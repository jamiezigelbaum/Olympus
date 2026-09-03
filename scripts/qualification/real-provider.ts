import { createHmac, randomBytes } from 'node:crypto';
import { chmodSync, lstatSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseReleaseQualificationAttempt, releaseQualificationCustodyPayload } from '../../src/core/release-qualification.ts';
import { V0_4_PUBLIC_SOURCE_IDS } from '../../src/core/public-surface.ts';
import { verifyQualificationArtifact } from './artifact.ts';

const command = process.argv[2];
if (command === 'begin') begin();
else if (command === 'finish') finish();
else usage();

interface Session {
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

function begin(): never {
  const plan = JSON.parse(readFileSync(resolve(required('--plan')), 'utf8')) as {
    candidate_artifact: { artifact_sha256: string; artifact_bytes: number };
    real_provider_matrix: Array<{ source_id: string; host_os: string; host_surface: string }>;
    hermes_cell: { source_id: string; host_os: string; host_surface: string };
  };
  const artifact = verifyQualificationArtifact(required('--artifact'), plan.candidate_artifact);
  const state = resolve(required('--state'));
  const sourceId = required('--source-id');
  if (!(V0_4_PUBLIC_SOURCE_IDS as readonly string[]).includes(sourceId)) throw new Error('--source-id is unsupported.');
  const hostOs = required('--host-os');
  if (hostOs !== 'darwin_arm64' && hostOs !== 'linux_x64_ubuntu_lts') throw new Error('--host-os is unsupported.');
  const hostSurface = required('--host-surface');
  if (hostSurface !== 'openclaw' && hostSurface !== 'hermes') throw new Error('--host-surface is unsupported.');
  if (hostSurface === 'hermes' && hostOs !== 'linux_x64_ubuntu_lts') throw new Error('Hermes qualification is Linux x86_64 Ubuntu LTS only.');
  const declared = hostSurface === 'hermes'
    ? plan.hermes_cell.source_id === sourceId && plan.hermes_cell.host_os === hostOs && plan.hermes_cell.host_surface === hostSurface
    : plan.real_provider_matrix.some((cell) => cell.source_id === sourceId && cell.host_os === hostOs && cell.host_surface === hostSurface);
  if (!declared) throw new Error('Real-provider cell is not declared by the exact plan.');
  const session: Session = {
    kind: 'olympus_real_provider_session', schema_version: 1, recorder: 'real_provider_runner_v1',
    session_id: randomBytes(16).toString('hex'), custody_nonce: randomBytes(32).toString('hex'), source_id: sourceId, host_os: hostOs, host_surface: hostSurface,
    artifact_sha256: artifact.sha256, artifact_bytes: artifact.bytes, started_at: new Date().toISOString(),
  };
  writeFileSync(state, `${JSON.stringify(session)}\n`, { mode: 0o600, flag: 'wx' });
  chmodSync(state, 0o600);
  console.log(JSON.stringify({ kind: 'olympus_real_provider_session_started', schema_version: 1, session_id: session.session_id, source_id: sourceId, host_os: hostOs, host_surface: hostSurface, artifact_sha256: session.artifact_sha256, content_free: true }));
  process.exit(0);
}

function finish(): never {
  const state = regularFile('--state');
  const output = resolve(required('--output'));
  const sessionProof = resolve(required('--session-proof'));
  const session = parseSession(JSON.parse(readFileSync(state, 'utf8')));
  const check = required('--check');
  const totals: Record<string, number> = { real_provider_end_to_end: 10, pilot_task: 7, hermes_end_to_end: 8 };
  const assertionsTotal = totals[check];
  if (!assertionsTotal) throw new Error('--check is unsupported.');
  const assertionsPassed = Number(required('--assertions-passed'));
  const assistance = required('--assistance');
  const result = required('--result');
  const failureReason = optional('--failure-reason');
  const reuseIntent = optional('--reuse-intent');
  const provisional = parseReleaseQualificationAttempt({
    kind: 'olympus_release_qualification_attempt', schema_version: 1, source_id: session.source_id,
    host_os: session.host_os, host_surface: session.host_surface, execution_kind: 'real_provider', check,
    artifact_sha256: session.artifact_sha256, artifact_bytes: session.artifact_bytes,
    started_at: session.started_at, ended_at: new Date().toISOString(), start_state: 'configured',
    end_state: result === 'passed' ? 'answer_ready' : result === 'failed' ? 'failed' : 'skipped',
    assistance, result, ...(failureReason ? { failure_reason: failureReason } : {}),
    recorder: session.recorder, execution_session_id: session.session_id, custody_hmac_sha256: '0'.repeat(64),
    ...(check === 'pilot_task' ? { pilot_attempt_id: session.session_id, reuse_intent: reuseIntent } : {}),
    assertions_total: assertionsTotal, assertions_passed: assertionsPassed,
  });
  const receipt = parseReleaseQualificationAttempt({
    ...provisional,
    custody_hmac_sha256: createHmac('sha256', Buffer.from(session.custody_nonce, 'hex')).update(releaseQualificationCustodyPayload(provisional)).digest('hex'),
  });
  writeFileSync(sessionProof, `${JSON.stringify(session)}\n`, { mode: 0o600, flag: 'wx' });
  chmodSync(sessionProof, 0o600);
  writeFileSync(output, `${JSON.stringify(receipt)}\n`, { mode: 0o600, flag: 'wx' });
  chmodSync(output, 0o600);
  rmSync(state);
  console.log(JSON.stringify({ kind: 'olympus_real_provider_receipt_recorded', schema_version: 1, session_id: session.session_id, cell: [receipt.host_os, receipt.host_surface, receipt.source_id, receipt.check].join(':'), content_free: true }));
  process.exit(0);
}

function required(name: string): string { const value = optional(name); if (!value) throw new Error(`${name} is required.`); return value; }
function optional(name: string): string | undefined { const index = process.argv.indexOf(name); return index >= 0 ? process.argv[index + 1] : undefined; }
function regularFile(name: string): string { const path = resolve(required(name)); const stat = lstatSync(path); if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`${name} must be a regular file.`); return path; }
function parseSession(value: unknown): Session {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Real-provider session is invalid.');
  const record = value as Record<string, unknown>;
  const fields = ['kind', 'schema_version', 'recorder', 'session_id', 'custody_nonce', 'source_id', 'host_os', 'host_surface', 'artifact_sha256', 'artifact_bytes', 'started_at'];
  if (Object.keys(record).some((key) => !fields.includes(key)) || fields.some((key) => !(key in record))) throw new Error('Real-provider session is invalid.');
  if (record.kind !== 'olympus_real_provider_session' || record.schema_version !== 1 || record.recorder !== 'real_provider_runner_v1' || typeof record.session_id !== 'string' || !/^[0-9a-f]{32}$/.test(record.session_id) || typeof record.custody_nonce !== 'string' || !/^[0-9a-f]{64}$/.test(record.custody_nonce)) throw new Error('Real-provider session is invalid.');
  if (typeof record.source_id !== 'string' || !(V0_4_PUBLIC_SOURCE_IDS as readonly string[]).includes(record.source_id)) throw new Error('Real-provider session is invalid.');
  if (record.host_os !== 'darwin_arm64' && record.host_os !== 'linux_x64_ubuntu_lts') throw new Error('Real-provider session is invalid.');
  if (record.host_surface !== 'openclaw' && record.host_surface !== 'hermes') throw new Error('Real-provider session is invalid.');
  if (typeof record.artifact_sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(record.artifact_sha256) || !Number.isSafeInteger(record.artifact_bytes) || (record.artifact_bytes as number) <= 0) throw new Error('Real-provider session is invalid.');
  if (typeof record.started_at !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(record.started_at) || new Date(record.started_at).toISOString() !== record.started_at) throw new Error('Real-provider session is invalid.');
  return record as unknown as Session;
}
function usage(): never { console.error('Usage: bun scripts/qualification/real-provider.ts begin --plan <json> --artifact <tgz> --state <json> --source-id <id> --host-os <id> --host-surface openclaw|hermes'); console.error('       bun scripts/qualification/real-provider.ts finish --state <json> --session-proof <json> --output <jsonl> --check <id> --assistance documented_flow|documented_recovery|engineering_intervention --result passed|failed|skipped --assertions-passed <n> [--failure-reason <id>] [--reuse-intent yes|no|not_recorded]'); process.exit(2); }
