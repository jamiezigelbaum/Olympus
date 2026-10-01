// Benchmark for the built-in private model (docs/design/private-model-benchmark.md).
//
// Runs the real built-in analyst path — createBuiltInAnalystModel → llama-server
// child process → the one generic Analyst prompt (with the local audit pass) —
// over a small synthetic Private question set built from the fictional
// reviewer demo data (chatgpt-plugin/demo-data). The repo's held-out eval has
// no instantiated private-tier cases in git (they carry private corpus values),
// so this set stands in for them; it is graded with the held-out eval's own
// answer and citation rules (eval/grade.ts). Privacy is structural here: the
// model runs on loopback and no evidence leaves the machine.
//
//   bun eval/private-model-bench.ts --model qwen3.5-4b-q4_k_m-e87f176 \
//     --gguf <path.gguf> --server <path/to/llama-server> [--gpu] [--out results.json]
//
// --model names a manifest model, or `custom:<label>` for a GGUF that is not in
// the manifest (candidates under evaluation).

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createAnalyst } from '../src/core/analyst.ts';
import { createBuiltInAnalystModel, privateEvidencePack, type PrivateEvidenceItem } from '../src/core/analyst-built-in.ts';
import type { AnalystResult, EvidencePack } from '../src/core/contracts.ts';
import {
  BUILT_IN_REASONING_MODELS,
  type BuiltInReasoningModelSpec,
} from '../src/workers/source-index/built-in-reasoning/manifest.ts';
import { createLlamaServerHandle, type LlamaServerHandle } from '../src/workers/source-index/built-in-reasoning/server.ts';
import { gradeAnswer } from './grade.ts';
import type { EvalQuestion } from './types.ts';

const DEMO = join(import.meta.dir, '..', 'chatgpt-plugin', 'demo-data');
const CORPUS = 'secure_local.demo';

const ITEMS: Array<{ id: string; file: string; title: string; source: string }> = [
  { id: 'lab-results', file: 'mail/008-lab-results.eml', title: 'Your test results are ready', source: 'Mail' },
  { id: 'bank-notice', file: 'mail/009-bank-notice.eml', title: 'Your September statement and overdraft notice', source: 'Mail' },
  { id: 'clinic-visit', file: 'notes/2026-09-20-clinic-visit.md', title: 'Clinic visit - 20 Sept 2026', source: 'Notes' },
  { id: 'insurance-claim', file: 'docs/insurance-claim.md', title: 'Insurance claim notes', source: 'Files' },
  { id: 'tax-notes', file: 'docs/tax-notes-2025.md', title: 'Tax notes, 2025 tax year', source: 'Files' },
  // Personal-tier neighbours, so the model has to pick the right evidence.
  { id: 'dentist', file: 'mail/003-dentist-appointment.eml', title: 'Appointment confirmed', source: 'Mail' },
  { id: 'budget-decision', file: 'notes/2026-09-02-budget-decision.md', title: 'Budget decision - 2 Sept 2026', source: 'Notes' },
  { id: 'lease-summary', file: 'docs/lease-summary.md', title: 'Lease summary: 14 Larch Court', source: 'Files' },
];

function ev(id: string) {
  return { corpusId: CORPUS, providerItemId: id, hint: id };
}

const QUESTIONS: EvalQuestion[] = [
  { id: 'p01', shape: 'value_lookup', question: 'How much was the overdraft fee on my bank account in September?', expectedAnswerContains: ['25'], expectedEvidence: [ev('bank-notice')] },
  { id: 'p02', shape: 'value_lookup', question: 'What is my current loan balance?', expectedAnswerContains: ['8,940'], expectedEvidence: [ev('bank-notice')] },
  { id: 'p03', shape: 'value_lookup', question: 'By how much was my account overdrawn, and on what date?', expectedAnswerContains: ['212.40', '19 September'], expectedEvidence: [ev('bank-notice')] },
  { id: 'p04', shape: 'value_lookup', question: 'How much did I claim from the insurer, and by when do I have to send the referral letter?', expectedAnswerContains: ['340', '10 October'], expectedEvidence: [ev('insurance-claim')] },
  { id: 'p05', shape: 'value_lookup', question: 'How much tax do I expect to owe for 2025?', expectedAnswerContains: ['1,240'], expectedEvidence: [ev('tax-notes')] },
  { id: 'p06', shape: 'count_or_aggregate', question: 'What were my total income and my freelance income in 2025?', expectedAnswerContains: ['71,300', '9,800'], expectedEvidence: [ev('tax-notes')] },
  { id: 'p07', shape: 'locator', question: 'Which clinic sent my blood test results, and which doctor reviewed them?', expectedAnswerContains: ['Riverside', 'Hale'], expectedEvidence: [ev('lab-results')] },
  { id: 'p08', shape: 'cross_source_synthesis', question: 'Why did I see Dr. Hale in September, and what did the blood tests she ordered show?', expectedAnswerContains: ['headache', 'iron'], expectedEvidence: [ev('clinic-visit'), ev('lab-results')] },
  { id: 'p09', shape: 'cross_source_synthesis', question: 'What follow-ups do I have after the blood tests: what did the clinic recommend and what does the insurer still need?', expectedAnswerContains: ['three months', 'referral'], expectedEvidence: [ev('lab-results'), ev('insurance-claim')] },
  { id: 'p10', shape: 'summary_or_sentiment', question: 'Summarize my money situation from the bank notice.', expectedAnswerContains: ['212.40', '8,940'], expectedEvidence: [ev('bank-notice')] },
  { id: 'n01', shape: 'coverage_negative', question: 'What was my blood pressure reading at the clinic?', mustReportGap: true },
  { id: 'n02', shape: 'coverage_negative', question: 'What interest rate does my loan charge?', mustReportGap: true },
];

interface CallTiming {
  promptTokens: number;
  promptMs: number;
  predictedTokens: number;
  predictedMs: number;
}

interface QuestionOutcome {
  id: string;
  passed: boolean;
  answerCorrect: boolean;
  evidenceCited: boolean;
  gapHonest: boolean;
  durationMs: number;
  calls: CallTiming[];
  answer: string;
  cited: string[];
  unanswered: string[];
  error?: string;
}

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function loadEvidence(): PrivateEvidenceItem[] {
  return ITEMS.map((item) => ({
    id: item.id,
    title: item.title,
    source: item.source,
    locator: item.file,
    text: readFileSync(join(DEMO, item.file), 'utf8'),
  }));
}

function packFor(question: string, evidence: PrivateEvidenceItem[]): EvidencePack {
  const pack = privateEvidencePack(question, evidence);
  return {
    ...pack,
    candidates: pack.candidates.map((candidate) => ({
      ...candidate,
      provenance: { ...candidate.provenance, localIds: { corpus_id: CORPUS } },
    })),
    coverage: { ...pack.coverage, searchedCorpora: [CORPUS] },
  };
}

function gradeNegative(result: AnalystResult): boolean {
  // Honest "not in the evidence": a reported gap, and no invented number.
  return result.unanswered.length > 0 && !/\d+(?:[.,]\d+)?\s*(?:%|mmhg|per ?cent)/i.test(result.answer);
}

function rssKb(pid: number | undefined): number {
  if (!pid) return 0;
  const out = spawnSync('ps', ['-o', 'rss=', '-p', String(pid)], { encoding: 'utf8' }).stdout.trim();
  return Number.parseInt(out, 10) || 0;
}

async function main(): Promise<void> {
  const modelArg = arg('model') ?? '';
  const gguf = arg('gguf');
  const serverPath = arg('server');
  const gpu = process.argv.includes('--gpu');
  const out = arg('out');
  if (!gguf || !serverPath) throw new Error('Pass --gguf and --server.');
  const manifest = BUILT_IN_REASONING_MODELS.find((model) => model.modelId === modelArg);
  const spec: BuiltInReasoningModelSpec = manifest ?? {
    ...BUILT_IN_REASONING_MODELS[1]!,
    modelId: modelArg.replace(/^custom:/, '') || 'custom',
    displayName: modelArg.replace(/^custom:/, '') || 'custom',
  };

  let server: LlamaServerHandle | undefined;
  const calls: CallTiming[] = [];
  const timedFetch: typeof fetch = Object.assign(async (input: RequestInfo | URL, init?: RequestInit) => {
    const response = await fetch(input, init);
    if (String(input).endsWith('/v1/chat/completions') && response.ok) {
      const copy = response.clone();
      const body = await copy.json() as { timings?: { prompt_n: number; prompt_ms: number; predicted_n: number; predicted_ms: number } };
      if (body.timings) {
        calls.push({
          promptTokens: body.timings.prompt_n,
          promptMs: body.timings.prompt_ms,
          predictedTokens: body.timings.predicted_n,
          predictedMs: body.timings.predicted_ms,
        });
      }
    }
    return response;
  }, { preconnect: fetch.preconnect });

  const model = createBuiltInAnalystModel({
    model: spec,
    install: async () => ({ modelPath: gguf, serverPath, gpu }),
    createServer: (launch) => {
      server = createLlamaServerHandle({ ...launch, idleShutdownSeconds: 0 });
      return server;
    },
    fetchImpl: timedFetch,
    waitForInstall: true,
  });
  const analyst = createAnalyst(model, { auditSuspiciousDrafts: true });
  const evidence = loadEvidence();

  let peakRssKb = 0;
  const sampler = setInterval(() => {
    peakRssKb = Math.max(peakRssKb, rssKb(server?.pid));
  }, 200);

  // Cold start: install check + process launch + model load, measured on a
  // tiny request so it is not mixed into the answer timings.
  const coldStartedAt = Date.now();
  await model.complete({ system: 'Reply with {"ok":true}', prompt: 'ping', localOnly: true, maxOutputChars: 20 });
  const coldStartMs = Date.now() - coldStartedAt;
  calls.length = 0;

  const outcomes: QuestionOutcome[] = [];
  for (const question of QUESTIONS) {
    const before = calls.length;
    const startedAt = Date.now();
    try {
      const pack = packFor(question.question, evidence);
      const result = await analyst.analyze(pack, { localOnly: true });
      const durationMs = Date.now() - startedAt;
      const cited = result.citations.map((citation) => citation.provenance.sourceItem.providerItemId);
      let answerCorrect: boolean;
      let evidenceCited: boolean;
      let gapHonest: boolean;
      if (question.mustReportGap) {
        answerCorrect = true;
        evidenceCited = true;
        gapHonest = gradeNegative(result);
      } else {
        const grade = gradeAnswer(question, result, undefined, {
          citationCorpusIds: result.citations.map(() => CORPUS),
        });
        answerCorrect = grade.answerCorrect;
        evidenceCited = grade.evidenceCited;
        gapHonest = true;
      }
      outcomes.push({
        id: question.id,
        passed: answerCorrect && evidenceCited && gapHonest,
        answerCorrect,
        evidenceCited,
        gapHonest,
        durationMs,
        calls: calls.slice(before),
        answer: result.answer,
        cited,
        unanswered: [...result.unanswered],
      });
    } catch (error) {
      outcomes.push({
        id: question.id,
        passed: false,
        answerCorrect: false,
        evidenceCited: false,
        gapHonest: false,
        durationMs: Date.now() - startedAt,
        calls: calls.slice(before),
        answer: '',
        cited: [],
        unanswered: [],
        error: error instanceof Error ? error.message : String(error),
      });
    }
    const last = outcomes[outcomes.length - 1]!;
    console.error(`${spec.modelId} ${last.id} ${last.passed ? 'PASS' : 'FAIL'} ${(last.durationMs / 1000).toFixed(1)}s ${last.error ?? ''}`);
  }
  clearInterval(sampler);
  await model.stop();

  const allCalls = outcomes.flatMap((outcome) => outcome.calls);
  const sum = (pick: (call: CallTiming) => number) => allCalls.reduce((total, call) => total + pick(call), 0);
  const firstCalls = outcomes.map((outcome) => outcome.calls[0]).filter((call): call is CallTiming => Boolean(call));
  const median = (values: number[]) => {
    const sorted = [...values].sort((a, b) => a - b);
    return sorted.length ? sorted[Math.floor(sorted.length / 2)]! : 0;
  };
  const summary = {
    modelId: spec.modelId,
    questions: outcomes.length,
    passed: outcomes.filter((outcome) => outcome.passed).length,
    coldStartMs,
    generationTokensPerSecond: sum((call) => call.predictedTokens) / (sum((call) => call.predictedMs) / 1000),
    promptTokensPerSecond: sum((call) => call.promptTokens) / (sum((call) => call.promptMs) / 1000),
    medianTimeToFirstTokenMs: median(firstCalls.map((call) => call.promptMs)),
    medianAnswerMs: median(outcomes.map((outcome) => outcome.durationMs)),
    medianPromptTokens: median(firstCalls.map((call) => call.promptTokens)),
    auditCalls: allCalls.length - firstCalls.length,
    peakRssMb: Math.round(peakRssKb / 1024),
    loadAverage: readLoadAverage(),
    outcomes,
  };
  const json = `${JSON.stringify(summary, null, 2)}\n`;
  if (out) writeFileSync(out, json);
  else process.stdout.write(json);
}

function readLoadAverage(): string {
  return spawnSync('sysctl', ['-n', 'vm.loadavg'], { encoding: 'utf8' }).stdout.trim();
}

await main();
