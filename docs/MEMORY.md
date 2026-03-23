# Project K - 작업 진행 메모리

> 세션 간 항상성을 유지하기 위한 작업 상태 기록.
> 세션 시작 시 반드시 이 파일을 먼저 읽는다.

## 최종 업데이트: 2026-03-21

## 현재 단계: 데이터 파이프라인 인프라 구축 중 + 피칭 준비

---

### [최근 작업 내역] 2026-03-21: 데이터 파이프라인 인프라 구축

**완료 항목:**
- **packages/data-pipeline/** 신규 패키지 생성
- **DB 스키마 (SQLite)**: 6 테이블 — crawl_sources, documents, conversions, jobs, issues, index_snapshots
- **워커 프레임워크**: 4타입 (crawl/capture/convert/index), 큐 기반, 자동 재시도
- **크롤링 소스 설정**: YAML 기반 (config/sources.yaml), 소스별 변환 전략 (vision-first/table-parser/html-to-md)
- **CLI 도구**: sources/docs/jobs/issues/pipeline/rollback 명령
- **스케줄러**: daily/hourly/weekly 자동 트리거
- **기존 데이터 임포트**: Excel 93건 + Confluence 489건 = 582 문서 DB 등록 완료
- **DB 공유 구조**: 서버 DB(SQLite) + 개발PC는 HTTP API 경유 (remote_db.py)
  - 개발PC: `--remote http://서버:8088` → crawl, capture (P4 권한 + Windows)
  - 서버: 로컬 DB 직접 접근 → convert, index
- **워커용 API 엔드포인트**: claim/start/complete/fail, upsert_document, create_conversion 등 13개
- **Admin 대시보드 UI**: React PipelinePage.tsx — 전체현황/소스/문서/작업큐/이슈 5탭
- **기획팀장 피드백 반영**: QnA+유관부서 기획서 추출이 1순위, 신규기획은 후순위

**추가 완료 (같은 세션):**
- **커밋 완료** (6커밋, master 브랜치): 모든 변경사항 커밋됨
- **서버 배포 완료**: FastAPI + 프론트엔드 + data-pipeline 배포
  - 모듈 충돌 2건 수정 (importlib 방식): api.py의 src.db 충돌, worker.py의 confluence client 충돌
- **P4 + Confluence 크롤링 완료**: 개발PC에서 --remote로 서버 DB에 등록
  - 서버 DB: 소스 2개, 문서 65건, 작업 2/2 완료
- **모바일 반응형**: 사이드바 숨김 + 상단 탭 바 (☰ 메뉴 + 대화/품질/파이프라인 탭)

**현재 git 상태:** 클린 (모든 변경 커밋됨)

**다음 작업 후보:**
1. Slack 봇 배포 (토큰 발급)
2. Confluence 신규 페이지 자동 생성
3. table-parser 전략 구현 (데이터시트용)
4. 피칭 준비

---

### [이전 작업 내역] 2026-03-20: 기획서 제안 + UX 전면 구축

**완료 항목:**
- **문서 충돌 스캐너**: 47쌍 탐지, 15쌍 심층 분석, 62건 충돌 발견 (`conflict_scanner.py`)
- **문서 정리 현황 페이지**: `/conflicts` — 패턴/심각도/유형별 필터 UI
- **기획서 제안(Proposal) 파이프라인**: 대화 맥락 기반 기존 문서 수정 diff + 신규 문서 생성
- **ProposalView UI**: before/after diff 카드, 복사 버튼 (TSV 변환), Confluence/Excel 아이콘 구분
- **대화 공유**: `/shared/:id` 읽기 전용 페이지 + 사이드바 공유 버튼
- **Admin Fork**: 기존 대화를 복제하여 이어서 테스트
- **textarea 줄바꿈**: Enter=줄바꿈, Ctrl+Enter=전송
- **"기획해줘" vs "기획서 수정해줘" 구분**: Planning 프롬프트에 명확히 분리
- **CTA 버튼**: QnA 답변 후 "이어서 기획서 수정/작성하기 →" 자동 표시
- **ADR-016**: 기획서 수정 UX 방향 결정 (Excel=Excel 플러그인+복사, Confluence=크롬 확장, 신규=Confluence API)

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

### 추가 데이터 소스

| 유형 | 개수 | 상태 | 우선순위 |
|------|------|------|----------|
| Confluence | 490페이지 | **다운로드 완료** (489 content.md, REST API 직접 추출) | QnA 통합 대기 |
| Confluence PDF (레거시) | 296개 | 불필요 — REST API로 대체 | - |
| PPTX | 11개 | 1/11 완료 (레거시) | 후순위 |
| 추가 XLSX | xlsm 등 | 미착수 | 필요 시 |

### 2단계: QnA PoC — **95% 달성**, UX 개발 진행 중

- **아키텍처**: Agent 파이프라인 (Planning→Search→Answer→Reflection) + Hybrid 4레이어 검색
- **위치**: `packages/qna-poc/`
- **인덱싱**: Excel + Confluence → 4,133 청크, ChromaDB 저장 (~/.qna-poc-chroma)
- **검색기(Retriever) 정확도**: **97.2% (481/495)** — 규칙 기반 495개 질문 (10차 평가)
- **Agent QnA 답변 품질**: **95.0% (66/69)** — LLM-as-Judge 8축 채점 (15차 평가)
  - 일반: 57/60 (95.0%), 트랩: 9/9 (100%)
  - A:93%, B:87%, C:100%, D:100%, E:100%, F:100%, H:100%
  - 잔여 FAIL 3건: A-003(OCR 데이터), B-002(경계값), B-003(확률적 regression)
  - 15차 평가까지 반복 개선 (47% → 95.0%)
- **Streamlit UI 완성 (2026-03-14)**:
  - ChatGPT 스타일 대화 인터페이스 + Agent 실시간 상태 표시
  - Mermaid 다이어그램 렌더링 (components.html + mermaid.js CDN)
  - Claude 스타일 옵션 바: ＋ popover(역할/모델/청크) + 모델 선택
  - 출처 표시 (Confluence 웹 링크, Excel 스크린샷 펼치기)
  - 피드백 시스템 (thumbs up/down + 상세 입력)
  - QnA 히스토리 DB (SQLite, qna_db.py)
  - **서버 배포 완료**: https://cp.tech2.hybe.im/proj-k-agent (systemd + nginx)
- **Slack 봇 구현 완료 (2026-03-14)**:
  - `src/slack_bot.py` — Slack Bolt (Socket Mode)
  - `@ProjectK-AI 질문` → Agent 답변 → Block Kit 포맷
  - DM 직접 질문 + 스레드 멀티턴
  - Markdown→mrkdwn 변환 (테이블→코드블록, 링크, Mermaid→Streamlit 링크)
  - systemd 서비스: `deploy/proj-k-slack-bot.service`
  - **배포 대기**: Slack App 토큰 발급 필요
- **UX 전략 (ADR-013)**:
  1. ~~Streamlit 웹앱~~ → **완료** (배포됨)
  2. ~~Slack 봇~~ → **코드 완료**, 토큰 발급 후 배포
  3. 피칭 후 → Next.js 전환, Slack 봇 유지

### 3단계: 데이터 확장 & 동기화 — 진행 중 (ADR-009, ADR-010)

- **Confluence 다운로드 완료**: REST API 직접 추출 490페이지 → 489 content.md (ADR-010)
- **Confluence 이미지 보강 완료**: 257페이지/1,370이미지 OK (~$36.44, Vision API → content_enriched.md)
- **Perforce 동기화 완료**: 7_System 69파일 → D:/ProjectK/Design/7_System (최신 리비전)
  - P4 워크스페이스: jacob-D, 스트림: //main/ProjectK
  - 7_System만 동기화 대상 (핵심 기획서 폴더, 나머지 미사용)
- **xlsx-extractor 외부 경로 연동**: XLSX_SOURCE_DIRS=D:/ProjectK/Design/7_System
- **증분 변환 기능**: --changed-only (mtime 비교로 변경분만 재변환)
- **파이프라인 통합**: rebuild_knowledge.py (5단계: 소스 업데이트 → Excel 변환 → 이미지 보강 → 인덱싱 → KG)

#### 3단계 완료 작업
1. ✅ Excel 재변환 (66파일, 401/408 시트 OK, 7.8M 토큰)
2. ✅ Confluence 이미지 보강 (257페이지, 1,370 이미지, $36.44)
3. ✅ ChromaDB 재인덱싱 (3,036 chunks, +90 증가)
4. ✅ **대규모 QnA 재검증: 97.2% (481/495)** — 최신 데이터 반영 확인

#### 남은 작업
1. 실패 7개 Excel 시트 재변환 (COM 캡처 오류 — RDP 환경 필요)
2. PR 생성 (remote 설정 후)

---

## 2. 서브 프로젝트 현황

### xlsx-extractor (완료 → 재변환 예정)

- **위치**: `packages/xlsx-extractor/`
- **상세 기록**: `packages/xlsx-extractor/docs/MEMORY.md`
- **파이프라인**: Excel COM 캡처 → Claude Opus Vision → OOXML 보정 → 14단계 Dedup + OCR 교정
- **소스 경로**: `D:/ProjectK/Design/7_System` (Perforce 동기화, .env XLSX_SOURCE_DIRS)
- **재변환**: Perforce 최신 리비전 수신 완료 → `--changed-only`로 변경분 재변환 필요

### confluence-downloader (완료)

- **위치**: `packages/confluence-downloader/`
- **상세 기록**: `packages/confluence-downloader/docs/MEMORY.md`
- **결과**: 490페이지, 489 content.md, ~2,195 이미지, 8.2GB

### confluence-enricher (완료)

- **위치**: `packages/confluence-enricher/`
- **상세 기록**: `packages/confluence-enricher/docs/MEMORY.md`
- **결과**: 257페이지, 1,370/1,432이미지 OK, ~$36.44 (Vision API → content_enriched.md)

### qna-poc (Agent 95% + Streamlit 배포 + Slack 봇 구현 완료)

- **위치**: `packages/qna-poc/`
- **상세 기록**: `packages/qna-poc/docs/MEMORY.md`
- **Agent QnA**: **95.0% (66/69)** — LLM-as-Judge 8축 채점, 15차 평가
- **Streamlit UI**: 배포 완료 (https://cp.tech2.hybe.im/proj-k-agent)
- **Slack 봇**: 코드 완료 (`src/slack_bot.py`), Slack App 토큰 발급 후 배포

---

## 3. 기존 자산

### 레거시 변환 도구 (ConvertProgram/)
- `convert_xlsx.py` — Tier 1+1.5 변환 (xlsx-extractor로 대체됨)
- `vision_reinforce.py` — Vision 보정 (xlsx-extractor에 통합됨)
- `run_all.py` — 레거시 오케스트레이션

### 통합 스크립트 (scripts/)
- `update_sources.py` — Perforce + Confluence 데이터 소스 업데이트
- `rebuild_knowledge.py` — 5단계 파이프라인 (소스 업데이트 → Excel 변환 → 이미지 보강 → 인덱싱 → KG)
- `scripts/.env` — P4 설정 (P4PORT, P4USER, P4CLIENT, P4PASSWD, P4_DEPOT_PATH, P4_LOCAL_PATH)

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
| ADR-009 | 데이터 확장 & 동기화를 독립 단계로 분리 (2→3단계) | 2026-03-08 |
| ADR-010 | Confluence PDF 변환 대신 REST API 직접 추출 | 2026-03-09 |
| ADR-011 | Perforce 7_System 단독 동기화 + 외부 경로 운영 | 2026-03-09 |
| ADR-012 | 대규모 QnA 검증 500개 — 데이터 확장 후 자동 평가 | 2026-03-09 |
| ADR-013 | QnA UX — Streamlit 개발 테스트 + Slack 봇 테스터 배포 | 2026-03-11 |
| ADR-014 | Agent 파이프라인 + LLM-as-Judge 95% 달성 | 2026-03-13 |
| ADR-015 | 프론트엔드 전환 — Streamlit → React(Vite) SPA | 2026-03-19 |
| ADR-016 | 기획서 수정 UX — Excel=Excel플러그인+복사, Confluence=크롬확장 | 2026-03-20 |

상세: `docs/DECISIONS.md`

---

## 5. 앞으로 할 일 (우선순위별)

### [즉시] 피칭 임팩트

| # | 항목 | 설명 | 상태 |
|---|------|------|------|
| 1 | ~~**Confluence 신규 페이지 자동 생성**~~ | Proposal create → Confluence REST API로 직접 페이지 생성 | **완료** |
| 2 | ~~**Proposal 품질 개선**~~ | modify before 원문 인용 정확도, 테이블 수치 구체화 | 보류 |

### [단기] 데이터 퀄리티

| # | 항목 | 설명 | 상태 |
|---|------|------|------|
| 3 | **엑셀/Confluence 자동 크롤링** | Perforce/Confluence 변경 감지 → 자동 재변환 → 재인덱싱 | 미착수 |
| 4 | **데이터시트 정보 추가** | 시트 내 수치 테이블 인덱싱 → 밸런스 관련 질문 대응 | 미착수 |
| 5 | **주요 플로우차트 정리 요청** | 기획팀에 핵심 플로우 문서화 요청 (사람 작업) | 미착수 |
| 6 | **기획서 자동 최신화** | conflict_scanner 정기 실행 + outdated 마킹 | 미착수 |

### [중기] 피칭 후 우선

| # | 항목 | 설명 | 상태 |
|---|------|------|------|
| 7 | **Confluence 크롬 확장** | 사이드 패널에서 기획서 수정/추가 (ADR-016) | **진행 중** (feature 브랜치) |
| 8 | **기획서 리팩토링/정리 지원** | conflict_scanner 결과 기반 기획자 판정 UI | 미착수 |
| 9 | **기획서 피드백** | 신규/기존 기획에 대한 AI 리뷰 (4단계) | 미착수 |
| 10 | **구글 계정 로그인** | 브라우저 재시작 후에도 스레드 유지 | 미착수 |
| 11 | **레벨 엑셀 파일 추가** | 레벨 디자인 관련 엑셀 변환/인덱싱 (현재 7_System만) | 후순위 |

### [장기] 사내 서비스

| # | 항목 | 설명 | 상태 |
|---|------|------|------|
| 12 | **실시간 작성 어시스턴트** | 기획 작성 중 실시간 제안 (5단계) | 미착수 |
| 13 | **Claude Excel 플러그인 연동 강화** | Proposal → Excel 플러그인 최적화 | 미착수 |
| 14 | **데이터시트 자동 생성/검증** | Claude로 데이터 시트 작업 | 미착수 |
| 15 | **JIRA/Perforce/Slack 통합** | 업무 프로세스 통합 (7단계) | 미착수 |

---

## 6. 사용자 선호

- 진행 과정을 MEMORY.md에 반드시 기록
- 작은 데이터부터 검증하며 진행 (1시트 → 1파일 → 전체)
- Opus 모델 사용 필수 (Vision), Sonnet은 텍스트용
- AI 가독성 우선
- API 키는 서브 프로젝트 내 `.env`에서 관리
- "기획해줘" = QnA (전략/방향), "기획서 수정/작성해줘" = Proposal (문서 작업)
- 신규 기획서는 Confluence가 기본 (기획팀 정책)
- Excel 수정 = Claude Excel 플러그인 + 복사, Confluence 수정 = 크롬 확장 (향후)
