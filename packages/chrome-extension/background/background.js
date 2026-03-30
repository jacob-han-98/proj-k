// background.js - Service Worker for Chrome Extension
// Handles all external API calls (Claude API, Backend Proxy, Confluence REST)

importScripts('/lib/config.js', '/lib/logger.js', '/lib/storage.js', '/lib/api-client.js', '/lib/confluence-api.js');

// Sync config.js values into chrome.storage on startup
Storage.syncFromConfig();
Logger.info('bg', 'Service worker started, config synced');

// --- Prompts ---

const PROMPTS = {
  summary: {
    system: `You are a technical writer analyzing Confluence wiki pages for Project K, a mobile MMORPG.
Summarize the page content concisely in Korean. Be specific about game systems, mechanics, and design decisions.`,
    user: (title, text) => `Page Title: ${title}

Page Content:
${text.slice(0, 100000)}

Provide:
1. **한줄 요약**: One-line summary of what this page covers
2. **핵심 포인트**: Key points as a bullet list (max 7 items)
3. **관련 시스템**: Game systems or features mentioned/referenced`,
  },

  editSuggestion: {
    system: `You are an editor for Confluence wiki pages. Propose text changes as a JSON array.

CRITICAL RULES:
- "before": COPY-PASTE an exact substring from the page text. It MUST appear verbatim. Keep it short (1 sentence max, no newlines, no tabs).
- "after": the REPLACEMENT text that will REPLACE "before". It must contain the full corrected version of "before", NOT just the addition.
  - WRONG: before="HP 물약" after="HP 물약 (자동 사용 포함)" ← this ADDS text instead of replacing
  - RIGHT: before="HP 물약을 사용한다" after="HP 물약을 자동으로 사용한다" ← this REPLACES the sentence
- If you need to ADD new content, use "before" as the sentence AFTER which the content should appear, and "after" as that sentence + the new content.
- Each change must be SMALL: 1-2 sentences only.
- Return ONLY a raw JSON array. No markdown fences. No explanation.
- Ensure valid JSON: escape quotes with \\", no literal newlines in strings.
- Generate one change per instruction item. Do NOT skip items.
- When referencing other documents: you do NOT know which documents actually exist. Never invent document names or links. Instead, write "[TODO: 관련 문서 링크 추가 필요]" so the author can fill in real links later.
- For features planned but not yet designed, mark as "[TODO]" with a brief note.`,
    user: (title, text, instruction, maxChanges) => `Page Title: ${title}

Page Text:
${text.slice(0, 60000)}

Edit Instruction: ${instruction}

Return JSON array (generate up to ${maxChanges || 10} changes — one per instruction item). Each "before" must be a short EXACT substring from the page text above (1 sentence, no newlines):
[{"id":"change-1","section":"섹션명","description":"간단한 설명","before":"페이지에서 복사한 정확한 짧은 텍스트","after":"대체 텍스트"}]`,
  },

  review: {
    system: `You are a senior game designer reviewing Confluence wiki pages for Project K, a mobile MMORPG.
Analyze the document quality from a game design perspective. Respond in Korean.

Return a JSON object with this exact structure:
{
  "score": 0-100,
  "issues": ["..."],
  "verifications": ["..."],
  "strengths": ["..."],
  "suggestions": ["..."]
}

STRICT CATEGORY RULES — each item must belong to EXACTLY ONE category. No duplicates across categories:
- "issues": 문서에 반드시 있어야 하는데 빠진 것. 구현자가 이 문서만 보고 작업할 수 없는 수준의 누락. (예: 수치 없음, 예외 케이스 미기술, 필수 정의 누락)
- "verifications": 적혀 있지만 맞는지 확인이 필요한 것. 다른 문서와 불일치 가능성, 오타/오류 의심, 모호한 표현. (예: 수치가 다른 문서와 다름, 용어 불일치)
- "strengths": 잘 작성된 부분. 간결하게.
- "suggestions": issues/verifications에 해당하지 않지만, 추가하면 문서 품질이 올라가는 것. (예: 다이어그램 추가, 관련 문서 링크, 구조 개선)

IMPORTANT: suggestions는 issues와 겹치면 안 됨. "없어서 문제"이면 issues, "있어도 되고 없어도 되지만 있으면 좋은 것"이면 suggestions.

Return ONLY the raw JSON object. No markdown fences.`,
    user: (title, text) => `Page Title: ${title}

Page Content:
${text.slice(0, 100000)}

Review this document and return the JSON result:`,
  },

  draftAssist: {
    system: `You are a game design expert helping complete draft Confluence pages for Project K, a mobile MMORPG.
Analyze the document and identify sections that are incomplete, placeholder-like ("추후 결정", "TBD", empty sections), or need more detail.
Respond in Korean. Be specific and actionable.

If the user asks about a specific section, focus on that section.
If the user asks generally, list all incomplete/draft sections and ask which to work on first.`,
    user: (title, text, instruction, history) => {
      let prompt = `Page Title: ${title}\n\nPage Content:\n${text.slice(0, 80000)}\n\n`;
      if (history && history.length > 0) {
        prompt += `Previous conversation:\n${history.map(h => `${h.role}: ${h.content}`).join('\n')}\n\n`;
      }
      prompt += `User request: ${instruction}`;
      return prompt;
    },
  },

  chat: {
    system: `You are a knowledgeable assistant for Project K, a mobile MMORPG. You have access to the current Confluence page content.
Answer questions about the page content in Korean. Be concise and specific.
If the user asks about content not in the current page, say so and suggest they use the QnA web app for cross-document search.`,
    user: (title, text, question, history) => {
      let prompt = `Current Page: ${title}\n\nPage Content:\n${text.slice(0, 60000)}\n\n`;
      if (history && history.length > 0) {
        prompt += `Previous conversation:\n${history.map(h => `${h.role}: ${h.content}`).join('\n')}\n\n`;
      }
      prompt += `Question: ${question}`;
      return prompt;
    },
  },

  applyEdits: {
    system: `You are a Confluence page editor. Given the original Confluence storage HTML and a list of text-based changes, apply each change to the HTML and return the COMPLETE modified HTML.

CRITICAL RULES:
- Each change has "before" (original text) and "after" (replacement text)
- Find where the "before" text appears in the HTML and replace the text content, preserving all HTML tags and attributes
- Return ONLY the complete modified HTML, no explanations, no markdown fences
- If a change's "before" text is not found, skip it
- Do NOT add or remove any HTML tags unless the change explicitly requires it
- Preserve all Confluence-specific attributes (data-renderer-*, etc.)`,
    user: (storageHtml, changes) => `Original Confluence Storage HTML:
${storageHtml}

Changes to apply:
${JSON.stringify(changes, null, 2)}

Return the COMPLETE modified HTML with all changes applied:`,
  },
};

// --- Message Handler ---

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || !message.action) {
    Logger.warn('bg', 'Ignoring null/invalid message', message);
    return false;
  }
  Logger.info('bg', `Message received: ${message.action}`, { hasPayload: !!message.payload });
  handleMessage(message, sender).then((resp) => {
    Logger.info('bg', `Message handled OK: ${message.action}`);
    sendResponse(resp);
  }).catch((err) => {
    Logger.error('bg', `Message FAILED: ${message.action}`, { error: err.message, stack: err.stack });
    sendResponse({ error: err.message });
  });
  return true; // keep channel open for async response
});

async function handleMessage(message) {
  const settings = await Storage.getAll();
  Logger.info('bg', 'Settings loaded', { apiMode: settings.apiMode, model: settings.bedrockModel, hasToken: !!settings.bedrockToken, hasConfluence: !!(settings.confluenceEmail && settings.confluenceApiToken), email: settings.confluenceEmail || '(empty)' });

  switch (message.action) {
    case 'SUMMARIZE':
      return handleSummarize(message.payload, settings);

    case 'SUGGEST_EDITS':
      return handleSuggestEdits(message.payload, settings);

    case 'REVIEW':
      return handleReview(message.payload, settings);

    case 'DRAFT_ASSIST':
      return handleDraftAssist(message.payload, settings);

    case 'CHAT':
      return handleChat(message.payload, settings);

    case 'CHAT_DIRECT':
      return handleChatDirect(message.payload, settings);

    case 'APPLY_EDITS':
      return handleApplyEdits(message.payload, settings);

    case 'ADD_CONFLUENCE_COMMENT':
      return handleAddConfluenceComment(message.payload, settings);

    case 'GET_CONFLUENCE_PAGE':
      return handleGetConfluencePage(message.payload, settings);

    case 'UPDATE_CONFLUENCE_PAGE':
      return handleUpdateConfluencePage(message.payload, settings);

    case 'GET_LOGS':
      return { logs: Logger.getAll() };

    case 'CLEAR_LOGS':
      Logger.clear();
      return { status: 'cleared' };

    case 'GET_SETTINGS':
      return { editableSpaces: settings.editableSpaces || '' };

    case 'PING':
      return { status: 'ok' };

    default:
      throw new Error(`Unknown action: ${message.action}`);
  }
}

// --- Handlers ---

async function handleSummarize({ title, text }, settings) {
  Logger.info('bg', 'Summarize start', { title, textLen: text?.length });
  const result = await ApiClient.call(
    PROMPTS.summary.system,
    PROMPTS.summary.user(title, text),
    settings
  );
  Logger.info('bg', 'Summarize done', { resultLen: result?.length });
  return { summary: result };
}

async function handleSuggestEdits({ title, text, html, instruction, maxChanges }, settings) {
  const content = text || html;
  Logger.info('bg', 'SuggestEdits start', { title, textLen: text?.length, htmlLen: html?.length, instruction, maxChanges });

  if (!content) {
    throw new Error('No page content available. Page content could not be extracted.');
  }

  const result = await ApiClient.call(
    PROMPTS.editSuggestion.system,
    PROMPTS.editSuggestion.user(title, content, instruction, maxChanges),
    settings
  );
  Logger.info('bg', 'SuggestEdits API response', { resultLen: result?.length, preview: result?.slice(0, 300) });

  // Parse JSON from LLM response
  let changes;
  try {
    // Strip markdown fences first
    let cleaned = result.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
    const jsonMatch = cleaned.match(/\[[\s\S]*\]/);
    if (!jsonMatch) throw new Error('No JSON array found in response');
    // Fix common LLM JSON issues: trailing commas, control chars in strings
    let jsonStr = jsonMatch[0]
      .replace(/,\s*([}\]])/g, '$1')           // trailing commas
      .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, ' ');  // control chars
    changes = JSON.parse(jsonStr);
  } catch (e) {
    Logger.error('bg', 'SuggestEdits parse failed', { parseError: e.message, rawPreview: result?.slice(0, 500) });
    throw new Error(`Failed to parse edit suggestions: ${e.message}\n\nRaw response:\n${result.slice(0, 500)}`);
  }

  for (const change of changes) {
    if (!change.id || !change.before || !change.after) {
      Logger.error('bg', 'Invalid change object', change);
      throw new Error(`Invalid change object: missing required fields (id, before, after)`);
    }
  }

  Logger.info('bg', 'SuggestEdits done', { changeCount: changes.length });
  return { changes };
}

async function handleReview({ title, text }, settings) {
  Logger.info('bg', 'Review start', { title, textLen: text?.length });
  const result = await ApiClient.call(
    PROMPTS.review.system,
    PROMPTS.review.user(title, text),
    settings
  );
  Logger.info('bg', 'Review done', { resultLen: result?.length });
  return { review: result };
}

async function handleDraftAssist({ title, text, instruction, history }, settings) {
  Logger.info('bg', 'DraftAssist start', { title, instruction });
  const result = await ApiClient.call(
    PROMPTS.draftAssist.system,
    PROMPTS.draftAssist.user(title, text, instruction, history),
    settings
  );
  Logger.info('bg', 'DraftAssist done', { resultLen: result?.length });
  return { answer: result };
}

async function handleChat({ title, text, question, history }, settings) {
  Logger.info('bg', 'Chat (QnA server) start', { question });
  // Try QnA backend first
  const backendUrl = settings.backendUrl || 'https://cp.tech2.hybe.im/proj-k/api';
  const contextNote = title ? `\n\n[현재 보고 있는 Confluence 페이지: "${title}"]` : '';
  const fullQuestion = question + contextNote;

  const resp = await fetch(`${backendUrl}/ask`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ question: fullQuestion }),
  });

  if (!resp.ok) throw new Error(`QnA server error: ${resp.status}`);
  const data = await resp.json();
  Logger.info('bg', 'Chat done (QnA server)', { answerLen: data.answer?.length });
  return { answer: data.answer || data.response || 'No response' };
}

async function handleChatDirect({ title, text, question, history }, settings) {
  Logger.info('bg', 'Chat (direct LLM) start', { question });
  const result = await ApiClient.call(
    PROMPTS.chat.system,
    PROMPTS.chat.user(title, text, question, history),
    settings
  );
  Logger.info('bg', 'Chat done (direct)', { resultLen: result?.length });
  return { answer: result };
}

async function handleApplyEdits({ pageId, confluenceUrl, changes }, settings) {
  Logger.info('bg', 'ApplyEdits start', { pageId, changeCount: changes.length });

  if (!settings.confluenceEmail || !settings.confluenceApiToken) {
    throw new Error('Confluence credentials not configured. Open extension settings.');
  }

  const baseUrl = confluenceUrl || `https://${extractDomain(settings)}/wiki`;

  // Step 1: Fetch current page storage HTML
  const page = await ConfluenceApi.getPage(pageId, baseUrl, settings.confluenceEmail, settings.confluenceApiToken);
  Logger.info('bg', 'Fetched page from Confluence', { title: page.title, version: page.version, bodyLen: page.body?.length });

  // Step 2: Apply text changes directly to storage HTML
  let body = page.body;
  const applied = [];
  const failed = [];

  for (const change of changes) {
    // Find "before" text inside HTML tags' text content
    // Strategy: escape HTML special chars in before/after, then search in body
    const beforeEscaped = escapeHtmlText(change.before);
    const afterEscaped = escapeHtmlText(change.after);

    if (body.includes(beforeEscaped)) {
      body = body.replace(beforeEscaped, afterEscaped);
      applied.push(change.description || change.before.slice(0, 30));
    } else if (body.includes(change.before)) {
      // Try raw match (text might not need escaping)
      body = body.replace(change.before, change.after);
      applied.push(change.description || change.before.slice(0, 30));
    } else {
      failed.push(change.description || change.before.slice(0, 30));
    }
  }

  Logger.info('bg', 'Text replace results', { applied: applied.length, failed: failed.length, failedItems: failed });

  if (applied.length === 0) {
    throw new Error(`No changes could be matched in storage HTML. The page structure may differ from rendered text. (${failed.length} failed)`);
  }

  // Step 3: Update page via Confluence API
  const versionMsg = `[Project K Assistant] ${applied.length} edit(s) applied`;
  await ConfluenceApi.updatePage(pageId, page.title, body, page.version, baseUrl, settings.confluenceEmail, settings.confluenceApiToken, versionMsg);
  Logger.info('bg', 'Page updated on Confluence', { pageId, newVersion: page.version + 1, applied: applied.length, failed: failed.length });

  return {
    status: 'ok',
    applied: applied.length,
    failed: failed.length,
    failedItems: failed,
    oldVersion: page.version,
    newVersion: page.version + 1,
  };
}

function escapeHtmlText(text) {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

async function handleGetConfluencePage({ pageId, confluenceUrl }, settings) {
  Logger.info('bg', 'GetConfluencePage', { pageId, confluenceUrl });
  if (!settings.confluenceEmail || !settings.confluenceApiToken) {
    throw new Error('Confluence credentials not configured. Open extension settings.');
  }
  const url = confluenceUrl || `https://${extractDomain(settings)}/wiki`;
  return ConfluenceApi.getPage(pageId, url, settings.confluenceEmail, settings.confluenceApiToken);
}

async function handleUpdateConfluencePage({ pageId, title, body, currentVersion, confluenceUrl }, settings) {
  Logger.info('bg', 'UpdateConfluencePage', { pageId, title, currentVersion });
  if (!settings.confluenceEmail || !settings.confluenceApiToken) {
    throw new Error('Confluence credentials not configured. Open extension settings.');
  }
  const url = confluenceUrl || `https://${extractDomain(settings)}/wiki`;
  return ConfluenceApi.updatePage(pageId, title, body, currentVersion, url, settings.confluenceEmail, settings.confluenceApiToken);
}

async function handleAddConfluenceComment({ pageId, confluenceUrl, body }, settings) {
  Logger.info('bg', 'AddConfluenceComment', { pageId });
  if (!settings.confluenceEmail || !settings.confluenceApiToken) {
    throw new Error('Confluence credentials not configured. Open extension settings.');
  }
  const baseUrl = confluenceUrl || `https://${extractDomain(settings)}/wiki`;
  const auth = btoa(`${settings.confluenceEmail}:${settings.confluenceApiToken}`);

  const resp = await fetch(`${baseUrl}/rest/api/content/${pageId}/child/comment`, {
    method: 'POST',
    headers: {
      'Authorization': `Basic ${auth}`,
      'Content-Type': 'application/json',
      'Accept': 'application/json',
    },
    body: JSON.stringify({
      type: 'comment',
      body: {
        storage: {
          value: body,
          representation: 'storage',
        },
      },
    }),
  });

  if (!resp.ok) {
    const text = await resp.text();
    Logger.error('bg', 'AddConfluenceComment failed', { status: resp.status, body: text });
    throw new Error(`Confluence comment failed: ${resp.status}`);
  }

  const result = await resp.json();
  Logger.info('bg', 'AddConfluenceComment done', { commentId: result.id });
  return { status: 'ok', commentId: result.id };
}

function extractDomain(settings) {
  return 'bighitcorp.atlassian.net';
}
