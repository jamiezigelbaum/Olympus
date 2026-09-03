/**
 * Seams for the source-neutral file-extraction factory.
 *
 * TYPES ONLY. No runtime code, no constants, no regular expressions.
 *
 * Every module in this directory is enrolled in the architecture guard's
 * source-agnostic file list, so nothing here may name a concrete source
 * family. Corpus ids, provider ids, account scopes and approved scope keys all
 * arrive as DATA at run time; they are never spelled out in this module, not
 * even as illustrative examples. An example that reads like configuration is
 * exactly what that guard exists to catch.
 *
 * The same guard rejects a one-line doc comment anywhere in this directory:
 * its regex-literal heuristic reads `/** text *\/` on a single line as a
 * regex. Doc comments here are always multi-line blocks.
 *
 * Three seams live here:
 *
 *   1. `FileExtractionSource` — what one connector family implements to feed
 *      the factory: enumerate candidates, fetch bytes, optionally verify them.
 *      Everything family-shaped (path resolution, provider download argument
 *      construction, family-specific content hashing) hides behind it.
 *   2. `Extractor` + `ExtractorRegistry` — how bytes become text plus
 *      structural provenance, dispatched through an explicit registry instead
 *      of by substring-matching a free-form kind string.
 *   3. `ExtractionSink` — how extracted text reaches the shared connector
 *      store, as an enrichment of an item that already exists there.
 *
 * The ordering those seams imply, and the only correct one: metadata sync
 * (connector) then extraction (factory) then embedding. The item must already
 * be in the store before the factory can attach text to it.
 */

import type { SourceItemIdentity } from '../../core/source-index/types.ts';

// --- Seam 1: the source ----------------------------------------------------

/**
 * Identity of one extractable item: corpus plus item identity, nothing else.
 *
 * Deliberately path-free. The queue that carries these refs no longer lives
 * inside a content store, so it cannot hold a foreign key into one, and it
 * must not learn any family's addressing scheme. Every optional field here is
 * metadata the enumerating source already has in hand at enqueue time.
 */
export interface ExtractionItemRef {
  /**
   * Corpus this item belongs to. Supplied as data by the calling lane.
   */
  corpusId: string;
  /**
   * Provider id exactly as the connector store records it.
   */
  provider: string;
  /**
   * Account partition within the provider.
   */
  accountScope: string;
  /**
   * Opaque lane-scoping key. The factory hashes it before reporting it.
   */
  approvedScopeKey: string;
  /**
   * The provider's own id for this item.
   */
  providerItemId: string;
  /**
   * Joins connector-store `items.local_item_id`. The factory's only join key.
   */
  localItemId: string;
  /**
   * Provider-side version marker for the bytes. Generalizes the per-family
   * revision id that older queues carried under a family-specific name, and
   * lines up with the store's `items.source_version`.
   */
  sourceVersion?: string;
  /**
   * Provider-supplied content digest, when the family offers one.
   */
  contentHash?: string;
  name?: string;
  mimeType?: string;
  sizeBytes?: number;
}

/**
 * Bytes for one item, however the source obtained them.
 */
export interface FetchedBytes {
  bytes: Uint8Array;
  mimeType?: string;
  sizeBytes?: number;
}

/**
 * Bounded, cursored candidate enumeration for enqueue.
 */
export interface ExtractionCandidateListOptions {
  limit: number;
  cursor?: string;
  mimeTypes?: readonly string[];
  approvedScopeKeys?: readonly string[];
}

export interface ExtractionCandidatePage {
  candidates: readonly ExtractionItemRef[];
  nextCursor?: string;
  done: boolean;
}

export interface ExtractionFetchOptions {
  maxBytes?: number;
}

/**
 * What a connector family implements to feed the factory. Two required
 * methods; the third is optional because not every family can verify bytes
 * against a digest it did not compute itself.
 */
export interface FileExtractionSource {
  /**
   * Stable id for this source instance. Data, chosen by the wiring layer.
   */
  readonly id: string;
  readonly corpusId: string;
  readonly provider: string;
  /**
   * Candidate enumeration for enqueue. Bounded and cursored.
   */
  listCandidates(options: ExtractionCandidateListOptions): Promise<ExtractionCandidatePage>;
  /**
   * Bytes for one item: provider download, local mount, or both.
   */
  fetch(ref: ExtractionItemRef, options: ExtractionFetchOptions): Promise<FetchedBytes>;
  /**
   * Optional: verify fetched bytes against the ref's `contentHash`.
   */
  verifyBytes?(ref: ExtractionItemRef, bytes: Uint8Array): boolean;
}

// --- Shared job vocabulary -------------------------------------------------

/**
 * Whether this item's content may leave the machine, decided at enqueue by the
 * enumerating source and re-stamped by the retarget and requalify passes. The
 * live trust-tier check happens separately, immediately before dispatch to any
 * `approved_remote` extractor.
 */
export type ExtractionPolicyDecision =
  | 'index_allowed'
  | 'index_redacted'
  | 'metadata_only'
  | 'blocked_sensitive'
  | 'needs_review';

/**
 * Statuses a job can come to rest in.
 */
export type ExtractionTerminalStatus =
  | 'indexed'
  | 'metadata_only'
  | 'skipped_unsupported'
  | 'skipped_too_large'
  | 'blocked_policy'
  | 'failed_retryable'
  | 'failed_terminal';

/**
 * Every value the job row's `status` column may hold.
 */
export type ExtractionJobStatus = 'queued' | 'leased' | ExtractionTerminalStatus;

/**
 * Whether an extractor's work stays on this machine or crosses an approved
 * remote boundary. The runner consults this, and only this, to decide whether
 * the egress policy gate applies.
 */
export type ExtractionEgress = 'local' | 'approved_remote';

export type ExtractionApprovedRemoteDestination =
  | 'venice_private'
  | 'venice_tee'
  | 'venice_e2ee'
  | 'venice_mixed_approved';

/**
 * The remote-egress gate, expressed without reading any family's own
 * classification tables. `maxTrustTierForRemote` is checked live against the
 * connector store's authoritative `items.trust_tier`; `allowDefaultDeferred`
 * is carried on the job row as its `ExtractionPolicyDecision`.
 */
export interface ExtractionEgressPolicy {
  maxTrustTierForRemote: 'S3' | 'S4';
  allowDefaultDeferred: boolean;
}

// --- Seam 2: the extractor registry ---------------------------------------

/**
 * Structural shape of one derived artifact.
 */
export type ExtractionArtifactKind =
  | 'document'
  | 'page'
  | 'sheet'
  | 'slide'
  | 'transcript'
  | 'image_description';

/**
 * Structural provenance for a slice of the extracted text. This never reaches
 * the shared store: it lives on the job side, keyed by corpus and item, and is
 * joined back when a consumer asks how a document was read.
 */
export interface ExtractionDerivation {
  artifactKind: ExtractionArtifactKind;
  /**
   * Free-form structural pointer, for instance a page or sheet index.
   */
  structuralRef?: Readonly<Record<string, unknown>>;
  confidence?: number;
  warnings?: readonly string[];
  chars: number;
}

/**
 * The leased job an extractor is running against.
 */
export interface ExtractorJobContext {
  jobId: string;
  extractorKind: string;
  extractorVersion: string;
  policyDecision: ExtractionPolicyDecision;
  /**
   * Attempt number of this lease, already incremented by the claim.
   */
  attempts: number;
  maxBytesPerFile?: number;
  leaseExpiresAt: string;
}

/**
 * Input to one extraction attempt.
 *
 * `bytes` is present whenever the selected extractor declares `needsBytes`.
 * `localPath` is the temp file those bytes were spilled to; extractors that
 * shell out to a local command consume the path rather than the buffer, so
 * both may be present for the same attempt.
 */
export interface ExtractorInput {
  ref: ExtractionItemRef;
  job: ExtractorJobContext;
  bytes?: Uint8Array;
  localPath?: string;
  mimeType?: string;
  sizeBytes?: number;
}

/**
 * The extractor produced usable text.
 *
 * `text` is required. Empty text is NOT this case — see
 * `ExtractorEmptyOutput`.
 */
export interface ExtractorIndexedOutput {
  status: 'indexed';
  text: string;
  derivations?: readonly ExtractionDerivation[];
  warnings?: readonly string[];
  egressDestination?: ExtractionApprovedRemoteDestination;
  errorKind?: never;
}

/**
 * The extractor ran to completion and produced nothing usable.
 *
 * This is a first-class outcome rather than a success carrying an empty
 * string, and that distinction is load-bearing: writing undefined or
 * whitespace-only text through the sink DELETES the item's existing chunks,
 * because the store's text-indexing path reads empty text as "remove the
 * representation". The runner must settle this case with the anti-clobber rule
 * BEFORE the sink is reached — empty output never replaces non-empty stored
 * text — so the store is never asked to be careful on the factory's behalf.
 *
 * Because only `ExtractorIndexedOutput` carries `text`, an empty result cannot
 * even be shaped into an `ExtractionSinkRequest`.
 */
export interface ExtractorEmptyOutput {
  status: 'empty_output';
  derivations?: readonly ExtractionDerivation[];
  warnings?: readonly string[];
  egressDestination?: ExtractionApprovedRemoteDestination;
  text?: never;
  errorKind?: never;
}

/**
 * The extractor declined the item, without failing.
 */
export interface ExtractorNonTextOutput {
  status: 'metadata_only' | 'skipped_unsupported' | 'skipped_too_large';
  derivations?: readonly ExtractionDerivation[];
  warnings?: readonly string[];
  egressDestination?: ExtractionApprovedRemoteDestination;
  text?: never;
  errorKind?: never;
}

/**
 * The extractor failed. `errorKind` is a bounded categorical token, never
 * free-form error text: the job side DB stores kinds and hashes only.
 */
export interface ExtractorFailureOutput {
  status: 'failed_retryable' | 'failed_terminal';
  errorKind: string;
  warnings?: readonly string[];
  egressDestination?: ExtractionApprovedRemoteDestination;
  text?: never;
  derivations?: never;
}

export type ExtractorOutput =
  | ExtractorIndexedOutput
  | ExtractorEmptyOutput
  | ExtractorNonTextOutput
  | ExtractorFailureOutput;

export interface Extractor {
  /**
   * Stable dispatch id. Matches the kind strings already enqueued today.
   */
  readonly kind: string;
  readonly version: string;
  readonly needsBytes: boolean;
  readonly egress: ExtractionEgress;
  readonly approvedRemoteDestination?: ExtractionApprovedRemoteDestination;
  accepts(mimeType: string | undefined, name?: string): boolean;
  extract(input: ExtractorInput): Promise<ExtractorOutput>;
}

export interface ExtractorRegistry {
  get(kind: string): Extractor | undefined;
  /**
   * Explicit selection, replacing today's substring matching on kind strings.
   */
  select(ref: ExtractionItemRef, requestedKind?: string): Extractor | undefined;
  list(): readonly Extractor[];
}

/**
 * Vision-model client seam. Tests supply a fake; wiring supplies a client.
 */
export interface VlmDescribeRequest {
  bytes: Uint8Array;
  mimeType: string;
  prompt: string;
  maxOutputChars: number;
  maxTokens?: number;
}

export interface VlmDescribeResult {
  text: string;
  confidence?: number;
  warnings?: readonly string[];
  egressDestination?: ExtractionApprovedRemoteDestination;
}

export interface VlmProbeRequest {
  timeoutMs?: number;
}

export interface VlmClient {
  readonly approvedRemoteDestination?: ExtractionApprovedRemoteDestination;
  describe(request: VlmDescribeRequest): Promise<VlmDescribeResult>;
  /**
   * Health probe. A backend that rejects a malformed image starves the lane.
   */
  probe?(request?: VlmProbeRequest): Promise<void>;
  /**
   * Optional backend-hygiene hook: unload the model between page batches.
   */
  recycle?(): Promise<void>;
}

/**
 * Per-extractor construction knobs. Every value is a constructor option, never
 * an environment read: the environment surface stays in the wiring layer so
 * this directory can be exercised entirely from unit tests.
 */
export interface ExtractorRegistryConfig {
  text?: {
    pdfTextCommand?: string;
    pdfTextTimeoutMs?: number;
    maxBoundedTextChars?: number;
  };
  ocr?: {
    ocrTimeoutMs?: number;
    pdfRenderTimeoutMs?: number;
  };
  vlmPdf?: {
    client?: VlmClient;
    maxPages?: number;
    maxTokens?: number;
    maxRequestBytes?: number;
    pageRetries?: number;
    pageRetryDelayMs?: number;
    recycleEveryNPages?: number;
    healthcheckTimeoutMs?: number;
    prompt?: string;
  };
  vlm?: {
    client?: VlmClient;
    prompt?: string;
  };
  /**
   * The approved-remote lane.
   */
  remote?: {
    client?: VlmClient;
    prompt?: string;
    model?: string;
  };
  transcription?: {
    command?: string;
    timeoutMs?: number;
    maxTranscriptChars?: number;
  };
}

// --- Seam 3: the sink ------------------------------------------------------

/**
 * The representation expectation the sink hands the connector store.
 *
 * Both hashes are computed from the SAME extracted text the sink is about to
 * write, using the store's own chunking (4,000 characters, no overlap):
 *
 *   contentHash        = hash(text)
 *   chunkContentHashes = chunk(text).map(hash)
 *
 * Any other derivation makes the store's coverage short-circuit disagree with
 * what was actually stored.
 */
export interface ExtractionRepresentationExpectation {
  sourceItem: SourceItemIdentity;
  sourceVersion?: string;
  contentHash: string;
  chunkContentHashes: readonly string[];
  /**
   * Structurally forbidden, and typed `never` so an attempt is a compile error
   * rather than a silent mismatch.
   *
   * The embedding input hash is a DIFFERENT hash: the store seasons each chunk
   * with the stored item row before hashing it, so the value can only be
   * derived inside the store. The factory must never try to supply it.
   */
  embeddingInputHash?: never;
}

/**
 * The claim this text was produced under.
 *
 * The first two fields are needed and neither is sufficient. The token alone
 * identifies a claim CALL, and one call claims a whole batch, so a token that
 * is still live for some other job in the batch says nothing about this one.
 * The job id alone identifies the row, which a recycle can hand to somebody
 * else without changing its name. The pair is what names a generation.
 *
 * The grant is what makes a generation COMPARABLE. Asking the queue whether a
 * claim still holds is a read of another database, so the answer is stale the
 * instant it is given; an ordered grant lets the store that receives the text
 * decide, inside its own write transaction, whether this generation is newer
 * than the one whose content it is about to replace. Ordinals are only
 * comparable within the same authority.
 */
export interface ExtractionClaim {
  jobId: string;
  leaseToken: string;
  grantAuthority: string;
  grantOrdinal: number;
}

/**
 * Answers one question about the CURRENT state of the job database: does this
 * claim still hold its job?
 *
 * A narrow port rather than the job store itself, so the fence is testable as
 * a boundary and so the sink takes on no queue dependency beyond this.
 */
export interface ExtractionClaimReader {
  holdsExtractionClaim(claim: ExtractionClaim): boolean;
}

/**
 * One accepted extraction, on its way into the shared store.
 *
 * `text` is required and non-empty by construction: only
 * `ExtractorIndexedOutput` carries text, so a request cannot be built from an
 * empty, skipped or failed extraction.
 */
export interface ExtractionSinkRequest {
  ref: ExtractionItemRef;
  text: string;
  extractorKind: string;
  extractorVersion: string;
  /**
   * When the bytes behind this text were fetched.
   */
  fetchedAt: string;
  derivations?: readonly ExtractionDerivation[];
  metadata?: Readonly<Record<string, unknown>>;
  /**
   * The claim this text was produced under, carried to the corpus mutation
   * boundary so a superseded generation can be refused BEFORE it writes.
   *
   * Optional because a sink with no claim reader wired behind it cannot use it
   * and every other caller of this seam has no queue at all. When both are
   * present the fence engages; when either is missing the write proceeds as it
   * always did, and the job store's own fence stays the backstop.
   */
  claim?: ExtractionClaim;
}

export interface ExtractionSinkResult {
  accepted: boolean;
  chunksIndexed: number;
  chunksAwaitingEmbedding: number;
  /**
   * Categorical token when `accepted` is false. Never free-form error text.
   */
  skippedReason?: string;
}

/**
 * Where accepted text goes. The only sanctioned way to attach text to an item
 * that already exists in the shared store; the sink enriches, it never
 * creates, and it refuses an item whose trust tier forbids stored text.
 */
export interface ExtractionSink {
  accept(request: ExtractionSinkRequest): Promise<ExtractionSinkResult>;
}
