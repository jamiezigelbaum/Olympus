import { randomUUID } from 'node:crypto';
/**
 * A single-item promotion, shared by owner actions and question-driven reads.
 * Folder policy and byte acquisition stay behind the runtime's resolver.
 */
import type { EnqueueExtractionJobsRequest, LocalFileExtractionJobStore } from './job-store.ts';

export interface OnDemandReadRequest {
  itemRef: { corpusId: string; providerItemId: string };
  requester: 'owner' | 'remote_app' | 'analyst';
  questionId?: string;
}

export interface OnDemandReadLimit {
  id: 'on_demand_reads_per_question';
  limit: { files: number; bytes: number };
  used: { files: number; bytes: number };
  waiting_names_count: number;
  resumes: 'never';
}

export interface OnDemandReadResult {
  state: 'reading' | 'queued' | 'capped' | 'refused';
  etaSeconds?: number;
  reason?: string | OnDemandReadLimit;
}

export type RequestOnDemandRead = (request: OnDemandReadRequest) => Promise<OnDemandReadResult>;

export interface OnDemandReadTarget {
  readableOnRequest: boolean;
  job: EnqueueExtractionJobsRequest;
  grant(): void;
}

export async function requestOnDemandRead(request: OnDemandReadRequest, context: {
  jobs: LocalFileExtractionJobStore;
  resolve(request: OnDemandReadRequest): OnDemandReadTarget | undefined | Promise<OnDemandReadTarget | undefined>;
  limits?: { files: number; bytes: number };
}): Promise<OnDemandReadResult> {
  if (!['owner', 'remote_app', 'analyst'].includes(request.requester)) return { state: 'refused', reason: 'invalid_requester' };
  const target = await context.resolve(request);
  if (!target || (request.requester !== 'owner' && !target.readableOnRequest)) return { state: 'refused', reason: 'names_only' };
  const ref = target.job.refs[0];
  if (!ref) return { state: 'refused', reason: 'item_not_found' };
  return context.jobs.enqueueOnDemandRead({ ...request, questionId: request.questionId?.trim() || randomUUID(),
    itemRef: { corpusId: ref.corpusId, providerItemId: ref.providerItemId },
  }, target.job, target.grant, context.limits);
}
