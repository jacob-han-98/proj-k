# QnA PoC

Excel 기획서 지식 베이스에 대한 자연어 질의응답 시스템. Hybrid Retrieval (구조적 KG + 벡터 시맨틱) + Claude Sonnet 답변 생성.

## 상위 프로젝트

**Project K AI 기획 어시스턴트** (`proj-k 기획/`)의 2단계(QnA PoC) 핵심 모듈.
1단계에서 변환한 629개 content.md를 검색·질의하여 기획 질문에 답변한다.

## 평가 결과 (2026-03-09)

| 항목 | 값 |
|------|-----|
| 평가 질문 | 48개 (6 카테고리 × 4 직군) |
| **통과** | **48/48 (100%)** |
| 평균 응답 | 21.6초 |
| 쿼리당 비용 | ~$0.05 |

## 아키텍처

```
질문 입력
  │
  ├─ [Query Analyzer]      시스템명 추출 + 유의어 매핑 (30+ 사전)
  │
  ├─ [Structural Search]   시스템→워크북 직접 매핑 + 키워드 랭킹 (1차)
  ├─ [KG Expand]           knowledge_graph.json 관계 탐색 (2차)
  ├─ [Vector Search]       ChromaDB 시맨틱 검색 (보조)
  │
  ├─ [Ranking & Budget]    중복 제거 + 스코어 랭킹 + 토큰 예산 (80K) 내 조립
  │
  ├─ [Answer Generator]    Claude Sonnet 4.5 via Bedrock (출처 포함)
  │
  └─ 답변 + 출처 + 관련 시스템 + 메타
```

**왜 RAG인가**: ~462KB ≈ 300K-400K 토큰 → 전체 컨텍스트 투입 불가. RAG로 관련 청크만 추출하면 쿼리당 <$0.05.

**왜 KG-first인가**: 게임 기획서는 시스템명이 명확하여 구조적 매칭이 벡터 검색보다 정확. 벡터는 유의어/애매한 표현 보완용.

## 빠른 시작

### 1. 환경 설정

```bash
cd packages/qna-poc
pip install -r requirements.txt
```

`.env.example`을 복사하여 `.env` 생성:
```
AWS_BEARER_TOKEN_BEDROCK=your-token
AWS_REGION=ap-northeast-2
```

### 2. 인덱싱 (최초 1회)

```bash
# 전체 629개 content.md → 1,783 청크 → ChromaDB
python -m src.indexer --reset

# 단일 워크북 테스트
python -m src.indexer --workbook "PK_변신 및 스킬 시스템"

# 통계만 확인 (API 호출 없음)
python -m src.indexer --stats
```

> 전체 임베딩 약 15분 소요, ~$0.02 비용

### 3. 실행

**데모 UI (Gradio)**:
```bash
python -m src.demo_ui
# → http://localhost:7860
```

**API 서버 (FastAPI)**:
```bash
uvicorn src.api:app --host 0.0.0.0 --port 8000 --reload
```

**평가**:
```bash
# 전체 48개 질문 (LLM 답변 포함)
python -m eval.evaluate
python -m eval.evaluate --category A

# 495개 Ground Truth 대규모 검증 (검색만, LLM 비용 없음)
python -m eval.verify_gt_500
python -m eval.verify_gt_500 --sample 50    # 50개 샘플
python -m eval.verify_gt_500 --category A   # 카테고리 필터

# GT QnA 재생성
python -m eval.generate_gt_questions
```

## API 엔드포인트

| 메서드 | 경로 | 설명 |
|--------|------|------|
| POST | `/ask` | 기획 QnA 질문 (역할·대화ID 지원) |
| POST | `/search` | 검색만 수행 (디버그용) |
| GET | `/systems` | 인덱싱된 시스템 목록 |
| GET | `/systems/{name}/related` | 관련 시스템 조회 |

**예시**:
```bash
curl -X POST http://localhost:8000/ask \
  -H "Content-Type: application/json" \
  -d '{"question": "변신 에픽 등급의 적용 스텟 수는?", "role": "기획자"}'
```

## 프로젝트 구조

```
packages/qna-poc/
├── src/
│   ├── indexer.py       # 청킹 + 임베딩 + ChromaDB 적재
│   ├── retriever.py     # 하이브리드 검색 (구조적 KG + 벡터)
│   ├── generator.py     # Claude Sonnet 답변 생성
│   ├── api.py           # FastAPI 엔드포인트
│   └── demo_ui.py       # Gradio 채팅 UI
├── eval/
│   ├── questions.json          # 48개 평가 질문 (6카테고리 × 4직군)
│   ├── evaluate.py             # 자동 평가 스크립트
│   ├── results.json            # 평가 결과
│   ├── generate_gt_questions.py # GT QnA 대량 생성 (495개)
│   ├── gt_questions.json       # 생성된 495개 QnA (45개 할루시네이션 트랩)
│   ├── verify_gt_500.py        # 대규모 Retriever 검증
│   ├── verify_retriever_deep.py # 10개 수동 GT 심층 검증
│   └── verify_retriever.py     # 검색 품질 기본 검증
├── docs/
│   ├── README.md        # 이 파일 — 개요, 실행법, 구조
│   ├── SPEC.md          # 기술 스펙 — 알고리즘, 파라미터, API 상세
│   ├── VERIFICATION.md  # 검증 현황 — 평가 결과, 모듈별 검증, 한계
│   └── MEMORY.md        # 작업 기록 — 세션 간 진행 상태
├── .env                 # API 키 (gitignore)
├── .env.example
└── requirements.txt
```

## 기술 스택

| 컴포넌트 | 선택 | 이유 |
|----------|------|------|
| Backend | FastAPI | 기존 Python 코드베이스, async |
| Vector DB | ChromaDB (로컬) | pip install, 2K 청크에 충분 |
| 임베딩 | Amazon Titan v2 (Bedrock) | 추가 벤더 불필요, 한국어 지원 |
| LLM | Claude Sonnet 4.5 (Bedrock) | 비용 효율, QnA에 충분 |
| 그래프 | NetworkX | knowledge_graph.json 로드 |
| Demo UI | Gradio | 20줄로 채팅 UI |

## 데이터 의존성

```
packages/xlsx-extractor/output/**/_final/content.md  ← 입력 (629개)
_knowledge_base/knowledge_graph.json                 ← KG (405 시스템, 627 관계)
~/.qna-poc-chroma/                                   ← ChromaDB (1,783 청크)
```

## 관련 문서

| 문서 | 역할 |
|------|------|
| [SPEC.md](SPEC.md) | 모듈별 알고리즘, 파라미터, 입출력 상세 |
| [VERIFICATION.md](VERIFICATION.md) | 평가 결과, 모듈별 검증, 최적화 히스토리 |
| [MEMORY.md](MEMORY.md) | 개발 진행 기록 (세션 간 상태 유지) |
