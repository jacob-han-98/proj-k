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
- "before": a SHORT, UNIQUE substring from the page (1 sentence max, no newlines, no tabs)
- "after": the replacement text (no newlines, no tabs — use spaces instead)
- Keep each change small and focused. Split large edits into multiple changes.
- Return ONLY a raw JSON array. No markdown fences. No explanation.
- Ensure valid JSON: escape quotes with \\", no literal newlines in strings.`,
    user: (title, text, instruction) => `Page Title: ${title}

Page Text:
${text.slice(0, 60000)}

Edit Instruction: ${instruction}

Return JSON array. Each "before" must be a short exact match (1 sentence, no newlines):
[{"id":"change-1","section":"섹션명","description":"설명","before":"short exact text","after":"replacement"}]`,
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

    case 'APPLY_EDITS':
      return handleApplyEdits(message.payload, settings);

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

async function handleSuggestEdits({ title, text, html, instruction }, settings) {
  const content = text || html;
  Logger.info('bg', 'SuggestEdits start', { title, textLen: text?.length, htmlLen: html?.length, instruction });

  if (!content) {
    throw new Error('No page content available. Page content could not be extracted.');
  }

  const result = await ApiClient.call(
    PROMPTS.editSuggestion.system,
    PROMPTS.editSuggestion.user(title, content, instruction),
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

function extractDomain(settings) {
  return 'bighitcorp.atlassian.net';
}
