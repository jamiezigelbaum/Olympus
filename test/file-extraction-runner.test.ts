// The extraction factory's batch loop.
//
// Almost everything in the runner is DISPOSITION, so almost everything here is
// a disposition assertion. Four of these groups exist because of a live
// incident rather than because of a design:
//
//   * "one bad item never aborts a run" is the defect that stopped a live
//     migration at 4,089 items. The distinction that fixes it is that a
//     TERMINAL failure is a settled job and must never touch the lane's
//     consecutive-failure counter, while a retryable one PAUSES the lane
//     instead of throwing out of the middle of a batch.
//   * the egress gate is exercised as a boundary, not as a branch: the
//     assertion is that the remote client is never called, from a corpus whose
//     policy forbids it, with the remote extractor fully registered.
//   * empty output must never reach the sink, because the store reads an empty
//     representation as "delete this item's chunks".
//   * the deterministic OCR refusal is reopened against the vision lane. Left
//     unwired, every scanned PDF the OCR command refuses stays terminal for
//     ever, and nothing in the type system would have noticed.

import { describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  RawItem,
  SourceConnector,
  SourceConnectorListOptions,
  SourceConnectorListPage,
} from '../src/core/contracts.ts';
import {
  FILE_EXTRACTION_SOURCE_ERROR_SETTLEMENTS,
  FileExtractionSourceError,
  type FileExtractionSourceErrorKind,
} from '../src/core/file-extraction-source.ts';
import {
  buildSourceSensitivity,
  type SourceTrustTier,
} from '../src/core/source-index/types.ts';
import { LocalConnectorStore } from '../src/workers/connector-store/index.ts';
import { LocalFileExtractionJobStore } from '../src/workers/file-extraction/job-store.ts';
import {
  OCR_DETERMINISTIC_PDF_REJECTION_KINDS,
  OCR_EXTRACTOR_KIND,
} from '../src/workers/file-extraction/extractors/ocr.ts';
import { REMOTE_VLM_EXTRACTOR_KINDS } from '../src/workers/file-extraction/extractors/remote-vlm.ts';
import { VLM_PDF_EXTRACTOR_KIND } from '../src/workers/file-extraction/extractors/vlm.ts';
import {
  buildExtractorRegistry,
  createDefaultExtractorRegistry,
  defaultTerminalReclassificationRules,
} from '../src/workers/file-extraction/registry.ts';
import { createConnectorStoreExtractionSink } from '../src/workers/file-extraction/store-sink.ts';
import {
  DEFAULT_EXTRACTION_WORKER_ID,
  EXTRACTION_EGRESS_REFUSED_DECISION,
  EXTRACTION_EGRESS_REFUSED_DEFERRED,
  EXTRACTION_EGRESS_REFUSED_NO_POLICY,
  EXTRACTION_EGRESS_REFUSED_TIER_UNKNOWN,
  EXTRACTION_EGRESS_REFUSED_TRUST_TIER,
  EXTRACTION_ERROR_KIND_EMPTY_OUTPUT,
  EXTRACTION_ERROR_KIND_EXTRACTOR_THREW,
  EXTRACTION_ERROR_KIND_LEASE_LOST,
  EXTRACTION_ERROR_KIND_UNKNOWN_EXTRACTOR,
  EXTRACTION_PAUSE_CONSECUTIVE_FAILURES,
  EXTRACTION_PAUSE_HEALTH_PROBE,
  createFileExtractionRunner,
  evaluateExtractionEgress,
  type ExtractionRunnerCorpus,
} from '../src/workers/file-extraction/runner.ts';
import type {
  ExtractionCandidatePage,
  ExtractionItemRef,
  ExtractionSink,
  ExtractionSinkRequest,
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

function ref(index: number, overrides: Partial<ExtractionItemRef> = {}): ExtractionItemRef {
  return {
    corpusId: CORPUS_ID,
    provider: PROVIDER,
    accountScope: ACCOUNT,
    approvedScopeKey: SCOPE_KEY,
    providerItemId: `item-${index}`,
    localItemId: `${ACCOUNT}:item-${index}`,
    mimeType: 'text/plain',
    name: `item-${index}.txt`,
    ...overrides,
  };
}

function jobStore(): LocalFileExtractionJobStore {
  return new LocalFileExtractionJobStore(':memory:');
}

function fakeExtractor(overrides: Partial<Extractor> = {}): Extractor {
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

function fakeSource(overrides: Partial<FileExtractionSource> = {}): FileExtractionSource {
  return {
    id: 'fake-source',
    corpusId: CORPUS_ID,
    provider: PROVIDER,
    async listCandidates(): Promise<ExtractionCandidatePage> {
      return { candidates: [], done: true };
    },
    async fetch(): Promise<FetchedBytes> {
      return { bytes: new TextEncoder().encode('bytes'), mimeType: 'text/plain' };
    },
    ...overrides,
  };
}

interface RecordingSink extends ExtractionSink {
  readonly accepted: ExtractionSinkRequest[];
}

function recordingSink(result: Partial<Awaited<ReturnType<ExtractionSink['accept']>>> = {}): RecordingSink {
  const accepted: ExtractionSinkRequest[] = [];
  return {
    accepted,
    async accept(request) {
      accepted.push(request);
      return {
        accepted: true,
        chunksIndexed: 1,
        chunksAwaitingEmbedding: 1,
        ...result,
      };
    },
  };
}

function enqueue(
  jobs: LocalFileExtractionJobStore,
  count: number,
  overrides: { extractorKind?: string; extractorVersion?: string; policyDecision?: 'index_allowed' | 'needs_review' | 'blocked_sensitive' } = {},
): void {
  jobs.enqueue({
    refs: Array.from({ length: count }, (_unused, index) => ref(index + 1)),
    extractorKind: overrides.extractorKind ?? FAKE_KIND,
    extractorVersion: overrides.extractorVersion ?? FAKE_VERSION,
    policyDecision: overrides.policyDecision ?? 'index_allowed',
  });
}

function runnerFor(input: {
  jobs: LocalFileExtractionJobStore;
  extractors?: readonly Extractor[];
  corpus?: Partial<ExtractionRunnerCorpus>;
  maxConsecutiveRetryableFailures?: number;
  healthProbes?: ReadonlyMap<string, () => Promise<void>>;
  now?: () => Date;
}) {
  const sink = input.corpus?.sink ?? recordingSink();
  return createFileExtractionRunner({
    jobs: input.jobs,
    registry: buildExtractorRegistry(input.extractors ?? [fakeExtractor()]),
    corpora: [{
      corpusId: CORPUS_ID,
      trustDomain: 'secure_local',
      source: fakeSource(),
      sink,
      ...input.corpus,
    }],
    ...(input.maxConsecutiveRetryableFailures !== undefined
      ? { maxConsecutiveRetryableFailures: input.maxConsecutiveRetryableFailures }
      : {}),
    ...(input.healthProbes ? { healthProbes: input.healthProbes } : {}),
    ...(input.now ? { now: input.now } : {}),
  });
}

describe('extraction runner: one bad item never aborts a run', () => {
  test('a terminal fetch failure settles its own job and the batch continues past it', async () => {
    const jobs = jobStore();
    try {
      enqueue(jobs, 3);
      const runner = runnerFor({
        jobs,
        corpus: {
          source: fakeSource({
            async fetch(itemRef) {
              if (itemRef.providerItemId === 'item-2') {
                throw new FileExtractionSourceError('source_item_not_found');
              }
              return { bytes: new TextEncoder().encode('bytes'), mimeType: 'text/plain' };
            },
          }),
        },
      });

      const result = await runner.run({ ...LANE });

      expect(result.leasedJobs).toBe(3);
      expect(result.processedJobs).toBe(3);
      expect(result.abandonedLeases).toBe(0);
      expect(result.paused).toBe(false);
      expect(result.counts.indexed).toBe(2);
      expect(result.counts.failed_terminal).toBe(1);
    } finally {
      jobs.close();
    }
  });

  test('terminal failures never feed the consecutive-failure counter', async () => {
    // The exact live defect: a corpus of deleted or unreadable files must run
    // to the end of its batch, however many of them are terminal.
    const jobs = jobStore();
    try {
      enqueue(jobs, 5);
      const runner = runnerFor({
        jobs,
        maxConsecutiveRetryableFailures: 2,
        corpus: {
          source: fakeSource({
            async fetch(): Promise<FetchedBytes> {
              throw new FileExtractionSourceError('source_item_not_found');
            },
          }),
        },
      });

      const result = await runner.run({ ...LANE });

      expect(result.paused).toBe(false);
      expect(result.pauseReason).toBeUndefined();
      expect(result.processedJobs).toBe(5);
      expect(result.counts.failed_terminal).toBe(5);
      expect(result.consecutiveRetryableFailures).toBe(0);
    } finally {
      jobs.close();
    }
  });

  test('consecutive retryable failures pause the lane and never throw mid-batch', async () => {
    const jobs = jobStore();
    try {
      enqueue(jobs, 5);
      const runner = runnerFor({
        jobs,
        maxConsecutiveRetryableFailures: 2,
        corpus: {
          source: fakeSource({
            async fetch(): Promise<FetchedBytes> {
              throw new FileExtractionSourceError('source_unavailable');
            },
          }),
        },
      });

      const result = await runner.run({ ...LANE });

      expect(result.paused).toBe(true);
      expect(result.pauseReason).toBe(EXTRACTION_PAUSE_CONSECUTIVE_FAILURES);
      expect(result.processedJobs).toBe(2);
      expect(result.abandonedLeases).toBe(3);
      expect(result.counts.failed_retryable).toBe(2);
    } finally {
      jobs.close();
    }
  });

  test('a settled job between two retryable ones resets the counter', async () => {
    const jobs = jobStore();
    try {
      enqueue(jobs, 3);
      // Sequenced by call order rather than by item id: the lease orders by
      // job id, which is a uuid, so keying this off which item comes back
      // would make the test order-dependent and flaky.
      let call = 0;
      const runner = runnerFor({
        jobs,
        maxConsecutiveRetryableFailures: 2,
        corpus: {
          source: fakeSource({
            async fetch(): Promise<FetchedBytes> {
              call += 1;
              if (call === 2) {
                return { bytes: new TextEncoder().encode('bytes'), mimeType: 'text/plain' };
              }
              throw new FileExtractionSourceError('source_unavailable');
            },
          }),
        },
      });

      const result = await runner.run({ ...LANE });

      expect(result.paused).toBe(false);
      expect(result.processedJobs).toBe(3);
      expect(result.counts.failed_retryable).toBe(2);
      expect(result.counts.indexed).toBe(1);
    } finally {
      jobs.close();
    }
  });

  test('an extractor that throws settles retryable and the loop keeps going', async () => {
    // Three paths still throw out of extract(); a test in the extractor wave
    // pins that, so the runner owns the catch.
    const jobs = jobStore();
    try {
      enqueue(jobs, 2);
      const runner = runnerFor({
        jobs,
        extractors: [fakeExtractor({
          async extract(input) {
            if (input.ref.providerItemId === 'item-1') throw new Error('/secret/path/leaked.pdf exploded');
            return { status: 'indexed', text: 'extracted text' };
          },
        })],
      });

      const result = await runner.run({ ...LANE });

      expect(result.processedJobs).toBe(2);
      expect(result.counts.failed_retryable).toBe(1);
      expect(result.counts.indexed).toBe(1);
      const failed = result.records.find((record) => record.status === 'failed_retryable')!;
      expect(failed.errorKind).toBe(EXTRACTION_ERROR_KIND_EXTRACTOR_THREW);

      // The exception's text never reaches the queue; only a digest does.
      const stored = jobs.get(failed.jobId)!;
      expect(stored.lastErrorHash).toMatch(/^[a-f0-9]{32}$/);
      expect(JSON.stringify(stored)).not.toContain('secret');
    } finally {
      jobs.close();
    }
  });

  test('an unregistered extractor kind settles that job terminally, not the run', async () => {
    const jobs = jobStore();
    try {
      enqueue(jobs, 1, { extractorKind: 'kind_nobody_registered' });
      const runner = runnerFor({ jobs });

      const result = await runner.run({ ...LANE });

      expect(result.counts.failed_terminal).toBe(1);
      expect(result.records[0]!.errorKind).toBe(EXTRACTION_ERROR_KIND_UNKNOWN_EXTRACTOR);
    } finally {
      jobs.close();
    }
  });
});

describe('extraction runner: settlement comes from the source, never re-derived', () => {
  for (const [errorKind, settlement] of Object.entries(FILE_EXTRACTION_SOURCE_ERROR_SETTLEMENTS)) {
    test(`${errorKind} settles as ${settlement}`, async () => {
      const jobs = jobStore();
      try {
        enqueue(jobs, 1);
        const runner = runnerFor({
          jobs,
          corpus: {
            source: fakeSource({
              async fetch(): Promise<FetchedBytes> {
                throw new FileExtractionSourceError(errorKind as FileExtractionSourceErrorKind);
              },
            }),
          },
        });

        const result = await runner.run({ ...LANE });

        expect(result.records[0]!.status).toBe(settlement);
        expect(result.records[0]!.errorKind).toBe(errorKind);
      } finally {
        jobs.close();
      }
    });
  }
});

describe('extraction runner: empty output never reaches the sink', () => {
  test('an empty extraction settles metadata-only without a write', async () => {
    const jobs = jobStore();
    const sink = recordingSink();
    try {
      enqueue(jobs, 1);
      const runner = runnerFor({
        jobs,
        extractors: [fakeExtractor({ async extract() { return { status: 'empty_output' }; } })],
        corpus: { sink },
      });

      const result = await runner.run({ ...LANE });

      expect(sink.accepted).toEqual([]);
      expect(result.records[0]!.status).toBe('metadata_only');
      expect(result.records[0]!.errorKind).toBe(EXTRACTION_ERROR_KIND_EMPTY_OUTPUT);
    } finally {
      jobs.close();
    }
  });

  test('an indexed output whose text is only whitespace is treated as empty', async () => {
    // The type system makes the empty case unrepresentable as a sink request;
    // whitespace is the hole it cannot close, and the store's chunker reads it
    // exactly the same way.
    const jobs = jobStore();
    const sink = recordingSink();
    try {
      enqueue(jobs, 1);
      const runner = runnerFor({
        jobs,
        extractors: [fakeExtractor({ async extract() { return { status: 'indexed', text: '   \n\t ' }; } })],
        corpus: { sink },
      });

      const result = await runner.run({ ...LANE });

      expect(sink.accepted).toEqual([]);
      expect(result.records[0]!.status).toBe('metadata_only');
    } finally {
      jobs.close();
    }
  });

  test('a sink refusal settles the job without ever being retryable', async () => {
    const jobs = jobStore();
    try {
      enqueue(jobs, 3);
      const runner = runnerFor({
        jobs,
        maxConsecutiveRetryableFailures: 2,
        corpus: {
          sink: {
            async accept() {
              return {
                accepted: false,
                chunksIndexed: 0,
                chunksAwaitingEmbedding: 0,
                skippedReason: 'store_item_missing',
              };
            },
          },
        },
      });

      const result = await runner.run({ ...LANE });

      expect(result.paused).toBe(false);
      expect(result.counts.failed_terminal).toBe(3);
      expect(result.counts.failed_retryable).toBe(0);
    } finally {
      jobs.close();
    }
  });
});

describe('extraction egress gate: the boundary, as a pure decision', () => {
  const REMOTE_ALLOWED = {
    egress: 'approved_remote' as const,
    policy: { maxTrustTierForRemote: 'S3' as const, allowDefaultDeferred: false },
    policyDecision: 'index_allowed' as const,
    trustTier: 'S2' as SourceTrustTier,
  };

  test('local work never consults the policy at all', () => {
    expect(evaluateExtractionEgress({ egress: 'local', policyDecision: 'blocked_sensitive' }))
      .toEqual({ allowed: true });
  });

  test('a corpus with no egress policy cannot reach the remote lane', () => {
    const { policy: _policy, ...withoutPolicy } = REMOTE_ALLOWED;
    expect(evaluateExtractionEgress(withoutPolicy))
      .toEqual({ allowed: false, errorKind: EXTRACTION_EGRESS_REFUSED_NO_POLICY });
  });

  test('an approved corpus, decision and tier is the only allowed combination', () => {
    expect(evaluateExtractionEgress(REMOTE_ALLOWED)).toEqual({ allowed: true });
  });

  test('a blocked or metadata-only decision is refused whatever the tier says', () => {
    for (const policyDecision of ['blocked_sensitive', 'metadata_only', 'index_redacted'] as const) {
      expect(evaluateExtractionEgress({ ...REMOTE_ALLOWED, policyDecision }))
        .toEqual({ allowed: false, errorKind: EXTRACTION_EGRESS_REFUSED_DECISION });
    }
  });

  test('default-deferred content crosses only when the corpus opted in', () => {
    expect(evaluateExtractionEgress({ ...REMOTE_ALLOWED, policyDecision: 'needs_review' }))
      .toEqual({ allowed: false, errorKind: EXTRACTION_EGRESS_REFUSED_DEFERRED });
    expect(evaluateExtractionEgress({
      ...REMOTE_ALLOWED,
      policyDecision: 'needs_review',
      policy: { maxTrustTierForRemote: 'S3', allowDefaultDeferred: true },
    })).toEqual({ allowed: true });
  });

  test('a tier above the corpus ceiling is refused', () => {
    expect(evaluateExtractionEgress({ ...REMOTE_ALLOWED, trustTier: 'S4' }))
      .toEqual({ allowed: false, errorKind: EXTRACTION_EGRESS_REFUSED_TRUST_TIER });
    expect(evaluateExtractionEgress({
      ...REMOTE_ALLOWED,
      trustTier: 'S4',
      policy: { maxTrustTierForRemote: 'S4', allowDefaultDeferred: false },
    })).toEqual({ allowed: true });
  });

  test('an unreadable tier is a refusal, because "we could not tell" is not permission', () => {
    const { trustTier: _trustTier, ...withoutTier } = REMOTE_ALLOWED;
    expect(evaluateExtractionEgress(withoutTier))
      .toEqual({ allowed: false, errorKind: EXTRACTION_EGRESS_REFUSED_TIER_UNKNOWN });
  });
});

describe('extraction egress gate: unreachable, not merely unconfigured', () => {
  test('a registered remote extractor is never called for a corpus with no policy', async () => {
    // The registry registers every remote kind unconditionally and this client
    // is fully configured. The ONLY thing standing between these bytes and the
    // network is the gate.
    const jobs = jobStore();
    const describeCalls: number[] = [];
    const fetchCalls: string[] = [];
    try {
      const remoteKind = REMOTE_VLM_EXTRACTOR_KINDS[0];
      const registry = createDefaultExtractorRegistry({
        remote: {
          client: {
            async describe() {
              describeCalls.push(1);
              return { text: 'described' };
            },
          },
        },
      });
      jobs.enqueue({
        refs: [ref(1, { mimeType: 'image/png' })],
        extractorKind: remoteKind,
        extractorVersion: registry.get(remoteKind)!.version,
        policyDecision: 'index_allowed',
      });

      const runner = createFileExtractionRunner({
        jobs,
        registry,
        corpora: [{
          corpusId: CORPUS_ID,
          trustDomain: 'secure_local',
          source: fakeSource({
            async fetch(itemRef) {
              fetchCalls.push(itemRef.providerItemId);
              return { bytes: new Uint8Array([1, 2, 3]), mimeType: 'image/png' };
            },
          }),
          sink: recordingSink(),
          trustTiers: { itemTrustTier: () => 'S2' },
        }],
      });

      const result = await runner.run({ ...LANE });

      expect(result.counts.blocked_policy).toBe(1);
      expect(result.records[0]!.errorKind).toBe(EXTRACTION_EGRESS_REFUSED_NO_POLICY);
      expect(describeCalls).toEqual([]);
      // The gate runs before the fetch, so the item's bytes are never even
      // pulled off the provider for a call that was never going to be made.
      expect(fetchCalls).toEqual([]);
      expect(result.policy.localOnly).toBe(false);
    } finally {
      jobs.close();
    }
  });

  test('a corpus that cannot read trust tiers cannot reach the remote lane either', async () => {
    const jobs = jobStore();
    const describeCalls: number[] = [];
    try {
      const remoteKind = REMOTE_VLM_EXTRACTOR_KINDS[0];
      const registry = createDefaultExtractorRegistry({
        remote: {
          client: {
            async describe() {
              describeCalls.push(1);
              return { text: 'described' };
            },
          },
        },
      });
      jobs.enqueue({
        refs: [ref(1, { mimeType: 'image/png' })],
        extractorKind: remoteKind,
        extractorVersion: registry.get(remoteKind)!.version,
        policyDecision: 'index_allowed',
      });

      const runner = createFileExtractionRunner({
        jobs,
        registry,
        corpora: [{
          corpusId: CORPUS_ID,
          trustDomain: 'secure_local',
          source: fakeSource(),
          sink: recordingSink(),
          egressPolicy: { maxTrustTierForRemote: 'S3', allowDefaultDeferred: false },
        }],
      });

      const result = await runner.run({ ...LANE });

      expect(result.records[0]!.errorKind).toBe(EXTRACTION_EGRESS_REFUSED_TIER_UNKNOWN);
      expect(describeCalls).toEqual([]);
    } finally {
      jobs.close();
    }
  });

  test('a fully approved corpus does reach the remote lane', async () => {
    // Without this the refusals above could be passing because the remote lane
    // is broken rather than because the gate is doing its job.
    const jobs = jobStore();
    const describeCalls: number[] = [];
    try {
      const remoteKind = REMOTE_VLM_EXTRACTOR_KINDS[0];
      const registry = createDefaultExtractorRegistry({
        remote: {
          client: {
            async describe() {
              describeCalls.push(1);
              return { text: 'described image' };
            },
          },
        },
      });
      jobs.enqueue({
        refs: [ref(1, { mimeType: 'image/png' })],
        extractorKind: remoteKind,
        extractorVersion: registry.get(remoteKind)!.version,
        policyDecision: 'index_allowed',
      });
      const sink = recordingSink();

      const runner = createFileExtractionRunner({
        jobs,
        registry,
        corpora: [{
          corpusId: CORPUS_ID,
          trustDomain: 'secure_local',
          source: fakeSource({
            async fetch() {
              return { bytes: new Uint8Array([1, 2, 3]), mimeType: 'image/png' };
            },
          }),
          sink,
          egressPolicy: { maxTrustTierForRemote: 'S3', allowDefaultDeferred: false },
          trustTiers: { itemTrustTier: () => 'S2' },
        }],
      });

      const result = await runner.run({ ...LANE });

      expect(result.counts.indexed).toBe(1);
      expect(describeCalls).toEqual([1]);
      expect(sink.accepted[0]!.text).toContain('described image');
    } finally {
      jobs.close();
    }
  });
});

describe('extraction runner: a lost lease never writes', () => {
  test('a lease that expired mid-extraction drops the text unwritten', async () => {
    const jobs = jobStore();
    const sink = recordingSink();
    try {
      enqueue(jobs, 1);
      // The clock jumps past the lease while the extractor is working.
      let calls = 0;
      const runner = runnerFor({
        jobs,
        corpus: { sink },
        now: () => {
          calls += 1;
          return calls > 0 ? new Date(Date.now() + 3_600_000) : new Date();
        },
      });

      const result = await runner.run({ ...LANE });

      expect(sink.accepted).toEqual([]);
      expect(result.records[0]!.status).toBe('failed_retryable');
      expect(result.records[0]!.errorKind).toBe(EXTRACTION_ERROR_KIND_LEASE_LOST);
      expect(result.records[0]!.leaseLost).toBe(true);
    } finally {
      jobs.close();
    }
  });

  test('a job re-claimed by another worker is reported without a second write', async () => {
    const jobs = jobStore();
    try {
      enqueue(jobs, 1);
      const runner = runnerFor({
        jobs,
        extractors: [fakeExtractor({
          async extract() {
            // Long enough for the one-second lease to lapse, then somebody else
            // takes the job while this extraction is still running.
            await new Promise((resolve) => setTimeout(resolve, 1_200));
            jobs.lease({ ...LANE, workerId: 'a-different-worker' });
            return { status: 'metadata_only' };
          },
        })],
      });

      const result = await runner.run({ ...LANE, leaseSeconds: 1 });

      expect(result.records[0]!.status).toBe('failed_retryable');
      expect(result.records[0]!.errorKind).toBe(EXTRACTION_ERROR_KIND_LEASE_LOST);
      expect(result.records[0]!.leaseLost).toBe(true);
      // The newer holder's lease is intact: this run did not overwrite it.
      expect(jobs.get(result.records[0]!.jobId)!.status).toBe('leased');
    } finally {
      jobs.close();
    }
  });
});

describe('extraction runner: the health probe costs throughput and nothing else', () => {
  test('a failing probe pauses the lane before any job is leased', async () => {
    const jobs = jobStore();
    try {
      enqueue(jobs, 3);
      const runner = runnerFor({
        jobs,
        healthProbes: new Map([[FAKE_KIND, async () => { throw new Error('backend down'); }]]),
      });

      const result = await runner.run({ ...LANE, extractorKind: FAKE_KIND });

      expect(result.paused).toBe(true);
      expect(result.pauseReason).toBe(EXTRACTION_PAUSE_HEALTH_PROBE);
      expect(result.leasedJobs).toBe(0);
      // No attempt was charged to any job, which is the whole point: a probe
      // that is itself wrong must not be able to burn a retry budget.
      for (let index = 1; index <= 3; index += 1) {
        expect(jobs.counts(LANE).find((count) => count.status === 'queued')?.jobs).toBe(3);
      }
    } finally {
      jobs.close();
    }
  });

  test('the ignore policy runs the batch anyway', async () => {
    const jobs = jobStore();
    try {
      enqueue(jobs, 1);
      const runner = createFileExtractionRunner({
        jobs,
        registry: buildExtractorRegistry([fakeExtractor()]),
        corpora: [{ corpusId: CORPUS_ID, trustDomain: 'secure_local', source: fakeSource(), sink: recordingSink() }],
        healthProbes: new Map([[FAKE_KIND, async () => { throw new Error('backend down'); }]]),
        probeFailurePolicy: 'ignore',
      });

      const result = await runner.run({ ...LANE, extractorKind: FAKE_KIND });

      expect(result.paused).toBe(false);
      expect(result.counts.indexed).toBe(1);
    } finally {
      jobs.close();
    }
  });
});

describe('extraction runner: the deterministic OCR refusal reaches the vision lane', () => {
  function ocrRegistry() {
    return createDefaultExtractorRegistry({});
  }

  function settleOcrJobTerminally(
    jobs: LocalFileExtractionJobStore,
    errorKind: string,
    version: string,
  ): string {
    jobs.enqueue({
      refs: [ref(1, { mimeType: 'application/pdf' })],
      extractorKind: OCR_EXTRACTOR_KIND,
      extractorVersion: version,
      policyDecision: 'index_allowed',
    });
    const leased = jobs.lease({ ...LANE, workerId: 'ocr-worker' });
    const jobId = leased.leasedJobs[0]!.jobId;
    jobs.record({ jobId, workerId: 'ocr-worker', status: 'failed_terminal', errorKind });
    return jobId;
  }

  test('the shipped rules cover every deterministic rejection and point at the raster lane', () => {
    const registry = ocrRegistry();
    const rules = defaultTerminalReclassificationRules(registry);
    expect(rules.map((rule) => rule.lastErrorKind).sort())
      .toEqual([...OCR_DETERMINISTIC_PDF_REJECTION_KINDS].sort());
    for (const rule of rules) {
      expect(rule.fromExtractorKind).toBe(OCR_EXTRACTOR_KIND);
      expect(rule.toExtractorKind).toBe(VLM_PDF_EXTRACTOR_KIND);
      expect(rule.toExtractorVersion).toBe(registry.get(VLM_PDF_EXTRACTOR_KIND)!.version);
    }
  });

  for (const errorKind of OCR_DETERMINISTIC_PDF_REJECTION_KINDS) {
    test(`a job settled ${errorKind} is reopened under the vision lane`, async () => {
      const jobs = jobStore();
      try {
        const registry = ocrRegistry();
        const ocrJobId = settleOcrJobTerminally(
          jobs,
          errorKind,
          registry.get(OCR_EXTRACTOR_KIND)!.version,
        );
        const runner = createFileExtractionRunner({
          jobs,
          registry,
          corpora: [{ corpusId: CORPUS_ID, trustDomain: 'secure_local', source: fakeSource(), sink: recordingSink() }],
          reclassificationRules: defaultTerminalReclassificationRules(registry),
        });

        // Driven exactly as a live OCR lane drives it: the batch is filtered to
        // the OCR kind, so the reopening has to happen inside the run rather
        // than as a separate pass somebody has to remember.
        const result = await runner.run({ ...LANE, extractorKind: OCR_EXTRACTOR_KIND });

        expect(result.reclassification?.jobsEscalated).toBe(1);
        // The source job stays terminal and is stamped, so it can never be
        // reopened a second time by the same rule.
        const source = jobs.get(ocrJobId)!;
        expect(source.status).toBe('failed_terminal');
        expect(source.janitorTerminalRequeueCount).toBe(1);

        // A real, leasable job now exists under the vision lane.
        const vision = jobs.counts(LANE)
          .find((count) => count.extractorKind === VLM_PDF_EXTRACTOR_KIND);
        expect(vision).toEqual({
          status: 'queued',
          extractorKind: VLM_PDF_EXTRACTOR_KIND,
          jobs: 1,
        });
      } finally {
        jobs.close();
      }
    });
  }

  test('the reopened job is leasable and runs through the vision lane', async () => {
    const jobs = jobStore();
    const sink = recordingSink();
    try {
      const registry = buildExtractorRegistry([
        fakeExtractor({ kind: OCR_EXTRACTOR_KIND, version: 'ocr-v1' }),
        fakeExtractor({
          kind: VLM_PDF_EXTRACTOR_KIND,
          version: 'vision-v1',
          async extract() {
            return { status: 'indexed', text: 'text the vision lane could read' };
          },
        }),
      ]);
      settleOcrJobTerminally(jobs, 'ocrmypdf_pdf_signed', 'ocr-v1');
      const runner = createFileExtractionRunner({
        jobs,
        registry,
        corpora: [{ corpusId: CORPUS_ID, trustDomain: 'secure_local', source: fakeSource(), sink }],
        reclassificationRules: defaultTerminalReclassificationRules(registry),
      });

      const first = await runner.run({ ...LANE, extractorKind: VLM_PDF_EXTRACTOR_KIND });

      expect(first.reclassification?.jobsEscalated).toBe(1);
      expect(first.counts.indexed).toBe(1);
      expect(sink.accepted[0]!.text).toBe('text the vision lane could read');
      expect(sink.accepted[0]!.extractorKind).toBe(VLM_PDF_EXTRACTOR_KIND);
    } finally {
      jobs.close();
    }
  });

  test('reopening is idempotent: a second pass creates no duplicate', async () => {
    const jobs = jobStore();
    try {
      const registry = ocrRegistry();
      settleOcrJobTerminally(jobs, 'ocrmypdf_pdf_signed', registry.get(OCR_EXTRACTOR_KIND)!.version);
      const runner = createFileExtractionRunner({
        jobs,
        registry,
        corpora: [{ corpusId: CORPUS_ID, trustDomain: 'secure_local', source: fakeSource(), sink: recordingSink() }],
        reclassificationRules: defaultTerminalReclassificationRules(registry),
      });

      const first = runner.reclassifyTerminal({ ...LANE });
      const second = runner.reclassifyTerminal({ ...LANE });

      expect(first.jobsEscalated).toBe(1);
      expect(second.jobsEscalated).toBe(0);
      const signedRule = second.rules.find((rule) => rule.lastErrorKind === 'ocrmypdf_pdf_signed')!;
      expect(signedRule.skippedTargetExists).toBe(1);
      expect(
        jobs.counts(LANE).filter((count) => count.extractorKind === VLM_PDF_EXTRACTOR_KIND),
      ).toHaveLength(1);
    } finally {
      jobs.close();
    }
  });

  test('a non-deterministic OCR failure is left alone', async () => {
    const jobs = jobStore();
    try {
      const registry = ocrRegistry();
      settleOcrJobTerminally(jobs, 'ocr_command_failed', registry.get(OCR_EXTRACTOR_KIND)!.version);
      const runner = createFileExtractionRunner({
        jobs,
        registry,
        corpora: [{ corpusId: CORPUS_ID, trustDomain: 'secure_local', source: fakeSource(), sink: recordingSink() }],
        reclassificationRules: defaultTerminalReclassificationRules(registry),
      });

      expect(runner.reclassifyTerminal({ ...LANE }).jobsEscalated).toBe(0);
      expect(
        jobs.counts(LANE).filter((count) => count.extractorKind === VLM_PDF_EXTRACTOR_KIND),
      ).toEqual([]);
    } finally {
      jobs.close();
    }
  });
});

// --- end to end ------------------------------------------------------------

const E2E_ITEM_ID = 'e2e-item-1';
const E2E_LOCAL_ITEM_ID = `${ACCOUNT}:${E2E_ITEM_ID}`;

function e2eItem(): RawItem {
  return {
    identity: {
      family: 'file',
      provider: PROVIDER,
      accountScope: ACCOUNT,
      providerItemId: E2E_ITEM_ID,
      localItemId: E2E_LOCAL_ITEM_ID,
      sourceVersion: 'rev-1',
    },
    mimeType: 'application/pdf',
    content: { kind: 'metadata_only' },
    metadata: { name: 'Report.pdf', pathDisplay: '/Files/Report.pdf' },
    fetchedAt: '2026-07-28T00:00:00.000Z',
  };
}

function e2eConnector(): SourceConnector {
  const items = [e2eItem()];
  return {
    id: 'e2e-metadata-sync',
    family: 'file',
    async authenticate() {},
    async *listItems(_options?: SourceConnectorListOptions): AsyncIterable<SourceConnectorListPage> {
      yield { items, done: true };
    },
    async fetchItem(localItemId: string): Promise<RawItem> {
      const found = items.find((item) => item.identity.localItemId === localItemId);
      if (!found) throw new Error(`no such item: ${localItemId}`);
      return found;
    },
    classify: () => buildSourceSensitivity({ trustTier: 'S2', trustDomain: 'secure_local' }),
  };
}

// The one candidate the store above already holds as metadata, so a plan pass
// queues exactly the job whose text is the thing under test.
function e2eSource(): FileExtractionSource {
  return fakeSource({
    async listCandidates(): Promise<ExtractionCandidatePage> {
      return {
        candidates: [{
          corpusId: CORPUS_ID,
          provider: PROVIDER,
          accountScope: ACCOUNT,
          approvedScopeKey: SCOPE_KEY,
          providerItemId: E2E_ITEM_ID,
          localItemId: E2E_LOCAL_ITEM_ID,
          sourceVersion: 'rev-1',
          mimeType: 'application/pdf',
          name: 'Report.pdf',
        }],
        done: true,
      };
    },
    async fetch(): Promise<FetchedBytes> {
      return { bytes: new TextEncoder().encode('%PDF-1.4'), mimeType: 'application/pdf' };
    },
  });
}

describe('extraction runner: end to end into a real connector store', () => {
  test('a fake source and a fake extractor put real chunks in the store', async () => {
    const store = new LocalConnectorStore({
      dbPath: join(mkdtempSync(join(tmpdir(), 'factory-runner-e2e-')), 'store.sqlite'),
      corpusId: CORPUS_ID,
      family: 'file',
      trustDomain: 'secure_local',
    });
    const jobs = jobStore();
    try {
      await store.syncFromConnector(e2eConnector(), { fetchContent: false });
      // The metadata sync ran but no text ever reached the spine.
      expect(store.localContent(E2E_LOCAL_ITEM_ID)?.storedChunks).toBe(0);

      const extractedText = 'The report body, as the extractor read it.';
      // A selection order is supplied so the plan pass exercises implicit
      // media-type selection rather than being handed a kind.
      const registry = buildExtractorRegistry([fakeExtractor({
        async extract() {
          return {
            status: 'indexed',
            text: extractedText,
            derivations: [{ artifactKind: 'document', chars: extractedText.length }],
          };
        },
      })], [FAKE_KIND]);
      const source = fakeSource({
        async listCandidates(): Promise<ExtractionCandidatePage> {
          return {
            candidates: [{
              corpusId: CORPUS_ID,
              provider: PROVIDER,
              accountScope: ACCOUNT,
              approvedScopeKey: SCOPE_KEY,
              providerItemId: E2E_ITEM_ID,
              localItemId: E2E_LOCAL_ITEM_ID,
              sourceVersion: 'rev-1',
              mimeType: 'application/pdf',
              name: 'Report.pdf',
            }],
            done: true,
          };
        },
        async fetch(): Promise<FetchedBytes> {
          return { bytes: new TextEncoder().encode('%PDF-1.4'), mimeType: 'application/pdf' };
        },
      });

      const runner = createFileExtractionRunner({
        jobs,
        registry,
        corpora: [{
          corpusId: CORPUS_ID,
          trustDomain: 'secure_local',
          source,
          sink: createConnectorStoreExtractionSink({
            store,
            classify: () => buildSourceSensitivity({ trustTier: 'S2', trustDomain: 'secure_local' }),
            syncConnectorId: 'file-extraction-factory',
            ownerConnectorId: 'e2e-metadata-sync',
            ownershipKind: 'observed',
          }),
        }],
      });

      const planned = await runner.plan({ ...LANE, limit: 10 });
      expect(planned.candidates).toBe(1);
      expect(planned.jobsQueued).toBe(1);
      expect(planned.extractorKinds).toEqual([FAKE_KIND]);

      const result = await runner.run({ ...LANE });

      expect(result.counts.indexed).toBe(1);
      expect(result.records[0]!.chunksIndexed).toBe(1);
      expect(result.records[0]!.artifactsRecorded).toBe(1);

      const stored = store.localContent(E2E_LOCAL_ITEM_ID)!;
      expect(stored.storedChunks).toBe(1);
      expect(stored.chunks).toEqual([extractedText]);

      // The structural provenance stayed on the job side, keyed by item.
      const artifacts = jobs.artifacts(CORPUS_ID, E2E_LOCAL_ITEM_ID);
      expect(artifacts).toHaveLength(1);
      expect(artifacts[0]!.derivation.artifactKind).toBe('document');

      // A second pass over the same item is a no-op rather than a rewrite.
      const again = await runner.plan({ ...LANE, limit: 10 });
      expect(again.jobsExisting).toBe(1);
      expect(again.jobsQueued).toBe(0);
    } finally {
      jobs.close();
      store.close();
    }
  });
});

// The `recycle-after-precheck` schedule, driven end to end against a real
// store. The runner's pre-write guard reads a lease expiry cached at claim
// time, so a recycle that reclaims a still-unexpired lease — `staleOnly:
// false`, which is exactly what a paused backend uses — is invisible to it. The
// superseded worker sailed past it, wrote its stale text over the new holder's
// content, and only afterwards had its record() refused: the job database said
// the new holder won while the corpus held the loser's output.
describe('extraction runner: a superseded claim never reaches the corpus', () => {
  test('a recycle that reclaims a live lease stops the stale worker at the sink', async () => {
    const store = new LocalConnectorStore({
      dbPath: join(mkdtempSync(join(tmpdir(), 'factory-runner-fence-')), 'store.sqlite'),
      corpusId: CORPUS_ID,
      family: 'file',
      trustDomain: 'secure_local',
    });
    const jobs = jobStore();
    try {
      await store.syncFromConnector(e2eConnector(), { fetchContent: false });

      const sink = createConnectorStoreExtractionSink({
        store,
        classify: () => buildSourceSensitivity({ trustTier: 'S2', trustDomain: 'secure_local' }),
        syncConnectorId: 'file-extraction-factory',
        ownerConnectorId: 'e2e-metadata-sync',
        ownershipKind: 'observed',
        claims: jobs,
      });

      const newHolderText = 'The report body, as the CURRENT holder read it.';
      const staleText = 'The report body, as the SUPERSEDED worker read it.';
      let newHolderWrote = false;

      const registry = buildExtractorRegistry([fakeExtractor({
        async extract(): Promise<ExtractorOutput> {
          // Worker A is mid-extraction. A provider pause recycles the lane with
          // staleOnly false, which requeues A's LIVE lease and clears its
          // token; A's cached expiry is untouched and still in the future.
          jobs.recycleLeases({ ...LANE, extractorKindPrefix: 'fake', staleOnly: false });
          // Worker B claims the same job and lands its own extraction. Same
          // worker id on purpose: the whole fleet runs under one, so identity
          // cannot separate these two runs and only the grant can.
          const stolen = jobs.lease({
            ...LANE,
            workerId: DEFAULT_EXTRACTION_WORKER_ID,
            leaseSeconds: 900,
          }).leasedJobs[0]!;
          const accepted = await sink.accept({
            ref: stolen.ref,
            text: newHolderText,
            extractorKind: stolen.extractorKind,
            extractorVersion: stolen.extractorVersion,
            fetchedAt: '2026-07-28T01:00:00.000Z',
            claim: {
              jobId: stolen.jobId,
              leaseToken: stolen.leaseToken,
              grantAuthority: stolen.grantAuthority,
              grantOrdinal: stolen.grantOrdinal,
            },
          });
          newHolderWrote = accepted.accepted;
          return { status: 'indexed', text: staleText };
        },
      })], [FAKE_KIND]);

      const runner = createFileExtractionRunner({
        jobs,
        registry,
        corpora: [{ corpusId: CORPUS_ID, trustDomain: 'secure_local', source: e2eSource(), sink }],
      });

      await runner.plan({ ...LANE, limit: 10 });
      const result = await runner.run({ ...LANE });

      // The current holder's write went in, under a claim that still held.
      expect(newHolderWrote).toBe(true);
      // The superseded worker is refused BEFORE the corpus mutation, and the
      // corpus still carries the current holder's text rather than the loser's.
      expect(store.localContent(E2E_LOCAL_ITEM_ID)!.chunks).toEqual([newHolderText]);
      expect(result.records).toHaveLength(1);
      expect(result.records[0]!.status).toBe('failed_retryable');
      expect(result.records[0]!.errorKind).toBe(EXTRACTION_ERROR_KIND_LEASE_LOST);
      expect(result.records[0]!.leaseLost).toBe(true);
    } finally {
      jobs.close();
      store.close();
    }
  });

  // The `recycle-between-probe-and-restore` schedule, which the probe alone
  // cannot close. The queue and the corpus are two databases, so no
  // transaction spans them: the probe answers truthfully, the recycle and the
  // new holder's write land in the gap, and the superseded worker's restore
  // then overwrites content the queue says belongs to somebody else. Only a
  // corpus-side monotonic grant, recorded inside the write's own transaction,
  // can refuse that write.
  test('a recycle that lands between the probe and the write cannot overwrite the new holder', async () => {
    const store = new LocalConnectorStore({
      dbPath: join(mkdtempSync(join(tmpdir(), 'factory-runner-cas-')), 'store.sqlite'),
      corpusId: CORPUS_ID,
      family: 'file',
      trustDomain: 'secure_local',
    });
    const jobs = jobStore();
    try {
      await store.syncFromConnector(e2eConnector(), { fetchContent: false });

      const sinkOptions = {
        store,
        classify: () => buildSourceSensitivity({ trustTier: 'S2', trustDomain: 'secure_local' }),
        syncConnectorId: 'file-extraction-factory',
        ownerConnectorId: 'e2e-metadata-sync',
        ownershipKind: 'observed' as const,
      };
      const newHolderSink = createConnectorStoreExtractionSink({ ...sinkOptions, claims: jobs });

      const newHolderText = 'The report body, as the CURRENT holder read it.';
      const staleText = 'The report body, as the SUPERSEDED worker read it.';
      let newHolderWrite: Promise<{ accepted: boolean }> | undefined;

      // The probe answers first, exactly as the job store would, and only then
      // does the race land. That is the whole schedule: a true answer that was
      // already stale by the time the corpus mutation began.
      const racedClaims = {
        holdsExtractionClaim(claim: Parameters<typeof jobs.holdsExtractionClaim>[0]): boolean {
          const held = jobs.holdsExtractionClaim(claim);
          if (!held || newHolderWrite !== undefined) return held;
          jobs.recycleLeases({ ...LANE, extractorKindPrefix: 'fake', staleOnly: false });
          const stolen = jobs.lease({
            ...LANE,
            workerId: DEFAULT_EXTRACTION_WORKER_ID,
            leaseSeconds: 900,
          }).leasedJobs[0]!;
          // `accept` has no await before its write, so the current holder's
          // content is committed by the time this returns.
          newHolderWrite = newHolderSink.accept({
            ref: stolen.ref,
            text: newHolderText,
            extractorKind: stolen.extractorKind,
            extractorVersion: stolen.extractorVersion,
            fetchedAt: '2026-07-28T01:00:00.000Z',
            claim: {
              jobId: stolen.jobId,
              leaseToken: stolen.leaseToken,
              grantAuthority: stolen.grantAuthority,
              grantOrdinal: stolen.grantOrdinal,
            },
          });
          return held;
        },
      };

      const runner = createFileExtractionRunner({
        jobs,
        registry: buildExtractorRegistry([fakeExtractor({
          async extract(): Promise<ExtractorOutput> {
            return { status: 'indexed', text: staleText };
          },
        })], [FAKE_KIND]),
        corpora: [{
          corpusId: CORPUS_ID,
          trustDomain: 'secure_local',
          source: e2eSource(),
          sink: createConnectorStoreExtractionSink({ ...sinkOptions, claims: racedClaims }),
        }],
      });

      await runner.plan({ ...LANE, limit: 10 });
      const result = await runner.run({ ...LANE });

      expect((await newHolderWrite!).accepted).toBe(true);
      // The corpus keeps the current holder's text. The superseded worker's
      // write is refused by the grant recorded with it, not merely reported as
      // a lost lease after the damage was already committed.
      expect(store.localContent(E2E_LOCAL_ITEM_ID)!.chunks).toEqual([newHolderText]);
      expect(result.records[0]!.status).toBe('failed_retryable');
      expect(result.records[0]!.errorKind).toBe(EXTRACTION_ERROR_KIND_LEASE_LOST);
      expect(result.records[0]!.leaseLost).toBe(true);
    } finally {
      jobs.close();
      store.close();
    }
  });

  test('a claim that still holds writes exactly as before', async () => {
    const store = new LocalConnectorStore({
      dbPath: join(mkdtempSync(join(tmpdir(), 'factory-runner-fence-ok-')), 'store.sqlite'),
      corpusId: CORPUS_ID,
      family: 'file',
      trustDomain: 'secure_local',
    });
    const jobs = jobStore();
    try {
      await store.syncFromConnector(e2eConnector(), { fetchContent: false });
      const text = 'The report body, read under a claim nobody took away.';
      const runner = createFileExtractionRunner({
        jobs,
        registry: buildExtractorRegistry([fakeExtractor({
          async extract(): Promise<ExtractorOutput> {
            return { status: 'indexed', text };
          },
        })], [FAKE_KIND]),
        corpora: [{
          corpusId: CORPUS_ID,
          trustDomain: 'secure_local',
          source: e2eSource(),
          sink: createConnectorStoreExtractionSink({
            store,
            classify: () => buildSourceSensitivity({ trustTier: 'S2', trustDomain: 'secure_local' }),
            syncConnectorId: 'file-extraction-factory',
            ownerConnectorId: 'e2e-metadata-sync',
            ownershipKind: 'observed',
            claims: jobs,
          }),
        }],
      });

      await runner.plan({ ...LANE, limit: 10 });
      const result = await runner.run({ ...LANE });

      expect(result.records[0]!.status).toBe('indexed');
      expect(store.localContent(E2E_LOCAL_ITEM_ID)!.chunks).toEqual([text]);
    } finally {
      jobs.close();
      store.close();
    }
  });
});
