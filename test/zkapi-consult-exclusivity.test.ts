// zkAPI consult transport tests; shared fixture in ./helpers/zkapi-transport-harness.ts.
import { describe, expect, test } from 'bun:test';
import { execFileSync, spawn } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  reserveZkapiRequest,
  sendZkapiConsult,
  zkapiUnresolvedSession,
  zkapiUsageToday,
} from '../src/core/consult-transport-zkapi.ts';
import { processInstanceIdentity } from '../src/core/file-lease.ts';
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
  completions,
  settings,
  transport,
  portFree,
  startConsultInChildProcess,
  runConsultInChildProcess,
  alive,
  ledger,
  useZkapiHarness,
} from './helpers/zkapi-transport-harness.ts';

useZkapiHarness();

describe('zkAPI consult transport: exclusivity, processes, caps', () => {
  test('a second consult while one is in flight is refused as busy', async () => {
    writePlan({ completion: 'held' });
    const first = sendZkapiConsult(QUESTION, transport());
    while (completions().length === 0) await Bun.sleep(20);
    expect(await sendZkapiConsult(QUESTION, transport())).toMatchObject({ ok: false, error: { code: 'busy', outcome: 'not_sent' } });
    writeFileSync(join(configDir, 'release'), '');
    expect(await first).toMatchObject({ ok: true, text: 'held' });
    expect(completions()).toHaveLength(1);
  }, SLOW);

  test('the session lease excludes a separate process holding it', async () => {
    const holder = spawn(process.execPath, [
      '-e',
      `const { withFileLease } = await import(${JSON.stringify(join(import.meta.dir, '..', 'src', 'core', 'file-lease.ts'))});
       await withFileLease(${JSON.stringify(`${statePath}.session`)}, async () => { console.log('held'); await new Promise(() => {}); });`,
    ], { stdio: ['ignore', 'pipe', 'ignore'] });
    try {
      await new Promise<void>((resolve) => holder.stdout!.on('data', (chunk) => { if (String(chunk).includes('held')) resolve(); }));
      expect(await sendZkapiConsult(QUESTION, transport())).toMatchObject({ ok: false, error: { code: 'busy' } });
      expect(events()).toEqual([]);
    } finally {
      holder.kill('SIGKILL');
    }
  }, SLOW);

  test('a separate process\'s consult counts toward an owner-set limit in this one', async () => {
    const limited = settings({ dailyRequestCap: 2 });
    const result = await runConsultInChildProcess({ ...transport({ settings: limited }) });
    expect(result).toEqual({ ok: true });
    expect(await sendZkapiConsult(QUESTION, transport({ settings: limited }))).toMatchObject({ ok: true });
    expect(await sendZkapiConsult(QUESTION, transport({ settings: limited }))).toMatchObject({ ok: false, error: { code: 'daily_cap_reached' } });
    expect(completions()).toHaveLength(2);
  }, 60_000);

  test('a supervisor killed mid-consult leaves no process behind, even one that ignores SIGTERM', async () => {
    writePlan({ completion: 'held', companion: true });
    const child = startConsultInChildProcess({ ...transport() });
    try {
      while (completions().length === 0) await Bun.sleep(50);
      const daemonPid = Number(events().find((line) => line.startsWith('serve '))!.split(' ')[1]);
      const companion = Number(events().find((line) => line.startsWith('companion '))!.split(' ')[1]);
      expect(alive(daemonPid) && alive(companion)).toBe(true);
      child.kill('SIGKILL');
      const deadline = Date.now() + 15_000;
      while ((alive(daemonPid) || alive(companion)) && Date.now() < deadline) await Bun.sleep(100);
      expect(alive(daemonPid)).toBe(false);
      expect(alive(companion)).toBe(false);
      expect(await portFree(torPort)).toBe(true);
    } finally {
      child.kill('SIGKILL');
    }
  }, 60_000);

  test('a session whose processes cannot be proven ours at teardown fails, is never signalled, and blocks the next', async () => {
    writePlan({ completion: 'held' });
    const pending = sendZkapiConsult(QUESTION, transport({ settings: settings({ timeoutMs: 30_000 }) }));
    while (completions().length === 0) await Bun.sleep(20);
    const daemonPid = Number(events().find((line) => line.startsWith('serve '))!.split(' ')[1]);
    const watchdogPid = Number(execFileSync('/bin/ps', ['-o', 'pgid=', '-p', String(daemonPid)], { encoding: 'utf8' }).trim());
    try {
      // The group's leader disappears without its members: its id can no
      // longer be proven ours, so nothing may signal it.
      process.kill(watchdogPid, 'SIGKILL');
      expect(await pending).toMatchObject({ ok: false, error: { code: 'teardown_incomplete' } });
      expect(alive(daemonPid)).toBe(true);
      expect(JSON.parse(readFileSync(statePath, 'utf8')).running).toBeDefined();
      expect(JSON.parse(readFileSync(statePath, 'utf8')).lastSession.result).toBe('teardown_incomplete');
      expect(await sendZkapiConsult(QUESTION, transport())).toMatchObject({ ok: false, error: { code: 'stranded_processes' } });
    } finally {
      try { process.kill(daemonPid, 'SIGKILL'); } catch {}
    }
  }, 60_000);

  test('a live group whose leader is gone is never signalled: ownership cannot be proven', async () => {
    const orphanMaker = spawn(process.execPath, [
      '-e',
      `const { spawn } = require('node:child_process');
       const member = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1 << 30)'], { stdio: 'ignore' });
       console.log(member.pid); setTimeout(() => process.exit(0), 100);`,
    ], { stdio: ['ignore', 'pipe', 'ignore'], detached: true });
    const memberPid = Number(await new Promise<string>((resolve) => orphanMaker.stdout!.once('data', (chunk) => resolve(String(chunk).trim()))));
    while (alive(orphanMaker.pid!)) await Bun.sleep(20);
    try {
      writeFileSync(statePath, JSON.stringify({
        version: 1,
        day: '2026-10-05',
        count: 0,
        reservedMicroUsd: 0,
        running: {
          sessionId: 'earlier',
          supervisor: { pid: 999_999 },
          groups: [{ role: 'daemon', pgid: orphanMaker.pid!, leader: processInstanceIdentity(process.pid) }],
        },
      }));
      expect(await sendZkapiConsult(QUESTION, transport())).toMatchObject({ ok: false, error: { code: 'stranded_processes' } });
      expect(alive(memberPid)).toBe(true);
      expect(JSON.parse(readFileSync(statePath, 'utf8')).running).toBeDefined();
    } finally {
      process.kill(memberPid, 'SIGKILL');
    }
  }, SLOW);

  test('a stranded group is stopped only once its supervisor is proven dead, and a live supervisor is never preempted', async () => {
    const supervisor = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1 << 30)'], { stdio: 'ignore' });
    const strandedGroup = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1 << 30)'], { stdio: 'ignore', detached: true });
    try {
      const record = (supervisorPid: number) => ({
        version: 1,
        day: '2026-10-05',
        count: 0,
        reservedMicroUsd: 0,
        running: {
          sessionId: 'earlier',
          supervisor: { pid: supervisorPid, instance: processInstanceIdentity(supervisorPid) },
          groups: [{ role: 'daemon', pgid: strandedGroup.pid!, leader: processInstanceIdentity(strandedGroup.pid!) }],
        },
      });
      writeFileSync(statePath, JSON.stringify(record(supervisor.pid!)));
      expect(await sendZkapiConsult(QUESTION, transport())).toMatchObject({ ok: false, error: { code: 'busy' } });
      expect(alive(strandedGroup.pid!)).toBe(true);
      supervisor.kill('SIGKILL');
      while (alive(supervisor.pid!)) await Bun.sleep(20);
      expect(await sendZkapiConsult(QUESTION, transport())).toMatchObject({ ok: true });
      expect(alive(strandedGroup.pid!)).toBe(false);
    } finally {
      supervisor.kill('SIGKILL');
      strandedGroup.kill('SIGKILL');
    }
  }, SLOW);

  test('a recorded leader from another boot is never signalled', async () => {
    const live = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1 << 30)'], { stdio: 'ignore', detached: true });
    try {
      const identity = processInstanceIdentity(live.pid!);
      if (!identity?.bootId) return; // this platform reports no boot identity
      writeFileSync(statePath, JSON.stringify({
        version: 1,
        day: '2026-10-05',
        count: 0,
        reservedMicroUsd: 0,
        running: {
          sessionId: 'earlier',
          supervisor: { pid: 999_999 },
          groups: [{ role: 'daemon', pgid: live.pid!, leader: { ...identity, bootId: 'another-boot' } }],
        },
      }));
      expect(await sendZkapiConsult(QUESTION, transport())).toMatchObject({ ok: true });
      expect(alive(live.pid!)).toBe(true);
    } finally {
      live.kill('SIGKILL');
    }
  }, SLOW);

  test('a daemon that crashes after answering fails the session, holds the fence, and leaves no descendant', async () => {
    writePlan({ companion: true, crashAfterCompletion: true, settleDelayMs: 2_000 });
    expect(await sendZkapiConsult(QUESTION, transport({ settings: settings({ settleTimeoutMs: 3_000 }) }))).toMatchObject({
      ok: false,
      error: { code: 'session_process_exited', outcome: 'unknown', receipt: { fence: 'held' } },
    });
    const companion = Number(events().find((line) => line.startsWith('companion '))!.split(' ')[1]);
    expect(alive(companion)).toBe(false);
    expect(zkapiUnresolvedSession(statePath)).toBe(true);
    expect(JSON.parse(readFileSync(statePath, 'utf8')).running).toBeUndefined();
  }, SLOW);

  test('a Tor client that dies while a consult is in flight ends it at once with a typed failure', async () => {
    writePlan({ completion: 'held' });
    const pending = sendZkapiConsult(QUESTION, transport({ settings: settings({ timeoutMs: 30_000 }) }));
    while (completions().length === 0) await Bun.sleep(20);
    const killedAt = Date.now();
    writeFileSync(join(configDir, 'kill-tor'), '');
    expect(await pending).toMatchObject({ ok: false, error: { code: 'session_process_exited', outcome: 'unknown', receipt: { fence: 'held' } } });
    expect(Date.now() - killedAt).toBeLessThan(15_000);
    expect(zkapiUnresolvedSession(statePath)).toBe(true);
  }, SLOW);

  test('a failed consult is never resent, and nothing but the daemon is contacted', async () => {
    const urls: string[] = [];
    const recordingFetch = (async (input: string | URL | Request, init?: RequestInit) => {
      urls.push(String(input));
      return fetch(input, init);
    }) as typeof fetch;
    writePlan({ completion: 'garbage' });
    await sendZkapiConsult(QUESTION, transport({ fetchImpl: recordingFetch }));
    expect(urls.length).toBeGreaterThan(0);
    expect(urls.every((url) => url.startsWith(`http://127.0.0.1:${daemonPort}/`))).toBe(true);
    expect(urls.filter((url) => url.endsWith('/v1/chat/completions'))).toHaveLength(1);
    expect(completions()).toHaveLength(1);
  }, SLOW);

  test('no limit applies by default: many sequential consults are not refused by any cap', async () => {
    writePlan({ allowance: 1_000_000 });
    for (let index = 0; index < 11; index += 1) {
      expect(await sendZkapiConsult(QUESTION, transport())).toMatchObject({ ok: true, receipt: { listedAllowanceUsd: 1, reservedUsd: 1 } });
    }
    expect(completions()).toHaveLength(11);
    // Still recorded for disclosure: each consult counts its model's listed hold.
    expect(zkapiUsageToday(statePath, NOW)).toEqual({ count: 11, reservedMicroUsd: 11_000_000 });
  }, 120_000);

  test('an owner-set money limit refuses at the boundary across a restart, counting each consult at its listed hold', async () => {
    writePlan({ allowance: 1_000_000 });
    const limited = settings({ dailySpendCapUsd: 2 });
    expect(await sendZkapiConsult(QUESTION, transport({ settings: limited }))).toMatchObject({ ok: true });
    // A real second process over the same ledger stands in for a restart.
    expect(await runConsultInChildProcess({ ...transport({ settings: limited }) })).toEqual({ ok: true });
    expect(await sendZkapiConsult(QUESTION, transport({ settings: limited }))).toMatchObject({
      ok: false,
      error: { code: 'spend_cap_reached', outcome: 'not_sent' },
    });
    expect(completions()).toHaveLength(2);
    expect(zkapiUsageToday(statePath, NOW)).toEqual({ count: 2, reservedMicroUsd: 2_000_000 });
    // A $6-tier model does not fit a $7 limit after $2 is used; refused at the send, after warming.
    writePlan({ allowance: 6_000_000 });
    expect(await sendZkapiConsult(QUESTION, transport({ settings: settings({ dailySpendCapUsd: 7 }) }))).toMatchObject({
      ok: false,
      error: { code: 'spend_cap_reached', outcome: 'not_sent' },
    });
    expect(completions()).toHaveLength(2);
  }, 60_000);

  test('an owner-set request limit refuses at the boundary, and an ambiguous send counts toward it', async () => {
    writePlan({ completion: 'slow' });
    const limited = settings({ dailyRequestCap: 2, timeoutMs: 300 });
    expect(await sendZkapiConsult(QUESTION, transport({ settings: limited }))).toMatchObject({ ok: false, error: { code: 'timeout', outcome: 'unknown' } });
    writePlan({ completion: 'normal' });
    expect(await sendZkapiConsult(QUESTION, { ...transport({ settings: limited }) })).toMatchObject({ ok: true });
    expect(await sendZkapiConsult(QUESTION, transport({ settings: limited }))).toMatchObject({
      ok: false,
      error: { code: 'daily_cap_reached', outcome: 'not_sent' },
    });
    expect(completions()).toHaveLength(2);
    // The ledger is atomic across processes, and a new UTC day starts a new count.
    expect(reserveZkapiRequest(statePath, { requestCap: 2 }, NOW)).toEqual({ reserved: false, reason: 'daily_cap_reached' });
    expect(reserveZkapiRequest(statePath, { requestCap: 2 }, new Date('2026-10-06T00:00:01.000Z'))).toEqual({ reserved: true });
  }, SLOW);
});
