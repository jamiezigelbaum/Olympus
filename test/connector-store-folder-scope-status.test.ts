// Folder scopes in a store's status: the counts a scope picks out, worked out
// in one pass over the items, and the locator path tests that match a folder
// whatever its letter case (ASCII), as they always have.
//
// Expected numbers come from the fixture's own paths, never from the store.

import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalConnectorStore } from '../src/workers/connector-store/index.ts';
import { fixtureConnector, type FixtureSpec } from './helpers/tier-fixtures.ts';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

// fixtureItem files each spec at /Files/<name>.
const SPECS: FixtureSpec[] = [
  { id: 'a', name: 'Work/plan.pdf' },
  { id: 'b', name: 'work/notes.pdf' },
  { id: 'c', name: 'WORK/sub/deep.pdf' },
  { id: 'd', name: 'Workshop/flyer.pdf' },
  { id: 'e', name: 'Archive/old.pdf' },
  { id: 'f', name: 'archive/older.pdf' },
];

test('a folder scope counts its files in any letter case, and only that folder', async () => {
  const root = mkdtempSync(join(tmpdir(), 'olympus-folder-scope-'));
  roots.push(root);
  const store = new LocalConnectorStore({
    dbPath: join(root, 'store.sqlite'),
    corpusId: 'internal.fixture.files',
    family: 'file',
    trustDomain: 'internal',
  });
  try {
    await store.syncFromConnector(fixtureConnector(() => SPECS), { fetchContent: false });

    const status = store.status({
      itemFilters: { locatorPathScopes: ['/files/work', '/FILES/ARCHIVE'] },
      contentAllowed: true,
      contentFilters: { locatorPathScopes: ['/files/WORK'], locatorPathExcludedScopes: ['/Files/work/sub'] },
    });
    // In the item scope: plan, notes, deep (Work in three cases), old, older. Not Workshop.
    expect(status.counts.items).toBe(5);
    expect(status.counts.files).toBe(5);
    expect(status.counts.folders).toBe(0);
    // Read in full: plan and notes; deep is under the excluded sub folder.
    expect(status.counts.fullIngestionFiles).toBe(2);
    expect(status.counts.scopeMetadataOnlyFiles).toBe(3);
  } finally {
    store.close();
  }
});
