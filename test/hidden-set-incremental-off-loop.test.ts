import { afterEach, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { classifyItemTiers } from '../src/workers/classification/tier-classifier.ts';
import { tierLedgerIdentityKey } from '../src/workers/classification/tier-ledger.ts';
import { LocalConnectorStore } from '../src/workers/connector-store/local-index.ts';
import { largeTableScans, LOOP_SQL_LARGE_TABLES, startMainThreadSqlSiteCount } from '../src/workers/connector-store/main-thread-sql-trace.ts';
import { setReadPoolObserverForTests, shutdownReadPool, type StoreRead } from '../src/workers/connector-store/off-thread-reads.ts';
import { moveTieredItem } from '../src/workers/connector-store/tier-move.ts';
import { waitFor } from './helpers/test-clock.ts';
import { CORPORA, FIXTURE_PLACEMENT, JUDGED_PERSONAL_SNIFFER, fixtureConnector, identityOf, openTierFixture, tempDir, type FixtureSpec } from './helpers/tier-fixtures.ts';

type HiddenSet = { hidden: number[]; held: number[]; heldForJudgment: number[]; metadataLayer: number[]; metadataLayerContentUnread: number[]; moving: number };
interface Probe {
  db: Database;
  tierLedgerHiddenMemo: {
    ledgerCursor: number;
    storeCursor: number;
    members: ReadonlyMap<string, { pks: number[]; flags: { hidden: boolean } }>;
  } | undefined;
  scheduleVisibilityPublish(): void;
  tierHiddenItemPksInTurns(): Promise<HiddenSet>;
  hiddenChildItemPksInTurns(): Promise<number[]>;
  tierHiddenItemPks(): HiddenSet;
  publishVisibility(): Promise<void>;
  copyServable(identity: ReturnType<typeof identityOf>): boolean;
}
const probe = (store: LocalConnectorStore) => store as unknown as Probe;
const sorted = (set: HiddenSet) => Object.fromEntries(Object.entries(set).map(([key, value]) =>
  [key, Array.isArray(value) ? [...value].sort((a, b) => a - b) : value]));
const cleanups: Array<() => void> = [];
const initialSwitch = process.env.OLYMPUS_HIDDEN_SET_INCREMENTAL_OFF_LOOP;
afterEach(() => {
  setReadPoolObserverForTests();
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
  shutdownReadPool();
  if (initialSwitch === undefined) delete process.env.OLYMPUS_HIDDEN_SET_INCREMENTAL_OFF_LOOP;
  else process.env.OLYMPUS_HIDDEN_SET_INCREMENTAL_OFF_LOOP = initialSwitch;
});

function copyFixtureRows(db: Database, table: 'items' | 'tier_items' | 'tier_copies', ids: string[], overrides: Record<string, string> = {}) {
  const columns = db.query<{ name: string }, []>(`PRAGMA table_info(${table})`).all()
    .map(row => row.name).filter(name => name !== 'item_pk');
  const changed: Record<string, string> = { provider_item_id: "json_extract(n.value, '$[0]')", ...overrides };
  db.query(`INSERT INTO ${table} (${columns.join(', ')})
    SELECT ${columns.map(name => changed[name] ?? `t.${name}`).join(', ')}
    FROM ${table} t CROSS JOIN json_each(?) n WHERE t.provider_item_id = 'row-0' ORDER BY n.key`)
    .run(JSON.stringify(ids.map(id => [id, identityOf(id).localItemId])));
}

function insertItemRows(db: Database, ids: string[]) {
  copyFixtureRows(db, 'items', ids, { local_item_id: "json_extract(n.value, '$[1]')", title: "json_extract(n.value, '$[0]')" });
}

function openFixture() {
  delete process.env.OLYMPUS_HIDDEN_SET_INCREMENTAL_OFF_LOOP;
  const tmp = tempDir('olympus-incremental-off-loop-');
  const f = openTierFixture(tmp.dir, { embed: false });
  cleanups.push(() => { f.close(); tmp.cleanup(); });
  for (const store of Object.values(f.stores)) probe(store!).scheduleVisibilityPublish = () => {};
  const db = probe(f.stores.internal!).db;
  const ledgerDb = (f.ledger as unknown as { db: Database }).db;
  const reader = (enabled: boolean, domain: 'internal' | 'secure_local' = 'internal') => {
    process.env.OLYMPUS_HIDDEN_SET_INCREMENTAL_OFF_LOOP = enabled ? '1' : '0';
    const store = new LocalConnectorStore({ dbPath: f.paths[domain], corpusId: CORPORA[domain], family: 'file', trustDomain: domain, tierLedger: f.ledger });
    // The switch is read once when opening. Changing env for the next reader
    // must not change the reader already open.
    delete process.env.OLYMPUS_HIDDEN_SET_INCREMENTAL_OFF_LOOP;
    probe(store).scheduleVisibilityPublish = () => {};
    store.useChildVisibility({ ledger: () => f.ledger, stores: () => [store, ...Object.values(f.stores).filter((s): s is LocalConnectorStore => s !== undefined && s.corpusId !== store.corpusId)] });
    cleanups.push(() => store.close());
    return probe(store);
  };
  const pk = (id: string, domain: 'internal' | 'secure_local' = 'internal') =>
    (probe(f.stores[domain]!).db.query('SELECT item_pk FROM items WHERE provider_item_id = ?').get(id) as { item_pk: number }).item_pk;
  return { f, db, ledgerDb, reader, pk };
}

async function setup(count = 260) {
  const fixture = openFixture();
  const { f, db, ledgerDb } = fixture;
  const seedCount = Math.min(count, 16);
  const specs: FixtureSpec[] = Array.from({ length: seedCount }, (_, i) => ({ id: `row-${i}`, name: `Note ${i}`, text: `Orchard picnic note ${i}.` }));
  specs.push(...['private', 'secret', 'held', 'staged', 'superseded', 'metadata', 'metadata-unread', 'parent', 'child']
    .map(id => ({ id, name: id, text: `Orchard picnic ${id}.` })));
  await f.set.sync(fixtureConnector(() => specs), { fetchContent: true, placement: FIXTURE_PLACEMENT });
  // Expand an API-created item row in one insert, as the large visibility
  // fixtures do. These extra rows exercise identity/feed paging; the API-
  // created rows above supply the content used in actual tier moves.
  const decision = classifyItemTiers({ signals: { title: 'Note 0' }, text: 'Orchard picnic note 0.' },
    { sniffer: JUDGED_PERSONAL_SNIFFER });
  if (count > seedCount) db.transaction(() => {
    insertItemRows(db, Array.from({ length: count - seedCount }, (_, i) => `row-${seedCount + i}`));
    ledgerDb.transaction(() => {
      for (let i = seedCount; i < count; i++) f.ledger.recordRoutedPlacement(identityOf(`row-${i}`), decision, f.set.placementFor(decision));
    })();
  })();
  const move = (id: string, metadataTier: 'private' | 'secure' | 'secrets', contentTier = metadataTier) =>
    moveTieredItem({ set: f.set, identity: identityOf(id), target: { metadataTier, contentTier } });
  await move('private', 'secure');
  await move('secret', 'secrets');
  await move('held', 'secure');
  await move('metadata', 'private', 'secure');
  const pending = { ...classifyItemTiers({ signals: {}, text: 'Orchard picnic.' }),
    metadataTier: 'secure' as const, contentTier: 'secure' as const, state: 'pending' as const,
    contentRead: true, metadataPending: false, contentPending: true };
  f.ledger.recordRoutedPlacement(identityOf('held'), pending, f.set.placementFor(pending));
  ledgerDb.query("UPDATE tier_copies SET copy_state = 'staged' WHERE provider_item_id = ?").run('staged');
  ledgerDb.query("UPDATE tier_copies SET copy_state = 'superseded' WHERE provider_item_id = ?").run('superseded');
  ledgerDb.query("UPDATE tier_copies SET layers = 'metadata' WHERE provider_item_id = ?").run('metadata-unread');
  db.query('UPDATE items SET parent_local_item_id = ? WHERE provider_item_id = ?').run(identityOf('parent').localItemId, 'child');
  f.stores.internal!.tombstoneCopy(identityOf('parent'), { connectorId: 'fixture-deletion' });

  const change = async (round: number) => {
    for (let i = 0; i < Math.min(count, 12); i++) await move(`row-${i}`, round === 1 ? 'secure' : 'private');
    // Title edits leave visibility unchanged.
    db.transaction(() => {
      db.query('UPDATE items SET title = title || ? WHERE provider_item_id LIKE ?').run(` r${round}`, 'row-%');
      db.query('UPDATE items SET title = title || ? WHERE provider_item_id LIKE ?').run(' updated', 'row-%');
    })();
    ledgerDb.transaction(() => {
      ledgerDb.query('UPDATE tier_copies SET embed_hold = ? WHERE provider_item_id LIKE ?').run(round === 1 ? 1 : 0, 'row-%');
    })();
    const additions = Array.from({ length: 5 }, (_, i) => ({ id: `new-${round}-${i}`, name: 'New note', text: 'Orchard new picnic.' }));
    await f.set.sync(fixtureConnector(() => additions), { fetchContent: true, placement: FIXTURE_PLACEMENT });
    f.stores.internal!.tombstoneCopy(identityOf(`row-${Math.min(count - 1, 20 + round)}`), { connectorId: 'fixture-deletion' });
    ledgerDb.query('UPDATE tier_copies SET copy_state = ? WHERE provider_item_id = ?').run(round === 1 ? 'current' : 'staged', 'staged');
  };
  return { ...fixture, move, change };
}

function observePool() {
  const reads: Array<{ path: string; read: StoreRead }> = [];
  setReadPoolObserverForTests((path, read) => reads.push({ path, read }), { snapshots: true });
  return reads;
}
const isLedgerFlagBatch = (sql: string) => sql.includes('FROM keys k CROSS JOIN tier_copies');
const isIncremental = (sql: string) => isLedgerFlagBatch(sql) || /WHERE seq >|CROSS JOIN items i/.test(sql);
const isStoreFeedPage = (sql: string) => sql.includes('FROM main.item_visibility_feed WHERE seq >');

function storeFeedAfter(db: Database, cursor: number) {
  return db.query<{ seq: number; provider_item_id: string }, [number]>(
    'SELECT seq, provider_item_id FROM main.item_visibility_feed WHERE seq > ? ORDER BY seq',
  ).all(cursor);
}

function issuedStoreCursor(db: Database) {
  return db.query<{ seq: number }, []>(
    "SELECT seq FROM main.sqlite_sequence WHERE name = 'item_visibility_feed'",
  ).get()!.seq;
}

function warmStoreOnlyMemos(count: number, truncate = false) {
  const h = openFixture();
  const ids = Array.from({ length: count }, (_, i) => `store-only-${i + 1}`);
  const identities = ids.map(id => identityOf(id));
  const decision = classifyItemTiers({ signals: { title: 'Orchard note' }, text: 'An orchard note.' },
    { sniffer: JUDGED_PERSONAL_SNIFFER });
  const template = identityOf('row-0');
  // This fixture needs only an active template row and its routed ledger rows.
  h.db.query(`INSERT INTO sync_runs (sync_run_id, corpus_id, connector_id, status, started_at, completed_at)
    VALUES ('store-only-fixture', ?, 'store-only-fixture', 'completed', '2026-01-01', '2026-01-01')`)
    .run(CORPORA.internal);
  h.db.query(`INSERT INTO items (provider, family, account_scope, provider_item_id, local_item_id,
    mime_type, fetched_at, indexed_at, trust_tier, sync_run_id)
    VALUES (?, 'file', ?, ?, ?, 'text/plain', '2026-01-01', '2026-01-01', 'S3', 'store-only-fixture')`)
    .run(template.provider, template.accountScope, template.providerItemId, template.localItemId);
  h.ledgerDb.transaction(() => {
    h.f.ledger.recordRoutedPlacement(template, decision, h.f.set.placementFor(decision));
    copyFixtureRows(h.ledgerDb, 'tier_items', ids);
    copyFixtureRows(h.ledgerDb, 'tier_copies', ids, { copy_state: "'superseded'" });
  })();
  expect(h.db.query("SELECT COUNT(*) AS n FROM items WHERE provider_item_id LIKE 'store-only-%'").get()).toEqual({ n: 0 });

  const off = h.reader(false);
  const on = h.reader(true);
  const sync = h.reader(true);
  const firstPageOnly = truncate ? h.reader(true) : undefined;
  const storeCursor = issuedStoreCursor(h.db);
  const ledgerCursor = h.f.ledger.visibilityChangesSince().cursor;
  for (const reader of firstPageOnly ? [off, on, sync, firstPageOnly] : [off, on, sync]) {
    reader.tierHiddenItemPks();
    const memo = reader.tierLedgerHiddenMemo!;
    expect(memo.ledgerCursor).toBe(ledgerCursor);
    expect(memo.storeCursor).toBe(storeCursor);
    for (const identity of identities) {
      const member = memo.members.get(tierLedgerIdentityKey(identity));
      expect(member?.flags.hidden).toBe(true);
      expect(member?.pks).toEqual([]);
    }
  }
  return { h, ids, off, on, sync, firstPageOnly, storeCursor, ledgerCursor };
}

test.each([
  { count: 1_001, duplicates: false },
  { count: 500, duplicates: false },
  { count: 501, duplicates: false },
  { count: 500, duplicates: true },
])('store-only inserts refresh all hidden pks ($count items, duplicates: $duplicates)', async ({ count, duplicates }) => {
  const { h, ids, off, on, sync, firstPageOnly, ledgerCursor, storeCursor } = warmStoreOnlyMemos(count, count === 1_001);
  h.db.transaction(() => {
    if (duplicates) {
      insertItemRows(h.db, ids.slice(0, 499));
      // A visibility-column UPDATE records OLD and NEW at positions 500 and 501.
      h.db.query('UPDATE items SET trust_tier = trust_tier WHERE provider_item_id = ?').run(ids[0]!);
      insertItemRows(h.db, ids.slice(499));
    } else {
      insertItemRows(h.db, ids);
    }
  })();
  const feed = storeFeedAfter(h.db, storeCursor);
  expect(feed).toHaveLength(count + (duplicates ? 2 : 0));
  expect(feed.map(row => row.provider_item_id)).toEqual(duplicates
    ? [...ids.slice(0, 499), ids[0]!, ids[0]!, ...ids.slice(499)]
    : ids);
  const finalCursor = issuedStoreCursor(h.db);
  expect(finalCursor - storeCursor).toBe(feed.length);
  expect(h.f.ledger.visibilityChangesSince().cursor).toBe(ledgerCursor);

  const pks = ids.map(id => h.pk(id));
  const expected = sorted(await off.tierHiddenItemPksInTurns());
  const reads = observePool();
  const pooled = await on.tierHiddenItemPksInTurns();
  setReadPoolObserverForTests();
  expect(sorted(pooled)).toEqual(expected);
  expect(sorted(sync.tierHiddenItemPks())).toEqual(expected);
  const newPks = new Set(pks);
  expect(pooled.hidden.filter(pk => newPks.has(pk)).sort((a, b) => a - b)).toEqual(pks);
  for (const index of new Set([0, 499, 500, count - 1])) {
    if (index < count) expect(pooled.hidden).toContain(pks[index]!);
  }
  expect([...new Set(reads.filter(({ path, read }) => path === h.f.paths.internal && isStoreFeedPage(read.sql))
    .map(({ read }) => read.params[0]))]).toEqual([
      storeCursor,
      ...feed.filter((_, index) => (index + 1) % 500 === 0 && index + 1 < feed.length).map(row => row.seq),
    ]);
  expect(on.tierLedgerHiddenMemo!.storeCursor).toBe(finalCursor);

  if (firstPageOnly) {
    const suppressedPages = new Set<unknown>();
    setReadPoolObserverForTests((path, read) => {
      if (path !== h.f.paths.internal || !isStoreFeedPage(read.sql) || read.params[0] === storeCursor) return;
      // Empty the later page before dispatch. The generator still reports
      // the cursor it captured from the real bounds query.
      suppressedPages.add(read.params[0]);
      read.params = [read.params[1], read.params[1]];
    }, { snapshots: true });
    let truncated: HiddenSet;
    try {
      truncated = await firstPageOnly.tierHiddenItemPksInTurns();
    } finally {
      setReadPoolObserverForTests();
    }
    expect([...suppressedPages]).toEqual([feed[499]!.seq]);
    expect(firstPageOnly.tierLedgerHiddenMemo!.storeCursor).toBe(finalCursor);
    expect(sorted(truncated)).not.toEqual(expected);
    expect(truncated.hidden.filter(pk => newPks.has(pk)).sort((a, b) => a - b)).toEqual(pks.slice(0, 500));
  }
});

test('an empty pruned store feed retains its issued cursor and refreshes hidden pks', async () => {
  const { h, ids, off, on, ledgerCursor, storeCursor } = warmStoreOnlyMemos(1);
  insertItemRows(h.db, ids);
  expect(storeFeedAfter(h.db, storeCursor)).toHaveLength(1);
  const issued = issuedStoreCursor(h.db);
  expect(issued).toBe(storeCursor + 1);
  h.db.exec('DELETE FROM main.item_visibility_feed');
  expect(storeFeedAfter(h.db, 0)).toEqual([]);
  expect(issuedStoreCursor(h.db)).toBe(issued);
  expect(h.f.ledger.visibilityChangesSince().cursor).toBe(ledgerCursor);

  const expected = await off.tierHiddenItemPksInTurns();
  const pooled = await on.tierHiddenItemPksInTurns();
  expect(sorted(pooled)).toEqual(sorted(expected));
  expect(pooled.hidden).toContain(h.pk(ids[0]!));
  expect(off.tierLedgerHiddenMemo!.storeCursor).toBe(issued);
  expect(on.tierLedgerHiddenMemo!.storeCursor).toBe(issued);
});

test.each(['internal', 'secure_local'] as const)('two incremental rounds equal switch-off and synchronous sets in %s', async (domain) => {
  const h = await setup();
  const off = h.reader(false, domain);
  const on = h.reader(true, domain);
  const sync = h.reader(true, domain);
  const first = await on.tierHiddenItemPksInTurns();
  expect(sorted(first)).toEqual(sorted(await off.tierHiddenItemPksInTurns()));
  expect(sorted(first)).toEqual(sorted(sync.tierHiddenItemPks()));
  if (domain === 'internal') {
    for (const id of ['private', 'staged', 'superseded', 'child']) expect(first.hidden).toContain(h.pk(id));
    expect(first.metadataLayer).toContain(h.pk('metadata'));
    expect(first.metadataLayerContentUnread).toContain(h.pk('metadata-unread'));
    expect(on.copyServable(identityOf('row-25'))).toBe(true); // Personal
    expect(h.f.stores.internal!.localContent(identityOf('secret').localItemId)).toBeUndefined();
    expect(h.f.ledger.getCurrent(identityOf('secret'))?.contentTier).toBe('secrets');
  } else {
    expect(first.held).toContain(h.pk('held', domain));
    expect(first.heldForJudgment).toContain(h.pk('held', domain));
  }
  for (const round of [1, 2]) {
    await h.change(round);
    const offReads = observePool();
    const offResult = await off.tierHiddenItemPksInTurns();
    expect(offReads.filter(({ read }) => isIncremental(read.sql))).toEqual([]);
    const pooled = observePool();
    const trace = startMainThreadSqlSiteCount(3);
    let onResult: HiddenSet;
    try {
      onResult = await on.tierHiddenItemPksInTurns();
      const targetSites = trace.sites().filter(({ site }) =>
        /visibilityChangesSince|itemVisibilityChangesSince|corpusVisibilityPages|itemRowsForIdentities/.test(site)
        // Parent read fencing still takes only the feed bounds here.
        && !site.includes('childVisibilityMarker'));
      expect(targetSites).toEqual([]);
    } finally { trace.stop(); }
    setReadPoolObserverForTests();
    expect(sorted(onResult!)).toEqual(sorted(offResult));
    expect(sorted(onResult!)).toEqual(sorted(sync.tierHiddenItemPks()));
    expect(pooled.some(({ read }) => read.sql.includes('FROM tier_visibility_changes WHERE seq >'))).toBe(true);
    expect(pooled.some(({ read }) => read.sql.includes('FROM main.item_visibility_feed WHERE seq >'))).toBe(true);
    expect(pooled.some(({ read }) => isLedgerFlagBatch(read.sql))).toBe(true);
    expect(pooled.some(({ read }) => read.sql.includes('CROSS JOIN items i'))).toBe(true);
    // Check the gated reads too: the stock guard workload keeps the switch
    // off, so it cannot prove that these new pool queries are keyed.
    const planned = new Set<string>();
    for (const { path, read } of pooled) if (isIncremental(read.sql) && !planned.has(read.sql)) {
      planned.add(read.sql);
      const db = new Database(path, { readonly: true });
      try { expect(largeTableScans(db, read.sql, new Set(LOOP_SQL_LARGE_TABLES))).toEqual([]); }
      finally { db.close(); }
    }
  }
});

test('a write during a pooled incremental page is retried, never served, and retained for the next read', async () => {
  const h = await setup(24);
  const on = h.reader(true);
  await on.tierHiddenItemPksInTurns();
  await h.move('row-2', 'secure');
  const start = { ...on.tierLedgerHiddenMemo! };
  let write: Promise<unknown> | undefined;
  let pages = 0;
  setReadPoolObserverForTests((_path, read) => {
    if (!isLedgerFlagBatch(read.sql)) return;
    pages++;
    if (!write) write = h.move('row-9', 'secure');
  }, { snapshots: true });
  const built = await on.tierHiddenItemPksInTurns();
  await waitFor(() => write !== undefined);
  await write;
  setReadPoolObserverForTests();
  expect(built.hidden).toContain(h.pk('row-2'));
  expect(pages).toBeGreaterThan(1); // changed read was taken again
  expect(on.copyServable(identityOf('row-9'))).toBe(false);
  // The build retains the cursors captured before this write. The current
  // row check above withholds it until the next build consumes that feed.
  expect(on.tierLedgerHiddenMemo!.ledgerCursor).toBeLessThan(h.f.ledger.visibilityChangesSince().cursor);
  expect(on.tierLedgerHiddenMemo!.ledgerCursor).toBeGreaterThan(start.ledgerCursor);
  const next = on.tierHiddenItemPks();
  const fresh = h.reader(false).tierHiddenItemPks();
  expect(next.hidden).toContain(h.pk('row-9'));
  expect(sorted(next)).toEqual(sorted(fresh));
});

test('a long ledger hold uses here for incremental reads, including its uncommitted hides', async () => {
  const h = await setup(24);
  const on = h.reader(true);
  await on.tierHiddenItemPksInTurns();
  const reads = observePool();
  await h.f.ledger.holdingWrites(async () => {
    await h.move('row-5', 'secure');
    const built = await on.tierHiddenItemPksInTurns();
    expect(built.hidden).toContain(h.pk('row-5'));
    expect(reads.filter(({ read }) => isIncremental(read.sql))).toEqual([]);
  });
  setReadPoolObserverForTests();
  expect(sorted(on.tierHiddenItemPks())).toEqual(sorted(h.reader(false).tierHiddenItemPks()));
});

test('a reader advancing the memo during a pooled feed cannot be overwritten by its older delta', async () => {
  const h = await setup(24);
  const on = h.reader(true);
  await on.tierHiddenItemPksInTurns();
  await h.move('row-2', 'secure');
  let advanced = false;
  setReadPoolObserverForTests((_path, read) => {
    if (advanced || !read.sql.includes('FROM tier_visibility_changes WHERE seq >')) return;
    advanced = true;
    h.ledgerDb.query("UPDATE tier_copies SET copy_state = 'superseded' WHERE provider_item_id = ?").run('row-9');
    on.tierHiddenItemPks();
  }, { snapshots: true });
  const built = await on.tierHiddenItemPksInTurns();
  setReadPoolObserverForTests();
  expect(advanced).toBe(true);
  expect(built.hidden).toContain(h.pk('row-9'));
  expect(sorted(built)).toEqual(sorted(h.reader(false).tierHiddenItemPks()));
});

test('saved-set catch-up reads its ledger feeds on the pool and rejects retention gaps', async () => {
  const h = await setup(24);
  const writer = probe(h.f.stores.internal!);
  writer.tierHiddenItemPks();
  await writer.publishVisibility();
  await h.move('row-3', 'secure');
  const on = h.reader(true);
  const reads = observePool();
  expect(sorted(await on.tierHiddenItemPksInTurns())).toEqual(sorted(h.reader(false).tierHiddenItemPks()));
  expect(reads.filter(({ read }) => read.sql.includes('FROM tier_visibility_changes WHERE seq >')).length).toBeGreaterThanOrEqual(2);
  setReadPoolObserverForTests();
  // The saved stamp is now outside retention; a fresh reader must bootstrap.
  h.ledgerDb.transaction(() => {
    for (let n = 0; n < 4_100; n++) h.ledgerDb.query('UPDATE tier_copies SET embed_hold = 1 - embed_hold WHERE provider_item_id = ?').run('row-4');
  })();
  const gapReads = observePool();
  expect(sorted(await h.reader(true).tierHiddenItemPksInTurns())).toEqual(sorted(h.reader(false).tierHiddenItemPks()));
  expect(gapReads.some(({ read }) => read.sql.includes('tier_copies_visibility_walk') && !isLedgerFlagBatch(read.sql))).toBe(true);
});

test('the awaited child path retries a feed read that meets a parent tombstone', async () => {
  const h = await setup(24);
  const on = h.reader(true);
  expect(await on.hiddenChildItemPksInTurns()).toContain(h.pk('child'));
  h.db.query('UPDATE items SET tombstoned = 0 WHERE provider_item_id = ?').run('parent');
  let written = false;
  let feedPages = 0;
  setReadPoolObserverForTests((_path, read) => {
    if (!read.sql.includes('FROM main.item_visibility_feed WHERE seq >')) return;
    feedPages++;
    if (written) return;
    written = true;
    h.db.query('UPDATE items SET tombstoned = 1 WHERE provider_item_id = ?').run('parent');
  }, { snapshots: true });
  const hidden = await on.hiddenChildItemPksInTurns();
  setReadPoolObserverForTests();
  expect(written).toBe(true);
  expect(feedPages).toBeGreaterThan(1);
  expect(hidden).toContain(h.pk('child'));
  expect(on.copyServable(identityOf('child'))).toBe(false);
  expect(sorted(on.tierHiddenItemPks())).toEqual(sorted(h.reader(false).tierHiddenItemPks()));
});
