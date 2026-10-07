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
//
// --panel runs the private answer panel's path instead (private-answer-model.ts:
// relevance-ranked, floored and capped items, the compact rendering, no audit)
// over a synthetic set of dated lab reports whose evidence arrives in a
// deliberately unhelpful retrieval order (reports from other months first, as
// a lexical search ranked a real store's in the 2026-10-02 owner report). A question
// passes when every cited item is an expected one. Add --embedding-dir
// <built-in-embedding dir> to rank with the built-in embedding model (the
// engine's default), or leave it out to measure retrieval order alone.

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
import { createBuiltInPrivateAnswerModel, embeddingPanelRelevance } from '../src/workers/chatgpt/private-answer-model.ts';
import { BuiltInSourceEmbeddingProvider } from '../src/workers/source-index/built-in-embedding/provider.ts';
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

// The panel set: fictional lab reports (no real person or value), named the
// way people file them, with a passage each.
const PANEL_ITEMS: Array<{ id: string; title: string; saved: string; text: string }> = [
  { id: 'organic', title: '2026-02-10 organic acids report RIVERA.pdf', saved: '2026-03-02T16:06:00Z', text: 'PATIENT: SAM RIVERA COLLECTED: 08-Feb-2026 TESTED: 20-Feb-2026 TEST NAME: Organic Acids Results Interpretation At-A-Glance B-Vitamin Needs Thiamin B1 2 Pyridoxine B6 3 Results reported for the test.' },
  { id: 'toxin', title: '2026-04-03 TOXIN PANEL_SAM RIVERA.pdf', saved: '2026-04-21T08:17:10Z', text: 'PATIENT: SAM RIVERA TEST NAME: Environmental Toxin Profile (urine) COLLECTED: 30-Mar-2026 Results: Toxin A < 0.5 <DL; Toxin B 2.1 ug/g creatinine (high); Toxin C <DL. Test results.' },
  { id: 'blood-1', title: '2026-04-14 blood work 1.pdf', saved: '2026-04-22T11:03:22Z', text: 'Laboratorio Central Data de colheita 14/04/2026 Data de emissao 22/04/2026 SAM RIVERA Hemograma: Hemoglobina 14.8 g/dL (13.0-17.0); Leucocitos 6.1 x10^9/L; Ferritina 82 ng/mL (30-400); Glicose 91 mg/dL.' },
  { id: 'blood-2', title: '2026-04-14 blood work 2.pdf', saved: '2026-04-23T18:35:05Z', text: 'Laboratorio Central Pag. 4/7 Data de colheita 14/04/2026 SAM RIVERA Testosterona total 640 ng/dL (241-827); Vitamina D (25-OH) 41 ng/mL (30-100); TSH 1.9 mUI/L.' },
  { id: 'metabolic', title: '2026-03-19 metabolic panel and tests.pdf', saved: '2026-03-26T10:00:00Z', text: 'Collected 19/03/2026 SAM RIVERA Metabolic panel: Creatinine 0.98 mg/dL; ALT 24 U/L; LDL 118 mg/dL.' },
  { id: 'sleep', title: '2025-11-05 sleep study (english).pdf', saved: '2025-11-20T09:00:00Z', text: 'Polysomnography 5 November 2025, SAM RIVERA. Apnea-hypopnea index (AHI) 3.1 events/h; lowest SpO2 91%; sleep efficiency 86%. Impression: no significant sleep apnea.' },
  { id: 'omega', title: '2025-11-12 Omega 3 index test.pdf', saved: '2025-12-08T14:59:34Z', text: 'Omega-3 Index report, sample collected 12 November 2025, SAM RIVERA. Omega-3 Index 6.2% (desirable 8-12%). Omega-6:Omega-3 ratio 7.4:1. Trans Fat Index 0.6%.' },
  { id: 'urgent', title: '2026-08-30 blood and urine urgent care.pdf', saved: '2026-08-31T12:00:00Z', text: 'Urgent care visit 30/08/2026 SAM RIVERA. Reason: fever and flank pain. CRP 12 mg/L (<5); leucocytes 11.2 x10^9/L; urinalysis: nitrites negative, leucocyte esterase trace. Plan: fluids, review in 48 h.' },
];

const PANEL_QUESTIONS: Array<{ id: string; question: string; order: string[]; expected: string[] }> = [
  { id: 'q01', question: 'April 2026 blood test results', order: ['toxin', 'organic', 'blood-2', 'metabolic', 'omega', 'blood-1'], expected: ['blood-1', 'blood-2'] },
  { id: 'q02', question: 'April 2026 lab results', order: ['toxin', 'organic', 'blood-2', 'urgent', 'blood-1', 'metabolic'], expected: ['blood-1', 'blood-2', 'toxin'] },
  { id: 'q03', question: 'What did my April 2026 blood work show?', order: ['blood-2', 'urgent', 'blood-1', 'organic', 'toxin', 'sleep'], expected: ['blood-1', 'blood-2'] },
  { id: 'q04', question: 'What did my sleep study in November 2025 find?', order: ['omega', 'organic', 'sleep', 'urgent', 'blood-1', 'toxin'], expected: ['sleep'] },
  { id: 'q05', question: 'What was my omega-3 index?', order: ['organic', 'metabolic', 'omega', 'blood-2', 'toxin', 'sleep'], expected: ['omega'] },
  { id: 'q06', question: 'What happened at my August 2026 urgent care visit?', order: ['blood-1', 'blood-2', 'urgent', 'organic', 'toxin', 'omega'], expected: ['urgent'] },
  { id: 'q07', question: 'What did my toxin test show?', order: ['organic', 'toxin', 'blood-1', 'urgent', 'omega', 'sleep'], expected: ['toxin'] },
  { id: 'q08', question: 'My March 2026 metabolic panel results', order: ['organic', 'toxin', 'metabolic', 'blood-1', 'blood-2', 'omega'], expected: ['metabolic'] },
];

/** The panel path over the synthetic lab set: pass when something is cited and every citation is expected. */
async function runPanel(model: ReturnType<typeof createBuiltInAnalystModel>, modelId: string): Promise<void> {
  const embeddingDir = arg('embedding-dir');
  let relevance: ReturnType<typeof embeddingPanelRelevance> | undefined;
  if (embeddingDir) {
    const { builtInEmbeddingPaths, installedBuiltInEmbedding } = await import('../src/workers/source-index/built-in-embedding/assets.ts');
    const paths = builtInEmbeddingPaths({ OLYMPUS_BUILT_IN_EMBEDDING_DIR: embeddingDir });
    const provider = new BuiltInSourceEmbeddingProvider({
      // Status writes stay out of the real install's directory.
      env: { OLYMPUS_BUILT_IN_EMBEDDING_DIR: join(process.env.TMPDIR ?? '/tmp', 'olympus-bench-embedding') },
      install: async () => installedBuiltInEmbedding(paths),
    });
    // Loaded first, as in a running engine (a query before the model is loaded falls back to keyword search).
    await provider.prepare();
    relevance = embeddingPanelRelevance(() => provider);
  }
  const { answerPrivately } = await import('../src/core/analyst-built-in.ts');
  // Synthetic bench items with no store behind them: every one is eligible.
  const panel = createBuiltInPrivateAnswerModel({
    model,
    available: () => true,
    answer: answerPrivately,
    eligible: async (items) => items.map(() => true),
    ...(relevance ? { relevance } : {}),
  });
  const byId = new Map(PANEL_ITEMS.map((item) => [item.id, item]));
  let passed = 0;
  const outcomes: Array<Record<string, unknown>> = [];
  for (const question of PANEL_QUESTIONS) {
    const evidence = question.order.map((id) => {
      const item = byId.get(id)!;
      return {
        sourceItem: { provider: 'bench', family: 'file', accountScope: 'personal', localItemId: id, providerItemId: id },
        provenance: { citation: { title: item.title, authoredAt: item.saved, uri: `/Health/Labs/${item.title}`, sourceLabel: 'files' } },
        chunks: [item.text],
        trust_domain: 'secure_local',
      };
    });
    const startedAt = Date.now();
    let read: readonly number[] = [];
    const result = await panel.answerPrivately(question.question, evidence, undefined, { evidence: (stats) => { read = stats.used ?? []; } });
    const titles = new Map(PANEL_ITEMS.map((item) => [item.title, item.id]));
    const cited = result.citations.map((citation) => titles.get(citation.title ?? '') ?? citation.title ?? '');
    const ok = cited.length > 0 && cited.every((id) => question.expected.includes(id));
    if (ok) passed += 1;
    outcomes.push({ id: question.id, passed: ok, durationMs: Date.now() - startedAt, read: read.map((index) => question.order[index]), cited });
    console.error(`${modelId} panel ${question.id} ${ok ? 'PASS' : 'FAIL'} ${((Date.now() - startedAt) / 1000).toFixed(1)}s read=${read.map((index) => question.order[index]).join(',')} cited=${cited.join(',')}`);
  }
  await model.stop();
  process.stdout.write(`${JSON.stringify({ modelId, mode: 'panel', ranking: relevance ? 'embedding' : 'retrieval order', questions: PANEL_QUESTIONS.length, passed, outcomes }, null, 2)}\n`);
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
  if (process.argv.includes('--panel')) {
    await runPanel(model, spec.modelId);
    return;
  }
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
