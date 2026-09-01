import * as crypto from 'crypto';
import * as vscode from 'vscode';
import { ConnectionProfile, DbType, Environment } from '../types';

/** Raw values posted by the form */
interface FormData {
  name: string;
  type: DbType;
  environment: Environment;
  host: string;
  port: number;
  database: string;
  authType: 'sql' | 'ntlm';
  domain: string;
  user: string;
  password: string;
  readOnly: boolean;
  encrypt: boolean;
  trustServerCertificate: boolean;
  ssl: boolean;
}

export interface ConnectionEditorHost {
  /** Persist the profile; password undefined = keep the stored one */
  save(profile: ConnectionProfile, password: string | undefined): Promise<void>;
  /** Try a real connect with the given values; throws on failure */
  test(profile: ConnectionProfile, password: string | undefined): Promise<void>;
}

/** "Add / Edit Connection" form in an editor tab. One instance at a time. */
export class ConnectionEditorPanel {
  private static current: ConnectionEditorPanel | undefined;

  static show(
    extensionUri: vscode.Uri,
    host: ConnectionEditorHost,
    existing?: ConnectionProfile,
  ): void {
    if (ConnectionEditorPanel.current) {
      const panel = ConnectionEditorPanel.current;
      panel.existing = existing;
      panel.panel.title = existing ? `Edit · ${existing.name}` : 'Add Connection';
      panel.panel.reveal();
      panel.postInit();
      return;
    }
    const webviewPanel = vscode.window.createWebviewPanel(
      'databaseHubConnection',
      existing ? `Edit · ${existing.name}` : 'Add Connection',
      vscode.ViewColumn.Active,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'media')],
      },
    );
    webviewPanel.iconPath = vscode.Uri.joinPath(extensionUri, 'media', 'database.svg');
    ConnectionEditorPanel.current = new ConnectionEditorPanel(
      webviewPanel,
      extensionUri,
      host,
      existing,
    );
  }

  private constructor(
    private readonly panel: vscode.WebviewPanel,
    extensionUri: vscode.Uri,
    private readonly host: ConnectionEditorHost,
    private existing: ConnectionProfile | undefined,
  ) {
    panel.webview.html = this.buildHtml(panel.webview, extensionUri);
    panel.onDidDispose(() => {
      ConnectionEditorPanel.current = undefined;
    });
    panel.webview.onDidReceiveMessage((msg) => void this.onMessage(msg));
  }

  private postInit(): void {
    void this.panel.webview.postMessage({ type: 'init', profile: this.existing });
  }

  private toProfile(data: FormData): ConnectionProfile {
    return {
      id: this.existing?.id ?? crypto.randomUUID(),
      name: data.name,
      type: data.type,
      environment: data.environment,
      host: data.host,
      port: data.port,
      database: data.database,
      user: data.user,
      authType: data.type === 'mssql' ? data.authType : undefined,
      domain: data.type === 'mssql' && data.authType === 'ntlm' ? data.domain : undefined,
      readOnly: data.readOnly,
      encrypt: data.type === 'mssql' ? data.encrypt : undefined,
      trustServerCertificate: data.type === 'mssql' ? data.trustServerCertificate : undefined,
      ssl: data.type === 'postgres' ? data.ssl : undefined,
    };
  }

  /** Empty password while editing means "keep the stored one" */
  private effectivePassword(data: FormData): string | undefined {
    return this.existing && data.password === '' ? undefined : data.password;
  }

  private async onMessage(msg: { type: string; data?: FormData }): Promise<void> {
    if (msg.type === 'ready') {
      this.postInit();
      return;
    }
    if (msg.type === 'cancel') {
      this.panel.dispose();
      return;
    }
    if (!msg.data) {
      return;
    }
    const profile = this.toProfile(msg.data);
    const password = this.effectivePassword(msg.data);

    if (msg.type === 'test') {
      try {
        await this.host.test(profile, password);
        void this.panel.webview.postMessage({
          type: 'testResult',
          ok: true,
          message: `✓ Connected to ${profile.host}:${profile.port}/${profile.database}`,
        });
      } catch (err) {
        void this.panel.webview.postMessage({
          type: 'testResult',
          ok: false,
          message: `✗ ${err instanceof Error ? err.message : String(err)}`,
        });
      }
      return;
    }
    if (msg.type === 'save') {
      try {
        await this.host.save(profile, password);
        vscode.window.showInformationMessage(
          `Database Hub: ${this.existing ? 'updated' : 'added'} "${profile.name}".`,
        );
        this.panel.dispose();
      } catch (err) {
        void this.panel.webview.postMessage({
          type: 'testResult',
          ok: false,
          message: `✗ ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    }
  }

  private buildHtml(webview: vscode.Webview, extensionUri: vscode.Uri): string {
    const css = webview.asWebviewUri(
      vscode.Uri.joinPath(extensionUri, 'media', 'connectionForm.css'),
    );
    const js = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', 'connectionForm.js'));
    const nonce = Math.random().toString(36).slice(2) + Date.now().toString(36);
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy"
      content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${css}">
<title>Connection</title>
</head>
<body>
<div class="form">
  <h1 id="title">Add Connection</h1>
  <p class="subtitle" id="subtitle"></p>

  <div class="section">
    <div class="legend">General</div>
    <div class="row"><label for="name">Name</label><input type="text" id="name" placeholder="e.g. Orders DEV"></div>
    <div class="row"><label for="type">Database type</label>
      <select id="type">
        <option value="mssql">Microsoft SQL Server</option>
        <option value="postgres">PostgreSQL</option>
      </select>
    </div>
    <div class="row"><label for="environment">Environment</label>
      <select id="environment">
        <option value="DEV">DEV</option>
        <option value="QA">QA</option>
        <option value="UAT">UAT</option>
        <option value="PROD">PROD</option>
      </select>
      <span class="env-dot" id="env-dot"></span>
    </div>
  </div>

  <div class="section">
    <div class="legend">Server</div>
    <div class="row"><label for="host">Host</label><input type="text" id="host"></div>
    <div class="row"><label for="port">Port</label><input type="number" id="port" min="1" max="65535"></div>
    <div class="row"><label for="database">Database</label><input type="text" id="database"></div>
    <div id="mssql-opts">
      <div class="check"><input type="checkbox" id="encrypt" checked><label for="encrypt">Encrypt connection</label></div>
      <div class="check"><input type="checkbox" id="trustCert" checked><label for="trustCert">Trust server certificate</label></div>
    </div>
    <div id="pg-opts" class="hidden">
      <div class="check"><input type="checkbox" id="ssl"><label for="ssl">Use SSL</label></div>
    </div>
  </div>

  <div class="section">
    <div class="legend">Authentication</div>
    <div class="row" id="mssql-auth"><label for="authType">Method</label>
      <select id="authType">
        <option value="sql">SQL Login</option>
        <option value="ntlm">Windows Authentication (NTLM)</option>
      </select>
    </div>
    <div class="row hidden" id="domain-row"><label for="domain">Domain</label><input type="text" id="domain"></div>
    <div class="row"><label for="user">User name</label><input type="text" id="user"></div>
    <div class="row"><label for="password">Password</label><input type="password" id="password"></div>
    <p class="hint" id="password-hint"></p>
  </div>

  <div class="section">
    <div class="legend">Safety</div>
    <div class="check" style="margin-left:0"><input type="checkbox" id="readOnly"><label for="readOnly">Read only — block all write statements on this connection</label></div>
  </div>

  <div class="buttons">
    <button id="save" class="primary">Save</button>
    <button id="test" class="secondary">Test Connection</button>
    <button id="cancel" class="secondary">Cancel</button>
  </div>
  <div id="status"></div>
</div>
<script nonce="${nonce}" src="${js}"></script>
</body>
</html>`;
  }
}
