// sidebar.js - Conversational UI for Project K Chrome Extension
// Replaces the old tab-based UI with a chat interface

(function () {
  'use strict';

  // --- State ---
  let pageMeta = null;
  let pageContent = null;
  let messages = [];        // { role: 'user'|'assistant'|'system', content, type?, changes?, reviewData? }
  let chatState = 'IDLE';   // IDLE | PROCESSING | CHANGES_PENDING | APPLYING
  let pendingChanges = [];  // changes[] waiting for user approval
  let editSession = { changes: [], decisions: {}, autoApply: false };
  let editEnabled = false;
  let pendingRequests = {};
  let requestCounter = 0;

  // --- DOM refs ---
  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => document.querySelectorAll(sel);

  // --- Init ---
  function init() {
    setupInput();
    setupPresets();
    setupClose();
    setupDelegation();
    requestPageContent();
    setupStatusBar();
  }

  // --- Event Delegation (MV3 CSP blocks inline onclick) ---
  function setupDelegation() {
    $('#chat-messages').addEventListener('click', (e) => {
      const btn = e.target.closest('[data-action]');
      if (!btn) return;
      const action = btn.dataset.action;
      const id = btn.dataset.id;

      switch (action) {
        case 'fix-from-review': window._fixFromReview(); break;
        case 'copy-review': window._copyReview(); break;
        case 'comment-review': window._commentReview(); break;
        case 'vision-debug': {
          const panel = document.getElementById('vision-debug-panel');
          if (panel) panel.style.display = panel.style.display === 'none' ? 'block' : 'none';
          break;
        }
        case 'ri-feedback': window._riFeedback(id, btn.dataset.status); break;
        case 'focus-change': sendToContent('FOCUS_CHANGE', { changeId: id }); break;
        case 'accept-change': window._acceptChange(id); break;
        case 'reject-change': window._rejectChange(id); break;
        case 'undo-change': window._undoChange(id); break;
        case 'accept-all': window._acceptAll(); break;
        case 'reject-all': window._rejectAll(); break;
      }
    });
  }

  // --- Communication with content script ---

  function sendToContent(type, payload) {
    window.parent.postMessage({ type, payload }, '*');
  }

  function callBackground(action, payload) {
    return new Promise((resolve, reject) => {
      const requestId = `req-${++requestCounter}`;
      pendingRequests[requestId] = { resolve, reject };
      window.parent.postMessage({
        type: 'CALL_BACKGROUND',
        requestId,
        payload: { action, payload },
      }, '*');
      setTimeout(() => {
        if (pendingRequests[requestId]) {
          delete pendingRequests[requestId];
          reject(new Error('Request timed out (300s)'));
        }
      }, 300000);
    });
  }

  window.addEventListener('message', (event) => {
    const msg = event.data;
    if (!msg || !msg.type) return;

    switch (msg.type) {
      case 'PAGE_CONTENT': {
        const isNewPage = pageMeta && msg.payload.meta && pageMeta.pageId !== msg.payload.meta.pageId;
        pageMeta = msg.payload.meta;
        pageContent = msg.payload.content;
        updatePageContext();
        if (isNewPage) resetChat();
        break;
      }
      case 'PREVIEW_RESULT': {
        const matched = new Set(msg.payload.orderedIds || []);
        // Track which changes matched on the page
        editSession.unmatchedIds = new Set();
        editSession.changes.forEach(c => {
          if (!matched.has(c.id)) editSession.unmatchedIds.add(c.id);
        });
        // Reorder changes to match page DOM order
        if (msg.payload.orderedIds && editSession.changes.length > 0) {
          const orderMap = {};
          msg.payload.orderedIds.forEach((id, i) => { orderMap[id] = i; });
          editSession.changes.sort((a, b) => {
            const oa = orderMap[a.id] != null ? orderMap[a.id] : 9999;
            const ob = orderMap[b.id] != null ? orderMap[b.id] : 9999;
            return oa - ob;
          });
          const changesMsg = messages.find(m => m.type === 'changes');
          if (changesMsg) {
            changesMsg.changes = editSession.changes;
            updateChangesCard();
          }
        }
        // Show match stats
        if (editSession.unmatchedIds.size > 0) {
          addMessage({ role: 'system', content: `⚠️ ${msg.payload.applied}/${msg.payload.total}건만 페이지에서 매칭됨. ${editSession.unmatchedIds.size}건은 원문 불일치로 프리뷰 불가.` });
        }
        break;
      }
      case 'INLINE_DECISION':
        if (msg.payload.decision === 'pending') {
          delete editSession.decisions[msg.payload.changeId];
        } else {
          editSession.decisions[msg.payload.changeId] = msg.payload.decision;
        }
        updateChangesCard();
        break;
      case 'FLOATING_CONFIRM':
        handleApplyAccepted();
        break;
      case 'FLOATING_CANCEL':
        handleCancelEdits();
        break;
      case 'BACKGROUND_RESPONSE': {
        const req = pendingRequests[msg.payload.requestId];
        if (req) {
          delete pendingRequests[msg.payload.requestId];
          const resp = msg.payload.response;
          if (resp && resp.error) req.reject(new Error(resp.error));
          else req.resolve(resp);
        }
        break;
      }
      case 'REVIEW_STATUS': {
        const statusMsg = msg.payload?.message || '';
        if (statusMsg) {
          setStatus(statusMsg);
          const loadingEl = document.querySelector('.loading-dots') || document.querySelector('.review-progress');
          if (loadingEl) {
            loadingEl.closest('.chat-msg').innerHTML = `<div class="review-progress">${escapeHtml(statusMsg)}</div>`;
          }
        }
        break;
      }
      case 'PARTIAL_REVIEW': {
        // 섹션별 중간 결과 — 리뷰 카드를 점진적으로 렌더링
        try {
          const partialData = typeof msg.payload.data === 'string' ? JSON.parse(msg.payload.data) : msg.payload.data;
          latestReviewData = partialData;
          reviewFeedback = {};

          // 로딩 메시지를 리뷰 카드로 교체
          const progressEl = document.querySelector('.review-progress');
          if (progressEl) {
            const cardEl = progressEl.closest('.chat-msg');
            if (cardEl) {
              cardEl.innerHTML = renderReviewCard(partialData);
              scrollToMessage(cardEl.id);
            }
          } else {
            // 이미 리뷰 카드가 있으면 업데이트
            const existingCard = document.getElementById('review-card');
            if (existingCard) {
              existingCard.closest('.chat-msg').innerHTML = renderReviewCard(partialData);
            }
          }
        } catch (e) { /* ignore parse errors */ }
        break;
      }
    }
  });

  function requestPageContent() {
    sendToContent('REQUEST_PAGE_CONTENT');
  }

  function refreshPageContent() {
    return new Promise((resolve) => {
      const handler = (event) => {
        const msg = event.data;
        if (msg && msg.type === 'PAGE_CONTENT') {
          window.removeEventListener('message', handler);
          pageMeta = msg.payload.meta;
          pageContent = msg.payload.content;
          updatePageContext();
          resolve(pageContent);
        }
      };
      window.addEventListener('message', handler);
      sendToContent('REQUEST_PAGE_CONTENT');
      setTimeout(() => { window.removeEventListener('message', handler); resolve(pageContent); }, 3000);
    });
  }

  // --- Page Context ---

  function updatePageContext() {
    if (!pageMeta) return;
    const ctx = $('#page-context');
    ctx.textContent = pageMeta.title || '';
    ctx.title = pageMeta.title || '';

    const desc = $('#welcome-desc');
    if (desc) {
      desc.textContent = pageContent
        ? `"${pageMeta.title}" 페이지에 대해 질문하거나 리뷰를 요청하세요.`
        : '페이지 내용을 추출할 수 없습니다.';
    }

    checkEditPermission();
    updateApiIndicator();
    setStatus('Ready');
  }

  async function updateApiIndicator() {
    try {
      const settings = await callBackground('GET_SETTINGS', {});
      const modeEl = $('#status-mode');
      if (!modeEl) return;
      const backendUrl = settings.backendUrl || '';
      if (backendUrl) {
        // Show short host
        try {
          const url = new URL(backendUrl);
          modeEl.textContent = url.host;
          modeEl.title = backendUrl;
          modeEl.style.color = '';
        } catch {
          modeEl.textContent = backendUrl.slice(0, 30);
          modeEl.title = backendUrl;
        }
      } else {
        modeEl.textContent = 'Direct (no backend)';
        modeEl.title = '백엔드 미설정 — 리뷰 시 Claude 직접 호출';
        modeEl.style.color = 'var(--warning-text, #f59e0b)';
      }
    } catch { /* ignore */ }
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
  }

  // --- Input ---

  function setupInput() {
    const input = $('#chat-input');
    const sendBtn = $('#btn-send');

    input.addEventListener('input', () => {
      sendBtn.disabled = !input.value.trim() || chatState === 'PROCESSING';
      autoResize(input);
    });

    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        if (input.value.trim() && chatState !== 'PROCESSING') handleSend();
      }
    });

    sendBtn.addEventListener('click', () => {
      if (input.value.trim() && chatState !== 'PROCESSING') handleSend();
    });
  }

  function autoResize(el) {
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 120) + 'px';
  }

  // --- Presets ---

  function setupPresets() {
    $$('.preset-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const text = btn.dataset.preset;
        $('#chat-input').value = text;
        handleSend();
      });
    });
  }

  function setupClose() {
    $('#btn-close').addEventListener('click', () => sendToContent('CLOSE_SIDEBAR'));
  }

  // --- Send Message ---

  async function handleSend() {
    const input = $('#chat-input');
    const text = input.value.trim();
    if (!text) return;

    input.value = '';
    input.style.height = 'auto';
    $('#btn-send').disabled = true;

    // Hide welcome
    const welcome = $('#welcome');
    if (welcome) welcome.style.display = 'none';

    // Add user message
    addMessage({ role: 'user', content: text });

    // Determine intent
    const intent = classifyIntent(text);
    await handleIntent(intent, text);
  }

  // --- Intent Classification ---

  function classifyIntent(text) {
    const lower = text.toLowerCase().trim();

    // State-based: if we have pending changes and user responds
    if (chatState === 'CHANGES_PENDING') {
      if (/^(응|네|예|적용|ㅇㅇ|yes|ok|확인|반영|저장)/.test(lower)) return 'CONFIRM_CHANGES';
      if (/^(아니|no|취소|안|다시|수정|말고)/.test(lower)) return 'REJECT_CHANGES';
    }

    // Keyword matching
    if (/요약|summarize|summary|정리해/.test(lower)) return 'SUMMARIZE';
    if (/이미지\s*리뷰|이미지\s*포함.*리뷰|리뷰.*이미지|vision.*review|review.*vision/.test(lower)) return 'REVIEW_VISION';
    if (/리뷰|검토|review|점검|진단/.test(lower)) return 'REVIEW';
    if (/초안|완성|보강|draft|같이.*작성|작성.*같이/.test(lower)) return 'DRAFT_ASSIST';
    if (/수정|고쳐|edit|바꿔|변경|추가해|삭제해|제거해/.test(lower)) return 'SUGGEST_EDITS';

    return 'CHAT';
  }

  // --- Intent Handlers ---

  async function handleIntent(intent, text) {
    chatState = 'PROCESSING';
    setStatus('분석 중...');

    // Show loading
    const loadingId = addMessage({ role: 'assistant', content: '', type: 'loading' });

    try {
      await refreshPageContent();
      if (!pageContent) {
        removeMessage(loadingId);
        addMessage({ role: 'system', content: '페이지 내용을 추출할 수 없습니다.' });
        chatState = 'IDLE';
        setStatus('Ready');
        return;
      }

      switch (intent) {
        case 'SUMMARIZE':
          await handleSummarize(loadingId);
          break;
        case 'REVIEW':
          await handleReview(loadingId);
          break;
        case 'REVIEW_VISION':
          await handleReviewVision(loadingId);
          break;
        case 'DRAFT_ASSIST':
          await handleDraftAssist(loadingId, text);
          break;
        case 'SUGGEST_EDITS':
          await handleSuggestEdits(loadingId, text);
          break;
        case 'CONFIRM_CHANGES':
          removeMessage(loadingId);
          await handleApplyAccepted();
          break;
        case 'REJECT_CHANGES':
          removeMessage(loadingId);
          handleCancelEdits();
          addMessage({ role: 'assistant', content: '수정을 취소했습니다. 다른 방향으로 수정할까요?' });
          break;
        case 'CHAT':
          await handleChat(loadingId, text);
          break;
      }
    } catch (err) {
      removeMessage(loadingId);
      addMessage({ role: 'system', content: `오류: ${err.message}` });
      setStatus('Error');
    }

    if (chatState === 'PROCESSING') chatState = 'IDLE';
    if (chatState === 'IDLE') setStatus('Ready');
  }

  async function handleSummarize(loadingId) {
    const response = await callBackground('SUMMARIZE', {
      title: pageMeta.title,
      text: pageContent.text,
    });
    removeMessage(loadingId);
    addMessage({ role: 'assistant', content: response.summary });
    setStatus('요약 완료');
  }

  async function handleReview(loadingId) {
    const response = await callBackground('REVIEW', {
      title: pageMeta.title,
      text: pageContent.text,
    });

    // 최종 결과 파싱
    let reviewData;
    try {
      const cleaned = response.review.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
      const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
      if (jsonMatch) reviewData = JSON.parse(jsonMatch[0]);
    } catch { /* fall through to text display */ }

    // partial_review로 이미 렌더링되었는지 확인
    const existingCard = document.getElementById('review-card');
    if (existingCard && reviewData) {
      // 최종 결과로 업데이트
      latestReviewData = reviewData;
      reviewFeedback = {};
      existingCard.closest('.chat-msg').innerHTML = renderReviewCard(reviewData);
      // 로딩 메시지 제거
      removeMessage(loadingId);
    } else {
      removeMessage(loadingId);
      if (reviewData) {
        latestReviewData = reviewData;
        reviewFeedback = {};
        addMessage({ role: 'assistant', content: '', type: 'review', reviewData });
      } else {
        addMessage({ role: 'assistant', content: response.review });
      }
    }
    setStatus('리뷰 완료');
  }

  async function handleReviewVision(loadingId) {
    setStatus('이미지 수집 중...');

    // content.js에서 이미지 목록 요청
    const images = await new Promise((resolve) => {
      const handler = (event) => {
        if (event.data?.type === 'PAGE_IMAGES') {
          window.removeEventListener('message', handler);
          resolve(event.data.payload?.images || []);
        }
      };
      window.addEventListener('message', handler);
      setTimeout(() => { window.removeEventListener('message', handler); resolve([]); }, 5000);
      window.parent.postMessage({ type: 'REQUEST_PAGE_IMAGES' }, '*');
    });

    if (images.length === 0) {
      removeMessage(loadingId);
      addMessage({ role: 'system', content: '이 페이지에 분석할 이미지가 없습니다. (아이콘/이모지 제외)' });
      setStatus('Ready');
      return;
    }

    setStatus(`이미지 ${images.length}개 분석 중... (Vision API, 최대 10개)`);
    const response = await callBackground('REVIEW_VISION', {
      title: pageMeta.title,
      text: pageContent.text,
      images: images,
    });
    removeMessage(loadingId);

    const results = response.images || [];
    const success = results.filter(r => r.analysis);
    const failed = results.filter(r => r.error);

    addMessage({ role: 'assistant', content: '', type: 'vision_review', visionResults: results });
    setStatus(`이미지 분석 완료 (${success.length}/${results.length}개 성공)`);
  }

  async function handleDraftAssist(loadingId, text) {
    const response = await callBackground('DRAFT_ASSIST', {
      title: pageMeta.title,
      text: pageContent.text,
      instruction: text,
      history: getRecentHistory(),
    });
    removeMessage(loadingId);
    addMessage({ role: 'assistant', content: response.answer });
    setStatus('분석 완료');
  }

  async function handleSuggestEdits(loadingId, text) {
    if (!editEnabled) {
      removeMessage(loadingId);
      addMessage({ role: 'system', content: `이 스페이스(${pageMeta.spaceKey})에서는 수정이 비활성화되어 있습니다. 설정에서 허용된 스페이스를 확인하세요.` });
      return;
    }

    // Enrich instruction with review context if available
    let instruction = text;
    if (latestReviewData && /수정|고쳐|fix|edit|리뷰.*바탕|리뷰.*수정/.test(text.toLowerCase())) {
      const reviewItems = [];
      if (latestReviewData.issues) latestReviewData.issues.forEach(i => reviewItems.push(`[보강 필요] ${_itemText(i)}`));
      if (latestReviewData.verifications) latestReviewData.verifications.forEach(i => reviewItems.push(`[검증 필요] ${_itemText(i)}`));
      if (latestReviewData.suggestions) latestReviewData.suggestions.forEach(i => reviewItems.push(`[제안] ${_itemText(i)}`));
      if (reviewItems.length > 0) {
        instruction = `${text}\n\n이전 AI 리뷰에서 발견한 항목들 (이 항목들을 모두 반영하여 수정해주세요):\n${reviewItems.join('\n')}`;
      }
    }

    // Count expected changes from instruction to pass as hint
    const lineCount = (instruction.match(/^\d+\./gm) || []).length;
    const maxChanges = lineCount > 0 ? Math.min(lineCount, 25) : 10;

    const response = await callBackground('SUGGEST_EDITS', {
      title: pageMeta.title,
      text: pageContent.text,
      html: pageContent.html,
      instruction,
      maxChanges,
    });

    removeMessage(loadingId);

    if (!response.changes || response.changes.length === 0) {
      addMessage({ role: 'assistant', content: '수정할 부분을 찾지 못했습니다.' });
      return;
    }

    // Store changes
    editSession.changes = response.changes;
    editSession.decisions = {};
    pendingChanges = response.changes;
    chatState = 'CHANGES_PENDING';

    addMessage({
      role: 'assistant',
      content: `${response.changes.length}건의 수정을 제안합니다.`,
      type: 'changes',
      changes: response.changes,
    });

    // Show inline preview on page
    sendToContent('PREVIEW_CHANGES', {
      changes: response.changes.map(c => ({ id: c.id, before: c.before, after: c.after })),
    });

    setStatus(`${response.changes.length}건 수정 제안`);
  }

  async function handleChat(loadingId, text) {
    // Use QnA backend for free-form questions
    try {
      const response = await callBackground('CHAT', {
        title: pageMeta.title,
        text: pageContent.text.slice(0, 30000),
        question: text,
        history: getRecentHistory(),
      });
      removeMessage(loadingId);
      addMessage({ role: 'assistant', content: response.answer });
    } catch (err) {
      // Fallback: direct LLM call with page context
      try {
        const response = await callBackground('CHAT_DIRECT', {
          title: pageMeta.title,
          text: pageContent.text,
          question: text,
          history: getRecentHistory(),
        });
        removeMessage(loadingId);
        addMessage({ role: 'assistant', content: response.answer });
      } catch (err2) {
        removeMessage(loadingId);
        throw err2;
      }
    }
    setStatus('Ready');
  }

  // --- Apply Changes ---

  async function handleApplyAccepted() {
    const accepted = editSession.changes.filter(c =>
      editSession.decisions[c.id] === 'accepted' || !editSession.decisions[c.id]
    );
    if (accepted.length === 0) {
      addMessage({ role: 'system', content: '적용할 변경사항이 없습니다.' });
      chatState = 'IDLE';
      return;
    }

    chatState = 'APPLYING';
    setStatus('Confluence에 저장 중...');
    addMessage({ role: 'system', content: '⏳ Confluence에 저장 중...' });

    try {
      const response = await callBackground('APPLY_EDITS', {
        pageId: pageMeta.pageId,
        confluenceUrl: pageMeta.confluenceBaseUrl,
        changes: accepted.map(c => ({ before: c.before, after: c.after, description: c.description })),
      });

      sendToContent('CLEAR_PREVIEW');
      sendToContent('HIDE_FLOATING_BAR');

      let msg = `✅ ${response.applied}건 저장 완료! (v${response.oldVersion} → v${response.newVersion})`;
      if (response.failed > 0) {
        msg += `\n⚠️ ${response.failed}건은 매칭 실패`;
      }
      addMessage({ role: 'system', content: msg });
      setStatus(`저장 완료 (v${response.newVersion})`);
    } catch (err) {
      addMessage({ role: 'system', content: `❌ 저장 실패: ${err.message}` });
      setStatus('저장 실패');
    }

    editSession = { changes: [], decisions: {}, autoApply: false };
    pendingChanges = [];
    chatState = 'IDLE';
  }

  function handleCancelEdits() {
    sendToContent('CLEAR_PREVIEW');
    sendToContent('HIDE_FLOATING_BAR');
    editSession = { changes: [], decisions: {}, autoApply: false };
    pendingChanges = [];
    chatState = 'IDLE';
    setStatus('Ready');
  }

  // --- Message Rendering ---

  let messageCounter = 0;

  function addMessage(msg) {
    const id = `msg-${++messageCounter}`;
    msg.id = id;
    messages.push(msg);
    renderMessage(msg);
    // Large responses (review, changes): scroll to start of the message
    // Small responses: scroll to bottom
    if (msg.type === 'review' || msg.type === 'changes' || msg.type === 'vision_review') {
      scrollToMessage(id);
    } else {
      scrollToBottom();
    }
    return id;
  }

  function removeMessage(id) {
    messages = messages.filter(m => m.id !== id);
    const el = document.getElementById(id);
    if (el) el.remove();
  }

  function renderMessage(msg) {
    const container = $('#chat-messages');
    const el = document.createElement('div');
    el.id = msg.id;
    el.className = `chat-msg ${msg.role}`;

    if (msg.type === 'loading') {
      el.innerHTML = '<div class="loading-dots"><span></span><span></span><span></span></div>';
    } else if (msg.type === 'review' && msg.reviewData) {
      el.innerHTML = renderReviewCard(msg.reviewData);
    } else if (msg.type === 'vision_review' && msg.visionResults) {
      el.innerHTML = renderVisionReviewCard(msg.visionResults);
    } else if (msg.type === 'changes' && msg.changes) {
      el.innerHTML = renderChangesCard(msg.changes);
    } else if (msg.role === 'system') {
      el.innerHTML = `<div class="system-msg">${escapeHtml(msg.content)}</div>`;
    } else if (msg.role === 'user') {
      el.innerHTML = `<div class="user-bubble">${escapeHtml(msg.content)}</div>`;
    } else {
      el.innerHTML = `<div class="assistant-bubble">${formatMarkdown(msg.content)}</div>`;
    }

    container.appendChild(el);
  }

  let reviewItemCounter = 0;

  function renderReviewCard(data) {
    reviewItemCounter = 0;
    let html = '<div class="review-card" id="review-card">';

    // Score
    if (data.score != null) {
      const pct = Math.max(0, Math.min(100, data.score));
      html += `<div class="review-score">
        <span class="review-score-label">전체 평가</span>
        <div class="review-score-bar"><div class="review-score-fill" style="width:${pct}%"></div></div>
        <span class="review-score-num">${data.score}/100</span>
      </div>`;
    }

    // Actionable sections (issues, verifications, suggestions) — with feedback buttons
    if (data.issues && data.issues.length > 0) {
      html += '<div class="review-section warning">';
      html += `<div class="review-section-title">⚠️ 보강 필요 (${data.issues.length}건)</div>`;
      data.issues.forEach(item => {
        const text = typeof item === 'object' ? item.text : item;
        const perspective = typeof item === 'object' ? item.perspective : null;
        html += renderReviewItem(text, 'issue', perspective);
      });
      html += '</div>';
    }

    if (data.verifications && data.verifications.length > 0) {
      html += '<div class="review-section info">';
      html += `<div class="review-section-title">🔍 검증 필요 (${data.verifications.length}건)</div>`;
      data.verifications.forEach(item => {
        const text = typeof item === 'object' ? item.text : item;
        const perspective = typeof item === 'object' ? item.perspective : null;
        html += renderReviewItem(text, 'verification', perspective);
      });
      html += '</div>';
    }

    if (data.suggestions && data.suggestions.length > 0) {
      html += '<div class="review-section suggestion">';
      html += `<div class="review-section-title">💡 제안 (${data.suggestions.length}건)</div>`;
      data.suggestions.forEach(item => {
        const text = typeof item === 'object' ? item.text : item;
        html += renderReviewItem(text, 'suggestion');
      });
      html += '</div>';
    }

    // Flow — text-based sequence diagram
    if (data.flow) {
      html += '<div class="review-section flow">';
      html += `<div class="review-section-title">🔀 로직 플로우</div>`;
      html += `<div class="review-flow-content">${escapeHtml(data.flow).replace(/\n/g, '<br>')}</div>`;
      html += '</div>';
    }

    // QA Checklist
    if (data.qa_checklist && data.qa_checklist.length > 0) {
      html += '<div class="review-section checklist">';
      html += `<div class="review-section-title">✅ QA 체크리스트 (${data.qa_checklist.length}건)</div>`;
      html += '<div class="review-checklist-items">';
      data.qa_checklist.forEach((item, i) => {
        html += `<label class="review-checklist-item"><input type="checkbox" /><span>${escapeHtml(item)}</span></label>`;
      });
      html += '</div></div>';
    }

    // Readability
    if (data.readability) {
      const rScore = data.readability.score != null ? data.readability.score : null;
      html += '<div class="review-section readability">';
      html += `<div class="review-section-title">📖 문서 가독성${rScore != null ? ` (${rScore}/100)` : ''}</div>`;
      if (rScore != null) {
        const rPct = Math.max(0, Math.min(100, rScore));
        html += `<div class="review-score" style="margin-bottom:8px">
          <div class="review-score-bar"><div class="review-score-fill" style="width:${rPct}%"></div></div>
          <span class="review-score-num">${rScore}/100</span>
        </div>`;
      }
      if (data.readability.issues && data.readability.issues.length > 0) {
        data.readability.issues.forEach(item => {
          html += `<div class="review-item">${escapeHtml(item)}</div>`;
        });
      }
      html += '</div>';
    }

    // Primary action: fix now
    html += `<div class="review-cta">`;
    html += `<button class="btn-fix-now" data-action="fix-from-review">✏️ 원본 Confluence 문서 수정안 정리</button>`;
    html += `<div class="review-cta-hint">각 항목의 👍👎 로 반영 여부를 조정할 수 있어요</div>`;
    html += `</div>`;

    // Secondary actions
    html += `<div class="review-actions">`;
    html += `<button class="btn-sm btn-copy-review" data-action="copy-review">📋 복사</button>`;
    html += `<button class="btn-sm btn-comment-review" data-action="comment-review">💬 Confluence 댓글</button>`;
    if (latestVisionDebug && latestVisionDebug.length > 0) {
      html += `<button class="btn-sm btn-vision-debug" data-action="vision-debug">🔍 Vision 디버그</button>`;
    }
    html += `</div>`;

    // Vision debug panel (hidden by default)
    if (latestVisionDebug && latestVisionDebug.length > 0) {
      html += `<div class="vision-debug-panel" id="vision-debug-panel" style="display:none">`;
      html += `<div class="review-section-title">🔍 Vision 분석 상세 (${latestVisionDebug.length}개 이미지)</div>`;
      latestVisionDebug.forEach((v, i) => {
        const status = v.error ? '❌' : '✅';
        const sizeInfo = v.width && v.height ? `${v.width}×${v.height}` : '?';
        html += `<div class="vision-debug-item">`;
        html += `<div class="vision-debug-header">${status} 이미지 ${i + 1} — ${sizeInfo} — ${v.elapsed}ms</div>`;
        html += `<div class="vision-debug-src">${escapeHtml((v.src || '').slice(0, 80))}${(v.src || '').length > 80 ? '...' : ''}</div>`;
        if (v.analysis) {
          html += `<div class="vision-debug-analysis">${escapeHtml(v.analysis)}</div>`;
        } else if (v.error) {
          html += `<div class="vision-debug-error">${escapeHtml(v.error)}</div>`;
        }
        html += `</div>`;
      });
      html += `</div>`;
    }

    html += '</div>';
    return html;
  }

  function renderVisionReviewCard(results) {
    const success = results.filter(r => r.analysis);
    const failed = results.filter(r => r.error);
    let html = '<div class="review-card" id="vision-review-card">';

    // 요약
    html += `<div class="review-score">
      <span class="review-score-label">이미지 분석</span>
      <span class="review-score-num">${success.length}/${results.length}개 완료</span>
    </div>`;

    // 각 이미지별 카드
    results.forEach((r, i) => {
      const status = r.error ? 'error' : 'success';
      const sizeInfo = r.width && r.height ? `${r.width}×${r.height}` : '';
      html += `<div class="vision-image-card ${status}">`;
      html += `<div class="vision-image-header">`;
      html += `<span class="vision-image-num">${r.error ? '❌' : '🖼️'} 이미지 ${i + 1}</span>`;
      if (sizeInfo) html += `<span class="vision-image-size">${sizeInfo}</span>`;
      html += `<span class="vision-image-time">${(r.elapsed / 1000).toFixed(1)}s</span>`;
      html += `</div>`;
      if (r.alt) html += `<div class="vision-image-alt">${escapeHtml(r.alt)}</div>`;
      if (r.context) html += `<div class="vision-image-context">📍 ${escapeHtml(r.context.slice(0, 80))}${r.context.length > 80 ? '...' : ''}</div>`;
      if (r.analysis) {
        html += `<div class="vision-image-analysis">${escapeHtml(r.analysis).replace(/\n/g, '<br>')}</div>`;
      } else if (r.error) {
        html += `<div class="vision-image-error">${escapeHtml(r.error)}</div>`;
      }
      html += `</div>`;
    });

    html += '</div>';
    return html;
  }

  function renderReviewItem(text, category, perspective) {
    const id = `ri-${reviewItemCounter++}`;
    const fb = reviewFeedback[id] || { status: 'liked', editText: '' };
    // Initialize default as liked
    if (!reviewFeedback[id]) reviewFeedback[id] = { status: 'liked', editText: '', text, category };

    const isLiked = fb.status === 'liked';
    const isDisliked = fb.status === 'disliked';
    const isEdited = fb.status === 'edited';

    const perspectiveBadge = perspective
      ? `<span class="ri-perspective ${perspective === '프로그래머' ? 'dev' : 'lead'}">${perspective}</span>`
      : '';

    let html = `<div class="review-item-outer" id="${id}">`;
    html += `<div class="review-item-wrap ${isDisliked ? 'disliked' : ''}">`;
    html += `<div class="review-item-content">${perspectiveBadge}${escapeHtml(text)}</div>`;
    html += `<div class="review-item-feedback">`;
    html += `<button class="ri-btn ${isLiked ? 'active' : ''}" data-action="ri-feedback" data-id="${id}" data-status="liked" title="좋아요">👍</button>`;
    html += `<button class="ri-btn ${isDisliked ? 'active' : ''}" data-action="ri-feedback" data-id="${id}" data-status="disliked" title="싫어요">👎</button>`;
    html += `<button class="ri-btn ${isEdited ? 'active' : ''}" data-action="ri-feedback" data-id="${id}" data-status="edited" title="수정">✏️</button>`;
    html += `</div>`;
    html += `</div>`;

    // Edit textarea (shown when status is 'edited') — full width below
    if (isEdited) {
      html += `<div class="ri-edit-area">`;
      html += `<textarea class="ri-edit-input" id="edit-${id}" placeholder="수정 방향을 입력하세요..." rows="2">${escapeHtml(fb.editText)}</textarea>`;
      html += `</div>`;
    }

    html += `</div>`;
    return html;
  }

  // Store latest review data for copy/comment
  let latestReviewData = null;
  let latestVisionDebug = [];
  // Per-item feedback: { 'ri-0': { status: 'liked'|'disliked'|'edited', editText: '' } }
  let reviewFeedback = {};

  function _itemText(item) {
    return typeof item === 'object' ? item.text : item;
  }
  function _itemPerspective(item) {
    const p = typeof item === 'object' ? item.perspective : null;
    return p ? `[${p}] ` : '';
  }

  function reviewDataToMarkdown(data) {
    let lines = [];
    lines.push(`## 📋 AI 리뷰 — ${pageMeta?.title || 'Untitled'}`);
    if (data.score != null) lines.push(`\n**전체 평가: ${data.score}/100**`);

    if (data.issues?.length) {
      lines.push(`\n### ⚠️ 보강 필요 (${data.issues.length}건)`);
      data.issues.forEach(item => lines.push(`- ${_itemPerspective(item)}${_itemText(item)}`));
    }
    if (data.verifications?.length) {
      lines.push(`\n### 🔍 검증 필요 (${data.verifications.length}건)`);
      data.verifications.forEach(item => lines.push(`- ${_itemPerspective(item)}${_itemText(item)}`));
    }
    if (data.suggestions?.length) {
      lines.push(`\n### 💡 제안 (${data.suggestions.length}건)`);
      data.suggestions.forEach(item => lines.push(`- ${_itemText(item)}`));
    }
    if (data.flow) {
      lines.push(`\n### 🔀 로직 플로우`);
      lines.push(data.flow);
    }
    if (data.qa_checklist?.length) {
      lines.push(`\n### ✅ QA 체크리스트 (${data.qa_checklist.length}건)`);
      data.qa_checklist.forEach(item => lines.push(`- [ ] ${item}`));
    }
    if (data.readability) {
      lines.push(`\n### 📖 문서 가독성${data.readability.score != null ? ` (${data.readability.score}/100)` : ''}`);
      if (data.readability.issues?.length) {
        data.readability.issues.forEach(item => lines.push(`- ${item}`));
      }
    }

    lines.push(`\n---\n_Project K AI Assistant로 생성됨_`);
    return lines.join('\n');
  }

  function reviewDataToConfluenceHtml(data) {
    let html = `<h3>📋 AI 리뷰 — ${escapeHtml(pageMeta?.title || '')}</h3>`;
    if (data.score != null) html += `<p><strong>전체 평가: ${data.score}/100</strong></p>`;

    if (data.issues?.length) {
      html += `<h4>⚠️ 보강 필요 (${data.issues.length}건)</h4><ul>`;
      data.issues.forEach(item => { html += `<li><strong>${escapeHtml(_itemPerspective(item))}</strong>${escapeHtml(_itemText(item))}</li>`; });
      html += '</ul>';
    }
    if (data.verifications?.length) {
      html += `<h4>🔍 검증 필요 (${data.verifications.length}건)</h4><ul>`;
      data.verifications.forEach(item => { html += `<li><strong>${escapeHtml(_itemPerspective(item))}</strong>${escapeHtml(_itemText(item))}</li>`; });
      html += '</ul>';
    }
    if (data.suggestions?.length) {
      html += `<h4>💡 제안 (${data.suggestions.length}건)</h4><ul>`;
      data.suggestions.forEach(item => { html += `<li>${escapeHtml(_itemText(item))}</li>`; });
      html += '</ul>';
    }
    if (data.flow) {
      html += `<h4>🔀 로직 플로우</h4><pre>${escapeHtml(data.flow)}</pre>`;
    }
    if (data.qa_checklist?.length) {
      html += `<h4>✅ QA 체크리스트 (${data.qa_checklist.length}건)</h4>`;
      html += `<ac:task-list>`;
      data.qa_checklist.forEach(item => {
        html += `<ac:task><ac:task-status>incomplete</ac:task-status><ac:task-body>${escapeHtml(item)}</ac:task-body></ac:task>`;
      });
      html += `</ac:task-list>`;
    }
    if (data.readability) {
      html += `<h4>📖 문서 가독성${data.readability.score != null ? ` (${data.readability.score}/100)` : ''}</h4>`;
      if (data.readability.issues?.length) {
        html += '<ul>';
        data.readability.issues.forEach(item => { html += `<li>${escapeHtml(item)}</li>`; });
        html += '</ul>';
      }
    }

    html += `<hr/><p><em>Project K AI Assistant로 생성됨</em></p>`;
    return html;
  }

  window._riFeedback = (id, status) => {
    // Save edit text before switching state
    const fb = reviewFeedback[id];
    if (!fb) return;
    const editInput = document.getElementById(`edit-${id}`);
    if (editInput) fb.editText = editInput.value;

    // Toggle: clicking same status resets to 'liked'
    fb.status = (fb.status === status && status !== 'liked') ? 'liked' : status;

    // Re-render the review card
    reRenderReviewCard();
  };

  function reRenderReviewCard() {
    if (!latestReviewData) return;
    const reviewMsg = messages.find(m => m.type === 'review');
    if (!reviewMsg) return;
    const el = document.getElementById(reviewMsg.id);
    if (!el) return;

    // Save all edit texts before re-render
    Object.keys(reviewFeedback).forEach(id => {
      const input = document.getElementById(`edit-${id}`);
      if (input) reviewFeedback[id].editText = input.value;
    });

    el.innerHTML = renderReviewCard(latestReviewData);

    // Restore edit texts and focus
    Object.keys(reviewFeedback).forEach(id => {
      if (reviewFeedback[id].status === 'edited') {
        const input = document.getElementById(`edit-${id}`);
        if (input) {
          input.value = reviewFeedback[id].editText;
          // Auto-focus the newly opened edit box
          if (!reviewFeedback[id].editText) input.focus();
        }
      }
    });
  }

  window._fixFromReview = async () => {
    if (!latestReviewData) return;

    // Save any open edit texts
    Object.keys(reviewFeedback).forEach(id => {
      const input = document.getElementById(`edit-${id}`);
      if (input) reviewFeedback[id].editText = input.value;
    });

    // 카테고리별로 항목 분류
    const sections = { issues: [], verifications: [], suggestions: [] };
    Object.keys(reviewFeedback).forEach(id => {
      const fb = reviewFeedback[id];
      if (fb.status === 'disliked') return;
      const text = fb.status === 'edited' && fb.editText.trim()
        ? `${fb.text} → 사용자 수정 방향: ${fb.editText.trim()}`
        : fb.text;
      if (!text) return;
      const cat = fb.category || 'suggestions';
      if (sections[cat]) sections[cat].push(text);
      else sections.suggestions.push(text);
    });

    const totalItems = Object.values(sections).reduce((s, arr) => s + arr.length, 0);
    if (totalItems === 0) {
      addMessage({ role: 'system', content: '반영할 항목이 없습니다. 좋아요(👍) 항목을 확인해주세요.' });
      return;
    }

    const total = Object.keys(reviewFeedback).length;
    const disliked = Object.values(reviewFeedback).filter(f => f.status === 'disliked').length;
    addMessage({ role: 'user', content: `리뷰 반영 수정 요청 (전체 ${total}건 중 제외 ${disliked}건 = 반영 대상 ${totalItems}건)` });
    const welcome = $('#welcome');
    if (welcome) welcome.style.display = 'none';

    chatState = 'PROCESSING';
    const loadingId = addMessage({ role: 'assistant', content: '', type: 'loading' });

    try {
      await refreshPageContent();
      if (!pageContent) {
        removeMessage(loadingId);
        addMessage({ role: 'system', content: '페이지 내용을 추출할 수 없습니다.' });
        chatState = 'IDLE';
        return;
      }

      // 섹션별 순차 체이닝 — 이전 섹션 변경사항을 다음에 전달
      const sectionOrder = ['issues', 'verifications', 'suggestions'];
      const sectionLabels = { issues: '⚠️ 보강 필요', verifications: '🔍 검증 필요', suggestions: '💡 제안' };
      const activeSections = sectionOrder.filter(cat => sections[cat] && sections[cat].length > 0);

      let allChanges = [];
      const resultSummary = [];

      for (let si = 0; si < activeSections.length; si++) {
        const cat = activeSections[si];
        const items = sections[cat];
        const label = sectionLabels[cat];
        const step = `${si + 1}/${activeSections.length}`;

        setStatus(`${label} ${items.length}건 수정안 생성 중... (${step})`);

        // 이전 섹션에서 이미 생성된 변경사항을 컨텍스트로 전달
        let chainContext = '';
        if (allChanges.length > 0) {
          chainContext = `\n\n⚠️ 이전 단계에서 이미 반영된 수정사항 (중복/충돌 방지):\n${allChanges.map((c, i) => `${i+1}. [${c.section || ''}] "${c.before?.slice(0, 40)}..." → "${c.after?.slice(0, 40)}..."`).join('\n')}\n\n위 수정사항과 중복되거나 충돌하는 변경은 생성하지 마세요.`;
        }

        try {
          const instruction = `[${label}] 다음 항목을 반영하여 문서를 수정해주세요:\n${items.map((it, i) => `${i+1}. ${it}`).join('\n')}${chainContext}`;
          const response = await callBackground('SUGGEST_EDITS', {
            title: pageMeta.title,
            text: pageContent.text,
            html: pageContent.html,
            instruction,
            maxChanges: items.length,
          });
          const changes = response.changes || [];
          resultSummary.push(`${label}: ✅ ${changes.length}건`);
          allChanges = allChanges.concat(changes);
        } catch (e) {
          resultSummary.push(`${label}: ❌ 실패 (${e.message.slice(0, 50)})`);
        }
      }

      removeMessage(loadingId);

      // 결과 표시
      addMessage({ role: 'system', content: resultSummary.join('\n') });

      if (allChanges.length > 0) {
        // 기존 changes 표시 로직 재활용
        editSession = { changes: allChanges, acceptedIds: new Set(), rejectedIds: new Set(), unmatchedIds: new Set() };
        addMessage({ role: 'assistant', content: '', type: 'changes', changes: allChanges });
        setStatus(`${allChanges.length}건 수정 제안`);
        chatState = 'CHANGES_PENDING';
      } else {
        addMessage({ role: 'system', content: '수정안을 생성하지 못했습니다.' });
        setStatus('Ready');
        chatState = 'IDLE';
      }
    } catch (e) {
      removeMessage(loadingId);
      addMessage({ role: 'system', content: `오류: ${e.message}` });
      chatState = 'IDLE';
      setStatus('Error');
    }
  };

  window._copyReview = async () => {
    if (!latestReviewData) return;
    const text = reviewDataToMarkdown(latestReviewData);
    try {
      await navigator.clipboard.writeText(text);
      // Show feedback
      const btn = document.querySelector('.btn-copy-review');
      if (btn) {
        const orig = btn.textContent;
        btn.textContent = '✅ 복사됨!';
        setTimeout(() => { btn.textContent = orig; }, 2000);
      }
    } catch {
      // Fallback
      const ta = document.createElement('textarea');
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
    }
  };

  window._commentReview = async () => {
    if (!latestReviewData || !pageMeta?.pageId) {
      addMessage({ role: 'system', content: '리뷰 데이터 또는 페이지 정보가 없습니다.' });
      return;
    }

    const btn = document.querySelector('.btn-comment-review');
    if (btn) {
      btn.disabled = true;
      btn.textContent = '⏳ 등록 중...';
    }

    try {
      const commentHtml = reviewDataToConfluenceHtml(latestReviewData);
      await callBackground('ADD_CONFLUENCE_COMMENT', {
        pageId: pageMeta.pageId,
        confluenceUrl: pageMeta.confluenceBaseUrl,
        body: commentHtml,
      });
      addMessage({ role: 'system', content: '✅ Confluence 댓글로 등록했습니다.' });
      if (btn) btn.textContent = '✅ 등록됨!';
    } catch (err) {
      addMessage({ role: 'system', content: `❌ 댓글 등록 실패: ${err.message}` });
      if (btn) { btn.textContent = '💬 Confluence 댓글'; btn.disabled = false; }
    }
  };

  function renderChangesCard(changes) {
    let html = '<div class="changes-card">';

    changes.forEach((change, i) => {
      const decision = editSession.decisions[change.id] || 'pending';
      html += `<div class="change-item ${decision}" data-change-id="${change.id}" data-action="focus-change" data-id="${change.id}">`;
      html += `<div class="change-header">`;
      html += `<span class="change-num">${i + 1}.</span>`;
      html += `<span class="change-desc">${escapeHtml(change.description || change.section || '')}</span>`;
      const unmatched = editSession.unmatchedIds && editSession.unmatchedIds.has(change.id);
      html += `<span class="change-badge ${decision}">${decision}</span>`;
      if (unmatched) html += `<span class="change-badge unmatched">미매칭</span>`;
      html += `</div>`;

      // Inline diff
      html += `<div class="change-diff">${DiffEngine.renderDiff(change.before, change.after)}</div>`;

      // Action buttons
      if (decision === 'pending') {
        html += `<div class="change-actions">`;
        html += `<button class="btn-sm btn-approve-sm" data-action="accept-change" data-id="${change.id}">✓ 적용</button>`;
        html += `<button class="btn-sm btn-reject-sm" data-action="reject-change" data-id="${change.id}">✕ 미적용</button>`;
        html += `</div>`;
      } else {
        html += `<div class="change-actions">`;
        html += `<button class="btn-sm btn-undo-sm" data-action="undo-change" data-id="${change.id}">↩ 되돌리기</button>`;
        html += `</div>`;
      }

      html += `</div>`;
    });

    // Bottom actions
    html += `<div class="changes-bottom">`;
    html += `<div class="changes-summary" id="changes-summary">${getChangesSummary()}</div>`;
    html += `<div class="changes-actions">`;
    html += `<button class="btn-sm btn-approve-sm" data-action="accept-all">전체 적용</button>`;
    html += `<button class="btn-sm btn-reject-sm" data-action="reject-all">전체 거부</button>`;
    html += `</div>`;
    html += `<div class="changes-confirm">Confluence에 반영할까요? "응" 또는 "아니"로 답해주세요.</div>`;
    html += `</div>`;

    html += '</div>';
    return html;
  }

  function getChangesSummary() {
    const accepted = editSession.changes.filter(c => editSession.decisions[c.id] === 'accepted').length;
    const rejected = editSession.changes.filter(c => editSession.decisions[c.id] === 'rejected').length;
    const pending = editSession.changes.length - accepted - rejected;
    return `${accepted}건 적용 / ${rejected}건 거부 / ${pending}건 대기`;
  }

  function updateChangesCard() {
    // Re-render the changes card in place
    const changesMsg = messages.find(m => m.type === 'changes');
    if (!changesMsg) return;
    const el = document.getElementById(changesMsg.id);
    if (!el) return;
    el.innerHTML = renderChangesCard(changesMsg.changes);

    // Update floating bar counts
    const accepted = editSession.changes.filter(c => editSession.decisions[c.id] === 'accepted').length;
    const rejected = editSession.changes.filter(c => editSession.decisions[c.id] === 'rejected').length;
    const pending = editSession.changes.length - accepted - rejected;
    sendToContent('UPDATE_COUNTS', {
      total: editSession.changes.length,
      accepted, rejected, pending,
    });
  }

  // Global handlers for inline onclick
  window._acceptChange = (id) => {
    editSession.decisions[id] = 'accepted';
    sendToContent('SYNC_DECISION', { changeId: id, decision: 'accepted' });
    updateChangesCard();
  };
  window._rejectChange = (id) => {
    editSession.decisions[id] = 'rejected';
    sendToContent('SYNC_DECISION', { changeId: id, decision: 'rejected' });
    updateChangesCard();
  };
  window._undoChange = (id) => {
    delete editSession.decisions[id];
    sendToContent('SYNC_DECISION', { changeId: id, decision: 'pending' });
    updateChangesCard();
  };
  window._acceptAll = () => {
    editSession.changes.forEach(c => {
      if (!editSession.decisions[c.id]) {
        editSession.decisions[c.id] = 'accepted';
        sendToContent('SYNC_DECISION', { changeId: c.id, decision: 'accepted' });
      }
    });
    updateChangesCard();
  };
  window._rejectAll = () => {
    editSession.changes.forEach(c => {
      if (!editSession.decisions[c.id]) {
        editSession.decisions[c.id] = 'rejected';
        sendToContent('SYNC_DECISION', { changeId: c.id, decision: 'rejected' });
      }
    });
    updateChangesCard();
  };

  // --- Utilities ---

  function getRecentHistory() {
    return messages
      .filter(m => m.role === 'user' || (m.role === 'assistant' && !m.type))
      .slice(-10)
      .map(m => ({ role: m.role, content: m.content }));
  }

  function scrollToBottom() {
    const container = $('#chat-messages');
    setTimeout(() => container.scrollTop = container.scrollHeight, 50);
  }

  function scrollToMessage(id) {
    setTimeout(() => {
      const el = document.getElementById(id);
      if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }, 50);
  }

  function setStatus(text) {
    $('#status-text').textContent = text;
  }

  function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }

  function formatMarkdown(text) {
    if (!text) return '';
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

  function resetChat() {
    messages = [];
    editSession = { changes: [], decisions: {}, autoApply: false };
    pendingChanges = [];
    chatState = 'IDLE';

    const container = $('#chat-messages');
    container.innerHTML = '';

    // Re-add welcome
    const welcome = document.createElement('div');
    welcome.id = 'welcome';
    welcome.className = 'welcome';
    welcome.innerHTML = `
      <div class="welcome-title">무엇을 도와드릴까요?</div>
      <div class="welcome-desc" id="welcome-desc">${pageMeta ? `"${escapeHtml(pageMeta.title)}" 페이지에 대해 질문하거나 리뷰를 요청하세요.` : '페이지를 분석하고 있습니다...'}</div>
      <div class="presets" id="presets">
        <button class="preset-btn" data-preset="이 문서를 요약해줘">요약해줘</button>
        <button class="preset-btn" data-preset="이 문서를 리뷰해줘">리뷰해줘</button>
        <button class="preset-btn" data-preset="초안을 같이 완성해줘">초안을 같이 완성해줘</button>
      </div>
    `;
    container.appendChild(welcome);
    setupPresets();
    setStatus('페이지 변경 — Ready');
  }

  function setupStatusBar() {
    $('#status-mode').textContent = 'Loading...';
    callBackground('PING', {}).then(() => {
      $('#status-mode').textContent = 'Connected';
    }).catch(() => {
      $('#status-mode').textContent = 'Disconnected';
    });
  }

  // --- Start ---
  document.addEventListener('DOMContentLoaded', init);
})();
