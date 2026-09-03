// Which Dropbox scope the METADATA lane is actually pointed at.
//
// Two Dropbox `approved_scope_key` id spaces exist on the live host, and mixing
// them is this system's recurring failure mode. The overnight drain guard
// already carries the split in bash — `METADATA_SCOPES` versus
// `CONTENT_LEASE_SCOPES` in scripts/ops/install-private-host-overnight-source-drain-
// guard-systemd.sh, written after the 2026-07-05 and 2026-08-21 incidents were
// found to be the same mismatch pointed opposite ways. This module is that
// same split, on the TypeScript side, for the lane and the reader that reports
// on it.
//
// - METADATA scope: the account root, `dropbox.personal:/`. The sync lane
//   crawls the whole account and completes every ~30 minutes. `sync_runs`,
//   `sync_jobs` and `crawl_frontier` are keyed by it.
// - CONTENT scopes: the approved folders, `/1 Projects` and its siblings. They
//   are deliberately NOT the root and are owned by content-scope-policy.ts.
//   Nothing here may be read against a content lane, or the reverse.
//
// The third id space is the one that produced the defect this module exists to
// close: `sync_jobs` HISTORY. Dropbox moved from the three folder scopes to the
// root on 2026-07-27, and neither `sync_runs` nor `sync_jobs` forgets a retired
// scope — a completed job keeps its row forever. So "the distinct scope keys in
// sync_jobs" answers with the union of every era the lane ever ran in, which is
// not a configuration anybody declared and not the population the lane syncs
// now. The dashboard reported it as "Last run 27d ago / Completed 637 of 1,165"
// on a lane that had in fact completed a root sync twelve minutes earlier.
//
// The scope is CONFIGURATION, never a constant in this file, for the same
// reason the content scopes are: a hardcoded root here would be a second,
// silent copy of a population the operator already declares to the fleet, and
// the two would drift the first time the lane moved again — which is exactly
// the move that caused the incident. Absent configuration the fence is simply
// OFF, and every reader answers exactly as it did before this module existed.

/**
 * The metadata lane's declared population, as approved scope keys.
 *
 * Installed on the live host by the runtime refresh's
 * `install_dropbox_metadata_scope_keys_dropin`, from the reviewed manifest key
 * `SOURCE_INDEX_DROPBOX_METADATA_SCOPE_KEYS`. The source worker's scheduler
 * lane and the index reader inside that same worker process both read this one
 * value, so the population the lane syncs and the population the panel reports
 * are the same statement by construction rather than by agreement.
 */
export const DROPBOX_METADATA_SCOPE_KEYS_ENV = 'OLYMPUS_SOURCE_INDEX_DROPBOX_METADATA_SCOPE_KEYS';

const MAX_SCOPE_KEY_LENGTH = 4_096;
/**
 * Control characters only. Unlike the content fence these keys are never
 * interpolated into SQL — they are bound as parameters and compared for exact
 * equality — so a quote or a brace is a legal character in a folder name here.
 */
function hasControlCharacter(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (code < 0x20 || (code >= 0x7f && code <= 0x9f) || code === 0x2028 || code === 0x2029) {
      return true;
    }
  }
  return false;
}

/** The prefix a scope key uses when it names a folder by id rather than path. */
const FOLDER_ID_PREFIX = 'folder_id:';

/**
 * The declared metadata scope keys, or an empty list meaning "not configured".
 *
 * Empty is not "no scope is in the metadata lane": it means the population is
 * undeclared, and an undeclared population must not narrow what a reader
 * reports. Every caller falls back to the behaviour it had before this key
 * existed.
 */
export function loadDropboxMetadataScopeKeys(
  env: Record<string, string | undefined> = process.env,
): string[] {
  const raw = env[DROPBOX_METADATA_SCOPE_KEYS_ENV]?.trim();
  if (!raw) return [];
  return dropboxMetadataScopeKeys(raw.split(','), DROPBOX_METADATA_SCOPE_KEYS_ENV);
}

/**
 * Approved scope keys (`dropbox.personal:/`), trimmed and de-duplicated,
 * preserving the declared order.
 *
 * A malformed value THROWS rather than being dropped, matching the content
 * fence: a population that cannot be read is a policy nobody can check, and
 * silently dropping one entry would fence the reader to a SUBSET of the lane —
 * the mismatch this module exists to prevent, arrived at from the other side.
 *
 * Accepts both scope-key shapes the enqueue path builds, `<provider>.<account>:
 * <rooted path>` and `<provider>.<account>:folder_id:<id>`, because a key this
 * loader refused would be a key the lane could still legitimately be launched
 * with.
 *
 * The keys are compared to `sync_runs.approved_scope_key` for exact equality
 * and are NOT normalized beyond trimming. Case and trailing slashes are
 * significant: the enqueue normalizer reproduces the key from the folder
 * argument byte for byte, so folding them here would fence the reader to a
 * scope that no row carries — reporting "never synced" over a live lane.
 */
export function dropboxMetadataScopeKeys(
  values: readonly string[],
  sourceLabel = 'Dropbox metadata scope',
): string[] {
  const keys: string[] = [];
  for (const value of values) {
    const key = value.trim();
    if (!key) continue;
    const separator = key.indexOf('.') > 0 ? key.indexOf(':') : -1;
    const remainder = separator > 0 ? key.slice(separator + 1) : '';
    const names = remainder.startsWith('/')
      || (remainder.startsWith(FOLDER_ID_PREFIX) && remainder.length > FOLDER_ID_PREFIX.length);
    if (!names || key.length > MAX_SCOPE_KEY_LENGTH || hasControlCharacter(key)) {
      throw new Error(
        `${sourceLabel} entries must be an approved scope key of the form `
        + `"<provider>.<account>:<rooted path>" or "<provider>.<account>:folder_id:<id>", `
        + `with no control character: ${JSON.stringify(value)}`,
      );
    }
    if (!keys.includes(key)) keys.push(key);
  }
  return keys;
}
