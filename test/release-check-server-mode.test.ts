// The Mac server-mode leg (scripts/release-check/server-mode.ts, #778) against a stand-in Mac: what each step asks the machine, how
// each check reads the answers, that every wait is bounded on the clock it is given, and that a broken switch, a restart that never
// comes back or a key that still works after revoke fails the run. What only a real Mac VM shows is listed in the module's header.

import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import {
  DAEMON_PLIST, SECOND_ACCOUNT, SERVER_MODE_BOUNDS, SERVER_MODE_DONE, bootScript, dashboardServerMode, parseState, restartScript, runServerModeLeg,
  saveScript, secondAccountAskScript, secondAccountCleanupScript, secondAccountRevokeScript, secondAccountScript, standInInstallScript,
  standInRemoveScript, stateScript, type ServerModeClock, type ServerModeHost,
} from '../scripts/release-check/server-mode.ts';
import type { CheckResult } from '../scripts/release-check/report.ts';
import { createTestClock } from './helpers/test-clock.ts';

const OWNER = 'admin';
const URL = 'http://127.0.0.1:17841/mcp';
const STAGE = '/private/tmp/rc-agent.AbC123';
const KEY_ID = 'a'.repeat(18);
const KEEPER_ID = 'b'.repeat(18);

interface FakeMac {
  /** The stand-in for the password prompt works. */
  standIn: boolean;
  /** State polls the helper takes before it writes its final result; Infinity never finishes. */
  finishAfter: number;
  /** What the helper's final result says. */
  doneMessage?: (enable: boolean) => string;
  /** Turning on leaves the LaunchAgent (and its engine) behind. */
  agentLeftBehind: boolean;
  daemonOwner: string;
  daemonMode: string;
  /** /dashboard.json after a switch: a refusal like #777's email_policy_violation. */
  dashboardBroken: boolean;
  /** Boot polls that do not answer after a restart before the machine is back; Infinity never comes back. */
  downFor: number;
  keyWorks: boolean;
  noKeyCode: string;
  revokedCode: string;
  keeperCode: string;
}

const b64 = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString('base64');

function fakeMac(overrides: Partial<FakeMac> = {}) {
  const opts: FakeMac = {
    standIn: true, finishAfter: 2, agentLeftBehind: false, daemonOwner: 'root:wheel', daemonMode: '644', dashboardBroken: false, downFor: 3,
    keyWorks: true, noKeyCode: '401', revokedCode: '401', keeperCode: '200', ...overrides,
  };
  const steps: string[] = [];
  let mode: 'agent' | 'daemon' = 'agent';
  let launchAgent = true;
  let boot = 1_700_000_000;
  let down = 0;
  let pending: { enable: boolean; polls: number } | undefined;
  let result: { pending: boolean; message: string } | undefined;
  let switched = false;
  const line = (key: string, value: string | number): string => `${key}\t${value}\n`;
  const ok = (stdout: string) => ({ code: 0, stdout, stderr: '' });
  const state = (): string => {
    if (pending && ++pending.polls > opts.finishAfter) {
      const enable = pending.enable;
      mode = enable ? 'daemon' : 'agent';
      launchAgent = enable ? opts.agentLeftBehind : true;
      result = { pending: false, message: opts.doneMessage?.(enable) ?? SERVER_MODE_DONE[enable ? 'on' : 'off'] };
      pending = undefined;
    }
    const daemon = mode === 'daemon';
    let out = line('user', OWNER) + line('uid', 501);
    out += daemon ? line('daemon.present', 1) + line('daemon.owner', opts.daemonOwner) + line('daemon.mode', opts.daemonMode) + line('daemon.username', OWNER) : line('daemon.present', 0);
    out += line('agent.present', launchAgent ? 1 : 0);
    out += line('system.code', daemon ? 0 : 113) + line('system.state', daemon ? 'running' : '') + line('system.pid', daemon ? 300 : '');
    out += line('gui.code', launchAgent ? 0 : 113) + line('gui.state', launchAgent ? 'running' : '') + line('gui.pid', launchAgent ? 200 : '');
    const helper = 'admin 300 1 /Users/admin/Library/Application Support/Olympus/Olympus Engine.app/Contents/MacOS/OlympusEngineHost /x/bun --no-env-file /x/cli.js __engine-run';
    if (daemon) out += line('engine', helper) + line('engine', 'admin 301 300 /x/bun --no-env-file /x/cli.js __engine-run');
    if (launchAgent) out += line('engine', 'admin 201 200 /x/bun --no-env-file /x/cli.js __engine-run');
    if (result || pending) out += line('result', JSON.stringify(pending ? { pending: true, pid: 9, message: 'Your Mac will ask…' } : result));
    return out;
  };
  const host: ServerModeHost = {
    os: 'macos',
    exec: async (script) => {
      const step = /^# rc-server-mode: (\S+)/.exec(script)?.[1] ?? 'unknown';
      steps.push(step);
      switch (step) {
        case 'boot':
          if (down > 0) { down -= 1; if (down === 0) boot += 120; return { code: 255, stdout: '', stderr: 'ssh: connect timed out' }; }
          return ok(line('boot', boot) + line('console', OWNER) + line('user', OWNER) + line('gui', 0));
        case 'restart':
          down = opts.downFor;
          return ok(line('restart', 'requested'));
        case 'stand-in-install': return ok(line('saved', 0) + line('allowed', opts.standIn ? 0 : 1) + line('uid', opts.standIn ? '0' : 'execution error: not allowed (-60007)'));
        case 'stand-in-remove': return ok(line('restored', 0));
        case 'save-on': case 'save-off':
          pending = { enable: step === 'save-on', polls: 0 };
          switched = true;
          return ok(line('save.code', 200) + line('save.body', '{"ok":true}'));
        case 'state': return ok(state());
        case 'second-account':
          return ok(line('user.add', 0) + line('user.uid', 502) + line('user.admin', 0) + line('key.code', 200) + line('key.id', KEY_ID) + line('key.url', URL) + line('key.token', 1)
            + line('keeper.code', opts.keeperCode) + (opts.keeperCode === '200' ? line('keeper.id', KEEPER_ID) : '') + line('stage', STAGE));
        case 'second-account-ask':
          return ok(line('whoami', SECOND_ACCOUNT)
            + line('key.init.code', opts.keyWorks ? 200 : 401) + line('key.init.body', b64(opts.keyWorks ? { jsonrpc: '2.0', id: 1, result: { serverInfo: { name: 'olympus' } } } : { error: 'unauthorized' }))
            + line('key.tools.code', opts.keyWorks ? 200 : 401) + line('key.tools.body', Buffer.from(`event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: 2, result: { tools: [{ name: 'olympus_search' }] } })}\n\n`).toString('base64'))
            + line('nokey.code', opts.noKeyCode) + line('nokey.body', b64({ error: 'unauthorized' })));
        case 'second-account-revoke': return ok(line('revoke.code', 200) + line('whoami', SECOND_ACCOUNT) + line('revoked.code', opts.revokedCode));
        case 'second-account-cleanup': return ok(line('keeper.revoke', 200) + line('user.delete', 0));
        default: return { code: 1, stdout: '', stderr: 'unknown script' };
      }
    },
    dashboard: async () => {
      if (opts.dashboardBroken && switched) return { status: 500, body: JSON.stringify({ ok: false, error: { code: 'email_policy_violation', message: 'forbidden raw field' } }) };
      return { status: 200, body: JSON.stringify({ model_setup: { ready: true, engine_server_mode: { enabled: mode === 'daemon', pending: pending !== undefined } } }) };
    },
  };
  return { host, steps };
}

/** The test clock, moved forward by each wait the leg makes, so nothing waits on the real clock. */
function fakeClock(): ServerModeClock & { now(): number; started: number } {
  const clock = createTestClock();
  const started = clock.now();
  return {
    started,
    now: () => clock.now(),
    sleep: async (ms) => { const done = clock.sleep(ms); await clock.advance(ms); await done; },
  };
}

const byId = (checks: CheckResult[], id: string): CheckResult => {
  const found = checks.find((c) => c.id === id);
  if (!found) throw new Error(`no check ${id} in ${checks.map((c) => c.id).join(', ')}`);
  return found;
};
const failed = (checks: CheckResult[]): string[] => checks.filter((c) => c.status === 'fail').map((c) => c.id);

describe('the Mac server-mode leg', () => {
  test('Linux has no server mode: one skip, nothing run on the machine', async () => {
    const mac = fakeMac();
    const checks = await runServerModeLeg({ ...mac.host, os: 'linux' });
    expect(checks).toEqual([expect.objectContaining({ id: 'server-mode', status: 'skip' })]);
    expect(mac.steps).toEqual([]);
  });

  test('a working Mac passes every check, in order: stand-in, on, restart, off, second account, stand-in removed', async () => {
    const mac = fakeMac();
    const clock = fakeClock();
    const checks = await runServerModeLeg(mac.host, { clock });
    expect(failed(checks)).toEqual([]);
    expect(checks.map((c) => c.id)).toEqual([
      'server-mode.stand-in',
      'server-mode.on.finished', 'server-mode.on.daemon-plist', 'server-mode.on.launch-agent', 'server-mode.on.one-engine', 'server-mode.on.dashboard',
      'server-mode.restart.back', 'server-mode.restart.system-domain',
      'server-mode.off.finished', 'server-mode.off.daemon-plist', 'server-mode.off.launch-agent', 'server-mode.off.one-engine', 'server-mode.off.dashboard',
      'server-mode.second-account.user', 'server-mode.second-account.key-works', 'server-mode.second-account.no-key', 'server-mode.second-account.revoked',
    ]);
    const order = mac.steps.filter((s) => s !== 'state' && s !== 'boot');
    expect(order).toEqual(['stand-in-install', 'save-on', 'restart', 'save-off', 'second-account', 'second-account-ask', 'second-account-revoke', 'second-account-cleanup', 'stand-in-remove']);
    expect(byId(checks, 'server-mode.on.daemon-plist').detail).toBe(`root:wheel 0644, UserName ${OWNER}`);
    // The engine counted is the bun process the system job's helper started, not the helper itself.
    expect(byId(checks, 'server-mode.on.one-engine').detail).toContain('engine 301');
    expect(byId(checks, 'server-mode.restart.back').detail).toContain('back in');
    expect(byId(checks, 'server-mode.second-account.key-works').detail).toContain('1 tools');
    // The waits ran on the given clock.
    expect(clock.now()).toBeGreaterThan(clock.started);
  });

  test('a dashboard that refuses itself after the switch (#777) fails the dashboard checks', async () => {
    const checks = await runServerModeLeg(fakeMac({ dashboardBroken: true }).host, { clock: fakeClock() });
    expect(byId(checks, 'server-mode.on.dashboard').status).toBe('fail');
    expect(byId(checks, 'server-mode.on.dashboard').detail).toContain('email_policy_violation');
    expect(byId(checks, 'server-mode.off.dashboard').status).toBe('fail');
  });

  test('a change that never finishes fails within its bound; the restart is skipped and off is still tried', async () => {
    const clock = fakeClock();
    const checks = await runServerModeLeg(fakeMac({ finishAfter: Infinity }).host, { clock });
    expect(byId(checks, 'server-mode.on.finished').status).toBe('fail');
    expect(byId(checks, 'server-mode.on.finished').detail).toContain('had not finished');
    expect(byId(checks, 'server-mode.restart').status).toBe('skip');
    expect(checks.some((c) => c.id === 'server-mode.off.finished')).toBe(true);
    // Bounded: each switch waits its bound, and the dashboard's own bound, and no more.
    const spent = clock.now() - clock.started;
    expect(spent).toBeGreaterThanOrEqual(2 * SERVER_MODE_BOUNDS.switchMs);
    expect(spent).toBeLessThan(2 * (SERVER_MODE_BOUNDS.switchMs + SERVER_MODE_BOUNDS.engineMs) + 10 * SERVER_MODE_BOUNDS.pollMs);
  });

  test('a change that ends with an error message fails, with what it said', async () => {
    const checks = await runServerModeLeg(fakeMac({ doneMessage: () => 'Your Mac could not change the Olympus server setting.' }).host, { clock: fakeClock() });
    expect(byId(checks, 'server-mode.on.finished').detail).toContain('could not change');
    expect(byId(checks, 'server-mode.on.finished').status).toBe('fail');
  });

  test('a LaunchAgent left behind fails the LaunchAgent and one-engine checks', async () => {
    const checks = await runServerModeLeg(fakeMac({ agentLeftBehind: true }).host, { clock: fakeClock() });
    expect(byId(checks, 'server-mode.on.launch-agent').status).toBe('fail');
    const engines = byId(checks, 'server-mode.on.one-engine');
    expect(engines.status).toBe('fail');
    expect(engines.detail).toContain('2 engine processes');
    expect(engines.detail).toContain("also loaded in the owner's login domain");
    expect(byId(checks, 'server-mode.restart.system-domain').status).toBe('fail');
  });

  test('a daemon plist with the wrong owner or mode fails', async () => {
    const checks = await runServerModeLeg(fakeMac({ daemonOwner: 'admin:staff', daemonMode: '664' }).host, { clock: fakeClock() });
    const plist = byId(checks, 'server-mode.on.daemon-plist');
    expect(plist.status).toBe('fail');
    expect(plist.detail).toContain('not root:wheel');
    expect(plist.detail).toContain('not 0644');
  });

  test('a VM that does not come back fails within the restart bound, and the leg goes on', async () => {
    const clock = fakeClock();
    const checks = await runServerModeLeg(fakeMac({ downFor: Infinity }).host, { clock });
    expect(byId(checks, 'server-mode.restart.back').status).toBe('fail');
    expect(byId(checks, 'server-mode.restart.back').detail).toContain('not back within');
    expect(byId(checks, 'server-mode.restart.system-domain').status).toBe('fail');
    expect(clock.now() - clock.started).toBeGreaterThanOrEqual(SERVER_MODE_BOUNDS.restartMs);
  });

  test('a restart that comes back after a while passes once the boot time changed', async () => {
    const mac = fakeMac({ downFor: 5 });
    const checks = await runServerModeLeg(mac.host, { clock: fakeClock() });
    expect(byId(checks, 'server-mode.restart.back').status).toBe('pass');
    expect(byId(checks, 'server-mode.restart.system-domain').status).toBe('pass');
  });

  test('without a working stand-in the switch is not tried, the second account still is, and the right is put back', async () => {
    const mac = fakeMac({ standIn: false });
    const checks = await runServerModeLeg(mac.host, { clock: fakeClock() });
    expect(byId(checks, 'server-mode.stand-in').status).toBe('fail');
    expect(byId(checks, 'server-mode.switch').status).toBe('skip');
    expect(mac.steps).not.toContain('save-on');
    expect(byId(checks, 'server-mode.second-account.key-works').status).toBe('pass');
    expect(mac.steps.at(-1)).toBe('stand-in-remove');
  });

  test('a key that does not work, an open endpoint, and a revoked key that still works each fail', async () => {
    const broken = await runServerModeLeg(fakeMac({ keyWorks: false, noKeyCode: '200', revokedCode: '200' }).host, { clock: fakeClock() });
    expect(byId(broken, 'server-mode.second-account.key-works').status).toBe('fail');
    expect(byId(broken, 'server-mode.second-account.no-key').status).toBe('fail');
    expect(byId(broken, 'server-mode.second-account.revoked').detail).toContain('answered 200');
  });

  test('a closed listener does not count as a refused key', async () => {
    const checks = await runServerModeLeg(fakeMac({ revokedCode: '000' }).host, { clock: fakeClock() });
    expect(byId(checks, 'server-mode.second-account.revoked').status).toBe('fail');
    expect(byId(checks, 'server-mode.second-account.revoked').detail).toContain('listener was closed');
  });

  test('without a keeper key the revoke is not tried and says why', async () => {
    const mac = fakeMac({ keeperCode: '503' });
    const checks = await runServerModeLeg(mac.host, { clock: fakeClock() });
    expect(mac.steps).not.toContain('second-account-revoke');
    expect(byId(checks, 'server-mode.second-account.revoked').detail).toContain('keeper key was not created');
  });
});

describe('the machine scripts', () => {
  test('each one is valid bash, nested here-documents included', () => {
    const scripts = [
      standInInstallScript(), standInRemoveScript(), saveScript(true), saveScript(false), stateScript(), bootScript(), restartScript(),
      secondAccountScript(), secondAccountAskScript(URL, STAGE), secondAccountRevokeScript(URL, STAGE, KEY_ID), secondAccountCleanupScript(KEEPER_ID, STAGE),
    ];
    for (const script of scripts) {
      const parsed = spawnSync('bash', ['-n'], { input: script, encoding: 'utf8' });
      expect({ script: script.split('\n')[0], stderr: parsed.stderr }).toEqual({ script: script.split('\n')[0], stderr: '' });
    }
  }, 15_000);

  test('the save is the Engine card\'s request from a local control session, and the switch reads the real paths', () => {
    expect(saveScript(true)).toContain(`/dashboard/engine/computer-use '{"choice":"server"}'`);
    expect(saveScript(false)).toContain(`'{"choice":"everyday"}'`);
    expect(saveScript(true)).toContain('/dashboard/control/session/local');
    expect(saveScript(true)).not.toMatch(/authorization:/i);
    expect(stateScript()).toContain(DAEMON_PLIST);
    expect(stateScript()).toContain('Library/LaunchAgents/ai.olympusplugin.engine.plist');
    expect(stateScript()).toContain('.olympus/server-mode-result.json');
    // The process filter never matches its own command line.
    expect(stateScript()).not.toContain('"__engine-run"');
  });

  test('the stand-in answers through sudo -n and is checked by osascript as the owner; the right is restored from what was saved', () => {
    expect(standInInstallScript()).toContain('sudo -n /usr/bin/security authorizationdb write system.privilege.admin allow');
    expect(standInInstallScript()).toContain('with administrator privileges');
    expect(standInRemoveScript()).toContain('authorizationdb write system.privilege.admin < "$HOME/rc/auth-admin.plist"');
  });

  test('the second account is a standard one, its key comes from "Agent on another account of this computer", and the key never leaves the machine', () => {
    const setup = secondAccountScript();
    expect(setup).toContain('sysadminctl -addUser "$name"');
    expect(setup).not.toContain('-admin ');
    expect(setup).toContain('\\"agent\\":\\"other\\",\\"route\\":\\"loopback\\"');
    // The token is written to a file and never emitted.
    expect(setup).not.toMatch(/emit "\$which\.token" "\$\(/);
    expect(secondAccountAskScript(URL, STAGE)).toContain(`sudo -n -u ${SECOND_ACCOUNT}`);
    // A stage path that is not the leg's own is never removed.
    expect(secondAccountCleanupScript(KEEPER_ID, '/Users/admin')).not.toContain('rm -rf \'/Users/admin\'');
  });

  test('the state parser leaves out the engine helper and reads launchd and the result', () => {
    const state = parseState([
      'user\tadmin', 'uid\t501', 'daemon.present\t1', 'daemon.owner\troot:wheel', 'daemon.mode\t644', 'daemon.username\tadmin', 'agent.present\t0',
      'system.code\t0', 'system.state\trunning', 'system.pid\t300', 'gui.code\t113', 'gui.state\t', 'gui.pid\t',
      'engine\tadmin 300 1 /A/Olympus Engine.app/Contents/MacOS/OlympusEngineHost /x/bun --no-env-file /x/cli.js __engine-run',
      'engine\tadmin 301 300 /x/bun --no-env-file /x/cli.js __engine-run',
      'result\t{"pending":false,"message":"done"}',
    ].join('\n'))!;
    expect(state.engines).toEqual([{ user: 'admin', pid: 301, ppid: 300, command: '/x/bun --no-env-file /x/cli.js __engine-run' }]);
    expect(state.system).toEqual({ code: 0, state: 'running', pid: 300 });
    expect(state.gui).toEqual({ code: 113 });
    expect(state.result).toEqual({ pending: false, message: 'done' });
    expect(parseState('')).toBeUndefined();
  });

  test('the dashboard\'s server-mode setting is found wherever the view nests it', () => {
    expect(dashboardServerMode({ model_setup: { engine_server_mode: { enabled: true, pending: false } } })).toEqual({ enabled: true, pending: false });
    expect(dashboardServerMode({ a: [{ b: { engine_server_mode: { enabled: false } } }] })).toEqual({ enabled: false });
    expect(dashboardServerMode({})).toBeUndefined();
  });
});
