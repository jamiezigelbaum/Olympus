/**
 * Ask privately on the computer: a question answered on this computer only,
 * from the person's Private items and the Personal items whose stores are
 * mounted here. Design docs/design/background-agents.md, section B. It is
 * the path behind the Private answers page's Ask box and behind Answer on a
 * waiting question (section A).
 *
 * Every stage stays on this computer:
 * - planning: none. The question (or the waiting question's own explicit
 *   query) is the one retrieval query; no planner model is called.
 * - embeddings: the built-in embedding model only, and only as this process
 *   already holds it loaded (`builtInEmbeddingOnly`): nothing here installs,
 *   downloads or starts a model. A store whose vectors came from any other
 *   model, or a model not loaded yet, is searched by its local keyword index.
 * - retrieval: the shared EvidencePack build over the lanes the caller hands
 *   in (Private stores and the Personal stores mounted here, through their
 *   scoped adapters), with cloud queries refused; a corpus that could only be
 *   searched remotely, has no adapter here, or timed out is named in
 *   `leftOut` (every problem findable).
 * - passage ranking: each store's own local passage selection.
 * - synthesis: the built-in private model, through the private answer
 *   panel's model (chatgpt/private-answer-model.ts), which re-checks each
 *   item's eligibility before every model call.
 * Anonymous outside help (zkAPI) is not reachable from here.
 *
 * Eligibility: an item may be read when its corpus is still registered at
 * the item's trust domain and that store would serve its content now under
 * the owner's current scope (`checkLocalEvidenceItems`), the same live check
 * the panel uses for Private items, widened to Personal ones. It is asked
 * again after the answer, before anything is shown, so an item re-tiered or
 * removed meanwhile withdraws the answer. That check covers every item that
 * can reach the output: the items read and the other versions the answer's
 * version note names (the model's `used`).
 */
import { buildEvidencePackDetailed, type LocalContentProvider } from '../../core/evidence-pack.ts';
import type { EvidenceCandidate } from '../../core/contracts.ts';
import { assertEvidencePackModelEligible, assertModelTrustTierAllowed } from '../../core/source-model-policy.ts';
import type { SourceIndexProvenance, SourceTrustDomain } from '../../core/source-index/types.ts';
import type { WaitingQuestionSelectors } from '../../core/waiting-private-questions.ts';
import {
  NoPrivateEvidenceError,
  type PrivateAnswerDetail,
  type PrivateAnswerModel,
  type PrivateAnswerSourceCitation,
  type PrivateEvidenceItem,
} from '../chatgpt/private-answer-contract.ts';
import {
  selectedEvidenceItemsFromRequest,
  sourceAnswerCorpusIds,
  type AnalystAnswerLanes,
} from './analyst-answer.ts';
import type { SourceIndexAnswerRequest } from './answer-types.ts';

/**
 * The trust domains a local answer reads: Personal and Private (design
 * section B). Public stores are searchable from the cloud by design, so
 * their corpora are outside this request's scope, not "left out".
 */
const LOCAL_TRUST_DOMAINS: readonly SourceTrustDomain[] = ['internal', 'secure_local'];
const LOCAL_MAX_RESULTS = 16;
const LOCAL_MAX_CHARS_PER_CANDIDATE = 3_000;
const LOCAL_EVIDENCE_BYTE_BUDGET = 24_000;
const LOCAL_DEPTH_MAX_PASSAGES = 24;
/** Skip reasons that are the request's own scope, not a source left out. */
const IN_SCOPE_SKIPS = new Set(['not_requested', 'trust_domain_not_allowed', 'corpus_not_allowed']);

export type LocalAnswerResult =
  | {
      status: 'answered';
      answer: string;
      citations: PrivateAnswerSourceCitation[];
      sentItems?: Array<{ title?: string; source?: string; date?: string }>;
      unanswered: string[];
      /** Sources that could not be searched on this computer, by name. */
      leftOut: string[];
      /**
       * The items the answer read, kept on this computer for the re-check
       * before a cited item opens. Never sent to the page.
       */
      read: readonly PrivateEvidenceItem[];
    }
  /** Nothing on this computer matched (or nothing that matched may be read now). */
  | { status: 'not_found'; leftOut: string[] }
  /** The built-in private model is not on this computer, or still downloading. */
  | { status: 'no_model' }
  | { status: 'model_downloading'; percent?: number }
  /** An item the answer read changed tier or went away before it was shown. */
  | { status: 'withdrawn'; sentItems: Array<{ title?: string; source?: string; date?: string }>; reason: string }
  | { status: 'changed' }
  | { status: 'failed' };

export interface LocalAnswerRequest {
  question: string;
  /** A waiting question's stored selectors: the replay searches exactly these, never wider. */
  selectors?: WaitingQuestionSelectors;
  detail?: PrivateAnswerDetail;
  signal?: AbortSignal;
  /** Owner inbox generation; checked at a remote dispatch, never accepted from the wire. */
  stillAuthorized?: () => boolean;
  /** Marks the start of synthesis so pre-model failures do not spend the inbox budget. */
  onModelCall?: () => void;
}

export interface LocalAnswerOptions {
  /**
   * The local lanes: Private stores and the Personal stores mounted here,
   * each adapter and content provider holding the built-in embedding model
   * or none (builtInEmbeddingOnly). Built per request.
   */
  lanes: (request: SourceIndexAnswerRequest) => AnalystAnswerLanes;
  /** The built-in private model behind the panel's contract, with checkLocalEvidenceItems as its guard. */
  model: PrivateAnswerModel;
  /** The live eligibility guard (checkLocalEvidenceItems over the same lanes). */
  eligible: (items: readonly PrivateEvidenceItem[]) => Promise<readonly boolean[]>;
  /** A source's name for a corpus id, for "left out"; undefined names it generically. */
  sourceName?: (corpusId: string) => string | undefined;
  laneTimeoutMs?: number;
}

/**
 * The embedding provider a local lane may hold (source-index/embeddings.ts,
 * kept there so the worker's lane builder needs nothing else from here).
 */
export { builtInEmbeddingOnly } from './embeddings.ts';

/** The retrieval request a local answer searches with: the selectors as stored, every tier on. */
export function localAnswerRequest(question: string, selectors: WaitingQuestionSelectors = {}): SourceIndexAnswerRequest {
  const { retrieval_mode: mode, selected_items: selected, ...rest } = selectors;
  return {
    ...rest,
    ...(selected?.length ? { selected_items: selected as unknown as NonNullable<SourceIndexAnswerRequest['selected_items']> } : {}),
    question,
    retrieval_mode: mode === 'keyword' ? 'keyword' : 'hybrid',
    include_internal: true,
    include_internal_content: true,
    include_secure_local: true,
    include_secure_local_content: true,
    max_results: LOCAL_MAX_RESULTS,
  };
}

export async function answerOnThisComputer(
  input: LocalAnswerRequest,
  options: LocalAnswerOptions,
): Promise<LocalAnswerResult> {
  const question = input.question.trim();
  if (!question) return { status: 'failed' };
  const status = options.model.status();
  if (status.state === 'no_model') return { status: 'no_model' };
  if (status.state === 'model_downloading') {
    return { status: 'model_downloading', ...(typeof status.percent === 'number' ? { percent: status.percent } : {}) };
  }
  const request = localAnswerRequest(question, input.selectors);
  const lanes = options.lanes(request);
  const corpusIds = sourceAnswerCorpusIds(request);
  const selectedItems = selectedEvidenceItemsFromRequest(request);
  const explicitQuery = request.query?.trim();
  const detail = await buildEvidencePackDetailed({
    question,
    ...(explicitQuery ? { searchQuery: explicitQuery } : {}),
    ...(selectedItems.length > 0 ? { selectedItems } : {}),
    maxResults: LOCAL_MAX_RESULTS,
    // Personal and Private, and no query leaves this computer: a corpus that
    // would need a cloud query is skipped and named below.
    searchContext: {
      allowedTrustDomains: LOCAL_TRUST_DOMAINS,
      allowCloudQueries: false,
      ...(corpusIds ? { allowedCorpusIds: corpusIds } : {}),
    },
    ...(corpusIds ? { corpusIds } : {}),
    registry: lanes.registry,
    adapters: lanes.adapters,
    contentProviders: lanes.contentProviders,
    maxCharsPerCandidate: LOCAL_MAX_CHARS_PER_CANDIDATE,
    evidenceByteBudget: LOCAL_EVIDENCE_BYTE_BUDGET,
    ...(options.laneTimeoutMs !== undefined ? { laneTimeoutMs: options.laneTimeoutMs } : {}),
    ...(lanes.visibilityGate ? { visibilityGate: lanes.visibilityGate } : {}),
  });
  assertEvidencePackModelEligible(detail.pack);
  const leftOut = leftOutSources(detail.skippedCorpora, lanes.excludedCorpusIds, options.sourceName);
  // Items kept as names only, and Personal names whose contents are Private
  // (read from their Private copy instead), carry no text to answer from.
  const skip = new Set([...(detail.namesOnlyCandidateIndexes ?? []), ...(detail.contentPrivateCandidateIndexes ?? [])]);
  const candidates: PrivateEvidenceItem[] = detail.pack.candidates.flatMap((candidate: EvidenceCandidate, index: number) => {
    const corpusId = detail.candidateCorpusIds[index] ?? '';
    if (skip.has(index) || !corpusId || !LOCAL_TRUST_DOMAINS.includes(candidate.trustDomain)) return [];
    return [{ ...candidate, corpusId } as unknown as PrivateEvidenceItem];
  });
  if (candidates.length === 0) return { status: 'not_found', leftOut };
  let used: readonly number[] | undefined;
  let result: Awaited<ReturnType<PrivateAnswerModel['answerPrivately']>>;
  try {
    result = await options.model.answerPrivately(question, candidates, input.signal, {
      evidence: (stats) => {
        used = stats.used;
      },
      ...(input.onModelCall ? { modelStarting: input.onModelCall } : {}),
    }, { detail: input.detail === 'full' ? 'full' : 'summary' });
  } catch (error) {
    if (error instanceof NoPrivateEvidenceError) return { status: 'failed' };
    return { status: 'failed' };
  }
  // Before anything is shown: every item that can reach the output (the items
  // read, and the other versions the note names) is still readable now.
  const read = (used ?? candidates.map((_, index) => index)).map((index) => candidates[index]).filter((item): item is PrivateEvidenceItem => item !== undefined);
  if (read.length > 0) {
    let ok: readonly boolean[];
    try {
      ok = await options.eligible(read);
    } catch {
      ok = read.map(() => false);
    }
    if (ok.length !== read.length || !ok.every((value) => value === true)) return { status: 'changed' };
  }
  return {
    status: 'answered',
    answer: result.answer,
    citations: result.citations,
    unanswered: result.unanswered ?? [],
    leftOut,
    read,
  };
}

/**
 * The sources this answer could not search here: a corpus that needs a cloud
 * query, a registered corpus with no adapter on this computer (not one the
 * owner's scope or the request left out on purpose), or one that timed out
 * or failed. Named by source, once each.
 */
function leftOutSources(
  skipped: readonly { corpusId: string; reason: string }[],
  excluded: ReadonlySet<string> | undefined,
  sourceName: ((corpusId: string) => string | undefined) | undefined,
): string[] {
  const names = new Set<string>();
  for (const skip of skipped) {
    if (IN_SCOPE_SKIPS.has(skip.reason)) continue;
    if (skip.reason === 'no_adapter' && excluded?.has(skip.corpusId)) continue;
    let name: string | undefined;
    try {
      name = sourceName?.(skip.corpusId);
    } catch {
      name = undefined;
    }
    names.add(name ?? 'One source');
  }
  return [...names].sort();
}

/**
 * Whether each evidence item may be read by a model on this computer right
 * now, from live state: the item names a corpus still registered at the
 * item's own trust domain (Personal or Private), and that store's
 * content provider would serve its content now under the owner's current
 * scope. A provider without `contentServable` is asked for the content and
 * must return text at that domain. Fails closed.
 */
export async function checkLocalEvidenceItems(input: {
  lanes: (request: SourceIndexAnswerRequest) => AnalystAnswerLanes;
  items: readonly Readonly<Record<string, unknown>>[];
  /** Preserve an unavailable check for callers that must retain stored answers. */
  throwOnUnavailable?: boolean;
}): Promise<boolean[]> {
  if (input.items.length === 0) return [];
  let lanes: AnalystAnswerLanes;
  try {
    lanes = input.lanes(localAnswerRequest('eligibility', { retrieval_mode: 'keyword' }));
  } catch (error) {
    if (input.throwOnUnavailable) throw error;
    return input.items.map(() => false);
  }
  return Promise.all(input.items.map(async (item) => {
    try {
      const corpusId = typeof item.corpusId === 'string' ? item.corpusId : undefined;
      const provenance = item.provenance as SourceIndexProvenance | undefined;
      const trustDomain = item.trustDomain as SourceTrustDomain | undefined;
      if (!corpusId || !provenance?.sourceItem?.localItemId || !trustDomain || !LOCAL_TRUST_DOMAINS.includes(trustDomain)) return false;
      if (lanes.registry.get(corpusId)?.trustDomain !== trustDomain) return false;
      const provider = lanes.contentProviders[corpusId] as
        | (LocalContentProvider & { contentServable?: (request: { provenance: SourceIndexProvenance; trustDomain: SourceTrustDomain; throwOnUnavailable?: boolean }) => boolean })
        | undefined;
      if (!provider) return false;
      if (typeof provider.contentServable === 'function') {
        return provider.contentServable({ provenance, trustDomain, throwOnUnavailable: input.throwOnUnavailable === true }) === true;
      }
      const content = await provider.fetchLocalContent({ provenance, trustDomain, maxChars: 1 });
      if (!content || content.namesOnly || content.contentPrivate || content.chunks.length === 0) return false;
      if (content.sensitivity.trustDomain !== trustDomain) return false;
      if (content.sensitivity.trustTier === 'S5') return false;
      assertModelTrustTierAllowed(content.sensitivity.trustTier);
      return true;
    } catch (error) {
      if (input.throwOnUnavailable) throw error;
      return false;
    }
  }));
}

/**
 * One evidence item's own text, read again from its store on this computer
 * with a larger budget (the whole item when it fits, else its passages most
 * relevant to `question`), at the item's own trust domain. Undefined when
 * the store will not serve it now.
 */
export async function readLocalEvidenceItem(input: {
  lanes: (request: SourceIndexAnswerRequest) => AnalystAnswerLanes;
  item: Readonly<Record<string, unknown>>;
  question: string;
  maxChars: number;
}): Promise<readonly string[] | undefined> {
  const corpusId = typeof input.item.corpusId === 'string' ? input.item.corpusId : undefined;
  const provenance = input.item.provenance as SourceIndexProvenance | undefined;
  const trustDomain = input.item.trustDomain as SourceTrustDomain | undefined;
  if (!corpusId || !provenance?.sourceItem || !trustDomain || !LOCAL_TRUST_DOMAINS.includes(trustDomain)) return undefined;
  const lanes = input.lanes(localAnswerRequest(input.question));
  if (lanes.registry.get(corpusId)?.trustDomain !== trustDomain) return undefined;
  const provider = lanes.contentProviders[corpusId];
  if (!provider) return undefined;
  const content = await provider.fetchLocalContent({
    provenance,
    trustDomain,
    maxChars: Math.max(1, Math.floor(input.maxChars)),
    query: input.question,
    maxPassages: LOCAL_DEPTH_MAX_PASSAGES,
  });
  if (!content || content.namesOnly || content.contentPrivate) return undefined;
  return content.chunks;
}
