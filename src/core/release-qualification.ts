import { V0_4_PUBLIC_SOURCE_IDS } from './public-surface.ts';

export const RELEASE_QUALIFICATION_HOST_OSES = ['darwin_arm64', 'linux_x64_ubuntu_lts'] as const;
export const RELEASE_QUALIFICATION_HOST_SURFACES = ['openclaw', 'hermes'] as const;
export const RELEASE_QUALIFICATION_EXECUTIONS = ['simulated', 'real_provider'] as const;
export const RELEASE_QUALIFICATION_RESULTS = ['passed', 'failed', 'skipped'] as const;
export const RELEASE_QUALIFICATION_ASSISTANCE = ['documented_flow', 'documented_recovery', 'engineering_intervention'] as const;
export const RELEASE_QUALIFICATION_CHECKS = [
  'install', 'lifecycle', 'dashboard_states', 'dependencies', 'inventory', 'upgrade', 'rollback', 'uninstall',
  'real_provider_end_to_end', 'pilot_task', 'hermes_end_to_end',
] as const;
export const RELEASE_QUALIFICATION_TARGETS = ['all', ...V0_4_PUBLIC_SOURCE_IDS] as const;
export const RELEASE_QUALIFICATION_END_STATES = [
  'installed', 'lifecycle_ready', 'dashboard_ready', 'dependencies_ready', 'inventory_verified',
  'answer_ready', 'evidence_ready', 'rolled_back', 'uninstalled', 'failed', 'skipped',
] as const;
export const RELEASE_QUALIFICATION_FAILURE_REASONS = [
  'credential_setup', 'provider_refusal', 'dependency_missing', 'lifecycle_failure', 'sync_incomplete',
  'extraction_gap', 'retrieval_failure', 'citation_failure', 'security_refusal', 'rollback_failure',
  'engineering_intervention', 'not_attempted',
] as const;

type QualificationTarget = typeof RELEASE_QUALIFICATION_TARGETS[number];
type QualificationCheck = typeof RELEASE_QUALIFICATION_CHECKS[number];
type QualificationEndState = typeof RELEASE_QUALIFICATION_END_STATES[number];

export interface ReleaseQualificationAttempt {
  kind: 'olympus_release_qualification_attempt';
  schema_version: 1;
  source_id: QualificationTarget;
  host_os: typeof RELEASE_QUALIFICATION_HOST_OSES[number];
  host_surface: typeof RELEASE_QUALIFICATION_HOST_SURFACES[number];
  execution_kind: typeof RELEASE_QUALIFICATION_EXECUTIONS[number];
  check: QualificationCheck;
  artifact_sha256: string;
  artifact_bytes: number;
  previous_artifact_sha256?: string;
  started_at: string;
  ended_at: string;
  start_state: 'clean_home' | 'installed_previous' | 'configured';
  end_state: QualificationEndState;
  assistance: typeof RELEASE_QUALIFICATION_ASSISTANCE[number];
  result: typeof RELEASE_QUALIFICATION_RESULTS[number];
  failure_reason?: typeof RELEASE_QUALIFICATION_FAILURE_REASONS[number];
  recorder?: 'real_provider_runner_v1';
  execution_session_id?: string;
  custody_hmac_sha256?: string;
  pilot_attempt_id?: string;
  reuse_intent?: 'yes' | 'no' | 'not_recorded';
  assertions_total: number;
  assertions_passed: number;
}

export interface ReleaseQualificationSummary {
  kind: 'olympus_release_qualification_summary';
  schema_version: 1;
  artifact_sha256: string;
  artifact_bytes: number;
  attempts: number;
  passed: number;
  eligible_passes: number;
  failed: number;
  skipped: number;
  real_provider_passes: number;
  simulated_passes: number;
  pilot_attempts: number;
  pilot_wants_reuse: number;
  assistance: Record<typeof RELEASE_QUALIFICATION_ASSISTANCE[number], number>;
  failure_reasons: Partial<Record<typeof RELEASE_QUALIFICATION_FAILURE_REASONS[number], number>>;
}

const EXPECTED_PASS_STATE: Record<QualificationCheck, QualificationEndState> = {
  install: 'installed', lifecycle: 'lifecycle_ready', dashboard_states: 'dashboard_ready',
  dependencies: 'dependencies_ready', inventory: 'inventory_verified', upgrade: 'lifecycle_ready',
  rollback: 'rolled_back', uninstall: 'uninstalled', real_provider_end_to_end: 'answer_ready',
  pilot_task: 'answer_ready', hermes_end_to_end: 'answer_ready',
};
const MIN_PASS_ASSERTIONS: Partial<Record<QualificationCheck, number>> = {
  install: 4,
  lifecycle: 4,
  dashboard_states: 7,
  dependencies: 2,
  inventory: 4,
  upgrade: 4,
  rollback: 5,
  uninstall: 4,
  real_provider_end_to_end: 10,
  pilot_task: 7,
  hermes_end_to_end: 8,
};

export function parseReleaseQualificationAttempt(value: unknown): ReleaseQualificationAttempt {
  const record = asStrictRecord(value, [
    'kind', 'schema_version', 'source_id', 'host_os', 'host_surface', 'execution_kind', 'check',
    'artifact_sha256', 'artifact_bytes', 'previous_artifact_sha256', 'started_at', 'ended_at',
    'start_state', 'end_state', 'assistance', 'result', 'failure_reason', 'recorder', 'execution_session_id', 'custody_hmac_sha256', 'pilot_attempt_id', 'reuse_intent', 'assertions_total', 'assertions_passed',
  ]);
  const attempt: ReleaseQualificationAttempt = {
    kind: exact(record.kind, 'olympus_release_qualification_attempt', 'kind'),
    schema_version: exact(record.schema_version, 1, 'schema_version'),
    source_id: member(record.source_id, RELEASE_QUALIFICATION_TARGETS, 'source_id'),
    host_os: member(record.host_os, RELEASE_QUALIFICATION_HOST_OSES, 'host_os'),
    host_surface: member(record.host_surface, RELEASE_QUALIFICATION_HOST_SURFACES, 'host_surface'),
    execution_kind: member(record.execution_kind, RELEASE_QUALIFICATION_EXECUTIONS, 'execution_kind'),
    check: member(record.check, RELEASE_QUALIFICATION_CHECKS, 'check'),
    artifact_sha256: sha256(record.artifact_sha256, 'artifact_sha256'),
    artifact_bytes: positiveInteger(record.artifact_bytes, 'artifact_bytes'),
    ...(record.previous_artifact_sha256 === undefined ? {} : { previous_artifact_sha256: sha256(record.previous_artifact_sha256, 'previous_artifact_sha256') }),
    started_at: canonicalTimestamp(record.started_at, 'started_at'),
    ended_at: canonicalTimestamp(record.ended_at, 'ended_at'),
    start_state: member(record.start_state, ['clean_home', 'installed_previous', 'configured'] as const, 'start_state'),
    end_state: member(record.end_state, RELEASE_QUALIFICATION_END_STATES, 'end_state'),
    assistance: member(record.assistance, RELEASE_QUALIFICATION_ASSISTANCE, 'assistance'),
    result: member(record.result, RELEASE_QUALIFICATION_RESULTS, 'result'),
    ...(record.failure_reason === undefined ? {} : { failure_reason: member(record.failure_reason, RELEASE_QUALIFICATION_FAILURE_REASONS, 'failure_reason') }),
    ...(record.recorder === undefined ? {} : { recorder: exact(record.recorder, 'real_provider_runner_v1', 'recorder') }),
    ...(record.execution_session_id === undefined ? {} : { execution_session_id: safeHex(record.execution_session_id, 'execution_session_id', 32) }),
    ...(record.custody_hmac_sha256 === undefined ? {} : { custody_hmac_sha256: sha256(record.custody_hmac_sha256, 'custody_hmac_sha256') }),
    ...(record.pilot_attempt_id === undefined ? {} : { pilot_attempt_id: safeHex(record.pilot_attempt_id, 'pilot_attempt_id', 32) }),
    ...(record.reuse_intent === undefined ? {} : { reuse_intent: member(record.reuse_intent, ['yes', 'no', 'not_recorded'] as const, 'reuse_intent') }),
    assertions_total: nonNegativeInteger(record.assertions_total, 'assertions_total'),
    assertions_passed: nonNegativeInteger(record.assertions_passed, 'assertions_passed'),
  };
  validateAttemptSemantics(attempt);
  return attempt;
}

export function summarizeReleaseQualification(attempts: readonly ReleaseQualificationAttempt[]): ReleaseQualificationSummary {
  if (attempts.length === 0) throw new Error('At least one qualification attempt is required.');
  const artifact = `${attempts[0]!.artifact_sha256}:${attempts[0]!.artifact_bytes}`;
  if (attempts.some((attempt) => `${attempt.artifact_sha256}:${attempt.artifact_bytes}` !== artifact)) throw new Error('Qualification summary cannot mix artifact identities.');
  const cellKeys = attempts.map(releaseQualificationCellKey);
  if (new Set(cellKeys).size !== cellKeys.length) throw new Error('Qualification summary contains duplicate cells.');
  const rollbackBaselines = new Set(attempts.filter((attempt) => attempt.check === 'rollback').map((attempt) => attempt.previous_artifact_sha256));
  if (rollbackBaselines.size > 1) throw new Error('Qualification summary cannot mix rollback baselines.');
  const assistance = Object.fromEntries(RELEASE_QUALIFICATION_ASSISTANCE.map((value) => [value, 0])) as ReleaseQualificationSummary['assistance'];
  const failure_reasons: ReleaseQualificationSummary['failure_reasons'] = {};
  for (const attempt of attempts) {
    assistance[attempt.assistance] += 1;
    if (attempt.failure_reason) failure_reasons[attempt.failure_reason] = (failure_reasons[attempt.failure_reason] ?? 0) + 1;
  }
  const eligible = (attempt: ReleaseQualificationAttempt) => attempt.result === 'passed'
    && attempt.assistance !== 'engineering_intervention';
  return {
    kind: 'olympus_release_qualification_summary', schema_version: 1,
    artifact_sha256: attempts[0]!.artifact_sha256, artifact_bytes: attempts[0]!.artifact_bytes,
    attempts: attempts.length, passed: attempts.filter((attempt) => attempt.result === 'passed').length,
    eligible_passes: attempts.filter(eligible).length,
    failed: attempts.filter((attempt) => attempt.result === 'failed').length,
    skipped: attempts.filter((attempt) => attempt.result === 'skipped').length,
    real_provider_passes: attempts.filter((attempt) => eligible(attempt) && attempt.execution_kind === 'real_provider' && attempt.check === 'real_provider_end_to_end').length,
    simulated_passes: attempts.filter((attempt) => eligible(attempt) && attempt.execution_kind === 'simulated').length,
    pilot_attempts: attempts.filter((attempt) => attempt.check === 'pilot_task').length,
    pilot_wants_reuse: attempts.filter((attempt) => eligible(attempt) && attempt.check === 'pilot_task' && attempt.reuse_intent === 'yes').length,
    assistance, failure_reasons,
  };
}

export function releaseQualificationCellKey(attempt: ReleaseQualificationAttempt): string {
  return [attempt.execution_kind, attempt.host_os, attempt.host_surface, attempt.source_id, attempt.check, ...(attempt.pilot_attempt_id ? [attempt.pilot_attempt_id] : [])].join(':');
}

export function releaseQualificationCustodyPayload(attempt: ReleaseQualificationAttempt): string {
  const entries = Object.entries(attempt)
    .filter(([key]) => key !== 'custody_hmac_sha256')
    .sort(([left], [right]) => left.localeCompare(right));
  return JSON.stringify(Object.fromEntries(entries));
}

function validateAttemptSemantics(attempt: ReleaseQualificationAttempt): void {
  if (Date.parse(attempt.ended_at) < Date.parse(attempt.started_at)) throw new Error('ended_at precedes started_at.');
  if (attempt.assertions_passed > attempt.assertions_total) throw new Error('assertions_passed exceeds assertions_total.');
  if (attempt.result === 'passed') {
    if (attempt.failure_reason) throw new Error('A passing attempt cannot carry failure_reason.');
    if (attempt.end_state !== EXPECTED_PASS_STATE[attempt.check]) throw new Error(`A passing ${attempt.check} attempt must end in ${EXPECTED_PASS_STATE[attempt.check]}.`);
    if (attempt.assistance === 'engineering_intervention') throw new Error('Engineering intervention cannot produce a passing qualification attempt.');
    if (attempt.assertions_total === 0 || attempt.assertions_passed !== attempt.assertions_total) throw new Error('A passing attempt requires all assertions to pass.');
    if (attempt.assertions_total < (MIN_PASS_ASSERTIONS[attempt.check] ?? 1)) throw new Error(`A passing ${attempt.check} attempt has too few assertions.`);
  } else {
    if (!attempt.failure_reason) throw new Error('A non-passing attempt requires failure_reason.');
    const expected = attempt.result === 'failed' ? 'failed' : 'skipped';
    if (attempt.end_state !== expected) throw new Error(`A ${attempt.result} attempt must end in ${expected}.`);
  }
  if (attempt.check === 'rollback') {
    if (attempt.start_state !== 'installed_previous' || !attempt.previous_artifact_sha256) throw new Error('Rollback requires installed_previous and an explicit previous artifact digest.');
    if (attempt.previous_artifact_sha256 === attempt.artifact_sha256) throw new Error('Rollback baseline must differ from the candidate artifact.');
  } else if (attempt.previous_artifact_sha256) throw new Error('previous_artifact_sha256 is only valid for rollback.');
  const realChecks: readonly QualificationCheck[] = ['real_provider_end_to_end', 'pilot_task', 'hermes_end_to_end'];
  if (attempt.execution_kind === 'real_provider' && !realChecks.includes(attempt.check)) throw new Error('real_provider execution requires a real-provider or pilot check.');
  if (attempt.execution_kind === 'simulated' && realChecks.includes(attempt.check)) throw new Error('Simulated execution cannot satisfy real-provider cells.');
  if (attempt.execution_kind === 'real_provider') {
    if (attempt.recorder !== 'real_provider_runner_v1' || !attempt.execution_session_id || !attempt.custody_hmac_sha256) throw new Error('real_provider execution requires runner custody fields.');
  } else if (attempt.recorder || attempt.execution_session_id || attempt.custody_hmac_sha256) throw new Error('Runner custody fields are only valid for real_provider execution.');
  if (attempt.execution_kind === 'real_provider' && attempt.source_id === 'all') throw new Error('Real-provider attempts require one exact source.');
  if (attempt.host_surface === 'hermes' && attempt.host_os !== 'linux_x64_ubuntu_lts') throw new Error('The v0.4 Hermes qualification lane is Linux x86_64 Ubuntu LTS only.');
  if (attempt.check === 'hermes_end_to_end' && attempt.host_surface !== 'hermes') throw new Error('hermes_end_to_end requires the Hermes host surface.');
  if (attempt.check === 'pilot_task') {
    if (!attempt.pilot_attempt_id || !attempt.reuse_intent) throw new Error('pilot_task requires pilot_attempt_id and reuse_intent.');
  } else if (attempt.pilot_attempt_id || attempt.reuse_intent) throw new Error('Pilot fields are only valid for pilot_task.');
}

function asStrictRecord(value: unknown, fields: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Attempt must be a JSON object.');
  const record = value as Record<string, unknown>;
  const allowed = new Set(fields);
  const unknown = Object.keys(record).filter((key) => !allowed.has(key));
  if (unknown.length) throw new Error(`Unknown receipt fields: ${unknown.sort().join(', ')}.`);
  return record;
}
function exact<T extends string | number>(value: unknown, expected: T, name: string): T { if (value !== expected) throw new Error(`${name} must equal ${expected}.`); return expected; }
function member<const T extends readonly string[]>(value: unknown, values: T, name: string): T[number] { if (typeof value !== 'string' || !(values as readonly string[]).includes(value)) throw new Error(`${name} is unsupported.`); return value as T[number]; }
function sha256(value: unknown, name: string): string { if (typeof value !== 'string' || !/^[0-9a-f]{64}$/.test(value)) throw new Error(`${name} must be lowercase SHA-256.`); return value; }
function positiveInteger(value: unknown, name: string): number { if (!Number.isSafeInteger(value) || (value as number) <= 0) throw new Error(`${name} must be a positive integer.`); return value as number; }
function nonNegativeInteger(value: unknown, name: string): number { if (!Number.isSafeInteger(value) || (value as number) < 0) throw new Error(`${name} must be a non-negative integer.`); return value as number; }
function safeHex(value: unknown, name: string, length: number): string { if (typeof value !== 'string' || !new RegExp(`^[0-9a-f]{${length}}$`).test(value)) throw new Error(`${name} must be ${length} lowercase hex characters.`); return value; }
function canonicalTimestamp(value: unknown, name: string): string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) throw new Error(`${name} must be canonical UTC ISO-8601.`);
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) throw new Error(`${name} must be canonical UTC ISO-8601.`);
  return value;
}
