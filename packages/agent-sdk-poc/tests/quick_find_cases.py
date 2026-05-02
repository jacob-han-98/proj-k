"""Quick Find 테스트 케이스 — 12개, 6 카테고리.

각 케이스의 expected_* 필드는 응답 검증 + KG/vector/substring 레이어별 quality 평가용.
"""

CASES = [
    # ─── 카테고리 1: 시스템 직역 (단일 키워드, 워크북 명에 직접 등장) ───
    {
        "id": "system-1-변신",
        "category": "system_name",
        "query": "변신",
        "expected_workbooks": ["PK_변신 및 스킬 시스템"],
        "expected_kinds": ["xlsx", "confluence"],
        "min_results": 3,
        "max_latency_ms": 3000,
        "notes": "직역 매칭의 가장 단순한 케이스. xlsx/conf 양쪽 다 떠야 정상.",
    },
    {
        "id": "system-2-레벨업",
        "category": "system_name",
        "query": "레벨업",
        "expected_workbooks": ["PK_레벨업 시스템"],
        "expected_kinds": ["xlsx"],
        "min_results": 1,
        "max_latency_ms": 3000,
        "notes": "단일 시스템 워크북 매칭.",
    },
    {
        "id": "system-3-물약",
        "category": "system_name",
        "query": "물약",
        "expected_workbooks": ["PK_물약 자동 사용 시스템"],
        "expected_kinds": ["xlsx"],
        "min_results": 1,
        "max_latency_ms": 3000,
        "notes": "복합어(자동 사용) 안의 부분 매칭.",
    },
    {
        "id": "system-4-분해",
        "category": "system_name",
        "query": "분해",
        "expected_workbooks": ["PK_분해 시스템"],
        "expected_kinds": ["xlsx"],
        "min_results": 1,
        "max_latency_ms": 3000,
        "notes": "짧은 한국어 키워드.",
    },

    # ─── 카테고리 2: 메커닉 (시스템 < 단위, 시트/공식 레벨) ───
    {
        "id": "mech-1-크리티컬",
        "category": "mechanic",
        "query": "크리티컬 확률",
        "expected_workbooks_any": [
            "PK_기본 전투 시스템",
            "PK_대미지 명중률 계산기",
            "PK_스탯 시스템",
        ],
        "expected_kinds": ["xlsx", "confluence"],
        "min_results": 2,
        "max_latency_ms": 3000,
        "notes": "시스템 명에 직접 안 나오고 시트/Confluence 레벨에 흩어진 메커닉.",
    },
    {
        "id": "mech-2-쿨타임",
        "category": "mechanic_crosscut",
        "query": "쿨타임",
        "expected_diversity_min": 3,  # 서로 다른 워크북 ≥ 3
        "min_results": 3,
        "max_latency_ms": 3000,
        "notes": "Cross-cutting — 변신 스킬·자동 물약·보스 레이드 등에 동시 등장. 다양성 평가.",
    },
    {
        "id": "mech-3-전투HUD",
        "category": "ui_locator",
        "query": "전투 HUD",
        "expected_workbooks": ["PK_HUD 시스템"],
        "expected_sheet_contains": "전투",
        "min_results": 1,
        "max_latency_ms": 3000,
        "notes": "워크북 + 시트 단위 정확 식별. 한·영 혼재.",
    },

    # ─── 카테고리 3: 컨텐츠/지역 (xlsx 가 아니라 Confluence 위주) ───
    {
        "id": "content-1-바리울",
        "category": "content_region",
        "query": "바리울",
        "expected_path_contains": "동대륙_바리울",
        "expected_kinds": ["confluence"],
        "min_results": 1,
        "max_latency_ms": 3000,
        "notes": "지역 고유명사 — Confluence 위주, xlsx 0건이 정상.",
    },
    {
        "id": "content-2-동대륙",
        "category": "content_region",
        "query": "동대륙",
        "expected_path_contains": "동대륙",
        "expected_kinds": ["confluence"],
        "min_results": 1,
        "max_latency_ms": 3000,
        "notes": "광역 키워드 — 동대륙_바리울 등 여러 페이지 후보.",
    },
    {
        "id": "content-3-던전",
        "category": "content_region",
        "query": "던전 리스트",
        "expected_path_contains": "던전",
        "expected_kinds": ["confluence"],
        "min_results": 1,
        "max_latency_ms": 3000,
        "notes": "구체적 페이지명에 가까운 자연어.",
    },

    # ─── 카테고리 4: 자연어 모호 ───
    {
        "id": "natural-1-키우기",
        "category": "natural_vague",
        "query": "캐릭터 키우는 법",
        "expected_workbooks_any": [
            "PK_레벨업 시스템",
            "PK_변신 및 스킬 시스템",
            "PK_보상 시스템",
        ],
        "expected_diversity_min": 2,
        "min_results": 3,
        "max_latency_ms": 4000,
        "notes": "자연어 자유 표현 — 의미 매칭 필요. Haiku rerank 의 가치를 보는 케이스.",
    },

    # ─── 카테고리 5: 의미 매칭 / 유사어 (substring 으로 못 잡는 hard case) ───
    {
        "id": "edge-1-치명타",
        "category": "synonym",
        "query": "치명타",
        "expected_workbooks_any": [
            "PK_기본 전투 시스템",
            "PK_대미지 명중률 계산기",
        ],
        "min_results": 1,
        "max_latency_ms": 4000,
        "notes": "치명타 = 크리티컬 의미 매칭. substring 으론 못 잡음. vector 또는 Haiku 의 의미 이해 필요. 만약 0건이면 vector layer 추가 검토.",
    },
]


def get_case(case_id: str) -> dict:
    for c in CASES:
        if c["id"] == case_id:
            return c
    raise KeyError(case_id)
