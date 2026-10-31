import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { secretLocationAnswer } from '../src/core/secret-location-note.ts';
import { openWaitingPrivateQuestionStore } from '../src/core/waiting-private-questions.ts';
import { expect, test } from 'bun:test';
import { buildSourceIndexCorpusRegistry } from '../src/core/source-index/corpus.ts';
import { searchPrivateEvidence } from '../src/workers/source-index/analyst-answer.ts';
import { PrivateAnswerJobs } from '../src/workers/chatgpt/private-answer-jobs.ts';
import { generatePanelKeyPair, openPrivateAnswer, type SealedPrivateAnswer } from '../src/workers/chatgpt/private-answer-crypto.ts';
import { defaultConfig } from '../src/core/config.ts';
import { createInProcessOperationContext } from '../src/workers/remote-mcp.ts';
import { createEmailSourceWorker } from '../src/workers/email-source/index.ts';
import { callChatGptTool } from '../src/workers/chatgpt/mcp-surface.ts';
import { REMOTE_SECRET_NOTE, REMOTE_PRIVATE_NOTE_PATTERN, remotePrivateNote, withRemotePrivateNote } from '../src/core/remote-result.ts';
import { PRIVATE_ANSWER_META_KEY } from '../src/workers/chatgpt/private-answer-contract.ts';
import { privateMatchNote } from '../src/workers/chatgpt/response-builder.ts';

const POINTER = 'A matching item is a Secret. Open it in Olympus on your computer.';
function sealedBody(body: unknown): SealedPrivateAnswer {
  if (!body || typeof body !== 'object') throw Error('Expected sealed answer');
  const { macPublicKey, iv, ciphertext } = body as Record<string, unknown>;
  if (typeof macPublicKey !== 'string' || typeof iv !== 'string' || typeof ciphertext !== 'string') throw Error('Expected sealed fields');
  return { macPublicKey, iv, ciphertext };
}

test('Secret-only search returns only a bit, no location or Secret evidence', async () => {
  const result = await searchPrivateEvidence({ question: 'vault', lanes: () => ({
    registry: buildSourceIndexCorpusRegistry([]), adapters: {}, contentProviders: {},
    secretLocations: () => [{ source: 'local_files', where: '/SENTINEL/vault.txt', title: 'SENTINEL' }] as never,
  }) });
  expect(result).toEqual({ matched: 1, candidates: [], secretMatch: true });
  expect(JSON.stringify(result)).not.toContain('SENTINEL');
});

test('Secret-only job works without a model, seals fixed pointer, and never invokes inference', async () => {
  let calls = 0;
  const jobs = new PrivateAnswerJobs({ installId: () => 'a'.repeat(32), claimHoldMs: 0,
    eligible: async (items) => items.map(() => true),
    model: () => ({ status: () => ({ state: 'no_model' }), answerPrivately: async () => { calls++; throw Error('must not infer'); } }),
  });
  const match = jobs.begin({ question: 'vault', count: 1, evidence: [], refresh: async () => [], secretMatch: async () => true } as Parameters<PrivateAnswerJobs['begin']>[0]);
  expect(match.panelState).toBe('ready');
  expect(privateMatchNote({ ...match, secretMatch: true } as typeof match)).toBe(POINTER);
  const panel = await generatePanelKeyPair();
  let result = await jobs.claim(match.jobId!, panel.publicKey);
  for (let i = 0; i < 20 && result.status === 202; i++) { await Bun.sleep(10); result = await jobs.claim(match.jobId!, panel.publicKey); }
  expect(result.status).toBe(200);
  const opened = JSON.parse(await openPrivateAnswer(match.jobId!, panel.privateKey, sealedBody(result.body)));
  expect(opened.answer).toBe(POINTER);
  expect(opened.citations).toEqual([]);
  expect(calls).toBe(0);
});


test('Secret-only question through ChatGPT creates a panel and says Secret without metadata', async () => {
  const worker = createEmailSourceWorker({});
  const ctx = createInProcessOperationContext({ config: defaultConfig(), sourceIndexReadEnabled: true, workerFetch: worker.fetch, caller: { surface: 'remote' } });
  let modelCalls = 0;
  const jobs = new PrivateAnswerJobs({ installId: () => 'a'.repeat(32), claimHoldMs: 0,
    eligible: async (items) => items.map(() => true),
    model: () => ({ status: () => ({ state: 'no_model' }), answerPrivately: async () => { modelCalls++; throw Error('must not infer'); } }),
  });
  const probe = () => searchPrivateEvidence({ question: 'vault', lanes: () => ({
    registry: buildSourceIndexCorpusRegistry([]), adapters: {}, contentProviders: {},
    secretLocations: () => [{ source: 'local_files', where: '/SENTINEL/vault.txt', title: 'SENTINEL' }] as never,
  }) }).then((result) => ({ count: result.matched, evidence: result.candidates as unknown as Readonly<Record<string, unknown>>[], ...(result.secretMatch ? { secretMatch: true as const } : {}) }));
  const response = await callChatGptTool('olympus_search', { question: 'vault' }, ctx, {
    dashboardView: async () => { throw Error('unused'); }, privateAnswers: jobs, privateMatchProbe: probe,
    evidenceSearch: async () => ({ evidence: [], withheld: 0, coverage: { searched_corpora: 0 } }),
  });
  expect(JSON.stringify(response)).not.toContain('SENTINEL');
  expect(JSON.stringify(response.content)).toContain(POINTER);
  const meta = (response._meta as Record<string, unknown> | undefined)?.[PRIVATE_ANSWER_META_KEY] as { jobId: string; state: string };
  expect(meta.state).toBe('ready');
  expect(meta.jobId).toStartWith('oly2p.');
  expect(modelCalls).toBe(0);
});

test('Secret fixed remote pointer preserves shape and rejects a locator suffix', () => {
  const result = withRemotePrivateNote({ kind: 'source_answer', status: 'answered', answer: '', citations: [] }, undefined, true);
  expect(Object.keys(result).sort()).toEqual(['answer', 'citations', 'kind', 'private_note', 'status']);
  expect(result.private_note).toBe(remotePrivateNote(undefined, true));
  expect(result.private_note).toContain(REMOTE_SECRET_NOTE);
  const pattern = new RegExp(REMOTE_PRIVATE_NOTE_PATTERN);
  expect(pattern.test(String(result.private_note))).toBe(true);
  expect(pattern.test(remotePrivateNote('a'.repeat(22), true))).toBe(true);
  expect(pattern.test(String(result.private_note) + ' /SENTINEL/vault.txt')).toBe(false);
});

test('Secret-only job fails closed when its match is revoked before claim', async () => {
  const jobs = new PrivateAnswerJobs({ installId: () => 'a'.repeat(32), claimHoldMs: 0,
    eligible: async (items) => items.map(() => true),
    model: () => ({ status: () => ({ state: 'no_model' }), answerPrivately: async () => { throw Error('must not infer'); } }),
  });
  const match = jobs.begin({ question: 'vault', count: 1, evidence: [], refresh: async () => [], secretMatch: async () => false });
  const panel = await generatePanelKeyPair();
  let result = await jobs.claim(match.jobId!, panel.publicKey);
  for (let i = 0; i < 20 && result.status === 202; i++) { await Bun.sleep(10); result = await jobs.claim(match.jobId!, panel.publicKey); }
  expect(result.body).toEqual({ status: 'failed' });
});


for (const seenOnDelivery of [false, true]) test(`Secret pointer claim and acknowledgment preserve the reachable Inbox question (legacy delivery=${seenOnDelivery})`, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'secret-pointer-waiting-'));
  const store = openWaitingPrivateQuestionStore(join(dir, 'waiting.sqlite'));
  try {
    const ref = store.record(store.ticket('a'.repeat(18)), { question: 'vault', surface: 'chatgpt', state: 'waiting' })!;
    const jobs = new PrivateAnswerJobs({ installId: () => 'a'.repeat(32), claimHoldMs: 0,
      eligible: async (items) => items.map(() => true), acknowledge: (waiting) => store.acknowledge(waiting),
      model: () => ({ status: () => ({ state: 'no_model' }), answerPrivately: async () => { throw Error('must not infer'); } }),
    });
    const match = jobs.begin({ question: 'vault', count: 1, evidence: [], refresh: async () => [], secretMatch: async () => true, waiting: ref, seenOnDelivery });
    const panel = await generatePanelKeyPair();
    let result = await jobs.claim(match.jobId!, panel.publicKey);
    expect(jobs.hasClaimedWaiting(ref)).toBe(false);
    for (let i = 0; i < 20 && result.status === 202; i++) { await Bun.sleep(10); result = await jobs.claim(match.jobId!, panel.publicKey); }
    expect(result.status).toBe(200);
    const opened = JSON.parse(await openPrivateAnswer(match.jobId!, panel.privateKey, sealedBody(result.body)));
    expect(opened.answer).toBe(POINTER);
    if (!seenOnDelivery) expect((await jobs.acknowledge(match.jobId!, panel.publicKey, opened.ack)).body).toEqual({ status: 'acknowledged' });
    expect(jobs.hasClaimedWaiting(ref)).toBe(false);
    expect(store.list().questions.map((question) => question.id)).toContain(ref.id);
    expect(store.get(ref.id)?.state).toBe('waiting');
    // The local worker can still save this generation after the panel
    // rendered its pointer; the reader marks that saved answer as read.
    const locationAnswer = secretLocationAnswer([{ where: 'SENTINEL local vault' }]);
    expect(store.saveAnswer(ref, { status: 'answered', answer: locationAnswer, citations: [], unanswered: [], leftOut: [], read: [] })).toBe(true);
    expect(store.get(ref.id)?.result?.answer).toBe(locationAnswer);
    expect(store.markRead(ref)).toBe(true);
    expect(store.get(ref.id)?.seen).toBe(true);
    expect(opened.answer).not.toContain('SENTINEL');
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('claim refresh discovering a Secret preserves Inbox through mixed Private answer acknowledgment', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'secret-refresh-waiting-'));
  const store = openWaitingPrivateQuestionStore(join(dir, 'waiting.sqlite'));
  let releaseModel: (() => void) | undefined;
  const heldModel = new Promise<void>((resolve) => { releaseModel = resolve; });
  let modelStarted = false;
  try {
    const ref = store.record(store.ticket('a'.repeat(18)), { question: 'mixed vault', surface: 'chatgpt', state: 'waiting' })!;
    const evidence = [{ trustDomain: 'secure_local', title: 'Ordinary Private item' }];
    const jobs = new PrivateAnswerJobs({ installId: () => 'a'.repeat(32), claimHoldMs: 0, precompute: false,
      eligible: async (items) => items.map(() => true), acknowledge: (waiting) => store.acknowledge(waiting),
      model: () => ({ status: () => ({ state: 'ready' }), answerPrivately: async () => {
        modelStarted = true;
        await heldModel;
        return { answer: 'The Private answer.', citations: [], unanswered: [] };
      } }),
    });
    const match = jobs.begin({ question: 'mixed vault', count: 1, evidence, waiting: ref,
      refresh: async () => Object.assign([...evidence], { secretMatch: true as const }),
    });
    const panel = await generatePanelKeyPair();
    let result = await jobs.claim(match.jobId!, panel.publicKey);
    for (let i = 0; i < 20 && !modelStarted; i++) await Bun.sleep(10);
    expect(modelStarted).toBe(true);
    expect(jobs.hasClaimedWaiting(ref)).toBe(false);
    releaseModel!();
    for (let i = 0; i < 20 && result.status === 202; i++) { await Bun.sleep(10); result = await jobs.claim(match.jobId!, panel.publicKey); }
    expect(result.status).toBe(200);
    const opened = JSON.parse(await openPrivateAnswer(match.jobId!, panel.privateKey, sealedBody(result.body)));
    expect(opened.answer).toContain('The Private answer.');
    expect(opened.answer).toContain(POINTER);
    expect(opened.citations).toEqual([]);
    expect((await jobs.acknowledge(match.jobId!, panel.publicKey, opened.ack)).body).toEqual({ status: 'acknowledged' });
    expect(jobs.hasClaimedWaiting(ref)).toBe(false);
    expect(store.list().questions.map((question) => question.id)).toContain(ref.id);
    const answer = secretLocationAnswer([{ where: 'SENTINEL refreshed local vault' }]);
    expect(store.saveAnswer(ref, { status: 'answered', answer, citations: [], unanswered: [], leftOut: [], read: [] })).toBe(true);
    expect(store.get(ref.id)?.result?.answer).toBe(answer);
    expect(opened.answer).not.toContain('SENTINEL');
  } finally { releaseModel?.(); store.close(); rmSync(dir, { recursive: true, force: true }); }
});
