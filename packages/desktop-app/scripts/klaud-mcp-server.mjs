#!/usr/bin/env node
/**
 * Klaud MCP server.
 *
 * 두 가지를 동시에 한다:
 *   1) stdio MCP 서버 — Claude Code 가 spawn 하여 tool 로 사용
 *   2) WebSocket 서버 (port 8769) — 사용자 PC 의 Klaud 가 connect
 *
 * 흐름:
 *   Claude Code → stdio MCP request → 본 서버
 *      → WS 메시지로 Klaud 에 전달 (id 기반 RPC) → 응답 대기
 *      → MCP tool result 로 Claude Code 에 회신
 *
 * Klaud 가 connect 안 되어 있으면 모든 tool 이 "klaud disconnected" 에러 반환.
 *
 * 환경변수:
 *   KLAUD_MCP_WS_PORT  (default 8769)
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { WebSocketServer } from 'ws';

const WS_PORT = Number(process.env.KLAUD_MCP_WS_PORT ?? 8769);
const RPC_TIMEOUT_MS = 30_000;

// ---- Klaud WS connection 관리 ----

let klaudWs = null;
let nextRpcId = 1;
const pendingRpcs = new Map(); // id → { resolve, reject, timer }

const wss = new WebSocketServer({ host: '0.0.0.0', port: WS_PORT });

wss.on('connection', (ws) => {
  // 한 번에 하나의 Klaud 만 가정 (multi 는 추후).
  if (klaudWs && klaudWs.readyState === klaudWs.OPEN) {
    log('Klaud 가 이미 연결되어 있음 — 기존 연결을 끊고 새 연결로 교체');
    try { klaudWs.close(); } catch {}
  }
  klaudWs = ws;
  log(`Klaud connected from ${ws._socket.remoteAddress}`);

  // 5초마다 ping. 응답 없으면 stuck 으로 판정 + 강제 disconnect.
  let lastPongAt = Date.now();
  const heartbeat = setInterval(() => {
    if (Date.now() - lastPongAt > 30_000) {
      log(`heartbeat: 30s 응답 없음 — 연결 끊고 재연결 대기`);
      try { ws.close(); } catch {}
      return;
    }
    callKlaudRaw(ws, 'ping', {})
      .then(() => { lastPongAt = Date.now(); })
      .catch((e) => log(`heartbeat ping 실패: ${e.message}`));
  }, 5_000);

  ws.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw.toString('utf-8'));
      if (typeof msg.id === 'number') {
        const pending = pendingRpcs.get(msg.id);
        if (pending) {
          clearTimeout(pending.timer);
          pendingRpcs.delete(msg.id);
          if (msg.error) pending.reject(new Error(msg.error));
          else pending.resolve(msg.result);
        }
      }
      // event 메시지는 일단 무시 (Stage 1).
    } catch (e) {
      log(`WS 메시지 파싱 실패: ${e.message}`);
    }
  });

  ws.on('close', () => {
    clearInterval(heartbeat);
    log('Klaud disconnected');
    if (klaudWs === ws) klaudWs = null;
    // 진행중 RPC 모두 reject
    for (const [, p] of pendingRpcs) {
      clearTimeout(p.timer);
      p.reject(new Error('Klaud disconnected'));
    }
    pendingRpcs.clear();
  });

  ws.on('error', (e) => log(`WS error: ${e.message}`));
});

// 특정 ws 에 대해 직접 RPC (heartbeat 용 — klaudWs 가 바뀌어도 검증 중인 sock 으로만 호출).
function callKlaudRaw(sock, method, params = {}) {
  return new Promise((resolve, reject) => {
    if (!sock || sock.readyState !== sock.OPEN) {
      reject(new Error('socket not open'));
      return;
    }
    const id = nextRpcId++;
    const timer = setTimeout(() => {
      pendingRpcs.delete(id);
      reject(new Error(`timeout (5000ms heartbeat)`));
    }, 5_000);
    pendingRpcs.set(id, { resolve, reject, timer });
    try {
      sock.send(JSON.stringify({ id, method, params }));
    } catch (e) {
      clearTimeout(timer);
      pendingRpcs.delete(id);
      reject(e);
    }
  });
}

function log(msg) {
  // stdio 는 MCP protocol 전용이라 stderr 에 로그.
  process.stderr.write(`[klaud-mcp] ${msg}\n`);
}

function callKlaud(method, params = {}) {
  return new Promise((resolve, reject) => {
    if (!klaudWs || klaudWs.readyState !== klaudWs.OPEN) {
      reject(new Error('Klaud disconnected — 사용자가 Klaud 를 켜둬야 합니다'));
      return;
    }
    const id = nextRpcId++;
    const timer = setTimeout(() => {
      pendingRpcs.delete(id);
      reject(new Error(`timeout (${RPC_TIMEOUT_MS}ms)`));
    }, RPC_TIMEOUT_MS);
    pendingRpcs.set(id, { resolve, reject, timer });
    klaudWs.send(JSON.stringify({ id, method, params }));
  });
}

// ---- MCP Tool 정의 ----

const TOOLS = [
  {
    name: 'klaud_health',
    description:
      'Klaud 데스크톱 앱이 WS 로 연결되어 있는지, 사이드카 / 트리 / 채팅 패널의 현재 상태를 한눈에 확인. tool 호출 전 살아있는지 가벼운 체크용.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'klaud_screenshot',
    description:
      'Klaud 메인 윈도우 현재 화면을 PNG 로 캡처. 텍스트로는 못 잡는 시각적 회귀 (레이아웃, 색, 컴포넌트 누락 등) 검증.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'klaud_state',
    description:
      'Klaud 의 UI 상태를 구조화된 JSON 으로 query. 트리 노드 수, 채팅 메시지 카운트와 마지막 assistant 텍스트, 검색 결과 카드 list, 사이드카 상태 등. 회귀 가설 검증할 때 가장 먼저 호출하는 도구.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'klaud_send_cmd',
    description:
      'Klaud 에 self-test 시나리오 명령을 즉시 보내 동작시킴. open-settings / close-modal / type-and-send / click-update-indicator / assert-tree-non-empty / wait. UI 를 동적으로 조작하면서 검증.',
    inputSchema: {
      type: 'object',
      properties: {
        kind: {
          type: 'string',
          enum: [
            'open-settings',
            'close-modal',
            'type-and-send',
            'click-update-indicator',
            'assert-tree-non-empty',
            'wait',
          ],
        },
        text: { type: 'string', description: 'type-and-send 일 때 보낼 텍스트' },
        ms: { type: 'number', description: 'wait 일 때 대기 ms' },
      },
      required: ['kind'],
      additionalProperties: false,
    },
  },
  {
    name: 'klaud_get_logs',
    description:
      'Klaud 메인 / 사이드카 / 렌더러 콘솔 로그 마지막 N 줄. 에러 / 경고 / IPC 흐름 추적.',
    inputSchema: {
      type: 'object',
      properties: {
        lines: { type: 'number', description: 'last N lines (default 50)' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'klaud_click_testid',
    description:
      'Klaud renderer 의 data-testid 가 매치되는 element 를 클릭. tree 노드 / 버튼 / 입력 등 React 요소 어디든 — Playwright 의 page.locator(...).click() 등가물. 스샷 → 비전 분석 사이클 없이 ms 단위로 회귀 검증 가능.',
    inputSchema: {
      type: 'object',
      properties: {
        testid: { type: 'string', description: 'data-testid 속성값' },
        nth: {
          type: 'number',
          description: '여러 매치 시 N번째 (0-based). default 0',
        },
      },
      required: ['testid'],
      additionalProperties: false,
    },
  },
  {
    name: 'klaud_query_testid',
    description:
      'data-testid 매치 element 들의 visible / text / value / classList 일괄 조회. 클릭 후 결과 검증 / assertion 용. Playwright 의 expect(locator).toBeVisible() / textContent() 등가물.',
    inputSchema: {
      type: 'object',
      properties: {
        testid: { type: 'string', description: 'data-testid 속성값' },
      },
      required: ['testid'],
      additionalProperties: false,
    },
  },
];

// ---- MCP Server 셋업 ----

const server = new Server(
  { name: 'klaud', version: '0.1.0' },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args = {} } = req.params;
  try {
    let result;
    switch (name) {
      case 'klaud_health':
        result = await callKlaud('health', {});
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      case 'klaud_screenshot': {
        const { png_base64 } = await callKlaud('screenshot', {});
        // collector(8772) 에 POST → file 저장 + 0x0.st upload → 외부 URL 받음.
        // 사용자가 모바일에서도 스샷 보게 하려면 외부 URL 이 필수.
        const collectorUrl =
          process.env.KLAUD_LOG_COLLECTOR_URL?.replace(/\/+$/, '') ||
          'http://localhost:8772';
        let shareUrl = null;
        let localPath = null;
        try {
          const resp = await fetch(`${collectorUrl}/screenshot`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ png_base64 }),
          });
          if (resp.ok) {
            const body = await resp.json();
            shareUrl = body.url ?? null;
            localPath = body.local_path ?? null;
          }
        } catch (e) {
          log(`collector POST 실패: ${e.message}`);
        }

        const lines = [`screenshot captured (${png_base64.length} b64 chars)`];
        if (shareUrl) lines.push(`share URL: ${shareUrl}`);
        if (localPath) lines.push(`local: ${localPath}`);
        return {
          content: [
            { type: 'text', text: lines.join('\n') },
            { type: 'image', data: png_base64, mimeType: 'image/png' },
          ],
        };
      }
      case 'klaud_state':
        result = await callKlaud('state', {});
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      case 'klaud_send_cmd':
        result = await callKlaud('send_cmd', args);
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      case 'klaud_get_logs':
        result = await callKlaud('get_logs', args);
        return { content: [{ type: 'text', text: result?.logs ?? '(no logs)' }] };
      case 'klaud_click_testid':
        // send_cmd path 로 forward — mcp-bridge → renderer 의 click-testid 분기.
        result = await callKlaud('send_cmd', { kind: 'click-testid', ...args });
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      case 'klaud_query_testid':
        result = await callKlaud('send_cmd', { kind: 'query-testid', ...args });
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      default:
        throw new Error(`unknown tool: ${name}`);
    }
  } catch (e) {
    return {
      content: [{ type: 'text', text: `error: ${e.message}` }],
      isError: true,
    };
  }
});

// ---- Boot ----

log(`WebSocket listening on ws://0.0.0.0:${WS_PORT}/`);
log('Klaud 가 이 URL 로 connect 하면 tool 활성. Claude Code 가 stdio 로 연결됨.');

const transport = new StdioServerTransport();
await server.connect(transport);
