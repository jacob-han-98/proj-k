"""
evaluate.py — QnA PoC 자동 평가

Usage:
    python -m eval.evaluate                    # 전체 48개 질문 평가
    python -m eval.evaluate --category A       # 카테고리별 평가
    python -m eval.evaluate --id A-기획-01     # 단일 질문 평가
    python -m eval.evaluate --dry-run          # 질문만 출력 (API 호출 안 함)
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

from src.retriever import retrieve, format_context
from src.generator import generate_answer


QUESTIONS_PATH = Path(__file__).resolve().parent / "questions.json"


def load_questions(category: str = None, question_id: str = None) -> list[dict]:
    """평가 질문 로드."""
    data = json.loads(QUESTIONS_PATH.read_text(encoding="utf-8"))
    questions = data["questions"]

    if question_id:
        questions = [q for q in questions if q["id"] == question_id]
    elif category:
        questions = [q for q in questions if q["category"] == category]

    return questions


def evaluate_single(question: dict, verbose: bool = True) -> dict:
    """단일 질문 평가."""
    q_text = question["question"]
    expected_keywords = question.get("expected_keywords", [])
    expected_source = question.get("expected_source", {})

    if verbose:
        print(f"\n{'='*60}")
        print(f"[{question['id']}] ({question['category']}/{question['role']})")
        print(f"Q: {q_text}")

    # 검색
    t_start = time.time()
    chunks = retrieve(q_text, top_k=12)
    t_retrieve = time.time() - t_start

    if not chunks:
        return {
            "id": question["id"],
            "success": False,
            "reason": "no_chunks_found",
            "time": 0,
        }

    context = format_context(chunks)

    # 답변 생성
    try:
        result = generate_answer(
            question=q_text,
            context=context,
            role=question.get("role"),
        )
    except Exception as e:
        return {
            "id": question["id"],
            "success": False,
            "reason": f"api_error: {str(e)[:100]}",
            "time": time.time() - t_start,
        }

    t_total = time.time() - t_start
    answer = result["answer"]

    # 키워드 매칭 평가
    keyword_hits = 0
    keyword_misses = []
    for kw in expected_keywords:
        if kw.lower() in answer.lower():
            keyword_hits += 1
        else:
            keyword_misses.append(kw)

    keyword_score = keyword_hits / max(len(expected_keywords), 1)

    # 출처 매칭 평가 (워크북 수준 — 시트는 보조 지표)
    source_match = True
    source_wb_match = True
    if expected_source:
        answer_lower = answer.lower()
        # 워크북 매칭 (필수)
        wb_val = expected_source.get("workbook", "")
        if wb_val and wb_val.lower() not in answer_lower:
            source_wb_match = False
        # 전체 매칭 (시트 포함 — 참고용)
        for key, val in expected_source.items():
            if val and val.lower() not in answer_lower:
                source_match = False
                break

    # 종합 판정:
    # - 키워드 80%+: PASS (강한 내용 매칭 시 출처 무관)
    # - 키워드 50~79%: 워크북 출처도 매칭되어야 PASS
    if keyword_score >= 0.8:
        success = True
    elif keyword_score >= 0.5:
        success = source_wb_match or not expected_source
    else:
        success = False

    if verbose:
        print(f"A: {answer[:200]}...")
        print(f"   Keywords: {keyword_hits}/{len(expected_keywords)} ({keyword_score:.0%})")
        if keyword_misses:
            print(f"   Missing: {keyword_misses}")
        print(f"   Source match: wb={source_wb_match}, full={source_match}")
        print(f"   Confidence: {result['confidence']}")
        print(f"   Time: {t_total:.1f}s (retrieve: {t_retrieve:.1f}s)")
        print(f"   Tokens: {result['tokens_used']['input']:,} in / {result['tokens_used']['output']:,} out")
        print(f"   Result: {'PASS' if success else 'FAIL'}")

    return {
        "id": question["id"],
        "category": question["category"],
        "role": question["role"],
        "question": q_text,
        "answer_preview": answer[:300],
        "success": success,
        "keyword_score": keyword_score,
        "keyword_misses": keyword_misses,
        "source_match": source_match,
        "source_wb_match": source_wb_match,
        "confidence": result["confidence"],
        "time": round(t_total, 1),
        "tokens_in": result["tokens_used"]["input"],
        "tokens_out": result["tokens_used"]["output"],
    }


def run_evaluation(questions: list[dict], verbose: bool = True) -> dict:
    """전체 평가 실행."""
    results = []
    total_time = 0
    total_tokens_in = 0
    total_tokens_out = 0

    for i, q in enumerate(questions, 1):
        print(f"\n[{i}/{len(questions)}] Evaluating {q['id']}...")
        result = evaluate_single(q, verbose=verbose)
        results.append(result)

        total_time += result.get("time", 0)
        total_tokens_in += result.get("tokens_in", 0)
        total_tokens_out += result.get("tokens_out", 0)

    # 요약
    passed = sum(1 for r in results if r["success"])
    total = len(results)

    print(f"\n{'='*60}")
    print(f"EVALUATION SUMMARY")
    print(f"{'='*60}")
    print(f"  Total: {passed}/{total} PASS ({passed/max(total,1):.0%})")

    # 카테고리별
    categories = sorted(set(r["category"] for r in results))
    for cat in categories:
        cat_results = [r for r in results if r["category"] == cat]
        cat_passed = sum(1 for r in cat_results if r["success"])
        print(f"  Category {cat}: {cat_passed}/{len(cat_results)} ({cat_passed/max(len(cat_results),1):.0%})")

    # 역할별
    roles = sorted(set(r["role"] for r in results))
    for role in roles:
        role_results = [r for r in results if r["role"] == role]
        role_passed = sum(1 for r in role_results if r["success"])
        print(f"  Role {role}: {role_passed}/{len(role_results)} ({role_passed/max(len(role_results),1):.0%})")

    print(f"\n  Total time: {total_time:.0f}s ({total_time/max(total,1):.1f}s avg)")
    print(f"  Total tokens: {total_tokens_in:,} in / {total_tokens_out:,} out")

    # 실패 목록
    failed = [r for r in results if not r["success"]]
    if failed:
        print(f"\n  FAILED ({len(failed)}):")
        for r in failed:
            print(f"    - {r['id']}: keyword={r.get('keyword_score', 0):.0%}, src={r.get('source_match', False)}")
            if r.get("keyword_misses"):
                print(f"      Missing keywords: {r['keyword_misses']}")

    return {
        "total": total,
        "passed": passed,
        "accuracy": passed / max(total, 1),
        "results": results,
        "total_time": total_time,
        "total_tokens_in": total_tokens_in,
        "total_tokens_out": total_tokens_out,
    }


def main():
    import argparse

    parser = argparse.ArgumentParser(description="QnA PoC Evaluation")
    parser.add_argument("--category", help="카테고리 필터 (A-F)")
    parser.add_argument("--id", help="특정 질문 ID")
    parser.add_argument("--dry-run", action="store_true", help="질문만 출력")
    parser.add_argument("--output", help="결과 JSON 저장 경로")
    args = parser.parse_args()

    questions = load_questions(category=args.category, question_id=args.id)
    print(f"[INFO] Loaded {len(questions)} questions.")

    if args.dry_run:
        for q in questions:
            print(f"  [{q['id']}] ({q['category']}/{q['role']}) {q['question']}")
        return

    summary = run_evaluation(questions)

    if args.output:
        Path(args.output).write_text(json.dumps(summary, ensure_ascii=False, indent=2), encoding="utf-8")
        print(f"\n[INFO] Results saved to {args.output}")


if __name__ == "__main__":
    main()
