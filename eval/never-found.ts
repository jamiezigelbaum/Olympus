// Why a question's expected item is never found by either lane, for the rows
// a passage receipt marks not_found. Read-only on an offline data-root copy;
// prints ids, codes and numbers only, never item or question text.
//   bun eval/never-found.ts --data-root <copy> --receipt <passage receipt.json> [dataset.json]
// Per expected item (alternates included):
//   miss: not_in_store | tombstoned | no_chunks | not_embedded | hidden | held | servable
//   exactRank: the item's rank among all items of its store by best exact
//     cosine to the question (every current vector, no digest, no scope)
//   neighbourRank: the best such rank among the 3 messages before and after
//     it in its conversation (by authored time), when it has one: a neighbour
//     ranked high with the item ranked low says the meaning is in the thread,
//     not the message
//   chars and quoteWords: the item's stored text length and the expected
//     quote's word count.
import { Database } from 'bun:sqlite';
import { readFileSync } from 'node:fs';
import { loadConfig } from '../src/core/config.ts';
import { connectorStoreCurrentEmbeddingRowsIterator } from '../src/workers/connector-store/local-index.ts';
import { cosineSimilarity, decodeEmbedding } from '../src/workers/source-index/embeddings.ts';
import { openEvalDataRoot } from './data-root.ts';
import { parseDataRootArgs } from './data-root-args.ts';
import { configuredEvalEmbedding, prepareEvalEmbedding } from './retrieval.ts';
import { validatePassageDataset } from './types.ts';

const NEIGHBOURS = 3;

async function main(): Promise<void> {
  const { isolation, rest } = parseDataRootArgs(process.argv.slice(2));
  if (!isolation) throw new Error('--data-root is required.');
  const at = rest.indexOf('--receipt');
  const receiptPath = at >= 0 ? rest[at + 1] : undefined;
  if (!receiptPath) throw new Error('--receipt is required.');
  const datasetPath = rest.filter((arg, index) => !arg.startsWith('--') && index !== at + 1)[0] ?? 'eval/private/passage-questions.json';
  const receipt = JSON.parse(readFileSync(receiptPath, 'utf8')) as { questions?: Array<{ questionId: string; funnel?: { stage: string } }> };
  const wanted = new Set((receipt.questions ?? []).filter(row => row.funnel?.stage === 'not_found').map(row => row.questionId));
  const dataset: unknown = JSON.parse(readFileSync(datasetPath, 'utf8'));
  validatePassageDataset(dataset);
  const questions = dataset.questions.filter(question => wanted.has(question.id));
  const opened = openEvalDataRoot(isolation);
  const embedding = await prepareEvalEmbedding({ configured: await configuredEvalEmbedding(loadConfig(), process.env) });
  try {
    for (const question of questions) {
      for (const expected of question.expectedEvidence ?? []) {
        for (const identity of [expected, ...(expected.alternates ?? [])]) {
          const store = opened.stores.find(candidate => candidate.corpusId === identity.corpusId);
          const base = { id: question.id, corpus: identity.corpusId, alternate: identity !== expected,
            quoteWords: (expected.quote ?? '').split(/\s+/).filter(Boolean).length };
          if (!store || !identity.providerItemId) { console.log(JSON.stringify({ ...base, miss: store ? 'no_item_id' : 'store_not_in_copy' })); continue; }
          const db = new Database(store.dbPath, { readonly: true, create: false, strict: true });
          db.exec('PRAGMA query_only = ON');
          try {
            const item = db.query('SELECT item_pk, tombstoned, provider_conversation_id AS conversation, authored_at FROM items WHERE provider_item_id = ? ORDER BY tombstoned ASC LIMIT 1')
              .get(identity.providerItemId) as { item_pk: number; tombstoned: number; conversation: string | null; authored_at: string | null } | null;
            if (!item) { console.log(JSON.stringify({ ...base, miss: 'not_in_store' })); continue; }
            const chars = (db.query('SELECT COALESCE(SUM(length(bounded_text)), 0) AS n, COUNT(*) AS chunks FROM chunks WHERE item_pk = ?').get(item.item_pk) as { n: number; chunks: number });
            const provider = embedding.embeddingFor(store.trustDomain);
            const embedded = provider ? (db.query(`SELECT COUNT(*) AS n FROM chunk_embeddings e JOIN chunks c ON c.chunk_pk = e.chunk_pk
              WHERE e.item_pk = ? AND e.model_id = ? AND e.content_hash = c.embedding_input_hash`).get(item.item_pk, provider.modelId) as { n: number }).n : 0;
            let visibility = 'servable';
            try {
              const hidden = (store as unknown as { tierLedgerHiddenItemPks(): { hidden: number[]; held: number[]; metadataLayer: number[] } }).tierLedgerHiddenItemPks();
              if (hidden.hidden.includes(item.item_pk)) visibility = 'hidden';
              else if (hidden.held.includes(item.item_pk)) visibility = 'held';
              else if (hidden.metadataLayer.includes(item.item_pk)) visibility = 'metadata_only';
            } catch { visibility = 'unknown'; }
            const miss = item.tombstoned ? 'tombstoned' : chars.chunks === 0 ? 'no_chunks' : embedded === 0 ? 'not_embedded' : visibility;
            const neighbours = item.conversation ? (db.query(`
              SELECT item_pk FROM (SELECT item_pk FROM items WHERE provider_conversation_id = ? AND tombstoned = 0 AND authored_at < ? ORDER BY authored_at DESC LIMIT ${NEIGHBOURS})
              UNION ALL SELECT item_pk FROM (SELECT item_pk FROM items WHERE provider_conversation_id = ? AND tombstoned = 0 AND authored_at > ? ORDER BY authored_at ASC LIMIT ${NEIGHBOURS})`)
              .all(item.conversation, item.authored_at ?? '', item.conversation, item.authored_at ?? '') as Array<{ item_pk: number }>).map(row => row.item_pk) : [];
            let exactRank: number | null = null; let neighbourRank: number | null = null;
            if (provider && embedded > 0) {
              const [vector] = await provider.embed([{ text: question.question }], { taskType: 'RETRIEVAL_QUERY' });
              const best = new Map<number, number>();
              db.exec('BEGIN DEFERRED');
              try {
                for (const row of connectorStoreCurrentEmbeddingRowsIterator(db, { modelId: provider.modelId })) {
                  const stored = decodeEmbedding(row.embedding);
                  if (!vector || stored.length !== vector.length) continue;
                  const score = cosineSimilarity(vector, stored);
                  if (score > (best.get(row.itemPk) ?? -Infinity)) best.set(row.itemPk, score);
                }
              } finally { db.exec('ROLLBACK'); }
              const order = [...best].sort((a, b) => b[1] - a[1]).map(([pk]) => pk);
              const rankOf = (pk: number) => { const index = order.indexOf(pk); return index < 0 ? null : index + 1; };
              exactRank = rankOf(item.item_pk);
              const ranks = neighbours.map(rankOf).filter((rank): rank is number => rank !== null);
              neighbourRank = ranks.length ? Math.min(...ranks) : null;
            }
            console.log(JSON.stringify({ ...base, miss, chunks: chars.chunks, embeddedChunks: embedded, chars: chars.n,
              inConversation: Boolean(item.conversation), neighbours: neighbours.length, exactRank, neighbourRank }));
          } finally { db.close(); }
        }
      }
    }
  } finally { for (const store of opened.stores) store.close(); }
}

await main();
