/**
 * OnlyOffice PoC verifier
 *
 * Opens the embed page, waits for the editor canvas, iterates all sheet tabs
 * and captures a screenshot of each. Cross-origin iframe access is handled
 * via Playwright's frame API.
 *
 * Env:
 *   POC_URL      embed page URL (default http://172.20.105.147:9000/)
 *   POC_SLUG     subfolder name under POC_OUT_DIR (default "default")
 *   POC_OUT_DIR  screenshots root (default ./screenshots)
 *   POC_OO_HOST  substring to identify OnlyOffice editor frame (default "8080")
 */
import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";

const URL = process.env.POC_URL || "http://172.20.105.147:9000/";
const SLUG = process.env.POC_SLUG || "default";
const OUT_DIR = path.resolve(process.env.POC_OUT_DIR || "./screenshots");
const OO_HOST = process.env.POC_OO_HOST || "8080";
const FILE_DIR = path.join(OUT_DIR, SLUG);
fs.mkdirSync(FILE_DIR, { recursive: true });

const log = (...a) => console.log(`[verify ${SLUG}]`, ...a);

const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
const page = await ctx.newPage();

const consoleMsgs = [];
const networkErrors = [];
page.on("console", (m) => consoleMsgs.push(`[${m.type()}] ${m.text()}`));
page.on("pageerror", (e) => consoleMsgs.push(`[pageerror] ${e.message}`));
page.on("requestfailed", (r) =>
  networkErrors.push(`${r.method()} ${r.url()} -> ${r.failure()?.errorText}`)
);

const tStart = Date.now();
log(`navigating to ${URL}`);
const resp = await page.goto(URL, { waitUntil: "domcontentloaded", timeout: 30000 });
log(`initial response ${resp?.status()}`);

await page.screenshot({ path: path.join(FILE_DIR, "00-initial.png") });

// Find OnlyOffice editor iframe (cross-origin, but Playwright frames work).
// OnlyOffice spreadsheet editor URL pattern: /sdkjs/cell/sdk-all-min.js (parent),
// the actual frame URL contains "sdkjs" or specific paths. Match by host + iframe count.
let editorFrame = null;
const tFrameWait = Date.now();
while (Date.now() - tFrameWait < 30000) {
  for (const f of page.frames()) {
    const u = f.url();
    if (u.includes(OO_HOST) && u !== URL && !u.includes("about:blank")) {
      editorFrame = f;
      break;
    }
  }
  if (editorFrame) break;
  await page.waitForTimeout(500);
}
if (!editorFrame) {
  log("ERROR: editor iframe never appeared");
  await page.screenshot({ path: path.join(FILE_DIR, "01-no-editor.png") });
  await browser.close();
  process.exit(2);
}
log(`editor frame found: ${editorFrame.url()}`);

// Wait for the spreadsheet canvas. OnlyOffice cell editor uses #ws-canvas-graphic.
let canvasReady = false;
const canvasSelectors = ["#ws-canvas-graphic", "#ws-canvas", "canvas#id_main", "canvas"];
for (const sel of canvasSelectors) {
  try {
    await editorFrame.waitForSelector(sel, { timeout: 60000, state: "attached" });
    log(`canvas ready: ${sel}`);
    canvasReady = true;
    break;
  } catch {
    log(`selector ${sel} not found within timeout, trying next`);
  }
}
if (!canvasReady) {
  const errBox = await editorFrame
    .locator(".asc-window.alert, .asc-window-alert, [class*='alert']")
    .first()
    .innerText()
    .catch(() => null);
  log(`ERROR: spreadsheet canvas never ready. err dialog: ${errBox || "(none)"}`);
  await page.screenshot({ path: path.join(FILE_DIR, "02-canvas-fail.png") });
  await browser.close();
  process.exit(3);
}

// Settle: wait for any load mask to disappear, then a fixed render delay
await editorFrame
  .locator(".asc-loadmask, .asc-window-loadmask, .loadmask")
  .first()
  .waitFor({ state: "hidden", timeout: 30000 })
  .catch(() => log("loadmask wait timed out (may not exist)"));
await page.waitForTimeout(3000);
await page.screenshot({ path: path.join(FILE_DIR, "03-loaded.png") });
log(`document loaded in ${((Date.now() - tStart) / 1000).toFixed(1)}s`);

// Probe sheet tabs — try a list of selectors until one yields >1 and <60 matches
let tabHandles = [];
let tabSelectorUsed = null;
const tabSelectors = [
  "#statusbar_bottom > li.list-item",
  "#statusbar_bottom li.list-item",
  ".nav-tabs.bottom > li.list-item",
];
for (const sel of tabSelectors) {
  const count = await editorFrame.locator(sel).count();
  if (count >= 1 && count < 60) {
    tabHandles = await editorFrame.locator(sel).all();
    tabSelectorUsed = sel;
    log(`tabs found via "${sel}": ${count}`);
    break;
  }
  log(`selector "${sel}" -> ${count} matches (skipped)`);
}

const sheets = [];
if (tabHandles.length === 0) {
  log("WARN: no sheet tabs found — only initial sheet captured");
} else {
  const tabNames = [];
  for (const h of tabHandles) {
    const txt = (await h.innerText().catch(() => "")).trim();
    tabNames.push(txt || `(tab${tabNames.length})`);
  }
  log(`sheet names (${tabNames.length}): ${JSON.stringify(tabNames)}`);

  for (let i = 0; i < tabHandles.length; i++) {
    const name = tabNames[i];
    const safe = name.replace(/[\\\/:*?"<>|]/g, "_").replace(/\s+/g, "_").slice(0, 40);
    const t0 = Date.now();
    try {
      await tabHandles[i].click({ timeout: 5000 });
    } catch (e) {
      log(`click failed for tab ${i} "${name}": ${e.message}`);
      sheets.push({ idx: i, name, status: "click_failed" });
      continue;
    }
    await page.waitForTimeout(1500);
    const fname = `sheet-${String(i).padStart(2, "0")}-${safe}.png`;
    await page.screenshot({ path: path.join(FILE_DIR, fname) });
    sheets.push({ idx: i, name, file: fname, ms: Date.now() - t0 });
    log(`  [${i}] ${name} -> ${fname} (${Date.now() - t0}ms)`);
  }
}

const report = {
  slug: SLUG,
  url: URL,
  outcome: canvasReady ? "rendered" : "failed",
  elapsedMs: Date.now() - tStart,
  tabSelectorUsed,
  tabsFound: tabHandles.length,
  sheets,
  consoleMsgs: consoleMsgs.slice(-30),
  networkErrors: networkErrors.slice(-15),
};
fs.writeFileSync(path.join(FILE_DIR, "report.json"), JSON.stringify(report, null, 2));
log(`done in ${((Date.now() - tStart) / 1000).toFixed(1)}s. tabs=${tabHandles.length} captures=${sheets.length}`);

await browser.close();
process.exit(0);
