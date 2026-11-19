import { expect, test } from 'bun:test';
import { cutoverChecks, dashboardAvailabilityCheck, startupAskCheck, hiddenCopyBuilds, samplePage, summarizeCutover, summarizePages } from '../scripts/release-check/cutover.ts';

test('startup uses the first complete receipt per role and records the background wait and warnings', () => {
  const partial = [
    "[olympus] front: a store's hidden-copy set could not be built yet: store detail",
    "[olympus] front: built 2 stores' hidden-copy sets in 10 ms",
    "[olympus] front: built 9 stores' hidden-copy sets in 99 ms",
    '[olympus] background: starting hidden-copy build after waiting 800 ms (front finished)',
    "[olympus] background: built 2 stores' hidden-copy sets",
  ].join('\n');
  expect(hiddenCopyBuilds(partial)).toEqual({
    finished: { front: { stores: 2, ms: 10 } },
    backgroundWait: { ms: 800, reason: 'front finished' },
    warnings: ['front'],
  });
  const hiddenCopy = hiddenCopyBuilds(partial + "\n[olympus] background: built 2 stores' hidden-copy sets in 123 ms");
  const summary = summarizeCutover([
    { startupStarted: 100 }, { hiddenCopy }, { startupEnded: 500, bothBuilds: true },
  ].map(entry => JSON.stringify(entry)).join('\n') + '\n');
  const check = cutoverChecks(summary).find(check => check.id === 'upgrade.cutover.startup');
  expect(check?.status).toBe('pass');
  expect(check?.detail).toContain('background built 2 stores in 123 ms');
  expect(check?.detail).toContain('background waited 800 ms (front finished)');
  expect(check?.detail).toContain('front logged 1 hidden-copy build warning(s)');
  expect(check?.detail).not.toContain('store detail');
});

test('unanswered stretches include the tail and use ordered answers, independent of request timeouts', () => {
  const summary = summarizePages([
    { page: 'Home', at: 4_000, ms: 100, answered: true, timeout: false },
    { page: 'Home', at: 2_000, ms: 10_000, answered: false, timeout: true },
    { page: 'Home', at: 0, ms: 2_500, answered: true, timeout: false },
    { page: 'Sources', at: 0, ms: 500, answered: true, timeout: false },
    { page: 'Sources', at: 14_000, ms: 2_000, answered: true, timeout: false },
  ], 0, 15_000);
  expect(summary.pages.Home).toEqual({ longestMs: 10_900, answers: 2, timeouts: 1, over1s: 2, firstGapAt: 14_101 });
  expect(summary.pages.Sources).toEqual({ longestMs: 14_500, answers: 1, timeouts: 0, over1s: 0, firstGapAt: 10_501 });
  expect(dashboardAvailabilityCheck(summary, true, true).status).toBe('fail');
});

test('boot and qualification have independent endpoints and exactly 10 s passes', () => {
  const entries = [
    { startupStarted: 100 },
    { qualifyStarted: 200 },
    { pageSample: { page: 'Home', at: 200, ms: 100, answered: true, timeout: false } },
    { pageSample: { page: 'Sources', at: 200, ms: 100, answered: true, timeout: false } },
    { startupEnded: 10_300, bothBuilds: true },
    { watchEnded: 10_301, stopped: true },
  ];
  const summary = summarizeCutover(entries.map(entry => JSON.stringify(entry)).join('\n') + '\n');
  expect(cutoverChecks(summary).find(check => check.id === 'upgrade.cutover.startup')?.status).toBe('pass');
  expect(dashboardAvailabilityCheck(summary.qualification).status).toBe('fail');
  expect(dashboardAvailabilityCheck(summary.startup, true, false).status).toBe('fail');
});

test('Home requires the panel response and both pages accept the front’s starting page', async () => {
  const paths: string[] = [];
  const html = (body: string, status = 200) => new Response(body, { status, headers: { 'content-type': 'text/html' } });
  const probe = async (path: string) => {
    paths.push(path);
    if (path === '/dashboard') return html('<iframe id="olympus-panel"></iframe>');
    return Response.json({ isError: true }, { status: 503 });
  };
  expect((await samplePage(probe, 'Home', Date.now())).answered).toBe(false);
  expect(paths).toEqual(['/dashboard', '/dashboard/tools/call']);
  for (const page of ['Home', 'Sources'] as const) {
    expect((await samplePage(async () => html('Olympus is starting:', 503), page, Date.now())).answered).toBe(true);
    expect((await samplePage(async () => html('sign in'), page, Date.now())).answered).toBe(false);
  }
});

test('an Ask taken during start-up fails only if it is cancelled, lost or silent, and reports its time', () => {
  expect(startupAskCheck(undefined).status).toBe('skip');
  expect(startupAskCheck({ status: 200, ms: 190_600, saidStarting: true, completed: true })).toMatchObject({ id: 'qualify.ask-startup', status: 'pass', ms: 190_600 });
  expect(startupAskCheck({ status: 200, ms: 40_000, saidStarting: false, completed: true }).status).toBe('fail');
  expect(startupAskCheck({ status: 503, ms: 1_000, saidStarting: true, completed: false }).detail).toContain('cancelled');
  expect(startupAskCheck({ status: null, ms: 0, saidStarting: false, completed: false, error: 'timeout' }).detail).toContain('lost or cancelled');
});

test('after ready, any Home or Sources probe over 1 s fails qualify.dashboard; during start-up only a 10 s gap does', () => {
  const at = 1_000_000;
  const samples = [0, 2, 4, 6].flatMap(s => (['Home', 'Sources'] as const).map(page => ({ page, at: at + s * 1000, ms: s === 4 && page === 'Home' ? 1_500 : 50, answered: true, timeout: false })));
  const window = summarizePages(samples, at, at + 8_000);
  expect(dashboardAvailabilityCheck(window).status).toBe('fail');
  expect(dashboardAvailabilityCheck(window, true, true).status).toBe('pass');
});

test('a restart the leg asked for is left out of the window after READY; a slow probe outside it still fails', () => {
  const sample = (page: 'Home' | 'Sources', at: number, ms: number, answered = true) => ({ pageSample: { page, at, ms, answered, timeout: false } });
  const entries = [
    { startupStarted: 0 }, { startupEnded: 1_000, bothBuilds: true },
    ...[1_000, 3_000, 5_000].flatMap(at => [sample('Home', at, 50), sample('Sources', at, 50)]),
    // The restart: one probe hangs into it and one is refused inside it.
    sample('Home', 6_900, 3_000, false), sample('Sources', 7_000, 100, false),
    { plannedRestart: { start: 7_000, end: 12_000 } },
    ...[13_000, 15_000].flatMap(at => [sample('Home', at, 50), sample('Sources', at, 50)]),
    { watchEnded: 16_000, stopped: true },
  ];
  const log = entries.map(entry => JSON.stringify(entry)).join('\n') + '\n';
  expect(dashboardAvailabilityCheck(summarizeCutover(log).qualification).status).toBe('pass');
  const slow = log.replace('{"page":"Home","at":13000,"ms":50', '{"page":"Home","at":13000,"ms":1500');
  expect(dashboardAvailabilityCheck(summarizeCutover(slow).qualification).status).toBe('fail');
  const unmarked = log.replace(/.*plannedRestart.*\n/, '');
  expect(dashboardAvailabilityCheck(summarizeCutover(unmarked).qualification).status).toBe('fail');
});
