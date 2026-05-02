"""Quick Find — 빠른 메타 검색 (≤ 2초, 답변 생성 없음).

설계:
    Phase 1 (~50ms, 비-LLM): summaries/*.md 파일에서 빌드한 in-memory 인덱스에
       substring/key_term 매칭으로 후보 30~50건 추출. 각 hit 에 matched_via 라벨.
    Phase 2 (~1~1.5s, Haiku stream): 후보를 Haiku 에 보내 query 와 가장 가까운
       순서로 doc_id 한 줄씩 stream → 즉시 NDJSON `hit` 이벤트로 forward.
    Phase 3 (즉시): 종료 마커 (`result` 이벤트) 전송.

KG / vector layer 는 v1 미포함 (substring 만으로 quality 측정 후 결정).
matched_via 필드로 어느 layer 가 어떤 hit 을 잡았는지 visible.
"""
from __future__ import annotations

import asyncio
import json
import os
import re
import time
from dataclasses import dataclass, asdict, field
from pathlib import Path
from typing import AsyncIterator

import httpx

from bedrock_stream import stream_messages, BedrockStreamError, normalize_model

# 인덱스 위치 — agent-sdk-poc/index/summaries/{xlsx,confluence}/...
_PKG_ROOT = Path(__file__).resolve().parents[1]
SUMMARIES_DIR = _PKG_ROOT / "index" / "summaries"
XLSX_OUTPUT_DIR = _PKG_ROOT.parent / "xlsx-extractor" / "output"
CONF_OUTPUT_DIR = _PKG_ROOT.parent / "confluence-downloader" / "output"


@dataclass
class Doc:
    doc_id: str               # "xlsx::<workbook>::<sheet>" or "conf::<page-path>"
    kind: str                 # "xlsx" | "confluence"
    title: str                # 시트명 or 페이지명
    workbook: str | None      # xlsx only
    space: str | None         # confluence only
    path: str                 # 표시용 (예: "7_System / PK_HUD 시스템 / HUD_전투")
    summary: str              # 한 줄 설명 (없으면 첫 200자)
    key_terms: list[str]      # 핵심 용어 리스트
    summary_md_path: str      # index/summaries/.../*.md 절대경로
    content_md_path: str      # 실제 content.md 절대경로 (frontend 가 열 때 사용)


# ── 인덱스 빌드 (모듈 로드 시 한 번) ───────────────────────────────────────

_INDEX: list[Doc] = []
_INDEX_BUILT = False


def _parse_summary_md(path: Path) -> Doc | None:
    """summary 한 파일 → Doc."""
    try:
        txt = path.read_text(encoding="utf-8")
    except Exception:
        return None

    # frontmatter 형태가 아니라 인용블록 형태 (`> 출처: ...`, `> 원본: ...`)
    src_match = re.search(r"^>\s*출처:\s*(.+)$", txt, re.MULTILINE)
    orig_match = re.search(r"^>\s*원본:\s*(.+)$", txt, re.MULTILINE)
    src = src_match.group(1).strip() if src_match else ""
    orig = orig_match.group(1).strip() if orig_match else ""

    # 한 줄 설명
    one_line = ""
    m = re.search(r"##\s*한 줄 설명\s*\n([^\n]+)", txt)
    if m:
        one_line = m.group(1).strip()
    if not one_line:
        # fallback — 첫 의미있는 줄
        for line in txt.splitlines():
            s = line.strip()
            if s and not s.startswith("#") and not s.startswith(">"):
                one_line = s[:200]
                break

    # 핵심 용어
    key_terms: list[str] = []
    kt_match = re.search(r"##\s*핵심 용어\s*\n((?:\s*-\s*[^\n]+\n?)+)", txt)
    if kt_match:
        for line in kt_match.group(1).splitlines():
            t = line.strip().lstrip("-").strip()
            if t:
                key_terms.append(t)

    # path 안에서 kind 결정
    rel = path.relative_to(SUMMARIES_DIR)
    parts = rel.parts
    if not parts:
        return None
    kind = parts[0]  # "xlsx" or "confluence"
    if kind not in ("xlsx", "confluence"):
        return None

    title = path.stem  # 파일명 (확장자 제외)

    if kind == "xlsx":
        # 실제 구조: 3-level `xlsx/<category>/<workbook>/<sheet>.md`  또는
        #          2-level `xlsx/<workbook>/<sheet>.md` (orphan, category 없음)
        # category 는 `\d+_` prefix (7_System, 8_Contents). PK_ 시작이면 워크북.
        if len(parts) >= 4 and re.match(r"^\d+_", parts[1]):
            category = parts[1]
            workbook = parts[2]
            sheet = title
        elif len(parts) >= 3:
            category = None
            workbook = parts[1]
            sheet = title
        else:
            return None
        path_display = " / ".join(p for p in [category, workbook, sheet] if p)
        doc_id = f"xlsx::{workbook}::{sheet}"
        content_md = ""
        if orig:
            cand = (_PKG_ROOT.parent / "xlsx-extractor" / orig.lstrip("./")) if orig.startswith("packages/") else None
            if cand and cand.exists():
                content_md = str(cand)
        return Doc(
            doc_id=doc_id, kind="xlsx", title=sheet,
            workbook=workbook, space=None,
            path=path_display, summary=one_line, key_terms=key_terms,
            summary_md_path=str(path), content_md_path=content_md,
        )
    else:  # confluence
        # parts: ("confluence", <space>, ...descendants..., <page>.md)
        space = parts[1] if len(parts) >= 3 else None
        descendants = parts[2:-1]  # 제외: kind / space / .md filename
        path_display = " / ".join([space or "?"] + list(descendants) + [title])
        doc_id = "conf::" + "/".join([space or "?"] + list(descendants) + [title])
        # confluence content.md 추정
        rel_conf = "/".join([space or ""] + list(descendants) + [title]) if space else title
        cand = CONF_OUTPUT_DIR / rel_conf / "content.md"
        content_md = str(cand) if cand.exists() else ""
        return Doc(
            doc_id=doc_id, kind="confluence", title=title,
            workbook=None, space=space,
            path=path_display, summary=one_line, key_terms=key_terms,
            summary_md_path=str(path), content_md_path=content_md,
        )


def build_index() -> list[Doc]:
    """인덱스 빌드 (한 번만 실행, 이후 cache).

    중복 dedup: 같은 (kind, workbook/space, title) 가 2-level + 3-level 양쪽에 있으면
    더 풍부한 path (3-level) 또는 더 긴 summary 를 가진 것 우선.
    """
    global _INDEX, _INDEX_BUILT
    if _INDEX_BUILT:
        return _INDEX
    seen: dict[tuple, Doc] = {}
    for md in SUMMARIES_DIR.rglob("*.md"):
        d = _parse_summary_md(md)
        if not d:
            continue
        key = (d.kind, d.workbook or d.space or "", d.title)
        existing = seen.get(key)
        if existing is None:
            seen[key] = d
            continue
        # 더 긴 path (= 카테고리 정보 포함) 또는 더 긴 summary 선호
        if (len(d.path) > len(existing.path)) or (
            len(d.path) == len(existing.path) and len(d.summary) > len(existing.summary)
        ):
            seen[key] = d
    _INDEX = list(seen.values())
    _INDEX_BUILT = True
    _build_reverse_lookups(_INDEX)
    return _INDEX


# ── Reverse lookup for vector strategy (chunk metadata → Doc) ─────────────

_DOC_BY_WORKBOOK_SHEET: dict[tuple[str, str], Doc] = {}
_DOC_BY_CONTENT_PATH: dict[str, Doc] = {}


def _build_reverse_lookups(docs: list[Doc]):
    global _DOC_BY_WORKBOOK_SHEET, _DOC_BY_CONTENT_PATH
    _DOC_BY_WORKBOOK_SHEET = {
        (d.workbook, d.title): d for d in docs if d.kind == "xlsx" and d.workbook
    }
    _DOC_BY_CONTENT_PATH = {
        d.content_md_path: d for d in docs if d.content_md_path
    }


def _chunk_to_doc(meta: dict) -> Doc | None:
    """ChromaDB chunk metadata → Doc 매핑."""
    sp = meta.get("source_path", "")
    # confluence: source_path 정확 매칭
    if "confluence-downloader" in sp:
        d = _DOC_BY_CONTENT_PATH.get(sp)
        if d:
            return d
    # xlsx: (workbook, sheet) 매칭
    wb, sh = meta.get("workbook"), meta.get("sheet")
    if wb and sh:
        d = _DOC_BY_WORKBOOK_SHEET.get((wb, sh))
        if d:
            return d
    # fallback: source_path
    return _DOC_BY_CONTENT_PATH.get(sp)


# ── Phase 1: substring/key_term 매칭 ───────────────────────────────────────

@dataclass
class Candidate:
    doc: Doc
    score: float
    matched_via: str          # "title_prefix" | "title_substring" | "key_term" | "path" | "summary" | "workbook"
    matched_text: str = ""    # 디버그/배지용


def _score_substring(query: str, doc: Doc) -> tuple[float, str, str]:
    """주어진 doc 에 대한 (score, matched_via, matched_text). 매칭 없으면 (0, '', '')."""
    q = query.lower().strip()
    if not q:
        return 0.0, "", ""
    title_l = doc.title.lower()
    workbook_l = (doc.workbook or "").lower()
    space_l = (doc.space or "").lower()
    path_l = doc.path.lower()
    summary_l = doc.summary.lower()
    key_terms_l = [t.lower() for t in doc.key_terms]

    # 점수 우선순위 — 워크북/title (구조적 매칭) 가 key_term/path/summary 보다 높음.
    # workbook_substring 을 0.75 → 0.88 로 올려 key_term_exact (0.80) 보다 위에 둠.
    # 이유: "분해" / "미니맵" / "골드" 같은 직역 query 가 wrong workbook 의 key_term 에
    # 우선 잡혀 fail 한 케이스 다수 (100 case eval 의 약 5건).

    # 1. title 정확 매칭
    if title_l == q:
        return 1.0, "title_exact", doc.title
    # 2. title prefix
    if title_l.startswith(q):
        return 0.95, "title_prefix", doc.title
    # 3. workbook/space 정확 매칭 (워크북 명이 query 와 동일)
    if q in workbook_l.split() or q == workbook_l:
        return 0.95, "workbook_exact", doc.workbook or ""
    # 4. workbook substring (워크북 명에 query 가 들어감) — bumped from 0.75 → 0.88
    if workbook_l and q in workbook_l:
        return 0.88, "workbook_substring", doc.workbook or ""
    # 5. title substring
    if q in title_l:
        return 0.85, "title_substring", doc.title
    # 6. space 정확/부분
    if space_l and q in space_l:
        return 0.82, "space_substring", doc.space or ""
    # 7. key_term 정확
    for kt, ktl in zip(doc.key_terms, key_terms_l):
        if ktl == q:
            return 0.80, "key_term_exact", kt
    # 8. key_term substring
    for kt, ktl in zip(doc.key_terms, key_terms_l):
        if q in ktl:
            return 0.65, "key_term_substring", kt
    # 9. path substring (파일경로)
    if q in path_l:
        return 0.55, "path_substring", doc.path
    # 10. summary substring
    if q in summary_l:
        return 0.40, "summary_substring", (doc.summary[:80] + "...") if len(doc.summary) > 80 else doc.summary
    return 0.0, "", ""


def search_substring(query: str, docs: list[Doc], kinds: list[str] | None = None,
                     limit: int = 50) -> list[Candidate]:
    """Phase 1 — substring/key_term 기반 후보 추출.

    한 query 가 여러 단어이면 단어별 점수 합산 (단순 OR).
    """
    tokens = [t for t in re.split(r"\s+", query.strip()) if t]
    if not tokens:
        return []
    out: list[Candidate] = []
    for d in docs:
        if kinds and d.kind not in kinds:
            continue
        best_score = 0.0
        best_via = ""
        best_text = ""
        for tok in tokens:
            s, via, txt = _score_substring(tok, d)
            if s > best_score:
                best_score = s
                best_via = via
                best_text = txt
        # 멀티 토큰 매칭 부스트 — 토큰 모두가 어딘가 매칭되면 +0.05
        if len(tokens) > 1:
            all_matched = all(_score_substring(t, d)[0] > 0 for t in tokens)
            if all_matched:
                best_score = min(1.0, best_score + 0.05)
        if best_score > 0:
            out.append(Candidate(doc=d, score=best_score, matched_via=best_via, matched_text=best_text))
    out.sort(key=lambda c: -c.score)
    return out[:limit]


# ── Phase 2: Haiku rerank stream ──────────────────────────────────────────

def _format_candidates_for_haiku(candidates: list[Candidate], max_n: int = 30) -> str:
    """Haiku 입력용 — 각 후보를 [doc_id] title — workbook/space — summary 한 줄."""
    lines: list[str] = []
    for i, c in enumerate(candidates[:max_n], 1):
        d = c.doc
        loc = d.workbook or d.space or "?"
        summary = d.summary[:120].replace("\n", " ")
        lines.append(f"[{d.doc_id}] [{d.kind}] {d.title} — {loc} — {summary}")
    return "\n".join(lines)


_HAIKU_SYSTEM = """You rank Project K planning documents by relevance to a short user query.

The user is a game designer searching for the most relevant doc to OPEN.
Output ranked doc_ids, MOST RELEVANT FIRST, one per line.
Format each line EXACTLY as: <doc_id>
Do NOT add explanation, numbers, or any other text — JUST the doc_id per line.
Stop after at most 10 lines, OR earlier if no more candidates are clearly relevant.

Relevance heuristic:
- A doc that is ABOUT the query (title/workbook directly matches) ranks highest.
- A doc where the query appears as a SUB-CONCEPT ranks medium.
- A doc that only tangentially mentions the query ranks low — usually exclude.
- Korean synonyms count (e.g. "치명타" = "크리티컬", "오토" = "AUTO" = "자동").
"""


def _parse_doc_id_line(line: str) -> str | None:
    s = line.strip()
    if not s or s.upper() == "END":
        return None
    # 가능한 변형 — "1. xlsx::...", "- xlsx::...", "[xlsx::...]" 등 모두 보정
    s = s.lstrip("0123456789.) -*").strip()
    s = s.strip("[]").strip()
    if "::" in s:
        return s
    return None


# ── Titan v2 임베딩 + ChromaDB (vector strategy) ──────────────────────────

_CHROMA_COLL = None  # lazy init


def _get_chroma_collection():
    """ChromaDB collection lazy init. 실패 시 None (vector strategy 가 graceful fail)."""
    global _CHROMA_COLL
    if _CHROMA_COLL is not None:
        return _CHROMA_COLL
    try:
        import chromadb  # type: ignore
        path = os.path.expanduser("~/.qna-poc-chroma")
        client = chromadb.PersistentClient(path=path)
        _CHROMA_COLL = client.get_collection("project_k")
    except Exception:
        return None
    return _CHROMA_COLL


async def _titan_embed_async(text: str, *, timeout: float = 15.0) -> list[float] | None:
    """Bedrock Titan v2 임베딩 (1024d, normalized). 실패 시 None."""
    region = os.environ.get("AWS_REGION", "us-east-1")
    tok = os.environ.get("AWS_BEARER_TOKEN_BEDROCK", "")
    if not tok:
        return None
    url = (
        f"https://bedrock-runtime.{region}.amazonaws.com"
        f"/model/amazon.titan-embed-text-v2:0/invoke"
    )
    headers = {
        "Authorization": f"Bearer {tok}",
        "Content-Type": "application/json",
    }
    body = {"inputText": text, "dimensions": 1024, "normalize": True}
    try:
        async with httpx.AsyncClient(timeout=timeout) as c:
            r = await c.post(url, headers=headers, json=body)
        if r.status_code != 200:
            return None
        j = r.json()
        emb = j.get("embedding")
        if emb:
            return emb
        embs = j.get("embeddings")
        if embs and len(embs) > 0:
            return embs[0]
    except Exception:
        return None
    return None


# ── Strategy 1: L1 only (no LLM) ──────────────────────────────────────────

async def strategy_l1(
    query: str, limit: int, kinds: list[str] | None, **_kw
) -> AsyncIterator[dict]:
    """L1 메타 어휘 매칭 only — substring 점수 정렬, LLM 0회."""
    t0 = time.time()
    docs = build_index()
    yield {"type": "status", "message": f"📚 인덱스 {len(docs):,}건"}

    t1 = time.time()
    candidates = search_substring(query, docs, kinds=kinds, limit=50)
    phase1_ms = int((time.time() - t1) * 1000)

    by_via: dict[str, int] = {}
    for c in candidates:
        by_via[c.matched_via] = by_via.get(c.matched_via, 0) + 1
    via_summary = ", ".join(f"{k}={v}" for k, v in sorted(by_via.items(), key=lambda x: -x[1])[:5])
    yield {
        "type": "status",
        "message": f"🔍 L1 substring → {len(candidates)}건 ({phase1_ms}ms) [{via_summary}]",
        "phase1_layers": by_via,
    }

    if not candidates:
        yield {"type": "result", "data": {"total": 0, "latency_ms": int((time.time() - t0) * 1000),
                                          "strategy": "l1", "phase1_layers": by_via}}
        return

    for i, c in enumerate(candidates[:limit], 1):
        yield {"type": "hit", "data": _hit_payload(c, source="l1", rank=i)}

    yield {
        "type": "result",
        "data": {
            "total": min(len(candidates), limit),
            "latency_ms": int((time.time() - t0) * 1000),
            "phase1_ms": phase1_ms,
            "strategy": "l1",
            "phase1_candidates": len(candidates),
            "phase1_layers": by_via,
        },
    }


# ── Strategy 2: L1 + Haiku Rerank (current default) ───────────────────────

async def strategy_haiku_rerank(
    query: str, limit: int, kinds: list[str] | None, model: str = "haiku", **_kw
) -> AsyncIterator[dict]:
    """L1 후보 top 20 을 Haiku 가 의미 기준으로 재정렬."""
    t0 = time.time()
    docs = build_index()
    yield {"type": "status", "message": f"📚 인덱스 {len(docs):,}건"}

    t1 = time.time()
    candidates = search_substring(query, docs, kinds=kinds, limit=50)
    phase1_ms = int((time.time() - t1) * 1000)

    by_via: dict[str, int] = {}
    for c in candidates:
        by_via[c.matched_via] = by_via.get(c.matched_via, 0) + 1
    via_summary = ", ".join(f"{k}={v}" for k, v in sorted(by_via.items(), key=lambda x: -x[1])[:5])
    yield {
        "type": "status",
        "message": f"🔍 L1 → {len(candidates)}건 ({phase1_ms}ms) [{via_summary}]",
        "phase1_layers": by_via,
    }

    if not candidates:
        yield {"type": "result", "data": {"total": 0, "latency_ms": int((time.time() - t0) * 1000),
                                          "strategy": "haiku_rerank", "phase1_layers": by_via}}
        return

    t2 = time.time()
    haiku_n = min(len(candidates), 20)
    yield {"type": "status", "message": f"🤖 R-Haiku top {haiku_n} 정렬 중..."}

    user_msg = (
        f"Query: {query}\n\n"
        f"Candidates ({haiku_n}):\n"
        f"{_format_candidates_for_haiku(candidates, max_n=haiku_n)}\n\n"
        f"Output ranked doc_ids (most relevant first, max {limit} lines):"
    )
    cand_by_id = {c.doc.doc_id: c for c in candidates}
    yielded_ids: set[str] = set()
    haiku_buf = ""
    yielded_count = 0

    try:
        async for ev in stream_messages(
            messages=[{"role": "user", "content": user_msg}],
            system=_HAIKU_SYSTEM,
            model=normalize_model(model),
            max_tokens=600, temperature=0.0, timeout=20.0,
        ):
            if ev.get("type") != "content_block_delta":
                continue
            delta = ev.get("delta", {})
            if delta.get("type") != "text_delta":
                continue
            haiku_buf += delta.get("text", "")
            while "\n" in haiku_buf:
                line, haiku_buf = haiku_buf.split("\n", 1)
                doc_id = _parse_doc_id_line(line)
                if not doc_id or doc_id in yielded_ids or doc_id not in cand_by_id:
                    continue
                c = cand_by_id[doc_id]
                yielded_ids.add(doc_id)
                yielded_count += 1
                yield {"type": "hit", "data": _hit_payload(c, source="haiku", rank=yielded_count)}
                if yielded_count >= limit:
                    break
            if yielded_count >= limit:
                break
        if yielded_count < limit and haiku_buf.strip():
            doc_id = _parse_doc_id_line(haiku_buf)
            if doc_id and doc_id not in yielded_ids and doc_id in cand_by_id:
                c = cand_by_id[doc_id]
                yielded_count += 1
                yield {"type": "hit", "data": _hit_payload(c, source="haiku", rank=yielded_count)}
    except BedrockStreamError as e:
        yield {"type": "status", "message": f"⚠️ Haiku 실패, L1 fallback: {e}"}
        for c in candidates[:max(0, limit - yielded_count)]:
            if c.doc.doc_id in yielded_ids:
                continue
            yielded_count += 1
            yield {"type": "hit", "data": _hit_payload(c, source="haiku_fallback", rank=yielded_count)}
    except Exception as e:
        yield {"type": "error", "message": f"unexpected: {e}"}
        return

    phase2_ms = int((time.time() - t2) * 1000)
    yield {
        "type": "result",
        "data": {
            "total": yielded_count, "latency_ms": int((time.time() - t0) * 1000),
            "phase1_ms": phase1_ms, "phase2_ms": phase2_ms, "model": model,
            "strategy": "haiku_rerank",
            "phase1_candidates": len(candidates), "phase1_layers": by_via,
        },
    }


# ── Strategy 3: Haiku Query Expansion → L1 ────────────────────────────────

_EXPAND_SYSTEM = """You expand a short Korean user query into 3~6 related KEYWORDS that would help search Project K (mobile MMORPG) planning documents (Excel/Confluence).

Output rules:
- Output ONLY keywords, ONE per line.
- Korean keywords. Single words or short phrases (2~4 chars typical).
- Include the original query as one of the keywords.
- Include synonyms (치명타↔크리티컬, 오토↔자동, 키우다↔성장/레벨업/강화).
- Include closely related concepts (변신 → 스킬, 합성, 강화).
- NO explanation, NO numbering, NO bullets — just keywords on separate lines.
- Stop at 6 keywords max.
"""


async def _haiku_expand_keywords(query: str, *, model: str = "haiku") -> list[str]:
    """Haiku 한 번 호출해서 query → 키워드 리스트. 실패 시 [query] 만 반환."""
    user_msg = f"Query: {query}\n\nOutput related keywords (one per line):"
    out: list[str] = []
    try:
        async for ev in stream_messages(
            messages=[{"role": "user", "content": user_msg}],
            system=_EXPAND_SYSTEM,
            model=normalize_model(model),
            max_tokens=200, temperature=0.0, timeout=15.0,
        ):
            if ev.get("type") != "content_block_delta":
                continue
            delta = ev.get("delta", {})
            if delta.get("type") == "text_delta":
                out.append(delta.get("text", ""))
    except Exception:
        return [query]

    text = "".join(out)
    keywords: list[str] = []
    for line in text.splitlines():
        s = line.strip().lstrip("-*0123456789. )").strip()
        if not s or len(s) > 30:
            continue
        if s.upper() == "END":
            break
        if s not in keywords:
            keywords.append(s)
    if query not in keywords:
        keywords.insert(0, query)
    return keywords[:6]


async def strategy_haiku_expand(
    query: str, limit: int, kinds: list[str] | None, model: str = "haiku", **_kw
) -> AsyncIterator[dict]:
    """Haiku 가 query → 동의어/관련어 확장 → 각 키워드로 L1 → score 합산.

    Haiku 는 검색 시작 전에 1회만 호출 (rerank 대신 expand 에 활용).
    """
    t0 = time.time()
    docs = build_index()
    yield {"type": "status", "message": f"📚 인덱스 {len(docs):,}건"}

    # Phase A: Haiku expand
    t_exp = time.time()
    keywords = await _haiku_expand_keywords(query, model=model)
    expand_ms = int((time.time() - t_exp) * 1000)
    yield {
        "type": "status",
        "message": f"🔮 E-Haiku 확장 → {len(keywords)}개 ({expand_ms}ms): {' | '.join(keywords)}",
        "expanded_keywords": keywords,
    }

    # Phase B: L1 with each keyword, merge by max score
    t_l1 = time.time()
    merged: dict[str, Candidate] = {}  # doc_id → best Candidate
    layer_total: dict[str, int] = {}
    for kw in keywords:
        cands = search_substring(kw, docs, kinds=kinds, limit=30)
        for c in cands:
            existing = merged.get(c.doc.doc_id)
            if existing is None or c.score > existing.score:
                # 매칭된 키워드도 기록
                c.matched_text = f"{c.matched_text} (kw={kw})" if c.matched_text else f"kw={kw}"
                merged[c.doc.doc_id] = c
            layer_total[c.matched_via] = layer_total.get(c.matched_via, 0) + 1
    candidates = sorted(merged.values(), key=lambda c: -c.score)[:limit * 3]
    l1_ms = int((time.time() - t_l1) * 1000)

    yield {
        "type": "status",
        "message": f"🔍 L1×{len(keywords)} → {len(candidates)}건 unique ({l1_ms}ms)",
        "phase1_layers": layer_total,
    }

    if not candidates:
        yield {"type": "result", "data": {"total": 0, "latency_ms": int((time.time() - t0) * 1000),
                                          "strategy": "haiku_expand"}}
        return

    for i, c in enumerate(candidates[:limit], 1):
        yield {"type": "hit", "data": _hit_payload(c, source="haiku_expand", rank=i)}

    yield {
        "type": "result",
        "data": {
            "total": min(len(candidates), limit),
            "latency_ms": int((time.time() - t0) * 1000),
            "expand_ms": expand_ms,
            "l1_ms": l1_ms,
            "model": model,
            "strategy": "haiku_expand",
            "phase1_candidates": len(candidates),
            "expanded_keywords": keywords,
            "phase1_layers": layer_total,
        },
    }


# ── Strategy 4: Vector (Titan + ChromaDB) ─────────────────────────────────

async def strategy_vector(
    query: str, limit: int, kinds: list[str] | None, **_kw
) -> AsyncIterator[dict]:
    """Titan v2 임베딩 + ChromaDB 코사인 유사도. LLM 0회 (임베딩만)."""
    t0 = time.time()
    docs = build_index()  # reverse lookup 빌드용
    yield {"type": "status", "message": f"📚 인덱스 {len(docs):,}건 (chunk 매핑용)"}

    # Step 1: ChromaDB 접근
    coll = _get_chroma_collection()
    if coll is None:
        yield {"type": "error", "message": "ChromaDB unavailable (collection 'project_k' not found)"}
        return

    # Step 2: Titan embedding
    t_emb = time.time()
    emb = await _titan_embed_async(query)
    emb_ms = int((time.time() - t_emb) * 1000)
    if emb is None:
        yield {"type": "error", "message": "Titan embedding 실패"}
        return
    yield {"type": "status", "message": f"🧬 Titan v2 embed ({emb_ms}ms, 1024d)"}

    # Step 3: ChromaDB query
    t_q = time.time()
    try:
        # n_results 크게 받아서 doc 단위 dedup 후 자름
        n_chunks = min(50, coll.count())
        results = coll.query(
            query_embeddings=[emb],
            n_results=n_chunks,
            include=["metadatas", "distances"],
        )
    except Exception as e:
        yield {"type": "error", "message": f"ChromaDB query 실패: {e}"}
        return
    q_ms = int((time.time() - t_q) * 1000)

    metadatas = (results.get("metadatas") or [[]])[0]
    distances = (results.get("distances") or [[]])[0]

    yield {"type": "status", "message": f"🔎 vector top {len(metadatas)} chunk ({q_ms}ms) → doc 단위 그룹"}

    # Step 4: chunk → Doc 매핑 + (workbook,sheet) / (page) 단위 그룹화
    by_doc: dict[str, tuple[Doc, float, str]] = {}  # doc_id → (doc, best_distance, section_path)
    unmapped = 0
    for meta, dist in zip(metadatas, distances):
        d = _chunk_to_doc(meta)
        if d is None:
            unmapped += 1
            continue
        # kind filter
        if kinds and d.kind not in kinds:
            continue
        existing = by_doc.get(d.doc_id)
        if existing is None or dist < existing[1]:
            by_doc[d.doc_id] = (d, dist, meta.get("section_path", ""))

    # distance ↑ 좋음 — 작을수록 가까움 (cosine distance). score = 1 - distance.
    grouped = sorted(by_doc.values(), key=lambda t: t[1])

    if not grouped:
        yield {
            "type": "status",
            "message": f"⚠️ vector hits {len(metadatas)} chunk 모두 doc 매핑 실패 (unmapped={unmapped})",
        }
        yield {"type": "result", "data": {"total": 0, "latency_ms": int((time.time() - t0) * 1000),
                                          "strategy": "vector", "unmapped": unmapped}}
        return

    for i, (d, dist, sec) in enumerate(grouped[:limit], 1):
        score = max(0.0, 1.0 - float(dist))
        c = Candidate(doc=d, score=score, matched_via="vector_cosine", matched_text=f"section={sec[:60]}")
        yield {"type": "hit", "data": _hit_payload(c, source="vector", rank=i)}

    yield {
        "type": "result",
        "data": {
            "total": min(len(grouped), limit),
            "latency_ms": int((time.time() - t0) * 1000),
            "embed_ms": emb_ms,
            "chroma_query_ms": q_ms,
            "strategy": "vector",
            "vector_chunks": len(metadatas),
            "vector_unique_docs": len(by_doc),
            "unmapped_chunks": unmapped,
        },
    }


# ── Strategy 5: Parallel L1 + Vector (둘 다 무료/빠름, 결과 모두 노출) ────

async def strategy_parallel(
    query: str, limit: int, kinds: list[str] | None, **_kw
) -> AsyncIterator[dict]:
    """L1 + Vector 동시 실행. 두 결과 셋을 각자 source 라벨로 stream.

    UX 의도: frontend 가 두 결과를 별도 섹션 (예: "키워드 매칭" / "의미 검색") 으로
    렌더링. 사용자가 토글로 골라 볼 수 있도록 hit 의 `source` 필드 사용.

    L1 (~30ms) 가 먼저 yield → Vector (~300ms) 가 이어서 yield. 총 latency ~ Vector.
    """
    t0 = time.time()
    docs = build_index()
    yield {"type": "status", "message": f"📚 인덱스 {len(docs):,}건 (parallel L1+Vector)"}

    # ── L1 (sync, 빠름) — Vector embed 와 병렬로 launch ──
    async def _l1():
        return search_substring(query, docs, kinds=kinds, limit=limit)

    async def _vector():
        coll = _get_chroma_collection()
        if coll is None:
            return None, "ChromaDB unavailable"
        emb = await _titan_embed_async(query)
        if emb is None:
            return None, "Titan embed failed"
        try:
            results = coll.query(
                query_embeddings=[emb],
                n_results=min(50, coll.count()),
                include=["metadatas", "distances"],
            )
            return results, None
        except Exception as e:
            return None, f"Chroma query failed: {e}"

    # 병렬 실행
    l1_task = asyncio.create_task(_l1())
    vec_task = asyncio.create_task(_vector())

    # ── L1 결과 먼저 (보통 더 빠름) ──
    l1_candidates = await l1_task
    l1_ms = int((time.time() - t0) * 1000)
    by_via: dict[str, int] = {}
    for c in l1_candidates:
        by_via[c.matched_via] = by_via.get(c.matched_via, 0) + 1
    via_summary = ", ".join(f"{k}={v}" for k, v in sorted(by_via.items(), key=lambda x: -x[1])[:4])
    yield {
        "type": "status",
        "message": f"⚡ L1 → {len(l1_candidates)}건 ({l1_ms}ms) [{via_summary}]",
        "phase1_layers": by_via,
    }

    l1_yielded_ids: set[str] = set()
    for i, c in enumerate(l1_candidates[:limit], 1):
        l1_yielded_ids.add(c.doc.doc_id)
        payload = _hit_payload(c, source="l1", rank=i)
        payload["source"] = "l1"   # top-level easy access
        yield {"type": "hit", "data": payload}

    # ── Vector 결과 ──
    vec_results, vec_err = await vec_task
    if vec_err:
        yield {"type": "status", "message": f"⚠️ Vector 실패: {vec_err}"}
        yield {
            "type": "result",
            "data": {
                "total": len(l1_yielded_ids),
                "latency_ms": int((time.time() - t0) * 1000),
                "strategy": "parallel",
                "sources": ["l1"],
                "l1_count": len(l1_yielded_ids),
                "vector_count": 0,
                "phase1_layers": by_via,
                "vector_error": vec_err,
            },
        }
        return

    metadatas = (vec_results.get("metadatas") or [[]])[0]
    distances = (vec_results.get("distances") or [[]])[0]
    by_doc: dict[str, tuple[Doc, float, str]] = {}
    unmapped = 0
    for meta, dist in zip(metadatas, distances):
        d = _chunk_to_doc(meta)
        if d is None:
            unmapped += 1
            continue
        if kinds and d.kind not in kinds:
            continue
        existing = by_doc.get(d.doc_id)
        if existing is None or dist < existing[1]:
            by_doc[d.doc_id] = (d, dist, meta.get("section_path", ""))

    grouped = sorted(by_doc.values(), key=lambda t: t[1])
    vec_total_ms = int((time.time() - t0) * 1000)
    yield {
        "type": "status",
        "message": f"🧬 Vector → {len(grouped)}건 unique ({vec_total_ms - l1_ms}ms after L1)",
    }

    vec_yielded = 0
    for d, dist, sec in grouped:
        if vec_yielded >= limit:
            break
        # L1 에서 이미 같은 doc 나왔으면 source=both 로 표시 (정보 가치)
        score = max(0.0, 1.0 - float(dist))
        c = Candidate(doc=d, score=score, matched_via="vector_cosine", matched_text=f"section={sec[:60]}")
        payload = _hit_payload(c, source="vector", rank=vec_yielded + 1)
        if d.doc_id in l1_yielded_ids:
            payload["source"] = "both"   # L1 + Vector 모두에서 hit
            payload["l1_also"] = True
        else:
            payload["source"] = "vector"
            payload["l1_also"] = False
        vec_yielded += 1
        yield {"type": "hit", "data": payload}

    total_ms = int((time.time() - t0) * 1000)
    overlap = sum(1 for _, _, _ in grouped[:limit] if _ in [g for g, _, _ in grouped[:limit]])  # placeholder
    overlap_count = sum(1 for d, _, _ in grouped[:limit] if d.doc_id in l1_yielded_ids)
    yield {
        "type": "result",
        "data": {
            "total": len(l1_yielded_ids) + vec_yielded,
            "latency_ms": total_ms,
            "l1_ms": l1_ms,
            "vector_ms": total_ms - l1_ms,
            "strategy": "parallel",
            "sources": ["l1", "vector"],
            "l1_count": len(l1_yielded_ids),
            "vector_count": vec_yielded,
            "overlap_count": overlap_count,
            "phase1_layers": by_via,
            "vector_unique_docs": len(by_doc),
            "vector_unmapped_chunks": unmapped,
        },
    }


# ── Strategy 6: Auto-router (Haiku 가 strategy 를 선택) ──────────────────

_ROUTER_SYSTEM = """You are a search-strategy router for Project K (mobile MMORPG planning docs).

Given a short Korean user query, choose the best search strategy from these 4:

- **l1** : Pure keyword substring match (no LLM). Best for short proper nouns / region names / exact direct keywords where the user clearly means a specific name. Examples: 바리울, 셀레탄, 동대륙, 던전 리스트.
- **vector** : Semantic similarity via embedding. Best DEFAULT for most queries — system names, mechanics, concepts, features, technical terms that appear in formal planning docs. Examples: 변신, 레벨업, 물약, 분해, 크리티컬, 쿨타임, 전투 HUD, 공격력, 회피.
- **haiku_expand** : Query expansion to synonyms+related terms, then keyword search. Best for vague NATURAL LANGUAGE queries with particles, sentence-like form, or "how/what" questions. Examples: 캐릭터 키우는 법, 보스 잡는 법, 어떻게 강해지나, 뭐가 좋아.
- **haiku_rerank** : Semantic rerank of substring candidates. Best for queries that are likely COLLOQUIAL/SLANG synonyms of canonical doc terms (where docs use formal term but user uses casual term).

## 한국어 게임 도메인 동의어 사전 (haiku_rerank 시그널)

다음 매핑에서 LEFT (사용자가 입력) 가 등장하면 haiku_rerank 우선 — 정식 문서엔 RIGHT 표현이 쓰일 가능성:

전투 / 스탯:
- 치명타 ↔ 크리티컬 / Critical
- 깡뎀 / 깡공 ↔ 공격력 / 기본 공격력
- 깡방 ↔ 방어력
- 옵션 ↔ 능력치 / 스탯
- 회피율 ↔ 회피 (그 반대도)
- 명중률 ↔ 명중

행동 / 시스템:
- 오토 ↔ 자동 / 자동전투
- 잡몹 ↔ 일반 몬스터
- 풀템 ↔ 모든 장비
- 키우다 ↔ 성장 / 강화 / 레벨업
- 잡다 ↔ 처치 / 사냥
- 죽다 / 죽음 ↔ 사망 / 부활
- 깎이다 ↔ 감소

아이템 / 보상:
- 룬 ↔ 보석 / 마법석
- 영걸 ↔ 영웅 / 신화
- 일반템 ↔ 일반 등급 / 노말
- 보상 ↔ 드랍 / 획득

장비 / 슬롯:
- 칸 ↔ 슬롯
- 무기 / 방어구 ↔ 장비

NPC / 컨텐츠:
- 보스 ↔ Boss / 네임드 / 우두머리
- 펫 ↔ 동반자 / 소환수

판단이 애매하면 haiku_rerank 보다 vector 가 안전한 기본값.

## 결정 우선순위 (순서대로)

1. **Natural language sentence** — 조사/어미 ("법", "어떻게", "는 법", "다", "어떤") + 2 어절 이상 → **haiku_expand**
2. **Colloquial synonym** — 위 동의어 사전의 LEFT 표현이 query 에 명확히 등장 → **haiku_rerank**
3. **Region / proper noun** — 짧고 (1~2 어절), 분명히 고유명사·특정 페이지를 가리킴 → **l1**
4. **Default** — system/mechanic/concept/일반 키워드 → **vector**

## Output rules — STRICT

- Line 1: strategy name, EXACTLY one of: l1, vector, haiku_expand, haiku_rerank.
- Line 2: one short Korean reason (≤ 25 chars).
- NO other text, NO numbering, NO markdown.

## 예시

Query: 변신
vector
시스템 직역, 의미 매칭

Query: 치명타
haiku_rerank
크리티컬 동의어 가능성

Query: 캐릭터 키우는 법
haiku_expand
자연어 + "법" 어미

Query: 바리울
l1
지역 고유명사 직접 매칭

Query: 깡뎀
haiku_rerank
공격력 동의어 (slang)

Query: 보스 잡는 법
haiku_expand
자연어 how 질문

Query: 쿨타임
vector
메카닉 키워드
"""


async def _haiku_route(query: str, *, model: str = "haiku", timeout: float = 8.0) -> tuple[str, str, int]:
    """Haiku router 호출. (strategy, reason, latency_ms) 반환. 실패 시 vector default.
    """
    t0 = time.time()
    user_msg = f"Query: {query}\n\nChoose strategy:"
    out_parts: list[str] = []
    try:
        async for ev in stream_messages(
            messages=[{"role": "user", "content": user_msg}],
            system=_ROUTER_SYSTEM,
            model=normalize_model(model),
            max_tokens=80, temperature=0.0, timeout=timeout,
        ):
            if ev.get("type") != "content_block_delta":
                continue
            delta = ev.get("delta", {})
            if delta.get("type") == "text_delta":
                out_parts.append(delta.get("text", ""))
    except Exception:
        return "vector", "fallback (haiku error)", int((time.time() - t0) * 1000)

    text = "".join(out_parts).strip()
    lines = [ln.strip() for ln in text.splitlines() if ln.strip()]
    if not lines:
        return "vector", "fallback (empty)", int((time.time() - t0) * 1000)
    chosen = lines[0].lower().strip(".,;: ")
    reason = lines[1] if len(lines) > 1 else ""
    if chosen not in {"l1", "vector", "haiku_expand", "haiku_rerank"}:
        # Haiku 가 자연어로 길게 쓴 경우 — substring 으로 detect
        for k in ("haiku_expand", "haiku_rerank", "vector", "l1"):
            if k in chosen:
                chosen = k
                break
        else:
            chosen = "vector"
            reason = f"unparsed → vector ({lines[0][:20]})"
    return chosen, reason, int((time.time() - t0) * 1000)


_NATURAL_LANG_PATTERN = re.compile(
    r"(법|방법|어떻게|어떤|뭐가|뭐|어디|왜|할까|하는|되나|되는|보이는|만드는|키우는|올리는|잡는|쓰는|되어|이에|있나)$"
    r"|(다\.|까\?|요\.)\s*$"
)


def _is_natural_language(query: str) -> bool:
    """자연어 모호 query 감지 — token ≥ 3 또는 한국어 어미·"법"·"방법" 패턴.

    이런 query 는 표면 substring 매칭이 wrong workbook 을 confident 하게 잡을 수 있어,
    Phase 1 score 가 아무리 높아도 expand 강제 발동.
    """
    s = query.strip()
    if len(s.split()) >= 3:
        return True
    if _NATURAL_LANG_PATTERN.search(s):
        return True
    return False


async def strategy_auto(
    query: str, limit: int, kinds: list[str] | None, model: str = "haiku",
    *,
    # 기본값 — 100 case eval + 자연어 강제 expand 룰 적용 후
    score_l1_high: float = 0.80,
    score_vec_high: float = 0.35,
    min_high_hits: int = 1,
    overlap_threshold: int = 1,
    title_tier_threshold: int = 1,    # title_exact/prefix/workbook_exact 이 N 이상이면 강한 stop
    force_expand_natural: bool = True, # 자연어 query 는 무조건 expand
    **_kw,
) -> AsyncIterator[dict]:
    """Auto v2 — 3 phase agentic.

    Phase 1: L1 + Vector 병렬 실행 → 결과 즉시 stream
    Phase 2: confidence 평가 (high score 갯수, overlap)
    Phase 3 (조건부): 부족하면 Haiku expand → 동의어로 L1 추가 검색
    """
    t0 = time.time()
    docs = build_index()
    yield {"type": "status", "message": f"📚 인덱스 {len(docs):,}건 (auto v2)"}

    # ── Phase 1a: L1 + Vector 병렬 실행 ──
    async def _l1_run():
        return search_substring(query, docs, kinds=kinds, limit=20)

    async def _vec_run():
        coll = _get_chroma_collection()
        if coll is None:
            return []
        emb = await _titan_embed_async(query)
        if emb is None:
            return []
        try:
            results = coll.query(
                query_embeddings=[emb],
                n_results=min(50, coll.count()),
                include=["metadatas", "distances"],
            )
        except Exception:
            return []
        metadatas = (results.get("metadatas") or [[]])[0]
        distances = (results.get("distances") or [[]])[0]
        by_doc: dict[str, tuple[Doc, float, str]] = {}
        for meta, dist in zip(metadatas, distances):
            d = _chunk_to_doc(meta)
            if d is None:
                continue
            if kinds and d.kind not in kinds:
                continue
            existing = by_doc.get(d.doc_id)
            if existing is None or dist < existing[1]:
                by_doc[d.doc_id] = (d, dist, meta.get("section_path", ""))
        out: list[Candidate] = []
        for d, dist, sec in sorted(by_doc.values(), key=lambda t: t[1]):
            score = max(0.0, 1.0 - float(dist))
            out.append(Candidate(doc=d, score=score, matched_via="vector_cosine",
                                 matched_text=f"section={sec[:60]}"))
        return out

    l1_task = asyncio.create_task(_l1_run())
    vec_task = asyncio.create_task(_vec_run())

    # ── Phase 1b: L1 결과 먼저 stream (보통 더 빠름) ──
    l1_cands = await l1_task
    l1_ms = int((time.time() - t0) * 1000)
    by_via: dict[str, int] = {}
    for c in l1_cands:
        by_via[c.matched_via] = by_via.get(c.matched_via, 0) + 1
    yield {
        "type": "status",
        "message": f"⚡ L1 → {len(l1_cands)}건 ({l1_ms}ms) [top={l1_cands[0].score:.2f}]" if l1_cands else f"⚡ L1 → 0건 ({l1_ms}ms)",
        "phase1_layers": by_via,
    }

    yielded_ids: set[str] = set()
    rank = 0
    for c in l1_cands[:limit]:
        rank += 1
        yielded_ids.add(c.doc.doc_id)
        payload = _hit_payload(c, source="l1", rank=rank)
        payload["source"] = "l1"
        yield {"type": "hit", "data": payload}

    # ── Phase 1c: Vector 결과 stream ──
    vec_cands = await vec_task
    vec_ms = int((time.time() - t0) * 1000) - l1_ms
    yield {
        "type": "status",
        "message": f"🧬 Vector → {len(vec_cands)}건 ({vec_ms}ms)" + (
            f" [top={vec_cands[0].score:.2f}]" if vec_cands else ""
        ),
    }
    vec_unique_yielded = 0
    for c in vec_cands[:limit]:
        if c.doc.doc_id in yielded_ids:
            continue
        rank += 1
        yielded_ids.add(c.doc.doc_id)
        payload = _hit_payload(c, source="vector", rank=rank)
        payload["source"] = "vector"
        yield {"type": "hit", "data": payload}
        vec_unique_yielded += 1

    # ── Phase 2: confidence 평가 ──
    # title-tier strong matches (구조적 매칭) — wrong-but-high score 케이스 회피
    n_title_tier = sum(
        1 for c in l1_cands[:5]
        if c.matched_via in ("title_exact", "title_prefix", "workbook_exact")
    )
    n_high_l1 = sum(1 for c in l1_cands[:5] if c.score >= score_l1_high)
    n_high_vec = sum(1 for c in vec_cands[:5] if c.score >= score_vec_high)
    l1_top5_ids = {c.doc.doc_id for c in l1_cands[:5]}
    vec_top5_ids = {c.doc.doc_id for c in vec_cands[:5]}
    overlap = len(l1_top5_ids & vec_top5_ids)

    is_natural = _is_natural_language(query)

    signals = {
        "title_tier": n_title_tier,
        "l1_high": n_high_l1, "vec_high": n_high_vec, "overlap": overlap,
        "l1_count": len(l1_cands), "vec_count": len(vec_cands),
        "is_natural": is_natural,
    }

    # 자연어이면 strong signal (title-tier 또는 overlap≥2) 가 있어야만 stop.
    # 그 외는 기존 룰.
    if is_natural and force_expand_natural:
        sufficient = (
            n_title_tier >= title_tier_threshold
            or overlap >= 2  # 자연어는 overlap 도 더 빡빡 (≥2)
        )
    else:
        sufficient = (
            n_title_tier >= title_tier_threshold     # title 직접 매칭이 강한 시그널
            or overlap >= overlap_threshold
            or n_high_vec >= min_high_hits + 1       # vector 만으로 충분하려면 ≥ 2 (수정)
        )

    if sufficient:
        reason = []
        if n_title_tier >= title_tier_threshold:
            reason.append(f"title-tier {n_title_tier}≥{title_tier_threshold}")
        if overlap >= (2 if is_natural else overlap_threshold):
            reason.append(f"overlap {overlap}")
        if not is_natural and n_high_vec >= min_high_hits + 1:
            reason.append(f"Vec high {n_high_vec}")
        yield {
            "type": "status",
            "message": f"✅ Phase1 충분 — 종료 ({', '.join(reason)})",
            "confidence_signals": signals,
        }
        yield {
            "type": "result",
            "data": {
                "total": len(yielded_ids),
                "latency_ms": int((time.time() - t0) * 1000),
                "strategy": "auto_v2",
                "expanded": False,
                "confidence_signals": signals,
                "thresholds": {
                    "score_l1_high": score_l1_high, "score_vec_high": score_vec_high,
                    "min_high_hits": min_high_hits, "overlap_threshold": overlap_threshold,
                },
                "phase1_layers": by_via,
            },
        }
        return

    # ── Phase 3: Haiku expand ──
    why = []
    if is_natural:
        why.append(f"자연어 query (force_expand)")
    if n_title_tier < title_tier_threshold:
        why.append(f"title-tier {n_title_tier}<{title_tier_threshold}")
    if overlap < overlap_threshold:
        why.append(f"overlap {overlap}<{overlap_threshold}")
    yield {
        "type": "status",
        "message": f"🔮 Phase1 부족 ({', '.join(why)}) → Haiku expand",
        "confidence_signals": signals,
    }

    t_exp = time.time()
    keywords = await _haiku_expand_keywords(query, model=model)
    expand_ms = int((time.time() - t_exp) * 1000)
    yield {
        "type": "status",
        "message": f"  → keywords: {' | '.join(keywords)} ({expand_ms}ms)",
        "expanded_keywords": keywords,
    }

    # 확장 키워드로 L1 추가 검색 (원본은 이미 했으니 skip)
    expand_pool: dict[str, Candidate] = {}
    for kw in keywords:
        if kw == query:
            continue
        cs = search_substring(kw, docs, kinds=kinds, limit=15)
        for c in cs:
            if c.doc.doc_id in yielded_ids:
                continue
            existing = expand_pool.get(c.doc.doc_id)
            if existing is None or c.score > existing.score:
                expand_pool[c.doc.doc_id] = c

    expand_sorted = sorted(expand_pool.values(), key=lambda c: -c.score)
    expand_yielded = 0
    for c in expand_sorted:
        if rank >= limit + 5:  # 확장은 limit 보다 약간 더 노출 가능
            break
        rank += 1
        yielded_ids.add(c.doc.doc_id)
        payload = _hit_payload(c, source="expand", rank=rank)
        payload["source"] = "expand"
        yield {"type": "hit", "data": payload}
        expand_yielded += 1

    yield {
        "type": "result",
        "data": {
            "total": len(yielded_ids),
            "latency_ms": int((time.time() - t0) * 1000),
            "strategy": "auto_v2",
            "expanded": True,
            "expand_yielded": expand_yielded,
            "expanded_keywords": keywords,
            "expand_ms": expand_ms,
            "confidence_signals": signals,
            "thresholds": {
                "score_l1_high": score_l1_high, "score_vec_high": score_vec_high,
                "min_high_hits": min_high_hits, "overlap_threshold": overlap_threshold,
            },
            "phase1_layers": by_via,
        },
    }


# ── Dispatcher ────────────────────────────────────────────────────────────

_STRATEGIES_INNER = {  # auto-router 가 호출할 수 있는 inner strategies
    "l1": strategy_l1,
    "haiku_rerank": strategy_haiku_rerank,
    "haiku_expand": strategy_haiku_expand,
    "vector": strategy_vector,
    "parallel": strategy_parallel,
}

_STRATEGIES = {
    **_STRATEGIES_INNER,
    "auto": strategy_auto,
}


async def quick_find_stream(
    query: str,
    limit: int = 10,
    kinds: list[str] | None = None,
    model: str = "haiku",
    *,
    strategy: str = "auto",
    skip_rerank: bool = False,
    # auto v2 thresholds (tuning)
    score_l1_high: float | None = None,
    score_vec_high: float | None = None,
    min_high_hits: int | None = None,
    overlap_threshold: int | None = None,
) -> AsyncIterator[dict]:
    """Quick Find dispatcher."""
    if skip_rerank:
        strategy = "l1"
    fn = _STRATEGIES.get(strategy)
    if fn is None:
        yield {"type": "error", "message": f"unknown strategy: {strategy}. Use one of {list(_STRATEGIES)}"}
        return
    extra = {}
    for k, v in {
        "score_l1_high": score_l1_high,
        "score_vec_high": score_vec_high,
        "min_high_hits": min_high_hits,
        "overlap_threshold": overlap_threshold,
    }.items():
        if v is not None:
            extra[k] = v
    async for ev in fn(query=query, limit=limit, kinds=kinds, model=model, **extra):
        yield ev


def _hit_payload(c: Candidate, *, source: str, rank: int = 0) -> dict:
    d = c.doc
    return {
        "doc_id": d.doc_id,
        "type": d.kind,
        "title": d.title,
        "path": d.path,
        "workbook": d.workbook,
        "space": d.space,
        "summary": d.summary,
        "score": round(c.score, 3),
        "matched_via": c.matched_via,
        "matched_text": c.matched_text,
        "rerank_source": source,   # "haiku" | "phase1" | "phase1_fallback"
        "rank": rank,
        "content_md_path": d.content_md_path,
    }


# ── self-test (live Bedrock 필요) ────────────────────────────────────────

if __name__ == "__main__":
    import sys

    async def _main():
        q = sys.argv[1] if len(sys.argv) > 1 else "변신"
        limit = int(sys.argv[2]) if len(sys.argv) > 2 else 5
        print(f"--- Quick Find: {q!r}, limit={limit} ---")
        async for ev in quick_find_stream(q, limit=limit):
            t = ev.get("type")
            if t == "status":
                print(f"  [status] {ev['message']}")
            elif t == "hit":
                d = ev["data"]
                print(f"  [hit #{d.get('rank', 0)}] [{d['type']}] {d['title']}  "
                      f"(score={d['score']}, via={d['matched_via']}, src={d['rerank_source']})")
                print(f"          path: {d['path']}")
                if d["summary"]:
                    print(f"          summary: {d['summary'][:100]}")
            elif t == "result":
                d = ev["data"]
                print(f"\n  [DONE] total={d['total']}, "
                      f"phase1_ms={d.get('phase1_ms','?')}, phase2_ms={d.get('phase2_ms','?')}, "
                      f"total={d['latency_ms']}ms, candidates={d.get('phase1_candidates','?')}")
                print(f"         phase1_layers={d.get('phase1_layers')}")
            elif t == "error":
                print(f"  [ERROR] {ev['message']}")

    asyncio.run(_main())
