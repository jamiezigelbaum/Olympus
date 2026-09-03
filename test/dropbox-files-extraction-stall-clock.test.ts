import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import { assessContentExtractionThroughput } from '../src/core/ingestion-throughput.ts';
import { DROPBOX_FILES_CORPUS_ID } from '../src/workers/dropbox-files/index.ts';
import { LocalFileExtractionJobStore } from '../src/workers/file-extraction/job-store.ts';
import type { ExtractionItemRef } from '../src/workers/file-extraction/types.ts';

const APPROVED_SCOPE = 'dropbox.personal:/Olympus Approved/SECRET_PATH';
const LANE = {
  corpusId: DROPBOX_FILES_CORPUS_ID,
  provider: 'dropbox',
  accountScope: 'personal',
  approvedScopeKey: APPROVED_SCOPE,
} as const;
const EXTRACTOR = { extractorKind: 'local_text', extractorVersion: 'text-v1' } as const;
const REF: ExtractionItemRef = {
  ...LANE,
  providerItemId: 'file-wedged',
  localItemId: 'personal:file-wedged',
  sourceVersion: 'rev-1',
  contentHash: 'dropbox-content-hash',
  name: 'Wedged.txt',
  mimeType: 'text/plain',
  sizeBytes: 64,
};

describe('shared file-extraction stall clock for the Dropbox lane', () => {
  test('pins oldest_actionable_at to job arrival across failure, janitor requeue and lease recycle', async () => {
    await withJobStore(async (jobs, db) => {
      const wedgedAt = new Date(Date.now() - 48 * 3_600_000).toISOString();
      jobs.enqueue({ refs: [REF], ...EXTRACTOR, policyDecision: 'index_allowed' });
      db.query('UPDATE extraction_jobs SET created_at = ?, updated_at = ?').run(wedgedAt, wedgedAt);

      const enqueued = throughput(db);
      const firstLease = jobs.lease({ ...LANE, workerId: 'wedge-worker-1', ...EXTRACTOR });
      expect(firstLease.leasedJobs).toHaveLength(1);
      jobs.record({
        jobId: firstLease.leasedJobs[0]!.jobId,
        workerId: 'wedge-worker-1',
        leaseToken: firstLease.leasedJobs[0]!.leaseToken,
        status: 'failed_retryable',
        errorKind: 'temporary_extractor_failure',
        tempBytesCleaned: true,
      });
      db.query('UPDATE extraction_jobs SET next_retry_at = ?')
        .run(new Date(Date.now() - 1_000).toISOString());
      const afterRetryableDue = throughput(db);

      jobs.janitorRequeue({
        ...LANE,
        mode: 'expired_retryable',
        extractorKindPrefix: 'local_text',
        limit: 10,
        dryRun: false,
        reason: 'stall_clock_test',
      });
      const afterJanitorRequeue = throughput(db);

      const secondLease = jobs.lease({
        ...LANE,
        workerId: 'wedge-worker-2',
        ...EXTRACTOR,
        leaseSeconds: 3_600,
      });
      expect(secondLease.leasedJobs).toHaveLength(1);
      db.query("UPDATE extraction_jobs SET leased_until = '2000-01-01T00:00:00.000Z'").run();
      jobs.recycleLeases({
        ...LANE,
        extractorKindPrefix: 'local_text',
        limit: 10,
        dryRun: false,
        staleOnly: true,
      });
      const afterLeaseRecycle = throughput(db);

      expect(enqueued).toMatchObject({ actionable_queued: 1, oldest_actionable_at: wedgedAt });
      expect(afterRetryableDue).toMatchObject({ actionable_retryable_due: 1, oldest_actionable_at: wedgedAt });
      expect(afterJanitorRequeue).toMatchObject({ actionable_queued: 1, oldest_actionable_at: wedgedAt });
      expect(afterLeaseRecycle).toMatchObject({ actionable_queued: 1, oldest_actionable_at: wedgedAt });
    });
  });

  test('reports a repeatedly retryable shared-factory job as stalled', async () => {
    await withJobStore(async (jobs, db) => {
      const wedgedAt = new Date(Date.now() - 48 * 3_600_000).toISOString();
      jobs.enqueue({ refs: [REF], ...EXTRACTOR, policyDecision: 'index_allowed' });
      db.query('UPDATE extraction_jobs SET created_at = ?, updated_at = ?').run(wedgedAt, wedgedAt);

      for (const attempt of [1, 2]) {
        const workerId = `wedge-worker-${attempt}`;
        const lease = jobs.lease({ ...LANE, workerId, ...EXTRACTOR });
        expect(lease.leasedJobs).toHaveLength(1);
        jobs.record({
          jobId: lease.leasedJobs[0]!.jobId,
          workerId,
          leaseToken: lease.leasedJobs[0]!.leaseToken,
          status: 'failed_retryable',
          errorKind: 'temporary_extractor_failure',
          tempBytesCleaned: true,
        });
        db.query('UPDATE extraction_jobs SET next_retry_at = ?')
          .run(new Date(Date.now() - 1_000).toISOString());
      }

      const assessment = assessContentExtractionThroughput(throughput(db));
      expect(assessment.state).toBe('stalled');
      expect(assessment.actionable).toBe(1);
      expect(assessment.hours_without_terminal_progress).toBeGreaterThanOrEqual(47);
    });
  });
});

async function withJobStore(
  run: (jobs: LocalFileExtractionJobStore, db: Database) => void | Promise<void>,
): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'olympus-dropbox-stall-clock-'));
  const dbPath = join(dir, 'file-extraction-jobs.sqlite');
  const jobs = new LocalFileExtractionJobStore(dbPath);
  const db = new Database(dbPath);
  try {
    await run(jobs, db);
  } finally {
    db.close();
    jobs.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

function throughput(db: Database) {
  const row = db.query(`
    SELECT status, created_at, updated_at, next_retry_at
    FROM extraction_jobs
    WHERE corpus_id = ? AND provider = ? AND account_scope = ? AND approved_scope_key = ?
    LIMIT 1
  `).get(LANE.corpusId, LANE.provider, LANE.accountScope, LANE.approvedScopeKey) as {
    status: string;
    created_at: string;
    updated_at: string;
    next_retry_at: string | null;
  };
  const retryableDue = row.status === 'failed_retryable'
    && (row.next_retry_at === null || Date.parse(row.next_retry_at) <= Date.now());
  const actionable = row.status === 'queued' || retryableDue;
  return {
    actionable_queued: Number(row.status === 'queued'),
    actionable_retryable_due: Number(retryableDue),
    ...(actionable ? { oldest_actionable_at: row.created_at } : {}),
    ...(['indexed', 'skipped_too_large', 'skipped_policy', 'failed_terminal'].includes(row.status)
      ? { newest_terminal_progress_at: row.updated_at }
      : {}),
  };
}
