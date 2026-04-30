// Phase 1 stub. The diff-preview UI ported from chrome-extension/content/content.js
// will land in Phase 4. For now, this preload simply tags the window so the host
// renderer can detect it loaded successfully.

declare global {
  interface Window {
    __projkConfluenceReady?: boolean;
  }
}

window.__projkConfluenceReady = true;
console.log('[projk] confluence-inject preload loaded');

export {};
