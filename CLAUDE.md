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
| **1단계: 지식화** | 엑셀/PDF/PPT 기획서 → 구조화된 지식 베이스 | 진행중 |
| **2단계: QnA API** | Backend API로 Project K 기획 QnA 서비스 | 미착수 |
| **3단계: 기획 리뷰** | 기존 기획 충돌/누락 감지, 신규 기획서 리뷰 | 미착수 |
| **4단계: 실시간 어시스턴트** | Confluence/Excel 모니터링 + 실시간 기획 조언 UX | 미착수 |

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
├── _knowledge_base/            # 변환 결과물 (AI가 읽을 지식)
│   ├── PROJECT_K_KNOWLEDGE_BASE.md  # 통합 지식 베이스
│   ├── knowledge_graph.json    # 시스템 간 관계 그래프
│   ├── sheets/                 # XLSX 변환 결과 (시트별)
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
| XLSX | 104개 | 2/104 | 7_System 67개가 핵심 |
| PDF  | 296개 | 0/296 | Confluence 내보내기 |
| PPTX | 11개  | 1/11 | 컨셉/방향성 문서 |

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

### 진행 기록 (필수)
- **`docs/MEMORY.md`**에 모든 작업 진행 과정을 기록한다
- 세션 시작 시 반드시 `docs/MEMORY.md`를 먼저 읽고 이전 상태를 파악한다
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
