import * as vscode from 'vscode';
import { ConnectionEditorHost, ConnectionEditorPanel } from './connections/editorPanel';
import { ConnectionManager } from './connections/manager';
import { ConnectionStore } from './connections/store';
import { MssqlDriver } from './drivers/mssqlDriver';
import { PostgresDriver } from './drivers/postgresDriver';
import { MetadataCache } from './explorer/cache';
import { HubNode, ObjectExplorer } from './explorer/tree';
import { FavoritesStore } from './favorites/store';
import { FavoritesView } from './favorites/view';
import { HistoryStore } from './history/store';
import { HistoryView } from './history/view';
import { EditorBinding } from './query/editorBinding';
import { Executor } from './query/executor';
import { SnippetsView } from './snippets/view';
import { StatusBar } from './statusBar';
import {
  ConnectionProfile,
  DbObject,
  FavoriteEntry,
  HistoryEntry,
  ObjectType,
  SnippetDef,
} from './types';

let manager: ConnectionManager | undefined;

export function activate(context: vscode.ExtensionContext): void {
  const store = new ConnectionStore(context);
  manager = new ConnectionManager(store);
  const cache = new MetadataCache();
  const historyStore = new HistoryStore(context);
  const favoritesStore = new FavoritesStore(context);
  const binding = new EditorBinding(store, manager);
  const executor = new Executor(manager, historyStore, context.extensionUri);
  const explorer = new ObjectExplorer(store, manager, cache);

  context.subscriptions.push(
    vscode.window.createTreeView('databaseHubConnections', {
      treeDataProvider: explorer,
      showCollapseAll: true,
    }),
    vscode.window.registerTreeDataProvider('databaseHubHistory', new HistoryView(historyStore)),
    vscode.window.registerTreeDataProvider('databaseHubFavorites', new FavoritesView(favoritesStore)),
    vscode.window.registerTreeDataProvider('databaseHubSnippets', new SnippetsView()),
    new StatusBar(manager, binding),
  );

  const mgr = manager;

  // ---------- helpers ----------

  async function pickProfile(placeHolder: string): Promise<ConnectionProfile | undefined> {
    const profiles = store.list();
    if (profiles.length === 0) {
      const add = await vscode.window.showInformationMessage(
        'Database Hub: no connections defined yet.',
        'Add Connection',
      );
      if (add) {
        await vscode.commands.executeCommand('databaseHub.addConnection');
      }
      return undefined;
    }
    const picked = await vscode.window.showQuickPick(
      profiles.map((p) => ({
        label: `$(database) ${p.name}`,
        description: `[${p.environment}]${p.readOnly ? ' 🔒' : ''} ${p.host}/${p.database}`,
        detail: mgr.isConnected(p.id) ? 'Connected' : undefined,
        profile: p,
      })),
      { placeHolder },
    );
    return picked?.profile;
  }

  async function ensureConnected(profile: ConnectionProfile) {
    if (mgr.isConnected(profile.id)) {
      return mgr.getDriver(profile.id)!;
    }
    return vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `Connecting to ${profile.name} (${profile.environment})…`,
      },
      () => mgr.connect(profile),
    );
  }

  async function openSqlEditor(
    content: string,
    profile?: ConnectionProfile,
  ): Promise<vscode.TextDocument> {
    const doc = await vscode.workspace.openTextDocument({ language: 'sql', content });
    await vscode.window.showTextDocument(doc, vscode.ViewColumn.One);
    if (profile) {
      binding.bind(doc, profile.id);
    }
    return doc;
  }

  async function resolveNodeProfile(node?: HubNode): Promise<ConnectionProfile | undefined> {
    if (node?.connectionId) {
      return store.get(node.connectionId);
    }
    return pickProfile('Select a connection');
  }

  function quoteFor(profile: ConnectionProfile, name: string): string {
    return profile.type === 'mssql'
      ? `[${name.replace(/]/g, ']]')}]`
      : `"${name.replace(/"/g, '""')}"`;
  }

  async function executeFromEditor(mode: 'smart' | 'all' | 'selection'): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.document.languageId !== 'sql') {
      vscode.window.showWarningMessage('Database Hub: open a SQL editor to execute queries.');
      return;
    }
    let sql: string;
    if (mode === 'all') {
      sql = editor.document.getText();
    } else if (mode === 'selection') {
      sql = editor.document.getText(editor.selection);
      if (!sql.trim()) {
        vscode.window.showWarningMessage('Database Hub: select some SQL first.');
        return;
      }
    } else {
      sql = editor.selection.isEmpty
        ? editor.document.getText()
        : editor.document.getText(editor.selection);
    }

    let profile = binding.getProfileFor(editor.document);
    if (!profile) {
      profile = await pickProfile('Select a connection for this editor');
      if (!profile) {
        return;
      }
      binding.bind(editor.document, profile.id);
    }
    await executor.runSql(profile, sql);
  }

  const register = (
    command: string,
    callback: (...args: never[]) => unknown,
  ): void => {
    context.subscriptions.push(
      vscode.commands.registerCommand(command, async (...args: unknown[]) => {
        try {
          await (callback as (...a: unknown[]) => Promise<unknown>)(...args);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          if (!/cancelled/i.test(message)) {
            vscode.window.showErrorMessage(`Database Hub: ${message}`);
          }
        }
      }),
    );
  };

  // ---------- connection commands ----------

  const connectionEditorHost: ConnectionEditorHost = {
    async save(profile, password) {
      if (mgr.isConnected(profile.id)) {
        await mgr.disconnect(profile.id);
        cache.invalidateConnection(profile.id);
      }
      await store.save(profile);
      if (password !== undefined) {
        await store.setPassword(profile.id, password);
      }
      explorer.refresh();
    },
    async test(profile, password) {
      const pw = password ?? (await store.getPassword(profile.id)) ?? '';
      const driver =
        profile.type === 'mssql' ? new MssqlDriver(profile) : new PostgresDriver(profile);
      try {
        await driver.connect(pw, { requestTimeoutMs: 15000 });
      } finally {
        await driver.disconnect().catch(() => undefined);
      }
    },
  };

  register('databaseHub.addConnection', () => {
    ConnectionEditorPanel.show(context.extensionUri, connectionEditorHost);
  });

  register('databaseHub.editConnection', async (node?: HubNode) => {
    const existing = await resolveNodeProfile(node);
    if (existing) {
      ConnectionEditorPanel.show(context.extensionUri, connectionEditorHost, existing);
    }
  });

  register('databaseHub.deleteConnection', async (node?: HubNode) => {
    const profile = await resolveNodeProfile(node);
    if (!profile) {
      return;
    }
    const choice = await vscode.window.showWarningMessage(
      `Delete connection "${profile.name}"?`,
      { modal: true },
      'Delete',
    );
    if (choice !== 'Delete') {
      return;
    }
    await mgr.disconnect(profile.id);
    cache.invalidateConnection(profile.id);
    await store.delete(profile.id);
    explorer.refresh();
  });

  register('databaseHub.connect', async (node?: HubNode) => {
    const profile = await resolveNodeProfile(node);
    if (profile) {
      await ensureConnected(profile);
    }
  });

  register('databaseHub.disconnect', async (node?: HubNode) => {
    const profile = await resolveNodeProfile(node);
    if (profile) {
      await mgr.disconnect(profile.id);
      cache.invalidateConnection(profile.id);
    }
  });

  register('databaseHub.newQuery', async (node?: HubNode) => {
    const profile = await resolveNodeProfile(node);
    if (!profile) {
      return;
    }
    await ensureConnected(profile);
    await openSqlEditor(
      `-- ${profile.name} (${profile.environment}) · ${profile.host}/${profile.database}\n\n`,
      profile,
    );
  });

  // ---------- explorer commands ----------

  register('databaseHub.refreshExplorer', () => {
    cache.invalidateAll();
    explorer.refresh();
  });

  register('databaseHub.refreshNode', (node?: HubNode) => {
    if (node) {
      cache.invalidateConnection(node.connectionId);
    }
    explorer.refresh();
  });

  register('databaseHub.toggleSchemaMode', async () => {
    const config = vscode.workspace.getConfiguration('databaseHub');
    const current = config.get<boolean>('explorer.groupBySchema', false);
    await config.update('explorer.groupBySchema', !current, vscode.ConfigurationTarget.Global);
    explorer.refresh();
    vscode.window.setStatusBarMessage(
      `Database Hub: ${!current ? 'Schema Focus Mode' : 'General Mode'}`,
      2000,
    );
  });

  register('databaseHub.selectTop1000', async (node?: HubNode) => {
    if (!node?.obj) {
      return;
    }
    const profile = store.get(node.connectionId);
    if (!profile) {
      return;
    }
    const driver = await ensureConnected(profile);
    const sql = driver.buildSelectTop(node.obj.schema, node.obj.name, 1000);
    await openSqlEditor(sql, profile);
    await executor.runSql(profile, sql);
  });

  register('databaseHub.scriptCreate', async (node?: HubNode) => {
    if (!node?.obj) {
      return;
    }
    const profile = store.get(node.connectionId);
    if (!profile) {
      return;
    }
    const driver = await ensureConnected(profile);
    const definition = await driver.getDefinition(node.obj);
    await openSqlEditor(definition, profile);
  });

  register('databaseHub.copyObjectName', async (node?: HubNode) => {
    if (!node?.obj) {
      return;
    }
    const profile = store.get(node.connectionId);
    if (!profile) {
      return;
    }
    await vscode.env.clipboard.writeText(
      `${quoteFor(profile, node.obj.schema)}.${quoteFor(profile, node.obj.name)}`,
    );
  });

  register('databaseHub.addObjectFavorite', async (node?: HubNode) => {
    if (!node?.obj) {
      return;
    }
    const profile = store.get(node.connectionId);
    await favoritesStore.add({
      kind: 'object',
      label: `${node.obj.schema}.${node.obj.name}`,
      connectionId: node.connectionId,
      connectionName: profile?.name,
      objectType: node.obj.type,
      schema: node.obj.schema,
      name: node.obj.name,
    });
  });

  register('databaseHub.searchObjects', async () => {
    const activeId = mgr.activeConnectionId;
    const profile = activeId ? store.get(activeId) : await pickProfile('Search objects in…');
    if (!profile) {
      return;
    }
    const driver = await ensureConnected(profile);
    const types: ObjectType[] = ['table', 'view', 'procedure', 'function', 'trigger', 'sequence'];
    const icon: Record<ObjectType, string> = {
      table: 'table',
      view: 'window',
      procedure: 'gear',
      function: 'symbol-function',
      trigger: 'zap',
      sequence: 'list-ordered',
    };
    const lists = await Promise.all(
      types.map((t) => cache.listObjects(profile.id, driver, t)),
    );
    const items = lists.flat().map((o) => ({
      label: `$(${icon[o.type]}) ${o.schema}.${o.name}`,
      description: o.type + (o.detail ? ` · ${o.detail}` : ''),
      obj: o,
    }));
    const picked = await vscode.window.showQuickPick(items, {
      placeHolder: `Search ${items.length.toLocaleString()} objects in ${profile.name}…`,
      matchOnDescription: true,
    });
    if (!picked) {
      return;
    }
    const o: DbObject = picked.obj;
    if (o.type === 'table' || o.type === 'view') {
      const sql = driver.buildSelectTop(o.schema, o.name, 1000);
      await openSqlEditor(sql, profile);
      await executor.runSql(profile, sql);
    } else if (o.type === 'procedure' || o.type === 'function') {
      const definition = await driver.getDefinition(o);
      await openSqlEditor(definition, profile);
    } else {
      await vscode.env.clipboard.writeText(
        `${quoteFor(profile, o.schema)}.${quoteFor(profile, o.name)}`,
      );
      vscode.window.showInformationMessage(`Database Hub: copied ${o.schema}.${o.name}`);
    }
  });

  // ---------- query commands ----------

  register('databaseHub.execute', () => executeFromEditor('smart'));
  register('databaseHub.executeAll', () => executeFromEditor('all'));
  register('databaseHub.executeSelection', () => executeFromEditor('selection'));
  register('databaseHub.cancelQuery', () => executor.cancel());

  register('databaseHub.selectConnectionForEditor', async () => {
    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.document.languageId !== 'sql') {
      vscode.window.showWarningMessage('Database Hub: open a SQL editor first.');
      return;
    }
    const profile = await pickProfile('Select a connection for this editor');
    if (profile) {
      binding.bind(editor.document, profile.id);
    }
  });

  register('databaseHub.pickActiveConnection', async () => {
    const profile = await pickProfile('Switch active connection');
    if (!profile) {
      return;
    }
    await ensureConnected(profile);
    const editor = vscode.window.activeTextEditor;
    if (editor && editor.document.languageId === 'sql') {
      binding.bind(editor.document, profile.id);
    } else {
      mgr.setActive(profile.id);
    }
  });

  // ---------- history commands ----------

  register('databaseHub.history.open', async (entry?: HistoryEntry) => {
    if (entry) {
      await openSqlEditor(entry.sql, store.get(entry.connectionId));
    }
  });

  register('databaseHub.history.rerun', async (entry?: HistoryEntry) => {
    if (!entry) {
      return;
    }
    const profile = store.get(entry.connectionId);
    if (!profile) {
      vscode.window.showWarningMessage('Database Hub: that connection no longer exists.');
      return;
    }
    await ensureConnected(profile);
    await executor.runSql(profile, entry.sql);
  });

  register('databaseHub.history.copy', async (entry?: HistoryEntry) => {
    if (entry) {
      await vscode.env.clipboard.writeText(entry.sql);
    }
  });

  register('databaseHub.history.favorite', async (entry?: HistoryEntry) => {
    if (!entry) {
      return;
    }
    await favoritesStore.add({
      kind: 'query',
      label: entry.sql.replace(/\s+/g, ' ').trim().slice(0, 60),
      connectionId: entry.connectionId,
      connectionName: entry.connectionName,
      sql: entry.sql,
    });
  });

  register('databaseHub.history.delete', async (entry?: HistoryEntry) => {
    if (entry) {
      await historyStore.remove(entry.id);
    }
  });

  register('databaseHub.history.clear', async () => {
    const choice = await vscode.window.showWarningMessage(
      'Clear all query history?',
      { modal: true },
      'Clear',
    );
    if (choice === 'Clear') {
      await historyStore.clear();
    }
  });

  register('databaseHub.history.search', async () => {
    const entries = historyStore.list();
    const picked = await vscode.window.showQuickPick(
      entries.map((e) => ({
        label: e.sql.replace(/\s+/g, ' ').trim().slice(0, 100),
        description: `${e.connectionName} · ${new Date(e.startedAt).toLocaleString()}`,
        detail: e.success ? `${e.rowCount} rows · ${e.durationMs} ms` : `failed: ${e.error ?? ''}`,
        entry: e,
      })),
      { placeHolder: 'Search query history…', matchOnDescription: true, matchOnDetail: true },
    );
    if (picked) {
      await openSqlEditor(picked.entry.sql, store.get(picked.entry.connectionId));
    }
  });

  // ---------- favorites commands ----------

  register('databaseHub.favorites.open', async (entry?: FavoriteEntry) => {
    if (!entry) {
      return;
    }
    const profile = entry.connectionId ? store.get(entry.connectionId) : undefined;
    if (entry.kind === 'query') {
      await openSqlEditor(entry.sql ?? '', profile);
      return;
    }
    if (!profile || !entry.schema || !entry.name) {
      vscode.window.showWarningMessage('Database Hub: that connection no longer exists.');
      return;
    }
    const driver = await ensureConnected(profile);
    if (entry.objectType === 'table' || entry.objectType === 'view') {
      const sql = driver.buildSelectTop(entry.schema, entry.name, 1000);
      await openSqlEditor(sql, profile);
      await executor.runSql(profile, sql);
    } else {
      const definition = await driver.getDefinition({
        type: entry.objectType ?? 'procedure',
        schema: entry.schema,
        name: entry.name,
      });
      await openSqlEditor(definition, profile);
    }
  });

  register('databaseHub.favorites.remove', async (entry?: FavoriteEntry) => {
    if (entry) {
      await favoritesStore.remove(entry.id);
    }
  });

  // ---------- snippets ----------

  register('databaseHub.snippets.insert', async (snippet?: SnippetDef) => {
    if (!snippet) {
      return;
    }
    let editor = vscode.window.activeTextEditor;
    if (!editor || editor.document.languageId !== 'sql') {
      const doc = await openSqlEditor('');
      editor = vscode.window.visibleTextEditors.find((e) => e.document === doc);
    }
    await editor?.insertSnippet(new vscode.SnippetString(snippet.body));
  });
}

export async function deactivate(): Promise<void> {
  await manager?.disposeAll();
}
