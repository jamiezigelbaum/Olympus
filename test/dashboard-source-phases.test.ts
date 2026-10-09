/**
 * The 2026-08-24 source-page redesign: three phases, three bars, one banner.
 *
 * Every rule the owner set in that design session is pinned here — the units
 * each phase counts in, the indeterminate bar for an unknown denominator, the
 * delta scoping that keeps three new files out of a 99.99%, the settled state
 * that takes the bars down, the two-plus-one banner classes, and the silence
 * that everything self-healing gets.
 */
import { describe, expect, test } from 'bun:test';
import { dashboardSourceProgress } from '../src/workers/dashboard/phases.ts';
import { dashboardSubLine } from '../src/workers/dashboard/vocabulary.ts';
import {
  DASHBOARD_SUPPORTED_SOURCES,
  type DashboardSourceCard,
} from '../src/workers/source-dashboard.ts';
import type { WorkerCredentialDegradation } from '../src/workers/credential-degradation.ts';

const NOW = new Date('2026-07-02T12:00:00.000Z');

describe('phase model units', () => {
  test('a bounded completed pass is not treated as a completed provider traversal', () => {
    const source = settledCard({
      last_run: {
        status: 'completed',
        items_seen: 200,
        items_indexed: 200,
        traversal_complete: false,
      },
    });
    const progress = dashboardSourceProgress(source);
    expect(progress.settled).toBe(false);
    expect(progress.phases[0]?.scope).toBe('corpus');
  });

  test('pending and explicitly empty scopes never present retained corpus work as active', () => {
    const pending = dashboardSourceProgress(settledCard({
      scope_selection: { required: true, connected: true, status: 'scope_pending', ingestion_enabled: false },
    }));
    expect(pending.settled).toBe(false);
    expect(pending.phases.every((phase) => phase.state === 'waiting')).toBe(true);
    expect(pending.phases.every((phase) => phase.measure.kind === 'indeterminate')).toBe(true);

    const disabled = dashboardSourceProgress(settledCard({
      scope_selection: { required: true, connected: true, status: 'approved', ingestion_enabled: false },
    }));
    expect(disabled.settled).toBe(false);
    expect(disabled.phases.map((phase) => phase.state_words))
      .toEqual(['Waiting · ingestion is off', 'Waiting · ingestion is off', 'Waiting · ingestion is off']);
  });

  test('counts each phase in its own unit and never folds one into another', () => {
    const progress = dashboardSourceProgress(settledPassCard({
      metadata_sync: {
        folders_total: 4_000,
        folders_visited: 3_000,
        folders_pending: 1_000,
        folders_failed: 0,
        folders_blocked: 0,
      },
      coverage: {
        indexed_items: 27_000,
        content_ready_items: 20_000,
        embedded_items: 0,
        embedded_files: 10_000,
        needs_review_items: 0,
        answer_ready_eligible_items: 27_000,
      },
      embedding_backlog: { chunks: 500_000, embedded_chunks: 250_000, missing_chunks: 250_000, refresh_needed: false },
    }));

    // Sync counts the walk in folders; extraction and embedding both count the
    // source's own items, because the waterfall only holds when the two lower
    // bars are denominated in the same population (owner ruling, 2026-09-01:
    // embedding is measured in items, never in chunks).
    expect(progress.phases.map((phase) => [phase.id, phase.unit])).toEqual([
      ['metadata_sync', 'folders'],
      ['extraction', 'files'],
      ['embedding', 'files'],
    ]);
    expect(progress.phases.map((phase) => phase.measure)).toEqual([
      { kind: 'ratio', done: 3_000, total: 4_000, percent: 75 },
      { kind: 'ratio', done: 20_000, total: 27_000, percent: 74.1 },
      // The store publishes a per-item count, so the embedding row is that
      // count over the same item population. The 250,000 embedded chunks sitting
      // beside it are never folded into a file figure.
      { kind: 'ratio', done: 10_000, total: 27_000, percent: 37 },
    ]);
    expect(progress.phases.find((phase) => phase.id === 'embedding')?.unmeasured).toBeUndefined();
  });

  test('counts a message source in messages and never in files', () => {
    // Owner note, 2026-09-01: Gmail was counting "files". The noun comes off
    // the family, and both content phases use the same one.
    const progress = dashboardSourceProgress(settledPassCard({
      corpus_id: 'secure_local.gmail.email',
      source_id: 'gmail.email',
      label: 'Gmail',
      provider: 'google',
      family: 'email',
      coverage: {
        indexed_items: 9_000,
        content_ready_items: 6_000,
        embedded_items: 0,
        embedded_files: 4_000,
        needs_review_items: 0,
        answer_ready_eligible_items: 9_000,
      },
    }));

    expect(progress.phases.map((phase) => phase.unit)).toEqual(['messages', 'messages', 'messages']);
  });

  test('divides extraction by the eligible population, not by everything indexed', () => {
    // 247,712 indexed, 234,900 of them never to be read by policy. The bar must
    // divide by the 12,812 the system is asked to handle, or a Dropbox that
    // reads every file it is meant to read renders as 5%.
    const progress = dashboardSourceProgress(settledPassCard({
      coverage: {
        indexed_items: 247_712,
        content_ready_items: 12_431,
        embedded_items: 0,
        needs_review_items: 0,
        not_read_by_policy_items: 234_900,
        answer_ready_eligible_items: 12_812,
      },
    }));

    const extraction = progress.phases.find((phase) => phase.id === 'extraction');
    expect(extraction?.measure).toEqual({ kind: 'ratio', done: 12_431, total: 12_812, percent: 97 });
  });
});

describe('embedding waterfall', () => {
  // The defect this replaced the three-tone bar for: Drive read 95% embedded
  // at 50% extracted, because embedding counted chunks of the files that HAD
  // been read while extraction counted files. Same unit, same population, and
  // the numerator clamped to what extraction has read, is what stops it.
  test('never lets a complete current chunk set outrun partial extraction', () => {
    const progress = dashboardSourceProgress(settledPassCard({
      coverage: {
        indexed_items: 100,
        content_ready_items: 50,
        embedded_items: 1_000,
        embedded_files: 50,
        needs_review_items: 0,
        answer_ready_eligible_items: 100,
      },
      embedding_backlog: {
        chunks: 1_000,
        embedded_chunks: 1_000,
        missing_chunks: 0,
        refresh_needed: false,
      },
    }));

    const extraction = progress.phases.find((phase) => phase.id === 'extraction');
    const embedding = progress.phases.find((phase) => phase.id === 'embedding');
    expect(extraction?.measure).toEqual({ kind: 'ratio', done: 50, total: 100, percent: 50 });
    // Every chunk of every read file is embedded, and that is still only half
    // the corpus: the bar reads 50%, not 100%.
    expect(embedding?.measure).toEqual({ kind: 'ratio', done: 50, total: 100, percent: 50 });
    expect(embedding?.unit).toBe(extraction?.unit);
  });

  test('clamps a measured per-item count to what extraction has read', () => {
    // A store that reports more embedded items than read items is wrong; the
    // bar must not be the place that wrongness first shows as progress.
    const progress = dashboardSourceProgress(settledPassCard({
      coverage: {
        indexed_items: 100,
        content_ready_items: 50,
        embedded_items: 0,
        embedded_files: 90,
        needs_review_items: 0,
        answer_ready_eligible_items: 100,
      },
    }));

    expect(progress.phases.find((phase) => phase.id === 'embedding')?.measure)
      .toEqual({ kind: 'ratio', done: 50, total: 100, percent: 50 });
  });

  test('a store that publishes no per-item count leaves the row unmeasured', () => {
    const progress = dashboardSourceProgress(settledPassCard({
      coverage: {
        indexed_items: 100,
        content_ready_items: 50,
        embedded_items: 800,
        needs_review_items: 0,
        answer_ready_eligible_items: 100,
      },
      embedding_backlog: {
        chunks: 1_000,
        embedded_chunks: 800,
        missing_chunks: 200,
        refresh_needed: true,
      },
    }));

    const embedding = progress.phases.find((phase) => phase.id === 'embedding');
    // The numerator is unknown, not zero and not derived: one 901-chunk file
    // beside 99 one-chunk files would have read as 40 embedded files.
    expect(embedding?.measure).toEqual({ kind: 'indeterminate', done: 0 });
    expect(embedding?.unmeasured).toBe(true);
    expect(embedding?.state).toBe('waiting');
    expect(embedding?.state_words).toBe('Not measured by this store');
  });

  test('a chunk backlog alone never produces a percentage', () => {
    // Every shape of chunk parity — none, some, all — leaves the item figure
    // unknown while the store publishes no per-item count.
    for (const embedded_chunks of [0, 800, 1_000]) {
      const progress = dashboardSourceProgress(settledPassCard({
        coverage: {
          indexed_items: 100,
          content_ready_items: 50,
          embedded_items: embedded_chunks,
          needs_review_items: 0,
          answer_ready_eligible_items: 100,
        },
        embedding_backlog: {
          chunks: 1_000,
          embedded_chunks,
          missing_chunks: 1_000 - embedded_chunks,
          refresh_needed: embedded_chunks < 1_000,
        },
      }));

      const embedding = progress.phases.find((phase) => phase.id === 'embedding');
      expect(embedding?.measure.kind).toBe('indeterminate');
      expect(embedding?.measure).not.toHaveProperty('percent');
      expect(embedding?.unmeasured).toBe(true);
    }
  });

  test('prefers the store\'s measured per-item count over chunk parity', () => {
    const progress = dashboardSourceProgress(settledPassCard({
      coverage: {
        indexed_items: 100,
        content_ready_items: 50,
        embedded_items: 800,
        embedded_files: 31,
        needs_review_items: 0,
        answer_ready_eligible_items: 100,
      },
      embedding_backlog: {
        chunks: 1_000,
        embedded_chunks: 800,
        missing_chunks: 200,
        refresh_needed: true,
      },
    }));

    const embedding = progress.phases.find((phase) => phase.id === 'embedding');
    expect(embedding?.measure).toEqual({ kind: 'ratio', done: 31, total: 100, percent: 31 });
    expect(embedding?.unmeasured).toBeUndefined();
  });

  test('a keyword-only source says the stage does not apply and still settles', () => {
    const progress = dashboardSourceProgress(settledPassCard({
      embedding_required: false,
      coverage: {
        indexed_items: 100,
        content_ready_items: 100,
        embedded_items: 0,
        needs_review_items: 0,
        answer_ready_eligible_items: 100,
      },
    }));

    const embedding = progress.phases.find((phase) => phase.id === 'embedding');
    expect(embedding?.not_applicable).toBe(true);
    expect(embedding?.state).toBe('done');
    expect(embedding?.state_words).toBe('Not needed · keyword search only');
    expect(progress.settled).toBe(true);
  });
});

describe('every source shows all three rows', () => {
  test('renders the three phases in pipeline order whatever the source has done', () => {
    for (const card of [firstIngestCard(), settledPassCard(), settledCard()]) {
      expect(dashboardSourceProgress(card, { now: NOW }).phases.map((phase) => phase.id))
        .toEqual(['metadata_sync', 'extraction', 'embedding']);
    }
  });
});

// The one word a row carries about motion. It is decided by the counter's own
// last rise where the history records one, because that is the only evidence
// that is about THIS phase rather than about the source as a whole.
describe('phase state words', () => {
  const partlyRead = {
    coverage: {
      indexed_items: 100,
      content_ready_items: 50,
      embedded_items: 0,
      embedded_files: 20,
      needs_review_items: 0,
      answer_ready_eligible_items: 100,
    },
  };

  test('a counter that rose inside the stall window is working, and says when', () => {
    const progress = dashboardSourceProgress(settledPassCard({
      ...partlyRead,
      movement: { extraction_at: new Date(NOW.getTime() - 40_000).toISOString() },
    }), { now: NOW });

    expect(progress.phases.find((phase) => phase.id === 'extraction')?.state).toBe('working');
    expect(progress.phases.find((phase) => phase.id === 'extraction')?.state_words)
      .toBe('Working · moved 40s ago');
  });

  test('a counter still for longer than the window is stalled, and says how long', () => {
    const progress = dashboardSourceProgress(settledPassCard({
      ...partlyRead,
      movement: { extraction_at: new Date(NOW.getTime() - 30 * 3_600_000).toISOString() },
    }), { now: NOW });

    const extraction = progress.phases.find((phase) => phase.id === 'extraction');
    expect(extraction?.state).toBe('stalled');
    expect(extraction?.state_words).toBe('Stalled · nothing moved for 1d 6h');
  });

  test('measured stillness outranks a lane reporting itself live', () => {
    // The counter has not moved for 30 hours and the queue says it is working
    // right now. The counter is the measurement and the flag is the claim: the
    // row is stalled, and the contradiction is printed rather than believed.
    const progress = dashboardSourceProgress(settledPassCard({
      ...partlyRead,
      movement: { extraction_at: new Date(NOW.getTime() - 30 * 3_600_000).toISOString() },
      queue_health: { label: 'Working now', waiting: 40, active: 3, needs_attention: 0 },
    }), { now: NOW });

    const extraction = progress.phases.find((phase) => phase.id === 'extraction');
    expect(extraction?.state).toBe('stalled');
    expect(extraction?.state_words).toBe('Stalled · nothing moved for 1d 6h · lane reports running');
  });

  test('a completed metadata traversal stays complete while the next check is scheduled', () => {
    const progress = dashboardSourceProgress(settledPassCard({
      last_run: { status: 'completed', traversal_complete: true, items_seen: 4806, items_indexed: 4806 },
      schedule: { running: false, consecutive_failures: 0, next_run_at: new Date(NOW.getTime() + 29 * 60_000).toISOString() },
    }), { now: NOW });
    expect(progress.phases[0]?.state).toBe('done');
    expect(progress.phases[0]?.state_words).toBe('Complete · next check in 29m');
  });

  test('a sync scheduled inside the hour is waiting, not stalled', () => {
    const progress = dashboardSourceProgress(settledPassCard({
      ...partlyRead,
      // A half-walked tree: the sync row has open work to be waiting on.
      metadata_sync: {
        folders_total: 100,
        folders_visited: 50,
        folders_pending: 50,
        folders_failed: 0,
        folders_blocked: 0,
      },
      schedule: {
        running: false,
        consecutive_failures: 0,
        next_run_at: new Date(NOW.getTime() + 12 * 60_000).toISOString(),
      },
    }), { now: NOW });

    const sync = progress.phases.find((phase) => phase.id === 'metadata_sync');
    expect(sync?.state_words).toBe('Waiting · next sync in 12m');
  });

  test('a stalled row names the condition that is holding it, when one is known', () => {
    const disabled = dashboardSourceProgress(settledPassCard({
      ...partlyRead,
      embedding_lane_state: 'embedding_lane_disabled',
    }), { now: NOW });
    const held = dashboardSourceProgress(settledPassCard({
      ...partlyRead,
      ingestion_health: {
        coverage_percent: 50,
        stuck_count: 0,
        drain_state: 'held',
        label: '50% covered; nothing stuck',
      },
    }), { now: NOW });
    const failing = dashboardSourceProgress(settledPassCard({
      ...partlyRead,
      metadata_sync: {
        folders_total: 100,
        folders_visited: 50,
        folders_pending: 50,
        folders_failed: 0,
        folders_blocked: 0,
      },
      schedule: { running: false, consecutive_failures: 3 },
    }), { now: NOW });

    expect(disabled.phases.find((phase) => phase.id === 'embedding')?.state_words)
      .toBe('Stalled · embedding lane is switched off');
    expect(held.phases.find((phase) => phase.id === 'extraction')?.state_words)
      .toBe('Stalled · extraction lane is switched off');
    expect(failing.phases.find((phase) => phase.id === 'metadata_sync')?.state_words)
      .toBe('Stalled · last 3 syncs failed');
  });
});

describe('phase model indeterminate state', () => {
  test('draws an indeterminate sync bar while a first walk has not sized the tree', () => {
    const progress = dashboardSourceProgress(firstIngestCard({
      metadata_sync: {
        folders_total: 0,
        folders_visited: 812,
        folders_pending: 40,
        folders_failed: 0,
        folders_blocked: 0,
      },
    }));

    const sync = progress.phases.find((phase) => phase.id === 'metadata_sync');
    expect(sync?.measure).toEqual({ kind: 'indeterminate', done: 812 });
    expect(sync?.denominator_unavailable).toBe(true);
    expect(progress.settled).toBe(false);
  });

  test('counts discovered items instead when the source has no walk to report', () => {
    const progress = dashboardSourceProgress(firstIngestCard());

    const sync = progress.phases.find((phase) => phase.id === 'metadata_sync');
    expect(sync?.unit).toBe('files');
    expect(sync?.measure).toEqual({ kind: 'indeterminate', done: 4_806 });
  });

  test('never calls an indeterminate phase complete', () => {
    // Embedded chunks with no parity gauge: a numerator and no denominator.
    // "We cannot measure it" and "there is nothing left" are different
    // sentences, and only the second may take the bars down.
    const progress = dashboardSourceProgress(settledPassCard({
      coverage: {
        indexed_items: 100,
        content_ready_items: 100,
        embedded_items: 4_000,
        needs_review_items: 0,
        answer_ready_eligible_items: 100,
      },
    }));

    const embedding = progress.phases.find((phase) => phase.id === 'embedding');
    // No per-item count and no chunk parity: the numerator is unknown, which
    // is not the same sentence as zero and not the same sentence as done.
    expect(embedding?.measure).toEqual({ kind: 'indeterminate', done: 0 });
    expect(embedding?.denominator_unavailable).toBe(true);
    expect(progress.settled).toBe(false);
  });

});

describe('phase model delta scoping', () => {
  test('divides the current pass by the batch the settled baseline records', () => {
    const progress = dashboardSourceProgress(updatePassCard());

    // 30,000 items were settled when the batch arrived, so the pass in flight
    // is 12 new files of which 7 are read. That is the sentence the bar makes,
    // and the denominator is measured rather than missing.
    const extraction = progress.phases.find((phase) => phase.id === 'extraction');
    expect(extraction?.scope).toBe('delta');
    expect(extraction?.measure).toEqual({ kind: 'ratio', done: 7, total: 12, percent: 58.3 });
    expect(extraction?.denominator_unavailable).toBe(false);
    expect(progress.delta).toBe(true);
    expect(progress.settled).toBe(false);
  });

  test('gives the embedding row its own baseline and keeps the waterfall', () => {
    const embedding = dashboardSourceProgress(updatePassCard())
      .phases.find((phase) => phase.id === 'embedding');

    // Same batch of 12, two of them embedded: embedding trails extraction
    // inside the delta exactly as it does over the corpus.
    expect(embedding?.scope).toBe('delta');
    expect(embedding?.measure).toEqual({ kind: 'ratio', done: 2, total: 12, percent: 16.7 });
    expect(embedding?.denominator_unavailable).toBe(false);
  });

  // The baseline REPLACES the sub-half-percent heuristic: a batch is the
  // current pass whatever share of the corpus it happens to be.
  test('delta-scopes a batch far larger than the old half-percent trigger', () => {
    const progress = dashboardSourceProgress(settledPassCard({
      coverage: {
        indexed_items: 1_000,
        content_ready_items: 800,
        embedded_items: 0,
        needs_review_items: 0,
        answer_ready_eligible_items: 1_000,
      },
      movement: { extraction_settled_value: 700 },
    }));

    const extraction = progress.phases.find((phase) => phase.id === 'extraction');
    expect(extraction?.scope).toBe('delta');
    expect(extraction?.measure).toEqual({ kind: 'ratio', done: 100, total: 300, percent: 33.3 });
  });

  // NEGATIVE CHECK. A baseline the counter has since fallen below describes no
  // batch — a re-index is not new material — so the honest fallback stands.
  test('ignores a baseline the counter has fallen below', () => {
    const progress = dashboardSourceProgress(settledPassCard({
      coverage: {
        indexed_items: 27_012,
        content_ready_items: 26_997,
        embedded_items: 0,
        needs_review_items: 0,
        answer_ready_eligible_items: 27_012,
      },
      movement: { extraction_settled_value: 27_000 },
    }));

    const extraction = progress.phases.find((phase) => phase.id === 'extraction');
    expect(extraction?.measure).toEqual({ kind: 'remaining', remaining: 15 });
    expect(extraction?.denominator_unavailable).toBe(true);
  });

  // NEGATIVE CHECK. A baseline at or above the current total leaves no batch to
  // divide by, and a zero denominator may never be invented.
  test('ignores a baseline that leaves no batch behind it', () => {
    const progress = dashboardSourceProgress(settledPassCard({
      coverage: {
        indexed_items: 27_000,
        content_ready_items: 26_997,
        embedded_items: 0,
        needs_review_items: 0,
        answer_ready_eligible_items: 27_000,
      },
      movement: { extraction_settled_value: 27_000 },
    }));

    expect(progress.phases.find((phase) => phase.id === 'extraction')?.measure)
      .toEqual({ kind: 'remaining', remaining: 3 });
  });

  // NEGATIVE CHECK. A first crawl has no settled pass, so a stray baseline on
  // the card cannot turn one into a delta.
  test('never uses a baseline on a source that has not finished a pass', () => {
    const progress = dashboardSourceProgress(firstIngestCard({
      coverage: {
        indexed_items: 30_012,
        content_ready_items: 30_007,
        embedded_items: 0,
        needs_review_items: 0,
        answer_ready_eligible_items: 30_012,
      },
      movement: { extraction_settled_value: 30_000 },
    }));

    expect(progress.delta).toBe(false);
    expect(progress.phases.find((phase) => phase.id === 'extraction')?.scope).toBe('corpus');
  });

  test('scopes a settled corpus to the delta rather than rendering 99.99%', () => {
    const progress = dashboardSourceProgress(settledPassCard({
      coverage: {
        indexed_items: 27_000,
        content_ready_items: 26_997,
        embedded_items: 0,
        needs_review_items: 0,
        answer_ready_eligible_items: 27_000,
      },
    }));

    const extraction = progress.phases.find((phase) => phase.id === 'extraction');
    expect(extraction?.scope).toBe('delta');
    expect(extraction?.measure).toEqual({ kind: 'remaining', remaining: 3 });
    // The ruling's own instruction for a delta with no derivable denominator.
    expect(extraction?.denominator_unavailable).toBe(true);
    expect(progress.delta).toBe(true);
  });

  // NEGATIVE CHECK. Delta scoping exists to stop a percentage lying; it must
  // not swallow a percentage that is telling the truth.
  test('leaves a real corpus-wide shortfall as a corpus-wide percentage', () => {
    const progress = dashboardSourceProgress(settledPassCard({
      coverage: {
        indexed_items: 27_000,
        content_ready_items: 26_190,
        embedded_items: 0,
        needs_review_items: 0,
        answer_ready_eligible_items: 27_000,
      },
    }));

    const extraction = progress.phases.find((phase) => phase.id === 'extraction');
    expect(extraction?.scope).toBe('corpus');
    expect(extraction?.measure).toEqual({ kind: 'ratio', done: 26_190, total: 27_000, percent: 97 });
    expect(progress.delta).toBe(false);
  });

  // NEGATIVE CHECK. Half a percent is the boundary, and it belongs to the
  // percentage: 99.5% still distinguishes itself from 100%.
  test('holds the boundary at half a percent remaining', () => {
    const progress = dashboardSourceProgress(settledPassCard({
      coverage: {
        indexed_items: 1_000,
        content_ready_items: 995,
        embedded_items: 0,
        needs_review_items: 0,
        answer_ready_eligible_items: 1_000,
      },
    }));

    expect(progress.phases.find((phase) => phase.id === 'extraction')?.measure)
      .toEqual({ kind: 'ratio', done: 995, total: 1_000, percent: 99.5 });
  });

  // NEGATIVE CHECK. A first crawl at 99.99% is genuinely 99.99% of a first
  // crawl. Only a corpus that has settled once can have a delta at all.
  test('never delta-scopes a source that has not finished a pass', () => {
    const progress = dashboardSourceProgress(firstIngestCard({
      coverage: {
        indexed_items: 27_000,
        content_ready_items: 26_997,
        embedded_items: 0,
        needs_review_items: 0,
        answer_ready_eligible_items: 27_000,
      },
    }));

    expect(progress.delta).toBe(false);
    expect(progress.phases.find((phase) => phase.id === 'extraction')?.scope).toBe('corpus');
  });
});

describe('per-source phase applicability', () => {
  test('a source whose text arrives with the item tracks sync instead of hiding its extraction row', () => {
    const progress = dashboardSourceProgress(settledPassCard({
      label: 'Telegram',
      source_id: 'telegram.messages',
      family: 'chat',
      content_arrives_extracted: true,
      coverage: {
        indexed_items: 9_000,
        content_ready_items: 9_000,
        embedded_items: 0,
        needs_review_items: 0,
        answer_ready_eligible_items: 9_000,
      },
      embedding_backlog: { chunks: 40_000, embedded_chunks: 10_000, missing_chunks: 30_000, refresh_needed: false },
    }));

    // The row is never omitted (owner ruling, 2026-09-01): it says it tracks
    // the sync row, in the source's own noun.
    expect(progress.phases.map((phase) => phase.id)).toEqual(['metadata_sync', 'extraction', 'embedding']);
    const extraction = progress.phases.find((phase) => phase.id === 'extraction');
    const sync = progress.phases.find((phase) => phase.id === 'metadata_sync');
    expect(extraction?.tracks_sync).toBe(true);
    expect(extraction?.measure).toEqual(sync?.measure);
    expect(extraction?.unit).toBe('messages');
  });

  // The declaration is a display hint and the counts outrank it. A wrong
  // declaration is allowed to look silly; it is never allowed to hide work.
  test('shows the extraction bar anyway when the counts contradict the declaration', () => {
    const progress = dashboardSourceProgress(settledPassCard({
      content_arrives_extracted: true,
      coverage: {
        indexed_items: 9_000,
        content_ready_items: 7_000,
        embedded_items: 0,
        needs_review_items: 0,
        answer_ready_eligible_items: 9_000,
      },
    }));

    // The row is always there; what the counts decide is whether it is the
    // sync row again or extraction's own, real ratio.
    const extraction = progress.phases.find((phase) => phase.id === 'extraction');
    expect(extraction?.tracks_sync).toBeUndefined();
    expect(extraction?.measure).toEqual({ kind: 'ratio', done: 7_000, total: 9_000, percent: 77.8 });
  });

  test('applicability is declared on the definition, per capability and not per provider', () => {
    const declared = new Map(DASHBOARD_SUPPORTED_SOURCES
      .map((definition) => [definition.source_id, definition.content_arrives_extracted === true]));

    // Text arrives AS the item: a message, a bookmark, a highlight.
    expect(declared.get('telegram.messages')).toBe(true);
    expect(declared.get('whatsapp.personal.messages')).toBe(true);
    expect(declared.get('x.bookmarks')).toBe(true);
    expect(declared.get('readwise.library')).toBe(true);
    // Bytes something has to read: files, and mail with attachments.
    expect(declared.get('dropbox.files')).toBe(false);
    expect(declared.get('google_drive.docs')).toBe(false);
    expect(declared.get('gmail.email')).toBe(false);
  });
});

describe('home card', () => {
  test('leads with the working percentage', () => {
    const line = dashboardSubLine(firstIngestCard({
      coverage: {
        indexed_items: 4_812,
        content_ready_items: 400,
        embedded_items: 0,
        needs_review_items: 0,
      },
      queue_health: { label: 'Working now', waiting: 12, active: 2, needs_attention: 0 },
      answer_readiness: { state: 'syncing', label: 'Syncing now' },
      connection: { state: 'syncing', label: 'syncing', action: { kind: 'none' }, handles: [] },
    }));

    expect(line.startsWith('8% answer-ready')).toBe(true);
  });
});

/** A connected, synced card with a partly-read corpus. The shape most tests start from. */
function settledPassCard(overrides: Partial<DashboardSourceCard> = {}): DashboardSourceCard {
  return {
    corpus_id: 'secure_local.dropbox.files',
    source_id: 'dropbox.files',
    label: 'Dropbox',
    provider: 'dropbox',
    family: 'file',
    trust_domain: 'secure_local',
    configured: true,
    freshness: { label: 'Last checked 41 minutes ago', hours: 0.68, threshold_hours: 26, stale: false },
    coverage: {
      indexed_items: 4_806,
      content_ready_items: 3_201,
      embedded_items: 0,
      needs_review_items: 0,
      answer_ready_eligible_items: 4_806,
    },
    ingestion_health: {
      coverage_percent: 100,
      stuck_count: 0,
      drain_state: 'enabled',
      label: '100% covered; nothing stuck',
    },
    tier_composition: [
      { trust_domain: 'secure_local', label: 'Secure local', indexed_items: 4_806, content_ready_items: 3_201 },
    ],
    queue_health: { label: 'Caught up', waiting: 0, active: 0, needs_attention: 0 },
    answer_readiness: { state: 'ready', label: 'Ready for questions' },
    connection: {
      state: 'synced',
      label: 'synced 41 minutes ago',
      action: { kind: 'none' },
      handles: ['dropbox.personal'],
    },
    ...overrides,
  };
}

/**
 * A settled corpus of 30,000 with a batch of 12 in flight: 7 read, 2 embedded.
 *
 * The two baselines are what the movement ledger recorded at the last moment
 * each phase was complete, which is the whole of what makes "7 of 12" sayable.
 */
function updatePassCard(overrides: Partial<DashboardSourceCard> = {}): DashboardSourceCard {
  return settledPassCard({
    coverage: {
      indexed_items: 30_012,
      content_ready_items: 30_007,
      embedded_items: 0,
      embedded_files: 30_002,
      needs_review_items: 0,
      answer_ready_eligible_items: 30_012,
    },
    movement: { extraction_settled_value: 30_000, embedding_settled_value: 30_000 },
    ...overrides,
  });
}

/** The same source before it has ever finished a pass. */
function firstIngestCard(overrides: Partial<DashboardSourceCard> = {}): DashboardSourceCard {
  return settledPassCard({
    freshness: { label: 'Waiting for the first sync', stale: false },
    connection: {
      state: 'waiting_for_first_sync',
      label: 'connected, waiting for first sync',
      action: { kind: 'none' },
      handles: [],
    },
    ...overrides,
  });
}

/** Every phase complete, with a stamp for the settled line to date itself from. */
function settledCard(overrides: Partial<DashboardSourceCard> = {}): DashboardSourceCard {
  return settledPassCard({
    coverage: {
      indexed_items: 12_812,
      content_ready_items: 12_812,
      // Every in-scope file embedded on the current model — the numerator the
      // store publishes as `items_embedded`, which is what settles the third
      // bar rather than leaving it unmeasured.
      embedded_files: 12_812,
      embedded_items: 100_000,
      needs_review_items: 0,
      answer_ready_eligible_items: 12_812,
    },
    embedding_backlog: { chunks: 100_000, embedded_chunks: 100_000, missing_chunks: 0, refresh_needed: false },
    last_sync_at: '2026-07-02T11:19:00.000Z',
    ...overrides,
  });
}

/** A card carrying files that failed extraction outright. */
function terminalExtractionCard(overrides: Partial<DashboardSourceCard> = {}): DashboardSourceCard {
  return settledPassCard({
    needs_review: {
      total: 194,
      automatic_total: 0,
      operator_total: 194,
      reasons: [{
        key: 'extraction_failed',
        label: 'Extraction failed',
        count: 194,
        who_acts: 'needs_you',
        actor_note: 'retried once already, so these wait for you',
      }],
    },
    ...overrides,
  });
}

/** A card with something in every one of the four relocated sections. */
function advancedCard(): DashboardSourceCard {
  return terminalExtractionCard({
    last_run: {
      status: 'completed',
      started_at: '2026-07-02T09:55:56.000Z',
      completed_at: '2026-07-02T09:58:06.000Z',
      duration_seconds: 130,
      items_seen: 480,
      items_indexed: 12,
    },
  });
}

function fixtureDegradation(): WorkerCredentialDegradation {
  return {
    kind: 'worker_credential_degraded',
    display_name: 'Dropbox',
    state: 'retrying',
    status_label: 'Credential unavailable - needs your attention',
    hint: 'Unlock or reconnect this credential, then restart the Olympus worker.',
    attempts: 2,
    max_attempts: 3,
    next_retry_at: '2026-07-02T12:05:00.000Z',
  };
}
