// P4 워크스페이스 자동 발견 — 사용자 PC 의 Perforce 설정을 여러 source 로부터 수집해
// 가장 그럴듯한 후보를 골라 `p4 info` 로 검증한다. 사용자는 SettingsModal 의 "자동 발견"
// 한 번 누르면 끝.
//
// 자료 출처 우선순위 (높을수록 신뢰):
//   1) `~/.p4qt/connectionmap.xml` (P4V Visual Client 의 명시 연결 프로필).
//      `<User>X</User><P4Port>Y</P4Port>` 가 분명히 들어있어 user 까지 정확히 알 수 있다.
//   2) Windows registry (HKCU\Software\Perforce\environment) — `P4_<host:port>_CHARSET`
//      항목으로 host 만 알 수 있음 (user 정보 없음). SSL 서버도 `ssl:host:port` 그대로.
//   3) p4tickets.txt — `host:port=user:ticket` 줄들. 모든 줄을 후보로 취급 (기존 코드는
//      첫 줄만 봐서 stale 로컬 entry 가 첫 번째일 때 망가졌음).
// 후보가 모이면 각각 `p4 -p <host> [-u <userHint>] info` 를 시도해 첫 성공한 것을 채택.
// 중요: userHint 가 있으면 반드시 `-u` 로 넘긴다 — 안 넘기면 p4 가 P4USER env 미설정 시
// **OS username 으로 fallback** 해서 잘못된 user (예: 'jacob' = OS user) 가 응답된다.
// 이게 사용자 시점에서 "왜 admin 계정인데 'jacob' 으로 잡히지?" 의 원인이었음.
//
// p4.exe 위치도 PATH + 일반 설치 경로로 검색 — 일부 시스템에서 PATH 누락된 경우 대비.

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { P4DiscoveryInfo, P4DepotEntry, P4DepotResult } from '../shared/types';

// p4.exe 캐싱 — module-level. 앱 한 세션 동안 같은 위치 가정.
let cachedP4Exe: string | null | undefined = undefined;

// PATH 의 p4 → 없으면 일반적인 Perforce 설치 경로 탐색.
function findP4ExePath(): string | null {
  if (cachedP4Exe !== undefined) return cachedP4Exe;
  if (process.platform !== 'win32') {
    // Linux/Mac 은 그냥 'p4' 가 PATH 에 있다고 가정.
    cachedP4Exe = 'p4';
    return cachedP4Exe;
  }
  // 1) PATH 검색.
  try {
    const r = spawnSync('where', ['p4'], { encoding: 'utf-8', timeout: 3000 });
    if (r.status === 0) {
      const first = r.stdout.split(/\r?\n/).find((l) => l.trim());
      if (first && existsSync(first.trim())) {
        cachedP4Exe = first.trim();
        return cachedP4Exe;
      }
    }
  } catch {
    /* fall through */
  }
  // 2) 흔한 설치 경로 — Helix Visual Client (P4V) 가 깔리면 함께 들어가는 위치.
  const candidates = [
    'C:\\Program Files\\Perforce\\p4.exe',
    'C:\\Program Files (x86)\\Perforce\\p4.exe',
    'D:\\Program Files\\Perforce\\p4.exe',
  ];
  for (const path of candidates) {
    if (existsSync(path)) {
      cachedP4Exe = path;
      return cachedP4Exe;
    }
  }
  cachedP4Exe = null;
  return null;
}

interface RunResult {
  ok: boolean;
  stdout: string;
  stderr: string;
}

// Default timeout 15s — SSL handshake + 한국어 path 가 있는 dir listing 은 5s 로는 부족할 수 있음.
function runP4(args: string[], timeoutMs = 15000): RunResult {
  const exe = findP4ExePath();
  if (!exe) return { ok: false, stdout: '', stderr: 'p4.exe not found' };
  // 항상 `-C utf8` 강제 — 서버가 unicode 모드일 때 한국어 파일/폴더명이 UTF-8 로 정상 출력된다.
  // 안 주면 p4 가 OS 기본 codepage (Korean Windows = CP949 / EUC-KR) 로 출력하고 우리는 UTF-8 로
  // 디코딩해서 mojibake (`PK_ä�� ý��.xlsx` 같은 깨진 글자) 가 발생.
  // 비-unicode 서버에서는 `-C utf8` 이 에러를 내지만, 기획팀의 Helix Core 는 unicode-mode 라
  // 항상 안전. (회귀 시 detect 후 conditional 로 바꿀 수 있게 한 곳에 박아둠.)
  const allArgs = ['-C', 'utf8', ...args];
  try {
    const r = spawnSync(exe, allArgs, {
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

// path 인자를 stdin 으로 전달하는 변형 (`p4 -x- <cmd>`).
// 이유: Windows spawnSync 가 한국어 + 공백 포함 path args 를 p4.exe 의 ANSI argv 파싱과
// 호환되게 전달하지 못함 (한국어 byte 가 token split 됨 → "Missing/wrong number of arguments").
// `-x-` 를 쓰면 path 를 stdin 의 줄바꿈 분리 list 로 받아 그 문제를 우회.
function runP4WithPaths(
  beforeXArgs: string[],
  cmd: string,
  afterCmdArgs: string[],
  paths: string[],
  timeoutMs = 30000,
): RunResult {
  const exe = findP4ExePath();
  if (!exe) return { ok: false, stdout: '', stderr: 'p4.exe not found' };
  // 순서: -C utf8 -p ... -u ... -c ... -x- <cmd> [<cmd-flags>]. -x- 는 cmd 앞에.
  const allArgs = ['-C', 'utf8', ...beforeXArgs, '-x-', cmd, ...afterCmdArgs];
  const stdin = paths.join('\n') + '\n';
  try {
    const r = spawnSync(exe, allArgs, {
      encoding: 'utf-8',
      timeout: timeoutMs,
      stdio: ['pipe', 'pipe', 'pipe'],
      input: stdin,
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

// HKCU\Software\Perforce\environment 에서 P4V 가 연결한 서버들 enumerate.
// 한 항목 형태: `P4_<server>_CHARSET REG_SZ <charset>`
//   예: `P4_ssl:p4.project-k.hybe.im:1666_CHARSET REG_SZ auto`
// 우리는 `<server>` 부분만 뽑는다. ssl: prefix 도 그대로 보존 (p4 -p 인자에 그대로 전달).
function enumP4ServersFromRegistry(): string[] {
  if (process.platform !== 'win32') return [];
  const out = new Set<string>();
  // reg query 는 case-insensitive — `environment` / `Environment` 둘 다 동일하게 매칭.
  const r = spawnSync('reg', ['query', 'HKCU\\Software\\Perforce\\environment'], {
    encoding: 'utf-8',
    timeout: 3000,
  });
  if (r.status !== 0) return [];
  for (const line of (r.stdout ?? '').split(/\r?\n/)) {
    // 한 라인: `    P4_<server>_CHARSET    REG_SZ    auto`
    // server 안에 콜론(:) 들어있으니 lazy 매칭으로 끝의 `_CHARSET` 까지 잡는다.
    const m = line.match(/^\s+P4_(.+)_CHARSET\s+REG_SZ\b/);
    if (m) {
      const server = m[1].trim();
      if (server) out.add(server);
    }
  }
  return [...out];
}

interface TicketEntry {
  host: string;
  user: string;
}

// `~/.p4qt/connectionmap.xml` (P4V) 파싱 — 이 파일은 사용자가 P4V 에서 명시적으로 만든
// 연결 프로필이라 user/host 가 가장 정확하다. 외부 XML 파서 의존 없이 정규식만으로 처리:
// 한 `<ConnectionMap>...</ConnectionMap>` 블록에서 `<User>X</User>` + `<P4Port>Y</P4Port>` 추출.
function parseP4QtConnections(): TicketEntry[] {
  const out: TicketEntry[] = [];
  const seen = new Set<string>();
  // 두 위치 모두 시도 — P4V (.p4qt) 와 P4Admin (.p4admin) 의 connectionmap.xml.
  const candidates = [
    join(homedir(), '.p4qt', 'connectionmap.xml'),
    join(homedir(), '.p4admin', 'connectionmap.xml'),
  ];
  for (const path of candidates) {
    let content: string;
    try {
      content = readFileSync(path, 'utf-8');
    } catch {
      continue;
    }
    const blockRe = /<ConnectionMap[^>]*>([\s\S]*?)<\/ConnectionMap>/g;
    let m: RegExpExecArray | null;
    while ((m = blockRe.exec(content)) !== null) {
      const block = m[1];
      const userM = block.match(/<User>([^<]+)<\/User>/);
      const portM = block.match(/<P4Port>([^<]+)<\/P4Port>/);
      const user = userM?.[1]?.trim();
      const host = portM?.[1]?.trim();
      if (!user || !host) continue;
      const key = `${host}|${user}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ host, user });
    }
  }
  return out;
}

// p4tickets.txt 의 모든 줄 파싱. 한 줄 포맷: `host:port=user:ticket`. host 부분에 `:` 가 있어
// 단순 split 안 됨 — `=` 로 1-회 자르고 오른쪽에서 첫 `:` 로 user/ticket 분리.
function parseAllP4Tickets(): TicketEntry[] {
  const out: TicketEntry[] = [];
  const seen = new Set<string>();
  // Windows: %USERPROFILE%\p4tickets.txt (도트 없음). Linux/Mac 은 ~/.p4tickets.
  const candidates = [join(homedir(), 'p4tickets.txt'), join(homedir(), '.p4tickets')];
  for (const path of candidates) {
    let content: string;
    try {
      content = readFileSync(path, 'utf-8');
    } catch {
      continue;
    }
    for (const line of content.split(/\r?\n/)) {
      if (!line.trim()) continue;
      const eq = line.indexOf('=');
      if (eq < 0) continue;
      const host = line.slice(0, eq).trim();
      const rest = line.slice(eq + 1).trim();
      const colon = rest.indexOf(':');
      if (colon < 0) continue;
      const user = rest.slice(0, colon).trim();
      if (!host || !user) continue;
      const key = `${host}|${user}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ host, user });
    }
  }
  return out;
}

interface InfoExtract {
  user?: string;
  client?: string;
  clientRoot?: string;
}

function parseInfoOutput(stdout: string): InfoExtract {
  const userM = stdout.match(/^User name:\s+(.+)$/m);
  const clientM = stdout.match(/^Client name:\s+(.+)$/m);
  const rootM = stdout.match(/^Client root:\s+(.+)$/m);
  const out: InfoExtract = {};
  const user = userM?.[1]?.trim();
  if (user) out.user = user;
  const client = clientM?.[1]?.trim();
  if (client && client.toLowerCase() !== 'unknown') out.client = client;
  const root = rootM?.[1]?.trim();
  if (root && root.toLowerCase() !== 'unknown') out.clientRoot = root;
  return out;
}

// 단일 후보 검증 — `p4 -p <host> [-u <userHint>] info`.
// userHint 를 안 넘기면 p4 가 P4USER 미설정 시 OS username 으로 fallback 해서
// 잘못된 user (예: Windows 의 'jacob') 가 응답되어 protect table 에서 reject 당한다.
// connectionmap.xml / p4tickets.txt 에서 얻은 user 가 있으면 무조건 -u 로 명시.
function probeServer(host: string, userHint?: string): { ok: boolean; data?: InfoExtract; stderr?: string } {
  const args = ['-p', host];
  if (userHint) args.push('-u', userHint);
  args.push('info');
  const r = runP4(args);
  if (!r.ok) return { ok: false, stderr: r.stderr.trim().split('\n')[0] || 'failed' };
  const info = parseInfoOutput(r.stdout);
  if (!info.user) return { ok: false, stderr: 'p4 info 응답에 User name 없음' };
  return { ok: true, data: info };
}

// 메인 entrypoint — SettingsModal 의 "자동 발견" 버튼이 호출.
export function discoverP4Info(): P4DiscoveryInfo {
  if (process.platform !== 'win32') {
    return {
      ok: false,
      source: 'none',
      diagnostics: 'Windows 전용 — 현재 플랫폼에서는 자동 발견 불가',
    };
  }

  const exe = findP4ExePath();
  if (!exe) {
    return {
      ok: false,
      source: 'none',
      diagnostics:
        'p4.exe 미발견 — Perforce CLI 가 PATH 에 없거나 설치 안 됨. P4V (Helix Visual Client) 설치 시 보통 C:\\Program Files\\Perforce\\p4.exe 가 함께 설치됩니다.',
    };
  }

  // 후보 수집 — 신뢰도 순: P4V connectionmap (user 명시) > registry (host 만) > tickets.
  const p4QtConns = parseP4QtConnections();
  const registryServers = enumP4ServersFromRegistry();
  const tickets = parseAllP4Tickets();

  type Candidate = { host: string; userHint?: string; sourceKind: 'registry' | 'tickets' };
  const candidates: Candidate[] = [];
  const seenHost = new Set<string>();
  // 1) P4V connectionmap — 가장 신뢰. user 명시.
  for (const c of p4QtConns) {
    if (seenHost.has(c.host)) continue;
    seenHost.add(c.host);
    // sourceKind 는 registry 로 분류 (사용자 시점에서 "P4V 가 아는 서버" 의미적 동치).
    candidates.push({ host: c.host, userHint: c.user, sourceKind: 'registry' });
  }
  // 2) registry — host 만 알고 user 는 모름 → tickets 에서 같은 host 매칭하면 hint 추출.
  for (const host of registryServers) {
    if (seenHost.has(host)) continue;
    seenHost.add(host);
    const ticket = tickets.find((t) => t.host === host);
    candidates.push({ host, userHint: ticket?.user, sourceKind: 'registry' });
  }
  // 3) tickets only — registry 에도 없고 connectionmap 에도 없는 서버.
  for (const t of tickets) {
    if (seenHost.has(t.host)) continue;
    seenHost.add(t.host);
    candidates.push({ host: t.host, userHint: t.user, sourceKind: 'tickets' });
  }

  if (candidates.length === 0) {
    return {
      ok: false,
      source: 'none',
      diagnostics:
        'P4 서버 후보 없음 — P4V 로 한 번 연결하거나 `p4 login` 을 한 번 실행한 뒤 재시도하세요. (registry/tickets 모두 비어있음)',
    };
  }

  // 각 후보 검증 — 첫 성공이 win. userHint 가 있으면 probe 시 -u 로 명시 (OS user fallback 방지).
  const errors: Array<{ host: string; msg: string }> = [];
  for (const c of candidates) {
    const probe = probeServer(c.host, c.userHint);
    if (probe.ok && probe.data) {
      return {
        ok: true,
        source: c.sourceKind,
        host: c.host,
        // userHint (P4V/tickets 에서 명시) 가 있으면 그걸 신뢰. probe 응답의 user 는 fallback.
        user: c.userHint ?? probe.data.user,
        client: probe.data.client,
        clientRoot: probe.data.clientRoot,
        candidates:
          candidates.length > 1 ? candidates.map((x) => x.host).filter((h) => h !== c.host) : undefined,
      };
    }
    errors.push({ host: c.host, msg: probe.stderr ?? 'unknown' });
  }

  // 전부 실패 — 첫 후보 정보를 partial 로 채워서 사용자가 수동 보정 시작점으로.
  const head = candidates[0];
  const errSummary = errors
    .slice(0, 3)
    .map((e) => `${e.host} — ${e.msg}`)
    .join(' / ');
  return {
    ok: false,
    source: head.sourceKind,
    host: head.host,
    user: head.userHint,
    diagnostics: `${candidates.length}개 후보 모두 연결 실패 (사내망/VPN 확인 필요): ${errSummary}`,
    candidates: candidates.length > 1 ? candidates.map((x) => x.host) : undefined,
  };
}

// 0.1.49 (PoC 2C) — 백엔드 서버에서 .xlsx 자동 다운로드 흐름. main 의 sidecar 가 호출.
// 사용자가 settings 에 path 입력 안 해도 동작. p4 info 의 Client root 로 fallback.
export function discoverP4ClientRoot(): string | null {
  const r = runP4(['info']);
  if (!r.ok) {
    console.log(`[p4-discovery] p4 info failed: ${r.stderr.trim()}`);
    return null;
  }
  const info = parseInfoOutput(r.stdout);
  return info.clientRoot ?? null;
}

// ---------- PR9b: depot 트리 lazy fetch ----------
// 보기 전용. 사용자가 depot 폴더를 펼치면 자식 (하위 폴더 + .xlsx 파일) 만 fetch.
// 편집은 별도 P4 checkout 흐름 (이번 PR 범위 외). 파일 클릭 시 안내만.

// `p4 client -o <client>` 의 `Stream:` 필드 추출. stream workspace 면 path (`//main/ProjectK`),
// classic workspace 면 null. UI 는 stream 이 있으면 그 한 path 만 root 로 노출 (P4V 의
// "Depot 탭 + 현재 stream workspace" 뷰와 동일한 스코핑).
function getClientStream(host: string, user: string, client: string): string | null {
  const r = runP4(['-p', host, '-u', user, '-c', client, 'client', '-o', client]);
  if (!r.ok) return null;
  // 라인 예: `Stream:\t//main/ProjectK` (탭 또는 스페이스 구분).
  const m = r.stdout.match(/^Stream:\s+(\S+)/m);
  return m?.[1]?.trim() || null;
}

// stream workspace 면 stream path 한 entry 만, 아니면 `p4 depots` 결과를 그대로.
//
// stream workspace 일 때:
//   `p4 client -o jacob-D` → Stream: //main/ProjectK
//   → root = [{ path: '//main/ProjectK', name: 'main/ProjectK', kind: 'depot' }]
//   → 사용자가 펼치면 listDepotChildren('//main/ProjectK') 가 ART/Build/Design/... 노출.
//
// classic workspace (Stream 없음):
//   → 기존처럼 `p4 depots` 결과 모두 노출.
export function listDepotRoots(host: string, user: string, client: string): P4DepotResult {
  if (!host || !user || !client) {
    return {
      ok: false,
      entries: [],
      diagnostics: 'P4 좌표 미설정 — ⚙ 설정에서 host/user/client 를 입력하거나 자동 발견을 실행하세요.',
    };
  }
  if (!findP4ExePath()) {
    return { ok: false, entries: [], diagnostics: 'p4.exe 미발견 — PATH 또는 일반 설치 경로 확인.' };
  }

  // 1) stream workspace 인지 먼저 확인. 있으면 단일 entry 로 끝.
  const stream = getClientStream(host, user, client);
  if (stream) {
    // 표시명: '//' prefix 떼고 'main/ProjectK' 형태 — P4V 의 stream label 과 동일.
    const display = stream.replace(/^\/\//, '');
    return {
      ok: true,
      entries: [{ path: stream, name: display, kind: 'depot' }],
    };
  }

  // 2) classic workspace fallback — `p4 depots` 출력 (한 라인 한 depot):
  //    Depot depot 2024/01/01 stream //depot/... '..'
  //    Depot another 2024/02/02 local //another/... '..'
  const r = runP4(['-p', host, '-u', user, '-c', client, 'depots']);
  if (!r.ok) {
    return { ok: false, entries: [], diagnostics: `p4 depots 실패: ${r.stderr.trim() || 'unknown'}` };
  }
  const entries: P4DepotEntry[] = [];
  for (const line of r.stdout.split(/\r?\n/)) {
    const m = line.match(/^Depot\s+(\S+)\s/);
    if (m) entries.push({ path: `//${m[1]}`, name: m[1], kind: 'depot' });
  }
  return { ok: true, entries };
}

// 한 path 의 직속 자식들. 폴더는 `p4 dirs <path>/*`, 파일은 `p4 files -e <path>/*.xlsx`.
//   - `p4 dirs //depot/main/*` → '//depot/main/Design\n//depot/main/Build\n...'
//   - `p4 files -e //depot/main/Design/*.xlsx` → '//.../foo.xlsx#3 - edit change 1234 (binary+S2)'
// -e 는 head 에서 deleted 된 파일 skip. 파일 출력의 # 앞부분이 depot path.
export function listDepotChildren(
  host: string,
  user: string,
  client: string,
  parentPath: string,
): P4DepotResult {
  if (!host || !user || !client) {
    return {
      ok: false,
      entries: [],
      diagnostics: 'P4 좌표 미설정',
    };
  }
  if (!findP4ExePath()) {
    return { ok: false, entries: [], diagnostics: 'p4.exe 미발견' };
  }
  const entries: P4DepotEntry[] = [];

  // 1) 자식 디렉토리. parentPath 가 한국어 포함이면 args 로 전달 시 깨지므로 stdin (-x-) 사용.
  const dirsR = runP4WithPaths(
    ['-p', host, '-u', user, '-c', client],
    'dirs',
    [],
    [`${parentPath}/*`],
    15000,
  );
  if (dirsR.ok) {
    for (const line of dirsR.stdout.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('//')) continue;
      const name = trimmed.split('/').pop() ?? trimmed;
      entries.push({ path: trimmed, name, kind: 'dir' });
    }
  }
  // dirs 가 'no such file(s).' 로 실패해도 빈 폴더일 수 있어 file 시도는 계속.

  // 2) .xlsx 파일 (기획 도구 본질). 다른 확장자는 일단 노출 안 함 — depot 은 보기 전용 +
  //    스펙 키우지 말자 원칙.
  const filesR = runP4WithPaths(
    ['-p', host, '-u', user, '-c', client],
    'files',
    ['-e'],
    [`${parentPath}/*.xlsx`],
    15000,
  );
  if (filesR.ok) {
    for (const line of filesR.stdout.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('//')) continue;
      const hashIdx = trimmed.indexOf('#');
      const filePath = hashIdx > 0 ? trimmed.slice(0, hashIdx) : trimmed.split(/\s/)[0];
      const name = filePath.split('/').pop() ?? filePath;
      entries.push({ path: filePath, name, kind: 'file' });
    }
  }

  // 폴더 먼저, 파일 나중 — 사용자에게 익숙한 정렬.
  // 같은 종류 안에서는 알파벳 (대소문자 무시).
  entries.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === 'dir' ? -1 : 1;
    return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
  });

  // dirs / files 둘 다 실패한 경우 (예: 권한 없음) diagnostics 표시.
  if (!dirsR.ok && !filesR.ok) {
    return {
      ok: false,
      entries: [],
      diagnostics: `자식 fetch 실패 — ${dirsR.stderr.trim() || filesR.stderr.trim() || 'unknown'}`,
    };
  }

  return { ok: true, entries };
}

// `p4 fstat <depotPath>` 의 `headRev N` 라인 추출 — depot 파일의 head revision.
// path 는 stdin 으로 전달 (-x-) — 한국어/공백 포함 path 가 Windows argv 에서 깨지는 문제 우회.
export function getDepotHeadRevision(
  host: string,
  user: string,
  client: string,
  depotPath: string,
): number | null {
  if (!host || !user || !client || !depotPath) return null;
  if (!findP4ExePath()) return null;
  const r = runP4WithPaths(['-p', host, '-u', user, '-c', client], 'fstat', [], [depotPath], 15000);
  if (!r.ok) {
    console.warn(
      `[p4-discovery] fstat failed path=${depotPath} status_stderr=${r.stderr.trim().slice(0, 300)}`,
    );
    return null;
  }
  const m = r.stdout.match(/^\.\.\.\s+headRev\s+(\d+)/m);
  if (!m) {
    console.warn(`[p4-discovery] fstat 출력에 headRev 없음 path=${depotPath} stdout=${r.stdout.slice(0, 300)}`);
    return null;
  }
  const n = parseInt(m[1], 10);
  return Number.isFinite(n) ? n : null;
}

// `p4 print -q -o <destLocalPath> <depotPath>` — depot 파일 head revision 의 binary 를
// 로컬 path 로 download. xlsx 는 binary+S2 이므로 -o 로 raw 저장. -q (quiet) 로 헤더 라인 suppress.
// path 는 stdin (-x-), destLocalPath 는 ASCII-only (호출측에서 보장) — 한국어/공백 모두 안전.
export function printDepotFile(
  host: string,
  user: string,
  client: string,
  depotPath: string,
  destLocalPath: string,
): { ok: boolean; error?: string } {
  if (!host || !user || !client || !depotPath || !destLocalPath) {
    return { ok: false, error: 'p4 좌표 / depot path / dest 누락' };
  }
  if (!findP4ExePath()) return { ok: false, error: 'p4.exe 미발견' };
  // 비-ASCII dest 는 spawn 에서 깨질 수 있어 호출측이 ASCII path 만 넘겨야 안전. 검증:
  if (/[^\x00-\x7E]/.test(destLocalPath)) {
    return {
      ok: false,
      error: `dest path 에 비-ASCII 문자 — Windows spawn argv 호환성 문제. ASCII 경로로 전달하세요. (${destLocalPath})`,
    };
  }
  // .xlsx 가 수십 MB 일 수 있어 timeout 60초로 확장.
  const r = runP4WithPaths(
    ['-p', host, '-u', user, '-c', client],
    'print',
    ['-q', '-o', destLocalPath],
    [depotPath],
    60000,
  );
  if (!r.ok) {
    // stderr/stdout 전체 + dest path 까지 포함해 진단 가능하게.
    const stderr = (r.stderr || '').trim();
    const stdout = (r.stdout || '').trim();
    const detail = stderr || stdout || 'unknown';
    console.error(
      `[p4-discovery] print 실패 path=${depotPath} dest=${destLocalPath}\n  stderr: ${stderr}\n  stdout: ${stdout}`,
    );
    return { ok: false, error: detail.split('\n').slice(0, 3).join(' | ') };
  }
  return { ok: true };
}
