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
import type { KeyedTokenBuckets } from '../shared/rate-limit.ts';

export interface RelayLimits {
  /** Time allowed for a public client to send its ClientHello. */
  clientHelloTimeoutMs: number;
  maxClientHelloBytes: number;
  /** Time an install has to attach a data connection after `open`. */
  attachTimeoutMs: number;
  /** Open plus pending public connections per install. */
  maxConcurrentPerInstall: number;
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
}

export const DEFAULT_LIMITS: RelayLimits = {
  clientHelloTimeoutMs: 5_000,
  maxClientHelloBytes: 16_384 + 5 * 4,
  attachTimeoutMs: 10_000,
  maxConcurrentPerInstall: 32,
  newConnectionsPerInstall: { capacity: 30, refillPerSecond: 5 },
  controlConnectionsPerIp: { capacity: 30, refillPerSecond: 0.5 },
  registrationsPerIp: { capacity: 5, refillPerSecond: 5 / 3600 },
  acmeDnsPerInstall: { capacity: 10, refillPerSecond: 10 / 3600 },
  maxPendingTotal: 5_000,
  maxSessions: 20_000,
  sessionIdleTimeoutMs: 90_000,
  splicedIdleTimeoutMs: 15 * 60_000,
  firstMessageTimeoutMs: 10_000,
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
  readonly limits: RelayLimits;
  readonly pending: Map<string, PendingConnection>;
  /** Open plus pending public connections, per install, across session replacement. */
  readonly active: Map<string, number>;
  readonly newConnectionBuckets: KeyedTokenBuckets;
  readonly controlBuckets: KeyedTokenBuckets;
  isRegistered(installId: string): boolean;
  session(installId: string): LiveSession | undefined;
  toControlPlane(socket: Socket, buffered: Buffer): void;
  log(event: RelayEvent, fields?: Record<string, unknown>): void;
}

export function reject(socket: Socket, alert: number): void {
  socket.end(tlsAlertRecord(alert));
  setTimeout(() => socket.destroy(), 1_000).unref();
}

export function handlePublicConnection(socket: Socket, deps: PublicPathDeps): void {
  let buffered = Buffer.alloc(0);
  socket.on('error', () => socket.destroy());
  const timer = setTimeout(() => {
    deps.log('public_rejected_invalid', { reason: 'client hello timeout' });
    socket.destroy();
  }, deps.limits.clientHelloTimeoutMs);
  const onData = (chunk: Buffer) => {
    buffered = Buffer.concat([buffered, chunk]);
    const hello = parseClientHello(buffered);
    if (hello.status === 'incomplete' && buffered.length <= deps.limits.maxClientHelloBytes) return;
    clearTimeout(timer);
    socket.removeListener('data', onData);
    socket.pause();
    if (hello.status !== 'ok' || !hello.serverName) {
      deps.log('public_rejected_invalid', { reason: hello.status === 'invalid' ? hello.reason : 'no server name' });
      reject(socket, TLS_ALERT.unrecognizedName);
      return;
    }
    route(socket, hello.serverName, buffered, deps);
  };
  socket.on('data', onData);
}

function route(socket: Socket, serverName: string, clientHello: Buffer, deps: PublicPathDeps): void {
  if (serverName === deps.controlHost) {
    if (!deps.controlBuckets.take(socket.remoteAddress ?? 'unknown')) {
      deps.log('control_rate_limited');
      socket.destroy();
      return;
    }
    deps.toControlPlane(socket, clientHello);
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
  if (
    (deps.active.get(label) ?? 0) >= deps.limits.maxConcurrentPerInstall ||
    deps.pending.size >= deps.limits.maxPendingTotal ||
    !deps.newConnectionBuckets.take(label)
  ) {
    deps.log('public_rejected_limit', { installId: label });
    reject(socket, TLS_ALERT.internalError);
    return;
  }
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
  const destroyBoth = () => {
    agent.destroy();
    data.destroy();
  };
  agent.on('error', destroyBoth);
  data.on('error', destroyBoth);
  agent.on('close', () => data.destroy());
  data.on('close', () => agent.destroy());
  agent.setTimeout(limits.splicedIdleTimeoutMs, destroyBoth);
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
