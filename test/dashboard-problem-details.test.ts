/**
 * Every problem line has a route to its details (owner rule, 2026-10-10:
 * never say something is wrong without a way to find out exactly what it
 * is). A stalled source carries why behind its row's See why; a failed Sync
 * now says why in its line; the page-wide progress line names the stopped
 * sources; a model that would not start or download says why; the
 * unreachable banner says what the last read got back; and an opaque tool
 * error names the reference its log line carries. Only closed words, counts,
 * times and a 16-hex reference cross: never a provider's or an error's text.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import { buildChatGptDashboardViewModel } from '../src/workers/chatgpt/dashboard-view-model.ts';
import { copyDashboardViewModel, errorToolResult } from '../src/workers/chatgpt/response-builder.ts';
import type { DashboardSource, DashboardViewModelV1 } from '../src/workers/chatgpt/dashboard-contract.ts';
import { chatgptDashboardPageHtml } from '../src/workers/dashboard/chatgpt/page.ts';
import { sourceFailureKind, sourceFailureRef } from '../src/workers/dashboard/source-failure.ts';
import {
  DASHBOARD_CHATGPT_CONNECTION_COPY as C,
  DASHBOARD_CHATGPT_PAGE_COPY as P,
  DASHBOARD_SOURCE_FAILURE_WORDS,
  dashboardManualSyncLine,
} from '../src/workers/dashboard/vocabulary.ts';
import {
  dashboardManualSyncOutcome,
  type DashboardSourceCard,
  type SourceDashboardViewModel,
} from '../src/workers/source-dashboard.ts';
import { modelLoadFailedReason } from '../src/workers/source-index/built-in-reasoning/transcription-model.ts';
import type { SourceSchedulerStatus } from '../src/workers/source-scheduler.ts';
import { OperationError } from '../src/core/operation-error.ts';

const NOW = new Date('2026-10-10T12:00:00.000Z');
const HOUR = 3_600_000;
const REF = '0123456789abcdef';
const PROVIDER_WORDS = 'upstream 503 maintenance for jamie@example.test';

/* ------------------------------------------------------------------ */
/* The closed failure words                                           */
/* ------------------------------------------------------------------ */

describe('a failure is one closed word', () => {
  test('scheduler error kinds and markers map onto words the page can say', () => {
    expect(sourceFailureKind('credential_reauth_required')).toBe('sign_in');
    expect(sourceFailureKind('timeout')).toBe('timeout');
    expect(sourceFailureKind('network')).toBe('network');
    expect(sourceFailureKind('temporary')).toBe('provider_busy');
    expect(sourceFailureKind('sqlite_busy')).toBe('busy_here');
    expect(sourceFailureKind('embedding_backend_unavailable')).toBe('search_model_unavailable');
    expect(sourceFailureKind(undefined, 'daily_cost_guard')).toBe('daily_limit');
    expect(sourceFailureKind(undefined, 'provider_rate_limit')).toBe('rate_limited');
    expect(sourceFailureKind('task_failed')).toBe('unknown');
    expect(sourceFailureKind(PROVIDER_WORDS)).toBe('unknown');
    expect(sourceFailureKind(undefined)).toBe('unknown');
  });

  test('a reference is 16 hex characters or nothing', () => {
    expect(sourceFailureRef(REF)).toBe(REF);
    for (const bad of ['0123456789ABCDEF', '0123', `${REF}0`, PROVIDER_WORDS, 7, undefined]) {
      expect(sourceFailureRef(bad)).toBeUndefined();
    }
  });

  test('the transcription model says why it would not start, from our own messages only', () => {
    expect(modelLoadFailedReason('The transcription model is not installed.')).toBe('not_installed');
    expect(modelLoadFailedReason('The transcription server exited while starting (code 1).')).toBe('stopped_while_starting');
    expect(modelLoadFailedReason('The transcription server did not load within 120 seconds.')).toBe('too_slow');
    expect(modelLoadFailedReason('No free loopback port for the transcription server.')).toBe('port_taken');
    expect(modelLoadFailedReason(PROVIDER_WORDS)).toBe('unknown');
  });
});

/* ------------------------------------------------------------------ */
/* Sync now: the failed line says why                                 */
/* ------------------------------------------------------------------ */

describe('a failed Sync now says why', () => {
  const before: SourceSchedulerStatus = {
    sources: [{ source_id: 'dropbox.files', tasks: [{ id: 'sync', kind: 'sync', last_attempt_at: '2026-10-10T11:00:00.000Z' }] }],
  } as unknown as SourceSchedulerStatus;
  const after = (task: Record<string, unknown>) => ({
    kind: 'source_scheduler_status',
    sources: [{ source_id: 'dropbox.files', tasks: [{ id: 'sync', kind: 'sync', last_attempt_at: NOW.toISOString(), ...task }] }],
  });

  test('a classified failure carries its word and no reference', () => {
    const outcome = dashboardManualSyncOutcome({
      result: after({ last_result: { status: 'failed' }, last_error_kind: 'timeout', last_error_hash: REF }),
      before,
      schedulerSourceId: 'dropbox.files',
      at: NOW,
    });
    expect(outcome).toEqual({ at: NOW.toISOString(), outcome: 'failed', failure_kind: 'timeout' });
    expect(dashboardManualSyncLine({ label: 'Dropbox', family: 'file', last_manual_sync: outcome } as DashboardSourceCard, NOW))
      .toBe('Couldn\'t check Dropbox just now: Dropbox took too long to answer. Olympus will try again on its own.');
  });

  test('an unclassified failure carries the reference its scheduler log line has', () => {
    const outcome = dashboardManualSyncOutcome({
      result: after({ last_result: { status: 'failed' }, last_error_kind: 'task_failed', last_error_hash: REF }),
      before,
      schedulerSourceId: 'dropbox.files',
      at: NOW,
    });
    expect(outcome).toMatchObject({ outcome: 'failed', failure_kind: 'unknown', failure_ref: REF });
    expect(dashboardManualSyncLine({ label: 'Dropbox', family: 'file', last_manual_sync: outcome } as DashboardSourceCard, NOW))
      .toContain(`under reference ${REF}.`);
  });

  test('nothing ran and nothing is running: the check did not start', () => {
    const outcome = dashboardManualSyncOutcome({
      result: { kind: 'source_scheduler_status', sources: [{ source_id: 'dropbox.files', tasks: [{ id: 'sync', kind: 'sync', last_attempt_at: '2026-10-10T11:00:00.000Z' }] }] },
      before,
      schedulerSourceId: 'dropbox.files',
      at: NOW,
    });
    expect(outcome).toEqual({ at: NOW.toISOString(), outcome: 'failed', failure_kind: 'not_started' });
  });

  test('the view model and the response builder carry the word, and the reference only for unknown', () => {
    const failing = { ...card(), last_manual_sync: { at: NOW.toISOString(), outcome: 'failed' as const, failure_kind: 'unknown' as const, failure_ref: REF } };
    const dropbox = copyDashboardViewModel(viewModelOf(failing)).sources[0]!;
    expect(dropbox.lastManualSync).toEqual({ at: NOW.toISOString(), outcome: 'failed', failure: 'unknown', ref: REF });
    expect(dropbox.detail).toContain(REF);
    const forged = copyDashboardViewModel({
      ...viewModelOf(card()),
      sources: [{ ...dropbox, lastManualSync: { at: NOW.toISOString(), outcome: 'failed', failure: 'timeout', ref: REF } }],
    }).sources[0]!;
    expect(forged.lastManualSync).toEqual({ at: NOW.toISOString(), outcome: 'failed', failure: 'timeout' });
    const planted = copyDashboardViewModel({
      ...viewModelOf(card()),
      sources: [{ ...dropbox, lastManualSync: { at: NOW.toISOString(), outcome: 'failed', failure: PROVIDER_WORDS as any, ref: PROVIDER_WORDS } }],
    });
    expect(JSON.stringify(planted)).not.toContain('example.test');
  });
});

/* ------------------------------------------------------------------ */
/* A stalled source: why, behind its See why                          */
/* ------------------------------------------------------------------ */

describe('a stalled source carries why', () => {
  test('a failing source names the failure, the count, when it last worked and tries again', () => {
    const dropbox = viewModelOf(card({
      schedule: {
        running: false,
        consecutive_failures: 3,
        last_error_kind: 'timeout',
        last_error_hash: REF,
        last_success_at: new Date(NOW.getTime() - 5 * HOUR).toISOString(),
        next_run_at: new Date(NOW.getTime() + 14 * 60_000).toISOString(),
      },
    })).sources[0]!;
    expect(dropbox.progress?.stalled).toBe(true);
    expect(dropbox.progress?.stall).toEqual({
      cause: 'failing',
      failure: 'timeout',
      failures: 3,
      lastWorkedAt: new Date(NOW.getTime() - 5 * HOUR).toISOString(),
      nextTryAt: new Date(NOW.getTime() + 14 * 60_000).toISOString(),
    });
  });

  test('an unclassified failure carries its log reference; a provider\'s words never cross', () => {
    const dropbox = viewModelOf(card({
      schedule: { running: false, consecutive_failures: 2, last_error_kind: 'task_failed', last_error_hash: REF, degraded_reason: PROVIDER_WORDS },
    })).sources[0]!;
    expect(dropbox.progress?.stall).toMatchObject({ cause: 'failing', failure: 'unknown', failures: 2, ref: REF });
    expect(JSON.stringify(copyDashboardViewModel(viewModelOf(card({
      schedule: { running: false, consecutive_failures: 2, last_error_kind: PROVIDER_WORDS, last_error_hash: PROVIDER_WORDS },
    }))))).not.toContain('example.test');
  });

  test('the response builder keeps closed values only', () => {
    const model = viewModelOf(card({ schedule: { running: false, consecutive_failures: 1, last_error_kind: 'timeout' } }));
    const source = model.sources[0]!;
    source.progress!.stall = {
      cause: 'failing', failure: 'timeout', failures: 1.7, ref: REF, lastWorkedAt: PROVIDER_WORDS, stage: 'reading', extra: PROVIDER_WORDS,
    } as any;
    const copied = copyDashboardViewModel(model).sources[0]!.progress!.stall!;
    expect(copied).toEqual({ cause: 'failing', failure: 'timeout', failures: 2, stage: 'reading' });
    source.progress!.stall = { cause: PROVIDER_WORDS } as any;
    expect(copyDashboardViewModel(model).sources[0]!.progress!.stall).toBeUndefined();
  });
});

/* ------------------------------------------------------------------ */
/* An opaque tool error: a reference, logged on the computer           */
/* ------------------------------------------------------------------ */

describe('an opaque tool error names its log reference', () => {
  test('internal and email_error carry a fresh reference, logged with the bounded message', () => {
    const logged: string[] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => { logged.push(args.map(String).join(' ')); };
    try {
      const result = errorToolResult(new Error(`boom ${'x'.repeat(400)}`));
      const ref = (result.structuredContent as { ref: string }).ref;
      expect(result.structuredContent).toEqual({ error: 'internal', ref });
      expect(ref).toMatch(/^[0-9a-f]{16}$/);
      expect((result.content[0] as { text: string }).text).toContain(`under reference ${ref}.`);
      expect(logged.some((line) => line.includes(`ref=${ref}`) && line.includes('boom') && line.length < 400)).toBe(true);
      const other = errorToolResult(new OperationError('email_error', 'connector exploded'));
      expect((other.structuredContent as { ref?: string }).ref).toMatch(/^[0-9a-f]{16}$/);
      expect((other.structuredContent as { ref?: string }).ref).not.toBe(ref);
      expect((other.content[0] as { text: string }).text).not.toContain('connector exploded');
    } finally {
      console.error = original;
    }
  });

  test('a code whose sentence already says what to do gets no reference', () => {
    expect(errorToolResult(new OperationError('invalid_params', 'bad')).structuredContent).toEqual({ error: 'invalid_params' });
  });
});

/* ------------------------------------------------------------------ */
/* The page                                                            */
/* ------------------------------------------------------------------ */

describe('the page shows the route to details, calmly', () => {
  const STALLED: DashboardSource = {
    id: 'dropbox.files', label: 'Dropbox', group: 'cloud', status: 'Failing',
    progress: {
      stage: 'reading', unit: 'files', done: 100, total: 254, percent: 39, stalled: true, stalledReason: 'provider_unavailable',
      stall: { cause: 'failing', failure: 'unknown', failures: 3, ref: REF, lastWorkedAt: new Date(Date.now() - 5 * HOUR).toISOString(), nextTryAt: new Date(Date.now() + 14 * 60_000 + 20_000).toISOString() },
    },
  };

  test('a stalled row keeps its one line, with the details behind a closed See why', () => {
    const host = mount({});
    host.push({ structuredContent: model({ sources: [STALLED] }) });
    const row = host.doc.querySelector('.row.source')!;
    expect(row.querySelector('.stall-line')!.textContent).toBe(P.stalledReasons.provider_unavailable.replace('{source}', 'Dropbox'));
    const why = row.querySelector('details.why') as HTMLDetailsElement;
    expect(why.open).toBe(false);
    expect(why.querySelector('summary')!.textContent).toBe(P.seeWhy);
    const lines = Array.from(why.querySelectorAll('.stall-why li')).map((node) => node.textContent);
    expect(lines).toEqual([
      DASHBOARD_SOURCE_FAILURE_WORDS.unknown,
      'The last 3 tries failed.',
      'Last worked 5 hr ago.',
      'Olympus tries again in 14 min.',
      `Olympus's log on the computer has the details under reference ${REF}.`,
    ]);
  });

  test('a stall the engine gave no reason for leads with why instead of a bare "Paused"', () => {
    const host = mount({});
    const quiet: DashboardSource = {
      id: 'notes', label: 'Notes', group: 'local', status: 'Working',
      progress: { stage: 'indexing', unit: 'files', done: 4, total: 10, percent: 40, stalled: true, stall: { cause: 'switched_off', stage: 'indexing' } },
    };
    host.push({ structuredContent: model({ sources: [quiet] }) });
    expect(host.doc.querySelector('.stall-line')!.textContent).toBe('Indexing is turned off in Olympus\'s settings.');
  });

  test('the page-wide line names the stopped sources instead of "stalled"', () => {
    const host = mount({});
    const progress = { unit: 'files' as const, phase: 'initial' as const, percent: 42, itemsLeft: 1204, stalled: true, details: [] };
    const gmail = { ...STALLED, id: 'gmail.email', label: 'Gmail' };
    const notes = { ...STALLED, id: 'notes', label: 'Notes' };
    const drive: DashboardSource = {
      id: 'google_drive.docs', label: 'Google Drive', group: 'cloud', status: 'Working',
      progress: { stage: 'reading', unit: 'files', done: 120, total: 300, percent: 40, stalled: false },
    };
    // The page-wide line shows while two or more sources are moving.
    const moving = [drive, { ...drive, id: 'readwise.library', label: 'Readwise' }];
    host.push({ structuredContent: model({ progress, sources: [STALLED, ...moving] }) });
    expect(host.doc.querySelector('.progress-line')!.textContent).toBe('First index: 42% done, 1,204 files left, Dropbox paused');
    host.push({ structuredContent: model({ progress, sources: [STALLED, gmail, ...moving] }) });
    expect(host.doc.querySelector('.progress-line')!.textContent).toContain('Dropbox and Gmail paused');
    host.push({ structuredContent: model({ progress, sources: [STALLED, gmail, notes, ...moving] }) });
    expect(host.doc.querySelector('.progress-line')!.textContent).toContain('Dropbox, Gmail and 1 more paused');
  });

  test('a model that would not start or download says why', () => {
    const host = mount({});
    host.push({ structuredContent: model({
      models: {
        embedding: { kind: 'built_in', state: 'failed', failedReason: 'disk_full' },
        transcription: { state: 'load_failed', loadFailedReason: 'too_slow' },
      },
    }) });
    expect(host.text()).toContain('Not working: the disk is full');
    expect(host.text()).toContain('Couldn\'t start the transcription model: it took too long to start');
  });

  test('the unreachable banner says what the last read got back, behind See why', async () => {
    const host = mount({
      olympus_dashboard: () => ({ isError: true, content: [{ type: 'text', text: `Olympus could not complete this request. Try again shortly. Olympus's log on the computer has the details under reference ${REF}.` }], structuredContent: { error: 'internal', ref: REF } }),
    });
    host.push({ structuredContent: model() });
    host.push({ isError: true, content: [{ type: 'text', text: 'x' }] });
    host.button('Try again').click();
    await host.settle();
    expect(host.text()).toContain(C.relay_unavailable.title);
    const why = host.doc.querySelector('.banner details.why') as HTMLDetailsElement;
    expect(why.open).toBe(false);
    expect(why.textContent).toContain(`Olympus answered with an error: Olympus could not complete this request. Try again shortly. Olympus's log on the computer has the details under reference ${REF}.`);
    expect(why.textContent).toContain('Last tried just now.');
  });

  test('a host error says so too', async () => {
    const refused = mount({ olympus_dashboard: () => 'fail' });
    refused.push({ isError: true, content: [] });
    refused.button('Try again').click();
    await refused.settle();
    expect(refused.doc.querySelector('.banner details.why')!.textContent).toContain('The connection to Olympus failed: gone');
  });
});

/* ------------------------------------------------------------------ */
/* Fixtures                                                            */
/* ------------------------------------------------------------------ */

function card(overrides: Partial<DashboardSourceCard> = {}): DashboardSourceCard {
  return {
    corpus_id: 'secure_local.dropbox.files',
    source_id: 'dropbox.files',
    label: 'Dropbox',
    provider: 'dropbox',
    family: 'file',
    trust_domain: 'secure_local',
    configured: true,
    freshness: { label: 'Last checked 5 hours ago', hours: 5, threshold_hours: 26, stale: false },
    coverage: {
      indexed_items: 254,
      content_ready_items: 100,
      embedded_items: 0,
      embedded_files: 100,
      needs_review_items: 0,
      answer_ready_eligible_items: 254,
    },
    ingestion_health: { coverage_percent: 39, stuck_count: 0, drain_state: 'enabled', label: '' },
    tier_composition: [],
    queue_health: { label: 'Needs attention', waiting: 0, active: 0, needs_attention: 1, failing_tasks: 1 },
    answer_readiness: { state: 'ready', label: 'Ready for questions' },
    connection: { state: 'synced', label: 'synced 5 hours ago', action: { kind: 'none' }, handles: ['dropbox.personal'] },
    last_sync_at: new Date(NOW.getTime() - 5 * HOUR).toISOString(),
    ...overrides,
  } as DashboardSourceCard;
}

function viewModelOf(source: DashboardSourceCard): DashboardViewModelV1 {
  const view = { sources: [source], generated_at: NOW.toISOString() } as unknown as SourceDashboardViewModel;
  return buildChatGptDashboardViewModel(view, { now: NOW });
}

function model(overrides: Partial<DashboardViewModelV1> = {}): DashboardViewModelV1 {
  return { v: 1, connection: { state: 'ready' }, needsYou: [], sources: [], models: { embedding: { kind: 'built_in', state: 'ready' } }, generatedAt: new Date().toISOString(), ...overrides };
}

type Serve = (args: any) => unknown | 'hang' | 'fail';
interface Host {
  win: Window;
  doc: Document;
  text(): string;
  button(label: string): HTMLButtonElement;
  push(result: unknown): void;
  settle(): Promise<void>;
}

const hosts: Host[] = [];
afterEach(async () => {
  while (hosts.length) await hosts.pop()!.win.happyDOM.close();
});
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function mount(serve: Record<string, Serve>): Host {
  const html = chatgptDashboardPageHtml({ resultTimeoutMs: 5_000, connectPollMs: 5 });
  const start = html.indexOf('<script>') + '<script>'.length;
  const script = html.slice(start, html.indexOf('</script>', start));
  const win = new Window({ url: 'https://sandbox.test/' });
  win.document.write(html.slice(0, start - '<script>'.length) + html.slice(html.indexOf('</script>', start) + '</script>'.length));
  const dispatch = (data: unknown) => win.dispatchEvent(new win.MessageEvent('message', { data, source: parent as any }));
  const parent = {
    postMessage: (message: any) => {
      if (message.method !== 'tools/call') return;
      const handler = serve[message.params.name];
      if (!handler) return;
      const answer = handler(message.params.arguments);
      if (answer === 'hang') return;
      setTimeout(() => dispatch(answer === 'fail'
        ? { jsonrpc: '2.0', id: message.id, error: { code: -1, message: 'gone' } }
        : { jsonrpc: '2.0', id: message.id, result: answer }), 0);
    },
  };
  Object.defineProperty(win, 'parent', { value: parent, configurable: true });
  (win as any).openai = { displayMode: 'fullscreen', notifyIntrinsicHeight: () => undefined, requestDisplayMode: () => undefined, openExternal: () => undefined, setWidgetState: () => undefined };
  new Function('window', 'document', script)(win, win.document);
  const buttons = () => Array.from(win.document.querySelectorAll('#app button')) as unknown as HTMLButtonElement[];
  const host: Host = {
    win,
    doc: win.document as unknown as Document,
    text: () => win.document.getElementById('app')!.textContent ?? '',
    button: (label) => {
      const found = buttons().find((node) => node.textContent === label);
      if (!found) throw new Error(`no button "${label}" in: ${buttons().map((b) => b.textContent).join(' | ')}`);
      return found;
    },
    push: (result) => dispatch({ jsonrpc: '2.0', method: 'ui/notifications/tool-result', params: result }),
    settle: async () => {
      for (let i = 0; i < 5; i++) await sleep(1);
    },
  };
  hosts.push(host);
  return host;
}
