/**
 * The install side of the relay: keeps one authenticated outbound session to
 * the relay, attaches a data connection for each public connection the relay
 * announces, and pipes it into the local TLS endpoint.
 *
 * Nothing the hosted agent sends is visible before the local endpoint: the data
 * connection carries the agent's TLS records, which only the install's
 * certificate key can open.
 */
import net from 'node:net';
import tls, { type TLSSocket } from 'node:tls';
import {
  PROTOCOL_VERSION,
  encodeLine,
  readLines,
  signInstallMessage,
  type ClientSessionMessage,
} from '../shared/protocol.ts';
import { propagateClose } from '../shared/bridge.ts';
import type { AcmeDnsPublisher } from './acme.ts';
import type { InstallIdentity } from './identity.ts';
import { startLocalEndpoint, type LocalEndpoint } from './local-endpoint.ts';

export type RelayClientStatus =
  | { state: 'connecting' }
  | { state: 'online'; hostname: string }
  | { state: 'offline'; reason: string; retryInMs: number }
  | { state: 'replaced' }
  | { state: 'stopped' };

export interface RelayClientOptions {
  readonly relayHost: string;
  readonly relayPort?: number;
  /** The relay's control hostname (SNI and certificate name), e.g. `relay.connect.olympusplugin.ai`. */
  readonly controlServerName: string;
  /** The relay's data hostname; defaults to `data.<controlServerName>`. */
  readonly dataServerName?: string;
  /** The zone install hostnames live in. `ready` must name `<installId>.<zone>` exactly. */
  readonly zone: string;
  /** Concurrent data connections the relay may make this install open (default 64). */
  readonly maxDataConnections?: number;
  /**
   * A data connection whose agent has not completed TLS and sent a first
   * request within this time is closed (default 10 s), so stalled handshakes
   * cannot hold install slots.
   */
  readonly firstRequestTimeoutMs?: number;
  readonly identity: InstallIdentity;
  /** Loopback Olympus worker; defaults to `http://127.0.0.1:28090`. */
  readonly target?: string;
  readonly allowedPaths?: readonly string[];
  /** Extra trust anchors for the relay control plane (tests and private relays). */
  readonly ca?: string | Buffer;
  readonly onStatus?: (status: RelayClientStatus) => void;
  readonly heartbeatMs?: number;
  readonly backoff?: { readonly minMs: number; readonly maxMs: number };
  /** After another process takes over this install's session. */
  readonly replacedBackoffMs?: number;
}

export class RelayClient implements AcmeDnsPublisher {
  private session: TLSSocket | undefined;
  private endpoint: LocalEndpoint | undefined;
  private stopped = true;
  private register = false;
  private failures = 0;
  private heartbeat: ReturnType<typeof setInterval> | undefined;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly dnsWaiters = new Map<string, { resolve: () => void; reject: (error: Error) => void }>();
  private readonly peers = new Map<number, string>();
  private readonly firstRequestTimers = new Map<number, ReturnType<typeof setTimeout>>();
  private readonly dataSockets = new Set<net.Socket>();
  private sequence = 0;
  private dataConnections = 0;
  private hostnameValue: string | undefined;
  private readyWaiters: Array<(hostname: string) => void> = [];

  constructor(private readonly options: RelayClientOptions) {}

  get installId(): string {
    return this.options.identity.installId;
  }

  /** Data connections currently open to the relay. */
  get activeDataConnections(): number {
    return this.dataConnections;
  }

  get hostname(): string | undefined {
    return this.hostnameValue;
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.connect();
  }

  /** Resolves with the public hostname once the relay session is ready. */
  ready(): Promise<string> {
    if (this.hostnameValue && this.session && !this.session.destroyed) return Promise.resolve(this.hostnameValue);
    return new Promise((resolve) => this.readyWaiters.push(resolve));
  }

  /** Serve with this certificate from now on (first issuance and renewals). */
  async setCertificate(material: { key: string | Buffer; cert: string | Buffer }): Promise<void> {
    const next = await startLocalEndpoint({
      key: material.key,
      cert: material.cert,
      target: this.options.target ?? 'http://127.0.0.1:28090',
      ...(this.options.allowedPaths ? { allowedPaths: this.options.allowedPaths } : {}),
      peerAddress: (port) => (port === undefined ? undefined : this.peers.get(port)),
      onRequest: (port) => {
        if (port === undefined) return;
        const timer = this.firstRequestTimers.get(port);
        if (timer) clearTimeout(timer);
        this.firstRequestTimers.delete(port);
      },
      handshakeTimeoutMs: this.options.firstRequestTimeoutMs ?? 10_000,
    });
    const previous = this.endpoint;
    this.endpoint = next;
    await previous?.close();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.session?.destroy();
    for (const socket of this.dataSockets) socket.destroy();
    for (const waiter of this.dnsWaiters.values()) waiter.reject(new Error('relay client stopped'));
    this.dnsWaiters.clear();
    await this.endpoint?.close();
    this.endpoint = undefined;
    this.options.onStatus?.({ state: 'stopped' });
  }

  publish(value: string): Promise<void> {
    return this.dnsRequest('acme-dns-set', value);
  }

  clear(value: string): Promise<void> {
    return this.dnsRequest('acme-dns-clear', value);
  }

  private dnsRequest(type: 'acme-dns-set' | 'acme-dns-clear', value: string): Promise<void> {
    const session = this.session;
    if (!session || session.destroyed || !this.hostnameValue) return Promise.reject(new Error('relay session is not online'));
    const id = `dns-${++this.sequence}`;
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.dnsWaiters.delete(id);
        reject(new Error('relay did not answer the DNS request'));
      }, 30_000);
      this.dnsWaiters.set(id, {
        resolve: () => {
          clearTimeout(timer);
          resolve();
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      this.send(session, { type, id, value });
    });
  }

  private send(socket: TLSSocket, message: ClientSessionMessage): void {
    socket.write(encodeLine(message));
  }

  private dial(servername: string): TLSSocket {
    return tls.connect({
      host: this.options.relayHost,
      port: this.options.relayPort ?? 443,
      servername,
      minVersion: 'TLSv1.2',
      ...(this.options.ca ? { ca: this.options.ca } : {}),
    });
  }

  private connect(): void {
    if (this.stopped) return;
    this.options.onStatus?.({ state: 'connecting' });
    const socket = this.dial(this.options.controlServerName);
    this.session = socket;
    let reason = 'connection closed';
    let replaced = false;
    const { identity } = this.options;
    readLines(
      socket,
      (message) => {
        switch (message.type) {
          case 'challenge': {
            const nonce = String(message.nonce);
            const kind = this.register ? 'register' : 'hello';
            const sig = signInstallMessage(identity.privateKey, kind, nonce, identity.installId);
            socket.write(
              encodeLine(
                kind === 'register'
                  ? { type: 'register', v: PROTOCOL_VERSION, installId: identity.installId, publicKey: identity.publicKeySpki, sig }
                  : { type: 'hello', v: PROTOCOL_VERSION, installId: identity.installId, sig },
              ),
            );
            return 'continue';
          }
          case 'ready': {
            // The hostname feeds ACME and the URL the user hands to agents:
            // accept only the one this install's key and zone determine.
            const expected = `${identity.installId}.${this.options.zone.toLowerCase()}`;
            if (message.hostname !== expected || message.installId !== identity.installId) {
              reason = 'relay announced an unexpected hostname';
              socket.destroy();
              return 'stop';
            }
            this.failures = 0;
            this.register = false;
            this.hostnameValue = expected;
            this.options.onStatus?.({ state: 'online', hostname: this.hostnameValue });
            if (this.heartbeat) clearInterval(this.heartbeat);
            this.heartbeat = setInterval(() => this.send(socket, { type: 'ping' }), this.options.heartbeatMs ?? 30_000);
            for (const waiter of this.readyWaiters.splice(0)) waiter(this.hostnameValue);
            return 'continue';
          }
          case 'open':
            this.attach(String(message.connId), typeof message.remoteAddress === 'string' ? message.remoteAddress : undefined);
            return 'continue';
          case 'acme-dns-result': {
            const waiter = this.dnsWaiters.get(String(message.id));
            this.dnsWaiters.delete(String(message.id));
            if (message.ok === true) waiter?.resolve();
            else waiter?.reject(new Error(`relay refused the DNS request: ${String(message.error ?? 'unknown')}`));
            return 'continue';
          }
          case 'pong':
            return 'continue';
          case 'error':
            reason = String(message.message ?? message.code);
            if (message.code === 'unregistered') this.register = true;
            if (message.code === 'replaced') replaced = true;
            return 'stop';
          default:
            return 'continue';
        }
      },
      (why) => {
        reason = why;
        socket.destroy();
      },
    );
    socket.on('error', (error) => {
      reason = error.message;
    });
    socket.on('close', () => {
      if (this.session === socket) this.session = undefined;
      if (this.heartbeat) clearInterval(this.heartbeat);
      for (const waiter of this.dnsWaiters.values()) waiter.reject(new Error('relay session closed'));
      this.dnsWaiters.clear();
      if (this.stopped) return;
      if (replaced) {
        this.options.onStatus?.({ state: 'replaced' });
        this.schedule(this.options.replacedBackoffMs ?? 5 * 60_000);
        return;
      }
      if (this.register && this.failures === 0) {
        this.failures = 1;
        this.schedule(0);
        return;
      }
      this.failures += 1;
      const { minMs, maxMs } = this.options.backoff ?? { minMs: 1_000, maxMs: 60_000 };
      const delay = Math.min(maxMs, minMs * 2 ** Math.min(this.failures - 1, 16));
      const jittered = Math.round(delay / 2 + Math.random() * (delay / 2));
      this.options.onStatus?.({ state: 'offline', reason, retryInMs: jittered });
      this.schedule(jittered);
    });
  }

  private schedule(delayMs: number): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => this.connect(), delayMs);
  }

  private attach(connId: string, remoteAddress: string | undefined): void {
    const endpoint = this.endpoint;
    // No certificate yet, or already at the cap: let the relay's attach
    // timeout answer the agent rather than open unbounded connections.
    if (!endpoint || this.dataConnections >= (this.options.maxDataConnections ?? 64)) return;
    const { identity } = this.options;
    const data = this.dial(this.options.dataServerName ?? `data.${this.options.controlServerName}`);
    this.dataConnections += 1;
    this.dataSockets.add(data);
    data.on('close', () => {
      this.dataConnections -= 1;
      this.dataSockets.delete(data);
    });
    data.on('error', () => data.destroy());
    let sentAttach = false;
    readLines(
      data,
      (message) => {
        if (message.type !== 'challenge') {
          data.destroy();
          return 'stop';
        }
        sentAttach = true;
        const sig = signInstallMessage(identity.privateKey, 'attach', String(message.nonce), identity.installId, connId);
        data.write(encodeLine({ type: 'attach', v: PROTOCOL_VERSION, installId: identity.installId, connId, sig }));
        return 'stop';
      },
      () => data.destroy(),
      (rest) => {
        if (!sentAttach) return;
        data.pause();
        const local = net.connect(endpoint.port, '127.0.0.1');
        this.dataSockets.add(local);
        local.on('close', () => this.dataSockets.delete(local));
        const destroyBoth = () => {
          data.destroy();
          local.destroy();
        };
        propagateClose(data, local);
        local.once('connect', () => {
          const port = local.localPort;
          if (port !== undefined) {
            if (remoteAddress) this.peers.set(port, remoteAddress);
            this.firstRequestTimers.set(port, setTimeout(destroyBoth, this.options.firstRequestTimeoutMs ?? 10_000));
            local.once('close', () => {
              this.peers.delete(port);
              const timer = this.firstRequestTimers.get(port);
              if (timer) clearTimeout(timer);
              this.firstRequestTimers.delete(port);
            });
          }
          // A relay-side rejection arrives as one JSON error line; the agent's
          // TLS stream always starts with a handshake record (0x16).
          const first = (chunk: Buffer) => {
            if (chunk[0] === 0x7b) {
              destroyBoth();
              return;
            }
            local.write(chunk);
            data.pipe(local);
          };
          if (rest.length > 0) first(rest);
          else data.once('data', first);
          local.pipe(data);
          data.resume();
        });
      },
    );
  }
}
