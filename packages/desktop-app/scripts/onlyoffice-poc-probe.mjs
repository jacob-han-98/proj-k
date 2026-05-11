import { chromium } from "playwright";

const URL = process.env.POC_URL || "http://172.20.105.147:9000/";
const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
const page = await ctx.newPage();
await page.goto(URL, { waitUntil: "domcontentloaded" });

let frame = null;
for (let i = 0; i < 60 && !frame; i++) {
  for (const f of page.frames()) {
    if (f.url().includes(":8080") && f.url().includes("spreadsheet")) {
      frame = f;
      break;
    }
  }
  if (!frame) await page.waitForTimeout(500);
}
await frame.waitForSelector("#ws-canvas-graphic", { timeout: 60000 });
await page.waitForTimeout(5000);

// Dump candidate selectors
const probe = await frame.evaluate(() => {
  const out = {};
  const counts = {};
  for (const sel of [
    "#status_bar",
    "#statusBar",
    "#status-bar",
    ".status-bar",
    "#sheet-list",
    ".sheet-list",
    "[id*='tab']",
    "[class*='tab']",
    "[class*='sheet']",
  ]) {
    const els = document.querySelectorAll(sel);
    counts[sel] = els.length;
  }
  // Find element near bottom containing the known sheet name "변신"
  const all = document.querySelectorAll("*");
  const candidates = [];
  for (const el of all) {
    const txt = (el.innerText || "").trim();
    if (txt === "변신" || txt === "히스토리" || txt === "스킬") {
      const r = el.getBoundingClientRect();
      candidates.push({
        tag: el.tagName,
        id: el.id,
        cls: el.className?.toString?.() || "",
        text: txt,
        rect: { x: r.x, y: r.y, w: r.width, h: r.height },
        parentTag: el.parentElement?.tagName,
        parentId: el.parentElement?.id,
        parentCls: el.parentElement?.className?.toString?.() || "",
      });
    }
  }
  return { counts, candidates };
});
console.log(JSON.stringify(probe, null, 2));

await browser.close();
