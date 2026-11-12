import { AsyncResource } from 'node:async_hooks';
import { Database } from 'bun:sqlite';
import { afterEach, expect, test } from 'bun:test';
import { classifyItemTiers } from '../src/workers/classification/tier-classifier.ts';
import { identityOf, openTierFixture, tempDir, type TierFixture } from './helpers/tier-fixtures.ts';
import { createReleaseTierCheck, createTierVisibilityGate } from '../src/workers/connector-store/tier-visibility.ts';
import { setReadPoolObserverForTests } from '../src/workers/connector-store/off-thread-reads.ts';
import { createSourceAnswerTrace, runWithSourceAnswerTrace, snapshotSourceAnswerTrace } from '../src/workers/source-index/answer-latency-trace.ts';
import type { SourceIndexRoutedSearchHit } from '../src/core/source-index/router.ts';
import type { ReleaseInput } from '../src/core/release-manifest.ts';

let fixture: TierFixture | undefined;
let cleanup: (() => void) | undefined;
afterEach(() => {
  setReadPoolObserverForTests();
  fixture?.close();
  cleanup?.();
  fixture = undefined;
  cleanup = undefined;
});

// This covers the cold Ask trigger as well as its cross-store gate and final
// release. Count SQL instead of timing a fast CI machine's tiny statements.
test('a cold Ask pools child and release reads and reuses unchanged identities', async () => {
  const temp = tempDir('olympus-ask-visibility-');
  cleanup = temp.cleanup;
  const f = openTierFixture(temp.dir, { embed: false });
  fixture = f;
  // Finish startup cleanup before adding deliberately orphaned fixture rows.
  await f.set.sweepOrphanedChildren();
  await f.set.repairLowerContent();
  const store = f.stores.secure_local!;
  const db = (store as any).db as Database;
  const decision = { ...classifyItemTiers({ signals: { title: 'Note' }, text: 'An orchard note' }), metadataTier: 'secure' as const, contentTier: 'secure' as const };
  db.transaction(() => {
    db.query(`INSERT INTO sync_runs (sync_run_id, corpus_id, connector_id, status, started_at) VALUES ('seed', ?, 'seed', 'completed', '2026-11-11')`).run(store.corpusId);
    for (const [id, parent] of [['parent-0', null], ['child-0', identityOf('parent-0').localItemId], ['orphan-0', identityOf('missing-parent-0').localItemId]] as const) {
      db.query(`INSERT INTO items (family, provider, account_scope, provider_item_id, local_item_id,
        mime_type, fetched_at, indexed_at, trust_tier, sync_run_id, parent_local_item_id)
        VALUES ('file', 'fixture', 'personal', ?, ?, 'text/plain', '2026-11-11', '2026-11-11', 'S4', 'seed', ?)`).run(id, identityOf(id).localItemId, parent);
    }
  })();
  (f.ledger as any).db.transaction(() => {
    for (const id of ['parent-0', 'child-0', 'orphan-0']) f.ledger.recordRoutedPlacement(identityOf(id), decision, f.set.placementFor(decision));
  })();
  // Clone valid fixture rows in SQL: the population should exercise many
  // visibility batches without spending the test on ingest bookkeeping.
  const ledgerDb = new Database(f.ledger.dbPath);
  const clone = (target: Database, table: string, id: string) => {
    const columns = (target.query(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(row => row.name).filter(name => name !== 'item_pk');
    const expression = columns.map(name => name === 'provider_item_id' ? "?1 || n"
      : name === 'local_item_id' ? "'personal:' || ?1 || n"
      : name === 'parent_local_item_id' ? "CASE WHEN t.parent_local_item_id IS NULL THEN NULL ELSE 'personal:parent-' || n END"
      : `t.${name}`).join(', ');
    target.query(`WITH RECURSIVE seq(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM seq WHERE n < 649)
      INSERT INTO ${table} (${columns.join(', ')}) SELECT ${expression} FROM seq CROSS JOIN ${table} t WHERE t.provider_item_id = ?2`).run(id.replace(/0$/, ''), id);
  };
  try {
    db.transaction(() => { clone(db, 'items', 'parent-0'); clone(db, 'items', 'child-0'); })();
    ledgerDb.transaction(() => {
      for (const table of ['tier_items', 'tier_copies']) { clone(ledgerDb, table, 'parent-0'); clone(ledgerDb, table, 'child-0'); }
    })();
  } finally { ledgerDb.close(); }
  const orphanPks = (db.query("SELECT item_pk FROM items WHERE provider_item_id = 'orphan-0'").all() as Array<{ item_pk: number }>).map(row => row.item_pk);
  const scopes = () => [{ ledger: f.ledger, corpusIds: new Set(f.set.openStores().map(s => s.corpusId)), stores: () => f.set.openStores() }];
  const gate = createTierVisibilityGate(scopes);
  const check = createReleaseTierCheck(scopes, () => 'allow');
  const identities = [...Array.from({ length: 650 }, (_, n) => identityOf(`child-${n}`)), identityOf('orphan-0')];
  const hits: SourceIndexRoutedSearchHit[] = identities.map(sourceItem => ({
    corpusId: store.corpusId, sourceItem, provenance: { sourceItem }, trustDomain: store.trustDomain, rawExposed: false,
  }));
  const inputs: ReleaseInput[] = identities.map(identity => ({ ...identity, corpusId: store.corpusId, privateAtAnswer: true }));
  const pooled: string[] = [];
  setReadPoolObserverForTests((_path, read) => pooled.push(read.sql), { snapshots: true });
  const trace = createSourceAnswerTrace();
  // Owner writes race with the Ask, but their SQL is not the Ask's work.
  const deleteParent = AsyncResource.bind(() => db.query('UPDATE items SET tombstoned = 1 WHERE provider_item_id = ?').run('parent-0'));
  const moveChild = AsyncResource.bind(() => f.ledger.beginMove(identityOf('child-1'), { metadataTier: 'secrets', contentTier: 'secrets' }, f.ledger.getCurrent(identityOf('child-1'))!.generation));
  await runWithSourceAnswerTrace(trace, async () => {
    // Exactly the first-Ask path: vector availability starts the cold hidden
    // set refresh even though this fixture has no vectors yet.
    store.vectorLaneServable('not-yet-embedded');
    await (store as any).tierHiddenCountsRefresh;
    expect([...(store as any).tierHiddenCountsMemo.value.hidden].sort((a: number, b: number) => a - b)).toEqual(orphanPks);
    const visible = await gate.offThread!(hits);
    expect(visible).toHaveLength(650);
    const verdicts = await (check.inputsOffThread?.(inputs) ?? check.inputs(inputs));
    expect(verdicts.slice(0, 650).every(verdict => !verdict.gone)).toBe(true);
    expect(verdicts[650]).toMatchObject({ gone: true, hiddenByParent: true });
    const statesRead = pooled.filter(sql => sql.includes('SELECT * FROM tier_items')).length;
    await (check.inputsOffThread?.([...inputs, ...inputs]) ?? check.inputs([...inputs, ...inputs]));
    expect(pooled.filter(sql => sql.includes('SELECT * FROM tier_items'))).toHaveLength(statesRead);

    // Reuse is bounded by changes, even within this one Ask. A deletion after
    // the first check cannot inherit its parent's earlier visible standing.
    deleteParent();
    const afterDelete = await (check.inputsOffThread?.([inputs[0]!]) ?? check.inputs([inputs[0]!]));
    expect(afterDelete[0]).toMatchObject({ gone: true, hiddenByParent: true });
    moveChild();
    const afterMove = await (check.inputsOffThread?.([inputs[1]!]) ?? check.inputs([inputs[1]!]));
    expect(afterMove[0]!.tier).toBe('secret');
  });
  const sql = snapshotSourceAnswerTrace(trace).mainThreadSql;
  console.info(`cold Ask main_thread_sql: statements=${sql.statements} total_ms=${sql.total_ms} max_ms=${sql.max_ms}`);
  expect(sql.statements).toBeLessThanOrEqual(400);
  expect(pooled.some(sql => sql.includes('SELECT * FROM tier_items'))).toBe(true);
  expect(pooled.some(sql => sql.includes('FROM items WHERE local_item_id'))).toBe(true);
  expect(pooled.some(sql => sql.includes('MIN(provider_item_id) AS child_item_id'))).toBe(true);
});
