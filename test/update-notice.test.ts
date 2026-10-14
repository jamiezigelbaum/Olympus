import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Window } from 'happy-dom';
import {
  createUpdateChecker, parseInstallerVersion, newerVersion, installerForPlatform,
  UPDATE_MAX_BYTES, UPDATE_TIMEOUT_MS,
} from '../src/core/update-check.ts';
import { renderComputerHostPage } from '../src/workers/dashboard/host-page.ts';
import { createEmailSourceWorker } from '../src/workers/email-source/index.ts';
import { engineStatusReport } from '../src/core/engine-cli.ts';

const fetcher = (body: string, status = 200) => (async () => new Response(body, { status })) as unknown as typeof fetch;
const script = (version: string) => `#!/bin/sh\nOLYMPUS_VERSION=${version}\n`;
const options = { runningVersion: '1.0.0', platform: 'darwin', env: {}, fileEnv: () => ({}) };

for (const [name, body, expected] of [
  ['valid', script('1.0.1'), '1.0.1'],
  ['first pin', script('1.0.1') + script('2.0.0'), '1.0.1'],
  ['missing', '# no version', undefined],
  ['garbage', script('nope'), undefined],
  ['first invalid pin', script('nope') + script('2.0.0'), undefined],
  ['oversized', script('1.0.1') + 'x'.repeat(524288), undefined],
  ['prerelease', script('1.1.0-rc.1'), '1.1.0-rc.1'],
  ['leading zero', script('01.0.1'), undefined],
  ['version length 64', script('1'.repeat(60) + '.0.1'), '1'.repeat(60) + '.0.1'],
  ['version length 65', script('1'.repeat(61) + '.0.1'), undefined],
] as const) test(`installer parser: ${name}`, () => expect(parseInstallerVersion(body)).toBe(expected));

test('parser follows the publisher version pattern without changing publishing', () => {
  const publisher = readFileSync('scripts/publish-release-to-site.ts', 'utf8');
  expect(publisher).toContain('const VERSION_PATTERN = /^[0-9]+\\.[0-9]+\\.[0-9]+(?:-[0-9A-Za-z]+(?:\\.[0-9A-Za-z]+)*)?$/;');
});

for (const [remote, running, expected] of [
  ['1.0.1', '1.0.0', true], ['1.10.0', '1.9.9', true], ['2.0.0', '1.99.99', true],
  ['1.0.0', '1.0.0', false], ['0.9.9', '1.0.0', false], ['bad', '1.0.0', false],
  ['1.1.0-rc.1', '1.0.0', false], ['1.1.0', '1.1.0-rc.1', true],
  ['1.1.0-rc.10', '1.1.0-rc.2', true], ['1.1.0-rc.2', '1.1.0-rc.10', false],
  ['1.1.0-rc', '1.1.0-beta.9', true], ['1.1.0-rc.01', '1.1.0-beta', false],
] as const) test(`semver ${remote} vs ${running}`, () => expect(newerVersion(remote, running)).toBe(expected));

test('Mac and Linux each use their own served installer; other platforms none', () => {
  expect(installerForPlatform('darwin')).toEqual({ url: 'https://olympusplugin.ai/install.sh', command: 'curl -fsSL https://olympusplugin.ai/install.sh | sh' });
  expect(installerForPlatform('linux')).toEqual({ url: 'https://olympusplugin.ai/install-linux.sh', command: 'curl -fsSL https://olympusplugin.ai/install-linux.sh | sh' });
  expect(installerForPlatform('win32')).toBeUndefined();
});

test('off in environment or worker.env makes zero requests, including after a previous result', async () => {
  for (const file of [false, true]) {
    const env: Record<string, string> = {};
    const fileEnv: Record<string, string> = {};
    let calls = 0;
    const checker = createUpdateChecker({ ...options, env, fileEnv: () => fileEnv, fetchImpl: (async () => { calls++; return new Response(script('1.0.1')); }) as unknown as typeof fetch });
    (file ? fileEnv : env).OLYMPUS_UPDATE_CHECK = 'off';
    checker.start(); await checker.check();
    expect(calls).toBe(0); expect(checker.available()).toBeUndefined();
    delete (file ? fileEnv : env).OLYMPUS_UPDATE_CHECK;
    await checker.check(); expect(checker.available()).toEqual({ version: '1.0.1' });
    (file ? fileEnv : env).OLYMPUS_UPDATE_CHECK = 'off';
    await checker.check(); expect(calls).toBe(1); expect(checker.available()).toBeUndefined();
    checker.stop();
  }
});

for (const value of ['OFF', '0', 'false', 'FaLsE', 'NO']) test(`update off switch ${value} makes zero requests`, async () => {
  for (const file of [false, true]) {
    let calls = 0;
    const setting = { OLYMPUS_UPDATE_CHECK: value };
    const checker = createUpdateChecker({
      ...options, env: file ? {} : setting, fileEnv: () => file ? setting : {},
      fetchImpl: (async () => { calls++; return new Response(script('1.0.1')); }) as unknown as typeof fetch,
    });
    try {
      checker.start(); await checker.check();
      expect(calls).toBe(0); expect(checker.available()).toBeUndefined();
    } finally { checker.stop(); }
  }
});

test('an overlong installer version is ignored by the update checker', async () => {
  const checker = createUpdateChecker({ ...options, fetchImpl: fetcher(script('1'.repeat(61) + '.0.1')) });
  try {
    await checker.check(); expect(checker.available()).toBeUndefined();
  } finally { checker.stop(); }
});

test('fixed anonymous GET, bounded timeout and no redirects; result stays in memory', async () => {
  let seen: Request | undefined;
  const checker = createUpdateChecker({ ...options, fetchImpl: (async (url: Parameters<typeof fetch>[0], init: Parameters<typeof fetch>[1]) => {
    seen = new Request(url, init);
    expect(init?.redirect).toBe('error'); expect(init).not.toHaveProperty('proxy'); expect(init?.credentials).toBe('omit');
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    return new Response(script('1.0.1'));
  }) as unknown as typeof fetch });
  await checker.check();
  expect(seen!.url).toBe('https://olympusplugin.ai/install.sh'); expect(seen!.method).toBe('GET');
  expect([...seen!.headers]).toEqual([['user-agent', 'Olympus']]);
  expect(UPDATE_TIMEOUT_MS).toBe(10_000); expect(UPDATE_MAX_BYTES).toBe(524288);
  expect(checker.available()).toEqual({ version: '1.0.1' }); checker.stop();
});

test('failures are silent, redact exceptions and clear an earlier notice', async () => {
  const debug: string[] = [];
  let fail = false;
  const checker = createUpdateChecker({ ...options, debug: line => debug.push(line), fetchImpl: (async () => {
    if (fail) throw new Error('https://example.test/?private=secret CONTENT');
    return new Response(script('1.0.1'));
  }) as unknown as typeof fetch });
  await checker.check(); fail = true;
  await expect(checker.check()).resolves.toBeUndefined();
  expect(checker.available()).toBeUndefined(); expect(debug).toEqual(['[update] check unavailable']); checker.stop();
});

for (const kind of ['http', 'declared-size', 'stream-size', 'timeout'] as const) test(`silent fetch failure: ${kind}`, async () => {
  let cancelled = false;
  const checker = createUpdateChecker({ ...options, timeoutMs: 15, fetchImpl: (async (_url: Parameters<typeof fetch>[0], init: Parameters<typeof fetch>[1]) => {
    if (kind === 'http') return new Response('offline', { status: 503 });
    if (kind === 'declared-size') return new Response('x', { headers: { 'Content-Length': '524289' } });
    if (kind === 'timeout') return new Promise((_resolve, reject) => init!.signal!.addEventListener('abort', () => reject(new Error('timeout'))));
    return new Response(new ReadableStream({ start(c) { c.enqueue(new Uint8Array(524289)); }, cancel() { cancelled = true; } }));
  }) as unknown as typeof fetch });
  await expect(checker.check()).resolves.toBeUndefined(); expect(checker.available()).toBeUndefined();
  if (kind === 'stream-size') expect(cancelled).toBe(true);
  checker.stop();
});

test('scheduler waits two minutes, then a day with jitter; stop cancels future work', async () => {
  const pending: { callback: () => void; delay: number; cancelled: boolean }[] = [];
  let calls = 0;
  const checker = createUpdateChecker({ ...options, random: () => 0, schedule: (callback, delay) => {
    const item = { callback, delay, cancelled: false }; pending.push(item); return () => { item.cancelled = true; };
  }, fetchImpl: (async () => { calls++; return new Response(script('1.0.1')); }) as unknown as typeof fetch });
  checker.start(); checker.start(); expect(calls).toBe(0); expect(pending).toHaveLength(1); expect(pending[0]!.delay).toBe(120_000);
  pending[0]!.callback(); await new Promise(resolve => setTimeout(resolve, 20));
  expect(calls).toBe(1); expect(pending[1]!.delay).toBeGreaterThanOrEqual(82_080_000); expect(pending[1]!.delay).toBeLessThanOrEqual(90_720_000);
  checker.stop(); expect(pending[1]!.cancelled).toBe(true);
});

for (const remote of ['1.0.0', '0.9.0', '1.1.0-beta.1', 'bad']) test(`no notice for ${remote}`, async () => {
  const checker = createUpdateChecker({ ...options, fetchImpl: fetcher(script(remote)) });
  await checker.check();
  const html = renderComputerHostPage({ panelHtml: '<p>panel</p>', origin: 'http://localhost', updateAvailable: checker.available() });
  expect(html).not.toContain('Olympus 1.0.1 is available.');
  expect(checker.available()).toBeUndefined(); checker.stop();
});

test('Mac dashboard renders a plain notice and copies the exact README command', async () => {
  const html = renderComputerHostPage({ panelHtml: '<p>panel</p>', origin: 'http://localhost', updateAvailable: { version: '1.0.1' } });
  expect(html).toContain('Olympus 1.0.1 is available. To update, run this in Terminal:');
  const command = 'curl -fsSL https://olympusplugin.ai/install.sh | sh';
  expect(readFileSync('README.md', 'utf8')).toContain(command);
  const window = new Window({ url: 'http://localhost', settings: { enableJavaScriptEvaluation: true } });
  Object.defineProperty(window, 'fetch', { value: async () => new window.Response(JSON.stringify({ update_available: { version: '1.0.1' } })) });
  let copied = '';
  Object.defineProperty(window.navigator, 'clipboard', { value: { writeText: async (value: string) => { copied = value; } } });
  window.document.write(html); window.document.close();
  (window.document.querySelector('[data-update-copy]') as unknown as HTMLButtonElement).click();
  await new Promise(resolve => setTimeout(resolve, 10));
  expect(copied).toBe(command);
  expect(window.document.querySelector('[data-update-copy-status]')!.textContent).toBe('Copied');
  await window.happyDOM.close();
});

test('Linux checks the Linux installer and reports a newer version', async () => {
  const urls: string[] = [];
  const checker = createUpdateChecker({ ...options, platform: 'linux', fetchImpl: (async (url: string | URL | Request) => { urls.push(String(url)); return new Response(script('1.0.1')); }) as unknown as typeof fetch });
  checker.start(); await checker.check();
  expect(urls).toEqual(['https://olympusplugin.ai/install-linux.sh']);
  expect(checker.available()).toEqual({ version: '1.0.1' }); checker.stop();
});

test('an unsupported platform requests nothing', async () => {
  let calls = 0;
  const checker = createUpdateChecker({ ...options, platform: 'win32', fetchImpl: (async () => { calls++; return new Response(script('1.0.1')); }) as unknown as typeof fetch });
  checker.start(); await checker.check(); expect(calls).toBe(0); expect(checker.available()).toBeUndefined(); checker.stop();
});

test('live worker carries in-memory result to the local dashboard and engine status JSON', async () => {
  let available: { version: string } | undefined = { version: '1.0.1' };
  const worker = createEmailSourceWorker({ updateAvailable: () => available, platform: 'darwin' });
  const home = mkdtempSync(join(tmpdir(), 'update-status-'));
  try {
    const html = await (await worker.fetch(new Request('http://localhost/dashboard'))).text();
    expect(html).toContain('Olympus 1.0.1 is available.');
    const status = () => engineStatusReport({ homeDir: home, platform: 'darwin', env: { HOME: home }, exec: () => ({ status: 1, stdout: '', stderr: '' }), openclawPath: () => undefined, fetchImpl: ((url: string | URL | Request) => worker.fetch(new Request(String(url)))) as unknown as typeof fetch });
    expect((await status()).update_available).toEqual({ version: '1.0.1' });
    available = undefined;
    expect(await status()).not.toHaveProperty('update_available');
  } finally { worker.close(); rmSync(home, { recursive: true, force: true }); }
});


test('an already-open Mac dashboard shows and removes a notice from local health reads', async () => {
  const html = renderComputerHostPage({ panelHtml: '<p>panel</p>', origin: 'http://localhost', platform: 'darwin' });
  const window = new Window({ url: 'http://localhost', settings: { enableJavaScriptEvaluation: true } });
  let update: { version: string } | undefined;
  let poll: (() => void) | undefined;
  Object.defineProperty(window, 'setInterval', { value: (callback: () => void, delay: number) => { expect(delay).toBe(60_000); poll = callback; return 1; } });
  Object.defineProperty(window, 'fetch', { value: async (url: string) => {
    expect(url).toBe('/v1/health');
    return new window.Response(JSON.stringify(update ? { update_available: update } : {}));
  } });
  try {
    window.document.write(html); window.document.close();
    await new Promise(resolve => setTimeout(resolve, 10));
    expect((window.document.querySelector('[data-update-notice]') as unknown as HTMLElement).hidden).toBe(true);
    update = { version: '1.0.1' }; poll!();
    await new Promise(resolve => setTimeout(resolve, 10));
    expect((window.document.querySelector('[data-update-notice]') as unknown as HTMLElement).hidden).toBe(false);
    expect(window.document.querySelector('[data-update-text]')!.textContent).toBe('Olympus 1.0.1 is available. To update, run this in Terminal:');
    update = undefined; poll!();
    await new Promise(resolve => setTimeout(resolve, 10));
    expect((window.document.querySelector('[data-update-notice]') as unknown as HTMLElement).hidden).toBe(true);
  } finally { await window.happyDOM.close(); }
});

test('a Linux dashboard shows the Linux update command', () => {
  const html = renderComputerHostPage({ panelHtml: '<p>panel</p>', origin: 'http://localhost', platform: 'linux', updateAvailable: { version: '1.0.1' } });
  expect(html).toContain('data-update-notice');
  expect(html).toContain('curl -fsSL https://olympusplugin.ai/install-linux.sh | sh');
  expect(html).not.toContain('curl -fsSL https://olympusplugin.ai/install.sh | sh');
});


test('proxy environments never send an update request through Tor or any other proxy', async () => {
  for (const key of ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy']) {
    let calls = 0;
    const checker = createUpdateChecker({ ...options, env: { [key]: 'http://127.0.0.1:9999' }, fetchImpl: (async () => { calls++; return new Response(script('1.0.1')); }) as unknown as typeof fetch });
    checker.start(); await checker.check(); expect(calls).toBe(0); expect(checker.available()).toBeUndefined(); checker.stop();
  }
});
