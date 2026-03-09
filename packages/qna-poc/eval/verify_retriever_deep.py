"""
verify_retriever_deep.py — Retriever 심층 검증

방법론: Claude Code가 원본 content.md를 직접 읽어 Ground Truth를 산출한 뒤,
Retriever 결과와 비교하여 검색 품질을 정량 평가한다.

Usage:
    python -m eval.verify_retriever_deep
"""

import io
import json
import sys
import time
from pathlib import Path

if sys.stdout.encoding != "utf-8":
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")
    sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding="utf-8", errors="replace")

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from dotenv import load_dotenv
load_dotenv(Path(__file__).resolve().parent.parent / ".env")

from src.retriever import (
    retrieve, extract_system_names, _vector_search,
    _structural_search, _build_system_aliases, format_context
)

# ── Ground Truth (Claude Code가 원본 content.md를 직접 읽어 산출) ──

GROUND_TRUTH = [
    {
        "id": "GT-01",
        "query": "변신 에픽 등급의 적용 스텟 수는?",
        "expected_workbooks": ["PK_변신 및 스킬 시스템"],
        "expected_sheets": ["변신"],
        "expected_answer_keywords": ["7", "에픽", "적용 스텟"],
        "ground_truth_source": "PK_변신 및 스킬 시스템/변신/_final/content.md:66",
        "ground_truth_text": "등급별 스펙 규칙 테이블에서 에픽 등급의 적용 스텟 수 = 7",
    },
    {
        "id": "GT-02",
        "query": "몬스터 어그로 계산 방식은?",
        "expected_workbooks": ["PK_몬스터 어그로 시스템"],
        "expected_sheets": ["몬스터 타기팅"],
        "expected_answer_keywords": ["어그로", "누적", "대미지", "1:1"],
        "ground_truth_source": "PK_몬스터 어그로 시스템/몬스터 타기팅/_final/content.md:75-78",
        "ground_truth_text": "누적 대미지 기반 1:1 비율로 어그로 수치 계산, 높은 순으로 우선순위 결정",
    },
    {
        "id": "GT-03",
        "query": "인벤토리와 아이템의 데이터 연결 구조는?",
        "expected_workbooks": ["PK_인벤토리 시스템", "PK_아이템 시스템"],
        "expected_sheets": ["인벤토리", "개요", "테이블 정보"],
        "expected_answer_keywords": ["인벤토리", "아이템", "MaxStack", "ItemType"],
        "ground_truth_source": "PK_인벤토리 시스템/인벤토리/_final/content.md + PK_아이템 시스템/개요/_final/content.md",
        "ground_truth_text": "인벤토리는 ItemTypeEnum으로 아이템을 분류(Equip/Consume/Material/Quest), MaxStack으로 중첩 제한",
    },
    {
        "id": "GT-04",
        "query": "PvP 시스템의 핵심 규칙은?",
        "expected_workbooks": ["PK_피아 식별"],
        "expected_sheets": ["기조 변경", "피아 관계의 결정"],
        "expected_answer_keywords": ["PvP", "피아", "패시브", "어그레시브"],
        "ground_truth_source": "PK_피아 식별/기조 변경/_final/content.md",
        "ground_truth_text": "패시브 모드(방어 위주, 선공 불가) vs 어그레시브 모드(선공 가능), UI 하단 좌측 토글",
    },
    {
        "id": "GT-05",
        "query": "'발동 액션'이란 용어의 정의는?",
        "expected_workbooks": ["PK_발동 액션 시스템"],
        "expected_sheets": ["발동 액션"],
        "expected_answer_keywords": ["발동 액션", "확률", "공격", "특수"],
        "ground_truth_source": "PK_발동 액션 시스템/발동 액션/_final/content.md:11-12",
        "ground_truth_text": "공격 시 확률 발동되는 특수 공격",
    },
    {
        "id": "GT-06",
        "query": "스킬 시전 시 체크하는 조건 순서는?",
        "expected_workbooks": ["PK_스킬 시스템"],
        "expected_sheets": ["스킬"],
        "expected_answer_keywords": ["쿨타임", "타겟", "사정거리"],
        "ground_truth_source": "PK_스킬 시스템/스킬/_final/content.md",
        "ground_truth_text": "쿨타임 체크 → 타겟 유효성 → 사정거리 → Cost 소모 → 시전",
    },
    {
        "id": "GT-07",
        "query": "골드 밸런스에서 필드 사냥 기준 시간당 획득량은?",
        "expected_workbooks": ["PK_골드 밸런스"],
        "expected_sheets": [],
        "expected_answer_keywords": ["골드", "사냥", "시간"],
        "ground_truth_source": "PK_골드 밸런스 content.md",
        "ground_truth_text": "레벨/난이도별 시간당 골드 획득량 테이블",
    },
    {
        "id": "GT-08",
        "query": "HUD 전투 화면에서 표시해야 할 UI 요소 목록은?",
        "expected_workbooks": ["PK_HUD 시스템"],
        "expected_sheets": ["HUD_기본"],
        "expected_answer_keywords": ["HUD", "HP", "스킬"],
        "ground_truth_source": "PK_HUD 시스템/HUD_기본/_final/content.md",
        "ground_truth_text": "타겟 정보, HP/MP 바, 스킬 슬롯, 미니맵, 채팅 등",
    },
    {
        "id": "GT-09",
        "query": "변신 시스템과 스킬 시스템은 어떻게 연동되는가?",
        "expected_workbooks": ["PK_변신 및 스킬 시스템"],
        "expected_sheets": ["변신", "스킬"],
        "expected_answer_keywords": ["변신", "스킬", "발동 액션", "의상"],
        "ground_truth_source": "PK_변신 및 스킬 시스템/변신 + 스킬/_final/content.md",
        "ground_truth_text": "스킬은 의상(변신)에 귀속, 의상 착용 시 스킬 자동 장착",
    },
    {
        "id": "GT-10",
        "query": "전투AI 시스템의 기본 상태 전이 흐름은?",
        "expected_workbooks": ["PK_전투AI시스템"],
        "expected_sheets": [],
        "expected_answer_keywords": ["전투", "AI", "상태"],
        "ground_truth_source": "PK_전투AI시스템 content.md",
        "ground_truth_text": "스폰 → 반응 체크 → 대기/추적/공격 상태 전이",
    },
]


def check_workbook_in_results(results: list[dict], expected_wbs: list[str]) -> dict:
    """검색 결과에 기대 워크북이 포함되어 있는지 확인."""
    result_wbs = set()
    for r in results:
        wb = r.get("workbook", "")
        if wb:
            result_wbs.add(wb)

    found = []
    missed = []
    for wb in expected_wbs:
        matched = any(wb.lower() in rwb.lower() or rwb.lower() in wb.lower()
                      for rwb in result_wbs)
        if matched:
            found.append(wb)
        else:
            missed.append(wb)

    return {
        "found": found,
        "missed": missed,
        "all_found": len(missed) == 0,
        "result_workbooks": sorted(result_wbs),
    }


def check_keywords_in_results(results: list[dict], keywords: list[str]) -> dict:
    """검색 결과 텍스트에 기대 키워드가 포함되어 있는지 확인."""
    all_text = " ".join(r.get("text", "") for r in results).lower()
    found = [kw for kw in keywords if kw.lower() in all_text]
    missed = [kw for kw in keywords if kw.lower() not in all_text]
    return {
        "found": found,
        "missed": missed,
        "score": len(found) / max(len(keywords), 1),
    }


def check_top_k_relevance(results: list[dict], expected_wbs: list[str], k: int = 3) -> dict:
    """상위 K개 결과의 관련성 확인."""
    top_k = results[:k]
    relevant = 0
    for r in top_k:
        wb = r.get("workbook", "").lower()
        if any(ew.lower() in wb or wb in ew.lower() for ew in expected_wbs):
            relevant += 1
    return {
        "top_k": k,
        "relevant": relevant,
        "precision": relevant / k if k > 0 else 0,
        "top_k_workbooks": [r.get("workbook", "") for r in top_k],
        "top_k_sources": [r.get("source", "") for r in top_k],
    }


def analyze_source_distribution(results: list[dict]) -> dict:
    """검색 레이어별 결과 분포."""
    dist = {}
    for r in results:
        src = r.get("source", "unknown")
        dist[src] = dist.get(src, 0) + 1
    return dist


def run_verification():
    """심층 검증 실행."""
    print("=" * 70)
    print("  Retriever 심층 검증 — Ground Truth 비교")
    print("  방법: Claude Code가 원본 content.md를 직접 읽어 정답 산출 후 비교")
    print("=" * 70)

    all_results = []
    total_pass = 0

    for gt in GROUND_TRUTH:
        print(f"\n{'─' * 60}")
        print(f"[{gt['id']}] {gt['query']}")
        print(f"  Ground Truth 출처: {gt['ground_truth_source']}")
        print(f"  Ground Truth 답변: {gt['ground_truth_text']}")

        # 1. 시스템명 추출
        t_start = time.time()
        detected = extract_system_names(gt["query"])
        t_extract = time.time() - t_start

        print(f"\n  [시스템명 추출] ({t_extract:.3f}s)")
        print(f"    감지: {detected}")
        print(f"    기대: {gt['expected_workbooks']}")

        # 2. 전체 하이브리드 검색
        t_start = time.time()
        results, _retrieval_info = retrieve(gt["query"], top_k=12)
        t_retrieve = time.time() - t_start

        # 3. 워크북 포함 확인
        wb_check = check_workbook_in_results(results, gt["expected_workbooks"])
        print(f"\n  [워크북 매칭] ({t_retrieve:.1f}s, {len(results)} chunks)")
        print(f"    찾음: {wb_check['found']}")
        if wb_check["missed"]:
            print(f"    누락: {wb_check['missed']}")
        print(f"    전체 결과 워크북: {wb_check['result_workbooks']}")

        # 4. 상위 3개 관련성
        top3 = check_top_k_relevance(results, gt["expected_workbooks"], k=3)
        print(f"\n  [Top-3 정밀도] {top3['relevant']}/{top3['top_k']} ({top3['precision']:.0%})")
        for i, (wb, src) in enumerate(zip(top3["top_k_workbooks"], top3["top_k_sources"]), 1):
            print(f"    #{i}: {wb} ({src})")

        # 5. 키워드 포함 확인
        kw_check = check_keywords_in_results(results, gt["expected_answer_keywords"])
        print(f"\n  [키워드 적중] {len(kw_check['found'])}/{len(gt['expected_answer_keywords'])} ({kw_check['score']:.0%})")
        if kw_check["missed"]:
            print(f"    누락 키워드: {kw_check['missed']}")

        # 6. 소스 분포
        src_dist = analyze_source_distribution(results)
        print(f"\n  [검색 레이어 분포] {src_dist}")

        # 7. 토큰 사용량
        total_tokens = sum(r.get("tokens", 0) for r in results)
        print(f"  [토큰] {total_tokens:,} / 80,000 ({total_tokens/80000:.0%})")

        # 종합 판정
        passed = wb_check["all_found"] and kw_check["score"] >= 0.5 and top3["precision"] >= 0.33
        status = "PASS" if passed else "FAIL"
        if passed:
            total_pass += 1
        print(f"\n  >>> 결과: {status}")

        all_results.append({
            "id": gt["id"],
            "query": gt["query"],
            "ground_truth_source": gt["ground_truth_source"],
            "ground_truth_text": gt["ground_truth_text"],
            "detected_systems": detected,
            "expected_workbooks": gt["expected_workbooks"],
            "workbook_check": wb_check,
            "top3_precision": top3["precision"],
            "top3_workbooks": top3["top_k_workbooks"],
            "top3_sources": top3["top_k_sources"],
            "keyword_score": kw_check["score"],
            "keyword_missed": kw_check["missed"],
            "source_distribution": src_dist,
            "total_tokens": total_tokens,
            "retrieve_time": round(t_retrieve, 2),
            "total_chunks": len(results),
            "passed": passed,
        })

    # ── 요약 ──
    print(f"\n{'=' * 70}")
    print(f"  심층 검증 결과: {total_pass}/{len(GROUND_TRUTH)} PASS ({total_pass/len(GROUND_TRUTH):.0%})")
    print(f"{'=' * 70}")

    # 카테고리별 분석
    avg_top3 = sum(r["top3_precision"] for r in all_results) / len(all_results)
    avg_kw = sum(r["keyword_score"] for r in all_results) / len(all_results)
    avg_time = sum(r["retrieve_time"] for r in all_results) / len(all_results)
    avg_tokens = sum(r["total_tokens"] for r in all_results) / len(all_results)

    print(f"\n  평균 Top-3 정밀도: {avg_top3:.0%}")
    print(f"  평균 키워드 적중률: {avg_kw:.0%}")
    print(f"  평균 검색 시간: {avg_time:.1f}s")
    print(f"  평균 토큰 사용: {avg_tokens:,.0f}")

    # 실패 목록
    failed = [r for r in all_results if not r["passed"]]
    if failed:
        print(f"\n  FAILED ({len(failed)}):")
        for r in failed:
            print(f"    [{r['id']}] {r['query']}")
            print(f"      워크북 누락: {r['workbook_check']['missed']}")
            print(f"      키워드 누락: {r['keyword_missed']}")
            print(f"      Top-3: {r['top3_workbooks']}")

    # 결과 저장
    output = {
        "summary": {
            "total": len(GROUND_TRUTH),
            "passed": total_pass,
            "accuracy": total_pass / len(GROUND_TRUTH),
            "avg_top3_precision": round(avg_top3, 3),
            "avg_keyword_score": round(avg_kw, 3),
            "avg_retrieve_time": round(avg_time, 2),
            "avg_tokens": round(avg_tokens),
        },
        "methodology": "Claude Code가 원본 content.md를 직접 읽어 Ground Truth(정답 출처+텍스트)를 산출한 뒤, "
                       "Retriever 결과의 워크북/키워드/Top-3 정밀도를 비교 검증",
        "results": all_results,
    }

    output_path = Path(__file__).resolve().parent / "retriever_deep_verification.json"
    output_path.write_text(json.dumps(output, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"\n  결과 저장: {output_path}")

    return output


if __name__ == "__main__":
    run_verification()
