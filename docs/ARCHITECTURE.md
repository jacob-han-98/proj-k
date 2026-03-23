# Project K AI 어시스턴트 - 기술 아키텍처

## 전체 시스템 구조

```
[원본 소스]              [Data Pipeline]                         [지식 베이스]          [AI 서비스]
                         (data-pipeline 패키지)
Perforce (Excel)    ──→  E: crawl + capture                 ──→ ChromaDB (4,133청크)──→ Agent API
Confluence (Wiki)   ──→  T: vision + parse + synthesize          + KG (405시스템)        |
  │                      T: download + enrich                                           v
  └─ 변경 감지 ───→      L: index + kg_build                                    [사용자 인터페이스]
     (polling/webhook)                                                          React SPA / Slack
                         DAG 기반 자동 체이닝
                         dev/prod 모드 분리
```

### Data Pipeline 개요

> 상세 설계: `packages/data-pipeline/docs/PIPELINE_DESIGN.md`

비정형 문서를 AI가 이해할 수 있는 구조화된 지식으로 변환하는 Data Pipeline.
ETL 패턴을 따르되, Transform 단계에 Vision AI + LLM 해석이 포함된다.

```
E (Extract)   = crawl + download + capture         소스에서 원본 획득
T (Transform) = vision + parse + synthesize + enrich   AI 기반 비정형 변환
L (Load)      = index + kg_build                   벡터DB + KG 적재
```

**소스별 파이프라인 DAG**:

| 소스 | 파이프라인 | 단계 |
|------|-----------|------|
| Perforce (Excel) | excel-vision | crawl(win) -> capture(win) -> convert -> index -> kg_build |
| Confluence | confluence-enrich | crawl -> download -> enrich(조건부) -> index -> kg_build |
| PPTX (향후) | pptx-vision | crawl -> capture -> convert -> index -> kg_build |
| DataSheet (향후) | excel-table | crawl -> convert(table-parser) -> index -> kg_build |

**인프라**: SQLite DB + 작업큐 워커 + 스케줄러 (자체 구축, 외부 프레임워크 미사용)
- 프레임워크 선택 근거: ADR-017
- Windows(P4+Excel COM capture) + Linux(나머지) 분산 지원 (`remote_db.py`)

## 1단계: 지식화 아키텍처

### 원본 소스 동기화

```
[현재] 로컬 폴더 (임시 복사본, 검증용)
  ├─ 1_High_Concept/, 7_System/, 9_MileStone/ ... (Perforce에서 복사)
  └─ Confluence PDF Sync/ (Confluence에서 내보내기)

[향후] 실시간 동기화
  ├─ Perforce triggers → Excel 변경 감지 → 자동 재변환
  └─ Confluence webhook/polling → PDF 변경 감지 → 자동 재변환
```

### 변환 파이프라인 - Vision-First

```
원본 문서 (XLSX / PDF / PPTX)
  │
  ├─ [1차] Headless 스크린샷 캡처
  │         └─ LibreOffice headless / PDF renderer
  │              └─ 시트별/페이지별/슬라이드별 PNG
  │
  ├─ [2차] Vision API 분석 (주 변환)
  │         └─ 스크린샷 → Claude Vision API
  │              └─ 구조화된 Markdown 생성
  │              └─ 잘 읽는 것: 레이아웃, 도형, 플로우차트, 이미지 내 텍스트
  │
  ├─ [3차] 데이터 파싱 보강 (보조)
  │         └─ openpyxl (XLSX) / PyMuPDF (PDF) / python-pptx (PPTX)
  │              └─ Vision이 약한 것: 정확한 수치, 숨겨진 셀, 수식, 데이터 테이블
  │
  └─ [합성] 두 결과 병합 → 최종 Markdown
                    │
                    v
            _knowledge_base/  (구조화된 지식)
```

### 레거시 파이프라인 (참고용, 기존 완성)

```
원본 문서
  ├─ XLSX ──→ convert_xlsx.py ──→ Tier1(셀) + Tier1.5(도형) + Tier2(Vision보정)
  ├─ PDF  ──→ convert_pdf.py  ──→ 텍스트 추출 (Confluence 특화)
  └─ PPTX ──→ convert_pptx.py ──→ 슬라이드/테이블/노트
```

### 지식 구조화 (TODO)

```
_knowledge_base/
  ├─ sheets/{시스템명}/          # 시스템별 변환 결과
  ├─ pdf/{카테고리}/             # PDF 변환 결과
  ├─ index/                      # 검색 인덱스
  │   ├─ system_index.json       # 시스템별 문서 매핑
  │   ├─ term_dictionary.json    # 용어 사전
  │   └─ chunk_manifest.json     # RAG 청크 목록
  ├─ knowledge_graph.json        # 시스템 간 관계
  └─ PROJECT_K_KNOWLEDGE_BASE.md # 통합 요약
```

### 청크 전략 (RAG 준비)
- **단위**: 시트 > 섹션(H1/H2 기준) > 테이블/플로우차트
- **메타데이터**: 시스템명, 시트명, 섹션 경로, 관련 시스템 태그
- **크기**: 500~2000 토큰 / 청크 (Claude 기준)
- **오버랩**: 앞뒤 1문단 겹침으로 문맥 보존

---

## 2단계: QnA API 아키텍처 (초안)

```
사용자 질문
    │
    v
[Query Router]  ──→  키워드/시스템명 감지
    │
    ├─→ [Vector Search]  ──→  임베딩 유사도 검색
    ├─→ [Graph Search]   ──→  관련 시스템 탐색
    └─→ [Term Lookup]    ──→  용어 사전 매칭
    │
    v
[Context Assembly]  ──→  검색 결과 + 관련 문서 조합
    │
    v
[Claude API]  ──→  답변 생성 (출처 표시)
    │
    v
사용자 응답 (답변 + 출처 링크)
```

### 주요 컴포넌트

| 컴포넌트 | 역할 | 기술 후보 |
|----------|------|----------|
| Query Router | 질문 분류 + 검색 전략 결정 | 규칙 기반 + LLM 분류 |
| Vector Search | 의미 기반 문서 검색 | Chroma(로컬) or Pinecone |
| Graph Search | 시스템 관계 기반 탐색 | NetworkX + knowledge_graph.json |
| Context Assembly | 검색 결과 → 프롬프트 구성 | 토큰 예산 내 최적 조합 |
| Claude API | 답변 생성 | claude-sonnet (빠른 응답) / claude-opus (복잡한 분석) |

---

## 3단계: 리뷰 시스템 (초안)

```
[기존 기획 분석]
  전체 지식 베이스 → 교차 검증 → 충돌/누락 리포트

[신규 기획서 리뷰]
  업로드된 문서 → 기존 지식과 비교 → 정합성 리포트
```

---

## 4단계: 실시간 어시스턴트 (초안)

```
[Confluence/Excel 변경 감지]
    │
    v
[변경 내용 파싱]  ──→  작성 중인 기획 내용 추출
    │
    v
[컨텍스트 매칭]   ──→  관련 기존 기획 검색
    │
    v
[피드백 생성]     ──→  Claude API로 의견 생성
    │
    v
[사이드바 UI]     ──→  기획자에게 실시간 표시
```

---

## 의존성

### 현재 (1단계)
```
anthropic       # Claude Vision API (주 변환 엔진)
openpyxl        # XLSX 데이터 보강
pymupdf (fitz)  # PDF 데이터 보강
python-pptx     # PPTX 데이터 보강
```

### 1단계 추가 필요
```
# headless 스크린샷
libreoffice     # headless Excel/PPT → PDF/PNG 변환 (서버용)
# 또는 Windows 환경: Excel COM automation

# 원본 동기화 (향후)
p4python        # Perforce Python API
atlassian-python-api  # Confluence API
```

### 2단계 추가 예정
```
fastapi         # Backend API
chromadb        # 벡터 DB (또는 대안)
voyageai        # 임베딩 (또는 대안)
networkx        # 그래프 탐색
```

## 멀티유저 지원 현황 (2026-03-19 분석)

### 현재 지원되는 것

| 항목 | 상태 | 근거 |
|------|------|------|
| 동시 요청 처리 | O | `def` 엔드포인트 → FastAPI가 threadpool에서 실행 (`api.py:83`) |
| 대화 격리 | O | `conversation_id`(UUID)로 분리 (`api.py:88`) |
| 스레드 안전성 | O | `_conv_lock`으로 conversations dict 보호 (`api.py:41`) |
| 프론트 상태 격리 | O | `localStorage` 기반 → 브라우저별 독립 (`App.tsx:94-101`) |

### 현재 한계점

| 항목 | 문제 | 영향 |
|------|------|------|
| **인메모리 대화 저장** | `conversations: dict` (`api.py:40`) — 서버 재시작 시 전체 히스토리 소실 | 스케일아웃(다중 프로세스) 시 프로세스 간 상태 공유 불가 |
| **인증 없음** | 사용자 식별 없음 — `conversation_id`만 알면 남의 대화에 접근 가능 | 보안·감사·사용량 추적 불가 |
| **단일 프로세스 병목** | `agent_answer()`가 Bedrock API 호출 포함 10~30초 소요. uvicorn 기본 threadpool(40개) | 동시 ~40명 한계, 실제로는 Bedrock rate limit에 먼저 도달 |
| **리소스 격리 없음** | 한 사용자의 heavy query(Deep Research 등)가 다른 사용자의 응답 시간에 영향 | QoS 보장 불가 |

### 결론

**소규모(5~10명 동시)로는 작동하지만, 프로덕션 멀티유저 서비스로는 부족.**

### 프로덕션 전환 시 필요 사항 (6단계 사내 서비스)

| 영역 | 필요 사항 | 후보 기술 |
|------|-----------|-----------|
| 인증 | SSO/OAuth 연동 | SAML (사내 SSO), OAuth 2.0 |
| 대화 영속화 | 서버 재시작·스케일아웃에도 히스토리 유지 | Redis (세션) / PostgreSQL (영구) |
| 요청 큐잉 | 사용자별 rate limiting, 공정한 자원 분배 | FastAPI middleware / Celery task queue |
| 다중 워커 | 동시 처리 수 확장 | gunicorn + uvicorn workers / 컨테이너 스케일아웃 |
| 사용량 추적 | 사용자별 토큰·비용 모니터링 | 로깅 + 대시보드 (Grafana 등) |

> 현재 PoC 단계에서는 위 한계가 문제되지 않음. 6단계(사내 서비스)에서 본격 대응 예정.

---

## 미결정 사항
- [x] Headless 렌더링 방식 → **Excel COM (Windows)** + LibreOffice (서버 백업) (ADR-006)
- [x] 벡터 DB 선택 → **ChromaDB** (로컬, 4,133 청크)
- [x] 임베딩 모델 선택 → **Amazon Titan v2** (Bedrock, 1024차원)
- [x] 배포 환경 → **사내 서버** (Ubuntu, systemd + nginx)
- [x] 프론트엔드 프레임워크 → **React + Vite SPA** (ADR-015)
- [x] Confluence API 연동 방식 → **REST API polling** (ADR-010), webhook은 서비스 단계에서
- [x] Perforce 동기화 방식 → **P4 sync polling** (ADR-011), triggers는 서비스 단계에서
- [ ] 파이프라인 프레임워크 → **자체 DAG 확장** (ADR-017), 서비스 단계에서 Dagster 검토

> 미결정 사항은 각 단계 착수 시 결정하고 `docs/DECISIONS.md`에 기록
