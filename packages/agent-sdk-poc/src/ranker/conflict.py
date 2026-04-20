"""Conflict Density 차원 — Stage 1 (재활용) + Stage 2 (Citations 기반 CoV).

Stage 1:
  기존 `qna-poc/eval/conflict_scan_latest.json`에서 시스템별 conflict를 추출해
  Evidence 리스트로 변환한다. LLM 호출 없음 (재활용).
  주의: 이때의 cited_text는 이전 스캔의 LLM 요약(`excel_says`/`confluence_says`)이라
  원문 인용이 아니다. Stage 2에서 실제 원문 quote로 교체한다.

Stage 2 (CoV):
  각 시스템 단위로 Sonnet + documents(원본 content.md) + Citations 를 호출해
  Stage 1 evidence를 재검증한다. 산출:
    - verdict: confirmed / rejected / uncertain
    - cited_text: 실제 원문에서 뽑은 quote (Citations 결과)
    - final_confidence
  rejected 된 evidence는 제거, confirmed/uncertain은 cited_text·confidence 갱신 후 유지.
"""
from __future__ import annotations

import json
from dataclasses import asdict, dataclass, field
from typing import Any, Literal

from . import corpus, llm

Confidence = Literal["high", "medium", "low"]
Verdict = Literal["confirmed", "rejected", "uncertain"]


@dataclass
class ConflictEvidence:
    """Ranker conflict 차원 evidence (Stage 1/2 공통)."""

    id: str  # 고유 ID (예: "C-PK_HUD 시스템-0")
    system: str  # 평가 대상 시스템
    conflict_type: str  # 공식불일치 / 수치불일치 / 구조적차이 / 정보누락 / 버전불일치 / 폐기후보
    topic: str
    side: Literal["excel", "confluence"]  # evidence가 가리키는 출처
    cited_text: str  # Stage 1: 이전 스캔 요약. Stage 2: 원문 quote로 갱신.
    source: dict[str, Any]  # {kind, workbook, sheet?} 또는 {kind, space?, page_path}
    reason: str  # 왜 이게 conflict evidence인지
    confidence: Confidence
    severity: str  # critical / major / minor (스캔 원본)
    counterpart_side: Literal["excel", "confluence"]
    counterpart_summary: str  # 상대 측 요약 (Stage 2 재검증에 도움)
    verdict: Verdict | None = None
    verified_by_cov: bool = False
    raw_scan_record: dict[str, Any] | None = field(default=None, repr=False)


# ---- Stage 1: 재활용 -----------------------------------------------------

_SEVERITY_TO_CONFIDENCE: dict[str, Confidence] = {
    "critical": "high",
    "major": "medium",
    "minor": "low",
}


def collect_evidence(systems: list[str]) -> dict[str, list[ConflictEvidence]]:
    """Stage 1 — qna-poc conflict scan 재활용해 시스템별 Evidence 변환.

    LLM 호출 없음.
    """
    result: dict[str, list[ConflictEvidence]] = {}
    for sys_name in systems:
        analyses = corpus.system_conflicts(sys_name)
        bucket: list[ConflictEvidence] = []
        for analysis in analyses:
            conf_rel = analysis.get("confluence", "")
            comp = analysis.get("comparison", {})
            for idx, c in enumerate(comp.get("conflicts", [])):
                severity = str(c.get("severity", "minor"))
                topic = str(c.get("topic", "")).strip() or "(topic unspecified)"
                ctype = str(c.get("type", "")).strip() or "unknown"

                # Excel side
                if c.get("excel_says"):
                    bucket.append(
                        ConflictEvidence(
                            id=f"C-{sys_name}-{len(bucket)}",
                            system=sys_name,
                            conflict_type=ctype,
                            topic=topic,
                            side="excel",
                            cited_text=c["excel_says"],
                            source={"kind": "excel", "workbook": sys_name},
                            reason=(
                                f"기존 scan의 '{ctype}: {topic}' 쟁점에서 Excel이 주장한 내용. "
                                f"상대 페이지: '{conf_rel}'"
                            ),
                            confidence=_SEVERITY_TO_CONFIDENCE.get(severity, "low"),
                            severity=severity,
                            counterpart_side="confluence",
                            counterpart_summary=str(c.get("confluence_says", "")),
                            raw_scan_record={
                                "confluence_rel_path": conf_rel,
                                "conflict_index": idx,
                                "recommendation": c.get("recommendation"),
                            },
                        )
                    )
                # Confluence side
                if c.get("confluence_says"):
                    bucket.append(
                        ConflictEvidence(
                            id=f"C-{sys_name}-{len(bucket)}",
                            system=sys_name,
                            conflict_type=ctype,
                            topic=topic,
                            side="confluence",
                            cited_text=c["confluence_says"],
                            source={"kind": "confluence", "page_path": conf_rel},
                            reason=(
                                f"기존 scan의 '{ctype}: {topic}' 쟁점에서 Confluence가 주장한 내용. "
                                f"상대 워크북: '{sys_name}'"
                            ),
                            confidence=_SEVERITY_TO_CONFIDENCE.get(severity, "low"),
                            severity=severity,
                            counterpart_side="excel",
                            counterpart_summary=str(c.get("excel_says", "")),
                            raw_scan_record={
                                "confluence_rel_path": conf_rel,
                                "conflict_index": idx,
                                "recommendation": c.get("recommendation"),
                            },
                        )
                    )
        result[sys_name] = bucket
    return result


# ---- Stage 2: Chain-of-Verification with Citations -----------------------

COV_TOOL: dict[str, Any] = {
    "name": "record_cov_verdicts",
    "description": (
        "각 Stage-1 evidence에 대해 원문 근거를 바탕으로 충돌 여부를 재검증하고 verdict, "
        "원문 quote, 최종 confidence를 기록한다."
    ),
    "input_schema": {
        "type": "object",
        "required": ["verdicts"],
        "properties": {
            "verdicts": {
                "type": "array",
                "items": {
                    "type": "object",
                    "required": ["evidence_id", "verdict", "final_confidence", "reason"],
                    "properties": {
                        "evidence_id": {"type": "string"},
                        "verdict": {"enum": ["confirmed", "rejected", "uncertain"]},
                        "final_confidence": {"enum": ["high", "medium", "low"]},
                        "reason": {
                            "type": "string",
                            "description": "왜 이 verdict인지 2~3문장. 책임 귀속 금지, 중립 프레이밍.",
                        },
                        "quote_from_source": {
                            "type": "string",
                            "description": (
                                "원문 documents에서 직접 복사한 짧은 문장. "
                                "rejected 이면 빈 문자열로 둬도 됨."
                            ),
                        },
                        "quote_source_title": {
                            "type": "string",
                            "description": "quote가 등장한 document의 title 정확 복사",
                        },
                    },
                },
            }
        },
    },
}


COV_SYSTEM_PROMPT = """당신은 기획서 리팩토링 평가의 **검증(Chain-of-Verification)** 담당이다.

입력:
- documents: 해당 시스템의 원본 Excel 시트 + 충돌 상대 Confluence 페이지 전문
- evidence_list: 이전 자동 스캔이 '충돌'로 표시한 항목들 (cited_text는 스캔의 LLM 요약으로, 원문 인용이 아닐 수 있음)

작업: 각 evidence에 대해 **documents의 원문을 근거로** 다음을 판정한다.
  - verdict:
      * "confirmed"  — 원문이 실제로 충돌을 뒷받침한다 (양측 주장이 실제로 상이)
      * "rejected"   — 충돌이 아니다 (이미 해결된 변경 이력, 의도된 구버전 표기, 맥락 차이 등)
      * "uncertain"  — 원문만으로는 결론 불가
  - quote_from_source: verdict 판정을 뒷받침하는 **연속된 한 문장/한 줄을 documents에서 복사**.
    * 여러 구절을 합치거나 재구성·요약하지 말 것. 문장 하나를 그대로 복사.
    * documents 원문에 글자 그대로 존재해야 한다. 공백·구두점 포함 일치.
    * 적절한 한 문장이 없으면 빈 문자열로 두고 uncertain 처리.
  - quote_source_title: quote가 나온 document의 정확한 title
  - final_confidence: 위 판정의 확신도 (high/medium/low)
  - reason: 왜 이 판정인지 2~3문장.

절대 원칙:
  1. **환각 금지**. quote_from_source는 documents 원문에 **글자 그대로 존재**해야 한다. 없으면 빈 문자열로 두고 uncertain 처리.
  2. **프레이밍**: "이게 잘못됐다" 금지. "현재 두 문서에 상이한 내용이 적혀 있음"처럼 상태를 기술.
  3. **책임 귀속 금지**: 누가 썼다/빠뜨렸다 류 금지.
  4. 의도된 "(구버전)", "archived", "개편 전" 표기가 명확하면 rejected 가 맞다.

반드시 tool `record_cov_verdicts` 로만 응답한다. 자유 텍스트 금지."""


def _normalize_for_match(s: str) -> str:
    """whitespace/구두점 축약 후 소문자화 — fuzzy substring 비교용."""
    import re as _re
    s = _re.sub(r"\s+", " ", s).strip()
    return s


def _build_cov_user_message(sys_name: str, evidence: list[ConflictEvidence]) -> str:
    lines = [
        f"# 대상 시스템: {sys_name}",
        "",
        "아래 evidence_list의 각 항목에 대해 documents 원문을 근거로 verdict를 내려라.",
        "",
        "## evidence_list",
        "",
    ]
    for ev in evidence:
        lines += [
            f"- evidence_id: {ev.id}",
            f"  side: {ev.side}",
            f"  conflict_type: {ev.conflict_type}",
            f"  topic: {ev.topic}",
            f"  prior_summary: {ev.cited_text}",
            f"  counterpart_side: {ev.counterpart_side}",
            f"  counterpart_summary: {ev.counterpart_summary}",
            f"  severity(prior): {ev.severity}",
            "",
        ]
    return "\n".join(lines)


def _build_documents_for_system(
    sys_name: str,
    evidence: list[ConflictEvidence],
    max_sheet_chars: int = 20000,
    max_conf_chars: int = 20000,
) -> list[dict[str, Any]]:
    docs: list[dict[str, Any]] = []

    # Excel 시트 전체
    for sheet in corpus.excel_sheet_contents(sys_name, max_chars_per_sheet=max_sheet_chars):
        docs.append(
            {
                "title": f"Excel / {sys_name} / {sheet['sheet']}",
                "text": sheet["text"],
                "context": f"Excel 원본. 워크북={sys_name}, 시트={sheet['sheet']}",
            }
        )

    # 관련 Confluence 페이지 (evidence에서 참조된 것만)
    conf_paths: set[str] = set()
    for ev in evidence:
        rel = ev.source.get("page_path") if ev.source.get("kind") == "confluence" else None
        if rel:
            conf_paths.add(rel)
        # counterpart side 가 confluence인 경우도 보강
        raw = ev.raw_scan_record or {}
        rel2 = raw.get("confluence_rel_path")
        if rel2:
            conf_paths.add(rel2)

    for rel in sorted(conf_paths):
        doc = corpus.confluence_page_content(rel, max_chars=max_conf_chars)
        if doc is None:
            continue
        docs.append(
            {
                "title": f"Confluence / {rel}",
                "text": doc["text"],
                "context": f"Confluence 페이지. rel_path={rel}",
            }
        )

    return docs


def verify_evidence_for_system(
    sys_name: str,
    evidence: list[ConflictEvidence],
    *,
    model: str = "sonnet",
    thinking_budget: int | None = 2000,
    max_tokens: int = 4096,
) -> tuple[list[ConflictEvidence], dict[str, Any]]:
    """Stage 2 CoV — 한 시스템의 evidence를 Sonnet + documents + Citations로 재검증.

    Returns:
        (verified_evidence, meta) — verified_evidence는 verdict != 'rejected' 만 남기고
        cited_text를 원문 quote로 갱신한 사본. meta는 호출 비용/시간 등.
    """
    if not evidence:
        return [], {"verdicts": 0, "usage": {}, "skipped": "no_evidence"}

    documents = _build_documents_for_system(sys_name, evidence)
    if not documents:
        return [], {"verdicts": 0, "usage": {}, "skipped": "no_documents"}

    user_msg = _build_cov_user_message(sys_name, evidence)

    result = llm.call_with_documents(
        messages=[{"role": "user", "content": [{"type": "text", "text": user_msg}]}],
        system=COV_SYSTEM_PROMPT,
        documents=documents,
        tool=COV_TOOL,
        model=model,
        max_tokens=max_tokens,
        thinking_budget=thinking_budget,
        enable_citations=True,
    )

    verdicts_by_id: dict[str, dict[str, Any]] = {}
    for v in result["tool_input"].get("verdicts", []):
        vid = v.get("evidence_id")
        if vid:
            verdicts_by_id[vid] = v

    # 원문 합본 (fuzzy substring 검증용)
    all_text_norm = _normalize_for_match("\n".join(d["text"] for d in documents))

    verified: list[ConflictEvidence] = []
    quote_hits = 0
    quote_misses = 0
    for ev in evidence:
        v = verdicts_by_id.get(ev.id)
        if not v:
            # verdict 누락 — uncertain 으로 보존
            ev.verdict = "uncertain"
            ev.verified_by_cov = False
            verified.append(ev)
            continue
        verdict = v.get("verdict", "uncertain")
        if verdict == "rejected":
            # 소거
            continue
        ev.verdict = verdict  # type: ignore[assignment]
        ev.verified_by_cov = True
        new_conf = v.get("final_confidence")
        if new_conf in ("high", "medium", "low"):
            ev.confidence = new_conf
        quote = (v.get("quote_from_source") or "").strip()
        ev.reason = v.get("reason", ev.reason)
        qtitle = v.get("quote_source_title")
        if qtitle:
            ev.source = {**ev.source, "title": qtitle}

        # Post-hoc 감사: quote가 원문에 실제 존재하는가 (fuzzy)
        if quote:
            if _normalize_for_match(quote) in all_text_norm:
                ev.cited_text = quote
                quote_hits += 1
            else:
                # 환각 의심 — 원래 scan 요약 유지, confidence 한 단계 하향
                quote_misses += 1
                downgrade = {"high": "medium", "medium": "low", "low": "low"}
                ev.confidence = downgrade.get(ev.confidence, "low")  # type: ignore[assignment]
                ev.verified_by_cov = False
                ev.reason = (ev.reason or "") + " [quote 원문 미일치 — 재확인 권장]"
        else:
            # quote 없음 → uncertain 으로 유지하되 verified 플래그 낮춤
            ev.verified_by_cov = False
        verified.append(ev)

    meta = {
        "verdicts": len(verdicts_by_id),
        "kept": len(verified),
        "rejected": len(evidence) - len(verified) - sum(1 for e in evidence if e.id not in verdicts_by_id),
        "quote_hits": quote_hits,
        "quote_misses": quote_misses,
        "usage": result.get("usage", {}),
        "stop_reason": result.get("stop_reason"),
    }
    return verified, meta


# ---- 편의: evidence 직렬화 ----------------------------------------------

def evidence_to_dict(ev: ConflictEvidence) -> dict[str, Any]:
    d = asdict(ev)
    d.pop("raw_scan_record", None)
    return d


def dump_evidence_json(evidence_by_system: dict[str, list[ConflictEvidence]]) -> str:
    return json.dumps(
        {k: [evidence_to_dict(e) for e in v] for k, v in evidence_by_system.items()},
        ensure_ascii=False,
        indent=2,
    )
