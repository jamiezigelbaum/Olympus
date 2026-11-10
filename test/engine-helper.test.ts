import { afterEach, describe, expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { engineStatusReport, runEngineCommand, parseInstallHelperArgs } from '../src/core/engine-cli.ts';
import { installEngineHelper, parseCodesignDetails } from '../src/core/engine-helper.ts';
import {
  ENGINE_HELPER_BUNDLE_ID,
  ENGINE_LABEL,
  enginePaths,
  installEngine,
  installedEngineHelper,
  installedProgram,
  recoverInterruptedHelperSwap,
  renderEnginePlist,
  uninstallEngine,
  type EngineExec,
} from '../src/core/engine-service.ts';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'olympus-helper-'));
  roots.push(root);
  const home = join(root, 'home');
  mkdirSync(home, { mode: 0o700 });
  const checkout = join(root, 'checkout');
  mkdirSync(join(checkout, 'dist'), { recursive: true });
  writeFileSync(join(checkout, 'package.json'), JSON.stringify({ name: 'olympus-source-checkout' }));
  writeFileSync(join(checkout, 'dist', 'cli.js'), '// fixture\n');
  const bun = join(root, 'bun');
  writeFileSync(bun, '#!/bin/sh\n');
  chmodSync(bun, 0o755);
  return { root, home, checkout, bun };
}

function installFakeHelper(home: string): string {
  const paths = enginePaths(home);
  mkdirSync(join(paths.helperAppPath!, 'Contents', 'MacOS'), { recursive: true });
  writeFileSync(paths.helperExecutablePath!, '#!/bin/sh\n');
  chmodSync(paths.helperExecutablePath!, 0o755);
  return paths.helperExecutablePath!;
}

function launchctl(): { exec: EngineExec; loaded: () => boolean } {
  let loaded = false;
  return {
    loaded: () => loaded,
    exec: (_command, args) => {
      if (args[0] === 'print') return loaded
        ? { status: 0, stdout: `${ENGINE_LABEL} = {\n\tstate = running\n\tpid = 1\n}\n`, stderr: '' }
        : { status: 113, stdout: '', stderr: 'Could not find service' };
      if (args[0] === 'bootstrap') loaded = true;
      if (args[0] === 'bootout') loaded = false;
      return { status: 0, stdout: '', stderr: '' };
    },
  };
}

const program = {
  runtimePath: '/Users/friend/Library/Application Support/Olympus/runtime/bun',
  entryPath: '/Users/friend/Library/Application Support/Olympus/app/dist/cli.js',
  workingDirectory: '/Users/friend/Library/Application Support/Olympus/app',
  source: 'package' as const,
};
const HELPER = '/Users/friend/Library/Application Support/Olympus/Olympus Engine.app/Contents/MacOS/OlympusEngineHost';

describe('engine plist with and without the helper', () => {
  test('without the helper it is today\'s Bun-direct plist, byte for byte', () => {
    const plist = renderEnginePlist({ paths: enginePaths('/Users/friend'), homeDir: '/Users/friend', program });
    expect(plist).toContain(`<array>\n    <string>${program.runtimePath}</string>\n    <string>--no-env-file</string>`);
    expect(plist).not.toContain('AssociatedBundleIdentifiers');
    expect(plist).not.toContain('OlympusEngineHost');
  });

  test('with the helper, launchd runs the helper first and it is told which app to name', () => {
    const plist = renderEnginePlist({ paths: enginePaths('/Users/friend'), homeDir: '/Users/friend', program: { ...program, helperPath: HELPER } });
    expect(plist).toContain(`<array>\n    <string>${HELPER}</string>\n    <string>${program.runtimePath}</string>\n    <string>--no-env-file</string>\n    <string>${program.entryPath}</string>\n    <string>__engine-run</string>\n  </array>`);
    expect(plist).toContain(`<key>AssociatedBundleIdentifiers</key>\n  <array>\n    <string>${ENGINE_HELPER_BUNDLE_ID}</string>`);
    // Everything else is the same: keep-alive rules, logs, environment.
    const direct = renderEnginePlist({ paths: enginePaths('/Users/friend'), homeDir: '/Users/friend', program });
    const strip = (text: string) => text.replace(/\n    <string>[^\n]*OlympusEngineHost<\/string>/, '').replace(/\n  <key>AssociatedBundleIdentifiers<\/key>\n  <array>\n[^\n]*\n  <\/array>/, '');
    expect(strip(plist)).toBe(direct);
  });

  test('installedProgram reads both shapes', () => {
    const { home } = fixture();
    const paths = enginePaths(home);
    mkdirSync(join(paths.plistPath, '..'), { recursive: true });
    writeFileSync(paths.plistPath, renderEnginePlist({ paths, homeDir: home, program }));
    expect(installedProgram(paths.plistPath)).toEqual({ runtimePath: program.runtimePath, entryPath: program.entryPath });
    writeFileSync(paths.plistPath, renderEnginePlist({ paths, homeDir: home, program: { ...program, helperPath: HELPER } }));
    expect(installedProgram(paths.plistPath)).toEqual({ runtimePath: program.runtimePath, entryPath: program.entryPath, helperPath: HELPER });
  });
});

describe('install picks the helper up when it is there', () => {
  test('no helper: Bun runs directly; helper installed: the plist changes and the loaded agent is reloaded', () => {
    const { home, checkout, bun } = fixture();
    const fake = launchctl();
    const options = { platform: 'darwin', homeDir: home, uid: 501, exec: fake.exec, fromCheckout: checkout, bunBin: bun };
    const paths = enginePaths(home);
    expect(installedEngineHelper(paths)).toBeUndefined();
    expect(installEngine(options).program.helperPath).toBeUndefined();
    expect(installedProgram(paths.plistPath)?.helperPath).toBeUndefined();

    const helper = installFakeHelper(home);
    expect(installedEngineHelper(paths)).toBe(helper);
    const second = installEngine(options);
    expect(second.action).toBe('reloaded');
    expect(second.program.helperPath).toBe(helper);
    expect(installedProgram(paths.plistPath)).toEqual({ runtimePath: bun, entryPath: join(checkout, 'dist', 'cli.js'), helperPath: helper });
  });

  test('a helper that is not an executable file does not count', () => {
    const { home } = fixture();
    const paths = enginePaths(home);
    mkdirSync(join(paths.helperAppPath!, 'Contents', 'MacOS'), { recursive: true });
    writeFileSync(paths.helperExecutablePath!, 'x');
    chmodSync(paths.helperExecutablePath!, 0o644);
    expect(installedEngineHelper(paths)).toBeUndefined();
  });

  test('uninstall keeps the helper and says so', () => {
    const { home, checkout, bun } = fixture();
    const fake = launchctl();
    installFakeHelper(home);
    installEngine({ platform: 'darwin', homeDir: home, uid: 501, exec: fake.exec, fromCheckout: checkout, bunBin: bun });
    const result = uninstallEngine({ platform: 'darwin', homeDir: home, uid: 501, exec: fake.exec });
    expect(result.kept.map((item) => item.path)).toContain(enginePaths(home).helperAppPath!);
    expect(existsSync(enginePaths(home).helperAppPath!)).toBe(true);
  });
});

describe('engine status knows about the helper', () => {
  const report = (home: string, exec: EngineExec) => engineStatusReport({
    homeDir: home, platform: 'darwin', env: { HOME: home }, exec, openclawPath: () => undefined,
    fetchImpl: (async () => Response.json({ ok: true })) as unknown as typeof fetch,
  }) as Promise<Record<string, any>>;

  test('not installed, installed but not yet used by the agent, and in use', async () => {
    const { home, checkout, bun } = fixture();
    const fake = launchctl();
    const service = { platform: 'darwin', homeDir: home, uid: 501, exec: fake.exec, fromCheckout: checkout, bunBin: bun };
    installEngine(service);
    const none = await report(home, fake.exec);
    expect(none.helper).toEqual({ installed: false, in_use: false, path: enginePaths(home).helperAppPath });
    installFakeHelper(home);
    const waiting = await report(home, fake.exec);
    expect(waiting.helper).toMatchObject({ installed: true, in_use: false });
    expect(waiting.ok).toBe(false);
    expect(waiting.missing).toContain('The Olympus helper app is installed but the engine agent does not use it yet: run olympus engine install.');
    installEngine(service);
    const using = await report(home, fake.exec);
    expect(using.helper).toMatchObject({ installed: true, in_use: true });
    expect(using.missing.join(' ')).not.toContain('helper app');
    // The helper app is deleted while the agent's plist still launches through it.
    rmSync(enginePaths(home).helperAppPath!, { recursive: true, force: true });
    const gone = await report(home, fake.exec);
    expect(using.missing.join(' ')).not.toContain('install-helper');
    expect(gone.ok).toBe(false);
    expect(gone.helper).toMatchObject({ installed: false, in_use: true, missing_but_referenced: true });
    expect(gone.missing.join(' ')).toContain('olympus engine install-helper');
  });
});

describe('olympus engine install-helper', () => {
  const GOOD = [
    'Executable=/x/OlympusEngineHost', 'Identifier=ai.olympusplugin.engine-host', 'Format=app bundle with Mach-O universal (x86_64 arm64)',
    'CodeDirectory v=20500 size=328 flags=0x10000(runtime) hashes=3+3 location=embedded',
    'Authority=Developer ID Application: Example Org (ABCDE12345)', 'TeamIdentifier=ABCDE12345',
  ].join('\n');

  test('reads codesign output', () => {
    expect(parseCodesignDetails(GOOD)).toEqual({ identifier: ENGINE_HELPER_BUNDLE_ID, teamId: 'ABCDE12345', developerId: true, adHoc: false, hardened: true });
    const adhoc = parseCodesignDetails('Identifier=ai.olympusplugin.engine-host\nCodeDirectory v=20400 flags=0x2(adhoc) hashes=3\nSignature=adhoc\nTeamIdentifier=not set');
    expect(adhoc).toMatchObject({ developerId: false, adHoc: true, teamId: null });
  });

  function prebuilt(root: string): string {
    const app = join(root, 'Prebuilt.app');
    mkdirSync(join(app, 'Contents', 'MacOS'), { recursive: true });
    writeFileSync(join(app, 'Contents', 'Info.plist'), '<plist/>');
    writeFileSync(join(app, 'Contents', 'MacOS', 'OlympusEngineHost'), 'bin');
    return app;
  }
  const codesign = (details: string, verifyStatus = 0): EngineExec => (command, args) => {
    if (command === '/usr/bin/codesign' && args[0] === '--verify') return { status: verifyStatus, stdout: '', stderr: verifyStatus ? 'a sealed resource is missing' : '' };
    if (command === '/usr/bin/codesign') return { status: 0, stdout: '', stderr: details };
    if (command === '/usr/bin/ditto') {
      mkdirSync(args[1]!, { recursive: true });
      writeFileSync(join(args[1]!, 'copied'), '1');
      return { status: 0, stdout: '', stderr: '' };
    }
    throw new Error(`unexpected ${command}`);
  };

  test('installs a verified Developer ID app and replaces an older one', () => {
    const { root, home } = fixture();
    const app = prebuilt(root);
    const first = installEngineHelper({ platform: 'darwin', homeDir: home, from: app, exec: codesign(GOOD) });
    expect(first).toMatchObject({ ok: true, app_path: enginePaths(home).helperAppPath, team_id: 'ABCDE12345', replaced: false, built: false });
    expect(existsSync(join(first.app_path, 'copied'))).toBe(true);
    expect(installEngineHelper({ platform: 'darwin', homeDir: home, from: app, exec: codesign(GOOD) }).replaced).toBe(true);
  });

  test('keeps the previous app when the final rename fails, and refuses unhardened or wrong-team apps', () => {
    const { root, home } = fixture();
    const app = prebuilt(root);
    const base = { platform: 'darwin', homeDir: home, from: app, exec: codesign(GOOD) };
    const first = installEngineHelper(base);
    writeFileSync(join(first.app_path, 'marker'), 'old');
    let calls = 0;
    const failing = (from: string, to: string) => {
      calls += 1;
      if (calls === 2) throw new Error('disk full');
      renameSync(from, to);
    };
    expect(() => installEngineHelper({ ...base, rename: failing })).toThrow('previous helper app was kept');
    expect(readFileSync(join(first.app_path, 'marker'), 'utf8')).toBe('old');
    expect(() => installEngineHelper({ ...base, exec: codesign(GOOD.replace('(runtime)', '(0x0)').replace('0x10000', '0x0')) })).toThrow('hardened runtime');
    expect(() => installEngineHelper({ ...base, expectedTeamId: 'ZZZZZZZZZZ' })).toThrow('not the expected team');
    expect(() => installEngineHelper({ ...base, env: { OLYMPUS_MACOS_HELPER_TEAM_ID: 'ZZZZZZZZZZ' } })).toThrow('not the expected team');
    expect(installEngineHelper({ ...base, expectedTeamId: 'ABCDE12345' }).replaced).toBe(true);
  });

  test('refuses a copy whose signature no longer verifies', () => {
    const { root, home } = fixture();
    const app = prebuilt(root);
    let verifies = 0;
    const inner = codesign(GOOD);
    const exec: EngineExec = (command, args) => (command === '/usr/bin/codesign' && args[0] === '--verify' && ++verifies === 2
      ? { status: 1, stdout: '', stderr: 'copy broken' } : inner(command, args));
    expect(() => installEngineHelper({ platform: 'darwin', homeDir: home, from: app, exec })).toThrow('copied helper app');
    expect(existsSync(enginePaths(home).helperAppPath!)).toBe(false);
  });

  test('refuses an unverifiable, mis-named or ad hoc app, and a missing identity, and Linux', () => {
    const { root, home } = fixture();
    const app = prebuilt(root);
    const base = { platform: 'darwin', homeDir: home, from: app };
    expect(() => installEngineHelper({ ...base, exec: codesign(GOOD, 1) })).toThrow('does not verify');
    expect(() => installEngineHelper({ ...base, exec: codesign(GOOD.replace('ai.olympusplugin.engine-host', 'com.other.app')) })).toThrow('not ai.olympusplugin.engine-host');
    expect(() => installEngineHelper({ ...base, exec: codesign('Identifier=ai.olympusplugin.engine-host\nSignature=adhoc\nTeamIdentifier=not set') })).toThrow('not signed with a Developer ID');
    expect(() => installEngineHelper({ platform: 'darwin', homeDir: home, env: {}, exec: codesign(GOOD) })).toThrow('needs a Developer ID signing identity');
    expect(() => installEngineHelper({ platform: 'linux', homeDir: home })).toThrow('for macOS');
    expect(existsSync(enginePaths(home).helperAppPath!)).toBe(false);
  });

  test('the CLI installs the helper, then reloads an installed engine through it, keeping its build and Bun', async () => {
    const { root, home, checkout, bun } = fixture();
    const fake = launchctl();
    const service = { platform: 'darwin', homeDir: home, uid: 501, exec: fake.exec };
    installEngine({ ...service, fromCheckout: checkout, bunBin: bun });
    let placed = '';
    const helper = installFakeHelper(home);
    const result = await runEngineCommand(['install-helper', '--from', prebuilt(root)], {
      ...service,
      health: { timeoutMs: 20, pollMs: 5, pidAlive: () => true, fetchImpl: (async () => new Response('{"ok":true}')) as unknown as typeof fetch },
      installHelper: (options) => {
        placed = options.from ?? '';
        return { ok: true, app_path: enginePaths(home).helperAppPath!, executable_path: helper, bundle_id: ENGINE_HELPER_BUNDLE_ID, team_id: 'ABCDE12345', signed_with: 'developer_id', built: false, replaced: false };
      },
    }) as Record<string, any>;
    expect(placed).toContain('Prebuilt.app');
    expect(result.engine.action).toBe('reloaded');
    expect(installedProgram(enginePaths(home).plistPath)).toEqual({ runtimePath: bun, entryPath: join(checkout, 'dist', 'cli.js'), helperPath: helper });
    expect(readFileSync(enginePaths(home).plistPath, 'utf8')).toContain(ENGINE_HELPER_BUNDLE_ID);
  });

  test('replacing the helper of an engine already on it restarts the agent, so the new launcher runs', async () => {
    const { root, home, checkout, bun } = fixture();
    const fake = launchctl();
    const service = { platform: 'darwin', homeDir: home, uid: 501, exec: fake.exec };
    const helper = installFakeHelper(home);
    installEngine({ ...service, fromCheckout: checkout, bunBin: bun });
    let restarts = 0;
    const result = await runEngineCommand(['install-helper', '--from', prebuilt(root)], {
      ...service,
      health: { timeoutMs: 20, pollMs: 5, pidAlive: () => true, fetchImpl: (async () => new Response('{"ok":true}')) as unknown as typeof fetch },
      installHelper: () => ({ ok: true, app_path: enginePaths(home).helperAppPath!, executable_path: helper, bundle_id: ENGINE_HELPER_BUNDLE_ID, team_id: 'ABCDE12345', signed_with: 'developer_id', built: false, replaced: true }),
      restartEngine: () => { restarts += 1; return { ok: true, command: [] }; },
    }) as Record<string, any>;
    expect(result.engine.action).toBe('unchanged');
    expect(restarts).toBe(1);
    expect(result.restarted_engine).toBe(true);
    expect(result.ok).toBe(false); // No fresh health proof after restart.
  });

  test('reports failed activation when the engine is unhealthy', async () => {
    const { root, home, checkout, bun } = fixture();
    const fake = launchctl();
    const service = { platform: 'darwin', homeDir: home, uid: 501, exec: fake.exec };
    installEngine({ ...service, fromCheckout: checkout, bunBin: bun });
    const helper = installFakeHelper(home);
    const result = await runEngineCommand(['install-helper', '--from', prebuilt(root)], {
      ...service, health: { timeoutMs: 0 },
      installHelper: () => ({ ok: true, app_path: enginePaths(home).helperAppPath!, executable_path: helper, bundle_id: ENGINE_HELPER_BUNDLE_ID, team_id: 'ABCDE12345', signed_with: 'developer_id', built: false, replaced: false }),
    }) as Record<string, any>;
    expect(result.engine.ok).toBe(false);
    expect(result.ok).toBe(false);
  });

  test('arguments', () => {
    expect(parseInstallHelperArgs(['--from', '/a.app', '--identity', 'Developer ID Application: X'])).toEqual({ from: '/a.app', identity: 'Developer ID Application: X' });
    expect(() => parseInstallHelperArgs(['--from'])).toThrow('needs a value');
    expect(() => parseInstallHelperArgs(['--nope'])).toThrow('Unknown');
  });

  // #693: what a stop between the two renames leaves is no helper, and the old one in a staging folder.
  function interrupted(home: string, pid: number): string {
    const paths = enginePaths(home);
    const staging = join(paths.appSupportDir, `.helper-${pid}-abc123`);
    const aside = join(staging, 'previous.app');
    mkdirSync(join(aside, 'Contents', 'MacOS'), { recursive: true });
    writeFileSync(join(aside, 'Contents', 'MacOS', 'OlympusEngineHost'), '#!/bin/sh\n');
    chmodSync(join(aside, 'Contents', 'MacOS', 'OlympusEngineHost'), 0o755);
    writeFileSync(join(aside, 'marker'), 'old');
    mkdirSync(join(staging, 'copy.app'), { recursive: true });
    return aside;
  }
  const dead = () => false;

  test('after an interrupted replacement, the next engine install puts the previous helper back before writing the plist', () => {
    const { home, checkout, bun } = fixture();
    interrupted(home, 999_999);
    const paths = enginePaths(home);
    expect(existsSync(paths.helperAppPath!)).toBe(false);
    installEngine({ platform: 'darwin', homeDir: home, uid: 501, exec: launchctl().exec, fromCheckout: checkout, bunBin: bun, helperRecovery: { pidAlive: dead } });
    expect(readFileSync(join(paths.helperAppPath!, 'marker'), 'utf8')).toBe('old');
    expect(installedProgram(paths.plistPath)?.helperPath).toBe(paths.helperExecutablePath);
    expect(readdirSync(paths.appSupportDir).filter(name => name.startsWith('.helper-'))).toEqual([]);
  });

  test('a replacement stopped between the renames keeps the previous app, and install-helper recovers it first', () => {
    const { root, home } = fixture();
    const app = prebuilt(root);
    const base = { platform: 'darwin', homeDir: home, from: app, exec: codesign(GOOD) };
    const first = installEngineHelper(base);
    writeFileSync(join(first.app_path, 'marker'), 'old');
    let calls = 0;
    // The first rename moves the old app aside; nothing after it gets done.
    const stopped = (from: string, to: string) => {
      calls += 1;
      if (calls >= 2) throw new Error('interrupted');
      renameSync(from, to);
    };
    expect(() => installEngineHelper({ ...base, rename: stopped })).toThrow();
    expect(existsSync(first.app_path)).toBe(false);
    // The previous app was not deleted with the staging folder.
    expect(recoverInterruptedHelperSwap(enginePaths(home), { pidAlive: dead })).toBe('restored');
    expect(readFileSync(join(first.app_path, 'marker'), 'utf8')).toBe('old');
    // install-helper recovers before it starts, so it replaces the old app rather than installing fresh.
    rmSync(first.app_path, { recursive: true });
    interrupted(home, 999_998);
    expect(installEngineHelper({ ...base, helperRecovery: { pidAlive: dead } }).replaced).toBe(true);
    expect(readdirSync(enginePaths(home).appSupportDir)).toEqual(['Olympus Engine.app']);
  });

  test('a recovery that another process finished first does not fail (#693 review)', () => {
    const { home } = fixture();
    const paths = enginePaths(home);
    interrupted(home, 999_997);
    const rival = (from: string, to: string) => {
      renameSync(from, to); // the other process restores the helper first
      renameSync(from, to); // then this one's rename finds nothing to move
    };
    expect(recoverInterruptedHelperSwap(paths, { pidAlive: dead, rename: rival })).toBe('cleaned');
    expect(existsSync(paths.helperAppPath!)).toBe(true);
    expect(readdirSync(paths.appSupportDir)).toEqual(['Olympus Engine.app']);
  });

  test('a replacement still running in another process is left alone; a stale folder beside a helper is cleared', () => {
    const { home } = fixture();
    const paths = enginePaths(home);
    interrupted(home, 4242);
    expect(recoverInterruptedHelperSwap(paths, { pidAlive: pid => pid === 4242 })).toBe('none');
    expect(existsSync(paths.helperAppPath!)).toBe(false);
    expect(readdirSync(paths.appSupportDir)).toEqual(['.helper-4242-abc123']);
    installFakeHelper(home);
    expect(recoverInterruptedHelperSwap(paths, { pidAlive: dead })).toBe('cleaned');
    expect(readdirSync(paths.appSupportDir)).toEqual(['Olympus Engine.app']);
    expect(recoverInterruptedHelperSwap(paths, { pidAlive: dead })).toBe('none');
  });
});

