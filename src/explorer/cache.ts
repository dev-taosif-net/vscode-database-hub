import * as vscode from 'vscode';
import { Driver } from '../drivers/driver';
import { ColumnInfo, DbObject, ObjectType, ParameterInfo } from '../types';

interface CacheEntry {
  data: unknown;
  loadedAt: number;
}

/**
 * In-memory metadata cache. One entry per (connection, database, query-kind).
 * Entries never block the tree once loaded: stale data is served
 * immediately and refreshed in the background.
 */
export class MetadataCache {
  private readonly byConnection = new Map<string, Map<string, CacheEntry>>();
  private readonly inFlight = new Map<string, Promise<unknown>>();

  private readonly _onDidRefresh = new vscode.EventEmitter<string>();
  /** Fired with the connection id when a background refresh lands */
  readonly onDidRefresh = this._onDidRefresh.event;

  private get ttlMs(): number {
    return (
      vscode.workspace.getConfiguration('databaseHub').get<number>('metadata.cacheTtlMinutes', 10) *
      60_000
    );
  }

  listDatabases(connectionId: string, driver: Driver): Promise<string[]> {
    return this.fetch(connectionId, 'databases', () => driver.listDatabases());
  }

  listObjects(
    connectionId: string,
    database: string,
    driver: Driver,
    type: ObjectType,
  ): Promise<DbObject[]> {
    return this.fetch(connectionId, `${database}|objects:${type}`, () => driver.listObjects(type));
  }

  listColumns(
    connectionId: string,
    database: string,
    driver: Driver,
    schema: string,
    table: string,
  ): Promise<ColumnInfo[]> {
    return this.fetch(connectionId, `${database}|columns:${schema}.${table}`, () =>
      driver.listColumns(schema, table),
    );
  }

  listParameters(
    connectionId: string,
    database: string,
    driver: Driver,
    schema: string,
    routine: string,
  ): Promise<ParameterInfo[]> {
    return this.fetch(connectionId, `${database}|params:${schema}.${routine}`, () =>
      driver.listParameters(schema, routine),
    );
  }

  private fetch<T>(connectionId: string, key: string, loader: () => Promise<T>): Promise<T> {
    let conn = this.byConnection.get(connectionId);
    if (!conn) {
      conn = new Map();
      this.byConnection.set(connectionId, conn);
    }
    const entry = conn.get(key);
    const flightKey = `${connectionId}:${key}`;

    if (entry) {
      // Serve cached data instantly; refresh in the background when stale.
      if (Date.now() - entry.loadedAt > this.ttlMs && !this.inFlight.has(flightKey)) {
        const refresh = loader()
          .then((data) => {
            conn!.set(key, { data, loadedAt: Date.now() });
            this._onDidRefresh.fire(connectionId);
            return data;
          })
          .catch(() => entry.data as T)
          .finally(() => this.inFlight.delete(flightKey));
        this.inFlight.set(flightKey, refresh);
      }
      return Promise.resolve(entry.data as T);
    }

    const existing = this.inFlight.get(flightKey);
    if (existing) {
      return existing as Promise<T>;
    }
    const load = loader()
      .then((data) => {
        conn!.set(key, { data, loadedAt: Date.now() });
        return data;
      })
      .finally(() => this.inFlight.delete(flightKey));
    this.inFlight.set(flightKey, load);
    return load;
  }

  invalidateConnection(connectionId: string): void {
    this.byConnection.delete(connectionId);
  }

  invalidateAll(): void {
    this.byConnection.clear();
  }
}
