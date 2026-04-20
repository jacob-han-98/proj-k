"""Hub / Blast Radius 차원 — Stage 1 (KG degree 초벌) + Stage 2 (edge 의미 분류).

Stage 1: knowledge_graph.json의 related_systems degree. LLM 없음.
Stage 2: Sonnet이 각 edge를 "strong / weak / loose" 로 의미 분류.
         가중 degree 산출 = strong*1.5 + weak*1.0 + loose*0.5.
         입력은 시스템·상대 description + sheet 이름으로 한정 (content.md 전문은 생략,
         토큰 절감).
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Literal

from . import corpus, llm

Strength = Literal["strong", "weak", "loose"]

_STRENGTH_WEIGHT: dict[Strength, float] = {"strong": 1.5, "weak": 1.0, "loose": 0.5}


@dataclass
class HubEdge:
    source: str  # 대상 시스템 (우리가 평가 중인 것)
    target: str  # related_system 이름
    strength: Strength | None = None
    reason: str = ""
    target_description: str = ""
    target_sheet_count: int = 0


@dataclass
class HubEvaluation:
    system: str
    raw_degree: int
    edges: list[HubEdge] = field(default_factory=list)
    weighted_degree: float = 0.0
    verified_by_cov: bool = False

    @property
    def strong_count(self) -> int:
        return sum(1 for e in self.edges if e.strength == "strong")

    @property
    def weak_count(self) -> int:
        return sum(1 for e in self.edges if e.strength == "weak")

    @property
    def loose_count(self) -> int:
        return sum(1 for e in self.edges if e.strength == "loose")


# ---- Stage 1: 초벌 degree (LLM 없음) -------------------------------------

def collect_raw_edges(systems: list[str]) -> dict[str, HubEvaluation]:
    kg = corpus.load_kg()["systems"]
    out: dict[str, HubEvaluation] = {}
    for s in systems:
        meta = kg.get(s, {})
        related = meta.get("related_systems") or []
        edges: list[HubEdge] = []
        for r in related:
            r_meta = kg.get(r, {})
            edges.append(
                HubEdge(
                    source=s,
                    target=r,
                    target_description=(r_meta.get("description") or "").strip(),
                    target_sheet_count=r_meta.get("sheet_count") or 0,
                )
            )
        out[s] = HubEvaluation(system=s, raw_degree=len(edges), edges=edges)
    return out


# ---- Stage 2: Edge 의미 분류 ---------------------------------------------

EDGE_CLASSIFY_TOOL: dict[str, Any] = {
    "name": "classify_edges",
    "description": "각 관련 시스템과의 의존 강도를 strong/weak/loose 로 분류하고 이유를 기록한다.",
    "input_schema": {
        "type": "object",
        "required": ["edges"],
        "properties": {
            "edges": {
                "type": "array",
                "items": {
                    "type": "object",
                    "required": ["target", "strength", "reason"],
                    "properties": {
                        "target": {"type": "string", "description": "related_system 이름 정확 복사"},
                        "strength": {
                            "enum": ["strong", "weak", "loose"],
                            "description": (
                                "strong = 공식/데이터/런타임 모델 공유, 이 시스템 변경이 상대 "
                                "시스템의 동작·수식을 직접 바꾸는 경우. weak = UI/메시지 연동, "
                                "명시적 호출이 있지만 구조적 결합은 약함. loose = 단순 참조·맥락 "
                                "공유 수준."
                            ),
                        },
                        "reason": {
                            "type": "string",
                            "description": "어떤 근거로 이 강도인지 1~2문장. 상대 시스템의 역할과 이 시스템과의 연결 방식 서술.",
                        },
                    },
                },
            }
        },
    },
}


HUB_SYSTEM_PROMPT = """당신은 기획 시스템 의존 관계 분석가다.

한 시스템의 related_systems(이미 knowledge graph가 추출한 후보)를 받아, 각 edge가 **의존 강도** 측면에서 어떤 관계인지 분류한다.

분류 기준:
- "strong" — 공식/데이터/런타임 모델을 공유. 이 시스템이 바뀌면 상대 시스템의 수식·동작이 즉시 영향. 예: 전투 시스템 ↔ 스탯/공식.
- "weak"   — UI 연동·메시지 호출 등 명시적 연결은 있으나, 구조 결합은 약함. 한쪽 변경이 다른 쪽에 부분 영향. 예: HUD ↔ 인벤토리.
- "loose"  — 단순 참조·맥락 공유. 자주 같이 언급되지만 실제 결합은 느슨함.

원칙:
1. 분류는 **문서 단서**(시스템 이름, description, 시트 구성)로만 판정. 외부 지식 금지.
2. 근거가 부족하면 보수적으로 loose.
3. 모든 related_systems에 대해 빠짐없이 분류.
4. 결과는 반드시 tool `classify_edges` 로만 기록. 자유 텍스트 금지.
5. reason은 중립 프레이밍 ("A는 B의 수식을 참조함"이 적절, "B가 A에 의존함" 같은 단정은 피함)."""


def _build_hub_user_message(system: str, edges: list[HubEdge]) -> str:
    kg = corpus.load_kg()["systems"]
    sys_meta = kg.get(system, {})
    self_desc = (sys_meta.get("description") or "").strip()
    self_sheets = sys_meta.get("sheets") or []

    lines = [
        f"# 대상 시스템: {system}",
        f"- description: {self_desc}",
        f"- sheet_count: {sys_meta.get('sheet_count', 0)}",
        f"- sheets (최대 8개 샘플): {self_sheets[:8]}",
        "",
        "# related_systems (분류 대상)",
        "",
    ]
    for e in edges:
        lines += [
            f"- target: {e.target}",
            f"  description: {e.target_description or '(no description)'}",
            f"  sheet_count: {e.target_sheet_count}",
            "",
        ]
    lines += [
        "모든 target에 대해 strength(strong/weak/loose) + reason을 기록하라.",
    ]
    return "\n".join(lines)


def classify_edges_for_system(
    evaluation: HubEvaluation,
    *,
    model: str = "sonnet",
    max_tokens: int = 4000,
) -> tuple[HubEvaluation, dict[str, Any]]:
    if not evaluation.edges:
        return evaluation, {"classified": 0, "usage": {}, "skipped": "no_edges"}

    user_msg = _build_hub_user_message(evaluation.system, evaluation.edges)
    result = llm.call_structured(
        messages=[{"role": "user", "content": user_msg}],
        system=HUB_SYSTEM_PROMPT,
        tool=EDGE_CLASSIFY_TOOL,
        model=model,
        max_tokens=max_tokens,
        temperature=0.0,
    )
    classifications = {
        c.get("target"): c for c in result["tool_input"].get("edges", [])
    }

    classified_count = 0
    for edge in evaluation.edges:
        c = classifications.get(edge.target)
        if not c:
            # 누락된 edge — 보수적으로 loose
            edge.strength = "loose"
            edge.reason = "(LLM이 분류 누락 — 보수적 loose)"
            continue
        strength = c.get("strength")
        if strength in ("strong", "weak", "loose"):
            edge.strength = strength  # type: ignore[assignment]
            edge.reason = c.get("reason", "")
            classified_count += 1
        else:
            edge.strength = "loose"
            edge.reason = c.get("reason") or "(분류값 비정상 — loose)"

    evaluation.weighted_degree = sum(_STRENGTH_WEIGHT.get(e.strength or "loose", 0.5) for e in evaluation.edges)
    evaluation.verified_by_cov = True

    meta = {
        "classified": classified_count,
        "total_edges": len(evaluation.edges),
        "usage": result.get("usage", {}),
        "stop_reason": result.get("stop_reason"),
    }
    return evaluation, meta
