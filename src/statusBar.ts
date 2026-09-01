import * as vscode from 'vscode';
import { ConnectionManager } from './connections/manager';
import { EditorBinding } from './query/editorBinding';
import { ENV_META } from './types';

export class StatusBar implements vscode.Disposable {
  private readonly item: vscode.StatusBarItem;
  private readonly disposables: vscode.Disposable[] = [];

  constructor(
    private readonly manager: ConnectionManager,
    private readonly binding: EditorBinding,
  ) {
    this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 200);
    this.item.command = 'databaseHub.pickActiveConnection';
    this.disposables.push(
      this.item,
      vscode.window.onDidChangeActiveTextEditor(() => this.update()),
      manager.onDidChange(() => this.update()),
      binding.onDidChange(() => this.update()),
    );
    this.update();
  }

  update(): void {
    const editor = vscode.window.activeTextEditor;
    const doc = editor?.document.languageId === 'sql' ? editor.document : undefined;
    const resolved = this.binding.getBindingFor(doc);
    const profile = resolved?.profile;

    if (!profile) {
      this.item.text = '$(database) No connection';
      this.item.tooltip = 'Database Hub: pick a connection';
      this.item.color = undefined;
      this.item.backgroundColor = undefined;
      this.item.show();
      return;
    }

    const connected = this.manager.isConnected(profile.id);
    const env = ENV_META[profile.environment];
    const db = resolved?.database || profile.database || 'all databases';
    const endpoint = profile.port ? `${profile.host}:${profile.port}` : profile.host;
    const user =
      profile.authType === 'ntlm' && profile.domain
        ? `${profile.domain}\\${profile.user}`
        : profile.user;
    this.item.text = `$(database) ${endpoint}/${db} · ${user}${profile.readOnly ? ' $(lock)' : ''}`;
    this.item.tooltip = new vscode.MarkdownString(
      `**${profile.name}** — ${profile.environment}${profile.readOnly ? ' (read only)' : ''}\n\n` +
        `${endpoint}/${db} · ${user}\n\n` +
        `${connected ? '$(pass) Connected' : '$(circle-slash) Not connected'} — click to switch`,
      true,
    );

    // PROD screams, UAT warns, everything else gets the env accent color.
    if (profile.environment === 'PROD') {
      this.item.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
      this.item.color = undefined;
    } else if (profile.environment === 'UAT') {
      this.item.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
      this.item.color = undefined;
    } else {
      this.item.backgroundColor = undefined;
      this.item.color = new vscode.ThemeColor(env.themeColor);
    }
    this.item.show();
  }

  dispose(): void {
    this.disposables.forEach((d) => d.dispose());
  }
}
