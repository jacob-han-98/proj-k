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


def extract_sources(answer: str) -> list[dict]:
    """Agent 답변 텍스트에서 `(출처: <path> § <section>)` 를 추출.

    Parens-balanced 파서 — section 안에 `(7)` 같은 중첩 괄호가 있어도 잘리지 않음.
    반환 스키마: {workbook, sheet, path, source, section_path, score, source_url}
    """
    seen: set[tuple[str, str]] = set()
    out: list[dict] = []
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
        # path 는 공백으로 끝나는 복수 인용 구분 방지: 첫 번째 ; 나 ' 또는 ',' 이전까지 라인으로
        # (실 사례에선 한 출처당 한 인용 블록이 정상)
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
