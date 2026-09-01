import * as crypto from 'crypto';
import * as vscode from 'vscode';
import { ConnectionProfile, DbType, ENV_META, Environment } from '../types';

interface WizardResult {
  profile: ConnectionProfile;
  password?: string;
}

/** Multi-step native QuickInput wizard — no webview, near-zero cost. */
export async function runConnectionWizard(
  existing?: ConnectionProfile,
): Promise<WizardResult | undefined> {
  const typePick = await vscode.window.showQuickPick(
    [
      { label: 'Microsoft SQL Server', value: 'mssql' as DbType },
      { label: 'PostgreSQL', value: 'postgres' as DbType },
    ],
    {
      title: existing ? `Edit Connection: ${existing.name} (1/8)` : 'Add Connection (1/8) — Database Type',
      placeHolder: 'Select the database type',
      ignoreFocusOut: true,
    },
  );
  if (!typePick) {
    return undefined;
  }
  const type = typePick.value;

  const name = await ask('Connection name', existing?.name ?? '', '2/8', (v) =>
    v.trim() ? undefined : 'Name is required',
  );
  if (name === undefined) {
    return undefined;
  }

  const envPick = await vscode.window.showQuickPick(
    (Object.keys(ENV_META) as Environment[]).map((env) => ({
      label: env,
      description: { DEV: '🟢 green', QA: '🔵 blue', UAT: '🟠 orange', PROD: '🔴 red' }[env],
      value: env,
    })),
    {
      title: 'Environment (3/8)',
      placeHolder: 'Colors every surface for this connection',
      ignoreFocusOut: true,
    },
  );
  if (!envPick) {
    return undefined;
  }

  const host = await ask('Host', existing?.host ?? 'localhost', '4/8', (v) =>
    v.trim() ? undefined : 'Host is required',
  );
  if (host === undefined) {
    return undefined;
  }

  const defaultPort = existing?.port ?? (type === 'mssql' ? 1433 : 5432);
  const portStr = await ask('Port', String(defaultPort), '5/8', (v) =>
    /^\d+$/.test(v.trim()) ? undefined : 'Port must be a number',
  );
  if (portStr === undefined) {
    return undefined;
  }

  const database = await ask('Database', existing?.database ?? '', '6/8', (v) =>
    v.trim() ? undefined : 'Database is required',
  );
  if (database === undefined) {
    return undefined;
  }

  let authType: 'sql' | 'ntlm' = existing?.authType ?? 'sql';
  let domain = existing?.domain;
  if (type === 'mssql') {
    const authPick = await vscode.window.showQuickPick(
      [
        { label: 'SQL Login', value: 'sql' as const },
        { label: 'Windows Authentication (NTLM)', value: 'ntlm' as const },
      ],
      { title: 'Authentication (7/8)', ignoreFocusOut: true },
    );
    if (!authPick) {
      return undefined;
    }
    authType = authPick.value;
    if (authType === 'ntlm') {
      domain = await ask('Domain', existing?.domain ?? '', '7/8');
      if (domain === undefined) {
        return undefined;
      }
    }
  }

  const user = await ask('User name', existing?.user ?? '', '7/8', (v) =>
    v.trim() ? undefined : 'User is required',
  );
  if (user === undefined) {
    return undefined;
  }

  const password = await vscode.window.showInputBox({
    title: 'Password (8/8)',
    prompt: existing ? 'Leave empty to keep the stored password' : 'Stored securely in VS Code Secret Storage',
    password: true,
    ignoreFocusOut: true,
  });
  if (password === undefined) {
    return undefined;
  }

  const readOnlyPick = await vscode.window.showQuickPick(
    [
      { label: 'Read / Write', value: false },
      { label: 'Read Only (blocks all write statements)', value: true },
    ],
    {
      title: 'Access Mode',
      placeHolder: envPick.value === 'PROD' ? 'Read Only is recommended for PROD' : undefined,
      ignoreFocusOut: true,
    },
  );
  if (!readOnlyPick) {
    return undefined;
  }

  const profile: ConnectionProfile = {
    id: existing?.id ?? crypto.randomUUID(),
    name: name.trim(),
    type,
    environment: envPick.value,
    host: host.trim(),
    port: Number(portStr.trim()),
    database: database.trim(),
    user: user.trim(),
    authType: type === 'mssql' ? authType : undefined,
    domain: type === 'mssql' && authType === 'ntlm' ? domain?.trim() : undefined,
    readOnly: readOnlyPick.value,
    encrypt: existing?.encrypt,
    trustServerCertificate: existing?.trustServerCertificate,
    ssl: existing?.ssl,
  };

  return { profile, password: password === '' && existing ? undefined : password };
}

function ask(
  prompt: string,
  value: string,
  step: string,
  validate?: (v: string) => string | undefined,
): Thenable<string | undefined> {
  return vscode.window.showInputBox({
    title: `${prompt} (${step})`,
    value,
    ignoreFocusOut: true,
    validateInput: validate,
  });
}
