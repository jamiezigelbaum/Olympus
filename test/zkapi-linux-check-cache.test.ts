// OLYMPUS_TEST_LANE: deploy
import { expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync, rmSync, utimesSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { linuxZkapiConfinement } from '../src/core/zkapi-confinement-linux.ts';
import { MANAGED_TOOL_PINS } from '../src/core/managed-tools.ts';
const passed = { ok: true, landlockAbi: 4, layers: ['netns','pidns','ipv6-off','caps','nnp','launcher-undumpable','launcher-seccomp','landlock-net','seccomp'], stage0Layers: ['nnp','launcher-undumpable','launcher-seccomp'] };
const ports = { tor: 9001, daemon: 9002, companionProxy: 9003, walletApi: 9004 };
async function fixture(run: (path: string) => Promise<void>) {
  const dir = mkdtempSync(join(tmpdir(), 'zk-check-cache-'));
  const path = join(dir, 'launcher');
  writeFileSync(path, 'original', { mode: 0o700 });
  try { await run(path); } finally { rmSync(dir, { recursive: true, force: true }); }
}
test('two status renders and concurrent callers run the launcher once across objects', async () => fixture(async path => {
  let calls = 0;
  const deps = { platform: 'linux' as const, arch: 'x64', resolveLauncher: () => path, check: async () => { calls++; await Bun.sleep(20); return passed; } };
  const a = linuxZkapiConfinement(deps), b = linuxZkapiConfinement(deps);
  expect(a.level).toBe('none');
  expect(calls).toBe(0);
  expect((await Promise.all([a.check!(), b.check!()])).every(r => r.ok)).toBe(true);
  expect((await linuxZkapiConfinement(deps).check!()).ok).toBe(true);
  expect(calls).toBe(1);
}));
test('changed launcher content with restored mtime invalidates success', async () => fixture(async path => {
  let calls = 0;
  const deps = { platform: 'linux' as const, arch: 'x64', resolveLauncher: () => path, check: () => { calls++; return passed; } };
  const a = linuxZkapiConfinement(deps);
  expect((await a.check!()).ok).toBe(true);
  const before = statSync(path);
  writeFileSync(path, 'modified'); utimesSync(path, before.atime, before.mtime);
  expect((await a.check!()).ok).toBe(true);
  expect(calls).toBe(2);
}));
test('a failed check is shared and retried after thirty seconds', async () => fixture(async path => {
  let time = 0, calls = 0;
  const deps = { platform: 'linux' as const, arch: 'x64', resolveLauncher: () => path, now: () => time, check: () => { calls++; return calls === 1 ? { ok: false, code: 'namespace_unavailable' } : passed; } };
  expect((await linuxZkapiConfinement(deps).check!()).ok).toBe(false);
  time = 29_999;
  expect((await linuxZkapiConfinement(deps).check!()).ok).toBe(false);
  expect(calls).toBe(1);
  time = 30_000;
  expect((await linuxZkapiConfinement(deps).check!()).ok).toBe(true);
  expect(calls).toBe(2);
}));
test('activation refuses a changed launcher whose new check fails', async () => fixture(async path => {
  let allowed = true;
  const a = linuxZkapiConfinement({ platform: 'linux', arch: 'x64', resolveLauncher: () => path, check: () => allowed ? passed : { ok: false, code: 'restriction_failed' }, selfTest: async () => true });
  expect((await a.check!()).ok).toBe(true);
  writeFileSync(path, 'changed'); allowed = false;
  expect(await a.selfTest('/fixture', {}, ports)).toBe(false);
  await expect(a.prepare!('/fixture', ports)).rejects.toThrow('confinement_unavailable');
}));
test('launcher changed while check is pending cannot publish success', async () => fixture(async path => {
  const a = linuxZkapiConfinement({ platform: 'linux', arch: 'x64', resolveLauncher: () => path, check: async () => { writeFileSync(path, 'replacement'); return passed; } });
  expect((await a.check!()).ok).toBe(false);
  expect(a.level).toBe('none');
}));
test('real launcher execution leaves the worker event loop responsive', async () => fixture(async path => {
  writeFileSync(path, `#!/bin/sh\nif [ "$1" = '--version' ]; then echo 'zkapi-confine ${MANAGED_TOOL_PINS['zkapi-clientd'].version}'; exit; fi\nsleep 0.2\nprintf '%s\\n' '${JSON.stringify(passed)}'\n`);
  const a = linuxZkapiConfinement({ platform: 'linux', arch: 'x64', resolveLauncher: () => path });
  let settled = false;
  const pending = a.check!().then(r => { settled = true; return r; });
  await Bun.sleep(20);
  expect(settled).toBe(false);
  expect((await pending).ok).toBe(true);
}));

test('a failed version command cannot masquerade as a passing host check', async () => fixture(async path => {
  writeFileSync(path, `#!/bin/sh\nprintf '%s\\n' '${JSON.stringify(passed)}'\nexit 1\n`);
  const a = linuxZkapiConfinement({ platform: 'linux', arch: 'x64', resolveLauncher: () => path });
  expect((await a.check!()).ok).toBe(false);
  expect(a.level).toBe('none');
}));
