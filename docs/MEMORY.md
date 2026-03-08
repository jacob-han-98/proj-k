# Project K - 작업 진행 메모리

> 세션 간 항상성을 유지하기 위한 작업 상태 기록.
> 세션 시작 시 반드시 이 파일을 먼저 읽는다.

## 최종 업데이트: 2026-03-08

## 현재 단계: 1단계 (지식화) 완료 → 2단계 (QnA PoC) 착수

---

## 1. 프로젝트 현황

### 1단계: 지식화 — Excel 변환 완료

| 항목 | 값 |
|------|-----|
| 대상 | 104 XLSX 파일, 635 시트 |
| 성공 | **623 시트 (98.1%)** |
| 실패 | 12 시트 (모두 Excel COM CopyPicture 오류) |
| 소요 시간 | 109분 (parallel=10) |
| 토큰 사용 | 12.3M |
| 출력 | 629개 content.md, ~462KB 텍스트, 2,009 서브 이미지 |

**핵심 도구**: `packages/xlsx-extractor/` — 4단계 파이프라인 (Capture → Vision → Parse OOXML → Synthesize)

### 추가 데이터 소스 (미변환, 확장 트랙)

| 유형 | 개수 | 상태 | 우선순위 |
|------|------|------|----------|
| Confluence PDF | 296개 | 미착수 | QnA 결과에 따라 결정 |
| PPTX | 11개 | 1/11 완료 (레거시) | 후순위 |
| 추가 XLSX | xlsm 등 | 미착수 | 필요 시 |

### 2단계: QnA PoC — 착수 예정 (ADR-008)

- **결정**: Excel 데이터만으로 QnA PoC 먼저 진행
- **근거**: 핵심 데이터 98.1% 확보, 가치 증명 우선
- **아키텍처**: RAG (ChromaDB + Titan Embeddings + Sonnet) + knowledge_graph.json
- **위치**: `packages/qna-poc/` (신규)

---

## 2. 서브 프로젝트 현황

### xlsx-extractor (완료)

- **위치**: `packages/xlsx-extractor/`
- **상세 기록**: `packages/xlsx-extractor/docs/MEMORY.md`
- **파이프라인**: Excel COM 캡처 → Claude Opus Vision → OOXML 보정 → 14단계 Dedup + OCR 교정
- **API**: AWS Bedrock (Claude Opus Vision + Sonnet OCR)
- **검증**: Human-in-the-Loop + Claude Code 반복 검증 (7 사이클)

### qna-poc (착수 예정)

- **위치**: `packages/qna-poc/` (생성 예정)
- **상세 기록**: `packages/qna-poc/docs/MEMORY.md` (생성 예정)
- **구성**: FastAPI + ChromaDB + Gradio + Bedrock Claude Sonnet

---

## 3. 기존 자산

### 레거시 변환 도구 (ConvertProgram/)
- `convert_xlsx.py` — Tier 1+1.5 변환 (xlsx-extractor로 대체됨)
- `vision_reinforce.py` — Vision 보정 (xlsx-extractor에 통합됨)
- `run_all.py` — 레거시 오케스트레이션

### 지식 베이스 (_knowledge_base/)
- `knowledge_graph.json` — 405 시스템, 627 관계 (QnA PoC에서 활용)
- `PROJECT_K_KNOWLEDGE_BASE.md` — 통합 요약 (레거시)
- xlsx-extractor 출력: `packages/xlsx-extractor/output/` (629개 content.md)

---

## 4. 의사결정 히스토리 요약

| ADR | 결정 | 날짜 |
|-----|------|------|
| ADR-001 | 3단계 Tier 구조 채택 | 2026-02 |
| ADR-002 | YAML + Mermaid 하이브리드 | 2026-02 |
| ADR-003 | Vision 보강 시스템 도입 | 2026-03 |
| ADR-004 | 변환 도구 → AI 에이전트로 전환 | 2026-03-06 |
| ADR-005 | Vision-First 방식 채택 | 2026-03-06 |
| ADR-006 | Vision-First 파이프라인 v1 완성 | 2026-03-07 |
| ADR-007 | Vision AI + OOXML 하이브리드 전략 | 2026-03-08 |
| ADR-008 | QnA PoC 우선, 데이터 확장은 병행 | 2026-03-08 |

상세: `docs/DECISIONS.md`

---

## 5. 사용자 선호

- 진행 과정을 MEMORY.md에 반드시 기록
- 작은 데이터부터 검증하며 진행 (1시트 → 1파일 → 전체)
- Opus 모델 사용 필수 (Vision), Sonnet은 텍스트용
- AI 가독성 우선
- API 키는 서브 프로젝트 내 `.env`에서 관리
