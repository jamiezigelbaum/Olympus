// OLYMPUS_TEST_LANE: deploy
import { afterEach, expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { defaultSovereigntyConfigPath } from '../src/core/owner-config-read.ts';
import { loadSovereigntyPreset } from '../src/core/sovereignty.ts';
import { createDefaultSecretStore } from '../src/core/secret-store.ts';
import { installWorkerService, ensureManagedWorkerEnvironment } from '../src/core/worker-service.ts';
import { olympusDataDir } from '../src/core/remote-access.ts';
import { environmentWithWorkerSetupEnv } from '../src/core/worker-auth.ts';
import { sharedDataPath } from '../src/core/olympus-layout.ts';
import { createWorkerFetch } from '../src/core/worker-transport.ts';

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })));
function fixture() {
  const home = mkdtempSync(join(tmpdir(), 'olympus-upgrade-')); roots.push(home);
  const env = { HOME: home, OPENCLAW_STATE_DIR: join(home, '.openclaw'), XDG_RUNTIME_DIR: join(home, 'run') };
  mkdirSync(env.XDG_RUNTIME_DIR, { mode: 0o700 });
  mkdirSync(join(home, '.olympus'), { mode: 0o700 });
  const legacy = join(home, '.olympus/sovereignty.json');
  const target = join(home, '.config/olympus/sovereignty.json');
  const text = JSON.stringify(loadSovereigntyPreset('local-first'));
  writeFileSync(legacy, text, { mode: 0o600 });
  return { home, env, legacy, target, text };
}

test('unreceipted Linux moves the old sovereignty file on first read, privately and idempotently', () => {
  const f = fixture();
  expect(defaultSovereigntyConfigPath(f.env)).toBe(f.target);
  expect(readFileSync(f.target, 'utf8')).toBe(f.text);
  expect(readFileSync(`${f.legacy}.pre-xdg-migration.bak`, 'utf8')).toBe(f.text);
  expect(existsSync(f.legacy)).toBe(false);
  for (const path of [f.target, `${f.legacy}.pre-xdg-migration.bak`]) expect(statSync(path).mode & 0o777).toBe(0o600);
  expect(defaultSovereigntyConfigPath(f.env)).toBe(f.target);
});

for (const same of [true, false]) test(`an existing ${same ? 'identical' : 'different'} target is never overwritten`, () => {
  const f = fixture(); mkdirSync(join(f.home, '.config/olympus'), { recursive: true, mode: 0o700 });
  const text = same ? f.text : '{"different":true}'; writeFileSync(f.target, text, { mode: 0o600 });
  if (same) expect(defaultSovereigntyConfigPath(f.env)).toBe(f.target);
  else { expect(() => defaultSovereigntyConfigPath(f.env)).toThrow('different'); expect(readFileSync(f.legacy, 'utf8')).toBe(f.text); }
  expect(readFileSync(f.target, 'utf8')).toBe(text);
});

for (const unsafe of ['link', 'writable', 'parent-link', 'backup-conflict']) test(`migration refuses ${unsafe} without losing the old file`, () => {
  const f = fixture();
  if (unsafe === 'link') { rmSync(f.legacy); symlinkSync('/dev/null', f.legacy); }
  if (unsafe === 'writable') chmodSync(f.legacy, 0o666);
  if (unsafe === 'parent-link') symlinkSync(f.env.XDG_RUNTIME_DIR, join(f.home, '.config'));
  if (unsafe === 'backup-conflict') writeFileSync(`${f.legacy}.pre-xdg-migration.bak`, 'earlier backup', { mode: 0o600 });
  expect(() => defaultSovereigntyConfigPath(f.env)).toThrow();
  expect(existsSync(f.legacy)).toBe(true); expect(existsSync(f.target)).toBe(false);
});

test('standalone environment reconciliation retains its engine marker', () => {
  const f = fixture(); const path = join(f.home, 'worker.env');
  writeFileSync(path, 'OLYMPUS_ENGINE_HOST=1\n', { mode: 0o600 });
  ensureManagedWorkerEnvironment({ homeDir: f.home, envPath: path });
  expect(readFileSync(path, 'utf8')).toContain('OLYMPUS_ENGINE_HOST=1');
});

test('a 1.0.x OpenClaw Linux layout installs and starts a real worker without manual migration', async () => {
  const f = fixture(); const configDir = join(f.home, '.config/olympus'); mkdirSync(configDir, { recursive: true, mode: 0o700 });
  // The pre-1.3 store has exactly the same encrypted format, without a selection.
  const paths = { encryptedFilePath: join(configDir, 'secrets.enc'), keyFilePath: join(configDir, 'secrets.key') };
  await createDefaultSecretStore({ platform: 'darwin', paths }).set('upgrade-fixture', 'preserved');
  const expectedDataRoot = olympusDataDir(f.env);
  // A competing standalone folder made the stale engine marker come up empty.
  mkdirSync(join(f.home, '.local/share/olympus'), { recursive: true, mode: 0o700 });
  writeFileSync(join(f.home, '.local/share/olympus/unrelated'), 'standalone-fixture');
  const cipher = readFileSync(paths.encryptedFilePath); const key = readFileSync(paths.keyFilePath);
  const envPath = join(configDir, 'worker.env');
  writeFileSync(envPath, 'OLYMPUS_ENGINE_HOST=1\nOLYMPUS_EMAIL_AUTH_TOKEN=upgrade-fixture-token\nCUSTOM_SETTING=kept\n', { mode: 0o600 });
  const installed = installWorkerService({ homeDir: f.home, platform: 'linux', workingDirectory: process.cwd() });
  expect(readFileSync(envPath, 'utf8')).not.toContain('OLYMPUS_ENGINE_HOST=');
  expect(readFileSync(envPath, 'utf8')).toContain('CUSTOM_SETTING=kept');
  expect(JSON.stringify(installed)).toContain('OpenClaw');
  const child = Bun.spawn([process.execPath, 'src/cli.ts', 'worker', 'foreground'], {
    env: { PATH: process.env.PATH, ...f.env, OLYMPUS_SOURCE_INDEX_ENABLED: 'false', OLYMPUS_SOURCE_SCHEDULER_ENABLED: 'false' }, stdout: 'pipe', stderr: 'pipe',
  });
  const stderr = new Response(child.stderr).text();
  const stdout = new Response(child.stdout).text();
  try {
    let healthy = false;
    const client = createWorkerFetch({ env: f.env });
    for (let i = 0; i < 100; i++) {
      if (child.exitCode !== null) throw new Error(`Worker exited: ${await stderr}`);
      try { healthy = (await client('http://127.0.0.1:8787/v1/health', { signal: AbortSignal.timeout(300) })).ok; } catch { /* still starting */ }
      if (healthy) break;
      await Bun.sleep(100);
    }
    if (!healthy) { child.kill('SIGKILL'); await child.exited; throw new Error(`Worker did not become ready: ${await stderr} ${await stdout}`); }
    expect(olympusDataDir(environmentWithWorkerSetupEnv({ env: f.env }))).toBe(expectedDataRoot);
    expect(existsSync(sharedDataPath('data-owner-lock', f.env))).toBe(true);
    expect(readFileSync(f.target, 'utf8')).toBe(f.text);
    expect(await createDefaultSecretStore({ platform: 'linux', env: f.env }).get('upgrade-fixture')).toBe('preserved');
    expect(JSON.parse(readFileSync(join(configDir, 'secret-backend.json'), 'utf8'))).toEqual({ version: 1, backend: 'file' });
    expect(readFileSync(paths.encryptedFilePath)).toEqual(cipher); expect(readFileSync(paths.keyFilePath)).toEqual(key);
  } finally { child.kill('SIGKILL'); await child.exited; }
}, 30_000);
