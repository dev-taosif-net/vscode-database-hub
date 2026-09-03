---
name: add-setting
description: Add or change a databaseHub.* configuration option - declare it in package.json contributes.configuration, read it with the same default through getConfiguration('databaseHub'), react to changes where needed, and document it in the README settings table. Use whenever a feature needs a user-tunable value or toggle.
argument-hint: "[group.name] [type] [default]"
---

# Add a setting

## 1. Name it

`databaseHub.<group>.<name>` — existing groups: `query`, `editor`, `grid`, `history`, `safety`,
`explorer`, `metadata`, `snippets`. Reuse a group before inventing one.

## 2. Declare it — `package.json` → `contributes.configuration.properties`

```jsonc
"databaseHub.<group>.<name>": {
  "type": "boolean",   // or "number" (add "minimum"), "string", "array" (add "items")
  "default": true,
  "description": "One sentence ending with a period. Say when it takes effect if not immediately, e.g. \"Applied when a connection is opened.\""
}
```

## 3. Read it where it is used

```ts
const value = vscode.workspace
  .getConfiguration('databaseHub')
  .get<boolean>('<group>.<name>', true); // inline default MUST equal the package.json default
```

- Read at the moment of use, as every existing setting does, so changes apply without a reload.
- If the value is consumed once — like `query.timeoutSeconds`, applied in
  `ConnectionManager.doConnect` — say so in the description ("Applied when a connection is opened").
- A tree view that must re-render on change subscribes the way `SnippetsView` does:

  ```ts
  vscode.workspace.onDidChangeConfiguration((e) => {
    if (e.affectsConfiguration('databaseHub.<group>.<name>')) {
      this._onDidChangeTreeData.fire();
    }
  });
  ```

- A toggle command writes with
  `config.update('<group>.<name>', value, vscode.ConfigurationTarget.Global)` — see
  `databaseHub.toggleSchemaMode` in `src/extension.ts`.

## 4. Document it

Add a row to the **Settings** table in `README.md` (`Setting | Default | Description`), plus a
feature bullet if the behaviour is user-visible.

## 5. Verify

Run `/verify-build`: its script flags a key that is read but not declared, a default that differs
between code and `package.json`, and a declared setting that nothing reads. Then flip the setting in
the Extension Development Host and confirm the behaviour changes without a reload (unless the
description says otherwise).
