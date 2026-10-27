// The release check's import beside a live input (scripts/release-check/archive-leg.ts, `besideLive` in archive-fixtures.ts): its
// checks, judged on observations made by hand, and the parts of the leg that must leave a source's imports alone.

import { describe, expect, test } from 'bun:test';
import { DASHBOARD_ARCHIVE_COPY as A } from '../src/workers/dashboard/vocabulary.ts';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ARCHIVE_FORMATS, legFixture, type LegFixture } from '../scripts/release-check/archive-fixtures.ts';
import {
  besideLiveChecks, besideLiveJourney, besideLiveLine, panelArchivesOf, seedLiveChecks, unpairJourney,
  type BesideLiveObservation, type RowView,
} from '../scripts/release-check/archive-leg.ts';
import { liveSeedHook, registerLiveSeedHook } from '../scripts/release-check/archive-live-seeds.ts';
import { afterSourceDelete, searchWhenJudged, type ArchiveHost } from '../scripts/release-check/archive-stages.ts';

const fx: LegFixture = {
  role: 'beside',
  format: 'fixture_chat',
  fileName: 'rc-beside-fixture_chat.json',
  token: 'rcarch0123456789abcd',
  relPath: 'rc-archives/rc-beside-fixture_chat.json',
  expect: { label: 'Fixture chat', citationLabel: 'Fixture', family: 'chat', messages: 6, earliest: '', latest: '', notImported: [], howRead: [] },
  beside: { read: 6, alreadyThere: 2, citationLabel: 'Fixture' },
  bytes: new Uint8Array(),
};

const row = (over: Partial<RowView> = {}): RowView => ({
  status: 'imported', name: fx.fileName, tag: A.status.imported, facts: '', text: `${fx.fileName} ${besideLiveLine(fx.beside!, 'chat')} · imported just now`,
  gapLines: [], notImported: [], howRead: [], headings: [], whyOpen: null, buttons: [], sourceImport: true, ...over,
});

const good = (over: Partial<BesideLiveObservation> = {}): BesideLiveObservation => ({
  ok: true,
  format: fx.format,
  fileName: fx.fileName,
  token: fx.token,
  start: { ok: false, code: 'needs_approval', requestId: 'req-1', hasOpenTarget: true, carriesContent: false },
  traces: [],
  settled: true,
  settleMs: 4_000,
  row: row(),
  stores: [{ tier: 'private', exists: true, live: 6, tokenRows: 3 }, { tier: 'personal', exists: true, live: 2, tokenRows: 0 }],
  search: { ok: true, isError: false, evidence: [{ source: 'Fixture', hasToken: true }] },
  deleted: { ok: true, unpaired: true, stores: [{ tier: 'private', exists: true, live: 0, tokenRows: 0 }], rowGone: true },
  ...over,
});

const failing = (observation: BesideLiveObservation) => besideLiveChecks(observation, fx).filter((check) => check.status === 'fail').map((check) => check.id);

describe('an import beside a live input is judged', () => {
  test('the count line says what the import read and how much the source already had', () => {
    expect(besideLiveLine({ read: 6, alreadyThere: 2, citationLabel: 'x' }, 'chat')).toBe('6 messages from this archive, of which 2 were already there');
    expect(besideLiveLine({ read: 1, alreadyThere: 1, citationLabel: 'x' }, 'chat')).toBe('1 message from this archive, of which 1 was already there');
    expect(besideLiveLine({ read: 3, alreadyThere: 0, citationLabel: 'x' }, 'chat')).toBe('3 messages from this archive');
  });

  test('an import that joined its source, is found and went with the Delete passes', () => {
    expect(failing(good())).toEqual([]);
  });

  test('each way it can go wrong fails the check that guards it', () => {
    expect(failing(good({ row: row({ sourceImport: false }) }))).toEqual(['archive.beside.fixture_chat.in-source']);
    expect(failing(good({ row: row({ buttons: [A.remove] }) }))).toEqual(['archive.beside.fixture_chat.in-source']);
    expect(failing(good({ row: row({ text: `${fx.fileName} 6 messages from this archive` }) }))).toEqual(['archive.beside.fixture_chat.in-source']);
    expect(failing(good({ stores: [{ tier: 'private', exists: true, live: 0, tokenRows: 0 }] }))).toEqual(['archive.beside.fixture_chat.stores']);
    expect(failing(good({ search: { ok: true, isError: false, evidence: [{ source: 'Imported mail', hasToken: true }] } }))).toEqual(['archive.beside.fixture_chat.search']);
    expect(failing(good({ deleted: { ok: true, unpaired: true, stores: [{ tier: 'private', exists: true, live: 1, tokenRows: 1 }], rowGone: true } }))).toEqual(['archive.beside.fixture_chat.deleted']);
    expect(failing(good({ deleted: { ok: true, unpaired: true, stores: [], rowGone: false } }))).toEqual(['archive.beside.fixture_chat.deleted']);
    // Mac, 2026-10-26: the Delete ran while the source was still paired, and the engine refused it (delete_source_paired).
    const paired = besideLiveChecks(good({ deleted: { ok: false, unpaired: false, detail: 'Error [delete_source_paired]: Unpair this source before deleting its indexed data.', stores: [], rowGone: false } }), fx);
    expect(paired.filter((check) => check.status === 'fail').map((check) => check.id)).toEqual(['archive.beside.fixture_chat.deleted']);
    expect(paired.find((check) => check.id === 'archive.beside.fixture_chat.deleted')!.detail).toContain('the source was not unpaired before its Delete');
    expect(failing(good({ deleted: { ok: true, unpaired: false, stores: [], rowGone: true } }))).toEqual(['archive.beside.fixture_chat.deleted']);
    // The engine did not come back from the restart the Delete asked for: whatever runs next would meet it restarting.
    expect(failing(good({ deleted: { ok: true, unpaired: true, stores: [], rowGone: true, engineBack: false, detail: 'the engine was not ready after the Delete\'s restart: timeout' } }))).toEqual(['archive.beside.fixture_chat.deleted']);
    expect(failing(good({ start: { ok: true, code: 'started', hasOpenTarget: false, carriesContent: false } }))).toEqual(['archive.beside.fixture_chat.requested']);
  });

  test('a seed that stored nothing fails', () => {
    expect(seedLiveChecks({ ok: true, format: 'x', liveItems: 0 }, 'x')[0]!.status).toBe('fail');
    expect(seedLiveChecks({ ok: true, format: 'x', liveItems: 3 }, 'x')[0]!.status).toBe('pass');
    expect(seedLiveChecks(undefined, 'x')[0]!.status).toBe('fail');
  });

  test('the source is unpaired the way the owner does it: its menu, Unpair, the confirmation, then it reads disconnected', () => {
    const journey = unpairJourney('telegram.messages', 'Telegram');
    expect(journey.steps.map((step) => step.do)).toEqual([
      { go: '/dashboard' },
      { click: { css: '[data-key="summary:menu:telegram.messages"]' }, frame: 'panel' },
      { click: { role: 'button', name: 'Unpair Telegram' }, frame: 'panel' },
      { click: { role: 'button', name: 'Yes, unpair telegram' }, frame: 'panel' },
    ]);
    expect(journey.steps.at(-1)!.expect).toEqual([
      { present: { css: 'li.row.source', text: 'Disconnected · indexed data kept', contains: true }, frame: 'panel' },
      { absent: { role: 'button', name: 'Unpair Telegram' }, frame: 'panel' },
    ]);
  });

  test('every format with an import beside a live input names its source for the Unpair', () => {
    for (const spec of Object.values(ARCHIVE_FORMATS)) if (spec.besideLive) expect(spec.besideLive.sourceLabel.length).toBeGreaterThan(0);
  });

  test('the stage unpairs before it deletes', () => {
    const stage = readFileSync(join(import.meta.dir, '..', 'scripts', 'release-check', 'archive-stages.ts'), 'utf8');
    const body = stage.slice(stage.indexOf('export async function besideLiveStage'));
    const unpairAt = body.indexOf('unpairJourney(beside.sourceId');
    const deleteAt = body.indexOf('host.deleteSourceData!(beside.sourceId)');
    expect(unpairAt).toBeGreaterThan(0);
    expect(deleteAt).toBeGreaterThan(unpairAt);
  });

  test('the journey waits for the row inside the source\'s card', () => {
    const journey = besideLiveJourney(fx, '~/rc-archives/rc-beside-fixture_chat.json');
    expect(journey.steps.at(-1)!.expect[0]).toMatchObject({ present: { css: 'li.archive[data-source-import="true"][data-archive="imported"]', text: fx.fileName } });
  });

  test('the panel reading tells a source\'s import from an archive under Archives', () => {
    const panel = panelArchivesOf({ rows: [{ name: 'a', sourceImport: true }, { name: 'b' }], requests: [] });
    expect(panel.rows.map((entry) => entry.sourceImport === true)).toEqual([true, false]);
  });

  test('a format with no import beside a live input has no beside fixture, and an unknown hook is named', () => {
    expect(() => legFixture('beside', 'seed', 'mbox')).toThrow('no import beside a live input');
    expect(() => liveSeedHook('nothing-registered')).toThrow('no live seed hook "nothing-registered"');
    registerLiveSeedHook('test-hook', { provider: 'p', stores: () => [], seed: async () => ({ ok: true, detail: '', liveItems: 1 }) });
    expect(liveSeedHook('test-hook').provider).toBe('p');
  });
});

describe('the search beside a live input waits for the private model', () => {
  const host = (citedFrom: number) => {
    let clock = 0;
    let calls = 0;
    const lines: string[] = [];
    return {
      calls: () => calls,
      lines,
      host: {
        now: () => clock,
        sleep: async (ms: number) => { clock += ms; },
        say: (line: string) => { lines.push(line); },
        search: async () => {
          calls += 1;
          // Held Private until judged: nothing is cited until the judge has run.
          const judged = calls >= citedFrom;
          return { ok: true, isError: false, structured: { evidence: judged ? [{ source: 'Fixture', excerpt: `the word ${fx.token}` }] : [{ source: 'Fixture', excerpt: 'another message' }] } };
        },
      } as unknown as Parameters<typeof searchWhenJudged>[0],
    };
  };

  test('a search asked before the records are judged is asked again until it is cited', async () => {
    const world = host(4);
    const search = await searchWhenJudged(world.host, { ...fx, expect: { ...fx.expect, citationLabel: 'Fixture' } }, 900_000);
    expect(world.calls()).toBe(4);
    expect(search.evidence.some((item) => item.hasToken)).toBe(true);
    expect(failing(good({ search }))).toEqual([]);
  });

  test('a search never cited within the bound is the one judged, and fails', async () => {
    const world = host(Number.POSITIVE_INFINITY);
    const search = await searchWhenJudged(world.host, { ...fx, expect: { ...fx.expect, citationLabel: 'Fixture' } }, 60_000);
    expect(world.calls()).toBe(7);
    expect(world.lines.at(-1)).toContain('NOT cited');
    expect(failing(good({ search }))).toEqual(['archive.beside.fixture_chat.search']);
  });
});

// Mac round 2 / Linux round 3, 2026-10-26: the stores were read right after the Delete returned, while the worker had only marked the
// account and was about to restart; its files go at that boot. The next leg then met the engine restarting.
describe('a source\'s Delete is judged once it has been applied', () => {
  const host = (clearAfter: number, engine = true) => {
    let clock = 0;
    let reads = 0;
    const order: string[] = [];
    const fake = {
      now: () => clock,
      sleep: async (ms: number) => { clock += ms; },
      readSourceStores: () => {
        reads += 1;
        order.push('read');
        const left = reads <= clearAfter ? 2 : 0;
        return [{ tier: 'private' as const, exists: left > 0, live: left, tokenRows: left }, { tier: 'personal' as const, exists: left > 0, live: left, tokenRows: left }];
      },
      awaitEngine: async () => { order.push('engine'); return engine ? { ok: true, ms: 1 } : { ok: false, ms: 1, detail: 'not ready' }; },
    };
    return { fake: fake as unknown as ArchiveHost, order, reads: () => reads };
  };

  test('the stores are read again until the restart has removed them, then the engine is waited for', async () => {
    const { fake, order, reads } = host(3);
    const after = await afterSourceDelete(fake, 'telegram', fx.token, 420_000);
    expect(after.stores.every((store) => store.tokenRows === 0)).toBe(true);
    expect(after.engineBack).toBe(true);
    expect(reads()).toBe(4);
    expect(order.at(-1)).toBe('engine');
  });

  test('stores never cleared within the bound are the reading judged, and the engine is still waited for', async () => {
    const { fake, order } = host(Number.MAX_SAFE_INTEGER);
    const after = await afterSourceDelete(fake, 'telegram', fx.token, 10_000);
    expect(after.stores.some((store) => store.tokenRows > 0)).toBe(true);
    expect(order.at(-1)).toBe('engine');
    expect(failing(good({ deleted: { ok: true, unpaired: true, stores: after.stores, rowGone: true, engineBack: after.engineBack } }))).toEqual(['archive.beside.fixture_chat.deleted']);
  });

  test('an engine that does not come back is said', async () => {
    const after = await afterSourceDelete(host(0, false).fake, 'telegram', fx.token, 10_000);
    expect(after.engineBack).toBe(false);
    expect(after.detail).toBe('not ready');
  });
});
