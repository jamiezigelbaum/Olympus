import { describe, expect, test } from 'bun:test';
import {
  buildEnvBridgeSovereigntyConfig,
  createSovereigntyEngine,
} from '../src/core/sovereignty.ts';
import { buildSourceDashboardViewModel } from '../src/workers/source-dashboard.ts';
import type { ConnectedHandleRegistry } from '../src/workers/credential-broker/connected-handles.ts';
import type {
  SourceIngestionLedgerRow,
  SourceIngestionLedgerSnapshot,
} from '../src/workers/source-ingestion-ledger.ts';
import type { SourceIndexStatusResult } from '../src/workers/source-index/status.ts';
import type { SourceSchedulerStatus } from '../src/workers/source-scheduler.ts';

const NOW = new Date('2026-07-02T12:00:00.000Z');

describe('dashboard view model additive facts', () => {
  test('embedding backlog sums the disjoint canonical connector-store bands', () => {
    const status = statusWithCorpora([
      emailCorpus('secure_local.email.private', 'secure_local', 400, {
        read_authority: 'connector_store',
        embedding_parity: { required: true, chunks: 1000, embedded_chunks: 400, missing_chunks: 600, refresh_needed: true },
      }),
      emailCorpus('internal.email', 'internal', 120, {
        embedding_parity: { required: true, chunks: 300, embedded_chunks: 300, missing_chunks: 0, refresh_needed: false },
      }),
    ]);

    const view = buildView({ status });
    const gmail = card(view, 'gmail.email');

    expect(gmail.embedding_backlog).toEqual({
      chunks: 1300,
      embedded_chunks: 700,
      missing_chunks: 600,
      refresh_needed: true,
    });
    expect(backgroundWork(view).embedding_backlog).toEqual(gmail.embedding_backlog!);
  });

  test('a source with nothing to embed reports no backlog rather than a zero denominator', () => {
    const status = statusWithCorpora([
      emailCorpus('internal.email', 'internal', 0, {
        embedding_parity: { required: true, chunks: 0, embedded_chunks: 0, missing_chunks: 0, refresh_needed: false },
      }),
    ]);

    const view = buildView({ status });

    expect(card(view, 'gmail.email').embedding_backlog).toBeUndefined();
    expect(backgroundWork(view).embedding_backlog).toBeUndefined();
  });

  // The embedding bar divides in ITEMS, so the store's per-item parity count
  // has to survive the trip from status counts to the card (owner ruling,
  // 2026-09-01). Absent stays absent: "not measured" is not zero.
  test('maps the store items_embedded count onto the card as embedded_files', () => {
    const view = buildView({
      status: statusWithCorpora([
        emailCorpus('internal.email', 'internal', 400, { counts: emailCounts(400, { items_embedded: 260 }) }),
      ]),
    });

    expect(card(view, 'gmail.email').coverage.embedded_files).toBe(260);
  });

  test('leaves embedded_files absent when no corpus publishes a per-item count', () => {
    const view = buildView({
      status: statusWithCorpora([emailCorpus('internal.email', 'internal', 400, {})]),
    });

    const coverage = card(view, 'gmail.email').coverage;
    expect(coverage.embedded_files).toBeUndefined();
    expect('embedded_files' in coverage).toBe(false);
  });

  test('sums embedded_files when every corpus holding items measures it', () => {
    const view = buildView({
      status: statusWithCorpora([
        emailCorpus('secure_local.email.private', 'secure_local', 400, {
          read_authority: 'connector_store',
          counts: emailCounts(400, { items_embedded: 300 }, 'secure_local'),
        }),
        emailCorpus('internal.email', 'internal', 120, { counts: emailCounts(120, { items_embedded: 90 }) }),
      ]),
    });

    expect(card(view, 'gmail.email').coverage.embedded_files).toBe(390);
  });

  test('a card whose corpora only partly measure keeps the sum absent, not partial', () => {
    // One corpus measures and one does not. The card's denominator covers BOTH
    // corpora, so summing only the measured half would print an exact
    // percentage whose numerator quietly excludes a whole corpus.
    const partial = buildView({
      status: statusWithCorpora([
        emailCorpus('secure_local.email.private', 'secure_local', 400, {
          read_authority: 'connector_store',
          counts: emailCounts(400, { items_embedded: 300 }, 'secure_local'),
        }),
        emailCorpus('internal.email', 'internal', 120, {}),
      ]),
    });
    const neither = buildView({
      status: statusWithCorpora([
        emailCorpus('secure_local.email.private', 'secure_local', 400, { read_authority: 'connector_store' }),
        emailCorpus('internal.email', 'internal', 120, {}),
      ]),
    });
    // A corpus holding nothing contributes nothing to the denominator either,
    // so its silence cannot make the sum partial.
    const emptyUnmeasured = buildView({
      status: statusWithCorpora([
        emailCorpus('secure_local.email.private', 'secure_local', 400, {
          read_authority: 'connector_store',
          counts: emailCounts(400, { items_embedded: 300 }, 'secure_local'),
        }),
        emailCorpus('internal.email', 'internal', 0, {}),
      ]),
    });

    const partialCoverage = card(partial, 'gmail.email').coverage;
    expect(partialCoverage.embedded_files).toBeUndefined();
    expect('embedded_files' in partialCoverage).toBe(false);
    expect(card(neither, 'gmail.email').coverage.embedded_files).toBeUndefined();
    expect(card(emptyUnmeasured, 'gmail.email').coverage.embedded_files).toBe(300);
  });

  // Keyword-only activation has no embedding stage at all, and the phase row
  // says so rather than counting toward a total it will never reach.
  test('carries embedding_required false through from corpus parity', () => {
    const notRequired = buildView({
      status: statusWithCorpora([
        emailCorpus('internal.email', 'internal', 400, {
          embedding_parity: { required: false, chunks: 0, embedded_chunks: 0, missing_chunks: 0, refresh_needed: false },
        }),
      ]),
    });
    const required = buildView({
      status: statusWithCorpora([
        emailCorpus('internal.email', 'internal', 400, {
          embedding_parity: { required: true, chunks: 10, embedded_chunks: 4, missing_chunks: 6, refresh_needed: false },
        }),
      ]),
    });
    const unpublished = buildView({
      status: statusWithCorpora([emailCorpus('internal.email', 'internal', 400, {})]),
    });

    expect(card(notRequired, 'gmail.email').embedding_required).toBe(false);
    expect(card(required, 'gmail.email').embedding_required).toBe(true);
    expect(card(unpublished, 'gmail.email').embedding_required).toBeUndefined();
  });

  test('the newest refresh becomes last_run, with its duration and without its scope key', () => {
    const status = statusWithCorpora([
      emailCorpus('secure_local.email.private', 'secure_local', 400, {
        last_refresh: {
          sync_run_id: 'run-older',
          status: 'ok',
          started_at: '2026-07-02T09:00:00.000Z',
          completed_at: '2026-07-02T09:00:30.000Z',
          items_seen: 10,
          items_indexed: 1,
        },
      }),
      emailCorpus('internal.email', 'internal', 120, {
        last_refresh: {
          sync_run_id: 'run-newer',
          status: 'ok',
          started_at: '2026-07-02T11:40:00.000Z',
          completed_at: '2026-07-02T11:42:10.000Z',
          items_seen: 812,
          items_indexed: 46,
          source_scope: 'label:INBOX',
        },
      }),
    ]);

    const view = buildView({ status });
    const lastRun = card(view, 'gmail.email').last_run;

    expect(lastRun).toEqual({
      status: 'ok',
      started_at: '2026-07-02T11:40:00.000Z',
      completed_at: '2026-07-02T11:42:10.000Z',
      duration_seconds: 130,
      items_seen: 812,
      items_indexed: 46,
    });
    const serialized = JSON.stringify(lastRun);
    expect(serialized).not.toContain('label:INBOX');
    expect(serialized).not.toContain('run-newer');
  });

  test('schedule counts a task once when the status matches by corpus and by source id', () => {
    const status = statusWithCorpora([emailCorpus('internal.email', 'internal', 120, {})]);
    const scheduler: SourceSchedulerStatus = {
      kind: 'source_scheduler_status',
      enabled: true,
      running: true,
      generated_at: NOW.toISOString(),
      sources: [{
        // Matched twice: schedulerByCorpus finds it by internal.email and
        // schedulerBySource by gmail.email.
        source_id: 'gmail.email',
        corpus_id: 'internal.email',
        sync_cadence: 'continuous',
        sync_interval_seconds: 300,
        freshness_threshold_hours: 26,
        freshness_hours: 1,
        stale_sync_anomaly: false,
        tasks: [{
          id: 'gmail.email:sync',
          kind: 'sync',
          running: false,
          consecutive_failures: 3,
          last_success_at: '2026-07-02T06:00:00.000Z',
          last_attempt_at: '2026-07-02T11:55:00.000Z',
          next_run_at: '2026-07-02T12:05:00.000Z',
          last_error_kind: 'provider_rate_limited',
        }],
      }],
      policy: {
        raw_source_exposed: false,
        source_text_returned: false,
        source_scope_keys_exposed: false,
        counts_only: true,
      },
    };

    const view = buildView({ status, scheduler });

    expect(card(view, 'gmail.email').schedule).toEqual({
      running: false,
      consecutive_failures: 3,
      last_success_at: '2026-07-02T06:00:00.000Z',
      last_attempt_at: '2026-07-02T11:55:00.000Z',
      next_run_at: '2026-07-02T12:05:00.000Z',
      last_error_kind: 'provider_rate_limited',
    });
    expect(card(view, 'google_drive.docs').schedule).toBeUndefined();
  });

  test('the ledger row carries its last sync, its reasons and its queued VLM work', () => {
    const status = statusWithCorpora([dropboxCorpus(20_000, 3_000)]);
    const ledger = ledgerSnapshot([dropboxLedgerRow()]);

    const view = buildView({ status, ledger });
    const dropbox = card(view, 'dropbox.files');

    expect(dropbox.last_sync_at).toBe('2026-07-02T11:20:00.000Z');
    expect(dropbox.attention_reasons).toEqual(['19 VLM extraction job(s) queued/paused']);
    expect(dropbox.vlm_extraction_queued).toBe(19);
    expect(backgroundWork(view).vlm_extraction_queued).toBe(19);
  });

  test('an unreported VLM queue stays absent instead of reading as empty', () => {
    const status = statusWithCorpora([dropboxCorpus(20_000, 3_000)]);
    const row = dropboxLedgerRow();
    delete row.failure_breakdown;

    const view = buildView({ status, ledger: ledgerSnapshot([row]) });

    expect(card(view, 'dropbox.files').vlm_extraction_queued).toBeUndefined();
    expect(backgroundWork(view).vlm_extraction_queued).toBeUndefined();
    expect('vlm_extraction_queued' in backgroundWork(view)).toBe(false);
  });

  test('a disabled embedding lane reaches background work', () => {
    const status = statusWithCorpora([emailCorpus('internal.email', 'internal', 120, {})]);
    status.embedding_lane = { state: 'embedding_lane_disabled', reason: 'embedding_provider_unavailable' };

    expect(backgroundWork(buildView({ status })).embedding_lane_state).toBe('embedding_lane_disabled');
    expect(backgroundWork(buildView({ status: statusWithCorpora([]) })).embedding_lane_state).toBeUndefined();
  });

  test('first_run stays true until a source is actually connected', () => {
    const status = statusWithCorpora([emailCorpus('internal.email', 'internal', 0, {})]);

    const fresh = buildView({ status });
    expect(fresh.first_run).toBe(true);
    expect(fresh.summary.connected_sources).toBe(0);
    // configured_sources is the card roster, which is why it cannot answer this.
    expect(fresh.summary.configured_sources).toBeGreaterThan(0);

    const connected = buildView({
      status: statusWithCorpora([emailCorpus('internal.email', 'internal', 120, {})]),
      handles: gmailHandleRegistry(),
    });
    expect(connected.first_run).toBe(false);
  });

  test('the fields this diff touches still serialize with their existing shape', () => {
    const status = statusWithCorpora([emailCorpus('internal.email', 'internal', 120, {})]);
    const view = JSON.parse(JSON.stringify(buildView({ status, handles: gmailHandleRegistry() }))) as
      ReturnType<typeof buildSourceDashboardViewModel>;

    expect(Object.keys(view)).toEqual([
      'kind',
      'generated_at',
      'summary',
      'onboarding',
      'google_pilot',
      'answer_lanes',
      'where_your_data_lives',
      'unassigned_corpora',
      'excluded_by_configuration',
      // `sensitivity` sits between these two when a map is configured; it is
      // absent here because no map was passed, which is the shipped default.
      'sensitivity_tiers',
      'folder_picker',
      'sources',
      'history',
      'first_run',
      'background_work',
      'policy',
    ]);
    expect(view.google_pilot).toEqual({
      mode: 'advanced_byo_required',
      verification: 'unverified',
      warning: 'The shared Google pilot client is not provisioned in this install. Use the advanced bring-your-own Google app flow.',
      advanced_byo_supported: true,
    });
    expect(view.policy).toEqual({
      counts_only: true,
      raw_source_exposed: false,
      source_text_returned: false,
      file_names_returned: false,
      file_paths_returned: false,
      host_names_returned: false,
    });
    expect(view.summary).toEqual({
      configured_sources: 7,
      connected_sources: 1,
      answer_ready_sources: 1,
      needs_attention_sources: 0,
      total_indexed_items: 120,
      total_content_ready_items: 120,
    });

    const gmail = card(view, 'gmail.email');
    expect(Object.keys(gmail)).toEqual([
      'corpus_id',
      'source_id',
      'label',
      'provider',
      'family',
      'trust_domain',
      'capabilities',
      'configured',
      'freshness',
      'coverage',
      'needs_review',
      'ingestion_health',
      'tier_composition',
      'queue_health',
      'answer_readiness',
      'connection',
      'setup',
    ]);
    expect(gmail.coverage).toEqual({
      indexed_items: 120,
      content_ready_items: 120,
      embedded_items: 0,
      needs_review_items: 0,
    });
    expect(gmail.queue_health).toEqual({
      label: 'Caught up',
      waiting: 0,
      active: 0,
      needs_attention: 0,
    });
    expect(gmail.answer_readiness).toEqual({ state: 'ready', label: 'Ready for questions' });
    expect(gmail.connection.state).toBe('synced');
    expect(gmail.freshness.stale).toBe(false);
    // Key-set pins on the nested objects the diff does not touch, so a rename
    // inside one of them fails here rather than slipping past the card pin.
    // `connected_at` is the handle's own grant time: the clock the phase rows
    // need to tell "connected a moment ago" from "connected and never syncing".
    expect(Object.keys(gmail.connection)).toEqual([
      'state',
      'label',
      'action',
      'handles',
      'connected_at',
      'disconnect',
    ]);
    expect(gmail.connection.connected_at).toBe('2026-07-02T10:00:00.000Z');
    expect(gmail.connection.disconnect).toMatchObject({
      source_id: 'gmail.email',
      label: 'Disconnect Gmail',
      provider_revocation_url: 'https://myaccount.google.com/connections',
    });
    expect(Object.keys(gmail.freshness)).toEqual(['label', 'stale']);
    expect(Object.keys(gmail.ingestion_health)).toEqual([
      'coverage_percent',
      'stuck_count',
      'drain_state',
      'label',
    ]);
  });

  test('a fully-populated card serializes exactly the base keys plus the additive ones', () => {
    const status = statusWithCorpora([{
      ...dropboxCorpus(20_000, 3_000),
      last_refresh: {
        sync_run_id: 'run-full',
        status: 'ok',
        started_at: '2026-07-02T11:40:00.000Z',
        completed_at: '2026-07-02T11:42:10.000Z',
        items_seen: 812,
        items_indexed: 46,
      },
      embedding_parity: { required: true, chunks: 1000, embedded_chunks: 400, missing_chunks: 600, refresh_needed: false },
    } as unknown as SourceIndexStatusResult['corpora'][number]]);
    const scheduler: SourceSchedulerStatus = {
      kind: 'source_scheduler_status',
      enabled: true,
      running: true,
      generated_at: NOW.toISOString(),
      sources: [{
        source_id: 'dropbox.files',
        corpus_id: 'secure_local.dropbox.files',
        sync_cadence: 'continuous',
        sync_interval_seconds: 300,
        freshness_threshold_hours: 26,
        freshness_hours: 1,
        stale_sync_anomaly: false,
        tasks: [{
          id: 'dropbox.files:sync',
          kind: 'sync',
          running: false,
          consecutive_failures: 0,
          last_success_at: '2026-07-02T11:42:10.000Z',
          last_attempt_at: '2026-07-02T11:42:10.000Z',
          next_run_at: '2026-07-02T12:05:00.000Z',
        }],
      }],
      policy: {
        raw_source_exposed: false,
        source_text_returned: false,
        source_scope_keys_exposed: false,
        counts_only: true,
      },
    };

    const view = JSON.parse(JSON.stringify(buildView({
      status,
      scheduler,
      ledger: ledgerSnapshot([dropboxLedgerRow()]),
      handles: dropboxHandleRegistry(),
    }))) as ReturnType<typeof buildSourceDashboardViewModel>;
    const dropbox = card(view, 'dropbox.files');

    // A stray field emitted alongside the additive ones fails here even though
    // the minimal-card pin above cannot see it.
    expect(Object.keys(dropbox)).toEqual([
      'corpus_id',
      'source_id',
      'label',
      'provider',
      'family',
      'trust_domain',
      'capabilities',
      'configured',
      'freshness',
      'coverage',
      'ingestion_selection',
      'needs_review',
      'ingestion_health',
      'tier_composition',
      'queue_health',
      'answer_readiness',
      'connection',
      'last_run',
      'last_sync_at',
      'schedule',
      'embedding_backlog',
      // Added 2026-09-01: whether this card's corpora are served from
      // embeddings at all, so the embedding row can say the stage is not
      // needed instead of counting toward a total it will never reach.
      'embedding_required',
      'vlm_extraction_queued',
      'attention_reasons',
      'setup',
    ]);
    expect(dropbox.setup).toMatchObject({
      stage: 'cited_answer_readiness',
      condition: 'usable',
      next_action: expect.stringContaining('confirm the answer cites Dropbox evidence'),
    });
  });
});

function buildView(input: {
  status: SourceIndexStatusResult;
  scheduler?: SourceSchedulerStatus;
  ledger?: SourceIngestionLedgerSnapshot;
  handles?: ConnectedHandleRegistry;
}) {
  return buildSourceDashboardViewModel({
    sourceIndexStatus: input.status,
    ...(input.scheduler ? { schedulerStatus: input.scheduler } : {}),
    ...(input.ledger ? { ingestionLedger: input.ledger } : {}),
    ...(input.handles ? { connectedHandleRegistry: input.handles } : {}),
    sovereigntyEngine: createSovereigntyEngine(buildEnvBridgeSovereigntyConfig({
      OLYMPUS_SOURCE_INDEX_CLOUD_ANALYST_ENABLED: 'true',
      OLYMPUS_SOURCE_INDEX_CLOUD_ANALYST_MODEL: 'openai/gpt-5.5',
    })),
    now: NOW,
  });
}

function backgroundWork(view: ReturnType<typeof buildSourceDashboardViewModel>) {
  const work = view.background_work;
  if (!work) throw new Error('the builder always emits background_work');
  return work;
}

function card(view: ReturnType<typeof buildSourceDashboardViewModel>, sourceId: string) {
  const found = view.sources.find((source) => source.source_id === sourceId);
  if (!found) throw new Error(`fixture is missing the ${sourceId} card`);
  return found;
}

function statusWithCorpora(corpora: SourceIndexStatusResult['corpora']): SourceIndexStatusResult {
  return {
    kind: 'source_index_status',
    generated_at: NOW.toISOString(),
    corpora,
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

/** The email fixture's own counts, plus whatever a case needs on top. */
function emailCounts(
  indexedItems: number,
  extra: Record<string, number>,
  trustDomain: 'secure_local' | 'internal' = 'internal',
): Record<string, number> {
  return {
    accounts: 1,
    indexed_items: indexedItems,
    threads: indexedItems,
    [trustDomain === 'secure_local' ? 'private_chunks' : 'internal_chunks']: indexedItems,
    items_with_text: indexedItems,
    embedded_chunks: 0,
    ...extra,
  };
}

function emailCorpus(
  corpusId: string,
  trustDomain: 'secure_local' | 'internal',
  indexedItems: number,
  extra: Record<string, unknown>,
): SourceIndexStatusResult['corpora'][number] {
  return {
    corpus_id: corpusId,
    family: 'email',
    trust_domain: trustDomain,
    activation_mode: 'hybrid_primary',
    embedding_policy: trustDomain === 'secure_local' ? 'local_only' : 'cloud_allowed_by_policy',
    configured: true,
    provider: 'gmail',
    counts: {
      accounts: 1,
      indexed_items: indexedItems,
      threads: indexedItems,
      [trustDomain === 'secure_local' ? 'private_chunks' : 'internal_chunks']: indexedItems,
      // The store's per-item ready count. A fully-read fixture corpus: every
      // message it holds has text.
      items_with_text: indexedItems,
      embedded_chunks: 0,
    },
    item_metadata_returned: false,
    skipped_item_metadata_reason: 'email_item_metadata_not_exposed_to_castor',
    ...extra,
  } as unknown as SourceIndexStatusResult['corpora'][number];
}

function dropboxCorpus(files: number, filesWithText: number): SourceIndexStatusResult['corpora'][number] {
  return {
    corpus_id: 'secure_local.dropbox.files',
    family: 'file',
    trust_domain: 'secure_local',
    activation_mode: 'hybrid_shadow',
    embedding_policy: 'local_only',
    configured: true,
    provider: 'dropbox',
    counts: {
      accounts: 1,
      files,
      folders: 0,
      files_with_text: filesWithText,
      secure_local_chunks: filesWithText,
      embedded_chunks: 0,
    },
    item_metadata_returned: false,
    skipped_item_metadata_reason: 'secure_local_item_metadata_not_exposed_to_castor',
  } as unknown as SourceIndexStatusResult['corpora'][number];
}

function ledgerSnapshot(rows: SourceIngestionLedgerRow[]): SourceIngestionLedgerSnapshot {
  return {
    kind: 'source_ingestion_ledger',
    generated_at: NOW.toISOString(),
    rows,
    unassigned_corpora: { corpus_count: 0, items: 0, content_indexed: 0, entries: [] },
    attention: [],
    policy: {
      read_only: true,
      raw_source_exposed: false,
      source_text_returned: false,
      castor_safe: true,
    },
  };
}

function dropboxLedgerRow(): SourceIngestionLedgerRow {
  return {
    source_id: 'dropbox',
    label: 'Dropbox',
    primary_corpus_id: 'secure_local.dropbox.files',
    corpus_ids: ['secure_local.dropbox.files'],
    family: 'file',
    trust_domains: ['secure_local'],
    configured: true,
    items: 20_000,
    content_indexed: 3_000,
    metadata_only: 17_000,
    failed: 0,
    coverage_percent: 15,
    stuck: { queued: 19, active: 0, held_paused: 19, broken: 0 },
    ingestion_health: {
      coverage_percent: 15,
      not_read_by_policy_items: 17_000,
      metadata_only_by_policy_items: 17_000,
      stuck_work: { queued: 19, failed_retryable: 0, failed_terminal: 0, by_class: [] },
      drain: { state: 'held', unit: 'olympus-source-processing-supervisor-vlm-pdf.timer' },
    },
    last_sync_at: '2026-07-02T11:20:00.000Z',
    attention: ['19 VLM extraction job(s) queued/paused'],
    failure_breakdown: [
      { status: 'queued', extractor_kind: 'vlm_pdf', count: 19 },
      { status: 'queued', extractor_kind: 'text', count: 4 },
      { status: 'failed_retryable', extractor_kind: 'vlm_pdf', count: 2 },
    ],
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

function gmailHandleRegistry(): ConnectedHandleRegistry {
  return {
    version: 1,
    handles: [{
      handle: 'gmail.personal',
      provider: 'gmail',
      accountRole: 'personal',
      trustDomain: 'secure_local',
      allowedCapabilities: ['gmail.email.sync'],
      scopes: ['https://www.googleapis.com/auth/gmail.readonly'],
      connectedAt: '2026-07-02T10:00:00.000Z',
    }],
  };
}
