/**
 * Olympus connect relay.
 *
 * One public TCP listener (443 in production) routes by TLS SNI:
 * - `<install-id>.<zone>` is spliced, still encrypted, onto that install's data
 *   connection (see public-path.ts);
 * - `<controlHost>` is the relay's own control plane. It is piped to a
 *   loopback TLS server holding the relay's certificate, where installs
 *   authenticate with their install key, keep a session open, attach data
 *   connections, and ask the relay to publish ACME DNS-01 TXT values.
 *
 * The control-plane TLS server listens on loopback rather than wrapping the
 * accepted socket because Bun cannot wrap an existing socket as a server-side
 * TLS socket; the loopback hop works identically on Node and Bun.
 */
import net, { type AddressInfo, type Socket } from 'node:net';
import tls, { type TLSSocket } from 'node:tls';
import {
  ACME_TXT_VALUE_PATTERN,
  CONN_ID_PATTERN,
  INSTALL_ID_PATTERN,
  PROTOCOL_VERSION,
  acmeChallengeName,
  encodeLine,
  hostnameFor,
  installIdForPublicKey,
  newNonce,
  publicKeyFromSpki,
  readLines,
  spkiOf,
  verifyInstallMessage,
  type ErrorMessage,
  type RelayErrorCode,
  type RelaySessionMessage,
} from '../shared/protocol.ts';
import { KeyedCounter, KeyedTokenBuckets, addressKey } from '../shared/rate-limit.ts';
import { propagateClose } from '../shared/bridge.ts';
import { TLS_ALERT } from '../shared/sni.ts';
import type { DnsProvider } from './dns.ts';
import {
  DEFAULT_LIMITS,
  handlePublicConnection,
  reject,
  splice,
  type ForwardTap,
  type LiveSession,
  type PendingConnection,
  type RelayEvent,
  type RelayLimits,
} from './public-path.ts';
import { publicKeyOf, type InstallRegistry, type RegistryCounts } from './registry.ts';

export interface RelayConfig {
  /** e.g. `connect.olympusplugin.ai`. Install hostnames are `<install-id>.<zone>`. */
  readonly zone: string;
  /** e.g. `relay.connect.olympusplugin.ai`; served with `controlTls`. */
  readonly controlHost: string;
  /**
   * Host installs dial for data connections; defaults to `data.<controlHost>`.
   * `controlTls` must cover it too. Kept apart from `controlHost` so that
   * public traffic, which drives data connections, cannot spend the budget an
   * install needs to keep its session.
   */
  readonly dataHost?: string;
  readonly controlTls: { readonly key: string | Buffer; readonly cert: string | Buffer };
  readonly registry: InstallRegistry;
  readonly dns: DnsProvider;
  readonly listen?: { readonly host?: string; readonly port?: number };
  readonly limits?: Partial<RelayLimits>;
  /** Observes every byte the relay forwards on the public path (metrics, tests). */
  readonly tap?: ForwardTap;
  readonly log?: (event: RelayEvent, fields?: Record<string, unknown>) => void;
  /** How often expired registrations are swept (default hourly). */
  readonly sweepIntervalMs?: number;
}

/** What the operator's `revoke` did. */
export interface RevokeResult {
  readonly installId: string;
  /** False when the id was already revoked. */
  readonly revoked: boolean;
  readonly wasRegistered: boolean;
  readonly wasOnline: boolean;
  /** `removed` now; `pending` retried by the hourly sweep (DNS budget or provider error); `none` there was none. */
  readonly addressRecord: 'removed' | 'pending' | 'none';
}

/** Counts only: the relay's status names no install. */
export interface RelayStatus extends RegistryCounts {
  readonly online: number;
  readonly publicConnections: number;
  readonly pendingPublicConnections: number;
  readonly startedAt: string;
}

export interface RelayHandle {
  readonly port: number;
  readonly host: string;
  onlineInstalls(): string[];
  /**
   * Operator revocation: removes the install, ends its session and waiting
   * connections, removes its address record within the DNS budget, and
   * refuses the id at registration from now on. No restart.
   */
  revoke(installId: string): Promise<RevokeResult>;
  /** Lets a revoked id register again. */
  restore(installId: string): boolean;
  status(): RelayStatus;
  /** Expires unused registrations now (also runs on a timer). */
  sweep(now?: number): Promise<string[]>;
  close(): Promise<void>;
}

interface Session extends LiveSession {
  readonly socket: TLSSocket;
  readonly publishedTxt: Set<string>;
  closed: boolean;
}

export async function startRelay(config: RelayConfig): Promise<RelayHandle> {
  const zone = config.zone.toLowerCase();
  const controlHost = config.controlHost.toLowerCase();
  const dataHost = (config.dataHost ?? `data.${controlHost}`).toLowerCase();
  if (controlHost.endsWith(`.${zone}`) && INSTALL_ID_PATTERN.test(controlHost.slice(0, -zone.length - 1))) {
    throw new Error('controlHost must not have the shape of an install hostname');
  }
  if (dataHost === controlHost) throw new Error('dataHost must differ from controlHost');
  const limits: RelayLimits = { ...DEFAULT_LIMITS, ...config.limits };
  const log = config.log ?? (() => {});
  const sessions = new Map<string, Session>();
  const pending = new Map<string, PendingConnection>();
  const active = new Map<string, number>();
  const loopbackPeers = new Map<number, { peer: string; plane: 'control' | 'data' }>();
  const newConnectionBuckets = new KeyedTokenBuckets(limits.newConnectionsPerInstall);
  const controlBuckets = new KeyedTokenBuckets(limits.controlConnectionsPerIp);
  const registrationBuckets = new KeyedTokenBuckets(limits.registrationsPerIp);
  const globalRegistrations = new KeyedTokenBuckets(limits.registrationsGlobal);
  const globalDnsCalls = new KeyedTokenBuckets(limits.dnsCallsGlobal);
  const preHello = new KeyedCounter();
  const dataConnections = new KeyedCounter();
  const perInstallAddress = new KeyedCounter();
  const dataHandshakeBuckets = new KeyedTokenBuckets(limits.dataHandshakesPerAddress);
  const acmeBuckets = new KeyedTokenBuckets(limits.acmeDnsPerInstall);
  const openSockets = new Set<Socket>();
  const track = (socket: Socket) => {
    openSockets.add(socket);
    socket.once('close', () => openSockets.delete(socket));
  };

  const controlServer = tls.createServer({ key: config.controlTls.key, cert: config.controlTls.cert, minVersion: 'TLSv1.2' });
  controlServer.on('secureConnection', (socket) => {
    track(socket);
    const origin = loopbackPeers.get(socket.remotePort ?? -1);
    if (!origin) {
      socket.destroy();
      return;
    }
    handleControlConnection(socket, origin.peer, origin.plane);
  });
  controlServer.on('tlsClientError', () => {});
  await new Promise<void>((resolve) => controlServer.listen(0, '127.0.0.1', resolve));
  const controlPort = (controlServer.address() as AddressInfo).port;

  const toControlPlane = (socket: Socket, buffered: Buffer, plane: 'control' | 'data') => {
    const upstream = net.connect(controlPort, '127.0.0.1');
    track(upstream);
    const peer = addressKey(socket.remoteAddress);
    upstream.once('connect', () => {
      const localPort = upstream.localPort;
      if (localPort !== undefined) {
        loopbackPeers.set(localPort, { peer, plane });
        upstream.once('close', () => loopbackPeers.delete(localPort));
      }
      upstream.write(buffered);
      socket.pipe(upstream);
      upstream.pipe(socket);
      socket.resume();
    });
    propagateClose(socket, upstream);
  };

  const publicServer = net.createServer((socket) => {
    track(socket);
    handlePublicConnection(socket, {
      zone,
      controlHost,
      dataHost,
      limits,
      pending,
      active,
      newConnectionBuckets,
      controlBuckets,
      preHello,
      dataConnections,
      perInstallAddress,
      dataHandshakeBuckets,
      isRegistered: (installId) => config.registry.get(installId) !== undefined,
      session: (installId) => sessions.get(installId),
      toControlPlane,
      log,
    });
  });
  publicServer.maxConnections = limits.maxConnections;
  const listenHost = config.listen?.host ?? '0.0.0.0';
  await new Promise<void>((resolve, reject) => {
    publicServer.once('error', reject);
    publicServer.listen(config.listen?.port ?? 443, listenHost, () => resolve());
  });

  function handleControlConnection(socket: TLSSocket, peer: string, plane: 'control' | 'data'): void {
    const nonce = newNonce();
    let session: Session | undefined;
    let attached: PendingConnection | undefined;
    const fail = (code: RelayErrorCode, message: string) => {
      const error: ErrorMessage = { type: 'error', code, message };
      socket.end(encodeLine(error));
      setTimeout(() => socket.destroy(), 1_000).unref();
    };
    socket.on('error', () => socket.destroy());
    const firstTimer = setTimeout(() => socket.destroy(), limits.firstMessageTimeoutMs);
    let idleTimer: ReturnType<typeof setTimeout> | undefined;
    const touch = () => {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => socket.destroy(), limits.sessionIdleTimeoutMs);
    };
    socket.once('close', () => {
      clearTimeout(firstTimer);
      if (idleTimer) clearTimeout(idleTimer);
      if (session) closeSession(session);
    });
    socket.write(encodeLine({ type: 'challenge', v: PROTOCOL_VERSION, nonce }));

    readLines(
      socket,
      (message) => {
        if (session) {
          touch();
          handleSessionMessage(session, message);
          return 'continue';
        }
        clearTimeout(firstTimer);
        if (message.v !== PROTOCOL_VERSION) {
          fail('unsupported_version', `relay speaks protocol ${PROTOCOL_VERSION}`);
          return 'stop';
        }
        const installId = typeof message.installId === 'string' ? message.installId : '';
        const sig = typeof message.sig === 'string' ? message.sig : '';
        if (!INSTALL_ID_PATTERN.test(installId)) {
          fail('bad_request', 'installId is malformed');
          return 'stop';
        }
        if ((message.type === 'attach') !== (plane === 'data')) {
          fail('bad_request', plane === 'data' ? 'the data host only accepts attach' : 'attach must use the data host');
          return 'stop';
        }
        if (config.registry.isRevoked(installId)) {
          log('auth_rejected', { reason: 'revoked' });
          fail('revoked', 'this install was revoked by the relay operator');
          return 'stop';
        }
        if (message.type === 'attach') {
          const connId = typeof message.connId === 'string' ? message.connId : '';
          const record = config.registry.get(installId);
          const waiting = pending.get(connId);
          if (!record || !CONN_ID_PATTERN.test(connId) || !verifyInstallMessage(publicKeyOf(record), 'attach', nonce, installId, sig, connId)) {
            log('attach_rejected', { reason: 'signature' });
            fail('bad_signature', 'attach signature rejected');
            return 'stop';
          }
          if (!waiting || waiting.installId !== installId) {
            log('attach_rejected', { reason: 'unknown connection' });
            fail('unknown_connection', 'no pending connection with that id');
            return 'stop';
          }
          pending.delete(connId);
          attached = waiting;
          return 'stop';
        }
        if (message.type === 'register') {
          const publicKey = typeof message.publicKey === 'string' ? message.publicKey : '';
          let key;
          try {
            key = publicKeyFromSpki(publicKey);
          } catch {
            fail('bad_request', 'publicKey must be an Ed25519 SPKI');
            return 'stop';
          }
          if (installIdForPublicKey(spkiOf(key)) !== installId) {
            log('register_rejected', { reason: 'id mismatch' });
            fail('id_mismatch', 'installId is not derived from publicKey');
            return 'stop';
          }
          if (!verifyInstallMessage(key, 'register', nonce, installId, sig)) {
            log('register_rejected', { reason: 'signature' });
            fail('bad_signature', 'register signature rejected');
            return 'stop';
          }
          if (!config.registry.get(installId)) {
            if (!registrationBuckets.take(peer) || !globalRegistrations.take('relay')) {
              log('register_rejected', { reason: 'rate limited' });
              fail('rate_limited', 'too many registrations; try again later');
              return 'stop';
            }
            if (!config.registry.register(installId, publicKey)) {
              fail('capacity', 'relay registry is full');
              return 'stop';
            }
            log('register', { installId });
          }
        } else if (message.type === 'hello') {
          const record = config.registry.get(installId);
          if (!record) {
            log('auth_rejected', { reason: 'unregistered' });
            fail('unregistered', 'install is not registered');
            return 'stop';
          }
          if (!verifyInstallMessage(publicKeyOf(record), 'hello', nonce, installId, sig)) {
            log('auth_rejected', { reason: 'signature' });
            fail('bad_signature', 'hello signature rejected');
            return 'stop';
          }
        } else {
          fail('bad_request', 'expected hello, register, or attach');
          return 'stop';
        }
        if (!sessions.has(installId) && sessions.size >= limits.maxSessions) {
          fail('capacity', 'relay is at session capacity');
          return 'stop';
        }
        session = openSession(installId, socket);
        touch();
        return 'continue';
      },
      (reason) => fail('bad_request', reason),
      (rest) => {
        if (!attached) return;
        // From here on this connection carries the agent's end-to-end TLS
        // bytes; the relay only splices them.
        socket.pause();
        log('public_spliced', { installId: attached.installId });
        splice(attached, socket, rest, limits, config.tap);
      },
    );
  }

  function openSession(installId: string, socket: TLSSocket): Session {
    const previous = sessions.get(installId);
    const session: Session = {
      installId,
      socket,
      publishedTxt: new Set(),
      closed: false,
      send: (message) => sendSession(session, message),
    };
    if (previous) {
      log('session_replaced', { installId });
      previous.closed = true;
      previous.socket.end(encodeLine({ type: 'error', code: 'replaced', message: 'a newer session replaced this one' }));
    }
    sessions.set(installId, session);
    config.registry.seen(installId);
    sendSession(session, { type: 'ready', installId, hostname: hostnameFor(installId, zone) });
    log('session_ready', { installId });
    return session;
  }

  function closeSession(session: Session): void {
    for (const value of session.publishedTxt) void config.dns.clearTxt(acmeChallengeName(session.installId, zone), value).catch(() => {});
    session.publishedTxt.clear();
    if (sessions.get(session.installId) === session) {
      sessions.delete(session.installId);
      // Agents waiting on this install get the offline answer now, not after the attach timeout.
      for (const [connId, waiting] of pending) {
        if (waiting.installId !== session.installId) continue;
        clearTimeout(waiting.timer);
        pending.delete(connId);
        reject(waiting.socket, TLS_ALERT.internalError);
      }
      log('session_closed', { installId: session.installId });
    }
    session.closed = true;
  }

  function sendSession(session: Session, message: RelaySessionMessage): void {
    if (!session.closed && !session.socket.destroyed) session.socket.write(encodeLine(message));
  }

  function handleSessionMessage(session: Session, message: Record<string, unknown>): void {
    if (message.type === 'ping') {
      config.registry.seen(session.installId);
      sendSession(session, { type: 'pong' });
      return;
    }
    if (message.type === 'acme-dns-set' || message.type === 'acme-dns-clear') {
      const id = typeof message.id === 'string' ? message.id.slice(0, 64) : '';
      const value = typeof message.value === 'string' ? message.value : '';
      const respond = (ok: boolean, error?: string) =>
        sendSession(session, { type: 'acme-dns-result', id, ok, ...(error ? { error } : {}) });
      if (!ACME_TXT_VALUE_PATTERN.test(value)) return respond(false, 'value must be a 43-character base64url digest');
      // The relay derives the record name itself: an install can only ever
      // publish under its own `_acme-challenge.<install-id>` name.
      const name = acmeChallengeName(session.installId, zone);
      if (message.type === 'acme-dns-clear') {
        // Only values this session published, so clears cannot drive provider calls on their own.
        if (!session.publishedTxt.has(value)) return respond(false, 'value was not published by this session');
        if (!acmeBuckets.take(session.installId) || !globalDnsCalls.take('relay')) return respond(false, 'rate_limited');
        session.publishedTxt.delete(value);
        void config.dns.clearTxt(name, value).then(() => respond(true), () => respond(false, 'dns provider error'));
        return;
      }
      if (session.publishedTxt.size >= 4) return respond(false, 'too many outstanding challenge values');
      const record = config.registry.get(session.installId);
      if (!record) return respond(false, 'install is not registered');
      const needsAddress = !record.hasAddressRecord;
      if (needsAddress && config.registry.addressRecordCount() >= limits.maxAddressRecords) return respond(false, 'capacity');
      if (!acmeBuckets.take(session.installId)) return respond(false, 'rate_limited');
      if (!globalDnsCalls.take('relay') || (needsAddress && !globalDnsCalls.take('relay'))) return respond(false, 'rate_limited');
      session.publishedTxt.add(value);
      config.registry.activate(session.installId);
      log('acme_dns', { installId: session.installId });
      const hostname = hostnameFor(session.installId, zone);
      void (needsAddress ? config.dns.ensureAddress(hostname).then(() => config.registry.markAddressRecord(session.installId)) : Promise.resolve())
        .then(() => config.dns.setTxt(name, value))
        .then(
          () => respond(true),
          () => {
            session.publishedTxt.delete(value);
            respond(false, 'dns provider error');
          },
        );
      return;
    }
    sendSession(session, { type: 'error', code: 'bad_request', message: 'unknown message type' });
  }

  /** Removes one queued address record, within the DNS budget. */
  const removeAddressRecord = async (installId: string): Promise<'removed' | 'failed' | 'no-budget'> => {
    if (!globalDnsCalls.take('relay')) return 'no-budget';
    const hostname = hostnameFor(installId, zone);
    try {
      await config.dns.removeAddress(hostname);
    } catch {
      return 'failed'; // Retried next sweep.
    }
    if (config.registry.pendingAddressRemovals().includes(installId)) {
      config.registry.addressRemoved(installId);
      return 'removed';
    }
    // The install re-registered while the removal was in flight and
    // reclaimed the record we just deleted: put it back, or record that it
    // is gone so the next publish re-creates it.
    if (!config.registry.get(installId)?.hasAddressRecord) return 'removed';
    try {
      if (!globalDnsCalls.take('relay')) throw new Error('no DNS budget');
      await config.dns.ensureAddress(hostname);
    } catch {
      config.registry.addressLost(installId);
    }
    return 'removed';
  };

  const revoke = async (installId: string): Promise<RevokeResult> => {
    if (!INSTALL_ID_PATTERN.test(installId)) throw new Error('not an install id');
    const wasRegistered = config.registry.get(installId) !== undefined;
    const live = sessions.get(installId);
    const revoked = config.registry.revoke(installId);
    if (revoked) log('install_revoked', { installId });
    // Ending the session also clears its ACME TXT values and answers any
    // waiting agent connection with the offline alert (closeSession).
    if (live) {
      live.socket.end(encodeLine({ type: 'error', code: 'revoked', message: 'this install was revoked by the relay operator' }));
      setTimeout(() => live.socket.destroy(), 1_000).unref();
    }
    let addressRecord: RevokeResult['addressRecord'] = 'none';
    if (config.registry.pendingAddressRemovals().includes(installId)) {
      addressRecord = (await removeAddressRecord(installId)) === 'removed' ? 'removed' : 'pending';
    }
    return { installId, revoked, wasRegistered, wasOnline: live !== undefined, addressRecord };
  };

  const startedAt = new Date().toISOString();
  const status = (): RelayStatus => {
    let publicConnections = 0;
    for (const count of active.values()) publicConnections += count;
    return {
      ...config.registry.counts(),
      online: sessions.size,
      publicConnections,
      pendingPublicConnections: pending.size,
      startedAt,
    };
  };

  const sweep = async (now = Date.now()): Promise<string[]> => {
    const expired = config.registry.expire(
      now,
      { unactivatedMs: limits.unactivatedRegistrationTtlMs, inactiveMs: limits.inactiveRegistrationTtlMs },
      (installId) => sessions.has(installId),
    );
    for (const record of expired) {
      log('registration_expired', { installId: record.installId });
      const live = sessions.get(record.installId);
      if (live) live.socket.end(encodeLine({ type: 'error', code: 'unregistered', message: 'registration expired' }));
    }
    // Address records are removed within the DNS budget; a failed or deferred
    // removal stays counted and is retried on the next sweep.
    for (const installId of config.registry.pendingAddressRemovals()) {
      if ((await removeAddressRecord(installId)) === 'no-budget') break;
    }
    return expired.map((record) => record.installId);
  };
  const sweepTimer = setInterval(() => void sweep(), config.sweepIntervalMs ?? 60 * 60_000);
  sweepTimer.unref?.();

  return {
    port: (publicServer.address() as AddressInfo).port,
    host: listenHost,
    onlineInstalls: () => [...sessions.keys()],
    revoke,
    restore: (installId) => {
      const restored = config.registry.restore(installId);
      if (restored) log('install_restored', { installId });
      return restored;
    },
    status,
    sweep,
    close: async () => {
      clearInterval(sweepTimer);
      for (const socket of openSockets) socket.destroy();
      for (const waiting of pending.values()) clearTimeout(waiting.timer);
      await Promise.all([
        new Promise<void>((resolve) => publicServer.close(() => resolve())),
        new Promise<void>((resolve) => controlServer.close(() => resolve())),
      ]);
      await config.registry.flush();
    },
  };
}
