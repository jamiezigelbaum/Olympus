import { describe, expect, test } from 'bun:test';
import { engineStatePaths } from '../scripts/release-check/machine-agent.ts';
import { AGENT_PAST_BUDGET_MS, agentDetail, agentTimeoutMs, defaultBudgetMs, phaseBudgetMs, stoppedByBudget } from '../scripts/release-check/run.ts';

describe('release-check time budget (olympus-ops#156)', () => {
  test('an in-machine call keeps its own bound while the budget has room', () => {
    expect(agentTimeoutMs(600_000, 10_000_000, 1_000_000)).toBe(600_000);
  });

  test('a call is cut to what is left of the budget', () => {
    expect(agentTimeoutMs(1_800_000, 1_000_000 + 300_000, 1_000_000)).toBe(300_000);
  });

  test('past the budget a call still gets a short floor, so evidence and teardown can run', () => {
    expect(agentTimeoutMs(1_800_000, 1_000_000, 2_000_000)).toBe(AGENT_PAST_BUDGET_MS);
    expect(agentTimeoutMs(10_000, 1_000_000, 2_000_000)).toBe(10_000);
  });

  test('a cut call counts as stopped by the budget whether the driver (exit 124) or the harness timer stopped it (Codex on #1325)', () => {
    expect(stoppedByBudget({ code: 124, timedOut: false }, 60_000, 600_000)).toBe(true);
    expect(stoppedByBudget({ code: 124, timedOut: true }, 60_000, 600_000)).toBe(true);
    expect(stoppedByBudget({ code: 1, timedOut: false }, 60_000, 600_000)).toBe(false);
    // A call that was not cut and timed out on its own bound is the phase's own failure, not the budget's.
    expect(stoppedByBudget({ code: 124, timedOut: false }, 600_000, 600_000)).toBe(false);
  });

  test('a run without the archive-import leg gets a shorter budget than one with it', () => {
    expect(defaultBudgetMs(false, true)).toBe(40 * 60_000);
    expect(defaultBudgetMs(false, false)).toBe(60 * 60_000);
    expect(defaultBudgetMs(true, true)).toBe(70 * 60_000);
    expect(defaultBudgetMs(true, false)).toBe(90 * 60_000);
    expect(defaultBudgetMs(false, false, true)).toBe(180 * 60_000);
    expect(phaseBudgetMs('archive-beside-live')).toBe(8 * 60_000);
    expect(phaseBudgetMs('archive-scale-readwise')).toBe(20 * 60_000);
  });
});

describe('the engine state a report keeps', () => {
  test('names the front\'s snapshot and the archive state and request files, all under the install\'s own data folders', () => {
    const home = '/home/rc-test';
    const paths = engineStatePaths({ HOME: home, XDG_DATA_HOME: `${home}/.local/share`, XDG_STATE_HOME: `${home}/.local/state` });
    expect(paths.map((path) => path.split('/').pop())).toEqual(['engine-background-status.json', 'archive-imports.json', 'archive-import-requests.json']);
    for (const path of paths) expect(path.startsWith(`${home}/`)).toBe(true);
  });
});

describe('why an in-machine call failed', () => {
  const call = (over: Partial<Parameters<typeof agentDetail>[0]>) => ({ result: undefined, stderr: '', code: 1, timedOut: false, ...over });

  test('the agent\'s own reason wins, in the order the check names its fields', () => {
    expect(agentDetail(call({ result: { ok: false, step: 'engine-restart' } }), 'detail', 'step')).toBe('engine-restart');
    expect(agentDetail(call({ result: { ok: false, detail: 'not ready', step: 'x' } }), 'detail', 'step')).toBe('not ready');
  });

  test('an agent that died without a word shows its exit code and signal, never an empty reason', () => {
    expect(agentDetail(call({ code: 137 }))).toBe('no result from the machine (exit 137, signal 9), and no output');
    expect(agentDetail(call({ code: 124, timedOut: true, stderr: 'still waiting\n' }))).toBe('no result from the machine (exit 124, timed out): still waiting');
  });

  test('a result with no reason falls back to stderr, then to the exit code', () => {
    expect(agentDetail(call({ result: { ok: false }, stderr: 'boom' }))).toBe('boom');
    expect(agentDetail(call({ result: { ok: false }, code: 3 }))).toBe('the agent gave no reason (exit 3)');
  });
});

// A stuck VM call must fail by phase name immediately, without waiting for teardown.
import { Run } from '../scripts/release-check/run.ts';
import { CommandDriver, type Machine } from '../scripts/release-check/machine.ts';
import { createTestClock, flushMicrotasks } from './helpers/test-clock.ts';

test('a phase budget clamps the VM timeout, reports while still running, and permits independent checks', async () => {
  const clock = createTestClock(0);
  const run = new Run({ runId: 'clock', candidateDir: '/tmp', candidateLabel: 'clock', outDir: '/tmp', config: { driver: ['unused'] } }, new CommandDriver({ argv: ['unused'] }), clock);
  let allowed = 0;
  let finish!: () => void;
  run.machine = { handle: 'clock', label: 'clock', os: 'linux', driver: 'clock',
    exec: async (_script, options) => {
      allowed = options?.timeoutMs ?? 0;
      await new Promise<void>(resolve => { finish = resolve; });
      return { code: 124, timedOut: true, stdout: '', stderr: '', ms: clock.now() };
    }, upgrade: async () => {}, put: async () => {}, get: async () => {},
  } satisfies Machine;
  const phase = run.phase('ingest', () => run.agent('settle', '', 900_000));
  await flushMicrotasks();
  expect(allowed).toBe(phaseBudgetMs('ingest'));
  await clock.advance(phaseBudgetMs('ingest'));
  expect(run.checks.some(check => check.id === 'phase.ingest.time-budget' && check.status === 'fail')).toBe(true);
  finish();
  await phase;
  run.add({ id: 'independent', title: 'later check', status: 'pass' });
  expect(run.checks.at(-1)?.id).toBe('independent');
  expect(run.timings.ingest).toBe(phaseBudgetMs('ingest'));
});

test('an over-budget phase also names its driver upgrade timeout', async () => {
  const clock = createTestClock(0);
  const run = new Run({ runId: 'clock', candidateDir: '/tmp', candidateLabel: 'clock', outDir: '/tmp', config: { driver: ['unused'] } }, new CommandDriver({ argv: ['unused'] }), clock);
  let allowed = 0;
  run.deadline = 10_000;
  run.machine = { handle: 'clock', label: 'clock', os: 'linux', driver: 'clock',
    exec: async () => ({ code: 0, timedOut: false, stdout: '', stderr: '', ms: 0 }),
    upgrade: async (_candidate, options) => { allowed = options?.timeoutMs ?? 0; },
    put: async () => {}, get: async () => {},
  } satisfies Machine;
  await run.phase('upgrade', () => run.machine!.upgrade('/tmp'));
  expect(allowed).toBe(10_000);
});

import { LegBudget } from '../scripts/release-check/leg-budget.ts';
test('a real-machine leg reports its deadline live and still allows bounded restoration', async () => {
  const clock = createTestClock(0);
  const checks: import('../scripts/release-check/report.ts').CheckResult[] = [];
  const budget = new LegBudget('fresh-install', 1_000, check => { checks.push(check); }, clock);
  let allowed = 0;
  const machine = budget.machine({ handle: 'clock', label: 'clock', os: 'linux', driver: 'clock',
    exec: async (_script, options) => {
      allowed = options?.timeoutMs ?? 0;
      return { code: 0, timedOut: false, stdout: '', stderr: '', ms: 0 };
    }, upgrade: async () => {}, put: async () => {}, get: async () => {},
  });
  budget.timings.install = 500;
  await clock.advance(1_001);
  expect(checks[0]?.id).toBe('leg.time-budget');
  expect(checks[0]?.status).toBe('fail');
  expect(checks[0]?.detail).toContain('install');
  budget.cleanup();
  await budget.phase('restore-zig', 5_000, () => machine.exec('restore', { timeoutMs: 4_000 }));
  expect(allowed).toBe(4_000);
  budget.finish();
  expect(checks).toHaveLength(1);
  expect(checks[0]?.status).toBe('fail');
});

test('a phase given its own budget uses it instead of the named one', async () => {
  const clock = createTestClock(0);
  const run = new Run({ runId: 'clock', candidateDir: '/tmp', candidateLabel: 'clock', outDir: '/tmp', config: { driver: ['unused'] } }, new CommandDriver({ argv: ['unused'] }), clock);
  run.deadline = 10 * 3_600_000;
  let allowed = 0;
  let finish!: () => void;
  run.machine = { handle: 'clock', label: 'clock', os: 'linux', driver: 'clock',
    exec: async (_script, options) => {
      allowed = options?.timeoutMs ?? 0;
      await new Promise<void>(resolve => { finish = resolve; });
      return { code: 0, timedOut: false, stdout: '{}', stderr: '', ms: clock.now() };
    }, upgrade: async () => {}, put: async () => {}, get: async () => {},
  } satisfies Machine;
  // A Readwise scale step bounded at 1,200 s waits for the import and then the repeat sweep, each up to the bound.
  const stepMs = (1_200 * 2 + 300 * 2 + 900 * 2 + 600) * 1_000;
  const phase = run.phase('archive-scale-readwise', () => run.agent('archive-scale', '', stepMs), stepMs);
  await flushMicrotasks();
  expect(allowed).toBe(stepMs);
  await clock.advance(phaseBudgetMs('archive-scale-readwise') + 1_000);
  expect(run.checks.some(check => check.id === 'phase.archive-scale-readwise.time-budget')).toBe(false);
  finish();
  await phase;
});
