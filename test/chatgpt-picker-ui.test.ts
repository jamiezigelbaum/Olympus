/**
 * The ChatGPT page's in-place Connect flow and folder and mail pickers,
 * driven against a fake MCP Apps host that serves the dashboard, connect,
 * scope-list and scope-set tools over JSON-RPC postMessage.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import type { DashboardViewModelV1 } from '../src/workers/chatgpt/dashboard-contract.ts';
import { CHATGPT_DASHBOARD_CSS, chatgptDashboardPageHtml } from '../src/workers/dashboard/chatgpt/page.ts';
import { CHATGPT_PICKER_TOOLS, CHATGPT_SCOPE_META_KEY } from '../src/workers/dashboard/chatgpt/picker.ts';
import { DASHBOARD_CHATGPT_PICKER_COPY as Q } from '../src/workers/dashboard/vocabulary.ts';
import { FIRST_RUN_RESOURCES, FIRST_RUN_RESOURCES_KEY, FIRST_RUN_ROOT } from './fixtures/chatgpt-picker-first-run.ts';

const T = CHATGPT_PICKER_TOOLS;
type Result = { structuredContent?: unknown; isError?: boolean; content?: unknown[]; _meta?: Record<string, unknown> | undefined };
type Serve = (args: any) => Result | 'hang' | 'fail';

interface Host {
  win: Window;
  sent: any[];
  calls: Array<[string, unknown]>;
  serve: Record<string, Serve>;
  text(): string;
  visibleText(): string;
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
const ev = (host: Host, type: string) => new host.win.Event(type) as unknown as Event;

function mount(options: { openai?: Record<string, any> | undefined; serve?: Record<string, Serve>; pollMs?: number; pollCapMs?: number } = {}): Host {
  const html = chatgptDashboardPageHtml({ resultTimeoutMs: 5_000, connectPollMs: options.pollMs ?? 5, connectPollCapMs: options.pollCapMs ?? 5_000 });
  const start = html.indexOf('<script>') + '<script>'.length;
  const script = html.slice(start, html.indexOf('</script>', start));
  const win = new Window({ url: 'https://sandbox.test/' });
  win.document.write(html.slice(0, start - '<script>'.length) + html.slice(html.indexOf('</script>', start) + '</script>'.length));
  const sent: any[] = [];
  const calls: Host['calls'] = [];
  const serve: Record<string, Serve> = { ...options.serve };
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
  if (options.openai) {
    (win as any).openai = {
      ...options.openai,
      notifyIntrinsicHeight: (height: number) => calls.push(['notifyIntrinsicHeight', height]),
      requestDisplayMode: (args: unknown) => calls.push(['requestDisplayMode', args]),
      openExternal: (args: unknown) => calls.push(['openExternal', args]),
      setWidgetState: (args: unknown) => calls.push(['setWidgetState', args]),
    };
  }
  new Function('window', 'document', script)(win, win.document);
  const buttons = () => Array.from(win.document.querySelectorAll('#app button')) as unknown as HTMLButtonElement[];
  const host: Host = {
    win,
    sent,
    calls,
    serve,
    text: () => win.document.getElementById('app')!.textContent ?? '',
    visibleText: () => {
      const clone = win.document.getElementById('app')!.cloneNode(true) as unknown as HTMLElement;
      for (const box of Array.from(clone.querySelectorAll('details'))) box.remove();
      return clone.textContent ?? '';
    },
    button: (label) => {
      const found = buttons().find((node) => node.textContent === label);
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

function model(overrides: Partial<DashboardViewModelV1> = {}): DashboardViewModelV1 {
  return { v: 1, connection: { state: 'ready' }, needsYou: [], sources: [], models: { embedding: { kind: 'built_in', state: 'ready' } }, generatedAt: new Date().toISOString(), ...overrides };
}

const connectResult = (openUrl: string): Result => ({ structuredContent: { status: 'open_link', source: 'dropbox', openUrl, expiresAt: new Date(Date.now() + 600_000).toISOString() } });
const CONNECT_FIX = { label: 'Connect', tool: T.connectSource, args: { source: 'dropbox' } };
const CHOOSE_FIX = { label: 'Choose folders', tool: T.scopeList, args: { source_id: 'dropbox.files' } };
const offDropbox = model({ sources: [{ id: 'dropbox.files', label: 'Dropbox', group: 'cloud', status: 'Off', primary: CONNECT_FIX }] });
const pendingDropbox = model({ sources: [{ id: 'dropbox.files', label: 'Dropbox', group: 'cloud', status: 'Waiting', primary: CHOOSE_FIX }] });

// Private-looking names: they may appear only inside the picker view.
const NAMES = ['Tax Returns 2024', 'Medical Records', 'Therapy Notes', 'Divorce', 'Kids Photos', 'Old Letters'];
const node = (key: string, name: string, extra: Record<string, unknown> = {}) => ({ key, name, kind: 'folder', has_children: false, selectable: true, ...extra });
const ROOT = [
  node('k-a', 'Tax Returns 2024', { has_children: true, size_bytes: 2_000_000_000, file_count: 1200 }),
  node('k-b', 'Medical Records', { size_bytes: 500_000_000, file_count: 1 }),
];
const ROOT_PAGE_2 = [node('k-d', 'Kids Photos')];
const CHILDREN = [node('k-a1', 'Therapy Notes', { size_bytes: 1_000_000_000 }), node('k-a2', 'Divorce', { size_bytes: 300_000_000, has_children: true })];

/** A scope tool result as the backend sends it: counts in structuredContent, picker data only in _meta. */
function scopeResult(list: Record<string, any>, structured?: Record<string, unknown>): Result {
  const summary = {
    kind: list.kind, source_id: list.source_id, status: list.status, account_generation: list.account_generation,
    scope_revision: list.scope_revision, shown: (list.nodes ?? list.labels ?? []).length, has_more: !!list.next_cursor,
    choices: (list.selections ?? []).length, whole_account_selected: !!list.whole_account_selected,
  };
  return { structuredContent: structured ?? summary, _meta: { [CHATGPT_SCOPE_META_KEY]: list } };
}

function browse(nodes: unknown[], extra: Record<string, unknown> = {}): Result {
  return scopeResult({ kind: 'folders', source_id: 'dropbox.files', account_generation: 'g1', scope_revision: 'r1', status: 'scope_pending', nodes, selections: [], whole_account_selected: false, ...extra });
}
const SAVED: Result = { structuredContent: { status: 'saved', source_id: 'dropbox.files', scope_revision: 'r2', indexing_started: true } };

function folderServer(extra: Record<string, unknown> = {}): Serve {
  return (args) => {
    if (args.parent_key === 'k-a') return browse(CHILDREN, extra);
    if (args.parent_key === 'k-a2') return browse([node('k-deep', 'Old Letters', { has_children: true })], extra);
    if (args.parent_key) return browse([], extra);
    if (args.cursor === 'c1') return browse(ROOT_PAGE_2, extra);
    return browse(ROOT, { next_cursor: 'c1', ...extra });
  };
}

async function openFolders(serveExtra: Record<string, unknown> = {}, openai?: Record<string, any>): Promise<Host> {
  const host = mount({ serve: { [T.scopeList]: folderServer(serveExtra), olympus_dashboard: () => ({ structuredContent: pendingDropbox }) }, openai });
  host.push({ structuredContent: pendingDropbox });
  host.button('Choose folders').click();
  await host.settle();
  return host;
}

const JARGON = ['lane', 'guard', 'supervisor', 'chunk', 'epoch', 'reauth', 'embed', 'ingest', 'metadata'];
function expectNoJargon(host: Host) {
  const text = host.visibleText().toLowerCase();
  for (const word of JARGON) expect(text).not.toContain(word);
}

/** Names may leave the page only in the picker's own two tools' arguments (the mail draft carries label names). */
const PICKER_CALL = (message: any) => message.method === 'tools/call' && [T.scopeList, T.scopeSet].includes(message.params.name);

function expectNamesOnlyInPicker(host: Host) {
  for (const message of host.sent) {
    if (PICKER_CALL(message)) continue;
    const raw = JSON.stringify(message);
    for (const name of NAMES) expect(raw).not.toContain(name);
  }
  expect(host.sent.some((message) => String(message.method).includes('update-model-context'))).toBe(false);
  expect(host.calls.some(([name]) => name === 'setWidgetState')).toBe(false);
  expect(host.win.location.href).toBe('https://sandbox.test/');
}

describe('connect', () => {
  test('Connect opens the /go/ link, waits visibly, and polls the dashboard until the source is connected, then opens the picker', async () => {
    let polls = 0;
    const host = mount({
      openai: { displayMode: 'fullscreen' },
      serve: {
        [T.connectSource]: () => (connectResult('https://mcp.olympusplugin.ai/go/abc123')),
        olympus_dashboard: () => ({ structuredContent: ++polls < 3 ? offDropbox : pendingDropbox }),
        [T.scopeList]: folderServer(),
      },
    });
    host.push({ structuredContent: offDropbox });
    host.button('Connect').click();
    expect(host.toolCalls(T.connectSource)).toEqual([{ source: 'dropbox' }]);
    expect(host.text()).toContain('Connect Dropbox');
    await sleep(1);
    expect(host.calls).toContainEqual(['openExternal', { href: 'https://mcp.olympusplugin.ai/go/abc123' }]);
    expect(host.text()).toContain(Q.connectWaiting);
    expect(host.button('Cancel').disabled).toBe(false);
    for (let i = 0; i < 40 && !host.text().includes('Tax Returns 2024'); i++) await sleep(5);
    expect(polls).toBe(3);
    expect(host.toolCalls(T.scopeList)).toEqual([{ source_id: 'dropbox.files' }]);
    // The connect hello is one quiet line with no side stripe, gone after the first choice.
    const hello = host.win.document.querySelector('.fnote')!;
    expect(hello.textContent).toBe('Dropbox is connected.');
    expect(hello.className).toBe('fnote muted');
    expect(host.win.document.querySelector('.notice')).toBeNull();
    expect(host.text()).toContain(Q.foldersTitle);
    (host.win.document.querySelector('.seg-opt[data-key="picker:seg:k-b:ingest"]') as unknown as HTMLButtonElement).click();
    expect(host.text()).not.toContain('Dropbox is connected.');
    expectNamesOnlyInPicker(host);
  });

  test('without window.openai the link goes through ui/open-link', async () => {
    const host = mount({ serve: { [T.connectSource]: () => (connectResult('https://mcp.olympusplugin.ai/go/x1')), olympus_dashboard: () => 'hang' } });
    host.push({ structuredContent: offDropbox });
    host.button('Connect').click();
    await host.settle();
    expect(host.sent.find((message) => message.method === 'ui/open-link')!.params).toEqual({ url: 'https://mcp.olympusplugin.ai/go/x1' });
  });

  test('a link anywhere but the connect host\'s /go/ path is refused', async () => {
    for (const url of ['https://evil.example/go/abc', 'https://mcp.olympusplugin.ai/oauth/abc', 'http://mcp.olympusplugin.ai/go/abc']) {
      const host = mount({ openai: {}, serve: { [T.connectSource]: () => (connectResult(url)) } });
      host.push({ structuredContent: offDropbox });
      host.button('Connect').click();
      await host.settle();
      expect(host.calls.some(([name]) => name === 'openExternal')).toBe(false);
      expect(host.text()).toContain(Q.connectFailed.replace('{source}', 'Dropbox'));
      expect(host.button('Try again').disabled).toBe(false);
    }
  });

  test('Cancel stops waiting and returns to the dashboard', async () => {
    const host = mount({ openai: {}, pollMs: 20, serve: { [T.connectSource]: () => (connectResult('https://mcp.olympusplugin.ai/go/a')), olympus_dashboard: () => ({ structuredContent: offDropbox }) } });
    host.push({ structuredContent: offDropbox });
    host.button('Connect').click();
    await host.settle();
    host.button('Cancel').click();
    expect(host.text()).toContain('Sources');
    const before = host.toolCalls('olympus_dashboard').length;
    await sleep(60);
    expect(host.toolCalls('olympus_dashboard').length).toBe(before);
  });

  test('a pending sign-in (Needs you with connecting) is not connected; polling continues until connecting clears', async () => {
    const expiresAt = new Date(Date.now() + 600_000).toISOString();
    const signingIn = model({ sources: [{ id: 'dropbox.files', label: 'Dropbox', group: 'cloud', status: 'Needs you', connecting: { expiresAt }, primary: CONNECT_FIX }] });
    let polls = 0;
    const host = mount({
      openai: { displayMode: 'fullscreen' },
      serve: {
        [T.connectSource]: () => (connectResult('https://mcp.olympusplugin.ai/go/abc123')),
        olympus_dashboard: () => ({ structuredContent: ++polls < 4 ? signingIn : pendingDropbox }),
        [T.scopeList]: folderServer(),
      },
    });
    host.push({ structuredContent: offDropbox });
    host.button('Connect').click();
    for (let i = 0; i < 20 && polls < 2; i++) await sleep(5);
    expect(host.text()).toContain(Q.connectWaiting);
    expect(host.toolCalls(T.scopeList)).toEqual([]);
    for (let i = 0; i < 40 && !host.text().includes('Tax Returns 2024'); i++) await sleep(5);
    expect(polls).toBe(4);
    expect(host.toolCalls(T.scopeList)).toEqual([{ source_id: 'dropbox.files' }]);
  });

  test('leaving the picker re-reads the dashboard: Cancel while waiting, and Back from the folder list', async () => {
    const host = mount({ openai: {}, pollMs: 10_000, serve: { [T.connectSource]: () => (connectResult('https://mcp.olympusplugin.ai/go/a')), olympus_dashboard: () => ({ structuredContent: pendingDropbox }) } });
    host.push({ structuredContent: offDropbox });
    host.button('Connect').click();
    await host.settle();
    expect(host.toolCalls('olympus_dashboard').length).toBe(0);
    host.button('Cancel').click();
    await host.settle();
    expect(host.toolCalls('olympus_dashboard').length).toBe(1);
    // The fresh dashboard replaced the stale Off row.
    expect(host.hasButton('Choose folders')).toBe(true);

    const folders = await openFolders();
    const before = folders.toolCalls('olympus_dashboard').length;
    folders.button(Q.back).click();
    await folders.settle();
    expect(folders.toolCalls('olympus_dashboard').length).toBe(before + 1);
  });

  test('waiting is capped; Check again resumes', async () => {
    const host = mount({ openai: {}, pollMs: 2, pollCapMs: 15, serve: { [T.connectSource]: () => (connectResult('https://mcp.olympusplugin.ai/go/a')), olympus_dashboard: () => ({ structuredContent: offDropbox }) } });
    host.push({ structuredContent: offDropbox });
    host.button('Connect').click();
    for (let i = 0; i < 50 && !host.hasButton('Check again'); i++) await sleep(3);
    expect(host.text()).toContain(Q.connectTimeout.replace('{source}', 'Dropbox'));
    host.button('Check again').click();
    expect(host.text()).toContain(Q.connectWaiting);
  });

  test('inline card: Connect asks for fullscreen first, then connects in place', async () => {
    const data = model({ needsYou: [{ id: 'source:dropbox.files', sentence: 'Dropbox — not connected', fix: CONNECT_FIX }], sources: offDropbox.sources });
    const host = mount({ openai: { toolOutput: data, displayMode: 'inline' }, serve: { [T.connectSource]: () => 'hang' } });
    host.button('Connect').click();
    expect(host.calls).toContainEqual(['requestDisplayMode', { mode: 'fullscreen' }]);
    expect(host.toolCalls(T.connectSource)).toEqual([{ source: 'dropbox' }]);
    expect(host.text()).toContain('Connect Dropbox');
    expect(host.win.document.documentElement.getAttribute('data-mode')).toBe('fullscreen');
  });

  test('inline card: Choose folders asks for fullscreen too', async () => {
    const data = model({ needsYou: [{ id: 'source:dropbox.files', sentence: 'Dropbox — choose folders', fix: CHOOSE_FIX }], sources: pendingDropbox.sources });
    const host = mount({ openai: { toolOutput: data, displayMode: 'inline' }, serve: { [T.scopeList]: folderServer() } });
    host.button('Choose folders').click();
    expect(host.calls).toContainEqual(['requestDisplayMode', { mode: 'fullscreen' }]);
    await host.settle();
    expect(host.text()).toContain('Tax Returns 2024');
  });
});

describe('folder picker', () => {
  const doc = (host: Host) => host.win.document;
  const rowOf = (host: Host, name: string) => {
    const found = Array.from(doc(host).querySelectorAll('li.seg-row')).find((node) => node.querySelector('.fname-text')!.textContent === name);
    if (!found) throw new Error(`no row for ${name}`);
    return found as unknown as HTMLElement;
  };
  const segIn = (scope: HTMLElement, state: string) => scope.querySelector(`.seg-opt[data-key$=":${state}"]`) as unknown as HTMLButtonElement;
  const seg = (host: Host, name: string, state: string) => segIn(rowOf(host, name), state);
  const thisSeg = (host: Host, state: string) => segIn(doc(host).querySelector('.this-row') as unknown as HTMLElement, state);
  /** What a control shows: the pressed segment, and the one drawn as inherited. */
  const shown = (scope: HTMLElement) => {
    const segs = Array.from(scope.querySelectorAll('.seg-opt')) as unknown as HTMLButtonElement[];
    const state = (button?: HTMLButtonElement) => (button ? String(button.getAttribute('data-key')).split(':').pop() : '');
    return {
      pressed: state(segs.find((button) => button.getAttribute('aria-pressed') === 'true')),
      inherited: state(segs.find((button) => button.className.includes('inherited'))),
    };
  };
  const rowShows = (host: Host, name: string) => shown(rowOf(host, name));
  const thisShows = (host: Host) => shown(doc(host).querySelector('.this-row') as unknown as HTMLElement);
  const tap = (host: Host, name: string, state: string) => seg(host, name, state).click();
  const openFolder = (host: Host, name: string) => (rowOf(host, name).querySelector('.fopen') as unknown as HTMLButtonElement).click();
  const footer = (host: Host) => doc(host).querySelector('.picker-footer')!.textContent!;
  const escapeKey = (host: Host) => doc(host).dispatchEvent(new host.win.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }) as any);
  const focused = (host: Host) => (doc(host).activeElement as any)?.getAttribute('data-key');
  const rowNames = (host: Host) => Array.from(doc(host).querySelectorAll('li.seg-row .fname-text')).map((node) => node.textContent);
  const mixedTag = (host: Host, name: string) => rowOf(host, name).querySelector('.ftag');

  test('root: one thin row per folder with a three-segment control, nothing chosen, a disabled Save, and no <select>, sheet or status links', async () => {
    const host = await openFolders({}, { displayMode: 'fullscreen' });
    const top = doc(host).querySelector('.this-row')!;
    expect(top.querySelector('.this-label')!.textContent).toBe('Everything in Dropbox');
    expect(thisShows(host)).toEqual({ pressed: '', inherited: '' });
    // The contract carries the whole account as on or off: only Full can be chosen there.
    expect(thisSeg(host, 'ingest').disabled).toBe(false);
    for (const state of ['metadata_only', 'exclude']) {
      expect(thisSeg(host, state).disabled).toBe(true);
      expect(thisSeg(host, state).getAttribute('aria-description')).toBe(Q.wholeOnlyFull);
    }
    expect(rowOf(host, 'Tax Returns 2024').querySelector('.fname')!.textContent).toBe('›Tax Returns 20242 GB· 1,200 files');
    expect(rowOf(host, 'Medical Records').querySelector('.fname')!.textContent).toBe('Medical Records500 MB· 1 file');
    // Every row: one drill-in button (› then the name) or a leaf name, then one control.
    for (const row of Array.from(doc(host).querySelectorAll('li.seg-row'))) {
      const opens = !!row.querySelector('.fopen');
      // The control last, flush right.
      expect(Array.from(row.children).map((child) => child.className)).toEqual([opens ? 'fname' : 'fname leaf', 'seg']);
      // Inside the name: the narrow › column (or a same-width spacer for a leaf, so names align), then the name.
      const name = row.firstElementChild!;
      expect(name.tagName).toBe(opens ? 'BUTTON' : 'P');
      expect(Array.from(name.children).slice(0, 2).map((child) => child.className)).toEqual([opens ? 'fopen' : 'fopen-gap', 'fname-main']);
      expect(name.firstElementChild!.getAttribute('aria-hidden')).toBe('true');
      expect(row.lastElementChild!.getAttribute('role')).toBe('radiogroup');
      expect(Array.from(row.querySelectorAll('.seg-opt .seg-long')).map((node) => node.textContent)).toEqual(['Full', 'Names only', 'Skip']);
      expect(Array.from(row.querySelectorAll('.seg-opt .seg-short')).map((node) => node.textContent)).toEqual(['Full', 'Names', 'Skip']);
    }
    expect(rowShows(host, 'Medical Records')).toEqual({ pressed: '', inherited: '' });
    // Nothing repeats per row: no status line, no "Not included", no underlined links, no notice.
    expect(host.text()).not.toContain(Q.notIncluded);
    expect(doc(host).querySelectorAll('.fstatus, .two-line, .sheet, .scrim, .notice, .fnote').length).toBe(0);
    expect(host.text()).not.toContain('Therapy Notes');
    expect(doc(host).querySelector('.exceptions')).toBeNull();
    expect(footer(host)).toContain(Q.summaryNone);
    expect(host.button(Q.saveNoStart).disabled).toBe(true);
    expect(footer(host)).toContain(Q.needChoice);
    expect(doc(host).querySelectorAll('select').length).toBe(0);
    expect(doc(host).querySelectorAll('.tree, [aria-expanded]').length).toBe(0);
    expectNoJargon(host);
  });

  test('accessibility: a labelled radiogroup per row, aria-pressed segments, one tab stop, and arrow keys move between segments', async () => {
    const host = await openFolders();
    const group = rowOf(host, 'Medical Records').querySelector('.seg')!;
    expect(group.getAttribute('role')).toBe('radiogroup');
    expect(group.getAttribute('aria-label')).toBe('Choice for Medical Records');
    const segs = () => Array.from(rowOf(host, 'Medical Records').querySelectorAll('.seg-opt')) as unknown as HTMLButtonElement[];
    expect(segs().map((button) => button.tagName)).toEqual(['BUTTON', 'BUTTON', 'BUTTON']);
    expect(segs().map((button) => button.getAttribute('aria-pressed'))).toEqual(['false', 'false', 'false']);
    expect(segs().map((button) => button.getAttribute('aria-label'))).toEqual(['Full', 'Names only', 'Skip']);
    expect(segs().map((button) => button.tabIndex)).toEqual([0, -1, -1]);
    const press = (name: string) => {
      const from = doc(host).activeElement as unknown as HTMLButtonElement;
      from.dispatchEvent(new host.win.KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true }) as any);
    };
    segs()[0]!.focus();
    press('ArrowRight');
    expect(focused(host)).toBe('picker:seg:k-b:metadata_only');
    expect(segs().map((button) => button.tabIndex)).toEqual([-1, 0, -1]);
    press('ArrowRight');
    press('ArrowRight');
    expect(focused(host)).toBe('picker:seg:k-b:ingest');
    press('ArrowLeft');
    expect(focused(host)).toBe('picker:seg:k-b:exclude');
    press('Home');
    expect(focused(host)).toBe('picker:seg:k-b:ingest');
    press('End');
    expect(focused(host)).toBe('picker:seg:k-b:exclude');
    // The › and the name are one drill-in button: one tap target, one tab stop.
    const open = rowOf(host, 'Tax Returns 2024').querySelector('.fname') as unknown as HTMLButtonElement;
    expect(open.getAttribute('aria-label')).toBe('Open Tax Returns 2024');
    expect(open.getAttribute('data-key')).toBe('picker:open:k-a');
    expect(open.tabIndex).toBe(0);
    expect(rowOf(host, 'Tax Returns 2024').querySelector('.fname')!.getAttribute('title')).toBe('Tax Returns 2024');
    // After a choice the chosen segment keeps focus and is the group's tab stop.
    tap(host, 'Medical Records', 'metadata_only');
    expect(focused(host)).toBe('picker:seg:k-b:metadata_only');
    expect(segs().map((button) => button.tabIndex)).toEqual([-1, 0, -1]);
  });

  test('folders are listed alphabetically, numbers in numeric order', async () => {
    const host = await openFolders({}, { displayMode: 'fullscreen' });
    const names = rowNames(host);
    expect(names.length).toBeGreaterThan(1);
    const sorted = [...names].sort((a, b) => a!.localeCompare(b!, undefined, { numeric: true, sensitivity: 'base' }));
    expect(names).toEqual(sorted);
  });

  test('drilling in lists one level lazily, shows the path and This folder, and Back and Escape go up', async () => {
    const host = await openFolders();
    openFolder(host, 'Tax Returns 2024');
    await host.settle();
    expect(host.toolCalls(T.scopeList).at(-1)).toEqual({ source_id: 'dropbox.files', parent_key: 'k-a' });
    expect(doc(host).querySelector('.fpath')!.textContent).toBe('Dropbox / Tax Returns 2024');
    expect(doc(host).querySelector('.this-row .this-label')!.textContent).toBe(Q.thisFolder);
    expect(doc(host).querySelector('.this-row .seg')!.getAttribute('aria-label')).toBe('Choice for Tax Returns 2024');
    expect(doc(host).querySelector('.this-row button.btn')).toBeNull();
    expect(host.text()).toContain('Therapy Notes');
    expect(host.text()).not.toContain('Medical Records');
    expect(focused(host)).toBe('picker:up');
    expect(host.button(Q.up).getAttribute('aria-label')).toBe('Back to Everything in Dropbox');
    host.button(Q.up).click();
    expect(host.text()).toContain('Medical Records');
    expect(focused(host)).toBe('picker:open:k-a');
    // Cached: the second visit lists nothing. Tapping the name drills in too.
    const listed = host.toolCalls(T.scopeList).length;
    (rowOf(host, 'Tax Returns 2024').querySelector('.fname') as unknown as HTMLButtonElement).click();
    openFolder(host, 'Divorce');
    await host.settle();
    expect(host.toolCalls(T.scopeList).length).toBe(listed + 1);
    expect(doc(host).querySelector('.fpath')!.textContent).toBe('Dropbox / Tax Returns 2024 / Divorce');
    openFolder(host, 'Old Letters');
    await host.settle();
    expect(doc(host).querySelector('.fpath')!.textContent).toBe('… / Divorce / Old Letters');
    escapeKey(host);
    expect(doc(host).querySelector('.fpath')!.textContent).toBe('Dropbox / Tax Returns 2024 / Divorce');
    escapeKey(host);
    escapeKey(host);
    expect(host.text()).toContain(Q.foldersTitle);
    expect(host.text()).toContain('Medical Records');
  });

  test('one tap chooses, a second tap clears; inherited choices are drawn weaker; Mixed; the footer counts and the exact save payload', async () => {
    const host = await openFolders({}, { displayMode: 'fullscreen' });
    tap(host, 'Tax Returns 2024', 'ingest');
    expect(rowShows(host, 'Tax Returns 2024')).toEqual({ pressed: 'ingest', inherited: '' });
    expect(seg(host, 'Tax Returns 2024', 'ingest').className).toBe('seg-opt on');
    expect(focused(host)).toBe('picker:seg:k-a:ingest');
    expect(footer(host)).toContain('1 folder fully indexed · about 2 GB');
    // A second tap on the chosen segment clears it.
    tap(host, 'Tax Returns 2024', 'ingest');
    expect(rowShows(host, 'Tax Returns 2024')).toEqual({ pressed: '', inherited: '' });
    expect(footer(host)).toContain(Q.summaryNone);
    // Another segment switches in one tap.
    tap(host, 'Tax Returns 2024', 'metadata_only');
    tap(host, 'Tax Returns 2024', 'ingest');
    expect(rowShows(host, 'Tax Returns 2024')).toEqual({ pressed: 'ingest', inherited: '' });
    openFolder(host, 'Tax Returns 2024');
    await host.settle();
    expect(thisShows(host)).toEqual({ pressed: 'ingest', inherited: '' });
    // Children inherit Full: outlined, not pressed, saying where it comes from without visible text.
    expect(rowShows(host, 'Divorce')).toEqual({ pressed: '', inherited: 'ingest' });
    const inheritedSeg = seg(host, 'Divorce', 'ingest');
    expect(inheritedSeg.getAttribute('aria-pressed')).toBe('false');
    expect(inheritedSeg.className).toBe('seg-opt inherited');
    expect(inheritedSeg.getAttribute('aria-description')).toBe('Inherited from Tax Returns 2024');
    expect(rowOf(host, 'Divorce').textContent).not.toContain('Tax Returns 2024');
    tap(host, 'Therapy Notes', 'exclude');
    expect(rowShows(host, 'Therapy Notes')).toEqual({ pressed: 'exclude', inherited: '' });
    host.button(Q.up).click();
    expect(mixedTag(host, 'Tax Returns 2024')!.textContent).toBe(Q.mixed);
    expect(mixedTag(host, 'Tax Returns 2024')!.getAttribute('title')).toBe('Mixed: some folders inside are skipped');
    expect(mixedTag(host, 'Medical Records')).toBeNull();
    const exceptions = doc(host).querySelector('.exceptions')!;
    expect(exceptions.querySelector('h2')!.textContent).toBe('Exceptions (2)');
    expect(Array.from(exceptions.querySelectorAll('.jump-btn')).map((node) => node.textContent)).toEqual(['Tax Returns 2024Full›', 'Tax Returns 2024 / Therapy NotesSkip›']);
    expect(footer(host)).toContain('1 folder fully indexed, 1 skipped · about 1 GB');
    tap(host, 'Medical Records', 'metadata_only');
    expect(footer(host)).toContain('1 folder fully indexed, 1 with names only, 1 skipped');
    tap(host, 'Medical Records', 'metadata_only');
    expect(host.calls.filter(([name]) => name === 'notifyIntrinsicHeight').length).toBeGreaterThan(5);
    expectNoJargon(host);
    host.serve[T.scopeSet] = () => SAVED;
    host.button(Q.saveFolders).click();
    expect(host.toolCalls(T.scopeSet)).toEqual([{
      source_id: 'dropbox.files',
      account_generation: 'g1',
      scope_revision: 'r1',
      selections: [
        { key: 'k-a', state: 'ingest', ancestor_keys: [] },
        { key: 'k-a1', state: 'exclude', ancestor_keys: ['k-a'] },
      ],
      whole_account_selected: false,
    }]);
    await host.settle();
    expect(host.text()).toContain('Dropbox: saved. Olympus is starting.');
    expect(host.toolCalls('olympus_dashboard').length).toBe(1);
    for (const name of NAMES) expect(host.text()).not.toContain(name);
    expectNamesOnlyInPicker(host);
  });

  test('under a stricter parent the more-open segments are disabled and say why, without visible text', async () => {
    const host = await openFolders();
    tap(host, 'Tax Returns 2024', 'metadata_only');
    openFolder(host, 'Tax Returns 2024');
    await host.settle();
    expect(rowShows(host, 'Therapy Notes')).toEqual({ pressed: '', inherited: 'metadata_only' });
    const states = ['ingest', 'metadata_only', 'exclude'].map((state) => [state, seg(host, 'Therapy Notes', state).disabled]);
    expect(states).toEqual([['ingest', true], ['metadata_only', false], ['exclude', false]]);
    const why = 'Not possible while Tax Returns 2024 is names only.';
    expect(seg(host, 'Therapy Notes', 'ingest').getAttribute('aria-description')).toBe(why);
    expect(seg(host, 'Therapy Notes', 'ingest').getAttribute('title')).toBe(why);
    expect(host.text()).not.toContain(why);
    // Choosing the inherited segment makes it the folder's own choice; a second tap clears it again.
    tap(host, 'Therapy Notes', 'metadata_only');
    expect(rowShows(host, 'Therapy Notes')).toEqual({ pressed: 'metadata_only', inherited: '' });
    tap(host, 'Therapy Notes', 'metadata_only');
    expect(rowShows(host, 'Therapy Notes')).toEqual({ pressed: '', inherited: 'metadata_only' });
    // Under a skipped parent only Skip is possible.
    host.button(Q.up).click();
    tap(host, 'Tax Returns 2024', 'exclude');
    openFolder(host, 'Tax Returns 2024');
    expect(['ingest', 'metadata_only', 'exclude'].map((state) => seg(host, 'Divorce', state).disabled)).toEqual([true, true, false]);
    expect(thisShows(host)).toEqual({ pressed: 'exclude', inherited: '' });
  });

  test('changing a parent keeps its children\'s own choices, and a stricter parent wins visibly', async () => {
    const host = await openFolders({
      selections: [
        { key: 'k-a', state: 'ingest', ancestor_keys: [] },
        { key: 'k-a1', state: 'metadata_only', ancestor_keys: ['k-a'] },
      ],
    });
    tap(host, 'Tax Returns 2024', 'exclude');
    openFolder(host, 'Tax Returns 2024');
    await host.settle();
    // Its own Names only stays pressed beside the parent's Skip that wins, and can still be cleared.
    expect(rowShows(host, 'Therapy Notes')).toEqual({ pressed: 'metadata_only', inherited: 'exclude' });
    expect(seg(host, 'Therapy Notes', 'metadata_only').disabled).toBe(false);
    expect(seg(host, 'Therapy Notes', 'metadata_only').getAttribute('aria-description')).toBe('This folder is set to Names only, but Tax Returns 2024 is Skipped, which wins.');
    expect(seg(host, 'Therapy Notes', 'ingest').disabled).toBe(true);
    expect(seg(host, 'Therapy Notes', 'ingest').getAttribute('aria-description')).toBe('Not possible while Tax Returns 2024 is skipped.');
    host.serve[T.scopeSet] = () => SAVED;
    host.button(Q.saveNoStart).click();
    expect(host.toolCalls(T.scopeSet).at(-1).selections).toEqual([
      { key: 'k-a', state: 'exclude', ancestor_keys: [] },
      { key: 'k-a1', state: 'metadata_only', ancestor_keys: ['k-a'] },
    ]);
  });

  test('saved deep choices: Mixed before anything is opened, and an exception jumps to its folder, loading each level once', async () => {
    const host = await openFolders({
      selections: [
        { key: 'k-a', state: 'ingest', ancestor_keys: [] },
        { key: 'k-deep', state: 'metadata_only', ancestor_keys: ['k-a', 'k-a2'] },
      ],
    });
    expect(rowShows(host, 'Tax Returns 2024')).toEqual({ pressed: 'ingest', inherited: '' });
    expect(mixedTag(host, 'Tax Returns 2024')!.getAttribute('title')).toBe('Mixed: some folders inside are names only');
    expect(rowShows(host, 'Medical Records')).toEqual({ pressed: '', inherited: '' });
    const jumps = Array.from(doc(host).querySelectorAll('button.jump-btn')).map((node) => node.textContent);
    expect(jumps).toEqual(['Tax Returns 2024Full›', 'A folder inside Tax Returns 2024Names only›']);
    (doc(host).querySelector('button[data-key="picker:jump:k-deep"]') as unknown as HTMLButtonElement).click();
    await host.settle();
    expect(host.toolCalls(T.scopeList).slice(-3)).toEqual([
      { source_id: 'dropbox.files', parent_key: 'k-a' },
      { source_id: 'dropbox.files', parent_key: 'k-a2' },
      { source_id: 'dropbox.files', parent_key: 'k-deep' },
    ]);
    expect(doc(host).querySelector('.fpath')!.textContent).toBe('… / Divorce / Old Letters');
    expect(thisShows(host)).toEqual({ pressed: 'metadata_only', inherited: '' });
    host.button(Q.up).click();
    expect(rowShows(host, 'Old Letters')).toEqual({ pressed: 'metadata_only', inherited: '' });
    host.button(Q.up).click();
    host.button(Q.up).click();
    // Now loaded, the exception shows its name under its parent's.
    expect(doc(host).querySelector('button[data-key="picker:jump:k-deep"]')!.textContent).toBe('Divorce / Old LettersNames only›');
    openFolder(host, 'Tax Returns 2024');
    expect(rowShows(host, 'Therapy Notes')).toEqual({ pressed: '', inherited: 'ingest' });
    expectNamesOnlyInPicker(host);
  });

  test('Load more appends the next page and disappears at the end', async () => {
    const host = await openFolders();
    expect(host.text()).not.toContain('Kids Photos');
    host.button(Q.loadMore).click();
    await host.settle();
    expect(host.toolCalls(T.scopeList).at(-1)).toEqual({ source_id: 'dropbox.files', cursor: 'c1' });
    expect(host.text()).toContain('Kids Photos');
    expect(host.text()).toContain('Tax Returns 2024');
    expect(host.hasButton(Q.loadMore)).toBe(false);
  });

  test('Everything in Dropbox: Full asks for an inline confirmation before Save, every folder then inherits it, and a second tap turns it off', async () => {
    const host = await openFolders();
    const prompt = Q.wholePrompt.replace('{source}', 'Dropbox');
    thisSeg(host, 'ingest').click();
    expect(thisShows(host)).toEqual({ pressed: 'ingest', inherited: '' });
    expect(host.text()).toContain(prompt);
    (doc(host).querySelector('button[data-key="picker:whole:no"]') as unknown as HTMLButtonElement).click();
    expect(thisShows(host)).toEqual({ pressed: '', inherited: '' });
    expect(host.text()).not.toContain(prompt);
    thisSeg(host, 'ingest').click();
    expect(host.button(Q.saveFolders).disabled).toBe(true);
    expect(footer(host)).toContain(Q.needConfirm);
    expect(rowShows(host, 'Medical Records')).toEqual({ pressed: '', inherited: 'ingest' });
    expect(seg(host, 'Medical Records', 'ingest').getAttribute('aria-description')).toBe('Inherited from Everything in Dropbox');
    host.button(Q.wholeConfirm).click();
    expect(host.text()).not.toContain(prompt);
    expect(footer(host)).toContain(Q.summaryWhole.replace('{source}', 'Dropbox'));
    // A second tap turns the whole account off again.
    thisSeg(host, 'ingest').click();
    expect(thisShows(host)).toEqual({ pressed: '', inherited: '' });
    expect(rowShows(host, 'Medical Records')).toEqual({ pressed: '', inherited: '' });
    thisSeg(host, 'ingest').click();
    host.button(Q.wholeConfirm).click();
    host.serve[T.scopeSet] = () => SAVED;
    host.button(Q.saveFolders).click();
    expect(host.toolCalls(T.scopeSet)).toEqual([{
      source_id: 'dropbox.files', account_generation: 'g1', scope_revision: 'r1', selections: [],
      whole_account_selected: true, confirm_whole_account: true,
    }]);
  });

  test('explicit rules stop at 100, the most a save can carry, with an inline message', async () => {
    const selections = Array.from({ length: 100 }, (_, i) => ({ key: `k-x${i}`, state: 'metadata_only', ancestor_keys: ['k-z'] }));
    const host = await openFolders({ selections });
    expect(footer(host)).toContain(Q.capReached.replace('{max}', '100'));
    expect(seg(host, 'Medical Records', 'ingest').disabled).toBe(true);
    expect(seg(host, 'Medical Records', 'exclude').getAttribute('aria-description')).toBe(Q.capReached.replace('{max}', '100'));
    tap(host, 'Medical Records', 'exclude');
    expect(rowShows(host, 'Medical Records')).toEqual({ pressed: '', inherited: '' });
    host.serve[T.scopeSet] = () => SAVED;
    host.button(Q.saveFolders).click();
    expect(host.toolCalls(T.scopeSet).at(-1).selections.length).toBe(100);
  });

  test('a conflict re-lists and says the view was refreshed', async () => {
    const host = await openFolders();
    tap(host, 'Medical Records', 'metadata_only');
    const fresh = browse(ROOT, { scope_revision: 'r2', next_cursor: 'c1', selections: [{ key: 'k-b', state: 'exclude', ancestor_keys: [] }] });
    host.serve[T.scopeSet] = () => ({ structuredContent: { status: 'conflict', source_id: 'dropbox.files', current: fresh.structuredContent }, _meta: fresh._meta });
    host.serve[T.scopeList] = folderServer({ scope_revision: 'r2' });
    const listed = host.toolCalls(T.scopeList).length;
    host.button(Q.saveFolders).click();
    await host.settle();
    expect(host.text()).toContain(Q.conflict);
    // The conflict carried the fresh list, so nothing is listed again.
    expect(host.toolCalls(T.scopeList).length).toBe(listed);
    expect(rowShows(host, 'Medical Records')).toEqual({ pressed: 'exclude', inherited: '' });
    host.serve[T.scopeSet] = () => SAVED;
    tap(host, 'Medical Records', 'ingest');
    // The refreshed-view warning stays until the next save.
    expect(host.text()).toContain(Q.conflict);
    host.button(Q.saveFolders).click();
    expect(host.toolCalls(T.scopeSet).at(-1).scope_revision).toBe('r2');
  });

  test('a failed save keeps the choices and says so inline', async () => {
    const host = await openFolders();
    tap(host, 'Medical Records', 'ingest');
    host.serve[T.scopeSet] = () => ({ isError: true, content: [{ type: 'text', text: 'Medical Records failed' }] });
    host.button(Q.saveFolders).click();
    await host.settle();
    expect(host.text()).toContain(Q.saveFailed);
    expect(host.text()).not.toContain('Medical Records failed');
    expect(rowShows(host, 'Medical Records')).toEqual({ pressed: 'ingest', inherited: '' });
    host.serve[T.scopeSet] = () => 'fail';
    host.button(Q.saveFolders).click();
    await host.settle();
    expect(host.text()).toContain(Q.saveFailed);
  });

  test('picker data is read only from _meta, never from structuredContent', async () => {
    const leaky = browse(ROOT);
    const host = mount({ serve: { [T.scopeList]: () => ({ structuredContent: leaky._meta![CHATGPT_SCOPE_META_KEY] }) } });
    host.push({ structuredContent: pendingDropbox });
    host.button('Choose folders').click();
    await host.settle();
    expect(host.text()).toContain(Q.loadFailed);
    expect(host.text()).not.toContain('Tax Returns 2024');
  });

  test('a failed listing offers Try again', async () => {
    let first = true;
    const host = mount({ serve: { [T.scopeList]: (args) => (first ? ((first = false), 'fail') : folderServer()(args)) } });
    host.push({ structuredContent: pendingDropbox });
    host.button('Choose folders').click();
    await host.settle();
    expect(host.text()).toContain(Q.loadFailed);
    host.button(Q.tryAgain).click();
    await host.settle();
    expect(host.text()).toContain('Tax Returns 2024');
  });

  test('Back with unsaved choices confirms inline; Back to Olympus leaves no names behind', async () => {
    const host = await openFolders();
    tap(host, 'Medical Records', 'ingest');
    host.button(Q.back).click();
    expect(host.text()).toContain(Q.discardPrompt);
    escapeKey(host);
    expect(host.text()).not.toContain(Q.discardPrompt);
    expect(rowShows(host, 'Medical Records')).toEqual({ pressed: 'ingest', inherited: '' });
    host.button(Q.back).click();
    host.button(Q.discard).click();
    expect(host.text()).toContain('Sources');
    for (const name of NAMES) expect(host.text()).not.toContain(name);
    expect(focused(host)).toBe('primary:dropbox.files');
    expect(host.toolCalls(T.scopeSet)).toEqual([]);
    expectNamesOnlyInPicker(host);
  });
});

describe('folder picker: a real first run (45 folders, nothing chosen)', () => {
  const firstRunServer: Serve = (args) => browse(args.parent_key === FIRST_RUN_RESOURCES_KEY ? FIRST_RUN_RESOURCES : args.parent_key ? [] : FIRST_RUN_ROOT);
  const open = async () => {
    const host = mount({ serve: { [T.scopeList]: firstRunServer } });
    host.push({ structuredContent: pendingDropbox });
    host.button('Choose folders').click();
    await host.settle();
    return host;
  };
  const rows = (host: Host) => Array.from(host.win.document.querySelectorAll('li.seg-row')) as unknown as HTMLElement[];

  test('every folder is one quiet line: no repeated status text, nothing pressed or outlined, no Mixed, full names in the title', async () => {
    const host = await open();
    const all = rows(host);
    expect(all.length).toBe(45);
    expect(all.slice(0, 5).map((row) => row.querySelector('.fname-text')!.textContent)).toEqual(['0 Inbox', '1 Projects', '2 Areas', '3 Resources', '4 Archive']);
    for (const row of all) {
      expect(row.querySelectorAll('.seg-opt.on, .seg-opt.inherited, .ftag').length).toBe(0);
      expect(row.querySelectorAll('.seg-opt:disabled').length).toBe(0);
      const name = row.querySelector('.fname-text')!.textContent!;
      expect(row.querySelector('.fname')!.getAttribute('title')).toBe(name);
      // Only the ›, the name, the size and the file count are text; the control's words are its own.
      expect(row.querySelector('.fname')!.textContent!.replace(/^›/, '').startsWith(name)).toBe(true);
    }
    const text = host.text();
    expect(text).not.toContain(Q.notIncluded);
    expect(text).not.toContain(Q.mixed);
    expect(text).not.toContain(Q.connected.replace('{source}', 'Dropbox'));
    expect(host.win.document.querySelector('.exceptions')).toBeNull();
    expect(host.win.document.querySelectorAll('.this-row').length).toBe(1);
    expectNoJargon(host);
  });

  test('a choice is one tap from the list, and a level of 30 shows the parent\'s choice as inherited', async () => {
    const host = await open();
    const row = (name: string) => rows(host).find((node) => node.querySelector('.fname-text')!.textContent === name)!;
    (row('3 Resources').querySelector('.seg-opt[data-key$=":metadata_only"]') as unknown as HTMLButtonElement).click();
    (row('Camera Uploads').querySelector('.seg-opt[data-key$=":exclude"]') as unknown as HTMLButtonElement).click();
    (row('1 Projects').querySelector('.seg-opt[data-key$=":ingest"]') as unknown as HTMLButtonElement).click();
    expect(host.win.document.querySelector('.picker-footer')!.textContent).toContain('1 folder fully indexed, 1 with names only, 1 skipped · about 48.3 GB');
    expect(host.button(Q.saveFolders).disabled).toBe(false);
    (row('3 Resources').querySelector('.fopen') as unknown as HTMLButtonElement).click();
    await host.settle();
    expect(host.win.document.querySelector('.fpath')!.textContent).toBe('Dropbox / 3 Resources');
    expect(rows(host).length).toBe(30);
    for (const child of rows(host)) {
      expect(Array.from(child.querySelectorAll('.seg-opt.inherited')).map((node) => node.getAttribute('data-key')!.split(':').pop())).toEqual(['metadata_only']);
      expect((child.querySelector('.seg-opt[data-key$=":ingest"]') as unknown as HTMLButtonElement).disabled).toBe(true);
    }
    host.serve[T.scopeSet] = () => SAVED;
    host.button(Q.saveFolders).click();
    expect(host.toolCalls(T.scopeSet).at(-1).selections).toEqual([
      { key: FIRST_RUN_RESOURCES_KEY, state: 'metadata_only', ancestor_keys: [] },
      { key: 'fr-6', state: 'exclude', ancestor_keys: [] },
      { key: 'fr-1', state: 'ingest', ancestor_keys: [] },
    ]);
  });
});

describe('mail picker', () => {
  const MAIL = {
    kind: 'mail', source_id: 'gmail.email', account_generation: 'mg1', scope_revision: 'mr1', status: 'scope_pending',
    draft: { window: '2y', skipped_categories: ['promotions', 'social'], skipped_labels: [], always_private_senders: [], skip_senders: [] },
    labels: [{ id: 'Label_7', name: 'Therapy Notes', system: false }, { id: 'SENT', name: 'SENT', system: true }],
    categories: [{ category: 'primary', label: 'Primary', messages_total: 18234 }],
    sender_suggestions: [{ sender: 'boss@example.com', sample_messages: 12 }],
    estimate: { content_messages: 12400, metadata_messages: 30100, total_messages: 42500 },
  };
  const gmail = model({
    needsYou: [{ id: 'source:gmail.email', sentence: 'Gmail — choose which mail to read', fix: { label: 'Choose mail', tool: T.scopeList, args: { source_id: 'gmail.email' } } }],
    sources: [{ id: 'gmail.email', label: 'Gmail', group: 'cloud', status: 'Waiting' }],
  });

  test('window, categories, labels and senders save as one draft', async () => {
    const host = mount({ openai: {}, serve: { [T.scopeList]: () => scopeResult(MAIL), olympus_dashboard: () => ({ structuredContent: gmail }) } });
    host.push({ structuredContent: gmail });
    host.button('Choose mail').click();
    await host.settle();
    expect(host.toolCalls(T.scopeList)).toEqual([{ source_id: 'gmail.email' }]);
    expect(host.text()).toContain(Q.mailTitle);
    expect(host.text()).toContain('Therapy Notes');
    expect(host.text()).toContain('Sent');
    expect(host.text()).toContain('Personal mail · 18,234 in your mailbox');
    expect(host.text()).toContain('About 12,400 messages read in full and 30,100 by subject and sender only.');
    expect(host.text()).not.toContain('$');
    const pick = (key: string) => host.win.document.querySelector(`input[data-key="${key}"]`) as unknown as HTMLInputElement;
    pick('picker:window:1y').checked = true;
    pick('picker:window:1y').dispatchEvent(ev(host, 'change'));
    pick('picker:category:updates').checked = false;
    pick('picker:category:updates').dispatchEvent(ev(host, 'change'));
    pick('picker:label:0').checked = false;
    pick('picker:label:0').dispatchEvent(ev(host, 'change'));
    const area = host.win.document.querySelector('textarea[data-key="picker:senders:always_private_senders"]') as unknown as HTMLTextAreaElement;
    area.value = 'a@b.com\n\n a@b.com \n@clinic.example';
    area.dispatchEvent(ev(host, 'input'));
    expect(host.text()).toContain('Full text from the last year · 4 categories and labels skipped · 2 senders always private · 0 senders skipped');
    host.button(Q.mailSkip).click();
    expectNoJargon(host);
    host.button(Q.mailUpdateEstimate).click();
    const draft = {
      window: '1y',
      skipped_categories: ['promotions', 'social', 'updates'],
      skipped_labels: [{ id: 'Label_7', name: 'Therapy Notes' }],
      always_private_senders: ['a@b.com', '@clinic.example'],
      skip_senders: ['boss@example.com'],
    };
    expect(host.toolCalls(T.scopeList).at(-1)).toEqual({ source_id: 'gmail.email', draft });
    await host.settle();
    host.serve[T.scopeSet] = () => ({ structuredContent: { status: 'saved', source_id: 'gmail.email', scope_revision: 'mr2', indexing_started: true } });
    host.button(Q.saveMail).click();
    expect(host.toolCalls(T.scopeSet)).toEqual([{ source_id: 'gmail.email', account_generation: 'mg1', scope_revision: 'mr1', mail: draft }]);
    await host.settle();
    expect(host.text()).toContain('Gmail: saved. Olympus is starting.');
    expectNamesOnlyInPicker(host);
    expect(host.text()).not.toContain('Therapy Notes');
    expect(host.text()).not.toContain('boss@example.com');
  });

  test('a mail conflict re-lists with the saved scope', async () => {
    const host = mount({ serve: { [T.scopeList]: () => scopeResult(MAIL) } });
    host.push({ structuredContent: gmail });
    host.button('Choose mail').click();
    await host.settle();
    const fresh = scopeResult({ ...MAIL, scope_revision: 'mr9', draft: { ...MAIL.draft, window: '5y' } });
    host.serve[T.scopeSet] = () => ({ structuredContent: { status: 'conflict', source_id: 'gmail.email', current: fresh.structuredContent }, _meta: fresh._meta });
    host.button(Q.saveMail).click();
    await host.settle();
    expect(host.text()).toContain(Q.conflict);
    expect((host.win.document.querySelector('input[data-key="picker:window:5y"]') as unknown as HTMLInputElement).checked).toBe(true);
  });
});

describe('page rules', () => {
  test('picker styles add no nested scrolling, no external origins, and use the host theme tokens', () => {
    const html = chatgptDashboardPageHtml();
    for (const banned of ['http://', 'https://', 'window.confirm', 'confirm(', 'alert(', 'navigator.clipboard', 'console.', 'localStorage', 'setWidgetState', 'update-model-context']) {
      expect(html).not.toContain(banned);
    }
    // Clipping for an ellipsis only: nothing scrolls inside the page.
    expect(CHATGPT_DASHBOARD_CSS).not.toMatch(/(?<![-a-z])overflow(-[xy])?:(?!hidden)/);
    // Nothing is pinned: no sheet, no scrim, the footer sits in page flow.
    const pinned = CHATGPT_DASHBOARD_CSS.split('}').filter((rule) => /position:(sticky|fixed)/.test(rule)).map((rule) => rule.split('{')[0]!.trim());
    expect(pinned).toEqual([]);
    expect(CHATGPT_DASHBOARD_CSS).not.toContain('.choice{');
    expect(CHATGPT_DASHBOARD_CSS).not.toContain('.sheet');
    // No one-side accent stripe anywhere, and no underlined status text.
    expect(CHATGPT_DASHBOARD_CSS).not.toMatch(/border-(left|right):/);
    expect(CHATGPT_DASHBOARD_CSS).not.toContain('text-decoration:underline');
    // Thin rows: one line, at least 48px, segments at least 44px wide with a 44px tall hit area.
    expect(CHATGPT_DASHBOARD_CSS).toContain('.frow.seg-row{flex-direction:row;align-items:center;gap:0.25rem;min-height:3rem}');
    expect(CHATGPT_DASHBOARD_CSS).toMatch(/\.seg-opt\{[^}]*min-width:2\.75rem[^}]*height:2rem/);
    expect(CHATGPT_DASHBOARD_CSS).toContain('.seg-opt::before{content:"";position:absolute;inset:-0.4375rem 0}');
    // The drill-in button (› plus name) keeps a 44px tap target; the › column is narrow, with a small gap before the name.
    // The › sits in an 18px column outside the name's wrapping line, 5px before the name.
    expect(CHATGPT_DASHBOARD_CSS).toContain('.seg-row>.fname{position:relative;min-width:2.75rem;padding-left:1.4375rem;');
    expect(CHATGPT_DASHBOARD_CSS).toMatch(/\.seg-row>\.fname\{[^}]*height:2\.75rem/);
    expect(CHATGPT_DASHBOARD_CSS).toContain('.seg-row>.fname>.fopen,.seg-row>.fname>.fopen-gap{position:absolute;left:0;top:0;width:1.125rem;height:2.75rem;');
    // Every control sits flush at the right edge, the level's own row included.
    expect(CHATGPT_DASHBOARD_CSS).toContain('.seg-row>.seg{margin-left:auto}');
    expect(CHATGPT_DASHBOARD_CSS).toContain('.this-row>.seg{margin-left:auto}');
    expect(CHATGPT_DASHBOARD_CSS).toMatch(/\.this-row\{[^}]*padding:0\.25rem 0 0\.25rem 0\.75rem/);
    // Short segment labels below a 420px container.
    expect(CHATGPT_DASHBOARD_CSS).toContain('@container (max-width:26.25rem){.seg-long{display:none}.seg-short{display:inline}');
  });
});
