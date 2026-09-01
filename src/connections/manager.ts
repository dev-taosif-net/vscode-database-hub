import * as vscode from 'vscode';
import { Driver } from '../drivers/driver';
import { MssqlDriver } from '../drivers/mssqlDriver';
import { PostgresDriver } from '../drivers/postgresDriver';
import { ConnectionProfile } from '../types';
import { ConnectionStore } from './store';

/**
 * The database a profile talks to when none was chosen: the profile's own
 * database, or the server maintenance database for browse-all profiles.
 */
export function defaultDatabase(profile: ConnectionProfile): string {
  return profile.database || (profile.type === 'mssql' ? 'master' : 'postgres');
}

/**
 * Tracks live connections — one pooled driver per (profile, database) —
 * and the "active" connection used as default for new editors.
 */
export class ConnectionManager {
  private readonly drivers = new Map<string, Driver>();
  private readonly connecting = new Map<string, Promise<Driver>>();
  private activeId: string | undefined;

  private readonly _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChange = this._onDidChange.event;

  constructor(private readonly store: ConnectionStore) {}

  private key(profileId: string, database: string): string {
    return `${profileId}::${database}`;
  }

  /** True when any database of this profile has a live pool */
  isConnected(profileId: string): boolean {
    const prefix = `${profileId}::`;
    for (const k of this.drivers.keys()) {
      if (k.startsWith(prefix)) {
        return true;
      }
    }
    return false;
  }

  getDriver(profile: ConnectionProfile, database?: string): Driver | undefined {
    return this.drivers.get(this.key(profile.id, database ?? defaultDatabase(profile)));
  }

  get activeConnectionId(): string | undefined {
    return this.activeId;
  }

  setActive(id: string | undefined): void {
    this.activeId = id;
    this._onDidChange.fire();
  }

  /** Connect (or return the live driver) for a profile+database. Prompts for a missing password. */
  async connect(profile: ConnectionProfile, database?: string): Promise<Driver> {
    const db = database ?? defaultDatabase(profile);
    const key = this.key(profile.id, db);
    const existing = this.drivers.get(key);
    if (existing) {
      return existing;
    }
    const inFlight = this.connecting.get(key);
    if (inFlight) {
      return inFlight;
    }
    const task = this.doConnect(profile, db, key).finally(() => this.connecting.delete(key));
    this.connecting.set(key, task);
    return task;
  }

  private async doConnect(profile: ConnectionProfile, database: string, key: string): Promise<Driver> {
    let password = await this.store.getPassword(profile.id);
    if (password === undefined) {
      password = await vscode.window.showInputBox({
        prompt: `Password for ${profile.name} (${profile.user})`,
        password: true,
        ignoreFocusOut: true,
      });
      if (password === undefined) {
        throw new Error('Connection cancelled — no password provided.');
      }
      await this.store.setPassword(profile.id, password);
    }

    const driver: Driver =
      profile.type === 'mssql'
        ? new MssqlDriver(profile, database)
        : new PostgresDriver(profile, database);

    const timeoutSeconds = vscode.workspace
      .getConfiguration('databaseHub')
      .get<number>('query.timeoutSeconds', 120);

    try {
      await driver.connect(password, { requestTimeoutMs: Math.max(0, timeoutSeconds) * 1000 });
    } catch (err) {
      // A stored password that fails is likely stale — drop it so the next
      // attempt prompts again instead of failing in a loop.
      if (/password|login|auth/i.test(err instanceof Error ? err.message : String(err))) {
        await this.store.deletePassword(profile.id);
      }
      throw err;
    }

    this.drivers.set(key, driver);
    this.activeId = profile.id;
    this._onDidChange.fire();
    return driver;
  }

  /** Close every pool belonging to this profile */
  async disconnect(profileId: string): Promise<void> {
    const prefix = `${profileId}::`;
    const closing: Driver[] = [];
    for (const [k, driver] of this.drivers) {
      if (k.startsWith(prefix)) {
        closing.push(driver);
        this.drivers.delete(k);
      }
    }
    if (closing.length === 0) {
      return;
    }
    if (this.activeId === profileId) {
      const next = this.drivers.keys().next();
      this.activeId = next.done ? undefined : next.value.split('::')[0];
    }
    this._onDidChange.fire();
    await Promise.allSettled(closing.map((d) => d.disconnect()));
  }

  async disposeAll(): Promise<void> {
    const all = [...this.drivers.values()];
    this.drivers.clear();
    await Promise.allSettled(all.map((d) => d.disconnect()));
  }
}
