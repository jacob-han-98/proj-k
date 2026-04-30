// 한 번에 빌드 + 패키징 + 피드 디렉터리 갱신.
//
//   npm run release                # patch 버전 자동 bump (0.1.0 → 0.1.1)
//   npm run release -- --version 1.0.0   # 명시 버전
//   npm run release -- --no-bump   # 현재 package.json 버전 그대로
//   npm run release -- --portable-only   # NSIS 생략 (Wine 미설치 환경)
//
// 출력:
//   release/ProjectK-Setup-X.Y.Z.exe (NSIS)
//   release/ProjectK-Portable-X.Y.Z.exe
//   release/latest.yml         ← electron-updater 가 폴링하는 메타파일
//   release/latest-mac.yml     (macOS 빌드 시)

import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PKG_DIR = join(__dirname, '..');
const PKG_JSON = join(PKG_DIR, 'package.json');

const args = process.argv.slice(2);
function flag(name) { return args.includes(`--${name}`); }
function opt(name) {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : null;
}

function run(cmd, cmdArgs, opts = {}) {
  console.log(`> ${cmd} ${cmdArgs.join(' ')}`);
  const r = spawnSync(cmd, cmdArgs, { stdio: 'inherit', cwd: PKG_DIR, ...opts });
  if (r.status !== 0) throw new Error(`${cmd} exited ${r.status}`);
}

function bumpPatch(v) {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(v);
  if (!m) return v;
  const [, a, b, c] = m;
  return `${a}.${b}.${Number(c) + 1}`;
}

function main() {
  const pkg = JSON.parse(readFileSync(PKG_JSON, 'utf-8'));
  let nextVersion = pkg.version;
  if (opt('version')) {
    nextVersion = opt('version');
  } else if (!flag('no-bump')) {
    nextVersion = bumpPatch(pkg.version);
  }

  if (nextVersion !== pkg.version) {
    pkg.version = nextVersion;
    writeFileSync(PKG_JSON, JSON.stringify(pkg, null, 2) + '\n');
    console.log(`[release] 버전 ${nextVersion}`);
  } else {
    console.log(`[release] 버전 유지: ${nextVersion}`);
  }

  // 1. electron-vite build (main + preload + renderer)
  run('npm', ['run', 'build']);

  // 2. electron-builder. publish=never → 자동 업로드 안 함 (로컬 release/ 에만 떨어짐)
  const builderArgs = ['electron-builder', '--win'];
  if (flag('portable-only')) {
    builderArgs.push('portable');
  } else {
    builderArgs.push('nsis', 'portable');
  }
  builderArgs.push('--config', 'electron-builder.yml', '--publish=never');

  // env 변수로 publish url 빈 값 채워둠 (yml의 ${env.X} 인터폴레이션 통과용)
  const env = { ...process.env };
  if (!env.PROJK_UPDATE_FEED_URL) {
    env.PROJK_UPDATE_FEED_URL = 'http://localhost:8765/';
  }

  run('npx', builderArgs, { env });

  // 3. 산출물 안내
  const releaseDir = join(PKG_DIR, 'release');
  if (!existsSync(releaseDir)) {
    console.warn('[release] release/ 디렉터리가 안 생겼습니다 — electron-builder 출력 확인');
    return;
  }
  console.log('');
  console.log('[release] 산출물:');
  for (const f of ['latest.yml', `ProjectK-Setup-${nextVersion}.exe`, `ProjectK-Portable-${nextVersion}.exe`]) {
    const p = join(releaseDir, f);
    if (existsSync(p)) console.log(`  ✓ ${p}`);
  }
  console.log('');
  console.log('[release] 다음 단계:');
  console.log('  1. 첫 설치: 사용자가 ProjectK-Setup-*.exe 한 번 실행');
  console.log('  2. 자동 업데이트 피드 시작: npm run serve:feed');
  console.log('  3. 다음 사이클부터 npm run release 만 돌리면 사용자 앱이 자동 업데이트');
}

try {
  main();
} catch (e) {
  console.error('[release] 실패:', e.message);
  process.exit(1);
}
