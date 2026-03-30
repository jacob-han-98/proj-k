// config.example.js - Copy this file to config.js and fill in your values
// config.js is gitignored and will not be committed

const CONFIG = {
  // === AWS Bedrock (recommended - same as qna-poc) ===
  bedrockToken: 'your-aws-bearer-token-here',
  bedrockModel: 'claude-opus-4-6',          // claude-opus-4-6 | claude-sonnet-4-6 | claude-sonnet-4-5 | claude-haiku-4-5
  bedrockRegion: 'us-east-1',

  // === Claude Direct API (alternative) ===
  // claudeApiKey: 'sk-ant-your-key-here',
  // claudeModel: 'claude-sonnet-4-5-20250514',

  // === Backend Proxy (alternative) ===
  // backendUrl: 'http://127.0.0.1:8088',

  // === Confluence API credentials (for page edits) ===
  confluenceEmail: 'your-email@company.com',
  confluenceApiToken: 'your-confluence-api-token',

  // === Editable spaces (comma-separated space keys) ===
  editableSpaces: 'PKTEST',   // only these spaces allow Edit Suggestions
};
