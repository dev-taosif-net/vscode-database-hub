import * as vscode from 'vscode';
import { ConnectionManager } from '../connections/manager';
import { ConnectionStore } from '../connections/store';
import { ConnectionProfile } from '../types';

interface Binding {
  connectionId: string;
  /** Chosen database for browse-all profiles */
  database?: string;
}

export interface ResolvedBinding {
  profile: ConnectionProfile;
  database?: string;
}

/**
 * Tracks which connection (and database) each SQL editor talks to.
 * Falls back to the globally active connection.
 */
export class EditorBinding {
  private readonly byDocument = new Map<string, Binding>();

  private readonly _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChange = this._onDidChange.event;

  constructor(
    private readonly store: ConnectionStore,
    private readonly manager: ConnectionManager,
  ) {
    vscode.workspace.onDidCloseTextDocument((doc) => {
      this.byDocument.delete(doc.uri.toString());
    });
  }

  bind(doc: vscode.TextDocument, connectionId: string, database?: string): void {
    this.byDocument.set(doc.uri.toString(), { connectionId, database });
    this.manager.setActive(connectionId);
    this._onDidChange.fire();
  }

  getBindingFor(doc: vscode.TextDocument | undefined): ResolvedBinding | undefined {
    if (doc) {
      const bound = this.byDocument.get(doc.uri.toString());
      if (bound) {
        const profile = this.store.get(bound.connectionId);
        if (profile) {
          return { profile, database: bound.database };
        }
        this.byDocument.delete(doc.uri.toString());
      }
    }
    const activeId = this.manager.activeConnectionId;
    const profile = activeId ? this.store.get(activeId) : undefined;
    return profile ? { profile } : undefined;
  }

  getProfileFor(doc: vscode.TextDocument | undefined): ConnectionProfile | undefined {
    return this.getBindingFor(doc)?.profile;
  }
}
