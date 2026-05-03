import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { app, safeStorage } from 'electron';
import type { ConfluenceCreds } from '../shared/types';

// Confluence credentials are encrypted with Electron's safeStorage and persisted
// next to the app userData directory. safeStorage uses the OS keychain (DPAPI on
// Windows, Keychain on macOS, libsecret on Linux) when available; otherwise it
// falls back to a process-tied scheme that is still better than plaintext.

const CREDS_FILE = () => join(app.getPath('userData'), 'confluence-creds.bin');

export async function getConfluenceCreds(): Promise<ConfluenceCreds | null> {
  let blob: Buffer;
  try {
    blob = await fs.readFile(CREDS_FILE());
  } catch {
    return null;
  }

  if (!safeStorage.isEncryptionAvailable()) {
    // Encryption unavailable — read as plain JSON (Linux without libsecret 등).
    try {
      return JSON.parse(blob.toString('utf-8')) as ConfluenceCreds;
    } catch {
      return null;
    }
  }

  // 암호화 활성 — 우선 decrypt 시도. fail 시 plain JSON fallback (외부 주입 / 옛 파일).
  // fallback hit 면 즉시 암호화로 재저장 → 다음 부팅엔 일반 흐름. 보안 약화 X — plain
  // 파일은 첫 부팅에만 받고 바로 cryptoencrypted 로 migrate.
  try {
    const json = safeStorage.decryptString(blob);
    return JSON.parse(json) as ConfluenceCreds;
  } catch {
    try {
      const fallback = JSON.parse(blob.toString('utf-8')) as ConfluenceCreds;
      if (fallback?.email && fallback?.apiToken) {
        // 자동 migration — encrypt + write back.
        await setConfluenceCreds(fallback).catch(() => {
          // migration 실패해도 in-memory 자격은 살림 — 다음 부팅에 한 번 더 시도.
        });
        return fallback;
      }
    } catch {
      /* not even valid plain JSON */
    }
    return null;
  }
}

export async function setConfluenceCreds(creds: ConfluenceCreds): Promise<void> {
  await fs.mkdir(app.getPath('userData'), { recursive: true });
  const payload = JSON.stringify(creds);
  if (safeStorage.isEncryptionAvailable()) {
    await fs.writeFile(CREDS_FILE(), safeStorage.encryptString(payload));
  } else {
    await fs.writeFile(CREDS_FILE(), payload, 'utf-8');
  }
}
