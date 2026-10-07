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
import type { privacyLogic } from '../shared-privacy-logic.ts';

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

/**
 * `makeLogic` is shared-privacy-logic.ts privacyLogic: the rules this panel
 * shares with the local Privacy editor. The page inlines it beside this
 * program (page.ts), since neither may import at run time.
 */
export function chatgptPrivacyProgram(kit: ChatGptPrivacyKit, makeLogic: typeof privacyLogic): ChatGptPrivacy {
  const T = kit.config.tools;
  const W = kit.config.copy;
  const el = kit.el;
  const add = kit.add;
  const fill = kit.fill;
  const L = makeLogic({ mailSourceId: kit.config.mailSourceId, folderSources: kit.config.folderSources, topicWords: W.questions });

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
      // The saved settings this view started from: the compare-and-swap revision,
      // the saved description, and the owner's confirmation for a save that lowers protection.
      revision: '', savedDescription: '', confirmation: '', confirmedAt: 0, confirmStep: false,
      // Loaded rules the page cannot show (an unexpected shape): never shown, always saved back as they came.
      hidden: [],
      // Settings changed elsewhere while this draft was open: the current saved ones, until the person picks.
      server: null,
      edited: false, saving: false, saveError: '', discarding: false, picking: false,
      labels: [], labelsLoading: false, labelsError: '',
      sender: '', senderError: '',
      questionsError: '',
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

  /** One rule exactly as the engine serializes it (shared-privacy-logic.ts). */
  function validRule(rule: Any): boolean {
    return L.validRule(rule);
  }

  /** What the page prints for a rule: the sender, the label's name, the folder's name or "A folder in Dropbox". */
  function displayOf(rule: Any): string {
    return L.displayOf(rule, fill(W.folderUnnamed, { source: sourceLabel(rule.source_id) }));
  }

  /** A loaded rule for the view: `raw` is what the engine sent, saved back unchanged unless removed. */
  function viewRule(rule: Any): Any {
    return L.viewRule(rule, displayOf(rule));
  }

  /**
   * The saved settings, replacing whatever the view held. A result without a
   * confirmation (a save or a conflict) keeps the one already held: it is
   * spent only by the save that uses it.
   */
  function take(data: Any): void {
    s.description = typeof data.description === 'string' ? data.description : '';
    s.savedDescription = s.description;
    s.revision = typeof data.revision === 'string' ? data.revision : '';
    s.edited = false;
    s.confirmStep = false;
    // `saved`: removing it lowers protection, so the save needs the owner's confirmation.
    s.rules = data.rules.filter(validRule).map(viewRule);
    s.hidden = data.rules.filter((rule: Any) => !validRule(rule));
    s.server = null;
    s.pendingCount = typeof data.pendingCount === 'number' && isFinite(data.pendingCount) ? Math.max(0, data.pendingCount) : 0;
    if (typeof data.confirmation === 'string' && data.confirmation) {
      s.confirmation = data.confirmation;
      s.confirmedAt = Date.now();
    }
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

  /** A rule's identity as the engine matches it: a folder or label by key, a sender by trimmed lower-cased address. */
  function identity(rule: Any): string {
    return L.identity(rule);
  }

  function kept(): Any[] {
    return s.rules.filter((rule: Any) => !rule.removed);
  }

  /** Exactly what the save sends for a rule (shared-privacy-logic.ts). */
  function ruleOut(rule: Any): ChatGptPrivacyRuleOut {
    return L.ruleOut(rule) as unknown as ChatGptPrivacyRuleOut;
  }

  /** The whole rule list a save sends: every kept rule, and every loaded rule the page cannot show. */
  function rulesOut(): Any[] {
    return kept().map(ruleOut).concat(s.hidden);
  }

  /** Any change to the draft closes an open confirmation step: what it named may no longer be true. */
  function changed(): void {
    s.edited = true;
    s.confirmStep = false;
  }

  function addRule(rule: Any): void {
    L.addTo(s.rules, rule);
    changed();
    s.saveError = '';
  }

  /** Saved rules this save would drop, and whether it changes the saved description: both lower protection. */
  function lowering(): { removed: Any[]; described: boolean } {
    return L.lowering(s.rules, s.description, s.savedDescription);
  }
  function lowers(): boolean {
    return L.lowers(s.rules, s.description, s.savedDescription);
  }

  /** Save: a save that lowers protection first asks inline, then carries the owner's confirmation. */
  function save(): void {
    if (!s || !s.loaded || s.saving || s.server) return;
    // The questions' choices as shown, defaults included, become their sentences before anything is decided.
    const shown = L.withShownAnswers(s.description);
    if (shown !== s.description) {
      s.description = shown;
      changed();
    }
    if (lowers()) {
      s.confirmStep = true;
      s.saveError = '';
      kit.render('privacy:confirm:yes');
      return;
    }
    send(false, false);
  }

  /** The olympus_privacy_get confirmation lives 30 minutes; one older than this is fetched again first. */
  const CONFIRMATION_FRESH_MS = 25 * 60_000;

  function send(confirmed: boolean, retried: boolean): void {
    if (confirmed && (!s.confirmation || Date.now() - s.confirmedAt > CONFIRMATION_FRESH_MS)) {
      renewConfirmation(() => send(true, true));
      return;
    }
    const args: Any = { description: s.description.trim(), rules: rulesOut() };
    // Always the revision the view was built from: a save over changed settings is refused.
    if (s.revision) args.revision = s.revision;
    // Only a save that lowers protection carries the confirmation, which it spends.
    if (confirmed) args.confirmation = s.confirmation;
    s.saving = true;
    s.saveError = '';
    s.confirmStep = false;
    kit.render('privacy:save');
    const mine = session;
    kit.call(T.set, args).then((result) => {
      if (mine !== session || !s) return;
      s.saving = false;
      const content = result && result.structuredContent && typeof result.structuredContent === 'object' ? result.structuredContent : null;
      if (confirmed && result && result.isError && content && content.error === 'privacy_owner_only' && !retried) {
        // The confirmation expired or was spent elsewhere: fetch a fresh one once.
        s.confirmation = '';
        renewConfirmation(() => send(true, true));
        return;
      }
      const data = settings(result);
      if (data && content && content.status === 'conflict') return conflict(data);
      if (!data || result.isError) {
        s.saveError = W.saveFailed;
        kit.render('privacy:save');
        return;
      }
      if (confirmed) s.confirmation = '';
      kit.remember(data.rules.filter(validRule).length);
      leave(W.saved, true);
    }, () => {
      if (mine !== session || !s) return;
      s.saving = false;
      s.saveError = W.saveFailed;
      kit.render('privacy:save');
    });
  }

  /**
   * The settings changed somewhere else and nothing was saved. The draft
   * stays as it is; the current saved settings are shown beside it until the
   * person applies their changes to them again or discards their changes.
   */
  function conflict(data: Any): void {
    s.server = data;
    s.confirmStep = false;
    s.saveError = '';
    kit.render('privacy:conflict:apply');
  }

  /** The person's changes, re-applied to the current saved settings, then saved (asking first if they lower protection). */
  function applyAgain(): void {
    const server = s.server;
    if (!server) return;
    const draft = { rules: s.rules, description: s.description, savedDescription: s.savedDescription };
    take(server);
    const replayed = L.replay(draft, s.rules);
    s.rules = replayed.rules;
    s.confirmStep = false;
    s.saveError = '';
    if (replayed.description !== null) s.description = replayed.description;
    s.edited = true;
    save();
    if (!s.saving && !s.confirmStep) kit.render('privacy:save');
  }

  function discardMine(): void {
    const server = s.server;
    if (!server) return;
    take(server);
    kit.render('privacy:description');
  }

  /** The conflict box: what happened, what is saved now, and the two ways on. */
  function conflictBox(): HTMLElement {
    const box = el('div', 'confirm-box');
    box.setAttribute('role', 'alert');
    add(box, el('p', 'strong', W.conflict), el('p', '', W.conflictNow));
    const list = el('ul', 'plain');
    const description = typeof s.server.description === 'string' ? s.server.description.trim() : '';
    add(list, el('li', '', description ? fill(W.conflictDescription, { text: description }) : W.conflictNoDescription));
    const rules = s.server.rules.filter(validRule);
    if (!rules.length) add(list, el('li', '', W.rulesEmpty));
    for (const rule of rules) add(list, el('li', '', displayOf(rule) + ' · ' + kindText(rule)));
    add(box, list, add(el('div', 'actions'),
      kit.button(W.applyAgain, 'privacy:conflict:apply', applyAgain, 'main'),
      kit.button(W.discardMine, 'privacy:conflict:discard', discardMine, 'plain')));
    return box;
  }

  /** olympus_privacy_get again for a fresh confirmation; settings changed meanwhile are a conflict. */
  function renewConfirmation(then: () => void): void {
    s.saving = true;
    s.saveError = '';
    s.confirmStep = false;
    kit.render('privacy:save');
    const mine = session;
    kit.call(T.get, {}).then((result) => {
      if (mine !== session || !s) return;
      s.saving = false;
      const data = settings(result);
      if (!data || typeof data.confirmation !== 'string' || !data.confirmation) {
        s.saveError = W.saveFailed;
        kit.render('privacy:save');
        return;
      }
      if (s.revision && typeof data.revision === 'string' && data.revision !== s.revision) return conflict(data);
      s.confirmation = data.confirmation;
      s.confirmedAt = Date.now();
      then();
    }, () => {
      if (mine !== session || !s) return;
      s.saving = false;
      s.saveError = W.saveFailed;
      kit.render('privacy:save');
    });
  }

  /** The inline step before a save that lowers protection: what it removes, Confirm or Cancel. */
  function confirmBox(): HTMLElement {
    const change = lowering();
    const box = el('div', 'confirm-box');
    box.setAttribute('role', 'alert');
    if (change.removed.length) {
      add(box, el('p', 'strong', fill(W.confirmRemove, { list: change.removed.map((rule: Any) => rule.display).join(', ') })));
    }
    if (change.described) add(box, el('p', change.removed.length ? '' : 'strong', W.confirmDescription));
    add(box, add(el('div', 'actions'),
      // Lowering is decided again from the draft as it is now: an additive save never carries the confirmation.
      kit.button(W.confirm, 'privacy:confirm:yes', () => send(lowers(), false), 'danger'),
      kit.button(W.cancel, 'privacy:confirm:no', () => {
        s.confirmStep = false;
        kit.render('privacy:save');
      }, 'plain')));
    return box;
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
    const value = L.senderValue(s.sender);
    if (!value) {
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
        changed();
        kit.render('privacy:rule:' + index);
      }, 'plain');
      undo.setAttribute('aria-label', fill(W.undoFor, { name: rule.display }));
      return add(li, undo);
    }
    add(li, add(el('p', 'fname leaf two-line'), el('span', 'two-top', rule.display), el('span', 'two-bottom', kindText(rule))));
    const remove = kit.button(W.remove, 'privacy:rule:' + index, s.saving ? null : () => {
      rule.removed = true;
      changed();
      s.saveError = '';
      kit.render('privacy:rule:' + index);
    }, 'plain');
    remove.setAttribute('aria-label', fill(W.removeFor, { name: rule.display }));
    return add(li, remove);
  }

  /**
   * The follow-up questions for the broad areas the description names: each
   * choice is a pair of radio buttons, Private or Fine to share, at its
   * default or the answer the description already carries. A change rewrites
   * that area's sentence in the description, so what is saved is visible text
   * (shared-privacy-logic.ts answerTopic), and marks the draft changed.
   */
  function questionsSection(): HTMLElement | null {
    const Q = W.questions;
    const asked = L.questions(s.description);
    if (!asked.length) return null;
    const section = add(el('section', 'fsection questions'), el('h2', '', Q.title), el('p', 'reason', Q.intro));
    for (const topic of asked) {
      const heading = el('h3', 'qtitle', topic.question);
      heading.id = 'privacy-q-' + topic.id;
      const group = add(el('div', 'qtopic'), heading);
      for (const option of topic.options) {
        const id = 'privacy-q-' + topic.id + '-' + option.id;
        const row = el('div', 'qopt');
        row.setAttribute('role', 'radiogroup');
        row.setAttribute('aria-labelledby', heading.id + ' ' + id);
        const name = el('span', 'qlabel', option.label);
        name.id = id;
        const choices = el('span', 'qchoices');
        for (const side of ['private', 'share'] as const) {
          const choice = el('label', 'qchoice');
          const input = el('input') as HTMLInputElement;
          input.type = 'radio';
          input.name = id;
          input.value = side;
          input.checked = option.side === side;
          input.disabled = s.saving;
          input.setAttribute('data-key', 'privacy:q:' + topic.id + ':' + option.id + ':' + side);
          input.addEventListener('change', () => {
            if (!input.checked || !s) return;
            const next = L.answerTopic(s.description, topic.id, option.id, side);
            // Too long to add: nothing changes, the radio redraws as it was, and the owner is told why.
            s.questionsError = next.fits ? '' : Q.tooLong;
            if (next.fits) {
              s.description = next.description;
              changed();
              s.saveError = '';
            }
            kit.render('privacy:q:' + topic.id + ':' + option.id + ':' + side);
          });
          add(choices, add(choice, input, el('span', '', side === 'private' ? Q.private : Q.share)));
        }
        add(group, add(row, name, choices));
      }
      add(section, group);
    }
    if (s.questionsError) {
      const message = el('p', 'reason error', s.questionsError);
      message.setAttribute('role', 'alert');
      add(section, message);
    }
    return section;
  }

  function mainView(page: HTMLElement): void {
    add(page, el('h1', '', W.title));
    add(page, el('p', 'muted intro', W.intro));
    if (s.server) add(page, conflictBox());
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
    area.setAttribute('aria-describedby', 'privacy-description-shared');
    const asked = L.questionsKey(s.description);
    area.addEventListener('input', () => {
      s.description = area.value;
      const open = s.confirmStep;
      changed();
      // Redrawn (caret kept) when the step closes, a too-long note clears, or
      // what the questions show changes (an area, or an answer edited by hand).
      const noted = !!s.questionsError;
      s.questionsError = '';
      if (open || noted || L.questionsKey(s.description) !== asked) kit.render('privacy:description');
    });
    add(page, add(field, area));
    const shared = el('p', 'reason field-note', W.descriptionShared);
    shared.id = 'privacy-description-shared';
    add(page, shared);
    const questions = questionsSection();
    if (questions) add(page, questions);

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
    add(rules, el('p', 'reason', W.namesShared));
    add(page, rules);

    const footer = el('section', 'picker-footer');
    if (s.pendingCount > 0) {
      add(footer, el('p', '', fill(s.pendingCount === 1 ? W.pending.one : W.pending.many, { n: kit.count(s.pendingCount) })));
    }
    // The confirmation step stands in for Save while it is open (and while the change still lowers protection).
    if (s.confirmStep && !s.saving && lowers()) {
      add(page, add(footer, confirmBox()));
      return;
    }
    const row = el('div', 'actions');
    if (s.saving) {
      const busy = kit.button(W.saving, 'privacy:save', null, 'main');
      busy.setAttribute('aria-busy', 'true');
      add(row, busy);
    } else add(row, kit.button(W.save, 'privacy:save', s.server ? null : save, 'main'));
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
