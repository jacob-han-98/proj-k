// popup.js - Settings popup logic

(function () {
  'use strict';

  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => document.querySelectorAll(sel);

  async function loadSettings() {
    const settings = await Storage.getAll();

    // API Mode
    const modeRadio = $(`input[name="apiMode"][value="${settings.apiMode}"]`);
    if (modeRadio) modeRadio.checked = true;

    // Bedrock settings
    $('#bedrockToken').value = settings.bedrockToken || '';
    $('#bedrockModel').value = settings.bedrockModel || 'claude-sonnet-4-5';
    $('#bedrockRegion').value = settings.bedrockRegion || 'us-east-1';

    // Direct settings
    $('#claudeApiKey').value = settings.claudeApiKey || '';
    $('#claudeModel').value = settings.claudeModel || 'claude-sonnet-4-5-20250514';

    // Proxy settings
    $('#backendUrl').value = settings.backendUrl || 'http://127.0.0.1:8088';

    // Confluence settings
    $('#confluenceEmail').value = settings.confluenceEmail || '';
    $('#confluenceApiToken').value = settings.confluenceApiToken || '';

    // Edit safety
    $('#editableSpaces').value = settings.editableSpaces || 'PKTEST';

    updateModeVisibility(settings.apiMode);
  }

  function updateModeVisibility(mode) {
    $('#bedrock-settings').classList.add('hidden');
    $('#direct-settings').classList.add('hidden');
    $('#proxy-settings').classList.add('hidden');

    const sectionId = mode + '-settings';
    const section = $(`#${sectionId}`);
    if (section) section.classList.remove('hidden');
  }

  async function saveSettings() {
    const apiMode = $('input[name="apiMode"]:checked').value;

    const data = {
      apiMode,
      bedrockToken: $('#bedrockToken').value.trim(),
      bedrockModel: $('#bedrockModel').value,
      bedrockRegion: $('#bedrockRegion').value.trim(),
      claudeApiKey: $('#claudeApiKey').value.trim(),
      claudeModel: $('#claudeModel').value,
      backendUrl: $('#backendUrl').value.trim(),
      confluenceEmail: $('#confluenceEmail').value.trim(),
      confluenceApiToken: $('#confluenceApiToken').value.trim(),
      editableSpaces: $('#editableSpaces').value.trim(),
    };

    await Storage.set(data);

    const statusEl = $('#save-status');
    statusEl.textContent = 'Saved!';
    setTimeout(() => { statusEl.textContent = ''; }, 2000);
  }

  function init() {
    loadSettings();

    // Mode toggle
    $$('input[name="apiMode"]').forEach((radio) => {
      radio.addEventListener('change', (e) => {
        updateModeVisibility(e.target.value);
      });
    });

    // Save button
    $('#btn-save').addEventListener('click', saveSettings);
  }

  document.addEventListener('DOMContentLoaded', init);
})();
