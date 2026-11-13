/**
 * Worker-side adoption of size refusals in the existing extraction queue.
 */
import { existsSync } from 'node:fs';
import { sourceSizeBytes, sourceSizeCeiling, sizeHeldItemKey, SOURCE_SIZE_LIMITS, type SourceSizeLimit } from '../../core/source-size-limits.ts';
import { readOwnerLimitOverride, saveOwnerLimitOverride } from '../../core/owner-limit-settings.ts';
import { createLimitStopReporter } from '../../core/limit-stops.ts';
import { OperationError } from '../../core/operation-error.ts';
import { LocalFileExtractionJobStore, defaultFileExtractionJobsDbPath } from './job-store.ts';

const reporter = createLimitStopReporter();

export function refreshSourceSizeStop(jobs: LocalFileExtractionJobStore, policy: SourceSizeLimit, now = new Date()): void {
  const held = jobs.sizeHeldJobs(policy.providers);
  if (!held.length) { reporter.clear(policy.id, policy.subject); return; }
  const limit = held.reduce((max, job) => Math.max(max, Math.min(job.maxBytes ?? Infinity, sourceSizeBytes(policy, job.ref, now))), 0);
  const sizes = held.flatMap(job => job.ref.sizeBytes === undefined ? [] : [job.ref.sizeBytes]);
  reporter.report({ id: policy.id, subject: policy.subject, since: now.toISOString(),
    limit, used: sizes.length ? sizes.reduce((max, size) => Math.max(max, size), 0) : null,
    reason: 'source_too_large', waiting: { items: new Set(held.map(job => sizeHeldItemKey(job.ref))).size },
    toContinue: { raiseTo: Math.min(policy.ceilingBytes, sizes.reduce((max, size) => Math.max(max, size), limit + 1)) },
  });
}

/**
 * Durable per-version grants survive restart and never apply to future files.
 */
export function raiseSourceSizeLimit(id: string, to: number, keep: boolean, now: Date): void {
  const policy = SOURCE_SIZE_LIMITS.find(policy => policy.id === id);
  if (!policy) throw new OperationError('invalid_params', 'This limit has no Raise action.');
  if (to > policy.ceilingBytes) throw new OperationError('invalid_params', `The memory safety ceiling is ${policy.ceilingBytes} bytes (${policy.ceilingBytes / 1024 / 1024} MiB).`);
  const path = defaultFileExtractionJobsDbPath();
  if (!existsSync(path)) throw new OperationError('invalid_params', 'The held-file queue is unavailable.');
  const jobs = new LocalFileExtractionJobStore(path);
  try {
    const held = jobs.sizeHeldJobs(policy.providers);
    const current = held.reduce((max, job) => Math.max(max, Math.min(job.maxBytes ?? Infinity, sourceSizeBytes(policy, job.ref, now))), 0);
    if (to <= current) throw new OperationError('invalid_params', `--to must be greater than the current limit of ${current} bytes.`);
    if (!held.length) throw new OperationError('invalid_params', 'No files are held for size any more.');
    const ceiling = held.reduce((max, job) => Math.max(max, sourceSizeCeiling(policy, job.ref.mimeType)), 0);
    if (to > ceiling) throw new OperationError('invalid_params', `The memory safety ceiling is ${ceiling} bytes (${ceiling / 1024 / 1024} MiB).`);
    saveOwnerLimitOverride(policy.id, to, keep, now, undefined, held.map(job => sizeHeldItemKey(job.ref)));
    resumeGrantedSizeHeld(jobs, policy, now);
    refreshSourceSizeStop(jobs, policy, now);
  } finally { jobs.close(); }
}

/**
 * A crash after writing the grant must not lose the continuation.
 */
export function resumeGrantedSizeHeld(jobs: LocalFileExtractionJobStore, policy: SourceSizeLimit, now = new Date()): void {
  const byAmount = new Map<number, string[]>();
  for (const job of jobs.sizeHeldJobs(policy.providers)) {
    const grant = readOwnerLimitOverride(policy.id, now, undefined, sizeHeldItemKey(job.ref));
    if (grant === undefined) continue;
    const to = sourceSizeBytes(policy, job.ref, now);
    // A legacy source refusal can carry the reader's larger cap. Even when
    // that equals the grant, a file known to fit still needs its first retry.
    if (to === job.maxBytes && (job.ref.sizeBytes === undefined || job.ref.sizeBytes > to)) continue;
    const ids = byAmount.get(to) ?? [];
    ids.push(job.jobId); byAmount.set(to, ids);
  }
  for (const [to, ids] of byAmount) jobs.requeueSizeHeld(ids, to);
}
