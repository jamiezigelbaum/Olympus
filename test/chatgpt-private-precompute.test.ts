// The private answer panel's search-time precompute (2026-10-02 owner
// report: the user waited for ChatGPT's reply, then ~30 s more for the
// panel; earlier logs showed panels queued 44-58 s behind each other).
//
// 1. The analysis starts when the job is created; a claim only revalidates
//    the evidence and seals, so the panel's answer is there in moments.
// 2. Claim-time revalidation still holds: a precomputed answer that read an
//    item no longer Private-eligible is discarded and computed again from the
//    current evidence (or the job fails).
// 3. ChatGPT's several searches per turn: an identical question shares one
//    analysis, a caller's newer job supersedes its older precomputes,
//    unclaimed precomputes that never started are abandoned, and claimed
//    work runs before precomputes.
// 4. The panel reads a few relevant items: relevance-ranked, floored, capped;
//    rendered compactly with each item's name and date first.

import { describe, expect, test } from 'bun:test';
import { createAnalyst, analystPromptBytes, type AnalystModelRequest } from '../src/core/analyst.ts';
import { privateEvidencePack } from '../src/core/analyst-built-in.ts';
import type { PrivateAnswerModel, PrivateEvidenceItem } from '../src/workers/chatgpt/private-answer-contract.ts';
import { generatePanelKeyPair, openPrivateAnswer, type SealedPrivateAnswer } from '../src/workers/chatgpt/private-answer-crypto.ts';
import { PrivateAnswerJobs, privateEvidenceKey } from '../src/workers/chatgpt/private-answer-jobs.ts';
import {
  createBuiltInPrivateAnswerModel,
  embeddingPanelRelevance,
  panelItems,
  PANEL_ANSWER_LIMITS,
} from '../src/workers/chatgpt/private-answer-model.ts';

const INSTALL = 'd'.repeat(32);

function item(id: string, extra: Record<string, unknown> = {}): PrivateEvidenceItem {
  return {
    sourceItem: { provider: 'fixture', family: 'file', accountScope: 'personal', providerItemId: id, localItemId: `personal:${id}` },
    trust_domain: 'secure_local',
    chunks: [`passage of ${id}`],
    ...extra,
  };
}

interface Call { question: string; evidence: readonly PrivateEvidenceItem[]; signal?: AbortSignal | undefined }

/** A model whose answers wait on `release(question)`, recording each call. */
function gatedModel(options: { gated?: boolean; used?: (evidence: readonly PrivateEvidenceItem[]) => number[] } = {}) {
  const calls: Call[] = [];
  const gates = new Map<string, () => void>();
  const model: PrivateAnswerModel = {
    status: () => ({ state: 'ready' }),
    answerPrivately: async (question, evidence, signal, observe) => {
      calls.push({ question, evidence, signal });
      const used = options.used?.(evidence);
      observe?.evidence?.({ items: evidence.length, unreadable: 0, bytes: 10, ...(used ? { used } : {}) });
      if (options.gated) {
        await new Promise<void>((resolve) => {
          gates.set(question, resolve);
          signal?.addEventListener('abort', () => resolve(), { once: true });
        });
      }
      return { answer: `answer to ${question} from ${evidence.map((hit) => privateEvidenceKey(hit)).length} items`, citations: [] };
    },
  };
  const release = (question: string) => gates.get(question)?.();
  return { model, calls, release };
}

function makeJobs(model: PrivateAnswerModel, extra: Partial<ConstructorParameters<typeof PrivateAnswerJobs>[0]> = {}) {
  const lines: string[] = [];
  const activity = { begins: 0, ends: 0, begin() { this.begins += 1; }, end() { this.ends += 1; } };
  const jobs = new PrivateAnswerJobs({
    model: () => model,
    installId: () => INSTALL,
    log: (line) => lines.push(line),
    activity,
    audit: () => {},
    ...extra,
  });
  return { jobs, lines, activity };
}

const tick = (ms = 20) => Bun.sleep(ms);

async function collect(jobs: PrivateAnswerJobs, jobId: string, panel: CryptoKeyPair & { publicKey: string } | Awaited<ReturnType<typeof generatePanelKeyPair>>) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const response = await jobs.claim(jobId, panel.publicKey);
    if (response.status === 200) {
      if (response.body.status !== 'ready') return { status: response.body.status as string };
      const opened = JSON.parse(await openPrivateAnswer(jobId, panel.privateKey, response.body as unknown as SealedPrivateAnswer)) as { answer: string };
      return { status: 'ready', answer: opened.answer };
    }
    await tick(10);
  }
  return { status: 'timeout' };
}

describe('1. the analysis starts at search time', () => {
  test('a claim after the precompute finished seals at once: no second model call, precomputed=yes', async () => {
    const { model, calls } = gatedModel();
    const { jobs, lines, activity } = makeJobs(model);
    const evidence = [item('a'), item('b')];
    const { jobId } = jobs.begin({ question: 'q', count: 2, evidence, refresh: async () => evidence });
    await tick();
    expect(calls).toHaveLength(1);
    // The precompute counted as answer activity, and ended.
    expect(activity.begins).toBe(1);
    expect(activity.ends).toBe(1);
    const panel = await generatePanelKeyPair();
    expect(await collect(jobs, jobId!, panel)).toEqual({ status: 'ready', answer: 'answer to q from 2 items' });
    expect(calls).toHaveLength(1);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^\[private-answer\] outcome=sealed precomputed=yes wait_at_claim_ms=\d+ search_to_ready_ms=\d+ queued_ms=\d+ refresh_ms=\d+ recheck_ms=\d+ matched=2 items=2 /);
    expect(activity.begins).toBe(activity.ends);
  });

  test('the claiming POST holds briefly, so a precomputed answer arrives in its first response; a slower one gets 202', async () => {
    const { model } = gatedModel();
    const { jobs } = makeJobs(model, { claimHoldMs: 1_000 });
    const evidence = [item('a')];
    const { jobId } = jobs.begin({ question: 'q', count: 1, evidence, refresh: async () => evidence });
    await tick();
    const panel = await generatePanelKeyPair();
    const first = await jobs.claim(jobId!, panel.publicKey);
    expect(first.status).toBe(200);
    expect(first.body.status).toBe('ready');

    const slow = gatedModel({ gated: true });
    const held = makeJobs(slow.model, { claimHoldMs: 50 });
    const pending = held.jobs.begin({ question: 'slow', count: 1, evidence, refresh: async () => evidence }).jobId!;
    const startedAt = Date.now();
    expect(await held.jobs.claim(pending, panel.publicKey)).toMatchObject({ status: 202, body: { status: 'pending' } });
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(40);
    slow.release('slow');
  });

  test('a claim while the precompute runs waits for it, then seals; the model runs once', async () => {
    const { model, calls, release } = gatedModel({ gated: true });
    const { jobs, lines } = makeJobs(model);
    const evidence = [item('a')];
    const { jobId } = jobs.begin({ question: 'q', count: 1, evidence, refresh: async () => evidence });
    await tick();
    const panel = await generatePanelKeyPair();
    expect((await jobs.claim(jobId!, panel.publicKey)).status).toBe(202);
    await tick();
    release('q');
    expect(await collect(jobs, jobId!, panel)).toMatchObject({ status: 'ready' });
    expect(calls).toHaveLength(1);
    expect(lines[0]).toContain('precomputed=yes');
  });

  test('the plaintext stays in memory only until the job expires; an unclaimed precompute is freed at TTL', async () => {
    const clock = { now: 0 };
    const { model, calls } = gatedModel();
    const { jobs } = makeJobs(model, { now: () => clock.now, ttlMs: 1_000, dedupeMs: 500 });
    jobs.begin({ question: 'q', count: 1, evidence: [item('a')], refresh: async () => [item('a')] });
    await tick();
    expect(calls).toHaveLength(1);
    clock.now = 2_000;
    jobs.sweep();
    expect(jobs.size).toBe(0);
    // Nothing left to share: the same question asks the model again.
    jobs.begin({ question: 'q', count: 1, evidence: [item('a')], refresh: async () => [item('a')] });
    await tick();
    expect(calls).toHaveLength(2);
  });
});

describe('2. claim-time revalidation of the precomputed answer', () => {
  test('an unread item re-tiered to Secret does not matter: the answer read only the other item', async () => {
    const { model, calls } = gatedModel({ used: () => [0] });
    const { jobs, lines } = makeJobs(model);
    const { jobId } = jobs.begin({
      question: 'q',
      count: 2,
      evidence: [item('lease'), item('password')],
      refresh: async () => [item('lease'), item('password', { trust_tier: 'secrets' })],
    });
    await tick();
    expect(await collect(jobs, jobId!, await generatePanelKeyPair())).toMatchObject({ status: 'ready' });
    expect(calls).toHaveLength(1);
    expect(lines[0]).toContain('precomputed=yes');
  });

  test('an item the answer read that is no longer Private-eligible: discarded, recomputed from the current evidence', async () => {
    const { model, calls } = gatedModel({ used: (evidence) => evidence.map((_, index) => index) });
    const { jobs, lines } = makeJobs(model);
    // Private when the precompute is dispatched; re-tiered before the claim.
    let reclassified = false;
    const { jobId } = jobs.begin({
      question: 'q',
      count: 2,
      evidence: [item('lease'), item('password')],
      refresh: async () => (reclassified
        ? [item('lease'), item('password', { trust_tier: 'secrets' }), item('note', { trust_domain: 'internal' })]
        : [item('lease'), item('password')]),
    });
    await tick();
    expect(calls).toHaveLength(1);
    reclassified = true;
    expect(await collect(jobs, jobId!, await generatePanelKeyPair())).toEqual({ status: 'ready', answer: 'answer to q from 1 items' });
    expect(calls).toHaveLength(2);
    expect(calls[1]!.evidence.map(privateEvidenceKey)).toEqual([privateEvidenceKey(item('lease'))]);
    expect(lines[0]).toContain('precomputed=no');
  });

  test('an item the answer read that left the Private search entirely, with nothing left: the job fails', async () => {
    const { model, calls } = gatedModel();
    const { jobs } = makeJobs(model);
    let gone = false;
    const { jobId } = jobs.begin({ question: 'q', count: 1, evidence: [item('gone')], refresh: async () => (gone ? [] : [item('gone')]) });
    await tick();
    expect(calls).toHaveLength(1);
    gone = true;
    expect(await collect(jobs, jobId!, await generatePanelKeyPair())).toEqual({ status: 'failed' });
    expect(calls).toHaveLength(1);
  });

  test('an item that left the Private search before the precompute was dispatched is never read: no model call', async () => {
    const { model, calls } = gatedModel();
    const { jobs, lines } = makeJobs(model);
    const { jobId } = jobs.begin({ question: 'q', count: 1, evidence: [item('gone')], refresh: async () => [] });
    await tick();
    expect(calls).toHaveLength(0);
    expect(await collect(jobs, jobId!, await generatePanelKeyPair())).toEqual({ status: 'failed' });
    expect(calls).toHaveLength(0);
    expect(lines[0]).toContain('reason=no_evidence');
  });
});

describe('3. several searches per turn', () => {
  test('an identical question (case and spacing aside) shares one analysis; each panel gets its own sealed copy', async () => {
    const { model, calls } = gatedModel();
    const { jobs } = makeJobs(model);
    const evidence = [item('a')];
    const first = jobs.begin({ question: 'What did my April blood work show?', count: 1, evidence, refresh: async () => evidence }).jobId!;
    const second = jobs.begin({ question: '  what did my april   blood work show? ', count: 1, evidence, refresh: async () => evidence }).jobId!;
    await tick();
    expect(calls).toHaveLength(1);
    const one = await collect(jobs, first, await generatePanelKeyPair());
    const two = await collect(jobs, second, await generatePanelKeyPair());
    expect(one).toMatchObject({ status: 'ready' });
    expect(two).toEqual(one);
    expect(calls).toHaveLength(1);
  });

  test('past the dedupe window the question is answered afresh', async () => {
    const clock = { now: 0 };
    const { model, calls } = gatedModel();
    const { jobs } = makeJobs(model, { now: () => clock.now, dedupeMs: 1_000 });
    jobs.begin({ question: 'q', count: 1, evidence: [item('a')], refresh: async () => [item('a')] });
    await tick();
    clock.now = 1_500;
    jobs.begin({ question: 'q', count: 1, evidence: [item('a')], refresh: async () => [item('a')] });
    await tick();
    expect(calls).toHaveLength(2);
  });

  test('a caller\'s newer job supersedes its older precomputes (queued never run, running aborted); other callers keep theirs', async () => {
    const { model, calls, release } = gatedModel({ gated: true });
    const { jobs } = makeJobs(model);
    const evidence = [item('a')];
    const one = jobs.begin({ question: 'one', count: 1, evidence, refresh: async () => evidence, caller: 'remote:x' }).jobId!;
    await tick();
    expect(calls.map((call) => call.question)).toEqual(['one']);
    jobs.begin({ question: 'two', count: 1, evidence, refresh: async () => evidence, caller: 'remote:x' });
    jobs.begin({ question: 'other', count: 1, evidence, refresh: async () => evidence, caller: 'remote:y' });
    const three = jobs.begin({ question: 'three', count: 1, evidence, refresh: async () => evidence, caller: 'remote:x' }).jobId!;
    await tick();
    // `one` was aborted mid-run, `two` never ran; the newest precompute runs next.
    expect(calls[0]!.signal?.aborted).toBe(true);
    expect(calls.map((call) => call.question)).toEqual(['one', 'three']);
    release('three');
    await tick();
    expect(calls.map((call) => call.question)).toEqual(['one', 'three', 'other']);
    release('other');
    expect(await collect(jobs, three, await generatePanelKeyPair())).toMatchObject({ status: 'ready', answer: 'answer to three from 1 items' });
    // A superseded job still answers if its panel claims it: computed then.
    const panel = await generatePanelKeyPair();
    await jobs.claim(one, panel.publicKey);
    await tick();
    release('one');
    expect(await collect(jobs, one, panel)).toMatchObject({ status: 'ready', answer: 'answer to one from 1 items' });
    expect(calls.map((call) => call.question)).toEqual(['one', 'three', 'other', 'one']);
  });

  test('claimed work runs before precomputes, and an unclaimed precompute that never started in its window is abandoned', async () => {
    const clock = { now: 0 };
    const { model, calls, release } = gatedModel({ gated: true });
    const { jobs } = makeJobs(model, { now: () => clock.now, precomputeWindowMs: 1_000 });
    const evidence = [item('a')];
    jobs.begin({ question: 'running', count: 1, evidence, refresh: async () => evidence });
    await tick();
    const claimed = jobs.begin({ question: 'claimed', count: 1, evidence, refresh: async () => evidence }).jobId!;
    jobs.begin({ question: 'newer', count: 1, evidence, refresh: async () => evidence });
    clock.now = 500;
    jobs.begin({ question: 'stale', count: 1, evidence, refresh: async () => evidence });
    const panel = await generatePanelKeyPair();
    await jobs.claim(claimed, panel.publicKey);
    await tick();
    expect(jobs.pendingAnalyses).toBe(4);
    release('running');
    await tick();
    // The claim jumps the newer precomputes.
    expect(calls.map((call) => call.question)).toEqual(['running', 'claimed']);
    clock.now = 1_200;
    release('claimed');
    await tick();
    // `newer` (begun at 0) is past its window unclaimed: abandoned. `stale` (begun at 500) still runs.
    expect(calls.map((call) => call.question)).toEqual(['running', 'claimed', 'stale']);
    release('stale');
    await tick();
    expect(jobs.pendingAnalyses).toBe(0);
    expect(await collect(jobs, claimed, panel)).toMatchObject({ status: 'ready' });
  });

  test('four searches in one turn from one caller: the panel of the last is ready without queueing behind the others', async () => {
    const { model, calls, release } = gatedModel({ gated: true });
    const { jobs, lines } = makeJobs(model);
    const evidence = [item('a')];
    let last = '';
    for (const question of ['q1', 'q2', 'q3', 'q4']) {
      last = jobs.begin({ question, count: 1, evidence, refresh: async () => evidence, caller: 'remote:x' }).jobId!;
      await tick(5);
    }
    release('q4');
    await tick();
    expect(await collect(jobs, last, await generatePanelKeyPair())).toMatchObject({ status: 'ready', answer: 'answer to q4 from 1 items' });
    expect(lines[0]).toMatch(/precomputed=yes wait_at_claim_ms=\d+ search_to_ready_ms=\d+ queued_ms=\d+ /);
    // It started as soon as the older precompute was aborted, not after it.
    expect(Number(/queued_ms=(\d+)/.exec(lines[0]!)![1])).toBeLessThan(1_000);
    expect(calls.filter((call) => !call.signal?.aborted).map((call) => call.question)).toEqual(['q4']);
  });
});

describe('4. the panel reads a few relevant items', () => {
  const read = { items: ['a', 'b', 'c', 'd', 'e', 'f'].map((id) => ({ id, title: id, text: `text ${id}` })) };

  test('by relevance, floored below the best and capped; ties keep retrieval order', async () => {
    const scores = [0.30, 0.50, 0.49, 0.10, 0.47, 0.49];
    const picked = await panelItems('q', read, { maxItems: 3, relevanceMargin: 0.05 }, async () => scores);
    expect(picked).toEqual([1, 2, 5]);
    expect(await panelItems('q', read, { maxItems: 4, relevanceMargin: 0.02 }, async () => scores)).toEqual([1, 2, 5]);
  });

  test('without scores (no local embedding, or a failing scorer): the first items in retrieval order', async () => {
    expect(await panelItems('q', read, { maxItems: 2, relevanceMargin: 0.05 })).toEqual([0, 1]);
    expect(await panelItems('q', read, { maxItems: 2, relevanceMargin: 0.05 }, async () => { throw new Error('down'); })).toEqual([0, 1]);
    expect(await panelItems('q', read, { maxItems: 2, relevanceMargin: 0.05 }, async () => [1])).toEqual([0, 1]);
  });

  test('embedding relevance weighs the item name; a cloud embedding service never sees Private names or text', async () => {
    const vector = (text: string) => (text.includes('april') ? [1, 0] : text.includes('q:') ? [1, 0.2] : [0, 1]);
    const seen: string[] = [];
    const local = {
      backend: 'local' as const,
      dimension: 2,
      embed: async (inputs: Array<{ text: string }>) => inputs.map((input) => {
        seen.push(input.text);
        return vector(input.text.toLowerCase());
      }),
    };
    const relevance = embeddingPanelRelevance(() => local);
    const scores = await relevance('q: april labs', [{ title: '2026-03 panel', text: 'april mentioned' }, { title: '2026-04 april labs', text: 'values' }]);
    expect(scores![1]!).toBeGreaterThan(scores![0]!);
    const cloud = embeddingPanelRelevance(() => ({ ...local, backend: 'cloud' as const }));
    seen.length = 0;
    expect(await cloud('q', [{ title: 'secret name', text: 'secret text' }])).toBeUndefined();
    expect(seen).toEqual([]);
  });

  test('the built-in panel model reads the relevant items, reports which it read, and renders compactly', async () => {
    let prompt: AnalystModelRequest | undefined;
    const panelModel = createBuiltInPrivateAnswerModel({
      model: {
        spec: { modelId: 'test' },
        complete: async (request: AnalystModelRequest) => {
          prompt = request;
          return { text: JSON.stringify({ answer: 'From the April labs [1].', citations: [{ evidence: 1, claim: 'April labs' }], unanswered: [], sufficient: true }) };
        },
        stop: async () => {},
      } as never,
      available: () => true,
      answer: (await import('../src/core/analyst-built-in.ts')).answerPrivately,
      relevance: async (_question, items) => items.map((entry) => (entry.title?.includes('04-14') ? 0.9 : 0.5)),
    });
    const hits = [
      { provenance: { sourceItem: { localItemId: 'm' }, citation: { title: '2026-04-03 other test.pdf', authoredAt: '2026-04-21T08:00:00Z', uri: '/Labs/2026-04-03 other test.pdf', sourceLabel: 'dropbox' } }, chunks: ['other results'] },
      { provenance: { sourceItem: { localItemId: 'n' }, citation: { title: '2026-04-14 blood work.pdf', authoredAt: '2026-04-23T18:00:00Z', uri: '/Labs/2026-04-14 blood work.pdf', sourceLabel: 'dropbox' } }, chunks: ['ferritin 80'] },
    ];
    const stats: Array<{ used?: readonly number[] }> = [];
    const result = await panelModel.answerPrivately('April blood work?', hits, undefined, { evidence: (entry) => stats.push(entry) });
    expect(stats[0]!.used).toEqual([1]);
    expect(result.citations).toEqual([{ title: '2026-04-14 blood work.pdf', source: 'dropbox', date: '2026-04-23T18:00:00Z' }]);
    expect(prompt!.prompt).toContain('[1] 2026-04-14 blood work.pdf\ndate: 2026-04-23 · source: dropbox · in: /Labs\nsource_data: ["ferritin 80"]');
    expect(prompt!.prompt).not.toContain('other test');
    expect(prompt!.prompt).not.toContain('local_private_provenance');
    expect(prompt!.prompt).not.toContain('trust:');
    expect(prompt!.system).toContain('USING ONLY the numbered evidence');
    expect(PANEL_ANSWER_LIMITS.maxItems).toBeLessThanOrEqual(4);
  });

  test('the compact rendering\'s prompt bytes are measured exactly, so the pack is fitted to the real prompt', async () => {
    const pack = privateEvidencePack('q', [{ id: 'x', title: 't', text: 'é'.repeat(50), date: '2026-01-02T00:00:00Z', locator: '/f/t', source: 's' }]);
    let sent = '';
    const analyst = createAnalyst({ complete: async (request) => {
      sent = `${request.system}\n\n${request.prompt}`;
      return { text: '{"answer":"x","citations":[],"unanswered":[],"sufficient":true}', modelId: 'test' };
    } }, { evidenceFormat: 'compact' });
    await analyst.analyze(pack, { localOnly: true });
    expect(analystPromptBytes(pack, { localOnly: true }, 'compact')).toBe(new TextEncoder().encode(sent).length);
  });
});

describe('5. dispatch-time eligibility: a queued analysis re-checks its cached evidence before any model input', () => {
  const SECRET_TEXT = 'SENTINEL_NOW_SECRET_9c2e';
  const lease = () => item('lease');
  const password = (extra: Record<string, unknown> = {}) => item('password', { chunks: [SECRET_TEXT], ...extra });

  /**
   * A job queued behind a running analysis, whose `password` item is Private
   * when it is queued and changes (by `change`) before it is dispatched.
   * Returns every byte any model-facing hook (embeddings, depth re-read,
   * the answer model) received.
   */
  async function queuedThenChanged(change: 'secret' | 'deleted' | 'out_of_scope' | 'all_gone') {
    const seen: string[] = [];
    let state: 'private' | typeof change = 'private';
    const refresh = async (): Promise<PrivateEvidenceItem[]> => {
      if (state === 'private') return [lease(), password()];
      if (state === 'secret') return [lease(), password({ trust_tier: 'secrets' })];
      if (state === 'all_gone') return [];
      // Deleted, or its folder taken out of scope: the Private search no longer returns it.
      return [lease()];
    };
    const blocker = gatedModel({ gated: true });
    let answerCalls = 0;
    const panelModel = createBuiltInPrivateAnswerModel({
      model: { spec: { modelId: 'test' }, complete: async () => ({ text: '{}' }), stop: async () => {} } as never,
      available: () => true,
      answer: async (_question, items) => {
        answerCalls += 1;
        for (const entry of items) seen.push(`${entry.title ?? ''}\n${entry.text}`);
        return { answer: 'ok', citations: [], unanswered: [], modelId: 'test' };
      },
      relevance: async (_question, items) => {
        for (const entry of items) seen.push(`${entry.title ?? ''}\n${entry.text}`);
        return items.map(() => 0.5);
      },
      readItem: async (hit) => {
        seen.push(JSON.stringify(hit));
        return hit.chunks as string[];
      },
    });
    let blocking = true;
    const model: PrivateAnswerModel = {
      status: () => ({ state: 'ready' }),
      answerPrivately: (question, evidence, signal, observe, request) => (blocking && question === 'blocker'
        ? blocker.model.answerPrivately(question, evidence, signal, observe, request)
        : panelModel.answerPrivately(question, evidence, signal, observe, request)),
    };
    const { jobs, lines } = makeJobs(model);
    jobs.begin({ question: 'blocker', count: 1, evidence: [item('other')], refresh: async () => [item('other')] });
    await tick();
    const { jobId } = jobs.begin({ question: 'q', count: 2, evidence: [lease(), password()], refresh });
    await tick();
    // Queued, not yet dispatched: nothing read.
    expect(seen).toEqual([]);
    state = change;
    blocking = false;
    blocker.release('blocker');
    await tick(40);
    const outcome = await collect(jobs, jobId!, await generatePanelKeyPair());
    return { seen, outcome, answerCalls, lines };
  }

  for (const change of ['secret', 'deleted', 'out_of_scope'] as const) {
    test(`an item Private when queued and ${change} by dispatch contributes zero bytes to embeddings, depth reads or the model`, async () => {
      const { seen, outcome } = await queuedThenChanged(change);
      expect(outcome).toMatchObject({ status: 'ready' });
      expect(seen.length).toBeGreaterThan(0);
      expect(seen.join('\n')).not.toContain(SECRET_TEXT);
      expect(seen.join('\n')).not.toContain('"password"');
    });
  }

  test('nothing eligible left at dispatch: no model input at all, and the job fails with no evidence', async () => {
    const { seen, outcome, answerCalls } = await queuedThenChanged('all_gone');
    expect(seen).toEqual([]);
    expect(answerCalls).toBe(0);
    expect(outcome).toEqual({ status: 'failed' });
  });
});
