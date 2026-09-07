import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { WorkerCredentialDegradation } from './credential-degradation.ts';

const SAFE_ID = /^[a-zA-Z0-9._:-]{1,160}$/;

// Report freshness is independent of the process that produced the report.
export const CREDENTIAL_HEALTH_REPORT_MAX_AGE_MS = 28 * 60 * 60 * 1000;

// A future timestamp must not keep an old report fresh indefinitely.
export const CREDENTIAL_HEALTH_MAX_FUTURE_SKEW_MS = 10 * 60 * 1000;

export type CredentialHealthStatus =
  | 'healthy'
  | 'reauth_required'
  | 'missing'
  | 'degraded'
  | 'skipped';

export type CredentialHealthType =
  | 'oauth2_refresh'
  | 'rotating_oauth2_refresh'
  | 'static_api_key'
  | 'non_refreshable_session';

/**
 * Describes how the report producer checked the credential. Reading a report
 * never performs a credential check or refresh.
 */
export type CredentialProbeMode = 'active' | 'passive';

export interface CredentialHealthResult {
  handle: string;
  provider: string;
  source_ids: string[];
  credential_type: CredentialHealthType;
  status: CredentialHealthStatus;
  checked_at: string;
  probe_mode?: CredentialProbeMode;
  reason?: string;
}

export interface CredentialHealthReport {
  kind: 'credential_health_report';
  version: 1;
  generated_at: string;
  results: CredentialHealthResult[];
  policy: {
    counts_only: true;
    raw_source_exposed: false;
    secrets_exposed: false;
    x_refresh_forced: false;
    op_cached_read_only: true;
  };
}

export function defaultCredentialHealthReportPath(): string {
  return join(homedir(), '.local', 'state', 'olympus', 'credential-health', 'current.json');
}

export function readCredentialHealthReport(path: string = defaultCredentialHealthReportPath()): CredentialHealthReport | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return undefined;
  }
  return normalizeCredentialHealthReport(parsed);
}

export function credentialHealthReportIsStale(report: CredentialHealthReport, now: Date): boolean {
  const age = now.getTime() - Date.parse(report.generated_at);
  return age > CREDENTIAL_HEALTH_REPORT_MAX_AGE_MS || age < -CREDENTIAL_HEALTH_MAX_FUTURE_SKEW_MS;
}

export function credentialHealthDegradations(
  report: CredentialHealthReport | undefined,
  now: Date = new Date(),
): WorkerCredentialDegradation[] {
  if (!report) return [];
  // An old report describes a world that may already
  // have been repaired. Say the check is stale rather than keep paging its
  // findings as if they were current.
  if (credentialHealthReportIsStale(report, now)) {
    return [{
      kind: 'worker_credential_degraded',
      display_name: 'Credential health: stale probe report',
      state: 'retrying',
      status_label: 'Credential unavailable - needs your attention',
      hint: 'This credential health report is out of date. Check the source connection status in Setup.',
      attempts: 1,
      max_attempts: 1,
    }];
  }
  return report.results
    .filter((result) => result.status === 'reauth_required'
      || result.status === 'missing'
      || result.status === 'degraded')
    .map((result): WorkerCredentialDegradation => ({
      kind: 'worker_credential_degraded',
      display_name: `Credential health: ${result.handle}`,
      state: result.status === 'degraded' ? 'retrying' : 'stopped',
      status_label: 'Credential unavailable - needs your attention',
      hint: result.status === 'degraded'
        ? 'This report could not confirm the connection. Check its current status in Setup and retry the source.'
        : 'Reconnect or restore this source credential in Setup.',
      attempts: 1,
      max_attempts: 1,
      ...(result.source_ids.length > 0 ? { affected_profiles: [...result.source_ids] } : {}),
    }));
}

function normalizeCredentialHealthReport(value: unknown): CredentialHealthReport | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const record = value as Partial<CredentialHealthReport>;
  if (record.kind !== 'credential_health_report' || record.version !== 1
    || !validTimestamp(record.generated_at) || !Array.isArray(record.results)
    // The policy block is the report's own claim about what the probe was
    // allowed to do. Substituting the canonical one for whatever was on disk
    // launders a policyless or drifted report into a valid one.
    || !isCanonicalCredentialHealthPolicy(record.policy)) return undefined;
  const generatedAt = Date.parse(record.generated_at);
  const results: CredentialHealthResult[] = [];
  for (const value of record.results) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
    const item = value as Partial<CredentialHealthResult>;
    const handle = safeId(item.handle);
    const provider = safeId(item.provider);
    if (!handle || !provider || !validTimestamp(item.checked_at)
      || !isHealthStatus(item.status) || !isCredentialType(item.credential_type)
      || !Array.isArray(item.source_ids) || item.source_ids.some((id) => !safeId(id))
      || (item.probe_mode !== undefined && !isProbeMode(item.probe_mode))
      || (item.reason !== undefined && !safeId(item.reason))) return undefined;
    // A result cannot have been checked after the report that carries it was
    // written, nor a whole cadence before it.
    const checkedAt = Date.parse(item.checked_at);
    if (checkedAt - generatedAt > CREDENTIAL_HEALTH_MAX_FUTURE_SKEW_MS
      || generatedAt - checkedAt > CREDENTIAL_HEALTH_REPORT_MAX_AGE_MS) return undefined;
    results.push({
      handle,
      provider,
      source_ids: [...item.source_ids],
      credential_type: item.credential_type,
      status: item.status,
      checked_at: new Date(item.checked_at).toISOString(),
      ...(item.probe_mode ? { probe_mode: item.probe_mode } : {}),
      ...(item.reason ? { reason: item.reason } : {}),
    });
  }
  return {
    kind: 'credential_health_report',
    version: 1,
    generated_at: new Date(record.generated_at).toISOString(),
    results,
    policy: credentialHealthPolicy(),
  };
}

function isCanonicalCredentialHealthPolicy(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const canonical = credentialHealthPolicy() as unknown as Record<string, unknown>;
  const policy = value as Record<string, unknown>;
  const keys = Object.keys(canonical);
  return Object.keys(policy).length === keys.length
    && keys.every((key) => policy[key] === canonical[key]);
}

function credentialHealthPolicy(): CredentialHealthReport['policy'] {
  return {
    counts_only: true,
    raw_source_exposed: false,
    secrets_exposed: false,
    x_refresh_forced: false,
    op_cached_read_only: true,
  };
}

function safeId(value: unknown): string | undefined {
  return typeof value === 'string' && SAFE_ID.test(value) ? value : undefined;
}

function validTimestamp(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}

function isHealthStatus(value: unknown): value is CredentialHealthStatus {
  return value === 'healthy' || value === 'reauth_required' || value === 'missing'
    || value === 'degraded' || value === 'skipped';
}

function isCredentialType(value: unknown): value is CredentialHealthType {
  return value === 'oauth2_refresh' || value === 'rotating_oauth2_refresh'
    || value === 'static_api_key' || value === 'non_refreshable_session';
}

function isProbeMode(value: unknown): value is CredentialProbeMode {
  return value === 'active' || value === 'passive';
}
