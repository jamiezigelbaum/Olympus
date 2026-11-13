import { expect, test } from 'bun:test';
import { join } from 'node:path';
import type { Analyst, EvidencePack } from '../src/core/contracts.ts';
import { checkReleaseChunks, type ReleaseInput } from '../src/core/release-manifest.ts';
import { createSourceExclusionMatcher, parseSourceIngestionExclusions } from '../src/core/source-ingestion-exclusions.ts';
import { buildSourceIndexCorpusRegistry } from '../src/core/source-index/corpus.ts';
import { registerInstalledTierClassification, type ReleaseWindowJudge } from '../src/workers/classification/installed-tier-classification-registry.ts';
import { TierSnifferStore } from '../src/workers/classification/sniffer-store.ts';
import type { TierSniffer } from '../src/workers/classification/tier-classifier.ts';
import { createConnectorStoreContentProvider, createConnectorStoreCorpusAdapter, defineConnectorCorpus } from '../src/workers/connector-store/index.ts';
import { createFileExtractionRuntime } from '../src/workers/engine/runtime/file-extraction-runtime.ts';
import { remoteSearchExtension } from '../src/workers/remote-search.ts';
import { createAnalystSourceIndexAnswerHandler, searchReleasedEvidence } from '../src/workers/source-index/analyst-answer.ts';
import { laneReleaseCheck } from './helpers/lane-release-check.ts';
import { provedReleaseCheck } from './helpers/scripted-search-release.ts';
import { fixtureConnector, identityOf, openTierFixture, tempDir } from './helpers/tier-fixtures.ts';
import { waitFor } from './helpers/test-clock.ts';

test('an on-demand long file holds its unread later section from apps and the cloud Analyst, with coverage', async () => {
  // These are fixture facts, not values derived from the chunker or judge's limits.
  const personal = 'The community garden grows violet turnips. ';
  const firstSection = personal.repeat(100).slice(0, 4_000);
  const privateSection = 'Cobaltbudget: confidential acquisition reserve is 73 million credits. ';
  const text = firstSection + privateSection.repeat(20);
  const question = 'cobaltbudget';
  const heldNote = "1 passages from 1 documents are still being checked for privacy and weren't shared. Ask again in a minute.";
  const dir = tempDir('on-demand-long-file-release-');
  const exclusions = createSourceExclusionMatcher(parseSourceIngestionExclusions({ schemaVersion: 1,
    rules: [{ id: 'selected', mode: 'on_demand', sources: [], path_prefixes: ['/Files'] }],
  }), 'fixture');
  const fixture = openTierFixture(dir.dir, { embed: false, exclusions });
  const store = fixture.stores.internal!;
  const identity = identityOf('long-file');
  const windows = new TierSnifferStore({ dbPath: join(dir.dir, 'windows.sqlite') });
  const judged: string[] = [];
  let judgeAvailable = true;
  const sniffer: TierSniffer = { id: 'excerpt-only-fixture', judge(request) {
    judged.push(request.material ?? '');
    return { verdict: 'decided', tier: 'private', code: 'ordinary:0.99', origin: 'model' };
  } };
  const windowJudge: ReleaseWindowJudge = {
    modelId: 'fixture-window-judge', promptVersion: 'fixture-v1',
    read: key => windows.chunkWindowVerdict(key),
    record: (key, tier) => windows.recordChunkWindow(key, tier),
    async resolve(request) {
      judged.push(request.material ?? '');
      return { verdict: 'decided', tier: 'private', code: 'ordinary:0.99', origin: 'model' };
    },
  };
  registerInstalledTierClassification({ forLedger: () => ({ sniffer, releaseWindows: windowJudge,
    ...(judgeAvailable ? { releaseJudge: windowJudge } : {}),
  }) });
  let runtime: ReturnType<typeof createFileExtractionRuntime>;
  try {
    await fixture.set.sync(fixtureConnector(() => [{ id: 'long-file', name: 'garden-notes.txt' }]), { fetchContent: false });
    expect(exclusions.evaluatePath('/Files/garden-notes.txt')).toMatchObject({ disposition: 'metadata_only', readOnDemand: true });
    expect(store.onDemandReadCandidate('long-file')).toMatchObject({ readableOnRequest: true });
    expect(store.readOnDemand(identity.localItemId, 'v1')).toBe(false);
    expect(store.localContent(identity.localItemId)?.chunks ?? []).toEqual([]);
    let fetches = 0;
    runtime = createFileExtractionRuntime({ enabled: true, connectorStores: [store],
      tierSets: new Map([[store.corpusId, fixture.set]]), jobsDbPath: join(dir.dir, 'jobs.sqlite'),
      env: { OLYMPUS_DATA_DIR: dir.dir },
      corpora: [{ corpusId: store.corpusId, provider: 'fixture', scopes: ['scope'], ownerConnectorId: 'fixture_lane' }],
      sourceFactories: new Map([['fixture', () => ({ id: 'fixture', corpusId: store.corpusId, provider: 'fixture',
        async listCandidates() { throw new Error('An individual read must not scan the folder'); },
        async fetch() { fetches++; return { bytes: new TextEncoder().encode(text) }; },
      })]]),
    });
    expect(runtime).toBeDefined();
    expect(await runtime!.requestOnDemandRead({ itemRef: { corpusId: store.corpusId, providerItemId: 'long-file' },
      requester: 'remote_app', questionId: 'long-file-question',
    })).toMatchObject({ state: 'queued' });
    await waitFor(() => runtime!.jobs.itemExtractionState(identity) === 'settled');
    expect(fetches).toBe(1);
    expect(store.readOnDemand(identity.localItemId, 'v1')).toBe(true);
    expect(store.readOnDemand(identity.localItemId, 'v2')).toBe(false);
    expect(fixture.ledger.getCurrent(identity)?.contentTier).toBe('private'); // stored key for Personal
    expect(judged.some(material => material.includes(personal))).toBe(true);
    expect(judged.join('\n')).not.toContain('Cobaltbudget');

    const snapshot = store.releaseItemChunks(identity)!;
    expect(snapshot.chunks.map(chunk => chunk.text)).toEqual([firstSection, privateSection.repeat(20).trim()]);
    expect(text.indexOf('Cobaltbudget')).toBe(4_000);
    const releaseCheck = laneReleaseCheck(fixture.ledger, () => fixture.set.openStores());
    const input: ReleaseInput = { ...identity, corpusId: store.corpusId, privateAtAnswer: false,
      chunkHashes: snapshot.chunks.map(chunk => chunk.contentHash),
    };
    // Read the entire Personal first chunk, then take the judge offline. Its
    // cached proofs survive; the later chunk has never been read in full.
    const firstHash = snapshot.chunks[0]!.contentHash;
    expect(await checkReleaseChunks(releaseCheck, [{ ...input, chunkHashes: [firstHash] }])).toEqual({
      allowed: [[firstHash]], withheldPassages: 0, withheldDocuments: 0,
    });
    judgeAvailable = false;
    expect(await checkReleaseChunks(releaseCheck, [input])).toEqual({
      allowed: [[firstHash]], withheldPassages: 1, withheldDocuments: 1,
    });

    const lanes = () => ({
      registry: buildSourceIndexCorpusRegistry([defineConnectorCorpus({ corpusId: store.corpusId, family: 'file', trustDomain: 'internal' })]),
      adapters: { [store.corpusId]: createConnectorStoreCorpusAdapter({ store }) },
      contentProviders: { [store.corpusId]: createConnectorStoreContentProvider({ store }) },
    });
    const search = (check = releaseCheck, searchQuestion = question) => searchReleasedEvidence({
      lanes, question: searchQuestion, releaseCheck: check, maxCharsPerCandidate: 2_000,
    });
    // A control proves the query actually retrieves the late section within
    // the app's excerpt budget, so truncation cannot make this test pass.
    expect(JSON.stringify((await search(provedReleaseCheck)).evidence)).toContain(privateSection.trim());
    const released = await search();
    expect(released.evidence).toEqual([]);
    expect(JSON.stringify(released)).not.toContain('Cobaltbudget');
    expect(JSON.stringify(released)).not.toContain('73 million credits');
    expect(released.withheld).toBe(1);
    expect(released.coverage.cut_short).toContain(heldNote);

    const remote = remoteSearchExtension({ evidenceSearch: input => search(releaseCheck, input.question) }, () => 'active', { releaseCheck });
    const app = await remote.call({ params: { name: 'olympus_search', arguments: { question } } },
      async () => { throw new Error('Unexpected next tool'); });
    expect(app?.isError).not.toBe(true);
    expect(JSON.stringify(app)).not.toContain('Cobaltbudget');
    expect(JSON.stringify(app)).not.toContain('73 million credits');
    expect(JSON.stringify(app)).toContain(heldNote);
    const personalAtApp = await remote.call({ params: { name: 'olympus_search', arguments: { question: 'violet turnips' } } },
      async () => { throw new Error('Unexpected next tool'); });
    expect(personalAtApp?.isError).not.toBe(true);
    expect(JSON.stringify(personalAtApp)).toContain(personal.trim());

    const cloudPacks: EvidencePack[] = [];
    const cloud: Analyst = { async analyze(pack) {
      cloudPacks.push(pack);
      return { answer: 'The garden grows violet turnips.', citations: [], unanswered: [] };
    } };
    const handler = createAnalystSourceIndexAnswerHandler({ lanes, releaseCheck,
      analyst: { async analyze() { throw new Error('Unexpected local fallback'); } }, cloudAnalyst: cloud,
      selfHealEnabled: false, maxCharsPerCandidate: 16_000,
      sovereigntyAnalystRoute: () => [{ profile: { id: 'cloud', profile: { provider: 'openai-compatible', trust: 'standard_cloud', model: 'fixture' } }, backend: 'cloud', analyst: cloud }],
    });
    const answer = await handler.answer({ question, analyst_provider: 'cloud', include_internal: true });
    expect(cloudPacks).toHaveLength(1);
    expect(cloudPacks[0]!.candidates).toHaveLength(1);
    expect(cloudPacks[0]!.candidates[0]!.chunks.join('\n')).toContain(personal.trim());
    expect(JSON.stringify(cloudPacks[0]!.candidates)).not.toContain('Cobaltbudget');
    expect(JSON.stringify(cloudPacks[0]!.candidates)).not.toContain('73 million credits');
    expect(cloudPacks[0]!.coverage.extractionGaps).toContain(heldNote);
    expect(answer.answer).toContain(heldNote);
    expect(judged.join('\n')).not.toContain('Cobaltbudget');
  } finally {
    runtime?.close();
    registerInstalledTierClassification(undefined);
    windows.close();
    fixture.close();
    dir.cleanup();
  }
});
