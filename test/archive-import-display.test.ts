// What the person reads when an agent asks to import or remove an archive:
// a name chosen by whoever asked must not hide or reorder what is approved.
// The helper writes every invisible, space-like and direction-changing
// character out as U+XXXX and isolates the value; the panel shows the name
// and folder as separate isolated values and the whole path under the
// request. Every name here is invented.

import { afterEach, describe, expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import {
  COMPUTER_META_KEY,
  DASHBOARD_TOOL_NAME,
  OLYMPUS_HOST_CONTEXT_KEY,
  type ComputerArchivesMeta,
} from '../src/workers/chatgpt/dashboard-contract.ts';
import { chatgptDashboardPageHtml } from '../src/workers/dashboard/chatgpt/page.ts';
import { displayText, visibleText } from '../src/workers/dashboard/display-text.ts';
import { DASHBOARD_ARCHIVE_COPY as A } from '../src/workers/dashboard/vocabulary.ts';
import { previewDashboardToolResult } from '../scripts/dashboard-preview.ts';

describe('visibleText and displayText', () => {
  test.each([
    ['a zero-width space', 'Inbox​.mbox', 'Inbox⟨U+200B⟩.mbox'],
    ['a zero-width joiner and non-joiner', 'a‌b‍c', 'a⟨U+200C⟩b⟨U+200D⟩c'],
    ['a right-to-left override', 'Takeout‮gpj.mbox', 'Takeout⟨U+202E⟩gpj.mbox'],
    ['a left-to-right isolate and its pop', '⁦x⁩', '⟨U+2066⟩x⟨U+2069⟩'],
    ['a left-to-right mark', 'a‎b', 'a⟨U+200E⟩b'],
    ['a byte order mark', '﻿Inbox', '⟨U+FEFF⟩Inbox'],
    ['a soft hyphen and a word joiner', 'a­b⁠c', 'a⟨U+00AD⟩b⟨U+2060⟩c'],
    ['a no-break space and an ideographic space', 'a b　c', 'a⟨U+00A0⟩b⟨U+3000⟩c'],
    ['a newline and a tab', 'a\nb\tc', 'a⟨U+000A⟩b⟨U+0009⟩c'],
    ['a line separator', 'a b', 'a⟨U+2028⟩b'],
    ['a Hangul filler and a blank Braille cell', 'aㅤb⠀c', 'a⟨U+3164⟩b⟨U+2800⟩c'],
    ['a tag character', 'a\u{E0041}b', 'a⟨U+E0041⟩b'],
    ['a lone surrogate', 'a\uD800b', 'a⟨U+D800⟩b'],
    ['a name that imitates an escape', '⟨U+200B⟩', '⟨U+27E8⟩U+200B⟨U+27E9⟩'],
  ])('%s is written out', (_label, raw, shown) => {
    expect(visibleText(raw)).toBe(shown);
  });

  test('what can be seen is left alone: plain and accented letters, emoji, combining marks, joined emoji, single spaces', () => {
    for (const text of ['Takeout 2.mbox', 'café 日本語.mbox', 'é.mbox', '\u{1F4EC}.mbox', '❤️.mbox', '~/Mail exports/a b']) {
      expect(visibleText(text)).toBe(text);
    }
  });

  test('plain ASCII is shown as it is; anything else is isolated from the words around it', () => {
    expect(displayText('Takeout 2.mbox')).toBe('Takeout 2.mbox');
    expect(displayText('~/Mail exports')).toBe('~/Mail exports');
    expect(displayText('דואר.mbox')).toBe('⁨דואר.mbox⁩');
    expect(displayText('Inbox​.mbox')).toBe('⁨Inbox⟨U+200B⟩.mbox⁩');
  });
});

type Message = { jsonrpc?: string; id?: number; method?: string; params?: any };

const windows: Window[] = [];
afterEach(async () => {
  while (windows.length) await windows.pop()!.happyDOM.close();
});
const settle = (ms = 20) => new Promise((resolve) => setTimeout(resolve, ms));
const LINKS = {
  keys: 'http://127.0.0.1:8787/dashboard?keys',
  agents: 'http://127.0.0.1:8787/dashboard?agents',
  privateAnswers: 'http://127.0.0.1:8787/dashboard?private-answers',
  connector: 'http://127.0.0.1:8787/dashboard?connector',
};

/** The panel on the computer, answering the dashboard tool from `answer`. */
async function mount(answer: unknown) {
  const html = chatgptDashboardPageHtml({ resultTimeoutMs: 5_000 });
  const start = html.indexOf('<script>') + '<script>'.length;
  const script = html.slice(start, html.indexOf('</script>', start));
  const win = new Window({ url: 'https://sandbox.test/' });
  windows.push(win);
  win.document.write(html.slice(0, start - '<script>'.length) + html.slice(html.indexOf('</script>', start) + '</script>'.length));
  const dispatch = (data: unknown) => win.dispatchEvent(new win.MessageEvent('message', { data, source: parent as any }));
  const reply = (id: number, result: unknown) => setTimeout(() => dispatch({ jsonrpc: '2.0', id, result }), 0);
  const parent = {
    postMessage: (message: Message) => {
      if (message.id === undefined) return;
      if (message.method === 'ui/initialize') {
        reply(message.id, {
          protocolVersion: '2026-01-26',
          hostContext: {
            theme: 'light',
            displayMode: 'fullscreen',
            availableDisplayModes: ['fullscreen'],
            [OLYMPUS_HOST_CONTEXT_KEY]: { kind: 'computer', readOnly: false, links: LINKS },
          },
        });
      } else if (message.method === 'tools/call' && message.params.name === DASHBOARD_TOOL_NAME) reply(message.id, answer);
    },
  };
  Object.defineProperty(win, 'parent', { value: parent, configurable: true });
  new Function('window', 'document', script)(win, win.document);
  await settle();
  await settle();
  return win.document;
}

/** The engine's own Archives row for a preview state, with this list in the computer's meta. */
function dashboard(state: string, archives: ComputerArchivesMeta) {
  const result = previewDashboardToolResult(state, false) as { _meta: Record<string, any> };
  return { ...result, _meta: { ...result._meta, [COMPUTER_META_KEY]: { ...result._meta[COMPUTER_META_KEY], archives } } };
}

const REQUEST_ID = '8c3b2a1f-6e5d-4c7b-8a9f-3d4e5f6a7b82';

describe('the request row in the panel', () => {
  test('an agent\'s request to import shows its name and folder as separate isolated values and the whole path under it', async () => {
    const name = displayText('Inbox​.mbox');
    const path = displayText('~/Downloads/Inbox​.mbox');
    const doc = await mount(dashboard('archives-request', {
      sourceId: 'archive.imports',
      archives: [],
      requests: [{ id: REQUEST_ID, name, where: '~/Downloads', path, origin: 'agent', status: 'pending' }],
      privateModel: 'ready',
    }));
    const row = doc.querySelector('li.archive.request[data-request="pending"]')!;
    expect(row).not.toBeNull();

    // The line: name and folder are each their own bdi, and the words around them are plain text.
    const line = row.querySelector('p')!;
    expect(Array.from(line.querySelectorAll('bdi')).map((node) => node.textContent)).toEqual([name, '~/Downloads']);
    expect(line.textContent).toBe(A.requestLine.replace('{name}', name).replace('{where}', '~/Downloads'));

    // The full target, written out: a person can read exactly which file Import acts on.
    const full = row.querySelector('.request-path')!;
    expect(Array.from(full.querySelectorAll('bdi')).map((node) => node.textContent)).toEqual([path]);
    expect(full.textContent).toBe(A.fullPath.replace('{path}', path));
    expect(full.textContent).toContain('Inbox⟨U+200B⟩.mbox');

    // Nothing the person reads holds the invisible character itself.
    expect(doc.getElementById('app')!.textContent).not.toContain('​');
  });

  test('an agent\'s request to remove shows the archive and the path it was imported from the same way', async () => {
    const name = displayText('Old‮mail.mbox');
    const path = displayText('~/Exports/Old‮mail.mbox');
    const doc = await mount(dashboard('archives-remove-request', {
      sourceId: 'archive.imports',
      archives: [],
      requests: [{
        id: REQUEST_ID, kind: 'remove', name, where: '~/Exports', path, origin: 'agent', status: 'pending',
        archiveId: '6a1f0e2d-4c3b-4a59-8e7d-1b2c3d4e5f60', archiveName: name,
      }],
      privateModel: 'ready',
    }));
    const row = doc.querySelector('li.archive.request[data-request="remove"]')!;
    expect(row).not.toBeNull();
    expect(Array.from(row.querySelector('p')!.querySelectorAll('bdi')).map((node) => node.textContent)).toEqual([name, '~/Exports']);
    expect(row.querySelector('.request-path')!.textContent).toBe(A.fullPath.replace('{path}', path));
    expect(row.querySelector('.request-path')!.textContent).toContain('Old⟨U+202E⟩mail.mbox');
    expect(doc.getElementById('app')!.textContent).not.toContain('‮');
  });

  test('a request from an older list, with no path, still shows its line', async () => {
    const doc = await mount(dashboard('archives-request', {
      sourceId: 'archive.imports',
      archives: [],
      requests: [{ id: REQUEST_ID, name: 'Takeout-2.mbox', where: '~/Downloads', origin: 'agent', status: 'pending' }],
      privateModel: 'ready',
    }));
    const row = doc.querySelector('li.archive.request[data-request="pending"]')!;
    expect(row.textContent).toContain(A.requestLine.replace('{name}', 'Takeout-2.mbox').replace('{where}', '~/Downloads'));
    expect(row.querySelector('.request-path')).toBeNull();
  });
});
