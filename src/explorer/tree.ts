import * as vscode from 'vscode';
import { ConnectionManager, defaultDatabase } from '../connections/manager';
import { ConnectionStore } from '../connections/store';
import { Driver } from '../drivers/driver';
import {
  ColumnInfo,
  ConnectionProfile,
  ENV_META,
  OBJECT_TYPE_LABEL,
  ObjectType,
} from '../types';
import { MetadataCache } from './cache';

export type NodeKind =
  | 'connection'
  | 'database'
  | 'folder'
  | 'schema'
  | 'object'
  | 'column'
  | 'parameter';

export interface HubNode {
  kind: NodeKind;
  connectionId: string;
  /** Effective database for this node (set on everything below connection) */
  database?: string;
  objectType?: ObjectType;
  schema?: string;
  obj?: import('../types').DbObject;
  column?: ColumnInfo;
  param?: import('../types').ParameterInfo;
}

export const OBJECT_ICON: Record<ObjectType, string> = {
  table: 'table',
  view: 'window',
  procedure: 'gear',
  function: 'symbol-function',
  trigger: 'zap',
  sequence: 'list-ordered',
};

const FOLDER_ORDER: ObjectType[] = [
  'table',
  'view',
  'procedure',
  'function',
  'trigger',
  'sequence',
];

export class ObjectExplorer implements vscode.TreeDataProvider<HubNode> {
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<HubNode | undefined>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  constructor(
    private readonly store: ConnectionStore,
    private readonly manager: ConnectionManager,
    private readonly cache: MetadataCache,
  ) {
    manager.onDidChange(() => this.refresh());
    cache.onDidRefresh(() => this.refresh());
  }

  refresh(node?: HubNode): void {
    this._onDidChangeTreeData.fire(node);
  }

  private get groupBySchema(): boolean {
    return vscode.workspace
      .getConfiguration('databaseHub')
      .get<boolean>('explorer.groupBySchema', false);
  }

  getTreeItem(node: HubNode): vscode.TreeItem {
    switch (node.kind) {
      case 'connection':
        return this.connectionItem(node);
      case 'database': {
        const item = new vscode.TreeItem(
          node.database ?? '',
          vscode.TreeItemCollapsibleState.Collapsed,
        );
        item.id = `${node.connectionId}|db|${node.database}`;
        item.iconPath = new vscode.ThemeIcon('database');
        item.contextValue = 'database';
        return item;
      }
      case 'folder': {
        const item = new vscode.TreeItem(
          OBJECT_TYPE_LABEL[node.objectType!],
          vscode.TreeItemCollapsibleState.Collapsed,
        );
        item.id = `${node.connectionId}|${node.database}|folder|${node.objectType}|${node.schema ?? ''}`;
        item.iconPath = new vscode.ThemeIcon('folder');
        item.contextValue = `folder-${node.objectType}`;
        return item;
      }
      case 'schema': {
        const item = new vscode.TreeItem(
          node.schema ?? '',
          vscode.TreeItemCollapsibleState.Collapsed,
        );
        item.id = `${node.connectionId}|${node.database}|schema|${node.schema}`;
        item.iconPath = new vscode.ThemeIcon('symbol-namespace');
        item.contextValue = 'schema';
        return item;
      }
      case 'object':
        return this.objectItem(node);
      case 'column': {
        const c = node.column!;
        const item = new vscode.TreeItem(c.name, vscode.TreeItemCollapsibleState.None);
        item.description = `${c.dataType}${c.nullable ? '' : ' not null'}${c.isIdentity ? ' identity' : ''}`;
        item.iconPath = new vscode.ThemeIcon(
          c.isPrimaryKey ? 'key' : 'symbol-field',
          c.isPrimaryKey ? new vscode.ThemeColor('charts.yellow') : undefined,
        );
        item.contextValue = 'column';
        return item;
      }
      case 'parameter': {
        const p = node.param!;
        const item = new vscode.TreeItem(p.name, vscode.TreeItemCollapsibleState.None);
        item.description = `${p.dataType}${p.isOutput ? ' OUT' : ''}`;
        item.iconPath = new vscode.ThemeIcon('symbol-parameter');
        item.contextValue = 'parameter';
        return item;
      }
    }
  }

  private connectionItem(node: HubNode): vscode.TreeItem {
    const profile = this.store.get(node.connectionId);
    const connected = this.manager.isConnected(node.connectionId);
    const item = new vscode.TreeItem(
      profile?.name ?? node.connectionId,
      connected ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None,
    );
    item.id = node.connectionId;
    if (profile) {
      const env = ENV_META[profile.environment];
      const target = profile.database || 'all databases';
      item.description = `${profile.environment}${profile.readOnly ? ' 🔒' : ''} · ${profile.host}/${target}`;
      item.iconPath = new vscode.ThemeIcon(
        connected ? 'circle-filled' : 'circle-outline',
        connected ? new vscode.ThemeColor(env.themeColor) : new vscode.ThemeColor('errorForeground'),
      );
      const endpoint = profile.port ? `${profile.host}:${profile.port}` : profile.host;
      item.tooltip = new vscode.MarkdownString(
        `**${profile.name}** — ${profile.environment}\n\n` +
          `${profile.type === 'mssql' ? 'SQL Server' : 'PostgreSQL'} · ${endpoint}/${target}\n\n` +
          `${profile.readOnly ? '**Read Only**\n\n' : ''}${connected ? 'Connected' : 'Not connected'}`,
      );
    }
    item.contextValue = connected ? 'connection-on' : 'connection-off';
    if (!connected) {
      item.command = {
        command: 'databaseHub.connect',
        title: 'Connect',
        arguments: [node],
      };
    }
    return item;
  }

  private objectItem(node: HubNode): vscode.TreeItem {
    const o = node.obj!;
    const expandable = o.type !== 'trigger' && o.type !== 'sequence';
    const label = node.schema ? o.name : `${o.schema}.${o.name}`;
    const item = new vscode.TreeItem(
      label,
      expandable ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None,
    );
    item.id = `${node.connectionId}|${node.database}|obj|${o.type}|${o.schema}.${o.name}`;
    if (o.detail) {
      item.description = o.detail;
    }
    item.iconPath = new vscode.ThemeIcon(OBJECT_ICON[o.type]);
    item.contextValue = `object-${o.type}`;
    item.tooltip = `${o.schema}.${o.name}`;
    return item;
  }

  async getChildren(node?: HubNode): Promise<HubNode[]> {
    if (!node) {
      return this.store
        .list()
        .map((p) => ({ kind: 'connection' as const, connectionId: p.id }));
    }
    const profile = this.store.get(node.connectionId);
    if (!profile || !this.manager.isConnected(profile.id)) {
      return [];
    }

    switch (node.kind) {
      case 'connection': {
        if (!profile.database) {
          // Browse-all profile: list every database on the server.
          const driver = await this.manager.connect(profile);
          const databases = await this.cache.listDatabases(profile.id, driver);
          return databases.map((d) => ({
            kind: 'database' as const,
            connectionId: profile.id,
            database: d,
          }));
        }
        return this.databaseChildren(profile, profile.database);
      }

      case 'database':
        return this.databaseChildren(profile, node.database!);

      case 'schema': {
        // Only show folders for object types that exist in this schema.
        const driver = await this.manager.connect(profile, node.database);
        const nodes: HubNode[] = [];
        for (const t of FOLDER_ORDER) {
          const objects = await this.cache.listObjects(profile.id, node.database!, driver, t);
          if (objects.some((o) => o.schema === node.schema)) {
            nodes.push({
              kind: 'folder',
              connectionId: profile.id,
              database: node.database,
              objectType: t,
              schema: node.schema,
            });
          }
        }
        return nodes;
      }

      case 'folder': {
        const driver = await this.manager.connect(profile, node.database);
        const objects = await this.cache.listObjects(
          profile.id,
          node.database!,
          driver,
          node.objectType!,
        );
        const filtered = node.schema ? objects.filter((o) => o.schema === node.schema) : objects;
        return filtered.map((o) => ({
          kind: 'object' as const,
          connectionId: profile.id,
          database: node.database,
          schema: node.schema,
          obj: o,
        }));
      }

      case 'object': {
        const driver = await this.manager.connect(profile, node.database);
        const o = node.obj!;
        if (o.type === 'table' || o.type === 'view') {
          const columns = await this.cache.listColumns(
            profile.id,
            node.database!,
            driver,
            o.schema,
            o.name,
          );
          return columns.map((c) => ({
            kind: 'column' as const,
            connectionId: profile.id,
            database: node.database,
            column: c,
          }));
        }
        if (o.type === 'procedure' || o.type === 'function') {
          const params = await this.cache.listParameters(
            profile.id,
            node.database!,
            driver,
            o.schema,
            o.name,
          );
          return params.map((p) => ({
            kind: 'parameter' as const,
            connectionId: profile.id,
            database: node.database,
            param: p,
          }));
        }
        return [];
      }

      default:
        return [];
    }
  }

  private async databaseChildren(
    profile: ConnectionProfile,
    database: string,
  ): Promise<HubNode[]> {
    if (this.groupBySchema) {
      const driver = await this.manager.connect(profile, database);
      const schemas = await this.loadSchemas(profile.id, database, driver);
      return schemas.map((s) => ({
        kind: 'schema' as const,
        connectionId: profile.id,
        database,
        schema: s,
      }));
    }
    return FOLDER_ORDER.map((t) => ({
      kind: 'folder' as const,
      connectionId: profile.id,
      database,
      objectType: t,
    }));
  }

  private async loadSchemas(
    connectionId: string,
    database: string,
    driver: Driver,
  ): Promise<string[]> {
    const lists = await Promise.all(
      FOLDER_ORDER.map((t) => this.cache.listObjects(connectionId, database, driver, t)),
    );
    const schemas = new Set<string>();
    for (const list of lists) {
      for (const o of list) {
        schemas.add(o.schema);
      }
    }
    return [...schemas].sort((a, b) => a.localeCompare(b));
  }
}

export { defaultDatabase };
