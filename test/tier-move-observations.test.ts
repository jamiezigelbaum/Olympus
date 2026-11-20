import { afterEach, expect, test } from 'bun:test';
import { classifyContentTier, classifyItemTiers, type TierSniffer } from '../src/workers/classification/tier-classifier.ts';
import { moveTieredItem, moveTieredItemsLowering } from '../src/workers/connector-store/tier-move.ts';
import { TieredStoreSet } from '../src/workers/connector-store/tiered-store-set.ts';
import { CORPORA, FIXTURE_PLACEMENT, fixtureConnector, identityOf, localId, openTierFixture, tempDir } from './helpers/tier-fixtures.ts';

const cleanups: Array<() => void> = [];
afterEach(() => { for (const close of cleanups.splice(0)) close(); });
const identity = identityOf('orchard');
const body = 'Ordinary orchard notes.';
const target = { metadataTier: 'private', contentTier: 'private' } as const;

function lane(sniffer?: TierSniffer) {
  const tmp = tempDir();
  const fixture = openTierFixture(tmp.dir, { embed: false });
  const set = sniffer ? new TieredStoreSet({
    setId: 'observations',
    ledger: fixture.ledger,
    secretLocations: fixture.secrets,
    tierClassification: { sniffer },
    legs: (['internal', 'secure_local'] as const).map(trustDomain => ({
      trustDomain, corpusId: CORPORA[trustDomain], store: fixture.stores[trustDomain]!,
    })),
  }) : fixture.set;
  const sync = (name = 'Notes', text = body, version = 'v1') => set.sync(
    fixtureConnector(() => [{ id: 'orchard', name, text, version }]),
    { fetchContent: true, placement: FIXTURE_PLACEMENT },
  );
  cleanups.push(() => { fixture.close(); tmp.cleanup(); });
  return { ...fixture, set, sync };
}

function queuePersonal(f: ReturnType<typeof lane>) {
  const applied = f.ledger.applySnifferVerdict(identity, {
    pass: 'content', tier: 'private', reason: 'content:sniffer:observations:ordinary', modelId: 'observations',
  }, { placementFor: decision => f.set.placementFor(decision) });
  expect(applied?.outcome).toBe('queued_move');
  expect(applied?.record.state).toBe('moving');
  return applied!.record.generation;
}

test('a re-list with stricter names supersedes a queued Personal verdict for the same body', async () => {
  const f = lane({
    id: 'observations',
    judge: question => question.pass === 'metadata' && question.material?.includes('New names')
      ? { verdict: 'decided', tier: 'secure', code: 'private' }
      : { verdict: 'undecided' },
  });
  await f.sync();
  const generation = queuePersonal(f);
  await f.sync('New names SSN 123-45-6789', body, 'v2');
  expect(f.ledger.getCurrent(identity)).toMatchObject({ generation: generation + 1 });
  expect(f.ledger.getCurrent(identity)?.reasons).toContain('metadata:sniffer:observations:private');
  const [stale] = moveTieredItemsLowering([{ set: f.set, identity, target, expectedGeneration: generation }]);
  expect(stale).toHaveProperty('error');
  expect(f.stores.internal!.localContent(localId('orchard'))?.chunks ?? []).toEqual([]);
});

test('a content-only question supersedes a queued Personal verdict and preserves the held body', async () => {
  const sniffer = { id: 'observations', judge: () => ({ verdict: 'undecided' as const }) };
  const f = lane(sniffer);
  await f.sync();
  const generation = queuePersonal(f);
  const content = classifyContentTier({
    text: body, metadataTier: 'private', metadataForced: false, metadataFlagged: false, title: 'Notes',
  }, { sniffer });
  expect(content.contentPending).toBe(true);
  f.ledger.recordContentDecision(identity, content);
  expect(f.ledger.getCurrent(identity)).toMatchObject({ generation: generation + 1, state: 'pending', contentPending: true });
  const [stale] = moveTieredItemsLowering([{ set: f.set, identity, target, expectedGeneration: generation }]);
  expect(stale).toHaveProperty('error');
  expect(f.stores.internal!.localContent(localId('orchard'))?.chunks ?? []).toEqual([]);
  expect(f.stores.secure_local!.exportItemCopy(identity)?.chunks.map(c => c.boundedText).join('')).toBe(body);
});

test('an identical re-list leaves the queued move and its generation in place', async () => {
  let questions = 0;
  const f = lane({
    id: 'observations',
    judge: () => { questions += 1; return { verdict: 'undecided' }; },
  });
  await f.sync();
  const generation = queuePersonal(f);
  const queued = f.ledger.getCurrent(identity);
  const asked = questions;
  await f.sync();
  expect(questions).toBe(asked);
  expect(f.ledger.getCurrent(identity)).toEqual(queued);
  expect((await moveTieredItem({ set: f.set, identity, target, expectedGeneration: generation })).outcome).toBe('moved');
});

test('a store re-list sends its newer names decision to the queued mover', async () => {
  const sniffer: TierSniffer = {
    id: 'observations',
    judge: question => question.pass === 'metadata'
      ? { verdict: 'decided', tier: 'secure', code: 'private' }
      : { verdict: 'undecided' },
  };
  const f = lane(sniffer);
  await f.sync();
  const generation = queuePersonal(f);
  const connector = fixtureConnector(() => [{
    id: 'orchard', name: 'Updated SSN 123-45-6789', text: body, version: 'v2', legacyDomain: 'secure_local',
  }]);
  await f.stores.secure_local!.syncFromConnector(connector, {
    fetchContent: true, placement: FIXTURE_PLACEMENT, tierClassification: { sniffer },
  });
  expect(f.ledger.getCurrent(identity)).toMatchObject({
    generation: generation + 1, targetMetadataTier: 'secure', targetContentTier: 'secure',
  });
  expect(moveTieredItemsLowering([{ set: f.set, identity, target, expectedGeneration: generation }])[0]).toHaveProperty('error');
  expect(f.stores.internal!.localContent(localId('orchard'))?.chunks ?? []).toEqual([]);
});

test('a names-only re-list with new names reopens the content judgment before a queued lowering', async () => {
  const f = lane({ id: 'observations', judge: () => ({ verdict: 'undecided' }) });
  await f.sync();
  const generation = queuePersonal(f);
  await f.set.sync(fixtureConnector(() => [{ id: 'orchard', name: 'Updated notes', version: 'v2' }]),
    { fetchContent: false, placement: FIXTURE_PLACEMENT });
  expect(f.ledger.getCurrent(identity)).toMatchObject({ generation: generation + 1, state: 'pending', contentPending: true });
  expect(moveTieredItemsLowering([{ set: f.set, identity, target, expectedGeneration: generation }])[0]).toHaveProperty('error');
  expect(f.stores.internal!.localContent(localId('orchard'))?.chunks ?? []).toEqual([]);
});

test('a newer decision replaces a mixed placement while retaining both layers for the new move', async () => {
  const f = lane();
  await f.sync();
  const ordinary = classifyItemTiers({ signals: { title: 'Notes' }, text: body });
  const mixed = { ...ordinary, metadataTier: 'public', contentTier: 'secure' } as const;
  expect(f.ledger.recordRoutedPlacement(identity, mixed, f.set.placementFor(mixed)).outcome).toBe('queued_move');
  const generation = f.ledger.getCurrent(identity)!.generation;
  const next = { ...mixed, metadataTier: 'private' } as const;
  f.ledger.recordRoutedPlacement(identity, next, f.set.placementFor(next));
  expect(f.ledger.getCurrent(identity)).toMatchObject({
    generation: generation + 1, targetMetadataTier: 'private', targetContentTier: 'secure',
  });
  await moveTieredItem({ set: f.set, identity, target: next, expectedGeneration: generation + 1 });
  expect(f.ledger.copies(identity).filter(copy => copy.state === 'current')).toMatchObject([
    { corpusId: CORPORA.internal, layers: 'metadata' },
    { corpusId: CORPORA.secure_local, layers: 'content' },
  ]);
  expect(f.stores.secure_local!.localContent(localId('orchard'))?.chunks.join('')).toBe(body);
});

test('an edited body retains the queued upper floor until the new body can land', async () => {
  const f = lane();
  await f.sync();
  const ordinary = classifyItemTiers({ signals: { title: 'Notes' }, text: body });
  const mixed = { ...ordinary, metadataTier: 'public', contentTier: 'secure' } as const;
  f.ledger.recordRoutedPlacement(identity, mixed, f.set.placementFor(mixed));
  const generation = f.ledger.getCurrent(identity)!.generation;
  const editedBody = 'The orchard notes have changed.';
  await f.sync('Notes', editedBody, 'v2');
  expect(f.ledger.getCurrent(identity)).toMatchObject({
    generation: generation + 1, targetMetadataTier: 'private', targetContentTier: 'secure',
  });
  expect(f.stores.internal!.localContent(localId('orchard'))?.chunks ?? []).toEqual([]);
  expect(f.ledger.writeIntent(identity)).toMatchObject({ kind: 'content', version: 'v2' });
  await moveTieredItem({
    set: f.set, identity, target: { metadataTier: 'private', contentTier: 'secure' }, expectedGeneration: generation + 1,
  });
  expect(f.stores.secure_local!.localContent(localId('orchard'))?.chunks.join('')).toBe(body);
  await f.sync('Notes', editedBody, 'v2');
  expect(f.ledger.writeIntent(identity)).toBeUndefined();
  expect(f.stores.secure_local!.localContent(localId('orchard'))?.chunks.join('')).toBe(editedBody);
});

test('a stricter detector observation supersedes a queued raise from Public', () => {
  const f = lane();
  const personal = classifyItemTiers({ signals: { title: 'Notes' }, text: body });
  const first = { ...personal, metadataTier: 'public', contentTier: 'public' } as const;
  f.ledger.recordRoutedPlacement(identity, first, f.set.placementFor(first));
  const queued = f.ledger.recordRoutedPlacement(identity, personal, f.set.placementFor(personal));
  expect(queued.outcome).toBe('queued_move');
  const observed = { ...personal, contentTier: 'secure', decidedBy: 'sensitive_detector' } as const;
  f.ledger.recordRoutedPlacement(identity, observed, f.set.placementFor(observed));
  expect(f.ledger.getCurrent(identity)).toMatchObject({
    generation: queued.record.generation + 1, targetMetadataTier: 'private', targetContentTier: 'secure',
  });
});
