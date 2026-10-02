/**
 * The ChatGPT page's privacy setup: what is private for this person, set once
 * in ChatGPT and edited later from the dashboard's Privacy row.
 *
 * Two tiers are the person's to choose: Personal (shared with ChatGPT, the
 * default) and Private (answered on the Mac only). Secret is detected on the
 * Mac and never offered here. The person describes what is private in their
 * own words and may add always-private folders, Gmail labels and senders.
 *
 * Like picker.ts, `chatgptPrivacyProgram` is never called on the server: the
 * page inlines its source text and hands it to the client with a small kit.
 * It stays self-contained and builds every node with `textContent`.
 *
 * Privacy: the description and the rules' names exist only in this
 * program's session object and the view it renders. They arrive only in the
 * privacy tools' result `_meta` (and the picker tools' `_meta` while adding a
 * folder or label), and leave only as the arguments of the privacy save. They
 * are never written to widget state, model context, the page URL or logs.
 */
import type { DASHBOARD_CHATGPT_PRIVACY_COPY } from '../vocabulary.ts';
import type { ChatGptPicker } from './picker.ts';
import { PRIVACY_GET_TOOL_NAME, PRIVACY_META_KEY, PRIVACY_SET_TOOL_NAME } from '../../chatgpt/dashboard-contract.ts';

/** The privacy tools: get {} and set {description?, rules?}; both answer with the settings in `_meta`. */
export const CHATGPT_PRIVACY_TOOLS = { get: PRIVACY_GET_TOOL_NAME, set: PRIVACY_SET_TOOL_NAME } as const;

/** The result `_meta` key that carries the description and rule names to the widget only. */
export const CHATGPT_PRIVACY_META_KEY = PRIVACY_META_KEY;

/** Folder sources a private folder can come from, with a fallback name when the dashboard has none. */
export const CHATGPT_PRIVACY_FOLDER_SOURCES = {
  'dropbox.files': 'Dropbox',
  'google_drive.docs': 'Google Drive',
} as const;

export type ChatGptPrivacyRuleKind = 'folder' | 'label' | 'sender';

/** One always-private rule as the page sends it (the server adds `display` on the way back). */
export interface ChatGptPrivacyRuleOut {
  kind: ChatGptPrivacyRuleKind;
  source_id: string;
  key?: string;
  value?: string;
}

export interface ChatGptPrivacyConfig {
  tools: typeof CHATGPT_PRIVACY_TOOLS;
  metaKey: string;
  /** olympus_scope_list and its `_meta` key: folders through the picker, Gmail labels here. */
  scopeList: string;
  scopeMetaKey: string;
  mailSourceId: string;
  folderSources: Record<string, string>;
  copy: typeof DASHBOARD_CHATGPT_PRIVACY_COPY;
}

// Loose shapes: the program validates what it reads instead of trusting a type.
/* eslint-disable @typescript-eslint/no-explicit-any */
type Any = any;

/** What the client hands the privacy program. */
export interface ChatGptPrivacyKit {
  config: ChatGptPrivacyConfig;
  el(tag: string, cls?: string, text?: string): HTMLElement;
  add(parent: HTMLElement, ...children: Array<Node | null | undefined | false>): HTMLElement;
  button(label: string, key: string, onClick: (() => void) | null, style: 'main' | 'plain' | 'danger'): HTMLButtonElement;
  fill(template: string, values: Record<string, string | number>): string;
  count(value: number): string;
  call(name: string, args: Any): Promise<Any>;
  render(focusKey?: string): void;
  compact(): boolean;
  fullscreen(): void;
  /** The dashboard view model, to know which sources are connected. */
  data(): Any;
  /** The folder picker, for Add a folder (pick mode). */
  picker: ChatGptPicker | null;
  /** Remember how many rules are saved (a count only), for the dashboard's Privacy row. */
  remember(ruleCount: number): void;
  /** Leave: optional notice, refresh the dashboard when asked, focus the control that opened it. */
  close(notice: string, refresh: boolean, focusKey: string): void;
}

export interface ChatGptPrivacy {
  handles(fix: Any): boolean;
  start(returnKey: string): void;
  active(): boolean;
  view(): HTMLElement;
}

export function chatgptPrivacyProgram(kit: ChatGptPrivacyKit): ChatGptPrivacy {
  const T = kit.config.tools;
  const W = kit.config.copy;
  const el = kit.el;
  const add = kit.add;
  const fill = kit.fill;
  const KINDS = ['folder', 'label', 'sender'];
  const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  const DOMAIN = /^@[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i;

  let s: Any = null;
  let session = 0;

  function handles(fix: Any): boolean {
    return !!fix && fix.tool === T.get;
  }

  function start(returnKey: string): void {
    session++;
    if (kit.compact()) kit.fullscreen();
    s = {
      screen: 'main', returnKey, loaded: false, loading: true, error: '',
      description: '', rules: [], pendingCount: 0,
      edited: false, saving: false, saveError: '', discarding: false, picking: false,
      labels: [], labelsLoading: false, labelsError: '',
      sender: '', senderError: '',
    };
    load();
  }

  function leave(notice: string, refresh: boolean): void {
    const key = s ? s.returnKey : '';
    s = null;
    session++;
    kit.close(notice, refresh, key);
  }

  // ---- data --------------------------------------------------------------
  /** Settings live only in the result's `_meta`, never in structuredContent. */
  function settings(result: Any): Any {
    if (!result || result.isError || !result._meta || typeof result._meta !== 'object') return null;
    const data = result._meta[kit.config.metaKey];
    if (!data || typeof data !== 'object' || !Array.isArray(data.rules)) return null;
    return data;
  }

  function validRule(rule: Any): boolean {
    return !!rule && KINDS.indexOf(rule.kind) >= 0 && typeof rule.source_id === 'string' && !!rule.source_id
      && typeof rule.display === 'string' && (typeof rule.key === 'string' || typeof rule.value === 'string');
  }

  function take(data: Any): void {
    s.description = typeof data.description === 'string' ? data.description : '';
    s.rules = data.rules.filter(validRule).map((rule: Any) => {
      const copy: Any = { kind: rule.kind, source_id: rule.source_id, display: rule.display, removed: false };
      if (typeof rule.key === 'string') copy.key = rule.key;
      if (typeof rule.value === 'string') copy.value = rule.value;
      return copy;
    });
    s.pendingCount = typeof data.pendingCount === 'number' && isFinite(data.pendingCount) ? Math.max(0, data.pendingCount) : 0;
    s.confirmation = typeof data.confirmation === 'string' ? data.confirmation : '';
  }

  function load(): void {
    s.loading = true;
    s.error = '';
    kit.render('privacy:back');
    const mine = session;
    kit.call(T.get, {}).then((result) => {
      if (mine !== session || !s) return;
      const data = settings(result);
      s.loading = false;
      if (!data) {
        s.error = W.loadFailed;
        kit.render('privacy:retry');
        return;
      }
      take(data);
      s.loaded = true;
      kit.render('privacy:description');
    }, () => {
      if (mine !== session || !s) return;
      s.loading = false;
      s.error = W.loadFailed;
      kit.render('privacy:retry');
    });
  }

  function identity(rule: Any): string {
    return rule.kind + '\n' + rule.source_id + '\n' + (typeof rule.key === 'string' ? rule.key : '') + '\n' + (typeof rule.value === 'string' ? rule.value : '');
  }

  function kept(): Any[] {
    return s.rules.filter((rule: Any) => !rule.removed);
  }

  /** Exactly what the save sends: no display names, no local flags. */
  function ruleOut(rule: Any): ChatGptPrivacyRuleOut {
    const out: ChatGptPrivacyRuleOut = { kind: rule.kind, source_id: rule.source_id };
    if (typeof rule.key === 'string') out.key = rule.key;
    if (typeof rule.value === 'string') out.value = rule.value;
    return out;
  }

  function addRule(rule: Any): void {
    const id = identity(rule);
    const existing = s.rules.filter((other: Any) => identity(other) === id)[0];
    if (existing) existing.removed = false;
    else s.rules.push(rule);
    s.edited = true;
    s.saveError = '';
  }

  function save(): void {
    if (!s || !s.loaded || s.saving) return;
    const rules = kept();
    const args: Any = { description: s.description.trim(), rules: rules.map(ruleOut) };
    // The owner's confirmation from olympus_privacy_get: removals and new words need it.
    if (s.confirmation) args.confirmation = s.confirmation;
    s.saving = true;
    s.saveError = '';
    kit.render('privacy:save');
    const mine = session;
    kit.call(T.set, args).then((result) => {
      if (mine !== session || !s) return;
      s.saving = false;
      const data = settings(result);
      if (!data) {
        s.saveError = W.saveFailed;
        kit.render('privacy:save');
        return;
      }
      kit.remember(data.rules.filter(validRule).length);
      leave(W.saved, true);
    }, () => {
      if (mine !== session || !s) return;
      s.saving = false;
      s.saveError = W.saveFailed;
      kit.render('privacy:save');
    });
  }

  // ---- sources -----------------------------------------------------------
  function sources(): Any[] {
    const data = kit.data();
    return data && Array.isArray(data.sources) ? data.sources : [];
  }

  function connected(id: string): Any {
    return sources().filter((source: Any) => source && String(source.id) === id && source.status !== 'Off')[0] || null;
  }

  function sourceLabel(id: string): string {
    const listed = sources().filter((source: Any) => source && String(source.id) === id)[0];
    if (listed && typeof listed.label === 'string' && listed.label) return listed.label;
    return kit.config.folderSources[id] || id;
  }

  function folderSources(): Array<{ id: string; label: string }> {
    return Object.keys(kit.config.folderSources).filter((id) => !!connected(id)).map((id) => ({ id, label: sourceLabel(id) }));
  }

  function gmailConnected(): boolean {
    return !!connected(kit.config.mailSourceId);
  }

  // ---- add a folder ------------------------------------------------------
  function addFolder(): void {
    const choices = folderSources();
    if (!choices.length || !kit.picker) return;
    if (choices.length === 1) {
      pickIn(choices[0]!.id, choices[0]!.label);
      return;
    }
    s.screen = 'sources';
    kit.render('privacy:back');
  }

  function pickIn(id: string, label: string): void {
    const mine = session;
    const taken = kept().filter((rule: Any) => rule.kind === 'folder' && rule.source_id === id && typeof rule.key === 'string')
      .map((rule: Any) => rule.key);
    s.picking = true;
    kit.picker!.pickFolder(id, label, {
      back: W.backToPrivacy,
      title: W.folderTitle,
      intro: W.folderIntro,
      makePrivate: W.makePrivate,
      makePrivateFor: W.makePrivateFor,
      alreadyPrivate: W.alreadyPrivate,
    }, taken, (folder) => {
      if (mine !== session || !s) return;
      s.picking = false;
      s.screen = 'main';
      if (folder) addRule({ kind: 'folder', source_id: id, key: folder.key, display: folder.name, removed: false });
      kit.render('privacy:add:folder');
    });
  }

  // ---- add a Gmail label -------------------------------------------------
  function addLabel(): void {
    if (!gmailConnected()) return;
    s.screen = 'labels';
    s.labels = [];
    s.labelsLoading = true;
    s.labelsError = '';
    kit.render('privacy:back');
    const mine = session;
    kit.call(kit.config.scopeList, { source_id: kit.config.mailSourceId }).then((result) => {
      if (mine !== session || !s) return;
      s.labelsLoading = false;
      const data = result && !result.isError && result._meta && typeof result._meta === 'object' ? result._meta[kit.config.scopeMetaKey] : null;
      if (!data || typeof data !== 'object' || !Array.isArray(data.labels)) {
        s.labelsError = W.loadFailed;
        kit.render('privacy:labels:retry');
        return;
      }
      s.labels = data.labels.filter((label: Any) => label && typeof label.id === 'string' && label.id && typeof label.name === 'string');
      kit.render('privacy:back');
    }, () => {
      if (mine !== session || !s) return;
      s.labelsLoading = false;
      s.labelsError = W.loadFailed;
      kit.render('privacy:labels:retry');
    });
  }

  function labelName(label: Any): string {
    return label.id === 'SENT' ? W.sentLabel : label.name;
  }

  // ---- add a sender ------------------------------------------------------
  function addSender(): void {
    s.screen = 'sender';
    s.sender = '';
    s.senderError = '';
    kit.render('privacy:sender');
  }

  function submitSender(): void {
    const value = String(s.sender || '').trim().toLowerCase();
    if (!EMAIL.test(value) && !DOMAIN.test(value)) {
      s.senderError = W.senderInvalid;
      kit.render('privacy:sender');
      return;
    }
    const rule = { kind: 'sender', source_id: kit.config.mailSourceId, value, display: value, removed: false };
    if (kept().some((other: Any) => identity(other) === identity(rule))) {
      s.senderError = W.senderDuplicate;
      kit.render('privacy:sender');
      return;
    }
    addRule(rule);
    s.screen = 'main';
    kit.render('privacy:add:sender');
  }

  // ---- views -------------------------------------------------------------
  function kindText(rule: Any): string {
    if (rule.kind === 'folder') return fill(W.kindFolder, { source: sourceLabel(rule.source_id) });
    return rule.kind === 'label' ? W.kindLabel : W.kindSender;
  }

  function ruleRow(rule: Any, index: number): HTMLElement {
    const li = el('li', 'frow pick rule');
    if (rule.removed) {
      add(li, el('p', 'fname leaf muted', fill(W.removed, { name: rule.display })));
      const undo = kit.button(W.undo, 'privacy:rule:' + index, s.saving ? null : () => {
        rule.removed = false;
        s.edited = true;
        kit.render('privacy:rule:' + index);
      }, 'plain');
      undo.setAttribute('aria-label', fill(W.undoFor, { name: rule.display }));
      return add(li, undo);
    }
    add(li, add(el('p', 'fname leaf two-line'), el('span', 'two-top', rule.display), el('span', 'two-bottom', kindText(rule))));
    const remove = kit.button(W.remove, 'privacy:rule:' + index, s.saving ? null : () => {
      rule.removed = true;
      s.edited = true;
      s.saveError = '';
      kit.render('privacy:rule:' + index);
    }, 'plain');
    remove.setAttribute('aria-label', fill(W.removeFor, { name: rule.display }));
    return add(li, remove);
  }

  function mainView(page: HTMLElement): void {
    add(page, el('h1', '', W.title));
    add(page, el('p', 'muted intro', W.intro));
    if (s.error) {
      const error = el('div', 'banner');
      error.setAttribute('role', 'alert');
      add(error, add(el('div', 'banner-body'), el('p', '', s.error),
        add(el('div', 'actions'), kit.button(W.tryAgain, 'privacy:retry', load, 'plain'))));
      add(page, error);
    }
    if (!s.loaded) {
      if (s.loading) {
        const line = el('p', 'muted fstate', W.loading);
        line.setAttribute('role', 'status');
        add(page, line);
      }
      return;
    }
    const field = el('label', 'field');
    add(field, el('span', 'field-label', W.descriptionLabel));
    const area = el('textarea', 'text') as HTMLTextAreaElement;
    area.rows = 4;
    area.placeholder = W.descriptionPlaceholder;
    area.value = s.description;
    area.disabled = s.saving;
    area.setAttribute('data-key', 'privacy:description');
    area.addEventListener('input', () => {
      s.description = area.value;
      s.edited = true;
    });
    add(page, add(field, area));

    const rules = add(el('section', 'fsection'), el('h2', '', W.rulesTitle));
    if (s.rules.length) {
      const listNode = el('ul', 'flist');
      s.rules.forEach((rule: Any, index: number) => add(listNode, ruleRow(rule, index)));
      add(rules, listNode);
    } else add(rules, el('p', 'muted fempty', W.rulesEmpty));
    const folders = folderSources().length > 0 && !!kit.picker;
    const gmail = gmailConnected();
    add(rules, add(el('div', 'actions add-rules'),
      kit.button(W.addFolder, 'privacy:add:folder', folders && !s.saving ? addFolder : null, 'plain'),
      kit.button(W.addLabel, 'privacy:add:label', gmail && !s.saving ? addLabel : null, 'plain'),
      kit.button(W.addSender, 'privacy:add:sender', s.saving ? null : addSender, 'plain')));
    if (!folders) add(rules, el('p', 'reason', W.needFolderSource));
    if (!gmail) add(rules, el('p', 'reason', W.needGmail));
    add(page, rules);

    const footer = el('section', 'picker-footer');
    if (s.pendingCount > 0) {
      add(footer, el('p', '', fill(s.pendingCount === 1 ? W.pending.one : W.pending.many, { n: kit.count(s.pendingCount) })));
    }
    const row = el('div', 'actions');
    if (s.saving) {
      const busy = kit.button(W.saving, 'privacy:save', null, 'main');
      busy.setAttribute('aria-busy', 'true');
      add(row, busy);
    } else add(row, kit.button(W.save, 'privacy:save', save, 'main'));
    add(row, kit.button(W.cancel, 'privacy:cancel', s.saving ? null : backOut, 'plain'));
    const wrap = add(el('div', 'save'), row);
    if (s.saveError) {
      const error = el('p', 'error', s.saveError);
      error.setAttribute('role', 'alert');
      add(wrap, error);
    }
    add(page, add(footer, wrap));
  }

  function sourcesView(page: HTMLElement): void {
    add(page, el('h1', '', W.folderSourceTitle));
    add(page, el('p', 'muted intro', W.folderSourceIntro));
    for (const source of folderSources()) {
      const control = el('button', 'account') as HTMLButtonElement;
      control.type = 'button';
      control.setAttribute('data-key', 'privacy:source:' + source.id);
      add(control, add(el('span', 'two-line'), el('span', 'two-top', source.label)));
      const chevron = el('span', 'chev', '›');
      chevron.setAttribute('aria-hidden', 'true');
      add(control, chevron);
      control.addEventListener('click', () => pickIn(source.id, source.label));
      add(page, control);
    }
  }

  function labelsView(page: HTMLElement): void {
    add(page, el('h1', '', W.labelTitle));
    add(page, el('p', 'muted intro', W.labelIntro));
    if (s.labelsError) {
      const error = el('div', 'banner');
      error.setAttribute('role', 'alert');
      add(error, add(el('div', 'banner-body'), el('p', '', s.labelsError),
        add(el('div', 'actions'), kit.button(W.tryAgain, 'privacy:labels:retry', addLabel, 'plain'))));
      add(page, error);
      return;
    }
    if (s.labelsLoading) {
      const line = el('p', 'muted fstate', W.loadingLabels);
      line.setAttribute('role', 'status');
      add(page, line);
      return;
    }
    const listNode = el('ul', 'flist');
    if (!s.labels.length) add(listNode, el('li', 'muted fempty', W.noLabels));
    const mail = kit.config.mailSourceId;
    s.labels.forEach((label: Any, index: number) => {
      const name = labelName(label);
      const li = add(el('li', 'frow pick'), add(el('p', 'fname leaf'), el('span', 'fname-text', name)));
      const rule = { kind: 'label', source_id: mail, key: label.id, value: label.name, display: name, removed: false };
      if (kept().some((other: Any) => other.kind === 'label' && other.source_id === mail && other.key === label.id)) {
        add(li, kit.button(W.alreadyPrivate, 'privacy:label:' + index, null, 'plain'));
      } else {
        const control = kit.button(W.makePrivate, 'privacy:label:' + index, () => {
          addRule(rule);
          s.screen = 'main';
          kit.render('privacy:add:label');
        }, 'plain');
        control.setAttribute('aria-label', fill(W.makePrivateFor, { name }));
        add(li, control);
      }
      add(listNode, li);
    });
    add(page, listNode);
  }

  function senderView(page: HTMLElement): void {
    add(page, el('h1', '', W.senderTitle));
    add(page, el('p', 'muted intro', W.senderIntro));
    const field = el('label', 'field');
    add(field, el('span', 'field-label', W.senderLabel));
    const input = el('input', 'text') as HTMLInputElement;
    input.type = 'text';
    input.setAttribute('inputmode', 'email');
    input.setAttribute('autocomplete', 'off');
    input.spellcheck = false;
    input.placeholder = W.senderPlaceholder;
    input.value = s.sender;
    input.setAttribute('data-key', 'privacy:sender');
    input.addEventListener('input', () => {
      s.sender = input.value;
    });
    input.addEventListener('keydown', (event: KeyboardEvent) => {
      if (event.key !== 'Enter') return;
      event.preventDefault();
      submitSender();
    });
    add(field, input);
    if (s.senderError) {
      const error = el('p', 'error', s.senderError);
      error.id = 'privacy-sender-error';
      error.setAttribute('role', 'alert');
      input.setAttribute('aria-invalid', 'true');
      input.setAttribute('aria-describedby', 'privacy-sender-error');
      add(field, error);
    }
    add(page, field);
    add(page, add(el('div', 'actions'), kit.button(W.senderAdd, 'privacy:sender:add', submitSender, 'main')));
  }

  function view(): HTMLElement {
    const page = el('main', 'page picker privacy');
    if (!s) return page;
    const top = el('div', 'picker-top');
    const backButton = kit.button(s.screen === 'main' ? W.back : W.backToPrivacy, 'privacy:back', escape, 'plain');
    backButton.className = 'btn back';
    add(page, add(top, backButton));
    if (s.discarding) {
      const confirm = el('div', 'confirm-box');
      confirm.setAttribute('role', 'alert');
      add(confirm, el('p', 'strong', W.discardPrompt), add(el('div', 'actions'),
        kit.button(W.discard, 'privacy:discard:yes', () => leave('', false), 'danger'),
        kit.button(W.keep, 'privacy:discard:no', () => {
          s.discarding = false;
          kit.render('privacy:back');
        }, 'plain')));
      add(page, confirm);
    }
    if (s.screen === 'sources') sourcesView(page);
    else if (s.screen === 'labels') labelsView(page);
    else if (s.screen === 'sender') senderView(page);
    else mainView(page);
    return page;
  }

  function backOut(): void {
    if (!s) return;
    if (s.edited && !s.saving) {
      s.discarding = true;
      kit.render('privacy:discard:no');
      return;
    }
    leave('', false);
  }

  /** Back and Escape: the discard prompt, then a sub-screen, then leave. */
  function escape(): void {
    if (!s || s.picking) return;
    if (s.discarding) {
      s.discarding = false;
      kit.render('privacy:back');
    } else if (s.screen !== 'main') {
      const from = s.screen;
      s.screen = 'main';
      kit.render(from === 'sources' ? 'privacy:add:folder' : from === 'labels' ? 'privacy:add:label' : 'privacy:add:sender');
    } else backOut();
  }

  if (typeof document !== 'undefined') {
    document.addEventListener('keydown', (event: KeyboardEvent) => {
      if (!s || s.picking || event.key !== 'Escape' || event.defaultPrevented) return;
      event.preventDefault();
      escape();
    });
  }

  return {
    handles,
    start,
    active: () => !!s,
    view,
  };
}
