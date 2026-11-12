import { expect, test } from 'bun:test';
import { percentile, scaleChecks, scaleReadwiseStage, scaleRowCount, READWISE_SCALE_ROW, type ScaleHost, type ScaleObservation } from '../scripts/release-check/archive-scale.ts';
import { SCALE_FIRST, SCALE_LAST } from '../scripts/release-check/archive-scale-fixtures.ts';
import { datesWord, gapSentence, messagesWord } from '../scripts/release-check/archive-leg.ts';
import { buildReport, renderHtml } from '../scripts/release-check/report.ts';
import type { JourneyDriver } from '../scripts/release-check/journey.ts';
import { createTestClock, flushMicrotasks } from './helpers/test-clock.ts';

function observation(): ScaleObservation {
  const count = 19_995;
  return { format: 'mbox', expected: count, ok: true, drained: true, held: 0, removed: true, gaps: { message_unreadable: 5 }, traces: [],
    archive: { id: 'scale', name: 'scale.mbox', format: 'mbox', status: 'imported', messages: count, waiting: 0, earliest: SCALE_FIRST, latest: SCALE_LAST, notImported: [], howRead: [] },
    row: { name: 'scale.mbox', status: 'imported', text: messagesWord(count, 'email'), facts: datesWord({ earliest: SCALE_FIRST, latest: SCALE_LAST }), notImported: [gapSentence('message_unreadable', 5)], howRead: [], gapLines: [], headings: [], tag: 'Imported', buttons: [], whyOpen: true },
    samples: [{ ms: 0, items: 100, status: 'importing' }, { ms: 10_000, items: count, status: 'imported' }],
    repeat: { already: true, added: 0 }, renamed: { already: true, added: 0 },
    measurement: { format: 'mbox', wallMs: 10_000, items: count, itemsPerMinute: count * 6, peakRssBytes: null, frontP50Ms: null, frontP95Ms: null, frontSamples: 0, frontFailures: 0 } };
}
const failures = (obs: ScaleObservation) => scaleChecks('mbox', obs).filter(c => c.status === 'fail').map(c => c.id);

test('scale checks fail independently for count, dates, held items, exact gaps, UI progress/reasons, duplicates and removal', () => {
  expect(failures(observation())).toEqual([]);
  const cases: Array<[string, (obs: ScaleObservation) => void]> = [
    ['items', obs => { obs.archive!.messages = 1; }],
    ['dates', obs => { obs.archive!.earliest = '2024-01-01'; }],
    ['held', obs => { obs.drained = false; obs.held = 37; }],
    ['gaps', obs => { obs.gaps = { message_unreadable: 5, message_too_large: 1 }; }],
    ['gaps', obs => { delete obs.gaps; }],
    ['progress', obs => { obs.samples = obs.samples.map(s => ({ ...s, items: null })); }],
    ['progress', obs => { obs.samples = obs.samples.map(s => ({ ...s, items: 100 })); }],
    ['dashboard', obs => { obs.row!.notImported = []; }],
    ['dashboard', obs => { obs.row!.whyOpen = false; }],
    ['repeat', obs => { obs.repeat!.already = false; }],
    ['renamed', obs => { obs.renamed!.added = 1; }],
    ['removed', obs => { obs.removed = false; }],
  ];
  for (const [id, mutate] of cases) {
    const obs = observation(); mutate(obs);
    expect(failures(obs)).toEqual([`archive.scale.mbox.${id}`]);
  }
  const held = observation(); held.held = 37; held.drained = false;
  expect(scaleChecks('mbox', held).find(c => c.id.endsWith('.held'))!.detail).toContain('37 still held');
  expect(scaleChecks('mbox', undefined)[0]!.status).toBe('fail');
});

test('measurement percentiles and row counts preserve missing data', () => {
  expect(percentile([], .95)).toBeNull();
  expect(percentile([100, 1, 3, 2, 4], .5)).toBe(3);
  expect(percentile([100, 1, 3, 2, 4], .95)).toBe(100);
  expect(scaleRowCount({ text: '19,995 messages · judged' })).toBe(19_995);
  expect(scaleRowCount({ text: '3,000 notes' })).toBe(3_000);
  expect(scaleRowCount({ text: 'Counting… 100 items' })).toBeNull();
  expect(scaleRowCount(undefined)).toBeNull();
});

/** Only the Sources-tab opening is scripted; progress always comes from that tab's visible row. */
async function readwiseStage(options: { held?: number; throwAtStart?: boolean; cleanupFails?: boolean } = {}) {
  const clock = createTestClock(0);
  let currentItems = 100;
  let syncs = 0;
  let cleaned = false;
  let at = '';
  const driver: JourneyDriver = {
    hasPanel: async () => false,
    click: async () => null, type: async () => false,
    open: async () => { throw new Error('unexpected open'); },
    reload: async () => { throw new Error('unexpected reload'); },
    setViewport: async () => { throw new Error('unexpected viewport'); },
    go: async (path: string) => { at = path; },
    where: async () => at, pages: async () => 1, screenshot: async () => true,
    drainEvents: () => ({ console: [], requests: [] }),
    probe: async (_frame: string, call: string) => {
      if (call === READWISE_SCALE_ROW) return `Readwise ${currentItems.toLocaleString('en-US')} items`;
      if (call.startsWith('__rc.count(')) return at === '/dashboard?connect' ? 1 : 0;
      if (call === '__rc.audit()') return { bad: [], emptyButtons: [], overflowX: 0, textLength: 100 };
      throw new Error(`unexpected probe: ${call}`);
    },
  };
  const host = {
    now: clock.now, sleep: clock.sleep,
    withBrowser: async (work: (session: { driver: JourneyDriver }) => Promise<unknown>) => work({ driver }),
    engineRss: () => 12_000,
    frontStatus: async () => { await clock.sleep(5); return true; },
    beginReadwise: async () => { if (options.throwAtStart) throw new Error('connection failed'); },
    readwiseSnapshot: async () => {
      currentItems = clock.now() >= 20_000 ? 3_800 : 100;
      return { items: currentItems, held: options.held ?? 0, gaps: {}, earliest: SCALE_FIRST, latest: SCALE_LAST,
        complete: currentItems === 3_800, running: currentItems < 3_800, run: syncs >= 2 ? 'second' : 'first' };
    },
    // The first second-sync request is too soon; the stage must retry it and wait for a fresh completed run.
    syncReadwise: async () => { syncs++; },
    endReadwise: async () => { cleaned = true; return !options.cleanupFails; },
  } as unknown as ScaleHost;
  let done = false;
  const task = scaleReadwiseStage(host, 'stage-seed', 40).finally(() => { done = true; });
  for (let i = 0; i < 100 && !done; i++) { await flushMicrotasks(100); await clock.advance(2_000); }
  expect(done).toBe(true);
  return { obs: await task, syncs, cleaned };
}

test('Readwise samples the Sources row, measures the front independently, retries the second sync and cleans up', async () => {
  const { obs, syncs, cleaned } = await readwiseStage();
  expect(scaleChecks('readwise', obs).filter(c => c.status === 'fail')).toEqual([]);
  expect(syncs).toBeGreaterThanOrEqual(2);
  expect(cleaned).toBe(true);
  expect(obs.measurement).toMatchObject({ items: 3_800, peakRssBytes: 12_000, frontP50Ms: 5, frontP95Ms: 5, frontFailures: 0 });
  expect(obs.measurement.frontSamples).toBeGreaterThan(1);
  expect(obs.measurement.itemsPerMinute).toBeGreaterThan(0);
});

test('Readwise held timeout reports the population, and failed starts still run cleanup', async () => {
  const timeout = await readwiseStage({ held: 37 });
  expect(timeout.cleaned).toBe(true);
  const held = scaleChecks('readwise', timeout.obs).find(c => c.id.endsWith('.held'))!;
  expect(held.status).toBe('fail');
  expect(held.detail).toContain('37 still held');
  const failed = await readwiseStage({ throwAtStart: true, cleanupFails: true });
  expect(failed.cleaned).toBe(true);
  expect(failed.obs.ok).toBe(false);
  expect(failed.obs.detail).toContain('connection failed');
  expect(failed.obs.removed).toBe(false);
});


test('the report renders scale measurements without imposing performance thresholds', () => {
  const obs = observation();
  obs.measurement = { ...obs.measurement, wallMs: 123_000, itemsPerMinute: 9753.7, peakRssBytes: 64 * 1024 * 1024, frontP50Ms: 12.5, frontP95Ms: 95000, frontSamples: 62, frontFailures: 3 };
  expect(failures(obs)).toEqual([]);
  const report = buildReport({ runId: 'scale-report', candidate: { label: 'synthetic' }, startedAt: '2026-01-01T00:00:00Z', finishedAt: '2026-01-01T01:00:00Z', errors: [],
    machines: [{ id: 'linux', label: 'Synthetic VM', os: 'linux', driver: 'synthetic', timings: {}, checks: [], agents: [], screenshots: [], logs: [], archiveScale: [obs.measurement] }] });
  const html = renderHtml(report);
  for (const expected of ['Archive scale measurements', '123.0 s', '9753.7', '64.0 MiB', '12.5 ms / 95000.0 ms', '62 / 3']) expect(html).toContain(expected);
  expect(renderHtml({ ...report, machines: report.machines.map(({ archiveScale, ...machine }) => machine) })).not.toContain('Archive scale measurements');
});
