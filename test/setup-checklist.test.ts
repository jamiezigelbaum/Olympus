// The one setup checklist (#1077): each step's states, the one way forward
// from each, and that nothing but names and states ever leaves it.
import { describe, expect, test } from 'bun:test';
import {
  buildSetupChecklist,
  parseSetupChecklist,
  renderSetupChecklistText,
  SETUP_DASHBOARD_LINKS,
  SETUP_OWNER_WHY,
  SETUP_STEP_IDS,
  type SetupChecklist,
  type SetupFacts,
  type SetupStepId,
} from '../src/core/setup-checklist.ts';
import { readSetupStatus } from '../src/core/setup-status.ts';
import { loadConfig } from '../src/core/config.ts';
import { createPendingPrivacyPolicy } from '../src/core/first-run-privacy.ts';
import { loadSovereigntyPreset } from '../src/core/sovereignty.ts';
import { readSetupWorkerFacts, setupChecklistFromView, setupFactsFromView } from '../src/workers/setup-status.ts';
import type { DashboardSourceCard, SourceDashboardViewModel } from '../src/workers/source-dashboard.ts';
import { DASHBOARD_SETUP_AGENT_COPY } from '../src/workers/dashboard/vocabulary.ts';
import { renderComputerHostPage, setupAgentDialog } from '../src/workers/dashboard/host-page.ts';
import { createDashboardPanelTools } from '../src/workers/engine/dashboard/dashboard-panel-tools.ts';
import { COMPUTER_META_KEY, DASHBOARD_TOOL_NAME } from '../src/workers/chatgpt/dashboard-contract.ts';

const RUNNING_EMPTY: SetupFacts = {
  version: '1.5.0',
  running: true,
  privateAnswers: { chosen: false },
  judge: { chosen: false },
  sources: [],
  messaging: [],
  aiApps: [],
  findableItems: 0,
};

const ALL_DONE: SetupFacts = {
  version: '1.5.0',
  running: true,
  privateAnswers: { chosen: true, label: 'Local models with Venice fallback' },
  judge: { chosen: true, choice: 'venice', limitDollars: 5 },
  sources: [{ id: 'gmail.email', name: 'Gmail', state: 'connected' }, { id: 'dropbox.files', name: 'Dropbox', state: 'skipped' }],
  messaging: [{ name: 'WhatsApp', paired: true, chatsChosen: true }],
  aiApps: ['ChatGPT'],
  findableItems: 1200,
};

function step(checklist: SetupChecklist, id: SetupStepId) {
  const found = checklist.steps.find((entry) => entry.id === id);
  if (!found) throw new Error(`no step ${id}`);
  return found;
}

/** Anything that looks like a credential, a path or a message. */
const LEAKS = [/dash_/, /olympus_conn_/i, /bearer/i, /sk-[A-Za-z0-9]/, /secret-token/, /[A-Za-z0-9_-]{32,}/];
function expectNoLeak(value: unknown): void {
  const text = JSON.stringify(value);
  for (const pattern of LEAKS) expect(text).not.toMatch(pattern);
}

describe('the setup checklist', () => {
  test('seven steps in a fixed order, each with exactly one way forward', () => {
    const checklist = buildSetupChecklist(RUNNING_EMPTY);
    expect(checklist.steps.map((entry) => entry.id)).toEqual([...SETUP_STEP_IDS]);
    for (const entry of checklist.steps) {
      if (entry.forward.kind === 'command') {
        expect(Object.keys(entry.forward).sort()).toEqual(['command', 'kind']);
        expect(entry.forward.command).toMatch(/^olympus /);
      } else {
        expect(Object.keys(entry.forward).sort()).toEqual(['kind', 'link', 'reason', 'why']);
        expect(Object.values(SETUP_DASHBOARD_LINKS) as string[]).toContain(entry.forward.link);
        expect(entry.forward.why).toBe(SETUP_OWNER_WHY[entry.forward.reason]);
      }
    }
  });

  test('a fresh install: the first open step is next, the rest to do, chats skipped until something is paired', () => {
    const checklist = buildSetupChecklist(RUNNING_EMPTY);
    expect(checklist.steps.map((entry) => [entry.id, entry.state])).toEqual([
      ['installed', 'done'],
      ['private_answers', 'next'],
      ['privacy_judge', 'todo'],
      ['sources', 'todo'],
      ['messaging_chats', 'skipped'],
      ['ai_app', 'todo'],
      ['first_items', 'todo'],
    ]);
    expect(checklist).toMatchObject({ done: 1, total: 6, complete: false, next: { id: 'private_answers' } });
  });

  test('who may change what does not move: privacy, access and spending are owner links; only read commands are runnable', () => {
    const checklist = buildSetupChecklist(RUNNING_EMPTY);
    expect(step(checklist, 'private_answers').forward).toEqual({ kind: 'owner', link: '/dashboard?keys#private-routing', reason: 'privacy', why: SETUP_OWNER_WHY.privacy });
    expect(step(checklist, 'privacy_judge').forward).toMatchObject({ kind: 'owner', link: '/dashboard?keys#privacy-judge', reason: 'spending' });
    expect(step(checklist, 'sources').forward).toMatchObject({ kind: 'owner', link: '/dashboard?connect#add-source', reason: 'access' });
    expect(step(checklist, 'ai_app').forward).toMatchObject({ kind: 'owner', link: '/dashboard?settings#agents', reason: 'access' });
    expect(step(checklist, 'installed').forward).toEqual({ kind: 'command', command: 'olympus doctor' });
    expect(step(checklist, 'first_items').forward).toEqual({ kind: 'command', command: 'olympus source index status' });
  });

  test('each step moves to done on its own fact, and next moves along', () => {
    let facts: SetupFacts = { ...RUNNING_EMPTY };
    const order: Array<[SetupStepId, Partial<SetupFacts>]> = [
      ['private_answers', { privateAnswers: { chosen: true, label: 'Venice' } }],
      ['privacy_judge', { judge: { chosen: true, choice: 'local' } }],
      ['sources', { sources: [{ id: 'gmail.email', name: 'Gmail', state: 'connected' }] }],
      ['ai_app', { aiApps: ['Claude'] }],
      ['first_items', { findableItems: 3 }],
    ];
    for (const [id, change] of order) {
      expect(buildSetupChecklist(facts).next?.id).toBe(id);
      facts = { ...facts, ...change };
      expect(step(buildSetupChecklist(facts), id).state).toBe('done');
    }
    const finished = buildSetupChecklist(facts);
    expect(finished).toMatchObject({ complete: true, done: 6, total: 6 });
    expect(finished.next).toBeUndefined();
  });

  test('done details name the choice: mode label, judge and limit, connected sources, apps, item count', () => {
    const checklist = buildSetupChecklist(ALL_DONE);
    expect(checklist).toMatchObject({ done: 7, total: 7, complete: true });
    expect(step(checklist, 'installed').detail).toBe('Version 1.5.0');
    expect(step(checklist, 'private_answers').detail).toBe('Local models with Venice fallback');
    expect(step(checklist, 'privacy_judge').detail).toBe('Venice, up to $5');
    expect(step(checklist, 'sources').title).toBe('Gmail connected');
    expect(step(checklist, 'sources').sources).toEqual([
      { id: 'gmail.email', name: 'Gmail', state: 'connected' },
      { id: 'dropbox.files', name: 'Dropbox', state: 'skipped' },
    ]);
    expect(step(checklist, 'messaging_chats').title).toBe('WhatsApp chats chosen');
    expect(step(checklist, 'ai_app').detail).toBe('ChatGPT');
    expect(step(checklist, 'first_items').detail).toBe('1,200 items findable');
    expect(buildSetupChecklist({ ...ALL_DONE, judge: { chosen: true, choice: 'venice', limitDollars: null } }).steps[2]!.detail).toBe('Venice, no spending limit set');
    expect(buildSetupChecklist({ ...ALL_DONE, judge: { chosen: true, choice: 'local' } }).steps[2]!.detail).toBe('On this computer, free');
    expect(buildSetupChecklist({ ...ALL_DONE, judge: { chosen: true, choice: 'local-then-venice', limitDollars: 3 } }).steps[2]!.detail).toBe('This computer, then Venice double-checks, up to $3');
    expect(buildSetupChecklist({ ...ALL_DONE, judge: { chosen: true, choice: 'local-then-venice', limitDollars: null } }).steps[2]!.detail).toBe('This computer, then Venice double-checks, no spending limit set');
  });

  test('a paired chat app without chosen chats is next, with the owner link to choose them', () => {
    const checklist = buildSetupChecklist({ ...ALL_DONE, messaging: [{ name: 'WhatsApp', paired: true, chatsChosen: false }] });
    const chats = step(checklist, 'messaging_chats');
    expect(chats).toMatchObject({ state: 'next', title: 'Choose your WhatsApp chats', detail: 'Paired. Pick which chats Olympus keeps.' });
    expect(chats.forward).toMatchObject({ kind: 'owner', link: '/dashboard?connect#sources', reason: 'access' });
    expect(checklist).toMatchObject({ done: 6, total: 7, next: { id: 'messaging_chats' } });
  });

  test('a source that needs the owner again is said, and the step stays done while another is connected', () => {
    const only = buildSetupChecklist({ ...RUNNING_EMPTY, privateAnswers: { chosen: true }, judge: { chosen: true, choice: 'local' }, sources: [{ id: 'gmail.email', name: 'Gmail', state: 'needs_you' }] });
    expect(step(only, 'sources')).toMatchObject({ state: 'next', detail: 'Gmail needs you to finish connecting.', forward: { link: '/dashboard?connect#sources' } });
    const mixed = buildSetupChecklist({ ...ALL_DONE, sources: [{ id: 'a', name: 'Gmail', state: 'connected' }, { id: 'b', name: 'Dropbox', state: 'needs_you' }] });
    expect(step(mixed, 'sources')).toMatchObject({ state: 'done', detail: 'Dropbox needs you.' });
  });

  test('Olympus not running: installed is next with a command to run, and nothing unknown is claimed done or skipped', () => {
    const checklist = buildSetupChecklist({ version: '1.5.0', running: false });
    expect(step(checklist, 'installed')).toMatchObject({ state: 'next', forward: { kind: 'command', command: 'olympus doctor' } });
    for (const entry of checklist.steps.slice(1)) {
      expect(entry.state).toBe('todo');
      expect(entry.detail).toBe('Start Olympus to check this.');
    }
    expect(checklist).toMatchObject({ done: 0, total: 7 });
  });

  test('names that look like credentials never reach the checklist', () => {
    const checklist = buildSetupChecklist({
      ...ALL_DONE,
      aiApps: ['olympus_conn_0123456789abcdef0123456789abcdef', 'Bearer abc.def', 'dash_abcdefghijkl', 'Claude'],
      sources: [{ id: 'gmail.email', name: 'sk-abcdefghijklmnop', state: 'connected' }],
      messaging: [{ name: 'A'.repeat(40), paired: true, chatsChosen: true }],
    });
    expectNoLeak(checklist);
    expect(step(checklist, 'ai_app').detail).toBe('An agent and Claude');
  });

  test('read back from the worker: only known fields survive, and odd links or commands are refused', () => {
    const good = buildSetupChecklist(ALL_DONE);
    const tampered = JSON.parse(JSON.stringify(good));
    tampered.token = 'secret-token';
    tampered.steps[0].worker_token = 'secret-token';
    tampered.steps[3].sources[0].token = 'secret-token';
    const parsed = parseSetupChecklist(tampered);
    expect(parsed).toEqual(good);
    expectNoLeak(parsed);
    const badLink = JSON.parse(JSON.stringify(good));
    badLink.steps[1].forward.link = 'https://evil.example/?token=secret-token';
    expect(parseSetupChecklist(badLink)).toBeUndefined();
    const badCommand = JSON.parse(JSON.stringify(good));
    badCommand.steps[0].forward = { kind: 'command', command: 'rm -rf ~' };
    expect(parseSetupChecklist(badCommand)).toBeUndefined();
    expect(parseSetupChecklist({ kind: 'something_else', steps: [] })).toBeUndefined();
  });

  test('the readable form says which steps the agent may run and which need the owner', () => {
    const text = renderSetupChecklistText(buildSetupChecklist(RUNNING_EMPTY));
    expect(text.split('\n')[0]).toBe('Setup: 1 of 6 done');
    expect(text).toContain('Next: Choose how Private items are answered');
    expect(text).toContain('You can run this: olympus source index status');
    expect(text).toContain('Needs the owner: /dashboard?keys#private-routing');
    expect(text).toContain(SETUP_OWNER_WHY.privacy);
  });
});

function card(sourceId: string, label: string, overrides: Record<string, unknown> = {}): DashboardSourceCard {
  return {
    source_id: sourceId,
    label,
    connection: { state: 'not_connected', label: '', action: { kind: 'none' }, handles: [] },
    coverage: { indexed_items: 0, content_ready_items: 0, embedded_items: 0, needs_review_items: 0 },
    ...overrides,
  } as unknown as DashboardSourceCard;
}

function view(sources: DashboardSourceCard[]): SourceDashboardViewModel {
  return { kind: 'source_dashboard', sources } as unknown as SourceDashboardViewModel;
}

const connected = (extra: Record<string, unknown> = {}) => ({ connection: { state: 'synced', label: '', action: { kind: 'none' }, handles: [] }, ...extra });

describe('the worker reads the facts the dashboard reads', () => {
  const worker = { version: '1.5.0', privateAnswers: { chosen: true, label: 'Venice' }, judge: { chosen: true, choice: 'local' as const, limitDollars: 0 }, aiApps: [] };

  test('sources by name and state; a model key and the imports row are not sources', () => {
    const facts = setupFactsFromView(view([
      card('gmail.email', 'Gmail', { ...connected(), coverage: { indexed_items: 7 } }),
      card('dropbox.files', 'Dropbox', { connection: { state: 'reauth_required', label: '', action: { kind: 'oauth' }, handles: [] } }),
      card('google.drive', 'Google Drive', { ...connected(), scope_selection: { required: true, status: 'scope_pending', connected: true } }),
      card('readwise.highlights', 'Readwise'),
      card('venice.api', 'Venice', connected()),
      card('archive.imports', 'Archives', connected()),
    ]), worker);
    expect(facts.sources).toEqual([
      { id: 'gmail.email', name: 'Gmail', state: 'connected' },
      { id: 'dropbox.files', name: 'Dropbox', state: 'needs_you' },
      { id: 'google.drive', name: 'Google Drive', state: 'needs_you' },
      { id: 'readwise.highlights', name: 'Readwise', state: 'skipped' },
    ]);
    expect(facts.findableItems).toBe(7);
  });

  test('an import-only source counts once its import landed, and is left out before (#1127)', () => {
    const imported = setupFactsFromView(view([
      card('chatgpt.conversations', 'ChatGPT', { connection: { state: 'connected', label: '', action: { kind: 'archive_import' }, handles: [] }, coverage: { indexed_items: 4 } }),
      card('claude.conversations', 'Claude', { connection: { state: 'not_connected', label: '', action: { kind: 'archive_import' }, handles: [] } }),
    ]), worker);
    expect(imported.sources).toEqual([{ id: 'chatgpt.conversations', name: 'ChatGPT', state: 'connected' }]);
    expect(step(buildSetupChecklist(imported), 'sources').state).toBe('done');
  });

  test('a paired chat app counts its chats chosen only once capture was approved', () => {
    const paired = setupChecklistFromView(view([card('whatsapp.personal.messages', 'WhatsApp', connected())]), worker);
    expect(step(paired, 'messaging_chats')).toMatchObject({ state: 'next', title: 'Choose your WhatsApp chats' });
    const chosen = setupChecklistFromView(view([card('whatsapp.personal.messages', 'WhatsApp', connected({ capture: { scope: { kind: 'chats', count: 3 } } }))]), worker);
    expect(step(chosen, 'messaging_chats').state).toBe('done');
    // A native capture service reports no scope to the worker; a captured message shows its chats were approved.
    const native = setupChecklistFromView(view([card('telegram.messages', 'Telegram', connected({ freshness: { label: '', stale: false, capture: { state: 'fresh', age_seconds: 60, threshold_seconds: 3600 } } }))]), worker);
    expect(step(native, 'messaging_chats').state).toBe('done');
    const nothingYet = setupChecklistFromView(view([card('telegram.messages', 'Telegram', connected({ freshness: { label: '', stale: false, capture: { state: 'awaiting', threshold_seconds: 3600 } } }))]), worker);
    expect(step(nothingYet, 'messaging_chats').state).toBe('next');
    const unpaired = setupChecklistFromView(view([card('telegram.messages', 'Telegram')]), worker);
    expect(step(unpaired, 'messaging_chats').state).toBe('skipped');
  });

  test('no view: sources, chats and items stay unknown rather than skipped', () => {
    const checklist = setupChecklistFromView(undefined, worker);
    expect(step(checklist, 'sources').detail).toBe('Start Olympus to check this.');
    expect(step(checklist, 'messaging_chats').state).not.toBe('skipped');
    expect(step(checklist, 'first_items').state).not.toBe('done');
  });

  test('the first-run choice, the judge record and active connections, from their own stores', () => {
    const judge = (record: boolean) => ({ hasRecord: () => record, status: () => ({ choice: 'venice' as const, capDollars: 5, spentDollars: 0, remainingDollars: 5, stop: null }) });
    const connections = () => ({
      list: () => [
        { displayName: 'ChatGPT', revokedAt: null },
        { displayName: 'Old laptop', revokedAt: '2026-11-01T00:00:00Z' },
        { displayName: 'olympus_conn_0123456789abcdef0123456789abcdef', revokedAt: null },
      ] as never,
    });
    const pending = readSetupWorkerFacts({ version: '1.5.0', policy: { config: createPendingPrivacyPolicy() }, judge: judge(false), connections });
    expect(pending.privateAnswers).toEqual({ chosen: false });
    expect(pending.judge).toEqual({ chosen: false, choice: 'venice', limitDollars: 5 });
    expect(pending.aiApps).toEqual(['ChatGPT', 'olympus_conn_0123456789abcdef0123456789abcdef']);
    const chosen = readSetupWorkerFacts({ version: '1.5.0', policy: { config: loadSovereigntyPreset('local-first') }, judge: judge(true), connections, hostAgent: 'OpenClaw' });
    expect(chosen.privateAnswers).toEqual({ chosen: true, label: 'Local models with Venice fallback' });
    expect(chosen.judge?.chosen).toBe(true);
    expect(chosen.aiApps?.[0]).toBe('OpenClaw');
    const checklist = buildSetupChecklist(setupFactsFromView(view([]), chosen));
    expectNoLeak(checklist);
    expect(step(checklist, 'ai_app').detail).toBe('OpenClaw, ChatGPT and An agent');
    // A connection store that cannot be read leaves the host agent and nothing else.
    const broken = readSetupWorkerFacts({ version: '1.5.0', policy: { config: loadSovereigntyPreset('local-first') }, connections: () => { throw new Error('locked'); }, hostAgent: 'OpenClaw' });
    expect(broken.aiApps).toEqual(['OpenClaw']);
  });
});

describe('olympus setup status reads the running Olympus', () => {
  const env = { HOME: '/nonexistent-olympus-home', OLYMPUS_WORKER_AUTH_TOKEN: 'worker-token-for-test', OLYMPUS_EMAIL_WORKER_URL: 'http://127.0.0.1:9' };

  test('nothing answers: installed is next and the rest is unknown', async () => {
    const fetchImpl = (async () => { throw new Error('connection refused'); }) as unknown as typeof fetch;
    const checklist = await readSetupStatus({ env, fetchImpl, version: '1.5.0' });
    expect(checklist.next?.id).toBe('installed');
    expect(checklist.done).toBe(0);
  });

  test('the worker answers: its checklist, read back field by field, with no token in it', async () => {
    const answer = { ...buildSetupChecklist(ALL_DONE), worker_token: 'worker-token-for-test' };
    const fetchImpl = (async (input: string | URL | Request) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.endsWith('/health')) return new Response('{}');
      expect(url).toContain('/cli/setup-status');
      return Response.json(answer);
    }) as unknown as typeof fetch;
    const checklist = await readSetupStatus({ env, fetchImpl });
    expect(checklist).toEqual(buildSetupChecklist(ALL_DONE));
    expect(JSON.stringify(checklist)).not.toContain('worker-token-for-test');
  });

  test('a native tool reaches the worker its plugin configuration names, with its token', async () => {
    const bare = { HOME: '/nonexistent-olympus-home' };
    const config = { ...loadConfig(bare), email: { ...loadConfig(bare).email, baseUrl: 'http://127.0.0.1:9911/v1' }, worker: { ...loadConfig(bare).worker, authToken: 'plugin-config-token' } };
    const seen: { url: string; auth: string | null }[] = [];
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      seen.push({ url, auth: new Headers(init?.headers).get('authorization') });
      if (url.endsWith('/health')) return new Response('{}');
      return Response.json(buildSetupChecklist(ALL_DONE));
    }) as unknown as typeof fetch;
    const checklist = await readSetupStatus({ env: bare, config, fetchImpl });
    expect(checklist).toEqual(buildSetupChecklist(ALL_DONE));
    expect(seen.every((call) => call.url.startsWith('http://127.0.0.1:9911/'))).toBe(true);
    expect(seen.at(-1)?.auth).toBe('Bearer plugin-config-token');
  });
});

describe('"Set up with my agent"', () => {
  test('the brief is the approved mockup wording', () => {
    expect(DASHBOARD_SETUP_AGENT_COPY.brief.split('\n')).toEqual([
      'Help me finish setting up Olympus on this computer.',
      '',
      '1. Run: olympus setup status',
      "   It lists every setup step, what's done, and the one way forward for each.",
      '2. Do the steps marked "you can run this" yourself.',
      '3. For steps marked "needs the owner", give me the link it shows, wait for me, then run setup status again. Don\'t ask me what\'s on screen.',
      "4. To change several settings at once, use olympus settings propose. I'll apply them with one click.",
      '',
      "You can't change what's Private, who has access, or what Olympus spends. Those always need my click in the dashboard.",
    ]);
    expect(DASHBOARD_SETUP_AGENT_COPY.copy).toBe('Copy for my agent');
  });

  test('the host page carries the brief and its Copy button, closed until a read brings the checklist', () => {
    const dialog = setupAgentDialog();
    expect(dialog).toContain('id="setup-with-agent"');
    expect(dialog).toContain('data-setup-agent-copy');
    expect(dialog).toContain('Help me finish setting up Olympus on this computer.');
    expect(dialog).not.toMatch(/<dialog[^>]* open/);
    const page = renderComputerHostPage({ panelHtml: '<p>panel</p>', origin: 'http://127.0.0.1:8787', csrfToken: 'csrf' });
    expect(page).toContain(dialog);
    expect(page).toContain('"metaKey":"olympus/computer"');
  });
});

describe('Home reads the same checklist', () => {
  const fullView = {
    kind: 'source_dashboard', generated_at: new Date(0).toISOString(),
    summary: { configured_sources: 1, connected_sources: 1, answer_ready_sources: 0, needs_attention_sources: 0, total_indexed_items: 4, total_content_ready_items: 0 },
    onboarding: { steps: [], ask_first_question: { enabled: false, label: 'Ask your first question', suggestion: 'x' } },
    answer_lanes: [], where_your_data_lives: [],
    unassigned_corpora: { corpus_count: 0, indexed_items: 0, content_ready_items: 0, entries: [] },
    excluded_by_configuration: { rules: 0, prefixes: 0, items_present: 0, items_unevaluable: 0, entries: [] },
    folder_picker: { available: false, label: 'Choose folders', path: '/dashboard/dispositions', rules: 0 },
    sources: [],
    history: { sample_count: 0, eta_available: false },
    policy: { counts_only: true, raw_source_exposed: false, source_text_returned: false, file_names_returned: false, file_paths_returned: false, host_names_returned: false },
  } as unknown as SourceDashboardViewModel;

  function tools(setupChecklist?: (view: SourceDashboardViewModel | undefined) => SetupChecklist) {
    return createDashboardPanelTools({
      surface: () => ({ dashboardView: async () => fullView }) as never,
      setup: {} as never,
      workerFetch: async () => { throw new Error('no worker routes here'); },
      makeContext: () => ({}) as never,
      indexFasterState: async () => undefined,
      ...(setupChecklist ? { setupChecklist } : {}),
    });
  }

  test('the dashboard result carries the checklist in the computer meta, built from the view it came from', async () => {
    let seen: SourceDashboardViewModel | undefined;
    const built = buildSetupChecklist(ALL_DONE);
    const result = await tools((view) => { seen = view; return built; }).call(DASHBOARD_TOOL_NAME, {}, { origin: 'http://127.0.0.1:8787' });
    expect(seen).toBe(fullView);
    expect((result._meta as Record<string, any>)[COMPUTER_META_KEY].setup).toEqual(built);
  });

  test('a checklist that cannot be built leaves Home as it was', async () => {
    const result = await tools(() => { throw new Error('unreadable'); }).call(DASHBOARD_TOOL_NAME, {}, { origin: 'http://127.0.0.1:8787' });
    expect((result._meta as Record<string, any> | undefined)?.[COMPUTER_META_KEY]?.setup).toBeUndefined();
  });
});
