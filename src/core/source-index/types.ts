export const SOURCE_FAMILIES = ['email', 'file', 'chat', 'calendar', 'note', 'task', 'readwise', 'x'] as const;
export const SOURCE_TRUST_TIERS = ['S0', 'S1', 'S2', 'S3', 'S4', 'S4+', 'S5'] as const;
export const SOURCE_TRUST_DOMAINS = ['public_safe', 'internal', 'secure_local'] as const;
export const SOURCE_INDEX_STORAGE_PLACEMENTS = ['local_private', 'cloud_managed'] as const;
export const SOURCE_INDEX_STORAGE_ENGINES = ['sqlite', 'postgres'] as const;
export const SOURCE_INDEX_LEXICAL_BACKENDS = ['sqlite_fts5', 'postgres_full_text'] as const;
export const SOURCE_INDEX_VECTOR_BACKENDS = ['none', 'exact_scan', 'sqlite_vec', 'sqlite_vec1', 'pgvector'] as const;
export const SOURCE_INDEX_EMBEDDING_BACKENDS = ['none', 'local', 'cloud'] as const;

export type BuiltInSourceFamily = (typeof SOURCE_FAMILIES)[number];
export type SourceIndexExtensionId = `x-${string}`;
export type SourceFamily = BuiltInSourceFamily | SourceIndexExtensionId;

export type SourceIndexCandidateId = string | number;

export type SourceTrustTier = (typeof SOURCE_TRUST_TIERS)[number];
export type SourceTrustDomain = (typeof SOURCE_TRUST_DOMAINS)[number] | SourceIndexExtensionId;
export type SourceIndexStoragePlacement = (typeof SOURCE_INDEX_STORAGE_PLACEMENTS)[number];
export type SourceIndexStorageEngine = (typeof SOURCE_INDEX_STORAGE_ENGINES)[number];
export type SourceIndexLexicalBackend = (typeof SOURCE_INDEX_LEXICAL_BACKENDS)[number];
export type SourceIndexVectorBackend = (typeof SOURCE_INDEX_VECTOR_BACKENDS)[number];
export type SourceIndexEmbeddingBackend = (typeof SOURCE_INDEX_EMBEDDING_BACKENDS)[number];

export interface SourceItemIdentity {
  family: SourceFamily;
  provider: string;
  accountScope: string;
  providerItemId: string;
  providerThreadId?: string;
  providerConversationId?: string;
  providerFileId?: string;
  providerEventId?: string;
  localItemId: string;
  sourceVersion?: string;
}

/**
 * Where inside an item a retrieval lane found its support.
 *
 * Two coordinate spaces, both offsets-only — a span never carries the text it
 * points at, so it is safe everywhere identity is (search rows, lane audits,
 * the Castor-visible answer):
 *
 *   char*      offsets inside THIS chunk's bounded text.
 *   itemChar*  the same span in the item's bounded text, defined as the chunks
 *              concatenated in chunkIndex order. That concatenation is the
 *              store's own chunking recipe run backwards (chunks are
 *              contiguous, non-overlapping slices of the trimmed item text),
 *              so the item-level offsets are derivable rather than stored.
 *
 * `lane` records which lane produced the span, because the two have different
 * precision and a caller must not mistake one for the other. A keyword lane
 * knows the matched terms and narrows to them; a semantic lane's signal is a
 * whole-chunk cosine and it claims the whole chunk rather than inventing a
 * tighter span it cannot justify.
 */
export interface SourceChunkSpan {
  /** Inclusive start offset within the chunk's bounded text. */
  charStart: number;
  /** Exclusive end offset within the chunk's bounded text. */
  charEnd: number;
  /** Inclusive start offset within the item's bounded text. */
  itemCharStart: number;
  /** Exclusive end offset within the item's bounded text. */
  itemCharEnd: number;
  /** Characters in this chunk's bounded text. */
  chunkChars: number;
  lane: 'keyword' | 'semantic';
}

export interface SourceChunkIdentity {
  sourceItem: SourceItemIdentity;
  chunkId: string;
  chunkIndex: number;
  contentHash: string;
  /** Offset-level citation support. Absent when the lane cannot locate one. */
  span?: SourceChunkSpan;
}

export interface SourceSensitivity {
  trustTier: SourceTrustTier;
  trustDomain: SourceTrustDomain;
  localOnly: boolean;
  cloudEmbeddingEligible: boolean;
}

export type SourceSensitivityInput = {
  trustTier: SourceTrustTier;
  trustDomain?: SourceTrustDomain;
  localOnly?: boolean;
  cloudEmbeddingEligible?: boolean;
};

export interface SourceIndexProvenance {
  sourceItem: SourceItemIdentity;
  chunk?: SourceChunkIdentity;
  providerIds?: Readonly<Record<string, string>>;
  localIds?: Readonly<Record<string, string>>;
  syncRunId?: string;
  syncCheckpoint?: string;
  citation?: SourceCitationMetadata;
}

export interface SourceIndexStorageProfile {
  trustDomain: SourceTrustDomain;
  placement: SourceIndexStoragePlacement;
  storageEngine: SourceIndexStorageEngine;
  lexicalBackend: SourceIndexLexicalBackend;
  vectorBackend: SourceIndexVectorBackend;
  embeddingBackend: SourceIndexEmbeddingBackend;
  cloudQueryEligible: boolean;
}

export type SourceIndexStorageProfileInput = {
  trustDomain: SourceTrustDomain;
  placement?: SourceIndexStoragePlacement;
  storageEngine?: SourceIndexStorageEngine;
  lexicalBackend?: SourceIndexLexicalBackend;
  vectorBackend?: SourceIndexVectorBackend;
  embeddingBackend?: SourceIndexEmbeddingBackend;
  cloudEmbeddingApproved?: boolean;
  cloudQueryApproved?: boolean;
};

export interface SourceCitationMetadata {
  title?: string;
  sourceLabel?: string;
  /** Message conversation/chat label; never substituted for the author. */
  conversationLabel?: string;
  /** Message author/sender label; distinct from the conversation label. */
  authorLabel?: string;
  uri?: string;
  authoredAt?: string;
  updatedAt?: string;
}

export type RetrievalLaneType = 'keyword' | 'semantic' | 'metadata' | 'structured' | 'hybrid' | SourceIndexExtensionId;

export interface RetrievalLaneAudit {
  laneName: string;
  laneType: RetrievalLaneType;
  candidateCount: number;
  returnedCount: number;
  skippedReason?: string;
  /** Highest absolute cosine observed by this semantic lane, rounded for audit stability. */
  bestCosine?: number;
  /** Semantic candidates removed by an absolute relevance gate before fusion. */
  suppressedBelowBar?: number;
  modelId?: string;
  backend?: string;
  localOnly: boolean;
  rawExposed: boolean;
}

/**
 * Why a lane is missing from a unified answer.
 *
 * The closed set is deliberate: a caller has to be able to tell
 * "keyword-only because that is all this corpus has" from "the semantic lane
 * timed out", and a free-form string cannot be branched on. Deliberate
 * scoping (a corpus the request did not ask for, a trust domain the caller may
 * not read) is NOT degradation — it is already reported in skippedCorpora and
 * putting it here would drown the signal this exists to carry.
 */
export type RetrievalDegradationReason =
  /** The lane did not settle inside the per-lane retrieval deadline. */
  | 'lane_timeout'
  /** The corpus is in scope and enabled but has no search adapter wired. */
  | 'lane_no_adapter'
  /**
   * The corpus searched successfully and returned hits, and the caller's result
   * budget filled before any of them were seated. Distinguishes "that corpus
   * had nothing" from "the answer never reached that corpus".
   */
  | 'lane_budget_cut'
  /** The corpus can serve a semantic lane, and this query did not run one. */
  | 'semantic_lane_not_run'
  /** The adapter attempted semantic retrieval but reported an operational skip. */
  | 'semantic_lane_skipped'
  /** The corpus declares a semantic lane it currently cannot serve. */
  | 'semantic_lane_unservable';

/**
 * A counts-only marker that one lane did not contribute to an answer.
 *
 * Content-free by construction: a lane name, a lane type, a closed-set reason,
 * an optional stable enum token, and a count. Safe in a receipt, a log line and
 * the Castor-visible audit alike.
 */
export interface RetrievalDegradation {
  /** Corpus id, or `${corpusId}:${lane}` when one lane inside a corpus dropped. */
  laneName: string;
  laneType: RetrievalLaneType;
  reason: RetrievalDegradationReason;
  /**
   * A further stable enum token from the layer that detected the loss (for
   * example a SourceIndexHybridUnservableReason). Never free-form text and
   * never anything derived from source content.
   */
  detail?: string;
  /** How many retrieval runs in this answer hit this degradation. */
  occurrences: number;
}

export function buildSourceSensitivity(input: SourceSensitivityInput): SourceSensitivity {
  const trustDomain = input.trustDomain ?? defaultTrustDomainForTier(input.trustTier);
  const localOnlyRequired = trustDomain === 'secure_local' || isSecureTrustTier(input.trustTier);
  const localOnly = localOnlyRequired ? true : input.localOnly ?? false;
  const cloudEmbeddingEligible =
    input.cloudEmbeddingEligible === true && !localOnly && trustDomain !== 'secure_local' && !isSecureTrustTier(input.trustTier);

  return {
    trustTier: input.trustTier,
    trustDomain,
    localOnly,
    cloudEmbeddingEligible,
  };
}

export function isSecureTrustTier(trustTier: SourceTrustTier): boolean {
  return trustTier === 'S4' || trustTier === 'S4+' || trustTier === 'S5';
}

export function buildSourceIndexStorageProfile(input: SourceIndexStorageProfileInput): SourceIndexStorageProfile {
  if (input.trustDomain === 'secure_local') {
    const profile: SourceIndexStorageProfile = {
      trustDomain: input.trustDomain,
      placement: input.placement ?? 'local_private',
      storageEngine: input.storageEngine ?? 'sqlite',
      lexicalBackend: input.lexicalBackend ?? 'sqlite_fts5',
      vectorBackend: input.vectorBackend ?? 'exact_scan',
      embeddingBackend: input.embeddingBackend ?? 'local',
      cloudQueryEligible: false,
    };
    assertSecureLocalStorageProfile(profile);
    return profile;
  }

  if (input.trustDomain === 'internal') {
    const storageEngine = input.storageEngine ?? 'sqlite';
    const profile: SourceIndexStorageProfile = {
      trustDomain: input.trustDomain,
      placement: input.placement ?? defaultStoragePlacementForEngine(storageEngine),
      storageEngine,
      lexicalBackend: input.lexicalBackend ?? defaultLexicalBackendForEngine(storageEngine),
      vectorBackend: input.vectorBackend ?? defaultVectorBackendForEngine(storageEngine),
      embeddingBackend: input.embeddingBackend ?? (input.cloudEmbeddingApproved === true ? 'cloud' : 'local'),
      cloudQueryEligible: input.cloudQueryApproved === true,
    };
    assertStorageBackendMatchesEngine(profile);
    assertCloudEmbeddingApproval(profile, input.cloudEmbeddingApproved === true);
    return profile;
  }

  if (input.trustDomain === 'public_safe') {
    const storageEngine = input.storageEngine ?? 'sqlite';
    const profile: SourceIndexStorageProfile = {
      trustDomain: input.trustDomain,
      placement: input.placement ?? defaultStoragePlacementForEngine(storageEngine),
      storageEngine,
      lexicalBackend: input.lexicalBackend ?? defaultLexicalBackendForEngine(storageEngine),
      vectorBackend: input.vectorBackend ?? defaultVectorBackendForEngine(storageEngine),
      embeddingBackend: input.embeddingBackend ?? (input.cloudEmbeddingApproved === true ? 'cloud' : 'local'),
      cloudQueryEligible: input.cloudQueryApproved ?? true,
    };
    assertStorageBackendMatchesEngine(profile);
    assertCloudEmbeddingApproval(profile, input.cloudEmbeddingApproved === true);
    return profile;
  }

  if (input.embeddingBackend === 'cloud' && input.cloudEmbeddingApproved !== true) {
    throw new Error('Extension trust domains require explicit cloud embedding approval.');
  }

  return {
    trustDomain: input.trustDomain,
    placement: input.placement ?? 'local_private',
    storageEngine: input.storageEngine ?? 'sqlite',
    lexicalBackend: input.lexicalBackend ?? 'sqlite_fts5',
    vectorBackend: input.vectorBackend ?? 'exact_scan',
    embeddingBackend: input.embeddingBackend ?? 'local',
    cloudQueryEligible: input.cloudQueryApproved === true,
  };
}

function defaultTrustDomainForTier(trustTier: SourceTrustTier): SourceTrustDomain {
  if (isSecureTrustTier(trustTier)) return 'secure_local';
  if (trustTier === 'S0') return 'public_safe';
  return 'internal';
}

function assertSecureLocalStorageProfile(profile: SourceIndexStorageProfile): void {
  if (profile.placement !== 'local_private') {
    throw new Error('secure_local storage must stay local_private.');
  }
  if (profile.storageEngine !== 'sqlite') {
    throw new Error('secure_local storage must use the SQLite-family local store.');
  }
  if (profile.lexicalBackend !== 'sqlite_fts5') {
    throw new Error('secure_local lexical search must use the local SQLite FTS5 lane.');
  }
  if (!['none', 'exact_scan', 'sqlite_vec', 'sqlite_vec1'].includes(profile.vectorBackend)) {
    throw new Error('secure_local vector search must use a local SQLite-family vector lane.');
  }
  if (profile.embeddingBackend === 'cloud') {
    throw new Error('secure_local corpora cannot use cloud embeddings.');
  }
  if (profile.cloudQueryEligible) {
    throw new Error('secure_local corpora cannot be directly cloud-query eligible.');
  }
}

function defaultStoragePlacementForEngine(storageEngine: SourceIndexStorageEngine): SourceIndexStoragePlacement {
  if (storageEngine === 'postgres') return 'cloud_managed';
  return 'local_private';
}

function defaultLexicalBackendForEngine(storageEngine: SourceIndexStorageEngine): SourceIndexLexicalBackend {
  if (storageEngine === 'postgres') return 'postgres_full_text';
  return 'sqlite_fts5';
}

function defaultVectorBackendForEngine(storageEngine: SourceIndexStorageEngine): SourceIndexVectorBackend {
  if (storageEngine === 'postgres') return 'pgvector';
  return 'exact_scan';
}

function assertStorageBackendMatchesEngine(profile: SourceIndexStorageProfile): void {
  if (profile.storageEngine === 'sqlite') {
    if (profile.lexicalBackend !== 'sqlite_fts5') {
      throw new Error('SQLite storage profiles must use sqlite_fts5 lexical search.');
    }
    if (!['none', 'exact_scan', 'sqlite_vec', 'sqlite_vec1'].includes(profile.vectorBackend)) {
      throw new Error('SQLite storage profiles must use a SQLite-family vector lane.');
    }
    return;
  }

  if (profile.lexicalBackend !== 'postgres_full_text') {
    throw new Error('Postgres storage profiles must use postgres_full_text lexical search.');
  }
  if (profile.vectorBackend !== 'pgvector') {
    throw new Error('Postgres storage profiles must use pgvector.');
  }
}

function assertCloudEmbeddingApproval(profile: SourceIndexStorageProfile, approved: boolean): void {
  if (profile.embeddingBackend === 'cloud' && approved !== true) {
    throw new Error('Cloud embeddings require explicit corpus policy approval.');
  }
}
