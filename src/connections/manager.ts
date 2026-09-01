import * as vscode from 'vscode';
import { Driver } from '../drivers/driver';
import { MssqlDriver } from '../drivers/mssqlDriver';
import { PostgresDriver } from '../drivers/postgresDriver';
import { ConnectionProfile } from '../types';
import { ConnectionStore } from './store';

/**
 * Tracks live connections (one pooled driver per profile) and the
 * "active" connection used as default for new editors.
 */
export class ConnectionManager {
  private readonly drivers = new Map<string, Driver>();
  private readonly connecting = new Map<string, Promise<Driver>>();
  private activeId: string | undefined;

  private readonly _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChange = this._onDidChange.event;

  constructor(private readonly store: ConnectionStore) {}

  isConnected(id: string): boolean {
    return this.drivers.has(id);
  }

  getDriver(id: string): Driver | undefined {
    return this.drivers.get(id);
  }

  get activeConnectionId(): string | undefined {
    return this.activeId;
  }

  setActive(id: string | undefined): void {
    this.activeId = id;
    this._onDidChange.fire();
  }

  connectedIds(): string[] {
    return [...this.drivers.keys()];
  }

  /** Connect (or return the live driver) for a profile. Prompts for a missing password. */
  async connect(profile: ConnectionProfile): Promise<Driver> {
    const existing = this.drivers.get(profile.id);
    if (existing) {
      return existing;
    }
    const inFlight = this.connecting.get(profile.id);
    if (inFlight) {
      return inFlight;
    }
    const task = this.doConnect(profile).finally(() => this.connecting.delete(profile.id));
    this.connecting.set(profile.id, task);
    return task;
  }

  private async doConnect(profile: ConnectionProfile): Promise<Driver> {
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
      profile.type === 'mssql' ? new MssqlDriver(profile) : new PostgresDriver(profile);

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

    this.drivers.set(profile.id, driver);
    this.activeId = profile.id;
    this._onDidChange.fire();
    return driver;
  }

  async disconnect(id: string): Promise<void> {
    const driver = this.drivers.get(id);
    if (!driver) {
      return;
    }
    this.drivers.delete(id);
    if (this.activeId === id) {
      this.activeId = this.connectedIds()[0];
    }
    this._onDidChange.fire();
    await driver.disconnect().catch(() => undefined);
  }

  async disposeAll(): Promise<void> {
    const all = [...this.drivers.values()];
    this.drivers.clear();
    await Promise.allSettled(all.map((d) => d.disconnect()));
  }
}
