/**
 * Runs the `olympus_doctor` operation once and prints its result as JSON.
 *
 * test/operations.test.ts starts this in a child process with HOME set to a
 * temporary directory. Bun resolves `os.homedir()` once per process, and the
 * doctor's default readers and writers (connected-handle registry, pending
 * OAuth state, ingestion-health state, sovereignty policy) use it, so changing
 * `process.env.HOME` inside the test process does not isolate them.
 */
import { defaultConfig } from '../../src/core/config.ts';
import { operations, type OperationContext } from '../../src/core/operations.ts';

const doctor = operations.find((operation) => operation.name === 'olympus_doctor')!;
const profiles: unknown[] = [];
const config = defaultConfig();
config.sourceIndex.enabled = false;
// Both worker-facing lanes deliberately off, so this asserts the walk's shape
// without reaching a worker over the network. The email lane is on by default
// now: an install whose worker is not running is a red doctor, and that
// behaviour is covered in doctor.test.ts.
config.email.enabled = false;
const ctx: OperationContext = {
  config,
  delphi: {
    listModelsForProfile: async (profile: unknown) => {
      profiles.push(profile);
      return [{ id: 'model-1' }];
    },
    complete: async (options: { profile: 'default_chat' }) => ({
      text: 'OLYMPUS_DOCTOR_OK',
      profile: options.profile,
      model: 'model-1',
    }),
  } as unknown as OperationContext['delphi'],
  email: {} as OperationContext['email'],
  // Never this machine's launchd or OpenClaw: a running standalone engine.
  doctorHostProbe: () => ({ engine: { installed: true, state: 'running' }, legacyWorkerUnit: false }),
};
const result = await doctor.handler(ctx, {}) as { ok: boolean; checks: Array<{ name: string; ok: boolean }> };
process.stdout.write(JSON.stringify({
  result: { ok: result.ok, checks: result.checks.map(({ name, ok }) => ({ name, ok })) },
  profiles,
}));
