# Project K — Agent SDK PoC

Claude Agent SDK로 재구성한 Project K 기획 QnA 에이전트. 기존 `packages/qna-poc/`와 병렬로 운영한다.

- **URL (배포)**: https://cp.tech2.hybe.im/proj-k/agentsdk/
- **로컬**: http://localhost:8090/

## 차이점 (vs. qna-poc)

| 요소 | qna-poc | agent-sdk-poc |
|------|---------|----------------|
| 검색 | ChromaDB + 4-레이어 하이브리드 | Glob/Grep/Read + KG MCP |
| 파이프라인 | Planning→Search→Answer→Reflection | Agent SDK 내장 tool_use 루프 |
| 인덱스 | 벡터 임베딩 1,673 청크 | 텍스트 인덱스 3종 (MASTER/summaries/TERM) |
| LLM 호출 | Bedrock 게이트웨이 수동 | Claude Agent SDK |
| UI | Streamlit | FastAPI + SSE + 정적 HTML |

## 디렉터리 구조

```
agent-sdk-poc/
├── CLAUDE.md            # 에이전트 도메인 지식 + 워크플로우
├── src/
│   ├── agent.py         # query() + ClaudeAgentOptions
│   ├── projk_tools.py   # KG MCP 툴 (list_systems, find_related_systems, glossary_lookup)
│   └── server.py        # FastAPI + SSE
├── index/               # 사전 빌드 산출물 (Phase 1에서 생성)
│   ├── MASTER_INDEX.md
│   ├── TERM_INDEX.md
│   ├── summaries/       # 시트별 300~500토큰 요약
│   └── knowledge_graph.json  # symlink → _knowledge_base/knowledge_graph.json
├── scripts/
│   ├── build_summaries.py
│   ├── build_master_index.py
│   └── build_term_index.py
├── static/
│   └── index.html
├── deploy/
├── tests/
└── requirements.txt
```

## 로컬 실행

```bash
cd packages/agent-sdk-poc
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env && vi .env           # AWS_BEARER_TOKEN_BEDROCK 채우기
cd src && uvicorn server:app --port 8090  # 또는 python server.py
```

브라우저에서 http://localhost:8090/ 접속.

## 인덱스 빌드 (Phase 1)

코퍼스가 변경된 경우에만 재빌드.

```bash
python scripts/build_summaries.py --sample 10     # 10개 PoC
python scripts/build_summaries.py --workbook "PK_HUD 시스템"   # 1 워크북 검증
python scripts/build_summaries.py --all           # 전체 (1,332 파일, ~$3, ~2h)
python scripts/build_master_index.py
python scripts/build_term_index.py
```
