"""
프리셋 질문 — agent-sdk 의 장점(크로스시스템 탐색, 근거 인용, 심층 분석)을 드러내는 질문 위주.
기존 qna-poc 프리셋을 기반으로 agent-sdk 특화로 재큐레이션.
"""

PRESETS: list[dict] = [
    # 시스템 요약 (베이스라인)
    {"label": "변신 시스템 정리", "prompt": "변신 시스템의 목적, 획득/보유 규칙, 등급, 합성, 강화를 정리해줘.", "category": "system"},
    {"label": "스킬 시스템 설명", "prompt": "스킬 시스템을 설명해줘. 평타/발동 액션/액티브 스킬의 차이와 확률 계산 방식 포함.", "category": "system"},
    {"label": "기본 전투 공식 정리", "prompt": "기본 전투 시스템의 공식 — 물리/마법 데미지, 명중/회피, 크리티컬 판정을 한 번에 정리해줘.", "category": "system"},
    {"label": "캐릭터 성장 구조", "prompt": "캐릭터 성장은 어떤 축(레벨/스탯/장비/변신/스킬)으로 이뤄지고 각각 어떻게 연결돼?", "category": "system"},

    # 수치·공식 (원문 인용 강조)
    {"label": "변신 등급별 스펙 규칙", "prompt": "변신 등급별(에픽~일반) 스탯 수·발동액션 수·스킬 수 차이를 표로 정리해줘. 원문 표기 유지.", "category": "spec"},
    {"label": "변신 전환 쿨타임", "prompt": "변신 A/B 전환 쿨타임은 몇 초인가? 내부 상수 이름과 출처를 함께 알려줘.", "category": "spec"},
    {"label": "HUD 경험치/골드 최대값", "prompt": "HUD에 표시되는 경험치/골드/은닉의 최대값은? 출처 포함.", "category": "spec"},

    # 크로스 시스템 (Agent 강점)
    {"label": "변신 ↔ 장비 ↔ 스킬 연결", "prompt": "변신·장비·스킬 시스템이 어떻게 맞물려 작동하는지, 스탯 기여 비중과 연결 지점을 중심으로 설명해줘.", "category": "cross"},
    {"label": "HUD_전투 참조 기획서", "prompt": "HUD_전투 시트에서 참조하는 다른 기획서를 전부 찾아 어느 번호에서 어떤 목적으로 참조하는지 매핑해줘.", "category": "cross"},
    {"label": "크리티컬 확률 종합", "prompt": "크리티컬 공격 확률 계산식, 관련 스탯, 시스템 간 관계, 예외 케이스까지 종합해줘.", "category": "cross"},

    # 컨텐츠·운영
    {"label": "던전 종류와 명칭", "prompt": "Project K에 등장하는 던전을 유형별·명칭별로 모두 알려줘. 필드형/클리어형 구분도 포함.", "category": "content"},
    {"label": "7_System 시스템 목록", "prompt": "7_System 폴더에 어떤 시스템 기획서가 있는지 주요 카테고리(전투/성장/UI/사회/경제)별로 묶어서 알려줘.", "category": "overview"},
    {"label": "운영 공간 주요 문서", "prompt": "Confluence `운영` 공간에 어떤 정책/프로세스 문서가 있는지 목록과 한 줄 요약으로 정리해줘.", "category": "overview"},

    # DataSheet — 게임 런타임 데이터 (Resource/design/*.xlsx → SQLite) 와 기획서 내 표 활용.
    # 1) 직접 테이블 값 조회, 2) 기획서 + 데이터시트 cross-check, 3) GDD 내부 표 셀 값 인용.
    {
        "label": "📊 Boss 몬스터 HP 분포",
        "prompt": (
            "MonsterClass 데이터시트에서 Boss 류(Keyward 에 'Boss' 포함) 몬스터들의 "
            "Id, TextkeyTitle, Keyward, Level, MaxHp 를 HP 내림차순으로 정리해줘. "
            "이상치(예: HP 999999) 가 보이면 그것도 짚어줘."
        ),
        "category": "datasheet",
    },
    {
        "label": "📊 스킬 분류 — 기획서 vs 데이터시트",
        "prompt": (
            "스킬 시스템 기획서가 평타/발동 액션/액티브 스킬을 어떻게 구분·정의하는지 정리하고, "
            "실제 Skill 데이터시트의 SkillType 별 분포(개수)가 그 정의와 부합하는지 cross-check 해줘. "
            "기획서에는 있는데 데이터에는 없거나, 그 반대 케이스가 있으면 명시."
        ),
        "category": "datasheet",
    },
    {
        "label": "📋 HUD 요소 상세 표 (GDD 내부 표)",
        "prompt": (
            "PK_HUD 시스템 기획서의 'HUD_기본' 시트에 있는 'HUD 요소 상세 테이블' 에서 "
            "분류가 'Button' 에 해당하는 요소들의 번호와 이름을 원문 표기 그대로 가져와줘. "
            "출처는 시트명·표 제목까지 정확히 인용."
        ),
        "category": "datasheet",
    },

    # Deep Research — 비교 모드 + 웹 검색 (Tavily) 활용. 클릭 시 "📚 비교" 토글 자동 ON.
    {
        "label": "🌐 검은사막 거점전 vs PK 월드 공성전",
        "prompt": (
            "검은사막의 거점전·점령전 시스템을 공식 자료까지 조사해서 "
            "PK 의 월드 공성전과 비교 분석해줘. PK가 도입할 만한 메카닉 3가지 이상을 "
            "구체 수치와 위험·trade-off 와 함께 제안."
        ),
        "category": "deepresearch",
        "compare_mode": True,
    },
    {
        "label": "🌐 HIT2 서버별 버프 투표 시스템 조사",
        "prompt": (
            "HIT2의 서버별 버프 투표 시스템을 조사해서 PK에 적용한다면 어떤 형태가 좋을지 검토해줘. "
            "PK 의 기존 서버 단위 메커니즘(연대기·공성전·서버 이동)과의 정합성도 같이."
        ),
        "category": "deepresearch",
        "compare_mode": True,
    },
    {
        "label": "🌐 모바일 MMORPG 거래소·세금 모델 비교",
        "prompt": (
            "리니지W·검은사막 모바일·Lord Nine 의 거래소 세금/수수료/등록 규칙을 공식 자료까지 조사해서 "
            "PK 의 거래소 설계와 비교해줘. 세율 구조·성주 권한·서버별 세금 분배 방식의 차이를 표로 정리하고, "
            "PK 가 도입할 만한 메카닉 2~3가지를 운영 리스크와 함께 제안."
        ),
        "category": "deepresearch",
        "compare_mode": True,
    },
    {
        "label": "🌐 한국 MMORPG 부활/사망 페널티 트렌드",
        "prompt": (
            "최근 한국 MMORPG(리니지M/W, Lord Nine, 검은사막 모바일, HIT2 등) 의 사망 시 페널티 "
            "(경험치 감소·장비 내구도·디버프·부활 위치·시간 페널티) 디자인 트렌드를 공식·위키 자료로 조사해서, "
            "PK 의 사망/부활 시스템과 비교해줘. PK 가 트렌드 대비 어떤 위치인지 평가하고, "
            "도입 검토할 만한 변형 1~2가지를 위험과 함께 제안."
        ),
        "category": "deepresearch",
        "compare_mode": True,
    },
]
