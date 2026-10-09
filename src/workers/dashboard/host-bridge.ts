/**
 * The Olympus side of the panel's host protocol (phase 4, owner decision
 * 2026-10-09: the ChatGPT panel is the only dashboard).
 *
 * The panel (chatgpt/client.ts) talks to whatever frames it the way it talks
 * to ChatGPT: JSON-RPC over postMessage (`ui/initialize`, `tools/call`,
 * `ui/open-link`, `ui/request-display-mode`, `ui/notifications/size-changed`).
 * This program answers those calls for an Olympus host — the computer's own
 * /dashboard and the OpenClaw Control UI tab — so both show the exact HTML
 * ChatGPT shows (`ui://olympus/dashboard`) and nothing else renders a
 * dashboard.
 *
 * It is self-contained (no imports, no closures over module state): the
 * computer's host page serializes it with toString, and the Control UI bundle
 * imports and calls it directly. Everything that differs between the two
 * hosts arrives in `config` and `io`.
 */

/** What the host says about itself; the panel reads it from `hostContext`. */
export interface DashboardHostBridgeConfig {
  /** dashboard-contract.ts OLYMPUS_HOST_CONTEXT_KEY. */
  contextKey: string;
  kind: 'computer' | 'openclaw';
  /** The local controls are locked: only the dashboard read is answered. */
  readOnly: boolean;
  /** The local pages the computer offers (Keys, Agents, Outside help, Build a connector), absolute. */
  links: Record<string, string>;
  /** The only tools the panel may call through this host. */
  tools: readonly string[];
  /** The one tool a locked host still answers (olympus_dashboard). */
  readTool: string;
  /**
   * olympusplugin.ai/open/<path>/ pages and the local page each one means
   * here. A link the panel opens that names one of them opens the local page
   * instead of the website that would only hand it back through olympus://.
   */
  openTargets: Record<string, string>;
  /** https://olympusplugin.ai/open/ */
  openBase: string;
}

export interface DashboardHostBridgeIo {
  frame: HTMLIFrameElement;
  /** Runs one tool; resolves to an MCP CallToolResult. */
  callTool(name: string, args: Record<string, unknown>): Promise<unknown>;
  /** Opens a page beside the dashboard (a new tab). */
  openUrl(url: string): void;
  /** The panel's content height changed (the host sizes the frame to it). */
  resize?(height: number): void;
}

export interface DashboardHostBridge {
  dispose(): void;
}

export function dashboardHostBridge(config: DashboardHostBridgeConfig, io: DashboardHostBridgeIo): DashboardHostBridge {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  type Any = any;
  const view = io.frame.ownerDocument.defaultView || window;
  const media = typeof view.matchMedia === 'function' ? view.matchMedia('(prefers-color-scheme: dark)') : null;

  function theme(): 'light' | 'dark' {
    return media && media.matches ? 'dark' : 'light';
  }

  function hostContext(): Any {
    const context: Any = {
      theme: theme(),
      displayMode: 'fullscreen',
      availableDisplayModes: ['fullscreen'],
    };
    context[config.contextKey] = { kind: config.kind, readOnly: config.readOnly, links: config.links };
    return context;
  }

  function post(message: Any): void {
    const target = io.frame.contentWindow;
    // The frame is sandboxed without same-origin, so its origin is opaque and
    // cannot be named; the message goes to that one window only.
    if (target) target.postMessage(message, '*');
  }

  function reply(id: Any, result: Any): void {
    post({ jsonrpc: '2.0', id, result });
  }

  function fail(id: Any, code: number, message: string): void {
    post({ jsonrpc: '2.0', id, error: { code, message } });
  }

  function refused(text: string): Any {
    return { isError: true, content: [{ type: 'text', text }] };
  }

  /** The local page an olympusplugin.ai/open/ link means here, or ''. */
  function localTarget(url: URL): string {
    const base = config.openBase;
    if (url.href.indexOf(base) !== 0) return '';
    const path = url.pathname.slice(new URL(base).pathname.length).replace(/\/$/, '');
    return Object.prototype.hasOwnProperty.call(config.openTargets, path) ? config.openTargets[path]! : '';
  }

  function openLink(raw: Any): boolean {
    if (typeof raw !== 'string') return false;
    const local = Object.keys(config.links).some((key) => config.links[key] === raw);
    if (local) {
      io.openUrl(raw);
      return true;
    }
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      return false;
    }
    if (url.protocol !== 'https:' || url.username || url.password) return false;
    io.openUrl(localTarget(url) || url.href);
    return true;
  }

  function callTool(id: Any, params: Any): void {
    const name = params && typeof params.name === 'string' ? params.name : '';
    const args = params && params.arguments && typeof params.arguments === 'object' && !Array.isArray(params.arguments)
      ? params.arguments
      : {};
    if (config.tools.indexOf(name) < 0) {
      reply(id, refused('This tool is not available here.'));
      return;
    }
    if (config.readOnly && name !== config.readTool) {
      reply(id, refused('Open dashboard controls first.'));
      return;
    }
    io.callTool(name, args).then(
      (result) => reply(id, result),
      () => reply(id, refused('Could not reach Olympus.')),
    );
  }

  function onMessage(event: MessageEvent): void {
    if (event.source !== io.frame.contentWindow) return;
    const message = event.data;
    if (!message || typeof message !== 'object' || message.jsonrpc !== '2.0' || typeof message.method !== 'string') return;
    const id = message.id;
    const params = message.params;
    switch (message.method) {
      case 'ui/initialize':
        reply(id, {
          protocolVersion: params && typeof params.protocolVersion === 'string' ? params.protocolVersion : '2026-01-26',
          hostInfo: { name: 'olympus', version: '1' },
          hostCapabilities: { openLinks: {}, serverTools: {} },
          hostContext: hostContext(),
        });
        return;
      case 'tools/call':
        callTool(id, params);
        return;
      case 'ui/open-link':
        if (openLink(params && params.url)) reply(id, {});
        else fail(id, -32602, 'That link cannot be opened.');
        return;
      case 'ui/request-display-mode':
        reply(id, { mode: 'fullscreen' });
        return;
      case 'ui/notifications/size-changed':
        if (io.resize && params && typeof params.height === 'number' && Number.isFinite(params.height)) io.resize(params.height);
        return;
      default:
        if (id !== undefined) fail(id, -32601, 'Method not found.');
    }
  }

  function onTheme(): void {
    post({ jsonrpc: '2.0', method: 'ui/notifications/host-context-changed', params: hostContext() });
  }

  view.addEventListener('message', onMessage);
  if (media && typeof media.addEventListener === 'function') media.addEventListener('change', onTheme);
  return {
    dispose(): void {
      view.removeEventListener('message', onMessage);
      if (media && typeof media.removeEventListener === 'function') media.removeEventListener('change', onTheme);
    },
  };
}
