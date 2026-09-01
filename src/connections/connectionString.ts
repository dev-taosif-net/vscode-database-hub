import { DbType } from '../types';

/** Fields recovered from a pasted connection string; all optional. */
export interface ParsedConnectionString {
  type?: DbType;
  host?: string;
  port?: number;
  database?: string;
  user?: string;
  password?: string;
  authType?: 'sql' | 'ntlm';
  domain?: string;
  encrypt?: boolean;
  trustServerCertificate?: boolean;
  ssl?: boolean;
}

const SSL_ON = /^(true|yes|1|on|require|required|mandatory|strict|verify-ca|verify-full)$/i;
const SSL_OFF = /^(false|no|0|off|disable|disabled)$/i;

function toBool(v: string | undefined): boolean | undefined {
  if (v === undefined) {
    return undefined;
  }
  if (SSL_ON.test(v.trim())) {
    return true;
  }
  if (SSL_OFF.test(v.trim())) {
    return false;
  }
  return undefined;
}

function unquote(v: string): string {
  const t = v.trim();
  if (
    (t.startsWith("'") && t.endsWith("'")) ||
    (t.startsWith('"') && t.endsWith('"')) ||
    (t.startsWith('{') && t.endsWith('}'))
  ) {
    return t.slice(1, -1);
  }
  return t;
}

/**
 * Parse a connection string in any of the common formats:
 *  - URL:       postgres://user:pass@host:5432/db?sslmode=require
 *  - JDBC:      jdbc:sqlserver://host:1433;databaseName=db;user=sa;password=x
 *  - ADO.NET:   Server=tcp:host,1433;Database=db;User Id=sa;Password=x;Encrypt=true
 *  - Npgsql:    Host=host;Port=5432;Database=db;Username=postgres;Password=x
 *  - conninfo:  host=localhost port=5432 dbname=db user=postgres password=x
 */
export function parseConnectionString(raw: string): ParsedConnectionString {
  let input = raw.trim();
  if (!input) {
    throw new Error('Connection string is empty.');
  }
  if (/^jdbc:/i.test(input)) {
    input = input.slice(5);
  }

  const urlMatch = /^([a-z][a-z0-9+.-]*):\/\//i.exec(input);
  let result: ParsedConnectionString;
  if (urlMatch) {
    result = parseUrlStyle(input, urlMatch[1].toLowerCase());
  } else if (
    !input.includes(';') &&
    /(^|\s)(host|hostaddr|dbname|user|password|port|sslmode)\s*=/i.test(input) &&
    /\s/.test(input)
  ) {
    result = parseConninfo(input);
  } else if (input.includes('=')) {
    result = parseSemicolonStyle(input);
  } else {
    throw new Error('Unrecognized connection string format.');
  }

  if (!result.host && !result.database && !result.user) {
    throw new Error('Could not find host, database or user in the connection string.');
  }
  return result;
}

function parseUrlStyle(input: string, scheme: string): ParsedConnectionString {
  const out: ParsedConnectionString = {};
  if (/^(postgres|postgresql|pg)$/.test(scheme)) {
    out.type = 'postgres';
  } else if (/^(mssql|sqlserver)$/.test(scheme)) {
    out.type = 'mssql';
  }

  // JDBC SQL Server appends ;key=value pairs after the authority.
  let base = input;
  if (input.includes(';')) {
    const i = input.indexOf(';');
    base = input.slice(0, i);
    const extra = parseSemicolonStyle(input.slice(i + 1));
    Object.assign(out, { ...extra, type: out.type ?? extra.type });
  }

  let url: URL;
  try {
    url = new URL(base.replace(/^[a-z0-9+.-]+:\/\//i, 'http://'));
  } catch {
    throw new Error('Invalid connection URL.');
  }
  if (url.hostname) {
    out.host = decodeURIComponent(url.hostname);
  }
  if (url.port) {
    out.port = Number(url.port);
  }
  if (url.username) {
    out.user = decodeURIComponent(url.username);
  }
  if (url.password) {
    out.password = decodeURIComponent(url.password);
  }
  const dbPath = decodeURIComponent(url.pathname.replace(/^\//, '')).trim();
  if (dbPath && !out.database) {
    out.database = dbPath;
  }
  const q = url.searchParams;
  const sslmode = q.get('sslmode') ?? q.get('ssl');
  const ssl = toBool(sslmode ?? undefined);
  if (ssl !== undefined) {
    out.ssl = ssl;
  }
  const encrypt = toBool(q.get('encrypt') ?? undefined);
  if (encrypt !== undefined) {
    out.encrypt = encrypt;
  }
  const trust = toBool(q.get('trustServerCertificate') ?? undefined);
  if (trust !== undefined) {
    out.trustServerCertificate = trust;
  }
  return out;
}

function parseSemicolonStyle(input: string): ParsedConnectionString {
  const kv: Record<string, string> = {};
  for (const part of input.split(';')) {
    const i = part.indexOf('=');
    if (i > 0) {
      const key = part.slice(0, i).trim().toLowerCase().replace(/\s+/g, ' ');
      kv[key] = unquote(part.slice(i + 1));
    }
  }

  const mssqlKeys = [
    'server',
    'data source',
    'initial catalog',
    'trustservercertificate',
    'trust server certificate',
    'integrated security',
    'trusted_connection',
    'user id',
    'databasename',
    'multipleactiveresultsets',
    'attachdbfilename',
  ];
  const pgKeys = ['host', 'hostaddr', 'username', 'dbname', 'sslmode', 'ssl mode', 'search path', 'pooling'];
  const mssqlScore = mssqlKeys.filter((k) => k in kv).length;
  const pgScore = pgKeys.filter((k) => k in kv).length;

  const out: ParsedConnectionString = {};
  if (pgScore > mssqlScore) {
    out.type = 'postgres';
  } else if (mssqlScore > 0) {
    out.type = 'mssql';
  }

  let host =
    kv['server'] ?? kv['data source'] ?? kv['address'] ?? kv['addr'] ?? kv['network address'] ?? kv['host'] ?? kv['hostaddr'];
  if (host) {
    host = host.replace(/^tcp:/i, '');
    const comma = host.indexOf(',');
    if (comma > 0) {
      const portPart = host.slice(comma + 1).trim();
      if (/^\d+$/.test(portPart)) {
        out.port = Number(portPart);
      }
      host = host.slice(0, comma);
    }
    out.host = host.trim();
  }
  if (kv['port'] && /^\d+$/.test(kv['port'])) {
    out.port = Number(kv['port']);
  }
  const database = kv['database'] ?? kv['initial catalog'] ?? kv['databasename'] ?? kv['dbname'];
  if (database) {
    out.database = database;
  }
  const user = kv['user id'] ?? kv['uid'] ?? kv['username'] ?? kv['user'];
  if (user) {
    out.user = user;
  }
  const password = kv['password'] ?? kv['pwd'];
  if (password) {
    out.password = password;
  }
  const integrated = kv['integrated security'] ?? kv['trusted_connection'] ?? kv['integratedsecurity'];
  if (integrated && /^(true|yes|sspi)$/i.test(integrated)) {
    out.authType = 'ntlm';
    out.type = out.type ?? 'mssql';
  }
  if (kv['domain']) {
    out.domain = kv['domain'];
  }
  const encrypt = toBool(kv['encrypt']);
  if (encrypt !== undefined) {
    out.encrypt = encrypt;
  }
  const trust = toBool(kv['trustservercertificate'] ?? kv['trust server certificate']);
  if (trust !== undefined) {
    out.trustServerCertificate = trust;
  }
  const ssl = toBool(kv['sslmode'] ?? kv['ssl mode'] ?? kv['ssl']);
  if (ssl !== undefined) {
    out.ssl = ssl;
  }
  return out;
}

function parseConninfo(input: string): ParsedConnectionString {
  const out: ParsedConnectionString = { type: 'postgres' };
  const re = /(\w+)\s*=\s*(?:'((?:[^'\\]|\\.)*)'|(\S+))/g;
  for (let m = re.exec(input); m; m = re.exec(input)) {
    const key = m[1].toLowerCase();
    const value = (m[2] ?? m[3] ?? '').replace(/\\(.)/g, '$1');
    switch (key) {
      case 'host':
      case 'hostaddr':
        out.host = value;
        break;
      case 'port':
        if (/^\d+$/.test(value)) {
          out.port = Number(value);
        }
        break;
      case 'dbname':
        out.database = value;
        break;
      case 'user':
        out.user = value;
        break;
      case 'password':
        out.password = value;
        break;
      case 'sslmode': {
        const ssl = toBool(value);
        if (ssl !== undefined) {
          out.ssl = ssl;
        }
        break;
      }
    }
  }
  return out;
}
