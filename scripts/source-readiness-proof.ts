import { writeFileSync } from 'node:fs';
import { loadConfig } from '../src/core/config.ts';
import { createSourceCorpusRegistry, defaultSourceCorpusRegistryConfig } from '../src/core/source-corpus-registry.ts';
import {
  EmailClient,
  createEmailTransport,
  type SourceIndexStatusCorpusId,
  type SourceIndexStatusResult,
} from '../src/core/email.ts';

export type SourceReadinessStatus = 'ready' | 'watch' | 'attention';

export const DEFAULT_REGISTERED_SOURCE_CORPORA = createSourceCorpusRegistry(
  defaultSourceCorpusRegistryConfig(),
).ids('status') satisfies SourceIndexStatusCorpusId[];

export interface SourceReadinessProofReport {
  kind: 'source_readiness_proof';
  generated_at: string;
  status: SourceReadinessStatus;
  corpora: SourceReadinessCorpusProof[];
  summary: {
    ready: number;
    watch: number;
    attention: number;
    configured: number;
    unconfigured: number;
  };
  policy: {
    raw_source_exposed: false;
    source_text_returned: false;
    secure_local_item_metadata_exposed: false;
    all_registered_corpora_included: true;
    read_only: true;
  };
  actions: string[];
}

export interface SourceReadinessCorpusProof {
  corpus_id: string;
  family: string;
  trust_domain: string;
  activation_mode: string;
  embedding_policy: string;
  configured: boolean;
  status: SourceReadinessStatus;
  last_refresh?: {
    status: string;
    completed_at?: string;
    items_seen: number;
    items_indexed: number;
  };
  counts: {
    indexed_items: number;
    chunks: number;
    embedded_chunks: number;
    sync_runs: number;
    extraction_failed?: number;
    extraction_queued?: number;
    extraction_leased?: number;
  };
  qa?: {
    total_items: number;
    pass: number;
    stale_revision: number;
    metadata_only_expected: number;
    metadata_only_gap: number;
    low_confidence_retry_local: number;
    low_confidence_candidate_for_venice: number;
    blocked_policy: number;
    failed_needs_operator: number;
    pending: number;
    visible_gaps: number;
    low_confidence: number;
  };
  embedding: {
    required: boolean;
    ready: boolean;
    coverage_ratio?: number;
  };
  retrieval: {
    declared_mode: string;
    servable_mode: 'keyword' | 'hybrid';
    state: 'ready' | 'degraded';
    reason?: string;
  };
  actions: string[];
}

interface SourceStatusCorpusRecord {
  corpus_id: string;
  family: string;
  trust_domain: string;
  activation_mode: string;
  embedding_policy: string;
  configured: boolean;
  retrieval?: SourceReadinessCorpusProof['retrieval'];
  counts?: Record<string, number>;
  last_refresh?: {
    status: string;
    completed_at?: string;
    items_seen: number;
    items_indexed: number;
  };
}

export async function runSourceReadinessProof(
  options: { client?: EmailClient; now?: Date } = {},
): Promise<SourceReadinessProofReport> {
  const config = options.client ? undefined : loadConfig();
  const client = options.client ?? new EmailClient(config!, createEmailTransport(config!));
  const corpusIds = config
    ? createSourceCorpusRegistry(config.sourceIndex.corpusRegistry).ids('status')
    : DEFAULT_REGISTERED_SOURCE_CORPORA;
  let corpora: SourceReadinessCorpusProof[];
  try {
    const status = await client.sourceIndexStatus({ includeItems: false });
    const returnedCorpusIds = status.corpora
      .map(sourceStatusCorpusRecord)
      .filter((corpus): corpus is SourceStatusCorpusRecord => Boolean(corpus))
      .map((corpus) => corpus.corpus_id);
    const allCorpusIds = [...new Set([...corpusIds, ...returnedCorpusIds])];
    corpora = allCorpusIds.map((corpusId) => corpusProofFromStatus(status, corpusId));
  } catch (error) {
    corpora = corpusIds.map((corpusId) => missingCorpusProof(corpusId, sourceStatusUnavailableReason(error)));
  }
  return buildSourceReadinessProof(corpora, options.now ?? new Date());
}

export function buildSourceReadinessProof(
  corpora: readonly SourceReadinessCorpusProof[],
  now: Date = new Date(),
): SourceReadinessProofReport {
  const statuses = corpora.map((corpus) => corpus.status);
  const status = aggregateStatus(statuses);
  const summary = {
    ready: statuses.filter((value) => value === 'ready').length,
    watch: statuses.filter((value) => value === 'watch').length,
    attention: statuses.filter((value) => value === 'attention').length,
    configured: corpora.filter((corpus) => corpus.configured).length,
    unconfigured: corpora.filter((corpus) => !corpus.configured).length,
  };
  return {
    kind: 'source_readiness_proof',
    generated_at: now.toISOString(),
    status,
    corpora: [...corpora],
    summary,
    policy: {
      raw_source_exposed: false,
      source_text_returned: false,
      secure_local_item_metadata_exposed: false,
      all_registered_corpora_included: true,
      read_only: true,
    },
    actions: corpora.flatMap((corpus) => corpus.actions),
  };
}

export function corpusProofFromStatus(
  status: SourceIndexStatusResult,
  corpusId: string,
): SourceReadinessCorpusProof {
  const corpus = status.corpora
    .map(sourceStatusCorpusRecord)
    .find((entry) => entry?.corpus_id === corpusId);
  if (!corpus) {
    return missingCorpusProof(corpusId, 'Source status did not return this registered corpus.');
  }
  const counts = countsFromCorpus(corpus);
  // Vector parity is a readiness requirement only when the declared retrieval
  // mode promises a semantic lane. A lexical-only corpus may retain optional
  // vectors for future promotion, but an incomplete optional cache cannot make
  // its currently declared keyword path unready.
  const embeddingRequired = corpus.embedding_policy !== 'disabled'
    && corpus.activation_mode !== 'lexical_only';
  const embeddingCoverage = counts.chunks > 0 ? Number((counts.embedded_chunks / counts.chunks).toFixed(4)) : undefined;
  const actions: string[] = [];
  if (corpus.retrieval?.state === 'degraded') {
    actions.push(
      `${corpusId}: declared ${corpus.retrieval.declared_mode} is unservable; keyword fallback is active (${corpus.retrieval.reason ?? 'unknown'}).`,
    );
  }
  if (!corpus.configured) actions.push(`${corpusId}: configure the source index and credential lane.`);
  if (!corpus.last_refresh) actions.push(`${corpusId}: run a bounded source_index_sync to establish freshness.`);
  if (counts.indexed_items === 0) actions.push(`${corpusId}: sync indexed items; current corpus has no indexed items.`);
  if (counts.extraction_failed && counts.extraction_failed > 0) {
    actions.push(`${corpusId}: repair ${counts.extraction_failed} failed extraction job(s).`);
  }
  if (counts.extraction_queued && counts.extraction_queued > 0) {
    actions.push(`${corpusId}: drain ${counts.extraction_queued} queued extraction job(s).`);
  }
  if (counts.extraction_leased && counts.extraction_leased > 0) {
    actions.push(`${corpusId}: wait for or complete ${counts.extraction_leased} leased extraction job(s).`);
  }
  if (embeddingRequired && counts.chunks > 0 && counts.embedded_chunks < counts.chunks) {
    actions.push(`${corpusId}: refresh embeddings (${counts.embedded_chunks}/${counts.chunks} chunks embedded).`);
  }
  const qa = qaFromCounts(corpus.counts ?? {});
  if (qa?.visible_gaps && qa.visible_gaps > 0) {
    actions.push(`${corpusId}: review ${qa.visible_gaps} extraction QA gap(s).`);
  }
  if (qa?.low_confidence_candidate_for_venice && qa.low_confidence_candidate_for_venice > 0) {
    actions.push(`${corpusId}: consider Venice escalation for ${qa.low_confidence_candidate_for_venice} low-confidence hard document item(s).`);
  }
  const corpusStatus = statusForCorpus({
    configured: corpus.configured,
    indexedItems: counts.indexed_items,
    hasLastRefresh: Boolean(corpus.last_refresh),
    extractionFailed: counts.extraction_failed ?? 0,
    qaVisibleGaps: qa?.visible_gaps ?? 0,
    qaFailedNeedsOperator: qa?.failed_needs_operator ?? 0,
    embeddingRequired,
    chunks: counts.chunks,
    embeddedChunks: counts.embedded_chunks,
    retrievalDegraded: corpus.retrieval?.state === 'degraded',
  });
  return {
    corpus_id: corpusId,
    family: corpus.family,
    trust_domain: corpus.trust_domain,
    activation_mode: corpus.activation_mode,
    embedding_policy: corpus.embedding_policy,
    configured: corpus.configured,
    status: corpusStatus,
    ...(corpus.last_refresh
      ? {
        last_refresh: {
          status: corpus.last_refresh.status,
          ...(corpus.last_refresh.completed_at ? { completed_at: corpus.last_refresh.completed_at } : {}),
          items_seen: corpus.last_refresh.items_seen,
          items_indexed: corpus.last_refresh.items_indexed,
        },
      }
      : {}),
    counts,
    ...(qa ? { qa } : {}),
    embedding: {
      required: embeddingRequired,
      ready: !embeddingRequired || counts.chunks === 0 || counts.embedded_chunks >= counts.chunks,
      ...(embeddingCoverage !== undefined ? { coverage_ratio: embeddingCoverage } : {}),
    },
    retrieval: corpus.retrieval ?? {
      declared_mode: corpus.activation_mode,
      servable_mode: 'keyword',
      state: corpus.activation_mode === 'lexical_only' ? 'ready' : 'degraded',
      ...(corpus.activation_mode === 'lexical_only' ? {} : { reason: 'hybrid_capability_unreported' }),
    },
    actions,
  };
}

function missingCorpusProof(
  corpusId: string,
  reason: string,
): SourceReadinessCorpusProof {
  return {
    corpus_id: corpusId,
    family: 'unknown',
    trust_domain: 'unknown',
    activation_mode: 'unknown',
    embedding_policy: 'unknown',
    configured: false,
    status: 'attention',
    counts: {
      indexed_items: 0,
      chunks: 0,
      embedded_chunks: 0,
      sync_runs: 0,
    },
    embedding: {
      required: false,
      ready: false,
    },
    retrieval: {
      declared_mode: 'unknown',
      servable_mode: 'keyword',
      state: 'degraded',
      reason: 'hybrid_capability_unreported',
    },
    actions: [`${corpusId}: ${reason}`],
  };
}

function sourceStatusUnavailableReason(error: unknown): string {
  if (error instanceof Error && error.message.trim()) {
    return `source status unavailable: ${error.message.trim()}`;
  }
  return 'source status unavailable.';
}

function countsFromCorpus(corpus: SourceStatusCorpusRecord): SourceReadinessCorpusProof['counts'] {
  const counts = corpus.counts ?? {};
  const indexedItems = firstNumber(counts, ['indexed_items', 'files', 'items', 'messages']);
  const chunks = firstNumber(counts, [
    'chunks',
    'internal_chunks',
    'public_safe_chunks',
    'secure_local_chunks',
    'private_chunks',
  ]);
  return {
    indexed_items: indexedItems,
    chunks,
    embedded_chunks: firstNumber(counts, ['embedded_chunks']),
    sync_runs: firstNumber(counts, ['sync_runs']),
    ...(counts.extraction_jobs_failed !== undefined ? { extraction_failed: counts.extraction_jobs_failed } : {}),
    ...(counts.extraction_jobs_queued !== undefined ? { extraction_queued: counts.extraction_jobs_queued } : {}),
    ...(counts.extraction_jobs_leased !== undefined ? { extraction_leased: counts.extraction_jobs_leased } : {}),
  };
}

function qaFromCounts(record: Record<string, number>): SourceReadinessCorpusProof['qa'] | undefined {
  const totalItems = record.qa_total_items;
  if (typeof totalItems !== 'number' || !Number.isFinite(totalItems)) return undefined;
  return {
    total_items: totalItems,
    pass: firstNumber(record, ['qa_pass']),
    stale_revision: firstNumber(record, ['qa_stale_revision']),
    metadata_only_expected: firstNumber(record, ['qa_metadata_only_expected']),
    metadata_only_gap: firstNumber(record, ['qa_metadata_only_gap']),
    low_confidence_retry_local: firstNumber(record, ['qa_low_confidence_retry_local']),
    low_confidence_candidate_for_venice: firstNumber(record, ['qa_low_confidence_candidate_for_venice']),
    blocked_policy: firstNumber(record, ['qa_blocked_policy']),
    failed_needs_operator: firstNumber(record, ['qa_failed_needs_operator']),
    pending: firstNumber(record, ['qa_pending']),
    visible_gaps: firstNumber(record, ['qa_visible_gaps']),
    low_confidence: firstNumber(record, ['qa_low_confidence']),
  };
}

function sourceStatusCorpusRecord(value: unknown): SourceStatusCorpusRecord | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const record = value as Record<string, unknown>;
  if (
    typeof record.corpus_id !== 'string'
    || typeof record.family !== 'string'
    || typeof record.trust_domain !== 'string'
    || typeof record.activation_mode !== 'string'
    || typeof record.embedding_policy !== 'string'
    || typeof record.configured !== 'boolean'
  ) {
    return undefined;
  }
  const counts = record.counts && typeof record.counts === 'object'
    ? numberRecord(record.counts as Record<string, unknown>)
    : undefined;
  const lastRefresh = lastRefreshRecord(record.last_refresh);
  const retrieval = retrievalRecord(record.retrieval);
  return {
    corpus_id: record.corpus_id,
    family: record.family,
    trust_domain: record.trust_domain,
    activation_mode: record.activation_mode,
    embedding_policy: record.embedding_policy,
    configured: record.configured,
    ...(retrieval ? { retrieval } : {}),
    ...(counts ? { counts } : {}),
    ...(lastRefresh ? { last_refresh: lastRefresh } : {}),
  };
}

function retrievalRecord(value: unknown): SourceReadinessCorpusProof['retrieval'] | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const record = value as Record<string, unknown>;
  if (
    typeof record.declared_mode !== 'string'
    || (record.servable_mode !== 'keyword' && record.servable_mode !== 'hybrid')
    || (record.state !== 'ready' && record.state !== 'degraded')
  ) {
    return undefined;
  }
  return {
    declared_mode: record.declared_mode,
    servable_mode: record.servable_mode,
    state: record.state,
    ...(typeof record.reason === 'string' ? { reason: record.reason } : {}),
  };
}

function numberRecord(record: Record<string, unknown>): Record<string, number> {
  const output: Record<string, number> = {};
  for (const [key, value] of Object.entries(record)) {
    if (typeof value === 'number' && Number.isFinite(value)) output[key] = value;
  }
  return output;
}

function lastRefreshRecord(value: unknown): SourceStatusCorpusRecord['last_refresh'] | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const record = value as Record<string, unknown>;
  if (
    typeof record.status !== 'string'
    || typeof record.items_seen !== 'number'
    || typeof record.items_indexed !== 'number'
  ) {
    return undefined;
  }
  return {
    status: record.status,
    ...(typeof record.completed_at === 'string' ? { completed_at: record.completed_at } : {}),
    items_seen: record.items_seen,
    items_indexed: record.items_indexed,
  };
}

function firstNumber(record: Record<string, number>, keys: readonly string[]): number {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'number' && Number.isFinite(value)) return value;
  }
  return 0;
}

function statusForCorpus(input: {
  configured: boolean;
  indexedItems: number;
  hasLastRefresh: boolean;
  extractionFailed: number;
  qaVisibleGaps: number;
  qaFailedNeedsOperator: number;
  embeddingRequired: boolean;
  chunks: number;
  embeddedChunks: number;
  retrievalDegraded: boolean;
}): SourceReadinessStatus {
  if (
    !input.configured
    || input.extractionFailed > 0
    || input.qaFailedNeedsOperator > 0
    || input.retrievalDegraded
  ) return 'attention';
  if (!input.hasLastRefresh || input.indexedItems === 0) return 'watch';
  if (input.qaVisibleGaps > 0) return 'watch';
  if (input.embeddingRequired && input.chunks > 0 && input.embeddedChunks < input.chunks) return 'watch';
  return 'ready';
}

function aggregateStatus(statuses: readonly SourceReadinessStatus[]): SourceReadinessStatus {
  if (statuses.includes('attention')) return 'attention';
  if (statuses.includes('watch')) return 'watch';
  return 'ready';
}

function parseArgs(argv: string[]): { reportPath?: string } {
  const options: { reportPath?: string } = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    if (arg === '--report') {
      const value = argv[index + 1];
      if (!value) throw new Error('--report requires a path.');
      options.reportPath = value;
      index += 1;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return options;
}

if (import.meta.main) {
  const options = parseArgs(process.argv.slice(2));
  const report = await runSourceReadinessProof();
  const json = JSON.stringify(report, null, 2);
  if (options.reportPath) writeFileSync(options.reportPath, `${json}\n`);
  console.log(json);
}
