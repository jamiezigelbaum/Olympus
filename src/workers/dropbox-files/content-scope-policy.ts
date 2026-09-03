// Which Dropbox folders the content lanes are actually pointed at.
//
// Dropbox METADATA sync covers the account root, but content extraction is
// deliberately folder-scoped: the supervisor and the embedding drain are both
// launched against a fixed list of approved scope keys, and a file outside
// them is never extracted BY POLICY. Nothing was ever asked of it.
//
// Owner ruling, 2026-08-21: "Dropbox should be 100% because it's 100% of the
// files that are marked to embed that are embedded. Don't count the files that
// we are not using as part of that number." Before this module the ladder
// scored those files `qa_metadata_only_gap` — reviewable work nobody intends to
// do — and they dominated every gap total on the operator page.
//
// The scopes are CONFIGURATION, never a constant in this file. A hardcoded
// "/1 Projects" here would be a second, silent copy of a policy the operator
// already declares to the extraction fleet, and the two would drift the first
// time a folder was added. Absent configuration the fence is simply OFF: every
// count comes out exactly as it did before this module existed, which is the
// only safe answer when nobody has said what the lanes are pointed at.
//
// The SQL fragment here is interpolated into a Python f-string inside the
// remote probe (scripts/source-ingestion-live-dashboard.ts), so it may never
// contain `{`, `}`, a backslash or a triple quote — the same rule every
// fragment in extraction-readiness.ts lives under, and validated on the way in
// rather than trusted.

/**
 * The dedicated key. Set this when the content lanes' scope list and the
 * readiness fence should be able to differ — normally they must not.
 */
export const DROPBOX_CONTENT_SCOPE_KEYS_ENV = 'OLYMPUS_SOURCE_INDEX_DROPBOX_CONTENT_SCOPE_KEYS';

/**
 * The key the extraction fleet is ALREADY launched with on the live host, and
 * the reason this module needs no new policy of its own: the supervisor's OCR
 * lane carries the union of the content scopes, so reading it here makes the
 * fence and the lanes the same statement by construction.
 */
export const DROPBOX_SUPERVISOR_SCOPE_KEYS_ENV = 'OLYMPUS_SOURCE_PROCESSING_SUPERVISOR_DROPBOX_SCOPES';

const MAX_SCOPE_PATH_LENGTH = 4_096;
// Control characters, and the four characters that would break the SQL out of
// the Python f-string / triple-quoted literal it is embedded in.
const UNSAFE_SCOPE_PATH = /[\u0000-\u001f\u007f-\u009f\u2028\u2029{}\\]|"""/;

/**
 * The content-scope path prefixes, lowercased, from the first configured key
 * that names any — or an empty list, meaning "no fence configured".
 *
 * Empty is not the same as "nothing is in scope": it means the policy is
 * unknown, and an unknown policy must not move a single file out of the
 * denominator.
 */
export function loadDropboxContentScopePathPrefixes(
  env: Record<string, string | undefined> = process.env,
): string[] {
  for (const key of [DROPBOX_CONTENT_SCOPE_KEYS_ENV, DROPBOX_SUPERVISOR_SCOPE_KEYS_ENV]) {
    const raw = env[key]?.trim();
    if (!raw) continue;
    const prefixes = dropboxContentScopePathPrefixes(raw.split(','), key);
    if (prefixes.length > 0) return prefixes;
  }
  return [];
}

/**
 * Scope keys (`dropbox.personal:/1 Projects`) or bare rooted paths, normalized
 * to lowercase rooted paths with no trailing slash.
 *
 * A malformed value THROWS rather than being dropped. A scope list that cannot
 * be read is a policy nobody can check, and silently ignoring one entry of it
 * would move exactly that folder's files out of the denominator — the failure
 * this fence exists to prevent, arrived at from the other side.
 *
 * The account root (`/`) collapses the whole list to empty: everything is in
 * scope, so there is no fence to draw.
 */
export function dropboxContentScopePathPrefixes(
  values: readonly string[],
  sourceLabel = 'Dropbox content scope',
): string[] {
  const prefixes: string[] = [];
  for (const value of values) {
    const trimmed = value.trim();
    if (!trimmed) continue;
    const separator = trimmed.indexOf(':');
    const path = separator < 0 ? trimmed : trimmed.slice(separator + 1).trim();
    if (
      !path.startsWith('/')
      || path.length > MAX_SCOPE_PATH_LENGTH
      || UNSAFE_SCOPE_PATH.test(path)
      || path.includes("'")
    ) {
      throw new Error(
        `${sourceLabel} entries must be a rooted path, optionally prefixed by "<provider>.<account>:", `
        + `with no quote, brace, backslash or control character: ${JSON.stringify(value)}`,
      );
    }
    // The root approves everything; a fence that approves everything is no
    // fence, and saying so here keeps every downstream copy from having to.
    if (path === '/') return [];
    const normalized = path.replace(/\/+$/, '').toLowerCase();
    if (normalized && !prefixes.includes(normalized)) prefixes.push(normalized);
  }
  return prefixes;
}

/**
 * The SQL half of the fence: 1 when this ledger row's path is outside every
 * approved content scope, 0 when it is inside one or cannot be judged.
 *
 * Returns `'0'` for an empty prefix list, so an unconfigured deployment
 * interpolates a constant the query planner discards.
 *
 * Binds NO parameters, matching every other fragment the ladder interpolates:
 * a call site must be able to drop it anywhere without renumbering its own
 * placeholders. The prefixes are literals, which is why the validation above
 * refuses a value containing a quote.
 *
 * `substr`/`length` rather than LIKE on purpose: `_` and `%` are LIKE
 * wildcards, and a real folder name is allowed to contain both. Both functions
 * count CHARACTERS in SQLite, so they agree with each other on any path;
 * computing the length in TypeScript instead would disagree with SQLite the
 * first time a folder name left the BMP.
 *
 * A path that is not rooted is never judged out of scope. `path_lower` falls
 * back to the bare file name when an entry has no stored path at all, and a
 * name is not evidence of where the file lives.
 */
export function dropboxOutOfContentScopeSql(pathPrefixes: readonly string[]): string {
  if (pathPrefixes.length === 0) return '0';
  const inScope = pathPrefixes
    .map((prefix) => {
      const withSlash = `${prefix}/`;
      return `substr(path_lower, 1, length('${withSlash}')) = '${withSlash}'`
        + ` OR path_lower = '${prefix}'`;
    })
    .join('\n                  OR ');
  return `CASE WHEN substr(path_lower, 1, 1) = '/' AND NOT (
                  ${inScope}
                ) THEN 1 ELSE 0 END`;
}

/**
 * The TypeScript half of the same fence, for the per-row ledger scorer.
 *
 * Deliberately the same three decisions in the same order as the SQL: no
 * prefixes means never out of scope, a non-rooted path means never out of
 * scope, and otherwise the path must sit under one approved prefix.
 */
export function isOutOfDropboxContentScope(
  pathHint: string | undefined,
  pathPrefixes: readonly string[],
): boolean {
  if (pathPrefixes.length === 0) return false;
  const path = pathHint?.trim().toLowerCase() ?? '';
  if (!path.startsWith('/')) return false;
  return !pathPrefixes.some((prefix) => path === prefix || path.startsWith(`${prefix}/`));
}
