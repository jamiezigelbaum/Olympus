// The Archives row in the dashboard panel, against a fake host: on the
// computer, Import an archive opens the picker in place (files beside
// folders), Import approves the choice and the row says what came of it, a
// refusal stays in the picker with the engine's reason; each archive's state
// renders with its way forward (Set up the private model, See what was not
// imported and how it was read, Remove with confirmation); an agent's request waits for Import or
// Decline. What needs the person (a stopped import, an agent's request,
// held messages no private model can judge, a list that cannot be read) is
// a Needs you line on both surfaces: on the computer its button goes to that
// archive or request in place; in ChatGPT it opens the computer's Archives
// row. In ChatGPT the row's Import an archive opens the computer's dashboard
// and no list is drawn. Every name here is invented.

import { afterEach, describe, expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import {
  ARCHIVE_APPROVE_TOOL_NAME,
  ARCHIVE_DECLINE_TOOL_NAME,
  ARCHIVE_REMOVE_TOOL_NAME,
  ARCHIVE_STOP_TOOL_NAME,
  ARCHIVE_UPLOAD_CANCEL_TOOL_NAME,
  ARCHIVE_UPLOAD_START_TOOL_NAME,
  ARCHIVE_UPLOAD_STATUS_TOOL_NAME,
  COMPUTER_META_KEY,
  DASHBOARD_TOOL_NAME,
  DELETE_SOURCE_DATA_TOOL_NAME,
  OLYMPUS_HOST_CONTEXT_KEY,
  type ComputerArchiveEntry,
  type ComputerArchivesMeta,
  type ComputerSourceImportEntry,
  type ComputerSourceImportsMeta,
} from '../src/workers/chatgpt/dashboard-contract.ts';
import { ARCHIVE_COMMON_FINDINGS } from '../src/core/archive-formats.ts';
import { chatgptDashboardPageHtml } from '../src/workers/dashboard/chatgpt/page.ts';
import { DASHBOARD_ARCHIVE_COPY as A } from '../src/workers/dashboard/vocabulary.ts';
import { ARCHIVE_APPROVE_COPY, ARCHIVE_NOT_RUNNING_COPY } from '../src/workers/archive-import/dashboard.ts';
import { DASHBOARD_PREVIEW_STATES, previewArchiveApprove, previewArchiveUploads, previewDashboardToolResult } from '../scripts/dashboard-preview.ts';
import { DASHBOARD_CHATGPT_PAGE_COPY } from '../src/workers/dashboard/vocabulary.ts';

type Message = { jsonrpc?: string; id?: number; method?: string; params?: any };
type Serve = Record<string, (args: any) => unknown>;

interface Page {
  win: Window;
  sent: Message[];
  doc: Document;
  text(): string;
  buttons(): HTMLButtonElement[];
  button(label: string): HTMLButtonElement;
  hasButton(label: string): boolean;
  calls(name?: string): Array<{ name: string; arguments: any }>;
  /** The files the panel handed the host page to send (olympus/upload-file), and the aborts it announced. */
  uploads(): Array<{ upload_id: string; path: string; modified: number; file: File }>;
  aborts(): string[];
}

const windows: Window[] = [];
afterEach(async () => {
  while (windows.length) await windows.pop()!.happyDOM.close();
});
const settle = (ms = 10) => new Promise((resolve) => setTimeout(resolve, ms));
/**
 * Wait until the page shows what a click leads to: its tool call and the
 * dashboard read after it take longer on a loaded machine than a fixed sleep.
 * Gives up after `ms`, so the assertion that follows says what is missing.
 */
async function until(ready: () => boolean, ms = 3000): Promise<void> {
  const end = Date.now() + ms;
  while (!ready() && Date.now() < end) await settle(10);
}

/**
 * The engine's side of a dropped file as the preview keeps it (previewArchiveUploads): an upload is begun, and the host
 * page's files are noted by name, so the approval can say what was dropped. The host page itself is the mount's `upload`.
 */
function uploadServe(): Serve {
  return {
    [ARCHIVE_UPLOAD_START_TOOL_NAME]: () => ({ content: [{ type: 'text', text: 'Ready.' }], structuredContent: { status: 'started', upload_id: previewArchiveUploads.start() } }),
    [ARCHIVE_UPLOAD_STATUS_TOOL_NAME]: () => ({ content: [{ type: 'text', text: 'Receiving.' }], structuredContent: { status: 'receiving', files: 0, bytes: 0 } }),
    [ARCHIVE_UPLOAD_CANCEL_TOOL_NAME]: (args) => {
      previewArchiveUploads.cancel(String(args.upload_id));
      return { content: [{ type: 'text', text: 'Cancelled.' }], structuredContent: { status: 'cancelled' } };
    },
  };
}
/** The host page noting each file in the preview's uploads, as the engine's route does. */
const noteUploads = (params: { upload_id: string; path: string; file: File }) => {
  previewArchiveUploads.receive(params.upload_id, params.path, params.file.size);
  return { ok: true };
};

type Chosen = { path: string; text?: string };
/** What the system's dialog hands the panel: files in the input (a folder's carry their path under the folder). */
function choose(page: Page, key: 'picker:drop:file-input' | 'picker:drop:folder-input', files: Chosen[]): void {
  const input = page.doc.querySelector(`[data-key="${key}"]`) as HTMLInputElement | null;
  if (!input) throw new Error(`no ${key} in: ${page.text()}`);
  const list = files.map((entry) => {
    const file = new page.win.File([entry.text ?? 'content'], entry.path.split('/').pop()!);
    Object.defineProperty(file, 'webkitRelativePath', { value: key === 'picker:drop:folder-input' ? entry.path : '' });
    return file;
  });
  Object.defineProperty(input, 'files', { value: list, configurable: true });
  input.dispatchEvent(new page.win.Event('change', { bubbles: true }) as unknown as Event);
}

type Fake = { name: string; text?: string; children?: Fake[]; unreadable?: true };
/** A dragged file or folder as the browser's entries API shows it. */
function entryOf(win: Window, node: Fake): any {
  if (!node.children) {
    return {
      isFile: true, isDirectory: false, name: node.name,
      file: (done: (file: File) => void, fail: (error: Error) => void) => (node.unreadable ? fail(new Error('NotReadableError')) : done(new win.File([node.text ?? 'content'], node.name) as unknown as File)),
    };
  }
  return {
    isFile: false, isDirectory: true, name: node.name,
    createReader: () => {
      let given = false;
      return { readEntries: (done: (batch: any[]) => void) => { done(given ? [] : node.children!.map((child) => entryOf(win, child))); given = true; } };
    },
  };
}
/** Drops these on the zone, with what the browser's DataTransfer holds. */
function dropOnZone(page: Page, dropped: Fake[], phase: 'enter' | 'drop' = 'drop'): HTMLElement {
  const zone = page.doc.querySelector('[data-key="picker:drop:zone"]') as HTMLElement | null;
  if (!zone) throw new Error(`no drop zone in: ${page.text()}`);
  const send = (type: string) => {
    const event = new page.win.Event(type, { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'dataTransfer', {
      value: { dropEffect: '', files: [], items: dropped.map((node) => ({ kind: 'file', webkitGetAsEntry: () => entryOf(page.win, node) })) },
    });
    zone.dispatchEvent(event as unknown as Event);
    return event;
  };
  if (phase === 'enter') send('dragenter');
  else {
    send('dragenter');
    send('drop');
  }
  return zone;
}

const LINKS = {
  keys: 'http://127.0.0.1:8787/dashboard?keys',
  agents: 'http://127.0.0.1:8787/dashboard?agents',
  privateAnswers: 'http://127.0.0.1:8787/dashboard?private-answers',
  connector: 'http://127.0.0.1:8787/dashboard?connector',
};
const COMPUTER = { kind: 'computer', readOnly: false, links: LINKS };

/** The panel on a host that answers its tool calls from `serve`; `computer: false` is ChatGPT. */
async function mount(serve: Serve, options: {
  computer?: boolean;
  /** The computer host's own context, in place of the plain one (a landing, say). */
  host?: Record<string, unknown>;
  dashboard?: () => unknown;
  /** The host page's side of one file: its answer, after any progress it reports. Default: the file arrived. */
  upload?: (params: { upload_id: string; path: string; modified: number; file: File }, progress: (loaded: number) => void) => unknown;
} = {}): Promise<Page> {
  const computer = options.computer !== false;
  const html = chatgptDashboardPageHtml({ resultTimeoutMs: 5_000 });
  const start = html.indexOf('<script>') + '<script>'.length;
  const script = html.slice(start, html.indexOf('</script>', start));
  const win = new Window({ url: 'https://sandbox.test/' });
  windows.push(win);
  win.document.write(html.slice(0, start - '<script>'.length) + html.slice(html.indexOf('</script>', start) + '</script>'.length));
  const sent: Message[] = [];
  const dispatch = (data: unknown) => win.dispatchEvent(new win.MessageEvent('message', { data, source: parent as any }));
  const reply = (id: number, result: unknown) => setTimeout(() => dispatch({ jsonrpc: '2.0', id, result }), 0);
  const parent = {
    postMessage: (message: Message) => {
      sent.push(message);
      if (message.id === undefined) return;
      if (message.method === 'ui/initialize') {
        reply(message.id, {
          protocolVersion: '2026-01-26',
          hostContext: { theme: 'light', displayMode: 'fullscreen', availableDisplayModes: ['fullscreen'], ...(computer ? { [OLYMPUS_HOST_CONTEXT_KEY]: options.host ?? COMPUTER } : {}) },
        });
      } else if (message.method === 'tools/call') {
        const handler = serve[message.params.name];
        // A handler may answer later, or fail (a JSON-RPC error), as the host does.
        const id = message.id;
        if (handler) {
          Promise.resolve().then(() => handler(message.params.arguments ?? {})).then(
            (result) => reply(id, result),
            (error) => setTimeout(() => dispatch({ jsonrpc: '2.0', id, error: { code: -32000, message: String(error) } }), 0),
          );
        }
      } else if (message.method === 'ui/open-link') reply(message.id, {});
      else if (message.method === 'olympus/upload-file') {
        const progress = (loaded: number) => dispatch({ jsonrpc: '2.0', method: 'olympus/upload-progress', params: { request: message.id, loaded } });
        const answer = options.upload ? options.upload(message.params, progress) : { ok: true };
        Promise.resolve(answer).then((result) => dispatch({ jsonrpc: '2.0', id: message.id, result }));
      }
    },
  };
  Object.defineProperty(win, 'parent', { value: parent, configurable: true });
  new Function('window', 'document', script)(win, win.document);
  await settle();
  if (!computer && options.dashboard) {
    // ChatGPT pushes the dashboard tool's result; it has no computer meta.
    dispatch({ jsonrpc: '2.0', method: 'ui/notifications/tool-result', params: options.dashboard() });
  }
  await settle(20);
  const buttons = () => Array.from(win.document.querySelectorAll('#app button')) as unknown as HTMLButtonElement[];
  const page: Page = {
    win,
    sent,
    doc: win.document as unknown as Document,
    text: () => win.document.getElementById('app')!.textContent ?? '',
    buttons,
    button: (label) => {
      const found = buttons().find((node) => node.textContent === label || node.getAttribute('aria-label') === label);
      if (!found) throw new Error(`no button "${label}" in: ${buttons().map((b) => b.textContent).join(' | ')}`);
      return found;
    },
    hasButton: (label) => buttons().some((node) => node.textContent === label || node.getAttribute('aria-label') === label),
    calls: (name) => sent
      .filter((message) => message.method === 'tools/call' && (!name || message.params.name === name))
      .map((message) => message.params),
    uploads: () => sent.filter((message) => message.method === 'olympus/upload-file').map((message) => message.params),
    aborts: () => sent.filter((message) => message.method === 'olympus/upload-abort').map((message) => message.params.upload_id),
  };
  return page;
}

/** The preview state exactly: its card (with its Needs you lines) and its own list in the computer's meta. */
function previewState(state: string) {
  return previewDashboardToolResult(state, false) as { _meta: Record<string, any> };
}

/** The Needs you section's lines, by sentence. */
function needsYou(page: Page): Map<string, Element> {
  const heading = Array.from(page.doc.querySelectorAll('h2')).find((node) => node.textContent === 'Needs you');
  const rows = heading ? Array.from(heading.parentElement!.querySelectorAll('li.row.need')) : [];
  return new Map(rows.map((row) => [row.querySelector('.row-text')?.textContent ?? '', row]));
}

/** The dashboard tool's answer: the engine's own Archives row for a state, with this list in the computer's meta. */
function dashboard(state: string, archives?: ComputerArchivesMeta) {
  const result = previewDashboardToolResult(state, false) as { _meta: Record<string, any> };
  const meta = { ...result._meta[COMPUTER_META_KEY] };
  if (archives) meta.archives = archives;
  else delete meta.archives;
  return { ...result, _meta: { ...result._meta, [COMPUTER_META_KEY]: meta } };
}

function fill(template: string, values: Record<string, string>): string {
  let out = template;
  for (const [key, value] of Object.entries(values)) out = out.split(`{${key}}`).join(value);
  return out;
}

const ARCHIVE: ComputerArchiveEntry = {
  id: '6a1f0e2d-4c3b-4a59-8e7d-1b2c3d4e5f60',
  name: 'Old work mail.mbox',
  format: 'Mail (mbox)',
  family: 'email',
  where: '~/Exports',
  status: 'imported',
  items: 1_250,
  judged: 1_240,
  held: 10,
  earliest: '2011-02-03',
  latest: '2019-12-30',
  startedAt: '2026-10-22T08:00:00.000Z',
  importedAt: '2026-10-22T09:00:00.000Z',
  gaps: [],
  skipped: [],
};

/** The same archive before it finished. */
const { importedAt: _importedAt, ...STARTED } = ARCHIVE;

function meta(archives: ComputerArchiveEntry[], requests: ComputerArchivesMeta['requests'] = [], privateModel: ComputerArchivesMeta['privateModel'] = 'ready'): ComputerArchivesMeta {
  return { sourceId: 'archive.imports', archives, requests, privateModel };
}

function archiveItem(page: Page, status: string): Element {
  const found = page.doc.querySelector(`li.archive[data-archive="${status}"]`);
  if (!found) throw new Error(`no ${status} archive in: ${page.text()}`);
  return found;
}

/** The two lists under an archive's See button: the button, and each list's heading with its lines (empty when the list is not there). */
function archiveLists(item: Element): { button: string | undefined; notImported: string[]; howRead: string[]; heads: string[] } {
  const why = item.querySelector('details.why');
  const heads = Array.from(why?.querySelectorAll('.why-head') ?? []).map((node) => node.textContent ?? '');
  const under = (head: string): string[] => {
    const node = Array.from(why?.querySelectorAll('.why-head') ?? []).find((candidate) => candidate.textContent === head);
    const list = node?.nextElementSibling;
    return list && list.matches('ul.plain') ? Array.from(list.querySelectorAll('li')).map((line) => line.textContent ?? '') : [];
  };
  return {
    button: why?.querySelector('summary')?.textContent ?? undefined,
    notImported: under(A.lists.notImported),
    howRead: under(A.lists.howRead),
    heads,
  };
}

describe('Import an archive on the computer', () => {
  test('opens the drop zone in place; a chosen file is uploaded, the approval names the upload, and the row says it started', async () => {
    let answer = dashboard('archives-none', meta([]));
    const page = await mount({
      [DASHBOARD_TOOL_NAME]: () => answer,
      ...uploadServe(),
      [ARCHIVE_APPROVE_TOOL_NAME]: (args) => previewArchiveApprove(args),
    }, { upload: noteUploads });
    expect(page.text()).toMatch(/No archives imported yet/i);
    page.button(A.importAction).click();
    await settle();
    // In place, never a link out; the zone says what it is, and what is to be dropped.
    expect(page.sent.some((message) => message.method === 'ui/open-link')).toBe(false);
    expect(page.text()).toContain(A.pick.intro);
    expect(page.text()).toContain(A.pick.zone);
    expect(page.text()).toContain(A.pick.hint);
    // Nothing of this computer is listed: no folder rows, no Import buttons per file.
    expect(page.doc.querySelector('[data-key^="picker:open:"]')).toBeNull();
    expect(page.hasButton(A.pick.chooseFile)).toBe(true);

    answer = dashboard('archives-importing', meta([{ ...ARCHIVE, name: 'Takeout-2026-10.mbox', status: 'importing', percent: 5, items: 40, judged: 0, held: 40 }]));
    choose(page, 'picker:drop:file-input', [{ path: 'Takeout-2026-10.mbox', text: 'From mail' }]);
    await until(() => page.doc.querySelector('li.archive[data-archive="importing"]') !== null);
    // One file, sent by the host page with its own name; no path of this computer is named anywhere.
    expect(page.uploads().map((entry) => entry.path)).toEqual(['Takeout-2026-10.mbox']);
    expect(page.calls(ARCHIVE_UPLOAD_START_TOOL_NAME)).toEqual([{ name: ARCHIVE_UPLOAD_START_TOOL_NAME, arguments: {} }]);
    const uploadId = page.uploads()[0]!.upload_id;
    expect(uploadId).toMatch(/^[0-9a-f]{32}$/);
    expect(page.calls(ARCHIVE_APPROVE_TOOL_NAME)).toEqual([{ name: ARCHIVE_APPROVE_TOOL_NAME, arguments: { upload_id: uploadId } }]);
    // Back on the dashboard, read again, with the one line that says what happened.
    expect(page.text()).not.toContain(A.pick.intro);
    expect(page.text()).toContain(fill(A.started, { name: 'Takeout-2026-10.mbox' }));
    expect(page.calls(DASHBOARD_TOOL_NAME).length).toBeGreaterThan(1);
    expect(archiveItem(page, 'importing').textContent).toContain(A.status.importing);
  });

  test('a folder chosen in the system\'s dialog keeps its files\' relative paths, and the approval is about the folder', async () => {
    const page = await mount({
      [DASHBOARD_TOOL_NAME]: () => dashboard('archives-none', meta([])),
      ...uploadServe(),
      [ARCHIVE_APPROVE_TOOL_NAME]: (args) => previewArchiveApprove(args),
    }, { upload: noteUploads });
    page.button(A.importAction).click();
    await settle();
    choose(page, 'picker:drop:folder-input', [
      { path: 'DataExport_2026-10-20/result.json' },
      { path: 'DataExport_2026-10-20/chats/a/photo.jpg' },
      { path: 'DataExport_2026-10-20/chats/b/voice.ogg' },
    ]);
    await until(() => page.calls(ARCHIVE_APPROVE_TOOL_NAME).length > 0);
    expect(page.uploads().map((entry) => entry.path).sort()).toEqual([
      'DataExport_2026-10-20/chats/a/photo.jpg',
      'DataExport_2026-10-20/chats/b/voice.ogg',
      'DataExport_2026-10-20/result.json',
    ]);
    // Every file is one upload, begun once.
    expect(new Set(page.uploads().map((entry) => entry.upload_id)).size).toBe(1);
    expect(page.calls(ARCHIVE_UPLOAD_START_TOOL_NAME)).toHaveLength(1);
    expect(page.calls(ARCHIVE_APPROVE_TOOL_NAME)[0]!.arguments).toEqual({ upload_id: page.uploads()[0]!.upload_id });
  });

  test('a folder dragged onto the zone is read through its entries, every depth, and the zone answers the drag', async () => {
    const page = await mount({
      [DASHBOARD_TOOL_NAME]: () => dashboard('archives-none', meta([])),
      ...uploadServe(),
      [ARCHIVE_APPROVE_TOOL_NAME]: (args) => previewArchiveApprove(args),
    }, { upload: noteUploads });
    page.button(A.importAction).click();
    await settle();
    const zone = dropOnZone(page, [{ name: 'DataExport_2026-10-20', children: [{ name: 'result.json' }, { name: 'chats', children: [{ name: 'a', children: [{ name: 'photo.jpg' }] }] }] }], 'enter');
    // While something is dragged over it, the zone says so.
    expect(zone.getAttribute('data-over')).toBe('true');
    expect(zone.textContent).toContain(A.pick.over);
    zone.dispatchEvent(new page.win.Event('dragleave', { bubbles: true }) as unknown as Event);
    expect(zone.getAttribute('data-over')).toBe('false');
    expect(zone.textContent).toContain(A.pick.zone);

    dropOnZone(page, [{ name: 'DataExport_2026-10-20', children: [{ name: 'result.json' }, { name: 'chats', children: [{ name: 'a', children: [{ name: 'photo.jpg' }] }] }] }]);
    await until(() => page.calls(ARCHIVE_APPROVE_TOOL_NAME).length > 0);
    expect(page.uploads().map((entry) => entry.path).sort()).toEqual(['DataExport_2026-10-20/chats/a/photo.jpg', 'DataExport_2026-10-20/result.json']);
    expect(page.calls(ARCHIVE_APPROVE_TOOL_NAME)).toHaveLength(1);
  });

  test('a file dropped on the zone is one upload under its own name', async () => {
    const page = await mount({
      [DASHBOARD_TOOL_NAME]: () => dashboard('archives-none', meta([])),
      ...uploadServe(),
      [ARCHIVE_APPROVE_TOOL_NAME]: (args) => previewArchiveApprove(args),
    }, { upload: noteUploads });
    page.button(A.importAction).click();
    await settle();
    dropOnZone(page, [{ name: 'Takeout-2026-10.mbox', text: 'From mail' }]);
    await until(() => page.calls(ARCHIVE_APPROVE_TOOL_NAME).length > 0);
    expect(page.uploads().map((entry) => entry.path)).toEqual(['Takeout-2026-10.mbox']);
    expect(page.uploads()[0]!.file.size).toBe('From mail'.length);
  });

  test('a folder with a file the browser cannot read fails the drop rather than importing the rest', async () => {
    const page = await mount({
      [DASHBOARD_TOOL_NAME]: () => dashboard('archives-none', meta([])),
      ...uploadServe(),
    });
    page.button(A.importAction).click();
    await settle();
    dropOnZone(page, [{ name: 'Inbox.mbox', children: [{ name: 'mbox', text: 'From x' }, { name: 'Info.plist', unreadable: true }] }]);
    await until(() => page.doc.querySelector('[role="alert"]') !== null);
    expect(page.doc.querySelector('[role="alert"]')!.textContent).toBe(A.pick.unreadable);
    expect(page.calls(ARCHIVE_UPLOAD_START_TOOL_NAME)).toEqual([]);
    expect(page.calls(ARCHIVE_APPROVE_TOOL_NAME)).toEqual([]);
  });

  test('a drop with nothing in it, or a folder with no file, says so and starts nothing', async () => {
    const page = await mount({
      [DASHBOARD_TOOL_NAME]: () => dashboard('archives-none', meta([])),
      ...uploadServe(),
    });
    page.button(A.importAction).click();
    await settle();
    dropOnZone(page, [{ name: 'Empty folder', children: [] }]);
    await until(() => page.doc.querySelector('[role="alert"]') !== null);
    expect(page.doc.querySelector('[role="alert"]')!.textContent).toBe(A.pick.empty);
    expect(page.calls(ARCHIVE_UPLOAD_START_TOOL_NAME)).toEqual([]);
    expect(page.calls(ARCHIVE_APPROVE_TOOL_NAME)).toEqual([]);
    // The zone is there to try again.
    expect(page.doc.querySelector('[data-key="picker:drop:zone"]')).not.toBeNull();
  });

  test('a refusal stays on the screen with the engine\'s reason, the zone is there again, and the refused upload is not kept', async () => {
    const page = await mount({
      [DASHBOARD_TOOL_NAME]: () => dashboard('archives-none', meta([])),
      ...uploadServe(),
      [ARCHIVE_APPROVE_TOOL_NAME]: (args) => previewArchiveApprove(args),
    }, { upload: noteUploads });
    page.button(A.importAction).click();
    await settle();
    choose(page, 'picker:drop:file-input', [{ path: 'notes.txt', text: 'shopping list' }]);
    await until(() => page.doc.querySelector('[role="alert"]') !== null);
    const alert = page.doc.querySelector('[role="alert"]');
    expect(alert!.textContent).toContain('Mail (mbox)');
    expect(page.text()).toContain(A.pick.intro);
    expect(page.doc.querySelector('[data-key="picker:drop:zone"]')).not.toBeNull();
    expect(page.calls(ARCHIVE_APPROVE_TOOL_NAME)).toHaveLength(1);
    // Another try is a new upload, not the refused one.
    choose(page, 'picker:drop:file-input', [{ path: 'Takeout-2026-10.mbox' }]);
    await until(() => page.calls(ARCHIVE_APPROVE_TOOL_NAME).length > 1);
    expect(page.calls(ARCHIVE_UPLOAD_START_TOOL_NAME)).toHaveLength(2);
    const [first, second] = page.calls(ARCHIVE_APPROVE_TOOL_NAME).map((call) => call.arguments.upload_id);
    expect(first).not.toBe(second);
  });

  test('a copy of an earlier import says it is checking, and Back leaves the dashboard as it was', async () => {
    const page = await mount({
      [DASHBOARD_TOOL_NAME]: () => dashboard('archives-imported', meta([ARCHIVE])),
      ...uploadServe(),
      [ARCHIVE_APPROVE_TOOL_NAME]: () => ({ content: [{ type: 'text', text: 'Checking.' }], structuredContent: { status: 'checking', name: 'Takeout-2026-10.mbox' } }),
    }, { upload: noteUploads });
    page.button(A.importAction).click();
    await settle();
    page.button(A.pick.back).click();
    await settle();
    expect(page.text()).not.toContain(A.pick.intro);
    expect(page.calls(ARCHIVE_APPROVE_TOOL_NAME)).toEqual([]);
    page.button(A.importAction).click();
    await settle();
    choose(page, 'picker:drop:file-input', [{ path: 'Takeout-2026-10.mbox' }]);
    await until(() => page.text().includes(fill(A.checking, { name: 'Takeout-2026-10.mbox' })));
    expect(page.text()).toContain(fill(A.checking, { name: 'Takeout-2026-10.mbox' }));
  });

  test('progress shows while files are on their way, and Cancel stops them, deletes what arrived and goes back to the zone', async () => {
    const release: Array<() => void> = [];
    const page = await mount({
      [DASHBOARD_TOOL_NAME]: () => dashboard('archives-none', meta([])),
      ...uploadServe(),
      [ARCHIVE_APPROVE_TOOL_NAME]: (args) => previewArchiveApprove(args),
    }, {
      upload: (params, progress) => new Promise((resolve) => {
        progress(4);
        release.push(() => resolve({ ok: false, cancelled: true }));
        // Never answers until the page aborts: a long upload.
        void params;
      }),
    });
    page.button(A.importAction).click();
    await settle();
    choose(page, 'picker:drop:folder-input', [{ path: 'Big export/result.json', text: '0123456789' }]);
    await until(() => page.doc.querySelector('[role="progressbar"]') !== null && page.text().includes('4 bytes of 10 bytes'));
    expect(page.text()).toContain(fill(A.pick.uploading, { name: 'Big export' }));
    expect(page.text()).toContain(fill(A.pick.progress, { sent: '4 bytes', total: '10 bytes' }));
    const bar = page.doc.querySelector('[role="progressbar"]')!;
    expect(bar.getAttribute('aria-valuenow')).toBe('40');
    // Nothing is approved while it sends.
    expect(page.calls(ARCHIVE_APPROVE_TOOL_NAME)).toEqual([]);
    const uploadId = page.uploads()[0]!.upload_id;

    page.button(A.pick.cancel).click();
    await settle();
    expect(page.aborts()).toEqual([uploadId]);
    expect(page.calls(ARCHIVE_UPLOAD_CANCEL_TOOL_NAME)).toEqual([{ name: ARCHIVE_UPLOAD_CANCEL_TOOL_NAME, arguments: { upload_id: uploadId } }]);
    expect(previewArchiveUploads.uploads.has(uploadId)).toBe(false);
    expect(page.doc.querySelector('[role="progressbar"]')).toBeNull();
    expect(page.doc.querySelector('[data-key="picker:drop:zone"]')).not.toBeNull();
    // The cancelled files' late answers change nothing.
    release.forEach((answer) => answer());
    await settle();
    expect(page.calls(ARCHIVE_APPROVE_TOOL_NAME)).toEqual([]);
    expect(page.doc.querySelector('[role="alert"]')).toBeNull();
  });

  test('Back while files are on their way cancels the upload too', async () => {
    const page = await mount({
      [DASHBOARD_TOOL_NAME]: () => dashboard('archives-none', meta([])),
      ...uploadServe(),
    }, { upload: () => new Promise(() => undefined) });
    page.button(A.importAction).click();
    await settle();
    choose(page, 'picker:drop:file-input', [{ path: 'Takeout-2026-10.mbox' }]);
    await until(() => page.uploads().length > 0);
    const uploadId = page.uploads()[0]!.upload_id;
    page.button(A.pick.back).click();
    await settle();
    expect(page.aborts()).toEqual([uploadId]);
    expect(page.calls(ARCHIVE_UPLOAD_CANCEL_TOOL_NAME)).toHaveLength(1);
    expect(page.text()).not.toContain(A.pick.intro);
  });

  test('a file the engine could not take stops the upload, says why in the engine\'s words, and nothing is imported', async () => {
    const page = await mount({
      [DASHBOARD_TOOL_NAME]: () => dashboard('archives-none', meta([])),
      ...uploadServe(),
      [ARCHIVE_APPROVE_TOOL_NAME]: (args) => previewArchiveApprove(args),
    }, { upload: () => ({ ok: false, message: 'This computer has no space left for it.' }) });
    page.button(A.importAction).click();
    await settle();
    choose(page, 'picker:drop:folder-input', [{ path: 'Export/a.json' }, { path: 'Export/b.json' }]);
    await until(() => page.doc.querySelector('[role="alert"]') !== null);
    expect(page.doc.querySelector('[role="alert"]')!.textContent).toBe('This computer has no space left for it.');
    expect(page.calls(ARCHIVE_APPROVE_TOOL_NAME)).toEqual([]);
    // What arrived is deleted.
    expect(page.calls(ARCHIVE_UPLOAD_CANCEL_TOOL_NAME)).toHaveLength(1);
    expect(page.doc.querySelector('[data-key="picker:drop:zone"]')).not.toBeNull();
  });

  test('the first file that fails stops the others at once and says why, without waiting for them', async () => {
    const page = await mount({
      [DASHBOARD_TOOL_NAME]: () => dashboard('archives-none', meta([])),
      ...uploadServe(),
    }, {
      // a.json fails; b.json never answers until the page aborts it (a long file, or one waiting for disk space).
      upload: (params) => (params.path.endsWith('a.json') ? { ok: false, message: 'This computer has no space left for it.' } : new Promise(() => undefined)),
    });
    page.button(A.importAction).click();
    await settle();
    choose(page, 'picker:drop:folder-input', [{ path: 'Export/a.json' }, { path: 'Export/b.json' }]);
    await until(() => page.doc.querySelector('[role="alert"]') !== null);
    expect(page.doc.querySelector('[role="alert"]')!.textContent).toBe('This computer has no space left for it.');
    expect(page.aborts()).toEqual([page.uploads()[0]!.upload_id]);
    expect(page.calls(ARCHIVE_UPLOAD_CANCEL_TOOL_NAME)).toHaveLength(1);
  });

  test('a start that fails after it was cancelled leaves the next upload alone', async () => {
    let failFirst: (error: Error) => void = () => undefined;
    let starts = 0;
    const page = await mount({
      [DASHBOARD_TOOL_NAME]: () => dashboard('archives-none', meta([])),
      ...uploadServe(),
      [ARCHIVE_UPLOAD_START_TOOL_NAME]: () => {
        starts += 1;
        if (starts === 1) return new Promise((_, reject) => { failFirst = reject; });
        return { content: [{ type: 'text', text: 'Ready.' }], structuredContent: { status: 'started', upload_id: previewArchiveUploads.start() } };
      },
    }, { upload: () => new Promise(() => undefined) });
    page.button(A.importAction).click();
    await settle();
    choose(page, 'picker:drop:file-input', [{ path: 'first.mbox' }]);
    await until(() => starts === 1);
    page.button(A.pick.cancel).click();
    await settle();
    choose(page, 'picker:drop:file-input', [{ path: 'second.mbox' }]);
    await until(() => page.uploads().length > 0);
    failFirst(new Error('timed out'));
    await settle(50);
    expect(page.doc.querySelector('[role="alert"]')).toBeNull();
    expect(page.aborts()).toEqual([]);
    expect(page.doc.querySelector('[role="progressbar"]')).not.toBeNull();
  });

  test('an upload that cannot reach Olympus says it stopped and nothing was imported', async () => {
    const page = await mount({
      [DASHBOARD_TOOL_NAME]: () => dashboard('archives-none', meta([])),
      ...uploadServe(),
    }, { upload: () => ({ ok: false }) });
    page.button(A.importAction).click();
    await settle();
    choose(page, 'picker:drop:file-input', [{ path: 'Takeout-2026-10.mbox' }]);
    await until(() => page.doc.querySelector('[role="alert"]') !== null);
    expect(page.doc.querySelector('[role="alert"]')!.textContent).toBe(A.pick.failed);
    expect(page.calls(ARCHIVE_APPROVE_TOOL_NAME)).toEqual([]);
  });

  test('while the engine waits for free space, the screen says so and goes back to plain progress when it goes on', async () => {
    let status: 'paused_disk_full' | 'receiving' = 'paused_disk_full';
    const page = await mount({
      [DASHBOARD_TOOL_NAME]: () => dashboard('archives-none', meta([])),
      ...uploadServe(),
      [ARCHIVE_UPLOAD_STATUS_TOOL_NAME]: () => ({ content: [{ type: 'text', text: 'x' }], structuredContent: { status, files: 1, bytes: 5 } }),
    }, { upload: () => new Promise(() => undefined) });
    page.button(A.importAction).click();
    await settle();
    choose(page, 'picker:drop:file-input', [{ path: 'Takeout-2026-10.mbox' }]);
    await until(() => page.text().includes(A.pick.paused), 4000);
    expect(page.text()).toContain(A.pick.paused);
    status = 'receiving';
    await until(() => !page.text().includes(A.pick.paused), 4000);
    expect(page.text()).not.toContain(A.pick.paused);
  });
});

describe('a source\'s own Import an archive, and Other archives (owner, 2026-10-25)', () => {
  const TELEGRAM = { sourceId: 'telegram.messages', label: 'Telegram', intro: 'Drop a file or folder from this computer: a Telegram export. Olympus keeps a copy in its own storage to read it until you remove the import, and never changes the original.' };

  /** A state's answer with these cards importing their own exports. */
  function withSources(state: string, sources: unknown[] | undefined, archives = meta([])) {
    const result = dashboard(state, archives);
    const computer = { ...result._meta[COMPUTER_META_KEY] };
    if (sources) computer.archiveSources = sources;
    else delete computer.archiveSources;
    return { ...result, _meta: { ...result._meta, [COMPUTER_META_KEY]: computer } };
  }

  function sourceRow(page: Page, label: string): Element {
    const row = Array.from(page.doc.querySelectorAll('li.row.source')).find((node) => node.querySelector('.source-name')?.textContent === label);
    if (!row) throw new Error(`no ${label} row in: ${page.text()}`);
    return row;
  }

  function menuLabels(row: Element): string[] {
    return Array.from(row.querySelectorAll('.menu-panel button')).map((node) => node.textContent ?? '');
  }

  test('the Archives card is its own section after Sources, saying which exports it is for, with Import another archive', async () => {
    const page = await mount({ [DASHBOARD_TOOL_NAME]: () => withSources('archives-none', [TELEGRAM]) });
    const headings = Array.from(page.doc.querySelectorAll('section > h2')).map((node) => node.textContent);
    const sources = headings.indexOf(DASHBOARD_CHATGPT_PAGE_COPY.sources);
    expect(sources).toBeGreaterThanOrEqual(0);
    expect(headings[sources + 1]).toBe(DASHBOARD_CHATGPT_PAGE_COPY.otherArchives.title);
    const section = page.doc.querySelector('section.other-archives')!;
    expect(section.textContent).toContain("For an export that isn't from one of your sources above.");
    expect(Array.from(section.querySelectorAll('button')).map((node) => node.textContent)).toContain('Import another archive');
    // Not in the Sources list too.
    const list = Array.from(page.doc.querySelectorAll('section')).find((node) => node.querySelector('h2')?.textContent === DASHBOARD_CHATGPT_PAGE_COPY.sources)!;
    expect(list.textContent).not.toContain('Import another archive');
    expect(list.textContent).not.toContain("For an export that isn't from one of your sources above.");
  });

  test('with archives imported, Import another archive stays the section\'s own button, never in ⋯', async () => {
    const page = await mount({ [DASHBOARD_TOOL_NAME]: () => withSources('archives-imported', [TELEGRAM], meta([ARCHIVE])) });
    const row = page.doc.querySelector('section.other-archives li.row.source')!;
    expect(Array.from(row.querySelectorAll('.source-actions button')).map((node) => node.textContent)).toContain('Import another archive');
    expect(menuLabels(row)).not.toContain('Import another archive');
  });

  /** The labels of a card's own buttons, in the order they are drawn: the row's actions, then the ⋯ menu's. */
  function rowButtons(row: Element): string[] {
    return Array.from(row.querySelectorAll('.source-actions button')).map((node) => node.textContent ?? '');
  }

  test('a source that reads its own exports has Import an archive on its own row, to the left of Connect and never inside ⋯; one that does not, has none (owner, 2026-10-26)', async () => {
    const page = await mount({ [DASHBOARD_TOOL_NAME]: () => withSources('archives-none', [TELEGRAM]) });
    const telegram = sourceRow(page, 'Telegram');
    expect(rowButtons(telegram)).toEqual(['Import an archive', 'Connect']);
    expect(menuLabels(telegram)).not.toContain('Import an archive');
    // The same row, not a second line under it: both buttons are in the one actions box, Import first in the document.
    const actions = telegram.querySelector('.source-actions')!;
    const buttons = Array.from(actions.querySelectorAll('button'));
    expect(buttons.map((node) => node.textContent)).toEqual(['Import an archive', 'Connect']);
    expect(telegram.querySelectorAll('.source-actions').length).toBe(1);
    expect(telegram.className).toContain('has-import');
    expect(rowButtons(sourceRow(page, 'WhatsApp'))).not.toContain('Import an archive');
    expect(rowButtons(sourceRow(page, 'Gmail'))).not.toContain('Import an archive');
    expect(menuLabels(sourceRow(page, 'WhatsApp'))).not.toContain('Import an archive');
  });

  test('with no card importing (none registered, or a list that cannot be read), no card offers it', async () => {
    const page = await mount({ [DASHBOARD_TOOL_NAME]: () => withSources('archives-none', undefined) });
    for (const label of ['Gmail', 'Telegram', 'WhatsApp']) {
      expect(Array.from(sourceRow(page, label).querySelectorAll('button')).map((node) => node.textContent)).not.toContain('Import an archive');
    }
    expect(page.hasButton('Import another archive')).toBe(true);
  });

  test('it opens the drop zone titled for the source, with its own exports, and every approval names the source', async () => {
    const page = await mount({
      [DASHBOARD_TOOL_NAME]: () => withSources('archives-none', [TELEGRAM]),
      ...uploadServe(),
      [ARCHIVE_APPROVE_TOOL_NAME]: () => ({ content: [{ type: 'text', text: 'Importing.' }], structuredContent: { status: 'started', name: 'result.json', source: { id: 'telegram.messages', label: 'Telegram' } } }),
    }, { upload: noteUploads });
    const row = sourceRow(page, 'Telegram');
    (Array.from(row.querySelectorAll('.source-actions button')).find((node) => node.textContent === 'Import an archive') as HTMLButtonElement).click();
    await settle();
    expect(page.text()).toContain('Import an archive into Telegram');
    expect(page.text()).toContain(TELEGRAM.intro);
    expect(page.text()).not.toContain(A.pick.intro);
    choose(page, 'picker:drop:file-input', [{ path: 'result.json', text: '{}' }]);
    // The line says where it shows: the source it joined, not Other archives.
    await until(() => page.calls(ARCHIVE_APPROVE_TOOL_NAME).length > 0 && page.text().includes(fill(A.startedIn, { name: 'result.json', source: 'Telegram' })));
    expect(page.text()).toContain('Importing result.json into Telegram. It shows in Telegram as it is read.');
    expect(page.calls(ARCHIVE_APPROVE_TOOL_NAME)).toEqual([
      { name: ARCHIVE_APPROVE_TOOL_NAME, arguments: { upload_id: page.uploads()[0]!.upload_id, source_id: 'telegram.messages' } },
    ]);
  });

  test('a Keys link lands on a card\'s Import an archive: its drop zone opens, for that card only (owner, 2026-10-29)', async () => {
    const landed = (sourceId: string) => mount(
      { [DASHBOARD_TOOL_NAME]: () => withSources('archives-none', [TELEGRAM]), ...uploadServe() },
      { host: { ...COMPUTER, landing: { sourceId, import: true } } },
    );
    const own = await landed('telegram.messages');
    expect(own.text()).toContain('Import an archive into Telegram');
    expect(own.text()).toContain(TELEGRAM.intro);
    // Other archives takes any export.
    const other = await landed('archive.imports');
    expect(other.text()).toContain(A.pick.intro);
    // A card the engine does not list opens nothing, and a plain landing never opens the drop zone.
    const unlisted = await landed('gmail.email');
    expect(unlisted.text()).not.toContain(A.pick.back);
    const plain = await mount(
      { [DASHBOARD_TOOL_NAME]: () => withSources('archives-none', [TELEGRAM]) },
      { host: { ...COMPUTER, landing: { sourceId: 'telegram.messages' } } },
    );
    expect(plain.text()).not.toContain(A.pick.back);
  });

  test('Back to Olympus from a card\'s Import an archive puts focus on that card\'s own Import button', async () => {
    const page = await mount({
      [DASHBOARD_TOOL_NAME]: () => withSources('archives-none', [TELEGRAM]),
      ...uploadServe(),
    });
    const row = sourceRow(page, 'Telegram');
    (Array.from(row.querySelectorAll('.source-actions button')).find((node) => node.textContent === 'Import an archive') as HTMLButtonElement).click();
    await settle();
    page.button(A.pick.back).click();
    await until(() => page.doc.activeElement?.getAttribute('data-key') === 'import:telegram.messages');
    expect(page.doc.activeElement?.getAttribute('data-key')).toBe('import:telegram.messages');
  });

  test('one file, the same outcome from either button: the preview routes both through one path', () => {
    const ask = (key: string, state: string, extra: Record<string, unknown> = {}) => (previewArchiveApprove({ key, ...extra }, state) as { structuredContent: any }).structuredContent;
    const mbox = '/Users/you/Mail exports/Takeout-2026-10.mbox';
    // The account question is asked whichever button chose the file, and the answer decides.
    expect(ask(mbox, 'archives-account-confirm')).toMatchObject({ status: 'confirm_account' });
    expect(ask(mbox, 'archives-account-confirm', { source_id: 'gmail.email' })).toMatchObject({ status: 'confirm_account' });
    expect(ask(mbox, 'archives-account-confirm', { keep_apart: true })).toEqual({ status: 'started', name: 'Takeout-2026-10.mbox' });
    expect(ask(mbox, 'archives-account-confirm', { source_id: 'gmail.email', keep_apart: true })).toEqual({ status: 'started', name: 'Takeout-2026-10.mbox' });
    expect(ask(mbox, 'archives-account-confirm', { source_id: 'gmail.email', confirm_account: true })).toMatchObject({ status: 'started', source: { id: 'gmail.email' } });
    // A Telegram export goes into Telegram from either button.
    const telegram = '/Users/you/Telegram exports/result.json';
    expect(ask(telegram, 'archives-none')).toEqual(ask(telegram, 'archives-none', { source_id: 'telegram.messages' }));
    expect(ask(telegram, 'archives-none')).toMatchObject({ status: 'started', source: { id: 'telegram.messages' } });
  });

  test('another kind of export is refused on the drop screen with the route to Import another archive', async () => {
    const page = await mount({
      [DASHBOARD_TOOL_NAME]: () => previewState('sources-import-imported'),
      ...uploadServe(),
      [ARCHIVE_APPROVE_TOOL_NAME]: (args) => previewArchiveApprove(args),
    }, { upload: noteUploads });
    const row = sourceRow(page, 'Telegram');
    (Array.from(row.querySelectorAll('.source-actions button')).find((node) => node.textContent === 'Import an archive') as HTMLButtonElement).click();
    await settle();
    choose(page, 'picker:drop:file-input', [{ path: 'Takeout-2026-10.mbox' }]);
    await until(() => page.doc.querySelector('[role="alert"]') !== null);
    const alert = page.doc.querySelector('[role="alert"]')!.textContent ?? '';
    expect(alert).toContain("This isn't a Telegram export.");
    expect(alert).toContain('Import another archive');
    expect(page.calls(ARCHIVE_APPROVE_TOOL_NAME)[0]!.arguments).toEqual({ upload_id: page.uploads()[0]!.upload_id, source_id: 'telegram.messages' });
  });

  test('Import another archive names no source: its approval routes the export by what it is', async () => {
    const page = await mount({
      [DASHBOARD_TOOL_NAME]: () => withSources('archives-none', [TELEGRAM]),
      ...uploadServe(),
      [ARCHIVE_APPROVE_TOOL_NAME]: (args) => previewArchiveApprove(args),
    }, { upload: noteUploads });
    page.button(A.importAction).click();
    await settle();
    expect(page.text()).toContain(A.pick.title);
    choose(page, 'picker:drop:file-input', [{ path: 'Takeout-2026-10.mbox' }]);
    await until(() => page.calls(ARCHIVE_APPROVE_TOOL_NAME).length > 0);
    expect(page.calls(ARCHIVE_APPROVE_TOOL_NAME)[0]!.arguments).toEqual({ upload_id: page.uploads()[0]!.upload_id });
  });

  test('in ChatGPT the section is there too, and its button opens the computer\'s dashboard', async () => {
    const page = await mount({}, { computer: false, dashboard: () => dashboard('archives-none', meta([])) });
    const section = page.doc.querySelector('section.other-archives');
    expect(section).not.toBeNull();
    expect(section!.textContent).toContain('Import another archive');
    // A live source's own Import an archive is the computer's (its picker); in ChatGPT no live source's card offers it.
    for (const label of ['Gmail', 'Telegram', 'WhatsApp']) {
      expect(Array.from(sourceRow(page, label).querySelectorAll('button')).map((node) => node.textContent)).not.toContain('Import an archive');
    }
  });
});

describe('Reflect, Roam and Evernote: import-only sources with cards of their own (step 7)', () => {
  /** A state's answer as the computer sends it: Reflect and Roam imports on their cards, not under Other archives. */
  function split(state: string) {
    return previewState(state);
  }

  function cardRow(page: Page, label: string): Element {
    const row = Array.from(page.doc.querySelectorAll('li.row.source')).find((node) => node.querySelector('.source-name')?.textContent === label);
    if (!row) throw new Error(`no ${label} row in: ${page.text()}`);
    return row;
  }

  test('each is a row in Sources; an import of its format is listed in its own row with its Remove, not under Other archives', async () => {
    const page = await mount({ [DASHBOARD_TOOL_NAME]: () => split('archives-notes-reflect') });
    const sources = Array.from(page.doc.querySelectorAll('section')).find((node) => node.querySelector('h2')?.textContent === DASHBOARD_CHATGPT_PAGE_COPY.sources)!;
    for (const label of ['Reflect', 'Roam', 'Evernote']) expect(sources.textContent).toContain(label);
    const reflect = cardRow(page, 'Reflect');
    expect(reflect.querySelector('li.archive .archive-name')?.textContent).toBe('Reflect export.zip');
    expect(Array.from(reflect.querySelectorAll('li.archive button')).map((node) => node.textContent)).toContain(A.remove);
    const other = page.doc.querySelector('section.other-archives')!;
    expect(other.querySelector('li.archive')).toBeNull();
  });

  test('a card with nothing imported offers Import an archive, which opens the drop zone for its exports and names it on approval', async () => {
    const page = await mount({
      [DASHBOARD_TOOL_NAME]: () => split('archives-none'),
      ...uploadServe(),
      [ARCHIVE_APPROVE_TOOL_NAME]: (args) => previewArchiveApprove(args),
    }, { upload: noteUploads });
    const evernote = cardRow(page, 'Evernote');
    const button = Array.from(evernote.querySelectorAll('.source-actions button')).find((node) => node.textContent === 'Import an archive') as HTMLButtonElement;
    expect(button).toBeDefined();
    // Never twice: neither the row (whose fix is the same import) nor the ⋯ menu repeats it.
    expect(Array.from(evernote.querySelectorAll('.source-actions button')).filter((node) => node.textContent === 'Import an archive')).toHaveLength(1);
    expect(Array.from(evernote.querySelectorAll('.menu-panel button')).map((node) => node.textContent)).not.toContain('Import an archive');
    button.click();
    await settle();
    expect(page.text()).toContain('Import an archive into Evernote');
    expect(page.text()).toContain('an Evernote export');
    choose(page, 'picker:drop:file-input', [{ path: 'Field notes.enex' }]);
    await until(() => page.calls(ARCHIVE_APPROVE_TOOL_NAME).length > 0 && page.text().includes('Importing Field notes.enex into Evernote.'));
    expect(page.calls(ARCHIVE_APPROVE_TOOL_NAME)[0]!.arguments).toEqual({ upload_id: page.uploads()[0]!.upload_id, source_id: 'evernote.notes' });
    expect(page.text()).toContain('Importing Field notes.enex into Evernote. It shows in Evernote as it is read.');
  });

  test('Remove on a card\'s import names it in the line, as on Other archives', async () => {
    const page = await mount({
      [DASHBOARD_TOOL_NAME]: () => split('archives-notes'),
      [ARCHIVE_REMOVE_TOOL_NAME]: () => ({ content: [{ type: 'text', text: 'Removing.' }], structuredContent: { status: 'removing' } }),
    });
    const roam = cardRow(page, 'Roam');
    (Array.from(roam.querySelectorAll('li.archive button')).find((node) => node.textContent === A.remove) as HTMLButtonElement).click();
    await settle();
    const confirm = page.buttons().find((node) => (node.textContent ?? '').toLowerCase().includes(A.remove.toLowerCase()) && node.getAttribute('data-key')?.endsWith(':yes'));
    expect(confirm).toBeDefined();
    confirm!.click();
    await until(() => page.text().includes(fill(A.removing, { name: 'Roam-Export-1760180000000.zip' })));
    expect(page.text()).toContain(fill(A.removing, { name: 'Roam-Export-1760180000000.zip' }));
  });
});

describe('each archive under the Archives row', () => {
  test('importing: how far, how many so far, and what still waits for the private model', async () => {
    const page = await mount({
      [DASHBOARD_TOOL_NAME]: () => dashboard('archives-importing', meta([{ ...STARTED, status: 'importing', percent: 42, items: 20_340, judged: 12_900, held: 7_440 }])),
    });
    const item = archiveItem(page, 'importing');
    expect(item.querySelector('.archive-name')!.textContent).toBe(ARCHIVE.name);
    expect(item.textContent).toContain(`${ARCHIVE.format} · ${ARCHIVE.where} · ${fill(A.dates, { earliest: '2011-02-03', latest: '2019-12-30' })}`);
    expect(item.textContent).toContain(fill(A.importingLine, { percent: '42', items: fill(A.nouns.email.many, { n: '20,340' }) }));
    expect(item.querySelector('[role="progressbar"]')).not.toBeNull();
    expect(item.textContent).toContain(fill(A.judgedLine, { judged: '12,900', held: '7,440' }));
    expect(item.textContent).toContain(A.heldWhy.ready);
    // The private model is answering: nothing to set up.
    expect(item.textContent).not.toContain(A.setUpPrivateModel);
    expect(Array.from(item.querySelectorAll('button')).map((node) => node.textContent)).toContain(A.remove);
  });

  test('imported with nothing judged while no private model is set up: held Private, with the way to set one up', async () => {
    const page = await mount({
      [DASHBOARD_TOOL_NAME]: () => dashboard('archives-waiting', meta([{ ...ARCHIVE, judged: 0, held: 1_250 }], [], 'off')),
    });
    const item = archiveItem(page, 'imported');
    expect(item.textContent).toContain(A.status.imported);
    expect(item.textContent).toContain(fill(A.judgedLine, { judged: '0', held: '1,250' }));
    expect(item.textContent).toContain(A.heldWhy.off);
    const setUp = Array.from(item.querySelectorAll('button')).find((node) => node.textContent === A.setUpPrivateModel) as HTMLButtonElement;
    expect(setUp).toBeDefined();
    setUp.click();
    await settle();
    // It opens the page's own models section; no tool is called for it.
    expect((page.doc.querySelector('details[data-open-key="models"]') as HTMLDetailsElement | null)?.open).toBe(true);
    expect(page.calls().map((call) => call.name).every((name) => name === DASHBOARD_TOOL_NAME)).toBe(true);
  });

  test('a private model set up but not answering says so', async () => {
    const page = await mount({
      [DASHBOARD_TOOL_NAME]: () => dashboard('archives-waiting', meta([ARCHIVE], [], 'waiting')),
    });
    const item = archiveItem(page, 'imported');
    expect(item.textContent).toContain(A.heldWhy.waiting);
    expect(item.textContent).toContain(A.setUpPrivateModel);
  });

  test('what was not imported and how it was read are two lists in plain words, behind one button; never a byte offset', async () => {
    const page = await mount({
      [DASHBOARD_TOOL_NAME]: () => dashboard('archives-imported', meta([{
        ...ARCHIVE,
        gaps: [{ kind: 'message_too_large', count: 2 }, { kind: 'time_zone_assumed', count: 1 }, { kind: 'attachments_not_read', count: 1 }, { kind: 'something_new', count: 4 }],
        skipped: [{ kind: 'spam_or_trash', count: 30 }, { kind: 'message_empty', count: 6 }],
      }])),
    });
    const item = archiveItem(page, 'imported');
    const why = item.querySelector('details.why')!;
    expect(why).not.toBeNull();
    const lists = archiveLists(item);
    expect(lists.button).toBe(A.seeWhy.both);
    expect(lists.heads).toEqual([A.lists.notImported, A.lists.howRead]);
    // A kind the page has never heard of is under Not imported, never hidden.
    expect(lists.notImported).toEqual([
      fill(A.gaps.message_too_large.many, { n: '2' }),
      A.gaps.attachments_not_read.one,
      fill(A.gaps.other.many, { n: '4' }),
      fill(A.gaps.spam_or_trash.many, { n: '30' }),
    ]);
    expect(lists.howRead).toEqual([
      A.gaps.time_zone_assumed.one,
      fill(A.gaps.message_empty.many, { n: '6' }),
    ]);
    expect(why.textContent).not.toContain('byte');
  });

  test('an archive with lines in only one list shows only that list, and the button says which', async () => {
    const only = async (gaps: ComputerArchiveEntry['gaps'], skipped: ComputerArchiveEntry['skipped']) => {
      const page = await mount({ [DASHBOARD_TOOL_NAME]: () => dashboard('archives-imported', meta([{ ...ARCHIVE, gaps, skipped }])) });
      return archiveLists(archiveItem(page, 'imported'));
    };
    const lost = await only([{ kind: 'file_damaged', count: 1 }], []);
    expect(lost.button).toBe(A.seeWhy.notImported);
    expect(lost.heads).toEqual([A.lists.notImported]);
    expect(lost.notImported).toEqual([A.gaps.file_damaged.one]);
    const read = await only([{ kind: 'date_order_assumed', count: 1 }], [{ kind: 'item_repeated', count: 112 }]);
    expect(read.button).toBe(A.seeWhy.howRead);
    expect(read.heads).toEqual([A.lists.howRead]);
    expect(read.howRead).toEqual([A.gaps.date_order_assumed.one, fill(A.gaps.item_repeated.many, { n: '112' })]);
    // Nothing to say is no button at all.
    const page = await mount({ [DASHBOARD_TOOL_NAME]: () => dashboard('archives-imported', meta([ARCHIVE])) });
    expect(archiveItem(page, 'imported').querySelector('details.why')).toBeNull();
  });

  test('a kind sits in the list the table gives it whichever way the engine classed it, and a name that is not a kind is shown under Not imported', async () => {
    const page = await mount({
      [DASHBOARD_TOOL_NAME]: () => dashboard('archives-imported', meta([{
        ...ARCHIVE,
        // The engine's own class (gap or skipped) does not decide the list: the kind does.
        gaps: [{ kind: 'message_empty', count: 2 }, { kind: 'constructor', count: 1 }],
        skipped: [{ kind: 'file_damaged', count: 1 }],
      }])),
    });
    const lists = archiveLists(archiveItem(page, 'imported'));
    expect(lists.howRead).toEqual([fill(A.gaps.message_empty.many, { n: '2' })]);
    expect(lists.notImported).toEqual([A.gaps.other.one, A.gaps.file_damaged.one]);
  });

  test('an archive of several files says which file each line is in', async () => {
    const page = await mount({
      [DASHBOARD_TOOL_NAME]: () => dashboard('archives-imported', meta([{
        ...ARCHIVE,
        gaps: [
          { kind: 'message_too_large', count: 2, file: 'Inbox' },
          { kind: 'message_unreadable', count: 1, file: 'Sent' },
          { kind: 'time_zone_assumed', count: 1, file: 'Sent' },
        ],
      }])),
    });
    const lists = archiveLists(archiveItem(page, 'imported'));
    expect(lists.notImported).toEqual([
      fill(A.gapInFile, { file: 'Inbox', gap: fill(A.gaps.message_too_large.many, { n: '2' }) }),
      fill(A.gapInFile, { file: 'Sent', gap: A.gaps.message_unreadable.one }),
    ]);
    expect(lists.howRead).toEqual([fill(A.gapInFile, { file: 'Sent', gap: A.gaps.time_zone_assumed.one })]);
  });

  test('a notes archive counts notes, and every kind of gap any format reports has its own plain sentence', async () => {
    const page = await mount({ [DASHBOARD_TOOL_NAME]: () => previewState('archives-notes') });
    const item = archiveItem(page, 'imported');
    expect(item.textContent).toContain(fill(A.nouns.note.many, { n: '3,412' }));
    expect(item.textContent).not.toContain('messages');
    expect(item.textContent).not.toContain(fill(A.nouns.other.many, { n: '3,412' }));
    const lists = archiveLists(item);
    expect(lists.notImported).toEqual([
      fill(A.gaps.media_not_imported.many, { n: '287' }),
      A.gaps.note_too_large.one,
      fill(A.gaps.section_not_imported.many, { n: '2' }),
      A.gaps.file_damaged.one,
    ]);
    // A date taken from the file and a note with nothing in it lose nothing: they are how the notes were read.
    expect(lists.howRead).toEqual([
      fill(A.gaps.note_date_assumed.many, { n: '12' }),
      fill(A.gaps.note_empty.many, { n: '38' }),
    ]);
    // Every kind has both a one and a many sentence, none of them the catch-all.
    for (const kind of ['media_not_imported', 'item_truncated', 'section_not_imported', 'file_damaged', 'note_empty', 'note_unreadable', 'note_too_large', 'note_content_unsupported', 'note_date_assumed'] as const) {
      expect(A.gaps[kind].one).not.toBe(A.gaps.other.one);
      expect(A.gaps[kind].many).toContain('{n}');
    }
  });

  test('a chat archive counts messages, says Snapshot, not updated beside its dates, and names what it did not import and how it read the rest in plain words', async () => {
    const page = await mount({ [DASHBOARD_TOOL_NAME]: () => previewState('archives-chat-whatsapp') });
    const item = archiveItem(page, 'imported');
    expect(item.textContent).toContain(fill(A.nouns.chat.many, { n: '12,644' }));
    const facts = item.querySelector('.archive-facts')!;
    expect(facts.textContent).toContain('WhatsApp chat export');
    expect(facts.textContent).toContain(fill(A.dates, { earliest: '2019-06-08', latest: '2026-09-30' }));
    expect(facts.querySelector('.archive-snapshot')!.textContent).toBe('Snapshot, not updated');
    const lists = archiveLists(item);
    expect(lists.notImported).toEqual([
      fill(A.gaps.media_not_imported.many, { n: '1,870' }),
      A.gaps.file_damaged.one,
      A.gaps.files_unconfirmed.one,
    ]);
    // WhatsApp's own notices, empty messages and a message in two files are how the chat was read, not losses.
    expect(lists.howRead).toEqual([
      A.gaps.time_zone_assumed.one,
      A.gaps.date_order_assumed.one,
      fill(A.gaps.item_start_assumed.many, { n: '3' }),
      fill(A.gaps.system_message.many, { n: '318' }),
      fill(A.gaps.message_empty.many, { n: '6' }),
      fill(A.gaps.item_repeated.many, { n: '112' }),
    ]);
    // A mail archive is not a snapshot.
    const mail = await mount({ [DASHBOARD_TOOL_NAME]: () => previewState('archives-imported') });
    expect(archiveItem(mail, 'imported').textContent).not.toContain('Snapshot');
    expect(archiveItem(mail, 'imported').querySelector('.archive-snapshot')).toBeNull();
  });

  test('a Telegram archive counts messages, and what it does not import or only reads a certain way has its own plain sentence', async () => {
    const page = await mount({ [DASHBOARD_TOOL_NAME]: () => previewState('archives-chat') });
    const item = archiveItem(page, 'imported');
    expect(item.textContent).toContain(fill(A.nouns.chat.many, { n: '18,460' }));
    expect(item.textContent).not.toContain(fill(A.nouns.other.many, { n: '18,460' }));
    const lists = archiveLists(item);
    expect(lists.notImported).toEqual([
      fill(A.gaps.media_not_imported.many, { n: '2,318' }),
      A.gaps.section_not_imported.one,
      fill(A.gaps.message_content_unsupported.many, { n: '12' }),
      A.gaps.file_damaged.one,
    ]);
    expect(lists.howRead).toEqual([
      A.gaps.time_zone_assumed.one,
      fill(A.gaps.message_without_text.many, { n: '54' }),
    ]);
    for (const kind of ['service_message', 'message_without_text', 'message_content_unsupported'] as const) {
      expect(A.gaps[kind].one).not.toBe(A.gaps.other.one);
      expect(A.gaps[kind].many).toContain('{n}');
    }
  });

  test('a Reflect archive counts notes, and a note with no date and a note that could not be read are named', async () => {
    const page = await mount({ [DASHBOARD_TOOL_NAME]: () => previewState('archives-notes-reflect') });
    const item = archiveItem(page, 'imported');
    expect(item.textContent).toContain(fill(A.nouns.note.many, { n: '1,208' }));
    expect(item.textContent).not.toContain('messages');
    const lists = archiveLists(item);
    expect(lists.notImported).toEqual([
      fill(A.gaps.media_not_imported.many, { n: '94' }),
      fill(A.gaps.note_unreadable.many, { n: '2' }),
    ]);
    expect(lists.howRead).toEqual([
      fill(A.gaps.note_date_assumed.many, { n: '3' }),
      fill(A.gaps.note_empty.many, { n: '17' }),
    ]);
  });

  test('every assumption the import makes has its own sentence, in a one and a many form, and none lists the others', () => {
    const specific = [
      ARCHIVE_COMMON_FINDINGS.timeZoneAssumed,
      ARCHIVE_COMMON_FINDINGS.dateOrderAssumed,
      ARCHIVE_COMMON_FINDINGS.itemStartAssumed,
      ARCHIVE_COMMON_FINDINGS.zipOverlapUnchecked,
    ];
    for (const kind of specific) {
      const words = (A.gaps as Record<string, { one: string; many: string }>)[kind]!;
      expect(words, kind).toBeDefined();
      expect(words.one).not.toBe(A.gaps.other.one);
      expect(words.many).toContain('{n}');
      // One thing is said, not a list of maybes.
      for (const sentence of [words.one, words.many]) expect(sentence).not.toMatch(/such as|had to assume/);
    }
    // They say the value that was taken.
    expect(A.gaps.date_order_assumed.one).toContain('day first');
    expect(A.gaps.time_zone_assumed.one).toContain("this computer's time zone");
    // Each kind reports a different thing.
    expect(new Set(specific.map((kind) => (A.gaps as Record<string, { one: string }>)[kind]!.one)).size).toBe(specific.length);
    // Every common kind a format can report has a sentence of its own, none of them the catch-all.
    for (const kind of Object.values(ARCHIVE_COMMON_FINDINGS)) {
      const words = (A.gaps as Record<string, { one: string; many: string }>)[kind];
      expect(words, kind).toBeDefined();
      expect(words!.one).not.toBe(A.gaps.other.one);
    }
  });

  test('an archive recorded before the specific kinds still reads: its one assumption has a plain sentence, not the catch-all', async () => {
    const old = { ...ARCHIVE, family: 'chat', gaps: [{ kind: ARCHIVE_COMMON_FINDINGS.assumption, count: 2 }], skipped: [] };
    const page = await mount({ [DASHBOARD_TOOL_NAME]: () => dashboard('archives-imported', meta([old])) });
    const lists = archiveLists(archiveItem(page, 'imported'));
    expect(lists.howRead).toEqual([fill(A.gaps.assumption.many, { n: '2' })]);
    expect(lists.notImported).toEqual([]);
    expect(lists.howRead[0]).not.toBe(fill(A.gaps.other.many, { n: '2' }));
    // It says why it cannot say which, and what to do.
    expect(A.gaps.assumption.one).toContain('import it again');
  });

  test('an archive from an engine that sends no family says items, and an empty import says it found nothing', async () => {
    const { family: _family, ...old } = ARCHIVE;
    const unknown = await mount({ [DASHBOARD_TOOL_NAME]: () => dashboard('archives-imported', meta([old])) });
    expect(archiveItem(unknown, 'imported').textContent).toContain(fill(A.nouns.other.many, { n: '1,250' }));

    const empty = await mount({ [DASHBOARD_TOOL_NAME]: () => previewState('archives-empty') });
    const item = archiveItem(empty, 'imported');
    expect(item.textContent).toContain('no notes found in this archive');
    expect(item.textContent).not.toContain(A.countsUnavailable.why);
    expect(item.textContent).not.toContain(fill(A.nouns.note.many, { n: '0' }));
    expect(item.textContent).not.toContain(fill(A.judgedLine, { judged: '0', held: '0' }));
    // Without a time to say, the same sentence reads on its own.
    const { importedAt: _at, ...untimed } = { ...ARCHIVE, family: 'note', items: 0, judged: 0, held: 0 };
    const bare = await mount({ [DASHBOARD_TOOL_NAME]: () => dashboard('archives-imported', meta([untimed])) });
    expect(archiveItem(bare, 'imported').textContent).toContain(fill(A.emptyImport, { none: A.nouns.note.none }));
    // An archive found nothing at all only when it also left out and could not read nothing.
    const { importedAt: _zeroAt, ...reasonsOfNothing } = { ...ARCHIVE, family: 'note', items: 0, judged: 0, held: 0, gaps: [{ kind: 'message_unreadable', count: 0 }], skipped: [] };
    const zero = await mount({ [DASHBOARD_TOOL_NAME]: () => dashboard('archives-imported', meta([reasonsOfNothing])) });
    expect(archiveItem(zero, 'imported').textContent).toContain(fill(A.emptyImport, { none: A.nouns.note.none }));
  });

  test('an archive whose messages were all left out or not read says no messages were imported, with the reasons', async () => {
    const page = await mount({ [DASHBOARD_TOOL_NAME]: () => previewState('archives-nothing-imported') });
    const item = archiveItem(page, 'imported');
    expect(item.textContent).toMatch(/No messages imported .+ ago\./);
    expect(item.textContent).not.toContain('found in this archive');
    expect(item.textContent).not.toContain(A.countsUnavailable.why);
    expect(item.textContent).not.toContain(fill(A.judgedLine, { judged: '0', held: '0' }));
    // The reasons stay one press away, in plain words.
    expect(item.textContent).toContain(A.seeWhy.notImported);
    expect(item.textContent).toContain(fill(A.gaps.spam_or_trash.many, { n: '1,204' }));
    expect(item.textContent).toContain(fill(A.gaps.message_too_large.many, { n: '2' }));
    // The same for notes, and without a time to say.
    const { importedAt: _at, ...untimed } = { ...ARCHIVE, family: 'note', items: 0, judged: 0, held: 0, gaps: [{ kind: 'file_damaged', count: 1 }], skipped: [] };
    const notes = await mount({ [DASHBOARD_TOOL_NAME]: () => dashboard('archives-imported', meta([untimed])) });
    expect(archiveItem(notes, 'imported').textContent).toContain('No notes imported.');
  });

  test('the picker names the formats the engine registers, from the registry', async () => {
    expect(A.pick.intro).toContain('an .mbox file from Google Takeout or Thunderbird');
    expect(A.pick.intro.startsWith('Drop a file or folder from this computer: ')).toBe(true);
    expect(A.pick.intro).toContain('Olympus keeps a copy in its own storage to read it until you remove the import, and never changes the original.');
    // Import another archive takes any export, and says where one of a source's own goes.
    expect(A.pick.intro.endsWith('An export from one of your sources joins that source; any other is kept under Other archives.')).toBe(true);
  });

  test('stopped: which file, what happened, and what to do', async () => {
    const page = await mount({
      [DASHBOARD_TOOL_NAME]: () => dashboard('archives-stopped', meta([
        { ...STARTED, status: 'stopped', stop: { code: 'file_changed', file: ARCHIVE.name } },
        { ...STARTED, id: '7b2a1f3e-5d4c-4b6a-9f8e-2c3d4e5f6a71', name: 'Gone.mbox', status: 'stopped', stop: { code: 'file_missing' } },
      ])),
    });
    const items = Array.from(page.doc.querySelectorAll('li.archive[data-archive="stopped"]'));
    expect(items).toHaveLength(2);
    expect(items[0]!.textContent).toContain(A.status.stopped);
    expect(items[0]!.textContent).toContain(fill(A.stopped.file_changed.why, { file: ARCHIVE.name }));
    expect(items[0]!.textContent).toContain(A.stopped.file_changed.fix);
    // No file named: the sentence still reads.
    expect(items[1]!.textContent).toContain(fill(A.stopped.file_missing.why, { file: A.thisFile }));
    expect(items[1]!.textContent).toContain(A.stopped.file_missing.fix);
  });

  test('Remove asks first in the archive\'s name, then removes it and says so; removing has no Remove', async () => {
    let answer = dashboard('archives-imported', meta([ARCHIVE]));
    const page = await mount({
      [DASHBOARD_TOOL_NAME]: () => answer,
      [ARCHIVE_REMOVE_TOOL_NAME]: () => ({ content: [{ type: 'text', text: 'Removing.' }], structuredContent: { ok: true } }),
    });
    const remove = Array.from(archiveItem(page, 'imported').querySelectorAll('button')).find((node) => node.textContent === A.remove) as HTMLButtonElement;
    remove.click();
    await settle();
    expect(page.text()).toContain(fill(A.removeConfirm, { name: ARCHIVE.name }));
    expect(page.calls(ARCHIVE_REMOVE_TOOL_NAME)).toEqual([]);
    answer = dashboard('archives-removing', meta([{ ...ARCHIVE, status: 'removing' }]));
    page.button('Yes, remove').click();
    await until(() => page.doc.querySelector('li.archive[data-archive="removing"]') !== null);
    expect(page.calls(ARCHIVE_REMOVE_TOOL_NAME)).toEqual([{ name: ARCHIVE_REMOVE_TOOL_NAME, arguments: { archive_id: ARCHIVE.id } }]);
    expect(page.text()).toContain(fill(A.removing, { name: ARCHIVE.name }));
    const removing = archiveItem(page, 'removing');
    expect(removing.textContent).toContain(A.removingLine);
    expect(Array.from(removing.querySelectorAll('button')).map((node) => node.textContent)).not.toContain(A.remove);
  });
});

describe('imports asked for', () => {
  const REQUEST = { id: '8c3b2a1f-6e5d-4c7b-8a9f-3d4e5f6a7b82', name: 'Takeout-2.mbox', where: '~/Downloads' };

  test('an agent\'s request waits for Import or Decline', async () => {
    let answer = dashboard('archives-request', meta([], [{ ...REQUEST, origin: 'agent', status: 'pending' }]));
    const page = await mount({
      [DASHBOARD_TOOL_NAME]: () => answer,
      [ARCHIVE_APPROVE_TOOL_NAME]: () => ({ content: [{ type: 'text', text: 'Importing.' }], structuredContent: { status: 'started', name: REQUEST.name } }),
      [ARCHIVE_DECLINE_TOOL_NAME]: () => ({ content: [{ type: 'text', text: 'Declined.' }], structuredContent: { ok: true } }),
    });
    expect(page.text()).toContain(fill(A.requestLine, { name: REQUEST.name, where: REQUEST.where }));
    page.button(A.approve).click();
    await until(() => page.calls(ARCHIVE_APPROVE_TOOL_NAME).length > 0 && page.text().includes(fill(A.started, { name: REQUEST.name })));
    expect(page.calls(ARCHIVE_APPROVE_TOOL_NAME)).toEqual([{ name: ARCHIVE_APPROVE_TOOL_NAME, arguments: { request_id: REQUEST.id } }]);
    expect(page.text()).toContain(fill(A.started, { name: REQUEST.name }));

    answer = dashboard('archives-request', meta([], [{ ...REQUEST, origin: 'agent', status: 'pending' }]));
    const again = await mount({
      [DASHBOARD_TOOL_NAME]: () => answer,
      [ARCHIVE_DECLINE_TOOL_NAME]: () => ({ content: [{ type: 'text', text: 'Declined.' }], structuredContent: { ok: true } }),
    });
    answer = dashboard('archives-none', meta([], []));
    again.button(A.decline).click();
    await until(() => again.calls(ARCHIVE_DECLINE_TOOL_NAME).length > 0 && again.text().includes(A.declined)
      && !again.text().includes(fill(A.requestLine, { name: REQUEST.name, where: REQUEST.where })));
    expect(again.calls(ARCHIVE_DECLINE_TOOL_NAME)).toEqual([{ name: ARCHIVE_DECLINE_TOOL_NAME, arguments: { request_id: REQUEST.id } }]);
    expect(again.text()).toContain(A.declined);
    expect(again.text()).not.toContain(fill(A.requestLine, { name: REQUEST.name, where: REQUEST.where }));
  });

  test('checking, already imported and failed each say so; the finished ones can be dismissed', async () => {
    const page = await mount({
      [DASHBOARD_TOOL_NAME]: () => dashboard('archives-checking', meta([ARCHIVE], [
        { ...REQUEST, origin: 'dashboard', status: 'checking' },
        { ...REQUEST, id: '9d4c3b2a-7f6e-4d8c-9b0a-4e5f6a7b8c93', name: 'Copy.mbox', origin: 'dashboard', status: 'already_imported', archiveId: ARCHIVE.id, archiveName: ARCHIVE.name },
        { ...REQUEST, id: 'ae5d4c3b-8a7f-4e9d-8c1b-5f6a7b8c9da4', name: 'Moving.mbox', origin: 'dashboard', status: 'failed', code: 'changed' },
      ])),
      [ARCHIVE_DECLINE_TOOL_NAME]: () => ({ content: [{ type: 'text', text: 'Dismissed.' }], structuredContent: { ok: true } }),
    });
    const checking = page.doc.querySelector('li.archive.request [role="status"]');
    expect(checking!.textContent).toBe(fill(A.checkingLine, { name: REQUEST.name }));
    expect(page.text()).toContain(fill(A.alreadyLine, { name: 'Copy.mbox', archive: ARCHIVE.name }));
    expect(page.text()).toContain(fill(A.failedLine, { name: 'Moving.mbox', reason: A.failed.changed }));
    const dismiss = page.buttons().filter((node) => node.textContent === A.dismiss);
    // A check still running has nothing to dismiss.
    expect(dismiss).toHaveLength(2);
    dismiss[0]!.click();
    await until(() => page.calls(ARCHIVE_DECLINE_TOOL_NAME).length > 0);
    await settle(30);
    expect(page.calls(ARCHIVE_DECLINE_TOOL_NAME)).toEqual([{ name: ARCHIVE_DECLINE_TOOL_NAME, arguments: { request_id: '9d4c3b2a-7f6e-4d8c-9b0a-4e5f6a7b8c93' } }]);
    // Dismiss only clears a finished check: no "Declined." line.
    expect(page.text()).not.toContain(A.declined);
  });

  test('a check can be cancelled, and one that ended without importing can be tried again', async () => {
    const FAILED = 'ae5d4c3b-8a7f-4e9d-8c1b-5f6a7b8c9da4';
    let answer = dashboard('archives-checking', meta([ARCHIVE], [
      { ...REQUEST, origin: 'dashboard', status: 'checking' },
      { ...REQUEST, id: FAILED, name: 'Moved.mbox', origin: 'dashboard', status: 'failed', code: 'replaced' },
    ]));
    const page = await mount({
      [DASHBOARD_TOOL_NAME]: () => answer,
      [ARCHIVE_DECLINE_TOOL_NAME]: () => ({ content: [{ type: 'text', text: 'Cancelled.' }], structuredContent: { ok: true } }),
      [ARCHIVE_APPROVE_TOOL_NAME]: () => ({ content: [{ type: 'text', text: 'Importing.' }], structuredContent: { status: 'started', name: 'Moved.mbox' } }),
    });
    expect(page.text()).toContain(fill(A.failedLine, { name: 'Moved.mbox', reason: A.failed.replaced }));
    answer = dashboard('archives-checking', meta([ARCHIVE], [{ ...REQUEST, id: FAILED, name: 'Moved.mbox', origin: 'dashboard', status: 'failed', code: 'replaced' }]));
    page.button(A.cancel).click();
    await until(() => page.text().includes(fill(A.cancelled, { name: REQUEST.name })) && !page.hasButton(A.cancel));
    expect(page.calls(ARCHIVE_DECLINE_TOOL_NAME)).toEqual([{ name: ARCHIVE_DECLINE_TOOL_NAME, arguments: { request_id: REQUEST.id } }]);
    expect(page.text()).toContain(fill(A.cancelled, { name: REQUEST.name }));
    expect(page.hasButton(A.cancel)).toBe(false);

    answer = dashboard('archives-checking', meta([ARCHIVE], []));
    page.button(A.tryAgain).click();
    await until(() => page.calls(ARCHIVE_APPROVE_TOOL_NAME).length > 0 && page.text().includes(fill(A.started, { name: 'Moved.mbox' })));
    expect(page.calls(ARCHIVE_APPROVE_TOOL_NAME)).toEqual([{ name: ARCHIVE_APPROVE_TOOL_NAME, arguments: { request_id: FAILED } }]);
    expect(page.text()).toContain(fill(A.started, { name: 'Moved.mbox' }));
  });
});

describe('Needs you for imports', () => {
  const TAKEOUT = 'All mail Including Spam and Trash.mbox';

  /** The Archives row, and whether its dot is the Needs you one. */
  function archivesRow(page: Page): Element {
    // Its own section below Sources (Other archives): the one row there.
    const row = page.doc.querySelector('section.other-archives li.row.source');
    if (!row) throw new Error(`no Archives row in: ${page.text()}`);
    return row;
  }

  test('a stopped import: a Needs you line whose See why goes to that archive in place; the row is not green', async () => {
    const page = await mount({ [DASHBOARD_TOOL_NAME]: () => previewState('archives-stopped') });
    const line = needsYou(page).get(fill(A.needsYou.stopped, { name: TAKEOUT }));
    expect(line).toBeDefined();
    expect(archivesRow(page).querySelector('.dot')!.className).toContain('tone-warn');
    const before = page.sent.length;
    (Array.from(line!.querySelectorAll('button')).find((node) => node.textContent === A.needsYou.seeWhy) as HTMLButtonElement).click();
    await settle();
    // In place: no tool, no link; the stopped archive itself is outlined.
    expect(page.sent.slice(before).filter((message) => message.method === 'tools/call' || message.method === 'ui/open-link')).toEqual([]);
    expect(archiveItem(page, 'stopped').className).toContain('landed');
  });

  test('an agent\'s request: a Needs you line whose Review goes to that request in place', async () => {
    const page = await mount({ [DASHBOARD_TOOL_NAME]: () => previewState('archives-request') });
    const line = needsYou(page).get(fill(A.needsYou.request, { name: 'Takeout-2.mbox' }));
    expect(line).toBeDefined();
    (Array.from(line!.querySelectorAll('button')).find((node) => node.textContent === A.needsYou.review) as HTMLButtonElement).click();
    await settle();
    expect(page.doc.querySelector('li.archive.request[data-request="pending"]')!.className).toContain('landed');
    expect(page.calls(ARCHIVE_APPROVE_TOOL_NAME)).toEqual([]);
  });

  test('held messages with no private model: a Needs you line that opens the private model in place', async () => {
    const page = await mount({ [DASHBOARD_TOOL_NAME]: () => previewState('archives-waiting') });
    const line = needsYou(page).get(fill(A.needsYou.held.many, { n: '48,210' }));
    expect(line).toBeDefined();
    (Array.from(line!.querySelectorAll('button')).find((node) => node.textContent === A.needsYou.setUp) as HTMLButtonElement).click();
    await settle();
    expect((page.doc.querySelector('details[data-open-key="models"]') as HTMLDetailsElement | null)?.open).toBe(true);
    expect(page.calls().map((call) => call.name).every((name) => name === DASHBOARD_TOOL_NAME)).toBe(true);
  });

  test('a list that cannot be read: never "no archives imported yet", no Import, and See why says why and what to do', async () => {
    const page = await mount({ [DASHBOARD_TOOL_NAME]: () => previewState('archives-unreadable') });
    expect(page.text()).not.toMatch(/No archives imported yet/i);
    expect(archivesRow(page).textContent).toMatch(/can't read the list of imported archives/i);
    expect(page.hasButton(A.importAction)).toBe(false);
    const line = needsYou(page).get(A.needsYou.unreadable);
    expect(line).toBeDefined();
    (Array.from(line!.querySelectorAll('button')).find((node) => node.textContent === A.needsYou.seeWhy) as HTMLButtonElement).click();
    await settle();
    const why = archivesRow(page).querySelector('details.why') as HTMLDetailsElement;
    expect(why.open).toBe(true);
    const file = '~/.local/share/openclaw/olympus/archive-imports.json';
    expect(why.textContent).toContain(fill(A.unreadable.why.damaged, { file }));
    expect(why.textContent).toContain(A.unreadable.kept);
    expect(why.textContent).toContain(A.unreadable.fix.damaged);
  });

  test('a check that ended without importing: a Needs you line whose See why goes to that request, with Try again', async () => {
    const page = await mount({ [DASHBOARD_TOOL_NAME]: () => previewState('archives-failed') });
    const line = needsYou(page).get(fill(A.needsYou.failed, { name: 'Inbox.mbox' }));
    expect(line).toBeDefined();
    (Array.from(line!.querySelectorAll('button')).find((node) => node.textContent === A.needsYou.seeWhy) as HTMLButtonElement).click();
    await settle();
    const request = page.doc.querySelector('li.archive.request[data-request="failed"]')!;
    expect(request.className).toContain('landed');
    expect(Array.from(request.querySelectorAll('button')).map((node) => node.textContent)).toEqual([A.tryAgain, A.dismiss]);
    expect(archivesRow(page).querySelector('.dot')!.className).toContain('tone-warn');
    // Said once, in one form: what happened, with Try again and Dismiss beside it.
    expect(request.querySelector('p')!.textContent).toBe('Inbox.mbox was not imported: it changed while Olympus was reading it.');
    for (const reason of Object.values(A.failed)) {
      for (const second of ['Import it again', 'Try again', 'Choose it again']) expect(reason).not.toContain(second);
    }
  });

  test('an archive Olympus cannot count now: never "0 messages", a Needs you line that goes to it', async () => {
    const page = await mount({ [DASHBOARD_TOOL_NAME]: () => previewState('archives-uncounted') });
    const archive = archiveItem(page, 'imported');
    expect(archive.textContent).toContain(A.countsUnavailable.why);
    expect(archive.textContent).toContain(A.countsUnavailable.fix);
    expect(archive.textContent).not.toContain(fill(A.nouns.email.many, { n: '0' }));
    expect(archive.textContent).not.toContain(fill(A.judgedLine, { judged: '0', held: '0' }));
    const line = needsYou(page).get(fill(A.needsYou.counts, { name: TAKEOUT }));
    expect(line).toBeDefined();
    (Array.from(line!.querySelectorAll('button')).find((node) => node.textContent === A.needsYou.seeWhy) as HTMLButtonElement).click();
    await settle();
    expect(archiveItem(page, 'imported').className).toContain('landed');
  });

  test('imports this computer\'s settings keep from running: a Needs you line whose See why names the setting and what to do', async () => {
    const page = await mount({ [DASHBOARD_TOOL_NAME]: () => previewState('archives-not-running') });
    const line = needsYou(page).get(A.needsYou.scheduler.disabled);
    expect(line).toBeDefined();
    (Array.from(line!.querySelectorAll('button')).find((node) => node.textContent === A.needsYou.seeWhy) as HTMLButtonElement).click();
    await settle();
    const why = archivesRow(page).querySelector('details.why') as HTMLDetailsElement;
    expect(why.open).toBe(true);
    // One plain sentence first, then the setting and the restart.
    expect(Array.from(why.querySelectorAll('li')).map((node) => node.textContent)).toEqual([A.notRunning.why.disabled, A.notRunning.fix.disabled]);
    expect(A.notRunning.why.disabled).toBe("Background syncing is turned off in Olympus's settings, so imports can't run.");
    for (const setting of ['disabled', 'not_selected'] as const) {
      expect(A.notRunning.why[setting]).not.toContain('worker.scheduler');
      expect(A.notRunning.fix[setting]).toContain(setting === 'disabled' ? 'worker.scheduler.enabled' : 'worker.scheduler.sourceIds');
      expect(A.notRunning.fix[setting]).toContain('restart Olympus after changing it');
    }
  });

  test('an import that cannot run says so: not Importing, no progress bar, and Remove shown but not pressable, its reason beside it', async () => {
    const page = await mount({ [DASHBOARD_TOOL_NAME]: () => previewState('archives-not-running') });
    const archive = archiveItem(page, 'importing');
    expect(archive.getAttribute('data-not-running')).toBe('disabled');
    expect(archive.querySelector('.ftag')!.textContent).toBe(A.status.notRunning);
    expect(archive.querySelector('[role="progressbar"]')).toBeNull();
    expect(archive.textContent).toContain(fill(A.notRunningLine, { percent: '0', items: fill(A.nouns.email.many, { n: '0' }) }));
    expect(archivesRow(page).textContent).not.toContain(A.status.importing);
    const remove = Array.from(archive.querySelectorAll('button')).find((node) => node.textContent === A.remove) as HTMLButtonElement;
    expect(remove.disabled).toBe(true);
    expect(archive.textContent).toContain(A.removeNotRunning.disabled);
  });

  test('the archive copy uses straight apostrophes throughout', () => {
    const strings: string[] = [];
    const walk = (value: unknown): void => {
      if (typeof value === 'string') strings.push(value);
      else if (value && typeof value === 'object') Object.values(value).forEach(walk);
    };
    walk(A);
    walk(ARCHIVE_APPROVE_COPY);
    walk(ARCHIVE_NOT_RUNNING_COPY);
    expect(strings.filter((text) => text.includes('\u2019'))).toEqual([]);
  });

  test('an imported archive with everything judged adds nothing to Needs you', async () => {
    const page = await mount({ [DASHBOARD_TOOL_NAME]: () => previewState('archives-imported') });
    expect([...needsYou(page).keys()].filter((sentence) => sentence.includes('import') || sentence.includes('archive'))).toEqual([]);
  });

  test('in ChatGPT the same lines open the computer\'s Archives row', async () => {
    const result = previewState('archives-stopped');
    const page = await mount({}, { computer: false, dashboard: () => ({ ...result, _meta: {} }) });
    const line = needsYou(page).get(fill(A.needsYou.stopped, { name: TAKEOUT }));
    expect(line).toBeDefined();
    (Array.from(line!.querySelectorAll('button')).find((node) => node.textContent === A.needsYou.seeWhy) as HTMLButtonElement).click();
    await settle();
    const opened = page.sent.filter((message) => message.method === 'ui/open-link').map((message) => message.params.url as string);
    expect(opened).toEqual(['https://olympusplugin.ai/open/archives/']);
  });
});

describe('the Archives row in ChatGPT', () => {
  test('Import an archive opens the computer\'s dashboard, and no list of archives is drawn', async () => {
    const result = dashboard('archives-none');
    const page = await mount({}, {
      computer: false,
      dashboard: () => ({ ...result, _meta: { ...result._meta, [COMPUTER_META_KEY]: { archives: meta([ARCHIVE]) } } }),
    });
    expect(page.text()).toMatch(/No archives imported yet/i);
    expect(page.doc.querySelector('ul.archives')).toBeNull();
    expect(page.text()).not.toContain(ARCHIVE.name);
    page.button(A.importAction).click();
    await settle();
    const opened = page.sent.filter((message) => message.method === 'ui/open-link').map((message) => message.params.url as string);
    expect(opened).toHaveLength(1);
    expect(opened[0]).toContain('olympusplugin.ai/open/dashboard/');
    expect(page.calls(ARCHIVE_UPLOAD_START_TOOL_NAME)).toEqual([]);
  });
});

// Imports that joined a live source (contract 2.2.0): listed inside that
// source's own card, never under Archives, each with its own progress,
// findings and Stop; the card counts each item once and an import counts its own run.
describe('an import inside its source\'s card', () => {
  const SOURCE = 'gmail.email';
  const IMPORT: ComputerSourceImportEntry = {
    id: '9d4c3b2a-7f6e-4d8c-9b0a-4e5f6a7b8c93',
    name: 'Old work mail.mbox',
    format: 'Mail (mbox)',
    family: 'email',
    where: '~/Exports',
    status: 'imported',
    read: 1_250,
    alreadyThere: 300,
    earliest: '2011-02-03',
    latest: '2019-12-30',
    startedAt: '2026-10-22T08:00:00.000Z',
    importedAt: '2026-10-22T09:00:00.000Z',
    gaps: [],
    skipped: [],
  };

  /** The dashboard with `groups` as the computer's imports that joined a source. */
  function withSourceImports(groups: ComputerSourceImportsMeta[], archives: ComputerArchivesMeta = meta([])) {
    const base = dashboard('archives-imported', archives) as { _meta: Record<string, any> };
    return { ...base, _meta: { ...base._meta, [COMPUTER_META_KEY]: { ...base._meta[COMPUTER_META_KEY], sourceImports: groups } } };
  }

  /** The source's own row, found by the import list it holds. */
  function sourceCard(page: Page): Element {
    const found = page.doc.querySelector('li[data-source-import]')?.closest('li.source');
    if (!found) throw new Error(`no source card holds an import in: ${page.text()}`);
    return found;
  }

  test('an import that joined a source is listed in that card, with its own count and what was already there', async () => {
    const page = await mount({
      [DASHBOARD_TOOL_NAME]: () => withSourceImports([{ sourceId: SOURCE, imports: [IMPORT], covers: { importedFrom: '2011-02-03', importedTo: '2019-12-30', liveSince: '2026-05-01' } }]),
    });
    const card = sourceCard(page);
    expect(card.querySelector('.source-name')!.textContent).toBe('Gmail');
    const text = card.textContent ?? '';
    expect(text).toContain(IMPORT.name);
    expect(text).toContain(fill(A.inSource.importedLine, { items: fill(A.nouns.email.many, { n: '1,250' }) }) + fill(A.inSource.alreadyThere.many, { n: '300' }));
    // Which history each input covers.
    expect(text).toContain('History imported up to 2019-12-30 · live since 2026-05-01');
    // It is not an Archives row, and it has no Remove of its own.
    expect(Array.from(card.querySelectorAll('button')).map((node) => node.textContent)).not.toContain(A.remove);
    expect(page.doc.querySelectorAll('li.archive[data-archive]').length).toBe(1);
  });

  test('one that was entirely new says nothing about what was already there; one already there entirely says so in the singular form', async () => {
    const page = await mount({
      [DASHBOARD_TOOL_NAME]: () => withSourceImports([{ sourceId: SOURCE, imports: [
        { ...IMPORT, alreadyThere: 0 },
        { ...IMPORT, id: 'a1b2c3d4-0000-4000-8000-000000000001', name: 'Second.mbox', read: 40, alreadyThere: 1 },
      ] }]),
    });
    const lines = Array.from(sourceCard(page).querySelectorAll('li[data-source-import]')).map((item) => item.textContent ?? '');
    expect(lines[0]).not.toContain('already there');
    expect(lines[1]).toContain(A.inSource.alreadyThere.one);
  });

  test('importing: how far, and Stop; pressing Stop calls the stop tool and keeps what was imported', async () => {
    let answer = withSourceImports([{ sourceId: SOURCE, imports: [{ ...IMPORT, status: 'importing', percent: 42, read: 500, alreadyThere: 120 }] }]);
    const page = await mount({
      [DASHBOARD_TOOL_NAME]: () => answer,
      [ARCHIVE_STOP_TOOL_NAME]: () => ({ content: [{ type: 'text', text: 'Stopped.' }], structuredContent: { ok: true } }),
    });
    const item = sourceCard(page).querySelector('li[data-source-import]')!;
    expect(item.textContent).toContain(fill(A.inSource.importingLine, { percent: '42', items: fill(A.nouns.email.many, { n: '500' }) }) + fill(A.inSource.alreadyThere.many, { n: '120' }));
    expect(item.querySelector('[role="progressbar"]')).not.toBeNull();
    answer = withSourceImports([{ sourceId: SOURCE, imports: [{ ...IMPORT, status: 'stopped', read: 500, alreadyThere: 120, stop: { code: 'stopped_by_owner' } }] }]);
    page.button(A.inSource.stop).click();
    await until(() => page.calls(ARCHIVE_STOP_TOOL_NAME).length > 0 && page.doc.querySelector('li[data-source-import][data-archive="stopped"]') !== null);
    expect(page.calls(ARCHIVE_STOP_TOOL_NAME)).toEqual([{ name: ARCHIVE_STOP_TOOL_NAME, arguments: { archive_id: IMPORT.id } }]);
    // The person's own Stop is not a problem: it says what stays and how to go on, and is no Needs you line.
    const stopped = sourceCard(page).querySelector('li[data-source-import][data-archive="stopped"]')!;
    expect(stopped.textContent).toContain(A.inSource.stoppedWhy.stopped_by_owner.why);
    expect(stopped.textContent).toContain(A.inSource.stoppedWhy.stopped_by_owner.fix);
    expect(stopped.textContent).toContain(fill(A.inSource.importedLine, { items: fill(A.nouns.email.many, { n: '500' }) }));
    expect(stopped.className).not.toContain('stopped');
    expect(Array.from(stopped.querySelectorAll('button')).map((node) => node.textContent)).not.toContain(A.inSource.stop);
  });

  test('stopped by something that needs the person: says why and what to do, and the account case names its way forward', async () => {
    const page = await mount({
      [DASHBOARD_TOOL_NAME]: () => withSourceImports([{ sourceId: SOURCE, imports: [{ ...IMPORT, status: 'stopped', read: 10, alreadyThere: 0, stop: { code: 'account_changed' } }] }]),
    });
    const stopped = sourceCard(page).querySelector('li[data-source-import][data-archive="stopped"]')!;
    expect(stopped.className).toContain('stopped');
    expect(stopped.textContent).toContain(A.inSource.stoppedWhy.account_changed.why);
    expect(stopped.textContent).toContain(A.inSource.stoppedWhy.account_changed.fix);
    // Never a Remove, and never a code.
    expect(stopped.textContent).not.toContain('account_changed');
    expect(Array.from(stopped.querySelectorAll('button')).map((node) => node.textContent)).not.toContain(A.remove);
  });

  test('findings are plain sentences in the same two lists as an archive\'s', async () => {
    const page = await mount({
      [DASHBOARD_TOOL_NAME]: () => withSourceImports([{ sourceId: SOURCE, imports: [{
        ...IMPORT,
        gaps: [{ kind: 'message_too_large', count: 2 }],
        skipped: [{ kind: 'spam_or_trash', count: 30 }],
      }] }]),
    });
    const item = sourceCard(page).querySelector('li[data-source-import]')!;
    const lists = archiveLists(item);
    expect(lists.button).toBeDefined();
    expect(lists.notImported.join(' ')).toContain('30 messages in Spam or Trash left out');
    expect(lists.notImported.join(' ')).toContain('2 messages too large to read');
  });

  test('imports that cannot run say why, with no Stop shown as if they were moving', async () => {
    const page = await mount({
      [DASHBOARD_TOOL_NAME]: () => withSourceImports([{ sourceId: SOURCE, notRunning: 'disabled', imports: [{ ...IMPORT, status: 'importing', percent: 10, read: 5, alreadyThere: 0 }] }]),
    });
    const item = sourceCard(page).querySelector('li[data-source-import]')!;
    expect(item.getAttribute('data-not-running')).toBe('disabled');
    expect(item.querySelector('[role="progressbar"]')).toBeNull();
    expect(item.textContent).toContain(fill(A.inSource.notRunningLine, { percent: '10' }));
  });

  test('in ChatGPT no import list is drawn in the card', async () => {
    const page = await mount({}, { computer: false, dashboard: () => previewDashboardToolResult('archives-imported', false) });
    expect(page.doc.querySelector('li[data-source-import]')).toBeNull();
  });
});

describe('the import sheet asks which account an export belongs to', () => {
  test('an export whose account cannot be proved asks in place; Add it joins the source, Keep it apart does not; the answer is about the same upload', async () => {
    const asked = { content: [{ type: 'text', text: 'Which account?' }], structuredContent: { status: 'confirm_account', name: 'Takeout-2026-10.mbox', source: { id: 'gmail.email', label: 'Gmail' } } };
    const started = { content: [{ type: 'text', text: 'Started.' }], structuredContent: { status: 'started', name: 'Takeout-2026-10.mbox', archive_id: '9d4c3b2a-7f6e-4d8c-9b0a-4e5f6a7b8c93' } };
    const answers: any[] = [];
    const page = await mount({
      [DASHBOARD_TOOL_NAME]: () => dashboard('archives-none', meta([])),
      ...uploadServe(),
      [ARCHIVE_APPROVE_TOOL_NAME]: (args) => {
        answers.push(args);
        return args.confirm_account === true || args.keep_apart === true ? started : asked;
      },
    }, { upload: noteUploads });
    page.button(A.importAction).click();
    await settle();
    choose(page, 'picker:drop:file-input', [{ path: 'Takeout-2026-10.mbox' }]);
    await until(() => page.text().includes(fill(A.account.line, { name: 'Takeout-2026-10.mbox', source: 'Gmail' })));
    // Still on the screen, with the question beside the file and no import started.
    expect(page.text()).toContain(fill(A.account.line, { name: 'Takeout-2026-10.mbox', source: 'Gmail' }));
    expect(page.text()).toContain(fill(A.account.note, { source: 'Gmail' }));
    const uploadId = page.uploads()[0]!.upload_id;
    expect(answers).toEqual([{ upload_id: uploadId }]);
    page.button(fill(A.account.addFor, { name: 'Takeout-2026-10.mbox', source: 'Gmail' })).click();
    await until(() => answers.length > 1);
    // Nothing is uploaded again: the same upload is answered.
    expect(answers[1]).toEqual({ upload_id: uploadId, confirm_account: true });
    expect(page.uploads()).toHaveLength(1);
    expect(page.hasButton(A.account.apart)).toBe(false);
  });

  test('asking again after the source changed account offers only Add and Start over, and says where to keep the export apart', async () => {
    const asked = { content: [{ type: 'text', text: 'Which account?' }], structuredContent: { status: 'confirm_account', reconfirm: true, name: 'Takeout-2026-10.mbox', source: { id: 'gmail.email', label: 'Gmail' } } };
    const page = await mount({
      [DASHBOARD_TOOL_NAME]: () => dashboard('archives-none', meta([])),
      ...uploadServe(),
      [ARCHIVE_APPROVE_TOOL_NAME]: () => asked,
    }, { upload: noteUploads });
    page.button(A.importAction).click();
    await settle();
    choose(page, 'picker:drop:file-input', [{ path: 'Takeout-2026-10.mbox' }]);
    await until(() => page.text().includes(fill(A.account.reconfirm.line, { name: 'Takeout-2026-10.mbox', source: 'Gmail' })));
    expect(page.text()).toContain(fill(A.account.reconfirm.note, { source: 'Gmail' }));
    expect(page.text()).toContain('Other archives');
    expect(page.hasButton(fill(A.account.addFor, { name: 'Takeout-2026-10.mbox', source: 'Gmail' }))).toBe(true);
    expect(page.hasButton(A.account.apart)).toBe(false);
    expect(page.doc.querySelector('[data-key="picker:confirm-apart"]')).toBeNull();
  });

  test('Start over on the question deletes the upload and goes back to the zone', async () => {
    const asked = { content: [{ type: 'text', text: 'Which account?' }], structuredContent: { status: 'confirm_account', name: 'Takeout-2026-10.mbox', source: { id: 'gmail.email', label: 'Gmail' } } };
    const page = await mount({
      [DASHBOARD_TOOL_NAME]: () => dashboard('archives-none', meta([])),
      ...uploadServe(),
      [ARCHIVE_APPROVE_TOOL_NAME]: () => asked,
    }, { upload: noteUploads });
    page.button(A.importAction).click();
    await settle();
    choose(page, 'picker:drop:file-input', [{ path: 'Takeout-2026-10.mbox' }]);
    await until(() => page.hasButton(A.pick.chooseAnother));
    const uploadId = page.uploads()[0]!.upload_id;
    page.button(A.pick.chooseAnother).click();
    await settle();
    expect(page.calls(ARCHIVE_UPLOAD_CANCEL_TOOL_NAME)).toEqual([{ name: ARCHIVE_UPLOAD_CANCEL_TOOL_NAME, arguments: { upload_id: uploadId } }]);
    expect(page.doc.querySelector('[data-key="picker:drop:zone"]')).not.toBeNull();
  });
});

describe('the preview states for imports that are inputs of a source', () => {
  const sourceImports = ['sources-import-importing', 'sources-import-imported', 'sources-import-stopped', 'sources-import-not-running', 'sources-import-delete'];
  const accounts = ['archives-account-confirm', 'archives-account-request', 'archives-account-apart'];

  test('every state is listed in the preview, so the 404 names it', () => {
    for (const state of [...sourceImports, ...accounts]) expect(DASHBOARD_PREVIEW_STATES as readonly string[]).toContain(state);
  });

  function gmailCard(page: Page): Element {
    const found = Array.from(page.doc.querySelectorAll('li.source')).find((card) => card.querySelector('.source-name')?.textContent === 'Gmail');
    if (!found) throw new Error(`no Gmail card in: ${page.text()}`);
    return found;
  }

  test('sources-import-importing: Gmail\'s card shows the import\'s progress, what Gmail already had, findings and Stop', async () => {
    const page = await mount({ [DASHBOARD_TOOL_NAME]: () => previewState('sources-import-importing') });
    const card = gmailCard(page);
    expect(card.textContent).toContain(fill(A.inSource.importingLine, { percent: '42', items: fill(A.nouns.email.many, { n: '18,420' }) }) + fill(A.inSource.alreadyThere.many, { n: '3,106' }));
    expect(card.querySelector('[role="progressbar"]')).not.toBeNull();
    expect(Array.from(card.querySelectorAll('button')).map((node) => node.textContent)).toContain(A.inSource.stop);
    expect(archiveLists(card.querySelector('li[data-source-import]')!).notImported.length).toBeGreaterThan(0);
    // Gmail's own card is the only place it is listed: the Archives row has no entry.
    expect(page.doc.querySelectorAll('li.archive[data-archive]').length).toBe(1);
  });

  test('sources-import-imported: the counts say how many were already there, and the card says which history each input covers', async () => {
    const page = await mount({ [DASHBOARD_TOOL_NAME]: () => previewState('sources-import-imported') });
    const card = gmailCard(page);
    const lines = Array.from(card.querySelectorAll('li[data-source-import]')).map((item) => item.textContent ?? '');
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain(fill(A.inSource.importedLine, { items: fill(A.nouns.email.many, { n: '48,210' }) }) + fill(A.inSource.alreadyThere.many, { n: '5,120' }));
    expect(lines[1]).toContain(fill(A.nouns.email.many, { n: '3,380' }));
    expect(lines[1]).not.toContain('already there');
    expect(card.textContent).toContain('History imported up to 2019-12-30 · live since 2026-05-01');
    expect(Array.from(card.querySelectorAll('button')).map((node) => node.textContent)).not.toContain(A.remove);
  });

  test('sources-import-stopped: a stopped file is a Needs you line and says how to go on; the person\'s own Stop is quiet', async () => {
    const page = await mount({ [DASHBOARD_TOOL_NAME]: () => previewState('sources-import-stopped') });
    const stopped = Array.from(gmailCard(page).querySelectorAll('li[data-source-import][data-archive="stopped"]'));
    expect(stopped).toHaveLength(2);
    expect(stopped[0]!.textContent).toContain(fill(A.inSource.stoppedWhy.file_changed.why, { file: 'Mail 2009 to 2019.mbox' }));
    expect(stopped[0]!.className).toContain('stopped');
    expect(stopped[1]!.textContent).toContain(A.inSource.stoppedWhy.stopped_by_owner.why);
    expect(stopped[1]!.className).not.toContain('stopped');
    const lines = Array.from(needsYou(page).keys());
    expect(lines.filter((line) => line.includes('Mail 2009 to 2019.mbox'))).toHaveLength(1);
    expect(lines.some((line) => line.includes('Shared inbox.mbox'))).toBe(false);
  });

  test('sources-import-not-running: the import says it is waiting, and Gmail\'s card says which setting holds it', async () => {
    const page = await mount({ [DASHBOARD_TOOL_NAME]: () => previewState('sources-import-not-running') });
    const item = gmailCard(page).querySelector('li[data-source-import]')!;
    expect(item.getAttribute('data-not-running')).toBe('disabled');
    expect(item.querySelector('[role="progressbar"]')).toBeNull();
    expect(item.textContent).toContain(fill(A.inSource.notRunningLine, { percent: '10' }));
  });

  test('sources-import-delete: deleting the source says the imported history goes with it, and a source with no import does not', async () => {
    const page = await mount({ [DASHBOARD_TOOL_NAME]: () => previewState('sources-import-delete') });
    const card = gmailCard(page);
    expect(card.textContent).toContain('Disconnected');
    const words = DASHBOARD_CHATGPT_PAGE_COPY.deleteDataConfirm.split('{source}').join('Gmail');
    const imports = DASHBOARD_CHATGPT_PAGE_COPY.deleteDataImports.split('{source}').join('Gmail');
    expect(page.hasButton('Delete indexed data')).toBe(true);
    page.button('Delete indexed data').click();
    await settle();
    expect(page.text()).toContain(words + ' ' + imports);
    expect(page.calls()).not.toContainEqual(expect.objectContaining({ name: DELETE_SOURCE_DATA_TOOL_NAME }));
    // A source nothing was imported into says nothing of imports.
    const plain = await mount({ [DASHBOARD_TOOL_NAME]: () => previewState('delete-data') });
    plain.button('Delete indexed data').click();
    await settle();
    expect(plain.text()).toContain(DASHBOARD_CHATGPT_PAGE_COPY.deleteDataConfirm.split('{source}').join('Dropbox'));
    expect(plain.text()).not.toContain('Archives you imported');
  });

  test('archives-account-confirm: the import sheet asks which account, in place, and answering starts the import', async () => {
    const answers: any[] = [];
    const page = await mount({
      [DASHBOARD_TOOL_NAME]: () => previewState('archives-account-confirm'),
      ...uploadServe(),
      [ARCHIVE_APPROVE_TOOL_NAME]: (args) => {
        answers.push(args);
        return previewArchiveApprove(args, 'archives-account-confirm');
      },
    }, { upload: noteUploads });
    page.button(A.importAction).click();
    await settle();
    choose(page, 'picker:drop:file-input', [{ path: 'Takeout-2026-10.mbox' }]);
    await until(() => page.text().includes(fill(A.account.line, { name: 'Takeout-2026-10.mbox', source: 'Gmail' })));
    expect(page.text()).toContain(fill(A.account.line, { name: 'Takeout-2026-10.mbox', source: 'Gmail' }));
    expect(page.hasButton(fill(A.account.addFor, { name: 'Takeout-2026-10.mbox', source: 'Gmail' }))).toBe(true);
    expect(page.hasButton(fill(A.account.apartFor, { name: 'Takeout-2026-10.mbox', source: 'Gmail' }))).toBe(true);
    // The first answer imported nothing; only the owner's choice starts it.
    expect(answers).toEqual([{ upload_id: page.uploads()[0]!.upload_id }]);
    expect(previewArchiveApprove({ key: '/Users/you/Mail exports/Takeout-2026-10.mbox', keep_apart: true }, 'archives-account-confirm').structuredContent).toMatchObject({ status: 'started' });
  });

  test('archives-account-request: an agent\'s request asks which account in its own row until answered', async () => {
    const page = await mount({
      [DASHBOARD_TOOL_NAME]: () => previewState('archives-account-request'),
      [ARCHIVE_APPROVE_TOOL_NAME]: (args) => previewArchiveApprove(args, 'archives-account-request'),
    });
    page.button(A.approve).click();
    await until(() => page.hasButton(fill(A.account.add, { source: 'Gmail' })));
    expect(page.text()).toContain(fill(A.account.line, { name: 'Takeout-2026-10.mbox', source: 'Gmail' }));
    expect(page.hasButton(A.account.apart)).toBe(true);
    expect(page.hasButton(A.decline)).toBe(true);
  });

  test('archives-account-apart: a different account\'s export stays under Archives with its Remove, beside Gmail\'s merged import without one', async () => {
    const page = await mount({ [DASHBOARD_TOOL_NAME]: () => previewState('archives-account-apart') });
    const merged = gmailCard(page).querySelector('li[data-source-import]')!;
    expect(Array.from(merged.querySelectorAll('button')).map((node) => node.textContent)).not.toContain(A.remove);
    const apart = Array.from(page.doc.querySelectorAll('li.archive[data-archive]')).filter((item) => !item.hasAttribute('data-source-import'));
    expect(apart).toHaveLength(1);
    expect(apart[0]!.textContent).toContain('Other address mail.mbox');
    expect(Array.from(apart[0]!.querySelectorAll('button')).map((node) => node.textContent)).toContain(A.remove);
  });
});
