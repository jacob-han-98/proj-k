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

from projk_tools import create_projk_server, get_datasheet_schema_summary

POC_DIR = Path(__file__).parent.parent.resolve()   # packages/agent-sdk-poc/

# Load .env — agent-sdk-poc 우선, qna-poc 는 폴백 (둘 다 로드, setdefault 라 충돌 X)
# break 제거: agent-sdk-poc/.env 에 추가 키만 두고 Bedrock 토큰은 qna-poc/.env 에서 폴백.
for _env_file in [POC_DIR / ".env", POC_DIR.parent / "qna-poc" / ".env"]:
    if _env_file.exists():
        for line in _env_file.read_text().splitlines():
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                key, _, val = line.partition("=")
                os.environ.setdefault(key.strip(), val.strip())


ALLOWED_TOOLS = [
    # 내장 — 코퍼스/인덱스 탐색의 주력
    "Glob",
    "Grep",
    "Read",
    # 커스텀 MCP — KG 보조
    "mcp__projk__list_systems",
    "mcp__projk__find_related_systems",
    "mcp__projk__glossary_lookup",
    # DataSheet (게임 런타임 데이터 — game_data SQLite)
    "mcp__projk__list_game_tables",
    "mcp__projk__describe_game_table",
    "mcp__projk__query_game_table",
    "mcp__projk__lookup_game_enum",
    # 비교 모드 — 호출 게이팅은 system_prompt 의 compare_mode 블록이 담당
    "mcp__projk__compare_with_reference_games",
    "mcp__projk__search_external_game",
]

# 명시적으로 금지 (서버 배포 시 보안: Bash/Write/Edit 실수 호출 차단)
# - TodoWrite: 에이전트 내부 플래닝 도구. 사용자 진행 타임라인 노이즈 + 레이아웃 깨뜨림.
# - AskUserQuestion: 자동/배포 환경에선 사용자 응답 받을 수 없음 — 무한 대기 유발. 차단.
# - WebSearch (Anthropic native): Bedrock 환경 미지원 — 호출되면 "권한 없음" 만 받음. 차단.
DISALLOWED_TOOLS = [
    "Bash",
    "Write",
    "Edit",
    "NotebookEdit",
    "ToolSearch",
    "Skill",
    "TodoWrite",
    "AskUserQuestion",
    "WebSearch",
]


# 비교 모드일 때만 추가되는 도구 — Deep Research 가 oracle 0건일 때 web fallback.
# Bedrock 환경에서 WebSearch (Anthropic native server tool) 는 미지원이므로
# 대신 mcp__projk__web_search (Tavily wrapping) 사용. WebFetch 는 본문 정독용.
COMPARE_MODE_EXTRA_TOOLS = [
    "mcp__projk__web_search",
    "WebFetch",
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


COMPARE_MODE_PROMPT = """
[비교 모드 활성 — 타게임 Deep Research]
이번 질문은 타게임 비교 모드입니다.

워크플로우 (이 순서를 지킨다):
1. 평소대로 Excel + Confluence 탐색을 먼저 완료 (CLAUDE.md 표준 워크플로우 1~6단계).
2. oracle 큐레이트 데이터 검색:
   - mcp__projk__compare_with_reference_games(keyword=..., include_raw=true 권장)
     → 리니지M/W, Lord Nine, Vampir KG. KG hit 0 이면 raw 자동 검색.
   - mcp__projk__search_external_game(game_name=..., query=...)
     → 사용자가 특정 게임명을 거론한 경우 (예: "HIT2의 X 알려줘").
3. **Web fallback** (mcp__projk__web_search → WebFetch) — oracle 두 도구 모두 0건/빈약(snippet 매칭만 있고 직접 시스템 설명 없음)일 때만:
   - mcp__projk__web_search(query="<게임명> <시스템> 공식|위키") 로 1~3회 검색 (Tavily)
   - 결과의 results[].url 중 **공식 사이트 (plaync.com, naver.game.naver.com 등) > 위키 (namu.wiki) > 인벤·디시 > 유튜브** 순서로 신뢰
   - **핵심 1~2개 URL 만** WebFetch 로 본문 정독 (전체를 fetch 하지 말 것)
   - 일부 사이트(namu.wiki 등)는 403 Forbidden — Tavily 가 반환한 results[].content snippet 을 인용해도 충분
   - oracle 에 풍부한 자료가 있으면 web 호출하지 말 것 (비용·정확도)

답변 구조 (CLAUDE.md 의 4단 구조 위에 비교 섹션을 덧붙임):
    ## 결론
    ## 근거 (Project K 현재 설계)
    ## 타게임 사례
        ### 리니지M / 리니지W / Lord Nine / Vampir   ← oracle 출처
        ### (그 외 사용자가 거론한 게임)                ← search_external_game / web 출처
    ## 비교 인사이트
    ## 보강 제안 (선택)
    ## 더 볼만한 곳

출처 형식 (4가지 tier — 답변에서 어떤 tier 인지 식별 가능해야 함):
    (출처: external/<게임>/<카테고리>/<항목명> § <섹션>)         ← oracle KG (큐레이트)
    (출처: external/<게임>/raw/<파일명> § <발췌>)               ← oracle raw (커뮤니티)
    (출처: external/<발견된게임>/cross-mention/<파일명> § ...)  ← cross_mentions
    (출처: web/<도메인>/<페이지 제목> § <섹션>)                  ← Gemini google_search / WebFetch 결과
    예: (출처: web/lineagem.plaync.com/PVP 시스템 소개 § 성향치)
        (출처: web/namu.wiki/HIT2 § 서버 시스템)

★ web 인용 규칙 (반드시 지킬 것 — 프론트의 출처 카드 자동 분류와 클릭 동작이 이 형식에 의존):
- 형식은 반드시 (출처: web/<도메인>/<페이지 제목>) — "(참고 자료: 실시간 웹 / web/…)" 같은 변형 금지
- 도메인은 실제 호스트 (event-hit2.nexon.com, namu.wiki, kr.playblackdesert.com 등)
- 검색 일자는 답변 본문 어디에든 한 번 명시 (예: "검색 일자: 2026-04-21")
- 인라인에서 URL 을 단순 언급할 때는 백틱 ``url`` 로 감싸면 프론트가 자동 클릭 가능 링크로 변환

규칙:
- external/ 출처는 "참고 자료 (oracle 큐레이트)" 라고 명시.
- web/ 출처는 "참고 자료 (실시간 웹)" 라고 명시 + 검색 일자(오늘 날짜)를 한 번 표기.
- 게임명은 한국어 표시명 그대로 사용 (리니지M, 리니지W, Lord Nine, Vampir, HIT2 등).
- 타게임 인용도 추측 금지 — 도구가 반환한 값만 인용.
- 각 게임 섹션이 비어 있으면 "(데이터 없음)" 한 줄로 표기.
- web 결과는 공식·위키 우선. 댓글·게시글은 "(커뮤니티 의견)" 명시 후 인용.

Miss 보고 (4-tier 분리 — 정직성 핵심):
- "PK 미확인": Excel/Confluence 검색 0건
- "oracle 미확인": compare/search_external_game 0건
- "web 미확인": WebSearch 도 0건 (또는 WebSearch 미사용 사유)
- 둘/셋/넷 모두 미확인이면 그 사실 자체를 결론에 명시하고, 사용자에게 자료 직접 제공 등 next step 제안.
""".strip()


# 비교 모드 OFF 라도, 사용자가 외부 게임을 명시적으로 거론하면 자동 발동.
EXTERNAL_GAME_AUTO_PROMPT = """
[외부 게임 자동 조회 규칙]
사용자 질문에 다음 게임 이름이 명시적으로 등장하면, 비교 모드 토글이 OFF여도
mcp__projk__search_external_game 또는 mcp__projk__compare_with_reference_games
를 호출해 답변에 반영한다:
  - 4게임: 리니지M, 리니지W, Lord Nine, Vampir
  - 그 외 자주 언급되는 MMORPG: HIT2/히트2, 검은사막/BDO, 로스트아크, 디아블로,
    오딘, RF온라인, WoW

호출 후 답변 구조:
- 일반 PK 답변(4단 구조) 끝에 "## 타게임 참고" 섹션을 추가.
- 결과가 0건이면 "{게임명}의 {시스템} 관련 자료는 PK 코퍼스·oracle raw 모두에서
  확인되지 않음" 한 줄 명시 후, 사용자가 제공한 컨텍스트만으로 답변.

이는 정직성 규칙: PK 미확인 vs 외부 자료 미확인 vs 둘 다 미확인을 분리해 보고한다.
환각 절대 금지.
""".strip()


def _make_options(
    resume: str | None = None,
    model: str | None = None,
    compare_mode: bool = False,
) -> ClaudeAgentOptions:
    projk_server = create_projk_server()

    resolved = _resolve_model(model)
    base_prompt = f"오늘 날짜: {date.today().isoformat()}"

    # DataSheet 테이블 스키마 주입 (query_game_table 컬럼명 추측 방지)
    # qna-poc 와 동일 패턴 — 187개 테이블 × 평균 30컬럼 + Enum 목록 = ~31KB.
    # system_prompt 에 들어가므로 SDK 의 자동 캐싱 대상이 되어 비용 흡수됨.
    ds_schema = get_datasheet_schema_summary()
    if ds_schema:
        base_prompt = base_prompt + "\n\n" + ds_schema

    if compare_mode:
        base_prompt = base_prompt + "\n\n" + COMPARE_MODE_PROMPT
    else:
        # OFF 라도 외부 게임 거론 시 자동 발동하는 규칙은 항상 주입 (정직성 보장)
        base_prompt = base_prompt + "\n\n" + EXTERNAL_GAME_AUTO_PROMPT

    # compare_mode 일 때만 web 도구 활성화 — 정직성 모델 보호
    allowed = list(ALLOWED_TOOLS)
    if compare_mode:
        allowed.extend(COMPARE_MODE_EXTRA_TOOLS)

    return ClaudeAgentOptions(
        system_prompt=base_prompt,
        mcp_servers={"projk": projk_server},
        allowed_tools=allowed,
        disallowed_tools=DISALLOWED_TOOLS,
        # bypassPermissions: ALLOWED_TOOLS 화이트리스트로 이미 보안 경계 잡혀있으므로
        # default 모드의 도구별 권한 프롬프트는 서버/배치 환경에선 무한 대기를 유발.
        # WebFetch 도메인 화이트리스트도 우회되지만, 어차피 답변에 출처 인용 강제 + 사후 audit 가능.
        permission_mode="bypassPermissions",
        cwd=str(POC_DIR),
        max_turns=30 if compare_mode else 20,
        model=resolved,
        env={
            "CLAUDE_CODE_USE_BEDROCK": os.environ.get("CLAUDE_CODE_USE_BEDROCK", "1"),
            "AWS_BEARER_TOKEN_BEDROCK": os.environ.get("AWS_BEARER_TOKEN_BEDROCK", ""),
            "AWS_REGION": os.environ.get("AWS_REGION", "us-east-1"),
        },
        **({"resume": resume} if resume else {}),
    )


async def run_query(prompt: str, model: str | None = None, compare_mode: bool = False):
    """단일 질의."""
    async for message in query(
        prompt=prompt, options=_make_options(model=model, compare_mode=compare_mode)
    ):
        yield message


async def run_query_with_session(
    prompt: str,
    session_id: str | None = None,
    model: str | None = None,
    compare_mode: bool = False,
):
    """세션 지원 질의."""
    async for message in query(
        prompt=prompt,
        options=_make_options(resume=session_id, model=model, compare_mode=compare_mode),
    ):
        yield message
