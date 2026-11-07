// Owner ruling 2026-10-28: only the user's own rules judge a group of items.
// Items stored Private because a connector or deployment once rested a whole
// source or chat there are re-judged on their own content automatically, with
// nobody's approval; an item the user's own rule holds is left alone.

import { afterEach, expect, test } from 'bun:test';
import type { SourceConnector } from '../src/core/contracts.ts';
import { TIER_CLASSIFIER_VERSION, type TierSniffer, type OwnerTierRule } from '../src/workers/classification/tier-classifier.ts';
import { rejudgeRoutedItems } from '../src/workers/connector-store/tier-rejudge.ts';
import { TieredStoreSet } from '../src/workers/connector-store/tiered-store-set.ts';
import { CORPORA, FIXTURE_PLACEMENT, fixtureConnector, identityOf, openTierFixture, tempDir } from './helpers/tier-fixtures.ts';

const personal: TierSniffer = { id: 'fixture-personal', judge: () => ({ verdict: 'decided', tier: 'private', code: 'ordinary:0.99' }) };
const cleanups: Array<() => void> = [];
afterEach(() => { for (const close of cleanups.splice(0)) close(); });

function lane(rules: OwnerTierRule[] = []) {
  const tmp = tempDir();
  const fixture = openTierFixture(tmp.dir, { embed: false });
  const set = new TieredStoreSet({ setId: 'retired-prior', ledger: fixture.ledger, secretLocations: fixture.secrets,
    tierClassification: { sniffer: personal, rules },
    legs: (['internal', 'secure_local'] as const).map(domain => ({ trustDomain: domain, corpusId: CORPORA[domain], store: fixture.stores[domain]! })),
  });
  cleanups.push(() => { fixture.close(); tmp.cleanup(); });
  return { ...fixture, set };
}

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
