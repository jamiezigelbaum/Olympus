// The Mac server-mode leg (scripts/release-check/server-mode.ts, #778) against a stand-in Mac: what each step asks the machine, how
// each check reads the answers, that every wait is bounded on the clock it is given, and that a broken switch, a restart that never
// comes back or a key that still works after revoke fails the run. What only a real Mac VM shows is listed in the module's header.

import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DAEMON_PLIST, HELPER_IN_USE, PUBLISHED_INSTALLER, SECOND_ACCOUNT, SERVER_MODE_BOUNDS, SERVER_MODE_DONE, bootScript, dashboardServerMode, helperScript, parseLines, parseState, restartScript, runServerModeLeg,
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
  /** The helper step: installs the published helper, finds one already in use, stops with a reason, or installs one the engine does not use. */
  helper: 'installs' | 'already' | 'not-in-use' | { fail: string };
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
    helper: 'installs', standIn: true, finishAfter: 2, agentLeftBehind: false, daemonOwner: 'root:wheel', daemonMode: '644', dashboardBroken: false, downFor: 3,
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
        case 'helper':
          if (opts.helper === 'already') return ok(line('helper.already', 1));
          if (typeof opts.helper === 'object') return ok(line('helper.fail', opts.helper.fail));
          return ok(line('helper.name', 'olympus-engine-helper-0123456789abcdef.zip') + line('helper.version', '1.3.2') + line('helper.team', 'ND2P3ZTQRD')
            + line('helper.install.code', 0) + line('helper.install.out', '{"ok":true}') + line('helper.in_use', opts.helper === 'installs' ? 1 : 0));
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
      'server-mode.helper', 'server-mode.stand-in',
      'server-mode.on.finished', 'server-mode.on.daemon-plist', 'server-mode.on.launch-agent', 'server-mode.on.one-engine', 'server-mode.on.dashboard',
      'server-mode.restart.back', 'server-mode.restart.system-domain',
      'server-mode.off.finished', 'server-mode.off.daemon-plist', 'server-mode.off.launch-agent', 'server-mode.off.one-engine', 'server-mode.off.dashboard',
      'server-mode.second-account.user', 'server-mode.second-account.key-works', 'server-mode.second-account.no-key', 'server-mode.second-account.revoked',
    ]);
    const order = mac.steps.filter((s) => s !== 'state' && s !== 'boot');
    expect(order).toEqual(['helper', 'stand-in-install', 'save-on', 'restart', 'save-off', 'second-account', 'second-account-ask', 'second-account-revoke', 'second-account-cleanup', 'stand-in-remove']);
    expect(byId(checks, 'server-mode.helper').detail).toContain('olympus-engine-helper-0123456789abcdef.zip from Olympus 1.3.2');
    expect(byId(checks, 'server-mode.on.daemon-plist').detail).toBe(`root:wheel 0644, UserName ${OWNER}`);
    // The engine counted is the bun process the system job's helper started, not the helper itself.
    expect(byId(checks, 'server-mode.on.one-engine').detail).toContain('engine 301');
    expect(byId(checks, 'server-mode.restart.back').detail).toContain('back in');
    expect(byId(checks, 'server-mode.second-account.key-works').detail).toContain('1 tools');
    // The waits ran on the given clock.
    expect(clock.now()).toBeGreaterThan(clock.started);
  });

  test('a helper already in use is kept, and the switch runs', async () => {
    const checks = await runServerModeLeg(fakeMac({ helper: 'already' }).host, { clock: fakeClock() });
    expect(byId(checks, 'server-mode.helper')).toEqual(expect.objectContaining({ status: 'pass', detail: 'a helper was already installed and in use' }));
    expect(failed(checks)).toEqual([]);
  });

  test('a helper that cannot be installed fails with the reason; the switch and restart are skipped, the second account still runs', async () => {
    const reason = 'olympus-engine-helper-0123456789abcdef.zip has SHA-256 ffff, not the pinned 0000';
    const mac = fakeMac({ helper: { fail: reason } });
    const checks = await runServerModeLeg(mac.host, { clock: fakeClock() });
    expect(byId(checks, 'server-mode.helper')).toEqual(expect.objectContaining({ status: 'fail', detail: reason }));
    expect(failed(checks)).toEqual(['server-mode.helper']);
    const skip = byId(checks, 'server-mode.switch');
    expect(skip.status).toBe('skip');
    expect(skip.detail).toContain(reason);
    expect(checks.some((c) => c.id.startsWith('server-mode.on.') || c.id.startsWith('server-mode.restart') || c.id.startsWith('server-mode.off.'))).toBe(false);
    expect(mac.steps).not.toContain('save-on');
    expect(mac.steps).not.toContain('restart');
    expect(byId(checks, 'server-mode.second-account.key-works').status).toBe('pass');
    expect(byId(checks, 'server-mode.second-account.revoked').status).toBe('pass');
    expect(mac.steps.at(-1)).toBe('stand-in-remove');
  });

  test('a helper the engine does not start through fails, and the switch is skipped', async () => {
    const mac = fakeMac({ helper: 'not-in-use' });
    const checks = await runServerModeLeg(mac.host, { clock: fakeClock() });
    expect(byId(checks, 'server-mode.helper').status).toBe('fail');
    expect(byId(checks, 'server-mode.helper').detail).toContain('does not report the helper installed and in use');
    expect(byId(checks, 'server-mode.switch').status).toBe('skip');
    expect(mac.steps).not.toContain('save-on');
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

/**
 * Runs the real helper script under bash on this machine with stand-ins for curl (the site), ditto and the installed Olympus CLI,
 * so the pin parsing, the checksum and the install call are the script's own. Returns what it emitted and what the CLI was asked.
 */
function runHelperScript(site: { installer?: string; zip?: string; installerCode?: string; inUseBefore?: boolean; installWorks?: boolean }) {
  const root = mkdtempSync(join(tmpdir(), 'rc-helper-test-'));
  try {
    const home = join(root, 'home');
    const bin = join(root, 'bin');
    const support = join(home, 'Library/Application Support/Olympus');
    mkdirSync(join(support, 'runtime'), { recursive: true });
    mkdirSync(join(support, 'app/dist'), { recursive: true });
    mkdirSync(bin);
    writeFileSync(join(support, 'app/dist/cli.js'), '');
    writeFileSync(join(root, 'installer'), site.installer ?? '');
    writeFileSync(join(root, 'zip'), site.zip ?? '');
    const log = join(root, 'calls');
    const state = join(root, 'in-use');
    if (site.inUseBefore) writeFileSync(state, '');
    // The installed CLI: status reports the helper in use once install-helper has run (when it works).
    writeFileSync(join(support, 'runtime/bun'), `#!/bin/bash
shift
echo "$* team=\${OLYMPUS_MACOS_HELPER_TEAM_ID:-}" >> '${log}'
case "$1 $2" in
  'engine status') if [ -e '${state}' ]; then echo '{"helper": {"installed": true, "in_use": true}}'; else echo '{"helper":{"installed":false,"in_use":false}}'; fi ;;
  'engine install-helper') ${site.installWorks === false ? `echo '{"ok":false,"error":"team mismatch"}'; exit 1` : `touch '${state}'; echo '{"ok":true}'`} ;;
esac
`);
    writeFileSync(join(bin, 'curl'), `#!/bin/bash
out=; url=
while [ $# -gt 0 ]; do case "$1" in -o) out=$2; shift 2 ;; -w|--max-time|--retry|--proto) shift 2 ;; -*) shift ;; *) url=$1; shift ;; esac; done
echo "curl $url" >> '${log}'
case "$url" in
  ${PUBLISHED_INSTALLER}) cp '${join(root, 'installer')}' "$out"; printf '%s' '${site.installerCode ?? '200'}' ;;
  https://olympusplugin.ai/releases/*) cp '${join(root, 'zip')}' "$out"; printf 200 ;;
  *) printf 404 ;;
esac
`);
    writeFileSync(join(bin, 'ditto'), `#!/bin/bash\nmkdir -p "$4/Olympus Engine.app"\n`);
    for (const file of [join(support, 'runtime/bun'), join(bin, 'curl'), join(bin, 'ditto')]) chmodSync(file, 0o755);
    const ran = spawnSync('bash', ['-s'], { input: helperScript(), encoding: 'utf8', env: { PATH: `${bin}:${process.env.PATH}`, HOME: home }, timeout: 20_000 });
    let calls = '';
    try { calls = readFileSync(log, 'utf8'); } catch { /* nothing was called */ }
    return { code: ran.status, lines: parseLines(ran.stdout), stderr: ran.stderr, calls };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const ZIP = 'not really a zip, but the bytes the pins name';
const pinsFor = (zip: string, overrides: Record<string, string> = {}): string => {
  const pins: Record<string, string> = {
    OLYMPUS_VERSION: '1.3.2', RELEASE_BASE: 'https://olympusplugin.ai/releases', MACOS_HELPER_NAME: 'olympus-engine-helper-0123456789abcdef.zip',
    MACOS_HELPER_SHA256: createHash('sha256').update(zip).digest('hex'), MACOS_HELPER_BYTES: String(Buffer.byteLength(zip)), MACOS_HELPER_TEAM_ID: 'ND2P3ZTQRD', ...overrides,
  };
  return `#!/bin/sh\nset -eu\n${Object.entries(pins).map(([k, v]) => `${k}=${v}`).join('\n')}\nmain "$@"\n`;
};

describe('the helper script, run', () => {
  test('pins read from the live installer, the zip checked, and install-helper run with the pinned team', () => {
    const run = runHelperScript({ installer: pinsFor(ZIP), zip: ZIP });
    expect(run.stderr).toBe('');
    expect(run.lines.get('helper.fail')).toBeUndefined();
    expect(run.lines.get('helper.install.code')).toEqual(['0']);
    expect(run.lines.get('helper.in_use')).toEqual(['1']);
    expect(run.calls).toContain('curl https://olympusplugin.ai/releases/1.3.2/olympus-engine-helper-0123456789abcdef.zip');
    expect(run.calls).toMatch(/engine install-helper --from \S*\/helper\/Olympus Engine\.app team=ND2P3ZTQRD/);
  }, 30_000);

  test('a zip that does not match its checksum is not installed', () => {
    const run = runHelperScript({ installer: pinsFor(ZIP), zip: `${ZIP}!` });
    expect(run.lines.get('helper.fail')?.[0]).toContain('not the pinned');
    expect(run.calls).not.toContain('install-helper');
  }, 30_000);

  test('an installer that pins no helper, or does not answer, says so', () => {
    expect(runHelperScript({ installer: pinsFor(ZIP, { MACOS_HELPER_NAME: 'none' }), zip: ZIP }).lines.get('helper.fail')?.[0]).toContain('pins no helper');
    expect(runHelperScript({ installer: pinsFor(ZIP), zip: ZIP, installerCode: '503' }).lines.get('helper.fail')?.[0]).toBe(`${PUBLISHED_INSTALLER} answered 503`);
  }, 30_000);

  test('a helper already in use is kept, with nothing downloaded', () => {
    const run = runHelperScript({ installer: pinsFor(ZIP), zip: ZIP, inUseBefore: true });
    expect(run.lines.get('helper.already')).toEqual(['1']);
    expect(run.calls).not.toContain('curl');
  }, 30_000);

  test('an install-helper that fails is reported with its exit and words', () => {
    const run = runHelperScript({ installer: pinsFor(ZIP), zip: ZIP, installWorks: false });
    expect(run.lines.get('helper.install.code')).toEqual(['1']);
    expect(run.lines.get('helper.install.out')?.[0]).toContain('team mismatch');
    expect(run.lines.get('helper.in_use')).toEqual(['0']);
  }, 30_000);
});

describe('the machine scripts', () => {
  test('each one is valid bash, nested here-documents included', () => {
    const scripts = [
      helperScript(), standInInstallScript(), standInRemoveScript(), saveScript(true), saveScript(false), stateScript(), bootScript(), restartScript(),
      secondAccountScript(), secondAccountAskScript(URL, STAGE), secondAccountRevokeScript(URL, STAGE, KEY_ID), secondAccountCleanupScript(KEEPER_ID, STAGE),
    ];
    for (const script of scripts) {
      const parsed = spawnSync('bash', ['-n'], { input: script, encoding: 'utf8' });
      expect({ script: script.split('\n')[0], stderr: parsed.stderr }).toEqual({ script: script.split('\n')[0], stderr: '' });
    }
  }, 15_000);

  test('the helper comes from the live installer\'s pins, is checked, and is installed by the candidate\'s own CLI with the pinned team', () => {
    const script = helperScript();
    expect(script).toContain(PUBLISHED_INSTALLER);
    expect(script).toContain('MACOS_HELPER_SHA256');
    expect(script).toContain('shasum -a 256');
    expect(script).toContain('ditto -x -k');
    expect(script).toContain('OLYMPUS_MACOS_HELPER_TEAM_ID="$team" "$bun" "$cli" engine install-helper --from "$work/helper/Olympus Engine.app"');
    expect(script).toContain(HELPER_IN_USE);
    expect(script).toContain('https://olympusplugin.ai/releases/$version/$name');
  });

  test('the save is the Engine card\'s request from a local control session, and the switch reads the real paths', () => {
    expect(saveScript(true)).toContain(`/dashboard/engine/computer-use '{"choice":"server"}'`);
    expect(saveScript(false)).toContain(`'{"choice":"everyday"}'`);
    expect(saveScript(true)).toContain('/dashboard/control/session/local');
    // The owner's token only opens the owner session the local mint needs (#1153); the save itself carries the local session alone.
    const lines = saveScript(true).split('\n');
    expect(lines.filter((line) => /authorization:/i.test(line)).every((line) => line.includes('/dashboard/control/session"'))).toBe(true);
    expect(lines.find((line) => line.includes('--data'))).not.toMatch(/authorization:/i);
    expect(saveScript(true)).not.toMatch(/echo .*token|printf .*token/);
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
