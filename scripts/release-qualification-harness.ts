import { createHmac, timingSafeEqual } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import {
  parseReleaseQualificationAttempt,
  releaseQualificationCustodyPayload,
  releaseQualificationCellKey,
  summarizeReleaseQualification,
  type ReleaseQualificationAttempt,
} from '../src/core/release-qualification.ts';

const command = process.argv[2];
const args = process.argv.slice(3);
if (!command || args.length === 0) usage();

if (command === 'validate') {
  for (const attempt of readAttempts(args)) console.log(JSON.stringify(attempt));
} else if (command === 'summarize') {
  console.log(JSON.stringify(summarizeReleaseQualification(readAttempts(args)), null, 2));
} else if (command === 'verify-simulated') {
  const plan = readPlan(args[0]!);
  const attempts = readAttempts(args.slice(1));
  const expected = new Set<string>();
  for (const matrix of plan.simulated_matrix) {
    for (const sourceId of matrix.source_ids) {
      for (const check of matrix.checks) expected.add(['simulated', matrix.host_os, matrix.host_surface, sourceId, check].join(':'));
    }
  }
  verifyPlanArtifacts(attempts, plan);
  verifyExactCells(attempts, expected, 'simulated');
  console.log(JSON.stringify({ ...summarizeReleaseQualification(attempts), matrix: 'simulated', complete: true }, null, 2));
} else if (command === 'verify-release-inputs') {
  const plan = readPlan(args[0]!);
  const inputs = readPreparedInputs(args.slice(1));
  const expected = new Set(plan.documentary_cells.map((cell) => [cell.source_id, cell.check].join(':')));
  const actual = inputs.map((input) => [input.source_id, input.check].join(':'));
  if (new Set(actual).size !== actual.length) throw new Error('Release-input manifest contains duplicate cells.');
  const missing = [...expected].filter((cell) => !actual.includes(cell));
  const extra = actual.filter((cell) => !expected.has(cell));
  if (missing.length || extra.length) throw new Error(`Release-input mismatch: missing=${missing.sort().join(',')} extra=${extra.sort().join(',')}`);
  for (const input of inputs) {
    const cell = plan.documentary_cells.find((candidate) => candidate.source_id === input.source_id && candidate.check === input.check)!;
    if (input.artifact_sha256 !== plan.candidate_artifact.artifact_sha256 || input.artifact_bytes !== plan.candidate_artifact.artifact_bytes) throw new Error('Release-input artifact does not match the exact plan input.');
    if (JSON.stringify([...input.required_assertions].sort()) !== JSON.stringify([...cell.assertions].sort())) throw new Error('Release-input assertions do not match the exact plan cell.');
  }
  console.log(JSON.stringify({ kind: 'olympus_release_input_readiness', schema_version: 1, artifact_sha256: plan.candidate_artifact.artifact_sha256, artifact_bytes: plan.candidate_artifact.artifact_bytes, prepared_inputs: inputs.length, qualification_complete: false, completion_owner: 'slice4_independent_review' }, null, 2));
} else if (command === 'verify-real-provider' || command === 'review-real-provider') {
  const plan = readPlan(args[0]!);
  const { receiptPaths, proofPaths } = splitCustodyPaths(args.slice(1));
  const attempts = readAttempts(receiptPaths);
  const expected = new Set(plan.real_provider_matrix.map((cell) => ['real_provider', cell.host_os, cell.host_surface, cell.source_id, 'real_provider_end_to_end'].join(':')));
  expected.add(['real_provider', plan.hermes_cell.host_os, plan.hermes_cell.host_surface, plan.hermes_cell.source_id, 'hermes_end_to_end'].join(':'));
  const independentReview = command === 'review-real-provider';
  verifyPlanArtifacts(attempts, plan);
  verifyRealProviderCustody(attempts, proofPaths);
  verifyExactCells(attempts, expected, 'real_provider', independentReview);
  console.log(JSON.stringify({
    ...summarizeReleaseQualification(attempts),
    matrix: independentReview ? 'real_provider_qualification' : 'real_provider_inputs',
    custody_consistent: true,
    qualification_complete: independentReview,
    completion_owner: 'slice4_independent_review',
  }, null, 2));
} else if (command === 'verify-pilot' || command === 'review-pilot') {
  const plan = readPlan(args[0]!);
  const { receiptPaths, proofPaths } = splitCustodyPaths(args.slice(1));
  const attempts = readAttempts(receiptPaths);
  if (attempts.length === 0 || attempts.some((attempt) => attempt.execution_kind !== 'real_provider' || attempt.check !== 'pilot_task' || attempt.host_surface !== 'openclaw')) throw new Error('Pilot matrix contains an unsupported cell.');
  verifyPlanArtifacts(attempts, plan);
  verifyRealProviderCustody(attempts, proofPaths);
  const keys = attempts.map(releaseQualificationCellKey);
  if (new Set(keys).size !== keys.length) throw new Error('Pilot matrix contains duplicate attempts.');
  if (attempts.some((attempt) => attempt.reuse_intent === 'not_recorded')) throw new Error('Pilot matrix has an unrecorded reuse intent.');
  const eligible = attempts.filter((attempt) => attempt.result === 'passed' && attempt.assistance !== 'engineering_intervention').length;
  const wantsReuse = attempts.filter((attempt) => attempt.reuse_intent === 'yes').length;
  const setupRate = eligible / attempts.length;
  const reuseRate = wantsReuse / attempts.length;
  if (setupRate < plan.pilot_thresholds.setup_success_without_engineering || reuseRate < plan.pilot_thresholds.participants_want_reuse) throw new Error('Pilot thresholds are not met.');
  const independentReview = command === 'review-pilot';
  console.log(JSON.stringify({
    ...summarizeReleaseQualification(attempts),
    matrix: independentReview ? 'pilot_qualification' : 'pilot_inputs',
    custody_consistent: true,
    qualification_complete: independentReview,
    completion_owner: 'slice4_independent_review',
    setup_success_rate: setupRate,
    wants_reuse_rate: reuseRate,
  }, null, 2));
} else {
  usage();
}

function readAttempts(paths: readonly string[]): ReleaseQualificationAttempt[] {
  if (paths.length === 0) throw new Error('At least one receipt path is required.');
  return paths.flatMap((path) => readFileSync(path, 'utf8').split('\n').filter(Boolean).map((line) => parseReleaseQualificationAttempt(JSON.parse(line))));
}

interface QualificationPlan {
  simulated_matrix: Array<{ host_os: string; host_surface: string; source_ids: string[]; checks: string[] }>;
  documentary_cells: Array<{ source_id: string; check: string; assertions: string[] }>;
  candidate_artifact: { artifact_sha256: string; artifact_bytes: number };
  rollback_baseline: { artifact_sha256: string; artifact_bytes: number };
  real_provider_matrix: Array<{ source_id: string; host_os: string; host_surface: string }>;
  hermes_cell: { source_id: string; host_os: string; host_surface: string };
  pilot_thresholds: { setup_success_without_engineering: number; participants_want_reuse: number };
}

interface PreparedReleaseInput {
  kind: 'olympus_release_input_manifest';
  schema_version: 1;
  status: 'prepared';
  source_id: string;
  check: string;
  artifact_sha256: string;
  artifact_bytes: number;
  required_assertions: string[];
  completion_owner: 'slice4_independent_review';
}

interface RealProviderSessionProof {
  kind: 'olympus_real_provider_session';
  schema_version: 1;
  recorder: 'real_provider_runner_v1';
  session_id: string;
  custody_nonce: string;
  source_id: string;
  host_os: string;
  host_surface: string;
  artifact_sha256: string;
  artifact_bytes: number;
  started_at: string;
}
function readPlan(path: string): QualificationPlan {
  if (!existsSync(path)) throw new Error('Qualification plan does not exist.');
  const plan = JSON.parse(readFileSync(path, 'utf8')) as QualificationPlan;
  if (!Array.isArray(plan.simulated_matrix) || !Array.isArray(plan.documentary_cells)) throw new Error('Qualification plan is incomplete.');
  return plan;
}

function verifyExactCells(attempts: readonly ReleaseQualificationAttempt[], expected: Set<string>, executionKind: ReleaseQualificationAttempt['execution_kind'], requirePassing = true): void {
  const actual = attempts.map(releaseQualificationCellKey);
  if (attempts.some((attempt) => attempt.execution_kind !== executionKind)) throw new Error(`Matrix contains a non-${executionKind} receipt.`);
  if (requirePassing && attempts.some((attempt) => attempt.result !== 'passed')) throw new Error('Matrix contains a non-passing receipt.');
  if (new Set(actual).size !== actual.length) throw new Error('Matrix contains duplicate cells.');
  const missing = [...expected].filter((cell) => !actual.includes(cell));
  const extra = actual.filter((cell) => !expected.has(cell));
  if (missing.length || extra.length) throw new Error(`Matrix mismatch: missing=${missing.sort().join(',')} extra=${extra.sort().join(',')}`);
}
function verifyPlanArtifacts(attempts: readonly ReleaseQualificationAttempt[], plan: QualificationPlan): void {
  if (attempts.some((attempt) => attempt.artifact_sha256 !== plan.candidate_artifact.artifact_sha256 || attempt.artifact_bytes !== plan.candidate_artifact.artifact_bytes)) throw new Error('Matrix candidate artifact does not match the exact plan input.');
  if (attempts.filter((attempt) => attempt.check === 'rollback').some((attempt) => attempt.previous_artifact_sha256 !== plan.rollback_baseline.artifact_sha256)) throw new Error('Matrix rollback baseline does not match the exact plan input.');
}

function splitCustodyPaths(paths: readonly string[]): { receiptPaths: string[]; proofPaths: string[] } {
  const marker = paths.indexOf('--session-proofs');
  if (marker <= 0 || marker === paths.length - 1) throw new Error('Real-provider verification requires receipt paths followed by --session-proofs and proof paths.');
  return { receiptPaths: paths.slice(0, marker), proofPaths: paths.slice(marker + 1) };
}

function verifyRealProviderCustody(attempts: readonly ReleaseQualificationAttempt[], proofPaths: readonly string[]): void {
  const proofs = proofPaths.map((path) => parseSessionProof(JSON.parse(readFileSync(path, 'utf8'))));
  const proofBySession = new Map(proofs.map((proof) => [proof.session_id, proof]));
  if (proofBySession.size !== proofs.length || proofs.length !== attempts.length) throw new Error('Real-provider custody requires one unique session proof per receipt.');
  for (const attempt of attempts) {
    const proof = attempt.execution_session_id ? proofBySession.get(attempt.execution_session_id) : undefined;
    if (!proof) throw new Error('Real-provider receipt has no matching session proof.');
    if (proof.recorder !== attempt.recorder || proof.source_id !== attempt.source_id || proof.host_os !== attempt.host_os || proof.host_surface !== attempt.host_surface || proof.artifact_sha256 !== attempt.artifact_sha256 || proof.artifact_bytes !== attempt.artifact_bytes || proof.started_at !== attempt.started_at) throw new Error('Real-provider receipt does not match its session proof.');
    const actual = Buffer.from(attempt.custody_hmac_sha256!, 'hex');
    const expected = createHmac('sha256', Buffer.from(proof.custody_nonce, 'hex')).update(releaseQualificationCustodyPayload(attempt)).digest();
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw new Error('Real-provider receipt custody HMAC is invalid.');
  }
}

function readPreparedInputs(paths: readonly string[]): PreparedReleaseInput[] {
  if (paths.length === 0) throw new Error('At least one release-input manifest path is required.');
  return paths.map((path) => parsePreparedInput(JSON.parse(readFileSync(path, 'utf8'))));
}

function parsePreparedInput(value: unknown): PreparedReleaseInput {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Release-input manifest is invalid.');
  const record = value as Record<string, unknown>;
  const fields = ['kind', 'schema_version', 'status', 'source_id', 'check', 'artifact_sha256', 'artifact_bytes', 'required_assertions', 'completion_owner'];
  if (Object.keys(record).some((key) => !fields.includes(key)) || fields.some((key) => !(key in record))) throw new Error('Release-input manifest is invalid.');
  if (record.kind !== 'olympus_release_input_manifest' || record.schema_version !== 1 || record.status !== 'prepared' || record.completion_owner !== 'slice4_independent_review') throw new Error('Release-input manifest is invalid.');
  if (typeof record.source_id !== 'string' || typeof record.check !== 'string' || typeof record.artifact_sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(record.artifact_sha256) || !Number.isSafeInteger(record.artifact_bytes) || (record.artifact_bytes as number) <= 0) throw new Error('Release-input manifest is invalid.');
  if (!Array.isArray(record.required_assertions) || record.required_assertions.length === 0 || record.required_assertions.some((assertion) => typeof assertion !== 'string' || !/^[a-z0-9_]+$/.test(assertion)) || new Set(record.required_assertions).size !== record.required_assertions.length) throw new Error('Release-input manifest is invalid.');
  return record as unknown as PreparedReleaseInput;
}

function parseSessionProof(value: unknown): RealProviderSessionProof {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Real-provider session proof is invalid.');
  const record = value as Record<string, unknown>;
  const fields = ['kind', 'schema_version', 'recorder', 'session_id', 'custody_nonce', 'source_id', 'host_os', 'host_surface', 'artifact_sha256', 'artifact_bytes', 'started_at'];
  if (Object.keys(record).some((key) => !fields.includes(key)) || fields.some((key) => !(key in record))) throw new Error('Real-provider session proof is invalid.');
  if (record.kind !== 'olympus_real_provider_session' || record.schema_version !== 1 || record.recorder !== 'real_provider_runner_v1' || typeof record.session_id !== 'string' || !/^[0-9a-f]{32}$/.test(record.session_id) || typeof record.custody_nonce !== 'string' || !/^[0-9a-f]{64}$/.test(record.custody_nonce)) throw new Error('Real-provider session proof is invalid.');
  if (typeof record.source_id !== 'string' || typeof record.host_os !== 'string' || typeof record.host_surface !== 'string' || typeof record.artifact_sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(record.artifact_sha256) || !Number.isSafeInteger(record.artifact_bytes) || (record.artifact_bytes as number) <= 0) throw new Error('Real-provider session proof is invalid.');
  if (typeof record.started_at !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(record.started_at) || new Date(record.started_at).toISOString() !== record.started_at) throw new Error('Real-provider session proof is invalid.');
  return record as unknown as RealProviderSessionProof;
}

function usage(): never {
  console.error('Usage: bun scripts/release-qualification-harness.ts validate|summarize <receipt.jsonl> [...]');
  console.error('       bun scripts/release-qualification-harness.ts verify-simulated|verify-release-inputs <plan.json> <receipt-or-manifest.json> [...]');
  console.error('       bun scripts/release-qualification-harness.ts verify-real-provider|verify-pilot <plan.json> <receipt.jsonl> [...] --session-proofs <session-proof.json> [...]');
  console.error('       bun scripts/release-qualification-harness.ts review-real-provider|review-pilot <plan.json> <receipt.jsonl> [...] --session-proofs <session-proof.json> [...]');
  process.exit(2);
}
