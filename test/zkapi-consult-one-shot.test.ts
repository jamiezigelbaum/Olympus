// OLYMPUS_TEST_LANE: deploy
// Processes start in the transport under test (fake Tor and daemon), not in this file.
// zkAPI consult transport tests; shared fixture in ./helpers/zkapi-transport-harness.ts.
import { describe, expect, test } from 'bun:test';
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  openZkapiConsultSession,
  recoverZkapiSession,
  sendZkapiConsult,
  zkapiUnresolvedSession,
  zkapiUsageToday,
  type ZkapiConsultReply,
  type ZkapiConsultResult,
} from '../src/core/consult-transport-zkapi.ts';
import {
  QUESTION,
  NOW,
  SLOW,
  configDir,
  statePath,
  daemonPort,
  torPort,
  writePlan,
  events,
  torRuns,
  completions,
  settings,
  transport,
  portFree,
  TRANSPORT_MODULE,
  runConsultInChildProcess,
  alive,
  NO_CONFINEMENT_LABEL,
  ledger,
  expectNothingReserved,
  expectProcessesGone,
  openReady,
  settledFlag,
  useZkapiHarness,
} from './helpers/zkapi-transport-harness.ts';

useZkapiHarness();

describe('zkAPI consult transport: one-shot session', () => {
  test('open warms the route and reserves nothing; cancel before send tears down and releases the lease', async () => {
    const session = await openReady();
    expect(session.state).toBe('ready');
    // The route is warm: Tor and the daemon are up, the policy is listed.
    expect(events().some((line) => line.startsWith('serve '))).toBe(true);
    expect(await portFree(daemonPort)).toBe(false);
    expect(completions()).toEqual([]);
    expectNothingReserved();
    // The lease spans the open session: another open is busy.
    expect(await openZkapiConsultSession(transport())).toMatchObject({ ok: false, error: { code: 'busy', outcome: 'not_sent' } });
    session.cancel();
    const result = await session.finished;
    expect(result).toMatchObject({ ok: false, error: { code: 'aborted', outcome: 'not_sent', receipt: { fence: 'clear', settlement: 'no_lease' } } });
    expect(session.state).toBe('cancelled');
    expect(completions()).toEqual([]);
    expectNothingReserved();
    await expectProcessesGone();
    // Lifecycle receipts are allowed; the running record is gone and the lease
    // is released: the next consult runs.
    expect(ledger().running).toBeUndefined();
    expect(ledger().lastSession).toMatchObject({ result: 'aborted', fence: 'clear' });
    const stageMs = !result.ok ? result.error.receipt?.stageMs : undefined;
    expect(stageMs).toMatchObject({ warmTotalMs: expect.any(Number), teardownMs: expect.any(Number), totalMs: expect.any(Number) });
    expect(stageMs).not.toHaveProperty('replyHandedOverAtMs');
    expect(stageMs).not.toHaveProperty('reservationMs');
    expect(await sendZkapiConsult(QUESTION, transport())).toMatchObject({ ok: true });
    // A send after cancellation is refused without touching anything.
    expect(await session.send(QUESTION)).toMatchObject({ kind: 'failed', error: { code: 'session_spent', outcome: 'not_sent' } });
  }, SLOW);

  test('a caller signal during opening cancels at that await: nothing reserved, processes gone', async () => {
    writePlan({ startDelayMs: 1_500 });
    const controller = new AbortController();
    const pending = openZkapiConsultSession(transport(), { signal: controller.signal });
    while (torRuns().length === 0) await Bun.sleep(20);
    controller.abort();
    const opened = await pending;
    expect(opened).toMatchObject({ ok: false, error: { code: 'aborted', outcome: 'not_sent' } });
    expect(completions()).toEqual([]);
    expectNothingReserved();
    await expectProcessesGone();
    // Already cancelled before the lease: nothing starts at all.
    const early = new AbortController();
    early.abort();
    expect(await openZkapiConsultSession(transport(), { signal: early.signal })).toMatchObject({ ok: false, error: { code: 'aborted', outcome: 'not_sent' } });
    expect(torRuns()).toHaveLength(1);
  }, SLOW);

  test('an open deadline that passes refuses with timeout, nothing reserved, and the lease released', async () => {
    writePlan({ startDelayMs: 2_000 });
    const opened = await openZkapiConsultSession(transport(), { deadlineMs: 400 });
    expect(opened).toMatchObject({ ok: false, error: { code: 'timeout', outcome: 'not_sent', receipt: { fence: 'clear', stageMs: { totalMs: expect.any(Number) } } } });
    expect(completions()).toEqual([]);
    expectNothingReserved();
    await expectProcessesGone();
    writePlan({ startDelayMs: 0 });
    const next = await openZkapiConsultSession(transport(), { deadlineMs: 20_000 });
    expect(next.ok).toBe(true);
    if (next.ok) {
      next.session.cancel();
      await next.session.finished;
    }
  }, SLOW);

  test('the reply is handed over before settlement, pending and fenced; finished settles and clears the fence', async () => {
    writePlan({ settleDelayMs: 1_500 });
    const session = await openReady();
    const finishedFlag = settledFlag(session.finished);
    const reply = await session.send(QUESTION);
    expect(reply).toMatchObject({
      kind: 'reply',
      text: 'Generally, notice scales with term length.',
      providerVerification: 'verified',
      networkIdentity: 'not_verified',
      routeLabel: `${NO_CONFINEMENT_LABEL}; lease settlement pending`,
      receipt: { settlement: 'pending', fence: 'held', reservedUsd: 1, postStopProbe: 'not_run' },
    });
    expect(session.state).toBe('replied');
    // At hand-over the money is still fenced and the session still owns its processes.
    expect(finishedFlag()).toBe(false);
    expect(zkapiUnresolvedSession(statePath)).toBe(true);
    expect(await portFree(daemonPort)).toBe(false);
    const replyStages = reply.kind === 'reply' ? reply.receipt.stageMs! : {};
    for (const key of ['warmTotalMs', 'reservationMs', 'replyHandedOverAtMs'] as const) expect(typeof replyStages[key]).toBe('number');
    expect(replyStages).not.toHaveProperty('settlementWaitMs');
    expect(replyStages).not.toHaveProperty('totalMs');
    // The one-shot refuses a second send while the first is settling.
    expect(await session.send(QUESTION)).toMatchObject({ kind: 'failed', error: { code: 'session_spent', outcome: 'not_sent' } });
    const result = await session.finished;
    expect(result).toMatchObject({
      ok: true,
      text: 'Generally, notice scales with term length.',
      routeLabel: NO_CONFINEMENT_LABEL,
      receipt: { settlement: 'confirmed', fence: 'clear', postStopProbe: 'route_lost', reservedUsd: 1 },
    });
    expect(session.state).toBe('finished');
    expect(zkapiUnresolvedSession(statePath)).toBe(false);
    expect(zkapiUsageToday(statePath, NOW)).toEqual({ count: 1, reservedMicroUsd: 1_000_000 });
    const stageMs = result.ok ? result.receipt.stageMs! : {};
    expect(stageMs.replyHandedOverAtMs).toBe(replyStages.replyHandedOverAtMs!);
    expect(stageMs.warmTotalMs).toBe(replyStages.warmTotalMs!);
    expect(stageMs.settlementWaitMs).toBeGreaterThanOrEqual(1_000);
    expect(stageMs.totalMs).toBeGreaterThan(stageMs.replyHandedOverAtMs!);
    expect(ledger().lastSession).toMatchObject({ result: 'ok', settlement: 'confirmed', fence: 'clear', stageMs: { replyHandedOverAtMs: stageMs.replyHandedOverAtMs } });
    // Reserved and fenced before the daemon saw the request.
    expect(completions()[0]).toMatchObject({ countAtArrival: 1, fenceAtArrival: true });
    await expectProcessesGone();
    expect(await session.send(QUESTION)).toMatchObject({ kind: 'failed', error: { code: 'session_spent' } });
  }, SLOW);

  test('a caller cancel after dispatch detaches the caller; the session keeps the reply, settles and clears the fence', async () => {
    writePlan({ completion: 'held', settleDelayMs: 800 });
    const session = await openReady();
    const controller = new AbortController();
    const pending = session.send(QUESTION, { signal: controller.signal });
    while (completions().length === 0) await Bun.sleep(20);
    expect(session.state).toBe('dispatched');
    controller.abort();
    expect(await pending).toMatchObject({ kind: 'failed', error: { code: 'aborted', outcome: 'unknown', receipt: { settlement: 'pending', fence: 'held' } } });
    // The fetch was not aborted: the daemon still holds the request until released.
    await Bun.sleep(200);
    expect(zkapiUnresolvedSession(statePath)).toBe(true);
    writeFileSync(join(configDir, 'release'), '');
    expect(await session.finished).toMatchObject({ ok: true, text: 'held', receipt: { settlement: 'confirmed', fence: 'clear' } });
    expect(zkapiUnresolvedSession(statePath)).toBe(false);
    expect(completions()).toHaveLength(1);
    await expectProcessesGone();
  }, SLOW);

  test('session.cancel after dispatch is the same detachment, and the open signal is detached too', async () => {
    writePlan({ completion: 'held', settleDelayMs: 300 });
    const openController = new AbortController();
    const opened = await openZkapiConsultSession(transport(), { signal: openController.signal });
    if (!opened.ok) throw new Error(opened.error.code);
    const pending = opened.session.send(QUESTION);
    while (completions().length === 0) await Bun.sleep(20);
    openController.abort();
    opened.session.cancel();
    expect(await pending).toMatchObject({ kind: 'failed', error: { code: 'aborted', outcome: 'unknown' } });
    writeFileSync(join(configDir, 'release'), '');
    expect(await opened.session.finished).toMatchObject({ ok: true, receipt: { settlement: 'confirmed', fence: 'clear' } });
  }, SLOW);

  test('a process that dies after dispatch holds the fence; recovery is needed', async () => {
    writePlan({ crashAfterCompletion: true, settleDelayMs: 2_000 });
    const session = await openReady({ settings: settings({ settleTimeoutMs: 3_000 }) });
    const reply = await session.send(QUESTION);
    expect(reply).toMatchObject({ kind: 'reply', receipt: { settlement: 'pending', fence: 'held' } });
    expect(await session.finished).toMatchObject({
      ok: false,
      error: { code: 'session_process_exited', outcome: 'unknown', receipt: { settlement: 'not_confirmed', fence: 'held' } },
    });
    expect(zkapiUnresolvedSession(statePath)).toBe(true);
    expect(ledger().running).toBeUndefined();
    await expectProcessesGone();
    expect(await openZkapiConsultSession(transport())).toMatchObject({ ok: false, error: { code: 'unresolved_session', outcome: 'not_sent' } });
    writePlan({ crashAfterCompletion: false, settleDelayMs: 30 });
    expect(await recoverZkapiSession(transport())).toMatchObject({ ok: true, receipt: { recovery: true, settlement: 'confirmed', fence: 'clear' } });
  }, SLOW);

  test('a process that dies while the session is ready ends it with nothing reserved', async () => {
    const session = await openReady();
    writeFileSync(join(configDir, 'kill-tor'), '');
    expect(await session.finished).toMatchObject({ ok: false, error: { code: 'session_process_exited', outcome: 'not_sent' } });
    expectNothingReserved();
    await expectProcessesGone();
    expect(await session.send(QUESTION)).toMatchObject({ kind: 'failed', error: { code: 'session_spent' } });
  }, SLOW);

  test('two concurrent opens: the second is busy in this process and across processes', async () => {
    const first = await openReady();
    expect(await openZkapiConsultSession(transport())).toMatchObject({ ok: false, error: { code: 'busy', outcome: 'not_sent' } });
    // Another process over the same ledger cannot take the session lease either.
    expect(await runConsultInChildProcess({ ...transport() })).toEqual({ ok: false, code: 'busy' });
    expect(completions()).toEqual([]);
    first.cancel();
    await first.finished;
    const second = await openReady();
    second.cancel();
    await second.finished;
    expect(torRuns()).toHaveLength(2);
  }, 60_000);

  test('final authorization runs at the last boundary: a refusal reserves nothing; it sees the session signal', async () => {
    const session = await openReady();
    let seenSignal: AbortSignal | undefined;
    const result = await session.send(QUESTION, {
      authorize: async (signal) => {
        seenSignal = signal;
        // Nothing is reserved while the caller decides.
        expectNothingReserved();
        return false;
      },
    });
    expect(result).toMatchObject({ kind: 'failed', error: { code: 'authorization_refused', outcome: 'not_sent', receipt: { fence: 'clear' } } });
    expect(seenSignal?.aborted).toBe(false);
    expect(await session.finished).toMatchObject({ ok: false, error: { code: 'authorization_refused', outcome: 'not_sent' } });
    expect(completions()).toEqual([]);
    expectNothingReserved();
    await expectProcessesGone();
    expect(ledger().lastSession).toMatchObject({ result: 'authorization_refused', fence: 'clear' });
    // An authorization that approves dispatches once: reserved and fenced before the daemon sees it.
    const approved = await openReady();
    const reply = await approved.send(QUESTION, { authorize: () => true });
    expect(reply).toMatchObject({ kind: 'reply', receipt: { settlement: 'pending' } });
    expect(await approved.finished).toMatchObject({ ok: true, receipt: { settlement: 'confirmed', fence: 'clear' } });
    expect(completions()).toHaveLength(1);
    expect(completions()[0]).toMatchObject({ countAtArrival: 1, fenceAtArrival: true });
  }, SLOW);

  test('a cancel, a send deadline or a throwing authorization during authorization reserves nothing', async () => {
    // Cancel while the caller's authorization is pending: cancel wins.
    const cancelled = await openReady();
    const cancelResult = await cancelled.send(QUESTION, {
      authorize: async (signal) => {
        cancelled.cancel();
        await Bun.sleep(50);
        expect(signal.aborted).toBe(true);
        return true;
      },
    });
    expect(cancelResult).toMatchObject({ kind: 'failed', error: { code: 'aborted', outcome: 'not_sent' } });
    expectNothingReserved();
    // The send deadline passes while authorization is slow.
    const late = await openReady();
    const lateResult = await late.send(QUESTION, { deadlineMs: 200, authorize: async () => { await Bun.sleep(600); return true; } });
    expect(lateResult).toMatchObject({ kind: 'failed', error: { code: 'timeout', outcome: 'not_sent' } });
    expectNothingReserved();
    // An authorization that throws is an internal error, nothing reserved.
    const thrown = await openReady();
    expect(await thrown.send(QUESTION, { authorize: () => { throw new Error('policy /secret/path'); } }))
      .toMatchObject({ kind: 'failed', error: { code: 'internal_error', outcome: 'not_sent' } });
    expectNothingReserved();
    // A send signal already aborted cancels before any check.
    const aborted = new AbortController();
    aborted.abort();
    const early = await openReady();
    expect(await early.send(QUESTION, { signal: aborted.signal })).toMatchObject({ kind: 'failed', error: { code: 'aborted', outcome: 'not_sent' } });
    expectNothingReserved();
    expect(completions()).toEqual([]);
    await expectProcessesGone();
  }, 90_000);

  test('once fetchImpl is invoked every exception is an unknown dispatch: a call-through-then-throw keeps the fence', async () => {
    // An injected fetch may send the request and then throw synchronously.
    const callThroughThenThrow = ((input: string | URL | Request, init?: RequestInit) => {
      if (String(input).endsWith('/v1/chat/completions')) {
        void fetch(input, init).catch(() => undefined);
        throw new Error('threw after sending');
      }
      return fetch(input, init);
    }) as typeof fetch;
    writePlan({ settleDelayMs: 300 });
    const session = await openReady({ fetchImpl: callThroughThenThrow });
    expect(await session.send(QUESTION)).toMatchObject({ kind: 'failed', error: { code: 'transport_failed', outcome: 'unknown', receipt: { settlement: 'pending', fence: 'held', reservedUsd: 1 } } });
    const result = await session.finished;
    // The daemon did see the request; its settlement evidence is what clears the fence, never a rollback.
    while (completions().length === 0) await Bun.sleep(20);
    expect(result).toMatchObject({ ok: false, error: { code: 'transport_failed', outcome: 'unknown', receipt: { reservedUsd: 1 } } });
    expect(zkapiUsageToday(statePath, NOW)).toEqual({ count: 1, reservedMicroUsd: 1_000_000 });
    expect(ledger().lastSession).toMatchObject({ result: 'transport_failed', reservedUsd: 1 });
    // A fetch that throws without sending is indistinguishable from the above and is treated the same.
    const throwingFetch = ((input: string | URL | Request, init?: RequestInit) => {
      if (String(input).endsWith('/v1/chat/completions')) throw new Error('never left the process');
      return fetch(input, init);
    }) as typeof fetch;
    writePlan({ settleDelayMs: 30 });
    if (zkapiUnresolvedSession(statePath)) expect(await recoverZkapiSession(transport())).toMatchObject({ ok: true, receipt: { fence: 'clear' } });
    const countBefore = zkapiUsageToday(statePath, NOW).count;
    expect(await sendZkapiConsult(QUESTION, transport({ fetchImpl: throwingFetch }))).toMatchObject({
      ok: false,
      error: { code: 'transport_failed', outcome: 'unknown', receipt: { settlement: 'not_confirmed', fence: 'held', reservedUsd: 1 } },
    });
    expect(zkapiUsageToday(statePath, NOW).count).toBe(countBefore + 1);
    expect(zkapiUnresolvedSession(statePath)).toBe(true);
  }, 90_000);

  test('a hung authorization never holds the session: cancel and the send deadline win, a late answer never dispatches', async () => {
    const never = (): Promise<boolean> => new Promise(() => undefined);
    const cancelled = await openReady();
    const pendingCancel = cancelled.send(QUESTION, { authorize: never });
    await Bun.sleep(150);
    expect(cancelled.state).toBe('authorizing');
    cancelled.cancel();
    expect(await pendingCancel).toMatchObject({ kind: 'failed', error: { code: 'aborted', outcome: 'not_sent' } });
    expect(await cancelled.finished).toMatchObject({ ok: false, error: { code: 'aborted', outcome: 'not_sent' } });
    expectNothingReserved();
    const timed = await openReady();
    expect(await timed.send(QUESTION, { deadlineMs: 200, authorize: never })).toMatchObject({ kind: 'failed', error: { code: 'timeout', outcome: 'not_sent' } });
    expectNothingReserved();
    // A late approval, and a late rejection, after the race was lost change nothing.
    let approve!: (value: boolean) => void;
    let rejectLate!: (error: Error) => void;
    const late = await openReady();
    const pendingLate = late.send(QUESTION, { authorize: () => new Promise<boolean>((resolve, reject) => { approve = resolve; rejectLate = reject; }) });
    await Bun.sleep(100);
    late.cancel();
    expect(await pendingLate).toMatchObject({ kind: 'failed', error: { code: 'aborted', outcome: 'not_sent' } });
    await late.finished;
    approve(true);
    const rejecting = await openReady();
    const pendingReject = rejecting.send(QUESTION, { authorize: () => new Promise<boolean>((_resolve, reject) => { rejectLate = reject; }) });
    await Bun.sleep(100);
    rejecting.cancel();
    expect(await pendingReject).toMatchObject({ kind: 'failed', error: { code: 'aborted' } });
    await rejecting.finished;
    rejectLate(new Error('too late'));
    await Bun.sleep(50);
    expect(completions()).toEqual([]);
    expectNothingReserved();
    await expectProcessesGone();
  }, 90_000);

  test('the dispatch deadline is absolute: a synchronous overrun is caught after authorization and again before the fetch', async () => {
    const busyWait = (ms: number): void => {
      const until = performance.now() + ms;
      while (performance.now() < until) { /* hold the event loop */ }
    };
    // A synchronous authorization that overruns the deadline: no timer could
    // fire, so only the absolute check refuses it. Nothing reserved.
    const overrun = await openReady();
    expect(await overrun.send(QUESTION, { deadlineMs: 100, authorize: () => { busyWait(300); return true; } }))
      .toMatchObject({ kind: 'failed', error: { code: 'timeout', outcome: 'not_sent' } });
    expect(await overrun.finished).toMatchObject({ ok: false, error: { code: 'timeout', outcome: 'not_sent' } });
    expectNothingReserved();
    // The reservation itself consumes the remaining time: the fetch is
    // provably not invoked, so the reservation, count and fence roll back.
    let reserving = false;
    const slowLedger = transport({
      now: () => {
        if (reserving) {
          reserving = false;
          busyWait(400);
        }
        return NOW;
      },
    });
    const opened = await openZkapiConsultSession(slowLedger);
    if (!opened.ok) throw new Error(opened.error.code);
    expect(await opened.session.send(QUESTION, { deadlineMs: 200, authorize: () => { reserving = true; return true; } }))
      .toMatchObject({ kind: 'failed', error: { code: 'timeout', outcome: 'not_sent', receipt: { fence: 'clear' } } });
    expect(await opened.session.finished).toMatchObject({ ok: false, error: { code: 'timeout', outcome: 'not_sent', receipt: { fence: 'clear' } } });
    expect(ledger().lastSession).toMatchObject({ result: 'timeout', fence: 'clear' });
    expect(ledger().lastSession.reservedUsd).toBeUndefined();
    expectNothingReserved();
    expect(completions()).toEqual([]);
    await expectProcessesGone();
  }, 90_000);

  test('the deadline is captured inside send and checked at the last instant before fetch is invoked', async () => {
    const busyWait = (ms: number): void => {
      const until = performance.now() + ms;
      while (performance.now() < until) { /* hold the event loop */ }
    };
    // Event-loop delay between the send call and the machine resuming counts:
    // the deadline was captured synchronously inside send.
    const blocked = await openReady();
    const pending = blocked.send(QUESTION, { deadlineMs: 100 });
    busyWait(300);
    expect(await pending).toMatchObject({ kind: 'failed', error: { code: 'timeout', outcome: 'not_sent' } });
    expect(await blocked.finished).toMatchObject({ ok: false, error: { code: 'timeout', outcome: 'not_sent' } });
    expectNothingReserved();
    // The stage clock sample taken just before the fetch overruns the deadline:
    // the fetch is not invoked, and the reservation rolls back.
    let armed = false;
    const slowClock = transport({
      clock: () => {
        if (armed) {
          armed = false;
          busyWait(400);
        }
        return performance.now();
      },
    });
    const opened = await openZkapiConsultSession(slowClock);
    if (!opened.ok) throw new Error(opened.error.code);
    const result = await opened.session.send(QUESTION, { deadlineMs: 200, authorize: () => { armed = true; return true; } });
    expect(result).toMatchObject({ kind: 'failed', error: { code: 'timeout', outcome: 'not_sent', receipt: { fence: 'clear' } } });
    expect(await opened.session.finished).toMatchObject({ ok: false, error: { code: 'timeout', outcome: 'not_sent', receipt: { fence: 'clear' } } });
    expect(ledger().lastSession).toMatchObject({ result: 'timeout', fence: 'clear' });
    expect(ledger().lastSession.reservedUsd).toBeUndefined();
    // The dispatch stage was opened but no fetch followed it.
    expect(ledger().lastSession.stageMs).toHaveProperty('dispatchToFirstByteMs');
    expectNothingReserved();
    expect(completions()).toEqual([]);
    await expectProcessesGone();
  }, 90_000);

  test('a ready session nobody sends on ends itself after the ready timeout, nothing reserved', async () => {
    const opened = await openZkapiConsultSession(transport(), { readyTimeoutMs: 400 });
    if (!opened.ok) throw new Error(opened.error.code);
    expect(opened.session.state).toBe('ready');
    expect(await opened.session.finished).toMatchObject({ ok: false, error: { code: 'timeout', outcome: 'not_sent' } });
    expect(opened.session.state).toBe('cancelled');
    expectNothingReserved();
    await expectProcessesGone();
    expect(await opened.session.send(QUESTION)).toMatchObject({ kind: 'failed', error: { code: 'session_spent' } });
    // The lease is free again.
    const next = await openReady();
    next.cancel();
    await next.finished;
  }, SLOW);

  test('a supervisor killed between the early reply and settlement leaves the running record and the fence; reopening is refused until recovery', async () => {
    writePlan({ settleDelayMs: 20_000 });
    const { now: _now, confinement: _confinement, ...plain } = transport();
    const script = `
      const { openZkapiConsultSession } = await import(${JSON.stringify(TRANSPORT_MODULE)});
      const options = JSON.parse(process.argv[1]);
      options.now = () => new Date(${JSON.stringify(NOW.toISOString())});
      options.confinement = { level: 'none', limit: 'none', wrap: (argv) => [...argv], selfTest: async () => false };
      const opened = await openZkapiConsultSession(options);
      if (!opened.ok) { console.log('open-failed ' + opened.error.code); process.exit(1); }
      const reply = await opened.session.send(${JSON.stringify(QUESTION)});
      console.log('reply ' + reply.kind);
      await opened.session.finished;
    `;
    const child = spawn(process.execPath, ['-e', script, JSON.stringify(plain)], { stdio: ['ignore', 'pipe', 'ignore'] });
    try {
      const line = await new Promise<string>((resolve) => child.stdout!.on('data', (chunk) => resolve(String(chunk).trim())));
      expect(line).toBe('reply reply');
      child.kill('SIGKILL');
      while (alive(child.pid!)) await Bun.sleep(20);
      // The ledger still names the session and the fence is held: the money is still fenced.
      expect(ledger().running).toBeDefined();
      expect(zkapiUnresolvedSession(statePath)).toBe(true);
      expect(zkapiUsageToday(statePath, NOW)).toEqual({ count: 1, reservedMicroUsd: 1_000_000 });
      // The watchdogs follow their supervisor; once they are gone an ordinary
      // reopen clears the stale record but is refused by the fence.
      const deadline = Date.now() + 15_000;
      while ((!await portFree(daemonPort) || !await portFree(torPort)) && Date.now() < deadline) await Bun.sleep(100);
      expect(await openZkapiConsultSession(transport())).toMatchObject({ ok: false, error: { code: 'unresolved_session', outcome: 'not_sent', receipt: { fence: 'held' } } });
      expect(ledger().running).toBeUndefined();
      writePlan({ settleDelayMs: 30 });
      expect(await recoverZkapiSession(transport())).toMatchObject({ ok: true, receipt: { recovery: true, settlement: 'confirmed', fence: 'clear' } });
      expect(zkapiUnresolvedSession(statePath)).toBe(false);
    } finally {
      child.kill('SIGKILL');
    }
  }, 90_000);

  test('a completion failure is handed over before settlement too, and finished carries the settled receipt', async () => {
    writePlan({ completion: 'error' });
    const session = await openReady();
    const reply = await session.send(QUESTION);
    expect(reply).toMatchObject({
      kind: 'failed',
      error: { code: 'daemon_error', daemonCode: 'model_budget_unavailable', httpStatus: 400, outcome: 'sent_failed', receipt: { settlement: 'pending', fence: 'held' } },
    });
    expect(await session.finished).toMatchObject({
      ok: false,
      error: { code: 'daemon_error', daemonCode: 'model_budget_unavailable', outcome: 'sent_failed', receipt: { settlement: 'no_lease', fence: 'clear' } },
    });
    expect(JSON.stringify(reply)).not.toContain('notice period');
  }, SLOW);

  test('an invalid question is refused without spending the one shot', async () => {
    const session = await openReady();
    expect(await session.send('')).toMatchObject({ kind: 'failed', error: { code: 'invalid_question', outcome: 'not_sent' } });
    expect(session.state).toBe('ready');
    expect(await session.send(QUESTION)).toMatchObject({ kind: 'reply' });
    expect(await session.finished).toMatchObject({ ok: true });
  }, SLOW);

  test('sendZkapiConsult is open, send and finished: the same receipts on success and failure paths', async () => {
    const strip = (result: ZkapiConsultResult): unknown => {
      const copy = JSON.parse(JSON.stringify(result)) as { ok: boolean; receipt?: { stageMs?: unknown }; error?: { receipt?: { stageMs?: unknown } }; elapsedMs?: number };
      delete copy.receipt?.stageMs;
      delete copy.error?.receipt?.stageMs;
      delete copy.elapsedMs;
      return copy;
    };
    const viaSession = async (): Promise<ZkapiConsultResult> => {
      const session = await openReady();
      await session.send(QUESTION);
      return session.finished;
    };
    expect(strip(await sendZkapiConsult(QUESTION, transport()))).toEqual(strip(await viaSession()));
    expect(ledger().lastSession.stageMs).toMatchObject({ warmTotalMs: expect.any(Number), replyHandedOverAtMs: expect.any(Number), totalMs: expect.any(Number) });
    writePlan({ completion: 'error' });
    const failed = await sendZkapiConsult(QUESTION, transport());
    expect(failed).toMatchObject({ ok: false, error: { code: 'daemon_error', outcome: 'sent_failed', receipt: { settlement: 'no_lease', fence: 'clear' } } });
    expect(strip(failed)).toEqual(strip(await viaSession()));
    // Every path records the warm total; only a reply records when it was handed over.
    const last = ledger().lastSession;
    expect(last.stageMs).toMatchObject({ warmTotalMs: expect.any(Number), totalMs: expect.any(Number) });
    expect(last.stageMs).not.toHaveProperty('replyHandedOverAtMs');
  }, 120_000);

  test('the reply type is the same text the finished result carries; nothing is resent', async () => {
    const urls: string[] = [];
    const recordingFetch = (async (input: string | URL | Request, init?: RequestInit) => {
      urls.push(String(input));
      return fetch(input, init);
    }) as typeof fetch;
    const session = await openReady({ fetchImpl: recordingFetch });
    const reply: ZkapiConsultReply = await session.send(QUESTION);
    const result = await session.finished;
    expect(reply.kind === 'reply' && result.ok && reply.text === result.text).toBe(true);
    expect(urls.filter((url) => url.endsWith('/v1/chat/completions'))).toHaveLength(1);
  }, SLOW);
});
