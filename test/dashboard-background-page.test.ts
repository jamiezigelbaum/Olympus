import { describe, expect, test } from 'bun:test';
import {
  dashboardBackgroundLanes,
  renderDashboardBackgroundPage,
} from '../src/workers/dashboard/pages/background.ts';
import { renderDashboardHomePage } from '../src/workers/dashboard/pages/home.ts';
import {
  DASHBOARD_BACKGROUND_QUERY_PARAM,
  DASHBOARD_HTML_PATH,
  renderDashboardHtmlRoute,
} from '../src/workers/dashboard/index.ts';
import type {
  DashboardSourceCard,
  SourceDashboardViewModel,
} from '../src/workers/source-dashboard.ts';
import type {
  BackgroundLaneRuntime,
  BackgroundRuntimeFacts,
} from '../src/workers/dashboard/background-runtime.ts';

const NOW = new Date('2026-07-02T12:00:00.000Z');
const GENERATED_AT = '2026-07-02T11:59:48.000Z';

describe('background lanes', () => {
  test('names only the lanes the view model can describe', () => {
    const view = fixtureView([scheduledSource({})], {
      background_work: {
        embedding_backlog: { chunks: 263_071, embedded_chunks: 133_123, missing_chunks: 129_948, refresh_needed: false },
        vlm_extraction_queued: 19,
      },
    });

    const lanes = dashboardBackgroundLanes(view, { now: NOW }).map((lane) => lane.name);

    expect(lanes).toEqual(['Embeddings', 'Vision', 'Syncs']);
  });

  test('reports no lane at all when nothing in the background is reporting', () => {
    const view = fixtureView([quietSource({})]);

    expect(dashboardBackgroundLanes(view, { now: NOW })).toEqual([]);
  });

  test('gives the embedding lane the one background ratio the model carries', () => {
    const view = fixtureView([quietSource({})], {
      background_work: {
        embedding_backlog: { chunks: 200_000, embedded_chunks: 100_000, missing_chunks: 100_000, refresh_needed: false },
      },
    });

    const lane = dashboardBackgroundLanes(view, { now: NOW })[0];

    expect(lane?.name).toBe('Embeddings');
    expect(lane?.fraction).toBeCloseTo(0.5, 5);
    expect(lane?.facts).toContain('50% embedded');
    expect(lane?.facts).toContain('100k of 200k chunks left');
    expect(lane?.working).toBe(true);
  });

  test('claims no rate and no ETA for embedding, because neither field exists', () => {
    const view = fixtureView([quietSource({})], {
      background_work: {
        embedding_backlog: { chunks: 200_000, embedded_chunks: 100_000, missing_chunks: 100_000, refresh_needed: false },
      },
    });

    const lane = dashboardBackgroundLanes(view, { now: NOW })[0];

    expect(lane?.facts).not.toContain('/s');
    expect(lane?.facts).not.toContain('left ·');
    expect(lane?.facts).not.toContain('~');
  });

  test('leaves the vision lane without a bar, because no denominator exists', () => {
    const view = fixtureView([quietSource({})], { background_work: { vlm_extraction_queued: 19 } });

    const lane = dashboardBackgroundLanes(view, { now: NOW })[0];

    expect(lane?.name).toBe('Vision');
    expect(lane?.fraction).toBeUndefined();
    expect(lane?.facts).toContain('19 jobs queued');
  });

  test('states a held extractor drain as the vision lane not working', () => {
    const view = fixtureView([drainingSource({})], { background_work: { vlm_extraction_queued: 4 } });

    const lane = dashboardBackgroundLanes(view, { now: NOW })[0];

    expect(lane?.facts).toContain('extraction held on 1 source');
    expect(lane?.working).toBe(false);
    expect(lane?.checks.some((check) => check.name === 'EXTRACTION_DRAIN')).toBe(true);
  });

  test('sums the sync lane out of the schedules the cards carry', () => {
    const view = fixtureView([
      scheduledSource({ source_id: 'gmail.email', label: 'Gmail' }),
      scheduledSource({ source_id: 'readwise.library', label: 'Readwise' }),
    ]);

    const lane = dashboardBackgroundLanes(view, { now: NOW })[0];

    expect(lane?.name).toBe('Syncs');
    expect(lane?.facts).toContain('all 2 on schedule');
    expect(lane?.facts).toContain('next: Gmail in 4m');
  });

  test('draws one strip bar per scheduled source, coloured by its last run', () => {
    const view = fixtureView([
      scheduledSource({ source_id: 'gmail.email', label: 'Gmail' }),
      failingSource({ source_id: 'dropbox.files', label: 'Dropbox' }),
    ]);

    const lane = dashboardBackgroundLanes(view, { now: NOW })[0];

    expect(lane?.strip?.length).toBe(2);
    expect(lane?.strip?.map((item) => item.tone).sort()).toEqual(['bad', 'good']);
  });
});

describe('background page', () => {
  test('leads with tiles that never claim a window no field measures', () => {
    const view = fixtureView([scheduledSource({})], {
      background_work: {
        embedding_backlog: { chunks: 200_000, embedded_chunks: 100_000, missing_chunks: 100_000, refresh_needed: false },
        vlm_extraction_queued: 19,
      },
    });

    const html = renderDashboardBackgroundPage(view, { now: NOW });

    expect(html).toContain('class="kpis"');
    // The section is named in the reader's words, not the module's. (The KPI
    // tile above it still counts "Lanes", which is a unit and not a heading.)
    expect(html).toContain('>Work running in the background<');
    expect(html).not.toContain('<div class="dsect">Lanes</div>');
    expect(html).toContain('of 3');
    expect(html).not.toContain('last 24h');
    expect(html).not.toContain('last hour');
    expect(html).not.toContain('Today');
  });

  test('carries the shared nav with Background marked as the page being read', () => {
    const view = fixtureView([scheduledSource({})]);

    const html = renderDashboardBackgroundPage(view, { now: NOW });

    expect(html).toContain('class="dnav"');
    expect(html).toContain('<a class="dnavlink on" href="/dashboard?background" aria-current="page">Background</a>');
    expect(html).toContain('href="/dashboard">Home</a>');
    expect(html).toContain('href="/dashboard?setup">Setup</a>');
  });

  test('offers the one link out to the embedding history', () => {
    const view = fixtureView([scheduledSource({})]);

    const html = renderDashboardBackgroundPage(view, { now: NOW });

    expect(html).toContain('href="/dashboard?embedding-ledger">Embedding decisions &amp; history →</a>');
  });

  test('counts no failures tile, because a count with no disposition is the failures lane', () => {
    const view = fixtureView([failingSource({ label: 'Dropbox' })]);

    const html = renderDashboardBackgroundPage(view, { now: NOW });

    expect(html).not.toContain('>Failures<');
    expect(html).not.toContain('consecutive attempt');
  });

  test('names the source behind the longest ETA rather than a lane', () => {
    const view = fixtureView([
      { ...scheduledSource({ label: 'Gmail' }), progress: { indexed_items_per_hour: 312, eta_minutes: 54 } },
    ]);

    const html = renderDashboardBackgroundPage(view, { now: NOW });

    expect(html).toContain('Longest ETA');
    expect(html).toContain('~54m');
    expect(html).toContain('Gmail ingest');
  });

  test('draws no throughput sparkline, because no per-hour history exists', () => {
    const view = fixtureView([scheduledSource({})], { background_work: { vlm_extraction_queued: 3 } });

    const html = renderDashboardBackgroundPage(view, { now: NOW });

    expect(html).not.toContain('<polyline');
    expect(html).not.toContain('<polygon');
    expect(html).not.toContain('Throughput');
  });

  test('gives each lane a block with a state word and no source status glyph', () => {
    const view = fixtureView([scheduledSource({})], {
      background_work: {
        embedding_backlog: { chunks: 1_000, embedded_chunks: 400, missing_chunks: 600, refresh_needed: false },
      },
    });

    const html = renderDashboardBackgroundPage(view, { now: NOW });

    expect(html).toContain('class="lane"');
    expect(html).toContain('>Embeddings<');
    expect(html).toContain('class="lstate"');
    expect(html).toContain('class="minibar"');
    // The six-word vocabulary describes sources; a lane is not one.
    expect(html).not.toContain('class="dot"');
    expect(html).not.toContain('<svg');
    expect(html).not.toContain('Fresh');
  });

  test('gives every non-moving lane a printed reason, and never a bare percentage', () => {
    const view = fixtureView([scheduledSource({})], {
      background_work: {
        embedding_backlog: { chunks: 200_000, embedded_chunks: 156_000, missing_chunks: 44_000, refresh_needed: false },
        vlm_extraction_queued: 12,
      },
    });

    const html = renderDashboardBackgroundPage(view, { now: NOW });

    // The owner's complaint, in one assertion: the percentage is on the page,
    // and no lane carrying one is allowed to stop there.
    expect(html).toContain('78% embedded');
    const laneBlocks = html.split('class="lane"').slice(1);
    expect(laneBlocks.length).toBeGreaterThan(0);
    for (const block of laneBlocks) {
      const moving = block.includes('Working now');
      const explained = block.includes('class="lreason"')
        || block.includes('class="lreason unknown"')
        || block.includes('class="lreason stuck"')
        || block.includes('Nothing waiting');
      expect(moving || explained).toBe(true);
    }
  });

  test('shows nothing at all for a failure the system is already retrying', () => {
    // A booked next run and a retrying task are both self-healing, and the page
    // that used to list them is the page the owner stopped reading.
    const view = fixtureView([failingSource({ label: 'Dropbox' })]);

    const html = renderDashboardBackgroundPage(view, { now: NOW });

    expect(html).not.toContain('Needs a look');
    expect(html).not.toContain('self-healing');
    expect(html).not.toContain('[CONSECUTIVE_FAILURES]');
    expect(html).not.toContain('class="tip"');
  });

  test('shows nothing for a failure with no booked run but a live retry', () => {
    const stranded = failingSource({ source_id: 'dropbox.files', label: 'Dropbox' });
    const view = fixtureView([{
      ...stranded,
      schedule: { running: false, consecutive_failures: 3, last_error_kind: 'provider_rate_limited' },
      queue_health: { label: 'Needs attention', waiting: 0, active: 0, needs_attention: 2, retrying_tasks: 1 },
    }]);

    const html = renderDashboardBackgroundPage(view, { now: NOW });

    expect(html).not.toContain('Needs a look');
  });

  test('banners the same failure when nothing will run it again', () => {
    const stranded = failingSource({ source_id: 'dropbox.files', label: 'Dropbox' });
    const view = fixtureView([{
      ...stranded,
      schedule: {
        running: false,
        consecutive_failures: 3,
        last_attempt_at: '2026-07-02T11:44:28.000Z',
        last_error_kind: 'provider_rate_limited',
      },
      queue_health: { label: 'Needs attention', waiting: 0, active: 0, needs_attention: 2 },
    }]);

    const html = renderDashboardBackgroundPage(view, { now: NOW });

    expect(html).toContain('Needs a look');
    expect(html).toContain('failed 3 times in a row and nothing is scheduled to try it again');
    // A banner is not a dead end: it leads to the one page that can act on it.
    expect(html).toContain('href="/dashboard?source=dropbox.files"');
  });

  test('sends a needs-you action through the reader own token prefix', () => {
    const stranded = failingSource({ source_id: 'dropbox.files', label: 'Dropbox' });
    const view = fixtureView([{
      ...stranded,
      schedule: { running: false, consecutive_failures: 3, last_error_kind: 'provider_rate_limited' },
      queue_health: { label: 'Needs attention', waiting: 0, active: 0, needs_attention: 2 },
    }]);

    const html = renderDashboardBackgroundPage(view, { now: NOW, basePath: '/dashboard?token=dash_abc' });

    expect(html).toMatch(/\/dashboard\?token=dash_abc(&|&amp;)source=dropbox\.files/);
  });

  test('banners a held extraction drain and says what it means in plain words', () => {
    const view = fixtureView([drainingSource({ label: 'Gmail' })]);

    const html = renderDashboardBackgroundPage(view, { now: NOW });

    expect(html).toContain('Needs a look');
    expect(html).toContain('Extraction is held on Gmail');
    expect(html).toContain('no new text is being extracted');
    expect(html).toContain('href="/dashboard?source=gmail.email"');
    // The mechanical check name never reaches the reader any more.
    expect(html).not.toContain('EXTRACTION_DRAIN');
  });

  test('says what stuck items are waiting on, and banners nothing when a task has them', () => {
    const retrying = drainingSource({ label: 'Gmail' });
    const withRetry = fixtureView([{
      ...retrying,
      ingestion_health: {
        ...retrying.ingestion_health,
        drain_state: 'enabled',
        // A live drain: 72 seconds since it last did anything, well inside the
        // heartbeat window, so the lane is moving and not stuck.
        last_drain_activity_hours: 0.02,
      },
      queue_health: { label: 'Working now', waiting: 0, active: 0, needs_attention: 2, retrying_tasks: 2 },
    }]);

    const html = renderDashboardBackgroundPage(withRetry, { now: NOW });

    expect(html).toContain('12 stuck items on Gmail');
    expect(html).toContain('2 tasks already retrying them');
    expect(html).not.toContain('Needs a look');
  });

  test('banners a lane that claims to be running while its heartbeat has stopped', () => {
    // The owner complaint in its exact shape: the drain says it is enabled and
    // has not done anything for 24 minutes. Nothing on the old page said so.
    const stalled = drainingSource({ label: 'Gmail' });
    const view = fixtureView([{
      ...stalled,
      ingestion_health: {
        ...stalled.ingestion_health,
        drain_state: 'enabled',
        last_drain_activity_hours: 0.4,
      },
    }]);

    const html = renderDashboardBackgroundPage(view, { now: NOW });

    expect(html).toContain('Needs a look');
    expect(html).toContain('says it is running, but it has not reported any activity for 24 minutes');
    expect(html).toContain('Not moving');
    expect(html).toContain('last activity 24m ago');
  });

  test('states the chunk backlog as a queue with what it waits on, never as a verdict', () => {
    const live = fixtureView([quietSource({})], {
      background_work: {
        embedding_backlog: { chunks: 1_000, embedded_chunks: 400, missing_chunks: 600, refresh_needed: true },
      },
    });
    const off = fixtureView([quietSource({})], {
      background_work: {
        embedding_backlog: { chunks: 1_000, embedded_chunks: 400, missing_chunks: 600, refresh_needed: true },
        embedding_lane_state: 'embedding_lane_disabled',
      },
    });

    const liveHtml = renderDashboardBackgroundPage(live, { now: NOW });
    expect(liveHtml).toContain('600 chunks not yet embedded');
    expect(liveHtml).toContain('waiting on');
    // Nothing needs the owner, so nothing reaches the top of the page.
    expect(liveHtml).not.toContain('Needs a look');
    expect(liveHtml).not.toContain('self-healing');

    const offHtml = renderDashboardBackgroundPage(off, { now: NOW });
    expect(offHtml).toContain('Needs a look');
    expect(offHtml).toContain('The embedding lane is switched off');
    // A switched-off lane is a stated governing condition, not an unknown.
    expect(offHtml).toContain('the embedding lane is switched off for this corpus');
    expect(offHtml).not.toContain('State unknown');
  });

  test('offers no lane row for OCR or transcription, which no field describes', () => {
    const view = fixtureView([scheduledSource({ ...drainingSource({}) })], {
      background_work: {
        embedding_backlog: { chunks: 1_000, embedded_chunks: 400, missing_chunks: 600, refresh_needed: false },
        vlm_extraction_queued: 19,
      },
    });

    const html = renderDashboardBackgroundPage(view, { now: NOW });

    expect(html).not.toContain('OCR');
    expect(html).not.toContain('Transcription');
    expect(dashboardBackgroundLanes(view, { now: NOW }).map((lane) => lane.name))
      .toEqual(['Embeddings', 'Vision', 'Syncs']);
  });

  test('shows no tip at all while every lane is fine', () => {
    const view = fixtureView([scheduledSource({})]);

    const html = renderDashboardBackgroundPage(view, { now: NOW });

    expect(html).not.toContain('class="tip"');
  });

  test('tables the last run of each source under a heading that says exactly that', () => {
    const view = fixtureView([scheduledSource({ label: 'Gmail' })]);

    const html = renderDashboardBackgroundPage(view, { now: NOW });

    expect(html).toContain('Last run of each source');
    expect(html).toContain('<th>Took</th>');
    // The Result cell carries designed copy, not the raw enum.
    expect(html).toContain('>✓ Completed</td>');
    // No event stream exists, so nothing calls itself one.
    expect(html).not.toContain('Activity');
    expect(html).not.toContain('class="feed"');
  });

  test('drops the run table when no card recorded a run', () => {
    const view = fixtureView([quietSource({})], { background_work: { vlm_extraction_queued: 2 } });

    const html = renderDashboardBackgroundPage(view, { now: NOW });

    expect(html).not.toContain('Last run of each source');
    expect(html).not.toContain('<table>');
  });

  test('says one calm sentence when no lane reports at all', () => {
    const view = fixtureView([quietSource({})]);

    const html = renderDashboardBackgroundPage(view, { now: NOW });

    expect(html).toContain('No background lane is reporting right now.');
    expect(html).not.toContain('class="lanerow"');
    expect(html).not.toContain('class="kpis"');
  });

  test('heads the page with the lanes working and the check time', () => {
    const view = fixtureView([scheduledSource({})], { background_work: { vlm_extraction_queued: 19 } });

    const html = renderDashboardBackgroundPage(view, { now: NOW });

    expect(html).toContain('Olympus / Background');
    expect(html).toContain('1 lane working · checked 12s ago');
  });

  test('escapes every value that came off the view model', () => {
    const view = fixtureView([
      failingSource({ label: '<script>alert(1)</script>', source_id: 'evil.source' }),
    ]);

    const html = renderDashboardBackgroundPage(view, { now: NOW });

    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
  });

  test('masks a token-shaped string before it reaches the tip', () => {
    const source = failingSource({ label: 'Dropbox' });
    const view = fixtureView([{
      ...source,
      schedule: { ...source.schedule!, degraded_reason: 'refused token sk-abcdefghijklmnop' },
    }]);

    const html = renderDashboardBackgroundPage(view, { now: NOW });

    expect(html).toContain('[REDACTED]');
    expect(html).not.toContain('sk-abcdefghijklmnop');
  });
});

describe('background route', () => {
  test('serves the background page on the same path as every other page', () => {
    const view = fixtureView([scheduledSource({})]);
    const url = new URL(`http://worker.test${DASHBOARD_HTML_PATH}?${DASHBOARD_BACKGROUND_QUERY_PARAM}`);

    const page = renderDashboardHtmlRoute({ url, view, options: { now: NOW } });

    expect(page.status).toBe(200);
    expect(page.html).toContain('Olympus / Background');
  });

  test('serves the background page even before a source is connected', () => {
    const view = fixtureView([{ ...quietSource({}), configured: false }]);
    const url = new URL(`http://worker.test${DASHBOARD_HTML_PATH}?${DASHBOARD_BACKGROUND_QUERY_PARAM}`);

    const page = renderDashboardHtmlRoute({ url, view, options: { now: NOW } });

    expect(page.status).toBe(200);
    expect(page.html).toContain('Olympus / Background');
  });
});

describe('background page with lane reports', () => {
  test('states the rate, the ETA and the heartbeat of a moving lane', () => {
    const view = fixtureView([quietSource({})], {
      background_work: {
        embedding_backlog: { chunks: 200_000, embedded_chunks: 156_000, missing_chunks: 12_400, refresh_needed: false },
      },
    });

    const html = renderDashboardBackgroundPage(view, {
      now: NOW,
      backgroundRuntime: runtimeFacts([movingEmbeddingLane()]),
    });

    expect(html).toContain('Working now');
    expect(html).toContain('1,240 chunks/min');
    expect(html).toContain('about 10m left');
    expect(html).toContain('last activity 8s ago');
  });

  test('prints the guard own words when a lane is parked, and never a clock', () => {
    const view = fixtureView([quietSource({})], {
      background_work: {
        embedding_backlog: { chunks: 200_000, embedded_chunks: 70_000, missing_chunks: 130_000, refresh_needed: false },
      },
    });

    const html = renderDashboardBackgroundPage(view, {
      now: NOW,
      backgroundRuntime: runtimeFacts([{
        ...movingEmbeddingLane(),
        samples: [],
        reportsLive: false,
        governing: { text: 'metadata frontier pending', decidedBy: 'the overnight guard' },
      }]),
    });

    expect(html).toContain('Waiting');
    expect(html).toContain('Waiting: metadata frontier pending — the overnight guard');
    expect(html).not.toContain('State unknown');
    expect(html).not.toContain('tonight');
    // And the queued work says what it is and what it is waiting on.
    expect(html).toContain('130,000 chunks not yet embedded');
    expect(html).toContain('which is waiting: metadata frontier pending');
  });

  test('banners a lane whose counter has not moved while its heartbeat keeps arriving', () => {
    const view = fixtureView([quietSource({})], {
      background_work: {
        embedding_backlog: { chunks: 200_000, embedded_chunks: 70_000, missing_chunks: 130_000, refresh_needed: false },
      },
    });

    const html = renderDashboardBackgroundPage(view, {
      now: NOW,
      backgroundRuntime: runtimeFacts([{
        ...movingEmbeddingLane(),
        samples: [
          { at: new Date(NOW.getTime() - 12 * 60_000), count: 88_000, heartbeatSeq: 1 },
          { at: NOW, count: 88_000, heartbeatSeq: 2 },
        ],
      }]),
    });

    expect(html).toContain('Needs a look');
    expect(html).toContain('Not moving');
    expect(html).toContain('130,000 chunks left and has moved none of them in the last 12 minutes');
  });

  test('collapses a lane with nothing outstanding to one quiet line', () => {
    const view = fixtureView([quietSource({})]);

    const html = renderDashboardBackgroundPage(view, {
      now: NOW,
      backgroundRuntime: runtimeFacts([{
        id: 'telegram-sync-drain',
        name: 'Telegram sync',
        unit: 'messages',
        reportsLive: false,
        lastActivityAt: new Date(NOW.getTime() - 30_000),
        samples: [],
        remaining: 0,
      }]),
    });

    expect(html).toContain('class="lane quiet"');
    expect(html).toContain('Nothing waiting');
    // A quiet lane draws no bar, no rate line and no queue.
    expect(html).not.toContain('class="lqueue"');
    expect(html).not.toContain('class="lmove"');
  });

  test('draws a lane for every report that exists, and none for one that does not', () => {
    const view = fixtureView([quietSource({})]);

    const html = renderDashboardBackgroundPage(view, {
      now: NOW,
      backgroundRuntime: runtimeFacts([{
        id: 'whatsapp-transcribe-drain',
        name: 'Transcription',
        unit: 'items',
        reportsLive: true,
        lastActivityAt: new Date(NOW.getTime() - 20_000),
        samples: [],
      }]),
    });

    expect(html).toContain('>Transcription<');
    // No counter is verified for that lane's report, so no rate is invented.
    expect(html).toContain('rate not measured yet');
    expect(html).not.toContain('>WhatsApp live<');
    expect(html).not.toContain('>Dropbox sync drain<');
  });
});

describe('home background section', () => {
  test('gives background its own section heading and one linked card', () => {
    const view = fixtureView([scheduledSource({})], { background_work: { vlm_extraction_queued: 19 } });

    const html = renderDashboardHomePage(view, { now: NOW });

    expect(html).toContain('<div class="sect">Background</div>');
    expect(html).toContain('class="bgrow"');
    expect(html).toContain('href="/dashboard?background"');
    expect(html).toContain('>Vision<');
    expect(html).toContain('>Syncs<');
    // The old grey background footnote is gone; the one .foot left on home is
    // the always-present way to the setup page.
    expect(html).not.toContain('Background:');
    expect(html).toContain('Connect more sources');
  });

  test('keeps the caller-supplied query prefix on the background link', () => {
    const view = fixtureView([scheduledSource({})]);

    const html = renderDashboardHomePage(view, { now: NOW, basePath: '/dashboard?view=all' });

    expect(html).toMatch(/\/dashboard\?view=all(&|&amp;)background/);
  });

  test('renders no background section when no lane reports', () => {
    const view = fixtureView([quietSource({})]);

    const html = renderDashboardHomePage(view, { now: NOW });

    // The nav's Background tab stays — the SECTION is what comes down.
    expect(html).not.toContain('<div class="sect">Background</div>');
    expect(html).not.toContain('class="bgrow"');
  });

  test('carries a lane bar into the home card only where progress is measurable', () => {
    const view = fixtureView([quietSource({})], {
      background_work: {
        embedding_backlog: { chunks: 1_000, embedded_chunks: 490, missing_chunks: 510, refresh_needed: false },
        vlm_extraction_queued: 19,
      },
    });

    const html = renderDashboardHomePage(view, { now: NOW });

    // One bar: the embedding lane. Vision has a queue and no denominator.
    expect(html.split('class="minibar"').length - 1).toBe(1);
    expect(html).toContain('width:49%');
  });
});

/** What the worker would have read off the lane report files. */
function runtimeFacts(lanes: BackgroundLaneRuntime[]): BackgroundRuntimeFacts {
  return { lanes, guardActions: [] };
}

/** The embedding drain, working: two samples five minutes apart, 6,200 chunks. */
function movingEmbeddingLane(): BackgroundLaneRuntime {
  return {
    id: 'embedding-drain',
    name: 'Embedding drain',
    unit: 'chunks',
    reportsLive: true,
    lastActivityAt: new Date(NOW.getTime() - 8_000),
    samples: [
      { at: new Date(NOW.getTime() - 5 * 60_000), count: 100_000, heartbeatSeq: 1 },
      { at: NOW, count: 106_200, heartbeatSeq: 2 },
    ],
    phase: 'embedding',
  };
}

function fixtureView(
  sources: DashboardSourceCard[],
  extra?: Partial<SourceDashboardViewModel>,
): SourceDashboardViewModel {
  const connected = sources.filter((source) => source.configured).length;
  return {
    kind: 'source_dashboard',
    generated_at: GENERATED_AT,
    summary: {
      configured_sources: sources.length,
      connected_sources: connected,
      answer_ready_sources: sources.filter((source) => source.answer_readiness.state === 'ready').length,
      needs_attention_sources: sources.filter((source) => source.answer_readiness.state === 'needs_attention').length,
      total_indexed_items: sources.reduce((total, source) => total + source.coverage.indexed_items, 0),
      total_content_ready_items: sources.reduce((total, source) => total + source.coverage.content_ready_items, 0),
    },
    onboarding: {
      steps: [
        { id: 'connect_sources', label: 'Connect your sources', state: connected > 0 ? 'complete' : 'active' },
        { id: 'first_sync', label: 'First sync', state: connected > 0 ? 'active' : 'pending' },
        { id: 'choose_folders', label: 'Choose folders', state: 'pending' },
        { id: 'where_data_lives', label: 'Where your data lives', state: 'pending' },
        { id: 'ask_first_question', label: 'Ask your first question', state: 'pending' },
      ],
      ask_first_question: {
        enabled: connected > 0,
        label: 'Ask your first question',
        suggestion: 'What did I say about the roof last spring?',
      },
    },
    answer_lanes: [],
    where_your_data_lives: [],
    unassigned_corpora: { corpus_count: 0, indexed_items: 0, content_ready_items: 0, entries: [] },
    excluded_by_configuration: { rules: 0, prefixes: 0, items_present: 0, items_unevaluable: 0, entries: [] },
    folder_picker: { available: false, label: 'Choose folders', path: '/dashboard/dispositions', rules: 0 },
    sources,
    history: { sample_count: 0, eta_available: false },
    policy: {
      counts_only: true,
      raw_source_exposed: false,
      source_text_returned: false,
      file_names_returned: false,
      file_paths_returned: false,
      host_names_returned: false,
    },
    ...extra,
  };
}

/** Connected, current, and reporting nothing in the background. */
function quietSource(overrides: Partial<DashboardSourceCard>): DashboardSourceCard {
  const source_id = overrides.source_id ?? 'gmail.email';
  return {
    corpus_id: `internal.${source_id.split('.')[0]}`,
    source_id,
    label: overrides.label ?? 'Gmail',
    provider: source_id.split('.')[0] ?? 'gmail',
    family: 'email',
    trust_domain: 'internal',
    configured: true,
    freshness: { label: 'Last checked 12 minutes ago', hours: 0.2, threshold_hours: 26, stale: false },
    coverage: { indexed_items: 1_200, content_ready_items: 1_200, embedded_items: 3_400, needs_review_items: 0 },
    ingestion_health: {
      coverage_percent: 100,
      stuck_count: 0,
      drain_state: 'enabled',
      label: '100.0% covered; 0 stuck',
    },
    tier_composition: [
      { trust_domain: 'internal', label: 'Internal', indexed_items: 1_200, content_ready_items: 1_200 },
    ],
    queue_health: { label: 'Caught up', waiting: 0, active: 0, needs_attention: 0 },
    answer_readiness: { state: 'ready', label: 'Ready for questions' },
    connection: { state: 'synced', label: 'synced 12 minutes ago', action: { kind: 'none' }, handles: [] },
    ...overrides,
  };
}

/** A card the scheduler owns: one completed run, one run still ahead. */
function scheduledSource(overrides: Partial<DashboardSourceCard>): DashboardSourceCard {
  return {
    ...quietSource(overrides),
    last_run: {
      status: 'completed',
      started_at: '2026-07-02T11:40:00.000Z',
      completed_at: '2026-07-02T11:42:04.000Z',
      duration_seconds: 124,
      items_seen: 40,
      items_indexed: 12,
    },
    schedule: {
      running: false,
      consecutive_failures: 0,
      last_success_at: '2026-07-02T11:42:04.000Z',
      last_attempt_at: '2026-07-02T11:42:04.000Z',
      next_run_at: '2026-07-02T12:04:00.000Z',
    },
    ...overrides,
  };
}

/** The scheduler has this source in a retry loop. */
function failingSource(overrides: Partial<DashboardSourceCard>): DashboardSourceCard {
  return {
    ...scheduledSource(overrides),
    last_run: {
      status: 'failed',
      started_at: '2026-07-02T11:44:00.000Z',
      completed_at: '2026-07-02T11:44:28.000Z',
      duration_seconds: 28,
      items_seen: 0,
      items_indexed: 0,
    },
    schedule: {
      running: false,
      consecutive_failures: 3,
      last_attempt_at: '2026-07-02T11:44:28.000Z',
      next_run_at: '2026-07-02T12:15:00.000Z',
      last_error_kind: 'provider_rate_limited',
    },
    queue_health: { label: 'Needs attention', waiting: 0, active: 0, needs_attention: 2, retrying_tasks: 1 },
    ...overrides,
  };
}

/** A held extractor drain, with stuck items behind it. */
function drainingSource(overrides: Partial<DashboardSourceCard>): DashboardSourceCard {
  return {
    ...quietSource(overrides),
    ingestion_health: {
      coverage_percent: 87.4,
      stuck_count: 12,
      oldest_stuck_age_hours: 3.1,
      last_drain_activity_hours: 0.4,
      drain_state: 'held',
      drain_unit: 'olympus-source-processing-supervisor-vlm-pdf.timer',
      label: '87.4% covered; 12 stuck; oldest 3.1h; last drain 0.4h ago',
    },
    vlm_extraction_queued: 4,
    ...overrides,
  };
}
