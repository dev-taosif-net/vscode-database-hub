import * as vscode from 'vscode';
import { ConnectionProfile } from '../types';

const STATE_KEY = 'databaseHub.connections';
const SECRET_PREFIX = 'databaseHub.password.';

/** Profiles live in globalState; passwords live in SecretStorage only. */
export class ConnectionStore {
  constructor(private readonly context: vscode.ExtensionContext) {}

  list(): ConnectionProfile[] {
    return this.context.globalState.get<ConnectionProfile[]>(STATE_KEY, []);
  }

  get(id: string): ConnectionProfile | undefined {
    return this.list().find((p) => p.id === id);
  }

  async save(profile: ConnectionProfile): Promise<void> {
    const all = this.list().filter((p) => p.id !== profile.id);
    all.push(profile);
    all.sort((a, b) => a.name.localeCompare(b.name));
    await this.context.globalState.update(STATE_KEY, all);
  }

  async delete(id: string): Promise<void> {
    await this.context.globalState.update(
      STATE_KEY,
      this.list().filter((p) => p.id !== id),
    );
    await this.deletePassword(id);
  }

  getPassword(id: string): Thenable<string | undefined> {
    return this.context.secrets.get(SECRET_PREFIX + id);
  }

  async setPassword(id: string, password: string): Promise<void> {
    await this.context.secrets.store(SECRET_PREFIX + id, password);
  }

  async deletePassword(id: string): Promise<void> {
    await this.context.secrets.delete(SECRET_PREFIX + id);
  }
}
