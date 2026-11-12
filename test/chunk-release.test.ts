import { afterEach, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { join } from 'node:path';
import type { EvidencePack } from '../src/core/contracts.ts';
import { createReleaseManifestSink, runWithReleaseManifestSink, type ReleaseInput } from '../src/core/release-manifest.ts';
import { remoteOperationOutputOffThread } from '../src/core/remote-result.ts';
import { buildSourceIndexCorpusRegistry } from '../src/core/source-index/corpus.ts';
import { BUILT_IN_SNIFFER_LANE } from '../src/workers/classification/built-in-sniffer.ts';
import { releaseChunks } from '../src/workers/classification/chunk-release.ts';
import { registerInstalledTierClassification, type ReleaseWindowJudge } from '../src/workers/classification/installed-tier-classification-registry.ts';
import { snifferCacheModelId, snifferId, SNIFFER_PROMPT_VERSION } from '../src/workers/classification/sniffer.ts';
import { resolveReleaseWindow, SnifferCallBudget } from '../src/workers/classification/sniffer-resolver.ts';
import { TierSnifferStore } from '../src/workers/classification/sniffer-store.ts';
import { InstalledTierClassification } from '../src/workers/classification/installed-tier-classification.ts';
import { TierSnifferService } from '../src/workers/classification/sniffer-service.ts';
import { appendClassificationLedgerEntryOnce, CLASSIFICATION_LEDGER_BUILT_IN_DEFAULT_APPROVAL } from '../src/workers/classification-ledger.ts';
import { SNIFFER_EXCERPT_MAX_CHARS, type TierSniffer, type TierSnifferRequest } from '../src/workers/classification/tier-classifier.ts';
import { DEFAULT_EXCERPT_LIMIT } from '../src/workers/classification/delphi-scorer.ts';
import { createConnectorStoreContentProvider, createConnectorStoreCorpusAdapter, defineConnectorCorpus } from '../src/workers/connector-store/index.ts';
import { createReleaseTierCheck } from '../src/workers/connector-store/tier-visibility.ts';
import { createAnalystSourceIndexAnswerHandler, searchReleasedEvidence } from '../src/workers/source-index/analyst-answer.ts';
import { remoteSearchExtension } from '../src/workers/remote-search.ts';
import { CORPORA, FIXTURE_PLACEMENT, fixtureConnector, identityOf, openTierFixture, tempDir, type FixtureSpec } from './helpers/tier-fixtures.ts';
import { createTestClock, flushMicrotasks } from './helpers/test-clock.ts';

const cleanup: Array<() => void> = [];
afterEach(() => { registerInstalledTierClassification(undefined); while (cleanup.length) cleanup.pop()!(); });
const longText = 'violet turnips garden. '.repeat(410) + 'LAST-PASSAGE violet turnips garden.';

async function world(text = longText) {
  const dir = tempDir('olympus-chunk-release-');
  cleanup.push(dir.cleanup);
  let promptVersion = SNIFFER_PROMPT_VERSION;
  const lane = { ...BUILT_IN_SNIFFER_LANE };
  let cache = new TierSnifferStore({ dbPath: join(dir.dir, 'windows.sqlite') });
  cleanup.push(() => cache.close());
  const materials: string[] = [];
  const requests: TierSnifferRequest[] = [];
  let available = true;
  let privateText = '';
  let malformed = false;
  let onCall: (() => void) | undefined;
  let hanging: Promise<void> | undefined;
  const model = { async complete(request: { prompt: string }) {
    const line = request.prompt.split('\n').find(line => line.startsWith('{"i":1'))!;
    const material = (JSON.parse(line) as { document: string }).document;
    materials.push(material);
    onCall?.();
    await hanging;
    return { modelId: 'fixture-judge', text: malformed ? 'no clear answer' : JSON.stringify({ verdicts: [{ i: 1,
      tier: privateText && material.includes(privateText) ? 'private' : 'personal',
      category: 'ordinary', confidence: 0.99, ownRecord: false, privateKind: 'none' }] }) };
  } };
  const budget = new SnifferCallBudget();
  const sniffer = (): TierSniffer => ({ id: snifferId(lane, promptVersion),
    // Initial item verdict models today's production excerpt-only ingest.
    judge: () => ({ verdict: 'decided', tier: 'private', code: 'ordinary:0.99', origin: 'model' }) });
  const judge = (): ReleaseWindowJudge => ({
    modelId: `${snifferCacheModelId(lane)}:${sniffer().id}`, promptVersion,
    read: key => cache.chunkWindowVerdict(key), record: (key, tier) => cache.recordChunkWindow(key, tier),
    resolve: (request, signal) => { requests.push(request); return available
      ? resolveReleaseWindow({ store: cache, lane, model, request, promptVersion, signal, budget })
      : Promise.resolve({ verdict: 'undecided' }); },
  });
  registerInstalledTierClassification({
    automaticMoveContext: { embeddingLedgerPath: join(dir.dir, 'embedding-ledger.jsonl'), localEmbeddingsOnly: () => true },
    forLedger: () => ({ sniffer: sniffer(), releaseJudge: judge() }),
  });
  const fixture = openTierFixture(dir.dir, { embed: false });
  cleanup.push(() => fixture.close());
  let specs: FixtureSpec[] = [{ id: 'garden', name: 'garden-notes.txt', text }];
  const sync = async () => fixture.set.sync(fixtureConnector(() => specs), { fetchContent: true, placement: FIXTURE_PLACEMENT });
  await sync();
  const scopes = () => [{ ledger: fixture.ledger, corpusIds: new Set(Object.values(CORPORA)), stores: () => fixture.set.openStores() }];
  const check = createReleaseTierCheck(scopes, () => 'allow');
  const snapshot = () => fixture.stores.internal!.releaseItemChunks(identityOf('garden'))!;
  const input = (hashes = snapshot().chunks.map(chunk => chunk.contentHash)): ReleaseInput => ({
    ...identityOf('garden'), corpusId: CORPORA.internal, privateAtAnswer: false, chunkHashes: hashes,
  });
  const lanes = () => {
    const stores = fixture.set.openStores();
    return {
      registry: buildSourceIndexCorpusRegistry(stores.map(store => defineConnectorCorpus({ corpusId: store.corpusId, family: store.family, trustDomain: store.trustDomain }))),
      adapters: Object.fromEntries(stores.map(store => [store.corpusId, createConnectorStoreCorpusAdapter({ store })])),
      contentProviders: Object.fromEntries(stores.map(store => [store.corpusId, createConnectorStoreContentProvider({ store })])),
    };
  };
  return { fixture, input, check, scopes, lanes, materials, requests, snapshot,
    unavailable: () => { available = false; }, privateOn: (text: string) => { privateText = text; },
    malformed: () => { malformed = true; }, onCall: (fn: () => void) => { onCall = fn; },
    edit: async (text: string) => { specs = [{ ...specs[0]!, text, version: 'v2' }]; await sync(); },
    promptChange: () => { promptVersion += '.changed'; },
    modelChange: () => { lane.cacheModelId = 'new-weights-revision'; },
    hold: () => { let release!: () => void; hanging = new Promise(resolve => { release = resolve; }); return release; },
    windowCount: () => { const db = new Database(cache.dbPath, { readonly: true }); try { return (db.query('SELECT COUNT(*) AS n FROM chunk_window_verdicts').get() as { n: number }).n; } finally { db.close(); } },
    installService: async (approved = true) => {
      const classificationLedgerPath = join(dir.dir, 'classification.jsonl');
      if (approved) await appendClassificationLedgerEntryOnce(classificationLedgerPath, {
        recorded_at: '2026-11-12T00:00:00.000Z', kind: 'classifier_model_decision', what: 'Fixture approved built-in judge',
        model_id: lane.modelId, profile_id: lane.profileId, lane: lane.kind, prompt_version: promptVersion,
        approved_by: CLASSIFICATION_LEDGER_BUILT_IN_DEFAULT_APPROVAL, status: 'complete', entry_id: 'fixture-approved-judge',
      });
      const installed = new InstalledTierClassification({ lane });
      const service = new TierSnifferService({ installed, lane, model, stores: () => fixture.set.openStores(),
        classificationLedgerPath, autoApproveBuiltIn: approved,
        modelAvailable: () => available,
      });
      registerInstalledTierClassification(installed);
      cleanup.push(() => { service.stop(); installed.close(); });
    },
    reopen: () => { cache.close(); cache = new TierSnifferStore({ dbPath: join(dir.dir, 'windows.sqlite') }); },
  };
}

test('every sub-window is read; verdicts survive reopening; unchanged chunks cost no calls', async () => {
  const w = await world();
  const snapshot = w.snapshot();
  const result = await w.check.chunks!([w.input()]);
  expect(result.withheldPassages).toBe(0);
  expect(result.allowed[0]).toEqual(snapshot.chunks.map(chunk => chunk.contentHash));
  expect(w.windowCount()).toBe(snapshot.chunks.reduce((n, chunk) => n + Math.ceil(chunk.text.length / SNIFFER_EXCERPT_MAX_CHARS), 0));
  const excerpts = w.materials.map(material => material.split('\nExcerpt: ')[1]!);
  for (const chunk of snapshot.chunks) {
    const text = chunk.text;
    for (let offset = 0; offset < text.length; offset += SNIFFER_EXCERPT_MAX_CHARS) {
      expect(excerpts).toContain(text.slice(offset, offset + SNIFFER_EXCERPT_MAX_CHARS).replace(/\s+/g, ' ').trim());
    }
  }
  expect(excerpts.every(text => text.length <= SNIFFER_EXCERPT_MAX_CHARS)).toBe(true);
  expect(w.materials.every(text => text.length <= DEFAULT_EXCERPT_LIMIT)).toBe(true);
  expect(w.materials.every(text => text.includes('Names: garden-notes.txt'))).toBe(true);
  const calls = w.materials.length;
  w.reopen();
  expect((await w.check.chunks!([w.input()])).withheldPassages).toBe(0);
  expect(w.materials).toHaveLength(calls);
});

test('unread last chunk is withheld and counted when the judge is unavailable', async () => {
  const w = await world();
  const hashes = w.input().chunkHashes!;
  await w.check.chunks!([w.input(hashes.slice(0, -1))]);
  w.unavailable();
  const result = await w.check.chunks!([w.input()]);
  expect(result.allowed[0]).toEqual(hashes.slice(0, -1));
  expect(result.withheldPassages).toBe(1);
  expect(result.withheldDocuments).toBe(1);
  const raw = await searchReleasedEvidence({ lanes: w.lanes, question: 'violet turnips garden', releaseCheck: w.check, maxCharsPerCandidate: 16000 });
  expect(JSON.stringify(raw.evidence)).not.toContain('LAST-PASSAGE');
  expect(raw.evidence[0]?.excerpt).toContain('violet turnips');
  expect(raw.coverage.cut_short?.join(' ')).toContain('1 passages from 1 documents were held until they are checked');
  const remote = remoteSearchExtension({ evidenceSearch: input => searchReleasedEvidence({ lanes: w.lanes,
    question: input.question, releaseCheck: w.check, maxCharsPerCandidate: 16000 }) }, () => 'active', { releaseCheck: w.check });
  const resultAtApp = await remote.call({ params: { name: 'olympus_search', arguments: { question: 'violet turnips garden' } } },
    async () => { throw new Error('unexpected next tool'); });
  expect(JSON.stringify(resultAtApp)).not.toContain('LAST-PASSAGE');
  expect(JSON.stringify(resultAtApp)).toContain('violet turnips');
});

test('window boundaries never cut a Unicode character', async () => {
  const text = 'a'.repeat(SNIFFER_EXCERPT_MAX_CHARS - 1) + '🌿' + ' garden'.repeat(400);
  const w = await world(text);
  expect((await w.check.chunks!([w.input()])).withheldPassages).toBe(0);
  expect(w.materials.every(material => !/[\uD800-\uDFFF]/u.test(material))).toBe(true);
  expect(w.materials.some(material => material.includes('🌿'))).toBe(true);
});

test('window detectors read original layout before the production excerpt builder normalizes it', async () => {
  const w = await world('x'.repeat(SNIFFER_EXCERPT_MAX_CHARS) + '\nName: Ada Lovelace\nOccupation: botanist\n' + ' ordinary'.repeat(400));
  await w.check.chunks!([w.input()]);
  expect(w.requests.some(request => request.flags.includes('content:own_record:filled_form'))).toBe(true);
});

test('zero budget does not ask; exhausted budget never counts a partially read chunk', async () => {
  const w = await world();
  expect((await w.check.chunks!([w.input()], { budgetMs: 0 })).allowed[0]).toEqual([]);
  expect(w.materials).toHaveLength(0);
  const clock = createTestClock(0);
  w.onCall(() => { clock.set(10); });
  const result = await releaseChunks([w.input()], w.scopes(), w.check, { budgetMs: 5, now: clock.now });
  expect(w.materials).toHaveLength(1);
  expect(result.allowed[0]).toEqual([]);
  expect(result.withheldPassages).toBe(w.input().chunkHashes!.length);
  // First window survives, but the rest must still be read.
  w.onCall(() => {});
  expect((await w.check.chunks!([w.input()])).withheldPassages).toBe(0);
});

test('Private late window raises and automatically moves the whole item; earlier passages are withheld', async () => {
  const w = await world();
  const request = w.input();
  w.privateOn('LAST-PASSAGE');
  const result = await w.check.chunks!([request]);
  expect(result.allowed[0]).toEqual([]);
  expect(result.withheldPassages).toBe(request.chunkHashes!.length);
  expect(w.fixture.ledger.getCurrent(request)?.contentTier).toBe('secure');
  expect(w.fixture.ledger.copies(request).some(copy => copy.state === 'current' && copy.corpusId === CORPORA.secure_local)).toBe(true);
  expect(w.check.inputs([request])[0]?.tier).toBe('private');
});

test('edited hash and prompt change need fresh judgments; unchanged chunks reuse verdicts', async () => {
  const w = await world();
  const old = w.input();
  await w.check.chunks!([old]);
  const before = w.materials.length;
  await w.edit(longText.replace('LAST-PASSAGE', 'EDIT-PASSAGE'));
  const current = w.input();
  expect(current.chunkHashes![0]).toBe(old.chunkHashes![0]);
  expect(current.chunkHashes!.at(-1)).not.toBe(old.chunkHashes!.at(-1));
  await w.check.chunks!([current]);
  expect(w.materials.length).toBeGreaterThan(before);
  expect(w.materials.slice(before).some(text => text.includes('EDIT-PASSAGE'))).toBe(true);
  expect(w.materials.length - before).toBeLessThan(before);
  const afterEdit = w.materials.length;
  w.promptChange();
  await w.check.chunks!([current]);
  expect(w.materials.length).toBeGreaterThan(afterEdit);
  const afterPrompt = w.materials.length;
  w.modelChange();
  await w.check.chunks!([current]);
  expect(w.materials.length).toBeGreaterThan(afterPrompt);
});

test('whole short item verdict costs zero new calls and zero window records', async () => {
  const w = await world('violet turnips garden.');
  expect((await w.check.chunks!([w.input()], { budgetMs: 0 })).withheldPassages).toBe(0);
  expect(w.materials).toHaveLength(0);
  expect(w.windowCount()).toBe(0);
  w.promptChange();
  await w.check.chunks!([w.input()]);
  expect(w.materials).toHaveLength(1);
});

test('an in-flight judge that ignores cancellation cannot run past the release budget or authorize a late answer', async () => {
  const w = await world();
  const release = w.hold();
  const clock = createTestClock();
  const { inputsOffThread, ...check } = w.check;
  const pending = releaseChunks([w.input()], w.scopes(), check, { now: clock.now, budgetMs: 8000,
    schedule: (callback, ms) => { const timer = clock.setTimeout(callback, ms); return () => clock.clearTimeout(timer); },
  });
  await flushMicrotasks();
  expect(clock.pendingTimers()).toBe(1);
  await clock.advance(8000);
  expect((await pending).allowed[0]).toEqual([]);
  expect(w.windowCount()).toBe(0);
  release();
  await flushMicrotasks();
  expect(w.windowCount()).toBe(0);
});

test('no clear model answer fails safe through the existing judge and raises the item', async () => {
  const w = await world();
  w.malformed();
  expect((await w.check.chunks!([w.input()])).allowed[0]).toEqual([]);
  expect(w.materials).toHaveLength(3);
  expect(w.check.inputs([w.input([])])[0]?.tier).toBe('private');
});

test('cloud Analyst receives only checked passages; local model can still read all text', async () => {
  const w = await world();
  await w.check.chunks!([w.input(w.input().chunkHashes!.slice(0, -1))]);
  w.unavailable();
  const received: EvidencePack[] = [];
  const analyst = { async analyze(pack: EvidencePack) {
    received.push(pack);
    return { answer: 'Garden notes.', citations: [], unanswered: [], sufficient: true };
  } };
  const handler = createAnalystSourceIndexAnswerHandler({
    analyst, cloudAnalyst: analyst, lanes: w.lanes, releaseCheck: w.check,
    selfHealEnabled: false, maxCharsPerCandidate: 16000,
    sovereigntyAnalystRoute: () => [{ profile: { id: 'cloud', profile: { provider: 'openai-compatible', trust: 'standard_cloud', model: 'fixture' } }, backend: 'cloud', analyst }],
  });
  await handler.answer({ question: 'violet turnips garden', analyst_provider: 'cloud' });
  expect(received.length).toBeGreaterThan(0);
  expect(JSON.stringify(received)).not.toContain('LAST-PASSAGE');
  expect(JSON.stringify(received)).toContain('violet turnips');
  received.length = 0;
  const local = createAnalystSourceIndexAnswerHandler({ analyst, lanes: w.lanes, releaseCheck: w.check,
    selfHealEnabled: false, maxCharsPerCandidate: 16000 });
  await local.answer({ question: 'violet turnips garden' });
  expect(JSON.stringify(received)).toContain('LAST-PASSAGE');
});

test('remote-result boundary withholds an answer carrying an unread chunk, retaining the secret scan', async () => {
  const w = await world();
  const manifests = createReleaseManifestSink();
  await runWithReleaseManifestSink(manifests, () => searchReleasedEvidence({ lanes: w.lanes, question: 'violet turnips', releaseCheck: w.check, maxCharsPerCandidate: 16000 }));
  const secret = await remoteOperationOutputOffThread('source_answer', { answer: 'api_key=ABCDEFGHIJKLMNOPQRSTUV', evidence: [] }, {
    releaseCheck: w.check, releaseManifests: manifests.manifests,
  });
  expect(JSON.stringify(secret)).not.toContain('ABCDEFGHIJKLMNOPQRSTUV');
  expect(secret.status).toBe('withheld');
  w.promptChange();
  w.unavailable();
  const output = await remoteOperationOutputOffThread('source_answer', { answer: 'LAST-PASSAGE', evidence: [] }, {
    releaseCheck: w.check, releaseManifests: manifests.manifests,
  });
  expect(JSON.stringify(output)).not.toContain('LAST-PASSAGE');
  expect(JSON.stringify(output)).toContain('withheld');
});

test('installed production service supplies the approved lane and transport to on-demand reading', async () => {
  const w = await world();
  await w.installService();
  expect((await w.check.chunks!([w.input()])).withheldPassages).toBe(0);
  expect(w.materials.length).toBeGreaterThan(0);
});

test('an unapproved installed judge cannot be asked by the release path', async () => {
  const w = await world();
  await w.installService(false);
  expect((await w.check.chunks!([w.input()])).allowed[0]).toEqual([]);
  expect(w.materials).toHaveLength(0);
});
