import type { AnalystModel } from '../../core/analyst.ts';
import type { EvidenceCandidate, EvidencePack } from '../../core/contracts.ts';
import {
  createDocumentDigest,
  DOCUMENT_DIGEST_LIMITS,
  type DocumentDigestProgress,
} from '../../core/document-digest.ts';
import type { LocalContentProvider } from '../../core/evidence-pack.ts';
import type { SourceIndexCorpusDefinition } from '../../core/source-index/corpus.ts';
import type { SourceTrustDomain, SourceTrustTier } from '../../core/source-index/types.ts';
import type {
  SourceIndexCorpusSearchAdapter,
  SourceIndexDocumentMatch,
  SourceIndexSearchContext,
} from '../../core/source-index/router.ts';

const DOCUMENT_TRAVERSAL_PAGE_SIZE = 64;
const DOCUMENT_TRAVERSAL_BYTES = 1024 * 1024;
const DOCUMENT_TRAVERSAL_MS = 60_000;
const encoder = new TextEncoder();

export interface DocumentDigestRequest {
  question: string;
  query?: string;
  context: SourceIndexSearchContext;
  /** Optional stricter request cap; the internal ceiling remains 512. */
  maxDocuments?: number;
}

export interface DocumentDigestLane {
  corpus: SourceIndexCorpusDefinition;
  adapter: SourceIndexCorpusSearchAdapter;
  contentProvider: LocalContentProvider;
}

export interface DocumentDigestReference {
  corpusId: string;
  document: SourceIndexDocumentMatch;
}

export type PreparedDocumentDigest =
  | {
      kind: 'digest';
      pack: EvidencePack;
      /** Frozen admitted full-document evidence, kept local for fallback/gates. */
      snapshot: EvidencePack;
      refs: readonly DocumentDigestReference[];
      current: () => boolean;
    }
  | {
      kind: 'excerpts';
      reason: 'digest_requires_excerpts';
      snapshot: EvidencePack;
      refs: readonly DocumentDigestReference[];
      current: () => boolean;
    }
  | {
      kind: 'refused';
      reason: string;
      current: () => boolean;
    };

export interface PrepareDocumentDigestOptions {
  request: DocumentDigestRequest;
  /** Immutable admission account/grant refs checked against live authority. */
  authorized: () => boolean;
  lanesFactory: (request: DocumentDigestRequest) => readonly DocumentDigestLane[] | Promise<readonly DocumentDigestLane[]>;
  /** Composition-root built-in model only. A pooled/routed AnalystModel is refused. */
  model: AnalystModel & { readonly name: 'built_in' };
  signal?: AbortSignal;
  onProgress?: (progress: DocumentDigestProgress) => void;
}

interface BoundReference extends DocumentDigestReference {
  provider: LocalContentProvider;
  trustDomain: SourceTrustDomain;
}

export async function prepareDocumentDigest(
  options: PrepareDocumentDigestOptions,
): Promise<PreparedDocumentDigest> {
  const refs: BoundReference[] = [];
  const current = (): boolean => {
    try {
      return options.authorized() === true && refs.every(ref => ref.provider.documentCurrent?.(ref.document, ref.trustDomain) === true);
    } catch { return false; }
  };
  const refused = (reason: string): PreparedDocumentDigest => ({ kind: 'refused', reason, current });
  if (options.model.name !== 'built_in') return refused('built_in_model_required');
  if (!current()) return refused('source_changed');
  if (options.signal?.aborted) return refused('cancelled');
  const maxDocuments = normalizeDocumentLimit(options.request.maxDocuments);
  if (maxDocuments === undefined) return refused('invalid_document_limit');
  const deadlineAtMs = Date.now() + DOCUMENT_TRAVERSAL_MS;

  let lanes: readonly DocumentDigestLane[];
  try { lanes = await options.lanesFactory(options.request); } catch { return refused('lane_setup_failed'); }
  if (options.signal?.aborted) return refused('cancelled');
  if (!current()) return refused('source_changed');
  for (const lane of lanes) {
    if (!lane.adapter.documentMatches || !lane.contentProvider.fetchDocumentWindow || !lane.contentProvider.documentCurrent) {
      return refused('document_traversal_unsupported');
    }
    if (!options.request.context.allowedTrustDomains.includes(lane.corpus.trustDomain)) {
      return refused('document_match_scope_not_allowed');
    }
    let cursor: string | undefined;
    do {
      if (options.signal?.aborted) return refused('cancelled');
      if (Date.now() >= deadlineAtMs) return refused('document_traversal_timeout');
      const page = await lane.adapter.documentMatches({
        query: options.request.query?.trim() || options.request.question,
        corpus: lane.corpus,
        context: options.request.context,
        pageSize: DOCUMENT_TRAVERSAL_PAGE_SIZE,
        maxDocuments,
        ...(cursor ? { cursor } : {}),
        deadlineAtMs,
      });
      if (page.status !== 'ok') return refused(page.reason);
      for (const document of page.documents) refs.push({
        corpusId: lane.corpus.corpusId,
        document,
        provider: lane.contentProvider,
        trustDomain: lane.corpus.trustDomain,
      });
      if (refs.length > maxDocuments) return refused('document_match_limit_exceeded');
      if (!current()) return refused('source_changed');
      cursor = page.nextCursor;
      if (page.done !== (cursor === undefined)) return refused('invalid_document_cursor');
    } while (cursor);
  }

  const documents: EvidenceCandidate[] = [];
  let totalBytes = 0;
  for (const ref of refs) {
    let cursor: string | undefined;
    let text = '';
    let sensitivity: SourceTrustTier | undefined;
    let trustDomain: SourceTrustDomain | undefined;
    do {
      if (options.signal?.aborted) return refused('cancelled');
      if (Date.now() >= deadlineAtMs) return refused('document_traversal_timeout');
      const remaining = DOCUMENT_DIGEST_LIMITS.documentChars - text.length;
      if (remaining <= 0) return refused('document_limit');
      const window = await ref.provider.fetchDocumentWindow!({
        document: ref.document,
        trustDomain: ref.trustDomain,
        maxChars: Math.min(DOCUMENT_DIGEST_LIMITS.windowChars, remaining),
        ...(cursor ? { cursor } : {}),
      });
      if (!current()) return refused('source_changed');
      if (!window || window.content.namesOnly || window.content.contentPrivate || window.content.coverageGaps?.length) {
        return refused('document_content_unavailable');
      }
      if (window.content.sensitivity.trustDomain !== ref.trustDomain
        || window.content.sensitivity.trustTier === 'S5') {
        return refused('document_sensitivity_changed');
      }
      const piece = window.content.chunks.join('');
      text += piece;
      totalBytes += encoder.encode(piece).length;
      if (text.length > DOCUMENT_DIGEST_LIMITS.documentChars) return refused('document_limit');
      if (totalBytes > DOCUMENT_TRAVERSAL_BYTES) return refused('document_text_limit_exceeded');
      sensitivity = window.content.sensitivity.trustTier;
      trustDomain = window.content.sensitivity.trustDomain;
      cursor = window.nextCursor;
      if (window.done !== (cursor === undefined)) return refused('invalid_document_window_cursor');
    } while (cursor);
    if (sensitivity === undefined || trustDomain === undefined) return refused('document_content_unavailable');
    documents.push({
      provenance: ref.document.provenance,
      trustTier: sensitivity,
      trustDomain,
      chunks: [text],
    });
  }
  if (!current()) return refused('source_changed');

  const searchedCorpora = [...new Set(refs.map((ref) => ref.corpusId))];
  const coverage: EvidencePack['coverage'] = {
    searchedCorpora,
    skippedCorpora: [],
    extractionGaps: [],
    matchCounts: searchedCorpora.map((corpusId) => {
      const lane = lanes.find((candidate) => candidate.corpus.corpusId === corpusId)!;
      const count = refs.filter((ref) => ref.corpusId === corpusId).length;
      return {
        corpusId,
        family: lane.corpus.family,
        matchedItems: count,
        contentMatchedItems: count,
        atLeast: false,
        inEvidence: count,
      };
    }),
  };
  const snapshot: EvidencePack = structuredClone({
    question: options.request.question,
    candidates: documents,
    coverage,
    builtAt: new Date().toISOString(),
  });
  const publicRefs = refs.map(({ provider: _provider, trustDomain: _trustDomain, ...ref }) => ref);

  const byLocalId = new Map(refs.map((ref) => [referenceKey(ref.corpusId, ref.document.sourceItem.localItemId), ref]));
  const digest = createDocumentDigest({
    question: options.request.question,
    documents,
    model: options.model,
    ...(options.signal ? { signal: options.signal } : {}),
    eligible: async (candidate) => {
      const corpusId = candidate.provenance.localIds?.corpus_id
        ?? refs.find((ref) => ref.document.provenance === candidate.provenance)?.corpusId;
      const ref = corpusId
        ? byLocalId.get(referenceKey(corpusId, candidate.provenance.sourceItem.localItemId))
        : refs.find((entry) => entry.document.sourceItem.localItemId === candidate.provenance.sourceItem.localItemId);
      return ref?.provider.documentCurrent?.(ref.document, ref.trustDomain) === true && current();
    },
  });
  while (digest.progress().state === 'working') {
    const progress = await digest.step();
    if (!current()) return refused('source_changed');
    options.onProgress?.(progress);
    if (options.signal?.aborted) return refused('cancelled');
  }
  const result = digest.result();
  if (!result) return refused(digest.progress().reason ?? 'document_digest_failed');
  if (!await digest.validate()) return refused('source_changed');
  if (!current()) return refused('source_changed');
  if (result.kind === 'excerpts') {
    return { kind: 'excerpts', reason: 'digest_requires_excerpts', snapshot, refs: publicRefs, current };
  }

  const pack: EvidencePack = {
    ...result.pack,
    coverage,
  };
  return {
    kind: 'digest',
    pack,
    snapshot,
    refs: publicRefs,
    current,
  };
}

function normalizeDocumentLimit(value: number | undefined): number | undefined {
  if (value === undefined) return DOCUMENT_DIGEST_LIMITS.documents;
  if (!Number.isSafeInteger(value) || value <= 0) return undefined;
  return Math.min(value, DOCUMENT_DIGEST_LIMITS.documents);
}

function referenceKey(corpusId: string, localItemId: string): string {
  return `${corpusId}\u0000${localItemId}`;
}
