"""
레퍼런스 답변 vs 시스템 답변 자동 비교 평가.

레퍼런스 답변(Opus, Claude 웹앱 시뮬레이션)과 시스템 답변을 LLM Judge로 비교하여
품질 격차를 정량화하고 개선 포인트를 자동 도출한다.

== 사용법 ==
    python -m eval.compare_reference                              # 전체 비교
    python -m eval.compare_reference --sample 5                    # 5개만
    python -m eval.compare_reference --id GT-LLM-A-001             # 특정 1개
    python -m eval.compare_reference --system-results path.json    # 특정 시스템 결과
"""

import argparse
import json
import sys
import time
import threading
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime
from pathlib import Path

sys.stdout.reconfigure(encoding="utf-8", errors="replace")
sys.stderr.reconfigure(encoding="utf-8", errors="replace")

ROOT = Path(__file__).resolve().parent.parent
EVAL_DIR = Path(__file__).resolve().parent
RESULTS_DIR = EVAL_DIR / "results"
REFERENCE_PATH = RESULTS_DIR / "reference_answers.json"
SYSTEM_RESULTS_PATH = RESULTS_DIR / "gt_llm_results_latest.json"

sys.path.insert(0, str(ROOT))
from src.generator import call_bedrock  # noqa: E402

# ── 비교 Judge 프롬프트 ──
COMPARE_JUDGE_PROMPT = """당신은 게임 기획 QnA 시스템의 품질 비교 심사관입니다.
두 답변을 비교하여 품질 격차를 정확히 분석하세요.

## 평가 기준

### 1. information_gap (정보 격차)
레퍼런스에만 있고 시스템 답변에 없는 정보를 리스트로 나열하세요.
각 항목은 구체적이어야 합니다 (예: "스킬 슬롯 시스템의 최대 슬롯 수 정보 누락").

### 2. structural_quality (구조 품질, 1~5)
- 5: 시스템 답변이 레퍼런스와 동등하거나 더 잘 구조화됨
- 4: 약간의 구조 차이 (헤더 누락 등)
- 3: 구조가 있으나 평면적
- 2: 구조가 미흡, 정보 나열 수준
- 1: 비구조적, 읽기 어려움

### 3. completeness_ratio (완전성, 1~5)
- 5: 레퍼런스의 핵심 정보를 95%+ 포함
- 4: 80~95% 포함
- 3: 60~80% 포함
- 2: 40~60% 포함
- 1: 40% 미만

### 4. overall_quality_gap (종합 품질 격차, 1~5)
- 5: 동등하거나 시스템이 더 나음
- 4: 약간의 차이 (실사용에 문제 없음)
- 3: 눈에 띄는 차이 (개선 필요)
- 2: 큰 차이 (중요 정보 누락)
- 1: 심각한 차이 (답변 품질 불충분)

### 5. improvement_priorities (개선 우선순위)
시스템 답변을 레퍼런스 수준으로 끌어올리기 위한 구체적 개선 포인트를 리스트로 제시하세요.
각 포인트에 원인 분류를 포함:
- [프롬프트]: 정보가 컨텍스트에 있었는데 답변에 안 들어감
- [검색]: 관련 정보가 검색에서 빠짐
- [구조]: 정보는 있지만 구조/형식이 부족

## 출력 형식 (JSON만 출력)
```json
{
  "information_gap": ["누락 정보 1", "누락 정보 2"],
  "structural_quality": 4,
  "completeness_ratio": 4,
  "overall_quality_gap": 4,
  "improvement_priorities": ["[프롬프트] 개선 포인트 1", "[검색] 개선 포인트 2"],
  "reasoning": "1~2줄 종합 평가"
}
```"""

# 트랩 질문용 비교 프롬프트
COMPARE_TRAP_PROMPT = """두 답변이 모두 할루시네이션 트랩 질문에 올바르게 대응했는지 비교하세요.

## 평가 기준
- 두 답변 모두 "기획서에 없다"고 명확히 거부했는가?
- 시스템 답변이 레퍼런스만큼 명확하게 거부했는가?
- 불필요한 추측이나 유사 시스템 언급이 없는가?

## 출력 (JSON)
```json
{
  "information_gap": [],
  "structural_quality": 5,
  "completeness_ratio": 5,
  "overall_quality_gap": 5,
  "improvement_priorities": [],
  "reasoning": "트랩 대응 비교 결과"
}
```"""


_lock = threading.Lock()
_done = 0
_total = 0
_results = []


def _parse_json(text: str) -> dict:
    """LLM 응답에서 JSON 추출."""
    import re
    # ```json ... ``` 블록 추출
    m = re.search(r"```json\s*(.*?)\s*```", text, re.DOTALL)
    if m:
        text = m.group(1)
    # { ... } 추출
    m = re.search(r"\{.*\}", text, re.DOTALL)
    if m:
        return json.loads(m.group(0))
    raise ValueError(f"JSON 파싱 실패: {text[:200]}")


def compare_one(ref_entry: dict, sys_entry: dict) -> dict:
    """1개 질문에 대한 비교 평가."""
    global _done
    t0 = time.time()
    qid = ref_entry["id"]
    query = ref_entry["query"]
    is_trap = ref_entry.get("is_trap", False)

    ref_answer = ref_entry.get("reference_answer", "")
    sys_answer = sys_entry.get("generated_answer", "")

    if not ref_answer or ref_entry.get("status") == "error":
        result = {
            "id": qid, "query": query, "status": "skip",
            "reason": "레퍼런스 답변 없음",
        }
        with _lock:
            _done += 1
            _results.append(result)
            print(f"  [{_done}/{_total}] {qid} | SKIP (레퍼런스 없음)")
        return result

    if not sys_answer:
        result = {
            "id": qid, "query": query, "status": "skip",
            "reason": "시스템 답변 없음",
        }
        with _lock:
            _done += 1
            _results.append(result)
            print(f"  [{_done}/{_total}] {qid} | SKIP (시스템 답변 없음)")
        return result

    try:
        prompt = COMPARE_TRAP_PROMPT if is_trap else COMPARE_JUDGE_PROMPT
        user_msg = (
            f"## 질문\n{query}\n\n"
            f"## 레퍼런스 답변 (목표 품질)\n{ref_answer}\n\n"
            f"## 시스템 답변 (현재 품질)\n{sys_answer}"
        )

        llm_result = call_bedrock(
            messages=[{"role": "user", "content": user_msg}],
            system=prompt,
            model="claude-sonnet-4-5",
            max_tokens=2048,
            temperature=0,
        )

        scores = _parse_json(llm_result["text"])
        judge_tokens = llm_result.get("input_tokens", 0) + llm_result.get("output_tokens", 0)

        result = {
            "id": qid,
            "query": query,
            "category": ref_entry.get("category", ""),
            "is_trap": is_trap,
            "status": "ok",
            **scores,
            "judge_tokens": judge_tokens,
            "judge_seconds": llm_result.get("api_seconds", 0),
            "total_seconds": round(time.time() - t0, 1),
        }

    except Exception as e:
        result = {
            "id": qid, "query": query, "status": "error",
            "error": str(e), "total_seconds": round(time.time() - t0, 1),
        }

    with _lock:
        _done += 1
        _results.append(result)
        gap = result.get("overall_quality_gap", "?")
        status = result["status"]
        print(f"  [{_done}/{_total}] {qid} | {status} | gap={gap} | {result['total_seconds']:.1f}s")
        _save_results()

    return result


def _save_results():
    """현재까지의 결과를 즉시 저장."""
    sorted_results = sorted(_results, key=lambda r: r["id"])
    ts = datetime.now().strftime("%Y%m%d_%H%M%S")
    out_path = RESULTS_DIR / "comparison_latest.json"
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(sorted_results, f, ensure_ascii=False, indent=2)


def main():
    global _total

    parser = argparse.ArgumentParser(description="레퍼런스 vs 시스템 답변 비교 평가")
    parser.add_argument("--sample", type=int, help="샘플 N개만")
    parser.add_argument("--id", type=str, help="특정 질문 ID만")
    parser.add_argument("--system-results", type=str, help="시스템 결과 파일 경로")
    parser.add_argument("--workers", type=int, default=5, help="동시 실행 수 (기본: 5)")
    args = parser.parse_args()

    # 레퍼런스 답변 로드
    if not REFERENCE_PATH.exists():
        print(f"레퍼런스 파일 없음: {REFERENCE_PATH}")
        print("먼저 python -m eval.generate_reference_answers 실행하세요.")
        sys.exit(1)

    with open(REFERENCE_PATH, encoding="utf-8") as f:
        references = {r["id"]: r for r in json.load(f)}

    # 시스템 결과 로드
    sys_path = Path(args.system_results) if args.system_results else SYSTEM_RESULTS_PATH
    if not sys_path.exists():
        print(f"시스템 결과 파일 없음: {sys_path}")
        print("먼저 python -m eval.verify_gt_llm 실행하세요.")
        sys.exit(1)

    with open(sys_path, encoding="utf-8") as f:
        sys_results = {r["id"]: r for r in json.load(f)}

    # 공통 ID 매칭
    common_ids = sorted(set(references.keys()) & set(sys_results.keys()))

    if args.id:
        common_ids = [i for i in common_ids if i == args.id]
    elif args.sample:
        common_ids = common_ids[:args.sample]

    _total = len(common_ids)
    print(f"=== 레퍼런스 vs 시스템 비교 평가 ===")
    print(f"비교 대상: {_total}개, Judge: claude-sonnet-4-5")
    print()

    t_start = time.time()

    with ThreadPoolExecutor(max_workers=args.workers) as executor:
        futures = {
            executor.submit(compare_one, references[qid], sys_results[qid]): qid
            for qid in common_ids
        }
        for future in as_completed(futures):
            future.result()

    _save_results()
    total_time = time.time() - t_start

    # 요약 통계
    ok_results = [r for r in _results if r["status"] == "ok"]
    if ok_results:
        avg_gap = sum(r.get("overall_quality_gap", 0) for r in ok_results) / len(ok_results)
        avg_struct = sum(r.get("structural_quality", 0) for r in ok_results) / len(ok_results)
        avg_complete = sum(r.get("completeness_ratio", 0) for r in ok_results) / len(ok_results)

        # 카테고리별 평균
        from collections import defaultdict
        cat_gaps = defaultdict(list)
        for r in ok_results:
            cat_gaps[r.get("category", "?")].append(r.get("overall_quality_gap", 0))

        print(f"\n{'='*60}")
        print(f"=== 비교 평가 완료 ===")
        print(f"비교: {len(ok_results)}/{_total}, 시간: {total_time:.0f}s")
        print(f"\n--- 종합 ---")
        print(f"  overall_quality_gap:  {avg_gap:.2f} / 5.0  (5=동등)")
        print(f"  structural_quality:   {avg_struct:.2f} / 5.0")
        print(f"  completeness_ratio:   {avg_complete:.2f} / 5.0")
        print(f"\n--- 카테고리별 quality_gap ---")
        for cat in sorted(cat_gaps.keys()):
            vals = cat_gaps[cat]
            print(f"  {cat}: {sum(vals)/len(vals):.2f} ({len(vals)}개)")

        # 빈출 개선 포인트 집계
        all_priorities = []
        for r in ok_results:
            all_priorities.extend(r.get("improvement_priorities", []))

        if all_priorities:
            prompt_issues = [p for p in all_priorities if "[프롬프트]" in p]
            search_issues = [p for p in all_priorities if "[검색]" in p]
            struct_issues = [p for p in all_priorities if "[구조]" in p]
            print(f"\n--- 개선 포인트 분류 ---")
            print(f"  [프롬프트] 문제: {len(prompt_issues)}건")
            print(f"  [검색] 문제:     {len(search_issues)}건")
            print(f"  [구조] 문제:     {len(struct_issues)}건")

        print(f"\n결과: {RESULTS_DIR / 'comparison_latest.json'}")


if __name__ == "__main__":
    main()
