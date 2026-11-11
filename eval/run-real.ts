import { openEvalDataRoot } from './data-root.ts';
import { parseDataRootArgs, dataRootArgv } from './data-root-args.ts';
import { createEvalSourceLanes } from './retrieval.ts';
import type { EvalDataRootOptions } from './data-root.ts';
import { configuredEvalEmbedding, prepareEvalEmbedding, type EvalRetrievalMode, buildEvalPack, createEvalDropboxLanes, evalDropboxStorePaths, openEvalDropboxStores, resolveEvalDropboxScope, type EvalStoreSearch } from './retrieval.ts';
export { configuredEvalEmbedding, prepareEvalEmbedding, builtInEmbeddingFilesPresent, type EvalRetrievalMode, buildEvalPack, createEvalDropboxLanes, evalDropboxStorePaths, openEvalDropboxStores, resolveEvalDropboxScope, assertEvalDropboxStoreIsolation, type EvalDropboxStorePaths, type EvalDropboxStores, type EvalStoreSearch } from './retrieval.ts';
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
//   OLYMPUS_SOURCE_INDEX_ACCOUNT=personal \
//   bun run eval:real [path/to/held-out.real.json]
//
// It searches the way Ask does: every Dropbox tier store this install has
// (Private and Personal, and Public when it exists) through the shared answer
// lanes, judged by the source's tier ledger, with the built-in embedding model
// when it is installed and keyword search otherwise (said in the run output).
// The Private store is where this install keeps it unless
// OLYMPUS_EVAL_DROPBOX_STORE names another file (a copy, say);
// OLYMPUS_EVAL_DROPBOX_PERSONAL_STORE, OLYMPUS_EVAL_DROPBOX_PUBLIC_STORE and
// OLYMPUS_EVAL_DROPBOX_LEDGER do the same for the other stores and the ledger.
//
// Set OLYMPUS_EVAL_DROPBOX_APPROVED_SCOPE_KEY only when every instantiated
// expected evidence item is inside that approved Dropbox scope.
// Set OLYMPUS_EVAL_QUERY_PLANNER_ENABLED=true to include model-planned
// retrieval expansions; default is literal-query retrieval for a usable gate.

import { createHash } from 'node:crypto';
import { prepareBuiltInRerankerFromEnv } from '../src/workers/source-index/built-in-reranker.ts';
import type { EvidenceReranker } from '../src/core/evidence-reranker.ts';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { analystPromptBytes, createAnalyst, type AnalystModel } from '../src/core/analyst.ts';
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
import type { EvidencePackBuildDetail } from '../src/core/evidence-pack.ts';
import { createAnalystQueryPlanner, type AnalystQueryPlanner } from '../src/core/query-planner.ts';
import {
  DEFAULT_LOCAL_ANALYST_PROMPT_BYTES,
  DEFAULT_MAX_CHARS_PER_CANDIDATE as PRODUCT_MAX_CHARS_PER_CANDIDATE,
  DEFAULT_MAX_RESULTS as PRODUCT_MAX_RESULTS,
  fitPackToPromptBytes,
  releaseAnalystAnswer,
  type AnalystAnswerLanes,
  type AnalystReleaseOutcome,
} from '../src/workers/source-index/analyst-answer.ts';
import type { Analyst, AnalystOptions, AnalystResult, EvidencePack } from '../src/core/contracts.ts';
import type { OpsecReleaseAudit } from '../src/core/opsec.ts';
import { acceptableForms, answerContainsExpectedValue, expectedEvidenceMatches, type EvalGrade } from './grade.ts';
import { runEval, type EvalQuestionTiming, type EvalReport } from './run.ts';
import { classifyPrecisionStage, summarizePrecisionTraces, type PrecisionTrace } from './diagnose.ts';
import { runBoundedEvalProcess } from './process-boundary.ts';
import type { EvalDataset, EvalExpectedEvidence, EvalQuestion } from './types.ts';

const DEFAULT_DATASET_PATH = 'eval/private/held-out.real.json';
const DEFAULT_REPORT_PATH = 'eval/private/report.latest.json';
const DEFAULT_QUESTION_TIMEOUT_MS = 240_000;
const DEFAULT_MAX_RESULTS = 5;
// The product's own per-candidate budget, so the eval reads each item the way
// Ask does (rerun 16: at 1,500 a summary question's seat carried only a
// 455-character tail of the right item).
const DEFAULT_MAX_CHARS_PER_CANDIDATE = PRODUCT_MAX_CHARS_PER_CANDIDATE;
const DEFAULT_EMBEDDING_WARM_TIMEOUT_MS = 180_000;
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
  const storePaths = args.isolation ? undefined : evalDropboxStorePaths(process.env);
  if (storePaths && !existsSync(storePaths.secure)) {
    console.error(`No Dropbox connector store at ${storePaths.secure}. Set OLYMPUS_EVAL_DROPBOX_STORE to the store to evaluate.`);
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
  // A local Analyst leg sees the pack Ask fits to its prompt budget (the
  // same default and override Ask reads); a Venice leg is not fitted.
  const analystPromptByteBudget = analystProvider === 'local'
    ? parsePositiveIntegerEnv(
      process.env.OLYMPUS_SOURCE_INDEX_LOCAL_ANALYST_PROMPT_BYTES,
      DEFAULT_LOCAL_ANALYST_PROMPT_BYTES,
      'OLYMPUS_SOURCE_INDEX_LOCAL_ANALYST_PROMPT_BYTES',
    )
    : undefined;
  // Extra Analyst answers to each question's frozen pack, for the questions
  // named (all when none are): tells a steady misreading from a coin flip.
  const analystRepeats = parsePositiveIntegerEnv(process.env.OLYMPUS_EVAL_ANALYST_REPEATS, 1, 'OLYMPUS_EVAL_ANALYST_REPEATS');
  const analystRepeatQuestions = (process.env.OLYMPUS_EVAL_ANALYST_REPEAT_QUESTIONS ?? '')
    .split(',').map((id) => id.trim()).filter((id) => id.length > 0);
  // Run the Analyst once more on each question's expected seats alone, to
  // tell distraction by other seats from a misread document.
  const analystExpectedSeatOnly = process.env.OLYMPUS_EVAL_ANALYST_EXPECTED_SEAT_ONLY === '1';
  const reportConfig = {
    analystProvider,
    ...(analystExpectedSeatOnly ? { analystExpectedSeatOnly } : {}),
    ...(analystRepeats > 1 ? { analystRepeats, ...(analystRepeatQuestions.length > 0 ? { analystRepeatQuestions } : {}) } : {}),
    questionTimeoutMs,
    queryPlannerEnabled,
    maxResults,
    maxCharsPerCandidate,
    ...(analystPromptByteBudget !== undefined ? { analystPromptByteBudget } : {}),
  };
  if (internalQuestionIndex === undefined) {
    const informationalMaxResults = informationalEvalMaxResults(process.env.OLYMPUS_EVAL_INFORMATIONAL_MAX_RESULTS, maxResults);
    await runIsolatedEval({
      args,
      dataset: fullDataset,
      reportPath,
      config: reportConfig,
      ...(informationalMaxResults !== undefined ? { informationalMaxResults } : {}),
    });
    return;
  }
  const dataset: EvalDataset = {
    ...fullDataset,
    questions: [fullDataset.questions[internalQuestionIndex]!],
  };
  const config = loadConfig();

  const rootOpened = args.isolation ? openEvalDataRoot(args.isolation) : undefined;
  const opened = rootOpened ?? openEvalDropboxStores(storePaths!);
  let storesClosed = false;
  try {
  const scope = rootOpened ? {} : resolveEvalDropboxScope(account, approvedScopeKey);
  const embedding = await prepareEvalEmbedding({
    configured: await configuredEvalEmbedding(config, process.env),
    warmTimeoutMs: parsePositiveIntegerEnv(
      process.env.OLYMPUS_EVAL_EMBEDDING_WARM_TIMEOUT_SECONDS,
      DEFAULT_EMBEDDING_WARM_TIMEOUT_MS / 1000,
      'OLYMPUS_EVAL_EMBEDDING_WARM_TIMEOUT_SECONDS',
    ) * 1000,
  });
  const retrieval = {
    ...embedding.retrieval,
    corpora: opened.stores.map((store) => store.corpusId),
    tierLedger: (rootOpened ? rootOpened.scopes.length > 0 : ('ledger' in opened && opened.ledger)) ? 'bound' as const : 'absent' as const,
  };
  console.error(
    `eval retrieval: ${retrieval.note}; stores ${retrieval.corpora.join(', ')}; tier ledger ${retrieval.tierLedger}`,
  );
  // Each run evaluates one question, so every store search recorded is that question's.
  const storeSearches: EvalStoreSearch[] = [];
  const lanes = rootOpened ? createEvalSourceLanes({ ...rootOpened, embeddingFor: embedding.embeddingFor, onStoreSearch: (search) => storeSearches.push(search) }) : createEvalDropboxLanes({
    stores: opened.stores,
    ...('ledger' in opened && opened.ledger ? { ledger: opened.ledger } : {}),
    scope,
    embeddingFor: embedding.embeddingFor,
    onStoreSearch: (search) => storeSearches.push(search),
  });
  const model = createEvalAnalystModel({
    provider: analystProvider,
    config,
    env: process.env,
  });
  // Each run evaluates one question, so every prompt recorded here is that
  // question's: the answer-stage audit checks the values against it.
  const analystPrompts: string[] = [];
  const analystModelIds: string[] = [];
  const analyst = createAnalyst({
    async complete(request) {
      analystPrompts.push(request.prompt);
      const completion = await model.complete(request);
      analystModelIds.push(completion.modelId);
      return completion;
    },
  }, { auditSuspiciousDrafts: true });
  // Optional multi-query retrieval expansion over the same local Delphi lane:
  // useful for recall experiments, but disabled by default because it adds a
  // model call before every question and made the real eval too slow as a gate.
  const queryPlanner = queryPlannerEnabled ? createAnalystQueryPlanner(model) : undefined;
  // Off unless OLYMPUS_SOURCE_RERANKER=built-in names a reranker model
  // directory, so one corpus can be measured with and without it (issue #921).
  const reranker = await prepareBuiltInRerankerFromEnv();

  const detailsByPack = new WeakMap<object, EvidencePackBuildDetail>();
  const rawResultsByPack = new WeakMap<object, AnalystResult>();
  // The pack seats (1-based) the Analyst was actually sent, per pack.
  const analystSeatsByPack = new WeakMap<object, number[]>();
  // Where the bytes of the prompt each pack was sent as went.
  const promptLayoutByPack = new WeakMap<object, EvalPromptLayout>();
  const fittedAnalyst = promptFittedEvalAnalyst(
    analyst,
    analystPromptByteBudget,
    (pack) => detailsByPack.get(pack)?.candidateCorpusIds,
    (pack, seats, sent, analyzeOptions) => {
      analystSeatsByPack.set(pack, seats);
      promptLayoutByPack.set(pack, evalPromptLayout(sent, analyzeOptions));
    },
    (pack) => detailsByPack.get(pack)?.recencySeats,
  );
  const repeatsByPack = new WeakMap<object, { results: AnalystResult[]; failures: number }>();
  const repeatThisQuestion = analystRepeatQuestions.length === 0 || analystRepeatQuestions.includes(dataset.questions[0]!.id);
  // How many prompts and model ids the graded (first) answer recorded.
  let firstAnswer: { prompts: number; modelIds: number } | undefined;
  // The audit's prompt and model fields describe the graded answer only.
  const keepGradedAnswerRecords = () => {
    analystPrompts.splice(firstAnswer?.prompts ?? 0);
    analystModelIds.splice(firstAnswer?.modelIds ?? 0);
  };
  const gradedAnalyst: Analyst = {
    async analyze(pack, analyzeOptions) {
      const result = await fittedAnalyst.analyze(pack, analyzeOptions);
      firstAnswer ??= { prompts: analystPrompts.length, modelIds: analystModelIds.length };
      return result;
    },
  };
  const seatOnlyByPack = new WeakMap<object, { seats: number[]; alone: EvidencePack; result: AnalystResult | undefined; prompts: string[] }>();
  // The seats the grader counts as expected evidence, by its own matcher.
  const expectedSeatsOf = (pack: EvidencePack) => evalExpectedSeats(
    dataset.questions[0]!.expectedEvidence ?? [],
    pack,
    detailsByPack.get(pack)?.candidateCorpusIds ?? [],
  );
  const seatOnlyAnalyst = analystExpectedSeatOnly && repeatThisQuestion
    ? expectedSeatOnlyEvalAnalyst(
      gradedAnalyst,
      // Once per pack: a repeat of the same pack does not run it again.
      (pack) => seatOnlyByPack.has(pack) ? [] : expectedSeatsOf(pack),
      (pack, alone, result) => {
        seatOnlyByPack.set(pack, { seats: expectedSeatsOf(pack), alone, result, prompts: analystPrompts.slice(firstAnswer?.prompts ?? 0) });
        keepGradedAnswerRecords();
      },
      (pack) => detailsByPack.get(pack)?.candidateCorpusIds ?? [],
    )
    : gradedAnalyst;
  const repeatingAnalyst = repeatedEvalAnalyst(
    seatOnlyAnalyst,
    repeatThisQuestion ? analystRepeats - 1 : 0,
    (pack, results, failures) => {
      repeatsByPack.set(pack, { results, failures });
      keepGradedAnswerRecords();
    },
  );
  const traces: Array<PrecisionTrace & { retrieval?: EvalRetrievalAudit; answerStage?: EvalAnswerStageAudit }> = [];
  const evaluated = await runEval(dataset, {
    questionTimeoutMs,
    continueOnQuestionError: true,
    stopOnQuestionTimeout: true,
    async buildPack(question) {
      const detail = await buildEvalPack({
        question: question.question,
        lanes,
        ...(queryPlanner ? { queryPlanner } : {}),
        ...(reranker ? { reranker } : {}),
        maxResults,
        // Keep local-model prompts bounded for an eval gate. Truncation is
        // reported as a coverage gap; raise this only for targeted diagnosis.
        maxCharsPerCandidate,
      });
      detailsByPack.set(detail.pack, detail);
      return detail.pack;
    },
    analyst: repeatingAnalyst,
    releaseFor(pack, result) {
      rawResultsByPack.set(pack, result);
      const detail = detailsByPack.get(pack);
      return detail ? releaseEvalAnswer(detail, result) : undefined;
    },
    gradeContextFor(pack) {
      const detail = detailsByPack.get(pack);
      return detail ? { candidateCorpusIds: detail.candidateCorpusIds } : undefined;
    },
    trace(question, pack, result) {
      const detail = detailsByPack.get(pack);
      traces.push({
        ...classifyPrecisionStage(question, pack, result, {
          ...(detail ? { candidateCorpusIds: detail.candidateCorpusIds } : {}),
        }),
        ...(detail ? { retrieval: evalRetrievalAudit(detail, question, storeSearches) } : {}),
        answerStage: {
          ...evalAnswerStageAudit(question, pack, rawResultsByPack.get(pack), result, analystPrompts, analystModelIds, analystSeatsByPack.get(pack)),
          ...(repeatsByPack.has(pack)
            ? {
              answerRepeats: repeatsByPack.get(pack)!.results.map((repeat) => evalAnswerRepeat(question, pack, repeat)),
              ...(repeatsByPack.get(pack)!.failures > 0 ? { answerRepeatFailures: repeatsByPack.get(pack)!.failures } : {}),
            }
            : {}),
          ...(seatOnlyByPack.has(pack) ? { expectedSeatOnly: expectedSeatOnlyAudit(question, seatOnlyByPack.get(pack)!) } : {}),
          ...(promptLayoutByPack.has(pack) ? { promptLayout: promptLayoutByPack.get(pack)! } : {}),
        },
      });
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
        ...reportConfig,
        retrieval,
        reranker: reranker?.id ?? 'off',
      }, { partial: true });
    },
  });
  try { rootOpened?.checkFileDescriptors(); } finally { opened.close(); storesClosed = true; }
  // A question whose search lost a store or a lane to a deadline measured a
  // different system than the one under test: it fails, loudly (#1242).
  const report = failIncompleteRetrieval(evaluated, traces);
  for (const grade of report.grades) {
    for (const line of grade.detail.filter((entry) => entry.startsWith('retrieval_incomplete'))) {
      console.error(`EVAL RETRIEVAL INCOMPLETE ${grade.questionId}: ${line}`);
    }
  }
  writeEvalReport(reportPath, datasetPath, report, traces, {
    ...reportConfig,
    retrieval,
    reranker: reranker?.id ?? 'off',
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
  } finally {
    if (!storesClosed) {
      try { rootOpened?.checkFileDescriptors(); } finally { opened.close(); }
    }
  }
}

/**
 * Why a question's pack holds what it holds, counts and codes only (#1233):
 * every lane's candidates before and after its own filters, the corpora
 * skipped and why, the lanes that degraded, and the candidates dropped or
 * left unread. Rides on the question's precision trace into the report, so a
 * short run separates "retrieval found nothing" from "a filter or policy
 * removed what it found" without a per-stage diagnostic. The eval builds its
 * pack with every trust domain allowed, so the Private-exclusion rebuild an
 * ordinary route can run never applies here; `secureExclusion` says so.
 */
export interface EvalRetrievalAudit {
  packCandidates: number;
  /**
   * The store and trust domain of each pack candidate, in pack order: which
   * store won each seat. `expectedItem` is the 1-based expected-evidence entry
   * whose item id the seat holds, in whichever store, so a copy left in
   * another store is told apart from the copy the question expects.
   */
  packCandidateSources: Array<{
    corpusId: string;
    trustDomain: string;
    expectedItem?: number;
    /**
     * On a seat holding an expected item: the 0-based chunk of the item the
     * winning lane matched, when it names one. Passage selection starts from
     * it, so a summary question can seat the right item with a chunk that
     * lacks the asked-for value.
     */
    anchorChunkIndex?: number;
    /** On a seat holding an expected item: characters of the item the pack carries. */
    packChars?: number;
  }>;
  lanes: Array<{
    laneName: string;
    laneType: string;
    candidateCount: number;
    returnedCount: number;
    skippedReason?: string;
    bestCosine?: number;
    suppressedBelowBar?: number;
    elapsedMs?: number;
  }>;
  /** Each store's whole search: wall time, the adapter's own time, and whether it beat the deadline. */
  corpusTimings: Array<{ corpusId: string; elapsedMs: number; adapterReportedMs?: number; outcome: string }>;
  skippedCorpora: Array<{ corpusId: string; reason: string }>;
  degradations: Array<{ laneName: string; reason: string; detail?: string; occurrences: number }>;
  policyDeniedCandidates: number;
  unreadCandidates: number;
  namesOnlyCandidates: number;
  contentPrivateCandidates: number;
  corpusReadabilityGaps: number;
  secureExclusion: 'not_applied';
  /**
   * Where each store's own search ranked each expected item, before the pack
   * merged the stores: 1-based rank in that store's returned hits, -1 when the
   * store never returned it. `searches` counts the store's searches for the
   * question (each formulation is one). Tells "the store never found it"
   * apart from "it was found and lost in the merge". Absent when no store
   * search was recorded.
   */
  expectedStoreRanks?: Array<{ expectedItem: number; corpusId: string; searches: number; bestRank: number; hitsReturned: number }>;
}

/** Each store search's returned item ids, in order, as the eval lanes record them. */


export function evalRetrievalAudit(
  detail: EvidencePackBuildDetail,
  question?: Pick<EvalQuestion, 'expectedEvidence'>,
  storeSearches?: readonly EvalStoreSearch[],
): EvalRetrievalAudit {
  const expected = question?.expectedEvidence ?? [];
  const expectedStoreRanks = storeSearches && storeSearches.length > 0
    ? expected.flatMap((want, index) => {
      if (want.providerItemId === undefined) return [];
      const byCorpus = new Map<string, EvalStoreSearch[]>();
      for (const search of storeSearches) byCorpus.set(search.corpusId, [...(byCorpus.get(search.corpusId) ?? []), search]);
      return [...byCorpus].map(([corpusId, searches]) => {
        const ranks = searches.map((search) => search.providerItemIds.indexOf(want.providerItemId!) + 1).filter((rank) => rank > 0);
        return {
          expectedItem: index + 1,
          corpusId,
          searches: searches.length,
          bestRank: ranks.length > 0 ? Math.min(...ranks) : -1,
          hitsReturned: Math.max(...searches.map((search) => search.providerItemIds.length)),
        };
      });
    })
    : undefined;
  return {
    packCandidates: detail.pack.candidates.length,
    packCandidateSources: detail.pack.candidates.map((candidate, index) => {
      const itemId = candidate.provenance.sourceItem.providerItemId;
      const expectedIndex = expected.findIndex((want) => want.providerItemId !== undefined && want.providerItemId === itemId);
      return {
        corpusId: detail.candidateCorpusIds[index] ?? 'unknown',
        trustDomain: candidate.trustDomain,
        ...(expectedIndex >= 0 ? {
          expectedItem: expectedIndex + 1,
          ...(candidate.provenance.chunk?.chunkIndex !== undefined ? { anchorChunkIndex: candidate.provenance.chunk.chunkIndex } : {}),
          packChars: candidate.chunks.reduce((sum, chunk) => sum + chunk.length, 0),
        } : {}),
      };
    }),
    lanes: detail.laneAudits.map((lane) => ({
      laneName: lane.laneName,
      laneType: lane.laneType,
      candidateCount: lane.candidateCount,
      returnedCount: lane.returnedCount,
      ...(lane.skippedReason !== undefined ? { skippedReason: lane.skippedReason } : {}),
      ...(lane.bestCosine !== undefined ? { bestCosine: lane.bestCosine } : {}),
      ...(lane.suppressedBelowBar !== undefined ? { suppressedBelowBar: lane.suppressedBelowBar } : {}),
      ...(lane.elapsedMs !== undefined ? { elapsedMs: lane.elapsedMs } : {}),
    })),
    corpusTimings: (detail.corpusTimings ?? []).map((timing) => ({
      corpusId: timing.corpusId,
      elapsedMs: timing.elapsedMs,
      ...(timing.adapterReportedMs !== undefined ? { adapterReportedMs: timing.adapterReportedMs } : {}),
      outcome: timing.outcome,
    })),
    skippedCorpora: detail.skippedCorpora.map((skip) => ({ corpusId: skip.corpusId, reason: skip.reason })),
    degradations: detail.degradations.map((degradation) => ({
      laneName: degradation.laneName,
      reason: degradation.reason,
      ...(degradation.detail !== undefined ? { detail: degradation.detail } : {}),
      occurrences: degradation.occurrences,
    })),
    policyDeniedCandidates: detail.policyDeniedCandidates ?? 0,
    unreadCandidates: detail.unreadCandidates ?? 0,
    namesOnlyCandidates: detail.namesOnlyCandidateIndexes?.length ?? 0,
    contentPrivateCandidates: detail.contentPrivateCandidateIndexes?.length ?? 0,
    corpusReadabilityGaps: detail.corpusReadabilityGaps?.length ?? 0,
    secureExclusion: 'not_applied',
    ...(expectedStoreRanks ? { expectedStoreRanks } : {}),
  };
}

/**
 * Where each expected value was lost after retrieval (#1234), booleans only:
 * in the pack text the Analyst read, in the Analyst's own answer, and in the
 * answer the release step let out (what the grader sees). In the pack but not
 * in the Analyst's answer is an Analyst miss; in the Analyst's answer but not
 * the released one is the release step removing it.
 */
export interface EvalAnswerStageAudit {
  expected: Array<{
    /** In the pack by the grader's rules (whole token, not negated): what an answer would need. */
    inPack: boolean;
    /**
     * In the pack as a plain substring of any accepted form, the looser test
     * the precision trace uses. True here with inPack false means the value
     * only appears inside a longer token or number, or right after a negation
     * such as "no" or "not".
     */
    inPackAsSubstring: boolean;
    /** In the prompt the Analyst model was sent; absent when no prompt was recorded. */
    inAnalystPrompt?: boolean;
    inAnalystAnswer: boolean;
    inReleasedAnswer: boolean;
    /**
     * When the value is in the pack only inside a longer token: that token's
     * shape (digits to 9, letters to a, punctuation kept), never its text.
     */
    packTokenShape?: string;
    /** The same for the Analyst's answer, when it holds the value only inside a longer token. */
    answerTokenShape?: string;
    /**
     * Each 1-based pack seat holding a form of the value as a substring: the
     * value's character offset in the seat's excerpt (-1 when it is only in the
     * seat's citation, facts or tables) and the excerpt's length.
     */
    packSeats: Array<{ seat: number; charOffset: number; seatChars: number }>;
    /** The value's character offset in the prompt the Analyst model was sent, when it is there. */
    promptCharOffset?: number;
    /** Whether the Analyst's answer cites a seat holding the value. */
    valueSeatCited: boolean;
  }>;
  /**
   * The 1-based pack seats the Analyst's answer cites, in seat order. A wrong
   * value cited from the seat holding the right one is a misreading of that
   * document; one cited from another seat is the wrong document.
   */
  answerCitedSeats: number[];
  /** Citations naming no pack candidate. */
  answerCitationsOutsidePack: number;
  /** Whether the answer cites a seat holding an expected evidence item; absent when the question names none. */
  expectedSeatCited?: boolean;
  /**
   * Cited seats that hold no expected evidence item; absent when the question
   * names none. Informational: an answer citing every seat still cites the
   * expected one, and this shows the rest.
   */
  citedSeatsWithoutExpectedItem?: number;
  /**
   * The answer's number-bearing tokens (dates, amounts, identifiers with a
   * digit), and how many of them occur in a seat the answer cites. Fewer in
   * the cited seats than in the answer means the answer states a value its
   * citations do not hold.
   */
  answerValueTokens: number;
  answerValueTokensInCitedSeats: number;
  /**
   * The shape of each answer value token not found in a cited seat (digits
   * to 9, letters to a), so a run can tell a reformatted value from a wrong
   * one without carrying the value itself.
   */
  answerValueTokensUnmatchedShapes: string[];
  /** The pack seats the Analyst was sent, when a prompt budget fitted the pack (Ask's local leg). */
  analystSeats?: number[];
  /**
   * Further Analyst answers to the same frozen pack (OLYMPUS_EVAL_ANALYST_REPEATS),
   * by shape and flags only. The graded answer is the first one.
   */
  answerRepeats?: EvalAnswerRepeat[];
  /** Repeats whose Analyst call failed: diagnostics only, never the grade. */
  answerRepeatFailures?: number;
  /**
   * The Analyst on a pack of the expected seats alone
   * (OLYMPUS_EVAL_ANALYST_EXPECTED_SEAT_ONLY=1): the full pack's seats it held,
   * and that answer by shape and flags (its cited seats count within that
   * pack), or failed when the call failed. Diagnostics only, never the grade.
   */
  expectedSeatOnly?: { seats: number[]; prompts?: Array<{ chars: number; sha256: string }> } & (EvalAnswerRepeat | { failed: true });
  /**
   * The Analyst's own answer, by its structure: every expected value in it,
   * some, or none (with no citation: it said it found nothing; with
   * citations: it answered from other evidence). Absent with no expected values.
   */
  answerShape?: 'contains_all' | 'partial' | 'not_found' | 'other_answer';
  answerCitations: number;
  answerUnanswered: number;
  /** Characters of every prompt the Analyst model was sent for the question. */
  analystPromptChars?: number;
  /** The model id each Analyst model call reported, in call order. */
  analystModelIds?: readonly string[];
}

export interface EvalAnswerRepeat {
  answerShape?: EvalAnswerStageAudit['answerShape'];
  answerCitedSeats: number[];
  /** Per expected value, in order: is it in this answer. */
  valuesInAnswer: boolean[];
  answerValueTokens: number;
  answerValueTokensInCitedSeats: number;
  answerValueTokensUnmatchedShapes: string[];
}

/** One repeat answer to a frozen pack, by the answer-stage audit's own measures. */
export function evalAnswerRepeat(
  question: Pick<EvalQuestion, 'expectedAnswerContains'> & Partial<Pick<EvalQuestion, 'expectedEvidence'>>,
  pack: EvidencePack,
  result: AnalystResult,
): EvalAnswerRepeat {
  const audit = evalAnswerStageAudit(question, pack, result, result);
  return {
    ...(audit.answerShape ? { answerShape: audit.answerShape } : {}),
    answerCitedSeats: audit.answerCitedSeats,
    valuesInAnswer: audit.expected.map((value) => value.inAnalystAnswer),
    answerValueTokens: audit.answerValueTokens,
    answerValueTokensInCitedSeats: audit.answerValueTokensInCitedSeats,
    answerValueTokensUnmatchedShapes: audit.answerValueTokensUnmatchedShapes,
  };
}

/**
 * The 1-based pack seats holding expected evidence, by the grader's own
 * matcher (item id, locator, parent label and store, as the question gives).
 */
export function evalExpectedSeats(
  expected: readonly EvalExpectedEvidence[],
  pack: EvidencePack,
  candidateCorpusIds: readonly string[],
): number[] {
  return pack.candidates.flatMap((candidate, index) =>
    expected.some((want) => expectedEvidenceMatches(want, candidate.provenance, candidateCorpusIds[index]))
      ? [index + 1]
      : []);
}

/** The expected-seat-only answer, by the repeat audit's own measures. */
export function expectedSeatOnlyAudit(
  question: Pick<EvalQuestion, 'expectedAnswerContains'> & Partial<Pick<EvalQuestion, 'expectedEvidence'>>,
  run: { seats: number[]; alone: EvidencePack; result: AnalystResult | undefined; prompts?: readonly string[] },
): NonNullable<EvalAnswerStageAudit['expectedSeatOnly']> {
  // Each model prompt by length and a short hash, so two runs can tell
  // byte-identical prompts from different ones without carrying the text.
  const prompts = run.prompts && run.prompts.length > 0
    ? { prompts: run.prompts.map((prompt) => ({ chars: prompt.length, sha256: createHash('sha256').update(prompt).digest('hex').slice(0, 12) })) }
    : {};
  return run.result
    ? { seats: [...run.seats], ...prompts, ...evalAnswerRepeat(question, run.alone, run.result) }
    : { seats: [...run.seats], ...prompts, failed: true };
}

/**
 * The Analyst, run extraRuns more times on the same pack after its first
 * answer, so a run can tell a steady misreading from a coin flip on one
 * frozen pack. The first answer is the one graded and released; a repeat
 * that fails is counted, never allowed to fail the question.
 */
export function repeatedEvalAnalyst(
  analyst: Analyst,
  extraRuns: number,
  onRepeats: (pack: EvidencePack, results: AnalystResult[], failures: number) => void,
): Analyst {
  if (extraRuns <= 0) return analyst;
  return {
    async analyze(pack, analyzeOptions) {
      const first = await analyst.analyze(pack, analyzeOptions);
      const extra: AnalystResult[] = [];
      let failures = 0;
      for (let run = 0; run < extraRuns; run += 1) {
        try {
          extra.push(await analyst.analyze(pack, analyzeOptions));
        } catch {
          failures += 1;
        }
      }
      onRepeats(pack, extra, failures);
      return first;
    },
  };
}

/**
 * The Analyst, run once more after its graded answer on a pack holding only
 * the seats with the question's expected items (1-based, in pack order). Right
 * alone but wrong in the full pack means the other seats distract it; wrong
 * alone means it misreads that document as extracted. Nothing to run when no
 * expected item is seated; a failed call is reported as undefined, never the
 * grade.
 */
export function expectedSeatOnlyEvalAnalyst(
  analyst: Analyst,
  expectedSeats: (pack: EvidencePack) => readonly number[],
  onResult: (pack: EvidencePack, alone: EvidencePack, result: AnalystResult | undefined) => void,
  candidateCorpusIds: (pack: EvidencePack) => readonly string[] = () => [],
): Analyst {
  return {
    async analyze(pack, analyzeOptions) {
      const graded = await analyst.analyze(pack, analyzeOptions);
      const seats = new Set(expectedSeats(pack));
      if (seats.size === 0) return graded;
      const corpusIds = candidateCorpusIds(pack);
      const kept = pack.candidates.flatMap((candidate, index) => seats.has(index + 1) ? [{ candidate, corpusId: corpusIds[index] }] : []);
      if (kept.length === 0) return graded;
      // The pack's coverage restated for the seats it keeps, as Ask's own fit
      // does: a store's items in evidence are the seats it holds here.
      const inEvidence = new Map<string, number>();
      for (const { corpusId } of kept) if (corpusId !== undefined) inEvidence.set(corpusId, (inEvidence.get(corpusId) ?? 0) + 1);
      const alone: EvidencePack = {
        ...pack,
        candidates: kept.map(({ candidate }) => candidate),
        coverage: {
          ...pack.coverage,
          ...(pack.coverage.matchCounts
            ? { matchCounts: pack.coverage.matchCounts.map((count) => ({ ...count, inEvidence: inEvidence.get(count.corpusId) ?? 0 })) }
            : {}),
        },
      };
      let result: AnalystResult | undefined;
      try {
        result = await analyst.analyze(alone, analyzeOptions);
      } catch {
        result = undefined;
      }
      onResult(pack, alone, result);
      return graded;
    },
  };
}

/**
 * The text's distinct tokens, lowercased, with edge punctuation trimmed. Splits
 * on whitespace and on JSON quotes and brackets too, so a value inside a
 * serialized table or citation field is its own token.
 */
function textTokens(text: string): Set<string> {
  return new Set(text.toLowerCase().split(/[\s"[\]{}]+/u)
    .map((token) => token.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, ''))
    .filter((token) => token.length > 0));
}

/**
 * The answer's distinct number-bearing tokens (textTokens), without the seat
 * markers the Analyst writes inline ("[2]", "[1, 3]"): a marker names a seat
 * of this pack, not a value, and no seat's text holds it.
 */
function answerValueTokens(answer: string, seats: number): string[] {
  const withoutMarkers = answer.replace(/\[\s*(\d+(?:\s*,\s*\d+)*)\s*\]/gu, (marker, list: string) =>
    list.split(',').every((seat) => { const n = Number(seat); return n >= 1 && n <= seats; }) ? ' ' : marker);
  return [...textTokens(withoutMarkers)].filter((token) => /\p{N}/u.test(token));
}

/**
 * A seat's tokens as support for an answer value: its textTokens, plus the
 * forms a citation line shows the Analyst that whole tokens miss. The
 * full-format label prints the timestamp ("[2026-03-01T09:30:00.000Z]") and
 * the compact one its date ("date: 2026-03-01"), so a timestamp also supports
 * its date; a locator path also supports each of its segments (the file name),
 * and a file name also supports itself without its extension.
 */
function seatSupportTokens(text: string): Set<string> {
  const tokens = textTokens(text);
  for (const token of [...tokens]) {
    const parts = [token, ...(token.includes('/')
      ? token.split('/').map((segment) => segment.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '')).filter(Boolean)
      : [])];
    for (const part of parts) {
      tokens.add(part);
      const date = /^(\d{4}-\d{2}-\d{2})t\d/u.exec(part);
      if (date) tokens.add(date[1]!);
      // A file name without its extension is still the name. The extension
      // holds a letter, so a decimal ("4182.99") never supports its integer part.
      const stem = /^(.+)\.(?=\p{N}*\p{L})[\p{L}\p{N}]{1,5}$/u.exec(part);
      if (stem) tokens.add(stem[1]!);
    }
  }
  return tokens;
}

function tokenShape(token: string): string {
  return token.replace(/\p{N}/gu, '9').replace(/\p{L}/gu, 'a');
}

/** The first offset of any accepted form of the value in the text (case-insensitive), or -1. */
function valueOffset(value: string, text: string): number {
  const lower = text.toLowerCase();
  const offsets = acceptableForms(value).map((form) => lower.indexOf(form)).filter((at) => at >= 0);
  return offsets.length > 0 ? Math.min(...offsets) : -1;
}

/** The shape of the first token holding a form of the value as a substring (digits to 9, letters to a). */
function valueTokenShape(value: string, text: string): string | undefined {
  const lower = text.toLowerCase();
  for (const form of acceptableForms(value)) {
    const at = lower.indexOf(form);
    if (at < 0) continue;
    let start = at;
    let end = at + form.length;
    while (start > 0 && !/\s/.test(lower[start - 1]!)) start -= 1;
    while (end < lower.length && !/\s/.test(lower[end]!)) end += 1;
    const token = lower.slice(start, end).replace(/[.,;:!?)\]]+$/u, '').replace(/^[(\[]+/u, '');
    return token.replace(/\p{N}/gu, '9').replace(/\p{L}/gu, 'a');
  }
  return undefined;
}

export function evalAnswerStageAudit(
  question: Pick<EvalQuestion, 'expectedAnswerContains'> & Partial<Pick<EvalQuestion, 'expectedEvidence'>>,
  pack: EvidencePack,
  analystResult: AnalystResult | undefined,
  releasedResult: AnalystResult,
  analystPrompts?: readonly string[],
  analystModelIds?: readonly string[],
  analystSeats?: readonly number[],
): EvalAnswerStageAudit {
  // Every evidence field the Analyst can be shown: citation metadata
  // (title, locator, dates), chunk text, extracted facts and tables.
  const seatTexts = pack.candidates.map((candidate) => ({
    excerpt: candidate.chunks.join('\n'),
    all: [
      JSON.stringify(candidate.provenance.citation ?? {}),
      ...candidate.chunks,
      JSON.stringify(candidate.facts ?? []),
      JSON.stringify(candidate.tables ?? []),
    ].join('\n'),
  }));
  const packText = seatTexts.map((seat) => seat.all).join('\n');
  const promptText = analystPrompts && analystPrompts.length > 0 ? analystPrompts.join('\n') : undefined;
  const analystOwn = analystResult ?? releasedResult;
  // A citation names its seat by the candidate's own provenance, else by the item.
  const citationSeats = analystOwn.citations.map((citation) => {
    const exact = pack.candidates.findIndex((candidate) => candidate.provenance === citation.provenance);
    const index = exact >= 0 ? exact : pack.candidates.findIndex((candidate) =>
      candidate.provenance.sourceItem.localItemId === citation.provenance.sourceItem.localItemId);
    return index + 1;
  });
  const citedSeats = [...new Set(citationSeats.filter((seat) => seat > 0))].sort((left, right) => left - right);
  const expectedIds = (question.expectedEvidence ?? []).flatMap((want) => want.providerItemId !== undefined ? [want.providerItemId] : []);
  const expectedSeats = pack.candidates.flatMap((candidate, index) =>
    expectedIds.includes(candidate.provenance.sourceItem.providerItemId) ? [index + 1] : []);
  const valueTokens = answerValueTokens(analystOwn.answer, pack.candidates.length);
  // Whole tokens, so '41' is not supported by a seat that says '4182'.
  const citedTokens = seatSupportTokens(citedSeats.map((seat) => seatTexts[seat - 1]!.all).join('\n'));
  const values = question.expectedAnswerContains ?? [];
  const inAnswer = values.filter((value) => answerContainsExpectedValue(value, analystOwn.answer).matched).length;
  const answerShape = values.length === 0
    ? undefined
    : inAnswer === values.length ? 'contains_all' as const
      : inAnswer > 0 ? 'partial' as const
        : analystOwn.citations.length === 0 ? 'not_found' as const : 'other_answer' as const;
  return {
    ...(answerShape ? { answerShape } : {}),
    answerCitations: analystOwn.citations.length,
    answerUnanswered: analystOwn.unanswered.length,
    answerCitedSeats: citedSeats,
    answerCitationsOutsidePack: citationSeats.filter((seat) => seat === 0).length,
    ...(expectedIds.length > 0
      ? {
        expectedSeatCited: expectedSeats.some((seat) => citedSeats.includes(seat)),
        citedSeatsWithoutExpectedItem: citedSeats.filter((seat) => !expectedSeats.includes(seat)).length,
      }
      : {}),
    answerValueTokens: valueTokens.length,
    answerValueTokensInCitedSeats: valueTokens.filter((token) => citedTokens.has(token)).length,
    answerValueTokensUnmatchedShapes: valueTokens.filter((token) => !citedTokens.has(token)).map(tokenShape),
    ...(analystSeats ? { analystSeats: [...analystSeats] } : {}),
    ...(promptText !== undefined ? { analystPromptChars: analystPrompts!.reduce((sum, prompt) => sum + prompt.length, 0) } : {}),
    ...(analystModelIds && analystModelIds.length > 0 ? { analystModelIds: [...analystModelIds] } : {}),
    expected: (question.expectedAnswerContains ?? []).map((value) => ({
      inPack: answerContainsExpectedValue(value, packText).matched,
      inPackAsSubstring: acceptableForms(value).some((form) => packText.toLowerCase().includes(form)),
      ...(promptText !== undefined ? { inAnalystPrompt: answerContainsExpectedValue(value, promptText).matched } : {}),
      inAnalystAnswer: answerContainsExpectedValue(value, (analystResult ?? releasedResult).answer).matched,
      inReleasedAnswer: answerContainsExpectedValue(value, releasedResult.answer).matched,
    })).map((entry, index) => {
      const value = question.expectedAnswerContains![index]!;
      const analystAnswer = (analystResult ?? releasedResult).answer;
      const packShape = !entry.inPack && entry.inPackAsSubstring ? valueTokenShape(value, packText) : undefined;
      const answerToken = !entry.inAnalystAnswer ? valueTokenShape(value, analystAnswer) : undefined;
      const packSeats = seatTexts.flatMap((seat, index) => valueOffset(value, seat.all) < 0
        ? []
        : [{ seat: index + 1, charOffset: valueOffset(value, seat.excerpt), seatChars: seat.excerpt.length }]);
      const promptCharOffset = promptText !== undefined ? valueOffset(value, promptText) : -1;
      return {
        ...entry,
        ...(packShape !== undefined ? { packTokenShape: packShape } : {}),
        ...(answerToken !== undefined ? { answerTokenShape: answerToken } : {}),
        packSeats,
        ...(promptCharOffset >= 0 ? { promptCharOffset } : {}),
        valueSeatCited: packSeats.some((seat) => citedSeats.includes(seat.seat)),
      };
    }),
  };
}

/**
 * Why a question's retrieval did not run whole, if it did not: a store
 * dropped at the lane deadline, or a lane inside a store that stopped at its
 * deadline. Empty when every searched store and lane completed.
 */
export function incompleteRetrievalReasons(audit: EvalRetrievalAudit): string[] {
  const reasons = new Set<string>();
  for (const skip of audit.skippedCorpora) {
    if (skip.reason === 'lane_timeout') reasons.add(`${skip.corpusId} store dropped: lane_timeout`);
  }
  for (const lane of audit.lanes) {
    if (lane.skippedReason && /deadline|timeout|timed_out/.test(lane.skippedReason)) {
      reasons.add(`${lane.laneName} lane skipped: ${lane.skippedReason}`);
    }
  }
  return [...reasons];
}

/** Fails each question whose retrieval was incomplete, naming why, and recounts. */
export function failIncompleteRetrieval<R extends EvalReport>(
  report: R,
  traces: ReadonlyArray<{ questionId: string; retrieval?: EvalRetrievalAudit }>,
): R {
  const grades = report.grades.map((grade) => {
    const audit = traces.find((trace) => trace.questionId === grade.questionId)?.retrieval;
    const reasons = audit ? incompleteRetrievalReasons(audit) : [];
    if (reasons.length === 0) return grade;
    return {
      ...grade,
      passed: false,
      detail: [...grade.detail, ...reasons.map((reason) => `retrieval_incomplete: ${reason}`)],
    };
  });
  const passed = grades.filter((grade) => grade.passed).length;
  return { ...report, grades, passed, failed: report.total - passed };
}

/**
 * Where the bytes of the Analyst's prompt go, for the pack as sent: the
 * text every prompt carries (system rules, question, coverage), each seat's
 * header (name, trust, provenance and citation labels) and each seat's
 * passages, plus what the same seats would cost in the compact evidence
 * format. Byte counts only, never text.
 */
export interface EvalPromptLayout {
  promptBytes: number;
  fixedBytes: number;
  seats: Array<{ headerBytes: number; passageBytes: number }>;
  compactPromptBytes: number;
}

export function evalPromptLayout(sent: EvidencePack, options: AnalystOptions): EvalPromptLayout {
  const bytes = (candidates: EvidencePack['candidates']) => analystPromptBytes({ ...sent, candidates }, options);
  const fixedBytes = bytes([]);
  return {
    promptBytes: analystPromptBytes(sent, options),
    fixedBytes,
    seats: sent.candidates.map((candidate) => {
      const header = bytes([{ ...candidate, chunks: [] }]);
      return { headerBytes: header - fixedBytes, passageBytes: bytes([candidate]) - header };
    }),
    compactPromptBytes: analystPromptBytes(sent, options, 'compact'),
  };
}

/**
 * The Analyst as Ask's local leg runs it: the pack fitted to the leg's prompt
 * budget (fitPackToPromptBytes, Ask's own fit), or sent whole without a
 * budget. Told the 1-based pack seats each Analyst call was sent.
 */
export function promptFittedEvalAnalyst(
  analyst: Analyst,
  promptByteBudget: number | undefined,
  candidateCorpusIds: (pack: EvidencePack) => readonly string[] | undefined,
  onSeats: (pack: EvidencePack, seats: number[], sent: EvidencePack, analyzeOptions: AnalystOptions) => void,
  recencySeats: (pack: EvidencePack) => number | undefined = () => undefined,
): Analyst {
  return {
    analyze(pack, analyzeOptions) {
      const corpusIds = candidateCorpusIds(pack);
      const sent = promptByteBudget === undefined || !corpusIds
        ? pack
        : fitPackToPromptBytes(
          pack,
          promptByteBudget,
          new Map(pack.candidates.map((candidate, index) => [candidate, corpusIds[index] ?? ''] as const)),
          analyzeOptions,
          recencySeats(pack),
        );
      onSeats(pack, sent.candidates.map((candidate) =>
        pack.candidates.findIndex((original) => original.provenance === candidate.provenance) + 1), sent, analyzeOptions ?? {});
      return analyst.analyze(sent, analyzeOptions);
    },
  };
}

/** The answer as the live release step lets it out, with the gaps it carries. */
export function releaseEvalAnswer(
  detail: EvidencePackBuildDetail,
  result: AnalystResult,
): { result: AnalystResult; audit: OpsecReleaseAudit } {
  const release = releaseAnalystAnswer({
    detail,
    result,
    releaseSecureContent: true, // the eval asks explicitly, like an owner ask
  });
  return { result: releasedEvalResult(result, release), audit: release.opsec };
}

/**
 * What the grader sees: the released answer, its citations when released,
 * and the release's own notes as `unanswered`, read from the structured
 * outcome rather than parsed out of the answer text.
 */
export function releasedEvalResult(result: AnalystResult, release: AnalystReleaseOutcome): AnalystResult {
  const released = release.decision.decision === 'allow' || release.decision.decision === 'redact';
  return {
    ...result,
    answer: release.answer,
    citations: released ? result.citations : [],
    unanswered: released ? [...release.unanswered] : [],
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
    analystPromptByteBudget?: number;
  };
  informationalMaxResults?: number;
}

interface RealEvalReportEnvelope {
  report: EvalReport;
  retrieval?: EvalReportRetrieval;
  precision?: { traces?: PrecisionTrace[] };
}

/** How each question's retrieval ran, as the run output says it. */
export interface EvalReportRetrieval extends EvalRetrievalMode {
  corpora: string[];
  tierLedger: 'bound' | 'absent';
}

/**
 * The pack size of the second, informational score: Ask's own default
 * (rerun 20: the gate stays at the eval's seats; the second score shows the
 * same questions at the product's). 0 turns it off; the gate's own size, or
 * an unset gate, needs no second pass.
 */
export function informationalEvalMaxResults(value: string | undefined, gateMaxResults: number): number | undefined {
  const parsed = value?.trim() ? Number(value.trim()) : PRODUCT_MAX_RESULTS;
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error('OLYMPUS_EVAL_INFORMATIONAL_MAX_RESULTS must be a whole number (0 turns the second score off).');
  }
  return parsed === 0 || parsed === gateMaxResults ? undefined : parsed;
}

interface IsolatedPass {
  grades: EvalGrade[];
  timings: EvalQuestionTiming[];
  traces: PrecisionTrace[];
  retrieval?: EvalReportRetrieval;
}

/** Every question in its own process, in order, stopping at the first timeout. */
async function runIsolatedPass(
  input: IsolatedEvalInput,
  label: string,
  env: Record<string, string>,
  onQuestion?: (pass: IsolatedPass) => void,
): Promise<IsolatedPass> {
  const pass: IsolatedPass = { grades: [], timings: [], traces: [] };
  const scriptPath = fileURLToPath(import.meta.url);
  const total = input.dataset.questions.length;
  for (const [index, question] of input.dataset.questions.entries()) {
    const childReportPath = `${input.reportPath}.${label}-question-${index + 1}-${process.pid}.json`;
    rmSync(childReportPath, { force: true });
    const timeoutMs = effectiveIsolatedQuestionTimeoutMs(input.config.questionTimeoutMs, question);
    console.error(`eval ${label} question ${index + 1}/${total} started: ${question.id} (${question.shape})`);
    const result = await runBoundedEvalProcess({
      command: [
        process.execPath,
        scriptPath,
        input.args.datasetPath,
        '--analyst-provider',
        input.args.analystProvider,
        ...dataRootArgv(input.args.isolation),
      ],
      env: {
        ...process.env,
        ...env,
        [INTERNAL_QUESTION_INDEX_ENV]: String(index),
        OLYMPUS_EVAL_REPORT_PATH: childReportPath,
      },
      timeoutMs,
      stdout: 'ignore',
      stderr: 'inherit',
    });
    let timedOut = false;
    if (result.timedOut) {
      timedOut = true;
      pass.grades.push(isolatedFailureGrade(question, 'timeout'));
      pass.timings.push(isolatedFailureTiming(question, result.durationMs, 'timeout'));
      console.error(`eval ${label} question ${index + 1}/${total} timeout: ${question.id} (${result.durationMs}ms)`);
    } else if (existsSync(childReportPath)) {
      const envelope = JSON.parse(readFileSync(childReportPath, 'utf8')) as RealEvalReportEnvelope;
      const grade = envelope.report.grades[0];
      const timing = envelope.report.timings[0];
      if (grade && timing) {
        pass.grades.push(grade);
        pass.timings.push(timing);
        pass.traces.push(...(envelope.precision?.traces ?? []));
        if (envelope.retrieval) pass.retrieval ??= envelope.retrieval;
      } else {
        pass.grades.push(isolatedFailureGrade(question, 'child_report_incomplete'));
        pass.timings.push(isolatedFailureTiming(question, result.durationMs, 'error'));
      }
    } else {
      pass.grades.push(isolatedFailureGrade(question, `child_exit_${result.exitCode}`));
      pass.timings.push(isolatedFailureTiming(question, result.durationMs, 'error'));
    }
    rmSync(childReportPath, { force: true });
    onQuestion?.(pass);
    if (timedOut) break;
  }
  return pass;
}

async function runIsolatedEval(input: IsolatedEvalInput): Promise<void> {
  const total = input.dataset.questions.length;
  const write = (gate: IsolatedPass, partial: boolean, informational?: { maxResults: number; pass: IsolatedPass }) => writeEvalReport(
    input.reportPath,
    input.args.datasetPath,
    evalReportFromParts(total, gate.grades, gate.timings),
    gate.traces,
    { ...input.config, ...(gate.retrieval ? { retrieval: gate.retrieval } : {}) },
    { partial },
    informational ? {
      maxResults: informational.maxResults,
      report: evalReportFromParts(total, informational.pass.grades, informational.pass.timings),
      traces: informational.pass.traces,
    } : undefined,
  );
  const gate = await runIsolatedPass(input, 'gate', {}, (pass) => write(pass, true));
  const report = evalReportFromParts(total, gate.grades, gate.timings);
  let informational: { maxResults: number; pass: IsolatedPass } | undefined;
  if (input.informationalMaxResults !== undefined && report.remaining === 0) {
    const maxResults = input.informationalMaxResults;
    informational = {
      maxResults,
      pass: await runIsolatedPass(input, `informational-${maxResults}`, { OLYMPUS_EVAL_MAX_RESULTS: String(maxResults) },
        (pass) => write(gate, true, { maxResults, pass })),
    };
  }
  write(gate, report.remaining > 0 || (informational !== undefined && informational.pass.grades.length < total), informational);
  console.log(JSON.stringify(report, null, 2));
  console.error(`held-out eval: ${report.passed}/${report.total} passed`);
  if (informational) {
    const second = evalReportFromParts(total, informational.pass.grades, informational.pass.timings);
    console.error(`informational at ${informational.maxResults} seats: ${second.passed}/${second.total} passed (not the gate)`);
  }
  if (gate.retrieval) console.error(`retrieval: ${gate.retrieval.note}; stores ${gate.retrieval.corpora.join(', ')}`);
  console.error('\nprecision trace (where the needle was lost):');
  for (const trace of gate.traces) {
    console.error(
      `  ${trace.questionId.padEnd(20)} ${trace.stage.padEnd(16)} rank=${trace.bestRank} cands=${trace.candidateCount}  ${trace.note}`,
    );
  }
  console.error(`\nlever attribution: ${summarizePrecisionTraces(gate.traces).recommendation}`);
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
): { datasetPath: string; analystProvider: EvalAnalystProvider; isolation?: EvalDataRootOptions } {
  const offline = parseDataRootArgs(argv);
  argv = offline.rest;
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
    ...(offline.isolation ? { isolation: offline.isolation } : {}),
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
    analystPromptByteBudget?: number;
    retrieval?: EvalReportRetrieval;
    reranker?: string;
  },
  options: { partial: boolean },
  /** The second, informational score at another pack size: never the gate. */
  informational?: { maxResults: number; report: Awaited<ReturnType<typeof runEval>>; traces: readonly PrecisionTrace[] },
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
      ...(config.analystPromptByteBudget !== undefined ? { analystPromptByteBudget: config.analystPromptByteBudget } : {}),
      ...(config.retrieval ? { retrieval: config.retrieval } : {}),
      ...(config.reranker ? { reranker: config.reranker } : {}),
      report,
      precision: {
        traces,
        summary: summarizePrecisionTraces(traces),
      },
      ...(informational ? {
        informational: {
          maxResults: informational.maxResults,
          note: 'Not the gate: the same questions at another pack size.',
          report: informational.report,
          precision: { traces: informational.traces, summary: summarizePrecisionTraces(informational.traces) },
        },
      } : {}),
      writtenAt: new Date().toISOString(),
    }, null, 2)}\n`,
  );
}

if (import.meta.main) {
  await main();
}
