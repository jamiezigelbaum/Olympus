import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { checkMacConsentOwnerProof, evaluateMacConsentOwnerProof, macConsentOwnerProofScript, MAC_CONSENT_PROOF_ACCOUNT } from '../scripts/release-check/mac-consent-owner-proof.ts';
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

const PASS = 'page=200\nform=yes\nother_form=403\nother_form_refused=yes\nother_page=403\nowner=303\nowner_code=yes\n';

describe('release check: approving an app connection on a Mac needs the owner (#1186)', () => {
  test('passes when the second account is refused by the owner check at both paths and the owner approves', async () => {
    const f = fake('macos', { stdout: PASS });
    expect((await checkMacConsentOwnerProof(f.machine, true)).status).toBe('pass');
    expect(f.scripts).toHaveLength(1);
  });

  test('fails when the second account approves, or is refused by something other than the owner check', () => {
    expect(evaluateMacConsentOwnerProof(0, PASS.replace('other_form=403', 'other_form=303')).detail).toContain('not refused by the owner check');
    expect(evaluateMacConsentOwnerProof(0, PASS.replace('other_form_refused=yes', 'other_form_refused=no')).status).toBe('fail');
    expect(evaluateMacConsentOwnerProof(0, PASS.replace('other_page=403', 'other_page=303')).detail).toContain('/connect/authorize was not refused');
  });

  test('fails when the owner cannot approve, or the page never had a form', () => {
    expect(evaluateMacConsentOwnerProof(0, PASS.replace('owner=303', 'owner=403')).detail).toContain('owner\'s Connect did not approve');
    expect(evaluateMacConsentOwnerProof(0, PASS.replace('owner_code=yes', 'owner_code=no')).status).toBe('fail');
    expect(evaluateMacConsentOwnerProof(0, 'page=404\nform=no\n').detail).toContain('did not open with a form');
  });

  test('fails closed on a missing answer, a script failure or an exec error', async () => {
    expect(evaluateMacConsentOwnerProof(0, '').status).toBe('fail');
    expect(evaluateMacConsentOwnerProof(1, PASS).status).toBe('fail');
    expect((await checkMacConsentOwnerProof(fake('macos', new Error('driver gone')).machine, true)).status).toBe('fail');
  });

  test('skips Linux, and a run with no relay, without running anything', async () => {
    const linux = fake('linux', { stdout: PASS });
    expect((await checkMacConsentOwnerProof(linux.machine, true)).status).toBe('skip');
    const noRelay = fake('macos', { stdout: PASS });
    expect((await checkMacConsentOwnerProof(noRelay.machine, false)).status).toBe('skip');
    expect([...linux.scripts, ...noRelay.scripts]).toEqual([]);
  });

  test('the script makes a standard account, posts as it with no session, removes it on every exit, and prints no credential', () => {
    const script = macConsentOwnerProofScript();
    expect(script).toContain(`account=${MAC_CONSENT_PROOF_ACCOUNT}`);
    expect(script).toContain('sysadminctl -addUser "$account"');
    expect(script).not.toContain('-admin');
    expect(script).toContain('trap cleanup EXIT HUP INT TERM');
    expect(script).toContain('sysadminctl -deleteUser "$account"');
    expect(script).toContain('sudo -n -u "$account"');
    expect(script).toContain('unset token');
    // Only status codes and yes/no flags are echoed.
    for (const line of script.split('\n').map((l) => l.trim()).filter((l) => /\becho\b/.test(l))) {
      expect(line).toMatch(/echo "(page|form|other_form|other_form_refused|other_page|owner|owner_code)=/);
    }
    // It is valid bash.
    expect(spawnSync('bash', ['-n'], { input: script, encoding: 'utf8' }).status).toBe(0);
  });
});
