import { expect, test } from 'bun:test';
import { runFreshLimits, LIMITS_HOME, type FreshLimitsOptions, type LimitsHome, type LimitsMachine, type LimitsStop } from '../scripts/release-check/fresh-limits.ts';
import type { Machine } from '../scripts/release-check/machine.ts';
import { renderLimits } from '../scripts/release-check/report.ts';
import { canaryVerdict } from '../scripts/release-check/canary.ts';
import { createTestClock } from './helpers/test-clock.ts';

function rig(fault?: 'missing-judge' | 'no-resume' | 'missing-venice' | 'no-credential' | 'no-credential-restart' | 'restart' | 'wrong-home' | 'refill-failed' | 'marker-remains' | 'command-error') {
  const time = createTestClock();
  const start = time.now();
  const commands: string[] = [];
  const events: string[] = [];
  let raisedAt: number | undefined;
  let markerAt: number | undefined;
  let marker = false;
  let refilled = false;
  let closed = false;
  const judge: LimitsStop = { id: 'judge.daily_calls', label: 'Privacy judge daily call budget used', unit: 'calls', limit: 1, used: 1, resumesAt: '2026-01-02T00:00:00.000Z' };
  const venice: LimitsStop = { id: 'venice.credit', label: 'Venice billing/balance.canConsume is false', unit: 'usd', limit: null, used: null };
  const stops = () => [
    ...(fault !== 'missing-judge' && raisedAt === undefined && time.now() >= start + 2000 ? [judge] : []),
    ...(markerAt !== undefined && time.now() >= markerAt + 60_000 && fault !== 'missing-venice' && !refilled ? [venice] : []),
  ];
  const dashboard = async (): Promise<LimitsHome> => ({ waits: stops().map(stop => ({
    reason: 'limit', limitLabel: stop.label, limit: stop.limit, used: stop.used, unit: stop.unit,
    ...(stop.resumesAt ? { resumesAt: stop.resumesAt } : {}),
    fix: { label: fault === 'wrong-home' ? 'Reconnect' : stop.id === judge.id ? 'Raise to 2 calls' : 'Refill — re-check',
      tool: 'olympus_limits', args: { action: 'continue', id: stop.id } },
  })) });
  const execute = async (script: string) => {
    commands.push(script);
    if (fault === 'command-error') throw new Error('/private/account Secret title from somebody@example.test');
    if (script.endsWith('limits')) return JSON.stringify({ stops: stops().map(stop => ({ ...stop, subject: '/private/account' })) });
    if (script.endsWith('limits continue judge.daily_calls --to 50')) {
      raisedAt = time.now(); return JSON.stringify({ ok: true });
    }
    if (script.endsWith('limits continue venice.credit')) {
      if (fault?.startsWith('no-credential') || fault === 'refill-failed') return JSON.stringify({ ok: false, status_message: 'Venice billing has not confirmed canConsume=true. The stop remains.' });
      refilled = true; marker = fault === 'marker-remains'; return JSON.stringify({ ok: true });
    }
    if (script.includes('/dashboard?panel-read')) return JSON.stringify({ structuredContent: { v: 1, ...await dashboard() } });
    throw new Error('unexpected command');
  };
  const machine: Machine = {
    handle: 'throwaway', label: 'throwaway', os: 'linux', driver: 'fake', disposable: true,
    exec: async script => ({ code: 0, stdout: await execute(script.split('\n').slice(1).join('\n')), stderr: '', timedOut: false, ms: 0 }),
    put: async () => {}, get: async () => {}, upgrade: async () => {},
  };
  const diagnostics: LimitsMachine = {
    prepare: async () => { events.push('prepare'); }, seed: async () => { events.push('seed'); return 2; },
    snapshot: async () => ({ pid: 41, workerPids: [(raisedAt !== undefined && fault === 'restart') || (markerAt !== undefined && fault === 'no-credential-restart') ? 999 : 42],
      calls: raisedAt !== undefined && fault !== 'no-resume' && time.now() >= raisedAt + 3000 ? 2 : 1 }),
    hasVeniceCredential: async () => !fault?.startsWith('no-credential'),
    marker: async action => {
      events.push(`marker-${action}`);
      if (action === 'write') { marker = true; markerAt = time.now(); }
      if (action === 'remove') marker = false;
      return marker;
    },
    close: async () => { events.push('close'); closed = true; },
  };
  const options: FreshLimitsOptions = { clock: { now: time.now, sleep: ms => time.advance(ms) }, diagnostics: async target => {
    expect(target).toBe(machine); return diagnostics;
  }, exec: execute, dashboard };
  return { machine, options, commands, events, time, diagnostics, marker: () => marker, closed: () => closed };
}

test('limits proves list, Home actions, one-step Raise and Refill, bounded resumption and cleanup', async () => {
  const r = rig();
  const result = await runFreshLimits(r.machine, r.options);
  expect(result.checks.every(check => check.status === 'pass')).toBe(true);
  expect(result.rows).toEqual([
    { id: 'judge.daily_calls', status: 'pass', unit: 'calls', limit: 1, used: 1, callsAfter: 2, resumesAt: '2026-01-02T00:00:00.000Z', startedAt: '2026-01-01T12:00:00.000Z', ms: 5000 },
    { id: 'venice.credit', status: 'pass', unit: 'usd', startedAt: '2026-01-01T12:00:05.000Z', ms: 60_000 },
  ]);
  expect(r.commands.filter(command => command.includes('limits continue'))).toEqual([
    '"$HOME/.local/bin/olympus" limits continue judge.daily_calls --to 50',
    '"$HOME/.local/bin/olympus" limits continue venice.credit',
  ]);
  expect(r.events.slice(-2)).toEqual(['marker-remove', 'close']);
  expect(r.marker()).toBe(false); expect(r.closed()).toBe(true);
  expect(JSON.stringify(result)).not.toContain('/private/account');
  expect(renderLimits(result.rows)).toContain('Calls after Raise');
}, 30_000);

test('a judge stop that never appears fails at its deadline', async () => {
  const r = rig('missing-judge');
  const result = await runFreshLimits(r.machine, r.options);
  expect(result.checks.find(check => check.id === 'limits.judge.daily_calls')).toMatchObject({ status: 'fail', detail: 'judge.daily_calls never appeared', ms: 180_000 });
  expect(result.rows[0]?.status).toBe('fail');
  expect(r.events.slice(-2)).toEqual(['marker-remove', 'close']);
}, 30_000);

test('Raise clearing the list and Home without more judge calls fails', async () => {
  const r = rig('no-resume');
  const result = await runFreshLimits(r.machine, r.options);
  expect(result.checks.find(check => check.id === 'limits.judge.daily_calls')).toMatchObject({ status: 'fail', detail: 'Raise did not resume judge calls' });
  expect(result.rows[0]?.callsAfter).toBeUndefined();
  expect(canaryVerdict(result.checks)).toBe('fail');
  expect(r.closed()).toBe(true);
}, 30_000);

test('Venice without a credential stays stopped and records the lift as inconclusive', async () => {
  const r = rig('no-credential');
  const result = await runFreshLimits(r.machine, r.options);
  expect(result.rows[1]).toMatchObject({ id: 'venice.credit', status: 'inconclusive', reason: 'Venice billing has not confirmed canConsume=true; no Venice credential' });
  expect(canaryVerdict(result.checks)).toBe('inconclusive');
  expect(result.checks.find(check => check.id === 'limits.venice.credit')?.status).toBe('skip');
  expect(result.checks.find(check => check.id === 'limits.venice.credit')?.detail).toContain('Inconclusive:');
  expect(renderLimits(result.rows)).toContain('inconclusive');
  expect(renderLimits(result.rows)).toContain('has not confirmed canConsume=true');
  expect(r.marker()).toBe(false); // Still present after the failed refill; finally removes it.
}, 30_000);

for (const [fault, check, detail] of [
  ['missing-venice', 'venice.credit', 'venice.credit never appeared within 90 seconds'],
  ['restart', 'judge.daily_calls', 'engine or judge worker restarted'],
  ['no-credential-restart', 'venice.credit', 'engine or judge worker restarted'],
  ['wrong-home', 'judge.daily_calls', 'Home did not show the same limit and continuation'],
  ['refill-failed', 'venice.credit', 'Refill did not return ok:true'],
  ['marker-remains', 'venice.credit', 'Refill left its pause marker'],
  ['command-error', 'judge.daily_calls', 'machine or dashboard operation failed'],
] as const) test(`limits rejects ${fault} and cleans up`, async () => {
  const r = rig(fault);
  const result = await runFreshLimits(r.machine, r.options);
  expect(result.checks.find(c => c.id === `limits.${check}`)).toMatchObject({ status: 'fail', detail });
  expect(result.rows.find(row => row.id === check)?.status).toBe('fail');
  expect(r.closed()).toBe(true); expect(r.marker()).toBe(false);
  expect(JSON.stringify(result)).not.toContain('Secret title');
}, 30_000);

test('default CLI and Home readers use machine exec on the owner socket', async () => {
  const r = rig();
  const { exec, dashboard, ...options } = r.options;
  const result = await runFreshLimits(r.machine, options);
  expect(result.checks.every(check => check.status === 'pass')).toBe(true);
  expect(r.commands).toContain(LIMITS_HOME);
}, 30_000);

test('limits refuses an existing machine before executing anything', async () => {
  const r = rig();
  const { disposable, ...existing } = r.machine;
  const result = await runFreshLimits(existing, r.options);
  expect(result.checks).toEqual([{ id: 'limits.setup', title: 'limits: setup', status: 'fail', detail: 'requires a throwaway machine from driver provision', ms: 0 }]);
  expect(r.events).toEqual([]); expect(r.commands).toEqual([]);
}, 30_000);
