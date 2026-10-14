import { afterEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BuiltInAnalystModel } from '../src/core/analyst-built-in.ts';
import type { EvidencePack } from '../src/core/contracts.ts';
import { createAnalyst, type AnalystModelRequest } from '../src/core/analyst.ts';
import { buildSourceIndexCorpusRegistry, defineSourceIndexCorpus } from '../src/core/source-index/corpus.ts';
import { buildSourceSensitivity } from '../src/core/source-index/types.ts';
import { createAnalystSourceIndexAnswerHandler, guardSourceAnswerEvidence, type AnalystAnswerLanes } from '../src/workers/source-index/analyst-answer.ts';
import { openWaitingPrivateQuestionStore, type StoredPrivateAnswer, type WaitingQuestionRef } from '../src/core/waiting-private-questions.ts';
import { createLocalModelActivity, runBackgroundInference } from '../src/workers/answer-activity.ts';
import { createBuiltInPrivateAnswerModel } from '../src/workers/chatgpt/private-answer-model.ts';
import { PrivateAnswerJobs } from '../src/workers/chatgpt/private-answer-jobs.ts';
import { generatePanelKeyPair, openPrivateAnswer, type SealedPrivateAnswer } from '../src/workers/chatgpt/private-answer-crypto.ts';
import { createLocalPrivateAnswers } from '../src/workers/email-source/local-private-answers.ts';
import type { LocalAnswerResult } from '../src/workers/source-index/local-answer.ts';
import { QWEN35_4B } from '../src/workers/source-index/built-in-reasoning/manifest.ts';

const SENTINEL = 'SYNTHETIC_PRIVATE_QUEUE_PASSAGE_7ac2';
const EVIDENCE = [{ corpusId: 'secure_local.synthetic.review', trustDomain: 'secure_local', trust_domain: 'secure_local',
  title: 'Synthetic document', text: SENTINEL, provenance: { sourceItem: { providerItemId: 'synthetic-review' } } }];
const cleanups: Array<() => void> = [];
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); });
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
async function until(predicate: () => boolean) {
  const deadline = Date.now() + 2_000;
  while (!predicate() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 2));
  expect(predicate()).toBe(true);
}
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'olympus-inbox-review-'));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  let clock = Date.parse('2026-10-14T12:00:00Z');
  const dbPath = join(dir, 'private', 'waiting-private-questions.sqlite');
  const store = openWaitingPrivateQuestionStore(dbPath, { now: () => clock, busyTimeoutMs: 0 });
  cleanups.push(() => store.close());
  const record = (question: string, surface: 'remote' | 'chatgpt' = 'remote') => {
    const ref = store.record(store.ticket('synthetic-agent'), { question, surface, state: 'waiting' });
    expect(ref).toBeDefined();
    return ref!;
  };
  return { store, dbPath, record, now: () => clock, advance: (ms: number) => { clock += ms; } };
}
function saved(): StoredPrivateAnswer {
  return { status: 'answered', answer: 'Synthetic retained answer', citations: [{ title: 'Synthetic source', url: 'https://example.invalid/source' }],
    unanswered: [], leftOut: [], read: EVIDENCE.map(({ text: _text, ...identity }) => identity) };
}
function localResult(): Extract<LocalAnswerResult, { status: 'answered' }> {
  return { ...saved(), status: 'answered', answer: 'Synthetic retained answer' };
}

describe('model-slot privacy fences', () => {
  for (const change of ['Secret', 'cancelled'] as const) {
    test(`queued private submission is withheld when ${change} before the owner releases the model`, async () => {
      const activity = createLocalModelActivity();
      const ownerGate = deferred<{ text: string; modelId: string }>();
      const dispatchEntered = deferred<void>();
      const submitted: AnalystModelRequest[] = [];
      let ownerRunning = false;
      let eligible = true;
      let guardChecks = 0;
      const raw: BuiltInAnalystModel = {
        name: 'built_in', spec: QWEN35_4B, prepare: async () => {}, stop: async () => {},
        status: () => ({ state: 'ready', modelId: QWEN35_4B.modelId, percent: 100, label: '', bytesDone: 0, bytesTotal: 0, updatedAt: new Date(0).toISOString() }),
        complete: async request => {
          submitted.push(request);
          if (request.prompt === 'owner occupying model') { ownerRunning = true; return ownerGate.promise; }
          return { text: 'Synthetic completion', modelId: 'synthetic' };
        },
      };
      const tracked = activity.track('synthetic-resource', raw);
      const owner = tracked.complete({ system: 'synthetic', prompt: 'owner occupying model', localOnly: true });
      await until(() => ownerRunning);
      const panelModel = createBuiltInPrivateAnswerModel({
        model: tracked, available: () => true,
        eligible: async items => { guardChecks++; return items.map(() => eligible); },
        answer: async (_question, evidence, options) => {
          const completion = options.model!.complete({ system: 'synthetic', prompt: evidence.map(item => item.text).join('\n'), localOnly: true,
            ...(options.signal ? { signal: options.signal } : {}) });
          dispatchEntered.resolve();
          await completion;
          return { answer: 'Synthetic answer', citations: [], unanswered: [], modelId: 'synthetic' };
        },
      });
      const abort = new AbortController();
      const privateAnswer = runBackgroundInference(() => panelModel.answerPrivately('Synthetic question?', EVIDENCE, abort.signal));
      // Attach rejection observation before withdrawing eligibility or aborting.
      const outcome = privateAnswer.then(() => 'answered', () => 'withheld');
      await dispatchEntered.promise;
      // Let the guarded completion finish its first live check and join the occupied queue.
      await new Promise(resolve => setTimeout(resolve, 0));
      expect(guardChecks).toBeGreaterThan(0);
      expect(submitted).toHaveLength(1);
      if (change === 'Secret') eligible = false;
      else abort.abort();
      ownerGate.resolve({ text: 'Owner completed', modelId: 'synthetic' });
      await owner;
      expect(await outcome).toBe('withheld');
      expect(submitted.map(request => request.prompt)).toEqual(['owner occupying model']);
      expect(JSON.stringify(submitted)).not.toContain(SENTINEL);
    });
  }

  for (const stage of ['main', 'audit'] as const) {
    test(`ordinary source-answer ${stage} cannot submit stale evidence after waiting behind owner inference`, async () => {
      const corpusId = 'secure_local.synthetic.source-answer';
      const sourceItem = { family: 'file' as const, provider: 'synthetic', accountScope: 'fixture', providerItemId: 'synthetic-renewal', localItemId: 'local-renewal' };
      const activity = createLocalModelActivity();
      const ownerGate = deferred<{ text: string; modelId: string }>();
      const mainGate = deferred<{ text: string; modelId: string }>();
      const underlying: AnalystModelRequest[] = [];
      const requested: AnalystModelRequest[] = [];
      let eligible = true;
      let guardChecks = 0;
      const tracked = activity.track('synthetic-source-answer-model', {
        async complete(request: AnalystModelRequest) {
          underlying.push(request);
          if (request.prompt === 'owner source-answer blocker') return ownerGate.promise;
          if (stage === 'audit') return mainGate.promise;
          return { text: JSON.stringify({ answer: 'Synthetic renewal is in May.', citations: [{ evidence: 1, claim: 'Synthetic renewal is in May.' }], unanswered: [], sufficient: true }), modelId: 'synthetic' };
        },
      });
      const analyst = createAnalyst({ complete: request => { requested.push(request); return tracked.complete(request); } }, {
        auditSuspiciousDrafts: stage === 'audit',
      });
      const provider = {
        fetchLocalContent: async () => ({ sensitivity: buildSourceSensitivity({ trustTier: eligible ? 'S4' : 'S5', trustDomain: 'secure_local' }), chunks: eligible ? [SENTINEL] : [] }),
        // Exercise both live-provider seams: main reads current sensitivity;
        // audit uses the connector-style content eligibility fast path.
        ...(stage === 'audit' ? { contentServable: () => eligible } : {}),
      };
      const lanes = (): AnalystAnswerLanes => ({
        registry: buildSourceIndexCorpusRegistry([defineSourceIndexCorpus({ corpusId, family: 'file', trustDomain: 'secure_local' })]),
        adapters: { [corpusId]: () => ({ hits: [{ sourceItem, provenance: { sourceItem, citation: { title: 'Synthetic renewal' } }, score: 1, rawExposed: false as const }], latencyMs: 0, rawExposed: false as const }) },
        contentProviders: { [corpusId]: provider },
      });
      const handler = createAnalystSourceIndexAnswerHandler({
        analyst,
        lanes,
        inferenceGuard: async (pack, request, corpusIds) => {
          guardChecks++;
          expect(request.question).toBe('When is the synthetic renewal?');
          expect(corpusIds).toContain(corpusId);
          expect(pack.candidates.some(candidate => candidate.chunks.some(chunk => chunk.includes(SENTINEL)))).toBe(true);
          await guardSourceAnswerEvidence({ lanes, request, pack, corpusIds });
        },
      });
      const ownerRequest = { system: 'synthetic', prompt: 'owner source-answer blocker', localOnly: true };
      let owner: Promise<{ text: string; modelId: string }> | undefined;
      if (stage === 'main') {
        owner = tracked.complete(ownerRequest);
        await until(() => underlying.length === 1);
      }
      const answer = runBackgroundInference(() => handler.answer({ question: 'When is the synthetic renewal?', corpus_id: corpusId, include_secure_local: true }));
      const outcome = answer.then(result => JSON.stringify(result), () => 'withheld');
      if (stage === 'audit') {
        await until(() => underlying.length === 1);
        expect(underlying[0]!.prompt).toContain(SENTINEL);
        // Owner work enters the same queue while the main inference is still running.
        owner = tracked.complete(ownerRequest);
        mainGate.resolve({ text: JSON.stringify({ answer: 'Synthetic renewal is in May.', citations: [{ evidence: 1, claim: 'Synthetic renewal is in May.' }], unanswered: [], sufficient: true }), modelId: 'synthetic' });
        await until(() => underlying.some(request => request.prompt === ownerRequest.prompt));
      }
      // The observer is outside the production tracked queue, so this proves the
      // main/audit request reached that queue while its slot remained occupied.
      await until(() => requested.length === (stage === 'main' ? 1 : 2));
      expect(guardChecks).toBeGreaterThan(0);
      expect(requested.at(-1)!.prompt).toContain(SENTINEL);
      eligible = false;
      ownerGate.resolve({ text: 'Owner completed', modelId: 'synthetic' });
      await owner;
      expect(await outcome).not.toContain(SENTINEL);
      const privateSubmissions = underlying.filter(request => request.prompt !== ownerRequest.prompt);
      expect(privateSubmissions).toHaveLength(stage === 'main' ? 0 : 1);
      expect(underlying.filter(request => request.system.includes('auditing'))).toEqual([]);
    });
  }

  test('metadata-only evidence remains usable without content until its current tier becomes Secret', async () => {
    const corpusId = 'secure_local.synthetic.metadata';
    const sourceItem = { family: 'file' as const, provider: 'synthetic', accountScope: 'fixture', providerItemId: 'synthetic-metadata', localItemId: 'local-metadata' };
    let secret = false;
    let contentChecks = 0;
    const provider = {
      contentServable: () => { contentChecks++; return false; },
      fetchLocalContent: async () => ({ sensitivity: buildSourceSensitivity({ trustTier: secret ? 'S5' : 'S4', trustDomain: 'secure_local' }), namesOnly: true, chunks: [] }),
    };
    const lanes = (): AnalystAnswerLanes => ({
      registry: buildSourceIndexCorpusRegistry([defineSourceIndexCorpus({ corpusId, family: 'file', trustDomain: 'secure_local' })]),
      adapters: { [corpusId]: () => ({ hits: [], latencyMs: 0, rawExposed: false as const }) },
      contentProviders: { [corpusId]: provider },
    });
    const pack: EvidencePack = {
      question: 'Which synthetic documents exist?',
      candidates: [{ provenance: { sourceItem, citation: { title: 'Synthetic metadata' } }, trustDomain: 'secure_local', trustTier: 'S4', chunks: [] }],
      coverage: { searchedCorpora: [corpusId], skippedCorpora: [], extractionGaps: [] }, builtAt: '2026-10-14T12:00:00Z',
    };
    const input = { lanes, request: { question: pack.question }, pack, corpusIds: [corpusId] };
    await expect(guardSourceAnswerEvidence(input)).resolves.toBeUndefined();
    expect(contentChecks).toBe(0);
    secret = true;
    await expect(guardSourceAnswerEvidence(input)).rejects.toThrow();
  });
});

describe('live authorization failures stop sovereignty fallback', () => {
  for (const fault of ['Secret', 'provider error', 'lanes error', 'model failure after retier', 'model failure control'] as const) {
    test(`${fault} after local queueing cannot masquerade as a provider outage`, async () => {
      const corpusId = 'secure_local.synthetic.multi-leg';
      const sourceItem = { family: 'file' as const, provider: 'synthetic', accountScope: 'fixture', providerItemId: 'multi-leg', localItemId: 'multi-leg' };
      const ownerGate = deferred<{ text: string; modelId: string }>();
      const activity = createLocalModelActivity();
      let changed = false;
      let queued = false;
      let guarded = 0;
      const localSubmissions: AnalystModelRequest[] = [];
      const fallbackSubmissions: AnalystModelRequest[] = [];
      const response = { text: JSON.stringify({ answer: 'Synthetic grounded answer.', citations: [{ evidence: 1, claim: 'Synthetic grounded answer.' }], unanswered: [], sufficient: true }), modelId: 'synthetic' };
      const tracked = activity.track('synthetic-multi-leg-model', {
        async complete(request: AnalystModelRequest) {
          localSubmissions.push(request);
          if (request.prompt === 'multi-leg owner blocker') return ownerGate.promise;
          if (fault === 'model failure after retier') {
            changed = true;
            throw new Error('Synthetic model outage after item became Secret');
          }
          if (fault === 'model failure control') throw new Error('Synthetic ordinary model outage');
          return response;
        },
      });
      const local = createAnalyst({ complete: request => { queued = true; return tracked.complete(request); } });
      // Approved encrypted-cloud fallback deliberately has no tracked local
      // resource: terminal authorization failure must stop the route itself.
      const fallback = createAnalyst({ complete: async request => { fallbackSubmissions.push(request); return response; } });
      const lanes = (): AnalystAnswerLanes => {
        if (changed && fault === 'lanes error') throw new Error('Synthetic live registry unavailable');
        return {
          registry: buildSourceIndexCorpusRegistry([defineSourceIndexCorpus({ corpusId, family: 'file', trustDomain: 'secure_local' })]),
          adapters: { [corpusId]: () => ({ hits: [{ sourceItem, provenance: { sourceItem, citation: { title: 'Synthetic multi-leg source' } }, score: 1, rawExposed: false as const }], latencyMs: 0, rawExposed: false as const }) },
          contentProviders: { [corpusId]: { fetchLocalContent: async () => {
            if (changed && fault === 'provider error') throw new Error('Synthetic live source unavailable');
            return { sensitivity: buildSourceSensitivity({ trustTier: changed && (fault === 'Secret' || fault === 'model failure after retier') ? 'S5' : 'S4', trustDomain: 'secure_local' }), chunks: [SENTINEL] };
          } } },
        };
      };
      const handler = createAnalystSourceIndexAnswerHandler({
        analyst: local, lanes,
        inferenceGuard: async (pack, request, corpusIds) => {
          guarded++;
          await guardSourceAnswerEvidence({ lanes, request, pack, corpusIds });
        },
        sovereigntyAnalystRoute: () => ({
          poolId: 'secure_local.synthetic.multi-leg', trustDomain: 'secure_local', selection: 'explicit_order',
          steps: [
            { profile: { id: 'synthetic-local', profile: { provider: 'local-openai-compatible', trust: 'local', model: 'synthetic-local', purpose: 'analyst' } }, backend: 'local', analyst: local },
            { profile: { id: 'synthetic-private-cloud', profile: { provider: 'venice', trust: 'encrypted_cloud', model: 'zai-org-glm-5-2', purpose: 'analyst' } }, backend: 'venice', analyst: fallback },
          ],
        }),
      });
      const owner = tracked.complete({ system: 'synthetic', prompt: 'multi-leg owner blocker', localOnly: true });
      await until(() => localSubmissions.length === 1);
      const answer = runBackgroundInference(() => handler.answer({ question: 'Summarize synthetic evidence.', corpus_id: corpusId, include_secure_local: true }));
      const outcome = answer.then(result => ({ result }), error => ({ error }));
      await until(() => queued);
      expect(guarded).toBeGreaterThan(0);
      changed = fault !== 'model failure after retier';
      ownerGate.resolve({ text: 'Owner complete', modelId: 'synthetic' });
      await owner;
      const completed = await outcome;
      if (fault === 'model failure control') {
        // Negative control proves the configured second leg really can submit
        // the pack when ordinary model failure occurs with authorization intact.
        expect(fallbackSubmissions).toHaveLength(1);
        expect(fallbackSubmissions[0]!.prompt).toContain(SENTINEL);
        expect('result' in completed).toBe(true);
      } else {
        expect(fallbackSubmissions).toEqual([]);
        if (fault === 'model failure after retier') {
          expect(localSubmissions).toHaveLength(2);
          expect(localSubmissions[1]!.prompt).toContain(SENTINEL);
        } else expect(localSubmissions.map(request => request.prompt)).toEqual(['multi-leg owner blocker']);
        expect('error' in completed).toBe(true);
        expect(JSON.stringify(completed)).not.toContain(SENTINEL);
      }
    });
  }
});

describe('retained answer bounds', () => {
  test('invalidated retained rows still count toward the 500-answer cap', () => {
    const f = fixture();
    const refs: WaitingQuestionRef[] = [];
    for (let index = 0; index < 500; index++) {
      f.advance(1);
      const ref = f.record(`Synthetic retained answer ${index}`);
      refs.push(ref);
      expect(f.store.saveAnswer(ref, saved())).toBe(true);
    }
    // Invalidate a recent row so the oldest complete row should be evicted.
    const invalidated = refs[499]!;
    expect(f.store.invalidate(invalidated)).toBe(true);
    expect(f.store.get(invalidated.id)?.result).toBeUndefined();
    expect(f.store.get(invalidated.id)?.answeredAt).toBeDefined();
    f.advance(1);
    expect(f.store.saveAnswer(f.record('Synthetic newest answer'), saved())).toBe(true);
    expect(f.store.list().questions).toHaveLength(500);
    expect(f.store.get(refs[0]!.id)).toBeUndefined();
    expect(f.store.get(invalidated.id)).toBeDefined();
    expect(f.store.list().olderRemoved).toBe(true);
  });

  test('oversized answer is refused without overwriting a retained result', () => {
    const f = fixture();
    const ref = f.record('Synthetic size boundary');
    expect(f.store.saveAnswer(ref, saved())).toBe(true);
    expect(f.store.saveAnswer(ref, { ...saved(), answer: 'x'.repeat(128 * 1024 + 1) })).toBe(false);
    expect(f.store.get(ref.id)?.result?.answer).toBe('Synthetic retained answer');
  });
});

function panelJobs(f: ReturnType<typeof fixture>) {
  return new PrivateAnswerJobs({
    model: () => ({ status: () => ({ state: 'ready' }), answerPrivately: async () => ({ answer: 'Synthetic sealed answer', citations: [] }) }),
    eligible: async items => items.map(() => true), installId: () => 'a'.repeat(32), now: f.now,
    claimHoldMs: 1_000, pollRate: { capacity: 100, refillPerSecond: 100 }, log: () => {},
    acknowledge: ref => {
      const current = f.store.get(ref.id);
      if (!current || current.generation !== ref.generation || current.connectionId !== ref.connectionId) return true;
      if (f.store.acknowledge(ref)) return true;
      const remaining = f.store.get(ref.id);
      return !remaining || remaining.generation !== ref.generation || remaining.connectionId !== ref.connectionId;
    },
  });
}
function lockStore(f: ReturnType<typeof fixture>) {
  const lock = new Database(f.dbPath);
  lock.exec('PRAGMA busy_timeout = 0; BEGIN IMMEDIATE');
  let locked = true;
  const release = () => { if (locked) { lock.exec('ROLLBACK'); locked = false; } };
  cleanups.push(() => { release(); lock.close(); });
  return release;
}

describe('panel acknowledgment durability under SQLite contention', () => {
  test('a busy durable delete retains the decrypted capability for retry and prevents later fallback', async () => {
    const f = fixture();
    const ref = f.record('Synthetic claimed panel question', 'chatgpt');
    const jobs = panelJobs(f);
    const { jobId } = jobs.begin({ question: 'Synthetic claimed panel question', count: 1, evidence: EVIDENCE, refresh: async () => EVIDENCE, waiting: ref });
    expect(jobId).toBeDefined();
    const key = await generatePanelKeyPair();
    const ready = await jobs.claim(jobId!, key.publicKey);
    expect(ready).toMatchObject({ status: 200, body: { status: 'ready' } });
    const opened = JSON.parse(await openPrivateAnswer(jobId!, key.privateKey, ready.body as unknown as SealedPrivateAnswer)) as { ack: string };
    expect(opened.ack).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const unlock = lockStore(f);
    expect(await jobs.acknowledge(jobId!, key.publicKey, opened.ack)).toMatchObject({ status: 503, body: { status: 'busy' } });
    expect(f.store.get(ref.id)).toBeDefined();
    unlock();
    expect(await jobs.acknowledge(jobId!, key.publicKey, opened.ack)).toMatchObject({ status: 200, body: { status: 'acknowledged' } });
    expect(f.store.get(ref.id)).toBeUndefined();
    expect((await jobs.acknowledge(jobId!, key.publicKey, opened.ack)).status).toBe(410);
    f.advance(31_000);
    let fallbackCalls = 0;
    const inbox = createLocalPrivateAnswers({ store: () => f.store, now: f.now, eligible: async items => items.map(() => true),
      answer: async () => { fallbackCalls++; return localResult(); } });
    cleanups.push(() => inbox.close());
    await inbox.tick();
    expect(fallbackCalls).toBe(0);
  });

  test('pinned seenOnDelivery never hands out ready bytes until durable deletion succeeds', async () => {
    const f = fixture();
    const ref = f.record('Synthetic pinned panel question', 'chatgpt');
    const jobs = panelJobs(f);
    const { jobId } = jobs.begin({ question: 'Synthetic pinned panel question', count: 1, evidence: EVIDENCE, refresh: async () => EVIDENCE, waiting: ref, seenOnDelivery: true });
    const key = await generatePanelKeyPair();
    const unlock = lockStore(f);
    const busy = await jobs.claim(jobId!, key.publicKey);
    expect(busy).toMatchObject({ status: 503, body: { status: 'busy' } });
    expect(JSON.stringify(busy.body)).not.toContain('ciphertext');
    expect(f.store.get(ref.id)).toBeDefined();
    unlock();
    const ready = await jobs.claim(jobId!, key.publicKey);
    expect(ready).toMatchObject({ status: 200, body: { status: 'ready' } });
    expect(f.store.get(ref.id)).toBeUndefined();
    expect(JSON.parse(await openPrivateAnswer(jobId!, key.privateKey, ready.body as unknown as SealedPrivateAnswer)).answer).toBe('Synthetic sealed answer');
  });

  test('a panel without waiting debt still acknowledges successfully', async () => {
    const f = fixture();
    const jobs = panelJobs(f);
    const { jobId } = jobs.begin({ question: 'Synthetic no-debt panel question', count: 1, evidence: EVIDENCE, refresh: async () => EVIDENCE });
    const key = await generatePanelKeyPair();
    const ready = await jobs.claim(jobId!, key.publicKey);
    expect(ready.status).toBe(200);
    const opened = JSON.parse(await openPrivateAnswer(jobId!, key.privateKey, ready.body as unknown as SealedPrivateAnswer)) as { ack: string };
    expect(await jobs.acknowledge(jobId!, key.publicKey, opened.ack)).toMatchObject({ status: 200, body: { status: 'acknowledged' } });
  });
});

test('delete_all clears retained rows, source tokens and pending completions without restoration', async () => {
  const f = fixture();
  const first = f.record('Synthetic retained first');
  f.store.saveAnswer(first, saved());
  const second = f.record('Synthetic retained second');
  f.store.saveAnswer(second, saved());
  const pending = f.record('Synthetic pending completion');
  const gate = deferred<LocalAnswerResult>();
  let started = false;
  let opened = 0;
  const api = createLocalPrivateAnswers({ store: () => f.store, now: f.now, eligible: async items => items.map(() => true),
    answer: () => { started = true; return gate.promise; }, openUrl: async () => { opened++; } });
  cleanups.push(() => api.close());
  const read = await api.handle({ action: 'read', id: first.id }, 'owner');
  const token = (read.body.citations as Array<{ open: string }>)[0]!.open;
  expect(token).toBeDefined();
  const pass = api.tick();
  await until(() => started);
  const removed = await api.handle({ action: 'delete_all' }, 'owner');
  expect(removed.body).toMatchObject({ status: 'deleted', removed: 3 });
  expect(f.store.list().questions).toEqual([]);
  gate.resolve(localResult());
  await pass;
  expect(f.store.get(pending.id)).toBeUndefined();
  expect(f.store.list().questions).toEqual([]);
  expect((await api.handle({ action: 'open', token }, 'owner')).status).toBe(410);
  expect(opened).toBe(0);
});
