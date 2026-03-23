// confluence-api.js - Confluence REST API helper

const ConfluenceApi = {
  _buildAuth(email, apiToken) {
    return 'Basic ' + btoa(`${email}:${apiToken}`);
  },

  _baseUrl(confluenceUrl) {
    // Ensure no trailing slash, add /rest/api if not present
    return confluenceUrl.replace(/\/+$/, '');
  },

  async getPage(pageId, confluenceUrl, email, apiToken) {
    const base = this._baseUrl(confluenceUrl);
    const url = `${base}/rest/api/content/${pageId}?expand=body.storage,version,space`;

    const response = await fetch(url, {
      headers: {
        'Authorization': this._buildAuth(email, apiToken),
        'Accept': 'application/json',
      },
    });

    if (!response.ok) {
      const err = await response.text();
      throw new Error(`Confluence API error (${response.status}): ${err}`);
    }

    const data = await response.json();
    return {
      id: data.id,
      title: data.title,
      version: data.version.number,
      body: data.body.storage.value,
      spaceKey: data.space?.key,
    };
  },

  async updatePage(pageId, title, body, currentVersion, confluenceUrl, email, apiToken, versionMessage) {
    const base = this._baseUrl(confluenceUrl);
    const url = `${base}/rest/api/content/${pageId}`;

    const response = await fetch(url, {
      method: 'PUT',
      headers: {
        'Authorization': this._buildAuth(email, apiToken),
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
      body: JSON.stringify({
        version: {
          number: currentVersion + 1,
          message: versionMessage || '[Project K Assistant] AI-suggested edits',
        },
        title: title,
        type: 'page',
        body: {
          storage: {
            value: body,
            representation: 'storage',
          },
        },
      }),
    });

    if (!response.ok) {
      const err = await response.text();
      throw new Error(`Confluence update error (${response.status}): ${err}`);
    }

    return response.json();
  },
};
