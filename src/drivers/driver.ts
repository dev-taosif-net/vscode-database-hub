import {
  ColumnInfo,
  ConnectionProfile,
  DbObject,
  ObjectType,
  ParameterInfo,
  QueryRunResult,
} from '../types';

export interface ConnectOptions {
  /** Request timeout applied to queries, ms. 0 = unlimited */
  requestTimeoutMs: number;
}

/**
 * One driver instance == one connection pool for one profile+database.
 * All metadata calls return everything for the database in a single
 * round-trip so results can be cached aggressively.
 */
export interface Driver {
  readonly profile: ConnectionProfile;
  /** The database this pool is connected to */
  readonly database: string;

  connect(password: string, opts: ConnectOptions): Promise<void>;
  disconnect(): Promise<void>;

  /** All accessible databases on the server */
  listDatabases(): Promise<string[]>;

  execute(sql: string): Promise<QueryRunResult>;
  /** Cancel the currently running execute(), if any */
  cancelRunning(): Promise<void>;

  listObjects(type: ObjectType): Promise<DbObject[]>;
  listColumns(schema: string, table: string): Promise<ColumnInfo[]>;
  listParameters(schema: string, routine: string): Promise<ParameterInfo[]>;
  getDefinition(obj: DbObject): Promise<string>;

  quoteIdent(name: string): string;
  buildSelectTop(schema: string, name: string, n: number): string;
}

export class QueryCancelledError extends Error {
  constructor() {
    super('Query was cancelled.');
    this.name = 'QueryCancelledError';
  }
}
