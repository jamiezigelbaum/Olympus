import { describe, expect, test } from 'bun:test';
import { readResult } from '../scripts/control-ui-preview.ts';
import {
  buildDashboardPreviewOptions,
  buildDashboardPreviewView,
  DASHBOARD_PREVIEW_NOW,
} from '../scripts/dashboard-preview.ts';
import { buildChatGptDashboardViewModel } from '../src/workers/chatgpt/dashboard-view-model.ts';
import { builtInTranscriptionDashboardState } from '../src/workers/source-index/built-in-reasoning/transcription-model.ts';
import { renderDashboardDetailPage } from '../src/workers/dashboard/pages/detail.ts';
import { renderDashboardHomePage } from '../src/workers/dashboard/pages/home.ts';
import { renderDashboardSetupPage } from '../src/workers/dashboard/pages/setup.ts';
import { dashboardHonestStatus } from '../src/workers/dashboard/shared-status.ts';
import {
  dashboardModelsSection,
  dashboardSourceRow,
  dashboardSourceStates,
  type DashboardRowOptions,
  type DashboardSourceRowState,
} from '../src/workers/dashboard/source-rows.ts';
import { dashboardAttentionLine, dashboardProviderRefusalSentence, dashboardStatus } from '../src/workers/dashboard/vocabulary.ts';
import { DASHBOARD_SOURCE_ROWS_CSS } from '../src/workers/dashboard/static-styles.ts';

/**
 * The ChatGPT dashboard's rules on the local pages (owner, 2026-10-02), read
 * off the preview's review states: Gmail mid-sign-in, Google Drive reading at
 * 40%, Dropbox waiting for its folders, Readwise fresh, the private model
 * downloading, privacy set up (or not).
 */
const NOW = DASHBOARD_PREVIEW_NOW;

function page(state: string, kind: 'home' | 'setup', extra: DashboardRowOptions = {}): string {
  const view = buildDashboardPreviewView(state);
  const options = { now: NOW, controlSessionCsrfToken: 'csrf', ...buildDashboardPreviewOptions(state), ...extra };
  return kind === 'home' ? renderDashboardHomePage(view, options) : renderDashboardSetupPage(view, options);
}

function rowFor(html: string, sourceId: string): string {
  const start = html.indexOf(`data-source-row="${sourceId}"`);
  expect(start).toBeGreaterThan(-1);
  const next = html.indexOf('data-source-row="', start + 1);
  const end = html.indexOf('<div class="sect', start);
  const stops = [next, end].filter((index) => index > -1);
  return html.slice(start, stops.length ? Math.min(...stops) : undefined);
}

function rowOrder(html: string): string[] {
  return [...html.matchAll(/data-source-row="([^"]+)"/g)].map((match) => match[1]!);
}

function visibleText(fragment: string): string {
  return fragment.replace(/<span class="sr">[^<]*<\/span>/g, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

describe('rule 1: each fact once', () => {
  test('a source that needs the owner is one row, at the top, with its one fix, and Needs you holds no source', () => {
    for (const kind of ['home', 'setup'] as const) {
      const html = page('review', kind);
      expect(rowOrder(html).slice(0, 2)).toEqual(['gmail.email', 'dropbox.files']);
      // No separate list of the same sources.
      expect(html).not.toContain('<div class="sect">Needs you</div>');
      for (const label of ['Gmail', 'Dropbox']) expect(html.split(`>${label}</a>`).length - 1).toBe(1);
      // One fix per row: one main button (Setup adds only the ⋯ menu).
      const dropbox = rowFor(html, 'dropbox.files');
      expect(dropbox.split('>Choose folders<').length - 1).toBe(1);
    }
  });

  test('Needs you holds only what is not a source, such as privacy not set up yet', () => {
    const html = page('review-unconfigured', 'home');
    const needs = html.slice(html.indexOf('<div class="sect">Needs you</div>'), html.indexOf('<div class="sect">Sources</div>'));
    expect(needs).toContain('Tell Olympus what&#39;s private for you');
    expect(needs).toContain('<a class="btn" href="/dashboard?privacy">Set up privacy</a>');
    expect(needs).not.toContain('data-source-row');
    // On Setup the same ask is the Privacy row itself, not a second item.
    const setup = page('review-unconfigured', 'setup');
    expect(setup).not.toContain('<div class="sect">Needs you</div>');
    expect(setup.split('Tell Olympus what&#39;s private for you').length - 1).toBe(1);
  });

  test('no status word sits beside a name: the dot and the sentence carry it, the word is for screen readers', () => {
    const html = page('review', 'home');
    for (const id of ['gmail.email', 'dropbox.files', 'google_drive.docs', 'readwise.library']) {
      const head = rowFor(html, id).match(/<div class="shead">([\s\S]*?)<\/div>/)![1]!;
      expect(visibleText(head)).not.toMatch(/Fresh|Working|Waiting|Needs you|Failing/);
      expect(head).toMatch(/<span class="sr"> — (Fresh|Working|Waiting|Needs you|Failing)<\/span>/);
    }
  });

  test('Not connected is said once, as a heading, on Setup only', () => {
    const setup = page('review', 'setup');
    expect(setup.split('Not connected').length - 1).toBe(1);
    expect(page('review', 'home')).not.toContain('Not connected');
  });
});

describe('rule 2: colours and buttons', () => {
  test('yellow in progress, orange needs you, green ready, a hollow grey ring for not connected', () => {
    const setup = page('review', 'setup');
    expect(rowFor(setup, 'google_drive.docs')).toContain('class="dot tone-run"');
    expect(rowFor(setup, 'gmail.email')).toContain('class="dot tone-warn"');
    expect(rowFor(setup, 'dropbox.files')).toContain('class="dot tone-warn"');
    expect(rowFor(setup, 'readwise.library')).toContain('class="dot tone-good"');
    const options = setup.slice(setup.indexOf('>Not connected<'));
    expect(options).toContain('<span class="dot hollow"></span>');
  });

  test('row buttons are outlined: no source row or option carries the accent fill', () => {
    for (const kind of ['home', 'setup'] as const) {
      const html = page('review', kind);
      for (const id of rowOrder(html)) expect(rowFor(html, id)).not.toContain('btn primary');
    }
    const setup = page('review', 'setup');
    const options = setup.slice(setup.indexOf('>Not connected<'), setup.indexOf('class="sheet'));
    expect(options).not.toContain('btn primary');
  });
});

describe('rule 3: honest progress', () => {
  test('a source still reading shows its stage and count over a bar, never synced', () => {
    const drive = rowFor(page('review', 'home'), 'google_drive.docs');
    expect(drive).toContain('<p class="sline">Reading — 40%, 1,240 of 3,100 files</p>');
    expect(drive).toContain('role="progressbar" aria-label="Google Drive: Reading — 40%, 1,240 of 3,100 files" aria-valuenow="40"');
    expect(drive).not.toMatch(/Synced|just now|Fresh/);
  });

  test('a stall says why in one sentence with its fix, and keeps an orange bar only over real progress', () => {
    const view = buildDashboardPreviewView('review');
    const drive = view.sources.find((source) => source.source_id === 'google_drive.docs')!;
    const base: DashboardSourceRowState = {
      source: drive,
      status: 'Working',
      group: 'cloud',
      needsYou: false,
      progress: { stage: 'reading', unit: 'files', done: 1_240, total: 3_100, percent: 40, stalled: true, stalledReason: 'provider_unavailable' },
    };
    const options = { now: NOW, controlSessionCsrfToken: 'csrf' };
    const unavailable = dashboardSourceRow(base, view, options, false);
    expect(unavailable).toContain('Paused: Google Drive isn&#39;t responding; Olympus will retry');
    expect(unavailable).toContain('class="bar stalled"');
    const downloading = dashboardSourceRow({ ...base, progress: { ...base.progress!, stage: 'indexing', stalledReason: 'model_downloading' } }, view, options, false);
    expect(downloading).toContain('Waiting for the search model to finish downloading');
    // No real progress (no total yet): the sentence alone, no bar.
    const finding = dashboardSourceRow({ ...base, progress: { ...base.progress!, stage: 'listing', total: 0, done: 0, percent: 0 } }, view, options, false);
    expect(finding).toContain('Paused: Google Drive isn&#39;t responding');
    expect(finding).not.toContain('role="progressbar"');
    // Waiting for folders: the sentence and Choose folders, no bar.
    const dropbox = rowFor(page('review', 'home'), 'dropbox.files');
    expect(dropbox).toContain('Paused until you choose folders');
    expect(dropbox).toContain('data-control-link="/dashboard/dispositions?source_id=dropbox.files"');
    expect(dropbox).not.toContain('role="progressbar"');
  });

  test('Finding items while there is no total, with no bar that would claim a share', () => {
    const view = buildDashboardPreviewView('review');
    const drive = view.sources.find((source) => source.source_id === 'google_drive.docs')!;
    const html = dashboardSourceRow({
      source: drive,
      status: 'Working',
      group: 'cloud',
      needsYou: false,
      progress: { stage: 'listing', unit: 'files', done: 12, total: 0, percent: 0, stalled: false },
    }, view, { now: NOW }, false);
    expect(html).toContain('<p class="sline">Finding items</p>');
    expect(html).not.toContain('role="progressbar"');
  });

  test('the page-wide progress line shows only while two or more sources are working, with no ETA unless measured', () => {
    expect(page('review', 'home')).not.toContain('<div class="sect">Progress</div>');
    const html = page('review-indexing', 'home');
    const section = html.slice(html.indexOf('<div class="sect">Progress</div>'), html.indexOf('<div class="sect">Background</div>'));
    // Done counts what is searchable (indexed), not items read (upstream 4853e2c9).
    expect(section).toContain('First index: 40% done, 2,010 items left');
    // The stalled source says so in its own row; the line is about what moves.
    expect(section).not.toContain('stalled');
    expect(section).not.toContain('about ');
  });

  test('the same engine state reads the same word on both surfaces (holistic review item 9)', () => {
    // Google Drive has found 3,100 files and read 1,240: its card alone reads
    // Fresh (synced minutes ago), which is what the local page used to say
    // while ChatGPT said Working. One shared derivation now decides both.
    const view = buildDashboardPreviewView('review');
    const drive = view.sources.find((source) => source.source_id === 'google_drive.docs')!;
    expect(dashboardStatus({ source: drive })).toBe('Fresh');
    const chatgpt = buildChatGptDashboardViewModel(view, { now: NOW });
    const local = dashboardSourceStates(view, { now: NOW });
    for (const entry of chatgpt.sources) {
      const row = local.rows.find((candidate) => candidate.source.source_id === entry.id)!;
      expect(`${entry.id}: ${row.status}`).toBe(`${entry.id}: ${entry.status}`);
    }
    expect(local.rows.find((row) => row.source.source_id === 'google_drive.docs')!.status).toBe('Working');
    const detail = renderDashboardDetailPage(view, 'google_drive.docs', { now: NOW }) ?? '';
    expect(detail).toContain('class="meta">Working · checked');
    // And the shared rule itself.
    expect(dashboardHonestStatus('Fresh', { stage: 'indexing', unit: 'items', done: 0, total: 100, percent: 0, stalled: false })).toBe('Working');
    expect(dashboardHonestStatus('Fresh', { stage: 'listing', unit: 'files', done: 0, total: 0, percent: 0, stalled: true, stalledReason: 'scope_pending' })).toBe('Needs you');
    expect(dashboardHonestStatus('Fresh', { stage: 'done', unit: 'files', done: 5, total: 5, percent: 100, stalled: false })).toBe('Fresh');
  });
});

describe('a sign-in problem needs the owner whatever the progress says (Codex review, 2026-10-02)', () => {
  function withDrive(patch: (drive: ReturnType<typeof buildDashboardPreviewView>['sources'][number]) => void) {
    const view = buildDashboardPreviewView('review');
    const drive = view.sources.find((source) => source.source_id === 'google_drive.docs')!;
    patch(drive);
    return view;
  }
  const render = (view: ReturnType<typeof buildDashboardPreviewView>, kind: 'home' | 'setup') => {
    const options = { now: NOW, controlSessionCsrfToken: 'csrf', ...buildDashboardPreviewOptions('review') };
    return kind === 'home' ? renderDashboardHomePage(view, options) : renderDashboardSetupPage(view, options);
  };

  test('a refused sign-in over reading in progress stays Needs you, with its sentence and Reconnect', () => {
    const view = withDrive((drive) => {
      drive.connection = { ...drive.connection, provider_refusal: { code: 'access_denied', reason: 'The user denied access.' } };
    });
    // Reading is still under way on the engine's own progress.
    expect(dashboardSourceStates(view, { now: NOW }).rows.find((row) => row.source.source_id === 'google_drive.docs')!.status).toBe('Needs you');
    for (const kind of ['home', 'setup'] as const) {
      const row = rowFor(render(view, kind), 'google_drive.docs');
      expect(row).toContain('class="dot tone-warn"');
      expect(row).toContain('Sign-in was declined');
      expect(row).toContain('data-connect-kind="oauth"');
      expect(row).toContain('>Reconnect</button>');
      expect(row).not.toContain('Reading — 40%');
    }
  });

  test('each surface words a refusal for its own fix: the local sheet\'s How to fix and app settings, ChatGPT\'s Reconnect', () => {
    const cases = [
      { code: 'redirect_uri_mismatch', local: 'fix it in your Google Drive app settings', chatgpt: 'Google Drive sign-in didn\'t go through. Try Reconnect.' },
      { code: 'access_denied', local: 'sign-in was declined — connect again to retry', chatgpt: 'Google Drive sign-in was declined. Connect again to retry.' },
      { code: 'temporarily_unavailable', local: 'see How to fix', chatgpt: 'Google Drive didn\'t finish signing in. Try Reconnect.' },
      { code: '', local: 'see How to fix', chatgpt: 'Google Drive didn\'t finish signing in. Try Reconnect.' },
    ];
    for (const { code, local, chatgpt } of cases) {
      const view = withDrive((drive) => {
        drive.connection = { ...drive.connection, provider_refusal: { code, reason: '' } };
      });
      const drive = view.sources.find((source) => source.source_id === 'google_drive.docs')!;
      // The local dashboard keeps its words.
      expect(dashboardAttentionLine(drive)).toContain(local);
      expect(dashboardAttentionLine(drive, { surface: 'local' })).toBe(dashboardAttentionLine(drive));
      // ChatGPT has no How to fix sheet and no app settings of the owner's own.
      const line = dashboardAttentionLine(drive, { surface: 'chatgpt' });
      const sentence = dashboardProviderRefusalSentence(drive, { surface: 'chatgpt' });
      expect(sentence).toBe(chatgpt);
      for (const words of [line, sentence]) {
        expect(words).toMatch(code === 'access_denied' ? /connect again to retry/i : /try Reconnect/i);
        expect(words).not.toContain('How to fix');
        expect(words).not.toContain('app settings');
      }
    }
  });

  test('the ChatGPT view model asks for its own refusal words; the local Home keeps the local ones', () => {
    for (const [code, chatgpt, local] of [
      ['redirect_uri_mismatch', 'Google Drive — sign-in didn\'t go through — try Reconnect', 'app settings'],
      ['temporarily_unavailable', 'Google Drive — didn\'t finish signing in — try Reconnect', 'How to fix'],
    ] as const) {
      const view = withDrive((drive) => {
        drive.connection = { ...drive.connection, provider_refusal: { code, reason: '' } };
      });
      const item = buildChatGptDashboardViewModel(view, { now: NOW }).needsYou.find((entry) => entry.id === 'source:google_drive.docs')!;
      expect(item.sentence).toBe(chatgpt);
      expect(item.fix).toMatchObject({ label: 'Reconnect', tool: 'olympus_connect_source' });
      expect(rowFor(render(view, 'home'), 'google_drive.docs')).toContain(local);
    }
  });

  test('a degraded credential over reading in progress stays Needs you too', () => {
    const view = withDrive(() => undefined);
    view.degraded_credentials = [{
      kind: 'worker_credential_degraded', display_name: 'Google Drive', state: 'retrying',
      status_label: 'Credential unavailable - needs your attention', hint: '', attempts: 1, max_attempts: 3,
    }];
    const row = rowFor(render(view, 'home'), 'google_drive.docs');
    expect(row).toContain('class="dot tone-warn"');
    expect(row).toContain('Can&#39;t sign in');
    expect(row).not.toContain('Reading — 40%');
  });
});

describe('each number once on Home, and one divider above Models', () => {
  test('while the Progress line shows, the Background card does not repeat an indexing number', () => {
    const working = page('review-indexing', 'home');
    expect(working).toContain('<div class="sect">Progress</div>');
    const background = working.includes('<div class="sect">Background</div>')
      ? working.slice(working.indexOf('<div class="sect">Background</div>'), working.indexOf('Connect more sources'))
      : '';
    expect(background).not.toContain('Indexing');
    // With no Progress line, the Background card keeps its indexing line.
    const quiet = page('review', 'home');
    expect(quiet).not.toContain('<div class="sect">Progress</div>');
    expect(quiet.slice(quiet.indexOf('<div class="sect">Background</div>'))).toContain('Indexing');
  });

  test('the Models row draws no border of its own over the list above it', () => {
    const rule = DASHBOARD_SOURCE_ROWS_CSS.split('\n').find((line) => line.startsWith('.modelsrow {'))!;
    expect(rule).not.toContain('border');
  });
});

describe('rule 4: a sign-in still outstanding', () => {
  test('says Finish signing in with the link time left, and offers one Open sign-in again', () => {
    for (const kind of ['home', 'setup'] as const) {
      const gmail = rowFor(page('review', kind), 'gmail.email');
      expect(gmail).toContain('<p class="sline">Finish signing in to Gmail · link expires in 9 min</p>');
      // Olympus's own app needs nothing first: the button starts a fresh
      // sign-in, which replaces the outstanding one.
      expect(gmail).toContain('<form class="rowform" data-connect-kind="oauth"><input type="hidden" name="source" value="gmail"><button class="btn" type="submit">Open sign-in again</button>');
      expect(gmail).not.toContain('approve in the');
    }
    // Cancel lives in Setup's ⋯ menu.
    expect(rowFor(page('review', 'setup'), 'gmail.email')).toContain('data-connect-kind="oauth_cancel"');
    expect(rowFor(page('review', 'home'), 'gmail.email')).not.toContain('oauth_cancel');
  });
});

describe('rule 5: the Models row', () => {
  test('one line, with each built-in install shown under it on a thin yellow bar', () => {
    const html = page('review', 'setup');
    expect(html).toContain('<summary>Models — Built-in · Getting ready</summary>');
    expect(html).toContain('<p class="sline">Downloading the private model · 40% · 1.2 of 3.0 GB</p>');
    expect(html).toContain('role="progressbar" aria-label="Downloading the private model · 40% · 1.2 of 3.0 GB" aria-valuenow="40"');
    // Status only: no key field appears for a built-in model.
    const start = html.indexOf('id="models"');
    const models = html.slice(start, html.indexOf('</section>', start));
    expect(models).not.toContain('name="api_key"');
  });

  test('checking and failed installs, and Ready once both are done', () => {
    const view = buildDashboardPreviewView('review');
    const render = (privateModel: NonNullable<DashboardRowOptions['modelInstalls']>['privateModel']) => dashboardModelsSection(
      dashboardSourceStates(view, { now: NOW, modelInstalls: { embedding: { kind: 'built_in', state: 'ready' }, ...(privateModel ? { privateModel } : {}) } }),
      view,
    );
    expect(render({ state: 'verifying', percent: 100 })).toContain('Checking the private model…');
    const failed = render({ state: 'failed', failedReason: 'disk_full' });
    expect(failed).toContain('<summary>Models — Built-in · Needs you</summary>');
    // Said once, in Needs you (with how much to free); Models does not repeat it.
    expect(failed).not.toContain('Couldn&#39;t download the private model');
    expect(failed).toContain('Answers: Built-in · Not working');
    const ready = render({ state: 'ready' });
    expect(ready).toContain('<summary>Models — Built-in · Ready</summary>');
    expect(ready).not.toContain('class="minstall');
  });

  test('the built-in transcription model: not needed without audio, its download, and ready', () => {
    const view = buildDashboardPreviewView('review');
    const render = (transcription: NonNullable<DashboardRowOptions['modelInstalls']>['transcription']) => dashboardModelsSection(
      dashboardSourceStates(view, { now: NOW, modelInstalls: { embedding: { kind: 'built_in', state: 'ready' }, ...(transcription ? { transcription } : {}) } }),
      view,
    );
    const none = render(undefined);
    expect(none).not.toContain('Transcription:');
    const status = (fields: Partial<Parameters<typeof builtInTranscriptionDashboardState>[0]['status']>) => ({
      state: 'not_started' as const, modelId: 'm', percent: 0, label: '', bytesDone: 0, bytesTotal: 0, updatedAt: '', ...fields,
    });
    const current = (fields: Parameters<typeof status>[0]) => ({ file: 'current' as const, status: status(fields) });
    const notNeeded = render(builtInTranscriptionDashboardState({ file: 'missing', status: status({}) }));
    expect(notNeeded).toContain('<li>Transcription: Not needed: no audio in your chosen folders ');
    expect(notNeeded).toContain('<summary>Models — Built-in · Ready</summary>');
    const downloading = render(builtInTranscriptionDashboardState(
      current({ state: 'downloading', percent: 42, bytesDone: 428_000_000, bytesTotal: 1_019_141_728 }),
      { installing: true },
    ));
    expect(downloading).toContain('<summary>Models — Built-in · Getting ready</summary>');
    expect(downloading).toContain('<li>Transcription: Built-in · Getting ready</li>');
    expect(downloading).toContain('<p class="sline">Downloading the transcription model · 42% · 0.4 of 1.0 GB</p>');
    const failed = render(builtInTranscriptionDashboardState(current({
      state: 'failed', percent: 10,
      failure: { reason: 'insufficient_space', message: 'x', bytesNeeded: 3, bytesFree: 1, retryAfter: '' },
    })));
    expect(failed).toContain('<summary>Models — Built-in · Needs you</summary>');
    expect(failed).toContain('Couldn&#39;t download the transcription model: the disk is full');
    const ready = render(builtInTranscriptionDashboardState(current({ state: 'loading', percent: 100 })));
    expect(ready).toContain('<li>Transcription: Built-in · Ready</li>');
    expect(ready).not.toContain('class="minstall');
  });

  test('transcription: a download left behind by a stopped engine, an unreadable or older status file, and a model that will not start', () => {
    const view = buildDashboardPreviewView('review');
    const render = (transcription: NonNullable<DashboardRowOptions['modelInstalls']>['transcription']) => dashboardModelsSection(
      dashboardSourceStates(view, { now: NOW, modelInstalls: { embedding: { kind: 'built_in', state: 'ready' }, ...(transcription ? { transcription } : {}) } }),
      view,
    );
    const status = { state: 'downloading' as const, modelId: 'm', percent: 40, label: '', bytesDone: 4, bytesTotal: 10, updatedAt: '' };
    // F1: the file says 40% but nothing in this process is downloading.
    const stale = builtInTranscriptionDashboardState({ file: 'current', status }, { installing: false });
    expect(stale).toEqual({ state: 'interrupted' });
    const staleHtml = render(stale);
    expect(staleHtml).toContain('<li>Transcription: Download stopped before it finished ');
    expect(staleHtml).toContain('Download now');
    expect(staleHtml).not.toContain('class="minstall');
    // F2: unreadable, or written for another model, is not "no audio".
    const unreadable = builtInTranscriptionDashboardState({ file: 'unreadable', status: { ...status, state: 'not_started' } });
    expect(unreadable).toEqual({ state: 'not_downloaded' });
    const unreadableHtml = render(unreadable);
    expect(unreadableHtml).toContain('<li>Transcription: Not downloaded ');
    expect(unreadableHtml).toContain('Download now');
    // F3: downloaded, but its server would not start: Try again, not Download now.
    const loadFailed = builtInTranscriptionDashboardState({
      file: 'current',
      status: { ...status, state: 'failed', failure: { reason: 'runtime_load_failed', message: 'x' } },
    });
    expect(loadFailed).toEqual({ state: 'load_failed' });
    const loadHtml = render(loadFailed);
    expect(loadHtml).toContain('<li>Transcription: Couldn&#39;t start the transcription model ');
    expect(loadHtml).toContain('Try again');
    expect(loadHtml).not.toContain('Download now');
    expect(loadHtml).toContain('<summary>Models — Built-in · Needs you</summary>');
  });

  test('a failed built-in download is a Needs-you item with one Try again', () => {
    const html = page('review', 'home', {
      modelInstalls: { embedding: { kind: 'built_in', state: 'ready' }, privateModel: { state: 'failed', failedReason: 'network' } },
    });
    const needs = html.slice(html.indexOf('<div class="sect">Needs you</div>'), html.indexOf('<div class="sect">Sources</div>'));
    expect(needs).toContain('Couldn&#39;t download the private model: the network dropped.');
    expect(needs).toContain('<form class="rowform" data-model-retry="answers"><button class="btn" type="submit">Try again</button>');
  });
});

describe('rule 6: the Privacy row', () => {
  test('Setup shows the description and rule count with Edit, or the one ask to set it up', () => {
    const configured = page('review', 'setup');
    const row = configured.slice(configured.indexOf('data-privacy-row'));
    expect(row).toContain('Uses your description and 3 always-private rules.');
    expect(row).toContain('12 items waiting to be checked');
    expect(row).toContain('<a class="btn" href="/dashboard?privacy">Edit</a>');
    const unset = page('review-unconfigured', 'setup');
    expect(unset).toContain('Tell Olympus what&#39;s private for you');
    expect(unset).toContain('<a class="btn" href="/dashboard?privacy">Set up privacy</a>');
    const unreadable = page('review', 'setup', { privacy: 'unreadable' });
    expect(unreadable).toContain('Olympus could not read your privacy settings.');
  });

  test('no page says Public', () => {
    for (const state of ['review', 'review-unconfigured', 'review-indexing']) {
      for (const view of ['home', 'setup', 'background', 'privacy', 'sensitivity'] as const) {
        expect(`${state}/${view}: ${readResult({ view }, true, 'partial', state).body.includes('Public')}`).toBe(`${state}/${view}: false`);
      }
    }
  });
});
