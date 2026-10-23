// The Archives row in the dashboard panel, against a fake host: on the
// computer, Import an archive opens the picker in place (files beside
// folders), Import approves the choice and the row says what came of it, a
// refusal stays in the picker with the engine's reason; each archive's state
// renders with its way forward (Set up the private model, See what was not
// read, Remove with confirmation); an agent's request waits for Import or
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
  ARCHIVE_BROWSE_TOOL_NAME,
  ARCHIVE_DECLINE_TOOL_NAME,
  ARCHIVE_REMOVE_TOOL_NAME,
  COMPUTER_META_KEY,
  DASHBOARD_TOOL_NAME,
  OLYMPUS_HOST_CONTEXT_KEY,
  type ComputerArchiveEntry,
  type ComputerArchivesMeta,
} from '../src/workers/chatgpt/dashboard-contract.ts';
import { chatgptDashboardPageHtml } from '../src/workers/dashboard/chatgpt/page.ts';
import { DASHBOARD_ARCHIVE_COPY as A } from '../src/workers/dashboard/vocabulary.ts';
import { ARCHIVE_APPROVE_COPY, ARCHIVE_NOT_RUNNING_COPY } from '../src/workers/archive-import/dashboard.ts';
import { previewArchiveApprove, previewArchiveBrowse, previewDashboardToolResult } from '../scripts/dashboard-preview.ts';

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

const LINKS = {
  keys: 'http://127.0.0.1:8787/dashboard?keys',
  agents: 'http://127.0.0.1:8787/dashboard?agents',
  privateAnswers: 'http://127.0.0.1:8787/dashboard?private-answers',
  connector: 'http://127.0.0.1:8787/dashboard?connector',
};
const COMPUTER = { kind: 'computer', readOnly: false, links: LINKS };

/** The panel on a host that answers its tool calls from `serve`; `computer: false` is ChatGPT. */
async function mount(serve: Serve, options: { computer?: boolean; dashboard?: () => unknown } = {}): Promise<Page> {
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
          hostContext: { theme: 'light', displayMode: 'fullscreen', availableDisplayModes: ['fullscreen'], ...(computer ? { [OLYMPUS_HOST_CONTEXT_KEY]: COMPUTER } : {}) },
        });
      } else if (message.method === 'tools/call') {
        const handler = serve[message.params.name];
        if (handler) reply(message.id, handler(message.params.arguments ?? {}));
      } else if (message.method === 'ui/open-link') reply(message.id, {});
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

describe('Import an archive on the computer', () => {
  test('opens the picker in place over files and folders; Import approves the file and the row says it started', async () => {
    let answer = dashboard('archives-none', meta([]));
    const page = await mount({
      [DASHBOARD_TOOL_NAME]: () => answer,
      [ARCHIVE_BROWSE_TOOL_NAME]: (args) => previewArchiveBrowse(args),
      [ARCHIVE_APPROVE_TOOL_NAME]: (args) => previewArchiveApprove(args),
    });
    expect(page.text()).toMatch(/No archives imported yet/i);
    page.button(A.importAction).click();
    await settle();
    // In place: the computer's own listing, never a link out.
    expect(page.sent.some((message) => message.method === 'ui/open-link')).toBe(false);
    expect(page.calls(ARCHIVE_BROWSE_TOOL_NAME)[0]!.arguments).toEqual({});
    expect(page.text()).toContain(A.pick.intro);
    const open = page.doc.querySelector('[data-key="picker:open:/Users/you/Mail exports"]') as HTMLButtonElement | null;
    expect(open).not.toBeNull();
    open!.click();
    await settle();
    expect(page.calls(ARCHIVE_BROWSE_TOOL_NAME)[1]!.arguments).toMatchObject({ parent_key: '/Users/you/Mail exports' });
    // A file beside a folder, each with its own Import.
    expect(page.hasButton(fill(A.pick.makePrivateFor, { name: 'Takeout-2026-10.mbox' }))).toBe(true);
    expect(page.hasButton(fill(A.pick.makePrivateFor, { name: 'Inbox.mbox' }))).toBe(true);

    answer = dashboard('archives-importing', meta([{ ...ARCHIVE, name: 'Takeout-2026-10.mbox', status: 'importing', percent: 5, items: 40, judged: 0, held: 40 }]));
    page.button(fill(A.pick.makePrivateFor, { name: 'Takeout-2026-10.mbox' })).click();
    await until(() => page.doc.querySelector('li.archive[data-archive="importing"]') !== null);
    expect(page.calls(ARCHIVE_APPROVE_TOOL_NAME)).toEqual([{ name: ARCHIVE_APPROVE_TOOL_NAME, arguments: { key: '/Users/you/Mail exports/Takeout-2026-10.mbox' } }]);
    // Back on the dashboard, read again, with the one line that says what happened.
    expect(page.text()).not.toContain(A.pick.intro);
    expect(page.text()).toContain(fill(A.started, { name: 'Takeout-2026-10.mbox' }));
    expect(page.calls(DASHBOARD_TOOL_NAME).length).toBeGreaterThan(1);
    expect(archiveItem(page, 'importing').textContent).toContain(A.status.importing);
  });

  test('a refusal stays in the picker with the engine\'s reason, and Choose another clears it', async () => {
    const page = await mount({
      [DASHBOARD_TOOL_NAME]: () => dashboard('archives-none', meta([])),
      [ARCHIVE_BROWSE_TOOL_NAME]: (args) => previewArchiveBrowse(args),
      [ARCHIVE_APPROVE_TOOL_NAME]: (args) => previewArchiveApprove(args),
    });
    page.button(A.importAction).click();
    await settle();
    (page.doc.querySelector('[data-key="picker:open:/Users/you/Mail exports"]') as HTMLButtonElement).click();
    await settle();
    page.button(fill(A.pick.makePrivateFor, { name: 'notes.txt' })).click();
    await until(() => page.doc.querySelector('[role="alert"]') !== null);
    const alert = page.doc.querySelector('[role="alert"]');
    expect(alert).not.toBeNull();
    expect(alert!.textContent).toContain('Mail (mbox)');
    // Still in the picker, in the same folder.
    expect(page.hasButton(fill(A.pick.makePrivateFor, { name: 'Takeout-2026-10.mbox' }))).toBe(true);
    page.button(A.pick.chooseAnother).click();
    await settle();
    expect(page.doc.querySelector('[role="alert"]')).toBeNull();
    expect(page.hasButton(fill(A.pick.makePrivateFor, { name: 'notes.txt' }))).toBe(true);
    expect(page.calls(ARCHIVE_APPROVE_TOOL_NAME)).toHaveLength(1);
  });

  test('a copy of an earlier import says it is checking, and Back leaves the dashboard as it was', async () => {
    const page = await mount({
      [DASHBOARD_TOOL_NAME]: () => dashboard('archives-imported', meta([ARCHIVE])),
      [ARCHIVE_BROWSE_TOOL_NAME]: (args) => previewArchiveBrowse(args),
      [ARCHIVE_APPROVE_TOOL_NAME]: () => ({ content: [{ type: 'text', text: 'Checking.' }], structuredContent: { status: 'checking', name: 'Takeout-2026-10.mbox' } }),
    });
    // With an archive imported, another is imported from the row's ⋯ menu.
    page.button(A.importAction).click();
    await settle();
    page.button(A.pick.back).click();
    await settle();
    expect(page.text()).not.toContain(A.pick.intro);
    expect(page.calls(ARCHIVE_APPROVE_TOOL_NAME)).toEqual([]);
    page.button(A.importAction).click();
    await settle();
    (page.doc.querySelector('[data-key="picker:open:/Users/you/Mail exports"]') as HTMLButtonElement).click();
    await settle();
    page.button(fill(A.pick.makePrivateFor, { name: 'Takeout-2026-10.mbox' })).click();
    await until(() => page.text().includes(fill(A.checking, { name: 'Takeout-2026-10.mbox' })));
    expect(page.text()).toContain(fill(A.checking, { name: 'Takeout-2026-10.mbox' }));
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
    expect(item.textContent).toContain(fill(A.importingLine, { percent: '42', items: fill(A.items.many, { n: '20,340' }) }));
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

  test('what was not read, per kind in plain words, behind See what was not read; never a byte offset', async () => {
    const page = await mount({
      [DASHBOARD_TOOL_NAME]: () => dashboard('archives-imported', meta([{
        ...ARCHIVE,
        gaps: [{ kind: 'message_too_large', count: 2 }, { kind: 'attachments_not_read', count: 1 }, { kind: 'something_new', count: 4 }],
        skipped: [{ kind: 'spam_or_trash', count: 30 }],
      }])),
    });
    const item = archiveItem(page, 'imported');
    const why = item.querySelector('details.why')!;
    expect(why).not.toBeNull();
    expect(why.querySelector('summary')!.textContent).toBe(A.seeWhy);
    const lines = Array.from(why.querySelectorAll('ul.plain li')).map((node) => node.textContent);
    expect(lines).toEqual([
      fill(A.gaps.message_too_large.many, { n: '2' }),
      A.gaps.attachments_not_read.one,
      fill(A.gaps.other.many, { n: '4' }),
      fill(A.gaps.spam_or_trash.many, { n: '30' }),
    ]);
    expect(why.textContent).not.toContain('byte');
  });

  test('an archive of several files says which file each gap is in', async () => {
    const page = await mount({
      [DASHBOARD_TOOL_NAME]: () => dashboard('archives-imported', meta([{
        ...ARCHIVE,
        gaps: [
          { kind: 'message_too_large', count: 2, file: 'Inbox' },
          { kind: 'message_unreadable', count: 1, file: 'Sent' },
        ],
      }])),
    });
    const lines = Array.from(archiveItem(page, 'imported').querySelectorAll('details.why ul.plain li')).map((node) => node.textContent);
    expect(lines).toEqual([
      fill(A.gapInFile, { file: 'Inbox', gap: fill(A.gaps.message_too_large.many, { n: '2' }) }),
      fill(A.gapInFile, { file: 'Sent', gap: A.gaps.message_unreadable.one }),
    ]);
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
    await until(() => page.text().includes(fill(A.removing, { name: ARCHIVE.name })));
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
    await until(() => page.text().includes(fill(A.started, { name: REQUEST.name })));
    expect(page.calls(ARCHIVE_APPROVE_TOOL_NAME)).toEqual([{ name: ARCHIVE_APPROVE_TOOL_NAME, arguments: { request_id: REQUEST.id } }]);
    expect(page.text()).toContain(fill(A.started, { name: REQUEST.name }));

    answer = dashboard('archives-request', meta([], [{ ...REQUEST, origin: 'agent', status: 'pending' }]));
    const again = await mount({
      [DASHBOARD_TOOL_NAME]: () => answer,
      [ARCHIVE_DECLINE_TOOL_NAME]: () => ({ content: [{ type: 'text', text: 'Declined.' }], structuredContent: { ok: true } }),
    });
    answer = dashboard('archives-none', meta([], []));
    again.button(A.decline).click();
    await until(() => again.text().includes(A.declined));
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
    await until(() => page.text().includes(fill(A.cancelled, { name: REQUEST.name })));
    expect(page.calls(ARCHIVE_DECLINE_TOOL_NAME)).toEqual([{ name: ARCHIVE_DECLINE_TOOL_NAME, arguments: { request_id: REQUEST.id } }]);
    expect(page.text()).toContain(fill(A.cancelled, { name: REQUEST.name }));
    expect(page.hasButton(A.cancel)).toBe(false);

    answer = dashboard('archives-checking', meta([ARCHIVE], []));
    page.button(A.tryAgain).click();
    await until(() => page.text().includes(fill(A.started, { name: 'Moved.mbox' })));
    expect(page.calls(ARCHIVE_APPROVE_TOOL_NAME)).toEqual([{ name: ARCHIVE_APPROVE_TOOL_NAME, arguments: { request_id: FAILED } }]);
    expect(page.text()).toContain(fill(A.started, { name: 'Moved.mbox' }));
  });
});

describe('Needs you for imports', () => {
  const TAKEOUT = 'All mail Including Spam and Trash.mbox';

  /** The Archives row, and whether its dot is the Needs you one. */
  function archivesRow(page: Page): Element {
    const row = Array.from(page.doc.querySelectorAll('li.row.source')).find((node) => node.querySelector('.source-name')?.textContent === 'Archives');
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
    expect(archive.textContent).not.toContain(fill(A.items.many, { n: '0' }));
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
    expect(archive.textContent).toContain(fill(A.notRunningLine, { percent: '0', items: fill(A.items.many, { n: '0' }) }));
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
    expect(page.calls(ARCHIVE_BROWSE_TOOL_NAME)).toEqual([]);
  });
});
