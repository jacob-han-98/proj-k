# xlsx-extractor 스펙 문서

> Excel 기획서 -> AI 지식 베이스 변환 파이프라인의 방법론, 기술 스펙, 출력 구조를 정의한다.

---

## 1. 변환 파이프라인 개요

```
XLSX 파일
  |
  v
[Stage 1: Capture]  Excel -> 시트별 이미지 세트 생성
  |
  v
[Stage 2: Vision]   2-이미지 전략으로 Vision AI 해석
  |
  v
[Stage 3: Parse]    openpyxl로 데이터 보강
  |
  v
[Stage 4: Synthesize] 최종 Markdown + 서브 이미지 합성
  |
  v
[Verify]            Vision AI 랜덤 질의 검증
```

| Stage | 입력 | 출력 | 핵심 기술 |
|-------|------|------|-----------|
| Capture | .xlsx 파일 | 시트별 이미지 세트 (원본/개요/분할) | Excel COM CopyPicture, Pillow |
| Vision | 이미지 세트 | 구조화된 텍스트 + 서브 이미지 후보 | Claude Opus Vision API (AWS Bedrock) |
| Parse | .xlsx 파일 | 셀 데이터, 수식, 숨겨진 행/열 | openpyxl |
| Synthesize | Vision 결과 + Parse 결과 | content.md + images/ | 텍스트 병합, 중복 제거 |
| Verify | content.md + 원본 이미지 | verification.json | Vision AI 랜덤 질의 |

---

## 2. AI 모델 정책

- **기본 모델**: Claude Opus (AWS Bedrock)
- Opus가 아닌 모델 사용 시 **WARNING 로그**를 출력한다
  - 예: `[WARNING] 현재 모델이 Claude Opus가 아닙니다 (model=claude-sonnet). 품질 저하 가능.`
- 모델 설정은 `.env` 파일 또는 CLI 인자로 지정
- Opus 미사용 시에도 실행은 차단하지 않으나, 검증 기준이 더 엄격해질 수 있음

## 3. 환경 변수 및 API 키 관리

API 키는 **서브 프로젝트 내 `.env` 파일**에서 관리한다.

```
packages/xlsx-extractor/.env
```

### .env 파일 형식

```env
# AWS Bedrock 인증
AWS_BEARER_TOKEN_BEDROCK=your-token-here
AWS_REGION=us-east-1

# AI 모델 설정 (기본값: claude-opus)
VISION_MODEL=claude-opus
```

### 로드 규칙
1. `packages/xlsx-extractor/.env`를 최우선으로 로드 (python-dotenv)
2. 환경변수가 이미 설정되어 있으면 .env 값보다 환경변수 우선
3. `.env` 파일은 `.gitignore`에 포함하되, `.env.example`을 함께 제공

---

## 4. Stage 1: Capture (이미지 생성)

### 4.0 왜 Excel COM인가

- **도형/커넥터 렌더링 정확도**: LibreOffice는 Excel 도형의 화살표 방향, 커넥터 연결을 다르게 렌더링하여 플로우차트 해석에 치명적 오류를 유발한다. Excel COM은 원본과 100% 동일하게 렌더링.
- **셀 구분자 보존**: LO 렌더링에서 셀 내 줄바꿈/쉼표가 사라져 "변신,스킬,UI"가 "변신스킬UI"로 합쳐지는 문제. Excel COM은 원본 그대로 보존.
- **PDF 중간 단계 불필요**: CopyPicture는 시트를 직접 비트맵으로 캡처하므로 페이지 나눔 문제가 원천적으로 없음.
- **안정성**: LO는 병렬 실행 시 프로세스 충돌이 잦았으나, Excel COM은 단일 프로세스에서 안정적으로 동작.
- **제약**: Windows + Excel 설치 필수. 향후 서버 배포 시 별도 방안 필요.

### 4.1 시트별 이미지 생성 프로세스

내부 변환 경로: **XLSX → PNG (직접)**

```
XLSX -> [Excel COM CopyPicture] -> 시트별 전체 PNG (페이지 나눔 없음)
     -> [Pillow] -> 개요 이미지 + 분할 상세 이미지
```

Excel COM의 `UsedRange.CopyPicture(xlScreen, xlBitmap)`로 시트 전체를 한 장의 연속 이미지로 캡처한다. PDF 중간 단계가 없으므로 페이지 나눔, 여백, 스케일링 문제가 발생하지 않는다.

1. Excel COM으로 워크북을 열고 각 시트의 UsedRange를 CopyPicture
2. 클립보드에서 PIL ImageGrab으로 비트맵 획득
3. 시트별 full_original.png 저장
4. 빈 시트 감지 (1셀, 빈 값)

### 4.1.1 Excel COM 주의사항

- `Visible=False`: Excel 창을 표시하지 않음
- `ScreenUpdating`은 반드시 **True**: False로 설정하면 CopyPicture가 빈 이미지를 반환함
- `Interactive=False`, `DisplayAlerts=False`, `AskToUpdateLinks=False`: 팝업 억제
- 해상도는 화면 DPI에 의존 (96~120 DPI 기준 약 1400~1800px 너비). Vision AI에 충분한 수준.

### 4.2 Vision AI 이미지 크기 제한

Claude Vision API의 이미지 처리 특성에 따른 크기 기준:

| 구분 | 크기 | 용도 |
|------|------|------|
| 상세 이미지 (detail) | **최대 1568 x 1568 px** | 정밀 해석용, 텍스트/숫자 정확도 극대화 |
| 개요 이미지 (overview) | **최대 1568 px 너비** (비율 유지 축소) | 전체 레이아웃/위치 맥락 파악용 |
| 원본 이미지 (full) | 제한 없음 (300 DPI 원본 보존) | 아카이브, 향후 재처리용 |

> Claude Vision은 1568x1568 이내에서 최적 성능. 이를 초과하면 내부적으로 리사이즈되어 정보 손실 가능.

### 4.3 시트 이미지 분할 전략

하나의 시트가 1568x1568px을 초과할 경우, 그리드 방식으로 분할한다.

#### 분할 시 잘림 방지 제약사항 (필수)

> **절대 규칙: 분할 시 글자, 이미지, 도형이 잘리면 안 된다.**

- 단순 픽셀 기반 그리드 분할만으로는 테이블 행, 텍스트 블록, 이미지가 중간에서 잘릴 수 있다
- **스마트 분할**: 가능한 경우 행/열 경계, 빈 영역, 시각적 구분선을 감지하여 자연스러운 분할점을 찾는다
- **안전 오버랩**: 분할 경계에서 최소 10% 오버랩을 적용하여, 경계에 걸친 요소가 양쪽 타일 모두에 완전히 포함되도록 보장
- **검증**: 분할 후 각 타일의 경계 영역을 검사하여 텍스트/이미지가 잘린 부분이 없는지 확인

#### 분할 알고리즘

```
원본 이미지 크기: W x H

분할 기준 크기: 1568 x 1568 px (DETAIL_MAX)
오버랩 비율: 10% (각 방향)

cols = ceil(W / (DETAIL_MAX * 0.9))    # 가로 분할 수
rows = ceil(H / (DETAIL_MAX * 0.9))    # 세로 분할 수

각 타일:
  tile_w = W / cols + overlap_px
  tile_h = H / rows + overlap_px
  위치: (col * stride_x, row * stride_y)
```

#### 오버랩 (10-15%)

- 인접 타일과 10-15% 겹침 영역을 두어 경계에서의 정보 손실 방지
- 테이블 행이나 플로우차트 연결선이 잘리지 않도록 보장
- 합성 단계에서 오버랩 영역의 중복 텍스트 제거

#### 분할 시 위치 컨텍스트

각 분할 이미지에 다음 메타데이터를 부여:

```json
{
  "tile_id": "detail_r0_c1",
  "grid_position": {"row": 0, "col": 1},
  "grid_total": {"rows": 2, "cols": 3},
  "pixel_region": {"x": 1411, "y": 0, "w": 1568, "h": 1568},
  "position_description": "상단 중앙",
  "overlap": {"left": 157, "right": 157, "top": 0, "bottom": 157}
}
```

### 4.4 시트별 출력 이미지 세트

각 시트에 대해 3종류의 이미지를 생성:

| 파일명 | 설명 | 크기 |
|--------|------|------|
| `full_original.png` | 시트 전체 원본 (Excel COM CopyPicture) | 화면 DPI 기준 |
| `overview.png` | 전체 시트를 Vision AI 크기로 축소 | 최대 1568px 너비 |
| `detail_r{N}.png` | 세로 분할된 상세 이미지 | 각 최대 1568px 높이 |

작은 시트(높이 1568px 이내)는 분할하지 않고 `detail_r0.png` = `overview.png`로 동일.

---

## 5. Stage 2: Vision (AI 해석)

### 5.1 2-이미지 Vision 전략 (핵심)

Vision API 호출 시 **항상 2장의 이미지를 동시 전달**:

```
[API Call]
  Image 1: overview.png (전체 시트 축소본)  -> 위치/맥락 파악
  Image 2: detail_rN_cM.png (해당 영역)    -> 정밀 해석
  Prompt: "Image 1은 전체 시트이며, Image 2는 그 중 {위치} 영역의 상세입니다."
```

**왜 2장인가?**
- 상세 이미지만으로는 해당 영역이 시트 전체에서 어디에 위치하는지 알 수 없음
- 개요 이미지가 "큰 그림"을 제공하여 컨텍스트 보존
- 예: 테이블의 헤더가 상단 타일에만 있어도, 하단 타일 해석 시 개요에서 헤더를 참조 가능

### 5.2 Vision 프롬프트 구조

```
당신은 게임 기획 문서 해석 전문가입니다.

[Image 1]은 Excel 시트 '{시트명}'의 전체 축소 이미지입니다.
[Image 2]는 해당 시트의 {위치 설명} 영역 상세 이미지입니다.
(그리드 위치: row {r}/{total_rows}, col {c}/{total_cols})

다음 규칙에 따라 Image 2의 내용을 구조화된 Markdown으로 변환하세요:

1. 테이블은 Markdown 테이블로 정확히 변환
2. 플로우차트/흐름도는 Mermaid 다이어그램으로 변환
3. 수학적/개념 도형은 텍스트로 최대한 설명
4. 텍스트로 표현 불가능한 시각 요소(게임 UI 스크린샷, 일러스트 등)는
   [IMAGE: 요소에 대한 설명]으로 마킹
5. Image 1을 참고하여 이 영역이 전체 시트에서 어떤 맥락인지 고려
6. 이전 영역과의 연속성을 유지 (테이블이 이어지면 헤더 반복 없이 행만 추가)
```

### 5.3 시트 내 이미지 연속성 보장

한 시트의 분할 이미지들은 **순서대로** 처리하며 연속성을 유지:

1. **처리 순서**: 좌->우, 상->하 (reading order)
   ```
   r0_c0 -> r0_c1 -> r0_c2
   r1_c0 -> r1_c1 -> r1_c2
   ```

2. **이전 컨텍스트 전달**: 각 Vision 호출 시 이전 타일의 해석 결과 요약을 프롬프트에 포함
   ```
   이전 영역({이전 위치})에서 추출된 내용 요약:
   - 테이블 "단축키 매핑"이 진행 중 (현재 12번 행까지)
   - 플로우차트 "전투 흐름"이 시작됨
   ```

3. **합성 시 병합 규칙**:
   - 오버랩 영역의 중복 텍스트 제거
   - 이어지는 테이블은 하나로 병합
   - 플로우차트 노드가 여러 타일에 걸치면 하나로 통합

### 5.4 텍스트 우선 해석 원칙

Vision AI가 시각 요소를 해석할 때의 우선순위:

| 우선순위 | 요소 유형 | 변환 대상 | 예시 |
|----------|-----------|-----------|------|
| 1 | 테이블/표 | Markdown 테이블 | `\| 번호 \| 기능 \| 단축키 \|` |
| 2 | 플로우차트/흐름도 | Mermaid 다이어그램 | `graph TD; A-->B` |
| 3 | 수학적/개념 도형 | 텍스트 설명 + 구조화 | `조건: HP < 30% -> 행동: 회복 물약 사용` |
| 4 | 어노테이션/화살표 | 텍스트 참조 | `(주석) 이 값은 서버 설정에서 변경 가능` |
| 5 | 게임 UI 스크린샷 | **서브 이미지** + 텍스트 설명 | `![HUD 상단 영역](./images/figure_01.png)` |
| 6 | 복잡한 일러스트 | **서브 이미지** + 캡션 | `![캐릭터 변신 컨셉](./images/figure_02.png)` |

**핵심 원칙**: 1~4는 반드시 텍스트로 변환. 5~6만 서브 이미지로 분리.

### 5.5 플로우차트 크롭 재분석 파이프라인

전체 타일 이미지에서 플로우차트 영역은 상대적으로 작아, 긴 커넥터(수평/수직 연결선) 추적이 실패할 수 있다.
이를 해결하기 위해 **3단계 크롭 재분석 파이프라인**을 적용한다:

```
[1st pass] 메인 프롬프트로 전체 타일 해석
    ↓ ```mermaid 블록 감지?
    ↓ Yes
[Locate] 전용 경량 Vision 호출 → 플로우차트 영역 bbox (JSON)
    ↓
[Crop] PIL로 해당 영역 크롭 (높이 50% / 너비 20% 패딩 추가)
    ↓
[2nd pass] FLOWCHART_PROMPT (전용 프롬프트)로 크롭 이미지 재분석
    ↓
[Replace] 1st pass 결과의 mermaid 블록을 2nd pass 결과로 교체
```

**전용 FLOWCHART_PROMPT의 핵심 규칙:**
1. 모든 도형(노드)을 테이블로 나열: | 번호 | 텍스트 | 모양 | 위치 |
2. 각 도형에서 나가는 선의 **개수와 방향**(→↑↓←)을 먼저 파악
3. 각 선을 **끝까지** 추적하여 도착 도형 확인 (꺾임/합류 포함)
4. 출발-도착 쌍을 테이블로 정리 후 Mermaid 변환
5. "긴 수평선/수직선이 이미지 끝까지 이어지는 경우를 놓치지 마세요" 경고

**검증 결과 (변신 시트 합성 플로우차트):**
- 크롭 없이(전체 타일): "합성 진행 불가 → 종료" 연결 실패 (v2~v9, v11)
- 크롭 + 전용 프롬프트: 성공 (v10) — 17.8s, 1,460 tokens

### 5.6 서브 이미지 분리 기준

Vision AI가 `[IMAGE: ...]` 마커를 출력한 요소에 대해:

1. 원본 고해상도 이미지에서 해당 영역을 크롭하여 서브 이미지로 저장
2. 파일명: `figure_{순번:02d}.png` (시트 내 등장 순서)
3. Markdown에서 참조: `![{AI가 생성한 설명}](./images/figure_{순번:02d}.png)`
4. 서브 이미지 메타데이터 기록:
   ```json
   {
     "figure_id": "figure_01",
     "source_tile": "detail_r1_c0",
     "pixel_region": {"x": 200, "y": 500, "w": 400, "h": 300},
     "description": "HUD 상단 영역 - 캐릭터 정보 및 미니맵",
     "reason": "게임 UI 스크린샷으로 텍스트 변환 불가"
   }
   ```

---

## 6. Stage 3: Parse (데이터 보강 + 커넥터 검증)

### 6.0 Stage 3의 목표

Stage 3는 Vision AI의 결과를 **신뢰하되 검증**하는 단계다.

**핵심 원칙: Vision AI 기본 신뢰 + OOXML 데이터로 교정**
- Vision AI의 텍스트 해석, 레이아웃 인식, 테이블 구조화를 기본으로 신뢰한다
- 다만 Vision AI가 **구조적으로 약한 영역**에 한해 OOXML 파싱 데이터로 교정한다:
  1. **커넥터/화살표 연결 관계**: Vision AI는 긴 수평/수직 연결선을 추적하지 못하는 경우가 있음 → OOXML drawing XML에서 커넥터의 start/end shape ID를 추출하여 Mermaid 다이어그램 검증/보정
  2. **도형 내 텍스트 오독**: 해상도 제한으로 "적용 스탯 수"를 "적용 스펙 수"로 읽는 등 오타 발생 → openpyxl/OOXML에서 도형 텍스트를 추출하여 대조/교정
  3. **정밀 수치**: Vision이 읽기 어려운 작은 숫자, 소수점 등 → openpyxl 셀 데이터로 보강

### 6.1 OOXML 커넥터 추출 (핵심 신규 기능)

Excel OOXML의 `xl/drawings/drawingN.xml`에서 도형과 커넥터 데이터를 추출한다.

**구조**:
```xml
<!-- 도형 (sp) -->
<xdr:sp>
  <xdr:nvSpPr><xdr:cNvPr id="39" name="합성 진행 불가"/></xdr:nvSpPr>
  <a:prstGeom prst="roundRect"/>
  <a:t>합성 진행 불가</a:t>
</xdr:sp>

<!-- 커넥터 (cxnSp) -->
<xdr:cxnSp>
  <a:stCxn id="39"/>  <!-- 출발: 합성 진행 불가 -->
  <a:endCxn id="34"/> <!-- 도착: 종료 -->
</xdr:cxnSp>
```

**추출 결과 예시** (변신 시트 합성 플로우차트):
```
시작(id=11) → "합성"버튼클릭(id=9)
"합성"버튼클릭 → 동일 등급 4장의 재료 등록 완료?(id=18)
(조건=Yes) → 합성 진행(id=19)
합성 진행 → 등급별 리스트중 1종 결정(id=26)
등급별 리스트중 1종 결정 → 결과 화면 출력(id=30)
결과 화면 출력 → 종료(id=34)
(조건=No) → 합성 진행 불가(id=39)
합성 진행 불가 → 종료(id=34)          ← Vision AI가 3회 실패한 연결
```

**검증 시나리오**: Vision AI의 Mermaid에서 "합성 진행불가"가 종료와 연결되지 않았으나, OOXML 커넥터 데이터에 `39→34` 연결이 존재 → 자동 보정.

### 6.2 openpyxl 데이터 보강

| 항목 | 설명 |
|------|------|
| 정확한 수치 | Vision이 읽기 어려운 작은 숫자, 소수점 등 |
| 숨겨진 행/열 | `hidden=True`인 행/열 데이터 추출 |
| 수식 | `=SUM(A1:A10)` 등 원본 수식 보존 |
| 셀 병합 정보 | merged_cells 범위 및 값 |
| 데이터 유효성 검사 | 드롭다운 목록, 허용 값 범위 |
| 조건부 서식 | 색상 코딩 규칙 (텍스트로 설명) |
| 시트 간 참조 | 다른 시트 데이터를 참조하는 수식 |

### 6.3 Vision AI vs OOXML 충돌 시 규칙

| 데이터 유형 | 우선 소스 | 이유 |
|-------------|-----------|------|
| 레이아웃/구조 | Vision AI | 시각적 배치를 AI가 가장 잘 이해 |
| 테이블 내용 | Vision AI (openpyxl 검증) | Vision이 주, 수치 오류만 보정 |
| 커넥터/화살표 연결 | **OOXML** | Vision AI의 구조적 약점 (긴 선 추적 실패) |
| 도형 내 텍스트 | **OOXML** | 해상도 제한으로 오독 가능성 |
| 숨겨진 데이터 | **openpyxl** | Vision이 볼 수 없는 정보 |
| 수식/참조 | **openpyxl** | Vision이 결과값만 보고 수식은 못 읽음 |

---

## 7. Stage 4: Synthesize (합성)

### 7.1 합성 프로세스

```
Vision 결과 (타일별 MD)
  |
  +-- 시트 내 타일 병합 (오버랩 중복 제거)
  |
  +-- openpyxl 데이터 보강 적용
  |     - Vision 테이블의 수치를 openpyxl 값으로 교차 검증/교체
  |     - 숨겨진 행/열 데이터 추가 (별도 섹션)
  |     - 수식 정보 각주로 추가
  |
  +-- 서브 이미지 추출 및 저장
  |     - [IMAGE: ...] 마커 -> 원본에서 크롭 -> images/ 폴더
  |     - 마커를 Markdown 이미지 링크로 교체
  |
  v
최종 출력: content.md + images/
```

### 7.2 최종 Markdown 구조

```markdown
# {시트명}

> 원본: {엑셀파일명}.xlsx / 시트: {시트명}
> 변환일: {날짜}
> 검증: {PASS/FAIL} ({정답률}%)

---

## 섹션 1: {Vision이 인식한 첫 번째 논리 블록}

{텍스트 변환 결과}

| 열1 | 열2 | 열3 |
|-----|-----|-----|
| ... | ... | ... |

![{설명}](./images/figure_01.png)

## 섹션 2: ...

---

## 부록: 숨겨진 데이터 (openpyxl 보강)

### 숨겨진 행/열
...

### 수식 목록
...
```

---

## 8. 출력 구조

### 8.1 Vision AI 입력용 (중간 산출물)

```
output/{ExcelFileName}/{SheetName}/_vision_input/
  ├── full_original.png       # 시트 전체 고해상도 (300 DPI)
  ├── overview.png            # 스케일다운 (max 1568px 너비)
  ├── detail_r0_c0.png        # 분할 상세 이미지
  ├── detail_r0_c1.png
  ├── detail_r1_c0.png
  ├── detail_r1_c1.png
  └── tile_manifest.json      # 분할 메타데이터 (그리드, 위치, 오버랩)
```

### 8.2 최종 출력

```
output/{ExcelFileName}/{SheetName}/_final/
  ├── content.md              # 구조화된 텍스트 (Markdown)
  └── images/                 # 텍스트로 해석 불가한 서브 이미지
      ├── figure_01.png
      ├── figure_02.png
      └── image_manifest.json # 서브 이미지 메타데이터
```

### 8.3 메타데이터

```
output/{ExcelFileName}/{SheetName}/_meta/
  ├── extraction_log.json     # 변환 과정 로그 (각 Stage 소요시간, 에러)
  └── verification.json       # 검증 결과 (질의/응답/판정)
```

### 8.4 전체 구조 예시

```
output/
├── PK_단축키_시스템/
│   ├── 히스토리/
│   │   ├── _vision_input/
│   │   │   ├── full_original.png
│   │   │   ├── overview.png
│   │   │   └── detail_r0_c0.png
│   │   ├── _final/
│   │   │   ├── content.md
│   │   │   └── images/
│   │   └── _meta/
│   │       ├── extraction_log.json
│   │       └── verification.json
│   ├── HUD/
│   │   ├── _vision_input/
│   │   │   ├── full_original.png
│   │   │   ├── overview.png
│   │   │   ├── detail_r0_c0.png
│   │   │   ├── detail_r0_c1.png
│   │   │   └── detail_r1_c0.png
│   │   ├── _final/
│   │   │   ├── content.md
│   │   │   └── images/
│   │   │       ├── figure_01.png    # HUD 상단 스크린샷
│   │   │       └── figure_02.png    # HUD 하단 스크린샷
│   │   └── _meta/
│   │       └── ...
│   └── 변신/
│       └── ...
```

---

## 9. 기존 레거시 코드 재사용

| 기존 코드 | 재사용 대상 | 변경 사항 |
|-----------|------------|-----------|
| `convert_xlsx.py` Tier 1+1.5 | Stage 3 (Parse) | OOXML 도형 파싱 로직 분리 |
| `vision_first_convert.py` | Stage 2 (Vision) 참조 | 2-이미지 전략으로 재설계 |

> `lo_sheet_export.py`는 더 이상 사용하지 않음 (LibreOffice → Excel COM으로 전환)

---

## 10. 기술 제약 및 알려진 이슈

| 이슈 | 영향 | 완화 방법 |
|------|------|-----------|
| Excel COM은 Windows+Excel 필수 | 서버/Linux 배포 불가 | 현재 로컬 개발 환경 전용. 서버 배포 시 별도 방안 |
| ScreenUpdating=False 시 빈 이미지 | CopyPicture가 빈 비트맵 반환 | ScreenUpdating는 반드시 True 유지 |
| 화면 DPI 의존 | 모니터 해상도에 따라 출력 크기 변동 | 96~120 DPI에서 1400~1800px 너비, Vision AI에 충분 |
| Vision API 비용 | 대량 변환 시 비용 증가 | 빈 시트 건너뛰기, 캐싱 |
| 매우 큰 시트 (50+ 타일) | 합성 복잡도 증가 | 타일 수 상한 설정 + 경고 |
| 한글/특수문자 파일명 | Windows cp949 인코딩 | safe_filename() 변환 |
