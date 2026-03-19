"""Mermaid 렌더링 테스트 페이지.

다양한 방향/복잡도의 Mermaid 다이어그램을 테스트하여 잘림, 정렬 등을 확인.

실행: streamlit run src/pages/mermaid_test.py --server.port 8502
"""

import sys
from pathlib import Path

# 독립 실행 시 src 경로 추가
sys.path.insert(0, str(Path(__file__).resolve().parent.parent.parent))

import streamlit as st
import streamlit.components.v1 as components

st.set_page_config(page_title="Mermaid 렌더링 테스트", layout="wide")
st.title("Mermaid 렌더링 테스트")

# ── render_mermaid_block (streamlit_app.py에서 import 가능하면 좋지만, 독립 실행을 위해 복사) ──

def _estimate_mermaid_height(code: str) -> int:
    """방향/노드 수 기반 높이 추정 (넉넉하게 → JS가 축소)."""
    first_line = code.strip().split('\n')[0].strip().lower()
    arrow_count = code.count('-->')

    if 'sequencediagram' in first_line:
        msg_count = sum(1 for line in code.split('\n')
                        if '->>' in line or '-->>' in line or '-->' in line)
        return max(300, msg_count * 55 + 150)

    if any(d in first_line for d in ['lr', 'rl']):
        branch_count = code.count('-->|') + code.count('--|')
        return max(250, min(800, branch_count * 70 + 200))

    # TB/TD
    return max(300, min(3000, arrow_count * 80 + 150))


def render_mermaid_block(code: str):
    """Mermaid 코드를 components.html로 렌더링."""
    escaped = code.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
    initial_height = _estimate_mermaid_height(code)
    components.html(f"""
    <script src="https://cdn.jsdelivr.net/npm/mermaid@10/dist/mermaid.min.js"></script>
    <style>
        body {{ margin:0; padding:4px 0; background:white; font-family:'Malgun Gothic','맑은 고딕',sans-serif; overflow:hidden; }}
        .mermaid {{ display:flex; justify-content:flex-start; }}
        .mermaid svg {{ height:auto; }}
        .mermaid .node rect, .mermaid .node circle, .mermaid .node polygon {{
            rx: 5px; ry: 5px;
        }}
        .mermaid .nodeLabel, .mermaid .label {{
            padding: 8px 16px !important;
            font-family: 'Malgun Gothic','맑은 고딕',sans-serif !important;
        }}
    </style>
    <div class="mermaid">{escaped}</div>
    <script>
    mermaid.initialize({{
        startOnLoad: false,
        theme: 'default',
        securityLevel: 'loose',
        flowchart: {{
            padding: 20,
            nodeSpacing: 30,
            rankSpacing: 40,
            useMaxWidth: false,
            htmlLabels: true,
            wrappingWidth: 200
        }}
    }});
    mermaid.run().then(() => {{
        let attempts = 0;
        function fitHeight() {{
            const svg = document.querySelector('.mermaid svg');
            if (svg) {{
                const h = svg.getBoundingClientRect().height;
                if (h > 10) {{
                    const newH = Math.ceil(h) + 20;
                    const fe = window.frameElement;
                    if (fe) {{
                        fe.style.height = newH + 'px';
                        if (fe.hasAttribute('height')) fe.setAttribute('height', newH);
                        let p = fe.parentElement;
                        for (let i = 0; i < 5 && p; i++) {{
                            if (p.style.height || p.hasAttribute('height')) {{
                                p.style.height = newH + 'px';
                                if (p.hasAttribute('height')) p.setAttribute('height', newH + 'px');
                            }}
                            p = p.parentElement;
                        }}
                    }}
                    return;
                }}
            }}
            if (attempts++ < 50) requestAnimationFrame(fitHeight);
        }}
        setTimeout(fitHeight, 150);
    }});
    </script>
    """, height=initial_height)


# ── 샘플 데이터 ──

SAMPLES = {
    "1. 세로 (TB) — 짧은": {
        "code": """flowchart TB
    A[상점에서 구매 완료] --> B[인벤토리 공간 확인]
    B -->|공간 충분| C[아이템 획득]
    B -->|공간 부족| D[시스템 메시지:\\nInventory_NotEnoughInventory]
    C --> E{인벤토리 열려있음?}
    E -->|Yes| F[실시간 정렬 X\\n최하순위 배치]
    E -->|No| G[다음 열 때 반영]""",
        "desc": "실제 QnA에서 자주 나오는 짧은 세로 플로우",
    },
    "2. 세로 (TB) — 긴 (10+ 노드)": {
        "code": """flowchart TB
    A[사용자 스킬 입력] --> B[스킬 유효성 검증]
    B --> C{쿨타임 확인}
    C -->|쿨타임 중| D[사용 불가 메시지]
    C -->|사용 가능| E[마나 소모 확인]
    E -->|마나 부족| F[마나 부족 메시지]
    E -->|마나 충분| G[스킬 시전 시작]
    G --> H[캐스팅 타임]
    H --> I[이펙트 발동]
    I --> J{대상 유효?}
    J -->|유효| K[대미지 계산]
    J -->|무효| L[Miss 처리]
    K --> M[방어력 적용]
    M --> N[최종 대미지 반영]
    N --> O[HP 감소 처리]
    O --> P{사망 판정}
    P -->|생존| Q[전투 계속]
    P -->|사망| R[사망 처리 시퀀스]
    R --> S[경험치 분배]
    S --> T[아이템 드롭 판정]""",
        "desc": "세로 방향 긴 플로우 — 잘림 여부 확인용",
    },
    "3. 가로 (LR) — 짧은": {
        "code": """flowchart LR
    A[캐릭터 선택] --> B[변신 선택]
    B --> C{프리셋 있음?}
    C -->|Yes| D[프리셋 적용]
    C -->|No| E[기본 스킬 세팅]
    D --> F[전투 진입]
    E --> F""",
        "desc": "가로 방향 짧은 플로우",
    },
    "4. 가로 (LR) — 넓은 (다분기)": {
        "code": """flowchart LR
    A[아이템 획득] --> B{아이템 타입}
    B -->|장비| C[장비 인벤토리]
    B -->|소비| D[소비 인벤토리]
    B -->|재료| E[재료 인벤토리]
    B -->|퀘스트| F[퀘스트 인벤토리]
    B -->|펫| G[펫 인벤토리]
    C --> H[자동 정렬]
    D --> H
    E --> H
    F --> I[퀘스트 자동 등록]
    G --> J[펫 도감 등록]
    H --> K[인벤토리 UI 갱신]
    I --> K
    J --> K""",
        "desc": "가로 방향 넓은 분기 — 가로 잘림 확인용",
    },
    "5. 시퀀스 다이어그램": {
        "code": """sequenceDiagram
    participant C as 클라이언트
    participant S as 서버
    participant DB as 데이터베이스
    C->>S: 스킬 사용 요청
    S->>S: 쿨타임 검증
    S->>S: 마나 검증
    S->>DB: 대상 정보 조회
    DB-->>S: 대상 HP/방어력
    S->>S: 대미지 계산
    S->>DB: HP 업데이트
    DB-->>S: 결과
    S-->>C: 스킬 결과 전송
    C->>C: 이펙트 재생""",
        "desc": "시퀀스 다이어그램 — 세로 확장",
    },
    "6. 한글 긴 텍스트 노드": {
        "code": """flowchart TB
    A[변신 강화 시스템 - 안전 강화와 일반 강화 두 가지 모드] --> B{강화 모드 선택}
    B -->|안전 강화| C[실패해도 강화 단계 유지\\n비용: 일반의 3배\\n보호권 자동 적용]
    B -->|일반 강화| D[실패 시 단계 하락 가능\\n비용: 기본 재화\\n보호권 선택 사용]
    C --> E[강화 성공 확률 계산\\n기본 확률 + 축복 보너스 + 이벤트 보너스]
    D --> E
    E --> F{결과}
    F -->|성공| G[강화 단계 +1\\n스탯 보너스 증가\\n외형 변경 체크]
    F -->|실패| H{보호 상태?}
    H -->|보호됨| I[단계 유지\\n재화만 소모]
    H -->|미보호| J[단계 -1\\n재화 소모]""",
        "desc": "한글 긴 텍스트가 노드 안에서 잘리는지 확인",
    },
}

# ── 렌더링 ──

st.markdown("각 다이어그램이 **잘리지 않고**, **좌측 정렬**되어 정상 표시되는지 확인하세요.")
st.divider()

for name, sample in SAMPLES.items():
    st.subheader(name)
    st.caption(sample["desc"])

    col_diagram, col_code = st.columns([3, 2])

    with col_diagram:
        render_mermaid_block(sample["code"])

    with col_code:
        with st.expander("코드 보기", expanded=False):
            st.code(sample["code"], language="mermaid")

    st.divider()

# ── 커스텀 입력 ──
st.subheader("커스텀 Mermaid 테스트")
custom = st.text_area("Mermaid 코드를 입력하세요:", height=200, placeholder="flowchart TB\n    A --> B")
if custom.strip():
    render_mermaid_block(custom.strip())
