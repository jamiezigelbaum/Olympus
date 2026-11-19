// A store's status counts read on the second thread (#870) must be the same
// counts status() reads on this one, and must not be read on this thread.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Database } from 'bun:sqlite';
import { afterEach, describe, expect, test } from 'bun:test';
import type { RawItem, SourceConnector, SourceConnectorListPage } from '../src/core/contracts.ts';
import { LocalConnectorStore } from '../src/workers/connector-store/index.ts';
import { moveTieredItem } from '../src/workers/connector-store/tier-move.ts';
import { FIXTURE_PLACEMENT, fixtureConnector, identityOf, openTierFixture, tempDir } from './helpers/tier-fixtures.ts';
import { setStatusPageKeysForTests } from '../src/workers/connector-store/local-index.ts';

const ACCOUNT = 'personal';
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function connector(mail: ReadonlyArray<{ id: string; authoredAt: string; text?: string }>): SourceConnector {
  const items = mail.map((entry): RawItem => ({
    identity: {
      family: 'email', provider: 'gmail', accountScope: ACCOUNT,
      providerItemId: entry.id, localItemId: `${ACCOUNT}:${entry.id}`, sourceVersion: '1',
    },
    mimeType: 'message/rfc822',
    content: entry.text === undefined ? { kind: 'metadata_only' } : { kind: 'text', text: entry.text },
    metadata: Object.freeze({
      title: `Subject ${entry.id}`, subject: `Subject ${entry.id}`, from: 'sender@example.com',
      authoredAt: entry.authoredAt, locatorUri: `https://mail.google.com/mail/u/0/#all/${entry.id}`,
    }),
    fetchedAt: '2026-10-16T10:00:00.000Z',
  }));
  const byId = new Map(items.map((item) => [item.identity.localItemId, item]));
  return {
    id: 'status-off-thread-fixture',
    family: 'email',
    async authenticate(): Promise<void> {},
    listItems(): AsyncIterable<SourceConnectorListPage> {
      return (async function* (): AsyncGenerator<SourceConnectorListPage> {
        yield { items, done: true };
      })();
    },
    async fetchItem(localItemId: string): Promise<RawItem> {
      const item = byId.get(localItemId);
      if (!item) throw new Error(`missing fixture ${localItemId}`);
      return item;
    },
    classificationSignals() {
      return {};
    },
  };
}

const MAIL = [
  { id: 'a', authoredAt: '2026-06-01T09:00:00Z', text: 'Lunch on Friday works for me.' },
  { id: 'b', authoredAt: '2026-04-06T14:40:48Z' },
  { id: 'c', authoredAt: '2026-03-01T08:00:00Z', text: 'An older note whose body was stored in full.' },
];

function fileStore(): LocalConnectorStore {
  const dir = mkdtempSync(join(tmpdir(), 'olympus-status-off-thread-'));
  roots.push(dir);
  return new LocalConnectorStore({ dbPath: join(dir, 'mail.sqlite'), corpusId: 'internal.email', family: 'email', trustDomain: 'internal' });
}

/** Counts this thread's queries whose SQL contains `marker`. */
function countMainThreadQueries(store: LocalConnectorStore, marker: string): () => number {
  const db = (store as unknown as { db: { query: (sql: string) => unknown } }).db;
  const original = db.query.bind(db);
  let seen = 0;
  db.query = (sql: string) => {
    if (sql.includes(marker)) seen += 1;
    return original(sql);
  };
  return () => seen;
}

describe('connector store status off the worker thread', () => {
  test('reads the same counts as status(), and none of them on this thread', async () => {
    const store = fileStore();
    try {
      await store.syncFromConnector(connector(MAIL), { fetchContent: true });
      for (const scope of [undefined, { contentNotBefore: '2026-04-13T00:00:00Z' }]) {
        const here = store.status(scope);
        const seen = countMainThreadQueries(store, 'WITH flags AS MATERIALIZED');
        const there = await store.statusOffThread(scope);
        expect(seen()).toBe(0);
        expect(there).toEqual(here);
      }
      // Written expectations, independent of either path: three live items, two with text.
      const counts = (await store.statusOffThread()).counts;
      expect(counts.items).toBe(3);
      expect(counts.itemsWithText).toBe(2);
    } finally {
      store.close();
    }
  });

  // Status walks the items a page of keys at a time, each page its own read:
  // the pages add up to the counts of one pass, here and on the read worker.
  test('counts the same a key at a time as in one page', async () => {
    const store = fileStore();
    try {
      await store.syncFromConnector(connector(MAIL), { fetchContent: true });
      for (const scope of [undefined, { contentNotBefore: '2026-04-13T00:00:00Z' }]) {
        const whole = store.status(scope);
        setStatusPageKeysForTests(1);
        try {
          expect(store.status(scope)).toEqual(whole);
          expect(await store.statusOffThread(scope)).toEqual(whole);
          // The status estimates walk the same pages on the read worker.
          expect(await store.authorCoverageOffThread()).toEqual(store.authorCoverage());
          expect(await store.pdfExtractionBacklogOffThread()).toEqual(store.pdfExtractionBacklog());
          expect(await store.embeddingBacklogEstimateOffThread('some-model', undefined, scope)).toEqual(store.embeddingBacklogEstimate('some-model', undefined, scope));
        } finally { setStatusPageKeysForTests(); }
      }
    } finally {
      store.close();
    }
  });

  test('sees what this thread has written since', async () => {
    const store = fileStore();
    try {
      await store.syncFromConnector(connector(MAIL.slice(0, 1)), { fetchContent: true });
      expect((await store.statusOffThread()).counts.items).toBe(1);
      await store.syncFromConnector(connector(MAIL), { fetchContent: true });
      expect((await store.statusOffThread()).counts.items).toBe(3);
    } finally {
      store.close();
    }
  });

  test('an in-memory store is counted on this thread, as status() does', async () => {
    const store = new LocalConnectorStore({ dbPath: ':memory:', corpusId: 'internal.email', family: 'email', trustDomain: 'internal' });
    try {
      await store.syncFromConnector(connector(MAIL), { fetchContent: true });
      expect(await store.statusOffThread()).toEqual(store.status());
    } finally {
      store.close();
    }
  });
});

describe('off-thread snapshot', () => {
  test('every read in one snapshot sees the same state, whatever is written meanwhile', async () => {
    const store = fileStore();
    try {
      await store.syncFromConnector(connector(MAIL.slice(0, 1)), { fetchContent: true });
      const { withOffThreadSnapshot } = await import('../src/workers/connector-store/off-thread-reads.ts');
      const count = { sql: 'SELECT COUNT(*) AS n FROM items WHERE tombstoned = 0', params: [], mode: 'get' as const };
      const [before, after] = await withOffThreadSnapshot(store.dbPath, async (read) => {
        const first = (await read(count)) as { n: number };
        await store.syncFromConnector(connector(MAIL), { fetchContent: true });
        const second = (await read(count)) as { n: number };
        return [first.n, second.n];
      });
      expect(before).toBe(1);
      expect(after).toBe(1);
      expect((await store.statusOffThread()).counts.items).toBe(3);
    } finally {
      store.close();
    }
  });
});

describe('status handler', () => {
  test('callers that find the counts expired together share one off-thread read', async () => {
    const { createSourceIndexStatusHandler } = await import('../src/workers/source-index/status.ts');
    const store = fileStore();
    try {
      await store.syncFromConnector(connector(MAIL), { fetchContent: true });
      let reads = 0;
      const read = store.statusOffThread.bind(store);
      store.statusOffThread = ((...args: Parameters<typeof store.statusOffThread>) => {
        reads += 1;
        return read(...args);
      }) as typeof store.statusOffThread;
      const handler = createSourceIndexStatusHandler({
        corpusDefinitions: [{ corpusId: 'internal.email', family: 'email', trustDomain: 'internal' } as never],
        connectorStores: [store],
      });
      const [a, b] = await Promise.all([
        handler.status({}, { countsMaxAgeMs: 60_000 }),
        handler.status({}, { countsMaxAgeMs: 60_000 }),
      ]);
      expect(reads).toBe(1);
      expect(b.corpora[0]).toEqual(a.corpora[0]);
    } finally {
      store.close();
    }
  });
});

describe('store visibility marker', () => {
  async function open() {
    const tmp = tempDir();
    roots.push(tmp.dir);
    const fixture = openTierFixture(tmp.dir, { embed: false });
    await fixture.set.sync(fixtureConnector(() => [{ id: 'parent', name: 'Parent', text: 'Synthetic parent body.' }]),
      { fetchContent: true, placement: FIXTURE_PLACEMENT });
    return fixture;
  }

  test('a tier move leaves a third store unchanged, and unchanged feed cursors survive reopening', async () => {
    const fixture = await open();
    try {
      const store = fixture.stores.internal!;
      const quiet = fileStore();
      const reopenOptions = { dbPath: quiet.dbPath, corpusId: quiet.corpusId, family: 'email' as const,
        trustDomain: 'internal' as const, tierLedger: fixture.ledger };
      quiet.close();
      const idle = new LocalConnectorStore(reopenOptions);
      try {
        await idle.syncFromConnector(connector(MAIL), { fetchContent: true });
        const before = store.visibilityMarker();
        const unchanged = idle.visibilityMarker();
        const db = (fixture.ledger as unknown as { db: Database }).db;
        db.query('UPDATE tier_copies SET embed_hold = embed_hold WHERE corpus_id = ?').run(store.corpusId);
        expect(store.visibilityMarker()).toBe(before);
        await moveTieredItem({ set: fixture.set, identity: identityOf('parent'), target: { metadataTier: 'secure', contentTier: 'secure' } });
        expect(store.visibilityMarker()).not.toBe(before);
        expect(idle.visibilityMarker()).toBe(unchanged);
      } finally { idle.close(); }
      const reopened = new LocalConnectorStore(reopenOptions);
      const baseline = reopened.visibilityMarker();
      reopened.close();
      const { TierLedger } = await import('../src/workers/classification/tier-ledger.ts');
      const ledger = new TierLedger({ dbPath: fixture.ledger.dbPath });
      const again = new LocalConnectorStore({ ...reopenOptions, tierLedger: ledger });
      try { expect(again.visibilityMarker()).toBe(baseline); } finally { again.close(); ledger.close(); }
    } finally { fixture.close(); }
  });

  test('an ancestor in another store wakes the child store on ledger and parent-row changes', async () => {
    const fixture = await open();
    try {
      const parent = fixture.stores.internal!;
      const child = fixture.stores.secure_local!;
      const identity = identityOf('parent#child:one');
      const copy = parent.exportItemCopy(identityOf('parent'))!;
      child.importItemCopy({ ...copy, identity, columns: { ...copy.columns,
        provider_item_id: identity.providerItemId, local_item_id: identity.localItemId,
        parent_local_item_id: identityOf('parent').localItemId,
      } }, { trustTier: 'S4', syncConnectorId: 'marker-test' });
      expect((await child.statusOffThread()).counts.items).toBe(1);
      const before = child.visibilityMarker();
      const ledgerDb = (fixture.ledger as unknown as { db: Database }).db;
      ledgerDb.query("UPDATE tier_copies SET copy_state = 'superseded' WHERE provider_item_id = ?").run('parent');
      expect(child.visibilityMarker()).not.toBe(before);
      expect((await child.statusOffThread()).counts.items).toBe(0);
      ledgerDb.query("UPDATE tier_copies SET copy_state = 'current' WHERE provider_item_id = ?").run('parent');
      expect((await child.statusOffThread()).counts.items).toBe(1);
      const restored = child.visibilityMarker();
      (parent as unknown as { db: Database }).db.query('DELETE FROM items WHERE provider_item_id = ?').run('parent');
      expect(child.visibilityMarker()).not.toBe(restored);
      expect((await child.statusOffThread()).counts.items).toBe(0);
    } finally { fixture.close(); }
  });

  test('a ledger retention gap wakes a store even if the only retained identity is unrelated', async () => {
    const fixture = await open();
    try {
      const store = fixture.stores.internal!;
      const before = store.visibilityMarker();
      const db = (fixture.ledger as unknown as { db: Database }).db;
      const note = db.query("INSERT INTO tier_visibility_changes (provider, account_scope, conversation_key, provider_item_id) VALUES ('fixture', 'fixture', '', 'unrelated')");
      note.run();
      db.exec('DELETE FROM tier_visibility_changes');
      note.run();
      const afterGap = store.visibilityMarker();
      expect(afterGap).not.toBe(before);
      note.run();
      db.exec('DELETE FROM tier_visibility_changes WHERE seq = (SELECT MAX(seq) FROM tier_visibility_changes)');
      expect(store.visibilityMarker()).not.toBe(afterGap);
    } finally { fixture.close(); }
  });

  test('a ledger change during count preparation remains due at the next recount', async () => {
    const fixture = await open();
    try {
      const { createSourceIndexStatusHandler, STORE_STATUS_REUSE_MS } = await import('../src/workers/source-index/status.ts');
      const store = fixture.stores.internal!;
      let now = 1_000_000;
      const handler = createSourceIndexStatusHandler({
        corpusDefinitions: [{ corpusId: store.corpusId, family: 'file', trustDomain: 'internal' } as never],
        connectorStores: [store], nowMs: () => now, snapshotRole: 'writer',
      });
      const prepare = store.prepareStatusCounts.bind(store);
      store.prepareStatusCounts = async scope => {
        await prepare(scope);
        fixture.ledger.putWriteIntent({ identity: identityOf('parent'), kind: 'deletion', connectorId: 'marker-test' });
        store.prepareStatusCounts = prepare;
      };
      const refresh = () => handler.refreshSnapshot!({}, { countsMaxAgeMs: STORE_STATUS_REUSE_MS, reuseCounts: true });
      expect((await refresh()).corpora[0]).toMatchObject({ counts: { indexed_items: 1 } });
      now += STORE_STATUS_REUSE_MS - 1;
      expect((await refresh()).corpora[0]).toMatchObject({ counts: { indexed_items: 0 } });
    } finally { fixture.close(); }
  });
});
