import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  invalidateLinuxEngineLayoutMemo,
  publishLinuxEngineReceipt,
  readLinuxEngineReceipt,
  resolveLinuxEngineLayout,
  writeLinuxEngineReceiptFile,
} from '../src/core/linux-engine-layout.ts';

const roots: string[] = [];
let savedHost: string | undefined;
let savedRole: string | undefined;
beforeEach(() => {
  savedHost = process.env.OLYMPUS_ENGINE_HOST;
  savedRole = process.env.OLYMPUS_WORKER_ENGINE_ROLE;
  process.env.OLYMPUS_ENGINE_HOST = '1';
  delete process.env.OLYMPUS_WORKER_ENGINE_ROLE;
  invalidateLinuxEngineLayoutMemo();
});
afterEach(() => {
  if (savedHost === undefined) delete process.env.OLYMPUS_ENGINE_HOST;
  else process.env.OLYMPUS_ENGINE_HOST = savedHost;
  if (savedRole === undefined) delete process.env.OLYMPUS_WORKER_ENGINE_ROLE;
  else process.env.OLYMPUS_WORKER_ENGINE_ROLE = savedRole;
  invalidateLinuxEngineLayoutMemo();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const home = fs.mkdtempSync(join(tmpdir(), 'layout-memo-'));
  roots.push(home);
  const env = { HOME: home, XDG_CONFIG_HOME: join(home, 'config'), XDG_DATA_HOME: join(home, 'data'),
    XDG_STATE_HOME: join(home, 'state'), XDG_CACHE_HOME: join(home, 'cache'), XDG_RUNTIME_DIR: join(home, 'run') };
  fs.mkdirSync(env.XDG_RUNTIME_DIR, { mode: 0o700 });
  return env;
}
function diskSpies() {
  const spies = [spyOn(fs, 'lstatSync'), spyOn(fs, 'readdirSync'), spyOn(fs, 'readFileSync')];
  return {
    calls: () => spies.map(spy => spy.mock.calls.length),
    clear: () => { for (const spy of spies) spy.mockClear(); },
    restore: () => { for (const spy of spies) spy.mockRestore(); },
  };
}

for (const role of ['standalone', 'front', 'background']) {
  for (const installed of [false, true]) {
    test(`${role}: 1,000 warm resolves and receipt reads make zero filesystem calls (${installed ? 'installed' : 'absent'})`, () => {
      const env = fixture();
      if (role !== 'standalone') {
        delete process.env.OLYMPUS_ENGINE_HOST;
        // engineRoleFromEnv accepts surrounding whitespace too.
        process.env.OLYMPUS_WORKER_ENGINE_ROLE = role === 'front' ? ' front ' : role;
      }
      if (installed) publishLinuxEngineReceipt(resolveLinuxEngineLayout(env));
      else fs.mkdirSync(join(env.XDG_DATA_HOME, 'olympus'), { recursive: true, mode: 0o700 });
      const spies = diskSpies();
      try {
        const first = resolveLinuxEngineLayout(env);
        const cold = spies.calls();
        expect(cold[0]).toBeGreaterThan(0);
        if (installed) expect(cold[2]).toBeGreaterThan(0);
        else expect(cold[1]).toBeGreaterThan(0);
        spies.clear();
        for (let i = 0; i < 1_000; i++) {
          expect(resolveLinuxEngineLayout({ ...env })).toEqual(first);
          expect(readLinuxEngineReceipt(first.receiptPath)?.installationState).toBe(installed ? 'installed' : undefined);
        }
        expect(spies.calls()).toEqual([0, 0, 0]);
      } finally { spies.restore(); }
    });
  }
}

test('publish invalidates cached absence, receipt contents and every layout key', () => {
  const env = fixture();
  const layout = resolveLinuxEngineLayout(env);
  const drift = { ...env, XDG_DATA_HOME: join(env.HOME, 'other-data') };
  expect(resolveLinuxEngineLayout(drift).dataDir).not.toBe(layout.dataDir);
  expect(readLinuxEngineReceipt(layout.receiptPath)).toBeUndefined();
  publishLinuxEngineReceipt(layout);
  expect(resolveLinuxEngineLayout(drift)).toEqual(layout);
  expect(readLinuxEngineReceipt(layout.receiptPath)?.installationState).toBe('installed');
  publishLinuxEngineReceipt(layout, { openHandlerPending: true });
  expect(readLinuxEngineReceipt(layout.receiptPath)?.openHandlerPending).toBe(true);
});

test('HOME, every XDG root, receipt path and UID have separate memo entries', () => {
  const env = fixture();
  const first = resolveLinuxEngineLayout(env);
  const other = fixture();
  const second = resolveLinuxEngineLayout(other);
  expect(second.home).toBe(other.HOME);
  expect(second.dataDir).not.toBe(first.dataDir);
  for (const key of ['XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_STATE_HOME', 'XDG_CACHE_HOME', 'XDG_RUNTIME_DIR'] as const) {
    expect(resolveLinuxEngineLayout({ ...env, [key]: join(env.HOME, `other-${key}`) })).not.toEqual(first);
  }
  publishLinuxEngineReceipt(first);
  publishLinuxEngineReceipt(second, { openHandlerPending: true });
  expect(readLinuxEngineReceipt(first.receiptPath)?.openHandlerPending).toBeUndefined();
  expect(readLinuxEngineReceipt(second.receiptPath)?.openHandlerPending).toBe(true);
  expect(() => readLinuxEngineReceipt(first.receiptPath, process.getuid!() + 1)).toThrow();
});

test('callers cannot mutate the validated memo through returned values', () => {
  const env = fixture();
  const layout = resolveLinuxEngineLayout(env);
  publishLinuxEngineReceipt(layout);
  const first = resolveLinuxEngineLayout(env);
  const receipt = readLinuxEngineReceipt(first.receiptPath)!;
  first.dataDir = '/synthetic-mutated-data';
  receipt.layout.configDir = '/synthetic-mutated-config';
  receipt.ownedUnitLinks.push('/synthetic-mutated-link');
  expect(resolveLinuxEngineLayout(env)).toEqual(layout);
  expect(readLinuxEngineReceipt(layout.receiptPath)?.layout).toEqual(layout);
  expect(readLinuxEngineReceipt(layout.receiptPath)?.ownedUnitLinks).toEqual([]);
});

test('invalidation rechecks receipt permissions, ancestors and the full schema', () => {
  const env = fixture();
  const layout = resolveLinuxEngineLayout(env);
  const receipt = publishLinuxEngineReceipt(layout);
  resolveLinuxEngineLayout(env);
  fs.chmodSync(layout.receiptPath, 0o644);
  invalidateLinuxEngineLayoutMemo();
  expect(() => readLinuxEngineReceipt(layout.receiptPath)).toThrow('must be private');
  fs.chmodSync(layout.receiptPath, 0o600);
  readLinuxEngineReceipt(layout.receiptPath);
  fs.chmodSync(layout.configDir, 0o777);
  invalidateLinuxEngineLayoutMemo();
  expect(() => resolveLinuxEngineLayout(env)).toThrow('unsafe writable permissions');
  fs.chmodSync(layout.configDir, 0o700);
  writeLinuxEngineReceiptFile(layout.receiptPath, JSON.stringify({ ...receipt, layout: { ...layout, dataDir: '/synthetic-invalid-data' } }));
  expect(() => readLinuxEngineReceipt(layout.receiptPath)).toThrow('Invalid Linux data root');
});

test('receipt removal invalidation drops both the receipt and discovered layout', () => {
  const env = fixture();
  const layout = resolveLinuxEngineLayout(env);
  publishLinuxEngineReceipt(layout);
  const drift = { ...env, XDG_DATA_HOME: join(env.HOME, 'after-removal') };
  expect(resolveLinuxEngineLayout(drift)).toEqual(layout);
  fs.rmSync(layout.receiptPath);
  invalidateLinuxEngineLayoutMemo();
  expect(readLinuxEngineReceipt(layout.receiptPath)).toBeUndefined();
  expect(resolveLinuxEngineLayout(drift).dataHome).toBe(drift.XDG_DATA_HOME);
});

test('short-lived callers keep reading external changes even with supplied engine flags', () => {
  delete process.env.OLYMPUS_ENGINE_HOST;
  const env = { ...fixture(), OLYMPUS_ENGINE_HOST: '1' };
  const layout = resolveLinuxEngineLayout(env);
  const receipt = publishLinuxEngineReceipt(layout);
  readLinuxEngineReceipt(layout.receiptPath);
  fs.writeFileSync(layout.receiptPath, JSON.stringify({ ...receipt, openHandlerPending: true }), { mode: 0o600 });
  expect(readLinuxEngineReceipt(layout.receiptPath)?.openHandlerPending).toBe(true);
  fs.rmSync(layout.receiptPath);
  expect(readLinuxEngineReceipt(layout.receiptPath)).toBeUndefined();
  const legacy = join(env.XDG_DATA_HOME, 'openclaw/olympus');
  fs.mkdirSync(legacy, { recursive: true, mode: 0o700 });
  fs.writeFileSync(join(legacy, 'synthetic-data'), 'data');
  expect(resolveLinuxEngineLayout(env).dataDir).toBe(legacy);
});
