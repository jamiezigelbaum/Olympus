// The worker service unit's own process with the engine split on, run as a
// real process (test/worker-service-split.test.ts): it supervises the
// stand-in children with the process's own signals, exit and stdio, so a
// test sees what systemd would: whether it stays up, what reaches its log,
// and its exit code.
import { join } from 'node:path';
import { superviseWorkerServiceSplit } from '../../src/core/worker-service-split.ts';

await superviseWorkerServiceSplit({
  env: process.env,
  runtimePath: process.execPath,
  executablePath: join(import.meta.dir, 'worker-service-split-child.ts'),
  authToken: process.env.OLYMPUS_WORKER_AUTH_TOKEN!,
  restartDelaysMs: [300],
  readinessPollMs: 20,
  startupTimeoutMs: 10_000,
  stopGraceMs: 3_000,
});
