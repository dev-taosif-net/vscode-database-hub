import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { QueryRunResult, ResultSet } from '../types';

export interface RunMeta {
  connectionName: string;
  environment: string;
  envHex: string;
  server: string;
  database: string;
  readOnly: boolean;
  durationMs?: number;
  sql?: string;
}

/** Single reusable webview panel hosting the results grid. */
export class ResultsPanel {
  private static instance: ResultsPanel | undefined;

  private lastResultSets: ResultSet[] = [];

  static show(extensionUri: vscode.Uri): ResultsPanel {
    if (ResultsPanel.instance) {
      ResultsPanel.instance.panel.reveal(vscode.ViewColumn.Two, true);
      return ResultsPanel.instance;
    }
    const panel = vscode.window.createWebviewPanel(
      'databaseHubResults',
      'Database Hub Results',
      { viewColumn: vscode.ViewColumn.Two, preserveFocus: true },
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'media')],
      },
    );
    ResultsPanel.instance = new ResultsPanel(panel, extensionUri);
    return ResultsPanel.instance;
  }

  private constructor(
    private readonly panel: vscode.WebviewPanel,
    extensionUri: vscode.Uri,
  ) {
    panel.webview.html = this.buildHtml(panel.webview, extensionUri);
    panel.onDidDispose(() => {
      ResultsPanel.instance = undefined;
    });
    panel.webview.onDidReceiveMessage((msg) => this.onMessage(msg));
  }

  showRunning(meta: RunMeta): void {
    this.post({ type: 'running', meta });
  }

  showResults(meta: RunMeta, result: QueryRunResult): void {
    this.lastResultSets = result.resultSets;
    const pageSize = vscode.workspace
      .getConfiguration('databaseHub')
      .get<number>('grid.pageSize', 200);
    this.post({
      type: 'results',
      meta,
      pageSize,
      messages: result.messages,
      resultSets: result.resultSets,
    });
  }

  showError(meta: RunMeta, message: string): void {
    this.lastResultSets = [];
    this.post({ type: 'error', meta, message });
  }

  private post(message: unknown): void {
    void this.panel.webview.postMessage(message);
  }

  private async onMessage(msg: {
    type: string;
    text?: string;
    format?: 'csv' | 'excel';
    index?: number;
  }): Promise<void> {
    if (msg.type === 'copy' && typeof msg.text === 'string') {
      await vscode.env.clipboard.writeText(msg.text);
      vscode.window.setStatusBarMessage('Database Hub: copied to clipboard', 2000);
      return;
    }
    if (msg.type === 'export' && msg.format) {
      const rs = this.lastResultSets[msg.index ?? 0];
      if (!rs) {
        return;
      }
      const isCsv = msg.format === 'csv';
      const uri = await vscode.window.showSaveDialog({
        filters: isCsv ? { CSV: ['csv'] } : { 'Excel XML Spreadsheet': ['xls'] },
        defaultUri: vscode.Uri.file(
          path.join(
            vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? os.homedir(),
            isCsv ? 'results.csv' : 'results.xls',
          ),
        ),
      });
      if (!uri) {
        return;
      }
      const content = isCsv ? toCsv(rs) : toExcelXml(rs);
      await vscode.workspace.fs.writeFile(uri, Buffer.from(content, 'utf8'));
      vscode.window.showInformationMessage(`Database Hub: exported ${rs.rows.length} rows.`);
    }
  }

  private buildHtml(webview: vscode.Webview, extensionUri: vscode.Uri): string {
    const css = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', 'results.css'));
    const js = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', 'results.js'));
    const nonce = Math.random().toString(36).slice(2) + Date.now().toString(36);
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy"
      content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${css}">
<title>Database Hub Results</title>
</head>
<body>
<div id="app"><div class="empty">Run a query to see results here.</div></div>
<script nonce="${nonce}" src="${js}"></script>
</body>
</html>`;
  }
}

function csvField(v: unknown): string {
  if (v === null || v === undefined) {
    return '';
  }
  const s = String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(rs: ResultSet): string {
  const lines = [rs.columns.map(csvField).join(',')];
  for (const row of rs.rows) {
    lines.push(row.map(csvField).join(','));
  }
  return lines.join('\r\n');
}

function xmlEscape(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** SpreadsheetML 2003 — opens directly in Excel, zero dependencies. */
export function toExcelXml(rs: ResultSet): string {
  const cell = (v: unknown): string => {
    if (typeof v === 'number' && Number.isFinite(v)) {
      return `<Cell><Data ss:Type="Number">${v}</Data></Cell>`;
    }
    const s = v === null || v === undefined ? '' : String(v);
    return `<Cell><Data ss:Type="String">${xmlEscape(s)}</Data></Cell>`;
  };
  const header = rs.columns.map((c) => cell(c)).join('');
  const body = rs.rows.map((r) => `<Row>${r.map(cell).join('')}</Row>`).join('\n');
  return `<?xml version="1.0"?>
<?mso-application progid="Excel.Sheet"?>
<Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet"
          xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet">
<Worksheet ss:Name="Results"><Table>
<Row>${header}</Row>
${body}
</Table></Worksheet></Workbook>`;
}
