# xlsx-extractor 기술 스펙

> 4단계 파이프라인의 구현 상세. 각 Stage의 입출력, 알고리즘, API 사양을 정의한다.

---

## 1. 파이프라인 개요

```
XLSX 파일
  │
  ├─ [Stage 1: Capture]      Excel COM → PNG → 세로 분할 타일
  ├─ [Stage 2: Vision]       Claude Opus Vision API → 구조화 Markdown
  ├─ [Stage 3: Parse OOXML]  OOXML drawing XML → Mermaid 보정 + 텍스트 코퍼스
  └─ [Stage 4: Synthesize]   중복 제거 + OCR 교정 → 최종 content.md
```

| Stage | 입력 | 출력 | 핵심 기술 |
|-------|------|------|-----------|
| Capture | .xlsx 파일 | 시트별 이미지 세트 | Excel COM CopyPicture, Pillow, numpy |
| Vision | 이미지 세트 | 타일별 MD + 서브 이미지 | Claude Opus Vision API (Bedrock) |
| Parse OOXML | .xlsx (ZIP) | Mermaid 보정 + 색상 + 텍스트 코퍼스 | OOXML XML 파싱 (ElementTree) |
| Synthesize | Vision + Parse 결과 | content.md + images/ | 14단계 dedup + Sonnet OCR 교정 |

---

## 2. 환경 설정

### API 모델

| 용도 | 모델 | Bedrock 모델 ID |
|------|------|-----------------|
| Vision 해석 | Claude Opus | `global.anthropic.claude-opus-4-5-20251101-v1:0` |
| OCR 교정 | Claude Sonnet | `global.anthropic.claude-sonnet-4-5-20250929-v1:0` |

### .env 변수

```env
AWS_BEARER_TOKEN_BEDROCK=<bearer-token>
AWS_REGION=ap-northeast-2
```

`.env` 파일 위치: `packages/xlsx-extractor/.env`

---

## 3. Stage 1: Capture

### 3.1 왜 Excel COM인가

| 비교 | Excel COM | LibreOffice headless |
|------|-----------|---------------------|
| 도형/화살표 방향 | 원본 100% 동일 | 방향 변경됨 (치명적) |
| 셀 내 구분자 | 보존 (줄바꿈, 쉼표) | 사라짐 ("변신,스킬,UI" → "변신스킬UI") |
| 페이지 나눔 | 없음 (연속 이미지) | PDF 경유 → 나눔 발생 |
| 안정성 | 단일 프로세스 안정 | 병렬 시 충돌 빈번 |
| 제약 | Windows + Excel 필수 | 크로스 플랫폼 |

### 3.2 2단계 캡처 프로세스

**Phase 1: Excel COM CopyPicture (순차)**
1. `win32com.client.Dispatch("Excel.Application")` — Excel 인스턴스 생성
2. 워크북 열기 → 각 시트의 `UsedRange.CopyPicture(xlScreen, xlBitmap)`
3. 클립보드 → `PIL.ImageGrab.grabclipboard()` → `full_original.png`
4. 빈 시트 감지 (1셀, 빈 값) → skip

**Phase 2: 이미지 분할 (병렬, ProcessPoolExecutor)**
1. `full_original.png` → `overview.png` (max 1568px 너비, 8000px 높이, LANCZOS)
2. 세로 전용 분할 → `detail_r0.png`, `detail_r1.png`, ...
3. `tile_manifest.json` 생성

### 3.3 분할 알고리즘

**세로 전용 분할** (가로 유지):
- 기획서는 가로 폭이 한정적 (보통 1400~1800px)
- 가로로 자르면 테이블 열이 분리되어 해석 불가

```
분할 기준: DETAIL_MAX = 1568px (높이)
오버랩: OVERLAP_RATIO = 0.10 (10%)

이미지 높이 H:
  H <= 1568px → 분할 없음 (detail_r0 = overview)
  H > 1568px  → 세로 분할, 각 타일 최대 1568px + 10% overlap
```

**콘텐츠 밀도 기반 분할점 탐색**:
- numpy로 행별 백색 비율 계산
- 공백 행(>95% 백색)을 분할 경계로 우선 선택
- 콘텐츠 중간을 자르는 것 방지

### 3.4 Excel COM 주의사항

| 설정 | 값 | 이유 |
|------|-----|------|
| `Visible` | False | UI 표시 불필요 |
| `ScreenUpdating` | **True** | False 시 CopyPicture가 빈 이미지 반환 |
| `Interactive` | False | 팝업 억제 |
| `DisplayAlerts` | False | 경고 억제 |
| `AskToUpdateLinks` | False | 외부 링크 갱신 팝업 억제 |

### 3.5 출력

```
{sheet_name}/_vision_input/
├── full_original.png       # 시트 전체 (화면 DPI 해상도)
├── overview.png            # 축소본 (max 1568px W, 8000px H)
├── detail_r0.png ~ rN.png  # 세로 분할 타일 (max 1568px H, 10% overlap)
└── tile_manifest.json      # 타일 위치/크기 메타데이터
```

---

## 4. Stage 2: Vision

### 4.1 2-이미지 전략

Vision API 호출 시 **overview + detail** 2장 동시 전달:

```
Image 1: overview.png  → 전체 시트에서 현재 영역의 위치/맥락 파악
Image 2: detail_rN.png → 해당 영역의 정밀 해석
```

- 타일이 1개인 경우: detail만 전달 (overview = detail이므로 중복 불필요)
- overview의 역할: 개요에서 텍스트를 읽지 않고 **구조와 맥락만** 파악

### 4.2 프롬프트 구조

**System Context**:
```
원본 이미지에 없는 내용을 절대 생성하지 마세요.
이미지에 실제로 보이는 텍스트와 요소만 해석하세요.
```

**해석 우선순위**:

| 우선순위 | 요소 유형 | 변환 대상 |
|----------|-----------|-----------|
| 1 | 테이블/표 | Markdown 테이블 |
| 2 | 플로우차트/흐름도 | Mermaid 다이어그램 |
| 3 | 수학적/개념 도형 | 텍스트 설명, 의사코드 |
| 4 | 주석/화살표 | 텍스트 참조 |
| 5 | 게임 UI 스크린샷 | `[SUB_IMAGE: 설명]` 마커 + 크롭 |
| 6 | 일러스트/아트 | `[SUB_IMAGE: 설명]` 마커 + 크롭 |

### 4.3 누적 컨텍스트

타일은 순서대로(r0 → r1 → r2 ...) 처리하며, 이전 타일의 결과를 다음 타일 프롬프트에 포함:

```
[이전 섹션 요약 (참고용, 반복 금지)]
{마지막 2개 헤딩 블록, 최대 3000자}
```

- 전체 결과가 아닌 **마지막 2개 heading section만** 전달
- 과도한 컨텍스트 → 할루시네이션 유발 (이전 내용을 새로 생성)
- "참고용일 뿐, 절대 반복하지 마세요" 경고 포함

### 4.4 빈 타일 감지

`is_blank_tile()`: PIL/numpy로 비백색 픽셀 비율 분석
- 비백색 비율 < 0.5% → 빈 타일 → Vision API 호출 스킵
- 방지: 빈 이미지에 대해 "⑤ 외부 참조" 등 할루시네이션 생성

### 4.5 플로우차트 크롭 재분석

전체 타일에서 플로우차트가 감지되면 3단계 추가 처리:

```
[1st pass] 메인 프롬프트로 전체 타일 해석 → mermaid 블록 감지
    ↓
[Locate] 경량 Vision 호출 → 플로우차트 영역 bbox (JSON: top/bottom/left/right %)
    ↓
[Crop] PIL로 해당 영역 크롭 (50% 높이 / 20% 너비 패딩)
    ↓
[2nd pass] FLOWCHART_PROMPT로 크롭 이미지 재분석
    ↓
[Replace] 1st pass의 mermaid 블록을 2nd pass 결과로 교체
```

**FLOWCHART_PROMPT 핵심 규칙**:
1. 모든 도형을 테이블로 나열: `| 번호 | 텍스트 | 모양 | 위치 |`
2. 각 도형에서 나가는 선의 **개수와 방향**(→↑↓←)을 먼저 파악
3. 각 선을 **끝까지** 추적 (꺾임/합류 포함)
4. 출발-도착 쌍을 테이블로 정리 후 Mermaid 변환
5. "긴 수평선/수직선이 이미지 끝까지 이어지는 경우를 놓치지 마세요"

### 4.6 서브 이미지 추출

Vision AI가 `[SUB_IMAGE: 설명]` 마커를 출력하면:

```
[Locate] 전용 Vision 호출 → 해당 요소의 bbox (JSON)
    ↓
[Crop] 원본 타일 이미지에서 정밀 크롭
    ↓
[Save] {sheet}_{tile}_fig{N}.png → _vision_output/images/
    ↓
[Replace] 마커를 ![설명](./images/{filename}) 으로 교체
```

- locate 실패 시: 타일 전체 이미지를 fallback으로 저장
- `_normalize_sub_image_markers()`: Vision이 `![desc](./images/...)` 직접 출력 시 정규화

### 4.7 출력

```
{sheet_name}/_vision_output/
├── detail_r0.md ~ rN.md         # 타일별 Vision 결과
├── merged.md                     # 전체 타일 병합
├── images/                       # 서브 이미지
│   ├── {sheet}_detail_r0_fig1.png  # 정밀 크롭
│   ├── {sheet}_detail_r0_fig2.png
│   └── {sheet}_detail_r0.png       # fallback (타일 전체)
├── detail_rN_flowchart.md        # 플로우차트 재분석 결과 (있을 때)
├── detail_rN_flowchart_crop.png  # 크롭 이미지 (있을 때)
└── vision_meta.json              # 타일별 토큰/타이밍/throughput
```

---

## 5. Stage 3: Parse OOXML

### 5.1 목표

Vision AI의 결과를 **기본 신뢰하되**, OOXML 데이터로 **구조적 약점을 보정**:
- 커넥터 연결 관계 (긴 수평/수직선 추적 실패)
- 등급 색상 정확도 (Vision의 근사 색상 → 정확한 hex)
- OCR 교정용 텍스트 코퍼스 (Stage 4에서 사용)

### 5.2 OOXML 도형/커넥터 추출

Excel의 `xl/drawings/drawingN.xml`에서:

```xml
<!-- 도형 (sp) -->
<xdr:sp>
  <xdr:nvSpPr><xdr:cNvPr id="39" name="합성 진행 불가"/></xdr:nvSpPr>
  <a:prstGeom prst="roundRect"/>
  <a:t>합성 진행 불가</a:t>
</xdr:sp>

<!-- 커넥터 (cxnSp) -->
<xdr:cxnSp>
  <a:stCxn id="39"/>  <!-- 출발 -->
  <a:endCxn id="34"/> <!-- 도착 -->
</xdr:cxnSp>
```

**추출 항목**:
- 도형: id, 이름, 텍스트, 프리셋(roundRect/diamond/ellipse 등)
- 커넥터: 출발 id, 도착 id

### 5.3 Mermaid 검증/보정

```
1. Vision merged.md에서 mermaid 코드 블록 추출
2. OOXML 도형/커넥터 추출 → BFS로 플로우차트 그룹 분리
3. 텍스트 유사도 기반 노드 매핑 (정규화: 공백/구두점 제거)
4. Diamond(마름모) 구조적 매칭: 이웃 노드 ≥2개 공통이면 매핑
5. OOXML 엣지 vs Mermaid 엣지 비교 → 누락/오판 감지
6. 누락 엣지 추가, 오판 엣지 제거 → 보정된 merged.md 출력
```

### 5.4 등급 색상 추출

`extract_grade_colors()`:
- OOXML 셀에서 등급 키워드(에픽, 신화, 레전드 등) 탐색
- 셀 배경색 추출: theme color + tint → RGB hex 계산
- Stage 4에서 Vision의 근사 색상명을 정확한 hex로 교체

### 5.5 텍스트 코퍼스

`extract_ooxml_text_corpus()`:
- 셀 텍스트 + 도형 내 텍스트 전체 수집
- Stage 4의 LLM OCR 교정에서 ground truth 참고 자료로 사용

### 5.6 출력

```
{sheet_name}/_parse_ooxml_output/
├── merged.md           # Mermaid 보정 적용 시만 생성
├── parse_meta.json     # 도형/커넥터 수, 보정 엣지, 타이밍
├── grade_colors.json   # {"신화": "#C00000", "에픽": "#7030A0", ...}
└── text_corpus.json    # ["텍스트1", "텍스트2", ...] (OCR 참조)
```

---

## 6. Stage 4: Synthesize

### 6.1 입력 선택

```
_parse_ooxml_output/merged.md 존재? → 사용 (Mermaid 보정 포함)
없으면 → _vision_output/merged.md (Vision 원본)
```

### 6.2 Dedup 파이프라인 (14단계)

| # | 단계 | 설명 |
|---|------|------|
| 1 | 타일 섹션 헤더 제거 | `# SheetName - Section N/M` 패턴 |
| 2 | 분석 메타데이터 제거 | Step blocks, HTML comments, 시트 요약, self-commentary |
| 3 | `(계속)`/`(이어서)` 접미사 제거 | 모든 헤딩에서 |
| 3.5 | 등급 색상 보정 | Vision 근사 색상 → OOXML 정확 hex |
| 3.6 | OCR 교정 | Sonnet API로 OOXML 텍스트 대조 교정 |
| 4 | 연속 중복 헤딩 정리 | 부모 컨텍스트 반복 제거 |
| 5 | 반복 부모 헤딩 축소 | 타일 경계 반복 컨테이너 제거 |
| 6 | 분할 테이블 병합 | 동일 헤딩+헤더 → 행 합치기 (set-based) |
| 7 | 원거리 중복 섹션 제거 | 동일 제목 leaf 섹션 → 긴 것 유지 |
| 7.5 | 동일 콘텐츠 연속 섹션 제거 | 다른 제목 + 같은 내용 → 뒤쪽 유지 |
| 7.6 | orphan 레벨 헤딩 제거 | overlap ≥40% 검사 후 제거 |
| 7.65 | 동일 제목 continuation 병합 | (계속) 제거 후 인접 섹션 합치기 |
| 7.7 | bold-heading 중복 제거 | `**Title**` 존재 시 `## Title` 제거 |
| 8 | 불완전 잘림 섹션 제거 | <5줄 짧은 중복 |
| 8.5 | 중복 blockquote 제거 | 동일 key의 `> **[key]**` 반복 |
| 8.6 | Meta-commentary 제거 | Vision AI self-reference 텍스트 |
| 9 | 최종 정리 | # SheetName 중복 + 빈 줄 정리 |

### 6.3 OCR 교정 (Step 3.6)

Sonnet API 1회 호출로 Vision의 OCR 오류를 교정:

```
입력:
  - 참고 자료 A: Vision 해석 텍스트 (교정 대상)
  - 참고 자료 B: OOXML 텍스트 코퍼스 (ground truth)

규칙:
  - B에 정확한 표기가 있으면 교정
  - changed_chars ≤ 5 (SequenceMatcher) — 과교정 방지
  - 구조 불변: 라인 수, 헤딩, 테이블, mermaid 블록 유지

출력: JSON 배열 [{original, corrected, reason}, ...]
```

**교정 예시**:
- `알파>` → `알파2` (특수문자 오인식)
- `가체` → `개체` (한글 유사 글자)
- `펑타` → `평타` (한글 유사 글자)
- `봉현탑` → `봉헌탑` (OOXML에 정확한 표기 있음)

### 6.4 등급 색상 보정 (Step 3.5)

Vision이 "보라색", "빨간색" 등으로 근사 인식한 등급 색상을:
OOXML에서 추출한 정확한 hex 코드로 교체.

```
Vision: "에픽 (보라색)"  →  교정: "에픽 (#7030A0)"
Vision: "신화 (빨간색)"  →  교정: "신화 (#C00000)"
```

### 6.5 서브 이미지 정리

- `_vision_output/images/` → `_final/images/`
- 참조되는 `_fig{N}.png` 크롭 이미지만 복사
- fallback 타일 전체 이미지 (`_detail_r0.png`)는 제외
- Dedup 제거된 섹션의 이미지 참조 → 텍스트 설명으로 교체

### 6.6 출력

```
{sheet_name}/_final/
├── content.md    # 최종 Markdown (메타 헤더 + 본문)
└── images/       # 참조되는 서브 이미지만
```

**content.md 메타 헤더**:
```markdown
---
source_file: PK_변신_및_스킬_시스템.xlsx
sheet_name: 변신
processed_date: 2026-03-08
stage_versions:
  capture: 2.0
  vision: 4.5
  parse_ooxml: 3.0
  synthesize: 2.5
---
```

---

## 7. 실행 구조 (run.py)

### 7.1 2단계 실행

```
Phase A (순차):  run_capture_batch()
  - 단일 Excel COM 인스턴스 생성
  - 104개 파일을 순차 캡처 (이미 캡처된 파일 skip)
  - Excel COM STA 제약으로 병렬화 불가

Phase B (병렬):  run_parallel_pipeline()
  - ThreadPoolExecutor(max_workers=N)
  - 각 워커: _sheet_worker() → Vision → Parse → Synthesize 순차
  - 완료된 시트 (_final/content.md 존재) 자동 skip
```

### 7.2 워크 큐

`build_work_queue()`:
- 모든 대상 파일의 `_capture_manifest.json` 읽기
- 시트별 work_item 생성 (xlsx_path, sheet_dir, sheet_name, tiles)
- skip-done: `_final/content.md` 있으면 제외 (`--force`로 override)

### 7.3 성능 로깅

각 시트 완료 시 1줄 요약:
```
[1234.5s] [ 123/635] PK_HUD 시스템/HUD_기본 -- vis(OK,175s,45,846tok) > parse(OK,1.2s) > synth(OK,4.7s,434lines)  [OK]
```

---

## 8. 기술 제약 및 알려진 이슈

| 이슈 | 영향 | 현황 |
|------|------|------|
| Windows + Excel 필수 | 서버/Linux 배포 불가 | 로컬 개발 환경 전용 |
| ScreenUpdating=True 필수 | CopyPicture 빈 이미지 | True 유지로 해결 |
| CopyPicture 실패 (12건) | 빈/특수 시트 캡처 불가 | 전체 98.1% 성공 |
| 타일 경계 중복/잘림 | 오버랩 구간 콘텐츠 중복 | Dedup 14단계로 대부분 해결 |
| Vision 할루시네이션 | 빈 이미지에 가짜 콘텐츠 | 빈 타일 감지 + anti-hallucination 프롬프트 |
| 회색 오버레이 텍스트 | 비활성 기능의 겹친 텍스트 | 미해결 |
| OCR false positive | 글자 모양 비유사 교정 | changed_chars≤5로 제한, 튜닝 여지 |
| 한글/특수문자 파일명 | 경로 인코딩 문제 | safe_filename() 변환 |
| overview 8000px 초과 | Vision API 리사이즈 왜곡 | LANCZOS 자동 리사이즈 |
