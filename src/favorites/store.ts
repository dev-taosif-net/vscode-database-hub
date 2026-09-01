import * as crypto from 'crypto';
import * as vscode from 'vscode';
import { FavoriteEntry } from '../types';

const STATE_KEY = 'databaseHub.favorites';

export class FavoritesStore {
  private readonly _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChange = this._onDidChange.event;

  constructor(private readonly context: vscode.ExtensionContext) {}

  list(): FavoriteEntry[] {
    return this.context.globalState.get<FavoriteEntry[]>(STATE_KEY, []);
  }

  async add(entry: Omit<FavoriteEntry, 'id'>): Promise<void> {
    const all = this.list();
    // Object favorites are unique per connection+object; query favorites per sql text.
    const duplicate = all.some(
      (f) =>
        f.kind === entry.kind &&
        f.connectionId === entry.connectionId &&
        (entry.kind === 'object'
          ? f.schema === entry.schema && f.name === entry.name && f.objectType === entry.objectType
          : f.sql === entry.sql),
    );
    if (duplicate) {
      return;
    }
    all.push({ ...entry, id: crypto.randomUUID() });
    await this.context.globalState.update(STATE_KEY, all);
    this._onDidChange.fire();
  }

  async remove(id: string): Promise<void> {
    await this.context.globalState.update(
      STATE_KEY,
      this.list().filter((f) => f.id !== id),
    );
    this._onDidChange.fire();
  }
}
