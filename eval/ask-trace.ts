// A whole Ask's evidence time on an offline copy of several stores at once,
// with the owner's live folder scope, timed by the same trace a live Ask
// writes. The eval's other speed tools time one store; per-store repeats,
// fan-out waits and the slowest lane only show here. Read-only; prints
// times, counts and store ids only, never question or item text.
//   bun eval/ask-trace.ts --data-root <copy> --query-file <questions, one per line>
//     --registry <connected handle registry> [--source dropbox.files] [--account personal] | --no-live-scope
//     [--trials 2] [--max-results 24] [--no-rerank] [--embed-load] [--priority]
// --embed-load keeps the embedding model busy with batches of made-up
// document text while each Ask runs, as a background embed sweep does;
// --priority builds the pack as a live Ask now does, with the question on the
// model's reserved query slot. Run both ways to see what the slot saves.
// Per question and trial:
//   evidenceMs, and inside it prepareMs (prepareSemanticMaxMs,
//   prepareKeywordsMaxMs), lanesMs, afterLanesMs, hydrationMs, rerankMs
//   queryEmbeds: question embeddings run, per model (the kind b16142cf fixed:
//     one per model per Ask, whatever the number of stores)
//   slowest: the three slowest stores, with pool queue wait and SQL time.
import { readFileSync } from 'node:fs';
import { loadConfig } from '../src/core/config.ts';
import type { ConnectorStoreSearchFilters } from '../src/workers/connector-store/local-index.ts';
import { FileSourceScopeAuthority, fileSourceScopeMetadataFilters } from '../src/workers/source-scope-runtime.ts';
import {
  createSourceAnswerTrace, observeSourceAnswerRetrievalAttempt, recordSourceAnswerRerank,
  runWithSourceAnswerTrace, snapshotSourceAnswerTrace,
} from '../src/workers/source-index/answer-latency-trace.ts';
import { DEFAULT_MAX_CHARS_PER_CANDIDATE } from '../src/workers/source-index/analyst-answer.ts';
import { prepareBuiltInRerankerFromEnv } from '../src/workers/source-index/built-in-reranker.ts';
import { withPriorityQueryEmbedding, type SourceEmbeddingProvider } from '../src/workers/source-index/embeddings.ts';
import { openEvalDataRoot } from './data-root.ts';
import { parseDataRootArgs } from './data-root-args.ts';
import { buildEvalPack, configuredEvalEmbedding, createEvalSourceLanes, prepareEvalEmbedding } from './retrieval.ts';

function flags(argv: readonly string[]): Map<string, string> {
  const values = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) if (argv[i]!.startsWith('--')) values.set(argv[i]!.slice(2), argv[i + 1]?.startsWith('--') ? '' : argv[i + 1] ?? '');
  return values;
}

/** Counts question embeddings per model; documents pass straight through. The built-in model's loaded-only view is counted too. */
function counted(provider: SourceEmbeddingProvider, counts: Map<string, number>): SourceEmbeddingProvider {
  const count = (inner: SourceEmbeddingProvider): SourceEmbeddingProvider['embed'] => (inputs, options) => {
    if (options.taskType === 'RETRIEVAL_QUERY') counts.set(inner.modelId, (counts.get(inner.modelId) ?? 0) + inputs.length);
    return inner.embed(inputs, options);
  };
  const loadedOnly = (provider as { loadedOnly?: () => SourceEmbeddingProvider }).loadedOnly;
  return Object.assign(Object.create(provider) as SourceEmbeddingProvider, {
    embed: count(provider),
    ...(loadedOnly ? { loadedOnly: () => { const view = loadedOnly.call(provider); return { ...view, embed: count(view) }; } } : {}),
  });
}

// Made-up document text, one embedding window long: what a sweep's batch costs the model.
const LOAD_TEXT = Array.from({ length: 300 }, (_, index) => `word${index % 97}`).join(' ');

/** Document batches back to back on the model until stopped. */
function backgroundEmbedding(provider: SourceEmbeddingProvider): { stop(): Promise<void>; batches(): number } {
  let running = true; let batches = 0;
  const loop = (async () => {
    while (running) {
      try { await provider.embed(Array.from({ length: 16 }, () => ({ text: LOAD_TEXT })), { taskType: 'RETRIEVAL_DOCUMENT' }); batches += 1; } catch { break; }
    }
  })();
  return { stop: async () => { running = false; await loop; }, batches: () => batches };
}

async function main(): Promise<void> {
  const { isolation, rest } = parseDataRootArgs(process.argv.slice(2));
  if (!isolation) throw new Error('--data-root is required.');
  const values = flags(rest);
  const queryFile = values.get('query-file');
  if (!queryFile) throw new Error('--query-file is required.');
  const questions = readFileSync(queryFile, 'utf8').split('\n').map(line => line.trim()).filter(Boolean);
  const trials = Number(values.get('trials') || 2);
  const maxResults = Number(values.get('max-results') || 24);
  const source = values.get('source') || 'dropbox.files';
  let live: { accountScope: string; filters: ConnectorStoreSearchFilters } | undefined;
  if (!rest.includes('--no-live-scope')) {
    const registryPath = values.get('registry');
    if (!registryPath) throw new Error('--registry is required (or --no-live-scope, for a comparison that does not count).');
    const scope = fileSourceScopeMetadataFilters(new FileSourceScopeAuthority({ registryPath }).snapshot(source));
    if (!scope.allowed) throw new Error('The source scope is not approved.');
    live = { accountScope: values.get('account') || 'personal', filters: scope.filters };
  }
  const opened = openEvalDataRoot(isolation);
  try {
    const embedding = await prepareEvalEmbedding({ configured: await configuredEvalEmbedding(loadConfig(), process.env) });
    const reranker = rest.includes('--no-rerank') ? undefined : await prepareBuiltInRerankerFromEnv();
    const counts = new Map<string, number>();
    const wrapped = new Map<SourceEmbeddingProvider, SourceEmbeddingProvider>();
    const embeddingFor = (domain: Parameters<typeof embedding.embeddingFor>[0]) => {
      const provider = embedding.embeddingFor(domain);
      if (!provider) return undefined;
      if (!wrapped.has(provider)) wrapped.set(provider, counted(provider, counts));
      return wrapped.get(provider);
    };
    const priority = rest.includes('--priority');
    const loadProvider = rest.includes('--embed-load')
      ? (() => { const provider = embedding.embeddingFor('secure_local') ?? embedding.embeddingFor('internal'); const view = (provider as { loadedOnly?: () => SourceEmbeddingProvider } | undefined)?.loadedOnly?.(); return view ?? provider; })()
      : undefined;
    if (rest.includes('--embed-load') && !loadProvider) throw new Error('--embed-load needs an embedding provider.');
    const lanes = createEvalSourceLanes({ ...opened, embeddingFor,
      ...(live ? { storeScope: store => store.corpusId.endsWith(`.${source}`) ? live : undefined } : {}) });
    console.log(JSON.stringify({ stores: opened.stores.length, skipped: opened.skipped.length, liveScope: live !== undefined,
      filterKeys: live ? Object.keys(live.filters).sort() : [], reranker: Boolean(reranker), embedLoad: loadProvider !== undefined, priority, questions: questions.length, trials }));
    for (const [index, question] of questions.entries()) {
      for (let trial = 1; trial <= trials; trial++) {
        counts.clear();
        const trace = createSourceAnswerTrace();
        const load = loadProvider ? backgroundEmbedding(loadProvider) : undefined;
        const started = performance.now();
        const build = async () => {
          const detail = await buildEvalPack({ question, lanes, maxResults, maxCharsPerCandidate: DEFAULT_MAX_CHARS_PER_CANDIDATE,
            ...(reranker ? { reranker } : {}) });
          recordSourceAnswerRerank(detail.rerank);
          return detail;
        };
        try {
          await runWithSourceAnswerTrace(trace, () => observeSourceAnswerRetrievalAttempt('hybrid', () => priority ? withPriorityQueryEmbedding(build) : build()));
        } finally { await load?.stop(); }
        const evidenceMs = Math.round(performance.now() - started);
        const snapshot = snapshotSourceAnswerTrace(trace);
        const attempt = snapshot.retrievalAttempts[0];
        const query = attempt?.queries[0];
        const stages = query?.stages;
        const slowest = [...(query?.corpus_timings ?? [])].sort((a, b) => b.elapsed_ms - a.elapsed_ms).slice(0, 3)
          .map(timing => ({ corpus: timing.corpus_id, ms: timing.elapsed_ms, outcome: timing.outcome,
            queueMs: timing.pool?.queue_wait_ms ?? null, sqlMs: timing.pool?.sql_ms ?? null, reads: timing.pool?.reads ?? null }));
        console.log(JSON.stringify({ q: index + 1, trial, evidenceMs, prepareMs: stages?.prepare_ms ?? null,
          prepareSemanticMaxMs: stages?.prepare_semantic_max_ms ?? null, prepareKeywordsMaxMs: stages?.prepare_keywords_max_ms ?? null,
          lanesMs: stages?.lanes_ms ?? null, afterLanesMs: stages?.after_lanes_ms ?? null, hydrationMs: attempt?.hydration_ms ?? null,
          rerankMs: snapshot.rerank?.elapsedMs ?? null, storesSearched: query?.corpus_timings.length ?? 0,
          queryEmbeds: Object.fromEntries(counts), ...(load ? { loadBatches: load.batches() } : {}), slowest }));
      }
    }
  } finally { opened.close(); }
}

await main();
