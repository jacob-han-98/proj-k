"""E2E Test: Confluence 페이지 열기 → 리뷰해줘 → 결과 확인 → Confluence에 적용

실행: python tests/e2e_review.py [--headed]
"""
import sys
import time
import json
from pathlib import Path
from playwright.sync_api import sync_playwright, expect

# ── Config ──
CONFLUENCE_PAGE = "https://bighitcorp.atlassian.net/wiki/spaces/PKTEST/pages/5760320533/2"
CONFLUENCE_EMAIL = "jacob@hybecorp.com"
EXTENSION_DIR = str(Path(__file__).parent.parent.resolve())
HEADED = "--headed" in sys.argv
TIMEOUT = 300_000  # 5분 (리뷰 최대 소요 시간)


def log(msg: str):
    print(f"[{time.strftime('%H:%M:%S')}] {msg}")


def run_test():
    with sync_playwright() as p:
        # ── 1. Chrome + Extension 로드 ──
        log("Chrome 시작 (확장 로드)...")
        context = p.chromium.launch_persistent_context(
            user_data_dir="/tmp/pw-chrome-profile",
            headless=not HEADED,
            args=[
                f"--disable-extensions-except={EXTENSION_DIR}",
                f"--load-extension={EXTENSION_DIR}",
                "--no-first-run",
                "--disable-blink-features=AutomationControlled",
            ],
            viewport={"width": 1400, "height": 900},
            ignore_https_errors=True,
        )

        page = context.pages[0] if context.pages else context.new_page()

        # ── 2. Confluence 로그인 (API 토큰 기반 Basic Auth 쿠키 설정) ──
        log("Confluence 인증 쿠키 설정...")

        # config.js에서 토큰 읽기
        config_path = Path(EXTENSION_DIR) / "lib" / "config.js"
        config_text = config_path.read_text()
        import re as _re
        api_token_match = _re.search(r"confluenceApiToken:\s*['\"]([^'\"]+)['\"]", config_text)
        api_token = api_token_match.group(1) if api_token_match else ""

        # Basic auth로 REST API 호출하여 세션 쿠키 획득
        import base64
        auth_b64 = base64.b64encode(f"{CONFLUENCE_EMAIL}:{api_token}".encode()).decode()

        # 먼저 REST API로 인증 확인
        page.set_extra_http_headers({"Authorization": f"Basic {auth_b64}"})
        log(f"Confluence 페이지 접속: {CONFLUENCE_PAGE}")
        page.goto(CONFLUENCE_PAGE, wait_until="domcontentloaded", timeout=30000)

        # SSO 리다이렉트 감지
        if "id.atlassian.com" in page.url or "login" in page.url.lower():
            log("SSO 리다이렉트 — API 테스트로 전환")
            context.close()
            return run_api_test()

        # headless에서 확장 content script 미로드 시 API 폴백
        page.wait_for_timeout(3000)
        if page.locator("#pk-sidebar-toggle").count() == 0:
            log("확장 content script 미로드 — API 테스트로 전환")
            context.close()
            return run_api_test()

        log(f"페이지 로드 완료: {page.title()}")
        page.wait_for_timeout(3000)  # 확장 로드 대기

        # ── 3. 사이드바 확인 ──
        log("사이드바 토글 버튼 찾기...")
        toggle_btn = page.locator("#pk-sidebar-toggle")
        if toggle_btn.count() == 0:
            log("❌ 사이드바 토글 버튼을 찾을 수 없습니다. 확장이 로드되지 않았을 수 있습니다.")
            context.close()
            return False

        # 사이드바 열기
        if not page.locator("#pk-sidebar-wrapper").is_visible():
            log("사이드바 열기...")
            toggle_btn.click()
            page.wait_for_timeout(1000)

        # ── 4. 사이드바 iframe 접근 ──
        log("사이드바 iframe 접근...")
        sidebar_frame = page.frame_locator("#pk-sidebar-frame")

        # 페이지 인식 대기 (welcome-desc에 페이지 제목이 표시될 때까지)
        sidebar_frame.locator("#welcome-desc").wait_for(timeout=10000)
        welcome_text = sidebar_frame.locator("#welcome-desc").inner_text()
        log(f"사이드바 상태: {welcome_text}")

        # ── 5. "리뷰해줘" 프리셋 클릭 ──
        log("'리뷰해줘' 프리셋 클릭...")
        review_btn = sidebar_frame.locator('button.preset-btn', has_text="리뷰해줘").first
        review_btn.click()

        # ── 6. 리뷰 진행 상태 모니터링 ──
        log("리뷰 진행 중... (최대 5분)")
        start_time = time.time()

        # 진행 상태 메시지 감시
        last_status = ""
        while True:
            elapsed = time.time() - start_time
            if elapsed > TIMEOUT / 1000:
                log("❌ 타임아웃!")
                break

            # status-text 확인
            try:
                status = sidebar_frame.locator("#status-text").inner_text(timeout=1000)
                if status != last_status:
                    log(f"  상태: {status}")
                    last_status = status
            except:
                pass

            # 리뷰 완료 확인 — review-card가 나타나면 완료
            if sidebar_frame.locator(".review-card").count() > 0:
                log(f"✅ 리뷰 완료! ({elapsed:.1f}초)")
                break

            # 에러 확인
            error_msgs = sidebar_frame.locator(".system-msg")
            if error_msgs.count() > 0:
                last_error = error_msgs.last.inner_text()
                if "오류" in last_error or "error" in last_error.lower() or "timed out" in last_error.lower():
                    log(f"❌ 에러 발생: {last_error}")
                    break

            time.sleep(2)

        # ── 7. 리뷰 결과 확인 ──
        review_card = sidebar_frame.locator(".review-card")
        if review_card.count() == 0:
            log("❌ 리뷰 카드를 찾을 수 없습니다")
            context.close()
            return False

        # 점수 확인
        try:
            score = sidebar_frame.locator(".review-score-num").first.inner_text()
            log(f"  전체 평가: {score}")
        except:
            log("  점수 확인 실패")

        # 각 섹션 건수 확인
        for section_cls, label in [("warning", "보강 필요"), ("info", "검증 필요"), ("suggestion", "제안")]:
            section = sidebar_frame.locator(f".review-section.{section_cls}")
            if section.count() > 0:
                title = section.first.locator(".review-section-title").inner_text()
                log(f"  {title}")

        # QA 체크리스트 확인
        checklist = sidebar_frame.locator(".review-checklist-item")
        if checklist.count() > 0:
            log(f"  QA 체크리스트: {checklist.count()}건")

        # 가독성 점수 확인
        readability = sidebar_frame.locator(".review-section.readability")
        if readability.count() > 0:
            log(f"  문서 가독성 섹션 존재")

        # ── 8. "Confluence 댓글" 버튼 클릭 ──
        log("'Confluence 댓글' 버튼 클릭...")
        comment_btn = sidebar_frame.locator('button.btn-comment-review')
        if comment_btn.count() > 0:
            comment_btn.click()
            page.wait_for_timeout(5000)

            # 결과 확인
            log("댓글 등록 결과 확인...")
            page.wait_for_timeout(3000)

            # 시스템 메시지에서 결과 확인
            sys_msgs = sidebar_frame.locator(".system-msg")
            if sys_msgs.count() > 0:
                last_msg = sys_msgs.last.inner_text()
                log(f"  결과: {last_msg}")
                if "등록" in last_msg or "성공" in last_msg:
                    log("✅ Confluence 댓글 등록 성공!")
                else:
                    log(f"⚠️ 댓글 등록 결과 불명확: {last_msg}")
        else:
            log("⚠️ 'Confluence 댓글' 버튼을 찾을 수 없습니다")

        # ── 9. 스크린샷 저장 ──
        screenshot_path = "/tmp/e2e_review_result.png"
        page.screenshot(path=screenshot_path, full_page=False)
        log(f"스크린샷 저장: {screenshot_path}")

        # ── 정리 ──
        log("테스트 완료!")
        context.close()
        return True


def run_api_test():
    """브라우저 UI 없이 REST API로 전체 시나리오 테스트.

    1. Confluence REST API로 페이지 내용 가져오기
    2. 백엔드 /review_stream으로 리뷰 실행 (SSE 모니터링)
    3. 리뷰 결과 파싱 + 검증
    4. Confluence REST API로 댓글 등록
    """
    import requests
    from bs4 import BeautifulSoup

    config_path = Path(EXTENSION_DIR) / "lib" / "config.js"
    config_text = config_path.read_text()
    import re as _re
    api_token = _re.search(r"confluenceApiToken:\s*['\"]([^'\"]+)['\"]", config_text).group(1)
    backend_url = _re.search(r"backendUrl:\s*['\"]([^'\"]+)['\"]", config_text)
    backend_url = backend_url.group(1) if backend_url else "https://cp.tech2.hybe.im/proj-k/api"

    auth = (CONFLUENCE_EMAIL, api_token)
    base = "https://bighitcorp.atlassian.net"
    page_id = CONFLUENCE_PAGE.split("/pages/")[1].split("/")[0]

    # ── Step 1: 페이지 내용 가져오기 ──
    log(f"Step 1: Confluence 페이지 가져오기 (ID: {page_id})")
    resp = requests.get(f"{base}/wiki/rest/api/content/{page_id}?expand=body.storage,version", auth=auth)
    if not resp.ok:
        log(f"❌ 페이지 접근 실패: {resp.status_code}")
        return False

    page_data = resp.json()
    title = page_data["title"]
    html = page_data["body"]["storage"]["value"]
    version = page_data["version"]["number"]
    soup = BeautifulSoup(html, "html.parser")
    text = soup.get_text(separator="\n")
    log(f"  제목: {title}")
    log(f"  텍스트: {len(text)}자, 버전: v{version}")

    # ── Step 2: 백엔드 리뷰 (SSE 스트리밍) ──
    log(f"Step 2: 백엔드 리뷰 시작 ({backend_url}/review_stream)")
    t0 = time.time()

    review_resp = requests.post(
        f"{backend_url}/review_stream",
        json={"title": title, "text": text, "model": "claude-opus-4-6"},
        stream=True,
        timeout=600,
    )

    if not review_resp.ok:
        log(f"❌ 리뷰 API 실패: {review_resp.status_code}")
        return False

    review_result = None
    for line in review_resp.iter_lines(decode_unicode=True):
        if not line:
            continue
        try:
            event = json.loads(line)
            if event["type"] == "status":
                log(f"  {event['message']}")
            elif event["type"] == "result":
                review_result = event["data"]
            elif event["type"] == "error":
                log(f"  ❌ 에러: {event['message']}")
                return False
        except json.JSONDecodeError:
            pass

    elapsed = time.time() - t0
    if not review_result:
        log(f"❌ 리뷰 결과 없음 ({elapsed:.1f}s)")
        return False

    log(f"  ✅ 리뷰 완료 ({elapsed:.1f}s, {review_result.get('total_tokens', 0):,} 토큰)")

    # ── Step 3: 리뷰 결과 파싱 + 검증 ──
    log("Step 3: 리뷰 결과 검증")
    review_text = review_result.get("review", "")
    cleaned = _re.sub(r"```json\s*", "", review_text)
    cleaned = _re.sub(r"```\s*", "", cleaned).strip()

    try:
        match = _re.search(r"\{[\s\S]*\}", cleaned)
        review = json.loads(match.group(0)) if match else None
    except Exception as e:
        log(f"  ❌ JSON 파싱 실패: {e}")
        log(f"  Raw (처음 500자): {cleaned[:500]}")
        return False

    if not review:
        log("  ❌ 리뷰 JSON을 찾을 수 없음")
        return False

    score = review.get("score", "?")
    issues = review.get("issues", [])
    verifications = review.get("verifications", [])
    suggestions = review.get("suggestions", [])
    qa_checklist = review.get("qa_checklist", [])
    cross_refs = review.get("cross_refs", [])
    readability = review.get("readability", {})

    log(f"  전체 평가: {score}/100")
    log(f"  보강 필요: {len(issues)}건")
    log(f"  검증 필요: {len(verifications)}건")
    log(f"  제안: {len(suggestions)}건")
    log(f"  QA 체크리스트: {len(qa_checklist)}건")
    log(f"  관련 문서: {len(cross_refs)}건")
    log(f"  가독성: {readability.get('score', '?')}/100")

    # GameData 교차 검증 확인
    all_texts = " ".join(
        (item.get("text", "") if isinstance(item, dict) else item)
        for item in issues + verifications
    )
    has_gamedata_ref = any(keyword in all_texts for keyword in ["1000001", "1000002", "1000003", "1000", "ContentSetting 실제"])
    log(f"  GameData 실제 값 인용: {'✅' if has_gamedata_ref else '⚠️ 미인용'}")

    # ── Step 4: Confluence 댓글 등록 ──
    log("Step 4: Confluence 댓글 등록")

    comment_html = f'<h3>📋 AI 리뷰 (E2E Test) — {score}/100</h3>'
    comment_html += f'<p><strong>⚠️ 보강 필요 ({len(issues)}건) | 🔍 검증 필요 ({len(verifications)}건) | 💡 제안 ({len(suggestions)}건) | ✅ QA ({len(qa_checklist)}건)</strong></p>'

    if issues:
        comment_html += '<h4>⚠️ 보강 필요</h4><ul>'
        for item in issues[:5]:
            t = item.get("text", "") if isinstance(item, dict) else item
            p = item.get("perspective", "") if isinstance(item, dict) else ""
            comment_html += f'<li><strong>[{p}]</strong> {t[:200]}</li>'
        if len(issues) > 5:
            comment_html += f'<li><em>...외 {len(issues) - 5}건</em></li>'
        comment_html += '</ul>'

    comment_html += '<hr/><p><em>E2E Test by Playwright — Project K AI Assistant</em></p>'

    comment_resp = requests.post(
        f"{base}/wiki/rest/api/content",
        auth=auth,
        headers={"Content-Type": "application/json"},
        json={
            "type": "comment",
            "container": {"id": page_id, "type": "page", "status": "current"},
            "body": {"storage": {"value": comment_html, "representation": "storage"}},
        },
    )

    if comment_resp.ok:
        comment_id = comment_resp.json().get("id")
        log(f"  ✅ 댓글 등록 성공! (ID: {comment_id})")
    else:
        log(f"  ❌ 댓글 등록 실패: {comment_resp.status_code} {comment_resp.text[:200]}")
        return False

    # ── 결과 저장 ──
    result_path = "/tmp/e2e_review_result.json"
    with open(result_path, "w") as f:
        json.dump({
            "title": title,
            "score": score,
            "issues": len(issues),
            "verifications": len(verifications),
            "suggestions": len(suggestions),
            "qa_checklist": len(qa_checklist),
            "cross_refs": len(cross_refs),
            "readability_score": readability.get("score"),
            "gamedata_cited": has_gamedata_ref,
            "elapsed_seconds": round(elapsed, 1),
            "tokens": review_result.get("total_tokens", 0),
            "comment_id": comment_id if comment_resp.ok else None,
        }, f, ensure_ascii=False, indent=2)
    log(f"  결과 저장: {result_path}")

    log("")
    log("═══════════════════════════════════════")
    log(f"✅ E2E 테스트 전체 통과! ({elapsed:.1f}s)")
    log("═══════════════════════════════════════")
    return True


if __name__ == "__main__":
    success = run_test()
    sys.exit(0 if success else 1)
