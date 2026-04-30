---
name: cross-claude-bridge
description: WSL backend Claude (agent-sdk-poc, knowledge base, /home/jacob/repos/proj-k) 와 Windows frontend Claude (Klaud Electron desktop-app, packages/desktop-app/) 가 공유 파일 디렉토리(C:\shared\claude-bridge)를 통해 비동기 메시지를 주고받는 브리지. **세션 시작 시 자동 inbox 체크**, **사용자가 명시하지 않아도 frontend 영향이 있는 변경(API/이벤트 schema/포트/repo 경로)이 발생하면 능동적으로 send**, "프론트한테 알려줘", "메시지 확인", "백엔드 답변" 같은 표현 트리거.
---

# Cross-Claude Bridge — Project K

WSL 측 backend Claude 와 Windows 측 frontend Claude 가 파일 공유 디렉토리로 비동기 통신.

## 역할 매핑 (Project K 한정)

| role | 환경 | 책임 영역 |
|---|---|---|
| **backend** (이쪽) | WSL2, `/home/jacob/repos/proj-k` | agent-sdk-poc (FastAPI :8090), xlsx-extractor, confluence-downloader, ChromaDB, ranker, 지식베이스, MCP 서버, 통합 이벤트/JSON schema |
| **frontend** | Windows native, `packages/desktop-app/` | Klaud Electron (main/preload/renderer), sidecar (FastAPI :{port}), NSIS installer, electron-updater, IPC, webview, dev cycle (npm run release / build:win-portable / dev-bundle hot-swap) |

## 설정

- 프로젝트 루트 `/home/jacob/repos/proj-k/.bridge-config.json` 에서 `role`, `peer`, `shared_dir` 읽음.
- 공유 디렉토리: `/mnt/c/shared/claude-bridge` (WSL 측), `C:\shared\claude-bridge` (Windows 측 같은 위치).
- 디렉토리 트리 (이미 생성됨):
  ```
  claude-bridge/
  ├── inbox/backend/      ← 내가 받는 (frontend → backend)
  ├── inbox/frontend/     ← 내가 보내는 (backend → frontend)
  ├── processed/backend/  ← 내가 읽고 처리 완료
  ├── processed/frontend/ ← peer 가 읽고 처리 완료 (참고용)
  └── log.jsonl           ← append-only 송수신 로그
  ```

## 메시지 파일 포맷

파일명: `{YYYYMMDD-HHMMSS}-{6자리 hex}.md` (UTC 기준, 시간순 정렬)

```markdown
---
id: 20260430-153022-a8f31c
from: backend
to: frontend
timestamp: 2026-04-30T06:30:22Z
tag: info|request|question|done|urgent
subject: 한 줄 요약 (50자 내)
reply_to: <원본 id>   # 답장일 때만
related_paths:        # 선택, 영향받는 파일/모듈
  - packages/agent-sdk-poc/src/server.py
related_commits:      # 선택, push 한 commit hash
  - 92a7e9d
---

본문 마크다운. **무엇이 / 왜 / 무엇을 해야 하는지**를 명확히.

## tag 가이드

- `info` — 정보 공유, 액션 불필요. 알기만 하면 됨. (예: "API 추가됨, 호출 가능")
- `request` — 작업 요청. peer 가 행동해야 함. (예: "sidecar 에 /review_stream proxy 라우트 추가 필요")
- `question` — 답변 필요. (예: "renderer 의 readToken 필드명이 뭐야?")
- `done` — 이전 request/question 종결 보고. reply_to 필수.
- `urgent` — 빌드 깨짐, 사용자 막힘 등 즉시 대응 필요.
```

---

## 동작

### A. inbox 자동 체크 (세션 시작 시 자동)

세션의 첫 응답 직전에 다음을 자동 수행:

1. `ls /mnt/c/shared/claude-bridge/inbox/backend/*.md` (없으면 패스, 에러 무시).
2. 파일이 있으면 각각의 frontmatter 만 빠르게 read 해서 (`head -20` 으로 충분):
   - "**📬 frontend 로부터 N건의 미확인 메시지** — \[tag\] subject ..." 형태로 한 줄씩 요약 보여주기.
3. **`info` 태그는 자동으로 컨텍스트 흡수** — 사용자에게는 "이런 알림이 와있었어요" 정도만 짧게.
4. **`request`/`question`/`urgent` 태그는 사용자 확인 후 처리** — 자동으로 작업 시작 금지. "지금 처리할까요?" 묻기.
5. 사용자 첫 메시지가 메시지 처리와 무관한 다른 작업이면 inbox 알림은 짧게 한 줄만 띄우고 사용자 작업 우선.

inbox 체크는 **세션 첫 응답에 한 번**만. 이후 매 턴 자동 수행 X (사용자 의식 흐름 끊김). 단, 사용자가 "메시지 확인", "받은 거 있나?" 라고 하면 즉시 재체크.

### B. 메시지 읽기 + 처리

1. `Read` 로 파일 전체 읽기.
2. 사용자에게 본문 보여주고 `tag` 에 따라:
   - `info`: "알겠어요, 컨텍스트에 반영" + 자동 processed 이동
   - `request`/`question`: "이대로 진행할까요?" 사용자 컨펌 후 작업/답변 → 답장 (`done` tag, reply_to=원본id) → processed 이동
   - `urgent`: 즉시 사용자에게 보고 + 작업 우선순위 최상
3. processed 이동:
   ```bash
   mv "/mnt/c/shared/claude-bridge/inbox/backend/<id>.md" \
      "/mnt/c/shared/claude-bridge/processed/backend/<id>.md"
   ```
4. log.jsonl 에 `{"event":"read","actor":"backend","id":"<id>","tag":"...","at":"<UTC>"}` append.

처리 보류(사용자가 "나중에") 시: inbox 에 그대로 두기. 다음 inbox 체크에서 다시 보임.

### C. 메시지 보내기 (사용자 명시 트리거 시)

사용자가 "프론트한테 ~ 알려줘", "Klaud 쪽에 메시지", "frontend 에 물어봐" 등 표현하면:

```bash
cd /mnt/c/shared/claude-bridge

# 1. id 생성
id="$(date -u +%Y%m%d-%H%M%S)-$(openssl rand -hex 3)"
peer="frontend"
final="inbox/$peer/$id.md"
tmp="inbox/$peer/.tmp-$id"

# 2. 임시 파일에 작성 (절반쓰기 방지)
cat > "$tmp" <<'EOF'
---
id: <id>
from: backend
to: frontend
timestamp: <UTC ISO8601>
tag: <tag>
subject: <subject>
related_paths:
  - <path>
---

<body>
EOF

# 3. 원자적 이동
mv "$tmp" "$final"

# 4. log 기록
echo '{"event":"send","actor":"backend","to":"frontend","id":"'$id'","tag":"<tag>","subject":"<subject>","at":"<UTC>"}' >> log.jsonl
```

본문 가이드:
- **무엇이 바뀌었는지** 명확히 (파일 경로, 함수명, 라인 번호, commit hash).
- **frontend 가 무엇을 해야 하는지** 구체적으로. "확인 부탁" 같은 모호한 말 금지.
- **schema/contract 변경**은 변경 전/후를 표 또는 코드 블록으로 비교.
- 한 메시지 = 한 주제. 여러 건이면 여러 번 send.

### D. 답장

원본 메시지의 `id` 를 `reply_to` 에 넣고, `subject` 는 `Re: <원본 subject>`. tag 는 보통 `done` (request/question 응답) 또는 `info`.

---

## 🔥 능동 발신 규칙 (사용자 명시 없이 자동 send)

**다음 조건 중 하나에 해당하는 작업을 backend 에서 완료/시작했으면, 사용자가 시키지 않아도 frontend 에 메시지를 보낸다.** 이 작업이 끝난 직후, 답변 마지막에 "→ frontend 에 \[tag\] '\<subject\>' 로 알림 보냈어요" 한 줄 추가.

### 능동 send 트리거 (tag = `info` 또는 `request`)

| 상황 | 예시 | tag |
|---|---|---|
| **agent-sdk-poc API 추가/변경/제거** | 새 endpoint mount, request/response shape 변경, query param 추가, status code 변경 | `info` (호환 유지) / `request` (호환 깨짐 → frontend 코드 수정 필요) |
| **NDJSON/SSE 이벤트 schema 변경** | `{type:"token", text}` 의 필드명, 신규 event type, payload shape 변경 | `info` 또는 `request` |
| **포트/호스트/URL 변경** | 8090 → 8091, /api/v1 prefix 도입 | `info` |
| **agent-sdk-poc 재시작 + 동작 변경** | 큰 prompt/모델/라우팅 변경으로 같은 입력에 답이 달라짐 | `info` |
| **knowledge base 재인덱싱** | ChromaDB 갱신, 새 코퍼스 추가 — frontend 검색 결과가 달라짐 | `info` |
| **shared schema/types 변경** | `packages/desktop-app/src/shared/types.ts` 와 backend pydantic 둘 다 영향 | `request` |
| **commit push (frontend 가 알아야 할)** | frontend 가 깔린 git working tree 의 backend 코드 변경 push 됨 | `info` (commit hash + 한줄 요약) |
| **계약 위반 감지** | frontend 코드에서 backend 가 안 주는 필드를 기대하는 걸 발견 | `urgent` |
| **장시간 작업 시작/완료** | "지금부터 30분간 ChromaDB 재인덱싱" / "완료" | `info` |

### 능동 send 금지 (메시지 보내지 말 것)

- **backend 내부 리팩터링** 으로 frontend 가 호출하는 contract 가 안 바뀐 경우 (ranker 내부, xlsx-extractor 내부 등).
- **typo, 주석, format 정리** 같은 의미 없는 변경.
- **탐색/조사** — 코드 읽기만 하고 변경 안 함.
- **테스트 데이터 변경** — frontend 가 그 데이터를 직접 의존하지 않으면.
- **민감 정보** (토큰, 비밀번호, AWS 키, .env 내용 — 절대 본문에 포함 X).
- 같은 변경을 **30분 내에 이미 알린 경우** — 중복 send 금지. log.jsonl 에서 최근 send 확인.

### 판단이 모호할 때

다음 질문을 한 번 던지고 답이 "예" 면 send:
1. 이 변경 때문에 **frontend 가 새 코드를 짜거나 기존 코드를 고쳐야 하는가?** → `request`
2. frontend 가 **모르고 있으면 다음 작업에서 헛수고할 가능성이 있는가?** → `info`
3. frontend 가 곧 동일한 정보를 묻거나 충돌할 가능성이 있는가? → `info`

답이 "아니오"면 send 하지 않는다.

---

## 운영 규칙

- **세션 시작 시 inbox 체크 자동 수행** — 사용자가 시키지 않아도. 단, 알림은 짧게 (≤ 3줄).
- **info 는 흡수, request/question 은 컨펌 후 처리.**
- **임시파일 → mv 패턴 필수** — peer 가 절반쓰기 파일 보면 frontmatter 파싱 깨짐.
- **UTF-8 + LF** — Windows CRLF 섞이지 않게 (heredoc/Write 도구 사용 시 자동 LF).
- **삭제 금지, processed 이동만.** 사용자가 수동으로 비우게.
- **민감 정보 금지** — 평문 공유라 토큰/비번 본문 X.
- **한 메시지 = 한 주제.** 여러 건이면 여러 번 send. 답장 체인은 reply_to 로 추적.
- **id 생성**: `date -u +%Y%m%d-%H%M%S` + `openssl rand -hex 3` (둘 다 WSL 기본 포함).

## 자주 쓰는 명령

```bash
SHARED=/mnt/c/shared/claude-bridge

# inbox 미처리 목록
ls -t "$SHARED/inbox/backend/" 2>/dev/null

# 최근 메시지 frontmatter 만
for f in "$SHARED/inbox/backend/"*.md; do
  echo "--- ${f##*/} ---"; head -10 "$f"
done

# 최근 송수신 로그 5건
tail -5 "$SHARED/log.jsonl"

# id 생성
echo "$(date -u +%Y%m%d-%H%M%S)-$(openssl rand -hex 3)"
```

## 예시 메시지 (능동 발신)

```markdown
---
id: 20260430-133022-a8f31c
from: backend
to: frontend
timestamp: 2026-04-30T13:30:22Z
tag: info
subject: agent-sdk-poc /review_stream + /suggest_edits 추가, 8090 재시작 완료
related_paths:
  - packages/agent-sdk-poc/src/server.py
  - packages/agent-sdk-poc/src/bedrock_stream.py
related_commits:
  - 92a7e9d
---

# /review_stream + /suggest_edits 추가

## 추가된 endpoint

- `POST /review_stream` — Confluence 리뷰, NDJSON 토큰 스트리밍
- `POST /suggest_edits` — 부분 편집 제안, NDJSON 토큰 스트리밍

## 이벤트 schema (양쪽 동일)

| event type | 필드 | 비고 |
|---|---|---|
| `status` | `message` | 진행 상태 (이모지 포함) |
| `token` | `text` | text_delta 단위 |
| `result` | `data` | 최종 결과 (구체 shape 아래 참고) |
| `error` | `message` | 실패 |

`/review_stream` result.data: `{review: <JSON 문자열>, model, usage}`
`/suggest_edits` result.data: `{changes: [{id, section, description, before, after}], model, usage, raw_count}`

## frontend 가 할 일 (참고용)

- sidecar `packages/desktop-app/src/sidecar/server.py` 에 `/ask_stream` 패턴 그대로 두 endpoint proxy 라우트 추가.
- ReviewCard / ChangesCard 의 readToken 핸들러는 `event.text` 로 추출.
```

위 메시지처럼 "한 화면에 frontend 가 작업하는 데 필요한 모든 정보"가 들어가도록 작성한다.
