/**
 * The ChatGPT dashboard's in-page program.
 *
 * `chatgptDashboardClient` is never called on the server: the page inlines its
 * source text (`Function.prototype.toString`) and calls it in the sandboxed
 * iframe with a JSON config. So it must stay self-contained — no imports, no
 * references to anything outside its own body — and it builds every node with
 * `textContent`, never HTML strings, so nothing from the view model can turn
 * into markup.
 *
 * Transport: the MCP Apps bridge (JSON-RPC over postMessage to the host) for
 * `ui/initialize`, tool results and `tools/call`; `window.openai` is optional
 * and only feature-detected. The sandbox blocks confirm() and the clipboard,
 * so a destructive fix confirms inline and help is selectable text.
 */
import type { DashboardStatus } from '../vocabulary.ts';
import type { ChatGptArchivePicked, ChatGptPicker, ChatGptPickerConfig, ChatGptPickerKit } from './picker.ts';
import type { ChatGptPrivacy, ChatGptPrivacyConfig, ChatGptPrivacyKit } from './privacy.ts';
import type {
  DashboardViewModelV1,
  ModelInstall,
  ModelInstallFailedReason,
  ModelInstallState,
} from '../../chatgpt/dashboard-contract.ts';
import type {
  DASHBOARD_CHATGPT_CONNECTION_COPY,
  DASHBOARD_CHATGPT_PAGE_COPY,
  DASHBOARD_COMPUTER_PANEL_COPY,
  DashboardStatusColorToken,
} from '../vocabulary.ts';

export interface ChatGptDashboardClientConfig {
  toolName: string;
  /**
   * Sync now's tool (olympus_sync_source). It answers at once; the row says
   * "Checking …" until the dashboard's `lastManualSync` carries the result.
   */
  syncTool: string;
  /** Delete indexed data (olympus_delete_source_data): a disconnected source's indexed data, after a confirmation. */
  deleteDataTool: string;
  /** Disconnect (olympus_disconnect_source); its confirmation says the indexed data stays. */
  disconnectTool: string;
  /**
   * The Archives card's source id: shown in its own section below Sources
   * (Other archives), for exports that are not from one of the sources above.
   */
  archivesSourceId: string;
  connection: typeof DASHBOARD_CHATGPT_CONNECTION_COPY;
  page: typeof DASHBOARD_CHATGPT_PAGE_COPY;
  statusTone: Record<DashboardStatus, DashboardStatusColorToken>;
  /** No tool result within this long means the relay cannot reach the Mac. */
  resultTimeoutMs: number;
  staleAfterMs: number;
  /**
   * Re-reading the dashboard while the page is visible: every `activeMs`
   * while something is moving (a source working or signing in, setup
   * unfinished, the Mac unreachable), every `idleMs` otherwise, doubling
   * after each failure up to `maxBackoffMs`. The "Updated … ago" line is
   * redrawn every `staleTickMs` even when nothing new arrives. After Delete
   * indexed data ran, the page re-reads every `settleMs` (for at most
   * `settleForMs`) until the row stops offering it.
   */
  refresh: { activeMs: number; idleMs: number; maxBackoffMs: number; staleTickMs: number; settleMs: number; settleForMs: number };
  /** The in-place Connect flow and folder/mail pickers (picker.ts). */
  picker: ChatGptPickerConfig;
  /** The privacy setup screen and the dashboard's Privacy row (privacy.ts). */
  privacy: ChatGptPrivacyConfig;
  /** Tool error codes whose fixed sentence is shown beside the control that ran the tool. */
  inlineErrorCodes: readonly string[];
  /**
   * An Olympus host (the computer's /dashboard, the OpenClaw Control UI tab)
   * adds `hostContext[hostContextKey]` (dashboard-contract.ts
   * OlympusHostContext). ChatGPT never sends it, so none of this applies there.
   */
  host: {
    contextKey: string;
    /** The computer-only `_meta` key on a dashboard result (ComputerDashboardMeta). */
    computerMetaKey: string;
    indexFasterTool: string;
    /** Unpair for a paired chat app, offered in its ⋯ menu on the computer only. */
    unpairTool: string;
    /** Opens one unreadable file (`{token}` from the computer meta), on the computer only. */
    unreadableOpenTool: string;
    /** The next page of one source's unreadable files (`{source_id, after}`), on the computer only. */
    unreadablePageTool: string;
    /**
     * The Archives row's own controls, on the computer only: import an agent's
     * request (`{request_id}`), decline or dismiss one, remove an archive
     * (`{archive_id}`). Choosing a new one is the picker's (picker.ts).
     */
    archiveApproveTool: string;
    archiveDeclineTool: string;
    archiveRemoveTool: string;
    /** Stops an import that is an input of a source (`{archive_id}`): what it imported stays. */
    archiveStopTool: string;
    /** How long the place an open link landed on stays outlined (`.landed`). */
    landedMs: number;
    copy: typeof DASHBOARD_COMPUTER_PANEL_COPY;
  };
}

// Loose shapes: the page validates what it reads instead of trusting a type.
/* eslint-disable @typescript-eslint/no-explicit-any */
type Any = any;

type DashboardModels = DashboardViewModelV1['models'];

/** What the last failed dashboard read got back (the unreachable banner's See why). */
interface RelayFailure {
  kind: 'no_answer' | 'error' | 'unreadable' | 'host';
  /** `error`: Olympus's own fixed sentence; `host`: the chat app's error message. Capped. */
  text?: string;
  at: number;
}

const RELAY_FAILURE_TEXT_MAX = 300;

/** One model's install line, read off the view model and validated (the values crossed the wire). */
interface ModelInstallLine {
  which: 'search' | 'answers' | 'transcription';
  state: Exclude<ModelInstallState, 'ready'>;
  /** -1 when unknown. */
  percent: number;
  done: number;
  total: number;
  reason: ModelInstallFailedReason;
}

export function chatgptDashboardClient(
  config: ChatGptDashboardClientConfig,
  pickerProgram?: (kit: ChatGptPickerKit) => ChatGptPicker,
  privacyProgram?: (kit: ChatGptPrivacyKit) => ChatGptPrivacy,
): void {
  const doc = document;
  const root = doc.getElementById('app') as HTMLElement;
  const P = config.page;
  const C = config.connection;
  const GLOBAL_STATES = ['not_connected', 'installing', 'mac_offline', 'relay_unavailable'];

  const state: {
    data: Any;
    relayDown: boolean;
    busy: string;
    confirming: string;
    helpOpen: boolean;
    theme: string;
    displayMode: string;
    canFullscreen: boolean;
    open: Record<string, boolean>;
    /** One line after the picker closes ("Dropbox: saved…"); never folder or label names. */
    notice: string;
    /** How many always-private rules the last privacy load or save returned (a count, never names); -1 unknown. */
    privacyRules: number;
    /** The fixed sentence of the last action's error, beside the control with this key. */
    actionError: { key: string; text: string } | null;
    /** Sources whose Sync now was pressed and whose `checking` the page has not read back yet. */
    syncPressed: Record<string, boolean>;
    /** '' in ChatGPT; `computer` or `openclaw` inside an Olympus host. */
    hostKind: string;
    /** The local dashboard controls are locked (computer host only). */
    hostReadOnly: boolean;
    /** The local pages the computer host offers, by row key: exact URLs the host gave. */
    hostLinks: Record<string, string>;
    /** The computer-only facts from the last dashboard result (`_meta[computerMetaKey]`). */
    computerMeta: Any;
    /** Computer only: further pages of a source's unreadable files read since the last dashboard result. */
    unreadablePages: Record<string, { files: Array<{ name: string; token?: string }>; more: number; after: string }>;
    /** Computer only: an agent's request whose export did not prove its account, by request id, until the person answers. */
    archiveConfirm: Record<string, { source: string; reconfirm?: boolean }>;
    /** Computer only: the source an open link asked to land on, until the panel has landed there. */
    landing: string;
    /** The source row outlined after landing, until `until` (ms). */
    landed: { id: string; until: number } | null;
    /** What the last failed read got back, for the unreachable banner's See why. */
    lastFailure: RelayFailure | null;
    /** Sources whose Delete indexed data ran: source id to when to stop waiting for the row to settle. */
    deleting: Record<string, number>;
  } = {
    data: null,
    relayDown: false,
    deleting: {},
    busy: '',
    confirming: '',
    helpOpen: false,
    theme: '',
    displayMode: '',
    canFullscreen: true,
    open: {},
    notice: '',
    privacyRules: -1,
    actionError: null,
    syncPressed: {},
    hostKind: '',
    hostReadOnly: false,
    hostLinks: {},
    computerMeta: null,
    // Agent requests whose export did not prove its account: asked in the request's own row, by request id.
    archiveConfirm: {},
    unreadablePages: {},
    landing: '',
    landed: null,
    lastFailure: null,
  };
  const H = config.host;

  // ---- host bridge -------------------------------------------------------
  let nextId = 1;
  const pending: Record<number, { resolve: (value: Any) => void; reject: (error: Any) => void; timer: Any }> = {};

  function post(message: Any): void {
    if (window.parent && window.parent !== window) window.parent.postMessage(message, '*');
  }
  function request(method: string, params: Any, timeoutMs?: number): Promise<Any> {
    const id = nextId++;
    post({ jsonrpc: '2.0', id, method, params: params || {} });
    return new Promise((resolve, reject) => {
      const timer = timeoutMs ? setTimeout(() => {
        delete pending[id];
        reject(new Error('timeout'));
      }, timeoutMs) : null;
      pending[id] = { resolve, reject, timer };
    });
  }
  function notify(method: string, params?: Any): void {
    post({ jsonrpc: '2.0', method, params: params || {} });
  }
  function openai(): Any {
    return (window as Any).openai || null;
  }

  window.addEventListener('message', (event: MessageEvent) => {
    if (event.source !== window.parent) return;
    const message = event.data;
    if (!message || message.jsonrpc !== '2.0') return;
    if (message.id !== undefined && pending[message.id]) {
      const entry = pending[message.id]!;
      delete pending[message.id];
      if (entry.timer) clearTimeout(entry.timer);
      if (message.error) entry.reject(message.error);
      else entry.resolve(message.result);
      return;
    }
    if (message.method === 'ui/notifications/tool-result') {
      // The host's result is the newest word: anything requested before it is stale.
      supersede();
      acceptResult(message.params, true);
    }
    else if (message.method === 'ui/notifications/host-context-changed') applyHostContext(message.params);
  });

  function applyHostContext(context: Any): void {
    if (!context || typeof context !== 'object') return;
    applyOlympusHost(context[H.contextKey]);
    if (context.theme === 'light' || context.theme === 'dark') state.theme = context.theme;
    if (typeof context.displayMode === 'string') state.displayMode = context.displayMode;
    if (Array.isArray(context.availableDisplayModes)) {
      state.canFullscreen = context.availableDisplayModes.indexOf('fullscreen') >= 0;
    }
    render();
  }

  /** An Olympus host's own facts (OlympusHostContext); anything malformed is ignored. */
  function applyOlympusHost(value: Any): void {
    if (!value || typeof value !== 'object') return;
    if (value.kind !== 'computer' && value.kind !== 'openclaw') return;
    state.hostKind = value.kind;
    state.hostReadOnly = value.readOnly === true;
    const links: Record<string, string> = {};
    const given = value.links && typeof value.links === 'object' ? value.links : {};
    for (const key of ['keys', 'agents', 'privateAnswers', 'connector']) {
      const href = given[key];
      if (typeof href === 'string' && /^https?:\/\//.test(href)) links[key] = href;
    }
    state.hostLinks = value.kind === 'computer' ? links : {};
    // Said once, in the first answer: See why on one source (core/open-targets.ts unreadable/<source>).
    const landing = value.landing;
    if (value.kind === 'computer' && landing && typeof landing.sourceId === 'string' && /^[a-z0-9_.]{1,64}$/.test(landing.sourceId)) {
      state.landing = landing.sourceId;
    }
  }

  /** The panel runs on the computer itself (the local /dashboard). */
  function onComputer(): boolean {
    return state.hostKind === 'computer';
  }

  function readOpenAiGlobals(): void {
    const host = openai();
    if (!host) return;
    if (host.theme === 'light' || host.theme === 'dark') state.theme = host.theme;
    if (typeof host.displayMode === 'string') state.displayMode = host.displayMode;
    if (host.toolOutput && isDashboard(host.toolOutput) && host.toolOutput !== state.data) {
      state.data = host.toolOutput;
      state.relayDown = false;
    }
  }
  window.addEventListener('openai:set_globals', () => {
    readOpenAiGlobals();
    render();
  });

  // ---- data --------------------------------------------------------------
  let resultTimer: Any = null;
  function waitForResult(): void {
    if (resultTimer) clearTimeout(resultTimer);
    resultTimer = setTimeout(() => {
      resultTimer = null;
      if (!state.data) {
        relayFailed({ kind: 'no_answer' });
        render();
      }
    }, config.resultTimeoutMs);
  }

  /**
   * The relay or the computer did not give a dashboard: the banner says so,
   * and its See why says what came back instead (owner rule, 2026-10-10).
   */
  function relayFailed(failure: Omit<RelayFailure, 'at'>): void {
    state.relayDown = true;
    state.lastFailure = { ...failure, at: Date.now() };
  }

  /** A tool error result's own fixed sentence (it names its log reference when it has one). */
  function resultFailure(result: Any): Omit<RelayFailure, 'at'> {
    if (!result || !result.isError) return { kind: 'unreadable' };
    const parts = Array.isArray(result.content) ? result.content : [];
    const said = parts.filter((part: Any) => part && part.type === 'text' && typeof part.text === 'string')[0];
    const text = said ? String(said.text).slice(0, RELAY_FAILURE_TEXT_MAX) : '';
    return text ? { kind: 'error', text } : { kind: 'unreadable' };
  }

  /** A rejected request: our own timeout, or the host's JSON-RPC error message (capped). */
  function rejectionFailure(error: Any): Omit<RelayFailure, 'at'> {
    if (error instanceof Error && error.message === 'timeout') return { kind: 'no_answer' };
    const message = error && typeof error.message === 'string' ? error.message.replace(/\s+/g, ' ').trim().slice(0, RELAY_FAILURE_TEXT_MAX) : '';
    return message ? { kind: 'host', text: message } : { kind: 'unreadable' };
  }

  function isDashboard(value: Any): boolean {
    return !!value && typeof value === 'object' && value.v === 1
      && !!value.connection && typeof value.connection.state === 'string';
  }

  // ---- generations -------------------------------------------------------
  // Every dashboard request remembers the generation it was sent in. An
  // interaction (Connect, a picker, Privacy, a confirmation, a control's own
  // call) or a newer authoritative result starts a new generation, and a
  // response from an older one is dropped, so a slow background read can
  // never undo what the person just did.
  let generation = 0;
  function supersede(): number {
    return ++generation;
  }

  /** The picker or the Privacy screen is open: data is kept but the editor is never redrawn under the person. */
  function editorOpen(): boolean {
    return (!!picker && picker.active()) || (!!privacy && privacy.active());
  }
  function redraw(): void {
    if (!editorOpen()) render();
  }

  /** A tool result: render it when it is the dashboard, else fetch the dashboard. */
  function acceptResult(result: Any, fromHost: boolean): boolean {
    if (resultTimer) {
      clearTimeout(resultTimer);
      resultTimer = null;
    }
    if (!result || result.isError) {
      relayFailed(resultFailure(result));
      redraw();
      return false;
    }
    const content = result.structuredContent;
    if (isDashboard(content)) {
      state.data = content;
      const meta = result._meta && typeof result._meta === 'object' ? result._meta[H.computerMetaKey] : null;
      state.computerMeta = meta && typeof meta === 'object' ? meta : null;
      // A fresh list starts from its first page (its tokens are new too).
      state.unreadablePages = {};
      state.relayDown = false;
      settleDeleting(content);
      // The engine's own `lastManualSync` now says whether a press is still checking.
      if (!state.busy) state.syncPressed = {};
      // Any good dashboard, from any path, ends a failure streak.
      refreshFailures = 0;
      redraw();
      // Fresh data from any path restarts the periodic wait from now.
      if (!refreshing) scheduleRefresh();
      return true;
    }
    if (fromHost) {
      relayFailed({ kind: 'unreadable' });
      redraw();
    }
    return false;
  }

  /** The fixed sentence of a tool error the page shows inline, or ''. */
  function inlineError(result: Any, name?: string): string {
    if (!result || !result.isError) return '';
    const code = result.structuredContent && typeof result.structuredContent.error === 'string' ? result.structuredContent.error : '';
    // Unpair's refusals, opening a file and the Archives row's controls are the computer's own sentences: always beside the control.
    if (config.inlineErrorCodes.indexOf(code) < 0 && !(name && (name === H.unpairTool || name === H.unreadableOpenTool || name === H.unreadablePageTool
      || name === H.archiveApproveTool || name === H.archiveDeclineTool || name === H.archiveRemoveTool || name === H.archiveStopTool))) return '';
    const parts = Array.isArray(result.content) ? result.content : [];
    const text = parts.filter((part: Any) => part && part.type === 'text' && typeof part.text === 'string')[0];
    return text ? String(text.text) : '';
  }

  function callTool(name: string, args: Any, key: string): void {
    const mine = supersede();
    state.busy = key;
    state.confirming = '';
    state.notice = '';
    state.actionError = null;
    render();
    request('tools/call', { name, arguments: args || {} }, config.resultTimeoutMs).then((result) => {
      if (state.busy === key) state.busy = '';
      if (mine !== generation) {
        redraw();
        return;
      }
      const failed = inlineError(result, name);
      if (failed) {
        if (name === config.syncTool) {
          state.syncPressed = {};
          // Pressed from the ⋯ menu, which closed: open it again so the reason shows beside Sync now.
          if (key.indexOf('menu:') === 0) state.open[key.slice(0, key.lastIndexOf(':'))] = true;
        }
        state.actionError = { key, text: failed };
        render(key);
        return;
      }
      if (name === H.unreadableOpenTool) {
        // The engine opened the file's copy on this computer, or answers the
        // file's own web page for this page to open. The token is spent:
        // read the list again for fresh ones.
        const url = result && result.structuredContent ? result.structuredContent.url : '';
        if (typeof url === 'string' && url) openLink(url);
        refresh();
        return;
      }
      if (name === H.unreadablePageTool) {
        // The next page of the list: appended under the files already shown.
        const page = result && result.structuredContent;
        if (page && page.status === 'listed' && typeof page.source_id === 'string' && Array.isArray(page.files)) {
          const prior = state.unreadablePages[page.source_id];
          state.unreadablePages[page.source_id] = {
            files: (prior ? prior.files : []).concat(unreadableEntries(page.files)),
            more: moreCount(page.more),
            after: cursorOf(page.after),
          };
        }
        redraw();
        return;
      }
      // A failed delete falls through to acceptResult, which shows the error;
      // only a result that is not an error reads as deleted (PR #455 review).
      if (name === config.deleteDataTool && !(result && result.isError)) {
        // Deleted: the row reads as a source with no data once the engine
        // has reopened its stores (it restarts; the page re-reads until it
        // answers). The brief result line stays until the next action.
        // The engine restarts right after it answers, so this read can still
        // come from the old process: keep re-reading until the row settles.
        const deletedId = args && typeof args.source_id === 'string' ? args.source_id : '';
        if (deletedId) state.deleting[deletedId] = Date.now() + R.settleForMs;
        refresh();
        // If that read fails or times out (the restart overlap), nothing else
        // replaces the idle timer: start the settle cadence now.
        scheduleRefresh();
        state.notice = P.deleteDataDone;
        redraw();
        return;
      }
      if ((name === H.archiveApproveTool || name === H.archiveDeclineTool || name === H.archiveRemoveTool || name === H.archiveStopTool) && result && !result.isError) {
        // The Archives row says what it did; the list itself arrives with the read.
        const said = archiveNotice(name, args, result);
        refresh();
        // refresh() clears the notice as it starts; the read's answer leaves it.
        state.notice = said;
        redraw();
        return;
      }
      if (name === H.unpairTool) {
        // Unpair says what it did, an incomplete removal included: keep its words on the page.
        const parts = result && Array.isArray(result.content) ? result.content : [];
        const said = parts.filter((part: Any) => part && part.type === 'text' && typeof part.text === 'string')[0];
        refresh();
        // refresh() clears the notice as it starts; the read's answer leaves it.
        state.notice = said ? String(said.text) : '';
        redraw();
        return;
      }
      if (acceptResult(result, false)) return;
      if (!state.relayDown && name !== config.toolName) refresh();
    }, (error: Any) => {
      if (state.busy === key) state.busy = '';
      if (name === config.syncTool) state.syncPressed = {};
      if (mine === generation) relayFailed(rejectionFailure(error));
      redraw();
    });
  }

  function refresh(): void {
    callTool(config.toolName, {}, 'refresh');
  }

  /** A tools/call whose result the caller handles (the picker's own tools). */
  function callRaw(name: string, args: Any): Promise<Any> {
    return request('tools/call', { name, arguments: args || {} }, config.resultTimeoutMs);
  }

  function openLink(href: string): void {
    if (typeof href !== 'string') return;
    // Only https, or one of the exact local pages the computer host offered.
    const hostLink = Object.keys(state.hostLinks).some((key) => state.hostLinks[key] === href);
    if (href.slice(0, 6) !== 'https:' && !hostLink) return;
    const host = openai();
    if (host && typeof host.openExternal === 'function') host.openExternal({ href });
    else request('ui/open-link', { url: href }).then(() => undefined, () => undefined);
  }

  function goFullscreen(): void {
    const host = openai();
    if (host && typeof host.requestDisplayMode === 'function') host.requestDisplayMode({ mode: 'fullscreen' });
    else request('ui/request-display-mode', { mode: 'fullscreen' }).then(() => undefined, () => undefined);
  }

  // ---- words -------------------------------------------------------------
  function fill(template: string, values: Record<string, string | number>): string {
    let out = template;
    for (const key of Object.keys(values)) out = out.split('{' + key + '}').join(String(values[key]));
    return out;
  }
  function count(value: number): string {
    return Math.max(0, Math.round(value)).toLocaleString('en-US');
  }
  function unitWord(unit: string, n: number): string {
    const words = (P.units as Any)[unit] || P.units.items;
    return n === 1 ? words.one : words.many;
  }
  function ago(iso: string): string {
    const at = Date.parse(iso);
    if (!isFinite(at)) return '';
    const minutes = Math.floor(Math.max(0, Date.now() - at) / 60000);
    if (minutes < 1) return P.justNow;
    if (minutes < 60) return fill(P.minutesAgo, { n: minutes });
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return fill(P.hoursAgo, { n: hours });
    const days = Math.floor(hours / 24);
    return days === 1 ? P.dayAgo : fill(P.daysAgo, { n: days });
  }
  function duration(seconds: number): string {
    const minutes = Math.round(seconds / 60);
    if (minutes < 1) return P.durationLessThanMinute;
    if (minutes < 60) return fill(P.durationMinutes, { n: minutes });
    const hours = Math.floor(minutes / 60);
    if (hours < 24) {
      const rest = minutes % 60;
      return rest ? fill(P.durationHoursMinutes, { h: hours, m: rest }) : fill(P.durationHours, { n: hours });
    }
    return fill(P.durationDays, { n: Math.round(hours / 24) });
  }
  function percent(value: number): string {
    const n = Math.max(0, Math.min(100, Number(value) || 0));
    return String(Math.floor(n));
  }

  // ---- DOM helpers -------------------------------------------------------
  function icon(glyph: string): HTMLElement {
    const node = el('span', 'icon', glyph);
    node.setAttribute('aria-hidden', 'true');
    return node;
  }
  function el(tag: string, cls?: string, text?: string): HTMLElement {
    const node = doc.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined) node.textContent = text;
    return node;
  }
  function add(parent: HTMLElement, ...children: Array<Node | null | undefined | false>): HTMLElement {
    for (const child of children) if (child) parent.appendChild(child);
    return parent;
  }
  let accentUsed = false;
  function button(label: string, key: string, onClick: (() => void) | null, style: 'main' | 'plain' | 'danger' | 'warn'): HTMLButtonElement {
    const node = el('button', 'btn', label) as HTMLButtonElement;
    node.type = 'button';
    node.setAttribute('data-key', key);
    if (style === 'danger') node.className = 'btn danger';
    // A Needs-you fix: filled orange, and never the page's one accent.
    else if (style === 'warn' && onClick) node.className = 'btn warnfill';
    else if (style === 'main' && onClick && !accentUsed) {
      node.className = 'btn primary';
      accentUsed = true;
    }
    if (onClick) node.addEventListener('click', onClick);
    else node.disabled = true;
    return node;
  }
  function progressBar(value: number, label: string): HTMLElement {
    const bar = el('div', 'bar');
    bar.setAttribute('role', 'progressbar');
    bar.setAttribute('aria-valuemin', '0');
    bar.setAttribute('aria-valuemax', '100');
    bar.setAttribute('aria-valuenow', percent(value));
    bar.setAttribute('aria-label', label);
    const fillNode = el('div', 'bar-fill');
    fillNode.style.width = percent(value) + '%';
    return add(bar, fillNode);
  }
  function details(key: string, summary: Node, cls: string): HTMLDetailsElement {
    const node = el('details', cls) as HTMLDetailsElement;
    node.setAttribute('data-open-key', key);
    if (state.open[key]) node.open = true;
    node.addEventListener('toggle', () => {
      state.open[key] = node.open;
      reportHeight();
    });
    const head = el('summary');
    head.setAttribute('data-key', 'summary:' + key);
    add(head, summary);
    return add(node, head) as HTMLDetailsElement;
  }

  // ---- state helpers -----------------------------------------------------
  function connectionState(): string {
    if (state.relayDown) return 'relay_unavailable';
    const current = state.data ? String(state.data.connection.state) : '';
    // Nothing produces not_installed any more; an old relay's reads as not connected.
    return current === 'not_installed' ? 'not_connected' : current;
  }

  /** A fix's help page, when it is an https page on olympusplugin.ai (the only domain the host opens for us), else ''. */
  function helpHref(href: Any): string {
    if (typeof href !== 'string' || !href) return '';
    let parsed: URL;
    try {
      parsed = new URL(href);
    } catch {
      return '';
    }
    const host = parsed.hostname;
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password) return '';
    return host === 'olympusplugin.ai' || host === 'www.olympusplugin.ai' ? parsed.href : '';
  }

  /**
   * Beside a real problem (a Needs you item, the blocker) the help link says
   * "Fix this on your computer"; anywhere else nothing is broken, the control
   * only works on the computer: "Do this on your computer".
   */
  function howWords(key: string): string {
    return key === 'blocker' || key.indexOf('need:') === 0 ? P.howOnComputerFix : P.howOnComputer;
  }

  /** The fix's open page, beside its control (not on the inline card). */
  function howLink(fix: Any, key: string, source?: { id: string; label: string }): HTMLElement | null {
    const href = helpHref(fix && fix.href);
    if (!href || compact()) return null;
    if (remoteMode()) {
      // Remote mode: the same words open the tunnel instructions in place.
      const toggle = button(howWords(key), key + ':how', () => toggleRemote(key), 'plain');
      toggle.className = 'btn link';
      toggle.setAttribute('aria-expanded', state.open['remote:' + key] ? 'true' : 'false');
      const wrap = add(el('span', 'fix'), toggle);
      return add(wrap, remoteBox(key, href, source));
    }
    const link = button(howWords(key), key + ':how', () => openLink(href), 'plain');
    link.className = 'btn link';
    return link;
  }

  // ---- remote mode (the engine runs on a server) ----------------------------
  /**
   * The engine declared it runs on a server (`remote` in the view model), and
   * this panel is not on that server's own dashboard: a "do this on your
   * computer" control then shows how to open Olympus on the owner's computer
   * instead of an olympus:// page, which cannot reach the server.
   */
  function remoteMode(): boolean {
    if (onComputer()) return false;
    const remote = state.data ? state.data.remote : null;
    return !!remote && typeof remote.port === 'number' && remote.port >= 1 && remote.port <= 65535 && Math.floor(remote.port) === remote.port;
  }
  function toggleRemote(key: string): void {
    state.open['remote:' + key] = !state.open['remote:' + key];
    render(key);
  }
  /** `connect/x`, `fix/models` from an olympusplugin.ai /open/ page; '' for anything else. */
  function openPath(href: string): string {
    const match = /^https:\/\/(?:www\.)?olympusplugin\.ai\/open\/((?:connect|fix|unreadable)\/[a-z]+)\/$/.exec(href);
    return match ? match[1]! : '';
  }
  /**
   * The two by-hand lines, exactly as core/remote-open.ts remoteOpenInstructions
   * writes them (test/remote-open.test.ts holds the two equal): the tunnel on
   * the engine's own port number, and a fresh one-time link from the server.
   */
  function remoteLines(href: string): { onComputer: string; onServer: string; port: number } {
    const remote = state.data.remote;
    const port = remote.port as number;
    const target = typeof remote.sshTarget === 'string' && /^(?:[A-Za-z0-9][A-Za-z0-9._-]{0,63}@)?[A-Za-z0-9][A-Za-z0-9.-]{0,190}$/.test(remote.sshTarget)
      ? remote.sshTarget
      : 'you@your-server';
    const path = openPath(href);
    return {
      onComputer: typeof remote.socketPath === 'string' && /^\/[A-Za-z0-9_./-]+\/olympus\/worker\.sock$/.test(remote.socketPath) && !remote.socketPath.split('/').some((part: string) => part === '..' || part === '.')
        ? 'ssh -N -o ExitOnForwardFailure=yes -L 127.0.0.1:' + port + ':' + remote.socketPath + ' ' + target
        : 'ssh -N -L ' + port + ':127.0.0.1:' + port + ' ' + target,
      onServer: 'olympus dashboard --no-open' + (path ? ' --target ' + path : ''),
      port,
    };
  }
  /**
   * Copy: select the line and ask the browser to copy the selection. ChatGPT's
   * sandbox may refuse (it blocks the clipboard API, which this page never
   * touches); then the line stays selected and the button says to press the
   * copy keys.
   */
  function copyControl(code: HTMLElement, key: string): HTMLElement {
    const R = P.remote;
    const node = button(R.copy, key, () => {
      let copied = false;
      try {
        const selection = window.getSelection();
        if (selection) {
          const range = doc.createRange();
          range.selectNodeContents(code);
          selection.removeAllRanges();
          selection.addRange(range);
          copied = typeof doc.execCommand === 'function' && doc.execCommand('copy') === true;
        }
      } catch {
        copied = false;
      }
      node.textContent = copied ? R.copied : R.copySelected;
    }, 'plain');
    return node;
  }
  function copyLine(text: string, key: string): HTMLElement {
    const code = el('code', '', text);
    return add(el('div', 'remote-line'), code, copyControl(code, key));
  }
  /** The remote-mode box under a control, while it is open. */
  function remoteBox(key: string, href: string, source?: { id: string; label: string }): HTMLElement | null {
    if (!state.open['remote:' + key]) return null;
    const R = P.remote;
    const lines = remoteLines(href);
    const box = add(el('div', 'remote-box'), el('p', 'strong', R.title));
    box.setAttribute('role', 'region');
    box.setAttribute('aria-label', R.title);
    if (state.data.remote.agent === true) {
      const phrase = source && openPath(href).indexOf('connect/') === 0 ? fill(R.askPhraseFor, { source: source.label }) : R.askPhrase;
      add(box, el('p', '', R.askLine), copyLine(phrase, key + ':remote:ask'), el('p', 'muted', R.byHandAfterAsk));
    }
    add(
      box,
      el('p', '', R.onComputer),
      copyLine(lines.onComputer, key + ':remote:tunnel'),
      el('p', '', R.onServer),
      copyLine(lines.onServer, key + ':remote:link'),
      el('p', 'muted', fill(R.portNote, { port: lines.port })),
    );
    return box;
  }
  function globalReason(): string {
    // The computer's controls are locked: every control waits for them.
    if (state.hostReadOnly) return state.hostKind === 'openclaw' ? H.copy.readOnlyOpenClaw : H.copy.locked;
    const current = connectionState();
    if (GLOBAL_STATES.indexOf(current) < 0) return '';
    return ((C as Any)[current] || C.relay_unavailable).disabledReason;
  }
  /**
   * The reason beside a disabled control. On the computer's locked page the
   * banner above the panel already says it once, so the controls are only
   * disabled; everywhere else (OpenClaw read-only, a ChatGPT connection state)
   * there is no banner and each control says why.
   */
  function rowReason(text: string): HTMLElement | null {
    if (state.hostReadOnly && state.hostKind === 'computer') return null;
    return el('span', 'reason', text);
  }
  function compact(): boolean {
    return state.displayMode !== '' && state.displayMode !== 'fullscreen';
  }

  /** One fix: a button, or a disabled button with its reason beside it. */
  function fixControl(fix: Any, key: string, style: 'main' | 'plain' | 'warn', allowConfirm: boolean, source?: { id: string; label: string }): HTMLElement {
    const wrap = el('span', 'fix');
    if (!fix || typeof fix.label !== 'string') return wrap;
    const blocked = globalReason();
    if (blocked || fix.disabledReason) {
      add(wrap, button(fix.label, key, null, style), rowReason(blocked || String(fix.disabledReason)));
      // A repair only the computer can make still says how, unless the whole page is waiting.
      if (!blocked) add(wrap, howLink(fix, key, source));
      return wrap;
    }
    if (state.busy === key) {
      const busy = button(P.working, key, null, style);
      busy.setAttribute('aria-busy', 'true');
      return add(wrap, busy);
    }
    const failure = state.actionError && state.actionError.key === key ? state.actionError.text : '';
    let action: (() => void) | null = null;
    const opens = fix.openHref === true ? helpHref(fix.href) : '';
    if (opens && remoteMode()) {
      // Remote mode: the control opens the tunnel instructions in place.
      const toggle = button(fix.label, key, () => toggleRemote(key), style);
      toggle.setAttribute('aria-expanded', state.open['remote:' + key] ? 'true' : 'false');
      return add(wrap, toggle, remoteBox(key, opens, source));
    }
    if (opens) {
      // The control is the link: Connect or Reconnect for a source set up on the computer.
      return add(wrap, button(fix.label, key, () => openLink(opens), style));
    }
    if (privacy && privacy.handles(fix)) {
      // Tell Olympus what's private, and the Privacy row's Edit, open the Privacy screen in place.
      action = () => openPrivacy(key);
    } else if (fix.archiveImport === true && picker) {
      // Import an archive (computer only): the picker over this computer's files, in place; from a
      // source's ⋯ menu, for that source's exports only.
      action = () => startArchivePick(key, typeof fix.archiveSource === 'string' ? fix.archiveSource : '');
    } else if (typeof fix.archiveFocus === 'string' && fix.archiveFocus) {
      // A Needs you line about one archive or request (computer only): straight to it, in place.
      action = () => focusArchive(String(fix.archiveFocus));
    } else if (fix.archiveModels === true) {
      // Held items (computer only): the private model under Models, in place.
      action = () => {
        state.open.models = true;
        render('summary:models');
      };
    } else if (picker && picker.handles(fix)) {
      // Connect, Choose folders and Choose mail open in place, never as a plain tool call.
      action = () => {
        supersede();
        state.notice = '';
        state.confirming = '';
        picker!.start(fix, source ? source.id : '', source ? source.label : '', key);
      };
    } else if (fix.tool === config.syncTool && source) {
      // Sync now: "Checking…" on the row at once; the sync's result arrives
      // with a later read of the dashboard, never in this call's answer.
      action = () => {
        state.syncPressed[source.id] = true;
        state.open['menu:' + source.id] = false;
        callTool(fix.tool, fix.args || {}, key);
      };
    } else if (typeof fix.tool === 'string' && fix.tool) action = () => callTool(fix.tool, fix.args || {}, key);
    else if (helpHref(fix.href)) {
      // No tool, only a help page: the control is the link to it. In remote
      // mode it shows the tunnel instructions in place: the open page's
      // olympus:// would wake Olympus on this computer, not the server's.
      if (remoteMode()) {
        const toggle = button(howWords(key), key, () => toggleRemote(key), style);
        toggle.setAttribute('aria-expanded', state.open['remote:' + key] ? 'true' : 'false');
        return add(wrap, toggle, remoteBox(key, helpHref(fix.href), source));
      }
      return add(wrap, button(howWords(key), key, () => openLink(helpHref(fix.href)), style));
    }
    if (fix.destructive && action) {
      if (!allowConfirm) return wrap;
      if (state.confirming === key) {
        const run = action;
        wrap.className = 'fix confirm';
        // Delete and Disconnect say in the source's name what they do and do not touch.
        const sourceWords = source ? String(source.label || '') : '';
        // On the computer, a source with archives imported into it says they go with it: their items are the source's own.
        const importsGo = source && sourceImportsMeta(source.id) ? ' ' + fill(P.deleteDataImports, { source: sourceWords }) : '';
        const named = sourceWords && fix.tool === config.deleteDataTool
          ? fill(fix.deletesCopies === 'messages_and_media' ? P.deleteDataConfirmMessagesMedia : fix.deletesCopies === 'messages' ? P.deleteDataConfirmMessages : P.deleteDataConfirm, { source: sourceWords }) + importsGo
          : sourceWords && fix.tool === config.disconnectTool
            ? fill(P.disconnectConfirm, { source: sourceWords })
            : '';
        add(
          wrap,
          el('span', 'reason strong', typeof fix.confirmText === 'string' && fix.confirmText ? fix.confirmText : named || P.confirmPrompt),
          button(fill(P.confirm, { label: String(fix.label).toLowerCase() }), key + ':yes', run, 'danger'),
          button(P.cancel, key + ':no', () => {
            state.confirming = '';
            render(key);
          }, 'plain'),
        );
        return wrap;
      }
      return add(wrap, button(fix.label, key, () => {
        supersede();
        state.confirming = key;
        render(key + ':no');
      }, 'plain'), errorNote(failure));
    }
    return add(wrap, button(fix.label, key, action, style), action && fix.tool ? howLink(fix, key, source) : null, errorNote(failure));
  }

  function errorNote(text: string): HTMLElement | null {
    if (!text) return null;
    const note = el('span', 'reason error', text);
    note.setAttribute('role', 'alert');
    return note;
  }

  // ---- sections ----------------------------------------------------------
  function connectionBanner(): HTMLElement | null {
    const current = connectionState();
    if (!current || current === 'ready') return null;
    const copy = (C as Any)[current] || C.relay_unavailable;
    const tone = current === 'installing' ? 'info' : 'warn';
    const banner = el('section', 'banner ' + tone);
    banner.setAttribute('role', current === 'installing' ? 'status' : 'alert');
    add(banner, icon(current === 'installing' ? '…' : '!'));
    const body = add(el('div', 'banner-body'), el('p', 'banner-title', copy.title));
    const conn = state.data ? state.data.connection : {};
    if (current === 'installing' && conn.progress) {
      const pct = percent(conn.progress.percent);
      const label = typeof conn.progress.label === 'string' ? conn.progress.label : '';
      add(body, el('p', 'muted', label + ' · ' + pct + '%'), progressBar(conn.progress.percent, label));
    }
    if (current === 'mac_offline' && typeof conn.lastSeenAt === 'string' && ago(conn.lastSeenAt)) {
      add(body, el('p', 'muted', fill(C.mac_offline.lastSeen, { when: ago(conn.lastSeenAt) })));
    }
    const actions = el('div', 'actions');
    if (current === 'relay_unavailable') {
      add(actions, state.busy === 'refresh'
        ? button(P.working, 'refresh', null, 'main')
        : button(C.actions.retry.label, 'refresh', refresh, 'main'));
    } else if (current === 'not_connected') {
      // Connect re-reads the dashboard: its result carries ChatGPT's own connect prompt.
      add(actions, state.busy === 'connection-action'
        ? button(P.working, 'connection-action', null, 'main')
        : button(C.actions.connect.label, 'connection-action', () => callTool(config.toolName, {}, 'connection-action'), 'main'));
      // The inline card keeps to Connect and Open Olympus; the install link waits for the full page.
      const install = compact() ? '' : helpHref(conn.installHref);
      if (install) add(actions, button(C.not_connected.install, 'connection-install', () => openLink(install), 'plain'));
    } else if (current !== 'installing' && conn.action && (C.actions as Any)[conn.action.id]) {
      const words = (C.actions as Any)[conn.action.id];
      const href = conn.action.href;
      let onClick: () => void;
      if (conn.action.id === 'retry') onClick = refresh;
      else if (typeof href === 'string' && href) onClick = () => openLink(href);
      else onClick = () => {
        state.helpOpen = !state.helpOpen;
        render('connection-action');
      };
      const control = button(words.label, 'connection-action', onClick, 'main');
      if (!href && conn.action.id !== 'retry') control.setAttribute('aria-expanded', String(state.helpOpen));
      add(actions, control);
      if (state.helpOpen && !href && words.help) add(body, el('p', 'help', words.help));
    }
    if (actions.childNodes.length) add(body, actions);
    if (current === 'relay_unavailable') add(body, relayWhy());
    return add(banner, body);
  }

  /** Under the unreachable banner: what the last failed read got back, and when. */
  function relayWhy(): HTMLElement | null {
    const failure = state.lastFailure;
    if (!failure) return null;
    const words = C.relay_unavailable.why;
    let line: string;
    if (failure.kind === 'no_answer') line = fill(words.no_answer, { seconds: Math.round(config.resultTimeoutMs / 1000) });
    else if (failure.kind === 'error') line = fill(words.error, { text: failure.text || '' });
    else if (failure.kind === 'host') line = fill(words.host, { text: failure.text || '' });
    else line = words.unreadable;
    const box = details('why:relay', doc.createTextNode(P.seeWhy), 'why');
    const list = add(el('ul', 'plain'), el('li', '', line));
    const when = ago(new Date(failure.at).toISOString());
    if (when) add(list, el('li', 'muted', fill(words.at, { when })));
    return add(box, list);
  }

  /** The source an attention item is about (`source:<id>`), for Connect and the pickers. */
  function itemSource(item: Any): { id: string; label: string } | undefined {
    const id = typeof item.id === 'string' && item.id.indexOf('source:') === 0 ? item.id.slice(7) : '';
    if (!id) return undefined;
    const sources = state.data && Array.isArray(state.data.sources) ? state.data.sources : [];
    const match = sources.filter((source: Any) => source && String(source.id) === id)[0];
    return { id, label: match ? String(match.label || id) : id };
  }

  function itemBanner(item: Any, key: string, allowConfirm: boolean): HTMLElement {
    const banner = el('section', 'banner warn');
    banner.setAttribute('role', 'alert');
    add(banner, icon('!'));
    const body = add(el('div', 'banner-body'), el('p', 'banner-title', String(item.sentence || '')));
    add(body, add(el('div', 'actions'), fixControl(item.fix, key, 'main', allowConfirm, itemSource(item))));
    return add(banner, body);
  }

  /** The stale line's words as drawn now, '' when it is not shown (the freshness tick compares it). */
  function staleWords(): string {
    const data = state.data;
    if (!data || state.relayDown) return '';
    const at = Date.parse(data.generatedAt);
    if (!isFinite(at) || Date.now() - at < config.staleAfterMs) return '';
    return fill(P.updated, { when: ago(data.generatedAt) });
  }

  function staleLine(): HTMLElement | null {
    const words = staleWords();
    drawnStale = words;
    if (!words) return null;
    const line = add(el('p', 'stale'), el('span', 'muted', words));
    return add(line, state.busy === 'refresh'
      ? button(P.working, 'refresh', null, 'plain')
      : button(P.checkAgain, 'refresh', refresh, 'plain'));
  }

  function needsYouSection(items: Any[]): HTMLElement | null {
    const waiting = waitingRow();
    if (!items.length && !waiting) return null;
    const section = add(el('section', 'section'), el('h2', '', P.needsYou));
    const list = el('ul', 'rows');
    add(list, waiting);
    items.forEach((item, index) => {
      const key = 'need:' + String(item.id || index);
      // A warm box with an orange edge carries the state, so the row has no dot.
      const body = add(el('div', 'need-body'), el('p', 'row-text', String(item.sentence || '')), fixControl(archiveNeedFix(item), key, 'warn', true, itemSource(item)));
      add(list, add(el('li', 'row need'), body));
    });
    return add(section, list);
  }

  /**
   * Computer only: one line while private questions wait, opening Private
   * answers. The count comes only from the computer meta, which ChatGPT never
   * receives, so this row can never appear there.
   */
  function waitingRow(): HTMLElement | null {
    const meta = state.computerMeta;
    if (!onComputer() || !meta) return null;
    const count = meta.waitingPrivateQuestions;
    const href = state.hostLinks.privateAnswers;
    if (typeof count !== 'number' || !isFinite(count) || count < 1 || !href) return null;
    const W = H.copy;
    const sentence = count === 1 ? W.waiting.one : fill(W.waiting.many, { count: Math.floor(count) });
    const open = button(W.open, 'need:waiting', () => openLink(href), 'warn');
    open.setAttribute('aria-label', W.open + ' ' + W.rows.privateAnswers.title);
    const body = add(el('div', 'need-body'), el('p', 'row-text', sentence), add(el('span', 'fix'), open));
    const row = add(el('li', 'row need'), body);
    row.setAttribute('data-waiting-private', String(Math.floor(count)));
    return row;
  }

  /** The Needs-you item about this source (`source:<id>`), which then lives in the source's own row. */
  function sourceItem(source: Any): Any {
    const items = state.data && Array.isArray(state.data.needsYou) ? state.data.needsYou : [];
    return items.filter((item: Any) => aboutSource(item, source))[0] || null;
  }

  /** An item is about a source by its id (`source:<id>`), its `source` field, or a sentence that starts with the source's name. */
  function aboutSource(item: Any, source: Any): boolean {
    if (!item || !source) return false;
    const id = String(source.id);
    if (item.id === 'source:' + id || item.source === id || item.sourceId === id) return true;
    const label = typeof source.label === 'string' ? source.label : '';
    return !!label && typeof item.sentence === 'string' && item.sentence.indexOf(label + ' — ') === 0;
  }

  function sourceRow(source: Any, other?: boolean): HTMLElement {
    const id = String(source.id || source.label);
    const status = String(source.status || '');
    // The Archives row on the computer: its own list, and Import an archive in place.
    const archives = archivesMeta(id);
    const item = sourceItem(source);
    // A source that needs the owner gets the amber dot, whatever its status word.
    const tone = item ? 'warn' : (config.statusTone as Any)[status] || 'off';
    const row = el('li', item ? 'row source need-row' : 'row source');
    const main = el('div', 'source-main');
    const dot = el('span', 'dot tone-' + tone);
    dot.setAttribute('aria-hidden', 'true');
    // Under Other archives the section names the row; its line says which exports it is for.
    const head = add(el('p', 'source-head'), dot, other
      ? add(el('span', 'source-name source-for', P.otherArchives.line), el('span', 'sr', ' — ' + String(source.label || '')))
      : el('span', 'source-name', String(source.label || '')));
    // The dot and the line under the name carry the state; the word is for screen readers only.
    const off = status === 'Off' && !item;
    if (!off) add(head, el('span', 'sr', ' — ' + (item ? P.needsYou : status)));
    add(main, head);
    const meta: string[] = [];
    const progress = sourceProgress(source);
    const stalledWords = progress ? stalledSentence(progress, source) : '';
    const detail = typeof source.detail === 'string' && source.detail ? source.detail : '';
    const checking = syncChecking(source);
    // What the last Sync now found leads the row while the engine carries it
    // (about ten minutes): its line is the engine's `detail` then.
    const manual = !checking && !source.connecting && syncResult(source) && !!detail;
    if (source.connecting) {
      // Waiting for sign-in: what is happening, and how long the link stays good.
      meta.push(capitalise(detail || (item ? itemReason(item, source) : '')));
      const expires = linkExpiry(source.connecting.expiresAt);
      if (expires) meta.push(expires);
    } else if (checking) {
      meta.push(fill(P.syncCheckingLine, { source: String(source.syncNoun || source.label || '') }));
    } else if (manual) {
      meta.push(capitalise(detail));
    } else if (progress) {
      // The bar and its sentence say what is happening; the line keeps only the last sync.
    } else if (item) meta.push(capitalise(itemReason(item, source)));
    else if (off) meta.push(capitalise(detail || P.notConnected));
    else if (detail) meta.push(capitalise(detail));
    // Never synced or fresh wording while work is unfinished: the stage line is
    // the detail then. Said once: when the engine's own line already says when
    // it synced, the page adds no second "Synced …" (it once printed
    // "synced 1h ago · Synced 1 hr ago").
    if (typeof source.lastSyncAt === 'string' && ago(source.lastSyncAt) && !source.connecting && !progress && !checking && !manual && !saysSynced(detail)) {
      meta.push(fill(P.synced, { when: ago(source.lastSyncAt) }));
    }
    const shown = meta.filter((part) => !!part);
    if (shown.length) add(main, el('p', 'muted', shown.join(' · ')));
    // While a press checks, or its result is the row's line, a pause sentence
    // under it would contradict it: only a moving bar stays.
    if (progress && !((checking || manual) && progress.stalled)) {
      add(main, sourceProgressBlock(progress, source, stalledWords || (progress.stalled ? pauseFallback(item, source) : '')));
    }
    // A pause the row shows (not one a Sync now line stands in for) gets its See why.
    // The archives that are inputs of this source, shown in its own card (computer only).
    const joined = sourceImportsMeta(id);
    const why = seeWhy(source, id, !!progress && !!progress.stalled && !checking && !manual)
      || (archives ? archiveUnreadable(archives, id) || archiveNotRunning(archives, id) : null)
      || (joined ? archiveNotRunning(joined, id) : null);
    if (why) add(main, why);
    // Landed on a source with nothing to see why about now: the row itself is
    // outlined, or on the Archives row each archive and request that needs the person.
    else if (state.landed && state.landed.id === id && !(archives && archiveNeeds(archives)) && !(joined && sourceImportsNeed(joined))) row.className += ' landed';
    if (archives) add(main, archiveList(archives));
    if (joined) add(main, sourceImportList(joined));
    add(row, main);
    const controls = el('div', 'source-actions');
    const context = { id, label: String(source.label || id) };
    // Row buttons are all outlined; the accent belongs to the page's one primary action.
    // One fix per row: the Needs-you fix when there is one, else the source's own.
    const fix = archiveFix(archives, item && item.fix ? item.fix : source.primary);
    const isSync = (entry: Any) => !!entry && entry.tool === config.syncTool;
    if (fix && !(checking && isSync(fix))) add(controls, fixControl(fix, 'primary:' + id, 'plain', true, context));
    // A press still checking: its button says so, disabled, in the row's place.
    if (checking) add(controls, checkingControl('primary:' + id));
    // The ⋯ menu keeps only secondary actions, never a copy of the row's fix,
    // and no second Sync now while one is checking.
    const menu = (Array.isArray(source.menu) ? source.menu : []).map((entry: Any) => archiveFix(archives, entry)).filter((entry: Any) =>
      (!fix || !entry || entry.label !== fix.label || entry.tool !== fix.tool) && !(checking && isSync(entry)));
    // Unpair for a paired chat app, on the computer only: the pairing lives here.
    const unpair = unpairEntry(id);
    if (unpair) menu.push(unpair);
    // A source that reads its own exports imports them from its ⋯ menu (computer only).
    const own = archiveSourceMeta(id);
    // It sits before Disconnect and Delete, which stay last.
    if (own) {
      const destructive = menu.findIndex((entry: Any) => !!entry && entry.destructive === true);
      menu.splice(destructive < 0 ? menu.length : destructive, 0, { label: H.copy.archives.sourceImport.action, archiveImport: true, archiveSource: own.sourceId });
    }
    let menuBox: HTMLElement | null = null;
    if (menu.length) {
      const glyph = el('span', '', '⋯');
      glyph.setAttribute('aria-hidden', 'true');
      const hidden = el('span', 'sr', fill(P.moreActions, { source: String(source.label || '') }));
      const box = details('menu:' + id, add(el('span'), glyph, hidden), 'menu');
      const panel = el('div', 'menu-panel');
      // Keyed by the action, not its place: the menu gains or loses an entry
      // (Sync now while one checks), and a position would then name another action.
      const taken: Record<string, number> = {};
      menu.forEach((fix: Any) => {
        const slug = String((fix && fix.label) || 'action').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'action';
        taken[slug] = (taken[slug] || 0) + 1;
        add(panel, fixControl(fix, 'menu:' + id + ':' + slug + (taken[slug] > 1 ? '-' + taken[slug] : ''), 'plain', true, context));
      });
      menuBox = add(box, panel);
    }
    if (controls.childNodes.length) {
      row.className += ' has-actions';
      add(row, controls);
    }
    if (menuBox) {
      // A sibling of the name, so ⋯ stays top-right of the row at every width.
      row.className += ' has-menu';
      add(row, menuBox);
    }
    return row;
  }

  // ---- archives (computer only) ----------------------------------------
  /** The Archives row's list from the computer meta, when this is that row on the computer. */
  function archivesMeta(id: string): Any {
    const meta = state.computerMeta;
    if (!onComputer() || !meta || !meta.archives || typeof meta.archives !== 'object') return null;
    const archives = meta.archives;
    return archives.sourceId === id && Array.isArray(archives.archives) && Array.isArray(archives.requests) ? archives : null;
  }

  /** On the computer the Archives row's Import an archive opens the picker in place, not this page again. */
  function archiveFix(archives: Any, fix: Any): Any {
    return archives && fix && fix.openHref === true && fix.label === H.copy.archives.importAction
      ? { label: fix.label, archiveImport: true }
      : fix;
  }

  /**
   * On the computer a Needs you line about imports acts in place: an archive
   * or a request is scrolled to and outlined, the unreadable list and imports
   * that cannot run open the row's See why, and held items open the private
   * model under Models. Anywhere
   * else (ChatGPT) the line's own link opens the computer's Archives row.
   */
  function archiveNeedFix(item: Any): Any {
    const fix = item && item.fix;
    const meta = onComputer() && state.computerMeta ? state.computerMeta.archives : null;
    const id = item && typeof item.id === 'string' ? item.id : '';
    if (!fix || typeof fix.label !== 'string' || !meta || typeof meta !== 'object') return fix;
    if (id === 'archives:held') return { label: fix.label, archiveModels: true };
    if (id === 'archives:unreadable' || id === 'archives:scheduler' || id.indexOf('archive:') === 0 || id.indexOf('archive-request:') === 0) {
      return { label: fix.label, archiveFocus: id };
    }
    return fix;
  }

  /** Scroll to one archive or request (or the row's See why) and outline it briefly. */
  function focusArchive(target: string): void {
    const meta = state.computerMeta && state.computerMeta.archives;
    const sourceId = meta && typeof meta.sourceId === 'string' ? meta.sourceId : '';
    const rowWhy = target === 'archives:unreadable' || target === 'archives:scheduler';
    if (rowWhy) {
      if (!sourceId) return;
      state.open['why:' + sourceId] = true;
      state.landed = { id: sourceId, until: Date.now() + H.landedMs };
    } else state.landed = { id: target, until: Date.now() + H.landedMs };
    render(rowWhy ? 'summary:why:' + sourceId : '');
    const node = root.querySelector('.landed') as HTMLElement | null;
    if (node && typeof node.scrollIntoView === 'function') node.scrollIntoView({ block: 'center' });
    const control = node ? node.querySelector('button, summary') as HTMLElement | null : null;
    if (control && typeof control.focus === 'function') control.focus();
    setTimeout(() => {
      state.landed = null;
      const shown = root.querySelector('.landed');
      if (shown) shown.classList.remove('landed');
    }, H.landedMs);
  }

  /** Whether an archive or a request on the Archives row needs the person now. */
  function archiveNeeds(meta: Any): boolean {
    return (Array.isArray(meta.archives) && meta.archives.some((entry: Any) => !!entry && archiveNeedsPerson(entry)))
      || (Array.isArray(meta.requests) && meta.requests.some((entry: Any) => !!entry && requestNeedsPerson(entry)));
  }

  /** A stopped archive, or one Olympus cannot count now. */
  function archiveNeedsPerson(archive: Any): boolean {
    return archive.status === 'stopped' || (archive.countsUnavailable === true && archive.status !== 'removing');
  }

  /** An agent's request waiting, or a check that ended without importing. */
  function requestNeedsPerson(request: Any): boolean {
    return (request.status === 'pending' && request.origin === 'agent') || request.status === 'failed';
  }

  /** An item on the Archives row outlined: by its own Needs you line, or by an open link that landed on the row. */
  function archiveLanded(own: string, needsPerson: boolean): boolean {
    const landed = state.landed;
    if (!landed) return false;
    const meta = state.computerMeta && state.computerMeta.archives;
    return landed.id === own || (needsPerson && !!meta && landed.id === meta.sourceId);
  }

  /** See why under the Archives row while its list cannot be read: why, what is kept, and what to do. */
  function archiveUnreadable(meta: Any, id: string): HTMLElement | null {
    const A = H.copy.archives;
    const unreadable = meta.unreadable;
    if (!unreadable || typeof unreadable !== 'object') return null;
    const reason = Object.prototype.hasOwnProperty.call(A.unreadable.why, unreadable.reason) ? String(unreadable.reason) : 'other';
    const file = typeof unreadable.file === 'string' && unreadable.file ? unreadable.file : '';
    const box = details('why:' + id, doc.createTextNode(P.seeWhy), 'why');
    if (state.landed && state.landed.id === id) box.className += ' landed';
    add(box, add(el('ul', 'plain'),
      el('li', '', fill((A.unreadable.why as Any)[reason], { file: file || A.thisFile })),
      el('li', '', A.unreadable.kept),
      el('li', '', (A.unreadable.fix as Any)[reason])));
    return box;
  }

  /** Which of this computer's settings keeps imports and removals from running, or '' when they run. */
  function archiveSetting(meta: Any): string {
    return meta && (meta.notRunning === 'disabled' || meta.notRunning === 'not_selected') ? String(meta.notRunning) : '';
  }

  /** See why under the Archives row while this computer's settings keep imports and removals from running. */
  function archiveNotRunning(meta: Any, id: string): HTMLElement | null {
    const A = H.copy.archives;
    const setting = archiveSetting(meta);
    if (!setting) return null;
    const box = details('why:' + id, doc.createTextNode(P.seeWhy), 'why');
    if (state.landed && state.landed.id === id) box.className += ' landed';
    add(box, add(el('ul', 'plain'),
      el('li', '', (A.notRunning.why as Any)[setting]),
      el('li', '', (A.notRunning.fix as Any)[setting])));
    return box;
  }

  /** An import being read, removed or checked keeps the page reading often. */
  function archivesMoving(): boolean {
    // An import that joined a source is read like any other: the page keeps reading while one moves.
    const joined = onComputer() && state.computerMeta && Array.isArray(state.computerMeta.sourceImports) ? state.computerMeta.sourceImports : [];
    if (joined.some((group: Any) => !!group && !archiveSetting(group) && Array.isArray(group.imports)
      && group.imports.some((entry: Any) => !!entry && entry.status === 'importing'))) return true;
    const meta = onComputer() && state.computerMeta ? state.computerMeta.archives : null;
    if (!meta || typeof meta !== 'object') return false;
    // Imports this computer's settings keep from running are not moving.
    return (!archiveSetting(meta) && Array.isArray(meta.archives) && meta.archives.some((entry: Any) => !!entry && (entry.status === 'importing' || entry.status === 'removing')))
      || (Array.isArray(meta.requests) && meta.requests.some((entry: Any) => !!entry && entry.status === 'checking'));
  }

  /**
   * Import an archive: the picker over this computer's files; its one line says
   * what came of the choice. From a source's ⋯ menu (`sourceId`) the picker is
   * titled for that source, says which of its exports to choose, and the engine
   * takes only those.
   */
  function startArchivePick(key: string, sourceId: string): void {
    supersede();
    state.notice = '';
    state.confirming = '';
    const A = H.copy.archives;
    const own = sourceId ? archiveSourceMeta(sourceId) : null;
    const words = own
      ? { ...A.pick, title: fill(A.sourceImport.title, { source: String(own.label) }), intro: String(own.intro), account: A.account }
      : { ...A.pick, account: A.account };
    // Names in the line are the person's own files, shown only on this computer.
    picker!.pickArchive(words, (picked: ChatGptArchivePicked | null) => closeScreen(picked ? archiveOutcome(picked) : '', true, key), own ? String(own.sourceId) : '');
  }

  /** The source whose card imports its own exports, from the computer meta (computer only). */
  function archiveSourceMeta(id: string): Any {
    const meta = state.computerMeta;
    if (!onComputer() || !meta || !Array.isArray(meta.archiveSources)) return null;
    return meta.archiveSources.filter((entry: Any) => !!entry && entry.sourceId === id
      && typeof entry.label === 'string' && !!entry.label && typeof entry.intro === 'string' && !!entry.intro)[0] || null;
  }

  /** The one line after an approval: started, checking, or already imported. */
  function archiveOutcome(outcome: Any): string {
    const A = H.copy.archives;
    const name = outcome && typeof outcome.name === 'string' ? outcome.name : '';
    if (!name) return '';
    const archive = typeof outcome.archiveName === 'string' ? outcome.archiveName : typeof outcome.archive_name === 'string' ? outcome.archive_name : '';
    if (outcome.status === 'checking') return fill(A.checking, { name });
    if (outcome.status === 'already_imported') return archive ? fill(A.already, { name, archive }) : fill(A.alreadyUnnamed, { name });
    return outcome.status === 'started' ? fill(A.started, { name }) : '';
  }

  /** What an Archives row control did, from the list read before it (names are the computer's own). */
  function archiveNotice(name: string, args: Any, result: Any): string {
    const A = H.copy.archives;
    const meta = state.computerMeta && state.computerMeta.archives;
    if (name === H.archiveRemoveTool) {
      // Remove on an archive names it; Remove on an agent's request names the archive the request does.
      const asked = args && args.request_id && meta && Array.isArray(meta.requests)
        ? meta.requests.filter((entry: Any) => entry && entry.id === args.request_id)[0]
        : null;
      const target = asked ? asked.archiveId : args && args.archive_id;
      const removed = meta && Array.isArray(meta.archives) ? meta.archives.filter((entry: Any) => entry && entry.id === target)[0] : null;
      return removed && typeof removed.name === 'string' ? fill(A.removing, { name: removed.name }) : '';
    }
    if (name === H.archiveStopTool) {
      const groups = state.computerMeta && Array.isArray(state.computerMeta.sourceImports) ? state.computerMeta.sourceImports : [];
      const stopped = groups
        .flatMap((group: Any) => (group && Array.isArray(group.imports) ? group.imports : []))
        .filter((entry: Any) => entry && entry.id === (args && args.archive_id))[0];
      return stopped && typeof stopped.name === 'string' ? fill(A.inSource.stopped, { name: stopped.name }) : '';
    }
    if (name === H.archiveDeclineTool) {
      // Decline answers an agent's request, Cancel stops a check; Dismiss only clears a finished one.
      const request = meta && Array.isArray(meta.requests) ? meta.requests.filter((entry: Any) => entry && entry.id === (args && args.request_id))[0] : null;
      if (request && request.status === 'checking' && typeof request.name === 'string') return fill(A.cancelled, { name: request.name });
      if (args && typeof args.request_id === 'string') delete state.archiveConfirm[args.request_id];
      return request && request.status === 'pending' ? A.declined : '';
    }
    if (name === H.archiveApproveTool) {
      // An agent's request whose export did not prove its account: asked in its own row until answered.
      const content = result && result.structuredContent;
      const requestId = args && typeof args.request_id === 'string' ? args.request_id : '';
      if (requestId) {
        if (content && content.status === 'confirm_account') {
          const source = content.source && typeof content.source.label === 'string' ? content.source.label : '';
          state.archiveConfirm[requestId] = { source, ...(content.reconfirm === true ? { reconfirm: true } : {}) };
        } else delete state.archiveConfirm[requestId];
      }
    }
    return archiveOutcome(result && result.structuredContent);
  }

  const ARCHIVE_STATUSES = ['importing', 'imported', 'stopped', 'removing'];
  const ARCHIVE_REQUEST_STATUSES = ['pending', 'checking', 'already_imported', 'failed'];

  function validArchive(entry: Any): boolean {
    return !!entry && typeof entry.id === 'string' && !!entry.id && typeof entry.name === 'string'
      && ARCHIVE_STATUSES.indexOf(entry.status) >= 0
      && Array.isArray(entry.gaps) && Array.isArray(entry.skipped);
  }

  function validArchiveRequest(entry: Any): boolean {
    return !!entry && typeof entry.id === 'string' && !!entry.id && typeof entry.name === 'string'
      && ARCHIVE_REQUEST_STATUSES.indexOf(entry.status) >= 0;
  }

  function wholeCount(value: Any): number {
    return typeof value === 'number' && isFinite(value) && value > 0 ? Math.floor(value) : 0;
  }

  /** What an archive's items are called, by its family; items when the family is not one with its own word. */
  function archiveNouns(archive: Any): Any {
    const nouns = H.copy.archives.nouns as Any;
    const family = archive && typeof archive.family === 'string' ? archive.family : '';
    return Object.prototype.hasOwnProperty.call(nouns, family) ? nouns[family] : nouns.other;
  }

  function itemCount(archive: Any, n: number): string {
    const nouns = archiveNouns(archive);
    return fill(n === 1 ? nouns.one : nouns.many, { n: count(n) });
  }

  /**
   * Under the Archives row: each import asked for, then each archive, with
   * what it holds, how far it is, what still waits for the private model and
   * what could not be read, each with its way forward (owner ruling,
   * 2026-10-10: nothing wrong without a route to exactly what).
   */
  function archiveList(meta: Any): HTMLElement | null {
    const A = H.copy.archives;
    const requests = meta.requests.filter(validArchiveRequest);
    const archives = meta.archives.filter(validArchive);
    if (!requests.length && !archives.length) return null;
    const list = el('ul', 'archives');
    list.setAttribute('aria-label', A.listLabel);
    for (const request of requests) add(list, archiveRequestItem(request));
    for (const archive of archives) add(list, archiveItem(archive, String(meta.privateModel || ''), archiveSetting(meta)));
    return list;
  }

  /** The imports that joined this source (computer only): their meta, or null when it has none. */
  function sourceImportsMeta(id: string): Any {
    const meta = state.computerMeta;
    if (!onComputer() || !meta || !Array.isArray(meta.sourceImports)) return null;
    const found = meta.sourceImports.filter((group: Any) => !!group && group.sourceId === id && Array.isArray(group.imports))[0];
    return found && found.imports.filter(validArchive).length > 0 ? found : null;
  }

  /** An import stopped for a reason that is not the person's own Stop needs them. */
  function sourceImportNeedsPerson(entry: Any): boolean {
    return entry.status === 'stopped' && !(entry.stop && entry.stop.code === 'stopped_by_owner');
  }

  function sourceImportsNeed(group: Any): boolean {
    return group.imports.filter(validArchive).some(sourceImportNeedsPerson);
  }

  /**
   * Under a source's card: the history its inputs cover, then each import that
   * joined it with its own progress, what it found, how much of it the source
   * already had, and Stop. The card counts every item once: these lines count
   * only what each archive held.
   */
  function sourceImportList(group: Any): HTMLElement {
    const S = H.copy.archives.inSource;
    const box = el('div', 'archive-source');
    const covers = group.covers && typeof group.covers === 'object' ? group.covers : {};
    const parts: string[] = [];
    if (typeof covers.importedTo === 'string' && covers.importedTo) parts.push(fill(S.covers.imported, { to: covers.importedTo }));
    if (typeof covers.liveSince === 'string' && covers.liveSince) parts.push(fill(S.covers.live, { since: covers.liveSince }));
    if (parts.length) {
      const line = parts.join(' · ');
      add(box, el('p', 'muted archive-facts archive-covers', line.charAt(0).toUpperCase() + line.slice(1)));
    }
    const list = el('ul', 'archives');
    list.setAttribute('aria-label', S.listLabel);
    const setting = archiveSetting(group);
    for (const entry of group.imports.filter(validArchive)) add(list, sourceImportItem(entry, setting));
    return add(box, list);
  }

  /** ", of which M were already there" when the source already had some of an import's items. */
  function alreadyThereNote(entry: Any): string {
    const n = wholeCount(entry.alreadyThere);
    const S = H.copy.archives.inSource;
    return n > 0 ? fill(n === 1 ? S.alreadyThere.one : S.alreadyThere.many, { n: count(n) }) : '';
  }

  /** One import inside its source's card; `setting` names what keeps imports from running ('' when they run). */
  function sourceImportItem(entry: Any, setting: string): HTMLElement {
    const A = H.copy.archives;
    const S = A.inSource;
    const ownStop = entry.status === 'stopped' && !sourceImportNeedsPerson(entry);
    const needs = sourceImportNeedsPerson(entry);
    const item = el('li', 'archive' + (needs ? ' stopped' : ''));
    item.setAttribute('data-archive', entry.status);
    item.setAttribute('data-source-import', 'true');
    if (archiveLanded('archive:' + entry.id, needs)) item.className += ' landed';
    const halted = !!setting && entry.status === 'importing';
    if (halted) item.setAttribute('data-not-running', setting);
    add(item, add(el('p', 'archive-head'), el('span', 'archive-name', entry.name), el('span', 'ftag', halted ? A.status.notRunning : (A.status as Any)[entry.status])));
    const facts: HTMLElement[] = [entry.format, entry.where]
      .filter((part: Any) => typeof part === 'string' && part)
      .map((part: string) => el('span', '', part));
    const earliest = typeof entry.earliest === 'string' ? entry.earliest : '';
    const latest = typeof entry.latest === 'string' ? entry.latest : '';
    if (earliest && latest) {
      facts.push(el('span', 'archive-dates', earliest === latest ? earliest : fill(A.dates, { earliest, latest })));
      const snapshot = archiveNouns(entry).snapshot;
      if (typeof snapshot === 'string' && snapshot) facts.push(el('span', 'archive-snapshot', snapshot));
    }
    if (facts.length) {
      const line = el('p', 'muted archive-facts');
      facts.forEach((fact, index) => {
        if (index) add(line, doc.createTextNode(' · '));
        add(line, fact);
      });
      add(item, line);
    }
    const read = wholeCount(entry.read);
    if (halted) {
      const pct = typeof entry.percent === 'number' && isFinite(entry.percent) ? entry.percent : 0;
      add(item, el('p', 'muted', fill(S.notRunningLine, { percent: percent(pct) })));
    } else if (entry.status === 'importing') {
      const pct = typeof entry.percent === 'number' && isFinite(entry.percent) ? entry.percent : 0;
      const line = read > 0
        ? fill(S.importingLine, { percent: percent(pct), items: itemCount(entry, read) }) + alreadyThereNote(entry)
        : fill(S.importingLineNone, { percent: percent(pct) });
      add(item, add(el('div', 'archive-progress'), progressBar(pct, line), el('p', 'muted', line)));
    } else if (entry.status === 'imported') {
      const when = typeof entry.importedAt === 'string' ? ago(entry.importedAt) : '';
      if (read === 0) {
        const none = archiveNouns(entry).none;
        if (archiveHasReasons(entry)) {
          const None = none.charAt(0).toUpperCase() + none.slice(1);
          add(item, el('p', 'muted', when ? fill(A.nothingImportedWhen, { None, when }) : fill(A.nothingImported, { None })));
        } else {
          add(item, el('p', 'muted', when ? fill(A.emptyImportWhen, { none, when }) : fill(A.emptyImport, { none })));
        }
      } else {
        add(item, el('p', 'muted', fill(S.importedLine, { items: itemCount(entry, read) }) + alreadyThereNote(entry) + (when ? fill(S.importedWhen, { when }) : '')));
      }
    } else {
      // Stopped: why, and the way to go on. The person's own Stop is not a problem.
      const stop = entry.stop && typeof entry.stop === 'object' ? entry.stop : {};
      const words = Object.prototype.hasOwnProperty.call(S.stoppedWhy, String(stop.code)) ? (S.stoppedWhy as Any)[String(stop.code)] : S.stoppedWhy.other;
      const file = typeof stop.file === 'string' && stop.file ? stop.file : A.thisFile;
      add(item, el('p', ownStop ? 'muted' : 'reason strong', fill(words.why, { file })), el('p', 'muted', words.fix));
      if (read > 0) add(item, el('p', 'muted', fill(S.importedLine, { items: itemCount(entry, read) }) + alreadyThereNote(entry)));
    }
    const why = archiveWhy(entry);
    if (why) add(item, why);
    if (entry.status === 'importing') {
      add(item, add(el('div', 'archive-actions'),
        fixControl({ label: S.stop, tool: H.archiveStopTool, args: { archive_id: entry.id } }, 'archive-stop:' + entry.id, 'plain', false)));
    }
    return item;
  }

  /**
   * A line from a template whose {keys} are names, folders or paths the
   * person did not choose (an agent asked): each is its own <bdi>, so
   * right-to-left text inside one cannot reorder the words around it or
   * the value beside it.
   */
  function isolatedLine(cls: string, template: string, values: Record<string, string>): HTMLElement {
    const line = el('p', cls);
    for (const part of template.split(/(\{[a-z]+\})/)) {
      const key = part.slice(1, -1);
      if (part.charAt(0) === '{' && Object.prototype.hasOwnProperty.call(values, key)) add(line, el('bdi', '', values[key]));
      else if (part) add(line, doc.createTextNode(part));
    }
    return line;
  }

  /** The whole path an approval is for, written out in full (hidden characters shown as ⟨U+XXXX⟩): what Import or Remove acts on. */
  function archiveFullPath(request: Any): HTMLElement | null {
    const path = typeof request.path === 'string' ? request.path : '';
    return path ? isolatedLine('muted archive-facts request-path', H.copy.archives.fullPath, { path }) : null;
  }

  function archiveRequestItem(request: Any): HTMLElement {
    const A = H.copy.archives;
    const item = el('li', 'archive request');
    item.setAttribute('data-request', String(request.status));
    if (archiveLanded('archive-request:' + request.id, requestNeedsPerson(request))) item.className += ' landed';
    const key = 'archive-request:' + request.id;
    const where = typeof request.where === 'string' ? request.where : '';
    if (request.kind === 'remove') {
      // An agent asked to remove an archive: the person's Remove runs the same removal as the archive's own, after the same confirmation.
      item.setAttribute('data-request', 'remove');
      add(item, where
        ? isolatedLine('', A.removeRequestLine, { name: request.name, where })
        : isolatedLine('', A.removeRequestLineNoWhere, { name: request.name }));
      add(item, archiveFullPath(request));
      add(item, el('p', 'muted', A.removeRequestNote));
      add(item, add(el('div', 'archive-actions'),
        fixControl({
          label: A.remove,
          tool: H.archiveRemoveTool,
          args: { request_id: request.id },
          destructive: true,
          confirmText: fill(A.removeConfirm, { name: request.name }),
        }, key + ':remove', 'plain', true),
        fixControl({ label: A.decline, tool: H.archiveDeclineTool, args: { request_id: request.id } }, key + ':decline', 'plain', false)));
      return item;
    }
    const asked = state.archiveConfirm[request.id];
    if (request.status === 'pending' && asked) {
      // The export does not prove which account it is of: asked here, and nothing is imported until answered.
      const source = asked.source || A.account.sourceFallback;
      add(item, isolatedLine('', asked.reconfirm ? A.account.reconfirm.line : A.account.line, { name: request.name, source }));
      add(item, el('p', 'muted', fill(asked.reconfirm ? A.account.reconfirm.note : A.account.note, { source })));
      add(item, add(el('div', 'archive-actions'),
        fixControl({ label: fill(A.account.add, { source }), tool: H.archiveApproveTool, args: { request_id: request.id, confirm_account: true } }, key + ':confirm', 'plain', false),
        ...(asked.reconfirm ? [] : [fixControl({ label: A.account.apart, tool: H.archiveApproveTool, args: { request_id: request.id, keep_apart: true } }, key + ':apart', 'plain', false)]),
        fixControl({ label: A.decline, tool: H.archiveDeclineTool, args: { request_id: request.id } }, key + ':decline', 'plain', false)));
      return item;
    }
    if (request.status === 'pending') {
      add(item, isolatedLine('', A.requestLine, { name: request.name, where }));
      add(item, archiveFullPath(request));
      add(item, add(el('div', 'archive-actions'),
        fixControl({ label: A.approve, tool: H.archiveApproveTool, args: { request_id: request.id } }, key + ':approve', 'plain', false),
        fixControl({ label: A.decline, tool: H.archiveDeclineTool, args: { request_id: request.id } }, key + ':decline', 'plain', false)));
      return item;
    }
    if (request.status === 'checking') {
      const line = el('p', 'muted', fill(A.checkingLine, { name: request.name }));
      line.setAttribute('role', 'status');
      return add(item, line, add(el('div', 'archive-actions'),
        fixControl({ label: A.cancel, tool: H.archiveDeclineTool, args: { request_id: request.id } }, key + ':cancel', 'plain', false)));
    }
    const archive = typeof request.archiveName === 'string' ? request.archiveName : '';
    const failed = request.status === 'failed';
    const sentence = !failed
      ? (archive ? fill(A.alreadyLine, { name: request.name, archive }) : fill(A.alreadyLineUnnamed, { name: request.name }))
      : fill(A.failedLine, { name: request.name, reason: (A.failed as Any)[String(request.code)] || A.failed.unreadable });
    add(item, el('p', failed ? 'reason strong' : '', sentence));
    const actions = el('div', 'archive-actions');
    if (failed) add(actions, fixControl({ label: A.tryAgain, tool: H.archiveApproveTool, args: { request_id: request.id } }, key + ':retry', 'plain', false));
    return add(item, add(actions,
      fixControl({ label: A.dismiss, tool: H.archiveDeclineTool, args: { request_id: request.id } }, key + ':dismiss', 'plain', false)));
  }

  /** One archive; `setting` names what keeps imports and removals from running ('' when they run). */
  function archiveItem(archive: Any, model: string, setting: string): HTMLElement {
    const A = H.copy.archives;
    const item = el('li', 'archive' + (archive.status === 'stopped' ? ' stopped' : ''));
    item.setAttribute('data-archive', archive.status);
    if (archiveLanded('archive:' + archive.id, archiveNeedsPerson(archive))) item.className += ' landed';
    // Importing or removing, but not running: never "Importing", never a moving bar.
    const halted = !!setting && (archive.status === 'importing' || archive.status === 'removing');
    if (halted) item.setAttribute('data-not-running', setting);
    add(item, add(el('p', 'archive-head'), el('span', 'archive-name', archive.name), el('span', 'ftag', halted ? A.status.notRunning : (A.status as Any)[archive.status])));
    const facts: HTMLElement[] = [archive.format, archive.where]
      .filter((part: Any) => typeof part === 'string' && part)
      .map((part: string) => el('span', '', part));
    const earliest = typeof archive.earliest === 'string' ? archive.earliest : '';
    const latest = typeof archive.latest === 'string' ? archive.latest : '';
    // A date never breaks at its hyphens.
    if (earliest && latest) {
      facts.push(el('span', 'archive-dates', earliest === latest ? earliest : fill(A.dates, { earliest, latest })));
      // A chat export is the conversation as it was on the day it was exported.
      const snapshot = archiveNouns(archive).snapshot;
      if (typeof snapshot === 'string' && snapshot) facts.push(el('span', 'archive-snapshot', snapshot));
    }
    if (facts.length) {
      const line = el('p', 'muted archive-facts');
      facts.forEach((fact, index) => {
        if (index) add(line, doc.createTextNode(' · '));
        add(line, fact);
      });
      add(item, line);
    }
    const items = wholeCount(archive.items);
    // An index that cannot be read now is said as such, never as no messages.
    const uncounted = archive.countsUnavailable === true && archive.status !== 'removing';
    if (halted && archive.status === 'importing') {
      const pct = typeof archive.percent === 'number' && isFinite(archive.percent) ? archive.percent : 0;
      add(item, el('p', 'muted', uncounted ? fill(A.notRunningLineUncounted, { percent: percent(pct) }) : fill(A.notRunningLine, { percent: percent(pct), items: itemCount(archive, items) })));
    } else if (halted) {
      add(item, el('p', 'muted', A.removingNotRunningLine));
    } else if (archive.status === 'importing') {
      const pct = typeof archive.percent === 'number' && isFinite(archive.percent) ? archive.percent : 0;
      const line = uncounted ? fill(A.importingLineUncounted, { percent: percent(pct) }) : fill(A.importingLine, { percent: percent(pct), items: itemCount(archive, items) });
      add(item, add(el('div', 'archive-progress'), progressBar(pct, line), el('p', 'muted', line)));
    } else if (archive.status === 'imported') {
      const when = typeof archive.importedAt === 'string' ? ago(archive.importedAt) : '';
      if (!uncounted && items === 0) {
        const none = archiveNouns(archive).none;
        if (archiveHasReasons(archive)) {
          // Messages were found and left out or not read: nothing was imported, which is not an empty archive.
          const None = none.charAt(0).toUpperCase() + none.slice(1);
          add(item, el('p', 'muted', when ? fill(A.nothingImportedWhen, { None, when }) : fill(A.nothingImported, { None })));
        } else {
          // Nothing found at all is said as that: the import finished, and this is what it found.
          add(item, el('p', 'muted', when ? fill(A.emptyImportWhen, { none, when }) : fill(A.emptyImport, { none })));
        }
      } else if (!uncounted) {
        add(item, el('p', 'muted', when ? fill(A.importedLine, { items: itemCount(archive, items), when }) : fill(A.importedLineNoTime, { items: itemCount(archive, items) })));
      }
    } else if (archive.status === 'removing') {
      const line = el('p', 'muted', A.removingLine);
      line.setAttribute('role', 'status');
      add(item, line);
    } else {
      // Stopped: what happened to which file, and what to do.
      const stop = archive.stop && typeof archive.stop === 'object' ? archive.stop : {};
      const words = (A.stopped as Any)[String(stop.code)] || A.stopped.other;
      const file = typeof stop.file === 'string' && stop.file ? stop.file : A.thisFile;
      add(item, el('p', 'reason strong', fill(words.why, { file })), el('p', 'muted', words.fix));
    }
    if (uncounted) add(item, el('p', 'reason strong', A.countsUnavailable.why), el('p', 'muted', A.countsUnavailable.fix));
    else if (archive.status !== 'removing' && items > 0) add(item, archiveHeld(archive, model));
    const why = archiveWhy(archive);
    if (why) add(item, why);
    if (archive.status !== 'removing') {
      // While removals cannot run, Remove is shown but not pressable, the reason beside it.
      add(item, add(el('div', 'archive-actions'), fixControl({
        label: A.remove,
        tool: H.archiveRemoveTool,
        args: { archive_id: archive.id },
        destructive: true,
        confirmText: fill(A.removeConfirm, { name: archive.name }),
        ...(setting ? { disabledReason: (A.removeNotRunning as Any)[setting] } : {}),
      }, 'archive-remove:' + archive.id, 'plain', true)));
    }
    return item;
  }

  /** Judged so far and still held Private, with the way to the private model when it is not answering. */
  function archiveHeld(archive: Any, model: string): HTMLElement {
    const A = H.copy.archives;
    const held = wholeCount(archive.held);
    const block = el('div', 'archive-held');
    add(block, el('p', 'muted', fill(A.judgedLine, { judged: count(wholeCount(archive.judged)), held: count(held) })));
    if (!held) return block;
    const level = model === 'ready' || model === 'off' ? model : 'waiting';
    add(block, el('p', 'muted', (A.heldWhy as Any)[level]));
    if (level !== 'ready') {
      add(block, add(el('div', 'archive-actions'), button(A.setUpPrivateModel, 'archive-models:' + archive.id, () => {
        state.open.models = true;
        render('summary:models');
      }, 'plain')));
    }
    return block;
  }

  /**
   * An archive's findings in two lists (what each kind is, and which list it
   * is in, are the vocabulary's: copy.archives.gaps and .listOf). Not
   * imported is what Olympus does not have; How it was read is what it took as
   * given or left out on purpose. For an archive of several files, each line
   * says which file it is in. A kind the table does not name is shown under
   * Not imported, so nothing is hidden.
   */
  function archiveFindings(archive: Any): Array<{ list: string; entry: Any }> {
    const lists = H.copy.archives.listOf as Any;
    return archive.gaps.concat(archive.skipped)
      .filter((entry: Any) => entry && typeof entry.kind === 'string' && wholeCount(entry.count) > 0)
      .map((entry: Any) => ({
        list: Object.prototype.hasOwnProperty.call(lists, entry.kind) && lists[entry.kind] === 'how_read' ? 'how_read' : 'not_imported',
        entry,
      }));
  }

  /** Whether the import has anything not imported or to say about how it was read (the lines under its See button). */
  function archiveHasReasons(archive: Any): boolean {
    return archiveFindings(archive).length > 0;
  }

  function archiveWhy(archive: Any): HTMLElement | null {
    const A = H.copy.archives;
    const kinds = A.gaps as Any;
    const found = archiveFindings(archive);
    const listed = (list: string) => found.filter((item) => item.list === list).map((item) => {
      const entry = item.entry;
      const words = Object.prototype.hasOwnProperty.call(kinds, entry.kind) ? kinds[entry.kind] : kinds.other;
      const n = wholeCount(entry.count);
      const gap = fill(n === 1 ? words.one : words.many, { n: count(n) });
      return el('li', '', typeof entry.file === 'string' && entry.file ? fill(A.gapInFile, { file: entry.file, gap }) : gap);
    });
    const notImported = listed('not_imported');
    const howRead = listed('how_read');
    if (!notImported.length && !howRead.length) return null;
    const label = notImported.length && howRead.length ? A.seeWhy.both : howRead.length ? A.seeWhy.howRead : A.seeWhy.notImported;
    const box = details('archive-why:' + archive.id, doc.createTextNode(label), 'why');
    if (notImported.length) add(box, el('p', 'why-head', A.lists.notImported), add(el('ul', 'plain'), ...notImported));
    if (howRead.length) add(box, el('p', 'why-head', A.lists.howRead), add(el('ul', 'plain'), ...howRead));
    return box;
  }

  /**
   * "See why", under a row with files that can't be read: a count per reason,
   * then which files (owner ruling, 2026-10-10: never say something is wrong
   * without a way to find out exactly what), and one note. In ChatGPT the
   * newest few names and "and N more", which opens the computer's full list;
   * on the computer every file from its own list, each opening the file. An
   * older engine's bare number has no reasons and shows nothing beyond the
   * row's own line.
   */
  function seeWhy(source: Any, id: string, stalled: boolean): HTMLElement | null {
    // Why the row is stalled first, then the files it can't read: one See why per row.
    const stall = stalled && source.progress ? stallLines(source.progress.stall, source) : [];
    const unreadable = source.unreadable;
    const words = P.unreadableReasons as Any;
    const lines = unreadable && typeof unreadable === 'object' && Array.isArray(unreadable.reasons)
      ? unreadable.reasons
        .filter((reason: Any) => reason && words[reason.code] && Number(reason.count) > 0)
        .map((reason: Any) => {
          const n = Number(reason.count);
          return add(el('li'), document.createTextNode(fill(n === 1 ? words[reason.code].one : words[reason.code].other, { count: count(n) })));
        })
      : [];
    if (!lines.length && !stall.length) return null;
    const box = details('why:' + id, document.createTextNode(P.seeWhy), 'why');
    if (state.landed && state.landed.id === id) box.className += ' landed';
    if (stall.length) add(box, add(el('ul', 'plain stall-why'), ...stall.map((line) => el('li', '', line))));
    if (lines.length) {
      add(box, add(el('ul', 'plain'), ...lines), unreadableFiles(unreadable, id), el('p', 'why-note', unreadable.reasons.some((reason: Any) => reason.code === 'privacy_check_missing') ? '' : unreadable.many ? P.unreadableNoteMany : P.unreadableNote));
    }
    return box;
  }

  /** The unreadable files under See why: the computer's own list when it has one, else the result's names. */
  function unreadableFiles(unreadable: Any, id: string): HTMLElement | null {
    const list = el('ul', 'plain files');
    const own = computerUnreadable(id);
    if (own) {
      own.files.forEach((file: Any, index: number) => {
        const item = el('li');
        if (typeof file.token === 'string' && file.token) {
          const key = 'why-file:' + id + ':' + index;
          const control = fixControl({ label: file.name, tool: H.unreadableOpenTool, args: { token: file.token } }, key, 'plain', false);
          const opener = control.querySelector('button');
          if (opener && opener.textContent === file.name) {
            opener.className = 'btn link file';
            opener.setAttribute('aria-label', fill(P.unreadableOpen, { name: file.name }));
          }
          add(item, control);
        } else add(item, document.createTextNode(file.name));
        add(list, item);
      });
      if (own.more > 0) {
        // The next page from where this one ended, so every file is reachable however many there are.
        const label = fill(P.unreadableMore, { count: count(own.more) });
        add(list, own.after
          ? add(el('li'), fixControl({ label, tool: H.unreadablePageTool, args: { source_id: id, after: own.after } }, 'why-page:' + id, 'plain', false))
          : el('li', 'muted', label));
      }
      return list.childNodes.length ? list : null;
    }
    const names = Array.isArray(unreadable.names) ? unreadable.names.filter((name: Any) => typeof name === 'string' && name) : [];
    names.forEach((name: string) => add(list, el('li', '', name)));
    if (unreadable.more && typeof unreadable.more === 'object') {
      add(list, add(el('li'), fixControl(unreadable.more, 'why-more:' + id, 'plain', false)));
    }
    return list.childNodes.length ? list : null;
  }

  /** Computer only: this source's unreadable files from the computer meta (names, open tokens), or null. */
  function computerUnreadable(id: string): { files: Array<{ name: string; token?: string }>; more: number; after: string } | null {
    const meta = state.computerMeta;
    if (!onComputer() || !meta || !Array.isArray(meta.unreadable)) return null;
    const entry = meta.unreadable.filter((item: Any) => item && item.sourceId === id)[0];
    if (!entry || !Array.isArray(entry.files)) return null;
    const pages = state.unreadablePages[id];
    const files = unreadableEntries(entry.files).concat(pages ? pages.files : []);
    const more = pages ? pages.more : moreCount(entry.more);
    const after = pages ? pages.after : cursorOf(entry.after);
    return files.length || more ? { files, more, after } : null;
  }

  /** A page cursor exactly as the engine gave it, or ''. */
  function cursorOf(value: Any): string {
    return typeof value === 'string' && value.length <= 64 && /^[0-9TZ:.+-]+~[A-Za-z0-9_-]+$/.test(value) ? value : '';
  }

  function unreadableEntries(input: Any[]): Array<{ name: string; token?: string }> {
    return input
      .filter((file: Any) => file && typeof file.name === 'string' && file.name)
      .map((file: Any) => (typeof file.token === 'string' && /^[A-Za-z0-9_-]{16,128}$/.test(file.token)
        ? { name: file.name, token: file.token }
        : { name: file.name }));
  }

  function moreCount(value: Any): number {
    return typeof value === 'number' && isFinite(value) && value > 0 ? Math.floor(value) : 0;
  }

  /**
   * Where an open link asked to land (computer only, once the data is in):
   * that source's See why opens, gets a brief outline (`.landed`) and the
   * focus. A source with nothing unreadable now is outlined as a row.
   */
  function applyLanding(): void {
    const id = state.landing;
    if (!id || !state.data || state.relayDown || editorOpen() || compact()) return;
    state.landing = '';
    const sources = Array.isArray(state.data.sources) ? state.data.sources : [];
    if (!sources.some((source: Any) => source && source.id === id)) return;
    state.open['why:' + id] = true;
    state.landed = { id, until: Date.now() + H.landedMs };
    render('summary:why:' + id);
    const node = root.querySelector('.landed') as HTMLElement | null;
    if (node && typeof node.scrollIntoView === 'function') node.scrollIntoView({ block: 'center' });
    setTimeout(() => {
      state.landed = null;
      const shown = root.querySelector('.landed');
      if (shown) shown.classList.remove('landed');
    }, H.landedMs);
  }

  /** Sync now was pressed and its sync has not finished: pressed here, or `checking` on the engine. */
  function syncChecking(source: Any): boolean {
    if (!source || source.connecting) return false;
    if (state.syncPressed[String(source.id)]) return true;
    const manual = source.lastManualSync;
    return !!manual && typeof manual === 'object' && manual.outcome === 'checking';
  }

  /** The source carries a finished Sync now result (checked, failed or busy). */
  function syncResult(source: Any): boolean {
    const manual = source && source.lastManualSync;
    return !!manual && typeof manual === 'object' && ['checked', 'failed', 'busy'].indexOf(manual.outcome) >= 0;
  }

  /** "Checking…": disabled and busy while the press's sync runs. */
  function checkingControl(key: string): HTMLElement {
    const busy = button(P.syncChecking, key, null, 'plain');
    busy.setAttribute('aria-busy', 'true');
    return add(el('span', 'fix'), busy);
  }

  /** The engine's line already names the last sync ("synced 1h ago", "Synced 1 hr ago · …"). */
  function saysSynced(detail: string): boolean {
    const word = P.synced.split('{')[0]!.trim().toLowerCase();
    return !!word && detail.trim().toLowerCase().indexOf(word + ' ') === 0;
  }

  /**
   * A stalled source whose reason the engine did not send still gets a line:
   * its Needs-you reason, else its own detail, else "Paused". Never a blank
   * row (review 2026-10-09, bug 1: a signed-out Dropbox showed none).
   */
  function pauseFallback(item: Any, source: Any): string {
    const reason = item ? itemReason(item, source) : '';
    const detail = typeof source.detail === 'string' ? source.detail : '';
    const progress = source && source.progress;
    const why = progress && progress.stalled ? stallLines(progress.stall, source)[0] : '';
    return capitalise(reason || detail || why || P.sourcePaused);
  }

  /**
   * A stalled source's See why, in sentences (owner rule, 2026-10-10: never
   * say something is wrong without a way to find out exactly what it is):
   * why, from the engine's closed words; how many tries failed; when it last
   * worked and tries again; and for a failure Olympus could not classify,
   * the reference its log keeps the error under. [] when the engine sent no
   * detail (an older engine).
   */
  function stallLines(stall: Any, source: Any): string[] {
    if (!stall || typeof stall !== 'object') return [];
    const label = String(source.label || '');
    const lines: string[] = [];
    const stage = (P.sourceStages as Any)[stall.stage] || P.findingItems;
    const failure = typeof stall.failure === 'string' && Object.prototype.hasOwnProperty.call(P.sourceFailures, stall.failure)
      ? stall.failure : '';
    const failures = Number(stall.failures) || 0;
    const stillSeconds = Number(stall.stillSeconds);
    if (stall.cause === 'failing' || stall.cause === 'paused') {
      if (failure) lines.push(fill((P.sourceFailures as Any)[failure], { source: label }));
      if (stall.cause === 'failing' && failures > 0) {
        lines.push(failures === 1 ? P.stallWhy.failedOnce : fill(P.stallWhy.failedMany, { count: count(failures) }));
      }
    } else if (stall.cause === 'switched_off') {
      lines.push(fill(P.stallWhy.switchedOff, { stage }));
    } else if (stall.cause === 'no_movement') {
      lines.push(isFinite(stillSeconds) && stillSeconds > 0
        ? fill(P.stallWhy.stillFor, { stage, duration: duration(stillSeconds) })
        : fill(P.stallWhy.still, { stage }));
    } else return [];
    const worked = typeof stall.lastWorkedAt === 'string' ? ago(stall.lastWorkedAt) : '';
    if (worked) lines.push(fill(P.stallWhy.lastWorked, { when: worked }));
    const next = typeof stall.nextTryAt === 'string' ? Date.parse(stall.nextTryAt) - Date.now() : NaN;
    if (isFinite(next) && next > 0) lines.push(fill(P.stallWhy.nextTry, { duration: duration(next / 1000) }));
    if (failure === 'unknown' && typeof stall.ref === 'string' && /^[0-9a-f]{16}$/.test(stall.ref)) {
      lines.push(fill(P.failureRef, { ref: stall.ref }));
    } else if (failure === 'unknown') {
      lines.push(P.failureLog);
    } else if (stall.cause === 'no_movement') {
      lines.push(P.stallWhy.watchLog);
    }
    return lines;
  }

  /** A source's progress while a stage is unfinished, else null. */
  function sourceProgress(source: Any): Any {
    const progress = source && source.progress;
    if (!progress || typeof progress !== 'object' || source.connecting) return null;
    if (progress.stage === 'done' && !progress.stalled) return null;
    return progress;
  }

  function stalledSentence(progress: Any, source: Any): string {
    if (!progress.stalled || !progress.stalledReason) return '';
    const words = (P.stalledReasons as Any)[progress.stalledReason];
    if (progress.stalledReason === 'scope_root_missing' && onComputer()) {
      const missing = state.computerMeta?.missingFolders;
      const paths = Array.isArray(missing) ? missing.find((entry: Any) => entry.sourceId === source.id)?.paths : undefined;
      if (Array.isArray(paths) && paths.length) return String(words) + ': ' + paths.filter((path: Any) => typeof path === 'string').join(', ');
    }
    return typeof words === 'string' ? fill(words, { source: String(source.label || '') }) : '';
  }

  function sourceProgressLabel(progress: Any): string {
    const total = Number(progress.total) || 0;
    if (progress.percent === undefined && progress.stage !== 'listing') return (P.sourceStages as Any)[progress.stage] || P.findingItems;
    if (total <= 0) return foundSoFar(progress.stage === 'listing' ? progress.done : 0, progress.unit);
    const stage = (P.sourceStages as Any)[progress.stage] || P.findingItems;
    return fill(P.sourceProgress, {
      stage,
      percent: percent(progress.percent),
      done: count(progress.done),
      total: count(total),
      unit: unitWord(progress.unit, total),
    });
  }

  /**
   * Listing before any total is known: how many were found so far, never a
   * percentage (the dashboard metric ruling). Nothing found yet says only that
   * it is finding.
   */
  function foundSoFar(found: Any, unit: Any): string {
    const n = Number(found) || 0;
    if (n <= 0) return P.findingItems;
    const words = (P.units as Any)[unit] || P.units.items;
    return fill(P.findingFound, { unit: words.many, done: count(n) });
  }

  /** A bar with no end to measure against: it moves, and carries no value. */
  function indeterminateBar(label: string): HTMLElement {
    const bar = el('div', 'bar indeterminate');
    bar.setAttribute('role', 'progressbar');
    bar.setAttribute('aria-label', label);
    return add(bar, el('div', 'bar-fill'));
  }

  /**
   * Under the row's name: the stage line (the row's detail) over a thin bar.
   * Stalled: only the pause sentence, with an amber bar when there is real
   * progress to show.
   */
  function sourceProgressBlock(progress: Any, source: Any, stalledWords: string): HTMLElement {
    const box = el('div', progress.stalled ? 'source-progress stalled' : 'source-progress');
    const name = String(source.label || '');
    if (progress.stalled) {
      const real = (Number(progress.total) || 0) > 0 && (Number(progress.percent) || 0) > 0 && progress.stage !== 'done';
      if (stalledWords) add(box, el('p', 'stall-line', stalledWords));
      // A Mac that will not open a chosen folder: the page that turns it on (the computer's own pages only).
      const fixes = progress.stalledReason === 'scope_root_permission_needed' && onComputer() && state.computerMeta && Array.isArray(state.computerMeta.permissionSettings)
        ? state.computerMeta.permissionSettings.filter((entry: Any) => entry && entry.sourceId === source.id && typeof entry.url === 'string' && entry.url.indexOf('x-apple.systempreferences:') === 0) : [];
      if (fixes.length) {
        const link = el('a', 'btn', config.picker.copy.openPrivacySettings) as HTMLAnchorElement;
        link.href = String(fixes[0].url);
        link.setAttribute('data-key', 'source:' + String(source.id) + ':privacy-settings');
        add(box, add(el('div', 'actions'), link));
      }
      if (real) add(box, progressBar(progress.percent, name + ': ' + (stalledWords || sourceProgressLabel(progress))));
      return box;
    }
    const label = sourceProgressLabel(progress);
    add(box, el('p', 'muted', label));
    // A listing with no total has no percentage, even from an engine that still
    // sends 0: only a sized folder walk (a real percent) draws a filled bar.
    const unsized = progress.stage === 'listing' && (Number(progress.total) || 0) <= 0 && !(Number(progress.percent) > 0);
    if (unsized) add(box, indeterminateBar(name + ': ' + label));
    else if (progress.percent !== undefined) add(box, progressBar(progress.percent, name + ': ' + label));
    return box;
  }

  /**
   * The page-wide line repeats a single source's bar, so it shows only when
   * two or more sources are working (or no source reports its own progress).
   */
  function progressRepeatsOneRow(sources: Any[]): boolean {
    const reporting = sources.filter((source: Any) => source && source.progress && typeof source.progress === 'object');
    if (!reporting.length) return false;
    // A stalled source is waiting, not working: its row's pause sentence covers it.
    return sources.filter((source: Any) => { const progress = sourceProgress(source); return !!progress && !progress.stalled; }).length < 2;
  }

  /** "link expires in N min" from the connect attempt's expiry. */
  function linkExpiry(iso: Any): string {
    const at = typeof iso === 'string' ? Date.parse(iso) : NaN;
    if (!isFinite(at)) return '';
    const left = at - Date.now();
    if (left <= 0) return P.linkExpired;
    return fill(P.linkExpires, { n: Math.max(1, Math.ceil(left / 60000)) });
  }

  /** The reason half of an item's sentence ("Gmail — signed out" → "signed out"), else the source's detail. */
  function itemReason(item: Any, source: Any): string {
    const sentence = String(item.sentence || '');
    const prefix = String(source.label || '') + ' — ';
    if (sentence.indexOf(prefix) === 0) return sentence.slice(prefix.length);
    return typeof source.detail === 'string' && source.detail ? source.detail : sentence;
  }

  function capitalise(text: string): string {
    return text ? text.charAt(0).toUpperCase() + text.slice(1) : text;
  }

  function isArchivesCard(source: Any): boolean {
    return !!source && String(source.id) === config.archivesSourceId;
  }

  /**
   * Below Sources: the Archives card, for an export that is not from one of the
   * sources above (owner, 2026-10-25). Its button imports any export and still
   * routes one to its source when a source reads it; a source's own exports are
   * imported from that source's ⋯ menu.
   */
  function otherArchivesSection(source: Any): HTMLElement | null {
    if (!source) return null;
    const section = add(el('section', 'section other-archives'), el('h2', '', P.otherArchives.title));
    return add(section, add(el('ul', 'rows'), sourceRow(source, true)));
  }

  function sourcesSection(sources: Any[]): HTMLElement {
    const section = add(el('section', 'section'), el('h2', '', P.sources));
    if (!sources.length) return add(section, el('p', 'muted', P.noSources));
    // One list, no group headings (owner, 2026-10-09): sources that need the
    // owner first, then connected ones, then the ones not connected yet, each
    // in server order.
    const off = (source: Any) => String(source && source.status) === 'Off' && !sourceItem(source);
    const ordered = sources.filter((source) => sourceItem(source))
      .concat(sources.filter((source) => !sourceItem(source) && !off(source)))
      .concat(sources.filter((source) => !sourceItem(source) && off(source)));
    const list = el('ul', 'rows');
    for (const source of ordered) add(list, sourceRow(source));
    return add(section, list);
  }

  function openPrivacy(returnKey: string): void {
    if (!privacy) return;
    state.notice = '';
    supersede();
    state.confirming = '';
    privacy.start(returnKey);
  }

  /**
   * The Privacy row, after Sources. Until privacy is set up its Needs-you item
   * says so and carries the one call to action, so the row then shows only
   * what is waiting to be checked, if anything.
   */
  function privacySection(data: Any): HTMLElement | null {
    const info = data && data.privacy && typeof data.privacy === 'object' ? data.privacy : null;
    if (!info || !privacy) return null;
    const W = config.privacy.copy;
    const configured = info.configured === true;
    const pending = typeof info.pendingCount === 'number' && isFinite(info.pendingCount) ? Math.max(0, Math.round(info.pendingCount)) : 0;
    const asked = (Array.isArray(data.needsYou) ? data.needsYou : [])
      .some((item: Any) => item && item.fix && privacy!.handles(item.fix));
    if (!configured && (asked || !pending)) return null;
    const section = add(el('section', 'section privacy-row'), el('h2', '', W.section));
    const row = el('li', 'row');
    const text = el('div', 'row-text');
    if (configured) {
      const rules = typeof info.ruleCount === 'number' && isFinite(info.ruleCount) ? Math.max(0, Math.round(info.ruleCount)) : state.privacyRules;
      const words = rules === 0 ? W.row.none : rules === 1 ? W.row.one : W.row.many;
      add(text, el('p', '', rules >= 0 ? fill(words, { n: count(rules) }) : W.rowNoCount));
    }
    if (pending > 0) add(text, el('p', 'muted', fill(pending === 1 ? W.dashboardPending.one : W.dashboardPending.many, { n: count(pending) })));
    add(row, text);
    if (configured) {
      const blocked = globalReason();
      const edit = button(W.edit, 'privacy:edit', blocked ? null : () => openPrivacy('privacy:edit'), 'plain');
      edit.setAttribute('aria-label', W.editLabel);
      add(row, blocked ? add(el('span', 'fix'), edit, rowReason(blocked)) : edit);
    }
    return add(section, add(el('ul', 'rows'), row));
  }

  /** Work cannot move while the Mac is unreachable: no items left, no ETA. */
  function progressPaused(): boolean {
    const current = connectionState();
    return current === 'mac_offline' || current === 'relay_unavailable';
  }

  /** No total known yet: every stage still counting from zero. */
  function totalUnknown(progress: Any): boolean {
    const stages = Array.isArray(progress.details) ? progress.details : [];
    if (stages.length === 0) return false;
    if (stages.every((stage: Any) => !(Number(stage && stage.total) > 0))) return true;
    // Another source is still on its first walk (listing leads the details and
    // has no total): the page-wide line has no percent, so it says what was found.
    return progress.percent === undefined && progress.itemsLeft === undefined && !(Number(stages[0] && stages[0].total) > 0);
  }

  /** Nothing left and nothing stuck: the line has nothing to say. */
  function progressFinished(progress: Any): boolean {
    return !!progress && progress.itemsLeft !== undefined && !progress.stalled && !totalUnknown(progress)
      && (Number(progress.itemsLeft) || 0) <= 0;
  }

  function progressText(progress: Any): string {
    const phase = progress.phase === 'initial' ? P.progressInitial : P.progressRefresh;
    if (totalUnknown(progress)) {
      const paused = progressPaused() ? ', ' + P.progressPaused : progress.stalled ? ', ' + stalledNames() : '';
      const first = Array.isArray(progress.details) ? progress.details[0] : undefined;
      return phase + ': ' + foundSoFar(first && first.done, progress.unit) + paused;
    }
    const parts = progress.percent === undefined ? [P.sourceStages.indexing] : [fill(P.percentDone, { percent: percent(progress.percent) })];
    if (progressPaused()) {
      parts.push(P.progressPaused);
      return (progress.phase === 'initial' ? P.progressInitial : P.progressRefresh) + ': ' + parts.join(', ');
    }
    const left = Number(progress.itemsLeft) || 0;
    if (progress.itemsLeft !== undefined) parts.push(fill(P.left, { count: count(left), unit: unitWord(progress.unit, left) }));
    if (typeof progress.etaSeconds === 'number' && progress.etaSeconds > 0 && !progress.stalled) {
      parts.push(fill(P.eta, { duration: duration(progress.etaSeconds) }));
    }
    if (progress.stalled) parts.push(stalledNames());
    return (progress.phase === 'initial' ? P.progressInitial : P.progressRefresh) + ': ' + parts.join(', ');
  }

  /**
   * Which sources stopped, for the page-wide line ("Dropbox and Gmail
   * paused"); each row's See why says why. A bare "stalled" only when no
   * row reports one.
   */
  function stalledNames(): string {
    const sources = state.data && Array.isArray(state.data.sources) ? state.data.sources : [];
    const names = sources
      .filter((source: Any) => source && source.progress && source.progress.stalled && !source.connecting && typeof source.label === 'string' && source.label)
      .map((source: Any) => String(source.label));
    if (!names.length) return P.stalled;
    let list: string;
    if (names.length === 1) list = names[0]!;
    else if (names.length === 2) list = fill(P.stalledAnd, { first: names[0]!, last: names[1]! });
    else list = fill(P.stalledAnd, { first: names[0] + ', ' + names[1], last: fill(P.stalledMore, { count: count(names.length - 2) }) });
    return fill(P.stalledSources, { sources: list });
  }

  function progressSection(progress: Any, withDetails: boolean): HTMLElement | null {
    if (!progress || progressFinished(progress)) return null;
    const section = add(el('section', 'section'), el('h2', '', P.progress));
    const stalled = progress.stalled && !progressPaused();
    const line = el('p', stalled ? 'progress-line stalled' : progressPaused() ? 'progress-line paused' : 'progress-line', progressText(progress));
    add(section, line);
    if (progress.percent !== undefined) add(section, progressBar(progress.percent, P.progress));
    else if (totalUnknown(progress) && !stalled && !progressPaused()) add(section, indeterminateBar(P.progress));
    const stages = Array.isArray(progress.details) ? progress.details : [];
    const faster = indexFasterControl();
    if (withDetails && (stages.length || faster)) {
      const box = details('progress-details', doc.createTextNode(P.details), 'disclosure');
      const list = el('ul', 'plain');
      stages.forEach((stage: Any) => add(list, el('li', '', fill(P.stageLine, {
        stage: String(stage.stage || ''),
        done: count(stage.done),
        total: count(stage.total),
        unit: unitWord(stage.unit, Number(stage.total) || 0),
      }))));
      add(section, add(box, stages.length ? list : null, faster));
    }
    return section;
  }

  /** A source is indexing right now (its first unfinished stage is indexing, and it is moving). */
  function indexingRuns(): boolean {
    const sources = state.data && Array.isArray(state.data.sources) ? state.data.sources : [];
    return sources.some((source: Any) => {
      const progress = sourceProgress(source);
      return !!progress && progress.stage === 'indexing' && !progress.stalled;
    });
  }

  /** Computer only, while indexing runs: Index faster (or Stop), with what it costs. */
  /** The computer's Unpair for this paired chat app, with the engine's own confirmation, or null. */
  function unpairEntry(id: string): Any {
    const meta = state.computerMeta;
    if (!onComputer() || !meta || !Array.isArray(meta.unpair)) return null;
    const entry = meta.unpair.filter((item: Any) => item && item.sourceId === id)[0];
    if (!entry || typeof entry.label !== 'string' || typeof entry.confirmation !== 'string') return null;
    return { label: entry.label, tool: H.unpairTool, args: { source_id: id }, destructive: true, confirmText: entry.confirmation };
  }

  function indexFasterShown(): boolean {
    const meta = state.computerMeta;
    return onComputer() && !!meta && !!meta.indexFaster && typeof meta.indexFaster.on === 'boolean' && indexingRuns();
  }

  function indexFasterControl(): HTMLElement | null {
    if (!indexFasterShown()) return null;
    const on = state.computerMeta.indexFaster.on === true;
    const W = H.copy.indexFaster;
    const fix = { label: on ? W.off : W.on, tool: H.indexFasterTool, args: { on: !on } };
    return add(el('div', 'actions index-faster'), fixControl(fix, 'index-faster', 'plain', false), el('span', 'reason', on ? W.explainOff : W.explainOn));
  }

  /**
   * One model's install: the search model's from models.embedding, the
   * private model's from models.answers.install. Its fields are optional and
   * crossed the wire, so each is checked. Null when it is not installing or
   * failed.
   */
  function modelInstall(models: DashboardModels, which: 'search' | 'answers' | 'transcription'): ModelInstallLine | null {
    const source: Partial<ModelInstall> | undefined = which === 'search'
      ? models.embedding
      : which === 'answers' ? (models.answers ? models.answers.install : undefined) : models.transcription as Partial<ModelInstall> | undefined;
    if (!source || typeof source !== 'object') return null;
    const stateName = source.state;
    if (stateName !== 'downloading' && stateName !== 'verifying' && stateName !== 'failed') return null;
    const number = (value: unknown) => (typeof value === 'number' && isFinite(value) && value >= 0 ? value : -1);
    const reason = source.failedReason;
    return {
      which,
      state: stateName,
      percent: number(source.percent),
      done: number(source.bytesDone),
      total: number(source.bytesTotal),
      reason: typeof reason === 'string' && Object.prototype.hasOwnProperty.call(P.modelInstallReasons, reason) ? reason : 'unknown',
    };
  }

  /** "1.2 of 3.0 GB", in the total's unit. */
  function installBytes(done: number, total: number): string {
    const units: Array<[number, string]> = [[1e12, 'TB'], [1e9, 'GB'], [1e6, 'MB'], [1e3, 'KB']];
    const [scale, unit] = units.filter(([size]) => total >= size)[0] || [1, 'bytes'];
    const shown = (value: number) => (scale === 1 ? String(Math.round(value)) : (value / scale).toFixed(1));
    return fill(P.modelInstallBytes, { done: shown(Math.min(done, total)), total: shown(total) + ' ' + unit });
  }

  function modelWords(models: DashboardModels): { summary: string; search: string; answers: string } {
    const embedding = models.embedding;
    const kind = embedding.kind === 'built_in' ? P.modelBuiltIn : P.modelCustom;
    let ready: string = P.modelReady;
    if (embedding.state === 'downloading') ready = fill(P.modelDownloading, { percent: percent(embedding.percent ?? 0) });
    else if (embedding.state === 'verifying') ready = P.modelChecking;
    else if (embedding.state === 'failed') ready = notWorking(embedding.failedReason);
    const answers = models.answers;
    const answersWords = answers ? String(answers.label || '') + ' · ' + (answers.ready ? P.modelReady : P.modelNotReady) : '';
    const installs = installLines(models);
    let overall: string = ready;
    const transcription = models.transcription && typeof models.transcription === 'object' ? models.transcription : null;
    if (installs.some((entry) => entry.state === 'failed') || (transcription && transcription.state === 'load_failed')) overall = P.modelNeedsYou;
    else if (installs.length) overall = P.modelGettingReady;
    else if (embedding.state === 'ready' && answers && !answers.ready) overall = P.modelNotReady;
    return { summary: P.models + ' — ' + kind + ' · ' + overall, search: kind + ' · ' + ready, answers: answersWords };
  }

  /** "Not working: the disk is full" when the failure says why, else "Not working". */
  function notWorking(reason: Any): string {
    const words = typeof reason === 'string' && Object.prototype.hasOwnProperty.call(P.modelInstallReasons, reason)
      ? (P.modelInstallReasons as Any)[reason] : '';
    return words ? fill(P.modelNotWorkingBecause, { reason: words }) : P.modelNotWorking;
  }

  /** "Couldn't start the transcription model: it took too long to start". */
  function couldNotStart(model: string, reason: Any): string {
    const words = (P.modelLoadFailedReasons as Any)[typeof reason === 'string' && Object.prototype.hasOwnProperty.call(P.modelLoadFailedReasons, reason) ? reason : 'unknown'];
    return fill(P.modelCouldNotStartBecause, { model, reason: words });
  }

  /** The transcription model's words after "Transcription:", or '' when the view model has none. */
  function transcriptionWords(models: DashboardModels): string {
    const entry = models.transcription;
    if (!entry || typeof entry !== 'object') return '';
    switch (entry.state) {
      case 'not_needed': return P.modelNotNeededNoAudio;
      case 'not_downloaded': return P.modelNotDownloaded;
      case 'interrupted': return P.modelDownloadInterrupted;
      case 'load_failed': return couldNotStart(P.modelNames.transcription, entry.loadFailedReason);
      case 'ready': return P.modelBuiltIn + ' · ' + P.modelReady;
      case 'failed': return P.modelBuiltIn + ' · ' + notWorking(entry.failedReason);
      case 'verifying': return P.modelBuiltIn + ' · ' + P.modelChecking;
      case 'downloading': return P.modelBuiltIn + ' · ' + P.modelGettingReady;
      default: return '';
    }
  }

  /** "Transcription: …" with its Download now, the third line inside Models. */
  function transcriptionItem(models: DashboardModels): HTMLElement | null {
    const words = transcriptionWords(models);
    if (!words) return null;
    const item = el('li', '', P.modelTranscription + ': ' + words + ' ');
    const fix = models.transcription && models.transcription.download;
    if (fix) add(item, fixControl(fix, 'models:transcription', 'plain', false));
    return item;
  }

  /**
   * Change models: status only in ChatGPT (disabled, with its reason). On the
   * computer it is enabled and opens the local models page (its own href,
   * which the computer host maps there).
   */
  function changeModelsFix(fix: Any): Any {
    if (!onComputer() || !fix || !helpHref(fix.href)) return fix;
    return { label: fix.label, href: fix.href, openHref: true };
  }

  /** One line per installing model, shown without expanding; the fix lives in Needs you, not here. */
  function installLines(models: DashboardModels): ModelInstallLine[] {
    const lines: ModelInstallLine[] = [];
    for (const which of ['search', 'answers', 'transcription'] as const) {
      const entry = modelInstall(models, which);
      if (entry) lines.push(entry);
    }
    return lines;
  }

  function installLine(entry: ModelInstallLine): HTMLElement {
    const model = P.modelNames[entry.which];
    const line = el('div', 'model-install' + (entry.state === 'failed' ? ' failed' : ''));
    let text: string;
    if (entry.state === 'failed') {
      text = fill(P.modelInstallFailed, { model, reason: P.modelInstallReasons[entry.reason] });
    } else if (entry.state === 'verifying') {
      text = fill(P.modelInstallVerifying, { model });
    } else {
      const parts = [fill(P.modelInstallDownloading, { model })];
      if (entry.percent >= 0) parts.push(percent(entry.percent) + '%');
      if (entry.total > 0 && entry.done >= 0) parts.push(installBytes(entry.done, entry.total));
      text = parts.join(' · ');
    }
    add(line, el('p', '', text));
    if (entry.state !== 'failed' && entry.percent >= 0) add(line, progressBar(entry.percent, text));
    return line;
  }

  function modelsSection(models: DashboardModels | undefined): HTMLElement | null {
    if (!models || !models.embedding) return null;
    const words = modelWords(models);
    const box = details('models', doc.createTextNode(words.summary), 'section models');
    const list = add(el('ul', 'plain'), el('li', '', P.modelSearch + ': ' + words.search));
    if (words.answers) add(list, el('li', '', P.modelAnswers + ': ' + words.answers));
    add(list, transcriptionItem(models));
    add(box, list);
    if (models.change) add(box, add(el('div', 'actions'), fixControl(changeModelsFix(models.change), 'models:change', 'plain', true)));
    // A failed search or private-model install is said once, in Needs you with
    // its Try again; transcription has no Needs-you item, so its line stays.
    const installs = installLines(models).filter((entry) => entry.state !== 'failed' || entry.which === 'transcription');
    if (!installs.length) return box;
    const wrap = add(el('div', 'models-wrap'), box);
    const lines = el('div', 'model-installs');
    for (const entry of installs) add(lines, installLine(entry));
    return add(wrap, lines);
  }

  /** The inline card: the single most important thing, the progress line, and Open Olympus. */
  function renderCompact(): HTMLElement {
    const card = el('div', 'card compact');
    const data = state.data;
    const top = connectionBanner()
      || (data && data.blocker ? itemBanner(data.blocker, 'blocker', false) : null)
      || (data && data.needsYou && data.needsYou[0] ? itemBanner(data.needsYou[0], 'need:' + String(data.needsYou[0].id || 0), false) : null);
    add(card, top);
    if (!top && !data) add(card, el('p', 'muted', P.loading));
    if (data && data.progress && !state.relayDown && !progressFinished(data.progress)) add(card, el('p', 'progress-line', progressText(data.progress)));
    else if (!top && data) add(card, el('p', '', P.upToDate));
    if (state.canFullscreen) {
      const buttons = card.querySelectorAll('button').length;
      if (buttons < 2) add(card, add(el('div', 'actions'), button(P.openOlympus, 'open', goFullscreen, 'plain')));
    }
    return card;
  }

  function renderFull(): HTMLElement {
    const page = el('main', 'page');
    add(page, el('h1', '', P.title));
    const data = state.data;
    add(page, connectionBanner());
    if (state.notice) {
      const notice = el('p', 'notice', state.notice);
      notice.setAttribute('role', 'status');
      add(page, notice);
    }
    if (!data) {
      if (!state.relayDown) add(page, el('p', 'muted', P.loading));
      return page;
    }
    add(page, data.blocker ? itemBanner(data.blocker, 'blocker', true) : null);
    add(page, staleLine());
    // Each fact once: an item about a listed source lives in that source's row, not here too.
    const listed = Array.isArray(data.sources) ? data.sources : [];
    add(page, needsYouSection((Array.isArray(data.needsYou) ? data.needsYou : [])
      .filter((item: Any) => item && !listed.some((source: Any) => aboutSource(item, source)))));
    // The Archives card has its own section below Sources: exports that are not from one of them.
    const allSources = Array.isArray(data.sources) ? data.sources : [];
    add(page, sourcesSection(allSources.filter((source: Any) => !isArchivesCard(source))));
    add(page, otherArchivesSection(allSources.filter(isArchivesCard)[0]));
    add(page, privacySection(data));
    const sourceList = Array.isArray(data.sources) ? data.sources : [];
    add(page, progressRepeatsOneRow(sourceList) && !indexFasterShown() ? null : progressSection(data.progress, true));
    add(page, modelsSection(data.models));
    add(page, computerSection());
    add(page, moreOnComputer());
    return page;
  }

  /**
   * Away from the computer (ChatGPT, OpenClaw), one quiet line in place of
   * the On this computer section: what lives only there, and Open on the
   * view model's `computerControls` page. Not while the whole page waits on
   * the connection. In remote mode Open shows the tunnel instructions in
   * place, as howLink does.
   */
  function moreOnComputer(): HTMLElement | null {
    if (onComputer() || GLOBAL_STATES.indexOf(connectionState()) >= 0) return null;
    const href = helpHref(state.data.computerControls && state.data.computerControls.href);
    if (!href) return null;
    const key = 'more-on-computer';
    const line = add(el('div', 'section more-on-computer'), el('p', 'muted', P.moreOnComputer));
    const remote = remoteMode();
    const open = button(P.moreOnComputerOpen, key, remote ? () => toggleRemote(key) : () => openLink(href), 'plain');
    open.className = 'btn link';
    open.setAttribute('aria-label', P.moreOnComputerOpenLabel);
    if (remote) open.setAttribute('aria-expanded', state.open['remote:' + key] ? 'true' : 'false');
    return add(line, open, remote ? remoteBox(key, href) : null);
  }

  /**
   * Computer only, at the end: what can't work through ChatGPT (keys, agents,
   * outside help, building a connector), each opening its local page.
   */
  function computerSection(): HTMLElement | null {
    if (!onComputer()) return null;
    const W = H.copy;
    const keys = ['keys', 'agents', 'privateAnswers', 'connector'].filter((key) => !!state.hostLinks[key]);
    if (!keys.length) return null;
    const heading = add(el('h2'), doc.createTextNode(W.section + ' '), el('span', 'tag', W.onlyHere));
    const section = add(el('section', 'section on-computer'), heading);
    const list = el('ul', 'rows');
    for (const key of keys) {
      const words = (W.rows as Any)[key];
      const text = add(el('div', 'row-text'), el('p', '', words.title), el('p', 'muted', words.line));
      const href = state.hostLinks[key]!;
      const open = button(W.open, 'computer:' + key, () => openLink(href), 'plain');
      open.setAttribute('aria-label', W.open + ' ' + words.title);
      add(list, add(el('li', 'row'), text, open));
    }
    return add(section, list);
  }

  // ---- render ------------------------------------------------------------
  function render(focusKey?: string): void {
    const active = doc.activeElement as HTMLElement | null;
    const keepFocus = focusKey || (active && active.getAttribute ? active.getAttribute('data-key') : '') || '';
    // A text field redrawn under the person keeps its caret and selection.
    const field = active && (active.tagName === 'TEXTAREA' || active.tagName === 'INPUT') && keepFocus === active.getAttribute('data-key')
      ? active as HTMLInputElement : null;
    const selection = field && typeof field.selectionStart === 'number'
      ? [field.selectionStart, field.selectionEnd === null ? field.selectionStart : field.selectionEnd] : null;
    const theme = state.theme;
    if (theme) doc.documentElement.setAttribute('data-theme', theme);
    else doc.documentElement.removeAttribute('data-theme');
    // The picker draws over the Privacy screen while it picks a folder for it.
    const picking = !!picker && picker.active();
    const privacyOpen = !picking && !!privacy && privacy.active();
    doc.documentElement.setAttribute('data-mode', compact() && !picking && !privacyOpen ? 'inline' : 'fullscreen');
    accentUsed = false;
    const view = picking ? picker!.view() : privacyOpen ? privacy!.view() : compact() ? renderCompact() : renderFull();
    root.textContent = '';
    root.appendChild(view);
    if (picking) picker!.afterRender();
    if (keepFocus) {
      const nodes = root.querySelectorAll('[data-key]');
      for (let i = 0; i < nodes.length; i++) {
        const node = nodes[i] as HTMLElement;
        if (node.getAttribute('data-key') === keepFocus) {
          node.focus();
          if (selection && (node.tagName === 'TEXTAREA' || node.tagName === 'INPUT')) {
            try { (node as HTMLInputElement).setSelectionRange(selection[0]!, selection[1]!); } catch { /* not a text field */ }
          }
          break;
        }
      }
    }
    reportHeight();
    if (state.landing && !picking && !privacyOpen) applyLanding();
  }

  function reportHeight(): void {
    const height = Math.ceil(doc.documentElement.scrollHeight || doc.body.scrollHeight || 0);
    const host = openai();
    if (host && typeof host.notifyIntrinsicHeight === 'function') host.notifyIntrinsicHeight(height);
    notify('ui/notifications/size-changed', { height });
  }

  // ---- picker ------------------------------------------------------------
  const picker: ChatGptPicker | null = pickerProgram ? pickerProgram({
    config: config.picker,
    dashboardTool: config.toolName,
    el,
    add,
    button,
    fill,
    count,
    call: callRaw,
    render,
    reportHeight,
    openLink,
    compact,
    fullscreen: goFullscreen,
    isDashboard,
    errorText: inlineError,
    showModels: () => {
      state.open.models = true;
      closeScreen('', false, 'summary:models');
    },
    // An Olympus host starts sign-in on the computer itself, so its link is
    // the provider's own page, not a one-time mcp.olympusplugin.ai link.
    directSignIn: () => state.hostKind !== '',
    setDashboard: (value: Any) => {
      if (!isDashboard(value)) return;
      // The Connect flow's own read is newer than anything still in flight.
      supersede();
      state.data = value;
      state.relayDown = false;
      refreshFailures = 0;
    },
    close: (notice: string, again: boolean, focusKey: string) => closeScreen(notice, again, focusKey),
  }) : null;

  /** Back to the dashboard from the picker or the Privacy screen. */
  function closeScreen(notice: string, again: boolean, focusKey: string): void {
    state.notice = notice;
    if (again) {
      // The dashboard re-renders from the refreshed result; the notice stays until the next action.
      const mine = supersede();
      state.busy = 'refresh';
      render(focusKey);
      request('tools/call', { name: config.toolName, arguments: {} }, config.resultTimeoutMs).then((result) => {
        if (state.busy === 'refresh') state.busy = '';
        if (mine !== generation) return redraw();
        acceptResult(result, false);
        if (!editorOpen()) render(focusKey);
      }, () => {
        if (state.busy === 'refresh') state.busy = '';
        if (!editorOpen()) render(focusKey);
      });
      return;
    }
    render(focusKey);
  }

  // ---- privacy -----------------------------------------------------------
  // Built after the picker, whose Escape handler runs first while it picks a folder.
  const privacy: ChatGptPrivacy | null = privacyProgram ? privacyProgram({
    config: config.privacy,
    el,
    add,
    button,
    fill,
    count,
    call: callRaw,
    render,
    compact,
    fullscreen: goFullscreen,
    data: () => state.data,
    picker,
    remember: (rules: number) => {
      state.privacyRules = rules;
    },
    close: (notice: string, again: boolean, focusKey: string) => closeScreen(notice, again, focusKey),
  }) : null;

  // ---- freshness ---------------------------------------------------------
  // While the page is visible it re-reads the dashboard on its own, so
  // progress, an offline Mac coming back and "Updated … ago" never freeze.
  // Hidden pages do nothing until they are shown again.
  const R = config.refresh;
  let refreshTimer: Any = null;
  let refreshing = false;
  let refreshFailures = 0;
  let nextRefreshAt = 0;
  let drawnStale = '';

  function pageHidden(): boolean {
    return doc.visibilityState === 'hidden' || doc.hidden === true;
  }

  /** Something is moving or not settled, so the page checks often. */
  function moving(): boolean {
    const data = state.data;
    if (!data || state.relayDown || String(data.connection.state) !== 'ready') return true;
    const sources = Array.isArray(data.sources) ? data.sources : [];
    if (sources.some((source: Any) => {
      if (!source || typeof source !== 'object') return false;
      if (source.connecting || source.status === 'Working' || syncChecking(source)) return true;
      const progress = sourceProgress(source);
      return !!progress && !progress.stalled;
    })) return true;
    if (data.progress && !data.progress.stalled && !progressFinished(data.progress)) return true;
    if (archivesMoving()) return true;
    return !!data.models && !!data.models.embedding && installLines(data.models).some((entry) => entry.state !== 'failed');
  }

  /** A source whose Delete indexed data ran and whose row still offers it (or is not yet read again). */
  function deletePending(): boolean {
    return Object.keys(state.deleting).length > 0;
  }

  /** Drops a source from the wait once its row no longer offers Delete indexed data, or the wait ran out. */
  function settleDeleting(data: Any): void {
    const sources = data && Array.isArray(data.sources) ? data.sources : [];
    for (const id of Object.keys(state.deleting)) {
      const row = sources.filter((source: Any) => source && source.id === id)[0];
      const offered = !!row && Array.isArray(row.menu)
        && row.menu.some((fix: Any) => fix && fix.tool === config.deleteDataTool);
      if (!offered || Date.now() >= (state.deleting[id] ?? 0)) delete state.deleting[id];
    }
  }

  function refreshDelay(): number {
    const base = deletePending() ? R.settleMs : moving() ? R.activeMs : R.idleMs;
    return refreshFailures ? Math.min(R.maxBackoffMs, base * Math.pow(2, refreshFailures)) : base;
  }

  function scheduleRefresh(): void {
    if (refreshTimer) clearTimeout(refreshTimer);
    refreshTimer = null;
    const wait = refreshDelay();
    nextRefreshAt = Date.now() + wait;
    if (!pageHidden()) refreshTimer = setTimeout(backgroundRefresh, wait);
  }

  function backgroundRefresh(): void {
    refreshTimer = null;
    if (pageHidden() || refreshing) return;
    // The picker polls on its own while sign-in finishes, and the picker and
    // Privacy screens re-read the dashboard when they close; a control's own
    // call is in flight while busy. None of them gets a second poller.
    // A destructive confirmation waits for the person, undisturbed.
    if (editorOpen() || state.busy || state.confirming) {
      scheduleRefresh();
      return;
    }
    refreshing = true;
    const mine = generation;
    request('tools/call', { name: config.toolName, arguments: {} }, config.resultTimeoutMs).then((result) => {
      refreshing = false;
      // Something newer happened while this was in flight: its answer is stale.
      if (mine !== generation) return scheduleRefresh();
      const ok = !!result && !result.isError && isDashboard(result.structuredContent);
      if (!ok) refreshFailures++;
      acceptResult(result, true);
      scheduleRefresh();
    }, (error: Any) => {
      refreshing = false;
      if (mine !== generation) return scheduleRefresh();
      refreshFailures++;
      relayFailed(rejectionFailure(error));
      redraw();
      scheduleRefresh();
    });
  }

  doc.addEventListener('visibilitychange', () => {
    if (pageHidden()) {
      if (refreshTimer) clearTimeout(refreshTimer);
      refreshTimer = null;
      return;
    }
    // Back in view: check at once when a check fell due while hidden.
    if (refreshing || refreshTimer) return;
    const left = nextRefreshAt - Date.now();
    if (left <= 0) backgroundRefresh();
    else refreshTimer = setTimeout(backgroundRefresh, left);
    tickStale();
  });

  /** Redraws when the "Updated … ago" line would read differently, with or without new data. */
  function tickStale(): void {
    if (pageHidden() || compact() || editorOpen()) return;
    if (staleWords() !== drawnStale) render();
  }
  setInterval(tickStale, R.staleTickMs);

  // ---- start -------------------------------------------------------------
  readOpenAiGlobals();
  render();
  scheduleRefresh();
  request('ui/initialize', {
    protocolVersion: '2026-01-26',
    appInfo: { name: 'olympus-dashboard', version: '1' },
    appCapabilities: {},
  }, config.resultTimeoutMs).then((result) => {
    if (result && result.hostContext) applyHostContext(result.hostContext);
    notify('ui/notifications/initialized');
    // ChatGPT delivers the first result itself; an Olympus host has no
    // conversation turn behind it, so the page reads the dashboard once.
    if (state.hostKind && !state.data) refresh();
  }, () => undefined);
  if (!state.data) waitForResult();
}
