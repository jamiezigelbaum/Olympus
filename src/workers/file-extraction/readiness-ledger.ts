// The extraction factory's answer to "how much of this corpus is actually
// answerable, and how much is it never asked to read".
//
// It exists because the readiness half of the status payload went missing when
// the last per-family index was deleted: the connector-store status arm
// published five generic counts, the dashboard's coverage math found no
// per-item readiness key, and its chunk fallback pinned the answer-ready
// percentage at 100 for a corpus most of which had never been extracted.
//
// Nothing here knows which source it is reading, and the ledger it replaces was
// reachable only through a corpus-id equality check — the shape this module
// exists to not have. The factory already partitions every job by corpus, and
// the vocabulary it decides in — a policy decision, a terminal status — is the
// shared job vocabulary in types.ts, so a corpus that grows an extraction lane
// gets these counts by being enumerated, with no branch added anywhere.

import {
  BLOCKED_BY_POLICY_COUNT_KEY,
  METADATA_ONLY_EXPECTED_COUNT_KEY,
} from '../dashboard/answer-ready-coverage.ts';
import type { SourceIndexReadinessLedger } from '../source-index/status.ts';
import type { ContentExtractionThroughputSignal } from '../../core/ingestion-throughput.ts';
import type { ExtractionCorpusReadiness, LocalFileExtractionJobStore } from './job-store.ts';

/**
 * The readiness ledger backed by the shared extraction queue.
 *
 * What it deliberately does NOT publish is the evidence-quality half of the
 * retired verdict ladder — stale revisions, part-read documents, OCR
 * escalations, low-confidence text. Those verdicts are scored from stored
 * artifacts, warnings and confidences, not from a job's resting status, and a
 * plausible-looking count invented from the queue alone would be worse than an
 * absent one. Their needs-review chips stay absent until the evidence they read
 * is published through the same shared path.
 */
export function createExtractionReadinessLedger(
  jobs: Pick<LocalFileExtractionJobStore, 'corpusReadiness'>,
): SourceIndexReadinessLedger {
  return {
    snapshotForCorpus(corpusId: string) {
      let readiness: ExtractionCorpusReadiness;
      try {
        readiness = jobs.corpusReadiness(corpusId);
      } catch {
        // A status poll must not fail because the queue is momentarily
        // unreadable. Absent counts leave the coverage math on its own honest
        // fallback, which understates rather than claiming a full corpus.
        return undefined;
      }
      return {
        counts: {
          [METADATA_ONLY_EXPECTED_COUNT_KEY]: readiness.metadataOnlyExpectedItems,
          [BLOCKED_BY_POLICY_COUNT_KEY]: readiness.blockedByPolicyItems,
          extraction_jobs_queued: readiness.queuedJobs,
          extraction_jobs_queued_actionable: readiness.queuedJobs,
          extraction_jobs_leased: readiness.leasedJobs,
          extraction_jobs_failed: readiness.failedRetryableJobs + readiness.failedTerminalJobs,
          extraction_jobs_failed_actionable: readiness.failedActionableJobs,
          extraction_jobs_retryable_due_actionable: readiness.retryableDueJobs,
        },
        contentExtractionThroughput: {
          actionable_queued: readiness.queuedJobs,
          actionable_retryable_due: readiness.retryableDueJobs,
          ...(readiness.oldestActionableAt ? { oldest_actionable_at: readiness.oldestActionableAt } : {}),
          ...(readiness.newestTerminalProgressAt
            ? { newest_terminal_progress_at: readiness.newestTerminalProgressAt }
            : {}),
        } satisfies ContentExtractionThroughputSignal,
      };
    },
  };
}
