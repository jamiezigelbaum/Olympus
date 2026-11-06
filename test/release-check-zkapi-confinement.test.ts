import { describe, expect, test } from 'bun:test';
import { checkZkapiConfinement } from '../scripts/release-check/zkapi-confinement.ts';
import { linuxConfinementRemedy } from '../src/core/zkapi-confinement-linux.ts';
import type { Machine, ExecResult } from '../scripts/release-check/machine.ts';

const ready = 'network confinement: ready (user, network and PID namespace, Landlock ABI 4, seccomp)\n';
const refusal = 'network confinement: unavailable: namespace_unavailable; ' + linuxConfinementRemedy('namespace_unavailable', { '/proc/sys/kernel/apparmor_restrict_unprivileged_userns': '1' }, '/home/tester/launcher') + '\n';
function fake(outputs: Array<[number, string]>, os: 'linux' | 'macos' = 'linux') {
  const scripts: string[] = [];
  const machine = { os, exec: async (script: string): Promise<ExecResult> => {
    scripts.push(script);
    const [code, stdout] = outputs.shift() ?? [1, ''];
    return { code, stdout, stderr: '', timedOut: false, ms: 1 };
  } } as Machine;
  return { machine, scripts };
}
describe('release confinement check', () => {
  test.each(['0', 'absent'])('ready without admin step (%s)', async (sysctl) => {
    const f = fake([[0, sysctl], [0, '{}'], [0, ready]]);
    expect((await checkZkapiConfinement(f.machine)).status).toBe('pass');
    expect(f.scripts).toHaveLength(3);
  });
  test('runs the printed step and checks again', async () => {
    const f = fake([[0, '1'], [0, '{}'], [1, refusal], [0, ''], [0, ready]]);
    expect((await checkZkapiConfinement(f.machine)).status).toBe('pass');
    expect(f.scripts[3]).toContain(refusal.split('\n\n')[1]!);
  });
  test('fails when the step is missing', async () => {
    expect((await checkZkapiConfinement(fake([[0, '1'], [0, '{}'], [1, 'network confinement: unavailable: missing']]).machine)).status).toBe('fail');
  });
  test('fails when still unavailable after the step', async () => {
    expect((await checkZkapiConfinement(fake([[0, '1'], [0, '{}'], [1, refusal], [0, ''], [1, refusal]]).machine)).status).toBe('fail');
  });
  test('fails when tools cannot be installed', async () => {
    expect((await checkZkapiConfinement(fake([[0, '0'], [1, '']]).machine)).status).toBe('fail');
  });
  test('skips macOS', async () => {
    expect((await checkZkapiConfinement(fake([], 'macos').machine)).status).toBe('skip');
  });
});
