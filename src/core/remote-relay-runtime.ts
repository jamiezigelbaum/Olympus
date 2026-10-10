/**
 * The relay child: what `olympus __relay-service-run` runs under the Gateway's
 * native relay service (`native-relay-service.ts`).
 *
 * It keeps one session open to the Olympus relay and serves the requests the
 * relay forwards by calling the loopback worker, and reports to status.json,
 * which the worker reads for its public base URL and install id and the CLI
 * reads for `olympus connections status`. The public base URL
 * (`https://<relay host>`) is published while the child runs, so the OAuth
 * issuer never moves with the network; `relay.state` says whether hosted
 * agents can reach this Mac right now. It is cleared when the child stops.
 *
 * Every forwarded request carries a secret minted at this boot in
 * `x-olympus-relay`; the worker refuses approval for any request that carries
 * the header (see workers/remote-oauth/handler.ts), and serves the ChatGPT
 * surface and `/private` only when its value is this secret, which the child
 * writes 0600 to the remote-access directory (`relay-secret`) for the worker
 * to check, and removes when it stops.
 */
import { randomBytes } from 'node:crypto';
import { loadOrCreateIdentity } from '../../connect-relay/client/identity.ts';
import { RelayClient, type RelayClientStatus } from '../../connect-relay/client/relay-client.ts';
import { DEMO_AUTHORIZE_PATH, FORWARDED_PATHS } from '../../connect-relay/client/forward.ts';
import {
  clearRelaySecret,
  demoInstallMarked,
  emptyRemoteAccessStatus,
  loopbackWorkerOrigin,
  olympusDataDir,
  readRemoteAccessStatus,
  remoteAccessDir,
  writeRemoteAccessStatus,
  writeRelaySecret,
  type RemoteAccessStatusFile,
} from './remote-access.ts';

export const RELAY_HOST_ENV = 'OLYMPUS_RELAY_HOST';
export const RELAY_TARGET_ENV = 'OLYMPUS_RELAY_TARGET';

export interface RelayRuntimeOptions {
  env: Record<string, string | undefined>;
  instanceId: string;
  /** Test seam: the full session URL (a local relay over ws://). */
  relayUrl?: string;
  heartbeatMs?: number;
  backoff?: { minMs: number; maxMs: number };
  /** How often the child re-asserts its status file (default 15 s). */
  statusRefreshMs?: number;
}

export interface RelayRuntime {
  readonly client: RelayClient;
  stop(): Promise<void>;
}

export async function startRelayRuntime(options: RelayRuntimeOptions): Promise<RelayRuntime> {
  const relayHost = options.env[RELAY_HOST_ENV]?.trim().toLowerCase();
  if (!relayHost) throw new Error(`${RELAY_HOST_ENV} is required.`);
  const target = loopbackWorkerOrigin(options.env[RELAY_TARGET_ENV]);
  if (!target) throw new Error(`${RELAY_TARGET_ENV} must be the loopback http origin of the Olympus worker.`);
  const dir = remoteAccessDir(options.env);
  const identity = loadOrCreateIdentity(olympusDataDir(options.env));

  const status: RemoteAccessStatusFile = {
    ...emptyRemoteAccessStatus('relay'),
    relay_host: relayHost,
    local_url: target,
    public_base_url: `https://${relayHost}`,
    instance_id: options.instanceId,
    pid: process.pid,
    install_id: identity.installId,
    relay: { state: 'connecting', reason: null, retry_in_ms: null },
  };
  let stopped = false;
  const write = () => {
    status.updated_at = new Date().toISOString();
    if (stopped) status.public_base_url = null;
    writeRemoteAccessStatus(dir, status);
  };
  write();

  const onStatus = (next: RelayClientStatus) => {
    if (stopped && next.state !== 'stopped') return;
    // A reconnect attempt after a failure stays "offline" with its reason
    // until it succeeds or fails again, so an unreachable relay reads as one
    // steady "relay unavailable", not a flicker.
    if (next.state === 'connecting' && status.relay?.state === 'offline') return;
    status.relay = {
      state: next.state,
      reason: next.state === 'offline' ? next.reason : null,
      retry_in_ms: next.state === 'offline' || next.state === 'replaced' ? next.retryInMs : null,
    };
    if (next.state === 'online') status.last_connected_at = new Date(next.connectedAt).toISOString();
    write();
  };

  // Minted per boot; written only to the worker's 0600 secret file, so only
  // this process, the worker and the requests it forwards know it.
  const relaySecret = randomBytes(32).toString('base64url');
  writeRelaySecret(dir, relaySecret);

  const client = new RelayClient({
    relayHost,
    ...(options.relayUrl ? { relayUrl: options.relayUrl } : {}),
    identity,
    target,
    relaySecret,
    // A demo install also forwards reviewer sign-in; every other install never does.
    forwardedPaths: demoInstallMarked(dir) ? [...FORWARDED_PATHS, DEMO_AUTHORIZE_PATH] : FORWARDED_PATHS,
    onStatus,
    ...(options.heartbeatMs ? { heartbeatMs: options.heartbeatMs } : {}),
    ...(options.backoff ? { backoff: options.backoff } : {}),
  });
  client.start();

  // status.json is this child's to report while it runs, but the file is
  // shared: a supervisor elsewhere (another Gateway, a test run against the
  // real data root) can overwrite it, and the child writes only when its
  // session changes, so an overwrite would stand for as long as the session
  // stays up, telling the worker and the CLI remote access is off while it
  // works. Re-assert it whenever it no longer names this instance.
  const reassert = setInterval(() => {
    if (stopped) return;
    try {
      const onDisk = readRemoteAccessStatus(dir);
      if (onDisk?.mode === 'relay' && onDisk.instance_id === status.instance_id && onDisk.pid === status.pid) return;
      write();
    } catch {
      // Advisory: the next tick or session change writes again.
    }
  }, options.statusRefreshMs ?? 15_000);
  reassert.unref?.();

  return {
    client,
    async stop() {
      if (stopped) return;
      stopped = true;
      clearInterval(reassert);
      await client.stop();
      clearRelaySecret(dir, relaySecret);
      status.relay = { state: 'stopped', reason: null, retry_in_ms: null };
      write();
    },
  };
}

/**
 * The child process entry point. SIGTERM (the supervisor's stop) clears the
 * public base URL before exiting, so the worker stops advertising OAuth.
 */
export async function runRelayRuntimeProcess(
  instanceId: string,
  overrides: Omit<RelayRuntimeOptions, 'env' | 'instanceId'> = {},
): Promise<void> {
  const runtime = await startRelayRuntime({ ...overrides, env: process.env, instanceId });
  await new Promise<void>((resolve) => {
    const shutdown = () => {
      void runtime.stop().finally(resolve);
    };
    process.once('SIGTERM', shutdown);
    process.once('SIGINT', shutdown);
  });
}
