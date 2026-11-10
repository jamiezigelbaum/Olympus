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

import { builtInRerankerFromEnv } from '../src/workers/source-index/built-in-reranker.ts';
import type { EvidenceReranker } from '../src/core/evidence-reranker.ts';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createAnalyst, type AnalystModel } from '../src/core/analyst.ts';
import { resolvedStorePath } from '../src/core/source-placement.ts';
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
import { createAnalystQueryPlanner, type AnalystQueryPlanner } from '../src/core/query-planner.ts';
import {
  buildSourceIndexCorpusRegistry,
  defineSourceIndexCorpus,
} from '../src/core/source-index/corpus.ts';
import { LocalConnectorStore } from '../src/workers/connector-store/index.ts';
import { DROPBOX_APPROVED_SCOPE_FILTER_CODEC } from '../src/workers/dropbox-files/index.ts';
import {
  releaseAnalystAnswer,
  type AnalystAnswerLanes,
  type AnalystReleaseOutcome,
} from '../src/workers/source-index/analyst-answer.ts';
import type { AnalystResult, EvidencePack } from '../src/core/contracts.ts';
import type { OpsecReleaseAudit } from '../src/core/opsec.ts';
import type { SourceTrustDomain } from '../src/core/source-index/types.ts';
import { TierLedger } from '../src/workers/classification/tier-ledger.ts';
import { createParentLabelResolver } from '../src/workers/connector-store/parent-label.ts';
import { tieredStoreSetLedgerPath } from '../src/workers/connector-store/tiered-store-set.ts';
import { createTierVisibilityGate } from '../src/workers/connector-store/tier-visibility.ts';
import { DROPBOX_TIER_CORPUS_IDS } from '../src/workers/dropbox-files/connector-store.ts';
import { createSourceAnswerLanes } from '../src/workers/email-source/source-answer-lanes.ts';
import {
  BuiltInSourceEmbeddingProvider,
  loadedBuiltInEmbedding,
} from '../src/workers/source-index/built-in-embedding/provider.ts';
import {
  builtInEmbeddingPaths,
  installedBuiltInEmbedding,
} from '../src/workers/source-index/built-in-embedding/assets.ts';
import { builtInEmbeddingModel } from '../src/workers/source-index/built-in-embedding/manifest.ts';
import type { SourceEmbeddingProvider } from '../src/workers/source-index/embeddings.ts';
import { localAnswerRequest } from '../src/workers/source-index/local-answer.ts';
import { acceptableForms, answerContainsExpectedValue, type EvalGrade } from './grade.ts';
import { runEval, type EvalQuestionTiming, type EvalReport } from './run.ts';
import { classifyPrecisionStage, summarizePrecisionTraces, type PrecisionTrace } from './diagnose.ts';
import { runBoundedEvalProcess } from './process-boundary.ts';
import type { EvalDataset, EvalQuestion } from './types.ts';

const DEFAULT_DATASET_PATH = 'eval/private/held-out.real.json';
const DEFAULT_REPORT_PATH = 'eval/private/report.latest.json';
const DEFAULT_QUESTION_TIMEOUT_MS = 240_000;
const DEFAULT_MAX_RESULTS = 5;
const DEFAULT_MAX_CHARS_PER_CANDIDATE = 1_500;
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
  const storePaths = evalDropboxStorePaths(process.env);
  if (!existsSync(storePaths.secure)) {
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

  const opened = openEvalDropboxStores(storePaths);
  const scope = resolveEvalDropboxScope(account, approvedScopeKey);
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
    tierLedger: opened.ledger ? 'bound' as const : 'absent' as const,
  };
  console.error(
    `eval retrieval: ${retrieval.note}; stores ${retrieval.corpora.join(', ')}; tier ledger ${retrieval.tierLedger}`,
  );
  const lanes = createEvalDropboxLanes({
    stores: opened.stores,
    ...(opened.ledger ? { ledger: opened.ledger } : {}),
    scope,
    embeddingFor: embedding.embeddingFor,
  });
  const model = createEvalAnalystModel({
    provider: analystProvider,
    config,
    env: process.env,
  });
  // Each run evaluates one question, so every prompt recorded here is that
  // question's: the answer-stage audit checks the values against it.
  const analystPrompts: string[] = [];
  const analyst = createAnalyst({
    complete(request) {
      analystPrompts.push(request.prompt);
      return model.complete(request);
    },
  }, { auditSuspiciousDrafts: true });
  // Optional multi-query retrieval expansion over the same local Delphi lane:
  // useful for recall experiments, but disabled by default because it adds a
  // model call before every question and made the real eval too slow as a gate.
  const queryPlanner = queryPlannerEnabled ? createAnalystQueryPlanner(model) : undefined;
  // Off unless OLYMPUS_SOURCE_RERANKER=built-in names a reranker model
  // directory, so one corpus can be measured with and without it (issue #921).
  const reranker = builtInRerankerFromEnv();

  const detailsByPack = new WeakMap<object, EvidencePackBuildDetail>();
  const rawResultsByPack = new WeakMap<object, AnalystResult>();
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
    analyst,
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
        ...(detail ? { retrieval: evalRetrievalAudit(detail, question) } : {}),
        answerStage: evalAnswerStageAudit(question, pack, rawResultsByPack.get(pack), result, analystPrompts),
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
  opened.close();
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

/** Where the eval finds each Dropbox tier store and the source's tier ledger. */
export interface EvalDropboxStorePaths {
  secure: string;
  personal?: string;
  public?: string;
  /** The set ledger; default beside the Private store, where the lane keeps it. */
  ledger?: string;
}

export function evalDropboxStorePaths(env: Record<string, string | undefined>): EvalDropboxStorePaths {
  const secure = env.OLYMPUS_EVAL_DROPBOX_STORE?.trim() || resolvedStorePath('dropbox.files', 'secure_local');
  return {
    secure,
    personal: env.OLYMPUS_EVAL_DROPBOX_PERSONAL_STORE?.trim() || resolvedStorePath('dropbox.files', 'internal', env),
    public: env.OLYMPUS_EVAL_DROPBOX_PUBLIC_STORE?.trim() || resolvedStorePath('dropbox.files', 'public_safe', env),
    ledger: env.OLYMPUS_EVAL_DROPBOX_LEDGER?.trim() || tieredStoreSetLedgerPath(secure),
  };
}

export interface EvalDropboxStores {
  /** Every tier store that exists, opened query-only. */
  stores: LocalConnectorStore[];
  /** The set ledger, read-only, when it exists. */
  ledger?: TierLedger;
  close(): void;
}

/**
 * Opens every Dropbox tier store that exists, query-only. A store bound to
 * the set ledger judges what it serves by that ledger itself; the ledger
 * opened here feeds the same visibility gate live Ask applies over the hits.
 */
export function openEvalDropboxStores(
  paths: EvalDropboxStorePaths,
  /** Filled with each open's milliseconds, keyed by corpus id or 'ledger' (store probe). */
  openMs?: Record<string, number>,
): EvalDropboxStores {
  const files: Array<[SourceTrustDomain, string | undefined]> = [
    ['secure_local', paths.secure],
    ['internal', paths.personal],
    ['public_safe', paths.public],
  ];
  const stores: LocalConnectorStore[] = [];
  for (const [trustDomain, dbPath] of files) {
    const corpusId = DROPBOX_TIER_CORPUS_IDS[trustDomain];
    if (!corpusId || !dbPath || !existsSync(dbPath)) continue;
    const startedAt = performance.now();
    stores.push(new LocalConnectorStore({
      dbPath,
      corpusId,
      family: 'file',
      trustDomain,
      readOnly: true,
    }));
    if (openMs) openMs[corpusId] = Math.round(performance.now() - startedAt);
  }
  const ledgerPath = paths.ledger ?? tieredStoreSetLedgerPath(paths.secure);
  const ledgerStartedAt = performance.now();
  const ledger = existsSync(ledgerPath) ? new TierLedger({ dbPath: ledgerPath, readOnly: true }) : undefined;
  if (openMs && ledger) openMs.ledger = Math.round(performance.now() - ledgerStartedAt);
  return {
    stores,
    ...(ledger ? { ledger } : {}),
    close() {
      for (const store of stores) store.close();
      ledger?.close();
    },
  };
}

/**
 * The answer lanes over the eval's stores, built by the same factory live
 * answers use (email-source/source-answer-lanes.ts) in its on-this-computer
 * mode: a store's vector lane runs only with the built-in model this process
 * holds loaded, and otherwise searches by keyword.
 */
export function createEvalDropboxLanes(input: {
  stores: readonly LocalConnectorStore[];
  ledger?: TierLedger;
  scope: { accountScope?: string; locatorPathScope?: string };
  embeddingFor?: (trustDomain: SourceTrustDomain) => SourceEmbeddingProvider | undefined;
  localEmbedding?: (provider: SourceEmbeddingProvider) => SourceEmbeddingProvider | undefined;
}): (question: string) => AnalystAnswerLanes {
  const stores = () => input.stores;
  const scopes = () => (input.ledger
    ? [{ ledger: input.ledger, corpusIds: new Set(input.stores.map((store) => store.corpusId)), stores }]
    : []);
  const filters = input.scope.locatorPathScope
    ? { provider: 'dropbox', locatorPathScope: input.scope.locatorPathScope }
    : undefined;
  const lanes = createSourceAnswerLanes({
    stores,
    registry: () => buildSourceIndexCorpusRegistry(input.stores.map((store) => defineSourceIndexCorpus({
      corpusId: store.corpusId,
      family: store.family,
      trustDomain: store.trustDomain,
    }))),
    embeddingProvider: (store) => input.embeddingFor?.(store.trustDomain),
    localEmbedding: input.localEmbedding ?? loadedBuiltInEmbedding,
    readScope: () => ({
      allowed: true,
      contentAllowed: true,
      ...(input.scope.accountScope ? { accountScope: input.scope.accountScope } : {}),
      ...(filters ? { filters, contentFilters: filters } : {}),
    }),
    answerScope: () => ({ kind: 'search' }),
    accountScope: () => input.scope.accountScope,
    visibilityGate: createTierVisibilityGate(scopes),
    parentLabels: createParentLabelResolver({ stores, scopes }),
  });
  return (question) => lanes(localAnswerRequest(question), 'built_in_only');
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
  packCandidateSources: Array<{ corpusId: string; trustDomain: string; expectedItem?: number }>;
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
}

export function evalRetrievalAudit(
  detail: EvidencePackBuildDetail,
  question?: Pick<EvalQuestion, 'expectedEvidence'>,
): EvalRetrievalAudit {
  const expected = question?.expectedEvidence ?? [];
  return {
    packCandidates: detail.pack.candidates.length,
    packCandidateSources: detail.pack.candidates.map((candidate, index) => {
      const itemId = candidate.provenance.sourceItem.providerItemId;
      const expectedIndex = expected.findIndex((want) => want.providerItemId !== undefined && want.providerItemId === itemId);
      return {
        corpusId: detail.candidateCorpusIds[index] ?? 'unknown',
        trustDomain: candidate.trustDomain,
        ...(expectedIndex >= 0 ? { expectedItem: expectedIndex + 1 } : {}),
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
  }>;
}

export function evalAnswerStageAudit(
  question: Pick<EvalQuestion, 'expectedAnswerContains'>,
  pack: EvidencePack,
  analystResult: AnalystResult | undefined,
  releasedResult: AnalystResult,
  analystPrompts?: readonly string[],
): EvalAnswerStageAudit {
  // Every evidence field the Analyst can be shown: citation metadata
  // (title, locator, dates), chunk text, extracted facts and tables.
  const packText = pack.candidates.map((candidate) => [
    JSON.stringify(candidate.provenance.citation ?? {}),
    ...candidate.chunks,
    JSON.stringify(candidate.facts ?? []),
    JSON.stringify(candidate.tables ?? []),
  ].join('\n')).join('\n');
  const promptText = analystPrompts && analystPrompts.length > 0 ? analystPrompts.join('\n') : undefined;
  return {
    expected: (question.expectedAnswerContains ?? []).map((value) => ({
      inPack: answerContainsExpectedValue(value, packText).matched,
      inPackAsSubstring: acceptableForms(value).some((form) => packText.toLowerCase().includes(form)),
      ...(promptText !== undefined ? { inAnalystPrompt: answerContainsExpectedValue(value, promptText).matched } : {}),
      inAnalystAnswer: answerContainsExpectedValue(value, (analystResult ?? releasedResult).answer).matched,
      inReleasedAnswer: answerContainsExpectedValue(value, releasedResult.answer).matched,
    })),
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

/** One question's evidence pack, over the eval's lanes, as live Ask builds it. */
export function buildEvalPack(input: {
  question: string;
  lanes: (question: string) => AnalystAnswerLanes;
  queryPlanner?: AnalystQueryPlanner;
  reranker?: EvidenceReranker;
  maxResults: number;
  maxCharsPerCandidate: number;
}): Promise<EvidencePackBuildDetail> {
  const lanes = input.lanes(input.question);
  return buildEvidencePackDetailed({
    question: input.question,
    ...(input.queryPlanner ? { queryPlanner: input.queryPlanner } : {}),
    ...(input.reranker ? { reranker: input.reranker } : {}),
    maxResults: input.maxResults,
    maxCharsPerCandidate: input.maxCharsPerCandidate,
    searchContext: {
      allowedTrustDomains: ['public_safe', 'internal', 'secure_local'],
    },
    registry: lanes.registry,
    adapters: lanes.adapters,
    contentProviders: lanes.contentProviders,
    ...(lanes.visibilityGate ? { visibilityGate: lanes.visibilityGate } : {}),
    ...(lanes.secretLocations ? { secretLocations: lanes.secretLocations } : {}),
    ...(lanes.classificationCoverage ? { classificationCoverage: lanes.classificationCoverage } : {}),
    ...(lanes.parentLabels ? { parentLabels: lanes.parentLabels } : {}),
  });
}

export interface EvalRetrievalMode {
  mode: 'hybrid' | 'keyword';
  /** The built-in model that ran, when hybrid. */
  modelId?: string;
  /** One line for the run output and report. */
  note: string;
}

/**
 * The built-in embedding model, loaded, when the install has it; keyword
 * search otherwise, with the reason. Never downloads a model: a model that
 * was never installed leaves the eval on keyword search.
 */
export async function prepareEvalEmbedding(input: {
  configured: Partial<Record<SourceTrustDomain, SourceEmbeddingProvider>>;
  /** Thrown or unset configuration, said in the note. */
  configurationError?: string;
  warmTimeoutMs?: number;
  /** Where the built-in model's files are looked for. Default: this process's environment. */
  env?: Record<string, string | undefined>;
}): Promise<{ retrieval: EvalRetrievalMode; embeddingFor: (trustDomain: SourceTrustDomain) => SourceEmbeddingProvider | undefined }> {
  const keyword = (reason: string) => ({
    retrieval: { mode: 'keyword' as const, note: `keyword search only (${reason})` },
    embeddingFor: () => undefined,
  });
  if (input.configurationError) return keyword(`embedding configuration unreadable: ${input.configurationError}`);
  const configured = Object.values(input.configured).filter((provider): provider is SourceEmbeddingProvider => provider !== undefined);
  if (configured.length === 0) return keyword('no embedding model is configured');
  const builtIn = [...new Set(configured.filter((provider) => provider instanceof BuiltInSourceEmbeddingProvider))] as BuiltInSourceEmbeddingProvider[];
  if (builtIn.length === 0) return keyword('the configured embedding model is not the built-in one');
  for (const provider of builtIn) {
    const status = provider.status();
    if (status.state !== 'ready' && status.previouslyReady !== true) {
      return keyword(`built-in embedding model ${provider.modelId} is not installed (${status.state})`);
    }
    // Loading runs the installer, which downloads whatever is missing: a
    // status file that outlived its files must not start a download.
    if (!builtInEmbeddingFilesPresent(provider.modelId, input.env ?? process.env)) {
      return keyword(`built-in embedding model ${provider.modelId} files are missing`);
    }
    try {
      await withTimeout(provider.warm(), input.warmTimeoutMs ?? DEFAULT_EMBEDDING_WARM_TIMEOUT_MS, 'model load');
    } catch (error) {
      return keyword(`built-in embedding model ${provider.modelId} did not load: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  const modelIds = [...new Set(builtIn.map((provider) => provider.modelId))].join(', ');
  return {
    retrieval: { mode: 'hybrid', modelId: modelIds, note: `hybrid search with the built-in embedding model ${modelIds}` },
    embeddingFor: (trustDomain) => input.configured[trustDomain],
  };
}

/** Whether every file the built-in model loads from is on disk (never downloads). */
export function builtInEmbeddingFilesPresent(modelId: string, env: Record<string, string | undefined>): boolean {
  const model = builtInEmbeddingModel(modelId);
  if (!model) return false;
  try {
    const paths = builtInEmbeddingPaths(env, model);
    const installed = installedBuiltInEmbedding(paths, model);
    return [installed.modelPath, installed.vocabularyPath, installed.libraryPath ?? installed.runtimeDir]
      .every((path) => path === undefined || existsSync(path));
  } catch {
    return false;
  }
}

/** Each tier's embedding model as this install configures it (the worker's own resolution). */
async function configuredEvalEmbedding(
  config: OlympusConfig,
  env: Record<string, string | undefined>,
): Promise<Parameters<typeof prepareEvalEmbedding>[0]['configured']> {
  try {
    const { loadSourceWorkerSovereignty, createSourceIndexEmbeddingProviderFromSovereignty } = await import('../src/workers/email-source/server.ts');
    const engine = loadSourceWorkerSovereignty(config, env);
    const configured: Partial<Record<SourceTrustDomain, SourceEmbeddingProvider>> = {};
    for (const domain of ['public_safe', 'internal', 'secure_local'] as const) {
      const provider = createSourceIndexEmbeddingProviderFromSovereignty(engine, domain, env);
      if (provider) configured[domain] = provider;
    }
    return configured;
  } catch (error) {
    console.error(`eval retrieval: embedding configuration unreadable (${error instanceof Error ? error.message : String(error)})`);
    return {};
  }
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${Math.round(timeoutMs / 1000)}s`)), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
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
  };
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

async function runIsolatedEval(input: IsolatedEvalInput): Promise<void> {
  const grades: EvalGrade[] = [];
  const timings: EvalQuestionTiming[] = [];
  const traces: PrecisionTrace[] = [];
  let retrieval: EvalReportRetrieval | undefined;
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
        retrieval ??= envelope.retrieval;
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
      { ...input.config, ...(retrieval ? { retrieval } : {}) },
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
    { ...input.config, ...(retrieval ? { retrieval } : {}) },
    { partial: report.remaining > 0 },
  );
  console.log(JSON.stringify(report, null, 2));
  console.error(`held-out eval: ${report.passed}/${report.total} passed`);
  if (retrieval) console.error(`retrieval: ${retrieval.note}; stores ${retrieval.corpora.join(', ')}`);
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
    retrieval?: EvalReportRetrieval;
    reranker?: string;
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
      ...(config.retrieval ? { retrieval: config.retrieval } : {}),
      ...(config.reranker ? { reranker: config.reranker } : {}),
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
