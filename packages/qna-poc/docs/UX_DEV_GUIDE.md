# QnA UX 개발 가이드

> 이 문서는 다른 Claude 채널에서 UX 개발을 시작할 때 참고하는 가이드입니다.
> 백엔드(Agent 파이프라인)는 별도 채널에서 품질 개선 중이므로, **UX는 API를 통해서만 접근**합니다.

---

## 현재 상태 (2026-03-12)

- **백엔드**: Agent 파이프라인 완성, 94.2% PASS (95% 목표 진행 중)
- **API**: `src/api.py` — FastAPI, Agent 파이프라인 연결 완료
- **UX 전략** (ADR-013):
  1. **Streamlit**: 개발 테스트 + 내부 품질 검증
  2. **Slack 봇**: 기획자 테스터 배포 (Slack Bolt)
  3. 피칭 후 Next.js 전환 (6단계)

---

## 1. 백엔드 API 사용법

### 서버 실행
```bash
cd "c:/Users/jacob.JACOB-D/Documents/proj-k 기획/packages/qna-poc"
PYTHONUTF8=1 uvicorn src.api:app --host 0.0.0.0 --port 8000 --reload
```

### 핵심 엔드포인트

#### POST /ask — 기획 QnA (메인)
```json
// Request
{
    "question": "물약 쿨타임 설정은?",
    "role": "기획자",           // optional: 기획자|프로그래머|QA|PD
    "conversation_id": null     // optional: 대화 연속성
}

// Response
{
    "answer": "물약 쿨타임은 ...",
    "confidence": "high",       // high|medium|low|none
    "sources": [
        {"workbook": "PK_물약 자동 사용 시스템", "sheet": "세부 내용", "section_path": "...", "score": 1.95}
    ],
    "conversation_id": "uuid",
    "total_tokens": 45000,
    "api_seconds": 12.3,
    "trace": [                  // Agent 파이프라인 각 단계 상세
        {"step": "planning", "seconds": 3.2, ...},
        {"step": "search", "seconds": 0.8, ...},
        {"step": "answer", "seconds": 7.5, ...},
        {"step": "reflection", "seconds": 2.1, ...}
    ]
}
```

#### POST /search — 검색만 (디버그)
```json
{"query": "물약 쿨타임", "limit": 10}
```

#### GET /health — 헬스체크
```json
{"status": "ok", "version": "0.2.0"}
```

#### GET /systems — 시스템 목록
#### GET /systems/{name}/related — 관련 시스템

### 직접 Python 호출 (Streamlit에서)
```python
from src.agent import agent_answer

result = agent_answer("물약 쿨타임 설정은?", role="기획자")
# result = {
#     "answer": str,
#     "chunks": list[dict],
#     "trace": list[dict],
#     "confidence": str,       # high/medium/low/none
#     "total_tokens": int,
#     "total_api_seconds": float,
# }
```

---

## 2. Streamlit 개발 가이드

### 목표
- ChatGPT 스타일 대화 UI
- 역할(기획자/프로그래머/QA/PD) 선택
- Markdown/표/Mermaid 렌더링
- 출처(워크북/시트) 표시
- Agent 트레이스 접기/펼치기 (디버그)

### 기존 파일
- `src/demo_ui.py` — 기존 Gradio UI (참고용, 교체 대상)
- 새 파일: `src/streamlit_app.py` 권장

### 실행
```bash
cd "c:/Users/jacob.JACOB-D/Documents/proj-k 기획/packages/qna-poc"
PYTHONUTF8=1 streamlit run src/streamlit_app.py
```

### 핵심 구현 포인트
1. **`st.chat_message`**: 대화 UI
2. **`st.sidebar`**: 역할 선택, 설정
3. **`st.expander("Agent Trace")`**: 트레이스 정보 접기
4. **`st.markdown`**: 답변 렌더링 (표, Mermaid 포함)
5. **`st.spinner`**: 응답 대기 중 표시 (10-30초 소요)
6. **`st.session_state`**: 대화 히스토리

### 의존성
```
streamlit>=1.30.0
```
기존 `requirements.txt`에 추가 필요.

---

## 3. Slack 봇 개발 가이드

### 목표
- `@ProjectK` 멘션 또는 DM으로 질문
- 스레드 답변 (채널 오염 방지)
- Markdown 포맷 → Slack Block Kit 변환
- 긴 답변은 Streamlit 링크 제공

### 기술 스택
- **Slack Bolt for Python** (`slack-bolt`)
- Socket Mode (서버 없이 로컬 실행 가능)

### 필요 설정
1. Slack App 생성 (api.slack.com)
2. Bot Token Scopes: `chat:write`, `app_mentions:read`, `im:history`
3. Socket Mode 활성화
4. `.env`에 추가:
   ```
   SLACK_BOT_TOKEN=xoxb-...
   SLACK_APP_TOKEN=xapp-...
   ```

### 파일 구조
```
src/
  slack_bot.py      # Slack Bolt 앱 (신규)
  slack_formatter.py # Markdown→Slack Block Kit 변환 (신규)
```

### 의존성
```
slack-bolt>=1.18.0
slack-sdk>=3.25.0
```

---

## 4. 병렬 작업 시 주의사항

### 수정 금지 파일 (백엔드 채널에서 작업 중)
- `src/agent.py` — Agent 파이프라인 (품질 개선 중)
- `src/retriever.py` — 검색 로직
- `src/generator.py` — LLM 호출
- `src/indexer.py` — 인덱싱
- `eval/` — 평가 스크립트 전체

### 수정 가능 파일
- `src/api.py` — API 엔드포인트 (필요 시 필드 추가 OK, 기존 필드 변경 X)
- `src/streamlit_app.py` — Streamlit UI (신규 생성)
- `src/slack_bot.py` — Slack 봇 (신규 생성)
- `src/slack_formatter.py` — Slack 포맷터 (신규 생성)
- `requirements.txt` — 의존성 추가 OK

### 공유 인터페이스 (변경 시 양쪽 동기화 필요)
```python
# agent_answer() 반환 형식 (고정)
{
    "answer": str,
    "chunks": list[dict],   # workbook, sheet, section_path, text, score 포함
    "trace": list[dict],    # step, seconds, model, description 포함
    "confidence": str,       # "high" | "medium" | "low" | "none"
    "total_tokens": int,
    "total_api_seconds": float,
}
```

---

## 5. 환경 설정

### .env 필수 항목 (기존)
```
AWS_REGION=us-west-2
AWS_BEARER_TOKEN_BEDROCK=...
```

### .env 추가 항목 (UX용)
```
# Slack 봇 (선택)
SLACK_BOT_TOKEN=xoxb-...
SLACK_APP_TOKEN=xapp-...
```

### ChromaDB
- 경로: `~/.qna-poc-chroma`
- 컬렉션: `project_k`
- 4,133 chunks (Excel 2,800+ / Confluence 1,200+)
- 인덱싱은 백엔드 채널에서 관리

---

## 6. 응답 시간 참고

| 단계 | 소요 시간 | 비고 |
|------|-----------|------|
| Planning (Sonnet) | 3-5초 | 질문 분석 + 검색 전략 |
| Search | 0.5-2초 | 하이브리드 4레이어 |
| Answer (Sonnet) | 5-15초 | 질문 복잡도에 따라 변동 |
| Reflection (Haiku) | 2-4초 | 자체 검증 |
| **총 응답** | **10-25초** | 재시도 시 +10초 |

Streamlit/Slack UI에서는 반드시 로딩 표시 필요.
