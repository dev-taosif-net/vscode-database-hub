export type DbType = 'mssql' | 'postgres';

export type Environment = 'DEV' | 'QA' | 'UAT' | 'PROD';

export interface EnvMeta {
  label: Environment;
  /** VS Code theme color id usable in tree items / status bar */
  themeColor: string;
  /** Raw hex used inside the results webview */
  hex: string;
}

export const ENV_META: Record<Environment, EnvMeta> = {
  DEV: { label: 'DEV', themeColor: 'charts.green', hex: '#2ea043' },
  QA: { label: 'QA', themeColor: 'charts.blue', hex: '#316dca' },
  UAT: { label: 'UAT', themeColor: 'charts.orange', hex: '#e8830c' },
  PROD: { label: 'PROD', themeColor: 'charts.red', hex: '#d13438' },
};

export interface ConnectionProfile {
  id: string;
  name: string;
  type: DbType;
  environment: Environment;
  /** May include a SQL Server named instance: host\INSTANCE */
  host: string;
  /** Blank = driver default (1433 / 5432) or SQL Browser for named instances */
  port?: number;
  /** Empty string = no fixed database; the explorer shows every database on the server */
  database: string;
  user: string;
  /** SQL Server only: 'sql' (default) or 'ntlm' for Windows auth */
  authType?: 'sql' | 'ntlm';
  /** NTLM domain (SQL Server Windows auth) */
  domain?: string;
  readOnly: boolean;
  /** SQL Server: encrypt connection (default true) */
  encrypt?: boolean;
  /** SQL Server: trust self-signed server certificate (default true) */
  trustServerCertificate?: boolean;
  /** PostgreSQL: use SSL */
  ssl?: boolean;
}

export type ObjectType =
  | 'table'
  | 'view'
  | 'procedure'
  | 'function'
  | 'trigger'
  | 'sequence';

export const OBJECT_TYPE_LABEL: Record<ObjectType, string> = {
  table: 'Tables',
  view: 'Views',
  procedure: 'Procedures',
  function: 'Functions',
  trigger: 'Triggers',
  sequence: 'Sequences',
};

export interface DbObject {
  type: ObjectType;
  schema: string;
  name: string;
  /** Extra info shown next to the item (e.g. trigger parent table) */
  detail?: string;
}

export interface ColumnInfo {
  name: string;
  dataType: string;
  nullable: boolean;
  isPrimaryKey: boolean;
  isIdentity?: boolean;
}

export interface ParameterInfo {
  name: string;
  dataType: string;
  isOutput: boolean;
}

export interface ResultSet {
  columns: string[];
  rows: unknown[][];
  /** True when the fetch was cut off at maxRows */
  truncated: boolean;
}

export interface QueryRunResult {
  resultSets: ResultSet[];
  /** Server messages (PRINT, NOTICE, rows-affected notes) */
  messages: string[];
  durationMs: number;
}

export interface HistoryEntry {
  id: string;
  sql: string;
  connectionId: string;
  connectionName: string;
  environment: Environment;
  database: string;
  startedAt: string; // ISO
  durationMs: number;
  success: boolean;
  rowCount: number;
  error?: string;
}

export interface FavoriteEntry {
  id: string;
  kind: 'object' | 'query';
  label: string;
  connectionId?: string;
  connectionName?: string;
  database?: string;
  objectType?: ObjectType;
  schema?: string;
  name?: string;
  sql?: string;
}

export interface SnippetDef {
  label: string;
  description?: string;
  body: string;
}
