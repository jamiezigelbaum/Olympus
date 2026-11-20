// The remote evidence search rereads every item's tier right before its
// result leaves (source-index/analyst-answer.ts searchReleasedEvidence
// releaseCheck): an item the owner moves to Private or Secrets while the
// search is reading it is withheld. Codex gpt-6-astra review of PR #300,
// 2026-10-12, reproduced exactly this with a paused content read.

import { readFileSync } from 'node:fs';
import { callChatGptTool } from '../src/workers/chatgpt/mcp-surface.ts';
import { PRIVATE_ANSWER_META_KEY } from '../src/workers/chatgpt/private-answer-contract.ts';
import type { PrivateAnswerJobs } from '../src/workers/chatgpt/private-answer-jobs.ts';
import type { OperationContext } from '../src/core/operations.ts';
import { afterEach, describe, expect, test } from 'bun:test';
import { buildSourceIndexCorpusRegistry } from '../src/core/source-index/corpus.ts';
import { createReleaseManifestSink, prepareSearchEvidenceRelease, runWithReleaseManifestSink, type ReleaseCheck } from '../src/core/release-manifest.ts';
import type { TierSniffer } from '../src/workers/classification/tier-classifier.ts';
import { searchToolResult } from '../src/workers/chatgpt/response-builder.ts';
import { createConnectorStoreContentProvider, createConnectorStoreCorpusAdapter, defineConnectorCorpus } from '../src/workers/connector-store/index.ts';
import { moveTieredItem } from '../src/workers/connector-store/tier-move.ts';
import { createReleaseTierCheck, createTierVisibilityGate } from '../src/workers/connector-store/tier-visibility.ts';
import { probePrivateMatch, searchPrivateEvidence, searchReleasedEvidence } from '../src/workers/source-index/analyst-answer.ts';
import { createRemotePrivateParts } from '../src/core/remote-private-part.ts';
import { REMOTE_SECRET_NOTE } from '../src/core/remote-result.ts';
import { remoteSearchExtension } from '../src/workers/remote-search.ts';
import { CORPORA, FIXTURE_PLACEMENT, fixtureConnector, identityOf, openTierFixture, tempDir } from './helpers/tier-fixtures.ts';
import { JUDGED_PERSONAL_SNIFFER } from './helpers/tier-fixtures.ts';
import { registerInstalledTierClassification } from '../src/workers/classification/installed-tier-classification-registry.ts';

const SENTENCE = 'The garden contains violet turnips.';
const cleanups: Array<() => void> = [];

afterEach(() => {
  registerInstalledTierClassification(undefined);
  while (cleanups.length > 0) cleanups.pop()!();
});

async function gardenLane(sniffer: TierSniffer = JUDGED_PERSONAL_SNIFFER, namesOnly = false) {
  // These short fixtures already have whole-item judgments. No new window
  // record or model call is needed to exercise the later tier-change race.
  registerInstalledTierClassification({ forLedger: () => ({ sniffer, releaseJudge: {
    modelId: 'fixture', promptVersion: 'fixture', read: () => undefined,
    record: () => { throw new Error('short items need no window records'); },
    resolve: async () => { throw new Error('short items need no new calls'); },
  } }) });
  const { dir, cleanup } = tempDir();
  const fixture = openTierFixture(dir, { embed: false });
  cleanups.push(() => {
    fixture.close();
    cleanup();
  });
  const items = [{ id: 'garden', name: 'garden-notes.txt', text: SENTENCE }];
  if (namesOnly) items.push({ id: 'field', name: 'field-notes.txt', text: 'Violet turnips grow beside the shed.' });
  await fixture.set.sync(fixtureConnector(() => items), { fetchContent: true, placement: FIXTURE_PLACEMENT });
  // Every content read waits here until the test lets it go.
  let pause: Promise<void> | undefined;
  let reading: (() => void) | undefined;
  const readStarted = new Promise<void>((resolve) => { reading = resolve; });
  if (namesOnly) {
    for (const id of ['garden', 'field']) fixture.stores.internal!.grantOnDemandRead(`personal:${id}`, 'v1');
  }
  const lanes = () => {
    const stores = fixture.set.openStores();
    return {
      registry: buildSourceIndexCorpusRegistry(stores.map((store) => defineConnectorCorpus({
        corpusId: store.corpusId, family: store.family, trustDomain: store.trustDomain,
      }))),
      adapters: Object.fromEntries(stores.map((store) => [store.corpusId, createConnectorStoreCorpusAdapter({ store, ...(namesOnly ? { filters: { metadataOnlyLocatorPathScopes: ['/Files'] } } : {}) })])),
      contentProviders: Object.fromEntries(stores.map((store) => {
        const provider = createConnectorStoreContentProvider({ store, ...(namesOnly ? { contentAllowed: false, metadataFilters: { locatorPathScope: '/Files' } } : {}) });
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
  const releaseCheck = createReleaseTierCheck(() => [{ ledger: fixture.ledger, corpusIds: new Set(Object.values(CORPORA)) }], () => 'allow');
  const hold = () => {
    let release!: () => void;
    pause = new Promise<void>((resolve) => { release = resolve; });
    return release;
  };
  return { fixture, lanes, releaseCheck, hold, readStarted };
}

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

test('ChatGPT drops a revoked body match and renumbers the surviving evidence after its Private probe', async () => {
  const lane = await gardenLane(JUDGED_PERSONAL_SNIFFER, true);
  const searched = Promise.withResolvers<string[]>();
  const probe = Promise.withResolvers<void>();
  const searching = callChatGptTool('olympus_search', { question: 'violet turnips' }, { releaseCheck: lane.releaseCheck } as OperationContext, {
    dashboardView: async () => { throw new Error('unused'); },
    async evidenceSearch(input) {
      const raw = await searchReleasedEvidence({ lanes: lane.lanes, question: input.question, releaseCheck: lane.releaseCheck });
      searched.resolve(raw.evidence.map(item => item.provider_item_id).sort());
      return raw;
    },
    async privateMatchProbe() {
      await probe.promise;
      return { count: 0, evidence: [] };
    },
  });
  expect(await searched.promise).toEqual(['field', 'garden']);
  lane.fixture.stores.internal!.revokeOnDemandRead('personal:garden');
  probe.resolve();
  const result = await searching;
  expect(result.structuredContent?.evidence).toEqual([
    expect.objectContaining({ id: 'E1', title: 'field-notes.txt', excerpt: 'Violet turnips grow beside the shed.' }),
  ]);
  expect(JSON.stringify(result)).not.toContain('garden');
  expect(JSON.stringify(result)).not.toContain('[E2]');
});

test('final release removes a revoked breadth match outside the selected evidence', async () => {
  const lane = await gardenLane(JUDGED_PERSONAL_SNIFFER, true);
  const sink = createReleaseManifestSink();
  const raw = await runWithReleaseManifestSink(sink, () => searchReleasedEvidence({
    lanes: lane.lanes, question: 'violet turnips', maxResults: 1, releaseCheck: lane.releaseCheck,
  }));
  expect(raw.evidence).toHaveLength(1);
  expect(raw.coverage.matches).toContainEqual(expect.objectContaining({ matched_items: 2, in_evidence: 1 }));
  const finish = await prepareSearchEvidenceRelease({ ...raw }, sink.manifests, lane.releaseCheck);
  const selected = raw.evidence[0]!.provider_item_id;
  lane.fixture.stores.internal!.revokeOnDemandRead(selected === 'garden' ? 'personal:field' : 'personal:garden');
  const released = finish().raw;
  expect(released.evidence).toEqual(raw.evidence);
  expect(released.coverage).toMatchObject({ matches: expect.arrayContaining([expect.objectContaining({ matched_items: 1, in_evidence: 1 })]) });
});

async function privateProbeLane() {
  const lane = await gardenLane(JUDGED_PERSONAL_SNIFFER, true);
  await moveTieredItem({ set: lane.fixture.set, identity: identityOf('field'), target: { metadataTier: 'secure', contentTier: 'secure' } });
  const store = lane.fixture.stores.secure_local!;
  store.grantOnDemandRead('personal:field', 'v1');
  const checking = Promise.withResolvers<void>();
  const finished = Promise.withResolvers<void>();
  const releaseCheck: ReleaseCheck = {
    ...lane.releaseCheck,
    async chunks(inputs, options) {
      checking.resolve();
      await finished.promise;
      return lane.releaseCheck.chunks!(inputs, options);
    },
  };
  return { ...lane, store, checking, finished, finalReleaseCheck: releaseCheck };
}

test.each([false, true])('ChatGPT releases a Private match count only while its body grant holds (Secret match %s)', async secretMatch => {
  const lane = await privateProbeLane();
  const question = 'violet turnips';
  const panelEvidence: number[] = [];
  const searching = callChatGptTool('olympus_search', { question }, { releaseCheck: lane.finalReleaseCheck } as OperationContext, {
    dashboardView: async () => { throw new Error('unused'); },
    evidenceSearch: input => searchReleasedEvidence({ lanes: lane.lanes, question: input.question, releaseCheck: lane.releaseCheck }),
    async privateMatchProbe() {
      const { matched, candidates } = await searchPrivateEvidence({ lanes: lane.lanes, question });
      expect(matched).toBe(1);
      expect(candidates[0]?.provenance.sourceItem?.providerItemId).toBe('field');
      return { count: matched, evidence: candidates as unknown as Record<string, unknown>[], ...(secretMatch ? { secretMatch: true as const } : {}) };
    },
    privateAnswers: {
      begin(input: Parameters<PrivateAnswerJobs['begin']>[0]) {
        panelEvidence.push(input.evidence.length);
        return { panelState: 'no_model', count: input.count };
      },
    } as PrivateAnswerJobs,
  });
  await lane.checking.promise;
  lane.store.revokeOnDemandRead('personal:field');
  lane.finished.resolve();
  const result = await searching;
  expect(JSON.stringify(result)).toContain(SENTENCE);
  const panel = (result._meta as Record<string, unknown> | undefined)?.[PRIVATE_ANSWER_META_KEY];
  if (secretMatch) {
    expect(panel).toMatchObject({ count: 1 });
    expect(JSON.stringify(result)).toContain(REMOTE_SECRET_NOTE);
    expect(panelEvidence).toEqual([0]);
  } else {
    expect(panel).toMatchObject({ count: 0 });
    expect(panel).not.toHaveProperty('jobId');
    expect(panelEvidence).toEqual([]);
  }
});

test('remote search drops a grant-derived Private note and waiting record when the grant is revoked during final checks', async () => {
  const lane = await privateProbeLane();
  const question = 'violet turnips';
  let recorded = 0;
  const remote = createRemotePrivateParts({
    probe: (_request, timeoutMs) => probePrivateMatch({
      lanes: lane.lanes, request: { question }, timeoutMs, deferGrantCheck: true,
    }),
    store: () => ({
      ticket: connectionId => ({ connectionId, revocation: 0 }),
      record: () => { recorded += 1; return { id: 'question', generation: 1, connectionId: 'agent' }; },
      unchecked: () => [],
      settleUnchecked: () => false,
      revokeConnection: () => 0,
      reconcileConnections: () => 0,
    }),
  });
  cleanups.push(() => remote.close());
  const extension = remoteSearchExtension({
    evidenceSearch: input => searchReleasedEvidence({ lanes: lane.lanes, question: input.question, releaseCheck: lane.releaseCheck }),
  }, () => 'active', { privatePart: remote.forConnection('agent'), releaseCheck: lane.finalReleaseCheck });
  const searching = extension.call!({ params: { name: 'olympus_search', arguments: { question } } },
    async () => { throw new Error('unused'); });
  await lane.checking.promise;
  lane.store.revokeOnDemandRead('personal:field');
  lane.finished.resolve();
  const result = await searching;
  expect(JSON.stringify(result)).toContain(SENTENCE);
  expect(result.structuredContent).not.toHaveProperty('private_note');
  expect(recorded).toBe(0);
});
