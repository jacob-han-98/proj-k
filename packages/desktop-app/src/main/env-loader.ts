// 2026-05-13 릴리스-B: dev 환경의 GCP OAuth credentials 자동 로드.
//
// 사용자가 GCP Console (Desktop app type) 에서 다운받은 JSON 을 packages/desktop-app/env/
// 에 두면 main 부팅 시 client_id 만 추출해 process.env.PROJK_GOOGLE_CLIENT_ID 로 inject.
// google-oauth.ts 가 이미 그 env 를 fallback 으로 읽음 — SettingsModal 의 OAuth Client ID
// 칸 비워둬도 동작.
//
// client_secret 은 무시 — Desktop app 의 PKCE 흐름은 client_secret 불필요.
//
// production (app.isPackaged === true) 에는 env/ 폴더 자체가 인스톨러에 안 들어가므로
// 자동 noop. 사용자는 SettingsModal 에서 client_id 입력해야 함 (CLAUDE.md 원칙).

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { app } from 'electron';

interface GcpInstalledCreds {
  installed?: {
    client_id?: string;
    client_secret?: string;
    project_id?: string;
  };
  web?: {
    client_id?: string;
  };
}

function findEnvDir(): string | null {
  // 후보 1: process.cwd() — `npm run dev` 가 packages/desktop-app/ 에서 실행되면 여기.
  // 후보 2: app.getAppPath() — electron-vite 빌드 후 out/ 경로. 그 위 (../..) 가 desktop-app.
  const candidates = [
    join(process.cwd(), 'env'),
    join(app.getAppPath(), 'env'),
    join(app.getAppPath(), '..', '..', 'env'),
  ];
  for (const dir of candidates) {
    if (existsSync(dir)) return dir;
  }
  return null;
}

export function loadDevEnvFromFiles(): void {
  if (app.isPackaged) return; // production 인스톨러에는 env/ 없음.
  const envDir = findEnvDir();
  if (!envDir) return;

  let injected: string[] = [];
  for (const name of readdirSync(envDir)) {
    // 1. Google Cloud Console GCP OAuth credentials JSON.
    if (name.endsWith('.json') && name.startsWith('client_secret_') && name.includes('.apps.googleusercontent.com')) {
      try {
        const raw = readFileSync(join(envDir, name), 'utf-8');
        const data = JSON.parse(raw) as GcpInstalledCreds;
        const clientId = data.installed?.client_id ?? data.web?.client_id;
        if (clientId && !process.env.PROJK_GOOGLE_CLIENT_ID) {
          process.env.PROJK_GOOGLE_CLIENT_ID = clientId;
          injected.push('PROJK_GOOGLE_CLIENT_ID');
          // client_secret 은 의도적으로 무시 — Desktop app PKCE 흐름은 secret 미사용.
        }
      } catch (e) {
        console.warn(`[env-loader] failed to parse env/${name}:`, (e as Error).message);
      }
      continue;
    }
    // 2. Atlassian OAuth credentials (수동 파일 — Atlassian Console 에는 JSON 다운로드 없음).
    //    형식: 단순 KEY=VALUE 텍스트. atlassian.env 라는 이름 권장.
    //    파일 안의 PROJK_ATLASSIAN_CLIENT_ID + PROJK_ATLASSIAN_CLIENT_SECRET 줄을 env 로 inject.
    if (name === 'atlassian.env' || name === '.atlassian.env') {
      try {
        const raw = readFileSync(join(envDir, name), 'utf-8');
        for (const line of raw.split(/\r?\n/)) {
          const trimmed = line.trim();
          if (!trimmed || trimmed.startsWith('#')) continue;
          const eq = trimmed.indexOf('=');
          if (eq <= 0) continue;
          const key = trimmed.slice(0, eq).trim();
          const value = trimmed.slice(eq + 1).trim();
          if (
            (key === 'PROJK_ATLASSIAN_CLIENT_ID' || key === 'PROJK_ATLASSIAN_CLIENT_SECRET') &&
            !process.env[key] &&
            value
          ) {
            process.env[key] = value;
            injected.push(key);
          }
        }
      } catch (e) {
        console.warn(`[env-loader] failed to parse env/${name}:`, (e as Error).message);
      }
    }
  }
  if (injected.length > 0) {
    console.log(`[env-loader] dev env loaded — injected: ${injected.join(', ')}`);
  }
}
