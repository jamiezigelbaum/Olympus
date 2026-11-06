// Slice 2: policy-to-store-to-consumer egress, using synthetic source items and
// model runtimes. No live worker, credentials, downloads or provider calls.
// Keep answer quality/readiness coverage in slice 3.
import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { seedEngineSovereignty } from '../src/core/engine-service.ts';
import { saveFirstRunPrivacyChoice } from '../src/core/first-run-privacy.ts';
import { defaultSovereigntyConfigPath, isPublicTierRetired, loadSovereigntyPreset } from '../src/core/sovereignty.ts';
import { ModelSetupService } from '../src/core/model-setup.ts';
import { answerPrivately, type BuiltInAnalystModel } from '../src/core/analyst-built-in.ts';
import type { AnalystModelRequest } from '../src/core/analyst.ts';
import { buildSourceIndexCorpusRegistry } from '../src/core/source-index/corpus.ts';
import { openWaitingPrivateQuestionStore } from '../src/core/waiting-private-questions.ts';
import { createSourceIndexEmbeddingProviderFromSovereignty, loadSourceWorkerSovereignty, createAnalystForSovereigntyProfile } from '../src/workers/email-source/server.ts';
import { WorkerBootSecretResolver } from '../src/workers/credential-degradation.ts';
import { loadConfig } from '../src/core/config.ts';
import { createSourceAnswerLanes } from '../src/workers/email-source/source-answer-lanes.ts';
import { createLocalAnswerPath, createLocalPrivateAnswers } from '../src/workers/email-source/local-private-answers.ts';
import { defineConnectorCorpus } from '../src/workers/connector-store/index.ts';
import { createReleaseTierCheck, createTierVisibilityGate } from '../src/workers/connector-store/tier-visibility.ts';
import { clearInstalledTierClassification, configureInstalledTierClassification } from '../src/workers/classification/installed-tier-classification.ts';
import { resolveTierSnifferRuntime } from '../src/workers/classification/built-in-sniffer.ts';
import { TierSnifferService } from '../src/workers/classification/sniffer-service.ts';
import { BuiltInSourceEmbeddingProvider, loadedBuiltInEmbedding, type BuiltInSourceEmbeddingProviderOptions } from '../src/workers/source-index/built-in-embedding/provider.ts';
import { builtInEmbeddingOnly } from '../src/workers/source-index/embeddings.ts';
import { QWEN35_4B } from '../src/workers/source-index/built-in-reasoning/manifest.ts';
import { checkPrivateEvidenceItems, probePrivateMatch, readPrivateEvidenceItem, searchPrivateEvidence, searchReleasedEvidence } from '../src/workers/source-index/analyst-answer.ts';
import { createBuiltInPrivateAnswerModel, embeddingPanelRelevance } from '../src/workers/chatgpt/private-answer-model.ts';
import { PrivateAnswerJobs } from '../src/workers/chatgpt/private-answer-jobs.ts';
import { generatePanelKeyPair, openPrivateAnswer, type SealedPrivateAnswer } from '../src/workers/chatgpt/private-answer-crypto.ts';
import { createChatGptSetupBackend } from '../src/workers/chatgpt/setup-backend.ts';
import { callSetupTool } from '../src/workers/chatgpt/setup-tools.ts';
import { renderModelSetup } from '../src/workers/dashboard/model-setup.ts';
import { FIXTURE_PLACEMENT, fixtureConnector, identityOf, openTierFixture } from './helpers/tier-fixtures.ts';

const cleanup: Array<() => void> = [];
afterEach(() => { cleanup.splice(0).reverse().forEach(fn => fn()); });

/** Record even requests caught/swallowed by production retries; never delegate. */
function denyNetwork() {
  const attempts: Array<{ transport: string; args: unknown[] }> = [];
  for (const [target, key, transport] of [
    [globalThis, 'fetch', 'fetch'], [http, 'request', 'http.request'], [http, 'get', 'http.get'],
    [https, 'request', 'https.request'], [https, 'get', 'https.get'],
    [net, 'connect', 'net.connect'], [net, 'createConnection', 'net.createConnection'],
    [net.Socket.prototype, 'connect', 'Socket.connect'], [tls, 'connect', 'tls.connect'],
  ] as const) {
    const object = target as unknown as Record<string, unknown>;
    const original = object[key];
    object[key] = (...args: unknown[]) => {
      attempts.push({ transport, args });
      throw new Error(`Outbound request denied: ${transport}`);
    };
    cleanup.push(() => { object[key] = original; });
  }
  return attempts;
}

function install() {
  const root = mkdtempSync(join(tmpdir(), 'first-privacy-egress-'));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const env = {
    HOME: root, XDG_CONFIG_HOME: join(root, 'config'), OLYMPUS_ENGINE_HOST: '1',
    OLYMPUS_BUILT_IN_EMBEDDING_DIR: join(root, 'embedding'),
    OLYMPUS_TIER_RULES_PATH: join(root, 'rules.json'),
    OLYMPUS_PRIVACY_PROFILE_PATH: join(root, 'privacy.json'),
  };
  const path = defaultSovereigntyConfigPath(env);
  mkdirSync(dirname(path), { recursive: true });
  return { root, env, path };
}

const PRIVATE_TEXT = 'EGRESS_PRIVATE_4f17: orchard loan balance is twenty euros. Account holder: Morgan Example.';
const PERSONAL_TEXT = 'EGRESS_PERSONAL_4f17: orchard pruning happens in spring.';
const QUESTION = 'orchard loan balance';
const ANSWER = JSON.stringify({ answer: 'The orchard loan balance is twenty euros [1].', citations: [{ evidence: 1, claim: 'The balance is twenty euros.' }], unanswered: [], sufficient: true });

/** Only local inference is canned; the Analyst, prompts and routing stay real. */
function localModel(text: string | ((request: AnalystModelRequest) => string)) {
  const requests: AnalystModelRequest[] = [];
  const model: BuiltInAnalystModel = {
    name: 'built_in', spec: QWEN35_4B,
    async prepare() {}, async stop() {},
    status: () => ({ state: 'ready', modelId: QWEN35_4B.modelId, percent: 100, label: '', bytesDone: 0, bytesTotal: 0, updatedAt: new Date(0).toISOString() }),
    async complete(request) { requests.push(request); return { text: typeof text === 'string' ? text : text(request), modelId: 'built_in' }; },
  };
  return { model, requests };
}

/** Replace the selected built-in provider's asset/runtime boundaries only.
 * Its actual prepare/embed/loadedOnly, identity and vector writes still run.
 * Never replace a cloud provider with a local fake: assert its concrete class.
 */
async function syntheticRuntime(provider: BuiltInSourceEmbeddingProvider, root: string) {
  const seams = provider as unknown as {
    install: NonNullable<BuiltInSourceEmbeddingProviderOptions['install']>;
    liteRtFactory: NonNullable<BuiltInSourceEmbeddingProviderOptions['liteRt']>;
  };
  const installer = spyOn(seams, 'install').mockImplementation(async () => ({ modelPath: join(root, 'model.bin'), runtimeDir: root, libraryPath: join(root, 'lib.so') }));
  const runtime = spyOn(seams, 'liteRtFactory').mockImplementation(async () => ({
    device: 'cpu', vision: false, async release() {},
    async embed(items) {
      return items.map(item => {
        const text = typeof item === 'string' ? item : item.text;
        const vector = new Float32Array(provider.dimension);
        vector[text.includes('loan') ? 0 : 1] = 1;
        return vector;
      });
    },
  }));
  cleanup.push(() => { runtime.mockRestore(); installer.mockRestore(); });
  await provider.prepare();
}

async function sourcePaths(i: ReturnType<typeof install>) {
  const engine = loadSourceWorkerSovereignty({}, i.env);
  const classifier = localModel(request => JSON.stringify(request).includes('orchard-pruning')
    ? '{"verdicts":[{"i":1,"tier":"personal","category":"ordinary","ownRecord":false,"privateKind":"none","confidence":0.99}]}'
    : '{"verdicts":[{"i":1,"tier":"private","category":"financial","ownRecord":true,"privateKind":"financial","confidence":0.99}]}');
  const sniffer = resolveTierSnifferRuntime({ engine, standaloneEngine: true, builtIn: { model: classifier.model, available: () => true } });
  expect(sniffer.source).toBe('built_in');
  if (sniffer.source !== 'built_in') throw new Error('Expected the installed local classifier');
  const installed = configureInstalledTierClassification({ env: i.env, lane: sniffer.lane, retirePublic: isPublicTierRetired(engine.config) });
  cleanup.push(clearInstalledTierClassification);
  const fixture = openTierFixture(i.root, { embed: false });
  cleanup.push(() => fixture.close());
  const providers = new Map(['internal', 'secure_local'].map(domain => [domain, createSourceIndexEmbeddingProviderFromSovereignty(engine, domain as 'internal' | 'secure_local', i.env)]));
  for (const provider of new Set(providers.values())) {
    expect(provider).toBeInstanceOf(BuiltInSourceEmbeddingProvider);
    await syntheticRuntime(provider as BuiltInSourceEmbeddingProvider, i.root);
  }
  // Capture runtime inputs after setup without mocking embed or retrieval.
  const embeddingCalls: string[] = [];
  for (const provider of new Set(providers.values())) {
    const original = provider!.embed.bind(provider);
    const spy = spyOn(provider!, 'embed').mockImplementation(async (inputs, options) => {
      embeddingCalls.push(...inputs.map(input => input.text));
      return original(inputs, options);
    });
    cleanup.push(() => spy.mockRestore());
  }
  await fixture.set.sync(fixtureConnector(() => [
    { id: 'loan', name: 'bank letter SSN 123-45-6789.txt', text: PRIVATE_TEXT },
    { id: 'garden', name: 'orchard-pruning.txt', text: PERSONAL_TEXT },
  ]), { fetchContent: true, placement: FIXTURE_PLACEMENT });
  const service = new TierSnifferService({ installed, lane: sniffer.lane, model: classifier.model,
    stores: () => fixture.set.openStores(), classificationLedgerPath: join(i.root, 'classification-ledger.jsonl'), autoApproveBuiltIn: true, rejudgePerPass: 0,
  });
  cleanup.push(() => service.stop());
  expect(await service.runOnce()).toMatchObject({ state: 'ran' });
  expect(classifier.requests.length).toBeGreaterThan(0);
  expect(fixture.ledger.getCurrent(identityOf('loan'))).toMatchObject({ state: 'current', contentTier: 'secure' });
  expect(fixture.ledger.getCurrent(identityOf('garden'))).toMatchObject({ state: 'current', contentTier: 'private' });
  for (const store of fixture.set.openStores()) {
    const provider = providers.get(store.trustDomain)!;
    const summary = await store.embedChunks({ provider });
    expect({ corpus: store.corpusId, summary, vectors: store.hasEmbeddings(provider.modelId) }).toMatchObject({ vectors: true });
  }
  const scopes = () => [{ ledger: fixture.ledger, corpusIds: new Set(fixture.set.openStores().map(store => store.corpusId)) }];
  const lanes = createSourceAnswerLanes({
    stores: () => fixture.set.openStores(), registry: () => buildSourceIndexCorpusRegistry(fixture.set.openStores().map(store => defineConnectorCorpus({ corpusId: store.corpusId, family: store.family, trustDomain: store.trustDomain }))),
    embeddingProvider: store => providers.get(store.trustDomain), localEmbedding: loadedBuiltInEmbedding,
    readScope: () => ({ allowed: true, contentAllowed: true }), answerScope: () => ({ kind: 'search' }), accountScope: () => undefined,
    visibilityGate: createTierVisibilityGate(scopes),
  });
  const builtIn = localModel(ANSWER);
  const local = createLocalAnswerPath({ lanes, model: builtIn.model, available: () => true,
    releaseCheck: createReleaseTierCheck(scopes, () => 'approval'),
    relevanceEmbedding: () => builtInEmbeddingOnly(providers.get('secure_local'), loadedBuiltInEmbedding),
  });
  return { engine, fixture, providers, lanes, builtIn, local, embeddingCalls };
}

for (const choice of ['pending', 'local-first', 'local-only'] as const) {
  test(`${choice}: ingest, search, Ask privately, waiting answer, sealed panel and probe make no outbound request`, async () => {
    const i = install();
    const attempts = denyNetwork(); // Includes seed, policy load, ingest and model selection.
    expect(seedEngineSovereignty(i.path)).toBe('pending');
    if (choice !== 'pending') expect(saveFirstRunPrivacyChoice(i.path, choice)).toMatchObject({ ok: true, changed: true });
    const p = await sourcePaths(i);
    if (choice === 'pending') {
      expect(() => p.engine.resolveAnalystPool({ trustDomain: 'internal' })).toThrow('Choose the first-run privacy policy');
      expect(() => p.engine.resolveAnalystPool({ trustDomain: 'secure_local' })).toThrow('Choose the first-run privacy policy');
    }
    expect(p.embeddingCalls.join('\n')).toContain(PRIVATE_TEXT);
    expect(p.embeddingCalls.join('\n')).toContain(PERSONAL_TEXT);
    expect(attempts).toEqual([]);

    // No real secret store is read: the same worker resolver reports an absent key.
    const secretRefs: string[] = [];
    const resolver = new WorkerBootSecretResolver({ resolveSecretRefValueSync: ref => { secretRefs.push(ref); return undefined; } });
    for (const [id, profile] of Object.entries(p.engine.config.modelProfiles)) {
      if (profile.provider !== 'venice') continue;
      expect(createAnalystForSovereigntyProfile({ profile, profileId: id, env: i.env, olympusConfig: loadConfig({}), bootSecretResolver: resolver, veniceAnalystTimeoutMs: undefined, veniceReasoningHeadroomTokens: undefined })).toBeUndefined();
    }
    if (choice === 'local-first') expect(secretRefs.length).toBeGreaterThan(0);
    expect(attempts).toEqual([]);

    const search = await searchReleasedEvidence({ lanes: p.lanes, question: 'orchard pruning' });
    expect(JSON.stringify(search.evidence)).toContain(PERSONAL_TEXT);
    expect(JSON.stringify(search.evidence)).not.toContain(PRIVATE_TEXT);
    expect(attempts).toEqual([]);

    const store = openWaitingPrivateQuestionStore(join(i.root, 'waiting.sqlite'), { isActive: () => true });
    cleanup.push(() => store.close());
    const inbox = createLocalPrivateAnswers({ answer: p.local.answer, eligible: p.local.eligible, store: () => store });
    cleanup.push(() => inbox.close());
    expect((await inbox.handle({ action: 'ask', question: QUESTION }, 'local-owner')).body.status).toBe('answered');
    const waiting = store.record(store.ticket('remote-fixture'), { question: QUESTION, surface: 'remote', state: 'waiting' })!;
    await inbox.tick();
    expect((await inbox.handle({ action: 'read', id: waiting.id }, 'local-owner')).body.status).toBe('answered');
    expect(p.builtIn.requests.length).toBeGreaterThan(0);
    expect(JSON.stringify(p.builtIn.requests)).toContain('EGRESS_PRIVATE_4f17');
    expect(attempts).toEqual([]);

    const evidence = await searchPrivateEvidence({ lanes: p.lanes, question: QUESTION });
    expect(evidence.matched).toBe(1);
    const eligible = (items: Parameters<typeof checkPrivateEvidenceItems>[0]['items']) => checkPrivateEvidenceItems({ lanes: p.lanes, items });
    const panelModel = createBuiltInPrivateAnswerModel({ model: p.builtIn.model, available: () => true, answer: answerPrivately, eligible,
      relevance: embeddingPanelRelevance(() => p.providers.get('secure_local')),
      readItem: (item, request) => readPrivateEvidenceItem({ lanes: p.lanes, item, ...request }),
    });
    const jobs = new PrivateAnswerJobs({ model: () => panelModel, eligible, installId: () => 'c'.repeat(32), claimHoldMs: 0, log: () => {} });
    const { jobId } = jobs.begin({ question: QUESTION, count: evidence.matched, evidence: evidence.candidates.map(item => ({ ...item })), refresh: async () => (await searchPrivateEvidence({ lanes: p.lanes, question: QUESTION })).candidates.map(item => ({ ...item })) });
    expect(jobId).toBeDefined();
    const keys = await generatePanelKeyPair();
    let response = await jobs.claim(jobId!, keys.publicKey);
    for (let n = 0; n < 100 && response.status === 202; n++) { await Bun.sleep(10); response = await jobs.claim(jobId!, keys.publicKey); }
    expect(response.body.status).toBe('ready');
    expect(JSON.stringify(response.body)).not.toContain('twenty euros');
    const plaintext = JSON.parse(await openPrivateAnswer(jobId!, keys.privateKey, response.body as unknown as SealedPrivateAnswer));
    expect(plaintext.answer).toContain('twenty euros');
    expect(attempts).toEqual([]);

    expect(await probePrivateMatch({ lanes: p.lanes, request: { question: QUESTION, retrieval_mode: 'hybrid' }, timeoutMs: 5000 })).toBe('match');
    await Bun.sleep(50); // Let scheduled work attempt transport before restoring it.
    expect(attempts).toEqual([]);
    jobs.sweep(Number.MAX_SAFE_INTEGER);
  });
}

describe('upgrade: preserve exact policy bytes and suppress both first-run surfaces', () => {
  test.each(['local-first', 'local-only', 'private-cloud-only', 'no-sensitive'] as const)('%s', async preset => {
    const i = install();
    const bytes = JSON.stringify(loadSovereigntyPreset(preset), null, 4) + '\n';
    writeFileSync(i.path, bytes);
    const attempts = denyNetwork();
    expect(seedEngineSovereignty(i.path)).toBeUndefined();
    const engine = loadSourceWorkerSovereignty({}, i.env);
    const status = new ModelSetupService({ config: engine.config, credentialState: () => 'missing', autoCheck: false }).getStatus();
    expect(status.privacy_choice_pending).toBeUndefined();
    expect(renderModelSetup(status)).not.toContain('data-first-run-sheet');
    const backend = createChatGptSetupBackend({ sovereignty: engine, credentialPresent: () => false, requestReload: () => true,
      workerFetch: async () => { throw new Error('Upgrade privacy read must be local'); }, publicUrls: () => undefined, handoffs: {} as never, env: i.env });
    const result = await callSetupTool('olympus_privacy_get', {}, backend);
    expect(((result._meta as Record<string, { privateAnswerChoice?: unknown }>)['olympus/privacy']!).privateAnswerChoice).toBeUndefined();
    expect(saveFirstRunPrivacyChoice(i.path, 'local-only')).toMatchObject({ ok: true, changed: false });
    expect(readFileSync(i.path, 'utf8')).toBe(bytes);
    expect(attempts).toEqual([]);
  });
});
