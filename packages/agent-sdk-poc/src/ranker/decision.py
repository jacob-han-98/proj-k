"""Decision 카드 생성 + apply (decisions.jsonl / annotations.jsonl append).

Step 0.4 의 end-to-end 루프를 이 모듈이 담당한다.

- `build_cards(target)` : Stage 1 재활용(LLM 호출 없음)으로 topic별 선택지 카드 생성.
- `apply_decision(target, card, selected_key, author, ttl_days)` : 선택 결과를
  decisions.jsonl + annotations.jsonl 에 append (append-only).
- `next_decision_id()` : 기존 파일 스캔 후 D-XXXX 시퀀스 다음 번호.
"""
from __future__ import annotations

import json
import re
from dataclasses import dataclass, field
from datetime import date, datetime, timedelta
from pathlib import Path
from typing import Any

from . import conflict

PKG_ROOT = Path(__file__).resolve().parents[2]
DECISIONS_DIR = PKG_ROOT / "decisions"
DECISIONS_JSONL = DECISIONS_DIR / "decisions.jsonl"
ANNOTATIONS_JSONL = DECISIONS_DIR / "annotations.jsonl"
FEEDBACK_JSONL = DECISIONS_DIR / "feedback.jsonl"


@dataclass
class DecisionCard:
    target_name: str
    topic: str
    conflict_type: str
    severity: str
    recommendation: str | None
    options: list[dict[str, Any]] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        return {
            "target_name": self.target_name,
            "topic": self.topic,
            "conflict_type": self.conflict_type,
            "severity": self.severity,
            "recommendation": self.recommendation,
            "options": self.options,
        }


# ---- 카드 빌더 ------------------------------------------------------------

_SEVERITY_ORDER = {"critical": 0, "major": 1, "minor": 2}


def build_cards(target_name: str) -> list[DecisionCard]:
    """Stage 1 재활용으로 topic별 선택지 카드 생성.

    각 topic은 excel/confluence 양측 evidence가 모두 있을 때만 카드로 승격.
    severity 순으로 정렬.
    """
    by_sys = conflict.collect_evidence([target_name])
    evidence = by_sys.get(target_name, [])

    by_topic: dict[str, dict[str, conflict.ConflictEvidence]] = {}
    for ev in evidence:
        key = f"{ev.conflict_type}::{ev.topic}"
        by_topic.setdefault(key, {})[ev.side] = ev

    cards: list[DecisionCard] = []
    for key, sides in by_topic.items():
        if "excel" not in sides or "confluence" not in sides:
            continue
        ex = sides["excel"]
        cf = sides["confluence"]
        cards.append(
            DecisionCard(
                target_name=target_name,
                topic=ex.topic,
                conflict_type=ex.conflict_type,
                severity=ex.severity,
                recommendation=(ex.raw_scan_record or {}).get("recommendation"),
                options=[
                    {
                        "key": "A",
                        "source": ex.source,
                        "summary": ex.cited_text,
                        "side": "excel",
                    },
                    {
                        "key": "B",
                        "source": cf.source,
                        "summary": cf.cited_text,
                        "side": "confluence",
                    },
                ],
            )
        )

    cards.sort(key=lambda c: _SEVERITY_ORDER.get(c.severity, 99))
    return cards


# ---- 파일 I/O -------------------------------------------------------------

_DEC_ID_RE = re.compile(r"^D-(\d+)$")
_FB_ID_RE = re.compile(r"^F-(\d+)$")


def _next_id(path: Path, prefix: str, id_re: re.Pattern[str]) -> str:
    max_num = 0
    if path.exists():
        for line in path.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if not line:
                continue
            try:
                obj = json.loads(line)
            except json.JSONDecodeError:
                continue
            m = id_re.match(str(obj.get("id", "")))
            if m:
                n = int(m.group(1))
                if n > max_num:
                    max_num = n
    return f"{prefix}-{max_num + 1:04d}"


def next_decision_id() -> str:
    return _next_id(DECISIONS_JSONL, "D", _DEC_ID_RE)


def next_feedback_id() -> str:
    return _next_id(FEEDBACK_JSONL, "F", _FB_ID_RE)


def _append_jsonl(path: Path, obj: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a", encoding="utf-8") as f:
        f.write(json.dumps(obj, ensure_ascii=False) + "\n")


# ---- Apply decision -------------------------------------------------------

def apply_decision(
    target_name: str,
    card: DecisionCard,
    selected_key: str,
    *,
    author: str,
    ttl_days: int = 30,
    selected_custom_text: str | None = None,
) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    """사용자 선택을 decisions.jsonl + annotations.jsonl 에 append.

    Returns: (decision_record, [annotation_records, ...])
    """
    decision_id = next_decision_id()
    today = date.today().isoformat()
    expires_at = (datetime.now().date() + timedelta(days=ttl_days)).isoformat()

    decision: dict[str, Any] = {
        "id": decision_id,
        "date": today,
        "target_name": target_name,
        "conflict_summary": f"[{card.conflict_type}] {card.topic}",
        "options": card.options,
        "selected_option": selected_key,
        "author": author,
        "ttl_days": ttl_days,
        "status": "active",
        "deprecated_refs": [],
    }
    if selected_custom_text is not None and selected_key == "other":
        decision["selected_custom_text"] = selected_custom_text

    annotations: list[dict[str, Any]] = []
    for opt in card.options:
        if opt["key"] == selected_key:
            continue
        ann = {
            "decision_id": decision_id,
            "target": opt["source"],
            "status": "deprecated",
            "label": (
                f"⚠️ {today} deprecated (결정 {decision_id}, "
                f"{selected_key}안 채택 — {card.conflict_type}: {card.topic})"
            ),
            "reason": card.recommendation or "",
            "applied_at": today,
            "expires_at": expires_at,
        }
        annotations.append(ann)
        decision["deprecated_refs"].append(opt["source"])

    _append_jsonl(DECISIONS_JSONL, decision)
    for ann in annotations:
        _append_jsonl(ANNOTATIONS_JSONL, ann)

    return decision, annotations


# ---- Feedback (dismiss / defer / regrade / comment) ----------------------

def record_feedback(
    target_name: str,
    *,
    action: str,
    author: str,
    comment: str = "",
    regrade_to: str | None = None,
    ttl_days: int = 30,
) -> dict[str, Any]:
    """feedback.jsonl 에 1줄 append.

    Ranker 재실행 시 Judge few-shot 으로 주입되어 순위를 조정한다.
    """
    if action not in ("dismiss", "regrade", "defer", "comment"):
        raise ValueError(f"invalid action: {action}")
    fid = next_feedback_id()
    now = datetime.now()
    record: dict[str, Any] = {
        "id": fid,
        "date": now.isoformat(timespec="seconds"),
        "target_name": target_name,
        "action": action,
        "comment": comment,
        "author": author,
        "expires_at": (now.date() + timedelta(days=ttl_days)).isoformat(),
    }
    if action == "regrade" and regrade_to:
        record["regrade_to"] = regrade_to
    _append_jsonl(FEEDBACK_JSONL, record)
    return record
