/**
 * OnlyOffice PoC multi-file runner.
 *
 * For each xlsx in TEST_FILES:
 *   1. kill any running serve.py in WSL
 *   2. start serve.py for this file (detached background in WSL)
 *   3. wait for port 9000 + container can fetch sample
 *   4. run onlyoffice-poc-verify.mjs with appropriate slug
 * Aggregates results to screenshots/_summary.json.
 */
import { spawnSync, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const REPO_ROOT = "/mnt/e/repos/proj-k";
const SCREENSHOTS_DIR = "e:/repos/proj-k/packages/excel-viewer-poc/screenshots";
const SERVE_PY = `${REPO_ROOT}/packages/excel-viewer-poc/serve.py`;
const VERIFY_MJS = "scripts/onlyoffice-poc-verify.mjs";

const TEST_FILES = [
  { wsl: "/mnt/d/ProjectK/Design/7_System/PK_기본 전투 시스템.xlsx", slug: "01-basic-combat" },
  { wsl: "/mnt/d/ProjectK/Design/7_System/PK_변신 및 스킬 시스템.xlsx", slug: "02-byunshin-skill" },
  { wsl: "/mnt/d/ProjectK/Design/7_System/PK_HUD 시스템.xlsx", slug: "03-hud" },
  { wsl: "/mnt/d/ProjectK/Design/7_System/PK_로그인 플로우.xlsx", slug: "04-login-flow" },
];

const log = (...a) => console.log("[runner]", ...a);

function wsl(cmd, opts = {}) {
  const r = spawnSync("wsl", ["--", "bash", "-c", cmd], { encoding: "utf8", ...opts });
  return { code: r.status ?? -1, stdout: r.stdout || "", stderr: r.stderr || "" };
}

function killServePy() {
  execScript(`#!/bin/bash
pgrep -f 'serve.py' | xargs -r kill -9 2>/dev/null
# wait for port 9000 to be free
for i in $(seq 1 20); do
  if ! ss -tln | grep -q ':9000 '; then exit 0; fi
  sleep 0.3
done
echo "WARN: port 9000 still busy after kill"
exit 0
`);
}

function execScript(scriptBody) {
  // Write script to a Windows-side temp file, then exec via wsl from /mnt path.
  // Avoids Node.js Windows arg-quoting issues with redirection chars.
  const win = path.join(process.cwd(), ".tmp-poc-runner.sh");
  fs.writeFileSync(win, scriptBody.replace(/\r\n/g, "\n"), { encoding: "utf8" });
  // Translate windows path -> wsl /mnt path
  const drive = win[0].toLowerCase();
  const rest = win.slice(2).replace(/\\/g, "/");
  const wslPath = `/mnt/${drive}${rest}`;
  const r = spawnSync("wsl", ["--", "bash", wslPath], { encoding: "utf8" });
  return { code: r.status ?? -1, stdout: r.stdout || "", stderr: r.stderr || "" };
}

function startServePyAndWait(wslPath, timeoutMs = 30000) {
  const escaped = wslPath.replace(/'/g, "'\\''");
  const iters = Math.ceil(timeoutMs / 500);
  const script = `#!/bin/bash
set +e
cd /tmp
setsid nohup python3 ${SERVE_PY} '${escaped}' > /tmp/serve.log 2>&1 < /dev/null &
disown
for i in $(seq 1 ${iters}); do
  if ss -tln | grep -q ':9000 '; then echo READY; exit 0; fi
  sleep 0.5
done
echo TIMEOUT
tail -30 /tmp/serve.log
exit 1
`;
  const r = execScript(script);
  return { ok: r.stdout.includes("READY"), stdout: r.stdout, stderr: r.stderr };
}

function waitContainerCanFetch(timeoutMs = 15000) {
  const iters = Math.ceil(timeoutMs / 500);
  const script = `#!/bin/bash
for i in $(seq 1 ${iters}); do
  code=$(docker exec onlyoffice-ds-poc curl -fsS -o /dev/null -w '%{http_code}' http://host.docker.internal:9000/sample.xlsx 2>/dev/null)
  if [ "$code" = "200" ]; then echo OK; exit 0; fi
  sleep 0.5
done
echo TIMEOUT
exit 1
`;
  const r = execScript(script);
  return r.stdout.includes("OK");
}

function runVerify(slug) {
  const r = spawnSync("node", [VERIFY_MJS], {
    encoding: "utf8",
    cwd: process.cwd(),
    env: {
      ...process.env,
      POC_SLUG: slug,
      POC_OUT_DIR: SCREENSHOTS_DIR,
    },
  });
  return { code: r.status ?? -1, stdout: r.stdout || "", stderr: r.stderr || "" };
}

const summary = [];
for (const tf of TEST_FILES) {
  log(`=== ${tf.slug} : ${tf.wsl} ===`);
  killServePy();
  log(`starting serve.py...`);
  const startRes = startServePyAndWait(tf.wsl);
  if (!startRes.ok) {
    log(`FAIL: serve.py not ready in time`);
    log(`stdout: ${startRes.stdout.slice(0, 500)}`);
    log(`stderr: ${startRes.stderr.slice(0, 500)}`);
    summary.push({ slug: tf.slug, file: tf.wsl, status: "serve_not_ready" });
    continue;
  }
  log(`serve.py ready`);

  const reachable = waitContainerCanFetch();
  if (!reachable) {
    log(`FAIL: container cannot fetch from host.docker.internal:9000`);
    summary.push({ slug: tf.slug, file: tf.wsl, status: "container_unreachable" });
    continue;
  }
  log(`container can fetch`);

  // Wipe existing screenshots for this slug
  const slugDir = path.join(SCREENSHOTS_DIR, tf.slug);
  fs.rmSync(slugDir, { recursive: true, force: true });

  log(`running verify...`);
  const t0 = Date.now();
  const v = runVerify(tf.slug);
  const elapsed = Date.now() - t0;
  log(v.stdout.split("\n").slice(-12).join("\n"));
  if (v.stderr) log("STDERR:", v.stderr.slice(0, 500));

  let report = null;
  try {
    report = JSON.parse(fs.readFileSync(path.join(slugDir, "report.json"), "utf8"));
  } catch (e) {
    log(`no report.json: ${e.message}`);
  }
  summary.push({
    slug: tf.slug,
    file: tf.wsl,
    elapsedMs: elapsed,
    exitCode: v.code,
    outcome: report?.outcome || "unknown",
    tabsFound: report?.tabsFound ?? 0,
    sheetsCaptured: report?.sheets?.length ?? 0,
  });
}

killServePy();

const summaryPath = path.join(SCREENSHOTS_DIR, "_summary.json");
fs.writeFileSync(summaryPath, JSON.stringify(summary, null, 2));
log(`=== SUMMARY ===`);
log(JSON.stringify(summary, null, 2));
log(`written: ${summaryPath}`);
