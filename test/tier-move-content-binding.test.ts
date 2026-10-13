import { afterEach, expect, test } from 'bun:test';
import { classifyItemTiers, type TierSniffer } from '../src/workers/classification/tier-classifier.ts';
import { moveTieredItem, TierMoveRefusedError } from '../src/workers/connector-store/tier-move.ts';
import { TieredStoreSet } from '../src/workers/connector-store/tiered-store-set.ts';
import { CORPORA, FIXTURE_PLACEMENT, fixtureConnector, identityOf, localId, openTierFixture, tempDir } from './helpers/tier-fixtures.ts';

const cleanups: Array<() => void> = [];
afterEach(() => { for (const close of cleanups.splice(0)) close(); });
const oldBody = 'Patient: Morgan Example\nGlucose 93 mg/dL. Oldprivatemarker.';
const newBody = 'Remember bananas and oranges. Newpersonalmarker.';
const identity = identityOf('edited');
const target = { metadataTier: 'private' as const, contentTier: 'private' as const };

function lane(sniffer?: TierSniffer) {
  const tmp = tempDir();
  const f = openTierFixture(tmp.dir, { embed: false });
  const set = new TieredStoreSet({
    setId: 'content-binding', ledger: f.ledger, secretLocations: f.secrets,
    ...(sniffer ? { tierClassification: { sniffer } } : {}),
    legs: ['internal', 'secure_local'].map(domain => ({
      trustDomain: domain as 'internal' | 'secure_local', corpusId: CORPORA[domain as 'internal' | 'secure_local'],
      store: f.stores[domain as 'internal' | 'secure_local']!,
    })),
  });
  const sync = (text: string) => set.sync(fixtureConnector(() => [{ id: 'edited', name: 'Notes', text, version: text === oldBody ? 'v1' : 'v2' }]),
    { fetchContent: true, placement: FIXTURE_PLACEMENT });
  cleanups.push(() => { f.close(); tmp.cleanup(); });
  return { ...f, set, sync };
}

test('a downward move refuses old Private chunks and a re-fetch can release only the newly judged body', async () => {
  const f = lane();
  await f.sync(oldBody);
  // Crash between recording the new verdict and storing the edited body.
  const decision = classifyItemTiers({ signals: { title: 'Notes' }, text: newBody });
  expect(f.ledger.recordRoutedPlacement(identity, decision, f.set.placementFor(decision)).outcome).toBe('queued_move');
  await expect(moveTieredItem({ set: f.set, identity, target })).rejects.toBeInstanceOf(TierMoveRefusedError);
  expect(f.stores.internal!.exportItemCopy(identity)?.chunks ?? []).toEqual([]);
  expect(f.stores.secure_local!.exportItemCopy(identity)?.chunks.map(c => c.boundedText).join('')).toBe(oldBody);
  await f.sync(newBody);
  await moveTieredItem({ set: f.set, identity, target });
  expect(f.stores.internal!.localContent(localId('edited'))?.chunks.join('')).toBe(newBody);
  expect(f.stores.internal!.searchItems('Oldprivatemarker', 10)).toEqual([]);
});

test('a sync lowering an edited item retains the judged new body for its downward move', async () => {
  const f = lane();
  await f.sync(oldBody);
  await f.sync(newBody);
  await moveTieredItem({ set: f.set, identity, target });
  expect(f.stores.internal!.localContent(localId('edited'))?.chunks.join('')).toBe(newBody);
  expect(f.stores.internal!.searchItems('Oldprivatemarker', 10)).toEqual([]);
});

test('a downward move with matching multi-chunk content proceeds', async () => {
  const f = lane();
  const text = `  ${'Ordinary orchard notes. '.repeat(800)}  `;
  await f.sync(text);
  await moveTieredItem({ set: f.set, identity, target: { metadataTier: 'secure', contentTier: 'secure' } });
  const decision = classifyItemTiers({ signals: { title: 'Notes' }, text });
  f.ledger.recordRoutedPlacement(identity, decision, f.set.placementFor(decision));
  const moved = await moveTieredItem({ set: f.set, identity, target });
  expect(moved.outcome).toBe('moved');
  expect(f.stores.internal!.localContent(localId('edited'))?.chunks.join('')).toBe(text.trim());
});

test('a background Personal verdict releases the edited held body, never the prior Private body', async () => {
  let answer: 'undecided' | 'private' = 'private';
  const f = lane({ id: 'binding-test', judge: () => answer === 'undecided'
    ? { verdict: 'undecided' } : { verdict: 'decided', tier: 'secure', code: 'private' } });
  await f.sync(oldBody);
  answer = 'undecided';
  await f.sync(newBody);
  expect(f.stores.internal!.localContent(localId('edited'))?.chunks ?? []).toEqual([]);
  expect(f.stores.secure_local!.exportItemCopy(identity)?.chunks.map(c => c.boundedText).join('')).toBe(newBody);
  const applied = f.ledger.applySnifferVerdict(identity, {
    pass: 'content', tier: 'private', reason: 'content:sniffer:binding-test:personal', modelId: 'binding-test',
  }, { placementFor: d => f.set.placementFor(d) });
  expect(applied?.outcome).toBe('queued_move');
  await moveTieredItem({ set: f.set, identity, target });
  expect(f.stores.internal!.localContent(localId('edited'))?.chunks.join('')).toBe(newBody);
});

test('a background Private verdict still hides first and moves upward even if stored content differs', async () => {
  // This scenario starts Personal-first with a persisted background question.
  const f = lane({ id: 'binding-test', judge: () => ({ verdict: 'undecided', queued: true }) });
  await f.sync(newBody);
  expect(f.stores.internal!.localContent(localId('edited'))?.chunks.join('')).toBe(newBody);
  const applied = f.ledger.applySnifferVerdict(identity, {
    pass: 'content', tier: 'secure', reason: 'content:sniffer:binding-test:private', modelId: 'binding-test',
  }, { placementFor: d => f.set.placementFor(d) });
  expect(applied?.outcome).toBe('queued_move');
  expect(f.stores.internal!.localContent(localId('edited'))?.chunks ?? []).toEqual([]);
  // Simulate a different stored snapshot without changing the verdict.
  const stored = f.stores.internal!.exportItemCopy(identity)!;
  f.stores.internal!.importItemCopy({ ...stored, chunks: stored.chunks.map(c => ({ ...c, boundedText: oldBody })) },
    { trustTier: 'S3', syncConnectorId: 'fixture-replay', layers: 'both' });
  expect((await moveTieredItem({ set: f.set, identity, target: { metadataTier: 'private', contentTier: 'secure' } })).raise).toBe(true);
  expect(f.stores.internal!.localContent(localId('edited'))?.chunks ?? []).toEqual([]);
  expect(f.stores.secure_local!.localContent(localId('edited'))?.chunks.join('')).toBe(oldBody);
});
