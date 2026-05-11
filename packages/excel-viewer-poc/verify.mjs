import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";

const URL = process.env.POC_URL || "http://172.20.105.147:9000/";
const OUT_DIR = path.resolve(process.env.POC_OUT_DIR || "./screenshots");
fs.mkdirSync(OUT_DIR, { recursive: true });

const log = (...a) => console.log("[verify]", ...a);

const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
const page = await ctx.newPage();

const consoleMsgs = [];
const networkErrors = [];
const dialogs = [];

page.on("console", (m) => consoleMsgs.push(`[${m.type()}] ${m.text()}`));
page.on("pageerror", (e) => consoleMsgs.push(`[pageerror] ${e.message}`));
page.on("requestfailed", (r) =>
  networkErrors.push(`${r.method()} ${r.url()} -> ${r.failure()?.errorText}`)
);

// OnlyOffice shows error popups via standard browser dialogs sometimes,
// but mostly via internal HTML modals — those are caught via DOM scan below.
page.on("dialog", async (d) => {
  dialogs.push(`[dialog ${d.type()}] ${d.message()}`);
  await d.dismiss().catch(() => {});
});

log(`navigating to ${URL}`);
const t0 = Date.now();
const resp = await page.goto(URL, { waitUntil: "domcontentloaded", timeout: 30000 });
log(`initial response ${resp?.status()} (${Date.now() - t0}ms)`);

// Initial screenshot — soon after load
await page.screenshot({ path: path.join(OUT_DIR, "01-initial.png"), fullPage: false });
log(`saved 01-initial.png`);

// Poll for OnlyOffice editor iframe + the spreadsheet area or any error modal
const maxWaitMs = 90000;
const pollIntervalMs = 2000;
let lastState = "";
let outcome = "timeout";
let outcomeDetail = "";
const tStart = Date.now();

while (Date.now() - tStart < maxWaitMs) {
  const state = await page.evaluate(() => {
    const findings = {
      iframes: [],
      errorTexts: [],
      hasSpreadsheetArea: false,
    };
    for (const iframe of document.querySelectorAll("iframe")) {
      try {
        const doc = iframe.contentDocument;
        if (!doc) {
          findings.iframes.push({ src: iframe.src, accessible: false });
          continue;
        }
        // Look for OnlyOffice spreadsheet canvas / known classes
        const grid =
          doc.querySelector("#ws-canvas-graphic") ||
          doc.querySelector("#ws-canvas") ||
          doc.querySelector(".asc-window") ||
          doc.querySelector("canvas");
        const errorBox =
          doc.querySelector(".asc-window.alert") ||
          doc.querySelector(".asc-loadmask-error") ||
          doc.querySelector('[id*="alert"]');
        let errText = "";
        if (errorBox) {
          errText = (errorBox.innerText || "").trim().slice(0, 500);
        }
        // Scan for any dialog-like nodes with Korean error text
        for (const el of doc.querySelectorAll("div,span")) {
          const t = (el.innerText || "").trim();
          if (
            t &&
            (t.includes("다운로드") ||
              t.includes("오류") ||
              t.includes("Error") ||
              t.includes("error"))
          ) {
            if (t.length < 200) findings.errorTexts.push(t);
          }
        }
        findings.iframes.push({
          src: iframe.src,
          accessible: true,
          grid: !!grid,
          errBox: errText,
        });
        if (grid) findings.hasSpreadsheetArea = true;
      } catch (e) {
        findings.iframes.push({ src: iframe.src, accessible: false, err: String(e) });
      }
    }
    return findings;
  });

  const summary = JSON.stringify({
    iframes: state.iframes.length,
    grid: state.hasSpreadsheetArea,
    errs: [...new Set(state.errorTexts)].slice(0, 3),
  });
  if (summary !== lastState) {
    log(`t+${((Date.now() - tStart) / 1000).toFixed(1)}s ${summary}`);
    lastState = summary;
  }

  if (state.hasSpreadsheetArea) {
    outcome = "rendered";
    outcomeDetail = "spreadsheet canvas detected";
    break;
  }
  const errSet = [...new Set(state.errorTexts)];
  const downloadFail = errSet.find(
    (t) => t.includes("다운로드하지 못했습니다") || t.toLowerCase().includes("download")
  );
  if (downloadFail) {
    outcome = "download_error";
    outcomeDetail = downloadFail;
    break;
  }
  await page.waitForTimeout(pollIntervalMs);
}

await page.screenshot({ path: path.join(OUT_DIR, "02-final.png"), fullPage: false });
log(`saved 02-final.png`);

// Try to scroll inside the editor iframe to capture more if loaded
if (outcome === "rendered") {
  await page.waitForTimeout(2000);
  await page.screenshot({ path: path.join(OUT_DIR, "03-rendered.png"), fullPage: false });
  log(`saved 03-rendered.png`);
}

const report = {
  url: URL,
  outcome,
  outcomeDetail,
  elapsedMs: Date.now() - t0,
  consoleMsgs: consoleMsgs.slice(-50),
  networkErrors: networkErrors.slice(-30),
  dialogs,
};
fs.writeFileSync(path.join(OUT_DIR, "report.json"), JSON.stringify(report, null, 2));
log("=== REPORT ===");
log(JSON.stringify(report, null, 2));

await browser.close();
process.exit(outcome === "rendered" ? 0 : 1);
