import { afterEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { engineStatusReport, parseInstallArgs, parseLogsArgs, parseVerifyArgs } from '../src/core/engine-cli.ts';
import { engineHostServices, engineStatusPath, startEngineHost } from '../src/core/engine-host.ts';
import {
  ENGINE_BUILD_ENV,
  ENGINE_LABEL,
  STANDALONE_RELAY_HOST,
  defaultEngineConfig,
  engineBuildIdentity,
  engineDataCustody,
  enginePaths,
  engineSovereigntySeedBlocker,
  inspectEngine,
  installEngine,
  installEngineVerified,
  installedEngineBuild,
  installedProgram,
  parseLaunchctlPrint,
  preflightEnginePaths,
  readEngineLogs,
  reconcileEngineConfig,
  renderEnginePlist,
  rollbackEngine,
  startEngine,
  stopEngine,
  uninstallEngine,
  verifyEngine,
  waitForEngineHealthy,
  type EngineExec,
  type EngineHealthDeps,
} from '../src/core/engine-service.ts';
import { dataDeleteCustody, deleteOlympusDataWithCustody } from '../src/data-lifecycle.ts';
import { runDoctor, type DoctorDeps, type DoctorHostFacts } from '../src/core/doctor.ts';
import { emptyRemoteAccessStatus, remoteAccessDir, writeRemoteAccessStatus } from '../src/core/remote-access.ts';
import { defaultConfig } from '../src/core/config.ts';
import { createOpenClawInferAnalystModel } from '../src/core/analyst-openclaw-infer.ts';
import { buildEnvBridgeSovereigntyConfig } from '../src/core/sovereignty.ts';
import type { NativeProcessServiceContext, NativeProcessServiceDefinition } from '../src/core/native-process-service.ts';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(): { root: string; home: string; checkout: string; bun: string } {
  const root = mkdtempSync(join(tmpdir(), 'olympus-engine-'));
  roots.push(root);
  const home = join(root, 'home');
  mkdirSync(home, { mode: 0o700 });
  const checkout = makeCheckout(root, 'checkout');
  const bun = join(root, 'runtime', 'bun');
  mkdirSync(join(root, 'runtime'));
  writeFileSync(bun, '#!/bin/sh\n');
  chmodSync(bun, 0o755);
  return { root, home, checkout, bun };
}

function makeCheckout(root: string, name: string): string {
  const checkout = join(root, name);
  mkdirSync(join(checkout, 'dist'), { recursive: true });
  writeFileSync(join(checkout, 'package.json'), JSON.stringify({ name: 'olympus-source-checkout' }));
  writeFileSync(join(checkout, 'dist', 'cli.js'), '// fixture\n');
  return checkout;
}

/** A launchctl that remembers whether the engine label is loaded. */
function fakeLaunchctl(): { exec: EngineExec; calls: string[][]; loaded: () => boolean } {
  let loaded = false;
  const calls: string[][] = [];
  const exec: EngineExec = (command, args) => {
    calls.push([command, ...args]);
    expect(command).toBe('launchctl');
    const [verb] = args;
    if (verb === 'print') {
      return loaded
        ? { status: 0, stdout: `${ENGINE_LABEL} = {\n\tstate = running\n\tpid = 4242\n\tlast exit code = 0\n}\n`, stderr: '' }
        : { status: 113, stdout: '', stderr: `Could not find service "${ENGINE_LABEL}" in domain for user gui: 501\n` };
    }
    if (verb === 'bootstrap') { loaded = true; return { status: 0, stdout: '', stderr: '' }; }
    if (verb === 'bootout') { loaded = false; return { status: 0, stdout: '', stderr: '' }; }
    return { status: 0, stdout: '', stderr: '' };
  };
  return { exec, calls, loaded: () => loaded };
}

/**
 * A launchctl whose (re)started host writes its status file the way
 * engine-host.ts does: the build the plist names, started now, and the
 * worker's readiness. `unhealthy` builds start but their worker never gets
 * ready.
 */
function launchingLaunchctl(home: string, unhealthy: (build: string | null) => boolean = () => false) {
  const base = fakeLaunchctl();
  const paths = enginePaths(home);
  const start = () => {
    const build = installedEngineBuild(paths.plistPath);
    mkdirSync(join(paths.statusPath, '..'), { recursive: true });
    const bad = unhealthy(build);
    writeFileSync(paths.statusPath, JSON.stringify({
      schema: 'olympus.engine.status.v1',
      pid: process.pid,
      started_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      state: 'running',
      build,
      remote_mode: 'relay',
      services: { 'olympus-worker': bad ? { state: 'failing', message: 'Olympus worker exited during startup.' } : { state: 'ok', message: null } },
    }));
  };
  const exec: EngineExec = (command, args) => {
    const result = base.exec(command, args);
    if (result.status === 0 && (args[0] === 'bootstrap' || args[0] === 'kickstart')) start();
    return result;
  };
  return { ...base, exec };
}

/** Health checks that never wait for real time and find a worker that answers. */
const fastHealth = (overrides: EngineHealthDeps = {}): EngineHealthDeps => ({
  timeoutMs: 50,
  pollMs: 5,
  pidAlive: () => true,
  fetchImpl: (async () => new Response('{"ok":true}', { status: 200 })) as unknown as typeof fetch,
  ...overrides,
});

describe('engine LaunchAgent plist', () => {
  test('runs the engine host with Bun, keeps it alive, and logs to ~/Library/Logs/Olympus', () => {
    const paths = enginePaths('/Users/friend');
    const plist = renderEnginePlist({
      paths,
      homeDir: '/Users/friend',
      program: {
        runtimePath: '/Users/friend/Library/Application Support/Olympus/runtime/bun',
        entryPath: '/Users/friend/Library/Application Support/Olympus/app/dist/cli.js',
        workingDirectory: '/Users/friend/Library/Application Support/Olympus/app',
        source: 'package',
      },
    });
    expect(paths.plistPath).toBe('/Users/friend/Library/LaunchAgents/ai.olympusplugin.engine.plist');
    expect(plist).toContain('<string>ai.olympusplugin.engine</string>');
    expect(plist).toContain('<string>/Users/friend/Library/Application Support/Olympus/runtime/bun</string>\n    <string>--no-env-file</string>\n    <string>/Users/friend/Library/Application Support/Olympus/app/dist/cli.js</string>\n    <string>__engine-run</string>');
    expect(plist).toContain('<key>KeepAlive</key>');
    expect(plist).toContain('<key>RunAtLoad</key>\n  <true/>');
    expect(plist).toContain('<string>/Users/friend/Library/Logs/Olympus/engine.log</string>');
    expect(plist).toContain('<string>/Users/friend/Library/Logs/Olympus/engine.err</string>');
    expect(plist).toContain('<key>OLYMPUS_ENGINE_HOST</key>');
    expect(plist).not.toContain('/bin/sh');
    expect(plist).not.toMatch(/OLYMPUS_WORKER_AUTH_TOKEN/);
  });

  test('escapes XML and passes plutil on macOS', () => {
    const { root } = fixture();
    const plist = renderEnginePlist({
      paths: enginePaths('/Users/a&b'),
      homeDir: '/Users/a&b',
      program: { runtimePath: '/opt/<x>/bun', entryPath: "/o'p/dist/cli.js", workingDirectory: '/o', source: 'checkout' },
    });
    expect(plist).toContain('/Users/a&amp;b');
    expect(plist).toContain('/opt/&lt;x&gt;/bun');
    if (process.platform === 'darwin') {
      const file = join(root, 'engine.plist');
      writeFileSync(file, plist);
      expect(spawnSync('plutil', ['-lint', file], { timeout: 10_000 }).status).toBe(0);
    }
  }, 15_000);
});

describe('olympus engine install/uninstall', () => {
  test('first install writes config, worker env and agent, then loads it; a second install is a no-op', () => {
    const { home, checkout, bun } = fixture();
    const launchctl = fakeLaunchctl();
    const options = { platform: 'darwin', homeDir: home, uid: 501, exec: launchctl.exec, fromCheckout: checkout, bunBin: bun };

    const first = installEngine(options);
    expect(first.action).toBe('bootstrapped');
    expect(first.wrote_plist && first.wrote_config && first.wrote_worker_env).toBe(true);
    expect(launchctl.calls).toEqual([
      ['launchctl', 'print', `gui/501/${ENGINE_LABEL}`],
      ['launchctl', 'enable', `gui/501/${ENGINE_LABEL}`],
      ['launchctl', 'bootstrap', 'gui/501', join(home, 'Library', 'LaunchAgents', `${ENGINE_LABEL}.plist`)],
    ]);
    const paths = enginePaths(home);
    expect(JSON.parse(readFileSync(paths.configPath, 'utf8'))).toEqual(defaultEngineConfig());
    expect(defaultEngineConfig().remote).toEqual({ enabled: true, relayHost: STANDALONE_RELAY_HOST });
    const env = readFileSync(paths.workerEnvPath, 'utf8');
    const token = env.match(/^OLYMPUS_WORKER_AUTH_TOKEN=(.+)$/m)?.[1];
    expect(token?.length).toBeGreaterThan(30);
    expect(statSync(paths.workerEnvPath).mode & 0o777).toBe(0o600);
    expect(readFileSync(paths.plistPath, 'utf8')).toContain(join(checkout, 'dist', 'cli.js'));
    expect(readFileSync(paths.plistPath, 'utf8')).not.toContain(token!);

    launchctl.calls.length = 0;
    const second = installEngine(options);
    expect(second.action).toBe('unchanged');
    expect(second.wrote_plist || second.wrote_config || second.wrote_worker_env).toBe(false);
    expect(launchctl.calls).toEqual([['launchctl', 'print', `gui/501/${ENGINE_LABEL}`]]);
    expect(readFileSync(paths.workerEnvPath, 'utf8')).toContain(`OLYMPUS_WORKER_AUTH_TOKEN=${token}`);
  });

  test('a changed program reloads the loaded agent', () => {
    const { root, home, checkout, bun } = fixture();
    const launchctl = fakeLaunchctl();
    const base = { platform: 'darwin', homeDir: home, uid: 501, exec: launchctl.exec, bunBin: bun };
    installEngine({ ...base, fromCheckout: checkout });
    launchctl.calls.length = 0;
    const other = makeCheckout(root, 'other-checkout');
    const result = installEngine({ ...base, fromCheckout: other });
    expect(result.action).toBe('reloaded');
    expect(launchctl.calls.map((call) => call[1])).toEqual(['print', 'bootout', 'enable', 'print', 'bootstrap']);
    expect(launchctl.loaded()).toBe(true);
  });

  test('dry run writes nothing and calls no launchctl', () => {
    const { home, checkout, bun } = fixture();
    const launchctl = fakeLaunchctl();
    const result = installEngine({ platform: 'darwin', homeDir: home, exec: launchctl.exec, fromCheckout: checkout, bunBin: bun, dryRun: true });
    expect(result.action).toBe('dry_run');
    expect(launchctl.calls).toEqual([]);
    expect(existsSync(enginePaths(home).plistPath)).toBe(false);
  });

  test('refuses a directory that is not an Olympus checkout, and non-macOS hosts', () => {
    const { root, home, bun } = fixture();
    mkdirSync(join(root, 'not-olympus'));
    expect(() => installEngine({ platform: 'darwin', homeDir: home, exec: fakeLaunchctl().exec, fromCheckout: join(root, 'not-olympus'), bunBin: bun }))
      .toThrow('is not an Olympus checkout');
    expect(() => installEngine({ platform: 'linux', homeDir: home })).toThrow('macOS');
  });

  test('uninstall unloads and removes the agent but keeps config and worker env; repeating it is a no-op', () => {
    const { home, checkout, bun } = fixture();
    const launchctl = fakeLaunchctl();
    const options = { platform: 'darwin', homeDir: home, uid: 501, exec: launchctl.exec };
    installEngine({ ...options, fromCheckout: checkout, bunBin: bun });
    const removed = uninstallEngine(options);
    expect(removed).toMatchObject({ unloaded: true, removed_plist: true });
    const paths = enginePaths(home);
    expect(existsSync(paths.plistPath)).toBe(false);
    expect(existsSync(paths.configPath)).toBe(true);
    expect(existsSync(paths.workerEnvPath)).toBe(true);
    launchctl.calls.length = 0;
    expect(uninstallEngine(options)).toMatchObject({ unloaded: false, removed_plist: false });
    expect(launchctl.calls.map((call) => call[1])).toEqual(['print']);
  });

  test('engine.json keeps every value the owner set, including remote access off', () => {
    const { home } = fixture();
    const path = join(home, 'engine.json');
    writeFileSync(path, JSON.stringify({ remote: { enabled: false }, email: { baseUrl: 'http://127.0.0.1:9010/v1' } }));
    const result = reconcileEngineConfig(path);
    expect(result.wrote).toBe(true);
    expect(result.config).toEqual({
      remote: { enabled: false },
      email: { baseUrl: 'http://127.0.0.1:9010/v1' },
      worker: { service: { enabled: true }, scheduler: { enabled: true } },
    });
    expect(reconcileEngineConfig(path).wrote).toBe(false);
  });

  test('status parsing and log tails', () => {
    expect(parseLaunchctlPrint('\tstate = running\n\tpid = 77\n\tlast exit code = 0\n')).toEqual({ state: 'running', pid: 77, lastExitCode: 0 });
    expect(parseLaunchctlPrint('\tstate = not running\n\tlast exit code = 78\n')).toEqual({ state: 'not running', pid: null, lastExitCode: 78 });
    const { home, checkout, bun } = fixture();
    const launchctl = fakeLaunchctl();
    expect(inspectEngine({ platform: 'darwin', homeDir: home, exec: launchctl.exec })).toMatchObject({ installed: false, state: 'not_loaded' });
    installEngine({ platform: 'darwin', homeDir: home, exec: launchctl.exec, fromCheckout: checkout, bunBin: bun });
    expect(inspectEngine({ platform: 'darwin', homeDir: home, exec: launchctl.exec })).toMatchObject({ installed: true, state: 'running', pid: 4242 });
    const paths = enginePaths(home);
    writeFileSync(paths.logPath, `one\nworker ready token=${'a'.repeat(48)}\n`);
    const logs = readEngineLogs({ homeDir: home, lines: 1 });
    expect(logs.stdout).toEqual(['worker ready token=[redacted]']);
    expect(logs.stderr).toEqual([]);
    expect(parseInstallArgs(['--from-checkout', '/x', '--dry-run'])).toEqual({ fromCheckout: '/x', dryRun: true });
    expect(parseLogsArgs(['--lines', '20'])).toEqual({ lines: 20, follow: false });
    expect(() => parseLogsArgs(['--lines', '0'])).toThrow();
  });
});

describe('engine host without OpenClaw', () => {
  test('hands the services engine.json as plugin config, records their health, and stops them', async () => {
    const { home } = fixture();
    const paths = enginePaths(home);
    mkdirSync(join(home, '.olympus'), { recursive: true });
    writeFileSync(paths.configPath, JSON.stringify(defaultEngineConfig()));
    const seen: NativeProcessServiceContext[] = [];
    const stopped: string[] = [];
    const fake = (id: string, fail: boolean): NativeProcessServiceDefinition => ({
      id,
      reload: { configPrefixes: [] },
      async start(context) {
        seen.push(context);
        if (fail) context.serviceHealth?.reportFailure(new Error(`Olympus ${id} failed to become ready.`));
        else context.serviceHealth?.clearFailure();
      },
      async stop() { stopped.push(id); },
    });
    const lines: string[] = [];
    const handle = await startEngineHost({
      moduleUrl: 'file:///fixture/dist/cli.js',
      env: { HOME: home },
      homeDir: home,
      services: () => [fake('olympus-worker', false), fake('olympus-remote-relay', true)],
      log: (line) => lines.push(line),
      exit: () => { throw new Error('must not exit'); },
      installSignalHandlers: false,
    });
    expect(handle).toBeDefined();
    expect(seen[0]?.config).toEqual({ plugins: { entries: { olympus: { config: defaultEngineConfig() } } } });
    const status = JSON.parse(readFileSync(engineStatusPath({ HOME: home }), 'utf8'));
    expect(status).toMatchObject({ state: 'running', remote_mode: 'relay' });
    expect(status.services['olympus-worker'].state).toBe('ok');
    expect(status.services['olympus-remote-relay']).toMatchObject({ state: 'failing' });
    await handle!.stop();
    expect(stopped).toEqual(['olympus-remote-relay', 'olympus-worker']);
    expect(JSON.parse(readFileSync(engineStatusPath({ HOME: home }), 'utf8')).state).toBe('stopped');
  });

  test('refuses to start without engine.json (exit 78, so launchd throttles)', async () => {
    const { home } = fixture();
    const exits: number[] = [];
    const handle = await startEngineHost({
      moduleUrl: 'file:///fixture/dist/cli.js',
      homeDir: home,
      env: { HOME: home },
      log: () => undefined,
      exit: (code) => { exits.push(code); },
      installSignalHandlers: false,
    });
    expect(handle).toBeUndefined();
    expect(exits).toEqual([78]);
  });

  test('hosts the same worker, relay and embedding services the plugin registers', () => {
    expect(engineHostServices(defaultEngineConfig(), 'file:///fixture/dist/cli.js').map((service) => service.id)).toEqual([
      'olympus-worker',
      'olympus-remote-relay',
      'olympus-source-embedding-drain',
    ]);
  });

  test('the default analyst routes never need openclaw, and a missing openclaw is a categorical error', async () => {
    const config = buildEnvBridgeSovereigntyConfig({});
    expect(Object.values(config.modelProfiles).some((profile) => profile.provider === 'openclaw-infer')).toBe(false);
    const model = createOpenClawInferAnalystModel({ command: '/nonexistent/openclaw' });
    await expect(model.complete({ system: 's', prompt: 'p' } as never)).rejects.toThrow('OpenClaw CLI not found');
  });

  test('engine status says plainly that OpenClaw is not needed and what is missing', async () => {
    const { home } = fixture();
    const report = await engineStatusReport({
      homeDir: home,
      platform: 'darwin',
      env: { HOME: home },
      exec: fakeLaunchctl().exec,
      openclawPath: () => undefined,
      fetchImpl: (async () => { throw new Error('offline'); }) as unknown as typeof fetch,
    });
    expect(report.ok).toBe(false);
    expect(report.host).toEqual({ mode: 'standalone', openclaw: 'not installed (not needed)' });
    expect(report.missing).toContain('The engine agent is not installed: run olympus engine install.');
  });

  test('engine status says when remote access is on but the relay is not running, whatever the service health says', async () => {
    const { home, checkout, bun } = fixture();
    const launchctl = fakeLaunchctl();
    installEngine({ platform: 'darwin', homeDir: home, exec: launchctl.exec, fromCheckout: checkout, bunBin: bun });
    const report = () => engineStatusReport({
      homeDir: home,
      platform: 'darwin',
      env: { HOME: home },
      exec: launchctl.exec,
      openclawPath: () => undefined,
      fetchImpl: (async () => Response.json({ ok: true })) as unknown as typeof fetch,
    });
    const dir = remoteAccessDir({ HOME: home });
    // The 2026-10-01 signature: status.json said off while the engine said ok.
    writeRemoteAccessStatus(dir, emptyRemoteAccessStatus('off'));
    const off = await report();
    expect(off.ok).toBe(false);
    expect(off.relay).toMatchObject({ mode: 'off', running: false });
    expect(off.missing).toContain('Remote access is on but the relay process is not running: see olympus engine logs, or run olympus engine restart.');

    writeRemoteAccessStatus(dir, {
      ...emptyRemoteAccessStatus('relay'),
      pid: process.pid,
      relay: { state: 'online', reason: null, retry_in_ms: null },
    });
    const live = await report();
    expect(live.relay).toMatchObject({ mode: 'relay', running: true, state: 'online' });
    expect(live.ok).toBe(true);
    expect(live.missing).toEqual([]);
  });
});

describe('doctor without OpenClaw', () => {
  function deps(facts: DoctorHostFacts, env: Record<string, string> = {}): DoctorDeps {
    return {
      config: defaultConfig(),
      delphi: {} as DoctorDeps['delphi'],
      commandExists: async (command) => command === 'bun',
      pythonModuleExists: async () => false,
      fetchImpl: (async () => { throw new Error('offline'); }) as unknown as typeof fetch,
      readHandleRegistry: () => ({ version: 1, handles: [] }),
      env,
      hostProbe: () => facts,
    };
  }

  test('a running standalone engine is a healthy host and Node is not required', async () => {
    const result = await runDoctor(deps({ engine: { installed: true, state: 'running' }, legacyWorkerUnit: false }));
    expect(result.checks.find((check) => check.name === 'host')).toMatchObject({ ok: true });
    expect(result.checks.find((check) => check.name === 'host')?.detail).toContain('OpenClaw is not installed (optional)');
    expect(result.checks.find((check) => check.name === 'dependencies')).toMatchObject({ ok: true });
  });

  test('says what is missing when nothing hosts the engine', async () => {
    const result = await runDoctor(deps({ engine: { installed: false, state: 'not_loaded' }, legacyWorkerUnit: false }));
    expect(result.checks.find((check) => check.name === 'host')).toMatchObject({
      ok: false,
      hint: expect.stringContaining('olympus engine install'),
    });
  });

  test('flags a cloud analyst that needs openclaw when OpenClaw is absent', async () => {
    const result = await runDoctor(deps(
      { engine: { installed: true, state: 'running' }, legacyWorkerUnit: false },
      { OLYMPUS_SOURCE_INDEX_CLOUD_ANALYST_ENABLED: 'true' },
    ));
    expect(result.checks.find((check) => check.name === 'host')).toMatchObject({
      ok: false,
      detail: expect.stringContaining('openclaw infer'),
    });
  });

  test('inside the OpenClaw Gateway the host check passes as before', async () => {
    const result = await runDoctor(deps({ engine: { installed: false, state: 'not_loaded' }, legacyWorkerUnit: false, insideOpenClaw: true }));
    expect(result.checks.find((check) => check.name === 'host')).toMatchObject({ ok: true });
  });
});

describe('engine upgrades restart the engine on the new build', () => {
  test('the plist names the build, so new files in the same place reload the loaded agent', () => {
    const { home, checkout, bun } = fixture();
    const launchctl = fakeLaunchctl();
    const options = { platform: 'darwin', homeDir: home, uid: 501, exec: launchctl.exec, fromCheckout: checkout, bunBin: bun };
    const first = installEngine(options);
    expect(first.program.build).toMatch(/^unknown\+[0-9a-f]{16}$/);
    const paths = enginePaths(home);
    expect(readFileSync(paths.plistPath, 'utf8')).toContain(`<key>${ENGINE_BUILD_ENV}</key>\n    <string>${first.program.build}</string>`);

    // An upgrade swaps the package under the same path: same entry, new bytes.
    writeFileSync(join(checkout, 'dist', 'cli.js'), '// fixture v2\n');
    writeFileSync(join(checkout, 'package.json'), JSON.stringify({ name: 'olympus-source-checkout', version: '0.5.0' }));
    launchctl.calls.length = 0;
    const second = installEngine(options);
    expect(second.program.build).toMatch(/^0\.5\.0\+[0-9a-f]{16}$/);
    expect(second.program.build).not.toBe(first.program.build);
    expect(second.action).toBe('reloaded');
    expect(launchctl.calls.map((call) => call[1])).toEqual(['print', 'bootout', 'enable', 'print', 'bootstrap']);
    expect(engineBuildIdentity(checkout)).toBe(second.program.build!);
  });

  test('an identical plist whose running host is another build is restarted in place; the same build is left alone', () => {
    const { home, checkout, bun } = fixture();
    const launchctl = fakeLaunchctl();
    const options = { platform: 'darwin', homeDir: home, uid: 501, exec: launchctl.exec, fromCheckout: checkout, bunBin: bun };
    const first = installEngine(options);
    const paths = enginePaths(home);
    mkdirSync(join(paths.statusPath, '..'), { recursive: true });
    const writeStatus = (build: string | undefined) => writeFileSync(paths.statusPath, JSON.stringify({
      schema: 'olympus.engine.status.v1', pid: 4242, state: 'running', ...(build === undefined ? {} : { build }),
    }));

    writeStatus(first.program.build);
    launchctl.calls.length = 0;
    expect(installEngine(options).action).toBe('unchanged');
    expect(launchctl.calls.map((call) => call[1])).toEqual(['print']);

    writeStatus('0.0.1+0000000000000000');
    launchctl.calls.length = 0;
    expect(installEngine(options).action).toBe('restarted');
    expect(launchctl.calls).toEqual([
      ['launchctl', 'print', `gui/501/${ENGINE_LABEL}`],
      ['launchctl', 'kickstart', '-k', `gui/501/${ENGINE_LABEL}`],
    ]);

    // A host from before build identities wrote no build: it is another build.
    writeStatus(undefined);
    expect(installEngine(options).action).toBe('restarted');

    // --restart (the installer after a swap) restarts even the same build.
    writeStatus(first.program.build);
    expect(installEngine({ ...options, restart: true }).action).toBe('restarted');
    expect(parseInstallArgs(['--restart'])).toEqual({ restart: true });
  });

  test('rollback swaps in the previous app and reloads the agent onto it; a second rollback swaps back', async () => {
    const { root, home, bun } = fixture();
    const launchctl = launchingLaunchctl(home);
    const paths = enginePaths(home);
    const makeApp = (dir: string, version: string) => {
      mkdirSync(join(dir, 'dist'), { recursive: true });
      writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'olympus', version }));
      writeFileSync(join(dir, 'dist', 'cli.js'), `// ${version}\n`);
    };
    makeApp(paths.appDir, '2.0.0');
    makeApp(paths.previousAppDir, '1.0.0');
    const service = { platform: 'darwin', homeDir: home, uid: 501, exec: launchctl.exec, health: fastHealth() };
    installEngine({ ...service, fromCheckout: paths.appDir, bunBin: bun });

    launchctl.calls.length = 0;
    const back = await rollbackEngine(service);
    expect(back.ok).toBe(true);
    expect(back.health).toMatchObject({ ok: true, running_build: back.running_build, worker: 'ok' });
    expect(back.running_build).toMatch(/^1\.0\.0\+/);
    expect(back.previous_build).toMatch(/^2\.0\.0\+/);
    expect(back.action).toBe('reloaded');
    expect(launchctl.calls.map((call) => call[1])).toEqual(['print', 'bootout', 'enable', 'print', 'bootstrap']);
    expect(readFileSync(join(paths.appDir, 'dist', 'cli.js'), 'utf8')).toBe('// 1.0.0\n');
    expect(readFileSync(join(paths.previousAppDir, 'dist', 'cli.js'), 'utf8')).toBe('// 2.0.0\n');
    expect(readFileSync(paths.plistPath, 'utf8')).toContain(back.running_build);
    // The runtime the installed agent used is kept.
    expect(installedProgram(paths.plistPath)).toEqual({ runtimePath: bun, entryPath: join(paths.appDir, 'dist', 'cli.js') });

    const forward = await rollbackEngine(service);
    expect(forward.running_build).toMatch(/^2\.0\.0\+/);
    expect(readFileSync(join(paths.appDir, 'dist', 'cli.js'), 'utf8')).toBe('// 2.0.0\n');
    expect(readdirSync(paths.appSupportDir).sort()).toEqual(['app', 'app.previous']);

    // A checkout install has no previous app to return to.
    const checkout = makeCheckout(root, 'dev-checkout');
    installEngine({ ...service, fromCheckout: checkout, bunBin: bun });
    await expect(rollbackEngine(service)).rejects.toThrow('not the installed app');
  });

  test('a rollback whose agent cannot be loaded puts the running version back', async () => {
    const { home, bun } = fixture();
    const launchctl = launchingLaunchctl(home);
    const paths = enginePaths(home);
    for (const [dir, version] of [[paths.appDir, '2.0.0'], [paths.previousAppDir, '1.0.0']] as const) {
      mkdirSync(join(dir, 'dist'), { recursive: true });
      writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'olympus', version }));
      writeFileSync(join(dir, 'dist', 'cli.js'), `// ${version}\n`);
    }
    installEngine({ platform: 'darwin', homeDir: home, uid: 501, exec: launchctl.exec, fromCheckout: paths.appDir, bunBin: bun });
    let failBootstrap = true;
    const flaky: EngineExec = (command, args) => {
      if (args[0] === 'bootstrap' && failBootstrap) {
        failBootstrap = false;
        // A non-transient failure (error 5 alone is retried; see the next test).
        return { status: 1, stdout: '', stderr: 'Bootstrap failed: 125: Domain does not support specified action' };
      }
      return launchctl.exec(command, args);
    };
    await expect(rollbackEngine({ platform: 'darwin', homeDir: home, uid: 501, exec: flaky, health: fastHealth() })).rejects.toThrow('could not load the engine agent');
    expect(readFileSync(join(paths.appDir, 'dist', 'cli.js'), 'utf8')).toBe('// 2.0.0\n');
    expect(readFileSync(join(paths.previousAppDir, 'dist', 'cli.js'), 'utf8')).toBe('// 1.0.0\n');
    expect(readFileSync(paths.plistPath, 'utf8')).toContain('2.0.0+');
    expect(launchctl.loaded()).toBe(true);
  });

  test('a bootstrap racing the previous bootout (error 5) is retried and loads the agent', async () => {
    const { home, bun, checkout } = fixture();
    const launchctl = launchingLaunchctl(home);
    installEngine({ platform: 'darwin', homeDir: home, uid: 501, exec: launchctl.exec, fromCheckout: checkout, bunBin: bun });
    // A new build at the same path changes the plist, so install boots out and bootstraps again.
    writeFileSync(join(checkout, 'dist', 'cli.js'), '// a newer build\n');
    let transient = 2;
    const racing: EngineExec = (command, args) => {
      if (args[0] === 'bootstrap' && transient > 0) {
        transient -= 1;
        return { status: 5, stdout: '', stderr: 'Bootstrap failed: 5: Input/output error' };
      }
      return launchctl.exec(command, args);
    };
    const result = installEngine({ platform: 'darwin', homeDir: home, uid: 501, exec: racing, fromCheckout: checkout, bunBin: bun });
    expect(result.action).toBe('reloaded');
    expect(transient).toBe(0);
    expect(launchctl.loaded()).toBe(true);
  });

  test('rollback without an installed engine or a previous app refuses and changes nothing', async () => {
    const { home, bun } = fixture();
    const launchctl = fakeLaunchctl();
    const service = { platform: 'darwin', homeDir: home, uid: 501, exec: launchctl.exec };
    await expect(rollbackEngine(service)).rejects.toThrow('not installed');
    const paths = enginePaths(home);
    mkdirSync(join(paths.appDir, 'dist'), { recursive: true });
    writeFileSync(join(paths.appDir, 'package.json'), JSON.stringify({ name: 'olympus', version: '2.0.0' }));
    writeFileSync(join(paths.appDir, 'dist', 'cli.js'), '// 2\n');
    installEngine({ ...service, fromCheckout: paths.appDir, bunBin: bun });
    await expect(rollbackEngine(service)).rejects.toThrow('is not an Olympus checkout or package');
    expect(existsSync(paths.appDir)).toBe(true);
  });
});

describe('install and rollback succeed only on proof the new build is healthy', () => {
  const makeApps = (home: string) => {
    const paths = enginePaths(home);
    for (const [dir, version] of [[paths.appDir, '2.0.0'], [paths.previousAppDir, '1.0.0']] as const) {
      mkdirSync(join(dir, 'dist'), { recursive: true });
      writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'olympus', version }));
      writeFileSync(join(dir, 'dist', 'cli.js'), `// ${version}\n`);
    }
    return paths;
  };

  test('a verified install reports ok once the restarted host runs this build and the worker answers', async () => {
    const { home, checkout, bun } = fixture();
    const launchctl = launchingLaunchctl(home);
    const fetched: string[] = [];
    const result = await installEngineVerified({
      platform: 'darwin', homeDir: home, uid: 501, exec: launchctl.exec, fromCheckout: checkout, bunBin: bun,
      health: fastHealth({ fetchImpl: (async (url: string) => { fetched.push(url); return new Response('{}', { status: 200 }); }) as unknown as typeof fetch }),
    });
    expect(result.ok).toBe(true);
    expect(result.health).toMatchObject({ ok: true, expected_build: result.program.build, running_build: result.program.build, worker: 'ok' });
    expect(fetched).toEqual(['http://127.0.0.1:8010/v1/health']);
  });

  test('PoC: launchd accepting the agent is not success: a worker that never gets ready is ok: false with the reason', async () => {
    const { home, checkout, bun } = fixture();
    const launchctl = launchingLaunchctl(home, () => true);
    const result = await installEngineVerified({ platform: 'darwin', homeDir: home, uid: 501, exec: launchctl.exec, fromCheckout: checkout, bunBin: bun, health: fastHealth() });
    expect(result.ok).toBe(false);
    expect(result.action).toBe('bootstrapped');
    expect(result.reason).toContain('the worker is not ready yet: Olympus worker exited during startup.');
  });

  test('a status file from before the restart, another build, a dead pid, or a silent worker is not proof', async () => {
    const { home } = fixture();
    const paths = enginePaths(home);
    mkdirSync(join(paths.statusPath, '..'), { recursive: true });
    const write = (fields: Record<string, unknown>) => writeFileSync(paths.statusPath, JSON.stringify({
      schema: 'olympus.engine.status.v1', pid: 4242, started_at: new Date(1_000).toISOString(), state: 'running', build: 'b1',
      services: { 'olympus-worker': { state: 'ok' } }, ...fields,
    }));
    const check = (deps: EngineHealthDeps = {}, since?: number) =>
      waitForEngineHealthy({ paths, expectedBuild: 'b1', ...(since === undefined ? {} : { since }) }, fastHealth(deps));
    write({});
    expect((await check()).ok).toBe(true);
    expect((await check({}, 2_000)).reason).toBe('the engine has not restarted yet');
    write({ build: 'b0' });
    expect((await check()).reason).toBe('the engine runs build b0, not b1');
    write({});
    expect((await check({ pidAlive: () => false })).reason).toBe('the engine process named in its status is not running');
    expect((await check({ fetchImpl: (async () => new Response('no', { status: 503 })) as unknown as typeof fetch })).reason).toBe('the worker /health answered HTTP 503');
    expect((await check({ fetchImpl: (async () => { throw new Error('refused'); }) as unknown as typeof fetch })).reason).toBe('the worker /health did not answer');
    write({ state: 'stopping' });
    expect((await check()).reason).toBe('the engine is stopping');
    // A config that turns the worker off needs no worker answer.
    write({ services: { 'olympus-worker': { state: 'off' } } });
    expect(await check({ fetchImpl: (async () => { throw new Error('refused'); }) as unknown as typeof fetch })).toMatchObject({ ok: true, worker: 'off' });
  });

  test('the wait is bounded and polls until proof arrives', async () => {
    const { home } = fixture();
    const paths = enginePaths(home);
    let clock = 0;
    let polls = 0;
    const proof = await waitForEngineHealthy({ paths, expectedBuild: 'b1' }, {
      timeoutMs: 60_000,
      pollMs: 500,
      now: () => clock,
      sleep: async (ms) => {
        clock += ms;
        polls += 1;
        if (polls === 3) {
          mkdirSync(join(paths.statusPath, '..'), { recursive: true });
          writeFileSync(paths.statusPath, JSON.stringify({ schema: 'olympus.engine.status.v1', pid: 1, state: 'running', build: 'b1', services: { 'olympus-worker': { state: 'ok' } } }));
        }
      },
      pidAlive: () => true,
      fetchImpl: (async () => new Response('{}')) as unknown as typeof fetch,
    });
    expect(proof).toMatchObject({ ok: true, waited_ms: 1_500 });
    clock = 0;
    rmSync(paths.statusPath);
    const timedOut = await waitForEngineHealthy({ paths, expectedBuild: 'b1' }, { timeoutMs: 60_000, pollMs: 500, now: () => clock, sleep: async (ms) => { clock += ms; } });
    expect(timedOut).toMatchObject({ ok: false, waited_ms: 60_000, reason: 'the engine has not written its status yet' });
  });

  test('PoC: a rollback to a build that never gets healthy reports failure, puts the running build back, and proves it healthy', async () => {
    const { home, bun } = fixture();
    const paths = makeApps(home);
    const launchctl = launchingLaunchctl(home, (build) => build?.startsWith('1.0.0+') ?? false);
    const service = { platform: 'darwin', homeDir: home, uid: 501, exec: launchctl.exec, health: fastHealth() };
    installEngine({ ...service, fromCheckout: paths.appDir, bunBin: bun });
    const result = await rollbackEngine(service);
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/^Rolling back to build 1\.0\.0\+\w+ failed \(.*the worker is not ready yet.*\); build 2\.0\.0\+\w+ was put back and is healthy\.$/);
    expect(result.restored).toMatchObject({ ok: true });
    expect(readFileSync(join(paths.appDir, 'dist', 'cli.js'), 'utf8')).toBe('// 2.0.0\n');
    expect(installedEngineBuild(paths.plistPath)).toMatch(/^2\.0\.0\+/);
  });

  test('PoC: when putting the running build back fails too, the rollback says so instead of swallowing it', async () => {
    const { home, bun } = fixture();
    const paths = makeApps(home);
    const healthy = launchingLaunchctl(home);
    installEngine({ platform: 'darwin', homeDir: home, uid: 501, exec: healthy.exec, fromCheckout: paths.appDir, bunBin: bun });
    const sick = launchingLaunchctl(home, () => true);
    const result = await rollbackEngine({ platform: 'darwin', homeDir: home, uid: 501, exec: sick.exec, health: fastHealth() });
    expect(result.ok).toBe(false);
    expect(result.restored).toMatchObject({ ok: false });
    expect(result.reason).toContain('putting back build 2.0.0+');
    expect(result.reason).toContain('failed too');

    // A launchctl failure on the way back is reported with the original error.
    let bootstraps = 0;
    const broken: EngineExec = (command, args) => {
      if (args[0] === 'bootstrap' && ++bootstraps >= 1) return { status: 5, stdout: '', stderr: 'Bootstrap failed: 5: Input/output error' };
      return healthy.exec(command, args);
    };
    await expect(rollbackEngine({ platform: 'darwin', homeDir: home, uid: 501, exec: broken, health: fastHealth() }))
      .rejects.toThrow(/could not load the engine agent.*Putting back build .* failed too/);
  });

  test('PoC: engine verify proves the build it is given, never the one the installed agent names', async () => {
    const { root, home, checkout, bun } = fixture();
    const launchctl = launchingLaunchctl(home);
    installEngine({ platform: 'darwin', homeDir: home, uid: 501, exec: launchctl.exec, fromCheckout: checkout, bunBin: bun });
    const oldBuild = engineBuildIdentity(checkout);
    const ok = await verifyEngine({ platform: 'darwin', homeDir: home, expectPackage: checkout, health: fastHealth() });
    expect(ok).toMatchObject({ ok: true, expected_build: oldBuild, installed_build: oldBuild, health: { running_build: oldBuild } });

    // An upgrade cut short after the swap: the new files are in place, but the
    // agent and the running host are still the old build. Checking against the
    // agent would pass; checking against the new package does not.
    const upgraded = makeCheckout(root, 'upgraded');
    writeFileSync(join(upgraded, 'dist', 'cli.js'), '// v2\n');
    const newBuild = engineBuildIdentity(upgraded);
    const cutShort = await verifyEngine({ platform: 'darwin', homeDir: home, expectPackage: upgraded, health: fastHealth() });
    expect(cutShort.ok).toBe(false);
    expect(cutShort).toMatchObject({ expected_build: newBuild, installed_build: oldBuild });
    expect(cutShort.reason).toBe(`The installed engine agent runs build ${oldBuild}, not ${newBuild}: run olympus engine install --restart.`);
    expect(await verifyEngine({ platform: 'darwin', homeDir: home, expectedBuild: newBuild, health: fastHealth() })).toMatchObject({ ok: false, installed_build: oldBuild });

    // The agent names the new build, but the host launchd runs is still the old one.
    installEngine({ platform: 'darwin', homeDir: home, uid: 501, exec: fakeLaunchctl().exec, fromCheckout: upgraded, bunBin: bun });
    const stale = await verifyEngine({ platform: 'darwin', homeDir: home, expectPackage: upgraded, health: fastHealth() });
    expect(stale.ok).toBe(false);
    expect(stale.reason).toBe(`The engine is not healthy: the engine runs build ${oldBuild}, not ${newBuild}.`);
  });

  test('engine verify takes one expectation, and refuses a folder that is not a runnable Olympus package', async () => {
    const { root, home, checkout, bun } = fixture();
    installEngine({ platform: 'darwin', homeDir: home, uid: 501, exec: launchingLaunchctl(home).exec, fromCheckout: checkout, bunBin: bun });
    await expect(verifyEngine({ platform: 'darwin', homeDir: home, expectPackage: checkout, expectedBuild: 'x', health: fastHealth() })).rejects.toThrow('not both');
    await expect(verifyEngine({ platform: 'darwin', homeDir: home, expectPackage: join(root, 'runtime'), health: fastHealth() })).rejects.toThrow('is not an Olympus checkout or package');
    await expect(verifyEngine({ platform: 'darwin', homeDir: home, expectedBuild: 'a b', health: fastHealth() })).rejects.toThrow('is not a build identity');
    expect(parseVerifyArgs([])).toEqual({});
    expect(parseVerifyArgs(['--expect-package', '/tmp/pkg'])).toEqual({ expectPackage: '/tmp/pkg' });
    expect(parseVerifyArgs(['--expect-build=1.0.0+abc'])).toEqual({ expectedBuild: '1.0.0+abc' });
    expect(() => parseVerifyArgs(['--expect-package'])).toThrow('needs a value');
    expect(() => parseVerifyArgs(['--json'])).toThrow('Unknown engine verify option: --json');
  });
});

describe('olympus engine stop/start and data delete custody', () => {
  test('stop unloads and disables the agent but keeps it installed; start loads it again', () => {
    const { home, checkout, bun } = fixture();
    const launchctl = fakeLaunchctl();
    const service = { platform: 'darwin', homeDir: home, uid: 501, exec: launchctl.exec };
    installEngine({ ...service, fromCheckout: checkout, bunBin: bun });
    launchctl.calls.length = 0;
    const stopped = stopEngine(service);
    expect(stopped).toMatchObject({ ok: true, stopped: true, stopped_leftover_processes: 0 });
    expect(launchctl.calls.map((call) => call.slice(1))).toEqual([
      ['print', `gui/501/${ENGINE_LABEL}`],
      ['bootout', `gui/501/${ENGINE_LABEL}`],
      ['disable', `gui/501/${ENGINE_LABEL}`],
    ]);
    expect(existsSync(enginePaths(home).plistPath)).toBe(true);
    const inspection = inspectEngine(service);
    expect(inspection).toMatchObject({ installed: true, state: 'not_loaded' });
    expect(engineDataCustody(inspection)).toBe('none');

    launchctl.calls.length = 0;
    expect(startEngine(service)).toEqual({ ok: true, action: 'started' });
    expect(launchctl.calls.map((call) => call[1])).toEqual(['enable', 'print', 'bootstrap']);
    expect(startEngine(service)).toEqual({ ok: true, action: 'already_running' });
  });

  test('a loaded engine holds the data whether or not it is running at this moment', () => {
    expect(engineDataCustody({ installed: true, state: 'running' })).toBe('loaded');
    // Loaded but between launchd's restarts: KeepAlive starts it again.
    expect(engineDataCustody({ installed: true, state: 'loaded' })).toBe('loaded');
    expect(engineDataCustody({ installed: false, state: 'loaded' })).toBe('loaded');
    expect(engineDataCustody({ installed: true, state: 'unknown' })).toBe('unknown');
    expect(engineDataCustody({ installed: true, state: 'not_loaded' })).toBe('none');
    expect(engineDataCustody({ installed: false, state: 'not_loaded' })).toBe('none');
  });

  test('delete-all refuses while the engine is loaded and points at olympus engine stop', () => {
    const { home } = fixture();
    mkdirSync(join(home, '.olympus'), { recursive: true });
    writeFileSync(join(home, '.olympus', 'owned-file'), 'owned');
    expect(dataDeleteCustody({ all: true, workerState: 'inactive', engineLoaded: true })).toEqual({
      requirement: 'worker_inactive',
      ready: false,
      observed: 'engine_loaded',
      next_action: expect.stringContaining('olympus engine stop'),
    });
    expect(() => deleteOlympusDataWithCustody({ all: true, homeDir: home, workerState: 'inactive', engineLoaded: true }))
      .toThrow('Stop the Olympus engine before deleting local data');
    expect(existsSync(join(home, '.olympus', 'owned-file'))).toBe(true);
    expect(dataDeleteCustody({ all: true, workerState: 'inactive', engineLoaded: false }).ready).toBe(true);
  });
});

describe('engine install preflight, policy seeding, and what uninstall keeps', () => {
  test('a symlinked ~/.config fails before anything is written', () => {
    const { root, home, checkout, bun } = fixture();
    const elsewhere = join(root, 'dotfiles-config');
    mkdirSync(elsewhere);
    symlinkSync(elsewhere, join(home, '.config'));
    const launchctl = fakeLaunchctl();
    expect(() => installEngine({ platform: 'darwin', homeDir: home, exec: launchctl.exec, fromCheckout: checkout, bunBin: bun }))
      .toThrow('Olympus cannot install here');
    const paths = enginePaths(home);
    expect(existsSync(paths.plistPath)).toBe(false);
    expect(existsSync(paths.configPath)).toBe(false);
    expect(existsSync(paths.sovereigntyPath)).toBe(false);
    expect(readdirSync(elsewhere)).toEqual([]);
    expect(launchctl.calls).toEqual([]);
  });

  test('PoC: a symlinked or foreign application folder fails before anything is written or loaded', () => {
    for (const name of ['support', 'app', 'app.previous', 'runtime'] as const) {
      const { root, home, checkout, bun } = fixture();
      const paths = enginePaths(home);
      const target = { support: paths.appSupportDir, app: paths.appDir, 'app.previous': paths.previousAppDir, runtime: paths.runtimeDir }[name];
      const elsewhere = join(root, `elsewhere-${name}`);
      mkdirSync(elsewhere);
      mkdirSync(join(target, '..'), { recursive: true });
      symlinkSync(elsewhere, target);
      const launchctl = fakeLaunchctl();
      expect(() => installEngine({ platform: 'darwin', homeDir: home, exec: launchctl.exec, fromCheckout: checkout, bunBin: bun }))
        .toThrow('Olympus cannot install here');
      expect(existsSync(paths.plistPath)).toBe(false);
      expect(existsSync(paths.configPath)).toBe(false);
      expect(launchctl.calls).toEqual([]);
    }
    const { home } = fixture();
    const paths = enginePaths(home);
    mkdirSync(paths.appDir, { recursive: true });
    const me = process.getuid?.() ?? 501;
    expect(() => preflightEnginePaths(home, paths, me)).not.toThrow();
    expect(() => preflightEnginePaths(home, paths, me + 1)).toThrow('belongs to another user');
  });

  test('rollback refuses a symlinked previous app before swapping anything', async () => {
    const { root, home, bun } = fixture();
    const paths = enginePaths(home);
    mkdirSync(join(paths.appDir, 'dist'), { recursive: true });
    writeFileSync(join(paths.appDir, 'package.json'), JSON.stringify({ name: 'olympus', version: '2.0.0' }));
    writeFileSync(join(paths.appDir, 'dist', 'cli.js'), '// 2.0.0\n');
    const launchctl = launchingLaunchctl(home);
    installEngine({ platform: 'darwin', homeDir: home, uid: 501, exec: launchctl.exec, fromCheckout: paths.appDir, bunBin: bun });
    const elsewhere = makeCheckout(root, 'elsewhere');
    symlinkSync(elsewhere, paths.previousAppDir);
    await expect(rollbackEngine({ platform: 'darwin', homeDir: home, uid: 501, exec: launchctl.exec, health: fastHealth() }))
      .rejects.toThrow('Olympus cannot install here');
    expect(readFileSync(join(paths.appDir, 'dist', 'cli.js'), 'utf8')).toBe('// 2.0.0\n');
  });

  test('a directory where the plist goes fails before anything is written', () => {
    const { home, checkout, bun } = fixture();
    const paths = enginePaths(home);
    mkdirSync(paths.plistPath, { recursive: true });
    expect(() => installEngine({ platform: 'darwin', homeDir: home, exec: fakeLaunchctl().exec, fromCheckout: checkout, bunBin: bun }))
      .toThrow('is not a regular file');
    expect(existsSync(paths.configPath)).toBe(false);
  });

  test('a fresh Mac gets the keyless policy seeded', () => {
    const { home, checkout, bun } = fixture();
    const result = installEngine({ platform: 'darwin', homeDir: home, exec: fakeLaunchctl().exec, fromCheckout: checkout, bunBin: bun, env: {} });
    expect(result.sovereignty).toMatchObject({ action: 'seeded', preset: 'no-sensitive' });
    expect(result.seeded_sovereignty).toBe('no-sensitive');
    expect(existsSync(enginePaths(home).sovereigntyPath)).toBe(true);
  });

  const blockers: Array<[string, (home: string, root: string) => Record<string, string>, string]> = [
    ['an OpenClaw config with an Olympus entry', (home) => {
      mkdirSync(join(home, '.openclaw'), { recursive: true });
      writeFileSync(join(home, '.openclaw', 'openclaw.json'), JSON.stringify({ plugins: { entries: { olympus: { config: {} } }, installs: { olympus: { source: 'npm' } } } }));
      return {};
    }, 'OpenClaw is configured to run Olympus'],
    ['an OpenClaw config whose Olympus entry has the plugin in its extensions folder', (home) => {
      mkdirSync(join(home, '.openclaw', 'extensions', 'olympus'), { recursive: true });
      writeFileSync(join(home, '.openclaw', 'openclaw.json'), JSON.stringify({ plugins: { entries: { olympus: { enabled: true } } } }));
      return {};
    }, 'OpenClaw is configured to run Olympus'],
    ['an OpenClaw config loading Olympus from a path', (home) => {
      mkdirSync(join(home, '.openclaw'), { recursive: true });
      writeFileSync(join(home, '.openclaw', 'openclaw.json'), JSON.stringify({ plugins: { entries: { olympus: {} }, load: { paths: ['/Users/me/Code/Olympus'] } } }));
      return {};
    }, 'OpenClaw is configured to run Olympus'],
    ['a JSON5 OpenClaw config named by OPENCLAW_CONFIG_PATH', (_home, root) => {
      const path = join(root, 'state', 'openclaw.json');
      mkdirSync(join(root, 'state'), { recursive: true });
      writeFileSync(path, '{\n  // comments make this JSON5\n  plugins: { entries: { olympus: { enabled: true } } },\n}\n');
      return { OPENCLAW_CONFIG_PATH: path };
    }, 'OpenClaw is configured to run Olympus'],
    ['a worker environment with a Venice key', (home) => {
      mkdirSync(join(home, '.config', 'olympus'), { recursive: true, mode: 0o700 });
      writeFileSync(join(home, '.config', 'olympus', 'worker.env'), 'PATH=/usr/bin\nVENICE_API_KEY=abc\n', { mode: 0o600 });
      return {};
    }, 'already sets VENICE_API_KEY'],
    ['a worker environment naming a policy file', (home) => {
      mkdirSync(join(home, '.config', 'olympus'), { recursive: true, mode: 0o700 });
      writeFileSync(join(home, '.config', 'olympus', 'worker.env'), 'OLYMPUS_SOVEREIGNTY_CONFIG=/elsewhere/policy.json\n', { mode: 0o600 });
      return {};
    }, 'already sets OLYMPUS_SOVEREIGNTY_CONFIG'],
    ['the legacy worker LaunchAgent', (home) => {
      mkdirSync(join(home, 'Library', 'LaunchAgents'), { recursive: true, mode: 0o700 });
      writeFileSync(join(home, 'Library', 'LaunchAgents', 'com.openclaw.olympus.worker.plist'), '<plist/>');
      return {};
    }, 'olympus worker install'],
  ];
  for (const [name, arrange, reason] of blockers) {
    test(`${name} keeps its policy: no sovereignty.json is seeded, and install says why`, () => {
      const { root, home, checkout, bun } = fixture();
      const env = arrange(home, root);
      const result = installEngine({ platform: 'darwin', homeDir: home, exec: fakeLaunchctl().exec, fromCheckout: checkout, bunBin: bun, env });
      expect(result.sovereignty.action).toBe('skipped');
      expect(result.sovereignty.reason).toContain(reason);
      expect(result.seeded_sovereignty).toBeUndefined();
      expect(existsSync(enginePaths(home).sovereigntyPath)).toBe(false);
      expect(result.warnings.some((warning) => warning.includes('was not created'))).toBe(true);
    });
  }

  for (const [name, config] of [
    ['a leftover Olympus entry with no installed plugin', { plugins: { entries: { olympus: { enabled: true } }, allow: ['olympus'] } }],
    ['a disabled Olympus plugin', { plugins: { entries: { olympus: { enabled: false } }, installs: { olympus: { source: 'npm' } } } }],
  ] as const) {
    test(`${name} in OpenClaw does not block the seed`, () => {
      const { home } = fixture();
      mkdirSync(join(home, '.openclaw'), { recursive: true });
      writeFileSync(join(home, '.openclaw', 'openclaw.json'), JSON.stringify(config));
      expect(engineSovereigntySeedBlocker({ homeDir: home, workerEnvPath: enginePaths(home).workerEnvPath, env: {} })).toBeUndefined();
    });
  }

  test('an OpenClaw config without Olympus does not block the seed', () => {
    const { home, checkout, bun } = fixture();
    mkdirSync(join(home, '.openclaw'), { recursive: true });
    writeFileSync(join(home, '.openclaw', 'openclaw.json'), JSON.stringify({ plugins: { entries: { other: {} } } }));
    expect(engineSovereigntySeedBlocker({ homeDir: home, workerEnvPath: enginePaths(home).workerEnvPath, env: {} })).toBeUndefined();
    const result = installEngine({ platform: 'darwin', homeDir: home, exec: fakeLaunchctl().exec, fromCheckout: checkout, bunBin: bun, env: {} });
    expect(result.sovereignty.action).toBe('seeded');
    // A second install leaves the file alone.
    const again = installEngine({ platform: 'darwin', homeDir: home, exec: fakeLaunchctl().exec, fromCheckout: checkout, bunBin: bun, env: {} });
    expect(again.sovereignty.action).toBe('present');
  });

  test('uninstall lists everything it keeps, with the size of the downloaded models', () => {
    const { home, checkout, bun } = fixture();
    const launchctl = fakeLaunchctl();
    const service = { platform: 'darwin', homeDir: home, uid: 501, exec: launchctl.exec };
    installEngine({ ...service, fromCheckout: checkout, bunBin: bun, env: {} });
    const paths = enginePaths(home);
    mkdirSync(join(paths.modelsDir, 'built-in-reasoning', 'm'), { recursive: true });
    writeFileSync(join(paths.modelsDir, 'built-in-reasoning', 'm', 'model.gguf'), new Uint8Array(3_000));
    writeFileSync(join(paths.modelsDir, 'status.json'), '{}');
    mkdirSync(paths.remoteAccessDir, { recursive: true });
    mkdirSync(paths.runtimeDir, { recursive: true });
    const removed = uninstallEngine(service);
    const kept = Object.fromEntries(removed.kept.map((item) => [item.path, item]));
    expect(Object.keys(kept)).toEqual(expect.arrayContaining([
      paths.configPath, paths.sovereigntyPath, paths.workerEnvPath, paths.logDir, paths.modelsDir, paths.remoteAccessDir, paths.runtimeDir,
    ]));
    expect(kept[paths.modelsDir]!.bytes).toBe(3_002);
    expect(kept[paths.sovereigntyPath]!.what).toContain('sovereignty.json');
    expect(kept[paths.remoteAccessDir]!.what).toContain('relay');
    expect(removed.next).toContain('olympus data delete --all');
    // Paths that do not exist are not listed.
    expect(kept[paths.previousAppDir]).toBeUndefined();
  });
});
