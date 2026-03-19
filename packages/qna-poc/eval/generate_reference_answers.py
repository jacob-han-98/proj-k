"""
Claude 웹앱 시뮬레이션 — 레퍼런스 답변 생성기.

우리 시스템과 동일한 검색 결과(시트 원본)를 Opus에 최소 프롬프트로 전달하여
"Claude 웹앱에 파일을 올리고 질문한 것"과 동등한 레퍼런스 답변을 생성한다.

이 레퍼런스 답변은 우리 시스템의 목표 품질 기준이 된다.

== 사용법 ==
    python -m eval.generate_reference_answers                    # 전체 69개
    python -m eval.generate_reference_answers --sample 3         # 3개만 테스트
    python -m eval.generate_reference_answers --id GT-LLM-A-001  # 특정 1개
    python -m eval.generate_reference_answers --model claude-sonnet-4-5  # 모델 변경
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

ROOT = Path(__file__).resolve().parent.parent  # packages/qna-poc
EVAL_DIR = Path(__file__).resolve().parent
QUESTIONS_PATH = EVAL_DIR / "results" / "gt_questions_llm.json"
RESULTS_DIR = EVAL_DIR / "results"

sys.path.insert(0, str(ROOT))
from src.agent import plan_search, execute_search, _load_full_sheets  # noqa: E402
from src.generator import call_bedrock  # noqa: E402

# ── 레퍼런스 프롬프트 (Claude 웹앱 시뮬레이션) ──
# 방어 규칙 없이 Claude의 자연스러운 능력을 최대한 활용
REFERENCE_SYSTEM_PROMPT = """당신은 모바일 MMORPG "Project K"의 기획 전문가입니다.
아래 기획 문서를 읽고 질문에 체계적으로 답변하세요.

## 답변 원칙
- 관련 정보를 **빠짐없이** 포함
- 구조화된 Markdown 형식 (헤더, 테이블, 리스트 적극 활용)
- 출처(워크북/시트)를 답변 내에 명시
- 시스템 개요 → 핵심 메커니즘 → 세부 규칙 → 관련 시스템 순으로 서술
- 수치, 조건, 규칙 등 구체적 데이터는 반드시 포함
- 기획서에 없는 내용은 만들어내지 마세요
- 기획서에 정의되지 않은 기능에 대한 질문이면 명확히 "기획서에 정의되어 있지 않다"고 답하세요"""

# 트랩 질문용 프롬프트
REFERENCE_TRAP_PROMPT = """당신은 모바일 MMORPG "Project K"의 기획 전문가입니다.
아래 기획 문서를 읽고 질문에 답변하세요.

## 핵심 원칙
- 기획 문서에 **실제로 존재하는 정보만** 답변하세요
- 질문에서 언급한 시스템/기능이 기획서에 없으면 "해당 기능은 기획서에 정의되어 있지 않습니다"라고 명확히 답하세요
- 추측이나 유사 시스템으로 대체 답변하지 마세요"""


# ── 스레드 세이프 카운터 ──
_lock = threading.Lock()
_done = 0
_total = 0
_results = []


def _build_context_from_chunks(chunks: list[dict]) -> str:
    """시트 전체 로드된 청크를 문서 형태로 조합."""
    sheet_groups = {}
    for c in chunks:
        key = (c.get("workbook", ""), c.get("sheet", ""))
        sheet_groups.setdefault(key, []).append(c)

    parts = []
    for (wb, sheet), s_chunks in sheet_groups.items():
        text_parts = []
        for c in s_chunks:
            sec = c.get("section_path", "")
            text = c.get("text", "")
            if sec:
                text_parts.append(f"### {sec}\n{text}")
            else:
                text_parts.append(text)
        sheet_content = "\n\n".join(text_parts)
        parts.append(f"## [{wb} / {sheet}]\n\n{sheet_content}")

    return "\n\n---\n\n".join(parts)


def generate_one(question: dict, model: str) -> dict:
    """1개 질문에 대한 레퍼런스 답변 생성."""
    global _done
    t0 = time.time()
    qid = question["id"]
    query = question["query"]
    is_trap = question.get("is_hallucination_trap", False)

    try:
        # 1) Planning + Search (우리 시스템과 동일)
        plan = plan_search(query)
        chunks = execute_search(plan, query)

        # 2) 시트 전체 로드 (Opus 200K 한계 고려: 시스템프롬프트+출력 제외 ~170K)
        full_chunks = _load_full_sheets(chunks, max_context_tokens=150000)
        context = _build_context_from_chunks(full_chunks)
        context_tokens = int(len(context) * 0.5)

        # 3) 레퍼런스 답변 생성 (최소 프롬프트 + 강력한 모델)
        system_prompt = REFERENCE_TRAP_PROMPT if is_trap else REFERENCE_SYSTEM_PROMPT
        user_msg = f"## 기획 문서\n\n{context}\n\n---\n\n## 질문\n{query}"

        result = call_bedrock(
            messages=[{"role": "user", "content": user_msg}],
            system=system_prompt,
            model=model,
            max_tokens=8192,
            temperature=0,
        )

        answer = result["text"]
        total_tokens = result.get("input_tokens", 0) + result.get("output_tokens", 0)
        api_seconds = result.get("api_seconds", 0)

        entry = {
            "id": qid,
            "query": query,
            "category": question.get("category", ""),
            "is_trap": is_trap,
            "reference_answer": answer,
            "model": model,
            "context_sheets": len(set(
                (c.get("workbook", ""), c.get("sheet", ""))
                for c in full_chunks
            )),
            "context_chunks": len(full_chunks),
            "context_tokens": context_tokens,
            "answer_tokens": total_tokens,
            "api_seconds": api_seconds,
            "total_seconds": round(time.time() - t0, 1),
            "key_systems": plan.get("key_systems", []),
            "status": "ok",
        }

    except Exception as e:
        entry = {
            "id": qid,
            "query": query,
            "category": question.get("category", ""),
            "is_trap": is_trap,
            "reference_answer": f"(생성 실패: {e})",
            "model": model,
            "status": "error",
            "error": str(e),
            "total_seconds": round(time.time() - t0, 1),
        }

    with _lock:
        _done += 1
        _results.append(entry)
        status = entry["status"]
        tokens = entry.get("answer_tokens", 0)
        secs = entry["total_seconds"]
        print(f"  [{_done}/{_total}] {qid} | {status} | {tokens:,} tok | {secs:.1f}s")

        # 매 항목 즉시 저장
        _save_results()

    return entry


def _save_results():
    """현재까지의 결과를 즉시 저장."""
    sorted_results = sorted(_results, key=lambda r: r["id"])
    out_path = RESULTS_DIR / "reference_answers.json"
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(sorted_results, f, ensure_ascii=False, indent=2)


def main():
    global _total

    parser = argparse.ArgumentParser(description="레퍼런스 답변 생성 (Claude 웹앱 시뮬레이션)")
    parser.add_argument("--sample", type=int, help="샘플 N개만 실행")
    parser.add_argument("--id", type=str, help="특정 질문 ID만 실행")
    parser.add_argument("--model", type=str, default="claude-opus-4-5",
                        help="사용 모델 (기본: claude-opus-4-5)")
    parser.add_argument("--workers", type=int, default=3,
                        help="동시 실행 수 (기본: 3, Opus는 rate limit 주의)")
    parser.add_argument("--resume", action="store_true",
                        help="기존 결과에서 이어서 실행 (ok 상태인 항목 스킵)")
    args = parser.parse_args()

    # 질문 로드
    with open(QUESTIONS_PATH, encoding="utf-8") as f:
        questions = json.load(f)

    # --resume: 기존 결과 로드 + ok 항목 스킵
    existing_ok_ids = set()
    if args.resume and RESULTS_DIR.joinpath("reference_answers.json").exists():
        with open(RESULTS_DIR / "reference_answers.json", encoding="utf-8") as f:
            existing = json.load(f)
        for r in existing:
            if r.get("status") == "ok":
                existing_ok_ids.add(r["id"])
                _results.append(r)  # 기존 ok 결과 보존
        print(f"기존 결과 로드: {len(existing_ok_ids)}개 ok (스킵)")

    if args.id:
        questions = [q for q in questions if q["id"] == args.id]
        if not questions:
            print(f"질문 ID '{args.id}'를 찾을 수 없습니다.")
            sys.exit(1)
    elif args.sample:
        questions = questions[:args.sample]

    # resume 시 이미 ok인 질문 제외
    if existing_ok_ids:
        questions = [q for q in questions if q["id"] not in existing_ok_ids]

    _total = len(questions)
    print(f"=== 레퍼런스 답변 생성 ===")
    print(f"질문: {_total}개, 모델: {args.model}, 동시 실행: {args.workers}")
    print(f"출력: {RESULTS_DIR / 'reference_answers.json'}")
    print()

    t_start = time.time()

    # 병렬 실행
    with ThreadPoolExecutor(max_workers=args.workers) as executor:
        futures = {
            executor.submit(generate_one, q, args.model): q
            for q in questions
        }
        for future in as_completed(futures):
            future.result()  # 예외 전파

    # 최종 저장
    _save_results()
    total_time = time.time() - t_start

    # 요약
    ok = sum(1 for r in _results if r["status"] == "ok")
    err = sum(1 for r in _results if r["status"] == "error")
    total_tokens = sum(r.get("answer_tokens", 0) for r in _results)
    print(f"\n=== 완료 ===")
    print(f"성공: {ok}/{_total}, 실패: {err}")
    print(f"총 토큰: {total_tokens:,}, 총 시간: {total_time:.0f}s")
    print(f"결과: {RESULTS_DIR / 'reference_answers.json'}")


if __name__ == "__main__":
    main()
