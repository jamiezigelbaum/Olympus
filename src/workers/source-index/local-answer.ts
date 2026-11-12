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
import { RECENT_ITEMS_CUT_SHORT, semanticSearchTimedOut } from '../../core/source-index/partial-search.ts';
import { buildEvidencePackDetailed, type LocalContentProvider, type SecretLocationNote } from '../../core/evidence-pack.ts';
import { providerSourceLabel } from '../../core/remote-result.ts';
import { secretLocationAnswer } from '../../core/secret-location-note.ts';
import { secretLocationFingerprint } from '../classification/secret-locations.ts';
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
      /** Sources whose search ran out of time because Olympus was busy, by name. */
      busy?: string[];
      /**
       * The items the answer read, kept on this computer for the re-check
       * before a cited item opens. Never sent to the page.
       */
      read: readonly PrivateEvidenceItem[];
      secretLocations?: readonly import('../../core/evidence-pack.ts').SavedSecretLocation[];
    }
  /** Nothing on this computer matched (or nothing that matched may be read now). */
  | { status: 'not_found'; leftOut: string[]; busy?: string[] }
  /**
   * No source was searched at all: each one timed out (`busy`) or cannot be
   * searched here (`leftOut`). Not "not found": nothing was looked at.
   */
  | { status: 'not_searched'; leftOut: string[]; busy: string[] }
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
  /**
   * The content-free retrieval line for each ask (latency, searched and
   * skipped corpus ids with reasons). Defaults to the worker log.
   */
  logRetrieval?: (line: LocalAnswerRetrievalLog) => void;
}

/** One ask's retrieval, content-free: no question, answer, item or name. */
export interface LocalAnswerRetrievalLog {
  latencyMs: number;
  searchedCorpora: readonly string[];
  skippedCorpora: ReadonlyArray<{ corpusId: string; reason: string }>;
  candidates: number;
}

function logRetrievalToWorkerLog(line: LocalAnswerRetrievalLog): void {
  const skipped = line.skippedCorpora.map((skip) => `${skip.corpusId}:${skip.reason}`).join(',');
  console.error(
    `[local-answer] retrieval latency_ms=${line.latencyMs} candidates=${line.candidates}`
    + ` searched=${line.searchedCorpora.join(',') || '-'} skipped=${skipped || '-'}`,
  );
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
  const request = localAnswerRequest(question, input.selectors);
  const lanes = options.lanes(request);
  const corpusIds = sourceAnswerCorpusIds(request);
  const selectedItems = selectedEvidenceItemsFromRequest(request);
  const explicitQuery = request.query?.trim();
  const retrievalStartedAt = Date.now();
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
    limitStops: lanes.limitStops ?? [],
    registry: lanes.registry,
    adapters: lanes.adapters,
    contentProviders: lanes.contentProviders,
    maxCharsPerCandidate: LOCAL_MAX_CHARS_PER_CANDIDATE,
    evidenceByteBudget: LOCAL_EVIDENCE_BYTE_BUDGET,
    ...(options.laneTimeoutMs !== undefined ? { laneTimeoutMs: options.laneTimeoutMs } : {}),
    ...(lanes.visibilityGate ? { visibilityGate: lanes.visibilityGate } : {}),
    ...(lanes.secretLocations ? { secretLocations: lanes.secretLocations } : {}),
  });
  assertEvidencePackModelEligible(detail.pack);
  const searchedCorpora = detail.pack.coverage.searchedCorpora;
  try {
    (options.logRetrieval ?? logRetrievalToWorkerLog)({
      latencyMs: Date.now() - retrievalStartedAt,
      searchedCorpora,
      skippedCorpora: detail.skippedCorpora.map(({ corpusId, reason }) => ({ corpusId, reason })),
      candidates: detail.pack.candidates.length,
    });
  } catch {
    // A log line never fails an answer.
  }
  const { leftOut, busy } = leftOutSources(
    [...detail.skippedCorpora, ...cutShortCorpora(detail.laneAudits)],
    lanes.excludedCorpusIds,
    lanes.unmountedCorpusIds,
    options.sourceName,
  );
  const busyField = busy.length > 0 ? { busy } : {};
  // Matching Secrets, by location only (no model sees them): said beside the answer, or as the answer.
  const secrets = secretLocationAnswer((detail.secretLocations ?? []).map((location) => ({ where: secretWhere(location) })));
  const secretLocations = (detail.secretLocations ?? []).map(({ source, ref, locator, title }) => ({ source, ref, fingerprint: secretLocationFingerprint({ locator, title }) }));
  const notFound = (): LocalAnswerResult => (secrets
    ? { status: 'answered', answer: secrets, citations: [], unanswered: [], leftOut, ...busyField, read: [], secretLocations }
    : searchedCorpora.length === 0 && leftOut.length + busy.length > 0
      ? { status: 'not_searched', leftOut, busy }
      : { status: 'not_found', leftOut, ...busyField });
  // Items kept as names only, and Personal names whose contents are Private
  // (read from their Private copy instead), carry no text to answer from.
  const skip = new Set([...(detail.namesOnlyCandidateIndexes ?? []), ...(detail.contentPrivateCandidateIndexes ?? [])]);
  const candidates: PrivateEvidenceItem[] = detail.pack.candidates.flatMap((candidate: EvidenceCandidate, index: number) => {
    const corpusId = detail.candidateCorpusIds[index] ?? '';
    if (skip.has(index) || !corpusId || !LOCAL_TRUST_DOMAINS.includes(candidate.trustDomain)) return [];
    return [{ ...candidate, corpusId } as unknown as PrivateEvidenceItem];
  });
  // A Secret location is a local notice, not an inference job.
  if (secrets && candidates.length === 0) return notFound();
  const status = options.model.status();
  if (status.state === 'no_model') return { status: 'no_model' };
  if (status.state === 'model_downloading') {
    return { status: 'model_downloading', ...(typeof status.percent === 'number' ? { percent: status.percent } : {}) };
  }
  if (candidates.length === 0) return notFound();
  let used: readonly number[] | undefined;
  let result: Awaited<ReturnType<PrivateAnswerModel['answerPrivately']>>;
  try {
    result = await options.model.answerPrivately(question, candidates, input.signal, {
      evidence: (stats) => {
        used = stats.used;
      },
    }, { detail: input.detail === 'full' ? 'full' : 'summary' });
  } catch (error) {
    if (!(error instanceof NoPrivateEvidenceError)) return { status: 'failed' };
    // Nothing picked may be read. Before any model call (`none_readable`) a
    // fresh search finds the same items, so that settles as not found; an
    // item revoked mid-answer is `changed` while any match is still eligible,
    // and searches again. A live check that throws stays `failed`. As
    // `changed` throughout, a question whose matches cannot be read in depth
    // searched and answered again until its deadline, holding the model.
    try {
      const ok = await options.eligible(candidates);
      return error.reason === 'revoked' && ok.some((value) => value === true) ? { status: 'changed' } : notFound();
    } catch {
      return { status: 'failed' };
    }
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
    answer: secrets ? `${result.answer}\n\n${secrets}` : result.answer,
    citations: result.citations,
    unanswered: result.unanswered ?? [],
    leftOut,
    ...busyField,
    read,
    secretLocations,
  };
}

/** Where a Secret is, as the index releases it: its locator or title, else its source by name. */
function secretWhere(location: SecretLocationNote): string {
  const named = location.locator ?? location.title;
  if (named) return named;
  return `In ${providerSourceLabel(location.source) ?? 'one of your sources'} (its name is Private, so it is not shown here)`;
}

/**
 * Corpora searched by keyword alone because their search by meaning ran out
 * of time (a held thread spends the vector scan's own deadline even when the
 * lane is given a grace, #1091 review). What they would have matched by
 * meaning is unknown, so they count as busy: asking again can find more. So
 * do corpora whose read of their newest items ran out of time (#1460).
 */
function cutShortCorpora(audits: readonly { laneName: string; skippedReason?: string }[]): { corpusId: string; reason: string }[] {
  const corpora = new Set<string>();
  for (const audit of audits) {
    if (!semanticSearchTimedOut(audit.skippedReason) && audit.skippedReason !== RECENT_ITEMS_CUT_SHORT) continue;
    const corpusId = audit.laneName.split(':')[0];
    if (corpusId) corpora.add(corpusId);
  }
  return [...corpora].map((corpusId) => ({ corpusId, reason: 'lane_timeout' }));
}

/**
 * The sources this answer could not search here, named by source, once each.
 * `busy`: a search that ran out of time (Olympus was busy; asking again can
 * work). `leftOut`: a corpus that needs a cloud query, one with a store on
 * this computer but no adapter (not one the owner's scope or the request left
 * out on purpose), or one whose search failed. A registered corpus with no
 * store here is not a source on this computer, so it is not named (#1079).
 * A source both busy and left out (two stores) is named as left out.
 */
function leftOutSources(
  skipped: readonly { corpusId: string; reason: string }[],
  excluded: ReadonlySet<string> | undefined,
  unmounted: ReadonlySet<string> | undefined,
  sourceName: ((corpusId: string) => string | undefined) | undefined,
): { leftOut: string[]; busy: string[] } {
  const leftOut = new Set<string>();
  const busy = new Set<string>();
  for (const skip of skipped) {
    if (IN_SCOPE_SKIPS.has(skip.reason)) continue;
    if (skip.reason === 'no_adapter' && (excluded?.has(skip.corpusId) || unmounted?.has(skip.corpusId))) continue;
    let name: string | undefined;
    try {
      name = sourceName?.(skip.corpusId);
    } catch {
      name = undefined;
    }
    (skip.reason === 'lane_timeout' ? busy : leftOut).add(name ?? 'One source');
  }
  for (const name of leftOut) busy.delete(name);
  return { leftOut: [...leftOut].sort(), busy: [...busy].sort() };
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
