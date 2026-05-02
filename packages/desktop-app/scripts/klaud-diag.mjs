#!/usr/bin/env node
/**
 * Klaud 진단 client — Claude Code (또는 누구든) 가 stdio MCP 거치지 않고 직접 WS 로
 * RPC 보내는 가벼운 도구. klaud-mcp-server.mjs 의 `x-klaud-role: diag` 분기를 사용.
 *
 * 사용:
 *   node scripts/klaud-diag.mjs health
 *   node scripts/klaud-diag.mjs state
 *   node scripts/klaud-diag.mjs get_logs 200
 *   node scripts/klaud-diag.mjs send_cmd '{"kind":"open-settings"}'
 *   node scripts/klaud-diag.mjs send_cmd '{"kind":"click-testid","testid":"activity-p4"}'
 *
 * 환경:
 *   KLAUD_MCP_WS_PORT (default 8769)
 *
 * Klaud 가 떠 있고 mcp-bridge 가 ws://<host>:<port> 에 connect 되어 있어야 동작.
 */

import WebSocket from 'ws';

const PORT = Number(process.env.KLAUD_MCP_WS_PORT ?? 8769);
const HOST = process.env.KLAUD_MCP_WS_HOST ?? 'localhost';

const [, , method, paramsStr] = process.argv;
if (!method) {
  console.error('usage: klaud-diag.mjs <method> [params-json]');
  process.exit(2);
}
const params = paramsStr
  ? (() => { try { return JSON.parse(paramsStr); } catch { return paramsStr; } })()
  : {};

const ws = new WebSocket(`ws://${HOST}:${PORT}/?role=diag`, {
  headers: { 'x-klaud-role': 'diag' },
});

const TIMEOUT_MS = 30_000;
const id = Math.floor(Math.random() * 1e9);
const timer = setTimeout(() => {
  console.error(`timeout ${TIMEOUT_MS}ms`);
  process.exit(3);
}, TIMEOUT_MS);

ws.on('open', () => {
  // get_logs 의 paramsStr 가 숫자면 lines.
  const finalParams =
    method === 'get_logs' && typeof params === 'string'
      ? { lines: Number(params) || 50 }
      : method === 'get_logs' && typeof params === 'number'
        ? { lines: params }
        : params;
  ws.send(JSON.stringify({ id, method, params: finalParams }));
});

ws.on('message', (raw) => {
  clearTimeout(timer);
  let msg;
  try { msg = JSON.parse(raw.toString('utf-8')); } catch (e) {
    console.error('parse error:', e.message);
    process.exit(4);
  }
  if (msg.id !== id) return;
  if (msg.error) {
    console.error('rpc error:', msg.error);
    process.exit(5);
  }
  // get_logs 는 string 으로 출력 (사람이 읽기 좋게).
  if (typeof msg.result?.logs === 'string') {
    console.log(msg.result.logs);
  } else {
    console.log(JSON.stringify(msg.result, null, 2));
  }
  ws.close();
});

ws.on('error', (e) => {
  clearTimeout(timer);
  console.error('ws error:', e.message);
  process.exit(6);
});

ws.on('close', () => process.exit(0));
