/** Release proof of a reported cost stop and one-step continuation, on driver-provisioned machines only. */
import type { Machine } from './machine.ts';
import type { CheckResult } from './report.ts';
import { openLimitsMachine } from './limits-machine.ts';

export interface LimitsClock { now(): number; sleep(ms: number): Promise<void> }
export interface LimitsStop {
  id: string; label: string; unit: string; limit: number | null; used: number | null; resumesAt?: string;
}
export interface LimitsHome {
  waits?: Array<{ reason?: string; limitLabel?: string; unit?: string; limit?: number | null; used?: number | null;
    resumesAt?: string; fix?: { label: string; tool: string; args: Record<string, unknown> } }>;
}
export interface LimitsSnapshot { pid: number; workerPids: number[]; calls: number }
export interface LimitsMachine {
  prepare(): Promise<void>;
  seed(): Promise<number>;
  snapshot(): Promise<LimitsSnapshot>;
  marker(action: 'write' | 'exists' | 'remove'): Promise<boolean>;
  hasVeniceCredential(): Promise<boolean>;
  close(): Promise<void>;
}
export interface LimitsRow {
  id: 'judge.daily_calls' | 'venice.credit';
  status: 'pass' | 'fail' | 'inconclusive';
  startedAt: string; ms: number; unit: 'calls' | 'usd';
  limit?: number; used?: number; callsAfter?: number; resumesAt?: string; reason?: string;
}
export interface LimitsResult { rows: LimitsRow[]; checks: CheckResult[] }
export interface FreshLimitsOptions {
  clock?: LimitsClock;
  /** Machine-free seams. The default adapter bundles its probe under /tmp. */
  diagnostics?: (machine: Machine, transport: Machine) => Promise<LimitsMachine>;
  exec?: (script: string) => Promise<string>;
  dashboard?: () => Promise<LimitsHome>;
}
const CLI = '"$HOME/.local/bin/olympus"';
export const LIMITS_HOME = `curl -fsS --max-time 10 --unix-socket "\${XDG_RUNTIME_DIR:-/run/user/$(id -u)}/olympus/worker.sock" -H @- 'http://127.0.0.1:8010/dashboard?panel-read' <<EOF
Authorization: Bearer $(${CLI} dashboard token)
EOF`;
/** Continue with room for the proof: above both the current limit and the calls already used today. */
export function judgeRaiseTarget(stop: Pick<LimitsStop, 'limit' | 'used'>): number {
  return Math.max(stop.limit ?? 0, stop.used ?? 0) + 50;
}
class Assertion extends Error {}
function assert(value: unknown, message: string): asserts value { if (!value) throw new Assertion(message); }
const REFILL_UNCONFIRMED = 'has not confirmed canConsume=true';

export async function runFreshLimits(machine: Machine, options: FreshLimitsOptions = {}, transport: Machine = machine): Promise<LimitsResult> {
  const result: LimitsResult = { rows: [], checks: [] };
  const clock = options.clock ?? { now: Date.now, sleep: (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)) };
  const exec = options.exec ?? (async (script: string) => {
    const reply = await machine.exec(`set -euo pipefail\n${script}`, { timeoutMs: 30_000 });
    assert(reply.code === 0 && !reply.timedOut, 'machine command failed');
    return reply.stdout;
  });
  const home = options.dashboard ?? (async () => {
    const reply = JSON.parse(await exec(machine.os === 'linux' ? LIMITS_HOME : LIMITS_HOME.replace(/ --unix-socket "[^"]+"/, '')));
    assert(!reply.isError && reply.structuredContent?.v === 1, 'Home view unavailable');
    return reply.structuredContent as LimitsHome;
  });
  const list = async (): Promise<LimitsStop[]> => {
    const value = JSON.parse(await exec(`${CLI} limits`));
    assert(Array.isArray(value.stops), 'limits list unavailable');
    return value.stops;
  };
  const poll = async <T>(read: () => Promise<T>, ready: (value: T) => boolean, bound: number, message: string): Promise<T> => {
    const deadline = clock.now() + bound;
    for (;;) {
      const value = await read();
      if (clock.now() <= deadline && ready(value)) return value;
      assert(clock.now() < deadline, message);
      await clock.sleep(Math.min(1000, deadline - clock.now()));
    }
  };
  let diagnostics: LimitsMachine | undefined;
  const check = async (id: string, action: () => Promise<void>) => {
    const started = clock.now();
    try { await action(); result.checks.push({ id: `limits.${id}`, title: `limits: ${id}`, status: 'pass', ms: clock.now() - started }); return true; }
    catch (error) {
      // Never forward machine output, paths, Home rows, item text or arbitrary exception messages.
      result.checks.push({ id: `limits.${id}`, title: `limits: ${id}`, status: 'fail',
        detail: error instanceof Assertion ? error.message : 'machine or dashboard operation failed', ms: clock.now() - started });
      return false;
    }
  };
  try {
    if (!await check('setup', async () => {
      assert(machine.disposable === true && transport.disposable === true, 'requires a throwaway machine from driver provision');
      diagnostics = await (options.diagnostics ?? openLimitsMachine)(machine, transport);
      await diagnostics.prepare();
      assert(await diagnostics.seed() >= 2, 'fewer than 2 synthetic judgment items seeded');
      await poll(() => diagnostics!.snapshot(), s => s.pid > 0 && s.workerPids.length > 0, 180_000, 'engine did not become ready');
    })) return result;
    const probe = diagnostics!;
    const unchanged = (before: LimitsSnapshot, after: LimitsSnapshot) => {
      assert(before.pid === after.pid && JSON.stringify(before.workerPids) === JSON.stringify(after.workerPids), 'engine or judge worker restarted');
    };
    const visible = async (stop: LimitsStop, action: 'Raise' | 'Refill') => poll(home, view => (view.waits ?? []).some(wait =>
      wait.reason === 'limit' && wait.limitLabel === stop.label && wait.unit === stop.unit && wait.limit === stop.limit && wait.used === stop.used
      && (action !== 'Raise' || wait.resumesAt === stop.resumesAt)
      && wait.fix?.label.startsWith(action) && wait.fix.tool === 'olympus_limits' && wait.fix.args.action === 'continue' && wait.fix.args.id === stop.id),
    30_000, 'Home did not show the same limit and continuation');
    const cleared = async (id: string, label: string) => {
      await poll(list, stops => !stops.some(stop => stop.id === id), 30_000, 'stop remained in limits');
      await poll(home, view => !(view.waits ?? []).some(wait => wait.fix?.args.id === id || wait.limitLabel === label), 30_000, 'stop remained on Home');
    };
    const judge: LimitsRow = { id: 'judge.daily_calls', status: 'fail', startedAt: new Date(clock.now()).toISOString(), ms: 0, unit: 'calls' };
    result.rows.push(judge);
    await check('judge.daily_calls', async () => {
      const before = await probe.snapshot();
      const stops = await poll(list, stops => stops.some(stop => stop.id === judge.id), 180_000, 'judge.daily_calls never appeared');
      const stop = stops.find(stop => stop.id === judge.id)!;
      assert(typeof stop.label === 'string' && stop.label.trim() && stop.unit === 'calls' && stop.limit === 1
        && Number.isFinite(stop.used) && stop.used! >= 1 && typeof stop.resumesAt === 'string' && Number.isFinite(Date.parse(stop.resumesAt)), 'judge stop lacks label, calls, limit 1, used calls or resumesAt');
      judge.limit = 1; judge.used = stop.used!; judge.resumesAt = stop.resumesAt;
      await visible(stop, 'Raise');
      // Earlier stages keep the day's count, so the target sits above what they already used.
      const reply = JSON.parse(await exec(`${CLI} limits continue judge.daily_calls --to ${judgeRaiseTarget(stop)}`));
      assert(reply.ok === true, 'Raise did not return ok:true');
      await cleared(judge.id, stop.label);
      const after = await poll(() => probe.snapshot(), s => s.calls > 1 && s.calls > before.calls, 180_000, 'Raise did not resume judge calls');
      unchanged(before, after);
      judge.callsAfter = after.calls; judge.status = 'pass';
    });
    judge.ms = clock.now() - Date.parse(judge.startedAt);

    const venice: LimitsRow = { id: 'venice.credit', status: 'fail', startedAt: new Date(clock.now()).toISOString(), ms: 0, unit: 'usd' };
    result.rows.push(venice);
    await check('venice.credit', async () => {
      const credential = await probe.hasVeniceCredential();
      await probe.marker('write');
      // Fresh items while Venice is stopped, so Refill has work to resume. Seeding restarts the engine,
      // so the no-restart window starts after it.
      assert(await probe.seed() >= 2, 'fewer than 2 synthetic judgment items seeded');
      const before = await poll(() => probe.snapshot(), s => s.pid > 0 && s.workerPids.length > 0, 180_000, 'engine did not become ready');
      const stops = await poll(list, stops => stops.some(stop => stop.id === venice.id), 90_000, 'venice.credit never appeared within 90 seconds');
      const stop = stops.find(stop => stop.id === venice.id)!;
      assert(typeof stop.label === 'string' && stop.label.includes('canConsume') && stop.unit === 'usd', 'Venice stop lacks its billing reason');
      await visible(stop, 'Refill');
      const reply = JSON.parse(await exec(`${CLI} limits continue venice.credit`));
      if (credential) {
        assert(reply.ok === true, 'Refill did not return ok:true');
        await cleared(venice.id, stop.label);
        assert(!await probe.marker('exists'), 'Refill left its pause marker');
        const after = await poll(() => probe.snapshot(), s => s.calls > before.calls, 180_000, 'Refill did not resume work');
        venice.callsAfter = after.calls;
      } else {
        assert(reply.ok === false && typeof reply.status_message === 'string' && reply.status_message.includes(REFILL_UNCONFIRMED), 'Refill without credentials did not report unconfirmed canConsume=true');
        assert((await list()).some(stop => stop.id === venice.id) && await probe.marker('exists'), 'unconfirmed refill cleared the stop or marker');
        await visible(stop, 'Refill');
        venice.reason = 'Venice billing has not confirmed canConsume=true; no Venice credential';
      }
      unchanged(before, await probe.snapshot());
      venice.status = credential ? 'pass' : 'inconclusive';
    });
    venice.ms = clock.now() - Date.parse(venice.startedAt);
    if (venice.status === 'inconclusive') {
      const check = result.checks.find(c => c.id === 'limits.venice.credit')!;
      check.status = 'skip'; check.detail = `Inconclusive: ${venice.reason}`;
    }
  } finally {
    if (diagnostics) await check('cleanup', async () => {
      try { await diagnostics!.marker('remove'); }
      finally { await diagnostics!.close(); }
    });
  }
  return result;
}
