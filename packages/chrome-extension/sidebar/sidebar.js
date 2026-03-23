// sidebar.js - Main sidebar UI logic
// Runs inside the sidebar iframe, communicates with content script via postMessage

(function () {
  'use strict';

  // --- State ---
  let pageMeta = null;
  let pageContent = null;
  let editSession = {
    changes: [],
    decisions: {},  // { 'change-1': 'accepted' | 'rejected' }
    autoApply: false,
  };
  let pendingRequests = {};
  let requestCounter = 0;

  // --- DOM refs ---
  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => document.querySelectorAll(sel);

  // --- Init ---
  function init() {
    setupTabs();
    setupSummaryTab();
    setupEditTab();
    setupStatusBar();
    requestPageContent();
  }

  // --- Communication with content script ---

  function sendToContent(type, payload) {
    window.parent.postMessage({ type, payload }, '*');
  }

  function callBackground(action, payload) {
    return new Promise((resolve, reject) => {
      const requestId = `req-${++requestCounter}`;
      pendingRequests[requestId] = { resolve, reject };

      sendToContent('CALL_BACKGROUND', null);
      // We need to pass the requestId along with the background message
      window.parent.postMessage({
        type: 'CALL_BACKGROUND',
        requestId: requestId,
        payload: { action, payload },
      }, '*');

      // Timeout after 180 seconds (Opus 4.6 + long pages can take a while)
      setTimeout(() => {
        if (pendingRequests[requestId]) {
          delete pendingRequests[requestId];
          reject(new Error('Request timed out (180s)'));
        }
      }, 180000);
    });
  }

  window.addEventListener('message', (event) => {
    const msg = event.data;
    if (!msg || !msg.type) return;

    switch (msg.type) {
      case 'PAGE_CONTENT':
        const isNewPage = pageMeta && msg.payload.meta && pageMeta.pageId !== msg.payload.meta.pageId;
        pageMeta = msg.payload.meta;
        pageContent = msg.payload.content;
        updatePageInfo();
        if (isNewPage) resetEditSession();
        break;

      case 'PREVIEW_RESULT':
        const previewEl = $('#preview-result');
        if (msg.payload.applied < msg.payload.total) {
          previewEl.innerHTML = `${msg.payload.applied}/${msg.payload.total} changes found on page. ` +
            `<em style="color:#f59e0b">${msg.payload.total - msg.payload.applied} not found (page may have changed)</em>`;
        }
        break;

      case 'INLINE_DECISION':
        // Decision made on the page → sync to sidebar
        if (msg.payload.decision === 'pending') {
          delete editSession.decisions[msg.payload.changeId];
        } else {
          editSession.decisions[msg.payload.changeId] = msg.payload.decision;
        }
        renderDiffs();
        break;

      case 'FLOATING_CONFIRM':
        handleSaveToConfluence();
        break;

      case 'FLOATING_CANCEL':
        handleCancelEdits();
        break;

      case 'BACKGROUND_RESPONSE':
        const req = pendingRequests[msg.payload.requestId];
        if (req) {
          delete pendingRequests[msg.payload.requestId];
          const resp = msg.payload.response;
          if (resp && resp.error) {
            req.reject(new Error(resp.error));
          } else {
            req.resolve(resp);
          }
        }
        break;
    }
  });

  function requestPageContent() {
    sendToContent('REQUEST_PAGE_CONTENT');
  }

  // Fetch fresh content from DOM right now (returns a promise)
  function refreshPageContent() {
    return new Promise((resolve) => {
      const handler = (event) => {
        const msg = event.data;
        if (msg && msg.type === 'PAGE_CONTENT') {
          window.removeEventListener('message', handler);
          pageMeta = msg.payload.meta;
          pageContent = msg.payload.content;
          updatePageInfo();
          resolve(pageContent);
        }
      };
      window.addEventListener('message', handler);
      sendToContent('REQUEST_PAGE_CONTENT');
      // Timeout fallback
      setTimeout(() => {
        window.removeEventListener('message', handler);
        resolve(pageContent);
      }, 3000);
    });
  }

  // --- Tabs ---

  function setupTabs() {
    $$('.tab').forEach((tab) => {
      tab.addEventListener('click', () => {
        if (tab.classList.contains('disabled')) return;
        $$('.tab').forEach((t) => t.classList.remove('active'));
        $$('.tab-content').forEach((c) => c.classList.remove('active'));
        tab.classList.add('active');
        $(`#tab-${tab.dataset.tab}`).classList.add('active');
      });
    });

    $('#btn-close').addEventListener('click', () => {
      sendToContent('CLOSE_SIDEBAR');
    });
  }

  // --- Page Info ---

  let editEnabled = false;

  function updatePageInfo() {
    if (!pageMeta) return;

    const spaceTag = pageMeta.spaceKey ? ` <span class="space-tag">${escapeHtml(pageMeta.spaceKey)}</span>` : '';
    const infoHtml = `<span class="page-title">${escapeHtml(pageMeta.title || 'Unknown')}</span>${spaceTag}`;
    $('#page-info').innerHTML = infoHtml;
    $('#edit-page-info').innerHTML = infoHtml;

    if (!pageContent) {
      $('#page-info').innerHTML += '<br><em style="color:#ef4444">Could not extract page content</em>';
    }

    checkEditPermission();
    setStatus('Ready');
  }

  async function checkEditPermission() {
    try {
      const resp = await callBackground('GET_SETTINGS', {});
      const allowedSpaces = (resp.editableSpaces || '').split(',').map(s => s.trim().toUpperCase()).filter(Boolean);
      const currentSpace = (pageMeta.spaceKey || '').toUpperCase();
      editEnabled = allowedSpaces.length === 0 || allowedSpaces.includes(currentSpace);
    } catch {
      editEnabled = false;
    }

    const editTab = $('[data-tab="edit"]');
    const editControls = $('#tab-edit .input-group');
    if (editEnabled) {
      editTab.classList.remove('disabled');
      editTab.title = '';
      if (editControls) editControls.style.display = '';
      $('#edit-page-info').innerHTML = $('#page-info').innerHTML;
    } else {
      editTab.classList.add('disabled');
      editTab.title = `Edit disabled — space "${pageMeta.spaceKey}" not in whitelist`;
      if (editControls) editControls.style.display = 'none';
      $('#edit-page-info').innerHTML = `<span class="edit-blocked">Edit disabled for space "${escapeHtml(pageMeta.spaceKey || '?')}"</span><br><em style="color:#888">Allowed spaces can be configured in extension settings</em>`;
    }
  }

  // --- Summary Tab ---

  function setupSummaryTab() {
    $('#btn-summarize').addEventListener('click', handleSummarize);
  }

  async function handleSummarize() {
    const btn = $('#btn-summarize');
    const resultEl = $('#summary-result');

    btn.disabled = true;
    resultEl.className = 'result-area loading';
    resultEl.innerHTML = '<span class="spinner"></span> Fetching page content...';

    // Always fetch fresh content from DOM
    await refreshPageContent();

    if (!pageContent) {
      showError('summary-result', 'Could not extract page content');
      btn.disabled = false;
      return;
    }
    resultEl.className = 'result-area loading';
    resultEl.innerHTML = '<span class="spinner"></span> Analyzing page...';
    setStatus('Summarizing...');

    try {
      const response = await callBackground('SUMMARIZE', {
        title: pageMeta.title,
        text: pageContent.text,
      });

      resultEl.className = 'result-area';
      resultEl.innerHTML = formatMarkdown(response.summary);
      setStatus('Summary complete');
    } catch (err) {
      showError('summary-result', err.message);
      setStatus('Error');
    } finally {
      btn.disabled = false;
    }
  }

  // --- Edit Tab ---

  function setupEditTab() {
    $('#btn-suggest-edits').addEventListener('click', handleSuggestEdits);
    $('#btn-yes-all').addEventListener('click', () => bulkAction('accepted'));
    $('#btn-reject-all').addEventListener('click', () => bulkAction('rejected'));
    $('#btn-always').addEventListener('click', handleAlways);
    $('#btn-confirm').addEventListener('click', handleSaveToConfluence);
    $('#btn-cancel-edits').addEventListener('click', handleCancelEdits);

    // Ctrl+Enter to submit
    $('#edit-instruction').addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
        handleSuggestEdits();
      }
    });
  }

  async function handleSuggestEdits() {
    const instruction = $('#edit-instruction').value.trim();
    if (!instruction) {
      alert('Please enter edit instructions.');
      return;
    }

    const btn = $('#btn-suggest-edits');
    const diffArea = $('#diff-area');

    btn.disabled = true;
    $('#edit-instruction').disabled = true;
    diffArea.innerHTML = '<div class="result-area loading"><span class="spinner"></span> Fetching latest page content...</div>';
    $('#bulk-actions').classList.add('hidden');
    $('#apply-area').classList.add('hidden');
    setStatus('Fetching page content...');

    // Always fetch fresh content from DOM
    await refreshPageContent();

    if (!pageContent) {
      showError('diff-area', 'Could not extract page content');
      btn.disabled = false;
      return;
    }

    diffArea.innerHTML = '<div class="result-area loading"><span class="spinner"></span> Analyzing page and generating suggestions...</div>';
    setStatus('Generating edit suggestions...');

    try {
      const response = await callBackground('SUGGEST_EDITS', {
        title: pageMeta.title,
        text: pageContent.text,
        html: pageContent.html,
        instruction: instruction,
      });

      editSession.changes = response.changes;
      editSession.decisions = {};
      editSession.autoApply = false;

      renderDiffs();
      setStatus(`${response.changes.length} change(s) suggested`);

      // Auto-show inline diff on page
      sendToContent('PREVIEW_CHANGES', {
        changes: response.changes.map((c) => ({ id: c.id, before: c.before, after: c.after })),
      });

      // Scroll to first card
      setTimeout(() => {
        const first = diffArea.querySelector('.diff-card');
        if (first) first.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }, 100);
    } catch (err) {
      diffArea.innerHTML = '';
      showError('diff-area', err.message);
      setStatus('Error');
    } finally {
      btn.disabled = false;
      $('#edit-instruction').disabled = false;
    }
  }

  // --- Diff Rendering ---

  // Track which card is currently expanded
  let focusedChangeId = null;

  function renderDiffs() {
    const diffArea = $('#diff-area');
    diffArea.innerHTML = '';

    if (editSession.changes.length === 0) {
      diffArea.innerHTML = '<div class="result-area">No changes suggested.</div>';
      return;
    }

    // Auto-focus first pending card
    if (!focusedChangeId || editSession.decisions[focusedChangeId]) {
      const firstPending = editSession.changes.find(c => !editSession.decisions[c.id]);
      focusedChangeId = firstPending ? firstPending.id : null;
    }

    editSession.changes.forEach((change, index) => {
      const decision = editSession.decisions[change.id] || 'pending';
      const isExpanded = change.id === focusedChangeId;
      const card = createDiffCard(change, index, decision, isExpanded);
      diffArea.appendChild(card);
    });

    updateBulkActions();

    // Scroll focused card into view
    if (focusedChangeId) {
      const focusedCard = diffArea.querySelector(`[data-change-id="${focusedChangeId}"]`);
      if (focusedCard) {
        setTimeout(() => focusedCard.scrollIntoView({ behavior: 'smooth', block: 'center' }), 50);
      }
    }
  }

  function createDiffCard(change, index, decision, isExpanded) {
    const card = document.createElement('div');
    card.className = `diff-card ${decision} ${isExpanded ? 'expanded' : 'collapsed'}`;
    card.dataset.changeId = change.id;

    // Header (always visible, clickable to toggle)
    const header = document.createElement('div');
    header.className = 'diff-card-header';
    header.innerHTML = `
      <span class="diff-card-title">${index + 1}/${editSession.changes.length}: ${escapeHtml(change.section || 'Change')}</span>
      <span class="diff-card-badge ${decision}">${decision}</span>
    `;

    // Click header to expand/collapse
    header.addEventListener('click', () => {
      focusedChangeId = (focusedChangeId === change.id) ? null : change.id;
      renderDiffs();
    });

    // Description (always visible)
    const desc = document.createElement('div');
    desc.className = 'diff-card-desc';
    desc.textContent = change.description || '';

    card.appendChild(header);
    card.appendChild(desc);

    // Body + Actions only when expanded
    if (isExpanded) {
      const body = document.createElement('div');
      body.className = 'diff-card-body';

      const sideBySide = DiffEngine.renderSideBySide(change.before, change.after);
      body.innerHTML = sideBySide.beforeHtml + sideBySide.afterHtml;

      const inlineDiff = document.createElement('div');
      inlineDiff.className = 'diff-inline';
      inlineDiff.innerHTML = DiffEngine.renderDiff(change.before, change.after);
      body.appendChild(inlineDiff);

      const actions = document.createElement('div');
      actions.className = 'diff-card-actions';
      if (decision === 'pending') {
        actions.innerHTML = `
          <button class="btn-approve" data-action="accept" data-id="${change.id}">Accept</button>
          <button class="btn-reject" data-action="reject" data-id="${change.id}">Reject</button>
        `;
      } else {
        actions.innerHTML = `
          <button class="btn-skip" data-action="undo" data-id="${change.id}">Undo</button>
        `;
      }

      actions.addEventListener('click', (e) => {
        const action = e.target.dataset.action;
        const id = e.target.dataset.id;
        if (!action || !id) return;

        let decision;
        if (action === 'accept') {
          editSession.decisions[id] = 'accepted';
          decision = 'accepted';
        } else if (action === 'reject') {
          editSession.decisions[id] = 'rejected';
          decision = 'rejected';
        } else if (action === 'undo') {
          delete editSession.decisions[id];
          decision = 'pending';
        }

        // Sync to inline diff on page
        sendToContent('SYNC_DECISION', { changeId: id, decision });

        // Auto-advance to next pending
        const currentIdx = editSession.changes.findIndex(c => c.id === id);
        const nextPending = editSession.changes.find((c, i) => i > currentIdx && !editSession.decisions[c.id]);
        focusedChangeId = nextPending ? nextPending.id : null;

        renderDiffs();
      });

      card.appendChild(body);
      card.appendChild(actions);
    }

    return card;
  }

  function updateBulkActions() {
    const pending = editSession.changes.filter((c) => !editSession.decisions[c.id]);
    const accepted = editSession.changes.filter((c) => editSession.decisions[c.id] === 'accepted');
    const rejected = editSession.changes.filter((c) => editSession.decisions[c.id] === 'rejected');

    const bulkEl = $('#bulk-actions');
    const applyEl = $('#apply-area');

    if (editSession.changes.length > 0) {
      bulkEl.classList.remove('hidden');
      $('#diff-stats').textContent = `${accepted.length} accepted / ${rejected.length} rejected / ${pending.length} pending`;
    }

    // Show confirm/cancel when at least one accepted
    if (accepted.length > 0) {
      applyEl.classList.remove('hidden');
      $('#btn-confirm').textContent = `Save ${accepted.length} Change(s) to Confluence`;
      $('#apply-result').innerHTML = '';
    } else {
      applyEl.classList.add('hidden');
    }

    // Sync counts to page floating bar
    sendToContent('UPDATE_COUNTS', {
      total: editSession.changes.length,
      accepted: accepted.length,
      rejected: rejected.length,
      pending: pending.length,
    });
  }

  function bulkAction(decision) {
    editSession.changes.forEach((change) => {
      if (!editSession.decisions[change.id]) {
        editSession.decisions[change.id] = decision;
        sendToContent('SYNC_DECISION', { changeId: change.id, decision });
      }
    });
    focusedChangeId = null;
    renderDiffs();
  }

  function handleAlways() {
    editSession.autoApply = true;
    bulkAction('accepted');
  }

  function handleCancelEdits() {
    sendToContent('CLEAR_PREVIEW');
    sendToContent('HIDE_FLOATING_BAR');
    editSession = { changes: [], decisions: {}, autoApply: false };
    focusedChangeId = null;
    $('#diff-area').innerHTML = '';
    $('#bulk-actions').classList.add('hidden');
    $('#apply-area').classList.add('hidden');
    $('#apply-result').innerHTML = '';
    setStatus('Edits cancelled');
  }

  // --- Save to Confluence ---

  async function handleSaveToConfluence() {
    const accepted = editSession.changes.filter((c) => editSession.decisions[c.id] === 'accepted');
    if (accepted.length === 0) return;

    const btn = $('#btn-confirm');
    const resultEl = $('#apply-result');
    btn.disabled = true;
    resultEl.className = 'result-area loading';
    resultEl.innerHTML = '<span class="spinner"></span> Saving to Confluence...';
    setStatus('Saving to Confluence...');

    try {
      const response = await callBackground('APPLY_EDITS', {
        pageId: pageMeta.pageId,
        confluenceUrl: pageMeta.confluenceBaseUrl,
        changes: accepted.map((c) => ({ before: c.before, after: c.after, description: c.description })),
      });

      // Clear preview after successful save
      sendToContent('CLEAR_PREVIEW');

      resultEl.className = 'result-area';
      let msg = `${response.applied} change(s) saved! (v${response.oldVersion} → v${response.newVersion})`;
      if (response.failed > 0) {
        msg += `<br><em style="color:#f59e0b">${response.failed} change(s) could not be matched in HTML</em>`;
      }
      msg += `<br><br><a href="#" onclick="location.reload(); return false;">Reload page</a> to see changes.`;
      msg += `<br><em style="color:#888">Rollback: Confluence page history → restore v${response.oldVersion}</em>`;
      resultEl.innerHTML = msg;
      setStatus(`Saved (v${response.oldVersion} → v${response.newVersion})`);

      // Hide buttons after save, clear inline preview
      sendToContent('HIDE_FLOATING_BAR');
      $('#btn-confirm').classList.add('hidden');
      $('#btn-cancel-edits').classList.add('hidden');

      setTimeout(() => resultEl.scrollIntoView({ behavior: 'smooth', block: 'end' }), 100);

    } catch (err) {
      resultEl.className = 'result-area error';
      resultEl.textContent = `Error: ${err.message}`;
      setStatus('Save failed');
      setTimeout(() => resultEl.scrollIntoView({ behavior: 'smooth', block: 'end' }), 100);
    } finally {
      btn.disabled = false;
    }
  }

  // --- Utilities ---

  function setStatus(text) {
    $('#status-text').textContent = text;
  }

  function showError(containerId, message) {
    const el = $(`#${containerId}`);
    el.className = 'result-area error';
    el.textContent = `Error: ${message}`;
  }

  function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }

  function formatMarkdown(text) {
    // Simple markdown formatting for display
    return text
      .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
      .replace(/\*(.+?)\*/g, '<em>$1</em>')
      .replace(/^### (.+)$/gm, '<h4>$1</h4>')
      .replace(/^## (.+)$/gm, '<h3>$1</h3>')
      .replace(/^# (.+)$/gm, '<h2>$1</h2>')
      .replace(/^- (.+)$/gm, '<li>$1</li>')
      .replace(/(<li>.*<\/li>)/gs, '<ul>$1</ul>')
      .replace(/<\/ul>\s*<ul>/g, '')
      .replace(/\n/g, '<br>');
  }

  function resetEditSession() {
    editSession = { changes: [], decisions: {}, autoApply: false };
    $('#diff-area').innerHTML = '';
    $('#bulk-actions').classList.add('hidden');
    $('#apply-area').classList.add('hidden');
    $('#edit-instruction').value = '';
    $('#summary-result').innerHTML = '';
    $('#summary-result').className = 'result-area';
    setStatus('Page changed — ready');
  }

  function setupStatusBar() {
    // Show API mode in status bar
    // We can't directly access chrome.storage from iframe, but we get it from background
    $('#status-mode').textContent = 'Loading...';
    // Will be updated when we get settings info
    callBackground('PING', {}).then(() => {
      $('#status-mode').textContent = 'Connected';
    }).catch(() => {
      $('#status-mode').textContent = 'Disconnected';
    });
  }

  // --- Start ---
  document.addEventListener('DOMContentLoaded', init);
})();
