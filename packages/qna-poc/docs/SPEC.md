# QnA PoC 기술 스펙

> Hybrid Retrieval + LLM 답변 생성 파이프라인의 구현 상세. 각 모듈의 입출력, 알고리즘, API 사양을 정의한다.

---

## 1. 파이프라인 개요

```
질문 입력
  │
  ├─ [1. Query Analyzer]       시스템명 추출 + 유의어 매핑 (사전 기반)
  │
  ├─ [2a. Structural Search]   시스템→시트→섹션 직접 매핑 + 키워드 스코어링
  ├─ [2b. KG Expand]           knowledge_graph.json BFS 관계 확장 (depth=1)
  ├─ [2c. Vector Search]       ChromaDB 시맨틱 검색 (top-8, cosine)
  │
  ├─ [3. Ranking & Budget]     중복 제거 + 스코어 랭킹 + 토큰 예산 (80K) 내 조립
  │
  ├─ [4. Answer Generator]     Claude Sonnet via Bedrock (출처 포함 답변)
  │
  └─ [5. Response]             답변 + 출처(워크북/시트/섹션) + 관련 시스템 + 메타
```

| 모듈 | 파일 | 입력 | 출력 | 핵심 기술 |
|------|------|------|------|-----------|
| Indexer | `src/indexer.py` | 629개 content.md | 1,783 청크 (ChromaDB) | H2 기반 청킹, Titan Embeddings v2 |
| Retriever | `src/retriever.py` | 사용자 질문 | 랭킹된 청크 리스트 | 유의어 사전, 구조적/KG/벡터 하이브리드 |
| Generator | `src/generator.py` | 질문 + 컨텍스트 | 출처 포함 답변 | Claude Sonnet 4.5 (Bedrock) |
| API | `src/api.py` | HTTP 요청 | JSON 응답 | FastAPI 4개 엔드포인트 |
| Demo UI | `src/demo_ui.py` | 사용자 채팅 | 대화형 답변 | Gradio ChatInterface |
| Evaluator | `eval/evaluate.py` | 48개 질문 | PASS/FAIL + 통계 | 키워드 매칭 + 출처 검증 |

---

## 2. 환경 설정

### API 모델

| 용도 | 모델 | Bedrock 모델 ID |
|------|------|-----------------|
| 임베딩 | Amazon Titan Embeddings v2 | `amazon.titan-embed-text-v2:0` |
| 답변 생성 | Claude Sonnet 4.5 | `global.anthropic.claude-sonnet-4-5-20250929-v1:0` |

### .env 변수

```env
AWS_BEARER_TOKEN_BEDROCK=<bearer-token>
AWS_REGION=ap-northeast-2
LLM_MODEL=claude-sonnet-4-5          # 선택 (기본: claude-sonnet-4-5)
EMBEDDING_MODEL=amazon.titan-embed-text-v2:0  # 선택
```

`.env` 파일 위치: `packages/qna-poc/.env`

### 의존성

```
fastapi>=0.110.0    # API 서버
uvicorn>=0.29.0     # ASGI 서버
chromadb>=0.5.0     # 벡터 DB
networkx>=3.2       # KG 그래프 탐색
gradio>=4.20.0      # 데모 UI
requests>=2.31.0    # Bedrock API 호출
python-dotenv>=1.0.0
```

---

## 3. Indexer (`src/indexer.py`)

### 3.1 입력 데이터

- **소스**: `packages/xlsx-extractor/output/**/_final/content.md` (629개)
- **형식**: YAML 프론트매터 + Markdown 본문 (`> 원본:` 메타 라인)
- **총량**: ~462KB 텍스트, ~300K-400K 토큰

### 3.2 청킹 전략

```
content.md 파싱
  │
  ├─ 메타데이터 추출 (워크북명, 시트명)
  ├─ --- 구분선 이후 본문만 사용
  │
  ├─ H2(##) 기준 1차 분할 → 섹션
  │   └─ 토큰 초과 시 H3(###)에서 재분할
  │
  └─ 각 청크에 부모 컨텍스트 prefix 부착
      └─ [워크북 / 시트] + ## 섹션 제목
```

| 파라미터 | 값 | 설명 |
|----------|-----|------|
| `MAX_CHUNK_TOKENS` | 2000 | 청크 최대 토큰 |
| `MIN_CHUNK_TOKENS` | 100 | 최소 토큰 필터 (너무 작은 청크 제거) |
| `APPROX_TOKENS_PER_CHAR` | 0.5 | 한국어 토큰 추정 비율 |

**보존 규칙**:
- Mermaid 블록 절대 분할 금지
- 부모 제목을 prefix로 보존 (`[워크북 / 시트]\n## 섹션`)

### 3.3 청크 메타데이터

각 청크에 부착되는 메타데이터:

| 필드 | 타입 | 설명 |
|------|------|------|
| `workbook` | str | 원본 워크북명 (예: `PK_변신 및 스킬 시스템`) |
| `sheet` | str | 시트명 (예: `변신`) |
| `section_path` | str | 섹션 경로 (예: `등급별 스펙 구성표`) |
| `has_mermaid` | bool | Mermaid 다이어그램 포함 여부 |
| `has_table` | bool | Markdown 테이블 포함 여부 |
| `has_images` | bool | 이미지 참조 포함 여부 |
| `tokens` | int | 추정 토큰 수 |
| `source_path` | str | content.md 파일 경로 |

### 3.4 임베딩

```
텍스트 → Bedrock Titan Embeddings v2 API → 1024차원 벡터
  - 단일 텍스트 API 호출 (배치 미지원)
  - 텍스트 8000자 절사 (8K 토큰 제한)
  - normalize: True
  - 실패 시 제로 벡터 fallback
```

### 3.5 ChromaDB 저장

| 설정 | 값 |
|------|-----|
| 저장 경로 | `~/.qna-poc-chroma` (한국어 경로 인코딩 문제 회피) |
| 컬렉션명 | `project_k` |
| 거리 함수 | cosine |
| 배치 크기 | 5000 (ChromaDB 제한 5461) |

### 3.6 인덱싱 결과

| 항목 | 값 |
|------|-----|
| content.md 파일 | 629개 |
| 생성 청크 | 1,783개 |
| 평균 토큰/청크 | 651 |
| 임베딩 소요 | 888.5초 |
| 임베딩 비용 | $0.023 |

### 3.7 실행

```bash
python -m src.indexer                                    # 전체 인덱싱
python -m src.indexer --workbook "PK_변신 및 스킬 시스템"  # 단일 워크북
python -m src.indexer --stats                            # 통계만 출력
python -m src.indexer --reset                            # 인덱스 초기화 후 재생성
```

---

## 4. Retriever (`src/retriever.py`)

### 4.1 하이브리드 검색 전략: KG-first + Vector complement

검색 우선순위:
1. **구조적 검색** (시스템명 직접 매칭) → 가장 높은 정확도
2. **KG 관계 확장** (관련 시스템 BFS) → 시스템 간 질문 대응
3. **벡터 검색** (시맨틱) → 유의어/애매한 표현 대응

### 4.2 시스템명 추출 (`extract_system_names`)

```
질문 텍스트
  │
  ├─ 유의어 사전 (SYNONYMS) 30+ 매핑
  │    "변신" → ["변신 시스템", "트랜스폼", "변환"]
  │    "스킬" → ["스킬 시스템", "기술", "액션 스킬"]
  │    ...
  │
  ├─ 워크북명에서 자동 별칭 생성
  │    "PK_변신 및 스킬 시스템" → "변신 및 스킬 시스템", "변신및스킬시스템" 등
  │
  └─ 별칭 우선순위 매칭
       - 긴 별칭부터 매칭 (탐욕적)
       - 워크북명 시작부분 매칭 우선 (starts_with)
       - 같은 조건이면 짧은 이름 우선
```

### 4.3 구조적 검색 (`_structural_search`)

시스템명이 감지되면 해당 워크북의 **모든** 청크를 가져와 키워드 기반 랭킹:

```
기본 점수: 0.6 (시스템 매칭 보너스)
키워드 점수: 쿼리 토큰 적중률 × 0.3
섹션 보너스: 섹션 제목에 키워드 있으면 +0.2
최종 점수: min(base + keyword + section, 1.0)
```

### 4.4 KG 관계 확장 (`_kg_expand`)

```
감지된 시스템 (최대 3개)
  │
  ├─ NetworkX BFS (depth=1)
  │    knowledge_graph.json: 405 시스템, 627 관계
  │
  ├─ 관련 시스템당 상위 3개 청크만 포함
  │
  └─ 가중치: score × 0.5 (간접 관련이므로 하향)
```

### 4.5 벡터 시맨틱 검색 (`_vector_search`)

```
질문 → Titan 임베딩 → ChromaDB cosine 검색
  - top_k=8 (기본)
  - 시스템 필터 지원 ($eq 조건)
  - 양쪽(구조적+벡터)에서 발견된 청크: score × 1.2 부스트
  - 시스템 매칭 부스트 벡터 검색: score × 1.5
```

### 4.6 통합 랭킹 & 토큰 예산

```
모든 검색 결과 합산
  │
  ├─ 중복 제거 (chunk ID 기준, 높은 score 유지)
  ├─ score 내림차순 정렬
  └─ 토큰 예산 (80K) 또는 top_k (12) 도달 시 절사
```

### 4.7 검색 해석 메타데이터 (`retrieval_info`)

`retrieve()` 함수는 `(chunks, retrieval_info)` 튜플을 반환한다. `retrieval_info`는 검색 과정을 해석할 수 있는 메타데이터:

| 필드 | 타입 | 설명 |
|------|------|------|
| `detected_systems` | `list[str]` | 질문에서 추출된 시스템명 (유의어 매핑 후 정식 워크북명) |
| `layers_used` | `list[str]` | 결과를 반환한 검색 레이어 (`structural`, `kg_expand`, `vector`) |
| `structural_hits` | `int` | 구조적 검색에서 찾은 결과 수 |
| `kg_hits` | `int` | KG 확장에서 찾은 결과 수 |
| `vector_hits` | `int` | 벡터 전용 결과 수 |
| `search_scope` | `list[str]` | 검색 범위 설명 (어떤 시스템에서 어떤 방식으로) |
| `total_candidates` | `int` | 랭킹 전 전체 후보 수 |
| `final_source_distribution` | `dict` | 최종 결과의 소스 레이어별 분포 |
| `final_total_tokens` | `int` | 최종 결과의 총 토큰 수 |

API 응답(`/ask`, `/search`)과 Demo UI에 자동으로 포함되어, 사용자가 검색 과정을 이해할 수 있다.

---

## 5. Generator (`src/generator.py`)

### 5.1 시스템 프롬프트

```
당신은 모바일 MMORPG "Project K"의 기획 전문가 AI 어시스턴트입니다.

규칙:
1. 제공된 컨텍스트만 기반으로 답변 (할루시네이션 금지)
2. 답변 후 반드시 출처 표시: [출처: 워크북 / 시트 / 섹션]
3. 찾을 수 없으면 "찾을 수 없습니다" 명시
4. 테이블/Mermaid 원본 형식 유지
5. 여러 시스템 종합 시 각각 출처 표시
6. 간결 정확하게 답변

역할별 스타일:
- 기획자: 규칙, 상호작용, 설계 의도
- 프로그래머: 데이터 구조, 공식, 시퀀스
- QA: 엣지 케이스, 조건 분기, 예외
- PD: 전체 그림, 시스템 간 관계, 진행 현황
```

### 5.2 메시지 구성

```
[System] 시스템 프롬프트 (역할 가이드 포함)
[User*3] 이전 대화 히스토리 (최근 3턴, 답변 500자 요약)
[User] "[역할] + 컨텍스트 + 질문" 통합 메시지
```

### 5.3 Bedrock API 호출

| 파라미터 | 값 |
|----------|-----|
| `anthropic_version` | `bedrock-2023-05-31` |
| `max_tokens` | 4096 |
| `temperature` | 0 (결정적 답변) |
| `timeout` | 120초 |

### 5.4 출처 추출

정규식 `\[출처\s*\d*:?\s*([^/\]]+)\s*/\s*([^/\]]+)\s*(?:/\s*([^\]]+))?\]`로 답변에서 추출.

### 5.5 신뢰도 추정 (휴리스틱)

| 조건 | 신뢰도 |
|------|--------|
| "찾을 수 없습니다" 포함 | `none` |
| 출처 2개+ | `high` |
| 출처 1개 | `medium` |
| 출처 없음 | `low` |

---

## 6. API (`src/api.py`)

### 6.1 엔드포인트

| 메서드 | 경로 | 설명 |
|--------|------|------|
| POST | `/ask` | 기획 QnA 질문 |
| POST | `/search` | 검색만 수행 (디버그용) |
| GET | `/systems` | 인덱싱된 시스템 목록 |
| GET | `/systems/{name}/related` | 관련 시스템 조회 |

### 6.2 `/ask` 요청/응답

**요청:**
```json
{
  "question": "변신 에픽 등급의 적용 스텟 수는?",
  "conversation_id": "uuid (선택, 없으면 자동 생성)",
  "role": "기획자 (선택)",
  "model": "claude-sonnet-4-5 (선택)"
}
```

**응답:**
```json
{
  "answer": "...",
  "sources": [{"workbook": "...", "sheet": "...", "section": "..."}],
  "confidence": "high|medium|low|none",
  "related_systems": ["관련 시스템1", "..."],
  "conversation_id": "uuid",
  "tokens_used": {"input": 15000, "output": 500},
  "api_seconds": 6.5
}
```

### 6.3 대화 메모리

- In-memory 저장 (서버 재시작 시 초기화)
- `conversation_id` 기준 최근 3턴 유지
- 이전 답변은 500자로 요약하여 전달

### 6.4 실행

```bash
cd packages/qna-poc
uvicorn src.api:app --host 0.0.0.0 --port 8000 --reload
```

---

## 7. Demo UI (`src/demo_ui.py`)

### 7.1 구성

| 항목 | 값 |
|------|-----|
| 프레임워크 | Gradio `ChatInterface` |
| 포트 | 7860 |
| 역할 선택 | 드롭다운 (선택 안 함, 기획자, 프로그래머, QA, PD) |
| 예시 질문 | 5개 |
| 대화 히스토리 | 최근 3턴 |

### 7.2 응답 포맷

```
[LLM 답변]
---
**참조한 기획서:**
  - 워크북 / 시트
**관련 시스템:** 시스템1, 시스템2
*토큰: 15,000 in / 500 out | 응답: 6.5초 | 신뢰도: high*
```

### 7.3 실행

```bash
cd packages/qna-poc
python -m src.demo_ui
# http://localhost:7860 에서 접속
```

---

## 8. 평가 시스템 (`eval/`)

### 8.1 질문 세트 (`eval/questions.json`)

| 항목 | 값 |
|------|-----|
| 총 질문 | 48개 |
| 카테고리 | 6개 (A~F) × 8문항 |
| 직군 | 4개 (기획자, 프로그래머, QA, PD) × 12문항 |

| 카테고리 | 설명 | 난이도 |
|----------|------|--------|
| A. 사실 조회 | 단일 문서에서 즉답 | 쉬움 |
| B. 시스템 간 연관 | 2개+ 문서 종합 필요 | 어려움 |
| C. 밸런스 수치 | 정확한 숫자/공식 | 중간 |
| D. 프로세스/플로우 | Mermaid 플로우차트 추적 | 중간 |
| E. UI 사양 | UI 요소/레이아웃 | 중간 |
| F. 메타/히스토리 | 변경 이력/용어 정의 | 쉬움 |

### 8.2 평가 기준

```
키워드 매칭:
  - expected_keywords 리스트와 답변 텍스트 비교 (case-insensitive)
  - keyword_score = 적중 수 / 전체 키워드 수

출처 매칭:
  - 워크북명이 답변에 포함되는지 확인 (대소문자 무시)
  - 시트명은 참고 지표 (필수 아님)

종합 판정:
  - keyword_score ≥ 80% → PASS (강한 내용 매칭 시 출처 무관)
  - keyword_score 50~79% → 워크북 출처도 매칭되어야 PASS
  - keyword_score < 50% → FAIL
```

### 8.3 실행

```bash
cd packages/qna-poc
python -m eval.evaluate                    # 전체 48개 질문 평가
python -m eval.evaluate --category A       # 카테고리별 평가
python -m eval.evaluate --id A-기획-01     # 단일 질문 평가
python -m eval.evaluate --dry-run          # 질문만 출력 (API 호출 안 함)
python -m eval.evaluate --output eval/results.json  # 결과 JSON 저장
```

---

## 9. 데이터 의존성

```
packages/xlsx-extractor/output/**/_final/content.md  ← Indexer 입력 (629개)
_knowledge_base/knowledge_graph.json                 ← Retriever KG 탐색 (405 시스템, 627 관계)
~/.qna-poc-chroma/                                   ← ChromaDB 저장소 (1,783 청크)
packages/qna-poc/.env                                ← API 인증 정보
```

---

## 10. 기술 제약 및 알려진 이슈

| 이슈 | 영향 | 현황 |
|------|------|------|
| ChromaDB 한국어 경로 | HNSW 인덱스 손상 | `~/.qna-poc-chroma` (ASCII 경로)로 해결 |
| Titan 임베딩 배치 미지원 | 단건 호출 → 임베딩 15분 소요 | PoC에서 허용 (1회성) |
| 대화 메모리 인메모리 | 서버 재시작 시 소실 | PoC에서 허용 |
| 유의어 사전 수동 관리 | 새 시스템 추가 시 SYNONYMS 업데이트 필요 | 35+ 매핑 |
| 벡터 검색 한국어 | Titan v2 한국어 임베딩 품질 미검증 | 구조적 검색이 1차이므로 실질 영향 작음 |
| Windows cp949 인코딩 | 이모지 포함 출력 시 크래시 | UTF-8 stdout 래퍼로 해결 |
| 응답 시간 21.9초 | LLM 호출이 병목 (임베딩 + 생성) | 최적화 여지 있음 (15초 목표) |
