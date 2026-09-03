---
name: webview-protocol
description: Reference for the two Database Hub webviews (results grid in media/results.js + src/results/panel.ts, connection editor in media/connectionForm.js + src/connections/editorPanel.ts) - CSP rules, ready handshake, the exact host<->webview message catalog, state model, and how to add a message or form field safely. Load before editing anything under media/ or either host class.
---

# Webview protocol

Both webviews are dependency-free plain JS; the HTML is a template string in the host class.

## Shared rules

- CSP: `default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}'`, and `media/`
  is the only local resource root. So: no inline `<script>`, no inline event handlers, no CDN. A new
  asset goes in `media/` and is referenced with
  `webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', '<file>'))`.
- Every dynamic string is rendered through `esc()` (escapes `& < > "`). Markup is built as strings and
  assigned with `innerHTML`; never insert raw cell values or messages.
- `acquireVsCodeApi()` once per script; the webview posts `{ type: 'ready' }` as its last statement.
- Messages are plain JSON objects with a `type` discriminator. Add new types on **both** sides in the
  same change.
- Styling uses VS Code theme CSS variables (`--vscode-*`). Environment colors arrive as a hex in
  `meta.envHex` (grid) or from the `ENV_HEX` map in `connectionForm.js`, which mirrors `ENV_META` in
  `src/types.ts` — change both together.

## Results grid — `src/results/panel.ts` ↔ `media/results.js`

Host: `ResultsViewProvider` (`WebviewViewProvider`, view id `databaseHubResults`, bottom panel,
`retainContextWhenHidden: true`). The view resolves lazily, so `post()` stores `lastMessage` and only
sends once `ready` arrived; on `ready` it replays `lastMessage`. New host → webview state must go
through `post()` or it can be lost before the view resolves.

Host → webview:

| Message | Shape | When |
|---|---|---|
| `running` | `{ type, meta }` | `Executor.runSql`, before connecting |
| `results` | `{ type, meta, pageSize, messages: string[], resultSets: ResultSet[] }` | success |
| `error` | `{ type, meta, message }` | failure or cancellation (`Query cancelled.`) |

`meta: RunMeta = { connectionName, environment, envHex, server, database, readOnly, durationMs?, sql? }`.
`ResultSet = { columns: string[], rows: unknown[][] }`; cells were already passed through
`sanitizeValue` (null stays `null`; Date / bigint / Buffer / object become strings), so the grid
renders `null` as `NULL` and everything else with `String()`.

Webview → host:

| Message | Shape | Host action |
|---|---|---|
| `ready` | `{ type }` | mark ready, replay `lastMessage` |
| `copy` | `{ type, text }` | clipboard write + 2 s status-bar message |
| `export` | `{ type, format: 'csv' \| 'excel', index }` | save dialog (default folder: first workspace folder, else home; `results.csv` / `results.xls`), then `toCsv` or `toExcelXml` (SpreadsheetML 2003) of `lastResultSets[index]` |

Grid state in `results.js`: `data` = last `results` message, `activeSet` = tab index,
`views[i] = { sort: { col, dir } | null, filter, page, selected: Set<rowIndex>, activeCell }`.
Any change calls `render()` (full rebuild of `#app`) and then `wire()` (re-attaches listeners).
Filtering and sorting work on index arrays (`filteredSortedIndexes`), so `rows` are never mutated.
Copy actions use the selection, or every filtered row when nothing is selected. `pageSize` comes from
the host (`databaseHub.grid.pageSize`).

## Connection editor — `src/connections/editorPanel.ts` ↔ `media/connectionForm.js`

Host: `ConnectionEditorPanel`, a singleton `WebviewPanel` (viewType `databaseHubConnection`,
`retainContextWhenHidden`). `show()` reuses an open panel and re-sends `init`. Persistence and the
real connect live in the `ConnectionEditorHost` object (`save`, `test`) built inside `activate()`.

Webview → host:

| Message | Shape | Host action |
|---|---|---|
| `ready` | `{ type }` | post `init` |
| `test` | `{ type, data: FormData }` | build the profile, `host.test`, reply `testResult` |
| `save` | `{ type, data: FormData }` | build the profile, `host.save`, info toast, dispose; on error reply `testResult` |
| `cancel` | `{ type }` | dispose the panel |

Host → webview:

| Message | Shape |
|---|---|
| `init` | `{ type, profile?: ConnectionProfile }` — a `profile` means edit mode |
| `testResult` | `{ type, ok: boolean, message }` — also carries save and parse errors |

`FormData` (built by `collect()` in the JS, typed in `editorPanel.ts`): `name, type, environment,
connectUsing: 'fields' | 'connectionString', connectionString, host, port?, database, authType,
domain, user, password, readOnly, encrypt, trustServerCertificate, ssl`. Rules the host relies on:

- `connectUsing === 'connectionString'` → `parseConnectionString()` supplies host / port / database /
  user / password / auth flags; `name`, `environment` and `readOnly` still come from the form; a
  string without a password keeps the stored password when editing.
- In edit mode an empty `password` means "keep the stored password" (`effectivePassword`).
- `toProfile()` nulls type-specific fields (`authType`, `domain`, `encrypt`, `trustServerCertificate`
  only for mssql; `ssl` only for postgres).
- The JS validates required fields (`name`, plus `host` and `user`, or `connString`) and the port
  range before posting; the host still validates the parsed connection string.

## Adding a field or message

1. Host: extend `FormData` / the `onMessage` parameter type, or add a `post({ type: '…' })` call.
2. JS: read and write the DOM in `collect()` and the `init` handler (form), or handle the new
   `msg.type` in the `message` listener / post it from an event handler (grid).
3. Host-initiated grid state must be sent via `post()` so it survives the lazy resolve.
4. Escape any new dynamic text; keep element ids unique (`$('id')` / `getElementById` lookups).
5. `/verify-build` step 3: run a query or open the form in the Extension Development Host. CSP
   violations only show in the webview developer tools (`Developer: Open Webview Developer Tools`).
