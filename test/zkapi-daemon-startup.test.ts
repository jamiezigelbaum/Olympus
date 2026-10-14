// OLYMPUS_TEST_LANE: deploy
// Startup-only stand-ins: never dispatch a completion.
import { expect, test } from 'bun:test';
import { openZkapiConsultSession, zkapiProcessExitMessage } from '../src/core/consult-transport-zkapi.ts';
import { completions, expectNothingReserved, expectProcessesGone, ledger, SLOW, transport, useZkapiHarness, writePlan } from './helpers/zkapi-transport-harness.ts';

useZkapiHarness();

test('a companion exit at startup names the companion and drops all raw output', async () => {
  const secret = 'synthetic-secret-do-not-retain';
  writePlan({ startupError: 'zkapi-clientd ERROR zkAPI service stopped unexpectedly; run zkapi-clientd config to check the installation, then restart zkapi-clientd serve ' + secret });
  const result = await openZkapiConsultSession(transport());
  expect(result).toMatchObject({ ok: false, error: { code: 'session_process_exited', outcome: 'not_sent', receipt: { exited: { role: 'daemon', reason: 'wallet_companion_exited', code: 1, stage: 'daemonReadyMs' } } } });
  if (!result.ok) {
    expect(result.error.message).toContain('wallet companion stopped');
    expect(result.error.message).toContain('exit code 1');
    expect(result.error.message).toContain('while the daemon was starting');
  }
  expect(ledger().lastSession?.exited).toMatchObject({ reason: 'wallet_companion_exited' });
  expect(JSON.stringify(result)).not.toContain(secret);
  expect(JSON.stringify(ledger())).not.toContain(secret);
  expect(completions()).toEqual([]);
  expectNothingReserved();
  await expectProcessesGone();
}, SLOW);

test('unknown startup output remains unrecorded', async () => {
  writePlan({ startupError: 'synthetic-secret-other-failure' });
  const result = await openZkapiConsultSession(transport());
  expect(result).toMatchObject({ ok: false, error: { code: 'session_process_exited' } });
  expect(ledger().lastSession?.exited?.reason).toBeUndefined();
  expect(JSON.stringify(result)).not.toContain('synthetic-secret-other-failure');
  expect(completions()).toEqual([]);
  expectNothingReserved();
  await expectProcessesGone();
}, SLOW);

test('an outside signal keeps its explanation even when the companion also stopped', () => {
  const message = zkapiProcessExitMessage({ role: 'daemon', signal: 'SIGTERM', stage: 'daemonReadyMs', reason: 'wallet_companion_exited' });
  expect(message).toContain('signal SIGTERM');
  expect(message).toContain('while the daemon was starting');
  expect(message).toContain('Something else on this computer stopped it.');
  expect(message).not.toContain('causing');
});
