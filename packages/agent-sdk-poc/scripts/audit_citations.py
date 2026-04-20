"""refactor_targets.json 의 각 evidence cited_text가 실제 원문 content.md 에 존재하는지 감사.

환각(LLM이 요약·재구성한 quote) 탐지용. 재실행 없이 기존 리포트를 보강/평가할 수 있다.

사용:
    python scripts/audit_citations.py
    python scripts/audit_citations.py --inplace   # evidence[].quote_in_source 플래그를 파일에 주입
"""
from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

PKG_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(PKG_ROOT))

from src.ranker import corpus  # noqa: E402

TARGETS_PATH = PKG_ROOT / "decisions" / "refactor_targets.json"


def _norm(s: str) -> str:
    return re.sub(r"\s+", " ", s or "").strip()


def _collect_corpus_text(target_name: str, evidence: list[dict]) -> str:
    parts: list[str] = []
    for s in corpus.excel_sheet_contents(target_name, max_chars_per_sheet=100_000):
        parts.append(s["text"])
    conf_paths: set[str] = set()
    for ev in evidence:
        src = ev.get("source", {})
        if src.get("kind") == "confluence" and src.get("page_path"):
            conf_paths.add(src["page_path"])
    for rel in conf_paths:
        doc = corpus.confluence_page_content(rel, max_chars=100_000)
        if doc:
            parts.append(doc["text"])
    return _norm("\n".join(parts))


def main() -> int:
    p = argparse.ArgumentParser()
    p.add_argument("--inplace", action="store_true", help="결과 플래그를 refactor_targets.json 에 주입")
    p.add_argument("--path", type=Path, default=TARGETS_PATH)
    args = p.parse_args()

    if not args.path.exists():
        print(f"[ERR] not found: {args.path}", file=sys.stderr)
        return 2

    report = json.loads(args.path.read_text(encoding="utf-8"))
    total_hits = total_misses = total = 0
    per_target: list[dict] = []

    for t in report.get("targets", []):
        name = t.get("name")
        evs = [e for e in t.get("evidence", []) if e.get("dimension") == "conflict"]
        if not evs:
            continue
        corpus_text = _collect_corpus_text(name, evs)
        hit = miss = 0
        for ev in evs:
            total += 1
            q = _norm(ev.get("cited_text") or "")
            present = bool(q) and q in corpus_text
            ev["quote_in_source"] = present  # inject
            if present:
                hit += 1
                total_hits += 1
            else:
                miss += 1
                total_misses += 1
        per_target.append({"name": name, "hits": hit, "misses": miss, "n": hit + miss})

    print(f"Citation existence audit — {args.path}")
    print(f"  conflict evidence total: {total}")
    pct = (total_hits / total * 100) if total else 0
    print(f"  hits: {total_hits}  misses: {total_misses}  hit_rate: {pct:.1f}%\n")
    print("  per-target:")
    for r in per_target:
        rate = (r["hits"] / r["n"] * 100) if r["n"] else 0
        marker = "✓" if rate >= 80 else ("~" if rate >= 40 else "✗")
        print(f"    {marker} {r['name']:40s}  {r['hits']}/{r['n']}  ({rate:.0f}%)")

    if args.inplace:
        args.path.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
        print(f"\n[✓] injected quote_in_source flags into {args.path.name}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
