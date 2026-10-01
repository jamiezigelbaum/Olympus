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
import { PENDING_VOCABULARY } from '../src/workers/chatgpt/dashboard-view-model.ts';
import {
  CHATGPT_DASHBOARD_CSS,
  CHATGPT_DASHBOARD_DARK,
  CHATGPT_DASHBOARD_LIGHT,
  chatgptDashboardPageHtml,
} from '../src/workers/dashboard/chatgpt/page.ts';
import {
  DASHBOARD_CHATGPT_CONNECTION_COPY,
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
      for (const tone of [palette.good, palette.run, palette.warn, palette.bad, palette.off, palette.focus]) {
        expect(contrast(tone, palette.bg)).toBeGreaterThanOrEqual(3);
      }
    }
  });
});

describe('vocabulary', () => {
  test('the producer\'s pending strings live in vocabulary.ts under the same keys', () => {
    expect(Object.keys(DASHBOARD_CHATGPT_VOCABULARY).sort()).toEqual(Object.keys(PENDING_VOCABULARY).sort());
    expect(DASHBOARD_CHATGPT_VOCABULARY).toMatchObject({
      installingNoSource: 'Connect a source to begin',
      installingModel: 'Getting search ready on your Mac',
      installingFirstIndex: 'Indexing your sources for the first time',
      stageReading: 'Reading',
      stageSearchable: 'Indexing',
      embeddingNeedsAttention: 'Search has stopped working on your Mac.',
      answerModelNeedsAttention: 'Answers have stopped working on your Mac.',
      openOnMac: 'Open Olympus on your Mac',
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
          { id: 'source:drive', sentence: 'Google Drive — sync keeps failing', fix: { label: 'Check again', tool: 'olympus_dashboard', args: {} } },
        ],
        sources: SOURCES,
        progress: PROGRESS,
        models: { embedding: { kind: 'built_in', state: 'ready' }, answers: { kind: 'venice', label: 'Venice', ready: true }, change: { label: 'Change', tool: 'olympus_models', args: {} } },
      }),
    });
    const text = host.text();
    const order = ['Search has stopped working', 'Needs you', 'Gmail — signed out', 'Sources', 'On your Mac', 'Notes', 'Accounts', 'Gmail', 'Progress', 'Models — Built-in · Ready'];
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
    expect(rows[0]!.textContent).toContain('Working');
    expect(rows[0]!.textContent).toContain('Synced 2 hr ago');
    expect(rows[1]!.textContent).toContain('1,204 messages · Synced 5 min ago');
    const menu = rows[1]!.querySelector('details.menu')!;
    expect(menu.querySelector('summary')!.textContent).toContain('More actions for Gmail');
    expect(menu.querySelector('button')!.textContent).toBe('Disconnect');
    expect(rows[2]!.textContent).toContain('Connect sources in Olympus on your Mac.');
    expect((rows[2]!.querySelector('button') as unknown as HTMLButtonElement).disabled).toBe(true);
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

  test('models stay collapsed and summarize readiness', () => {
    const host = mount();
    host.push({ structuredContent: model({ models: { embedding: { kind: 'built_in', state: 'downloading', percent: 12 }, answers: { kind: 'local', label: 'Local models', ready: false } } }) });
    const box = host.win.document.querySelector('details.models') as unknown as HTMLDetailsElement;
    expect(box.open).toBe(false);
    expect(box.querySelector('summary')!.textContent).toBe('Models — Built-in · Downloading 12%');
    expect(box.textContent).toContain('Answers: Local models · Not ready');
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
