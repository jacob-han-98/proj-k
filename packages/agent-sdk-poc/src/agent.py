"""
Agent SDK Wrapper — Project K
===============================
Claude Agent SDK의 query()로 Project K 기획 지식 베이스 에이전트를 실행.
CLAUDE.md(정적 도메인 지식)는 cwd에서 자동 로딩, system_prompt는 동적 컨텍스트(오늘 날짜 등).
"""

import os
from datetime import date
from pathlib import Path

from claude_agent_sdk import query, ClaudeAgentOptions

from projk_tools import create_projk_server

POC_DIR = Path(__file__).parent.parent.resolve()   # packages/agent-sdk-poc/

# Load .env — agent-sdk-poc 우선, 없으면 qna-poc 에서 폴백
for _env_file in [POC_DIR / ".env", POC_DIR.parent / "qna-poc" / ".env"]:
    if _env_file.exists():
        for line in _env_file.read_text().splitlines():
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                key, _, val = line.partition("=")
                os.environ.setdefault(key.strip(), val.strip())
        break


ALLOWED_TOOLS = [
    # 내장 — 코퍼스/인덱스 탐색의 주력
    "Glob",
    "Grep",
    "Read",
    # 커스텀 MCP — KG 보조
    "mcp__projk__list_systems",
    "mcp__projk__find_related_systems",
    "mcp__projk__glossary_lookup",
]

# 명시적으로 금지 (서버 배포 시 보안: Bash/Write/Edit 실수 호출 차단)
# TodoWrite 는 에이전트 내부 플래닝 도구인데 사용자의 진행 타임라인에 노출되면
# 의미 없이 자리만 차지 + 레이아웃을 깨뜨려 차단.
DISALLOWED_TOOLS = [
    "Bash",
    "Write",
    "Edit",
    "NotebookEdit",
    "WebFetch",
    "WebSearch",
    "ToolSearch",
    "Skill",
    "TodoWrite",
]


# 모델 별칭 → Bedrock ID (CLI가 수용하는 형태)
MODEL_ALIASES = {
    "opus": "global.anthropic.claude-opus-4-7",
    "opus-4-7": "global.anthropic.claude-opus-4-7",
    "opus-4-6": "global.anthropic.claude-opus-4-6-v1",
    "sonnet": "global.anthropic.claude-sonnet-4-6",
    "haiku": "global.anthropic.claude-haiku-4-5-20251001-v1:0",
}
DEFAULT_MODEL = "opus"


def _resolve_model(model: str | None) -> str | None:
    if not model:
        model = DEFAULT_MODEL
    return MODEL_ALIASES.get(model, model)


def _make_options(resume: str | None = None, model: str | None = None) -> ClaudeAgentOptions:
    projk_server = create_projk_server()

    resolved = _resolve_model(model)
    return ClaudeAgentOptions(
        system_prompt=f"오늘 날짜: {date.today().isoformat()}",
        mcp_servers={"projk": projk_server},
        allowed_tools=ALLOWED_TOOLS,
        disallowed_tools=DISALLOWED_TOOLS,
        permission_mode="default",
        cwd=str(POC_DIR),
        max_turns=20,
        model=resolved,
        env={
            "CLAUDE_CODE_USE_BEDROCK": os.environ.get("CLAUDE_CODE_USE_BEDROCK", "1"),
            "AWS_BEARER_TOKEN_BEDROCK": os.environ.get("AWS_BEARER_TOKEN_BEDROCK", ""),
            "AWS_REGION": os.environ.get("AWS_REGION", "us-east-1"),
        },
        **({"resume": resume} if resume else {}),
    )


async def run_query(prompt: str, model: str | None = None):
    """단일 질의."""
    async for message in query(prompt=prompt, options=_make_options(model=model)):
        yield message


async def run_query_with_session(prompt: str, session_id: str | None = None, model: str | None = None):
    """세션 지원 질의."""
    async for message in query(prompt=prompt, options=_make_options(resume=session_id, model=model)):
        yield message
