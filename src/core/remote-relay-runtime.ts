/**
 * The relay child: what `olympus __relay-service-run` runs under the Gateway's
 * native relay service (`native-relay-service.ts`).
 *
 * It keeps one relay session open, obtains and renews the install's
 * certificate, and reports progress to status.json, which the worker reads for
 * its public base URL and the CLI reads for `olympus connections status`. The
 * public base URL is published only once the session is up and a certificate
 * is being served, and cleared when the child stops.
 *
 * No ACME order is placed until the owner has accepted the CA's current
 * subscriber agreement (`olympus connections terms --accept`); until then the
 * status says `awaiting_terms` and names the agreement.
 */
import { startConnect, LETS_ENCRYPT_DIRECTORY, type CertificateStatus, type ConnectHandle } from '../../connect-relay/client/connect.ts';
import type { RelayClientStatus } from '../../connect-relay/client/relay-client.ts';
import {
  emptyRemoteAccessStatus,
  loadOrCreateRelayAuthSecret,
  loopbackWorkerOrigin,
  olympusDataDir,
  remoteAccessDir,
  termsAccepted,
  writeRemoteAccessStatus,
  type RemoteAccessStatusFile,
} from './remote-access.ts';

export const RELAY_HOST_ENV = 'OLYMPUS_RELAY_HOST';
export const RELAY_TARGET_ENV = 'OLYMPUS_RELAY_TARGET';

export interface RelayRuntimeOptions {
  env: Record<string, string | undefined>;
  instanceId: string;
  /** Test seams: where the relay really listens, its CA, and the ACME server. */
  relayAddress?: { host: string; port: number };
  ca?: string;
  acmeDirectoryUrl?: string;
  acmePropagationDelayMs?: number;
  acmePollIntervalMs?: number;
  heartbeatMs?: number;
  backoff?: { minMs: number; maxMs: number };
  retryBackoff?: { minMs: number; maxMs: number };
  /** How often to look for a new agreement acceptance while waiting (default 5 s). */
  termsPollMs?: number;
}

export interface RelayRuntime {
  readonly handle: ConnectHandle;
  stop(): Promise<void>;
}

export async function startRelayRuntime(options: RelayRuntimeOptions): Promise<RelayRuntime> {
  const zone = options.env[RELAY_HOST_ENV]?.trim().toLowerCase();
  if (!zone) throw new Error(`${RELAY_HOST_ENV} is required.`);
  const target = loopbackWorkerOrigin(options.env[RELAY_TARGET_ENV]);
  if (!target) throw new Error(`${RELAY_TARGET_ENV} must be the loopback http origin of the Olympus worker.`);
  const dataDir = olympusDataDir(options.env);
  const dir = remoteAccessDir(options.env);
  const relayAuth = loadOrCreateRelayAuthSecret(dir);
  const controlHost = `relay.${zone}`;

  const status: RemoteAccessStatusFile = {
    ...emptyRemoteAccessStatus('relay'),
    relay_host: zone,
    local_url: target,
    instance_id: options.instanceId,
    pid: process.pid,
    relay: { state: 'connecting', reason: null, retry_in_ms: null },
    certificate: { state: 'none', not_after: null, reason: null, retry_in_ms: null },
  };
  let stopped = false;
  // Set once a certificate is served. A renewal that fails or waits for the
  // agreement keeps the current certificate serving, so the address stays.
  let servedHostname: string | undefined;
  const write = () => {
    status.updated_at = new Date().toISOString();
    status.public_base_url = !stopped && servedHostname ? `https://${servedHostname}` : null;
    writeRemoteAccessStatus(dir, status);
  };
  write();

  const onStatus = (next: RelayClientStatus) => {
    if (stopped && next.state !== 'stopped') return;
    status.relay = {
      state: next.state,
      reason: next.state === 'offline' ? next.reason : null,
      retry_in_ms: next.state === 'offline' ? next.retryInMs : null,
    };
    if (next.state === 'online') status.hostname = next.hostname;
    write();
  };
  const onCertificate = (next: CertificateStatus) => {
    if (stopped) return;
    const serving = next.state === 'serving' ? next : next.state === 'awaiting_terms' ? next.serving : undefined;
    if (serving) {
      servedHostname = serving.hostname;
      status.hostname = serving.hostname;
    }
    status.certificate = {
      state: next.state,
      not_after: serving?.notAfter ?? status.certificate?.not_after ?? null,
      reason: next.state === 'failed' ? next.reason : null,
      retry_in_ms: next.state === 'failed' ? next.retryInMs : null,
    };
    if (next.state === 'awaiting_terms') status.terms_url = next.termsUrl ?? null;
    write();
  };

  const handle = await startConnect({
    stateDir: dataDir,
    relayHost: options.relayAddress?.host ?? controlHost,
    ...(options.relayAddress ? { relayPort: options.relayAddress.port } : {}),
    controlServerName: controlHost,
    zone,
    target,
    relayAuth,
    ...(options.ca ? { ca: options.ca } : {}),
    ...(options.heartbeatMs ? { heartbeatMs: options.heartbeatMs } : {}),
    ...(options.backoff ? { backoff: options.backoff } : {}),
    ...(options.retryBackoff ? { retryBackoff: options.retryBackoff } : {}),
    onStatus,
    onCertificate,
    awaitFirstCertificate: false,
    acme: {
      directoryUrl: options.acmeDirectoryUrl ?? LETS_ENCRYPT_DIRECTORY,
      termsOfServiceAgreed: (termsUrl) => {
        if (status.terms_url !== (termsUrl ?? null)) {
          status.terms_url = termsUrl ?? null;
          write();
        }
        return termsAccepted(dir, termsUrl);
      },
      ...(options.acmePropagationDelayMs !== undefined ? { propagationDelayMs: options.acmePropagationDelayMs } : {}),
      ...(options.acmePollIntervalMs !== undefined ? { pollIntervalMs: options.acmePollIntervalMs } : {}),
    },
  });
  status.install_id = handle.client.installId;
  write();

  // The owner accepts the agreement from another process; notice it promptly.
  const termsTimer = setInterval(() => {
    if (status.certificate?.state !== 'awaiting_terms') return;
    if (termsAccepted(dir, status.terms_url ?? undefined)) void handle.checkCertificate();
  }, options.termsPollMs ?? 5_000);
  termsTimer.unref?.();

  return {
    handle,
    async stop() {
      if (stopped) return;
      stopped = true;
      clearInterval(termsTimer);
      await handle.stop();
      status.relay = { state: 'stopped', reason: null, retry_in_ms: null };
      write();
    },
  };
}

/**
 * The child process entry point. SIGTERM (the supervisor's stop) clears the
 * public base URL before exiting, so the worker stops advertising an address
 * nothing answers.
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
