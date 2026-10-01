/**
 * The ChatGPT dashboard page (`ui://olympus/dashboard`), driven the way
 * ChatGPT drives it: the page's own inline script runs against a happy-dom
 * document whose parent is a fake MCP Apps host (JSON-RPC over postMessage),
 * optionally with `window.openai`.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import { dashboardResourceHtml } from '../src/workers/chatgpt/dashboard-resource.ts';
import type { DashboardViewModelV1 } from '../src/workers/chatgpt/dashboard-contract.ts';
import {
  CHATGPT_DASHBOARD_CSS,
  CHATGPT_DASHBOARD_DARK,
  CHATGPT_DASHBOARD_LIGHT,
  chatgptDashboardPageHtml,
} from '../src/workers/dashboard/chatgpt/page.ts';
import {
  DASHBOARD_CHATGPT_CONNECTION_COPY,
  DASHBOARD_CHATGPT_PAGE_COPY,
  DASHBOARD_CHATGPT_VOCABULARY,
} from '../src/workers/dashboard/vocabulary.ts';

const MIN = 60_000;
const ago = (ms: number) => new Date(Date.now() - ms).toISOString();

function model(overrides: Partial<DashboardViewModelV1> = {}): DashboardViewModelV1 {
  return {
    v: 1,
    connection: { state: 'ready' },
    needsYou: [],
    sources: [],
    models: { embedding: { kind: 'built_in', state: 'ready' } },
    generatedAt: ago(0),
    ...overrides,
  };
}

const SOURCES: DashboardViewModelV1['sources'] = [
  {
    id: 'gmail', label: 'Gmail', group: 'cloud', status: 'Fresh', detail: '1,204 messages', lastSyncAt: ago(5 * MIN),
    menu: [{ label: 'Disconnect', tool: 'olympus_disconnect', args: { source: 'gmail' }, destructive: true }],
  },
  { id: 'notes', label: 'Notes', group: 'local', status: 'Working', lastSyncAt: ago(2 * 60 * MIN) },
  { id: 'drive', label: 'Google Drive', group: 'cloud', status: 'Off', primary: { label: 'Connect', disabledReason: 'Connect sources in Olympus on your Mac.' } },
];

const PROGRESS: NonNullable<DashboardViewModelV1['progress']> = {
  unit: 'files', phase: 'initial', percent: 42.6, itemsLeft: 1204, etaSeconds: 7800, stalled: false,
  details: [
    { stage: 'Reading', unit: 'files', done: 900, total: 2104 },
    { stage: 'Indexing', unit: 'files', done: 600, total: 2104 },
  ],
};

interface Host {
  win: Window;
  sent: Array<{ id?: number; method?: string; params?: any }>;
  openai: Record<string, any> | undefined;
  calls: Array<[string, unknown]>;
  text(): string;
  /** Text outside every <details>. */
  visibleText(): string;
  buttons(): HTMLButtonElement[];
  button(label: string): HTMLButtonElement;
  push(result: unknown): void;
  respond(method: string, result: unknown, error?: unknown): void;
  toolCalls(): Array<{ name: string; arguments: unknown }>;
}

const hosts: Host[] = [];
afterEach(async () => {
  while (hosts.length) await hosts.pop()!.win.happyDOM.close();
});

function mount(options: { openai?: Record<string, any>; timeoutMs?: number; html?: string } = {}): Host {
  const html = options.html ?? chatgptDashboardPageHtml({ resultTimeoutMs: options.timeoutMs ?? 5_000 });
  const start = html.indexOf('<script>') + '<script>'.length;
  const script = html.slice(start, html.indexOf('</script>', start));
  const win = new Window({ url: 'https://sandbox.test/' });
  // The page without its script (happy-dom does not evaluate it), then the
  // script itself, run against this window.
  win.document.write(html.slice(0, start - '<script>'.length) + html.slice(html.indexOf('</script>', start) + '</script>'.length));
  const sent: Host['sent'] = [];
  const calls: Host['calls'] = [];
  const parent = { postMessage: (message: any) => sent.push(message) };
  Object.defineProperty(win, 'parent', { value: parent, configurable: true });
  let openai: Host['openai'];
  if (options.openai) {
    openai = {
      ...options.openai,
      notifyIntrinsicHeight: (height: number) => calls.push(['notifyIntrinsicHeight', height]),
      requestDisplayMode: (args: unknown) => calls.push(['requestDisplayMode', args]),
      openExternal: (args: unknown) => calls.push(['openExternal', args]),
    };
    (win as any).openai = openai;
  }
  new Function('window', 'document', script)(win, win.document);
  const dispatch = (data: unknown) => win.dispatchEvent(new win.MessageEvent('message', { data, source: parent as any }));
  const host: Host = {
    win,
    sent,
    openai,
    calls,
    text: () => win.document.getElementById('app')!.textContent ?? '',
    visibleText: () => {
      const clone = win.document.getElementById('app')!.cloneNode(true) as unknown as HTMLElement;
      for (const box of Array.from(clone.querySelectorAll('details'))) box.remove();
      return clone.textContent ?? '';
    },
    buttons: () => Array.from(win.document.querySelectorAll('#app button')) as unknown as HTMLButtonElement[],
    button: (label: string) => {
      const found = host.buttons().find((node) => node.textContent === label);
      if (!found) throw new Error(`no button "${label}" in: ${host.buttons().map((b) => b.textContent).join(' | ')}`);
      return found;
    },
    push: (result) => dispatch({ jsonrpc: '2.0', method: 'ui/notifications/tool-result', params: result }),
    respond: (method, result, error) => {
      const request = [...sent].reverse().find((message) => message.method === method && message.id !== undefined);
      if (!request) throw new Error(`no ${method} request`);
      dispatch(error ? { jsonrpc: '2.0', id: request.id, error } : { jsonrpc: '2.0', id: request.id, result });
    },
    toolCalls: () => sent.filter((message) => message.method === 'tools/call').map((message) => message.params),
  };
  hosts.push(host);
  return host;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const JARGON = ['lane', 'guard', 'supervisor', 'chunk', 'epoch', 'reauth', 'embed'];

function expectNoJargon(host: Host) {
  const text = host.visibleText().toLowerCase();
  for (const word of JARGON) expect(text).not.toContain(word);
}

describe('page source', () => {
  const html = dashboardResourceHtml();

  test('is one self-contained page with no external origin and no sandbox-blocked API', () => {
    expect(html.startsWith('<!doctype html>')).toBe(true);
    expect(html).toContain('tools/call');
    for (const banned of ['http://', 'https://', 'window.confirm', 'confirm(', 'alert(', 'prompt(', 'navigator.clipboard',
      'console.', 'localStorage', '<link', ' src=', '@import', 'url(', 'gradient', '@font-face']) {
      expect(html).not.toContain(banned);
    }
  });

  test('has no nested scrolling anywhere', () => {
    expect(CHATGPT_DASHBOARD_CSS).not.toContain('overflow:auto');
    expect(CHATGPT_DASHBOARD_CSS).not.toContain('overflow:scroll');
    expect(CHATGPT_DASHBOARD_CSS).not.toContain('overflow-y');
    expect(CHATGPT_DASHBOARD_CSS).toContain(':focus-visible');
    expect(CHATGPT_DASHBOARD_CSS).toContain('font-family:system-ui');
  });

  test('every text pair clears WCAG AA in light and dark', () => {
    for (const palette of [CHATGPT_DASHBOARD_LIGHT, CHATGPT_DASHBOARD_DARK]) {
      const pairs: Array<[string, string]> = [
        [palette.text, palette.bg], [palette.muted, palette.bg], [palette.muted, palette.surface],
        [palette.text, palette.warnBg], [palette.muted, palette.warnBg], [palette.text, palette.infoBg],
        [palette.muted, palette.infoBg], [palette.onAccent, palette.accent], [palette.danger, palette.bg],
        [palette.bg, palette.warnLine], [palette.bg, palette.infoLine],
      ];
      for (const [fg, bg] of pairs) expect(contrast(fg, bg)).toBeGreaterThanOrEqual(4.5);
      // In progress (yellow) and needs you (orange) are never the only signal, so they are exempt from 3:1.
      for (const tone of [palette.good, palette.bad, palette.off, palette.focus]) {
        expect(contrast(tone, palette.bg)).toBeGreaterThanOrEqual(3);
      }
    }
  });

  test('status tones: in progress is a clear yellow, needs you a warm orange, both distinct from ready and failing', () => {
    expect([CHATGPT_DASHBOARD_LIGHT.run, CHATGPT_DASHBOARD_DARK.run]).toEqual(['#f5c518', '#facc15']);
    expect([CHATGPT_DASHBOARD_LIGHT.warn, CHATGPT_DASHBOARD_DARK.warn]).toEqual(['#ea6c0a', '#fb8c3c']);
    for (const palette of [CHATGPT_DASHBOARD_LIGHT, CHATGPT_DASHBOARD_DARK]) {
      const run = hue(palette.run);
      const warn = hue(palette.warn);
      expect(run).toBeGreaterThanOrEqual(44);
      expect(run).toBeLessThanOrEqual(56);
      expect(warn).toBeGreaterThanOrEqual(20);
      expect(warn).toBeLessThanOrEqual(32);
      // Bright, not brown: high lightness and saturation.
      expect(lightness(palette.run)).toBeGreaterThan(0.5);
      expect(lightness(palette.warn)).toBeGreaterThan(0.45);
      for (const other of [palette.good, palette.bad]) expect(Math.abs(hue(other) - warn)).toBeGreaterThan(10);
    }
    // The in-progress bar fills yellow; a stalled source's bar stays orange.
    expect(CHATGPT_DASHBOARD_CSS).toContain('.bar-fill{height:100%;border-radius:999px;background:var(--run);min-width:0}');
    expect(CHATGPT_DASHBOARD_CSS).toContain('.source-progress.stalled .bar-fill{background:var(--warn)}');
    // Off stays a hollow ring.
    expect(CHATGPT_DASHBOARD_CSS).toContain('.tone-line{background:transparent;border:2px solid var(--idle)}');
  });
});

describe('vocabulary', () => {
  test('the producer\'s strings live in vocabulary.ts', () => {
    expect(DASHBOARD_CHATGPT_VOCABULARY).toMatchObject({
      installingNoSource: 'Connect a source to begin',
      installingModel: 'Getting search ready on your Mac',
      installingFirstIndex: 'Indexing your sources for the first time',
      stageReading: 'Reading',
      stageSearchable: 'Indexing',
      embeddingNeedsAttention: 'Search has stopped working on your Mac.',
      answerModelNeedsAttention: 'Answers have stopped working on your Mac.',
      openOnMac: 'Open Olympus on your Mac',
      changeModelsOnMac: 'Change models in Olympus on your Mac.',
    });
  });
});

describe('connection states', () => {
  test('not installed: one banner, Install on your Mac, everything else disabled with a reason', () => {
    const host = mount();
    host.push({ structuredContent: model({ connection: { state: 'not_installed', action: { id: 'install' } }, sources: SOURCES }) });
    expect(host.text()).toContain(DASHBOARD_CHATGPT_CONNECTION_COPY.not_installed.title);
    const install = host.button('Install on your Mac');
    expect(install.disabled).toBe(false);
    expect(install.className).toContain('primary');
    install.click();
    // No link: the help is selectable text, never the clipboard.
    expect(host.text()).toContain('Install Olympus on my Mac.');
    for (const other of host.buttons().filter((node) => node !== host.button('Install on your Mac'))) {
      expect(other.disabled).toBe(true);
    }
    expect(host.text()).toContain(DASHBOARD_CHATGPT_CONNECTION_COPY.not_installed.disabledReason);
    expectNoJargon(host);
  });

  test('installing: progress label and percent, no button', () => {
    const host = mount();
    host.push({ structuredContent: model({ connection: { state: 'installing', progress: { percent: 37.4, label: 'Getting search ready on your Mac' } } }) });
    const banner = host.win.document.querySelector('.banner')!;
    expect(banner.textContent).toContain('Installing Olympus on your Mac…');
    expect(banner.textContent).toContain('Getting search ready on your Mac · 37%');
    expect(banner.querySelectorAll('button').length).toBe(0);
    expect(banner.querySelector('[role=progressbar]')!.getAttribute('aria-valuenow')).toBe('37');
  });

  test('mac offline: last seen and its action, opened through openExternal', () => {
    const host = mount({ openai: {} });
    host.push({
      structuredContent: model({
        connection: { state: 'mac_offline', lastSeenAt: ago(2 * 60 * MIN + 5 * MIN), action: { id: 'wake_mac', href: 'https://olympusplugin.ai/help/awake' } },
      }),
    });
    expect(host.text()).toContain('Your Mac is offline or asleep, so answers are paused');
    expect(host.text()).toContain('Last seen 2 hr ago');
    host.button('How to keep it available').click();
    expect(host.calls).toContainEqual(['openExternal', { href: 'https://olympusplugin.ai/help/awake' }]);
  });

  test('a link without window.openai goes through ui/open-link', () => {
    const host = mount();
    host.push({ structuredContent: model({ connection: { state: 'mac_offline', action: { id: 'open_olympus', href: 'https://olympusplugin.ai/open' } } }) });
    host.button('Open Olympus on your Mac').click();
    expect(host.sent.find((message) => message.method === 'ui/open-link')!.params).toEqual({ url: 'https://olympusplugin.ai/open' });
  });

  test('relay unavailable when a tools/call fails, and Try again re-calls the dashboard tool', async () => {
    const host = mount();
    host.push({ structuredContent: model({ needsYou: [{ id: 'source:gmail', sentence: 'Gmail — signed out', fix: { label: 'Check again', tool: 'olympus_dashboard', args: {} } }] }) });
    host.button('Check again').click();
    expect(host.button('Working…').disabled).toBe(true);
    host.respond('tools/call', undefined, { code: -32000, message: 'unreachable' });
    await sleep(0);
    expect(host.text()).toContain(DASHBOARD_CHATGPT_CONNECTION_COPY.relay_unavailable.title);
    // Old data stays visible, but its controls wait.
    expect(host.text()).toContain('Gmail — signed out');
    expect(host.buttons().filter((node) => !node.disabled).map((node) => node.textContent)).toEqual(['Try again']);
    host.button('Try again').click();
    expect(host.toolCalls().at(-1)).toEqual({ name: 'olympus_dashboard', arguments: {} });
    host.respond('tools/call', { structuredContent: model() });
    await sleep(0);
    expect(host.text()).not.toContain(DASHBOARD_CHATGPT_CONNECTION_COPY.relay_unavailable.title);
    expect(host.text()).toContain('Olympus');
  });

  test('relay unavailable when no result arrives in time', async () => {
    const host = mount({ timeoutMs: 20 });
    expect(host.text()).toContain('Checking your Mac…');
    await sleep(40);
    expect(host.text()).toContain(DASHBOARD_CHATGPT_CONNECTION_COPY.relay_unavailable.title);
    expect(host.button('Try again').disabled).toBe(false);
  });

  test('an error tool result is relay unavailable too', () => {
    const host = mount();
    host.push({ isError: true, content: [{ type: 'text', text: 'Your Mac is offline' }] });
    expect(host.text()).toContain(DASHBOARD_CHATGPT_CONNECTION_COPY.relay_unavailable.title);
  });
});

describe('ready page', () => {
  test('blocker, needs-you, sources, progress and models in that order', () => {
    const host = mount();
    host.push({
      structuredContent: model({
        blocker: { id: 'model:embedding', sentence: 'Search has stopped working on your Mac.', fix: { label: 'Open Olympus on your Mac', disabledReason: 'Open Olympus on your Mac to fix this.' } },
        needsYou: [
          { id: 'source:gmail', sentence: 'Gmail — signed out', fix: { label: 'Reconnect', disabledReason: 'Open Olympus on your Mac to fix this.' } },
          { id: 'model:answers', sentence: 'Answers are not working on your Mac', fix: { label: 'Open Olympus on your Mac', disabledReason: 'Open Olympus on your Mac to fix this.' } },
          { id: 'account', sentence: 'Olympus needs an update', fix: { label: 'Check again', tool: 'olympus_dashboard', args: {} } },
        ],
        sources: SOURCES,
        progress: PROGRESS,
        models: { embedding: { kind: 'built_in', state: 'ready' }, answers: { kind: 'venice', label: 'Venice', ready: true }, change: { label: 'Change', tool: 'olympus_models', args: {} } },
      }),
    });
    const text = host.text();
    const order = ['Search has stopped working', 'Needs you', 'Answers are not working', 'Sources', 'On your Mac', 'Notes', 'Accounts', 'Gmail', 'Signed out', 'Progress', 'Models — Built-in · Ready'];
    let at = -1;
    for (const marker of order) {
      const next = text.indexOf(marker, at + 1);
      expect(next).toBeGreaterThan(at);
      at = next;
    }
    expect(host.win.document.querySelectorAll('.banner').length).toBe(1);
    // Each needs-you row: one sentence, one control; a disabled one says why beside itself.
    const rows = Array.from(host.win.document.querySelectorAll('.need'));
    expect(rows.map((row) => row.querySelectorAll('button').length)).toEqual([1, 1]);
    // Gmail's item lives only in its own row, first in its group, with an amber dot and one control.
    expect(host.win.document.querySelector('.need')!.parentElement!.textContent).not.toContain('Gmail');
    const gmail = host.win.document.querySelector('.row.source.need-row')!;
    expect(gmail.querySelector('.source-name')!.textContent).toBe('Gmail');
    expect(gmail.querySelector('.dot')!.className).toBe('dot tone-warn');
    expect(gmail.querySelectorAll('.source-actions button').length).toBe(1);
    expect(text.split('signed out').length + text.split('Signed out').length).toBe(3);
    expect(rows[0]!.textContent).toContain('Open Olympus on your Mac to fix this.');
    expect((rows[0]!.querySelector('button') as unknown as HTMLButtonElement).disabled).toBe(true);
    // Only one accent button on the page.
    expect(host.win.document.querySelectorAll('.btn.primary').length).toBe(1);
    expectNoJargon(host);
  });

  test('sources: status word, detail, relative last sync, one primary, secondary actions in a ⋯ menu', () => {
    const host = mount();
    host.push({ structuredContent: model({ sources: SOURCES }) });
    const rows = Array.from(host.win.document.querySelectorAll('.source'));
    expect(rows.map((row) => row.querySelector('.source-name')!.textContent)).toEqual(['Notes', 'Gmail', 'Google Drive']);
    expect(rows[2]!.className).toBe('row source mac');
    expect(rows[0]!.textContent).toContain('Working');
    expect(rows[0]!.textContent).toContain('Synced 2 hr ago');
    expect(rows[1]!.textContent).toContain('1,204 messages · Synced 5 min ago');
    const menu = rows[1]!.querySelector('details.menu')!;
    expect(menu.querySelector('summary')!.textContent).toContain('More actions for Gmail');
    expect(menu.querySelector('button')!.textContent).toBe('Disconnect');
    expect(rows[2]!.textContent).toBe('Google Drive');
  });

  test('a connecting source is one row with one button, and Check again appears once on the page', () => {
    const host = mount();
    const waiting = 'waiting for you to approve in the Gmail tab · expires in 9m';
    host.push({ structuredContent: model({
      needsYou: [{ id: 'source:gmail.email', sentence: `Gmail — ${waiting}`, fix: { label: 'Check again', tool: 'olympus_dashboard', args: {} } }],
      sources: [{ id: 'gmail.email', label: 'Gmail', group: 'cloud', status: 'Needs you', detail: waiting }],
    }) });
    const doc = host.win.document;
    expect(doc.querySelector('.row.need')).toBeNull();
    expect(host.text()).not.toContain('Needs you' + 'Gmail');
    const row = doc.querySelector('.row.source')!;
    expect(row.querySelectorAll('button').length).toBe(1);
    expect(Array.from(doc.querySelectorAll('button')).filter((node) => node.textContent === 'Check again').length).toBe(1);
    expect(host.text().toLowerCase().split(waiting.toLowerCase()).length).toBe(2);
  });

  test('Mac-only sources group under one heading and sentence, with no buttons; connectable rows are outlined', () => {
    const host = mount();
    const onMac = (id: string, label: string) => ({ id, label, group: 'cloud' as const, status: 'Off' as const, detail: 'not connected',
      primary: { label: 'Connect', tool: 'olympus_dashboard', args: {}, disabledReason: 'Connect sources in Olympus on your Mac.' } });
    host.push({ structuredContent: model({
      needsYou: [{ id: 'source:gmail.email', sentence: 'Gmail — choose mail', fix: { label: 'Choose mail', tool: 'olympus_scope_list', args: { source_id: 'gmail.email' } } }],
      sources: [
        onMac('x.bookmarks', 'X'),
        { id: 'gmail.email', label: 'Gmail', group: 'cloud', status: 'Off', detail: 'not connected', primary: { label: 'Connect', tool: 'olympus_connect_source', args: { source: 'gmail' } } },
        { id: 'dropbox.files', label: 'Dropbox', group: 'cloud', status: 'Off', primary: { label: 'Connect', tool: 'olympus_connect_source', args: { source: 'dropbox' } } },
        onMac('telegram', 'Telegram'), onMac('whatsapp', 'WhatsApp'), onMac('readwise.library', 'Readwise'),
        { id: 'x2', label: 'Readwise (connected)', group: 'cloud', status: 'Fresh', primary: { label: 'Check', disabledReason: 'Connect sources in Olympus on your Mac.' } },
      ],
    }) });
    const doc = host.win.document;
    const mac = doc.querySelector('.rows.mac-only')!;
    expect(Array.from(mac.querySelectorAll('.source-name')).map((node) => node.textContent)).toEqual(['X', 'Telegram', 'WhatsApp', 'Readwise']);
    expect(mac.querySelectorAll('button').length).toBe(0);
    expect(mac.previousElementSibling!.textContent).toBe(DASHBOARD_CHATGPT_PAGE_COPY.sourcesOnMacHelp);
    expect(mac.previousElementSibling!.previousElementSibling!.textContent).toBe(DASHBOARD_CHATGPT_PAGE_COPY.sourcesOnMac);
    expect(host.text().split('Connect sources in Olympus on your Mac.').length).toBeLessThanOrEqual(2);
    // A connected source stays in its group even with a disabled fix.
    expect(mac.textContent).not.toContain('connected)');
    // No page-level action here (Gmail's item is in its row), so no accent at all; never on a source row.
    expect(doc.querySelectorAll('.btn.primary').length).toBe(0);
    expect(doc.querySelector('.section h2')!.textContent).toBe('Sources');
    // Not connected is said once: no status word beside the name.
    const gmail = Array.from(doc.querySelectorAll('.row.source')).find((row) => row.querySelector('.source-name')!.textContent === 'Gmail')!;
    expect(gmail.querySelector('.status')).toBeNull();
    expect(gmail.textContent).toBe('Gmail — Needs youChoose mailChoose mail');
    expect(gmail.querySelectorAll('button').length).toBe(1);
    const dropbox = Array.from(doc.querySelectorAll('.row.source')).find((row) => row.querySelector('.source-name')!.textContent === 'Dropbox')!;
    expect(dropbox.textContent).toContain('Not connected');
    expect(dropbox.textContent!.match(/Off|not connected/g)).toBeNull();
  });

  test('a destructive fix confirms inline in its row before it runs', async () => {
    const host = mount();
    host.push({ structuredContent: model({ sources: SOURCES }) });
    host.button('Disconnect').click();
    expect(host.toolCalls()).toEqual([]);
    expect(host.text()).toContain('Are you sure?');
    host.button('Cancel').click();
    expect(host.text()).not.toContain('Are you sure?');
    host.button('Disconnect').click();
    host.button('Yes, disconnect').click();
    expect(host.toolCalls()).toEqual([{ name: 'olympus_disconnect', arguments: { source: 'gmail' } }]);
    // A non-dashboard result re-fetches the dashboard.
    host.respond('tools/call', { content: [{ type: 'text', text: 'done' }] });
    await sleep(0);
    expect(host.toolCalls().at(-1)).toEqual({ name: 'olympus_dashboard', arguments: {} });
  });

  test('a fix that returns the dashboard re-renders from it', async () => {
    const host = mount();
    host.push({ structuredContent: model({ needsYou: [{ id: 'x', sentence: 'Notes — paused', fix: { label: 'Check again', tool: 'olympus_dashboard', args: {} } }] }) });
    host.button('Check again').click();
    host.respond('tools/call', { structuredContent: model() });
    await sleep(0);
    expect(host.text()).not.toContain('Notes — paused');
    expect(host.toolCalls().length).toBe(1);
  });

  test('progress: percent, items left in the unit, ETA, stage detail only under Details', () => {
    const host = mount();
    host.push({ structuredContent: model({ progress: PROGRESS }) });
    expect(host.text()).toContain('First index: 42% done, 1,204 files left, about 2 hr 10 min');
    const box = host.win.document.querySelector('details.disclosure')!;
    expect(box.querySelector('summary')!.textContent).toBe('Details');
    expect(box.textContent).toContain('Reading: 900 of 2,104 files');
    expect(host.visibleText()).not.toContain('Reading:');
  });

  test('progress without an ETA, and stalled', () => {
    const host = mount();
    const { etaSeconds: _eta, ...noEta } = PROGRESS;
    host.push({ structuredContent: model({ progress: { ...noEta, phase: 'refresh', itemsLeft: 1, unit: 'messages' } }) });
    expect(host.text()).toContain('Catching up: 42% done, 1 message left');
    expect(host.text()).not.toContain('about');
    host.push({ structuredContent: model({ progress: { ...PROGRESS, stalled: true } }) });
    expect(host.text()).toContain('First index: 42% done, 1,204 files left, stalled');
  });

  test('progress pauses while the Mac is unreachable: percent only, no items left, no ETA', async () => {
    const paused = `First index: 42% done, ${DASHBOARD_CHATGPT_PAGE_COPY.progressPaused}`;
    for (const connection of [{ state: 'mac_offline' }, { state: 'relay_unavailable' }] as const) {
      const host = mount();
      host.push({ structuredContent: model({ connection, progress: { ...PROGRESS, stalled: true } }) });
      const line = host.win.document.querySelector('.progress-line')!;
      expect(line.textContent).toBe(paused);
      expect(line.className).not.toContain('stalled');
      expect(host.text()).not.toContain('files left');
      expect(host.text()).not.toContain('about 2 hr');
      expect(host.win.document.querySelector('[role=progressbar]')!.getAttribute('aria-valuenow')).toBe('42');
    }
    // A relay that stops answering pauses progress already on screen.
    const host = mount();
    host.push({ structuredContent: model({ sources: SOURCES, progress: PROGRESS }) });
    expect(host.text()).toContain('1,204 files left');
    host.button('Disconnect').click();
    host.button('Yes, disconnect').click();
    host.respond('tools/call', undefined, { code: -1, message: 'gone' });
    await sleep(0);
    expect(host.win.document.querySelector('.progress-line')!.textContent).toBe(paused);
    // The inline card says the same.
    const inline = mount({ openai: { toolOutput: model({ connection: { state: 'mac_offline' }, progress: PROGRESS }), displayMode: 'inline' } });
    expect(inline.text()).toContain(paused);
    expect(inline.text()).not.toContain('left');
  });

  test('a source row keeps ⋯ beside the name at every width; status and actions wrap under it', () => {
    const host = mount();
    host.push({ structuredContent: model({ sources: [...SOURCES, { ...SOURCES[2]!, id: 'dropbox', label: 'Dropbox', primary: { label: 'Connect', tool: 'olympus_connect_source', args: { source: 'dropbox' } }, menu: SOURCES[0]!.menu! }] }) });
    const row = (label: string) => Array.from(host.win.document.querySelectorAll('.source'))
      .find((node) => node.querySelector('.source-name')!.textContent === label)!;
    const gmail = row('Gmail');
    expect(gmail.className).toBe('row source has-menu');
    expect(Array.from(gmail.children).map((node) => node.className)).toEqual(['source-main', 'menu']);
    // The status sits in the name's line box, the detail under it, never beside ⋯.
    // No visible status word: the dot carries it, labelled for screen readers.
    expect(gmail.querySelector('.source-main .source-head .status')).toBeNull();
    expect(gmail.querySelector('.source-head .sr')!.textContent).toBe(' — Fresh');
    expect(gmail.querySelector('.dot')!.getAttribute('aria-hidden')).toBe('true');
    const dropbox = row('Dropbox');
    expect(dropbox.className).toBe('row source has-actions has-menu');
    expect(Array.from(dropbox.children).map((node) => node.className)).toEqual(['source-main', 'source-actions', 'menu']);
    expect(dropbox.querySelector('.source-actions details')).toBeNull();
    expect(row('Notes').className).toBe('row source');
    // ⋯ is pinned to the last column of the first row; only the actions span the row when narrow.
    expect(CHATGPT_DASHBOARD_CSS).toContain('.row.source>.menu{grid-column:-2/-1;grid-row:1}');
    expect(CHATGPT_DASHBOARD_CSS).toContain('.row.source>.menu[open]>summary{position:absolute;top:0.75rem;right:0}');
    const narrow = CHATGPT_DASHBOARD_CSS.slice(CHATGPT_DASHBOARD_CSS.indexOf('@media (max-width:30rem)'));
    expect(narrow).toContain('.row.source.has-actions.has-menu{grid-template-columns:minmax(0,1fr) 2.25rem}');
    expect(narrow).toContain('.row.source>.source-actions{grid-column:1/-1');
    expect(narrow.slice(0, narrow.indexOf('}}'))).not.toContain('width:100%');
  });

  test('a needs-you dot has its own column, beside the sentence\'s first line at any text size', () => {
    const host = mount();
    host.push({ structuredContent: model({ needsYou: [{ id: 'x', sentence: 'Notes — paused', fix: { label: 'Check again', tool: 'olympus_dashboard', args: {} } }] }) });
    const row = host.win.document.querySelector('.row.need')!;
    expect(Array.from(row.children).map((node) => node.className)).toEqual(['dot tone-warn', 'need-body']);
    expect(Array.from(row.querySelector('.need-body')!.children).map((node) => node.className)).toEqual(['row-text', 'fix']);
    expect(CHATGPT_DASHBOARD_CSS).toContain('.row.need{display:grid;grid-template-columns:0.625rem minmax(0,1fr);align-items:start');
    expect(CHATGPT_DASHBOARD_CSS).toContain('.need-body{display:flex;flex-wrap:wrap');
  });

  test('models stay collapsed and summarize readiness', () => {
    const host = mount();
    host.push({ structuredContent: model({ models: { embedding: { kind: 'built_in', state: 'downloading', percent: 12 }, answers: { kind: 'local', label: 'Local models', ready: false } } }) });
    const box = host.win.document.querySelector('details.models') as unknown as HTMLDetailsElement;
    expect(box.open).toBe(false);
    expect(box.querySelector('summary')!.textContent).toBe('Models — Built-in · Getting ready');
    expect(box.textContent).toContain('Search: Built-in · Downloading 12%');
    expect(box.textContent).toContain('Answers: Local models · Not ready');
    // Without byte counts the install line names the percent only, under the summary, not inside it.
    const lines = Array.from(host.win.document.querySelectorAll('.model-install')).map((node) => node.textContent);
    expect(lines).toEqual(['Downloading the search model · 12%']);
    expect(box.querySelector('.model-install')).toBeNull();
  });

  describe('model installs', () => {
    // The install fields arrive with the backend's ModelInstall contract; read here as optional.
    const withModels = (models: Record<string, unknown>) => model({ models } as any);
    const summary = (host: Host) => host.win.document.querySelector('details.models summary')!.textContent;
    const lines = (host: Host) => Array.from(host.win.document.querySelectorAll('.model-install')).map((node) => node.querySelector('p')!.textContent);

    test('downloading: one line per model with percent and bytes, and a thin yellow bar, without expanding', () => {
      const host = mount();
      host.push({ structuredContent: withModels({
        embedding: { kind: 'built_in', state: 'downloading', percent: 40, bytesDone: 1_200_000_000, bytesTotal: 3_000_000_000 },
        answers: { kind: 'built_in', label: 'Built-in', ready: false, install: { state: 'downloading', percent: 5.6, bytesDone: 230_000_000, bytesTotal: 4_100_000_000 } },
      }) });
      expect(summary(host)).toBe('Models — Built-in · Getting ready');
      expect(lines(host)).toEqual([
        'Downloading the search model · 40% · 1.2 of 3.0 GB',
        'Downloading the private model · 5% · 0.2 of 4.1 GB',
      ]);
      const bars = Array.from(host.win.document.querySelectorAll('.model-install .bar')) as unknown as HTMLElement[];
      expect(bars.map((bar) => bar.getAttribute('aria-valuenow'))).toEqual(['40', '5']);
      expect((bars[0]!.querySelector('.bar-fill') as unknown as HTMLElement).style.width).toBe('40%');
      expect(CHATGPT_DASHBOARD_CSS).toContain('.model-install .bar{height:0.375rem}');
      expect((host.win.document.querySelector('details.models') as unknown as HTMLDetailsElement).open).toBe(false);
      expectNoJargon(host);
    });

    test('verifying reads Checking, with a bar only when the percent is known', () => {
      const host = mount();
      host.push({ structuredContent: withModels({
        embedding: { kind: 'built_in', state: 'ready' },
        answers: { kind: 'built_in', label: 'Built-in', ready: false, install: { state: 'verifying' } },
      }) });
      expect(summary(host)).toBe('Models — Built-in · Getting ready');
      expect(lines(host)).toEqual(['Checking the private model…']);
      expect(host.win.document.querySelector('.model-install .bar')).toBeNull();
      host.push({ structuredContent: withModels({
        embedding: { kind: 'built_in', state: 'verifying', percent: 70 },
      }) });
      expect(lines(host)).toEqual(['Checking the search model…']);
      expect(host.win.document.querySelector('.model-install .bar')!.getAttribute('aria-valuenow')).toBe('70');
    });

    test('a failed install says why, the summary says Needs you, and no second fix button appears', () => {
      const reasons: Array<[string | undefined, string]> = [
        ['disk_full', 'the disk is full'], ['network', 'the connection dropped'], ['checksum', 'the download was damaged'],
        ['unknown', 'something went wrong'], [undefined, 'something went wrong'], ['surprise', 'something went wrong'],
      ];
      for (const [reason, words] of reasons) {
        const host = mount();
        host.push({ structuredContent: withModels({
          embedding: { kind: 'built_in', state: 'ready' },
          answers: { kind: 'built_in', label: 'Built-in', ready: false, install: { state: 'failed', failedReason: reason } },
        }) });
        expect(summary(host)).toBe('Models — Built-in · Needs you');
        expect(lines(host)).toEqual([`Couldn't download the private model: ${words}`]);
        expect(host.win.document.querySelectorAll('.models-wrap button').length).toBe(0);
        expect(host.win.document.querySelector('.model-install .bar')).toBeNull();
      }
    });

    test('both ready: Ready and no install lines', () => {
      const host = mount();
      host.push({ structuredContent: withModels({
        embedding: { kind: 'built_in', state: 'ready' },
        answers: { kind: 'built_in', label: 'Built-in', ready: true, install: { state: 'ready' } },
      }) });
      expect(summary(host)).toBe('Models — Built-in · Ready');
      expect(host.win.document.querySelectorAll('.model-install, .models-wrap').length).toBe(0);
    });
  });

  test('stale data offers Check again', () => {
    const host = mount();
    host.push({ structuredContent: model({ generatedAt: ago(15 * MIN) }) });
    expect(host.text()).toContain('Updated 15 min ago');
    host.button('Check again').click();
    expect(host.toolCalls()).toEqual([{ name: 'olympus_dashboard', arguments: {} }]);
  });

  test('fresh data says nothing about freshness', () => {
    const host = mount();
    host.push({ structuredContent: model({ generatedAt: ago(2 * MIN) }) });
    expect(host.text()).not.toContain('Updated');
  });
});

describe('host integration', () => {
  test('window.openai data, theme and height reporting', () => {
    const host = mount({ openai: { toolOutput: model({ sources: SOURCES }), theme: 'dark', displayMode: 'fullscreen' } });
    expect(host.win.document.documentElement.getAttribute('data-theme')).toBe('dark');
    expect(host.text()).toContain('Gmail');
    expect(host.calls.some(([name]) => name === 'notifyIntrinsicHeight')).toBe(true);
    host.openai!.theme = 'light';
    host.win.dispatchEvent(new host.win.Event('openai:set_globals'));
    expect(host.win.document.documentElement.getAttribute('data-theme')).toBe('light');
  });

  test('the ui/initialize host context sets the theme; size changes are reported', async () => {
    const host = mount();
    host.respond('ui/initialize', { hostContext: { theme: 'dark', displayMode: 'fullscreen' } });
    await sleep(0);
    expect(host.win.document.documentElement.getAttribute('data-theme')).toBe('dark');
    expect(host.sent.some((message) => message.method === 'ui/notifications/initialized')).toBe(true);
    expect(host.sent.some((message) => message.method === 'ui/notifications/size-changed')).toBe(true);
  });

  test('with no host theme the page follows the system colour scheme', () => {
    const host = mount();
    expect(host.win.document.documentElement.hasAttribute('data-theme')).toBe(false);
    expect(CHATGPT_DASHBOARD_CSS).toContain('prefers-color-scheme:dark');
  });

  test('the page never changes its own URL', () => {
    const host = mount();
    host.push({ structuredContent: model({ sources: SOURCES, progress: PROGRESS }) });
    expect(host.win.location.href).toBe('https://sandbox.test/');
  });
});

describe('inline card', () => {
  const fixtures: Array<[string, DashboardViewModelV1]> = [
    ['not installed', model({ connection: { state: 'not_installed', action: { id: 'install' } }, sources: SOURCES })],
    ['mac offline', model({ connection: { state: 'mac_offline', action: { id: 'wake_mac', href: 'https://olympusplugin.ai/a' } }, progress: PROGRESS })],
    ['blocker', model({ blocker: { id: 'b', sentence: 'Search has stopped working on your Mac.', fix: { label: 'Check again', tool: 'olympus_dashboard', args: {} } }, needsYou: [{ id: 'n', sentence: 'Gmail — signed out', fix: { label: 'Reconnect', disabledReason: 'x' } }], sources: SOURCES, progress: PROGRESS })],
    ['needs you', model({ needsYou: [{ id: 'n', sentence: 'Gmail — signed out', fix: { label: 'Disconnect', tool: 't', destructive: true } }], sources: SOURCES })],
    ['all well', model({ sources: SOURCES, progress: { ...PROGRESS, stalled: true } })],
  ];
  for (const [name, data] of fixtures) {
    test(`${name}: at most two buttons, no sections, no disclosures`, () => {
      const host = mount({ openai: { toolOutput: data, displayMode: 'inline' } });
      expect(host.win.document.documentElement.getAttribute('data-mode')).toBe('inline');
      expect(host.buttons().length).toBeLessThanOrEqual(2);
      expect(host.win.document.querySelectorAll('#app details, #app h2, #app .source').length).toBe(0);
      expect(host.button('Open Olympus').disabled).toBe(false);
      expectNoJargon(host);
    });
  }

  test('Open Olympus asks the host for fullscreen; the progress line is shown', () => {
    const host = mount({ openai: { toolOutput: model({ progress: PROGRESS }), displayMode: 'inline' } });
    expect(host.text()).toContain('First index: 42% done');
    host.button('Open Olympus').click();
    expect(host.calls).toContainEqual(['requestDisplayMode', { mode: 'fullscreen' }]);
  });

  test('without window.openai, inline comes from the host context and fullscreen goes over the bridge', async () => {
    const host = mount();
    host.respond('ui/initialize', { hostContext: { displayMode: 'inline', availableDisplayModes: ['inline', 'fullscreen'] } });
    await sleep(0);
    host.push({ structuredContent: model() });
    expect(host.text()).toContain('Olympus is up to date.');
    host.button('Open Olympus').click();
    expect(host.sent.find((message) => message.method === 'ui/request-display-mode')!.params).toEqual({ mode: 'fullscreen' });
  });
});

function rgb(hex: string): [number, number, number] {
  return [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255) as [number, number, number];
}

function hue(hex: string): number {
  const [r, g, b] = rgb(hex);
  const max = Math.max(r, g, b);
  const d = max - Math.min(r, g, b);
  if (!d) return 0;
  const h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return (h * 60 + 360) % 360;
}

function lightness(hex: string): number {
  const [r, g, b] = rgb(hex);
  return (Math.max(r, g, b) + Math.min(r, g, b)) / 2;
}

function contrast(a: string, b: string): number {
  const [la, lb] = [luminance(a), luminance(b)];
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

function luminance(hex: string): number {
  const channel = (offset: number) => {
    const value = parseInt(hex.slice(offset, offset + 2), 16) / 255;
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5);
}
