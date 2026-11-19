import { afterEach, expect, spyOn, test } from 'bun:test';
import type { Database } from 'bun:sqlite';
import { LocalConnectorStore } from '../src/workers/connector-store/local-index.ts';
import { startMainThreadSqlSiteCount } from '../src/workers/connector-store/main-thread-sql-trace.ts';
import {
  setReadPoolObserverForTests,
  setReadPoolWorkerFactoryForTests,
  shutdownReadPool,
} from '../src/workers/connector-store/off-thread-reads.ts';
import { createSourceAnswerTrace, runWithSourceAnswerTrace } from '../src/workers/source-index/answer-latency-trace.ts';
import { classifyItemTiers } from '../src/workers/classification/tier-classifier.ts';
import { encodeEmbedding } from '../src/workers/source-index/embeddings.ts';
import { CORPORA, identityOf, JUDGED_PERSONAL_SNIFFER, openTierFixture, tempDir } from './helpers/tier-fixtures.ts';

interface StoreProbe {
  db: Database;
  scheduleVisibilityPublish(): void;
  tierLedgerHiddenItemPks(): { hidden: number[]; held: number[]; metadataLayer: number[] };
  hiddenChildItemPks(): number[];
  tierLedgerHiddenMemo: unknown;
  hiddenChildMemo: unknown;
  vectorScanExcludedItemPks(): { has(itemPk: number): boolean } | undefined;
  vectorScanExclusion: { set: Set<number> } | undefined;
  vectorScanExclusionBuild: Promise<void> | undefined;
  buildVectorScanExclusion(): Promise<void>;
  visibleVectorItemPks(...args: Parameters<LocalConnectorStore['visibleVectorItemPks']>): Set<number>;
}

const probe = (store: LocalConnectorStore) => store as unknown as StoreProbe;
const ids = ['visible', 'changing-parent', 'changing-child', 'held', 'metadata',
  'hidden-parent', 'hidden-child', 'tombstoned-parent', 'tombstoned-child'];
const initiallyVisible = ['changing-child', 'changing-parent', 'visible'];
const initiallyExcluded = ['held', 'metadata', 'hidden-parent', 'hidden-child', 'tombstoned-child'];
const cleanups: Array<() => void> = [];

afterEach(() => {
  setReadPoolObserverForTests();
  setReadPoolWorkerFactoryForTests();
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
  shutdownReadPool();
});

const parentRead = (sql: string) => sql.includes('FROM items WHERE local_item_id IN');

// Keep the real read-pool lease occupied by pausing dispatch of one actual
// statement. Other workers are free to execute the search.
function gatePoolRead(matches = parentRead) {
  let next: { entered(): void; wait: Promise<void> } | undefined;
  setReadPoolWorkerFactoryForTests(url => new Proxy(new Worker(url), {
    get(target, key) {
      if (key === 'postMessage') return (message: { op?: string; sql?: string }) => {
        const gate = next;
        if (gate && message.op === 'read' && message.sql && matches(message.sql)) {
          next = undefined;
          gate.entered();
          void gate.wait.then(() => target.postMessage(message));
        } else target.postMessage(message);
      };
      const field = Reflect.get(target, key);
      return typeof field === 'function' ? field.bind(target) : field;
    },
    set: (target, key, value) => Reflect.set(target, key, value),
  }));
  return () => {
    const entered = Promise.withResolvers<void>();
    const released = Promise.withResolvers<void>();
    next = { entered: entered.resolve, wait: released.promise };
    cleanups.push(released.resolve);
    return { entered: entered.promise, release: released.resolve };
  };
}

async function setup() {
  const tmp = tempDir('olympus-vector-exclusion-never-waits-');
  const fixture = openTierFixture(tmp.dir, { embed: false });
  cleanups.push(() => { fixture.close(); tmp.cleanup(); });
  for (const store of Object.values(fixture.stores)) {
    probe(store!).scheduleVisibilityPublish = () => {};
    probe(store!).db.exec('PRAGMA synchronous=OFF');
  }
  const writer = fixture.stores.internal!;
  const db = probe(writer).db;
  const ledger = fixture.ledger;
  const ledgerDb = (ledger as unknown as { db: Database }).db;
  ledgerDb.exec('PRAGMA synchronous=OFF');
  const decision = classifyItemTiers({ signals: { title: 'Orchard notes' }, text: 'Orchard picnic notes.' },
    { sniffer: JUDGED_PERSONAL_SNIFFER });
  const placement = { copies: [{ corpusId: writer.corpusId, trustDomain: 'internal' as const, layers: 'both' as const }], embedHold: false };
  const text = 'Orchard picnic notes.';
  const [vector] = await fixture.cloud.embed([{ text }]);
  const embedding = encodeEmbedding(vector!, fixture.cloud.dimension);
  db.transaction(() => {
    db.query(`INSERT INTO sync_runs (sync_run_id, corpus_id, connector_id, status, started_at)
      VALUES ('seed', ?, 'fixture', 'completed', '2026-11-01')`).run(writer.corpusId);
    for (const [index, id] of ids.entries()) {
      const pk = index + 1;
      const identity = identityOf(id);
      db.query(`INSERT INTO items (item_pk, provider, family, account_scope, provider_item_id,
        local_item_id, title, mime_type, fetched_at, indexed_at, trust_tier, sync_run_id)
        VALUES (?, ?, 'file', ?, ?, ?, ?, 'text/plain', '2026-11-01', '2026-11-01', 'S3', 'seed')`)
        .run(pk, identity.provider, identity.accountScope, id, identity.localItemId, id);
      db.query(`INSERT INTO chunks (chunk_pk, item_pk, chunk_index, bounded_text, content_hash, embedding_input_hash, indexed_at)
        VALUES (?, ?, 0, ?, 'hash', 'hash', '2026-11-01')`).run(pk, pk, text);
      db.query(`INSERT INTO chunk_embeddings (chunk_pk, model_id, item_pk, content_hash, embedding, embedded_at)
        VALUES (?, ?, ?, 'hash', ?, '2026-11-01')`).run(pk, fixture.cloud.modelId, pk, embedding);
    }
  })();
  ledgerDb.transaction(() => {
    for (const id of ids) ledger.recordRoutedPlacement(identityOf(id), decision, placement);
  })();
  writer.bindTierSet(ledger);
  expect(ledger.copies(identityOf('held'))).toHaveLength(1);
  expect(db.query('SELECT COUNT(DISTINCT item_pk) AS count FROM chunk_embeddings').get()).toEqual({ count: ids.length });
  const copyState = (id: string, state: 'current' | 'staged' | 'superseded') => {
    ledgerDb.query('UPDATE tier_copies SET copy_state = ? WHERE corpus_id = ? AND provider_item_id = ?').run(state, writer.corpusId, id);
  };
  copyState('hidden-parent', 'staged');
  ledgerDb.query('UPDATE tier_copies SET embed_hold = 1 WHERE provider_item_id = ?').run('held');
  ledgerDb.query("UPDATE tier_copies SET layers = 'metadata' WHERE provider_item_id = ?").run('metadata');
  for (const parent of ['changing', 'hidden', 'tombstoned']) {
    db.query('UPDATE items SET parent_local_item_id = ? WHERE provider_item_id = ?')
      .run(identityOf(`${parent}-parent`).localItemId, `${parent}-child`);
  }
  writer.tombstoneCopy(identityOf('tombstoned-parent'), { connectorId: 'fixture-deletion' });

  const reader = () => {
    const store = new LocalConnectorStore({ dbPath: fixture.paths.internal, corpusId: CORPORA.internal,
      family: 'file', trustDomain: 'internal', readOnly: true, tierLedger: ledger });
    store.useChildVisibility({ ledger: () => ledger, stores: () => [store, fixture.stores.secure_local!] });
    cleanups.push(() => store.close());
    return store;
  };
  const search = (store: LocalConnectorStore) => store.vectorSearchLane('Orchard picnic notes.', fixture.cloud, ids.length);
  const pk = (id: string) => (db.query('SELECT item_pk FROM items WHERE provider_item_id = ?').get(id) as { item_pk: number }).item_pk;
  return { copyState, ledger, ledgerDb, writer, sibling: fixture.stores.secure_local!, reader, search, pk };
}

function results(result: Awaited<ReturnType<LocalConnectorStore['vectorSearchLane']>>): string[] {
  expect(result.skippedReason).toBeUndefined();
  return result.rows.map(({ sourceItem }) => sourceItem.providerItemId).sort();
}

function startRefresh(store: StoreProbe): Promise<void> {
  expect(store.vectorScanExcludedItemPks()).toBeUndefined();
  expect(store.vectorScanExclusionBuild).toBeDefined();
  return store.vectorScanExclusionBuild!;
}

test('a search with warm visibility memos finishes while the refresh pool read is gated', async () => {
  const pause = gatePoolRead();
  const h = await setup();
  const front = h.reader();
  const lane = probe(front);
  lane.tierLedgerHiddenItemPks();
  lane.hiddenChildItemPks();
  const gate = pause();
  const sql = startMainThreadSqlSiteCount(8);
  // Account for keyed parent SQL from the live winner check, which must still
  // run. Every other statement is attributed to its actual prefilter site.
  const liveSql = new Map<string, number>();
  const visible = lane.visibleVectorItemPks.bind(lane);
  const live = spyOn(lane, 'visibleVectorItemPks').mockImplementation((...args) => {
    const before = new Map(sql.sites().map(({ site, statements }) => [site, statements]));
    const pks = visible(...args);
    for (const { site, statements } of sql.sites()) {
      const delta = statements - (before.get(site) ?? 0);
      if (delta > 0) liveSql.set(site, (liveSql.get(site) ?? 0) + delta);
    }
    return pks;
  });
  try {
    const [result] = await Promise.all([h.search(front), gate.entered]);
    expect(results(result)).toEqual(initiallyVisible);
    expect(lane.vectorScanExclusionBuild).toBeDefined();
    expect(lane.vectorScanExclusion).toBeUndefined();
    gate.release();
    await lane.vectorScanExclusionBuild;
    expect(sql.sites().filter(({ site, statements }) =>
      /hiddenChildSteps|parentStandings|tierLedgerHiddenSteps/.test(site) && statements > (liveSql.get(site) ?? 0))).toEqual([]);
  } finally {
    live.mockRestore();
    sql.stop();
    gate.release();
    await lane.vectorScanExclusionBuild;
  }
});

test('the next search uses the completed set and agrees with the synchronous builders', async () => {
  const h = await setup();
  const front = h.reader();
  const lane = probe(front);
  const reference = h.reader();
  const ref = probe(reference);
  const { hidden, held, metadataLayer } = ref.tierLedgerHiddenItemPks();
  const expected = new Set([...hidden, ...held, ...metadataLayer, ...ref.hiddenChildItemPks()]);
  expect(expected).toEqual(new Set(initiallyExcluded.map(h.pk)));
  ref.vectorScanExcludedItemPks = () => expected;

  await startRefresh(lane);
  expect(lane.vectorScanExclusion?.set).toEqual(expected);
  const exclusion = spyOn(lane, 'vectorScanExcludedItemPks');
  expect(await h.search(front)).toEqual(await h.search(reference));
  const used = exclusion.mock.results[0]?.value as ReturnType<StoreProbe['vectorScanExcludedItemPks']>;
  expect(used?.has(h.pk('hidden-child'))).toBe(true);
  expect(lane.vectorScanExclusionBuild).toBeUndefined();
  exclusion.mockRestore();
});

test('a traced Ask never inherits pooled parent state across a writable ledger hold', async () => {
  const pause = gatePoolRead();
  const h = await setup();
  const lane = probe(h.writer);
  const gate = pause();
  await runWithSourceAnswerTrace(createSourceAnswerTrace(), async () => {
    const refresh = startRefresh(lane);
    await gate.entered;
    const heldMarker = await h.ledger.holdingWrites(async () => {
      h.ledger.putWriteIntent({ kind: 'deletion', identity: identityOf('changing-parent'), connectorId: 'fixture' });
      gate.release();
      await refresh;
      expect(lane.vectorScanExclusion).toBeUndefined();
      expect(results(await h.search(h.writer))).toEqual(['visible']);
      await lane.vectorScanExclusionBuild;
      expect(lane.vectorScanExclusion).toBeUndefined();
      return h.ledger.changeMarker();
    });
    expect(h.ledger.changeMarker()).toBe(heldMarker);
    expect(results(await h.search(h.writer))).toEqual(['visible']);
    await lane.vectorScanExclusionBuild;
  });
});

test('a release during an in-flight refresh reaches the very next search', async () => {
  const pause = gatePoolRead();
  const h = await setup();
  const front = h.reader();
  const lane = probe(front);
  await startRefresh(lane);
  expect(lane.vectorScanExclusion?.set.has(h.pk('hidden-child'))).toBe(true);

  h.copyState('hidden-parent', 'superseded');
  const gate = pause();
  const refresh = startRefresh(lane);
  await gate.entered;
  h.copyState('hidden-parent', 'current');
  const released = ['changing-child', 'changing-parent', 'hidden-child', 'hidden-parent', 'visible'];
  try {
    expect(results(await h.search(front))).toEqual(released);
    expect(lane.vectorScanExclusionBuild).toBe(refresh);
  } finally {
    gate.release();
    await refresh;
  }
  expect(lane.vectorScanExclusion).toBeUndefined();
  await startRefresh(lane);
  expect(lane.vectorScanExclusion?.set.has(h.pk('hidden-child'))).toBe(false);
  expect(results(await h.search(front))).toEqual(released);
});

test('one failed pooled parent read discards the entire refresh and leaves live memos alone', async () => {
  const h = await setup();
  const front = h.reader();
  const lane = probe(front);
  lane.tierLedgerHiddenItemPks();
  lane.hiddenChildItemPks();
  const base = lane.tierLedgerHiddenMemo;
  const children = lane.hiddenChildMemo;
  let failed = false;
  setReadPoolObserverForTests((_path, read, observed) => {
    if (failed || observed?.lane !== 'background' || !parentRead(read.sql)) return;
    failed = true;
    read.sql = 'SELECT * FROM vector_exclusion_fixture_missing_table';
    read.params = [];
  }, { snapshots: true });
  await startRefresh(lane);
  setReadPoolObserverForTests();
  expect(failed).toBe(true);
  expect(lane.vectorScanExclusion).toBeUndefined();
  expect(lane.tierLedgerHiddenMemo).toBe(base);
  expect(lane.hiddenChildMemo).toBe(children);
  expect(results(await h.search(front))).toEqual(initiallyVisible);
  await lane.vectorScanExclusionBuild;
  expect(lane.vectorScanExclusion?.set.has(h.pk('changing-child'))).toBe(false);
  expect(results(await h.search(front))).toEqual(initiallyVisible);
});

test('a sibling store release invalidates a completed set already borrowed by a scan', async () => {
  const pause = gatePoolRead(sql => sql.includes('SELECT status, cursor, audit_receipt_sha256'));
  const h = await setup();
  const parent = identityOf('hidden-parent');
  const db = probe(h.sibling).db;
  db.query(`INSERT INTO sync_runs (sync_run_id, corpus_id, connector_id, status, started_at)
    VALUES ('seed', ?, 'fixture', 'completed', '2026-11-01')`).run(h.sibling.corpusId);
  db.query(`INSERT INTO items (provider, family, account_scope, provider_item_id, local_item_id,
    mime_type, fetched_at, indexed_at, trust_tier, sync_run_id, tombstoned)
    VALUES (?, 'file', ?, ?, ?, 'text/plain', '2026-11-01', '2026-11-01', 'S4', 'seed', 1)`)
    .run(parent.provider, parent.accountScope, parent.providerItemId, parent.localItemId);
  h.ledgerDb.query(`UPDATE tier_copies SET copy_state = 'current', corpus_id = ?, trust_domain = 'secure_local'
    WHERE provider_item_id = ?`).run(h.sibling.corpusId, parent.providerItemId);
  const front = h.reader();
  const lane = probe(front);
  await startRefresh(lane);
  expect(lane.vectorScanExclusion?.set.has(h.pk('hidden-child'))).toBe(true);

  const gate = pause();
  const search = h.search(front);
  await gate.entered;
  db.query('UPDATE items SET tombstoned = 0 WHERE local_item_id = ?').run(parent.localItemId);
  gate.release();
  const released = ['changing-child', 'changing-parent', 'hidden-child', 'visible'];
  expect(results(await search)).toEqual(released);
  expect(results(await h.search(front))).toEqual(released);
  await lane.vectorScanExclusionBuild;
});

test('concurrent searches share one refresh and all finish with it still gated', async () => {
  const pause = gatePoolRead();
  const h = await setup();
  const front = h.reader();
  const lane = probe(front);
  const builds = spyOn(lane, 'buildVectorScanExclusion');
  const gate = pause();
  try {
    const [searches] = await Promise.all([Promise.all(Array.from({ length: 6 }, () => h.search(front))), gate.entered]);
    for (const result of searches) expect(results(result)).toEqual(initiallyVisible);
    expect(builds).toHaveBeenCalledTimes(1);
    expect(lane.vectorScanExclusionBuild).toBeDefined();
  } finally {
    gate.release();
    await lane.vectorScanExclusionBuild;
    builds.mockRestore();
  }
});

test('successive writes invalidate successive refreshes without holding searches', async () => {
  const pause = gatePoolRead();
  const h = await setup();
  const front = h.reader();
  const lane = probe(front);
  for (const state of ['staged', 'current', 'staged', 'current'] as const) {
    const gate = pause();
    const refresh = startRefresh(lane);
    await gate.entered;
    h.copyState('changing-parent', state);
    try {
      const result = await h.search(front);
      expect(results(result)).toEqual(state === 'current' ? initiallyVisible : ['visible']);
      expect(lane.vectorScanExclusionBuild).toBe(refresh);
    } finally {
      gate.release();
      await refresh;
    }
    expect(lane.vectorScanExclusion).toBeUndefined();
  }
});
