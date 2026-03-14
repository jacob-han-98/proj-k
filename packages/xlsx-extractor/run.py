#!/usr/bin/env python3
"""
run.py - xlsx-extractor 통합 파이프라인 v2 (시트별 병렬 워크플로우)

Excel 기획서를 구조화된 Markdown으로 변환하는 전체 파이프라인을 실행한다.

  Phase A (Sequential) : Capture — Excel COM으로 모든 파일/시트 캡처
  Phase B (Parallel N) : Vision → Parse OOXML → Synthesize — 시트별 독립 워크플로우

사용법:
  # 단일 파일
  python run.py "../../7_System/PK_변신 및 스킬 시스템.xlsx"

  # 폴더 내 모든 xlsx
  python run.py "../../7_System" --parallel 10

  # 여러 입력 (파일/폴더 혼합)
  python run.py "../../7_System" "../../3_Base" --parallel 10

  # 전체 프로젝트 (모든 알려진 폴더)
  python run.py --all --parallel 10

  # 특정 시트만
  python run.py "file.xlsx" --sheet 변신

  # 특정 단계만
  python run.py "file.xlsx" --stage vision-synthesize --parallel 10

  # 이미 완료된 시트는 건너뛰지 않고 재처리
  python run.py --all --parallel 10 --force

  # dry-run (실행 없이 대상 확인)
  python run.py --all --dry-run
"""

import sys
import os
import time
import shutil
import argparse
import json
import threading
from pathlib import Path
from datetime import datetime
from concurrent.futures import ThreadPoolExecutor, as_completed

# Windows cp949 콘솔 인코딩 문제 방지
if sys.stdout.encoding and sys.stdout.encoding.lower() != 'utf-8':
    sys.stdout.reconfigure(encoding='utf-8', errors='replace')
    sys.stderr.reconfigure(encoding='utf-8', errors='replace')

# 파일 리다이렉트/파이프 시에도 실시간 출력 보장 (버퍼링 방지)
import builtins
_original_print = builtins.print
def _flushed_print(*args, **kwargs):
    kwargs.setdefault('flush', True)
    return _original_print(*args, **kwargs)
builtins.print = _flushed_print

# 프로젝트 루트 및 src를 path에 추가
SCRIPT_DIR = Path(__file__).parent.resolve()
SRC_DIR = SCRIPT_DIR / "src"
sys.path.insert(0, str(SRC_DIR))

# .env 로드
from dotenv import load_dotenv
load_dotenv(SCRIPT_DIR / ".env")


# ── 상수 ──
STAGES = ["capture", "vision", "parse_ooxml", "synthesize"]
STAGE_ALIASES = {
    "cap": "capture", "vis": "vision",
    "par": "parse_ooxml", "parse": "parse_ooxml", "ooxml": "parse_ooxml",
    "syn": "synthesize",
}
OUTPUT_DIR = SCRIPT_DIR / "output"
PROJECT_ROOT = SCRIPT_DIR.parent.parent  # proj-k 기획/

# 소스 폴더: 환경변수 XLSX_SOURCE_DIRS로 오버라이드 가능 (콤마 구분, 절대 경로)
# 미설정 시 PROJECT_ROOT 하위의 기본 폴더를 사용
_DEFAULT_XLSX_FOLDERS = ["7_System", "2_Development", "3_Base", "9_MileStone"]
_source_dirs_env = os.environ.get("XLSX_SOURCE_DIRS", "").strip()
if _source_dirs_env:
    XLSX_SOURCE_DIRS = [Path(d.strip()) for d in _source_dirs_env.split(",") if d.strip()]
    XLSX_FOLDERS = None  # 환경변수 사용 시 기본 폴더 비활성
else:
    XLSX_SOURCE_DIRS = None
    XLSX_FOLDERS = _DEFAULT_XLSX_FOLDERS


# ── 로깅 (thread-safe) ──
class Logger:
    """타임스탬프 + 단계 표시가 있는 로거 (thread-safe)"""

    def __init__(self):
        self.start_time = time.time()
        self.stage_start = None
        self.current_stage = None
        self._lock = threading.Lock()

    def _elapsed(self):
        return time.time() - self.start_time

    def _stage_elapsed(self):
        if self.stage_start is None:
            return 0
        return time.time() - self.stage_start

    def banner(self, text):
        with self._lock:
            print(f"\n{'=' * 70}")
            print(f"  {text}")
            print(f"{'=' * 70}")

    def stage_start_log(self, stage_name, description=""):
        with self._lock:
            self.current_stage = stage_name
            self.stage_start = time.time()
            print(f"\n{'-' * 70}")
            print(f"  {stage_name.upper()}  —  {description}")
            print(f"  start: {datetime.now().strftime('%H:%M:%S')}")
            print(f"{'-' * 70}")

    def stage_end_log(self, success=True, summary=""):
        with self._lock:
            elapsed = self._stage_elapsed()
            status = "OK" if success else "FAILED"
            print(f"\n  [{self.current_stage}] {status}  ({elapsed:.1f}s)")
            if summary:
                print(f"  {summary}")

    def info(self, msg):
        with self._lock:
            elapsed = self._elapsed()
            print(f"  [{elapsed:6.1f}s] {msg}")

    def warn(self, msg):
        with self._lock:
            elapsed = self._elapsed()
            print(f"  [{elapsed:6.1f}s] [WARN] {msg}")

    def error(self, msg):
        with self._lock:
            elapsed = self._elapsed()
            print(f"  [{elapsed:6.1f}s] [ERR] {msg}")

    def progress(self, current, total, msg=""):
        with self._lock:
            elapsed = self._elapsed()
            pct = current / total * 100 if total > 0 else 0
            bar_len = 30
            filled = int(bar_len * current / total) if total > 0 else 0
            bar = "#" * filled + "." * (bar_len - filled)
            print(f"  [{elapsed:6.1f}s] [{bar}] {current}/{total} ({pct:.0f}%)  {msg}")


log = Logger()


# ── 유틸리티 ──

def safe_name(name):
    """시트 이름을 파일시스템 안전한 이름으로 변환"""
    for ch in '/\\:*?"<>|':
        name = name.replace(ch, "_")
    return name


def get_output_dir(xlsx_path):
    """xlsx 파일에 대응하는 output 디렉토리 경로"""
    stem = Path(xlsx_path).stem
    return OUTPUT_DIR / stem


def find_sheets_in_output(output_dir, target_sheet=None):
    """output 디렉토리에서 시트 목록을 탐색 (콤마 구분 멀티 시트 지원)"""
    sheets = []
    if not output_dir.is_dir():
        return sheets
    target_names = None
    if target_sheet:
        target_names = set()
        for t in target_sheet.split(","):
            t = t.strip()
            target_names.add(t)
            target_names.add(safe_name(t))
    for entry in sorted(output_dir.iterdir()):
        if not entry.is_dir() or entry.name.startswith("_"):
            continue
        if target_names and entry.name not in target_names:
            continue
        sheets.append(entry)
    return sheets


def dir_size_str(directory):
    """디렉토리 크기를 사람이 읽기 좋은 형태로"""
    if not directory.is_dir():
        return "0B"
    total = sum(f.stat().st_size for f in directory.rglob("*") if f.is_file())
    if total < 1024:
        return f"{total}B"
    elif total < 1024 * 1024:
        return f"{total/1024:.1f}KB"
    else:
        return f"{total/1024/1024:.1f}MB"


# ── 입력 해석 ──

def resolve_xlsx_inputs(paths, all_mode=False):
    """입력 경로들을 xlsx 파일 목록으로 변환한다.

    - 파일 경로: 직접 추가
    - 디렉토리 경로: 하위 xlsx를 재귀 탐색
    - --all: 프로젝트 내 알려진 폴더 전부 탐색
    """
    xlsx_files = []
    search_dirs = []

    if all_mode:
        if XLSX_SOURCE_DIRS:
            # 환경변수로 지정된 외부 소스 폴더 사용
            for d in XLSX_SOURCE_DIRS:
                if d.is_dir():
                    search_dirs.append(d)
                else:
                    log.warn(f"소스 폴더 없음: {d}")
        else:
            # 기본: 프로젝트 하위 폴더
            for folder in XLSX_FOLDERS:
                d = PROJECT_ROOT / folder
                if d.is_dir():
                    search_dirs.append(d)
                else:
                    log.warn(f"폴더 없음: {folder}")

    for p_str in (paths or []):
        p = Path(p_str).resolve()
        if p.is_file() and p.suffix.lower() == '.xlsx' and not p.name.startswith('~$'):
            xlsx_files.append(p)
        elif p.is_dir():
            search_dirs.append(p)
        else:
            log.warn(f"경로를 찾을 수 없습니다: {p_str}")

    for d in search_dirs:
        for f in sorted(d.rglob("*.xlsx")):
            if not f.name.startswith("~$"):
                xlsx_files.append(f.resolve())

    # 중복 제거 (순서 유지)
    seen = set()
    unique = []
    for f in xlsx_files:
        key = str(f)
        if key not in seen:
            seen.add(key)
            unique.append(f)

    return unique


def filter_changed_files(xlsx_files: list[Path]) -> list[Path]:
    """소스 파일이 마지막 변환 이후 변경된 파일만 반환.

    비교 기준: 소스 xlsx mtime > 출력 폴더 내 _capture_manifest.json mtime
    출력 폴더가 없거나 manifest가 없으면 '변경됨'으로 간주.
    """
    changed = []
    skipped = []

    for xlsx_path in xlsx_files:
        file_name = xlsx_path.stem  # e.g. "PK_변신 및 스킬 시스템"
        output_dir = OUTPUT_DIR / file_name
        manifest = output_dir / "_capture_manifest.json"

        if not manifest.exists():
            # 아직 변환한 적 없음 → 변경됨
            changed.append(xlsx_path)
            continue

        src_mtime = xlsx_path.stat().st_mtime
        out_mtime = manifest.stat().st_mtime

        if src_mtime > out_mtime:
            changed.append(xlsx_path)
        else:
            skipped.append(xlsx_path)

    if skipped:
        log.info(f"[changed-only] 변경 감지: {len(changed)}개 변경, {len(skipped)}개 스킵")
        if changed:
            for f in changed[:10]:
                log.info(f"  변경됨: {f.name}")
            if len(changed) > 10:
                log.info(f"  ... 외 {len(changed) - 10}개")
    elif changed:
        log.info(f"[changed-only] 전체 {len(changed)}개 파일이 변환 대상 (기존 출력 없음)")

    return changed


def parse_stages(stage_arg):
    """--stage 인자를 파싱하여 실행할 단계 목록을 반환한다."""
    if not stage_arg:
        return list(STAGES)

    stage_input = stage_arg.lower()
    stage_input = STAGE_ALIASES.get(stage_input, stage_input)

    if "-" in stage_input:
        parts = stage_input.split("-")
        start = STAGE_ALIASES.get(parts[0], parts[0])
        end = STAGE_ALIASES.get(parts[1], parts[1])
        if start not in STAGES or end not in STAGES:
            log.error(f"알 수 없는 단계: {stage_arg}  (가능: {', '.join(STAGES)})")
            sys.exit(1)
        return STAGES[STAGES.index(start):STAGES.index(end) + 1]
    elif stage_input in STAGES:
        return [stage_input]
    else:
        log.error(f"알 수 없는 단계: {stage_arg}  (가능: {', '.join(STAGES)})")
        sys.exit(1)


# ── Phase A: Capture (순차, 단일 Excel COM 인스턴스) ──

def run_capture_batch(xlsx_files, target_sheet=None, skip_existing=True):
    """Phase A: Excel COM으로 모든 파일 캡처.

    단일 Excel 인스턴스를 재사용하여 파일 열기/닫기 오버헤드를 최소화한다.
    """
    from capture import capture_all

    log.stage_start_log("capture",
        f"Excel COM batch capture ({len(xlsx_files)} files, "
        f"{'skip existing' if skip_existing else 'force'})")

    t_start = time.time()
    total_new_sheets = 0
    total_skipped_files = 0
    total_blank = 0
    total_failed = 0

    # Excel COM 인스턴스 생성 (모든 파일에서 재사용)
    import win32com.client
    excel = win32com.client.Dispatch("Excel.Application")
    excel.Visible = False
    excel.DisplayAlerts = False
    excel.Interactive = False
    excel.AskToUpdateLinks = False

    try:
        for i, xlsx_path in enumerate(xlsx_files):
            name = xlsx_path.name
            output_dir = get_output_dir(xlsx_path)
            manifest_path = output_dir / "_capture_manifest.json"

            # 이미 캡처된 파일 건너뛰기
            if skip_existing and manifest_path.exists():
                try:
                    with open(manifest_path, "r", encoding="utf-8") as f:
                        manifest = json.load(f)
                    count = len([s for s in manifest.get("sheets", [])
                                if s.get("split_success") or s.get("blank")])
                    log.info(f"[{i+1}/{len(xlsx_files)}] {name}: "
                             f"already captured ({count} sheets, skip)")
                    total_skipped_files += 1
                except Exception:
                    log.warn(f"[{i+1}/{len(xlsx_files)}] {name}: "
                             f"manifest 읽기 실패, 재캡처")
                    # fall through to capture
                else:
                    continue

            log.info(f"[{i+1}/{len(xlsx_files)}] {name}...")
            try:
                results = capture_all(
                    str(xlsx_path), str(OUTPUT_DIR), target_sheet,
                    excel_app=excel
                )
                ok = sum(1 for r in results if r.get("split_success"))
                blank = sum(1 for r in results if r.get("blank"))
                fail = len(results) - ok - blank
                total_new_sheets += ok
                total_blank += blank
                total_failed += fail
                log.info(f"  -> {ok} sheets, {blank} blank"
                         + (f", {fail} FAILED" if fail else ""))
            except Exception as e:
                log.error(f"  -> FAILED: {e}")
                total_failed += 1
    finally:
        try:
            excel.Quit()
        except Exception:
            pass

    elapsed = time.time() - t_start
    summary = (f"{len(xlsx_files)} files "
               f"({total_skipped_files} skipped, {total_new_sheets} new sheets, "
               f"{total_blank} blank, {total_failed} failed)")
    log.stage_end_log(success=total_failed == 0, summary=summary)

    return {"elapsed": elapsed, "new_sheets": total_new_sheets,
            "skipped_files": total_skipped_files}


# ── 작업 큐 구성 ──

def build_work_queue(xlsx_files, target_sheet=None, skip_done=True):
    """캡처된 모든 시트를 (xlsx_path, sheet_dir, sheet_name) 작업 큐로 구성한다.

    Args:
        skip_done: True이면 이미 _final/content.md가 있는 시트 건너뛰기
    """
    queue = []
    skipped = 0

    for xlsx_path in xlsx_files:
        output_dir = get_output_dir(xlsx_path)
        if not output_dir.is_dir():
            continue

        sheets = find_sheets_in_output(output_dir, target_sheet)
        for sheet_dir in sheets:
            # 이미 완료된 시트 건너뛰기
            if skip_done and (sheet_dir / "_final" / "content.md").exists():
                skipped += 1
                continue

            # tile_manifest에서 시트 정보 읽기
            tm_path = sheet_dir / "_vision_input" / "tile_manifest.json"
            if tm_path.exists():
                with open(tm_path, "r", encoding="utf-8") as f:
                    tm = json.load(f)
                real_name = tm.get("sheet_name", sheet_dir.name)
                tiles = len(tm.get("tiles", []))
            else:
                real_name = sheet_dir.name
                tiles = 0

            queue.append({
                "xlsx_path": xlsx_path,
                "output_dir": output_dir,
                "sheet_dir": sheet_dir,
                "sheet_name": real_name,
                "file_stem": xlsx_path.stem,
                "tiles": tiles,
            })

    return queue, skipped


# ── Phase B: 시트별 병렬 파이프라인 ──

def _sheet_worker(work_item, run_stages, counter, total):
    """워커: 단일 시트에 대해 Vision → Parse → Synthesize 순차 실행.

    각 시트 내에서 타일은 순차 처리 (누적 컨텍스트 의존).
    시트 간에는 완전 독립이므로 병렬 가능.
    """
    xlsx_path = work_item["xlsx_path"]
    sheet_dir = work_item["sheet_dir"]
    sheet_name = work_item["sheet_name"]
    file_stem = work_item["file_stem"]
    label = f"{file_stem}/{sheet_name}"

    stages_log = {}
    success = True
    total_tokens = 0

    # ── Vision ──
    if "vision" in run_stages:
        t0 = time.time()
        try:
            from vision import process_sheet as vision_process
            r = vision_process(str(sheet_dir), sheet_name)
            elapsed = time.time() - t0
            ok = r.get("success", False)
            in_tok = r.get("total_input_tokens", 0)
            out_tok = r.get("total_output_tokens", 0)
            total_tokens = in_tok + out_tok
            stages_log["vis"] = f"{'OK' if ok else 'FAIL'},{elapsed:.0f}s,{total_tokens:,}tok"
            if not ok:
                success = False
                with counter["lock"]:
                    counter["done"] += 1
                    n = counter["done"]
                log.info(f"[{n:>4}/{total}] {label} -- vis(FAIL: {r.get('error','?')[:60]})")
                return {"label": label, "success": False, "stages": stages_log,
                        "tokens": total_tokens}
        except Exception as e:
            elapsed = time.time() - t0
            stages_log["vis"] = f"ERR,{elapsed:.0f}s"
            with counter["lock"]:
                counter["done"] += 1
                n = counter["done"]
            log.error(f"[{n:>4}/{total}] {label} -- vis(ERR: {e})")
            return {"label": label, "success": False, "stages": stages_log,
                    "tokens": 0}

    # ── Parse OOXML ──
    if "parse_ooxml" in run_stages:
        vision_merged = sheet_dir / "_vision_output" / "merged.md"
        if vision_merged.exists():
            t0 = time.time()
            try:
                from parse_ooxml import process_sheet as parse_process
                parse_process(str(xlsx_path), str(sheet_dir), sheet_name)
                elapsed = time.time() - t0
                stages_log["parse"] = f"OK,{elapsed:.1f}s"
            except Exception as e:
                elapsed = time.time() - t0
                stages_log["parse"] = f"ERR,{elapsed:.1f}s"
                # parse 실패는 치명적이지 않음 (synth가 vision fallback 사용)

    # ── Synthesize ──
    if "synthesize" in run_stages:
        vision_merged = sheet_dir / "_vision_output" / "merged.md"
        if vision_merged.exists():
            t0 = time.time()
            try:
                from synthesize import synthesize_sheet
                source_name = xlsx_path.stem
                r = synthesize_sheet(str(sheet_dir), sheet_name,
                                     str(xlsx_path), source_name)
                elapsed = time.time() - t0
                ok = r.get("success", False)
                lines = r.get("content_lines", 0)
                stages_log["synth"] = f"{'OK' if ok else 'FAIL'},{elapsed:.1f}s,{lines}lines"
                if not ok:
                    success = False
            except Exception as e:
                elapsed = time.time() - t0
                stages_log["synth"] = f"ERR,{elapsed:.1f}s"
                success = False

    # ── 완료 보고 ──
    with counter["lock"]:
        counter["done"] += 1
        if success:
            counter["ok"] += 1
        n = counter["done"]

    stages_str = " > ".join(f"{k}({v})" for k, v in stages_log.items())
    mark = "OK" if success else "FAIL"
    log.info(f"[{n:>4}/{total}] {label} -- {stages_str}  [{mark}]")

    return {"label": label, "success": success, "stages": stages_log,
            "tokens": total_tokens}


def run_parallel_pipeline(work_queue, run_stages, parallel):
    """Phase B: 시트별 병렬 파이프라인 실행."""
    total = len(work_queue)
    parallel = min(parallel, total) if total > 0 else 1

    # 예상 소요 시간
    if "vision" in run_stages:
        total_tiles = sum(w.get("tiles", 0) for w in work_queue)
        est_minutes = (total_tiles * 30 / 60) / max(parallel, 1)
        log.info(f"타일: {total_tiles}개, 예상 Vision 소요: ~{est_minutes:.0f}분 "
                 f"(타일당 ~30s, {parallel} workers)")
    else:
        log.info(f"Vision 제외, 빠르게 완료 예상")

    log.info(f"단계: {' -> '.join(s for s in run_stages if s != 'capture')}")
    print()

    t_start = time.time()

    counter = {"done": 0, "ok": 0, "lock": threading.Lock()}
    results = []

    with ThreadPoolExecutor(max_workers=parallel) as executor:
        futures = {}
        for work_item in work_queue:
            future = executor.submit(
                _sheet_worker, work_item, run_stages, counter, total
            )
            futures[future] = work_item

        for future in as_completed(futures):
            try:
                result = future.result()
                results.append(result)
            except Exception as e:
                item = futures[future]
                label = f"{item['file_stem']}/{item['sheet_name']}"
                with counter["lock"]:
                    counter["done"] += 1
                    n = counter["done"]
                log.error(f"[{n:>4}/{total}] {label} -- UNHANDLED: {e}")
                results.append({"label": label, "success": False, "error": str(e)})

    elapsed = time.time() - t_start

    ok = counter["ok"]
    fail = total - ok
    total_tokens = sum(r.get("tokens", 0) for r in results)

    log.banner(f"PIPELINE COMPLETE -- {ok}/{total} sheets OK, "
               f"{fail} failed  ({elapsed:.0f}s / {elapsed/60:.1f}분)")
    if total_tokens > 0:
        log.info(f"Total tokens: {total_tokens:,}")

    # 실패한 시트 목록
    failed = [r for r in results if not r.get("success")]
    if failed and len(failed) <= 20:
        log.info("Failed sheets:")
        for r in failed:
            log.info(f"  {r['label']}: {r.get('stages', r.get('error', '?'))}")

    return results


# ── 클린 ──

def _force_clean_dir(dir_path):
    """디렉토리 삭제를 시도하고, 실패하면 내부 파일만이라도 모두 삭제한다."""
    try:
        shutil.rmtree(dir_path)
        return True, False
    except PermissionError:
        pass

    deleted_files = 0
    failed_files = 0
    for root, dirs, files in os.walk(str(dir_path), topdown=False):
        for fname in files:
            fpath = os.path.join(root, fname)
            try:
                os.remove(fpath)
                deleted_files += 1
            except PermissionError:
                failed_files += 1
        for dname in dirs:
            dpath = os.path.join(root, dname)
            try:
                os.rmdir(dpath)
            except OSError:
                pass
    try:
        os.rmdir(str(dir_path))
    except OSError:
        pass

    if failed_files > 0:
        log.warn(f"  {failed_files}개 파일 삭제 실패 (프로세스 점유)")
    if deleted_files > 0:
        log.info(f"  fallback: {deleted_files}개 파일 개별 삭제")
    return failed_files == 0, True


def clean_output(xlsx_files, target_sheet=None):
    """xlsx 파일들의 출력 디렉토리를 삭제한다."""
    for xlsx_path in xlsx_files:
        output_dir = get_output_dir(xlsx_path)
        if not output_dir.is_dir():
            continue
        if target_sheet:
            for tn in [t.strip() for t in target_sheet.split(",")]:
                sheet_dir = output_dir / safe_name(tn)
                if sheet_dir.is_dir():
                    size = dir_size_str(sheet_dir)
                    _force_clean_dir(sheet_dir)
                    log.info(f"삭제: {xlsx_path.stem}/{tn} ({size})")
        else:
            size = dir_size_str(output_dir)
            count = 0
            for entry in sorted(output_dir.iterdir()):
                if entry.is_dir() and not entry.name.startswith("_"):
                    _force_clean_dir(entry)
                    count += 1
            log.info(f"삭제: {xlsx_path.stem} ({count} sheets, {size})")


# ── dry-run ──

def dry_run_batch(xlsx_files, run_stages, target_sheet=None):
    """실행하지 않고 대상 확인"""
    log.banner("DRY RUN - 실행 대상 확인")

    log.info(f"입력: {len(xlsx_files)} files")
    log.info(f"단계: {' -> '.join(s.upper() for s in run_stages)}")
    if target_sheet:
        log.info(f"시트 필터: {target_sheet}")

    total_sheets = 0
    total_tiles = 0
    total_captured = 0
    total_done = 0

    for xlsx_path in xlsx_files:
        output_dir = get_output_dir(xlsx_path)
        name = xlsx_path.name

        if not output_dir.is_dir():
            # 시트 수 미리보기 (openpyxl)
            try:
                from capture import get_sheet_names
                snames = get_sheet_names(str(xlsx_path))
                sheet_count = len(snames)
            except Exception:
                sheet_count = "?"
            log.info(f"  {name}: {sheet_count} sheets (미캡처)")
            if isinstance(sheet_count, int):
                total_sheets += sheet_count
            continue

        sheets = find_sheets_in_output(output_dir, target_sheet)
        total_sheets += len(sheets)

        captured = 0
        done = 0
        tiles = 0
        for s in sheets:
            if (s / "_vision_input" / "tile_manifest.json").exists():
                captured += 1
                try:
                    with open(s / "_vision_input" / "tile_manifest.json", "r",
                              encoding="utf-8") as f:
                        tm = json.load(f)
                    tiles += len(tm.get("tiles", []))
                except Exception:
                    pass
            if (s / "_final" / "content.md").exists():
                done += 1

        total_captured += captured
        total_done += done
        total_tiles += tiles

        log.info(f"  {name}: {len(sheets)} sheets "
                 f"(captured={captured}, done={done}, tiles={tiles})")

    print()
    log.info(f"총 시트: {total_sheets}개")
    log.info(f"캡처됨: {total_captured}개 ({total_tiles} tiles)")
    log.info(f"완료됨: {total_done}개 (skip 대상)")
    log.info(f"처리 대상: {total_sheets - total_done}개")

    if "vision" in run_stages and total_tiles > 0:
        # 아직 캡처 안 된 시트의 타일은 추정 불가 → 캡처된 것만으로 추정
        remaining_tiles = total_tiles  # conservative estimate
        log.info(f"\n예상 Vision 소요 (N=10 기준): "
                 f"~{remaining_tiles * 30 / 60 / 10:.0f}분 ({remaining_tiles} tiles)")

    print()


# ── 메인 ──

def main():
    parser = argparse.ArgumentParser(
        description="xlsx-extractor 통합 파이프라인 v2 (시트별 병렬 워크플로우)",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
예시:
  python run.py "file.xlsx"                            단일 파일 전체 파이프라인
  python run.py "../../7_System" --parallel 10         폴더 내 모든 xlsx
  python run.py --all --parallel 10                    전체 프로젝트
  python run.py --all --parallel 10 --stage vis-syn    Vision~Synth만 (캡처 건너뛰기)
  python run.py "file.xlsx" --sheet 변신 --clean        삭제 후 재실행
  python run.py --all --dry-run                        실행 없이 확인
  python run.py --all --parallel 10 --force            완료된 시트도 재처리
        """,
    )
    parser.add_argument("xlsx", nargs="*", help="Excel 파일 또는 디렉토리 (여러 개 가능)")
    parser.add_argument("--all", action="store_true",
                        help="모든 소스 폴더 처리 (XLSX_SOURCE_DIRS 또는 기본 폴더)")
    parser.add_argument("--sheet", help="특정 시트만 처리 (콤마 구분)")
    parser.add_argument("--stage",
                        help="특정 단계만 실행 (cap/vis/parse/syn 또는 vis-syn 구간)")
    parser.add_argument("--parallel", type=int, default=1,
                        help="시트별 병렬 워커 수 (default: 1)")
    parser.add_argument("--clean", action="store_true", help="기존 출력 삭제 후 재실행")
    parser.add_argument("--dry-run", action="store_true", help="실행 없이 대상 확인")
    parser.add_argument("--force", action="store_true",
                        help="이미 완료된 시트도 재처리 (기본: 건너뛰기)")
    parser.add_argument("--output", help="출력 디렉토리 (기본: output/)")
    parser.add_argument("--changed-only", action="store_true",
                        help="소스 파일이 변경된 것만 처리 (mtime 비교)")

    args = parser.parse_args()

    if args.output:
        global OUTPUT_DIR
        OUTPUT_DIR = Path(args.output).resolve()

    # 입력 해석
    if not args.xlsx and not args.all:
        parser.error("xlsx 파일/디렉토리를 지정하거나 --all을 사용하세요")

    xlsx_files = resolve_xlsx_inputs(args.xlsx, args.all)
    if not xlsx_files:
        log.error("처리할 xlsx 파일이 없습니다")
        sys.exit(1)

    # --changed-only: 변경된 파일만 필터링
    if args.changed_only:
        original_count = len(xlsx_files)
        xlsx_files = filter_changed_files(xlsx_files)
        if not xlsx_files:
            log.info(f"변경된 파일 없음 (전체 {original_count}개 중 0개 변경)")
            sys.exit(0)

    # 실행 단계 결정
    run_stages = parse_stages(args.stage)

    # 배너
    log.banner("xlsx-extractor Pipeline v2")
    log.info(f"입력:   {len(xlsx_files)} files"
             + (f" (changed-only)" if args.changed_only else ""))
    log.info(f"병렬:   {args.parallel} workers")
    log.info(f"단계:   {' -> '.join(s.upper() for s in run_stages)}")
    log.info(f"force:  {'YES' if args.force else 'NO (완료된 시트 skip)'}")
    if XLSX_SOURCE_DIRS:
        log.info(f"소스:   {', '.join(str(d) for d in XLSX_SOURCE_DIRS)}")
    log.info(f"시작:   {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}")

    # 파일 목록 (간략)
    if len(xlsx_files) <= 10:
        for f in xlsx_files:
            log.info(f"  - {f.name}")
    else:
        for f in xlsx_files[:5]:
            log.info(f"  - {f.name}")
        log.info(f"  ... 외 {len(xlsx_files) - 5}개")

    # dry-run
    if args.dry_run:
        dry_run_batch(xlsx_files, run_stages, args.sheet)
        sys.exit(0)

    # 클린
    if args.clean:
        log.info("")
        log.info("[clean] 출력 삭제 중...")
        clean_output(xlsx_files, args.sheet)

    # ── Phase A: Capture (순차) ──
    if "capture" in run_stages:
        run_capture_batch(xlsx_files, args.sheet, skip_existing=not args.force)

    # ── Phase B: 시트별 병렬 파이프라인 ──
    pipeline_stages = [s for s in run_stages if s != "capture"]

    if not pipeline_stages:
        log.info("캡처만 실행 (추가 단계 없음)")
        sys.exit(0)

    work_queue, skipped = build_work_queue(
        xlsx_files, args.sheet, skip_done=not args.force
    )

    if not work_queue:
        if skipped > 0:
            log.info(f"모든 시트가 이미 완료됨 ({skipped}개 skip). --force로 재처리 가능.")
        else:
            log.warn("처리할 시트가 없습니다 (캡처 결과 확인)")
        sys.exit(0)

    log.banner(f"Phase B: Pipeline ({len(work_queue)} sheets, "
               f"{args.parallel} workers"
               + (f", {skipped} skipped" if skipped else "") + ")")

    results = run_parallel_pipeline(work_queue, pipeline_stages, args.parallel)

    # 종료 코드
    any_failed = any(not r.get("success") for r in results)
    sys.exit(1 if any_failed else 0)


if __name__ == "__main__":
    main()
