"""Quick Find 100 케이스 평가 — l1 / vector / auto 만.

100 케이스 생성:
  - 40 system_name : 실제 인덱스에서 샘플한 xlsx 워크북, query = 워크북 short name
  - 30 content    : 샘플한 confluence 페이지, query = 페이지명
  - 15 natural    : 자연어 (수동 작성)
  - 15 synonym    : 한국어 동의어/슬랭 (수동 작성)

PASS 기준 (자동):
  - 자동 생성 케이스: expected_doc_id 가 top 5 hits 안에 있으면 PASS
  - 자연어/동의어: expected_workbooks_any 중 하나가 top 5 워크북에 있으면 PASS

사용:
  .venv/bin/python tests/run_quick_find_100.py
  .venv/bin/python tests/run_quick_find_100.py --strategies l1
  .venv/bin/python tests/run_quick_find_100.py --top-n 5
"""
from __future__ import annotations

import argparse
import json
import random
import re
import sys
import time
from pathlib import Path

import httpx

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))
from quick_find import build_index, Doc  # noqa


SEED = 42
TOP_N_DEFAULT = 5
PUBLIC_STRATEGIES = ["l1", "vector", "auto"]


# ── 100 케이스 생성 ─────────────────────────────────────────────────────────

def _short_workbook(wb: str) -> str:
    """'PK_레벨업 시스템' → '레벨업'. 'PK_변신 및 스킬 시스템' → '변신 및 스킬'."""
    s = re.sub(r"^PK_", "", wb)
    s = re.sub(r"\s*시스템\s*$", "", s)
    return s.strip()


def _short_page(title: str) -> str:
    """confluence 페이지 제목 단순화. 너무 길면 첫 핵심 단어만."""
    s = title.strip()
    # "동대륙_바리울Bariul" → "바리울" 같은 정규화는 안 함, 원본 유지
    return s[:30]


def gen_cases(docs: list[Doc], n_xlsx: int = 40, n_conf: int = 30) -> list[dict]:
    rng = random.Random(SEED)
    xlsx_docs = [d for d in docs if d.kind == "xlsx" and d.workbook]
    conf_docs = [d for d in docs if d.kind == "confluence"]

    # === Auto-generate: 워크북 별 1개씩 샘플 (다양성) ===
    by_workbook: dict[str, list[Doc]] = {}
    for d in xlsx_docs:
        by_workbook.setdefault(d.workbook, []).append(d)
    workbooks = list(by_workbook.keys())
    rng.shuffle(workbooks)

    cases: list[dict] = []

    # 40 system_name (워크북 명에서 short 추출)
    for wb in workbooks[:n_xlsx]:
        sheets = by_workbook[wb]
        sheet = rng.choice(sheets)
        short = _short_workbook(wb)
        if not short or len(short) < 2:
            continue
        cases.append({
            "id": f"sys-{len(cases):03d}",
            "category": "system_name",
            "query": short,
            "expected_workbook": wb,
            "expected_doc_id_or_workbook": True,
            "min_results": 1,
            "max_latency_ms": 5000,
        })

    # 30 confluence pages
    rng.shuffle(conf_docs)
    chosen_conf = []
    for d in conf_docs:
        # 너무 짧거나 generic 한 페이지명 제외
        title = d.title
        if len(title) < 3:
            continue
        if title in ("개요", "히스토리", "목적", "구성", "참고", "메모"):
            continue
        chosen_conf.append(d)
        if len(chosen_conf) >= n_conf:
            break

    for d in chosen_conf:
        cases.append({
            "id": f"conf-{len(cases):03d}",
            "category": "content_region",
            "query": _short_page(d.title),
            "expected_doc_id": d.doc_id,
            "min_results": 1,
            "max_latency_ms": 5000,
        })

    # === Manual: 15 natural language + 15 synonym ===
    # 자연어 모호 / 사용 의도 표현
    natural_cases = [
        ("캐릭터 키우는 법", ["PK_레벨업 시스템", "PK_변신 및 스킬 시스템", "PK_보상 시스템", "PK_장비 시스템"]),
        ("보스 잡는 법", ["PK_보스 레이드 시스템", "PK_몬스터 시스템", "PK_몬스터 어그로 시스템"]),
        ("어떻게 강해지나", ["PK_레벨업 시스템", "PK_변신 및 스킬 시스템", "PK_장비 시스템"]),
        ("아이템 만드는 법", ["PK_분해 시스템"]),
        ("스킬 강화하는 법", ["PK_변신 및 스킬 시스템", "PK_스킬 표준 데이터"]),
        ("자동 사냥 켜는 법", ["PK_물약 자동 사용 시스템"]),
        ("HP 자동 회복", ["PK_물약 자동 사용 시스템"]),
        ("죽으면 어떻게 되나", ["PK_사망 및 부활 시스템"]),
        ("레벨 올리는 방법", ["PK_레벨업 시스템"]),
        ("파티 만드는 방법", ["PK_NPC 시스템"]),
        ("메뉴 닫는 단축키", ["PK_단축키 시스템"]),
        ("화면에 보이는 정보", ["PK_HUD 시스템"]),
        ("적이 나를 공격하는 우선순위", ["PK_몬스터 어그로 시스템"]),
        ("몬스터가 죽을 때 연출", ["PK_몬스터 사망 랙돌 시스템"]),
        ("처음 게임 켜면 보이는 화면", ["PK_로그인 플로우"]),
    ]
    for q, wbs in natural_cases:
        cases.append({
            "id": f"nat-{len(cases):03d}",
            "category": "natural_vague",
            "query": q,
            "expected_workbooks_any": wbs,
            "min_results": 1,
            "max_latency_ms": 6000,
        })

    # 동의어/슬랭 — 정식 용어와 다른 표현
    synonym_cases = [
        ("치명타", ["PK_기본 전투 시스템", "PK_대미지 명중률 계산기"]),
        ("크리티컬", ["PK_기본 전투 시스템", "PK_대미지 명중률 계산기"]),
        ("깡뎀", ["PK_기본 전투 시스템", "PK_스탯 시스템"]),
        ("깡공", ["PK_스탯 시스템", "PK_기본 전투 시스템"]),
        ("깡방", ["PK_스탯 시스템"]),
        ("오토", ["PK_물약 자동 사용 시스템"]),
        ("자동", ["PK_물약 자동 사용 시스템"]),
        ("잡몹", ["PK_몬스터 시스템"]),
        ("네임드 몬스터", ["PK_네임드 몬스터 타입추가", "PK_몬스터 시스템"]),
        ("미니맵", ["PK_미니맵 시스템"]),
        ("어그로", ["PK_몬스터 어그로 시스템"]),
        ("부활", ["PK_사망 및 부활 시스템"]),
        ("골드", ["PK_골드 밸런스"]),
        ("물약", ["PK_물약 자동 사용 시스템"]),
        ("분해", ["PK_분해 시스템"]),
    ]
    for q, wbs in synonym_cases:
        cases.append({
            "id": f"syn-{len(cases):03d}",
            "category": "synonym",
            "query": q,
            "expected_workbooks_any": wbs,
            "min_results": 1,
            "max_latency_ms": 6000,
        })

    return cases


# ── case 1개 호출 + 검증 ────────────────────────────────────────────────────

def call_one(base: str, strategy: str, case: dict, top_n: int) -> dict:
    payload = {"query": case["query"], "limit": 10, "strategy": strategy}
    t0 = time.time()
    hits: list[dict] = []
    statuses: list[dict] = []
    result_meta: dict = {}
    error_msg = None
    try:
        with httpx.stream("POST", f"{base}/quick_find", json=payload, timeout=60.0) as r:
            if r.status_code != 200:
                error_msg = f"HTTP {r.status_code}"
            else:
                for line in r.iter_lines():
                    if not line.strip():
                        continue
                    try:
                        ev = json.loads(line)
                    except Exception:
                        continue
                    t = ev.get("type")
                    if t == "status":
                        statuses.append(ev)
                    elif t == "hit":
                        hits.append(ev["data"])
                    elif t == "result":
                        result_meta = ev["data"]
                    elif t == "error":
                        error_msg = ev.get("message")
    except Exception as e:
        error_msg = str(e)
    elapsed_ms = int((time.time() - t0) * 1000)

    # 검증
    top_hits = hits[:top_n]
    passed = False
    fail_reason = ""
    if error_msg:
        fail_reason = f"error: {error_msg}"
    elif len(hits) < case.get("min_results", 1):
        fail_reason = f"too few results ({len(hits)})"
    else:
        # 검증 룰
        if case.get("expected_doc_id"):
            top_ids = [h.get("doc_id") for h in top_hits]
            passed = case["expected_doc_id"] in top_ids
            if not passed:
                fail_reason = f"expected_doc_id={case['expected_doc_id']!r} not in top{top_n}: {top_ids}"
        elif case.get("expected_workbook"):
            top_wbs = [h.get("workbook") for h in top_hits]
            passed = case["expected_workbook"] in top_wbs
            if not passed:
                fail_reason = f"workbook {case['expected_workbook']!r} not in top{top_n}: {top_wbs}"
        elif case.get("expected_workbooks_any"):
            top_wbs = {h.get("workbook") or "" for h in top_hits}
            passed = any(w in top_wbs for w in case["expected_workbooks_any"])
            if not passed:
                fail_reason = f"none of {case['expected_workbooks_any']} in top{top_n}: {top_wbs}"

    return {
        "case_id": case["id"], "category": case["category"], "query": case["query"],
        "strategy": strategy, "passed": passed, "latency_ms": elapsed_ms,
        "n_hits": len(hits), "fail_reason": fail_reason,
        "top1": hits[0] if hits else None, "result": result_meta,
    }


# ── runner ──────────────────────────────────────────────────────────────────

def main():
    p = argparse.ArgumentParser()
    p.add_argument("--base", default="http://127.0.0.1:8090")
    p.add_argument("--strategies", default=",".join(PUBLIC_STRATEGIES))
    p.add_argument("--top-n", type=int, default=TOP_N_DEFAULT)
    p.add_argument("--limit-cases", type=int, default=0, help="for quick test, limit total cases")
    args = p.parse_args()

    print(f"=== Quick Find 100 케이스 평가 ===")
    print(f"base={args.base}  strategies={args.strategies}  top_n={args.top_n}\n")

    print("[1/3] 인덱스 빌드 중...")
    docs = build_index()
    print(f"  index: {len(docs)} docs")

    print("[2/3] 100 케이스 생성 중...")
    cases = gen_cases(docs)
    if args.limit_cases:
        cases = cases[:args.limit_cases]
    print(f"  cases: {len(cases)}")

    by_cat: dict[str, int] = {}
    for c in cases:
        by_cat[c["category"]] = by_cat.get(c["category"], 0) + 1
    for cat, n in by_cat.items():
        print(f"    - {cat}: {n}")

    strategies = [s.strip() for s in args.strategies.split(",")]
    total_calls = len(cases) * len(strategies)
    print(f"\n[3/3] 실행 중... ({total_calls} calls)")

    results: dict[str, dict[str, dict]] = {c["id"]: {} for c in cases}
    t_start = time.time()
    n_done = 0

    for c in cases:
        for s in strategies:
            r = call_one(args.base, s, c, args.top_n)
            results[c["id"]][s] = r
            n_done += 1
            if n_done % 20 == 0:
                el = time.time() - t_start
                print(f"  {n_done}/{total_calls}  ({el:.0f}s elapsed)")

    el_total = time.time() - t_start
    print(f"\n  done in {el_total:.0f}s ({total_calls/el_total:.1f} calls/s)\n")

    # ── 종합 ──
    print("=" * 90)
    print("=== 종합 ===\n")

    # strategy 별 PASS/lat
    strat_stats: dict[str, dict] = {s: {"pass": 0, "lats": []} for s in strategies}
    for c in cases:
        for s in strategies:
            r = results[c["id"]][s]
            if r["passed"]:
                strat_stats[s]["pass"] += 1
            strat_stats[s]["lats"].append(r["latency_ms"])

    print(f"{'strategy':12s}  {'PASS':>10s}  {'avg':>7s}  {'p50':>7s}  {'p90':>7s}  {'max':>7s}")
    for s in strategies:
        st = strat_stats[s]
        lats = sorted(st["lats"])
        n = len(lats)
        avg = sum(lats) // n if n else 0
        p50 = lats[n // 2] if n else 0
        p90 = lats[int(n * 0.9)] if n else 0
        mx = lats[-1] if n else 0
        rate = st["pass"] / n * 100 if n else 0
        print(f"{s:12s}  {st['pass']:>3}/{n:<3} ({rate:.0f}%)  {avg:>5}ms  {p50:>5}ms  {p90:>5}ms  {mx:>5}ms")

    # 카테고리 × strategy 매트릭스
    print("\n=== 카테고리별 PASS rate ===\n")
    cats: dict[str, list[dict]] = {}
    for c in cases:
        cats.setdefault(c["category"], []).append(c)
    print(f"{'category':22s}  total  " + "  ".join(f"{s:>14s}" for s in strategies))
    for cat, cat_cases in cats.items():
        row = []
        for s in strategies:
            n_p = sum(1 for c in cat_cases if results[c["id"]][s]["passed"])
            rate = n_p / len(cat_cases) * 100
            row.append(f"{n_p:>3}/{len(cat_cases):<3} ({rate:>3.0f}%)")
        print(f"{cat:22s}  {len(cat_cases):>5}  " + "  ".join(f"{r:>14s}" for r in row))

    # 모든 strategy 가 fail 한 케이스 (진짜 어려운 케이스)
    print("\n=== 모든 strategy 실패 케이스 (시스템적 미스) ===")
    hard_cases = []
    for c in cases:
        if all(not results[c["id"]][s]["passed"] for s in strategies):
            hard_cases.append(c)
    if not hard_cases:
        print("  (없음 — 모든 케이스 최소 1 strategy 가 잡음)")
    else:
        print(f"  총 {len(hard_cases)} 건:")
        for c in hard_cases[:15]:
            print(f"    [{c['id']}] {c['query']!r}  ({c['category']})")
        if len(hard_cases) > 15:
            print(f"    ... +{len(hard_cases) - 15} more")

    # auto routing 분포 (auto strategy 만)
    if "auto" in strategies:
        print("\n=== auto routing 분포 ===")
        routed_count: dict[str, int] = {}
        routed_pass: dict[str, list[bool]] = {}
        for c in cases:
            r = results[c["id"]].get("auto", {})
            rt = r.get("result", {}).get("routed_to") or "?"
            routed_count[rt] = routed_count.get(rt, 0) + 1
            routed_pass.setdefault(rt, []).append(bool(r.get("passed")))
        print(f"  {'routed_to':18s}  count   PASS rate")
        for k, v in sorted(routed_count.items(), key=lambda x: -x[1]):
            ps = routed_pass[k]
            rate = sum(ps) / len(ps) * 100 if ps else 0
            print(f"  {k:18s}  {v:>5}   {sum(ps)}/{len(ps)} ({rate:.0f}%)")

    # JSON 으로 저장
    out_path = Path(__file__).resolve().parent / "quick_find_100_results.json"
    out_path.write_text(json.dumps(
        {"cases": cases, "results": results, "strat_stats": {
            s: {"pass": st["pass"], "n": len(st["lats"])} for s, st in strat_stats.items()
        }},
        ensure_ascii=False, indent=2, default=str,
    ))
    print(f"\n전체 결과 저장: {out_path}")


if __name__ == "__main__":
    main()
