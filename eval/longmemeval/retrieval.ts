// LongMemEval session-level retrieval recall, measured through the shared
// connector store (issue #626). Dev-only: nothing here is on the public
// surface, and no benchmark data is committed.
//
// Each question's haystack sessions become RawItems of a plain
// SourceConnector, synced into a fresh in-memory LocalConnectorStore exactly as
// any source's items are, and the question is asked through
// createConnectorStoreCorpusAdapter, the same routed search the product uses.
// No Analyst, no model calls, no benchmark-specific query handling: the
// question text is the query as-is.
//
// Metric: recall_any@k (at least one evidence session in the top k distinct
// sessions) and recall_all@k (every evidence session in the top k), the two
// session-level retrieval metrics LongMemEval reports. Abstention questions
// (question_id ending in `_abs`) are skipped, as LongMemEval's own retrieval
// scoring does; --include-abstention scores all 500 (MemPalace's published
// raw run scores all 500, indexing user turns only: --roles user).
//
// Data: LongMemEval's `longmemeval_s_cleaned.json` (or `_oracle`), kept
// outside git under eval/private/ (gitignored).
//
//   bun eval/longmemeval/retrieval.ts --data eval/private/longmemeval/longmemeval_s_cleaned.json \
//     [--limit N] [--family note|chat|...] [--roles all|user] [--include-abstention] [--shared-store] [--out report.json]
//
// --limit N takes the first N non-abstention questions in file order.
// Embeddings: --embedding built-in runs the hybrid lane (keyword + vector,
// RRF) with the provider the OLYMPUS_SOURCE_INDEX_EMBEDDING_* environment
// names, defaulting the provider to `built-in` (whose env default model is
// Arctic; set OLYMPUS_SOURCE_INDEX_EMBEDDING_MODEL to pick another). Each
// question's haystack is embedded afresh, so try --limit first. Without the
// flag the run is keyword-only.

import { readFileSync, writeFileSync } from 'node:fs';
import type { RawItem, SourceConnector } from '../../src/core/contracts.ts';
import { SOURCE_FAMILIES, type SourceFamily } from '../../src/core/source-index/types.ts';
import {
  LocalConnectorStore,
  createConnectorStoreCorpusAdapter,
  defineConnectorCorpus,
} from '../../src/workers/connector-store/index.ts';
import type { SourceEmbeddingProvider } from '../../src/workers/source-index/embeddings.ts';

interface Turn { role: string; content: string }
interface LongMemEvalQuestion {
  question_id: string;
  question_type: string;
  question: string;
  question_date: string;
  answer_session_ids: string[];
  haystack_dates: string[];
  haystack_session_ids: string[];
  haystack_sessions: Turn[][];
}

interface Args {
  data: string;
  limit?: number;
  family: SourceFamily;
  roles: 'all' | 'user';
  out?: string;
  embedding?: 'built-in';
  maxResults: number;
  includeAbstention: boolean;
  sharedStore: boolean;
}

const KS = [1, 3, 5, 10] as const;

function parseArgs(argv: readonly string[]): Args {
  const args: Args = { data: 'eval/private/longmemeval/longmemeval_s_cleaned.json', family: 'note', roles: 'all', maxResults: 50, includeAbstention: false, sharedStore: false };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i]!;
    const value = (): string => {
      const next = argv[i + 1];
      if (next === undefined) throw new Error(`${flag} requires a value.`);
      i += 1;
      return next;
    };
    if (flag === '--data') args.data = value();
    else if (flag === '--limit') args.limit = Number.parseInt(value(), 10);
    else if (flag === '--family') {
      const family = value();
      if (!(SOURCE_FAMILIES as readonly string[]).includes(family)) throw new Error(`--family must be one of ${SOURCE_FAMILIES.join(', ')}`);
      args.family = family as SourceFamily;
    } else if (flag === '--roles') {
      const roles = value();
      if (roles !== 'all' && roles !== 'user') throw new Error('--roles must be all or user');
      args.roles = roles;
    } else if (flag === '--out') args.out = value();
    else if (flag === '--embedding') {
      const kind = value();
      if (kind !== 'built-in') throw new Error('--embedding supports built-in only');
      args.embedding = kind;
    } else if (flag === '--max-results') args.maxResults = Number.parseInt(value(), 10);
    else if (flag === '--include-abstention') args.includeAbstention = true;
    else if (flag === '--shared-store') args.sharedStore = true;
    else throw new Error(`Unknown flag ${flag}`);
  }
  return args;
}

// "2023/05/20 (Sat) 02:21" -> ISO. Dates are generic item metadata, the same
// field any chat or note connector fills.
function isoDate(value: string): string | undefined {
  const match = /^(\d{4})\/(\d{2})\/(\d{2}) \(\w+\) (\d{2}):(\d{2})$/.exec(value.trim());
  if (!match) return undefined;
  const [, y, mo, d, h, mi] = match;
  return new Date(Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi))).toISOString();
}

function sessionText(turns: readonly Turn[], roles: Args['roles']): string {
  return turns
    .filter((turn) => roles === 'all' || turn.role === 'user')
    .map((turn) => `${turn.role}: ${turn.content}`)
    .join('\n\n');
}

function itemsFor(question: LongMemEvalQuestion, args: Args): RawItem[] {
  const seen = new Set<string>();
  const items: RawItem[] = [];
  question.haystack_session_ids.forEach((sessionId, index) => {
    if (seen.has(sessionId)) return;
    seen.add(sessionId);
    const text = sessionText(question.haystack_sessions[index] ?? [], args.roles);
    if (!text.trim()) return;
    const sentAt = isoDate(question.haystack_dates[index] ?? '');
    items.push({
      identity: {
        provider: 'longmemeval',
        family: args.family,
        accountScope: 'benchmark',
        providerItemId: sessionId,
        localItemId: sessionId,
        sourceVersion: '1',
      },
      content: { kind: 'text', text },
      mimeType: 'text/plain',
      metadata: { title: `Conversation ${sentAt?.slice(0, 10) ?? ''}`.trim(), ...(sentAt ? { sentAt } : {}) },
      fetchedAt: '2026-11-10T00:00:00Z',
    });
  });
  return items;
}

function connectorFor(items: readonly RawItem[], family: SourceFamily): SourceConnector {
  return {
    id: 'longmemeval',
    family,
    async authenticate() {},
    async *listItems() { yield { items: [...items], done: true }; },
    async fetchItem(id: string) { return items.find((item) => item.identity.localItemId === id)!; },
    classificationSignals() { return {}; },
  };
}

async function embeddingProviderFor(args: Args): Promise<SourceEmbeddingProvider | undefined> {
  if (!args.embedding) return undefined;
  const { createSourceIndexEmbeddingProviderFromEnv } = await import('../../src/workers/engine/runtime/embedding-providers.ts');
  process.env.OLYMPUS_SOURCE_INDEX_EMBEDDING_PROVIDER ??= 'built-in';
  const provider = createSourceIndexEmbeddingProviderFromEnv();
  if (!provider) throw new Error('No built-in embedding provider could be created from the environment.');
  return provider;
}

interface QuestionResult {
  questionId: string;
  questionType: string;
  evidence: number;
  rankedSessions: number;
  firstEvidenceRank: number | null;
  anyAt: Record<number, boolean>;
  allAt: Record<number, boolean>;
  latencyMs: number;
  // A hybrid run whose semantic lane failed to run for this question (for
  // example the query embedding timed out) scored it on keywords alone.
  semanticSkipped?: string;
}

const CORPUS_ID = 'benchmark.longmemeval';

async function openStore(items: readonly RawItem[], args: Args, provider?: SourceEmbeddingProvider): Promise<LocalConnectorStore> {
  const store = new LocalConnectorStore({ dbPath: ':memory:', corpusId: CORPUS_ID, family: args.family, trustDomain: 'internal', tierLedger: null });
  await store.syncFromConnector(connectorFor(items, args.family), { fetchContent: true, placement: { trustTier: 'S3', trustDomain: 'internal' } });
  if (provider) await store.embedChunks({ provider });
  return store;
}

async function scoreQuestion(
  question: LongMemEvalQuestion,
  store: LocalConnectorStore,
  args: Args,
  provider?: SourceEmbeddingProvider,
): Promise<QuestionResult> {
  const adapter = createConnectorStoreCorpusAdapter({ store, ...(provider ? { embeddingProvider: provider, retrievalMode: 'hybrid' as const } : { retrievalMode: 'keyword' as const }) });
  const startedAt = performance.now();
  const response = await adapter({
    query: question.question,
    maxResults: args.maxResults,
    corpus: defineConnectorCorpus({ corpusId: CORPUS_ID, family: args.family, trustDomain: 'internal' }),
    context: { allowedTrustDomains: ['internal'] },
  });
  const latencyMs = performance.now() - startedAt;
  const ranked: string[] = [];
  for (const hit of response.hits) {
    const id = hit.sourceItem.providerItemId;
    if (!ranked.includes(id)) ranked.push(id);
  }
  const evidence = new Set(question.answer_session_ids);
  const firstIndex = ranked.findIndex((id) => evidence.has(id));
  const anyAt: Record<number, boolean> = {};
  const allAt: Record<number, boolean> = {};
  for (const k of KS) {
    const top = new Set(ranked.slice(0, k));
    anyAt[k] = [...evidence].some((id) => top.has(id));
    allAt[k] = [...evidence].every((id) => top.has(id));
  }
  const skip = provider
    ? response.laneAudits?.find((audit) => audit.laneType === 'semantic' && audit.skippedReason
      // Nothing above the model's relevance bar is a normal result, not a failure.
      && audit.skippedReason !== 'semantic_below_relevance_bar')?.skippedReason
    : undefined;
  return {
    ...(skip ? { semanticSkipped: skip } : {}),
    questionId: question.question_id,
    questionType: question.question_type,
    evidence: evidence.size,
    rankedSessions: ranked.length,
    firstEvidenceRank: firstIndex < 0 ? null : firstIndex + 1,
    anyAt,
    allAt,
    latencyMs,
  };
}

function summarize(results: readonly QuestionResult[]) {
  const rate = (rows: readonly QuestionResult[], pick: (row: QuestionResult) => boolean) =>
    rows.length === 0 ? 0 : Math.round((rows.filter(pick).length / rows.length) * 1000) / 10;
  const block = (rows: readonly QuestionResult[]) => ({
    questions: rows.length,
    ...Object.fromEntries(KS.flatMap((k) => [
      [`recall_any@${k}`, rate(rows, (row) => row.anyAt[k]!)],
      [`recall_all@${k}`, rate(rows, (row) => row.allAt[k]!)],
    ])),
    no_evidence_returned: rows.filter((row) => row.firstEvidenceRank === null).length,
  });
  const types = [...new Set(results.map((row) => row.questionType))].sort();
  return {
    overall: block(results),
    byType: Object.fromEntries(types.map((type) => [type, block(results.filter((row) => row.questionType === type))])),
    medianSearchLatencyMs: [...results.map((row) => row.latencyMs)].sort((a, b) => a - b)[Math.floor(results.length / 2)] ?? 0,
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const all = JSON.parse(readFileSync(args.data, 'utf8')) as LongMemEvalQuestion[];
  const scored = args.includeAbstention ? all : all.filter((question) => !question.question_id.endsWith('_abs'));
  const questions = args.limit ? scored.slice(0, args.limit) : scored;
  const provider = await embeddingProviderFor(args);
  const startedAt = Date.now();
  const results: QuestionResult[] = [];
  // --shared-store: one store holding every question's haystack (all 500
  // questions' sessions, deduplicated), so each question is searched against
  // the whole set rather than its own ~50-session haystack.
  let shared: LocalConnectorStore | undefined;
  if (args.sharedStore) {
    const byId = new Map<string, RawItem>();
    for (const question of all) for (const item of itemsFor(question, args)) byId.set(item.identity.providerItemId, item);
    shared = await openStore([...byId.values()], args, provider);
    process.stderr.write(`shared store: ${byId.size} sessions indexed in ${Math.round((Date.now() - startedAt) / 1000)}s\n`);
  }
  try {
    for (const [index, question] of questions.entries()) {
      const store = shared ?? await openStore(itemsFor(question, args), args, provider);
      try {
        results.push(await scoreQuestion(question, store, args, provider));
      } finally {
        if (!shared) store.close();
      }
      if ((index + 1) % 50 === 0) process.stderr.write(`${index + 1}/${questions.length} questions\n`);
    }
  } finally {
    shared?.close();
  }
  // A hybrid score must mean every question used the semantic lane. Refuse to
  // report one otherwise, rather than label a partly keyword-only run hybrid.
  const degraded = results.filter((row) => row.semanticSkipped);
  if (degraded.length > 0) {
    const reasons = [...new Set(degraded.map((row) => row.semanticSkipped))].join(', ');
    throw new Error(`semantic lane skipped for ${degraded.length}/${results.length} questions (${reasons}); no hybrid score reported`);
  }
  const report = {
    benchmark: 'LongMemEval',
    data: args.data.split('/').pop(),
    questionsInFile: all.length,
    abstentionSkipped: all.length - scored.length,
    questionsScored: questions.length,
    retrieval: provider ? `hybrid (keyword + ${provider.modelId})` : 'keyword only',
    family: args.family,
    roles: args.roles,
    haystack: args.sharedStore ? 'shared store (every question\'s sessions)' : 'per question (LongMemEval standard)',
    maxResults: args.maxResults,
    wallClockSeconds: Math.round((Date.now() - startedAt) / 1000),
    ...summarize(results),
  };
  const json = JSON.stringify(report, null, 2);
  if (args.out) writeFileSync(args.out, `${json}\n`);
  await new Promise<void>((resolve) => process.stdout.write(`${json}\n`, () => resolve()));
}

// The built-in embedding provider keeps its model helpers running for the
// life of the process (they are killed on exit), so end the run explicitly
// once the report is written.
if (import.meta.main) {
  await main();
  process.exit(process.exitCode ?? 0);
}
