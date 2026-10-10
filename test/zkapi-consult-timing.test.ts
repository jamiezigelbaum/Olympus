// Tests for scripts/zkapi-consult-timing.ts with stand-in transport functions
// that return the transport's own result types. No network, no Tor, no daemon.

import { describe, expect, test } from 'bun:test';
import {
  DEFAULT_QUESTIONS,
  loadQuestions,
  median,
  parseTimingArgs,
  percentile,
  runTiming,
  sessionConsult,
  type ConsultTiming,
  type TimingDeps,
  type TimingPlan,
} from '../scripts/zkapi-consult-timing.ts';
import type {
  ZkapiConsultReply,
  ZkapiConsultReadiness,
  ZkapiConsultResult,
  ZkapiConsultSession,
  ZkapiSessionReceipt,
} from '../src/core/consult-transport-zkapi.ts';
import { parseZkapiConsultSettings } from '../src/core/zkapi-consult-settings.ts';

const receipt = (totalMs: number, dispatch: number): ZkapiSessionReceipt => ({
  recovery: false,
  keyReuse: 'verified_off',
  inferenceAuth: 'verified',
  tor: 'per_consult',
  freshTorClient: true,
  confinement: 'none',
  confinementSelfTest: 'failed',
  postStopProbe: 'route_lost',
  settlement: 'confirmed',
  fence: 'clear',
  reservedUsd: 6,
  stageMs: { torBootstrapMs: 100, dispatchToFirstByteMs: dispatch, totalMs },
});

const okResult = (totalMs: number, dispatch: number): ZkapiConsultResult => ({
  ok: true,
  text: 'SECRET-REPLY',
  routeLabel: 'route-x',
  networkIdentity: 'not_verified',
  receipt: receipt(totalMs, dispatch),
  elapsedMs: totalMs,
});

const ready = (blockers: ZkapiConsultReadiness['blockers'] = []): ZkapiConsultReadiness => ({ blockers } as ZkapiConsultReadiness);

/** A stand-in session timing: the reply came at half the total when the run succeeded. */
const timed = (result: ZkapiConsultResult): ConsultTiming => {
  const total = result.ok ? result.elapsedMs : result.error.receipt?.stageMs?.totalMs ?? 0;
  return { result, toReplyMs: result.ok ? total / 2 : null, toFinishedMs: total };
};

function harness(results: ZkapiConsultResult[], blockersPerCall: ZkapiConsultReadiness['blockers'][] = []) {
  const out: string[] = [];
  const errs: string[] = [];
  const sent: string[] = [];
  const written: Record<string, string> = {};
  let readinessCalls = 0;
  const deps: TimingDeps = {
    readiness: async () => ready(blockersPerCall[readinessCalls++] ?? []),
    consult: async (question) => {
      sent.push(question);
      return timed(results[sent.length - 1]!);
    },
    log: (line) => out.push(line),
    error: (line) => errs.push(line),
    writeResults: (path, json) => { written[path] = json; },
    now: () => new Date('2026-10-07T00:00:00.000Z'),
  };
  const plan = (n: number, extra: Partial<TimingPlan> = {}): TimingPlan => ({
    questions: DEFAULT_QUESTIONS,
    n,
    showReplies: false,
    out: 'results.json',
    transport: { baseUrl: 'http://127.0.0.1:1/v1', model: 'm', settings: parseZkapiConsultSettings({}, 'test') },
    ...extra,
  });
  return { deps, plan, out, errs, sent, written };
}

describe('zkapi consult timing runner', () => {
  test('aggregate math: median and nearest-rank p95', () => {
    expect(median([5, 1, 3])).toBe(3);
    expect(median([1, 2, 3, 4])).toBe(2.5);
    expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.95)).toBe(10);
    expect(percentile([10, 20, 30, 40], 0.95)).toBe(40);
  });

  test('argument parsing', () => {
    expect(parseTimingArgs([])).toMatchObject({ n: 10, showReplies: false });
    expect(parseTimingArgs(['--n', '3', '--model', 'x', '--show-replies'])).toMatchObject({ n: 3, model: 'x', showReplies: true });
    expect(parseTimingArgs(['--n', '0'])).toHaveProperty('error');
    expect(parseTimingArgs(['--bogus'])).toHaveProperty('error');
    expect(parseTimingArgs(['--out'])).toHaveProperty('error');
  });

  test('readiness block stops before any send and exits 2', async () => {
    const h = harness([], [['unresolved_session']]);
    const result = await runTiming(h.plan(3), h.deps);
    expect(result.exitCode).toBe(2);
    expect(h.sent).toHaveLength(0);
    expect(h.errs.join('\n')).toContain('unresolved_session');
    expect(h.errs.join('\n')).toContain('zkapi-consult-recover.ts');
    expect(JSON.parse(h.written['results.json']!).blockedBefore).toEqual({ run: 1, blockers: ['unresolved_session'] });
  });

  test('successful runs: rows, medians, p95, reservation, quiet replies, no secrets in file', async () => {
    const h = harness([okResult(1000, 10), okResult(3000, 30), okResult(2000, 20)]);
    const result = await runTiming(h.plan(3), h.deps);
    expect(result.exitCode).toBe(0);
    expect(h.sent).toEqual(DEFAULT_QUESTIONS.slice(0, 3));
    const printed = h.out.join('\n');
    expect(printed).toContain('#1 | ok | outcome=ok | identity=not_verified | route="route-x" | confinement=none | fence=clear | reserved=$6 | elapsed=1000ms | reply=500ms | finished=1000ms');
    expect(printed).toContain('dispatch to first byte');
    expect(printed).toContain('Time to reply (caller side): median 1000 ms, p95 1500 ms (3 run(s))');
    expect(printed).toContain('Time to finished (caller side): median 2000 ms, p95 3000 ms (3 run(s))');
    expect(printed).not.toContain('SECRET-REPLY');
    expect(result.summary.toReply).toEqual({ runs: 3, medianMs: 1000, p95Ms: 1500 });
    expect(result.summary.toFinished).toEqual({ runs: 3, medianMs: 2000, p95Ms: 3000 });
    expect(result.summary.totalWorstCaseReservedUsd).toBe(18);
    expect(result.summary.stages.find((s) => s.stage === 'totalMs')).toMatchObject({ runs: 3, medianMs: 2000, p95Ms: 3000 });
    expect(result.summary.stages.find((s) => s.stage === 'dispatchToFirstByteMs')).toMatchObject({ medianMs: 20, p95Ms: 30 });
    expect(h.written['results.json']).not.toContain('SECRET-REPLY');
    expect(JSON.parse(h.written['results.json']!).questions).toHaveLength(3);
  });

  test('--show-replies prints the reply', async () => {
    const h = harness([okResult(1000, 10)]);
    await runTiming(h.plan(1, { showReplies: true }), h.deps);
    expect(h.out.join('\n')).toContain('reply: SECRET-REPLY');
  });

  test('a failed run is counted by code, excluded from stage stats, and exits 1', async () => {
    const failed: ZkapiConsultResult = {
      ok: false,
      error: {
        code: 'timeout',
        message: 'The zkAPI consult timed out; it may still have been charged.',
        outcome: 'unknown',
        networkIdentity: 'not_verified',
        receipt: { ...receipt(9000, 8000), fence: 'held' },
      },
    };
    const h = harness([okResult(1000, 10), failed]);
    const result = await runTiming(h.plan(2), h.deps);
    expect(result.exitCode).toBe(1);
    expect(result.summary).toMatchObject({ succeeded: 1, failed: 1, failuresByCode: { timeout: 1 }, totalWorstCaseReservedUsd: 12 });
    expect(result.summary.stages.find((s) => s.stage === 'totalMs')).toMatchObject({ runs: 1, medianMs: 1000 });
    expect(result.summary.toReply).toEqual({ runs: 1, medianMs: 500, p95Ms: 500 });
    expect(h.out.join('\n')).toContain('#2 | error timeout | outcome=unknown');
    expect(h.out.join('\n')).toContain('| reply=n/a | finished=9000ms');
  });

  test('sessionConsult times the reply and the finish from the caller\'s side through open, send and finished', async () => {
    let clock = 0;
    const calls: string[] = [];
    const final = okResult(5000, 10);
    const reply: ZkapiConsultReply = { kind: 'reply', text: 'SECRET-REPLY', routeLabel: 'route-x', networkIdentity: 'not_verified', receipt: { ...receipt(0, 10), settlement: 'pending', fence: 'held' }, elapsedMs: 10 };
    const session: ZkapiConsultSession = {
      state: 'ready',
      send: async (question) => {
        calls.push(`send:${question}`);
        clock = 40;
        return reply;
      },
      cancel: () => calls.push('cancel'),
      finished: Promise.resolve(final),
    };
    const open = async () => {
      calls.push('open');
      clock = 25;
      return { ok: true as const, session };
    };
    const timing = await sessionConsult('q', { baseUrl: 'http://127.0.0.1:1/v1', model: 'm', settings: parseZkapiConsultSettings({}, 'test') }, {
      open,
      now: () => {
        const at = clock;
        if (clock === 40) clock = 100;
        return at;
      },
    });
    expect(calls).toEqual(['open', 'send:q']);
    expect(timing).toEqual({ result: final, toReplyMs: 40, toFinishedMs: 100 });
    // A refused open is a failed run with no reply time.
    const refused = await sessionConsult('q', { baseUrl: 'http://127.0.0.1:1/v1', model: 'm', settings: parseZkapiConsultSettings({}, 'test') }, {
      open: async () => ({ ok: false as const, error: { code: 'busy', message: 'busy', outcome: 'not_sent', networkIdentity: 'not_verified' } }),
      now: () => 7,
    });
    expect(refused).toMatchObject({ result: { ok: false, error: { code: 'busy' } }, toReplyMs: null, toFinishedMs: 0 });
    // A send refused before it touched the session cancels it, waits for teardown and reports the refusal.
    const calls2: string[] = [];
    let finish!: (value: ZkapiConsultResult) => void;
    const idle: ZkapiConsultSession = {
      state: 'ready',
      send: async () => ({ kind: 'failed', error: { code: 'invalid_question', message: 'invalid', outcome: 'not_sent', networkIdentity: 'not_verified' } }),
      cancel: () => {
        calls2.push('cancel');
        finish({ ok: false, error: { code: 'aborted', message: 'aborted', outcome: 'not_sent', networkIdentity: 'not_verified' } });
      },
      finished: new Promise<ZkapiConsultResult>((resolve) => { finish = resolve; }),
    };
    const refusedSend = await sessionConsult('', { baseUrl: 'http://127.0.0.1:1/v1', model: 'm', settings: parseZkapiConsultSettings({}, 'test') }, {
      open: async () => ({ ok: true as const, session: idle }),
      now: () => 3,
    });
    expect(calls2).toEqual(['cancel']);
    expect(refusedSend).toMatchObject({ result: { ok: false, error: { code: 'invalid_question' } }, toReplyMs: null });
  });

  test('question sets are validated at load: empty, oversize and control characters are refused', () => {
    expect(loadQuestions(undefined, () => '')).toEqual([...DEFAULT_QUESTIONS]);
    expect(loadQuestions('q.txt', () => 'one\ntwo\n')).toEqual(['one', 'two']);
    expect(() => loadQuestions('q.json', () => JSON.stringify(['ok', 'x'.repeat(9000)]))).toThrow(/Question 2/);
    expect(() => loadQuestions('q.json', () => JSON.stringify(['a\u0000b']))).toThrow(/Question 1/);
    expect(() => loadQuestions('q.json', () => '[]')).toThrow(/non-empty/);
  });
});
