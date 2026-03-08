# xlsx-extractor

Excel 기획서를 AI가 활용할 수 있는 구조화된 Markdown + 서브 이미지로 변환하는 파이프라인.

## 상위 프로젝트

**Project K AI 기획 어시스턴트** (`proj-k 기획/`)의 1단계(지식화) 핵심 모듈.
104개 Excel 기획서 → AI 지식 베이스 변환 담당.

## 변환 결과 (2026-03-08)

| 항목 | 값 |
|---|---|
| 입력 | 104 파일, 635 시트 |
| 성공 | 623 시트 (98.1%) |
| 소요 시간 | 109분 (parallel=10) |
| 총 토큰 | 12.3M |

## 파이프라인 아키텍처

```
XLSX 파일
  │
  ├─ [Stage 1: Capture]   Excel COM CopyPicture → 시트별 PNG → 세로 분할 타일
  │
  ├─ [Stage 2: Vision]    Claude Opus Vision API (overview + detail 2-이미지 전략)
  │                        텍스트 우선 해석 / 플로우차트→Mermaid / 서브 이미지 추출
  │
  ├─ [Stage 3: Parse]     OOXML drawing XML에서 커넥터/도형 추출 → Mermaid 검증/보정
  │                        등급 색상 추출 + OCR 교정용 텍스트 코퍼스 생성
  │
  └─ [Stage 4: Synthesize] 14단계 중복 제거 + OCR 교정(Sonnet) + 등급 색상 보정
                           → content.md + images/
```

## 빠른 시작

### 환경 설정

```bash
pip install openpyxl pillow python-dotenv anthropic pywin32 numpy
```

`.env.example`을 복사하여 `.env` 생성:
```
AWS_BEARER_TOKEN_BEDROCK=your-token
AWS_REGION=ap-northeast-2
```

### 실행

```bash
# 단일 파일
python run.py "7_System/PK_단축키 시스템.xlsx"

# 폴더 내 전체
python run.py "7_System/" --parallel 10

# 전체 104파일 일괄
python run.py --all --parallel 10

# 미리보기 (실행 안 함)
python run.py --all --dry-run

# 이미 완료된 시트 재처리
python run.py "7_System/PK_HUD 시스템.xlsx" --force
```

### CLI 옵션

| 옵션 | 설명 |
|------|------|
| `--all` | 4개 폴더 전체 (7_System, 2_Development, 3_Base, 9_MileStone) |
| `--parallel N` | 시트별 병렬 워커 수 (기본: 1) |
| `--force` | 완료된 시트도 재처리 |
| `--stage STAGE` | 특정 단계만 실행 (cap, vis, par, syn 또는 범위 vis-syn) |
| `--sheet NAME` | 특정 시트만 처리 |
| `--dry-run` | 대상 파일/시트 목록만 출력 |
| `--clean` | 출력 디렉토리 삭제 |

## 실행 구조

```
Phase A (순차)    단일 Excel COM 인스턴스로 모든 파일/시트 캡처
                  ↓
Phase B (병렬 N)  시트별 독립 워크플로우: Vision → Parse → Synthesize
                  각 워커가 1시트를 처음부터 끝까지 순차 처리
```

- **Phase A가 순차인 이유**: Excel COM은 단일 스레드 전용 (Win32 STA)
- **Phase B가 병렬 가능한 이유**: 시트 간 완전 독립 (API 호출, 파일 I/O 모두 분리)
- **타일 내부는 순차**: 이전 타일 결과를 다음 타일의 누적 컨텍스트로 사용

## 출력 구조

```
output/
└── PK_HUD 시스템/                    # 엑셀 파일별
    └── HUD_기본/                      # 시트별
        ├── _vision_input/             # Stage 1 출력
        │   ├── full_original.png      # 시트 전체 원본
        │   ├── overview.png           # 축소본 (max 1568px 너비)
        │   ├── detail_r0.png ~ rN.png # 세로 분할 타일
        │   └── tile_manifest.json     # 타일 메타데이터
        ├── _vision_output/            # Stage 2 출력
        │   ├── detail_r0.md ~ rN.md   # 타일별 Vision 결과
        │   ├── merged.md              # 타일 병합 결과
        │   ├── images/                # 추출된 서브 이미지
        │   └── vision_meta.json       # 성능 메타 (토큰, 타이밍)
        ├── _parse_ooxml_output/       # Stage 3 출력
        │   ├── merged.md              # Mermaid 보정 적용 시만 생성
        │   ├── parse_meta.json        # 검증 결과
        │   ├── grade_colors.json      # 등급 색상 매핑
        │   └── text_corpus.json       # OOXML 텍스트 (OCR 참조용)
        └── _final/                    # Stage 4 최종 출력
            ├── content.md             # 최종 Markdown
            └── images/                # 참조되는 서브 이미지만
```

## 의존성

| 패키지 | 용도 |
|--------|------|
| `pywin32` | Excel COM CopyPicture (Windows 전용) |
| `Pillow` | 이미지 분할, 리사이즈, 크롭 |
| `numpy` | 빈 타일 감지, 콘텐츠 밀도 분석 |
| `openpyxl` | OOXML XML 파싱, 셀 데이터 접근 |
| `python-dotenv` | .env 환경변수 로드 |
| `anthropic` | Bedrock Claude API 호출 |

**시스템 요구사항**: Windows 10+ / Microsoft Excel 설치 / Python 3.10+

## 관련 문서

| 문서 | 설명 |
|------|------|
| [SPEC.md](SPEC.md) | Stage별 상세 기술 스펙 |
| [VERIFICATION.md](VERIFICATION.md) | 검증 기준 및 품질 현황 |
| [MEMORY.md](MEMORY.md) | 개발 과정 기록 (세션 간 상태 유지) |
