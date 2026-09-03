// The two runner legs that make the job store's guards reachable.
//
// The store already refuses to rewrite a stored policy decision for a pass that
// names none, and already refuses a write from a run whose lease grant is no
// longer the row's. Neither guard could ever fire while the runner turned an
// omitted decision into an explicit permissive one and recorded without naming
// the grant it was handed. These are integration assertions: they drive the
// runner, not the store, because the runner is the only caller in production.
//
// Time is moved by writing `leased_until` through a second connection to the
// same file, the same way test/file-extraction-job-store.test.ts does — the
// store reads the wall clock exactly where the ported original does.

import { Database } from 'bun:sqlite';
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalFileExtractionJobStore } from '../src/workers/file-extraction/job-store.ts';
import { buildExtractorRegistry } from '../src/workers/file-extraction/registry.ts';
import {
  DEFAULT_EXTRACTION_WORKER_ID,
  EXTRACTION_ERROR_KIND_LEASE_LOST,
  createFileExtractionRunner,
} from '../src/workers/file-extraction/runner.ts';
import type {
  ExtractionCandidatePage,
  ExtractionItemRef,
  ExtractionSink,
  Extractor,
  ExtractorOutput,
  FetchedBytes,
  FileExtractionSource,
} from '../src/workers/file-extraction/types.ts';

const CORPUS_ID = 'secure_local.fake.files';
const PROVIDER = 'fake';
const ACCOUNT = 'personal';
const SCOPE_KEY = 'fake.personal:/Projects';
const FAKE_KIND = 'fake_text';
const FAKE_VERSION = 'fake-v1';

const LANE = {
  corpusId: CORPUS_ID,
  provider: PROVIDER,
  accountScope: ACCOUNT,
  approvedScopeKey: SCOPE_KEY,
};

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

function newStore(): { jobs: LocalFileExtractionJobStore; dbPath: string } {
  const root = mkdtempSync(join(tmpdir(), 'olympus-extraction-runner-'));
  openRoots.push(root);
  const dbPath = join(root, 'file-extraction-jobs.sqlite');
  const jobs = new LocalFileExtractionJobStore(dbPath);
  openStores.push(jobs);
  return { jobs, dbPath };
}

function ref(index: number): ExtractionItemRef {
  return {
    ...LANE,
    providerItemId: `item-${index}`,
    localItemId: `${ACCOUNT}:item-${index}`,
    mimeType: 'text/plain',
    name: `item-${index}.txt`,
  };
}

function source(candidates: readonly ExtractionItemRef[]): FileExtractionSource {
  return {
    id: 'fake-source',
    corpusId: CORPUS_ID,
    provider: PROVIDER,
    async listCandidates(): Promise<ExtractionCandidatePage> {
      return { candidates: [...candidates], done: true };
    },
    async fetch(): Promise<FetchedBytes> {
      return { bytes: new TextEncoder().encode('bytes'), mimeType: 'text/plain' };
    },
  };
}

function sink(): ExtractionSink {
  return {
    async accept() {
      return { accepted: true, chunksIndexed: 1, chunksAwaitingEmbedding: 1 };
    },
  };
}

function runnerFor(jobs: LocalFileExtractionJobStore, extractor: Extractor, candidates: readonly ExtractionItemRef[] = []) {
  return createFileExtractionRunner({
    jobs,
    registry: buildExtractorRegistry([extractor]),
    corpora: [{ corpusId: CORPUS_ID, trustDomain: 'secure_local', source: source(candidates), sink: sink() }],
  });
}

function textExtractor(overrides: Partial<Extractor> = {}): Extractor {
  return {
    kind: FAKE_KIND,
    version: FAKE_VERSION,
    needsBytes: true,
    egress: 'local',
    accepts: () => true,
    async extract(): Promise<ExtractorOutput> {
      return { status: 'indexed', text: 'extracted text' };
    },
    ...overrides,
  };
}

describe('extraction runner: a plan that names no policy decision asserts nothing', () => {
  test('a re-plan with no decision leaves the stored decision alone', async () => {
    const { jobs } = newStore();
    const runner = runnerFor(jobs, textExtractor(), [ref(1)]);

    await runner.plan({ ...LANE, limit: 10, extractorKind: FAKE_KIND, policyDecision: 'needs_review' });
    await runner.plan({ ...LANE, limit: 10, extractorKind: FAKE_KIND, force: true });

    const leased = jobs.lease({ ...LANE, workerId: 'reader' }).leasedJobs;
    expect(leased).toHaveLength(1);
    expect(leased[0]!.policyDecision).toBe('needs_review');
  });

  test('a plan that does name a decision still re-stamps it', async () => {
    const { jobs } = newStore();
    const runner = runnerFor(jobs, textExtractor(), [ref(1)]);

    await runner.plan({ ...LANE, limit: 10, extractorKind: FAKE_KIND, policyDecision: 'needs_review' });
    await runner.plan({ ...LANE, limit: 10, extractorKind: FAKE_KIND, force: true, policyDecision: 'blocked_sensitive' });

    const leased = jobs.lease({ ...LANE, workerId: 'reader' }).leasedJobs;
    expect(leased[0]!.policyDecision).toBe('blocked_sensitive');
  });
});

describe('extraction runner: the lease grant, not the worker id, separates two runs', () => {
  test('a run superseded inside the same worker process does not overwrite the new holder', async () => {
    const { jobs, dbPath } = newStore();
    jobs.enqueue({
      refs: [ref(1)],
      extractorKind: FAKE_KIND,
      extractorVersion: FAKE_VERSION,
      policyDecision: 'index_allowed',
    });

    let stolenGrant: string | undefined;
    let stolenExpiry: string | undefined;
    const runner = runnerFor(jobs, textExtractor({
      async extract(): Promise<ExtractorOutput> {
        // The deployment runs every overlapping pass under one worker id: expire
        // this run's grant and re-claim the row as the same worker, which is
        // exactly what a janitor requeue plus a following batch produces.
        const clock = new Database(dbPath);
        try {
          clock.query('UPDATE extraction_jobs SET leased_until = ?')
            .run(new Date(Date.now() - 1_000).toISOString());
        } finally {
          clock.close();
        }
        const stolen = jobs.lease({
          ...LANE,
          workerId: DEFAULT_EXTRACTION_WORKER_ID,
          leaseSeconds: 900,
        }).leasedJobs[0];
        stolenGrant = stolen?.leaseToken;
        stolenExpiry = stolen?.leaseExpiresAt;
        return { status: 'indexed', text: 'extracted text' };
      },
    }));

    const result = await runner.run({ ...LANE });

    expect(stolenGrant).toBeDefined();
    expect(result.records).toHaveLength(1);
    expect(result.records[0]!.status).toBe('failed_retryable');
    expect(result.records[0]!.errorKind).toBe(EXTRACTION_ERROR_KIND_LEASE_LOST);
    expect(result.records[0]!.leaseLost).toBe(true);
    // The current holder's row is untouched: still leased, still theirs.
    const row = jobs.get(result.records[0]!.jobId);
    expect(row?.status).toBe('leased');
    expect(row?.leasedUntil).toBe(stolenExpiry);
  });

  test('a run that still holds its grant records normally', async () => {
    const { jobs } = newStore();
    jobs.enqueue({
      refs: [ref(1)],
      extractorKind: FAKE_KIND,
      extractorVersion: FAKE_VERSION,
      policyDecision: 'index_allowed',
    });
    const runner = runnerFor(jobs, textExtractor());

    const result = await runner.run({ ...LANE });

    expect(result.records[0]!.status).toBe('indexed');
    expect(result.records[0]!.leaseLost).toBeUndefined();
  });
});
