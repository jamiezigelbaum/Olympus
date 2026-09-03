import { describe, expect, test } from 'bun:test';
import {
  buildRemoteProbeScript,
  buildLiveDashboardState,
  computeRecentProgress,
  normalizeRemoteProbe,
  publicPollErrorMessage,
  renderLiveDashboardHtml,
} from '../scripts/source-ingestion-live-dashboard.ts';

describe('source ingestion live dashboard', () => {
  test('remote probe ignores stale inactive active sync rows', () => {
    const script = buildRemoteProbeScript('secure_local.dropbox.files', '/tmp/dropbox.sqlite');

    expect(script).toContain('ACTIVE_SYNC_STALE_SECONDS = 30 * 60');
    expect(script).toContain('ORDER BY last_activity_at DESC');
	    expect(script).toContain('is_stale_inactive = (');
	    expect(script).toContain('(now - activity_at).total_seconds() > ACTIVE_SYNC_STALE_SECONDS');
    expect(script).toContain('extraction_jobs_leased_current');
    expect(script).toContain('extraction_jobs_leased_expired');
    expect(script).toContain('extraction_jobs_leased_current_actionable');
    expect(script).toContain('extraction_jobs_leased_current_superseded');
    expect(script).toContain('extraction_jobs_leased_current_policy_excluded');
    expect(script).toContain('extraction_jobs_leased_expired_actionable');
    expect(script).toContain('extraction_jobs_leased_expired_superseded');
    expect(script).toContain('extraction_jobs_leased_expired_policy_excluded');
    expect(script).toContain('def leased_expired_sql');
    expect(script).toContain('SOURCE_STATUS_TIMEOUT_SECONDS = 25');
    expect(script).toContain('WORKER_AUTH_TOKEN = os.environ.get("OLYMPUS_WORKER_AUTH_TOKEN", "").strip()');
    expect(script).toContain('def curl_json(config_lines, body=None, timeout=20, include_worker_auth=False):');
    expect(script).toContain('return run(["curl", "-K", "-"], input_text=config, timeout=timeout)');
    expect(script).toContain('curl_json([');
    expect(script).toContain('include_worker_auth=True');
    expect(script).toContain('SQLITE_STATUS_DEADLINE_SECONDS = 12');
    expect(script).toContain('SQLITE_FAST_STATUS_DEADLINE_SECONDS = 5');
    expect(script).toContain('SQLITE_AGGREGATE_DEADLINE_SECONDS = 12');
    expect(script).toContain('SQLITE_FAST_AGGREGATE_DEADLINE_SECONDS = 5');
    expect(script).toContain('def install_sqlite_deadline');
    expect(script).toContain('def db_fast_status_counts');
    expect(script).toContain('def merge_status_counts');
    expect(script).toContain('def db_fast_aggregates');
    expect(script).toContain('ACTIVE_ROOT_PATHS = active_root_paths()');
    expect(script).toContain('def active_path_predicate');
    expect(script).toContain('Archive/global inventory');
    expect(script).toContain('def local_success_sql');
    expect(script).toContain('def stale_scope_sql');
    expect(script).toContain('same_scope = "NOT (" + stale_scope_sql("j", "e") + ")"');
    expect(script).toContain('CONTENT_EXCLUDE_PREFIXES');
    expect(script).toContain('def content_exclusion_sql');
    expect(script).toContain('AND sj.job_id <> {alias}.job_id');
    expect(script).toContain('AND sj.job_id <> j.job_id');
    expect(script).toContain('extraction_jobs_queued_actionable');
    expect(script).toContain('extraction_jobs_queued_superseded');
    expect(script).toContain('extraction_jobs_queued_policy_excluded');
    expect(script).toContain("wrong_lane_visual = \"j.status IN ('queued', 'leased', 'failed_retryable') AND LOWER(j.extractor_kind) LIKE 'venice_%'");
    expect(script).toContain("WHEN j.extractor_kind LIKE 'venice_%' AND {visual_media_sql()}");
    expect(script).toContain("j.extractor_version < '2026-06-24'");
    expect(script).toContain('"Waiting local OCR", same_scope + " AND j.status = \'queued\' AND NOT (" + local_success');
    expect(script).toContain('AND NOT (" + content_excluded + ") AND " + local_ocr');
    expect(script).not.toContain('"olympus-telegram-sync-drain.service"');
    expect(script).not.toContain('"olympus-source-sync-drain.service"');
    expect(script).toContain('out["ocr_helpers"]');
    expect(script).toContain('"ocrmypdf"');
    expect(script).toContain('out["status"] = merge_status_counts(out["status"], fast_counts)');
    expect(script).toContain('out["status_db_error"] = safe_error(exc)');
    expect(script).toContain('out["aggregates"] = db_fast_aggregates(con)');
    expect(script).toContain('out["aggregates_mode"] = "fast"');
    expect(script).toContain('out["aggregates_warning"] = aggregate_warning');
    expect(script).toContain('qa_metadata_only_gap_likely_needs_extraction');
    expect(script).toContain('qa_metadata_only_gap_likely_deferred_metadata_only');
    expect(script).toContain('qa_metadata_only_gap_unknown_or_needs_policy');
    expect(script).toContain('"scope_files"');
    expect(script).toContain('"scope_folders"');
    expect(script).toContain('"file_types": rows(con, f"""');
    expect(script).toContain('"extraction_lanes": rows(con, f"""');
    expect(script).toContain('"embedding_lanes": rows(con, f"""');
    expect(script).toContain('"media_job_groups": media_job_groups(con)');
    expect(script).toContain("WHERE entry_type = 'folder' AND tombstoned = 0");
    expect(script.indexOf('out["status"] = source_worker_status()')).toBeLessThan(script.indexOf('out["aggregates"] = db_aggregates(con)'));
	  });

  test('separates actionable queue from superseded historical queue rows', () => {
    const snapshot = normalizeRemoteProbe({
      sampled_at: '2026-06-24T18:00:00.000Z',
      status: {
        corpora: [{
          corpus_id: 'secure_local.dropbox.files',
          counts: {
            files: 100,
            extraction_jobs_queued: 773,
            extraction_jobs_queued_actionable: 90,
            extraction_jobs_queued_superseded: 664,
            extraction_jobs_queued_policy_excluded: 19,
            extraction_jobs_leased: 0,
            extraction_jobs_failed: 191,
            extraction_jobs_failed_actionable: 10,
            extraction_jobs_failed_superseded: 179,
            extraction_jobs_failed_policy_excluded: 2,
          },
          qa: { total_items: 100, pass: 10 },
        }],
      },
    });

    expect(snapshot.counts.queued).toBe(773);
    expect(snapshot.counts.queuedActionable).toBe(90);
    expect(snapshot.counts.queuedSuperseded).toBe(664);
    expect(snapshot.counts.queuedPolicyExcluded).toBe(19);
    expect(snapshot.counts.failedActionable).toBe(10);
    expect(snapshot.counts.failedSuperseded).toBe(179);
    expect(snapshot.counts.failedPolicyExcluded).toBe(2);
  });

  test('uses actionable queue remaining for queue ETA', () => {
    const baseline = normalizeRemoteProbe({
      sampled_at: '2026-06-27T10:00:00.000Z',
      status: {
        corpora: [{
          corpus_id: 'secure_local.dropbox.files',
          counts: {
            files: 1000,
            extraction_jobs_queued: 900,
            extraction_jobs_queued_actionable: 10,
            extraction_jobs_queued_superseded: 870,
            extraction_jobs_queued_policy_excluded: 20,
          },
          qa: { total_items: 1000, pass: 100 },
        }],
      },
    });
    const latest = normalizeRemoteProbe({
      sampled_at: '2026-06-27T11:00:00.000Z',
      status: {
        corpora: [{
          corpus_id: 'secure_local.dropbox.files',
          counts: {
            files: 1000,
            extraction_jobs_queued: 890,
            extraction_jobs_queued_actionable: 5,
            extraction_jobs_queued_superseded: 865,
            extraction_jobs_queued_policy_excluded: 20,
          },
          qa: { total_items: 1000, pass: 100 },
        }],
      },
    });

    const progress = computeRecentProgress([baseline, latest], new Date('2026-06-27T11:00:00.000Z'));

    expect(progress?.ratesPerHour.queueDrain).toBe(5);
    expect(progress?.eta.queueRemainingHours).toBe(1);
  });

  test('keeps latest file samples but slims dashboard history samples', () => {
    const snapshot = normalizeRemoteProbe({
      sampled_at: '2026-06-27T10:00:00.000Z',
      status: {
        corpora: [{
          corpus_id: 'secure_local.dropbox.files',
          counts: { files: 1 },
          qa: { total_items: 1, pass: 0 },
        }],
      },
      aggregates: {
        file_samples: [{
          group: 'Waiting local OCR',
          name: 'review.pdf',
          status: 'queued',
          path_display: '/1 Projects/review.pdf',
          size_bytes: 1200,
          file_type: 'PDF',
          extractor_kind: 'local_ocr_tesseract',
          extractor_version: 'ocr-v1',
          attempts: 0,
        }],
      },
    });

    const state = buildLiveDashboardState([snapshot], {
      intervalSeconds: 20,
      now: new Date('2026-06-27T10:00:00.000Z'),
    });

    expect(state.latest?.aggregates?.fileSamples).toHaveLength(1);
    expect(state.history[0]?.aggregates?.fileSamples).toEqual([]);
  });

  test('treats aggregate fallback data as usable even when full aggregates warned', () => {
    const snapshot = normalizeRemoteProbe({
      sampled_at: '2026-06-24T19:18:00.000Z',
      status: {
        corpora: [{
          corpus_id: 'secure_local.dropbox.files',
          counts: { files: 10, extraction_jobs_queued: 1 },
          qa: { total_items: 10, pass: 5 },
        }],
      },
      aggregates: {
        file_samples: [],
      },
      aggregates_error: 'interrupted',
    });

    expect(snapshot.aggregateError).toBeNull();
  });

  test('normalizes counts-only live probes and computes recent progress', () => {
    const baseline = normalizeRemoteProbe({
      sampled_at: '2026-06-23T10:00:00.000Z',
      status: {
        generated_at: '2026-06-23T10:00:01.000Z',
        corpora: [{
          corpus_id: 'secure_local.dropbox.files',
          counts: {
            files: 48642,
            folders: 6800,
            secure_local_chunks: 38387,
            embedded_chunks: 30000,
            extraction_artifacts: 9000,
	            extraction_jobs: 19919,
	            extraction_jobs_queued: 5000,
	            extraction_jobs_leased: 100,
	            extraction_jobs_leased_current: 70,
	            extraction_jobs_leased_expired: 30,
	            extraction_jobs_blocked: 30,
            extraction_jobs_skipped: 8200,
            extraction_jobs_failed: 10,
            metadata_sync_folders_total: 100,
            metadata_sync_folders_visited: 40,
            metadata_sync_folders_pending: 58,
            metadata_sync_folders_retryable_failed: 1,
            metadata_sync_folders_blocked: 1,
          },
          qa: {
            total_items: 48642,
            pass: 1000,
            pending: 5900,
            visible_gaps: 42000,
            low_confidence_candidate_for_venice: 3900,
          },
        }],
      },
      health: { ok: true, status: 'ok' },
      source_worker: {
        ActiveState: 'active',
        SubState: 'running',
        MainPID: '123',
        NRestarts: '0',
        MemoryCurrent: '104857600',
        MemoryPeak: '209715200',
        TasksCurrent: '22',
      },
      ocr_helpers: {
        active: 38,
        by_name: { ocrmypdf: 12, tesseract: 20, gs: 6 },
      },
      drain_units: { 'active/running': 64 },
      provider_pauses: [{
        active: true,
        kind: 'venice',
        reason: 'provider_backpressure',
        error_kind: 'venice_http_402',
        created_at: '2026-06-23T10:29:00.000Z',
        message: 'Venice escalation paused because provider reported credit/payment exhaustion.',
      }],
      venice_credit_status: {
        kind: 'venice_credit_status',
        generated_at: '2026-06-23T09:59:00.000Z',
        status: 'credit_exhausted',
        can_consume: false,
        consumption_currency: 'USD',
        balances: { usd: 0, diem: 0 },
        diem_epoch_allocation: 100,
        actions: ['venice: credit balance cannot consume.'],
      },
      aggregates: {
        file_types: [{ label: 'PDF', count: 4000 }],
        job_statuses: [{ label: 'queued', count: 5000 }],
        crawl_frontier_statuses: [{ label: 'visited', count: 500 }, { label: 'pending', count: 50 }],
        scope_files: [{ label: 'Active ingestion roots', count: 48642 }, { label: 'Other indexed scopes', count: 25000 }],
        scope_folders: [{ label: 'Active ingestion roots', count: 6841 }, { label: 'Other indexed scopes', count: 8000 }],
        extraction_lanes: [{ label: 'PDF', files: 4000, extracted: 1500, terminal: 2100 }],
        embedding_lanes: [{ label: 'PDF', files: 4000, chunks: 12000, embedded_chunks: 10000 }],
        media_job_groups: [{
          label: 'Historical broad VLM jobs',
	          planned_jobs: 12,
	          queued_jobs: 10,
	          leased_jobs: 0,
	          leased_current_jobs: 0,
	          leased_expired_jobs: 0,
	          indexed_jobs: 0,
          metadata_only_jobs: 2,
          retryable_jobs: 0,
          failed_terminal_jobs: 0,
          skipped_jobs: 0,
          blocked_jobs: 0,
          completed_jobs: 2,
          active_jobs: 10,
        }],
        planning_files: {
          planned_files: 18000,
          indexed_files: 11000,
          queued_files: 5000,
          leased_files: 100,
          retryable_files: 0,
          failed_terminal_files: 0,
        },
        venice_progress: {
	          planned_jobs: 2,
	          queued_jobs: 1,
	          leased_jobs: 0,
	          leased_current_jobs: 0,
	          leased_expired_jobs: 0,
	          indexed_jobs: 1,
          metadata_only_jobs: 0,
          retryable_jobs: 0,
          failed_terminal_jobs: 0,
          blocked_jobs: 0,
          skipped_jobs: 0,
          completed_jobs: 1,
          active_jobs: 1,
          recipe_statuses: [{ label: 'venice_grok43_document:2026-06-23-grok43-escalation-v1:indexed', count: 1 }],
          error_kind_statuses: [],
        },
        file_samples: [{
          group: 'Running now',
          name: 'active-proof.pdf',
          status: 'leased',
          file_type: 'PDF',
          extractor_kind: 'local_text',
          extractor_version: '2026-05-22',
          attempts: 1,
          updated_at: '2026-06-23T10:00:00.000Z',
        }],
      },
    });

    const latest = normalizeRemoteProbe({
      sampled_at: '2026-06-23T10:30:00.000Z',
      status: {
        generated_at: '2026-06-23T10:30:01.000Z',
        corpora: [{
          corpus_id: 'secure_local.dropbox.files',
          counts: {
            files: 48642,
            folders: 6841,
            secure_local_chunks: 38387,
            embedded_chunks: 31000,
            extraction_artifacts: 9200,
	            extraction_jobs: 19919,
	            extraction_jobs_queued: 4700,
	            extraction_jobs_leased: 80,
	            extraction_jobs_leased_current: 20,
	            extraction_jobs_leased_expired: 60,
	            extraction_jobs_blocked: 28,
            extraction_jobs_skipped: 8250,
            extraction_jobs_failed: 10,
            metadata_sync_folders_total: 100,
            metadata_sync_folders_visited: 45,
            metadata_sync_folders_pending: 53,
            metadata_sync_folders_retryable_failed: 1,
            metadata_sync_folders_blocked: 1,
          },
          qa: {
            total_items: 48642,
            pass: 1200,
            pending: 5700,
            visible_gaps: 41500,
            low_confidence_candidate_for_venice: 4000,
          },
        }],
      },
      health: { ok: true, status: 'ok' },
      source_worker: {
        ActiveState: 'active',
        SubState: 'running',
        MainPID: '123',
        NRestarts: '0',
        MemoryCurrent: '104857600',
        MemoryPeak: '209715200',
        TasksCurrent: '22',
      },
      ocr_helpers: {
        active: 38,
        by_name: { ocrmypdf: 12, tesseract: 20, gs: 6 },
      },
      drain_units: { 'active/running': 64 },
      provider_pauses: [{
        active: true,
        kind: 'venice',
        reason: 'provider_backpressure',
        error_kind: 'venice_http_402',
        created_at: '2026-06-23T10:29:00.000Z',
        message: 'Venice escalation paused because provider reported credit/payment exhaustion.',
      }],
      venice_credit_status: {
        kind: 'venice_credit_status',
        generated_at: '2026-06-23T10:29:30.000Z',
        status: 'credit_exhausted',
        can_consume: false,
        consumption_currency: 'USD',
        balances: { usd: 0, diem: 0 },
        diem_epoch_allocation: 100,
        actions: ['venice: credit balance cannot consume.'],
      },
      aggregates: {
        file_types: [{ label: 'PDF', count: 4000 }, { label: 'Images', count: 3000 }],
        job_statuses: [{ label: 'queued', count: 4700 }, { label: 'leased', count: 80 }],
        crawl_frontier_statuses: [{ label: 'visited', count: 520 }, { label: 'pending', count: 30 }],
        scope_files: [{ label: 'Active ingestion roots', count: 48642 }, { label: 'Other indexed scopes', count: 29685 }],
        scope_folders: [{ label: 'Active ingestion roots', count: 6841 }, { label: 'Other indexed scopes', count: 8129 }],
        extraction_lanes: [{ label: 'PDF', files: 4000, extracted: 1600, terminal: 2200 }],
        embedding_lanes: [{ label: 'PDF', files: 4000, chunks: 12000, embedded_chunks: 10500 }],
        media_job_groups: [
          {
            label: 'Active Delphi VLM repair',
            planned_jobs: 90,
	            queued_jobs: 0,
	            leased_jobs: 80,
	            leased_current_jobs: 20,
	            leased_expired_jobs: 60,
	            indexed_jobs: 10,
            metadata_only_jobs: 0,
            retryable_jobs: 0,
            failed_terminal_jobs: 0,
            skipped_jobs: 0,
            blocked_jobs: 0,
            completed_jobs: 10,
            active_jobs: 80,
          },
          {
            label: 'Historical broad VLM jobs',
            planned_jobs: 12,
	            queued_jobs: 9,
	            leased_jobs: 0,
	            leased_current_jobs: 0,
	            leased_expired_jobs: 0,
	            indexed_jobs: 0,
            metadata_only_jobs: 3,
            retryable_jobs: 0,
            failed_terminal_jobs: 0,
            skipped_jobs: 0,
            blocked_jobs: 0,
            completed_jobs: 3,
            active_jobs: 9,
          },
        ],
        planning_files: {
          planned_files: 18000,
          indexed_files: 11200,
          queued_files: 4700,
          leased_files: 80,
          retryable_files: 0,
          failed_terminal_files: 0,
        },
        active_sync: {
          run_id_hash: 'active-sync-hash',
          started_at: '2026-06-23T10:20:00.000Z',
          status: 'running',
          items_seen: 52217,
          items_indexed: 52217,
          events: 19000,
          upserted: 19000,
          tombstoned: 0,
          skipped: 0,
        },
        venice_progress: {
	          planned_jobs: 5,
	          queued_jobs: 2,
	          leased_jobs: 1,
	          leased_current_jobs: 1,
	          leased_expired_jobs: 0,
	          indexed_jobs: 2,
	          metadata_only_jobs: 0,
          retryable_jobs: 0,
          failed_terminal_jobs: 0,
          blocked_jobs: 0,
          skipped_jobs: 0,
          completed_jobs: 2,
          active_jobs: 3,
          recipe_statuses: [{ label: 'venice_grok43_document:2026-06-23-grok43-escalation-v1:indexed', count: 2 }],
          error_kind_statuses: [
            { label: 'venice_rate_limited:failed_retryable', count: 7 },
            { label: 'venice_http_402:failed_retryable', count: 2 },
          ],
        },
        file_samples: [{
          group: 'Venice lane',
          name: 'image-escalation.png',
          status: 'queued',
          path_display: '/1 Projects/Idea Files/image-escalation.png',
          size_bytes: 1297383,
          superseded_by_local_success: 0,
          file_type: 'Image',
          extractor_kind: 'venice_grok43_document',
          extractor_version: '2026-06-23-grok43-escalation-v1',
          attempts: 0,
          updated_at: '2026-06-23T10:30:00.000Z',
          workflow: 'Venice/Grok escalation',
          phase: 'waiting for worker',
          detail: 'Waiting to be claimed by a worker.',
          download_policy: 'Temporary download, then private Venice request; file bytes are not persisted.',
          policy_decision: 'escalate_private_vision',
          priority: 250,
          max_bytes_per_file: 25000000,
          created_at: '2026-06-23T10:28:00.000Z',
	          next_retry_at: null,
	          last_error_kind: null,
	          temp_bytes_cleaned: null,
	          lease_state: null,
	        }],
      },
    });

    expect(latest.sourceWorker.health).toBe('healthy');
    expect(latest.ocrHelpers.active).toBe(38);
    expect(latest.ocrHelpers.byName.tesseract).toBe(20);
    expect(latest.drainWorkers.active).toBe(64);
    expect(latest.aggregates?.fileTypes.map((row) => row.label)).toEqual(['PDF', 'Images']);
	    expect(latest.aggregates?.veniceProgress).toMatchObject({
	      plannedJobs: 5,
	      leasedCurrentJobs: 1,
	      leasedExpiredJobs: 0,
	      activeJobs: 3,
      completedJobs: 2,
      errorKindStatuses: [
        { label: 'venice_rate_limited:failed_retryable', count: 7 },
        { label: 'venice_http_402:failed_retryable', count: 2 },
      ],
    });
    expect(latest.aggregates?.activeSync).toMatchObject({
      runIdHash: 'active-sync-hash',
      status: 'running',
      itemsSeen: 52217,
      itemsIndexed: 52217,
      events: 19000,
      upserted: 19000,
    });
    expect(latest.aggregates?.scopeFiles).toEqual([
      { label: 'Active ingestion roots', count: 48642 },
      { label: 'Other indexed scopes', count: 29685 },
    ]);
    expect(latest.aggregates?.scopeFolders).toEqual([
      { label: 'Active ingestion roots', count: 6841 },
      { label: 'Other indexed scopes', count: 8129 },
    ]);
	    expect(latest.aggregates?.mediaJobGroups).toEqual([
	      expect.objectContaining({ label: 'Active Delphi VLM repair', plannedJobs: 90, leasedJobs: 80, leasedCurrentJobs: 20, leasedExpiredJobs: 60 }),
	      expect.objectContaining({ label: 'Historical broad VLM jobs', plannedJobs: 12, activeJobs: 9 }),
	    ]);
    expect(latest.providerPauses).toEqual([{
      active: true,
      kind: 'venice',
      reason: 'provider_backpressure',
      errorKind: 'venice_http_402',
      createdAt: '2026-06-23T10:29:00.000Z',
      message: 'Venice escalation paused because provider reported credit/payment exhaustion.',
    }]);
    expect(latest.veniceCreditStatus).toMatchObject({
      status: 'credit_exhausted',
      canConsume: false,
      consumptionCurrency: 'USD',
      balances: { usd: 0, diem: 0 },
      diemEpochAllocation: 100,
    });
    expect(latest.aggregates?.fileSamples[0]).toMatchObject({
      group: 'Venice lane',
      name: 'image-escalation.png',
      status: 'queued',
      pathDisplay: '/1 Projects/Idea Files/image-escalation.png',
      sizeBytes: 1297383,
      supersededByLocalSuccess: false,
      fileType: 'Image',
      extractorKind: 'venice_grok43_document',
      workflow: 'Venice/Grok escalation',
      phase: 'waiting for worker',
      downloadPolicy: 'Temporary download, then private Venice request; file bytes are not persisted.',
      policyDecision: 'escalate_private_vision',
	      priority: 250,
	      maxBytesPerFile: 25000000,
	      leaseState: null,
	    });

	    const progress = computeRecentProgress([baseline, latest], new Date('2026-06-23T10:30:00.000Z'));
	    expect(progress?.deltas.queueRemaining).toBe(-320);
	    expect(progress?.deltas.artifacts).toBe(200);
	    expect(progress?.deltas.qaPass).toBe(200);
	    expect(progress?.ratesPerHour.queueDrain).toBe(640);
	    expect(progress?.ratesPerHour.qaPassGain).toBe(400);
	    expect(progress?.deltas.veniceJobsPlanned).toBe(3);
	    expect(progress?.deltas.veniceJobsCompleted).toBe(1);

	    const legacyBaseline = JSON.parse(JSON.stringify(baseline)) as typeof baseline;
	    delete (legacyBaseline.counts as Partial<typeof legacyBaseline.counts>).leasedCurrent;
	    delete (legacyBaseline.counts as Partial<typeof legacyBaseline.counts>).leasedExpired;
	    const legacyProgress = computeRecentProgress([legacyBaseline, latest], new Date('2026-06-23T10:30:00.000Z'));
	    expect(legacyProgress?.deltas.queueRemaining).toBe(-320);
	    expect(legacyProgress?.ratesPerHour.queueDrain).toBe(640);

	    const state = buildLiveDashboardState([baseline, latest], {
      intervalSeconds: 20,
      now: new Date('2026-06-23T10:30:00.000Z'),
    });
	    expect(state.latest?.counts.queued).toBe(4700);
	    expect(state.latest?.counts.leasedCurrent).toBe(20);
	    expect(state.latest?.counts.leasedExpired).toBe(60);
    expect(state.progress?.windowLabel).toBe('last 30 minutes available');
  });

  test('uses named continuous drain units instead of stale one-shot unit totals', () => {
    const latest = normalizeRemoteProbe({
      sampled_at: '2026-06-24T17:57:00.000Z',
      status: {
        corpora: [{
          corpus_id: 'secure_local.dropbox.files',
          counts: {
            files: 100,
            extraction_jobs_queued: 10,
            extraction_jobs_leased: 20,
            extraction_jobs_failed: 1,
          },
          qa: { total_items: 100, pass: 20 },
        }],
      },
      health: { ok: true, status: 'ok' },
      source_worker: { ActiveState: 'active', SubState: 'running' },
      drain_units: {
        'active/running': 3,
        'inactive/dead': 197,
      },
      drain_unit_details: [
        { unit: 'olympus-source-processing-supervisor.service', active_state: 'active', sub_state: 'running' },
        { unit: 'olympus-source-processing-supervisor-local-ocr.service', active_state: 'active', sub_state: 'running' },
        { unit: 'olympus-source-embedding-drain.service', active_state: 'active', sub_state: 'running' },
        { unit: 'olympus-source-processing-supervisor-local-vlm-visual-repair.service', active_state: 'inactive', sub_state: 'dead' },
        { unit: 'olympus-source-processing-supervisor-venice-grok43.service', active_state: 'inactive', sub_state: 'dead' },
      ],
    });

    expect(latest.drainWorkers.active).toBe(3);
    expect(latest.drainWorkers.inactive).toBe(2);
    expect(latest.drainWorkers.total).toBe(5);
    expect(latest.drainWorkers.services).toEqual([
      expect.objectContaining({ label: 'Default supervisor', activeState: 'active', subState: 'running', health: 'healthy' }),
      expect.objectContaining({ label: 'Local OCR supervisor', activeState: 'active', subState: 'running', health: 'healthy' }),
      expect.objectContaining({ label: 'Embedding drain', activeState: 'active', subState: 'running', health: 'healthy' }),
      expect.objectContaining({ label: 'Local VLM repair supervisor', activeState: 'inactive', subState: 'dead', health: 'unknown' }),
      expect.objectContaining({ label: 'Venice/Grok supervisor', activeState: 'inactive', subState: 'dead', health: 'unknown' }),
    ]);
  });

  test('keeps rework deltas visible without turning them into negative throughput', () => {
    const baseline = normalizeRemoteProbe({
      sampled_at: '2026-06-24T17:00:00.000Z',
      status: {
        corpora: [{
          corpus_id: 'secure_local.dropbox.files',
          counts: {
            files: 100,
            secure_local_chunks: 1000,
            embedded_chunks: 900,
            extraction_artifacts: 200,
            extraction_jobs_queued: 100,
            extraction_jobs_leased: 10,
            extraction_jobs_failed: 5,
          },
          qa: { total_items: 100, pass: 20 },
        }],
      },
    });
    const latest = normalizeRemoteProbe({
      sampled_at: '2026-06-24T17:30:00.000Z',
      status: {
        corpora: [{
          corpus_id: 'secure_local.dropbox.files',
          counts: {
            files: 100,
            secure_local_chunks: 950,
            embedded_chunks: 850,
            extraction_artifacts: 180,
            extraction_jobs_queued: 50,
            extraction_jobs_leased: 20,
            extraction_jobs_failed: 5,
          },
          qa: { total_items: 100, pass: 20 },
        }],
      },
    });

    const progress = computeRecentProgress([baseline, latest], new Date('2026-06-24T17:30:00.000Z'));

    expect(progress?.deltas.artifacts).toBe(-20);
    expect(progress?.deltas.embeddedChunks).toBe(-50);
    expect(progress?.ratesPerHour.artifactGain).toBe(0);
    expect(progress?.ratesPerHour.embeddingGain).toBe(0);
    expect(progress?.ratesPerHour.queueDrain).toBe(80);
  });

  test('renders a live polling page without source content', () => {
    const html = renderLiveDashboardHtml();
    expect(html).toContain('Olympus Live Source Ingestion');
    expect(html).toContain('/api/state');
    expect(html).toContain('Operator Focus');
    expect(html).toContain('Throughput Pulse');
    expect(html).toContain('Actionable Queue');
    expect(html).toContain('Rich Answer Ready');
    expect(html).toContain('Rich answer-ready files');
    expect(html).toContain('Metadata-only policy rows count in overall progress');
    expect(html).toContain('Actionable queue');
    expect(html).toContain('Workers Functioning');
    expect(html).toContain('Venice Credits');
    expect(html).toContain('Bottleneck / Next Action');
    expect(html).toContain('First-screen diagnosis from existing counts only');
    expect(html).toContain('Current bottleneck');
    expect(html).toContain('Active-Root And Full-Corpus Progress');
    expect(html).toContain('Active-root progress is scoped to /1 Projects, /2 Areas, and /3 Resources');
    expect(html).toContain('Global Archive, broad roots, books, media');
    expect(html).toContain('Full-corpus discovery progress');
    expect(html).toContain('full-corpus denominator can grow while active-root answer-ready work catches up');
    expect(html).toContain('Full Corpus Discovery');
    expect(html).toContain('items indexed this run');
    expect(html).toContain('full-corpus files');
    expect(html).toContain('outside active roots');
    expect(html).toContain('Metadata frontier');
    expect(html).toContain('Queue truth');
    expect(html).toContain('policy/on-demand');
    expect(html).toContain('Active drain is clear; remaining gaps need policy or on-demand decisions.');
    expect(html).toContain('queue clear');
    expect(html).toContain('No actionable extraction queue is waiting.');
    expect(html).toContain('stale-scope history');
    expect(html).toContain('Active Service States');
    expect(html).toContain('QA Gap Categories');
    expect(html).toContain('likely need extraction');
    expect(html).toContain('likely deferred inventory');
    expect(html).toContain('need policy review');
    expect(html).toContain('Active-Root And Full-Corpus Progress');
    expect(html).toContain('Metadata sync coverage');
    expect(html).toContain('Active metadata sync pass');
    expect(html).toContain('Known files by planning state');
    expect(html).toContain('Venice Escalation');
    expect(html).toContain('Venice escalation paused');
    expect(html).toContain('Live File Progress');
    expect(html).toContain('Active local text/PDF');
    expect(html).toContain('Waiting local OCR');
	    expect(html).toContain('Waiting Venice/Grok');
	    expect(html).toContain('Historical broad VLM jobs');
	    expect(html).toContain('Stale local leases');
	    expect(html).toContain('Media lane separation');
	    expect(html).toContain('Current, unexpired leases are shown first');
    expect(html).toContain('Terminal book/library inventory is collapsed below');
    expect(html).toContain('Recent terminal and inventory rows');
    expect(html).toContain('Book/library inventory');
    expect(html).toContain('Location');
    expect(html).not.toContain('Superseded old retries');
    expect(html).not.toContain('Already indexed locally; old Venice retry row.');
    expect(html).toContain('not 100% complete');
    expect(html).not.toContain('path_display');
    // Literal owner path on purpose: this is the leak tripwire, not fixture data.
    expect(html).not.toContain('/Users/zig/Library/CloudStorage/Dropbox');
  });

  test('reads QA metrics from the live status count keys', () => {
    const snapshot = normalizeRemoteProbe({
      sampled_at: '2026-06-23T10:00:00.000Z',
      status: {
        corpora: [{
          corpus_id: 'secure_local.dropbox.files',
          counts: {
            files: 10,
            qa_total_items: 10,
            qa_pass: 3,
            qa_metadata_only_gap: 7,
            qa_metadata_only_gap_likely_needs_extraction: 2,
            qa_metadata_only_gap_likely_deferred_metadata_only: 3,
            qa_metadata_only_gap_unknown_or_needs_policy: 2,
            qa_pending: 7,
            qa_visible_gaps: 7,
          },
        }],
      },
      health: { reachable: true, configured: true },
      source_worker: { ActiveState: 'active', SubState: 'running' },
      drain_units: { 'active/running': 4 },
    });

    expect(snapshot.health.ok).toBe(true);
    expect(snapshot.qa.totalItems).toBe(10);
    expect(snapshot.qa.pass).toBe(3);
    expect(snapshot.qa.metadataOnlyGap).toBe(7);
    expect(snapshot.qa.metadataOnlyGapLikelyNeedsExtraction).toBe(2);
    expect(snapshot.qa.metadataOnlyGapLikelyDeferred).toBe(3);
    expect(snapshot.qa.metadataOnlyGapUnknownOrNeedsPolicy).toBe(2);
  });

  test('reads metadata-sync crawl-frontier metrics from live status count keys', () => {
    const snapshot = normalizeRemoteProbe({
      sampled_at: '2026-06-23T10:00:00.000Z',
      status: {
        corpora: [{
          corpus_id: 'secure_local.dropbox.files',
          counts: {
            files: 10,
            folders: 4,
            metadata_sync_folders_total: 5,
            metadata_sync_folders_visited: 3,
            metadata_sync_folders_pending: 1,
            metadata_sync_folders_retryable_failed: 1,
            metadata_sync_folders_blocked: 0,
            qa_total_items: 10,
          },
        }],
      },
      health: { reachable: true, configured: true },
      source_worker: { ActiveState: 'active', SubState: 'running' },
      drain_units: { 'active/running': 4 },
    });

    expect(snapshot.counts.metadataFoldersTotal).toBe(5);
    expect(snapshot.counts.metadataFoldersVisited).toBe(3);
    expect(snapshot.counts.metadataFoldersPending).toBe(1);
    expect(snapshot.counts.metadataFoldersRetryableFailed).toBe(1);
  });

  test('sanitizes raw polling failures for the product surface', () => {
    expect(publicPollErrorMessage(
      "ssh exited 1: Command '['curl', '-fsS', '--max-time', '25']' returned non-zero exit status 7.",
    )).toBe('Could not reach the private-host source-worker status endpoint on this poll.');
    expect(publicPollErrorMessage('some private command detail')).toBe('The live status poll failed.');
  });
});
