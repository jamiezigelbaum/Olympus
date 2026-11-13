// Eval-only serialization boundary. Never persist questions, titles, passages,
// quotes, hints, account scopes or locators. All source content stays in memory.
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildEvalPack } from './retrieval.ts';
import type { EvalQuestion } from './types.ts';
import { passageContainsQuote } from './passage-match.ts';
import { questionHasTemporalIntent } from '../src/core/evidence-pack.ts';
import { MAX_RERANK_POOL_SIZE, type EvidenceReranker, type EvidenceRerankOutcome } from '../src/core/evidence-reranker.ts';
import { builtInRerankerFromEnv, type BuiltInRerankerFromEnvOptions } from '../src/workers/source-index/built-in-reranker.ts';
import { routedHitCandidateId, type SeatingLane, type SourceIndexRoutedSearchHit, type SourceIndexStoreRelevance } from '../src/core/source-index/router.ts';
import { SourceModelPolicyDeniedError } from '../src/core/source-model-policy.ts';
import { applySourceIndexVisibilityGate } from '../src/core/source-index/router.ts';
import type { LocalContentBlock } from '../src/core/evidence-pack.ts';
import type { SourceTrustDomain, SourceIndexCandidateId } from '../src/core/source-index/types.ts';

export interface CapturedItem {
  candidateId: SourceIndexCandidateId;
  providerItemId: string;
  localItemId: string;
  rank: number;
  adapterScore?: number;
  rerankerScore?: number | 'Infinity' | '-Infinity';
  keywordFirst?: boolean;
  nameLeader?: boolean;
  conceptShare?: number;
  newestInStore?: number;
  pinAppended?: boolean;
  authoredAtMs?: number;
  /** False when the final visibility/model-policy check excluded the item. */
  packEligible: boolean;
  expected: boolean;
  holdsQuote: boolean;
  /** Indexes distinguish multiple expectations and their alternate documents. */
  matches: { expectedIndex: number; expected: boolean; holdsQuote: boolean }[];
}
export interface CapturedLane {
  corpusId: string;
  trustDomain: SourceTrustDomain;
  relevance?: SourceIndexStoreRelevance;
  items: CapturedItem[];
}
export interface PoolCapture {
  version: 2;
  questionId: string;
  storeDepth: number;
  poolSize: number;
  maxResults: number;
  temporalIntent: boolean;
  strengthAllocation: boolean;
  rerankOutcome: EvidenceRerankOutcome | 'off' | 'temporal';
  scoreLimit: number;
  capturedCandidates: number;
  scoringTruncated: boolean;
  expected: { corpusId: string; providerItemId?: string; quoteRequired: boolean; alternates: { corpusId: string; providerItemId: string }[] }[];
  runs: { ordinal: number; lanes: CapturedLane[] }[];
  /** Actual live seats for parity checks; pre Analyst prompt fitting. */
  pack: { corpusId: string; providerItemId: string }[];
}

/** Capture is fail-closed when the environment explicitly requests a local reranker. No download. */
export async function prepareCaptureReranker(env: Record<string, string | undefined>, options: Pick<BuiltInRerankerFromEnvOptions, 'runtime'> = {}): Promise<EvidenceReranker | undefined> {
  if (env.OLYMPUS_SOURCE_RERANKER?.trim().toLowerCase() !== 'built-in') return undefined;
  const reranker = builtInRerankerFromEnv({ ...options, env });
  if (!reranker) throw new Error('Pool capture requested the built-in reranker, but model files are missing. Set OLYMPUS_SOURCE_RERANKER_MODEL_DIR to an installed model.onnx and vocab.txt or tokenizer.json.');
  try { await reranker.prepare(); }
  catch (error) { throw new Error(`Pool capture could not load the built-in reranker: ${error instanceof Error ? error.message : String(error)}`); }
  return reranker;
}

export async function captureEvalPack(input: Omit<Parameters<typeof buildEvalPack>[0], 'question'> & {
  question: EvalQuestion;
  captureDepth: number;
}) {
  if (!Number.isSafeInteger(input.captureDepth) || input.captureDepth < 1) throw new Error('capture depth must be a positive integer');
  const temporalIntent = questionHasTemporalIntent({ question: input.question.question });
  const rerankEnabled = !!input.reranker && !temporalIntent;
  if (rerankEnabled && input.maxResults > MAX_RERANK_POOL_SIZE) throw new Error('Pool capture maxResults exceeds the 400 candidate scoring limit.');
  const runs: { ordinal: number; lanes: readonly SeatingLane[] }[] = [];
  const scores = new Map<SourceIndexCandidateId, number>();
  let outcome: PoolCapture['rerankOutcome'] = temporalIntent && input.reranker ? 'temporal' : 'off';
  // Keep content only long enough to evaluate the booleans. Providers may be
  // asked for a matched item outside the scored pool, using the same passage
  // budget/query as the live build, so it too gets a paragraph mark.
  const holds = new Map<string, boolean[]>();
  const denied = new Set<string>();
  let finalVisibility: ReadonlyMap<SourceIndexCandidateId, boolean> | undefined;
  const key = (corpusId: string, providerItemId: string) => JSON.stringify([corpusId, providerItemId]);
  const mark = (corpusId: string, providerItemId: string, content: LocalContentBlock | undefined) => {
    // Same text and matching rule as the retrieval eval's in-pack check.
    const passage = [...(content?.chunks ?? []), ...(content?.facts ?? []).map(f => f.claim),
      ...(content?.tables ?? []).flatMap(t => [t.caption ?? '', ...t.columns, ...t.rows.map(row => row.join(' '))])].join('\n');
    holds.set(key(corpusId, providerItemId), (input.question.expectedEvidence ?? []).map(e =>
      !!e.quote && passageContainsQuote(passage, e.quote)));
  };
  const liveLanes = input.lanes(input.question.question);
  const contentProviders = Object.fromEntries(Object.entries(liveLanes.contentProviders).map(([corpusId, provider]) => [corpusId, provider && {
    ...provider,
    ...(provider.corpusReadability ? { corpusReadability: () => provider.corpusReadability!() } : {}),
    async fetchLocalContent(request: Parameters<typeof provider.fetchLocalContent>[0]) {
      try {
        const content = await provider.fetchLocalContent(request);
        mark(corpusId, request.provenance.sourceItem.providerItemId, content);
        return content;
      } catch (error) {
        if (error instanceof SourceModelPolicyDeniedError) denied.add(key(corpusId, request.provenance.sourceItem.providerItemId));
        throw error;
      }
    },
  }]));
  const detail = await buildEvalPack({
    ...input,
    question: input.question.question,
    lanes: () => ({ ...liveLanes, contentProviders,
      ...(liveLanes.visibilityGate ? { visibilityGate: Object.assign(liveLanes.visibilityGate.bind(null), {
        offThread: async (...args: Parameters<typeof liveLanes.visibilityGate>) => {
          const kept = await applySourceIndexVisibilityGate(liveLanes.visibilityGate!, ...args);
          const keptIds = new Set(kept.map(routedHitCandidateId));
          // The builder's final pass is the last invocation. Items outside
          // that pass have only their captured, per-run visibility decision.
          finalVisibility = new Map(args[0].map(hit => [routedHitCandidateId(hit), keptIds.has(routedHitCandidateId(hit))]));
          return kept;
        },
      }) } : {}),
    }),
    ...(input.reranker ? { reranker: { ...input.reranker, poolSize: MAX_RERANK_POOL_SIZE, score: request => input.reranker!.score(request) } } : {}),
    ...(rerankEnabled ? { poolAllocation: { storeDepth: input.captureDepth } } : {}),
    storeSearchDepth: input.captureDepth,
    onSeatingLanes: (lanes, ordinal) => { runs.push({ ordinal, lanes }); },
    onRerankScores: (entries, observedOutcome) => {
      outcome = observedOutcome;
      for (const entry of entries) scores.set(entry.candidateId, entry.score);
    },
  });
  const expected = input.question.expectedEvidence ?? [];
  const matchesIdentity = (hit: SourceIndexRoutedSearchHit, index: number) => {
    const e = expected[index]!;
    return [{ corpusId: e.corpusId, providerItemId: e.providerItemId }, ...(e.alternates ?? [])]
      .some(id => id.corpusId === hit.corpusId && (!id.providerItemId || id.providerItemId === hit.sourceItem.providerItemId));
  };
  for (const { lanes } of runs) for (const lane of lanes) for (const hit of lane.items) {
    const itemKey = key(hit.corpusId, hit.sourceItem.providerItemId);
    if (!holds.has(itemKey) && expected.some((e, i) => !!e.quote && matchesIdentity(hit, i))) {
      try {
        const content = await liveLanes.contentProviders[hit.corpusId]?.fetchLocalContent({
          provenance: hit.provenance ?? { sourceItem: hit.sourceItem }, trustDomain: hit.trustDomain,
          maxChars: input.maxCharsPerCandidate, query: input.question.question,
        });
        mark(hit.corpusId, hit.sourceItem.providerItemId, content);
      } catch (error) {
        if (!(error instanceof SourceModelPolicyDeniedError)) throw error;
        denied.add(itemKey);
        mark(hit.corpusId, hit.sourceItem.providerItemId, undefined);
      }
    }
  }
  const serializeItem = (hit: SourceIndexRoutedSearchHit, index: number): CapturedItem => {
    const candidateId = routedHitCandidateId(hit);
    const score = scores.get(candidateId);
    const matches = expected.map((_, expectedIndex) => ({ expectedIndex, expected: matchesIdentity(hit, expectedIndex),
      holdsQuote: matchesIdentity(hit, expectedIndex) && (holds.get(key(hit.corpusId, hit.sourceItem.providerItemId))?.[expectedIndex] ?? false),
    })).filter(m => m.expected || m.holdsQuote);
    const time = Date.parse(hit.provenance?.citation?.authoredAt ?? '') || 0;
    return {
      candidateId, providerItemId: hit.sourceItem.providerItemId, localItemId: hit.sourceItem.localItemId,
      rank: index + 1,
      ...(hit.score !== undefined ? { adapterScore: hit.score } : {}),
      ...(score !== undefined ? { rerankerScore: Number.isFinite(score) ? score : score > 0 ? 'Infinity' as const : '-Infinity' as const } : {}),
      ...(hit.keywordLeader ? { keywordFirst: hit.keywordLeader.kinds.includes('keyword_first'), nameLeader: hit.keywordLeader.kinds.includes('name'), conceptShare: hit.keywordLeader.conceptShare } : {}),
      ...(hit.newestInStore !== undefined ? { newestInStore: hit.newestInStore, authoredAtMs: time, ...(hit.pinAppended ? { pinAppended: true } : {}) } : {}),
      packEligible: finalVisibility?.get(candidateId) !== false && !denied.has(key(hit.corpusId, hit.sourceItem.providerItemId)),
      expected: matches.some(m => m.expected), holdsQuote: matches.some(m => m.holdsQuote), matches,
    };
  };
  const capturedCandidates = new Set(runs.flatMap(run => run.lanes.flatMap(lane => lane.items.map(routedHitCandidateId)))).size;
  const capture: PoolCapture = {
    version: 2, questionId: input.question.id, storeDepth: input.captureDepth,
    poolSize: rerankEnabled ? MAX_RERANK_POOL_SIZE : input.maxResults, maxResults: input.maxResults,
    temporalIntent, strengthAllocation: rerankEnabled, rerankOutcome: outcome,
    scoreLimit: MAX_RERANK_POOL_SIZE, capturedCandidates,
    scoringTruncated: rerankEnabled && capturedCandidates > MAX_RERANK_POOL_SIZE,
    expected: expected.map(e => ({ corpusId: e.corpusId, ...(e.providerItemId ? { providerItemId: e.providerItemId } : {}), quoteRequired: !!e.quote, alternates: (e.alternates ?? []).map(a => ({ corpusId: a.corpusId, providerItemId: a.providerItemId })) })),
    runs: runs.map(run => ({ ordinal: run.ordinal, lanes: run.lanes.map(lane => ({ corpusId: lane.name,
      trustDomain: lane.items[0]?.trustDomain ?? liveLanes.registry.get(lane.name)!.trustDomain,
      ...(lane.relevance ? { relevance: { conceptShare: lane.relevance.conceptShare, ...(lane.relevance.vectorMargin !== undefined ? { vectorMargin: lane.relevance.vectorMargin } : {}) } } : {}),
      items: lane.items.map(serializeItem),
    })) })),
    pack: detail.pack.candidates.map((candidate, index) => ({ corpusId: detail.candidateCorpusIds[index]!, providerItemId: candidate.provenance.sourceItem.providerItemId })),
  };
  return { detail, capture };
}

export function writePoolCapture(directory: string, capture: PoolCapture): string {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  // Dataset ids need not be valid filenames; a digest also prevents traversal.
  const path = join(directory, `${createHash('sha256').update(capture.questionId).digest('hex')}.json`);
  writeFileSync(path, `${JSON.stringify(capture, null, 2)}\n`, { mode: 0o600 });
  return path;
}
