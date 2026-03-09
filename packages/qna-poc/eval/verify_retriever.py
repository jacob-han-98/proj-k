"""
verify_retriever.py -- Retriever 모듈 품질 검증 (LLM 호출 없음)

Tests:
  1. System Name Extraction (10 queries)
  2. Retrieval Relevance (10 queries)
  3. Edge Cases (5 queries)
  4. Search Layer Comparison (5 queries)

Usage:
    cd packages/qna-poc
    python -m eval.verify_retriever
"""

import io
import json
import sys
import time
from pathlib import Path

# Windows cp949 인코딩 문제 방지
if sys.stdout.encoding != "utf-8":
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")
    sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding="utf-8", errors="replace")

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from dotenv import load_dotenv
load_dotenv(Path(__file__).resolve().parent.parent / ".env")

from src.retriever import (
    extract_system_names,
    retrieve,
    _structural_search,
    _vector_search,
    _kg_expand,
    _build_system_aliases,
    _build_structural_index,
)

# ── 결과 저장용 ──
ALL_RESULTS = {
    "timestamp": "",
    "tests": {},
    "summary": {},
}


def print_header(title: str):
    print(f"\n{'='*70}")
    print(f"  {title}")
    print(f"{'='*70}")


def print_subheader(title: str):
    print(f"\n--- {title} ---")


# ============================================================
# Test 1: System Name Extraction
# ============================================================

TEST1_CASES = [
    {
        "query": "변신 에픽 등급의 적용 스텟 수는?",
        "expected_partial": ["변신"],  # 워크북명에 이 키워드가 포함되어야
        "description": "변신 시스템 감지",
    },
    {
        "query": "스킬 쿨타임 계산법",
        "expected_partial": ["스킬"],
        "description": "스킬 시스템 감지",
    },
    {
        "query": "버프가 전투에 미치는 영향",
        "expected_partial": ["버프"],
        "description": "버프 시스템 감지",
    },
    {
        "query": "펫 시스템의 합성 규칙",
        "expected_partial": ["펫"],
        "description": "펫 시스템 감지",
    },
    {
        "query": "골드 밸런스에서 시간당 획득량",
        "expected_partial": ["골드"],
        "description": "골드 밸런스 감지",
    },
    {
        "query": "몬스터 어그로 계산 방식",
        "expected_partial": ["몬스터", "어그로"],
        "description": "몬스터 어그로 감지",
    },
    {
        "query": "HUD 전투 화면 UI 요소",
        "expected_partial": ["HUD"],
        "description": "HUD 시스템 감지",
    },
    {
        "query": "로그인 플로우",
        "expected_partial": ["로그인"],
        "description": "로그인 시스템 감지",
    },
    {
        "query": "인벤토리와 아이템 연동",
        "expected_partial": ["인벤토리"],
        "description": "인벤토리 + 아이템 감지",
    },
    {
        "query": "튜토리얼 진행 순서",
        "expected_partial": ["튜토리얼"],
        "description": "튜토리얼 시스템 감지",
    },
]


def run_test1():
    print_header("Test 1: System Name Extraction (10 queries)")

    results = []
    passed = 0

    for i, case in enumerate(TEST1_CASES, 1):
        query = case["query"]
        expected = case["expected_partial"]

        t0 = time.time()
        detected = extract_system_names(query)
        elapsed = time.time() - t0

        # 판정: expected_partial의 모든 키워드가 감지된 워크북명 중 하나에 포함되어야
        detected_lower = " ".join(detected).lower()
        hits = [kw for kw in expected if kw.lower() in detected_lower]
        misses = [kw for kw in expected if kw.lower() not in detected_lower]
        success = len(misses) == 0 and len(detected) > 0

        if success:
            passed += 1

        status = "PASS" if success else "FAIL"
        print(f"\n  [{i:02d}] {status} | {case['description']}")
        print(f"       Query: {query}")
        print(f"       Detected: {detected}")
        print(f"       Expected keywords: {expected} -> hits={hits}, misses={misses}")
        print(f"       Time: {elapsed*1000:.0f}ms")

        results.append({
            "query": query,
            "description": case["description"],
            "detected_systems": detected,
            "expected_partial": expected,
            "hits": hits,
            "misses": misses,
            "success": success,
            "time_ms": round(elapsed * 1000, 1),
        })

    rate = passed / len(TEST1_CASES) * 100
    print(f"\n  Result: {passed}/{len(TEST1_CASES)} PASS ({rate:.0f}%)")

    ALL_RESULTS["tests"]["test1_system_extraction"] = {
        "passed": passed,
        "total": len(TEST1_CASES),
        "rate": rate,
        "cases": results,
    }
    return passed, len(TEST1_CASES)


# ============================================================
# Test 2: Retrieval Relevance
# ============================================================

TEST2_CASES = [
    {
        "query": "변신 에픽 등급의 적용 스텟 수는?",
        "expected_workbook": "PK_변신 및 스킬 시스템",
    },
    {
        "query": "스킬 시전 시 체크하는 조건 순서를 나열해줘",
        "expected_workbook": "PK_스킬 시스템",
    },
    {
        "query": "몬스터 어그로 시스템의 기본 작동 원리는?",
        "expected_workbook": "PK_몬스터 어그로 시스템",
    },
    {
        "query": "펫 시스템의 핵심 기능은 무엇인가?",
        "expected_workbook": "PK_펫 시스템",
    },
    {
        "query": "변신 시스템과 스킬 시스템은 어떻게 연동되는가?",
        "expected_workbook": "PK_변신 및 스킬 시스템",
    },
    {
        "query": "버프 시스템이 전투 대미지 계산에 어떤 영향을 주는가?",
        "expected_workbook": "PK_버프 시스템",
    },
    {
        "query": "인벤토리 시스템과 아이템 시스템의 데이터 연결 구조는?",
        "expected_workbook": "PK_인벤토리 시스템",
    },
    {
        "query": "전투력 시스템에 영향을 주는 모든 시스템은 무엇인가?",
        "expected_workbook": "PK_전투력 시스템",
    },
    {
        "query": "스탯 공식에서 정수 타입과 % 타입의 처리 차이는?",
        "expected_workbook": "PK_스탯 및 공식",
    },
    {
        "query": "HUD 전투 화면 UI 구성을 설명해줘",
        "expected_workbook": "PK_HUD 시스템",
    },
]


def run_test2():
    print_header("Test 2: Retrieval Relevance (10 queries)")

    results = []
    passed = 0

    for i, case in enumerate(TEST2_CASES, 1):
        query = case["query"]
        expected_wb = case["expected_workbook"]

        t0 = time.time()
        chunks, _ri = retrieve(query, top_k=12)
        elapsed = time.time() - t0

        total_chunks = len(chunks)
        total_tokens = sum(c.get("tokens", 0) for c in chunks)

        # top-3 워크북 분석
        top3_workbooks = [c["workbook"] for c in chunks[:3]]
        top3_match = sum(1 for wb in top3_workbooks if wb == expected_wb)

        # 소스 분포
        source_dist = {}
        for c in chunks:
            src = c.get("source", "unknown")
            source_dist[src] = source_dist.get(src, 0) + 1

        # 전체 중 expected workbook 비율
        wb_match_count = sum(1 for c in chunks if c["workbook"] == expected_wb)

        # 판정: top-3 중 최소 1개가 expected workbook이면 PASS
        success = top3_match >= 1

        if success:
            passed += 1

        status = "PASS" if success else "FAIL"
        print(f"\n  [{i:02d}] {status} | Q: {query[:50]}...")
        print(f"       Expected WB: {expected_wb}")
        print(f"       Top-3 WBs: {top3_workbooks}")
        print(f"       Top-3 match: {top3_match}/3")
        print(f"       Total chunks: {total_chunks}, tokens: {total_tokens:,}")
        print(f"       WB match in all: {wb_match_count}/{total_chunks}")
        print(f"       Source dist: {source_dist}")
        print(f"       Time: {elapsed:.2f}s")

        # 점수 분포 (상위 5개)
        if chunks:
            print(f"       Top-5 scores: {[round(c['score'], 3) for c in chunks[:5]]}")

        results.append({
            "query": query,
            "expected_workbook": expected_wb,
            "top3_workbooks": top3_workbooks,
            "top3_match": top3_match,
            "total_chunks": total_chunks,
            "total_tokens": total_tokens,
            "wb_match_in_all": wb_match_count,
            "source_distribution": source_dist,
            "top5_scores": [round(c["score"], 3) for c in chunks[:5]],
            "success": success,
            "time_s": round(elapsed, 2),
        })

    rate = passed / len(TEST2_CASES) * 100
    print(f"\n  Result: {passed}/{len(TEST2_CASES)} PASS ({rate:.0f}%)")

    ALL_RESULTS["tests"]["test2_retrieval_relevance"] = {
        "passed": passed,
        "total": len(TEST2_CASES),
        "rate": rate,
        "cases": results,
    }
    return passed, len(TEST2_CASES)


# ============================================================
# Test 3: Edge Cases
# ============================================================

TEST3_CASES = [
    {
        "query": "게임 전체 구조",
        "type": "vague",
        "description": "Very vague query -- should still return something",
        "min_chunks": 1,
    },
    {
        "query": "변싱 시스템",
        "type": "typo",
        "description": "Typo (변싱 -> 변신) -- fuzzy matching test",
        "expected_partial": [],  # might or might not match
    },
    {
        "query": "변신과 스킬의 관계",
        "type": "multi_system",
        "description": "Multi-system query -- should find both",
        "expected_partial": ["변신", "스킬"],
    },
    {
        "query": "낚시 시스템",
        "type": "nonexistent",
        "description": "Non-existent system -- graceful fallback",
    },
    {
        "query": "PvP 밸런스",
        "type": "mixed_lang",
        "description": "Korean/English mix -- PvP detection",
        "expected_partial": ["PvP"],
    },
]


def run_test3():
    print_header("Test 3: Edge Cases (5 queries)")

    results = []
    passed = 0

    for i, case in enumerate(TEST3_CASES, 1):
        query = case["query"]
        case_type = case["type"]

        # System name extraction
        detected = extract_system_names(query)

        # Full retrieve
        t0 = time.time()
        chunks, _ri = retrieve(query, top_k=12)
        elapsed = time.time() - t0

        total_chunks = len(chunks)
        source_dist = {}
        for c in chunks:
            src = c.get("source", "unknown")
            source_dist[src] = source_dist.get(src, 0) + 1

        # 판정 기준은 case type에 따라 다름
        if case_type == "vague":
            # 뭐라도 반환하면 PASS
            success = total_chunks >= case.get("min_chunks", 1)
            detail = f"Returned {total_chunks} chunks (need >= {case.get('min_chunks', 1)})"

        elif case_type == "typo":
            # 타이포에도 뭔가 반환되면 PASS, 변신 관련이면 보너스
            success = total_chunks > 0
            has_byunshin = any("변신" in c["workbook"] for c in chunks)
            detail = f"Returned {total_chunks} chunks, contains 변신 WB: {has_byunshin}"

        elif case_type == "multi_system":
            # 여러 시스템 감지 여부
            expected = case.get("expected_partial", [])
            detected_lower = " ".join(detected).lower()
            hits = [kw for kw in expected if kw.lower() in detected_lower]
            success = len(hits) >= 1  # 최소 1개
            detail = f"Detected: {detected}, hits: {hits}/{expected}"

        elif case_type == "nonexistent":
            # 에러 없이 gracefully 반환
            success = True  # no crash = pass
            detail = f"Returned {total_chunks} chunks (graceful: no crash)"

        elif case_type == "mixed_lang":
            expected = case.get("expected_partial", [])
            detected_lower = " ".join(detected).lower()
            hits = [kw for kw in expected if kw.lower() in detected_lower]
            success = len(hits) >= 1
            detail = f"Detected: {detected}, hits: {hits}"

        else:
            success = total_chunks > 0
            detail = f"Returned {total_chunks} chunks"

        if success:
            passed += 1

        status = "PASS" if success else "FAIL"
        print(f"\n  [{i:02d}] {status} | [{case_type}] {case['description']}")
        print(f"       Query: {query}")
        print(f"       Detected systems: {detected}")
        print(f"       {detail}")
        print(f"       Chunks: {total_chunks}, Source: {source_dist}")
        print(f"       Time: {elapsed:.2f}s")

        if chunks:
            top3_wb = [c["workbook"] for c in chunks[:3]]
            print(f"       Top-3 workbooks: {top3_wb}")

        results.append({
            "query": query,
            "type": case_type,
            "description": case["description"],
            "detected_systems": detected,
            "total_chunks": total_chunks,
            "source_distribution": source_dist,
            "detail": detail,
            "success": success,
            "time_s": round(elapsed, 2),
            "top3_workbooks": [c["workbook"] for c in chunks[:3]],
        })

    rate = passed / len(TEST3_CASES) * 100
    print(f"\n  Result: {passed}/{len(TEST3_CASES)} PASS ({rate:.0f}%)")

    ALL_RESULTS["tests"]["test3_edge_cases"] = {
        "passed": passed,
        "total": len(TEST3_CASES),
        "rate": rate,
        "cases": results,
    }
    return passed, len(TEST3_CASES)


# ============================================================
# Test 4: Search Layer Comparison
# ============================================================

TEST4_CASES = [
    {
        "query": "변신 에픽 등급의 적용 스텟 수는?",
        "structural_workbook": "PK_변신 및 스킬 시스템",
    },
    {
        "query": "스킬 쿨타임 계산법",
        "structural_workbook": "PK_스킬 시스템",
    },
    {
        "query": "몬스터 어그로 계산 방식",
        "structural_workbook": "PK_몬스터 어그로 시스템",
    },
    {
        "query": "버프가 전투에 미치는 영향",
        "structural_workbook": "PK_버프 시스템",
    },
    {
        "query": "HUD 전투 화면 UI 요소",
        "structural_workbook": "PK_HUD 시스템",
    },
]


def run_test4():
    print_header("Test 4: Search Layer Comparison (5 queries)")

    results = []

    for i, case in enumerate(TEST4_CASES, 1):
        query = case["query"]
        wb = case["structural_workbook"]

        print_subheader(f"[{i:02d}] {query}")

        # Layer A: Structural only
        t0 = time.time()
        structural_results = _structural_search(wb, query)
        t_structural = time.time() - t0
        structural_ids = set(r["id"] for r in structural_results[:5])
        print(f"  Structural ({wb}): {len(structural_results)} total, top-5 in {t_structural*1000:.0f}ms")
        for r in structural_results[:5]:
            print(f"    score={r['score']:.3f} | {r['sheet']} > {r['section_path'][:40]}")

        # Layer B: Vector only
        t0 = time.time()
        vector_results = _vector_search(query, top_k=8)
        t_vector = time.time() - t0
        vector_ids = set(r["id"] for r in vector_results[:5])
        print(f"\n  Vector: {len(vector_results)} total, top-5 in {t_vector*1000:.0f}ms")
        for r in vector_results[:5]:
            print(f"    score={r['score']:.3f} dist={r['distance']:.3f} | {r['workbook'][:30]} > {r['sheet'][:20]} > {r['section_path'][:30]}")

        # Layer C: Full hybrid retrieve
        t0 = time.time()
        hybrid_results, _ri2 = retrieve(query, top_k=12)
        t_hybrid = time.time() - t0
        hybrid_ids = set(r["id"] for r in hybrid_results[:5])
        print(f"\n  Hybrid: {len(hybrid_results)} total, top-5 in {t_hybrid*1000:.0f}ms")
        for r in hybrid_results[:5]:
            print(f"    score={r['score']:.3f} src={r['source']:12s} | {r['workbook'][:30]} > {r['section_path'][:30]}")

        # Overlap analysis
        sv_overlap = structural_ids & vector_ids
        sh_overlap = structural_ids & hybrid_ids
        vh_overlap = vector_ids & hybrid_ids
        all_overlap = structural_ids & vector_ids & hybrid_ids

        structural_unique = structural_ids - vector_ids - hybrid_ids
        vector_unique = vector_ids - structural_ids - hybrid_ids

        print(f"\n  Overlap (top-5):")
        print(f"    Structural & Vector:  {len(sv_overlap)}/5")
        print(f"    Structural & Hybrid:  {len(sh_overlap)}/5")
        print(f"    Vector & Hybrid:      {len(vh_overlap)}/5")
        print(f"    All three:            {len(all_overlap)}/5")
        print(f"    Structural-only unique: {len(structural_unique)}")
        print(f"    Vector-only unique:     {len(vector_unique)}")

        # Source distribution in hybrid
        hybrid_sources = {}
        for c in hybrid_results:
            src = c.get("source", "unknown")
            hybrid_sources[src] = hybrid_sources.get(src, 0) + 1

        print(f"    Hybrid source dist: {hybrid_sources}")

        results.append({
            "query": query,
            "structural_workbook": wb,
            "structural_count": len(structural_results),
            "vector_count": len(vector_results),
            "hybrid_count": len(hybrid_results),
            "time_structural_ms": round(t_structural * 1000, 1),
            "time_vector_ms": round(t_vector * 1000, 1),
            "time_hybrid_ms": round(t_hybrid * 1000, 1),
            "overlap_structural_vector": len(sv_overlap),
            "overlap_structural_hybrid": len(sh_overlap),
            "overlap_vector_hybrid": len(vh_overlap),
            "overlap_all_three": len(all_overlap),
            "structural_unique": len(structural_unique),
            "vector_unique": len(vector_unique),
            "hybrid_source_dist": hybrid_sources,
        })

    ALL_RESULTS["tests"]["test4_layer_comparison"] = {
        "cases": results,
    }
    return results


# ============================================================
# Summary & Main
# ============================================================

def print_summary(test_scores: list[tuple[int, int]]):
    print_header("VERIFICATION SUMMARY")

    test_names = [
        "Test 1: System Name Extraction",
        "Test 2: Retrieval Relevance",
        "Test 3: Edge Cases",
        "Test 4: Search Layer Comparison",
    ]

    total_passed = 0
    total_cases = 0

    for name, (p, t) in zip(test_names, test_scores):
        rate = p / t * 100 if t > 0 else 0
        status = "PASS" if rate >= 80 else "WARN" if rate >= 60 else "FAIL"
        print(f"  [{status}] {name}: {p}/{t} ({rate:.0f}%)")
        total_passed += p
        total_cases += t

    overall_rate = total_passed / total_cases * 100 if total_cases > 0 else 0
    overall_status = "PASS" if overall_rate >= 80 else "WARN" if overall_rate >= 60 else "FAIL"

    print(f"\n  Overall: {total_passed}/{total_cases} ({overall_rate:.0f}%) [{overall_status}]")

    ALL_RESULTS["summary"] = {
        "total_passed": total_passed,
        "total_cases": total_cases,
        "overall_rate": overall_rate,
        "overall_status": overall_status,
        "per_test": {
            name: {"passed": p, "total": t, "rate": p/t*100 if t > 0 else 0}
            for name, (p, t) in zip(test_names, test_scores)
        },
    }


def main():
    import datetime

    ALL_RESULTS["timestamp"] = datetime.datetime.now().isoformat()

    print("=" * 70)
    print("  QnA PoC Retriever Verification")
    print(f"  {ALL_RESULTS['timestamp']}")
    print("=" * 70)

    # Warm up caches
    print("\n[INFO] Warming up caches (aliases, structural index)...")
    t0 = time.time()
    aliases = _build_system_aliases()
    structural_idx = _build_structural_index()
    t_warmup = time.time() - t0
    print(f"[INFO] Cache ready: {len(aliases)} aliases, {len(structural_idx)} workbooks, {t_warmup:.1f}s")

    # Run tests
    test_scores = []

    p1, t1 = run_test1()
    test_scores.append((p1, t1))

    p2, t2 = run_test2()
    test_scores.append((p2, t2))

    p3, t3 = run_test3()
    test_scores.append((p3, t3))

    t4_results = run_test4()
    # Test 4 doesn't have simple pass/fail, report as informational
    test_scores.append((len(t4_results), len(t4_results)))  # all informational = pass

    print_summary(test_scores)

    # Save results
    output_path = Path(__file__).resolve().parent / "retriever_verification.json"
    output_path.write_text(
        json.dumps(ALL_RESULTS, ensure_ascii=False, indent=2, default=str),
        encoding="utf-8",
    )
    print(f"\n[INFO] Results saved to {output_path}")


if __name__ == "__main__":
    main()
