# xlsx-extractor 작업 기록

> 이 파일은 서브 프로젝트의 진행 상태를 세션 간 유지하기 위한 기록이다.
> 새 세션 시작 시 반드시 이 파일을 먼저 읽는다.

---

## 현재 집중 대상

**PK_변신 및 스킬 시스템.xlsx** — 13시트, 사용자가 가장 익숙한 파일로 개발/검증 진행 중

## 현재 상태: Stage 2 (Vision) 구현 진행 중

---

### 완료된 작업

#### 문서화 (2026-03-06)
- [x] README.md, SPEC.md, VERIFICATION.md 생성
- [x] .env.example 생성 (AWS Bedrock 인증)
- [x] .gitignore 설정 (output/ 제외)

#### Stage 1: capture.py 구현
- [x] v1 (LO 기반): LibreOffice headless → PDF → PNG (폐기됨)
- [x] v2 (Excel COM 기반): CopyPicture → 직접 PNG (현재 사용)
- [x] 세로 전용 분할 (가로 유지, 공백 기반 수직 분할)
- [x] 개요 이미지 (1568px 너비)
- [x] Phase 1 (Excel COM 순차) + Phase 2 (분할 병렬)
- [x] LO → Excel COM 전환 (2026-03-06)

#### LibreOffice → Excel COM 전환 이유 (2026-03-06)
1. **도형 렌더링 오류 (치명적)**: LO가 플로우차트 화살표 방향을 Excel과 다르게 렌더링
2. **셀 구분자 손실**: LO 렌더링에서 셀 내 줄바꿈/쉼표가 사라짐 ("변신,스킬,UI" → "변신스킬UI")
3. **페이지 나눔 없음**: CopyPicture는 시트를 한 장의 연속 이미지로 캡처
4. **안정성**: LO 병렬 실행 시 빈번한 충돌 vs Excel COM 단일 프로세스 안정 동작

### 핵심 기술 결정

| 항목 | 결정 | 이유 |
|------|------|------|
| 캡처 방식 | Excel COM CopyPicture | LO 대비 도형/셀구분자 정확도 월등 |
| 분할 방식 | 세로 전용 | 기획서 가로 폭은 한정적, 가로 자르면 해석 불리 |
| 분할 기준 | DETAIL_MAX=1568px, 10% overlap | Vision AI 최적 입력 크기 |
| ScreenUpdating | 반드시 True | False 시 CopyPicture가 빈 이미지 반환 |
| Phase 2 워커 | cores - 2 | 이미지 분할은 가벼움, 최대 병렬 |

### Vision AI 해석 원칙 (사용자 지시)

1. **텍스트 우선**: 테이블 → Markdown 테이블, 플로우차트 → Mermaid
2. **수학적 표현 시도**: 도식/다이어그램을 수식, 공식, 의사코드 등으로 표현
3. **LLM 친화적 텍스트 최대한 활용**: ASCII art, 구조화 목록, 관계 표현 등
4. **불가능한 시각 요소만 이미지**: 해당 영역을 발췌하여 서브 이미지로 저장
5. **서브 이미지 참조 필수**: `![설명](./images/figure_01.png)` + 추상적 요약 텍스트

### capture.py 주요 상수

```python
DETAIL_MAX = 1568       # 분할 타일 최대 높이
OVERVIEW_MAX_W = 1568   # 개요 이미지 최대 너비
OVERLAP_RATIO = 0.10    # 인접 타일 오버랩
```

### Excel COM 캡처 테스트 결과

| 시트 | Excel COM | LO (구) | 비고 |
|------|-----------|---------|------|
| 히스토리 | 1420x4029, 3타일 | 1501x4173, 4타일 | 셀 구분자 보존 ✓ |
| 변신 | 1788x7456, 타일미정 | 1980x6983, 6타일 | 화살표 정확 ✓ |
| UI_변신_컬렉션 | 1266x91 | 1 |
| UI_변신_확정 | 1266x91 | 1 |
| 아트_연출 리스트 | 1266x588 | 1 |
| 테이블 정보 | 902x255 | 1 |

### Vision AI 검증 결과

**히스토리 시트:**

| 실행 | 리전 | 모델 | 토큰 | 시간 | 비고 |
|------|------|------|------|------|------|
| 1차 | us-east-1 | us.anthropic.claude-opus-4-6 | 46K | ~240s | 중복 내용 있음, overview 텍스트 읽기 문제 |
| 2차 | ap-northeast-2 | global.anthropic.claude-opus-4-5 | 40K | 167s | 프롬프트 개선 후. 타일 경계 2행 중복 외 양호 |

**변신 시트 전체 실행 (2026-03-08):**

| 항목 | 값 |
|------|-----|
| 타일 | 7개 + 플로우차트 크롭 4회 (r1, r3, r4, r5) |
| 소요 시간 | 314초 (5분 14초), API 222.6초 |
| 토큰 | 85,953 input + 20,795 output = 106,748 total |
| Output 속도 | 93.4 tok/s (API), 66.1 tok/s (wall) |
| 결과 | merged.md 721줄 / 32KB |
| 플로우차트 | r3,r4,r5 성공 / r1(합성) D→H 연결 실패 (비결정적, v10에서만 성공) |
| 버그 수정 | results[] 텍스트가 크롭 교체 반영 안 됨 → 수정 완료 |

### Bedrock API 설정

| 항목 | 값 |
|------|------|
| 리전 | ap-northeast-2 |
| 모델 ID | global.anthropic.claude-opus-4-5-20251101-v1:0 |
| 인증 | Bearer Token (AWS_BEARER_TOKEN_BEDROCK) |
| 기타 모델 | global.anthropic.claude-sonnet-4-5-20250929-v1:0, global.anthropic.claude-haiku-4-5-20251001-v1:0 |

### 알려진 이슈

- ScreenUpdating=False 시 CopyPicture가 빈 이미지 반환 → 반드시 True 유지
- Vision 타일 경계에서 1~2행 중복 발생 가능 (10% 오버랩 구간)
  - 프롬프트로 중복 방지 지시하지만 완벽하지 않음
  - Synthesize 단계에서 후처리 중복 제거 고려
- **Vision AI 플로우차트 커넥터 추적 — 크롭+프롬프트 강화로 해결** (2026-03-08)
  - 긴 수평/수직 연결선(다른 노드를 건너뛰는 선) 추적이 어려움
  - v2~v9 (8회 시도): 합류 패턴 힌트, 단계별 분석, 루프백 금지, 크롭 등 시도 → 실패
  - **v10 성공**: FLOWCHART_PROMPT 구조 변경으로 해결
    - 핵심: "도형별 나가는 선 개수 먼저 확인 + 각 선의 방향(→↑↓←) 기록 + 테이블 형식 강제"
    - "긴 수평선/수직선이 이미지 끝까지 이어지는 경우를 놓치지 마세요" 직접 경고
    - 17.8s, 1,460 output tokens (이전 v9: 13.1s, 885 tokens — 더 상세한 분석)
  - **v11 확인**: 크롭 없이 전체 타일 + 강화 프롬프트만으로는 실패 → **크롭 필수 확정**
  - 3단계 파이프라인: locate_flowchart_bbox() → crop → FLOWCHART_PROMPT 2nd pass
  - SPEC.md 5.5에 정식 기록. Stage 3 OOXML은 safety net으로 유지
- **타일 경계 콘텐츠 중복/잘림** (2026-03-08 확인)
  - 콘텐츠가 타일 경계를 걸쳐 있으면 두 타일 모두에서 부분적으로 해석됨
  - 예: UI_변신_기본 r5/r6 — "최종 결과 화면"이 r5 하단에 잘린 채 나오고, r6에서 완전히 나옴
  - 결과: 중복 텍스트, 잘린 참조 이미지
  - **해결 방안**: Stage 4 (Synthesize)에서 중복 감지/병합 후처리 필요
- **Vision AI 플로우차트 주변 주석 누락** (2026-03-08 확인)
  - 플로우차트 노드 근처에 배치된 주석/참조 텍스트가 해당 노드와 연결되지 않고 별도 섹션으로 분리됨
  - **해결**: 프롬프트에 "주변 주석은 가장 가까운 노드의 주석으로 기록" 규칙 추가

---

## 다음 작업

### Stage 2: Vision (구현 완료, 전체 시트 처리 진행 중)
- [x] vision.py 구현 — AWS Bedrock Claude Opus Vision API 호출
- [x] 2-이미지 전략: overview + detail 동시 전달
- [x] 프롬프트: 텍스트 우선 + 수학적 표현 + LLM 텍스트 표현 최대화
- [x] 누적 MD 컨텍스트: 이전 타일 결과를 다음 타일 프롬프트에 포함 → 중복 최소화
- [x] 프롬프트 최적화: overview에서 텍스트 읽기 금지, 구조/맥락 파악용으로만 사용
- [x] 히스토리 시트 4타일 추출 성공 (Ver 1.0~8.0 전체 80행)
- [x] 플로우차트 크롭 재분석 파이프라인 구현 (2026-03-08)
- [x] 콘텐츠 해석 규칙 3종 추가 (2026-03-08)
  - 주사위 아이콘 = "확률(주사위)" 해석
  - 수학적/기하학적 표현 우선, 불가 시 서브 이미지 저장
  - UI_ 탭: 텍스트 해석 + 서브 이미지 저장 + 참조 링크 필수
- [x] 서브 이미지 추출 파이프라인 구현 (2026-03-08)
  - `[SUB_IMAGE: desc]` 마커 → 전용 locate Vision call → 정밀 크롭
  - `_normalize_sub_image_markers()`: Vision AI가 `![desc](./images/...)` 직접 출력 시 정규화
  - fallback: locate 실패 시 타일 전체 이미지 저장
  - UI_변신_기본 검증: 16 sub-images 정밀 크롭 성공
- [x] process_all() 디렉토리 스캔 보완: 매니페스트 미등록 시트도 자동 발견
- [x] 전체 13시트 처리 완료 (2026-03-08)
  - 8000px 초과 overview 자동 리사이즈 (LANCZOS) 추가
  - UI_변신_기본: 7타일, 213s, 95,939 tok, 16 sub-images
  - 스킬: 4타일, 180s, 54,458 tok, 7 sub-images + 1 flowchart
  - 나머지 8시트 일괄: 803s, 289,722 tok (스킬 기능 리스트 재처리 포함 +309s)
  - 총 sub-images: 105개

**전체 처리 결과 요약 (PK_변신 및 스킬 시스템.xlsx)**:

| 시트 | 타일 | 결과 | Sub-images |
|------|------|------|-----------|
| UI_변신_강화 | 7 | OK | 20 |
| UI_변신_기본 | 7 | OK | 22 |
| UI_변신_컬렉션 | 1 | OK | 0 |
| UI_변신_합성 | 7 | OK | 21 |
| UI_변신_확정 | 1 | OK | 0 |
| UI_스킬 | 5 | OK | 13 |
| 변신 | 7 | OK | 0 |
| 스킬 | 4 | OK | 7 |
| 스킬 기능 리스트 | 9 | OK | 22 |
| 아트_연출 리스트 | 1 | OK | 0 |
| 주요 정의 | 1 | OK | 0 |
| 테이블 정보 | 1 | OK | 0 |
| 히스토리 | 4 | OK | 0 |

### Stage 3: Parse (OOXML 커넥터 검증 구현 완료, 2026-03-08)

**구현**: `parse.py` — OOXML drawing XML에서 도형/커넥터를 추출하여 Vision AI Mermaid 보정

**핵심 기능 (구현됨)**:
1. **OOXML 도형/커넥터 추출**: `xl/drawings/drawingN.xml`에서 sp(도형) + cxnSp(커넥터) 파싱
2. **플로우차트 그룹핑**: BFS로 연결 컴포넌트 자동 분리 (하나의 drawing에 여러 플로우차트 있을 수 있음)
3. **Mermaid-OOXML 매칭**: 텍스트 유사도 기반 노드 매핑 + 엣지 비교
4. **자동 보정**: 누락된 엣지를 Mermaid 코드에 추가

**검증 결과 (변신 시트)**:
- 70 shapes, 56 connectors, 3개 플로우차트 그룹 자동 분리
- 합성 플로우차트: Vision AI가 D->C (루프백)로 잘못 해석한 경우, OOXML에서 `39->34` (합성 진행 불가->종료) 감지 -> `D --> H` 자동 추가 확인
- 알려진 한계: OOXML에서 diamond(마름모)가 텍스트 없이 별도 라벨 rect 사용 -> 해당 노드 매핑 불가 (match 4/6)

**미구현**:
- 도형 텍스트 교정 (Vision 오독 보정)
- openpyxl 데이터 보강 (정밀 수치, 숨겨진 행/열, 수식)

### Stage 4: Synthesize (미착수)
- Vision + Parse 결과 병합 → content.md + images/

### Verification (미착수)
- Vision AI 랜덤 질의 검증

---

## 파일 구조

```
packages/xlsx-extractor/
├── capture.py          # Stage 1 구현 (완료)
├── vision.py           # Stage 2 구현 (완료 - 크롭 재분석 포함)
├── parse.py            # Stage 3 구현 (OOXML 커넥터 검증)
├── MEMORY.md           # 이 파일 - 작업 기록
├── README.md           # 서브 프로젝트 개요
├── SPEC.md             # 상세 스펙
├── VERIFICATION.md     # 검증 프로토콜
├── .env.example        # 환경변수 템플릿
└── output/             # 변환 결과물 (.gitignore)
```
