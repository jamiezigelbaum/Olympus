import { describe, expect, test } from 'bun:test';
import { checkForwardedSocketOwnerProof, evaluateForwardedSocketOwnerProof, forwardedSocketOwnerProofScript } from '../scripts/release-check/forwarded-socket-owner-proof.ts';
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

describe('release check: the forwarded owner socket is not an owner proof by itself (#1188)', () => {
  test('passes when the bare forwarded request is refused and the owner\'s opened page unlocks', async () => {
    const f = fake('linux', { stdout: 'forward_bare=401\nowner_page=200\n' });
    expect((await checkForwardedSocketOwnerProof(f.machine)).status).toBe('pass');
    expect(f.scripts).toHaveLength(1);
  });

  test('fails when the bare request mints, or the owner\'s page cannot unlock', () => {
    expect(evaluateForwardedSocketOwnerProof(0, 'forward_bare=200\nowner_page=200').detail).toContain('was not refused');
    expect(evaluateForwardedSocketOwnerProof(0, 'forward_bare=401\nowner_page=401').detail).toContain('could not unlock');
  });

  test('fails closed on a missing answer, a script failure or an exec error', async () => {
    expect(evaluateForwardedSocketOwnerProof(0, 'owner_page=200').status).toBe('fail');
    expect(evaluateForwardedSocketOwnerProof(1, 'forward_bare=401\nowner_page=200').status).toBe('fail');
    expect((await checkForwardedSocketOwnerProof(fake('linux', new Error('driver gone')).machine)).status).toBe('fail');
  });

  test('skips a Mac, which has no owner socket', async () => {
    const f = fake('macos', { stdout: '' });
    expect((await checkForwardedSocketOwnerProof(f.machine)).status).toBe('skip');
    expect(f.scripts).toEqual([]);
  });

  test('the script goes over the socket, opens the page with a remote ticket, cleans up, and prints only status codes', () => {
    const script = forwardedSocketOwnerProofScript();
    expect(script).toContain('--unix-socket "$socket"');
    expect(script).toContain('/dashboard/control/launch?purpose=remote');
    expect(script).toContain('/dashboard/control/launch/redeem');
    expect(script).toContain('trap cleanup EXIT HUP INT TERM');
    expect(script).toContain('unset token');
    expect(script).toContain('unset ticket');
    for (const line of script.split('\n').filter((l) => l.startsWith('echo'))) expect(line).toMatch(/^echo "(forward_bare|owner_page)=\$\(/);
  });
});
