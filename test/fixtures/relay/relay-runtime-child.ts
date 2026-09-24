/**
 * Stand-in for `dist/cli.js __relay-service-run <instance>` in the native relay
 * service tests: the real runtime, pointed at the test relay, CA and mock ACME
 * server named in its environment.
 */
import { runRelayRuntimeProcess } from '../../../src/core/remote-relay-runtime.ts';

const [command, instanceId] = process.argv.slice(2);
if (command !== '__relay-service-run' || !instanceId) throw new Error('unexpected relay child arguments');
await runRelayRuntimeProcess(instanceId, {
  relayAddress: { host: '127.0.0.1', port: Number(process.env.TEST_RELAY_PORT) },
  ca: process.env.TEST_RELAY_CA!,
  acmeDirectoryUrl: process.env.TEST_ACME_DIRECTORY!,
  acmePropagationDelayMs: 0,
  acmePollIntervalMs: 20,
  termsPollMs: 50,
  heartbeatMs: 1_000,
  backoff: { minMs: 50, maxMs: 200 },
});
process.exit(0);
