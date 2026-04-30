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
  try {
    const blob = await fs.readFile(CREDS_FILE());
    if (!safeStorage.isEncryptionAvailable()) {
      // Best-effort: stored as plain JSON if encryption unavailable
      return JSON.parse(blob.toString('utf-8')) as ConfluenceCreds;
    }
    const json = safeStorage.decryptString(blob);
    return JSON.parse(json) as ConfluenceCreds;
  } catch {
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
