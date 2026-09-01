import { splitStatements, stripCommentsAndStrings } from './safety';

export interface UseAnalysis {
  /** Database named by the last USE statement in the script, unquoted */
  database?: string;
  /** True when the script consists of nothing but USE statements */
  onlyUse: boolean;
}

/** Matches `USE db`, `USE [db]`, `USE "db"` as a whole statement */
const USE_STATEMENT = /^USE\s+(?:\[([^\]]+)\]|"([^"]+)"|([\w$@#.]+))$/i;

/**
 * Finds USE statements so a tab can switch its database context
 * (SSMS-style) instead of leaving the binding, status bar and header
 * comment pointing at the old database.
 */
export function analyzeUse(sql: string): UseAnalysis {
  const statements = splitStatements(stripCommentsAndStrings(sql));
  let database: string | undefined;
  let others = 0;
  for (const stmt of statements) {
    const m = USE_STATEMENT.exec(stmt.replace(/\s+/g, ' ').trim());
    if (m) {
      database = m[1] ?? m[2] ?? m[3];
    } else {
      others++;
    }
  }
  return { database, onlyUse: database !== undefined && others === 0 };
}
