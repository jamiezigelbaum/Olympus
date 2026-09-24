/**
 * The relay's public data path: raw TCP from hosted agents.
 *
 * This module deliberately handles bytes only. It reads the cleartext TLS
 * ClientHello to learn the server name, then either hands the socket to the
 * relay's own control plane or splices it, unchanged, onto an install's data
 * connection. It never imports `node:tls` and never holds an install key or
 * certificate, so it has no way to decrypt what it forwards;
 * `connect-relay/test/structure.test.ts` keeps it that way.
 */
import type { Socket } from 'node:net';
import type { Duplex } from 'node:stream';
import { INSTALL_ID_PATTERN, newConnId, type OpenMessage } from '../shared/protocol.ts';
import { parseClientHello, TLS_ALERT, tlsAlertRecord } from '../shared/sni.ts';
import { propagateClose } from '../shared/bridge.ts';
import { addressKey, type KeyedCounter, type KeyedTokenBuckets } from '../shared/rate-limit.ts';

export interface RelayLimits {
  /** Time allowed for a public client to send its ClientHello. */
  clientHelloTimeoutMs: number;
  maxClientHelloBytes: number;
  /** Time an install has to attach a data connection after `open`. */
  attachTimeoutMs: number;
  /** Open plus pending public connections per install. */
  maxConcurrentPerInstall: number;
  /**
   * The same, from one source address (IPv6 by /64), so one address cannot
   * hold all of an install's slots.
   */
  maxConcurrentPerInstallPerAddress: number;
  /** TLS handshakes per address on the data host. */
  dataHandshakesPerAddress: { capacity: number; refillPerSecond: number };
  newConnectionsPerInstall: { capacity: number; refillPerSecond: number };
  controlConnectionsPerIp: { capacity: number; refillPerSecond: number };
  registrationsPerIp: { capacity: number; refillPerSecond: number };
  acmeDnsPerInstall: { capacity: number; refillPerSecond: number };
  maxPendingTotal: number;
  maxSessions: number;
  /** Session is dropped after this long without a line from the install. */
  sessionIdleTimeoutMs: number;
  /** A spliced connection with no bytes either way for this long is closed. */
  splicedIdleTimeoutMs: number;
  firstMessageTimeoutMs: number;
  /** Open sockets on the public listener (`net.Server.maxConnections`). */
  maxConnections: number;
  /** Connections per address that have not yet delivered a ClientHello. */
  maxPreHelloPerAddress: number;
  /**
   * Concurrent connections per address to the data host. Data connections are
   * dialed by installs in answer to `open`, so their volume follows public
   * traffic, not the install's own behavior; they get this concurrency cap
   * instead of the control host's rate budget.
   */
  maxDataConnectionsPerAddress: number;
  /** Registrations accepted relay-wide. */
  registrationsGlobal: { capacity: number; refillPerSecond: number };
  /** Calls to the DNS provider relay-wide. */
  dnsCallsGlobal: { capacity: number; refillPerSecond: number };
  /** A registration with no certificate activity is dropped after this long. */
  unactivatedRegistrationTtlMs: number;
  /** A registration with no session for this long is dropped, with its address record. */
  inactiveRegistrationTtlMs: number;
  /** Explicit per-install address records the relay will create. */
  maxAddressRecords: number;
}

export const DEFAULT_LIMITS: RelayLimits = {
  clientHelloTimeoutMs: 5_000,
  maxClientHelloBytes: 16_384 + 5 * 4,
  attachTimeoutMs: 10_000,
  maxConcurrentPerInstall: 32,
  maxConcurrentPerInstallPerAddress: 6,
  dataHandshakesPerAddress: { capacity: 200, refillPerSecond: 50 },
  newConnectionsPerInstall: { capacity: 30, refillPerSecond: 5 },
  controlConnectionsPerIp: { capacity: 30, refillPerSecond: 0.5 },
  registrationsPerIp: { capacity: 5, refillPerSecond: 5 / 3600 },
  acmeDnsPerInstall: { capacity: 10, refillPerSecond: 10 / 3600 },
  maxPendingTotal: 5_000,
  maxSessions: 20_000,
  sessionIdleTimeoutMs: 90_000,
  splicedIdleTimeoutMs: 15 * 60_000,
  firstMessageTimeoutMs: 10_000,
  maxConnections: 50_000,
  maxPreHelloPerAddress: 32,
  maxDataConnectionsPerAddress: 512,
  registrationsGlobal: { capacity: 200, refillPerSecond: 200 / 3600 },
  dnsCallsGlobal: { capacity: 120, refillPerSecond: 2 },
  unactivatedRegistrationTtlMs: 24 * 60 * 60_000,
  inactiveRegistrationTtlMs: 90 * 24 * 60 * 60_000,
  maxAddressRecords: 50_000,
};

export interface LiveSession {
  readonly installId: string;
  send(message: OpenMessage): void;
}

export interface PendingConnection {
  readonly installId: string;
  readonly socket: Socket;
  readonly clientHello: Buffer;
  readonly timer: ReturnType<typeof setTimeout>;
}

export type ForwardTap = (direction: 'to-install' | 'to-agent', chunk: Buffer) => void;

export type RelayEvent =
  | 'public_rejected_unknown'
  | 'public_rejected_offline'
  | 'public_rejected_limit'
  | 'public_rejected_invalid'
  | 'public_attach_timeout'
  | 'public_spliced'
  | 'control_rate_limited'
  | 'data_rejected_limit'
  | 'public_rejected_prehello_limit'
  | 'registration_expired'
  | 'session_ready'
  | 'session_closed'
  | 'session_replaced'
  | 'register'
  | 'register_rejected'
  | 'auth_rejected'
  | 'attach_rejected'
  | 'acme_dns';

export interface PublicPathDeps {
  readonly zone: string;
  readonly controlHost: string;
  readonly dataHost: string;
  readonly limits: RelayLimits;
  readonly pending: Map<string, PendingConnection>;
  /** Open plus pending public connections, per install, across session replacement. */
  readonly active: Map<string, number>;
  readonly newConnectionBuckets: KeyedTokenBuckets;
  readonly controlBuckets: KeyedTokenBuckets;
  readonly preHello: KeyedCounter;
  readonly dataConnections: KeyedCounter;
  readonly perInstallAddress: KeyedCounter;
  readonly dataHandshakeBuckets: KeyedTokenBuckets;
  isRegistered(installId: string): boolean;
  session(installId: string): LiveSession | undefined;
  toControlPlane(socket: Socket, buffered: Buffer, plane: 'control' | 'data'): void;
  log(event: RelayEvent, fields?: Record<string, unknown>): void;
}

export function reject(socket: Socket, alert: number): void {
  socket.end(tlsAlertRecord(alert));
  setTimeout(() => socket.destroy(), 1_000).unref();
}

/** Reads byte `index` across buffered chunks without concatenating them. */
function byteAt(chunks: readonly Buffer[], index: number): number {
  let offset = index;
  for (const chunk of chunks) {
    if (offset < chunk.length) return chunk[offset]!;
    offset -= chunk.length;
  }
  return -1;
}

export function handlePublicConnection(socket: Socket, deps: PublicPathDeps): void {
  socket.on('error', () => socket.destroy());
  const release = deps.preHello.tryAcquire(addressKey(socket.remoteAddress), deps.limits.maxPreHelloPerAddress);
  if (!release) {
    deps.log('public_rejected_prehello_limit');
    socket.destroy();
    return;
  }
  socket.once('close', release);
  const chunks: Buffer[] = [];
  let total = 0;
  // Start of the next TLS record header not yet known to be complete. The
  // ClientHello is only parsed once a whole record has arrived, so a slow
  // trickle costs one parse per record rather than one per byte.
  let recordStart = 0;
  const timer = setTimeout(() => {
    deps.log('public_rejected_invalid', { reason: 'client hello timeout' });
    socket.destroy();
  }, deps.limits.clientHelloTimeoutMs);
  const finish = () => {
    clearTimeout(timer);
    socket.removeListener('data', onData);
    socket.pause();
    release();
  };
  const onData = (chunk: Buffer) => {
    chunks.push(chunk);
    total += chunk.length;
    for (;;) {
      if (total > deps.limits.maxClientHelloBytes) {
        finish();
        deps.log('public_rejected_invalid', { reason: 'client hello too large' });
        reject(socket, TLS_ALERT.unrecognizedName);
        return;
      }
      if (total < recordStart + 5) return;
      if (byteAt(chunks, recordStart) !== 0x16) break;
      const recordEnd = recordStart + 5 + ((byteAt(chunks, recordStart + 3) << 8) | byteAt(chunks, recordStart + 4));
      if (total < recordEnd) return;
      const hello = parseClientHello(Buffer.concat(chunks));
      if (hello.status === 'incomplete') {
        recordStart = recordEnd;
        continue;
      }
      finish();
      const buffered = Buffer.concat(chunks);
      if (hello.status !== 'ok' || !hello.serverName) {
        deps.log('public_rejected_invalid', { reason: hello.status === 'invalid' ? hello.reason : 'no server name' });
        reject(socket, TLS_ALERT.unrecognizedName);
        return;
      }
      route(socket, hello.serverName, buffered, deps);
      return;
    }
    finish();
    deps.log('public_rejected_invalid', { reason: 'not a TLS handshake record' });
    reject(socket, TLS_ALERT.unrecognizedName);
  };
  socket.on('data', onData);
}

function route(socket: Socket, serverName: string, clientHello: Buffer, deps: PublicPathDeps): void {
  const address = addressKey(socket.remoteAddress);
  if (serverName === deps.controlHost) {
    // Session establishment only (hello/register): an install does this on
    // start and reconnect, and outsiders cannot make it happen.
    if (!deps.controlBuckets.take(address)) {
      deps.log('control_rate_limited');
      socket.destroy();
      return;
    }
    deps.toControlPlane(socket, clientHello, 'control');
    return;
  }
  if (serverName === deps.dataHost) {
    if (!deps.dataHandshakeBuckets.take(address)) {
      deps.log('data_rejected_limit');
      socket.destroy();
      return;
    }
    const releaseData = deps.dataConnections.tryAcquire(address, deps.limits.maxDataConnectionsPerAddress);
    if (!releaseData) {
      deps.log('data_rejected_limit');
      socket.destroy();
      return;
    }
    socket.once('close', releaseData);
    deps.toControlPlane(socket, clientHello, 'data');
    return;
  }
  const suffix = `.${deps.zone}`;
  const label = serverName.endsWith(suffix) ? serverName.slice(0, -suffix.length) : '';
  if (!INSTALL_ID_PATTERN.test(label) || !deps.isRegistered(label)) {
    deps.log('public_rejected_unknown');
    reject(socket, TLS_ALERT.unrecognizedName);
    return;
  }
  const session = deps.session(label);
  if (!session) {
    deps.log('public_rejected_offline', { installId: label });
    reject(socket, TLS_ALERT.internalError);
    return;
  }
  const releaseAddress =
    (deps.active.get(label) ?? 0) < deps.limits.maxConcurrentPerInstall && deps.pending.size < deps.limits.maxPendingTotal
      ? deps.perInstallAddress.tryAcquire(`${label}|${address}`, deps.limits.maxConcurrentPerInstallPerAddress)
      : undefined;
  if (!releaseAddress || !deps.newConnectionBuckets.take(label)) {
    releaseAddress?.();
    deps.log('public_rejected_limit', { installId: label });
    reject(socket, TLS_ALERT.internalError);
    return;
  }
  socket.once('close', releaseAddress);
  const connId = newConnId();
  deps.active.set(label, (deps.active.get(label) ?? 0) + 1);
  socket.once('close', () => {
    const remaining = (deps.active.get(label) ?? 1) - 1;
    if (remaining > 0) deps.active.set(label, remaining);
    else deps.active.delete(label);
    const pending = deps.pending.get(connId);
    if (pending) {
      clearTimeout(pending.timer);
      deps.pending.delete(connId);
    }
  });
  const timer = setTimeout(() => {
    if (!deps.pending.delete(connId)) return;
    deps.log('public_attach_timeout', { installId: label });
    reject(socket, TLS_ALERT.internalError);
  }, deps.limits.attachTimeoutMs);
  deps.pending.set(connId, { installId: label, socket, clientHello, timer });
  session.send({ type: 'open', connId, ...(socket.remoteAddress ? { remoteAddress: socket.remoteAddress } : {}) });
}

/**
 * Splices an agent's public socket onto the install's data connection. The
 * first bytes written are the agent's ClientHello, exactly as received.
 */
export function splice(
  pending: PendingConnection,
  data: Duplex,
  rest: Buffer,
  limits: RelayLimits,
  tap?: ForwardTap,
): void {
  clearTimeout(pending.timer);
  const agent = pending.socket;
  propagateClose(agent, data);
  agent.setTimeout(limits.splicedIdleTimeoutMs, () => {
    agent.destroy();
    data.destroy();
  });
  if (tap) {
    tap('to-install', pending.clientHello);
    agent.on('data', (chunk: Buffer) => tap('to-install', chunk));
    data.on('data', (chunk: Buffer) => tap('to-agent', chunk));
  }
  data.write(pending.clientHello);
  if (rest.length > 0) agent.write(rest);
  agent.pipe(data);
  data.pipe(agent);
  agent.resume();
}
