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

export interface RawItem {
  identity: SourceItemIdentity;
  mimeType: string;
  content: RawItemContent;
  metadata: Readonly<Record<string, unknown>>;
  fetchedAt: string;
}

export interface SourceConnectorListOptions {
  cursor?: string;
  limit?: number;
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
  fetchItem(localItemId: string): Promise<RawItem>;
  classificationSignals(item: RawItem): SourceClassificationSignals;
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
