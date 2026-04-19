"""
build_summaries.py — Haiku로 시트별 요약 생성
================================================
각 content.md에 1:1 대응하는 요약 파일을 `index/summaries/` 아래에 생성한다.
Agent가 Grep+Read로 빠르게 스크리닝할 수 있도록 핵심 용어를 front-load한다.

사용법:
    python scripts/build_summaries.py --sample 10
    python scripts/build_summaries.py --workbook "PK_HUD 시스템"
    python scripts/build_summaries.py --space "시스템 디자인"
    python scripts/build_summaries.py --all
    python scripts/build_summaries.py --all --workers 8
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

from bedrock_client import call as bedrock_call, BedrockError  # noqa: E402

ROOT = HERE.parent                                  # packages/agent-sdk-poc
REPO = ROOT.parent.parent                            # repo root
XLSX_ROOT = REPO / "packages" / "xlsx-extractor" / "output"
CONFLU_ROOT = REPO / "packages" / "confluence-downloader" / "output"
SUMMARIES_ROOT = ROOT / "index" / "summaries"


SYSTEM_PROMPT = """당신은 한국 모바일 MMORPG "Project K"의 기획 문서 요약 전문가다.

주어진 기획 문서(마크다운, Excel 시트 또는 Confluence 페이지의 변환 결과)를 읽고,
**에이전트가 Grep으로 빠르게 검색할 수 있는** 요약 파일을 작성한다.

반드시 아래 형식을 지켜라. 섹션 순서와 제목을 절대 바꾸지 말고, 원문에 해당 정보가 없으면 섹션은 남기되 "(없음)"이라 적는다.

```
# <시트/페이지명> (요약)

> 출처: <워크북/공간명> / <시트/페이지명>
> 원본: <유저가 전달한 "문서 경로" 값을 그대로 기록>

## 한 줄 설명
<이 문서가 무엇을 정의하는가를 1~2문장으로. 추측 금지, 문서에 있는 내용만.>

## 핵심 용어
- <용어1>
- <용어2>
...
(10~20개. 명사/고유명사/제품 내 용어를 중심으로. 원문 표기 유지. Grep 용이성 위해 중요 용어를 우선 배치.)

## 숫자/상수/공식
- <수치 또는 공식 표현>
...
(확률, HP 공식, 상수, 판정 순서 등. 없으면 "(없음)")

## 참조 시스템
- <언급된 다른 .xlsx 또는 Confluence 페이지명>
...
(문서 내 "PK_xxx 시스템.xlsx 참조" 같은 언급 추출. 없으면 "(없음)")

## 주요 섹션
- <섹션 제목 1>
- <섹션 제목 2>
...
(문서의 상위 헤딩 목록. 최대 10개.)
```

주의사항:
- 원문에 없는 내용을 추측·보강하지 않는다.
- 마크다운 구조(표, 리스트)는 풀어서 용어로만 요약한다.
- 표/코드블록/이미지 링크는 재현하지 않는다 (본문 원문이 그대로 존재하므로 중복 불필요).
- 응답은 위 마크다운 한 블록만 출력한다. 다른 설명/주석/안내 문구 없음.
"""


# ── 코퍼스 수집 ─────────────────────────────────────────────────

def collect_xlsx_files(workbook_filter: str | None = None) -> list[Path]:
    if not XLSX_ROOT.exists():
        return []
    files = sorted(XLSX_ROOT.rglob("content.md"))
    # xlsx content.md 는 항상 */_final/content.md
    files = [f for f in files if f.parent.name == "_final"]
    if workbook_filter:
        files = [f for f in files if workbook_filter in str(f)]
    return files


def collect_confluence_files(space_filter: str | None = None) -> list[Path]:
    if not CONFLU_ROOT.exists():
        return []
    files = sorted(CONFLU_ROOT.rglob("content.md"))
    if space_filter:
        files = [f for f in files if space_filter in str(f)]
    return files


def _rel_under(src: Path, root: Path) -> Path | None:
    """심볼릭 링크로 root가 다른 파티션을 가리켜도 작동하도록 string-relative 계산."""
    src_s = os.path.realpath(src)
    root_s = os.path.realpath(root)
    if src_s.startswith(root_s + os.sep):
        return Path(os.path.relpath(src_s, root_s))
    return None


def summary_path_for(src: Path) -> Path:
    """
    xlsx: <XLSX_ROOT>/7_System/PK_HUD 시스템/HUD_전투/_final/content.md
      → index/summaries/xlsx/7_System/PK_HUD 시스템/HUD_전투.md
    confluence: <CONFLU_ROOT>/시스템 디자인/NPC/content.md
      → index/summaries/confluence/시스템 디자인/NPC.md
    """
    rel = _rel_under(src, XLSX_ROOT)
    if rel is not None:
        parts = rel.parts
        if parts and parts[-1] == "content.md" and len(parts) >= 2 and parts[-2] == "_final":
            parts = parts[:-2]
        return SUMMARIES_ROOT / "xlsx" / Path(*parts).with_suffix(".md")

    rel = _rel_under(src, CONFLU_ROOT)
    if rel is not None:
        parts = rel.parts
        if parts and parts[-1] == "content.md":
            parts = parts[:-1]
        if not parts:
            parts = (src.parent.name,)
        return SUMMARIES_ROOT / "confluence" / Path(*parts).with_suffix(".md")

    return SUMMARIES_ROOT / "other" / (src.stem + ".md")


# ── 요약 생성 ───────────────────────────────────────────────────

MAX_INPUT_CHARS = 30000   # 본문이 너무 길면 앞부분만 사용 (Haiku 입력 절약)

def build_user_message(src: Path, body: str) -> str:
    if len(body) > MAX_INPUT_CHARS:
        body = body[:MAX_INPUT_CHARS] + "\n\n...(본문 절단)..."
    return f"문서 경로: {logical_repo_path(src)}\n\n=== 본문 ===\n{body}"


def logical_repo_path(src: Path) -> str:
    """Symlink를 해석하지 않고 'packages/xlsx-extractor/output/...' 형태로 표현."""
    s = str(src)
    repo_s = str(REPO)
    if s.startswith(repo_s + os.sep):
        return s[len(repo_s) + 1:]
    return s


def generate_summary(src: Path) -> tuple[Path, dict]:
    """한 파일을 처리하고 (summary_path, stats)를 반환."""
    body = src.read_text(encoding="utf-8", errors="replace")
    user_msg = build_user_message(src, body)

    t0 = time.time()
    result = bedrock_call(
        messages=[{"role": "user", "content": user_msg}],
        system=[{"type": "text", "text": SYSTEM_PROMPT,
                 "cache_control": {"type": "ephemeral"}}],
        model="haiku",
        max_tokens=2048,
        temperature=0.0,
    )
    dur = time.time() - t0

    text = result["text"].strip()
    # strip outer code fences if Haiku wrapped the markdown
    if text.startswith("```"):
        lines = text.splitlines()
        if lines[0].startswith("```"):
            lines = lines[1:]
        if lines and lines[-1].strip() == "```":
            lines = lines[:-1]
        text = "\n".join(lines).strip()

    dst = summary_path_for(src)
    dst.parent.mkdir(parents=True, exist_ok=True)
    dst.write_text(text + "\n", encoding="utf-8")

    stats = {
        "src": str(src),
        "dst": str(dst),
        "input_tokens": result["input_tokens"],
        "output_tokens": result["output_tokens"],
        "cache_read": result.get("cache_read_input_tokens", 0),
        "cache_creation": result.get("cache_creation_input_tokens", 0),
        "duration_s": round(dur, 2),
    }
    return dst, stats


# ── Orchestrator ───────────────────────────────────────────────

def is_fresh(src: Path, dst: Path) -> bool:
    """summary가 이미 존재하고 src보다 최신이면 True"""
    if not dst.exists():
        return False
    return dst.stat().st_mtime >= src.stat().st_mtime


def run(files: list[Path], workers: int, skip_existing: bool, out_log: Path):
    to_process = []
    skipped = 0
    for f in files:
        dst = summary_path_for(f)
        if skip_existing and is_fresh(f, dst):
            skipped += 1
        else:
            to_process.append(f)

    total = len(to_process)
    print(f"[run] total={len(files)}, to_process={total}, skipped={skipped}, workers={workers}")

    if total == 0:
        return

    results: list[dict] = []
    errors: list[dict] = []
    done = 0
    t0 = time.time()

    out_log.parent.mkdir(parents=True, exist_ok=True)

    with ThreadPoolExecutor(max_workers=workers) as ex:
        futures = {ex.submit(generate_summary, f): f for f in to_process}
        for fut in as_completed(futures):
            src = futures[fut]
            done += 1
            try:
                _, stats = fut.result()
                results.append(stats)
            except BedrockError as e:
                err = {"src": str(src), "error": str(e)}
                errors.append(err)
                print(f"[ERR] {src}: {e}", flush=True)
            if done % 10 == 0 or done == total:
                elapsed = time.time() - t0
                rate = done / max(elapsed, 1e-6)
                eta = (total - done) / max(rate, 1e-6)
                last = results[-1] if results else {}
                print(
                    f"[{done}/{total}] {elapsed:.0f}s  rate={rate:.2f}/s  eta={eta:.0f}s  "
                    f"last in={last.get('input_tokens',0)} out={last.get('output_tokens',0)}",
                    flush=True,
                )
            # 즉시 로그 저장 (실시간 가시성)
            with out_log.open("w", encoding="utf-8") as f:
                json.dump({
                    "total": total,
                    "done": done,
                    "errors": len(errors),
                    "elapsed_s": round(time.time() - t0, 1),
                    "results": results[-50:],   # 마지막 50개만
                    "recent_errors": errors[-20:],
                }, f, ensure_ascii=False, indent=2)

    # 최종 리포트
    total_in = sum(r["input_tokens"] for r in results)
    total_out = sum(r["output_tokens"] for r in results)
    total_cache_read = sum(r["cache_read"] for r in results)
    # Haiku 4.5 가격 (2026-04 기준, per 1M tokens): input $1, output $5, cache read $0.10
    est_cost = total_in * 1.0e-6 + total_out * 5.0e-6 + total_cache_read * 0.10e-6
    elapsed = time.time() - t0
    print("=" * 60)
    print(f"완료: {done}/{total}  에러: {len(errors)}")
    print(f"총 소요: {elapsed:.1f}s  평균 {elapsed/max(done,1):.2f}s/건")
    print(f"토큰: in={total_in:,} out={total_out:,} cache_read={total_cache_read:,}")
    print(f"예상 비용: ${est_cost:.3f} (Haiku 4.5 기준)")
    print(f"로그: {out_log}")


def main():
    ap = argparse.ArgumentParser()
    g = ap.add_mutually_exclusive_group(required=True)
    g.add_argument("--sample", type=int, help="무작위 N개 샘플 실행")
    g.add_argument("--workbook", help="xlsx 워크북 이름 부분일치 (예: 'PK_HUD')")
    g.add_argument("--space", help="Confluence 공간 이름 부분일치 (예: '시스템 디자인')")
    g.add_argument("--all", action="store_true", help="전체 1,332 파일")
    g.add_argument("--file", help="단일 파일 경로 (디버깅용)")

    ap.add_argument("--workers", type=int, default=5, help="병렬 워커 수 (기본 5)")
    ap.add_argument("--skip-existing", action="store_true",
                    help="이미 summary가 있고 src보다 최신이면 건너뛰기")
    ap.add_argument("--log", default=str(ROOT / "index" / "_build_summaries.log.json"),
                    help="실시간 로그 JSON 경로")
    args = ap.parse_args()

    if args.file:
        files = [Path(args.file).resolve()]
    elif args.sample:
        import random
        pool = collect_xlsx_files() + collect_confluence_files()
        random.seed(42)
        files = random.sample(pool, min(args.sample, len(pool)))
    elif args.workbook:
        files = collect_xlsx_files(args.workbook)
    elif args.space:
        files = collect_confluence_files(args.space)
    elif args.all:
        files = collect_xlsx_files() + collect_confluence_files()
    else:
        ap.error("one of --sample/--workbook/--space/--all/--file required")

    print(f"대상: {len(files)}개 파일")
    if not files:
        print("(대상이 없습니다.)")
        return
    print(f"첫 3개: {[os.path.relpath(os.path.realpath(f), os.path.realpath(REPO)) for f in files[:3]]}")

    SUMMARIES_ROOT.mkdir(parents=True, exist_ok=True)
    run(files, workers=args.workers, skip_existing=args.skip_existing,
        out_log=Path(args.log))


if __name__ == "__main__":
    main()
