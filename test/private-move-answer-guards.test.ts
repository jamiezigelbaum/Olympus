import { expect, test } from 'bun:test';
import { defaultConfig } from '../src/core/config.ts';
import { DirectHttpEmailTransport, EmailClient } from '../src/core/email.ts';
import { findOperationByName, type OperationContext } from '../src/core/operations.ts';
import { SourceAnswerJobRegistry, type SourceAnswerPending } from '../src/core/source-answer-jobs.ts';
import { createReleaseManifestSink, recordReleaseManifest, runWithReleaseManifestSink, type ReleaseCheck } from '../src/core/release-manifest.ts';
import { buildSourceIndexCorpusRegistry, defineSourceIndexCorpus } from '../src/core/source-index/corpus.ts';
import { buildSourceSensitivity } from '../src/core/source-index/types.ts';
import { createAnalystSourceIndexAnswerHandler } from '../src/workers/source-index/analyst-answer.ts';
import { createEmailSourceWorker } from '../src/workers/email-source/index.ts';
import { callChatGptTool } from '../src/workers/chatgpt/mcp-surface.ts';
import { createInProcessOperationContext } from '../src/workers/remote-mcp.ts';

const CORPUS = 'internal.email';
const SENTINEL = 'Personal-read-secret-sentinel';
const input = { corpusId: CORPUS, provider: 'gmail', accountScope: 'test-account', providerItemId: 'message-1', privateAtAnswer: false };
const constraints = { secureDerivativeDefault: 'allow' as const, includeSecureLocalContent: false };

function mutableTier() {
  let privateNow = false;
  const check: ReleaseCheck = {
    inputs: (inputs) => inputs.map(() => ({ tier: privateNow ? 'private' : 'public_or_personal', gone: false })),
    secureDerivativeDefault: () => 'allow',
  };
  return { check, promote: () => { privateNow = true; } };
}

function pipeline(tier: ReturnType<typeof mutableTier>, promoteOnHydration = false, failFirst = false, promoteDuringInference = false) {
  let calls = 0;
  const identity = { family: 'email' as const, provider: 'gmail', accountScope: input.accountScope, providerItemId: input.providerItemId, localItemId: 'message-1' };
  const handler = createAnalystSourceIndexAnswerHandler({
    releaseCheck: tier.check,
    analyst: { async analyze(pack) {
      calls++;
      if (failFirst && calls === 1) { tier.promote(); throw new Error('first leg failed'); }
      if (promoteDuringInference) tier.promote();
      return { answer: SENTINEL, citations: [{ provenance: pack.candidates[0]!.provenance, claim: SENTINEL }], unanswered: [] };
    } },
    lanes: () => ({
      registry: buildSourceIndexCorpusRegistry([defineSourceIndexCorpus({ corpusId: CORPUS, family: 'email', trustDomain: 'internal' })]),
      adapters: { [CORPUS]: () => ({ hits: [{ sourceItem: identity, provenance: { sourceItem: identity }, score: 1, rawExposed: false }], latencyMs: 1, rawExposed: false }) },
      contentProviders: { [CORPUS]: { async fetchLocalContent() {
        if (promoteOnHydration) tier.promote();
        return { sensitivity: buildSourceSensitivity({ trustTier: 'S2', trustDomain: 'internal' }), chunks: [SENTINEL] };
      } } },
    }),
  });
  return { handler, calls: () => calls };
}

test('analyst dispatch refuses a Personal pack promoted during hydration, before any model reads it', async () => {
  const tier = mutableTier();
  const source = pipeline(tier, true);
  await expect(source.handler.answer({ question: 'What is in the message?' })).rejects.toThrow('became Private');
  expect(source.calls()).toBe(0);
});

test('unchanged Personal packs still dispatch and answer', async () => {
  const source = pipeline(mutableTier());
  expect((await source.handler.answer({ question: 'What is in the message?' })).answer).toBe(SENTINEL);
  expect(source.calls()).toBe(1);
});

test.each(['native', 'cli'] as const)('%s checks final release after promotion during inference, while unchanged Personal answers return', async surface => {
  for (const promote of [false, true]) {
    const tier = mutableTier();
    tier.check.secureDerivativeDefault = () => 'approval';
    const source = pipeline(tier, false, false, promote);
    const worker = createEmailSourceWorker({ sourceAnswer: source.handler, sourceAnswerReleaseCheck: tier.check });
    const config = defaultConfig();
    config.email.enabled = true; config.sourceIndex.enabled = true;
    const email = new EmailClient(config, new DirectHttpEmailTransport((url, init) => worker.fetch(new Request(url, init))));
    try {
      const result = await findOperationByName('source_answer')!.handler({ config, email, caller: { surface } } as OperationContext, { question: 'What is in the message?' });
      expect(source.calls()).toBe(1); // the pre-inference guard allowed Personal
      if (promote) {
        expect(result).toEqual({ answer: 'Olympus withheld this answer because an item became Private.', evidence: [] });
        expect(JSON.stringify(result)).not.toContain(SENTINEL);
      } else expect((result as { answer: string }).answer).toBe(SENTINEL);
      expect(JSON.stringify(result)).not.toContain('_release_ticket');
    } finally { worker.close(); }
  }
});

async function cachedJob(jobs: SourceAnswerJobRegistry, owner: string, result: unknown, manifest = false) {
  let finish!: () => void;
  const gate = new Promise<void>((resolve) => { finish = resolve; });
  const sink = createReleaseManifestSink();
  const pending = await runWithReleaseManifestSink(sink, () => jobs.run({ registry: jobs, owner }, async () => {
    if (manifest) recordReleaseManifest({ inputs: [input], constraints });
    await gate;
    return result;
  })) as SourceAnswerPending;
  finish();
  return pending.job_id;
}

test('ChatGPT cached collection withholds a previously Personal answer even when Private derivatives are otherwise allowed', async () => {
  const tier = mutableTier();
  const source = pipeline(tier);
  const result = await source.handler.answer({ question: 'What is in the message?' });
  const jobs = new SourceAnswerJobRegistry({ limits: { handoffMs: 1, resultWaitMs: 30 } });
  const worker = createEmailSourceWorker({ sourceAnswer: source.handler });
  const ctx = { ...createInProcessOperationContext({ config: defaultConfig(), sourceIndexReadEnabled: true, workerFetch: worker.fetch, caller: { surface: 'remote', connectionId: 'test' }, sourceAnswerJobs: jobs }), releaseCheck: tier.check };
  const id = await cachedJob(jobs, ctx.sourceAnswerJobs!.owner, result, true);
  tier.promote();
  const released = await callChatGptTool('source_answer_result', { job_id: id }, ctx, { dashboardView: async () => { throw new Error('not used'); }, answerModelAvailable: () => true });
  expect(JSON.stringify(released)).not.toContain(SENTINEL);
  expect(JSON.stringify(released)).toContain('became Private');
});

test('stdio cached collection checks the worker manifest across fresh EmailClient instances and strips the ticket', async () => {
  const tier = mutableTier();
  const source = pipeline(tier);
  const worker = createEmailSourceWorker({ sourceAnswer: source.handler, sourceAnswerReleaseCheck: tier.check });
  const config = defaultConfig();
  config.email.enabled = true;
  config.sourceIndex.enabled = true;
  const transport = new DirectHttpEmailTransport((url, init) => worker.fetch(new Request(url, init)));
  const email = new EmailClient(config, transport);
  const result = await email.sourceAnswer({ question: 'What is in the message?', caller: { surface: 'mcp' } });
  expect(result.answer).toBe(SENTINEL);
  expect(JSON.stringify(result)).not.toContain('_release_ticket');
  const jobs = new SourceAnswerJobRegistry({ limits: { handoffMs: 1, resultWaitMs: 30 } });
  const id = await cachedJob(jobs, 'mcp:test', result);
  const context = { config, caller: { surface: 'mcp' }, email: new EmailClient(config, transport), sourceAnswerJobs: { registry: jobs, owner: 'mcp:test' } } as OperationContext;
  const collect = findOperationByName('source_answer_result')!;
  expect((await collect.handler(context, { job_id: id }) as { answer: string }).answer).toBe(SENTINEL);
  tier.promote();
  const withheld = await collect.handler(context, { job_id: id });
  expect(JSON.stringify(withheld)).not.toContain(SENTINEL);
  expect(withheld).toEqual({ answer: 'Olympus withheld this answer because an item became Private.', evidence: [] });
});

test('fresh dispatch visibility rejects stale content when the lower copy remains current for metadata only', async () => {
  const { CORPORA, FIXTURE_PLACEMENT, fixtureConnector, identityOf, openTierFixture, tempDir } = await import('./helpers/tier-fixtures.ts');
  const { moveTieredItem } = await import('../src/workers/connector-store/tier-move.ts');
  const { createTierVisibilityGate } = await import('../src/workers/connector-store/tier-visibility.ts');
  const { dir, cleanup } = tempDir();
  const fixture = openTierFixture(dir);
  try {
    await fixture.set.sync(fixtureConnector(() => [{ id: 'garden', name: 'garden.txt', text: 'The garden contains ordinary compost notes.' }]), { fetchContent: true, placement: FIXTURE_PLACEMENT });
    const stale = fixture.stores.internal!.searchItems('compost', 5)[0]!;
    await moveTieredItem({ set: fixture.set, identity: identityOf('garden'), target: { metadataTier: 'private', contentTier: 'secure' } });
    const gate = createTierVisibilityGate(() => [{ ledger: fixture.ledger, corpusIds: new Set(Object.values(CORPORA)) }]);
    const hit = { sourceItem: stale.sourceItem, corpusId: CORPORA.internal, trustDomain: 'internal' as const, rawExposed: false as const };
    expect(gate([{ ...hit, servingLayer: 'content' }])).toHaveLength(0);
    expect(gate([{ ...hit, servingLayer: 'metadata' }])).toHaveLength(1);
  } finally { fixture.close(); cleanup(); }
});

test('ChatGPT fails closed for a cached answer without a checker or without a release manifest', async () => {
  for (const missing of ['checker', 'manifest'] as const) {
    const tier = mutableTier();
    const source = pipeline(tier);
    const result = await source.handler.answer({ question: 'What is in the message?' });
    const jobs = new SourceAnswerJobRegistry({ limits: { handoffMs: 1, resultWaitMs: 30 } });
    const worker = createEmailSourceWorker({ sourceAnswer: source.handler });
    const base = createInProcessOperationContext({ config: defaultConfig(), sourceIndexReadEnabled: true, workerFetch: worker.fetch, caller: { surface: 'remote', connectionId: 'test' }, sourceAnswerJobs: jobs });
    const ctx = missing === 'checker' ? base : { ...base, releaseCheck: tier.check };
    const id = await cachedJob(jobs, ctx.sourceAnswerJobs!.owner, result, missing !== 'manifest');
    const released = await callChatGptTool('source_answer_result', { job_id: id }, ctx, { dashboardView: async () => { throw new Error('not used'); }, answerModelAvailable: () => true });
    expect(JSON.stringify(released)).not.toContain(SENTINEL);
    expect(JSON.stringify(released)).toContain('could not be verified');
  }
});

test('stdio refuses cached content when its transport cannot revalidate the release ticket', async () => {
  const source = pipeline(mutableTier());
  const result = await source.handler.answer({ question: 'What is in the message?' });
  const jobs = new SourceAnswerJobRegistry({ limits: { handoffMs: 1, resultWaitMs: 30 } });
  const id = await cachedJob(jobs, 'mcp:test', result);
  const context = { config: defaultConfig(), caller: { surface: 'mcp' }, email: {}, sourceAnswerJobs: { registry: jobs, owner: 'mcp:test' } } as OperationContext;
  const withheld = await findOperationByName('source_answer_result')!.handler(context, { job_id: id });
  expect(JSON.stringify(withheld)).not.toContain(SENTINEL);
  expect(JSON.stringify(withheld)).toContain('could not be verified');
});
