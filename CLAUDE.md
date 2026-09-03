# Project instructions

## DevOS logging — disabled

Do NOT log tasks to DevOS for this repository. This overrides the global
DevOS task-logging instructions in ~/.claude/CLAUDE.md: no POST to the
ingest API for any change or analysis done in this repo.

## What this repo is

**Database Hub** (`database-hub` 0.1.0, publisher `databasehub`) — a VS Code extension for
Microsoft SQL Server and PostgreSQL: connection manager, lazy object explorer, query execution
from any `sql` editor, results grid, history, favorites, snippets, IntelliSense, keyword
auto-uppercase and safety gates. Remote: https://github.com/dev-taosif-net/vscode-database-hub

- Runtime deps are only `mssql` and `pg`. No UI framework: both webviews are vanilla JS in `media/`.
- TypeScript `strict`, target ES2022, `module: node16`. esbuild bundles `src/extension.ts` into
  `dist/extension.js` (CJS, node18, `vscode` + `pg-native` external, minified unless `--watch`).
- **No tests and no linter.** `npm run typecheck` and `npm run build` are the only automated checks.
- `activationEvents` is just `onLanguage:sql`; contributed views/commands activate implicitly.
- Project skills live in `.claude/skills/` (list at the bottom). `.claude/**`, `src/**` and
  `CLAUDE.md` are excluded from the .vsix by `.vscodeignore`.

## Commands

| Task | Command |
|---|---|
| Type check | `npm run typecheck` |
| Bundle | `npm run build` (writes `dist/`, gitignored) |
| Rebuild on save | `npm run watch` |
| Debug | F5 → "Run Extension" (runs `npm: build` first) |
| Files that would ship | `npx @vscode/vsce ls` |
| Package | `npx @vscode/vsce package` → `database-hub-<version>.vsix` (gitignored) |

Verified 2026-09-03 on Node 24 / npm 11: typecheck and build pass. esbuild's
`dist\extension.js 1.7mb ⚠️` size warning is expected; anything else is a regression.

## Source map

| File | Role |
|---|---|
| `src/extension.ts` | `activate()`: builds every service, registers all commands through `register()`, holds the helpers `pickProfile`, `ensureConnected`, `resolveDbContext`, `openSqlEditor`, `executeFromEditor` |
| `src/types.ts` | `DbType`, `Environment`, `ENV_META` (theme color id + hex per env), `ConnectionProfile`, `ObjectType` + `OBJECT_TYPE_LABEL`, `DbObject`, `ColumnInfo`, `ParameterInfo`, `ResultSet`, `QueryRunResult`, `HistoryEntry`, `FavoriteEntry`, `SnippetDef` |
| `src/connections/store.ts` | `ConnectionStore`: profiles in `globalState`, passwords in `SecretStorage` |
| `src/connections/manager.ts` | `ConnectionManager`: one pool per profile+database, active connection, `defaultDatabase()` |
| `src/connections/connectionString.ts` | `parseConnectionString()`: URL, JDBC, ADO.NET, Npgsql, libpq conninfo |
| `src/connections/editorPanel.ts` | `ConnectionEditorPanel` (singleton webview panel) + `ConnectionEditorHost { save, test }` |
| `src/drivers/driver.ts` | `Driver` interface, `ConnectOptions`, `QueryCancelledError` |
| `src/drivers/mssqlDriver.ts` | `mssql`/tedious: GO batches, streamed rows, `sys.*` catalog queries |
| `src/drivers/postgresDriver.ts` | `pg`: one simple query per run, `pg_catalog` queries, cancel via `pg_cancel_backend` |
| `src/explorer/cache.ts` | `MetadataCache`: TTL + stale-while-revalidate, keyed by connection/database/kind |
| `src/explorer/tree.ts` | `ObjectExplorer` tree provider, `HubNode`, `OBJECT_ICON`, `FOLDER_ORDER` |
| `src/query/executor.ts` | `Executor.runSql()`: safety → connect → run → grid → history; `sanitizeValue()` |
| `src/query/editorBinding.ts` | `EditorBinding`: document URI → `{connectionId, database}`, persisted in `workspaceState` |
| `src/query/safety.ts` | `analyzeSql`, `readOnlyViolation`, `stripCommentsAndStrings`, `splitStatements` |
| `src/query/useStatement.ts` | `analyzeUse()`: SSMS-style `USE` handling |
| `src/query/intellisense.ts` | `SqlCompletionProvider` and `registerAutoUppercase()` |
| `src/query/sqlKeywords.ts` | Data only: `KEYWORD_PHRASES`, `UPPERCASE_WORDS`, `MSSQL_FUNCTIONS`, `POSTGRES_FUNCTIONS`, `COMMON_FUNCTIONS` |
| `src/results/panel.ts` | `ResultsViewProvider` (webview view in the bottom panel), `toCsv`, `toExcelXml` |
| `src/history/*.ts`, `src/favorites/*.ts` | `store.ts` (globalState + `onDidChange`) and `view.ts` (tree provider) pairs |
| `src/snippets/view.ts` | Built-in SQL Server / PostgreSQL snippets + `databaseHub.snippets.custom` |
| `src/statusBar.ts` | Bound connection + database, env colors, click → `databaseHub.pickActiveConnection` |
| `media/results.{js,css}` | Results grid webview |
| `media/connectionForm.{js,css}` | Connection editor webview |

## Runtime model — invariants to preserve

**Profiles, databases, pools**
- `ConnectionProfile.database === ''` means "browse all databases". `defaultDatabase(profile)` returns
  the profile database, else `master` (mssql) / `postgres` (postgres). Queries on a browse-all profile
  with no database chosen run there, like SSMS.
- Pools are keyed `${profileId}::${database}`; `manager.isConnected(id)` is true if any database pool
  is open. `connect()` dedupes concurrent connects per key. Pool: max 4, min 0, idle 30 s, connect
  timeout 15 s. `query.timeoutSeconds` is applied at connect time, so changing it needs a reconnect.
- `host\INSTANCE` → tedious `instanceName`, and the explicit port is dropped (mutually exclusive).
- Passwords live only in `SecretStorage` under `databaseHub.password.<profileId>`. A connect error
  matching `/password|login|auth/i` deletes the stored password so the next attempt re-prompts.
  Never write, log or echo passwords anywhere else.
- Persisted keys: `databaseHub.connections`, `databaseHub.history`, `databaseHub.favorites`
  (globalState); `databaseHub.editorBindings` (workspaceState).

**Editor binding**
- Each SQL document URI maps to `{connectionId, database}`; unbound editors fall back to
  `manager.activeConnectionId`. `bind()` also makes that connection active. Bindings are restored on
  activation only for tabs still open and profiles still existing.

**Execution pipeline** (`executeFromEditor` → `Executor.runSql`)
1. Selection or whole document (`smart`), whole document (`all`), selection only (`selection`).
2. `analyzeUse()`: a script that is *only* `USE db` never reaches the server — it re-binds the tab,
   rewrites the `-- name (ENV) · host/db` header comment, updates the status bar and returns.
3. `runSql`: read-only block (`readOnlyViolation`) → dangerous-statement modal
   (`safety.warnDangerousQueries`) → PROD write modal (`safety.requireProdConfirmation`).
4. Reveal the Results panel, post `running`, connect, set context key `databaseHub.queryRunning`
   (drives the play/stop editor-title buttons), run under a cancellable progress notification.
5. Every cell passes through `sanitizeValue` (Date → `YYYY-MM-DD HH:mm:ss.SSS`, bigint → string,
   Buffer → hex preview, object → JSON). Then `showResults` and a history entry (also on failure;
   cancellation records `Query cancelled.` without an error toast).
6. MSSQL only: if a larger script contained `USE`, the tab is re-pointed at that database and the
   old pool is `reset()` because a pooled session is now parked in the wrong database.
- Exactly one query runs at a time (`Executor.runningDriver`); a second run is refused.

**Drivers**
- MSSQL splits on lines that are only `GO` (`/^\s*GO\s*;?\s*$/gim`; `GO <n>` unsupported), streams with
  `arrayRowMode`, collects `info`/`rowsaffected` as messages, cancels via `request.cancel()`
  (error code `ECANCEL` is swallowed and surfaced as `QueryCancelledError`).
- Postgres sends the whole text as one simple query (`rowMode: 'array'`; multi-statement → array of
  results), sets `statement_timeout` per checkout, records `NOTICE`s and `<COMMAND> — n rows affected`,
  cancels with a second `Client` running `pg_cancel_backend(pid)`. Read-only profiles get
  `SET default_transaction_read_only = on` on every pool connection.
- `listObjects(type)` in both drivers returns rows `sch, name, detail` and is a
  `Record<ObjectType, string>`, so adding an `ObjectType` fails to compile until both drivers have a query.
- Identifier quoting: `driver.quoteIdent` — `[x]` with `]]` escaping for MSSQL, `"x"` with `""` for
  Postgres. `quoteFor()` in extension.ts and `quoteIfNeeded()` in intellisense.ts mirror this.

**Metadata cache**
- Keys: `databases`, `<db>|objects:<type>`, `<db>|columns:<schema>.<table>`,
  `<db>|params:<schema>.<routine>`, per connection id. TTL = `metadata.cacheTtlMinutes`.
- Stale entries are returned immediately and refreshed in the background; `onDidRefresh` refreshes
  the tree. A failed refresh keeps the old data. Invalidate per connection on disconnect / delete /
  save / "Refresh" node; `invalidateAll` on "Refresh Explorer".

**Safety analysis** (`safety.ts`) is lexical, not a parser: strip comments and string literals, split
on `;` or `GO` lines, then flag statement heads (`DELETE`/`UPDATE` without `WHERE`, `TRUNCATE`,
`DROP`). Write verbs (`INSERT UPDATE DELETE MERGE TRUNCATE DROP ALTER CREATE GRANT REVOKE EXEC
EXECUTE CALL`) are searched anywhere so CTE-hidden writes still trigger the PROD modal. Bracketed or
quoted identifiers are not stripped, so a column named `[Delete]` counts as a write — accepted by
design ("errs on the side of warning"). Read-only mode blocks `EXEC`/`CALL` entirely.

**IntelliSense / auto-uppercase**
- Completion provider is registered for `sql` with `.` as trigger character and never opens a
  connection while typing: it uses `manager.getDriver()` only, so object/column items appear only
  when a pool is already live.
- Order via `sortText` prefixes: `0_` aliases/columns/databases, `1_` keyword phrases, `2_` objects,
  `3_` functions. Objects outside `dbo`/`public` are inserted schema-qualified. In a FROM/JOIN
  clause (`editor.autoInsertAlias`) tables get a generated alias (`suggestAlias`).
- Auto-uppercase runs on `onDidChangeTextDocument` when the typed character is a delimiter, the
  previous word is in `UPPERCASE_WORDS`, it is not preceded by `.`/quote/`@#$`, and the prefix ends
  in plain code (not string / comment / quoted identifier). Undo/redo events (`e.reason`) are skipped.

**Webviews** (details in the `webview-protocol` skill)
- Results grid = `WebviewView` id `databaseHubResults` (`retainContextWhenHidden`); connection form =
  singleton `WebviewPanel` viewType `databaseHubConnection`.
- CSP is `default-src 'none'; style-src <cspSource>; script-src 'nonce-…'` with `media/` as the only
  local resource root — no inline scripts, no CDN. All dynamic text goes through `esc()`.
- Handshake: the webview posts `{ type: 'ready' }`; the results host buffers the last state message
  and replays it, the form host answers with `init`.
- `ENV_HEX` in `media/connectionForm.js` duplicates `ENV_META` hex values — keep them in sync.

**UI wiring**
- Tree `contextValue`s drive every context menu: `connection-on|off`, `database`, `folder-<type>`,
  `schema`, `object-<type>`, `column`, `parameter` (Connections); `history`; `favorite`; `snippet`.
- Keybindings: `Ctrl+Enter` = execute selection-or-all, `Ctrl+Shift+Enter` = execute all, only when
  `editorTextFocus && editorLangId == sql`.
- Environment colors come from `ENV_META`; PROD uses `statusBarItem.errorBackground`, UAT
  `statusBarItem.warningBackground`.

## Conventions

- Register commands only through `register()` in `src/extension.ts` (awaits, shows
  `Database Hub: <error>`, swallows messages matching `/cancelled/i`). Every id is `databaseHub.*`,
  declared in `package.json` `contributes.commands`, and hidden from the palette with
  `"when": "false"` when it needs a tree/list argument.
- User-facing messages start with `Database Hub: `. Modal confirmations use a single explicit action
  label (`Execute Anyway`, `Run on PROD`, `Delete`, `Clear`).
- Read settings live with `vscode.workspace.getConfiguration('databaseHub').get<T>('key', default)`;
  the inline default must equal the `package.json` default (the verify-build script checks this).
- Feature = folder under `src/` with `store.ts` (state + `onDidChange`) and `view.ts` (tree provider).
- Keep webviews dependency-free vanilla JS; keep the bundle small — do not add runtime deps casually.
- Match the existing style: 2-space indent, single quotes, trailing commas, `readonly` fields,
  small single-purpose files, doc comments explaining *why*.
- Commits: `feat: <imperative summary>` style, as in `git log`.
- README is the user manual: add a bullet / settings row for anything user-visible.

## README drift (checked 2026-09-03) — trust the code for these

- "streamed row-capped fetches" (intro) and "row cap" in *Known limitations*: no row cap exists since
  commit `00c7367`; all rows are fetched and the grid pages them by `grid.pageSize`.
- Settings table omits `editor.suggestions`, `editor.autoUppercaseKeywords`, `editor.autoInsertAlias`.
- Roadmap "Phase 2 autocomplete": tables, columns and aliases are already implemented in
  `intellisense.ts`; FK joins and procedure parameters are not.
- "One connection pool per profile": it is one pool per profile **and database**.

## Project skills (`.claude/skills/`)

| Skill | Use it when |
|---|---|
| `/verify-build` | Finishing any change: typecheck, build, contribution consistency script, smoke checklist, packaging |
| `/add-command` | Adding or changing a `databaseHub.*` command, menu item, toolbar button or keybinding |
| `/add-setting` | Adding a `databaseHub.*` configuration option |
| `/add-object-type` | Extending the explorer / drivers with a new object type or metadata query |
| `/webview-protocol` | Touching `media/*.js`, `results/panel.ts` or `connections/editorPanel.ts` |
