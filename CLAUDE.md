# Project K - AI 기획 어시스턴트 프로젝트

## 프로젝트 개요

모바일 MMORPG "Project K"의 전체 기획 지식을 AI가 완전히 이해하고 활용할 수 있도록 구조화하여,
**기획 QnA, 기획서 리뷰, 신규 기획 작성을 지원하는 AI 에이전트**를 만드는 프로젝트.

### 최종 목표

Claude LLM API와 결합된 에이전트가 Project K의 기획 내용을 가장 잘 아는 전문가처럼
기획자의 작업을 실시간으로 보조하는 것.

## 프로젝트 단계

| 단계 | 목표 | 상태 |
|------|------|------|
| **1단계: 지식화** | 엑셀/PDF/PPT 기획서 → 구조화된 지식 베이스 | Excel 완료 (98.1%) |
| **2단계: QnA API** (PoC) | Backend API로 기획 QnA | **진행중** |
| **3단계: 데이터 확장 & 동기화** | Confluence/PPTX 변환 + Perforce 동기화 | 미착수 |
| **4단계: 기획 리뷰** (PoC) | 기존 기획 충돌/누락 감지, 신규 기획서 리뷰 API | 미착수 |
| **5단계: 실시간 어시스턴트** (PoC) | 맥락 인식 실시간 피드백 API | 미착수 |
| **피칭** | 경영진/이해관계자 시연 → 승인 | - |
| **6단계: 사내 서비스** | 동기화 고도화 + 배포 + 권한 + UX | 미착수 |
| **7단계: 업무 프로세스 통합** (후보) | JIRA + Perforce 로그 + Slack + Email 연동 | 후보 |
| **8단계: 조직 인텔리전스** (후보) | 전사 Slack 기반 R&R·커뮤니케이션·의사결정 병목 분석 | 후보 |

> 각 단계의 상세 스펙은 `docs/VISION.md` 참조

## 폴더 구조

```
proj-k 기획/
├── CLAUDE.md                   # 이 파일 - 프로젝트 안내서
├── docs/                       # 프로젝트 문서
│   ├── VISION.md               # 목표, 로드맵, 단계별 상세 스펙
│   ├── ARCHITECTURE.md         # 기술 아키텍처 설계
│   ├── DECISIONS.md            # 주요 의사결정 히스토리
│   └── MEMORY.md               # 작업 진행 상태 (세션 간 항상성 유지)
│
├── ConvertProgram/             # 1단계: 변환 파이프라인
│   └── _tools/                 # 변환 스크립트
│       ├── convert_xlsx.py     # XLSX → Markdown (Tier 1 + 1.5)
│       ├── convert_pdf.py      # PDF → Markdown
│       ├── convert_pptx.py     # PPTX → Markdown
│       ├── capture_screenshots.py # XLSX 시트 → PNG 스크린샷
│       ├── vision_reinforce.py # Vision API 기반 이미지 분석/보강
│       ├── planner_review.py   # 기획자 리뷰 필요 항목 감지
│       ├── run_all.py          # 전체 일괄 변환
│       └── file_manifest.json  # 변환 대상 파일 목록
│
├── packages/                    # 서브 프로젝트
│   ├── xlsx-extractor/          # ★ Excel 변환 파이프라인 (완료)
│   │   ├── src/                 # capture.py, vision.py, parse_ooxml.py, synthesize.py
│   │   ├── run.py               # 통합 실행 스크립트
│   │   ├── output/              # 변환 결과 (629개 content.md)
│   │   └── docs/                # README, SPEC, VERIFICATION, MEMORY
│   └── qna-poc/                 # ★ QnA PoC (착수 예정)
│
├── _knowledge_base/            # 변환 결과물 (AI가 읽을 지식)
│   ├── PROJECT_K_KNOWLEDGE_BASE.md  # 통합 지식 베이스
│   ├── knowledge_graph.json    # 시스템 간 관계 그래프 (405시스템, 627관계)
│   ├── sheets/                 # XLSX 변환 결과 (레거시)
│   ├── pptx/                   # PPTX 변환 결과
│   └── images/                 # XLSX 내장 이미지 추출
│
├── 1_High_Concept/             # [원본] 컨셉 문서 (pptx 4개)
├── 2_Development/              # [원본] 개발 구조 (xlsx 2, pptx 1)
├── 3_Base/                     # [원본] 기본 설정 (xlsx 6, pptx 3)
├── 7_System/                   # [원본] ★ 핵심 시스템 기획서 (xlsx 67개)
├── 9_MileStone/                # [원본] 마일스톤 기획서 (xlsx 28, pptx 2)
└── Confluence PDF Sync/        # [원본] Confluence PDF (296개)
```

## 원본 문서 현황

| 유형 | 개수 | 변환 완료 | 비고 |
|------|------|-----------|------|
| XLSX | 104개 | **623/635 시트 (98.1%)** | xlsx-extractor로 완료 |
| PDF  | 296개 | 0/296 | 확장 트랙 (QnA 결과에 따라) |
| PPTX | 11개  | 1/11 | 후순위 |

## 변환 파이프라인 (1단계 도구)

### 변환 전략 (Vision-First)

기존: Excel 파싱(openpyxl) → MD → Vision API 보정
**신규: Vision API 먼저 (스크린샷→AI 분석) → Excel 데이터로 보강**

```
XLSX/PDF/PPTX
  │
  ├─ [1차] 스크린샷 캡처 (headless) → Vision API로 전체 내용 인식
  │        Vision이 잘 읽는 것: 레이아웃, 도형, 플로우차트, 이미지 내 텍스트
  │
  ├─ [2차] Excel 데이터 파싱으로 보강
  │        Vision이 약한 것: 정확한 수치, 숨겨진 셀, 수식, 데이터 테이블
  │
  └─ [합성] 두 결과를 병합하여 최종 Markdown 생성
```

**왜 순서를 바꾸는가?**
- 기존 방식은 openpyxl이 못 읽는 도형/이미지(정보의 80%)를 나중에 Vision으로 보정 → 한계 명확
- Vision API가 먼저 전체 그림을 잡고, 수치/테이블만 Excel 데이터로 정밀 보강하는 게 더 자연스러움

### 원본 소스 (향후)
- 현재: 임시 복사본 (로컬 폴더)
- 향후: Perforce(Excel) + Confluence(PDF) 실시간 동기화 → 변경 감지 → 자동 재변환

### Vision-First 스크립트 (신규)
```bash
pip install openpyxl pymupdf pillow python-dotenv anthropic
# ConvertProgram/.env 에 AWS_BEARER_TOKEN_BEDROCK 설정 필수
python ConvertProgram/_tools/vision_first_convert.py "7_System/PK_단축키 시스템.xlsx"  # 단일 변환
python ConvertProgram/_tools/vision_first_convert.py --folder 7_System --dry-run       # 폴더 대상 확인
python ConvertProgram/_tools/vision_first_convert.py --folder 7_System --skip-existing # 일괄 변환
```

### 환경변수 설정 방침
- **API 키는 `ConvertProgram/.env` 파일에서 관리한다**
- `.env.example`을 복사하여 `.env`를 만들고 실제 값을 채운다
- `.env` 파일은 절대 버전 관리에 포함하지 않는다
- 모든 변환 스크립트는 실행 시 자동으로 `.env`를 로드한다

### 기존 스크립트 (레거시, 참고용)
```bash
pip install openpyxl pymupdf python-pptx
python ConvertProgram/_tools/run_all.py --dry-run       # 대상 확인
python ConvertProgram/_tools/run_all.py --skip-existing  # 일괄 변환
```

### 품질 기준 (시범 변환 검증 완료)
- 시범 변환(변신/스킬 시스템): 2KB → 200KB (100배) 정보량 확보
- Tier 1 셀 데이터: 원본 행 90%+ 반영
- Tier 1.5 도형: 327/327 추출, 연결선 123/123 매핑

## Claude Code 작업 규칙

### 개발 방침: 작은 데이터부터 검증하며 진행 (필수)

전체 데이터(104 XLSX, 296 PDF 등)는 양이 방대하다. **절대 처음부터 전체를 돌리지 않는다.**

1. **최소 단위 테스트 먼저**: 새 기능/파이프라인 개발 시 반드시 **1개 시트** 또는 **1개 파일**로 먼저 테스트
2. **검증 후 확대**: 1개 성공 → 1개 파일 전체 시트 → 같은 유형 여러 파일 → 전체 일괄 순서로 확대
3. **대표 파일 지정**: 각 서브 프로젝트는 개발/검증용 대표 파일을 정하고, 해당 파일로 모든 새 기능을 먼저 확인
   - xlsx-extractor: `PK_변신 및 스킬 시스템.xlsx` (13시트, 다양한 콘텐츠 유형 포함)
4. **단계별 확인**: 파이프라인의 각 Stage를 독립적으로 실행·검증할 수 있게 설계
5. **실패 시 범위 축소**: 문제 발생 시 전체를 다시 돌리지 말고, 실패한 단일 항목으로 범위를 좁혀 디버깅

이 방침은 사용자와 Claude 모두에게 적용된다. 계획 수립 시에도 이 순서를 따른다.

### 성능 측정 및 최적화 관리 (필수)

모든 파이프라인 스크립트는 **단계별 성능 로그를 남긴다.** 비용과 시간이 큰 작업이므로 병목을 파악하고 최적화해야 한다.

1. **단계별 타이밍 측정**: 각 처리 단계(이미지 인코딩, API 호출, 응답 파싱, 프롬프트 빌드 등)의 소요 시간을 개별 측정
2. **입출력 크기 기록**: 이미지 파일 크기, 프롬프트 문자 수, 토큰 수 등 비용에 영향을 주는 지표
3. **성능 메타데이터 저장**: `vision_meta.json` 등에 타이밍/크기 정보를 구조화하여 저장 — 이후 분석/비교 가능
4. **시트/파일 단위 요약**: 실행 완료 시 시트별 성능 요약 테이블 출력 (타일 수, 토큰, API 시간, throughput)
5. **병목 식별 기준**:
   - API 호출: 타일당 평균 시간, output tokens/second
   - 누적 컨텍스트: 뒤쪽 타일일수록 프롬프트가 커지는 패턴 → 토큰 증가 추이 모니터링
   - 이미지 인코딩: 파일 크기 대비 인코딩 시간
6. **최적화 기회 발견 시 MEMORY.md에 기록**: 측정 결과에서 명확한 병목이 보이면 기록하고 다음 세션에서 개선
7. **실행 결과 요약 보고 (필수)**: 프로그램 실행 후 Claude는 단순히 로그를 보여주는 것에 그치지 않고, **유의미한 인사이트를 캐치하여 요약 보고**한다:
   - 예상 대비 느린/빠른 항목, 토큰 사용 추이, 이전 실행 대비 변화
   - 최적화 가능 포인트 (예: "뒤쪽 타일이 2배 느림 — 누적 컨텍스트 크기 때문")
   - 비정상 패턴 (특정 타일 실패, 재시도, 비정상적 토큰 수 등)
8. **장시간 실행 시 중간 상태 보고**: 1분 이상 걸리는 작업은 반드시 **예상 소요 시간을 사전에 안내**하고, 가능하면 **실시간 진행 상황이 보이는 방식**으로 실행한다. 사용자가 정상 동작인지 오동작인지 판단할 수 없는 "가만히 기다리는" 상태를 만들지 않는다.

### 진행 기록 (필수)
- **`docs/MEMORY.md`**에 프로젝트 전체 진행 과정을 기록한다
- **서브 프로젝트는 각자의 `MEMORY.md`에 상세 기록한다**:
  - `packages/xlsx-extractor/docs/MEMORY.md` — Excel 변환 서브 프로젝트
- 세션 시작 시 현재 작업 중인 서브 프로젝트의 MEMORY.md를 먼저 읽고 이전 상태를 파악한다
- 작업 단계 완료 시 즉시 업데이트한다
- 주요 의사결정은 `docs/DECISIONS.md`에 별도 기록한다

### 변환 작업 시
1. `run_all.py --dry-run`으로 대상 확인
2. `--type xlsx`로 유형별 순차 실행
3. 오류 시 단일 파일로 디버깅
4. `--skip-existing`으로 중단 후 이어서 작업

### 코드 작업 시
- `convert_xlsx.py`의 계층 마커 패턴은 Project K 문서 특화
- OOXML 네임스페이스는 표준이므로 모든 xlsx/pptx에 공통
