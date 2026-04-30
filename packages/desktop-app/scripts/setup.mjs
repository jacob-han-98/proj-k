// Cross-platform Python venv bootstrap.
// Used by `npm run setup` on first checkout (Windows or Linux/macOS).
//
// What it does:
//   1. Creates packages/desktop-app/.venv if missing
//   2. Installs sidecar requirements.txt into that venv
//   3. Prints a summary so the user can verify the toolchain
//
// It deliberately does NOT touch node_modules — that's npm's job.

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PKG_DIR = join(__dirname, '..');
const VENV_DIR = join(PKG_DIR, '.venv');
const isWin = process.platform === 'win32';
const venvPython = isWin ? join(VENV_DIR, 'Scripts', 'python.exe') : join(VENV_DIR, 'bin', 'python');

function run(cmd, args, opts = {}) {
  console.log(`> ${cmd} ${args.join(' ')}`);
  const res = spawnSync(cmd, args, { stdio: 'inherit', ...opts });
  if (res.status !== 0) {
    throw new Error(`${cmd} exited with code ${res.status}`);
  }
}

function detectPython() {
  if (process.env.PROJK_PYTHON) return process.env.PROJK_PYTHON;
  for (const candidate of isWin ? ['python', 'py'] : ['python3', 'python']) {
    const probe = spawnSync(candidate, ['--version'], { stdio: 'pipe' });
    if (probe.status === 0) return candidate;
  }
  throw new Error(
    `Python 인터프리터를 찾지 못했습니다. ${isWin ? 'https://python.org 에서 Python 3.11+를 설치하고 PATH에 추가해 주세요.' : 'sudo apt install python3 python3-venv'}`,
  );
}

function main() {
  const py = detectPython();
  console.log(`[setup] using base Python: ${py}`);

  if (!existsSync(venvPython)) {
    console.log(`[setup] creating venv at ${VENV_DIR}`);
    run(py, ['-m', 'venv', VENV_DIR]);
  } else {
    console.log(`[setup] venv already exists`);
  }

  const reqPath = join(PKG_DIR, 'src', 'sidecar', 'requirements.txt');
  console.log(`[setup] installing ${reqPath}`);
  run(venvPython, ['-m', 'pip', 'install', '--upgrade', 'pip']);
  run(venvPython, ['-m', 'pip', 'install', '-r', reqPath]);

  console.log('');
  console.log('[setup] OK. To launch the dev environment:');
  console.log('  npm run dev');
}

try {
  main();
} catch (e) {
  console.error('[setup] FAILED:', e.message);
  process.exit(1);
}
