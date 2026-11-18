import { expect, test } from 'bun:test';
import { cutoverChecks, dashboardAvailabilityCheck, hiddenCopyBuilds, samplePage, summarizeCutover, summarizePages } from '../scripts/release-check/cutover.ts';

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
