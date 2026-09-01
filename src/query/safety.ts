/**
 * Lightweight lexical SQL safety analysis. Not a full parser — it strips
 * comments and string literals, splits statements, then inspects leading
 * keywords. Deliberately errs on the side of warning.
 */

export interface SafetyIssue {
  statement: string;
  reason: string;
}

export interface SafetyAnalysis {
  issues: SafetyIssue[];
  hasWrites: boolean;
  writeVerbs: string[];
}

/** Verbs blocked when a connection is marked Read Only */
const READONLY_BLOCKED =
  /\b(INSERT|UPDATE|DELETE|MERGE|TRUNCATE|DROP|ALTER|CREATE|GRANT|REVOKE|EXEC|EXECUTE|CALL)\b/i;

export function stripCommentsAndStrings(sql: string): string {
  let out = '';
  let i = 0;
  const n = sql.length;
  while (i < n) {
    const two = sql.slice(i, i + 2);
    if (two === '--') {
      while (i < n && sql[i] !== '\n') i++;
    } else if (two === '/*') {
      let depth = 1;
      i += 2;
      while (i < n && depth > 0) {
        if (sql.slice(i, i + 2) === '/*') {
          depth++;
          i += 2;
        } else if (sql.slice(i, i + 2) === '*/') {
          depth--;
          i += 2;
        } else {
          i++;
        }
      }
    } else if (sql[i] === "'") {
      i++;
      while (i < n) {
        if (sql[i] === "'" && sql[i + 1] === "'") {
          i += 2;
        } else if (sql[i] === "'") {
          i++;
          break;
        } else {
          i++;
        }
      }
      out += "''";
    } else {
      out += sql[i];
      i++;
    }
  }
  return out;
}

export function splitStatements(cleanSql: string): string[] {
  return cleanSql
    .split(/;|^\s*GO\s*$/gim)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

export function analyzeSql(sql: string): SafetyAnalysis {
  const clean = stripCommentsAndStrings(sql);
  const statements = splitStatements(clean);
  const issues: SafetyIssue[] = [];
  const writeVerbs = new Set<string>();

  // Scan the whole script, not just statement heads, so writes hidden
  // behind CTEs (WITH ... UPDATE) still trigger PROD confirmation.
  const anywhere = new RegExp(READONLY_BLOCKED.source, 'gi');
  for (let m = anywhere.exec(clean); m; m = anywhere.exec(clean)) {
    writeVerbs.add(m[1].toUpperCase());
  }

  for (const stmt of statements) {
    const preview = stmt.replace(/\s+/g, ' ').slice(0, 80);
    if (/^\s*DELETE\b/i.test(stmt) && !/\bWHERE\b/i.test(stmt)) {
      issues.push({ statement: preview, reason: 'DELETE without a WHERE clause' });
    } else if (/^\s*UPDATE\b/i.test(stmt) && !/\bWHERE\b/i.test(stmt)) {
      issues.push({ statement: preview, reason: 'UPDATE without a WHERE clause' });
    } else if (/^\s*TRUNCATE\b/i.test(stmt)) {
      issues.push({ statement: preview, reason: 'TRUNCATE removes all rows' });
    } else if (/^\s*DROP\b/i.test(stmt)) {
      issues.push({ statement: preview, reason: 'DROP is irreversible' });
    }
  }

  return { issues, hasWrites: writeVerbs.size > 0, writeVerbs: [...writeVerbs] };
}

/** Returns the offending keyword when a read-only connection would be violated. */
export function readOnlyViolation(sql: string): string | undefined {
  const clean = stripCommentsAndStrings(sql);
  const match = READONLY_BLOCKED.exec(clean);
  return match ? match[1].toUpperCase() : undefined;
}
