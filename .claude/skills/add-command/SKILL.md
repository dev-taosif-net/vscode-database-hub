---
name: add-command
description: Add or change a Database Hub command end to end - package.json contributes.commands, menus (palette, view/title, view/item/context, editor/title, editor/context), keybindings, the register() handler in src/extension.ts with the right argument shape, and the README. Use for any new databaseHub.* command, context-menu action, toolbar button or shortcut.
argument-hint: "[command-id] [surface: palette|tree|editor|keybinding]"
---

# Add a command

Everything user-triggerable is a `databaseHub.*` command declared in `package.json` and implemented
in `src/extension.ts`. Work through the steps in order; step 6 catches anything missed.

## 1. Choose the id and title

- Id pattern: `databaseHub.<verb>` for connection / explorer / query commands,
  `databaseHub.<view>.<verb>` for view-scoped ones (`history.*`, `favorites.*`, `snippets.*`).
  `grep -n "register('" src/extension.ts` lists the existing set.
- `"category": "Database Hub"`, an imperative `title`, and a `$(codicon)` `icon` if it will be an
  inline or toolbar button.

## 2. Declare it — `package.json` → `contributes.commands`

```json
{ "command": "databaseHub.<id>", "title": "<Imperative Title>", "category": "Database Hub", "icon": "$(play)" }
```

## 3. Decide where it appears — `contributes.menus`

| Surface | Menu key | `when` / `group` pattern used in this repo |
|---|---|---|
| Command palette | `commandPalette` | Commands that need a tree/list argument get `"when": "false"`; editor commands use `"editorLangId == sql"` |
| Connections view toolbar | `view/title` | `"view == databaseHubConnections"`, `"group": "navigation@N"` for an icon, no group for the `…` overflow menu |
| History view toolbar | `view/title` | `"view == databaseHubHistory"` |
| Tree item, inline icon | `view/item/context` | `"view == databaseHubConnections && viewItem == object-table"`, `"group": "inline@N"` |
| Tree item, right-click | `view/item/context` | Same `when`; groups `1_connection`, `1_query`, `2_refresh`, `5_copy`, `9_manage` (Connections) and `1_actions`, `9_manage` (History) |
| Editor title button | `editor/title` | `"editorLangId == sql && !databaseHub.queryRunning"` (`&& databaseHub.queryRunning` for the stop button), `"group": "navigation@N"` |
| Editor right-click | `editor/context` | `"editorLangId == sql"`, `"group": "databaseHub@N"`; add `&& editorHasSelection` for selection-only actions |
| Shortcut | `contributes.keybindings` | `"when": "editorTextFocus && editorLangId == sql"`, give both `key` and `mac` |

`viewItem` values (set in `src/explorer/tree.ts` and the view classes) and the argument the
handler receives:

| `contextValue` | Handler argument |
|---|---|
| `connection-off`, `connection-on` | `HubNode { kind: 'connection', connectionId }` |
| `database` | `HubNode { kind: 'database', connectionId, database }` (browse-all profiles only) |
| `folder-table`, `folder-view`, `folder-procedure`, `folder-function`, `folder-trigger`, `folder-sequence` | `HubNode { kind: 'folder', connectionId, database, objectType, schema? }` |
| `schema` | `HubNode { kind: 'schema', connectionId, database, schema }` (Schema Focus Mode) |
| `object-<type>` | `HubNode { kind: 'object', connectionId, database, schema?, obj: DbObject }` |
| `column`, `parameter` | `HubNode` carrying `column` / `param` |
| `history` | `HistoryEntry` |
| `favorite` | `FavoriteEntry` |
| `snippet` | `SnippetDef` |

Match several values with a regex, e.g. `viewItem =~ /^object-(table|view)$/`.

## 4. Implement it — `src/extension.ts`

Always go through the local `register()` wrapper: it awaits the handler, shows
`Database Hub: <message>` on error and swallows errors whose message matches `/cancelled/i`.
Never call `vscode.commands.registerCommand` directly.

```ts
register('databaseHub.<id>', async (node?: HubNode) => {
  if (!node?.obj) {
    return; // invoked without an argument (palette); or fall back to resolveNodeProfile(node)
  }
  const profile = store.get(node.connectionId);
  if (!profile) {
    return;
  }
  const driver = await ensureConnected(profile, node.database); // reuses a live pool, else connects with a progress notification
  // driver.*, cache.listObjects(profile.id, node.database!, driver, type), executor.runSql(profile, sql, node.database) ...
});
```

Helpers already defined inside `activate()`:

| Helper | Use |
|---|---|
| `pickProfile(placeholder)` | Quick pick over all profiles; offers "Add Connection" when there are none |
| `resolveNodeProfile(node)` | Profile from a node, else `pickProfile` |
| `ensureConnected(profile, database?)` | Live driver for that profile + database |
| `resolveDbContext(profile)` | Database to use: the fixed one, or a quick pick for browse-all profiles |
| `openSqlEditor(sql, profile?, database?)` | New untitled SQL document bound to the profile / database |
| `executor.runSql(profile, sql, database?)` | Full pipeline: safety gates, grid, history |
| `quoteFor(profile, name)` | `[name]` / `"name"` quoting |
| `cache.invalidateConnection(id)` then `explorer.refresh()` | After anything that changes server objects |

Commands that need a tree argument are hidden from the palette with `"when": "false"`. To expose
one in the palette, give the handler a no-argument fallback (`resolveNodeProfile` / `pickProfile`)
and drop the hide entry.

## 5. Document it

Add a bullet to the matching *Features* section of `README.md`.

## 6. Verify

Run `/verify-build`: the contribution script fails on any declared-but-unregistered or
registered-but-undeclared id and on menu references to unknown commands. Then exercise the new
surface in the Extension Development Host.
