import * as vscode from 'vscode';
import { ConnectionManager } from '../connections/manager';
import { ConnectionStore } from '../connections/store';
import { ConnectionProfile } from '../types';

/**
 * Tracks which connection each SQL editor talks to.
 * Falls back to the globally active connection.
 */
export class EditorBinding {
  private readonly byDocument = new Map<string, string>();

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

  bind(doc: vscode.TextDocument, connectionId: string): void {
    this.byDocument.set(doc.uri.toString(), connectionId);
    this.manager.setActive(connectionId);
    this._onDidChange.fire();
  }

  getProfileFor(doc: vscode.TextDocument | undefined): ConnectionProfile | undefined {
    if (doc) {
      const bound = this.byDocument.get(doc.uri.toString());
      if (bound) {
        const profile = this.store.get(bound);
        if (profile) {
          return profile;
        }
        this.byDocument.delete(doc.uri.toString());
      }
    }
    const activeId = this.manager.activeConnectionId;
    return activeId ? this.store.get(activeId) : undefined;
  }
}
