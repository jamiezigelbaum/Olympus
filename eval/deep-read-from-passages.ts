// Turns passage-eval questions into a deep-read dataset: one row per question,
// reading the whole of its first expected item that is in the data-root copy.
// For asking whether a deep read of the top file answers a question whose
// paragraph did not reach the ordinary prompt (1.5 items 7 and 8).
// Read-only; writes question text and quotes to --output, so keep that file
// beside the private dataset. Prints ids and counts only.
//   bun eval/deep-read-from-passages.ts --data-root <copy> --ids p026,p133 --output eval/private/deep-read.from-passages.json [dataset.json]
// A quote longer than the deep-read limit is cut to its first 40 words.
import { readFileSync, writeFileSync } from 'node:fs';
import { openEvalDataRoot } from './data-root.ts';
import { parseDataRootArgs } from './data-root-args.ts';
import { DEEP_READ_DATASET_VERSION, validateDeepReadDataset, type DeepReadDataset, type DeepReadQuestion } from './draft-deep-read-questions.ts';
import { validatePassageDataset } from './types.ts';

const QUOTE_WORDS = 40;

function option(args: string[], name: string): string | undefined {
  const at = args.indexOf(name);
  return at >= 0 ? args[at + 1] : undefined;
}

function main(): void {
  const { isolation, rest } = parseDataRootArgs(process.argv.slice(2));
  if (!isolation) throw new Error('--data-root is required.');
  const ids = new Set(option(rest, '--ids')?.split(',').filter(Boolean) ?? []);
  const output = option(rest, '--output');
  if (!ids.size || !output) throw new Error('--ids and --output are required.');
  const valued = new Set(['--ids', '--output'].flatMap(name => { const at = rest.indexOf(name); return at >= 0 ? [at + 1] : []; }));
  const datasetPath = rest.filter((arg, index) => !arg.startsWith('--') && !valued.has(index))[0] ?? 'eval/private/passage-questions.json';
  const dataset: unknown = JSON.parse(readFileSync(datasetPath, 'utf8'));
  validatePassageDataset(dataset);
  const opened = openEvalDataRoot(isolation);
  const questions: DeepReadQuestion[] = [];
  try {
    for (const question of dataset.questions.filter(q => ids.has(q.id))) {
      const row = (() => {
        for (const expected of question.expectedEvidence ?? []) {
          if (!expected.quote) continue;
          for (const identity of [expected, ...(expected.alternates ?? [])]) {
            const store = opened.stores.find(candidate => candidate.corpusId === identity.corpusId);
            if (!store || !identity.providerItemId) continue;
            const db = (store as unknown as { db: import('bun:sqlite').Database }).db;
            const item = db.query(`SELECT provider, account_scope, local_item_id, provider_item_id,
                (SELECT count(*) FROM chunks c WHERE c.item_pk = i.item_pk) AS chunks
              FROM items i WHERE provider_item_id = ? AND tombstoned = 0 LIMIT 1`)
              .get(identity.providerItemId) as { provider: string; account_scope: string; local_item_id: string; provider_item_id: string; chunks: number } | null;
            if (item) return { quote: expected.quote, corpusId: store.corpusId, item };
          }
        }
        return undefined;
      })();
      if (!row) { console.log(JSON.stringify({ id: question.id, miss: 'no_expected_item_in_copy' })); continue; }
      const words = row.quote.split(/\s+/).filter(Boolean);
      questions.push({
        id: question.id, kind: 'item', question: question.question, quote: words.slice(0, QUOTE_WORDS).join(' '),
        set: { whole: 'item', corpus_id: row.corpusId, provider: row.item.provider, account_scope: row.item.account_scope, local_item_id: row.item.local_item_id, provider_item_id: row.item.provider_item_id },
        expected: [{ corpus_id: row.corpusId, provider_item_id: row.item.provider_item_id, local_item_id: row.item.local_item_id }],
        target: { index: 0, of: row.item.chunks }, setItems: 1, setPassages: row.item.chunks, notes: 'natural',
      });
      console.log(JSON.stringify({ id: question.id, corpus: row.corpusId, chunks: row.item.chunks, quoteWords: words.length, quoteCut: words.length > QUOTE_WORDS }));
    }
  } finally { for (const store of opened.stores) store.close(); }
  const result: DeepReadDataset = { version: DEEP_READ_DATASET_VERSION, description: `Deep read of the expected item for ${questions.length} passage-eval questions.`, seed: [...ids].join(','), questions };
  validateDeepReadDataset(result);
  writeFileSync(output, `${JSON.stringify(result, null, 1)}\n`, { mode: 0o600 });
  console.log(JSON.stringify({ written: questions.length, asked: ids.size }));
}

main();
