# Database Hub

Fast, lightweight database tools for **Microsoft SQL Server** and **PostgreSQL**, completely inside VS Code. Built for large enterprise databases (thousands of procedures and tables, many schemas, many environments) with a strict *performance first* philosophy: lazy loading everywhere, aggressive metadata caching, streamed row-capped fetches, and near-zero startup cost.

## Features (Phase 1)

### Connections
- Unlimited connections to SQL Server and PostgreSQL.
- Native multi-step wizard (no webview): name, environment, host, port, database, auth, read-only mode.
- SQL Login and Windows (NTLM) authentication for SQL Server.
- Passwords are stored only in VS Code **Secret Storage** (OS keychain), never in settings.

### Environment colors & safety
Every connection has an environment that colors the explorer, status bar, and results grid:

| Environment | Color |
|---|---|
| DEV | 🟢 Green |
| QA | 🔵 Blue |
| UAT | 🟠 Orange (status bar warning background) |
| PROD | 🔴 Red (status bar error background) |

Safety features:
- **Dangerous query detection** — `DELETE`/`UPDATE` without `WHERE`, `TRUNCATE`, `DROP` trigger a modal warning before execution.
- **PROD confirmation** — any write statement against a PROD connection requires explicit confirmation (catches writes hidden behind CTEs too).
- **Read-only connections** — block all write statements client-side; PostgreSQL sessions additionally get `default_transaction_read_only = on`.

### Object Explorer
- Activity bar container with **Connections / Query History / Favorites / Snippets** views.
- Lazy tree: `Connection → Tables / Views / Procedures / Functions / Triggers / Sequences → columns / parameters`. Nothing loads until you expand it.
- **Schema Focus Mode** (toggle in the view title): group by schema instead of object type — ideal for databases with 100+ schemas.
- Metadata cache with TTL (`databaseHub.metadata.cacheTtlMinutes`): stale data is served instantly and refreshed in the background, so the tree never blocks.
- Context actions: SELECT Top 1000, Script as CREATE, Copy Qualified Name, Add to Favorites, per-connection Refresh.
- **Search Database Objects** (magnifier in the view title): instant fuzzy search across all cached tables, views, procedures, functions, triggers and sequences.

### Query execution
- `Ctrl+Enter` — execute selection (or whole file when nothing is selected); `Ctrl+Shift+Enter` — execute all.
- Async with cancel (toolbar stop button or the progress notification). SQL Server `GO` batch separators are supported.
- Per-editor connection binding: each SQL editor remembers which connection it talks to (plug icon in the editor title).
- Execution timeout (`databaseHub.query.timeoutSeconds`) and row cap (`databaseHub.query.maxRows`). SQL Server results are **streamed** and execution stops at the cap, so a runaway `SELECT *` can never freeze VS Code.

### Results grid
- Environment color band with connection · server / database · row count · duration.
- Multiple result sets as tabs, sorting, instant filtering, pagination.
- Copy cell / rows as CSV / rows as JSON; export CSV or Excel; `NULL` styling; server messages (`PRINT`, `RAISERROR`, notices, rows-affected).

### Query history
- Every execution recorded (query, connection, environment, duration, rows, errors) — capped by `databaseHub.history.maxEntries`.
- Search, re-run, open in editor, copy, favorite, delete, clear.

### Favorites & snippets
- Favorite tables, views, procedures, functions and queries; opening a favorite runs SELECT Top 1000 or scripts the definition.
- Built-in snippet library per dialect (pagination, MERGE/upsert, CTE, recursive CTE, audit query, dynamic SQL, EXPLAIN ANALYZE) plus custom snippets via `databaseHub.snippets.custom`.

### Status bar
- Active connection with environment color; PROD gets the red status-bar background, UAT the warning background, read-only shows a lock. Click to switch connections.

## Getting started (development)

```bash
npm install
npm run build      # or: npm run watch
```

Press **F5** ("Run Extension") to launch the Extension Development Host, open the Database Hub activity bar icon, and add a connection.

## Settings

| Setting | Default | Description |
|---|---|---|
| `databaseHub.query.timeoutSeconds` | `120` | Query timeout (0 = none), applied at connect time |
| `databaseHub.query.maxRows` | `5000` | Row cap per result set |
| `databaseHub.grid.pageSize` | `200` | Rows per page in the grid |
| `databaseHub.history.maxEntries` | `200` | History size |
| `databaseHub.safety.warnDangerousQueries` | `true` | Warn on dangerous statements |
| `databaseHub.safety.requireProdConfirmation` | `true` | Confirm writes on PROD |
| `databaseHub.explorer.groupBySchema` | `false` | Schema Focus Mode |
| `databaseHub.metadata.cacheTtlMinutes` | `10` | Metadata cache TTL |
| `databaseHub.snippets.custom` | `[]` | Custom snippets |

## Architecture notes

- **Two runtime dependencies** (`mssql`, `pg` — both pure JS), bundled to a single file with esbuild. No frameworks, no webview UI except the results grid (vanilla JS).
- Activation only on `onLanguage:sql` or opening a Database Hub view; startup impact is near zero.
- One connection pool per profile (max 4), created lazily on first use.
- Metadata queries fetch one object type per round-trip and are cached per connection; the explorer tree, object search and schema mode all read from the same cache.

## Roadmap

- **Phase 2** — smart SQL autocomplete (tables, columns, aliases, FK joins, procedure parameters).
- **Phase 3** — execution plan viewer (ShowPlan XML / EXPLAIN ANALYZE), query analytics and warnings, .NET solution integration (find procedure usages in Dapper/ADO.NET/EF Core code), dependency graph.

## Known limitations (v1)

- `GO <count>` repeat batches are not supported (plain `GO` is).
- PostgreSQL results are buffered before the row cap is applied (SQL Server results are streamed and capped server-side).
- Read-only mode blocks `EXEC`/`CALL` entirely, including read-only procedures.
- Scripting `CREATE` is available for views, procedures and functions (not tables).
