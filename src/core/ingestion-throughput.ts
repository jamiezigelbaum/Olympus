import { OperationError } from './operation-error.ts';

export const DEFAULT_DROPBOX_CONTENT_EXTRACTION_STALL_HOURS = 6;
export const DROPBOX_CONTENT_EXTRACTION_STALL_HOURS_ENV = 'OLYMPUS_DROPBOX_CONTENT_EXTRACTION_STALL_HOURS';

export interface ContentExtractionThroughputSignal {
  actionable_queued: number;
  actionable_retryable_due: number;
  oldest_actionable_at?: string;
  newest_terminal_progress_at?: string;
}

export interface ContentExtractionThroughputAssessment {
  state: 'idle' | 'healthy' | 'warning' | 'stalled' | 'unknown';
  actionable: number;
  threshold_hours: number;
  hours_without_terminal_progress?: number;
}

export function dropboxContentExtractionStallHours(
  env: Record<string, string | undefined> = process.env,
): number {
  const raw = env[DROPBOX_CONTENT_EXTRACTION_STALL_HOURS_ENV];
  if (raw === undefined || raw.trim().length === 0) {
    return DEFAULT_DROPBOX_CONTENT_EXTRACTION_STALL_HOURS;
  }
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    throw new OperationError(
      'invalid_params',
      `${DROPBOX_CONTENT_EXTRACTION_STALL_HOURS_ENV} must be greater than zero.`,
    );
  }
  return value;
}

export function assessContentExtractionThroughput(
  signal: ContentExtractionThroughputSignal,
  options: { now?: Date; thresholdHours?: number } = {},
): ContentExtractionThroughputAssessment {
  const actionable = nonNegativeCount(signal.actionable_queued) + nonNegativeCount(signal.actionable_retryable_due);
  const thresholdHours = options.thresholdHours ?? DEFAULT_DROPBOX_CONTENT_EXTRACTION_STALL_HOURS;
  if (!Number.isFinite(thresholdHours) || thresholdHours <= 0) {
    throw new Error('Content extraction stall threshold must be greater than zero.');
  }
  if (actionable === 0) {
    return { state: 'idle', actionable, threshold_hours: thresholdHours };
  }

  const now = options.now ?? new Date();
  const progressAt = validDateMs(signal.newest_terminal_progress_at);
  const actionableAt = validDateMs(signal.oldest_actionable_at);
  const observedSince = progressAt !== undefined && actionableAt !== undefined
    ? Math.max(progressAt, actionableAt)
    : progressAt ?? actionableAt;
  if (observedSince === undefined || Number.isNaN(now.getTime())) {
    return { state: 'unknown', actionable, threshold_hours: thresholdHours };
  }
  const hours = round1(Math.max(0, now.getTime() - observedSince) / 3_600_000);
  const state = hours >= thresholdHours
    ? 'stalled'
    : hours >= thresholdHours / 2
      ? 'warning'
      : 'healthy';
  return {
    state,
    actionable,
    threshold_hours: thresholdHours,
    hours_without_terminal_progress: hours,
  };
}

function validDateMs(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function nonNegativeCount(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0;
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}
