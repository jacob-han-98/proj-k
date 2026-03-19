# QnA Agent 파이프라인 종합 리포트

> 최종 갱신: 2026-03-16

## 1. 지식 베이스 현황 (ChromaDB)

### 개요
| 항목 | 값 |
|------|-----|
| 벡터DB | ChromaDB (PersistentClient) |
| 저장 경로 | `~/.qna-poc-chroma` |
| 컬렉션명 | `project_k` |
| 총 청크 수 | **4,133** |
| 총 워크북 수 | **176** |
| 임베딩 모델 | Amazon Titan Embeddings v2 (Bedrock), 1024차원 |

### 데이터 소스 분포

| 소스 | 워크북 수 | 청크 수 | 비율 | 평균 토큰/청크 |
|------|----------|---------|------|---------------|
| Excel (PK_*) | 94 | 2,853 | 69% | ~788 |
| Confluence | 82 | 1,280 | 31% | ~873 |

### 상위 10 워크북 (청크 수 기준)
| 워크북 | 청크 수 | 소스 |
|--------|---------|------|
| PK_몬스터설정 | 260 | Excel |
| PK_퀘스트 | 199 | Excel |
| PK_NPC 시스템 | 118 | Excel |
| Confluence/.../서대륙_레벨 | 103 | Confluence |
| PK_기타설정 | 84 | Excel |
| Confluence/.../길드 | 81 | Confluence |
| Confluence/.../스킬 시스템 | 81 | Confluence |
| PK_월드 시스템 | 77 | Excel |
| PK_기본전투_시스템 | 75 | Excel |
| Confluence/.../성장 밸런스 | 74 | Confluence |

### 청크 크기 분포
| 구간 | 수 | 비고 |
|------|-----|------|
| < 200 토큰 | 889 | 너무 짧은 청크 (21.5%) |
| 200~2000 토큰 | 2,997 | 적정 범위 (72.5%) |
| > 2000 토큰 | 247 | 큰 청크 (6.0%) |
| **총 토큰** | **3,366,519** | 평균 815 토큰/청크, min=22, max=24,302 |

### 메타데이터 필드 커버리지
| 필드 | 커버리지 | 설명 |
|------|---------|------|
| `workbook` | 100.0% | 워크북(문서)명 |
| `sheet` | 100.0% | 시트/페이지명 |
| `section_path` | 100.0% | 섹션 경로 |
| `tokens` | 100.0% | 토큰 수 |
| `source_path` | 100.0% | 원본 파일 경로 |
| `has_table` | 64.1% | 테이블 포함 여부 |
| `has_images` | 33.5% | 이미지 설명 포함 여부 |
| `has_mermaid` | 6.6% | Mermaid 다이어그램 포함 여부 |

---

## 2. Agent QnA 파이프라인

### 전체 흐름

```
사용자 질문
    │
    ▼
┌─────────────────────┐
│  1. Planning (Sonnet)│  질문 분석 → 검색 전략 JSON
│  ~1024 tokens out    │  query_type, key_systems, search_plan
└────────┬────────────┘
         │
         ▼
┌─────────────────────┐
│  2. Search (no LLM)  │  4-레이어 하이브리드 검색
│  Retrieve + Plan실행 │  → max 25 청크 수집
└────────┬────────────┘
         │
         ▼
┌─────────────────────┐
│  3. Answer (Sonnet)  │  증거 기반 답변 생성
│  ~2048 tokens out    │  20개 규칙 프롬프트 (423줄)
│  detail_level 조절   │  간결/보통/상세
└────────┬────────────┘
         │
         ▼
┌─────────────────────┐
│  4. Reflection       │  자기 평가 (Haiku)
│  (Haiku) ~256 tokens │  is_sufficient + confidence
│  Short-circuit 패턴  │  → 즉시 PASS 가능
└────────┬────────────┘
         │
    [부족하면]
         ▼
┌─────────────────────┐
│  5. Retry (Sonnet)   │  재검색 + 재답변 (최대 1회)
│  Optional            │  Reflection의 retry_query 사용
└─────────────────────┘
```

### LLM 호출 상세 (총 7종)

#### Call #1: Planning
| 항목 | 값 |
|------|-----|
| 함수 | `plan_search()` |
| 모델 | Claude Sonnet |
| max_tokens | 1,024 |
| temperature | 0 |
| 시스템 프롬프트 | `PLANNING_PROMPT` (~108줄) |
| 입력 | 질문 + 워크북 목록 + KG 관계 요약 |
| 출력 | JSON (key_systems, query_type, search_keywords, search_plan) |
| 특이사항 | ~25개 하드코딩 워크북 매칭 규칙 포함 |

#### Call #2: Search (LLM 미사용)
| 항목 | 값 |
|------|-----|
| 함수 | `execute_search()` |
| L1 | 구조적 검색 — ChromaDB `get()` by workbook |
| L2 | KG 확장 — NetworkX BFS (depth=1) |
| L3 | 벡터 검색 — Titan v2 임베딩 |
| L4 | 풀텍스트 — `$contains` 필터 |
| 결과 | 최대 25 청크, score 기반 정렬 |
| 다양성 | 워크북당 max 5 (overview) / 8 (기타) |

#### Call #3: Answer Generation
| 항목 | 값 |
|------|-----|
| 함수 | `generate_agent_answer()` |
| 모델 | Claude Sonnet |
| max_tokens | 1,024 (간결) / 2,048 (보통) / 4,096 (상세) |
| temperature | 0 |
| 시스템 프롬프트 | `AGENT_ANSWER_PROMPT` (~423줄, 20개 규칙) |
| 입력 | 컨텍스트 (상위 15청크 × 7000자) + 질문 + 대화 히스토리 (3턴) |
| 역할별 | 기획자/프로그래머/QA/PD 스타일 분기 |

#### Call #4: Reflection
| 항목 | 값 |
|------|-----|
| 함수 | `reflect_on_answer()` |
| 모델 | Claude Haiku |
| max_tokens | 512 |
| temperature | 0 |
| 시스템 프롬프트 | `REFLECTION_PROMPT` (~25줄) |
| Short-circuit | "기획서에서 확인되지 않", "정의되어 있지 않" → 즉시 sufficient |
| 출력 | JSON (is_sufficient, confidence, retry_query, retry_systems) |

#### Call #5: Retry (조건부)
| 항목 | 값 |
|------|-----|
| 조건 | Reflection에서 `is_sufficient=false` |
| 모델 | Claude Sonnet |
| 동작 | retry_query로 재검색 → 기존+추가 청크 → 재답변 |
| 채택 | 더 나은 답변을 자동 선택 |

---

## 3. Deep Research 파이프라인 (overview 질문 전용)

### 트리거 조건
- `query_type == "overview"` (Planning이 판단)
- 관련 청크 30개 초과 시 사용자에게 선택 제안
- 30개 이하이면 자동으로 일반 Agent 사용

### Map-Reduce 구조

```
scan_all_related_chunks()
    │  메타데이터 기반 전체 스캔 (제한 없음)
    │  key_systems + 키워드 매칭
    ▼
┌─────────────────────────────────┐
│  워크북별 그룹핑                  │
│  {워크북A: [chunk1, chunk2, ...]}│
│  {워크북B: [chunk3, chunk4, ...]}│
└────────┬────────────────────────┘
         │
         ▼  병렬 5 워커
┌─────────────────────────────────┐
│  _summarize_group() × N         │
│  모델: Claude Haiku (저렴+빠름)   │
│  max_tokens: 2,048              │
│  각 워크북의 모든 청크 → 1500자 요약│
│  컨텍스트 상한: 60,000자/그룹     │
└────────┬────────────────────────┘
         │
         ▼
┌─────────────────────────────────┐
│  deep_research() — 최종 종합     │
│  모델: Claude Sonnet             │
│  max_tokens: 4,096              │
│  N개 워크북 요약 → 체계적 종합 답변│
│  구조: 개요→메커니즘→세부→UI/UX   │
└─────────────────────────────────┘
```

### Deep Research LLM 호출

#### Call #6: Group Summary (× N 워크북)
| 항목 | 값 |
|------|-----|
| 함수 | `_summarize_group()` |
| 모델 | **Claude Haiku** (비용 효율) |
| max_tokens | 2,048 |
| temperature | 0 |
| 병렬 | `ThreadPoolExecutor(max_workers=5)` |
| 프롬프트 | `_GROUP_SUMMARY_PROMPT` (~10줄) |
| 입력 | 워크북별 청크 (시트별 정렬, 각 4000자 제한) |
| 컨텍스트 상한 | 60,000자/그룹 |

#### Call #7: Final Synthesis
| 항목 | 값 |
|------|-----|
| 함수 | `deep_research()` 내부 |
| 모델 | Claude Sonnet |
| max_tokens | 4,096 |
| temperature | 0 |
| 프롬프트 | `_SYNTHESIS_PROMPT` (~11줄) |
| 입력 | 모든 그룹 요약 종합 |
| 출력 구조 | 시스템 개요 → 핵심 메커니즘 → 세부 규칙 → UI/UX |

### 비용 추정 (Deep Research)
| 시나리오 | 워크북 수 | Haiku 요약 | Sonnet 종합 | 예상 비용 |
|----------|----------|-----------|------------|----------|
| 소규모 (5 WB) | 5 | ~$0.01 | ~$0.02 | ~$0.03 |
| 중규모 (15 WB) | 15 | ~$0.03 | ~$0.04 | ~$0.07 |
| 대규모 (30+ WB) | 30 | ~$0.06 | ~$0.06 | ~$0.12 |

> Sonnet으로 그룹 요약 시 대비 **~12배 절감** (Haiku $0.25/M vs Sonnet $3/M input)

---

## 4. 검색 시스템 상세 (retriever.py)

### 4-레이어 하이브리드 검색

```
┌──────────────────────────────────────────────┐
│  L1: Structural Search (구조적 검색)           │
│  ChromaDB get() by workbook/sheet/section     │
│  Planning의 key_systems → 워크북 직접 조회     │
│  ~70 SYNONYMS + ~80 SYNONYM_WORKBOOK_OVERRIDES│
└──────────┬───────────────────────────────────┘
           │
┌──────────▼───────────────────────────────────┐
│  L2: KG Expansion (지식 그래프 확장)            │
│  NetworkX BFS (depth=1)                       │
│  knowledge_graph.json: 405 시스템, 627 관계    │
│  관련 시스템의 워크북도 검색 대상에 추가          │
└──────────┬───────────────────────────────────┘
           │
┌──────────▼───────────────────────────────────┐
│  L3: Vector Search (벡터 검색)                 │
│  Amazon Titan Embeddings v2 (1024D)           │
│  ChromaDB query() → cosine similarity         │
│  top_k=15 기본                                │
└──────────┬───────────────────────────────────┘
           │
┌──────────▼───────────────────────────────────┐
│  L4: Fulltext Search (풀텍스트 검색)            │
│  ChromaDB $contains 필터                      │
│  키워드 직접 매칭 (보조)                        │
└──────────────────────────────────────────────┘
```

### 검색 파라미터
| 파라미터 | 값 | 설명 |
|---------|-----|------|
| top_k | 15 | 기본 벡터 검색 결과 수 |
| max_chunks | 25 | execute_search() 최대 반환 수 |
| token_budget | 80,000 | retrieve() 토큰 예산 |
| max_per_wb (overview) | 5 | 워크북당 최대 청크 (다양성) |
| max_per_wb (기타) | 8 | 워크북당 최대 청크 |

### 동의어/별칭 시스템
- `SYNONYMS`: ~70개 시스템 이름 동의어 매핑
- `SYNONYM_WORKBOOK_OVERRIDES`: ~80개 특수 매핑 (FAQ에서 자주 틀리는 패턴)
- Planning 프롬프트에도 ~25개 하드코딩 매칭 규칙

---

## 5. 프롬프트 아키텍처

### 프롬프트 크기 비교
| 프롬프트 | 줄 수 | 역할 |
|---------|------|------|
| `PLANNING_PROMPT` | ~108줄 | 검색 전략 수립 + 워크북 매칭 |
| `AGENT_ANSWER_PROMPT` | ~80줄 (20규칙) | 답변 생성 품질 보장 |
| `REFLECTION_PROMPT` | ~25줄 | 자기 평가 + 재검색 전략 |
| `_GROUP_SUMMARY_PROMPT` | ~10줄 | 워크북별 요약 (Deep Research) |
| `_SYNTHESIS_PROMPT` | ~11줄 | 최종 종합 (Deep Research) |

### query_type 체계 (7종)
| 타입 | 설명 | 코드 분기 |
|------|------|----------|
| `overview` | 시스템 전체 설명/개요 | Deep Research 트리거, max_per_wb=5 |
| `fact` | 특정 사실 조회 | 기본 동작 |
| `cross_system` | 시스템 간 관계/비교 | Planning 힌트만 |
| `flow` | 플로우/시퀀스 | Planning 힌트만 |
| `balance` | 수치/밸런스 | Planning 힌트만 |
| `ui` | UI/UX 관련 | Planning 힌트만 |
| `trap` | 존재하지 않는 기능 | Planning 힌트만 |

> `overview`만 코드 레벨 분기 있음 (Deep Research 트리거 + 워크북당 청크 수 제한)

---

## 6. 성능 지표

### 검색 정확도
- **규칙 기반 평가**: 97.2% (481/495) — 10차 평가 기준
- 495 ground truth 질문 대상

### Agent QnA 답변 품질
- **LLM-as-Judge**: 95.0% (66/69) — 15차 평가 기준
  - 일반 질문: 95.0% (57/60)
  - 트랩 질문: 100% (9/9)
- 카테고리별: A:93%, B:87%, C:100%, D:100%, E:100%, F:100%, H:100%
- 잔여 FAIL 3건: A-003(OCR 데이터), B-002(경계값), B-003(확률적 regression)

### 개선 이력
```
47%  (기준선, 단순 RAG)
 ↓ 인덱서 버그 수정
72%
 ↓ Agent 파이프라인 도입
87%
 ↓ 프롬프트 튜닝 + 동의어
94.2%
 ↓ OOXML 보강 + 규칙 추가
95.0%  (현재)
```

---

## 7. 모델 사용 요약

| 용도 | 모델 | 비용 등급 |
|------|------|----------|
| Planning | Claude Sonnet | 중 |
| Answer Generation | Claude Sonnet | 중 |
| Reflection | Claude Haiku | **저** |
| Retry Answer | Claude Sonnet | 중 |
| Deep Research 그룹 요약 | Claude Haiku | **저** |
| Deep Research 최종 종합 | Claude Sonnet | 중 |
| 임베딩 | Amazon Titan v2 | 저 |

### 비용 최적화 전략
1. **Haiku for Reflection**: 품질 검증은 저렴한 모델로 충분
2. **Haiku for Group Summary**: Map-Reduce 중간 단계는 Haiku로 12배 절감
3. **Short-circuit 패턴**: 명백한 답변은 Reflection 스킵
4. **워크북 다양성 제한**: 같은 워크북 과다 사용 방지 → 불필요한 토큰 절감

---

## 8. 기술 스택

| 컴포넌트 | 기술 |
|---------|------|
| 벡터DB | ChromaDB (PersistentClient) |
| 임베딩 | Amazon Titan Embeddings v2 (Bedrock) |
| LLM | Claude Sonnet / Haiku (AWS Bedrock) |
| 지식 그래프 | NetworkX + knowledge_graph.json |
| API 게이트웨이 | `call_bedrock()` — HTTP POST, Bearer Token |
| 웹 UI | Streamlit |
| API 서버 | FastAPI (api.py) |
| Slack 봇 | Bolt for Python (pkai) |
