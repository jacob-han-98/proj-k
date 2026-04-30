"""
Playwright — tool-summary overflow 수정 검증.
공유 링크의 진행 타임라인을 펼친 뒤 .tool-entry summary 가 부모 (.message) 박스를
초과하지 않는지 모든 row 폭을 측정한다.
"""
from __future__ import annotations
import asyncio, sys
from pathlib import Path
from playwright.async_api import async_playwright

HERE = Path(__file__).resolve().parent
SHOTS = HERE / "shots"
SHOTS.mkdir(exist_ok=True)
URL = "https://cp.tech2.hybe.im/proj-k/agentsdk/shared/1776674162264"


async def main() -> int:
    failures: list[str] = []
    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=True)
        ctx = await browser.new_context(viewport={"width": 1440, "height": 900})
        page = await ctx.new_page()

        # 캐시 무력화 — 새 CSS 강제 로드
        await page.set_extra_http_headers({"Cache-Control": "no-cache"})
        resp = await page.goto(URL, wait_until="networkidle")
        print(f"status: {resp.status if resp else 'none'}")

        # 모든 .progress-panel 펼치기
        await page.evaluate("""
          () => document.querySelectorAll('details.progress-panel').forEach(d => d.open = true)
        """)
        # tool-entry 도 펼쳐서 tool-input(JSON) 까지 보이게
        await page.evaluate("""
          () => document.querySelectorAll('details.tool-entry').forEach(d => d.open = true)
        """)
        await page.wait_for_timeout(500)

        # 측정 — 각 .tool-entry summary 의 right 좌표가 부모 .message right 좌표를 초과하나
        report = await page.evaluate("""() => {
          const results = [];
          document.querySelectorAll('.message.assistant').forEach((msg, mi) => {
            const mRect = msg.getBoundingClientRect();
            msg.querySelectorAll('.tool-entry > summary').forEach((s, si) => {
              const sRect = s.getBoundingClientRect();
              const summaryEl = s.querySelector('.tool-summary');
              const summaryText = summaryEl ? summaryEl.textContent.slice(0, 80) : '';
              const overflowRight = sRect.right - mRect.right;  // > 0 이면 overflow
              results.push({
                msg_idx: mi,
                tool_idx: si,
                msg_right: Math.round(mRect.right),
                msg_width: Math.round(mRect.width),
                summary_right: Math.round(sRect.right),
                summary_width: Math.round(sRect.width),
                overflow_px: Math.round(overflowRight),
                summary_preview: summaryText,
              });
            });
          });
          return results;
        }""")

        print(f"\n검사한 tool-entry: {len(report)}개")
        violations = [r for r in report if r["overflow_px"] > 1]
        if violations:
            failures.append(f"{len(violations)} tool-entry 가 부모 .message 폭 초과")
            print("\n❌ overflow violations (px = summary right - message right):")
            for v in violations[:10]:
                print(f"  msg{v['msg_idx']} tool{v['tool_idx']}: +{v['overflow_px']}px"
                      f"  msg.right={v['msg_right']} summary.right={v['summary_right']}")
                print(f"    summary: {v['summary_preview']!r}")
        else:
            print("\n✅ 모든 tool-entry 가 .message 박스 안에 포함")
            sample = sorted(report, key=lambda r: -r["summary_width"])[:5]
            print("\n가장 긴 5개 (참고):")
            for r in sample:
                print(f"  +{r['overflow_px']}px  width={r['summary_width']}  preview: {r['summary_preview']!r}")

        # 폭 변수 + .shared-content 폭 재확인
        cmw = await page.evaluate("() => getComputedStyle(document.documentElement).getPropertyValue('--chat-max-width').trim()")
        sw = await page.evaluate("""() => {
          const el = document.querySelector('.shared-content');
          return el ? Math.round(el.getBoundingClientRect().width) : null;
        }""")
        print(f"\n--chat-max-width = {cmw}, .shared-content 실측 = {sw}px")
        if cmw != "1060px":
            failures.append(f"--chat-max-width != 1060px ({cmw})")
        if sw != 1060:
            failures.append(f".shared-content width != 1060 ({sw})")

        await page.screenshot(path=str(SHOTS / "shared_after_fix.png"), full_page=False)
        await browser.close()

    print("\n" + "=" * 60)
    if failures:
        print(f"❌ FAIL — {len(failures)} 건")
        for f in failures: print(f"  - {f}")
        return 1
    print("✅ ALL PASS")
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
