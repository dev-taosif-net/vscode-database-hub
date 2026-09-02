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

const STORAGE_KEY = 'databaseHub.editorBindings';

/**
 * Tracks which connection (and database) each SQL editor talks to.
 * Falls back to the globally active connection.
 *
 * Bindings are persisted to workspaceState and revived on activation for
 * editors that survived the reload (hot exit restores untitled tabs under
 * their original URIs), so the status bar keeps showing the database a tab
 * will actually run against instead of resetting to the server default.
 */
export class EditorBinding {
  private readonly byDocument = new Map<string, Binding>();

  private readonly _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChange = this._onDidChange.event;

  constructor(
    private readonly store: ConnectionStore,
    private readonly manager: ConnectionManager,
    private readonly memento: vscode.Memento,
  ) {
    this.restore();
    vscode.workspace.onDidCloseTextDocument((doc) => {
      if (this.byDocument.delete(doc.uri.toString())) {
        this.persist();
        this._onDidChange.fire();
      }
    });
  }

  /**
   * Revive persisted bindings, but only for tabs that are actually open and
   * connections that still exist — untitled names get reused across windows,
   * so anything else would attach an old database to an unrelated editor.
   */
  private restore(): void {
    const saved = this.memento.get<Record<string, Binding>>(STORAGE_KEY, {});
    const openUris = new Set<string>();
    for (const group of vscode.window.tabGroups.all) {
      for (const tab of group.tabs) {
        if (tab.input instanceof vscode.TabInputText) {
          openUris.add(tab.input.uri.toString());
        }
      }
    }
    for (const [uri, binding] of Object.entries(saved)) {
      if (openUris.has(uri) && binding?.connectionId && this.store.get(binding.connectionId)) {
        this.byDocument.set(uri, binding);
      }
    }
    this.persist();
  }

  private persist(): void {
    void this.memento.update(STORAGE_KEY, Object.fromEntries(this.byDocument));
  }

  bind(doc: vscode.TextDocument, connectionId: string, database?: string): void {
    this.byDocument.set(doc.uri.toString(), { connectionId, database });
    this.persist();
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
        this.persist();
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
