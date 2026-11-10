/** Private, bearer-only entrypoints to the existing remote MCP surface. */
import { isIP } from 'node:net';
import { networkInterfaces } from 'node:os';
import type { RemoteConnectionStore } from '../core/remote-connections.ts';
import { authenticateRemoteRequest, createRemoteMcpHandler, type RemoteMcpHandlerOptions } from './remote-mcp.ts';
import { withFirstRunPrivacyGate } from './first-run-privacy-gate.ts';

export type PrivateAgentRoute = 'loopback' | 'tailnet';
export const PRIVATE_AGENT_PORT = 17841;
export interface PrivateAgentRouteView {
  state: 'available' | 'absent' | 'unavailable';
  listening: boolean;
  urls: string[];
  message?: string;
}
export type PrivateAgentListenersView = Record<PrivateAgentRoute, PrivateAgentRouteView>;
type Handler = (request: Request) => Promise<Response>;
type Listener = { port: number; stop(): unknown };
export interface PrivateAgentListeners {
  refresh(): void;
  view(): PrivateAgentListenersView;
  close(): void;
}

/** No hostnames, wildcards, mapped IPv4, LAN, or public interfaces. */
export function isPrivateAgentBindAddress(route: PrivateAgentRoute, address: string): boolean {
  if (route === 'loopback') return address === '127.0.0.1';
  if (isIP(address) === 4) {
    const octets = address.split('.').map(Number);
    return octets[0] === 100 && octets[1]! >= 64 && octets[1]! <= 127;
  }
  return isIP(address) === 6 && /^fd7a:115c:a1e0:/i.test(address) && !address.includes('%');
}

/** Tailscale's interface: tailscale0 on Linux, a utun device on macOS. */
export function isTailscaleInterfaceName(name: string, platform: string = process.platform): boolean {
  return platform === 'darwin' ? /^utun\d+$/.test(name) : /^tailscale\d+$/.test(name);
}

function interfaceAddresses(): string[] {
  // OS interface inspection only: no Tailscale CLI, subprocess or network call.
  // Only Tailscale's own interfaces: some ISPs hand out 100.64.0.0/10 (carrier-grade
  // NAT) addresses to ordinary network interfaces, and those must never be bound.
  return Object.entries(networkInterfaces())
    .filter(([name]) => isTailscaleInterfaceName(name))
    .flatMap(([, items]) => (items ?? []).filter(item => !item.internal).map(item => item.address));
}
const mcpUrl = (address: string, port: number) => `http://${isIP(address) === 6 ? `[${address}]` : address}:${port}/mcp`;

export function createPrivateAgentListeners(options: {
  connections: () => RemoteConnectionStore | undefined;
  mcp: Pick<RemoteMcpHandlerOptions, 'makeOperationContext' | 'search' | 'anonymousAnswersEnabled'>;
  privacyPending: () => boolean;
  addresses?: () => string[];
  port?: number;
  /** Injection for bind/lifecycle tests; production always calls Bun.serve. */
  listen?: (address: string, handler: Handler) => Listener;
  /**
   * The engine split's front: the read gate a source-data delete closes
   * (engine-split/runtime.ts), so these listeners admit nothing and return
   * nothing read before the delete once it starts.
   */
  gate?: (handler: Handler) => (request: Request, server: undefined) => Promise<Response>;
}): PrivateAgentListeners {
  const port = options.port ?? PRIVATE_AGENT_PORT;
  const active = new Map<string, { route: PrivateAgentRoute; server: Listener }>();
  let closed = false;
  let views: PrivateAgentListenersView;
  const listen = options.listen ?? ((hostname, fetch) => {
    // HTTP on the tailnet is protected by Tailscale's WireGuard encryption.
    // Binding an exact interface address is mandatory; never retry a wildcard.
    const server = Bun.serve({ hostname, port, idleTimeout: 0, fetch });
    return { port: server.port!, stop: () => server.stop(true) };
  });
  const handlers = Object.fromEntries((['loopback', 'tailnet'] as const).map(route => {
    const mcp = withFirstRunPrivacyGate(createRemoteMcpHandler({
      // Select fields explicitly: runtime objects may also carry publicUrls
      // or the relay's ChatGPT selector. Neither belongs on these listeners.
      makeOperationContext: options.mcp.makeOperationContext,
      ...(options.mcp.search ? { search: options.mcp.search } : {}),
      ...(options.mcp.anonymousAnswersEnabled ? { anonymousAnswersEnabled: options.mcp.anonymousAnswersEnabled } : {}),
      connections: options.connections, connectionRoute: route,
      isRelayed: () => false,
    }), { pending: options.privacyPending });
    const gated = options.gate?.(mcp);
    return [route, gated ? (request: Request) => gated(request, undefined) : mcp];
  })) as Record<PrivateAgentRoute, Handler>;

  function stop(address: string) {
    const entry = active.get(address);
    active.delete(address);
    if (entry) entry.server.stop();
  }
  function refresh() {
    if (closed) return;
    let addresses: string[] = [];
    let records: ReturnType<RemoteConnectionStore['list']> = [];
    let storeFailed = false;
    let interfacesFailed = false;
    try { addresses = [...new Set((options.addresses ?? interfaceAddresses)())].filter(a => isPrivateAgentBindAddress('tailnet', a)); }
    catch { interfacesFailed = true; }
    try { records = options.connections()?.list() ?? []; }
    catch { storeFailed = true; }
    const desired = new Map<string, PrivateAgentRoute>();
    if (!storeFailed) {
      for (const route of ['loopback', 'tailnet'] as const) {
        if (records.some(r => r.kind === 'bearer' && r.route === route && r.revokedAt === null)) {
          for (const address of route === 'loopback' ? ['127.0.0.1'] : addresses) desired.set(address, route);
        }
      }
    }
    for (const address of active.keys()) if (!desired.has(address)) stop(address);
    const failed = new Set<PrivateAgentRoute>();
    for (const [address, route] of desired) {
      if (active.has(address)) continue;
      try {
        // Validate at the actual bind boundary as well as during discovery.
        if (!isPrivateAgentBindAddress(route, address)) throw new Error('Unsafe bind refused');
        const server = listen(address, async request => {
          // Disappearance and revocation also take effect before each request,
          // without waiting for the background interface poll.
          refresh();
          if (!active.has(address)) return Response.json({ error: 'connection_unavailable' }, { status: 503 });
          // No dashboard, OAuth approval, directory listing, OpenAPI or control
          // route is ever composed here. Even a valid key reaches only /mcp.
          if (new URL(request.url).pathname !== '/mcp') return new Response(null, { status: 404 });
          const auth = authenticateRemoteRequest(request, { connections: options.connections, connectionRoute: route });
          if (!auth.ok) return auth.response;
          return handlers[route](request);
        });
        active.set(address, { route, server });
      } catch { failed.add(route); }
    }
    const view = (route: PrivateAgentRoute): PrivateAgentRouteView => {
      const candidates = route === 'loopback' ? ['127.0.0.1'] : addresses;
      const servers = [...active.values()].filter(a => a.route === route);
      if (storeFailed || failed.has(route) || (route === 'tailnet' && interfacesFailed)) return {
        state: 'unavailable', listening: servers.length > 0, urls: [],
        message: 'Olympus could not open this connection. Check that Olympus is running, then try again.',
      };
      if (route === 'tailnet' && candidates.length === 0) return {
        state: 'absent', listening: false, urls: [], message: "Tailscale isn't running on this computer",
      };
      return { state: 'available', listening: servers.length > 0,
        urls: candidates.map(a => mcpUrl(a, active.get(a)?.server.port ?? port)) };
    };
    views = { loopback: view('loopback'), tailnet: view('tailnet') };
  }
  refresh();
  // Keys can be revoked by the CLI in another process. Poll both that database
  // and the OS interfaces, including while no private listener is running.
  const timer = setInterval(refresh, 2_000); timer.unref();
  return {
    refresh,
    view() { refresh(); return views; },
    close() { closed = true; clearInterval(timer); for (const address of active.keys()) stop(address); },
  };
}
