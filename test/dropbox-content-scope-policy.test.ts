// The content-lane scope fence: where it comes from, and how it reaches the
// dashboard.
//
// Two failures live here. The first is a policy invented in code — a hardcoded
// "/1 Projects" would be a second copy of what the operator already tells the
// extraction fleet, and the two would drift the first time a folder was added.
// The second is the one that produced the live 55%: the Dropbox corpus now
// serves its status from the CONNECTOR STORE, whose counts are only
// {chunks, embedded_chunks, indexed_items, sync_runs, tombstoned_items}. No
// qa_* key reached the dashboard at all, so the answer-ready card fell back to
// a chunks-over-items ratio and reported work nobody was going to do.

import { describe, expect, test } from 'bun:test';
import {
  DROPBOX_CONTENT_SCOPE_KEYS_ENV,
  DROPBOX_SUPERVISOR_SCOPE_KEYS_ENV,
  dropboxContentScopePathPrefixes,
  dropboxOutOfContentScopeSql,
  isOutOfDropboxContentScope,
  loadDropboxContentScopePathPrefixes,
} from '../src/workers/dropbox-files/content-scope-policy.ts';
import { dropboxQaVerdictLadderSql } from '../src/workers/dropbox-files/extraction-readiness.ts';

describe('the approved content scopes come from configuration', () => {
  test('a scope key is read as its path, lowercased and unrooted of trailing slash', () => {
    expect(dropboxContentScopePathPrefixes([
      'dropbox.personal:/1 Projects',
      'dropbox.personal:/2 Areas/',
    ])).toEqual(['/1 projects', '/2 areas']);
  });

  test('a bare rooted path is accepted, and duplicates collapse', () => {
    expect(dropboxContentScopePathPrefixes(['/1 Projects', 'dropbox.personal:/1 projects']))
      .toEqual(['/1 projects']);
  });

  test('the account root approves everything, so it draws no fence at all', () => {
    // Not "nothing is in scope" — the opposite. A list containing the root can
    // never exclude a file, and saying so once here keeps every downstream copy
    // from having to work it out.
    expect(dropboxContentScopePathPrefixes(['dropbox.personal:/'])).toEqual([]);
    expect(isOutOfDropboxContentScope('/4 Archive/old.pdf', [])).toBe(false);
  });

  test('a malformed entry throws instead of being quietly dropped', () => {
    // Dropping one entry would move exactly that folder's files out of the
    // denominator — the failure this fence exists to prevent, from the other
    // side. Quotes and braces are refused because the value is interpolated as
    // a SQL literal inside a Python f-string.
    expect(() => dropboxContentScopePathPrefixes(['1 Projects'])).toThrow(/rooted path/);
    expect(() => dropboxContentScopePathPrefixes(["/it's mine"])).toThrow(/rooted path/);
    expect(() => dropboxContentScopePathPrefixes(['/brace{0}'])).toThrow(/rooted path/);
    expect(() => dropboxContentScopePathPrefixes(['/back\\slash'])).toThrow(/rooted path/);
  });

  test('the dedicated key wins, the fleet\'s own key is the fallback, absent means no fence', () => {
    expect(loadDropboxContentScopePathPrefixes({
      [DROPBOX_CONTENT_SCOPE_KEYS_ENV]: 'dropbox.personal:/Dedicated',
      [DROPBOX_SUPERVISOR_SCOPE_KEYS_ENV]: 'dropbox.personal:/Fleet',
    })).toEqual(['/dedicated']);

    // The supervisor's OCR lane already carries the union of the content
    // scopes on the live host, so reading it makes the fence and the lanes the
    // same statement rather than a second one.
    expect(loadDropboxContentScopePathPrefixes({
      [DROPBOX_SUPERVISOR_SCOPE_KEYS_ENV]: 'dropbox.personal:/1 Projects,dropbox.personal:/2 Areas',
    })).toEqual(['/1 projects', '/2 areas']);

    expect(loadDropboxContentScopePathPrefixes({})).toEqual([]);
  });

  test('the path fence matches folders, never mere prefixes of a folder name', () => {
    const prefixes = ['/1 projects'];
    expect(isOutOfDropboxContentScope('/1 Projects/plan.md', prefixes)).toBe(false);
    expect(isOutOfDropboxContentScope('/1 Projects', prefixes)).toBe(false);
    expect(isOutOfDropboxContentScope('/4 Archive/plan.md', prefixes)).toBe(true);
    // "/1 Projects Archive" is a DIFFERENT folder that happens to start with
    // the same characters.
    expect(isOutOfDropboxContentScope('/1 Projects Archive/plan.md', prefixes)).toBe(true);
    // No usable path is not evidence of being outside anything.
    expect(isOutOfDropboxContentScope('plan.md', prefixes)).toBe(false);
    expect(isOutOfDropboxContentScope(undefined, prefixes)).toBe(false);
  });
});

describe('the scope SQL is safe where it is embedded', () => {
  const scoped = dropboxOutOfContentScopeSql(['/1 projects', '/2 areas']);

  test('it binds no parameters, so no call site has to renumber', () => {
    expect(scoped).not.toContain('?');
    expect(dropboxQaVerdictLadderSql(['/1 projects'])).not.toContain('?');
  });

  test('it carries nothing that breaks the Python f-string it rides in', () => {
    for (const sql of [scoped, dropboxQaVerdictLadderSql(['/1 projects'])]) {
      expect([sql.includes('{'), sql.includes('}'), sql.includes('\\'), sql.includes('"""')])
        .toEqual([false, false, false, false]);
    }
  });

  test('it avoids LIKE, whose wildcards a real folder name is allowed to contain', () => {
    // `_` matches any character and `%` matches any run of them, so a LIKE
    // fence would silently approve "/1 Xrojects" for a scope of "/1_rojects".
    expect(scoped).toContain('substr(path_lower, 1, length(');
    expect(scoped).not.toContain('LIKE');
  });

  test('with no scopes it is the constant 0, leaving the ladder as it was', () => {
    expect(dropboxOutOfContentScopeSql([])).toBe('0');
  });
});
