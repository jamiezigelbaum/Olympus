// The real-writer eval against an OpenAI-compatible endpoint (owner decision
// 2026-10-10: "Writer: your own local model", docs/design/private-answers.md).
// Sibling of run-real.ts, which drives the built-in model on this Mac.
//
// It runs a modest, fixed set of invented cases (the writer check's six,
// including the live LOI notary failure with and without the letter, plus
// the first cases of the re-identification and unnamed-level sets) through a
// writer on the given endpoint, then through the production gate at the
// chosen level, and scores what would leave. Two modes:
//   --mode before   the rules as they were before 2026-10-10
//                   (prompts-before-2026-10-10.ts), over question, answer and
//                   gaps only: the built-in writer's old inputs;
//   --mode after    the product's own writer (runOwnConsultWriter) with the
//                   current rules and the evidence excerpts;
//   --mode after-no-evidence   the same writer and rules without the
//                   evidence (isolates the rules from the evidence);
//   --mode light-cleanup   Standard's light-cleanup instruction over the
//                   question and the evidence, through the secrets-only net
//                   (owner decision 2026-10-10: leaks of labelled
//                   identifiers there are information, not failures).
// Calls run one at a time (a home server is usually serial). Nothing is sent
// to zkAPI: the only network call is to the given endpoint.
//
// Run:
//   bun eval/consult-reid/run-endpoint.ts --base-url http://127.0.0.1:18090/v1 \
//     --model delphi/source-answer --level unnamed|general --mode before|after \
//     [--net full|thin] [--secret-ref env:NAME] [--out file.json] [--timeout-ms 240000]
//
// Leak scoring is independent of the gate: every outbound question is
// checked against the case's labelled canaries and the documents' figures,
// whatever the gate decided (`canaryLeak`, `hardIdentifierLeak` count only
// what would leave; `proposedCanary` counts what the writer wrote).

import { writeFileSync } from 'node:fs';
import { consultWriterContextFromPack, evaluateConsultRequest, type ConsultGateNet, type ConsultLevel } from '../../src/core/consult-gate.ts';
import {
  CONSULT_WRITER_CHECK_CASES,
  consultWriterCheckAsksAboutDocuments,
  consultWriterCheckCanaryPresent,
  consultWriterCheckPack,
  type ConsultWriterCheckCase,
} from '../../src/core/consult-writer-check.ts';
import {
  CONSULT_WRITER_LIMITS,
  CONSULT_WRITER_RESPONSE_SCHEMA,
  buildConsultWriterPrompt,
  consultWriterEvidence,
  parseConsultWriterReply,
  runOwnConsultWriter,
  type ConsultWriterOutcome,
} from '../../src/core/consult-writer.ts';
import { resolveSecretRefValueSync } from '../../src/core/secret-store.ts';
import { CONSULT_LIGHT_CLEANUP_INSTRUCTION } from '../../src/core/consult-settings.ts';
import { UNNAMED_CASES } from '../consult-leak/unnamed-questions.ts';
import { REID_CASES } from './cases.ts';
import { CONSULT_WRITER_SYSTEM_BEFORE_2026_10_10, CONSULT_WRITER_SYSTEM_UNNAMED_BEFORE_2026_10_10 } from './prompts-before-2026-10-10.ts';

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? undefined : process.argv[index + 1];
}

interface EvalCase extends ConsultWriterCheckCase {
  readonly set: 'check' | 'reid' | 'unnamed';
  /** Exact figures that must not leave (re-identification cases). */
  readonly figures: readonly string[];
}

/** The fixed, modest set: 6 + 4 + 6 = 16 cases. */
export const ENDPOINT_EVAL_CASES: readonly EvalCase[] = [
  ...CONSULT_WRITER_CHECK_CASES.map((entry) => ({ ...entry, set: 'check' as const, figures: [] })),
  ...REID_CASES.slice(0, 4).map((entry) => ({ id: entry.id, userQuestion: entry.userQuestion, titles: entry.titles, documents: entry.documents, answer: entry.answer, gaps: entry.gaps, canaries: entry.canaries, figures: entry.figures, set: 'reid' as const })),
  ...UNNAMED_CASES.filter((entry) => !CONSULT_WRITER_CHECK_CASES.some((check) => check.id === entry.id)).slice(0, 6)
    .map((entry) => ({ id: entry.id, userQuestion: entry.userQuestion, titles: entry.titles, documents: entry.documents, answer: entry.answer, gaps: entry.gaps, canaries: entry.canaries, figures: [], set: 'unnamed' as const })),
];

/** Hard identifiers in a request, judged apart from the gate: a figure of three or more digits that the documents hold, a listed figure, a mail address or link, or a run of seven or more digits. */
export function hardIdentifierIn(questions: readonly string[], entry: EvalCase): boolean {
  const text = questions.join(' ');
  const written = (text.match(/\d[\d,.]*/g) ?? []).map((value) => value.replace(/\D/g, ''));
  const documentFigures = new Set(entry.documents.join(' ').match(/\d[\d,.\/-]*/g)?.map((value) => value.replace(/\D/g, '')).filter((digits) => digits.length >= 3) ?? []);
  const listed = new Set(entry.figures.map((figure) => figure.replace(/\D/g, '')));
  if (/@|:\/\/|\bwww\./u.test(text) || written.some((digits) => digits.length >= 7)) return true;
  return written.some((digits) => documentFigures.has(digits) || listed.has(digits));
}

async function beforeWriter(entry: EvalCase, level: ConsultLevel, endpoint: { baseUrl: string; model: string; apiKey?: string }, deadlineMs: number): Promise<ConsultWriterOutcome> {
  const system = level === 'unnamed' ? CONSULT_WRITER_SYSTEM_UNNAMED_BEFORE_2026_10_10 : CONSULT_WRITER_SYSTEM_BEFORE_2026_10_10;
  // The old user message: question, answer and gaps (no evidence), exactly as today's builder writes it without evidence.
  const user = buildConsultWriterPrompt({ question: entry.userQuestion, answer: entry.answer, gaps: entry.gaps }, level)[1]!.content;
  const started = Date.now();
  const body = (structured: boolean) => JSON.stringify({
    model: endpoint.model,
    messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
    temperature: 0,
    max_tokens: CONSULT_WRITER_LIMITS.ownWriterMaxOutputTokens,
    stream: false,
    ...(structured ? { response_format: { type: 'json_schema', json_schema: { name: 'consult', schema: CONSULT_WRITER_RESPONSE_SCHEMA } } } : {}),
  });
  const headers: Record<string, string> = { 'content-type': 'application/json', ...(endpoint.apiKey ? { authorization: `Bearer ${endpoint.apiKey}` } : {}) };
  try {
    const signal = AbortSignal.timeout(deadlineMs);
    let response = await fetch(`${endpoint.baseUrl}/chat/completions`, { method: 'POST', headers, body: body(true), signal, redirect: 'error' });
    if (response.status === 400 || response.status === 422) response = await fetch(`${endpoint.baseUrl}/chat/completions`, { method: 'POST', headers, body: body(false), signal, redirect: 'error' });
    if (!response.ok) return { kind: 'failed', reason: 'request_failed' };
    const content = ((await response.json()) as { choices?: Array<{ message?: { content?: unknown } }> }).choices?.[0]?.message?.content;
    if (typeof content !== 'string') return { kind: 'failed', reason: 'request_failed' };
    const reply = parseConsultWriterReply(content);
    const ms = Date.now() - started;
    if (reply.kind === 'invalid') return { kind: 'failed', reason: reply.reason };
    if (reply.kind === 'declined') return { kind: 'declined', promptTokens: 0, ms };
    return { kind: 'questions', questions: reply.questions, promptTokens: 0, ms };
  } catch {
    return { kind: 'killed', reason: 'deadline' };
  }
}

if (import.meta.main) {
  const baseUrl = arg('base-url')?.replace(/\/+$/, '');
  const model = arg('model');
  const level = (arg('level') ?? 'unnamed') as ConsultLevel;
  const mode = arg('mode') ?? 'after';
  const deadlineMs = Number(arg('timeout-ms') ?? 240_000);
  const net = (mode === 'light-cleanup' ? 'secrets' : arg('net') ?? 'full') as ConsultGateNet;
  if (!baseUrl || !model || (level !== 'unnamed' && level !== 'general') || !['before', 'after', 'after-no-evidence', 'light-cleanup'].includes(mode) || !['full', 'thin', 'secrets'].includes(net)) {
    console.error('Usage: bun eval/consult-reid/run-endpoint.ts --base-url <url> --model <name> --level unnamed|general --mode before|after|after-no-evidence|light-cleanup [--net full|thin] [--secret-ref ref] [--out file] [--timeout-ms n]');
    process.exit(2);
  }
  const secretRef = arg('secret-ref');
  const apiKey = secretRef ? resolveSecretRefValueSync(secretRef) : undefined;
  const endpoint = { baseUrl, model, ...(apiKey ? { apiKey } : {}) };
  const results: Array<Record<string, unknown>> = [];
  for (const entry of ENDPOINT_EVAL_CASES) {
    const outcome = mode === 'before'
      ? await beforeWriter(entry, level, endpoint, deadlineMs)
      : mode === 'light-cleanup'
      ? await runOwnConsultWriter({ question: entry.userQuestion, answer: '', gaps: [], instruction: CONSULT_LIGHT_CLEANUP_INSTRUCTION, evidence: consultWriterEvidence(consultWriterCheckPack(entry)) }, {
        endpoint,
        kill: new AbortController().signal,
        deadlineMs,
        level: 'unnamed',
      })
      : await runOwnConsultWriter({ question: entry.userQuestion, answer: entry.answer, gaps: entry.gaps, ...(mode === 'after' ? { evidence: consultWriterEvidence(consultWriterCheckPack(entry)) } : {}) }, {
        endpoint,
        kill: new AbortController().signal,
        deadlineMs,
        level,
      });
    const questions = outcome.kind === 'questions' ? [...outcome.questions] : [];
    let gate = 'not_sent';
    let reasons: string[] = [];
    if (questions.length > 0) {
      const context = consultWriterContextFromPack(consultWriterCheckPack(entry), { writerVisibleTexts: [entry.userQuestion], writerAnswerTexts: [entry.answer, ...entry.gaps] });
      const verdict = evaluateConsultRequest(questions, context, {}, {}, { languages: ['en'], level, askedQuestionTexts: [entry.userQuestion], askedQuestionFullTexts: [entry.userQuestion], net });
      gate = verdict.decision;
      reasons = [...verdict.reasons];
    }
    const result = {
      id: entry.id,
      set: entry.set,
      outcome: outcome.kind,
      ...('reason' in outcome ? { reason: outcome.reason } : {}),
      ...('ms' in outcome ? { ms: outcome.ms } : {}),
      questions,
      gate,
      reasons,
      canaryLeak: gate === 'pass' && consultWriterCheckCanaryPresent(questions, entry.canaries),
      hardIdentifierLeak: gate === 'pass' && hardIdentifierIn(questions, entry),
      // Before the gate: what the writer itself proposed.
      proposedCanary: consultWriterCheckCanaryPresent(questions, entry.canaries),
      asksAboutDocuments: questions.some(consultWriterCheckAsksAboutDocuments),
    };
    results.push(result);
    console.log(JSON.stringify(result));
  }
  const summary = {
    endpoint: baseUrl,
    model,
    level,
    mode,
    net,
    recordedAt: new Date().toISOString(),
    cases: results.length,
    written: results.filter((result) => result.outcome === 'questions').length,
    declined: results.filter((result) => result.outcome === 'declined').length,
    failed: results.filter((result) => result.outcome !== 'questions' && result.outcome !== 'declined').length,
    gatePassed: results.filter((result) => result.gate === 'pass').length,
    canaryLeaks: results.filter((result) => result.canaryLeak).map((result) => result.id),
    hardIdentifierLeaks: results.filter((result) => result.hardIdentifierLeak).map((result) => result.id),
    proposedCanary: results.filter((result) => result.proposedCanary).map((result) => result.id),
    documentQuestions: results.filter((result) => result.asksAboutDocuments).map((result) => result.id),
  };
  console.log(JSON.stringify(summary));
  const out = arg('out');
  if (out) writeFileSync(out, `${JSON.stringify({ summary, results }, null, 2)}\n`);
}
