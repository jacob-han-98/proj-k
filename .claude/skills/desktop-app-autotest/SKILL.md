---
name: desktop-app-autotest
description: Klaud 데스크톱 앱의 닫힘 루프 자동 검증 인프라. 사용자가 ⚙ 설정에서 selfTestEnabled=true 로 켜둔 상태에서, Claude 가 코드 수정 → npm run release 하면 사용자 PC 의 Klaud 가 자동 업데이트로 새 빌드 받음 → 부팅 후 5초 뒤 미리 정의된 시나리오 자동 수행 → 각 단계 스크린샷 + 결과를 WSL collector(8767)로 POST → Claude 가 collector stdout 을 tail 로 모니터해서 분석 → 다음 변경. 매 사이클마다 사용자가 직접 스크린샷을 찍어 올릴 필요 없음. 트리거 조건은 desktop-app-verify 와 같지만 추가로 "검증을 단순 단위 테스트가 아닌 실제 GUI 캡처로 하고 싶을 때" / "사용자에게 수동 확인 부담 주기 싫을 때" / "회귀가 GUI 에서만 보이는 종류일 때" 즉시 호출.
user-invocable: false
allowed-tools:
  - Bash
  - BashOutput
  - Read
  - Edit
  - Write
---

# Desktop App 자동 자가검증 루프 (Klaud)

`packages/desktop-app/` 안의 코드를 수정하고 회귀가 실제 사용자 GUI 에서만 드러날 때, 사용자에게 "스크린샷 찍어 주세요" 시키지 않고 **사용자 PC 의 Klaud 가 직접 시나리오를 돌고 결과를 WSL 로 보내게** 하는 닫힘 루프.

## 전제 조건 (1회만 셋업)

1. 사용자 PC 의 Klaud 가 0.1.11+ 자동 업데이트 받은 상태
2. 사용자가 한 번이라도 ⚙ 설정 → "부팅 시 자동 자가테스트" 체크 + collector URL `http://localhost:8767` 입력 + 저장
3. WSL 에서 `npm run serve:test-collector` 백그라운드 실행 중

이 셋업은 한 번만. 그 후 영구 자동.

## 워크플로우 (Claude 가 매 사이클 수행)

### 1) 변경 + 검증 + 릴리스

```bash
cd /home/jacob/repos/proj-k/packages/desktop-app

# 코드 수정
npm test                      # 3계층 회귀 5초
npm run release               # 0.1.x → 0.1.x+1 자동 bump + dev.yml 갱신
```

자동 업데이트 메커니즘이 사용자 앱에 새 버전 배달.

### 2) 사용자 앱이 알아서

- 5초 후 dev.yml 폴링 → 새 버전 발견 → 백그라운드 다운로드
- 우측 하단 토스트 → 사용자 클릭 (또는 못 봤으면 다음 종료 시 자동)
- silent install + relaunch
- 부팅 5초 후 self-test 시나리오 자동 시작:
  - boot-shell (앱 첫 화면 캡처)
  - open-settings (모달 열기 → 캡처)
  - close-settings (모달 닫고 → 캡처)
  - send-question (채팅 입력 + 보내기 → 검색 결과 캡처)
  - after-stream (8초 대기 → 답변 스트림 후 캡처)
- 각 단계 결과를 WSL collector(8767)로 POST

### 3) Claude 가 collector 모니터

WSL 에서 collector 가 실행 중이라면 stdout 에 매 이벤트 한 줄씩 (JSON) 출력. `BashOutput` 으로 tail.

```bash
# 백그라운드 task ID 확인 (예: bnhf2olj2)
# BashOutput 으로 tail
```

이벤트 종류:
- `{kind: "run-start", run_id, app_version}` — 새 사이클 시작
- `{kind: "step", run_id, name, status, screenshot, meta}` — 한 단계 끝
- `{kind: "run-end", run_id, passed, failed, total}` — 사이클 종료

### 4) 스크린샷 분석

run 디렉터리: `packages/desktop-app/test-runs/<run_id>/`
- `meta.json` — 빌드 버전, 시작 시각
- `screenshots/00-boot-shell.png` ~ `04-after-stream.png`
- `events.log` — 단계별 이벤트
- `summary.json` — 최종 통과/실패 카운트

PNG 를 직접 `Read` 로 시각 확인. 또는 grep events.log 로 status=fail 골라 보기.

### 5) 다음 액션 결정

- 모두 pass + 스크린샷도 정상 → 작업 끝, 사용자에게 결과 한 줄 보고
- step fail / 스크린샷에 회귀 보임 → 코드 수정 → step 1 로 루프

## 트리거 조건 (자동 호출)

다음 상황에 이 스킬을 자동으로 호출:

1. `packages/desktop-app/` 안에서 코드 수정 후, 회귀가 GUI 에서만 보일 가능성이 있을 때
   - CSS 변경 (시각적 회귀)
   - 컴포넌트 layout 변경
   - IPC ↔ UI 동기화 흐름 변경
   - 자동 업데이트 / 토스트 / 모달 동작 변경
2. 사용자가 "스크린샷 찍어줘" / "확인해 봐" 같은 시각 검증 요청을 했을 때 (수동 부담 0 으로 대체)
3. `desktop-app-verify` 가 통과했지만 사용자 환경에서 다르게 보일까 의심될 때

수동 단위 테스트 (Vitest/pytest/Playwright web mode) 만으로 충분하면 `desktop-app-verify` 만 호출. 자동 GUI 검증이 추가로 필요하면 이 스킬.

## Collector 운영

```bash
# WSL 에서 한 번 시작 (백그라운드)
cd /home/jacob/repos/proj-k/packages/desktop-app
npm run serve:test-collector &
```

이미 떠있는지 확인:
```bash
curl -s http://127.0.0.1:8767/health
# {"ok":true}
```

미띠 있으면 다시 띄움. 사용자 PC Klaud 가 끄지 않은 한 collector 도 끄지 않는 게 좋음.

## 환경변수 / 채널

- `PROJK_SELFTEST_COLLECTOR_URL` — env 우선 (settings.json 이 비어있어도 동작)
- `dev` 채널만 self-test 활성 (production stable 채널 추가 시 false 디폴트)

## Gotchas

- **collector 미실행** → POST 가 silently fail. Klaud main 콘솔에 `[selftest] collector unreachable`. 이때 사용자 PC 의 self-test 시나리오 자체는 정상 진행되지만 결과는 안 옴. 항상 collector 먼저 띄울 것.
- **self-test 가 너무 자주 도는 것** — 매 부팅마다 1회. 사용자가 앱을 자주 껐다 켜면 매번 시나리오. 비용 측면에선 LLM 호출 1회 만 (백엔드가 응답하는 케이스). 하지만 noise 가 많으면 settings 토글 OFF.
- **시나리오 단계 추가/변경** → `src/main/selftest.ts` 의 `defaultScenario()` 수정. renderer 가 새 cmd 를 알아듣도록 `App.tsx` 의 `onSelfTestCommand` 분기도 같이.
- **timing 이슈** — `STABILIZE_MS` (600ms) + `postCmdWaitMs` 로 안정화. CSS 애니메이션 / 비동기 fetch 가 끝나기 전에 캡처되면 빈 화면. 늘려야 할 수 있음.
- **collector 디스크 사용** — 매 사이클 마다 5장 PNG (~수 MB). `test-runs/` 디렉터리는 .gitignore 에 들어가야 함 (이미 등록됨? 확인 필요).
- **여러 windows / 대화상자 노출** — `BrowserWindow.webContents.capturePage()` 는 "활성" window 만. self-test 중 사용자가 다른 모달을 열면 의도와 다른 화면 캡처될 수 있음. 사용자에게 self-test 동안 건드리지 말라고 안내하거나, 아예 시나리오를 더 짧게.
- **자동 업데이트 + self-test 동시 사이클** — release 한 번 하면 사용자 앱이 그것 받아 self-test 도는데, 그 사이 또 release 하면 사용자 앱이 두 번째 것을 폴링에 발견. 큰 문제 안 됨 (electron-updater 가 LATEST 만 받음). 그래도 한 번에 한 사이클만 돌리는 게 분석에 유리.

## 자율 의사결정 + 즉시 행동 원칙 (필수)

스크린샷을 분석한 결과 **수정이 필요하다고 판단되면, 사용자에게 묻지 않고 즉시 코드 수정·재빌드·재검증까지 한 사이클 더 돌려야 한다.** 이 닫힘 루프는 사용자 부담을 0 으로 만들기 위해 만든 것이며, "고칠지 말지" 를 사용자에게 매번 떠넘기면 그 가치가 사라진다.

### 자율 행동 트리거 (다음 중 하나라도 보이면 즉시 행동)

1. **시각 회귀**: 스크린샷에서 레이아웃 깨짐, 텍스트 잘림, 색 / 보더 누락, 컴포넌트 사라짐, 모달 viewport 밖
2. **시나리오 step fail**: status=fail 인 step 이 1개 이상 (assert-tree-non-empty 실패 등)
3. **답변 텍스트 비어있음**: after-stream 에서 assistant 메시지가 "..." spinner 만
4. **검색 결과 0건**: 사용자가 입력한 질문에 hit 카드가 안 보임 (백엔드 미실행은 별개 — 그 경우 백엔드 띄우기)
5. **콘솔 / events.log 에 에러 흔적**: ENOENT, timeout, null reference, IPC 실패 등

### 즉시 행동 절차

1. **원인 가설 수립** — 스크린샷 + events.log + 최근 코드 변경 묶어서 가장 그럴듯한 원인 1개
2. **즉시 코드 수정** — 가설에 따라 main/renderer/sidecar 어디든 수정
3. **`npm test`** — 3계층 단위 회귀 5초
4. **`npm run release`** — 자동 bump + dev.yml 갱신
5. **사용자 앱이 자동으로 다음 사이클** — 수정한 빌드를 받아서 self-test 재실행
6. **사용자에게는 한 줄 보고** — "0.1.x → 0.1.x+1: <한 줄 원인> 수정 → 자동 검증 통과" 또는 "여전히 실패. <다음 가설>"

### 사용자에게 묻고 가야 하는 경우 (자율 행동 X)

- **백엔드 인프라 변경** (qna-poc 셋업, AWS 권한, p4 sync 등) — 사용자 환경 의존
- **데이터 마이그레이션** (settings.json 스키마 변경, SQLite migration)
- **사용자 워크플로우 자체 변경** (UI 큰 재배치, 메뉴 구조 변경)
- **여러 가능성 중 하나를 골라야 하는 설계 결정** — 가설 2개 이상이면 짧게 묻기

### 사이클 한계

자율 사이클은 **연속 3회까지**. 3회 시도 후에도 같은 step fail 이 반복되면, 사용자에게 보고 + 가설 + 다음 액션 후보 제시하고 멈춘다. 무한 루프 방지.

## 보고 형식 (사용자에게)

매 사이클 후 사용자에게 한 묶음으로 보고:

```
🔄 0.1.x → 0.1.x+1 사이클
✅ 5/5 시나리오 단계 통과
스크린샷:
  - test-runs/run-2026-04-28T07-50-00/screenshots/00-boot-shell.png
  - ...
회귀: 없음
다음 변경: <다음 작업 제안>
```

또는 실패 시:

```
❌ run-2026-04-28T08-10-00 — 4/5 통과, send-question 실패
이벤트 로그: ...
스크린샷에서 보이는 문제: <분석 한 줄>
수정 제안: <어디를 어떻게 고칠지>
```

## 관련 스킬과의 관계

- **`desktop-app-verify`**: WSL 단독 단위/계약/Playwright web-mode 검증. 빠르고 (5초) 매 코드 변경마다. **첫째 게이트**.
- **`desktop-app-autotest`** (이 스킬): 사용자 PC 실제 GUI 까지 검증. 자동 업데이트 사이클 1회분 (수십 초 ~ 1분). **둘째 게이트, 시각/통합 회귀용**.

대부분의 변경은 desktop-app-verify 만으로 충분. CSS / layout / 자동 업데이트 / 토스트 / 모달 / IPC ↔ UI 흐름 변경 시 desktop-app-autotest 도 추가.

---

## MCP 직접 조작 (klaud_* tools) — 가장 빠른 ad-hoc 검증 (2026-04-28+)

`@modelcontextprotocol/sdk` 기반 MCP 서버 추가됨. 사용자가 Klaud 켜둔 상태에서 Claude Code 가 MCP tool 로 직접 Klaud 를 조작할 수 있다 — release 사이클 안 거치고 즉시.

### 셋업 (사용자 1회)

`~/.claude/.mcp.json` 또는 글로벌 `~/.claude/settings.json` 의 `mcpServers` 에 추가:

```json
{
  "mcpServers": {
    "klaud": {
      "command": "node",
      "args": ["/home/jacob/repos/proj-k/packages/desktop-app/scripts/klaud-mcp-server.mjs"]
    }
  }
}
```

Klaud ⚙ 설정에서 `MCP Bridge URL = ws://localhost:8769` 입력 + 저장. 부팅 시 자동 connect.

### 가용 tools

| 도구 | 용도 |
|------|------|
| `klaud_health` | Klaud 가 WS 로 살아있는지 + 사이드카 상태. 호출 전 가벼운 체크 |
| `klaud_screenshot` | 현재 메인 윈도우 PNG. 시각 회귀 검증 |
| `klaud_state` | 트리/채팅/검색 결과/사이드카/업데이터 상태를 구조화된 JSON 으로 |
| `klaud_send_cmd` | open-settings / close-modal / type-and-send / click-update-indicator / assert-tree-non-empty / wait |
| `klaud_get_logs` | main + sidecar console 로그 last N |

### 언제 MCP 를 쓰나 (vs collector self-test)

| 상황 | 권장 도구 |
|------|----------|
| 사용자에게 "사이클 한 번" 자동 검증 보여주기 | self-test (정해진 시나리오, 결과는 collector 로) |
| 회귀 가설 떠올라 즉시 확인 | **MCP** (release 안 거치고 바로 클릭/캡처) |
| LLM 이 동적으로 다음 액션 결정 (예: "이 버튼 클릭 후 답변에 X 가 보이면 다음 단계, 아니면 다른 가설") | **MCP** (Klaud 와 양방향) |
| 자동 업데이트 + NSIS 설치 + 첫부팅 흐름 검증 | self-test (release 사이클 통째로 검증해야 의미) |
| Windows 환경 의존 회귀 (UNC 경로, DPAPI 등) | self-test (사용자 진짜 환경) |
| 단순 UI 회귀 (CSS, 컴포넌트 표시) | **MCP** 또는 desktop-app-verify Playwright web-mode |

**의사결정 흐름**: 단위 테스트 (5초) → MCP 직접 조작 (수 초) → self-test 사이클 (~수십 초) → 사용자 보고. MCP 가 가장 짧은 피드백 루프.

### Gotcha

- Klaud 가 꺼져있으면 모든 MCP tool 이 `Klaud disconnected` 에러. 사용자에게 앱 켜기 요청.
- 한 번에 하나의 Klaud 만 connect. 다중 윈도우는 미지원.
- `klaud_eval` (임의 JS 실행) 은 stage 1 에 없음. 추후 보안 고려 후 추가.
- 자동 사이클(self-test) 은 collector 가 깐 시나리오만 자동으로 도는 반면, MCP 는 Claude 가 명령을 직접 보내야 하는 도구. 둘이 보완.
