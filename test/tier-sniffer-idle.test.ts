import { Database } from 'bun:sqlite';
import { afterEach, expect, spyOn, test } from 'bun:test';
import { join } from 'node:path';
import { BUILT_IN_SNIFFER_LANE } from '../src/workers/classification/built-in-sniffer.ts';
import { InstalledTierClassification } from '../src/workers/classification/installed-tier-classification.ts';
import { registerInstalledTierClassification } from '../src/workers/classification/installed-tier-classification-registry.ts';
import { storedPersonalLoweringLap, TierSnifferService } from '../src/workers/classification/sniffer-service.ts';
import { TierSnifferStore } from '../src/workers/classification/sniffer-store.ts';
import { snifferId, snifferPromptVersions } from '../src/workers/classification/sniffer.ts';
import { classifyItemTiers, PERSONAL_FIRST_REASON, TIER_CLASSIFIER_VERSION } from '../src/workers/classification/tier-classifier.ts';
import { PERSONAL_FIRST_SETTLE_DONE, TierLedger } from '../src/workers/classification/tier-ledger.ts';
import { writeOwnerTierRules } from '../src/workers/classification/tier-rules.ts';
import { TieredStoreSet } from '../src/workers/connector-store/tiered-store-set.ts';
import { reopenLabelRuleSweep, sweepLabelRuleRaises, sweepOwnerRuleRaises } from '../src/workers/connector-store/tier-rules-sweep.ts';
import { settlePersonalFirstItems } from '../src/workers/connector-store/tier-held-settle.ts';
import { createTestClock } from './helpers/test-clock.ts';
import { FIXTURE_PLACEMENT, JUDGED_PERSONAL_SNIFFER, fixtureConnector, identityOf, localId, openTierFixture, tempDir } from './helpers/tier-fixtures.ts';

const cleanup: Array<() => void> = [];
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close(); });

function fixture(autoMoves = false) {
  const tmp = tempDir('tier-sniffer-idle-');
  const clock = createTestClock();
  const f = openTierFixture(tmp.dir, { embed: false, now: clock.date });
  const rulesPath = join(tmp.dir, 'rules.json');
  let ownerWords: string | undefined;
  let folder = 'index.txt';
  let folderRevision = 0;
  const ownerContext = () => ownerWords;
  const installed = new InstalledTierClassification({
    env: { OLYMPUS_TIER_RULES_PATH: rulesPath }, lane: BUILT_IN_SNIFFER_LANE, now: clock.date, ownerContext,
  });
  registerInstalledTierClassification(installed);
  const set = new TieredStoreSet({
    setId: 'idle-fixture', ledger: f.ledger, contentArrivesLater: true,
    legs: f.set.openStores().map(store => ({ store, corpusId: store.corpusId, trustDomain: store.trustDomain, legacy: true })),
    namesOnlyByOwner: Object.assign((path: string) => path.endsWith(folder), { revision: () => String(folderRevision) }),
  });
  const service = new TierSnifferService({
    installed, lane: BUILT_IN_SNIFFER_LANE, now: clock.date, ownerContext,
    stores: () => set.openStores(), classificationLedgerPath: join(tmp.dir, 'classification.jsonl'),
    ...(autoMoves ? { autoMoves: { embeddingLedgerPath: join(tmp.dir, 'embedding.jsonl'), localEmbeddingsOnly: () => true } } : {}),
    autoApproveBuiltIn: true, ingestionTurn: () => undefined,
    model: { async complete() {
      return { modelId: 'test-judge', text: '{"verdicts":[{"i":1,"tier":"personal","category":"ordinary","confidence":0.99,"ownRecord":false,"privateKind":"none"}]}' };
    } },
  });
  cleanup.push(() => { service.stop(); registerInstalledTierClassification(undefined); installed.close(); f.close(); tmp.cleanup(); });
  const tick = async () => {
    await clock.advance(1_000);
    const result = await service.runOnce();
    expect(result.state).toBe('ran');
    return result;
  };
  return {
    ...f, set, service, installed, clock, tick, rulesPath, setOwnerWords: (words: string) => { ownerWords = words; },
    setFolder(next: string, versioned = true) { folder = next; if (versioned) folderRevision++; },
    readWindows: () => [
      spyOn(f.ledger, 'listAwaitingTextWindowSteps'), spyOn(f.ledger, 'listPersonalFirstWindowSteps'),
      spyOn(f.ledger, 'rejudgeCandidatePageSteps'), spyOn(f.ledger, 'listRoutedSteps'),
      spyOn(f.ledger, 'listRoutedOverridesSteps'), spyOn(f.ledger, 'listClearedOverrideRowsSteps'),
      spyOn(f.ledger, 'staleEmbedHoldSteps'), spyOn(f.ledger, 'storedPersonalLoweringSteps'),
    ],
  };
}

type Fixture = ReturnType<typeof fixture>;

async function storeUnread(f: Fixture, name: string) {
  const identity = identityOf(name);
  await f.set.sync(fixtureConnector(() => [{ id: name, name }]), {
    fetchContent: true, placement: FIXTURE_PLACEMENT,
  }, { settle: false });
  const row = classifyItemTiers({ signals: { title: name }, hasNonTextContent: true });
  expect(row.reasons).toContain('content:unread');
  f.ledger.recordRoutedPlacement(identity, row, f.set.placementFor(row));
  return identity;
}

test('settled ledgers read no background tier item windows on idle ticks', async () => {
  const f = fixture();
  const row = classifyItemTiers({ signals: { title: 'Index' }, namesOnly: true });
  f.ledger.recordRoutedPlacement(identityOf('settled'), row, f.set.placementFor(row));
  await f.tick();
  await f.tick();
  const reads = f.readWindows();
  const marker = f.ledger.changeMarker();
  for (let tick = 0; tick < 5; tick++) await f.tick();
  for (const read of reads) expect(read).not.toHaveBeenCalled();
  // Idle ticks write nothing to the ledger either, progress meta included.
  expect(f.ledger.changeMarker()).toBe(marker);
  expect(f.service.backlog().storedWalks?.[0]).toMatchObject({
    ledger: 'idle-fixture',
    walkers: {
      namesOnly: { reason: 'idle_unchanged', lastResult: 'no_work' },
      personalFirst: { reason: 'retired', lastResult: 'retired' },
      legacyPersonalBodies: { reason: 'retired', lastResult: 'retired' },
      personalLowerings: { reason: 'idle_unchanged', lastResult: 'no_work' },
      rejudge: { reason: 'idle_unchanged', lastResult: 'no_work' },
      staleEmbedHolds: { reason: 'idle_unchanged', lastResult: 'no_work' },
    },
  });
});

// Recreate the old writer's durable decision, keeping the actual held store copies.
async function storedPersonalRows(f: Fixture, ids: string[]) {
  const text = 'Bring bananas to the picnic.';
  await f.set.sync(fixtureConnector(() => ids.map(id => ({ id, name: 'Picnic list', text }))), {
    fetchContent: true, placement: FIXTURE_PLACEMENT, tierClassification: { holdContentUntilJudged: true },
  }, { settle: false });
  const decision = classifyItemTiers({ signals: { title: 'Picnic list' }, text, holdUntilJudged: true }, { sniffer: JUDGED_PERSONAL_SNIFFER });
  const db = new Database(f.ledger.dbPath);
  try {
    const update = db.query("UPDATE tier_items SET state = 'current', content_pending = 0, reasons_json = ? WHERE provider_item_id = ?");
    for (const id of ids) {
      expect(f.ledger.copies(identityOf(id))).toContainEqual(expect.objectContaining({ layers: 'content', trustDomain: 'secure_local', embedHold: true }));
      update.run(JSON.stringify(decision.reasons), id);
    }
  } finally { db.close(); }
  return text;
}

test('repair resumes after its page, even after stale holds clear, and the normal drain moves the judged bytes', async () => {
  const f = fixture(true);
  const ids = ['a-held', 'b-held'];
  const text = await storedPersonalRows(f, ids);
  const steps = f.ledger.storedPersonalLoweringSteps.bind(f.ledger);
  spyOn(f.ledger, 'storedPersonalLoweringSteps').mockImplementation(options => steps({ ...options, limit: 1 }));
  // These are settled decisions. The existing question donor can be absent.
  for (const id of ids) {
    const identity = identityOf(id);
    f.installed.snifferStoreForLedger(f.ledger.dbPath).deleteQuestion(identity, 'content');
    f.ledger.markJudged(identity, { engineVersion: TIER_CLASSIFIER_VERSION, snifferId: f.set.classification()!.sniffer!.id });
  }
  for (const id of ids) {
    const tick = await f.tick();
    expect(tick.state === 'ran' && tick.report.calls).toBe(0);
    expect(tick.state === 'ran' && tick.autoMoves?.moved).toBe(1);
    expect(f.ledger.copies(identityOf(id))).toEqual([expect.objectContaining({ trustDomain: 'internal', layers: 'both', embedHold: false })]);
    expect(f.stores.internal!.localContent(localId(id))?.chunks.join('')).toBe(text);
  }
});

test('a repair page rechecks overrides, open questions, write intents and verdict evidence on the writer', async () => {
  const f = fixture();
  const ids = ['override', 'owner-rule', 'pending', 'moving', 'secret', 'rejudge', 'intent', 'staged', 'mixed', 'fail-safe', 'two-receipts', 'unchanged'];
  await storedPersonalRows(f, ids);
  const page = f.ledger.readSteps(f.ledger.storedPersonalLoweringSteps({ limit: 100 }));
  expect(page.records).toHaveLength(ids.length);
  f.ledger.setOverride(identityOf('override'), { kind: 'not_secret' });
  const db = new Database(f.ledger.dbPath);
  try {
    for (const [id, reason] of [['owner-rule', 'metadata:owner_rule:sender:fixture:prior'], ['fail-safe', 'content:sniffer:model:unresolved:0.00'],
      ['two-receipts', 'content:sha256:other']] as const) {
      db.query("UPDATE tier_items SET reasons_json = json_insert(reasons_json, '$[#]', ?) WHERE provider_item_id = ?").run(reason, id);
    }
    db.exec("UPDATE tier_items SET content_pending = 1, state = 'pending' WHERE provider_item_id = 'pending'");
    db.exec("UPDATE tier_items SET state = 'moving', target_content_tier = 'secure', target_metadata_tier = 'secure' WHERE provider_item_id = 'moving'");
    db.exec("UPDATE tier_items SET content_tier = 'secrets' WHERE provider_item_id = 'secret'");
    db.exec("UPDATE tier_copies SET copy_state = 'staged' WHERE provider_item_id = 'staged' AND layers = 'metadata'");
    // The plan brings both layers to Personal: names would rise from Public as the body comes down.
    db.exec("UPDATE tier_copies SET trust_domain = 'public_safe' WHERE provider_item_id = 'mixed' AND layers = 'metadata'");
    db.exec("UPDATE tier_items SET rejudge_json = '{}' WHERE provider_item_id = 'rejudge'");
  } finally { db.close(); }
  f.ledger.putWriteIntent({ identity: identityOf('intent'), kind: 'deletion', version: 'v2', connectorId: 'fixture' });
  const queued = page.records.filter(row => f.ledger.queueStoredPersonalLowering(identityOf(row.providerItemId), decision => f.set.placementFor(decision)));
  expect(queued.map(row => row.providerItemId)).toEqual(['unchanged']);
  expect(f.ledger.listMoving({ direction: 'raise' }).map(row => row.providerItemId)).toEqual(['moving']);
});

test('repair waits for the full stored sweep and the label receipt for every applicable account in the ledger', async () => {
  const f = fixture();
  await storedPersonalRows(f, ['outside']);
  const identity = identityOf('outside');
  const second = { ...identity, accountScope: 'second' };
  const names = classifyItemTiers({ signals: { title: 'Picnic' }, namesOnly: true });
  f.ledger.recordDecision(second, names);
  writeOwnerTierRules([
    { id: 'folder', match: { kind: 'pathPrefix', value: '/Elsewhere/' }, tier: 'secure', strength: 'force' },
    { id: 'label', source: identity.provider, match: { kind: 'label', value: 'Family' }, tier: 'secure', strength: 'force' },
    { id: 'unrelated', source: 'different-provider', match: { kind: 'label', value: 'Work' }, tier: 'secure', strength: 'force' },
  ], { path: f.rulesPath });
  const repair = () => storedPersonalLoweringLap(f.set, undefined, () => undefined);
  const labels = (accountScope: string) => sweepLabelRuleRaises({
    set: f.set, provider: identity.provider, accountScope, source: { async listLabelled() { return { ids: [] }; } },
  });
  expect(sweepOwnerRuleRaises({ set: f.set, limit: 1 }).complete).toBe(false);
  expect((await labels(identity.accountScope)).pending).toBe(0);
  expect((await labels(second.accountScope)).pending).toBe(0);
  expect(await repair()).toMatchObject({ complete: false });
  reopenLabelRuleSweep(f.ledger, identity.provider, second.accountScope);
  expect(sweepOwnerRuleRaises({ set: f.set, limit: 1 }).complete).toBe(true);
  expect(await repair()).toMatchObject({ complete: false });
  expect(f.ledger.listMoving()).toEqual([]);
  expect((await labels(second.accountScope)).pending).toBe(0);
  expect(await repair()).toMatchObject({ complete: true, changed: true });
  expect(f.ledger.listMoving({ direction: 'lower' }).map(row => row.providerItemId)).toEqual(['outside']);
});

test('a new decided hold wakes the release walk on the next tick', async () => {
  const f = fixture();
  const identity = identityOf('decided');
  const decision = classifyItemTiers({ signals: { title: 'Notes' }, namesOnly: true });
  f.ledger.recordRoutedPlacement(identity, decision, f.set.placementFor(decision));
  await f.tick();
  await f.tick();
  const read = spyOn(f.ledger, 'staleEmbedHoldSteps');
  const db = new Database(f.ledger.dbPath);
  try {
    db.query('UPDATE tier_copies SET embed_hold = 1 WHERE provider_item_id = ?').run(identity.providerItemId);
  } finally {
    db.close();
  }
  await f.tick();
  expect(read).toHaveBeenCalledTimes(1);
  expect(f.ledger.copies(identity)[0]?.embedHold).toBe(false);
  expect(f.service.backlog().storedWalks?.[0]?.walkers.staleEmbedHolds?.lastResult).toBe('changed');
});

test('a new unread item and a folder revision each wake names-only settlement on the next tick', async () => {
  const f = fixture();
  await f.tick();
  await f.tick();
  const identity = await storeUnread(f, 'index.txt');
  expect(f.ledger.getCurrent(identity)?.reasons).toContain('content:unread');
  await f.tick();
  expect(f.ledger.getCurrent(identity)?.reasons).toContain('content:names_only');

  const waiting = await storeUnread(f, 'waiting.txt');
  await f.tick();
  await f.tick();
  expect(f.service.backlog().storedWalks?.[0]?.walkers.namesOnly?.reason).toBe('idle_unchanged');
  expect(f.ledger.getCurrent(waiting)?.reasons).not.toContain('content:names_only');
  f.setFolder('waiting.txt');
  await f.tick();
  expect(f.ledger.getCurrent(waiting)?.reasons).toContain('content:names_only');
});

test('an owner rule edit wakes the raising walk on the next tick', async () => {
  const f = fixture();
  const identity = await storeUnread(f, 'report.txt');
  await f.tick();
  await f.tick();
  expect(f.service.backlog().storedWalks?.[0]?.walkers.ownerRules?.reason).toBe('idle_unchanged');
  writeOwnerTierRules([{ id: 'private-reports', match: { kind: 'pathPrefix', value: '/Files/report.txt' }, tier: 'secure', strength: 'force' }],
    { path: f.rulesPath });
  await f.tick();
  expect(f.ledger.getCurrent(identity)?.reasons).toContain('metadata:owner_rule:pathPrefix:private-reports:force');
});

test('a prompt input change wakes re-judge on the next tick', async () => {
  const f = fixture();
  const identity = identityOf('note');
  const text = 'Bring apples to the garden club picnic.';
  f.setOwnerWords('Gardening notes are ordinary.');
  const before = snifferId(BUILT_IN_SNIFFER_LANE, snifferPromptVersions('Gardening notes are ordinary.').cache);
  registerInstalledTierClassification(undefined);
  await f.set.sync(fixtureConnector(() => [{ id: 'note', name: 'Garden club', text }]), {
    fetchContent: true, placement: FIXTURE_PLACEMENT,
  }, { settle: false });
  registerInstalledTierClassification(f.installed);
  const previousJudge = { id: before, judge: () => ({ verdict: 'decided' as const, tier: 'private' as const, code: 'ordinary:0.99', origin: 'model' as const }) };
  const decision = classifyItemTiers({ signals: {}, text }, { sniffer: previousJudge });
  decision.reasons.push(`metadata:sniffer:${before}:ordinary:0.99`);
  f.ledger.recordRoutedPlacement(identity, decision, f.set.placementFor(decision));
  expect(f.ledger.getCurrent(identity)).toMatchObject({ state: 'current', contentRead: true });
  f.ledger.markJudged(identity, { engineVersion: TIER_CLASSIFIER_VERSION, snifferId: before });
  f.installed.snifferStoreForLedger(f.ledger.dbPath).deleteQuestion(identity, 'content');
  f.installed.snifferStoreForLedger(f.ledger.dbPath).deleteQuestion(identity, 'metadata');
  await f.tick();
  await f.tick();
  expect(f.service.backlog().storedWalks?.[0]?.walkers.rejudge?.reason).toBe('idle_unchanged');
  f.setOwnerWords('Gardening club membership is private.');
  const tick = await f.tick();
  expect(tick.state === 'ran' && tick.rejudged).toMatchObject({ causeOwnerWords: 1, asked: 1 });
});

test('the hourly backstop reaches the end after a missed folder revision', async () => {
  const f = fixture();
  await storeUnread(f, 'a.txt');
  const pending = await storeUnread(f, 'z.txt');
  await f.tick();
  await f.tick();
  const window = f.ledger.listAwaitingTextWindowSteps.bind(f.ledger);
  const read = spyOn(f.ledger, 'listAwaitingTextWindowSteps')
    .mockImplementation(options => window({ ...options, limit: 1, examine: 1 }));
  f.setFolder('z.txt', false);
  await f.tick();
  expect(read).not.toHaveBeenCalled();
  await f.clock.advance(60 * 60_000);
  expect(f.service.backlog().storedWalks?.[0]?.walkers.namesOnly?.reason).toBe('backstop_due');
  const holds = spyOn(f.ledger, 'staleEmbedHoldSteps');
  expect(f.service.backlog().storedWalks?.[0]?.walkers.staleEmbedHolds?.reason).toBe('backstop_due');
  await f.tick();
  expect(holds).toHaveBeenCalledTimes(1);
  expect(f.ledger.getCurrent(pending)?.reasons).not.toContain('content:names_only');
  await f.tick();
  expect(f.ledger.getCurrent(pending)?.reasons).toContain('content:names_only');
});

test('a failed window stays eligible for retry on the next tick', async () => {
  const f = fixture();
  const pending = await storeUnread(f, 'index.txt');
  const read = spyOn(f.ledger, 'listAwaitingTextWindowSteps').mockImplementationOnce(() => {
    throw new Error('window read failed');
  });
  await f.tick();
  expect(f.service.backlog().storedWalks?.[0]?.walkers.namesOnly).toMatchObject({ reason: 'working', lastResult: 'read_failed' });
  expect(f.ledger.getCurrent(pending)?.reasons).not.toContain('content:names_only');
  await f.tick();
  expect(read).toHaveBeenCalledTimes(2);
  expect(f.ledger.getCurrent(pending)?.reasons).toContain('content:names_only');
});

test('store-only photo judgment writes wake a bounded media walk', async () => {
  const f = fixture();
  await f.tick();
  await f.tick();
  const store = f.stores.internal!;
  const read = spyOn(store, 'unappliedMediaJudgmentKeys');
  const digest = (index: number) => index.toString(16).padStart(64, '0');
  const db = new Database(store.dbPath);
  try {
    const insert = db.query(`INSERT INTO media_judgments (media_sha256, verdict, judge_id, judged_at)
      VALUES (?, 'ordinary', 'fixture', ?)`);
    db.transaction(() => {
      for (let index = 1; index <= 201; index++) insert.run(digest(index), f.clock.date().toISOString());
    })();
  } finally {
    db.close();
  }
  await f.tick();
  expect(read).toHaveBeenCalledTimes(1);
  expect(store.unappliedMediaJudgments().map(row => row.mediaSha256)).toEqual([digest(201)]);
  await f.tick();
  expect(read.mock.calls[1]?.[0]).toBe(digest(200));
  expect(store.unappliedMediaJudgments()).toEqual([]);
});

test('Personal-first settlement retires after verifying the ledger', () => {
  const f = fixture();
  const read = spyOn(f.ledger, 'listPersonalFirstWindowSteps');
  const identity = identityOf('legacy');
  const legacy = {
    ...classifyItemTiers({ signals: { title: 'Notes' }, text: 'Ordinary notes.' }),
    reasons: [PERSONAL_FIRST_REASON], state: 'pending' as const, contentPending: true,
  };
  f.ledger.recordRoutedPlacement(identity, legacy, f.set.placementFor(legacy));
  expect(settlePersonalFirstItems({ set: f.set }).settled).toBe(1);
  expect(f.ledger.getCurrent(identity)?.reasons).not.toContain(PERSONAL_FIRST_REASON);
  settlePersonalFirstItems({ set: f.set });
  read.mockClear();
  settlePersonalFirstItems({ set: f.set });
  expect(read).not.toHaveBeenCalled();
});

test('a fresh ledger retires after its first Personal-first lap', () => {
  const f = fixture();
  const read = spyOn(f.ledger, 'listPersonalFirstWindowSteps');
  settlePersonalFirstItems({ set: f.set });
  expect(read).toHaveBeenCalledTimes(1);
  const reopened = new TierLedger({ dbPath: f.ledger.dbPath, readOnly: true });
  try {
    expect(reopened.readMeta(PERSONAL_FIRST_SETTLE_DONE)).toBe('1');
  } finally {
    reopened.close();
  }
  settlePersonalFirstItems({ set: f.set });
  expect(read).toHaveBeenCalledTimes(1);
});

test('work counts match a fresh count across queue changes', () => {
  const tmp = tempDir('sniffer-work-counts-');
  const path = join(tmp.dir, 'questions.sqlite');
  const queue = new TierSnifferStore({ dbPath: path });
  const writer = new TierSnifferStore({ dbPath: path });
  const db = new Database(path, { readonly: true });
  cleanup.push(() => { db.close(); writer.close(); queue.close(); tmp.cleanup(); });
  const a = identityOf('a');
  const b = identityOf('b');
  const check = () => {
    for (const id of ['judge', 'other']) {
      const fresh = db.query(`SELECT
        COUNT(CASE WHEN held_sniffer_id IS NULL OR held_sniffer_id != ? THEN 1 END) AS unanswered,
        COUNT(CASE WHEN held_sniffer_id = ? THEN 1 END) AS heldLowering FROM sniffer_questions`)
        .get(id, id) as ReturnType<TierSnifferStore['questionWorkCounts']>;
      expect(queue.questionWorkCounts(id)).toEqual(fresh);
      expect(queue.questionWorkCounts(id)).toEqual(fresh);
    }
  };
  const statement = spyOn((queue as unknown as { db: Database }).db, 'query');
  check();
  expect(statement.mock.calls.filter(([sql]) => sql.includes('COUNT('))).toHaveLength(2);
  queue.enqueue({ subject: a, pass: 'content', material: 'First item', flags: [], mapRevision: 'none' });
  writer.enqueue({ subject: b, pass: 'content', material: 'Second item', flags: [], mapRevision: 'none' });
  check();
  const beforeScan = statement.mock.calls.filter(([sql]) => sql.includes('COUNT(')).length;
  queue.listQuestions({ eligible: () => true });
  check();
  expect(statement.mock.calls.filter(([sql]) => sql.includes('COUNT('))).toHaveLength(beforeScan);
  queue.markHeldLowering(queue.questionFor(a, 'content')!, 'judge');
  check();
  writer.deleteQuestion(a, 'content');
  queue.deleteQuestion(b, 'content');
  check();
});
