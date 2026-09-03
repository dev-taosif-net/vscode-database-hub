---
name: verify-build
description: Verify a Database Hub change before calling it done - run typecheck and the esbuild bundle, run the contribution-consistency script (commands, menus, settings vs. source), and walk the manual smoke checklist for the area touched. There is no test suite, so this is the definition of done. Also covers listing and packaging the .vsix.
---

# Verify a change

No automated tests exist. A change is done when the steps below are clean for the area touched.

## 1. Static checks (every change)

```bash
npm run typecheck
npm run build
```

Both must exit 0. The only expected output beyond npm noise is esbuild's size line
`dist\extension.js 1.7mb ⚠️`. Any TypeScript error, or any other esbuild warning, must be fixed.

## 2. Contribution consistency (when `package.json` or anything under `src/` changed)

```bash
node .claude/skills/verify-build/scripts/check-contributions.js
```

It exits 1 and prints `BAD` lines for:

- commands declared in `contributes.commands` but not registered via `register()` in `src/extension.ts`, or vice versa;
- `menus` / `keybindings` entries referencing an undeclared command;
- `getConfiguration('databaseHub').get('key', default)` reads whose key is missing from `contributes.configuration` or whose inline default differs from the declared default;
- declared settings that nothing reads;
- `when` clauses naming a view id that is not contributed, and views placed in an unknown container.

Fix the source of truth (`package.json` or the code). Change the script only if the script itself is wrong.

## 3. Manual smoke checks

Press F5 ("Run Extension"), then run the rows for the area you touched.

| Area | Check |
|---|---|
| Connections | Add via fields and via a pasted connection string; **Test Connection** succeeds and fails visibly; editing with a blank password keeps the stored one; Delete removes the tree item |
| Explorer | Expand connection → folders → objects → columns / parameters; a browse-all profile (blank database) shows a Databases level; toggle Schema Focus Mode; Refresh on a node; Search Database Objects opens the picked object |
| Folder filter | Filter icon on Tables / Views / Procedures sets `order, dbo.cust*`; folder shows `filter: …`, only matches load, Search and Refresh icons stay visible; no-match shows one info row that clears on click; filter survives collapse, Refresh, disconnect, reconnect and a window reload; Clear icon removes it and all objects load again |
| Query | `Ctrl+Enter` with and without a selection; `Ctrl+Shift+Enter`; SQL Server `GO` batches give several result sets; cancel a long query (`WAITFOR DELAY '00:00:20'` / `SELECT pg_sleep(20)`) — the grid shows *Query cancelled.*; a bare `USE x` switches the tab (status bar + header comment) without executing |
| Safety | `DELETE FROM t` without WHERE shows the modal; any write on a PROD profile shows the PROD modal; a read-only profile blocks writes with an error toast |
| Results | Multiple result sets show as tabs; sort, filter, paging; Copy Cell / Rows CSV / Rows JSON; Export CSV and Export Excel write files; `PRINT` / `RAISE NOTICE` and rows-affected lines appear under the grid |
| History / Favorites / Snippets | The run appears at the top of history; Re-run works; Add to Favorites then open it; insert a snippet with no SQL editor open (a new one is created) |
| Status bar | Shows `host[:port]/db · user`, a lock when read-only, PROD red / UAT warning background; clicking switches the active connection |
| IntelliSense | With a live connection: `.` after a schema or alias lists members / columns; `USE ` lists databases; keywords uppercase when you type a space after them |

## 4. Package (only when asked)

```bash
npx @vscode/vsce ls        # dry run: must NOT list .claude/**, src/**, CLAUDE.md or *.map
npx @vscode/vsce package   # writes database-hub-<version>.vsix in the repo root (gitignored)
```

`@vscode/vsce` 3.x resolves through npx. `package.json` has no `repository` field; if `package`
stops to ask about it, re-run with `--allow-missing-repository`. Install a build locally with
`code --install-extension database-hub-<version>.vsix`.
