/**
 * The one-click install of Tor and zkapi-clientd (src/core/managed-tools.ts),
 * its discovery by the zkAPI consult transport, its dashboard route and its
 * card section. Design docs/design/private-answers.md, "One-click install".
 *
 * No test touches the network or runs a downloaded program: archives are
 * built here and served by an injected fetch under fixture pins, and the
 * version check is a seam. The transport-discovery test runs one fixture
 * shell script, written by the test.
 */
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { afterEach, describe, expect, test } from 'bun:test';
import { recordRequestPeer } from '../src/core/request-peer.ts';
import { resolveZkapiExecutable } from '../src/core/consult-transport-zkapi.ts';
import {
  createManagedToolsJob,
  installManagedTools,
  managedToolExecutable,
  managedToolsBase,
  managedToolsPlatform,
  managedToolsRoot,
  MANAGED_TOOL_PINS,
  type ManagedToolName,
  type ManagedToolsCommandRunner,
  type ManagedToolPin,
  type ManagedToolsInstallOptions,
  type ManagedToolsProgressEvent,
  type ManagedToolVersionCheck,
} from '../src/core/managed-tools.ts';
import { V0_4_PUBLIC_CLI_COMMANDS, V0_4_PUBLIC_DASHBOARD_ROUTES } from '../src/core/public-surface.ts';
import { DASHBOARD_OUTSIDE_HELP_PATHS, renderOutsideHelpCard } from '../src/workers/dashboard/outside-help.ts';
import type { DashboardOutsideHelpReadiness } from '../src/workers/dashboard/outside-help.ts';
import {
  DASHBOARD_OUTSIDE_HELP_INSTALL_TOOLS_PATH,
  renderOutsideHelpTools,
  renderOutsideHelpToolsFix,
  renderOutsideHelpToolsScript,
  type DashboardOutsideHelpTools,
} from '../src/workers/dashboard/outside-help-tools.ts';
import { DEFAULT_CONSULT_DOMAIN_PACKS } from '../src/core/consult-gate.ts';
import { createDashboardConsultAdapter, dashboardInstallView } from '../src/workers/email-source/dashboard-consult.ts';
import { loadSovereigntyPreset, type SovereigntyConfig } from '../src/core/sovereignty.ts';
import { DASHBOARD_CONSULT_CONTROL_PATHS, DASHBOARD_LOCAL_CONTROL_SESSION_PATH, withWorkerBearerAuth } from '../src/workers/http.ts';
import { DashboardLaunchTickets } from '../src/core/dashboard-launch.ts';

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()!();
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'olympus-managed-tools-'));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// ---------------------------------------------------------------------------
// Fixture archives: a minimal ustar writer.

interface FixtureEntry {
  name: string;
  type?: '0' | '1' | '2' | '3' | '5' | 'x';
  data?: string | Buffer;
  mode?: number;
  link?: string;
}

function octalField(header: Buffer, offset: number, length: number, value: number): void {
  header.write(value.toString(8).padStart(length - 1, '0'), offset, length - 1, 'latin1');
  header[offset + length - 1] = 0;
}

function tarBlock(entry: FixtureEntry): Buffer {
  const data = typeof entry.data === 'string' ? Buffer.from(entry.data) : entry.data ?? Buffer.alloc(0);
  const header = Buffer.alloc(512);
  header.write(entry.name, 0, 100, 'utf8');
  octalField(header, 100, 8, entry.mode ?? (entry.type === '5' ? 0o755 : 0o644));
  octalField(header, 108, 8, 0);
  octalField(header, 116, 8, 0);
  octalField(header, 124, 12, data.length);
  octalField(header, 136, 12, 1_700_000_000);
  header.fill(0x20, 148, 156);
  header.write(entry.type ?? '0', 156, 1, 'latin1');
  if (entry.link) header.write(entry.link, 157, 100, 'utf8');
  header.write('ustar\0', 257, 6, 'latin1');
  header.write('00', 263, 2, 'latin1');
  let sum = 0;
  for (const byte of header) sum += byte;
  header.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'latin1');
  const padded = Buffer.alloc(Math.ceil(data.length / 512) * 512);
  data.copy(padded);
  return Buffer.concat([header, padded]);
}

function paxRecord(key: string, value: string): string {
  const body = ` ${key}=${value}\n`;
  let length = body.length + 1;
  while (`${length}${body}`.length !== length) length += 1;
  return `${length}${body}`;
}

function tarGz(entries: FixtureEntry[]): Buffer {
  return gzipSync(Buffer.concat([...entries.map(tarBlock), Buffer.alloc(1024)]));
}

const LONG_PATH = `share/zkapi-clientd/third-party/${'x'.repeat(90)}/LICENSE`;

function zkapiEntries(): FixtureEntry[] {
  return [
    { name: 'zkapi-clientd', data: '#!/bin/sh\necho "zkapi-clientd 0.1.6"\n', mode: 0o755 },
    { name: 'zkapi-walletd', data: 'walletd', mode: 0o755 },
    { name: 'share/', type: '5' },
    { name: 'share/zkapi-clientd/', type: '5' },
    { name: 'share/zkapi-clientd/build-info.json', data: '{}' },
    { name: 'share/zkapi-clientd/proof-setup/manifest.json', data: '{}' },
    { name: 'share/zkapi-clientd/proof-setup/request.pk', data: 'pk' },
    { name: 'share/zkapi-clientd/proof-setup/request.vk', data: 'vk' },
    { name: 'share/zkapi-clientd/proof-setup/withdrawal.pk', data: 'pk' },
    { name: 'share/zkapi-clientd/proof-setup/withdrawal.vk', data: 'vk' },
    // A pax header carrying a path longer than the ustar name field, as the real bundle has.
    { name: 'PaxHeaders/LICENSE', type: 'x', data: paxRecord('path', LONG_PATH) },
    { name: 'share/zkapi-clientd/third-party/x/LICENSE', data: 'MIT' },
  ];
}

function torEntries(extra: FixtureEntry[] = []): FixtureEntry[] {
  return [
    { name: 'tor/', type: '5', mode: 0o700 },
    { name: 'tor/tor', data: '#!/bin/sh\necho "Tor version 0.4.9.13."\n', mode: 0o700 },
    { name: 'tor/libevent-2.1.7.dylib', data: 'lib', mode: 0o700 },
    { name: 'data/geoip', data: 'geo', mode: 0o600 },
    ...extra,
  ];
}

const sha256 = (data: Buffer): string => createHash('sha256').update(data).digest('hex');

/** Fixture pins for darwin-arm64 (Tor's macOS layout) and linux-x64, serving the given archives. */
function fixturePins(archives: { tor: Buffer; zkapi: Buffer }): Record<ManagedToolName, ManagedToolPin> {
  const real = MANAGED_TOOL_PINS;
  const torMac = real.tor.assets['darwin-arm64']!;
  const zk = real['zkapi-clientd'].assets['darwin-arm64']!;
  const torAsset = { ...torMac, url: 'https://fixture.test/tor.tar.gz', sha256: sha256(archives.tor), bytes: archives.tor.length };
  const zkAsset = { ...zk, url: 'https://fixture.test/zkapi.tar.gz', sha256: sha256(archives.zkapi), bytes: archives.zkapi.length };
  return {
    tor: { ...real.tor, assets: { 'darwin-arm64': torAsset, 'linux-x64': torAsset } },
    'zkapi-clientd': { ...real['zkapi-clientd'], assets: { 'darwin-arm64': zkAsset, 'linux-x64': zkAsset } },
  };
}

function servingFetch(files: Record<string, Buffer>, log: string[] = []): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = String(input instanceof Request ? input.url : input);
    log.push(url);
    const body = files[url];
    if (!body) return new Response('missing', { status: 404 });
    return new Response(new Uint8Array(body), { headers: { 'content-length': String(body.length) } });
  }) as typeof fetch;
}

const okVersion: ManagedToolVersionCheck = async (executable) => ({
  ok: true,
  stdout: executable.endsWith('zkapi-clientd') ? 'zkapi-clientd 0.1.6 (darwin/arm64)\n' : 'Tor version 0.4.9.13.\n',
});

function setup(input: { tor?: Buffer; zkapi?: Buffer; platform?: NodeJS.Platform; served?: Partial<Record<'tor' | 'zkapi', Buffer>> } = {}) {
  const home = tempDir();
  const tor = input.tor ?? tarGz(torEntries());
  const zkapi = input.zkapi ?? tarGz(zkapiEntries());
  const pins = fixturePins({ tor, zkapi });
  const fetched: string[] = [];
  const quarantined: string[] = [];
  const events: ManagedToolsProgressEvent[] = [];
  const commands: string[] = [];
  const platform = input.platform ?? 'darwin';
  const options: ManagedToolsInstallOptions = {
    env: { HOME: home },
    platform,
    arch: platform === 'darwin' ? 'arm64' : 'x64',
    pins,
    fetchImpl: servingFetch({ 'https://fixture.test/tor.tar.gz': input.served?.tor ?? tor, 'https://fixture.test/zkapi.tar.gz': input.served?.zkapi ?? zkapi }, fetched),
    versionCheck: okVersion,
    clearQuarantine: async (dir) => { quarantined.push(dir); },
    // A Mac where every file reads as already signed: nothing is re-signed.
    runCommand: async (command, args) => { commands.push(`${command} ${args.join(' ')}`); return { code: 0, stdout: '', stderr: 'Signature=adhoc' }; },
    onProgress: (event) => events.push(event),
    now: () => new Date('2026-10-07T12:00:00.000Z'),
  };
  const host = { env: { HOME: home }, platform, arch: options.arch!, pins };
  return { home, tor, zkapi, pins, options, host, fetched, quarantined, events, commands, root: managedToolsRoot(host)! };
}

function leftovers(dir: string): string[] {
  return existsSync(dir) ? readdirSync(dir).filter((name) => name.startsWith('.')) : [];
}

// ---------------------------------------------------------------------------

describe('the pins', () => {
  test('every pinned download is https from the upstream release, with a 64-hex SHA-256 and a size', () => {
    for (const pin of Object.values(MANAGED_TOOL_PINS)) {
      for (const asset of Object.values(pin.assets)) {
        expect(asset!.url.startsWith('https://github.com/ethereum/zkapi/releases/download/clientd-v0.1.6/') || asset!.url.startsWith('https://dist.torproject.org/torbrowser/15.0.24/')).toBe(true);
        expect(asset!.sha256).toMatch(/^[0-9a-f]{64}$/);
        expect(asset!.bytes).toBeGreaterThan(1_000_000);
      }
    }
    expect(MANAGED_TOOL_PINS['zkapi-clientd'].version).toBe('0.1.6');
    expect(Object.keys(MANAGED_TOOL_PINS['zkapi-clientd'].assets).sort()).toEqual(['darwin-arm64', 'darwin-x64', 'linux-arm64', 'linux-x64']);
    expect(Object.keys(MANAGED_TOOL_PINS.tor.assets).sort()).toEqual(['darwin-arm64', 'darwin-x64', 'linux-ia32', 'linux-x64']);
  });

  test('the folder: Application Support on macOS, XDG_DATA_HOME or ~/.local/share on Linux', () => {
    expect(managedToolsRoot({ env: { HOME: '/Users/a' }, platform: 'darwin' })).toBe('/Users/a/Library/Application Support/Olympus/tools');
    expect(managedToolsRoot({ env: { HOME: '/home/a' }, platform: 'linux' })).toBe('/home/a/.local/share/olympus/tools');
    expect(managedToolsRoot({ env: { HOME: '/home/a', XDG_DATA_HOME: '/data' }, platform: 'linux' })).toBe('/data/olympus/tools');
    expect(managedToolsRoot({ env: { HOME: '/home/a', XDG_DATA_HOME: 'relative' }, platform: 'linux' })).toBe('/home/a/.local/share/olympus/tools');
    expect(managedToolsBase({ env: {}, platform: 'darwin' })).toBeUndefined();
    expect(managedToolsPlatform('win32', 'x64')).toBeUndefined();
    expect(managedToolsPlatform('linux', 'arm64')).toBe('linux-arm64');
  });
});

describe('installing', () => {
  test('installs both into owner-only version folders, writes the manifest, clears quarantine on staging only, and discovery finds them', async () => {
    const f = setup();
    const result = await installManagedTools(f.options);
    expect(result.ok).toBe(true);
    expect(result.tools.map((tool) => tool.outcome)).toEqual(['installed', 'installed']);
    const torDir = join(f.root, 'tor', '15.0.24');
    const zkDir = join(f.root, 'zkapi-clientd', '0.1.6');
    for (const dir of [managedToolsBase(f.host)!, f.root, join(f.root, 'tor'), torDir, zkDir, join(zkDir, 'share', 'zkapi-clientd')]) {
      expect(statSync(dir).mode & 0o777).toBe(0o700);
    }
    expect(statSync(join(zkDir, 'bin', 'zkapi-clientd')).mode & 0o777).toBe(0o700);
    expect(statSync(join(zkDir, 'share', 'zkapi-clientd', 'build-info.json')).mode & 0o777).toBe(0o600);
    // The bundle's root programs moved to bin/, beside share/; the pax long path kept.
    expect(existsSync(join(zkDir, 'zkapi-clientd'))).toBe(false);
    expect(readFileSync(join(zkDir, LONG_PATH), 'utf8')).toBe('MIT');
    const manifest = JSON.parse(readFileSync(join(zkDir, 'olympus-tool.json'), 'utf8'));
    expect(manifest).toEqual({
      schema: 1,
      tool: 'zkapi-clientd',
      version: '0.1.6',
      platform: 'darwin-arm64',
      asset: 'zkapi.tar.gz',
      sha256: sha256(f.zkapi),
      installedAt: '2026-10-07T12:00:00.000Z',
    });
    expect(managedToolExecutable('zkapi-clientd', f.host)).toBe(join(realRoot(f.root), 'zkapi-clientd', '0.1.6', 'bin', 'zkapi-clientd'));
    expect(managedToolExecutable('tor', f.host)).toBe(join(realRoot(f.root), 'tor', '15.0.24', 'tor', 'tor'));
    expect(f.quarantined).toHaveLength(2);
    for (const dir of f.quarantined) expect(dir).toMatch(/\/\.staging-[0-9a-f-]+$/);
    expect(f.events.map((event) => `${event.tool}:${event.phase}`).filter((value, index, all) => all.indexOf(value) === index))
      .toEqual(['tor:downloading', 'tor:checking', 'tor:installing', 'zkapi-clientd:downloading', 'zkapi-clientd:checking', 'zkapi-clientd:installing']);
    expect(leftovers(join(f.root, 'tor'))).toEqual([]);
    expect(leftovers(join(f.root, 'zkapi-clientd'))).toEqual([]);
  });

  test('Linux Tor gets a launcher that puts its bundled libraries on the library path; no quarantine step', async () => {
    const tor = tarGz([
      { name: 'tor/tor', data: 'elf', mode: 0o700 },
      { name: 'tor/libevent-2.1.so.7', data: 'lib' },
      { name: 'tor/libssl.so.3', data: 'lib' },
      { name: 'tor/libcrypto.so.3', data: 'lib' },
      { name: 'debug/tor', data: 'symbols' },
    ]);
    const f = setup({ tor, platform: 'linux' });
    const linuxTor = { ...MANAGED_TOOL_PINS.tor.assets['linux-x64']!, url: 'https://fixture.test/tor.tar.gz', sha256: sha256(tor), bytes: tor.length };
    const pins = { ...f.pins, tor: { ...f.pins.tor, assets: { 'linux-x64': linuxTor } } };
    const result = await installManagedTools({ ...f.options, pins, tools: ['tor'] });
    expect(result.tools[0]!.outcome).toBe('installed');
    const dir = join(f.root, 'tor', '15.0.24');
    const launcher = readFileSync(join(dir, 'bin', 'tor'), 'utf8');
    expect(launcher).toContain('LD_LIBRARY_PATH="$here/tor" exec "$here/tor/tor" "$@"');
    // No external command (PATH is kept in sessions): the folder comes from
    // $0 by shell parameter expansion, with a guard when it carries no slash.
    expect(launcher).not.toMatch(/\bdirname\b/);
    expect(launcher).toContain('here="${0%/*}/.."');
    // The launcher script text is the behavior here (it execs the real, fake
    // "tor" binary, which is not a runnable program in this fixture); so the
    // guard is driven directly through sh's own `-c script $0 [args]` form,
    // which sets $0 to the given value without any PATH search or directory
    // change (`exec -a`, used instead, is a bash extension dash lacks).
    const withSlash = Bun.spawnSync(['/bin/sh', '-c', launcher, join(dir, 'bin', 'tor'), '--help']);
    expect(new TextDecoder().decode(withSlash.stderr)).not.toContain('run it by its path');
    const relative = Bun.spawnSync(['/bin/sh', '-c', launcher, './tor', '--help']);
    expect(new TextDecoder().decode(relative.stderr)).not.toContain('run it by its path');
    const bareArg0 = Bun.spawnSync(['/bin/sh', '-c', launcher, 'tor', '--help']);
    expect(new TextDecoder().decode(bareArg0.stderr)).toContain('run it by its path');
    expect(bareArg0.exitCode).toBe(127);
    expect(statSync(join(dir, 'bin', 'tor')).mode & 0o777).toBe(0o700);
    expect(existsSync(join(dir, 'debug'))).toBe(false);
    expect(managedToolExecutable('tor', { ...f.host, pins })).toBe(join(realRoot(f.root), 'tor', '15.0.24', 'bin', 'tor'));
    expect(f.quarantined).toEqual([]);
  }, 30_000);

  test('re-running is a no-op: nothing is downloaded and the install is untouched', async () => {
    const f = setup();
    await installManagedTools(f.options);
    const before = statSync(join(f.root, 'zkapi-clientd', '0.1.6', 'olympus-tool.json')).mtimeMs;
    f.fetched.length = 0;
    const again = await installManagedTools(f.options);
    expect(again.ok).toBe(true);
    expect(again.tools.map((tool) => tool.outcome)).toEqual(['already_installed', 'already_installed']);
    expect(f.fetched).toEqual([]);
    expect(statSync(join(f.root, 'zkapi-clientd', '0.1.6', 'olympus-tool.json')).mtimeMs).toBe(before);
  });

  test('a download whose SHA-256 differs from the pin is refused before extraction; nothing is installed or left behind', async () => {
    const good = tarGz(zkapiEntries());
    const evil = Buffer.from(good);
    evil[evil.length - 20] = evil[evil.length - 20]! ^ 0xff;
    const f = setup({ zkapi: good, served: { zkapi: evil } });
    const result = await installManagedTools(f.options);
    expect(result.ok).toBe(false);
    expect(result.tools[1]).toMatchObject({ tool: 'zkapi-clientd', outcome: 'failed', code: 'hash_mismatch' });
    expect(existsSync(join(f.root, 'zkapi-clientd', '0.1.6'))).toBe(false);
    expect(leftovers(join(f.root, 'zkapi-clientd'))).toEqual([]);
    expect(managedToolExecutable('zkapi-clientd', f.host)).toBeUndefined();
    // The other tool is unaffected.
    expect(result.tools[0]!.outcome).toBe('installed');
  });

  test('a download larger than the pin is cut off and refused', async () => {
    const good = tarGz(zkapiEntries());
    const f = setup({ zkapi: good, served: { zkapi: Buffer.concat([good, Buffer.alloc(10)]) } });
    const result = await installManagedTools({
      ...f.options,
      tools: ['zkapi-clientd'],
      // No content-length: the stream itself is counted.
      fetchImpl: (async () => new Response(new Blob([Buffer.concat([good, Buffer.alloc(10)])]).stream())) as unknown as typeof fetch,
    });
    expect(result.tools[0]).toMatchObject({ outcome: 'failed', code: 'size_mismatch' });
  });

  for (const [label, entry] of [
    ['a ../ path', { name: '../evil', data: 'x' }],
    ['a nested ../ path', { name: 'tor/../../evil', data: 'x' }],
    ['an absolute path', { name: '/tmp/olympus-evil', data: 'x' }],
    ['a symlink leaving the folder', { name: 'tor/escape', type: '2', link: '../../../outside' }],
    ['an absolute symlink', { name: 'tor/escape', type: '2', link: '/etc/passwd' }],
    ['a hard link', { name: 'tor/hard', type: '1', link: 'tor/tor' }],
    ['a device file', { name: 'tor/dev', type: '3' }],
  ] as Array<[string, FixtureEntry]>) {
    test(`an archive with ${label} is refused and nothing is written`, async () => {
      const f = setup({ tor: tarGz(torEntries([entry])) });
      const result = await installManagedTools({ ...f.options, tools: ['tor'] });
      expect(result.tools[0]).toMatchObject({ tool: 'tor', outcome: 'failed', code: 'unsafe_archive' });
      expect(existsSync(join(f.root, 'tor', '15.0.24'))).toBe(false);
      expect(leftovers(join(f.root, 'tor'))).toEqual([]);
      expect(existsSync(join(f.home, 'evil'))).toBe(false);
      expect(existsSync(join(f.root, 'evil'))).toBe(false);
      expect(existsSync('/tmp/olympus-evil')).toBe(false);
    });
  }

  test('links that escape only together (a link through another link) are refused; a link inside the install is kept', async () => {
    const chained = setup({ tor: tarGz(torEntries([
      { name: 'tor/sub/', type: '5' },
      { name: 'tor/up', type: '2', link: 'sub/..' },
      { name: 'tor/x', type: '2', link: 'up/../..' },
    ])) });
    expect((await installManagedTools({ ...chained.options, tools: ['tor'] })).tools[0]).toMatchObject({ outcome: 'failed', code: 'unsafe_archive' });
    const through = setup({ tor: tarGz(torEntries([
      { name: 'tor/out', type: '2', link: '.' },
      { name: 'tor/out/file', data: 'x' },
    ])) });
    expect((await installManagedTools({ ...through.options, tools: ['tor'] })).tools[0]).toMatchObject({ outcome: 'failed', code: 'unsafe_archive' });
    const inside = setup({ tor: tarGz(torEntries([{ name: 'tor/tor-link', type: '2', link: 'tor' }])) });
    expect((await installManagedTools({ ...inside.options, tools: ['tor'] })).tools[0]!.outcome).toBe('installed');
    expect(lstatSync(join(inside.root, 'tor', '15.0.24', 'tor', 'tor-link')).isSymbolicLink()).toBe(true);
  });

  test('a program this computer will not run is not installed, and the reason is said plainly', async () => {
    const f = setup();
    const result = await installManagedTools({ ...f.options, tools: ['tor'], versionCheck: async () => ({ ok: false, detail: 'stopped by SIGKILL' }) });
    expect(result.tools[0]).toMatchObject({ outcome: 'failed', code: 'will_not_run' });
    expect(result.tools[0]!.message).toContain('stopped by SIGKILL');
    expect(existsSync(join(f.root, 'tor', '15.0.24'))).toBe(false);
    const wrong = await installManagedTools({ ...f.options, tools: ['zkapi-clientd'], versionCheck: async () => ({ ok: true, stdout: 'zkapi-clientd 0.1.4\n' }) });
    expect(wrong.tools[0]).toMatchObject({ outcome: 'failed', code: 'will_not_run' });
  });

  test('an archive missing a file the program needs is not installed', async () => {
    const f = setup({ zkapi: tarGz(zkapiEntries().filter((entry) => !entry.name.endsWith('withdrawal.pk'))) });
    const result = await installManagedTools({ ...f.options, tools: ['zkapi-clientd'] });
    expect(result.tools[0]).toMatchObject({ outcome: 'failed', code: 'archive_incomplete' });
  });

  test('an interrupted install never shadows a good one, and never reads as installed on its own', async () => {
    // 1. A download that dies part way: nothing discoverable, no version folder.
    const f = setup();
    const dying = (async () => new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array(f.zkapi.subarray(0, 100)));
        controller.error(new Error('connection reset'));
      },
    }))) as unknown as typeof fetch;
    const broken = await installManagedTools({ ...f.options, tools: ['zkapi-clientd'], fetchImpl: dying });
    expect(broken.tools[0]).toMatchObject({ outcome: 'failed', code: 'download_failed' });
    expect(existsSync(join(f.root, 'zkapi-clientd', '0.1.6'))).toBe(false);
    expect(managedToolExecutable('zkapi-clientd', f.host)).toBeUndefined();
    // 2. A good install, then a killed process's leftovers beside it: the good one still wins.
    await installManagedTools(f.options);
    const good = managedToolExecutable('zkapi-clientd', f.host);
    expect(good).toBeDefined();
    const toolDir = join(f.root, 'zkapi-clientd');
    mkdirSync(join(toolDir, '.staging-dead'), { mode: 0o700 });
    writeFileSync(join(toolDir, '.staging-dead', 'olympus-tool.json'), '{}');
    writeFileSync(join(toolDir, '.download-dead'), 'partial');
    expect(managedToolExecutable('zkapi-clientd', f.host)).toBe(good!);
    // 3. A version folder without a valid manifest (copied by hand, cut short) is not discovered, and an install replaces it in one step.
    const torDir = join(f.root, 'tor', '15.0.24');
    rmSync(join(torDir, 'olympus-tool.json'));
    expect(managedToolExecutable('tor', f.host)).toBeUndefined();
    const repaired = await installManagedTools(f.options);
    expect(repaired.tools.map((tool) => tool.outcome)).toEqual(['installed', 'already_installed']);
    expect(managedToolExecutable('tor', f.host)).toBeDefined();
    expect(leftovers(join(f.root, 'tor'))).toEqual([]);
  });

  test('one install at a time: a second install while the lease is held is refused as busy', async () => {
    const f = setup();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const slowFetch = (async (input: string | URL | Request) => {
      await gate;
      return servingFetch({ 'https://fixture.test/tor.tar.gz': f.tor, 'https://fixture.test/zkapi.tar.gz': f.zkapi })(input);
    }) as typeof fetch;
    const first = installManagedTools({ ...f.options, fetchImpl: slowFetch });
    await new Promise((resolve) => setTimeout(resolve, 100));
    const second = await installManagedTools(f.options);
    expect(second.ok).toBe(false);
    expect(second.tools.every((tool) => tool.code === 'busy')).toBe(true);
    release();
    expect((await first).ok).toBe(true);
  });

  test('Apple silicon: the unsigned Tor files are ad-hoc signed with /usr/bin/codesign inside staging, before the version check, and recorded', async () => {
    const f = setup();
    const order: string[] = [];
    const runCommand: ManagedToolsCommandRunner = async (command, args) => {
      order.push(`${command} ${args.slice(0, -1).join(' ')} ${args.at(-1)!.split('/').slice(-3).join('/')}`);
      expect(command).toBe('/usr/bin/codesign');
      expect(args.at(-1)!).toMatch(/\/tor\/\.staging-[0-9a-f-]+\/tor\/(tor|libevent-2\.1\.7\.dylib)$/);
      if (args[0] === '-dv') return { code: 1, stdout: '', stderr: `${args.at(-1)}: code object is not signed at all\n` };
      return { code: 0, stdout: '', stderr: '' };
    };
    const versionCheck: ManagedToolVersionCheck = async (executable, options) => { order.push('version'); return okVersion(executable, options); };
    const result = await installManagedTools({ ...f.options, tools: ['tor'], runCommand, versionCheck });
    expect(result.tools[0]!.outcome).toBe('installed');
    expect(order.map((line) => line.replace(/\.staging-[0-9a-f-]+/, 'S'))).toEqual([
      '/usr/bin/codesign -dv S/tor/tor',
      '/usr/bin/codesign --force --sign - S/tor/tor',
      '/usr/bin/codesign -dv S/tor/libevent-2.1.7.dylib',
      '/usr/bin/codesign --force --sign - S/tor/libevent-2.1.7.dylib',
      'version',
    ]);
    const manifest = JSON.parse(readFileSync(join(f.root, 'tor', '15.0.24', 'olympus-tool.json'), 'utf8'));
    expect(manifest.adhocSigned).toEqual(['tor/tor', 'tor/libevent-2.1.7.dylib']);
  });

  test('already-signed files are never re-signed; zkAPI is never touched by codesign; Intel and Linux never sign', async () => {
    const f = setup();
    const result = await installManagedTools(f.options);
    expect(result.ok).toBe(true);
    // Only the two Tor files were inspected; each read as signed, so no --sign ran.
    expect(f.commands.map((line) => line.split(' ').slice(0, 2).join(' '))).toEqual(['/usr/bin/codesign -dv', '/usr/bin/codesign -dv']);
    expect(f.commands.some((line) => line.includes('zkapi'))).toBe(false);
    expect(JSON.parse(readFileSync(join(f.root, 'tor', '15.0.24', 'olympus-tool.json'), 'utf8')).adhocSigned).toBeUndefined();
    const intel = setup();
    const intelResult = await installManagedTools({ ...intel.options, arch: 'x64', pins: { ...intel.pins, tor: { ...intel.pins.tor, assets: { 'darwin-x64': { ...intel.pins.tor.assets['darwin-arm64']! } } } }, tools: ['tor'] });
    expect(intelResult.tools[0]!.outcome).toBe('installed');
    expect(intel.commands).toEqual([]);
  });

  test('codesign missing or failing stops the Tor install with a plain message; nothing is installed', async () => {
    for (const runCommand of [
      (async () => ({ code: null, stdout: '', stderr: '', error: 'ENOENT' })) as ManagedToolsCommandRunner,
      (async (_command: string, args: readonly string[]) => args[0] === '-dv'
        ? { code: 1, stdout: '', stderr: 'code object is not signed at all' }
        : { code: 1, stdout: '', stderr: 'internal error' }) as ManagedToolsCommandRunner,
      (async () => ({ code: 1, stdout: '', stderr: 'something else entirely' })) as ManagedToolsCommandRunner,
    ]) {
      const f = setup();
      const result = await installManagedTools({ ...f.options, tools: ['tor'], runCommand });
      expect(result.tools[0]).toMatchObject({ tool: 'tor', outcome: 'failed', code: 'signing_failed' });
      expect(result.tools[0]!.message).toContain('was not installed');
      expect(existsSync(join(f.root, 'tor', '15.0.24'))).toBe(false);
      expect(leftovers(join(f.root, 'tor'))).toEqual([]);
    }
  });

  test('a lease takeover mid-install aborts at once, before any shared path is touched again, and the rest of the batch is reported lease_lost', async () => {
    const f = setup();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const slowFetch = (async (input: string | URL | Request) => {
      await gate;
      return servingFetch({ 'https://fixture.test/tor.tar.gz': f.tor, 'https://fixture.test/zkapi.tar.gz': f.zkapi })(input);
    }) as typeof fetch;
    const run = installManagedTools({ ...f.options, fetchImpl: slowFetch });
    await new Promise((resolve) => setTimeout(resolve, 100));
    // Another holder takes the lease over mid-download (the install lock's own format).
    writeFileSync(join(f.root, 'install.lock'), JSON.stringify({ version: 1, token: 'another-holder', pid: process.pid, acquiredAt: new Date().toISOString() }), { mode: 0o600 });
    release();
    const result = await run;
    expect(result.ok).toBe(false);
    expect(result.tools.every((tool) => tool.code === 'lease_lost')).toBe(true);
    // Nothing was installed or left behind under either tool.
    expect(existsSync(join(f.root, 'tor', '15.0.24'))).toBe(false);
    expect(existsSync(join(f.root, 'zkapi-clientd', '0.1.6'))).toBe(false);
    expect(leftovers(join(f.root, 'tor'))).toEqual([]);
    expect(leftovers(join(f.root, 'zkapi-clientd'))).toEqual([]);
  });

    test('the background job: start returns at once, a second start while running is refused, and the state reads the outcome', async () => {
    const f = setup();
    const job = createManagedToolsJob(f.options);
    expect(job.progress()).toEqual({ state: 'idle' });
    expect(job.start()).toBe('started');
    expect(job.progress().state).toBe('running');
    expect(job.start()).toBe('running');
    await job.settled();
    expect(job.progress().state).toBe('done');
    const failing = createManagedToolsJob({ ...f.options, tools: ['tor'], pins: fixturePins({ tor: Buffer.from('other'), zkapi: f.zkapi }) });
    failing.start();
    await failing.settled();
    expect(failing.progress()).toMatchObject({ state: 'failed', tool: 'tor', code: 'size_mismatch' });
    expect(dashboardInstallView(failing.progress())).toMatchObject({ state: 'failed', code: 'size_mismatch' });
    expect(dashboardInstallView({ state: 'running', tool: 'tor', phase: 'downloading', receivedBytes: 50, totalBytes: 200, startedAt: 'x' }))
      .toEqual({ state: 'running', tool: 'Tor', phase: 'downloading', percent: 25 });
  });
});

function realRoot(root: string): string {
  return realpathSync(root);
}

describe('discovery refuses what it did not verify', () => {
  test('a manifest naming another hash, a folder others can write, and an executable linked outside are each ignored', async () => {
    const f = setup();
    await installManagedTools(f.options);
    const zkDir = join(f.root, 'zkapi-clientd', '0.1.6');
    expect(managedToolExecutable('zkapi-clientd', f.host)).toBeDefined();
    const manifestPath = join(zkDir, 'olympus-tool.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    writeFileSync(manifestPath, JSON.stringify({ ...manifest, sha256: '0'.repeat(64) }));
    expect(managedToolExecutable('zkapi-clientd', f.host)).toBeUndefined();
    writeFileSync(manifestPath, JSON.stringify(manifest));
    chmodSync(manifestPath, 0o600);
    expect(managedToolExecutable('zkapi-clientd', f.host)).toBeDefined();
    chmodSync(zkDir, 0o770);
    expect(managedToolExecutable('zkapi-clientd', f.host)).toBeUndefined();
    chmodSync(zkDir, 0o700);
    chmodSync(join(zkDir, 'bin', 'zkapi-clientd'), 0o722);
    expect(managedToolExecutable('zkapi-clientd', f.host)).toBeUndefined();
    rmSync(join(zkDir, 'bin', 'zkapi-clientd'));
    const outside = join(f.home, 'outside-clientd');
    writeFileSync(outside, '#!/bin/sh\n', { mode: 0o700 });
    symlinkSync(outside, join(zkDir, 'bin', 'zkapi-clientd'));
    expect(managedToolExecutable('zkapi-clientd', f.host)).toBeUndefined();
  });

  test('discovery requires every file the program needs, not only the one it starts: missing, exposed or escaping, each reads as not installed, and a reinstall repairs it', async () => {
    const f = setup();
    await installManagedTools(f.options);
    const zkDir = join(f.root, 'zkapi-clientd', '0.1.6');
    expect(managedToolExecutable('zkapi-clientd', f.host)).toBeDefined();
    // Missing: a required proof file removed.
    const pk = join(zkDir, 'share', 'zkapi-clientd', 'proof-setup', 'withdrawal.pk');
    const saved = readFileSync(pk);
    rmSync(pk);
    expect(managedToolExecutable('zkapi-clientd', f.host)).toBeUndefined();
    // A reinstall (the good folder fails discovery, so it is not "already installed") repairs it.
    const repaired = await installManagedTools(f.options);
    expect(repaired.tools.find((t) => t.tool === 'zkapi-clientd')!.outcome).toBe('installed');
    expect(managedToolExecutable('zkapi-clientd', f.host)).toBeDefined();
    writeFileSync(pk, saved);
    // Exposed: a directory between the version folder and a required file, group-writable.
    const proofDir = join(zkDir, 'share', 'zkapi-clientd', 'proof-setup');
    chmodSync(proofDir, 0o770);
    expect(managedToolExecutable('zkapi-clientd', f.host)).toBeUndefined();
    chmodSync(proofDir, 0o700);
    expect(managedToolExecutable('zkapi-clientd', f.host)).toBeDefined();
    // Escaping: a required file replaced by a symlink to something outside the version folder.
    const outside = join(f.home, 'outside.pk');
    writeFileSync(outside, 'pk', { mode: 0o600 });
    rmSync(pk);
    symlinkSync(outside, pk);
    expect(managedToolExecutable('zkapi-clientd', f.host)).toBeUndefined();
  });

  test('a group-writable folder holding links to protected files inside the version folder reads as not installed (the links could be retargeted)', async () => {
    const f = setup();
    await installManagedTools(f.options);
    const zkDir = join(f.root, 'zkapi-clientd', '0.1.6');
    const proof = join(zkDir, 'share', 'zkapi-clientd', 'proof-setup');
    const kept = join(zkDir, 'kept');
    mkdirSync(kept, { mode: 0o700 });
    for (const name of readdirSync(proof)) {
      writeFileSync(join(kept, name), readFileSync(join(proof, name)), { mode: 0o600 });
      rmSync(join(proof, name));
      symlinkSync(join(kept, name), join(proof, name));
    }
    // Links to protected files inside the version folder, in a private folder: trusted.
    expect(managedToolExecutable('zkapi-clientd', f.host)).toBeDefined();
    chmodSync(proof, 0o770);
    expect(managedToolExecutable('zkapi-clientd', f.host)).toBeUndefined();
  });

  test('the consult transport prefers the managed install over PATH; an explicit path is only that path', () => {
    const home = tempDir();
    const platformKey = managedToolsPlatform();
    const asset = platformKey ? MANAGED_TOOL_PINS['zkapi-clientd'].assets[platformKey] : undefined;
    if (!platformKey || !asset) return; // a host Olympus has no download for
    const env = { HOME: home, PATH: join(home, 'bin') };
    mkdirSync(join(home, 'bin'), { recursive: true });
    writeFileSync(join(home, 'bin', 'zkapi-clientd'), '#!/bin/sh\necho "zkapi-clientd 0.1.6"\n', { mode: 0o755 });
    expect(resolveZkapiExecutable('zkapi-clientd', undefined, env)).toBe(join(home, 'bin', 'zkapi-clientd'));
    const versionDir = join(managedToolsRoot({ env })!, 'zkapi-clientd', '0.1.6');
    mkdirSync(join(versionDir, 'bin'), { recursive: true, mode: 0o700 });
    for (let dir = versionDir; dir !== join(home); dir = join(dir, '..')) chmodSync(dir, 0o700);
    writeFileSync(join(versionDir, 'bin', 'zkapi-clientd'), '#!/bin/sh\necho "zkapi-clientd 0.1.6"\n', { mode: 0o700 });
    // Discovery now checks every file the daemon needs, not only the one it starts.
    for (const required of asset.required) {
      if (required === 'bin/zkapi-clientd') continue;
      mkdirSync(join(versionDir, dirname(required)), { recursive: true, mode: 0o700 });
      writeFileSync(join(versionDir, required), 'x', { mode: 0o600 });
    }
    writeFileSync(join(versionDir, 'olympus-tool.json'), JSON.stringify({
      schema: 1, tool: 'zkapi-clientd', version: '0.1.6', platform: platformKey, asset: 'x', sha256: asset.sha256, installedAt: '2026-10-07T00:00:00.000Z',
    }), { mode: 0o600 });
    const managed = resolveZkapiExecutable('zkapi-clientd', undefined, env);
    expect(managed).toBe(managedToolExecutable('zkapi-clientd', { env }));
    expect(managed!.endsWith(join('tools', 'zkapi-clientd', '0.1.6', 'bin', 'zkapi-clientd'))).toBe(true);
    expect(resolveZkapiExecutable('zkapi-clientd', join(home, 'bin', 'zkapi-clientd'), env)).toBe(join(home, 'bin', 'zkapi-clientd'));
    // Tor is not installed there: PATH (none here) decides.
    expect(resolveZkapiExecutable('tor', undefined, env)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// The dashboard: route, adapter, card.

describe('the install route', () => {
  const TOKEN = 'worker-secret-token';
  const ORIGIN = 'http://127.0.0.1:28190';

  test('is one of the local-grade consult routes, on the public route list and the card\'s paths', () => {
    expect(DASHBOARD_CONSULT_CONTROL_PATHS).toContain(DASHBOARD_OUTSIDE_HELP_INSTALL_TOOLS_PATH);
    expect(DASHBOARD_OUTSIDE_HELP_PATHS.installTools).toBe(DASHBOARD_OUTSIDE_HELP_INSTALL_TOOLS_PATH);
    expect(V0_4_PUBLIC_DASHBOARD_ROUTES).toContainEqual({ method: 'POST', path: DASHBOARD_OUTSIDE_HELP_INSTALL_TOOLS_PATH });
    expect(V0_4_PUBLIC_CLI_COMMANDS).toContain('zkapi install-tools');
  });

  test('the bearer and a bearer-grade session are refused; a local-grade session needs CSRF and same origin', async () => {
    const seen: string[] = [];
    const clock = Date.parse('2026-10-07T12:00:00.000Z');
    const fetcher = withWorkerBearerAuth(async (request) => {
      seen.push(new URL(request.url).pathname);
      return new Response(JSON.stringify({ ok: true }), { headers: { 'Content-Type': 'application/json' } });
    }, { authToken: TOKEN, now: () => clock, launchTickets: new DashboardLaunchTickets({ now: () => clock }) });
    const post = (headers: Record<string, string>) => new Request(`${ORIGIN}${DASHBOARD_OUTSIDE_HELP_INSTALL_TOOLS_PATH}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify({ confirm: true }),
    });
    const cookieOf = (response: Response) => (response.headers.get('Set-Cookie') ?? '').split(';')[0]!;
    expect((await fetcher(post({ Authorization: `Bearer ${TOKEN}`, Origin: ORIGIN }))).status).toBe(403);
    const bearerMint = await fetcher(new Request(`${ORIGIN}/dashboard/control/session`, { method: 'POST', headers: { Authorization: `Bearer ${TOKEN}`, Origin: ORIGIN } }));
    const bearerCsrf = ((await bearerMint.json()) as { csrf_token: string }).csrf_token;
    const bearerGrade = await fetcher(post({ Cookie: cookieOf(bearerMint), Origin: ORIGIN, 'X-Olympus-CSRF': bearerCsrf }));
    expect(bearerGrade.status).toBe(403);
    expect(((await bearerGrade.json()) as { error: { code: string } }).error.code).toBe('mac_dashboard_only');
    const localRequest = new Request(`${ORIGIN}${DASHBOARD_LOCAL_CONTROL_SESSION_PATH}`, { method: 'POST', headers: { Origin: ORIGIN } });
    recordRequestPeer(localRequest, '127.0.0.1');
    const localMint = await fetcher(localRequest);
    expect(localMint.status).toBe(200);
    const cookie = cookieOf(localMint);
    const csrf = ((await localMint.json()) as { csrf_token: string }).csrf_token;
    expect((await fetcher(post({ Cookie: cookie, Origin: ORIGIN }))).status).toBe(403);
    expect((await fetcher(post({ Cookie: cookie, Origin: 'http://attacker.test', 'X-Olympus-CSRF': csrf }))).status).toBe(403);
    expect((await fetcher(post({ Cookie: cookie, Origin: ORIGIN, 'X-Olympus-CSRF': 'wrong' }))).status).toBe(403);
    expect(seen).toEqual([]);
    expect((await fetcher(post({ Cookie: cookie, Origin: ORIGIN, 'X-Olympus-CSRF': csrf }))).status).toBe(200);
    expect(seen).toEqual([DASHBOARD_OUTSIDE_HELP_INSTALL_TOOLS_PATH]);
  });

  test('the adapter starts the job once, needs confirmation, changes no setting, and reports progress in the status', async () => {
    const home = tempDir();
    let started = 0;
    let state: ReturnType<ReturnType<typeof createManagedToolsJob>['progress']> = { state: 'idle' };
    const job = {
      start: () => { if (state.state === 'running') return 'running' as const; started += 1; state = { state: 'running', tool: 'tor', phase: 'downloading', receivedBytes: 1, totalBytes: 4, startedAt: 'x' }; return 'started' as const; },
      progress: () => state,
      settled: async () => undefined,
    };
    const adapter = createDashboardConsultAdapter({
      sovereignty: { config: loadSovereigntyPreset('local-first'), source: 'preset' },
      secretPresent: () => false,
      recoverSession: async () => { throw new Error('not used'); },
      requestReload: () => { throw new Error('install must not restart the worker'); },
      env: { HOME: home },
      toolsJob: job,
      toolsState: () => [{ tool: 'tor', label: 'Tor', source: 'missing' }, { tool: 'zkapi-clientd', label: 'zkAPI', source: 'system' }],
    });
    expect(await adapter.installTools({})).toMatchObject({ ok: false, code: 'confirmation_required' });
    expect(await adapter.installTools({ confirm: true })).toMatchObject({ ok: true });
    expect(await adapter.installTools({ confirm: true })).toMatchObject({ ok: false, httpStatus: 409, code: 'install_running' });
    expect(started).toBe(1);
    const status = await adapter.status();
    expect(status.tools).toEqual({
      tools: [{ tool: 'tor', label: 'Tor', source: 'missing' }, { tool: 'zkapi-clientd', label: 'zkAPI', source: 'system' }],
      install: { state: 'running', tool: 'Tor', phase: 'downloading', percent: 25 },
    });
    expect(existsSync(join(home, '.olympus'))).toBe(false);
  });

  test("the default tools status uses the route's effective resolution: an explicit path wins (found or not), over the managed install and PATH", async () => {
    const home = tempDir();
    const config = structuredClone(loadSovereigntyPreset('local-first')) as SovereigntyConfig;
    (config.modelProfiles as Record<string, unknown>)['zkapi-consult'] = {
      provider: 'zkapi', trust: 'standard_cloud', purpose: 'consult', baseUrl: 'http://127.0.0.1:8787/v1', model: 'openai/gpt-5-mini',
      secretRef: 'env:OLYMPUS_ZKAPI_API_KEY',
      zkapi: { fundingDate: '2026-10-01', acknowledgements: { version: 0, accepted: [] }, daemonExecutable: join(home, 'bin', 'zkapi-clientd'), torExecutable: '/nowhere/tor' },
    };
    mkdirSync(join(home, 'bin'), { recursive: true });
    writeFileSync(join(home, 'bin', 'zkapi-clientd'), '#!/bin/sh\n', { mode: 0o755 });
    const adapter = createDashboardConsultAdapter({
      sovereignty: { config, source: 'preset' },
      secretPresent: () => false,
      recoverSession: async () => { throw new Error('not used'); },
      requestReload: () => { throw new Error('not used'); },
      env: { HOME: home },
    });
    const status = await adapter.status();
    expect(status.tools!.tools).toEqual([
      { tool: 'tor', label: 'Tor', source: 'configured_missing', path: '/nowhere/tor' },
      { tool: 'zkapi-clientd', label: 'zkAPI', source: 'configured', path: join(home, 'bin', 'zkapi-clientd') },
    ]);
  });
});

describe('the card section', () => {
  const tools = (install: DashboardOutsideHelpTools['install'], sources: Array<DashboardOutsideHelpTools['tools'][number]['source']> = ['missing', 'missing']): DashboardOutsideHelpTools => ({
    tools: [{ tool: 'tor', label: 'Tor', source: sources[0]! }, { tool: 'zkapi-clientd', label: 'zkAPI', source: sources[1]! }],
    install,
  });

  test('not installed: two plain lines and one button; the script posts with the CSRF token', () => {
    const html = renderOutsideHelpTools(tools({ state: 'idle' }), { canEdit: true });
    expect(html).toContain('data-install-state="idle"');
    expect(html).toContain('Tor: Not installed');
    expect(html).toContain('zkAPI: Not installed');
    expect(html).toContain('>Install Tor and zkAPI</button>');
    const script = renderOutsideHelpToolsScript(tools({ state: 'idle' }), { canEdit: true, csrfToken: 'csrf-1' });
    expect(script).toContain('csrf-1');
    expect(script).toContain(DASHBOARD_OUTSIDE_HELP_INSTALL_TOOLS_PATH);
    expect(() => new Function(/<script>([\s\S]*)<\/script>/.exec(script)![1]!)).not.toThrow();
  });

  test('read-only: the button is disabled and there is no script', () => {
    expect(renderOutsideHelpTools(tools({ state: 'idle' }), { canEdit: false })).toContain('disabled aria-disabled="true"');
    expect(renderOutsideHelpToolsScript(tools({ state: 'idle' }), { canEdit: false })).toBe('');
  });

  test('progress: Downloading Tor… with a percent, then Checking…, and no button while it runs', () => {
    const downloading = renderOutsideHelpTools(tools({ state: 'running', tool: 'Tor', phase: 'downloading', percent: 40 }), { canEdit: true });
    expect(downloading).toContain('data-install-state="running"');
    expect(downloading).toContain('Downloading Tor… 40%');
    expect(downloading).not.toContain('<button');
    expect(renderOutsideHelpTools(tools({ state: 'running', tool: 'zkAPI', phase: 'checking' }), { canEdit: true })).toContain('Checking zkAPI…');
  });

  test('installed: where each came from, Installed, no button, and nothing to fix', () => {
    const done = tools({ state: 'done' }, ['olympus', 'system']);
    const html = renderOutsideHelpTools(done, { canEdit: true });
    expect(html).toContain('Tor: Installed (Olympus)');
    expect(html).toContain('zkAPI: Installed (your system)');
    expect(html).toContain('data-outside-install-done');
    expect(html).not.toContain('<button');
    expect(renderOutsideHelpToolsFix(done, { canEdit: true })).toBe('');
  });

  test('failure: the plain reason and Try again, in both places', () => {
    const failed = tools({ state: 'failed', code: 'hash_mismatch', message: 'The Tor download did not match its pinned fingerprint, so nothing was installed.' });
    for (const html of [renderOutsideHelpTools(failed, { canEdit: true }), renderOutsideHelpToolsFix(failed, { canEdit: true })]) {
      expect(html).toContain('data-outside-install-failed="hash_mismatch"');
      expect(html).toContain('Not installed. The Tor download did not match its pinned fingerprint');
      expect(html).toContain('>Try again</button>');
    }
  });

  test('on the card: missing parts are one "To fix" line with the button (replacing the two not-found blockers), and step 1 of an open Set up zkAPI', () => {
    const missing = tools({ state: 'idle' }, ['missing', 'olympus']);
    const card = renderOutsideHelpCard({
      settings: { state: 'off', revision: 0, languages: ['en'], domains: { ...DEFAULT_CONSULT_DOMAIN_PACKS }, strict: false, level: 'unnamed' },
      route: { state: 'not_configured', policyWritable: true },
      languages: [],
      restartPending: false,
      tools: missing,
    }, { csrfToken: 'csrf-2', localSession: true });
    const fix = card.indexOf('data-outside-tools="fix"');
    const setup = card.indexOf('data-outside-tools="setup"');
    expect(fix).toBeGreaterThan(card.indexOf('data-outside-blockers'));
    expect(card.slice(fix, fix + 400)).toContain('Tor is not installed on this Mac.');
    expect(setup).toBeGreaterThan(card.indexOf('data-outside-section="steps" open'));
    expect(setup).toBeLessThan(card.indexOf('data-outside-steps'));
    expect(card.match(/<script>/g)!.length).toBe(2);
    expect(card).not.toContain('Install zkapi-clientd (version');
  });

  test('on the card: a configured-path blocker (not installable) stays, and an installable blocker is replaced by the parts\' To fix line', () => {
    const mixed = tools({ state: 'idle' }, ['configured_missing', 'missing']);
    const mixedWithPath = { ...mixed, tools: [{ ...mixed.tools[0]!, path: '/nowhere/tor' }, mixed.tools[1]!] };
    const readiness: DashboardOutsideHelpReadiness = {
      ready: false, blockers: ['tor_not_found', 'daemon_not_found'], daemonFound: false, torMode: 'per_consult', torFound: false, apiKeyConfigured: true,
      expiry: { state: 'unknown' }, requestsToday: { count: 0 }, spendToday: { reservedUsd: 0 }, fences: [], routeLabel: 'x',
    };
    const card = renderOutsideHelpCard({
      settings: { state: 'off', revision: 0, languages: ['en'], domains: { ...DEFAULT_CONSULT_DOMAIN_PACKS }, strict: false, level: 'unnamed' },
      route: {
        state: 'configured', profileId: 'zkapi-consult', model: 'x', policyWritable: true, secretRef: 'env:X',
        acknowledgements: { version: 0, accepted: [], complete: false }, readiness,
      },
      languages: [],
      restartPending: false,
      tools: mixedWithPath,
    }, { csrfToken: 'csrf-3', localSession: true });
    const start = card.indexOf('data-outside-blockers');
    const toFix = card.slice(start, card.indexOf('</ul>', start));
    // The configured, not-found Tor path: the install button cannot fix it, so To
    // fix says it plainly, with the path, not the generic not-installed wording.
    expect(toFix).toContain('/nowhere/tor');
    expect(toFix).toContain('was not found');
    expect(toFix).not.toContain('The program that hides your network address is not installed');
    // The installable zkAPI blocker is dropped there in favor of the parts' own To fix line.
    expect(toFix).not.toContain('The zkAPI app is not installed on this Mac. See Set up zkAPI.');
    expect(toFix).toContain('zkAPI is not installed on this Mac.');
  });
});
