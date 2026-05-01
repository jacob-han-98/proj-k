// P4 워크스페이스 자동 발견 — 사용자 PC 에 깔린 p4.exe 의 `p4 info` 출력에서
// Client root 추출. 사용자가 settings 에 path 입력하지 않아도 sidecar 가 알아서
// .xlsx 원본을 fetch 하게 됨. 사용자 부담 0회.
//
// 0.1.49 (PoC 2C) — 백엔드 서버 (= P4 워크스페이스) 에서 .xlsx 자동 다운로드 흐름.
// 향후 production 에서는 사내 file 게이트웨이 HTTP API 로 교체 가능 — 같은 sidecar
// /xlsx_raw 가 환경변수만 바뀌면 동작.
//
// PR9 — 좌표 (P4PORT/P4USER/P4CLIENT) 자동 발견 추가. 사용자가 회사 PC 에서 P4V 한
// 번 로그인했으면 ~/p4tickets.txt 에 ticket 이 있고, 그걸 파싱해서 host/user 를 얻은
// 다음 `p4 -p <host> -u <user> login -s` 로 ticket 유효성 확인하고 `p4 clients -u
// <user>` 로 client 자동 매칭. 결과는 SettingsModal 의 "자동 발견" 버튼이 form 에 채움.

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { homedir, hostname } from 'node:os';
import { join } from 'node:path';
import type { P4DiscoveryInfo } from '../shared/types';

// `p4 info` 출력 예:
//   User name: jacob
//   Client name: jacob_HYBE
//   Client host: ...
//   Client root: D:\ProjectK\Design
//   Current directory: ...
//   ...
// 사용자가 P4 login 안 한 상태에서도 Client info 는 나옴. P4 client 가 PATH 에 있어야 함
// (보통 D:\Program Files\Perforce\... 가 인스톨러로 자동 추가).
export function discoverP4ClientRoot(): string | null {
  if (process.platform !== 'win32') return null;
  try {
    const r = spawnSync('p4', ['info'], {
      encoding: 'utf-8',
      timeout: 5000,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    if (r.status !== 0) {
      console.log(`[p4-discovery] p4 info failed status=${r.status} stderr=${r.stderr?.trim()}`);
      return null;
    }
    const m = r.stdout.match(/^Client root:\s+(.+)$/m);
    const root = m?.[1]?.trim();
    if (!root || root.toLowerCase() === 'unknown') return null;
    return root;
  } catch (e) {
    console.log(`[p4-discovery] spawn 예외 ${(e as Error).message}`);
    return null;
  }
}

// p4tickets.txt 한 줄 포맷: `host:port=user:ticket`. 호스트:포트 부분에 콜론이 있어
// 단순 split 안 됨 — `=` 로 한 번 자르고 오른쪽에서 첫 `:` 로 user/ticket 분리.
function parseFirstP4Ticket(): { host: string; user: string } | null {
  if (process.platform !== 'win32') return null;
  // Windows: %USERPROFILE%\p4tickets.txt (도트 없음). Linux/Mac 은 ~/.p4tickets.
  const candidates = [join(homedir(), 'p4tickets.txt'), join(homedir(), '.p4tickets')];
  for (const path of candidates) {
    try {
      const content = readFileSync(path, 'utf-8');
      const firstLine = content.split(/\r?\n/).find((l) => l.trim());
      if (!firstLine) continue;
      const eq = firstLine.indexOf('=');
      if (eq < 0) continue;
      const host = firstLine.slice(0, eq).trim();
      const rest = firstLine.slice(eq + 1).trim();
      const colon = rest.indexOf(':');
      if (colon < 0) continue;
      const user = rest.slice(0, colon).trim();
      if (host && user) return { host, user };
    } catch {
      /* file 없음 — 다음 후보 */
    }
  }
  return null;
}

function runP4(args: string[], timeoutMs = 5000): { ok: boolean; stdout: string; stderr: string } {
  try {
    const r = spawnSync('p4', args, {
      encoding: 'utf-8',
      timeout: timeoutMs,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return {
      ok: r.status === 0,
      stdout: r.stdout ?? '',
      stderr: r.stderr ?? '',
    };
  } catch (e) {
    return { ok: false, stdout: '', stderr: (e as Error).message };
  }
}

// `p4 -p <host> -u <user> login -s` — exit 0 이면 ticket 유효. 1+ 이면 로그인 필요/만료.
function isLoggedIn(host: string, user: string): boolean {
  const r = runP4(['-p', host, '-u', user, 'login', '-s']);
  return r.ok;
}

// `p4 -p <host> -u <user> clients -u <user>` 출력 파싱 — 각 라인에서
// `Client <name> <date> root <root> '<desc>'` 패턴.
function listClientsForUser(host: string, user: string): string[] {
  const r = runP4(['-p', host, '-u', user, 'clients', '-u', user]);
  if (!r.ok) return [];
  const out: string[] = [];
  for (const line of r.stdout.split(/\r?\n/)) {
    const m = line.match(/^Client\s+(\S+)\s/);
    if (m) out.push(m[1]);
  }
  return out;
}

// host (PC) 이름과 가장 잘 매칭되는 client 선택 — Perforce 의 client 는 보통 hostname
// 일부를 포함. 매칭 안 되면 첫 번째 client 를 후보로 (사용자가 SettingsModal 에서
// candidates 중 다른 걸로 변경 가능).
function pickClient(clients: string[], hostName: string): string | undefined {
  if (clients.length === 0) return undefined;
  const lower = hostName.toLowerCase();
  // 정확히 hostname 포함 → 우선. 없으면 hostname 의 도메인 제거 부분 매칭.
  const exact = clients.find((c) => c.toLowerCase().includes(lower));
  if (exact) return exact;
  const shortHost = lower.split('.')[0]; // JACOB-D.local → 'jacob-d'
  const partial = clients.find((c) => c.toLowerCase().includes(shortHost));
  return partial ?? clients[0];
}

// 메인 entrypoint — SettingsModal 의 "자동 발견" 버튼이 호출.
// 단계: tickets 파싱 → login -s 검증 → clients 매칭 → p4 info (client root).
// 각 단계 실패 시 source/diagnostics 로 사용자에게 어디서 막혔는지 알려준다.
export function discoverP4Info(): P4DiscoveryInfo {
  if (process.platform !== 'win32') {
    return { ok: false, source: 'none', diagnostics: 'Windows 전용 — 현재 플랫폼에서는 자동 발견 불가' };
  }

  const ticket = parseFirstP4Ticket();
  if (!ticket) {
    return {
      ok: false,
      source: 'none',
      diagnostics:
        'p4tickets.txt 가 비어있거나 파싱 실패. P4V 또는 `p4 login` 으로 한 번 로그인 후 재시도하세요.',
    };
  }

  if (!isLoggedIn(ticket.host, ticket.user)) {
    return {
      ok: false,
      source: 'tickets',
      host: ticket.host,
      user: ticket.user,
      diagnostics:
        'ticket 만료 또는 서버 미접속 — 회사 VPN/사내망 확인 후 P4V 또는 `p4 login` 으로 재인증 하세요.',
    };
  }

  const candidates = listClientsForUser(ticket.host, ticket.user);
  const client = pickClient(candidates, hostname());

  // client root 는 p4 info 로 추가 fetch (있는 경우만 채움).
  let clientRoot: string | undefined;
  if (client) {
    const info = runP4(['-p', ticket.host, '-u', ticket.user, '-c', client, 'info']);
    if (info.ok) {
      const m = info.stdout.match(/^Client root:\s+(.+)$/m);
      const root = m?.[1]?.trim();
      if (root && root.toLowerCase() !== 'unknown') clientRoot = root;
    }
  }

  return {
    ok: true,
    source: 'tickets',
    host: ticket.host,
    user: ticket.user,
    client,
    clientRoot,
    candidates: candidates.length > 1 ? candidates : undefined,
  };
}
