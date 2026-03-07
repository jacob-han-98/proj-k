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

#### Stage 1: capture.py 구현 (2026-03-06)
- [x] LibreOffice headless → 시트별 PDF (1페이지 강제)
- [x] PDF → PNG (PyMuPDF, 콘텐츠 영역만 clip 렌더링)
- [x] 세로 전용 분할 (가로 유지, 공백 기반 수직 분할)
- [x] 개요 이미지 (1568px 너비)
- [x] 2단계 병렬 파이프라인: Phase 1 (PDF 병렬) + Phase 2 (PNG 병렬)
- [x] 실패 시트 자동 순차 재시도
- [x] 테스트: PK_변신 및 스킬 시스템.xlsx 13/13 시트 성공 (80개 이미지)

### 핵심 기술 결정

| 항목 | 결정 | 이유 |
|------|------|------|
| PDF DPI | 100 | 300→150→100. Vision AI 인식에 충분, 파일 크기 합리적 |
| 용지 크기 | 400cm x 400cm | 200cm은 큰 시트에서 2페이지 발생 |
| PDF→PNG | 콘텐츠 영역만 clip | 전체 용지 렌더링 시 15748px = 710MB, 메모리 폭발 |
| 분할 방식 | 세로 전용 | 기획서 가로 폭은 한정적, 가로 자르면 해석 불리 |
| 분할 기준 | DETAIL_MAX=1568px, 10% overlap | Vision AI 최적 입력 크기 |
| LO 병렬 | 워커별 독립 UserInstallation | 공유 프로파일 사용 시 충돌 |
| Phase 1 워커 | 최대 4 | LO가 무거워서 과도한 병렬화 시 충돌 증가 |
| Phase 2 워커 | cores - 2 | 이미지 처리는 가벼움, 최대 병렬 |

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
PNG_DPI = 100           # PDF→PNG 해상도
```

### 테스트 결과 (PK_변신 및 스킬 시스템.xlsx)

| 시트 | 크기 | 섹션 수 |
|------|------|---------|
| 히스토리 | 1501x4173 | 4 |
| 주요 정의 | 1190x1465 | 1 |
| 변신 | 1980x6983 | 6 |
| 스킬 | 1885x4462 | 4 |
| 스킬 기능 리스트 | 1793x9840 | 9 |
| UI_변신_기본 | 1961x6676 | 7 |
| UI_변신_합성 | 2036x7169 | 7 |
| UI_변신_강화 | 2036x8131 | 7 |
| UI_스킬 | 1871x4407 | 5 |
| UI_변신_컬렉션 | 1266x91 | 1 |
| UI_변신_확정 | 1266x91 | 1 |
| 아트_연출 리스트 | 1266x588 | 1 |
| 테이블 정보 | 902x255 | 1 |

### Vision AI 검증 결과 (히스토리 시트)

| 실행 | 리전 | 모델 | 토큰 | 시간 | 비고 |
|------|------|------|------|------|------|
| 1차 | us-east-1 | us.anthropic.claude-opus-4-6 | 46K | ~240s | 중복 내용 있음, overview 텍스트 읽기 문제 |
| 2차 | ap-northeast-2 | global.anthropic.claude-opus-4-5 | 40K | 167s | 프롬프트 개선 후. 타일 경계 2행 중복 외 양호 |

### Bedrock API 설정

| 항목 | 값 |
|------|------|
| 리전 | ap-northeast-2 |
| 모델 ID | global.anthropic.claude-opus-4-5-20251101-v1:0 |
| 인증 | Bearer Token (AWS_BEARER_TOKEN_BEDROCK) |
| 기타 모델 | global.anthropic.claude-sonnet-4-5-20250929-v1:0, global.anthropic.claude-haiku-4-5-20251001-v1:0 |

### 알려진 이슈

- Phase 1 병렬 실행 시 일부 LO 인스턴스가 충돌 (URP bridge disposed)
  - 해결: 실패 시트 자동 순차 재시도로 100% 복구
- Vision 타일 경계에서 1~2행 중복 발생 가능 (10% 오버랩 구간)
  - 프롬프트로 중복 방지 지시하지만 완벽하지 않음
  - Synthesize 단계에서 후처리 중복 제거 고려

---

## 다음 작업

### Stage 2: Vision (기본 구현 완료, 검증 진행 중)
- [x] vision.py 구현 — AWS Bedrock Claude Opus Vision API 호출
- [x] 2-이미지 전략: overview + detail 동시 전달
- [x] 프롬프트: 텍스트 우선 + 수학적 표현 + LLM 텍스트 표현 최대화
- [x] 누적 MD 컨텍스트: 이전 타일 결과를 다음 타일 프롬프트에 포함 → 중복 최소화
- [x] 프롬프트 최적화: overview에서 텍스트 읽기 금지, 구조/맥락 파악용으로만 사용
- [x] 히스토리 시트 4타일 추출 성공 (Ver 1.0~8.0 전체 80행)
- [ ] 다른 시트 유형 테스트 (UI, 플로우차트, 도형 포함 시트)
- [ ] 서브 이미지 분리 (텍스트 불가 요소만 발췌 + 참조 + 요약)

### Stage 3: Parse (미착수)
- openpyxl로 셀 데이터/수식/숨겨진 행열 추출 → Vision 결과 보강

### Stage 4: Synthesize (미착수)
- Vision + Parse 결과 병합 → content.md + images/

### Verification (미착수)
- Vision AI 랜덤 질의 검증

---

## 파일 구조

```
packages/xlsx-extractor/
├── capture.py          # Stage 1 구현 (완료)
├── vision.py           # Stage 2 구현 (진행 중)
├── MEMORY.md           # 이 파일 - 작업 기록
├── README.md           # 서브 프로젝트 개요
├── SPEC.md             # 상세 스펙
├── VERIFICATION.md     # 검증 프로토콜
├── .env.example        # 환경변수 템플릿
└── output/             # 변환 결과물 (.gitignore)
```
