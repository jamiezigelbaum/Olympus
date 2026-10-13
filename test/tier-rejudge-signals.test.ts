import { afterEach, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { join } from 'node:path';
import { InstalledTierClassification } from '../src/workers/classification/installed-tier-classification.ts';
import { BUILT_IN_SNIFFER_LANE } from '../src/workers/classification/built-in-sniffer.ts';
import { TierSnifferService } from '../src/workers/classification/sniffer-service.ts';
import { classifyItemTiers, tierSnifferInputHash, type TierSnifferRequest } from '../src/workers/classification/tier-classifier.ts';
import { emptyTierRejudgeReport, rejudgeStoredContent, settleRoutedSecrets, settleLegacySecrets } from '../src/workers/connector-store/tier-rejudge.ts';
import { moveTieredItem } from '../src/workers/connector-store/tier-move.ts';
import { FIXTURE_PLACEMENT, fixtureConnector, identityOf, localId, openTierFixture, tempDir } from './helpers/tier-fixtures.ts';

const cleanup: Array<() => void> = [];
afterEach(() => { for (const close of cleanup.splice(0)) close(); });
const identity = identityOf('record');
const text = 'Ordinary orchard notes.';

for (const [pass, otherState, otherLayers] of [
  ['content', 'superseded', 'both'],
  ['content', 'staged', 'both'],
  ['content', 'current', 'metadata'],
  ['metadata', 'current', 'metadata'],
] as const) test(`secret refusal uses the current ${pass} copy with an earlier ${otherState}/${otherLayers} copy`, async () => {
  const f = await storedPrivate();
  for (const domain of ['internal', 'secure_local'] as const) {
    const db = new Database(f.paths[domain]);
    db.query(`UPDATE items SET title = ?, locator_uri = ?, source_scope_folder_keys_json = ?,
      source_scope_generation = ?, source_scope_revision = ?`).run(
      `${domain} notes`, `https://example.test/${domain}`, JSON.stringify([`${domain}-folder`]),
      `${domain}-generation`, `${domain}-revision`,
    );
    db.close();
  }
  const decision = { ...classifyItemTiers({ signals: { title: 'Notes' }, text }),
    metadataTier: 'secure' as const, contentTier: 'secure' as const, state: 'pending' as const,
    metadataPending: pass === 'metadata', contentPending: pass === 'content' };
  f.ledger.recordRoutedPlacement(identity, decision, f.set.placementFor(decision));
  const db = new Database(f.ledger.dbPath);
  db.query("UPDATE tier_copies SET copy_state = ?, layers = ? WHERE trust_domain = 'internal'").run(otherState, otherLayers);
  db.query("UPDATE tier_copies SET layers = 'content' WHERE trust_domain = 'secure_local'").run();
  db.close();
  const installed = new InstalledTierClassification({ env: {} });
  const queue = installed.snifferStoreForLedger(f.ledger.dbPath);
  queue.enqueue({ subject: identity, pass, material: 'api_key=sk-abcdefghijklmnopqrstuvwxyz123456', flags: [], mapRevision: 'none' });
  let calls = 0;
  const service = new TierSnifferService({ installed, lane: BUILT_IN_SNIFFER_LANE,
    model: { async complete() { calls++; throw new Error('secret must not reach the model'); } },
    stores: () => [f.stores.secure_local!], classificationLedgerPath: join(f.dir, 'classification.jsonl'),
    autoApproveBuiltIn: true,
  });
  try {
    expect(await service.runOnce()).toMatchObject({ state: 'ran', report: { secretRefused: 1 } });
    const servingDomain = pass === 'metadata' ? 'internal' : 'secure_local';
    expect(f.secrets.get(identity)).toMatchObject({
      locator: `https://example.test/${servingDomain}`, title: null,
      folderKeys: [`${servingDomain}-folder`], scopeGeneration: `${servingDomain}-generation`,
      scopeRevision: `${servingDomain}-revision`,
    });
    expect(calls).toBe(0);
    expect(queue.listQuestions()).toEqual([]);
    expect(f.ledger.copies(identity)).toEqual([]);
  } finally { service.stop(); installed.close(); }
});

async function storedPrivate() {
  const tmp = tempDir();
  const f = openTierFixture(tmp.dir, { embed: false });
  cleanup.push(() => { f.close(); tmp.cleanup(); });
  await f.set.sync(fixtureConnector(() => [{ id: 'record', name: 'Notes', text }]), { fetchContent: true, placement: FIXTURE_PLACEMENT });
  await moveTieredItem({ set: f.set, identity, target: { metadataTier: 'secure', contentTier: 'secure' } });
  const decision = { ...classifyItemTiers({ signals: { title: 'Notes' }, text }),
    metadataTier: 'secure' as const, contentTier: 'secure' as const,
    reasons: ['metadata:sniffer:old-prompt:private', 'content:no_raise'],
  };
  f.ledger.recordRoutedPlacement(identity, decision, f.set.placementFor(decision));
  return f;
}

test('rejudging includes stored folder keys in the metadata question and its cache key', async () => {
  const f = await storedPrivate();
  const db = new Database(f.paths.secure_local);
  db.query('UPDATE items SET source_scope_folder_keys_json = ?').run(JSON.stringify(['Medical records']));
  db.close();
  const requests: TierSnifferRequest[] = [];
  rejudgeStoredContent(f.set, f.ledger.getCurrent(identity)!, { autoMoves: true, report: emptyTierRejudgeReport(),
    sniffer: { id: 'new-prompt', judge(request) { requests.push(request); return { verdict: 'decided', tier: 'private', code: 'ordinary' }; } },
  });
  const question = requests.find(request => request.pass === 'metadata')!;
  expect(question.material).toContain('Medical records');
  expect(question.materialHash).toBe(tierSnifferInputHash('metadata', { title: 'Notes', path: '/Files/Notes', folderKeys: ['Medical records'] }));
  expect(f.ledger.getCurrent(identity)).toMatchObject({ state: 'current', metadataTier: 'secure', contentTier: 'secure' });
  expect(f.stores.internal!.localContent(localId('record'))).toBeUndefined();
});

test('a Personal answer cannot lower an old names verdict when labels were not stored; a relist can reassess it', async () => {
  const f = await storedPrivate();
  rejudgeStoredContent(f.set, f.ledger.getCurrent(identity)!, { autoMoves: true, report: emptyTierRejudgeReport(),
    sniffer: { id: 'new-prompt', judge: () => ({ verdict: 'decided', tier: 'private', code: 'ordinary' }) },
  });
  expect(f.ledger.getCurrent(identity)).toMatchObject({ state: 'current', metadataTier: 'secure', contentTier: 'secure' });
  expect(f.stores.internal!.localContent(localId('record'))).toBeUndefined();
  await f.set.sync(fixtureConnector(() => [{ id: 'record', name: 'Notes', text, version: 'v2' }]), { fetchContent: true, placement: FIXTURE_PLACEMENT });
  await moveTieredItem({ set: f.set, identity, target: { metadataTier: 'private', contentTier: 'private' } });
  expect(f.stores.internal!.localContent(localId('record'))?.chunks.join('')).toBe(text);
});

for (const locator of [
  'ftp://reader:synthetic-password@example.test/report',
  'ftp://example.test/report?access_token=synthetic-url-credential',
  'https://reader:synthetic-password@example.test/report',
  "https://reader:p'ass@example.test/report",
  'https://reader:p ass@example.test/report',
  'https://example.test/report?access_token=synthetic-url-credential',
  'https://example.test/report',
]) test(`shared Secrets settlement filters locator ${locator}`, async () => {
  const f = await storedPrivate();
  const stored = f.stores.secure_local!.exportItemCopy(identity)!;
  const exported = { ...stored, columns: { ...stored.columns, locator_uri: locator } };
  const decision = { ...classifyItemTiers({ signals: { title: 'Notes' }, text }), contentTier: 'secrets' as const };
  expect(settleRoutedSecrets(f.set, identity, decision, exported, { findingKinds: ['sniffer_secret_refusal'] })).toBe(true);
  expect(f.secrets.get(identity)?.locator).toBe(locator === 'https://example.test/report' ? locator : null);
  expect(f.ledger.copies(identity)).toEqual([]);
  expect(f.stores.secure_local!.exportItemCopy(identity)).toBeUndefined();
  expect(f.stores.internal!.localContent(localId('record'))).toBeUndefined();
});


for (const locator of ['https://example.test/notes', 'https://example.test/?%61ccess%5F%74oken=synthetic-credential'])
  test('a legacy secret refusal removes the stored copy and records a safe location', async () => {
    const tmp = tempDir();
    const f = openTierFixture(tmp.dir, { embed: false });
    cleanup.push(() => { f.close(); tmp.cleanup(); });
    const store = f.stores.internal!;
    await store.syncFromConnector(fixtureConnector(() => [{ id: 'record', name: 'Orchard notes', text }]), { fetchContent: true, placement: FIXTURE_PLACEMENT });
    store.bindTierSet(f.ledger);
    expect(f.ledger.getCurrent(identity)?.routed).toBe(false);
    expect(store.searchItems('Orchard', 10)).toHaveLength(1);
    const db = new Database(f.paths.internal);
    db.query('UPDATE items SET locator_uri = ?').run(locator); db.close();
    const pending = classifyItemTiers({ signals: { title: 'Orchard notes' }, text, subject: identity },
      { sniffer: { id: 'pending', judge() { return { verdict: 'undecided' }; } } });
    f.ledger.recordDecision(identity, pending);
    const installed = new InstalledTierClassification({ env: {} });
    const queue = installed.snifferStoreForLedger(f.ledger.dbPath);
    queue.enqueue({ subject: identity, pass: 'content', material: 'api_key=sk-abcdefghijklmnopqrstuvwxyz123456', flags: [], mapRevision: 'none' });
    let calls = 0;
    const service = new TierSnifferService({ installed, lane: BUILT_IN_SNIFFER_LANE,
      model: { async complete() { calls++; throw new Error('must not dispatch'); } },
      stores: () => [store], classificationLedgerPath: join(tmp.dir, 'classification.jsonl'), autoApproveBuiltIn: true });
    try {
      expect(await service.runOnce()).toMatchObject({ state: 'ran', report: { secretRefused: 1 } });
      expect(store.searchItems('Orchard', 10)).toEqual([]);
      expect(store.localContent(localId('record'))).toBeUndefined();
      expect(f.secrets.get(identity)).toMatchObject({ locator: locator.includes('%') ? null : locator, findingKinds: ['sniffer_secret_refusal'] });
      expect(f.ledger.getCurrent(identity)).toMatchObject({ contentTier: 'secrets', contentPending: false });
      expect(queue.counts().questions).toBe(0);
      expect(calls).toBe(0);
    } finally { service.stop(); installed.close(); }
  });


test('legacy Secrets settlement resumes after tombstoning but before the ledger write', async () => {
  const tmp = tempDir();
  const f = openTierFixture(tmp.dir, { embed: false });
  cleanup.push(() => { f.close(); tmp.cleanup(); });
  const store = f.stores.internal!;
  await store.syncFromConnector(fixtureConnector(() => [{ id: 'record', name: 'Orchard notes', text }]), { fetchContent: true, placement: FIXTURE_PLACEMENT });
  const decision = classifyItemTiers({ signals: { title: 'Orchard notes' }, text: 'api_key=sk-abcdefghijklmnopqrstuvwxyz123456' });
  const settle = () => settleLegacySecrets({ ledger: f.ledger, stores: [store], locations: f.secrets, identity, decision });
  const original = f.ledger.recordDecision.bind(f.ledger);
  f.ledger.recordDecision = () => { throw new Error('simulated ledger write failure'); };
  expect(settle).toThrow('simulated ledger write failure');
  f.ledger.recordDecision = original;
  expect(store.localContent(localId('record'))).toBeUndefined();
  expect(f.secrets.get(identity)).toBeDefined();
  expect(settle()).toBe(true);
  expect(f.ledger.getCurrent(identity)).toMatchObject({ contentTier: 'secrets', contentPending: false });
});


for (const afterTombstone of [false, true]) test(`routed secret cleanup retries after a tombstone failure (after=${afterTombstone}) and service restart`, async () => {
  const f = await storedPrivate();
  const decision = { ...classifyItemTiers({ signals: { title: 'Notes' }, text }),
    metadataTier: 'secure' as const, contentTier: 'secure' as const, state: 'pending' as const,
    metadataPending: false, contentPending: true };
  f.ledger.recordRoutedPlacement(identity, decision, f.set.placementFor(decision));
  let installed = new InstalledTierClassification({ env: {} });
  const queue = () => installed.snifferStoreForLedger(f.ledger.dbPath);
  queue().enqueue({ subject: identity, pass: 'content', material: ['AKIA', 'ABCDEFGHIJKLMNOP'].join(''), flags: [], mapRevision: 'none' });
  let calls = 0;
  const makeService = () => new TierSnifferService({ installed, lane: BUILT_IN_SNIFFER_LANE,
    model: { async complete() { calls++; throw new Error('must not dispatch'); } },
    stores: () => [f.stores.secure_local!], classificationLedgerPath: join(f.dir, 'classification.jsonl'), autoApproveBuiltIn: true });
  let service = makeService();
  const store = f.stores.secure_local!;
  const original = store.tombstoneCopy.bind(store);
  store.tombstoneCopy = (...args) => {
    if (afterTombstone) original(...args);
    throw new Error('transient tombstone failure');
  };
  try {
    expect(await service.runOnce()).toMatchObject({ state: 'failed' });
    expect(f.ledger.getCurrent(identity)?.contentTier).toBe('secrets');
    expect(f.ledger.copies(identity).length).toBeGreaterThan(0);
    expect(store.itemStoredContent(identity)?.chunkCount ?? 0).toBe(afterTombstone ? 0 : 1);
    expect(queue().counts().questions).toBe(1);
    service.stop(); installed.close();
    store.tombstoneCopy = original;
    installed = new InstalledTierClassification({ env: {} }); service = makeService();
    expect(await service.runOnce()).toMatchObject({ state: 'ran', report: { secretRefused: 1 } });
    expect(f.ledger.copies(identity)).toEqual([]);
    expect(store.itemStoredContent(identity)?.chunkCount ?? 0).toBe(0);
    expect(queue().counts().questions).toBe(0);
    expect(calls).toBe(0);
  } finally { store.tombstoneCopy = original; service.stop(); installed.close(); }
});
