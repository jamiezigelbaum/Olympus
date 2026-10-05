/**
 * Stand-in for `dist/cli.js __relay-service-run <instance>` in the native relay
 * service tests: the real runtime, pointed at the test relay on loopback
 * (plain ws://) named in its environment.
 */
import { runRelayRuntimeProcess } from '../../../src/core/remote-relay-runtime.ts';

const [command, instanceId] = process.argv.slice(2);
if (command !== '__relay-service-run' || !instanceId) throw new Error('unexpected relay child arguments');
await runRelayRuntimeProcess(instanceId, {
  relayUrl: `ws://127.0.0.1:${Number(process.env.TEST_RELAY_PORT)}/v2/connect`,
  heartbeatMs: 1_000,
  backoff: { minMs: 50, maxMs: 200 },
  ...(process.env.TEST_STATUS_REFRESH_MS ? { statusRefreshMs: Number(process.env.TEST_STATUS_REFRESH_MS) } : {}),
});
process.exit(0);
