// OLYMPUS_TEST_LANE: deploy
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDefaultSecretStore } from '../src/core/secret-store.ts';

describe('Linux durable secret backend', () => {
  test('fresh selection is durable file even with secret-tool and later desktop login', async () => {
    const root = mkdtempSync(join(tmpdir(), 'linux-secrets-'));
    const paths = { encryptedFilePath: join(root, 'secrets.enc'), keyFilePath: join(root, 'secrets.key') };
    const runner = () => { throw new Error('Auto must not probe desktop tools'); };
    try {
      const store = createDefaultSecretStore({ platform: 'linux', env: {}, paths, runner });
      expect(store.label).toBe('encrypted-file');
      expect(JSON.parse(readFileSync(join(root, 'secret-backend.json'), 'utf8'))).toEqual({ version: 1, backend: 'file' });
      await store.set('fixture', 'fixture-value');
      const restarted = createDefaultSecretStore({ platform: 'linux', env: { DISPLAY: ':0' }, paths, runner });
      expect(await restarted.get('fixture')).toBe('fixture-value');
      expect(() => createDefaultSecretStore({ platform: 'linux', env: { OLYMPUS_SECRET_STORE_BACKEND: 'libsecret' }, paths, runner })).toThrow();
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test('lost wrapping key refuses without generating a replacement', async () => {
    const root = mkdtempSync(join(tmpdir(), 'linux-secrets-'));
    const paths = { encryptedFilePath: join(root, 'secrets.enc'), keyFilePath: join(root, 'secrets.key') };
    try {
      const store = createDefaultSecretStore({ platform: 'linux', env: { OLYMPUS_SECRET_STORE_BACKEND: 'file' }, paths });
      await store.set('fixture', 'fixture-value');
      const ciphertext = readFileSync(paths.encryptedFilePath);
      rmSync(paths.keyFilePath);
      await expect(store.get('fixture')).rejects.toMatchObject({ code: 'corrupt' });
      expect(existsSync(paths.keyFilePath)).toBe(false);
      expect(readFileSync(paths.encryptedFilePath)).toEqual(ciphertext);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});

import { chmodSync, mkdirSync, writeFileSync, symlinkSync } from 'node:fs';
import { createCipheriv } from 'node:crypto';
import { LinuxLibsecretSecretStore, runLinuxSecretCommand, SecretStoreError, type CommandRunner } from '../src/core/secret-store.ts';
import { resolveLinuxSecretPaths } from '../src/core/linux-secret-backend.ts';
import { resolveLinuxEngineLayout, publishLinuxEngineReceipt } from '../src/core/linux-engine-layout.ts';
import { resolveRemoteConnectionsDbPathForCli } from '../src/core/remote-connections.ts';

test('secret consumers follow the installed receipt after shell XDG roots drift', async () => {
  const root = mkdtempSync(join(tmpdir(), 'linux-secret-layout-'));
  const runtime = join(root, 'runtime'); mkdirSync(runtime, { mode: 0o700 });
  try {
    const env = { HOME: root, XDG_RUNTIME_DIR: runtime, XDG_DATA_HOME: join(root, 'data') };
    const layout = resolveLinuxEngineLayout(env);
    publishLinuxEngineReceipt(layout);
    const drift = { ...env, XDG_CONFIG_HOME: join(root, 'different-config'), XDG_DATA_HOME: join(root, 'different-data') };
    const paths = resolveLinuxSecretPaths(drift);
    expect(paths.encryptedFilePath).toBe(layout.secretsPath);
    expect(paths.keyFilePath).toBe(layout.secretsKeyPath);
    expect(paths.backendFilePath).toBe(join(layout.configDir, 'secret-backend.json'));
    expect(resolveRemoteConnectionsDbPathForCli(drift)).toBe(join(layout.dataDir, 'remote-connections.sqlite'));
    await createDefaultSecretStore({ platform: 'linux', env: drift }).set('fixture', 'fixture-value');
    expect(await createDefaultSecretStore({ platform: 'linux', env }).get('fixture')).toBe('fixture-value');
    expect(existsSync(join(root, 'different-config'))).toBe(false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'linux-secrets-'));
  const paths = { encryptedFilePath: join(root, 'secrets.enc'), keyFilePath: join(root, 'secrets.key'), backendFilePath: join(root, 'secret-backend.json') };
  return { root, paths, make: (env = {}) => createDefaultSecretStore({ platform: 'linux', env, paths }), clean: () => rmSync(root, { recursive: true, force: true }) };
}

for (const invalid of ['', '{', '{"version":1,"backend":"auto"}', 'null']) {
  test(`interrupted or invalid published selection refuses: ${JSON.stringify(invalid)}`, () => {
    const f = fixture();
    try { writeFileSync(f.paths.backendFilePath, invalid, { mode: 0o600 }); expect(f.make).toThrow(SecretStoreError); expect(existsSync(f.paths.keyFilePath)).toBe(false); }
    finally { f.clean(); }
  });
}

test('selection cannot publish over a conflicting object; no credential write starts', () => {
  const f = fixture();
  try { mkdirSync(f.paths.backendFilePath); expect(f.make).toThrow(SecretStoreError); expect(existsSync(f.paths.keyFilePath)).toBe(false); }
  finally { f.clean(); }
});

test('unpublished temporary selection is ignored and durable file is chosen', () => {
  const f = fixture();
  try { writeFileSync(`${f.paths.backendFilePath}.interrupted.tmp`, '{"backend":"libsecret"}'); expect(f.make().label).toBe('encrypted-file'); }
  finally { f.clean(); }
});

test('legacy ciphertext without selection is refused without modifying it', () => {
  const f = fixture();
  try { writeFileSync(f.paths.encryptedFilePath, 'old-store', { mode: 0o600 }); expect(f.make).toThrow('no migration'); expect(readFileSync(f.paths.encryptedFilePath, 'utf8')).toBe('old-store'); expect(existsSync(f.paths.backendFilePath)).toBe(false); }
  finally { f.clean(); }
});

test('XDG paths are absolute, custom config receives all three files, shared root is not chmodded', async () => {
  const f = fixture();
  try {
    const config = join(f.root, 'config'); mkdirSync(config, { mode: 0o755 });
    const env = { XDG_CONFIG_HOME: config, HOME: f.root };
    const paths = resolveLinuxSecretPaths(env);
    expect(paths.encryptedFilePath).toBe(join(config, 'olympus/secrets.enc'));
    await createDefaultSecretStore({ platform: 'linux', env }).set('fixture', 'value');
    expect(Object.values(paths).every(existsSync)).toBe(true);
    expect(() => resolveLinuxSecretPaths({ XDG_CONFIG_HOME: 'relative' })).toThrow('absolute');
  } finally { f.clean(); }
});

test('unsafe permissions and symlinked managed paths refuse without following them', async () => {
  const f = fixture();
  try {
    const store = f.make(); await store.set('fixture', 'value');
    chmodSync(f.paths.keyFilePath, 0o644);
    await expect(store.get('fixture')).rejects.toMatchObject({ code: 'permission' });
    chmodSync(f.paths.keyFilePath, 0o600);
    const original = readFileSync(f.paths.encryptedFilePath);
    rmSync(f.paths.encryptedFilePath); writeFileSync(join(f.root, 'target'), original, { mode: 0o600 });
    symlinkSync(join(f.root, 'target'), f.paths.encryptedFilePath);
    await expect(store.delete('fixture')).rejects.toMatchObject({ code: 'permission' });
    expect(readFileSync(join(f.root, 'target'))).toEqual(original);
  } finally { f.clean(); }
});

test('corrupt ciphertext and invalid wrapping keys fail with typed errors on every operation', async () => {
  const f = fixture();
  try {
    const store = f.make(); await store.set('fixture', 'value');
    writeFileSync(f.paths.keyFilePath, 'bad');
    await expect(store.get('fixture')).rejects.toMatchObject({ code: 'corrupt' });
    writeFileSync(f.paths.encryptedFilePath, '{');
    for (const op of [() => store.get('fixture'), () => store.list(), () => store.set('x', 'y'), () => store.delete('fixture')]) {
      await expect(op()).rejects.toMatchObject({ code: 'corrupt' });
    }
  } finally { f.clean(); }
});

test('Mac reads a fixed pre-change AES-GCM fixture byte-for-byte without creating backend selection', async () => {
  const f = fixture();
  try {
    const key = Buffer.alloc(32, 7), iv = Buffer.alloc(12, 3);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    const ciphertext = Buffer.concat([cipher.update('{"version":1,"secrets":{"fixture":"  value\\n"}}'), cipher.final()]);
    const original = JSON.stringify({ version: 1, algorithm: 'aes-256-gcm', kdf: 'local-random-key', iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), ciphertext: ciphertext.toString('base64') }, null, 2);
    writeFileSync(f.paths.encryptedFilePath, original); writeFileSync(f.paths.keyFilePath, key.toString('base64'));
    const store = createDefaultSecretStore({ platform: 'darwin', paths: f.paths, env: { XDG_CONFIG_HOME: 'ignored-relative' } });
    expect(await store.get('fixture')).toBe('  value\n');
    expect(readFileSync(f.paths.encryptedFilePath, 'utf8')).toBe(original);
    expect(existsSync(f.paths.backendFilePath)).toBe(false);
  } finally { f.clean(); }
});

const collection = '/org/freedesktop/secrets/collection/login';
function fakeService(options: { locked?: boolean; itemLocked?: boolean; failure?: string; failedAction?: string } = {}) {
  const values = new Map<string, string>();
  const calls: { command: string; args: string[]; input?: string }[] = [];
  const deleteItem = (path: string) => {
    const key = [...values.keys()][Number(path.split('_').at(-1))];
    if (key !== undefined) values.delete(key);
  };
  const runner: CommandRunner = (command, args, input) => {
    calls.push({ command, args, ...(input ? { input } : {}) });
    const ok = (stdout = '') => ({ status: 0, stdout, stderr: '' });
    const json = (type: string, data: unknown[]) => ok(JSON.stringify({ type, data }));
    if (options.failure) return { status: 1, stdout: '', stderr: options.failure };
    if (command === '/usr/bin/python3') {
      const req = JSON.parse(input!);
      if (req.action === 'bus') {
        if (req.method === 'ReadAlias') return json('o', [collection]);
        if (req.method === 'SearchItems') {
          const key = req.args[0].key;
          const items = [...values.keys()].filter((k) => !key || k === key).map((k) => `${collection}/item_${[...values.keys()].indexOf(k)}`);
          return json('aoao', [items, []]);
        }
        if (req.method === 'Delete') { deleteItem(req.path); return json('o', ['/']); }
        if (req.args[1] === 'Locked') return json('b', [options.locked || (req.args[0] === 'org.freedesktop.Secret.Item' && options.itemLocked) || false]);
        if (req.args[1] === 'Attributes') return json('a{ss}', [{ key: [...values.keys()][Number(req.path.split('_').at(-1))] }]);
      }
      // The fixed helper deletes the exact prevalidated item paths; the pre-fix
      // helper re-searched by attribute. Model both request shapes.
      const action = req.action === 'delete' ? 'clear' : req.action;
      if (action === options.failedAction) return { status: 1, stdout: '', stderr: 'permission' };
      if (action === 'store') { values.set(req.key, req.value); return ok(); }
      if (action === 'lookup') return values.has(req.key) ? ok(values.get(req.key)) : { status: 1, stdout: '', stderr: '' };
      if (action === 'clear') {
        if (Array.isArray(req.items)) {
          for (const path of req.items as string[]) deleteItem(path);
        } else {
          values.delete(req.key);
        }
        return ok();
      }
    }
    throw new Error('Unexpected call');
  };
  return { values, calls, runner, store: new LinuxLibsecretSecretStore({ runner }) };
}

test('libsecret explicit opt-in persists; backend outage cannot fall back to files', async () => {
  const f = fixture();
  try {
    const runner: CommandRunner = () => ({ status: 1, stdout: '', stderr: 'ServiceUnknown' });
    const store = createDefaultSecretStore({ platform: 'linux', paths: f.paths, env: { OLYMPUS_SECRET_STORE_BACKEND: 'libsecret' }, runner });
    expect(store.label).toBe('libsecret');
    await expect(store.get('fixture')).rejects.toMatchObject({ code: 'unavailable' });
    expect(createDefaultSecretStore({ platform: 'linux', paths: f.paths, env: {}, runner }).label).toBe('libsecret');
    expect(existsSync(f.paths.encryptedFilePath)).toBe(false);
  } finally { f.clean(); }
});

test('libsecret roundtrip preserves bytes, proves absence, and probe cleans up', async () => {
  const f = fakeService();
  expect(f.store.getSync('absent')).toBeUndefined();
  await f.store.set('fixture', ' fixture-payload-8ea8\n');
  expect(await f.store.get('fixture')).toBe(' fixture-payload-8ea8\n');
  expect(await f.store.list()).toEqual(['fixture']);
  await f.store.delete('fixture');
  expect(await f.store.get('fixture')).toBeUndefined();
  await f.store.probe();
  expect(f.values.size).toBe(0);
  expect(f.calls.some((c) => JSON.stringify(c.args).includes('fixture-payload-8ea8'))).toBe(false);
});

for (const [failure, code] of [['IsLocked', 'locked'], ['AccessDenied sensitive-provider-output', 'permission'], ['TimedOut', 'timeout'], ['ServiceUnknown', 'unavailable']] as const) {
  test(`libsecret ${code} never becomes missing and is safe to report`, async () => {
    const f = fakeService({ failure });
    expect(() => f.store.getSync('fixture')).toThrow(SecretStoreError);
    for (const op of [() => f.store.get('fixture'), () => f.store.set('fixture', 'value'), () => f.store.delete('fixture'), () => f.store.list()]) {
      await expect(op()).rejects.toMatchObject({ code });
      try { await op(); } catch (e) { expect(String(e)).not.toContain('sensitive-provider-output'); }
    }
  });
}

for (const option of ['locked', 'itemLocked'] as const) {
  test(`D-Bus ${option} prevents secret access`, async () => {
    const f = fakeService({ [option]: true }); f.values.set('fixture', 'value');
    await expect(f.store.get('fixture')).rejects.toMatchObject({ code: 'locked' });
    expect(f.calls.every((c) => JSON.parse(c.input!).action === 'bus')).toBe(true);
  });
}

test('failed lookup after successful preflight is unavailable, failed delete and probe cleanup are reported', async () => {
  const f = fakeService({ failedAction: 'lookup' }); f.values.set('fixture', 'value');
  await expect(f.store.get('fixture')).rejects.toMatchObject({ code: 'permission' });
  const d = fakeService({ failedAction: 'clear' }); d.values.set('fixture', 'value');
  await expect(d.store.delete('fixture')).rejects.toMatchObject({ code: 'permission' });
  await expect(d.store.probe()).rejects.toMatchObject({ code: 'cleanup' });
});

// Secret Service SearchItems matches attributes across the whole service, while
// the chosen collection is only one of several it can return; Delete acts on an
// exact item path. `delete` must therefore reuse set's collection/ambiguity
// preflight and must act on the paths preflight proved, never on a repeat
// attributes search.
const otherCollection = '/org/freedesktop/secrets/collection/other';
function pathService(seed: { path: string; key: string; value: string }[] = []) {
  const items = new Map(seed.map((entry): [string, { key: string; value: string }] => [entry.path, { key: entry.key, value: entry.value }]));
  const calls: { command: string; args: string[]; input?: string }[] = [];
  let onDelete: (() => void) | undefined;
  const matched = (attrs: { application?: string | undefined; key?: string | undefined }) =>
    [...items].filter(([, item]) => (!attrs.key || item.key === attrs.key) && (!attrs.application || attrs.application === 'olympus')).map(([path]) => path);
  const remove = (exact: string[] | undefined, attrs: { key?: string | undefined }) => {
    // An explicit path list is the fixed contract; the attributes lookup is the
    // pre-fix helper's repeat search, kept so the regression is red before it.
    for (const path of exact ?? matched({ application: 'olympus', key: attrs.key })) items.delete(path);
  };
  const runner: CommandRunner = (command, args, input) => {
    calls.push({ command, args, ...(input ? { input } : {}) });
    const ok = (stdout = '') => ({ status: 0, stdout, stderr: '' });
    const json = (type: string, data: unknown[]) => ok(JSON.stringify({ type, data }));
    if (command !== '/usr/bin/python3') throw new Error('Unexpected call');
    const request = JSON.parse(input!);
    if (request.action === 'bus') {
      if (request.method === 'ReadAlias') return json('o', [collection]);
      if (request.method === 'SearchItems') return json('aoao', [matched(request.args[0] ?? {}), []]);
      if (request.method === 'Delete') { onDelete?.(); remove([request.path], {}); return json('o', ['/']); }
      if (request.args[1] === 'Locked') return json('b', [false]);
      if (request.args[1] === 'Attributes') return json('a{ss}', [{ application: 'olympus', key: items.get(request.path)?.key }]);
    }
    if (request.action === 'clear' || request.action === 'delete') {
      onDelete?.();
      remove(Array.isArray(request.items) ? request.items as string[] : undefined, request);
      return ok();
    }
    throw new Error(`Unexpected call ${request.action}`);
  };
  return {
    items, calls, runner,
    store: new LinuxLibsecretSecretStore({ runner }),
    onDelete: (fn: () => void) => { onDelete = fn; },
  };
}

test('libsecret delete refuses an Olympus item outside the selected collection and leaves it intact', async () => {
  const foreign = `${otherCollection}/item_0`;
  const f = pathService([{ path: foreign, key: 'fixture', value: 'value' }]);
  await expect(f.store.delete('fixture')).rejects.toMatchObject({ code: 'configuration' });
  expect(f.items.get(foreign)?.value).toBe('value');
});

test('libsecret delete refuses ambiguous matches like set and deletes neither', async () => {
  const first = `${collection}/item_0`, second = `${collection}/item_1`;
  const f = pathService([{ path: first, key: 'fixture', value: 'one' }, { path: second, key: 'fixture', value: 'two' }]);
  await expect(f.store.delete('fixture')).rejects.toMatchObject({ code: 'configuration' });
  expect([...f.items.keys()]).toEqual([first, second]);
});

test('libsecret delete acts on the prevalidated item path, never a later attributes match', async () => {
  const target = `${collection}/item_0`, latecomer = `${collection}/item_1`;
  const f = pathService([{ path: target, key: 'fixture', value: 'value' }]);
  // A second item with identical attributes materializes between preflight and delete.
  f.onDelete(() => f.items.set(latecomer, { key: 'fixture', value: 'late' }));
  await expect(f.store.delete('fixture')).rejects.toMatchObject({ code: 'unavailable' });
  expect(f.items.has(target)).toBe(false);
  expect(f.items.has(latecomer)).toBe(true);
});

test('libsecret delete removes the single prevalidated in-collection item', async () => {
  const only = `${collection}/item_0`;
  const f = pathService([{ path: only, key: 'fixture', value: 'value' }]);
  expect(await f.store.delete('fixture')).toBeUndefined();
  expect(f.items.has(only)).toBe(false);
});

test('hung helper is killed at five seconds, even if it ignores SIGTERM', () => {
  const start = performance.now();
  const result = runLinuxSecretCommand(process.execPath, ['-e', 'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000)']);
  expect(result.errorCode).toBe('ETIMEDOUT');
  expect(performance.now() - start).toBeLessThan(6500);
}, 8000);

test('concurrent writers and deletes survive process restart without lost updates', async () => {
  const f = fixture();
  try {
    const store = f.make(); await store.set('retained', 'original');
    const script = `import { createDefaultSecretStore } from './src/core/secret-store.ts';
      const [root, id] = process.argv.slice(1);
      const store = createDefaultSecretStore({ platform: 'linux', env: {}, paths: { encryptedFilePath: root + '/secrets.enc', keyFilePath: root + '/secrets.key' }});
      for (let i = 0; i < 8; i++) { await store.set('writer.' + id, String(i)); await store.set('discard.' + id, 'temporary'); await store.delete('discard.' + id); }`;
    const children = Array.from({ length: 4 }, (_, i) => Bun.spawn([process.execPath, '-e', script, f.root, String(i)], { stdout: 'pipe', stderr: 'pipe' }));
    const results = await Promise.all(children.map(async (c) => ({ code: await c.exited, error: await new Response(c.stderr).text() })));
    expect(results).toEqual(Array.from({ length: 4 }, () => ({ code: 0, error: '' })));
    const restarted = f.make();
    expect(await restarted.list()).toEqual(['retained', 'writer.0', 'writer.1', 'writer.2', 'writer.3']);
    expect(await restarted.get('retained')).toBe('original');
    for (let i = 0; i < 4; i++) expect(await restarted.get(`writer.${i}`)).toBe('7');
  } finally { f.clean(); }
}, 15000);

test('the exact normalized paths validated are used for IO, including dot components after a symlink', async () => {
  const f = fixture();
  try {
    const foreign = join(f.root, 'foreign'), privateDir = join(f.root, 'private');
    mkdirSync(foreign, { mode: 0o777 }); mkdirSync(join(foreign, 'child')); mkdirSync(privateDir, { mode: 0o700 });
    symlinkSync(join(foreign, 'child'), join(privateDir, 'link'));
    const paths = { encryptedFilePath: `${privateDir}/link/../secrets.enc`, keyFilePath: `${privateDir}/link/../secrets.key`, backendFilePath: join(privateDir, 'secret-backend.json') };
    const store = createDefaultSecretStore({ platform: 'linux', env: {}, paths });
    await store.set('fixture', 'value');
    expect(existsSync(join(foreign, 'secrets.enc'))).toBe(false);
    expect(existsSync(join(foreign, 'secrets.key'))).toBe(false);
    expect(existsSync(join(privateDir, 'secrets.enc'))).toBe(true);
  } finally { f.clean(); }
});

for (const boundary of ['before', 'after']) {
  test(`selection publication failure ${boundary} rename never returns a consumer`, async () => {
    const f = fixture();
    try {
      const script = `import { mock } from 'bun:test';
        const atomic = await import('./src/core/atomic-file.ts');
        const publish = atomic.writePrivateFileAtomicSync;
        mock.module('./src/core/atomic-file.ts', () => ({ ...atomic, writePrivateFileAtomicSync(path, text) {
          if (process.argv[2] === 'after') publish(path, text);
          throw Object.assign(new Error('injected durable boundary failure'), { code: 'EIO' });
        }}));
        const { createDefaultSecretStore } = await import('./src/core/secret-store.ts');
        try {
          createDefaultSecretStore({ platform: 'linux', env: {}, paths: { encryptedFilePath: process.argv[1] + '/secrets.enc', keyFilePath: process.argv[1] + '/secrets.key' }});
          console.log('consumer-started');
        } catch (error) { console.log(error.code); process.exitCode = 7; }`;
      const child = Bun.spawn([process.execPath, '-e', script, f.root, boundary], { stdout: 'pipe', stderr: 'pipe' });
      expect(await child.exited).toBe(7);
      expect(await new Response(child.stdout).text()).toBe('unavailable\n');
      expect(existsSync(f.paths.keyFilePath)).toBe(false);
      expect(f.make().label).toBe('encrypted-file');
    } finally { f.clean(); }
  }, 30_000);
}
