"""
generator.py — Claude Sonnet으로 QnA 답변 생성

검색된 컨텍스트 + 질문 → 출처 포함 답변 생성
"""

import json
import os
import re
import time
from pathlib import Path

import requests
from dotenv import load_dotenv

load_dotenv(Path(__file__).resolve().parent.parent / ".env")

# 모델 매핑 (.env의 MODEL_* 변수에서 로드)
def _load_model_mapping() -> dict:
    mapping = {}
    for key, val in os.environ.items():
        if key.startswith("MODEL_") and key != "MODEL_MAPPING":
            alias = key[len("MODEL_"):].replace("_", "-").lower()
            mapping[alias] = val
    return mapping

MODEL_MAPPING = _load_model_mapping()

SYSTEM_PROMPT = """당신은 모바일 MMORPG "Project K"의 기획 전문가 AI 어시스턴트입니다.

## 규칙
1. **제공된 컨텍스트만 기반으로 답변하세요.** 컨텍스트에 없는 내용을 추측하거나 생성하지 마세요.
2. **답변 후 반드시 출처를 표시하세요.** 형식: `[출처: 워크북명 / 시트명 / 섹션명]`
3. 컨텍스트에서 답을 찾을 수 없으면 "제공된 기획서에서 해당 정보를 찾을 수 없습니다."라고 답하세요.
4. 테이블, 플로우차트(Mermaid) 등 구조화된 정보는 원본 형식을 유지하여 답하세요.
5. 여러 시스템에 걸친 질문은 각 시스템의 관련 부분을 종합하여 답하되, 각각의 출처를 표시하세요.
6. 간결하고 정확하게 답하세요. 불필요한 서론이나 반복을 피하세요.

## 역할별 답변 스타일
- **기획자**: 시스템 규칙, 상호작용, 설계 의도 중심
- **프로그래머**: 데이터 구조, 공식, 시퀀스, 조건 분기 중심
- **QA**: 엣지 케이스, 조건 분기, 상태 전이, 예외 상황 중심
- **PD**: 전체 그림, 시스템 간 관계, 진행 현황 중심
"""


def call_bedrock(
    messages: list[dict],
    system: str = SYSTEM_PROMPT,
    model: str = None,
    max_tokens: int = 2048,
    temperature: float = 0,
) -> dict:
    """Bedrock Claude API 호출."""
    token = os.environ.get("AWS_BEARER_TOKEN_BEDROCK")
    if not token:
        raise RuntimeError("AWS_BEARER_TOKEN_BEDROCK 환경변수 미설정")
    region = os.environ.get("AWS_REGION", "us-east-1")

    if model is None:
        model = os.environ.get("LLM_MODEL", "claude-sonnet-4-5")
    model_id = MODEL_MAPPING.get(model, f"global.anthropic.{model}-v1:0")

    url = f"https://bedrock-runtime.{region}.amazonaws.com/model/{model_id}/invoke"

    body = {
        "anthropic_version": "bedrock-2023-05-31",
        "max_tokens": max_tokens,
        "temperature": temperature,
        "system": system,
        "messages": messages,
    }
    headers = {
        "Content-Type": "application/json",
        "Authorization": f"Bearer {token}",
    }

    t_start = time.time()
    resp = requests.post(url, json=body, headers=headers, timeout=120)
    t_api = time.time() - t_start

    if resp.status_code != 200:
        raise RuntimeError(f"API error {resp.status_code}: {resp.text[:500]}")

    result = resp.json()
    text = result["content"][0]["text"]
    usage = result.get("usage", {})

    return {
        "text": text.strip(),
        "input_tokens": usage.get("input_tokens", 0),
        "output_tokens": usage.get("output_tokens", 0),
        "api_seconds": round(t_api, 1),
        "model": model,
    }


def generate_answer(
    question: str,
    context: str,
    role: str = None,
    conversation_history: list[dict] = None,
    model: str = None,
) -> dict:
    """질문에 대한 답변 생성.

    Args:
        question: 사용자 질문
        context: 검색된 컨텍스트 (format_context 결과)
        role: 사용자 역할 (기획자/프로그래머/QA/PD)
        conversation_history: 이전 대화 히스토리 [(question, answer), ...]
        model: LLM 모델명

    Returns:
        {answer, sources, confidence, tokens_used, api_seconds}
    """
    # 프롬프트 구성
    parts = []

    if role:
        parts.append(f"[사용자 역할: {role}]")

    parts.append(f"## 참조 기획서 컨텍스트\n\n{context}")
    parts.append(f"## 질문\n\n{question}")

    user_message = "\n\n".join(parts)

    # 메시지 구성
    messages = []

    # 대화 히스토리 (최근 3턴)
    if conversation_history:
        for prev_q, prev_a in conversation_history[-3:]:
            messages.append({"role": "user", "content": [{"type": "text", "text": prev_q}]})
            # 이전 답변은 요약하여 전달
            summary = prev_a[:500] + "..." if len(prev_a) > 500 else prev_a
            messages.append({"role": "assistant", "content": [{"type": "text", "text": summary}]})

    messages.append({"role": "user", "content": [{"type": "text", "text": user_message}]})

    # API 호출
    result = call_bedrock(messages, model=model)

    # 출처 추출
    sources = extract_sources(result["text"])

    # 신뢰도 추정
    confidence = estimate_confidence(result["text"], context)

    return {
        "answer": result["text"],
        "sources": sources,
        "confidence": confidence,
        "tokens_used": {
            "input": result["input_tokens"],
            "output": result["output_tokens"],
        },
        "api_seconds": result["api_seconds"],
        "model": result["model"],
    }


def extract_sources(answer_text: str) -> list[dict]:
    """답변 텍스트에서 출처 정보를 추출."""
    sources = []

    # 패턴: [출처: 워크북 / 시트 / 섹션] 또는 [출처 N: ...]
    pattern = r'\[출처\s*\d*:?\s*([^/\]]+)\s*/\s*([^/\]]+)\s*(?:/\s*([^\]]+))?\]'
    for match in re.finditer(pattern, answer_text):
        source = {
            "workbook": match.group(1).strip(),
            "sheet": match.group(2).strip(),
        }
        if match.group(3):
            source["section"] = match.group(3).strip()
        sources.append(source)

    return sources


def estimate_confidence(answer: str, context: str) -> str:
    """답변 신뢰도 추정 (간단한 휴리스틱)."""
    # 답을 찾을 수 없다고 한 경우
    if "찾을 수 없습니다" in answer or "정보가 없습니다" in answer:
        return "none"

    # 출처가 명시된 경우
    source_count = len(re.findall(r'\[출처', answer))

    if source_count >= 2:
        return "high"
    elif source_count == 1:
        return "medium"
    else:
        return "low"
