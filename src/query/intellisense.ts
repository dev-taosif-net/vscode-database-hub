import * as vscode from 'vscode';
import { ConnectionManager, defaultDatabase } from '../connections/manager';
import { Driver } from '../drivers/driver';
import { MetadataCache } from '../explorer/cache';
import { ConnectionProfile, DbObject, ObjectType } from '../types';
import { EditorBinding } from './editorBinding';
import {
  COMMON_FUNCTIONS,
  KEYWORD_PHRASES,
  MSSQL_FUNCTIONS,
  POSTGRES_FUNCTIONS,
  UPPERCASE_WORDS,
} from './sqlKeywords';

const OBJECT_TYPES: readonly ObjectType[] = ['table', 'view', 'procedure', 'function'];

const OBJECT_KIND: Record<string, vscode.CompletionItemKind> = {
  table: vscode.CompletionItemKind.Struct,
  view: vscode.CompletionItemKind.Interface,
  procedure: vscode.CompletionItemKind.Method,
  function: vscode.CompletionItemKind.Function,
};

interface EditorContext {
  profile: ConnectionProfile;
  database: string;
  /** Present only when a live pool exists — never connect while typing. */
  driver: Driver | undefined;
}

/** `schema.table` (or bare `table`) a FROM/JOIN alias points at. */
interface AliasTarget {
  schema?: string;
  name: string;
  /** Original-case alias text when this entry was declared via an alias. */
  aliasText?: string;
}

const IDENT = String.raw`(?:\[[^\]]+\]|"[^"]+"|[\w$]+)`;
const ALIAS_RE = new RegExp(
  String.raw`\b(?:from|join|update|into)\s+(${IDENT})(?:\s*\.\s*(${IDENT}))?` +
    String.raw`(?:\s+(?:as\s+)?(?!(?:where|on|join|inner|left|right|full|cross|outer|group|order|having|union|intersect|except|limit|offset|set|values|select|when|then|and|or|not|as|with)\b)([A-Za-z_][\w$]*))?`,
  'gi',
);

function stripQuotes(s: string): string {
  return s.replace(/^[\["]|[\]"]$/g, '');
}

/** Map alias → target and table-name → itself from FROM/JOIN/UPDATE/INTO clauses. */
function parseAliases(sql: string): Map<string, AliasTarget> {
  const map = new Map<string, AliasTarget>();
  for (const m of sql.matchAll(ALIAS_RE)) {
    const first = stripQuotes(m[1]);
    const second = m[2] ? stripQuotes(m[2]) : undefined;
    const alias = m[3];
    const target: AliasTarget = second ? { schema: first, name: second } : { name: first };
    map.set(target.name.toLowerCase(), target);
    if (alias) {
      map.set(alias.toLowerCase(), { ...target, aliasText: alias });
    }
  }
  return map;
}

/** Text of the `;`/`GO`-delimited statement containing the cursor. */
function currentStatement(document: vscode.TextDocument, position: vscode.Position): string {
  const text = document.getText();
  const offset = document.offsetAt(position);
  const boundary = /;|^[ \t]*go[ \t]*\d*[ \t]*$/gim;
  let start = 0;
  let end = text.length;
  for (const m of text.matchAll(boundary)) {
    const idx = m.index ?? 0;
    if (idx < offset) {
      start = idx + m[0].length;
    } else {
      end = idx;
      break;
    }
  }
  return text.slice(start, end);
}

/** Short alias for a table name: initials of its words (`order_details` → `od`,
 *  `OrderDetails` → `od`), skipping SQL keywords and names already in use. */
function suggestAlias(name: string, taken: ReadonlySet<string>): string {
  const parts = name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[\s_-]+/)
    .filter(Boolean);
  let base = parts
    .map((p) => p[0])
    .join('')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
  if (!base || /^\d/.test(base)) {
    base = 't';
  }
  if (!taken.has(base) && !UPPERCASE_WORDS.has(base)) {
    return base;
  }
  for (let i = 2; ; i++) {
    const candidate = `${base}${i}`;
    if (!taken.has(candidate) && !UPPERCASE_WORDS.has(candidate)) {
      return candidate;
    }
  }
}

function snippetEscape(s: string): string {
  return s.replace(/[\\$}]/g, '\\$&');
}

/** True when the cursor sits right after FROM/JOIN (optionally mid-way through
 *  a table name) — the spot where a completed table should get an alias.
 *  `DELETE FROM` is excluded: an inline alias there is not portable T-SQL. */
const FROM_TAIL_RE = new RegExp(
  String.raw`\b(?:from|join)\s+(?:${IDENT}\s*\.\s*)?[\w$"\[\]]*$`,
  'i',
);

function inTableClause(beforeCursor: string): boolean {
  const m = FROM_TAIL_RE.exec(beforeCursor);
  if (!m) {
    return false;
  }
  return !/\bdelete\s+$/i.test(beforeCursor.slice(0, m.index));
}

export class SqlCompletionProvider implements vscode.CompletionItemProvider {
  constructor(
    private readonly binding: EditorBinding,
    private readonly manager: ConnectionManager,
    private readonly cache: MetadataCache,
  ) {}

  async provideCompletionItems(
    document: vscode.TextDocument,
    position: vscode.Position,
  ): Promise<vscode.CompletionItem[]> {
    const config = vscode.workspace.getConfiguration('databaseHub');
    if (!config.get<boolean>('editor.suggestions', true)) {
      return [];
    }
    const aliases = parseAliases(currentStatement(document, position));
    const beforeCursor = document.getText(
      new vscode.Range(new vscode.Position(0, 0), position),
    );
    const withAlias =
      config.get<boolean>('editor.autoInsertAlias', true) && inTableClause(beforeCursor);
    const linePrefix = document.lineAt(position).text.slice(0, position.character);
    const member = linePrefix.match(
      new RegExp(String.raw`(${IDENT})\.[\w$]*$`),
    );
    if (member) {
      const ident = stripQuotes(member[1]);
      // `1.` is a numeric literal being typed, not a member access.
      return /^\d+$/.test(ident)
        ? []
        : this.memberCompletions(document, ident, aliases, withAlias);
    }
    return this.topLevelCompletions(document, aliases, withAlias);
  }

  private resolveContext(document: vscode.TextDocument): EditorContext | undefined {
    const bound = this.binding.getBindingFor(document);
    if (!bound) {
      return undefined;
    }
    const database = bound.database ?? defaultDatabase(bound.profile);
    return {
      profile: bound.profile,
      database,
      driver: this.manager.getDriver(bound.profile, bound.database),
    };
  }

  private async listObjects(ctx: EditorContext): Promise<DbObject[]> {
    if (!ctx.driver) {
      return [];
    }
    const driver = ctx.driver;
    try {
      const lists = await Promise.all(
        OBJECT_TYPES.map((t) =>
          this.cache.listObjects(ctx.profile.id, ctx.database, driver, t),
        ),
      );
      return lists.flat();
    } catch {
      return [];
    }
  }

  private async topLevelCompletions(
    document: vscode.TextDocument,
    aliases: ReadonlyMap<string, AliasTarget>,
    withAlias: boolean,
  ): Promise<vscode.CompletionItem[]> {
    const ctx = this.resolveContext(document);
    const items: vscode.CompletionItem[] = [];

    for (const target of aliases.values()) {
      if (!target.aliasText) {
        continue;
      }
      const item = new vscode.CompletionItem(
        {
          label: target.aliasText,
          description: (target.schema ? `${target.schema}.` : '') + target.name,
        },
        vscode.CompletionItemKind.Variable,
      );
      item.detail = 'table alias';
      // No trailing space: `.` typically follows and must stay adjacent so
      // column completions trigger.
      item.sortText = `0_${target.aliasText}`;
      items.push(item);
    }

    for (const phrase of KEYWORD_PHRASES) {
      const item = new vscode.CompletionItem(phrase, vscode.CompletionItemKind.Keyword);
      item.insertText = `${phrase} `;
      item.sortText = `1_${phrase}`;
      items.push(item);
    }

    const functions =
      ctx?.profile.type === 'mssql'
        ? MSSQL_FUNCTIONS
        : ctx?.profile.type === 'postgres'
          ? POSTGRES_FUNCTIONS
          : COMMON_FUNCTIONS;
    for (const fn of functions) {
      const item = new vscode.CompletionItem(
        { label: fn, description: 'built-in' },
        vscode.CompletionItemKind.Function,
      );
      item.insertText = new vscode.SnippetString(`${fn}($0)`);
      item.sortText = `3_${fn}`;
      items.push(item);
    }

    if (ctx?.driver) {
      const taken = withAlias ? new Set(aliases.keys()) : undefined;
      for (const obj of await this.listObjects(ctx)) {
        items.push(this.objectItem(ctx, obj, false, taken));
      }
    }
    return items;
  }

  private objectItem(
    ctx: EditorContext,
    obj: DbObject,
    bareName: boolean,
    aliasTaken?: ReadonlySet<string>,
  ): vscode.CompletionItem {
    const item = new vscode.CompletionItem(
      { label: obj.name, description: `${obj.schema}.${obj.name}` },
      OBJECT_KIND[obj.type] ?? vscode.CompletionItemKind.Value,
    );
    item.detail = obj.type + (obj.detail ? ` · ${obj.detail}` : '');
    const defaultSchema = ctx.profile.type === 'mssql' ? 'dbo' : 'public';
    const qualify = !bareName && obj.schema.toLowerCase() !== defaultSchema;
    const name = this.quoteIfNeeded(ctx, obj.name);
    const text = qualify ? `${this.quoteIfNeeded(ctx, obj.schema)}.${name}` : name;
    if (obj.type === 'function') {
      item.insertText = new vscode.SnippetString(`${text}($0)`);
    } else if (aliasTaken && (obj.type === 'table' || obj.type === 'view')) {
      const alias = suggestAlias(obj.name, aliasTaken);
      item.insertText = new vscode.SnippetString(
        `${snippetEscape(text)} \${1:${alias}} `,
      );
    } else {
      item.insertText = `${text} `;
    }
    item.filterText = obj.name;
    item.sortText = `2_${obj.name}`;
    return item;
  }

  private quoteIfNeeded(ctx: EditorContext, name: string): string {
    const plain =
      ctx.profile.type === 'postgres'
        ? /^[a-z_][a-z0-9_$]*$/.test(name)
        : /^[A-Za-z_@#][\w@#$]*$/.test(name);
    if (plain) {
      return name;
    }
    return ctx.driver
      ? ctx.driver.quoteIdent(name)
      : ctx.profile.type === 'mssql'
        ? `[${name.replace(/]/g, ']]')}]`
        : `"${name.replace(/"/g, '""')}"`;
  }

  /** Completions after `<ident>.` — schema members, or columns of a table/alias. */
  private async memberCompletions(
    document: vscode.TextDocument,
    ident: string,
    aliases: ReadonlyMap<string, AliasTarget>,
    withAlias: boolean,
  ): Promise<vscode.CompletionItem[]> {
    const ctx = this.resolveContext(document);
    if (!ctx?.driver) {
      return [];
    }
    const objects = await this.listObjects(ctx);
    const lower = ident.toLowerCase();

    const inSchema = objects.filter((o) => o.schema.toLowerCase() === lower);
    if (inSchema.length > 0) {
      const taken = withAlias ? new Set(aliases.keys()) : undefined;
      return inSchema.map((o) => this.objectItem(ctx, o, true, taken));
    }

    const relations = objects.filter((o) => o.type === 'table' || o.type === 'view');
    const target = aliases.get(lower);
    const wantedSchema = target?.schema?.toLowerCase();
    const wantedName = (target?.name ?? ident).toLowerCase();
    const relation = relations.find(
      (o) =>
        o.name.toLowerCase() === wantedName &&
        (!wantedSchema || o.schema.toLowerCase() === wantedSchema),
    );
    if (!relation) {
      return [];
    }
    try {
      const columns = await this.cache.listColumns(
        ctx.profile.id,
        ctx.database,
        ctx.driver,
        relation.schema,
        relation.name,
      );
      return columns.map((c) => {
        const item = new vscode.CompletionItem(
          { label: c.name, description: `${relation.schema}.${relation.name}` },
          vscode.CompletionItemKind.Field,
        );
        item.detail =
          c.dataType +
          (c.nullable ? '' : ' NOT NULL') +
          (c.isPrimaryKey ? ' · PK' : '') +
          (c.isIdentity ? ' · identity' : '');
        item.insertText = `${this.quoteIfNeeded(ctx, c.name)} `;
        item.sortText = `0_${c.name}`;
        return item;
      });
    } catch {
      return [];
    }
  }
}

// ---------- keyword auto-uppercase ----------

/** True when `offset` (end of text) is plain code — not inside a string,
 *  comment, or quoted identifier. */
function endsInCode(text: string): boolean {
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === '-' && text[i + 1] === '-') {
      const nl = text.indexOf('\n', i);
      if (nl === -1) {
        return false;
      }
      i = nl + 1;
      continue;
    }
    if (c === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      if (end === -1) {
        return false;
      }
      i = end + 2;
      continue;
    }
    if (c === "'") {
      let j = i + 1;
      let closed = false;
      while (j < text.length) {
        if (text[j] === "'") {
          if (text[j + 1] === "'") {
            j += 2;
            continue;
          }
          closed = true;
          j++;
          break;
        }
        j++;
      }
      if (!closed) {
        return false;
      }
      i = j;
      continue;
    }
    if (c === '"' || c === '[') {
      const end = text.indexOf(c === '"' ? '"' : ']', i + 1);
      if (end === -1) {
        return false;
      }
      i = end + 1;
      continue;
    }
    i++;
  }
  return true;
}

/** Characters that finish a word and trigger uppercasing. '.' is excluded so
 *  `alias.left` style references stay untouched. */
const DELIMITER = /[\s,;()=<>!+\-*/%&|^]/;

/** Characters immediately before a word that mark it as an identifier, not a keyword. */
const IDENT_PREFIX = /[.\w\]"'@#$]/;

export function registerAutoUppercase(): vscode.Disposable {
  return vscode.workspace.onDidChangeTextDocument(async (e) => {
    if (e.document.languageId !== 'sql' || e.reason || e.contentChanges.length === 0) {
      return;
    }
    if (
      !vscode.workspace
        .getConfiguration('databaseHub')
        .get<boolean>('editor.autoUppercaseKeywords', true)
    ) {
      return;
    }

    const edit = new vscode.WorkspaceEdit();
    for (const change of e.contentChanges) {
      const first = change.text[0] ?? '';
      if (!DELIMITER.test(first)) {
        continue;
      }
      const pos = change.range.start;
      if (pos.character === 0) {
        continue;
      }
      const wordRange = e.document.getWordRangeAtPosition(
        pos.translate(0, -1),
        /[A-Za-z_][\w]*/,
      );
      if (!wordRange || !wordRange.end.isEqual(pos)) {
        continue;
      }
      const word = e.document.getText(wordRange);
      if (word === word.toUpperCase() || !UPPERCASE_WORDS.has(word.toLowerCase())) {
        continue;
      }
      if (wordRange.start.character > 0) {
        const before = e.document.getText(
          new vscode.Range(wordRange.start.translate(0, -1), wordRange.start),
        );
        if (IDENT_PREFIX.test(before)) {
          continue;
        }
      }
      const prefix = e.document.getText(
        new vscode.Range(new vscode.Position(0, 0), wordRange.start),
      );
      if (!endsInCode(prefix)) {
        continue;
      }
      edit.replace(e.document.uri, wordRange, word.toUpperCase());
    }
    if (edit.size > 0) {
      await vscode.workspace.applyEdit(edit);
    }
  });
}
