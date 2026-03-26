# Project K — 데이터 처리 시스템 핵심 요소 & 정책

> 게임 기획 지식을 AI가 이해하고 활용할 수 있도록 구축한 자체 시스템의 전체 아키텍처

---

## 1. 시스템 전체 구조

```
┌─────────────────────────── 소스 (원본 데이터) ───────────────────────────┐
│  Perforce 기획서 (xlsx)    Confluence (wiki)    Perforce 데이터시트 (xlsx) │
└──────────┬────────────────────┬────────────────────────┬────────────────┘
           │                    │                        │
    ┌──────▼──────┐     ┌──────▼──────┐     ┌───────────▼───────────┐
    │ Excel-Vision│     │ Confluence  │     │ DataSheet             │
    │ Pipeline    │     │ Pipeline    │     │ Pipeline              │
    │             │     │             │     │                       │
    │ P4 Sync     │     │ Web Scan    │     │ P4 Sync               │
    │ ScreenShot  │     │ Download    │     │ Table Parser → SQLite │
    │ Vision AI   │     │ Image Enrich│     │ (스키마+데이터 파싱)    │
    └──────┬──────┘     └──────┬──────┘     └───────────┬───────────┘
           │                    │                        │
    ┌──────▼────────────────────▼──────┐     ┌──────────▼──────────┐
    │ ChromaDB 벡터 인덱스             │     │ SQLite Game Data DB │
    │ 4,133 청크 (Excel + Confluence)  │     │ 187 테이블, 28K행    │
    │ + Knowledge Graph (405 시스템)   │     │ + 1,337 Enum 값      │
    └──────────────┬───────────────────┘     └──────────┬──────────┘
                   │                                    │
            ┌──────▼────────────────────────────────────▼──────┐
            │              QnA Agent (4단계 파이프라인)           │
            │                                                   │
            │  1. Planning  — 질문 분석 → 도구 선택              │
            │  2. Search    — 기획서 검색 + 데이터 테이블 쿼리    │
            │  3. Answer    — 두 소스 교차 참조 답변 생성         │
            │  4. Reflection — 자기 평가 + 보강                  │
            └──────────────────────┬────────────────────────────┘
                                   │
                       ┌───────────▼───────────┐
                       │  FastAPI (port 8088)   │
                       │  + React Frontend      │
                       │  + Slack Bot           │
                       └───────────────────────┘
```

---

## 2. 세 가지 파이프라인

### 2.1 Excel-Vision 파이프라인 (기획서)

**목적**: 기획자가 작성한 Excel 기획서를 AI가 읽을 수 있는 Markdown으로 변환

**핵심 정책: Vision-First (스크린샷 → AI → 데이터 보정)**
- 기존 방식(openpyxl 파싱 → Vision 보정)을 뒤집음
- Vision API가 먼저 전체 레이아웃/도형/플로우차트를 인식
- OOXML 파싱이 정확한 수치/테이블을 보정
- **왜?** Excel 기획서 정보의 80%가 도형/이미지에 있으므로, Vision이 주, 파싱이 보조

**처리 단계**:
```
1. P4 Get Latest    — Perforce에서 7_System 폴더 동기화, SHA256 해시로 변경 감지
2. ScreenShot       — Excel COM(Windows)으로 각 시트를 PNG 캡처
3. Vision Convert   — Opus 4.6 Vision API로 이미지 분석 → OOXML 수치 보정 → Markdown 생성
4. Vector Indexing  — 섹션 단위 청크 분할 → Titan 임베딩 → ChromaDB 저장
5. KG Build         — 시스템 간 관계 추출 → NetworkX 그래프 생성
```

**변환 결과**:
- 입력: 104개 xlsx, 635개 시트
- 출력: 623개 content.md (98.1% 변환율)
- 품질: 시범 변환에서 2KB → 200KB (100배) 정보량 확보

**Windows-Linux 분리 실행**:
- Windows PC: P4 Sync + ScreenShot (Excel COM 필요)
- Linux 서버: Vision Convert + Indexing (API 호출, 병렬화)
- 통신: HTTP API (port 8088) — worker가 원격으로 job claim/complete

### 2.2 Confluence 파이프라인

**목적**: Confluence 위키 페이지를 Markdown으로 변환 + 이미지 설명 보강

**처리 단계**:
```
1. Web Scan         — REST API로 페이지 트리 순회, version 비교로 변경 감지
2. Web Download     — HTML → Markdown 변환 + 첨부 이미지 다운로드
3. Image Enrich     — Opus 4.6 Vision으로 이미지마다 게임 맥락 설명 자동 삽입
4. Vector Indexing  — (Excel과 동일)
5. KG Build         — (Excel과 동일)
```

**변환 결과**: 490개 페이지 → 489개 content.md

### 2.3 DataSheet 파이프라인 (게임 데이터)

**목적**: 클라이언트/서버가 실제 사용하는 수치 데이터를 SQLite로 구조화하여 Agent가 직접 쿼리

**핵심 정책: Vision 미사용, 원본 구조 그대로 파싱**
- 데이터시트는 시각적 요소가 아닌 **정형 테이블** → Vision 불필요
- Row 1(헤더) + Row 2(타입 메타데이터) + Row 3+(데이터)의 통일된 스키마를 그대로 활용

**처리 단계**:
```
1. P4 Get Latest       — DataSheet 폴더 동기화 + 변경 감지
2. Table Parser → SQLite — xlsx 파싱 → SQLite DB 생성 (Enum 통합, FK 자동 감지)
```

**데이터시트 스키마 규칙**:
```
Row 1: 컬럼 헤더          Id, Name, SkillType, CoolTime, ...
Row 2: 타입 메타데이터     domain=cs\ntype=int32, domain=cs\ntype=SkillTypeEnum, ...
Row 3+: 실제 데이터        100100, SwordShield_Attack_01, Attack, 0, ...
```

- `domain=c` (클라이언트), `s` (서버), `cs` (양쪽) — 누가 이 데이터를 쓰는지 명시
- `type=` — int32, float, string, bool, 또는 Enum 이름 (예: SkillTypeEnum)
- `array=TRUE` — 쉼표 구분 배열
- `Info` 시트, `#Common#` 시트는 스킵 (문서/Perforce 내부 시트)
- `Disable` 컬럼이 True인 행은 스킵 (비활성 데이터)

**테이블 이름 정책**: `TableAttribute.xlsx`의 183개 정식 이름을 기준으로 사용
- 게임 엔진이 인식하는 이름과 동일 (예: `MonsterClass`, `CharacterSkillClass`)
- xlsx 시트 이름과 정식 이름 매핑 테이블 유지

**인제스트 결과**:
- 73개 루트 xlsx + 140개 Enum xlsx
- 187개 SQL 테이블, 28,126행, 5.67MB
- 120개 Enum 타입, 1,337개 Enum 값
- 428개 FK 관계 자동 감지
- 인제스트 시간: ~10초

---

## 3. 데이터 파이프라인 엔진

### 3.1 작업큐 시스템 (Job Queue)

**아키텍처**: SQLite 기반 작업큐 + 워커 프레임워크

```
crawl_sources (소스 정의)
    ↓
documents (문서 추적 — 파일 경로, 해시, 상태)
    ↓
jobs (작업큐 — pending → assigned → running → completed/failed)
    ↓
conversions (변환 이력 — 버전별, 롤백 가능)
```

**핵심 정책**:

**1) Atomic Job Claiming**:
```sql
UPDATE jobs SET status='assigned', worker_id=?
WHERE id = (SELECT id FROM jobs WHERE status='pending' AND worker_type IN (?, 'any')
            ORDER BY priority, created_at LIMIT 1)
```
- 단일 UPDATE로 경합 방지 — 여러 워커가 동시에 claim해도 중복 실행 없음

**2) 자동 체이닝 (Auto-Chaining)**:
- 크롤 완료 → 변경된 문서에 대해 다음 단계 작업 자동 생성
- 중복 방지: 이미 pending/running인 문서는 스킵
- 이중 체이닝: worker-level (크롤 직후) + API-level (완료 보고 시)

**3) 버전별 변환 이력**:
- 같은 문서의 변환 결과를 버전별로 보관
- `is_active` 플래그로 현재 서빙 중인 버전 관리
- 롤백: `is_active`만 변경하면 이전 버전으로 즉시 복원

**4) 워커 하트비트**:
- 15초마다 worker_heartbeats 테이블 업데이트
- 타임아웃된 워커의 assigned job → pending으로 자동 복구

### 3.2 소스 관리

**현재 등록된 소스 (3개 라인)**:

| 소스 | 타입 | 전략 | 스케줄 | 경로 |
|------|------|------|--------|------|
| 7_System 기획서 | perforce | vision-first | daily | `//main/ProjectK/.../7_System/...` |
| Confluence | confluence | html-to-md | daily | 3666773573 (root page ID) |
| DataSheet | perforce | table-parser | daily | `//main/ProjectK/.../DataSheet/...` |

**소스별 자동화 설정** (sources.yaml → DB sync):
- `auto_crawl_interval`: 주기적 크롤 간격 (초)
- `auto_download`: 크롤 후 자동 다운로드
- `auto_enrich`: 다운로드 후 자동 이미지 보강

### 3.3 변경 감지

**Perforce**: SHA256 파일 해시 비교 — 바이트 단위 변경 감지
**Confluence**: 페이지 version 번호 비교 — REST API로 트리 순회

### 3.4 CLI 도구

```bash
python -m src.cli sources list          # 소스 목록
python -m src.cli sources sync          # YAML → DB 반영
python -m src.cli docs status           # 문서 상태 통계
python -m src.cli jobs list --status pending
python -m src.cli pipeline trigger 1    # 소스 1 크롤 시작
python -m src.cli rollback doc 42 --version 2  # 버전 롤백
```

---

## 4. QnA Agent 파이프라인

### 4.1 4단계 아키텍처

```
질문 → [1. Planning] → [2. Search] → [3. Answer] → [4. Reflection] → 답변
                                                         ↓ (품질 부족 시)
                                                    [Retry: 1회 재시도]
```

### 4.2 Stage 1: Planning (검색 전략 수립)

**모델**: Claude Opus 4.6
**입력**: 질문 + 워크북/시트 목록 + KG 관계 요약 + **게임 데이터 스키마 요약**
**출력**: JSON — 핵심 시스템, 질문 유형, 검색 전략

**Planning Prompt 핵심 내용**:
```
## 사용 가능한 검색 도구
1. retrieve         — 기획서 하이브리드 검색 (설계 의도, 규칙, 플로우)
2. section_search   — 특정 워크북 내 집중 검색
3. kg_related       — 지식 그래프 관련 시스템 조회
4. query_game_data  — 게임 데이터 테이블 직접 조회 (실제 수치)
   - 기획서 = "왜/어떻게",  데이터 테이블 = "무엇이/얼마나"
   - args: {action, table, columns, filters, order_by, limit}
```

**질문 유형 분류**:
- `overview` — 시스템 전체 설명 (Deep Research 트리거)
- `fact` — 사실 조회 (단답)
- `cross_system` — 시스템 간 관계
- `balance` — 수치/밸런스 (기획서 + 데이터시트 병행)
- `data_query` — 구체적 수치/목록 (데이터시트 우선)
- `proposal` — 기획서 수정/작성 요청

**게임 데이터 스키마 자동 주입**:
- Planning 프롬프트에 매 질문마다 ~3-4K 토큰의 스키마 요약이 포함됨
- Agent가 어떤 테이블에 어떤 컬럼이 있는지 알고 적절한 쿼리를 생성
- 형식: `MonsterClass (696행): Id, Level, MaxHp, Type[MonsterTypeEnum], ...`

### 4.3 Stage 2: Search (4-레이어 하이브리드 검색)

**LLM 미사용 — 모든 검색은 결정론적**

```
L1 구조적 검색    — 시스템명 추출 → SYNONYMS 매핑 → 워크북/시트 직접 조회
L2 KG 확장       — NetworkX 그래프 → 관련 시스템 문서 확장
L3 벡터 검색     — Titan Embeddings → ChromaDB 코사인 유사도
L4 풀텍스트      — $contains 필터링 (최후 수단)
```

**SYNONYMS 사전 (150+ 항목)**:
```python
"변신": ["변신 시스템", "트랜스폼", "변환"],
"스킬": ["스킬 시스템", "기술", "액션 스킬"],
"창고": "PK_NPC 시스템",  # 의외의 매핑 — 실제 기획서 위치 기반
```

**query_game_data 도구 실행**:
- Planning이 지정하면 execute_search()에서 SQLite 쿼리 실행
- 결과를 높은 스코어(1.5)의 pseudo-chunk로 삽입
- `_game_data: True` 플래그로 컨텍스트 분리에 사용

### 4.4 Stage 3: Answer Generation

**모델**: Claude Sonnet / Opus (선택 가능)

**Answer Prompt 핵심 규칙 (20개)**:
```
1. 대화 연속성 — 이전 맥락 이어서 답변, 반복 금지
2. 컨텍스트 기반 완전 답변 — 부분적이라도 관련 있으면 답변
3. 구체적 데이터 정확 인용 — 수치는 반드시 컨텍스트에서 직접 인용
4. 출처 명시 — [출처: 워크북/시트명] 형식
5. 기획서 + 데이터 테이블 교차 참조 (NEW)
   - 실제 수치 → [출처: GameData/테이블명]
   - 설계 의도 → [출처: 워크북/시트명]
   - 두 소스를 결합하여 "왜 이 수치인지"까지 설명
```

**컨텍스트 조합 구조** (데이터시트 결과가 있을 때):
```
## 게임 데이터 조회 결과 (실제 수치)
| Id | Name | Type | Level | MaxHp |
| 501 | 코럽티드 보어 | Boss | 50 | 125,000 |
...

---

## 참조 기획서 (설계 의도/규칙)
[PK_몬스터 시스템 / 보스 몬스터]
보스 몬스터는 일반 몬스터 대비 10배의 HP를 가지며...

---

## 질문
보스 몬스터의 HP는 어떻게 되나요?
```

**역할별 답변 스타일**:
- 기획자: 시스템 규칙, 상호작용, 설계 의도
- 프로그래머: 데이터 구조, 공식, 시퀀스, 조건 분기
- QA: 엣지 케이스, 조건 분기, 상태 전이, 예외 상황
- PD: 전체 그림, 시스템 간 관계, 진행 현황

### 4.5 Stage 4: Reflection

**모델**: Claude Haiku (빠르고 저렴)

**자기 평가 8축**:
완전성, 정확성, 출처 인용, 명확성, 구조화, 관련성, 간결성, 실행 가능성

**Retry 조건**: 신뢰도 < 0.7 AND 시도 횟수 < 2 → 검색 보강 후 재답변

### 4.6 Deep Research (개요 질문 전용)

**트리거**: query_type="overview" AND 관련 청크 30개 초과

**Map-Reduce 전략**:
1. 워크북별 청크 그룹화
2. Haiku로 각 그룹 병렬 요약 (5 concurrent)
3. Sonnet으로 최종 종합

### 4.7 LLM 모델 배치

| 용도 | 모델 | 이유 |
|------|------|------|
| Planning / Answer / Deep Research 종합 | Opus or Sonnet | 복잡한 추론 |
| Reflection / Deep Research 그룹 요약 | Haiku | 비용 효율 (12배 저렴) |
| 임베딩 | Amazon Titan v2 | AWS Bedrock 네이티브, 1024차원 |
| Vision (기획서 변환) | Opus 4.6 Vision | 도형/플로우차트 인식 |

---

## 5. 게임 데이터 쿼리 엔진

### 5.1 Tool Calling 구조

Agent의 Planning 단계에서 `query_game_data`를 선택하면:

```
Planning LLM 출력:
  {"tool": "query_game_data", "args": {
    "action": "query",
    "table": "CharacterSkillClass",
    "columns": ["Id", "Name", "SkillType", "CoolTime"],
    "filters": [{"column": "CharacterClass", "op": "=", "value": "Guardian"}],
    "order_by": [{"column": "CoolTime", "direction": "DESC"}],
    "limit": 50
  }}

→ Python이 안전한 SQL로 변환:
  SELECT "Id", "Name", "SkillType", "CoolTime"
  FROM "CharacterSkillClass"
  WHERE "CharacterSkillClass"."CharacterClass" = ?
  ORDER BY "CoolTime" DESC LIMIT 50

→ Markdown 테이블로 Agent에 전달
```

### 5.2 안전 정책

| 정책 | 내용 |
|------|------|
| **No Raw SQL** | LLM이 SQL을 직접 생성하지 않음. 구조화 JSON → Python이 빌드 |
| **화이트리스트** | `_table_catalog`에 등록된 테이블/컬럼만 허용 |
| **연산자 제한** | `=, !=, <, >, <=, >=, LIKE, IN, IS NULL, IS NOT NULL`만 허용 |
| **파라미터 바인딩** | 모든 값은 `?` 바인딩 (SQL injection 차단) |
| **행 수 제한** | 최대 500행 |
| **타임아웃** | 5초 |
| **읽기 전용** | DB를 `?mode=ro`로 open |

### 5.3 지원 액션

| 액션 | 설명 | 예시 |
|------|------|------|
| `list_tables` | 전체 테이블 카탈로그 | 187개 테이블 목록 |
| `describe` | 특정 테이블 컬럼 정의 | CharacterSkillClass의 44개 컬럼 |
| `query` | 필터/조인/정렬 쿼리 | Type=Boss인 MonsterClass |
| `lookup_enum` | Enum 값 조회 | SkillTypeEnum의 6개 값 |

### 5.4 Enum 시스템

- 140개 Enum 파일 → 단일 `_enums` 테이블로 통합
- 모든 데이터 테이블의 Enum 타입 컬럼이 이 테이블을 참조
- Agent가 `lookup_enum`으로 "이 값이 무엇을 의미하는지" 조회 가능

### 5.5 FK 관계 자동 감지

컬럼명 패턴 `*Id` + 대상 테이블 존재 확인으로 자동 감지:
```
BuffId       → BuffClass.Id
MonsterId    → MonsterClass.Id
WorldId      → WorldClass.Id
SkillType    → _enums (SkillTypeEnum)
```

---

## 6. 벡터 인덱싱 & Knowledge Graph

### 6.1 청크 분할 정책

- **섹션 기반**: H2 단위로 1차 분할, 크면 H3 단위로 2차 분할
- **토큰 범위**: 100~2,000 토큰 (한글 기준 ~0.5 토큰/글자)
- **메타데이터**: workbook, sheet, section_path, has_table, has_mermaid, has_images, tokens

### 6.2 ChromaDB 저장

- 컬렉션: `project_k`
- 임베딩: Amazon Titan v2 (1024차원)
- 총 청크: 4,133개 (Excel 2,852 + Confluence 1,281)
- 경로: `~/.qna-poc-chroma/`

### 6.3 Knowledge Graph

- 405개 시스템, 627개 관계
- NetworkX DiGraph
- 용도: L2 검색에서 관련 시스템 확장
- 저장: `_knowledge_base/knowledge_graph.json`

---

## 7. 프론트엔드 & API

### 7.1 React Frontend

**3개 탭 (데이터 파이프라인 페이지)**:
- **Graph**: DAG 시각화 — 3개 파이프라인 라인 + 공유 단계 (Index, KG Build)
- **문서**: 문서 목록, 상태 필터, 내용 미리보기
- **DataSheet DB**: 게임 데이터 탐색기 + 아키텍처 설명

### 7.2 FastAPI 엔드포인트

| 그룹 | 엔드포인트 | 용도 |
|------|-----------|------|
| QnA | `POST /ask`, `/ask_stream` | 질문 → 스트리밍 답변 |
| 검색 | `POST /search` | 검색 디버그 |
| 파이프라인 | `GET /admin/pipeline/dag` | DAG 그래프 데이터 |
| 게임 데이터 | `GET /admin/game-data/summary` | DB 요약 |
| 게임 데이터 | `GET /admin/game-data/table/{name}` | 테이블 조회 |
| 게임 데이터 | `GET /admin/game-data/enum/{type}` | Enum 조회 |
| Webhook | `POST /webhook/perforce` | P4 변경 알림 |

---

## 8. 핵심 정책 요약

### 8.1 개발 방침

| 정책 | 내용 |
|------|------|
| **작은 데이터부터** | 1개 시트 → 1개 파일 → 유형별 → 전체 순서로 확대 |
| **실험적 기능** | PoC → 검증 → regression 확인 → 전체 적용 |
| **병렬 작업** | 의존성 없는 작업은 반드시 병렬 실행 |
| **실시간 가시성** | 배치 작업은 매 항목 즉시 결과 파일에 저장 |
| **성능 측정** | 단계별 타이밍, 토큰, 비용 추적 |

### 8.2 데이터 처리 정책

| 정책 | 내용 |
|------|------|
| **Vision-First** | 기획서는 Vision → 데이터 보정 순서 (설계 의도 우선) |
| **Table-Parser** | 데이터시트는 원본 구조 그대로 파싱 (정확한 수치 우선) |
| **변경 감지** | SHA256 해시(Perforce) / version 번호(Confluence) |
| **버전 관리** | 변환 결과를 버전별 보관, 롤백 가능 |
| **자동 체이닝** | 각 단계 완료 시 다음 단계 작업 자동 생성 |

### 8.3 QnA Agent 정책

| 정책 | 내용 |
|------|------|
| **컨텍스트 기반** | 기획서에 없는 내용은 추측하지 않음 |
| **출처 명시** | 모든 답변에 [출처: 워크북/시트] 표시 |
| **교차 참조** | 기획서(설계 의도) + 데이터시트(실제 수치) 병행 인용 |
| **역할별 스타일** | 기획자/프로그래머/QA/PD에 맞는 답변 톤 |
| **Trap 감지** | 존재하지 않는 기능 질문에 "정의되어 있지 않습니다" 답변 |

### 8.4 안전 정책

| 정책 | 내용 |
|------|------|
| **No Raw SQL** | LLM → 구조화 JSON → Python이 parameterized SQL 빌드 |
| **읽기 전용 DB** | 쿼리 엔진은 `?mode=ro`로만 DB 접근 |
| **행 제한** | 쿼리 결과 최대 500행, 타임아웃 5초 |
| **API 키** | `.env` 파일 관리, 버전 관리 미포함 |

---

## 9. 평가 & 품질

### 9.1 현재 성과

| 지표 | 수치 |
|------|------|
| 기획서 변환율 | 98.1% (623/635 시트) |
| QnA Agent 정확도 | 95.0% (66/69 질문) |
| 검색 정확도 | 97.2% (481/495 청크) |
| Trap 감지율 | 100% (9/9) |

### 9.2 평가 프레임워크

- 69개 Ground Truth 질문 (일반 60 + Trap 9)
- LLM-as-Judge (8축 평가): 완전성, 정확성, 출처, 명확성, 구조화, 관련성, 간결성, 실행가능성
- 이전 대비 개선 추적: 47% → 95% (15회 반복 개선)

---

## 10. 기술 스택

| 레이어 | 기술 |
|--------|------|
| LLM | Claude Opus 4.6, Sonnet, Haiku (AWS Bedrock) |
| 임베딩 | Amazon Titan Embeddings v2 (1024차원) |
| 벡터DB | ChromaDB (로컬 persistent) |
| 관계DB | SQLite (파이프라인, QnA 히스토리, 게임 데이터) |
| 그래프 | NetworkX (Knowledge Graph) |
| 백엔드 | FastAPI + uvicorn |
| 프론트엔드 | React 18 + TypeScript + Vite |
| 문서 변환 | openpyxl, LibreOffice headless, BeautifulSoup, markdownify |
| 인프라 | WSL2 Linux + Windows PC (이원 운영) |
