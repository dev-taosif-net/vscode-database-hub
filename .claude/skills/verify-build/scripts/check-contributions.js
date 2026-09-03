#!/usr/bin/env node
// Cross-checks package.json contributions against src/.
// Run from the repo root:  node .claude/skills/verify-build/scripts/check-contributions.js
// Exits 1 when anything is inconsistent.
'use strict';
const fs = require('fs');
const path = require('path');

const root = process.cwd();
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const c = pkg.contributes;
let problems = 0;

function report(label, items) {
  if (items.length) {
    problems += items.length;
    console.log(`BAD  ${label}:`);
    for (const i of items) console.log(`     - ${i}`);
  } else {
    console.log(`OK   ${label}`);
  }
}

// 1. Commands: declared in package.json <-> registered through register() in src/extension.ts
const declared = new Set(c.commands.map((x) => x.command));
const ext = fs.readFileSync(path.join(root, 'src', 'extension.ts'), 'utf8');
const registered = new Set([...ext.matchAll(/register\('(databaseHub\.[\w.]+)'/g)].map((m) => m[1]));
report('commands declared but not registered in src/extension.ts', [...declared].filter((x) => !registered.has(x)));
report('commands registered but not declared in package.json', [...registered].filter((x) => !declared.has(x)));
const refs = [...Object.values(c.menus).flat(), ...(c.keybindings || [])].map((x) => x.command);
report('menu/keybinding entries referencing undeclared commands', [...new Set(refs.filter((r) => !declared.has(r)))]);

// 2. Settings: every getConfiguration('databaseHub').get('<key>', <default>) in src/ must be declared with the same default
const props = c.configuration.properties;
const tsFiles = [];
(function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p);
    else if (e.name.endsWith('.ts')) tsFiles.push(p);
  }
})(path.join(root, 'src'));
const reads = [];
for (const f of tsFiles) {
  const text = fs.readFileSync(f, 'utf8');
  for (const m of text.matchAll(/\.get<[^>]*>\(\s*'([\w.]+)'\s*,\s*([^)]+?)\s*\)/g)) {
    reads.push({ file: path.relative(root, f).replace(/\\/g, '/'), key: `databaseHub.${m[1]}`, def: m[2] });
  }
}
const badReads = [];
for (const r of reads) {
  const prop = props[r.key];
  let parsed;
  try {
    parsed = JSON.parse(r.def);
  } catch {
    parsed = undefined;
  }
  if (!prop) badReads.push(`${r.key} is read in ${r.file} but not declared`);
  else if (JSON.stringify(prop.default) !== JSON.stringify(parsed))
    badReads.push(`${r.key}: code default ${r.def} != package.json default ${JSON.stringify(prop.default)} (${r.file})`);
}
report('setting reads vs package.json defaults', badReads);
report('settings declared but never read in src/', Object.keys(props).filter((k) => !reads.some((r) => r.key === k)));

// 3. Views: menu when-clauses reference contributed views; views sit in contributed containers
const containers = new Set(Object.values(c.viewsContainers).flat().map((v) => v.id));
const viewIds = new Set(Object.values(c.views).flat().map((v) => v.id));
report('views placed in unknown containers', Object.keys(c.views).filter((k) => !containers.has(k)));
const viewRefs = new Set();
for (const entries of Object.values(c.menus))
  for (const e of entries) for (const m of (e.when || '').matchAll(/view == (\w+)/g)) viewRefs.add(m[1]);
report('menu when-clauses referencing unknown views', [...viewRefs].filter((v) => !viewIds.has(v)));

console.log(problems ? `\n${problems} problem(s) found.` : '\nAll contribution checks passed.');
process.exit(problems ? 1 : 0);
