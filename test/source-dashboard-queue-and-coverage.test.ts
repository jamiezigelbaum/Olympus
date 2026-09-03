import { describe, expect, test } from 'bun:test';
import {
  buildEnvBridgeSovereigntyConfig,
  createSovereigntyEngine,
} from '../src/core/sovereignty.ts';
import {
  buildSourceDashboardViewModel,
  DASHBOARD_NEEDS_REVIEW_REASONS,
} from '../src/workers/source-dashboard.ts';
import type { ConnectedHandleRegistry } from '../src/workers/credential-broker/connected-handles.ts';
import type { SourceIndexStatusResult } from '../src/workers/source-index/status.ts';
import type { SourceSchedulerStatus } from '../src/workers/source-scheduler.ts';
import { buildSourceIngestionLedgerSnapshot } from '../src/workers/source-ingestion-ledger.ts';

const NOW = new Date('2026-07-02T12:00:00.000Z');

describe('dashboard queue counts', () => {
  test('reads the live gauge instead of adding the scheduler last-run deltas to it', () => {
    const view = buildSourceDashboardViewModel({
      sourceIndexStatus: statusWithDropbox({
        files: 44_000,
        folders: 0,
        secure_local_chunks: 300_000,
        qa_pass: 20_000,
        extraction_jobs_queued: 800,
        extraction_jobs_queued_actionable: 800,
        extraction_jobs_leased_current: 8,
        extraction_jobs_leased_current_actionable: 8,
      }),
      // The planner queued 200 of those 800 and the batch leased 8 of them in
      // the same pass, so the deltas are already inside the gauges.
      schedulerStatus: dropboxScheduler({ jobs_queued: 200, jobs_leased: 8 }),
      sovereigntyEngine: fixtureSovereigntyEngine(),
      connectedHandleRegistry: dropboxHandleRegistry(),
      now: NOW,
    });

    expect(view.sources.find((source) => source.source_id === 'dropbox.files')).toMatchObject({
      queue_health: { waiting: 800, active: 8, label: 'Working now' },
    });
  });

  test('lets a drained source report caught up despite a persisted last-run result', () => {
    const view = buildSourceDashboardViewModel({
      sourceIndexStatus: statusWithDropbox({
        files: 44_000,
        folders: 0,
        secure_local_chunks: 300_000,
        qa_pass: 44_000,
        extraction_jobs_queued: 0,
        extraction_jobs_queued_actionable: 0,
        extraction_jobs_leased_current: 0,
        extraction_jobs_leased_current_actionable: 0,
      }),
      // The metadata sync re-enqueues and leases one job on nearly every pass,
      // and last_result persists between runs.
      schedulerStatus: dropboxScheduler({ jobs_enqueued: 1, jobs_leased: 1 }),
      sovereigntyEngine: fixtureSovereigntyEngine(),
      connectedHandleRegistry: dropboxHandleRegistry(),
      now: NOW,
    });

    const card = view.sources.find((source) => source.source_id === 'dropbox.files');
    expect(card).toMatchObject({ queue_health: { waiting: 0, active: 0, label: 'Caught up' } });
    expect(card?.connection.state).not.toBe('syncing');
  });

  test('still falls back to scheduler deltas for a corpus that reports no queue depth', () => {
    expectGmailWaiting({ corpusCounts: {}, waiting: 5 });
  });

  test('prefers a corpus-reported queue depth over the scheduler delta', () => {
    expectGmailWaiting({ corpusCounts: { jobs_queued: 3 }, waiting: 3 });
  });
});

function expectGmailWaiting(input: { corpusCounts: Record<string, number>; waiting: number }): void {
  const status = statusWithDropbox({ files: 10, folders: 0, secure_local_chunks: 10, qa_pass: 10 });
  status.corpora.push({
    corpus_id: 'internal.email',
    family: 'email',
    trust_domain: 'internal',
    activation_mode: 'hybrid_primary',
    embedding_policy: 'cloud_allowed_by_policy',
    configured: true,
    provider: 'gmail',
    counts: {
      accounts: 1,
      indexed_items: 40,
      internal_chunks: 40,
      embedded_chunks: 20,
      ...input.corpusCounts,
    },
    item_metadata_returned: false,
    skipped_item_metadata_reason: 'email_item_metadata_not_exposed_to_castor',
  } as unknown as SourceIndexStatusResult['corpora'][number]);
  const scheduler = dropboxScheduler({ jobs_queued: 0 });
  scheduler.sources.push({
    source_id: 'gmail.email',
    corpus_id: 'internal.email',
    sync_cadence: 'continuous',
    sync_interval_seconds: 300,
    freshness_threshold_hours: 26,
    freshness_hours: 1,
    stale_sync_anomaly: false,
    tasks: [{
      id: 'email.sync',
      kind: 'sync',
      running: false,
      consecutive_failures: 0,
      last_result: { status: 'progress', counts: { jobs_queued: 5 } },
    }],
  } as unknown as SourceSchedulerStatus['sources'][number]);

  const view = buildSourceDashboardViewModel({
    sourceIndexStatus: status,
    schedulerStatus: scheduler,
    sovereigntyEngine: fixtureSovereigntyEngine(),
    connectedHandleRegistry: dropboxHandleRegistry(),
    now: NOW,
  });

  expect(view.sources.find((source) => source.source_id === 'gmail.email')?.queue_health.waiting).toBe(input.waiting);
}

describe('dashboard answer-ready counts', () => {
  test('counts per-item qa_pass rather than saturating on the chunk fallback', () => {
    const view = buildSourceDashboardViewModel({
      sourceIndexStatus: statusWithDropbox({
        files: 44_000,
        folders: 0,
        secure_local_chunks: 300_000,
        qa_pass: 20_000,
      }),
      sovereigntyEngine: fixtureSovereigntyEngine(),
      connectedHandleRegistry: dropboxHandleRegistry(),
      now: NOW,
    });

    const card = view.sources.find((source) => source.source_id === 'dropbox.files');
    expect(card?.coverage).toMatchObject({ indexed_items: 44_000, content_ready_items: 20_000 });
    expect(card?.tier_composition[0]).toMatchObject({ content_ready_items: 20_000 });
    expect(view.summary.total_content_ready_items).toBe(20_000);
  });

  // The inverse of the test above, and it used to assert the opposite: that a
  // corpus reporting no per-item ready count keeps a chunk fallback. The rule
  // that saturates on 300,000 chunks against 44,000 files saturates just as
  // hard on 30 against 30 — the case simply looks harmless because the fixture
  // chose one chunk per file. Chunks are evidence that text exists somewhere,
  // never a count of readable ITEMS, so a corpus that publishes no per-item
  // count is unknown, and unknown may not be published as complete.
  test('reports no content-ready items for a corpus that publishes no per-item ready count', () => {
    const status = statusWithDropbox({ files: 30, folders: 0, secure_local_chunks: 30 });
    const view = buildSourceDashboardViewModel({
      sourceIndexStatus: status,
      sovereigntyEngine: fixtureSovereigntyEngine(),
      connectedHandleRegistry: dropboxHandleRegistry(),
      now: NOW,
    });

    const card = view.sources.find((source) => source.source_id === 'dropbox.files');
    expect(card?.coverage).toMatchObject({ indexed_items: 30, content_ready_items: 0 });
    expect(card?.ingestion_health.coverage_percent).toBe(0);
  });

  test('reads the connector store\'s per-item with-text count when it is published', () => {
    const status = statusWithDropbox({
      files: 44_000,
      folders: 0,
      secure_local_chunks: 300_000,
      chunks: 300_000,
      items_with_text: 20_000,
    });
    const view = buildSourceDashboardViewModel({
      sourceIndexStatus: status,
      sovereigntyEngine: fixtureSovereigntyEngine(),
      connectedHandleRegistry: dropboxHandleRegistry(),
      now: NOW,
    });

    const card = view.sources.find((source) => source.source_id === 'dropbox.files');
    expect(card?.coverage).toMatchObject({ indexed_items: 44_000, content_ready_items: 20_000 });
    expect(card?.ingestion_health.coverage_percent).toBe(45.5);
  });
});

/**
 * Owner ruling, 2026-08-21: "Dropbox should be 100% because it's 100% of the
 * files that are marked to embed that are embedded. Don't count the files that
 * we are not using as part of that number."
 *
 * The live shape this fixes: ~126K indexed, ~67K of them media and books the
 * extraction ladder is never asked to read, an empty extraction queue — and a
 * card reading 55% answer-ready, which described work nobody was ever going to
 * do.
 */
describe('answer-ready percentage excludes what the system never reads', () => {
  test('divides by the eligible files and still reports the raw indexed count', () => {
    const card = dropboxCard({
      files: 126_000,
      folders: 0,
      qa_pass: 59_000,
      qa_metadata_only_expected: 67_000,
    });

    expect(card?.coverage.indexed_items).toBe(126_000);
    expect(card?.coverage.content_ready_items).toBe(59_000);
    expect(card?.coverage.not_read_by_policy_items).toBe(67_000);
    // 59,000 of the 59,000 files it is asked to read.
    expect(card?.ingestion_health.coverage_percent).toBe(100);
    expect(card?.ingestion_health.label).toContain('100% covered');
  });

  // Was: "a 100% never stands alone — the label says what was left unread".
  // Owner ruling, 2026-08-23/24 supersedes that pairing: the exclusion count
  // must not sit beside the percentage anywhere, and this label is read in the
  // detail page's foot and as a failing check's cause, both of which stand a
  // percentage next to it. The count keeps its own foot line in pages/detail.ts
  // and stays on the card for anyone reading the payload, so it is one click
  // away rather than gone.
  test('the label states the ratio without the exclusion count beside it', () => {
    const card = dropboxCard({
      files: 126_000,
      folders: 0,
      qa_pass: 59_000,
      qa_metadata_only_expected: 67_000,
    });

    expect(card?.ingestion_health.label).toBe('100% covered; no stuck work');
    expect(card?.ingestion_health.label).not.toContain('not read by policy');
    // Still counted, still published, still reachable — just not here.
    expect(card?.coverage.not_read_by_policy_items).toBe(67_000);
  });

  test('sums both policy verdicts into the excluded count', () => {
    const card = dropboxCardWithLedger({
      files: 100,
      folders: 0,
      qa_pass: 30,
      qa_metadata_only_expected: 30,
      qa_blocked_policy: 10,
    });

    expect(card?.coverage.not_read_by_policy_items).toBe(40);
    // 30 ready out of the 60 eligible, not out of all 100.
    expect(card?.ingestion_health.coverage_percent).toBe(50);
    expect(card?.ingestion_selection).toEqual({
      metadata_only_files: 30,
      full_ingestion_files: 60,
    });
  });

  test('does not turn an extraction readiness gap into an owner selection', () => {
    const card = dropboxCardWithLedger({ files: 100, folders: 0, qa_pass: 30 });

    expect(card?.ingestion_selection).toBeUndefined();
  });

  test('a corpus where every file is deferred says so instead of claiming 100%', () => {
    const card = dropboxCard({
      files: 500,
      folders: 0,
      qa_pass: 0,
      qa_metadata_only_expected: 500,
    });

    // No divide-by-zero, and nothing was left unread — but the words carry it,
    // because "100% covered" over 500 unread files states the opposite.
    expect(card?.ingestion_health.coverage_percent).toBe(100);
    expect(card?.ingestion_health.label).not.toContain('% covered');
    expect(card?.ingestion_health.label).toContain('None of these files are read by policy');
    expect(card?.coverage.indexed_items).toBe(500);
  });

  test('out-of-content-scope files are excluded and are NOT needs-review work', () => {
    // Metadata sync covers the account root; extraction is pointed at a few
    // folders. The ladder used to score everything else qa_metadata_only_gap,
    // which is a needs-review reason — so the card asked an operator to fix
    // 160,000 files nobody ever intended to read.
    const card = dropboxCard({
      files: 262_000,
      folders: 0,
      qa_pass: 23_000,
      qa_metadata_only_expected: 69_000,
      qa_blocked_policy: 100,
      qa_out_of_content_scope: 166_000,
      qa_metadata_only_gap: 3_000,
      qa_eligible_items: 26_900,
    });

    expect(card?.coverage.not_read_by_policy_items).toBe(235_100);
    // The gap total is the in-scope gaps only; the out-of-scope mass is gone
    // from review work entirely.
    expect(card?.coverage.needs_review_items).toBe(3_000);
    expect(card?.needs_review?.reasons.map((reason) => reason.key)).not.toContain('out_of_content_scope');
  });

  /**
   * The connector store reports what it has finished DRAINING; the QA ladder
   * scores the whole legacy index it drains from. On the live host that is
   * ~126K against ~262K, so `indexed_items - not_read_by_policy_items` is a
   * subtraction across two populations and lands below zero — which reads as
   * "none of these files are read by policy" on a corpus that reads most of
   * what it is asked to. The ladder publishes its own denominator for exactly
   * this reason.
   */
  describe('the denominator comes from the population that produced the ready count', () => {
    const CONNECTOR_STORE_COUNTS = {
      // The store's own facts.
      indexed_items: 126_437,
      chunks: 69_512,
      embedded_chunks: 69_512,
      // The evidence owner's facts, over a larger population.
      qa_total_items: 262_144,
      qa_pass: 23_294,
      qa_metadata_only_expected: 69_423,
      qa_blocked_policy: 137,
      qa_out_of_content_scope: 166_000,
      qa_metadata_only_gap: 643,
      qa_eligible_items: 26_584,
    };

    test('the published eligible count is believed over the subtraction', () => {
      const card = dropboxCard(CONNECTOR_STORE_COUNTS);

      expect(card?.coverage.answer_ready_eligible_items).toBe(26_584);
      // 23,294 / 26,584 — not 23,294 / (126,437 - 235,560), which is negative.
      expect(card?.ingestion_health.coverage_percent).toBe(87.6);
      expect(card?.ingestion_health.label).toContain('87.6% covered');
    });

    test('the card still reports the store\'s own indexed count beside it', () => {
      const card = dropboxCard(CONNECTOR_STORE_COUNTS);

      // The read authority's number is never overwritten by the evidence
      // owner's: how much the store holds is the store's answer to give.
      expect(card?.coverage.indexed_items).toBe(126_437);
      expect(card?.coverage.content_ready_items).toBe(23_294);
    });

    test('without the published count the same numbers collapse to a false none-read', () => {
      // The pre-change arithmetic, kept as the reason the key exists: strip the
      // denominator and the subtraction goes negative, and the card claims the
      // policy reads nothing at all.
      const { qa_eligible_items: _dropped, ...withoutEligible } = CONNECTOR_STORE_COUNTS;
      const card = dropboxCard(withoutEligible);

      expect(card?.coverage.answer_ready_eligible_items).toBeUndefined();
      expect(card?.ingestion_health.label).toContain('None of these files are read by policy');
    });
  });

  test('a corpus reporting neither verdict key is arithmetically untouched', () => {
    const card = dropboxCard({ files: 100, folders: 0, files_with_text: 55 });

    expect(card?.coverage.not_read_by_policy_items).toBeUndefined();
    expect(card?.ingestion_health.coverage_percent).toBe(55);
    expect(card?.ingestion_health.label).toContain('55% covered');
    expect(card?.ingestion_health.label).not.toContain('not read by policy');
  });

  test('zero indexed items still answers 0, never a vacuous 100', () => {
    const card = dropboxCard({ files: 0, folders: 0, qa_pass: 0, qa_metadata_only_expected: 0 });

    expect(card?.ingestion_health.coverage_percent).toBe(0);
    expect(card?.ingestion_health.label).toContain('Nothing ingested yet');
  });
});

/**
 * A privacy-fenced file is the fence working as configured — never operator
 * work. The live private host carries ~60 of them on Dropbox, which under the old ladder
 * pinned that card to "Needs attention" permanently with nothing to press,
 * while the same files were being excluded from the answer-ready denominator
 * as deliberately-not-read. One file cannot be both.
 */
describe('privacy-fenced files are stated, never alarmed about', () => {
  test('a corpus whose only exception is the fence is caught up and answerable', () => {
    const card = dropboxCard({
      files: 1_000,
      folders: 0,
      qa_pass: 940,
      qa_blocked_policy: 60,
    });

    expect(card?.queue_health.needs_attention).toBe(0);
    expect(card?.queue_health.label).toBe('Caught up');
    expect(card?.answer_readiness.state).toBe('ready');
    // 940 of the 940 files it is asked to read.
    expect(card?.ingestion_health.coverage_percent).toBe(100);
  });

  test('the fenced files stay visible in the count the card prints', () => {
    const card = dropboxCard({
      files: 1_000,
      folders: 0,
      qa_pass: 940,
      qa_blocked_policy: 60,
    });

    // The fenced files stay counted and published on the card. They are simply
    // no longer printed beside the coverage percentage (owner ruling,
    // 2026-08-23/24) — the detail page's foot is where the reader meets them.
    expect(card?.coverage.not_read_by_policy_items).toBe(60);
    expect(card?.ingestion_health.label).not.toContain('not read by policy');
  });

  test('a fence never hides a genuine failure sitting beside it', () => {
    const card = dropboxCard({
      files: 1_000,
      folders: 0,
      qa_pass: 930,
      qa_blocked_policy: 60,
      qa_failed_needs_operator: 10,
    });

    // The failures, and only the failures: 10, not 70.
    expect(card?.queue_health.needs_attention).toBe(10);
    expect(card?.queue_health.label).toBe('Needs attention');
    expect(card?.answer_readiness).toEqual({
      state: 'needs_attention',
      label: 'Needs attention before answers',
    });
  });

  test('a fenced file is never counted as a document needing review', () => {
    // The needs-review total is summed from this list alone, so the guarantee
    // is the list's membership, not a coincidence of the fixture.
    expect(DASHBOARD_NEEDS_REVIEW_REASONS.map((reason) => reason.count_key))
      .not.toContain('qa_blocked_policy');

    const card = dropboxCard({ files: 1_000, folders: 0, qa_pass: 940, qa_blocked_policy: 60 });
    expect(card?.coverage.needs_review_items).toBe(0);
  });
});

function dropboxCard(counts: Record<string, number>) {
  const view = buildSourceDashboardViewModel({
    sourceIndexStatus: statusWithDropbox(counts),
    sovereigntyEngine: fixtureSovereigntyEngine(),
    connectedHandleRegistry: dropboxHandleRegistry(),
    now: NOW,
  });
  return view.sources.find((source) => source.source_id === 'dropbox.files');
}

function dropboxCardWithLedger(counts: Record<string, number>) {
  const status = statusWithDropbox(counts);
  const view = buildSourceDashboardViewModel({
    sourceIndexStatus: status,
    ingestionLedger: buildSourceIngestionLedgerSnapshot(status, { now: NOW }),
    sovereigntyEngine: fixtureSovereigntyEngine(),
    connectedHandleRegistry: dropboxHandleRegistry(),
    now: NOW,
  });
  return view.sources.find((source) => source.source_id === 'dropbox.files');
}

function statusWithDropbox(counts: Record<string, number>): SourceIndexStatusResult {
  return {
    kind: 'source_index_status',
    generated_at: '2026-07-02T12:00:00.000Z',
    corpora: [{
      corpus_id: 'secure_local.dropbox.files',
      family: 'file',
      trust_domain: 'secure_local',
      activation_mode: 'hybrid_primary',
      embedding_policy: 'local_only',
      configured: true,
      provider: 'dropbox',
      read_authority: 'legacy_index',
      counts: { accounts: 1, embedded_chunks: 0, ...counts },
      item_metadata_returned: false,
      skipped_item_metadata_reason: 'secure_local_item_metadata_not_exposed_to_castor',
    } as unknown as SourceIndexStatusResult['corpora'][number]],
    policy: {
      read_only: true,
      raw_source_exposed: false,
      source_packets_exposed: false,
      source_text_returned: false,
      secure_local_item_metadata_exposed: false,
      castor_visible: true,
    },
  };
}

function dropboxScheduler(lastResultCounts: Record<string, number>): SourceSchedulerStatus {
  return {
    kind: 'source_scheduler_status',
    enabled: true,
    running: true,
    generated_at: '2026-07-02T12:00:00.000Z',
    sources: [{
      source_id: 'dropbox.files',
      corpus_id: 'secure_local.dropbox.files',
      sync_cadence: 'continuous',
      sync_interval_seconds: 300,
      freshness_threshold_hours: 26,
      freshness_hours: 1,
      stale_sync_anomaly: false,
      tasks: [{
        id: 'dropbox.content_extraction',
        kind: 'extract',
        running: false,
        consecutive_failures: 0,
        last_result: { status: 'progress', counts: lastResultCounts },
      }],
    } as unknown as SourceSchedulerStatus['sources'][number]],
    policy: {
      raw_source_exposed: false,
      source_text_returned: false,
      source_scope_keys_exposed: false,
      counts_only: true,
    },
  };
}

function dropboxHandleRegistry(): ConnectedHandleRegistry {
  return {
    version: 1,
    handles: [{
      handle: 'dropbox.personal',
      provider: 'dropbox',
      accountRole: 'personal',
      trustDomain: 'secure_local',
      allowedCapabilities: ['dropbox.files.sync'],
      scopes: ['files.metadata.read'],
      connectedAt: '2026-07-02T10:00:00.000Z',
    }],
  };
}

function fixtureSovereigntyEngine() {
  return createSovereigntyEngine(buildEnvBridgeSovereigntyConfig({
    OLYMPUS_SOURCE_INDEX_CLOUD_ANALYST_ENABLED: 'true',
    OLYMPUS_SOURCE_INDEX_CLOUD_ANALYST_MODEL: 'openai/gpt-5.5',
  }));
}
