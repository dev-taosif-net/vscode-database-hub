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
    const profile = this.binding.getProfileFor(doc);

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
    this.item.text = `$(database) ${profile.name} · ${profile.database}${profile.readOnly ? ' $(lock)' : ''}`;
    this.item.tooltip = new vscode.MarkdownString(
      `**${profile.name}** — ${profile.environment}${profile.readOnly ? ' (read only)' : ''}\n\n` +
        `${profile.host}:${profile.port}/${profile.database}\n\n` +
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
