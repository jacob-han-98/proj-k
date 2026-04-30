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
- For features planned but not yet designed, mark as "[TODO]" with a brief note.
- TABLE CELLS: The page text shows tables in markdown format (| col1 | col2 |). CRITICAL table rules:
  1. NEVER include pipe characters (|) in "before" or "after" — pipes are column separators, not content.
  2. "before" must contain text from ONE CELL ONLY. Never span multiple columns.
  3. If you need to edit a cell, copy ONLY that cell's text without any | or adjacent cell text.
  Example: For row "| KeywordA | 텍스트A | 설명A |", to edit 텍스트A → 텍스트B:
  ✅ CORRECT: before="텍스트A" after="텍스트B"
  ❌ WRONG: before="KeywordA | 텍스트A" (spans 2 cells)
  ❌ WRONG: before="KeywordA || 텍스트A" (includes pipes)`,
    user: (title, text, instruction, maxChanges) => `Page Title: ${title}

Page Text:
${text.slice(0, 60000)}

Edit Instruction: ${instruction}

Return JSON array (generate up to ${maxChanges || 10} changes — one per instruction item). Each "before" must be a short EXACT substring from the page text above (1 sentence, no newlines):
[{"id":"change-1","section":"섹션명","description":"간단한 설명","before":"페이지에서 복사한 정확한 짧은 텍스트","after":"대체 텍스트"}]`,
  },

  review: {
    system: `You are a senior game designer and document quality expert reviewing Confluence wiki pages for Project K, a mobile MMORPG.
Analyze the document from multiple perspectives. Respond in Korean.

Return a JSON object with this exact structure:
{
  "score": 0-100,
  "issues": [{"text": "...", "perspective": "기획팀장|프로그래머"}],
  "verifications": [{"text": "...", "perspective": "기획팀장|프로그래머"}],
  "suggestions": ["..."],
  "flow": "전체 로직을 단계별 텍스트 순서도로 정리 (1. → 2. → 3. ...)",
  "qa_checklist": ["테스트 항목 1", "테스트 항목 2", "..."],
  "readability": {"score": 0-100, "issues": ["가독성 관련 지적 사항"]}
}

## 리뷰 관점 (perspective)

모든 issues/verifications 항목에 관점을 명시하세요:
- **"기획팀장"**: 기획 의도, 시스템 설계, 콘텐츠 방향성, 다른 시스템과의 정합성, 우선순위/스코프 판단
- **"프로그래머"**: 구현 가능성, 기술적 명세 부족, 서버/클라이언트 처리 방식, 체크 빈도/타이밍, 데이터 타입/단위 오류, 예외 처리

## 카테고리 규칙 — 각 항목은 정확히 하나의 카테고리에만 속함

- **"issues"**: 문서에 반드시 있어야 하는데 빠진 것. 구현자가 이 문서만 보고 작업할 수 없는 수준의 누락.
  - 수치가 기획서에 없는 경우, 실제 데이터시트(ContentSetting, 테이블 등)에 값이 존재할 수 있음. 데이터시트에서 채워야 할 값은 "[TODO: 데이터시트에서 실제 값 확인 필요]"로 표기.
  - 예: 수치 없음, 예외 케이스 미기술, 필수 정의 누락, 데이터 타입/단위 모호
- **"verifications"**: 적혀 있지만 맞는지 확인이 필요한 것. 오타/오류 의심, 모호한 표현, 다른 문서와 불일치 가능성.
  - 예: 텍스트 키 중복, 수치 단위 혼동, 용어 불일치
- **"suggestions"**: issues/verifications에 해당하지 않지만, 추가하면 문서 품질이 올라가는 것.
  - 예: 다이어그램 추가, 관련 문서 링크, 구조 개선, 연출/피드백 명세

IMPORTANT: suggestions는 issues와 겹치면 안 됨. "없어서 문제"이면 issues, "있어도 되고 없어도 되지만 있으면 좋은 것"이면 suggestions.

## 로직 플로우 (flow)

시스템의 전체 동작 로직을 **텍스트 기반 순서도**로 정리하세요.
- 조건 분기: "→ [조건] → 결과A / [아니면] → 결과B" 형식
- 구현자와 QA 모두 이해할 수 있는 수준으로 작성
- 문서에 명시된 로직만 기반으로 작성 (추측 금지)

## QA 테스트 체크리스트 (qa_checklist)

이 기획서를 기반으로 **QA가 검증해야 할 테스트 케이스**를 생성하세요:
- **기본 흐름(Happy Path)을 최우선으로 포함** — 시스템의 가장 기본적인 정상 동작을 먼저 검증 (예: "물약 보유 상태에서 HP가 설정 비율 이하로 감소 → 자동 사용 → HP 회복 확인")
- 기본 흐름 이후 엣지 케이스 + 경계값 테스트 추가
- 각 항목은 구체적이고 실행 가능해야 함 (예: "물약 0개 상태에서 HP 50% 이하로 감소 시 동작 확인")
- 문서에 정의된 모든 조건 분기, 상태 전이, 예외 처리를 커버
- 다른 시스템과의 상호작용 테스트 포함 (예: PVP 전환, 서포트 모드, 던전 입장 등)

## 문서 가독성 평가 (readability)

이 문서를 **프로그래머, QA, 아트 담당자가 읽고 바로 작업에 착수할 수 있는지** 평가하세요:
- 논리적 흐름: 개념정의 → 규칙 → 데이터 → 예외처리 → UI 순서가 자연스러운가
- 계층 구조: 한 섹션이 너무 비대하거나, 관련 없는 내용이 섞여 있지 않은가
- 용어 일관성: 같은 개념을 다른 이름으로 부르고 있지 않은가
- 조건문 명확성: "일정 수준", "적절히" 같은 모호한 표현이 없는가
- 독립성: 이 문서만으로 이해 가능한가, 암묵적 전제가 없는가
- UX 관점: UI 이미지나 와이어프레임이 포함되어 있다면, 일반적인 모바일 게임 UX 관점에서 개선점 제시

Return ONLY the raw JSON object. No markdown fences.`,
    user: (title, text) => `Page Title: ${title}

Page Content:
${text.slice(0, 100000)}

Review this document thoroughly and return the JSON result:`,
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

    case 'REVIEW_VISION':
      return handleReviewVision(message.payload, settings);

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
      return { editableSpaces: settings.editableSpaces || '', backendUrl: settings.backendUrl || '', apiMode: settings.apiMode || '' };

    case 'PING':
      return { status: 'ok' };

    default:
      throw new Error(`Unknown action: ${message.action}`);
  }
}

// --- Handlers ---

// proxy 모드에서도 LLM 직접 호출이 필요한 경우 Bedrock으로 폴백
function _llmSettings(settings) {
  if (settings.apiMode === 'proxy' && settings.bedrockToken) {
    return { ...settings, apiMode: 'bedrock' };
  }
  return settings;
}

async function handleSummarize({ title, text }, settings) {
  Logger.info('bg', 'Summarize start', { title, textLen: text?.length });
  const result = await ApiClient.call(
    PROMPTS.summary.system,
    PROMPTS.summary.user(title, text),
    _llmSettings(settings)
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
    _llmSettings(settings)
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

async function handleReview({ title, text, reviewInstruction, _senderId }, settings) {
  Logger.info('bg', 'Review start', { title, textLen: text?.length });

  const backendUrl = settings.backendUrl || '';
  if (backendUrl) {
    try {
      Logger.info('bg', 'Review via backend SSE', { backendUrl });

      // SSE 스트리밍으로 중간 상태 전달
      const response = await fetch(`${backendUrl}/review_stream`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title, text, model: settings.bedrockModel || 'claude-opus-4-6', review_instruction: reviewInstruction || '' }),
      });

      if (response.ok && response.body) {
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        let finalResult = null;

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });

          // NDJSON 파싱 — 줄 단위
          const lines = buffer.split('\n');
          buffer = lines.pop() || '';
          for (const line of lines) {
            if (!line.trim()) continue;
            try {
              const event = JSON.parse(line);
              if (event.type === 'status') {
                // 중간 상태를 탭에 브로드캐스트
                Logger.info('bg', 'Review status', { message: event.message });
                chrome.tabs.query({ url: '*://*.atlassian.net/*' }, (tabs) => {
                  for (const tab of tabs) {
                    chrome.tabs.sendMessage(tab.id, {
                      type: 'REVIEW_STATUS',
                      message: event.message,
                    }).catch(() => {});
                  }
                });
              } else if (event.type === 'token') {
                // 스트리밍 토큰을 탭에 브로드캐스트
                chrome.tabs.query({ url: '*://*.atlassian.net/*' }, (tabs) => {
                  for (const tab of tabs) {
                    chrome.tabs.sendMessage(tab.id, {
                      type: 'REVIEW_TOKEN',
                      text: event.text,
                    }).catch(() => {});
                  }
                });
              } else if (event.type === 'partial_review') {
                chrome.tabs.query({ url: '*://*.atlassian.net/*' }, (tabs) => {
                  for (const tab of tabs) {
                    chrome.tabs.sendMessage(tab.id, {
                      type: 'PARTIAL_REVIEW',
                      data: event.data,
                    }).catch(() => {});
                  }
                });
              } else if (event.type === 'result') {
                finalResult = event.data;
              } else if (event.type === 'error') {
                throw new Error(event.message);
              }
            } catch (e) {
              if (e.message && !e.message.includes('Unexpected')) throw e;
            }
          }
        }

        if (finalResult) {
          Logger.info('bg', 'Review SSE done', { reviewLen: finalResult.review?.length });
          return { review: finalResult.review, trace: finalResult.trace, chunks: finalResult.chunks };
        }
      }

      // SSE 실패 시 일반 호출로 폴백
      Logger.warn('bg', 'Review SSE failed, trying regular endpoint');
      const fallbackResp = await fetch(`${backendUrl}/review`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title, text, model: settings.bedrockModel || 'claude-opus-4-6' }),
      });
      if (fallbackResp.ok) {
        const data = await fallbackResp.json();
        return { review: data.review, trace: data.trace, chunks: data.chunks };
      }
    } catch (e) {
      Logger.warn('bg', 'Review backend error, falling back to direct', { error: e.message });
    }
  }

  // 폴백: Claude API 직접 호출
  const result = await ApiClient.call(
    PROMPTS.review.system,
    PROMPTS.review.user(title, text),
    _llmSettings(settings)
  );
  Logger.info('bg', 'Review direct done', { resultLen: result?.length });
  return { review: result };
}

const VISION_ANALYZE_PROMPT = `당신은 모바일 MMORPG "Project K"의 UI/UX 및 기획 전문가입니다.
아래에 기획 문서 전문과 그 안에 포함된 이미지가 제공됩니다.
이미지가 기획 문서의 어떤 맥락에 위치하는지 파악하고 분석하세요.

다음을 분석해주세요 (한국어):
1. **이미지 종류**: UI 와이어프레임 / 플로우차트 / 데이터 테이블 / 스크린샷 / 기타
2. **핵심 내용**: 이미지가 보여주는 핵심 정보 (2-3문장)
3. **UX 평가** (UI 관련 이미지인 경우만):
   - 모바일 게임 UX 일반 원칙 관점에서 개선점 (터치 타겟, 정보 밀도, 원핸드 조작, 시인성 등)
   - 해당 기능의 기획 의도와 UI가 부합하는지
4. **기획서와의 정합성**: 이미지 내용이 기획 문서 텍스트와 일치하는지, 불일치하거나 누락된 부분은 없는지

간결하게 답변하세요 (300자 이내).`;

async function handleReviewVision({ title, text, images }, settings) {
  Logger.info('bg', 'ReviewVision start', { title, imageCount: images?.length });

  if (!images || images.length === 0) {
    return { images: [], totalImages: 0, analyzedImages: 0 };
  }

  // 최대 10개 이미지 분석
  const targetImages = images.slice(0, 10);
  Logger.info('bg', 'Vision analyzing', { total: images.length, analyzing: targetImages.length });

  const analyzeImage = async (img, idx) => {
    const start = Date.now();
    try {
      const response = await fetch(img.src);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const blob = await response.blob();
      const buffer = await blob.arrayBuffer();
      // 큰 바이너리를 chunk 방식으로 base64 변환 (스택 오버플로우 방지)
      const bytes = new Uint8Array(buffer);
      let binary = '';
      const CHUNK = 8192;
      for (let j = 0; j < bytes.length; j += CHUNK) {
        binary += String.fromCharCode.apply(null, bytes.subarray(j, j + CHUNK));
      }
      const base64 = btoa(binary);
      const mediaType = blob.type || 'image/png';

      const docContext = text.slice(0, 15000);
      const userContent = [
        { type: 'text', text: `## 기획 문서: ${title}\n\n${docContext}\n\n---\n\n## 이미지 위치 맥락\n이미지 주변 텍스트: ${img.context || '없음'}\nalt: ${img.alt || '없음'}\n\n아래 이미지를 위 기획 문서의 맥락에서 분석해주세요:` },
        { type: 'image', source: { type: 'base64', media_type: mediaType, data: base64 } },
      ];
      // Vision은 항상 Bedrock으로 호출 (proxy 모드여도)
      const visionSettings = { ...settings, apiMode: settings.bedrockToken ? 'bedrock' : settings.claudeApiKey ? 'direct' : settings.apiMode };
      const analysis = await ApiClient.callVision(VISION_ANALYZE_PROMPT, userContent, visionSettings);
      const elapsed = Date.now() - start;
      Logger.info('bg', `Vision image ${idx} done`, { elapsed });
      return { idx, src: img.src, alt: img.alt, width: img.width, height: img.height, context: img.context, analysis, elapsed, error: null };
    } catch (e) {
      const elapsed = Date.now() - start;
      Logger.error('bg', `Vision image ${idx} failed`, { error: e.message });
      return { idx, src: img.src, alt: img.alt, width: img.width, height: img.height, context: img.context, analysis: null, elapsed, error: e.message };
    }
  };

  // 병렬 실행 (최대 5개 동시)
  const visionResults = [];
  const CONCURRENCY = 5;
  for (let i = 0; i < targetImages.length; i += CONCURRENCY) {
    const batch = targetImages.slice(i, i + CONCURRENCY);
    const results = await Promise.all(batch.map((img, batchIdx) => analyzeImage(img, i + batchIdx)));
    visionResults.push(...results);
  }

  const success = visionResults.filter(r => r.analysis).length;
  Logger.info('bg', 'ReviewVision done', { total: visionResults.length, success });

  return { images: visionResults, totalImages: images.length, analyzedImages: targetImages.length };
}

async function handleDraftAssist({ title, text, instruction, history }, settings) {
  Logger.info('bg', 'DraftAssist start', { title, instruction });
  const result = await ApiClient.call(
    PROMPTS.draftAssist.system,
    PROMPTS.draftAssist.user(title, text, instruction, history),
    _llmSettings(settings)
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
    _llmSettings(settings)
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

  const resp = await fetch(`${baseUrl}/rest/api/content`, {
    method: 'POST',
    headers: {
      'Authorization': `Basic ${auth}`,
      'Content-Type': 'application/json',
      'Accept': 'application/json',
    },
    body: JSON.stringify({
      type: 'comment',
      container: {
        id: pageId,
        type: 'page',
      },
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
