import * as sql from 'mssql';
import {
  ColumnInfo,
  ConnectionProfile,
  DbObject,
  ObjectType,
  ParameterInfo,
  QueryRunResult,
  ResultSet,
} from '../types';
import { ConnectOptions, Driver, QueryCancelledError, QueryOptions } from './driver';

/** Split a script into batches on lines containing only GO */
function splitBatches(text: string): string[] {
  return text
    .split(/^\s*GO\s*;?\s*$/gim)
    .map((b) => b.trim())
    .filter((b) => b.length > 0);
}

function columnNames(recordset: unknown): string[] {
  const cols = (recordset as { columns?: unknown }).columns;
  if (Array.isArray(cols)) {
    return cols.map((c: { name?: string }, i: number) => c?.name || `(column ${i + 1})`);
  }
  if (cols && typeof cols === 'object') {
    return Object.keys(cols);
  }
  return [];
}

export class MssqlDriver implements Driver {
  private pool?: sql.ConnectionPool;
  private currentRequest?: sql.Request;
  private userCancelled = false;

  constructor(
    readonly profile: ConnectionProfile,
    readonly database: string,
  ) {}

  async connect(password: string, opts: ConnectOptions): Promise<void> {
    const p = this.profile;
    // "host\INSTANCE" targets a named instance via SQL Browser; a named
    // instance and an explicit port are mutually exclusive in tedious.
    let server = p.host;
    let instanceName: string | undefined;
    const backslash = server.indexOf('\\');
    if (backslash > 0) {
      instanceName = server.slice(backslash + 1);
      server = server.slice(0, backslash);
    }
    const config: sql.config = {
      server,
      port: instanceName ? undefined : p.port,
      database: this.database,
      connectionTimeout: 15000,
      requestTimeout: opts.requestTimeoutMs,
      pool: { max: 4, min: 0, idleTimeoutMillis: 30000 },
      options: {
        encrypt: p.encrypt ?? true,
        trustServerCertificate: p.trustServerCertificate ?? true,
        appName: 'VSCode Database Hub',
        enableArithAbort: true,
        instanceName,
      },
    };
    if (p.authType === 'ntlm') {
      (config as unknown as Record<string, unknown>).authentication = {
        type: 'ntlm',
        options: { domain: p.domain ?? '', userName: p.user, password },
      };
    } else {
      config.user = p.user;
      config.password = password;
    }
    this.pool = new sql.ConnectionPool(config);
    await this.pool.connect();
  }

  async disconnect(): Promise<void> {
    const pool = this.pool;
    this.pool = undefined;
    if (pool) {
      await pool.close();
    }
  }

  private getPool(): sql.ConnectionPool {
    if (!this.pool) {
      throw new Error(`Not connected: ${this.profile.name}`);
    }
    return this.pool;
  }

  async execute(text: string, opts: QueryOptions): Promise<QueryRunResult> {
    const started = Date.now();
    const resultSets: ResultSet[] = [];
    const messages: string[] = [];
    this.userCancelled = false;

    for (const batch of splitBatches(text)) {
      if (this.userCancelled) {
        break;
      }
      await this.runBatchStreaming(batch, opts, resultSets, messages);
    }
    if (this.userCancelled) {
      throw new QueryCancelledError();
    }
    return { resultSets, messages, durationMs: Date.now() - started };
  }

  /**
   * Stream rows so a runaway SELECT is stopped at maxRows instead of
   * buffering millions of rows in the extension host.
   */
  private runBatchStreaming(
    batch: string,
    opts: QueryOptions,
    resultSets: ResultSet[],
    messages: string[],
  ): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const request = this.getPool().request();
      request.stream = true;
      request.arrayRowMode = true;
      this.currentRequest = request;

      let current: ResultSet | undefined;
      let cappedCancel = false;

      request.on('recordset', (columns: unknown) => {
        current = { columns: columnNames({ columns }), rows: [], truncated: false };
        resultSets.push(current);
      });

      request.on('row', (row: unknown[]) => {
        if (!current) {
          current = { columns: [], rows: [], truncated: false };
          resultSets.push(current);
        }
        if (current.rows.length < opts.maxRows) {
          current.rows.push(row);
        } else if (!current.truncated) {
          current.truncated = true;
          cappedCancel = true;
          messages.push(
            `Result truncated at ${opts.maxRows} rows (databaseHub.query.maxRows) — execution stopped.`,
          );
          request.cancel();
        }
      });

      request.on('info', (info: { message?: string }) => {
        if (info?.message) {
          messages.push(info.message);
        }
      });

      request.on('rowsaffected', (count: number) => {
        messages.push(`(${count} row${count === 1 ? '' : 's'} affected)`);
      });

      request.on('error', (err: Error & { code?: string }) => {
        this.currentRequest = undefined;
        if (cappedCancel && err.code === 'ECANCEL') {
          resolve();
        } else if (this.userCancelled && err.code === 'ECANCEL') {
          resolve(); // execute() converts to QueryCancelledError
        } else {
          reject(err);
        }
      });

      request.on('done', () => {
        this.currentRequest = undefined;
        resolve();
      });

      // In stream mode results arrive via events; the returned promise
      // settles too — swallow it so a rejection is never unhandled.
      const settled = request.query(batch) as unknown as Promise<unknown> | undefined;
      if (settled && typeof settled.catch === 'function') {
        settled.catch(() => undefined);
      }
    });
  }

  async cancelRunning(): Promise<void> {
    this.userCancelled = true;
    this.currentRequest?.cancel();
  }

  private async metaQuery(
    text: string,
    params?: Record<string, unknown>,
  ): Promise<Record<string, unknown>[]> {
    const request = this.getPool().request();
    for (const [k, v] of Object.entries(params ?? {})) {
      request.input(k, v);
    }
    const result = await request.query(text);
    return result.recordset as unknown as Record<string, unknown>[];
  }

  async listDatabases(): Promise<string[]> {
    const rows = await this.metaQuery(
      `SELECT name FROM sys.databases
       WHERE state = 0 AND HAS_DBACCESS(name) = 1
       ORDER BY CASE WHEN name IN ('master','model','msdb','tempdb') THEN 1 ELSE 0 END, name`,
    );
    return rows.map((r) => String(r.name));
  }

  async listObjects(type: ObjectType): Promise<DbObject[]> {
    const queries: Record<ObjectType, string> = {
      table: `SELECT s.name AS sch, o.name AS name, NULL AS detail
              FROM sys.tables o JOIN sys.schemas s ON s.schema_id = o.schema_id
              WHERE o.is_ms_shipped = 0 ORDER BY s.name, o.name`,
      view: `SELECT s.name AS sch, o.name AS name, NULL AS detail
             FROM sys.views o JOIN sys.schemas s ON s.schema_id = o.schema_id
             WHERE o.is_ms_shipped = 0 ORDER BY s.name, o.name`,
      procedure: `SELECT s.name AS sch, o.name AS name, NULL AS detail
                  FROM sys.procedures o JOIN sys.schemas s ON s.schema_id = o.schema_id
                  WHERE o.is_ms_shipped = 0 ORDER BY s.name, o.name`,
      function: `SELECT s.name AS sch, o.name AS name,
                        CASE o.type WHEN 'FN' THEN 'scalar' WHEN 'IF' THEN 'inline table' WHEN 'TF' THEN 'table' WHEN 'AF' THEN 'aggregate' END AS detail
                 FROM sys.objects o JOIN sys.schemas s ON s.schema_id = o.schema_id
                 WHERE o.type IN ('FN','IF','TF','AF') AND o.is_ms_shipped = 0
                 ORDER BY s.name, o.name`,
      trigger: `SELECT s.name AS sch, t.name AS name, OBJECT_NAME(t.parent_id) AS detail
                FROM sys.triggers t
                JOIN sys.objects po ON po.object_id = t.parent_id
                JOIN sys.schemas s ON s.schema_id = po.schema_id
                WHERE t.is_ms_shipped = 0 AND t.parent_class = 1
                ORDER BY s.name, t.name`,
      sequence: `SELECT s.name AS sch, o.name AS name, NULL AS detail
                 FROM sys.sequences o JOIN sys.schemas s ON s.schema_id = o.schema_id
                 ORDER BY s.name, o.name`,
    };
    const rows = await this.metaQuery(queries[type]);
    return rows.map((r) => ({
      type,
      schema: String(r.sch),
      name: String(r.name),
      detail: r.detail ? String(r.detail) : undefined,
    }));
  }

  async listColumns(schema: string, table: string): Promise<ColumnInfo[]> {
    const rows = await this.metaQuery(
      `SELECT c.name, t.name AS type_name, c.max_length, c.precision, c.scale,
              c.is_nullable, c.is_identity,
              CASE WHEN pk.column_id IS NOT NULL THEN 1 ELSE 0 END AS is_pk
       FROM sys.columns c
       JOIN sys.types t ON c.user_type_id = t.user_type_id
       LEFT JOIN (
         SELECT ic.object_id, ic.column_id
         FROM sys.index_columns ic
         JOIN sys.indexes i ON i.object_id = ic.object_id AND i.index_id = ic.index_id
         WHERE i.is_primary_key = 1
       ) pk ON pk.object_id = c.object_id AND pk.column_id = c.column_id
       WHERE c.object_id = OBJECT_ID(@obj)
       ORDER BY c.column_id`,
      { obj: `${this.quoteIdent(schema)}.${this.quoteIdent(table)}` },
    );
    return rows.map((r) => ({
      name: String(r.name),
      dataType: formatMssqlType(
        String(r.type_name),
        Number(r.max_length),
        Number(r.precision),
        Number(r.scale),
      ),
      nullable: Boolean(r.is_nullable),
      isPrimaryKey: Boolean(r.is_pk),
      isIdentity: Boolean(r.is_identity),
    }));
  }

  async listParameters(schema: string, routine: string): Promise<ParameterInfo[]> {
    const rows = await this.metaQuery(
      `SELECT p.name, t.name AS type_name, p.max_length, p.precision, p.scale, p.is_output
       FROM sys.parameters p
       JOIN sys.types t ON p.user_type_id = t.user_type_id
       WHERE p.object_id = OBJECT_ID(@obj) AND p.parameter_id > 0
       ORDER BY p.parameter_id`,
      { obj: `${this.quoteIdent(schema)}.${this.quoteIdent(routine)}` },
    );
    return rows.map((r) => ({
      name: String(r.name),
      dataType: formatMssqlType(
        String(r.type_name),
        Number(r.max_length),
        Number(r.precision),
        Number(r.scale),
      ),
      isOutput: Boolean(r.is_output),
    }));
  }

  async getDefinition(obj: DbObject): Promise<string> {
    const rows = await this.metaQuery(
      `SELECT OBJECT_DEFINITION(OBJECT_ID(@obj)) AS defn`,
      { obj: `${this.quoteIdent(obj.schema)}.${this.quoteIdent(obj.name)}` },
    );
    const defn = rows[0]?.defn;
    if (!defn) {
      throw new Error(`No definition available for ${obj.schema}.${obj.name}.`);
    }
    return String(defn);
  }

  quoteIdent(name: string): string {
    return `[${name.replace(/]/g, ']]')}]`;
  }

  buildSelectTop(schema: string, name: string, n: number): string {
    return `SELECT TOP ${n} *\nFROM ${this.quoteIdent(schema)}.${this.quoteIdent(name)};\n`;
  }
}

function formatMssqlType(type: string, maxLength: number, precision: number, scale: number): string {
  const t = type.toLowerCase();
  if (t === 'varchar' || t === 'char' || t === 'varbinary' || t === 'binary') {
    return `${t}(${maxLength === -1 ? 'max' : maxLength})`;
  }
  if (t === 'nvarchar' || t === 'nchar') {
    return `${t}(${maxLength === -1 ? 'max' : maxLength / 2})`;
  }
  if (t === 'decimal' || t === 'numeric') {
    return `${t}(${precision},${scale})`;
  }
  if (t === 'datetime2' || t === 'datetimeoffset' || t === 'time') {
    return `${t}(${scale})`;
  }
  return t;
}
