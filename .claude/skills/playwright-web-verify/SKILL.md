---
name: playwright-web-verify
description: Headless Playwright verification for Project K Chrome extension and FastAPI backend changes. Use whenever you modify the Chrome extension (packages/chrome-extension/), FastAPI routes (packages/qna-poc/src/api.py), or Streamlit app (packages/qna-poc/src/streamlit_app.py) and need to verify the live behavior BEFORE reporting the fix as complete — capture console errors, network failures, SSE stream events, and visual screenshots. Triggers on any task involving: Chrome extension sidebar/content/background changes, Confluence page interactions (review/edit-suggestion/apply), SSE streaming verification, backend API behavior, review card rendering, or when the user reports issues ("안 되네", "에러난다", "404", "응답이 이상해", "수정안 실패", "미리보기 안 보여"). E2E tests live in packages/chrome-extension/tests/.
user-invocable: false
allowed-tools:
  - Bash
  - Read
  - Write
  - Edit
---

# Playwright Web Verification (Project K)

## When to run

Project K의 다음 요소를 변경한 후에는 반드시 Playwright 또는 API-기반 검증을 돌리고 나서야 "완료"라고 보고한다:

1. **Chrome extension 변경**: `packages/chrome-extension/` 하위
   - `background/background.js` — 서비스 워커, LLM 호출, Confluence REST
   - `content/content.js` — DOM 조작, 페이지 추출, 인라인 프리뷰
   - `sidebar/sidebar.js` + `sidebar/sidebar.html` + `sidebar/sidebar.css` — UI
   - `lib/api-client.js`, `lib/storage.js`, `lib/confluence-api.js`

2. **백엔드 변경**: `packages/qna-poc/src/`
   - `api.py` — FastAPI 엔드포인트 (`/ask`, `/review`, `/review_stream`)
   - `agent.py` — 리뷰/QnA 파이프라인
   - `generator.py` — LLM 게이트웨이 (Bedrock + Streaming)

3. **사용자가 UI 이슈를 보고할 때**:
   - "안 되네", "에러난다", "404", "응답이 이상해"
   - "수정안 실패", "미리보기 안 보여", "리뷰가 멈췄어"
   - "셀이 합쳐졌어", "테이블 깨짐"

**curl만으로는 부족하다**. SSE 이벤트 순서, 브라우저 JS 런타임 에러, DOM 주입 타이밍, 서비스 워커 idle timeout 등은 실제 브라우저로만 잡을 수 있다.

## Environment

- Playwright (Python) 설치 상태:
  ```bash
  pip3 list 2>/dev/null | grep -iE "playwright|requests|beautifulsoup"
  ```
  → `playwright 1.58.0`, `requests 2.33.1`, `beautifulsoup4 4.14.3`
- Chromium: `playwright install chromium` 이미 실행됨
- 실행: `python3` (Ubuntu/WSL에서 `python`은 없음 — `python3` 사용 필수)
- 기존 E2E 테스트: [packages/chrome-extension/tests/](packages/chrome-extension/tests/)
  - `e2e_review.py` — 리뷰 + Confluence 댓글
  - `e2e_edit_suggestion.py` — 테이블 셀 수정안 검증

## Critical gotcha: Chrome MV3 Service Worker

Chrome Manifest V3의 서비스 워커는 **30초 idle 후 죽는다**. SSE 같은 장시간 연결은 서비스 워커가 아닌 **sidebar iframe에서 직접 fetch**해야 한다. 이는 `background.js` handleReview의 구조적 제약.

## Critical gotcha: Headless Extension Loading

Playwright headless 모드에서 Chrome 확장은 **로드되지 않거나 content script가 주입되지 않을 수 있다**. `e2e_review.py`의 패턴:

```python
page.wait_for_timeout(3000)
if page.locator("#pk-sidebar-toggle").count() == 0:
    log("확장 content script 미로드 — API 테스트로 전환")
    context.close()
    return run_api_test()  # REST API + Bedrock 직접 호출로 fallback
```

**원칙**: 확장 로드에 실패하면 API fallback으로 시나리오를 검증한다. 둘 중 하나는 꼭 돌아가야 함.

## Critical gotcha: Confluence SSO

Confluence는 SSO 리다이렉트(`id.atlassian.com`)가 걸릴 수 있다. Basic Auth 쿠키로 우회하거나 REST API 기반 테스트로 전환한다.

```python
import base64
auth_b64 = base64.b64encode(f"{EMAIL}:{API_TOKEN}".encode()).decode()
page.set_extra_http_headers({"Authorization": f"Basic {auth_b64}"})
```

## Standard verification flows

### Flow A: Chrome extension diagnosis (`/tmp/diag_extension.py`)

확장 동작 확인 — 페이지 열기 → 사이드바 로드 → 버튼 클릭 → 로그/에러 수집.

```python
from playwright.sync_api import sync_playwright
from pathlib import Path

EXTENSION_DIR = "/home/jacob/repos/proj-k/packages/chrome-extension"
URL = "https://bighitcorp.atlassian.net/wiki/spaces/PKTEST/pages/5760320533/2"

def run():
    with sync_playwright() as p:
        ctx = p.chromium.launch_persistent_context(
            user_data_dir="/tmp/pw-chrome-profile",
            headless=False,  # 확장은 headed가 안정적
            args=[
                f"--disable-extensions-except={EXTENSION_DIR}",
                f"--load-extension={EXTENSION_DIR}",
                "--no-first-run",
                "--disable-blink-features=AutomationControlled",
            ],
            viewport={"width": 1400, "height": 900},
        )
        page = ctx.pages[0] if ctx.pages else ctx.new_page()

        errors, logs = [], []
        page.on("pageerror", lambda e: errors.append(f"{e.message}"))
        page.on("console", lambda msg: logs.append(f"[{msg.type}] {msg.text}"))

        page.goto(URL, wait_until="domcontentloaded")
        page.wait_for_timeout(3000)

        print("── Sidebar ──", page.locator("#pk-sidebar-toggle").count())
        print("── Errors ──")
        for e in errors: print(" ", e)
        print("── Console (last 20) ──")
        for l in logs[-20:]: print(" ", l)

        page.screenshot(path="/tmp/diag_ext.png", full_page=False)
        ctx.close()

run()
```

### Flow B: Backend API verification

백엔드 변경 시 REST API로 직접 검증 — SSE 이벤트 순서 확인에 특히 유용.

```python
import requests, json, time

BACKEND = "https://cp.tech2.hybe.im/proj-k/api"

t0 = time.time()
resp = requests.post(f"{BACKEND}/review_stream",
    json={"title": "테스트", "text": "문서 내용...", "model": "claude-opus-4-6"},
    stream=True, timeout=600)

events = []
for line in resp.iter_lines(decode_unicode=True):
    if not line: continue
    try:
        ev = json.loads(line)
        events.append(ev["type"])
        if ev["type"] == "status":
            print(f"  [{time.time()-t0:.1f}s] {ev['message']}")
        elif ev["type"] == "result":
            print(f"  ✅ 결과 수신 ({time.time()-t0:.1f}s)")
            break
        elif ev["type"] == "error":
            print(f"  ❌ {ev['message']}"); break
    except json.JSONDecodeError: pass

assert "status" in events, "status 이벤트 누락"
assert "result" in events, "result 이벤트 누락"
```

### Flow C: Existing E2E test (review + comment)

```bash
cd /home/jacob/repos/proj-k/packages/chrome-extension
python3 tests/e2e_review.py            # headless
python3 tests/e2e_review.py --headed   # 브라우저 창 보기
```

### Flow D: Edit suggestion E2E (table cell regression guard)

```bash
python3 tests/e2e_edit_suggestion.py
```
테이블 셀 병합 버그가 재발하지 않는지 확인. 검증 지표:
- **셀 병합 건수 0**: LLM이 여러 셀을 합쳐서 before로 생성하지 않음
- **파이프 포함 0**: `" | "` 구분자가 before에 들어있지 않음
- **HTML 적용률 ≥ 4/5**: 생성된 before가 Confluence storage HTML에서 매칭

## Verification checklist (after ANY extension/backend change)

최소 확인 항목:
1. **No pageerror** — 브라우저 콘솔에 빨간 에러 없음
2. **확장 로드 성공** — `#pk-sidebar-toggle` 존재
3. **메시지 릴레이 동작** — background ↔ content ↔ sidebar 메시지 통과
4. **SSE 이벤트 순서** — status → token/partial → result (error는 즉시 중단)
5. **DOM 인젝션** — 인라인 프리뷰 위젯(`.pk-inline-diff`) 정상 삽입
6. **스크린샷** — `/tmp/*.png` 저장 후 `Read` 툴로 시각 확인

실패 시 non-zero exit로 종료하여 스크립트 워크플로우에서 즉시 드러내기.

## Project K 특화 검증 포인트

### a) Streaming buffer & TTFT
`call_bedrock_stream()`은 Bedrock EventStream 이진 프로토콜을 파싱한다. 변경 시 확인:
- 첫 토큰 도착 시간(TTFT) < 10초
- `__STREAM_TOKEN__` 콜백이 꾸준히 호출
- 50자 버퍼 플러시가 지나치게 지연되지 않음

### b) Progressive JSON parser
`_parsePartialReviewJSON()`은 불완전한 JSON에서 완결된 항목만 추출한다. 리뷰 스키마(issues/verifications/suggestions/qa_checklist/cross_refs) 변경 시 필드 매칭 재확인.

### c) GameData tool calling
ContentSetting 키 이름 부분 매칭(앞 15자)이 깨지면 `HudHpPotionDefaultCondition` 같은 긴 키가 검색 실패. 백엔드 테스트로 확인:
```bash
python3 packages/qna-poc/src/agent.py --debug --question "HP 물약 쿨타임은?"
```

### d) Service worker 30s timeout
SSE는 sidebar iframe에서 fetch. background에서 fetch하면 긴 리뷰(100초+) 중 워커가 죽음.

### e) Table cell separator (현재 이슈)
`getTableAwareText()`가 테이블을 `| col1 | col2 |` 마크다운으로 변환. 회귀 방지:
```bash
python3 packages/chrome-extension/tests/e2e_edit_suggestion.py
```

### f) Confluence storage HTML apply
`handleApplyEdits`는 `body.replace(before, after)` 단순 문자열 치환. 태그가 섞인 텍스트는 매칭 실패 → 적용률 저하는 알려진 한계.

## Reverse proxy gotcha

백엔드는 nginx `location /proj-k/api/ { proxy_pass http://127.0.0.1:PORT/; }` 뒤에서 서빙된다. 
확장에서 fetch URL은 반드시 **`backendUrl` 전체 경로**(`https://cp.tech2.hybe.im/proj-k/api/...`) 사용. 상대 경로(`/api/...`)는 확장 컨텍스트에서 작동하지 않음.

## Key URLs

- Confluence 테스트 페이지: `https://bighitcorp.atlassian.net/wiki/spaces/PKTEST/pages/5760320533/2`
- 백엔드 API: `https://cp.tech2.hybe.im/proj-k/api`
- Confluence REST: `https://bighitcorp.atlassian.net/wiki/rest/api/content/{pageId}`

## Verification workflow (표준 루틴)

1. **Edit** Chrome 확장 또는 백엔드 코드
2. **백엔드 변경 시**: 서버 재배포 확인 (`curl https://cp.tech2.hybe.im/proj-k/api/health`)
3. **확장 변경 시**: 사용자에게 `chrome://extensions` 리로드 안내 (또는 headed Playwright로 자동 로드)
4. **E2E 실행**: `python3 tests/e2e_review.py` 또는 `e2e_edit_suggestion.py`
5. **스크린샷 확인**: `Read /tmp/e2e_*.png`
6. **실패 시**: pageerror/console log 분석 → 수정 → 2로 루프
7. **통과 시**: 사용자에게 URL 또는 테스트 로그 제시 + "검증 완료" 보고

**완료 보고 직전 필수**: 실제 테스트 로그의 마지막 N줄을 사용자에게 제시. "돌렸다고 했지만 안 돌아간" 사례를 방지.

## Don't

- ❌ curl 만으로 "확장 동작 확인 완료" 보고 (JS runtime 에러 못 잡음)
- ❌ headless에서 확장이 안 뜨면 "실패"로 끝내기 (→ API fallback 시도)
- ❌ 서비스 워커 살려두기 위해 `chrome.alarms` 해킹 (구조적 해결: sidebar에서 fetch)
- ❌ Playwright 프로필(`/tmp/pw-chrome-profile`)을 repo에 커밋
- ❌ 테스트 결과 JSON(`/tmp/e2e_*.json`)을 커밋

## Reference

- E2E 테스트: [packages/chrome-extension/tests/e2e_review.py](packages/chrome-extension/tests/e2e_review.py), [e2e_edit_suggestion.py](packages/chrome-extension/tests/e2e_edit_suggestion.py)
- 스크린샷: `/tmp/e2e_*.png`
- 결과 JSON: `/tmp/e2e_*_result.json`
