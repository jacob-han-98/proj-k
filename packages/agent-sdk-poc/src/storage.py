"""
Conversation storage — data/conversations.json 기반 단일 파일.
qna-poc/src/api.py의 저장 로직을 agent-sdk-poc 용으로 이식.
"""

from __future__ import annotations

import datetime
import json
import re
import threading
from pathlib import Path

_ROOT = Path(__file__).resolve().parent.parent
_CONV_FILE = _ROOT / "data" / "conversations.json"

_conversations: dict[str, dict] = {}
_lock = threading.Lock()


def _load():
    global _conversations
    if _CONV_FILE.exists():
        try:
            _conversations = json.loads(_CONV_FILE.read_text(encoding="utf-8"))
            print(f"[storage] 대화 {len(_conversations)}개 로드 ({_CONV_FILE})")
        except Exception as e:
            print(f"[storage] 대화 로드 실패: {e}")
            _conversations = {}
    else:
        _conversations = {}


def _flush():
    _CONV_FILE.parent.mkdir(parents=True, exist_ok=True)
    _CONV_FILE.write_text(
        json.dumps(_conversations, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )


def now_iso() -> str:
    return datetime.datetime.utcnow().isoformat() + "Z"


# ── Source extraction from Agent's inline citations ───────────

_SOURCE_START = re.compile(r"\(\s*출처\s*[:：]\s*")


def _balanced_paren_end(s: str, start: int) -> int:
    """s[start]가 '(' 다음 위치라고 가정하고 matching ')' index 반환. 못 찾으면 -1."""
    depth = 1
    i = start
    while i < len(s):
        ch = s[i]
        if ch == "(":
            depth += 1
        elif ch == ")":
            depth -= 1
            if depth == 0:
                return i
        i += 1
    return -1


_ABBREV_PHRASES = (
    "위와 동일", "위와동일", "위 동일", "위동일", "상기와 동일", "상동",
    "동일", "같음", "위 참조", "위참조", "above", "same as above", "ibid",
)


def _is_abbrev(path: str) -> bool:
    p = path.strip().strip("`'\"")
    if not p:
        return True
    low = p.lower()
    return any(low == a.lower() or low.startswith(a.lower()) for a in _ABBREV_PHRASES)


def extract_sources(answer: str) -> list[dict]:
    """Agent 답변 텍스트에서 `(출처: <path> § <section>)` 를 추출.

    Parens-balanced 파서 — section 안에 `(7)` 같은 중첩 괄호가 있어도 잘리지 않음.
    '위와 동일' 등 축약 표기는 직전 유효 path 로 승계.
    반환 스키마: {workbook, sheet, path, source, section_path, score, source_url}
    """
    seen: set[tuple[str, str]] = set()
    out: list[dict] = []
    last_path = ""
    for m in _SOURCE_START.finditer(answer):
        end = _balanced_paren_end(answer, m.end())
        if end < 0:
            continue
        body = answer[m.end():end].strip()
        if "§" in body:
            path_raw, _, section = body.partition("§")
        else:
            path_raw, section = body, ""
        path_raw = path_raw.strip().strip("`'\" ").lstrip("/")
        section = section.strip()
        if _is_abbrev(path_raw):
            if not last_path:
                continue
            path_raw = last_path
        else:
            last_path = path_raw
        if not path_raw:
            continue
        key = (path_raw, section)
        if key in seen:
            continue
        seen.add(key)
        out.append({
            **_path_to_source_meta(path_raw),
            "section_path": section,
            "score": 1.0,
            "source_url": "",
        })
    return out[:20]


# ── Answer post-processing ────────────────────────────────────

_PROGRESS_EMOJIS = set("🧠💭🔎📂📖🔗🔤✨✅❌")


_META_KEYWORDS = (
    "요약에서", "요약을", "정독", "탐색", "확인했습니다", "찾았습니다",
    "답변 준비", "관련 문서", "근거를 확보", "원본 문서", "찾아보겠습니다",
    "읽어보겠습니다", "검색하겠습니다", "조사하겠습니다", "확인하겠습니다",
    "살펴보겠습니다", "진행하겠습니다", "관련 자료", "먼저 관련",
)


def strip_progress_prefix(answer: str) -> str:
    """Agent 답변 본문 시작부의 메타 서술/진행 이모지 블록 제거 + H2 앞 개행 보정.

    처리 케이스:
    1) "🔎 ... 📖 ... ✅ ..." 이모지 누적 → 첫 `## ` 앞까지 제거
    2) "요약에서 ... 확인했습니다. 원본 문서를 정독..." 메타 서술 → 첫 `## ` 앞까지 제거
    3) "...확인하겠습니다.## 결론" 처럼 개행 없이 붙은 H2 → 첫 `##` 위치에서 잘라 라인 시작으로 정규화
    """
    if not answer:
        return answer

    # 1) 첫 '## 결론' / '## 근거' / '## 답변' / 기타 '## ' 헤딩 탐색
    headings = ["## 결론", "## 근거", "## 답변"]
    pos = -1
    for h in headings:
        p = answer.find(h)
        if p >= 0 and (pos < 0 or p < pos):
            pos = p
    # fallback: 아무 `## ` (라인 시작 아니어도) 찾기
    if pos < 0:
        pos = answer.find("## ")
        if pos < 0:
            return answer

    prefix = answer[:pos].strip()
    if not prefix:
        return answer.lstrip()

    emoji_count = sum(1 for ch in prefix if ch in _PROGRESS_EMOJIS)
    has_meta = any(k in prefix for k in _META_KEYWORDS)
    short = len(prefix) <= 600

    if emoji_count >= 2 or has_meta or (short and len(prefix.splitlines()) <= 3):
        # lead-in 제거. 헤딩 앞이 라인 시작이 되도록 반환 문자열에 newline 보장은 불필요
        # (시작 자체가 '## ' 이므로 Markdown H2 로 파싱됨)
        return answer[pos:].lstrip()

    return answer


def _path_to_source_meta(path: str) -> dict:
    """
    packages/xlsx-extractor/output/7_System/PK_HUD 시스템/HUD_전투/_final/content.md
      → {workbook: "PK_HUD 시스템", sheet: "HUD_전투", source: "xlsx"}

    packages/confluence-downloader/output/시스템 디자인/NPC/content.md
      → {workbook: "시스템 디자인", sheet: "NPC", source: "confluence"}
    """
    parts = path.split("/")
    if "xlsx-extractor" in parts:
        try:
            i = parts.index("output")
            # parts after "output": <category>/<workbook>/<sheet>/_final/content.md
            # or <workbook>/<sheet>/_final/content.md
            rest = parts[i + 1 :]
            # strip _final/content.md
            if rest and rest[-1] == "content.md":
                rest = rest[:-1]
            if rest and rest[-1] == "_final":
                rest = rest[:-1]
            if len(rest) >= 2:
                return {
                    "workbook": rest[-2],
                    "sheet": rest[-1],
                    "path": path,
                    "source": "xlsx",
                }
        except ValueError:
            pass
    if "confluence-downloader" in parts:
        try:
            i = parts.index("output")
            rest = parts[i + 1 :]
            if rest and rest[-1] == "content.md":
                rest = rest[:-1]
            if len(rest) >= 1:
                return {
                    "workbook": rest[0] if len(rest) > 1 else "",
                    "sheet": rest[-1],
                    "path": path,
                    "source": "confluence",
                }
        except ValueError:
            pass
    return {"workbook": "", "sheet": path.split("/")[-1], "path": path, "source": "other"}


# ── Turn / Conversation CRUD ─────────────────────────────────


def save_turn(
    conv_id: str,
    question: str,
    *,
    answer: str,
    sources: list[dict] | None = None,
    tool_trace: list[dict] | None = None,
    elapsed_s: float | None = None,
    cost_usd: float | None = None,
    sdk_session_id: str | None = None,
    title: str | None = None,
) -> dict:
    """대화 턴 추가 후 저장. 없는 경우 새 대화 생성."""
    now = now_iso()
    turn = {
        "question": question,
        "answer": answer,
        "sources": sources or [],
        "tool_trace": tool_trace or [],
        "elapsed_s": elapsed_s,
        "cost_usd": cost_usd,
        "sdk_session_id": sdk_session_id,
        "timestamp": now,
    }
    with _lock:
        if conv_id not in _conversations:
            _conversations[conv_id] = {
                "id": conv_id,
                "title": title or (question[:40] + ("..." if len(question) > 40 else "")),
                "created_at": now,
                "updated_at": now,
                "turns": [],
            }
        _conversations[conv_id]["turns"].append(turn)
        _conversations[conv_id]["updated_at"] = now
        _flush()
    return _conversations[conv_id]


def get_conversation(conv_id: str) -> dict | None:
    with _lock:
        return _conversations.get(conv_id)


def list_conversations(limit: int | None = None) -> list[dict]:
    """최신순 대화 요약."""
    with _lock:
        convs = list(_conversations.values())
    convs.sort(key=lambda c: c.get("updated_at", ""), reverse=True)
    summaries = [
        {
            "id": c["id"],
            "title": c["title"],
            "created_at": c["created_at"],
            "updated_at": c["updated_at"],
            "turn_count": len(c["turns"]),
            "last_elapsed_s": (c["turns"][-1].get("elapsed_s") if c["turns"] else None),
            "last_cost_usd": (c["turns"][-1].get("cost_usd") if c["turns"] else None),
        }
        for c in convs
    ]
    if limit:
        summaries = summaries[:limit]
    return summaries


def fork_conversation(conv_id: str) -> dict | None:
    """대화를 복제, 새 ID 부여."""
    import copy
    import uuid

    with _lock:
        original = _conversations.get(conv_id)
        if not original:
            return None
        new_id = str(uuid.uuid4())
        now = now_iso()
        new_conv = copy.deepcopy(original)
        new_conv["id"] = new_id
        new_conv["title"] = f"(fork) {original['title']}"
        new_conv["created_at"] = now
        new_conv["updated_at"] = now
        # Fork 된 대화는 새로운 sdk_session_id 를 받게 되므로 턴의 기존 값은 유지.
        _conversations[new_id] = new_conv
        _flush()
    return new_conv


def get_conv_history(conv_id: str, n_last: int = 5) -> list[tuple[str, str]]:
    """에이전트 재호출 시 사용할 최근 N턴 (Q, A)."""
    with _lock:
        turns = _conversations.get(conv_id, {}).get("turns", [])
    return [(t["question"], t["answer"]) for t in turns[-n_last:]]


# 모듈 import 시 자동 로드
_load()
