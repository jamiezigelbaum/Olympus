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
 * drops the session. Pick mode (the privacy flow's Add a folder) saves
 * nothing: it hands the one picked folder's key and name back to its caller.
 */
import type { DASHBOARD_CHATGPT_PICKER_COPY } from '../vocabulary.ts';
import {
  CONNECT_SOURCE_TOOL_NAME,
  SCOPE_LIST_TOOL_NAME,
  SCOPE_SET_TOOL_NAME,
  SCOPE_UI_META_KEY,
} from '../../chatgpt/dashboard-contract.ts';

/** The backend tools the picker calls, named by the contract (dashboard-contract.ts). */
export const CHATGPT_PICKER_TOOLS = {
  /** {source} → structuredContent {status: 'open_link', openUrl} on the connect host's /go/ path. */
  connectSource: CONNECT_SOURCE_TOOL_NAME,
  /** {source_id, parent_key?, cursor?, draft?} → ScopeSummary; the picker data is in `_meta[scopeMetaKey]`. */
  scopeList: SCOPE_LIST_TOOL_NAME,
  /** {..., selections | mail} → {status: 'saved'} or {status: 'conflict'} with the fresh list in `_meta`. */
  scopeSet: SCOPE_SET_TOOL_NAME,
} as const;

/** Argument names that carry the mail draft (list: the estimate; set: the save). */
export const CHATGPT_PICKER_MAIL_ARGS = { list: 'draft', set: 'mail' } as const;

/** The result `_meta` key that carries picker data (names, keys, cursors) to the widget only. */
export const CHATGPT_SCOPE_META_KEY = SCOPE_UI_META_KEY;

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
  /** The fixed sentence of a setup tool error the page shows inline (sign_in_failed, …), or ''. */
  errorText(result: Any): string;
  setDashboard(value: Any): void;
  /** Leave the picker: optional notice, refresh the dashboard when asked, focus the control that opened it. */
  close(notice: string, refresh: boolean, focusKey: string): void;
}

/** Words for picking one folder (the privacy flow's Add a folder); the caller owns them. */
export interface ChatGptFolderPickWords {
  back: string;
  title: string;
  intro: string;
  makePrivate: string;
  makePrivateFor: string;
  alreadyPrivate: string;
}

/** The folder picked in pick mode: its opaque key and its name, for the caller's own view only. */
export interface ChatGptPickedFolder {
  key: string;
  name: string;
}

export interface ChatGptPicker {
  handles(fix: Any): boolean;
  start(fix: Any, sourceId: string, sourceLabel: string, returnKey: string): void;
  /**
   * Browse one folder source a level per screen and pick a single folder, with
   * no choices and no save: `done` gets the folder, or null on Back.
   * `taken` keys show as already picked.
   */
  pickFolder(sourceId: string, sourceLabel: string, words: ChatGptFolderPickWords, taken: string[], done: (folder: ChatGptPickedFolder | null) => void): void;
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
  /** The whole-account row's key in focus keys (never a provider key). */
  const ACCOUNT = '@account';
  /** olympus_scope_set accepts at most this many explicit rules (its input schema's maxItems). */
  const MAX_RULES = 100;

  function handles(fix: Any): boolean {
    return !!fix && (fix.tool === T.connectSource || fix.tool === T.scopeList);
  }

  function stopTimer(): void {
    if (timer) clearTimeout(timer);
    timer = null;
  }

  function leave(notice: string, refresh: boolean, picked?: ChatGptPickedFolder): void {
    stopTimer();
    if (p && p.pick) {
      const done = p.pick.done;
      p = null;
      session++;
      done(picked || null);
      return;
    }
    const key = p ? p.returnKey : '';
    p = null;
    session++;
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
        p.errorText = kit.errorText(result);
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
      p.errorText = '';
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
      const line = el('p', '', p.errorText || fill(Q.connectFailed, { source: p.label }));
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

  function pickFolder(sourceId: string, sourceLabel: string, words: ChatGptFolderPickWords, taken: string[],
    done: (folder: ChatGptPickedFolder | null) => void): void {
    stopTimer();
    session++;
    if (kit.compact()) kit.fullscreen();
    openScope(sourceId, sourceLabel, words.title, '', '', undefined, { words, taken: taken.slice(), done });
  }

  // ---- scope sessions ----------------------------------------------------
  function openScope(id: string, label: string, title: string, returnKey: string, notice: string, initial?: Any, pick?: Any): void {
    stopTimer();
    session++;
    const mail = id === kit.config.mailSourceId;
    p = {
      mode: mail ? 'mail' : 'folders', id, label, returnKey, notice,
      title: title || (mail ? Q.mailTitle : Q.foldersTitle),
      loading: 'root', loaded: false, error: '', retry: null, generation: '', revision: '',
      edited: false, saving: false, saveError: '', discarding: false,
      // folders
      roots: [], rootCursor: '', branches: new Map(), cursors: new Map(), catalog: new Map(),
      ancestors: new Map(), own: new Map(), whole: false, wholeConfirmed: false,
      path: [], lastSeg: '',
      // mail
      draft: null, labels: [], categories: [], suggestions: [], sampleSize: 0, estimate: null,
      // pick mode (privacy): one folder, no choices, no save
      pick: pick || null,
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
    openScope(keep.id, keep.label, keep.title, keep.returnKey, message, fresh || undefined, keep.pick || undefined);
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
  // One level per screen: the root (the whole-account row, the exceptions,
  // the top-level folders) or a folder (its own choice, then its folders).
  // Every row carries one segmented control (Full, Names only, Skip): a tap
  // sets that folder's own choice and a second tap clears it. Only explicit
  // rules are stored; inherited choices and Mixed are derived on every render.
  function list(parentKey: string, append: boolean, after?: () => void): void {
    const cursor = append ? (parentKey ? p.cursors.get(parentKey) : p.rootCursor) : '';
    const args: Any = { source_id: p.id };
    if (parentKey) args.parent_key = parentKey;
    if (cursor) args.cursor = cursor;
    p.loading = parentKey || 'root';
    p.error = '';
    // A deeper level keeps focus where it is (the row's control) until it arrives.
    const focus = append ? 'picker:more:' + parentKey : p.loaded ? '' : 'picker:back';
    kit.render(focus);
    const mine = session;
    kit.call(T.scopeList, args).then((result) => {
      if (mine !== session || !p) return;
      const page = scopeData(result);
      if (!validBrowse(page)) {
        failLoad(() => list(parentKey, append, after), 'picker:retry');
        return;
      }
      if (p.loaded && !p.pick && (page.account_generation !== p.generation || page.scope_revision !== p.revision)) {
        reload(Q.conflict, parentKey || append ? null : page);
        return;
      }
      takeFolders(page, parentKey, append, focus, after);
    }, () => {
      if (mine !== session || !p) return;
      failLoad(() => list(parentKey, append, after), 'picker:retry');
    });
  }

  function takeFolders(page: Any, parentKey: string, append: boolean, focus: string, after?: () => void): void {
    if (!p.loaded) {
      p.generation = page.account_generation;
      p.revision = page.scope_revision;
      p.whole = page.whole_account_selected === true;
      p.wholeConfirmed = p.whole;
      const saved = Array.isArray(page.selections) ? page.selections : [];
      for (const selection of saved) {
        if (!selection || typeof selection.key !== 'string' || STATES.indexOf(selection.state) < 0) continue;
        p.own.set(selection.key, selection.state);
        p.ancestors.set(selection.key, Array.isArray(selection.ancestor_keys)
          ? selection.ancestor_keys.filter((key: Any) => typeof key === 'string') : []);
      }
      p.loaded = true;
    }
    const trail: string[] = parentKey ? trailOf(parentKey) : [];
    const previous: Any[] = append ? (parentKey ? p.branches.get(parentKey) || [] : p.roots) : [];
    const seen: Record<string, boolean> = {};
    for (const node of previous) seen[node.key] = true;
    const fresh = page.nodes.filter((node: Any) => !seen[node.key] && trail.indexOf(node.key) < 0);
    for (const node of fresh) {
      p.catalog.set(node.key, node);
      p.ancestors.set(node.key, trail);
    }
    // Alphabetical, numbers in numeric order ("2 Areas" before "10 Notes"),
    // whatever order the provider lists them in.
    const nodes = previous.concat(fresh).sort((a: Any, b: Any) =>
      String(a.name).localeCompare(String(b.name), undefined, { numeric: true, sensitivity: 'base' }));
    const next = typeof page.next_cursor === 'string' && page.next_cursor ? page.next_cursor : '';
    if (parentKey) {
      p.branches.set(parentKey, nodes);
      if (next) p.cursors.set(parentKey, next);
      else p.cursors.delete(parentKey);
    } else {
      p.roots = nodes;
      p.rootCursor = next;
    }
    p.loading = '';
    if (after) after();
    else kit.render(focus);
  }

  function trailOf(key: string): string[] {
    return (p.ancestors.get(key) || []).concat([key]);
  }

  function nameOf(key: string): string {
    const node = p.catalog.get(key);
    if (node && typeof node.name === 'string' && node.name) return node.name;
    // Not listed yet: name it by the nearest listed folder above it, when there is one.
    const above = (p.ancestors.get(key) || []).filter((ancestor: string) => {
      const known = p.catalog.get(ancestor);
      return known && typeof known.name === 'string' && known.name;
    });
    return above.length ? fill(Q.insideFolder, { name: p.catalog.get(above[above.length - 1]).name }) : Q.unknownFolder;
  }

  /** An exception's label: its name under its parent's ("Clients / Archive 2019") when both are loaded. */
  function shortPath(key: string): string {
    const node = p.catalog.get(key);
    if (!node || typeof node.name !== 'string' || !node.name) return nameOf(key);
    const ancestors: string[] = p.ancestors.get(key) || [];
    const parent = ancestors.length ? p.catalog.get(ancestors[ancestors.length - 1]) : null;
    return parent && typeof parent.name === 'string' && parent.name ? parent.name + ' / ' + node.name : node.name;
  }

  /** What a folder gets from above it: the strictest ancestor rule wins, as the engine evaluates it. */
  function inherited(key: string): { state: string; from: string } {
    let state = p.whole ? 'ingest' : '';
    let from = p.whole ? ACCOUNT : '';
    for (const ancestor of p.ancestors.get(key) || []) {
      const choice = p.own.get(ancestor);
      if (choice === 'exclude') {
        state = 'exclude';
        from = ancestor;
      } else if (choice === 'metadata_only' && state !== 'exclude') {
        state = 'metadata_only';
        from = ancestor;
      } else if (choice === 'ingest' && (state === '' || state === 'ingest')) {
        state = 'ingest';
        from = ancestor;
      }
    }
    return { state, from };
  }

  /** '' is Not included: no rule here or above, and the whole account is not chosen. */
  function effective(key: string): string {
    const from = inherited(key).state;
    const own = p.own.get(key) || '';
    if (from === 'exclude' || own === 'exclude') return 'exclude';
    if (from === 'metadata_only') return 'metadata_only';
    return own || from;
  }

  function allowed(key: string, state: string): boolean {
    const from = inherited(key).state;
    if (!state) return true;
    if (from === 'exclude') return state === 'exclude';
    if (from === 'metadata_only') return state !== 'ingest';
    return true;
  }

  function descendants(key: string): string[] {
    const out: string[] = [];
    p.own.forEach((_state: string, other: string) => {
      if (other !== key && (p.ancestors.get(other) || []).indexOf(key) >= 0) out.push(other);
    });
    return out;
  }

  /** Derived from the known rules below a folder, never stored: the first effective choice that differs. */
  function mixed(key: string): string {
    const mine = effective(key);
    for (const other of descendants(key)) {
      const theirs = effective(other);
      if (theirs !== mine) return theirs;
    }
    return '';
  }

  function stateName(state: string): string {
    return state ? (Q.states as Any)[state] : Q.notIncluded;
  }

  function sourceName(from: string): string {
    return from === ACCOUNT ? fill(Q.accountRow, { source: p.label }) : nameOf(from);
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

  /** The muted size and file count after a folder's name: [size, count], either may be ''. */
  function nodeMeta(node: Any): [string, string] {
    let bytes = '';
    let files = '';
    if (typeof node.size_bytes === 'number' && isFinite(node.size_bytes) && node.size_bytes >= 0) bytes = size(node.size_bytes);
    if (typeof node.file_count === 'number' && isFinite(node.file_count) && node.file_count >= 0) {
      const n = Math.round(node.file_count);
      files = fill(n === 1 ? Q.folderFiles.one : Q.folderFiles.many, { n: kit.count(n) });
    }
    return [bytes, files];
  }

  /** Exceptions: folders whose own rule differs from what they would inherit. */
  function exceptions(): string[] {
    const out: string[] = [];
    p.own.forEach((state: string, key: string) => {
      if (state !== inherited(key).state) out.push(key);
    });
    return out;
  }

  /** Set (or with '' clear) one folder's own choice, or the whole account's. */
  function choose(key: string, value: string, focus: string): void {
    if (p.saving) return;
    if (key === ACCOUNT) {
      const whole = value === 'ingest';
      if (whole !== p.whole) {
        p.whole = whole;
        p.wholeConfirmed = false;
        p.edited = true;
      }
    } else {
      if (value && STATES.indexOf(value) < 0) return;
      if (value && !allowed(key, value)) return;
      if (value && !p.own.has(key) && p.own.size >= MAX_RULES) return;
      if (value) p.own.set(key, value);
      else p.own.delete(key);
      p.edited = true;
    }
    // The connect line is a one-time hello; a refreshed-view warning stays until the next save.
    if (p.notice && p.notice !== Q.conflict) p.notice = '';
    p.saveError = '';
    p.lastSeg = focus;
    kit.render(focus);
  }

  function drill(key: string): void {
    if (p.loading || p.saving) return;
    const arrive = () => {
      p.path = trailOf(key);
      kit.render('picker:up');
    };
    if (p.branches.has(key)) arrive();
    else list(key, false, arrive);
  }

  /** Open a folder anywhere, loading each level above it with the ancestor keys already held. */
  function jump(key: string): void {
    if (p.loading || p.saving) return;
    const trail = trailOf(key);
    const mine = session;
    const step = (index: number): void => {
      if (mine !== session || !p) return;
      if (index >= trail.length) {
        p.path = trail;
        kit.render('picker:up');
        return;
      }
      if (p.branches.has(trail[index])) step(index + 1);
      else list(trail[index]!, false, () => step(index + 1));
    };
    step(0);
  }

  function up(): void {
    const left = p.path.pop();
    kit.render(left ? 'picker:open:' + left : 'picker:back');
  }

  function counts(): Any {
    const totals: Any = { ingest: 0, metadata_only: 0, exclude: 0 };
    p.own.forEach((_state: string, key: string) => {
      const state = effective(key);
      if (state) totals[state]++;
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
    if (p.whole) lines.push(fill(Q.summaryWhole, { source: p.label }));
    if (parts.length) {
      const bytes = indexedBytes();
      lines.push(parts.join(', ') + (bytes > 0 ? ' · ' + fill(Q.summarySize, { size: size(bytes) }) : ''));
    } else if (!p.whole) lines.push(Q.summaryNone);
    return lines;
  }

  function anyChosen(): boolean {
    let chosen = false;
    p.own.forEach((_state: string, key: string) => {
      const state = effective(key);
      if (state === 'ingest' || state === 'metadata_only') chosen = true;
    });
    return chosen;
  }

  function saveFolders(): void {
    if (!canSaveFolders()) return;
    // Explicit rules only, exactly as chosen: the engine applies the strictest rule above each folder.
    const selections: Any[] = [];
    p.own.forEach((state: string, key: string) => {
      selections.push({ key, state, ancestor_keys: (p.ancestors.get(key) || []).slice() });
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
    if (!p.loaded || p.saving || !p.generation || !p.revision || p.own.size > MAX_RULES) return false;
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

  function wholeConfirm(): HTMLElement {
    const confirm = el('div', 'confirm-box');
    confirm.setAttribute('role', 'alert');
    add(confirm, el('p', 'strong', fill(Q.wholePrompt, { source: p.label })), add(el('div', 'actions'),
      kit.button(Q.wholeConfirm, 'picker:whole:yes', p.saving ? null : () => {
        p.wholeConfirmed = true;
        kit.render('picker:seg:' + ACCOUNT + ':ingest');
      }, 'danger'),
      kit.button(Q.cancel, 'picker:whole:no', p.saving ? null : () => {
        p.whole = false;
        p.wholeConfirmed = false;
        kit.render('picker:seg:' + ACCOUNT + ':ingest');
      }, 'plain')));
    return confirm;
  }

  /** Arrow keys, Home and End move focus between a control's enabled segments. */
  function segKeys(event: KeyboardEvent, buttons: HTMLButtonElement[], current: HTMLButtonElement): void {
    const live = buttons.filter((button) => !button.disabled);
    if (!live.length) return;
    const at = live.indexOf(current);
    let next: HTMLButtonElement | undefined;
    if (event.key === 'ArrowRight' || event.key === 'ArrowDown') next = live[(at + 1) % live.length];
    else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') next = live[(at - 1 + live.length) % live.length];
    else if (event.key === 'Home') next = live[0];
    else if (event.key === 'End') next = live[live.length - 1];
    if (!next) return;
    event.preventDefault();
    for (const button of buttons) button.tabIndex = button === next ? 0 : -1;
    next.focus();
  }

  interface SegModel {
    /** The explicit choice ('' when none). */
    pressed: string;
    /** The choice that applies without being chosen here: drawn weaker than an explicit one. */
    inherited: string;
    /** Why a segment cannot be chosen here, or ''. */
    blocked(state: string): string;
    /** A quiet description for a segment (where an inherited choice comes from), or ''. */
    note(state: string): string;
    pick(state: string): void;
  }

  /**
   * One pill of three segments (Full, Names only, Skip): buttons with
   * aria-pressed in a radiogroup, one tab stop, arrow keys between segments.
   */
  function segControl(name: string, focusBase: string, model: SegModel): HTMLElement {
    const group = el('div', 'seg');
    group.setAttribute('role', 'radiogroup');
    group.setAttribute('aria-label', fill(Q.choiceGroup, { name }));
    const buttons: HTMLButtonElement[] = [];
    for (const state of STATES) {
      const words = (Q.segments as Any)[state] as readonly [string, string];
      const pressed = model.pressed === state;
      const button = el('button', 'seg-opt' + (pressed ? ' on' : model.inherited === state ? ' inherited' : '')) as HTMLButtonElement;
      button.type = 'button';
      button.setAttribute('data-key', focusBase + state);
      button.setAttribute('aria-label', words[0]);
      button.setAttribute('aria-pressed', pressed ? 'true' : 'false');
      add(button, el('span', 'seg-long', words[0]), el('span', 'seg-short', words[1]));
      const blocked = pressed ? '' : model.blocked(state);
      const note = blocked || model.note(state);
      if (note) {
        button.setAttribute('aria-description', note);
        button.title = note;
      }
      if (blocked || p.saving) button.disabled = true;
      else button.addEventListener('click', () => model.pick(state));
      button.addEventListener('keydown', (event: KeyboardEvent) => segKeys(event, buttons, button));
      buttons.push(button);
      add(group, button);
    }
    const live = buttons.filter((button) => !button.disabled);
    const home = live.filter((button) => button.getAttribute('data-key') === p.lastSeg)[0]
      || live.filter((button) => button.getAttribute('aria-pressed') === 'true')[0]
      || live.filter((button) => button.className.indexOf('inherited') >= 0)[0]
      || live[0];
    for (const button of buttons) button.tabIndex = button === home ? 0 : -1;
    return group;
  }

  /** A folder's control: its own choice, what it inherits, and the engine's no-more-open-than-the-parent rule. */
  function folderControl(key: string, name: string, node: Any): HTMLElement {
    const own = p.own.get(key) || '';
    const from = inherited(key);
    const now = effective(key);
    const selectable = !node || node.selectable !== false;
    const capped = !own && p.own.size >= MAX_RULES;
    return segControl(name, 'picker:seg:' + key + ':', {
      pressed: own,
      // An own choice a stricter parent overrides shows the winning choice beside it.
      inherited: own ? (now !== own ? now : '') : from.state,
      blocked: (state) => {
        if (!selectable) return Q.cannotChoose;
        if (!allowed(key, state)) return fill(Q.notPossible, { parent: sourceName(from.from), state: (Q.statesLower as Any)[from.state] });
        if (capped) return fill(Q.capReached, { max: kit.count(MAX_RULES) });
        return '';
      },
      note: (state) => {
        if (own === state && now !== own) return fill(Q.overridden, { own: stateName(own), parent: sourceName(from.from), state: stateName(from.state) });
        if (!own && from.from && from.state === state) return fill(Q.inheritedFrom, { parent: sourceName(from.from) });
        return '';
      },
      pick: (state) => choose(key, own === state ? '' : state, 'picker:seg:' + key + ':' + state),
    });
  }

  /** The whole account is on or off in the contract: Full is the only choice it can carry. */
  function accountControl(): HTMLElement {
    return segControl(fill(Q.accountRow, { source: p.label }), 'picker:seg:' + ACCOUNT + ':', {
      pressed: p.whole ? 'ingest' : '',
      inherited: '',
      blocked: (state) => (state === 'ingest' ? '' : Q.wholeOnlyFull),
      note: () => '',
      pick: (state) => choose(ACCOUNT, p.whole ? '' : state, 'picker:seg:' + ACCOUNT + ':' + state),
    });
  }

  /** Pick mode: Make private, or Already private when the caller holds it. */
  function pickButton(key: string, name: string, focusKey: string): HTMLButtonElement {
    const words = p.pick.words;
    if (p.pick.taken.indexOf(key) >= 0) return kit.button(words.alreadyPrivate, focusKey, null, 'plain');
    const control = kit.button(words.makePrivate, focusKey, p.loading ? null : () => leave('', false, { key, name }), 'plain');
    control.setAttribute('aria-label', fill(words.makePrivateFor, { name }));
    return control;
  }

  /** Pick mode keeps its own row: the name opens the folder, Make private on the right. */
  function pickRow(node: Any): HTMLElement {
    const key = node.key;
    const li = el('li', 'frow pick');
    if (node.has_children) {
      const open = el('button', 'fname') as HTMLButtonElement;
      open.type = 'button';
      open.setAttribute('data-key', 'picker:open:' + key);
      add(open, el('span', 'fname-text', node.name));
      const chevron = el('span', 'chev', '›');
      chevron.setAttribute('aria-hidden', 'true');
      add(open, chevron);
      if (p.loading || p.saving) open.disabled = true;
      else open.addEventListener('click', () => drill(key));
      add(li, open);
    } else add(li, add(el('p', 'fname leaf'), el('span', 'fname-text', node.name)));
    if (node.selectable !== false) add(li, pickButton(key, node.name, 'picker:pick:' + key));
    return li;
  }

  /**
   * The name and a Mixed tag when the folders inside differ (together, the
   * name truncating first), then the muted size and file count, each shown
   * only when it fits whole on the line.
   */
  function nameParts(target: HTMLElement, name: string, key: string, node: Any): void {
    const main = add(el('span', 'fname-main'), el('span', 'fname-text', name));
    const differs = key ? mixed(key) : '';
    if (differs) {
      const tag = el('span', 'ftag', Q.mixed);
      tag.title = fill(Q.mixedSome, { state: (Q.statesLower as Any)[differs] });
      add(main, tag);
    }
    add(target, main);
    if (node) {
      const [bytes, files] = nodeMeta(node);
      if (bytes) add(target, el('span', 'fmeta fsize', bytes));
      if (files) add(target, el('span', 'fmeta fcount', (bytes ? '· ' : '') + files));
    }
  }

  /** One thin line: name (opens the folder), the choice control, then › to open it. */
  function folderRow(node: Any): HTMLElement {
    if (p.pick) return pickRow(node);
    const key = node.key;
    const li = el('li', 'frow seg-row');
    const busy = p.loading || p.saving;
    let label: HTMLElement;
    if (node.has_children) {
      const open = el('button', 'fname') as HTMLButtonElement;
      open.type = 'button';
      // The › button is the keyboard target for opening; the name is the wide tap target.
      open.tabIndex = -1;
      open.setAttribute('data-key', 'picker:name:' + key);
      if (busy) open.disabled = true;
      else open.addEventListener('click', () => drill(key));
      label = open;
    } else label = el('p', 'fname leaf');
    label.title = node.name;
    nameParts(label, node.name, key, node);
    add(li, label, folderControl(key, node.name, node));
    if (node.has_children) {
      const chevron = el('button', 'fopen', '›') as HTMLButtonElement;
      chevron.type = 'button';
      chevron.setAttribute('data-key', 'picker:open:' + key);
      chevron.setAttribute('aria-label', fill(Q.openFolder, { name: node.name }));
      chevron.title = fill(Q.openFolder, { name: node.name });
      if (busy) chevron.disabled = true;
      else chevron.addEventListener('click', () => drill(key));
      add(li, chevron);
    } else {
      const spacer = el('span', 'fopen-gap');
      spacer.setAttribute('aria-hidden', 'true');
      add(li, spacer);
    }
    return li;
  }

  function loadMore(parentKey: string): HTMLElement {
    const busy = p.loading === (parentKey || 'root');
    return kit.button(busy ? Q.loadingFolders : Q.loadMore, 'picker:more:' + parentKey, busy || p.loading ? null : () => list(parentKey, true), 'plain');
  }

  function levelList(parentKey: string, nodes: Any[], hasMore: boolean): HTMLElement {
    const listNode = el('ul', 'flist');
    for (const node of nodes) add(listNode, folderRow(node));
    if (!nodes.length) add(listNode, el('li', 'muted fempty', Q.noFolders));
    if (hasMore) add(listNode, add(el('li', 'fmore'), loadMore(parentKey)));
    return listNode;
  }

  function loadingLine(): HTMLElement | null {
    if (!p.loading) return null;
    const line = el('p', 'muted fstate', Q.loadingFolders);
    line.setAttribute('role', 'status');
    return line;
  }

  /** The level's own choice, as a compact row above its folders. */
  function topRow(text: string, control: HTMLElement): HTMLElement {
    const row = el('div', 'this-row');
    add(row, el('p', 'this-label', text), control);
    return row;
  }

  function exceptionList(rules: string[]): HTMLElement {
    const section = el('section', 'fsection exceptions');
    add(section, el('h2', '', fill(Q.exceptions, { n: kit.count(rules.length) })));
    const listNode = el('ul', 'flist');
    for (const key of rules) {
      const path = shortPath(key);
      const state = p.own.get(key);
      const jumpButton = el('button', 'jump-btn') as HTMLButtonElement;
      jumpButton.type = 'button';
      jumpButton.setAttribute('data-key', 'picker:jump:' + key);
      jumpButton.title = path;
      add(jumpButton, el('span', 'fname-text', path), el('span', 'jtag jtag-' + state, (Q.segments as Any)[state][0]));
      const chevron = el('span', 'chev', '›');
      chevron.setAttribute('aria-hidden', 'true');
      add(jumpButton, chevron);
      if (p.loading || p.saving) jumpButton.disabled = true;
      else jumpButton.addEventListener('click', () => jump(key));
      add(listNode, add(el('li', 'frow jump'), jumpButton));
    }
    return add(section, listNode);
  }

  function rootScreen(body: HTMLElement): void {
    add(body, el('h1', '', p.title));
    add(body, el('p', 'muted intro', fill(p.pick ? p.pick.words.intro : Q.foldersIntro, { source: p.label })));
    noticeAndError(body);
    if (!p.loaded) {
      add(body, loadingLine());
      return;
    }
    if (p.pick) {
      const only = add(el('section', 'fsection'), el('h2', '', p.label));
      add(only, loadingLine());
      add(only, levelList('', p.roots, !!p.rootCursor));
      add(body, only);
      return;
    }
    add(body, topRow(fill(Q.accountRow, { source: p.label }), accountControl()));
    if (p.whole && !p.wholeConfirmed) add(body, wholeConfirm());
    const rules = exceptions();
    if (rules.length) add(body, exceptionList(rules));
    const folders = add(el('section', 'fsection'), el('h2', '', Q.foldersHeading));
    add(folders, loadingLine());
    add(folders, levelList('', p.roots, !!p.rootCursor));
    add(body, folders);
  }

  function pathLine(): HTMLElement {
    const names = [p.label].concat(p.path.map((key: string) => nameOf(key)));
    const shown = names.length > 3 ? [Q.pathMore].concat(names.slice(-2)) : names;
    const head = el('h1', 'fpath');
    shown.forEach((name: string, index: number) => {
      if (index === shown.length - 1) add(head, el('span', 'fpath-here', name));
      else add(head, el('span', 'fpath-up', name + ' / '));
    });
    return head;
  }

  function folderScreen(body: HTMLElement): void {
    const key = p.path[p.path.length - 1];
    add(body, pathLine());
    noticeAndError(body);
    const node = p.catalog.get(key);
    if (p.pick) {
      const here = el('div', 'this-row pick');
      add(here, add(el('p', 'this-text'), el('span', 'this-label', nameOf(key))));
      if (!node || node.selectable !== false) add(here, pickButton(key, nameOf(key), 'picker:pick-this'));
      add(body, here);
    } else add(body, topRow(Q.thisFolder, folderControl(key, nameOf(key), node)));
    add(body, loadingLine());
    add(body, levelList(key, p.branches.get(key) || [], p.cursors.has(key)));
  }

  /** A quiet line (the connect hello, or why the view was refreshed) and a load error with Try again. */
  function noticeAndError(body: HTMLElement): void {
    if (p.notice) {
      const notice = el('p', p.notice === Q.conflict ? 'fnote strong' : 'fnote muted', p.notice);
      notice.setAttribute('role', 'status');
      add(body, notice);
    }
    if (p.error) {
      const error = el('div', 'banner');
      error.setAttribute('role', 'alert');
      add(error, add(el('div', 'banner-body'), el('p', '', p.error),
        add(el('div', 'actions'), kit.button(Q.tryAgain, 'picker:retry', () => p.retry && p.retry(), 'plain'))));
      add(body, error);
    }
  }

  function folderFooter(): HTMLElement {
    const footer = el('section', 'picker-footer');
    footer.setAttribute('aria-label', Q.summaryTitle);
    const summary = el('div', 'summary');
    summary.setAttribute('aria-live', 'polite');
    for (const line of folderSummary()) add(summary, el('p', '', line));
    if (p.own.size >= MAX_RULES) add(summary, el('p', 'reason strong', fill(Q.capReached, { max: kit.count(MAX_RULES) })));
    add(footer, summary);
    add(footer, saveRow(canSaveFolders(), p.whole || anyChosen() ? Q.saveFolders : Q.saveNoStart, saveFolders,
      p.whole && !p.wholeConfirmed ? Q.needConfirm : !anyChosen() && !p.edited ? Q.needChoice : ''));
    return footer;
  }

  function foldersView(page: HTMLElement): void {
    const body = el('div', 'picker-body');
    if (p.path.length) folderScreen(body);
    else rootScreen(body);
    if (p.loaded && !p.pick) add(body, folderFooter());
    add(page, body);
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
      const notice = el('p', p.notice === Q.conflict ? 'fnote strong' : 'fnote muted', p.notice);
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
    if (!p) return page;
    const top = el('div', 'picker-top');
    // Inside a folder the top control goes up one level; at the root it leaves the picker.
    const deep = p.mode === 'folders' && p.path.length > 0;
    const backButton = deep
      ? kit.button(Q.up, 'picker:up', escape, 'plain')
      : kit.button(p.pick ? p.pick.words.back : Q.back, 'picker:back', escape, 'plain');
    if (deep) {
      const above = p.path.length > 1 ? nameOf(p.path[p.path.length - 2]) : p.pick ? p.label : fill(Q.accountRow, { source: p.label });
      backButton.setAttribute('aria-label', fill(Q.upTo, { name: above }));
    }
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

  /** Back and Escape: close the discard prompt, then go up a level, then leave. */
  function escape(): void {
    if (!p) return;
    if (p.discarding) {
      p.discarding = false;
      kit.render('picker:back');
    } else if (p.mode === 'folders' && p.path.length) up();
    else back();
  }

  if (typeof document !== 'undefined') {
    document.addEventListener('keydown', (event: KeyboardEvent) => {
      if (!p || event.key !== 'Escape' || event.defaultPrevented) return;
      event.preventDefault();
      escape();
    });
  }

  return {
    handles,
    start,
    pickFolder,
    active: () => !!p,
    view,
    afterRender: () => undefined,
  };
}
