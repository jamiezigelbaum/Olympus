// Developer harness for stages M1 and C2 of the consult design: send N real
// zkAPI consults, one at a time, through the session transport (open, send,
// finished) and print the per-stage timings, the time until the reply was in
// the caller's hands and the time until the session finished, so the owner can
// measure the route live.
//
//   bun scripts/zkapi-consult-timing.ts [--n 10] [--question-set <path>]
//     [--model <id>] [--state <path>] [--sovereignty <path>] [--out <path>]
//     [--profile <id>] [--show-replies]
//
// Every run spends real money: each consult reserves up to the model's
// per-request allowance (Olympus counts $6). The script never starts a
// recovery session; if readiness reports a blocker (an unresolved fence
// included) it stops and prints the blockers. Recover with
// `bun scripts/zkapi-consult-recover.ts --yes`.
//
// Output carries timings, labels and counts only. Replies are not printed
// unless --show-replies is given, and are never written to the results file.
// Exit codes: 0 every run succeeded; 1 a run failed or a later run was
// blocked; 2 usage, setup, or blocked before the first run.

import { writeFileSync } from 'node:fs';
import {
  defaultZkapiStatePath,
  formatZkapiStageTable,
  openZkapiConsultSession,
  ZKAPI_STAGE_LABELS,
  zkapiConsultReadiness,
  type ZkapiConsultReadiness,
  type ZkapiConsultResult,
  type ZkapiConsultTransportOptions,
  type ZkapiOpenSessionResult,
  type ZkapiStageTimings,
} from '../src/core/consult-transport-zkapi.ts';
import { resolveSecretRefValue } from '../src/core/secret-store.ts';
import { loadSovereigntyEngine } from '../src/core/sovereignty.ts';

export const DEFAULT_QUESTIONS: readonly string[] = [
  'What is the boiling point of water at sea level in Celsius?',
  'How many days are in a leap year?',
  'What is the chemical symbol for gold?',
  'What is the capital of Australia?',
  'How many sides does a hexagon have?',
  'What is the square root of 144?',
  'Which planet is closest to the sun?',
  'How many minutes are in one day?',
  'What is the freezing point of water in Fahrenheit?',
  'Who wrote the play Romeo and Juliet?',
];

export interface TimingArgs {
  n: number;
  questionSet?: string;
  model?: string;
  statePath?: string;
  sovereignty?: string;
  profile?: string;
  out?: string;
  showReplies: boolean;
}

export function parseTimingArgs(argv: readonly string[]): TimingArgs | { error: string } {
  const args: TimingArgs = { n: 10, showReplies: false };
  const strings: Record<string, keyof TimingArgs> = {
    '--question-set': 'questionSet',
    '--model': 'model',
    '--state': 'statePath',
    '--sovereignty': 'sovereignty',
    '--profile': 'profile',
    '--out': 'out',
  };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i]!;
    if (flag === '--show-replies') {
      args.showReplies = true;
    } else if (flag === '--n') {
      const raw = argv[++i];
      const n = raw !== undefined && /^\d+$/.test(raw) ? Number(raw) : NaN;
      if (!Number.isInteger(n) || n < 1 || n > 1000) return { error: '--n needs a whole number from 1 to 1000.' };
      args.n = n;
    } else if (strings[flag]) {
      const value = argv[++i];
      if (!value || value.startsWith('--')) return { error: `${flag} needs a value.` };
      (args as unknown as Record<string, unknown>)[strings[flag]!] = value;
    } else {
      return { error: `Unknown argument ${flag}.` };
    }
  }
  return args;
}

export interface TimingRun {
  run: number;
  ok: boolean;
  code?: string;
  outcome: string;
  networkIdentity: string;
  routeLabel: string;
  confinement: string;
  fence: string;
  reservedUsd: number | null;
  elapsedMs: number;
  /** Wall clock from before `open` until the reply was in the caller's hands; null when no reply came. */
  toReplyMs: number | null;
  /** Wall clock from before `open` until `finished` resolved. */
  toFinishedMs: number;
  stageMs: ZkapiStageTimings;
}

/** One consult through the session API, timed from the caller's side. */
export interface ConsultTiming {
  result: ZkapiConsultResult;
  toReplyMs: number | null;
  toFinishedMs: number;
}

/**
 * open, send, finished: the reply is handed over before settlement, so the
 * caller-visible time to reply is measured separately from the whole session.
 */
export async function sessionConsult(
  question: string,
  options: ZkapiConsultTransportOptions,
  deps: { open: (options: ZkapiConsultTransportOptions) => Promise<ZkapiOpenSessionResult>; now: () => number } = { open: openZkapiConsultSession, now: () => Date.now() },
): Promise<ConsultTiming> {
  const started = deps.now();
  const opened = await deps.open(options);
  if (!opened.ok) return { result: opened, toReplyMs: null, toFinishedMs: deps.now() - started };
  const reply = await opened.session.send(question);
  const toReplyMs = reply.kind === 'reply' ? deps.now() - started : null;
  const result = await opened.session.finished;
  return { result, toReplyMs, toFinishedMs: deps.now() - started };
}

export interface StageSummary {
  stage: string;
  label: string;
  runs: number;
  medianMs: number;
  p95Ms: number;
}

export interface SpanSummary {
  runs: number;
  medianMs: number;
  p95Ms: number;
}

export interface TimingSummary {
  runs: number;
  succeeded: number;
  failed: number;
  failuresByCode: Record<string, number>;
  totalWorstCaseReservedUsd: number;
  /** Caller-side time to reply over the successful runs; null when none replied. */
  toReply: SpanSummary | null;
  /** Caller-side time to finished over the successful runs; null when none succeeded. */
  toFinished: SpanSummary | null;
  stages: StageSummary[];
}

function span(values: readonly number[]): SpanSummary | null {
  return values.length === 0 ? null : { runs: values.length, medianMs: median(values), p95Ms: percentile(values, 0.95) };
}

export function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/** Nearest-rank percentile: the smallest value with at least p of the sample at or below it. */
export function percentile(values: readonly number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(p * sorted.length) - 1)]!;
}

export function summarizeRuns(runs: readonly TimingRun[]): TimingSummary {
  const good = runs.filter((run) => run.ok);
  const failuresByCode: Record<string, number> = {};
  for (const run of runs) if (!run.ok) failuresByCode[run.code ?? 'unknown'] = (failuresByCode[run.code ?? 'unknown'] ?? 0) + 1;
  const stages: StageSummary[] = [];
  for (const [key, label] of ZKAPI_STAGE_LABELS) {
    const values = good.map((run) => run.stageMs[key]).filter((value): value is number => typeof value === 'number');
    if (values.length === 0) continue;
    stages.push({ stage: key, label, runs: values.length, medianMs: median(values), p95Ms: percentile(values, 0.95) });
  }
  return {
    runs: runs.length,
    succeeded: good.length,
    failed: runs.length - good.length,
    failuresByCode,
    totalWorstCaseReservedUsd: runs.reduce((sum, run) => sum + (run.reservedUsd ?? 0), 0),
    toReply: span(good.map((run) => run.toReplyMs).filter((value): value is number => value !== null)),
    toFinished: span(good.map((run) => run.toFinishedMs)),
    stages,
  };
}

export function toTimingRun(run: number, timing: ConsultTiming): TimingRun {
  const { result, toReplyMs, toFinishedMs } = timing;
  if (result.ok) {
    const receipt = result.receipt;
    return {
      run,
      ok: true,
      outcome: 'ok',
      networkIdentity: result.networkIdentity,
      routeLabel: result.routeLabel,
      confinement: receipt.confinement,
      fence: receipt.fence,
      reservedUsd: receipt.reservedUsd ?? null,
      elapsedMs: result.elapsedMs,
      toReplyMs,
      toFinishedMs,
      stageMs: receipt.stageMs ?? {},
    };
  }
  const error = result.error;
  return {
    run,
    ok: false,
    code: error.code,
    outcome: error.outcome,
    networkIdentity: error.networkIdentity,
    routeLabel: '',
    confinement: error.receipt?.confinement ?? 'n/a',
    fence: error.receipt?.fence ?? 'n/a',
    reservedUsd: error.receipt?.reservedUsd ?? null,
    elapsedMs: error.receipt?.stageMs?.totalMs ?? error.stageMs?.totalMs ?? 0,
    toReplyMs,
    toFinishedMs,
    stageMs: error.receipt?.stageMs ?? error.stageMs ?? {},
  };
}

export function formatRow(row: TimingRun): string {
  const status = row.ok ? 'ok' : `error ${row.code}`;
  const head = [
    `#${row.run}`,
    status,
    `outcome=${row.outcome}`,
    `identity=${row.networkIdentity}`,
    `route="${row.routeLabel || 'n/a'}"`,
    `confinement=${row.confinement}`,
    `fence=${row.fence}`,
    `reserved=${row.reservedUsd === null ? 'n/a' : `$${row.reservedUsd}`}`,
    `elapsed=${row.elapsedMs}ms`,
    `reply=${row.toReplyMs === null ? 'n/a' : `${row.toReplyMs}ms`}`,
    `finished=${row.toFinishedMs}ms`,
  ].join(' | ');
  const table = formatZkapiStageTable(row.stageMs).split('\n').map((line) => `    ${line}`).join('\n');
  return `${head}\n${table}`;
}

export function formatSummary(summary: TimingSummary): string {
  const lines = [`Runs: ${summary.runs} (${summary.succeeded} ok, ${summary.failed} failed). Total worst-case reservation: $${summary.totalWorstCaseReservedUsd}.`];
  const codes = Object.entries(summary.failuresByCode);
  lines.push(codes.length ? `Failures by code: ${codes.map(([code, count]) => `${code}=${count}`).join(', ')}` : 'Failures by code: none');
  const spanLine = (label: string, value: SpanSummary | null): string => (
    value ? `${label}: median ${value.medianMs} ms, p95 ${value.p95Ms} ms (${value.runs} run(s))` : `${label}: no run`
  );
  lines.push(spanLine('Time to reply (caller side)', summary.toReply));
  lines.push(spanLine('Time to finished (caller side)', summary.toFinished));
  if (summary.stages.length === 0) {
    lines.push('No successful runs, so no per-stage medians.');
  } else {
    const width = Math.max(...summary.stages.map((stage) => stage.label.length));
    lines.push(`Per-stage across ${summary.succeeded} successful run(s):`);
    lines.push(`  ${'stage'.padEnd(width)}  ${'median'.padStart(10)}  ${'p95'.padStart(10)}`);
    for (const stage of summary.stages) {
      lines.push(`  ${stage.label.padEnd(width)}  ${`${stage.medianMs} ms`.padStart(10)}  ${`${stage.p95Ms} ms`.padStart(10)}`);
    }
  }
  return lines.join('\n');
}

export interface TimingDeps {
  readiness: (options: Omit<ZkapiConsultTransportOptions, 'fetchImpl' | 'inspectListener'> & { apiKeyPresent?: boolean }) => Promise<ZkapiConsultReadiness>;
  consult: (question: string, options: ZkapiConsultTransportOptions) => Promise<ConsultTiming>;
  log: (line: string) => void;
  error: (line: string) => void;
  writeResults: (path: string, json: string) => void;
  now: () => Date;
}

export interface TimingPlan {
  questions: readonly string[];
  n: number;
  showReplies: boolean;
  out?: string;
  transport: ZkapiConsultTransportOptions;
}

export interface TimingOutcome {
  exitCode: number;
  runs: TimingRun[];
  summary: TimingSummary;
  blockedBefore?: { run: number; blockers: string[] };
}

/** Runs the plan serially; readiness is checked before every run and never auto-recovers. */
export async function runTiming(plan: TimingPlan, deps: TimingDeps): Promise<TimingOutcome> {
  const runs: TimingRun[] = [];
  const asked: string[] = [];
  let blockedBefore: TimingOutcome['blockedBefore'];
  for (let i = 0; i < plan.n; i += 1) {
    const readiness = await deps.readiness(plan.transport);
    if (readiness.blockers.length > 0) {
      blockedBefore = { run: i + 1, blockers: [...readiness.blockers] };
      deps.error(`Not ready before run ${i + 1}: ${readiness.blockers.join(', ')}. Nothing was sent for this run.`);
      if (readiness.blockers.some((b) => b === 'unresolved_session' || b === 'unresolved_session_other_wallet' || b === 'stranded_processes')) {
        deps.error('Recovery spends money, so this script never starts it. Run: bun scripts/zkapi-consult-recover.ts --yes');
      }
      break;
    }
    const question = plan.questions[i % plan.questions.length]!;
    asked.push(question);
    const timing = await deps.consult(question, plan.transport);
    const { result } = timing;
    const row = toTimingRun(i + 1, timing);
    if (!row.ok && !result.ok) row.routeLabel = result.error.message;
    runs.push(row);
    deps.log(formatRow(row));
    if (result.ok && plan.showReplies) deps.log(`    reply: ${result.text}`);
  }
  const summary = summarizeRuns(runs);
  deps.log(formatSummary(summary));
  const generatedAt = deps.now();
  if (plan.out) {
    const body = {
      generatedAt: generatedAt.toISOString(),
      requested: plan.n,
      model: plan.transport.model,
      questions: asked,
      blockedBefore,
      runs,
      summary,
    };
    deps.writeResults(plan.out, `${JSON.stringify(body, null, 2)}\n`);
    deps.log(`Results written to ${plan.out}`);
  }
  const exitCode = blockedBefore && runs.length === 0 ? 2 : summary.failed > 0 || blockedBefore ? 1 : 0;
  return { exitCode, runs, summary, ...(blockedBefore ? { blockedBefore } : {}) };
}

export function loadQuestions(path: string | undefined, readText: (path: string) => string): string[] {
  if (!path) return [...DEFAULT_QUESTIONS];
  const text = readText(path);
  const list = path.endsWith('.json')
    ? (JSON.parse(text) as unknown)
    : text.split('\n').map((line) => line.trim()).filter(Boolean);
  if (!Array.isArray(list) || list.length === 0 || list.some((item) => typeof item !== 'string' || !item.trim())) {
    throw new Error('The question set must be a non-empty list of non-empty strings (JSON array, or one question per line).');
  }
  return list as string[];
}

export function defaultOutPath(now: Date): string {
  return `./zkapi-consult-timing.${now.toISOString().replace(/[:.]/g, '-')}.json`;
}

async function main(argv: string[]): Promise<number> {
  const parsed = parseTimingArgs(argv);
  if ('error' in parsed) {
    console.error(parsed.error);
    return 2;
  }
  const { readFileSync } = await import('node:fs');
  let questions: string[];
  try {
    questions = loadQuestions(parsed.questionSet, (path) => readFileSync(path, 'utf8'));
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'Could not read the question set.');
    return 2;
  }
  const engine = loadSovereigntyEngine(parsed.sovereignty ? { configPath: parsed.sovereignty } : {});
  const profiles = Object.entries(engine.config.modelProfiles)
    .filter(([id, profile]) => profile.provider === 'zkapi' && (!parsed.profile || id === parsed.profile));
  if (profiles.length !== 1) {
    console.error(profiles.length === 0
      ? 'No zkapi profile found in the sovereignty policy.'
      : 'More than one zkapi profile: pass --profile <id>.');
    return 2;
  }
  const [, profile] = profiles[0]!;
  const apiKey = await resolveSecretRefValue(profile.secretRef);
  const now = new Date();
  const outcome = await runTiming({
    questions,
    n: parsed.n,
    showReplies: parsed.showReplies,
    out: parsed.out ?? defaultOutPath(now),
    transport: {
      baseUrl: profile.baseUrl!,
      model: parsed.model ?? ('model' in profile && profile.model ? profile.model : ''),
      ...(apiKey ? { apiKey } : {}),
      settings: profile.zkapi!,
      statePath: parsed.statePath ?? defaultZkapiStatePath(),
    },
  }, {
    readiness: zkapiConsultReadiness,
    consult: sessionConsult,
    log: (line) => console.log(line),
    error: (line) => console.error(line),
    writeResults: (path, json) => writeFileSync(path, json, { mode: 0o600 }),
    now: () => new Date(),
  });
  return outcome.exitCode;
}

if (import.meta.main) process.exit(await main(process.argv.slice(2)));
