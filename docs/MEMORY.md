# Project K - 작업 진행 메모리

> 세션 간 항상성을 유지하기 위한 작업 상태 기록.
> 세션 시작 시 반드시 이 파일을 먼저 읽는다.

## 최종 업데이트: 2026-03-08

## 현재 단계: 1단계 (지식화)

---

## 1. 전체 변환 현황

| 유형 | 총 개수 | 완료 | 우선순위 |
|------|---------|------|----------|
| XLSX | 104 | 2/104 (레거시) + 1 VF 테스트 | 7_System 64개 최우선 |
| PDF  | 296 | 0/296 | Confluence 배치 변환 |
| PPTX | 11  | 1/11  | 컨셉 문서 |

### 완료된 변환 (레거시 방식)
- `PK_변신_및_스킬_시스템.xlsx` - 13시트 전체 (프로토타입, 검증 완료)
- `PK_버프_시스템.xlsx` - 변환 완료
- `PK_전투컨셉트.pptx` - 변환 완료

### Vision-First 테스트 완료
- `PK_단축키 시스템.xlsx` - 2/3 시트 변환 성공 (히스토리, HUD)
  - 변신 시트: LibreOffice 3번째 프로세스 크래시 (재시도 로직 추가)
  - 품질: 매우 우수 (게임 UI 스크린샷 내 모든 텍스트/숫자 정확히 인식)

## 2. Vision-First 파이프라인 (신규, 세션 11)

### 아키텍처
```
XLSX → [LibreOffice headless] → 시트별 PDF
     → [PyMuPDF] → 페이지별 PNG (자동 크롭, 빈 페이지 건너뛰기)
     → [Claude Opus via Bedrock] → 구조화된 Markdown
     → [openpyxl] → 숨겨진 행/열, 수식 데이터 보강
     → 합성 → 최종 Markdown
```

### 스크립트 현황

| 스크립트 | 상태 | 설명 |
|---------|------|------|
| lo_sheet_export.py | v1 완성 | LibreOffice UNO 시트별 PDF 내보내기 (프로세스 격리, 재시도) |
| vision_first_convert.py | v1 완성 | 메인 파이프라인 (캡처→Vision→보강→합성) |

### 기술 결정사항
- **스크린샷**: LibreOffice 26.2.0 headless (사용자 선택, 서버 호환)
- **Vision API**: AWS Bedrock Claude Opus (사용자 선택, 최고 품질)
- **환경변수**: `ConvertProgram/.env` 파일에서 로드 (python-dotenv)
- **시트 격리**: 시트당 별도 LibreOffice 프로세스 (안정성 확보)
- **fit-to-page**: ScaleToPagesX=1 + Selection 기반 개별 시트 내보내기

### 알려진 이슈
- LibreOffice 3번째 연속 프로세스에서 간헐적 크래시 → 재시도 로직으로 완화
- 시트당 약 7-10초 소요 (soffice 시작/종료 포함)
- 전체 파이프라인 약 120초/파일 (3시트 기준, Vision API 응답 포함)

## 3. 레거시 변환 스크립트

| 스크립트 | 버전 | 주요 기능 |
|---------|------|----------|
| convert_xlsx.py | v5 | Tier1(셀)+Tier1.5(도형) 변환 |
| vision_reinforce.py | v3 | Bedrock Vision 보정, idempotent |
| tier2_vision.py | v1 | 스크린샷 vs MD 비교 보강 |
| tier2_verify.py | v1 | 품질 검증 루프 (9/10 PASS 기준) |
| capture_screenshots.py | v2 | Excel COM→PDF→PNG, 시맨틱 분할 |
| run_all.py | v2 | 레거시 일괄 오케스트레이션 |

## 4. 서브 프로젝트: xlsx-extractor

### 전략 변경 (세션 12)
- 한 번에 큰 시스템 → 작은 단위 서브 프로젝트로 분리
- 첫 번째 서브 프로젝트: `packages/xlsx-extractor/`

### 문서 현황
| 문서 | 상태 | 설명 |
|------|------|------|
| README.md | 완성 | 개요, 목표, 출력 구조 |
| SPEC.md | 완성 | 방법론, 4단계 파이프라인, 이미지 전략, 출력 구조 |
| VERIFICATION.md | 완성 | 검증 프로토콜, Vision AI 랜덤 질의 검증, 품질 기준 |
| .env.example | 완성 | 환경변수 템플릿 |

### 핵심 방법론
- 2-이미지 Vision 전략: 개요(전체 축소) + 상세(영역 고해상도)
- 텍스트 우선 해석: 테이블/플로우차트/도형 -> 텍스트, 불가 시만 서브 이미지
- Vision AI 랜덤 질의 검증: 추출 결과를 원본 이미지로 자동 검증
- API 키: 서브 프로젝트 내 `.env` 파일에서 관리

### 다음 할 일
1. xlsx-extractor 코드 구현 시작 (Stage 1: Capture부터)
2. PK_단축키_시스템.xlsx로 프로토타입 테스트
3. 레거시 결과와 품질 비교

### 이후 (상위 프로젝트)
1. pdf-extractor, pptx-extractor 서브 프로젝트
2. RAG 파이프라인 설계
3. QnA API (2단계)

## 5. 프로젝트 전환 기록

- **2026-03-06**: 프로젝트 방향 전환 (ADR-004)
  - 변환 도구 프로젝트 → AI 기획 어시스턴트 프로젝트
  - CLAUDE.md 전면 개편, docs/ 폴더 신설
- **2026-03-06**: 변환 순서 전환 (ADR-005)
  - Vision API 먼저 → Excel 데이터 보강 (신규)
- **2026-03-07**: Vision-First 파이프라인 v1 완성 (세션 11)
  - LibreOffice headless + Claude Opus Bedrock + openpyxl 보강
  - PK_단축키 시스템 프로토타입 테스트 성공 (2/3 시트)
  - 환경변수 관리: ConvertProgram/.env 방침 확립
- **2026-03-08**: 전략 변경 - 서브 프로젝트 분리 (세션 12)
  - 큰 시스템 → 작은 단위 서브 프로젝트로 전환
  - packages/xlsx-extractor/ 문서화 완료 (README, SPEC, VERIFICATION)
  - API 키 관리: 서브 프로젝트 내 .env로 변경

## 6. 사용자 선호

- 진행 과정을 docs/MEMORY.md에 반드시 기록
- 검증 절차 포함하여 진행
- Opus 모델 사용 필수 (아니면 WARNING)
- AI 가독성 우선
- API 키는 서브 프로젝트 내 `.env`에서 관리 (방침 변경)
