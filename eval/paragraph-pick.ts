// Why the store's passage pick leaves an expected paragraph out of a long
// item, for the rows a passage receipt marks fitted_no_passage (or --ids).
// Read-only on an offline data-root copy; prints ids, indexes and numbers
// only, never item or question text.
//   bun eval/paragraph-pick.ts --data-root <copy> --receipt <passage receipt.json> [--ids p026,p133 | --all] [--max-chars 3000] [--rerank] [dataset.json]
// Per expected item (alternates included):
//   chunks, chunkChars: the item's stored chunks and each one's length
//   quoteChunks: indexes of the chunks holding the expected quote (word rule);
//     quoteSpans when it only matches across two neighbouring chunks
//   quoteCosineRank: the best quote chunk's rank among the item's chunks by
//     cosine to the question (1 = most similar), and topCosineGap: best minus
//     the quote chunk's cosine
//   picked: the chunks the store's own pick returns for the question at
//     --max-chars (no anchor, as a vector or keyword anchor varies by lane),
//     in priority order, with the characters read from each
//   pickedQuote: whether the pick's text holds the quote.
// With --rerank (OLYMPUS_SOURCE_RERANKER=built-in and its model directory
// set), a reranker-led pick is sized before one is built: the item's 16 most
// similar chunks are cut into 800-character windows (600 apart), each scored
// by the reranker against the question.
//   rerankWindows, rerankMs: windows scored and the time it took
//   rerankPick: for a shortlist of the 4, 8 and 16 most similar chunks,
//     quoteChunkRank (the quote chunk's rank among the shortlist by its best
//     window; null when it is not in the shortlist) and pickedQuote (whether
//     the best windows, kept up to --max-chars, hold the quote).
import { readFileSync } from 'node:fs';
import { loadConfig } from '../src/core/config.ts';
import { withExpandedSourceIndexKeywords } from '../src/core/source-index/keyword-expansion.ts';
import { cosineSimilarity, decodeEmbedding } from '../src/workers/source-index/embeddings.ts';
import { openEvalDataRoot } from './data-root.ts';
import { parseDataRootArgs } from './data-root-args.ts';
import { passageContainsQuote } from './passage-match.ts';
import { configuredEvalEmbedding, prepareEvalEmbedding } from './retrieval.ts';
import { validatePassageDataset } from './types.ts';
import { prepareCaptureReranker } from './capture-pool.ts';
import { sizeRerankPick } from './paragraph-pick-rerank.ts';

function option(args: string[], name: string): string | undefined {
  const at = args.indexOf(name);
  return at >= 0 ? args[at + 1] : undefined;
}

async function main(): Promise<void> {
  const { isolation, rest } = parseDataRootArgs(process.argv.slice(2));
  if (!isolation) throw new Error('--data-root is required.');
  const receiptPath = option(rest, '--receipt');
  const ids = option(rest, '--ids')?.split(',').filter(Boolean);
  const all = rest.includes('--all');
  const withRerank = rest.includes('--rerank');
  if (!receiptPath && !ids && !all) throw new Error('--receipt, --ids or --all is required.');
  const maxChars = Number(option(rest, '--max-chars') ?? 3000);
  const valued = new Set(['--receipt', '--ids', '--max-chars'].flatMap(name => { const at = rest.indexOf(name); return at >= 0 ? [at + 1] : []; }));
  const datasetPath = rest.filter((arg, index) => !arg.startsWith('--') && !valued.has(index))[0] ?? 'eval/private/passage-questions.json';
  const wanted = new Set(ids ?? []);
  if (receiptPath) {
    const receipt = JSON.parse(readFileSync(receiptPath, 'utf8')) as { questions?: Array<{ questionId: string; funnel?: { stage: string } }> };
    if (!ids) for (const row of receipt.questions ?? []) if (row.funnel?.stage === 'fitted_no_passage') wanted.add(row.questionId);
  }
  const dataset: unknown = JSON.parse(readFileSync(datasetPath, 'utf8'));
  validatePassageDataset(dataset);
  if (all) for (const question of dataset.questions) wanted.add(question.id);
  const reranker = withRerank ? await prepareCaptureReranker(process.env) : undefined;
  if (withRerank && !reranker) throw new Error('--rerank needs OLYMPUS_SOURCE_RERANKER=built-in.');
  const opened = openEvalDataRoot(isolation);
  const embedding = await prepareEvalEmbedding({ configured: await configuredEvalEmbedding(loadConfig(), process.env) });
  try {
    for (const question of dataset.questions.filter(q => wanted.has(q.id))) {
      for (const expected of question.expectedEvidence ?? []) {
        const quote = expected.quote ?? '';
        for (const identity of [expected, ...(expected.alternates ?? [])]) {
          const store = opened.stores.find(candidate => candidate.corpusId === identity.corpusId);
          const base = { id: question.id, corpus: identity.corpusId, alternate: identity !== expected };
          if (!store || !identity.providerItemId) { console.log(JSON.stringify({ ...base, miss: store ? 'no_item_id' : 'store_not_in_copy' })); continue; }
          const db = (store as unknown as { db: import('bun:sqlite').Database }).db;
          const item = db.query('SELECT item_pk, local_item_id FROM items WHERE provider_item_id = ? AND tombstoned = 0 LIMIT 1')
            .get(identity.providerItemId) as { item_pk: number; local_item_id: string } | null;
          if (!item) { console.log(JSON.stringify({ ...base, miss: 'not_in_store' })); continue; }
          const provider = embedding.embeddingFor(store.trustDomain);
          const chunks = db.query(`SELECT c.chunk_index, c.bounded_text, c.content_hash, e.embedding FROM chunks c
            LEFT JOIN chunk_embeddings e ON e.chunk_pk = c.chunk_pk AND e.model_id = ? AND e.content_hash = c.embedding_input_hash
            WHERE c.item_pk = ? ORDER BY c.chunk_index`).all(provider?.modelId ?? '', item.item_pk) as Array<{ chunk_index: number; bounded_text: string; content_hash: string; embedding: unknown }>;
          const quoteChunks = quote ? chunks.filter(chunk => passageContainsQuote(chunk.bounded_text, quote)).map(chunk => chunk.chunk_index) : [];
          const quoteSpans = quote && !quoteChunks.length
            ? chunks.slice(1).filter((chunk, at) => passageContainsQuote(`${chunks[at]!.bounded_text}\n${chunk.bounded_text}`, quote)).map(chunk => [chunk.chunk_index - 1, chunk.chunk_index])
            : [];
          const [vector] = provider ? await provider.embed([{ text: question.question }], { taskType: 'RETRIEVAL_QUERY' }) : [];
          const cosines = chunks.map(chunk => {
            if (!vector || chunk.embedding === null || chunk.embedding === undefined) return null;
            const stored = decodeEmbedding(chunk.embedding);
            return stored.length === vector.length ? cosineSimilarity(vector, stored) : null;
          });
          const order = cosines.map((score, at) => ({ score, index: chunks[at]!.chunk_index })).filter(entry => entry.score !== null)
            .sort((a, b) => b.score! - a.score!);
          const targets = quoteChunks.length ? quoteChunks : quoteSpans.flat();
          const ranks = targets.map(index => order.findIndex(entry => entry.index === index) + 1).filter(rank => rank > 0);
          const quoteCosineRank = ranks.length ? Math.min(...ranks) : null;
          const quoteBest = quoteCosineRank ? order[quoteCosineRank - 1]!.score! : null;
          const rerank = reranker && quote && order.length
            ? await sizeRerankPick({
                reranker, question: question.question, quote, maxChars, targets,
                chunks: chunks.map(chunk => ({ index: chunk.chunk_index, text: chunk.bounded_text })),
                shortlist: order.slice(0, 16).map(entry => entry.index),
              })
            : {};
          const content = await withExpandedSourceIndexKeywords(question.question, () => store.keywordLanguages(), () => store.localContent(item.local_item_id, maxChars, {
            query: question.question,
            ...(vector && provider ? { queryVector: vector, queryVectorModelId: provider.modelId } : {}),
          }), store);
          const byHash = new Map(chunks.map(chunk => [chunk.content_hash, chunk.chunk_index]));
          const picked = (content?.chunks ?? []).map((text, at) => ({
            chunks: (content?.chunkHashes?.[at] ?? []).map(hash => byHash.get(hash) ?? -1),
            chars: text.length,
          }));
          console.log(JSON.stringify({ ...base, chunks: chunks.length, chunkChars: chunks.map(chunk => chunk.bounded_text.length),
            quoteWords: quote.split(/\s+/).filter(Boolean).length, quoteChunks, ...(quoteSpans.length ? { quoteSpans } : {}),
            quoteCosineRank, topCosineGap: quoteBest !== null && order.length ? Number((order[0]!.score! - quoteBest).toFixed(4)) : null,
            picked, pickedQuote: Boolean(quote && passageContainsQuote((content?.chunks ?? []).join('\n'), quote)), ...rerank }));
        }
      }
    }
  } finally { for (const store of opened.stores) store.close(); }
}

await main();
