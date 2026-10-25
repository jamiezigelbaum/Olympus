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
 * - for a local-grade control session (the computer's own browser), the meta
 *   also counts the private questions waiting here (`waitingPrivateQuestions`),
 *   the computer's one Needs you line. Never for the Gateway bearer, a session
 *   the bearer minted or a launch ticket redeemed, and never to ChatGPT.
 * - the computer imports archives: `olympus_archive_browse` lists files and
 *   folders for the picker (names in the picker's `_meta` only),
 *   `olympus_archive_approve`, `olympus_archive_decline` and
 *   `olympus_archive_remove` and `olympus_archive_stop` reach the worker's archive routes, which run
 *   under the dashboard grant guard, and `_meta['olympus/computer']
 *   archives` lists the imported archives and the imports waiting on the
 *   person for the Archives row.
 */
import {
  ARCHIVE_APPROVE_TOOL_NAME,
  ARCHIVE_BROWSE_TOOL_NAME,
  ARCHIVE_DECLINE_TOOL_NAME,
  ARCHIVE_REMOVE_TOOL_NAME,
  ARCHIVE_STOP_TOOL_NAME,
  COMPUTER_HOST_TOOL_NAMES,
  COMPUTER_META_KEY,
  COMPUTER_UNREADABLE_FILES_LIMIT,
  DASHBOARD_TOOL_NAME,
  INDEX_FASTER_TOOL_NAME,
  OPEN_UNREADABLE_FILE_TOOL_NAME,
  UNPAIR_SOURCE_TOOL_NAME,
  SCOPE_UI_META_KEY,
  UNREADABLE_FILES_PAGE_TOOL_NAME,
  unreadableNames,
  type ComputerArchivesMeta,
  type ComputerDashboardMeta,
  type ComputerArchiveSourceMeta,
  type ComputerSourceImportsMeta,
  type ComputerUnpairEntry,
  type ComputerUnreadableEntry,
} from '../chatgpt/dashboard-contract.ts';
import { isUnreadablePageCursor, type UnreadableFiles } from '../file-extraction/unreadable-files.ts';
import { callChatGptTool, type ChatGptSurfaceOptions } from '../chatgpt/mcp-surface.ts';
import type { ChatGptToolResult } from '../chatgpt/response-builder.ts';
import { SetupBackendError, type ChatGptSetupBackend } from '../chatgpt/setup-tools.ts';
import type { OperationContext } from '../../core/operations.ts';
import { FILES_AND_FOLDERS_URL } from '../local-files/mac-permissions.ts';
import type { SourceDashboardViewModel } from '../source-dashboard.ts';
import { DASHBOARD_CONTROL_GRADE_CONTEXT_HEADER, DASHBOARD_GATEWAY_PUBLIC_ORIGIN_HEADER } from '../http.ts';

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
  /**
   * True only for a local-grade control session (minted from this computer's
   * own browser): the grade workers/http.ts injects after the cookie checked
   * out. A bearer-minted or launch-ticket session, and the bearer, are never local.
   */
  localSession?: boolean;
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
  /**
   * How many private questions wait for this computer (core/
   * waiting-private-questions.ts), for the computer's one Needs you line.
   * Put in the computer meta only for a local-grade control session, never
   * for the Gateway bearer (the OpenClaw tab), a bearer-minted or launch-ticket
   * session, or a locked reader, and never in anything ChatGPT receives.
   */
  waitingPrivateQuestions?: () => number;
  /**
   * The Archives row's list (archive-import/dashboard.ts): the person's
   * imported archives and the imports waiting on them. Names and folders of
   * the person's files, so only ever in the computer meta. Absent: no row list.
   */
  archives?: () => ComputerArchivesMeta | undefined;
  /**
   * The imports that joined a source (archive-import/dashboard.ts), shown
   * inside that source's card. Names and folders of the person's files, so
   * only ever in the computer meta.
   */
  sourceImports?: () => ComputerSourceImportsMeta[] | undefined;
  /** The cards that import their own exports (archive-import/dashboard.ts archiveSources). */
  archiveSources?: () => ComputerArchiveSourceMeta[] | undefined;
}

/** Why an archive control did nothing for a session that is not this computer's own. */
const ARCHIVE_LOCAL_SESSION_REFUSAL = 'Archives are chosen, imported, declined and removed only in the dashboard on this computer, in an unlocked browser.';

function refused(text: string, code: string): ChatGptToolResult {
  return { content: [{ type: 'text', text }], structuredContent: { error: code }, isError: true };
}

/** A Connect that starts and finishes on this computer. */
function computerSetup(
  options: DashboardPanelToolsOptions,
  context: DashboardPanelCallContext,
  privacyConfirmationScope: object,
): ChatGptSetupBackend {
  return {
    ...options.setup,
    // A fresh wrapper per call: the privacy confirmations live on one stable
    // scope instead, or a save could never spend the confirmation its
    // olympus_privacy_get issued (2026-10-11: every first save failed).
    privacyConfirmationScope,
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

const ARCHIVE_ARG_MAX = 4096;

function archiveArg(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= ARCHIVE_ARG_MAX && !value.includes('\0');
}

/**
 * One archive route on the worker (email-source/index.ts, under the grant
 * guard): its JSON answer, or the refusal it gave in its own words.
 */
async function archiveRoute(
  options: DashboardPanelToolsOptions,
  route: 'browse' | 'approve' | 'decline' | 'remove' | 'stop',
  body: Record<string, unknown>,
  context: DashboardPanelCallContext,
): Promise<{ ok: true; parsed: Record<string, unknown> } | { ok: false; result: ChatGptToolResult }> {
  // Browse, Approve, Decline and Remove are the person's at this computer's
  // own dashboard: a local-grade session, never the bearer (the OpenClaw
  // tab's gateway method holds it) nor a session a bearer minted. Browse too:
  // it lists this computer's folders. The grade rides to the route only from
  // here, so the route refuses everything else too.
  if (context.localSession !== true) {
    return { ok: false, result: refused(ARCHIVE_LOCAL_SESSION_REFUSAL, 'mac_dashboard_only') };
  }
  const response = await options.workerFetch(new Request(`http://olympus-worker.internal/dashboard/archive-import/${route}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      [DASHBOARD_CONTROL_GRADE_CONTEXT_HEADER]: 'local',
    },
    body: JSON.stringify(body),
  }));
  const parsed = await response.json().catch(() => undefined) as Record<string, unknown> | undefined;
  if (response.ok && parsed && parsed.ok === true) return { ok: true, parsed };
  // A refusal the backend answered (not a file Olympus imports, a link, the Mac's permission) or the route's own.
  const error = (parsed?.ok === false && typeof parsed.code === 'string' ? parsed : parsed?.error) as
    { code?: unknown; message?: unknown; access?: unknown } | undefined;
  const code = typeof error?.code === 'string' ? error.code : 'internal';
  const text = typeof error?.message === 'string' ? error.message : 'Olympus could not do that. Try again.';
  const access = error?.access && typeof error.access === 'object' ? error.access : undefined;
  return {
    ok: false,
    result: {
      content: [{ type: 'text', text }],
      structuredContent: { error: code, ...(access ? { access } : {}) },
      isError: true,
    },
  };
}

/** One level of the archive picker: files and folders, the names in the picker's `_meta` only. */
async function archiveBrowse(options: DashboardPanelToolsOptions, args: Record<string, unknown>, context: DashboardPanelCallContext): Promise<ChatGptToolResult> {
  const keys = Object.keys(args);
  if (keys.some((key) => key !== 'parent_key' && key !== 'cursor')
    || (args.parent_key !== undefined && !archiveArg(args.parent_key))
    || (args.cursor !== undefined && !archiveArg(args.cursor))) {
    return refused('parent_key and cursor must be from the picker.', 'invalid_params');
  }
  const answer = await archiveRoute(options, 'browse', args, context);
  if (!answer.ok) return answer.result;
  const nodes = Array.isArray(answer.parsed.nodes) ? answer.parsed.nodes : [];
  return {
    content: [{ type: 'text', text: 'Listed.' }],
    structuredContent: { status: 'listed', count: nodes.length },
    _meta: {
      [SCOPE_UI_META_KEY]: {
        nodes,
        ...(typeof answer.parsed.next_cursor === 'string' ? { next_cursor: answer.parsed.next_cursor } : {}),
        ...(answer.parsed.access && typeof answer.parsed.access === 'object' ? { access: answer.parsed.access } : {}),
      },
    },
  };
}

/** Import the chosen file or folder, or approve an agent's request: answered at once (started, checking, already imported). */
async function archiveApprove(options: DashboardPanelToolsOptions, args: Record<string, unknown>, context: DashboardPanelCallContext): Promise<ChatGptToolResult> {
  // The chosen key or the request, and at most one answer to "which account is this export of": add it to
  // the connected account, or keep it under Archives.
  // A source's own Import an archive also names its card (`source_id`), with a chosen key only.
  const keys = Object.keys(args).filter((key) => key !== 'confirm_account' && key !== 'keep_apart' && key !== 'source_id');
  const byKey = keys.length === 1 && keys[0] === 'key' && archiveArg(args.key);
  if (args.source_id !== undefined && !(byKey && archiveArg(args.source_id))) return refused('source_id goes with a chosen key.', 'invalid_params');
  const byRequest = keys.length === 1 && keys[0] === 'request_id' && archiveArg(args.request_id);
  const answers = [args.confirm_account, args.keep_apart];
  if (!byKey && !byRequest) return refused('Give the chosen key or a request id.', 'invalid_params');
  if (answers.some((value) => value !== undefined && value !== true) || answers.filter((value) => value === true).length > 1) {
    return refused('Say either confirm_account or keep_apart, as true.', 'invalid_params');
  }
  const answer = await archiveRoute(options, 'approve', args, context);
  if (!answer.ok) return answer.result;
  const status = answer.parsed.status;
  if (status !== 'started' && status !== 'checking' && status !== 'already_imported' && status !== 'confirm_account') {
    return refused('Olympus could not do that. Try again.', 'internal');
  }
  const name = typeof answer.parsed.name === 'string' ? answer.parsed.name : '';
  const archiveName = typeof answer.parsed.archive_name === 'string' ? answer.parsed.archive_name : '';
  const source = answer.parsed.source && typeof answer.parsed.source === 'object' ? answer.parsed.source as { id?: unknown; label?: unknown } : undefined;
  const sourceId = typeof source?.id === 'string' ? source.id : '';
  const sourceLabel = typeof source?.label === 'string' ? source.label : '';
  return {
    content: [{
      type: 'text',
      text: status === 'started' ? 'Importing.' : status === 'checking' ? 'Checking.' : status === 'confirm_account' ? 'Waiting for which account.' : 'Already imported.',
    }],
    structuredContent: {
      status,
      name,
      ...(archiveName ? { archive_name: archiveName } : {}),
      ...(status === 'confirm_account' && sourceId ? { source: { id: sourceId, label: sourceLabel } } : {}),
      ...(status === 'confirm_account' && answer.parsed.reconfirm === true ? { reconfirm: true } : {}),
    },
  };
}

/** Decline an agent's request, or dismiss a finished check. */
async function archiveDecline(options: DashboardPanelToolsOptions, args: Record<string, unknown>, context: DashboardPanelCallContext): Promise<ChatGptToolResult> {
  const keys = Object.keys(args);
  if (keys.length !== 1 || keys[0] !== 'request_id' || !archiveArg(args.request_id)) return refused('request_id is required.', 'invalid_params');
  const answer = await archiveRoute(options, 'decline', args, context);
  if (!answer.ok) return answer.result;
  return { content: [{ type: 'text', text: 'Declined.' }], structuredContent: { status: 'declined' } };
}

/**
 * Remove one imported archive (`archive_id`), or approve an agent's request to
 * remove one (`request_id`): the panel's confirm is the acknowledgement the
 * route asks for. Both run the same removal.
 */
async function archiveRemove(options: DashboardPanelToolsOptions, args: Record<string, unknown>, context: DashboardPanelCallContext): Promise<ChatGptToolResult> {
  const keys = Object.keys(args);
  const byArchive = keys.length === 1 && keys[0] === 'archive_id' && archiveArg(args.archive_id);
  const byRequest = keys.length === 1 && keys[0] === 'request_id' && archiveArg(args.request_id);
  if (!byArchive && !byRequest) return refused('Give an archive id or a request id.', 'invalid_params');
  const answer = await archiveRoute(options, 'remove', { ...(byArchive ? { archive_id: args.archive_id } : { request_id: args.request_id }), acknowledge: true }, context);
  if (!answer.ok) return answer.result;
  return { content: [{ type: 'text', text: 'Removing.' }], structuredContent: { status: 'removing' } };
}

/** Stop one import that is an input of a source: what it imported stays. */
async function archiveStop(options: DashboardPanelToolsOptions, args: Record<string, unknown>, context: DashboardPanelCallContext): Promise<ChatGptToolResult> {
  const keys = Object.keys(args);
  if (keys.length !== 1 || keys[0] !== 'archive_id' || !archiveArg(args.archive_id)) return refused('archive_id is required.', 'invalid_params');
  const answer = await archiveRoute(options, 'stop', args, context);
  if (!answer.ok) return answer.result;
  return { content: [{ type: 'text', text: 'Stopped.' }], structuredContent: { status: 'stopped' } };
}

/** The cards that import their own exports, or undefined when none does: Import another archive is then the only way in. */
function archiveSourcesMeta(options: DashboardPanelToolsOptions): ComputerArchiveSourceMeta[] | undefined {
  try {
    const sources = options.archiveSources?.();
    return sources && sources.length > 0 ? sources : undefined;
  } catch {
    return undefined;
  }
}

/** The imports that joined a source, or undefined when they cannot be read: a card then shows without them. */
function sourceImportsMeta(options: DashboardPanelToolsOptions): ComputerSourceImportsMeta[] | undefined {
  try {
    const imports = options.sourceImports?.();
    return imports && imports.length > 0 ? imports : undefined;
  } catch {
    return undefined;
  }
}

/** The Archives row's list, or undefined when it cannot be read: the row then shows the card alone. */
function archivesMeta(options: DashboardPanelToolsOptions): ComputerArchivesMeta | undefined {
  try {
    return options.archives?.();
  } catch {
    return undefined;
  }
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
    const [label] = unreadableNames([file.parent?.label]);
    return name
      ? [{
          name,
          ...(file.token ? { token: file.token } : {}),
          ...(file.parent ? { parent: { ...(label ? { label } : {}), route: file.parent.route } } : {}),
        }]
      : [];
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

/** The waiting count, or 0 when it cannot be read: the line is a nudge, never a failure. */
function waitingCount(options: DashboardPanelToolsOptions): number {
  try {
    const count = options.waitingPrivateQuestions?.() ?? 0;
    return Number.isInteger(count) && count > 0 ? count : 0;
  } catch {
    return 0;
  }
}

export function createDashboardPanelTools(options: DashboardPanelToolsOptions): DashboardPanelTools {
  const allowed = new Set(COMPUTER_HOST_TOOL_NAMES);
  const privacyConfirmationScope = {};
  return {
    allows: (name) => allowed.has(name),
    async call(name, args, context) {
      if (!allowed.has(name)) return refused('This tool is not available here.', 'unknown_tool');
      if (name === INDEX_FASTER_TOOL_NAME) return await indexFaster(options, args);
      if (name === UNPAIR_SOURCE_TOOL_NAME) return await unpairSource(options, args);
      if (name === OPEN_UNREADABLE_FILE_TOOL_NAME) return await openUnreadableFile(options, args, context);
      if (name === UNREADABLE_FILES_PAGE_TOOL_NAME) return await unreadableFilesPage(options, args, context);
      if (name === ARCHIVE_BROWSE_TOOL_NAME) return await archiveBrowse(options, args, context);
      if (name === ARCHIVE_APPROVE_TOOL_NAME) return await archiveApprove(options, args, context);
      if (name === ARCHIVE_DECLINE_TOOL_NAME) return await archiveDecline(options, args, context);
      if (name === ARCHIVE_REMOVE_TOOL_NAME) return await archiveRemove(options, args, context);
      if (name === ARCHIVE_STOP_TOOL_NAME) return await archiveStop(options, args, context);
      const signal = context.signal ?? new AbortController().signal;
      const base = options.surface();
      // Keep the view the dashboard result is built from, for Unpair's entries.
      let view: SourceDashboardViewModel | undefined;
      const surface = {
        ...base,
        setup: computerSetup(options, context, privacyConfirmationScope),
        dashboardView: async (viewSignal?: AbortSignal) => (view = await base.dashboardView(viewSignal)),
      };
      const result = await callChatGptTool(name, args, options.makeContext(signal), surface, signal);
      if (name !== DASHBOARD_TOOL_NAME || result.isError) return result;
      const on = await options.indexFasterState().catch(() => undefined);
      const unpair = computerUnpairEntries(view);
      const unreadable = computerUnreadableEntries(view, options.unreadableFiles?.(), context.opener);
      const missingFolders = (view?.sources ?? []).flatMap(source => source.schedule?.missing_folders?.length
        ? [{ sourceId: source.source_id, paths: source.schedule.missing_folders }] : []);
      const permissionSettings = process.platform === 'darwin'
        ? (view?.sources ?? []).flatMap(source => source.schedule?.degraded_reason === 'scope_root_permission_needed'
          ? [{ sourceId: source.source_id, url: FILES_AND_FOLDERS_URL }] : [])
        : [];
      const waiting = context.localSession === true ? waitingCount(options) : 0;
      const archives = archivesMeta(options);
      const sourceImports = sourceImportsMeta(options);
      const archiveSources = archiveSourcesMeta(options);
      if (on === undefined && unpair.length === 0 && unreadable.length === 0 && waiting === 0 && missingFolders.length === 0 && permissionSettings.length === 0 && !archives && !sourceImports && !archiveSources) return result;
      const meta: ComputerDashboardMeta = {
        ...(missingFolders.length ? { missingFolders } : {}),
        ...(permissionSettings.length ? { permissionSettings } : {}),
        ...(on !== undefined ? { indexFaster: { on } } : {}),
        ...(unpair.length > 0 ? { unpair } : {}),
        ...(unreadable.length > 0 ? { unreadable } : {}),
        ...(waiting > 0 ? { waitingPrivateQuestions: waiting } : {}),
        ...(archives ? { archives } : {}),
        ...(sourceImports ? { sourceImports } : {}),
        ...(archiveSources ? { archiveSources } : {}),
      };
      const existing = result._meta && typeof result._meta === 'object' ? result._meta as Record<string, unknown> : {};
      return { ...result, _meta: { ...existing, [COMPUTER_META_KEY]: meta } };
    },
  };
}
