// Real held-out eval runner (Lane C of the execution plan).
//
// Runs the held-out eval against the REAL local Dropbox connector store and the REAL
// local Analyst (the source_answer profile on Delphi), grading through the
// same release gate the live source_answer path uses. This is the
// definition-of-done measurement.
//
// The instantiated dataset holds private corpus values, so it lives OUTSIDE
// git in eval/private/ (gitignored). See eval/README.md "Running for real".
//
// Usage (on a machine with a hydrated connector store and a reachable Argus profile):
//   OLYMPUS_SOURCE_INDEX_DROPBOX_CONNECTOR_STORE_DB_PATH=~/.olympus/indexes/dropbox-files-connector-store.sqlite \
//   OLYMPUS_SOURCE_INDEX_ACCOUNT=personal \
//   bun run eval:real [path/to/held-out.real.json]
//
// Set OLYMPUS_EVAL_DROPBOX_APPROVED_SCOPE_KEY only when every instantiated
// expected evidence item is inside that approved Dropbox scope.
// Set OLYMPUS_EVAL_QUERY_PLANNER_ENABLED=true to include model-planned
// retrieval expansions; default is literal-query retrieval for a usable gate.

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createAnalyst, type AnalystModel } from '../src/core/analyst.ts';
import { createDelphiAnalystModel } from '../src/core/analyst-delphi.ts';
import {
  DEFAULT_VENICE_ANALYST_MODEL,
  createVeniceAnalystModel,
  type VeniceThinkingMode,
} from '../src/core/analyst-venice.ts';
import {
  loadConfig,
  parseLane,
  parseModelProfile,
  type OlympusConfig,
} from '../src/core/config.ts';
import { DelphiClient } from '../src/core/delphi.ts';
import {
  buildEvidencePackDetailed,
  type EvidencePackBuildDetail,
} from '../src/core/evidence-pack.ts';
import { createAnalystQueryPlanner } from '../src/core/query-planner.ts';
import {
  buildSourceIndexCorpusRegistry,
  defineSourceIndexCorpus,
} from '../src/core/source-index/corpus.ts';
import {
  LocalConnectorStore,
  createConnectorStoreContentProvider,
  createConnectorStoreCorpusAdapter,
} from '../src/workers/connector-store/index.ts';
import {
  DROPBOX_APPROVED_SCOPE_FILTER_CODEC,
  DROPBOX_FILES_CORPUS_ID,
} from '../src/workers/dropbox-files/index.ts';
import { releaseAnalystAnswer } from '../src/workers/source-index/analyst-answer.ts';
import type { EvalGrade } from './grade.ts';
import { runEval, type EvalQuestionTiming, type EvalReport } from './run.ts';
import { classifyPrecisionStage, summarizePrecisionTraces, type PrecisionTrace } from './diagnose.ts';
import { runBoundedEvalProcess } from './process-boundary.ts';
import type { EvalDataset, EvalQuestion } from './types.ts';

const DEFAULT_DATASET_PATH = 'eval/private/held-out.real.json';
const DEFAULT_REPORT_PATH = 'eval/private/report.latest.json';
const DEFAULT_QUESTION_TIMEOUT_MS = 240_000;
const DEFAULT_MAX_RESULTS = 5;
const DEFAULT_MAX_CHARS_PER_CANDIDATE = 1_500;
const INTERNAL_QUESTION_INDEX_ENV = 'OLYMPUS_EVAL_INTERNAL_QUESTION_INDEX';
type EvalAnalystProvider = 'local' | 'venice';

async function main(): Promise<void> {
  const args = parseEvalRealArgs(process.argv.slice(2), process.env);
  const datasetPath = args.datasetPath;
  if (!existsSync(datasetPath)) {
    console.error(
      [
        `No instantiated dataset at ${datasetPath}.`,
        'Copy eval/questions/held-out.json, replace each {placeholder} with real',
        'corpus values, fill expectedAnswerContains/expectedEvidence, and save it',
        'as eval/private/held-out.real.json (gitignored). See eval/README.md.',
      ].join('\n'),
    );
    process.exit(2);
  }
  const dbPath = process.env.OLYMPUS_SOURCE_INDEX_DROPBOX_CONNECTOR_STORE_DB_PATH?.trim();
  if (!dbPath) {
    console.error('Set OLYMPUS_SOURCE_INDEX_DROPBOX_CONNECTOR_STORE_DB_PATH to the local Dropbox connector store.');
    process.exit(2);
  }

  const fullDataset = JSON.parse(readFileSync(datasetPath, 'utf8')) as EvalDataset;
  const account = process.env.OLYMPUS_SOURCE_INDEX_ACCOUNT?.trim() || undefined;
  const approvedScopeKey = process.env.OLYMPUS_EVAL_DROPBOX_APPROVED_SCOPE_KEY?.trim() || undefined;
  const reportPath = process.env.OLYMPUS_EVAL_REPORT_PATH?.trim() || DEFAULT_REPORT_PATH;
  const analystProvider = args.analystProvider;
  const questionTimeoutMs = parseQuestionTimeoutMs(process.env.OLYMPUS_EVAL_QUESTION_TIMEOUT_SECONDS);
  const queryPlannerEnabled = parseBooleanEnv(process.env.OLYMPUS_EVAL_QUERY_PLANNER_ENABLED);
  const maxResults = parsePositiveIntegerEnv(process.env.OLYMPUS_EVAL_MAX_RESULTS, DEFAULT_MAX_RESULTS, 'OLYMPUS_EVAL_MAX_RESULTS');
  const maxCharsPerCandidate = parsePositiveIntegerEnv(
    process.env.OLYMPUS_EVAL_MAX_CHARS_PER_CANDIDATE,
    DEFAULT_MAX_CHARS_PER_CANDIDATE,
    'OLYMPUS_EVAL_MAX_CHARS_PER_CANDIDATE',
  );
  const internalQuestionIndex = parseInternalQuestionIndex(
    process.env[INTERNAL_QUESTION_INDEX_ENV],
    fullDataset.questions.length,
  );
  const reportConfig = {
    analystProvider,
    questionTimeoutMs,
    queryPlannerEnabled,
    maxResults,
    maxCharsPerCandidate,
  };
  if (internalQuestionIndex === undefined) {
    await runIsolatedEval({
      args,
      dataset: fullDataset,
      reportPath,
      config: reportConfig,
    });
    return;
  }
  const dataset: EvalDataset = {
    ...fullDataset,
    questions: [fullDataset.questions[internalQuestionIndex]!],
  };
  const config = loadConfig();

  const store = new LocalConnectorStore({
    dbPath,
    corpusId: DROPBOX_FILES_CORPUS_ID,
    family: 'file',
    trustDomain: 'secure_local',
    readOnly: true,
  });
  const scope = resolveEvalDropboxScope(account, approvedScopeKey);
  const registry = buildSourceIndexCorpusRegistry([
    defineSourceIndexCorpus({
      corpusId: DROPBOX_FILES_CORPUS_ID,
      family: 'file',
      trustDomain: 'secure_local',
    }),
  ]);
  const adapters = {
    [DROPBOX_FILES_CORPUS_ID]: createConnectorStoreCorpusAdapter({
      store,
      ...(scope.accountScope ? { accountScope: scope.accountScope } : {}),
      ...(scope.locatorPathScope
        ? { filters: { provider: 'dropbox', locatorPathScope: scope.locatorPathScope } }
        : {}),
    }),
  };
  const contentProviders = {
    [DROPBOX_FILES_CORPUS_ID]: createConnectorStoreContentProvider({ store }),
  };
  const model = createEvalAnalystModel({
    provider: analystProvider,
    config,
    env: process.env,
  });
  const analyst = createAnalyst(model, { auditSuspiciousDrafts: true });
  // Optional multi-query retrieval expansion over the same local Delphi lane:
  // useful for recall experiments, but disabled by default because it adds a
  // model call before every question and made the real eval too slow as a gate.
  const queryPlanner = queryPlannerEnabled ? createAnalystQueryPlanner(model) : undefined;

  const detailsByPack = new WeakMap<object, EvidencePackBuildDetail>();
  const traces: PrecisionTrace[] = [];
  const report = await runEval(dataset, {
    questionTimeoutMs,
    continueOnQuestionError: true,
    stopOnQuestionTimeout: true,
    async buildPack(question) {
      const detail = await buildEvidencePackDetailed({
        question: question.question,
        ...(queryPlanner ? { queryPlanner } : {}),
        maxResults,
        // Keep local-model prompts bounded for an eval gate. Truncation is
        // reported as a coverage gap; raise this only for targeted diagnosis.
        maxCharsPerCandidate,
        searchContext: {
          allowedTrustDomains: ['public_safe', 'internal', 'secure_local'],
        },
        registry,
        adapters,
        contentProviders,
      });
      detailsByPack.set(detail.pack, detail);
      return detail.pack;
    },
    analyst,
    releaseFor(pack, result) {
      const detail = detailsByPack.get(pack);
      if (!detail) return undefined;
      const release = releaseAnalystAnswer({
        detail,
        result,
        releaseSecureContent: true, // the eval asks explicitly, like an owner ask
      });
      const released = release.decision.decision === 'allow' || release.decision.decision === 'redact';
      return {
        result: {
          ...result,
          answer: release.answer,
          citations: released ? result.citations : [],
          unanswered: releasedVisibleUnanswered(release.answer, released),
        },
        audit: release.opsec,
      };
    },
    gradeContextFor(pack) {
      const detail = detailsByPack.get(pack);
      return detail ? { candidateCorpusIds: detail.candidateCorpusIds } : undefined;
    },
    trace(question, pack, result) {
      const detail = detailsByPack.get(pack);
      traces.push(classifyPrecisionStage(question, pack, result, {
        ...(detail ? { candidateCorpusIds: detail.candidateCorpusIds } : {}),
      }));
    },
    onProgress(event) {
      if (event.type === 'question_started') {
        console.error(
          `eval question ${event.index + 1}/${event.total} started: ${event.questionId} (${event.shape})`,
        );
      } else if (event.type === 'question_finished') {
        const seconds = Math.round((event.timing.durationMs ?? 0) / 100) / 10;
        const phase = event.timing.lastPhase ? ` last_phase=${event.timing.lastPhase}` : '';
        console.error(
          `eval question ${event.index + 1}/${event.total} ${event.timing.status}: ${event.questionId} (${seconds}s)${phase}`,
        );
      } else if (event.type === 'phase_started') {
        console.error(
          `eval question ${event.index + 1}/${event.total} phase started: ${event.questionId} ${event.phase}`,
        );
      } else {
        const seconds = Math.round(event.timing.durationMs / 100) / 10;
        console.error(
          `eval question ${event.index + 1}/${event.total} phase ${event.timing.status}: ${event.questionId} ${event.phase} (${seconds}s)`,
        );
      }
    },
    onPartialReport(partial) {
      writeEvalReport(reportPath, datasetPath, partial, traces, {
        analystProvider,
        questionTimeoutMs,
        queryPlannerEnabled,
        maxResults,
        maxCharsPerCandidate,
      }, { partial: true });
    },
  });
  store.close();
  writeEvalReport(reportPath, datasetPath, report, traces, {
    ...reportConfig,
  }, { partial: false });

  console.log(JSON.stringify(report, null, 2));
  console.error(`held-out eval: ${report.passed}/${report.total} passed`);

  // Precision diagnostics — where each miss happens, and which lever fixes it.
  const failingTraces = traces.filter((t) => t.stage !== 'ok' && t.stage !== 'no_expectations');
  console.error('\nprecision trace (where the needle was lost):');
  for (const t of traces) {
    console.error(`  ${t.questionId.padEnd(20)} ${t.stage.padEnd(16)} rank=${t.bestRank} cands=${t.candidateCount}  ${t.note}`);
  }
  const summary = summarizePrecisionTraces(traces);
  console.error(`\nlever attribution: ${summary.recommendation}`);
  void failingTraces;

  process.exit(report.failed === 0 ? 0 : 1);
}

export function resolveEvalDropboxScope(
  account: string | undefined,
  approvedScopeKey: string | undefined,
): { accountScope?: string; locatorPathScope?: string } {
  if (!approvedScopeKey) return account ? { accountScope: account } : {};
  if (!account) {
    throw new Error('OLYMPUS_SOURCE_INDEX_ACCOUNT is required when OLYMPUS_EVAL_DROPBOX_APPROVED_SCOPE_KEY is set.');
  }
  const resolution = DROPBOX_APPROVED_SCOPE_FILTER_CODEC.resolveLocatorPath(approvedScopeKey, {
    provider: 'dropbox',
    accountScope: account,
  });
  if (resolution.kind !== 'path') {
    throw new Error('OLYMPUS_EVAL_DROPBOX_APPROVED_SCOPE_KEY must be a Dropbox path scope for the configured account.');
  }
  return {
    accountScope: resolution.accountScope,
    locatorPathScope: resolution.locatorPath,
  };
}

interface IsolatedEvalInput {
  args: ReturnType<typeof parseEvalRealArgs>;
  dataset: EvalDataset;
  reportPath: string;
  config: {
    analystProvider: EvalAnalystProvider;
    questionTimeoutMs: number;
    queryPlannerEnabled: boolean;
    maxResults: number;
    maxCharsPerCandidate: number;
  };
}

interface RealEvalReportEnvelope {
  report: EvalReport;
  precision?: { traces?: PrecisionTrace[] };
}

async function runIsolatedEval(input: IsolatedEvalInput): Promise<void> {
  const grades: EvalGrade[] = [];
  const timings: EvalQuestionTiming[] = [];
  const traces: PrecisionTrace[] = [];
  const scriptPath = fileURLToPath(import.meta.url);
  let timedOut = false;

  for (const [index, question] of input.dataset.questions.entries()) {
    const childReportPath = `${input.reportPath}.question-${index + 1}-${process.pid}.json`;
    rmSync(childReportPath, { force: true });
    const timeoutMs = effectiveIsolatedQuestionTimeoutMs(input.config.questionTimeoutMs, question);
    console.error(
      `eval isolated question ${index + 1}/${input.dataset.questions.length} started: ${question.id} (${question.shape})`,
    );
    const result = await runBoundedEvalProcess({
      command: [
        process.execPath,
        scriptPath,
        input.args.datasetPath,
        '--analyst-provider',
        input.args.analystProvider,
      ],
      env: {
        ...process.env,
        [INTERNAL_QUESTION_INDEX_ENV]: String(index),
        OLYMPUS_EVAL_REPORT_PATH: childReportPath,
      },
      timeoutMs,
      stdout: 'ignore',
      stderr: 'inherit',
    });
    if (result.timedOut) {
      timedOut = true;
      grades.push(isolatedFailureGrade(question, 'timeout'));
      timings.push(isolatedFailureTiming(question, result.durationMs, 'timeout'));
      console.error(
        `eval isolated question ${index + 1}/${input.dataset.questions.length} timeout: ${question.id} (${result.durationMs}ms)`,
      );
    } else if (existsSync(childReportPath)) {
      const envelope = JSON.parse(readFileSync(childReportPath, 'utf8')) as RealEvalReportEnvelope;
      const grade = envelope.report.grades[0];
      const timing = envelope.report.timings[0];
      if (grade && timing) {
        grades.push(grade);
        timings.push(timing);
        traces.push(...(envelope.precision?.traces ?? []));
      } else {
        grades.push(isolatedFailureGrade(question, 'child_report_incomplete'));
        timings.push(isolatedFailureTiming(question, result.durationMs, 'error'));
      }
    } else {
      grades.push(isolatedFailureGrade(question, `child_exit_${result.exitCode}`));
      timings.push(isolatedFailureTiming(question, result.durationMs, 'error'));
    }
    rmSync(childReportPath, { force: true });
    const partial = evalReportFromParts(input.dataset.questions.length, grades, timings);
    writeEvalReport(
      input.reportPath,
      input.args.datasetPath,
      partial,
      traces,
      input.config,
      { partial: true },
    );
    if (timedOut) break;
  }

  const report = evalReportFromParts(input.dataset.questions.length, grades, timings);
  writeEvalReport(
    input.reportPath,
    input.args.datasetPath,
    report,
    traces,
    input.config,
    { partial: report.remaining > 0 },
  );
  console.log(JSON.stringify(report, null, 2));
  console.error(`held-out eval: ${report.passed}/${report.total} passed`);
  console.error('\nprecision trace (where the needle was lost):');
  for (const trace of traces) {
    console.error(
      `  ${trace.questionId.padEnd(20)} ${trace.stage.padEnd(16)} rank=${trace.bestRank} cands=${trace.candidateCount}  ${trace.note}`,
    );
  }
  console.error(`\nlever attribution: ${summarizePrecisionTraces(traces).recommendation}`);
  process.exit(report.failed === 0 ? 0 : 1);
}

export function effectiveIsolatedQuestionTimeoutMs(
  runnerTimeoutMs: number,
  question: Pick<EvalQuestion, 'maxDurationMs'>,
): number {
  const questionTimeoutMs = question.maxDurationMs;
  return questionTimeoutMs !== undefined && questionTimeoutMs > 0
    ? Math.min(runnerTimeoutMs, questionTimeoutMs)
    : runnerTimeoutMs;
}

function parseInternalQuestionIndex(value: string | undefined, total: number): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed >= total) {
    throw new Error('Internal eval question index is invalid.');
  }
  return parsed;
}

function isolatedFailureGrade(question: EvalQuestion, reason: string): EvalGrade {
  return {
    questionId: question.id,
    shape: question.shape,
    answerCorrect: false,
    evidenceCited: false,
    gapHonest: false,
    privacyRespected: question.maxTrustDomain === 'secure_local' ? false : 'pending',
    passed: false,
    detail: [`isolated_eval_error: ${reason}`],
  };
}

function isolatedFailureTiming(
  question: EvalQuestion,
  durationMs: number,
  status: 'error' | 'timeout',
): EvalQuestionTiming {
  const completedAt = new Date();
  return {
    questionId: question.id,
    shape: question.shape,
    startedAt: new Date(completedAt.getTime() - durationMs).toISOString(),
    completedAt: completedAt.toISOString(),
    durationMs,
    status,
  };
}

function evalReportFromParts(
  total: number,
  grades: readonly EvalGrade[],
  timings: readonly EvalQuestionTiming[],
): EvalReport {
  const passed = grades.filter((grade) => grade.passed).length;
  return {
    total,
    completed: grades.length,
    remaining: Math.max(0, total - grades.length),
    passed,
    failed: total - passed,
    grades,
    timings,
  };
}

function parseQuestionTimeoutMs(value: string | undefined): number {
  if (!value?.trim()) return DEFAULT_QUESTION_TIMEOUT_MS;
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds <= 0) {
    throw new Error('OLYMPUS_EVAL_QUESTION_TIMEOUT_SECONDS must be a positive number.');
  }
  return Math.round(seconds * 1000);
}

export function parseEvalRealArgs(
  argv: readonly string[],
  env: Record<string, string | undefined> = process.env,
): { datasetPath: string; analystProvider: EvalAnalystProvider } {
  let datasetPath: string | undefined;
  let analystProvider = resolveEvalAnalystProvider(env.OLYMPUS_EVAL_ANALYST_PROVIDER);
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    if (arg === '--analyst-provider') {
      const value = argv[index + 1];
      if (!value) throw new Error('--analyst-provider requires local or venice.');
      analystProvider = resolveEvalAnalystProvider(value);
      index += 1;
      continue;
    }
    if (arg.startsWith('--analyst-provider=')) {
      analystProvider = resolveEvalAnalystProvider(arg.slice('--analyst-provider='.length));
      continue;
    }
    if (arg.startsWith('--')) {
      throw new Error(`Unsupported eval:real option: ${arg}`);
    }
    if (datasetPath !== undefined) {
      throw new Error(`Unexpected extra eval dataset argument: ${arg}`);
    }
    datasetPath = arg;
  }
  return {
    datasetPath: datasetPath ?? DEFAULT_DATASET_PATH,
    analystProvider,
  };
}

export function resolveEvalAnalystProvider(value: string | undefined): EvalAnalystProvider {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) return 'local';
  if (normalized === 'local' || normalized === 'venice') return normalized;
  throw new Error('OLYMPUS_EVAL_ANALYST_PROVIDER/--analyst-provider must be local or venice.');
}

export function releasedVisibleUnanswered(answer: string, released: boolean): string[] {
  if (!released) return [];
  const marker = '\n\nCoverage notes:\n';
  const markerIndex = answer.indexOf(marker);
  if (markerIndex === -1) return [];
  const notes = answer.slice(markerIndex + marker.length).trim();
  return notes ? [notes] : [];
}

export function createEvalAnalystModel(input: {
  provider: EvalAnalystProvider;
  config: OlympusConfig;
  env?: Record<string, string | undefined>;
  lane?: ReturnType<typeof parseLane>;
  profile?: ReturnType<typeof parseModelProfile>;
}): AnalystModel {
  const env = input.env ?? process.env;
  if (input.provider === 'local') {
    const laneOverride = input.lane ?? (env.OLYMPUS_SOURCE_INDEX_ANALYST_LANE?.trim()
      ? parseLane(env.OLYMPUS_SOURCE_INDEX_ANALYST_LANE)
      : undefined);
    const profile = input.profile ?? (env.OLYMPUS_SOURCE_INDEX_ANALYST_PROFILE?.trim()
      ? parseModelProfile(env.OLYMPUS_SOURCE_INDEX_ANALYST_PROFILE)
      : 'source_answer');
    return createDelphiAnalystModel(
      new DelphiClient(input.config),
      laneOverride ? { lane: laneOverride } : { profile },
    );
  }
  return createVeniceAnalystModel({
    apiKey: requireVeniceApiKey(env),
    model: env.OLYMPUS_EVAL_VENICE_ANALYST_MODEL?.trim()
      || env.OLYMPUS_SOURCE_INDEX_VENICE_ANALYST_MODEL?.trim()
      || DEFAULT_VENICE_ANALYST_MODEL,
    baseUrl: env.OLYMPUS_EVAL_VENICE_ANALYST_BASE_URL?.trim()
      || env.OLYMPUS_SOURCE_INDEX_VENICE_ANALYST_BASE_URL?.trim()
      || 'https://api.venice.ai/api/v1',
    ...(env.OLYMPUS_EVAL_VENICE_ANALYST_REASONING_EFFORT?.trim()
      || env.OLYMPUS_SOURCE_INDEX_VENICE_ANALYST_REASONING_EFFORT?.trim()
      ? { reasoningEffort: parseVeniceReasoningEffort(
          env.OLYMPUS_EVAL_VENICE_ANALYST_REASONING_EFFORT
          ?? env.OLYMPUS_SOURCE_INDEX_VENICE_ANALYST_REASONING_EFFORT,
        ) }
      : {}),
    ...(env.OLYMPUS_EVAL_VENICE_ANALYST_THINKING?.trim()
      || env.OLYMPUS_SOURCE_INDEX_VENICE_ANALYST_THINKING?.trim()
      ? { thinking: parseVeniceThinkingMode(
          env.OLYMPUS_EVAL_VENICE_ANALYST_THINKING
          ?? env.OLYMPUS_SOURCE_INDEX_VENICE_ANALYST_THINKING,
        ) }
      : {}),
    ...(parseOptionalTimeoutMs(
      env.OLYMPUS_EVAL_VENICE_ANALYST_TIMEOUT_SECONDS
      ?? env.OLYMPUS_SOURCE_INDEX_VENICE_ANALYST_TIMEOUT_SECONDS,
      'OLYMPUS_EVAL_VENICE_ANALYST_TIMEOUT_SECONDS',
    ) !== undefined
      ? {
          timeoutMs: parseOptionalTimeoutMs(
            env.OLYMPUS_EVAL_VENICE_ANALYST_TIMEOUT_SECONDS
            ?? env.OLYMPUS_SOURCE_INDEX_VENICE_ANALYST_TIMEOUT_SECONDS,
            'OLYMPUS_EVAL_VENICE_ANALYST_TIMEOUT_SECONDS',
          )!,
        }
      : {}),
  });
}

function requireVeniceApiKey(env: Record<string, string | undefined>): string {
  const value = firstNonEmptyEnv(env, [
    'OLYMPUS_EVAL_VENICE_API_KEY',
    'OLYMPUS_SOURCE_INDEX_VENICE_API_KEY',
    'VENICE_API_KEY',
    'API_KEY_VENICE',
    'Venice-API-Key',
  ]);
  if (!value) {
    throw new Error('Set OLYMPUS_EVAL_VENICE_API_KEY, OLYMPUS_SOURCE_INDEX_VENICE_API_KEY, VENICE_API_KEY, API_KEY_VENICE, or Venice-API-Key for --analyst-provider venice.');
  }
  return value;
}

function firstNonEmptyEnv(env: Record<string, string | undefined>, names: readonly string[]): string | undefined {
  for (const name of names) {
    const value = env[name]?.trim();
    if (value) return value;
  }
  return undefined;
}

function parseVeniceReasoningEffort(value: string | undefined) {
  const normalized = value?.trim();
  if ([
    'none',
    'minimal',
    'low',
    'medium',
    'high',
    'xhigh',
    'max',
  ].includes(normalized ?? '')) {
    return normalized as 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  }
  throw new Error('Venice eval reasoning effort must be one of none, minimal, low, medium, high, xhigh, max.');
}

function parseVeniceThinkingMode(value: string | undefined): VeniceThinkingMode {
  const normalized = value?.trim().toLowerCase();
  if (normalized === 'enabled' || normalized === 'on' || normalized === 'true') return 'enabled';
  if (normalized === 'disabled' || normalized === 'off' || normalized === 'false') return 'disabled';
  throw new Error('Venice eval thinking mode must be enabled or disabled.');
}

function parseOptionalTimeoutMs(value: string | undefined, name: string): number | undefined {
  if (!value?.trim()) return undefined;
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds <= 0) {
    throw new Error(`${name} must be a positive number of seconds.`);
  }
  return Math.round(seconds * 1000);
}

function parseBooleanEnv(value: string | undefined): boolean {
  if (!value?.trim()) return false;
  const normalized = value.trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  throw new Error('OLYMPUS_EVAL_QUERY_PLANNER_ENABLED must be true or false.');
}

function parsePositiveIntegerEnv(value: string | undefined, fallback: number, name: string): number {
  if (!value?.trim()) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer.`);
  }
  return parsed;
}

function writeEvalReport(
  reportPath: string,
  datasetPath: string,
  report: Awaited<ReturnType<typeof runEval>>,
  traces: readonly PrecisionTrace[],
  config: {
    analystProvider: EvalAnalystProvider;
    questionTimeoutMs: number;
    queryPlannerEnabled: boolean;
    maxResults: number;
    maxCharsPerCandidate: number;
  },
  options: { partial: boolean },
): void {
  mkdirSync(dirname(reportPath), { recursive: true });
  writeFileSync(
    reportPath,
    `${JSON.stringify({
      kind: 'olympus_real_held_out_eval_report',
      partial: options.partial,
      datasetPath,
      analystProvider: config.analystProvider,
      questionTimeoutMs: config.questionTimeoutMs,
      queryPlannerEnabled: config.queryPlannerEnabled,
      maxResults: config.maxResults,
      maxCharsPerCandidate: config.maxCharsPerCandidate,
      report,
      precision: {
        traces,
        summary: summarizePrecisionTraces(traces),
      },
      writtenAt: new Date().toISOString(),
    }, null, 2)}\n`,
  );
}

if (import.meta.main) {
  await main();
}
