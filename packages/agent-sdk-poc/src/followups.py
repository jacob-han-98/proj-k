"""후속 질문(follow-up) 생성 — Haiku 로 3~5개 제안."""
from __future__ import annotations

import json
import sys
from pathlib import Path

# scripts/bedrock_client.py 재사용
sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scripts"))
from bedrock_client import call as bedrock_call, BedrockError  # type: ignore  # noqa: E402


_SYS_PROMPT = """당신은 Project K(모바일 MMORPG) 기획자 보조를 돕는 에이전트입니다.
방금 제공된 질문과 답변을 바탕으로, 사용자가 답변을 읽은 뒤 자연스럽게 이어서 궁금해할 만한 **후속 질문 3~5개**를 제안합니다.

규칙:
1. 답변 내용과 직접 연결되는 맥락적 질문이어야 합니다(단순 재질문/요약 금지).
2. 한국어 · 한 문장 · 15~40자 · 물음표로 끝냅니다.
3. 답변에서 열려있는 부분(언급만 되고 구체 설명 없는 주제, 반대 케이스, 연관 시스템, 수치/밸런스 근거)을 파고드세요.
4. 이미 답변이 충분히 설명한 내용을 다시 묻지 마세요.
5. JSON 배열만 반환하세요: ["질문1", "질문2", "질문3"]. 다른 텍스트·설명·코드블록 금지.
"""


def _parse_json_array(raw: str) -> list[str]:
    if not raw:
        return []
    t = raw.strip()
    # 코드블록 제거
    if t.startswith("```"):
        t = t.strip("`")
        if t.startswith("json"):
            t = t[4:]
    # 첫 [ 부터 마지막 ] 까지
    l = t.find("[")
    r = t.rfind("]")
    if l < 0 or r < 0 or r <= l:
        return []
    try:
        arr = json.loads(t[l : r + 1])
    except Exception:
        return []
    out: list[str] = []
    for x in arr:
        if isinstance(x, str):
            s = x.strip()
            if s and len(s) <= 120:
                out.append(s)
    return out[:5]


def generate(question: str, answer: str, *, max_answer_chars: int = 3500) -> list[str]:
    """후속 질문 리스트 반환. 실패 시 빈 리스트."""
    if not question or not answer:
        return []
    a = answer.strip()
    if len(a) > max_answer_chars:
        a = a[:max_answer_chars] + "\n...(이하 생략)"
    user = f"## 사용자 질문\n{question.strip()}\n\n## 에이전트 답변\n{a}\n\n후속 질문 JSON 배열:"
    try:
        res = bedrock_call(
            messages=[{"role": "user", "content": user}],
            model="haiku",
            max_tokens=512,
            temperature=0.4,
            system=_SYS_PROMPT,
            timeout=30.0,
            retries=2,
        )
    except BedrockError:
        return []
    return _parse_json_array(res.get("text", ""))
