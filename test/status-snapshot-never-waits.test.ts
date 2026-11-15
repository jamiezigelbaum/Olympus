// The dashboard and status never wait on a store read: a snapshot caller gets
// the last complete status at once, with its age, and the recount runs behind
// it. A restarted engine answers its first read from the snapshot it kept on
// disk. Sparta rc.17, 15 Nov 2026: with an import, the judge and a backup
// running, every dashboard poll recounted the expired stores inline (30-69 s).

import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalConnectorStore } from '../src/workers/connector-store/index.ts';
import { defineDropboxFilesCorpus } from '../src/workers/dropbox-files/index.ts';
import { flushMicrotasks } from './helpers/test-clock.ts';
import { STORE_STATUS_REUSE_MS, createSourceIndexStatusHandler } from '../src/workers/source-index/status.ts';

const CORPUS_ID = 'secure_local.dropbox.files';
const SNAPSHOT = { countsMaxAgeMs: 300_000 };

/** Resolves with the value, or 'waited' if it needs more than a few microtask turns (no I/O, no worker). */
async function within<T>(promise: Promise<T>): Promise<T | 'waited'> {
  return await Promise.race([promise, flushMicrotasks().then(() => 'waited' as const)]);
}

describe('status snapshot for the dashboard', () => {
  test('a store whose recount never finishes still answers every dashboard read at once, with its age', async () => {
    const store = new LocalConnectorStore({ dbPath: ':memory:', corpusId: CORPUS_ID, family: 'file', trustDomain: 'secure_local' });
    let now = 1_000_000;
    let reads = 0;
    try {
      const handler = createSourceIndexStatusHandler({ corpusDefinitions: [defineDropboxFilesCorpus()], connectorStores: [store], nowMs: () => now });
      const first = await handler.status({ include_items: false }, SNAPSHOT);
      expect(first.snapshot_age_ms).toBeUndefined();
      // From here the store's recount is stuck (a busy disk, a held lock, a blocked engine).
      store.prepareStatusCounts = () => { reads += 1; return new Promise<void>(() => {}); };
      now += STORE_STATUS_REUSE_MS + 1;
      for (let poll = 0; poll < 5; poll += 1) {
        now += 2_000;
        const shown = await within(handler.status({ include_items: false }, SNAPSHOT));
        expect(shown).not.toBe('waited');
        expect((shown as typeof first).corpora).toEqual(first.corpora);
        expect((shown as typeof first).snapshot_age_ms).toBe(STORE_STATUS_REUSE_MS + 1 + 2_000 * (poll + 1));
      }
      // One recount runs behind the polls, not one per poll.
      expect(reads).toBe(1);
      // A live read (no allowance) still reads now.
      expect((await handler.status({ include_items: false })).snapshot_age_ms).toBeUndefined();
    } finally { store.close(); }
  });

  test('a restarted engine answers its first dashboard read from the snapshot it kept', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'status-snapshot-'));
    const snapshotPath = join(dir, 'source-status-snapshot.json');
    const store = new LocalConnectorStore({ dbPath: ':memory:', corpusId: CORPUS_ID, family: 'file', trustDomain: 'secure_local' });
    let now = 1_000_000;
    try {
      const before = createSourceIndexStatusHandler({ corpusDefinitions: [defineDropboxFilesCorpus()], connectorStores: [store], nowMs: () => now, snapshotPath });
      const first = await before.status({ include_items: false }, SNAPSHOT);
      // The restart: a new handler, and a store too busy to count.
      store.prepareStatusCounts = () => new Promise<void>(() => {});
      now += 30_000;
      const after = createSourceIndexStatusHandler({ corpusDefinitions: [defineDropboxFilesCorpus()], connectorStores: [store], nowMs: () => now, snapshotPath });
      const shown = await within(after.status({ include_items: false }, SNAPSHOT));
      expect(shown).not.toBe('waited');
      expect((shown as typeof first).corpora).toEqual(first.corpora);
      expect((shown as typeof first).snapshot_age_ms).toBe(30_000);
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
