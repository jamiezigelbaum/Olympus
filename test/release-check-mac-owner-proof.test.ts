import { describe, expect, test } from 'bun:test';
import { checkMacOwnerProof, evaluateMacOwnerProof, macOwnerProofScript, MAC_OWNER_PROOF_ACCOUNT } from '../scripts/release-check/mac-owner-proof.ts';
import type { ExecResult, Machine } from '../scripts/release-check/machine.ts';

function fake(os: 'linux' | 'macos', result: Partial<ExecResult> | Error) {
  const scripts: string[] = [];
  const machine = { os, exec: async (script: string): Promise<ExecResult> => {
    scripts.push(script);
    if (result instanceof Error) throw result;
    return { code: 0, stdout: '', stderr: '', timedOut: false, ms: 1, ...result };
  } } as Machine;
  return { machine, scripts };
}

describe('release check: the Mac local unlock needs the owner', () => {
  test('passes when the second account and the bare owner are refused and the owner\'s page unlocks', async () => {
    const f = fake('macos', { stdout: 'other=401\nowner_bare=401\nowner_page=200\n' });
    const check = await checkMacOwnerProof(f.machine);
    expect(check.status).toBe('pass');
    expect(f.scripts).toHaveLength(1);
    expect(evaluateMacOwnerProof(0, 'other=403\nowner_bare=401\nowner_page=200').status).toBe('pass');
  });

  test('fails when the second account gets a session', async () => {
    const check = await checkMacOwnerProof(fake('macos', { stdout: 'other=200\nowner_bare=401\nowner_page=200\n' }).machine);
    expect(check.status).toBe('fail');
    expect(check.detail).toContain('second account was not refused');
  });

  test('fails when the owner with no session is let in, or the owner\'s page cannot unlock', () => {
    expect(evaluateMacOwnerProof(0, 'other=401\nowner_bare=200\nowner_page=200').status).toBe('fail');
    expect(evaluateMacOwnerProof(0, 'other=401\nowner_bare=401\nowner_page=401').detail).toContain('could not unlock');
  });

  test('fails closed on a missing answer, a script failure or an exec error', async () => {
    expect(evaluateMacOwnerProof(0, 'other=401\nowner_page=200').status).toBe('fail');
    expect(evaluateMacOwnerProof(1, 'other=401\nowner_bare=401\nowner_page=200').status).toBe('fail');
    expect(evaluateMacOwnerProof(0, '').status).toBe('fail');
    expect((await checkMacOwnerProof(fake('macos', new Error('driver gone')).machine)).status).toBe('fail');
  });

  test('skips Linux, which proves the owner with its socket', async () => {
    const f = fake('linux', { stdout: '' });
    expect((await checkMacOwnerProof(f.machine)).status).toBe('skip');
    expect(f.scripts).toEqual([]);
  });

  test('the script makes a standard account, runs the mint as it, removes it on every exit, and prints no credential', () => {
    const script = macOwnerProofScript();
    expect(script).toContain(`account=${MAC_OWNER_PROOF_ACCOUNT}`);
    expect(script).toContain('sysadminctl -addUser "$account"');
    expect(script).not.toContain('-admin');
    expect(script).toContain('trap cleanup EXIT HUP INT TERM');
    expect(script).toContain('sysadminctl -deleteUser "$account"');
    expect(script).toContain('sudo -n -u "$account"');
    // Only status codes are echoed.
    for (const line of script.split('\n').filter((l) => l.startsWith('echo'))) expect(line).toMatch(/^echo "(other|owner_bare|owner_page)=\$\(/);
    expect(script).toContain('unset token');
  });
});
