#!/usr/bin/env node
// Verify-Excel-Content — Klaud 데스크톱 앱의 xlsx 클릭 → webview 렌더링까지 end-to-end 검증.
//
// 대상 시나리오 (2026-05-08 추가):
//   1. depot 또는 local tree 의 xlsx 파일을 클릭
//   2. main 의 ensureFresh / depot-open 흐름 통과
//   3. SP 의 cloud binary 가 진본인지 stub 인지 (Range GET probe 가 자동 판정)
//   4. webview 가 cloud-not-ready 카드 또는 정상 Excel 그리드 렌더 중 어느 쪽인지
//
// 사용:
//   node scripts/verify-excel-content.mjs <testid>
// 예:
//   node scripts/verify-excel-content.mjs "depot-row-//main/ProjectK/Design/7_System/PK_변신 및 스킬 시스템.xlsx"
//   node scripts/verify-excel-content.mjs "p4-row-xlsx::8_Contents/PK_몬스터_그림리퍼.xlsx"
//
// 출력:
//   - "READY" + 시작 → 끝까지 ms 단위 분해
//   - "STUB DETECTED" + cloud size / expected size — 함정 3 (Excel-for-Web auto-save corruption) 시그니처
//   - "CLOUD NOT READY" + reason 코드 — 다른 종류 실패 (네트워크 / 인증 / timeout)
//   - "WEBVIEW EMPTY" + 진단 — webview 떴지만 Excel 그리드 미렌더 (cross-origin iframe 안 쪽 검증 한계)
//   - "ERROR" + 메시지 — IPC / WS 등 인프라 실패
//
// klaud-mcp-server (port 8769) 가 떠 있어야 동작 — `?role=diag` 로 connect 후 RPC.
// 별도 npm 의존 없음 (ws 만 사용 — desktop-app 의 dependencies 에 이미 포함).

import WebSocket from 'ws';

const target = process.argv[2];
if (!target) {
  console.error('usage: verify-excel-content.mjs <testid>');
  console.error('예: verify-excel-content.mjs "depot-row-//main/ProjectK/Design/7_System/PK_HUD.xlsx"');
  process.exit(2);
}

const url = process.env.KLAUD_DIAG_URL || 'ws://localhost:8769/?role=diag';
const TOTAL_TIMEOUT_MS = Number(process.env.KLAUD_DIAG_TOTAL_TIMEOUT_MS || 90_000);

let nextId = 1;
const ws = new WebSocket(url, { headers: { 'x-klaud-role': 'diag' } });
const pending = new Map();
let totalTimer;

function call(method, params = {}, timeoutMs = 60_000) {
  return new Promise((resolve, reject) => {
    const id = nextId++;
    const t = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`timeout ${timeoutMs}ms ${method}`));
    }, timeoutMs);
    pending.set(id, { resolve, reject, t });
    ws.send(JSON.stringify({ id, method, params }));
  });
}

ws.on('message', (raw) => {
  let msg;
  try { msg = JSON.parse(raw.toString('utf-8')); }
  catch { return; }
  if (typeof msg.id !== 'number') return;
  const p = pending.get(msg.id);
  if (!p) return;
  clearTimeout(p.t);
  pending.delete(msg.id);
  if (msg.error) p.reject(new Error(msg.error));
  else p.resolve(msg.result);
});
ws.on('error', (e) => {
  console.error(`WS error: ${e.message}`);
  process.exit(4);
});

const log = (...args) => console.log(`[${((Date.now() - tStart) / 1000).toFixed(1)}s]`, ...args);
const tStart = Date.now();

ws.on('open', async () => {
  totalTimer = setTimeout(() => {
    console.error(`overall timeout ${TOTAL_TIMEOUT_MS}ms`);
    process.exit(5);
  }, TOTAL_TIMEOUT_MS);

  try {
    // 1. health 확인
    const h = await call('health');
    if (!h.connected) throw new Error('Klaud not connected to MCP bridge');
    log(`klaud connected, sidecar=${h.sidecar?.state}`);

    // 2. testid 가 DOM 에 보이는지
    const q = await call('send_cmd', { kind: 'query-testid', testid: target });
    if (!q.ok || q.count !== 1) {
      throw new Error(`testid not found or ambiguous: ${target} (count=${q.count})`);
    }
    log(`testid visible: "${(q.items?.[0]?.text || '').slice(0, 60)}"`);

    // 3. 클릭 → main 흐름 시작
    const c = await call('send_cmd', { kind: 'click-testid', testid: target });
    if (!c.ok) throw new Error(`click failed: ${c.error}`);
    log('clicked');

    // 4. cloud-not-ready 카드 또는 webview 등장까지 polling. 최대 75s.
    const tDeadline = Date.now() + 75_000;
    let outcome = null;
    while (Date.now() < tDeadline && !outcome) {
      // a) cloudNotReady 카드 검사 — Range GET probe 가 stub 또는 timeout 으로 판정 시 노출.
      const cnr = await call('send_cmd', { kind: 'query-testid', testid: 'onedrive-cloud-not-ready' });
      if (cnr.ok && cnr.count > 0 && cnr.items?.[0]?.visible) {
        const text = (cnr.items[0].text || '').slice(0, 500);
        outcome = {
          kind: 'cloud-not-ready-card',
          text,
          isStub: /size-mismatch|STUB|6148/i.test(text),
          isAuth: /auth|login\.microsoftonline/i.test(text),
        };
        break;
      }
      // b) webview 등장 검사 — SharePoint partition 의 webview 중 우리가 클릭한 file 명을
      //    포함하는 것만. 여러 탭 켜진 환경에서 다른 탭의 webview 가 잘못 매칭되는 회피.
      //    title 은 SP 가 file 명으로 set 하므로 그게 가장 신뢰. file 명은 testid 끝에서 추출.
      const fileNameInTestid = (target.match(/([^/\\]+\.xlsx)/) || [])[1] || '';
      try {
        const wv = await call('webview-eval', {
          expression: '({readyState:document.readyState,title:document.title,canvases:document.querySelectorAll("canvas").length,iframes:document.querySelectorAll("iframe").length,hasErrorPage:!!document.querySelector("[id*=error],[class*=Error]")})',
          urlPattern: fileNameInTestid ? encodeURIComponent(fileNameInTestid).slice(0, 40) : 'sharepoint',
          nth: 0,
        }, 5_000);
        if (wv?.result && wv.result.readyState === 'complete') {
          outcome = { kind: 'webview-rendered', state: wv.result };
          break;
        }
      } catch { /* webview 아직 없음 — 계속 */ }
      await new Promise((r) => setTimeout(r, 1500));
    }

    if (!outcome) throw new Error('neither cloud-not-ready card nor webview appeared in 75s');

    // 5. 판정
    if (outcome.kind === 'cloud-not-ready-card') {
      if (outcome.isStub) {
        console.log('\n=== STUB DETECTED ===');
        console.log(outcome.text);
        console.log(`\n진단: cloud 가 stub (Excel-for-Web auto-save 손상 또는 OneDrive Sync 미완). ` +
                    `local 진본은 정상이나 cloud upload 가 멈춤. 사용자가 SharePoint 웹 UI 에서 ` +
                    `corrupt 파일 삭제 후 재시도 또는 OneDrive Sync 재시작 필요.`);
        process.exit(10);
      } else if (outcome.isAuth) {
        console.log('\n=== AUTH REQUIRED ===');
        console.log(outcome.text);
        process.exit(11);
      } else {
        console.log('\n=== CLOUD NOT READY (other) ===');
        console.log(outcome.text);
        process.exit(12);
      }
    } else {
      // webview 떴음 — Excel-for-Web 그리드는 cross-origin iframe 안에 있어 직접 inspection 불가.
      // host 페이지의 canvas 0개 + iframe 1개 = Excel 컴포넌트 정상 mount. cell 렌더 자체는 SP
      // WOPI 응답 의존이라 host 페이지에서 못 잡음. fallback verification: title 이 파일명과 매치
      // 하면 SP 가 file 인식했다는 신호.
      const s = outcome.state;
      const title = (await call('webview-eval', { expression: 'document.title', urlPattern: 'sharepoint', nth: 0 }, 5_000)).result;
      console.log('\n=== WEBVIEW READY ===');
      console.log(`readyState: ${s.readyState}`);
      console.log(`canvases: ${s.canvases} / iframes: ${s.iframes} (Excel-for-Web 은 iframe 안 canvas)`);
      console.log(`title: "${title}"`);
      console.log(`hasErrorPage: ${s.hasErrorPage}`);
      if (s.iframes < 1) {
        console.log('\n경고: iframe 0개 — Excel-for-Web 컴포넌트 mount 실패 가능. 사용자 시점 확인 필요.');
        process.exit(13);
      }
      process.exit(0);
    }
  } catch (e) {
    console.error(`\n=== ERROR ===\n${e.message}`);
    process.exit(1);
  } finally {
    if (totalTimer) clearTimeout(totalTimer);
    try { ws.close(); } catch {}
  }
});
