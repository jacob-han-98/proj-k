#!/usr/bin/env node
// Diag client for Klaud MCP bridge (port 8769).
// Usage:
//   node diag-call.mjs <method> [json-params]
// Examples:
//   node diag-call.mjs health
//   node diag-call.mjs state
//   node diag-call.mjs send_cmd '{"kind":"click-testid","testid":"activity-icon-p4"}'
//   node diag-call.mjs get_logs '{"lines":120}'
//
// Connects with header `x-klaud-role: diag` so it does not hijack the main Klaud
// connection. Server forwards method + params to klaudWs and returns its response.
import WebSocket from 'ws';

const [, , method, paramsJson] = process.argv;
if (!method) {
  console.error('usage: diag-call.mjs <method> [json-params]');
  process.exit(2);
}
let params = {};
if (paramsJson) {
  try { params = JSON.parse(paramsJson); }
  catch (e) { console.error('params must be valid JSON:', e.message); process.exit(2); }
}

const url = process.env.KLAUD_DIAG_URL || 'ws://localhost:8769/?role=diag';
const ws = new WebSocket(url, { headers: { 'x-klaud-role': 'diag' } });

const id = 1;
const TIMEOUT_MS = Number(process.env.KLAUD_DIAG_TIMEOUT_MS || 60_000);
let done = false;
const timer = setTimeout(() => {
  if (done) return;
  done = true;
  console.error(`timeout after ${TIMEOUT_MS}ms`);
  try { ws.close(); } catch {}
  process.exit(3);
}, TIMEOUT_MS);

ws.on('open', () => {
  ws.send(JSON.stringify({ id, method, params }));
});
ws.on('message', (raw) => {
  let msg;
  try { msg = JSON.parse(raw.toString('utf-8')); }
  catch (e) { console.error('bad json from server:', e.message); return; }
  if (msg.id !== id) return;
  done = true;
  clearTimeout(timer);
  if (msg.error) {
    console.error('error:', msg.error);
    try { ws.close(); } catch {}
    process.exit(1);
  }
  // Print result as JSON. Logs (get_logs) come back wrapped — print as-is.
  console.log(JSON.stringify(msg.result, null, 2));
  try { ws.close(); } catch {}
  process.exit(0);
});
ws.on('error', (e) => {
  if (done) return;
  console.error('ws error:', e.message);
  process.exit(4);
});
