import { splitStatements, stripCommentsAndStrings } from './safety';

export interface UseAnalysis {
  /** Database named by the last USE statement in the script, unquoted */
  database?: string;
  /** True when the script consists of nothing but USE statements */
  onlyUse: boolean;
}

/** Matches a statement starting `USE db`, `USE [db]`, `USE "db"`, capturing any same-line tail */
const USE_STATEMENT = /^USE\s+(?:\[([^\]]+)\]|"([^"]+)"|([\w$@#.]+))\s*(.*)$/i;

/**
 * Finds USE statements so a tab can switch its database context
 * (SSMS-style) instead of leaving the binding, status bar and header
 * comment pointing at the old database.
 */
export function analyzeUse(sql: string): UseAnalysis {
  const clean = stripCommentsAndStrings(sql);
  let database: string | undefined;
  let others = 0;
  // T-SQL needs no statement terminator, so `USE db` directly above a SELECT
  // arrives as one ;-delimited chunk. Split on newlines too: a USE is only
  // ever recognized at the start of a line anyway, and a multi-line statement
  // counting as several "others" doesn't change the onlyUse boolean.
  for (const line of clean.split(/\r?\n/)) {
    for (const stmt of splitStatements(line)) {
      const m = USE_STATEMENT.exec(stmt);
      if (m) {
        database = m[1] ?? m[2] ?? m[3];
        if (m[4]) {
          others++; // `USE db SELECT …` crammed on one line
        }
      } else {
        others++;
      }
    }
  }
  return { database, onlyUse: database !== undefined && others === 0 };
}
