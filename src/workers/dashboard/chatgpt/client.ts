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
import type {
  DASHBOARD_CHATGPT_CONNECTION_COPY,
  DASHBOARD_CHATGPT_PAGE_COPY,
  DashboardStatusColorToken,
} from '../vocabulary.ts';

export interface ChatGptDashboardClientConfig {
  toolName: string;
  connection: typeof DASHBOARD_CHATGPT_CONNECTION_COPY;
  page: typeof DASHBOARD_CHATGPT_PAGE_COPY;
  statusTone: Record<DashboardStatus, DashboardStatusColorToken>;
  /** No tool result within this long means the relay cannot reach the Mac. */
  resultTimeoutMs: number;
  staleAfterMs: number;
  /** The in-place Connect flow and folder/mail pickers (picker.ts). */
  picker: ChatGptPickerConfig;
}

// Loose shapes: the page validates what it reads instead of trusting a type.
/* eslint-disable @typescript-eslint/no-explicit-any */
type Any = any;

export function chatgptDashboardClient(
  config: ChatGptDashboardClientConfig,
  pickerProgram?: (kit: ChatGptPickerKit) => ChatGptPicker,
): void {
  const doc = document;
  const root = doc.getElementById('app') as HTMLElement;
  const P = config.page;
  const C = config.connection;
  const GLOBAL_STATES = ['not_installed', 'installing', 'mac_offline', 'relay_unavailable'];

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
    if (message.method === 'ui/notifications/tool-result') acceptResult(message.params, true);
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

  /** A tool result: render it when it is the dashboard, else fetch the dashboard. */
  function acceptResult(result: Any, fromHost: boolean): boolean {
    if (resultTimer) {
      clearTimeout(resultTimer);
      resultTimer = null;
    }
    if (!result || result.isError) {
      state.relayDown = true;
      render();
      return false;
    }
    const content = result.structuredContent;
    if (isDashboard(content)) {
      state.data = content;
      state.relayDown = false;
      render();
      return true;
    }
    if (fromHost) {
      state.relayDown = true;
      render();
    }
    return false;
  }

  function callTool(name: string, args: Any, key: string): void {
    state.busy = key;
    state.confirming = '';
    state.notice = '';
    render();
    request('tools/call', { name, arguments: args || {} }, config.resultTimeoutMs).then((result) => {
      state.busy = '';
      if (acceptResult(result, false)) return;
      if (!state.relayDown && name !== config.toolName) refresh();
    }, () => {
      state.busy = '';
      state.relayDown = true;
      render();
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
  function button(label: string, key: string, onClick: (() => void) | null, style: 'main' | 'plain' | 'danger'): HTMLButtonElement {
    const node = el('button', 'btn', label) as HTMLButtonElement;
    node.type = 'button';
    node.setAttribute('data-key', key);
    if (style === 'danger') node.className = 'btn danger';
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
    return state.data ? String(state.data.connection.state) : '';
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
  function fixControl(fix: Any, key: string, style: 'main' | 'plain', allowConfirm: boolean, source?: { id: string; label: string }): HTMLElement {
    const wrap = el('span', 'fix');
    if (!fix || typeof fix.label !== 'string') return wrap;
    const blocked = globalReason();
    if (blocked || fix.disabledReason) {
      add(wrap, button(fix.label, key, null, style), el('span', 'reason', blocked || String(fix.disabledReason)));
      return wrap;
    }
    if (state.busy === key) {
      const busy = button(P.working, key, null, style);
      busy.setAttribute('aria-busy', 'true');
      return add(wrap, busy);
    }
    let action: (() => void) | null = null;
    if (picker && picker.handles(fix)) {
      // Connect, Choose folders and Choose mail open in place, never as a plain tool call.
      action = () => {
        state.notice = '';
        state.confirming = '';
        picker!.start(fix, source ? source.id : '', source ? source.label : '', key);
      };
    } else if (typeof fix.tool === 'string' && fix.tool) action = () => callTool(fix.tool, fix.args || {}, key);
    else if (typeof fix.href === 'string' && fix.href) action = () => openLink(fix.href);
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
        state.confirming = key;
        render(key + ':no');
      }, 'plain'));
    }
    return add(wrap, button(fix.label, key, action, style));
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

  function staleLine(): HTMLElement | null {
    const data = state.data;
    if (!data || state.relayDown) return null;
    const at = Date.parse(data.generatedAt);
    if (!isFinite(at) || Date.now() - at < config.staleAfterMs) return null;
    const line = add(el('p', 'stale'), el('span', 'muted', fill(P.updated, { when: ago(data.generatedAt) })));
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
      // The dot has its own column so it stays beside the sentence's first line.
      const body = add(el('div', 'need-body'), el('p', 'row-text', String(item.sentence || '')), fixControl(item.fix, key, 'main', true, itemSource(item)));
      add(list, add(el('li', 'row need'), el('span', 'dot tone-warn'), body));
    });
    return add(section, list);
  }

  function sourceRow(source: Any): HTMLElement {
    const id = String(source.id || source.label);
    const status = String(source.status || '');
    const tone = (config.statusTone as Any)[status] || 'off';
    const row = el('li', 'row source');
    const main = el('div', 'source-main');
    const head = add(el('p', 'source-head'), el('span', 'dot tone-' + tone), el('span', 'source-name', String(source.label || '')));
    // Off is said once, under the name ("Not connected"), never twice.
    const off = status === 'Off';
    if (!off) add(head, el('span', 'status', status));
    add(main, head);
    const meta: string[] = [];
    if (off) meta.push(capitalise(typeof source.detail === 'string' && source.detail ? source.detail : P.notConnected));
    else if (typeof source.detail === 'string' && source.detail) meta.push(source.detail);
    if (typeof source.lastSyncAt === 'string' && ago(source.lastSyncAt)) meta.push(fill(P.synced, { when: ago(source.lastSyncAt) }));
    if (meta.length) add(main, el('p', 'muted', meta.join(' · ')));
    add(row, main);
    const controls = el('div', 'source-actions');
    const context = { id, label: String(source.label || id) };
    // Row buttons are all outlined; the accent belongs to the page's one primary action.
    if (source.primary) add(controls, fixControl(source.primary, 'primary:' + id, 'plain', true, context));
    const menu = Array.isArray(source.menu) ? source.menu : [];
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

  /** Not connected, and its only fix is set up on the Mac: no button here, just its name in one group. */
  function macOnly(source: Any): boolean {
    const fix = source && source.primary;
    return String(source && source.status) === 'Off' && !!fix && !!fix.disabledReason
      && (!fix.tool || fix.tool === config.toolName);
  }

  function capitalise(text: string): string {
    return text ? text.charAt(0).toUpperCase() + text.slice(1) : text;
  }

  function sourcesSection(sources: Any[]): HTMLElement {
    const section = add(el('section', 'section'), el('h2', '', P.sources));
    if (!sources.length) return add(section, el('p', 'muted', P.noSources));
    const onMac = sources.filter(macOnly);
    const here = sources.filter((source) => !macOnly(source));
    // Server order within each group; the local group always comes first.
    const ordered = here.filter((source) => source.group === 'local')
      .concat(here.filter((source) => source.group !== 'local'));
    let group = '';
    let list: HTMLElement | null = null;
    for (const source of ordered) {
      if (source.group !== group || !list) {
        group = source.group;
        add(section, el('h3', '', group === 'local' ? P.sourcesLocal : P.sourcesCloud));
        list = add(section, el('ul', 'rows')).lastChild as HTMLElement;
      }
      add(list, sourceRow(source));
    }
    if (onMac.length) {
      add(section, el('h3', '', P.sourcesOnMac), el('p', 'muted mac-help', P.sourcesOnMacHelp));
      const rows = el('ul', 'rows mac-only');
      for (const source of onMac) add(rows, add(el('li', 'row source mac'), el('span', 'source-name', String(source.label || source.id || ''))));
      add(section, rows);
    }
    return section;
  }

  /** Work cannot move while the Mac is unreachable: no items left, no ETA. */
  function progressPaused(): boolean {
    const current = connectionState();
    return current === 'mac_offline' || current === 'relay_unavailable';
  }

  function progressText(progress: Any): string {
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
    if (!progress) return null;
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

  function modelWords(models: Any): { summary: string; search: string; answers: string } {
    const embedding = models.embedding || {};
    const kind = embedding.kind === 'built_in' ? P.modelBuiltIn : P.modelCustom;
    let ready: string = P.modelReady;
    if (embedding.state === 'downloading') ready = fill(P.modelDownloading, { percent: percent(embedding.percent) });
    else if (embedding.state === 'failed') ready = P.modelNotWorking;
    const answers = models.answers;
    const answersWords = answers ? String(answers.label || '') + ' · ' + (answers.ready ? P.modelReady : P.modelNotReady) : '';
    let overall: string = ready;
    if (embedding.state === 'ready' && answers && !answers.ready) overall = P.modelNotReady;
    return { summary: P.models + ' — ' + kind + ' · ' + overall, search: kind + ' · ' + ready, answers: answersWords };
  }

  function modelsSection(models: Any): HTMLElement | null {
    if (!models || !models.embedding) return null;
    const words = modelWords(models);
    const box = details('models', doc.createTextNode(words.summary), 'section models');
    const list = add(el('ul', 'plain'), el('li', '', P.modelSearch + ': ' + words.search));
    if (words.answers) add(list, el('li', '', P.modelAnswers + ': ' + words.answers));
    add(box, list);
    if (models.change) add(box, add(el('div', 'actions'), fixControl(models.change, 'models:change', 'plain', true)));
    return box;
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
    if (data && data.progress && !state.relayDown) add(card, el('p', 'progress-line', progressText(data.progress)));
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
    add(page, needsYouSection(Array.isArray(data.needsYou) ? data.needsYou : []));
    add(page, sourcesSection(Array.isArray(data.sources) ? data.sources : []));
    add(page, progressSection(data.progress, true));
    add(page, modelsSection(data.models));
    return page;
  }

  // ---- render ------------------------------------------------------------
  function render(focusKey?: string): void {
    const active = doc.activeElement as HTMLElement | null;
    const keepFocus = focusKey || (active && active.getAttribute ? active.getAttribute('data-key') : '') || '';
    const theme = state.theme;
    if (theme) doc.documentElement.setAttribute('data-theme', theme);
    else doc.documentElement.removeAttribute('data-theme');
    const picking = !!picker && picker.active();
    doc.documentElement.setAttribute('data-mode', compact() && !picking ? 'inline' : 'fullscreen');
    accentUsed = false;
    const view = picking ? picker!.view() : compact() ? renderCompact() : renderFull();
    root.textContent = '';
    root.appendChild(view);
    if (picking) picker!.afterRender();
    if (keepFocus) {
      const nodes = root.querySelectorAll('[data-key]');
      for (let i = 0; i < nodes.length; i++) {
        const node = nodes[i] as HTMLElement;
        if (node.getAttribute('data-key') === keepFocus) {
          node.focus();
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
    setDashboard: (value: Any) => {
      if (!isDashboard(value)) return;
      state.data = value;
      state.relayDown = false;
    },
    close: (notice: string, again: boolean, focusKey: string) => {
      state.notice = notice;
      if (again) {
        // The dashboard re-renders from the refreshed result; the notice stays until the next action.
        state.busy = 'refresh';
        render(focusKey);
        request('tools/call', { name: config.toolName, arguments: {} }, config.resultTimeoutMs).then((result) => {
          state.busy = '';
          acceptResult(result, false);
          render(focusKey);
        }, () => {
          state.busy = '';
          render(focusKey);
        });
        return;
      }
      render(focusKey);
    },
  }) : null;

  // ---- start -------------------------------------------------------------
  readOpenAiGlobals();
  render();
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
