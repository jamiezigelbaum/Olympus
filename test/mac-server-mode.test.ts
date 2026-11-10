import { spawn, spawnSync } from 'node:child_process';
import { afterEach, expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { ENGINE_BUILD_ENV, ENGINE_LABEL, enginePaths, engineServicePaths, inspectEngine, renderEnginePlist, restartEngine, setMacEngineServerMode, requestMacServerMode, macServerModeView, runMacServerModeChange, installEngine, rollbackEngine, engineBuildIdentity, installedEngineBuild, uninstallEngine, waitForMacAgentHandoff, macServerModeScript, validateMacEngineOwner, type EngineExec } from '../src/core/engine-service.ts';
import { createSovereigntyEngine, loadSovereigntyPreset } from '../src/core/sovereignty.ts';
import { startEngineHost } from '../src/core/engine-host.ts';
import { engineStatusReport } from '../src/core/engine-cli.ts';
import { renderModelSetup } from '../src/workers/dashboard/model-setup.ts';
import { computerUseStatePath, readComputerUseState, seedComputerUseState, saveComputerUseChoice } from '../src/core/first-run-privacy.ts';
import { renderComputerHostPage } from '../src/workers/dashboard/host-page.ts';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const home = mkdtempSync(join(tmpdir(), 'olympus-server-')); roots.push(home);
  const paths = enginePaths(home);
  const daemonPlistPath = join(home, 'LaunchDaemons', `${ENGINE_LABEL}.plist`);
  const program = { runtimePath: join(paths.runtimeDir, 'bun'), entryPath: join(paths.appDir, 'dist/cli.js'), workingDirectory: paths.appDir, source: 'package' as const, helperPath: paths.helperExecutablePath!, build: '1.3.2+abc' };
  const agent = renderEnginePlist({ paths, program, homeDir: home });
  const daemon = renderEnginePlist({ paths, program, homeDir: home, owner: { userName: 'mark', groupName: 'staff' } });
  const put = (path: string, content: string) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, content); };
  return { home, paths, daemonPlistPath, program, agent, daemon, put };
}

test('daemon has the same program and logs, an account and no build stamp', () => {
  const f = fixture();
  expect(f.daemon).toContain('<key>UserName</key>'); expect(f.daemon).toContain('<string>mark</string>');
  expect(f.daemon).toContain('<key>GroupName</key>'); expect(f.daemon).toContain('<string>staff</string>');
  expect(f.daemon).toContain(f.program.helperPath); expect(f.daemon).toContain(f.paths.logPath);
  expect(f.daemon).toContain('<key>RunAtLoad</key>'); expect(f.daemon).toContain('<key>SuccessfulExit</key>');
  expect(f.daemon).not.toContain(ENGINE_BUILD_ENV); expect(f.agent).toContain(ENGINE_BUILD_ENV);
  expect(f.daemon).toBe(renderEnginePlist({ paths: f.paths, program: { ...f.program, build: 'next' }, homeDir: f.home, owner: { userName: 'mark', groupName: 'staff' } }));
});

test('installed plist determines manager and inspection uses system domain', () => {
  const f = fixture(); f.put(f.paths.plistPath, f.agent);
  const options = { homeDir: f.home, platform: 'darwin', daemonPlistPath: f.daemonPlistPath };
  expect(inspectEngine({ ...options, exec: () => ({ status: 113, stdout: '', stderr: '' }) }).manager).toBe('agent');
  f.put(f.daemonPlistPath, f.daemon);
  expect(engineServicePaths(options).plistPath).toBe(f.daemonPlistPath);
  const seen: string[][] = [];
  const status = inspectEngine({ ...options, exec: (cmd, args) => { seen.push([cmd, ...args]); return { status: 0, stdout: 'state = running\npid = 4242', stderr: '' }; } });
  expect(status).toMatchObject({ manager: 'daemon', state: 'running', installed: true });
  expect(seen).toEqual([['launchctl', 'print', `system/${ENGINE_LABEL}`]]);
  // A second account cannot mistake this daemon for its own.
  expect(engineServicePaths({ ...options, homeDir: join(f.home, 'other') }).plistPath).not.toBe(f.daemonPlistPath);
});

test('privilege boundary rejects shell syntax, root, invalid ids and mismatched argument shapes', () => {
  for (const name of ['root', '-mark', 'mark;id', 'mark\nwhoami', '$(id)', 'mark name', '']) expect(() => validateMacEngineOwner(name, 501)).toThrow();
  for (const uid of [0, -1, 1.5, NaN, Infinity, 2 ** 40]) expect(() => validateMacEngineOwner('mark', uid)).toThrow();
  expect(() => validateMacEngineOwner('mark', 501)).not.toThrow();
  const script = macServerModeScript(true);
  expect(script).toContain('id -u'); expect(script).toContain('root:wheel'); expect(script).toContain('chmod 0644');
  expect(script).toContain('mktemp'); expect(script).toContain('plutil'); expect(script).not.toContain(ENGINE_BUILD_ENV);
});

test('cancel leaves agent and daemon untouched; success removes agent; turning off restores it', () => {
  const f = fixture(); f.put(f.paths.plistPath, f.agent);
  const calls: string[][] = [];
  let cancel = true;
  let adding = true;
  let agentLoaded = true;
  const exec: EngineExec = (cmd, args) => {
    calls.push([cmd, ...args]);
    if (cmd === 'osascript') {
      if (cancel) return { status: 1, stdout: '', stderr: 'User canceled. (-128)' };
      if (adding) f.put(f.daemonPlistPath, f.daemon);
      else rmSync(f.daemonPlistPath);
      return { status: 0, stdout: '', stderr: '' };
    }
    if (args[0] === 'bootout') agentLoaded = false;
    if (args[0] === 'bootstrap') agentLoaded = true;
    return { status: args[0] === 'print' && args[1]?.includes(ENGINE_LABEL) && !agentLoaded ? 113 : 0, stdout: 'state = running\npid = 4242', stderr: '' };
  };
  const options = { homeDir: f.home, platform: 'darwin', userName: 'mark', uid: 501, daemonPlistPath: f.daemonPlistPath, exec, now: true };
  expect(() => setMacEngineServerMode(true, options)).toThrow('Nothing was changed');
  expect(readFileSync(f.paths.plistPath, 'utf8')).toBe(f.agent);
  expect(engineServicePaths(options).plistPath).toBe(f.paths.plistPath);
  cancel = false;
  expect(setMacEngineServerMode(true, options)).toMatchObject({ manager: 'daemon' });
  expect(existsSync(f.paths.plistPath)).toBe(false);
  expect(engineServicePaths(options).plistPath).toBe(f.daemonPlistPath);
  adding = false;
  expect(setMacEngineServerMode(false, options)).toMatchObject({ manager: 'agent' });
  expect(existsSync(f.daemonPlistPath)).toBe(false);
  expect(readFileSync(f.paths.plistPath, 'utf8')).toContain(ENGINE_BUILD_ENV);
  expect(calls.filter(call => call[0] === 'osascript')).toHaveLength(3);
  expect(calls).toContainEqual(['launchctl', 'bootout', `gui/501/${ENGINE_LABEL}`]);
  expect(calls).toContainEqual(['launchctl', 'bootstrap', 'gui/501', f.paths.plistPath]);
});

test('daemon restart signals the launchd-owned helper, without a privileged launchctl mutation', () => {
  const f = fixture(); f.put(f.daemonPlistPath, f.daemon);
  const calls: string[][] = [];
  restartEngine({ homeDir: f.home, daemonPlistPath: f.daemonPlistPath, platform: 'darwin', uid: 501, now: true, exec: (cmd, args) => {
    calls.push([cmd, ...args]); return { status: 0, stdout: 'state = running\npid = 4242', stderr: '' };
  } });
  expect(calls).toEqual([['launchctl', 'print', `system/${ENGINE_LABEL}`], ['/bin/kill', '-HUP', '4242']]);
});

test('only newly seeded first-run state asks how the computer runs, before Private answers', () => {
  const f = fixture(); const policy = f.paths.sovereigntyPath;
  expect(readComputerUseState(policy)).toBeUndefined();
  seedComputerUseState(policy); expect(readComputerUseState(policy)?.choice).toBeNull();
  expect(computerUseStatePath(policy)).toBe(join(dirname(policy), 'computer-use.json'));
  const base = { ready: false, checked_at: '2026-11-03T00:00:00.000Z', cards: [], privacy_choice_pending: true };
  const fresh = renderModelSetup({ ...base, computer_use_pending: true });
  expect(fresh).toContain('How will this computer run?'); expect(fresh).toContain('My everyday computer');
  expect(fresh).toContain('Recommended'); expect(fresh).not.toContain('id="first-run-privacy"');
  saveComputerUseChoice(policy, 'everyday'); expect(readComputerUseState(policy)?.choice).toBe('everyday');
  expect(renderModelSetup(base)).not.toContain('How will this computer run?');
});

test('computer dashboard header identifies the machine and account, escaped', () => {
  const html = renderComputerHostPage({ origin: 'http://localhost', panelHtml: '<p>Panel</p>', computerIdentity: "Mark's <Mac> · mark" });
  expect(html).toContain("Mark's &lt;Mac&gt; · mark");
});


test('the fixed shell script rejects bad arguments before reaching a privileged operation', () => {
  for (const enable of [true, false]) {
    const script = macServerModeScript(enable);
    expect(spawnSync('/bin/sh', ['-n'], { input: script }).status).toBe(0);
    for (const args of [[], ['mark'], ['mark', '501', 'extra'], ['root', '501'], ['mark; id', '501'], ['mark', '0'], ['mark', '1;id'], ['mark', '-1'], ['mark', '99999999999']]) {
      expect(spawnSync('/bin/sh', ['-c', script, 'olympus', ...args]).status).toBe(64);
    }
  }
}, 30_000);

test('a daemon cannot enter the data plane before the login agent unloads, and unknown custody refuses', async () => {
  let calls = 0; let sleeps = 0;
  expect(await waitForMacAgentHandoff({ uid: 501, attempts: 3, sleep: async () => { sleeps++; }, exec: (_cmd, args) => {
    expect(args).toEqual(['print', `gui/501/${ENGINE_LABEL}`]);
    return { status: ++calls < 3 ? 0 : 113, stdout: '', stderr: '' };
  } })).toBe(true);
  expect(sleeps).toBe(2);
  expect(await waitForMacAgentHandoff({ exec: () => ({ status: 1, stdout: '', stderr: 'permission denied' }) })).toBe(false);
});

test('a daemon starts after a reboot when nobody has signed in and the login domain does not exist', async () => {
  expect(await waitForMacAgentHandoff({ uid: 501, sleep: async () => { throw new Error('no wait expected'); }, exec: () => ({ status: 125, stdout: '', stderr: 'Bad request.\nCould not find domain for user gui: 501' }) })).toBe(true);
});

test('daemon upgrades retain the exact plist and signal restart, with no administrator request', () => {
  const f = fixture(); f.put(f.daemonPlistPath, f.daemon);
  f.put(join(f.paths.appDir, 'package.json'), JSON.stringify({ name: 'olympus', version: '1.3.2' }));
  f.put(f.program.entryPath, '// new build'); f.put(f.program.runtimePath, '#!/bin/sh'); chmodSync(f.program.runtimePath, 0o755);
  f.put(f.program.helperPath, '#!/bin/sh'); chmodSync(f.program.helperPath, 0o755);
  f.put(f.paths.statusPath, JSON.stringify({ schema: 'olympus.engine.status.v1', state: 'running', build: 'old' }));
  const calls: string[][] = [];
  const result = installEngine({ platform: 'darwin', homeDir: f.home, daemonPlistPath: f.daemonPlistPath, fromCheckout: f.paths.appDir, bunBin: f.program.runtimePath, now: true,
    exec: (command, args) => { calls.push([command, ...args]); return { status: 0, stdout: 'state = running\npid = 4242', stderr: '' }; },
  });
  expect(result).toMatchObject({ action: 'restarted', wrote_plist: false });
  expect(readFileSync(f.daemonPlistPath, 'utf8')).toBe(f.daemon);
  expect(existsSync(f.paths.plistPath)).toBe(false);
  expect(installedEngineBuild(f.daemonPlistPath)).toBe(engineBuildIdentity(f.paths.appDir));
  expect(calls).toContainEqual(['/bin/kill', '-HUP', '4242']);
  expect(calls.some(call => call[0] === 'osascript' || ['kickstart', 'enable', 'disable', 'bootout', 'bootstrap'].includes(call[1]!))).toBe(false);
});

test('server mode refuses a rollback to a release older than 1.3.2 before changing anything', async () => {
  const f = fixture(); f.put(f.daemonPlistPath, f.daemon);
  const app = (dir: string, version: string) => {
    f.put(join(dir, 'package.json'), JSON.stringify({ name: 'olympus', version }));
    f.put(join(dir, 'dist', 'cli.js'), `// ${version}\n`);
  };
  app(f.paths.appDir, '1.4.2');
  f.put(f.program.runtimePath, '#!/bin/sh'); chmodSync(f.program.runtimePath, 0o755);
  f.put(f.program.helperPath, '#!/bin/sh'); chmodSync(f.program.helperPath, 0o755);
  const calls: string[][] = [];
  const options = { platform: 'darwin', homeDir: f.home, daemonPlistPath: f.daemonPlistPath, uid: 501, now: true,
    exec: (command: string, args: string[]) => { calls.push([command, ...args]); return { status: 0, stdout: 'state = running\npid = 4242', stderr: '' }; } };
  for (const old of ['1.3.1', '1.2.0', '1.3.2-rc.1']) {
    app(f.paths.previousAppDir, old);
    await expect(rollbackEngine(options)).rejects.toThrow(/older than 1\.3\.2.*Turn server mode off in Keys/s);
    expect(readFileSync(join(f.paths.appDir, 'dist', 'cli.js'), 'utf8')).toBe('// 1.4.2\n');
    expect(readFileSync(join(f.paths.previousAppDir, 'dist', 'cli.js'), 'utf8')).toBe(`// ${old}\n`);
  }
  expect(calls).toEqual([]);
  expect(readFileSync(f.daemonPlistPath, 'utf8')).toBe(f.daemon);
  // 1.3.2 and later get past the check and the daemon is signalled onto them.
  app(f.paths.previousAppDir, '1.3.2');
  let clock = 0;
  const result = await rollbackEngine({ ...options, health: { timeoutMs: 0, pollMs: 1, now: () => (clock += 1), sleep: async () => {} } });
  expect(result.ok).toBe(false);
  expect(calls).toContainEqual(['/bin/kill', '-HUP', '4242']);
  expect(readFileSync(join(f.paths.appDir, 'dist', 'cli.js'), 'utf8')).toBe('// 1.4.2\n');
});

test('host HUP drains services before exiting 75 for launchd KeepAlive', async () => {
  const f = fixture(); f.put(f.paths.configPath, JSON.stringify({ worker: { service: { enabled: false } }, remote: { enabled: false } }));
  const previous = new Set(process.listeners('SIGHUP'));
  const exits: number[] = []; const stopped: string[] = [];
  const beforeTerm = new Set(process.listeners('SIGTERM')); const beforeInt = new Set(process.listeners('SIGINT'));
  const host = await startEngineHost({ platform: 'darwin', moduleUrl: 'file:///test/dist/cli.js', homeDir: f.home, env: { HOME: f.home },
    log: () => {}, exit: code => { expect(stopped).toEqual(['worker']); exits.push(code); },
    services: () => [{ id: 'worker', start: async () => {}, reload: { configPrefixes: [] }, stop: async () => { stopped.push('worker'); } }],
  });
  try {
    const hup = process.listeners('SIGHUP').find(listener => !previous.has(listener));
    expect(hup).toBeDefined(); hup!('SIGHUP');
    await host!.stop(); await Bun.sleep(0);
    expect(exits).toEqual([75]); expect(host!.status().state).toBe('stopped');
  } finally {
    for (const listener of process.listeners('SIGHUP')) if (!previous.has(listener)) process.removeListener('SIGHUP', listener);
    for (const listener of process.listeners('SIGTERM')) if (!beforeTerm.has(listener)) process.removeListener('SIGTERM', listener);
    for (const listener of process.listeners('SIGINT')) if (!beforeInt.has(listener)) process.removeListener('SIGINT', listener);
    await host?.stop();
  }
});

test('uninstall requests administrator approval only when the installed manager is a daemon', () => {
  const f = fixture(); f.put(f.daemonPlistPath, f.daemon);
  let prompts = 0;
  const exec: EngineExec = (cmd, args) => {
    if (cmd === 'osascript') { prompts++; rmSync(f.daemonPlistPath); }
    return { status: args[0] === 'print' ? 113 : 0, stdout: '', stderr: '' };
  };
  const result = uninstallEngine({ platform: 'darwin', homeDir: f.home, daemonPlistPath: f.daemonPlistPath, uid: 501, userName: 'mark', exec, now: true });
  expect(result.removed_plist).toBe(true); expect(prompts).toBe(1); expect(existsSync(f.daemonPlistPath)).toBe(false);
  f.put(f.paths.plistPath, f.agent);
  uninstallEngine({ platform: 'darwin', homeDir: f.home, daemonPlistPath: f.daemonPlistPath, exec, now: true });
  expect(prompts).toBe(1);
});

test('status reports the daemon manager and system service state', async () => {
  const f = fixture(); f.put(f.daemonPlistPath, f.daemon);
  const report = await engineStatusReport({ platform: 'darwin', homeDir: f.home, daemonPlistPath: f.daemonPlistPath,
    openclawPath: () => undefined, fetchImpl: (async () => new Response('{}')) as unknown as typeof fetch,
    exec: () => ({ status: 0, stdout: 'state = running\npid = 4242', stderr: '' }),
  });
  expect(report.agent).toMatchObject({ manager: 'daemon', state: 'running', plist_path: f.daemonPlistPath });
});

test('the server switch appears only when the standalone Mac supplies server-mode facts', () => {
  const view = { ready: true, checked_at: '2026-11-03T00:00:00.000Z', cards: [] };
  expect(renderModelSetup(view)).not.toContain('role="switch"');
  const html = renderModelSetup({ ...view, engine_server_mode: { enabled: true, pending: false, notice: 'Saved.' } });
  expect(html).toContain('role="switch"'); expect(html).toContain('checked'); expect(html).toContain('Saved.');
  expect(html).toContain('once the disk is unlocked');
});

test('fresh Mac install seeds the computer question; an existing install never gets it retroactively', () => {
  const f = fixture();
  f.put(join(f.paths.appDir, 'package.json'), JSON.stringify({ name: 'olympus', version: '1.3.2' }));
  f.put(f.program.entryPath, '// new build'); f.put(f.program.runtimePath, '#!/bin/sh'); chmodSync(f.program.runtimePath, 0o755);
  let loaded = false;
  const exec: EngineExec = (_cmd, args) => {
    if (args[0] === 'bootstrap') loaded = true;
    return { status: args[0] === 'print' && !loaded ? 113 : 0, stdout: 'state = running\npid = 4242', stderr: '' };
  };
  const options = { platform: 'darwin', homeDir: f.home, fromCheckout: f.paths.appDir, bunBin: f.program.runtimePath, daemonPlistPath: f.daemonPlistPath, exec, now: true };
  installEngine(options);
  expect(readComputerUseState(f.paths.sovereigntyPath)?.choice).toBeNull();
  rmSync(computerUseStatePath(f.paths.sovereigntyPath));
  installEngine(options);
  expect(readComputerUseState(f.paths.sovereigntyPath)).toBeUndefined();
});

test('dashboard server changes require local controls and the computer question precedes privacy writes', async () => {
  const { createEmailSourceWorker } = await import('../src/workers/email-source/index.ts');
  const { DASHBOARD_CONTROL_CSRF_CONTEXT_HEADER, DASHBOARD_CONTROL_GRADE_CONTEXT_HEADER } = await import('../src/workers/http.ts');
  const f = fixture(); let computerWrites = 0; let privacyWrites = 0;
  const worker = createEmailSourceWorker({ sourceDashboard: { sovereigntyEngine: createSovereigntyEngine(loadSovereigntyPreset('local-first')), registryPath: join(f.home, 'handles.json'),
    computerSetup: () => ({ engine_server_mode: { enabled: false, pending: false }, computer_use_pending: computerWrites === 0 }),
    saveComputerUseChoice: () => { computerWrites++; return { ok: true, status_message: 'Choice saved.' }; },
    saveFirstRunPrivacyChoice: () => { privacyWrites++; return true; },
  } });
  const post = (path: string, local: boolean, choice: string) => worker.fetch(new Request('http://worker.test' + path, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...(local ? { [DASHBOARD_CONTROL_CSRF_CONTEXT_HEADER]: 'test', [DASHBOARD_CONTROL_GRADE_CONTEXT_HEADER]: 'local' } : {}) }, body: JSON.stringify({ choice }),
  }));
  try {
    expect((await post('/dashboard/engine/computer-use', false, 'server')).status).toBe(403);
    expect(computerWrites).toBe(0);
    const malformed = await worker.fetch(new Request('http://worker.test/dashboard/engine/computer-use', { method: 'POST', headers: { 'Content-Type': 'application/json', [DASHBOARD_CONTROL_CSRF_CONTEXT_HEADER]: 'test', [DASHBOARD_CONTROL_GRADE_CONTEXT_HEADER]: 'local' }, body: JSON.stringify({ choice: ['server'] }) }));
    expect(malformed.status).toBe(400); expect(computerWrites).toBe(0);
    expect((await post('/dashboard/models/first-run-privacy', true, 'local-first')).status).toBe(409);
    expect(privacyWrites).toBe(0);
    expect((await post('/dashboard/engine/computer-use', true, 'everyday')).status).toBe(200);
    expect(computerWrites).toBe(1);
    expect((await post('/dashboard/models/first-run-privacy', true, 'local-first')).status).toBe(200);
    expect(privacyWrites).toBe(1);
  } finally { worker.close(); }
});

test('the standalone uninstaller embeds exactly the fixed daemon removal script', () => {
  const script = macServerModeScript(false);
  const shellQuoted = "'" + script.replaceAll("'", "'\\''") + "'";
  const appleQuoted = (`/bin/sh -c ${shellQuoted} olympus `).replaceAll('\\', '\\\\').replaceAll('"', '\\"');
  const file = readFileSync(join(import.meta.dir, '../site/uninstall.sh'), 'utf8');
  const shellApple = appleQuoted.replaceAll("'", "'\\''");
  expect(file).toContain(shellApple);
  expect(file.indexOf('\n  stop_daemon\n')).toBeLessThan(file.indexOf('\n  stop_agent\n'));
});

test.skipIf(!existsSync('/usr/bin/python3'))('the privileged script generates the daemon itself, with fixed arguments, ownership and permissions', () => {
  const f = fixture(); const bins = join(f.home, 'fake-system');
  const executable = (name: string, text: string) => { const path = join(bins, name); f.put(path, text); chmodSync(path, 0o755); return path; };
  f.put(f.program.runtimePath, '#!/bin/sh'); chmodSync(f.program.runtimePath, 0o755);
  f.put(f.program.helperPath, '#!/bin/sh'); chmodSync(f.program.helperPath, 0o755);
  f.put(f.program.entryPath, '// installed'); mkdirSync(dirname(f.daemonPlistPath), { recursive: true });
  const id = executable('id', '#!/bin/sh\ncase "$*" in "-u mark") echo 501 ;; "-u") echo 0 ;; "-gn mark") echo staff ;; *) exit 64 ;; esac\n');
  const dscl = executable('dscl', '#!/bin/sh\nprintf "%s\\n" "NFSHomeDirectory: ' + f.home + '"\n');
  const chown = executable('chown', '#!/bin/sh\nprintf "%s\\n" "$*" > "' + join(f.home, 'ownership') + '"\n');
  const launchctl = executable('launchctl', '#!/bin/sh\n[ "$1" = print ] && exit 113\nprintf "%s\\n" "$*" >> "' + join(f.home, 'launchctl') + '"\n');
  const plutil = executable('plutil', `#!/usr/bin/python3
import sys, plistlib
args=sys.argv[1:]
if args[0]=='-extract':
  with open(args[-1], 'rb') as f: print(plistlib.load(f)[args[1]])
  sys.exit(0)
_, key, kind, value, path = args
with open(path, 'rb') as f: obj=plistlib.load(f)
if kind=='-bool': value=value=='YES'
elif kind=='-integer': value=int(value)
elif kind=='-xml': value=plistlib.loads(('<plist version="1.0">'+value+'</plist>').encode())
parts=key.split('.')
parent=obj
for part in parts[:-1]: parent=parent[part]
if isinstance(parent, list): parent.insert(int(parts[-1]), value)
else: parent[parts[-1]]=value
with open(path, 'wb') as f: plistlib.dump(obj,f)
`);
  const forTest = (enable: boolean) => macServerModeScript(enable)
    .replaceAll('/Library/LaunchDaemons', dirname(f.daemonPlistPath))
    .replaceAll('/usr/bin/id', id).replaceAll('/usr/bin/dscl', dscl).replaceAll('/usr/bin/plutil', plutil)
    .replaceAll('/usr/sbin/chown', chown).replaceAll('/bin/launchctl', launchctl);
  const installed = spawnSync('/bin/sh', ['-c', forTest(true), 'olympus', 'mark', '501'], { encoding: 'utf8' });
  expect(installed.stderr).toBe(''); expect(installed.status).toBe(0);
  const parsed = spawnSync('/usr/bin/python3', ['-c', 'import sys,plistlib,json; print(json.dumps(plistlib.load(open(sys.argv[1],"rb"))))', f.daemonPlistPath], { encoding: 'utf8' });
  const plist = JSON.parse(parsed.stdout);
  expect(plist).toMatchObject({ Label: ENGINE_LABEL, UserName: 'mark', GroupName: 'staff', RunAtLoad: true, KeepAlive: { SuccessfulExit: false },
    WorkingDirectory: f.paths.appDir, StandardOutPath: f.paths.logPath, StandardErrorPath: f.paths.errorLogPath,
    EnvironmentVariables: { HOME: f.home, OLYMPUS_ENGINE_HOST: '1' },
  });
  expect(plist.ProgramArguments).toEqual([f.program.helperPath, f.program.runtimePath, '--no-env-file', f.program.entryPath, '__engine-run']);
  expect(plist.EnvironmentVariables[ENGINE_BUILD_ENV]).toBeUndefined();
  expect((statSync(f.daemonPlistPath).mode & 0o777)).toBe(0o644);
  expect(readFileSync(join(f.home, 'ownership'), 'utf8')).toContain('root:wheel ' + dirname(f.daemonPlistPath) + '/.olympus-engine.');
  expect(readFileSync(join(f.home, 'launchctl'), 'utf8')).toContain('bootstrap system ' + f.daemonPlistPath);
  expect(engineServicePaths({ platform: 'darwin', homeDir: f.home, daemonPlistPath: f.daemonPlistPath }).engineManager).toBe('daemon');
  expect(spawnSync('/bin/sh', ['-c', forTest(false), 'olympus', 'mark', '501']).status).toBe(0);
  expect(existsSync(f.daemonPlistPath)).toBe(false);
});

test('the dashboard switch submits both on and off through the shared browser controller', async () => {
  const { Window } = await import('happy-dom');
  const { mountDashboardController } = await import('../src/control-ui/browser-controller.ts');
  const happy = new Window({ url: 'http://localhost/dashboard?keys' });
  const names = ['window', 'document', 'navigator', 'Element', 'HTMLElement', 'HTMLFormElement', 'HTMLInputElement', 'HTMLTextAreaElement', 'HTMLSelectElement', 'HTMLButtonElement', 'HTMLAnchorElement', 'ShadowRoot', 'Event', 'MouseEvent', 'FormData', 'CSS'];
  const previous = new Map(names.map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  for (const name of names) Object.defineProperty(globalThis, name, { configurable: true, writable: true, value: name === 'window' ? happy : (happy as unknown as Record<string, unknown>)[name] });
  try {
    for (const [enabled, checked, choice] of [[false, true, 'server'], [true, false, 'everyday']] as const) {
      const root = document.createElement('div'); document.body.append(root);
      root.innerHTML = renderModelSetup({ ready: true, checked_at: '2026-11-03', cards: [], engine_server_mode: { enabled, pending: false } });
      const calls: unknown[] = [];
      const abort = new AbortController();
      const controller = mountDashboardController({ root, canWrite: true, signal: abort.signal, navigate: () => {}, refresh: async () => undefined, returnUrl: '/dashboard?keys',
        transport: { control: async params => { calls.push(params); return { status: 200, body: { ok: true, status_message: 'Saved.' } }; } },
      });
      try {
        root.querySelector<HTMLInputElement>('[name="server"]')!.checked = checked;
        root.querySelector('form[data-computer-use]')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
        for (let tick = 0; tick < 4; tick++) await Bun.sleep(0);
        expect(calls).toEqual([{ action: 'set_computer_use', choice }]);
      } finally { controller.dispose(); abort.abort(); root.remove(); }
    }
  } finally {
    for (const name of names) {
      const descriptor = previous.get(name);
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete (globalThis as Record<string, unknown>)[name];
    }
    happy.close();
  }
});


test('mode change waits for the new host rather than accepting the previous healthy login engine', async () => {
  const f = fixture(); f.put(f.paths.plistPath, f.agent);
  f.put(join(f.paths.appDir, 'package.json'), JSON.stringify({ name: 'olympus', version: '1.3.2' }));
  f.put(f.program.entryPath, '// installed');
  f.put(f.paths.statusPath, JSON.stringify({ schema: 'olympus.engine.status.v1', state: 'running', build: engineBuildIdentity(f.paths.appDir), pid: process.pid,
    started_at: '2020-01-01T00:00:00Z', services: { 'olympus-worker': { state: 'off' } },
  }));
  seedComputerUseState(f.paths.sovereigntyPath);
  await runMacServerModeChange(true, { platform: 'darwin', homeDir: f.home, daemonPlistPath: f.daemonPlistPath, userName: 'mark', uid: 501, now: true,
    exec: (command, args) => {
      if (command === 'osascript') f.put(f.daemonPlistPath, f.daemon);
      return { status: args[0] === 'print' ? 113 : 0, stdout: '', stderr: '' };
    }, health: { timeoutMs: 0, pidAlive: () => true },
  });
  expect(readComputerUseState(f.paths.sovereigntyPath)?.choice).toBeNull();
  expect(JSON.parse(readFileSync(join(dirname(f.paths.configPath), 'server-mode-result.json'), 'utf8')).message).toContain('has not reconnected');
});

test('retrying an interrupted handoff retires the leftover agent without another administrator request', () => {
  const f = fixture(); f.put(f.paths.plistPath, f.agent); f.put(f.daemonPlistPath, f.daemon);
  const calls: string[][] = [];
  setMacEngineServerMode(true, { platform: 'darwin', homeDir: f.home, daemonPlistPath: f.daemonPlistPath, uid: 501, userName: 'mark', now: true,
    exec: (command, args) => { calls.push([command, ...args]); return { status: 0, stdout: 'state = running\npid = 4242', stderr: '' }; },
  });
  expect(existsSync(f.paths.plistPath)).toBe(false);
  expect(calls).toContainEqual(['launchctl', 'bootout', `gui/501/${ENGINE_LABEL}`]);
  expect(calls.some(call => call[0] === 'osascript')).toBe(false);
});

test('the dashboard can start the server-mode helper: the CLI accepts it as a package-internal command', async () => {
  const { V0_4_PACKAGE_INTERNAL_CLI_HELPERS } = await import('../src/core/public-surface.ts');
  expect(V0_4_PACKAGE_INTERNAL_CLI_HELPERS as readonly string[]).toContain('__engine-server-mode');
});

test('the admin step names the real account when Bun reports "unknown" without USER', async () => {
  const { currentMacUserName } = await import('../src/core/mac-engine-daemon.ts');
  expect(currentMacUserName(501, 'unknown', uid => (uid === 501 ? 'mark' : 'wrong'))).toBe('mark');
  expect(currentMacUserName(501, 'mark', () => { throw new Error('must not look up'); })).toBe('mark');
});

test('a server-mode notice passes the dashboard view policy', async () => {
  const { assertNoRawEmailFields } = await import('../src/core/email-policy.ts');
  const view = { model_setup: { engine_server_mode: { enabled: false, pending: true, notice: 'Your Mac will ask for an administrator’s password.' } } };
  expect(() => assertNoRawEmailFields(view)).not.toThrow();
  expect(() => assertNoRawEmailFields({ model_setup: { engine_server_mode: { enabled: false, pending: true, message: 'x' } } })).toThrow();
});

const signInMessage = "Sign in to this Mac's desktop to turn this off. Olympus keeps running.";

test('a daemon off request bootstraps a private one-shot agent with only the fixed installed command', () => {
  const f = fixture(); f.put(f.daemonPlistPath, f.daemon);
  const calls: string[][] = [];
  const agentPath = join(dirname(f.paths.configPath), 'server-mode-off.plist');
  const options = { platform: 'darwin', homeDir: f.home, daemonPlistPath: f.daemonPlistPath, uid: 501, userName: 'mark',
    spawn: (() => { throw new Error('must use launchd, never detach in the daemon session'); }) as typeof spawn,
    exec: ((cmd, args) => {
      calls.push([cmd, ...args]);
      if (args[0] === 'bootstrap') {
        expect(macServerModeView(options)).toMatchObject({ enabled: true, pending: true });
        const plist = readFileSync(agentPath, 'utf8');
        const argv = [...(/<key>ProgramArguments<\/key><array>(.*?)<\/array>/.exec(plist)?.[1] ?? '').matchAll(/<string>(.*?)<\/string>/g)].map(match => match[1]);
        expect(argv).toEqual([f.program.runtimePath, '--no-env-file', f.program.entryPath, '__engine-server-mode', 'off']);
        expect(plist).toContain('<key>RunAtLoad</key><true/>');
        expect(plist).toContain('<key>LaunchOnlyOnce</key><true/>');
        expect(plist).toContain('<key>LimitLoadToSessionType</key><string>Aqua</string>');
        expect(plist).toContain(`<key>HOME</key><string>${f.home}</string>`);
        expect(plist).toContain('<key>USER</key><string>mark</string>');
        expect(plist).not.toContain('KeepAlive');
        expect(plist).not.toContain('/bin/sh');
        expect(statSync(agentPath).mode & 0o777).toBe(0o600);
        expect(statSync(dirname(agentPath)).mode & 0o777).toBe(0o700);
      }
      return { status: 0, stdout: '', stderr: '' };
    }) as EngineExec,
  };
  expect(requestMacServerMode(false, options).ok).toBe(true);
  expect(calls).toEqual([['launchctl', 'print', 'gui/501'], ['launchctl', 'bootstrap', 'gui/501', agentPath]]);
  expect(readFileSync(f.daemonPlistPath, 'utf8')).toBe(f.daemon);
  expect(() => requestMacServerMode(false, options)).toThrow('already changing');
  expect(calls).toHaveLength(2);
}, 5_000);

test('a missing desktop domain refuses immediately and publishes the sign-in notice without stopping Olympus', () => {
  const f = fixture(); f.put(f.daemonPlistPath, f.daemon); f.put(f.paths.configPath, '{}');
  const calls: string[][] = [];
  const options = { platform: 'darwin', homeDir: f.home, daemonPlistPath: f.daemonPlistPath, uid: 501,
    exec: ((cmd, args) => { calls.push([cmd, ...args]); return { status: 125, stdout: '', stderr: 'Could not find domain for user gui: 501' }; }) as EngineExec,
  };
  expect(() => requestMacServerMode(false, options)).toThrow(signInMessage);
  expect(calls).toEqual([['launchctl', 'print', 'gui/501']]);
  expect(macServerModeView(options)).toEqual({ enabled: true, pending: false, notice: signInMessage });
  expect(readFileSync(f.daemonPlistPath, 'utf8')).toBe(f.daemon);
  expect(existsSync(join(dirname(f.paths.configPath), 'server-mode-off.plist'))).toBe(false);
}, 5_000);

test('logout between domain check and bootstrap clears pending and removes the temporary plist', () => {
  const f = fixture(); f.put(f.daemonPlistPath, f.daemon);
  const options = { platform: 'darwin', homeDir: f.home, daemonPlistPath: f.daemonPlistPath, uid: 501, userName: 'mark',
    exec: ((_cmd, args) => ({ status: args[0] === 'bootstrap' ? 125 : 0, stdout: '', stderr: args[0] === 'bootstrap' ? 'Could not find domain' : '' })) as EngineExec,
  };
  expect(() => requestMacServerMode(false, options)).toThrow(signInMessage);
  expect(macServerModeView(options)).toEqual({ enabled: true, pending: false, notice: signInMessage });
  expect(existsSync(join(dirname(f.paths.configPath), 'server-mode-off.plist'))).toBe(false);
  expect(readFileSync(f.daemonPlistPath, 'utf8')).toBe(f.daemon);
}, 5_000);

for (const outcome of ['success', 'cancel', 'no-desktop'] as const) {
  test(`desktop helper records ${outcome} before removing its plist and unloading itself`, async () => {
    const f = fixture(); f.put(f.daemonPlistPath, f.daemon); seedComputerUseState(f.paths.sovereigntyPath);
    const agentPath = join(dirname(f.paths.configPath), 'server-mode-off.plist');
    const calls: string[][] = [];
    const options = { platform: 'darwin', homeDir: f.home, daemonPlistPath: f.daemonPlistPath, uid: 501, userName: 'mark', now: true,
      exec: ((cmd, args) => {
        calls.push([cmd, ...args]);
        if (cmd === 'osascript') {
          expect(JSON.parse(readFileSync(join(dirname(f.paths.configPath), 'server-mode-result.json'), 'utf8'))).toMatchObject({ pending: true, pid: process.pid });
          if (outcome !== 'success') return { status: 1, stdout: '', stderr: outcome === 'cancel' ? 'User canceled. (-128)' : 'execution error: An error of type -60007 has occurred. (-60007)' };
          rmSync(f.daemonPlistPath);
        }
        if (args[0] === 'bootstrap' && args[2] === f.paths.plistPath) {
          f.put(f.paths.statusPath, JSON.stringify({ schema: 'olympus.engine.status.v1', state: 'running', build: engineBuildIdentity(f.paths.appDir), pid: process.pid,
            started_at: new Date().toISOString(), services: { 'olympus-worker': { state: 'off' } } }));
        }
        if (args[0] === 'bootout') {
          expect(existsSync(agentPath)).toBe(false);
          expect(macServerModeView(options).pending).toBe(false);
        }
        return { status: 0, stdout: '', stderr: '' };
      }) as EngineExec,
      health: { timeoutMs: 0, pidAlive: () => true },
    };
    requestMacServerMode(false, options);
    await runMacServerModeChange(false, options);
    expect(calls.at(-1)).toEqual(['launchctl', 'bootout', 'gui/501/ai.olympusplugin.engine-server-mode-off']);
    expect(existsSync(agentPath)).toBe(false);
    expect(macServerModeView(options)).toEqual({ enabled: outcome !== 'success', pending: false,
      notice: outcome === 'success' ? 'Olympus will run while this account is signed in.' : outcome === 'cancel' ? 'The administrator request was cancelled. Nothing was changed.' : signInMessage });
    expect(readComputerUseState(f.paths.sovereigntyPath)?.choice).toBe(outcome === 'success' ? 'everyday' : null);
  }, 5_000);
}

test('agent-manager dashboard requests retain the detached helper command and pending result', () => {
  const f = fixture(); f.put(f.paths.plistPath, f.agent); f.put(f.paths.configPath, '{}');
  const calls: unknown[][] = [];
  let unrefs = 0;
  const child = { pid: process.pid, on: () => child, unref: () => { unrefs++; } };
  const options = { platform: 'darwin', homeDir: f.home, daemonPlistPath: f.daemonPlistPath, uid: 501, userName: 'mark',
    exec: (() => { throw new Error('agent requests must not use launchctl'); }) as EngineExec,
    spawn: ((...args: unknown[]) => { calls.push(args); return child; }) as unknown as typeof spawn,
  };
  const result = requestMacServerMode(true, options);
  expect(calls).toEqual([[f.program.runtimePath, ['--no-env-file', f.program.entryPath, '__engine-server-mode', 'on'], {
    detached: true, stdio: 'ignore', env: { HOME: f.home, PATH: '/usr/bin:/bin:/usr/sbin:/sbin', USER: 'mark', LOGNAME: 'mark' },
  }]]);
  expect(unrefs).toBe(1);
  expect(macServerModeView(options)).toEqual({ enabled: false, pending: true, notice: result.status_message });
  expect(existsSync(join(dirname(f.paths.configPath), 'server-mode-off.plist'))).toBe(false);
}, 5_000);

test('an off request whose desktop helper never took over frees the switch after the handoff window', () => {
  const f = fixture(); f.put(f.daemonPlistPath, f.daemon);
  const options = { platform: 'darwin', homeDir: f.home, daemonPlistPath: f.daemonPlistPath } as const;
  const resultPath = join(dirname(f.paths.configPath), 'server-mode-result.json');
  mkdirSync(dirname(resultPath), { recursive: true });
  writeFileSync(resultPath, JSON.stringify({ pending: true, pid: process.pid, handoff_at: Date.now(), message: 'waiting' }));
  expect(macServerModeView(options).pending).toBe(true);
  writeFileSync(resultPath, JSON.stringify({ pending: true, pid: process.pid, handoff_at: Date.now() - 10 * 60_000, message: 'waiting' }));
  expect(macServerModeView(options).pending).toBe(false);
  // The helper's own record carries no handoff time and stays pending while it runs.
  writeFileSync(resultPath, JSON.stringify({ pending: true, pid: process.pid, message: 'working' }));
  expect(macServerModeView(options).pending).toBe(true);
});
