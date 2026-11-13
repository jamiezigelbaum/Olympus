import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { buildSourceIndexCorpusRegistry, defineSourceIndexCorpus } from '../src/core/source-index/corpus.ts';
import { createOwnerQuestionActivity, createSourceAnswerLanes, OWNER_QUESTION_RESOURCE } from '../src/workers/engine/runtime/source-answer-lanes.ts';
import { OwnerBusyRelay } from '../src/workers/engine-split/client.ts';
import { OwnerBusyMarks } from '../src/workers/engine-split/runtime.ts';
import type { EngineCommand } from '../src/workers/engine-split/commands.ts';
import { startSupersededSweepTicker, SUPERSEDED_SWEEP_TICK_MS } from '../src/workers/connector-store/tier-auto-prune-sweep.ts';
import type { TieredStoreSet } from '../src/workers/connector-store/tiered-store-set.ts';
import { createAnalystSourceIndexAnswerHandler, searchReleasedEvidence } from '../src/workers/source-index/analyst-answer.ts';
import { createAnalyst } from '../src/core/analyst.ts';
import { createTestClock } from './helpers/test-clock.ts';
import { provedReleaseCheck } from './helpers/scripted-search-release.ts';

function deferred() {
  let resolve!: () => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function world(split = true) {
  const clock = createTestClock();
  const marks = new OwnerBusyMarks({ now: clock.now });
  const sent: EngineCommand[] = [];
  const relay = new OwnerBusyRelay({ post: async command => {
    sent.push(command);
    if (command.kind === 'owner_busy' || command.kind === 'owner_idle') marks.apply(command);
    return { id: 'question', state: 'done', instance_id: 'background' };
  } }, () => {}, {
    front: 'front', setInterval: clock.setInterval,
    clearInterval: timer => clock.clearInterval(timer as never),
  });
  const questions = createOwnerQuestionActivity(split ? relay : undefined);
  const corpusId = 'internal.fixture';
  const registry = buildSourceIndexCorpusRegistry([
    defineSourceIndexCorpus({ corpusId, family: 'file', trustDomain: 'internal' }),
  ]);
  let failSetup = false;
  const factory = createSourceAnswerLanes({
    ownerQuestions: questions,
    stores: () => {
      // Activation precedes even mounting stores / looking up scopes.
      if (failSetup) throw new Error('store unavailable');
      return [];
    },
    registry: () => registry,
    embeddingProvider: () => undefined, localEmbedding: () => undefined,
    readScope: () => ({ allowed: true, contentAllowed: true }),
    answerScope: () => ({ kind: 'search' }), accountScope: () => undefined,
  });
  const pending: ReturnType<typeof deferred>[] = [];
  const lanes: typeof factory = request => {
    const current = factory(request);
    const gate = deferred();
    pending.push(gate);
    return { ...current, unmountedCorpusIds: new Set(), adapters: {
      [corpusId]: async () => {
        await gate.promise;
        return { hits: [], latencyMs: 0, rawExposed: false as const };
      },
    } };
  };
  const handler = createAnalystSourceIndexAnswerHandler({
    lanes,
    analyst: createAnalyst({ complete: async () => { throw new Error('empty evidence never calls a model'); } }),
  });
  const ask = () => questions.run(() => handler.answer({ question: 'What do my sources say?', retrieval_mode: 'keyword' }));
  const search = () => questions.run(() => searchReleasedEvidence({ lanes, question: 'What do my sources say?', releaseCheck: provedReleaseCheck }));
  let slices = 0;
  const stopTicker = startSupersededSweepTicker({
    active: () => split ? !marks.busy(OWNER_QUESTION_RESOURCE) : !questions.busy,
    sets: () => [{ sweepSupersededSlice: () => { slices++; return false; } } as TieredStoreSet],
    every: (tick, ms) => {
      const timer = clock.setInterval(tick, ms);
      return () => clock.clearInterval(timer);
    },
  });
  return { clock, marks, relay, questions, factory, pending, sent, ask, search,
    failSetup: () => { failSetup = true; }, slices: () => slices,
    close: () => { relay.stop(); stopTicker(); } };
}

const kinds = (sent: EngineCommand[]) => sent.map(command => command.kind);

describe('owner questions pause the superseded-copy sweep', () => {
  test('a real Ask sends busy before retrieval, skips ticks, and sends idle on success', async () => {
    const w = world();
    try {
      await w.clock.advance(SUPERSEDED_SWEEP_TICK_MS);
      expect(w.slices()).toBe(1);
      const answer = w.ask();
      expect(kinds(w.sent)).toEqual(['owner_busy']);
      expect(w.sent[0]).toMatchObject({ resource: OWNER_QUESTION_RESOURCE });
      expect(w.questions.busy).toBe(true);
      await w.clock.advance(SUPERSEDED_SWEEP_TICK_MS * 2);
      expect(w.slices()).toBe(1);
      w.pending[0]!.resolve();
      expect((await answer).answer).toContain('no matching evidence');
      expect(kinds(w.sent)).toEqual(['owner_busy', 'owner_idle']);
      expect(w.questions.busy).toBe(false);
      await w.clock.advance(SUPERSEDED_SWEEP_TICK_MS);
      expect(w.slices()).toBe(2);
    } finally { w.close(); }
  });

  test('a lane setup failure still releases the front mark', async () => {
    const w = world();
    try {
      w.failSetup();
      await expect(w.ask()).rejects.toThrow('store unavailable');
      expect(kinds(w.sent)).toEqual(['owner_busy', 'owner_idle']);
      expect(w.questions.busy).toBe(false);
      expect(w.marks.busy(OWNER_QUESTION_RESOURCE)).toBe(false);
    } finally { w.close(); }
  });

  for (const name of ['Error', 'AbortError', 'TimeoutError']) {
    test(`a question that settles with ${name} releases its mark`, async () => {
      const w = world();
      try {
        const settled = deferred();
        const question = w.questions.run(async () => {
          w.factory({ question: 'Read my sources' });
          await settled.promise;
        });
        const error = Object.assign(new Error(name), { name });
        const rejected = question.catch(error => error);
        w.clock.setTimeout(() => settled.reject(error), 100);
        await w.clock.advance(100);
        expect(await rejected).toBe(error);
        expect(kinds(w.sent)).toEqual(['owner_busy', 'owner_idle']);
        expect(w.marks.busy(OWNER_QUESTION_RESOURCE)).toBe(false);
      } finally { w.close(); }
    });
  }

  test('two overlapping Asks stay busy until the last settles', async () => {
    const w = world();
    try {
      const first = w.ask();
      const second = w.ask();
      expect(kinds(w.sent)).toEqual(['owner_busy']);
      w.pending[0]!.resolve();
      await first;
      expect(w.questions.busy).toBe(true);
      expect(kinds(w.sent)).toEqual(['owner_busy']);
      await w.clock.advance(SUPERSEDED_SWEEP_TICK_MS);
      expect(w.slices()).toBe(0);
      w.pending[1]!.resolve();
      await second;
      expect(w.questions.busy).toBe(false);
      expect(kinds(w.sent)).toEqual(['owner_busy', 'owner_idle']);
    } finally { w.close(); }
  });

  test('search uses the same lease and an overlapping Ask cannot clear it', async () => {
    const w = world();
    try {
      const search = w.search();
      const answer = w.ask();
      w.pending[1]!.resolve();
      await answer;
      expect(kinds(w.sent)).toEqual(['owner_busy']);
      await w.clock.advance(SUPERSEDED_SWEEP_TICK_MS);
      expect(w.slices()).toBe(0);
      w.pending[0]!.resolve();
      await search;
      expect(kinds(w.sent)).toEqual(['owner_busy', 'owner_idle']);
    } finally { w.close(); }
  });

  test('the combined engine pauses locally without sending relay commands', async () => {
    const w = world(false);
    try {
      const answer = w.ask();
      await w.clock.advance(SUPERSEDED_SWEEP_TICK_MS);
      expect(w.questions.busy).toBe(true);
      expect(w.slices()).toBe(0);
      expect(w.sent).toEqual([]);
      w.pending[0]!.resolve();
      await answer;
      await w.clock.advance(SUPERSEDED_SWEEP_TICK_MS);
      expect(w.slices()).toBe(1);
    } finally { w.close(); }
  });

  test('a live front renews a long Ask; a crashed front lapses and the background resumes', async () => {
    const w = world();
    // Here the ticker is a different process: only its received mark gates it.
    let slices = 0;
    const stop = startSupersededSweepTicker({
      active: () => !w.marks.busy(OWNER_QUESTION_RESOURCE),
      sets: () => [{ sweepSupersededSlice: () => { slices++; return false; } } as TieredStoreSet],
      every: (tick, ms) => { const timer = w.clock.setInterval(tick, ms); return () => w.clock.clearInterval(timer); },
    });
    try {
      const answer = w.ask();
      await w.clock.advance(12 * 60_000);
      expect(slices).toBe(0);
      expect(kinds(w.sent)).toEqual(Array(5).fill('owner_busy'));
      w.relay.observeInstance('background-1');
      w.relay.observeInstance('background-2');
      expect(w.sent.at(-1)).toMatchObject({ kind: 'owner_busy', resource: OWNER_QUESTION_RESOURCE });
      // Front death stops renewal and sends no idle.
      w.relay.stop();
      await w.clock.advance(10 * 60_000 - SUPERSEDED_SWEEP_TICK_MS);
      expect(slices).toBe(0);
      await w.clock.advance(SUPERSEDED_SWEEP_TICK_MS);
      expect(slices).toBe(1);
      expect(w.marks.busy(OWNER_QUESTION_RESOURCE)).toBe(false);
      // Settle the simulated call only to clean up the test's promise.
      w.pending[0]!.resolve();
      await answer;
    } finally { stop(); w.close(); }
  });

  test('only retrieval in a question scope counts, and repeated or nested reads use one lease', async () => {
    const w = world();
    try {
      w.factory({ question: 'scope check' });
      await w.questions.run(async () => {});
      await w.questions.run(async () => { w.factory({ question: 'watch' }); }, 'background');
      expect(w.sent).toEqual([]);
      await w.questions.run(async () => {
        w.factory({ question: 'first read' });
        await w.questions.run(async () => { w.factory({ question: 'second read' }); });
        expect(kinds(w.sent)).toEqual(['owner_busy']);
        expect(w.questions.busy).toBe(true);
      });
      expect(kinds(w.sent)).toEqual(['owner_busy', 'owner_idle']);
    } finally { w.close(); }
  });

  test('the engine wires answer/search scopes and the ticker to the same activity', () => {
    const server = readFileSync(new URL('../src/workers/engine/server.ts', import.meta.url), 'utf8');
    expect(server).toContain('createOwnerQuestionActivity(engineFront?.ownerBusy)');
    expect(server).toMatch(/createSourceAnswerLanes\(\{\s*ownerQuestions,/);
    expect(server).toContain('ownerQuestions.run(() => answerActivity.run(() => analystSourceAnswer.answer(request, local), kind), kind)');
    expect(server).toContain('ownerQuestions.run(() => answerActivity.run(() => local.answer(input)))');
    expect(server.match(/ownerQuestions.run\(\(\) => searchReleasedEvidence\(/g)).toHaveLength(2);
    expect(server).toContain('ownerQuestions.run(() => searchPrivateEvidence(');
    expect(server).toContain('active: () => !engineFront && !ownerQuestions.busy && !remoteOwnerBusy(OWNER_QUESTION_RESOURCE)');
    // A claimed Private panel answer holds a question lease until it settles.
    expect(server).toMatch(/activity: \{\s*begin: \(\) => \{\s*const releaseAnswer = answerActivity\.begin\(\);\s*const releaseQuestion = ownerQuestions\.begin\(\);/);
  });

  test('a claimed panel job holds the lease until its release, and a second release does nothing', async () => {
    const w = world();
    try {
      const release = w.questions.begin();
      expect(w.questions.busy).toBe(true);
      expect(kinds(w.sent)).toEqual(['owner_busy']);
      const ask = w.ask();
      w.pending[0]!.resolve();
      await ask;
      // The Ask settled; the claimed job still holds the sweep back.
      expect(w.questions.busy).toBe(true);
      await w.clock.advance(SUPERSEDED_SWEEP_TICK_MS * 2);
      expect(w.slices()).toBe(0);
      release();
      release();
      expect(w.questions.busy).toBe(false);
      expect(kinds(w.sent)).toEqual(['owner_busy', 'owner_idle']);
    } finally { w.close(); }
  });
});
