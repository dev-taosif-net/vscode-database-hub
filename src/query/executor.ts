import * as vscode from 'vscode';
import { ConnectionManager, defaultDatabase } from '../connections/manager';
import { Driver, QueryCancelledError } from '../drivers/driver';
import { ResultsViewProvider, RunMeta } from '../results/panel';
import { HistoryStore } from '../history/store';
import { ConnectionProfile, ENV_META, QueryRunResult } from '../types';
import { analyzeSql, readOnlyViolation } from './safety';

function formatDate(d: Date): string {
  const pad = (n: number, w = 2) => String(n).padStart(w, '0');
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`
  );
}

export function sanitizeValue(v: unknown): unknown {
  if (v === null || v === undefined) {
    return null;
  }
  if (v instanceof Date) {
    return formatDate(v);
  }
  if (typeof v === 'bigint') {
    return v.toString();
  }
  if (Buffer.isBuffer(v)) {
    const head = v.subarray(0, 32).toString('hex');
    return `0x${head}${v.length > 32 ? `… (${v.length} bytes)` : ''}`;
  }
  if (typeof v === 'object') {
    try {
      return JSON.stringify(v);
    } catch {
      return String(v);
    }
  }
  return v;
}

export class Executor {
  private runningDriver: Driver | undefined;

  constructor(
    private readonly manager: ConnectionManager,
    private readonly history: HistoryStore,
    private readonly resultsView: ResultsViewProvider,
  ) {}

  get isRunning(): boolean {
    return this.runningDriver !== undefined;
  }

  async cancel(): Promise<void> {
    await this.runningDriver?.cancelRunning();
  }

  private buildMeta(profile: ConnectionProfile, database: string, durationMs?: number): RunMeta {
    return {
      connectionName: profile.name,
      environment: profile.environment,
      envHex: ENV_META[profile.environment].hex,
      server: profile.host,
      database,
      readOnly: profile.readOnly,
      durationMs,
    };
  }

  /** Safety gates. Returns false when the user aborted. */
  private async checkSafety(profile: ConnectionProfile, sql: string): Promise<boolean> {
    if (profile.readOnly) {
      const verb = readOnlyViolation(sql);
      if (verb) {
        vscode.window.showErrorMessage(
          `Database Hub: "${profile.name}" is read-only — ${verb} is blocked. ` +
            'Edit the connection to allow writes.',
        );
        return false;
      }
    }

    const config = vscode.workspace.getConfiguration('databaseHub');
    const analysis = analyzeSql(sql);

    if (analysis.issues.length > 0 && config.get<boolean>('safety.warnDangerousQueries', true)) {
      const detail = analysis.issues
        .map((i) => `• ${i.reason}\n   ${i.statement}`)
        .join('\n');
      const choice = await vscode.window.showWarningMessage(
        `Dangerous query on ${profile.name} (${profile.environment})`,
        { modal: true, detail },
        'Execute Anyway',
      );
      if (choice !== 'Execute Anyway') {
        return false;
      }
    }

    if (
      profile.environment === 'PROD' &&
      analysis.hasWrites &&
      config.get<boolean>('safety.requireProdConfirmation', true)
    ) {
      const choice = await vscode.window.showWarningMessage(
        `⚠ PRODUCTION: ${profile.name}`,
        {
          modal: true,
          detail: `This will run ${analysis.writeVerbs.join(', ')} against a PROD database (${profile.host}/${profile.database}).`,
        },
        'Run on PROD',
      );
      if (choice !== 'Run on PROD') {
        return false;
      }
    }
    return true;
  }

  /** Execute SQL on a profile: safety gates, progress + cancel, grid, history. */
  async runSql(profile: ConnectionProfile, sql: string, database?: string): Promise<void> {
    const db = database || defaultDatabase(profile);
    if (!sql.trim()) {
      vscode.window.showInformationMessage('Database Hub: nothing to execute.');
      return;
    }
    if (this.runningDriver) {
      vscode.window.showWarningMessage(
        'Database Hub: a query is already running — cancel it first.',
      );
      return;
    }
    if (!(await this.checkSafety(profile, sql))) {
      return;
    }

    // Surface the panel before connecting so a slow first connect
    // still gives immediate visual feedback.
    const panel = this.resultsView;
    await panel.reveal();
    panel.showRunning(this.buildMeta(profile, db));

    let driver: Driver;
    try {
      driver = await this.manager.connect(profile, db);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      panel.showError(this.buildMeta(profile, db), message);
      throw err;
    }
    const maxRows = vscode.workspace
      .getConfiguration('databaseHub')
      .get<number>('query.maxRows', 5000);

    this.runningDriver = driver;
    await vscode.commands.executeCommand('setContext', 'databaseHub.queryRunning', true);
    const startedAt = new Date().toISOString();
    const started = Date.now();

    try {
      const result = await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: `Executing on ${profile.name} (${profile.environment})…`,
          cancellable: true,
        },
        async (_progress, token): Promise<QueryRunResult> => {
          token.onCancellationRequested(() => void driver.cancelRunning());
          return driver.execute(sql, { maxRows });
        },
      );

      for (const rs of result.resultSets) {
        for (const row of rs.rows) {
          for (let i = 0; i < row.length; i++) {
            row[i] = sanitizeValue(row[i]);
          }
        }
      }

      const rowCount = result.resultSets.reduce((n, rs) => n + rs.rows.length, 0);
      panel.showResults(this.buildMeta(profile, db, result.durationMs), result);
      await this.history.add({
        sql,
        connectionId: profile.id,
        connectionName: profile.name,
        environment: profile.environment,
        database: db,
        startedAt,
        durationMs: result.durationMs,
        success: true,
        rowCount,
      });
    } catch (err) {
      const durationMs = Date.now() - started;
      const cancelled = err instanceof QueryCancelledError;
      const message = cancelled
        ? 'Query cancelled.'
        : err instanceof Error
          ? err.message
          : String(err);
      panel.showError(this.buildMeta(profile, db, durationMs), message);
      await this.history.add({
        sql,
        connectionId: profile.id,
        connectionName: profile.name,
        environment: profile.environment,
        database: db,
        startedAt,
        durationMs,
        success: false,
        rowCount: 0,
        error: message,
      });
      if (!cancelled) {
        vscode.window.showErrorMessage(`Database Hub: ${message}`);
      }
    } finally {
      this.runningDriver = undefined;
      await vscode.commands.executeCommand('setContext', 'databaseHub.queryRunning', false);
    }
  }
}
