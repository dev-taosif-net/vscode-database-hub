import * as vscode from 'vscode';
import { ENV_META, HistoryEntry } from '../types';
import { HistoryStore } from './store';

export class HistoryView implements vscode.TreeDataProvider<HistoryEntry> {
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  constructor(private readonly store: HistoryStore) {
    store.onDidChange(() => this._onDidChangeTreeData.fire());
  }

  getTreeItem(entry: HistoryEntry): vscode.TreeItem {
    const label = entry.sql.replace(/\s+/g, ' ').trim().slice(0, 80) || '(empty)';
    const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.None);
    item.id = entry.id;
    const when = new Date(entry.startedAt);
    item.description = `${entry.success ? `${entry.rowCount} rows` : 'failed'} · ${entry.durationMs} ms · ${entry.connectionName}`;
    item.iconPath = new vscode.ThemeIcon(
      entry.success ? 'history' : 'error',
      new vscode.ThemeColor(
        entry.success ? ENV_META[entry.environment].themeColor : 'errorForeground',
      ),
    );
    item.tooltip = new vscode.MarkdownString(
      `\`\`\`sql\n${entry.sql.slice(0, 1000)}\n\`\`\`\n\n` +
        `${entry.connectionName} (${entry.environment}) · ${entry.database}\n\n` +
        `${when.toLocaleString()} · ${entry.durationMs} ms` +
        (entry.error ? `\n\n**Error:** ${entry.error}` : ''),
    );
    item.contextValue = 'history';
    item.command = {
      command: 'databaseHub.history.open',
      title: 'Open in Editor',
      arguments: [entry],
    };
    return item;
  }

  getChildren(element?: HistoryEntry): HistoryEntry[] {
    return element ? [] : this.store.list();
  }
}
