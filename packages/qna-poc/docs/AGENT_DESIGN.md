# Agent QnA 파이프라인 설계

> 이 문서는 `src/agent.py`의 핵심 설계를 상세히 기술합니다.
> 코드 변경 시 이 문서도 함께 업데이트하세요.

---

## 개요

단순 RAG(retrieve→answer)에서 **Agent 4원칙**(Planning, Tool Use, Reflection, Trace)을 적용한 파이프라인.

```
질문 → [Planning] → [Search] → [Answer] → [Reflection] → (필요 시 [Retry]) → 최종 답변
```

## Agent 4원칙

| 원칙 | 구현 위치 | 역할 |
|------|----------|------|
| **Planning** | `plan_search()` | LLM이 질문을 분석하여 검색 전략 수립 |
| **Tool Use** | `execute_search()` | 전략에 따라 검색 도구 실행 |
| **Reflection** | `reflect_on_answer()` | 답변 품질 자체 검증, 재검색 판단 |
| **Trace** | `agent_trace` 필드 | 전체 수행 이력 JSON 기록 |

---

## Step 1: Planning (`plan_search`)

### 목적
질문을 분석하여 **어떤 기획서(워크북)를 참고할지** 사전에 결정.
단순 키워드 매칭이 아닌, LLM이 질문 의도를 이해하고 전략을 수립.

### 모델
- **Claude Sonnet 4.5** (Bedrock)
- 이유: Planning 정확도가 전체 파이프라인 품질을 좌우함. Haiku 대비 비용은 높지만 정확도 우선.

### 입력
1. **질문** + 질문자 역할 (기획자/프로그래머/QA/PD)
2. **워크북 목록** (~167개): ChromaDB 인덱스에서 자동 추출
   - PK_ 워크북 (Excel 기획서, ~104개)
   - Confluence/Design/ 워크북 (Confluence 페이지, ~63개)
3. **KG 관계 정보**: Knowledge Graph에서 시스템 간 관계 요약 (~128줄)
   - 형식: `시스템A -> 관련1, 관련2, 관련3`
   - 목적: cross-system 질문에서 관련 시스템을 함께 검색하도록 유도

### 출력 (JSON)
```json
{
  "key_systems": ["PK_물약 자동 사용 시스템"],
  "query_type": "fact|cross_system|flow|balance|ui|trap",
  "search_keywords": ["물약 자동 사용", "트리거", "HP 기본값"],
  "search_plan": [
    {"tool": "section_search", "args": {"workbook": "PK_물약 자동 사용 시스템", "query": "HP 기본값"}}
  ],
  "reasoning": "물약 자동 사용 시스템에서 HP 트리거 기본값 조회"
}
```

### 설계 의도
- 167개 워크북 목록을 직접 제공하여 **정확한 워크북명 매칭** 유도
- KG 관계 정보로 **시스템 간 연관성** 파악 (예: "물약 → HUD 시스템" 관계)
- Planning 실패 시 `extract_system_names()` (SYNONYMS 사전 기반)로 폴백

---

## Step 2: Search (`execute_search`)

### 목적
Planning 전략에 따라 검색 도구를 실행하고 결과를 병합.

### 실행 순서
1. **기본 하이브리드 검색** (항상 실행): `retrieve(query, top_k=15)`
   - 3레이어: 구조적 검색 → KG 확장 → 벡터 검색
2. **Planning 전략 실행** (보강): `search_plan`에 따라 추가 검색
   - `retrieve`: 다른 검색어로 추가 검색
   - `section_search`: 특정 워크북 내 집중 검색
   - `kg_related`: KG에서 관련 시스템 조회 → 관련 워크북 검색
3. **key_systems 직접 검색** (보강): Planning이 지목한 워크북의 청크를 높은 스코어로 추가

### 검색 도구

| 도구 | 함수 | 설명 |
|------|------|------|
| `retrieve` | `retriever.retrieve()` | 하이브리드 3레이어 (구조적+KG+벡터) |
| `section_search` | `retriever._structural_search()` | 특정 워크북 내 키워드 기반 검색 |
| `kg_related` | `retriever.get_related_systems()` | KG BFS로 관련 시스템 탐색 |

### 출력
- 최대 20개 청크 (중복 제거, 스코어 순)
- 각 청크: `{id, text, workbook, sheet, section_path, score, source}`

### source 값 의미

| source | 의미 |
|--------|------|
| `structural` | 시스템명 직접 매칭 → 키워드 관련성 스코어링 |
| `vector` | Titan Embeddings 코사인 유사도 |
| `kg_expand` | KG 관계 확장 (간접 관련 시스템) |
| `agent_planned` | Planning이 지목한 key_systems 직접 검색 |
| `retry_retrieve` | Reflection 재검색에서 발견 |
| `retry_structural` | Reflection 재검색 (구조적) |

---

## Step 3: Answer Generation (`generate_agent_answer`)

### 목적
수집된 청크(증거)를 기반으로 질문에 대한 답변 생성.

### 모델
- **Claude Sonnet 4.5** (Bedrock), max_tokens=2048, temperature=0

### 핵심 프롬프트 원칙
1. **반드시 답변하세요** — 부분적 정보라도 답변 구성
2. **"찾을 수 없습니다" 사용 금지 원칙** — 컨텍스트에 관련 단어가 단 하나도 없을 때만
3. **출처 명시** — `[출처: 워크북명 / 시트명]` 형식
4. **역할별 답변 스타일** — 기획자(규칙/설계 의도), 프로그래머(데이터 구조/공식), QA(엣지 케이스), PD(전체 그림)

### 컨텍스트 구성
- 상위 10개 청크 사용
- key_systems 청크를 우선 배치 (Planning이 지목한 시스템이 먼저 오도록)
- 각 청크 텍스트 최대 3000자

---

## Step 4: Reflection (`reflect_on_answer`)

### 목적
생성된 답변의 품질을 자체 검증하고, 부족하면 재검색 전략 수립.

### 모델
- **Claude Haiku 4.5** (Bedrock) — 빠른 판단용

### 판단 로직

#### 빠른 판단 (LLM 호출 없이)
- 답변에 "찾을 수 없습니다", "정보가 없습니다", "답변 생성 불가" 포함 시:
  - `is_sufficient=False`, `confidence=none`
  - `retry_query` = Planning의 search_keywords 조합

#### LLM 판단
- 답변이 존재하는 경우, Haiku가 평가:
  - 질문 의도에 답했는가?
  - 구체적 수치/조건/규칙 포함?
  - 검색 범위가 잘못된 것 아닌가?

### 검색 컨텍스트 전달 (스마트 재검색)
Reflection에 검색 컨텍스트를 함께 전달하여 더 나은 재검색 전략 수립:
- 검색된 출처 목록 (어떤 문서를 찾았는지)
- Planning이 지목한 시스템
- 사용된 검색 키워드
- 질문 유형

이를 통해 Reflection이 **"어떤 문서를 찾지 못했는지"** 파악하고,
**다른 검색어/다른 워크북**을 제안할 수 있음.

### 출력
```json
{
  "is_sufficient": false,
  "confidence": "low",
  "missing_info": "물약 자동 사용의 세부 트리거 조건이 부족",
  "retry_query": "물약 자동 사용 HP 트리거 설정",
  "retry_systems": ["PK_물약 자동 사용 시스템"]
}
```

---

## Step 4b: Retry (`execute_retry_search`)

### 조건
- `is_sufficient=False`인 경우에만 실행 (최대 1회)

### 실행
1. Reflection이 제안한 `retry_query`로 `retrieve()` 재검색
2. `retry_systems`의 워크북을 직접 구조적 검색
3. 기존 청크 + 신규 청크 병합, 스코어 순 정렬
4. 병합된 청크로 Sonnet이 재답변 생성
5. 재답변은 **항상 채택** (기존 답변이 불충분했으므로)

---

## Trace (agent_trace)

모든 단계의 수행 이력을 JSON으로 기록. 디버깅 및 평가 분석에 활용.

### 각 step 공통 필드
```json
{
  "step": "planning|search|answer_generation|reflection|retry",
  "model": "claude-sonnet-4-5|claude-haiku-4-5|null",
  "description": "단계 설명",
  "seconds": 5.2
}
```

### step별 추가 필드

| step | 추가 필드 |
|------|----------|
| planning | `input` (query, role, workbook_count), `output` (key_systems, query_type, search_keywords, search_plan, reasoning), `tokens` |
| search | `tools_used` (실행된 도구 목록), `chunks_count`, `workbooks_found`, `source_distribution`, `top3_chunks` |
| answer_generation | `input` (chunks_count, key_systems_priority, role), `answer_preview`, `tokens` |
| reflection | `output` (is_sufficient, confidence, missing_info), `tokens` |
| retry | `tools_used`, `extra_chunks`, `answer_preview`, `adopted`, `tokens` |

---

## 비용 구조

| 단계 | 모델 | 예상 토큰 | 비용/질문 |
|------|------|----------|----------|
| Planning | Sonnet | ~5K in + ~300 out | ~$0.017 |
| Search | - | 0 (로컬 검색) | $0 |
| Answer | Sonnet | ~10K in + ~500 out | ~$0.034 |
| Reflection | Haiku | ~1K in + ~200 out | ~$0.001 |
| Retry (선택) | Sonnet | ~10K in + ~500 out | ~$0.034 |

**질문당 평균**: ~$0.05 (Retry 없을 때), ~$0.09 (Retry 포함)

---

## 검색 인프라

### ChromaDB
- 경로: `~/.qna-poc-chroma` (ASCII 경로 — 한국어 경로 인코딩 문제 회피)
- 컬렉션: `project_k`
- 청크 수: ~3,036 (Excel 1,822 + Confluence 1,214)
- 임베딩: Amazon Titan Embeddings v2 (1024차원)

### Knowledge Graph
- 경로: `_knowledge_base/knowledge_graph.json`
- 규모: 176 시스템, 478 관계
- 용도: (1) KG 확장 검색, (2) Planning에 시스템 간 관계 정보 제공

### SYNONYMS 사전
- 위치: `src/retriever.py`
- 역할: 게임 용어 유의어 매핑 (예: "변신"→"트랜스폼", "버프"→"상태 효과")
- 70+ 매핑

---

## 파일 구조

```
packages/qna-poc/
  src/
    agent.py          # Agent 파이프라인 (이 문서가 설명하는 코드)
    retriever.py      # 검색 도구 (하이브리드: 구조적+KG+벡터)
    generator.py      # LLM 호출 (Bedrock) + 시스템 로그
    indexer.py         # ChromaDB 인덱싱
    api.py            # FastAPI 엔드포인트
  eval/
    generate_gt_llm.py  # [1단계] GT 질문 + 기대 정답 생성
    verify_gt_llm.py    # [2단계+3단계] Agent 답변 생성 + Judge 채점
  docs/
    AGENT_DESIGN.md     # ★ 이 문서
    MEMORY.md           # 작업 진행 기록
```

---

## 변경 이력

| 날짜 | 변경 | 이유 |
|------|------|------|
| 2026-03-10 | 초기 작성 | Agent 4원칙 설계 문서화 |
| 2026-03-10 | Planning 모델 Haiku→Sonnet | Planning 정확도가 파이프라인 품질 좌우 |
| 2026-03-10 | Planning에 KG 관계 정보 추가 | cross-system 질문 대응 개선 |
| 2026-03-10 | Reflection에 검색 컨텍스트 전달 | 스마트 재검색 전략 수립 |
