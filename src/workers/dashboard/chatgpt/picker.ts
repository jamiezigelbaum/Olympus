/**
 * The ChatGPT page's in-place Connect flow and its folder and mail pickers.
 *
 * Like client.ts, `chatgptPickerProgram` is never called on the server: the
 * page inlines its source text and hands it to the client, which calls it with
 * a small kit (DOM helpers, the tool bridge, render). So it stays
 * self-contained — no imports at runtime, no references outside its body —
 * and builds every node with `textContent`.
 *
 * Privacy: folder names, label names and senders exist only in this
 * program's session object and the picker view it renders. They are never
 * written to widget state, model context, the page URL or logs, and the only
 * tool call that carries any of them is the scope save (opaque folder keys;
 * label id and name, which the mail contract requires). Closing the picker
 * drops the session.
 */
import type { DASHBOARD_CHATGPT_PICKER_COPY } from '../vocabulary.ts';

/**
 * The backend tools the picker calls (src/workers/chatgpt/dashboard-contract.ts
 * setup additions: CONNECT_SOURCE_TOOL_NAME, SCOPE_LIST_TOOL_NAME,
 * SCOPE_SET_TOOL_NAME). One map, so a rename is a one-line change here.
 */
export const CHATGPT_PICKER_TOOLS = {
  /** {source} → structuredContent {status: 'open_link', openUrl} on the connect host's /go/ path. */
  connectSource: 'olympus_connect_source',
  /** {source_id, parent_key?, cursor?, draft?} → ScopeSummary; the picker data is in `_meta[scopeMetaKey]`. */
  scopeList: 'olympus_scope_list',
  /** {..., selections | mail} → {status: 'saved'} or {status: 'conflict'} with the fresh list in `_meta`. */
  scopeSet: 'olympus_scope_set',
} as const;

/** Argument names that carry the mail draft (list: the estimate; set: the save). */
export const CHATGPT_PICKER_MAIL_ARGS = { list: 'draft', set: 'mail' } as const;

/** The result `_meta` key that carries picker data (names, keys, cursors) to the widget only. */
export const CHATGPT_SCOPE_META_KEY = 'olympus/scope';

/** The only host an authorize link may point at; its path must start with /go/. */
export const CHATGPT_CONNECT_HOST = 'mcp.olympusplugin.ai';
export const CHATGPT_CONNECT_POLL_MS = 3_000;
export const CHATGPT_CONNECT_POLL_CAP_MS = 3 * 60_000;
export const CHATGPT_MAIL_SOURCE_ID = 'gmail.email';

export interface ChatGptPickerConfig {
  tools: typeof CHATGPT_PICKER_TOOLS;
  mailArgs: typeof CHATGPT_PICKER_MAIL_ARGS;
  scopeMetaKey: string;
  copy: typeof DASHBOARD_CHATGPT_PICKER_COPY;
  connectHost: string;
  mailSourceId: string;
  pollMs: number;
  pollCapMs: number;
}

// Loose shapes: the program validates what it reads instead of trusting a type.
/* eslint-disable @typescript-eslint/no-explicit-any */
type Any = any;

/** What the client hands the picker. */
export interface ChatGptPickerKit {
  config: ChatGptPickerConfig;
  dashboardTool: string;
  el(tag: string, cls?: string, text?: string): HTMLElement;
  add(parent: HTMLElement, ...children: Array<Node | null | undefined | false>): HTMLElement;
  button(label: string, key: string, onClick: (() => void) | null, style: 'main' | 'plain' | 'danger'): HTMLButtonElement;
  fill(template: string, values: Record<string, string | number>): string;
  count(value: number): string;
  call(name: string, args: Any): Promise<Any>;
  render(focusKey?: string): void;
  reportHeight(): void;
  openLink(href: string): void;
  compact(): boolean;
  fullscreen(): void;
  isDashboard(value: Any): boolean;
  setDashboard(value: Any): void;
  /** Leave the picker: optional notice, refresh the dashboard when asked, focus the control that opened it. */
  close(notice: string, refresh: boolean, focusKey: string): void;
}

export interface ChatGptPicker {
  handles(fix: Any): boolean;
  start(fix: Any, sourceId: string, sourceLabel: string, returnKey: string): void;
  active(): boolean;
  view(): HTMLElement;
  afterRender(): void;
}

export function chatgptPickerProgram(kit: ChatGptPickerKit): ChatGptPicker {
  const T = kit.config.tools;
  const Q = kit.config.copy;
  const el = kit.el;
  const add = kit.add;
  const fill = kit.fill;
  const STATES = ['ingest', 'metadata_only', 'exclude'];
  const WINDOWS = ['6m', '1y', '2y', '5y', 'all'];
  const CATEGORIES = ['primary', 'updates', 'forums', 'social', 'promotions'];

  let p: Any = null;
  let session = 0;
  let timer: Any = null;
  let searchRows: Array<{ li: HTMLElement; name: string; children: Any[] }> = [];
  let searchEmpty: HTMLElement | null = null;

  function handles(fix: Any): boolean {
    return !!fix && (fix.tool === T.connectSource || fix.tool === T.scopeList);
  }

  function stopTimer(): void {
    if (timer) clearTimeout(timer);
    timer = null;
  }

  function leave(notice: string, refresh: boolean): void {
    stopTimer();
    const key = p ? p.returnKey : '';
    p = null;
    session++;
    searchRows = [];
    kit.close(notice, refresh, key);
  }

  function start(fix: Any, sourceId: string, sourceLabel: string, returnKey: string): void {
    stopTimer();
    session++;
    if (kit.compact()) kit.fullscreen();
    const args = fix && fix.args && typeof fix.args === 'object' ? fix.args : {};
    const id = String(args.source_id || sourceId || args.source || '');
    const label = sourceLabel || id;
    if (fix.tool === T.connectSource) startConnect(args, id, label, returnKey);
    else openScope(id, label, String(fix.label || ''), returnKey, '');
  }

  // ---- connect -----------------------------------------------------------
  function authorizeHref(content: Any): string {
    if (!content || typeof content !== 'object') return '';
    for (const value of [content.openUrl]) {
      if (typeof value !== 'string') continue;
      let parsed: URL;
      try {
        parsed = new URL(value);
      } catch {
        continue;
      }
      if (parsed.protocol === 'https:' && parsed.hostname === kit.config.connectHost
        && parsed.pathname.indexOf('/go/') === 0 && parsed.pathname.length > 4 && !parsed.username && !parsed.password) {
        return parsed.href;
      }
    }
    return '';
  }

  function startConnect(args: Any, id: string, label: string, returnKey: string): void {
    p = { mode: 'connect', id, label, returnKey, phase: 'starting', href: '', startedAt: 0, connectArgs: args };
    const mine = session;
    kit.render('picker:back');
    kit.call(T.connectSource, args).then((result) => {
      if (mine !== session || !p) return;
      const href = result && !result.isError ? authorizeHref(result.structuredContent) : '';
      if (!href) {
        p.phase = 'error';
        kit.render('picker:connect:retry');
        return;
      }
      p.href = href;
      p.phase = 'waiting';
      p.startedAt = Date.now();
      kit.openLink(href);
      kit.render('picker:back');
      schedulePoll();
    }, () => {
      if (mine !== session || !p) return;
      p.phase = 'error';
      kit.render('picker:connect:retry');
    });
  }

  function schedulePoll(): void {
    stopTimer();
    const mine = session;
    timer = setTimeout(() => {
      timer = null;
      if (mine !== session || !p || p.mode !== 'connect') return;
      kit.call(kit.dashboardTool, {}).then((result) => {
        if (mine !== session || !p) return;
        const content = result && !result.isError ? result.structuredContent : null;
        if (kit.isDashboard(content)) {
          kit.setDashboard(content);
          const sources = Array.isArray(content.sources) ? content.sources : [];
          const source = sources.filter((entry: Any) => entry && String(entry.id) === p.id)[0];
          if (source && source.status !== 'Off') {
            connected(source);
            return;
          }
        }
        continuePolling();
      }, () => {
        if (mine !== session || !p) return;
        continuePolling();
      });
    }, kit.config.pollMs);
  }

  function continuePolling(): void {
    if (Date.now() - p.startedAt >= kit.config.pollCapMs) {
      p.phase = 'timeout';
      kit.render('picker:connect:check');
      return;
    }
    schedulePoll();
  }

  function connected(source: Any): void {
    const next = source.primary;
    if (next && next.tool === T.scopeList && !next.disabledReason) {
      const args = next.args && typeof next.args === 'object' ? next.args : {};
      openScope(String(args.source_id || p.id), p.label, String(next.label || ''), p.returnKey, fill(Q.connected, { source: p.label }));
      return;
    }
    leave(fill(Q.connected, { source: p.label }), false);
  }

  function connectView(page: HTMLElement): void {
    add(page, el('h1', '', fill(Q.connectTitle, { source: p.label })));
    const box = el('div', 'picker-status');
    if (p.phase === 'starting') {
      const line = el('p', '', Q.connectStarting);
      line.setAttribute('role', 'status');
      add(box, line);
    } else if (p.phase === 'waiting') {
      const line = el('p', 'strong', Q.connectWaiting);
      line.setAttribute('role', 'status');
      add(box, line, el('p', 'muted', fill(Q.connectWaitingHelp, { source: p.label })));
      add(box, add(el('div', 'actions'),
        kit.button(Q.connectReopen, 'picker:connect:reopen', () => kit.openLink(p.href), 'plain'),
        kit.button(Q.cancel, 'picker:connect:cancel', () => leave('', false), 'plain')));
    } else if (p.phase === 'timeout') {
      const line = el('p', '', fill(Q.connectTimeout, { source: p.label }));
      line.setAttribute('role', 'alert');
      add(box, line, add(el('div', 'actions'),
        kit.button(Q.checkAgain, 'picker:connect:check', () => {
          p.phase = 'waiting';
          p.startedAt = Date.now();
          kit.render('picker:connect:cancel');
          schedulePoll();
        }, 'main'),
        kit.button(Q.connectReopen, 'picker:connect:reopen', () => kit.openLink(p.href), 'plain'),
        kit.button(Q.cancel, 'picker:connect:cancel', () => leave('', false), 'plain')));
    } else {
      const line = el('p', '', fill(Q.connectFailed, { source: p.label }));
      line.setAttribute('role', 'alert');
      add(box, line, add(el('div', 'actions'),
        kit.button(Q.tryAgain, 'picker:connect:retry', () => {
          session++;
          startConnect(p.connectArgs, p.id, p.label, p.returnKey);
        }, 'main'),
        kit.button(Q.cancel, 'picker:connect:cancel', () => leave('', false), 'plain')));
    }
    add(page, box);
  }

  // ---- scope sessions ----------------------------------------------------
  function openScope(id: string, label: string, title: string, returnKey: string, notice: string, initial?: Any): void {
    stopTimer();
    session++;
    const mail = id === kit.config.mailSourceId;
    p = {
      mode: mail ? 'mail' : 'folders', id, label, returnKey, notice,
      title: title || (mail ? Q.mailTitle : Q.foldersTitle),
      loading: 'root', loaded: false, error: '', retry: null, generation: '', revision: '',
      edited: false, saving: false, saveError: '', discarding: false,
      // folders
      roots: [], rootCursor: '', branches: new Map(), cursors: new Map(), expanded: new Set(), catalog: new Map(),
      ancestors: new Map(), own: new Map(), whole: false, wholeConfirmed: false, search: '',
      // mail
      draft: null, labels: [], categories: [], suggestions: [], sampleSize: 0, estimate: null,
    };
    if (initial && mail) takeMail(initial, 'picker:back');
    else if (initial && validBrowse(initial)) takeFolders(initial, '', false, 'picker:back');
    else {
      kit.render('picker:back');
      if (mail) listMail(false);
      else list('', false);
    }
  }

  /** Start over from the saved scope: the fresh list when the conflict carried it, else a new listing. */
  function reload(message: string, fresh?: Any): void {
    const keep = p;
    openScope(keep.id, keep.label, keep.title, keep.returnKey, message, fresh || undefined);
  }

  /** Picker data lives only in the result's `_meta`, never in structuredContent. */
  function scopeData(result: Any): Any {
    if (!result || result.isError || !result._meta || typeof result._meta !== 'object') return null;
    const data = result._meta[kit.config.scopeMetaKey];
    return data && typeof data === 'object' ? data : null;
  }

  function validNode(node: Any): boolean {
    return !!node && typeof node.key === 'string' && !!node.key && typeof node.name === 'string';
  }

  function validBrowse(page: Any): boolean {
    return !!page && typeof page === 'object' && typeof page.account_generation === 'string' && !!page.account_generation
      && typeof page.scope_revision === 'string' && !!page.scope_revision
      && Array.isArray(page.nodes) && page.nodes.every(validNode);
  }

  function failLoad(retry: () => void, focus: string): void {
    p.loading = '';
    p.error = Q.loadFailed;
    p.retry = retry;
    kit.render(focus);
  }

  // ---- folders -----------------------------------------------------------
  function list(parentKey: string, append: boolean): void {
    const cursor = append ? (parentKey ? p.cursors.get(parentKey) : p.rootCursor) : '';
    const args: Any = { source_id: p.id };
    if (parentKey) args.parent_key = parentKey;
    if (cursor) args.cursor = cursor;
    p.loading = parentKey || 'root';
    p.error = '';
    const focus = append ? 'picker:more:' + parentKey : parentKey ? 'picker:open:' + parentKey : 'picker:back';
    kit.render(focus);
    const mine = session;
    kit.call(T.scopeList, args).then((result) => {
      if (mine !== session || !p) return;
      const page = scopeData(result);
      if (!validBrowse(page)) {
        failLoad(() => list(parentKey, append), 'picker:retry');
        return;
      }
      if (p.loaded && (page.account_generation !== p.generation || page.scope_revision !== p.revision)) {
        reload(Q.conflict, parentKey || append ? null : page);
        return;
      }
      takeFolders(page, parentKey, append, focus);
    }, () => {
      if (mine !== session || !p) return;
      failLoad(() => list(parentKey, append), 'picker:retry');
    });
  }

  function takeFolders(page: Any, parentKey: string, append: boolean, focus: string): void {
    if (!p.loaded) {
      p.generation = page.account_generation;
      p.revision = page.scope_revision;
      p.whole = page.whole_account_selected === true;
      const saved = Array.isArray(page.selections) ? page.selections : [];
      for (const selection of saved) {
        if (!selection || typeof selection.key !== 'string' || STATES.indexOf(selection.state) < 0) continue;
        p.own.set(selection.key, selection.state);
        p.ancestors.set(selection.key, Array.isArray(selection.ancestor_keys)
          ? selection.ancestor_keys.filter((key: Any) => typeof key === 'string') : []);
      }
      p.loaded = true;
    }
    const trail: string[] = parentKey ? (p.ancestors.get(parentKey) || []).concat([parentKey]) : [];
    const previous: Any[] = append ? (parentKey ? p.branches.get(parentKey) || [] : p.roots) : [];
    const seen: Record<string, boolean> = {};
    for (const node of previous) seen[node.key] = true;
    const fresh = page.nodes.filter((node: Any) => !seen[node.key] && trail.indexOf(node.key) < 0);
    for (const node of fresh) {
      p.catalog.set(node.key, node);
      p.ancestors.set(node.key, trail);
    }
    const nodes = previous.concat(fresh);
    const next = typeof page.next_cursor === 'string' && page.next_cursor ? page.next_cursor : '';
    if (parentKey) {
      p.branches.set(parentKey, nodes);
      p.expanded.add(parentKey);
      if (next) p.cursors.set(parentKey, next);
      else p.cursors.delete(parentKey);
    } else {
      p.roots = nodes;
      p.rootCursor = next;
    }
    p.loading = '';
    kit.render(focus);
  }

  function inherited(key: string): string {
    let state = p.whole ? 'ingest' : '';
    const ancestors: string[] = p.ancestors.get(key) || [];
    for (const ancestor of ancestors) {
      const choice = p.own.get(ancestor);
      if (choice === 'exclude') return 'exclude';
      if (choice === 'metadata_only') state = 'metadata_only';
      else if (choice === 'ingest' && !state) state = 'ingest';
    }
    return state;
  }

  function effective(key: string): string {
    const from = inherited(key);
    const own = p.own.get(key);
    if (from === 'exclude' || own === 'exclude') return 'exclude';
    if (from === 'metadata_only') return 'metadata_only';
    return own || from || 'exclude';
  }

  function allowed(key: string, state: string): boolean {
    const from = inherited(key);
    if (!state) return true;
    if (from === 'exclude') return state === 'exclude';
    if (from === 'metadata_only') return state !== 'ingest';
    return true;
  }

  function mixed(key: string): boolean {
    const mine = effective(key);
    let differs = false;
    p.own.forEach((_state: string, other: string) => {
      if (differs || other === key) return;
      const ancestors: string[] = p.ancestors.get(other) || [];
      if (ancestors.indexOf(key) >= 0 && effective(other) !== mine) differs = true;
    });
    return differs;
  }

  function hasAncestorChoice(key: string): boolean {
    const ancestors: string[] = p.ancestors.get(key) || [];
    return ancestors.some((ancestor) => p.own.has(ancestor));
  }

  function size(bytes: number): string {
    const units = ['bytes', 'KB', 'MB', 'GB', 'TB'];
    let value = bytes;
    let unit = 0;
    while (value >= 1000 && unit < units.length - 1) {
      value /= 1000;
      unit++;
    }
    const shown = unit === 0 || value >= 100 ? String(Math.round(value)) : String(Math.round(value * 10) / 10);
    return shown + ' ' + units[unit];
  }

  function nodeMeta(node: Any): string {
    const parts: string[] = [];
    if (typeof node.size_bytes === 'number' && isFinite(node.size_bytes) && node.size_bytes >= 0) parts.push(size(node.size_bytes));
    if (typeof node.file_count === 'number' && isFinite(node.file_count) && node.file_count >= 0) {
      const n = Math.round(node.file_count);
      parts.push(fill(n === 1 ? Q.folderFiles.one : Q.folderFiles.many, { n: kit.count(n) }));
    }
    return parts.join(' · ');
  }

  function choose(key: string, value: string): void {
    if (value && STATES.indexOf(value) < 0) return;
    if (value) p.own.set(key, value);
    else p.own.delete(key);
    p.edited = true;
    p.saveError = '';
    kit.render('picker:choice:' + key);
  }

  function folderRow(node: Any): { li: HTMLElement; row: Any } {
    const key = node.key;
    const li = el('li', 'folder-item');
    const row = el('div', 'folder');
    const toggle = el('span', 'folder-toggle');
    if (node.has_children) {
      const open = p.expanded.has(key);
      const loadingHere = p.loading === key;
      const control = kit.button(open ? '▾' : '▸', 'picker:open:' + key, loadingHere ? null : () => {
        if (open) {
          p.expanded.delete(key);
          kit.render('picker:open:' + key);
        } else if (p.branches.has(key)) {
          p.expanded.add(key);
          kit.render('picker:open:' + key);
        } else list(key, false);
      }, 'plain');
      control.className = 'btn icon-btn';
      control.setAttribute('aria-expanded', String(open));
      control.setAttribute('aria-label', fill(open ? Q.collapse : Q.expand, { name: node.name }));
      add(toggle, control);
    }
    const text = el('div', 'folder-text');
    const nameLine = add(el('p', 'folder-name'), el('span', '', node.name));
    const own = p.own.get(key);
    const from = inherited(key);
    let status = '';
    if (mixed(key)) status = Q.mixed + ' — ' + Q.mixedHelp;
    else if (own || from) {
      status = (Q.states as Any)[effective(key)];
      if (!own && from) status += ' · ' + Q.inherited;
    } else status = Q.notSelected;
    add(text, nameLine);
    const metaParts = [status];
    const meta = nodeMeta(node);
    if (meta) metaParts.push(meta);
    add(text, el('p', 'muted folder-meta', metaParts.join(' · ')));
    const choice = el('select', 'choice') as HTMLSelectElement;
    choice.setAttribute('data-key', 'picker:choice:' + key);
    choice.setAttribute('aria-label', fill(Q.choiceFor, { name: node.name }));
    if (node.selectable === false || p.saving) choice.disabled = true;
    const none = el('option', '', from
      ? fill(hasAncestorChoice(key) ? Q.sameAsParent : Q.sameAsAccount, { state: (Q.states as Any)[from] })
      : Q.notSelected) as HTMLOptionElement;
    none.value = '';
    add(choice, none);
    for (const state of STATES) {
      const option = el('option', '', (Q.states as Any)[state]) as HTMLOptionElement;
      option.value = state;
      if (!allowed(key, state)) option.disabled = true;
      add(choice, option);
    }
    choice.value = own || '';
    choice.addEventListener('change', () => choose(key, choice.value));
    add(row, toggle, text, choice);
    add(li, row);
    const record: Any = { li, name: String(node.name).toLowerCase(), children: [] };
    if (node.has_children && p.expanded.has(key)) {
      const children = p.branches.get(key) || [];
      const group = el('ul', 'tree');
      group.setAttribute('role', 'group');
      for (const child of children) {
        const built = folderRow(child);
        record.children.push(built.row);
        add(group, built.li);
      }
      if (!children.length && p.loading !== key) add(group, el('li', 'muted folder-empty', Q.noFolders));
      if (p.cursors.has(key)) add(group, add(el('li', 'folder-more'), loadMore(key)));
      add(li, group);
    }
    if (p.loading === key) {
      const line = el('p', 'muted folder-loading', Q.loadingFolders);
      line.setAttribute('role', 'status');
      add(li, line);
    }
    return { li, row: record };
  }

  function loadMore(parentKey: string): HTMLElement {
    const busy = p.loading === (parentKey || 'root');
    return kit.button(busy ? Q.loadingFolders : Q.loadMore, 'picker:more:' + parentKey, busy ? null : () => list(parentKey, true), 'plain');
  }

  function applySearch(): void {
    const needle = String(p && p.search || '').trim().toLowerCase();
    let any = false;
    const visit = (record: Any): boolean => {
      let show = !needle || record.name.indexOf(needle) >= 0;
      for (const child of record.children) if (visit(child)) show = true;
      record.li.hidden = !show;
      if (show) any = true;
      return show;
    };
    for (const record of searchRows) visit(record);
    if (searchEmpty) searchEmpty.hidden = !needle || any || !searchRows.length;
  }

  function counts(): Any {
    const totals: Any = { ingest: 0, metadata_only: 0, exclude: 0 };
    p.own.forEach((_state: string, key: string) => {
      totals[effective(key)]++;
    });
    return totals;
  }

  /** Bytes fully indexed, when every folder that decides it has a known size. */
  function indexedBytes(): number {
    if (p.whole) return -1;
    let total = 0;
    let known = true;
    p.own.forEach((_state: string, key: string) => {
      const state = effective(key);
      const ancestors: string[] = p.ancestors.get(key) || [];
      let nearest = '';
      for (const ancestor of ancestors) if (p.own.has(ancestor)) nearest = ancestor;
      const parentIngest = nearest !== '' && effective(nearest) === 'ingest';
      let sign = 0;
      if (state === 'ingest' && !parentIngest) sign = 1;
      else if (state !== 'ingest' && parentIngest) sign = -1;
      if (!sign) return;
      const node = p.catalog.get(key);
      if (!node || typeof node.size_bytes !== 'number' || !isFinite(node.size_bytes)) {
        known = false;
        return;
      }
      total += sign * node.size_bytes;
    });
    return known ? Math.max(0, total) : -1;
  }

  function folderSummary(): string[] {
    const totals = counts();
    const lines: string[] = [];
    const parts: string[] = [];
    const templates: Array<[string, string]> = [['ingest', Q.summaryIngest], ['metadata_only', Q.summaryMetadata], ['exclude', Q.summaryExclude]];
    for (const [state, template] of templates) {
      const n = totals[state] || 0;
      if (!n) continue;
      let part = fill(template, { n: kit.count(n) });
      if (!parts.length) {
        const noun = n === 1 ? Q.summaryFolder.one : Q.summaryFolder.many;
        part = part.replace(kit.count(n), kit.count(n) + ' ' + noun);
      }
      parts.push(part);
    }
    if (p.whole) lines.push(Q.summaryWhole);
    if (parts.length) lines.push(parts.join(', ') + '.');
    else if (!p.whole) lines.push(Q.summaryNone);
    const bytes = indexedBytes();
    if (bytes > 0) lines.push(fill(Q.summarySize, { size: size(bytes) }));
    if (!p.whole) lines.push(Q.summaryRest);
    return lines;
  }

  function anyChosen(): boolean {
    let chosen = false;
    p.own.forEach((_state: string, key: string) => {
      if (effective(key) !== 'exclude') chosen = true;
    });
    return chosen;
  }

  function saveFolders(): void {
    if (!canSaveFolders()) return;
    const selections: Any[] = [];
    p.own.forEach((_state: string, key: string) => {
      selections.push({ key, state: effective(key), ancestor_keys: (p.ancestors.get(key) || []).slice() });
    });
    const args: Any = {
      source_id: p.id,
      account_generation: p.generation,
      scope_revision: p.revision,
      selections,
      whole_account_selected: p.whole,
    };
    if (p.whole) args.confirm_whole_account = true;
    save(args, 'picker:save');
  }

  function canSaveFolders(): boolean {
    if (!p.loaded || p.saving || !p.generation || !p.revision) return false;
    if (p.whole) return p.wholeConfirmed;
    return anyChosen() || p.edited;
  }

  function save(args: Any, focus: string): void {
    p.saving = true;
    p.saveError = '';
    kit.render(focus);
    const mine = session;
    kit.call(T.scopeSet, args).then((result) => {
      if (mine !== session || !p) return;
      p.saving = false;
      const content = result && !result.isError ? result.structuredContent : null;
      const status = content && typeof content === 'object' ? content.status : '';
      if (status === 'conflict') {
        reload(Q.conflict, scopeData(result));
        return;
      }
      if (status === 'saved') {
        leave(fill(Q.saved, { source: p.label }), true);
        return;
      }
      p.saveError = Q.saveFailed;
      kit.render(focus);
    }, () => {
      if (mine !== session || !p) return;
      p.saving = false;
      p.saveError = Q.saveFailed;
      kit.render(focus);
    });
  }

  function wholeControl(): HTMLElement {
    const box = el('div', 'whole');
    const label = el('label', 'opt');
    const input = el('input') as HTMLInputElement;
    input.type = 'checkbox';
    input.checked = p.whole;
    input.disabled = !p.loaded || p.saving;
    input.setAttribute('data-key', 'picker:whole');
    input.addEventListener('change', () => {
      p.whole = input.checked;
      p.wholeConfirmed = false;
      p.edited = true;
      kit.render(p.whole ? 'picker:whole:no' : 'picker:whole');
    });
    add(box, add(label, input, el('span', '', Q.wholeAccount)));
    if (p.whole && !p.wholeConfirmed) {
      const confirm = el('div', 'confirm-box');
      confirm.setAttribute('role', 'alert');
      add(confirm, el('p', 'strong', fill(Q.wholePrompt, { source: p.label })), add(el('div', 'actions'),
        kit.button(Q.wholeConfirm, 'picker:whole:yes', () => {
          p.wholeConfirmed = true;
          kit.render('picker:whole');
        }, 'danger'),
        kit.button(Q.cancel, 'picker:whole:no', () => {
          p.whole = false;
          kit.render('picker:whole');
        }, 'plain')));
      add(box, confirm);
    } else if (p.whole) {
      add(box, el('p', 'muted', Q.wholeConfirmed));
    }
    return box;
  }

  function meanings(): HTMLElement {
    const box = el('details', 'disclosure');
    const head = el('summary', '', Q.meaningTitle);
    head.setAttribute('data-key', 'picker:meanings');
    add(box, head);
    const listNode = el('ul', 'plain');
    for (const line of Q.meanings) add(listNode, el('li', '', line));
    return add(box, listNode);
  }

  function foldersView(page: HTMLElement): void {
    add(page, el('h1', '', p.title));
    add(page, el('p', 'muted', fill(Q.foldersIntro, { source: p.label })));
    if (p.notice) {
      const notice = el('p', 'notice', p.notice);
      notice.setAttribute('role', 'status');
      add(page, notice);
    }
    add(page, meanings());
    if (p.error) {
      const error = el('div', 'banner');
      error.setAttribute('role', 'alert');
      add(error, add(el('div', 'banner-body'), el('p', '', p.error),
        add(el('div', 'actions'), kit.button(Q.tryAgain, 'picker:retry', () => p.retry && p.retry(), 'plain'))));
      add(page, error);
    }
    if (!p.loaded) {
      if (p.loading) {
        const line = el('p', 'muted', Q.loadingFolders);
        line.setAttribute('role', 'status');
        add(page, line);
      }
      return;
    }
    const search = el('label', 'field');
    add(search, el('span', 'field-label', Q.search));
    const input = el('input', 'text') as HTMLInputElement;
    input.type = 'search';
    input.value = p.search;
    input.setAttribute('data-key', 'picker:search');
    input.addEventListener('input', () => {
      p.search = input.value;
      applySearch();
      kit.reportHeight();
    });
    add(page, add(search, input));
    const tree = el('ul', 'tree root');
    searchRows = [];
    for (const node of p.roots) {
      const built = folderRow(node);
      searchRows.push(built.row);
      add(tree, built.li);
    }
    if (!p.roots.length) add(tree, el('li', 'muted folder-empty', Q.noFolders));
    if (p.rootCursor) add(tree, add(el('li', 'folder-more'), loadMore('')));
    add(page, tree);
    searchEmpty = el('p', 'muted search-empty', Q.searchEmpty);
    searchEmpty.hidden = true;
    add(page, searchEmpty);
    add(page, wholeControl());
    const footer = el('section', 'picker-footer');
    footer.setAttribute('aria-label', Q.summaryTitle);
    const summary = el('div', 'summary');
    summary.setAttribute('aria-live', 'polite');
    for (const line of folderSummary()) add(summary, el('p', '', line));
    add(footer, summary);
    add(footer, saveRow(canSaveFolders(), p.whole || anyChosen() ? Q.saveFolders : Q.saveNoStart, saveFolders,
      p.whole && !p.wholeConfirmed ? Q.needConfirm : !anyChosen() && !p.edited ? Q.needChoice : ''));
    add(page, footer);
  }

  function saveRow(enabled: boolean, label: string, onSave: () => void, reason: string): HTMLElement {
    const row = el('div', 'actions');
    if (p.saving) {
      const busy = kit.button(Q.saving, 'picker:save', null, 'main');
      busy.setAttribute('aria-busy', 'true');
      add(row, busy);
    } else add(row, kit.button(label, 'picker:save', enabled ? onSave : null, 'main'));
    add(row, kit.button(Q.cancel, 'picker:cancel', p.saving ? null : back, 'plain'));
    const wrap = el('div', 'save');
    add(wrap, row);
    if (!enabled && !p.saving && reason) add(wrap, el('p', 'reason', reason));
    if (p.saveError) {
      const error = el('p', 'error', p.saveError);
      error.setAttribute('role', 'alert');
      add(wrap, error);
    }
    return wrap;
  }

  // ---- mail --------------------------------------------------------------
  function strings(value: Any): string[] {
    return Array.isArray(value) ? value.filter((entry) => typeof entry === 'string') : [];
  }

  function normalizeDraft(value: Any): Any {
    const draft = value && typeof value === 'object' ? value : {};
    return {
      window: WINDOWS.indexOf(draft.window) >= 0 ? draft.window : '2y',
      skipped_categories: Array.isArray(draft.skipped_categories)
        ? draft.skipped_categories.filter((entry: Any) => CATEGORIES.indexOf(entry) >= 0) : ['promotions', 'social'],
      skipped_labels: Array.isArray(draft.skipped_labels)
        ? draft.skipped_labels.filter((entry: Any) => entry && typeof entry.id === 'string' && typeof entry.name === 'string')
          .map((entry: Any) => ({ id: entry.id, name: entry.name }))
        : [],
      always_private_senders: strings(draft.always_private_senders),
      skip_senders: strings(draft.skip_senders),
    };
  }

  function draftOut(): Any {
    const clean = (lines: string[]): string[] => {
      const out: string[] = [];
      for (const line of lines) {
        const value = line.trim();
        if (value && out.indexOf(value) < 0) out.push(value);
      }
      return out;
    };
    return {
      window: p.draft.window,
      skipped_categories: p.draft.skipped_categories.slice(),
      skipped_labels: p.draft.skipped_labels.map((label: Any) => ({ id: label.id, name: label.name })),
      always_private_senders: clean(p.draft.always_private_senders),
      skip_senders: clean(p.draft.skip_senders),
    };
  }

  function listMail(withDraft: boolean): void {
    const args: Any = { source_id: p.id };
    // The draft (label ids and names, as the contract requires) goes only to the picker's own tools.
    if (withDraft && p.draft) args[kit.config.mailArgs.list] = draftOut();
    p.loading = 'root';
    p.error = '';
    const focus = withDraft ? 'picker:estimate' : 'picker:back';
    kit.render(focus);
    const mine = session;
    kit.call(T.scopeList, args).then((result) => {
      if (mine !== session || !p) return;
      const body = scopeData(result);
      if (!validMail(body)) {
        failLoad(() => listMail(withDraft), 'picker:retry');
        return;
      }
      if (p.loaded && (body.account_generation !== p.generation || body.scope_revision !== p.revision)) {
        reload(Q.conflict, withDraft ? null : body);
        return;
      }
      takeMail(body, focus);
    }, () => {
      if (mine !== session || !p) return;
      failLoad(() => listMail(withDraft), 'picker:retry');
    });
  }

  function validMail(body: Any): boolean {
    return !!body && typeof body === 'object' && typeof body.account_generation === 'string' && !!body.account_generation
      && typeof body.scope_revision === 'string' && !!body.scope_revision;
  }

  function takeMail(body: Any, focus: string): void {
    if (!validMail(body)) return;
    if (!p.loaded) {
      p.generation = body.account_generation;
      p.revision = body.scope_revision;
      p.draft = normalizeDraft(body.draft);
      p.loaded = true;
    }
    p.labels = Array.isArray(body.labels)
      ? body.labels.filter((label: Any) => label && typeof label.id === 'string' && typeof label.name === 'string') : [];
    p.categories = Array.isArray(body.categories) ? body.categories : [];
    p.suggestions = Array.isArray(body.sender_suggestions)
      ? body.sender_suggestions.filter((entry: Any) => entry && typeof entry.sender === 'string') : [];
    p.sampleSize = typeof body.sample_size === 'number' ? body.sample_size : 0;
    p.estimate = body.estimate && typeof body.estimate === 'object' ? body.estimate : null;
    p.loading = '';
    kit.render(focus);
  }

  function mailEdited(focus: string): void {
    p.edited = true;
    p.saveError = '';
    kit.render(focus);
  }

  function option(type: string, name: string, key: string, checked: boolean, text: string, hint: string, onChange: (input: HTMLInputElement) => void): HTMLElement {
    const label = el('label', 'opt');
    const input = el('input') as HTMLInputElement;
    input.type = type;
    if (name) input.name = name;
    input.checked = checked;
    input.disabled = p.saving;
    input.setAttribute('data-key', key);
    input.addEventListener('change', () => onChange(input));
    const words = add(el('span', 'opt-text'), el('span', '', text));
    if (hint) add(words, el('span', 'muted opt-hint', hint));
    return add(label, input, words);
  }

  function group(legend: string, help: string): HTMLElement {
    const box = el('fieldset', 'group');
    add(box, el('legend', '', legend));
    if (help) add(box, el('p', 'muted', help));
    return box;
  }

  function senderField(which: 'always_private_senders' | 'skip_senders', title: string, help: string): HTMLElement {
    const label = el('label', 'field');
    add(label, el('span', 'field-label', title), el('span', 'muted', help));
    const area = el('textarea', 'text') as HTMLTextAreaElement;
    area.rows = 3;
    area.spellcheck = false;
    area.disabled = p.saving;
    area.value = p.draft[which].join('\n');
    area.setAttribute('data-key', 'picker:senders:' + which);
    area.addEventListener('input', () => {
      p.draft[which] = area.value.split('\n');
      p.edited = true;
      const slot = p.summaryNode as HTMLElement | null;
      if (slot) slot.textContent = mailSummary();
    });
    return add(label, area);
  }

  function lowerFirst(value: string): string {
    return value ? value.charAt(0).toLowerCase() + value.slice(1) : value;
  }

  function plural(words: { one: string; many: string }, n: number): string {
    return fill(n === 1 ? words.one : words.many, { n: kit.count(n) });
  }

  function mailSummary(): string {
    const draft = draftOut();
    const skipped = draft.skipped_categories.length + draft.skipped_labels.length;
    return [
      fill(Q.mailSummaryWindow, { window: lowerFirst((Q.mailWindows as Any)[draft.window]) }),
      plural(Q.mailSummarySkipped, skipped),
      plural(Q.mailSummaryPrivate, draft.always_private_senders.length),
      plural(Q.mailSummarySkipSenders, draft.skip_senders.length),
    ].join(' · ');
  }

  function addSender(which: 'always_private_senders' | 'skip_senders', sender: string, focus: string): void {
    const listNow: string[] = p.draft[which].map((line: string) => line.trim()).filter((line: string) => line);
    if (listNow.indexOf(sender) < 0) listNow.push(sender);
    p.draft[which] = listNow;
    mailEdited(focus);
  }

  function mailView(page: HTMLElement): void {
    add(page, el('h1', '', p.title));
    add(page, el('p', 'muted', fill(Q.mailIntro, { source: p.label })));
    if (p.notice) {
      const notice = el('p', 'notice', p.notice);
      notice.setAttribute('role', 'status');
      add(page, notice);
    }
    if (p.error) {
      const error = el('div', 'banner');
      error.setAttribute('role', 'alert');
      add(error, add(el('div', 'banner-body'), el('p', '', p.error),
        add(el('div', 'actions'), kit.button(Q.tryAgain, 'picker:retry', () => p.retry && p.retry(), 'plain'))));
      add(page, error);
    }
    if (!p.loaded) {
      if (p.loading) {
        const line = el('p', 'muted', Q.loadingMail);
        line.setAttribute('role', 'status');
        add(page, line);
      }
      return;
    }
    const draft = p.draft;
    const windows = group(Q.mailWindow, Q.mailWindowHelp);
    for (const value of WINDOWS) {
      add(windows, option('radio', 'mail-window', 'picker:window:' + value, draft.window === value,
        (Q.mailWindows as Any)[value], value === '2y' ? Q.mailRecommended : '', () => {
          draft.window = value;
          mailEdited('picker:window:' + value);
        }));
    }
    add(page, windows);
    const categories = group(Q.mailCategories, Q.mailCategoriesHelp);
    for (const category of CATEGORIES) {
      const words = (Q.mailCategoryNames as Any)[category];
      const known = p.categories.filter((entry: Any) => entry && entry.category === category)[0];
      const hint = known && typeof known.messages_total === 'number'
        ? words[1] + ' · ' + fill(Q.mailCategoryCount, { count: kit.count(known.messages_total) }) : words[1];
      add(categories, option('checkbox', '', 'picker:category:' + category, draft.skipped_categories.indexOf(category) < 0,
        words[0], hint, (input) => {
          const rest = draft.skipped_categories.filter((entry: string) => entry !== category);
          draft.skipped_categories = input.checked ? rest : rest.concat([category]);
          mailEdited('picker:category:' + category);
        }));
    }
    add(page, categories);
    const labels = group(Q.mailLabels, Q.mailLabelsHelp);
    if (!p.labels.length) add(labels, el('p', 'muted', Q.mailLabelsEmpty));
    p.labels.forEach((label: Any, index: number) => {
      const skipped = draft.skipped_labels.some((entry: Any) => entry.id === label.id);
      add(labels, option('checkbox', '', 'picker:label:' + index, !skipped, label.id === 'SENT' ? Q.mailSentLabel : label.name, '', (input) => {
        const rest = draft.skipped_labels.filter((entry: Any) => entry.id !== label.id);
        draft.skipped_labels = input.checked ? rest : rest.concat([{ id: label.id, name: label.name }]);
        mailEdited('picker:label:' + index);
      }));
    });
    add(page, labels);
    const senders = group(Q.mailSenders, '');
    add(senders, senderField('always_private_senders', Q.mailPrivate, Q.mailPrivateHelp));
    add(senders, senderField('skip_senders', Q.mailSkip, Q.mailSkipHelp));
    if (p.suggestions.length) {
      add(senders, el('p', 'field-label', Q.mailSuggestions));
      const listNode = el('ul', 'suggestions');
      p.suggestions.forEach((entry: Any, index: number) => {
        const item = el('li', 'suggestion');
        const text = add(el('p', 'suggestion-text'), el('span', '', entry.sender));
        if (typeof entry.sample_messages === 'number' && p.sampleSize > 0) {
          add(text, el('span', 'muted', ' · ' + fill(Q.mailSuggestionCount, { n: kit.count(entry.sample_messages), total: kit.count(p.sampleSize) })));
        }
        add(item, text, add(el('div', 'actions'),
          kit.button(Q.mailPrivate, 'picker:suggest:private:' + index, p.saving ? null : () => addSender('always_private_senders', entry.sender, 'picker:suggest:private:' + index), 'plain'),
          kit.button(Q.mailSkip, 'picker:suggest:skip:' + index, p.saving ? null : () => addSender('skip_senders', entry.sender, 'picker:suggest:skip:' + index), 'plain')));
        add(listNode, item);
      });
      add(senders, listNode);
    }
    add(page, senders);
    const footer = el('section', 'picker-footer');
    footer.setAttribute('aria-label', Q.summaryTitle);
    const summary = el('div', 'summary');
    summary.setAttribute('aria-live', 'polite');
    const summaryLine = el('p', '', mailSummary());
    p.summaryNode = summaryLine;
    add(summary, summaryLine);
    const estimate = p.estimate;
    if (estimate && typeof estimate.content_messages === 'number' && typeof estimate.metadata_messages === 'number') {
      add(summary, el('p', '', fill(Q.mailEstimate, { content: kit.count(estimate.content_messages), metadata: kit.count(estimate.metadata_messages) })));
      if (typeof estimate.embedding_cost_usd === 'number' && isFinite(estimate.embedding_cost_usd)) {
        add(summary, el('p', '', fill(Q.mailCost, { cost: estimate.embedding_cost_usd.toFixed(2) })));
      }
      add(summary, el('p', 'muted', Q.mailEstimateNote));
    }
    add(summary, add(el('div', 'actions'), kit.button(p.loading ? Q.loadingMail : Q.mailUpdateEstimate, 'picker:estimate',
      p.loading || p.saving ? null : () => listMail(true), 'plain')));
    add(footer, summary);
    add(footer, saveRow(!p.saving && !p.loading, Q.saveMail, () => {
      if (p.saving || !p.loaded) return;
      const args: Any = { source_id: p.id, account_generation: p.generation, scope_revision: p.revision };
      args[kit.config.mailArgs.set] = draftOut();
      save(args, 'picker:save');
    }, ''));
    add(page, footer);
  }

  // ---- shell -------------------------------------------------------------
  function back(): void {
    if (!p) return;
    if (p.mode !== 'connect' && p.edited && !p.saving) {
      p.discarding = true;
      kit.render('picker:discard:no');
      return;
    }
    leave('', false);
  }

  function view(): HTMLElement {
    const page = el('main', 'page picker');
    searchRows = [];
    searchEmpty = null;
    if (!p) return page;
    const top = el('div', 'picker-top');
    const backButton = kit.button(Q.back, 'picker:back', back, 'plain');
    backButton.className = 'btn back';
    add(top, backButton);
    add(page, top);
    if (p.discarding) {
      const confirm = el('div', 'confirm-box');
      confirm.setAttribute('role', 'alert');
      add(confirm, el('p', 'strong', Q.discardPrompt), add(el('div', 'actions'),
        kit.button(Q.discard, 'picker:discard:yes', () => leave('', false), 'danger'),
        kit.button(Q.keep, 'picker:discard:no', () => {
          p.discarding = false;
          kit.render('picker:back');
        }, 'plain')));
      add(page, confirm);
    }
    if (p.mode === 'connect') connectView(page);
    else if (p.mode === 'mail') mailView(page);
    else foldersView(page);
    return page;
  }

  return {
    handles,
    start,
    active: () => !!p,
    view,
    afterRender: () => {
      if (p && p.mode === 'folders') applySearch();
    },
  };
}
