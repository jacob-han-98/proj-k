// logger.js - Dual logging: chrome.storage + local HTTP log server
// Log server: python3 log-server.py (writes to logs/extension.log)

const LOG_SERVER_URL = 'http://172.20.105.147:19876';

const Logger = {
  _buffer: [],
  _maxEntries: 200,
  _serverAvailable: null, // null = unknown, true/false after first attempt

  log(level, source, message, data) {
    const entry = {
      ts: new Date().toLocaleString('ko-KR', { timeZone: 'Asia/Seoul', hour12: false }) + ' KST',
      level,
      source,
      message,
      data: data !== undefined ? JSON.stringify(data).slice(0, 2000) : undefined,
    };
    this._buffer.push(entry);
    if (this._buffer.length > this._maxEntries) {
      this._buffer = this._buffer.slice(-this._maxEntries);
    }

    // Console log
    const prefix = `[PK:${source}]`;
    if (level === 'error') {
      console.error(prefix, message, data || '');
    } else {
      console.log(prefix, message, data || '');
    }

    // Persist to chrome.storage
    if (typeof chrome !== 'undefined' && chrome.storage) {
      chrome.storage.local.set({ _pk_logs: this._buffer });
    }

    // Send to log server (fire-and-forget)
    this._sendToServer(entry);
  },

  async _sendToServer(entry) {
    if (this._serverAvailable === false) return;
    try {
      const resp = await fetch(LOG_SERVER_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'log', ...entry }),
      });
      this._serverAvailable = resp.ok;
    } catch {
      this._serverAvailable = false;
      // Retry availability check after 30s
      setTimeout(() => { this._serverAvailable = null; }, 30000);
    }
  },

  info(source, message, data) { this.log('info', source, message, data); },
  error(source, message, data) { this.log('error', source, message, data); },
  warn(source, message, data) { this.log('warn', source, message, data); },

  getAll() { return this._buffer; },

  clear() {
    this._buffer = [];
    if (typeof chrome !== 'undefined' && chrome.storage) {
      chrome.storage.local.remove('_pk_logs');
    }
  },
};
