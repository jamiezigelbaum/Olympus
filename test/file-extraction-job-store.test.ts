// Unit coverage for the generic extraction job side database.
//
// The lease/retry/janitor semantics here are a port of a queue that runs a
// live extraction fleet, so these tests are parity tests first and design
// tests second: eligibility predicate, atomic claim, attempt accounting,
// linear backoff, terminal escalation, the one-terminal-requeue-ever guard and
// its network override, and the escalate-to-another-extractor pass.
//
// Time is moved by writing timestamps directly through a second connection to
// the same file. That is deliberate: the store reads the wall clock exactly
// where the ported original does, and faking the clock in the store would test
// a seam that production does not have.

import { Database } from 'bun:sqlite';
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DEFAULT_EXTRACTION_LEASE_LIMIT,
  DEFAULT_EXTRACTION_LEASE_SECONDS,
  DEFAULT_EXTRACTION_RETRY_BACKOFF_SECONDS,
  FILE_EXTRACTION_JOBS_DB_PATH_ENV,
  FILE_EXTRACTION_JOBS_SCHEMA_VERSION,
  FILE_EXTRACTION_JOBS_STORE_ID,
  LocalFileExtractionJobStore,
  MAX_EXTRACTION_RETRY_ATTEMPTS,
  MAX_EXTRACTION_RETRY_BACKOFF_SECONDS,
  defaultFileExtractionJobsDbPath,
} from '../src/workers/file-extraction/job-store.ts';
import { createExtractionReadinessLedger } from '../src/workers/file-extraction/readiness-ledger.ts';
import type { ExtractionItemRef, ExtractionTerminalStatus } from '../src/workers/file-extraction/types.ts';

const LANE = {
  corpusId: 'secure_local.files.primary',
  provider: 'example_provider',
  accountScope: 'owner@example.com',
  approvedScopeKey: 'example_provider.personal:/Work Files',
};

const KIND = 'local_text';
const VERSION = '2026-05-22';

const openStores: LocalFileExtractionJobStore[] = [];
const openRoots: string[] = [];

afterEach(() => {
  while (openStores.length > 0) {
    try {
      openStores.pop()?.close();
    } catch {
      // A test may have closed the store itself; cleanup must not mask it.
    }
  }
  while (openRoots.length > 0) {
    rmSync(openRoots.pop()!, { recursive: true, force: true });
  }
});

function newStore(): { store: LocalFileExtractionJobStore; dbPath: string } {
  const root = mkdtempSync(join(tmpdir(), 'olympus-extraction-jobs-'));
  openRoots.push(root);
  const dbPath = join(root, 'file-extraction-jobs.sqlite');
  const store = new LocalFileExtractionJobStore(dbPath);
  openStores.push(store);
  return { store, dbPath };
}

function ref(providerItemId: string, overrides: Partial<ExtractionItemRef> = {}): ExtractionItemRef {
  return {
    corpusId: LANE.corpusId,
    provider: LANE.provider,
    accountScope: LANE.accountScope,
    approvedScopeKey: LANE.approvedScopeKey,
    providerItemId,
    localItemId: `${LANE.accountScope}:${providerItemId}`,
    sourceVersion: `${providerItemId}-v1`,
    contentHash: `hash-${providerItemId}`,
    name: `${providerItemId}.pdf`,
    mimeType: 'application/pdf',
    sizeBytes: 1_024,
    ...overrides,
  };
}

function enqueueOne(store: LocalFileExtractionJobStore, providerItemId: string, options: {
  priority?: number;
  kind?: string;
  version?: string;
} = {}): string {
  const result = store.enqueue({
    refs: [ref(providerItemId)],
    extractorKind: options.kind ?? KIND,
    extractorVersion: options.version ?? VERSION,
    policyDecision: 'index_allowed',
    ...(options.priority === undefined ? {} : { priority: options.priority }),
  });
  return result.jobRefs[0]!.jobId;
}

/**
 * Move a job's clock-sensitive columns into the past through a second
 * connection, so eligibility windows can be exercised without waiting.
 */
function backdate(dbPath: string, jobId: string, columns: Record<string, string | number | null>): void {
  const db = new Database(dbPath);
  db.exec('PRAGMA busy_timeout = 10000;');
  const assignments = Object.keys(columns).map((column) => `${column} = ?`).join(', ');
  db.query(`UPDATE extraction_jobs SET ${assignments} WHERE job_id = ?`)
    .run(...Object.values(columns), jobId);
  db.close();
}

function isoSecondsFromNow(seconds: number): string {
  return new Date(Date.now() + seconds * 1_000).toISOString();
}

describe('extraction job store: module identity', () => {
  test('store id, schema version and default path follow the side-DB precedent', () => {
    expect(FILE_EXTRACTION_JOBS_STORE_ID).toBe('file-extraction-jobs');
    expect(FILE_EXTRACTION_JOBS_SCHEMA_VERSION).toBe(3);
    expect(defaultFileExtractionJobsDbPath({ XDG_DATA_HOME: '/data' }))
      .toBe('/data/openclaw/olympus/file-extraction-jobs.sqlite');
    expect(defaultFileExtractionJobsDbPath({
      XDG_DATA_HOME: '/data',
      [FILE_EXTRACTION_JOBS_DB_PATH_ENV]: '/override/jobs.sqlite',
    })).toBe('/override/jobs.sqlite');
  });

  test('ported constants keep their production values', () => {
    expect(DEFAULT_EXTRACTION_LEASE_LIMIT).toBe(10);
    expect(DEFAULT_EXTRACTION_LEASE_SECONDS).toBe(900);
    expect(DEFAULT_EXTRACTION_RETRY_BACKOFF_SECONDS).toBe(300);
    expect(MAX_EXTRACTION_RETRY_BACKOFF_SECONDS).toBe(3_600);
    expect(MAX_EXTRACTION_RETRY_ATTEMPTS).toBe(3);
  });

  test('a read-only handle refuses every write', () => {
    const { store, dbPath } = newStore();
    enqueueOne(store, 'item-a');
    store.close();

    const reader = new LocalFileExtractionJobStore(dbPath, { readonly: true });
    openStores.push(reader);
    expect(reader.counts(LANE).map((entry) => entry.jobs)).toEqual([1]);
    expect(() => reader.lease({ ...LANE, workerId: 'worker-1' })).toThrow(/read-only/);
    expect(() => reader.enqueue({
      refs: [ref('item-b')],
      extractorKind: KIND,
      extractorVersion: VERSION,
      policyDecision: 'index_allowed',
    })).toThrow(/read-only/);
  });
});

describe('extraction job store: enqueue', () => {
  test('a repeat enqueue of the same identity reuses the job rather than duplicating it', () => {
    const { store } = newStore();
    const first = store.enqueue({
      refs: [ref('item-a')],
      extractorKind: KIND,
      extractorVersion: VERSION,
      policyDecision: 'index_allowed',
    });
    const second = store.enqueue({
      refs: [ref('item-a')],
      extractorKind: KIND,
      extractorVersion: VERSION,
      policyDecision: 'index_allowed',
    });

    expect(first.jobsQueued).toBe(1);
    expect(second.jobsQueued).toBe(0);
    expect(second.jobsExisting).toBe(1);
    expect(second.jobRefs[0]!.jobId).toBe(first.jobRefs[0]!.jobId);
  });

  test('the dedupe key includes the extractor, so a second extractor gets its own job', () => {
    const { store } = newStore();
    const textJob = enqueueOne(store, 'item-a');
    const ocrJob = enqueueOne(store, 'item-a', { kind: 'local_ocr_tesseract', version: 'ocr-v1' });
    expect(ocrJob).not.toBe(textJob);
  });

  test('an item over the byte ceiling is enqueued as skipped_too_large, not queued', () => {
    const { store } = newStore();
    const result = store.enqueue({
      refs: [ref('item-big', { sizeBytes: 10_000 })],
      extractorKind: KIND,
      extractorVersion: VERSION,
      policyDecision: 'index_allowed',
      maxBytesPerFile: 1_000,
    });
    expect(result.jobsSkippedTooLarge).toBe(1);
    expect(store.get(result.jobRefs[0]!.jobId)?.status).toBe('skipped_too_large');
  });

  test('force resets a spent job back to queued and clears its error state', () => {
    const { store } = newStore();
    const jobId = enqueueOne(store, 'item-a');
    store.lease({ ...LANE, workerId: 'worker-1' });
    store.record({ jobId, status: 'failed_terminal', errorKind: 'extractor_crashed' });

    const forced = store.enqueue({
      refs: [ref('item-a')],
      extractorKind: KIND,
      extractorVersion: VERSION,
      policyDecision: 'index_allowed',
      force: true,
    });

    expect(forced.jobsForced).toBe(1);
    const job = store.get(jobId)!;
    expect(job.status).toBe('queued');
    expect(job.attempts).toBe(0);
    expect(job.lastErrorKind).toBeUndefined();
  });

  test('a re-plan that names no decision leaves the stored policy decision alone', () => {
    // An omitted policy_decision means "the caller has nothing to say about
    // this", not "index_allowed". Reading it as the latter let a requalify pass
    // silently relax the decision leg of the remote-egress gate.
    const { store } = newStore();
    const restricted = store.enqueue({
      refs: [ref('item-a')],
      extractorKind: KIND,
      extractorVersion: VERSION,
      policyDecision: 'needs_review',
    });
    const jobId = restricted.jobRefs[0]!.jobId;

    store.enqueue({
      refs: [ref('item-a')],
      extractorKind: KIND,
      extractorVersion: VERSION,
      force: true,
    });
    expect(store.get(jobId)?.policyDecision).toBe('needs_review');

    // An explicit re-stamp still lands, in either direction.
    store.enqueue({
      refs: [ref('item-a')],
      extractorKind: KIND,
      extractorVersion: VERSION,
      policyDecision: 'blocked_sensitive',
    });
    expect(store.get(jobId)?.policyDecision).toBe('blocked_sensitive');
    store.enqueue({
      refs: [ref('item-a')],
      extractorKind: KIND,
      extractorVersion: VERSION,
      policyDecision: 'index_allowed',
    });
    expect(store.get(jobId)?.policyDecision).toBe('index_allowed');
  });

  test('a first enqueue with no decision still stores one', () => {
    const { store } = newStore();
    const created = store.enqueue({
      refs: [ref('item-a')],
      extractorKind: KIND,
      extractorVersion: VERSION,
    });
    expect(store.get(created.jobRefs[0]!.jobId)?.policyDecision).toBe('index_allowed');
  });

  test('a ref with no version or hash still dedupes, despite SQL NULL semantics', () => {
    // NULLs compare distinct in a UNIQUE index, so an absent version stored as
    // NULL would let the same item enqueue forever. The port keeps the
    // original's empty-string encoding for exactly this reason.
    const { store } = newStore();
    const bare = ref('item-bare');
    delete bare.sourceVersion;
    delete bare.contentHash;

    store.enqueue({ refs: [bare], extractorKind: KIND, extractorVersion: VERSION, policyDecision: 'index_allowed' });
    const second = store.enqueue({
      refs: [bare], extractorKind: KIND, extractorVersion: VERSION, policyDecision: 'index_allowed',
    });
    expect(second.jobsExisting).toBe(1);
    expect(store.counts(LANE)).toEqual([{ status: 'queued', extractorKind: KIND, jobs: 1 }]);
  });
});

describe('extraction job store: lease', () => {
  test('a claim leases the job, charges an attempt, and returns the whole ref', () => {
    const { store } = newStore();
    const jobId = enqueueOne(store, 'item-a');
    const leased = store.lease({ ...LANE, workerId: 'worker-1' });

    expect(leased.leasedJobs).toHaveLength(1);
    const job = leased.leasedJobs[0]!;
    expect(job.jobId).toBe(jobId);
    expect(job.attempts).toBe(1);
    expect(job.ref).toEqual(ref('item-a'));
    expect(job.extractorKind).toBe(KIND);
    expect(Date.parse(job.leaseExpiresAt)).toBeGreaterThan(Date.now());
    expect(store.get(jobId)?.status).toBe('leased');
  });

  test('a live lease is invisible to a second worker', () => {
    const { store } = newStore();
    enqueueOne(store, 'item-a');
    expect(store.lease({ ...LANE, workerId: 'worker-1' }).leasedJobs).toHaveLength(1);
    expect(store.lease({ ...LANE, workerId: 'worker-2' }).leasedJobs).toHaveLength(0);
  });

  test('an expired lease is re-claimable, and the attempt count keeps climbing', () => {
    const { store, dbPath } = newStore();
    const jobId = enqueueOne(store, 'item-a');
    store.lease({ ...LANE, workerId: 'worker-1' });
    backdate(dbPath, jobId, { leased_until: isoSecondsFromNow(-1) });

    const reclaimed = store.lease({ ...LANE, workerId: 'worker-2' });
    expect(reclaimed.leasedJobs).toHaveLength(1);
    expect(reclaimed.leasedJobs[0]!.attempts).toBe(2);
    expect(store.get(jobId)?.leasedByHash).toBe(reclaimed.workerIdHash);
  });

  test('leases come out in priority then age order', () => {
    const { store, dbPath } = newStore();
    const low = enqueueOne(store, 'item-low');
    const old = enqueueOne(store, 'item-old');
    const high = enqueueOne(store, 'item-high', { priority: 5 });
    backdate(dbPath, old, { updated_at: isoSecondsFromNow(-3_600) });

    const leased = store.lease({ ...LANE, workerId: 'worker-1' });
    expect(leased.leasedJobs.map((job) => job.jobId)).toEqual([high, old, low]);
  });

  test('the lease limit is clamped and honoured', () => {
    const { store } = newStore();
    for (const id of ['a', 'b', 'c']) enqueueOne(store, `item-${id}`);
    expect(store.lease({ ...LANE, workerId: 'worker-1', limit: 2 }).leasedJobs).toHaveLength(2);
    expect(store.lease({ ...LANE, workerId: 'worker-2', limit: 0 }).leasedJobs).toHaveLength(1);
  });

  test('a lease can be narrowed to one extractor kind', () => {
    const { store } = newStore();
    enqueueOne(store, 'item-a');
    const ocrJob = enqueueOne(store, 'item-b', { kind: 'local_ocr_tesseract', version: 'ocr-v1' });
    const leased = store.lease({ ...LANE, workerId: 'worker-1', extractorKind: 'local_ocr_tesseract' });
    expect(leased.leasedJobs.map((job) => job.jobId)).toEqual([ocrJob]);
  });

  test('another lane is never visible, even for the same provider and account', () => {
    const { store } = newStore();
    enqueueOne(store, 'item-a');
    const other = store.lease({
      ...LANE,
      corpusId: 'internal.files.secondary',
      workerId: 'worker-1',
    });
    expect(other.leasedJobs).toHaveLength(0);
  });

  test('the reported scope and worker are hashes, never the raw values', () => {
    const { store } = newStore();
    enqueueOne(store, 'item-a');
    const leased = store.lease({ ...LANE, workerId: 'worker-1' });
    expect(leased.scopeKeyHash).not.toContain('Work Files');
    expect(leased.workerIdHash).not.toContain('worker-1');
    expect(leased.scopeKeyHash).toHaveLength(64);
  });
});

describe('extraction job store: record, retry and lost leases', () => {
  test('a successful record comes to rest with no retry scheduled', () => {
    const { store } = newStore();
    const jobId = enqueueOne(store, 'item-a');
    store.lease({ ...LANE, workerId: 'worker-1' });
    const recorded = store.record({ jobId, workerId: 'worker-1', status: 'indexed' });

    expect(recorded.status).toBe('indexed');
    expect(recorded.nextRetryAt).toBeUndefined();
    const job = store.get(jobId)!;
    expect(job.status).toBe('indexed');
    expect(job.leasedUntil).toBeUndefined();
    expect(job.leasedByHash).toBeUndefined();
  });

  test('a retryable failure backs off linearly, five minutes per attempt', () => {
    const { store } = newStore();
    const jobId = enqueueOne(store, 'item-a');
    store.lease({ ...LANE, workerId: 'worker-1' });
    const before = Date.now();
    const recorded = store.record({ jobId, status: 'failed_retryable', errorKind: 'extractor_timeout' });

    expect(recorded.status).toBe('failed_retryable');
    const delayMs = Date.parse(recorded.nextRetryAt!) - before;
    expect(delayMs).toBeGreaterThanOrEqual(DEFAULT_EXTRACTION_RETRY_BACKOFF_SECONDS * 1_000 - 1_000);
    expect(delayMs).toBeLessThanOrEqual(DEFAULT_EXTRACTION_RETRY_BACKOFF_SECONDS * 1_000 + 1_000);
  });

  test('backoff scales with the attempt count', () => {
    // The one-hour ceiling is unreachable in practice and that is faithful to
    // the queue this ports: escalation to terminal fires at three attempts,
    // while the cap needs twelve. Only the first and second retries can ever
    // schedule a backoff, so those are what is asserted.
    const { store, dbPath } = newStore();
    const jobId = enqueueOne(store, 'item-a');
    store.lease({ ...LANE, workerId: 'worker-1' });
    store.record({ jobId, status: 'failed_retryable', errorKind: 'extractor_timeout' });
    backdate(dbPath, jobId, { next_retry_at: isoSecondsFromNow(-1) });

    const second = store.lease({ ...LANE, workerId: 'worker-1' });
    expect(second.leasedJobs[0]!.attempts).toBe(2);
    const before = Date.now();
    const recorded = store.record({ jobId, status: 'failed_retryable', errorKind: 'extractor_timeout' });

    const delayMs = Date.parse(recorded.nextRetryAt!) - before;
    const expectedMs = DEFAULT_EXTRACTION_RETRY_BACKOFF_SECONDS * 2 * 1_000;
    expect(delayMs).toBeGreaterThanOrEqual(expectedMs - 1_000);
    expect(delayMs).toBeLessThanOrEqual(expectedMs + 1_000);
    expect(expectedMs).toBeLessThan(MAX_EXTRACTION_RETRY_BACKOFF_SECONDS * 1_000);
  });

  test('a job in backoff is not leasable until its retry time arrives', () => {
    const { store, dbPath } = newStore();
    const jobId = enqueueOne(store, 'item-a');
    store.lease({ ...LANE, workerId: 'worker-1' });
    store.record({ jobId, status: 'failed_retryable', errorKind: 'extractor_timeout' });

    expect(store.lease({ ...LANE, workerId: 'worker-1' }).leasedJobs).toHaveLength(0);
    backdate(dbPath, jobId, { next_retry_at: isoSecondsFromNow(-1) });
    expect(store.lease({ ...LANE, workerId: 'worker-1' }).leasedJobs).toHaveLength(1);
  });

  test('a retryable failure against an exhausted budget escalates to terminal', () => {
    const { store, dbPath } = newStore();
    const jobId = enqueueOne(store, 'item-a');
    store.lease({ ...LANE, workerId: 'worker-1' });
    backdate(dbPath, jobId, { attempts: MAX_EXTRACTION_RETRY_ATTEMPTS });

    const recorded = store.record({ jobId, status: 'failed_retryable', errorKind: 'extractor_timeout' });
    expect(recorded.status).toBe('failed_terminal');
    expect(recorded.nextRetryAt).toBeUndefined();
    expect(store.lease({ ...LANE, workerId: 'worker-1' }).leasedJobs).toHaveLength(0);
  });

  test('a lost lease is refused rather than allowed to overwrite the newer holder', () => {
    const { store, dbPath } = newStore();
    const jobId = enqueueOne(store, 'item-a');
    store.lease({ ...LANE, workerId: 'worker-1' });
    backdate(dbPath, jobId, { leased_until: isoSecondsFromNow(-1) });
    store.lease({ ...LANE, workerId: 'worker-2' });

    // worker-1 finishes late: its lease is gone and worker-2 holds the job.
    expect(() => store.record({ jobId, workerId: 'worker-1', status: 'indexed' }))
      .toThrow(/does not hold the job lease/);
    expect(store.get(jobId)?.status).toBe('leased');
    expect(store.record({ jobId, workerId: 'worker-2', status: 'indexed' }).status).toBe('indexed');
  });

  test('a superseded run in the SAME worker process is refused by its lease grant', () => {
    // The deployment runs every overlapping extract pass under one worker id,
    // so a worker-identity comparison alone can never separate two runs. The
    // grant they were each handed can.
    const { store, dbPath } = newStore();
    const jobId = enqueueOne(store, 'item-a');
    // Identical lease windows on purpose: even when two claims land in the
    // same millisecond and hand out the same expiry, their tokens differ.
    const superseded = store.lease({ ...LANE, workerId: 'worker-1', leaseSeconds: 900 }).leasedJobs[0]!;
    backdate(dbPath, jobId, { leased_until: isoSecondsFromNow(-1) });
    const holder = store.lease({ ...LANE, workerId: 'worker-1', leaseSeconds: 900 }).leasedJobs[0]!;
    expect(holder.leaseToken).not.toBe(superseded.leaseToken);
    expect(holder.jobId).toBe(jobId);

    expect(() => store.record({
      jobId,
      workerId: 'worker-1',
      leaseToken: superseded.leaseToken,
      status: 'metadata_only',
    })).toThrow(/does not hold the job lease/);
    expect(store.get(jobId)?.status).toBe('leased');

    expect(store.record({
      jobId,
      workerId: 'worker-1',
      leaseToken: holder.leaseToken,
      status: 'indexed',
    }).status).toBe('indexed');
  });

  test('recording against an unleased or unknown job is refused', () => {
    const { store } = newStore();
    const jobId = enqueueOne(store, 'item-a');
    expect(() => store.record({ jobId, status: 'indexed' })).toThrow(/requires a leased job/);
    expect(() => store.record({ jobId: 'fx_missing', status: 'indexed' })).toThrow(/unknown job/);
  });

  test('only categorical error markers are persisted, never free-form text', () => {
    const { store } = newStore();
    const jobId = enqueueOne(store, 'item-a');
    store.lease({ ...LANE, workerId: 'worker-1' });
    expect(() => store.record({
      jobId,
      status: 'failed_retryable',
      errorKind: 'the private file /Users/owner/secret.pdf could not be read',
    })).toThrow(/safe categorical token/);
    expect(() => store.record({
      jobId, status: 'failed_retryable', errorKind: 'read_failed', errorHash: 'not-a-digest',
    })).toThrow(/hexadecimal digest/);
  });

  test('structural provenance is stored on the job side and read back by item', () => {
    const { store } = newStore();
    const jobId = enqueueOne(store, 'item-a');
    store.lease({ ...LANE, workerId: 'worker-1' });
    const recorded = store.record({
      jobId,
      status: 'indexed',
      derivations: [
        { artifactKind: 'page', structuralRef: { kind: 'page', page: 7 }, confidence: 0.9, chars: 120 },
        { artifactKind: 'page', structuralRef: { kind: 'page', page: 8 }, warnings: ['low_contrast'], chars: 80 },
      ],
    });

    expect(recorded.artifactsRecorded).toBe(2);
    const artifacts = store.artifacts(LANE.corpusId, `${LANE.accountScope}:item-a`);
    expect(artifacts).toHaveLength(2);
    expect(artifacts[0]!.derivation.structuralRef).toEqual({ kind: 'page', page: 7 });
    expect(artifacts[1]!.derivation.warnings).toEqual(['low_contrast']);
    expect(artifacts[0]!.extractorKind).toBe(KIND);
  });
});

describe('extraction job store: unattempted lease release', () => {
  test('a stale batch cannot release the claim that superseded it', () => {
    const { store, dbPath } = newStore();
    const jobId = enqueueOne(store, 'item-fenced');

    // The whole fleet runs under one worker id, so the worker hash cannot tell
    // two claims apart. Only the per-grant token can.
    const stale = store.lease({ ...LANE, workerId: 'fleet' });
    const staleClaim = stale.leasedJobs[0]!;
    expect(staleClaim.attempts).toBe(1);

    backdate(dbPath, jobId, { leased_until: isoSecondsFromNow(-1) });
    const live = store.lease({ ...LANE, workerId: 'fleet' });
    const liveClaim = live.leasedJobs[0]!;
    expect(liveClaim.attempts).toBe(2);
    expect(liveClaim.leaseToken).not.toBe(staleClaim.leaseToken);

    // The abandoned batch hands its lease back. It must not touch the claim
    // that is mid-flight, or it launders real work into a free retry.
    const released = store.releaseLeasesWithoutAttempt({
      jobIds: [jobId],
      workerId: 'fleet',
      leaseToken: staleClaim.leaseToken,
    });
    expect(released.releasedJobs).toBe(0);
    expect(store.get(jobId)?.status).toBe('leased');
    expect(store.get(jobId)?.attempts).toBe(2);
  });

  test('the holder of the current claim releases it and gets the attempt back', () => {
    const { store } = newStore();
    const jobId = enqueueOne(store, 'item-refund');

    const claim = store.lease({ ...LANE, workerId: 'fleet' });
    expect(claim.leasedJobs[0]!.attempts).toBe(1);

    const released = store.releaseLeasesWithoutAttempt({
      jobIds: [jobId],
      workerId: 'fleet',
      leaseToken: claim.leasedJobs[0]!.leaseToken,
    });
    expect(released.releasedJobs).toBe(1);
    expect(store.get(jobId)?.status).toBe('queued');
    expect(store.get(jobId)?.attempts).toBe(0);
  });
});

describe('extraction job store: lease recycling', () => {
  test('a recycled lease returns to the queue without charging the next attempt', () => {
    const { store } = newStore();
    const jobId = enqueueOne(store, 'item-a', { kind: 'venice_e2ee_document' });
    store.lease({ ...LANE, workerId: 'worker-1', extractorKind: 'venice_e2ee_document' });

    const recycled = store.recycleLeases({ ...LANE, extractorKindPrefix: 'venice_' });
    expect(recycled.jobsRequeued).toBe(1);
    expect(store.get(jobId)?.status).toBe('queued');
    expect(store.get(jobId)?.lastErrorKind).toBe('provider_pause_recycled');

    // The recycled marker resets the attempt counter instead of incrementing it.
    const released = store.lease({ ...LANE, workerId: 'worker-2' });
    expect(released.leasedJobs[0]!.attempts).toBe(1);
    expect(store.get(jobId)?.attempts).toBe(1);
  });

  test('the free attempt is spent by the claim that takes it, not granted forever', () => {
    // The marker is the grant. A claim that leaves it in place re-grants the
    // free attempt on every later reclaim, freezing the retry budget at 1.
    const { store, dbPath } = newStore();
    const jobId = enqueueOne(store, 'item-a', { kind: 'venice_e2ee_document' });
    store.lease({ ...LANE, workerId: 'worker-1', extractorKind: 'venice_e2ee_document' });
    store.recycleLeases({ ...LANE, extractorKindPrefix: 'venice_' });

    expect(store.lease({ ...LANE, workerId: 'worker-1' }).leasedJobs[0]!.attempts).toBe(1);
    expect(store.get(jobId)?.lastErrorKind).toBeUndefined();

    // The run died holding the lease, so nothing recorded an outcome.
    backdate(dbPath, jobId, { leased_until: isoSecondsFromNow(-1) });
    expect(store.lease({ ...LANE, workerId: 'worker-1' }).leasedJobs[0]!.attempts).toBe(2);
    expect(store.get(jobId)?.attempts).toBe(2);
  });

  test('a dry run reports the match without touching a row', () => {
    const { store } = newStore();
    const jobId = enqueueOne(store, 'item-a', { kind: 'venice_e2ee_document' });
    store.lease({ ...LANE, workerId: 'worker-1' });
    const dry = store.recycleLeases({ ...LANE, extractorKindPrefix: 'venice_', dryRun: true });

    expect(dry.matchedJobs).toBe(1);
    expect(dry.jobsRequeued).toBe(0);
    expect(store.get(jobId)?.status).toBe('leased');
  });

  test('staleOnly leaves live leases alone', () => {
    const { store, dbPath } = newStore();
    const live = enqueueOne(store, 'item-live', { kind: 'venice_e2ee_document' });
    const stale = enqueueOne(store, 'item-stale', { kind: 'venice_e2ee_document' });
    store.lease({ ...LANE, workerId: 'worker-1' });
    backdate(dbPath, stale, { leased_until: isoSecondsFromNow(-1) });

    const recycled = store.recycleLeases({ ...LANE, extractorKindPrefix: 'venice_', staleOnly: true });
    expect(recycled.jobsRequeued).toBe(1);
    expect(store.get(stale)?.status).toBe('queued');
    expect(store.get(live)?.status).toBe('leased');
  });

  test('the prefix match does not reach another extractor family', () => {
    const { store } = newStore();
    const localJob = enqueueOne(store, 'item-a');
    store.lease({ ...LANE, workerId: 'worker-1' });
    const recycled = store.recycleLeases({ ...LANE, extractorKindPrefix: 'venice_' });
    expect(recycled.matchedJobs).toBe(0);
    expect(store.get(localJob)?.status).toBe('leased');
  });

  // The read a caller needs BEFORE it does something it cannot undo. record()
  // answers the same question by writing, which is too late for a corpus.
  test('a recycled-then-reclaimed grant is readable as superseded before any write', () => {
    const { store } = newStore();
    enqueueOne(store, 'item-a', { kind: 'venice_e2ee_document' });
    const first = store.lease({ ...LANE, workerId: 'worker-1', leaseSeconds: 900 }).leasedJobs[0]!;
    expect(store.holdsExtractionClaim(first)).toBe(true);

    // A paused backend recycles a LIVE lease, so the expiry the first run
    // cached is still in the future and tells it nothing.
    store.recycleLeases({ ...LANE, extractorKindPrefix: 'venice_', staleOnly: false });
    expect(Date.parse(first.leaseExpiresAt)).toBeGreaterThan(Date.now());
    expect(store.holdsExtractionClaim(first)).toBe(false);

    // Same worker id, so only the grant separates the two runs.
    const second = store.lease({ ...LANE, workerId: 'worker-1', leaseSeconds: 900 }).leasedJobs[0]!;
    expect(store.holdsExtractionClaim(second)).toBe(true);
    expect(store.holdsExtractionClaim(first)).toBe(false);
    expect(store.holdsExtractionClaim({ ...second, jobId: 'no-such-job' })).toBe(false);

    // The grant is ordered and the order is strict, which is what lets a
    // second database — the corpus this job's text lands in — tell the two
    // generations apart without holding a transaction over this one.
    expect(second.grantAuthority).toBe(first.grantAuthority);
    expect(second.grantOrdinal).toBeGreaterThan(first.grantOrdinal);
    // A grant from another sequence names a job this store never granted.
    expect(store.holdsExtractionClaim({ ...second, grantAuthority: 'some-other-queue' }))
      .toBe(false);
    expect(store.holdsExtractionClaim({ ...second, grantOrdinal: second.grantOrdinal + 1 }))
      .toBe(false);
  });

  // One token per call, but one grant per JOB. Two jobs in a batch can target
  // the same item under the same extractor, and a shared ordinal would make
  // the second one's write look to a corpus like a replay of the first.
  test('every job in one batch gets its own grant', () => {
    const { store } = newStore();
    enqueueOne(store, 'item-a', { kind: 'venice_e2ee_document' });
    enqueueOne(store, 'item-b', { kind: 'venice_e2ee_document' });

    const leased = store.lease({ ...LANE, workerId: 'worker-1', limit: 10 }).leasedJobs;

    expect(leased).toHaveLength(2);
    expect(leased[0]!.leaseToken).toBe(leased[1]!.leaseToken);
    expect(new Set(leased.map((job) => job.grantOrdinal)).size).toBe(2);
    for (const job of leased) expect(store.holdsExtractionClaim(job)).toBe(true);
  });
});

describe('extraction job store: janitor', () => {
  function failRetryable(store: LocalFileExtractionJobStore, jobId: string, errorKind: string): void {
    store.lease({ ...LANE, workerId: 'worker-1' });
    store.record({ jobId, status: 'failed_retryable', errorKind });
  }

  test('the expired-retryable pass requeues jobs whose backoff has elapsed', () => {
    const { store, dbPath } = newStore();
    const jobId = enqueueOne(store, 'item-a');
    failRetryable(store, jobId, 'extractor_timeout');
    backdate(dbPath, jobId, { next_retry_at: isoSecondsFromNow(-1) });

    const swept = store.janitorRequeue({ ...LANE, mode: 'expired_retryable', reason: 'nightly sweep' });
    expect(swept.matchedJobs).toBe(1);
    expect(swept.jobsRequeued).toBe(1);
    const job = store.get(jobId)!;
    expect(job.status).toBe('queued');
    expect(job.lastErrorKind).toBe('janitor_retryable_requeued');
    expect(job.janitorRequeueCount).toBe(1);
    expect(job.janitorRequeueReason).toBe('nightly sweep');
  });

  test('a job still inside its backoff window is not swept', () => {
    const { store } = newStore();
    const jobId = enqueueOne(store, 'item-a');
    failRetryable(store, jobId, 'extractor_timeout');
    const swept = store.janitorRequeue({ ...LANE, mode: 'expired_retryable', reason: 'nightly sweep' });
    expect(swept.matchedJobs).toBe(0);
  });

  test('a job past its attempt budget is counted, not cycled', () => {
    const { store, dbPath } = newStore();
    const jobId = enqueueOne(store, 'item-a');
    failRetryable(store, jobId, 'extractor_timeout');
    backdate(dbPath, jobId, {
      next_retry_at: isoSecondsFromNow(-1),
      attempts: MAX_EXTRACTION_RETRY_ATTEMPTS,
    });

    const swept = store.janitorRequeue({ ...LANE, mode: 'expired_retryable', reason: 'nightly sweep' });
    expect(swept.matchedJobs).toBe(1);
    expect(swept.skippedAttemptBudget).toBe(1);
    expect(swept.jobsRequeued).toBe(0);
    expect(store.get(jobId)?.status).toBe('failed_retryable');
  });

  test('terminal reclassification reopens a job once, and only once, ever', () => {
    const { store } = newStore();
    const jobId = enqueueOne(store, 'item-a');
    store.lease({ ...LANE, workerId: 'worker-1' });
    store.record({ jobId, status: 'failed_terminal', errorKind: 'renderer_unavailable' });

    const first = store.janitorRequeue({
      ...LANE,
      mode: 'terminal_reclassification',
      extractorKind: KIND,
      lastErrorKind: 'renderer_unavailable',
      reason: 'renderer fixed',
    });
    expect(first.jobsRequeued).toBe(1);
    expect(store.get(jobId)?.janitorTerminalRequeueCount).toBe(1);

    // Fail it terminally again with the same error, then try a second requeue.
    store.lease({ ...LANE, workerId: 'worker-1' });
    store.record({ jobId, status: 'failed_terminal', errorKind: 'renderer_unavailable' });
    const second = store.janitorRequeue({
      ...LANE,
      mode: 'terminal_reclassification',
      extractorKind: KIND,
      lastErrorKind: 'renderer_unavailable',
      reason: 'renderer fixed again',
    });
    expect(second.matchedJobs).toBe(0);
    expect(second.skippedAlreadyJanitorRequeued).toBe(1);
    expect(store.get(jobId)?.status).toBe('failed_terminal');
  });

  test('a network failure may be requeued past the one-requeue-ever guard', () => {
    const { store } = newStore();
    const jobId = enqueueOne(store, 'item-a');
    store.lease({ ...LANE, workerId: 'worker-1' });
    store.record({ jobId, status: 'failed_terminal', errorKind: 'network_unreachable' });
    store.janitorRequeue({
      ...LANE,
      mode: 'terminal_reclassification',
      extractorKind: KIND,
      lastErrorKind: 'network_unreachable',
      reason: 'link restored',
    });
    store.lease({ ...LANE, workerId: 'worker-1' });
    store.record({ jobId, status: 'failed_terminal', errorKind: 'network_unreachable' });

    const override = store.janitorRequeue({
      ...LANE,
      mode: 'terminal_reclassification',
      extractorKind: KIND,
      lastErrorKind: 'network_unreachable',
      reason: 'link restored again',
      allowNetworkTerminalRequeueAfterPriorJanitor: true,
    });
    expect(override.networkGuardOverrideUsed).toBe(true);
    expect(override.jobsRequeued).toBe(1);
    expect(store.get(jobId)?.status).toBe('queued');
  });

  test('the override does not apply to a failure that is not a network error', () => {
    const { store } = newStore();
    const jobId = enqueueOne(store, 'item-a');
    store.lease({ ...LANE, workerId: 'worker-1' });
    store.record({ jobId, status: 'failed_terminal', errorKind: 'renderer_unavailable' });
    store.janitorRequeue({
      ...LANE,
      mode: 'terminal_reclassification',
      extractorKind: KIND,
      lastErrorKind: 'renderer_unavailable',
      reason: 'first',
    });
    store.lease({ ...LANE, workerId: 'worker-1' });
    store.record({ jobId, status: 'failed_terminal', errorKind: 'renderer_unavailable' });

    const attempt = store.janitorRequeue({
      ...LANE,
      mode: 'terminal_reclassification',
      extractorKind: KIND,
      lastErrorKind: 'renderer_unavailable',
      reason: 'second',
      allowNetworkTerminalRequeueAfterPriorJanitor: true,
    });
    expect(attempt.networkGuardOverrideUsed).toBe(false);
    expect(attempt.jobsRequeued).toBe(0);
  });

  test('terminal reclassification matches on the exact error kind', () => {
    const { store } = newStore();
    const jobId = enqueueOne(store, 'item-a');
    store.lease({ ...LANE, workerId: 'worker-1' });
    store.record({ jobId, status: 'failed_terminal', errorKind: 'renderer_unavailable' });

    const mismatch = store.janitorRequeue({
      ...LANE,
      mode: 'terminal_reclassification',
      extractorKind: KIND,
      lastErrorKind: 'extractor_timeout',
      reason: 'wrong kind',
    });
    expect(mismatch.matchedJobs).toBe(0);
    expect(store.get(jobId)?.status).toBe('failed_terminal');
  });

  test('escalation opens a job under a different extractor, once per target', () => {
    const { store } = newStore();
    const jobId = enqueueOne(store, 'item-a');
    store.lease({ ...LANE, workerId: 'worker-1' });
    store.record({ jobId, status: 'failed_terminal', errorKind: 'text_layer_absent' });

    const escalated = store.janitorRequeue({
      ...LANE,
      mode: 'terminal_reclassification',
      extractorKind: KIND,
      lastErrorKind: 'text_layer_absent',
      targetExtractorKind: 'local_ocr_tesseract',
      targetExtractorVersion: 'ocr-v1',
      reason: 'no text layer, try optical recognition',
    });
    expect(escalated.jobsEscalated).toBe(1);
    expect(store.get(jobId)?.janitorTerminalRequeueCount).toBe(1);

    const queued = store.counts(LANE)
      .filter((entry) => entry.status === 'queued')
      .map((entry) => entry.extractorKind);
    expect(queued).toEqual(['local_ocr_tesseract']);

    // Running it again must not create a second target job.
    const repeat = store.janitorRequeue({
      ...LANE,
      mode: 'terminal_reclassification',
      extractorKind: KIND,
      lastErrorKind: 'text_layer_absent',
      targetExtractorKind: 'local_ocr_tesseract',
      targetExtractorVersion: 'ocr-v1',
      reason: 'repeat',
    });
    expect(repeat.skippedTargetExists).toBe(1);
    expect(repeat.jobsEscalated).toBe(0);
  });

  test('a janitor dry run changes nothing', () => {
    const { store, dbPath } = newStore();
    const jobId = enqueueOne(store, 'item-a');
    failRetryable(store, jobId, 'extractor_timeout');
    backdate(dbPath, jobId, { next_retry_at: isoSecondsFromNow(-1) });

    const dry = store.janitorRequeue({
      ...LANE, mode: 'expired_retryable', reason: 'dry sweep', dryRun: true,
    });
    expect(dry.matchedJobs).toBe(1);
    expect(dry.jobsRequeued).toBe(0);
    expect(store.get(jobId)?.status).toBe('failed_retryable');
  });

  test('terminal reclassification demands both an extractor kind and an error kind', () => {
    const { store } = newStore();
    expect(() => store.janitorRequeue({
      ...LANE, mode: 'terminal_reclassification', reason: 'incomplete',
    })).toThrow(/requires both/);
  });
});

// The readiness half of the source status payload, computed here because this
// is where the extraction lane's own verdicts rest. It exists source-agnostically
// for the same reason the queue does: the corpus id partitions it, and nothing
// in it names a provider.
describe('extraction job store: corpus readiness', () => {
  /** Enqueue one job, lease it and bring it to rest on `status`. */
  function settle(
    store: LocalFileExtractionJobStore,
    providerItemId: string,
    status: ExtractionTerminalStatus,
    kind?: string,
  ): void {
    const jobId = enqueueOne(store, providerItemId, kind === undefined ? {} : { kind });
    store.lease({ ...LANE, workerId: 'worker-1' });
    store.record({
      jobId,
      status,
      ...(status === 'failed_terminal' ? { errorKind: 'extractor_crashed' } : {}),
    });
  }

  test('reports policy exits per item and failures per job, across every lane of a corpus', () => {
    const { store } = newStore();
    settle(store, 'fenced', 'blocked_policy');
    settle(store, 'movie', 'metadata_only');
    settle(store, 'huge', 'skipped_too_large');
    settle(store, 'read', 'indexed');

    // Two items whose first attempt failed. The second was then read by a
    // different extractor, so its failure costs no content.
    settle(store, 'broken', 'failed_terminal');
    settle(store, 'rescued', 'failed_terminal');
    settle(store, 'rescued', 'indexed', 'local_ocr');

    // A deferred file somebody extracted anyway keeps the reading its
    // extraction earned: it must not be subtracted out of the denominator
    // while its text sits in the numerator.
    settle(store, 'shelved', 'metadata_only');
    settle(store, 'shelved', 'indexed', 'local_ocr');

    // Enqueued last, so nothing above leases it away from the queue.
    enqueueOne(store, 'waiting');

    expect(store.corpusReadiness(LANE.corpusId)).toMatchObject({
      blockedByPolicyItems: 1,
      metadataOnlyExpectedItems: 2,
      queuedJobs: 1,
      leasedJobs: 0,
      failedRetryableJobs: 0,
      failedTerminalJobs: 2,
      failedActionableJobs: 1,
      retryableDueJobs: 0,
    });
    // Another corpus's jobs are not this corpus's readiness.
    expect(store.corpusReadiness('secure_local.files.other')).toEqual({
      blockedByPolicyItems: 0,
      metadataOnlyExpectedItems: 0,
      queuedJobs: 0,
      leasedJobs: 0,
      failedRetryableJobs: 0,
      failedTerminalJobs: 0,
      failedActionableJobs: 0,
      retryableDueJobs: 0,
    });
  });

  test('publishes those verdicts under the count keys the coverage math reads', () => {
    const { store } = newStore();
    settle(store, 'fenced', 'blocked_policy');
    settle(store, 'movie', 'metadata_only');
    settle(store, 'broken', 'failed_terminal');
    enqueueOne(store, 'waiting');

    expect(createExtractionReadinessLedger(store).snapshotForCorpus(LANE.corpusId)?.counts).toEqual({
      qa_blocked_policy: 1,
      qa_metadata_only_expected: 1,
      extraction_jobs_queued: 1,
      extraction_jobs_queued_actionable: 1,
      extraction_jobs_leased: 0,
      extraction_jobs_failed: 1,
      extraction_jobs_failed_actionable: 1,
      extraction_jobs_retryable_due_actionable: 0,
    });
  });

  test('keeps the actionable stall clock anchored to job arrival across retries', () => {
    const { store, dbPath } = newStore();
    const jobId = enqueueOne(store, 'retrying');
    const arrivedAt = '2026-01-01T00:00:00.000Z';
    backdate(dbPath, jobId, { created_at: arrivedAt, updated_at: arrivedAt });

    store.lease({ ...LANE, workerId: 'worker-1' });
    store.record({ jobId, status: 'failed_retryable', errorKind: 'extractor_unavailable' });
    backdate(dbPath, jobId, { next_retry_at: '2026-01-01T00:01:00.000Z' });

    expect(store.corpusReadiness(LANE.corpusId, new Date('2026-09-01T00:00:00.000Z')))
      .toMatchObject({ retryableDueJobs: 1, oldestActionableAt: arrivedAt });
  });

  test('an unreadable queue leaves the counts absent rather than failing the status poll', () => {
    const ledger = createExtractionReadinessLedger({
      corpusReadiness() {
        throw new Error('synthetic queue failure');
      },
    });
    expect(ledger.snapshotForCorpus(LANE.corpusId)).toBeUndefined();
  });
});
