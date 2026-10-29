import { TierSnifferStore } from '../src/workers/classification/sniffer-store.ts';
import { CachedTierSniffer } from '../src/workers/classification/sniffer.ts';
import { BUILT_IN_SNIFFER_LANE } from '../src/workers/classification/built-in-sniffer.ts';
import { TIER_CLASSIFIER_VERSION } from '../src/workers/classification/tier-classifier.ts';
import { runSnifferPass } from '../src/workers/classification/sniffer-resolver.ts';
import { rejudgeRoutedItems } from '../src/workers/connector-store/tier-rejudge.ts';
import { moveTieredItem } from '../src/workers/connector-store/tier-move.ts';
import { createReleaseTierCheck } from '../src/workers/connector-store/tier-visibility.ts';
import { afterEach, expect, test } from 'bun:test';
import { classifyItemTiers, classifyContentTier, type TierSniffer, type TierSnifferRequest } from '../src/workers/classification/tier-classifier.ts';
import { TieredStoreSet } from '../src/workers/connector-store/tiered-store-set.ts';
import { ACCOUNT, CORPORA, FIXTURE_PLACEMENT, PROVIDER, fixtureConnector, identityOf, localId, openTierFixture, tempDir } from './helpers/tier-fixtures.ts';

const requests: TierSnifferRequest[] = [];
const waiting: TierSniffer = { id: 'fixture-waiting', judge(request) { requests.push(request); return { verdict: 'undecided', queued: true }; } };
const cleanups: Array<() => void> = [];
afterEach(() => { requests.length = 0; for (const close of cleanups.splice(0)) close(); });
function lane(sniffer: TierSniffer = waiting) {
  const tmp = tempDir();
  const fixture = openTierFixture(tmp.dir, { embed: false });
  const set = new TieredStoreSet({ setId: 'personal-first', ledger: fixture.ledger, secretLocations: fixture.secrets,
    tierClassification: { sniffer },
    legs: ['internal', 'secure_local'].map(domain => ({ trustDomain: domain as 'internal' | 'secure_local', corpusId: CORPORA[domain as 'internal' | 'secure_local'], store: fixture.stores[domain as 'internal' | 'secure_local']! })),
  });
  cleanups.push(() => { fixture.close(); tmp.cleanup(); });
  return { ...fixture, set };
}

for (const [title, text] of [
  ['Fruit reminder', 'Please remember bananas and oranges for tomorrow.'],
  ['Gmail tips', 'Organize your inbox with labels and keyboard shortcuts.'],
  ['Uber promo', 'Save on your next ride this weekend.'],
  ['Health and finance guide', 'Learn about treatment, symptoms, invoice processing and family life.'],
] as const) test(`${title}: content is usable while its model question waits`, async () => {
  const f = lane();
  await f.set.sync(fixtureConnector(() => [{ id: 'ordinary', name: title, text }]), { fetchContent: true, placement: FIXTURE_PLACEMENT });
  expect(f.stores.internal!.localContent(localId('ordinary'))?.chunks.join(' ')).toContain(text);
  expect(f.ledger.copies(identityOf('ordinary'))).toEqual([expect.objectContaining({ corpusId: CORPORA.internal, layers: 'both', embedHold: false })]);
  expect(requests.some(r => r.pass === 'content')).toBe(true);
});

for (const [title, text, path] of [
  ['Lab result', 'Glucose 93 mg/dL. Reference range: 70-99.', undefined],
  ['Patient record', 'Patient: Ana\nReturn next week.', undefined],
  ['Filled contact form', 'Name: Morgan Example\nEmail: morgan@example.test', undefined],
  ['Bank statement', 'Account holder: Morgan Example\nClosing balance: 315.20 EUR', undefined],
  ['Application', 'Full name: Morgan Example\nDate of birth: 1990-02-03\nAddress: 10 Example Road', undefined],
  ['Report', 'Measured value 4.8 (reference range 3.5–5.2)', undefined],
  ['Notes', 'Follow-up instructions.', '/Records/Medical/notes.txt'],
  ['Visit 2026-10-12', 'Follow-up instructions.', undefined],
  ['Bank statement September 2026', 'Opening balance: EUR 315.20\nClosing balance: EUR 400.00', undefined],
] as const) test(`${title}: own-record signal holds content and asks with high priority`, () => {
  const decision = classifyItemTiers({ signals: { title, ...(path ? { path } : {}) }, text }, { sniffer: waiting });
  const f = lane();
  const placement = f.set.placementFor(decision);
  expect(placement.copies).toContainEqual(expect.objectContaining({ corpusId: CORPORA.secure_local, layers: 'content' }));
  expect(placement.embedHold).toBe(true);
  expect(requests.find(r => r.pass === 'content')).toMatchObject({ priority: 10 });
});

test('held names are searchable; no body, snippet or chunks reach Personal', async () => {
  const f = lane();
  await f.set.sync(fixtureConnector(() => [{ id: 'held', name: 'Orchid laboratory report', text: 'Patient: Morgan Example\nGlucose 93 mg/dL. Hiddenbodymarker.' }]), { fetchContent: true, placement: FIXTURE_PLACEMENT });
  expect(f.stores.internal!.searchItems('Orchid', 10).map(r => r.sourceItem.providerItemId)).toEqual(['held']);
  expect(f.stores.internal!.searchItems('Hiddenbodymarker', 10)).toEqual([]);
  expect(f.stores.internal!.localContent(localId('held'))?.chunks).toEqual([]);
  expect(f.stores.secure_local!.localContent(localId('held'))?.chunks.join(' ')).toContain('Hiddenbodymarker');
});

test('background Private verdict hides Personal-first content before its move', async () => {
  const f = lane();
  await f.set.sync(fixtureConnector(() => [{ id: 'raise', name: 'Orchard notes', text: 'Quietmarker from our conversation.' }]), { fetchContent: true, placement: FIXTURE_PLACEMENT });
  expect(f.stores.internal!.searchItems('Quietmarker', 10)).toHaveLength(1);
  const result = f.ledger.applySnifferVerdict(identityOf('raise'), { pass: 'content', tier: 'secure', reason: 'content:sniffer:fixture-waiting:private', modelId: 'fixture' }, { placementFor: d => f.set.placementFor(d) });
  expect(result?.outcome).toBe('queued_move');
  expect(f.stores.internal!.searchItems('Quietmarker', 10)).toEqual([]);
  expect(f.stores.internal!.localContent(localId('raise'))).toBeUndefined();
});

test('late content uses the same waiting policy', () => {
  const base = { metadataTier: 'private' as const, metadataForced: false, metadataFlagged: false };
  expect(classifyContentTier({ ...base, text: 'Remember the oranges.' }, { sniffer: waiting }).reasons).toContain('content:personal_first');
  expect(classifyContentTier({ ...base, path: '/Records/Labs/report.txt', text: 'Follow up next week.' }, { sniffer: waiting }).reasons).not.toContain('content:personal_first');
});

test('topic words alone are Personal even without a configured model', () => {
  expect(classifyItemTiers({ signals: { title: 'Health guide' }, text: 'Treatment and symptoms, therapy and finance.' })).toMatchObject({ metadataTier: 'private', contentTier: 'private', metadataPending: false });
});

for (const names of [
  { title: 'Open https://reader:synthetic-password@example.test/report' },
  { sender: 'Report https://example.test/check?access_token=synthetic-url-credential' },
]) test('credential-bearing names are never released or sent to the model', () => {
  const decision = classifyItemTiers({ signals: names, text: 'Patient: Morgan Example\nGlucose 93 mg/dL.' }, { sniffer: waiting });
  const f = lane();
  expect(f.set.placementFor(decision).copies.some(c => c.trustDomain === 'internal')).toBe(false);
  expect(requests).toEqual([]);
});


for (const locator of [
  'https://reader:synthetic-password@example.test/report',
  "https://reader:p'ass@example.test/report",
  'https://reader:p ass@example.test/report',
]) test('held metadata cannot release a credential-bearing locator', async () => {
  const f = lane();
  const base = fixtureConnector(() => [{ id: 'url', name: 'Orchid report', text: 'Patient: Morgan Example\nGlucose 93 mg/dL.' }]);
  const connector = { ...base, async *listItems() {
    for await (const page of base.listItems()) yield { ...page, items: page.items.map(item => ({ ...item,
      metadata: { ...item.metadata, locatorUri: locator },
    })) };
  } };
  await f.set.sync(connector, { fetchContent: false, placement: FIXTURE_PLACEMENT });
  expect(f.stores.internal!.searchItems('Orchid', 10)).toEqual([]);
  expect(f.ledger.copies(identityOf('url'))).toEqual([]);
  expect(f.secrets.get(identityOf('url'))).toMatchObject({ locator: null, findingKinds: ['credential_assignment'] });
});

for (const prefix of ['', 'Ordinary background. '.repeat(200)]) test('encoded credential URL anywhere in a body settles as Secrets before storage', async () => {
  const f = lane();
  const text = prefix + 'Open https://example.test/?%61ccess%5F%74oken=synthetic-credential';
  await f.set.sync(fixtureConnector(() => [{ id: 'body-url', name: 'Orchard notes', text }]), { fetchContent: true, placement: FIXTURE_PLACEMENT });
  expect(f.ledger.getCurrent(identityOf('body-url'))).toMatchObject({ contentTier: 'secrets', contentPending: false });
  expect(f.ledger.copies(identityOf('body-url'))).toEqual([]);
  expect(f.stores.internal!.localContent(localId('body-url'))).toBeUndefined();
  expect(requests).toEqual([]);
});

function failingQueue() {
  const queue = new TierSnifferStore({ dbPath: ':memory:' });
  cleanups.push(() => queue.close());
  const enqueue = queue.enqueue.bind(queue);
  queue.enqueue = () => { throw new Error('database is locked'); };
  const sniffer = new CachedTierSniffer(queue, BUILT_IN_SNIFFER_LANE);
  return { queue, sniffer, recover: () => { queue.enqueue = enqueue; } };
}

test('enqueue failure holds ordinary content in Private until a question is persisted', async () => {
  const q = failingQueue();
  const f = lane(q.sniffer);
  await f.set.sync(fixtureConnector(() => [{ id: 'queue-failure', name: 'Orchard notes', text: 'Hiddenbodymarker from the orchard.' }]), { fetchContent: true, placement: FIXTURE_PLACEMENT });
  const identity = identityOf('queue-failure');
  expect(q.queue.listQuestions()).toEqual([]);
  expect(f.ledger.getCurrent(identity)?.reasons).not.toContain('content:personal_first');
  expect(f.stores.internal!.searchItems('Hiddenbodymarker', 10)).toEqual([]);
  expect(f.stores.internal!.localContent(localId('queue-failure'))?.chunks ?? []).toEqual([]);
  expect(f.stores.secure_local!.localContent(localId('queue-failure'))?.chunks.join('')).toContain('Hiddenbodymarker');
  expect(f.ledger.copies(identity)).toContainEqual(expect.objectContaining({ trustDomain: 'secure_local', embedHold: true }));
});

test('failed rejudge enqueue leaves a held row eligible for retry', async () => {
  const q = failingQueue();
  const f = lane(q.sniffer);
  // An own-record fixture is held even before the queue-failure fix.
  await f.set.sync(fixtureConnector(() => [{ id: 'retry', name: 'Orchard notes', text: 'Patient: Morgan Example\nReturn next week.' }]), { fetchContent: true, placement: FIXTURE_PLACEMENT });
  const key = { engineVersion: TIER_CLASSIFIER_VERSION, snifferId: q.sniffer.id, limit: 10 };
  const candidates = () => f.ledger.rejudgeCandidatePage(key).records.map(row => row.providerItemId);
  expect(candidates()).toContain('retry');
  expect(rejudgeRoutedItems({ set: f.set, autoMoves: true }).report).toMatchObject({ failed: 1, asked: 0 });
  expect(candidates()).toContain('retry');
  expect(q.queue.listQuestions()).toEqual([]);
  q.recover();
  expect(rejudgeRoutedItems({ set: f.set, autoMoves: true }).report).toMatchObject({ failed: 0, asked: 1 });
  expect(q.queue.questionFor(identityOf('retry'), 'content')).toBeDefined();
  expect(candidates()).not.toContain('retry');
});

test('a held own record is Private to every answer release until its model answers; Personal-first content is not', async () => {
  const f = lane();
  await f.set.sync(fixtureConnector(() => [
    { id: 'held', name: 'Cardiology notes', text: 'Resting heart rate 52 bpm. Prescribed lisinopril 5 mg daily.' },
    { id: 'usable', name: 'Orchard notes', text: 'Please remember bananas and oranges for tomorrow.' },
  ]), { fetchContent: true, placement: FIXTURE_PLACEMENT });
  // Both wait on the model with the Personal default recorded; only the own record is held.
  expect(f.ledger.getCurrent(identityOf('held'))).toMatchObject({ state: 'pending', contentTier: 'private', contentPending: true });
  const check = createReleaseTierCheck(() => [{ ledger: f.ledger, corpusIds: new Set([CORPORA.internal, CORPORA.secure_local]) }], () => 'approval');
  const input = (id: string, corpusId: string, layer?: 'names') => ({
    corpusId, provider: PROVIDER, accountScope: ACCOUNT, providerItemId: id, privateAtAnswer: corpusId === CORPORA.secure_local, ...(layer ? { layer } : {}),
  });
  expect(check.inputs([
    input('held', CORPORA.secure_local),
    input('held', CORPORA.internal, 'names'),
    input('usable', CORPORA.internal),
  ]).map((verdict) => verdict.tier)).toEqual(['private', 'public_or_personal', 'public_or_personal']);
});

test('an unchanged item keeps its model verdict on every later listing, whichever names the re-judge asked with', async () => {
  const queue = new TierSnifferStore({ dbPath: ':memory:' });
  cleanups.push(() => queue.close());
  const f = lane(new CachedTierSniffer(queue, BUILT_IN_SNIFFER_LANE));
  // The listing names the item's labels too; the stored copy the re-judge reads its names back from does not keep them.
  const base = fixtureConnector(() => [{ id: 'record', name: 'Cardiology notes', text: 'Resting heart rate 52 bpm. Prescribed lisinopril 5 mg daily.' }]);
  const listing = { ...base, classificationSignals: (item: Parameters<typeof base.classificationSignals>[0]) => ({ ...base.classificationSignals(item), labels: ['rc-private'] }) };
  const sync = () => f.set.sync(listing, { fetchContent: true, placement: FIXTURE_PLACEMENT });
  let calls = 0;
  const model = { async complete() {
    calls += 1;
    return { modelId: BUILT_IN_SNIFFER_LANE.modelId, text: JSON.stringify({ verdicts: [{ i: 1, tier: 'private', category: 'health', ownRecord: true, privateKind: 'health', confidence: 0.99 }] }) };
  } };
  const tick = async () => {
    rejudgeRoutedItems({ set: f.set, autoMoves: true });
    await runSnifferPass({ targets: [{ ledger: f.ledger, sniffer: queue, placementFor: (d) => f.set.placementFor(d) }], lane: BUILT_IN_SNIFFER_LANE, model });
    const row = f.ledger.getCurrent(identityOf('record'))!;
    if (row.state === 'moving') {
      await moveTieredItem({ set: f.set, identity: identityOf('record'), target: { metadataTier: row.targetMetadataTier!, contentTier: row.targetContentTier! }, expectedGeneration: row.generation });
    }
  };
  await sync();
  await tick();
  const judged = f.ledger.getCurrent(identityOf('record'))!;
  expect(judged).toMatchObject({ state: 'current', contentTier: 'secure', decidedBy: 'sniffer' });
  for (let round = 0; round < 3; round++) {
    await sync();
    expect(f.ledger.getCurrent(identityOf('record'))).toMatchObject({ state: 'current', contentTier: 'secure', generation: judged.generation });
    await tick();
  }
  expect(f.ledger.getCurrent(identityOf('record'))!.generation).toBe(judged.generation);
  expect(queue.counts().questions).toBe(0);
  expect(calls).toBe(1);
});

test('a judged item that is renamed or moved is judged again, even with the same text', async () => {
  const queue = new TierSnifferStore({ dbPath: ':memory:' });
  cleanups.push(() => queue.close());
  const f = lane(new CachedTierSniffer(queue, BUILT_IN_SNIFFER_LANE));
  let name = 'Visit notes';
  const connector = fixtureConnector(() => [{ id: 'note', name, text: 'Saw the doctor on Tuesday; everything looked fine.' }]);
  const sync = () => f.set.sync(connector, { fetchContent: true, placement: FIXTURE_PLACEMENT });
  let calls = 0;
  const model = { async complete() {
    calls += 1;
    return { modelId: BUILT_IN_SNIFFER_LANE.modelId, text: JSON.stringify({ verdicts: [{ i: 1, tier: 'personal', category: 'ordinary', ownRecord: false, privateKind: 'none', confidence: 0.99 }] }) };
  } };
  const pass = () => runSnifferPass({ targets: [{ ledger: f.ledger, sniffer: queue, placementFor: (d) => f.set.placementFor(d) }], lane: BUILT_IN_SNIFFER_LANE, model });
  await sync();
  await pass();
  expect(f.ledger.getCurrent(identityOf('note'))).toMatchObject({ state: 'current', contentPending: false });
  expect(f.ledger.getCurrent(identityOf('note'))!.reasons.some((reason) => reason.endsWith(':ordinary:0.99'))).toBe(true);
  // Unchanged: the recorded verdict stands, nothing is asked.
  await sync();
  expect(f.ledger.getCurrent(identityOf('note'))).toMatchObject({ state: 'current', contentPending: false });
  expect(queue.counts().questions).toBe(0);
  // Same text under a new name and folder: the model is asked about it again.
  name = 'Medical records 2026';
  await sync();
  expect(queue.counts().questions).toBe(1);
  await pass();
  expect(calls).toBe(2);
});
