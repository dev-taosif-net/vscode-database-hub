// Database Hub connection editor form.
(function () {
  'use strict';

  const vscode = acquireVsCodeApi();
  const $ = (id) => document.getElementById(id);

  const ENV_HEX = { DEV: '#2ea043', QA: '#316dca', UAT: '#e8830c', PROD: '#d13438' };
  const DEFAULT_PORT = { mssql: 1433, postgres: 5432 };

  let isEdit = false;

  function refreshTypeSections() {
    const type = $('type').value;
    $('mssql-auth').classList.toggle('hidden', type !== 'mssql');
    $('mssql-opts').classList.toggle('hidden', type !== 'mssql');
    $('pg-opts').classList.toggle('hidden', type !== 'postgres');
    refreshDomainRow();
    const port = $('port');
    const other = type === 'mssql' ? DEFAULT_PORT.postgres : DEFAULT_PORT.mssql;
    if (!port.value || Number(port.value) === other) {
      port.value = DEFAULT_PORT[type];
    }
  }

  function refreshDomainRow() {
    const ntlm = $('type').value === 'mssql' && $('authType').value === 'ntlm';
    $('domain-row').classList.toggle('hidden', !ntlm);
  }

  function refreshEnvDot() {
    $('env-dot').style.background = ENV_HEX[$('environment').value] || '#888';
  }

  function setStatus(kind, text) {
    const el = $('status');
    el.className = kind || '';
    el.textContent = text || '';
  }

  function setBusy(busy) {
    ['test', 'save', 'cancel'].forEach((id) => {
      $(id).disabled = busy;
    });
  }

  function collect() {
    const required = ['name', 'host', 'port', 'database', 'user'];
    let firstBad = null;
    required.forEach((id) => {
      const el = $(id);
      const bad = !String(el.value).trim();
      el.classList.toggle('invalid', bad);
      if (bad && !firstBad) firstBad = el;
    });
    if (firstBad) {
      setStatus('err', 'Please fill in the highlighted fields.');
      firstBad.focus();
      return null;
    }
    return {
      name: $('name').value.trim(),
      type: $('type').value,
      environment: $('environment').value,
      host: $('host').value.trim(),
      port: Number($('port').value),
      database: $('database').value.trim(),
      authType: $('authType').value,
      domain: $('domain').value.trim(),
      user: $('user').value.trim(),
      password: $('password').value,
      readOnly: $('readOnly').checked,
      encrypt: $('encrypt').checked,
      trustServerCertificate: $('trustCert').checked,
      ssl: $('ssl').checked,
    };
  }

  $('type').addEventListener('change', refreshTypeSections);
  $('authType').addEventListener('change', refreshDomainRow);
  $('environment').addEventListener('change', refreshEnvDot);

  $('test').addEventListener('click', () => {
    const data = collect();
    if (!data) return;
    setBusy(true);
    setStatus('busy', 'Testing connection…');
    vscode.postMessage({ type: 'test', data });
  });

  $('save').addEventListener('click', () => {
    const data = collect();
    if (!data) return;
    setBusy(true);
    setStatus('busy', 'Saving…');
    vscode.postMessage({ type: 'save', data });
  });

  $('cancel').addEventListener('click', () => vscode.postMessage({ type: 'cancel' }));

  window.addEventListener('message', (event) => {
    const msg = event.data;
    if (msg.type === 'init') {
      isEdit = Boolean(msg.profile);
      const p = msg.profile || {};
      $('title').textContent = isEdit ? 'Edit Connection' : 'Add Connection';
      $('subtitle').textContent = isEdit
        ? p.name
        : 'Microsoft SQL Server · PostgreSQL';
      $('name').value = p.name || '';
      $('type').value = p.type || 'mssql';
      $('environment').value = p.environment || 'DEV';
      $('host').value = p.host || 'localhost';
      $('port').value = p.port || '';
      $('database').value = p.database || '';
      $('authType').value = p.authType || 'sql';
      $('domain').value = p.domain || '';
      $('user').value = p.user || '';
      $('password').value = '';
      $('password-hint').textContent = isEdit
        ? 'Leave blank to keep the saved password.'
        : 'Stored securely in VS Code Secret Storage — never in settings files.';
      $('readOnly').checked = Boolean(p.readOnly);
      $('encrypt').checked = p.encrypt !== false;
      $('trustCert').checked = p.trustServerCertificate !== false;
      $('ssl').checked = Boolean(p.ssl);
      refreshTypeSections();
      refreshEnvDot();
      setBusy(false);
      setStatus('', '');
      $('name').focus();
    } else if (msg.type === 'testResult') {
      setBusy(false);
      setStatus(msg.ok ? 'ok' : 'err', msg.message);
    }
  });

  vscode.postMessage({ type: 'ready' });
})();
