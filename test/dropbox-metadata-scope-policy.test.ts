// The metadata-lane scope declaration: what it accepts, what it refuses, and
// why it refuses rather than repairs.
//
// This list is compared to `sync_runs.approved_scope_key` for exact equality.
// Anything this loader quietly "fixes" — a dropped bad entry, a lowercased
// folder name, a trimmed trailing slash — fences the reader to a scope no row
// carries, and the panel then reports "never synced" over a lane that is
// running. So the contract is: parse it exactly, or refuse it loudly.

import { describe, expect, test } from 'bun:test';
import {
  DROPBOX_METADATA_SCOPE_KEYS_ENV,
  dropboxMetadataScopeKeys,
  loadDropboxMetadataScopeKeys,
} from '../src/workers/dropbox-files/metadata-scope-policy.ts';

const ROOT_SCOPE = 'dropbox.personal:/';

describe('Dropbox metadata scope declaration', () => {
  test('reads the root population the live lane is launched with', () => {
    expect(loadDropboxMetadataScopeKeys({ [DROPBOX_METADATA_SCOPE_KEYS_ENV]: ROOT_SCOPE }))
      .toEqual([ROOT_SCOPE]);
  });

  test('an unset or blank key declares nothing, and nothing is not an empty population', () => {
    // Every reader falls back to the behaviour it had before this key existed.
    // An empty list here must never be read as "no scope is in the lane".
    expect(loadDropboxMetadataScopeKeys({})).toEqual([]);
    expect(loadDropboxMetadataScopeKeys({ [DROPBOX_METADATA_SCOPE_KEYS_ENV]: '   ' })).toEqual([]);
    expect(loadDropboxMetadataScopeKeys({ [DROPBOX_METADATA_SCOPE_KEYS_ENV]: ',,' })).toEqual([]);
  });

  test('keeps declared order, trims separators, and drops exact duplicates', () => {
    expect(loadDropboxMetadataScopeKeys({
      [DROPBOX_METADATA_SCOPE_KEYS_ENV]: ` ${ROOT_SCOPE} , dropbox.work:/Shared ,${ROOT_SCOPE}`,
    })).toEqual([ROOT_SCOPE, 'dropbox.work:/Shared']);
  });

  test('accepts the folder-id scope shape the enqueue path can also build', () => {
    expect(dropboxMetadataScopeKeys(['dropbox.personal:folder_id:id:abc123']))
      .toEqual(['dropbox.personal:folder_id:id:abc123']);
  });

  test('never folds case or a trailing slash, because the stored key does not', () => {
    // `/1 Projects` and `/1 projects` are different scope keys to SQLite here,
    // and guessing which one the lane wrote is how a fence silently matches no
    // row at all.
    expect(dropboxMetadataScopeKeys(['dropbox.personal:/1 Projects/']))
      .toEqual(['dropbox.personal:/1 Projects/']);
    expect(dropboxMetadataScopeKeys(['dropbox.personal:/1 Projects', 'dropbox.personal:/1 projects']))
      .toEqual(['dropbox.personal:/1 Projects', 'dropbox.personal:/1 projects']);
  });

  test('refuses a malformed entry instead of dropping it', () => {
    // Dropping one entry fences the reader to a SUBSET of the lane, which
    // reports a live scope as stale — the same failure from the other side.
    for (const malformed of ['/1 Projects', 'dropbox.personal', 'dropbox.personal:', 'dropbox.personal:1 Projects']) {
      expect(() => dropboxMetadataScopeKeys([malformed])).toThrow(/approved scope key/);
    }
    expect(() => dropboxMetadataScopeKeys([`${ROOT_SCOPE}${String.fromCharCode(10)}x`]))
      .toThrow(/control character/);
    expect(() => loadDropboxMetadataScopeKeys({
      [DROPBOX_METADATA_SCOPE_KEYS_ENV]: `${ROOT_SCOPE},not-a-scope`,
    })).toThrow(/approved scope key/);
  });

  test('a quote or a brace is a legal folder name here, unlike the content fence', () => {
    // These keys are bound as parameters and compared for equality; they are
    // never interpolated into SQL, so the content fence's stricter character
    // rule would only refuse folders a user is allowed to create.
    expect(dropboxMetadataScopeKeys([`dropbox.personal:/Notes {2026} 'draft'`]))
      .toEqual([`dropbox.personal:/Notes {2026} 'draft'`]);
  });
});
