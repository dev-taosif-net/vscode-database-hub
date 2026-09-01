import { Client, Pool, PoolClient } from 'pg';
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

interface PgResultLike {
  fields?: { name: string }[];
  rows: unknown[][];
  rowCount: number | null;
  command: string;
}

export class PostgresDriver implements Driver {
  private pool?: Pool;
  private password = '';
  private requestTimeoutMs = 0;
  private currentPid?: number;
  private userCancelled = false;

  constructor(
    readonly profile: ConnectionProfile,
    readonly database: string,
  ) {}

  async connect(password: string, opts: ConnectOptions): Promise<void> {
    const p = this.profile;
    this.password = password;
    this.requestTimeoutMs = opts.requestTimeoutMs;
    this.pool = new Pool({
      host: p.host,
      port: p.port,
      database: this.database,
      user: p.user,
      password,
      max: 4,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 15000,
      ssl: p.ssl ? { rejectUnauthorized: false } : undefined,
      application_name: 'VSCode Database Hub',
    });
    this.pool.on('connect', (client) => {
      if (p.readOnly) {
        client.query('SET default_transaction_read_only = on').catch(() => undefined);
      }
    });
    // Validate credentials eagerly so failures surface at connect time.
    const client = await this.pool.connect();
    try {
      await client.query('SELECT 1');
    } finally {
      client.release();
    }
  }

  async disconnect(): Promise<void> {
    const pool = this.pool;
    this.pool = undefined;
    if (pool) {
      await pool.end();
    }
  }

  private getPool(): Pool {
    if (!this.pool) {
      throw new Error(`Not connected: ${this.profile.name}`);
    }
    return this.pool;
  }

  async execute(text: string, opts: QueryOptions): Promise<QueryRunResult> {
    const started = Date.now();
    const messages: string[] = [];
    this.userCancelled = false;
    const client: PoolClient = await this.getPool().connect();
    const onNotice = (notice: { message?: string }) => {
      if (notice?.message) {
        messages.push(notice.message);
      }
    };
    client.on('notice', onNotice);
    this.currentPid = (client as unknown as { processID?: number }).processID;
    try {
      if (this.requestTimeoutMs > 0) {
        await client.query(`SET statement_timeout = ${Math.floor(this.requestTimeoutMs)}`);
      }
      const raw = (await client.query({ text, rowMode: 'array' })) as unknown as
        | PgResultLike
        | PgResultLike[];
      const results = Array.isArray(raw) ? raw : [raw];
      const resultSets: ResultSet[] = [];
      for (const r of results) {
        if (r.fields && r.fields.length > 0) {
          const truncated = r.rows.length > opts.maxRows;
          resultSets.push({
            columns: r.fields.map((f, i) => f.name || `(column ${i + 1})`),
            rows: truncated ? r.rows.slice(0, opts.maxRows) : r.rows,
            truncated,
          });
          if (truncated) {
            messages.push(
              `Result truncated at ${opts.maxRows} rows (databaseHub.query.maxRows).`,
            );
          }
        } else if (r.command) {
          const n = r.rowCount ?? 0;
          messages.push(`${r.command} — ${n} row${n === 1 ? '' : 's'} affected`);
        }
      }
      return { resultSets, messages, durationMs: Date.now() - started };
    } catch (err) {
      if (this.userCancelled) {
        throw new QueryCancelledError();
      }
      throw err;
    } finally {
      client.removeListener('notice', onNotice);
      this.currentPid = undefined;
      client.release();
    }
  }

  async cancelRunning(): Promise<void> {
    const pid = this.currentPid;
    if (!pid) {
      return;
    }
    this.userCancelled = true;
    const p = this.profile;
    const cancelClient = new Client({
      host: p.host,
      port: p.port,
      database: this.database,
      user: p.user,
      password: this.password,
      ssl: p.ssl ? { rejectUnauthorized: false } : undefined,
      connectionTimeoutMillis: 10000,
    });
    try {
      await cancelClient.connect();
      await cancelClient.query('SELECT pg_cancel_backend($1)', [pid]);
    } finally {
      await cancelClient.end().catch(() => undefined);
    }
  }

  private async metaQuery(
    text: string,
    params?: unknown[],
  ): Promise<Record<string, unknown>[]> {
    const result = await this.getPool().query(text, params);
    return result.rows as Record<string, unknown>[];
  }

  async listDatabases(): Promise<string[]> {
    const rows = await this.metaQuery(
      `SELECT datname FROM pg_database
       WHERE datallowconn AND NOT datistemplate
       ORDER BY datname`,
    );
    return rows.map((r) => String(r.datname));
  }

  async listObjects(type: ObjectType): Promise<DbObject[]> {
    const hideSchemas = `n.nspname NOT IN ('pg_catalog','information_schema') AND n.nspname NOT LIKE 'pg_toast%' AND n.nspname NOT LIKE 'pg_temp%'`;
    const queries: Record<ObjectType, string> = {
      table: `SELECT n.nspname AS sch, c.relname AS name, NULL AS detail
              FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
              WHERE c.relkind IN ('r','p') AND ${hideSchemas}
              ORDER BY 1, 2`,
      view: `SELECT n.nspname AS sch, c.relname AS name,
                    CASE c.relkind WHEN 'm' THEN 'materialized' END AS detail
             FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
             WHERE c.relkind IN ('v','m') AND ${hideSchemas}
             ORDER BY 1, 2`,
      procedure: `SELECT n.nspname AS sch, p.proname AS name, NULL AS detail
                  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                  WHERE p.prokind = 'p' AND ${hideSchemas}
                  ORDER BY 1, 2`,
      function: `SELECT n.nspname AS sch, p.proname AS name, NULL AS detail
                 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                 WHERE p.prokind = 'f' AND ${hideSchemas}
                 ORDER BY 1, 2`,
      trigger: `SELECT n.nspname AS sch, t.tgname AS name, c.relname AS detail
                FROM pg_trigger t
                JOIN pg_class c ON c.oid = t.tgrelid
                JOIN pg_namespace n ON n.oid = c.relnamespace
                WHERE NOT t.tgisinternal AND ${hideSchemas}
                ORDER BY 1, 2`,
      sequence: `SELECT n.nspname AS sch, c.relname AS name, NULL AS detail
                 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
                 WHERE c.relkind = 'S' AND ${hideSchemas}
                 ORDER BY 1, 2`,
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
      `SELECT a.attname AS name,
              format_type(a.atttypid, a.atttypmod) AS type_name,
              NOT a.attnotnull AS is_nullable,
              COALESCE(i.indisprimary, false) AS is_pk,
              a.attidentity <> '' AS is_identity
       FROM pg_attribute a
       JOIN pg_class c ON c.oid = a.attrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
       LEFT JOIN pg_index i ON i.indrelid = c.oid AND i.indisprimary AND a.attnum = ANY(i.indkey)
       WHERE n.nspname = $1 AND c.relname = $2 AND a.attnum > 0 AND NOT a.attisdropped
       ORDER BY a.attnum`,
      [schema, table],
    );
    return rows.map((r) => ({
      name: String(r.name),
      dataType: String(r.type_name),
      nullable: Boolean(r.is_nullable),
      isPrimaryKey: Boolean(r.is_pk),
      isIdentity: Boolean(r.is_identity),
    }));
  }

  async listParameters(schema: string, routine: string): Promise<ParameterInfo[]> {
    const rows = await this.metaQuery(
      `SELECT pg_get_function_arguments(p.oid) AS args
       FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = $1 AND p.proname = $2
       LIMIT 1`,
      [schema, routine],
    );
    const args = rows[0]?.args ? String(rows[0].args) : '';
    if (!args.trim()) {
      return [];
    }
    // "a integer, OUT b text, c timestamp DEFAULT now()" -> one entry each
    return args.split(/,(?![^(]*\))/).map((part) => {
      const trimmed = part.trim();
      const isOutput = /^(OUT|INOUT)\s/i.test(trimmed);
      const clean = trimmed.replace(/^(IN|OUT|INOUT|VARIADIC)\s+/i, '');
      const space = clean.indexOf(' ');
      return {
        name: space > 0 ? clean.slice(0, space) : clean,
        dataType: space > 0 ? clean.slice(space + 1).replace(/\sDEFAULT\s.*$/i, '') : '',
        isOutput,
      };
    });
  }

  async getDefinition(obj: DbObject): Promise<string> {
    if (obj.type === 'view') {
      const rows = await this.metaQuery(`SELECT pg_get_viewdef($1::regclass, true) AS defn`, [
        `${this.quoteIdent(obj.schema)}.${this.quoteIdent(obj.name)}`,
      ]);
      const body = rows[0]?.defn ? String(rows[0].defn) : '';
      if (!body) {
        throw new Error(`No definition available for ${obj.schema}.${obj.name}.`);
      }
      return `CREATE OR REPLACE VIEW ${this.quoteIdent(obj.schema)}.${this.quoteIdent(obj.name)} AS\n${body}`;
    }
    const rows = await this.metaQuery(
      `SELECT pg_get_functiondef(p.oid) AS defn
       FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = $1 AND p.proname = $2
       LIMIT 1`,
      [obj.schema, obj.name],
    );
    const defn = rows[0]?.defn;
    if (!defn) {
      throw new Error(`No definition available for ${obj.schema}.${obj.name}.`);
    }
    return String(defn);
  }

  quoteIdent(name: string): string {
    return `"${name.replace(/"/g, '""')}"`;
  }

  buildSelectTop(schema: string, name: string, n: number): string {
    return `SELECT *\nFROM ${this.quoteIdent(schema)}.${this.quoteIdent(name)}\nLIMIT ${n};\n`;
  }
}
