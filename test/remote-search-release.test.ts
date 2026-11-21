// The remote evidence search rereads every item's tier right before its
// result leaves (source-index/analyst-answer.ts searchReleasedEvidence
// releaseCheck): an item the owner moves to Private or Secrets while the
// search is reading it is withheld. Codex gpt-6-astra review of PR #300,
// 2026-10-12, reproduced exactly this with a paused content read.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { callChatGptTool } from '../src/workers/chatgpt/mcp-surface.ts';
import { defaultConfig } from '../src/core/config.ts';
import type { OperationContext } from '../src/core/operations.ts';
import { openRemoteConnectionStore } from '../src/core/remote-connections.ts';
import { forbidWritableStoreOpens, resetStoreWriteGuardForTests } from '../src/core/store-write-guard.ts';
import { afterEach, describe, expect, test } from 'bun:test';
import { buildSourceIndexCorpusRegistry } from '../src/core/source-index/corpus.ts';
import type { ReleaseCheck } from '../src/core/release-manifest.ts';
import { classifyItemTiers, contentDigestReason, type TierSniffer } from '../src/workers/classification/tier-classifier.ts';
import { TierLedger } from '../src/workers/classification/tier-ledger.ts';
import { tierLedgerPathForStore } from '../src/workers/classification/tier-ledger-path.ts';
import { searchToolResult } from '../src/workers/chatgpt/response-builder.ts';
import { createConnectorStoreContentProvider, createConnectorStoreCorpusAdapter, defineConnectorCorpus } from '../src/workers/connector-store/index.ts';
import { moveTieredItem } from '../src/workers/connector-store/tier-move.ts';
import { createReleaseTierCheck, createTierVisibilityGate } from '../src/workers/connector-store/tier-visibility.ts';
import { createEmailSourceWorker } from '../src/workers/engine/index.ts';
import { createInProcessOperationContext, createRemoteMcpHandler } from '../src/workers/remote-mcp.ts';
import { createAnalystSourceIndexAnswerHandler, searchReleasedEvidence } from '../src/workers/source-index/analyst-answer.ts';
import { CORPORA, FIXTURE_PLACEMENT, RecordingProvider, fixtureConnector, identityOf, openLegStore, openTierFixture, storePaths, tempDir } from './helpers/tier-fixtures.ts';
import { JUDGED_PERSONAL_SNIFFER } from './helpers/tier-fixtures.ts';
import { registerInstalledTierClassification } from '../src/workers/classification/installed-tier-classification-registry.ts';

const SENTENCE = 'The garden contains violet turnips.';
const cleanups: Array<() => void> = [];

afterEach(() => {
  registerInstalledTierClassification(undefined);
  while (cleanups.length > 0) cleanups.pop()!();
});

async function gardenLane(sniffer: TierSniffer = JUDGED_PERSONAL_SNIFFER, legacy?: 'set' | 'sidecar') {
  // These short fixtures already have whole-item judgments. No new window
  // record or model call is needed to exercise the later tier-change race.
  registerInstalledTierClassification({ forLedger: () => ({ sniffer, releaseJudge: {
    modelId: 'fixture', promptVersion: 'fixture', read: () => undefined,
    record: () => { throw new Error('short items need no window records'); },
    resolve: async () => { throw new Error('short items need no new calls'); },
  } }) });
  const { dir, cleanup } = tempDir();
  const connector = fixtureConnector(() => [{ id: 'garden', name: 'garden-notes.txt', text: SENTENCE }]);
  if (legacy) {
    const store = openLegStore(storePaths(dir), 'internal', null);
    try {
      await store.syncFromConnector(connector, { fetchContent: true, placement: FIXTURE_PLACEMENT });
    } finally { store.close(); }
  }
  const fixture = openTierFixture(dir, { embed: false });
  cleanups.push(() => {
    fixture.close();
    cleanup();
  });
  if (legacy) {
    const identity = identityOf('garden');
    const item = { signals: { title: 'garden-notes.txt' }, text: SENTENCE };
    const personal = classifyItemTiers(item, { sniffer });
    const privateDecision = classifyItemTiers(item, { sniffer: {
      id: sniffer.id,
      judge: () => ({ verdict: 'decided', tier: 'secure', code: 'private:0.99', origin: 'model' }),
    } });
    expect(privateDecision).toMatchObject({ decidedBy: 'sniffer', contentTier: 'secure' });
    expect(privateDecision.reasons).toContain(contentDigestReason(SENTENCE));
    const stored = { trustDomain: 'internal' as const, trustTier: 'S3' as const };
    fixture.ledger.recordDecision(identity, legacy === 'set' ? privateDecision : personal, stored);
    if (legacy === 'sidecar') {
      const previous = new TierLedger({ dbPath: tierLedgerPathForStore(fixture.paths.internal) });
      try { previous.recordDecision(identity, privateDecision, stored); }
      finally { previous.close(); }
    }
    expect(fixture.ledger.getCurrent(identity)?.routed).toBe(false);
    expect(fixture.ledger.copies(identity)).toEqual([]);
    expect(fixture.stores.internal!.searchItems('violet turnips', 10)).toHaveLength(1);
  } else {
    await fixture.set.sync(connector, { fetchContent: true, placement: FIXTURE_PLACEMENT });
  }
  // Every content read waits here until the test lets it go.
  let pause: Promise<void> | undefined;
  let reading: (() => void) | undefined;
  const readStarted = new Promise<void>((resolve) => { reading = resolve; });
  const lanes = () => {
    const stores = fixture.set.openStores();
    return {
      registry: buildSourceIndexCorpusRegistry(stores.map((store) => defineConnectorCorpus({
        corpusId: store.corpusId, family: store.family, trustDomain: store.trustDomain,
      }))),
      adapters: Object.fromEntries(stores.map((store) => [store.corpusId, createConnectorStoreCorpusAdapter({ store })])),
      contentProviders: Object.fromEntries(stores.map((store) => {
        const provider = createConnectorStoreContentProvider({ store });
        return [store.corpusId, {
          ...provider,
          contentServable: provider.contentServable.bind(provider),
          async fetchLocalContent(request: Parameters<typeof provider.fetchLocalContent>[0]) {
            const block = await provider.fetchLocalContent(request);
            reading?.();
            if (pause) await pause;
            return block;
          },
        }];
      })),
      visibilityGate: createTierVisibilityGate(() => [{ ledger: fixture.ledger, corpusIds: new Set(stores.map((store) => store.corpusId)) }]),
    };
  };
  const releaseCheck = createReleaseTierCheck(() => [{
    ledger: fixture.ledger, corpusIds: new Set(Object.values(CORPORA)), stores: () => fixture.set.openStores(),
  }], () => 'allow');
  const hold = () => {
    let release!: () => void;
    pause = new Promise<void>((resolve) => { release = resolve; });
    return release;
  };
  return { fixture, lanes, releaseCheck, hold, readStarted };
}

async function legacyRemoteLane(legacy: 'set' | 'sidecar') {
  const lane = await gardenLane(JUDGED_PERSONAL_SNIFFER, legacy);
  let modelCalls = 0;
  const analyst = { async analyze() {
    modelCalls++;
    return { answer: SENTENCE, citations: [], unanswered: [] };
  } };
  const sourceAnswer = createAnalystSourceIndexAnswerHandler({
    lanes: lane.lanes, releaseCheck: lane.releaseCheck, analyst, cloudAnalyst: analyst, veniceAnalyst: () => analyst,
  });
  const worker = createEmailSourceWorker({ sourceAnswer, sourceAnswerReleaseCheck: lane.releaseCheck });
  const store = openRemoteConnectionStore(join(lane.fixture.dir, 'remote-connections.sqlite'));
  cleanups.push(() => { store.close(); worker.close(); });
  const { token } = store.create('Remote test');
  const context = (caller: NonNullable<OperationContext['caller']>, signal?: AbortSignal) => ({
    ...createInProcessOperationContext({
      config: defaultConfig(), sourceIndexReadEnabled: true, workerFetch: worker.fetch, caller,
      ...(signal ? { signal } : {}),
    }),
    releaseCheck: lane.releaseCheck,
  });
  const evidenceSearch = (input: { question: string }) => searchReleasedEvidence({
    lanes: lane.lanes, question: input.question, releaseCheck: lane.releaseCheck,
  });
  const app = { evidenceSearch, dashboardView: async () => { throw new Error('unused'); },
    privateMatchProbe: async () => ({ count: 0, evidence: [] }) };
  const handler = createRemoteMcpHandler({
    connections: () => store, makeOperationContext: context, search: { evidenceSearch }, log: () => {},
  });
  const question = 'violet turnips garden';
  const remoteTool = async (name: string, args: Record<string, unknown>) => {
    const response = await handler(new Request('http://worker.test/mcp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: { question, ...args } } }),
    }));
    expect(response.status).toBe(200);
    const wire = await response.text();
    expect(wire).toContain('"result"');
    return wire;
  };
  forbidWritableStoreOpens();
  cleanups.push(resetStoreWriteGuardForTests);
  expect(await lane.releaseCheck.inputsOffThread!([{
    ...identityOf('garden'), corpusId: CORPORA.internal, privateAtAnswer: false,
  }])).toEqual([{ tier: 'private', gone: false, unroutedPrivate: true }]);
  const ctx = context({ surface: 'remote', connectionId: 'test' });
  const apps = [app, { ...app, appClient: { host: 'claude', connectorUrl: 'https://test.invalid/mcp' } }] as const;
  const workerAnswer = (analyst_provider: 'cloud' | 'venice') => worker.fetch(new Request('http://worker.test/v1/source/answer', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ question, analyst_provider, include_secure_local: false }),
  }));
  return { remoteTool, workerAnswer, question, ctx, apps, modelCalls: () => modelCalls };
}

test.each(['set', 'sidecar'] as const)('remote search withholds an unrouted Private body (%s ledger)', async legacy => {
  const { remoteTool, question, ctx, apps } = await legacyRemoteLane(legacy);
  expect(await remoteTool('olympus_search', {})).not.toContain(SENTENCE);
  for (const options of apps) {
    const search = await callChatGptTool('olympus_search', { question }, ctx, options);
    expect(search.structuredContent?.evidence).toEqual([]);
    expect(JSON.stringify(search)).not.toContain(SENTENCE);
  }
});

test.each(['set', 'sidecar'] as const)('remote answer withholds an unrouted Private body (%s ledger)', async legacy => {
  const { remoteTool, question, ctx, apps, modelCalls } = await legacyRemoteLane(legacy);
  const remoteAnswer = await remoteTool('source_answer', {});
  expect(remoteAnswer).toContain('source_index_policy_violation');
  expect(remoteAnswer).not.toContain(SENTENCE);
  for (const options of apps) {
    const answer = await callChatGptTool('source_answer', { question }, ctx, options);
    expect(answer.isError).toBe(true);
    expect(JSON.stringify(answer)).not.toContain(SENTENCE);
  }
  expect(modelCalls()).toBe(0);
});

test.each([
  ['set', 'cloud'], ['set', 'venice'], ['sidecar', 'cloud'], ['sidecar', 'venice'],
] as const)('%s ledger withholds an unrouted Private body from the %s analyst', async (legacy, analyst_provider) => {
  const { workerAnswer, modelCalls } = await legacyRemoteLane(legacy);
  const response = await workerAnswer(analyst_provider);
  const body = await response.text();
  expect(body).toContain('source_index_policy_violation');
  expect(body).not.toContain(SENTENCE);
  expect(modelCalls()).toBe(0);
});

test.each([
  ['set', 'google-gemini'], ['set', 'venice'], ['sidecar', 'google-gemini'], ['sidecar', 'venice'],
] as const)('cloud embedding withholds an unrouted Private body (%s ledger, %s)', async (legacy, name) => {
  const lane = await gardenLane(JUDGED_PERSONAL_SNIFFER, legacy);
  const provider = new RecordingProvider(name, 'embedding-fixture', 'cloud');
  const result = await lane.fixture.stores.internal!.embedChunks({ provider });
  expect(result.chunksSeen).toBe(1);
  expect(result.chunksEmbedded).toBe(0);
  expect(provider.inputs).toEqual([]);
});

describe('remote search: tiers reread before release', () => {
  test('a Personal item is released when nothing changed', async () => {
    const lane = await gardenLane();
    const raw = await searchReleasedEvidence({ lanes: lane.lanes, question: 'violet turnips garden', releaseCheck: lane.releaseCheck });
    expect(JSON.stringify(searchToolResult(raw).content)).toContain(SENTENCE);
  });

  test('Personal evidence search withholds a held Private keyword match', async () => {
    const lane = await gardenLane({ id: 'waiting', judge: () => ({ verdict: 'undecided', queued: true }) });
    const query = 'violet turnips';
    const identity = identityOf('garden');
    expect(lane.fixture.ledger.copies(identity)).toContainEqual(expect.objectContaining({
      corpusId: CORPORA.secure_local, state: 'current', embedHold: true,
    }));
    expect(lane.fixture.stores.secure_local!.searchItems(query, 10).map(hit => hit.sourceItem.providerItemId)).toEqual(['garden']);

    const raw = await searchReleasedEvidence({ lanes: lane.lanes, question: query, releaseCheck: lane.releaseCheck });
    expect(raw.evidence).toEqual([]);
    expect(JSON.stringify(searchToolResult(raw))).not.toContain('garden-notes');
    expect(JSON.stringify(searchToolResult(raw))).not.toContain(SENTENCE);
  });

  for (const target of [
    { name: 'Private', tiers: { metadataTier: 'private', contentTier: 'secure' } },
    { name: 'Secrets', tiers: { metadataTier: 'secrets', contentTier: 'secrets' } },
  ] as const) {
    test(`moved to ${target.name} while its content is being read: withheld`, async () => {
      const lane = await gardenLane();
      const release = lane.hold();
      const searching = searchReleasedEvidence({ lanes: lane.lanes, question: 'violet turnips garden', releaseCheck: lane.releaseCheck });
      await lane.readStarted;
      await moveTieredItem({ set: lane.fixture.set, identity: identityOf('garden'), target: target.tiers });
      release();
      const raw = await searching;
      const text = JSON.stringify(searchToolResult(raw));
      expect(text).not.toContain('violet turnips');
      expect(text).not.toContain('garden-notes');
      expect(raw.evidence).toEqual([]);
      expect(raw.withheld).toBeGreaterThanOrEqual(1);
    });
  }

  test.each(['sync', 'pool'] as const)('a tier check that cannot be read fails the whole search (%s)', async path => {
    const lane = await gardenLane();
    const broken: ReleaseCheck = {
      inputs: inputs => {
        if (path === 'sync') throw new Error('ledger locked');
        return inputs.map(() => ({ tier: 'public_or_personal', gone: false }));
      },
      ...(path === 'pool' ? { inputsOffThread: async () => { throw new Error('ledger locked'); } } : {}),
      secureDerivativeDefault: () => 'allow',
    };
    await expect(searchReleasedEvidence({ lanes: lane.lanes, question: 'violet turnips garden', releaseCheck: broken }))
      .rejects.toMatchObject({ code: 'source_index_policy_violation' });
  });

  test('an item whose tier cannot be proven is withheld', async () => {
    const lane = await gardenLane();
    const unknown: ReleaseCheck = {
      inputs: (inputs) => inputs.map(() => ({ tier: 'unknown', gone: false })),
      secureDerivativeDefault: () => 'allow',
    };
    const raw = await searchReleasedEvidence({ lanes: lane.lanes, question: 'violet turnips garden', releaseCheck: unknown });
    expect(raw.evidence).toEqual([]);
  });
});

// Exercise the ChatGPT tool boundary with the production search function.
test('ChatGPT olympus_search withholds an item moved after hydration', async () => {
  const lane = await gardenLane();
  const release = lane.hold();
  const searching = callChatGptTool('olympus_search', { question: 'violet turnips garden' }, { releaseCheck: lane.releaseCheck } as OperationContext, {
    dashboardView: async () => { throw new Error('unused'); },
    evidenceSearch: input => searchReleasedEvidence({ lanes: lane.lanes, question: input.question, releaseCheck: lane.releaseCheck }),
  });
  await lane.readStarted;
  await moveTieredItem({ set: lane.fixture.set, identity: identityOf('garden'), target: { metadataTier: 'private', contentTier: 'secure' } });
  release();
  expect(JSON.stringify(await searching)).not.toContain(SENTENCE);
  // This composition-root regression prevents ChatGPT losing the final check
  // while the shared search implementation still passes its own tests.
  const server = readFileSync(new URL('../src/workers/engine/server.ts', import.meta.url), 'utf8');
  const chatgpt = server.slice(server.indexOf('const chatgptEvidenceSearch'), server.indexOf('const remoteEvidenceSearch'));
  expect(chatgpt).toContain('releaseCheck: remoteReleaseCheck');
});

test('ChatGPT rechecks search after a delayed Private probe, before serializing Personal evidence', async () => {
  const lane = await gardenLane();
  let searchDone!: () => void;
  const searched = new Promise<void>((resolve) => { searchDone = resolve; });
  let releaseProbe!: () => void;
  const probeWait = new Promise<void>((resolve) => { releaseProbe = resolve; });
  let hydratedEvidence: unknown;
  const searching = callChatGptTool('olympus_search', { question: 'violet turnips garden' }, { releaseCheck: lane.releaseCheck } as OperationContext, {
    dashboardView: async () => { throw new Error('unused'); },
    async evidenceSearch(input) {
      const raw = await searchReleasedEvidence({ lanes: lane.lanes, question: input.question, releaseCheck: lane.releaseCheck });
      hydratedEvidence = raw.evidence;
      searchDone();
      return raw;
    },
    async privateMatchProbe() {
      await probeWait;
      return { count: 0, evidence: [] };
    },
  });
  await searched;
  // Proves the search's own final check has already released the Personal
  // content; only the later surface check can close this race.
  expect(JSON.stringify(hydratedEvidence)).toContain(SENTENCE);
  await moveTieredItem({ set: lane.fixture.set, identity: identityOf('garden'), target: { metadataTier: 'private', contentTier: 'secure' } });
  releaseProbe();
  const result = await searching;
  expect(JSON.stringify(result)).not.toContain(SENTENCE);
  expect(JSON.stringify(result)).not.toContain('garden-notes');
  expect(result.structuredContent?.evidence).toEqual([]);
});

test('ChatGPT final search check leaves unchanged Personal evidence readable', async () => {
  const lane = await gardenLane();
  const result = await callChatGptTool('olympus_search', { question: 'violet turnips garden' }, { releaseCheck: lane.releaseCheck } as OperationContext, {
    dashboardView: async () => { throw new Error('unused'); },
    evidenceSearch: input => searchReleasedEvidence({ lanes: lane.lanes, question: input.question, releaseCheck: lane.releaseCheck }),
    privateMatchProbe: async () => ({ count: 0, evidence: [] }),
  });
  expect(JSON.stringify(result)).toContain(SENTENCE);
});

// The search implementation already released evidence. This check belongs to
// the ChatGPT boundary after any Private probe has finished waiting.
test.each(['sync', 'pool'] as const)('ChatGPT final search check withholds on a %s read failure', async path => {
  const lane = await gardenLane();
  let checked = false;
  const broken: ReleaseCheck = {
    inputs: inputs => {
      if (path === 'sync') { checked = true; throw new Error('SQLITE_BUSY'); }
      return inputs.map(() => ({ tier: 'public_or_personal', gone: false }));
    },
    ...(path === 'pool' ? { inputsOffThread: async () => { checked = true; throw new Error('SQLITE_BUSY'); } } : {}),
    secureDerivativeDefault: () => 'allow',
  };
  const result = await callChatGptTool('olympus_search', { question: 'violet turnips garden' }, { releaseCheck: broken } as OperationContext, {
    dashboardView: async () => { throw new Error('unused'); },
    evidenceSearch: async input => {
      const raw = await searchReleasedEvidence({ lanes: lane.lanes, question: input.question, releaseCheck: lane.releaseCheck });
      expect(JSON.stringify(raw.evidence)).toContain(SENTENCE);
      return raw;
    },
    privateMatchProbe: async () => ({ count: 0, evidence: [] }),
  });
  expect(checked).toBe(true);
  expect(result.structuredContent?.evidence).toEqual([]);
  expect(JSON.stringify(result)).not.toContain(SENTENCE);
  expect(JSON.stringify(result)).not.toContain('garden-notes');
  expect(result.structuredContent?.notes).toEqual(["Olympus held back some matching items under the owner's privacy rules."]);
});
