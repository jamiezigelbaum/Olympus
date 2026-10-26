// Stable, versioned architecture contracts for the Olympus source pipeline.
//
// These three interfaces are the only boundaries between the source-agnostic
// capabilities (normalize, extract, index, retrieve, reason, release). The
// load-bearing decision they encode: organize by CAPABILITY, not by source.
// A source is a thin adapter (SourceConnector); everything downstream is
// written once and shared.
//
// Ordinary changes implement these interfaces. Semantic shape changes require
// a version increment plus compatibility/migration, held-out eval, and review
// receipts in config/source-pipeline-contract-version.json. No change may
// invent parallel types or branch on a specific source/question downstream of
// SourceConnector.
//
// Version 2.2.0 (docs/design/archive-live-one-dataset.md) lets a source's one
// connector read more than one input: the live reader and each imported
// archive, each with its own cursor, through the same record-to-item code, with
// a per-record intake rule decided against what the store holds and a
// per-item hold until the private model has judged. 2.1.0 added child items;
// 2.0.0 moved the tier decision out of the connector.

import type {
  SourceFamily,
  SourceIndexProvenance,
  SourceItemIdentity,
  SourceTrustDomain,
  SourceTrustTier,
} from './source-index/types.ts';
import type { StructuredEvidenceFact } from './opsec.ts';

// --- Contract 1: SourceConnector ------------------------------------------
// The ONLY per-source code. ~300 lines per source, not 6,000. Emits a
// normalized RawItem plus the classification SIGNALS the provider knows about
// it. Since 2.0.0 a connector no longer decides a tier: the shared,
// source-agnostic tier classifier does, from these signals and the item's text
// (docs/design/per-item-four-tier-classification.md, section 6).

export type RawItemContent =
  | { kind: 'text'; text: string }
  | { kind: 'bytes'; mimeType: string; bytes: Uint8Array }
  | { kind: 'metadata_only' };

// How to read a child item's bytes later (2.1.0, docs/design/child-items.md).
// `locator` is opaque outside the connector that wrote it and is bound to the
// version it was written for: it holds whatever that connector needs to read
// the bytes again after a restart. `sizeBytes` is the size the SOURCE states,
// checked again while reading. `available: false` means the source says the
// bytes are not there, so the child is listed by name and never read.
export interface RawItemDeferredBytes {
  locator: string;
  available: boolean;
  sizeBytes?: number;
}

// What `fetchItem` gets besides the item id (2.1.0): the persisted locator of
// a child whose bytes were deferred, read fresh from the store at fetch time.
export interface SourceConnectorFetchOptions {
  deferredBytes?: { locator: string };
}

export interface RawItem {
  identity: SourceItemIdentity;
  mimeType: string;
  content: RawItemContent;
  metadata: Readonly<Record<string, unknown>>;
  fetchedAt: string;
  deferredBytes?: RawItemDeferredBytes;
  // 2.2.0: this item's content stays Private until the private model has judged
  // it (docs/design/archive-live-one-dataset.md, section 3). Placement honours
  // it exactly as it honours the lane option of the same name, through first
  // classification and child extraction, and the persisted hold keeps applying
  // to the item's later versions until it has been judged. An item built only
  // from live records never carries it.
  holdContentUntilJudged?: true;
}

// 2.2.0: what the store holds of one item, as the store lane tells the
// connector before it builds the item. `version` is the newest
// `identity.sourceVersion` any row of the item holds, by the connector's own
// order (the lookup is given it); `hasContent` is whether the item's rows at
// that version hold content (chunks), as against its names alone. Absent only
// when the store holds no row of the item at all: a tombstoned row (deleted,
// or a Secret kept as a location only) and a row on one leg alone are still
// the item's, so the version boundary never depends on how completely the
// item was written or whether its row is visible.
//
// `incomplete` says the item is not whole at its newest version: an older or
// unversioned row is still active beside it, or a leg that should hold it has
// no active row, or a body is still owed to a leg. A record of that version or a
// newer one completes it; an older one never applies, except the record whose
// body is owed (`owedBodyVersion`, older than `version` when a newer names-only
// record took an older record's body): replaying it finishes the write. `tombstoned` says the rows at the newest version
// are all tombstones (deleted, or a Secret kept as a location): only a newer
// record, or live's own word at the same version, brings the item back.
export interface StoredItemState {
  version?: string;
  hasContent: boolean;
  incomplete?: true;
  owedBodyVersion?: string;
  tombstoned?: true;
}

// 2.2.0: looks up one item in the store set the listing writes into. The
// connector gives its own order of versions, which only it can say.
export type StoredItemLookup = (
  identity: Pick<SourceItemIdentity, 'provider' | 'accountScope' | 'providerItemId' | 'providerConversationId'>,
  compareVersions: (a: string, b: string) => number,
) => StoredItemState | undefined;

export interface SourceConnectorListOptions {
  cursor?: string;
  limit?: number;
  // 2.2.0: the store lane's lookup of the stored version, given to a listing
  // so the connector can decide, per record and before it builds the item,
  // whether the record applies. Absent where no store is behind the listing.
  storedItem?: StoredItemLookup;
}

// 2.2.0: a source's records as its live reader writes them (a Telegram message
// record, a WhatsApp bridge record, a parsed mail). The shape is the
// connector's own and opaque to everything else. The two arms mirror
// SourceConnectorListPage: a truncated page is a prefix, and its `nextCursor`
// resumes inside the same provider page.
export type SourceRecordPage<R = unknown> =
  | { records: readonly R[]; nextCursor?: string; done: boolean; truncated?: false }
  | { records: readonly R[]; nextCursor?: string; done: false; truncated: true };

export type SourceInputKind = 'live' | 'archive';

// 2.2.0: one way records reach a source's one connector. The live reader is one
// input; each imported archive is another, emitting the live reader's own
// record shape. Each input keeps its own cursor under its own `inputId` (the
// connector id sync runs record it under), so an archive never moves the live
// cursor. Inputs live below `RawItem`: nothing downstream learns which input an
// item came from.
export interface SourceConnectorInput<R = unknown> {
  readonly inputId: string;
  readonly kind: SourceInputKind;
  records(options?: { cursor?: string; limit?: number }): AsyncIterable<SourceRecordPage<R>>;
}

// `truncated` means the connector cut the page short of what the provider
// actually returned — a run budget ran out mid-page — so `items` is a prefix
// and the rest of that provider page is still unread. `done` means the
// traversal reached the end of the provider's data.
//
// The two are mutually exclusive, and the union enforces it rather than
// leaving it to a runtime check: there is no arm with `done: true` and
// `truncated: true`. A connector that truncates must yield `done: false` and a
// `nextCursor` that resumes INSIDE the same provider page.
//
// This is a type, not a style preference. On 2026-07-28 the Readwise export
// lane reported a locally-sliced page as `done`, the spine cleared the
// checkpoint on it, and every pull restarted at page 1 — so only the first
// slice of the export was ever reachable. The illegal state is what made that
// possible, so the illegal state is now unconstructable.
export type SourceConnectorListPage =
  | { items: readonly RawItem[]; nextCursor?: string; done: boolean; truncated?: false }
  | { items: readonly RawItem[]; nextCursor?: string; done: false; truncated: true };

// Tier keys use the schema-v1 stored names (TRUST_MODEL.md, "Product tier
// names"): public = Public, private = Personal, secure = Private,
// secrets = Secrets. Display names never appear in stored or typed values.
export type SourceClassificationTier = 'public' | 'private' | 'secure' | 'secrets';

// A provider fact that sets a MINIMUM tier, e.g. a Telegram Secret Chat is at
// least Private. `basis` is a content-free code naming the fact.
export interface SourceClassificationFloor {
  tier: SourceClassificationTier;
  basis: string;
}

// A configured resting tier for the item (a chat-level or source-level rule).
// `prior` sets where the item rests; item-level raises still apply and no
// automatic signal lowers it. `force` is final except for Secrets and an
// explicit per-item owner override.
export interface SourceClassificationPrior {
  tier: SourceClassificationTier;
  strength: 'prior' | 'force';
  basis: string;
}

// Deterministic sharing evidence. Only `public_link` and `published` are
// positive evidence for Public; `unknown` and absence are never evidence.
export type SourceSharingState = 'public_link' | 'published' | 'shared' | 'private' | 'unknown';

export type SourceConversationKind = 'direct' | 'group' | 'channel' | 'secret_chat';

// Source facts only. No field here is a tier decision; the shared classifier
// turns them into one. Names (title, path, folderKeys, sender, recipients,
// labels) are classifier INPUT and are never written to the tier ledger.
export interface SourceClassificationSignals {
  floor?: SourceClassificationFloor;
  prior?: SourceClassificationPrior;
  sharing?: SourceSharingState;
  title?: string;
  path?: string;
  folderKeys?: readonly string[];
  sender?: string;
  recipients?: readonly string[];
  labels?: readonly string[];
  conversationKind?: SourceConversationKind;
}

export interface SourceConnector {
  readonly id: string;
  readonly family: SourceFamily;
  authenticate(): Promise<void>;
  listItems(options?: SourceConnectorListOptions): AsyncIterable<SourceConnectorListPage>;
  fetchItem(localItemId: string, options?: SourceConnectorFetchOptions): Promise<RawItem>;
  classificationSignals(item: RawItem): SourceClassificationSignals;
  // 2.2.0: a source that reads more than one input returns a connector for one
  // of them: its id is the input's, its listing reads that input's records, and
  // it builds every item with this connector's own record-to-item code. The
  // only writer of the source's items stays this connector's code.
  forInput?(input: SourceConnectorInput): SourceConnector;
}

// --- Contract 2: EvidencePack ---------------------------------------------
// The retrieval -> reasoning boundary. Source-agnostic. `coverage` is
// first-class: it is how the assistant can be "complete" or report an honest
// gap instead of silently returning partial truth. `facts` are cached derived
// evidence handed to the analyst, NEVER the answer itself.

export interface EvidenceTableBlock {
  caption?: string;
  columns: readonly string[];
  rows: readonly (readonly string[])[];
}

export interface EvidenceCandidate {
  provenance: SourceIndexProvenance;
  trustTier: SourceTrustTier;
  trustDomain: SourceTrustDomain;
  chunks: readonly string[];
  tables?: readonly EvidenceTableBlock[];
  facts?: readonly StructuredEvidenceFact[];
  score?: number;
}

export interface EvidenceCoverageSkip {
  corpusId: string;
  reason: string;
}

// Breadth of one searched corpus's match set, counts only (v1.1.0). The pack
// carries a bounded slice of the evidence; this is how the Analyst can say
// "23 emails and 6 files match; the most relevant are..." instead of mistaking
// the slice for the whole. `atLeast` marks a count that stopped at the
// adapter's probe ceiling.
export interface EvidenceCoverageMatchCount {
  corpusId: string;
  family: SourceFamily;
  matchedItems: number;
  contentMatchedItems: number;
  atLeast: boolean;
  inEvidence: number;
}

export interface EvidenceCoverage {
  searchedCorpora: readonly string[];
  skippedCorpora: readonly EvidenceCoverageSkip[];
  extractionGaps: readonly string[];
  matchCounts?: readonly EvidenceCoverageMatchCount[];
}

export interface EvidencePack {
  question: string;
  candidates: readonly EvidenceCandidate[];
  coverage: EvidenceCoverage;
  builtAt: string;
}

// --- Contract 3: Analyst --------------------------------------------------
// Replaces every synthesizeSafe* template and every query regex. One generic
// prompt: answer from this evidence only, cite each claim, state what you
// could not find. NO per-question or per-source logic. `localOnly` routing is
// governed by docs/CONTRACTS.md#venice-s4-policy-normative.
//
// Escalation: when localOnly and the local model cannot produce any grounded
// answer, the analyst returns an `escalation` proposal carrying a redacted pack
// (bounded derivatives only). Grounded partial answers still return with
// unanswered gaps, because usable secure-local derivatives should flow to
// Castor by default. Provider eligibility is governed by the canonical policy
// linked above.

export interface AnalystOptions {
  localOnly: boolean;
  maxAnswerChars?: number;
}

export interface AnalystCitation {
  provenance: SourceIndexProvenance;
  claim: string;
}

export interface AnalystEscalation {
  reason: string;
  redactedPack: EvidencePack;
}

export interface AnalystResult {
  answer: string;
  citations: readonly AnalystCitation[];
  unanswered: readonly string[];
  escalation?: AnalystEscalation;
}

export interface Analyst {
  analyze(pack: EvidencePack, options: AnalystOptions): Promise<AnalystResult>;
}
