/**
 * The panel's tools on Olympus's own hosts (unified dashboard phase 4,
 * 2026-10-09): the worker side of POST /dashboard/tools/call (the computer's
 * /dashboard) and of the OpenClaw Control UI tab's gateway method.
 *
 * Every call runs the same in-process handler ChatGPT's /mcp reaches
 * (chatgpt/mcp-surface.ts callChatGptTool, with the same surface options), so
 * the panel answers the same way on every host. Three things differ, all
 * because the person is at the computer rather than in ChatGPT:
 * - only the panel's own tools run (dashboard-contract.ts PANEL_TOOL_NAMES):
 *   search and the answer tools belong to a conversation;
 * - sign-in starts here and returns here: Connect posts the local OAuth start
 *   (no relay handback) with this browser's origin, and the panel opens the
 *   provider's own page instead of a one-time relay link;
 * - the computer adds Index faster (`olympus_index_faster`, the
 *   embedding-priority override) and tells the panel where it stands in the
 *   dashboard result's `_meta['olympus/computer']`, read off the overnight
 *   guard's own files. ChatGPT never sees either.
 */
import {
  COMPUTER_HOST_TOOL_NAMES,
  COMPUTER_META_KEY,
  DASHBOARD_TOOL_NAME,
  INDEX_FASTER_TOOL_NAME,
  type ComputerDashboardMeta,
} from '../chatgpt/dashboard-contract.ts';
import { callChatGptTool, type ChatGptSurfaceOptions } from '../chatgpt/mcp-surface.ts';
import type { ChatGptToolResult } from '../chatgpt/response-builder.ts';
import { SetupBackendError, type ChatGptSetupBackend } from '../chatgpt/setup-tools.ts';
import type { OperationContext } from '../../core/operations.ts';
import { DASHBOARD_GATEWAY_PUBLIC_ORIGIN_HEADER } from '../http.ts';

/** Where the call came from: the origin the browser reached Olympus at. */
export interface DashboardPanelCallContext {
  /** The worker's OAuth redirect origin for this request (loopback, or the gateway's public origin). */
  origin: string;
  /** Set when the request came through the gateway: the start route re-reads it. */
  gatewayOrigin?: string;
  signal?: AbortSignal;
}

export interface DashboardPanelTools {
  /** Whether `name` is one of the tools this host runs for the panel. */
  allows(name: string): boolean;
  call(name: string, args: Record<string, unknown>, context: DashboardPanelCallContext): Promise<ChatGptToolResult>;
}

export interface DashboardPanelToolsOptions {
  /** ChatGPT's surface options, exactly as /mcp uses them (server.ts). */
  surface: () => ChatGptSurfaceOptions;
  /** The ChatGPT setup backend; Connect is replaced, everything else is shared. */
  setup: ChatGptSetupBackend;
  /** The worker's own fetch (in process, no bearer). */
  workerFetch: (request: Request) => Promise<Response>;
  /** An operation context for this local caller (unused by the panel's tools, required by the surface). */
  makeContext: (signal: AbortSignal) => OperationContext;
  /** The embedding-priority override, or undefined when the guard's state is unknown here. */
  indexFasterState: () => Promise<boolean | undefined>;
}

function refused(text: string, code: string): ChatGptToolResult {
  return { content: [{ type: 'text', text }], structuredContent: { error: code }, isError: true };
}

/** A Connect that starts and finishes on this computer. */
function computerSetup(options: DashboardPanelToolsOptions, context: DashboardPanelCallContext): ChatGptSetupBackend {
  return {
    ...options.setup,
    directSignIn: true,
    async startOAuth(source) {
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (context.gatewayOrigin) headers[DASHBOARD_GATEWAY_PUBLIC_ORIGIN_HEADER] = context.gatewayOrigin;
      // The request URL carries the origin: the start route builds the
      // callback from it exactly as it does for the local Connect button.
      const response = await options.workerFetch(new Request(`${context.origin}/dashboard/connect/oauth/start`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ source }),
      }));
      const parsed = await response.json().catch(() => undefined) as Record<string, unknown> | undefined;
      if (!response.ok || !parsed) {
        const code = (parsed?.error as { code?: unknown } | undefined)?.code;
        throw new SetupBackendError(typeof code === 'string' ? code : 'internal');
      }
      if (typeof parsed.authorization_url !== 'string' || typeof parsed.expires_at !== 'string') throw new SetupBackendError('internal');
      return { authorizationUrl: parsed.authorization_url, expiresAt: parsed.expires_at };
    },
    handoffLink() {
      // Nothing to hand off: the browser is already on the computer.
      return undefined;
    },
  };
}

async function indexFaster(options: DashboardPanelToolsOptions, args: Record<string, unknown>): Promise<ChatGptToolResult> {
  const keys = Object.keys(args);
  if (typeof args.on !== 'boolean' || keys.some((key) => key !== 'on')) return refused('on must be true or false.', 'invalid_params');
  const response = await options.workerFetch(new Request('http://olympus-worker.internal/dashboard/embedding-priority', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ on: args.on }),
  }));
  if (!response.ok) return refused('Could not change indexing speed.', 'internal');
  return {
    content: [{ type: 'text', text: args.on ? 'Indexing faster.' : 'Indexing at the normal pace.' }],
    structuredContent: { status: 'saved', on: args.on },
  };
}

export function createDashboardPanelTools(options: DashboardPanelToolsOptions): DashboardPanelTools {
  const allowed = new Set(COMPUTER_HOST_TOOL_NAMES);
  return {
    allows: (name) => allowed.has(name),
    async call(name, args, context) {
      if (!allowed.has(name)) return refused('This tool is not available here.', 'unknown_tool');
      if (name === INDEX_FASTER_TOOL_NAME) return await indexFaster(options, args);
      const signal = context.signal ?? new AbortController().signal;
      const surface = { ...options.surface(), setup: computerSetup(options, context) };
      const result = await callChatGptTool(name, args, options.makeContext(signal), surface, signal);
      if (name !== DASHBOARD_TOOL_NAME || result.isError) return result;
      const on = await options.indexFasterState().catch(() => undefined);
      if (on === undefined) return result;
      const meta: ComputerDashboardMeta = { indexFaster: { on } };
      const existing = result._meta && typeof result._meta === 'object' ? result._meta as Record<string, unknown> : {};
      return { ...result, _meta: { ...existing, [COMPUTER_META_KEY]: meta } };
    },
  };
}
