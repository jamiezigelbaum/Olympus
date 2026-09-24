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
import { KeyedTokenBuckets } from '../shared/rate-limit.ts';
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
import { publicKeyOf, type InstallRegistry } from './registry.ts';

export interface RelayConfig {
  /** e.g. `connect.olympusplugin.ai`. Install hostnames are `<install-id>.<zone>`. */
  readonly zone: string;
  /** e.g. `relay.connect.olympusplugin.ai`; served with `controlTls`. */
  readonly controlHost: string;
  readonly controlTls: { readonly key: string | Buffer; readonly cert: string | Buffer };
  readonly registry: InstallRegistry;
  readonly dns: DnsProvider;
  readonly listen?: { readonly host?: string; readonly port?: number };
  readonly limits?: Partial<RelayLimits>;
  /** Observes every byte the relay forwards on the public path (metrics, tests). */
  readonly tap?: ForwardTap;
  readonly log?: (event: RelayEvent, fields?: Record<string, unknown>) => void;
}

export interface RelayHandle {
  readonly port: number;
  readonly host: string;
  onlineInstalls(): string[];
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
  if (controlHost.endsWith(`.${zone}`) && INSTALL_ID_PATTERN.test(controlHost.slice(0, -zone.length - 1))) {
    throw new Error('controlHost must not have the shape of an install hostname');
  }
  const limits: RelayLimits = { ...DEFAULT_LIMITS, ...config.limits };
  const log = config.log ?? (() => {});
  const sessions = new Map<string, Session>();
  const pending = new Map<string, PendingConnection>();
  const active = new Map<string, number>();
  const loopbackPeers = new Map<number, string>();
  const newConnectionBuckets = new KeyedTokenBuckets(limits.newConnectionsPerInstall);
  const controlBuckets = new KeyedTokenBuckets(limits.controlConnectionsPerIp);
  const registrationBuckets = new KeyedTokenBuckets(limits.registrationsPerIp);
  const acmeBuckets = new KeyedTokenBuckets(limits.acmeDnsPerInstall);
  const openSockets = new Set<Socket>();
  const track = (socket: Socket) => {
    openSockets.add(socket);
    socket.once('close', () => openSockets.delete(socket));
  };

  const controlServer = tls.createServer({ key: config.controlTls.key, cert: config.controlTls.cert, minVersion: 'TLSv1.2' });
  controlServer.on('secureConnection', (socket) => {
    track(socket);
    const peer = loopbackPeers.get(socket.remotePort ?? -1) ?? 'unknown';
    handleControlConnection(socket, peer);
  });
  controlServer.on('tlsClientError', () => {});
  await new Promise<void>((resolve) => controlServer.listen(0, '127.0.0.1', resolve));
  const controlPort = (controlServer.address() as AddressInfo).port;

  const toControlPlane = (socket: Socket, buffered: Buffer) => {
    const upstream = net.connect(controlPort, '127.0.0.1');
    track(upstream);
    const peer = socket.remoteAddress ?? 'unknown';
    upstream.once('connect', () => {
      const localPort = upstream.localPort;
      if (localPort !== undefined) {
        loopbackPeers.set(localPort, peer);
        upstream.once('close', () => loopbackPeers.delete(localPort));
      }
      upstream.write(buffered);
      socket.pipe(upstream);
      upstream.pipe(socket);
      socket.resume();
    });
    const destroyBoth = () => {
      socket.destroy();
      upstream.destroy();
    };
    socket.on('error', destroyBoth);
    upstream.on('error', destroyBoth);
    socket.on('close', () => upstream.destroy());
    upstream.on('close', () => socket.destroy());
  };

  const publicServer = net.createServer((socket) => {
    track(socket);
    handlePublicConnection(socket, {
      zone,
      controlHost,
      limits,
      pending,
      active,
      newConnectionBuckets,
      controlBuckets,
      isRegistered: (installId) => config.registry.get(installId) !== undefined,
      session: (installId) => sessions.get(installId),
      toControlPlane,
      log,
    });
  });
  const listenHost = config.listen?.host ?? '0.0.0.0';
  await new Promise<void>((resolve, reject) => {
    publicServer.once('error', reject);
    publicServer.listen(config.listen?.port ?? 443, listenHost, () => resolve());
  });

  function handleControlConnection(socket: TLSSocket, peer: string): void {
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
            if (!registrationBuckets.take(peer)) {
              log('register_rejected', { reason: 'rate limited' });
              fail('rate_limited', 'too many registrations from this address');
              return 'stop';
            }
            if (!config.registry.register({ installId, publicKey, registeredAt: new Date().toISOString() })) {
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
        session.publishedTxt.delete(value);
        void config.dns.clearTxt(name, value).then(() => respond(true), () => respond(false, 'dns provider error'));
        return;
      }
      if (session.publishedTxt.size >= 4) return respond(false, 'too many outstanding challenge values');
      if (!acmeBuckets.take(session.installId)) return respond(false, 'rate_limited');
      session.publishedTxt.add(value);
      log('acme_dns', { installId: session.installId });
      void config.dns
        .ensureAddress(hostnameFor(session.installId, zone))
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

  return {
    port: (publicServer.address() as AddressInfo).port,
    host: listenHost,
    onlineInstalls: () => [...sessions.keys()],
    close: async () => {
      for (const socket of openSockets) socket.destroy();
      for (const waiting of pending.values()) clearTimeout(waiting.timer);
      await Promise.all([
        new Promise<void>((resolve) => publicServer.close(() => resolve())),
        new Promise<void>((resolve) => controlServer.close(() => resolve())),
      ]);
    },
  };
}
