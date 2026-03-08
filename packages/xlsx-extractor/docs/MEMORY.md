# xlsx-extractor 작업 기록

> 이 파일은 서브 프로젝트의 진행 상태를 세션 간 유지하기 위한 기록이다.
> 새 세션 시작 시 반드시 이 파일을 먼저 읽는다.

---

## 현재 집중 대상

**PK_변신 및 스킬 시스템.xlsx** — 13시트, 사용자가 가장 익숙한 파일로 개발/검증 진행 중

## 현재 상태: 전체 104파일 일괄 변환 완료 (623/635 시트 OK, 98.1%)

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

### run.py v2 — 시트별 병렬 워크플로우 (2026-03-08)

**구현**: `run.py` — 배치 입력 + 시트별 독립 파이프라인

**v1 → v2 아키텍처 변경**:
- v1: Stage별로 모든 시트 처리 (Capture ALL → Vision ALL → Parse ALL → Synth ALL)
- **v2: 시트별 독립 워크플로우** (각 시트가 Vision→Parse→Synth 순차, N개 병렬)

**2단계 실행 구조**:
- Phase A (순차): Capture — 단일 Excel COM 인스턴스로 모든 파일/시트 캡처
  - `capture.py`에 `excel_app` 파라미터 추가 → 104개 파일을 1개 Excel로 처리
- Phase B (병렬 N): Vision → Parse → Synthesize — 시트별 독립 워크플로우
  - ThreadPoolExecutor로 N개 워커, 각각 1시트씩 전 Stage 순차 처리

**CLI**:
- 다중 입력: `run.py file1.xlsx folder/ --parallel 10`
- `--all`: 모든 알려진 폴더 (7_System, 2_Development, 3_Base, 9_MileStone)
- `--parallel N`: 시트별 병렬 워커 수 (default: 1)
- `--force`: 이미 완료된 시트도 재처리 (기본: `_final/content.md` 있으면 skip)
- `--sheet`, `--stage`, `--clean`, `--dry-run` 기존 호환

**검증**: PK_단축키 시스템.xlsx (3시트, parallel=3) — 58초, 3/3 OK

**전체 실행 결과 (2026-03-08)**:

| 항목 | 값 |
|---|---|
| 입력 | 104 files, 635 sheets (16 skipped as already done) |
| 설정 | `--all --parallel 10` |
| **총 소요 시간** | **109.2분 (1시간 49분)** |
| Phase A (Capture) | 99/104 파일 캡처 (5파일은 이미 완료) |
| Phase B (Pipeline) | **623/635 시트 OK, 12 실패** |
| 총 토큰 | 12,318,975 (약 1,230만) |
| 성공률 | **98.1%** |

**실패 12건 (모두 Capture 단계 CopyPicture 오류 → tile_manifest.json 없음)**:
- PK_레벨업 시스템/개요, PK_인스턴스 시스템/temp, PK_전투력 시스템/전투력 시스템
- PK_캐릭터 성장 밸런스/장비 밸런스, PK_텔레포트 시스템/텔레포트
- PK_튜토리얼,도움말_시스템/개요, PK_장비 밸런스 및 데이터/장비 분해 밸런스+장비 제작
- PK_리니지M_데이터구조/데이터 구조 추출, PK_바리울_레벨/!!숨기기 있음!!
- PK_비대면 지문/목표 및 개요, PK_프로토 플레이 콘티/맵과 씬 연결
- 원인: Excel COM `CopyPicture` 메서드 오류 (빈 시트, 차트 전용, 숨겨진 시트 등)

### synthesize.py dedup 버그 수정 (2026-03-08)

**증상**: 변신 시트 content.md에서 (5)~(8) 섹션 전체 누락
**원인**: `_remove_analysis_metadata()`에서 `## Step 4: 주석 정보`가 `skip_until_heading_level = 2` 설정 → 이후 `### (5) 성장&강화` 등 level 3 헤딩이 모두 스킵됨
**수정**: 스킵 종료 로직을 메타데이터 헤딩(Step, 주석 정보 등)과 콘텐츠 헤딩 구분으로 변경. 콘텐츠 헤딩이면 레벨 무관하게 스킵 즉시 종료. blockquote 보존도 추가.

### Stage 3: Parse OOXML (리팩토링 완료, 2026-03-08)

**구현**: `parse_ooxml.py` (구 parse.py에서 이름 변경)
**변경**: Vision 출력 in-place 수정 → `_parse_ooxml_output/` 중간 결과 디렉토리로 분리

**입출력**:
- 입력: 원본 XLSX + `_vision_output/merged.md`
- 출력: `_parse_ooxml_output/`
  - `merged.md` — Mermaid 보정이 있을 때만 생성
  - `parse_meta.json` — 검증 결과 메타데이터 (항상)
  - `grade_colors.json` — 등급 색상 매핑 (데이터 있을 때)
  - `text_corpus.json` — OOXML 텍스트 코퍼스 (OCR 교정용)

**Stage 4 연동**: synthesize.py가 `_parse_ooxml_output/merged.md` 존재 시 사용, 없으면 `_vision_output/merged.md` fallback

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

### Stage 4: Synthesize (구현 완료 + Dedup 2.0 최적화, 2026-03-08)

**구현**: `synthesize.py` — Vision + Parse 결과 합성 → `_final/content.md` + `_final/images/`

**핵심 기능 (Dedup 2.5 — 14단계 파이프라인)**:
1. **타일 섹션 헤더 제거**: `# SheetName - Section N/M`, 일반화 패턴
2. **분석 메타데이터 제거**: Step blocks, HTML comments, 시트 요약, 플로우차트 분석 헤딩
   - Step block에서 mermaid 보존 후 skip 종료 (콘텐츠 소실 방지)
   - `## 이전 섹션에서 계속...` 제거는 Step block 처리 이후 실행 (순서 의존성)
   - Vision self-commentary 제거 (`**[참고]**: ...이미지에는...표시되지 않았습니다`)
   - 다양한 continuation marker 제거 (6종)
3. **`(계속)` 접미사 제거**: 모든 헤딩에서
4. **연속 중복 헤딩 정리**: 부모 컨텍스트 반복 제거
5. **반복 부모 헤딩 축소**: 타일 경계 반복 컨테이너 제거
6. **분할 테이블 병합**: 동일 헤딩+테이블 헤더 → 행 합치기 (set-based dedup)
7. **원거리 중복 섹션 제거**: 동일 제목 leaf 섹션 중 긴 것 유지
   - same-level + cross-level + parent+leaf 3종 매칭
   - 번호 체계 정규화 (①②③ vs (1)(2)(3)) cross-numbering 매칭
   - normalized line 비교 (blockquote/bold 제거)
   - prefix title matching (짧은 제목이 긴 제목의 접두사이면 동일 그룹)
7.5. **동일 콘텐츠 연속 섹션 제거**: 다른 제목, 같은 내용 → 뒤쪽 유지
7.6. **orphan 레벨 헤딩 제거**: 잘못된 레벨로 출력된 짧은 중복 (overlap ≥40% 시에만)
7.65. **동일 제목 continuation 병합**: (계속) 제거 후 동일 제목 인접 섹션 내용 합치기
7.7. **bold-heading 중복 제거**: `**Title**`이 이미 존재하면 `## Title` heading 제거
8. **불완전 잘림 섹션 제거**: < 5줄의 짧은 중복
8.5. **중복 blockquote annotation 제거**: 동일 key의 `> **[key]**` 중복
8.6. **Meta-commentary 제거**: Vision AI self-reference 텍스트
9. **# SheetName 중복 정리** + 빈 줄 정리

**기타 기능**:
- Parse 보정 통합: OOXML Mermaid 검증/보정 자동 적용
- 메타데이터 헤더: 원본 파일, 시트명, 변환일, 파이프라인 버전
- 서브 이미지 정리: 참조되는 이미지만 `_final/images/`에 복사
- Dangling 참조 처리: dedup 제거 섹션의 이미지 참조 → 텍스트 설명 교체

**최종 처리 결과 (PK_변신 및 스킬 시스템.xlsx) — Dedup 2.5 적용 후**:

| 시트 | Lines | Bytes | Dedup | Images | Parse | Score |
|------|-------|-------|-------|--------|-------|-------|
| UI_변신_강화 | 179 | 12,157 | -161 | 8 | +1 edge | 96 |
| UI_변신_기본 | 280 | 19,076 | -69 | 7 | - | 78* |
| UI_변신_컬렉션 | 27 | 694 | 0 | 0 | - | 100 |
| UI_변신_합성 | 232 | 19,968 | -137 | 12 | verified | 93 |
| UI_변신_확정 | 30 | 768 | 0 | 0 | - | 100 |
| UI_스킬 | 164 | 13,828 | -97 | 8 | - | 92 |
| 변신 | 440 | 19,937 | -397 | 3 | +4 edges | **95** |
| 스킬 | 340 | 17,168 | -120 | 4 | verified | 95 |
| 스킬 기능 리스트 | 528 | 24,597 | -190 | 5 | +1 edge | 96 |
| 아트_연출 리스트 | 38 | 1,705 | -1 | 0 | - | 100 |
| 주요 정의 | 91 | 5,607 | -1 | 0 | - | 97 |
| 테이블 정보 | 27 | 708 | -3 | 0 | - | 95 |
| 히스토리 | 91 | 20,000 | -56 | 0 | - | 97 |
| **합계** | **2,467** | **155,213** | **-1,232** | **47** | | |

- 총 출력: 2,467줄, 155KB, 47개 서브 이미지
- **95+ 달성: 10/13 시트**
- 소요 시간: <1초 (API 호출 없음)

**Dedup 2.1 추가 개선 (2026-03-08)**:
- "(이어서)" 접미사 제거 (기존 "(계속)"에 추가)
- 타일 섹션 헤더 `(섹션 N/M - 이어서)` 패턴 추가
- Vision 타일 경계 continuation note 제거 (`*[이미지가...계속됨]*`)
- 동일 콘텐츠 비교: 깊은 정규화 (번호체계/조사/주석 라인 무시)
- orphan level 헤딩: deep→shallow 순서도 감지

**변신 시트 품질 개선 사이클 (Dedup 2.5, 2026-03-08)**:

사용자가 Vision 입력 이미지와 최종 출력을 직접 대조 검증 요청 → 5회+ 반복 개선 사이클 수행.

*Vision.py 수정사항*:
- Anti-hallucination SYSTEM_CONTEXT 추가: "원본 이미지에 없는 내용을 절대 생성하지 마세요"
- 누적 컨텍스트 축소: last 4000자 → last 2 heading sections (max 3000자)
  - 과도한 컨텍스트가 할루시네이션 유발 (이전 섹션 내용을 새로 생성)
- Continuation context에 "참고용일 뿐, 절대 반복 금지" 경고 강화

*Synthesize.py 신규 dedup 단계*:
- **Step 7 강화**: `_normalize_line()` — blockquote `>` prefix, bold `**` 제거 후 비교
- **Step 7 강화**: prefix title matching (2.7차) — "③ 기타 사항"이 "③ 기타 사항 (이미지 하단 텍스트)"의 prefix면 동일 그룹
- **Step 7.6 강화**: orphan level heading 제거 시 overlap ratio ≥0.4 검사 추가 (false positive 방지)
  - 수정 전: 같은 제목 + <15줄이면 무조건 제거 → (4) 합성의 텍스트 불릿이 소실됨
  - 수정 후: 콘텐츠의 40%+ 가 survivor에 존재할 때만 제거
- **Step 7.65 (신규)**: `_merge_same_heading_continuations()` — (계속) 제거 후 동일 제목 인접 섹션 병합
  - 첫 섹션의 **전체** 콘텐츠 라인으로 overlap 감지 (last 10줄만이 아닌)
- **Step 7.7 (신규)**: `_remove_bold_heading_duplicates()` — `**Title**` bold text가 이미 존재할 때 `## Title` heading 제거
  - 보수적: heading + 직후 최대 3줄만 제거 (bold 이후 5줄과 매칭)
  - mermaid 블록 파괴 방지를 위해 bold 이후 5줄만 비교
- **Step 8.5 (신규)**: `_remove_duplicate_annotations()` — 동일 key의 `> **[key]** 주석:` blockquote 중복 제거
- **Step 8.6 (신규)**: Meta-commentary 제거

*발견된 버그 및 해결*:
1. (4) 합성 텍스트 불릿 소실: Step 7.6 orphan 제거가 원인 → overlap check 추가로 해결
2. Mermaid 블록 파괴: `_remove_bold_heading_duplicates()` 초기 버전이 mermaid 코드 fence를 제거 → bold 이후 5줄만 비교로 수정
3. (5) 성장&강화 continuation merge 불완전: last 10줄만 overlap 체크 → 전체 라인으로 변경

**병렬 실행 검증 (2026-03-08)**:
- 사용자 피드백: --parallel 4 실행 시 변신 시트에 5가지 문제 발생
  - 시스템 메시지 섹션 누락, 플로우차트 주석 오배치, 엉뚱한 콘텐츠 삽입 등
- 순차 실행(parallel=1)으로 재실행 시 3/5 이슈 즉시 해결
- **결론**: 병렬 API 호출이 컨텍스트 오염 유발. 원인 미확정 (Bedrock API 측 이슈 추정)
- **권장**: parallel=1 사용, 병렬은 당분간 비활성

**95 미만 시트 분석**:
- **UI_변신_기본 (78)**: 섹션 ③-⑤의 OCR 오독. 원인: Excel 임베디드 이미지. openpyxl/OOXML 보정 불가. Vision 재실행만이 해결책
- **UI_변신_합성 (93)**: 섹션 순서가 타일 캡처 순서 반영. 콘텐츠는 완전함
- **UI_스킬 (92)**: 타일 경계 테이블 분절 + 일부 garbled annotation

**OOXML 보정 추가 기능 (2026-03-08)**:

*vision.py*:
- `is_blank_tile()`: PIL/numpy 분석으로 빈 타일 감지 → Vision API 호출 스킵
  - 변신 r6 (빈 흰색 이미지)에서 "⑤ 외부 참조" 할루시네이션 방지

*parse.py*:
- `extract_grade_colors()`: OOXML 셀 배경색 추출 (theme color + tint 해석)
- `rgb_to_color_name()`: RGB hex → 한국어 색상명 매핑
- `extract_ooxml_text_corpus()`: 셀 + 도형 텍스트 전체 수집
- Diamond 노드 구조적 매칭: 텍스트 없는 마름모를 이웃 노드 기반으로 매핑 (≥2 공통 이웃)
- `apply_corrections()`: 오판 엣지 제거 기능 추가 (3-tuple 반환: code, added, removed)

*synthesize.py*:
- **Step 3.5** `correct_grade_colors()`: Vision AI 근사 색상을 OOXML 정확한 hex로 교정
- **Step 3.6** `correct_ocr_typos()`: LLM(Sonnet) 기반 OCR 오타 교정
  - OOXML 텍스트 코퍼스를 ground truth 참고로 제공
  - 구조 보존 검증: 라인 수/헤딩/테이블/mermaid 불변
  - 변경 글자 수 검증 (SequenceMatcher, changed_chars ≤ 5)
  - temperature=0, JSON 파싱 견고화
  - 변신 시트: 10건 교정 (알파>→알파2, 가체→개체, 펑타→평타 등)
  - 시트당 ~15K input tokens, 23초 (Sonnet API 1회)
- `call_text_api()`: Bedrock 텍스트 전용 API 호출 (OCR_MODEL 환경변수)

**미해결**:
- 회색 오버레이 패턴: 비활성 기능의 겹친 텍스트 처리
- OCR 교정 false positive: "세션→패시브" 등 글자 모양 비유사 교정 — 프롬프트 튜닝 여지

### Verification (미착수)
- Vision AI 랜덤 질의 검증

---

## 파일 구조

```
packages/xlsx-extractor/
├── src/
│   ├── capture.py      # Stage 1 (Excel COM 캡처)
│   ├── vision.py       # Stage 2 (Vision AI 분석)
│   ├── parse_ooxml.py  # Stage 3 (Parse OOXML)
│   └── synthesize.py   # Stage 4 (합성 + dedup + OCR 교정)
├── docs/
│   ├── MEMORY.md       # 이 파일 - 작업 기록
│   ├── README.md       # 서브 프로젝트 개요
│   ├── SPEC.md         # 상세 스펙
│   └── VERIFICATION.md # 검증 프로토콜
├── run.py              # 통합 파이프라인 실행 스크립트
├── .env.example        # 환경변수 템플릿
└── output/             # 변환 결과물 (.gitignore)
```
