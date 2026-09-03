import * as vscode from 'vscode';
import { DbObject, ObjectType } from '../types';

const STATE_KEY = 'databaseHub.folderFilters';

/**
 * Persistent explorer folder filters: one per connection + database + object
 * type, so in Schema Focus Mode the same filter applies under every schema.
 * Filtering happens client-side over the cached object list — no extra
 * round-trips, and search / IntelliSense keep seeing every object.
 */
export class FolderFilterStore {
  private readonly _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChange = this._onDidChange.event;

  constructor(private readonly context: vscode.ExtensionContext) {}

  private static key(connectionId: string, database: string, type: ObjectType): string {
    return `${connectionId}|${database}|${type}`;
  }

  private all(): Record<string, string> {
    return this.context.globalState.get<Record<string, string>>(STATE_KEY, {});
  }

  get(connectionId: string, database: string, type: ObjectType): string | undefined {
    return this.all()[FolderFilterStore.key(connectionId, database, type)];
  }

  /** Empty / whitespace text clears the filter. */
  async set(
    connectionId: string,
    database: string,
    type: ObjectType,
    text: string,
  ): Promise<void> {
    const key = FolderFilterStore.key(connectionId, database, type);
    const all = { ...this.all() };
    const normalized = text.trim();
    if (normalized) {
      all[key] = normalized;
    } else {
      delete all[key];
    }
    await this.context.globalState.update(STATE_KEY, all);
    this._onDidChange.fire();
  }

  clear(connectionId: string, database: string, type: ObjectType): Promise<void> {
    return this.set(connectionId, database, type, '');
  }

  /** Drop every filter of a deleted connection. */
  async clearConnection(connectionId: string): Promise<void> {
    const prefix = `${connectionId}|`;
    const all = this.all();
    const kept = Object.fromEntries(Object.entries(all).filter(([k]) => !k.startsWith(prefix)));
    if (Object.keys(kept).length === Object.keys(all).length) {
      return;
    }
    await this.context.globalState.update(STATE_KEY, kept);
    this._onDidChange.fire();
  }

  /** Objects whose `schema.name` matches any comma-separated term of the filter. */
  apply(text: string | undefined, objects: DbObject[]): DbObject[] {
    const terms = compileTerms(text);
    if (terms.length === 0) {
      return objects;
    }
    return objects.filter((o) => {
      const qualified = `${o.schema}.${o.name}`;
      return terms.some((re) => re.test(qualified));
    });
  }
}

/**
 * `"ord*, dbo.cust"` → one case-insensitive regex per term. Terms match
 * anywhere in `schema.name`; `*` matches any run of characters; everything
 * else is literal.
 */
export function compileTerms(text: string | undefined): RegExp[] {
  if (!text) {
    return [];
  }
  return text
    .split(',')
    .map((t) => t.trim())
    .filter((t) => t.length > 0)
    .map((t) => new RegExp(t.split('*').map(escapeRegExp).join('.*'), 'i'));
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
