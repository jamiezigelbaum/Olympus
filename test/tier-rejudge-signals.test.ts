import { afterEach, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { join } from 'node:path';
import { InstalledTierClassification } from '../src/workers/classification/installed-tier-classification.ts';
import { BUILT_IN_SNIFFER_LANE } from '../src/workers/classification/built-in-sniffer.ts';
import { SNIFFER_PROMPT_VERSION, snifferCacheModelId } from '../src/workers/classification/sniffer.ts';
import { TierSnifferService } from '../src/workers/classification/sniffer-service.ts';
import { classifyItemTiers, tierSnifferInputHash, type TierSnifferRequest } from '../src/workers/classification/tier-classifier.ts';
import { emptyTierRejudgeReport, rejudgeStoredContent, settleRoutedSecrets, settleLegacySecrets } from '../src/workers/connector-store/tier-rejudge.ts';
import { moveTieredItem } from '../src/workers/connector-store/tier-move.ts';
import { storedSignals } from '../src/workers/connector-store/stored-names.ts';
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

async function storedPrivate(tier: 'private' | 'secure' = 'secure') {
  const tmp = tempDir();
  const f = openTierFixture(tmp.dir, { embed: false });
  cleanup.push(() => { f.close(); tmp.cleanup(); });
  await f.set.sync(fixtureConnector(() => [{ id: 'record', name: 'Notes', text }]), { fetchContent: true, placement: FIXTURE_PLACEMENT });
  if (tier === 'secure') await moveTieredItem({ set: f.set, identity, target: { metadataTier: 'secure', contentTier: 'secure' } });
  const decision = { ...classifyItemTiers({ signals: { title: 'Notes' }, text }),
    metadataTier: tier, contentTier: tier,
    reasons: [`metadata:sniffer:old-prompt:${tier === 'secure' ? 'private' : 'ordinary'}`, 'content:no_raise'],
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

test('rejudging a message asks about its names with its chat, as the owner-rule sweep reads them', async () => {
  const tmp = tempDir();
  const f = openTierFixture(tmp.dir, { embed: false });
  cleanup.push(() => { f.close(); tmp.cleanup(); });
  const chatIdentity = identityOf('message', 'chat-7971');
  await f.set.sync(fixtureConnector(() => [{ id: 'message', name: 'Jamie', text, conversation: 'chat-7971' }]), { fetchContent: true, placement: FIXTURE_PLACEMENT });
  await moveTieredItem({ set: f.set, identity: chatIdentity, target: { metadataTier: 'secure', contentTier: 'secure' } });
  const decision = { ...classifyItemTiers({ signals: { title: 'Jamie' }, text }),
    metadataTier: 'secure' as const, contentTier: 'secure' as const,
    reasons: ['metadata:sniffer:old-prompt:private', 'content:no_raise'],
  };
  f.ledger.recordRoutedPlacement(chatIdentity, decision, f.set.placementFor(decision));
  const requests: TierSnifferRequest[] = [];
  rejudgeStoredContent(f.set, f.ledger.getCurrent(chatIdentity)!, { autoMoves: true, report: emptyTierRejudgeReport(),
    sniffer: { id: 'new-prompt', judge(request) { requests.push(request); return { verdict: 'decided', tier: 'private', code: 'ordinary' }; } },
  });
  const question = requests.find(request => request.pass === 'metadata')!;
  expect(question.material).toContain('chat-7971');
  expect(question.materialHash).toBe(tierSnifferInputHash('metadata', storedSignals(f.stores.secure_local!.exportItemCopy(chatIdentity)!)));
});

test('a chat key with no letters is left out of the names the sniffer reads, but still keys the question', async () => {
  // 1.2.1 canary: next to "Tiago Ferreira", Telegram's numeric peer id read as his identity and held his messages Private.
  const tmp = tempDir();
  const f = openTierFixture(tmp.dir, { embed: false });
  cleanup.push(() => { f.close(); tmp.cleanup(); });
  const chatIdentity = identityOf('message', '8122045531');
  await f.set.sync(fixtureConnector(() => [{ id: 'message', name: 'Tiago Ferreira', text, conversation: '8122045531' }]), { fetchContent: true, placement: FIXTURE_PLACEMENT });
  await moveTieredItem({ set: f.set, identity: chatIdentity, target: { metadataTier: 'secure', contentTier: 'secure' } });
  const decision = { ...classifyItemTiers({ signals: { title: 'Tiago Ferreira' }, text }),
    metadataTier: 'secure' as const, contentTier: 'secure' as const,
    reasons: ['metadata:sniffer:old-prompt:private', 'content:no_raise'],
  };
  f.ledger.recordRoutedPlacement(chatIdentity, decision, f.set.placementFor(decision));
  const requests: TierSnifferRequest[] = [];
  rejudgeStoredContent(f.set, f.ledger.getCurrent(chatIdentity)!, { autoMoves: true, report: emptyTierRejudgeReport(),
    sniffer: { id: 'new-prompt', judge(request) { requests.push(request); return { verdict: 'decided', tier: 'private', code: 'ordinary' }; } },
  });
  const question = requests.find(request => request.pass === 'metadata')!;
  expect(question.material).toContain('Tiago Ferreira');
  expect(question.material).not.toContain('8122045531');
  expect(question.materialHash).toBe(tierSnifferInputHash('metadata', storedSignals(f.stores.secure_local!.exportItemCopy(chatIdentity)!)));
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

const judging = (id: string, tier: 'private' | 'secure') => ({ id, judge: (request: TierSnifferRequest) =>
  request.pass === 'metadata' ? { verdict: 'decided' as const, tier, code: tier === 'secure' ? 'identity' : 'ordinary' }
    : { verdict: 'decided' as const, tier: 'private' as const, code: 'ordinary' } });

test('names held Private by labels the store lacks stay Private across repeated Personal re-judges', async () => {
  const f = await storedPrivate();
  for (const prompt of ['prompt-a', 'prompt-b']) {
    rejudgeStoredContent(f.set, f.ledger.getCurrent(identity)!, { autoMoves: true, report: emptyTierRejudgeReport(), sniffer: judging(prompt, 'private') });
    expect(f.ledger.getCurrent(identity)).toMatchObject({ state: 'current', metadataTier: 'secure', contentTier: 'secure' });
    expect(f.ledger.getCurrent(identity)!.reasons).not.toContain('metadata:names_from_store');
  }
  expect(f.stores.internal!.localContent(localId('record'))).toBeUndefined();
});

test('names a re-judge held Private from the stored names can be lowered by a later re-judge', async () => {
  // 1.2.1 canary: a re-judge held Tiago's messages Private on a chat id it should not have read; the
  // fixed prompt answered Personal, but the old maximum kept them Private for good.
  const f = await storedPrivate('private');
  rejudgeStoredContent(f.set, f.ledger.getCurrent(identity)!, { autoMoves: true, report: emptyTierRejudgeReport(), sniffer: judging('prompt-a', 'secure') });
  expect(f.ledger.getCurrent(identity)).toMatchObject({ state: 'moving', targetMetadataTier: 'secure' });
  await moveTieredItem({ set: f.set, identity, target: { metadataTier: 'secure', contentTier: 'secure' } });
  expect(f.ledger.getCurrent(identity)).toMatchObject({ metadataTier: 'secure' });
  expect(f.ledger.getCurrent(identity)!.reasons).toContain('metadata:names_from_store');
  rejudgeStoredContent(f.set, f.ledger.getCurrent(identity)!, { autoMoves: true, report: emptyTierRejudgeReport(), sniffer: judging('prompt-b', 'private') });
  expect(f.ledger.getCurrent(identity)).toMatchObject({ state: 'moving', targetMetadataTier: 'private', targetContentTier: 'private' });
  await moveTieredItem({ set: f.set, identity, target: { metadataTier: 'private', contentTier: 'private' } });
  expect(f.ledger.getCurrent(identity)).toMatchObject({ metadataTier: 'private', contentTier: 'private' });
  expect(f.stores.internal!.localContent(localId('record'))?.chunks.join('')).toBe(text);
});

test('a raise from a queued stored-names question is marked when its answer comes in, so a later re-judge can lower it', async () => {
  const f = await storedPrivate('private');
  const placementFor = f.set.placementFor.bind(f.set);
  const queued = { id: 'prompt-a', judge: (request: TierSnifferRequest) => request.pass === 'metadata'
    ? { verdict: 'undecided' as const, queued: true as const }
    : { verdict: 'decided' as const, tier: 'private' as const, code: 'ordinary' } };
  rejudgeStoredContent(f.set, f.ledger.getCurrent(identity)!, { autoMoves: true, report: emptyTierRejudgeReport(), sniffer: queued });
  f.ledger.applySnifferVerdict(identity, { pass: 'metadata', tier: 'secure', reason: 'metadata:sniffer:prompt-a:identity', modelId: 'fixture' }, { placementFor });
  expect(f.ledger.getCurrent(identity)).toMatchObject({ state: 'moving', targetMetadataTier: 'secure' });
  await moveTieredItem({ set: f.set, identity, target: { metadataTier: 'secure', contentTier: 'secure' } });
  const raised = f.ledger.getCurrent(identity)!;
  expect(raised.reasons).toContain('metadata:names_from_store');
  expect(raised.reasons).not.toContain('metadata:names_from_store:asked');
  rejudgeStoredContent(f.set, raised, { autoMoves: true, report: emptyTierRejudgeReport(), sniffer: judging('prompt-b', 'private') });
  expect(f.ledger.getCurrent(identity)).toMatchObject({ state: 'moving', targetMetadataTier: 'private' });
});

test('a queued stored-names question answered at its floor leaves no mark', async () => {
  const f = await storedPrivate();
  const queued = { id: 'prompt-a', judge: (request: TierSnifferRequest) => request.pass === 'metadata'
    ? { verdict: 'undecided' as const, queued: true as const }
    : { verdict: 'decided' as const, tier: 'private' as const, code: 'ordinary' } };
  rejudgeStoredContent(f.set, f.ledger.getCurrent(identity)!, { autoMoves: true, report: emptyTierRejudgeReport(), sniffer: queued });
  f.ledger.applySnifferVerdict(identity, { pass: 'metadata', tier: 'private', reason: 'metadata:sniffer:prompt-a:ordinary', modelId: 'fixture' }, { placementFor: f.set.placementFor.bind(f.set) });
  const settled = f.ledger.getCurrent(identity)!;
  expect(settled).toMatchObject({ state: 'current', metadataTier: 'secure' });
  expect(settled.reasons.filter((reason) => reason.startsWith('metadata:names_from_store'))).toEqual([]);
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


for (const failure of ['before-tombstone', 'after-tombstone', 'record-safe-locator', 'record-credential-locator'])
test(`routed secret cleanup retries after ${failure} and service restart`, async () => {
  const afterTombstone = failure === 'after-tombstone';
  const recordFailure = failure.startsWith('record-');
  const f = await storedPrivate();
  const locator = failure === 'record-credential-locator'
    ? 'postgres://alice:q7@db.internal/app' : 'https://example.test/notes';
  // The Personal copy was stripped by the raise. Only Private retains names.
  for (const domain of ['secure_local'] as const) {
    const db = new Database(f.paths[domain]);
    db.query('UPDATE items SET locator_uri = ?, source_scope_folder_keys_json = ?, source_scope_generation = ?, source_scope_revision = ?')
      .run(locator, JSON.stringify(['notes-folder']), 'generation', 'revision');
    db.close();
  }
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
  const originalRecord = f.secrets.record.bind(f.secrets);
  if (recordFailure) f.secrets.record = () => { throw new Error('transient receipt failure'); };
  else store.tombstoneCopy = (...args) => {
    if (afterTombstone) original(...args);
    throw new Error('transient tombstone failure');
  };
  try {
    expect(await service.runOnce()).toMatchObject({ state: 'failed' });
    expect(f.ledger.getCurrent(identity)?.contentTier).toBe('secrets');
    expect(f.ledger.copies(identity).length).toBeGreaterThan(0);
    expect(store.itemStoredContent(identity)?.chunkCount ?? 0).toBe(afterTombstone ? 0 : 1);
    expect(queue().counts().questions).toBe(1);
    expect(f.secrets.get(identity) === undefined).toBe(recordFailure);
    expect(store.localContent(localId('record'))).toBeUndefined();
    service.stop(); installed.close();
    store.tombstoneCopy = original;
    f.secrets.record = originalRecord;
    installed = new InstalledTierClassification({ env: {} }); service = makeService();
    expect(await service.runOnce()).toMatchObject({ state: 'ran', report: { secretRefused: 1 } });
    expect(f.ledger.copies(identity)).toEqual([]);
    expect(store.itemStoredContent(identity)?.chunkCount ?? 0).toBe(0);
    expect(queue().counts().questions).toBe(0);
    expect(f.secrets.get(identity)).toMatchObject({
      locator: failure === 'record-credential-locator' ? null : locator,
      title: null, findingKinds: ['sniffer_secret_refusal'],
      folderKeys: ['notes-folder'], scopeGeneration: 'generation', scopeRevision: 'revision',
    });
    expect(calls).toBe(0);
  } finally { store.tombstoneCopy = original; f.secrets.record = originalRecord; service.stop(); installed.close(); }
});


for (const scenario of ['secret', 'clean', 'unreadable', 'missing', 'cached-secret', 'cleanup-interrupted', 'changed-during-model'] as const)
test(`legacy full-body screening before resolving a clean excerpt: ${scenario}`, async () => {
  const tmp = tempDir();
  const f = openTierFixture(tmp.dir, { embed: false });
  cleanup.push(() => { f.close(); tmp.cleanup(); });
  const store = f.stores.internal!;
  const body = `${'Ordinary orchard notes. '.repeat(400)}\n${scenario.includes('secret') || scenario === 'cleanup-interrupted'
    ? ['postgres://alice:', 'q7', '@db.internal/app'].join('') : 'Prune the apple trees in winter.'}`;
  // Land under the pre-upgrade screen, then restore the actual persisted body.
  await store.syncFromConnector(fixtureConnector(() => [{ id: 'record', name: 'Orchard notes', text }]),
    { fetchContent: true, placement: FIXTURE_PLACEMENT });
  const original = store.exportItemCopy(identity)!;
  store.importItemCopy({ ...original, chunks: original.chunks.map(chunk => ({ ...chunk, boundedText: body })) },
    { trustTier: 'S3', syncConnectorId: 'legacy-fixture' });
  store.bindTierSet(f.ledger);
  const pending = classifyItemTiers({ signals: { title: 'Orchard notes' }, text, subject: identity },
    { sniffer: { id: 'old-prompt', judge() { return { verdict: 'undecided' }; } } });
  f.ledger.recordDecision(identity, { ...pending, engineVersion: '2026-10-01.p3' });
  expect(f.ledger.getCurrent(identity)?.routed).toBe(false);
  const installed = new InstalledTierClassification({ env: {} });
  const queue = installed.snifferStoreForLedger(f.ledger.dbPath);
  queue.enqueue({ subject: identity, pass: 'content', material: text, flags: [], mapRevision: 'none' });
  if (scenario === 'cached-secret') queue.putVerdict({
    materialHash: queue.questionFor(identity, 'content')!.materialHash,
    modelId: snifferCacheModelId(BUILT_IN_SNIFFER_LANE), promptVersion: SNIFFER_PROMPT_VERSION, mapRevision: 'none',
  }, { tier: 'personal', category: 'ordinary', confidence: 1, failSafe: false });
  const exportCopy = store.exportItemCopy.bind(store);
  const tombstoneCopy = store.tombstoneCopy.bind(store);
  if (scenario === 'unreadable') store.exportItemCopy = () => { throw new Error('temporarily unreadable'); };
  if (scenario === 'missing') store.exportItemCopy = () => undefined;
  if (scenario === 'cleanup-interrupted') store.tombstoneCopy = (...args) => { tombstoneCopy(...args); throw new Error('interrupted after tombstone'); };
  let calls = 0;
  const service = new TierSnifferService({ installed, lane: BUILT_IN_SNIFFER_LANE,
    model: { async complete() {
      calls++;
      if (scenario === 'changed-during-model') store.importItemCopy({ ...original,
        chunks: original.chunks.map(chunk => ({ ...chunk, boundedText: `${body}\n${['postgres://alice:', 'q7', '@db.internal/app'].join('')}` })),
      }, { trustTier: 'S3', syncConnectorId: 'legacy-fixture' });
      return { modelId: BUILT_IN_SNIFFER_LANE.modelId, text: JSON.stringify({ verdicts: [
      { i: 1, tier: 'personal', category: 'ordinary', ownRecord: false, privateKind: 'none', confidence: 1 },
    ] }) }; } },
    stores: () => [store], classificationLedgerPath: join(tmp.dir, 'classification.jsonl'), autoApproveBuiltIn: true });
  try {
    const result = await service.runOnce();
    if (scenario === 'unreadable' || scenario === 'missing') {
      expect(result).toMatchObject({ state: 'ran', report: { calls: 0, verdictsApplied: 0, staleDropped: 0 } });
      expect(queue.counts().questions).toBe(1);
      expect(f.ledger.getCurrent(identity)).toMatchObject({ state: 'pending', contentPending: true });
      store.exportItemCopy = exportCopy;
      await service.runOnce();
      expect(queue.counts().questions).toBe(0);
    } else if (scenario === 'clean') {
      expect(result).toMatchObject({ state: 'ran', report: { calls: 1, verdictsApplied: 1 } });
      expect(f.ledger.getCurrent(identity)).toMatchObject({ state: 'current', contentTier: 'private', contentPending: false });
      expect(store.searchItems('Orchard', 10)).toHaveLength(1);
      expect(queue.counts().questions).toBe(0);
    } else {
      if (scenario === 'cleanup-interrupted') {
        expect(result).toMatchObject({ state: 'failed' });
        expect(queue.counts().questions).toBe(1);
        store.tombstoneCopy = tombstoneCopy;
        expect(await service.runOnce()).toMatchObject({ state: 'ran', report: { secretRefused: 1 } });
      } else expect(result).toMatchObject({ state: 'ran', report: { secretRefused: 1 } });
      expect(f.ledger.getCurrent(identity)).toMatchObject({ state: 'current', contentTier: 'secrets', contentPending: false });
      expect(store.searchItems('Orchard', 10)).toEqual([]);
      expect(store.localContent(localId('record'))).toBeUndefined();
      expect(f.secrets.get(identity)).toMatchObject({ title: null, findingKinds: ['sniffer_secret_refusal'] });
      expect(queue.counts().questions).toBe(0);
      expect(calls).toBe(scenario === 'changed-during-model' ? 1 : 0);
    }
  } finally { store.exportItemCopy = exportCopy; store.tombstoneCopy = tombstoneCopy; service.stop(); installed.close(); }
});
