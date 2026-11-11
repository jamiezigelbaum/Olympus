// Owner ruling 2026-10-28: only the user's own rules judge a group of items.
// Items stored Private because a connector or deployment once rested a whole
// source or chat there are re-judged on their own content automatically, with
// nobody's approval; an item the user's own rule holds is left alone.

import { afterEach, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { join } from 'node:path';
import type { SourceConnector } from '../src/core/contracts.ts';
import { NAMES_INPUT_REASON_PREFIX, TIER_CLASSIFIER_VERSION, type TierSniffer, type OwnerTierRule } from '../src/workers/classification/tier-classifier.ts';
import { rejudgeRoutedItems } from '../src/workers/connector-store/tier-rejudge.ts';
import { TieredStoreSet } from '../src/workers/connector-store/tiered-store-set.ts';
import { CachedTierSniffer } from '../src/workers/classification/sniffer.ts';
import { TierSnifferStore } from '../src/workers/classification/sniffer-store.ts';
import { BUILT_IN_SNIFFER_LANE } from '../src/workers/classification/built-in-sniffer.ts';
import { runSnifferPass } from '../src/workers/classification/sniffer-resolver.ts';
import { moveTieredItem } from '../src/workers/connector-store/tier-move.ts';
import { CORPORA, FIXTURE_PLACEMENT, fixtureConnector, identityOf, openTierFixture, tempDir } from './helpers/tier-fixtures.ts';

const personal: TierSniffer = { id: 'fixture-personal', judge: () => ({ verdict: 'decided', tier: 'private', code: 'ordinary:0.99' }) };
const cleanups: Array<() => void> = [];
afterEach(() => { for (const close of cleanups.splice(0)) close(); });

function lane(rules: OwnerTierRule[] = [], sniffer: TierSniffer = personal) {
  const tmp = tempDir();
  const fixture = openTierFixture(tmp.dir, { embed: false });
  const set = new TieredStoreSet({ setId: 'retired-prior', ledger: fixture.ledger, secretLocations: fixture.secrets,
    tierClassification: { sniffer, rules },
    legs: (['internal', 'secure_local'] as const).map(domain => ({ trustDomain: domain, corpusId: CORPORA[domain], store: fixture.stores[domain]! })),
  });
  cleanups.push(() => { fixture.close(); tmp.cleanup(); });
  return { ...fixture, set };
}

for (const scenario of [
  { name: 'queued names and content, Private answer', cachedNames: false, alreadyPersonal: false, tier: 'secure' },
  { name: 'queued names and content, Personal answer lowers the prior', cachedNames: false, alreadyPersonal: false, tier: 'private' },
  { name: 'cached Personal names and queued content on an already Personal prior row', cachedNames: true, alreadyPersonal: true, tier: 'private' },
] as const) test(`retired-prior rows are asked once: ${scenario.name}`, async () => {
  const tmp = tempDir();
  const queue = new TierSnifferStore({ dbPath: join(tmp.dir, 'sniffer.sqlite') });
  cleanups.push(() => { queue.close(); tmp.cleanup(); });
  const cached = new CachedTierSniffer(queue, BUILT_IN_SNIFFER_LANE);
  const requests: string[] = [];
  let delayed = false;
  const sniffer: TierSniffer = { id: cached.id, judge(request) {
    if (!delayed) return personal.judge(request);
    requests.push(`${request.subject?.providerItemId}:${request.pass}`);
    if (scenario.cachedNames && request.pass === 'metadata') return personal.judge(request);
    return cached.judge(request);
  } };
  const f = lane([], sniffer);
  const items = Array.from({ length: 6 }, (_, n) => ({ id: `item-${n}`, name: `Picnic ${n}`, text: `Bring bananas on Saturday ${n}.` }));
  await f.set.sync(restingPrivate(fixtureConnector(() => items), 'source_config:trust_domain:secure_local'),
    { fetchContent: true, placement: FIXTURE_PLACEMENT });
  if (scenario.alreadyPersonal) for (const item of items) {
    // The live rows retain the historical reason after a move to Personal.
    await moveTieredItem({ set: f.set, identity: identityOf(item.id), target: { metadataTier: 'private', contentTier: 'private' } });
  }
  delayed = true;
  for (let pass = 0; pass < 3; pass++) {
    expect(rejudgeRoutedItems({ set: f.set, autoMoves: true }).report).toMatchObject({
      seen: pass === 0 ? items.length : 0, asked: pass === 0 ? items.length : 0, failed: 0,
    });
  }
  expect(new Set(requests).size).toBe(requests.length);
  expect(requests.filter(request => request.endsWith(':metadata'))).toHaveLength(items.length);
  const db = new Database(f.ledger.dbPath);
  try {
    // #1078's counts-only shape: the old row has no stamp or names verdict
    // and neither pending flag, because the open question is kept beside it.
    expect(db.query(`SELECT count(*) AS n FROM tier_items WHERE rejudged_key IS NULL
      AND state = 'current' AND metadata_pending = 0 AND content_pending = 0
      AND instr(reasons_json, 'metadata:prior:source_') > 0
      AND instr(reasons_json, 'metadata:sniffer:') = 0
      AND instr(reasons_json, 'metadata:names_from_store') = 0`).get()).toEqual({ n: items.length });
    for (const item of items) {
      expect(f.ledger.rejudgeQuestion(identityOf(item.id))?.decision).toMatchObject({
        metadataPending: !scenario.cachedNames, contentPending: true,
      });
    }
  } finally { db.close(); }
  let calls = 0;
  const report = await runSnifferPass({ lane: BUILT_IN_SNIFFER_LANE,
    targets: [{ ledger: f.ledger, sniffer: queue, placementFor: f.set.placementFor.bind(f.set) }],
    model: { async complete() { calls++; return { text: JSON.stringify({ verdicts: [{ i: 1,
      tier: scenario.tier === 'secure' ? 'private' : 'personal', category: 'ordinary', confidence: 0.99,
      ownRecord: false, privateKind: 'none' }] }), modelId: 'fixture' }; } },
  });
  expect(report.verdictsApplied).toBeGreaterThanOrEqual(items.length);
  expect(calls).toBe(items.length * (!scenario.cachedNames && scenario.tier === 'private' ? 2 : 1));
  const settledDb = new Database(f.ledger.dbPath);
  try {
    for (const item of items) {
      const identity = identityOf(item.id);
      expect(f.ledger.getCurrent(identity)!.reasons.some(reason => reason.startsWith('metadata:prior:source_'))).toBe(false);
      expect(f.ledger.rejudgeQuestion(identity)).toBeUndefined();
      if (f.ledger.getCurrent(identity)!.state === 'moving') {
        await moveTieredItem({ set: f.set, identity, target: { metadataTier: scenario.tier, contentTier: scenario.tier } });
      }
      expect(f.ledger.getCurrent(identity)).toMatchObject({ state: 'current', metadataTier: scenario.tier, contentTier: scenario.tier });
    }
    expect(settledDb.query('SELECT count(*) AS n FROM tier_items WHERE rejudged_key IS NULL').get()).toEqual({ n: 0 });
  } finally { settledDb.close(); }
  expect(queue.counts().questions).toBe(0);
  expect(rejudgeRoutedItems({ set: f.set, autoMoves: true }).report.seen).toBe(0);
});

/** The connector as builds before 2026-10-28 published it: every item rests Private by source. */
function restingPrivate(inner: SourceConnector, basis: string): SourceConnector {
  return { ...inner, classificationSignals: (item) => ({ ...inner.classificationSignals!(item), prior: { tier: 'secure', strength: 'prior', basis } }) };
}

for (const basis of ['source_config:trust_domain:secure_local', 'source_default:trust_domain:secure_local']) {
  test(`an item stored Private by a retired ${basis.split(':')[0]} prior is re-judged on its content without approval`, async () => {
    const f = lane();
    const specs = () => [{ id: 'chat', name: 'Tiago', text: 'See you at the café at seven.' }];
    await f.set.sync(restingPrivate(fixtureConnector(specs), basis), { fetchContent: true, placement: FIXTURE_PLACEMENT });
    const before = f.ledger.getCurrent(identityOf('chat'))!;
    expect(before.contentTier).toBe('secure');
    expect(before.reasons).toContain(`metadata:prior:${basis}`);

    const key = { engineVersion: TIER_CLASSIFIER_VERSION, snifferId: personal.id, limit: 10 };
    expect(f.ledger.rejudgeCandidatePage(key).records.map(row => row.providerItemId)).toEqual(['chat']);
    expect(rejudgeRoutedItems({ set: f.set, autoMoves: true }).report).toMatchObject({ movesQueued: 1, failed: 0 });

    const after = f.ledger.getCurrent(identityOf('chat'))!;
    // Judged Personal: its move down to the Personal store is queued, and runs
    // with the other automatic moves.
    expect(after).toMatchObject({ state: 'moving', targetMetadataTier: 'private', targetContentTier: 'private' });
    expect(after.reasons.some(reason => reason.startsWith('metadata:prior:'))).toBe(false);
    // Judged once: the next pass does not pick it up again.
    expect(f.ledger.rejudgeCandidatePage(key).records).toEqual([]);
  });
}

test('an owner re-check still drops a retired source prior on a row with no names-input receipt (#1114)', async () => {
  const f = lane();
  const basis = 'source_config:trust_domain:secure_local';
  await f.set.sync(restingPrivate(fixtureConnector(() => [{ id: 'chat', name: 'Tiago', text: 'See you at the café at seven.' }]), basis),
    { fetchContent: true, placement: FIXTURE_PLACEMENT });
  const identity = identityOf('chat');
  const before = f.ledger.getCurrent(identity)!;
  // A legacy row: written before names-input receipts existed.
  f.ledger.recordRoutedPlacement(identity, { ...before, reasons: before.reasons.filter(reason => !reason.startsWith(NAMES_INPUT_REASON_PREFIX)) },
    f.set.placementFor(before));
  expect(f.ledger.requestRecheck({ conversationKey: '' }).items).toBeGreaterThan(0);
  expect(rejudgeRoutedItems({ set: f.set, autoMoves: true }).report).toMatchObject({ failed: 0 });
  const after = f.ledger.getCurrent(identity)!;
  expect(after).toMatchObject({ state: 'moving', targetMetadataTier: 'private', targetContentTier: 'private' });
  expect(after.reasons.some(reason => reason.startsWith('metadata:prior:'))).toBe(false);
});

test('an item the user\'s own rule holds Private is not re-judged', async () => {
  const f = lane([{ id: 'owner.folder', match: { kind: 'pathPrefix', value: '/Files/' }, tier: 'secure', strength: 'prior' }]);
  const specs = () => [{ id: 'kept', name: 'Ana Ribeiro', text: 'Draft parenting plan attached.' }];
  await f.set.sync(fixtureConnector(specs), { fetchContent: true, placement: FIXTURE_PLACEMENT });
  const record = f.ledger.getCurrent(identityOf('kept'))!;
  expect(record.contentTier).toBe('secure');
  expect(record.reasons.some(reason => reason.startsWith('metadata:owner_rule:'))).toBe(true);
  expect(record.reasons.some(reason => reason.startsWith('metadata:prior:'))).toBe(false);
  const key = { engineVersion: TIER_CLASSIFIER_VERSION, snifferId: personal.id, limit: 10 };
  expect(f.ledger.rejudgeCandidatePage(key).records).toEqual([]);
});

for (const stamped of [false, true]) test(`upgrade automatically re-judges and moves a retired source-prior item (previous re-judge stamp=${stamped})`, async () => {
  const f = lane();
  const identity = identityOf('upgrade');
  await f.set.sync(restingPrivate(fixtureConnector(() => [{ id: 'upgrade', name: 'Picnic notes', text: 'Bring bananas on Saturday.' }]),
    'source_config:trust_domain:secure_local'), { fetchContent: true, placement: FIXTURE_PLACEMENT });
  expect(f.ledger.getCurrent(identity)).toMatchObject({ decidedBy: 'source_prior', contentTier: 'secure' });
  const key = { engineVersion: TIER_CLASSIFIER_VERSION, snifferId: personal.id };
  // A prior replayed after #606 may have inherited the plain stamp of an
  // earlier re-judge that settled a different decision of the row.
  if (stamped) {
    (f.ledger as unknown as { db: { query(sql: string): { run(...args: unknown[]): void } } }).db
      .query('UPDATE tier_items SET rejudged_key = ?').run(`${key.engineVersion}\u0000${key.snifferId}`);
  }
  expect(f.ledger.rejudgeCandidatePage(key).records).toHaveLength(1);
  const { InstalledTierClassification } = await import('../src/workers/classification/installed-tier-classification.ts');
  const { BUILT_IN_SNIFFER_LANE } = await import('../src/workers/classification/built-in-sniffer.ts');
  const { TierSnifferService } = await import('../src/workers/classification/sniffer-service.ts');
  const { join } = await import('node:path');
  const installed = new InstalledTierClassification({ env: {} });
  const service = new TierSnifferService({ installed, lane: BUILT_IN_SNIFFER_LANE,
    model: { async complete() { throw new Error('the cached Personal verdict suffices'); } },
    stores: () => f.set.openStores(), classificationLedgerPath: join(f.dir, 'classification.jsonl'), autoApproveBuiltIn: true,
    autoMoves: { localEmbeddingsOnly: () => true, embeddingLedgerPath: join(f.dir, 'embedding.jsonl') },
  });
  try {
    expect(await service.runOnce()).toMatchObject({ state: 'ran', rejudged: { causeRetiredPrior: 1, failed: 0 }, autoMoves: { moved: 1, failed: 0 } });
    expect(f.ledger.getCurrent(identity)).toMatchObject({ state: 'current', metadataTier: 'private', contentTier: 'private' });
    expect(f.stores.internal!.localContent('personal:upgrade')?.chunks.join(' ')).toBe('Bring bananas on Saturday.');
    expect(f.stores.secure_local!.localContent('personal:upgrade')).toBeUndefined();
    expect(f.ledger.rejudgeCandidatePage(key).records).toEqual([]);
    expect(f.ledger.getCurrent(identity)!.reasons.some(reason => reason.startsWith('metadata:prior:'))).toBe(false);
  } finally { service.stop(); installed.close(); }
});

test('a retired source-prior item a re-judge could not re-read stays settled until its decision changes', async () => {
  const f = lane();
  const identity = identityOf('no-text');
  await f.set.sync(restingPrivate(fixtureConnector(() => [{ id: 'no-text', name: 'Picnic notes', text: 'Bring bananas on Saturday.' }]),
    'source_config:trust_domain:secure_local'), { fetchContent: true, placement: FIXTURE_PLACEMENT });
  const key = { engineVersion: TIER_CLASSIFIER_VERSION, snifferId: personal.id };
  expect(f.ledger.rejudgeCandidatePage(key).records).toHaveLength(1);
  // The no-text branch stamps the row without changing its prior reason.
  f.ledger.markRejudged(identity, key);
  expect(f.ledger.getCurrent(identity)!.reasons.some(reason => reason.startsWith('metadata:prior:source_'))).toBe(true);
  expect(f.ledger.rejudgeCandidatePage(key).records).toEqual([]);
  // A replayed prior is a new decision of the row and is re-judged again.
  (f.ledger as unknown as { db: { query(sql: string): { run(...args: unknown[]): void } } }).db
    .query("UPDATE tier_items SET decided_at = decided_at || 'x'").run();
  expect(f.ledger.rejudgeCandidatePage(key).records).toHaveLength(1);
});
