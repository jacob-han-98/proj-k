// Real Electron — 🤖 클릭 → agent-web 탭의 webview 가 실제로 어떤 URL 로 로드되고,
// content.length / title / DOM 의 #root 가 prod 와 동일한지 비교.
//
// 사용자 보고: "임베드 결과가 prod URL 과 동일하지 않음". 진단 목적 — 빌드된 Klaud 띄워
// webview src + 응답 비교.

import { _electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { join } from 'node:path';

let app: ElectronApplication;
let win: Page;

test.beforeAll(async () => {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  app = await _electron.launch({
    args: [join(__dirname, '..', '..', 'out', 'main', 'index.js')],
    env,
    timeout: 60_000,
  });
  win = await app.firstWindow();
  await win.waitForLoadState('domcontentloaded');
});

test.afterAll(async () => {
  await app?.close();
});

test('🤖 → agent-web 탭의 webview src 가 settings.agentWebUrl 로 들어가야', async () => {
  // 사이드카 대기 skip — webview src 검증만, sidecar 필요 X.
  await expect(win.getByTestId('topbar-agent-web')).toBeVisible({ timeout: 30_000 });

  // 자동 settings 모달이 보이면 "취소" 클릭 — 클릭 차단 회피.
  const cancelBtn = win.locator('.creds-modal button', { hasText: '취소' });
  if (await cancelBtn.isVisible().catch(() => false)) {
    await cancelBtn.click();
    await win.waitForTimeout(300);
  }

  // 클릭 전 settings 의 agentWebUrl 값 확인.
  const settings = await win.evaluate(() =>
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (window as any).projk.getSettings()
  );
  console.log('settings keys:', Object.keys(settings));
  console.log('settings.agentWebUrl =', settings.agentWebUrl);
  console.log('settings.agentUrl    =', settings.agentUrl);
  console.log('settings.repoRoot    =', settings.repoRoot);

  // app.getPath('userData') — main 의 _electron 앱 인스턴스 직접.
  const probe = await app.evaluate(({ app }) => ({
    userData: app.getPath('userData'),
    appData: app.getPath('appData'),
    name: app.getName(),
    isReady: app.isReady(),
  }));
  console.log('app probe:', probe);

  // 🤖 버튼 클릭.
  await win.getByTestId('topbar-agent-web').click();

  // agent-web 탭 mount.
  await expect(win.getByTestId('agent-web-pane')).toBeVisible();

  // webview 요소 src.
  const wv = win.getByTestId('agent-webview');
  await expect(wv).toBeVisible();
  const src = await wv.getAttribute('src');
  console.log('webview src =', src);
  expect(src).toBeTruthy();

  // webview 의 실제 로드된 URL / title 추출.
  // Electron 에선 webview 가 별도 webContents — page.frames 로는 안 잡힘. window.__inspectAgentWebview 같은
  // probe 를 추가해도 되지만, 가장 간단히 webview element 의 getURL / getTitle 을 evaluate 로.
  await win.waitForTimeout(8_000); // SSO 등 로딩 대기

  const wvProbe = await win.evaluate(async () => {
    const wv = document.querySelector('[data-testid="agent-webview"]') as
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      any;
    if (!wv) return { error: 'no webview' };
    try {
      const url = typeof wv.getURL === 'function' ? wv.getURL() : '(no getURL)';
      const title = typeof wv.getTitle === 'function' ? wv.getTitle() : '(no getTitle)';
      // executeJavaScript 로 webview 안에서 측정.
      const rootInfo = typeof wv.executeJavaScript === 'function'
        ? await wv.executeJavaScript(`(() => {
            const r = document.querySelector('#root');
            const sb = document.querySelector('.sidebar');
            const layout = document.querySelector('.layout');
            const sbStyle = sb ? getComputedStyle(sb) : null;
            return {
              docTitle: document.title,
              rootBytes: r ? r.innerHTML.length : 0,
              hasSidebar: !!sb,
              sidebarDisplay: sbStyle ? sbStyle.display : null,
              sidebarWidth: sbStyle ? sbStyle.width : null,
              hasLayout: !!layout,
              viewport: { w: window.innerWidth, h: window.innerHeight },
              devicePx: window.devicePixelRatio,
              media768: window.matchMedia('(max-width: 768px)').matches,
              media900: window.matchMedia('(max-width: 900px)').matches,
              media1024: window.matchMedia('(max-width: 1024px)').matches,
              location: location.href,
              dataTheme: document.documentElement.getAttribute('data-theme'),
              colorScheme: document.documentElement.style.colorScheme,
              prefersDark: window.matchMedia('(prefers-color-scheme: dark)').matches,
              bodyBg: getComputedStyle(document.body).backgroundColor,
              bodyColor: getComputedStyle(document.body).color,
              sidebarBg: sb ? getComputedStyle(sb).backgroundColor : null,
              sidebarColor: sb ? getComputedStyle(sb).color : null,
              sidebarRect: sb ? (() => { const r = sb.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height, visible: r.width > 0 && r.height > 0 }; })() : null,
              logoText: document.querySelector('.logo')?.innerText,
              cssVarBgPrimary: getComputedStyle(document.documentElement).getPropertyValue('--bg-primary'),
              cssVarTextPrimary: getComputedStyle(document.documentElement).getPropertyValue('--text-primary'),
            };
          })()`)
        : null;
      return { url, title, rootInfo };
    } catch (e) {
      return { error: String(e) };
    }
  });

  console.log('webview probe:', JSON.stringify(wvProbe, null, 2));

  // 시각 비교용 스크린샷 — Klaud 안 webview 영역만 잘라.
  const wvBox = await wv.boundingBox();
  if (wvBox) {
    await win.screenshot({ path: '.tmp-klaud-embed.png', clip: wvBox });
    console.log('saved: .tmp-klaud-embed.png');
  }

  // 추가 진단 — sidebar 안 logo 위치 + backdrop-filter disable 후 비교.
  const diag = await win.evaluate(async () => {
    const wv = document.querySelector('[data-testid="agent-webview"]') as
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      any;
    return await wv.executeJavaScript(`(() => {
      const logo = document.querySelector('.logo');
      const r = logo ? logo.getBoundingClientRect() : null;
      const cs = logo ? getComputedStyle(logo) : null;
      // 모든 .glass 의 backdrop-filter 제거 + 명시 흰색 bg.
      document.querySelectorAll('.glass').forEach(el => {
        el.style.backdropFilter = 'none';
        el.style.webkitBackdropFilter = 'none';
        el.style.background = 'rgba(255,255,255,1)';
      });
      return {
        logoRect: r ? { x: r.x, y: r.y, w: r.width, h: r.height } : null,
        logoColor: cs ? cs.color : null,
        logoFontSize: cs ? cs.fontSize : null,
        logoOpacity: cs ? cs.opacity : null,
        logoFontFamily: cs ? cs.fontFamily.slice(0, 80) : null,
      };
    })()`);
  });
  console.log('logo diag:', JSON.stringify(diag, null, 2));
  await win.waitForTimeout(500);
  if (wvBox) {
    await win.screenshot({ path: '.tmp-klaud-embed-noblur.png', clip: wvBox });
    console.log('saved: .tmp-klaud-embed-noblur.png  (backdrop-filter disabled)');
  }
});
