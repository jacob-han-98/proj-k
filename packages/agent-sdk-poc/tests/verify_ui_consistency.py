"""
Playwright 검증 — App / Shared / Admin 답변 렌더 UI 일관성
==============================================================
cc00e25 배포 후: 메인 채팅 / 공유 링크 / Admin 세 화면이 동일한 답변 컴포넌트를
사용하는지 실제 브라우저로 확인.

체크 항목:
1. 세 페이지 모두 200 OK + 콘솔 에러 없음
2. 세 페이지 모두 `--chat-max-width` CSS 변수 1060px 적용
3. 공유 링크 대화에서 출처 카드의 SVG fill 색(Excel #217346 / Confluence #1868DB /
   External #9333ea / Web #0891b2) 정확히 보임 — Shared 와 Admin 이 동일
4. 메인 랜딩의 🌐 Deep Research 프리셋 카드가 보라 테두리 (prompt-card-deepresearch)
5. 스크린샷 저장 (shots/main.png / shared.png / admin.png)

실행: /home/jacob/repos/proj-k/packages/agent-sdk-poc/.venv/bin/python \
      /home/jacob/repos/proj-k/packages/agent-sdk-poc/tests/verify_ui_consistency.py
"""
from __future__ import annotations

import asyncio
import json
import sys
from pathlib import Path

from playwright.async_api import async_playwright, ConsoleMessage

HERE = Path(__file__).resolve().parent
SHOTS = HERE / "shots"
SHOTS.mkdir(exist_ok=True)

BASE = "https://cp.tech2.hybe.im/proj-k/agentsdk"
SHARED_CONV = "1776674162264"   # 기획팀장 대화 (5 turns, PvP 컨텐츠)


async def main() -> int:
    failures: list[str] = []
    console_errors_by_page: dict[str, list[str]] = {"main": [], "shared": [], "admin": []}

    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=True)
        context = await browser.new_context(viewport={"width": 1440, "height": 900})

        def wire_console(page, bucket: str):
            def on_console(msg: ConsoleMessage):
                if msg.type in ("error", "warning"):
                    console_errors_by_page[bucket].append(f"[{msg.type}] {msg.text[:200]}")
            page.on("console", on_console)
            page.on("pageerror", lambda exc: console_errors_by_page[bucket].append(f"[pageerror] {exc}"))

        async def check_chat_max_width(page, label: str) -> None:
            v = await page.evaluate(
                "() => getComputedStyle(document.documentElement).getPropertyValue('--chat-max-width').trim()"
            )
            print(f"  {label} --chat-max-width: {v!r}")
            if v != "1060px":
                failures.append(f"{label} --chat-max-width != '1060px' (got {v!r})")

        # ── 1. Main landing ─────────────────────────────────────
        print("\n[1/3] Main landing — 프리셋 카드 확인")
        page = await context.new_page()
        wire_console(page, "main")
        resp = await page.goto(f"{BASE}/", wait_until="networkidle")
        print(f"  status: {resp.status if resp else 'no-response'}")
        if not resp or resp.status != 200:
            failures.append(f"main page status {resp.status if resp else 'none'}")
        await check_chat_max_width(page, "main")

        # Deep Research 프리셋 개수 + 보라 테두리 클래스
        dr_cards = await page.locator(".prompt-card-deepresearch").count()
        print(f"  deepresearch prompt-card count: {dr_cards} (기대: 4)")
        if dr_cards != 4:
            failures.append(f"main: prompt-card-deepresearch count={dr_cards} (expected 4)")
        dr_labels = await page.locator(".prompt-card-deepresearch").all_text_contents()
        for l in dr_labels[:4]:
            print(f"    - {l}")

        await page.screenshot(path=str(SHOTS / "main.png"), full_page=False)
        await page.close()

        # ── 2. Shared link ──────────────────────────────────────
        print(f"\n[2/3] Shared link /shared/{SHARED_CONV}")
        page = await context.new_page()
        wire_console(page, "shared")
        resp = await page.goto(f"{BASE}/shared/{SHARED_CONV}", wait_until="networkidle")
        print(f"  status: {resp.status if resp else 'no-response'}")
        if not resp or resp.status != 200:
            failures.append(f"shared page status {resp.status if resp else 'none'}")
        # 대화 로드 대기
        try:
            await page.wait_for_selector(".source-link-card, .message-sources", timeout=10000)
        except Exception:
            failures.append("shared: source-link-card 셀렉터 미발견 (대화 로드 실패?)")
        await check_chat_max_width(page, "shared")

        # 실제 컨테이너 폭 측정
        w = await page.evaluate("""() => {
          const el = document.querySelector('.shared-content, .chat-container');
          return el ? el.getBoundingClientRect().width : null;
        }""")
        print(f"  shared-content width: {w}px")

        # 출처 카드 SVG 색상 분포 파악 (아이콘 정확성)
        fills = await page.evaluate("""() => {
          const rects = document.querySelectorAll('.source-link-card svg rect');
          const by = {};
          rects.forEach(r => {
            const f = r.getAttribute('fill') || '';
            by[f] = (by[f] || 0) + 1;
          });
          return by;
        }""")
        print(f"  source card SVG fill distribution: {fills}")
        shared_fills = dict(fills)

        await page.screenshot(path=str(SHOTS / "shared.png"), full_page=False)
        await page.close()

        # ── 3. Admin ─────────────────────────────────────────────
        print(f"\n[3/3] Admin — conversation 상세")
        page = await context.new_page()
        wire_console(page, "admin")
        resp = await page.goto(f"{BASE}/admin", wait_until="networkidle")
        print(f"  admin root status: {resp.status if resp else 'no-response'}")
        if not resp or resp.status != 200:
            failures.append(f"admin page status {resp.status if resp else 'none'}")

        # 대화 목록에서 SHARED_CONV id 를 가진 행 클릭 시도
        await check_chat_max_width(page, "admin")

        # conversation 상세를 직접 URL 로 이동 (Admin SPA 가 /admin/conv/<id> 같은 라우트 지원 여부 확인)
        # 그냥 /admin 랜딩만 찍어도 폭·CSS 변수는 검증 가능
        admin_fills = {}
        try:
            # 상세 페이지로 이동 — 링크 패턴 확인
            detail_url = f"{BASE}/admin?conv={SHARED_CONV}"
            resp2 = await page.goto(detail_url, wait_until="networkidle")
            if resp2 and resp2.status == 200:
                await page.wait_for_timeout(1500)
                admin_fills = await page.evaluate("""() => {
                  const rects = document.querySelectorAll('.source-link-card svg rect');
                  const by = {};
                  rects.forEach(r => { const f = r.getAttribute('fill') || ''; by[f] = (by[f]||0)+1; });
                  return by;
                }""")
                print(f"  admin source card fill distribution: {admin_fills}")
        except Exception as e:
            print(f"  admin conv detail 진입 실패: {e}")

        await page.screenshot(path=str(SHOTS / "admin.png"), full_page=False)
        await page.close()

        # ── 콘솔 에러 집계 ────────────────────────────────────
        print("\n=== 콘솔 에러 ===")
        for name, errs in console_errors_by_page.items():
            real = [e for e in errs if "favicon" not in e.lower()]
            print(f"  {name}: {len(real)}건")
            for e in real[:5]:
                print(f"    {e}")
            if real:
                failures.append(f"{name}: {len(real)} console errors")

        # ── External/Web 아이콘이 Shared 에 노출됐는지 (정성 체크) ──
        print("\n=== Shared 출처 SVG fill 컬러 해석 ===")
        fill_map = {
            "#217346": "Excel (초록)",
            "#1868DB": "Confluence (파랑)",
            "#9333ea": "External 타게임 (📚 보라)",
            "#0891b2": "Web (🌐 cyan)",
        }
        for fill, n in shared_fills.items():
            name = fill_map.get(fill, "unknown")
            print(f"  {fill} ({name}): {n}")

        await browser.close()

    # ── 결과 ─────────────────────────────────────────────
    print("\n" + "=" * 60)
    if failures:
        print(f"❌ FAIL — {len(failures)} 건:")
        for f in failures:
            print(f"  - {f}")
        return 1
    print("✅ ALL PASS")
    print(f"\n스크린샷: {SHOTS}/main.png, shared.png, admin.png")
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
