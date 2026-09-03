import { describe, expect, test } from 'bun:test';
import {
  buildSourceIngestionDashboardViewModel,
  renderSourceIngestionDashboardHtml,
} from '../scripts/source-ingestion-dashboard.ts';

describe('source ingestion dashboard', () => {
  test('renders Dropbox ingestion progress without raw source paths', () => {
    const model = buildSourceIngestionDashboardViewModel({
      readiness: {
        kind: 'source_readiness_proof',
        generated_at: '2026-06-23T08:03:33.572Z',
        status: 'attention',
        approved_non_message_corpora: [{
          corpus_id: 'secure_local.dropbox.files',
          family: 'file',
          trust_domain: 'secure_local',
          status: 'attention',
          counts: {
            indexed_items: 100,
            chunks: 50,
            embedded_chunks: 40,
            sync_runs: 3,
            extraction_failed: 2,
            extraction_queued: 20,
            extraction_leased: 3,
          },
          qa: {
            total_items: 100,
            pass: 10,
            metadata_only_expected: 5,
            metadata_only_gap: 30,
            low_confidence_retry_local: 4,
            low_confidence_candidate_for_venice: 6,
            blocked_policy: 2,
            failed_needs_operator: 0,
            pending: 43,
            visible_gaps: 40,
            low_confidence: 10,
          },
          embedding: {
            required: true,
            ready: false,
            coverage_ratio: 0.8,
          },
          actions: [],
        }],
        actions: [],
      },
      supervisor: {
        kind: 'source_processing_supervisor_report',
        generated_at: '2026-06-23T08:01:41.098Z',
        status: 'attention',
        cycles_run: 3,
        exhausted_cycle_budget: true,
        exhausted_time_budget: false,
        scopes: [{
          scope_key_hash: '933d4c6abe9c22d4',
          status: 'attention',
          cycles_run: 1,
          jobs_leased: 0,
          jobs_planned: 0,
          terminal_progress_jobs: 0,
          failed_retryable_jobs: 0,
          embed_runs: 0,
          counts: {},
          errors: ['The operation was aborted.'],
          before: {
            indexed_items: 10,
            chunks: 2,
            embedded_chunks: 1,
            extraction_queued: 0,
            extraction_leased: 3,
            extraction_failed: 2,
          },
        }],
        summary: {
          jobs_leased: 4,
          jobs_planned: 25,
          jobs_existing: 0,
          terminal_progress_jobs: 4,
          failed_retryable_jobs: 0,
          embed_runs: 0,
          queued_before: 18,
          queued_after: 20,
          leased_before: 3,
          leased_after: 3,
        },
        actions: [],
      },
      aggregates: {
        file_types: [
          { label: 'PDF', count: 40 },
          { label: 'Images', count: 30 },
          { label: 'Word documents', count: 10 },
        ],
        mime_types: [
          { label: 'application/pdf', count: 40 },
          { label: 'image/heif', count: 30 },
        ],
        extraction_statuses: [
          { label: 'metadata_only', count: 30 },
          { label: 'indexed', count: 10 },
        ],
        job_statuses: [
          { label: 'queued', count: 20 },
          { label: 'indexed', count: 10 },
          { label: 'failed_retryable', count: 2 },
        ],
        failed_error_kinds: [
          { label: 'provider_timeout', count: 2 },
        ],
        extractor_kinds: [
          { label: 'local_text', count: 22 },
        ],
        sync_job_statuses: [
          { label: 'completed', count: 5 },
          { label: 'leased', count: 1 },
        ],
        crawl_frontier_statuses: [
          { label: 'visited', count: 10 },
          { label: 'pending', count: 3 },
          { label: 'retryable_failed', count: 1 },
        ],
        embedding_lanes: [
          { label: 'PDF', files: 40, chunks: 30, embedded_chunks: 20 },
          { label: 'Images', files: 30, chunks: 10, embedded_chunks: 10 },
        ],
        extraction_lanes: [
          { label: 'PDF', files: 40, extracted: 12, terminal: 30 },
          { label: 'Images', files: 30, extracted: 2, terminal: 28 },
        ],
        planning_files: {
          planned_files: 32,
          indexed_files: 10,
          queued_files: 20,
          leased_files: 0,
          retryable_files: 2,
          failed_terminal_files: 0,
        },
        chunked_files: 12,
        artifact_files: 8,
      },
      generatedAt: new Date('2026-06-23T08:05:00.000Z'),
      timerIntervalMinutes: 10,
      latestRunDurationSeconds: 212,
    });

    const html = renderSourceIngestionDashboardHtml(model);
    expect(model.throughput.scheduledJobsPerHour).toBe(24);
    expect(model.phases.map((phase) => phase.title)).toEqual([
      'Metadata Sync',
      'Plan & Queue',
      'Full Extraction',
      'Classify & QA',
      'Embeddings',
      'Answer Ready',
    ]);
    expect(html).toContain('Olympus Source Ingestion');
    expect(html).toContain('How Ingestion Works');
    expect(html).toContain('Overall Answer Ready');
    expect(html).toContain('10 / 100 files');
    expect(html).toContain('the file denominator can still grow');
    expect(html).toContain('Phase Monitors');
    expect(html).toContain('Metadata Sync');
    expect(html).toContain('Plan &amp; Queue');
    expect(html).toContain('Full Extraction');
    expect(html).toContain('Classify &amp; QA');
    expect(html).toContain('Embeddings');
    expect(html).toContain('Answer Ready');
    expect(html).toContain('Known folders synced');
    expect(html).toContain('10 / 14 folders');
    expect(html).toContain('Known files planned for work');
    expect(html).toContain('32 / 100 files');
    expect(html).toContain('Ready now: planned files indexed');
    expect(html).toContain('10 indexed / 32 planned files');
    expect(html).toContain('Queued files');
    expect(html).toContain('Indexed files');
    expect(html).toContain('Known full-extraction candidates processed');
    expect(html).toContain('Ready now: planned files text-extracted');
    expect(html).toContain('Current speed');
    expect(html).toContain('PDF');
    expect(html).toContain('12 text-extracted / 40 files');
    expect(html).toContain('20 / 30 chunks');
    expect(html).not.toContain('pie');
    expect(html).not.toContain('Visited folders');
    expect(html).not.toContain('Crawl frontier');
    expect(html).toContain('Files mapped');
    expect(html).toContain('Queue remaining');
    expect(html).toContain('/1 Projects');
    expect(html).toContain('The operation was aborted.');
    expect(html).toContain('What Else To Monitor');
    // Literal owner path on purpose: this is the leak tripwire, not fixture data.
    expect(html).not.toContain('/Users/zig/Library/CloudStorage/Dropbox');
    expect(html).not.toContain('path_display');
  });
});
