// What imported archives need from the person, in the one view model both
// dashboards draw (the computer's and ChatGPT's): an import that stopped, an
// agent's request waiting for an answer, held messages no private model can
// judge, and a list of imports that cannot be read. Each is its own Needs you
// item with a way to exactly that archive or request, and the Archives row is
// not green while any is true; a healthy archive adds nothing. Names are
// invented.

import { describe, expect, test } from 'bun:test';
import { buildEnvBridgeSovereigntyConfig, createSovereigntyEngine } from '../src/core/sovereignty.ts';
import { buildChatGptDashboardViewModel } from '../src/workers/chatgpt/dashboard-view-model.ts';
import type { SourceIndexStatusResult } from '../src/workers/source-index/status.ts';
import {
  buildSourceDashboardViewModel,
  type DashboardImportedArchives,
} from '../src/workers/source-dashboard.ts';
import { DASHBOARD_ARCHIVE_COPY as A } from '../src/workers/dashboard/vocabulary.ts';

const NOW = new Date('2026-10-23T12:00:00.000Z');
const ARCHIVES_PAGE = 'https://olympusplugin.ai/open/archives/';
const STOPPED_ID = '6a1f0e2d-4c3b-4a59-8e7d-1b2c3d4e5f60';
const REQUEST_ID = '8c3b2a1f-6e5d-4c7b-8a9f-3d4e5f6a7b82';

function status(): SourceIndexStatusResult {
  return {
    kind: 'source_index_status',
    generated_at: NOW.toISOString(),
    corpora: [],
    policy: {
      read_only: true,
      raw_source_exposed: false,
      source_packets_exposed: false,
      source_text_returned: false,
      secure_local_item_metadata_exposed: false,
      castor_visible: true,
    },
  } as SourceIndexStatusResult;
}

function dashboard(importedArchives: DashboardImportedArchives) {
  const view = buildSourceDashboardViewModel({
    sourceIndexStatus: status(),
    sovereigntyEngine: createSovereigntyEngine(buildEnvBridgeSovereigntyConfig({})),
    connectedHandleRegistry: { version: 1, handles: [] },
    apiKeyAvailability: {},
    importedArchives,
    now: NOW,
  });
  const model = buildChatGptDashboardViewModel(view, { now: NOW });
  const row = model.sources.find((source) => source.id === 'archive.imports')!;
  const items = model.needsYou.filter((item) => item.id.startsWith('archive'));
  return { model, row, items };
}

function fill(template: string, values: Record<string, string>): string {
  let out = template;
  for (const [key, value] of Object.entries(values)) out = out.split(`{${key}}`).join(value);
  return out;
}

describe('Needs you for imported archives', () => {
  test('an import that stopped: its own item, going to the Archives row, and the row is not green', () => {
    const { row, items } = dashboard({ archives: 2, importing: false, attention: [{ kind: 'stopped', id: STOPPED_ID, name: 'Old work mail.mbox' }] });
    expect(items).toEqual([{
      id: `archive:${STOPPED_ID}`,
      sentence: fill(A.needsYou.stopped, { name: 'Old work mail.mbox' }),
      fix: { label: A.needsYou.seeWhy, tool: 'olympus_dashboard', args: {}, href: ARCHIVES_PAGE, openHref: true },
    }]);
    expect(row.status).toBe('Needs you');
    // The row keeps its own line; the item is not folded into it.
    expect(row.detail).toBe('2 archives imported');
  });

  test('an agent\'s request waiting for an answer: its own item, going to the Archives row', () => {
    const { row, items } = dashboard({ archives: 0, importing: false, attention: [{ kind: 'request', id: REQUEST_ID, name: 'Takeout-2.mbox' }] });
    expect(items).toEqual([{
      id: `archive-request:${REQUEST_ID}`,
      sentence: fill(A.needsYou.request, { name: 'Takeout-2.mbox' }),
      fix: { label: A.needsYou.review, tool: 'olympus_dashboard', args: {}, href: ARCHIVES_PAGE, openHref: true },
    }]);
    expect(row.status).toBe('Needs you');
    // No stalled "finding items" bar over a source that has nothing to find yet.
    expect(row.progress).toBeUndefined();
  });

  test('held messages with no private model set up, or one not answering: the way to the private model', () => {
    const off = dashboard({ archives: 1, importing: false, attention: [{ kind: 'held', count: 48_210, model: 'off' }] });
    expect(off.items).toEqual([{
      id: 'archives:held',
      sentence: fill(A.needsYou.held.many, { n: '48,210' }),
      fix: { label: A.needsYou.setUp, tool: 'olympus_dashboard', args: {}, href: 'https://olympusplugin.ai/open/fix/answers/', openHref: true },
    }]);
    expect(off.row.status).toBe('Needs you');
    const waiting = dashboard({ archives: 1, importing: true, attention: [{ kind: 'held', count: 1, model: 'waiting' }] });
    expect(waiting.items.map((item) => [item.sentence, item.fix.label])).toEqual([[A.needsYou.held.one, A.needsYou.check]]);
    expect(waiting.row.status).toBe('Needs you');
  });

  test('a list of imports that cannot be read: never "no archives imported yet", no Import, and an item to see why', () => {
    const { row, items } = dashboard({ archives: 0, importing: false, attention: [{ kind: 'unreadable', reason: 'damaged' }] });
    expect(items).toEqual([{
      id: 'archives:unreadable',
      sentence: A.needsYou.unreadable,
      fix: { label: A.needsYou.seeWhy, tool: 'olympus_dashboard', args: {}, href: ARCHIVES_PAGE, openHref: true },
    }]);
    expect(row.status).toBe('Needs you');
    expect(row.detail).not.toMatch(/no archives imported yet/i);
    expect(row.detail).toMatch(/can't read the list of imported archives/i);
    const offered = [row.primary, ...(row.menu ?? [])].filter(Boolean).map((fix) => fix!.label);
    expect(offered).not.toContain(A.importAction);
  });

  test('a check that ended without importing: its own item, going to that request', () => {
    const { row, items } = dashboard({ archives: 1, importing: false, attention: [{ kind: 'failed', id: REQUEST_ID, name: 'Takeout-2.mbox' }] });
    expect(items).toEqual([{
      id: `archive-request:${REQUEST_ID}`,
      sentence: fill(A.needsYou.failed, { name: 'Takeout-2.mbox' }),
      fix: { label: A.needsYou.seeWhy, tool: 'olympus_dashboard', args: {}, href: ARCHIVES_PAGE, openHref: true },
    }]);
    expect(row.status).toBe('Needs you');
  });

  test('an archive Olympus cannot count now: its own item, going to that archive', () => {
    const { row, items } = dashboard({ archives: 1, importing: false, attention: [{ kind: 'counts', id: STOPPED_ID, name: 'Old work mail.mbox' }] });
    expect(items).toEqual([{
      id: `archive:${STOPPED_ID}`,
      sentence: fill(A.needsYou.counts, { name: 'Old work mail.mbox' }),
      fix: { label: A.needsYou.seeWhy, tool: 'olympus_dashboard', args: {}, href: ARCHIVES_PAGE, openHref: true },
    }]);
    expect(row.status).toBe('Needs you');
  });

  test('imports this computer\'s settings keep from running: one item naming which, with See why', () => {
    for (const setting of ['disabled', 'not_selected'] as const) {
      const { row, items } = dashboard({ archives: 1, importing: true, attention: [{ kind: 'scheduler', setting }] });
      expect(items).toEqual([{
        id: 'archives:scheduler',
        sentence: A.needsYou.scheduler[setting],
        fix: { label: A.needsYou.seeWhy, tool: 'olympus_dashboard', args: {}, href: ARCHIVES_PAGE, openHref: true },
      }]);
      expect(row.status).toBe('Needs you');
      // Not running is never "Importing".
      expect(row.detail).toBe("imports can't run");
    }
    // A setting this build does not know is not passed on.
    const unknown = dashboard({ archives: 1, importing: true, attention: [{ kind: 'scheduler', setting: 'later' as 'disabled' }] });
    expect(unknown.items).toEqual([]);
  });

  test('several at once: one item each, in order, and Import still offered while the list reads', () => {
    const { row, items } = dashboard({
      archives: 1,
      importing: false,
      attention: [
        { kind: 'stopped', id: STOPPED_ID, name: 'Old work mail.mbox' },
        { kind: 'request', id: REQUEST_ID, name: 'Takeout-2.mbox' },
        { kind: 'held', count: 12, model: 'off' },
      ],
    });
    expect(items.map((item) => item.id)).toEqual([`archive:${STOPPED_ID}`, `archive-request:${REQUEST_ID}`, 'archives:held']);
    expect((row.menu ?? []).map((fix) => fix.label)).toContain(A.importAction);
  });

  test('a healthy archive, imported or still being judged, adds nothing to Needs you and is not Needs you', () => {
    for (const imported of [{ archives: 1, importing: false }, { archives: 1, importing: true }] as DashboardImportedArchives[]) {
      const { row, items } = dashboard(imported);
      expect(items).toEqual([]);
      expect(row.status).not.toBe('Needs you');
    }
  });
});
