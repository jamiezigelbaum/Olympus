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
  SourceSensitivity,
  SourceTrustDomain,
  SourceTrustTier,
} from './source-index/types.ts';
import type { StructuredEvidenceFact } from './opsec.ts';

// --- Contract 1: SourceConnector ------------------------------------------
// The ONLY per-source code. ~300 lines per source, not 6,000. Emits a
// normalized RawItem; classify() is the single place where trust policy is
// allowed to be source-aware.

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

export interface SourceConnector {
  readonly id: string;
  readonly family: SourceFamily;
  authenticate(): Promise<void>;
  listItems(options?: SourceConnectorListOptions): AsyncIterable<SourceConnectorListPage>;
  fetchItem(localItemId: string): Promise<RawItem>;
  classify(item: RawItem): SourceSensitivity;
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

export interface EvidenceCoverage {
  searchedCorpora: readonly string[];
  skippedCorpora: readonly EvidenceCoverageSkip[];
  extractionGaps: readonly string[];
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
