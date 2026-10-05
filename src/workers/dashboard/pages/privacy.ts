/**
 * Privacy: what is private for the owner, the local twin of the ChatGPT
 * privacy screen (dashboard/chatgpt/privacy.ts), reached from Setup's Privacy
 * row and the Sensitivity page. One authoritative view of the owner's privacy
 * profile (holistic review 2026-10-02, item 11).
 *
 * The owner describes what is private in their own words and may name
 * folders, Gmail labels and senders that are always private. Saving runs the
 * same engine operation as ChatGPT's olympus_privacy_set (the worker's
 * POST /dashboard/privacy), so the two surfaces edit one profile. Rules on
 * Secrets-tier locations never reach this page and are kept as saved.
 *
 * Names: the description and the rules' names are rendered only here, only to
 * a reader holding the controls or the operator's own connection; a reader with
 * the read-only dash_ link gets one sentence pointing at Setup instead.
 * "Public" never appears: the owner's choice is private or not.
 *
 * The page is inert markup; the shared browser controller adds and removes
 * rules in place and saves the whole list (browser-controller.ts, privacy).
 */
import type { PrivacyRuleView, PrivacySettings } from '../../chatgpt/dashboard-contract.ts';
import type { SourceDashboardViewModel } from '../../source-dashboard.ts';
import { mailScopeDraftView } from '../../../core/mail-source-scope.ts';
import {
  DASHBOARD_CONTROL_GATE_ID,
  escapeHtml,
  pageShell,
} from '../components.ts';
import { DASHBOARD_NAV_CSS, renderDashboardNav } from '../nav.ts';
import { DASHBOARD_PRIVACY_CSS, DASHBOARD_SOURCE_ROWS_CSS } from '../static-styles.ts';
import { DASHBOARD_LOCAL_PRIVACY_COPY as W, dashboardCheckedLabel, dashboardIsConnectedSource } from '../vocabulary.ts';
import { dashboardControlsAvailable, fill, setupHref } from '../source-rows.ts';
import { PRIVACY_FOLDER_SOURCE_NAMES, privacyLogic } from '../shared-privacy-logic.ts';
import type { DashboardPageOptions } from './home.ts';

/** Folder sources a private folder can come from, with their names. */
const FOLDER_SOURCES = PRIVACY_FOLDER_SOURCE_NAMES;
const MAIL_SOURCE_ID = 'gmail.email';

export function renderDashboardPrivacyPage(
  view: SourceDashboardViewModel,
  options?: DashboardPageOptions,
): string {
  const now = options?.now ?? new Date();
  return pageShell({
    title: 'Olympus',
    crumb: W.crumb,
    ...(options?.basePath === undefined ? {} : { basePath: options.basePath }),
    meta: dashboardCheckedLabel(view.generated_at, now),
    body: [
      renderDashboardNav('setup', { ...(options?.basePath === undefined ? {} : { basePath: options.basePath }) }),
      renderPrivacyBody(view, options),
    ].join('\n'),
    styles: [DASHBOARD_NAV_CSS, DASHBOARD_SOURCE_ROWS_CSS, DASHBOARD_PRIVACY_CSS],
    controller: { ...(options?.controlSessionCsrfToken === undefined ? {} : { csrfToken: options.controlSessionCsrfToken }) },
    poll: {
      unlocked: options?.controlSessionCsrfToken !== undefined,
      ...(options?.controlSessionCsrfToken === undefined ? {} : { controlSessionCsrfToken: options.controlSessionCsrfToken }),
    },
    ...(options?.format === undefined ? {} : { format: options.format }),
  });
}

function renderPrivacyBody(view: SourceDashboardViewModel, options: DashboardPageOptions | undefined): string {
  const head = `<h2 class="ptitle">${escapeHtml(W.title)}</h2><p class="pintro">${escapeHtml(W.intro)}</p>`;
  // The owner's words and the rules' names are shown only to a reader who
  // can change them: the control session, or a native connection with
  // operator.write. Anyone else (the dash_ link, a read-only OpenClaw
  // connection) gets the counts and where to unlock (Codex review,
  // 2026-10-02: write authority before any privacy content, on every surface).
  if (!dashboardControlsAvailable(options)) {
    const summary = options?.privacy !== undefined && options.privacy !== 'unreadable' ? options.privacy : undefined;
    const counts = summary
      ? `<p class="pnote" data-privacy-counts>${escapeHtml(summary.configured
        ? fill(summary.ruleCount === 1 ? W.countsOne : W.counts, { n: summary.ruleCount.toLocaleString('en-US') })
        : W.countsUnset)}</p>`
      : '';
    const unlock = options?.controlMode === 'native'
      ? `<p class="pnote">${escapeHtml(W.readOnly)}</p>`
      : `<p class="pnote">${escapeHtml(W.locked)} <a href="${escapeHtml(`${setupHref(options?.basePath)}#${DASHBOARD_CONTROL_GATE_ID}`)}">Setup →</a></p>`;
    return `<div class="privacy" data-privacy-locked>${head}${counts}${unlock}</div>`;
  }
  const settings = options?.privacySettings;
  if (!settings) {
    const sentence = options?.privacy === 'unreadable' ? W.loadFailed : W.unavailable;
    return `<div class="privacy">${head}<p class="pnote">${escapeHtml(sentence)}</p></div>`;
  }
  const canEdit = dashboardControlsAvailable(options);
  const folderSources = Object.keys(FOLDER_SOURCES).filter((id) => connected(view, id));
  const gmail = connected(view, MAIL_SOURCE_ID);
  const disabled = canEdit ? '' : ' disabled aria-disabled="true"';
  const shown = settings.rules.filter((rule) => LOGIC.validRule(rule));
  const rules = shown.map((rule) => privacyRuleRow(rule, canEdit)).join('');
  const pending = Math.max(0, Math.floor(settings.pendingCount));
  const pendingLine = pending > 0
    ? fill(pending === 1 ? W.pending.one : W.pending.many, { n: pending.toLocaleString('en-US') })
    : W.nothingPending;
  const note = canEdit
    ? ''
    : `<p class="pnote">${escapeHtml(options?.controlMode === 'native' ? W.readOnly : W.locked)}</p>`;
  const folderButton = folderSources.length > 0
    ? `<button type="button" class="btn" data-privacy-add="folder"${disabled}>${escapeHtml(W.addFolder)}</button>`
    : `<span class="blocked"><button type="button" class="btn" disabled aria-disabled="true">${escapeHtml(W.addFolder)}</button><span class="hint">${escapeHtml(W.needFolderSource)}</span></span>`;
  const labelButton = gmail
    ? `<button type="button" class="btn" data-privacy-add="label"${disabled}>${escapeHtml(W.addLabel)}</button>`
    : `<span class="blocked"><button type="button" class="btn" disabled aria-disabled="true">${escapeHtml(W.addLabel)}</button><span class="hint">${escapeHtml(W.needGmail)}</span></span>`;
  return `<div class="privacy" data-privacy-editor>${head}${note}`
    + `<form class="pform" data-privacy-form`
    + ` data-folder-sources="${escapeHtml(JSON.stringify(folderSources.map((id) => ({ id, label: FOLDER_SOURCES[id] }))))}"`
    + ` data-mail-draft="${escapeHtml(JSON.stringify(mailScopeDraftView(undefined)))}"`
    + ` data-copy="${escapeHtml(JSON.stringify(CLIENT_COPY))}"`
    // What the engine holds now, so a save can tell what it would remove and
    // send back the revision it was edited against (compare-and-swap).
    + ` data-revision="${escapeHtml(settings.revision ?? '')}"`
    + ` data-saved-description="${escapeHtml(settings.description)}"`
    + ` data-source-names="${escapeHtml(JSON.stringify(FOLDER_SOURCES))}"`
    // The follow-up questions' words, so the controller can ask them again as the description changes.
    + ` data-questions="${escapeHtml(JSON.stringify(W.questions))}"`
    // Saved rules the page cannot show (not in the engine's shape): sent back unchanged.
    + ` data-hidden="${escapeHtml(JSON.stringify(settings.rules.filter((rule) => !LOGIC.validRule(rule))))}">`
    + `<label class="plabel" for="privacy-description">${escapeHtml(W.descriptionLabel)}</label>`
    + `<textarea class="ptext" id="privacy-description" name="description" maxlength="2000" rows="5"`
    + ` placeholder="${escapeHtml(W.descriptionPlaceholder)}"${canEdit ? '' : ' readonly'}>${escapeHtml(settings.description)}</textarea>`
    + privacyQuestions(settings.description, canEdit)
    + `<div class="sect">${escapeHtml(W.rulesTitle)}</div>`
    + `<div class="srows" data-privacy-rules>${rules}</div>`
    + `<p class="foot pempty" data-privacy-empty${shown.length > 0 ? ' hidden' : ''}>${escapeHtml(W.rulesEmpty)}</p>`
    + `<div class="padd">${folderButton}${labelButton}`
    + `<button type="button" class="btn" data-privacy-add="sender"${disabled}>${escapeHtml(W.addSender)}</button></div>`
    + senderPanel()
    + `<div class="ppanel" data-privacy-panel="label" hidden><p class="pnote">${escapeHtml(W.labelIntro)}</p>`
    + `<div class="srows" data-privacy-list></div><p class="actmsg" data-privacy-panel-message role="status"></p>`
    + `<button type="button" class="btn" data-privacy-panel-close>${escapeHtml(W.close)}</button></div>`
    + `<div class="ppanel" data-privacy-panel="folder" hidden><p class="pnote">${escapeHtml(W.folderIntro)}</p>`
    + `<div class="psources" data-privacy-folder-sources></div><p class="ppath" data-privacy-folder-path></p>`
    + `<div class="srows" data-privacy-list></div><p class="actmsg" data-privacy-panel-message role="status"></p>`
    + `<button type="button" class="btn" data-privacy-panel-close>${escapeHtml(W.close)}</button></div>`
    + `<div class="pfooter"><p>${escapeHtml(pendingLine)}</p>`
    + `<div class="pbuttons"><button type="submit" class="btn primary"${disabled}>${escapeHtml(W.save)}</button>`
    + `<a class="btn" href="${escapeHtml(setupHref(options?.basePath))}" data-privacy-cancel>${escapeHtml(W.cancel)}</a></div>`
    + `<span class="actmsg" data-action-message role="status"></span></div>`
    + `</form></div>`;
}

/**
 * The follow-up questions for the broad areas the saved description names
 * (shared-privacy-logic.ts questions): per choice, a radio pair, Private or
 * Fine to share, at its default or the answer the description already
 * carries. The controller asks them again as the description changes and
 * writes each answer into the description (browser-controller.ts); this is
 * the same markup it builds.
 */
function privacyQuestions(description: string, canEdit: boolean): string {
  const Q = W.questions;
  const asked = LOGIC.questions(description);
  const disabled = canEdit ? '' : ' disabled aria-disabled="true"';
  if (asked.length === 0) return `<div class="pquestions" data-privacy-questions="" hidden></div>`;
  const topics = asked.map((topic) => {
    const options = topic.options.map((option) => {
      const id = `privacy-q-${topic.id}-${option.id}`;
      const choices = (['private', 'share'] as const).map((side) => `<label class="pqchoice"><input type="radio" name="${id}" value="${side}"`
        + ` data-privacy-topic="${escapeHtml(topic.id)}" data-privacy-option="${escapeHtml(option.id)}"`
        + `${option.side === side ? ' checked' : ''}${disabled}><span>${escapeHtml(side === 'private' ? Q.private : Q.share)}</span></label>`).join('');
      return `<div class="pqopt" role="radiogroup" aria-labelledby="${id}"><span class="pqlabel" id="${id}">${escapeHtml(option.label)}</span>`
        + `<span class="pqchoices">${choices}</span></div>`;
    }).join('');
    return `<div class="pqtopic"><h3 class="pqtitle">${escapeHtml(topic.question)}</h3>${options}</div>`;
  }).join('');
  return `<div class="pquestions" data-privacy-questions="${escapeHtml(asked.map((topic) => topic.id).join(','))}">`
    + `<div class="sect">${escapeHtml(Q.title)}</div><p class="pnote">${escapeHtml(Q.intro)}</p>${topics}</div>`;
}

function senderPanel(): string {
  return `<div class="ppanel" data-privacy-panel="sender" hidden><p class="pnote">${escapeHtml(W.senderIntro)}</p>`
    + `<label class="plabel" for="privacy-sender">${escapeHtml(W.senderLabel)}</label>`
    + `<div class="prow"><input class="keyfield ptextline" id="privacy-sender" type="text" autocomplete="off"`
    + ` placeholder="${escapeHtml(W.senderPlaceholder)}" data-privacy-sender>`
    + `<button type="button" class="btn" data-privacy-sender-add>${escapeHtml(W.senderAdd)}</button>`
    + `<button type="button" class="btn" data-privacy-panel-close>${escapeHtml(W.close)}</button></div>`
    + `<p class="actmsg" data-privacy-panel-message role="status"></p></div>`;
}

/** True when the source is connected and signed in, so its folders or labels can be listed. */
function connected(view: SourceDashboardViewModel, sourceId: string): boolean {
  const source = view.sources.find((card) => card.source_id === sourceId);
  return source !== undefined && dashboardIsConnectedSource(source)
    && source.connection.state !== 'awaiting_consent' && source.connection.state !== 'reauth_required';
}

/** The rules this editor shares with ChatGPT's privacy panel. */
const LOGIC = privacyLogic({ mailSourceId: MAIL_SOURCE_ID, folderSources: { ...PRIVACY_FOLDER_SOURCE_NAMES }, topicWords: W.questions });

/** A rule's name and what kind of place it is, in the ChatGPT panel's words (shared-privacy-logic.ts). */
export function privacyRuleWords(rule: PrivacyRuleView): { name: string; kind: string } {
  const source = FOLDER_SOURCES[rule.source_id] ?? rule.source_id;
  const kind = rule.kind === 'sender' ? W.kindSender : rule.kind === 'label' ? W.kindLabel : fill(W.kindFolder, { source });
  return { name: LOGIC.displayOf(rule, fill(W.folderUnnamed, { source })), kind };
}

/** One always-private rule as a row; the rule itself rides along for the save. */
function privacyRuleRow(rule: PrivacyRuleView, canEdit: boolean): string {
  const words = privacyRuleWords(rule);
  const data = JSON.stringify(rule);
  return `<div class="srow nodot prule" data-privacy-rule="${escapeHtml(data)}" data-privacy-saved>`
    + `<div class="smain"><p class="sline strong">${escapeHtml(words.name)}</p><p class="sline">${escapeHtml(words.kind)}</p></div>`
    + `<div class="sact"><button type="button" class="btn" data-privacy-remove`
    + ` aria-label="${escapeHtml(fill(W.removeFor, { name: words.name }))}"${canEdit ? '' : ' disabled aria-disabled="true"'}>${escapeHtml(W.remove)}</button></div>`
    + `</div>`;
}

/**
 * The words the browser controller prints while it edits the list (it is
 * serialized into the standalone page, so it carries no vocabulary of its own).
 */
const CLIENT_COPY = {
  remove: W.remove,
  removeFor: W.removeFor,
  undo: W.undo,
  removed: W.removed,
  kindFolder: W.kindFolder,
  kindLabel: W.kindLabel,
  kindSender: W.kindSender,
  makePrivate: W.makePrivate,
  alreadyPrivate: W.alreadyPrivate,
  folderUp: W.folderUp,
  folderOpen: W.folderOpen,
  folderEmpty: W.folderEmpty,
  folderMore: W.folderMore,
  noLabels: W.noLabels,
  loading: W.loading,
  loadFailed: W.loadFailed,
  senderInvalid: W.senderInvalid,
  senderDuplicate: W.senderDuplicate,
  saving: W.saving,
  saved: W.saved,
  saveFailed: W.saveFailed,
  unchanged: W.unchanged,
  discard: 'Discard your changes?',
  confirmRemoves: W.confirmRemoves,
  confirmDescription: W.confirmDescription,
  confirm: W.confirm,
  conflict: W.conflict,
  conflictNow: W.conflictNow,
  conflictDescription: W.conflictDescription,
  conflictNoDescription: W.conflictNoDescription,
  applyAgain: W.applyAgain,
  discardMine: W.discardMine,
  folderUnnamed: W.folderUnnamed,
  undoFor: W.undoFor,
  rulesEmpty: W.rulesEmpty,
} as const;

export type DashboardPrivacyClientCopy = typeof CLIENT_COPY;
