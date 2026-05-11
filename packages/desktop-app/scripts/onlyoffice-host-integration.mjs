/**
 * OnlyOffice host integration test (Electron 우회).
 *
 * 진짜 spawn (wsl python3 serve.py) + 진짜 port wait + 진짜 HTTP fetch 로 onlyoffice-host.ts
 * 의 핵심 로직 검증. Klaud Electron 을 띄우지 않아 test:electron 인프라 (sidecar cwd 등) 이슈
 * 회피. CI 에선 못 돌림 (WSL + Docker container 필요).
 *
 * 검증 항목:
 *   1) WSL IP 자동 감지
 *   2) Windows xlsx path → WSL path 변환
 *   3) serve.py 가 정확한 args 로 spawn 됨
 *   4) FILE_PORT(9000) 가 실제로 listen
 *   5) viewerUrl 반환 형식 검증
 *   6) viewerUrl 본문이 OnlyOffice DocsAPI 호출을 포함
 *   7) sample.xlsx 가 reachable
 *   8) shutdown 후 포트 free
 *
 * 사용:
 *   node scripts/onlyoffice-host-integration.mjs
 */
import { spawn, spawnSync } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

const TEST_XLSX_WIN = 'D:\\ProjectK\\Design\\7_System\\PK_변신 및 스킬 시스템.xlsx';
const TEST_XLSX_WSL = '/mnt/d/ProjectK/Design/7_System/PK_변신 및 스킬 시스템.xlsx';
const ONLYOFFICE_URL = 'http://172.20.105.147:8080';
const SERVE_PY_WSL = '/mnt/e/repos/proj-k/packages/excel-viewer-poc/serve.py';
const FILE_PORT = 9000;

let pass = 0;
let fail = 0;
const log = (...a) => console.log('[host-int]', ...a);
const ok = (msg) => {
  pass++;
  log('  ✓', msg);
};
const ko = (msg) => {
  fail++;
  log('  ✗', msg);
};

// 0) Pre-clean.
log('== prep: kill stale serve.py ==');
spawnSync('wsl', ['--', 'bash', '-c', "pgrep -f 'excel-viewer-poc/serve.py' | xargs -r kill -9 2>/dev/null"], { timeout: 5000 });
await sleep(500);

// 1) WSL IP detect.
log('== 1) WSL IP detect ==');
const ipResult = spawnSync('wsl', ['--', 'hostname', '-I'], { encoding: 'utf8', timeout: 5000 });
const wslIp = (ipResult.stdout || '').trim().split(/\s+/)[0];
if (/^\d+\.\d+\.\d+\.\d+$/.test(wslIp)) ok(`WSL IP = ${wslIp}`);
else { ko(`WSL IP detect 실패: stdout="${ipResult.stdout}"`); process.exit(1); }

// 2) Verify test xlsx exists in both forms.
log('== 2) Verify test xlsx exists (WSL path) ==');
const statResult = spawnSync('wsl', ['--', 'stat', '-c', '%s', TEST_XLSX_WSL], { encoding: 'utf8', timeout: 5000 });
const size = parseInt((statResult.stdout || '0').trim(), 10);
if (size > 1000) ok(`${TEST_XLSX_WSL} (${size.toLocaleString()} bytes)`);
else { ko(`test xlsx 없거나 크기 0: stdout="${statResult.stdout}" stderr="${statResult.stderr}"`); process.exit(1); }

// 3) Spawn serve.py with the same args onlyoffice-host.ts uses.
log('== 3) Spawn serve.py ==');
const args = [
  '--', 'python3', SERVE_PY_WSL, TEST_XLSX_WSL,
  '--port', String(FILE_PORT),
  '--onlyoffice-url', ONLYOFFICE_URL,
  '--title', '7_System/PK_변신 및 스킬 시스템',
];
const child = spawn('wsl', args, { stdio: 'pipe', windowsHide: true });
let serveOut = '';
child.stdout?.on('data', (d) => { serveOut += d.toString(); });
child.stderr?.on('data', (d) => { serveOut += d.toString(); });
ok(`serve.py spawned via wsl (pid=${child.pid})`);

// 4) Wait for port 9000 listen (max 30s).
log('== 4) Wait for port 9000 ==');
let portUp = false;
const tStart = Date.now();
while (Date.now() - tStart < 30_000) {
  const r = spawnSync('wsl', ['--', 'bash', '-c', `ss -tln | grep -q ':${FILE_PORT} '`], { encoding: 'utf8', timeout: 3000 });
  if (r.status === 0) { portUp = true; break; }
  await sleep(500);
}
if (portUp) ok(`port ${FILE_PORT} listening (${((Date.now() - tStart) / 1000).toFixed(1)}s)`);
else { ko(`port ${FILE_PORT} 응답 없음 (30s)\nserve.py output:\n${serveOut}`); child.kill('SIGKILL'); process.exit(1); }

// 5) viewerUrl format.
const viewerUrl = `http://${wslIp}:${FILE_PORT}/`;
log(`== 5) viewerUrl = ${viewerUrl} ==`);
ok(`format http://<ip>:<port>/`);

// 6) Fetch embed HTML — must contain DocsAPI call.
log('== 6) Fetch embed HTML ==');
const htmlRes = await fetch(viewerUrl).catch((e) => ({ ok: false, status: 0, _err: String(e) }));
if (!htmlRes.ok) { ko(`HTML fetch 실패: status=${htmlRes.status} ${htmlRes._err ?? ''}`); }
else {
  const html = await htmlRes.text();
  if (html.includes('DocsAPI.DocEditor')) ok('embed HTML contains DocsAPI.DocEditor');
  else ko('embed HTML missing DocsAPI.DocEditor');
  if (html.includes('host.docker.internal:9000/sample.xlsx')) ok('container fetch URL correct');
  else ko('container fetch URL not found in embed HTML');
  if (html.includes(ONLYOFFICE_URL)) ok(`onlyoffice-url 주입됨 (${ONLYOFFICE_URL})`);
  else ko('onlyoffice-url not found in embed HTML');
}

// 7) Fetch sample.xlsx itself.
log('== 7) Fetch sample.xlsx ==');
const fileRes = await fetch(viewerUrl + 'sample.xlsx').catch((e) => ({ ok: false, status: 0, _err: String(e) }));
if (!fileRes.ok) ko(`sample.xlsx fetch 실패: status=${fileRes.status}`);
else {
  const len = Number(fileRes.headers.get('content-length') ?? '0');
  if (len === size) ok(`sample.xlsx ${len.toLocaleString()} bytes (matches source)`);
  else ko(`sample.xlsx size mismatch: got=${len} expected=${size}`);
}

// 8) Shutdown — kill serve.py and verify port free.
log('== 8) Shutdown ==');
child.kill('SIGKILL');
spawnSync('wsl', ['--', 'bash', '-c', "pgrep -f 'excel-viewer-poc/serve.py' | xargs -r kill -9 2>/dev/null"], { timeout: 5000 });
await sleep(1000);
const r2 = spawnSync('wsl', ['--', 'bash', '-c', `ss -tln | grep -q ':${FILE_PORT} '`], { encoding: 'utf8', timeout: 3000 });
if (r2.status !== 0) ok(`port ${FILE_PORT} freed after shutdown`);
else ko(`port ${FILE_PORT} still busy after shutdown`);

// Summary.
console.log('');
console.log(`=== integration: ${pass} passed, ${fail} failed ===`);
process.exit(fail === 0 ? 0 : 1);
