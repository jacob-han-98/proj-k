import { useState } from 'react';

interface Props {
  initialEmail?: string;
  initialBaseUrl?: string;
  onClose: () => void;
  onSaved: () => void;
}

const DEFAULT_BASE_URL = 'https://bighitcorp.atlassian.net';

export function CredsModal({ initialEmail, initialBaseUrl, onClose, onSaved }: Props) {
  const [email, setEmail] = useState(initialEmail ?? '');
  const [apiToken, setApiToken] = useState('');
  const [baseUrl, setBaseUrl] = useState(initialBaseUrl ?? DEFAULT_BASE_URL);
  const [saving, setSaving] = useState(false);

  const save = async () => {
    if (!email || !apiToken) return;
    setSaving(true);
    try {
      await window.projk.setConfluenceCreds({ email, apiToken, baseUrl });
      onSaved();
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="creds-modal" onClick={onClose}>
      <div className="panel" onClick={(e) => e.stopPropagation()}>
        <h3>Confluence 자격증명</h3>
        <label>이메일</label>
        <input value={email} onChange={(e) => setEmail(e.target.value)} placeholder="user@hybe.im" />
        <label>API Token</label>
        <input
          type="password"
          value={apiToken}
          onChange={(e) => setApiToken(e.target.value)}
          placeholder="Atlassian API token"
        />
        <label>Base URL</label>
        <input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} />
        <div className="row">
          <button onClick={onClose}>취소</button>
          <button className="primary" onClick={save} disabled={saving || !email || !apiToken}>
            {saving ? '저장 중…' : '저장'}
          </button>
        </div>
      </div>
    </div>
  );
}
