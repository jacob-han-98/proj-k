// content.js - Injected into Confluence pages
// Responsibilities: page detection, content extraction, sidebar injection, message bridge

(function () {
  'use strict';

  // Prevent double injection
  if (window.__pkAssistantLoaded) return;
  window.__pkAssistantLoaded = true;

  // --- Page Detection & Metadata ---

  function getMeta(name) {
    const el = document.querySelector(`meta[name="${name}"]`);
    return el ? el.getAttribute('content') : null;
  }

  function extractPageIdFromUrl() {
    // /pages/{pageId}, /pages/{pageId}/{title}, /pages/edit-v2/{pageId}
    const match = window.location.pathname.match(/\/pages\/(?:edit-v2\/)?(\d+)/);
    if (match) return match[1];
    // /spaces/{spaceKey}/pages/{pageId} or /spaces/{spaceKey}/pages/edit-v2/{pageId}
    const match2 = window.location.pathname.match(/\/spaces\/[^/]+\/pages\/(?:edit-v2\/)?(\d+)/);
    return match2 ? match2[1] : null;
  }

  function getPageMeta() {
    return {
      pageId: getMeta('ajs-page-id') || extractPageIdFromUrl(),
      spaceKey: getMeta('ajs-space-key') || extractSpaceKeyFromUrl(),
      title: getPageTitle(),
      url: window.location.href,
      confluenceBaseUrl: window.location.origin + '/wiki',
    };
  }

  function extractSpaceKeyFromUrl() {
    const match = window.location.pathname.match(/\/spaces\/([^/]+)/);
    return match ? match[1] : null;
  }

  function getPageTitle() {
    // Try multiple selectors
    const selectors = [
      '#title-text',
      '[data-testid="title-text"]',
      'h1[data-testid="title-text"]',
      '.page-title',
      'h1',
    ];
    for (const sel of selectors) {
      const el = document.querySelector(sel);
      if (el && el.innerText.trim()) return el.innerText.trim();
    }
    return document.title.replace(/ - .+$/, '').trim();
  }

  // --- Content Extraction ---

  function getPageContent() {
    const selectors = [
      '[data-testid="renderer-page"]',
      '.ak-renderer-document',
      '#content-body .wiki-content',
      '#content .wiki-content',
      '#main-content',
      '[role="main"]',
    ];

    for (const sel of selectors) {
      const el = document.querySelector(sel);
      if (el) {
        return {
          text: el.innerText,
          html: el.innerHTML,
          selector: sel,
        };
      }
    }

    return null;
  }

  // --- Sidebar Injection ---

  let sidebarFrame = null;
  let sidebarWrapper = null;
  let toggleBtn = null;
  let isOpen = false;
  let sidebarWidth = 420;
  const SIDEBAR_MIN_WIDTH = 300;
  const SIDEBAR_MAX_WIDTH = 800;

  function createToggleButton() {
    toggleBtn = document.createElement('button');
    toggleBtn.id = 'pk-assistant-toggle';
    toggleBtn.innerHTML = 'K';
    toggleBtn.title = 'Project K Assistant';
    toggleBtn.addEventListener('click', toggleSidebar);
    document.body.appendChild(toggleBtn);
  }

  function createSidebar() {
    // Wrapper: [resize-handle] [iframe]
    sidebarWrapper = document.createElement('div');
    sidebarWrapper.id = 'pk-assistant-sidebar-wrapper';
    sidebarWrapper.classList.add('hidden');
    sidebarWrapper.style.width = sidebarWidth + 'px';

    // Resize handle
    const handle = document.createElement('div');
    handle.id = 'pk-assistant-resize-handle';
    setupResizeHandle(handle);

    // iframe
    sidebarFrame = document.createElement('iframe');
    sidebarFrame.id = 'pk-assistant-sidebar';
    sidebarFrame.src = chrome.runtime.getURL('sidebar/sidebar.html');

    sidebarWrapper.appendChild(handle);
    sidebarWrapper.appendChild(sidebarFrame);
    document.body.appendChild(sidebarWrapper);
  }

  function setupResizeHandle(handle) {
    let startX, startWidth;

    handle.addEventListener('mousedown', (e) => {
      e.preventDefault();
      startX = e.clientX;
      startWidth = sidebarWidth;
      handle.classList.add('dragging');

      const onMouseMove = (e) => {
        const delta = startX - e.clientX;
        const newWidth = Math.min(SIDEBAR_MAX_WIDTH, Math.max(SIDEBAR_MIN_WIDTH, startWidth + delta));
        sidebarWidth = newWidth;
        sidebarWrapper.style.width = newWidth + 'px';
        setSidebarMargin(newWidth);
      };

      const onMouseUp = () => {
        handle.classList.remove('dragging');
        document.removeEventListener('mousemove', onMouseMove);
        document.removeEventListener('mouseup', onMouseUp);
      };

      document.addEventListener('mousemove', onMouseMove);
      document.addEventListener('mouseup', onMouseUp);
    });
  }

  function setSidebarMargin(width) {
    if (width) {
      document.body.style.setProperty('margin-right', width + 'px', 'important');
      const main = document.querySelector('#AkMainContent, [data-testid="grid-main-content"], #content');
      if (main) main.style.setProperty('max-width', `calc(100% - ${width}px)`, 'important');
      // Adjust floating bar so it doesn't hide behind sidebar
      if (floatingBar) floatingBar.style.setProperty('right', width + 'px');
    } else {
      document.body.style.removeProperty('margin-right');
      const main = document.querySelector('#AkMainContent, [data-testid="grid-main-content"], #content');
      if (main) main.style.removeProperty('max-width');
      if (floatingBar) floatingBar.style.setProperty('right', '0');
    }
  }

  function toggleSidebar() {
    isOpen = !isOpen;
    if (isOpen) {
      sidebarWrapper.classList.remove('hidden');
      sidebarWrapper.style.width = sidebarWidth + 'px';
      toggleBtn.classList.add('active');
      document.body.classList.add('pk-sidebar-open');
      setSidebarMargin(sidebarWidth);
    } else {
      sidebarWrapper.classList.add('hidden');
      toggleBtn.classList.remove('active');
      document.body.classList.remove('pk-sidebar-open');
      setSidebarMargin(null);
    }
  }

  // --- Message Bridge: sidebar iframe <-> background service worker ---

  window.addEventListener('message', (event) => {
    // Only accept messages from our sidebar iframe
    if (event.source !== sidebarFrame?.contentWindow) return;

    const msg = event.data;
    if (!msg || !msg.type) return;

    switch (msg.type) {
      case 'REQUEST_PAGE_CONTENT':
        sendToSidebar('PAGE_CONTENT', {
          meta: getPageMeta(),
          content: getPageContent(),
        });
        break;

      case 'CALL_BACKGROUND':
        // Relay message to background service worker
        chrome.runtime.sendMessage(msg.payload, (response) => {
          sendToSidebar('BACKGROUND_RESPONSE', {
            requestId: msg.requestId,
            response: response,
          });
        });
        break;

      case 'PREVIEW_CHANGES':
        previewChangesOnPage(msg.payload.changes);
        break;

      case 'CLEAR_PREVIEW':
        clearPreview();
        break;

      case 'SYNC_DECISION':
        syncInlineDecision(msg.payload.changeId, msg.payload.decision);
        break;

      case 'UPDATE_COUNTS':
        updateFloatingBar(msg.payload);
        break;

      case 'HIDE_FLOATING_BAR':
        hideFloatingBar();
        break;

      case 'CLOSE_SIDEBAR':
        clearPreview();
        hideFloatingBar();
        if (isOpen) toggleSidebar();
        break;

      default:
        break;
    }
  });

  // --- DOM Preview ---

  let previewMarkers = [];
  let focusedWidgetId = null;

  function previewChangesOnPage(changes) {
    clearPreview();

    const contentEl = getPageContentElement();
    if (!contentEl) return;

    let applied = 0;
    for (const change of changes) {
      const found = findAndHighlightText(contentEl, change.before, change.after, change.id);
      if (found) applied++;
    }

    sendToSidebar('PREVIEW_RESULT', { applied, total: changes.length });

    // Focus first pending widget
    if (previewMarkers.length > 0) {
      setFocusedWidget(previewMarkers[0].dataset.changeId);
      startKeyboardNavigation();
    }
  }

  function getPageContentElement() {
    const selectors = [
      '[data-testid="renderer-page"]',
      '.ak-renderer-document',
      '#content-body .wiki-content',
      '#content .wiki-content',
      '#main-content',
      '[role="main"]',
    ];
    for (const sel of selectors) {
      const el = document.querySelector(sel);
      if (el) return el;
    }
    return null;
  }

  function findAndHighlightText(root, beforeText, afterText, changeId) {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null, false);
    const textNodes = [];
    while (walker.nextNode()) textNodes.push(walker.currentNode);

    const fullText = textNodes.map(n => n.textContent).join('');
    const idx = fullText.indexOf(beforeText);
    if (idx === -1) return false;

    let charPos = 0;
    let startNode = null, startOffset = 0, endNode = null, endOffset = 0;

    for (const node of textNodes) {
      const nodeEnd = charPos + node.textContent.length;
      if (!startNode && idx < nodeEnd) {
        startNode = node;
        startOffset = idx - charPos;
      }
      if (startNode && idx + beforeText.length <= nodeEnd) {
        endNode = node;
        endOffset = idx + beforeText.length - charPos;
        break;
      }
      charPos = nodeEnd;
    }

    if (!startNode || !endNode) return false;

    const range = document.createRange();
    range.setStart(startNode, startOffset);
    range.setEnd(endNode, endOffset);

    // Create inline diff widget
    const widget = document.createElement('span');
    widget.className = 'pk-inline-diff pending';
    widget.dataset.changeId = changeId;
    widget.dataset.originalText = beforeText;
    widget.dataset.afterText = afterText;

    // Before text (strikethrough)
    const beforeEl = document.createElement('span');
    beforeEl.className = 'pk-diff-removed';
    beforeEl.textContent = beforeText;

    // After text (green)
    const afterEl = document.createElement('span');
    afterEl.className = 'pk-diff-added';
    afterEl.textContent = afterText;

    // Action buttons toolbar
    const toolbar = document.createElement('span');
    toolbar.className = 'pk-diff-toolbar';

    const btnAccept = document.createElement('button');
    btnAccept.className = 'pk-diff-icon pk-icon-accept';
    btnAccept.innerHTML = '&#x2713;'; // ✓
    btnAccept.title = 'Accept this change';

    const btnReject = document.createElement('button');
    btnReject.className = 'pk-diff-icon pk-icon-reject';
    btnReject.innerHTML = '&#x2715;'; // ✕
    btnReject.title = 'Reject this change';

    const btnSkip = document.createElement('button');
    btnSkip.className = 'pk-diff-icon pk-icon-skip';
    btnSkip.innerHTML = '&#x279C;'; // ➜
    btnSkip.title = 'Skip — decide later';

    toolbar.appendChild(btnAccept);
    toolbar.appendChild(btnReject);
    toolbar.appendChild(btnSkip);

    btnAccept.addEventListener('click', (e) => { e.stopPropagation(); applyInlineDecision(changeId, 'accepted'); });
    btnReject.addEventListener('click', (e) => { e.stopPropagation(); applyInlineDecision(changeId, 'rejected'); });
    btnSkip.addEventListener('click', (e) => { e.stopPropagation(); scrollToNextPending(changeId); });

    // Assemble widget
    range.deleteContents();
    widget.appendChild(toolbar);
    widget.appendChild(beforeEl);
    widget.appendChild(afterEl);
    range.insertNode(widget);

    previewMarkers.push(widget);
    return true;
  }

  // --- Focus & Keyboard Navigation ---

  function setFocusedWidget(changeId) {
    // Remove old focus
    document.querySelectorAll('.pk-inline-diff.pk-focused').forEach(el => el.classList.remove('pk-focused'));
    focusedWidgetId = changeId;
    if (!changeId) return;

    const widget = document.querySelector(`.pk-inline-diff[data-change-id="${changeId}"]`);
    if (widget) {
      widget.classList.add('pk-focused');
      widget.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  }

  function advanceFocus() {
    const allWidgets = [...document.querySelectorAll('.pk-inline-diff')];
    const currentIdx = allWidgets.findIndex(w => w.dataset.changeId === focusedWidgetId);

    // First: look downward from current position
    for (let i = currentIdx + 1; i < allWidgets.length; i++) {
      if (allWidgets[i].classList.contains('pending')) {
        setFocusedWidget(allWidgets[i].dataset.changeId);
        return;
      }
    }
    // Then: wrap to top and search from beginning (but stop before current)
    for (let i = 0; i <= currentIdx; i++) {
      if (allWidgets[i].classList.contains('pending')) {
        setFocusedWidget(allWidgets[i].dataset.changeId);
        return;
      }
    }
    // No pending left at all
    setFocusedWidget(null);
  }

  let keyboardActive = false;

  function startKeyboardNavigation() {
    if (keyboardActive) return;
    keyboardActive = true;

    document.addEventListener('keydown', handleDiffKeyboard);
  }

  function stopKeyboardNavigation() {
    keyboardActive = false;
    document.removeEventListener('keydown', handleDiffKeyboard);
  }

  function handleDiffKeyboard(e) {
    // Don't capture when typing in inputs
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.isContentEditable) return;
    if (!focusedWidgetId) return;

    if (e.key === 'y' || e.key === 'Y') {
      e.preventDefault();
      applyInlineDecision(focusedWidgetId, 'accepted');
    } else if (e.key === 'n' || e.key === 'N') {
      e.preventDefault();
      applyInlineDecision(focusedWidgetId, 'rejected');
    } else if (e.key === ' ') {
      e.preventDefault();
      advanceFocus();
    } else if (e.key === 'z' || e.key === 'Z') {
      e.preventDefault();
      applyInlineDecision(focusedWidgetId, 'pending');
    }
  }

  function scrollToNextPending(currentChangeId) {
    // Go downward first, then wrap to top
    const allWidgets = [...document.querySelectorAll('.pk-inline-diff')];
    const currentIdx = allWidgets.findIndex(w => w.dataset.changeId === currentChangeId);

    // Downward from current
    for (let i = currentIdx + 1; i < allWidgets.length; i++) {
      if (allWidgets[i].classList.contains('pending')) {
        setFocusedWidget(allWidgets[i].dataset.changeId);
        return;
      }
    }
    // Wrap to top
    for (let i = 0; i < currentIdx; i++) {
      if (allWidgets[i].classList.contains('pending')) {
        setFocusedWidget(allWidgets[i].dataset.changeId);
        return;
      }
    }
  }

  function applyInlineDecision(changeId, decision) {
    syncInlineDecision(changeId, decision);
    sendToSidebar('INLINE_DECISION', { changeId, decision });
    // Auto-advance focus after accept/reject (not on undo/pending)
    if (decision !== 'pending') {
      setTimeout(() => advanceFocus(), 50);
    }
  }

  function syncInlineDecision(changeId, decision) {
    const widget = document.querySelector(`.pk-inline-diff[data-change-id="${changeId}"]`);
    if (!widget) return;

    widget.className = `pk-inline-diff ${decision}`;
    const removed = widget.querySelector('.pk-diff-removed');
    const added = widget.querySelector('.pk-diff-added');
    const toolbar = widget.querySelector('.pk-diff-toolbar');

    if (decision === 'accepted') {
      if (removed) removed.style.display = 'none';
      if (added) added.className = 'pk-diff-accepted-text';
      if (toolbar) toolbar.innerHTML = '<button class="pk-diff-icon pk-icon-undo" title="Undo">&#x21A9;</button>';
    } else if (decision === 'rejected') {
      if (removed) removed.className = 'pk-diff-rejected-text';
      if (added) added.style.display = 'none';
      if (toolbar) toolbar.innerHTML = '<button class="pk-diff-icon pk-icon-undo" title="Undo">&#x21A9;</button>';
    } else {
      // Reset to pending
      if (removed) { removed.style.display = ''; removed.className = 'pk-diff-removed'; }
      if (added) { added.style.display = ''; added.className = 'pk-diff-added'; }
      if (toolbar) {
        toolbar.innerHTML = `
          <button class="pk-diff-icon pk-icon-accept" title="Accept">&#x2713;</button>
          <button class="pk-diff-icon pk-icon-reject" title="Reject">&#x2715;</button>
          <button class="pk-diff-icon pk-icon-skip" title="Skip — decide later">&#x279C;</button>
        `;
      }
    }

    // Wire up buttons
    if (toolbar) {
      const a = toolbar.querySelector('.pk-icon-accept');
      const r = toolbar.querySelector('.pk-icon-reject');
      const s = toolbar.querySelector('.pk-icon-skip');
      const u = toolbar.querySelector('.pk-icon-undo');
      if (a) a.addEventListener('click', (e) => { e.stopPropagation(); applyInlineDecision(changeId, 'accepted'); });
      if (r) r.addEventListener('click', (e) => { e.stopPropagation(); applyInlineDecision(changeId, 'rejected'); });
      if (s) s.addEventListener('click', (e) => { e.stopPropagation(); scrollToNextPending(changeId); });
      if (u) u.addEventListener('click', (e) => { e.stopPropagation(); applyInlineDecision(changeId, 'pending'); });
    }
  }

  function clearPreview() {
    for (const marker of previewMarkers) {
      const original = marker.dataset.originalText;
      if (original && marker.parentNode) {
        const textNode = document.createTextNode(original);
        marker.parentNode.replaceChild(textNode, marker);
      }
    }
    previewMarkers = [];
    focusedWidgetId = null;
    stopKeyboardNavigation();
    hideFloatingBar();
  }

  // --- Floating Status Bar (bottom of Confluence page) ---

  let floatingBar = null;

  function createFloatingBar() {
    if (floatingBar) return floatingBar;

    floatingBar = document.createElement('div');
    floatingBar.id = 'pk-floating-bar';
    floatingBar.innerHTML = `
      <div class="pk-float-stats">
        <span class="pk-float-label">Project K</span>
        <span id="pk-float-accepted" class="pk-float-badge pk-badge-accept">0 accepted</span>
        <span id="pk-float-rejected" class="pk-float-badge pk-badge-reject">0 rejected</span>
        <span id="pk-float-pending" class="pk-float-badge pk-badge-pending">0 pending</span>
        <span class="pk-float-keys"><kbd>Y</kbd> accept <kbd>N</kbd> reject <kbd>Space</kbd> skip <kbd>Z</kbd> undo</span>
      </div>
      <div class="pk-float-actions">
        <button id="pk-float-confirm" class="pk-float-btn pk-float-btn-confirm">Save to Confluence</button>
        <button id="pk-float-cancel" class="pk-float-btn pk-float-btn-cancel">Cancel</button>
      </div>
    `;

    floatingBar.querySelector('#pk-float-confirm').addEventListener('click', () => {
      sendToSidebar('FLOATING_CONFIRM');
    });
    floatingBar.querySelector('#pk-float-cancel').addEventListener('click', () => {
      sendToSidebar('FLOATING_CANCEL');
    });

    document.body.appendChild(floatingBar);
    return floatingBar;
  }

  function updateFloatingBar({ total, accepted, rejected, pending }) {
    if (total === 0) { hideFloatingBar(); return; }

    const bar = createFloatingBar();
    bar.style.display = 'flex';
    // Ensure bar doesn't hide behind sidebar
    bar.style.right = isOpen ? sidebarWidth + 'px' : '0';

    bar.querySelector('#pk-float-accepted').textContent = `${accepted} accepted`;
    bar.querySelector('#pk-float-rejected').textContent = `${rejected} rejected`;
    bar.querySelector('#pk-float-pending').textContent = `${pending} pending`;

    const confirmBtn = bar.querySelector('#pk-float-confirm');
    confirmBtn.disabled = accepted === 0;
    confirmBtn.textContent = accepted > 0 ? `Save ${accepted} Change(s) to Confluence` : 'Save to Confluence';

    // Highlight save button when all reviewed
    if (pending === 0 && accepted > 0) {
      confirmBtn.classList.add('pk-float-btn-ready');
    } else {
      confirmBtn.classList.remove('pk-float-btn-ready');
    }
  }

  function hideFloatingBar() {
    if (floatingBar) floatingBar.style.display = 'none';
  }

  function sendToSidebar(type, payload) {
    if (sidebarFrame && sidebarFrame.contentWindow) {
      sidebarFrame.contentWindow.postMessage({ type, payload }, '*');
    }
  }

  // --- SPA Navigation Tracking ---

  let currentUrl = window.location.href;
  let currentPageId = null;

  function startNavigationTracking() {
    // Poll for URL changes (Confluence SPA doesn't fire popstate consistently)
    setInterval(() => {
      if (window.location.href !== currentUrl) {
        const oldUrl = currentUrl;
        currentUrl = window.location.href;
        console.log('[PK Assistant] URL changed:', oldUrl, '->', currentUrl);
        handlePageChange();
      }
    }, 1000);

    // Also listen to popstate/pushState
    window.addEventListener('popstate', () => handlePageChange());
    const origPush = history.pushState;
    history.pushState = function (...args) {
      origPush.apply(this, args);
      setTimeout(handlePageChange, 300);
    };
  }

  function handlePageChange() {
    // Wait for new page content to render
    setTimeout(() => {
      const meta = getPageMeta();

      if (!meta.pageId) {
        // Navigated away from a page view (e.g. search, space overview)
        if (toggleBtn) toggleBtn.style.display = 'none';
        currentPageId = null;
        return;
      }

      // Show toggle button (create if not yet created)
      if (!toggleBtn) {
        createToggleButton();
        createSidebar();
      }
      toggleBtn.style.display = 'flex';

      // Only refresh sidebar if page actually changed
      if (meta.pageId !== currentPageId) {
        currentPageId = meta.pageId;
        console.log('[PK Assistant] Page changed to:', meta.title, `(${meta.pageId})`);

        // Notify sidebar of page change
        sendToSidebar('PAGE_CONTENT', {
          meta: meta,
          content: getPageContent(),
        });
      }
    }, 800); // Wait for Confluence to render new page
  }

  // --- Init ---

  function init() {
    const meta = getPageMeta();
    if (!meta.pageId) {
      console.log('[PK Assistant] Not a Confluence page (no pageId found), skipping.');
      // Still set up tracking - user might navigate to a page later
      startNavigationTracking();
      return;
    }

    currentPageId = meta.pageId;
    console.log('[PK Assistant] Detected Confluence page:', meta);
    createToggleButton();
    createSidebar();
    startNavigationTracking();
  }

  // Wait for page to be ready
  if (document.readyState === 'complete') {
    init();
  } else {
    window.addEventListener('load', init);
  }
})();
