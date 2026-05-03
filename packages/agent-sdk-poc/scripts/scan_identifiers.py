"""
Step 1 진단 — content.md 코퍼스에서 식별자 후보 추출.

목표:
- 모델이 첫 턴에 정답 식별자를 Grep 할 수 있도록 인덱스에 노출할 후보 수집
- 노이즈 (2~3자 약어, 흔한 영어 키워드) 거르기
- 식별자 + 같은 라인의 한국어 라벨/설명 페어로 묶어서 의미 보존

출력:
- bench_out/identifier_scan.json: 전체 식별자 occurrence 목록
- 콘솔: 통계 + sample 100건

검증 포인트:
- 통계: 시트당 평균 식별자 수, 식별자 등장 시트 수 분포
- sample: 사용자 eyeball 로 "이런 게 잡히는 게 맞는가" 한 번 보고 stoplist 보강 필요 여부 판단
"""
from __future__ import annotations

import json
import random
import re
import sys
from collections import Counter, defaultdict
from pathlib import Path

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass


# 코퍼스 위치 (Windows 에서)
CORPUS_ROOTS = [
    Path("e:/proj-k-data/xlsx-extractor/output"),
]
OUT_DIR = Path(__file__).resolve().parent / "bench_out"


# 식별자 패턴 ─────────────────────────────────────
# 1) CamelCase 2단어 이상: MetaSwitchCoolTime, MetamorphCompose
PAT_CAMEL = re.compile(r"\b[A-Z][a-z]{1,}(?:[A-Z][a-z0-9]+){1,}\b")
# 2) snake_case 식별자 (밑줄 포함, 첫 글자 대문자 또는 영문): Meta_FailChangeInCooltime
PAT_SNAKE = re.compile(r"\b[A-Z][a-zA-Z0-9]+(?:_[A-Z][a-zA-Z0-9]+)+\b")
# 3) ALL_CAPS_SNAKE (3+ 글자 segment, 길이 6+): META_SWITCH_TIME — 잘 안 쓰지만 일부 있음
PAT_UPPER_SNAKE = re.compile(r"\b[A-Z]{3,}(?:_[A-Z0-9]{2,})+\b")

# 노이즈 stoplist — 흔한 영어 키워드 + 마크다운/문서 메타 + 약어
STOPWORDS = {
    # 영문 키워드/방향
    "TRUE", "FALSE", "NULL", "NONE", "YES", "NO", "AND", "OR", "NOT",
    "START", "END", "BEGIN", "STOP", "PAUSE", "RESUME",
    "MIN", "MAX", "AVG", "SUM", "COUNT",
    "CPU", "GPU", "RAM", "ROM", "API", "SDK", "URL", "URI", "CSS", "HTML", "JSON", "XML",
    "NPC", "PC", "PVP", "PVE", "DPS", "HP", "MP", "EXP", "SP", "AP",
    # 마크다운/포맷
    "TD", "TR", "TH", "BR", "BM", "LR", "UL", "OL", "LI",
    # 문서 / 메타
    "OOXML", "OOX", "PDF", "PPT", "DOC",
    "PK", "PK_",
    # 단일 두자 (대부분 약어)
    "ID", "UI", "UX", "FX", "OK", "IO",
}

# 한 글자 두 글자 식별자는 무조건 노이즈
MIN_LEN = 4


def is_meaningful(token: str) -> bool:
    if len(token) < MIN_LEN:
        return False
    if token in STOPWORDS:
        return False
    # 모두 대문자에 길이 짧고 segment 1개면 약어 가능성 — 패스
    if token.isupper() and "_" not in token and len(token) <= 5:
        return False
    return True


def extract_from_line(line: str) -> list[str]:
    """라인에서 식별자 후보 추출. 중복 제거 후 리턴."""
    found: list[str] = []
    for pat in (PAT_SNAKE, PAT_CAMEL, PAT_UPPER_SNAKE):
        for m in pat.finditer(line):
            tok = m.group(0)
            if is_meaningful(tok):
                found.append(tok)
    # 한 라인 내 중복 제거 (등장 순서 보존)
    seen = set()
    out = []
    for t in found:
        if t not in seen:
            seen.add(t)
            out.append(t)
    return out


def line_korean_context(line: str, max_chars: int = 80) -> str:
    """식별자 주변의 의미있는 한국어 컨텍스트. 마크다운 테이블 행이면 가장 첫 한국어 셀."""
    s = line.strip()
    # 테이블 행
    if s.startswith("|"):
        cells = [c.strip() for c in s.split("|") if c.strip()]
        for c in cells:
            # 한글이 포함된 첫 셀
            if any("가" <= ch <= "힣" for ch in c):
                return c[:max_chars]
        return ""
    return s[:max_chars]


def scan_file(path: Path) -> list[dict]:
    """한 content.md 의 모든 식별자 occurrence 추출."""
    occs: list[dict] = []
    try:
        text = path.read_text(encoding="utf-8", errors="replace")
    except Exception:
        return occs

    sheet_label = derive_sheet_label(path)

    for ln, line in enumerate(text.splitlines(), 1):
        ids = extract_from_line(line)
        if not ids:
            continue
        ctx = line_korean_context(line)
        for tok in ids:
            occs.append({
                "id": tok,
                "sheet": sheet_label,
                "line": ln,
                "ctx": ctx,
                "path": str(path),
            })
    return occs


def derive_sheet_label(p: Path) -> str:
    """content.md 의 절대경로에서 '<workbook> / <sheet>' 라벨 도출."""
    parts = list(p.parts)
    # 끝에서 ['_final', 'content.md'] 또는 ['content.md']
    if parts and parts[-1] == "content.md":
        parts = parts[:-1]
    if parts and parts[-1] == "_final":
        parts = parts[:-1]
    if len(parts) >= 2:
        return f"{parts[-2]} / {parts[-1]}"
    if parts:
        return parts[-1]
    return str(p)


def main():
    OUT_DIR.mkdir(parents=True, exist_ok=True)

    files: list[Path] = []
    for root in CORPUS_ROOTS:
        if not root.exists():
            continue
        files.extend(root.rglob("content.md"))
    print(f"[scan] {len(files)} content.md files")

    all_occs: list[dict] = []
    sheets_with_ids: int = 0
    for i, p in enumerate(files, 1):
        occs = scan_file(p)
        if occs:
            sheets_with_ids += 1
            all_occs.extend(occs)
        if i % 100 == 0:
            print(f"[scan]   {i}/{len(files)} ({len(all_occs)} occurrences so far)")

    print(f"\n[scan] DONE. {len(all_occs):,} identifier occurrences across {sheets_with_ids} sheets\n")

    # 통계
    id_counter: Counter = Counter()        # 식별자 → 등장 occurrence 수
    sheets_per_id: defaultdict = defaultdict(set)  # 식별자 → 등장 시트 set
    ids_per_sheet: defaultdict = defaultdict(set)  # 시트 → 식별자 set
    for o in all_occs:
        id_counter[o["id"]] += 1
        sheets_per_id[o["id"]].add(o["sheet"])
        ids_per_sheet[o["sheet"]].add(o["id"])

    # 분포 — 식별자 등장 시트 수 (1=고유, 2~5=일부, 6+=공통)
    dist = Counter()
    for tid, sheets in sheets_per_id.items():
        n = len(sheets)
        if n == 1:
            dist["unique-1-sheet"] += 1
        elif n <= 5:
            dist["2-5-sheets"] += 1
        elif n <= 20:
            dist["6-20-sheets"] += 1
        else:
            dist["21+-sheets"] += 1

    print("=== 통계 ===")
    print(f"unique identifier 종류 = {len(id_counter):,}")
    print(f"시트별 식별자 평균    = {len(all_occs) / max(sheets_with_ids, 1):.1f}")
    print(f"식별자 등장 시트 분포:")
    for k, v in sorted(dist.items(), key=lambda x: -x[1]):
        print(f"  {k:<20} {v:,}")

    print("\n--- 가장 많이 나오는 상위 30 식별자 (= 공통/노이즈 성격 강함) ---")
    for tid, cnt in id_counter.most_common(30):
        print(f"  {cnt:>5}  {tid:<40}  ({len(sheets_per_id[tid])} sheets)")

    print("\n--- 시트당 식별자 수 상위 10 (어느 시트가 식별자 많은가) ---")
    sheet_id_count = sorted(ids_per_sheet.items(), key=lambda x: -len(x[1]))
    for sheet, ids in sheet_id_count[:10]:
        print(f"  {len(ids):>4} ids  {sheet}")

    # 100 sample (랜덤 + 1-시트 unique 위주 — 노이즈 거른 후 진짜 의미있는 것)
    unique_only = [o for o in all_occs if len(sheets_per_id[o["id"]]) <= 3 and id_counter[o["id"]] >= 2]
    print(f"\n--- 100 SAMPLE (시트 1~3곳에서만 등장 = 시트 고유 식별자 후보) ---")
    print(f"    이런 분포의 식별자 풀: {len(unique_only):,}건 / 전체 {len(all_occs):,}")
    print(f"    아래 100건이 '이게 진짜 의미있는 식별자다' 라고 사용자가 동의하시는지 확인 부탁")
    print()
    random.seed(42)
    sample = random.sample(unique_only, min(100, len(unique_only)))
    for s in sample:
        ctx = s["ctx"][:60].replace("\n", " ")
        print(f"  {s['id']:<40} | {s['sheet'][:35]:<35} | {ctx}")

    # 저장
    out_full = OUT_DIR / "identifier_scan_full.json"
    out_full.write_text(
        json.dumps({
            "stats": {
                "total_occurrences": len(all_occs),
                "unique_identifiers": len(id_counter),
                "sheets_with_ids": sheets_with_ids,
                "sheets_total": len(files),
                "distribution": dict(dist),
            },
            "occurrences": all_occs,
        }, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    out_sample = OUT_DIR / "identifier_scan_sample.json"
    out_sample.write_text(
        json.dumps({"sample_100": sample}, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    print(f"\n[saved] {out_full}  ({out_full.stat().st_size:,} bytes)")
    print(f"[saved] {out_sample}")


if __name__ == "__main__":
    main()
