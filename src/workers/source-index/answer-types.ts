// Castor-visible wire types for the `source_answer` operation.
//
// Extracted from the old template path (answer.ts) before the Lane F deletion
// milestone: these shapes are the durable surface contract implemented by the
// analyst-backed handler. Changing these shapes changes what Castor sees —
// treat with the same care as the OPSEC policy fields they carry.

import type { OpsecReleaseAudit, SourceInstructionFlag } from '../../core/opsec.ts';
import type {
  RetrievalDegradationReason,
  RetrievalLaneAudit,
  RetrievalLaneType,
  SourceTrustDomain,
} from '../../core/source-index/types.ts';

// Which analyst reasoned over the pack. Counts/observability only — no content.
// 'local' = Argus on Delphi/local models; 'venice' = explicitly requested
// approved encrypted-cloud escalation; 'cloud' = ordinary cloud analyst for
// internal/public packs only.
export type AnalystBackend = 'local' | 'venice' | 'cloud';
export type SourceAnswerAnalystProvider = 'default' | 'local' | 'venice' | 'cloud';

export interface SourceIndexAnswerRequest {
  question: string;
  query?: string;
  account?: string;
  corpus_id?: string;
  corpus_ids?: string[];
  approved_scope_key?: string;
  chat_scope?: string;
  conversation_id?: string;
  sender_id?: string;
  sender_label?: string;
  authored_after?: string;
  authored_before?: string;
  selected_items?: SourceAnswerSelectedItem[];
  retrieval_mode?: 'keyword' | 'hybrid';
  analyst_provider?: SourceAnswerAnalystProvider;
  analyst_model?: string;
  max_results?: number;
  include_secure_local?: boolean;
  include_secure_local_content?: boolean;
  include_internal?: boolean;
  include_internal_content?: boolean;
  internal_content_max_bytes?: number;
  timeout_ms?: number;
}

export interface SourceAnswerSelectedItem {
  corpus_id: string;
  family: string;
  provider: string;
  account_scope: string;
  provider_item_id: string;
  local_item_id: string;
  provider_thread_id?: string;
  provider_conversation_id?: string;
  provider_file_id?: string;
  source_version?: string;
  title?: string;
  conversation_label?: string;
  author_label?: string;
  uri?: string;
  authored_at?: string;
  updated_at?: string;
}

export interface SourceIndexAnswerResult {
  answer: string;
  evidence: SourceIndexAnswerEvidence[];
  audit: {
    searched_corpora: string[];
    skipped_corpora: SourceIndexAnswerSkippedCorpus[];
    lane_audits: RetrievalLaneAudit[];
    // Present only when a lane actually dropped out. Counts-only: which lane,
    // why, how many of this answer's retrieval runs hit it. It is what lets a
    // caller tell "keyword-only because that is all this corpus has" from
    // "the semantic lane timed out" — two states that used to produce the
    // identical keyword-shaped answer with nothing to distinguish them.
    retrieval_degradations?: SourceIndexAnswerRetrievalDegradation[];
    // Present only when the search returned nothing AND some searched corpus
    // holds documents that could not be read. Counts-only, same reasoning as
    // retrieval_degradations above: "I could not find that" over a corpus read
    // in full and the same sentence over a corpus with unread pages are two
    // different facts that otherwise produce a byte-identical answer.
    corpus_readability?: SourceIndexAnswerCorpusReadability[];
    self_heal?: SourceIndexAnswerSelfHealAudit;
    answer_synthesis: {
      private_context_used: boolean;
      secure_local_items_consulted: number;
      internal_content_used: boolean;
      internal_items_consulted: number;
      internal_content_failures: number;
      // Which analyst served this answer (counts/observability only, never
      // content). 'cloud' is only ever possible when no secure_local candidate
      // is in the pack. 'venice' is only possible when explicitly selected as
      // approved encrypted-cloud escalation.
      analyst_backend: AnalystBackend;
      requested_analyst_provider?: SourceAnswerAnalystProvider;
      requested_analyst_model?: string;
      analyst_fallback?: SourceIndexAnalystFallback;
      raw_source_exposed: false;
    };
    latency_ms: number;
    phase_timings?: SourceIndexAnswerPhaseTimings;
    raw_source_exposed: false;
  };
  policy: {
    raw_source_exposed: false;
    source_packets_exposed: false;
    internal_content_exposed: boolean;
    secure_local_content_exposed: boolean;
    castor_safe_bridge: true;
  };
  internal_context?: SourceIndexInternalContext;
  opsec: OpsecReleaseAudit;
}

export interface SourceIndexAnswerSelfHealAudit {
  attempted: boolean;
  corpus_id?: string;
  entry_id_hash?: string;
  provider_file_id_hash?: string;
  prior_state?: {
    extraction_status?: string;
    extraction_completeness?: string;
  };
  action?: 'forced_reextract';
  outcome: 'healed' | 'in_progress' | 'failed' | 'skipped';
  retry_after_ms?: number;
  reason?: string;
  error_kind?: string;
  error_hash?: string;
}

export interface SourceIndexAnswerPhaseTimings {
  lane_setup_ms: number;
  bulk_gate_ms: number;
  evidence_pack_ms?: number;
  self_heal_ms?: number;
  analyst_ms?: number;
  release_gate_ms?: number;
  total_ms: number;
}

export interface SourceIndexAnalystFallback {
  from: Exclude<AnalystBackend, 'local'>;
  to: 'local';
  reason: 'timeout' | 'escalation' | 'unavailable' | `${Exclude<AnalystBackend, 'local'>}_${string}`;
  elapsed_ms?: number;
  timeout_ms?: number;
}

export interface SourceIndexAnswerEvidence {
  corpus_id: string;
  trust_domain: SourceTrustDomain;
  family: string;
  provider: string;
  provider_item_id: string;
  provider_thread_id?: string;
  provider_conversation_id?: string;
  provider_file_id?: string;
  folder_names?: string[];
  title?: string;
  source_label?: string;
  conversation_label?: string;
  author_label?: string;
  uri?: string;
  authored_at?: string;
  updated_at?: string;
  // Offset-level support locator. Absent when no lane could produce one.
  citation_span?: SourceIndexAnswerCitationSpan;
}

export interface SourceIndexAnswerSkippedCorpus {
  corpus_id: string;
  trust_domain: SourceTrustDomain;
  reason: string;
}

export interface SourceIndexAnswerRetrievalDegradation {
  lane_name: string;
  lane_type: RetrievalLaneType;
  reason: RetrievalDegradationReason;
  // A further stable enum token from the detecting layer. Never free text.
  detail?: string;
  occurrences: number;
}

/**
 * Where inside the cited item the support sits.
 *
 * Offsets only — the chunk's bounded text stays behind the membrane, and these
 * numbers are what let a caller locate the span without carrying it. `lane`
 * says how precise the span is: a keyword lane narrows to the matched terms, a
 * semantic lane claims the whole winning chunk because a chunk-level cosine
 * cannot justify anything tighter.
 */
export interface SourceIndexAnswerCorpusReadability {
  corpus_id: string;
  // Documents extracted with durable gaps inside them (unread pages).
  partial_documents: number;
  // Documents carrying no extracted text at all, for any reason.
  unread_documents: number;
}

export interface SourceIndexAnswerCitationSpan {
  chunk_index: number;
  chunk_id: string;
  // Inclusive start offset within the chunk's bounded text.
  char_start: number;
  // Exclusive end offset within the chunk's bounded text.
  char_end: number;
  // The same span in the item's bounded-text coordinates.
  item_char_start: number;
  item_char_end: number;
  chunk_chars: number;
  lane: 'keyword' | 'semantic';
}

export interface SourceIndexInternalContext {
  kind: 'internal_document_context';
  trust_domain: 'internal';
  warning: string;
  total_chars: number;
  items: SourceIndexInternalContextItem[];
}

export interface SourceIndexInternalContextItem {
  corpus_id: string;
  provider: string;
  provider_file_id?: string;
  provider_message_id?: string;
  provider_conversation_id?: string;
  provider_post_id?: string;
  title?: string;
  source_label?: string;
  uri?: string;
  folder_names?: string[];
  authored_at?: string;
  updated_at?: string;
  passage: string;
  passage_chars: number;
  truncated: boolean;
  passage_withheld?: boolean;
  withheld_reason?: 'source_instruction_flags';
  source_instruction_flags: SourceInstructionFlag[];
}

export interface SourceIndexAnswerHandler {
  answer(request: SourceIndexAnswerRequest): Promise<SourceIndexAnswerResult>;
}
