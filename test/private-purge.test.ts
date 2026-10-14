import { afterEach, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { fixtureConnector, FIXTURE_PLACEMENT, openTierFixture, tempDir, identityOf, localId } from './helpers/tier-fixtures.ts';
import { moveTieredItem } from '../src/workers/connector-store/tier-move.ts';
import { purgeLowerTierContent } from '../src/workers/connector-store/tier-content-purge.ts';

const closes: Array<() => void> = [];
afterEach(() => { for (const close of closes.splice(0)) close(); });
const body = 'Synthetic message about a garden meeting. Bodymarkerprivatepurge.';
const target = { metadataTier: 'private' as const, contentTier: 'secure' as const };

async function fixture() {
  const tmp = tempDir('olympus-private-purge-');
  let f = openTierFixture(tmp.dir, { family: 'email' });
  // Synthetic Gmail identities exercise the shared connector pipeline.
  const base = fixtureConnector(() => [{ id: 'mail', name: 'Garden', text: body }, { id: 'safe', name: 'Orchard', text: 'Ordinary pears.' }]);
  const connector = { ...base, id: 'gmail.synthetic', family: 'email' as const,
    listItems: async function* () { for await (const page of base.listItems()) {
      if ('items' in page) yield { ...page, items: page.items.map(item => ({ ...item, identity: { ...item.identity, provider: 'gmail', family: 'email' as const } })) };
    } },
    fetchItem: async (id: string) => { const item = await base.fetchItem(id); return { ...item, identity: { ...item.identity, provider: 'gmail', family: 'email' as const } }; },
  };
  await f.set.sync(connector, { fetchContent: true, placement: FIXTURE_PLACEMENT });
  const identity = { ...identityOf('mail'), provider: 'gmail', family: 'email' as const };
  const safe = { ...identityOf('safe'), provider: 'gmail', family: 'email' as const };
  closes.push(() => { f.close(); tmp.cleanup(); });
  return { get f() { return f; }, identity, safe, connector,
    restart: () => { f.close(); f = openTierFixture(tmp.dir, { family: 'email' }); return f; } };
}

function contentCounts(path: string, id = 'personal:mail') {
  const db = new Database(path);
  try {
    const pk = (db.query('SELECT item_pk FROM items WHERE local_item_id = ?').get(id) as { item_pk: number }).item_pk;
    const count = (table: string) => (db.query(`SELECT COUNT(*) AS n FROM ${table} WHERE item_pk = ?`).get(pk) as { n: number }).n;
    return { chunks: count('chunks'), vectors: count('chunk_embeddings'), versions: count('item_text_versions'),
      fts: (db.query('SELECT COUNT(*) AS n FROM connector_store_fts WHERE item_pk = ? AND chunk_pk IS NOT NULL').get(pk) as { n: number }).n };
  } finally { db.close(); }
}
const empty = { chunks: 0, vectors: 0, versions: 0, fts: 0 };

test('Gmail Personal to Private removes lower body, FTS, vectors and version rows; Personal neighbour unchanged', async () => {
  const x = await fixture(); const f = x.f;
  expect(contentCounts(f.paths.internal)).toMatchObject({ chunks: 1, vectors: 1, fts: 1 });
  const beforeSafe = contentCounts(f.paths.internal, localId('safe'));
  await moveTieredItem({ set: f.set, identity: x.identity, target });
  expect(contentCounts(f.paths.internal)).toEqual(empty);
  expect(f.stores.secure_local!.localContent(localId('mail'))?.chunks.join('')).toBe(body);
  expect(contentCounts(f.paths.internal, localId('safe'))).toEqual(beforeSafe);
  expect(f.stores.internal!.searchItems('Bodymarkerprivatepurge', 10)).toEqual([]);
});

test.each(['afterVerified', 'afterPurge'] as const)('restart after %s converges without overwriting destination from empty source', async hook => {
  const x = await fixture();
  await expect(moveTieredItem({ set: x.f.set, identity: x.identity, target, [hook]: () => { throw new Error('crash'); } })).rejects.toThrow('crash');
  if (hook === 'afterVerified') expect(contentCounts(x.f.paths.internal).chunks).toBe(1);
  else expect(contentCounts(x.f.paths.internal)).toEqual(empty);
  const reopened = x.restart(); // bounded startup pass resumes receipt
  expect(reopened.ledger.getCurrent(x.identity)?.state).toBe('current');
  expect(reopened.stores.secure_local!.localContent(localId('mail'))?.chunks.join('')).toBe(body);
  expect(contentCounts(reopened.paths.internal)).toEqual(empty);
});

test('failed destination copy/verification leaves source intact and can be retried', async () => {
  const x = await fixture();
  const store = x.f.stores.secure_local!;
  const original = store.importItemCopy.bind(store);
  store.importItemCopy = () => { throw new Error('disk full'); };
  await expect(moveTieredItem({ set: x.f.set, identity: x.identity, target })).rejects.toThrow('disk full');
  expect(contentCounts(x.f.paths.internal)).toMatchObject({ chunks: 1, vectors: 1, fts: 1 });
  store.importItemCopy = original;
  await moveTieredItem({ set: x.f.set, identity: x.identity, target });
  expect(contentCounts(x.f.paths.internal)).toEqual(empty);
});

test('bounded ledger repair clears pre-1.0.1 leftovers including zero-chunk text versions, idempotently', async () => {
  const x = await fixture(); const f = x.f;
  const lower = f.stores.internal!;
  const kept = lower.exportItemCopy(x.identity)!;
  await moveTieredItem({ set: f.set, identity: x.identity, target });
  // Simulate old release's retained metadata-copy content after its flip.
  lower.importItemCopy(kept, { trustTier: 'S3', syncConnectorId: 'old-release', layers: 'both' });
  const db = new Database(f.paths.internal);
  const pk = (db.query('SELECT item_pk FROM items WHERE local_item_id = ?').get(localId('mail')) as { item_pk: number }).item_pk;
  db.query('INSERT OR REPLACE INTO item_text_versions (item_pk, source_version, recorded_at) VALUES (?, ?, ?)').run(pk, 'old', '2026-10-14');
  db.query('DELETE FROM chunks WHERE item_pk = ?').run(pk); db.close();
  expect(contentCounts(f.paths.internal).versions).toBe(1);
  const r = purgeLowerTierContent(f.set, { limit: 1 });
  expect(r.checked).toBeLessThanOrEqual(1);
  expect(contentCounts(f.paths.internal)).toEqual(empty);
  purgeLowerTierContent(f.set); purgeLowerTierContent(f.set);
  expect(contentCounts(f.paths.internal)).toEqual(empty);
  expect(f.stores.secure_local!.localContent(localId('mail'))?.chunks.join('')).toBe(body);
});

test('repair refuses an identity whose generation changes before deletion', async () => {
  const x = await fixture(); const f = x.f;
  const retained = f.stores.internal!.exportItemCopy(x.identity)!;
  await moveTieredItem({ set: f.set, identity: x.identity, target });
  f.stores.internal!.importItemCopy(retained, { trustTier: 'S3', syncConnectorId: 'old', layers: 'both' });
  const report = purgeLowerTierContent(f.set, { limit: 1, beforeDelete: () => {
    const competing = new Database(f.ledger.dbPath);
    competing.query('UPDATE tier_items SET generation = generation + 1 WHERE provider = ? AND account_scope = ? AND provider_item_id = ?')
      .run(x.identity.provider, x.identity.accountScope, x.identity.providerItemId);
    competing.close();
  } });
  expect(report.failed).toBe(1);
  expect(contentCounts(f.paths.internal).chunks).toBe(1);
});

test('a hidden higher-tier vector cannot crowd an eligible Personal item out of the rank limit', async () => {
  const x = await fixture(); const f = x.f;
  const lower = f.stores.internal!;
  const retained = lower.exportItemCopy(x.identity)!;
  await moveTieredItem({ set: f.set, identity: x.identity, target });
  lower.importItemCopy(retained, { trustTier: 'S3', syncConnectorId: 'old-release', layers: 'both', vectorProvider: f.cloud });
  const db = new Database(f.paths.internal);
  for (const [id, values] of [[localId('mail'), [1, 0, 0, 0]], [localId('safe'), [0, 1, 0, 0]]] as const) {
    db.query('UPDATE chunk_embeddings SET embedding = ? WHERE item_pk = (SELECT item_pk FROM items WHERE local_item_id = ?)')
      .run(new Uint8Array(new Float32Array(values).buffer), id);
  }
  db.close();
  f.cloud.embed = async () => [[1, 0.8, 0, 0]];
  const results = await lower.vectorSearchItems('garden', f.cloud, 1);
  expect(results.map(row => row.sourceItem.localItemId)).toEqual([localId('safe')]);
});

test('destination verification failure preserves the lower source and its vectors', async () => {
  const x = await fixture();
  await expect(moveTieredItem({ set: x.f.set, identity: x.identity, target, afterVerified: () => {
    const db = new Database(x.f.paths.secure_local);
    db.query('DELETE FROM chunks').run(); db.close();
  } })).rejects.toThrow('destination changed');
  expect(contentCounts(x.f.paths.internal)).toMatchObject({ chunks: 1, vectors: 1, fts: 1 });
  expect(x.f.ledger.getCurrent(x.identity)?.state).toBe('moving');
});

test('a metadata-only raise removes zero-chunk version remnants', async () => {
  const tmp = tempDir(); const f = openTierFixture(tmp.dir, { embed: false });
  closes.push(() => { f.close(); tmp.cleanup(); });
  await f.set.sync(fixtureConnector(() => [{ id: 'mail', name: 'Garden' }]), { placement: FIXTURE_PLACEMENT });
  const identity = identityOf('mail');
  f.ledger.adoptLegacyPlacement(identity, [{ corpusId: f.stores.internal!.corpusId, trustDomain: 'internal', layers: 'metadata' }]);
  f.stores.internal!.bindTierSet(f.ledger);
  const db = new Database(f.paths.internal);
  const pk = (db.query('SELECT item_pk FROM items WHERE local_item_id = ?').get(localId('mail')) as { item_pk: number }).item_pk;
  db.query('INSERT INTO item_text_versions (item_pk, source_version, recorded_at) VALUES (?, ?, ?)').run(pk, 'old', '2026-10-14');
  db.close();
  await moveTieredItem({ set: f.set, identity, target: { metadataTier: 'secure', contentTier: 'secure' } });
  expect(contentCounts(f.paths.internal)).toEqual(empty);
});

test('a move between vector scan pages cannot crowd out a Personal match at ranking time', async () => {
  const x = await fixture(); const f = x.f; const lower = f.stores.internal!;
  const copy = lower.exportItemCopy(x.identity)!;
  lower.importItemCopy({ ...copy, chunks: Array.from({ length: 260 }, (_, chunkIndex) => ({ ...copy.chunks[0]!, chunkIndex })) },
    { trustTier: 'S3', syncConnectorId: 'paged-fixture', layers: 'both' });
  const db = new Database(f.paths.internal);
  db.query(`INSERT OR REPLACE INTO chunk_embeddings (chunk_pk, item_pk, model_id, content_hash, embedding, embedded_at)
    SELECT c.chunk_pk, c.item_pk, ?, c.embedding_input_hash, ?, '2026-10-14'
    FROM chunks c JOIN items i ON i.item_pk = c.item_pk WHERE i.local_item_id = ?`)
    .run(f.cloud.modelId, new Uint8Array(new Float32Array([1, 0, 0, 0]).buffer), localId('mail'));
  db.query('UPDATE chunk_embeddings SET embedding = ? WHERE item_pk = (SELECT item_pk FROM items WHERE local_item_id = ?)')
    .run(new Uint8Array(new Float32Array([0, 1, 0, 0]).buffer), localId('safe'));
  db.close();
  let moved!: Promise<unknown>;
  let began!: () => void;
  const started = new Promise<void>(resolve => { began = resolve; });
  f.cloud.embed = async () => {
    setTimeout(() => { moved = moveTieredItem({ set: f.set, identity: x.identity, target }); began(); }, 0);
    return [[1, 0.8, 0, 0]];
  };
  const searching = lower.vectorSearchItems('garden', f.cloud, 1);
  await started; await moved;
  expect((await searching).map(row => row.sourceItem.localItemId)).toEqual([localId('safe')]);
});

test.each(['afterVerified', 'afterPurge'] as const)('a newer Secret/restored generation supersedes a %s receipt without blocking later moves', async hook => {
  const x = await fixture(); const f = x.f;
  await expect(moveTieredItem({ set: f.set, identity: x.identity, target, [hook]: () => { throw new Error('crash'); } })).rejects.toThrow('crash');
  await moveTieredItem({ set: f.set, identity: x.identity, target: { metadataTier: 'secrets', contentTier: 'secrets' } });
  f.ledger.setOverride(x.identity, { kind: 'not_secret' });
  await f.set.sync(x.connector, { fetchContent: true, placement: FIXTURE_PLACEMENT });
  expect(f.ledger.getCurrent(x.identity)?.contentTier).toBe('private');
  expect(f.stores.internal!.localContent(localId('mail'))?.chunks.join('')).toBe(body);
  await moveTieredItem({ set: f.set, identity: x.identity, target });
  expect(contentCounts(f.paths.internal)).toEqual(empty);
  expect(f.stores.secure_local!.localContent(localId('mail'))?.chunks.join('')).toBe(body);
});

test('vector visibility uses full row identity when a hidden and a Personal item share a local id', async () => {
  const x = await fixture(); const f = x.f; const lower = f.stores.internal!;
  const retained = lower.exportItemCopy(x.identity)!;
  await moveTieredItem({ set: f.set, identity: x.identity, target });
  lower.importItemCopy(retained, { trustTier: 'S3', syncConnectorId: 'old-release', layers: 'both', vectorProvider: f.cloud });
  const db = new Database(f.paths.internal);
  db.query('UPDATE items SET local_item_id = ? WHERE provider_item_id = ?').run(localId('mail'), 'safe');
  for (const [id, values] of [['mail', [1, 0, 0, 0]], ['safe', [0, 1, 0, 0]]] as const) {
    db.query('UPDATE chunk_embeddings SET embedding = ? WHERE item_pk = (SELECT item_pk FROM items WHERE provider_item_id = ?)')
      .run(new Uint8Array(new Float32Array(values).buffer), id);
  }
  db.close();
  f.cloud.embed = async () => [[1, 0.8, 0, 0]];
  expect((await lower.vectorSearchItems('garden', f.cloud, 1)).map(row => row.sourceItem.providerItemId)).toEqual(['safe']);
});

test('a stale second executor cannot copy an emptied source over a completed destination', async () => {
  const x = await fixture(); const f = x.f;
  let first!: Promise<unknown>;
  await expect(moveTieredItem({ set: f.set, identity: x.identity, target, beforeCopy: () => {
    first = moveTieredItem({ set: f.set, identity: x.identity, target });
  } })).rejects.toMatchObject({ name: 'TierLedgerGenerationConflictError' });
  await first;
  expect(contentCounts(f.paths.internal)).toEqual(empty);
  expect(f.stores.secure_local!.localContent(localId('mail'))?.chunks.join('')).toBe(body);
});

test('a second executor resumes a first executor partial purge instead of recopying its emptied source', async () => {
  const x = await fixture(); const f = x.f;
  let first!: Promise<unknown>;
  await moveTieredItem({ set: f.set, identity: x.identity, target, beforeCopy: () => {
    first = moveTieredItem({ set: f.set, identity: x.identity, target, afterPurge: () => { throw new Error('crash'); } }).catch(error => error);
  } });
  expect(await first).toBeInstanceOf(Error);
  expect(contentCounts(f.paths.internal)).toEqual(empty);
  expect(f.stores.secure_local!.localContent(localId('mail'))?.chunks.join('')).toBe(body);
});

test('override revocation after lower strip resumes verified destination instead of replanning empty source', async () => {
  const x = await fixture(); const f = x.f;
  f.ledger.setOverride(x.identity, { kind: 'tier', tier: 'secure' });
  const { applyOwnerOverrides } = await import('../src/workers/connector-store/tier-override-settle.ts');
  expect(applyOwnerOverrides({ set: f.set }).raised).toBe(1);
  const target = { metadataTier: 'secure' as const, contentTier: 'secure' as const };
  await expect(moveTieredItem({ set: f.set, identity: x.identity, target,
    afterPurge: () => { throw new Error('crash'); } })).rejects.toThrow('crash');
  expect(contentCounts(f.paths.internal)).toEqual(empty);
  f.ledger.clearOverride(x.identity);
  await moveTieredItem({ set: f.set, identity: x.identity, target });
  expect(f.ledger.getCurrent(x.identity)).toMatchObject({ state: 'current', contentTier: 'secure', metadataTier: 'secure' });
  expect(f.stores.secure_local!.localContent(localId('mail'))?.chunks.join('')).toBe(body);
  expect(contentCounts(f.paths.internal)).toEqual(empty);
});

test('abandon removes verified receipt before another move queues at the same generation', async () => {
  const x = await fixture(); const f = x.f;
  await expect(moveTieredItem({ set: f.set, identity: x.identity,
    target: { metadataTier: 'private', contentTier: 'private' },
    afterVerified: () => { throw new Error('crash'); } })).rejects.toThrow('crash');
  const generation = f.ledger.getCurrent(x.identity)!.generation;
  const key = `tier-move-verified:${x.identity.provider}\0${x.identity.accountScope}\0\0${x.identity.providerItemId}`;
  expect(f.ledger.readMeta(key)).toBeTruthy();
  f.ledger.abandonMove(x.identity, { expectedGeneration: generation });
  expect(f.ledger.readMeta(key)).toBe('');
  expect(f.ledger.getCurrent(x.identity)!.generation).toBe(generation);
  await moveTieredItem({ set: f.set, identity: x.identity, target });
  expect(contentCounts(f.paths.internal)).toEqual(empty);
  expect(f.stores.secure_local!.localContent(localId('mail'))?.chunks.join('')).toBe(body);
});

test.each(['empty', 'stale'] as const)('repair preserves lower content when destination body is %s', async damage => {
  const x = await fixture(); const f = x.f;
  const retained = f.stores.internal!.exportItemCopy(x.identity)!;
  await moveTieredItem({ set: f.set, identity: x.identity, target });
  f.stores.internal!.importItemCopy(retained, { trustTier: 'S3', syncConnectorId: 'old', layers: 'both' });
  const db = new Database(f.paths.secure_local);
  if (damage === 'empty') db.query('DELETE FROM chunks').run();
  else db.query('UPDATE items SET source_version = ? WHERE provider_item_id = ?').run('new-unread-version', 'mail');
  db.close();
  const report = purgeLowerTierContent(f.set);
  expect(report.failed).toBe(1);
  expect(contentCounts(f.paths.internal).chunks).toBe(1);
});

test('maintenance finishes, persists done across restart, and neither exports nor scans the corpus again', async () => {
  const x = await fixture(); const f = x.f;
  await f.set.repairLowerContent(); // let startup note flush settle
  let scans = 0; let exports = 0;
  const originalScan = f.ledger.listRouted.bind(f.ledger);
  const originalExport = f.stores.secure_local!.exportItemCopy.bind(f.stores.secure_local!);
  f.ledger.listRouted = options => { scans++; return originalScan(options); };
  f.stores.secure_local!.exportItemCopy = identity => { exports++; return originalExport(identity); };
  await f.set.repairLowerContent({ nowMs: Date.now() + 1_000 });
  purgeLowerTierContent(f.set, { maintenance: true });
  expect(scans).toBe(0); expect(exports).toBe(0);
  expect(f.ledger.readMeta('lower-content-purge-done-v2')).toBe('1');
  const reopened = x.restart();
  expect(reopened.ledger.readMeta('lower-content-purge-done-v2')).toBe('1');
});

test('repair reads content proof without exports and writes its durable embedding note outside the ledger writer', async () => {
  const x = await fixture(); const f = x.f;
  const retained = f.stores.internal!.exportItemCopy(x.identity)!;
  await moveTieredItem({ set: f.set, identity: x.identity, target });
  f.stores.internal!.importItemCopy(retained, { trustTier: 'S3', syncConnectorId: 'old', layers: 'both' });
  f.stores.secure_local!.exportItemCopy = () => { throw new Error('sweep must not export'); };
  const path = `${f.dir}/repair-ledger.jsonl`;
  expect(purgeLowerTierContent(f.set, { embeddingLedger: { path, approvedBy: 'system-automatic' } }).purged).toBe(1);
  const { flushTierMoveNotes } = await import('../src/workers/connector-store/tier-move.ts');
  await flushTierMoveNotes(f.ledger);
  const { readEmbeddingLedger } = await import('../src/workers/embedding-ledger.ts');
  const notes = (await readEmbeddingLedger(path)).entries.filter(entry => entry.entry_id?.startsWith('tier-content-repair:'));
  expect(notes).toHaveLength(1);
  expect(notes[0]!.scope?.chunks).toEqual({ [f.stores.internal!.corpusId]: 1 });
});

test.each(['direct', 'sweep'] as const)('a verified move resumed by %s writes the normal embedding note exactly once', async via => {
  const x = await fixture(); const f = x.f;
  const path = `${f.dir}/move-ledger.jsonl`;
  const embeddingLedger = { path, approvedBy: 'system-automatic' as const };
  await expect(moveTieredItem({ set: f.set, identity: x.identity, target, embeddingLedger,
    afterPurge: () => { throw new Error('crash'); } })).rejects.toThrow('crash');
  if (via === 'direct') await moveTieredItem({ set: f.set, identity: x.identity, target, embeddingLedger });
  else {
    expect(purgeLowerTierContent(f.set, { maintenance: true, embeddingLedger }).resumed).toBe(1);
    const { flushTierMoveNotes } = await import('../src/workers/connector-store/tier-move.ts');
    await flushTierMoveNotes(f.ledger);
  }
  const { readEmbeddingLedger } = await import('../src/workers/embedding-ledger.ts');
  expect((await readEmbeddingLedger(path)).entries.filter(entry => entry.entry_id?.startsWith('tier-move:'))).toHaveLength(1);
  const { flushTierMoveNotes } = await import('../src/workers/connector-store/tier-move.ts');
  await flushTierMoveNotes(f.ledger);
  expect((await readEmbeddingLedger(path)).entries.filter(entry => entry.entry_id?.startsWith('tier-move:'))).toHaveLength(1);
});

test('an unfinished repair page waits for the maintenance cadence rather than each sniffer tick', async () => {
  const x = await fixture(); const f = x.f;
  await f.set.repairLowerContent();
  f.ledger.writeMeta('lower-content-purge-done-v2', '');
  const original = f.ledger.listRouted.bind(f.ledger);
  let scans = 0;
  f.ledger.listRouted = options => { scans++; return original(options); };
  const now = Date.now() + 5 * 60_000;
  await f.set.repairLowerContent({ nowMs: now });
  expect(scans).toBe(1);
  // Leave work outstanding to distinguish cadence from the done watermark.
  f.ledger.writeMeta('lower-content-purge-done-v2', '');
  for (let tick = 1; tick <= 10; tick++) await f.set.repairLowerContent({ nowMs: now + tick * 1_000 });
  expect(scans).toBe(1);
  await f.set.repairLowerContent({ nowMs: now + 5 * 60_000 });
  expect(scans).toBe(2);
});

test('an abandoned executor cannot flip a new move with the same generation and target', async () => {
  const x = await fixture(); const f = x.f;
  const target = { metadataTier: 'private' as const, contentTier: 'private' as const };
  await expect(moveTieredItem({ set: f.set, identity: x.identity, target, afterVerified: () => {
    const generation = f.ledger.getCurrent(x.identity)!.generation;
    f.ledger.abandonMove(x.identity, { expectedGeneration: generation });
    f.ledger.stageMove(x.identity, { expectedGeneration: generation, target,
      destination: f.set.placementFor({ ...target, state: 'current', metadataPending: false, contentPending: false, contentRead: true }).copies,
      hideSource: false });
  } })).rejects.toMatchObject({ name: 'TierLedgerGenerationConflictError' });
  expect(f.ledger.getCurrent(x.identity)?.state).toBe('moving');
  expect(contentCounts(f.paths.internal).chunks).toBe(1);
  await moveTieredItem({ set: f.set, identity: x.identity, target });
  expect(f.ledger.getCurrent(x.identity)?.state).toBe('current');
});

test('failed receipts rotate without starving a later valid receipt or historical repair', async () => {
  const x = await fixture(); const f = x.f;
  await expect(moveTieredItem({ set: f.set, identity: x.identity, target,
    afterVerified: () => { throw new Error('crash'); } })).rejects.toThrow('crash');
  const receiptKey = `tier-move-verified:${x.identity.provider}\0${x.identity.accountScope}\0\0${x.identity.providerItemId}`;
  const receipt = f.ledger.readMeta(receiptKey)!;
  // Unknown identities model unavailable recovery obligations ahead of a live
  // receipt. They fail, remain durable, and must not consume every later pass.
  for (let i = 0; i < 205; i++) f.ledger.writeMeta(`tier-move-verified:aaa\0personal\0\0${String(i).padStart(3, '0')}`, receipt);
  f.ledger.writeMeta('lower-content-purge-done-v2', '');
  const first = purgeLowerTierContent(f.set, { maintenance: true });
  expect(first.checked).toBeLessThanOrEqual(200);
  expect(first.failed).toBe(100);
  expect(first.checked).toBeGreaterThan(100); // historical identities also got budget
  purgeLowerTierContent(f.set, { maintenance: true });
  const third = purgeLowerTierContent(f.set, { maintenance: true });
  expect(third.resumed).toBe(1);
  expect(f.ledger.getCurrent(x.identity)?.state).toBe('current');
  expect(f.stores.secure_local!.localContent(localId('mail'))?.chunks.join('')).toBe(body);
  expect(f.ledger.metaEntries('tier-move-verified:')).toHaveLength(205); // failed obligations retained
});
