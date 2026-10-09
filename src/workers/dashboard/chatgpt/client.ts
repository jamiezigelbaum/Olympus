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
import type { ChatGptPicker, ChatGptPickerConfig, ChatGptPickerKit } from './picker.ts';
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
  DashboardStatusColorToken,
} from '../vocabulary.ts';

export interface ChatGptDashboardClientConfig {
  toolName: string;
  /**
   * Sync now's tool (olympus_sync_source). It answers at once; the row says
   * "Checking …" until the dashboard's `lastManualSync` carries the result.
   */
  syncTool: string;
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
   * redrawn every `staleTickMs` even when nothing new arrives.
   */
  refresh: { activeMs: number; idleMs: number; maxBackoffMs: number; staleTickMs: number };
  /** The in-place Connect flow and folder/mail pickers (picker.ts). */
  picker: ChatGptPickerConfig;
  /** The privacy setup screen and the dashboard's Privacy row (privacy.ts). */
  privacy: ChatGptPrivacyConfig;
  /** Tool error codes whose fixed sentence is shown beside the control that ran the tool. */
  inlineErrorCodes: readonly string[];
}

// Loose shapes: the page validates what it reads instead of trusting a type.
/* eslint-disable @typescript-eslint/no-explicit-any */
type Any = any;

type DashboardModels = DashboardViewModelV1['models'];

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
  } = {
    data: null,
    relayDown: false,
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
  };

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
    if (context.theme === 'light' || context.theme === 'dark') state.theme = context.theme;
    if (typeof context.displayMode === 'string') state.displayMode = context.displayMode;
    if (Array.isArray(context.availableDisplayModes)) {
      state.canFullscreen = context.availableDisplayModes.indexOf('fullscreen') >= 0;
    }
    render();
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
        state.relayDown = true;
        render();
      }
    }, config.resultTimeoutMs);
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
      state.relayDown = true;
      redraw();
      return false;
    }
    const content = result.structuredContent;
    if (isDashboard(content)) {
      state.data = content;
      state.relayDown = false;
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
      state.relayDown = true;
      redraw();
    }
    return false;
  }

  /** The fixed sentence of a tool error the page shows inline, or ''. */
  function inlineError(result: Any): string {
    if (!result || !result.isError) return '';
    const code = result.structuredContent && typeof result.structuredContent.error === 'string' ? result.structuredContent.error : '';
    if (config.inlineErrorCodes.indexOf(code) < 0) return '';
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
      const failed = inlineError(result);
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
      if (acceptResult(result, false)) return;
      if (!state.relayDown && name !== config.toolName) refresh();
    }, () => {
      if (state.busy === key) state.busy = '';
      if (name === config.syncTool) state.syncPressed = {};
      if (mine === generation) state.relayDown = true;
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
    if (typeof href !== 'string' || href.slice(0, 6) !== 'https:') return;
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

  /** "How to fix this on your computer": the fix's help page, beside its control (not on the inline card). */
  function howLink(fix: Any, key: string): HTMLElement | null {
    const href = helpHref(fix && fix.href);
    if (!href || compact()) return null;
    const link = button(P.howOnMac, key + ':how', () => openLink(href), 'plain');
    link.className = 'btn link';
    return link;
  }
  function globalReason(): string {
    const current = connectionState();
    if (GLOBAL_STATES.indexOf(current) < 0) return '';
    return ((C as Any)[current] || C.relay_unavailable).disabledReason;
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
      add(wrap, button(fix.label, key, null, style), el('span', 'reason', blocked || String(fix.disabledReason)));
      // A repair only the computer can make still says how, unless the whole page is waiting.
      if (!blocked) add(wrap, howLink(fix, key));
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
    if (opens) {
      // The control is the link: Connect or Reconnect for a source set up on the computer.
      return add(wrap, button(fix.label, key, () => openLink(opens), style));
    }
    if (privacy && privacy.handles(fix)) {
      // Tell Olympus what's private, and the Privacy row's Edit, open the Privacy screen in place.
      action = () => openPrivacy(key);
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
      // No tool, only a help page: the control is the link to it.
      return add(wrap, button(P.howOnMac, key, () => openLink(helpHref(fix.href)), style));
    }
    if (fix.destructive && action) {
      if (!allowConfirm) return wrap;
      if (state.confirming === key) {
        const run = action;
        wrap.className = 'fix confirm';
        add(
          wrap,
          el('span', 'reason strong', P.confirmPrompt),
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
    return add(wrap, button(fix.label, key, action, style), action && fix.tool ? howLink(fix, key) : null, errorNote(failure));
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
    return add(banner, body);
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
    if (!items.length) return null;
    const section = add(el('section', 'section'), el('h2', '', P.needsYou));
    const list = el('ul', 'rows');
    items.forEach((item, index) => {
      const key = 'need:' + String(item.id || index);
      // A warm box with an orange edge carries the state, so the row has no dot.
      const body = add(el('div', 'need-body'), el('p', 'row-text', String(item.sentence || '')), fixControl(item.fix, key, 'warn', true, itemSource(item)));
      add(list, add(el('li', 'row need'), body));
    });
    return add(section, list);
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

  function sourceRow(source: Any): HTMLElement {
    const id = String(source.id || source.label);
    const status = String(source.status || '');
    const item = sourceItem(source);
    // A source that needs the owner gets the amber dot, whatever its status word.
    const tone = item ? 'warn' : (config.statusTone as Any)[status] || 'off';
    const row = el('li', item ? 'row source need-row' : 'row source');
    const main = el('div', 'source-main');
    const dot = el('span', 'dot tone-' + tone);
    dot.setAttribute('aria-hidden', 'true');
    const head = add(el('p', 'source-head'), dot, el('span', 'source-name', String(source.label || '')));
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
      meta.push(fill(P.syncCheckingLine, { source: String(source.label || '') }));
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
    add(row, main);
    const controls = el('div', 'source-actions');
    const context = { id, label: String(source.label || id) };
    // Row buttons are all outlined; the accent belongs to the page's one primary action.
    // One fix per row: the Needs-you fix when there is one, else the source's own.
    const fix = item && item.fix ? item.fix : source.primary;
    const isSync = (entry: Any) => !!entry && entry.tool === config.syncTool;
    if (fix && !(checking && isSync(fix))) add(controls, fixControl(fix, 'primary:' + id, 'plain', true, context));
    // A press still checking: its button says so, disabled, in the row's place.
    if (checking) add(controls, checkingControl('primary:' + id));
    // The ⋯ menu keeps only secondary actions, never a copy of the row's fix,
    // and no second Sync now while one is checking.
    const menu = (Array.isArray(source.menu) ? source.menu : []).filter((entry: Any) =>
      (!fix || !entry || entry.label !== fix.label || entry.tool !== fix.tool) && !(checking && isSync(entry)));
    let menuBox: HTMLElement | null = null;
    if (menu.length) {
      const glyph = el('span', '', '⋯');
      glyph.setAttribute('aria-hidden', 'true');
      const hidden = el('span', 'sr', fill(P.moreActions, { source: String(source.label || '') }));
      const box = details('menu:' + id, add(el('span'), glyph, hidden), 'menu');
      const panel = el('div', 'menu-panel');
      menu.forEach((fix: Any, index: number) => add(panel, fixControl(fix, 'menu:' + id + ':' + index, 'plain', true, context)));
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
    return capitalise(reason || detail || P.sourcePaused);
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
    return typeof words === 'string' ? fill(words, { source: String(source.label || '') }) : '';
  }

  function sourceProgressLabel(progress: Any): string {
    const total = Number(progress.total) || 0;
    if (total <= 0) return P.findingItems;
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
      if (real) add(box, progressBar(progress.percent, name + ': ' + (stalledWords || sourceProgressLabel(progress))));
      return box;
    }
    const label = sourceProgressLabel(progress);
    add(box, el('p', 'muted', label), progressBar(progress.percent, name + ': ' + label));
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
      add(row, blocked ? add(el('span', 'fix'), edit, el('span', 'reason', blocked)) : edit);
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
    return stages.length > 0 && stages.every((stage: Any) => !(Number(stage && stage.total) > 0));
  }

  /** Nothing left and nothing stuck: the line has nothing to say. */
  function progressFinished(progress: Any): boolean {
    return !!progress && !progress.stalled && !totalUnknown(progress)
      && (Number(progress.itemsLeft) || 0) <= 0;
  }

  function progressText(progress: Any): string {
    const phase = progress.phase === 'initial' ? P.progressInitial : P.progressRefresh;
    if (totalUnknown(progress)) {
      const paused = progressPaused() ? ', ' + P.progressPaused : progress.stalled ? ', ' + P.stalled : '';
      return phase + ': ' + P.findingItems + paused;
    }
    const parts = [fill(P.percentDone, { percent: percent(progress.percent) })];
    if (progressPaused()) {
      parts.push(P.progressPaused);
      return (progress.phase === 'initial' ? P.progressInitial : P.progressRefresh) + ': ' + parts.join(', ');
    }
    const left = Number(progress.itemsLeft) || 0;
    parts.push(fill(P.left, { count: count(left), unit: unitWord(progress.unit, left) }));
    if (typeof progress.etaSeconds === 'number' && progress.etaSeconds > 0 && !progress.stalled) {
      parts.push(fill(P.eta, { duration: duration(progress.etaSeconds) }));
    }
    if (progress.stalled) parts.push(P.stalled);
    return (progress.phase === 'initial' ? P.progressInitial : P.progressRefresh) + ': ' + parts.join(', ');
  }

  function progressSection(progress: Any, withDetails: boolean): HTMLElement | null {
    if (!progress || progressFinished(progress)) return null;
    const section = add(el('section', 'section'), el('h2', '', P.progress));
    const stalled = progress.stalled && !progressPaused();
    const line = el('p', stalled ? 'progress-line stalled' : progressPaused() ? 'progress-line paused' : 'progress-line', progressText(progress));
    add(section, line, progressBar(progress.percent, P.progress));
    const stages = Array.isArray(progress.details) ? progress.details : [];
    if (withDetails && stages.length) {
      const box = details('progress-details', doc.createTextNode(P.details), 'disclosure');
      const list = el('ul', 'plain');
      stages.forEach((stage: Any) => add(list, el('li', '', fill(P.stageLine, {
        stage: String(stage.stage || ''),
        done: count(stage.done),
        total: count(stage.total),
        unit: unitWord(stage.unit, Number(stage.total) || 0),
      }))));
      add(section, add(box, list));
    }
    return section;
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
    else if (embedding.state === 'failed') ready = P.modelNotWorking;
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

  /** The transcription model's words after "Transcription:", or '' when the view model has none. */
  function transcriptionWords(models: DashboardModels): string {
    const entry = models.transcription;
    if (!entry || typeof entry !== 'object') return '';
    switch (entry.state) {
      case 'not_needed': return P.modelNotNeededNoAudio;
      case 'not_downloaded': return P.modelNotDownloaded;
      case 'interrupted': return P.modelDownloadInterrupted;
      case 'load_failed': return fill(P.modelCouldNotStart, { model: P.modelNames.transcription });
      case 'ready': return P.modelBuiltIn + ' · ' + P.modelReady;
      case 'failed': return P.modelBuiltIn + ' · ' + P.modelNotWorking;
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
    if (models.change) add(box, add(el('div', 'actions'), fixControl(models.change, 'models:change', 'plain', true)));
    const installs = installLines(models);
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
    add(page, sourcesSection(Array.isArray(data.sources) ? data.sources : []));
    add(page, privacySection(data));
    const sourceList = Array.isArray(data.sources) ? data.sources : [];
    add(page, progressRepeatsOneRow(sourceList) ? null : progressSection(data.progress, true));
    add(page, modelsSection(data.models));
    return page;
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
    return !!data.models && !!data.models.embedding && installLines(data.models).some((entry) => entry.state !== 'failed');
  }

  function refreshDelay(): number {
    const base = moving() ? R.activeMs : R.idleMs;
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
    }, () => {
      refreshing = false;
      if (mine !== generation) return scheduleRefresh();
      refreshFailures++;
      state.relayDown = true;
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
  }, () => undefined);
  if (!state.data) waitForResult();
}
