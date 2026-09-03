---
name: add-object-type
description: Extend the Database Hub object explorer and drivers - add a new ObjectType (tree folder, catalog queries for SQL Server and PostgreSQL, icons, menus, search, IntelliSense, favorites) or add a new per-object metadata query through the Driver interface and MetadataCache. Use when the explorer must show a new kind of database object or new metadata about existing ones.
argument-hint: "[object-type | metadata-query]"
---

# Extend the explorer / drivers

Two variants. Both end with `/verify-build`.

## A. New object type (e.g. `synonym`, `type`)

The `ObjectType` union fans out into several `Record<ObjectType, …>` maps, so the compiler points at
most of the places below. Work top-down:

1. **`src/types.ts`** — add the literal to `ObjectType` and its plural label to `OBJECT_TYPE_LABEL`.
2. **`src/explorer/tree.ts`**
   - `OBJECT_ICON`: a codicon name (existing: `table`, `window`, `gear`, `symbol-function`, `zap`, `list-ordered`).
   - `FOLDER_ORDER`: position of the folder under a database.
   - `objectItem()`: `expandable` is true for every type except `trigger` and `sequence` — add the new type to that leaf list unless it has children.
   - `getChildren()` case `'object'`: return columns (`cache.listColumns`), parameters (`cache.listParameters`) or `[]`.
3. **Both drivers — `listObjects()`** in `src/drivers/mssqlDriver.ts` and `src/drivers/postgresDriver.ts`.
   The map is `Record<ObjectType, string>`, so the build fails until both have a query. Row contract:
   columns `sch`, `name`, `detail` (`detail` may be `NULL`; it becomes the tree item description).
   - SQL Server: query `sys.*`, join `sys.schemas s`, filter `is_ms_shipped = 0`, `ORDER BY s.name, o.name`.
   - PostgreSQL: query `pg_catalog`, join `pg_namespace n`, include the shared `hideSchemas` predicate, `ORDER BY 1, 2`.
4. **Definition (optional)** — `getDefinition()` in both drivers (SQL Server `OBJECT_DEFINITION`;
   PostgreSQL the matching `pg_get_*def`). Then widen the `databaseHub.scriptCreate` menu regex
   `object-(view|procedure|function)` in `package.json`, and the `procedure || function` branches in
   `openPickedObject` and `databaseHub.favorites.open` in `src/extension.ts`.
5. **Data preview (optional)** — if `SELECT TOP` makes sense, widen the `databaseHub.selectTop1000`
   regex `object-(table|view)` and the `table || view` branches in `openPickedObject` / `favorites.open`.
6. **Favorites (optional)** — widen the `databaseHub.addObjectFavorite` regex and add an icon to
   `KIND_ICON` in `src/favorites/view.ts`.
7. **Search** — `databaseHub.searchObjects` in `src/extension.ts` hard-codes
   `['table', 'view', 'procedure', 'function', 'trigger', 'sequence']`; add the new type.
8. **IntelliSense (optional)** — `OBJECT_TYPES` and `OBJECT_KIND` in `src/query/intellisense.ts` if it
   should be completed. Only tables and views get alias insertion and column completion.
9. **Copy Qualified Name** already works: its menu matches the `object-` prefix.
10. **Cache** — nothing to add; the key is `<db>|objects:<type>`.
11. **README** — update the Object Explorer bullet that lists the tree levels.

Smoke test: expand the new folder on a SQL Server *and* a PostgreSQL connection; in Schema Focus Mode
the folder must appear only under schemas that contain such objects.

## B. New per-object metadata query (e.g. indexes, foreign keys)

1. **`src/drivers/driver.ts`** — add the method to the `Driver` interface, and a result type in `src/types.ts`.
2. **Both drivers** — implement it with parameters (`request.input()` on SQL Server, `$1` placeholders on
   PostgreSQL). Never concatenate identifiers into catalog SQL; on SQL Server pass
   `OBJECT_ID(@obj)` with `quoteIdent(schema) + '.' + quoteIdent(name)` as the column and parameter queries do.
3. **`src/explorer/cache.ts`** — add a wrapper that calls
   `this.fetch(connectionId, \`${database}|<kind>:${schema}.${name}\`, loader)` so TTL and
   stale-while-revalidate apply.
4. **Consumers** — go through the cache only (`this.cache.<method>(profile.id, database, driver, …)`),
   getting `driver` from `manager.connect(profile, database)` in the tree, or `manager.getDriver()`
   in IntelliSense, which must never trigger a connect.
5. **Invalidation** — nothing extra: per-connection invalidation drops the whole map.
