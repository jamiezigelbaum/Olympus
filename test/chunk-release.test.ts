import { afterEach, expect, test } from 'bun:test';
import { setAppReleaseRecorder, type AppRequestRecord } from '../src/core/app-release-capture.ts';
import { readFileSync } from 'node:fs';
import { forbidWritableStoreOpens, resetStoreWriteGuardForTests } from '../src/core/store-write-guard.ts';
import { currentLocalInferencePriority, runClassificationInference } from '../src/workers/answer-activity.ts';
import { EngineCommandClient } from '../src/workers/engine-split/client.ts';
import { frontJudgeNow, judgeNow } from '../src/workers/classification/chunk-release.ts';
import { TierLedger } from '../src/workers/classification/tier-ledger.ts';
import { LocalConnectorStore } from '../src/workers/connector-store/local-index.ts';
import { Database } from 'bun:sqlite';
import { join } from 'node:path';
import type { TierVisibilityScope } from '../src/workers/connector-store/tier-visibility.ts';
import type { EvidencePack } from '../src/core/contracts.ts';
import { answerReleaseWithheldReasonOffThread, ANSWER_BECAME_PRIVATE, ANSWER_RELEASE_UNVERIFIED, createReleaseManifestSink, bindReleaseChunks, passagesWithheldAtReleasableTiers, recheckSearchEvidence, releaseCandidateHashes, releasedTextDigest, runWithReleaseManifestSink, type ReleaseInput } from '../src/core/release-manifest.ts';
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
afterEach(() => { setAppReleaseRecorder(undefined); resetStoreWriteGuardForTests(); registerInstalledTierClassification(undefined); while (cleanup.length) cleanup.pop()!(); });
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
  let missingJudge = false;
  let unavailableReason: string | undefined;
  let rejudgeReady = true;
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
  const sniffer = (): TierSniffer => ({ id: snifferId(lane, promptVersion), rejudgeReady,
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
    forLedger: () => ({ sniffer: sniffer(), releaseWindows: judge(), ...(missingJudge ? {} : { releaseJudge: judge() }), ...(unavailableReason ? { unavailableReason } : {}) }),
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
  return { fixture, lane,
    noReleaseJudge: () => { missingJudge = true; },
    classificationUnavailable: () => { unavailableReason = 'fixture_unavailable'; },
    rejudgeNotReady: () => { rejudgeReady = false; }, input, check, scopes, lanes, materials, requests, snapshot,
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
  expect(raw.coverage.cut_short?.join(' ')).toContain("1 passages from 1 documents are still being checked for privacy and weren't shared. Ask again in a minute.");
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


test.each(['noReleaseJudge', 'classificationUnavailable', 'rejudgeNotReady'] as const)(
  'short judged items release with %s', async state => {
    const w = await world('violet turnips garden.');
    w[state]();
    expect((await w.check.chunks!([w.input()])).withheldPassages).toBe(0);
    expect(w.materials).toHaveLength(0);
  },
);

test.each(['noReleaseJudge', 'classificationUnavailable', 'rejudgeNotReady'] as const)(
  'recorded windows release with %s; unread windows still wait', async state => {
    const w = await world();
    const hashes = w.input().chunkHashes!;
    await w.check.chunks!([w.input(hashes.slice(0, -1))]);
    const calls = w.materials.length;
    w[state]();
    const result = await w.check.chunks!([w.input()]);
    expect(result.allowed[0]).toEqual(hashes.slice(0, -1));
    expect(result.withheldPassages).toBe(1);
    expect(w.materials).toHaveLength(calls);
  },
);

test('split front opens its caches read-only, posts judge_now, and holds/counts a timeout', async () => {
  const w = await world();
  await w.installService();
  const input = w.input();
  await w.check.chunks!([w.input(input.chunkHashes!.slice(0, -1))]);
  const calls = w.materials.length;
  forbidWritableStoreOpens();
  const installed = new InstalledTierClassification({ lane: w.lane, readOnly: true });
  registerInstalledTierClassification(installed);
  cleanup.push(() => installed.close());
  const ledger = new TierLedger({ dbPath: w.fixture.ledger.dbPath, readOnly: true });
  cleanup.push(() => ledger.close());
  const store = new LocalConnectorStore({ dbPath: w.fixture.paths.internal, corpusId: CORPORA.internal,
    family: 'file', trustDomain: 'internal', readOnly: true, tierLedger: ledger });
  cleanup.push(() => store.close());
  const commands: unknown[] = [];
  const boosted: unknown[] = [];
  const check = createReleaseTierCheck(() => [{ ledger, corpusIds: new Set(Object.values(CORPORA)), stores: () => [store] }], () => 'allow', {
    judgeNow: frontJudgeNow({ post: async (command, options) => {
      commands.push(command);
      expect(command.kind).toBe('judge_now');
      if (command.kind === 'judge_now') expect(options?.timeoutMs).toBe(command.budgetMs + 500);
      throw new Error('background sweep stalled');
    } }),
    boost: items => { boosted.push(...items); },
  });
  const result = await check.chunks!([input]);
  expect(commands).toHaveLength(1);
  expect(result.allowed[0]).toEqual(input.chunkHashes!.slice(0, -1));
  expect(result.withheldPassages).toBe(1);
  expect(result.withheldDocuments).toBe(1);
  expect(boosted).toHaveLength(1);
  expect(w.materials).toHaveLength(calls);
  const server = readFileSync(new URL('../src/workers/engine/server.ts', import.meta.url), 'utf8');
  expect(server).toContain('judgeNow: engineFront ? frontJudgeNow(engineFront.client) : runChunkJudgment');
  expect(server).toContain('judge_now: ({ items, budgetMs }) => runChunkJudgment(items, budgetMs)');
});

test('single-process judge_now preserves owner priority through classification dispatch', async () => {
  const w = await world();
  const priorities: string[] = [];
  w.onCall(() => { void runClassificationInference(async () => { priorities.push(currentLocalInferencePriority()); }); });
  const input = w.input();
  await runClassificationInference(() => judgeNow([{ ...input, chunkHashes: [...input.chunkHashes!] }], w.scopes(), w.check));
  expect(priorities.length).toBeGreaterThan(0);
  expect(priorities.every(priority => priority === 'owner')).toBe(true);
});

test('remote search drops one newly unread hit and keeps the other hits', async () => {
  const records: AppRequestRecord[] = [];
  setAppReleaseRecorder(record => { records.push(record); });
  const w = await world('violet turnips garden.');
  const second = { id: 'second', name: 'second.txt', text: 'violet turnips elsewhere.' };
  await w.fixture.set.sync(fixtureConnector(() => [second]), { fetchContent: true, placement: FIXTURE_PLACEMENT });
  const base = w.check;
  let finalCheck = false;
  const check = { ...base, chunks: async (inputs: readonly ReleaseInput[]) => {
    const result = await base.chunks!(inputs);
    return finalCheck ? { ...result, allowed: inputs.map((input, index) => input.providerItemId === 'garden' ? [] : result.allowed[index]!),
      withheldPassages: 1, withheldDocuments: 1 } : result;
  } };
  const remote = remoteSearchExtension({ evidenceSearch: async input => {
    const raw = await searchReleasedEvidence({ lanes: w.lanes, question: input.question, releaseCheck: check });
    expect(raw.evidence).toHaveLength(2);
    finalCheck = true;
    return raw;
  } }, () => 'active', { releaseCheck: check, caller: { surface: 'remote', displayName: 'Fixture app', connectionId: 'fixture' } });
  const result = await remote.call({ params: { name: 'olympus_search', arguments: { question: 'violet turnips' } } },
    async () => { throw new Error('unexpected tool'); });
  expect(result.structuredContent?.evidence).toHaveLength(1);
  expect(records).toHaveLength(1);
  expect(records[0]!.items).toHaveLength(1);
  expect(records[0]!.heldBack).toBe(1);
  expect(JSON.stringify(result)).toContain('second.txt');
  expect(JSON.stringify(result)).not.toContain('garden-notes.txt');
  expect(JSON.stringify(result)).toContain("1 passages from 1 documents are still being checked for privacy and weren't shared. Ask again in a minute.");
});


// Transport tests use a fixed read snapshot: socket deadlines need no disk setup.
function unreadTransportFixture() {
  const input: ReleaseInput = { ...identityOf('transport'), corpusId: CORPORA.internal,
    privateAtAnswer: false, chunkHashes: ['transport-hash'] };
  let localCalls = 0;
  registerInstalledTierClassification({ forLedger: () => ({
    sniffer: { id: 'transport-judge', judge: () => ({ verdict: 'undecided' }) },
    releaseJudge: { modelId: 'transport-judge', promptVersion: 'fixture', read: () => undefined,
      record: () => { throw new Error('transport front must never write'); },
      resolve: async () => { localCalls++; return { verdict: 'undecided' }; },
    },
  }) });
  const scopes = [{ corpusIds: new Set([CORPORA.internal]),
    ledger: { dbPath: '/tmp/olympus-virtual-transport-ledger.sqlite', getCurrent: () => ({ reasons: [] }), getOverride: () => undefined },
    stores: () => [{ corpusId: CORPORA.internal, releaseItemChunks: () => ({ title: 'garden.txt',
      chunks: [{ contentHash: 'transport-hash', text: 'violet turnips garden. '.repeat(410) }] }) }],
  }] as unknown as TierVisibilityScope[];
  const check = { inputs: (inputs: readonly ReleaseInput[]) => inputs.map(() => ({ tier: 'public_or_personal' as const, gone: false })),
    secureDerivativeDefault: () => 'allow' as const };
  return { input, scopes, check, localCalls: () => localCalls };
}

test('a judge_now transport timeout holds and counts without reaching the app as an error', async () => {
  const fixture = unreadTransportFixture();
  const clock = createTestClock(0);
  const commands: unknown[] = [];
  const client = new EngineCommandClient({ authToken: 'fixture-token', now: clock.now, sleep: clock.sleep,
    setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout as (timer: unknown) => void,
    fetch: ((_url: unknown, init: RequestInit) => {
      commands.push(JSON.parse(init.body as string).command);
      return new Promise<Response>(() => {});
    }) as typeof fetch,
  });
  const boosted: unknown[] = [];
  const pending = releaseChunks([fixture.input], fixture.scopes, fixture.check, { now: clock.now,
    judgeNow: frontJudgeNow(client), boost: items => { boosted.push(...items); } });
  await flushMicrotasks();
  expect(commands).toHaveLength(1);
  expect(commands[0]).toMatchObject({ kind: 'judge_now', budgetMs: 8000 });
  await clock.advance(8500);
  const result = await pending;
  expect(result.allowed[0]).toEqual([]);
  expect(result.withheldPassages).toBe(1);
  expect(result.withheldDocuments).toBe(1);
  expect(boosted).toHaveLength(1);
  expect(fixture.localCalls()).toBe(0);
});

test('the front batches judge_now and boosts every remaining item in commands of at most 20', async () => {
  const fixture = unreadTransportFixture();
  const commands: number[] = [];
  const boosts: number[] = [];
  const result = await releaseChunks(Array.from({ length: 21 }, () => fixture.input), fixture.scopes, fixture.check, {
    now: () => 0,
    judgeNow: frontJudgeNow({ post: async command => {
      if (command.kind === 'judge_now') commands.push(command.items.length);
      return { id: 'fixture', instance_id: 'background', state: 'received' };
    } }),
    boost: items => { boosts.push(items.length); },
  });
  expect(commands).toEqual([20, 1]);
  expect(boosts).toEqual([20, 1]);
  expect(result.withheldPassages).toBe(21);
  expect(fixture.localCalls()).toBe(0);
});


test('remote search adds held passage counts to withheld and keeps cleared hits', async () => {
  const fixture = unreadTransportFixture();
  const inputs = [{ ...fixture.input, chunkHashes: ['held-one', 'held-two'] },
    { ...fixture.input, providerItemId: 'cleared', chunkHashes: ['cleared'] }];
  const evidence = inputs.map(input => ({ corpus_id: input.corpusId, provider: input.provider,
    account_scope: input.accountScope, provider_item_id: input.providerItemId }));
  const result = await recheckSearchEvidence({ evidence, withheld: 4 }, [{ inputs,
    constraints: { secureDerivativeDefault: 'approval', includeSecureLocalContent: false } }], {
    ...fixture.check, chunks: async () => ({ allowed: [[], ['cleared']], withheldPassages: 2, withheldDocuments: 1 }),
  });
  expect(result.raw.evidence).toEqual([evidence[1]!]);
  expect(result.raw.withheld).toBe(6);
  expect(result.raw.coverage).toEqual({ cut_short: ["2 passages from 1 documents are still being checked for privacy and weren't shared. Ask again in a minute."] });
});

test('an input from a corpus no tier ledger governs yet is held and counted, never released on its item tier', async () => {
  const check = { inputs: (inputs: readonly ReleaseInput[]) => inputs.map(() => ({ tier: 'legacy' as const, gone: false })), secureDerivativeDefault: () => 'allow' as const };
  const waiting: ReleaseInput = { corpusId: 'mount-waiting-for-its-ledger', provider: 'notes', accountScope: 'me', providerItemId: 'a', privateAtAnswer: false, chunkHashes: ['h1', 'h2'] };
  const result = await releaseChunks([waiting], [], check, { judgeNow: async () => undefined });
  expect(result).toEqual({ allowed: [[]], withheldPassages: 2, withheldDocuments: 1 });
});

test('a delayed answer reads item tiers after chunk judging settles, so an item raised meanwhile is withheld', async () => {
  const input: ReleaseInput = { corpusId: 'internal.files', provider: 'files', accountScope: 'a', providerItemId: 'doc', providerConversationId: '', privateAtAnswer: false, chunkHashes: ['h1'] };
  let tier: 'public_or_personal' | 'private' = 'public_or_personal';
  const check = {
    inputs: (inputs: readonly ReleaseInput[]) => inputs.map(() => ({ tier, gone: false })),
    // The judge finds a Private window and the background raises the whole item.
    chunks: async (inputs: readonly ReleaseInput[]) => { tier = 'private'; return { allowed: inputs.map(() => []), withheldPassages: 1, withheldDocuments: 1 }; },
    secureDerivativeDefault: () => 'approval' as const,
  };
  const reason = await answerReleaseWithheldReasonOffThread([{ inputs: [input], constraints: { includeSecureLocalContent: false } }] as never, check, 'private', { chunks: true });
  expect(reason).toBe(ANSWER_BECAME_PRIVATE);
});

test('an authorized Private derivative is not held for passage proof; Personal passages still are', () => {
  const base = { corpusId: 'internal.files', provider: 'files', accountScope: 'a', providerConversationId: '' };
  const priv: ReleaseInput = { ...base, providerItemId: 'p', chunkHashes: ['a', 'b'], privateAtAnswer: true };
  const personal: ReleaseInput = { ...base, providerItemId: 'q', chunkHashes: ['c', 'd'], privateAtAnswer: false };
  const report = { allowed: [[], ['c']] };
  expect(passagesWithheldAtReleasableTiers([priv, personal], [{ tier: 'private', gone: false }, { tier: 'public_or_personal', gone: false }], report)).toBe(1);
  expect(passagesWithheldAtReleasableTiers([priv], [{ tier: 'legacy', gone: false }], { allowed: [[]] })).toBe(0);
  expect(passagesWithheldAtReleasableTiers([personal], [{ tier: 'legacy', gone: false }], { allowed: [[]] })).toBe(2);
  // A hash the input never named cannot stand in for one it did.
  expect(passagesWithheldAtReleasableTiers([personal], [{ tier: 'public_or_personal', gone: false }], { allowed: [['c', 'zz']] })).toBe(1);
});

test('remote output keeps an authorized Private answer whose passages the judge has not proved', async () => {
  const input: ReleaseInput = { corpusId: 'internal.files', provider: 'files', accountScope: 'a', providerItemId: 'p', providerConversationId: '', chunkHashes: ['a'], privateAtAnswer: true };
  const check = {
    inputs: (inputs: readonly ReleaseInput[]) => inputs.map(() => ({ tier: 'private' as const, gone: false })),
    chunks: async (inputs: readonly ReleaseInput[]) => ({ allowed: inputs.map(() => []), withheldPassages: 1, withheldDocuments: 1 }),
    secureDerivativeDefault: () => 'allow' as const,
  };
  const raw = { answer: 'The policy covers it.', evidence: [], coverage: {} };
  const output = await remoteOperationOutputOffThread('source_answer', raw, {
    releaseCheck: check, releaseManifests: [{ inputs: [input], constraints: { includeSecureLocalContent: false } }] as never,
  });
  expect(output.status).toBe('answered');
});

test('a search hit leaves only with the excerpt its proved passages made; a names-only hit carries no text', async () => {
  const constraints = { secureDerivativeDefault: 'approval' as const, includeSecureLocalContent: false };
  const base = { corpusId: 'internal.files', provider: 'files', accountScope: 'a', privateAtAnswer: false };
  const proved: ReleaseInput = { ...base, providerItemId: 'proved', chunkHashes: ['h1'], releasedTextDigest: releasedTextDigest('the proved text') };
  const swapped: ReleaseInput = { ...base, providerItemId: 'swapped', chunkHashes: ['h2'], releasedTextDigest: releasedTextDigest('what was proved') };
  const names: ReleaseInput = { ...base, providerItemId: 'names', layer: 'names' };
  const hit = (input: ReleaseInput, excerpt?: string) => ({ corpus_id: input.corpusId, provider: input.provider,
    account_scope: input.accountScope, provider_item_id: input.providerItemId, ...(excerpt ? { excerpt } : {}) });
  const evidence = [hit(proved, 'the proved text'), hit(swapped, 'some other text'), hit(names, 'text a names-only hit never had'), hit(names)];
  const check = { inputs: (inputs: readonly ReleaseInput[]) => inputs.map(() => ({ tier: 'public_or_personal' as const, gone: false })),
    chunks: async (inputs: readonly ReleaseInput[]) => ({ allowed: inputs.map(input => input.chunkHashes ?? []), withheldPassages: 0, withheldDocuments: 0 }),
    secureDerivativeDefault: () => 'approval' as const };
  const result = await recheckSearchEvidence({ evidence, withheld: 0 }, [{ inputs: [proved, swapped, names], constraints }], check);
  expect(result.raw.evidence).toEqual([evidence[0]!, evidence[3]!]);
  // Each hit dropped for its text counts once.
  expect(result.raw.withheld).toBe(2);
});

test('withheld counts held passages and every hit dropped for another reason, without double counting', async () => {
  const base = { corpusId: 'internal.files', provider: 'files', accountScope: 'a', privateAtAnswer: false };
  const held: ReleaseInput = { ...base, providerItemId: 'held', chunkHashes: ['a', 'b', 'c'] };
  const evidence = [{ corpus_id: 'internal.files', provider: 'files', account_scope: 'a', provider_item_id: 'held' },
    { corpus_id: 'internal.files', provider: 'files', account_scope: 'a', provider_item_id: 'unlisted' }];
  const result = await recheckSearchEvidence({ evidence, withheld: 0 }, [{ inputs: [held], constraints: { secureDerivativeDefault: 'approval', includeSecureLocalContent: false } }], {
    inputs: inputs => inputs.map(() => ({ tier: 'public_or_personal', gone: false })),
    chunks: async () => ({ allowed: [[]], withheldPassages: 3, withheldDocuments: 1 }),
    secureDerivativeDefault: () => 'approval',
  });
  expect(result.raw.evidence).toEqual([]);
  expect(result.raw.withheld).toBe(4);
});

test('text a model read with no stored chunk behind it holds the derivative; a passage filter leaves it out instead', () => {
  const provenance = {};
  bindReleaseChunks(provenance, ['the body text'], [['body-hash']]);
  const candidate = { provenance, chunks: ['Reactions: 👍 ×2 (Sam)', 'the body text'], tables: [{}], facts: [] };
  const held = releaseCandidateHashes(candidate, { holdUnmapped: true });
  expect(held).toEqual(['body-hash', 'unproved:0', 'unproved:1']);
  expect(releaseCandidateHashes(candidate)).toEqual(['body-hash']);
  const input: ReleaseInput = { corpusId: 'internal.chat', provider: 'chat', accountScope: 'a', providerItemId: 'm', privateAtAnswer: false, chunkHashes: held };
  // The body is proved; the reaction line and table never can be.
  expect(passagesWithheldAtReleasableTiers([input], [{ tier: 'public_or_personal', gone: false }], { allowed: [['body-hash']] })).toBe(2);
  // Nothing proved at all already holds the input; no marker is added.
  expect(releaseCandidateHashes({ provenance: {}, chunks: ['unbound'] }, { holdUnmapped: true })).toEqual([]);
});

test('a ledger removed while windows are judged no longer vouches for what it read', async () => {
  const w = await world('violet turnips garden.');
  // Judging awaits the pool; the ledger is unset meanwhile, so the item now reads as legacy.
  let current = w.scopes();
  const live = createReleaseTierCheck(() => current, () => 'allow');
  const check = { ...live, chunks: async (inputs: readonly ReleaseInput[], options?: { budgetMs?: number }) => {
    const report = await live.chunks!(inputs, options);
    current = [];
    return report;
  } };
  const manifest = [{ inputs: [w.input()], constraints: { secureDerivativeDefault: 'allow' as const, includeSecureLocalContent: false } }];
  expect(await answerReleaseWithheldReasonOffThread(manifest, check, 'private', { chunks: true })).toBe(ANSWER_RELEASE_UNVERIFIED);
  // With the ledger still there, the same short item is proved and released.
  current = w.scopes();
  expect(await answerReleaseWithheldReasonOffThread(manifest, live, 'private', { chunks: true })).toBeUndefined();
});
