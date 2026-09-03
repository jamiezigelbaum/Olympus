import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, test } from 'bun:test';
import { V0_4_PUBLIC_PACKAGE_FILES, V0_4_PUBLIC_SOURCE_IDS } from '../src/core/public-surface.ts';

const ROOT = join(import.meta.dir, '..');
const plan = JSON.parse(readFileSync(join(ROOT, 'config/release-qualification-plan.json'), 'utf8')) as {
  simulated_matrix: Array<{ host_os: string; host_surface: string; source_ids: string[]; checks: string[] }>;
  real_provider_matrix: Array<{ source_id: string; script: string; host_os: string; host_surface: string }>;
  documentary_cells: Array<{ source_id: string; check: string; assertions: string[] }>;
  assistance: { eligible: string[]; ineligible: string[] };
  assertion_contracts: Record<string, string[]>;
  normal_install_rule: string;
  rollback_baseline: { source_commit: string; artifact_sha256: string; artifact_bytes: number };
  candidate_artifact: { artifact_sha256: string; artifact_bytes: number };
  pilot_thresholds: { setup_success_without_engineering: number; participants_want_reuse: number };
  hermes_cell: { source_id: string; host_os: string; host_surface: string };
};

describe('Slice 3F exact qualification plan', () => {
  test('pins the approved hosts, exact seven sources, executable owners, and normal-install rule', () => {
    expect(plan.simulated_matrix.map((entry) => entry.host_os)).toEqual(['darwin_arm64', 'linux_x64_ubuntu_lts']);
    for (const matrix of plan.simulated_matrix) {
      expect(matrix.host_surface).toBe('openclaw');
      expect(matrix.source_ids).toEqual([...V0_4_PUBLIC_SOURCE_IDS]);
      expect(matrix.checks).toEqual(['install', 'lifecycle', 'dashboard_states', 'dependencies', 'inventory', 'upgrade', 'rollback', 'uninstall']);
    }
    expect(plan.real_provider_matrix).toHaveLength(V0_4_PUBLIC_SOURCE_IDS.length * 2);
    for (const hostOs of ['darwin_arm64', 'linux_x64_ubuntu_lts']) {
      expect(plan.real_provider_matrix.filter((entry) => entry.host_os === hostOs).map((entry) => entry.source_id))
        .toEqual([...V0_4_PUBLIC_SOURCE_IDS]);
    }
    for (const entry of plan.real_provider_matrix) expect(existsSync(join(ROOT, entry.script))).toBe(true);
    expect(existsSync(join(ROOT, 'scripts/qualification/simulated-clean-home.ts'))).toBe(true);
    expect(existsSync(join(ROOT, 'scripts/qualification/release-input-evidence.ts'))).toBe(true);
    expect(plan.assistance).toEqual({ eligible: ['documented_flow', 'documented_recovery'], ineligible: ['engineering_intervention'] });
    expect(plan.normal_install_rule).toContain('user or their AI');
    expect(plan.normal_install_rule).toContain('without code, database, config-file, service-manager, or undocumented repair work');
    expect(plan.rollback_baseline).toEqual({ source_commit: '9d9fc02fa30e9dc6d1ceee6c3742da7b9b0c1ead', artifact_sha256: 'e70351832431110d7786ac77486bd1d4c3e06af1fae3b22770b18ef370b3aa81', artifact_bytes: 603128 });
    expect(plan.assertion_contracts.rollback).toEqual(['previous_digest_restored', 'service_state_restored', 'config_retained', 'credentials_retained', 'indexed_data_retained']);
    expect(plan.assertion_contracts.real_provider_end_to_end).toEqual(['install', 'dashboard_onboarding', 'scope', 'automatic_sync', 'extraction_accounting', 'retrieval', 'citations', 'honest_gaps', 'fail_closed_security', 'restart_resume']);
    expect(plan.assertion_contracts.pilot_task).toContain('normal_question_answer_checked');
    expect(plan.assertion_contracts.pilot_task).not.toContain('known_answer');
    expect(plan.assertion_contracts.hermes_end_to_end).toEqual(['runbook_install', 'mcp_test', 'two_tool_discovery', 'source_setup', 'sync', 'cited_answer', 'truthful_status', 'fail_closed_security']);
    expect(plan.pilot_thresholds).toEqual({ setup_success_without_engineering: 0.8, participants_want_reuse: 0.6 });
  });

  test('the matrix verifier requires every unique simulated cell', () => {
    const dir = mkdtempSync(join(tmpdir(), 'olympus-qualification-plan-test-'));
    const receiptPath = join(dir, 'receipts.jsonl');
    try {
      const now = '2026-08-30T18:00:00.000Z';
      const lines: string[] = [];
      for (const matrix of plan.simulated_matrix) {
        for (const sourceId of matrix.source_ids) {
          for (const check of matrix.checks) {
            const endState: Record<string, string> = { install: 'installed', lifecycle: 'lifecycle_ready', dashboard_states: 'dashboard_ready', dependencies: 'dependencies_ready', inventory: 'inventory_verified', upgrade: 'lifecycle_ready', rollback: 'rolled_back', uninstall: 'uninstalled' };
            lines.push(JSON.stringify({
              kind: 'olympus_release_qualification_attempt', schema_version: 1, source_id: sourceId,
              host_os: matrix.host_os, host_surface: 'openclaw', execution_kind: 'simulated', check,
              artifact_sha256: plan.candidate_artifact.artifact_sha256, artifact_bytes: plan.candidate_artifact.artifact_bytes,
              ...(check === 'rollback' ? { previous_artifact_sha256: plan.rollback_baseline.artifact_sha256 } : {}),
              started_at: now, ended_at: now, start_state: check === 'rollback' ? 'installed_previous' : 'clean_home',
              end_state: endState[check], assistance: 'documented_flow', result: 'passed', assertions_total: plan.assertion_contracts[check]!.length, assertions_passed: plan.assertion_contracts[check]!.length,
            }));
          }
        }
      }
      writeFileSync(receiptPath, `${lines.join('\n')}\n`);
      const good = Bun.spawnSync(['bun', 'scripts/release-qualification-harness.ts', 'verify-simulated', 'config/release-qualification-plan.json', receiptPath], { cwd: ROOT, stdout: 'pipe', stderr: 'pipe' });
      expect(good.exitCode).toBe(0);
      const wrongArtifact = `${lines[0]!.replace(plan.candidate_artifact.artifact_sha256, 'f'.repeat(64))}\n`;
      writeFileSync(receiptPath, wrongArtifact);
      const wrong = Bun.spawnSync(['bun', 'scripts/release-qualification-harness.ts', 'verify-simulated', 'config/release-qualification-plan.json', receiptPath], { cwd: ROOT, stdout: 'pipe', stderr: 'pipe' });
      expect(wrong.exitCode).not.toBe(0);
      expect(wrong.stderr.toString()).toContain('candidate artifact');
      writeFileSync(receiptPath, `${lines.slice(1).join('\n')}\n`);
      const missing = Bun.spawnSync(['bun', 'scripts/release-qualification-harness.ts', 'verify-simulated', 'config/release-qualification-plan.json', receiptPath], { cwd: ROOT, stdout: 'pipe', stderr: 'pipe' });
      expect(missing.exitCode).not.toBe(0);
      expect(missing.stderr.toString()).toContain('Matrix mismatch');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);

  test('the real-provider owner records a content-free session without editing JSON', () => {
    const dir = mkdtempSync(join(tmpdir(), 'olympus-real-provider-test-'));
    try {
      const fixture = createPublicFixture(dir);
      const cell = runRealCell(fixture, dir, 'single', { source_id: 'gmail.email', host_os: 'darwin_arm64', host_surface: 'openclaw', check: 'real_provider_end_to_end', assistance: 'documented_recovery', result: 'passed', assertions_passed: 10 });
      const receipt = JSON.parse(readFileSync(cell.receipt, 'utf8'));
      expect(receipt).toMatchObject({ source_id: 'gmail.email', assistance: 'documented_recovery', result: 'passed', assertions_total: 10, assertions_passed: 10 });
      expect(receipt).toMatchObject({ recorder: 'real_provider_runner_v1', execution_session_id: expect.any(String), custody_hmac_sha256: expect.any(String) });
      expect(receipt).not.toHaveProperty('question');
      expect(receipt).not.toHaveProperty('answer');
      const verified = Bun.spawnSync(['bun', 'scripts/release-qualification-harness.ts', 'verify-real-provider', fixture.plan, cell.receipt, '--session-proofs', cell.proof], { cwd: ROOT, stdout: 'pipe', stderr: 'pipe' });
      expect(verified.exitCode).not.toBe(0);
      expect(verified.stderr.toString()).toContain('Matrix mismatch');
      const evidenceOutput = join(dir, 'evidence.json');
      const evidence = Bun.spawnSync(['bun', 'scripts/qualification/release-input-evidence.ts', '--plan', fixture.plan, '--artifact', fixture.artifact, '--source-id', 'gmail.email', '--check', 'google_scale_readiness', '--output', evidenceOutput], { cwd: ROOT, stdout: 'pipe', stderr: 'pipe' });
      expect(evidence.exitCode).toBe(0);
      expect(JSON.parse(readFileSync(evidenceOutput, 'utf8'))).toMatchObject({ kind: 'olympus_release_input_manifest', status: 'prepared', completion_owner: 'slice4_independent_review' });
      expect(() => JSON.parse(readFileSync(evidenceOutput, 'utf8')) as { result: string }).not.toThrow();
      expect(JSON.parse(readFileSync(evidenceOutput, 'utf8'))).not.toHaveProperty('result');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);
  test('real-provider and pilot verifiers validate prepared matrices without promoting them', () => {
    const dir = mkdtempSync(join(tmpdir(), 'olympus-real-matrix-test-'));
    try {
      const fixture = createPublicFixture(dir);
      const realCells = [
        ...plan.real_provider_matrix.map((cell, index) => ({
          ...cell, check: 'real_provider_end_to_end',
          assistance: index === 0 ? 'engineering_intervention' : 'documented_flow',
          result: index === 0 ? 'failed' : 'passed', assertions_passed: index === 0 ? 0 : 10,
          ...(index === 0 ? { failure_reason: 'engineering_intervention' } : {}),
        })),
        { ...plan.hermes_cell, check: 'hermes_end_to_end', assistance: 'documented_flow', result: 'passed', assertions_passed: 8 },
      ];
      const real = realCells.map((cell, index) => runRealCell(fixture, dir, `real-${index}`, cell));
      const verified = Bun.spawnSync(['bun', 'scripts/release-qualification-harness.ts', 'verify-real-provider', fixture.plan, ...real.map((cell) => cell.receipt), '--session-proofs', ...real.map((cell) => cell.proof)], { cwd: ROOT, stdout: 'pipe', stderr: 'pipe' });
      expect(verified.exitCode).toBe(0);
      expect(JSON.parse(verified.stdout.toString())).toMatchObject({ matrix: 'real_provider_inputs', custody_consistent: true, passed: 14, failed: 1, eligible_passes: 14, real_provider_passes: 13, failure_reasons: { engineering_intervention: 1 }, qualification_complete: false, completion_owner: 'slice4_independent_review' });
      const incompleteReview = Bun.spawnSync(['bun', 'scripts/release-qualification-harness.ts', 'review-real-provider', fixture.plan, ...real.map((cell) => cell.receipt), '--session-proofs', ...real.map((cell) => cell.proof)], { cwd: ROOT, stdout: 'pipe', stderr: 'pipe' });
      expect(incompleteReview.exitCode).not.toBe(0);
      expect(incompleteReview.stderr.toString()).toContain('non-passing receipt');
      const tampered = JSON.parse(readFileSync(real[0]!.receipt, 'utf8')) as Record<string, unknown>;
      tampered.assistance = 'documented_recovery';
      writeFileSync(real[0]!.receipt, `${JSON.stringify(tampered)}\n`);
      const rejected = Bun.spawnSync(['bun', 'scripts/release-qualification-harness.ts', 'verify-real-provider', fixture.plan, ...real.map((cell) => cell.receipt), '--session-proofs', ...real.map((cell) => cell.proof)], { cwd: ROOT, stdout: 'pipe', stderr: 'pipe' });
      expect(rejected.exitCode).not.toBe(0);
      expect(rejected.stderr.toString()).toContain('custody HMAC');

      const qualifiedReal = [
        ...plan.real_provider_matrix.map((cell) => ({ ...cell, check: 'real_provider_end_to_end', assistance: 'documented_flow', result: 'passed', assertions_passed: 10 })),
        { ...plan.hermes_cell, check: 'hermes_end_to_end', assistance: 'documented_flow', result: 'passed', assertions_passed: 8 },
      ].map((cell, index) => runRealCell(fixture, dir, `qualified-real-${index}`, cell));
      const reviewedReal = Bun.spawnSync(['bun', 'scripts/release-qualification-harness.ts', 'review-real-provider', fixture.plan, ...qualifiedReal.map((cell) => cell.receipt), '--session-proofs', ...qualifiedReal.map((cell) => cell.proof)], { cwd: ROOT, stdout: 'pipe', stderr: 'pipe' });
      expect(reviewedReal.exitCode).toBe(0);
      expect(JSON.parse(reviewedReal.stdout.toString())).toMatchObject({ matrix: 'real_provider_qualification', attempts: 15, passed: 15, real_provider_passes: 14, qualification_complete: true });

      const pilot = Array.from({ length: 5 }, (_, index) => runRealCell(fixture, dir, `pilot-${index}`, {
        source_id: 'gmail.email', host_os: 'darwin_arm64', host_surface: 'openclaw', check: 'pilot_task',
        assistance: index < 4 ? 'documented_flow' : 'engineering_intervention', result: index < 4 ? 'passed' : 'failed', assertions_passed: index < 4 ? 7 : 0,
        ...(index < 4 ? {} : { failure_reason: 'engineering_intervention' }), reuse_intent: index < 3 ? 'yes' : 'no',
      }));
      const pilotVerified = Bun.spawnSync(['bun', 'scripts/release-qualification-harness.ts', 'verify-pilot', fixture.plan, ...pilot.map((cell) => cell.receipt), '--session-proofs', ...pilot.map((cell) => cell.proof)], { cwd: ROOT, stdout: 'pipe', stderr: 'pipe' });
      expect(pilotVerified.exitCode).toBe(0);
      expect(JSON.parse(pilotVerified.stdout.toString())).toMatchObject({ matrix: 'pilot_inputs', attempts: 5, eligible_passes: 4, pilot_wants_reuse: 3, qualification_complete: false, completion_owner: 'slice4_independent_review', setup_success_rate: 0.8, wants_reuse_rate: 0.6 });
      const pilotReviewed = Bun.spawnSync(['bun', 'scripts/release-qualification-harness.ts', 'review-pilot', fixture.plan, ...pilot.map((cell) => cell.receipt), '--session-proofs', ...pilot.map((cell) => cell.proof)], { cwd: ROOT, stdout: 'pipe', stderr: 'pipe' });
      expect(pilotReviewed.exitCode).toBe(0);
      expect(JSON.parse(pilotReviewed.stdout.toString())).toMatchObject({ matrix: 'pilot_qualification', attempts: 5, qualification_complete: true });

      const manifests = plan.documentary_cells.map((cell, index) => {
        const output = join(dir, `prepared-${index}.json`);
        const recorded = Bun.spawnSync(['bun', 'scripts/qualification/release-input-evidence.ts', '--plan', fixture.plan, '--artifact', fixture.artifact, '--source-id', cell.source_id, '--check', cell.check, '--output', output], { cwd: ROOT, stdout: 'pipe', stderr: 'pipe' });
        expect(recorded.exitCode).toBe(0);
        return output;
      });
      const prepared = Bun.spawnSync(['bun', 'scripts/release-qualification-harness.ts', 'verify-release-inputs', fixture.plan, ...manifests], { cwd: ROOT, stdout: 'pipe', stderr: 'pipe' });
      expect(prepared.exitCode).toBe(0);
      expect(JSON.parse(prepared.stdout.toString())).toMatchObject({ prepared_inputs: 3, qualification_complete: false, completion_owner: 'slice4_independent_review' });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);
});

interface PublicFixture {
  artifact: string;
  plan: string;
}

interface RealCellInput {
  source_id: string;
  host_os: string;
  host_surface: string;
  check: string;
  assistance: string;
  result: string;
  assertions_passed: number;
  failure_reason?: string;
  reuse_intent?: string;
}

function createPublicFixture(dir: string): PublicFixture {
  const packageRoot = join(dir, 'package');
  const artifact = join(dir, 'candidate.tgz');
  const localPlan = join(dir, 'plan.json');
  for (const path of V0_4_PUBLIC_PACKAGE_FILES) {
    const absolute = join(packageRoot, path);
    mkdirSync(dirname(absolute), { recursive: true });
    writeFileSync(absolute, path === 'package.json' ? JSON.stringify({ name: 'olympus', version: '0.4.0' }) : 'public fixture\n');
  }
  const packed = Bun.spawnSync(['tar', '-czf', artifact, '-C', dir, 'package'], { stdout: 'pipe', stderr: 'pipe' });
  if (packed.exitCode !== 0) throw new Error('Could not build public fixture artifact.');
  const artifactSha = createHash('sha256').update(readFileSync(artifact)).digest('hex');
  writeFileSync(localPlan, JSON.stringify({
    simulated_matrix: plan.simulated_matrix,
    documentary_cells: plan.documentary_cells,
    candidate_artifact: { artifact_sha256: artifactSha, artifact_bytes: statSync(artifact).size },
    rollback_baseline: plan.rollback_baseline,
    real_provider_matrix: plan.real_provider_matrix,
    hermes_cell: plan.hermes_cell,
    pilot_thresholds: plan.pilot_thresholds,
  }));
  return { artifact, plan: localPlan };
}

function runRealCell(fixture: PublicFixture, dir: string, name: string, cell: RealCellInput): { receipt: string; proof: string } {
  const state = join(dir, `${name}-state.json`);
  const proof = join(dir, `${name}-proof.json`);
  const receipt = join(dir, `${name}-receipt.jsonl`);
  const begin = Bun.spawnSync(['bun', 'scripts/qualification/real-provider.ts', 'begin', '--plan', fixture.plan, '--artifact', fixture.artifact, '--state', state, '--source-id', cell.source_id, '--host-os', cell.host_os, '--host-surface', cell.host_surface], { cwd: ROOT, stdout: 'pipe', stderr: 'pipe' });
  if (begin.exitCode !== 0) throw new Error(`Real-provider begin failed: ${begin.stderr.toString()}`);
  const finishArgs = ['bun', 'scripts/qualification/real-provider.ts', 'finish', '--state', state, '--session-proof', proof, '--output', receipt, '--check', cell.check, '--assistance', cell.assistance, '--result', cell.result, '--assertions-passed', String(cell.assertions_passed)];
  if (cell.failure_reason) finishArgs.push('--failure-reason', cell.failure_reason);
  if (cell.reuse_intent) finishArgs.push('--reuse-intent', cell.reuse_intent);
  const finish = Bun.spawnSync(finishArgs, { cwd: ROOT, stdout: 'pipe', stderr: 'pipe' });
  if (finish.exitCode !== 0) throw new Error(`Real-provider finish failed: ${finish.stderr.toString()}`);
  return { receipt, proof };
}
