import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'bun:test';
import { runVlmPromotionGate, type VlmPromotionConfig } from '../scripts/local-vlm-promotion-gate.ts';

describe('local VLM promotion gate', () => {
  test('promotes a document VLM only when every proof criterion passes', () => {
    const dir = mkdtempSync(join(tmpdir(), 'olympus-vlm-promotion-'));
    const config: VlmPromotionConfig = {
      candidates: [{
        id: 'qwen35',
        model: 'mlx-community/Qwen3.6-35B-A3B-4bit',
        reports: {
          shape_eval: writeReport(dir, 'shape.json', evalReport({ total: 10, passed: 9, failed: 1 })),
          document_eval: writeReport(dir, 'document.json', evalReport({ total: 3, passed: 3, failed: 0 })),
          rendered_pdf_eval: writeReport(dir, 'pdf.json', evalReport({ total: 2, passed: 2, failed: 0 })),
          dropbox_extraction: writeReport(dir, 'dropbox.json', dropboxProofReport()),
          doctor_after_load: writeReport(dir, 'doctor.json', doctorReport({ ok: true })),
          real_source_eval: writeReport(dir, 'real-source.json', realSourceEvalReport({ total: 7, passed: 7 })),
        },
      }],
    };

    const result = runVlmPromotionGate(config);

    expect(result.ok).toBe(true);
    expect(result.candidates[0]).toMatchObject({
      id: 'qwen35',
      decision: 'promote_document_vlm',
      ok: true,
      metrics: {
        totalChecks: 6,
        passedChecks: 6,
        missingChecks: 0,
        failedChecks: 0,
        realSourcePassRate: 1,
        realSourcePrivacyPassRate: 1,
      },
    });
  });

  test('writes explicit env output paths and creates durable parent directories', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'olympus-vlm-promotion-output-'));
    const configPath = join(dir, 'config.json');
    const outputPath = join(dir, 'durable/state/olympus/vlm-promotion/report.json');
    const config: VlmPromotionConfig = {
      candidates: [{
        id: 'qwen35',
        reports: {
          shape_eval: writeReport(dir, 'shape.json', evalReport({ total: 10, passed: 10, failed: 0 })),
          document_eval: writeReport(dir, 'document.json', evalReport({ total: 3, passed: 3, failed: 0 })),
          rendered_pdf_eval: writeReport(dir, 'pdf.json', evalReport({ total: 2, passed: 2, failed: 0 })),
          dropbox_extraction: writeReport(dir, 'dropbox.json', dropboxProofReport()),
          doctor_after_load: writeReport(dir, 'latency.json', latencyReport()),
          real_source_eval: writeReport(dir, 'real-source.json', realSourceEvalReport({ total: 7, passed: 7 })),
        },
      }],
    };
    writeFileSync(configPath, `${JSON.stringify(config)}\n`);

    const proc = Bun.spawn([process.execPath, 'scripts/local-vlm-promotion-gate.ts', '--config', configPath], {
      env: { ...process.env, OLYMPUS_VLM_PROMOTION_OUTPUT: outputPath },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const [exitCode, stderr] = await Promise.all([
      proc.exited,
      new Response(proc.stderr).text(),
    ]);

    expect(exitCode).toBe(0);
    expect(stderr).toBe('');
    expect(existsSync(outputPath)).toBe(true);
    expect(JSON.parse(readFileSync(outputPath, 'utf8'))).toMatchObject({
      ok: true,
      candidates: [expect.objectContaining({ id: 'qwen35', decision: 'promote_document_vlm' })],
    });
  }, 30_000);

  test('keeps an otherwise green model candidate-only when a required report is missing', () => {
    const dir = mkdtempSync(join(tmpdir(), 'olympus-vlm-promotion-'));
    const config: VlmPromotionConfig = {
      candidates: [{
        id: 'qwen27',
        reports: {
          shape_eval: writeReport(dir, 'shape.json', evalReport({ total: 10, passed: 10, failed: 0 })),
          document_eval: writeReport(dir, 'document.json', evalReport({ total: 3, passed: 3, failed: 0 })),
          rendered_pdf_eval: writeReport(dir, 'pdf.json', evalReport({ total: 2, passed: 2, failed: 0 })),
          dropbox_extraction: writeReport(dir, 'dropbox.json', dropboxProofReport()),
          real_source_eval: writeReport(dir, 'real-source.json', realSourceEvalReport({ total: 7, passed: 7 })),
        },
      }],
    };

    const result = runVlmPromotionGate(config);

    expect(result.ok).toBe(false);
    expect(result.candidates[0]?.decision).toBe('candidate_only');
    expect(result.candidates[0]?.criteria.find((criterion) => criterion.kind === 'doctor_after_load')).toMatchObject({
      status: 'missing',
      summary: { reason: 'report_missing' },
    });
  });

  test('holds a model when secure-local extraction proof violates the membrane', () => {
    const dir = mkdtempSync(join(tmpdir(), 'olympus-vlm-promotion-'));
    const unsafeDropbox = dropboxProofReport();
    unsafeDropbox.policy.raw_source_exposed = true;
    const config: VlmPromotionConfig = {
      candidates: [{
        id: 'unsafe-model',
        reports: {
          shape_eval: writeReport(dir, 'shape.json', evalReport({ total: 10, passed: 10, failed: 0 })),
          document_eval: writeReport(dir, 'document.json', evalReport({ total: 3, passed: 3, failed: 0 })),
          rendered_pdf_eval: writeReport(dir, 'pdf.json', evalReport({ total: 2, passed: 2, failed: 0 })),
          dropbox_extraction: writeReport(dir, 'dropbox.json', unsafeDropbox),
          doctor_after_load: writeReport(dir, 'doctor.json', doctorReport({ ok: true })),
          real_source_eval: writeReport(dir, 'real-source.json', realSourceEvalReport({ total: 7, passed: 7 })),
        },
      }],
    };

    const result = runVlmPromotionGate(config);

    expect(result.ok).toBe(false);
    expect(result.candidates[0]?.decision).toBe('hold');
    expect(result.candidates[0]?.criteria.find((criterion) => criterion.kind === 'dropbox_extraction')).toMatchObject({
      status: 'fail',
      summary: { safePolicy: false },
    });
  });

  test('accepts Dropbox extraction proof through an approved Venice Private recipe boundary', () => {
    const dir = mkdtempSync(join(tmpdir(), 'olympus-vlm-promotion-'));
    const veniceDropbox = dropboxProofReport();
    veniceDropbox.policy.local_only = false;
    veniceDropbox.policy.egress_destination = 'venice_private';
    const config: VlmPromotionConfig = {
      candidates: [{
        id: 'venice-assisted-model',
        reports: {
          shape_eval: writeReport(dir, 'shape.json', evalReport({ total: 10, passed: 10, failed: 0 })),
          document_eval: writeReport(dir, 'document.json', evalReport({ total: 3, passed: 3, failed: 0 })),
          rendered_pdf_eval: writeReport(dir, 'pdf.json', evalReport({ total: 2, passed: 2, failed: 0 })),
          dropbox_extraction: writeReport(dir, 'dropbox.json', veniceDropbox),
          doctor_after_load: writeReport(dir, 'doctor.json', doctorReport({ ok: true })),
          real_source_eval: writeReport(dir, 'real-source.json', realSourceEvalReport({ total: 7, passed: 7 })),
        },
      }],
    };

    const result = runVlmPromotionGate(config);

    expect(result.ok).toBe(true);
    expect(result.candidates[0]?.criteria.find((criterion) => criterion.kind === 'dropbox_extraction')).toMatchObject({
      status: 'pass',
      summary: { safePolicy: true },
    });
  });

  test('holds a Dropbox extraction proof routed to an anonymized Venice model', () => {
    const dir = mkdtempSync(join(tmpdir(), 'olympus-vlm-promotion-'));
    const anonymizedDropbox = dropboxProofReport();
    anonymizedDropbox.policy.local_only = false;
    anonymizedDropbox.policy.egress_destination = 'venice_anonymized';
    const config: VlmPromotionConfig = {
      candidates: [{
        id: 'anonymized-model',
        reports: {
          shape_eval: writeReport(dir, 'shape.json', evalReport({ total: 10, passed: 10, failed: 0 })),
          document_eval: writeReport(dir, 'document.json', evalReport({ total: 3, passed: 3, failed: 0 })),
          rendered_pdf_eval: writeReport(dir, 'pdf.json', evalReport({ total: 2, passed: 2, failed: 0 })),
          dropbox_extraction: writeReport(dir, 'dropbox.json', anonymizedDropbox),
          doctor_after_load: writeReport(dir, 'doctor.json', doctorReport({ ok: true })),
          real_source_eval: writeReport(dir, 'real-source.json', realSourceEvalReport({ total: 7, passed: 7 })),
        },
      }],
    };

    const result = runVlmPromotionGate(config);

    expect(result.ok).toBe(false);
    expect(result.candidates[0]?.decision).toBe('hold');
    expect(result.candidates[0]?.criteria.find((criterion) => criterion.kind === 'dropbox_extraction')).toMatchObject({
      status: 'fail',
      summary: { safePolicy: false },
    });
  });

  test('holds a model when post-load doctor has warnings even without hard failures', () => {
    const dir = mkdtempSync(join(tmpdir(), 'olympus-vlm-promotion-'));
    const config: VlmPromotionConfig = {
      candidates: [{
        id: 'slow-model',
        reports: {
          shape_eval: writeReport(dir, 'shape.json', evalReport({ total: 10, passed: 10, failed: 0 })),
          document_eval: writeReport(dir, 'document.json', evalReport({ total: 3, passed: 3, failed: 0 })),
          rendered_pdf_eval: writeReport(dir, 'pdf.json', evalReport({ total: 2, passed: 2, failed: 0 })),
          dropbox_extraction: writeReport(dir, 'dropbox.json', dropboxProofReport()),
          doctor_after_load: writeReport(dir, 'doctor.json', doctorReport({
            ok: true,
            warnings: ['text_pool:generation_slow:16000ms>15000ms'],
          })),
          real_source_eval: writeReport(dir, 'real-source.json', realSourceEvalReport({ total: 7, passed: 7 })),
        },
      }],
    };

    const result = runVlmPromotionGate(config);

    expect(result.ok).toBe(false);
    expect(result.candidates[0]?.decision).toBe('hold');
    expect(result.candidates[0]?.criteria.find((criterion) => criterion.kind === 'doctor_after_load')).toMatchObject({
      status: 'fail',
      summary: { failures: 0, warnings: 1 },
    });
  });

  test('accepts a clean repeated-latency report as stronger post-load health evidence', () => {
    const dir = mkdtempSync(join(tmpdir(), 'olympus-vlm-promotion-'));
    const config: VlmPromotionConfig = {
      candidates: [{
        id: 'qwen35',
        reports: {
          shape_eval: writeReport(dir, 'shape.json', evalReport({ total: 10, passed: 10, failed: 0 })),
          document_eval: writeReport(dir, 'document.json', evalReport({ total: 3, passed: 3, failed: 0 })),
          rendered_pdf_eval: writeReport(dir, 'pdf.json', evalReport({ total: 2, passed: 2, failed: 0 })),
          dropbox_extraction: writeReport(dir, 'dropbox.json', dropboxProofReport()),
          doctor_after_load: writeReport(dir, 'latency.json', latencyReport()),
          real_source_eval: writeReport(dir, 'real-source.json', realSourceEvalReport({ total: 7, passed: 7 })),
        },
      }],
    };

    const result = runVlmPromotionGate(config);

    expect(result.ok).toBe(true);
    expect(result.candidates[0]?.decision).toBe('promote_document_vlm');
    expect(result.candidates[0]?.criteria.find((criterion) => criterion.kind === 'doctor_after_load')).toMatchObject({
      status: 'pass',
      summary: {
        failures: 0,
        warnings: 0,
        textGenerationP95Ms: 3110,
      },
    });
  });

  test('keeps a model candidate-only until held-out real-source eval evidence exists', () => {
    const dir = mkdtempSync(join(tmpdir(), 'olympus-vlm-promotion-'));
    const config: VlmPromotionConfig = {
      candidates: [{
        id: 'qwen35',
        reports: {
          shape_eval: writeReport(dir, 'shape.json', evalReport({ total: 10, passed: 10, failed: 0 })),
          document_eval: writeReport(dir, 'document.json', evalReport({ total: 3, passed: 3, failed: 0 })),
          rendered_pdf_eval: writeReport(dir, 'pdf.json', evalReport({ total: 2, passed: 2, failed: 0 })),
          dropbox_extraction: writeReport(dir, 'dropbox.json', dropboxProofReport()),
          doctor_after_load: writeReport(dir, 'latency.json', latencyReport()),
        },
      }],
    };

    const result = runVlmPromotionGate(config);

    expect(result.ok).toBe(false);
    expect(result.candidates[0]?.decision).toBe('candidate_only');
    expect(result.candidates[0]?.criteria.find((criterion) => criterion.kind === 'real_source_eval')).toMatchObject({
      status: 'missing',
      summary: { reason: 'report_missing' },
    });
  });

  test('holds a model when held-out real-source eval has incomplete privacy evidence', () => {
    const dir = mkdtempSync(join(tmpdir(), 'olympus-vlm-promotion-'));
    const config: VlmPromotionConfig = {
      candidates: [{
        id: 'privacy-weak',
        reports: {
          shape_eval: writeReport(dir, 'shape.json', evalReport({ total: 10, passed: 10, failed: 0 })),
          document_eval: writeReport(dir, 'document.json', evalReport({ total: 3, passed: 3, failed: 0 })),
          rendered_pdf_eval: writeReport(dir, 'pdf.json', evalReport({ total: 2, passed: 2, failed: 0 })),
          dropbox_extraction: writeReport(dir, 'dropbox.json', dropboxProofReport()),
          doctor_after_load: writeReport(dir, 'latency.json', latencyReport()),
          real_source_eval: writeReport(dir, 'real-source.json', realSourceEvalReport({
            total: 7,
            passed: 7,
            privacyRespected: false,
          })),
        },
      }],
    };

    const result = runVlmPromotionGate(config);

    expect(result.ok).toBe(false);
    expect(result.candidates[0]?.decision).toBe('hold');
    expect(result.candidates[0]?.criteria.find((criterion) => criterion.kind === 'real_source_eval')).toMatchObject({
      status: 'fail',
      summary: {
        total: 7,
        passed: 7,
        privacyRespected: 0,
        privacyPassRate: 0,
      },
    });
  });
});

function writeReport(dir: string, name: string, report: unknown): string {
  const path = join(dir, name);
  writeFileSync(path, `${JSON.stringify(report)}\n`);
  return path;
}

function evalReport(input: { total: number; passed: number; failed: number }): Record<string, unknown> {
  return {
    ok: input.failed === 0,
    total: input.total,
    passed: input.passed,
    failed: input.failed,
    results: Array.from({ length: input.total }, (_, index) => ({
      id: `case-${index}`,
      ok: index < input.passed,
      elapsedMs: 1000 + index,
    })),
  };
}

function dropboxProofReport(): {
  ok: boolean;
  counts: { indexed: number };
  checks: Array<{ hits: number }>;
  elapsedMs: number;
  policy: {
    raw_source_exposed: boolean;
    source_text_returned: boolean;
    file_bytes_persisted: boolean;
    temp_bytes_cleaned: boolean;
    local_only: boolean;
    egress_destination?: string;
    trust_domain: string;
  };
} {
  return {
    ok: true,
    counts: { indexed: 1 },
    checks: [{ hits: 1 }, { hits: 1 }],
    elapsedMs: 12000,
    policy: {
      raw_source_exposed: false,
      source_text_returned: false,
      file_bytes_persisted: false,
      temp_bytes_cleaned: true,
      local_only: true,
      trust_domain: 'secure_local',
    },
  };
}

function doctorReport(input: { ok: boolean; warnings?: string[] }): Record<string, unknown> {
  return {
    ok: input.ok,
    elapsedMs: 7000,
    summary: {
      required: 3,
      optional: 1,
      failures: input.ok ? [] : ['text_pool'],
      warnings: input.warnings ?? [],
    },
  };
}

function latencyReport(): Record<string, unknown> {
  return {
    ok: true,
    runs: 3,
    intervalMs: 0,
    runGeneration: true,
    summary: {
      failedChecks: [],
      warningChecks: [],
    },
    checks: [{
      id: 'text_pool',
      required: true,
      runs: 3,
      okRuns: 3,
      failedRuns: 0,
      warningRuns: 0,
      modelsElapsedMs: { min: 90, p50: 95, p95: 102, max: 102, avg: 96 },
      generationElapsedMs: { min: 1100, p50: 1566, p95: 3110, max: 3110, avg: 1925 },
      warnings: [],
      errors: [],
    }],
  };
}

function realSourceEvalReport(input: {
  total: number;
  passed: number;
  privacyRespected?: boolean;
}): Record<string, unknown> {
  const grades = Array.from({ length: input.total }, (_, index) => {
    const passed = index < input.passed;
    return {
      questionId: `held-out-${index}`,
      shape: 'value_lookup',
      answerCorrect: passed,
      evidenceCited: passed,
      gapHonest: true,
      privacyRespected: input.privacyRespected ?? passed,
      passed,
      detail: [],
    };
  });
  return {
    kind: 'olympus_real_held_out_eval_report',
    partial: false,
    report: {
      total: input.total,
      completed: input.total,
      remaining: 0,
      passed: input.passed,
      failed: input.total - input.passed,
      grades,
      timings: grades.map((grade, index) => ({
        questionId: grade.questionId,
        shape: grade.shape,
        startedAt: '2026-06-15T00:00:00.000Z',
        completedAt: '2026-06-15T00:00:01.000Z',
        durationMs: 1000 + index,
        status: grade.passed ? 'passed' : 'failed',
      })),
    },
  };
}
