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
    expect(host.text()).toContain('Dropbox is connected.');
    expect(host.text()).toContain(Q.foldersTitle);
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
  const status = (host: Host, name: string) => {
    const found = Array.from(doc(host).querySelectorAll('button.fstatus'))
      .find((node) => String(node.getAttribute('aria-label')).startsWith(`Choice for ${name}: `));
    if (!found) throw new Error(`no status for ${name}`);
    return found as unknown as HTMLButtonElement;
  };
  const statusText = (host: Host, name: string) => status(host, name).textContent;
  const openFolder = (host: Host, name: string) => {
    const found = Array.from(doc(host).querySelectorAll('button.fname')).find((node) => node.querySelector('.fname-text')!.textContent === name);
    if (!found) throw new Error(`no folder button for ${name}`);
    (found as unknown as HTMLButtonElement).click();
  };
  const radio = (host: Host, value: string) => doc(host).querySelector(`input[data-key="picker:sheet:${value || 'parent'}"]`) as unknown as HTMLInputElement;
  const pick = (host: Host, value: string) => {
    const input = radio(host, value);
    input.checked = true;
    input.dispatchEvent(ev(host, 'change'));
  };
  const sheet = (host: Host) => doc(host).querySelector('.sheet')?.textContent ?? '';
  const footer = (host: Host) => doc(host).querySelector('.picker-footer')!.textContent!;
  const escapeKey = (host: Host) => doc(host).dispatchEvent(new host.win.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }) as any);
  const focused = (host: Host) => (doc(host).activeElement as any)?.getAttribute('data-key');
  const choose = (host: Host, name: string, value: string) => {
    status(host, name).click();
    pick(host, value);
    host.button(Q.done).click();
  };

  test('root: the whole-account row, the top-level folders with sizes, a disabled Save, and no <select> anywhere', async () => {
    const host = await openFolders({}, { displayMode: 'fullscreen' });
    const account = doc(host).querySelector('button.account')!;
    expect(account.textContent).toContain('Everything in Dropbox');
    expect(account.textContent).toContain(Q.notIncluded);
    expect(host.text()).toContain('Tax Returns 2024');
    expect(host.text()).toContain('2 GB · 1,200 files');
    expect(host.text()).toContain('500 MB · 1 file');
    expect(statusText(host, 'Medical Records')).toBe(Q.notIncluded);
    expect(host.text()).not.toContain('Therapy Notes');
    expect(host.text()).not.toContain('Exceptions');
    expect(footer(host)).toContain(Q.summaryNone);
    expect(host.button(Q.saveNoStart).disabled).toBe(true);
    expect(footer(host)).toContain(Q.needChoice);
    expect(doc(host).querySelectorAll('select').length).toBe(0);
    expect(doc(host).querySelectorAll('.tree, [aria-expanded]').length).toBe(0);
    // Each status is a real button, a separate target from the name.
    expect(status(host, 'Medical Records').tagName).toBe('BUTTON');
    expect(status(host, 'Medical Records').getAttribute('aria-haspopup')).toBe('dialog');
    expectNoJargon(host);
  });

  test('drilling in lists one level lazily, shows the path and This folder, and Back and Escape go up', async () => {
    const host = await openFolders();
    openFolder(host, 'Tax Returns 2024');
    await host.settle();
    expect(host.toolCalls(T.scopeList).at(-1)).toEqual({ source_id: 'dropbox.files', parent_key: 'k-a' });
    expect(doc(host).querySelector('.fpath')!.textContent).toBe('Dropbox / Tax Returns 2024');
    expect(doc(host).querySelector('.this-row')!.textContent).toContain(`${Q.thisFolder} ${Q.notIncluded}`);
    expect(host.text()).toContain('Therapy Notes');
    expect(host.text()).not.toContain('Medical Records');
    expect(focused(host)).toBe('picker:up');
    expect(host.button(Q.up).getAttribute('aria-label')).toBe('Back to Everything in Dropbox');
    host.button(Q.up).click();
    expect(host.text()).toContain('Medical Records');
    expect(focused(host)).toBe('picker:open:k-a');
    // Cached: the second visit lists nothing.
    const listed = host.toolCalls(T.scopeList).length;
    openFolder(host, 'Tax Returns 2024');
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

  test('the sheet: inherited text, Same as parent, Mixed derived from children, the footer counts, and the exact save payload', async () => {
    const host = await openFolders({}, { displayMode: 'fullscreen' });
    status(host, 'Tax Returns 2024').click();
    expect(doc(host).querySelectorAll('.sheet').length).toBe(1);
    expect(doc(host).querySelector('.sheet')!.getAttribute('role')).toBe('dialog');
    expect(doc(host).querySelector('.picker-body')!.hasAttribute('inert')).toBe(true);
    for (const state of ['ingest', 'metadata_only', 'exclude'] as const) {
      expect(sheet(host)).toContain(Q.states[state]);
      expect(sheet(host)).toContain(Q.consequences[state]);
    }
    expect(sheet(host)).toContain('Same as everything else (Not included)');
    expect(radio(host, '').checked).toBe(true);
    pick(host, 'ingest');
    expect(focused(host)).toBe('picker:sheet:ingest');
    host.button(Q.done).click();
    expect(doc(host).querySelector('.sheet')).toBeNull();
    expect(focused(host)).toBe('picker:choice:k-a');
    expect(statusText(host, 'Tax Returns 2024')).toBe('Fully indexed');
    openFolder(host, 'Tax Returns 2024');
    await host.settle();
    expect(statusText(host, 'Divorce')).toBe('Fully indexed · from Tax Returns 2024');
    expect(doc(host).querySelector('.this-row')!.textContent).toContain('Fully indexed');
    status(host, 'Therapy Notes').click();
    expect(sheet(host)).toContain('Inherited from Tax Returns 2024');
    expect(sheet(host)).toContain('Same as parent (Fully indexed)');
    pick(host, 'exclude');
    escapeKey(host);
    expect(doc(host).querySelector('.sheet')).toBeNull();
    expect(statusText(host, 'Therapy Notes')).toBe('Skipped');
    expect(doc(host).querySelector('.this-row')!.textContent).toContain('Fully indexed · Mixed: some skipped');
    host.button(Q.up).click();
    expect(statusText(host, 'Tax Returns 2024')).toBe('Fully indexed · Mixed: some skipped');
    const exceptions = doc(host).querySelector('.fsection')!.textContent!;
    expect(exceptions).toContain('Exceptions (2)');
    expect(exceptions).toContain('Therapy Notes');
    expect(footer(host)).toContain('1 folder fully indexed, 1 skipped · about 1 GB');
    const notifications = host.calls.filter(([name]) => name === 'notifyIntrinsicHeight').length;
    expect(notifications).toBeGreaterThan(5);
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

  test('Same as parent removes the rule; the sheet closes on an outside tap and never stacks', async () => {
    const host = await openFolders();
    choose(host, 'Medical Records', 'metadata_only');
    expect(statusText(host, 'Medical Records')).toBe('Names only');
    status(host, 'Medical Records').click();
    expect(() => status(host, 'Medical Records').click()).not.toThrow();
    expect(doc(host).querySelectorAll('.sheet').length).toBe(1);
    pick(host, '');
    (doc(host).querySelector('.scrim') as unknown as HTMLElement).click();
    expect(doc(host).querySelector('.sheet')).toBeNull();
    expect(statusText(host, 'Medical Records')).toBe(Q.notIncluded);
    expect(footer(host)).toContain(Q.summaryNone);
  });

  test('changing a parent keeps its children\'s own choices, and a stricter parent wins visibly', async () => {
    const host = await openFolders({
      selections: [
        { key: 'k-a', state: 'ingest', ancestor_keys: [] },
        { key: 'k-a1', state: 'metadata_only', ancestor_keys: ['k-a'] },
      ],
    });
    status(host, 'Tax Returns 2024').click();
    expect(sheet(host)).toContain('1 folder inside keeps its own choice.');
    pick(host, 'exclude');
    host.button(Q.done).click();
    openFolder(host, 'Tax Returns 2024');
    await host.settle();
    expect(statusText(host, 'Therapy Notes')).toBe('Skipped · from Tax Returns 2024');
    status(host, 'Therapy Notes').click();
    expect(sheet(host)).toContain('This folder is set to Names only, but Tax Returns 2024 is Skipped, which wins.');
    expect(radio(host, 'metadata_only').checked).toBe(true);
    expect(radio(host, 'ingest').disabled).toBe(true);
    expect(sheet(host)).toContain('Not possible while Tax Returns 2024 is skipped.');
    escapeKey(host);
    host.serve[T.scopeSet] = () => SAVED;
    host.button(Q.saveNoStart).click();
    expect(host.toolCalls(T.scopeSet).at(-1).selections).toEqual([
      { key: 'k-a', state: 'exclude', ancestor_keys: [] },
      { key: 'k-a1', state: 'metadata_only', ancestor_keys: ['k-a'] },
    ]);
  });

  test('a child under a Names only parent cannot be fully indexed', async () => {
    const host = await openFolders();
    choose(host, 'Tax Returns 2024', 'metadata_only');
    openFolder(host, 'Tax Returns 2024');
    await host.settle();
    status(host, 'Therapy Notes').click();
    const states = ['', 'ingest', 'metadata_only', 'exclude'].map((value) => [value, radio(host, value).disabled]);
    expect(states).toEqual([['', false], ['ingest', true], ['metadata_only', false], ['exclude', false]]);
  });

  test('saved deep choices: Mixed before anything is opened, and an exception jumps to its folder, loading each level once', async () => {
    const host = await openFolders({
      selections: [
        { key: 'k-a', state: 'ingest', ancestor_keys: [] },
        { key: 'k-deep', state: 'metadata_only', ancestor_keys: ['k-a', 'k-a2'] },
      ],
    });
    expect(statusText(host, 'Tax Returns 2024')).toBe('Fully indexed · Mixed: some names only');
    expect(statusText(host, 'Medical Records')).toBe(Q.notIncluded);
    const jumps = Array.from(doc(host).querySelectorAll('button.jump-btn')).map((node) => node.textContent);
    expect(jumps).toEqual(['Tax Returns 2024Fully indexed›', 'A folder inside Tax Returns 2024Names only›']);
    (doc(host).querySelector('button[data-key="picker:jump:k-deep"]') as unknown as HTMLButtonElement).click();
    await host.settle();
    expect(host.toolCalls(T.scopeList).slice(-3)).toEqual([
      { source_id: 'dropbox.files', parent_key: 'k-a' },
      { source_id: 'dropbox.files', parent_key: 'k-a2' },
      { source_id: 'dropbox.files', parent_key: 'k-deep' },
    ]);
    expect(doc(host).querySelector('.fpath')!.textContent).toBe('… / Divorce / Old Letters');
    expect(doc(host).querySelector('.this-row')!.textContent).toContain('Names only');
    host.button(Q.up).click();
    expect(statusText(host, 'Old Letters')).toBe('Names only');
    host.button(Q.up).click();
    expect(statusText(host, 'Therapy Notes')).toBe('Fully indexed · from Tax Returns 2024');
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

  test('the whole account is a choice on its own row and needs an explicit inline confirmation before Save', async () => {
    const host = await openFolders();
    (doc(host).querySelector('button.account') as unknown as HTMLButtonElement).click();
    expect(sheet(host)).toContain(Q.consequences.wholeIngest);
    pick(host, 'ingest');
    expect(sheet(host)).toContain(Q.wholePrompt.replace('{source}', 'Dropbox'));
    (doc(host).querySelector('button[data-key="picker:whole:no"]') as unknown as HTMLButtonElement).click();
    expect(radio(host, '').checked).toBe(true);
    pick(host, 'ingest');
    host.button(Q.done).click();
    // Still unconfirmed: the prompt stays on the root, and Save waits.
    expect(host.text()).toContain(Q.wholePrompt.replace('{source}', 'Dropbox'));
    expect(host.button(Q.saveFolders).disabled).toBe(true);
    expect(footer(host)).toContain(Q.needConfirm);
    expect(statusText(host, 'Medical Records')).toBe('Fully indexed · whole account');
    expect(doc(host).querySelector('button.account')!.textContent).toContain('Fully indexed');
    host.button(Q.wholeConfirm).click();
    expect(footer(host)).toContain(Q.summaryWhole.replace('{source}', 'Dropbox'));
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
    status(host, 'Medical Records').click();
    expect(radio(host, 'ingest').disabled).toBe(true);
    expect(radio(host, 'exclude').disabled).toBe(true);
    expect(sheet(host)).toContain(Q.capReached.replace('{max}', '100'));
    escapeKey(host);
    expect(statusText(host, 'Medical Records')).toBe(Q.notIncluded);
    host.serve[T.scopeSet] = () => SAVED;
    host.button(Q.saveFolders).click();
    expect(host.toolCalls(T.scopeSet).at(-1).selections.length).toBe(100);
  });

  test('a conflict re-lists and says the view was refreshed', async () => {
    const host = await openFolders();
    choose(host, 'Medical Records', 'metadata_only');
    const fresh = browse(ROOT, { scope_revision: 'r2', next_cursor: 'c1', selections: [{ key: 'k-b', state: 'exclude', ancestor_keys: [] }] });
    host.serve[T.scopeSet] = () => ({ structuredContent: { status: 'conflict', source_id: 'dropbox.files', current: fresh.structuredContent }, _meta: fresh._meta });
    host.serve[T.scopeList] = folderServer({ scope_revision: 'r2' });
    const listed = host.toolCalls(T.scopeList).length;
    host.button(Q.saveFolders).click();
    await host.settle();
    expect(host.text()).toContain(Q.conflict);
    // The conflict carried the fresh list, so nothing is listed again.
    expect(host.toolCalls(T.scopeList).length).toBe(listed);
    expect(statusText(host, 'Medical Records')).toBe('Skipped');
    host.serve[T.scopeSet] = () => SAVED;
    choose(host, 'Medical Records', 'ingest');
    host.button(Q.saveFolders).click();
    expect(host.toolCalls(T.scopeSet).at(-1).scope_revision).toBe('r2');
  });

  test('a failed save keeps the choices and says so inline', async () => {
    const host = await openFolders();
    choose(host, 'Medical Records', 'ingest');
    host.serve[T.scopeSet] = () => ({ isError: true, content: [{ type: 'text', text: 'Medical Records failed' }] });
    host.button(Q.saveFolders).click();
    await host.settle();
    expect(host.text()).toContain(Q.saveFailed);
    expect(host.text()).not.toContain('Medical Records failed');
    expect(statusText(host, 'Medical Records')).toBe('Fully indexed');
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
    choose(host, 'Medical Records', 'ingest');
    host.button(Q.back).click();
    expect(host.text()).toContain(Q.discardPrompt);
    escapeKey(host);
    expect(host.text()).not.toContain(Q.discardPrompt);
    expect(statusText(host, 'Medical Records')).toBe('Fully indexed');
    host.button(Q.back).click();
    host.button(Q.discard).click();
    expect(host.text()).toContain('Sources');
    for (const name of NAMES) expect(host.text()).not.toContain(name);
    expect(focused(host)).toBe('primary:dropbox.files');
    expect(host.toolCalls(T.scopeSet)).toEqual([]);
    expectNamesOnlyInPicker(host);
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
    expect(CHATGPT_DASHBOARD_CSS).not.toMatch(/overflow:|overflow-[xy]/);
    // The only pinned layers are the choice sheet (sticky to the bottom, in page flow) and its scrim.
    const pinned = CHATGPT_DASHBOARD_CSS.split('}').filter((rule) => /position:(sticky|fixed)/.test(rule)).map((rule) => rule.split('{')[0]!.trim());
    expect(pinned).toEqual(['.scrim', '.sheet']);
    expect(CHATGPT_DASHBOARD_CSS).not.toContain('.choice{');
  });
});
