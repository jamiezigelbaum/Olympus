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
 *   embedding-priority override) and Unpair (`olympus_unpair_source`, the
 *   worker's POST /dashboard/unpair for a paired chat app), and tells the
 *   panel where they stand in the dashboard result's
 *   `_meta['olympus/computer']`: Index faster's position read off the
 *   overnight guard's own files, and which paired apps Unpair can end, read
 *   off the same view the dashboard result was built from. ChatGPT never sees
 *   any of it.
 * - the computer lists every unreadable file (`_meta['olympus/computer']`
 *   `unreadable`, up to COMPUTER_UNREADABLE_FILES_LIMIT per source) with a
 *   one-time token each, and opens one through `olympus_open_unreadable_file
 *   {token}`: the synced copy here, or the file's own web page for the panel
 *   to open. The token is the only argument; a path is never taken. Tokens
 *   are minted only for an unlocked control session (or the worker bearer),
 *   bound to it, open once, and last 30 minutes from issue; a locked reader
 *   gets the names alone. Past the first page, `olympus_unreadable_files
 *   {source_id, after}` lists the next (a keyset cursor, so a file judged
 *   Secrets between pages moves nothing), so every file is reachable.
 */
import {
  COMPUTER_HOST_TOOL_NAMES,
  COMPUTER_META_KEY,
  COMPUTER_UNREADABLE_FILES_LIMIT,
  DASHBOARD_TOOL_NAME,
  INDEX_FASTER_TOOL_NAME,
  OPEN_UNREADABLE_FILE_TOOL_NAME,
  UNPAIR_SOURCE_TOOL_NAME,
  UNREADABLE_FILES_PAGE_TOOL_NAME,
  unreadableNames,
  type ComputerDashboardMeta,
  type ComputerUnpairEntry,
  type ComputerUnreadableEntry,
} from '../chatgpt/dashboard-contract.ts';
import { isUnreadablePageCursor, type UnreadableFiles } from '../file-extraction/unreadable-files.ts';
import { callChatGptTool, type ChatGptSurfaceOptions } from '../chatgpt/mcp-surface.ts';
import type { ChatGptToolResult } from '../chatgpt/response-builder.ts';
import { SetupBackendError, type ChatGptSetupBackend } from '../chatgpt/setup-tools.ts';
import type { OperationContext } from '../../core/operations.ts';
import type { SourceDashboardViewModel } from '../source-dashboard.ts';
import { DASHBOARD_GATEWAY_PUBLIC_ORIGIN_HEADER } from '../http.ts';

/** Where the call came from: the origin the browser reached Olympus at. */
export interface DashboardPanelCallContext {
  /** The worker's OAuth redirect origin for this request (loopback, or the gateway's public origin). */
  origin: string;
  /** Set when the request came through the gateway: the start route re-reads it. */
  gatewayOrigin?: string;
  signal?: AbortSignal;
  /**
   * Who may open unreadable files from this call: an unlocked control session
   * or the worker bearer. Absent (a locked dash_ reader): names, no tokens.
   */
  opener?: string;
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
  /** Which files can't be read, and opening one; absent without the extraction factory. */
  unreadableFiles?: () => UnreadableFiles | undefined;
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

/** The paired chat apps the worker's Unpair route takes. */
const UNPAIR_SOURCE_IDS = new Set(['telegram.messages', 'whatsapp.personal.messages']);

/** Unpair for a paired chat app: the worker's own route, acknowledged by the panel's confirm. */
async function unpairSource(options: DashboardPanelToolsOptions, args: Record<string, unknown>): Promise<ChatGptToolResult> {
  const keys = Object.keys(args);
  if (typeof args.source_id !== 'string' || !UNPAIR_SOURCE_IDS.has(args.source_id) || keys.some((key) => key !== 'source_id')) {
    return refused('source_id must be a paired chat app.', 'invalid_params');
  }
  const response = await options.workerFetch(new Request('http://olympus-worker.internal/dashboard/unpair', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ source_id: args.source_id, acknowledge: true }),
  }));
  const parsed = await response.json().catch(() => undefined) as Record<string, unknown> | undefined;
  if (!response.ok || !parsed || parsed.ok !== true) {
    // The route's refusals are its own fixed sentences (busy, record unreadable, ...).
    const error = parsed?.error as { code?: unknown; message?: unknown } | undefined;
    return refused(
      typeof error?.message === 'string' ? error.message : 'Could not unpair.',
      typeof error?.code === 'string' ? error.code : 'internal',
    );
  }
  const text = typeof parsed.status_message === 'string' ? parsed.status_message : 'Unpaired.';
  return { content: [{ type: 'text', text }], structuredContent: { status: 'saved', source_id: args.source_id } };
}

/** Opening one unreadable file by its one-time token; the token is the only argument. */
async function openUnreadableFile(options: DashboardPanelToolsOptions, args: Record<string, unknown>, context: DashboardPanelCallContext): Promise<ChatGptToolResult> {
  const keys = Object.keys(args);
  if (typeof args.token !== 'string' || keys.some((key) => key !== 'token')) return refused('token must be a file token from the dashboard.', 'invalid_params');
  const files = options.unreadableFiles?.();
  if (!files || !context.opener) return refused('Olympus cannot open this file here.', 'unavailable');
  const opened = await files.open(args.token, context.opener);
  switch (opened.status) {
    case 'opened':
      return { content: [{ type: 'text', text: 'Opened the file on this computer.' }], structuredContent: { status: 'opened' } };
    case 'open_link':
      return { content: [{ type: 'text', text: 'Opening the file\'s page.' }], structuredContent: { status: 'open_link', url: opened.url } };
    case 'invalid':
      return refused('token must be a file token from the dashboard.', 'invalid_params');
    case 'rate_limited':
      return refused('Too many files opened at once. Try again in a moment.', 'rate_limited');
    case 'failed':
      return refused('The file could not be opened.', 'internal');
    default:
      return refused('This file is no longer in the list. Refresh the dashboard.', 'gone');
  }
}

/**
 * The next page of one source's unreadable files (`{source_id, after}`), with
 * open tokens for this opener: what the first page's "more" counts, so every
 * file is reachable however many there are. The source's corpora are the ones
 * the dashboard view names now.
 */
async function unreadableFilesPage(
  options: DashboardPanelToolsOptions,
  args: Record<string, unknown>,
  context: DashboardPanelCallContext,
): Promise<ChatGptToolResult> {
  const keys = Object.keys(args);
  const after = args.after;
  if (
    typeof args.source_id !== 'string'
    || !isUnreadablePageCursor(after)
    || keys.some((key) => key !== 'source_id' && key !== 'after')
  ) {
    return refused('source_id and after must come from the dashboard.', 'invalid_params');
  }
  const files = options.unreadableFiles?.();
  if (!files || !context.opener) return refused('Olympus cannot list these files here.', 'unavailable');
  const sourceId = args.source_id;
  const view = await options.surface().dashboardView(context.signal).catch(() => undefined);
  const corpusIds = view?.sources.find((card) => card.source_id === sourceId)?.unreadable_files?.corpus_ids;
  if (!corpusIds?.length) return refused('This list changed. Refresh the dashboard.', 'gone');
  const listed = files.computerList(corpusIds, COMPUTER_UNREADABLE_FILES_LIMIT, { after, opener: context.opener });
  const page = entriesOf(listed.files);
  return {
    content: [{ type: 'text', text: `${page.length} more files.` }],
    structuredContent: {
      status: 'listed',
      source_id: args.source_id,
      files: page,
      more: listed.more,
      ...(listed.more > 0 && listed.after ? { after: listed.after } : {}),
    },
  };
}

function entriesOf(files: ReturnType<UnreadableFiles['computerList']>['files']): ComputerUnreadableEntry['files'] {
  return files.flatMap((file) => {
    const [name] = unreadableNames([file.name]);
    return name ? [{ name, ...(file.token ? { token: file.token } : {}) }] : [];
  });
}

/**
 * Every unreadable file per source the view counts, first page, for the
 * computer's See why: with open tokens bound to `opener` when there is one
 * (an unlocked session, or the bearer), names alone for a locked reader.
 */
export function computerUnreadableEntries(
  view: SourceDashboardViewModel | undefined,
  files: UnreadableFiles | undefined,
  opener?: string,
): ComputerUnreadableEntry[] {
  if (!view || !files) return [];
  return view.sources.flatMap((card) => {
    const count = Math.max(0, Math.trunc(card.coverage.unreadable_items ?? 0));
    const corpusIds = card.unreadable_files?.corpus_ids ?? [];
    if (count === 0 || corpusIds.length === 0) return [];
    let listed: ReturnType<UnreadableFiles['computerList']>;
    try {
      listed = files.computerList(corpusIds, COMPUTER_UNREADABLE_FILES_LIMIT, opener ? { opener } : {});
    } catch {
      return [];
    }
    const entries = entriesOf(listed.files);
    // Past the limit the list says how many more; the row's count is the word,
    // so a count read a moment apart from the list never shows fewer.
    const more = Math.max(0, listed.more, count - entries.length);
    return [{ sourceId: card.source_id, files: entries, more, ...(more > 0 && listed.after ? { after: listed.after } : {}) }];
  });
}

/** Which paired apps this computer can unpair, off the view the dashboard result came from. */
export function computerUnpairEntries(view: SourceDashboardViewModel | undefined): ComputerUnpairEntry[] {
  if (!view) return [];
  return view.sources.flatMap((card) => {
    const action = card.connection.unpair;
    if (!action || !UNPAIR_SOURCE_IDS.has(action.source_id)) return [];
    return [{ sourceId: action.source_id, label: action.label, confirmation: action.confirmation }];
  });
}

export function createDashboardPanelTools(options: DashboardPanelToolsOptions): DashboardPanelTools {
  const allowed = new Set(COMPUTER_HOST_TOOL_NAMES);
  return {
    allows: (name) => allowed.has(name),
    async call(name, args, context) {
      if (!allowed.has(name)) return refused('This tool is not available here.', 'unknown_tool');
      if (name === INDEX_FASTER_TOOL_NAME) return await indexFaster(options, args);
      if (name === UNPAIR_SOURCE_TOOL_NAME) return await unpairSource(options, args);
      if (name === OPEN_UNREADABLE_FILE_TOOL_NAME) return await openUnreadableFile(options, args, context);
      if (name === UNREADABLE_FILES_PAGE_TOOL_NAME) return await unreadableFilesPage(options, args, context);
      const signal = context.signal ?? new AbortController().signal;
      const base = options.surface();
      // Keep the view the dashboard result is built from, for Unpair's entries.
      let view: SourceDashboardViewModel | undefined;
      const surface = {
        ...base,
        setup: computerSetup(options, context),
        dashboardView: async (viewSignal?: AbortSignal) => (view = await base.dashboardView(viewSignal)),
      };
      const result = await callChatGptTool(name, args, options.makeContext(signal), surface, signal);
      if (name !== DASHBOARD_TOOL_NAME || result.isError) return result;
      const on = await options.indexFasterState().catch(() => undefined);
      const unpair = computerUnpairEntries(view);
      const unreadable = computerUnreadableEntries(view, options.unreadableFiles?.(), context.opener);
      if (on === undefined && unpair.length === 0 && unreadable.length === 0) return result;
      const meta: ComputerDashboardMeta = {
        ...(on !== undefined ? { indexFaster: { on } } : {}),
        ...(unpair.length > 0 ? { unpair } : {}),
        ...(unreadable.length > 0 ? { unreadable } : {}),
      };
      const existing = result._meta && typeof result._meta === 'object' ? result._meta as Record<string, unknown> : {};
      return { ...result, _meta: { ...existing, [COMPUTER_META_KEY]: meta } };
    },
  };
}
