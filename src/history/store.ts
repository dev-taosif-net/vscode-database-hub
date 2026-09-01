import * as crypto from 'crypto';
import * as vscode from 'vscode';
import { HistoryEntry } from '../types';

const STATE_KEY = 'databaseHub.history';
const MAX_SQL_LENGTH = 20_000;

export class HistoryStore {
  private readonly _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChange = this._onDidChange.event;

  constructor(private readonly context: vscode.ExtensionContext) {}

  list(): HistoryEntry[] {
    return this.context.globalState.get<HistoryEntry[]>(STATE_KEY, []);
  }

  async add(entry: Omit<HistoryEntry, 'id'>): Promise<void> {
    const max = vscode.workspace
      .getConfiguration('databaseHub')
      .get<number>('history.maxEntries', 200);
    const all = this.list();
    all.unshift({
      ...entry,
      sql: entry.sql.length > MAX_SQL_LENGTH ? entry.sql.slice(0, MAX_SQL_LENGTH) : entry.sql,
      id: crypto.randomUUID(),
    });
    await this.context.globalState.update(STATE_KEY, all.slice(0, max));
    this._onDidChange.fire();
  }

  async remove(id: string): Promise<void> {
    await this.context.globalState.update(
      STATE_KEY,
      this.list().filter((e) => e.id !== id),
    );
    this._onDidChange.fire();
  }

  async clear(): Promise<void> {
    await this.context.globalState.update(STATE_KEY, []);
    this._onDidChange.fire();
  }
}
