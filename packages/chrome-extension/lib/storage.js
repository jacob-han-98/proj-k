// storage.js - chrome.storage wrapper for extension settings
// CONFIG is loaded from config.js (gitignored) - see config.example.js

const _fallback = {
  bedrockToken: '',
  bedrockModel: 'claude-opus-4-6',
  bedrockRegion: 'us-east-1',
  claudeApiKey: '',
  claudeModel: 'claude-sonnet-4-5-20250514',
  backendUrl: 'http://127.0.0.1:8088',
  confluenceEmail: '',
  confluenceApiToken: '',
};

const _cfg = (typeof CONFIG !== 'undefined') ? CONFIG : {};

const StorageDefaults = {
  apiMode: _cfg.bedrockToken ? 'bedrock' : 'direct',
  bedrockToken: _cfg.bedrockToken || _fallback.bedrockToken,
  bedrockModel: _cfg.bedrockModel || _fallback.bedrockModel,
  bedrockRegion: _cfg.bedrockRegion || _fallback.bedrockRegion,
  claudeApiKey: _cfg.claudeApiKey || _fallback.claudeApiKey,
  claudeModel: _cfg.claudeModel || _fallback.claudeModel,
  backendUrl: _cfg.backendUrl || _fallback.backendUrl,
  confluenceAuth: 'token',
  confluenceEmail: _cfg.confluenceEmail || _fallback.confluenceEmail,
  confluenceApiToken: _cfg.confluenceApiToken || _fallback.confluenceApiToken,
  editableSpaces: _cfg.editableSpaces || 'PKTEST',  // comma-separated space keys
};

const Storage = {
  async get(keys) {
    return new Promise((resolve) => {
      chrome.storage.local.get(keys || Object.keys(StorageDefaults), (result) => {
        const merged = {};
        const defaults = StorageDefaults;
        const requestedKeys = keys || Object.keys(defaults);
        for (const key of (Array.isArray(requestedKeys) ? requestedKeys : [requestedKeys])) {
          merged[key] = result[key] !== undefined ? result[key] : defaults[key];
        }
        resolve(merged);
      });
    });
  },

  async set(data) {
    return new Promise((resolve) => {
      chrome.storage.local.set(data, resolve);
    });
  },

  async getAll() {
    return this.get(Object.keys(StorageDefaults));
  },

  // Sync config.js values into chrome.storage (overwrites cached values)
  async syncFromConfig() {
    if (typeof CONFIG === 'undefined' || !CONFIG.bedrockToken) return;
    await this.set(StorageDefaults);
  },
};
