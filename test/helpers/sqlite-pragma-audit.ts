export interface SqlitePragmaOffender {
  line: number;
  statement: string;
  reason: string;
}

export interface SqliteOpenSiteOffender {
  line: number;
  reason: string;
}

const SINGLE_QUOTED_LITERAL = /'([^']*)'/g;
const TEMPLATE_LITERAL = /`([^`]*)`/g;
const SETS_BUSY_TIMEOUT = /^PRAGMA\s+busy_timeout\s*=/i;
const SETS_JOURNAL_MODE = /^PRAGMA\s+journal_mode\s*=/i;
const ASSIGNMENT_PRAGMA = /^PRAGMA\s+\w+\s*=/i;
const COMMENT_LINE = /^\s*(\/\/|\/\*|\*)/;
const OPENS_CONNECTION = /new Database\(/;
const OPEN_SITE_SETUP_LINES = 12;

/**
 * bun:sqlite applies pragmas in statement order, so every statement ahead of
 * `busy_timeout` runs with timeout 0. `journal_mode = WAL` takes a lock on the
 * database file, so an unlucky open during another process's close-time
 * checkpoint fails instantly with SQLITE_BUSY instead of retrying.
 */
export function scanSqlitePragmaOrder(relativePath: string, source: string): SqlitePragmaOffender[] {
  const offenders: SqlitePragmaOffender[] = [];
  const lines = source.split('\n');
  lines.forEach((text, index) => {
    if (!text.includes('PRAGMA') || COMMENT_LINE.test(text)) return;
    for (const match of text.matchAll(SINGLE_QUOTED_LITERAL)) {
      judgeLiteral(offenders, index + 1, match[1] ?? '');
    }
  });
  // The other natural spelling of a connection setup is a template literal, and
  // it routinely spans lines: a per-line scan sees no delimiter pair on the
  // PRAGMA-bearing lines and misses the whole block. Single-quoted strings stay
  // per-line because a JS single-quoted string cannot span lines, and pairing
  // apostrophes across the whole file swallows large regions.
  for (const match of source.matchAll(TEMPLATE_LITERAL)) {
    const literal = match[1] ?? '';
    if (!literal.includes('PRAGMA')) continue;
    const line = source.slice(0, match.index).split('\n').length;
    if (COMMENT_LINE.test(lines[line - 1] ?? '')) continue;
    judgeLiteral(offenders, line, literal);
  }
  return offenders.sort((left, right) => left.line - right.line);
}

/**
 * busy_timeout is per-connection state, so a connection that sets no pragma at
 * all retries nothing: it fails instantly with SQLITE_BUSY the first time
 * another process — or bun:sqlite's own GC reap — holds the write lock through
 * a close-time checkpoint. The ordering scan above cannot see such a site,
 * because it has no pragma literal to read.
 */
export function scanSqliteBusyTimeoutOpens(relativePath: string, source: string): SqliteOpenSiteOffender[] {
  const lines = source.split('\n');
  const openIndexes = lines
    .map((text, index) => (OPENS_CONNECTION.test(text) && !COMMENT_LINE.test(text) ? index : -1))
    .filter((index) => index >= 0);
  const offenders: SqliteOpenSiteOffender[] = [];
  for (let cursor = 0; cursor < openIndexes.length;) {
    // Adjacent open lines are one site: a readonly/readwrite ternary opens twice
    // and then configures whichever connection it produced.
    let last = cursor;
    while (last + 1 < openIndexes.length && openIndexes[last + 1]! - openIndexes[last]! <= 1) last += 1;
    const firstIndex = openIndexes[cursor]!;
    const setupStart = openIndexes[last]! + 1;
    // The setup window ends at the next unrelated open, so a later connection's
    // pragma cannot vouch for this one.
    const setupEnd = last + 1 < openIndexes.length
      ? Math.min(openIndexes[last + 1]!, firstIndex + OPEN_SITE_SETUP_LINES)
      : firstIndex + OPEN_SITE_SETUP_LINES;
    if (!/PRAGMA\s+busy_timeout\s*=/i.test(lines.slice(setupStart, setupEnd).join('\n'))) {
      offenders.push({ line: firstIndex + 1, reason: 'opens a connection that never sets busy_timeout' });
    }
    cursor = last + 1;
  }
  return offenders;
}

function judgeLiteral(offenders: SqlitePragmaOffender[], line: number, literal: string): void {
  const statements = literal.split(';').map((part) => part.trim()).filter(Boolean);
  // Introspection reads (`PRAGMA table_info(...)`, `PRAGMA foreign_key_check`)
  // set nothing and take no lock, so a literal with no assignment pragma is not
  // a connection setup. Everything else is judged, DDL included.
  if (!statements.some((statement) => ASSIGNMENT_PRAGMA.test(statement))) return;

  const setsBusyTimeout = statements.some((statement) => SETS_BUSY_TIMEOUT.test(statement));
  const setsJournalMode = statements.some((statement) => SETS_JOURNAL_MODE.test(statement));
  if (setsJournalMode && !setsBusyTimeout) {
    offenders.push({
      line,
      statement: literal,
      reason: 'sets journal_mode without ever setting busy_timeout on the connection',
    });
    return;
  }
  // The first statement overall, not the first pragma: a CREATE TABLE ahead of
  // busy_timeout takes the lock just as a lock-taking pragma does.
  if (setsBusyTimeout && !SETS_BUSY_TIMEOUT.test(statements[0]!)) {
    offenders.push({
      line,
      statement: literal,
      reason: `busy_timeout must be the first pragma, but "${statements[0]}" runs first with timeout 0`,
    });
  }
}
