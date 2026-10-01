/**
 * The ChatGPT page's in-place Connect flow and folder and mail pickers,
 * driven against a fake MCP Apps host that serves the dashboard, connect,
 * scope-list and scope-set tools over JSON-RPC postMessage.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import type { DashboardViewModelV1 } from '../src/workers/chatgpt/dashboard-contract.ts';
import { CHATGPT_DASHBOARD_CSS, chatgptDashboardPageHtml } from '../src/workers/dashboard/chatgpt/page.ts';
import { CHATGPT_PICKER_TOOLS } from '../src/workers/dashboard/chatgpt/picker.ts';
import { DASHBOARD_CHATGPT_PICKER_COPY as Q } from '../src/workers/dashboard/vocabulary.ts';

const T = CHATGPT_PICKER_TOOLS;
type Result = { structuredContent?: unknown; isError?: boolean; content?: unknown[] };
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
  select(name: string): HTMLSelectElement;
  push(result: unknown): void;
  toolCalls(name?: string): any[];
  settle(): Promise<void>;
}

const hosts: Host[] = [];
afterEach(async () => {
  while (hosts.length) await hosts.pop()!.win.happyDOM.close();
});

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function mount(options: { openai?: Record<string, any>; serve?: Record<string, Serve>; pollMs?: number; pollCapMs?: number } = {}): Host {
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
    select: (name) => {
      const found = win.document.querySelector(`select[aria-label="${Q.choiceFor.replace('{name}', name)}"]`);
      if (!found) throw new Error(`no choice for ${name}`);
      return found as unknown as HTMLSelectElement;
    },
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

const CONNECT_FIX = { label: 'Connect', tool: T.connectSource, args: { source: 'dropbox' } };
const CHOOSE_FIX = { label: 'Choose folders', tool: T.scopeList, args: { source_id: 'dropbox.files' } };
const offDropbox = model({ sources: [{ id: 'dropbox.files', label: 'Dropbox', group: 'cloud', status: 'Off', primary: CONNECT_FIX }] });
const pendingDropbox = model({ sources: [{ id: 'dropbox.files', label: 'Dropbox', group: 'cloud', status: 'Waiting', primary: CHOOSE_FIX }] });

// Private-looking names: they may appear only inside the picker view.
const NAMES = ['Tax Returns 2024', 'Medical Records', 'Therapy Notes', 'Divorce', 'Kids Photos'];
const node = (key: string, name: string, extra: Record<string, unknown> = {}) => ({ key, name, kind: 'folder', has_children: false, selectable: true, ...extra });
const ROOT = [
  node('k-a', 'Tax Returns 2024', { has_children: true, size_bytes: 2_000_000_000, file_count: 1200 }),
  node('k-b', 'Medical Records', { size_bytes: 500_000_000, file_count: 1 }),
];
const ROOT_PAGE_2 = [node('k-d', 'Kids Photos')];
const CHILDREN = [node('k-a1', 'Therapy Notes', { size_bytes: 1_000_000_000 }), node('k-a2', 'Divorce', { size_bytes: 300_000_000, has_children: true })];

function browse(nodes: unknown[], extra: Record<string, unknown> = {}) {
  return { structuredContent: { source_id: 'dropbox.files', account_generation: 'g1', scope_revision: 'r1', status: 'scope_pending', nodes, selections: [], whole_account_selected: false, ...extra } };
}

function folderServer(extra: Record<string, unknown> = {}): Serve {
  return (args) => {
    if (args.parent_key === 'k-a') return browse(CHILDREN, extra);
    if (args.parent_key === 'k-a2') return browse([], extra);
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

function expectNamesOnlyInPicker(host: Host, allowedIn: (message: any) => boolean = () => false) {
  for (const message of host.sent) {
    if (allowedIn(message)) continue;
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
        [T.connectSource]: () => ({ structuredContent: { authorizeUrl: 'https://mcp.olympusplugin.ai/go/abc123' } }),
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
    const host = mount({ serve: { [T.connectSource]: () => ({ structuredContent: { authorize_url: 'https://mcp.olympusplugin.ai/go/x1' } }), olympus_dashboard: () => 'hang' } });
    host.push({ structuredContent: offDropbox });
    host.button('Connect').click();
    await host.settle();
    expect(host.sent.find((message) => message.method === 'ui/open-link')!.params).toEqual({ url: 'https://mcp.olympusplugin.ai/go/x1' });
  });

  test('a link anywhere but the connect host\'s /go/ path is refused', async () => {
    for (const url of ['https://evil.example/go/abc', 'https://mcp.olympusplugin.ai/oauth/abc', 'http://mcp.olympusplugin.ai/go/abc']) {
      const host = mount({ openai: {}, serve: { [T.connectSource]: () => ({ structuredContent: { authorizeUrl: url } }) } });
      host.push({ structuredContent: offDropbox });
      host.button('Connect').click();
      await host.settle();
      expect(host.calls.some(([name]) => name === 'openExternal')).toBe(false);
      expect(host.text()).toContain(Q.connectFailed.replace('{source}', 'Dropbox'));
      expect(host.button('Try again').disabled).toBe(false);
    }
  });

  test('Cancel stops waiting and returns to the dashboard', async () => {
    const host = mount({ openai: {}, pollMs: 20, serve: { [T.connectSource]: () => ({ structuredContent: { url: 'https://mcp.olympusplugin.ai/go/a' } }), olympus_dashboard: () => ({ structuredContent: offDropbox }) } });
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
    const host = mount({ openai: {}, pollMs: 2, pollCapMs: 15, serve: { [T.connectSource]: () => ({ structuredContent: { url: 'https://mcp.olympusplugin.ai/go/a' } }), olympus_dashboard: () => ({ structuredContent: offDropbox }) } });
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
  test('lists one level, expands lazily, shows sizes, Mixed, inheritance and the footer, then saves the exact payload', async () => {
    const host = await openFolders({}, { displayMode: 'fullscreen' });
    expect(host.text()).toContain('Tax Returns 2024');
    expect(host.text()).toContain('2 GB · 1,200 files');
    expect(host.text()).toContain('500 MB · 1 file');
    expect(host.text()).not.toContain('Therapy Notes');
    expect(host.text()).toContain(Q.summaryNone);
    expect(host.button(Q.saveNoStart).disabled).toBe(true);
    expect(host.text()).toContain(Q.needChoice);
    // Expand: one scope_list for that folder only.
    const expand = host.win.document.querySelector(`button[aria-label="${Q.expand.replace('{name}', 'Tax Returns 2024')}"]`) as unknown as HTMLButtonElement;
    expect(expand.getAttribute('aria-expanded')).toBe('false');
    expand.click();
    await host.settle();
    expect(host.toolCalls(T.scopeList).at(-1)).toEqual({ source_id: 'dropbox.files', parent_key: 'k-a' });
    expect(host.text()).toContain('Therapy Notes');
    // Parent fully indexed: children inherit, visibly.
    const parent = host.select('Tax Returns 2024');
    parent.value = 'ingest';
    parent.dispatchEvent(new host.win.Event('change'));
    const divorceRow = () => host.select('Divorce').closest('.folder')!.textContent!;
    expect(divorceRow()).toContain('Fully indexed · inherited');
    expect(host.select('Divorce').options[0]!.textContent).toBe('Same as its parent (Fully indexed)');
    // A child that differs makes the parent Mixed.
    const child = host.select('Therapy Notes');
    child.value = 'exclude';
    child.dispatchEvent(new host.win.Event('change'));
    expect(host.select('Tax Returns 2024').closest('.folder')!.textContent).toContain('Mixed');
    const footer = host.win.document.querySelector('.picker-footer')!.textContent!;
    expect(footer).toContain('1 folder fully indexed, 1 skipped.');
    expect(footer).toContain('About 1 GB will be fully indexed.');
    // Focus stays on the control just changed.
    expect((host.win.document.activeElement as any).getAttribute('data-key')).toBe('picker:choice:k-a1');
    const notifications = host.calls.filter(([name]) => name === 'notifyIntrinsicHeight').length;
    expect(notifications).toBeGreaterThan(3);
    expectNoJargon(host);
    host.serve[T.scopeSet] = () => browse(ROOT, { status: 'approved', scope_revision: 'r2' });
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
    // Back on the dashboard, refreshed, with a notice and no folder names anywhere.
    expect(host.text()).toContain('Dropbox: saved. Olympus is starting.');
    expect(host.toolCalls('olympus_dashboard').length).toBe(1);
    for (const name of NAMES) expect(host.text()).not.toContain(name);
    expectNamesOnlyInPicker(host);
  });

  test('a child under a Names only or Skipped parent cannot be fully indexed', async () => {
    const host = await openFolders();
    (host.win.document.querySelector('button[aria-expanded]') as unknown as HTMLButtonElement).click();
    await host.settle();
    const parent = host.select('Tax Returns 2024');
    parent.value = 'metadata_only';
    parent.dispatchEvent(new host.win.Event('change'));
    const options = Array.from(host.select('Therapy Notes').options).map((option) => [option.value, option.disabled]);
    expect(options).toEqual([['', false], ['ingest', true], ['metadata_only', false], ['exclude', false]]);
  });

  test('saved choices with deep ancestors show Mixed before anything is expanded', async () => {
    const host = await openFolders({
      selections: [
        { key: 'k-a', state: 'ingest', ancestor_keys: [] },
        { key: 'k-deep', state: 'metadata_only', ancestor_keys: ['k-a', 'k-a2'] },
      ],
    });
    expect(host.select('Tax Returns 2024').value).toBe('ingest');
    expect(host.select('Tax Returns 2024').closest('.folder')!.textContent).toContain('Mixed');
    expect(host.select('Medical Records').closest('.folder')!.textContent).toContain('Not selected');
    (host.win.document.querySelector('button[aria-expanded]') as unknown as HTMLButtonElement).click();
    await host.settle();
    expect(host.select('Divorce').closest('.folder')!.textContent).toContain('Mixed');
    expect(host.select('Therapy Notes').closest('.folder')!.textContent).toContain('Fully indexed · inherited');
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

  test('search filters the listed folders in place and keeps parents of matches', async () => {
    const host = await openFolders();
    (host.win.document.querySelector('button[aria-expanded]') as unknown as HTMLButtonElement).click();
    await host.settle();
    const input = host.win.document.querySelector('input[type=search]') as unknown as HTMLInputElement;
    input.value = 'therapy';
    input.dispatchEvent(new host.win.Event('input'));
    const visible = () => Array.from(host.win.document.querySelectorAll('.folder-item'))
      .filter((li) => !(li as unknown as HTMLElement).hidden && !(li.parentElement!.closest('.folder-item') as unknown as HTMLElement | null)?.hidden)
      .map((li) => li.querySelector('.folder-name')!.textContent);
    expect(visible()).toEqual(['Tax Returns 2024', 'Therapy Notes']);
    const empty = () => (host.win.document.querySelector('.search-empty') as unknown as HTMLElement).hidden;
    expect(empty()).toBe(true);
    input.value = 'nothing like this';
    input.dispatchEvent(new host.win.Event('input'));
    expect(visible()).toEqual([]);
    expect(empty()).toBe(false);
    // The search survives a re-render.
    const choice = host.select('Medical Records');
    choice.value = 'ingest';
    choice.dispatchEvent(new host.win.Event('change'));
    expect((host.win.document.querySelector('input[type=search]') as unknown as HTMLInputElement).value).toBe('nothing like this');
    expect(empty()).toBe(false);
  });

  test('the entire account needs an explicit inline confirmation before Save', async () => {
    const host = await openFolders();
    const whole = host.win.document.querySelector('input[data-key="picker:whole"]') as unknown as HTMLInputElement;
    whole.checked = true;
    whole.dispatchEvent(new host.win.Event('change'));
    expect(host.text()).toContain(Q.wholePrompt.replace('{source}', 'Dropbox'));
    expect(host.button(Q.saveFolders).disabled).toBe(true);
    expect(host.text()).toContain(Q.needConfirm);
    expect(host.select('Medical Records').closest('.folder')!.textContent).toContain('Fully indexed · inherited');
    expect(host.select('Medical Records').options[0]!.textContent).toBe('Same as the entire account (Fully indexed)');
    host.button(Q.cancel).click();
    expect((host.win.document.querySelector('input[data-key="picker:whole"]') as unknown as HTMLInputElement).checked).toBe(false);
    const again = host.win.document.querySelector('input[data-key="picker:whole"]') as unknown as HTMLInputElement;
    again.checked = true;
    again.dispatchEvent(new host.win.Event('change'));
    host.button(Q.wholeConfirm).click();
    expect(host.text()).toContain(Q.wholeConfirmed);
    expect(host.text()).toContain(Q.summaryWhole);
    host.serve[T.scopeSet] = () => browse(ROOT, { whole_account_selected: true, scope_revision: 'r2' });
    host.button(Q.saveFolders).click();
    expect(host.toolCalls(T.scopeSet)).toEqual([{
      source_id: 'dropbox.files', account_generation: 'g1', scope_revision: 'r1', selections: [],
      whole_account_selected: true, explicit_whole_account_confirmation: true,
    }]);
  });

  test('a conflict re-lists and says the view was refreshed', async () => {
    const host = await openFolders();
    const choice = host.select('Medical Records');
    choice.value = 'metadata_only';
    choice.dispatchEvent(new host.win.Event('change'));
    host.serve[T.scopeSet] = () => ({ structuredContent: { conflict: true, scope_revision: 'r2' } });
    host.serve[T.scopeList] = folderServer({ scope_revision: 'r2', selections: [{ key: 'k-b', state: 'exclude', ancestor_keys: [] }] });
    host.button(Q.saveFolders).click();
    await host.settle();
    expect(host.text()).toContain(Q.conflict);
    expect(host.toolCalls(T.scopeList).at(-1)).toEqual({ source_id: 'dropbox.files' });
    expect(host.select('Medical Records').value).toBe('exclude');
    host.serve[T.scopeSet] = () => browse(ROOT, { scope_revision: 'r3' });
    const again = host.select('Medical Records');
    again.value = 'ingest';
    again.dispatchEvent(new host.win.Event('change'));
    host.button(Q.saveFolders).click();
    expect(host.toolCalls(T.scopeSet).at(-1).scope_revision).toBe('r2');
  });

  test('a failed save keeps the choices and says so inline', async () => {
    const host = await openFolders();
    const choice = host.select('Medical Records');
    choice.value = 'ingest';
    choice.dispatchEvent(new host.win.Event('change'));
    host.serve[T.scopeSet] = () => ({ isError: true, content: [{ type: 'text', text: 'Medical Records failed' }] });
    host.button(Q.saveFolders).click();
    await host.settle();
    expect(host.text()).toContain(Q.saveFailed);
    expect(host.text()).not.toContain('Medical Records failed');
    expect(host.select('Medical Records').value).toBe('ingest');
    host.serve[T.scopeSet] = () => 'fail';
    host.button(Q.saveFolders).click();
    await host.settle();
    expect(host.text()).toContain(Q.saveFailed);
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
    const choice = host.select('Medical Records');
    choice.value = 'ingest';
    choice.dispatchEvent(new host.win.Event('change'));
    host.button(Q.back).click();
    expect(host.text()).toContain(Q.discardPrompt);
    host.button(Q.keep).click();
    expect(host.select('Medical Records').value).toBe('ingest');
    host.button(Q.back).click();
    host.button(Q.discard).click();
    expect(host.text()).toContain('Sources');
    for (const name of NAMES) expect(host.text()).not.toContain(name);
    expect((host.win.document.activeElement as any).getAttribute('data-key')).toBe('primary:dropbox.files');
    expect(host.toolCalls(T.scopeSet)).toEqual([]);
  });
});

describe('mail picker', () => {
  const MAIL = {
    source_id: 'gmail.email', account_generation: 'mg1', scope_revision: 'mr1', status: 'scope_pending',
    scope: { window: '2y', skipped_categories: ['promotions', 'social'], skipped_labels: [], always_private_senders: [], skip_senders: [] },
    labels: [{ id: 'Label_7', name: 'Therapy Notes', system: false }, { id: 'SENT', name: 'SENT', system: true }],
    categories: [{ category: 'primary', label: 'Primary', messages_total: 18234 }],
    sender_suggestions: [{ sender: 'boss@example.com', sample_messages: 12 }],
    sample_size: 200,
    estimate: { estimate: true, content_messages: 12400, metadata_messages: 30100, total_messages: 42500, embedding_tokens: 1, embedding_cost_usd: 1.5 },
  };
  const gmail = model({
    needsYou: [{ id: 'source:gmail.email', sentence: 'Gmail — choose which mail to read', fix: { label: 'Choose mail', tool: T.scopeList, args: { source_id: 'gmail.email' } } }],
    sources: [{ id: 'gmail.email', label: 'Gmail', group: 'cloud', status: 'Waiting' }],
  });

  test('window, categories, labels and senders save as one draft', async () => {
    const host = mount({ openai: {}, serve: { [T.scopeList]: () => ({ structuredContent: MAIL }), olympus_dashboard: () => ({ structuredContent: gmail }) } });
    host.push({ structuredContent: gmail });
    host.button('Choose mail').click();
    await host.settle();
    expect(host.toolCalls(T.scopeList)).toEqual([{ source_id: 'gmail.email' }]);
    expect(host.text()).toContain(Q.mailTitle);
    expect(host.text()).toContain('Therapy Notes');
    expect(host.text()).toContain('Sent');
    expect(host.text()).toContain('Personal mail · 18,234 in your mailbox');
    expect(host.text()).toContain('About 12,400 messages read in full and 30,100 by subject and sender only.');
    expect(host.text()).toContain('Indexing costs at most $1.50.');
    const pick = (key: string) => host.win.document.querySelector(`input[data-key="${key}"]`) as unknown as HTMLInputElement;
    pick('picker:window:1y').checked = true;
    pick('picker:window:1y').dispatchEvent(new host.win.Event('change'));
    pick('picker:category:updates').checked = false;
    pick('picker:category:updates').dispatchEvent(new host.win.Event('change'));
    pick('picker:label:0').checked = false;
    pick('picker:label:0').dispatchEvent(new host.win.Event('change'));
    const area = host.win.document.querySelector('textarea[data-key="picker:senders:always_private_senders"]') as unknown as HTMLTextAreaElement;
    area.value = 'a@b.com\n\n a@b.com \n@clinic.example';
    area.dispatchEvent(new host.win.Event('input'));
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
    // The estimate carries label ids only; names go out only with the save.
    expect(host.toolCalls(T.scopeList).at(-1)).toEqual({ source_id: 'gmail.email', draft: { ...draft, skipped_labels: [{ id: 'Label_7' }] } });
    await host.settle();
    host.serve[T.scopeSet] = () => ({ structuredContent: { ...MAIL, status: 'approved', scope_revision: 'mr2' } });
    host.button(Q.saveMail).click();
    expect(host.toolCalls(T.scopeSet)).toEqual([{ source_id: 'gmail.email', account_generation: 'mg1', scope_revision: 'mr1', scope: draft }]);
    await host.settle();
    expect(host.text()).toContain('Gmail: saved. Olympus is starting.');
    // The label name left the page only inside scope_set (the contract carries id and name).
    expectNamesOnlyInPicker(host, (message) => message.method === 'tools/call' && message.params.name === T.scopeSet);
    expect(host.text()).not.toContain('Therapy Notes');
    expect(host.text()).not.toContain('boss@example.com');
  });

  test('a mail conflict re-lists with the saved scope', async () => {
    const host = mount({ serve: { [T.scopeList]: () => ({ structuredContent: MAIL }) } });
    host.push({ structuredContent: gmail });
    host.button('Choose mail').click();
    await host.settle();
    host.serve[T.scopeSet] = () => ({ isError: true, structuredContent: { error: { code: 'scope_conflict' }, scope_revision: 'mr9' } });
    host.serve[T.scopeList] = () => ({ structuredContent: { ...MAIL, scope_revision: 'mr9', scope: { ...MAIL.scope, window: '5y' } } });
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
    expect(CHATGPT_DASHBOARD_CSS).not.toMatch(/overflow:|overflow-[xy]|position:sticky|position:fixed/);
    expect(CHATGPT_DASHBOARD_CSS).toContain('.choice{font:inherit');
  });
});
