/**
 * "See why" (unified dashboard, phase 3): a source whose files can't be read
 * shows a count per reason and one note under its row. Owner ruling
 * 2026-10-10: it also names the files (never say something is wrong without
 * a way to find out exactly what): up to 5 names, capped at 120 characters,
 * then "and N more", which opens the computer's full list. File names may
 * reach ChatGPT; paths never do, and only the card's own list is read.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import { buildChatGptDashboardViewModel } from '../src/workers/chatgpt/dashboard-view-model.ts';
import { copyDashboardViewModel } from '../src/workers/chatgpt/response-builder.ts';
import { DASHBOARD_TOOL_NAME, type DashboardViewModelV1 } from '../src/workers/chatgpt/dashboard-contract.ts';
import { chatgptDashboardPageHtml } from '../src/workers/dashboard/chatgpt/page.ts';
import {
  DASHBOARD_CHATGPT_PAGE_COPY,
  DASHBOARD_UNREADABLE_NOTE,
  DASHBOARD_UNREADABLE_NOTE_MANY,
  DASHBOARD_UNREADABLE_REASON_CODES,
  dashboardUnreadableSentence,
} from '../src/workers/dashboard/vocabulary.ts';
import type { DashboardSourceCard, SourceDashboardViewModel } from '../src/workers/source-dashboard.ts';

const NOW = new Date('2026-10-09T12:00:00.000Z');
const SECRET_NAME = 'Divorce settlement - FINAL.pdf';
const SECRET_PATH = '/Users/jamie/Dropbox/Taxes/2025-return.pdf';

function card(unreadable: number, readiness: DashboardSourceCard['answer_readiness'] = { state: 'ready', label: 'Ready for questions' }): DashboardSourceCard {
  return {
    corpus_id: 'secure_local.dropbox.files',
    source_id: 'dropbox.files',
    label: 'Dropbox',
    provider: 'dropbox',
    family: 'file',
    trust_domain: 'secure_local',
    configured: true,
    freshness: { label: 'Last checked 12 minutes ago', hours: 0.2, threshold_hours: 26, stale: false },
    coverage: {
      indexed_items: 254,
      content_ready_items: 254 - unreadable,
      embedded_items: 0,
      embedded_files: 254 - unreadable,
      needs_review_items: 0,
      answer_ready_eligible_items: 254,
      ...(unreadable > 0 ? { unreadable_items: unreadable } : {}),
    },
    ingestion_health: { coverage_percent: 100, stuck_count: 0, drain_state: 'enabled', label: '' },
    tier_composition: [],
    queue_health: { label: 'Caught up', waiting: 0, active: 0, needs_attention: 0 },
    answer_readiness: readiness,
    connection: { state: 'synced', label: 'synced 12 minutes ago', action: { kind: 'none' }, handles: ['dropbox.personal'] },
    last_sync_at: '2026-10-09T11:48:00.000Z',
  } as DashboardSourceCard;
}

function viewModelOf(source: DashboardSourceCard): DashboardViewModelV1 {
  const view = { sources: [source], generated_at: NOW.toISOString() } as unknown as SourceDashboardViewModel;
  return buildChatGptDashboardViewModel(view, { now: NOW });
}

const dropboxOf = (model: DashboardViewModelV1) => model.sources.find((source) => source.id === 'dropbox.files')!;

const MORE_HREF = 'https://olympusplugin.ai/open/unreadable/dropbox/';
const moreFix = (count: number) => ({ label: `and ${count} more`, tool: DASHBOARD_TOOL_NAME, args: {}, href: MORE_HREF, openHref: true as const });

function named(unreadable: number, names: string[]): DashboardSourceCard {
  return { ...card(unreadable), unreadable_files: { names, corpus_ids: ['secure_local.dropbox.files'] } };
}

describe('the view model carries a count per closed reason', () => {
  test('two unreadable files are one reason with a count, and their names', () => {
    expect(dropboxOf(viewModelOf(named(2, ['b.pdf', 'a.pdf']))).unreadable).toEqual({
      count: 2,
      reasons: [{ code: 'damaged_or_unsupported', count: 2 }],
      names: ['b.pdf', 'a.pdf'],
    });
  });

  test('with no names to hand, "and N more" still leads to the full list', () => {
    expect(dropboxOf(viewModelOf(card(2))).unreadable).toEqual({
      count: 2,
      reasons: [{ code: 'damaged_or_unsupported', count: 2 }],
      more: moreFix(2),
    });
  });

  test('nothing unreadable leaves the key out', () => {
    expect('unreadable' in dropboxOf(viewModelOf(card(0)))).toBe(false);
  });

  test('past the alarm share it says so, and every code is on the closed list', () => {
    const many = dropboxOf(viewModelOf(card(20, { state: 'needs_attention', label: 'Many files cannot be read' }))).unreadable!;
    expect(many.many).toBe(true);
    for (const reason of many.reasons) expect(DASHBOARD_UNREADABLE_REASON_CODES).toContain(reason.code);
    expect(many.reasons.reduce((sum, reason) => sum + reason.count, 0)).toBe(many.count);
    expect('many' in dropboxOf(viewModelOf(card(2))).unreadable!).toBe(false);
  });

  test('the engine knows one reason today', () => {
    expect(DASHBOARD_UNREADABLE_REASON_CODES).toEqual(['damaged_or_unsupported']);
  });
});

describe('the names: newest first, capped, and only the card\'s own list', () => {
  test('up to 5 names in the card\'s order, then "and N more" with the right arithmetic', () => {
    const names = ['f.pdf', 'e.pdf', 'd.pdf', 'c.pdf', 'b.pdf', 'a.pdf'];
    const unreadable = dropboxOf(viewModelOf(named(12, names))).unreadable!;
    expect(unreadable.names).toEqual(names.slice(0, 5));
    expect(unreadable.more).toEqual(moreFix(7));
    // Never more names than the count says.
    expect(dropboxOf(viewModelOf(named(2, names))).unreadable!.names).toEqual(['f.pdf', 'e.pdf']);
    expect('more' in dropboxOf(viewModelOf(named(2, names))).unreadable!).toBe(false);
  });

  test('each name is one line of at most 120 characters', () => {
    const long = `${'x'.repeat(200)}.pdf`;
    const [first, second] = dropboxOf(viewModelOf(named(2, [long, 'two\nlines\u2028here.pdf']))).unreadable!.names!;
    expect(Array.from(first!)).toHaveLength(120);
    expect(first!.endsWith('…')).toBe(true);
    expect(second).toBe('two lines here.pdf');
  });

  test('a card is read for its own list only: names planted elsewhere never leave', () => {
    const planted = card(2);
    (planted.coverage as any).unreadable_names = [SECRET_NAME, SECRET_PATH];
    (planted as any).unreadable = [SECRET_NAME];
    const unreadable = dropboxOf(viewModelOf(planted)).unreadable!;
    expect(Object.keys(unreadable).sort()).toEqual(['count', 'more', 'reasons']);
    expect(Object.keys(unreadable.reasons[0]!).sort()).toEqual(['code', 'count']);
    expect(JSON.stringify(viewModelOf(planted))).not.toContain(SECRET_NAME);
    expect(JSON.stringify(viewModelOf(planted))).not.toContain(SECRET_PATH);
  });

  test('the response sanitizer keeps capped names and a safe "more", and drops any other key or code', () => {
    const model = viewModelOf(named(9, ['e.pdf', 'd.pdf']));
    const raw = dropboxOf(model).unreadable as any;
    raw.files = [SECRET_PATH];
    raw.names = ['1.pdf', '2.pdf', '3.pdf', '4.pdf', '5.pdf', '6.pdf', `${'y'.repeat(300)}`, 7];
    raw.reasons.push(
      { code: SECRET_PATH, count: 1 },
      { code: 'damaged_or_unsupported', count: 1, name: SECRET_NAME, path: SECRET_PATH },
    );
    const copied = copyDashboardViewModel(model);
    expect(JSON.stringify(copied)).not.toContain(SECRET_NAME);
    expect(JSON.stringify(copied)).not.toContain(SECRET_PATH);
    expect(dropboxOf(copied).unreadable).toEqual({
      count: 9,
      reasons: [{ code: 'damaged_or_unsupported', count: 9 }, { code: 'damaged_or_unsupported', count: 1 }],
      names: ['1.pdf', '2.pdf', '3.pdf', '4.pdf', '5.pdf'],
      more: moreFix(7),
    });
    // A "more" that would open anything but a safe link loses its link.
    raw.more = { ...moreFix(7), href: 'javascript:alert(1)' };
    expect(dropboxOf(copyDashboardViewModel(model)).unreadable!.more!.href).toBeUndefined();
  });

  test('a bare count from an older producer still reads, as one reason', () => {
    const model = viewModelOf(card(2));
    (dropboxOf(model) as any).unreadable = 3;
    expect(dropboxOf(copyDashboardViewModel(model)).unreadable).toEqual({
      count: 3,
      reasons: [{ code: 'damaged_or_unsupported', count: 3 }],
    });
  });

  test('the computer\'s own sentence for the same files names none', () => {
    const sentence = dashboardUnreadableSentence(card(2))!;
    expect(sentence).toContain("2 files can't be read");
    expect(sentence).toContain(DASHBOARD_UNREADABLE_NOTE);
    expect(dashboardUnreadableSentence(card(20, { state: 'needs_attention', label: 'Many files cannot be read' })))
      .toContain(DASHBOARD_UNREADABLE_NOTE_MANY);
  });
});

describe('the panel renders See why', () => {
  const windows: Window[] = [];
  afterEach(async () => {
    while (windows.length) await windows.pop()!.happyDOM.close();
  });

  function mount(model: DashboardViewModelV1, sent: any[] = []) {
    const html = chatgptDashboardPageHtml({ resultTimeoutMs: 5_000 });
    const start = html.indexOf('<script>') + '<script>'.length;
    const script = html.slice(start, html.indexOf('</script>', start));
    const win = new Window({ url: 'https://sandbox.test/' });
    windows.push(win);
    win.document.write(html.slice(0, start - '<script>'.length) + html.slice(html.indexOf('</script>', start) + '</script>'.length));
    const parent = { postMessage: (message: unknown) => { sent.push(message); } };
    Object.defineProperty(win, 'parent', { value: parent, configurable: true });
    new Function('window', 'document', script)(win, win.document);
    win.dispatchEvent(new win.MessageEvent('message', {
      data: { jsonrpc: '2.0', method: 'ui/notifications/tool-result', params: { structuredContent: model } },
      source: parent as any,
    }));
    return win;
  }

  const fresh = (overrides: Partial<DashboardViewModelV1['sources'][number]>): DashboardViewModelV1 => ({
    v: 1,
    connection: { state: 'ready' },
    needsYou: [],
    sources: [{
      id: 'dropbox.files', label: 'Dropbox', group: 'cloud', status: 'Fresh', detail: "synced 12m ago · 2 files can't be read",
      lastSyncAt: new Date(Date.now() - 12 * 60_000).toISOString(), ...overrides,
    }],
    models: { embedding: { kind: 'built_in', state: 'ready' } },
    generatedAt: new Date().toISOString(),
  });

  test('the row line stays, with a See why disclosure listing the reason count and one note', () => {
    const win = mount(fresh({ unreadable: { count: 2, reasons: [{ code: 'damaged_or_unsupported', count: 2 }] } }));
    const row = win.document.querySelector('.row.source')!;
    expect(row.querySelector('.source-main .muted')!.textContent).toBe("Synced 12m ago · 2 files can't be read");
    const why = row.querySelector('details.why')!;
    expect(why.querySelector('summary')!.textContent).toBe(DASHBOARD_CHATGPT_PAGE_COPY.seeWhy);
    expect(Array.from(why.querySelectorAll('li')).map((node) => node.textContent))
      .toEqual(["2 files are damaged or in a format Olympus can't read"]);
    expect(why.querySelector('.why-note')!.textContent).toBe(DASHBOARD_UNREADABLE_NOTE);
  });

  test('one file is singular; past the alarm share the note says it may be Olympus', () => {
    const win = mount(fresh({ unreadable: { count: 1, many: true, reasons: [{ code: 'damaged_or_unsupported', count: 1 }] } }));
    const why = win.document.querySelector('details.why')!;
    expect(why.querySelector('li')!.textContent).toBe("1 file is damaged or in a format Olympus can't read");
    expect(why.querySelector('.why-note')!.textContent).toBe(DASHBOARD_UNREADABLE_NOTE_MANY);
  });

  test('no See why without reasons: nothing unreadable, or an older engine\'s bare count', () => {
    expect(mount(fresh({ detail: 'synced 12m ago' })).document.querySelector('details.why')).toBeNull();
    expect(mount(fresh({ unreadable: 2 as any })).document.querySelector('details.why')).toBeNull();
  });

  test('the names sit inside the closed See why, and "and N more" opens the computer\'s list', () => {
    const sent: any[] = [];
    const win = mount(fresh({ unreadable: {
      count: 7,
      reasons: [{ code: 'damaged_or_unsupported', count: 7 }],
      names: ['Q3 board deck.key', 'scan-0042.tiff'],
      more: { label: 'and 5 more', tool: DASHBOARD_TOOL_NAME, args: {}, href: MORE_HREF, openHref: true },
    } }), sent);
    const row = win.document.querySelector('.row.source')!;
    const why = row.querySelector('details.why')! as unknown as HTMLDetailsElement;
    expect(why.open).toBe(false);
    expect(row.querySelector('.source-main .muted')!.textContent).toBe("Synced 12m ago · 2 files can't be read");
    expect(why.querySelector('summary')!.textContent).not.toContain('Q3 board deck.key');
    expect(why.querySelector('summary')!.textContent).toBe(DASHBOARD_CHATGPT_PAGE_COPY.seeWhy);
    const files = Array.from(why.querySelectorAll('ul.files li')).map((node) => node.textContent);
    expect(files).toEqual(['Q3 board deck.key', 'scan-0042.tiff', 'and 5 more']);
    const more = Array.from(why.querySelectorAll('ul.files button')).find((node) => node.textContent === 'and 5 more') as unknown as HTMLButtonElement;
    more.click();
    expect(sent.filter((message) => message.method === 'ui/open-link').map((message) => message.params.url)).toEqual([MORE_HREF]);
  });

  // On a server, the computer's full list is the remote route: the tunnel
  // and `olympus dashboard --no-open --target unreadable/dropbox`, never the
  // /open/ page (its olympus:// link would open the laptop's own Olympus).
  test('engine on a server: "and N more" shows the remote lines for unreadable/dropbox, never the /open/ page', () => {
    const sent: any[] = [];
    const win = mount({ ...fresh({ unreadable: {
      count: 7,
      reasons: [{ code: 'damaged_or_unsupported', count: 7 }],
      names: ['Q3 board deck.key', 'scan-0042.tiff'],
      more: { label: 'and 5 more', tool: DASHBOARD_TOOL_NAME, args: {}, href: MORE_HREF, openHref: true },
    } }), remote: { port: 8123, sshTarget: 'jamie@sparta', agent: false } }, sent);
    const more = Array.from(win.document.querySelectorAll('details.why ul.files button')).find((node) => node.textContent === 'and 5 more') as unknown as HTMLButtonElement;
    more.click();
    expect(sent.some((message) => message.method === 'ui/open-link')).toBe(false);
    const box = win.document.querySelector('.remote-box')!;
    expect(box).not.toBeNull();
    expect(Array.from(box.querySelectorAll('code')).map((node) => node.textContent)).toEqual([
      'ssh -N -L 8123:127.0.0.1:8123 jamie@sparta',
      'olympus dashboard --no-open --target unreadable/dropbox',
    ]);
  });

  test('no file path reaches the panel, whatever the data carries', () => {
    const hostile = { count: 2, files: [SECRET_NAME, SECRET_PATH], reasons: [
      { code: 'damaged_or_unsupported', count: 2, name: SECRET_NAME, path: SECRET_PATH },
      { code: SECRET_NAME, count: 1 },
    ] };
    const win = mount(fresh({ unreadable: hostile as any }));
    const page = win.document.getElementById('app')!.innerHTML;
    expect(page).not.toContain(SECRET_NAME);
    expect(page).not.toContain(SECRET_PATH);
    expect(page).not.toContain('Taxes');
    expect(win.document.querySelectorAll('details.why ul:not(.files) li').length).toBe(1);
  });
});
