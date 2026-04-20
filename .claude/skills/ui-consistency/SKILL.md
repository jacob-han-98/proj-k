---
name: ui-consistency
description: agent-sdk-poc 프론트엔드(React)에서 메시지 답변·출처·본문 렌더링 변경 시 App / SharedPage / AdminPage 3곳이 갈라지지 않도록 강제. 신규 source kind / 인라인 패턴 / 너비 정책 / 아이콘 추가 시 반드시 이 스킬을 트리거.
---

# UI Consistency — 답변·출처·너비 단일 source 강제

## 왜 필요한가

agent-sdk-poc 의 메시지 답변 영역은 **세 화면**에서 동일하게 표시되어야 한다:

1. **메인 채팅** — App.tsx
2. **공유 링크 뷰** — SharedPage.tsx (`/shared/<conv_id>`)
3. **Admin 대화 상세** — AdminPage.tsx (`/admin`)

과거 패턴: 메인 채팅에만 신규 기능(예: 새 source kind, 새 아이콘, 새 너비 정책) 적용 → 공유/Admin 누락 → 사용자 캡처에서 갈라짐 발견 → 사후 patch. 이 사이클을 끊는다.

## 단일 source of truth — 절대 위배 금지

| 영역 | 단일 정의 위치 | 절대 inline 금지 화면 |
|------|---------------|------------------|
| 본문 Markdown 렌더 (mermaid, 인라인 출처 anchor) | `frontend/src/assistantRender.tsx::RenderAssistantMarkdown` | App / Shared / Admin |
| 출처 카드 (PK / 타게임 / 웹 그룹 분리, 아이콘) | `frontend/src/assistantRender.tsx::RenderSourceCards` | App / Shared / Admin |
| 인라인 출처 body 파싱 (xlsx/confluence/external/web/other) | `frontend/src/assistantRender.tsx::parseInlineSourceBody` | App / Shared / Admin |
| 출처 아이콘 (Excel/Confluence/External/Web) | `frontend/src/assistantRender.tsx` 의 named export | App / Shared / Admin |
| 후속 질문 카드 | `frontend/src/assistantRender.tsx::FollowUpCards` | App / Shared / Admin |
| 채팅·답변 컨테이너 폭 | `frontend/src/index.css` 의 `--chat-max-width` 변수 | App / Shared / Admin |
| 출처 분기 (storage 측 origin_label 생성) | `packages/agent-sdk-poc/src/storage.py::_path_to_source_meta` | (백엔드 단일) |

**App.tsx / SharedPage.tsx / AdminPage.tsx 안에 동일 함수를 또 정의하지 않는다.** import 만 한다.

## 변경이 트리거되는 패턴

다음 중 하나라도 해당하면 이 스킬을 적용:

- 새 `source` kind 추가 (예: `web` → `pdf` 추가)
- 새 출처 아이콘 (색·모양) 추가
- 인라인 출처 본문 패턴 변경 (예: `(출처: …)` 외 새 표기 추가)
- 출처 카드 그룹 추가/순서 변경
- 메시지 컨테이너 max-width / padding 변경
- ReactMarkdown components 옵션 변경 (code, a, table 등)
- `linkifyInlineSources` 정규식 수정
- `parseInlineSourceBody` kind union 변경
- 후속 질문 카드 디자인 변경

## 작업 순서 (반드시 이대로)

1. **변경은 `assistantRender.tsx` (또는 `index.css` :root) 한 곳에만 한다**.
   - App.tsx / SharedPage.tsx / AdminPage.tsx 에는 inline 정의를 추가하지 말 것.
   - 인라인 코드 발견 시 → 곧바로 assistantRender 로 backport + 호출 측 import.

2. **타입 일관성 — `Source['source']` 타입을 `api.ts` 한 곳에서만 확장**.
   - 새 kind 추가 시: `'xlsx' | 'confluence' | 'summary' | 'image' | 'external' | 'web' | <new> | 'other'`
   - storage.py 의 `_path_to_source_meta` 도 같이 분기 추가 (백엔드).

3. **CSS 변수 사용 — 폭은 `--chat-max-width` 만**.
   - `.chat-container`, `.shared-content`, `.admin-content` 모두 `max-width: var(--chat-max-width)` 사용.
   - 직접 `1060px`, `820px` 같은 magic number 박지 말 것.

4. **검증 (`playwright-web-verify` 스킬 활용)**:
   - 동일 conversation 을 main / shared / admin 3곳에서 모두 캡처
   - 픽셀 너비 동일 + 동일 source 의 아이콘 동일 확인
   - 비교 모드 답변(웹 출처 포함) 도 3곳 모두 캡처해서 web/external 그룹·아이콘 일치 확인

5. **단위 검증** (변경 분량이 작을 때):
   - `cd frontend && npm run build` 통과
   - `tsc --noEmit -p tsconfig.app.json` 통과

## 검증 체크리스트 (배포 전 반드시 통과)

- [ ] App.tsx / SharedPage.tsx / AdminPage.tsx 에 inline 정의 0건
  - `grep -nE "function (linkifyInlineSources|parseInlineSourceBody)|const (ExcelIcon|ConfluenceIcon|ExternalIcon|WebIcon|renderSources)" frontend/src/{App,SharedPage,AdminPage}.tsx` → 비어 있어야
- [ ] `frontend/src/assistantRender.tsx` 가 모든 source kind 처리 (xlsx/confluence/external/web/other)
- [ ] `index.css` `:root` 에 `--chat-max-width` 정의 + 3개 컨테이너 모두 변수 사용
- [ ] `npm run build` 성공 (Node 20)
- [ ] Playwright: main/shared/admin 동일 conversation 답변 폭 동일, 동일 source 카드 동일 아이콘
- [ ] 비교 모드 답변에 web/external 출처 포함된 케이스를 main/shared/admin 모두 캡처해서 시각 확인

## Gotchas (재발 방지용 — 발견 시 즉시 추가)

- **Linter / IDE auto-revert** — 큰 Edit 으로 inline 코드를 제거하면 일부 환경에서 파일이 원복되는 경우 발견됨. **각 Edit 직후 `git add`** 로 stage 에 올려두면 보호된다.
- **Node 18 vs Node 20** — `vite` 가 `CustomEvent` 미정의로 깨짐. 반드시 `nvm use 20` 후 build.
- **package SourceView 타입 union** — `api.ts::SourceView['source']` 는 backend `/source_view` 가 반환하는 타입만 (xlsx/confluence/summary/image/other). external/web 은 source_view 호출 안 하므로 union 추가 불필요.
- **`Source` vs `SourceView` 혼동** — `Source['source']` (출처 카드용) 는 'external'/'web' 포함, `SourceView['source']` (스플릿 뷰용) 는 미포함. 다른 인터페이스.
- **deploy/push.sh 의 ssh heredoc + `~` expand 안 됨** — `cd ~/proj-k-agent/...` 가 실패. 절대경로 `/home/ubuntu/...` 사용. `DEPLOY_SERVER=ubuntu@cp.tech2.hybe.im` (jacob 아님), `~/.ssh/config` 의 `Host cp.tech2.hybe.im` mapping 활용.

## 관련 파일

- `packages/agent-sdk-poc/frontend/src/assistantRender.tsx` — 단일 컴포넌트
- `packages/agent-sdk-poc/frontend/src/api.ts` — Source 타입
- `packages/agent-sdk-poc/frontend/src/index.css` — `--chat-max-width` 변수
- `packages/agent-sdk-poc/frontend/src/App.css` — `.chat-container`, `.shared-content` 등
- `packages/agent-sdk-poc/src/storage.py` — `_path_to_source_meta` (백엔드 origin_label)
- `.claude/skills/playwright-web-verify/SKILL.md` — 검증 도구
