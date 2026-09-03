/**
 * The lane-state law, tested at the level it is decided: rate from real samples,
 * one state per lane, a mechanical stuck rule, and banners that stay silent for
 * anything the system is already fixing.
 */
import { describe, expect, test } from 'bun:test';
import {
  LANE_RATE_MIN_WINDOW_MS,
  LANE_STUCK_GRACE_MS,
  armLaneBanners,
  computeLaneRate,
  deriveLaneState,
  type DashboardLaneCounterSample,
  type DashboardLaneEvidence,
} from '../src/workers/dashboard/lane-state.ts';

const NOW = new Date('2026-08-24T12:00:00.000Z');

/** A sample that many minutes before NOW, carrying `count`. */
function sample(minutesAgo: number, count: number, heartbeatSeq?: number): DashboardLaneCounterSample {
  return {
    at: new Date(NOW.getTime() - minutesAgo * 60_000),
    count,
    ...(heartbeatSeq === undefined ? {} : { heartbeatSeq }),
  };
}

describe('lane rate', () => {
  test('measures the trailing slope in the lane own units', () => {
    const rate = computeLaneRate([sample(5, 100_000), sample(0, 106_200)], {
      unit: 'chunks',
      now: NOW,
    });

    expect(rate?.perMinute).toBeCloseTo(1240, 5);
    expect(rate?.text).toBe('1,240 chunks/min');
    expect(rate?.windowMs).toBe(5 * 60_000);
  });

  test('reports a measured zero rather than swallowing it as no data', () => {
    // This is the number the stuck detector reads; undefined here would make a
    // frozen counter indistinguishable from a lane nobody has sampled yet.
    const rate = computeLaneRate([sample(12, 88_000), sample(0, 88_000)], {
      unit: 'chunks',
      now: NOW,
    });

    expect(rate?.perMinute).toBe(0);
    expect(rate?.text).toBe('0 chunks/min');
  });

  test('claims no rate from a single reading', () => {
    expect(computeLaneRate([sample(0, 12)], { unit: 'chunks', now: NOW })).toBeUndefined();
    expect(computeLaneRate([], { unit: 'chunks', now: NOW })).toBeUndefined();
    expect(computeLaneRate(undefined, { unit: 'chunks', now: NOW })).toBeUndefined();
  });

  test('claims no rate across a span too short to mean anything', () => {
    const tooClose = computeLaneRate(
      [sample(0.25, 100), sample(0, 400)],
      { unit: 'chunks', now: NOW },
    );

    expect(LANE_RATE_MIN_WINDOW_MS).toBe(45_000);
    expect(tooClose).toBeUndefined();
  });

  test('collapses two readings of the same heartbeat into one observation', () => {
    // A poll loop re-reading a frozen report must not manufacture a window.
    const rate = computeLaneRate(
      [sample(6, 5_000, 41), sample(0, 5_000, 41)],
      { unit: 'chunks', now: NOW },
    );

    expect(rate).toBeUndefined();
  });

  test('starts over at a counter reset instead of reporting a lane running backwards', () => {
    // The drains publish cumulative-per-process counters, so a restart drops the
    // count to near zero. Differencing across that would print a negative rate.
    const rate = computeLaneRate(
      [sample(10, 900_000, 1), sample(6, 1_200, 2), sample(0, 7_200, 3)],
      { unit: 'chunks', now: NOW },
    );

    expect(rate?.perMinute).toBeCloseTo(1000, 5);
  });

  test('ignores samples that fell out of the trailing window', () => {
    const rate = computeLaneRate(
      [sample(120, 0, 1), sample(4, 10_000, 2), sample(0, 14_000, 3)],
      { unit: 'chunks', now: NOW },
    );

    expect(rate?.windowMs).toBe(4 * 60_000);
    expect(rate?.perMinute).toBeCloseTo(1000, 5);
  });
});

describe('lane state derivation', () => {
  test('calls a lane with a climbing counter active, with rate and ETA', () => {
    const status = deriveLaneState({
      name: 'Embeddings',
      unit: 'chunks',
      samples: [sample(5, 100_000), sample(0, 106_200)],
      lastActivityAt: new Date(NOW.getTime() - 8_000),
      remaining: 12_400,
      reportsLive: true,
    }, NOW);

    expect(status.kind).toBe('active');
    expect(status.rate?.text).toBe('1,240 chunks/min');
    expect(status.etaMs).toBeCloseTo(10 * 60_000, 0);
    expect(status.sinceActivityMs).toBe(8_000);
    expect(status.stuck).toBeUndefined();
  });

  test('quotes the governing condition verbatim and names who decided it', () => {
    const status = deriveLaneState({
      name: 'Embeddings',
      unit: 'chunks',
      remaining: 129_948,
      governing: {
        text: 'metadata frontier pending',
        decidedBy: 'the overnight guard',
      },
    }, NOW);

    expect(status.kind).toBe('waiting');
    // Verbatim: not reworded, not summarised, not prefixed.
    expect(status.reason).toBe('metadata frontier pending');
    expect(status.reasonBy).toBe('the overnight guard');
  });

  test('keeps calling a lane active while its counter climbs, even under a park line', () => {
    // The guard parked it a moment ago and it is still finishing a batch.
    // Reporting it parked while the number moves is the same class of lie as
    // reporting it running when it is dead.
    const status = deriveLaneState({
      name: 'Embeddings',
      unit: 'chunks',
      samples: [sample(5, 10_000), sample(0, 16_200)],
      remaining: 400,
      governing: { text: 'metadata sync active', decidedBy: 'the overnight guard' },
      reportsLive: true,
      lastActivityAt: NOW,
    }, NOW);

    expect(status.kind).toBe('active');
  });

  test('collapses a lane with nothing outstanding to done', () => {
    const status = deriveLaneState({
      name: 'Vision',
      unit: 'jobs',
      remaining: 0,
    }, NOW);

    expect(status.kind).toBe('done');
  });

  test('an unknown lane stays unknown and never borrows a state word', () => {
    const status = deriveLaneState({
      name: 'Embeddings',
      unit: 'chunks',
      remaining: 129_948,
    }, NOW);

    expect(status.kind).toBe('unknown');
    expect(status.headline).toBe('Embeddings: state unknown');
    expect(status.unknownWhy).toBeDefined();
    // The fabricated-state regression, at the source: the sentence that exists
    // to say there is no state must not contain a state word.
    expect(status.unknownWhy).not.toContain('parked');
    expect(status.unknownWhy).not.toContain('running');
    expect(status.unknownWhy).not.toContain('scheduled');
    expect(status.reason).toBeUndefined();
  });

  test('says which gap it is when a lane has reported exactly once', () => {
    const status = deriveLaneState({
      name: 'Telegram sync',
      unit: 'messages',
      samples: [sample(0, 4_100)],
      remaining: 12,
    }, NOW);

    expect(status.kind).toBe('unknown');
    expect(status.unknownWhy).toContain('reported only once');
  });
});

describe('stuck detection', () => {
  test('catches a lane that claims to be running while its heartbeat stopped', () => {
    const status = deriveLaneState({
      name: 'Embeddings',
      unit: 'chunks',
      lastActivityAt: new Date(NOW.getTime() - 22 * 60_000),
      remaining: 129_948,
      reportsLive: true,
    }, NOW);

    expect(status.stuck?.kind).toBe('heartbeat_stale');
    expect(status.stuck?.words).toContain('says it is running');
    expect(status.stuck?.words).toContain('22 minutes');
  });

  test('catches a measured zero rate with work still outstanding', () => {
    const status = deriveLaneState({
      name: 'Embeddings',
      unit: 'chunks',
      // Heartbeats keep arriving — the lane is alive — but the counter has not
      // moved in twelve minutes.
      samples: [sample(12, 88_000, 1), sample(6, 88_000, 2), sample(0, 88_000, 3)],
      lastActivityAt: NOW,
      remaining: 41_948,
      reportsLive: true,
    }, NOW);

    expect(status.stuck?.kind).toBe('rate_zero_with_work');
    expect(status.stuck?.words).toContain('41,948 chunks left');
    expect(status.stuck?.words).toContain('12 minutes');
  });

  test('does not call a zero rate stuck before the grace window is spent', () => {
    const status = deriveLaneState({
      name: 'Embeddings',
      unit: 'chunks',
      samples: [sample(3, 88_000, 1), sample(0, 88_000, 2)],
      lastActivityAt: NOW,
      remaining: 41_948,
      reportsLive: true,
    }, NOW);

    expect(LANE_STUCK_GRACE_MS).toBe(10 * 60 * 1000);
    expect(status.stuck).toBeUndefined();
  });

  test('does not call a zero rate stuck when there is no work left to do', () => {
    const status = deriveLaneState({
      name: 'Embeddings',
      unit: 'chunks',
      samples: [sample(12, 88_000, 1), sample(0, 88_000, 2)],
      lastActivityAt: NOW,
      remaining: 0,
      reportsLive: true,
    }, NOW);

    expect(status.stuck).toBeUndefined();
  });

  test('never calls a lane stuck while a governing condition explains it', () => {
    // A parked lane not moving is the system working as designed. Banner-ing it
    // is how a banner stops being read.
    const status = deriveLaneState({
      name: 'Embeddings',
      unit: 'chunks',
      samples: [sample(12, 88_000, 1), sample(0, 88_000, 2)],
      lastActivityAt: new Date(NOW.getTime() - 40 * 60_000),
      remaining: 41_948,
      reportsLive: true,
      governing: { text: 'metadata frontier pending', decidedBy: 'the overnight guard' },
    }, NOW);

    expect(status.kind).toBe('waiting');
    expect(status.stuck).toBeUndefined();
  });

  test('does not call a lane stuck that never claimed to be running', () => {
    const status = deriveLaneState({
      name: 'Transcription',
      unit: 'items',
      lastActivityAt: new Date(NOW.getTime() - 6 * 60 * 60_000),
      reportsLive: false,
    }, NOW);

    expect(status.stuck).toBeUndefined();
    expect(status.kind).toBe('unknown');
  });

  test('carries the last governing condition into the stuck finding', () => {
    const evidence: DashboardLaneEvidence = {
      name: 'Embeddings',
      unit: 'chunks',
      lastActivityAt: new Date(NOW.getTime() - 30 * 60_000),
      remaining: 12,
      reportsLive: true,
    };
    // The same lane, once with a heartbeat inside the window and once outside,
    // proves the rule is the heartbeat and not the presence of a reason.
    const fresh = deriveLaneState({ ...evidence, lastActivityAt: NOW }, NOW);
    const stale = deriveLaneState(evidence, NOW);

    expect(fresh.stuck).toBeUndefined();
    expect(stale.stuck?.kind).toBe('heartbeat_stale');
  });

  /**
   * The negative control for the whole detector.
   *
   * Same evidence, with the two thresholds widened past the fault: if the
   * assertions above were passing on incidental page text rather than on the
   * detector, this would still report stuck.
   */
  test('finds nothing stuck in the same evidence when the rules are not applied', () => {
    const evidence: DashboardLaneEvidence = {
      name: 'Embeddings',
      unit: 'chunks',
      samples: [sample(12, 88_000, 1), sample(0, 88_000, 2)],
      lastActivityAt: new Date(NOW.getTime() - 22 * 60_000),
      remaining: 41_948,
      reportsLive: true,
    };

    expect(deriveLaneState(evidence, NOW).stuck).toBeDefined();
    expect(deriveLaneState({
      ...evidence,
      heartbeatStaleAfterMs: 24 * 60 * 60_000,
      stuckGraceMs: 24 * 60 * 60_000,
    }, NOW).stuck).toBeUndefined();
  });
});

describe('banner arming', () => {
  test('arms one banner per stuck lane and nothing else', () => {
    const stuck = deriveLaneState({
      name: 'Embeddings',
      unit: 'chunks',
      lastActivityAt: new Date(NOW.getTime() - 30 * 60_000),
      remaining: 400,
      reportsLive: true,
    }, NOW);
    const fine = deriveLaneState({ name: 'Vision', unit: 'jobs', remaining: 0 }, NOW);

    const banners = armLaneBanners({
      lanes: [{ name: 'Embeddings', status: stuck }, { name: 'Vision', status: fine }],
    });

    expect(banners.length).toBe(1);
    expect(banners[0]?.lane).toBe('Embeddings');
  });

  test('arms nothing at all when every lane is moving or explained', () => {
    const active = deriveLaneState({
      name: 'Embeddings',
      unit: 'chunks',
      samples: [sample(5, 1_000), sample(0, 7_200)],
      lastActivityAt: NOW,
      reportsLive: true,
    }, NOW);
    const waiting = deriveLaneState({
      name: 'Syncs',
      unit: 'items',
      remaining: 40,
      governing: { text: 'next: Gmail in 4m', decidedBy: 'the scheduler' },
    }, NOW);

    const banners = armLaneBanners({
      lanes: [{ name: 'Embeddings', status: active }, { name: 'Syncs', status: waiting }],
    });

    expect(banners).toEqual([]);
  });

  test('carries a condition that needs a person, with the way to act on it', () => {
    const fine = deriveLaneState({ name: 'Vision', unit: 'jobs', remaining: 0 }, NOW);

    const banners = armLaneBanners({
      lanes: [{ name: 'Vision', status: fine }],
      actionable: [{
        lane: 'Vision',
        words: 'Extraction is held on Gmail.',
        href: '/dashboard?source=gmail.email',
        hrefLabel: 'Open Gmail →',
      }],
    });

    expect(banners.length).toBe(1);
    expect(banners[0]?.words).toBe('Extraction is held on Gmail.');
    expect(banners[0]?.href).toBe('/dashboard?source=gmail.email');
  });

  test('puts the stuck lanes ahead of the conditions that need a person', () => {
    const stuck = deriveLaneState({
      name: 'Embeddings',
      unit: 'chunks',
      lastActivityAt: new Date(NOW.getTime() - 30 * 60_000),
      remaining: 400,
      reportsLive: true,
    }, NOW);

    const banners = armLaneBanners({
      lanes: [{ name: 'Embeddings', status: stuck }],
      actionable: [{ lane: 'Vision', words: 'Extraction is held on Gmail.' }],
    });

    expect(banners.map((banner) => banner.lane)).toEqual(['Embeddings', 'Vision']);
  });
});
