import { describe, expect, test } from 'bun:test';
import { engineStatePaths } from '../scripts/release-check/machine-agent.ts';
import { AGENT_PAST_BUDGET_MS, agentDetail, agentTimeoutMs, defaultBudgetMs, stoppedByBudget } from '../scripts/release-check/run.ts';

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
    expect(defaultBudgetMs(false, true)).toBe(60 * 60_000);
    expect(defaultBudgetMs(false, false)).toBe(135 * 60_000);
    expect(defaultBudgetMs(true, true)).toBe(120 * 60_000);
    expect(defaultBudgetMs(true, false)).toBe(195 * 60_000);
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
