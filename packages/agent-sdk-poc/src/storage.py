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


def rewrite_source_paths(answer: str) -> str:
    """답변 본문의 ``(출처: <내부 경로> § <섹션>)`` 에서 경로를 ``origin_label`` 로 치환.

    내부 가공 경로(`packages/xlsx-extractor/output/...` / `../xlsx-extractor/...`)를
    사용자에게 노출하지 않기 위해 서버에서 일괄 치환. 섹션·백틱·축약 표기는 유지.
    """
    if not answer:
        return answer
    out: list[str] = []
    i = 0
    last_path = ""
    while True:
        m = _SOURCE_START.search(answer, i)
        if not m:
            out.append(answer[i:])
            break
        out.append(answer[i:m.start()])
        end = _balanced_paren_end(answer, m.end())
        if end < 0:
            out.append(answer[m.start():])
            break
        body = answer[m.end():end]
        if "§" in body:
            path_raw, _sep, section = body.partition("§")
        else:
            path_raw, section = body, ""
        path_stripped = path_raw.strip().strip("`'\" ").lstrip("/")
        section = section.strip()
        if _is_abbrev(path_stripped):
            if last_path:
                label_path = last_path
            else:
                # 치환할 수 없음 — 원형 유지
                out.append(answer[m.start():end+1])
                i = end + 1
                continue
        else:
            last_path = path_stripped
            meta = _path_to_source_meta(path_stripped)
            label_path = meta.get("origin_label") or path_stripped
        if section:
            out.append(f"(출처: {label_path} § {section})")
        else:
            out.append(f"(출처: {label_path})")
        i = end + 1
    return "".join(out)


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


# ── Confluence manifest 로더 (page path → pageId) ─────────────

_CONFLU_MANIFEST = _ROOT.parent / "confluence-downloader" / "output" / "_manifest.json"
_CONFLU_BASE = "https://bighitcorp.atlassian.net/wiki/pages/viewpage.action?pageId="
_confluence_path_to_id: dict[str, str] = {}


def _load_confluence_manifest():
    """manifest 를 walk 하여 'title/chain' → pageId 매핑 생성."""
    if not _CONFLU_MANIFEST.exists():
        return
    try:
        root = json.loads(_CONFLU_MANIFEST.read_text(encoding="utf-8"))
    except Exception as e:
        print(f"[storage] confluence manifest 로드 실패: {e}")
        return

    def walk(node: dict, chain: list[str]):
        title = node.get("title", "")
        pid = node.get("id", "")
        depth = node.get("depth", 0)
        # depth 0 은 root 공간 (로컬 디렉터리의 한 단계 위). skip.
        if depth > 0 and title and pid:
            new_chain = chain + [title]
            _confluence_path_to_id["/".join(new_chain)] = pid
        else:
            new_chain = chain
        for c in node.get("children", []) or []:
            walk(c, new_chain)

    walk(root, [])
    print(f"[storage] confluence pageId 매핑 {len(_confluence_path_to_id)}개 로드")


_load_confluence_manifest()


def _confluence_url_for(chain_parts: tuple[str, ...]) -> str:
    """디렉터리 체인에서 pageId 탐색 (가장 긴 prefix 매치부터)."""
    key = "/".join(chain_parts)
    pid = _confluence_path_to_id.get(key)
    if pid:
        return _CONFLU_BASE + pid
    # 최장 prefix 매칭 (일부 페이지는 manifest 에 누락될 수 있음)
    for i in range(len(chain_parts) - 1, 0, -1):
        pid = _confluence_path_to_id.get("/".join(chain_parts[:i]))
        if pid:
            return _CONFLU_BASE + pid
    return ""


def _path_to_source_meta(path: str) -> dict:
    """
    xlsx: packages/xlsx-extractor/output/7_System/PK_HUD 시스템/HUD_전투/_final/content.md
      → workbook="PK_HUD 시스템", sheet="HUD_전투",
         origin_label="PK_HUD 시스템.xlsx / HUD_전투 시트"
    xlsx image: .../HUD_전투/_final/images/HUD_전투_detail_r0_fig1.png
      → source="image", origin_label="PK_HUD 시스템 / HUD_전투 / HUD_전투_detail_r0_fig1.png"
    confluence: packages/confluence-downloader/output/시스템 디자인/NPC/content.md
      → workbook="시스템 디자인", sheet="NPC",
         origin_label="Confluence / 시스템 디자인 / NPC",
         origin_url="https://bighitcorp.atlassian.net/wiki/pages/viewpage.action?pageId=<id>"
    """
    parts = path.split("/")
    low = path.lower()
    is_image = low.endswith((".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg"))

    if "xlsx-extractor" in parts:
        try:
            i = parts.index("output")
            rest = parts[i + 1 :]
            if is_image:
                # .../<workbook>/<sheet>/_final/images/<file>.png
                try:
                    img_idx = rest.index("images")
                    before = [p for p in rest[:img_idx] if p != "_final"]
                    img_name = rest[-1]
                    workbook = before[-2] if len(before) >= 2 else (before[-1] if before else "")
                    sheet = before[-1] if before else ""
                    parts_label = [p for p in [workbook, sheet, img_name] if p]
                    return {
                        "workbook": workbook,
                        "sheet": sheet,
                        "path": path,
                        "source": "image",
                        "origin_label": " / ".join(parts_label),
                        "origin_url": "",
                    }
                except ValueError:
                    pass
            if rest and rest[-1] == "content.md":
                rest = rest[:-1]
            if rest and rest[-1] == "_final":
                rest = rest[:-1]
            if len(rest) >= 2:
                workbook = rest[-2]
                sheet = rest[-1]
                return {
                    "workbook": workbook,
                    "sheet": sheet,
                    "path": path,
                    "source": "xlsx",
                    "origin_label": f"{workbook}.xlsx / {sheet} 시트",
                    "origin_url": "",
                }
        except ValueError:
            pass
    if "confluence-downloader" in parts:
        try:
            i = parts.index("output")
            rest = parts[i + 1 :]
            if rest and rest[-1] == "content.md":
                rest = rest[:-1]
            if rest:
                chain = tuple(rest)
                space = rest[0]
                title = rest[-1]
                display_chain = " / ".join(rest)
                return {
                    "workbook": space,
                    "sheet": title,
                    "path": path,
                    "source": "confluence",
                    "origin_label": f"Confluence / {display_chain}",
                    "origin_url": _confluence_url_for(chain),
                }
        except ValueError:
            pass
    return {
        "workbook": "",
        "sheet": path.split("/")[-1],
        "path": path,
        "source": "other",
        "origin_label": path,
        "origin_url": "",
    }


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
