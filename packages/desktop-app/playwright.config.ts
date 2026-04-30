import { defineConfig, devices } from '@playwright/test';

// Web-mode renderer testing. Spawns the renderer-only Vite server, then loads
// http://127.0.0.1:5180/ in headless Chromium. Tests inject a mocked
// window.projk before the page scripts run, so no Electron / IPC is required.

export default defineConfig({
  testDir: 'tests/e2e-renderer',
  timeout: 30_000,
  fullyParallel: false,
  retries: 0,
  reporter: 'list',
  webServer: {
    command: 'npm run renderer:test-server',
    url: 'http://127.0.0.1:5180/',
    timeout: 60_000,
    reuseExistingServer: !process.env.CI,
    stdout: 'ignore',
    stderr: 'pipe',
  },
  use: {
    baseURL: 'http://127.0.0.1:5180/',
    headless: true,
    trace: 'retain-on-failure',
    viewport: { width: 1400, height: 900 },
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
  ],
});
