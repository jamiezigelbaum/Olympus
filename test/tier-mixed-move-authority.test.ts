import { afterEach, expect, test } from 'bun:test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { clearInstalledTierClassification, configureInstalledTierClassification } from '../src/workers/classification/installed-tier-classification.ts';
import { classifyItemTiers } from '../src/workers/classification/tier-classifier.ts';
import { tierLedgerIdentityKey } from '../src/workers/classification/tier-ledger.ts';
import { writeOwnerTierRules } from '../src/workers/classification/tier-rules.ts';
import { purgeLowerTierContent } from '../src/workers/connector-store/tier-content-purge.ts';
import { moveTieredItem, moveTieredItemsLowering, retireRestoredTierLowerings, TierMoveContentChangedError } from '../src/workers/connector-store/tier-move.ts';
import { CORPORA, FIXTURE_PLACEMENT, JUDGED_PERSONAL_SNIFFER, fixtureConnector, identityOf, localId, openTierFixture, tempDir } from './helpers/tier-fixtures.ts';

const cleanup: Array<() => void> = [];
afterEach(() => {
  clearInstalledTierClassification();
  for (const close of cleanup.splice(0).reverse()) close();
});

for (const checkpoint of ['before copy', 'after reopening a verified receipt', 'after reopening a receipt from the previous move format'] as const) {
  test(`a mixed move retains its raising layer when names cannot move ${checkpoint}`, async () => {
    const tmp = tempDir();
    const env = { OLYMPUS_TIER_RULES_PATH: join(tmp.dir, 'tier-rules.json') };
    let fixture = openTierFixture(tmp.dir, { embed: false });
    cleanup.push(() => { fixture.close(); tmp.cleanup(); });
    const identity = identityOf('orchard');
    const body = 'Orchard inventory and planting notes.';
    const target = { metadataTier: 'public', contentTier: 'secure' } as const;
    const decision = { ...classifyItemTiers({ signals: { title: 'Inventory' }, text: body }), ...target };
    await fixture.set.sync(fixtureConnector(() => [{ id: identity.providerItemId, name: 'Inventory', text: body }]),
      { fetchContent: true, placement: FIXTURE_PLACEMENT });
    expect(fixture.ledger.copies(identity).filter(copy => copy.state === 'current')).toMatchObject([
      { corpusId: CORPORA.internal, layers: 'both' },
    ]);
    configureInstalledTierClassification({ env });
    expect(fixture.ledger.recordRoutedPlacement(identity, decision, fixture.set.placementFor(decision)).outcome).toBe('queued_move');
    const generation = fixture.ledger.getCurrent(identity)!.generation;

    if (checkpoint !== 'before copy') {
      await expect(moveTieredItem({
        set: fixture.set, identity, target, expectedGeneration: generation,
        afterVerified() { throw new Error('checkpoint'); },
      })).rejects.toThrow('checkpoint');
      expect(fixture.stores.public_safe?.exportItemCopy(identity)).toBeDefined();
      if (checkpoint === 'after reopening a receipt from the previous move format') {
        const key = tierLedgerIdentityKey(identity);
        const receiptKey = `tier-move-verified:${key}`;
        const { ruleRevision: _revision, sourceFingerprints: _fingerprints, ...old } = JSON.parse(fixture.ledger.readMeta(receiptKey)!);
        fixture.ledger.writeMeta(receiptKey, JSON.stringify(old));
        fixture.ledger.writeMeta(`tier-move-imports:${key}`, '');
        fixture.stores.internal!.stripCopyContent(identity, { keepMetadata: true });
      }
      fixture.close();
    }
    writeOwnerTierRules([{
      id: 'inventory', source: identity.provider, match: { kind: 'pathPrefix', value: '/Files' },
      tier: 'private', strength: 'force',
    }], { env });
    if (checkpoint !== 'before copy') {
      fixture = openTierFixture(tmp.dir, { embed: false });
      purgeLowerTierContent(fixture.set);
    } else {
      await expect(moveTieredItem({ set: fixture.set, identity, target, expectedGeneration: generation })).rejects.toThrow();
    }

    const retained = { metadataTier: 'private', contentTier: 'secure' } as const;
    expect(fixture.ledger.getCurrent(identity)).toMatchObject({
      generation: generation + 1, state: 'moving', targetMetadataTier: retained.metadataTier, targetContentTier: retained.contentTier,
    });
    await moveTieredItem({ set: fixture.set, identity, target: retained, expectedGeneration: generation + 1 });
    expect(fixture.ledger.copies(identity).filter(copy => copy.state === 'current')).toMatchObject([
      { corpusId: CORPORA.internal, layers: 'metadata' },
      { corpusId: CORPORA.secure_local, layers: 'content' },
    ]);
    expect(fixture.stores.secure_local!.localContent(localId('orchard'))?.chunks.join('')).toBe(body);
    expect(fixture.stores.internal!.exportItemCopy(identity)?.chunks).toEqual([]);
    expect(fixture.stores.public_safe?.exportItemCopy(identity)).toBeUndefined();
  });
}

for (const phase of ['before staging', 'beforeCopy', 'beforeFlip'] as const) {
  test(`unresolved owner policy preserves a mixed move's body raise ${phase}`, async () => {
    const tmp = tempDir();
    const fixture = openTierFixture(tmp.dir, { embed: false });
    cleanup.push(() => { fixture.close(); tmp.cleanup(); });
    const identity = identityOf('orchard');
    const text = 'Orchard inventory and planting notes.';
    const target = { metadataTier: 'public', contentTier: 'secure' } as const;
    const decision = { ...classifyItemTiers({ signals: { title: 'Inventory' }, text }), ...target };
    await fixture.set.sync(fixtureConnector(() => [{ id: identity.providerItemId, name: 'Inventory', text }]),
      { fetchContent: true, placement: FIXTURE_PLACEMENT });
    const path = join(tmp.dir, 'tier-rules.json');
    configureInstalledTierClassification({ env: { OLYMPUS_TIER_RULES_PATH: path } });
    const makePolicyUnavailable = () => writeFileSync(path, '{');
    if (phase === 'before staging') makePolicyUnavailable();
    expect(fixture.ledger.recordRoutedPlacement(identity, decision, fixture.set.placementFor(decision)).outcome).toBe('queued_move');
    const generation = fixture.ledger.getCurrent(identity)!.generation;

    await expect(moveTieredItem({ set: fixture.set, identity, target, expectedGeneration: generation,
      ...(phase === 'before staging' ? {} : { [phase]: makePolicyUnavailable }),
    })).rejects.toMatchObject({ code: 'rule_policy_unavailable' });

    const retained = { metadataTier: 'private', contentTier: 'secure' } as const;
    expect(fixture.ledger.getCurrent(identity)).toMatchObject({
      generation: generation + 1, state: 'moving', targetMetadataTier: retained.metadataTier, targetContentTier: retained.contentTier,
    });
    await moveTieredItem({ set: fixture.set, identity, target: retained, expectedGeneration: generation + 1 });
    expect(fixture.ledger.copies(identity).filter(copy => copy.state === 'current')).toMatchObject([
      { corpusId: CORPORA.internal, layers: 'metadata' },
      { corpusId: CORPORA.secure_local, layers: 'content' },
    ]);
    expect(fixture.stores.secure_local!.localContent(localId('orchard'))?.chunks.join('')).toBe(text);
    expect(fixture.stores.internal!.exportItemCopy(identity)?.chunks).toEqual([]);
    expect(fixture.stores.public_safe?.exportItemCopy(identity)).toBeUndefined();
  });
}

test('a previously abandoned import is discarded when its policy no longer permits the placement', async () => {
  const tmp = tempDir();
  const fixture = openTierFixture(tmp.dir, { embed: false });
  cleanup.push(() => { fixture.close(); tmp.cleanup(); });
  const env = { OLYMPUS_TIER_RULES_PATH: join(tmp.dir, 'tier-rules.json') };
  const identity = identityOf('orchard');
  const text = 'Orchard inventory and planting notes.';
  const target = classifyItemTiers({ signals: { title: 'Inventory' }, text }, { sniffer: JUDGED_PERSONAL_SNIFFER });
  await fixture.set.sync(fixtureConnector(() => [{ id: identity.providerItemId, name: 'Inventory', text }]),
    { fetchContent: true, placement: FIXTURE_PLACEMENT });
  await moveTieredItem({
    set: fixture.set, identity, target: { metadataTier: 'secure', contentTier: 'secure' },
  });
  expect(purgeLowerTierContent(fixture.set, { maintenance: true }).complete).toBe(true);
  fixture.ledger.recordRoutedPlacement(identity, target, fixture.set.placementFor(target));
  const generation = fixture.ledger.getCurrent(identity)!.generation;
  await expect(moveTieredItem({
    set: fixture.set, identity, target, afterVerified() { throw new Error('checkpoint'); },
  })).rejects.toThrow('checkpoint');
  fixture.ledger.abandonMove(identity, { expectedGeneration: generation });
  expect(fixture.stores.internal!.exportItemCopy(identity)?.chunks.map(chunk => chunk.boundedText).join('')).toBe(text);
  expect(purgeLowerTierContent(fixture.set, { maintenance: true }).resumed).toBe(0);

  configureInstalledTierClassification({ env });
  writeOwnerTierRules([{
    id: 'inventory', source: identity.provider, match: { kind: 'pathPrefix', value: '/Files' },
    tier: 'secure', strength: 'force',
  }], { env });
  purgeLowerTierContent(fixture.set, { maintenance: true });

  expect(fixture.stores.internal!.exportItemCopy(identity)).toBeUndefined();
  expect(fixture.stores.secure_local!.localContent(localId('orchard'))?.chunks.join('')).toBe(text);
});

test('a source edit discards staged bytes after an interruption before the receipt commit', async () => {
  const tmp = tempDir();
  const fixture = openTierFixture(tmp.dir, { embed: false });
  cleanup.push(() => { fixture.close(); tmp.cleanup(); });
  const identity = identityOf('orchard');
  const text = 'Orchard inventory and planting notes.';
  const edited = 'Updated orchard inventory.';
  const target = classifyItemTiers({ signals: { title: 'Inventory' }, text }, { sniffer: JUDGED_PERSONAL_SNIFFER });
  await fixture.set.sync(fixtureConnector(() => [{ id: identity.providerItemId, name: 'Inventory', text }]),
    { fetchContent: true, placement: FIXTURE_PLACEMENT });
  await moveTieredItem({
    set: fixture.set, identity, target: { metadataTier: 'secure', contentTier: 'secure' },
  });
  fixture.ledger.recordRoutedPlacement(identity, target, fixture.set.placementFor(target));
  const move = { set: fixture.set, identity, target };
  expect(() => moveTieredItemsLowering([move], {
    afterCopiesCommitted() { throw new Error('checkpoint'); },
  })).toThrow('checkpoint');
  expect(fixture.ledger.metaEntries('tier-move-verified:')).toHaveLength(0);
  expect(fixture.stores.internal!.exportItemCopy(identity)?.chunks.map(chunk => chunk.boundedText).join('')).toBe(text);
  const source = fixture.stores.secure_local!;
  const stillHeld = source.exportItemCopy(identity)!;
  source.importItemCopy({ ...stillHeld, chunks: stillHeld.chunks.map(chunk => ({ ...chunk, boundedText: edited })) },
    { trustTier: 'S4', syncConnectorId: 'fixture-copy', layers: 'both' });

  const [refused] = moveTieredItemsLowering([move]);
  expect(refused).toEqual({ error: expect.any(TierMoveContentChangedError) });
  expect(fixture.stores.internal!.exportItemCopy(identity)).toBeUndefined();
  expect(source.localContent(localId('orchard'))?.chunks.join('')).toBe(edited);
});

test('a source-unspecified label rule permits lowerings in a lane without label resolution', async () => {
  const tmp = tempDir();
  const fixture = openTierFixture(tmp.dir, { embed: false });
  cleanup.push(() => { fixture.close(); tmp.cleanup(); });
  const identity = identityOf('orchard');
  const text = 'Orchard inventory and planting notes.';
  await fixture.set.sync(fixtureConnector(() => [{ id: identity.providerItemId, name: 'Inventory', text }]),
    { fetchContent: true, placement: FIXTURE_PLACEMENT });
  await moveTieredItem({ set: fixture.set, identity, target: { metadataTier: 'secure', contentTier: 'secure' } });
  const env = { OLYMPUS_TIER_RULES_PATH: join(tmp.dir, 'tier-rules.json') };
  configureInstalledTierClassification({ env });
  writeOwnerTierRules([{ id: 'private-label', match: { kind: 'label', value: 'private' }, tier: 'secure', strength: 'force' }], { env });
  const target = classifyItemTiers({ signals: { title: 'Inventory' }, text }, { sniffer: JUDGED_PERSONAL_SNIFFER });
  fixture.ledger.recordRoutedPlacement(identity, target, fixture.set.placementFor(target));

  expect(moveTieredItemsLowering([{ set: fixture.set, identity, target }])[0]).toHaveProperty('result');
  expect(fixture.stores.internal!.localContent(localId('orchard'))?.chunks.join('')).toBe(text);
});

test('restore of a verified mixed move retires the names lowering and retains the only copy of the raised body', async () => {
  const tmp = tempDir();
  const fixture = openTierFixture(tmp.dir, { embed: false });
  cleanup.push(() => { fixture.close(); tmp.cleanup(); });
  const identity = identityOf('orchard');
  const text = 'Orchard inventory and planting notes.';
  const target = { metadataTier: 'public', contentTier: 'secure' } as const;
  await fixture.set.sync(fixtureConnector(() => [{ id: identity.providerItemId, name: 'Inventory', text }]),
    { fetchContent: true, placement: FIXTURE_PLACEMENT });
  const decision = { ...classifyItemTiers({ signals: { title: 'Inventory' }, text }), ...target };
  fixture.ledger.recordRoutedPlacement(identity, decision, fixture.set.placementFor(decision));
  await expect(moveTieredItem({ set: fixture.set, identity, target, afterVerified() { throw new Error('checkpoint'); } }))
    .rejects.toThrow('checkpoint');
  const key = tierLedgerIdentityKey(identity);
  const receiptKey = `tier-move-verified:${key}`;
  const { ruleRevision: _revision, sourceFingerprints: _fingerprints, ...legacy } = JSON.parse(fixture.ledger.readMeta(receiptKey)!);
  fixture.ledger.writeMeta(receiptKey, JSON.stringify(legacy));
  fixture.ledger.writeMeta(`tier-move-imports:${key}`, '');
  fixture.stores.internal!.stripCopyContent(identity, { keepMetadata: true });

  retireRestoredTierLowerings(fixture.set);

  expect(fixture.ledger.readMeta(receiptKey)).toBeFalsy();
  expect(fixture.stores.public_safe?.exportItemCopy(identity)).toBeUndefined();
  const retained = { metadataTier: 'private', contentTier: 'secure' } as const;
  expect(fixture.ledger.getCurrent(identity)).toMatchObject({ state: 'moving', targetMetadataTier: 'private', targetContentTier: 'secure' });
  await moveTieredItem({ set: fixture.set, identity, target: retained });
  expect(fixture.stores.secure_local!.localContent(localId('orchard'))?.chunks.join('')).toBe(text);
});
