/**
 * Settings › Back up and restore (#1065, mockup 6-backup): the last backup
 * with Back up now, where backups go, when they run, the passphrase, and
 * Restore from a backup. Its controls work only in the unlocked dashboard on
 * this computer (backup-routes.ts); elsewhere the section explains and shows
 * no folder. Link target: `?settings#backup` (Home's setup card, "Restore
 * from a backup").
 */
import { escapeHtml } from './components.ts';
import type { BackupStatus } from '../backup-service.ts';

export const DASHBOARD_SETTINGS_BACKUP_ID = 'backup';

export const BACKUP_COPY = {
  title: 'Back up and restore',
  intro: 'A backup holds everything Olympus can\'t fetch again: captured WhatsApp and Telegram messages, your privacy rules and decisions, and every privacy judgment. Sign-ins aren\'t included.',
  lastBackup: 'Last backup',
  none: 'none yet',
  backUpNow: 'Back up now',
  backingUp: 'Backing up…',
  where: 'Where',
  noFolder: 'No folder chosen yet. Choose one on another disk, so a backup outlives this computer.',
  chooseFolder: 'Choose folder',
  when: 'When',
  manual: 'Only when I press Back up now',
  nightly: 'Every night',
  weekly: 'Every week',
  keep: 'Olympus keeps the 7 newest backups in this folder and deletes older ones.',
  passphrase: 'Passphrase',
  passphraseLine: 'Your backup holds Private and Secret items. With a passphrase they\'re encrypted; without one, anyone with the files can read them. Olympus can\'t recover a lost passphrase.',
  passphraseKept: 'A key made from it is kept on this computer so nightly backups can run.',
  set: 'Set',
  notSet: 'Not set',
  change: 'Change',
  setOne: 'Set a passphrase',
  restore: 'Restore',
  restoreLine: 'On a new computer, restore before you connect sources. Nothing is judged or indexed again when the models match. Afterwards you sign in to each source once.',
  restoreButton: 'Restore from a backup…',
  locked: 'Open dashboard controls on this computer to back up or restore.',
} as const;

function formatBytes(bytes: number): string {
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)} GB`;
  if (bytes >= 1e6) return `${(bytes / 1e6).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1e3))} KB`;
}

/** "yesterday at 03:10", "today at 03:10", or "3 Nov at 03:10", in this computer's time. */
export function backupWhen(iso: string, now: Date): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return iso;
  const two = (n: number) => String(n).padStart(2, '0');
  const time = `${two(at.getHours())}:${two(at.getMinutes())}`;
  const day = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const days = Math.round((day(now) - day(at)) / 86_400_000);
  if (days === 0) return `today at ${time}`;
  if (days === 1) return `yesterday at ${time}`;
  return `${at.getDate()} ${at.toLocaleString('en-US', { month: 'short' })} at ${time}`;
}

/** Where a folder is, in words: on a drive by its name, or under the home folder. */
export function backupWhere(folder: string): string {
  const drive = /^\/Volumes\/([^/]+)(?:\/(.*))?$/.exec(folder) ?? /^\/(?:run\/)?media\/[^/]+\/([^/]+)(?:\/(.*))?$/.exec(folder);
  if (drive) return drive[2] ? `in ${drive[2]} on the drive "${drive[1]}"` : `on the drive "${drive[1]}"`;
  const home = /^\/(?:Users|home)\/[^/]+\/(.+)$/.exec(folder);
  if (home) return `in ${home[1]} in your home folder`;
  return `in ${folder}`;
}

export function renderBackupSection(input: { status?: BackupStatus; local: boolean; now: Date; csrfToken?: string }): string {
  const C = BACKUP_COPY;
  const head = `<h3 class="sect">${escapeHtml(C.title)}</h3><p class="pnote">${escapeHtml(C.intro)}</p>`;
  const status = input.status;
  if (!input.local || !status || input.csrfToken === undefined) {
    return `<section class="setpane" id="${DASHBOARD_SETTINGS_BACKUP_ID}">${head}<p class="pnote" data-backup-locked>${escapeHtml(C.locked)}</p></section>`;
  }
  const last = status.last
    ? `${escapeHtml(backupWhen(status.last.at, input.now))} · ${escapeHtml(formatBytes(status.last.bytes))}${status.folder ? ` · ${escapeHtml(backupWhere(status.folder))}` : ''}${status.last.encrypted ? '' : ' · not encrypted'}`
    : escapeHtml(C.none);
  const error = status.lastError
    ? `<p class="bkerr" role="alert">The last backup didn't finish (${escapeHtml(backupWhen(status.lastError.at, input.now))}): ${escapeHtml(status.lastError.message)}</p>` : '';
  const off = status.folder ? '' : ' disabled';
  const lastRow = `<div class="bklast"><p><b>${escapeHtml(C.lastBackup)}</b> — <span data-backup-last>${last}</span></p>`
    + `<button class="btn primaryline" type="button" data-backup-run${off || (status.running ? ' disabled' : '')}>${escapeHtml(status.running ? C.backingUp : C.backUpNow)}</button></div>`
    + `${error}<p class="pnote" data-backup-msg role="status" aria-live="polite"></p>`;
  const where = `<h4 class="bkh">${escapeHtml(C.where)}</h4><div class="bkwhere">`
    + (status.folder ? `<span class="bkpath" data-backup-folder>${escapeHtml(status.folder)}</span>` : `<span class="pnote" data-backup-folder>${escapeHtml(C.noFolder)}</span>`)
    + `<button class="btn primaryline" type="button" data-backup-browse="folder">${escapeHtml(C.chooseFolder)}</button></div>`;
  const radio = (value: string, label: string) => `<label class="bkradio"><input type="radio" name="schedule" value="${value}"${status.schedule === value ? ' checked' : ''}${off}> ${escapeHtml(label)}</label>`;
  const when = `<fieldset class="bkwhen" data-backup-schedule><legend class="bkh">${escapeHtml(C.when)}</legend>${radio('manual', C.manual)}${radio('nightly', C.nightly)}${radio('weekly', C.weekly)}<p class="pnote">${escapeHtml(C.keep)}</p></fieldset>`;
  const passphrase = `<h4 class="bkh">${escapeHtml(C.passphrase)}</h4><p>${escapeHtml(C.passphraseLine)}</p>`
    + `<p>${status.passphraseProblem ? '' : status.passphraseSet ? `✓ ${escapeHtml(C.set)} · ` : `${escapeHtml(C.notSet)} · `}<button class="linkbtn" type="button" data-dialog-open="backup-passphrase">${escapeHtml(status.passphraseProblem ? 'Set the passphrase again' : status.passphraseSet ? C.change : C.setOne)}</button></p>`
    + (status.passphraseProblem
      ? '<p class="bkerr" role="alert" data-backup-key-problem>The key kept for your passphrase can\'t be read, so backups stop until you set the passphrase again.</p>'
      : status.passphraseSet ? `<p class="pnote">${escapeHtml(C.passphraseKept)}</p>` : '');
  const restoreState = status.restore;
  const restoreNote = restoreState?.state === 'done'
    ? `<p class="bkok" role="status" data-backup-restored>Restored ${escapeHtml(backupWhen(restoreState.at, input.now))}.${restoreState.sign_in_again?.length ? ` Sign in again to: ${escapeHtml(restoreState.sign_in_again.join(', '))}.` : ''} <a href="/dashboard?connect">Open Sources</a></p>`
    : restoreState?.state === 'failed'
      ? `<p class="bkerr" role="alert">The restore didn't finish: ${escapeHtml(restoreState.message ?? '')}</p>`
      : restoreState?.state === 'restarting' ? '<p role="status">Olympus is restarting to restore…</p>' : '';
  const restore = `<h4 class="bkh">${escapeHtml(C.restore)}</h4><p>${escapeHtml(C.restoreLine)}</p>${restoreNote}`
    + (status.restoreAvailable
      ? `<button class="btn primaryline" type="button" data-backup-browse="restore">${escapeHtml(C.restoreButton)}</button>`
      : '<p class="pnote">On this install Olympus can\'t restart itself. Stop Olympus, then run <code>olympus data restore --input &lt;file&gt; --passphrase-stdin</code>.</p>');
  const dialogs = `<dialog class="adddialog" id="backup-passphrase" data-closable aria-labelledby="backup-passphrase-title"><div class="adddialoghead"><h3 id="backup-passphrase-title">${escapeHtml(status.passphraseSet ? 'Change the passphrase' : C.setOne)}</h3><button class="btn iconbtn" type="button" data-dialog-close aria-label="Close">✕</button></div>`
    + `<form data-backup-passphrase><p class="pnote">${escapeHtml(C.passphraseLine)}</p><label class="bkfield">New passphrase <input type="password" name="passphrase" autocomplete="new-password" minlength="8" required></label><label class="bkfield">Type it again <input type="password" name="again" autocomplete="new-password" minlength="8" required></label>`
    + `<p class="pnote">${escapeHtml(C.passphraseKept)} Backups made before keep their old passphrase.</p><div class="pickbar"><button class="btn primary" type="submit">Save passphrase</button>${status.passphraseSet ? '<button class="btn" type="button" data-backup-nopass>Back up without a passphrase</button>' : ''}</div><p class="pnote" data-backup-dialog-msg role="status"></p></form></dialog>`
    + `<dialog class="adddialog bkbrowser" id="backup-browser" data-closable aria-labelledby="backup-browser-title"><div class="adddialoghead"><h3 id="backup-browser-title">Choose a folder</h3><button class="btn iconbtn" type="button" data-dialog-close aria-label="Close">✕</button></div>`
    + '<p class="bkpath" data-browser-path></p><div class="bklist" data-browser-files></div><div class="bklist" data-browser-folders></div>'
    + '<form data-backup-restore hidden><label class="bkfield">Passphrase <input type="password" name="passphrase" autocomplete="off"></label><p class="pnote">Restoring stops Olympus, puts the backup in place and starts Olympus again. It only works on a computer that holds no Olympus data yet.</p></form>'
    + '<div class="pickbar"><button class="btn" type="button" data-browser-up>Up</button><button class="btn primary" type="button" data-browser-use>Use this folder</button></div><p class="pnote" data-backup-dialog-msg role="status"></p></dialog>';
  return `<section class="setpane" id="${DASHBOARD_SETTINGS_BACKUP_ID}" data-backup-section>${head}${lastRow}${where}${when}${passphrase}${restore}${dialogs}`
    + `<script>${backupClientScript(input.csrfToken, status.folder ?? null)}</script></section>`;
}

export const BACKUP_SECTION_CSS = `
#backup .adddialog { max-width: 560px; width: calc(100% - 32px); border: 1px solid var(--line); border-radius: 12px; background: var(--bg); color: var(--t1); padding: 18px 20px; }
#backup .adddialog::backdrop { background: rgba(0, 0, 0, 0.55); }
#backup .adddialoghead { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
#backup .adddialoghead h3 { margin: 0; }
#backup .iconbtn { min-width: 36px; padding: 4px 8px; }
.bklast { display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; background: var(--panel2); border: 1px solid var(--line); border-radius: 10px; padding: 14px 18px; margin: 12px 0 4px; }
.bklast p { margin: 0; min-width: 0; overflow-wrap: anywhere; }
.bkh { font-size: var(--fs-row); font-weight: 600; margin: 18px 0 8px; padding: 0; }
.bkwhere { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.bkpath { overflow-wrap: anywhere; min-width: 0; }
.bkwhen { border: 0; padding: 0; margin: 18px 0 0; min-width: 0; }
.bkwhen > legend { margin: 0 0 8px; }
.bkradio { display: block; margin: 6px 0; }
.bkfield { display: grid; gap: 4px; margin: 10px 0; }
.bkfield input { font: inherit; padding: 8px 10px; border: 1px solid var(--line); border-radius: 8px; background: var(--bg); color: var(--t1); }
.bkerr { color: var(--bad); }
.bkok { color: var(--good); }
.btn.primaryline { border-color: var(--link); color: var(--link); }
.linkbtn { background: none; border: 0; padding: 0; color: var(--link); text-decoration: underline; font: inherit; cursor: pointer; }
.bklist { display: grid; gap: 6px; margin: 8px 0; max-height: 50vh; overflow-y: auto; }
.bklist button { text-align: left; }
.bklist .bkpick[aria-pressed="true"] { border-color: var(--link); outline: 2px solid var(--link); outline-offset: 1px; }
`;

/** The section's own small script: posts to the backup routes with the session's CSRF token. */
function backupClientScript(csrfToken: string, folder: string | null): string {
  const config = JSON.stringify({ csrf: csrfToken, folder }).replace(/</g, '\\u003c');
  return `(function () {
  if (window.__olympusBackup) return; window.__olympusBackup = true;
  var config = ${config};
  function $(sel, scope) { return (scope || document).querySelector(sel); }
  function say(sel, text, bad) { var el = $(sel); if (el) { el.textContent = text || ''; if (bad) el.setAttribute('data-state', 'error'); else el.removeAttribute('data-state'); } }
  async function post(path, body) {
    var response;
    try {
      response = await fetch('/dashboard/backup/' + path, { method: 'POST', credentials: 'same-origin', cache: 'no-store', headers: { 'X-Olympus-CSRF': config.csrf, 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
    } catch (error) { return { ok: false, offline: true, error: { message: 'Olympus is not answering right now.' } }; }
    var result = {};
    try { result = await response.json(); } catch (error) { result = {}; }
    if (!response.ok && !result.error) result.error = { message: 'That did not work. Try again.' };
    return result;
  }
  function reload() { window.location.reload(); }
  function sleep(ms) { return new Promise(function (resolve) { setTimeout(resolve, ms); }); }
  async function waitForBackup() {
    for (var i = 0; i < 2400; i += 1) {
      await sleep(1500);
      var status = await post('status');
      if (status.ok && !status.running) { reload(); return; }
    }
  }
  // The folder browser: folder mode picks where backups go; restore mode picks a backup file.
  var browser = { mode: 'folder', stack: [], picked: null };
  function el(tag, cls, text) { var node = document.createElement(tag); if (cls) node.className = cls; if (text !== undefined) node.textContent = text; return node; }
  function size(bytes) { return bytes >= 1e9 ? (bytes / 1e9).toFixed(1) + ' GB' : bytes >= 1e6 ? (bytes / 1e6).toFixed(1) + ' MB' : Math.max(1, Math.round(bytes / 1e3)) + ' KB'; }
  async function show(key) {
    var dialog = $('#backup-browser');
    var folders = $('[data-browser-folders]', dialog); var files = $('[data-browser-files]', dialog);
    say('#backup-browser [data-backup-dialog-msg]', 'Reading…');
    var result = await post('browse', key ? { parent_key: key, files: browser.mode === 'restore' } : {});
    folders.replaceChildren(); files.replaceChildren();
    if (!result.ok) { say('#backup-browser [data-backup-dialog-msg]', result.error && result.error.message, true); return; }
    say('#backup-browser [data-backup-dialog-msg]', result.note || '');
    $('[data-browser-path]', dialog).textContent = result.path || 'Your home folder and connected disks';
    $('[data-browser-up]', dialog).disabled = browser.stack.length === 0;
    $('[data-browser-use]', dialog).hidden = browser.mode !== 'folder';
    $('[data-browser-use]', dialog).disabled = !key;
    (result.files || []).forEach(function (file) {
      var button = el('button', 'btn bkpick', file.name + ' · ' + size(file.bytes) + (file.encrypted ? '' : ' · not encrypted'));
      button.type = 'button'; button.setAttribute('aria-pressed', 'false');
      button.addEventListener('click', function () {
        Array.prototype.forEach.call(files.querySelectorAll('.bkpick'), function (b) { b.setAttribute('aria-pressed', 'false'); });
        button.setAttribute('aria-pressed', 'true');
        browser.picked = file;
        var form = $('[data-backup-restore]', dialog); form.hidden = false;
        var pass = form.querySelector('input[name="passphrase"]'); pass.disabled = !file.encrypted; pass.required = !!file.encrypted;
        $('[data-browser-use]', dialog).hidden = false; $('[data-browser-use]', dialog).disabled = false;
        $('[data-browser-use]', dialog).textContent = 'Restore';
      });
      files.append(button);
    });
    (result.folders || []).forEach(function (folder) {
      var button = el('button', 'btn', '📁 ' + folder.name + (folder.note ? ' — ' + folder.note : ''));
      button.type = 'button'; button.disabled = !folder.selectable;
      button.addEventListener('click', function () { browser.stack.push(key || ''); browser.current = folder.key; show(folder.key); });
      folders.append(button);
    });
  }
  function openBrowser(mode) {
    var dialog = $('#backup-browser');
    browser = { mode: mode, stack: [], picked: null, current: '' };
    $('#backup-browser-title').textContent = mode === 'folder' ? 'Choose a folder for backups' : 'Choose a backup to restore';
    var form = $('[data-backup-restore]', dialog); form.hidden = true; form.reset();
    $('[data-browser-use]', dialog).textContent = 'Use this folder';
    if (!dialog.open) dialog.showModal();
    show('');
  }
  document.addEventListener('click', async function (event) {
    var target = event.target instanceof Element ? event.target : null;
    if (!target || !target.closest('[data-backup-section]')) return;
    var opener = target.closest('[data-backup-browse]');
    if (opener) { openBrowser(opener.getAttribute('data-backup-browse')); return; }
    if (target.closest('[data-browser-up]')) { var up = browser.stack.pop() || ''; browser.current = up; show(up); return; }
    if (target.closest('[data-browser-use]')) {
      var use = target.closest('[data-browser-use]'); use.disabled = true;
      if (browser.mode === 'folder') {
        var saved = await post('settings', { folder_key: browser.current });
        if (saved.ok) { reload(); return; }
        say('#backup-browser [data-backup-dialog-msg]', saved.error && saved.error.message, true); use.disabled = false; return;
      }
      if (!browser.picked) { use.disabled = false; return; }
      var pass = $('#backup-browser [data-backup-restore] input[name="passphrase"]').value;
      if (browser.picked.encrypted && !pass) { say('#backup-browser [data-backup-dialog-msg]', 'Enter the passphrase this backup was made with.', true); use.disabled = false; return; }
      say('#backup-browser [data-backup-dialog-msg]', 'Opening the backup and checking it… This can take a few minutes for a large backup.');
      var started = await post('restore', { file_key: browser.picked.key, passphrase: pass });
      if (!started.ok) { say('#backup-browser [data-backup-dialog-msg]', started.error && started.error.message, true); use.disabled = false; return; }
      say('#backup-browser [data-backup-dialog-msg]', 'Olympus is restarting to restore your backup…');
      // Olympus stops, restores and starts again: wait for it to answer with the result.
      for (var i = 0; i < 600; i += 1) {
        await sleep(2000);
        var status = await post('status');
        if (status.ok && status.restore && status.restore.state !== 'restarting') { reload(); return; }
        if (status.offline) say('#backup-browser [data-backup-dialog-msg]', 'Olympus is restarting to restore your backup…');
      }
      return;
    }
    if (target.closest('[data-backup-run]')) {
      var run = target.closest('[data-backup-run]'); run.disabled = true; run.textContent = 'Backing up…';
      var result = await post('run');
      if (!result.ok) { say('[data-backup-msg]', result.error && result.error.message, true); run.disabled = false; run.textContent = 'Back up now'; return; }
      say('[data-backup-msg]', 'Backing up. You can leave this page; the backup goes on.');
      waitForBackup();
      return;
    }
    if (target.closest('[data-backup-nopass]')) {
      var cleared = await post('passphrase', { passphrase: null });
      if (cleared.ok) { reload(); return; }
      say('#backup-passphrase [data-backup-dialog-msg]', cleared.error && cleared.error.message, true);
    }
  });
  document.addEventListener('change', async function (event) {
    var input = event.target instanceof HTMLInputElement ? event.target : null;
    if (!input || input.name !== 'schedule' || !input.closest('[data-backup-schedule]')) return;
    var saved = await post('settings', { schedule: input.value });
    say('[data-backup-msg]', saved.ok ? 'Saved.' : (saved.error && saved.error.message), !saved.ok);
  });
  document.addEventListener('submit', async function (event) {
    var form = event.target instanceof HTMLFormElement ? event.target : null;
    if (!form || !form.matches('[data-backup-passphrase]')) return;
    event.preventDefault();
    var pass = form.elements.passphrase.value, again = form.elements.again.value;
    if (pass !== again) { say('#backup-passphrase [data-backup-dialog-msg]', 'The two passphrases are different.', true); return; }
    say('#backup-passphrase [data-backup-dialog-msg]', 'Saving…');
    var saved = await post('passphrase', { passphrase: pass });
    form.reset();
    if (saved.ok) { reload(); return; }
    say('#backup-passphrase [data-backup-dialog-msg]', saved.error && saved.error.message, true);
  });
})();`;
}
