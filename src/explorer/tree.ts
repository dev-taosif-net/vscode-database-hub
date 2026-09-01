import * as vscode from 'vscode';
import { ConnectionManager } from '../connections/manager';
import { ConnectionStore } from '../connections/store';
import { Driver } from '../drivers/driver';
import {
  ColumnInfo,
  ConnectionProfile,
  DbObject,
  ENV_META,
  OBJECT_TYPE_LABEL,
  ObjectType,
  ParameterInfo,
} from '../types';
import { MetadataCache } from './cache';

export type NodeKind = 'connection' | 'folder' | 'schema' | 'object' | 'column' | 'parameter';

export interface HubNode {
  kind: NodeKind;
  connectionId: string;
  objectType?: ObjectType;
  schema?: string;
  obj?: DbObject;
  column?: ColumnInfo;
  param?: ParameterInfo;
}

const OBJECT_ICON: Record<ObjectType, string> = {
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
      case 'folder':
        return this.folderItem(node);
      case 'schema': {
        const item = new vscode.TreeItem(
          node.schema ?? '',
          vscode.TreeItemCollapsibleState.Collapsed,
        );
        item.id = `${node.connectionId}|schema|${node.schema}`;
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
      item.description = `${profile.environment}${profile.readOnly ? ' 🔒' : ''} · ${profile.host}/${profile.database}`;
      item.iconPath = new vscode.ThemeIcon(
        connected ? 'circle-filled' : 'circle-outline',
        new vscode.ThemeColor(env.themeColor),
      );
      item.tooltip = new vscode.MarkdownString(
        `**${profile.name}** — ${profile.environment}\n\n` +
          `${profile.type === 'mssql' ? 'SQL Server' : 'PostgreSQL'} · ${profile.host}:${profile.port}/${profile.database}\n\n` +
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

  private folderItem(node: HubNode): vscode.TreeItem {
    const item = new vscode.TreeItem(
      OBJECT_TYPE_LABEL[node.objectType!],
      vscode.TreeItemCollapsibleState.Collapsed,
    );
    item.id = `${node.connectionId}|folder|${node.objectType}|${node.schema ?? ''}`;
    item.iconPath = new vscode.ThemeIcon('folder');
    item.contextValue = 'folder';
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
    item.id = `${node.connectionId}|obj|${o.type}|${o.schema}.${o.name}`;
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
    const driver = this.manager.getDriver(node.connectionId);
    if (!driver) {
      return [];
    }

    switch (node.kind) {
      case 'connection':
        if (this.groupBySchema) {
          const schemas = await this.loadSchemas(node.connectionId, driver);
          return schemas.map((s) => ({
            kind: 'schema' as const,
            connectionId: node.connectionId,
            schema: s,
          }));
        }
        return FOLDER_ORDER.map((t) => ({
          kind: 'folder' as const,
          connectionId: node.connectionId,
          objectType: t,
        }));

      case 'schema': {
        // Only show folders for object types that exist in this schema.
        const nodes: HubNode[] = [];
        for (const t of FOLDER_ORDER) {
          const objects = await this.cache.listObjects(node.connectionId, driver, t);
          if (objects.some((o) => o.schema === node.schema)) {
            nodes.push({
              kind: 'folder',
              connectionId: node.connectionId,
              objectType: t,
              schema: node.schema,
            });
          }
        }
        return nodes;
      }

      case 'folder': {
        const objects = await this.cache.listObjects(node.connectionId, driver, node.objectType!);
        const filtered = node.schema ? objects.filter((o) => o.schema === node.schema) : objects;
        return filtered.map((o) => ({
          kind: 'object' as const,
          connectionId: node.connectionId,
          schema: node.schema,
          obj: o,
        }));
      }

      case 'object': {
        const o = node.obj!;
        if (o.type === 'table' || o.type === 'view') {
          const columns = await this.cache.listColumns(node.connectionId, driver, o.schema, o.name);
          return columns.map((c) => ({
            kind: 'column' as const,
            connectionId: node.connectionId,
            column: c,
          }));
        }
        if (o.type === 'procedure' || o.type === 'function') {
          const params = await this.cache.listParameters(
            node.connectionId,
            driver,
            o.schema,
            o.name,
          );
          return params.map((p) => ({
            kind: 'parameter' as const,
            connectionId: node.connectionId,
            param: p,
          }));
        }
        return [];
      }

      default:
        return [];
    }
  }

  private async loadSchemas(connectionId: string, driver: Driver): Promise<string[]> {
    const lists = await Promise.all(
      FOLDER_ORDER.map((t) => this.cache.listObjects(connectionId, driver, t)),
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
