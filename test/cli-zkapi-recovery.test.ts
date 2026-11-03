import { afterEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runZkapiRecoveryCommand } from '../src/cli.ts';
import { DASHBOARD_OUTSIDE_HELP_COPY as W } from '../src/workers/dashboard/vocabulary.ts';
import { baseConfig, zkapiProfile } from './helpers/zkapi-transport-harness.ts';
import { zkapiFenceScope, zkapiOutstandingFences } from '../src/core/consult-transport-zkapi.ts';
import type { SovereigntyConfig } from '../src/core/sovereignty.ts';

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })));
function fixture() {
  const home = mkdtempSync(join(tmpdir(), 'zk-recovery-')); roots.push(home);
  const env = { HOME: home, ZKAPI_CLIENTD_CONFIG_DIR: home };
  const statePath = join(home, 'state.json'); const scope = zkapiFenceScope({ env });
  writeFileSync(statePath, JSON.stringify({ version: 1, day: '2026-11-03', count: 1, reservedMicroUsd: 1000000, fences: { [scope]: { at: '2026-11-03T00:00:00Z' } } }));
  const config = baseConfig() as SovereigntyConfig; config.modelProfiles.zk = zkapiProfile() as SovereigntyConfig['modelProfiles'][string];
  const lines: string[] = []; const prompts: string[] = [];
  return { statePath, scope, env, lines, prompts, deps: { env, statePath, sovereignty: { config }, print: (line: string) => lines.push(line), confirm: async (line: string) => { prompts.push(line); return false; } } };
}

test('recover and abandon use the dashboard confirmations and cancellation changes nothing', async () => {
  for (const verb of ['recover', 'abandon']) {
    const f = fixture(); const before = readFileSync(f.statePath, 'utf8');
    expect(await runZkapiRecoveryCommand(verb === 'recover' ? [verb] : [verb, f.scope], f.deps)).toBe(2);
    expect(f.prompts).toEqual([verb === 'recover' ? W.recoverConfirm : W.abandonConfirm]);
    expect(readFileSync(f.statePath, 'utf8')).toBe(before);
  }
});

test('abandon with explicit confirmation records the same ledger action as the dashboard', async () => {
  const f = fixture();
  expect(await runZkapiRecoveryCommand(['abandon', f.scope, '--yes'], f.deps)).toBe(0);
  expect(zkapiOutstandingFences(f.statePath)).toEqual({});
  expect(JSON.parse(readFileSync(f.statePath, 'utf8')).abandonedFences[f.scope]).toBeDefined();
  expect(f.lines.join(' ')).toContain('marked abandoned');
});

test('recovery requires confirmed settlement and a clear fence, and never sends an owner question', async () => {
  const f = fixture(); let calls = 0;
  const recoverSession = async (route: unknown, ref: unknown) => {
    calls++; expect(route).not.toHaveProperty('question'); expect(ref).toBe('env:OLYMPUS_ZKAPI_LOCAL_API_KEY');
    return { ok: true, receipt: { fence: 'held', settlement: 'not_confirmed' } } as any;
  };
  expect(await runZkapiRecoveryCommand(['recover', '--yes'], { ...f.deps, recoverSession })).toBe(1);
  expect(calls).toBe(1); expect(f.lines.join(' ')).toContain('still held');
  const clear = async () => ({ ok: true, receipt: { fence: 'clear', settlement: 'confirmed' } }) as any;
  expect(await runZkapiRecoveryCommand(['recover', '--yes'], { ...f.deps, recoverSession: clear })).toBe(0);
});

test('recovery refuses another wallet and invalid arguments without starting a session', async () => {
  const f = fixture(); let calls = 0;
  const deps = { ...f.deps, env: { ...f.env, ZKAPI_CLIENTD_CONFIG_DIR: join(f.env.HOME, 'another') }, recoverSession: async () => { calls++; return {} as any; } };
  expect(await runZkapiRecoveryCommand(['recover', '--yes'], deps)).toBe(1);
  expect(calls).toBe(0); expect(f.lines.join(' ')).toContain('another wallet');
  await expect(runZkapiRecoveryCommand(['abandon', 'invalid', '--yes'], f.deps)).rejects.toThrow();
  await expect(runZkapiRecoveryCommand(['recover', '--force'], f.deps)).rejects.toThrow();
});

test('the public CLI dispatches abandon and refuses an unconfirmed recovery without changing the ledger', () => {
  const f = fixture();
  const dir = join(f.env.HOME, process.platform === 'linux' ? '.config/olympus' : '.olympus');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const ledger = join(dir, 'zkapi-consult-state.json');
  const original = readFileSync(f.statePath, 'utf8'); writeFileSync(ledger, original, { mode: 0o600 });
  const invoke = (args: string[]) => Bun.spawnSync([process.execPath, 'src/cli.ts', 'zkapi', ...args], { env: { PATH: process.env.PATH, ...f.env }, stdin: 'ignore' });
  const unconfirmed = invoke(['recover']);
  expect(unconfirmed.exitCode).toBe(2); expect(unconfirmed.stdout.toString()).toContain(W.recoverConfirm);
  expect(readFileSync(ledger, 'utf8')).toBe(original);
  const abandoned = invoke(['abandon', f.scope, '--yes']);
  expect({ exit: abandoned.exitCode, stderr: abandoned.stderr.toString() }).toEqual({ exit: 0, stderr: '' });
  expect(abandoned.stdout.toString()).toContain('marked abandoned');
  expect(zkapiOutstandingFences(ledger)).toEqual({});
});
