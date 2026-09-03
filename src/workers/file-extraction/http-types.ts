export interface FileExtractionPlanResponse {
  kind: 'file_extraction_plan';
  corpus_id: string;
  candidates: number;
  jobs_queued: number;
  jobs_existing: number;
  jobs_forced: number;
  jobs_skipped_too_large: number;
  jobs_unroutable: number;
  extractor_kinds: readonly string[];
  next_cursor?: string;
  done: boolean;
  policy: {
    worker_private_surface: true;
    raw_source_exposed: false;
    source_text_returned: false;
    file_bytes_downloaded: false;
    local_only: boolean;
    trust_domain: string;
    egress_destination?: 'venice_private' | 'venice_tee' | 'venice_e2ee' | 'venice_mixed_approved';
  };
}

export interface FileExtractionRunResponse {
  kind: 'file_extraction_run';
  corpus_id: string;
  provider: string;
  account: string;
  scope_key_hash: string;
  worker_id_hash: string;
  leased_jobs: number;
  processed_jobs: number;
  abandoned_leases: number;
  paused: boolean;
  pause_reason?: string;
  preflight_error_kind?: string;
  consecutive_retryable_failures: number;
  counts: {
    indexed: number;
    metadata_only: number;
    blocked_policy: number;
    skipped_unsupported: number;
    skipped_too_large: number;
    failed_retryable: number;
    failed_terminal: number;
  };
  records: Array<{
    job_id: string;
    status: string;
    extractor_kind: string;
    extractor_version: string;
    attempts: number;
    error_kind?: string;
    next_retry_at?: string;
    chunks_indexed?: number;
    chunks_awaiting_embedding?: number;
    artifacts_recorded?: number;
    egress_destination?: 'venice_private' | 'venice_tee' | 'venice_e2ee' | 'venice_mixed_approved';
    lease_lost?: true;
  }>;
  policy: {
    worker_private_surface: true;
    raw_source_exposed: false;
    source_text_returned: false;
    file_bytes_persisted: false;
    temp_bytes_cleaned: true;
    local_only: boolean;
    trust_domain: string;
    egress_destination?: 'venice_private' | 'venice_tee' | 'venice_e2ee' | 'venice_mixed_approved';
  };
}

export interface FileExtractionLeaseRecycleResponse {
  kind: 'file_extraction_lease_recycle';
  corpus_id: string;
  extractor_kind_prefix: string;
  matched_jobs: number;
  jobs_requeued: number;
  stale_only: boolean;
  dry_run: boolean;
}

export interface FileExtractionJanitorRequeueResponse {
  kind: 'file_extraction_janitor_requeue';
  corpus_id: string;
  mode: 'expired_retryable' | 'terminal_reclassification';
  matched_jobs: number;
  jobs_requeued: number;
  jobs_escalated: number;
  skipped_attempt_budget: number;
  skipped_already_janitor_requeued: number;
  skipped_policy_excluded: number;
  skipped_escalation_budget: number;
  skipped_target_exists: number;
  network_guard_override_used: boolean;
  dry_run: boolean;
  reason: string;
}
