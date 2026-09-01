import * as vscode from 'vscode';
import { FavoriteEntry } from '../types';
import { FavoritesStore } from './store';

const KIND_ICON: Record<string, string> = {
  table: 'table',
  view: 'window',
  procedure: 'gear',
  function: 'symbol-function',
  query: 'code',
};

export class FavoritesView implements vscode.TreeDataProvider<FavoriteEntry> {
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  constructor(private readonly store: FavoritesStore) {
    store.onDidChange(() => this._onDidChangeTreeData.fire());
  }

  getTreeItem(entry: FavoriteEntry): vscode.TreeItem {
    const item = new vscode.TreeItem(entry.label, vscode.TreeItemCollapsibleState.None);
    item.id = entry.id;
    item.description = entry.connectionName;
    item.iconPath = new vscode.ThemeIcon(
      entry.kind === 'query' ? KIND_ICON.query : KIND_ICON[entry.objectType ?? 'table'] ?? 'star',
    );
    item.contextValue = 'favorite';
    item.tooltip = entry.kind === 'query' ? entry.sql : `${entry.schema}.${entry.name}`;
    item.command = {
      command: 'databaseHub.favorites.open',
      title: 'Open Favorite',
      arguments: [entry],
    };
    return item;
  }

  getChildren(element?: FavoriteEntry): FavoriteEntry[] {
    return element ? [] : this.store.list();
  }
}
