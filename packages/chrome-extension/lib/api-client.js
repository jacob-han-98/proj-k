// api-client.js - LLM API abstraction (Bedrock + Direct Claude + Backend Proxy)

const BEDROCK_MODEL_MAP = {
  'claude-opus-4-6': 'global.anthropic.claude-opus-4-6-v1',
  'claude-sonnet-4-6': 'global.anthropic.claude-sonnet-4-6',
  'claude-sonnet-4-5': 'global.anthropic.claude-sonnet-4-5-20250929-v1:0',
  'claude-haiku-4-5': 'global.anthropic.claude-haiku-4-5-20251001-v1:0',
  'claude-opus-4-5': 'global.anthropic.claude-opus-4-5-20251101-v1:0',
};

const ApiClient = {
  // AWS Bedrock Claude API call (same pattern as qna-poc/generator.py)
  async callBedrock(systemPrompt, userMessage, bearerToken, model, region) {
    region = region || 'us-east-1';
    model = model || 'claude-opus-4-6';
    const modelId = BEDROCK_MODEL_MAP[model] || `global.anthropic.${model}-v1:0`;
    const url = `https://bedrock-runtime.${region}.amazonaws.com/model/${modelId}/invoke`;

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${bearerToken}`,
      },
      body: JSON.stringify({
        anthropic_version: 'bedrock-2023-05-31',
        max_tokens: 32768,
        temperature: 0,
        system: systemPrompt,
        messages: [{ role: 'user', content: userMessage }],
      }),
    });

    if (!response.ok) {
      const err = await response.text();
      throw new Error(`Bedrock API error (${response.status}): ${err}`);
    }

    const data = await response.json();
    return data.content[0].text;
  },

  // Direct Claude API call (Anthropic API)
  async callClaude(systemPrompt, userMessage, apiKey, model) {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true',
      },
      body: JSON.stringify({
        model: model || 'claude-opus-4-6-20250925',
        max_tokens: 32768,
        system: systemPrompt,
        messages: [{ role: 'user', content: userMessage }],
      }),
    });

    if (!response.ok) {
      const err = await response.text();
      throw new Error(`Claude API error (${response.status}): ${err}`);
    }

    const data = await response.json();
    return data.content[0].text;
  },

  // Backend proxy call (qna-poc FastAPI)
  async callProxy(question, backendUrl) {
    const response = await fetch(`${backendUrl}/ask`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question }),
    });

    if (!response.ok) {
      const err = await response.text();
      throw new Error(`Backend proxy error (${response.status}): ${err}`);
    }

    const data = await response.json();
    return data.answer || data.response || JSON.stringify(data);
  },

  // Vision call — userContent is array of {type:'text'|'image', ...} blocks
  async callVision(systemPrompt, userContent, settings) {
    // userContent: [{type:'text', text:'...'}, {type:'image', source:{type:'base64', media_type:'image/png', data:'...'}}]
    const messages = [{ role: 'user', content: userContent }];
    const model = settings.bedrockModel || 'claude-sonnet-4-6';
    const modelId = BEDROCK_MODEL_MAP[model] || `global.anthropic.${model}-v1:0`;

    if (settings.apiMode === 'bedrock') {
      if (!settings.bedrockToken) throw new Error('Bedrock Bearer Token not configured');
      const region = settings.bedrockRegion || 'us-east-1';
      const url = `https://bedrock-runtime.${region}.amazonaws.com/model/${modelId}/invoke`;
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${settings.bedrockToken}` },
        body: JSON.stringify({ anthropic_version: 'bedrock-2023-05-31', max_tokens: 1024, temperature: 0, system: systemPrompt, messages }),
      });
      if (!response.ok) { const err = await response.text(); throw new Error(`Bedrock Vision error (${response.status}): ${err}`); }
      const data = await response.json();
      return data.content[0].text;
    } else if (settings.apiMode === 'direct') {
      if (!settings.claudeApiKey) throw new Error('Claude API key not configured');
      const response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': settings.claudeApiKey, 'anthropic-version': '2023-06-01', 'anthropic-dangerous-direct-browser-access': 'true' },
        body: JSON.stringify({ model: model || 'claude-sonnet-4-6-20250929', max_tokens: 1024, system: systemPrompt, messages }),
      });
      if (!response.ok) { const err = await response.text(); throw new Error(`Claude Vision error (${response.status}): ${err}`); }
      const data = await response.json();
      return data.content[0].text;
    }
    throw new Error('Vision requires bedrock or direct API mode');
  },

  // Unified call - picks mode from settings
  async call(systemPrompt, userMessage, settings) {
    switch (settings.apiMode) {
      case 'bedrock':
        if (!settings.bedrockToken) throw new Error('Bedrock Bearer Token not configured');
        return this.callBedrock(systemPrompt, userMessage, settings.bedrockToken, settings.bedrockModel, settings.bedrockRegion);
      case 'direct':
        if (!settings.claudeApiKey) throw new Error('Claude API key not configured');
        return this.callClaude(systemPrompt, userMessage, settings.claudeApiKey, settings.claudeModel);
      case 'proxy':
        return this.callProxy(userMessage, settings.backendUrl);
      default:
        throw new Error(`Unknown API mode: ${settings.apiMode}`);
    }
  },
};
