// A worker stand-in with the real shutdown helper and an async teardown
// (test/worker-shutdown-repeat-signal.test.ts): the teardown finishes only
// when the test writes a line to stdin. It notes in EVENTS_PATH when the
// teardown starts and when it has drained, then exits 0.
import { appendFileSync } from 'node:fs';
import { installWorkerShutdownSignals } from '../../src/core/worker-shutdown.ts';

const note = (event: string) => appendFileSync(process.env.EVENTS_PATH!, `${event}\n`);
const signals = installWorkerShutdownSignals({ closeOwnerBridge: () => {}, exit: (code) => process.exit(code) });
signals.setShutdown(() => {
  note('teardown-started');
  void new Promise((resolve) => process.stdin.once('data', resolve)).then(() => {
    note('drained');
    process.exit(0);
  });
});
setInterval(() => {}, 60_000);
note('ready');
