/**
 * The ChatGPT dashboard's source rows while a source is connecting, indexing
 * or stalled, the top-level progress line, and setup errors shown inline,
 * driven against a fake MCP Apps host.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import type { DashboardSource, DashboardViewModelV1 } from '../src/workers/chatgpt/dashboard-contract.ts';
import { chatgptDashboardPageHtml } from '../src/workers/dashboard/chatgpt/page.ts';
import { DASHBOARD_CHATGPT_PAGE_COPY as P, DASHBOARD_CHATGPT_PICKER_COPY as Q } from '../src/workers/dashboard/vocabulary.ts';

type Result = { structuredContent?: unknown; isError?: boolean; content?: unknown[]; _meta?: Record<string, unknown> };
type Serve = (args: any) => Result | 'hang' | 'fail';

interface Host {
  win: Window;
  sent: any[];
  calls: Array<[string, unknown]>;
  serve: Record<string, Serve>;
  doc: Document;
  text(): string;
  button(label: string): HTMLButtonElement;
  hasButton(label: string): boolean;
  push(result: unknown): void;
  toolCalls(name?: string): any[];
  settle(): Promise<void>;
}

const hosts: Host[] = [];
afterEach(async () => {
  while (hosts.length) await hosts.pop()!.win.happyDOM.close();
});
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function mount(serve: Record<string, Serve>, openai: Record<string, any> = { displayMode: 'fullscreen' }): Host {
  const html = chatgptDashboardPageHtml({ resultTimeoutMs: 5_000, connectPollMs: 5 });
  const start = html.indexOf('<script>') + '<script>'.length;
  const script = html.slice(start, html.indexOf('</script>', start));
  const win = new Window({ url: 'https://sandbox.test/' });
  win.document.write(html.slice(0, start - '<script>'.length) + html.slice(html.indexOf('</script>', start) + '</script>'.length));
  const sent: any[] = [];
  const calls: Host['calls'] = [];
  const dispatch = (data: unknown) => win.dispatchEvent(new win.MessageEvent('message', { data, source: parent as any }));
  const parent = {
    postMessage: (message: any) => {
      sent.push(message);
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
  (win as any).openai = {
    ...openai,
    notifyIntrinsicHeight: (height: number) => calls.push(['notifyIntrinsicHeight', height]),
    requestDisplayMode: (args: unknown) => calls.push(['requestDisplayMode', args]),
    openExternal: (args: unknown) => calls.push(['openExternal', args]),
    setWidgetState: (args: unknown) => calls.push(['setWidgetState', args]),
  };
  new Function('window', 'document', script)(win, win.document);
  const buttons = () => Array.from(win.document.querySelectorAll('#app button')) as unknown as HTMLButtonElement[];
  const host: Host = {
    win,
    sent,
    calls,
    serve,
    doc: win.document as unknown as Document,
    text: () => win.document.getElementById('app')!.textContent ?? '',
    button: (label) => {
      const found = buttons().find((node) => node.textContent === label || node.getAttribute('aria-label') === label);
      if (!found) throw new Error(`no button "${label}" in: ${buttons().map((b) => b.textContent).join(' | ')}`);
      return found;
    },
    hasButton: (label) => buttons().some((node) => node.textContent === label),
    push: (result) => dispatch({ jsonrpc: '2.0', method: 'ui/notifications/tool-result', params: result }),
    toolCalls: (name) => sent.filter((message) => message.method === 'tools/call' && (!name || message.params.name === name))
      .map((message) => message.params.arguments),
    settle: async () => {
      for (let i = 0; i < 5; i++) await sleep(1);
    },
  };
  hosts.push(host);
  return host;
}

const DISCONNECT = { label: 'Disconnect', tool: 'olympus_disconnect_source', args: { source_id: 'gmail.email' }, destructive: true };
const REOPEN = { label: Q.connectReopen, tool: 'olympus_connect_source', args: { source: 'gmail' } };
const CHOOSE = { label: 'Choose folders', tool: 'olympus_scope_list', args: { source_id: 'dropbox.files' } };
const inMinutes = (n: number) => new Date(Date.now() + n * 60_000 - 5_000).toISOString();

const connectingGmail: DashboardSource = {
  id: 'gmail.email', label: 'Gmail', group: 'cloud', status: 'Needs you', detail: Q.connectWaiting,
  primary: REOPEN, connecting: { expiresAt: inMinutes(9) }, menu: [DISCONNECT],
};
const indexingDrive: DashboardSource = {
  id: 'google_drive.docs', label: 'Google Drive', group: 'cloud', status: 'Working', detail: 'Reading',
  progress: { stage: 'reading', unit: 'files', done: 120, total: 300, percent: 40, stalled: false },
};
const stalledDropbox: DashboardSource = {
  id: 'dropbox.files', label: 'Dropbox', group: 'cloud', status: 'Needs you', primary: CHOOSE,
  progress: { stage: 'listing', unit: 'files', done: 0, total: 0, percent: 0, stalled: true, stalledReason: 'scope_pending' },
};
const ITEMS = [
  { id: 'source:gmail.email', sentence: 'Gmail — waiting for you to finish signing in', fix: REOPEN },
  { id: 'source:dropbox.files', sentence: 'Dropbox — choose folders', fix: CHOOSE },
];

function model(overrides: Partial<DashboardViewModelV1> = {}): DashboardViewModelV1 {
  return { v: 1, connection: { state: 'ready' }, needsYou: [], sources: [], models: { embedding: { kind: 'built_in', state: 'ready' } }, generatedAt: new Date().toISOString(), ...overrides };
}
function row(host: Host, label: string): Element {
  const found = Array.from(host.doc.querySelectorAll('.row.source')).find((node) => node.querySelector('.source-name')!.textContent === label);
  if (!found) throw new Error(`no row ${label}`);
  return found;
}

describe('a connecting source', () => {
  test('shows its detail and the link expiry, one button that reconnects, and Disconnect only in the menu', async () => {
    let polls = 0;
    const host = mount({
      olympus_connect_source: () => ({ structuredContent: { status: 'open_link', source: 'gmail', openUrl: 'https://mcp.olympusplugin.ai/go/fresh1', expiresAt: inMinutes(10) } }),
      olympus_dashboard: () => { polls++; return { structuredContent: model({ sources: [connectingGmail] }) }; },
    });
    host.push({ structuredContent: model({ needsYou: [ITEMS[0]!], sources: [connectingGmail] }) });
    const gmail = row(host, 'Gmail');
    expect(gmail.querySelector('.muted')!.textContent).toBe(`${Q.connectWaiting} · link expires in 9 min`);
    const buttons = Array.from(gmail.querySelectorAll('.source-actions button')).map((node) => node.textContent);
    expect(buttons).toEqual([Q.connectReopen]);
    expect(gmail.querySelector('.menu-panel')!.textContent).toContain('Disconnect');
    expect(gmail.querySelector('.source-progress')).toBeNull();
    host.button(Q.connectReopen).click();
    await host.settle();
    expect(host.toolCalls('olympus_connect_source')).toEqual([{ source: 'gmail' }]);
    expect(host.calls).toContainEqual(['openExternal', { href: 'https://mcp.olympusplugin.ai/go/fresh1' }]);
    expect(host.text()).toContain(Q.connectWaiting);
    for (let i = 0; i < 20 && !polls; i++) await sleep(5);
    expect(polls).toBeGreaterThan(0);
  });

  test('a failed sign-in start shows the result\'s own sentence', async () => {
    const host = mount({
      olympus_connect_source: () => ({ isError: true, content: [{ type: 'text', text: 'Olympus couldn\'t open the sign-in page for this source. Try again.' }], structuredContent: { error: 'sign_in_failed' } }),
    });
    host.push({ structuredContent: model({ sources: [connectingGmail] }) });
    host.button(Q.connectReopen).click();
    await host.settle();
    expect(host.text()).toContain('Olympus couldn\'t open the sign-in page for this source. Try again.');
    expect(host.text()).not.toContain(Q.connectFailed.replace('{source}', 'Gmail'));
  });
});

describe('each fact once', () => {
  test('an item about a listed source is not repeated in Needs you, matched by id, source or name', () => {
    const host = mount({});
    host.push({ structuredContent: model({
      needsYou: [
        ...ITEMS,
        { id: 'stall:drive', sentence: 'Google Drive — isn\'t responding', fix: { label: 'Check again', tool: 'olympus_dashboard', args: {} } },
        { id: 'other', source: 'google_drive.docs', sentence: 'Something about Drive', fix: { label: 'Check again', tool: 'olympus_dashboard', args: {} } } as any,
        { id: 'model:answers', sentence: 'Answers are not working on your Mac', fix: { label: 'Check again', tool: 'olympus_dashboard', args: {} } },
      ],
      sources: [connectingGmail, indexingDrive, stalledDropbox],
    }) });
    const needs = Array.from(host.doc.querySelectorAll('.row.need')).map((node) => node.textContent);
    expect(needs.length).toBe(1);
    expect(needs[0]).toContain('Answers are not working');
    expect(host.text().split('waiting for you to finish signing in').length).toBe(1);
    expect(host.text().split(Q.connectWaiting).length).toBe(2);
  });
});

describe('per-source progress', () => {
  test('an indexing source shows a labelled bar with stage, percent and counts, and no ETA or synced wording', () => {
    const host = mount({});
    host.push({ structuredContent: model({ sources: [{ ...indexingDrive, status: 'Fresh', lastSyncAt: new Date().toISOString() }] }) });
    const drive = row(host, 'Google Drive');
    expect(drive.textContent).not.toContain('Synced');
    expect(drive.querySelectorAll('.source-main > p.muted').length).toBe(0);
    const block = drive.querySelector('.source-progress')!;
    expect(block.querySelector('p')!.textContent).toBe('Reading — 40%, 120 of 300 files');
    const bar = block.querySelector('[role=progressbar]')!;
    expect(bar.getAttribute('aria-valuenow')).toBe('40');
    expect(bar.getAttribute('aria-label')).toContain('Google Drive');
    expect(drive.textContent).not.toContain('about');
    expect(block.className).toBe('source-progress');
  });

  test('a working source with no fix renders no action column: no empty controls box, no has-actions grid', () => {
    const host = mount({});
    const disconnectDrive = { ...DISCONNECT, args: { source_id: 'google_drive.docs' } };
    host.push({ structuredContent: model({ sources: [indexingDrive, { ...indexingDrive, id: 'dropbox.files', label: 'Dropbox', menu: [disconnectDrive] }] }) });
    const drive = row(host, 'Google Drive');
    expect(drive.querySelector('.source-actions')).toBeNull();
    expect(drive.className).toBe('row source');
    expect(Array.from(drive.children).map((node) => node.className)).toEqual(['source-main']);
    expect(drive.querySelectorAll('button').length).toBe(0);
    // With a ⋯ menu the row gets the menu's column only.
    const dropbox = row(host, 'Dropbox');
    expect(dropbox.querySelector('.source-actions')).toBeNull();
    expect(dropbox.className).toBe('row source has-menu');
  });

  test('while the total is unknown it says Finding items with no count', () => {
    const host = mount({});
    host.push({ structuredContent: model({ sources: [{ ...indexingDrive, progress: { stage: 'listing', unit: 'files', done: 0, total: 0, percent: 0, stalled: false } }] }) });
    expect(row(host, 'Google Drive').querySelector('.source-progress p')!.textContent).toBe('Finding items');
  });

  test('stalled: amber bar and one plain sentence per reason; the row\'s fix comes from the view model', () => {
    const reasons = [
      ['waiting_for_credentials', 'Paused: Olympus needs you to sign in to Dropbox again'],
      ['scope_pending', 'Paused until you choose folders'],
      ['provider_unavailable', 'Paused: Dropbox isn\'t responding; Olympus will retry'],
      ['model_downloading', 'Waiting for the search model to finish downloading'],
    ] as const;
    for (const [reason, sentence] of reasons) {
      const host = mount({});
      const source = { ...stalledDropbox, progress: { ...stalledDropbox.progress!, stage: 'reading' as const, done: 5, total: 10, percent: 50, stalledReason: reason } };
      host.push({ structuredContent: model({ sources: [source] }) });
      const dropbox = row(host, 'Dropbox');
      expect(dropbox.querySelector('.source-progress')!.className).toBe('source-progress stalled');
      expect(dropbox.querySelectorAll('.stall-line').length).toBe(1);
      expect(dropbox.querySelector('.stall-line')!.textContent).toBe(sentence);
      expect(Array.from(dropbox.querySelectorAll('.source-actions button')).map((node) => node.textContent)).toEqual(['Choose folders']);
      expect(dropbox.querySelectorAll('[role=progressbar]').length).toBe(1);
      expect(dropbox.textContent).not.toContain('Reading —');
    }
  });

  test('stalled with nothing counted yet: only the pause sentence, no stage line, no bar', () => {
    const host = mount({});
    host.push({ structuredContent: model({ sources: [stalledDropbox] }) });
    const dropbox = row(host, 'Dropbox');
    expect(dropbox.querySelector('.source-progress')!.textContent).toBe('Paused until you choose folders');
    expect(dropbox.querySelector('[role=progressbar]')).toBeNull();
    expect(dropbox.textContent).not.toContain('Finding items');
    expect(P.stalledReasons).toBeDefined();
  });

  test('a finished source shows no bar', () => {
    const host = mount({});
    host.push({ structuredContent: model({ sources: [{ ...indexingDrive, status: 'Fresh', progress: { stage: 'done', unit: 'files', done: 300, total: 300, percent: 100, stalled: false } }] }) });
    expect(host.doc.querySelector('.source-progress')).toBeNull();
  });
});

describe('top-level progress', () => {
  const top = { unit: 'files' as const, phase: 'initial' as const, percent: 40, itemsLeft: 180, stalled: false, details: [{ stage: 'Reading', unit: 'files' as const, done: 120, total: 300 }] };
  test('with one unfinished source the row\'s bar is the only place it appears', () => {
    const host = mount({});
    host.push({ structuredContent: model({ sources: [indexingDrive, stalledDropbox, { ...connectingGmail }], progress: top }) });
    expect(host.doc.querySelector('.progress-line')).toBeNull();
    expect(host.text().split('40%').length).toBe(2);
  });
  test('with two or more unfinished sources the page-wide line shows', () => {
    const host = mount({});
    host.push({ structuredContent: model({ sources: [indexingDrive, { ...stalledDropbox, progress: { ...stalledDropbox.progress!, stalled: false, stage: 'reading', total: 10, done: 2, percent: 20 } }], progress: top }) });
    expect(host.doc.querySelector('.progress-line')!.textContent).toBe('First index: 40% done, 180 files left');
  });

  const base = { unit: 'files' as const, phase: 'initial' as const, percent: 0, itemsLeft: 0, stalled: false };
  test('Finding items while no total is known', () => {
    const host = mount({});
    host.push({ structuredContent: model({ progress: { ...base, details: [{ stage: 'Finding items', unit: 'files', done: 0, total: 0 }] } }) });
    expect(host.doc.querySelector('.progress-line')!.textContent).toBe('First index: Finding items');
  });
  test('hidden once nothing is unfinished', () => {
    const host = mount({});
    host.push({ structuredContent: model({ progress: { ...base, percent: 100, details: [{ stage: 'Indexing', unit: 'files', done: 10, total: 10 }] } }) });
    expect(host.doc.querySelector('.progress-line')).toBeNull();
    expect(host.text()).not.toContain('Progress');
  });
  test('as before while items are left', () => {
    const host = mount({});
    host.push({ structuredContent: model({ progress: { ...base, percent: 40, itemsLeft: 60, details: [{ stage: 'Reading', unit: 'files', done: 40, total: 100 }] } }) });
    expect(host.doc.querySelector('.progress-line')!.textContent).toBe('First index: 40% done, 60 files left');
  });
});

describe('setup errors inline', () => {
  for (const [code, text] of [
    ['source_not_connected', 'This source isn\'t connected, so there is nothing to disconnect.'],
    ['source_busy', 'This source is finishing a read. Try again in a moment.'],
    ['disconnect_incomplete', 'Olympus couldn\'t finish disconnecting this source. Try again.'],
  ] as const) {
    test(`${code}: the sentence appears beside Disconnect and the Mac is not called unreachable`, async () => {
      const host = mount({ olympus_disconnect_source: () => ({ isError: true, content: [{ type: 'text', text }], structuredContent: { error: code } }) });
      host.push({ structuredContent: model({ sources: [{ ...indexingDrive, id: 'gmail.email', label: 'Gmail', menu: [DISCONNECT] }] }) });
      (row(host, 'Gmail').querySelector('summary') as unknown as HTMLElement).click();
      host.button('Disconnect').click();
      host.button('Yes, disconnect').click();
      await host.settle();
      expect(host.toolCalls('olympus_disconnect_source')).toEqual([{ source_id: 'gmail.email' }]);
      const note = row(host, 'Gmail').querySelector('.reason.error')!;
      expect(note.textContent).toBe(text);
      expect(note.getAttribute('role')).toBe('alert');
      expect(host.text()).not.toContain('can\'t reach your Mac');
    });
  }
});
