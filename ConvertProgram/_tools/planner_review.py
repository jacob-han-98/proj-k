"""
기획자 리뷰 필요 항목 자동 감지
================================
변환 파이프라인에서 자동으로 감지할 수 없거나,
문맥 추론이 필요한 항목을 별도 문서로 출력.

감지 유형:
  1. unlabeled_visual: 라벨 없는 화살표/축/도형 (문맥 추론 시도 → 불가 시 리뷰 요청)
  2. image_only_diagram: 이미지로만 존재하는 다이어그램 (Tier 1.5 추출 불가)
  3. orphan_connector: 연결 대상 불명인 커넥터 (?)
  4. ambiguous_reference: 모호한 외부 참조
  5. inferred_content: AI가 문맥에서 추론한 내용 (기획자 확인 필요)

사용법:
  from planner_review import ReviewCollector

  collector = ReviewCollector("PK_변신_및_스킬_시스템")
  collector.add("unlabeled_visual", "변신", "밸런스 예시",
                description="세로축에 라벨 없음",
                inference="합성으로 추정 (강화/합성 두 가지 성장 방향만 존재)",
                confidence="medium")
  collector.save(out_dir)
"""

import json
import os
from datetime import datetime
from collections import defaultdict


# 감지 유형 정의
REVIEW_TYPES = {
    "unlabeled_visual": {
        "label": "라벨 미표기 시각 요소",
        "icon": "🏷️",
        "desc": "화살표, 축, 도형 등에 라벨이 없어 의미가 불명확",
    },
    "image_only_diagram": {
        "label": "이미지 전용 다이어그램",
        "icon": "🖼️",
        "desc": "도형이 아닌 이미지로만 존재하여 Tier 1.5 추출 불가",
    },
    "orphan_connector": {
        "label": "연결 대상 불명 커넥터",
        "icon": "🔗",
        "desc": "시작 또는 끝 도형을 찾을 수 없는 연결선",
    },
    "ambiguous_reference": {
        "label": "모호한 외부 참조",
        "icon": "📎",
        "desc": "다른 파일/시트를 참조하지만 경로나 내용이 불명확",
    },
    "inferred_content": {
        "label": "AI 추론 내용",
        "icon": "🤔",
        "desc": "문맥에서 AI가 추론한 내용 — 기획자 확인 필요",
    },
    "missing_label_in_diagram": {
        "label": "다이어그램 내 누락 라벨",
        "icon": "⚠️",
        "desc": "플로우차트/다이어그램에서 분기 조건이나 경로 라벨이 누락",
    },
}


class ReviewItem:
    """단일 리뷰 항목"""

    def __init__(self, review_type, sheet, location, description,
                 inference=None, confidence="low", context=None):
        self.review_type = review_type
        self.sheet = sheet
        self.location = location
        self.description = description
        self.inference = inference  # AI가 추론한 내용 (있으면)
        self.confidence = confidence  # high/medium/low
        self.context = context  # 관련 셀/도형 데이터

    def to_dict(self):
        d = {
            "type": self.review_type,
            "sheet": self.sheet,
            "location": self.location,
            "description": self.description,
            "confidence": self.confidence,
        }
        if self.inference:
            d["inference"] = self.inference
        if self.context:
            d["context"] = self.context
        return d


class ReviewCollector:
    """리뷰 항목 수집기"""

    def __init__(self, workbook_name):
        self.workbook_name = workbook_name
        self.items = []

    def add(self, review_type, sheet, location, description,
            inference=None, confidence="low", context=None):
        item = ReviewItem(
            review_type=review_type,
            sheet=sheet,
            location=location,
            description=description,
            inference=inference,
            confidence=confidence,
            context=context,
        )
        self.items.append(item)
        return item

    def has_items(self):
        return len(self.items) > 0

    def save(self, out_dir):
        """리뷰 문서 저장 (MD + JSON)"""
        if not self.items:
            return None

        os.makedirs(out_dir, exist_ok=True)

        # JSON 저장
        json_path = os.path.join(out_dir, "_기획자_리뷰.json")
        data = {
            "workbook": self.workbook_name,
            "generated": datetime.now().strftime("%Y-%m-%d %H:%M"),
            "total_items": len(self.items),
            "items": [item.to_dict() for item in self.items],
        }
        with open(json_path, 'w', encoding='utf-8') as f:
            json.dump(data, f, ensure_ascii=False, indent=2)

        # MD 저장
        md_path = os.path.join(out_dir, "_기획자_리뷰.md")
        md = self._to_markdown()
        with open(md_path, 'w', encoding='utf-8') as f:
            f.write(md)

        print(f"  [REVIEW] {len(self.items)}개 기획자 리뷰 항목 → {md_path}")
        return md_path

    def _to_markdown(self):
        md = f"# 기획자 리뷰 필요 — {self.workbook_name}\n\n"
        md += f"> 자동 생성: {datetime.now().strftime('%Y-%m-%d %H:%M')}\n"
        md += f"> 총 {len(self.items)}개 항목\n\n"
        md += "---\n\n"

        # 유형별 그룹핑
        by_type = defaultdict(list)
        for item in self.items:
            by_type[item.review_type].append(item)

        # 우선순위: inference 없는 것(기획자 액션 필요) > inference 있는 것(확인만)
        needs_action = [i for i in self.items if not i.inference]
        needs_confirm = [i for i in self.items if i.inference]

        if needs_action:
            md += "## 기획자 보강 필요 (AI 추론 불가)\n\n"
            md += "아래 항목은 문맥만으로 의미를 파악할 수 없어 기획자의 보강이 필요합니다.\n\n"
            for i, item in enumerate(needs_action, 1):
                info = REVIEW_TYPES.get(item.review_type, {})
                icon = info.get("icon", "❓")
                md += f"### {i}. {icon} [{item.sheet}] {item.location}\n\n"
                md += f"- **유형**: {info.get('label', item.review_type)}\n"
                md += f"- **설명**: {item.description}\n"
                if item.context:
                    md += f"- **관련 데이터**: {item.context}\n"
                md += f"- **조치**: 기획서 원본에서 해당 부분의 의미를 명시해 주세요\n\n"

        if needs_confirm:
            md += "## AI 추론 내용 (기획자 확인 필요)\n\n"
            md += "아래 항목은 AI가 문맥에서 추론한 내용입니다. 정확성을 확인해 주세요.\n\n"
            for i, item in enumerate(needs_confirm, 1):
                info = REVIEW_TYPES.get(item.review_type, {})
                icon = info.get("icon", "🤔")
                conf_label = {"high": "높음", "medium": "보통", "low": "낮음"}.get(item.confidence, "?")
                md += f"### {i}. {icon} [{item.sheet}] {item.location}\n\n"
                md += f"- **유형**: {info.get('label', item.review_type)}\n"
                md += f"- **설명**: {item.description}\n"
                md += f"- **AI 추론**: {item.inference}\n"
                md += f"- **추론 신뢰도**: {conf_label}\n"
                if item.context:
                    md += f"- **관련 데이터**: {item.context}\n"
                md += f"- **조치**: 추론이 맞으면 무시, 틀리면 정정 후 재변환\n\n"

        return md


# ============================================================
# 자동 감지 함수들
# ============================================================

def detect_orphan_connectors(shapes, connectors, sheet_name, collector):
    """연결 대상 불명인 커넥터 감지"""
    for cxn in connectors:
        f = shapes.get(cxn.get('from', ''), {})
        t = shapes.get(cxn.get('to', ''), {})
        ft = f.get('text', '')
        tt = t.get('text', '')

        if not ft or not tt:
            desc = f"커넥터의 {'시작' if not ft else '끝'} 도형 텍스트 미확인"
            context = f"from={cxn.get('from', '?')}, to={cxn.get('to', '?')}"
            if ft:
                context += f", 시작=[{ft}]"
            if tt:
                context += f", 끝=[{tt}]"
            collector.add(
                "orphan_connector", sheet_name, "도형 연결선",
                description=desc, context=context
            )


def detect_image_only_diagrams(ws, shapes, sheet_name, collector):
    """이미지로만 존재하는 다이어그램 감지

    이미지가 있지만 해당 영역에 도형 데이터가 없으면 → 이미지 전용 다이어그램
    """
    image_count = len(ws._images) if hasattr(ws, '_images') else 0
    shape_count = len([s for s in shapes.values() if s.get('text')])

    if image_count > 0 and shape_count == 0:
        collector.add(
            "image_only_diagram", sheet_name, "전체 시트",
            description=f"이미지 {image_count}개가 존재하지만 도형 텍스트가 0개 — 다이어그램이 이미지로만 존재할 가능성",
        )
    elif image_count > shape_count * 2:
        collector.add(
            "image_only_diagram", sheet_name, "전체 시트",
            description=f"이미지 {image_count}개 vs 도형 {shape_count}개 — 일부 다이어그램이 이미지로만 존재할 가능성",
            confidence="medium",
        )


def detect_unlabeled_connectors_in_flowchart(shapes, connectors, sheet_name, collector):
    """플로우차트에서 분기 조건(Yes/No 등) 라벨 누락 감지

    다이아몬드(분기) 도형에서 나가는 커넥터가 2개 이상인데
    커넥터에 텍스트 라벨이 없으면 → 라벨 누락
    """
    # 분기 도형 (다이아몬드/결정) 찾기
    decision_shapes = {
        sid: s for sid, s in shapes.items()
        if s.get('geo') in ('flowChartDecision', 'diamond') and s.get('text')
    }

    for sid, s in decision_shapes.items():
        # 이 분기에서 나가는 커넥터 수
        outgoing = [c for c in connectors if c.get('from') == sid]
        if len(outgoing) >= 2:
            # 커넥터에 텍스트 라벨이 있는지 확인
            # (커넥터 자체는 보통 텍스트가 없지만, 근처에 Yes/No 텍스트 도형이 있을 수 있음)
            has_labels = any(
                shapes.get(c.get('to', ''), {}).get('text', '').upper() in
                ('YES', 'NO', 'Y', 'N', 'TRUE', 'FALSE', '예', '아니오')
                for c in outgoing
            )
            if not has_labels:
                collector.add(
                    "missing_label_in_diagram", sheet_name,
                    f"분기: {s['text'][:30]}",
                    description=f"분기 도형 '{s['text'][:40]}'에서 {len(outgoing)}개 경로가 나가지만 Yes/No 라벨 미확인",
                    inference="분기 조건의 경로별 의미를 기획자가 확인 필요",
                    confidence="medium",
                )


def run_auto_detection(ws, shapes, connectors, sheet_name, collector):
    """모든 자동 감지를 실행"""
    detect_orphan_connectors(shapes, connectors, sheet_name, collector)
    detect_image_only_diagrams(ws, shapes, sheet_name, collector)
    detect_unlabeled_connectors_in_flowchart(shapes, connectors, sheet_name, collector)
