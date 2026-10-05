// Secret items are never read by any model: the private answer panel checks
// each item's eligibility, from live state, immediately before every model
// submission (document embeddings, the depth re-read's hand-off, every
// answer-model call) and again before an answer is sealed.
//
// Independent review of PR #145 (2026-10-05) reproduced five paths around a
// single dispatch-time search: a claim's retry reusing stale claim-time
// evidence, revocation during hydration or during the question embedding, an
// answer sealed against a stale claim-time set, every depth-read exception
// treated as transient, and a partial re-check that did not fail closed.
// Each is a regression here. Synthetic fixtures only; no fixed sleeps.

import { describe, expect, test } from 'bun:test';
import type { AnswerPrivatelyOptions, PrivateEvidenceItem as BuiltInEvidenceItem } from '../src/core/analyst-built-in.ts';
import type { AnalystModelRequest } from '../src/core/analyst.ts';
import { SourceModelPolicyDeniedError } from '../src/core/source-model-policy.ts';
import type { PrivateEvidenceItem } from '../src/workers/chatgpt/private-answer-contract.ts';
import { generatePanelKeyPair, openPrivateAnswer, type SealedPrivateAnswer } from '../src/workers/chatgpt/private-answer-crypto.ts';
import { PrivateAnswerJobs } from '../src/workers/chatgpt/private-answer-jobs.ts';
import { createBuiltInPrivateAnswerModel, embeddingPanelRelevance } from '../src/workers/chatgpt/private-answer-model.ts';

const INSTALL = 'f'.repeat(32);
const SENTINEL = 'SENTINEL_REVOKED_5b7e';

function hit(id: string, text: string, corpusId = 'private-a'): PrivateEvidenceItem {
  return {
    provenance: {
      sourceItem: { family: 'file', provider: 'fixture', accountScope: 'personal', providerItemId: id, localItemId: id },
      citation: { title: `${id}.txt` },
    },
    corpusId,
    trustDomain: 'secure_local',
    chunks: [text],
  };
}

const idOf = (item: PrivateEvidenceItem) => (item.provenance as { sourceItem: { localItemId: string } }).sourceItem.localItemId;

async function until(condition: () => boolean, ms = 10_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('condition not reached');
    await Bun.sleep(2);
  }
}

/**
 * A world of items whose eligibility the test changes, a guard that reads it
 * live, and a panel model whose every model input (document embeddings, the
 * depth reader's hand-off, each answer-model call) is recorded with whether
 * revocation had already happened when it was submitted.
 */
function world(options: { gateFirstCall?: 'fail' | 'succeed'; depthRead?: boolean; relevance?: 'stub' | 'embedding'; readItem?: (item: PrivateEvidenceItem) => Promise<readonly string[] | undefined>; precompute?: boolean } = {}) {
  const revoked = new Set<string>();
  /** Corpora whose eligibility lookup fails (a timed-out or unreadable store). */
  const failing = new Set<string>();
  let revokedAt = 0;
  const events: string[] = [];
  const inputs: Array<{ kind: 'embed' | 'depth' | 'prompt'; text: string; afterRevoke: boolean }> = [];
  const record = (kind: 'embed' | 'depth' | 'prompt', text: string) => inputs.push({ kind, text, afterRevoke: revokedAt > 0 });
  let guardCalls = 0;
  const eligible = async (items: readonly PrivateEvidenceItem[]) => {
    guardCalls += 1;
    return items.map((item) => {
      if (failing.has(String(item.corpusId))) throw new Error('lookup failed');
      return !revoked.has(idOf(item));
    });
  };
  let calls = 0;
  let releaseFirst: (() => void) | undefined;
  const base = {
    name: 'built_in' as const,
    spec: { modelId: 'test' },
    prepare: async () => {},
    status: () => ({ state: 'ready' }),
    stop: async () => {},
    async complete(request: AnalystModelRequest) {
      calls += 1;
      const call = calls;
      record('prompt', request.prompt);
      events.push(`complete:${call}`);
      if (call === 1 && options.gateFirstCall) {
        await new Promise<void>((resolve) => { releaseFirst = resolve; });
        if (options.gateFirstCall === 'fail') throw new Error('model failed');
      }
      return { text: '{}' };
    },
  };
  const answer = async (_question: string, items: readonly BuiltInEvidenceItem[], answerOptions: AnswerPrivatelyOptions) => {
    await answerOptions.model!.complete({ system: 'system', prompt: items.map((item) => `${item.id}: ${item.text}`).join('\n') } as AnalystModelRequest);
    return {
      answer: `answer from ${items.map((item) => item.id).join(',')}`,
      citations: items.map((item) => ({ id: item.id, claim: 'c' })),
      unanswered: [],
      modelId: 'test',
    };
  };
  let releaseQuery: (() => void) | undefined;
  const embedder = {
    backend: 'local' as const,
    dimension: 2,
    embed: async (batch: Array<{ text: string }>, request: { taskType: string }) => {
      if (request.taskType === 'RETRIEVAL_QUERY') {
        events.push('embed:query');
        await new Promise<void>((resolve) => { releaseQuery = resolve; });
        return batch.map(() => [1, 0]);
      }
      for (const entry of batch) record('embed', entry.text);
      return batch.map((entry) => (entry.text.includes('lease') ? [1, 0] : [0.9, 0.1]));
    },
  };
  const relevance = options.relevance === 'embedding'
    ? embeddingPanelRelevance(() => embedder)
    : options.relevance === 'stub'
      ? async (_question: string, items: unknown) => {
          const list = (typeof items === 'function' ? await (items as () => Promise<unknown[]>)() : items) as Array<{ title?: string; text: string } | undefined>;
          for (const entry of list) if (entry) record('embed', `${entry.title ?? ''} ${entry.text}`);
          return list.map(() => 0.5);
        }
      : undefined;
  const readItem = options.readItem ?? (async (item: PrivateEvidenceItem) => item.chunks as string[]);
  const panel = createBuiltInPrivateAnswerModel({
    model: base as never,
    available: () => true,
    answer: answer as never,
    eligible,
    ...(relevance ? { relevance: relevance as never } : {}),
    ...(options.depthRead ? {
      readItem: async (item: PrivateEvidenceItem) => {
        const chunks = await readItem(item);
        for (const chunk of chunks ?? []) record('depth', chunk);
        return chunks;
      },
    } : {}),
  } as never);
  const lines: string[] = [];
  const jobs = new PrivateAnswerJobs({
    model: () => panel,
    installId: () => INSTALL,
    eligible,
    log: (line: string) => lines.push(line),
    claimHoldMs: 0,
    audit: () => {},
    ...(options.precompute === false ? { precompute: false } : {}),
  } as never);
  return {
    jobs,
    panel,
    events,
    inputs,
    lines,
    revoked,
    failing,
    get guardCalls() { return guardCalls; },
    get calls() { return calls; },
    revoke(id: string) {
      revoked.add(id);
      revokedAt = Date.now();
    },
    releaseFirst: () => releaseFirst?.(),
    releaseQuery: () => releaseQuery?.(),
    /** Every model input submitted after revocation, joined. */
    afterRevoke: () => inputs.filter((input) => input.afterRevoke).map((input) => input.text).join('\n'),
  };
}

/** Claims until the job settles (bounded; each pending answer spends one poll token). */
async function outcome(jobs: PrivateAnswerJobs, jobId: string, panel: Awaited<ReturnType<typeof generatePanelKeyPair>>, lines: string[]) {
  await until(() => lines.length > 0);
  const response = await jobs.claim(jobId, panel.publicKey);
  if (response.body.status !== 'ready') return { status: response.body.status as string };
  const opened = JSON.parse(await openPrivateAnswer(jobId, panel.privateKey, response.body as unknown as SealedPrivateAnswer)) as { answer: string };
  return { status: 'ready', answer: opened.answer };
}

const lease = () => hit('lease', 'the lease ends in May');
const password = (corpusId?: string) => hit('password', `${SENTINEL} the vault password`, corpusId);

describe('blocker 1: a claim\'s retry re-checks; it never reuses stale claim-time evidence', () => {
  test('precompute fails after the claim searched and eligibility was revoked: the replacement call reads no Secret byte', async () => {
    const w = world({ gateFirstCall: 'fail', relevance: 'stub', depthRead: true });
    const evidence = [lease(), password()];
    const { jobId } = w.jobs.begin({ question: 'q', count: 2, evidence, refresh: async () => evidence });
    await until(() => w.events.includes('complete:1'));
    const key = await generatePanelKeyPair();
    // The claim's search succeeds while both are still Private.
    expect((await w.jobs.claim(jobId!, key.publicKey)).status).toBe(202);
    w.revoke('password');
    w.releaseFirst();
    const result = await outcome(w.jobs, jobId!, key, w.lines);
    expect(w.afterRevoke()).not.toContain(SENTINEL);
    expect(result).toEqual({ status: 'ready', answer: 'answer from lease' });
  });
});

describe('blocker 2: current at search is not current at model input', () => {
  test('revoked while the search hydrated: the item comes back in its old form, and no model reads it', async () => {
    // The claim's own search and computation (no precompute running beside it).
    const w = world({ relevance: 'stub', depthRead: true, precompute: false });
    const searchTime = [lease(), password()];
    const refresh = async () => {
      // Revoked mid-hydration: the search still returns its old copy.
      w.revoke('password');
      return [lease(), password()];
    };
    const { jobId } = w.jobs.begin({ question: 'q', count: 2, evidence: searchTime, refresh, detail: 'full' });
    const key = await generatePanelKeyPair();
    await w.jobs.claim(jobId!, key.publicKey);
    const result = await outcome(w.jobs, jobId!, key, w.lines);
    expect(w.afterRevoke()).not.toContain(SENTINEL);
    expect(result.status).toBe('ready');
    expect(result.answer).not.toContain('password');
  });

  test('revoked while the question embedding waited: the document embeddings get no Secret byte', async () => {
    const w = world({ relevance: 'embedding' });
    const answering = w.panel.answerPrivately('q', [lease(), password()]);
    await until(() => w.events.includes('embed:query'));
    w.revoke('password');
    w.releaseQuery();
    await answering;
    expect(w.inputs.filter((input) => input.kind === 'embed').length).toBeGreaterThan(0);
    expect(w.afterRevoke()).not.toContain(SENTINEL);
  });
});

describe('blocker 3: an answer is never sealed after an item it used was revoked', () => {
  test('revoked while the precompute ran, after the claim searched: the old answer is not claimable', async () => {
    const w = world({ gateFirstCall: 'succeed' });
    const evidence = [lease(), password()];
    const { jobId } = w.jobs.begin({ question: 'q', count: 2, evidence, refresh: async () => evidence });
    await until(() => w.events.includes('complete:1'));
    const key = await generatePanelKeyPair();
    expect((await w.jobs.claim(jobId!, key.publicKey)).status).toBe(202);
    w.revoke('password');
    w.releaseFirst();
    const result = await outcome(w.jobs, jobId!, key, w.lines);
    // The precompute's answer read `password`: discarded, never sealed. Any
    // answer the panel gets is computed again without it.
    expect(result).not.toEqual({ status: 'ready', answer: 'answer from lease,password' });
    expect(w.afterRevoke()).not.toContain(SENTINEL);
  });

  test('a claim\'s own computation revoked while it ran: the job fails rather than seal', async () => {
    // No precompute in this one: the claim computes it.
    const w = world({ gateFirstCall: 'succeed', precompute: false });
    const evidence = [password()];
    const jobs = w.jobs;
    const { jobId } = jobs.begin({ question: 'q', count: 1, evidence, refresh: async () => evidence });
    const key = await generatePanelKeyPair();
    await jobs.claim(jobId!, key.publicKey);
    await until(() => w.events.includes('complete:1'));
    w.revoke('password');
    w.releaseFirst();
    expect(await outcome(jobs, jobId!, key, w.lines)).toEqual({ status: 'failed' });
  });
});

describe('should-fix 4: a depth read is transient only when eligibility is confirmed after it', () => {
  test('a reader that throws a policy denial drops the item; its earlier passages are never read', async () => {
    const w = world({
      depthRead: true,
      readItem: async (item) => {
        if (idOf(item) === 'password') throw new SourceModelPolicyDeniedError('s5');
        return item.chunks as string[];
      },
    });
    const result = await w.panel.answerPrivately('q', [password()], undefined, undefined, { detail: 'full' }).catch((error: Error) => error);
    expect(w.inputs.map((input) => input.text).join('\n')).not.toContain(SENTINEL);
    expect(result).toBeInstanceOf(Error);
  });

  test('a reader that fails while the item is revoked, or returns nothing, keeps nothing of it', async () => {
    const w = world({
      depthRead: true,
      readItem: async (item) => {
        if (idOf(item) === 'password') {
          w.revoke('password');
          throw new Error('database busy');
        }
        return [];
      },
    });
    await w.panel.answerPrivately('q', [lease(), password()], undefined, undefined, { detail: 'full' });
    expect(w.afterRevoke()).not.toContain(SENTINEL);
  });
});

describe('should-fix 5: an incomplete re-check fails closed for what it could not vouch for', () => {
  test('items from a store whose eligibility lookup failed are never read; the rest are', async () => {
    const w = world({ relevance: 'stub', depthRead: true });
    w.failing.add('private-slow');
    const evidence = [lease(), password('private-slow')];
    // The claim's search timed out on the slow corpus and returned only `lease`.
    const { jobId } = w.jobs.begin({ question: 'q', count: 2, evidence, refresh: async () => [lease()] });
    const key = await generatePanelKeyPair();
    await w.jobs.claim(jobId!, key.publicKey);
    const result = await outcome(w.jobs, jobId!, key, w.lines);
    expect(w.inputs.map((input) => input.text).join('\n')).not.toContain(SENTINEL);
    expect(result).toEqual({ status: 'ready', answer: 'answer from lease' });
  });

  test('a guard that cannot answer at all: nothing is read and the job fails', async () => {
    const w = world({ relevance: 'stub' });
    w.failing.add('private-a');
    const evidence = [lease(), password()];
    const { jobId } = w.jobs.begin({ question: 'q', count: 2, evidence, refresh: async () => evidence });
    const key = await generatePanelKeyPair();
    await w.jobs.claim(jobId!, key.publicKey);
    expect(await outcome(w.jobs, jobId!, key, w.lines)).toEqual({ status: 'failed' });
    expect(w.inputs).toEqual([]);
  });
});

describe('the guard\'s cost, in guard calls per job', () => {
  test('a precomputed full answer with relevance and a depth read, claimed once', async () => {
    const w = world({ relevance: 'stub', depthRead: true });
    const evidence = [lease(), hit('note', 'a note')];
    const { jobId } = w.jobs.begin({ question: 'q', count: 2, evidence, refresh: async () => evidence, detail: 'full' });
    await until(() => w.calls === 1);
    const key = await generatePanelKeyPair();
    await w.jobs.claim(jobId!, key.publicKey);
    expect((await outcome(w.jobs, jobId!, key, w.lines)).status).toBe('ready');
    // Dispatch, the document embeddings, the depth read, the answer, its one
    // model call, and before and after sealing: one batched lookup each.
    expect(w.guardCalls).toBe(7);
  });
});
