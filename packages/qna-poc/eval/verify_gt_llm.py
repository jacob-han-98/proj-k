"""
LLM-as-Judge QnA 평가기.

== 파이프라인 ==
1. gt_questions_llm.json에서 미리 생성된 질문을 로드
2. 각 질문을 Agent QnA 시스템에 전달 → 시스템이 답변 생성
   (Agent: Planning→검색→답변→Reflection)
3. Stage 1: 규칙 기반 빠른 필터 (검색된 문서가 맞는지)
4. Stage 2: LLM Judge가 "시스템 답변" vs "기대 정답" 비교 평가 (8축+보너스)

== 용어 ==
- 질문 (question): 미리 생성된 GT 질문 (gt_questions_llm.json)
- 시스템 답변 (generated_answer): Agent가 생성한 답변
- 기대 정답 (expected_answer): 질문 생성 시 함께 만든 정답
- Judge 평가: LLM이 시스템 답변과 기대 정답을 비교하여 점수 부여

== 사용법 ==
    python -m eval.verify_gt_llm --stage1-only         # 무료 평가만
    python -m eval.verify_gt_llm --sample 5             # 5개만
    python -m eval.verify_gt_llm                        # 전체 (Stage 1+2)
    python -m eval.verify_gt_llm --role 프로그래머      # 역할별
    python -m eval.verify_gt_llm --difficulty hard      # 난이도별
    python -m eval.verify_gt_llm --no-agent             # Agent 없이 단순 RAG
"""

import argparse
import json
import shutil
import sys
import time
import threading
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime
from pathlib import Path

# Windows cp949 인코딩 문제 방지
sys.stdout.reconfigure(encoding="utf-8", errors="replace")
sys.stderr.reconfigure(encoding="utf-8", errors="replace")

# ── 경로 ──────────────────────────────────────────────────
ROOT = Path(__file__).resolve().parent.parent  # packages/qna-poc
EVAL_DIR = Path(__file__).resolve().parent
QUESTIONS_PATH = EVAL_DIR / "results" / "gt_questions_llm.json"
RESULTS_DIR = EVAL_DIR / "results"
# RESULTS_PATH는 main()에서 타임스탬프 붙여서 설정

sys.path.insert(0, str(ROOT))
from src.retriever import retrieve, warmup as retriever_warmup  # noqa: E402
from src.generator import call_bedrock, SYSTEM_PROMPT as QNA_SYSTEM_PROMPT  # noqa: E402
from src.generator import get_system_logger, get_log_file_path  # noqa: E402
from src.agent import agent_answer  # noqa: E402

log = get_system_logger()


# ══════════════════════════════════════════════════════════
#  Stage 1: 규칙 기반 빠른 필터
# ══════════════════════════════════════════════════════════

def stage1_evaluate(question: dict, chunks: list[dict]) -> dict:
    """규칙 기반 빠른 평가."""
    combined_text = " ".join(c.get("text", "") for c in chunks).lower()
    chunk_workbooks = set()
    for c in chunks:
        wb = c.get("workbook", "")
        if wb:
            chunk_workbooks.add(wb.lower())

    # 워크북 매칭
    expected_wbs = question.get("expected_workbooks", [])
    wb_found = []
    wb_missed = []
    for wb in expected_wbs:
        wb_lower = wb.lower()
        matched = any(
            wb_lower in cwb or cwb in wb_lower
            for cwb in chunk_workbooks
        )
        if not matched:
            # 부분 매칭 시도
            wb_terms = set(wb_lower.replace("pk_", "").replace("/", " ").split())
            for cwb in chunk_workbooks:
                cwb_terms = set(cwb.replace("pk_", "").replace("/", " ").split())
                overlap = len(wb_terms & cwb_terms)
                if overlap >= max(1, len(wb_terms) * 0.5):
                    matched = True
                    break
        if matched:
            wb_found.append(wb)
        else:
            wb_missed.append(wb)

    # key_facts 매칭
    key_facts = question.get("key_facts", [])
    kf_found = []
    kf_missed = []
    for fact in key_facts:
        fact_lower = fact.lower()
        # 전체 매칭
        if fact_lower in combined_text:
            kf_found.append(fact)
            continue
        # 핵심 단어 매칭 (60% 이상)
        words = [w for w in fact_lower.split() if len(w) >= 2]
        if words:
            hit = sum(1 for w in words if w in combined_text)
            if hit / len(words) >= 0.6:
                kf_found.append(fact)
                continue
        kf_missed.append(fact)

    wb_all_found = len(wb_missed) == 0 and len(expected_wbs) > 0
    kf_score = len(kf_found) / len(key_facts) if key_facts else 1.0

    # 할루시네이션 트랩 판정
    if question.get("is_hallucination_trap"):
        # 트랩: 관련 없는 문서가 검색되지 않아야 함 (또는 검색되더라도 정답 포함 안됨)
        trap_passed = kf_score < 0.5  # key_facts가 대부분 없어야 PASS
        return {
            "stage1_verdict": "PASS" if trap_passed else "FAIL",
            "is_trap": True,
            "trap_passed": trap_passed,
            "kf_score": kf_score,
        }

    # 일반 질문 판정
    passed = wb_all_found and kf_score >= 0.5
    return {
        "stage1_verdict": "PASS" if passed else "FAIL",
        "is_trap": False,
        "wb_found": wb_found,
        "wb_missed": wb_missed,
        "wb_all_found": wb_all_found,
        "kf_found": kf_found,
        "kf_missed": kf_missed,
        "kf_score": kf_score,
    }


# ══════════════════════════════════════════════════════════
#  답변 생성 (QnA 시스템 핵심)
# ══════════════════════════════════════════════════════════

def generate_answer(query: str, chunks: list[dict]) -> dict:
    """QnA 시스템으로 실제 답변 생성."""
    if not chunks:
        return {"answer": "(검색 결과 없음 - 답변 생성 불가)", "tokens": 0}

    # 컨텍스트 조합 (상위 5개 청크)
    context_parts = []
    for i, c in enumerate(chunks[:5]):
        wb = c.get("workbook", "?")
        sheet = c.get("sheet", "?")
        text = c.get("text", "")[:3000]
        context_parts.append(f"[출처 {i+1}: {wb}/{sheet}]\n{text}")

    context = "\n\n---\n\n".join(context_parts)

    user_msg = f"""## 컨텍스트 (검색된 기획서)

{context}

---

## 질문
{query}"""

    try:
        result = call_bedrock(
            messages=[{"role": "user", "content": user_msg}],
            system=QNA_SYSTEM_PROMPT,
            model="claude-sonnet-4-5",
            max_tokens=2048,
            temperature=0,
        )
        return {
            "answer": result["text"],
            "tokens": result.get("input_tokens", 0) + result.get("output_tokens", 0),
        }
    except Exception as e:
        return {"answer": f"(답변 생성 실패: {e})", "tokens": 0}


# ══════════════════════════════════════════════════════════
#  Stage 2: LLM Judge 의미론적 평가
# ══════════════════════════════════════════════════════════

JUDGE_SYSTEM_PROMPT = """당신은 10년차 게임 기획 전문가입니다.
모바일 MMORPG "Project K"의 QnA 시스템이 생성한 **실제 답변**을 평가합니다.

질문, 기대 정답, 핵심 사실(key_facts), 그리고 **QnA 시스템이 생성한 답변**이 제공됩니다.
시스템 답변이 기대 정답과 비교하여 적절한지 8축 + 보너스 1축으로 평가하세요.

## 평가 축 (각 1~5점)

1. **intent_alignment** (의도 부합): 시스템 답변이 질문자의 의도를 정확히 파악했는가?
   - 5: 질문 배경/맥락까지 파악한 정확한 답변
   - 3: 표면적 질문에는 답하지만 깊은 의도는 놓침
   - 1: 질문 의도와 무관한 답변

2. **factual_accuracy** (사실 정확성): 시스템 답변의 사실관계가 기대 정답과 일치하는가?
   - 5: key_facts 전부 정확히 포함, 오류 없음
   - 3: 핵심 사실 일부 포함, 오류는 없음
   - 1: 핵심 사실 누락 또는 사실 오류 포함
   - **참고: 용어/표현 차이는 감점하지 마세요.** "Defense"와 "Melee Defense", "공격력"과 "Attack Power" 등은 같은 의미입니다. 정확한 수치와 비율이 일치하면 5점입니다.

3. **completeness** (설명 충분성): 기획 전문가가 납득할 충분한 설명을 했는가?
   - 5: 추가 질문 없이 완전한 답변
   - 3: 답변했으나 보충 설명 필요
   - 1: 핵심이 빠져 답변으로 불충분

4. **no_misinterpretation** (오해 방지): 시스템 답변이 오해를 유발할 여지가 없는가?
   - 5: 명확하고 혼동 없는 답변
   - 3: 일부 애매하나 크게 문제없음
   - 1: 잘못 해석할 가능성 높은 답변

5. **source_fidelity** (원문 충실도): 시스템 답변이 원본 문서 내용을 정확히 반영하는가?
   - 5: 원문 왜곡 없이 반영, 출처 명시
   - 3: 원문 부분 반영
   - 1: 원문과 다르거나 출처 불명

6. **actionability** (실행 가능성): 역할에 맞는 실행(구현/테스트/의사결정)이 가능한가?
   - 5: 답변만으로 바로 구현/테스트/판단 가능
   - 3: 추가 조사 필요하나 방향은 잡힘
   - 1: 실행 불가능, 정보 부족

7. **scope_match** (범위 적절성): 질문 스코프에 맞는 답변 범위인가?
   - 5: 질문에 딱 맞는 범위
   - 3: 약간 넓거나 좁음
   - 1: 질문과 범위 불일치 (과잉/부족)
   - **참고: 질문에 답한 후 추가 관련 정보를 제공하는 것은 감점 사유가 아닙니다.** 핵심 답변이 정확하면 부가 정보가 있어도 4-5점입니다.

8. **freshness** (최신성): 시스템 답변이 최신 버전의 정보를 반영하는가?
   - 5: 최신 기획 반영
   - 3: 대부분 최신이나 일부 구버전
   - 1: 구버전/폐기된 스펙

## 보너스 (0~2점)

9. **implicit_prerequisites** (암묵적 전제 포함):
   - +2: 답변에 필요한 전제 조건/의존성까지 설명
   - +1: 일부 포함
   - +0: 미포함

## 출력 형식

JSON 객체로 출력하세요. 다른 텍스트 없이 JSON만 출력합니다.

```json
{
  "scores": {
    "intent_alignment": 5,
    "factual_accuracy": 4,
    "completeness": 4,
    "no_misinterpretation": 5,
    "source_fidelity": 4,
    "actionability": 3,
    "scope_match": 4,
    "freshness": 5
  },
  "bonus": {"implicit_prerequisites": 1},
  "reasoning": {
    "intent_alignment": "1줄 근거",
    "factual_accuracy": "1줄 근거",
    "completeness": "1줄 근거",
    "no_misinterpretation": "1줄 근거",
    "source_fidelity": "1줄 근거",
    "actionability": "1줄 근거",
    "scope_match": "1줄 근거",
    "freshness": "1줄 근거",
    "implicit_prerequisites": "1줄 근거"
  }
}
```"""

JUDGE_TRAP_SYSTEM_PROMPT = """당신은 10년차 게임 기획 전문가입니다.
이 질문은 **할루시네이션 트랩**입니다. 기획서에 존재하지 않는 기능에 대한 질문입니다.

좋은 QnA 시스템은:
1. "해당 기능은 기획서에 정의되어 있지 않다"고 명확히 거부해야 합니다.
2. 존재하지 않는 기능을 마치 있는 것처럼 답변하면 안 됩니다.

**QnA 시스템이 생성한 실제 답변**을 보고, 할루시네이션을 피했는지 평가하세요.

## 출력 형식

```json
{
  "trap_passed": true,
  "reasoning": "시스템이 해당 기능이 기획서에 없다고 정확히 답변함",
  "risk_level": "low|medium|high"
}
```"""


def parse_judge_json(text: str) -> dict:
    """Judge 응답에서 JSON 추출."""
    text = text.strip()
    if "```json" in text:
        start = text.index("```json") + 7
        end = text.find("```", start)
        text = text[start:end].strip() if end >= 0 else text[start:].strip()
    elif "```" in text:
        start = text.index("```") + 3
        end = text.find("```", start)
        text = text[start:end].strip() if end >= 0 else text[start:].strip()
    # { ... } 추출
    brace_start = text.find("{")
    brace_end = text.rfind("}")
    if brace_start >= 0 and brace_end > brace_start:
        text = text[brace_start:brace_end + 1]
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        return {}


def stage2_evaluate(question: dict, chunks: list[dict], generated_answer: str = "") -> dict:
    """LLM Judge 의미론적 평가. 시스템이 생성한 답변을 평가한다."""
    is_trap = question.get("is_hallucination_trap", False)

    if is_trap:
        user_msg = f"""## 질문 (할루시네이션 트랩)
{question['query']}

## 기대 정답
{question.get('expected_answer', '해당 기능은 기획서에 없다')}

## QnA 시스템의 답변
{generated_answer}

이 트랩 질문에 대해 QnA 시스템이 할루시네이션을 피했는지 평가하세요."""
        system = JUDGE_TRAP_SYSTEM_PROMPT
    else:
        user_msg = f"""## 질문
{question['query']}

## 질문자 역할
{question.get('role', '기획자')}

## 기대 정답
{question.get('expected_answer', '')}

## 핵심 사실 (key_facts)
{json.dumps(question.get('key_facts', []), ensure_ascii=False)}

## QnA 시스템의 답변
{generated_answer}

위 시스템 답변이 기대 정답과 비교하여 적절한지 8축+보너스로 평가하세요."""
        system = JUDGE_SYSTEM_PROMPT

    try:
        result = call_bedrock(
            messages=[{"role": "user", "content": user_msg}],
            system=system,
            model="claude-sonnet-4-5",
            max_tokens=2048,
            temperature=0,
        )
    except Exception as e:
        print(f"  [ERROR] Judge API failed: {e}")
        return {"error": str(e)}

    judge_output = parse_judge_json(result["text"])
    # 파싱 실패 시 1회 재시도 (max_tokens 부족으로 JSON 잘림 방지)
    if not judge_output:
        try:
            result = call_bedrock(
                messages=[{"role": "user", "content": user_msg}],
                system=system + "\n\n중요: 반드시 완전한 JSON만 출력하세요. reasoning은 짧게 작성하세요.",
                model="claude-sonnet-4-5",
                max_tokens=2048,
                temperature=0,
            )
            judge_output = parse_judge_json(result["text"])
        except Exception:
            pass
    if not judge_output:
        return {"error": "Judge JSON parse failed", "raw": result["text"][:200]}

    if is_trap:
        return {
            "stage2_verdict": "PASS" if judge_output.get("trap_passed") else "FAIL",
            "is_trap": True,
            "trap_passed": judge_output.get("trap_passed", False),
            "risk_level": judge_output.get("risk_level", "unknown"),
            "reasoning": judge_output.get("reasoning", ""),
            "judge_tokens": result.get("input_tokens", 0) + result.get("output_tokens", 0),
        }

    # 일반 질문
    scores = judge_output.get("scores", {})
    bonus = judge_output.get("bonus", {})
    reasoning = judge_output.get("reasoning", {})

    base_axes = [
        "intent_alignment", "factual_accuracy", "completeness",
        "no_misinterpretation", "source_fidelity", "actionability",
        "scope_match", "freshness",
    ]

    base_scores = [scores.get(ax, 3) for ax in base_axes]
    avg = sum(base_scores) / len(base_scores) if base_scores else 0
    min_score = min(base_scores) if base_scores else 0
    bonus_score = bonus.get("implicit_prerequisites", 0)

    if avg >= 4.0 and min_score >= 3:
        verdict = "PASS"
    elif avg >= 3.0 and min_score >= 2:
        verdict = "PARTIAL"
    else:
        verdict = "FAIL"

    return {
        "stage2_verdict": verdict,
        "is_trap": False,
        "scores": scores,
        "bonus": bonus,
        "reasoning": reasoning,
        "base_avg": round(avg, 2),
        "base_min": min_score,
        "base_total": sum(base_scores),
        "bonus_total": bonus_score,
        "judge_tokens": result.get("input_tokens", 0) + result.get("output_tokens", 0),
    }


# ══════════════════════════════════════════════════════════
#  메인
# ══════════════════════════════════════════════════════════

def main():
    parser = argparse.ArgumentParser(description="LLM-as-Judge 평가기")
    parser.add_argument("--stage1-only", action="store_true", help="Stage 1만 실행 (무료)")
    parser.add_argument("--sample", type=int, default=0, help="샘플 수 (0=전체)")
    parser.add_argument("--role", type=str, default=None, help="역할 필터")
    parser.add_argument("--difficulty", type=str, default=None, help="난이도 필터")
    parser.add_argument("--category", type=str, default=None, help="카테고리 필터")
    parser.add_argument("--no-agent", action="store_true", help="Agent 없이 단순 RAG 모드")
    parser.add_argument("--filter", type=str, default=None, help="질문 텍스트 필터 (부분 매칭)")
    parser.add_argument("--id", type=str, default=None, help="질문 ID 필터 (콤마 구분)")
    args = parser.parse_args()
    use_agent = not args.no_agent

    # results 디렉토리 생성
    RESULTS_DIR.mkdir(exist_ok=True)

    # 타임스탬프 결과 파일 경로
    ts = datetime.now().strftime("%Y%m%d_%H%M%S")
    results_path = RESULTS_DIR / f"gt_llm_results_{ts}.json"
    latest_path = RESULTS_DIR / "gt_llm_results_latest.json"

    # 질문 로드 (results/ 우선, 없으면 eval/ 폴백)
    questions_path = QUESTIONS_PATH
    if not questions_path.exists():
        fallback = EVAL_DIR / "gt_questions_llm.json"
        if fallback.exists():
            questions_path = fallback
    if not questions_path.exists():
        print(f"[ERROR] {questions_path} not found. Run generate_gt_llm.py first.")
        sys.exit(1)

    with open(questions_path, "r", encoding="utf-8") as f:
        questions = json.load(f)

    print(f"[INFO] Loaded {len(questions)} questions from {questions_path.name}")

    # 필터링
    if args.role:
        questions = [q for q in questions if q.get("role") == args.role]
    if args.difficulty:
        questions = [q for q in questions if q.get("difficulty") == args.difficulty]
    if args.category:
        questions = [q for q in questions if q.get("category") == args.category]
    if args.filter:
        questions = [q for q in questions if args.filter in q.get("query", "") or args.filter in q.get("question", "")]
    if args.id:
        id_set = set(args.id.split(","))
        questions = [q for q in questions if q.get("id") in id_set]
    if args.sample > 0:
        questions = questions[:args.sample]

    total = len(questions)
    normal_count = sum(1 for q in questions if not q.get("is_hallucination_trap"))
    trap_count = sum(1 for q in questions if q.get("is_hallucination_trap"))

    mode_str = "Stage 1 only" if args.stage1_only else "Stage 1 + Stage 2"
    agent_str = "Agent" if use_agent else "Simple RAG"

    log_path = get_log_file_path()
    print(f"\n{'='*60}")
    print(f"  LLM-as-Judge QnA 평가")
    print(f"  질문 {total}개 (일반 {normal_count} + 트랩 {trap_count})")
    print(f"  모드: {mode_str} | 파이프라인: {agent_str}")
    print(f"  로그: {log_path}")
    print(f"{'='*60}")
    print(f"  파이프라인: 질문 -> Agent 답변 생성 -> Judge LLM 평가")
    print(f"{'='*60}\n")

    log.info(f"{'='*70}")
    log.info(f"평가 시작: {total}개 질문, 모드={mode_str}, 파이프라인={agent_str}")
    log.info(f"{'='*70}")

    # ── Warmup: 캐시 미리 초기화 (병렬 실행 전 필수) ──
    retriever_warmup()

    # ── 병렬 실행 설정 ──
    MAX_WORKERS = 10  # 동시 실행 질문 수 (API rate limit 고려)

    # 스레드-세이프 카운터
    lock = threading.Lock()
    stats = {"pass": 0, "partial": 0, "fail": 0, "total": 0, "done": 0,
             "judge_tokens": 0}
    # 결과를 인덱스 순서대로 저장하기 위한 슬롯
    results = [None] * total

    t0 = time.time()

    def evaluate_one(idx: int, q: dict) -> dict:
        """단일 질문 평가 (병렬 실행 단위)."""
        q_t0 = time.time()

        entry = {
            "id": q["id"],
            "query": q["query"],
            "category": q.get("category"),
            "role": q.get("role"),
            "difficulty": q.get("difficulty"),
            "is_trap": q.get("is_hallucination_trap", False),
            "expected_answer": q.get("expected_answer", ""),
            "expected_workbooks": q.get("expected_workbooks", []),
            "key_facts": q.get("key_facts", []),
            "rationale": q.get("rationale", ""),
            "ground_truth_source": q.get("ground_truth_source", ""),
        }

        if use_agent and not args.stage1_only:
            try:
                agent_result = agent_answer(q["query"], role=q.get("role"))
                chunks = agent_result["chunks"]
                entry["generated_answer"] = agent_result["answer"]
                entry["answer_tokens"] = agent_result["total_tokens"]
                entry["agent_trace"] = agent_result["trace"]
                entry["agent_confidence"] = agent_result.get("confidence", "?")
                entry["chunks_found"] = len(chunks)
            except Exception as e:
                chunks = []
                entry["generated_answer"] = f"(Agent 실패: {e})"
                entry["answer_tokens"] = 0
                entry["agent_trace"] = [{"step": "error", "message": str(e)}]
                entry["chunks_found"] = 0
        else:
            try:
                chunks, retrieval_info = retrieve(q["query"], top_k=20)
            except Exception as e:
                chunks, retrieval_info = [], {}
            entry["chunks_found"] = len(chunks)

        # Stage 1
        s1 = stage1_evaluate(q, chunks)
        entry.update(s1)

        # Stage 2
        if not args.stage1_only:
            if not use_agent:
                gen_result = generate_answer(q["query"], chunks)
                entry["generated_answer"] = gen_result["answer"]
                entry["answer_tokens"] = gen_result["tokens"]

            judge_t0 = time.time()
            s2 = stage2_evaluate(q, chunks, generated_answer=entry.get("generated_answer", ""))
            judge_time = time.time() - judge_t0
            entry.update(s2)
            entry["judge_seconds"] = round(judge_time, 1)

        entry["total_seconds"] = round(time.time() - q_t0, 1)

        # ── 스레드-세이프 결과 업데이트 ──
        with lock:
            results[idx] = entry
            stats["done"] += 1
            done = stats["done"]
            q_tokens = entry.get("judge_tokens", 0) + entry.get("answer_tokens", 0)
            stats["judge_tokens"] += q_tokens

            verdict = entry.get("stage2_verdict", entry.get("stage1_verdict", "?"))
            if not entry.get("is_trap") and "stage2_verdict" in entry:
                stats["total"] += 1
                if verdict == "PASS":
                    stats["pass"] += 1
                elif verdict == "PARTIAL":
                    stats["partial"] += 1
                else:
                    stats["fail"] += 1

            # 실시간 출력
            elapsed = time.time() - t0
            pct = f"{100*stats['pass']/max(stats['total'],1):.0f}%"
            verdict_mark = {"PASS": "O", "PARTIAL": "~", "FAIL": "X"}.get(verdict, "?")
            avg = entry.get("base_avg", 0)

            if entry.get("is_trap"):
                print(f"  [{done}/{total}] {q['id']} TRAP [{verdict_mark}] {verdict} | "
                      f"{elapsed:.0f}s | PASS={stats['pass']}/{stats['total']} ({pct})")
            else:
                answer_preview = entry.get('generated_answer', '')[:60].replace(chr(10), ' ')
                print(f"  [{done}/{total}] {q['id']} [{verdict_mark}] {verdict} avg={avg} | "
                      f"{elapsed:.0f}s | PASS={stats['pass']}/{stats['total']} ({pct})"
                      f" | {answer_preview}")

            log.info(f"[{done}/{total}] {q['id']}: {verdict} avg={avg} "
                     f"PASS={stats['pass']}/{stats['total']} ({pct}) "
                     f"time={entry.get('total_seconds',0):.1f}s")

            # 중간 저장 (완료된 결과만)
            completed = [r for r in results if r is not None]
            with open(results_path, "w", encoding="utf-8") as f:
                json.dump(completed, f, ensure_ascii=False, indent=2)
            shutil.copy2(results_path, latest_path)

        return entry

    # ── 병렬 실행 ──
    print(f"  [병렬 실행] max_workers={MAX_WORKERS}")
    with ThreadPoolExecutor(max_workers=MAX_WORKERS) as executor:
        futures = {}
        for idx, q in enumerate(questions):
            future = executor.submit(evaluate_one, idx, q)
            futures[future] = idx

        for future in as_completed(futures):
            try:
                future.result()  # 예외 전파
            except Exception as e:
                idx = futures[future]
                print(f"  [ERROR] Question {idx} failed: {e}")

    # results에 None이 남아있으면 제거
    results = [r for r in results if r is not None]

    total_time = time.time() - t0

    # ── 통계 출력 ──
    print(f"\n{'='*60}")
    print(f"  평가 결과 요약")
    print(f"{'='*60}")

    # Stage 1
    s1_normal = [r for r in results if not r.get("is_trap")]
    s1_traps = [r for r in results if r.get("is_trap")]
    s1_pass = sum(1 for r in s1_normal if r.get("stage1_verdict") == "PASS")
    s1_trap_pass = sum(1 for r in s1_traps if r.get("stage1_verdict") == "PASS" or r.get("trap_passed"))

    print(f"\n  Stage 1 (규칙 기반):")
    print(f"    일반: {s1_pass}/{len(s1_normal)} ({100*s1_pass/max(len(s1_normal),1):.1f}%)")
    print(f"    트랩: {s1_trap_pass}/{len(s1_traps)} ({100*s1_trap_pass/max(len(s1_traps),1):.1f}%)")

    # Stage 2
    if not args.stage1_only:
        s2_normal = [r for r in s1_normal if "stage2_verdict" in r]
        s2_traps_eval = [r for r in s1_traps if "stage2_verdict" in r]

        s2_pass = sum(1 for r in s2_normal if r.get("stage2_verdict") == "PASS")
        s2_partial = sum(1 for r in s2_normal if r.get("stage2_verdict") == "PARTIAL")
        s2_fail = sum(1 for r in s2_normal if r.get("stage2_verdict") == "FAIL")
        s2_trap_pass = sum(1 for r in s2_traps_eval if r.get("stage2_verdict") == "PASS")

        print(f"\n  Stage 2 (LLM Judge):")
        print(f"    PASS: {s2_pass}/{len(s2_normal)} ({100*s2_pass/max(len(s2_normal),1):.1f}%)")
        print(f"    PARTIAL: {s2_partial}/{len(s2_normal)}")
        print(f"    FAIL: {s2_fail}/{len(s2_normal)}")
        print(f"    트랩: {s2_trap_pass}/{len(s2_traps_eval)}")

        # 축별 평균
        if s2_normal:
            axes = ["intent_alignment", "factual_accuracy", "completeness",
                     "no_misinterpretation", "source_fidelity", "actionability",
                     "scope_match", "freshness"]
            print(f"\n  축별 평균 점수:")
            for ax in axes:
                vals = [r["scores"].get(ax, 0) for r in s2_normal if "scores" in r]
                if vals:
                    print(f"    {ax:25s}: {sum(vals)/len(vals):.2f}")

        # 카테고리별
        cats = set(r.get("category") for r in results)
        print(f"\n  카테고리별 (Stage 2):")
        for cat in sorted(cats):
            cat_results = [r for r in results if r.get("category") == cat and "stage2_verdict" in r]
            cat_pass = sum(1 for r in cat_results if r.get("stage2_verdict") == "PASS")
            print(f"    {cat}: {cat_pass}/{len(cat_results)}")

        # 비용 추정
        est_cost = stats["judge_tokens"] * 0.000003  # ~$3/M input tokens (Sonnet)
        print(f"\n  Judge 토큰: {stats['judge_tokens']:,}")
        print(f"  추정 비용: ~${est_cost:.4f}")

    # 실패 샘플
    failed = [r for r in results
              if not r.get("is_trap")
              and (r.get("stage2_verdict", r.get("stage1_verdict")) == "FAIL")]
    if failed:
        print(f"\n  실패 샘플 (상위 5개):")
        for r in failed[:5]:
            print(f"    [{r['id']}] {r['query'][:60]}...")
            if "kf_missed" in r:
                print(f"      key_facts 누락: {r['kf_missed'][:3]}")
            if "scores" in r:
                low = {k: v for k, v in r["scores"].items() if v <= 2}
                if low:
                    print(f"      낮은 축: {low}")

    print(f"\n  총 소요 시간: {total_time:.0f}s ({total_time/60:.1f}min)")
    print(f"  결과 저장: {results_path.name}")
    print(f"  최신 복사: {latest_path.name}")
    print(f"  시스템 로그: {log_path}")
    log.info(f"{'='*70}")
    log.info(f"평가 완료: {total_time:.0f}s ({total_time/60:.1f}min)")
    log.info(f"  PASS={stats['pass']}/{stats['total']} ({100*stats['pass']/max(stats['total'],1):.0f}%) "
             f"PARTIAL={stats['partial']} FAIL={stats['fail']}")
    log.info(f"  결과={results_path.name}")
    log.info(f"{'='*70}")


if __name__ == "__main__":
    main()
