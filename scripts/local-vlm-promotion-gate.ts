import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export type VlmPromotionEvidenceKind =
  | 'shape_eval'
  | 'document_eval'
  | 'rendered_pdf_eval'
  | 'dropbox_extraction'
  | 'doctor_after_load'
  | 'real_source_eval';

export type VlmPromotionDecision = 'promote_document_vlm' | 'candidate_only' | 'hold';

export interface VlmPromotionConfig {
  candidates: VlmPromotionCandidateConfig[];
}

export interface VlmPromotionCandidateConfig {
  id: string;
  model?: string;
  reports: Partial<Record<VlmPromotionEvidenceKind, string>>;
}

export interface VlmPromotionReport {
  ok: boolean;
  generatedAt: string;
  candidates: VlmPromotionCandidateSummary[];
}

export interface VlmPromotionCandidateSummary {
  id: string;
  model?: string;
  decision: VlmPromotionDecision;
  ok: boolean;
  criteria: VlmPromotionCriterion[];
  metrics: {
    totalChecks: number;
    passedChecks: number;
    missingChecks: number;
    failedChecks: number;
    maxElapsedMs?: number;
    realSourcePassRate?: number;
    realSourcePrivacyPassRate?: number;
  };
}

export interface VlmPromotionCriterion {
  id: string;
  label: string;
  kind: VlmPromotionEvidenceKind;
  status: 'pass' | 'fail' | 'missing';
  required: true;
  summary: Record<string, string | number | boolean>;
}

type JsonRecord = Record<string, unknown>;

const APPROVED_VENICE_EGRESS_DESTINATIONS = new Set([
  'venice_private',
  'venice_tee',
  'venice_e2ee',
  'venice_mixed_approved',
]);

const CRITERIA: Array<{
  id: string;
  label: string;
  kind: VlmPromotionEvidenceKind;
}> = [
  {
    id: 'visual_baseline',
    label: 'Public-safe visual baseline passes at least 90 percent with at most one miss.',
    kind: 'shape_eval',
  },
  {
    id: 'document_images',
    label: 'Synthetic document-image extraction passes all cases.',
    kind: 'document_eval',
  },
  {
    id: 'rendered_pdf',
    label: 'Rendered PDF page extraction passes all cases.',
    kind: 'rendered_pdf_eval',
  },
  {
    id: 'dropbox_secure_local',
    label: 'Dropbox secure-local extraction worker indexes VLM evidence without source leakage.',
    kind: 'dropbox_extraction',
  },
  {
    id: 'post_load_health',
    label: 'Gateway-side appliance doctor stays green after VLM load.',
    kind: 'doctor_after_load',
  },
  {
    id: 'real_source_answer_eval',
    label: 'Held-out real source-answer eval passes with privacy, citation, and gap checks green.',
    kind: 'real_source_eval',
  },
];

export function runVlmPromotionGate(config: VlmPromotionConfig): VlmPromotionReport {
  if (!Array.isArray(config.candidates) || config.candidates.length === 0) {
    throw new Error('VLM promotion gate requires at least one candidate.');
  }
  const candidates = config.candidates.map(evaluateCandidate);
  return {
    ok: candidates.every((candidate) => candidate.decision === 'promote_document_vlm'),
    generatedAt: new Date().toISOString(),
    candidates,
  };
}

function evaluateCandidate(candidate: VlmPromotionCandidateConfig): VlmPromotionCandidateSummary {
  const id = candidate.id.trim();
  if (!id) throw new Error('VLM promotion candidate id must be non-empty.');
  const criteria = CRITERIA.map((criterion) => evaluateCriterion(criterion, candidate.reports[criterion.kind]));
  const failedChecks = criteria.filter((criterion) => criterion.status === 'fail').length;
  const missingChecks = criteria.filter((criterion) => criterion.status === 'missing').length;
  const passedChecks = criteria.filter((criterion) => criterion.status === 'pass').length;
  const maxElapsedMs = maxMetric(criteria, 'maxElapsedMs');
  const realSourcePassRate = metricForKind(criteria, 'real_source_eval', 'passRate');
  const realSourcePrivacyPassRate = metricForKind(criteria, 'real_source_eval', 'privacyPassRate');
  const decision: VlmPromotionDecision = failedChecks > 0
    ? 'hold'
    : missingChecks > 0
      ? 'candidate_only'
      : 'promote_document_vlm';
  return {
    id,
    ...(candidate.model?.trim() ? { model: candidate.model.trim() } : {}),
    decision,
    ok: decision === 'promote_document_vlm',
    criteria,
    metrics: {
      totalChecks: criteria.length,
      passedChecks,
      missingChecks,
      failedChecks,
      ...(maxElapsedMs !== undefined ? { maxElapsedMs } : {}),
      ...(realSourcePassRate !== undefined ? { realSourcePassRate } : {}),
      ...(realSourcePrivacyPassRate !== undefined ? { realSourcePrivacyPassRate } : {}),
    },
  };
}

function evaluateCriterion(
  criterion: (typeof CRITERIA)[number],
  reportPath: string | undefined,
): VlmPromotionCriterion {
  if (!reportPath?.trim()) {
    return {
      id: criterion.id,
      label: criterion.label,
      kind: criterion.kind,
      status: 'missing',
      required: true,
      summary: { reason: 'report_missing' },
    };
  }
  const report = readJsonRecord(reportPath);
  const evaluated = evaluateReport(criterion.kind, report);
  return {
    id: criterion.id,
    label: criterion.label,
    kind: criterion.kind,
    status: evaluated.ok ? 'pass' : 'fail',
    required: true,
    summary: evaluated.summary,
  };
}

function evaluateReport(
  kind: VlmPromotionEvidenceKind,
  report: JsonRecord,
): { ok: boolean; summary: Record<string, string | number | boolean> } {
  if (kind === 'shape_eval') {
    const total = numberField(report, 'total');
    const passed = numberField(report, 'passed');
    const failed = numberField(report, 'failed');
    const passRate = total > 0 ? passed / total : 0;
    return {
      ok: booleanField(report, 'ok') || (total > 0 && passRate >= 0.9 && failed <= 1),
      summary: {
        total,
        passed,
        failed,
        passRate: round(passRate),
        maxElapsedMs: maxElapsedFromResults(report),
      },
    };
  }
  if (kind === 'document_eval' || kind === 'rendered_pdf_eval') {
    const total = numberField(report, 'total');
    const passed = numberField(report, 'passed');
    const failed = numberField(report, 'failed');
    return {
      ok: booleanField(report, 'ok') && total > 0 && passed === total && failed === 0,
      summary: {
        total,
        passed,
        failed,
        maxElapsedMs: maxElapsedFromResults(report),
      },
    };
  }
  if (kind === 'dropbox_extraction') {
    const counts = recordField(report, 'counts');
    const policy = recordField(report, 'policy');
    const indexed = numberField(counts, 'indexed');
    const checks = arrayField(report, 'checks');
    const egressDestination = policy['egress_destination'];
    const localOrApprovedVenice = policy['local_only'] === true
      || (
        policy['local_only'] === false
        && typeof egressDestination === 'string'
        && APPROVED_VENICE_EGRESS_DESTINATIONS.has(egressDestination)
      );
    const safePolicy = policy['raw_source_exposed'] === false
      && policy['source_text_returned'] === false
      && policy['file_bytes_persisted'] === false
      && policy['temp_bytes_cleaned'] === true
      && localOrApprovedVenice
      && policy['trust_domain'] === 'secure_local';
    const allChecksHit = checks.length > 0
      && checks.every((check) => typeof check === 'object'
        && check !== null
        && numberField(check as JsonRecord, 'hits') > 0);
    return {
      ok: booleanField(report, 'ok') && indexed > 0 && allChecksHit && safePolicy,
      summary: {
        indexed,
        privateSearchChecks: checks.length,
        safePolicy,
        elapsedMs: numberField(report, 'elapsedMs'),
      },
    };
  }
  if (kind === 'real_source_eval') {
    const evalReport = realEvalPayload(report);
    const total = numberField(evalReport, 'total');
    const completed = numberField(evalReport, 'completed');
    const remaining = numberField(evalReport, 'remaining');
    const passed = numberField(evalReport, 'passed');
    const failed = numberField(evalReport, 'failed');
    const grades = arrayField(evalReport, 'grades').filter((grade): grade is JsonRecord =>
      Boolean(grade) && typeof grade === 'object' && !Array.isArray(grade));
    const answerCorrect = countBooleanGrades(grades, 'answerCorrect');
    const evidenceCited = countBooleanGrades(grades, 'evidenceCited');
    const gapHonest = countBooleanGrades(grades, 'gapHonest');
    const privacyRespected = grades.filter((grade) => grade['privacyRespected'] === true).length;
    const passRate = total > 0 ? passed / total : 0;
    const privacyPassRate = grades.length > 0 ? privacyRespected / grades.length : 0;
    return {
      ok: total > 0
        && completed === total
        && remaining === 0
        && passed === total
        && failed === 0
        && grades.length === total
        && answerCorrect === total
        && evidenceCited === total
        && gapHonest === total
        && privacyRespected === total,
      summary: {
        total,
        completed,
        remaining,
        passed,
        failed,
        passRate: round(passRate),
        answerCorrect,
        evidenceCited,
        gapHonest,
        privacyRespected,
        privacyPassRate: round(privacyPassRate),
        maxElapsedMs: maxElapsedFromTimings(evalReport),
      },
    };
  }
  const summary = recordField(report, 'summary');
  const failures = arrayField(summary, 'failures');
  const warnings = arrayField(summary, 'warnings');
  const failedChecks = arrayField(summary, 'failedChecks');
  const warningChecks = arrayField(summary, 'warningChecks');
  const textPool = findCheck(report, 'text_pool');
  const generationElapsedMs = numberField(recordField(textPool, 'generationElapsedMs'), 'p95');
  return {
    ok: booleanField(report, 'ok')
      && failures.length === 0
      && warnings.length === 0
      && failedChecks.length === 0
      && warningChecks.length === 0,
    summary: {
      required: numberField(summary, 'required'),
      optional: numberField(summary, 'optional'),
      failures: failures.length + failedChecks.length,
      warnings: warnings.length + warningChecks.length,
      elapsedMs: numberField(report, 'elapsedMs'),
      textGenerationP95Ms: generationElapsedMs,
    },
  };
}

function realEvalPayload(report: JsonRecord): JsonRecord {
  const nested = recordField(report, 'report');
  return Object.keys(nested).length > 0 ? nested : report;
}

function findCheck(report: JsonRecord, id: string): JsonRecord {
  for (const check of arrayField(report, 'checks')) {
    if (!check || typeof check !== 'object' || Array.isArray(check)) continue;
    const record = check as JsonRecord;
    if (record['id'] === id) return record;
  }
  return {};
}

function readJsonRecord(path: string): JsonRecord {
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`VLM promotion report is not a JSON object: ${path}`);
  }
  return parsed as JsonRecord;
}

function maxMetric(criteria: VlmPromotionCriterion[], key: string): number | undefined {
  const values = criteria
    .map((criterion) => criterion.summary[key])
    .filter((value): value is number => typeof value === 'number' && Number.isFinite(value));
  return values.length > 0 ? Math.max(...values) : undefined;
}

function metricForKind(criteria: VlmPromotionCriterion[], kind: VlmPromotionEvidenceKind, key: string): number | undefined {
  const criterion = criteria.find((item) => item.kind === kind);
  const value = criterion?.summary[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function maxElapsedFromResults(report: JsonRecord): number {
  const results = arrayField(report, 'results');
  if (results.length === 0) return 0;
  return Math.max(...results.map((result) => {
    if (!result || typeof result !== 'object' || Array.isArray(result)) return 0;
    return numberField(result as JsonRecord, 'elapsedMs');
  }));
}

function maxElapsedFromTimings(report: JsonRecord): number {
  const timings = arrayField(report, 'timings');
  if (timings.length === 0) return 0;
  return Math.max(...timings.map((timing) => {
    if (!timing || typeof timing !== 'object' || Array.isArray(timing)) return 0;
    return numberField(timing as JsonRecord, 'durationMs');
  }));
}

function countBooleanGrades(grades: JsonRecord[], key: string): number {
  return grades.filter((grade) => grade[key] === true).length;
}

function booleanField(record: JsonRecord, key: string): boolean {
  return record[key] === true;
}

function numberField(record: JsonRecord, key: string): number {
  const value = record[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function recordField(record: JsonRecord, key: string): JsonRecord {
  const value = record[key];
  return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : {};
}

function arrayField(record: JsonRecord, key: string): unknown[] {
  const value = record[key];
  return Array.isArray(value) ? value : [];
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function parseArgs(argv: string[]): { configPath: string; outputPath?: string } {
  const value = (name: string): string | undefined => {
    const index = argv.indexOf(name);
    return index >= 0 ? argv[index + 1] : undefined;
  };
  const configPath = value('--config') ?? process.env.OLYMPUS_VLM_PROMOTION_CONFIG;
  if (!configPath?.trim()) {
    throw new Error('Usage: bun scripts/local-vlm-promotion-gate.ts --config <promotion-config.json> [--output <report.json>]');
  }
  const outputPath = value('--output')?.trim() ?? process.env.OLYMPUS_VLM_PROMOTION_OUTPUT?.trim();
  return {
    configPath: configPath.trim(),
    ...(outputPath ? { outputPath } : {}),
  };
}

if (import.meta.main) {
  try {
    const args = parseArgs(process.argv.slice(2));
    const config = readJsonRecord(args.configPath) as unknown as VlmPromotionConfig;
    const report = runVlmPromotionGate(config);
    const serialized = `${JSON.stringify(report, null, 2)}\n`;
    if (args.outputPath) {
      mkdirSync(dirname(args.outputPath), { recursive: true });
      writeFileSync(args.outputPath, serialized);
    }
    console.log(serialized.trimEnd());
    if (!report.ok) process.exit(1);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
