"""
slack_bot.py — Project K QnA Slack Bot

Slack Bolt 기반. @ProjectK-AI 멘션 또는 DM으로 질문 → Agent 답변.
스레드로 멀티턴 대화 지원, Streamlit 상세 링크 제공.

실행: cd packages/qna-poc && python -m src.slack_bot
"""

import base64
import os
import re
import sys
import time
import logging
from pathlib import Path

from dotenv import load_dotenv

# 프로젝트 루트를 path에 추가
_project_root = Path(__file__).resolve().parent.parent
if str(_project_root) not in sys.path:
    sys.path.insert(0, str(_project_root))

load_dotenv(_project_root / ".env")

# ── 설정 ──
SLACK_BOT_TOKEN = os.environ.get("SLACK_BOT_TOKEN", "")
SLACK_APP_TOKEN = os.environ.get("SLACK_APP_TOKEN", "")  # xapp- (Socket Mode)
STREAMLIT_URL = os.environ.get("STREAMLIT_URL", "https://cp.tech2.hybe.im/proj-k-agent")
CONFLUENCE_BASE = "https://bighitcorp.atlassian.net/wiki"

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
log = logging.getLogger("slack_bot")


# ── Markdown → Slack mrkdwn 변환 ──

def md_to_slack(text: str) -> str:
    """Markdown → Slack mrkdwn 변환.

    Slack은 **bold**, *italic*, `code`, ```codeblock```, ~strike~,
    > quote, <url|text> 링크를 지원하지만 표준 Markdown과 문법이 다름.
    """
    # 테이블 → 텍스트 (Slack은 표 미지원)
    text = _convert_tables(text)

    # Mermaid 블록 → mermaid.ink 이미지 링크로 변환
    text = _convert_mermaid_blocks(text)

    # 헤딩 → bold
    text = re.sub(r'^#{1,6}\s+(.+)$', r'*\1*', text, flags=re.MULTILINE)

    # Markdown 링크 → Slack 링크
    text = re.sub(r'\[([^\]]+)\]\(([^)]+)\)', r'<\2|\1>', text)

    # 이미지 → 링크
    text = re.sub(r'!\[([^\]]*)\]\(([^)]+)\)', r'<\2|[이미지: \1]>', text)

    # 수평선
    text = re.sub(r'^---+$', '─' * 30, text, flags=re.MULTILINE)

    # HTML 태그 제거 (details, summary 등)
    text = re.sub(r'<details>.*?</details>', '', text, flags=re.DOTALL)
    text = re.sub(r'</?(?:summary|details|div|span|br)[^>]*>', '', text)

    return text.strip()


def _mermaid_to_image_url(code: str) -> str:
    """Mermaid 코드 → mermaid.ink 이미지 URL 변환."""
    encoded = base64.urlsafe_b64encode(code.strip().encode("utf-8")).decode("ascii")
    return f"https://mermaid.ink/img/{encoded}"


def _convert_mermaid_blocks(text: str) -> str:
    """Mermaid 코드블록을 mermaid.ink 이미지 링크로 변환."""
    def _replace(m):
        code = m.group(1)
        url = _mermaid_to_image_url(code)
        return f"<{url}|:bar_chart: 플로우 다이어그램 보기>"

    return re.sub(r'```mermaid\n(.*?)```', _replace, text, flags=re.DOTALL)


def _convert_tables(text: str) -> str:
    """Markdown 테이블 → 정렬된 텍스트."""
    lines = text.split('\n')
    result = []
    table_lines = []
    in_table = False

    for line in lines:
        stripped = line.strip()
        if stripped.startswith('|') and stripped.endswith('|'):
            # 구분선(|---|---| 형태) 무시
            if re.match(r'^\|[\s\-:|]+\|$', stripped):
                in_table = True
                continue
            table_lines.append(stripped)
            in_table = True
        else:
            if in_table and table_lines:
                result.append(_format_table(table_lines))
                table_lines = []
                in_table = False
            result.append(line)

    if table_lines:
        result.append(_format_table(table_lines))

    return '\n'.join(result)


def _format_table(lines: list[str]) -> str:
    """테이블 라인들을 Slack 코드블록으로 포맷."""
    rows = []
    for line in lines:
        cells = [c.strip() for c in line.strip('|').split('|')]
        rows.append(cells)

    if not rows:
        return ''

    # 열 너비 계산
    col_count = max(len(r) for r in rows)
    widths = [0] * col_count
    for row in rows:
        for i, cell in enumerate(row):
            if i < col_count:
                widths[i] = max(widths[i], len(cell))

    # 포맷
    formatted = []
    for i, row in enumerate(rows):
        parts = []
        for j in range(col_count):
            val = row[j] if j < len(row) else ''
            parts.append(val.ljust(widths[j]))
        formatted.append('  '.join(parts))
        # 첫 행(헤더) 뒤에 구분선
        if i == 0:
            formatted.append('  '.join('-' * w for w in widths))

    return '```\n' + '\n'.join(formatted) + '\n```'


def format_sources_slack(sources: list[dict]) -> str:
    """출처 목록을 Slack 텍스트로 포맷."""
    if not sources:
        return ""

    lines = []
    for s in sources[:5]:  # 최대 5개
        wb = s.get("workbook", "?")
        sheet = s.get("sheet", "")

        if wb.startswith("Confluence"):
            search_term = sheet or wb.split("/")[-1]
            link = f"{CONFLUENCE_BASE}/search?text={search_term}&where=PK"
            display = wb.split("/")[-1] if "/" in wb else wb
            if sheet:
                display += f" / {sheet}"
            lines.append(f"  :link: <{link}|{display}>")
        else:
            display = wb
            if sheet:
                display += f" / {sheet}"
            lines.append(f"  :bar_chart: {display}")

    return "\n".join(lines)


def format_answer_blocks(question: str, result: dict) -> list[dict]:
    """Agent 답변을 Slack Block Kit 메시지로 포맷."""
    answer = result["answer"]
    confidence = result.get("confidence", "medium")
    sources = []
    seen = set()
    for chunk in result.get("chunks", []):
        key = f"{chunk.get('workbook', '')}/{chunk.get('sheet', '')}"
        if key not in seen:
            seen.add(key)
            sources.append({
                "workbook": chunk.get("workbook", ""),
                "sheet": chunk.get("sheet", ""),
            })

    # 신뢰도 이모지
    conf_emoji = {"high": ":large_green_circle:", "medium": ":large_yellow_circle:",
                  "low": ":red_circle:", "none": ":white_circle:"}.get(confidence, ":white_circle:")

    # Mermaid 블록 추출 (이미지 블록으로 분리)
    mermaid_blocks = re.findall(r'```mermaid\n(.*?)```', answer, flags=re.DOTALL)

    # 답변 본문 (Slack mrkdwn)
    slack_answer = md_to_slack(answer)

    # 3000자 초과 시 잘라서 Streamlit 링크 안내
    if len(slack_answer) > 2800:
        slack_answer = slack_answer[:2800] + "\n\n... _(답변이 길어 일부만 표시)_"

    blocks = [
        {
            "type": "section",
            "text": {"type": "mrkdwn", "text": slack_answer},
        },
    ]

    # Mermaid 다이어그램을 인라인 이미지로 추가
    for i, mermaid_code in enumerate(mermaid_blocks[:3]):  # 최대 3개
        img_url = _mermaid_to_image_url(mermaid_code)
        blocks.append({
            "type": "image",
            "image_url": img_url,
            "alt_text": f"플로우 다이어그램 {i + 1}",
        })

    # 출처
    sources_text = format_sources_slack(sources)
    if sources_text:
        blocks.append({"type": "divider"})
        blocks.append({
            "type": "section",
            "text": {"type": "mrkdwn", "text": f"*출처* {conf_emoji}\n{sources_text}"},
        })

    # 메타 + Streamlit 링크
    tokens = result.get("total_tokens", 0)
    api_sec = result.get("total_api_seconds", 0)
    meta = f"_{tokens:,} tokens · {api_sec:.1f}s_  |  <{STREAMLIT_URL}|:desktop_computer: Streamlit에서 상세 보기>"
    blocks.append({
        "type": "context",
        "elements": [{"type": "mrkdwn", "text": meta}],
    })

    return blocks


# ── 스레드별 대화 히스토리 (in-memory) ──

# { thread_ts: [(question, answer), ...] }
_thread_history: dict[str, list[tuple[str, str]]] = {}
_MAX_HISTORY_TURNS = 3
_MAX_THREADS = 200  # 메모리 제한


# ── Slack App (지연 초기화) ──

_app = None


def _get_app():
    """Slack App 지연 초기화. 토큰이 없으면 None 반환."""
    global _app
    if _app is not None:
        return _app

    if not SLACK_BOT_TOKEN:
        return None

    from slack_bolt import App
    _app = App(token=SLACK_BOT_TOKEN)
    _register_handlers(_app)
    return _app


def _register_handlers(bolt_app):
    """이벤트 핸들러 등록."""

    @bolt_app.event("app_mention")
    def handle_mention(event, say, client):
        """채널에서 @ProjectK-AI 멘션 시 답변."""
        _handle_question(event, say, client)

    @bolt_app.event("message")
    def handle_dm(event, say, client):
        """DM으로 직접 질문."""
        # DM만 처리 (채널 메시지는 멘션으로 처리)
        if event.get("channel_type") != "im":
            return
        # 봇 자신의 메시지 무시
        if event.get("bot_id"):
            return
        _handle_question(event, say, client)


def _handle_question(event, say, client):
    """질문 처리 공통 로직."""
    text = event.get("text", "").strip()
    user = event.get("user", "?")
    channel = event.get("channel", "")
    thread_ts = event.get("thread_ts") or event.get("ts")

    # 멘션 태그 제거
    question = re.sub(r'<@[A-Z0-9]+>', '', text).strip()

    if not question:
        say(text="질문을 입력해주세요! 예: `@ProjectK-AI 변신 시스템이 뭐야?`", thread_ts=thread_ts)
        return

    log.info(f"[Q] user={user} channel={channel} question='{question[:60]}'")

    # "생각 중" 리액션
    try:
        client.reactions_add(channel=channel, name="hourglass_flowing_sand", timestamp=event["ts"])
    except Exception:
        pass

    # 이전 대화 히스토리 가져오기
    conv_history = _thread_history.get(thread_ts, [])[-_MAX_HISTORY_TURNS:]

    # Agent 파이프라인 실행
    t0 = time.time()
    try:
        from src.agent import agent_answer
        from src.qna_db import save_qna

        result = agent_answer(question, conversation_history=conv_history or None)
        elapsed = time.time() - t0
        log.info(f"[A] {elapsed:.1f}s, {result.get('total_tokens', 0)} tokens, "
                 f"confidence={result.get('confidence', '?')}")

        # QnA DB 저장
        sources = []
        seen = set()
        for chunk in result.get("chunks", []):
            key = f"{chunk.get('workbook', '')}/{chunk.get('sheet', '')}"
            if key not in seen:
                seen.add(key)
                sources.append({"workbook": chunk.get("workbook", ""), "sheet": chunk.get("sheet", "")})

        save_qna(
            question=question,
            answer=result["answer"],
            role="slack",
            confidence=result.get("confidence"),
            total_tokens=result.get("total_tokens", 0),
            api_seconds=result.get("total_api_seconds", 0),
            sources=sources,
            trace=result.get("trace"),
            answer_model="claude-opus-4-6",
            planning_model="claude-opus-4-6",
            reflection_model="claude-opus-4-6",
        )

        # 대화 히스토리 저장
        if thread_ts not in _thread_history:
            # 오래된 스레드 정리
            if len(_thread_history) >= _MAX_THREADS:
                oldest = next(iter(_thread_history))
                del _thread_history[oldest]
            _thread_history[thread_ts] = []
        _thread_history[thread_ts].append((question, result["answer"]))

        # Block Kit 메시지 전송 (이미지 블록 실패 시 폴백)
        blocks = format_answer_blocks(question, result)
        try:
            say(blocks=blocks, text=result["answer"][:200], thread_ts=thread_ts)
        except Exception as img_err:
            if "image" in str(img_err).lower():
                # 이미지 블록 제거 후 재시도
                blocks = [b for b in blocks if b.get("type") != "image"]
                say(blocks=blocks, text=result["answer"][:200], thread_ts=thread_ts)
            else:
                raise

    except Exception as e:
        log.error(f"[ERROR] {e}", exc_info=True)
        say(text=f":warning: 답변 생성 중 오류가 발생했습니다.\n```{str(e)[:500]}```",
            thread_ts=thread_ts)

    # 리액션 제거
    try:
        client.reactions_remove(channel=channel, name="hourglass_flowing_sand", timestamp=event["ts"])
        client.reactions_add(channel=channel, name="white_check_mark", timestamp=event["ts"])
    except Exception:
        pass


# ── 메인 ──

def main():
    if not SLACK_BOT_TOKEN:
        print("ERROR: SLACK_BOT_TOKEN not set in .env")
        sys.exit(1)
    if not SLACK_APP_TOKEN:
        print("ERROR: SLACK_APP_TOKEN not set in .env")
        sys.exit(1)

    bolt_app = _get_app()
    log.info("Project K QnA Slack Bot starting...")
    log.info(f"  Streamlit URL: {STREAMLIT_URL}")

    from slack_bolt.adapter.socket_mode import SocketModeHandler
    handler = SocketModeHandler(bolt_app, SLACK_APP_TOKEN)
    handler.start()


if __name__ == "__main__":
    main()
