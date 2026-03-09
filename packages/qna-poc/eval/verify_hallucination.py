"""
verify_hallucination.py — Generator 레벨 할루시네이션 트랩 검증

gt_questions.json의 할루시네이션 트랩 질문(H카테고리)을
Retriever + Generator 전체 파이프라인으로 실행하여:
1. Generator가 "찾을 수 없습니다" 등으로 올바르게 거부하는지
2. 존재하지 않는 정보를 생성(할루시네이션)하지 않는지
를 검증한다.

Usage:
    python -m eval.verify_hallucination
    python -m eval.verify_hallucination --sample 10
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

from src.retriever import retrieve, format_context
from src.generator import generate_answer

GT_PATH = Path(__file__).resolve().parent / "gt_questions.json"
OUTPUT_PATH = Path(__file__).resolve().parent / "hallucination_results.json"

# 할루시네이션 거부 키워드
REJECTION_KEYWORDS = [
    "찾을 수 없", "없습니다", "정보가 없", "존재하지 않",
    "기획서에 없", "해당 정보", "확인할 수 없", "관련 정보를 찾",
    "언급되어 있지 않", "포함되어 있지 않", "다루고 있지 않",
]


def check_rejection(answer: str) -> dict:
    """답변이 올바르게 정보 부재를 표시하는지 확인."""
    answer_lower = answer.lower()

    # 거부 키워드 확인
    found_keywords = [kw for kw in REJECTION_KEYWORDS if kw in answer_lower]

    # 거부 답변인지 판정
    is_rejection = len(found_keywords) > 0

    # 거부하면서도 구체적 정보를 지어내는 경우 체크
    # (예: "해당 정보를 찾을 수 없습니다" 라면서 뒤에 구체적 수치를 나열하는 경우)
    has_specific_claims = False
    if is_rejection:
        # 거부 문장 이후에 구체적 테이블/수치가 나오면 의심
        lines = answer.split("\n")
        rejection_line_idx = -1
        for i, line in enumerate(lines):
            if any(kw in line.lower() for kw in REJECTION_KEYWORDS):
                rejection_line_idx = i
                break
        # 거부 이후 줄에 테이블(|)이나 수식이 있으면 의심
        if rejection_line_idx >= 0:
            after = "\n".join(lines[rejection_line_idx + 1:])
            if "|" in after and after.count("|") > 4:
                has_specific_claims = True

    return {
        "is_rejection": is_rejection,
        "rejection_keywords": found_keywords,
        "has_specific_claims": has_specific_claims,
        "passed": is_rejection and not has_specific_claims,
    }


def run_verification(sample_size: int = None):
    """할루시네이션 트랩 검증 실행."""
    data = json.loads(GT_PATH.read_text(encoding="utf-8"))
    trap_qs = [q for q in data["questions"] if q.get("is_hallucination_trap")]

    if sample_size and sample_size < len(trap_qs):
        import random
        random.seed(42)
        trap_qs = random.sample(trap_qs, sample_size)

    total = len(trap_qs)
    print(f"{'=' * 70}")
    print(f"  Generator 할루시네이션 트랩 검증 — {total}개 질문")
    print(f"{'=' * 70}")

    results = []
    passed = 0
    total_time = 0
    total_input_tokens = 0
    total_output_tokens = 0

    for i, q in enumerate(trap_qs):
        qid = q.get("id", f"H-{i}")

        # 진행 상황
        if (i + 1) % 5 == 0 or i == 0:
            elapsed = total_time
            rate = (i) / elapsed if elapsed > 0 else 0
            eta = (total - i) / rate if rate > 0 else 0
            print(f"  [{i+1}/{total}] {elapsed:.0f}s elapsed, ~{eta:.0f}s remaining")

        # 1. 검색
        t0 = time.time()
        try:
            chunks, retrieval_info = retrieve(q["query"], top_k=12)
        except Exception as e:
            print(f"  [ERROR] {qid} retrieve: {e}")
            chunks, retrieval_info = [], {}

        # 2. 답변 생성
        if chunks:
            context = format_context(chunks)
            try:
                gen_result = generate_answer(
                    question=q["query"],
                    context=context,
                )
                answer = gen_result["answer"]
                input_tokens = gen_result["tokens_used"]["input"]
                output_tokens = gen_result["tokens_used"]["output"]
            except Exception as e:
                print(f"  [ERROR] {qid} generate: {e}")
                answer = f"[ERROR: {e}]"
                input_tokens = output_tokens = 0
        else:
            answer = "검색 결과 없음 — 관련 기획서를 찾을 수 없습니다."
            input_tokens = output_tokens = 0

        t_total = time.time() - t0
        total_time += t_total
        total_input_tokens += input_tokens
        total_output_tokens += output_tokens

        # 3. 판정
        check = check_rejection(answer)

        result_entry = {
            "id": qid,
            "query": q["query"],
            "ground_truth": q.get("ground_truth_text", ""),
            "answer_preview": answer[:300],
            "is_rejection": check["is_rejection"],
            "rejection_keywords": check["rejection_keywords"],
            "has_specific_claims": check["has_specific_claims"],
            "passed": check["passed"],
            "chunks_found": len(chunks),
            "detected_systems": retrieval_info.get("detected_systems", []),
            "layers_used": retrieval_info.get("layers_used", []),
            "time": round(t_total, 1),
            "tokens": {"input": input_tokens, "output": output_tokens},
        }
        results.append(result_entry)

        if check["passed"]:
            passed += 1
            status = "PASS"
        else:
            status = "FAIL"
            print(f"  [{qid}] FAIL: {q['query'][:50]}...")
            print(f"    답변: {answer[:100]}...")

    # 요약
    acc = passed / max(total, 1)
    avg_time = total_time / max(total, 1)

    print(f"\n{'=' * 70}")
    print(f"  할루시네이션 트랩 검증 결과")
    print(f"{'=' * 70}")
    print(f"  통과: {passed}/{total} ({acc:.1%})")
    print(f"  평균 응답 시간: {avg_time:.1f}s")
    print(f"  총 소요 시간: {total_time:.1f}s")
    print(f"  총 토큰: {total_input_tokens:,} in / {total_output_tokens:,} out")
    print(f"  예상 비용: ~${total_input_tokens * 3 / 1_000_000 + total_output_tokens * 15 / 1_000_000:.3f}")

    # 실패 사례 상세
    failed = [r for r in results if not r["passed"]]
    if failed:
        print(f"\n  실패 사례 ({len(failed)}개):")
        for r in failed:
            print(f"    [{r['id']}] {r['query'][:60]}")
            print(f"      답변: {r['answer_preview'][:150]}...")
    else:
        print(f"\n  모든 할루시네이션 트랩 통과!")

    # 저장
    output = {
        "summary": {
            "total": total,
            "passed": passed,
            "accuracy": round(acc, 4),
            "avg_time": round(avg_time, 1),
            "total_time": round(total_time, 1),
            "total_tokens": {
                "input": total_input_tokens,
                "output": total_output_tokens,
            },
        },
        "methodology": "gt_questions.json의 할루시네이션 트랩 질문을 "
                       "Retriever+Generator 전체 파이프라인으로 실행하여 "
                       "Generator가 올바르게 '정보 없음'으로 응답하는지 검증.",
        "results": results,
    }
    OUTPUT_PATH.write_text(
        json.dumps(output, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    print(f"\n  결과 저장: {OUTPUT_PATH}")

    return output


if __name__ == "__main__":
    sample = None
    for arg in sys.argv[1:]:
        if arg.startswith("--sample"):
            idx = sys.argv.index(arg)
            if idx + 1 < len(sys.argv):
                sample = int(sys.argv[idx + 1])

    run_verification(sample_size=sample)
