import { Database } from 'bun:sqlite';
import { afterEach, expect, test } from 'bun:test';
import { join } from 'node:path';
import type { RawItem } from '../src/core/contracts.ts';
import type { BuiltInAnalystModel } from '../src/core/analyst-built-in.ts';
import { buildSourceIndexCorpusRegistry } from '../src/core/source-index/corpus.ts';
import { buildSourceSensitivity } from '../src/core/source-index/types.ts';
import { BUILT_IN_SNIFFER_LANE } from '../src/workers/classification/built-in-sniffer.ts';
import { InstalledTierClassification } from '../src/workers/classification/installed-tier-classification.ts';
import { registerInstalledTierClassification } from '../src/workers/classification/installed-tier-classification-registry.ts';
import { tierLedgerPathForStore } from '../src/workers/classification/tier-ledger-path.ts';
import { placePersonalBody } from '../src/workers/connector-store/place-personal-body.ts';
import { TierLedger } from '../src/workers/classification/tier-ledger.ts';
import { TierSnifferService } from '../src/workers/classification/sniffer-service.ts';
import { HELD_UNTIL_JUDGED_REASON, classifyItemTiers, contentDigestReason } from '../src/workers/classification/tier-classifier.ts';
import {
  CONNECTOR_STORE_DEFAULT_MAX_CHUNK_CHARS, LocalConnectorStore, connectorStoreChunkText,
  connectorStoreHashString, defineConnectorCorpus,
} from '../src/workers/connector-store/index.ts';
import { settleLegacyPersonalBodiesOffThread } from '../src/workers/connector-store/legacy-personal-bodies.ts';
import { createReleaseTierCheck, createTierVisibilityGate } from '../src/workers/connector-store/tier-visibility.ts';
import { TieredStoreSet } from '../src/workers/connector-store/tiered-store-set.ts';
import { createXBookmarksSourceConnector, xBookmarkRawItemFromPost, X_BOOKMARKS_LIVE_CONNECTOR_ID } from '../src/workers/x-bookmarks/connector.ts';
import { X_BOOKMARKS_CORPUS_ID } from '../src/workers/x-bookmarks/corpus-adapter.ts';
import { createLocalAnswerPath } from '../src/workers/engine/runtime/local-private-answers.ts';
import { createSourceAnswerLanes } from '../src/workers/engine/runtime/source-answer-lanes.ts';
import { BUILT_IN_EMBEDDING_PROVIDER, loadedBuiltInEmbedding } from '../src/workers/source-index/built-in-embedding/provider.ts';
import { QWEN35_4B } from '../src/workers/source-index/built-in-reasoning/manifest.ts';
import {
  ACCOUNT, JUDGED_PERSONAL_SNIFFER, RecordingProvider, fixtureConnector, fixtureItem, identityOf,
  openLegStore, openTierFixture, snapshotStore, storePaths, tempDir, type FixtureSpec,
} from './helpers/tier-fixtures.ts';

const cleanups: Array<() => void> = [];
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); });

function fixture(tmp = tempDir('olympus-legacy-personal-'), options: { maxCallsPerPass?: number; onlyPersonalMounted?: boolean; localEmbeddingsOnly?: boolean } = {}) {
  const f = openTierFixture(tmp.dir);
  const logs: string[] = [];
  const installed = new InstalledTierClassification({
    env: { OLYMPUS_TIER_RULES_PATH: join(tmp.dir, 'rules.json') },
    lane: BUILT_IN_SNIFFER_LANE,
  });
  registerInstalledTierClassification(installed);
  let judgeReady = false;
  const service = new TierSnifferService({
    installed,
    lane: BUILT_IN_SNIFFER_LANE,
    stores: () => options.onlyPersonalMounted ? [f.stores.internal!] : f.set.openStores(),
    classificationLedgerPath: join(tmp.dir, 'classification.jsonl'),
    autoMoves: { embeddingLedgerPath: join(tmp.dir, 'embedding.jsonl'), localEmbeddingsOnly: () => options.localEmbeddingsOnly ?? true },
    autoApproveBuiltIn: true,
    ingestionTurn: () => undefined,
    ...(options.maxCallsPerPass ? { maxCallsPerPass: options.maxCallsPerPass } : {}),
    log: message => logs.push(message),
    modelAvailable: () => judgeReady,
    model: { async complete() {
      return { modelId: 'test-judge', text: '{"verdicts":[{"i":1,"tier":"personal","category":"ordinary","confidence":0.99,"ownRecord":false,"privateKind":"none"}]}' };
    } },
  });
  cleanups.push(() => { service.stop(); registerInstalledTierClassification(undefined); installed.close(); f.close(); tmp.cleanup(); });
  return { ...f, service, installed, logs, enableJudge() { judgeReady = true; } };
}

async function answerPrivately(f: ReturnType<typeof fixture>) {
  const scopes = () => [{ ledger: f.ledger, corpusIds: new Set(f.set.openStores().map(store => store.corpusId)) }];
  const lanes = createSourceAnswerLanes({
    stores: () => f.set.openStores(),
    registry: () => buildSourceIndexCorpusRegistry(f.set.openStores().map(store => defineConnectorCorpus({
      corpusId: store.corpusId, family: store.family, trustDomain: store.trustDomain,
    }))),
    embeddingProvider: () => undefined,
    localEmbedding: loadedBuiltInEmbedding,
    readScope: () => ({ allowed: true, contentAllowed: true }),
    answerScope: () => ({ kind: 'search' }),
    accountScope: () => undefined,
    visibilityGate: createTierVisibilityGate(scopes),
  });
  const prompts: unknown[] = [];
  const model: BuiltInAnalystModel = {
    name: 'built_in',
    spec: QWEN35_4B,
    async prepare() {},
    status: () => ({ state: 'ready', modelId: QWEN35_4B.modelId, percent: 100, label: '', bytesDone: 0, bytesTotal: 0, updatedAt: new Date(0).toISOString() }),
    async stop() {},
    async complete(request) {
      prompts.push(request);
      return { text: JSON.stringify({
        answer: 'The picnic begins at noon [1].',
        citations: [{ evidence: 1, claim: 'The picnic begins at noon.' }],
        unanswered: [],
        sufficient: true,
      }), modelId: `built_in/${QWEN35_4B.modelId}` };
    },
  };
  const path = createLocalAnswerPath({
    releaseCheck: createReleaseTierCheck(scopes, () => 'approval'),
    lanes, model, available: () => true, relevanceEmbedding: () => undefined,
  });
  const answer = await path.answer({ question: MARKER, selectors: { retrieval_mode: 'keyword' } });
  expect(answer).toMatchObject({
    status: 'answered', answer: 'The picnic begins at noon.',
    citations: [expect.objectContaining({ title: 'Picnic notes' })],
    read: [expect.objectContaining({ trustDomain: 'secure_local', corpusId: f.stores.secure_local!.corpusId })],
  });
  expect(JSON.stringify(prompts)).toContain(BODY);
}

const MARKER = 'orchardlantern';
const BODY = 'The orchardlantern picnic begins at noon. Bring oranges and a blanket.';

/** A historical connector store writer with no tier ledger. */
async function seedLegacy(dir: string, rows: FixtureSpec[], provider?: RecordingProvider) {
  const store = openLegStore(storePaths(dir), 'internal', null);
  try {
    await store.syncFromConnector(fixtureConnector(() => rows), {
      fetchContent: true,
      placement: () => buildSourceSensitivity({ trustTier: 'S1', trustDomain: 'internal' }),
    });
    if (provider) {
      expect((await store.embedChunks({ provider })).chunksEmbedded).toBe(rows.length);
      expect(await store.vectorSearchItems(MARKER, provider, 10)).toHaveLength(rows.length);
    }
  } finally {
    store.close();
  }
}

test('the installed tier service hides old Personal text and judges it without a new listing', async () => {
  const tmp = tempDir('olympus-legacy-personal-');
  const vectors = new RecordingProvider(BUILT_IN_EMBEDDING_PROVIDER, 'test-embedder', 'local');
  await seedLegacy(tmp.dir, [{ id: 'old-picnic', name: 'Picnic notes', text: BODY }], vectors);
  const f = fixture(tmp, { onlyPersonalMounted: true });
  const personal = f.stores.internal!;
  const secure = f.stores.secure_local!;
  const identity = identityOf('old-picnic');
  expect(personal.searchItems(MARKER, 10)).toHaveLength(1);
  expect(snapshotStore(personal.dbPath).vectors).toHaveLength(1);
  expect(f.ledger.getCurrent(identity)).toBeUndefined();
  expect(personal.tierSetBinding()).toBeUndefined();
  expect(personal.tierLedgerPathInUse()).toBe(f.ledger.dbPath);

  expect((await f.service.runOnce()).state).toBe('model_unavailable');
  expect(personal.searchItems(MARKER, 10)).toEqual([]);
  expect(await personal.vectorSearchItems(MARKER, vectors, 10)).toEqual([]);
  expect(snapshotStore(personal.dbPath).vectors).toEqual([]);
  expect(secure.exportItemCopy(identity)?.chunks.map(chunk => chunk.boundedText).join('')).toBe(BODY);
  expect(f.ledger.getCurrent(identity)).toMatchObject({ contentPending: true, reasons: expect.arrayContaining([HELD_UNTIL_JUDGED_REASON]) });
  expect(f.ledger.copies(identity)).toContainEqual(expect.objectContaining({ trustDomain: 'secure_local', state: 'current', embedHold: true }));

  expect(f.service.backlog().legacyPersonalBodies).toEqual({ held: 1, judged: 0 });
  expect(f.logs.filter(line => line.startsWith('Olympus tier hold: 1 item(s)'))).toHaveLength(1);
  await answerPrivately(f);
  expect(f.ledger.getCurrent(identity)?.contentPending).toBe(true);

  f.enableJudge();
  for (let tick = 0; tick < 3 && !personal.searchItems(MARKER, 10).length; tick++) {
    expect((await f.service.runOnce()).state).toBe('ran');
  }
  expect(f.ledger.getCurrent(identity)).toMatchObject({ contentPending: false, state: 'current',
    reasons: expect.arrayContaining([contentDigestReason(BODY)]) });
  expect(personal.searchItems(MARKER, 10).map(row => row.sourceItem.providerItemId)).toEqual(['old-picnic']);
  expect(personal.exportItemCopy(identity)?.chunks.map(chunk => chunk.boundedText).join('')).toBe(BODY);
  expect(f.service.backlog().legacyPersonalBodies).toEqual({ held: 1, judged: 1 });
});

test('an interrupted hold finishes privately after the embedding choice changes, while new items stay searchable', async () => {
  const tmp = tempDir('olympus-legacy-personal-');
  const rows = [
    { id: 'first', name: 'Shopping list', text: 'Fresh tomatoes for the salad.' },
    { id: 'second', name: 'Picnic notes', text: BODY },
  ];
  await seedLegacy(tmp.dir, rows);
  const settings = { localEmbeddingsOnly: true };
  const f = fixture(tmp, settings);
  const queue = f.installed.snifferStoreForLedger(f.ledger.dbPath);
  expect(await settleLegacyPersonalBodiesOffThread({ set: f.set, queue, limit: 1 })).toMatchObject({ held: 1 });
  settings.localEmbeddingsOnly = false;
  await f.service.runOnce();
  expect(f.stores.internal!.searchItems('tomatoes', 10).map(hit => hit.sourceItem.providerItemId)).toEqual(['first']);
  expect(f.ledger.getCurrent(identityOf('first'))).toBeUndefined();
  expect(f.ledger.getCurrent(identityOf('second'))).toMatchObject({ state: 'pending', contentPending: true });
  expect(f.service.backlog().legacyPersonalBodies).toEqual({ held: 1, judged: 0, waiting: 1 });
  await answerPrivately(f);
});

test('a Secret in legacy text takes the Secrets path instead of reaching the judge', async () => {
  const tmp = tempDir('olympus-legacy-personal-');
  const identity = identityOf('secret');
  const text = 'Legacysecretmarker contains ' + '-----BEGIN ' + 'PRIVATE KEY-----';
  await seedLegacy(tmp.dir, [{ id: 'secret', name: 'Deployment notes', text }]);
  const f = fixture(tmp);
  const personal = f.stores.internal!;
  expect(personal.searchItems('Legacysecretmarker', 10)).toHaveLength(1);

  await f.service.runOnce();
  expect(f.ledger.getCurrent(identity)).toMatchObject({ contentTier: 'secrets', contentPending: false });
  expect(f.secrets.get(identity)?.findingKinds).toContain('private_key_material');
  for (const store of f.set.openStores()) {
    expect(store.searchItems('Legacysecretmarker', 10)).toEqual([]);
    expect(store.exportItemCopy(identity)).toBeUndefined();
  }
  expect(f.installed.snifferStoreForLedger(f.ledger.dbPath).questionFor(identity, 'content')).toBeUndefined();
});

test('a paused walk only counts Secret candidates and resumes at the saved page without double counting', async () => {
  const tmp = tempDir('olympus-legacy-personal-');
  const text = 'Legacysecretmarker contains ' + '-----BEGIN ' + 'PRIVATE KEY-----';
  await seedLegacy(tmp.dir, ['a', 'b'].map(id => ({ id, name: 'Deployment notes', text })));
  const f = fixture(tmp);
  const queue = f.installed.snifferStoreForLedger(f.ledger.dbPath);
  const step = () => settleLegacyPersonalBodiesOffThread({ set: f.set, queue, movesAvailable: () => false, limit: 1 });
  for (const waiting of [1, 2, 2, 2]) {
    expect(await step()).toMatchObject({ held: 0, secrets: 0, failed: 0 });
    expect(f.service.backlog().legacyPersonalBodies).toEqual({ held: 0, judged: 0, waiting });
  }
  expect(f.stores.internal!.searchItems('Legacysecretmarker', 10)).toHaveLength(2);
  for (const id of ['a', 'b']) {
    expect(f.ledger.getCurrent(identityOf(id))).toBeUndefined();
    expect(f.secrets.get(identityOf(id))).toBeUndefined();
  }
});

test('a legacy Personal verdict for the exact text leaves the stored row alone', async () => {
  const f = fixture();
  const row = { id: 'cleared', name: 'Picnic list', text: BODY };
  const identity = identityOf(row.id);
  const personal = f.stores.internal!;
  await personal.syncFromConnector(fixtureConnector(() => [row]), { fetchContent: true });
  const decision = classifyItemTiers({ signals: { title: row.name }, text: row.text }, { sniffer: JUDGED_PERSONAL_SNIFFER });
  expect(decision.reasons).toContain(contentDigestReason(row.text));
  f.ledger.recordDecision(identity, decision, { trustDomain: 'internal', trustTier: 'S3' });
  const before = f.ledger.getCurrent(identity);
  expect(before?.routed).toBe(false);
  const oldCopy = personal.exportItemCopy(identity);

  await f.service.runOnce();
  expect(personal.searchItems(MARKER, 10)).toHaveLength(1);
  expect(personal.exportItemCopy(identity)).toEqual(oldCopy);
  expect(f.ledger.getCurrent(identity)).toEqual(before);
  expect(f.stores.secure_local!.exportItemCopy(identity)).toBeUndefined();
});

function restoreLegacyRepresentation(store: LocalConnectorStore, raw: RawItem, text: string,
  syncConnectorId: string, ownerConnectorId: string): void {
  const contentHash = connectorStoreHashString(text);
  const item = { ...raw, content: { kind: 'text', text } as const, metadata: Object.freeze({ ...raw.metadata, contentHash }) };
  const restored = store.restoreItemRepresentations({
    items: [{ item, expectation: { sourceItem: item.identity, contentHash,
      ...(item.identity.sourceVersion ? { sourceVersion: item.identity.sourceVersion } : {}),
      chunkContentHashes: connectorStoreChunkText(text, CONNECTOR_STORE_DEFAULT_MAX_CHUNK_CHARS).map(connectorStoreHashString) } }],
    syncConnectorId,
    ownerConnectorId,
    ownershipKind: 'observed',
    preserveStoredSearchTextOwnedFacets: true,
    classify: () => buildSourceSensitivity({ trustTier: 'S1', trustDomain: 'internal' }),
  });
  expect(restored.counts.itemsRestored).toBe(1);
}

test.each(['local', 'historical cloud', 'configured cloud'] as const)('the old recovery writer’s S1 X bookmark embedded by %s is found without a re-list', async backend => {
  const tmp = tempDir('olympus-legacy-personal-');
  const personalOptions = {
    dbPath: join(tmp.dir, 'x-internal.sqlite'), family: 'x', trustDomain: 'internal',
    corpusId: X_BOOKMARKS_CORPUS_ID,
  } as const;
  const legacy = new LocalConnectorStore({ ...personalOptions, tierLedger: null });
  cleanups.push(() => legacy.close());
  const source = { id: '2076846914813788163', createdAt: '2026-07-20T12:00:00.000Z' };
  const fetchedAt = '2026-07-30T10:00:00.000Z';
  const text = 'The restored bookmark mentions recoveryorchardmarker and a local trail.';
  const placement = () => buildSourceSensitivity({ trustTier: 'S1', trustDomain: 'internal' });
  await legacy.syncFromConnector(createXBookmarksSourceConnector({
    account: ACCOUNT, posts: [source], fetchedAt,
  }), { fetchContent: true, placement });
  const raw = xBookmarkRawItemFromPost({ ...source, text }, ACCOUNT, [], fetchedAt);
  restoreLegacyRepresentation(legacy, raw, text, 'x_bookmarks_content_recovery', X_BOOKMARKS_LIVE_CONNECTOR_ID);
  const embedder = new RecordingProvider(backend === 'local' ? BUILT_IN_EMBEDDING_PROVIDER : 'historical-x-embedder', 'old-embedder', backend === 'local' ? 'local' : 'cloud');
  expect((await legacy.embedChunks({ provider: embedder })).chunksEmbedded).toBe(1);
  expect(await legacy.vectorSearchItems('recoveryorchardmarker', embedder, 10)).toHaveLength(1);
  const settings = { localEmbeddingsOnly: backend !== 'configured cloud' };
  const f = fixture(tmp, settings);
  const personal = new LocalConnectorStore({ ...personalOptions, tierLedger: f.ledger });
  const secure = new LocalConnectorStore({
    dbPath: join(f.dir, 'x-private.sqlite'), family: 'x', trustDomain: 'secure_local',
    corpusId: 'secure_local.x.bookmarks', tierLedger: f.ledger,
  });
  cleanups.push(() => { personal.close(); secure.close(); });
  expect(personal.searchItems('recoveryorchardmarker', 10)[0]?.trustTier).toBe('S1');
  expect(f.ledger.getCurrent(raw.identity)).toBeUndefined();

  const set = new TieredStoreSet({
    setId: 'x-bookmarks-legacy-fixture', ledger: f.ledger,
    legs: [
      { trustDomain: 'internal', corpusId: personal.corpusId, store: personal },
      { trustDomain: 'secure_local', corpusId: secure.corpusId, store: secure, embeddingProvider: f.local },
    ],
  });
  if (backend === 'configured cloud') {
    for (let pass = 0; pass < 2; pass++) {
      expect((await f.service.runOnce()).state).toBe('model_unavailable');
      expect(f.service.backlog().legacyPersonalBodies).toEqual({ held: 0, judged: 0, waiting: 1 });
      expect(f.ledger.getCurrent(raw.identity)).toBeUndefined();
      expect(personal.searchItems('recoveryorchardmarker', 10)).toHaveLength(1);
      expect(await personal.vectorSearchItems('recoveryorchardmarker', embedder, 10)).toHaveLength(1);
      expect(secure.exportItemCopy(raw.identity)).toBeUndefined();
    }
    settings.localEmbeddingsOnly = true;
    await f.service.runOnce();
    expect(f.service.backlog().legacyPersonalBodies).toEqual({ held: 1, judged: 0 });
    expect(secure.exportItemCopy(raw.identity)?.chunks.map(chunk => chunk.boundedText).join('')).toBe(text);
    expect(snapshotStore(secure.dbPath).vectors).toEqual([]);
    return;
  }
  const queue = f.installed.snifferStoreForLedger(f.ledger.dbPath);
  expect(await settleLegacyPersonalBodiesOffThread({ set, queue })).toMatchObject({ held: 1 });
  // At the end of the walker the old copy is hidden, with the mover still to run.
  expect(personal.searchItems('recoveryorchardmarker', 10)).toEqual([]);
  expect(await personal.vectorSearchItems('recoveryorchardmarker', embedder, 10)).toEqual([]);
  expect(secure.exportItemCopy(raw.identity)).toBeUndefined();
  expect(f.ledger.getCurrent(raw.identity)).toMatchObject({ state: 'moving', contentPending: true });
  expect((await f.service.runOnce()).state).toBe('model_unavailable');
  expect(f.ledger.getCurrent(raw.identity)).toMatchObject({ state: 'pending', contentPending: true });
  expect(secure.exportItemCopy(raw.identity)?.chunks.map(chunk => chunk.boundedText).join('')).toBe(text);
  expect(snapshotStore(personal.dbPath).vectors).toEqual([]);
  if (backend !== 'local') {
    expect(snapshotStore(secure.dbPath).vectors).toEqual([]);
    f.enableJudge();
    for (let tick = 0; tick < 3 && f.ledger.getCurrent(raw.identity)?.contentPending; tick++) await f.service.runOnce();
    expect(f.ledger.getCurrent(raw.identity)).toMatchObject({ contentPending: false,
      reasons: expect.arrayContaining([contentDigestReason(text)]) });
  }
});

test('a one-row page resumes by newest source date and then by descending insertion order', async () => {
  const f = fixture();
  const specs = [
    { id: 'dated-newer', name: 'Newer note', text: 'This is the most recent dated entry.', date: '2026-10-03T00:00:00.000Z' },
    { id: 'undated-first', name: 'Earlier undated note', text: 'This undated entry was inserted first.' },
    { id: 'dated-older', name: 'Older note', text: 'This older dated entry was inserted later.', date: '2026-10-02T00:00:00.000Z' },
    { id: 'undated-last', name: 'Later undated note', text: 'This undated entry was inserted last.' },
  ];
  const connector = fixtureConnector(() => specs);
  const items = specs.map(spec => {
    const item = fixtureItem(spec);
    return spec.date ? { ...item, metadata: { ...item.metadata, authoredAt: spec.date } } : item;
  });
  await f.stores.internal!.syncFromConnector({ ...connector, async *listItems() { yield { items, done: true }; } }, { fetchContent: true });
  const queue = f.installed.snifferStoreForLedger(f.ledger.dbPath);
  const lap = () => settleLegacyPersonalBodiesOffThread({ set: f.set, queue, limit: 1 });
  for (const id of ['dated-newer', 'dated-older', 'undated-last', 'undated-first']) {
    expect(f.ledger.getCurrent(identityOf(id))?.routed).toBeFalsy();
    expect(await lap()).toMatchObject({ checked: 1, held: 1, retired: false });
    expect(f.ledger.getCurrent(identityOf(id))).toMatchObject({ contentPending: true });
  }
  // A clean lap sees no new holds, even when the moves are still queued.
  let retired = false;
  for (let page = 0; page < 6 && !retired; page++) {
    const report = await lap();
    expect(report.held).toBe(0);
    retired = report.retired;
  }
  expect(retired).toBe(true);
  expect(await lap()).toMatchObject({ checked: 0, held: 0, retired: true });
});

test('an earlier Personal verdict does not authorize a changed body', async () => {
  const tmp = tempDir('olympus-legacy-personal-');
  const row = { id: 'changed', name: 'Picnic list', text: BODY, version: 'v2' };
  await seedLegacy(tmp.dir, [row]);
  const f = fixture(tmp);
  const { identity } = fixtureItem(row);
  const oldText = 'The picnic begins at ten.';
  const priorVerdict = classifyItemTiers({ signals: { title: row.name }, text: oldText }, { sniffer: JUDGED_PERSONAL_SNIFFER });
  expect(priorVerdict.reasons).toContain(contentDigestReason(oldText));
  f.ledger.recordDecision(identity, priorVerdict, { trustDomain: 'internal', trustTier: 'S1' });

  await f.service.runOnce();
  expect(f.ledger.getCurrent(identity)).toMatchObject({ contentPending: true });
  expect(f.stores.internal!.searchItems(MARKER, 10)).toEqual([]);
  expect(f.stores.secure_local!.exportItemCopy(identity)?.chunks.map(chunk => chunk.boundedText).join('')).toBe(BODY);
});

test('the walker retries a body replaced after the finder read it', async () => {
  const tmp = tempDir('olympus-legacy-personal-');
  const row = { id: 'replaced', name: 'Picnic list', text: BODY };
  await seedLegacy(tmp.dir, [row]);
  const f = fixture(tmp);
  const personal = f.stores.internal!;
  const queue = f.installed.snifferStoreForLedger(f.ledger.dbPath);
  const text = 'Replacementsecretmarker contains ' + '-----BEGIN ' + 'PRIVATE KEY-----';
  const raw = fixtureItem({ ...row, text, version: 'v2' });

  const skipped = await settleLegacyPersonalBodiesOffThread({
    set: f.set, queue, turn: () => {
      restoreLegacyRepresentation(personal, raw, text, 'fixture_legacy_restore', 'fixture_lane');
      return undefined;
    },
  });
  expect(skipped).toMatchObject({ checked: 1, held: 0, secrets: 0, retired: false });
  expect(f.ledger.getCurrent(raw.identity)).toBeUndefined();
  expect(f.stores.secure_local!.exportItemCopy(raw.identity)).toBeUndefined();

  const retry = await settleLegacyPersonalBodiesOffThread({ set: f.set, queue });
  expect(retry).toMatchObject({ checked: 1, held: 0, secrets: 1, retired: false });
  expect(f.ledger.getCurrent(raw.identity)?.contentTier).toBe('secrets');
  expect(personal.searchItems('Replacementsecretmarker', 10)).toEqual([]);
  expect(f.stores.secure_local!.exportItemCopy(raw.identity)).toBeUndefined();
  expect(queue.questionFor(raw.identity, 'content')).toBeUndefined();
});

test('conflicting active bodies are hidden and preserved for the mover', async () => {
  const tmp = tempDir('olympus-legacy-personal-');
  const id = 'two-bodies';
  const text = 'Legacyconflictmarker contains ' + '-----BEGIN ' + 'PRIVATE KEY-----';
  await seedLegacy(tmp.dir, [{ id, name: 'Old notes', text }]);
  const other = openLegStore(storePaths(tmp.dir), 'secure_local', null);
  try {
    await other.syncFromConnector(fixtureConnector(() => [{ id, name: 'New notes', text: BODY }]), { fetchContent: true });
  } finally {
    other.close();
  }
  const f = fixture(tmp);
  const identity = identityOf(id);
  await f.service.runOnce();
  expect(f.stores.internal!.searchItems('Legacyconflictmarker', 10)).toEqual([]);
  expect(f.stores.internal!.exportItemCopy(identity)?.chunks.map(chunk => chunk.boundedText).join('')).toBe(text);
  expect(f.stores.secure_local!.exportItemCopy(identity)?.chunks.map(chunk => chunk.boundedText).join('')).toBe(BODY);
  expect(f.service.backlog().movesRefused?.byReason['TierMoveRefusedError:conflicting_legacy_bodies']).toBe(1);
  expect(f.installed.snifferStoreForLedger(f.ledger.dbPath).questionFor(identity, 'content')).toBeUndefined();
});

test('a not-Secret override leaves clean legacy text pending until the judge is ready', async () => {
  const tmp = tempDir('olympus-legacy-personal-');
  const row = { id: 'not-secret', name: 'Picnic list', text: BODY };
  await seedLegacy(tmp.dir, [row]);
  const f = fixture(tmp);
  const identity = identityOf(row.id);
  f.ledger.setOverride(identity, { kind: 'not_secret' });

  for (let tick = 0; tick < 2; tick++) {
    expect((await f.service.runOnce()).state).toBe('model_unavailable');
    expect(f.ledger.getCurrent(identity)).toMatchObject({ contentPending: true, state: 'pending' });
  }
  expect(f.stores.secure_local!.exportItemCopy(identity)?.chunks.map(chunk => chunk.boundedText).join('')).toBe(BODY);

  f.enableJudge();
  for (let tick = 0; tick < 3 && !f.stores.internal!.searchItems(MARKER, 10).length; tick++) {
    expect((await f.service.runOnce()).state).toBe('ran');
  }
  expect(f.ledger.getOverride(identity)).toEqual({ kind: 'not_secret' });
  expect(f.ledger.getCurrent(identity)).toMatchObject({ contentPending: false, state: 'current',
    reasons: expect.arrayContaining([contentDigestReason(BODY), 'override:item:not_secret']) });
  expect(f.stores.internal!.searchItems(MARKER, 10).map(hit => hit.sourceItem.providerItemId)).toEqual([row.id]);
});

test('the judge takes a newer legacy hold first even when the older question was queued last', async () => {
  const tmp = tempDir('olympus-legacy-personal-');
  // No source dates: insertion order makes a-new the newer source item.
  // Missing-question recovery reads identities in the opposite order.
  await seedLegacy(tmp.dir, [
    { id: 'z-old', name: 'Saturday list', text: 'Pack napkins for the community reception next Saturday.' },
    { id: 'a-new', name: 'Sunday plan', text: 'Bring oranges and a blanket to the neighborhood picnic on Sunday.' },
  ]);
  const f = fixture(tmp, { maxCallsPerPass: 1 });
  await f.service.runOnce();
  f.enableJudge();
  const tick = await f.service.runOnce();
  expect(tick.state === 'ran' && tick.report.verdictsApplied).toBe(1);
  expect(f.ledger.getCurrent(identityOf('a-new'))?.contentPending).toBe(false);
  expect(f.ledger.getCurrent(identityOf('z-old'))?.contentPending).toBe(true);
});

test.each(['internal', 'secure_local'] as const)('the walker refuses a set whose %s store is bound to another ledger', async domain => {
  const tmp = tempDir('olympus-legacy-personal-');
  await seedLegacy(tmp.dir, [{ id: 'different-set', name: 'Picnic plan', text: BODY }]);
  const f = fixture(tmp);
  const personal = f.stores.internal!;
  const other = new TierLedger({ dbPath: join(tmp.dir, 'other-tier.sqlite') });
  try {
    f.stores[domain]!.bindTierSet(other);
    const report = await settleLegacyPersonalBodiesOffThread({ set: f.set, queue: f.installed.snifferStoreForLedger(f.ledger.dbPath) });
    expect(report).toMatchObject({ checked: 0, held: 0, failed: 1, retired: false });
    expect(f.ledger.getCurrent(identityOf('different-set'))).toBeUndefined();
    expect(personal.exportItemCopy(identityOf('different-set'))?.chunks[0]?.boundedText).toBe(BODY);
  } finally {
    other.close();
  }
});

test('a judge receipt beside the pre-routing Personal store authorizes only its exact text', async () => {
  const tmp = tempDir('olympus-legacy-personal-');
  const rows = ['authorized', 'names-only', 'routed-names', 'edited'].map(id => ({ id, name: 'Picnic notes', text: BODY }));
  await seedLegacy(tmp.dir, rows);
  const historical = new TierLedger({ dbPath: tierLedgerPathForStore(storePaths(tmp.dir).internal) });
  try {
    for (const row of rows) {
      const decision = classifyItemTiers({ signals: { title: row.name }, text: row.id === 'edited' ? 'Previous text.' : BODY },
        { sniffer: JUDGED_PERSONAL_SNIFFER });
      historical.recordDecision(identityOf(row.id), decision, { trustDomain: 'internal', trustTier: 'S1' });
    }
  } finally { historical.close(); }
  const f = fixture(tmp);
  f.ledger.recordDecision(identityOf('names-only'), classifyItemTiers({ signals: { title: 'Picnic notes' }, namesOnly: true }),
    { trustDomain: 'internal', trustTier: 'S1' });
  const routedNames = identityOf('routed-names');
  f.ledger.recordRoutedPlacement(routedNames, classifyItemTiers({ signals: { title: 'Picnic notes' }, namesOnly: true }),
    { copies: [{ corpusId: f.stores.internal!.corpusId, trustDomain: 'internal', layers: 'metadata' }], embedHold: false });
  await f.service.runOnce();
  expect(f.stores.internal!.searchItems(MARKER, 10).map(hit => hit.sourceItem.providerItemId).sort()).toEqual(['authorized', 'names-only']);
  expect(f.ledger.getCurrent(identityOf('authorized'))?.contentPending).toBeFalsy();
  expect(f.stores.secure_local!.exportItemCopy(routedNames)).toBeUndefined();
  expect(f.ledger.copies(routedNames)).toMatchObject([{ layers: 'metadata', state: 'current' }]);
  expect(f.stores.secure_local!.exportItemCopy(identityOf('edited'))?.chunks[0]?.boundedText).toBe(BODY);
});

test.each([false, true])('retained Personal chunks and vectors move from a names-only copy (Private stub %s)', async privateStub => {
  const tmp = tempDir('olympus-legacy-personal-');
  const row = { id: 'retained', name: 'Picnic notes', text: BODY };
  await seedLegacy(tmp.dir, [row], new RecordingProvider(BUILT_IN_EMBEDDING_PROVIDER, 'fixture', 'local'));
  const f = fixture(tmp);
  const personal = f.stores.internal!;
  const identity = identityOf(row.id);
  personal.bindTierSet(f.ledger);
  const names = classifyItemTiers({ signals: { title: row.name } });
  const secure = f.stores.secure_local!;
  if (privateStub) await secure.syncFromConnector(fixtureConnector(() => [{ id: row.id, name: row.name }]), { fetchContent: false });
  f.ledger.recordRoutedPlacement(identity, names, { copies: [
    { corpusId: personal.corpusId, trustDomain: 'internal', layers: 'metadata' },
    ...(privateStub ? [{ corpusId: secure.corpusId, trustDomain: 'secure_local' as const, layers: 'content' as const }] : []),
  ], embedHold: false });
  const queue = f.installed.snifferStoreForLedger(f.ledger.dbPath);
  expect(await settleLegacyPersonalBodiesOffThread({ set: f.set, queue })).toMatchObject({ checked: 1, held: 1 });
  await f.service.runOnce();
  expect(f.stores.secure_local!.exportItemCopy(identity)?.chunks[0]?.boundedText).toBe(BODY);
  expect(personal.exportItemCopy(identity)?.chunks ?? []).toEqual([]);
  expect(snapshotStore(personal.dbPath).vectors).toEqual([]);
});

test('restore removes an obsolete question before reading names for an override', async () => {
  const tmp = tempDir('olympus-legacy-personal-');
  const row = { id: 'override', name: 'Picnic notes', text: BODY };
  await seedLegacy(tmp.dir, [row]);
  const f = fixture(tmp);
  const personal = f.stores.internal!;
  const { identity } = fixtureItem(row);
  f.ledger.setOverride(identity, { kind: 'tier', tier: 'private' });
  const queue = f.installed.snifferStoreForLedger(f.ledger.dbPath);
  queue.enqueue({ subject: identity, pass: 'content', material: 'Earlier body', flags: [], mapRevision: 'none' });
  personal.exportItemNames = () => { throw new Error('fixture names unavailable'); };
  expect(() => placePersonalBody(f.set, personal, { identity, text: BODY }, queue, 'restore')).toThrow('fixture names unavailable');
  expect(queue.questionFor(identity, 'content')).toBeUndefined();
});

test('a tick reads a bounded slice of a large body and never places a prefix', async () => {
  const tmp = tempDir('olympus-legacy-personal-');
  const large = 'orchard '.repeat(3000) + 'secret tail -----BEGIN ' + 'PRIVATE KEY-----';
  await seedLegacy(tmp.dir, [{ id: 'older', name: 'Picnic notes', text: BODY }, { id: 'large', name: 'Large note', text: large }]);
  const f = fixture(tmp);
  const queue = f.installed.snifferStoreForLedger(f.ledger.dbPath);
  const lap = () => settleLegacyPersonalBodiesOffThread({ set: f.set, queue, chunkLimit: 2 });
  expect(await lap()).toMatchObject({ checked: 0, held: 0, retired: false });
  expect(f.ledger.getCurrent(identityOf('large'))).toBeUndefined();
  expect(f.ledger.getCurrent(identityOf('older'))).toBeUndefined();
  const writer = new Database(f.stores.internal!.dbPath);
  cleanups.push(() => writer.close());
  let secrets = 0;
  let held = 0;
  for (let tick = 0; tick < 8 && !held; tick++) {
    writer.query("UPDATE items SET title = ? WHERE provider_item_id = 'older'").run(`Other notes ${tick}`);
    const page = await lap();
    secrets += page.secrets;
    held += page.held;
  }
  expect(secrets).toBe(1);
  expect(held).toBe(1);
  expect(f.ledger.getCurrent(identityOf('large'))?.contentTier).toBe('secrets');
});

test('a large body edited between slices is checked from its new first chunk', async () => {
  const tmp = tempDir('olympus-legacy-personal-');
  const text = BODY.repeat(140);
  const row = { id: 'large-edit', name: 'Picnic notes', text };
  await seedLegacy(tmp.dir, [row]);
  const f = fixture(tmp);
  const queue = f.installed.snifferStoreForLedger(f.ledger.dbPath);
  const step = () => settleLegacyPersonalBodiesOffThread({ set: f.set, queue, chunkLimit: 1 });
  expect((await step()).checked).toBe(0);
  expect((await step()).checked).toBe(0);
  const db = new Database(f.stores.internal!.dbPath);
  try {
    const replacement = 'Changed prefix -----BEGIN ' + 'PRIVATE KEY-----';
    db.query('UPDATE chunks SET bounded_text = ?, content_hash = ? WHERE chunk_index = 0').run(replacement, connectorStoreHashString(replacement));
    let secrets = 0;
    let retired = false;
    for (let tick = 0; tick < 12 && !retired; tick++) {
      const page = await step();
      expect(page.held).toBe(0);
      secrets += page.secrets;
      retired = page.retired;
    }
    expect(secrets).toBe(1);
    expect(retired).toBe(true);
    expect(db.query("SELECT name FROM sqlite_master WHERE name GLOB 'legacy_body_watch*'").all()).toEqual([]);
  } finally { db.close(); }
});

test('a retained orphan vector has no bytes to judge and is cleared without losing the names', async () => {
  const tmp = tempDir('olympus-legacy-personal-');
  const row = { id: 'orphan-vector', name: 'Picnic notes', text: BODY };
  await seedLegacy(tmp.dir, [row], new RecordingProvider(BUILT_IN_EMBEDDING_PROVIDER, 'fixture', 'local'));
  const f = fixture(tmp);
  const personal = f.stores.internal!;
  const identity = identityOf(row.id);
  const names = classifyItemTiers({ signals: { title: row.name }, namesOnly: true });
  f.ledger.recordRoutedPlacement(identity, names, { copies: [{ corpusId: personal.corpusId, trustDomain: 'internal', layers: 'metadata' }], embedHold: false });
  const db = new Database(personal.dbPath);
  try { db.exec('PRAGMA foreign_keys = OFF; DELETE FROM chunks'); } finally { db.close(); }
  expect(snapshotStore(personal.dbPath).vectors).toHaveLength(1);
  await f.service.runOnce();
  expect(snapshotStore(personal.dbPath).vectors).toEqual([]);
  expect(personal.exportItemNames(identity)?.columns.title).toBe(row.name);
});

test('a fresh store handle resumes before an unfinished body after restart', async () => {
  const tmp = tempDir('olympus-legacy-personal-');
  const text = BODY.repeat(150);
  await seedLegacy(tmp.dir, [{ id: 'restart', name: 'Picnic notes', text }]);
  const f = fixture(tmp);
  const queue = f.installed.snifferStoreForLedger(f.ledger.dbPath);
  const step = (set: TieredStoreSet) => settleLegacyPersonalBodiesOffThread({ set, queue, chunkLimit: 1 });
  expect((await step(f.set)).checked).toBe(0);
  expect((await step(f.set)).checked).toBe(0);
  const reopened = openTierFixture(tmp.dir);
  cleanups.push(() => reopened.close());
  let held = 0;
  for (let tick = 0; tick < 8 && !held; tick++) held += (await step(reopened.set)).held;
  expect(held).toBe(1);
  expect(reopened.ledger.getCurrent(identityOf('restart'))?.reasons).toContain(contentDigestReason(text));
});
