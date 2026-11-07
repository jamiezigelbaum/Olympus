import { expect, test } from 'bun:test';
import { scorePrefilter, calibrationEmbeddingInputs } from './score-prefilter.ts';
import { EMBEDDING_PREFILTER_DIMENSIONS as D } from '../../src/workers/classification/embedding-logistic.ts';
import { buildConnectorStoreEmbeddingText, chunkText, DEFAULT_MAX_CHUNK_CHARS } from '../../src/workers/connector-store/local-index.ts';
import { promptText } from '../../src/workers/source-index/built-in-embedding/provider.ts';
import { EMBEDDINGGEMMA_2 } from '../../src/workers/source-index/built-in-embedding/manifest.ts';
const marker = 'DO_NOT_PRINT_fixture_item';
const item = { id: marker, name: marker, text: ' picnic '.repeat(900), mimeType: 'text/plain', modifiedAt: '', path: marker, rel: marker, area: marker, sizeBytes: 1, recordsHint: false };
const saved = { version: marker, revisions: marker, trainedAt: 1, judge: marker, model: { weights: new Array(D).fill(0), bias: 0 }, prior: { privateRate: 0.03, trainingPrivateRate: 0.5, personal: 970, private: 30, since: 0, until: 1 } };
test('production chunking and metadata framing feed the document prefix', () => {
  const inputs = calibrationEmbeddingInputs(item);
  expect(inputs.length).toBe(2);
  expect(inputs.map(input => promptText(EMBEDDINGGEMMA_2, input, 'RETRIEVAL_DOCUMENT'))).toEqual(
    chunkText(item.text, DEFAULT_MAX_CHUNK_CHARS).map(text => `title: ${marker} | text: ${buildConnectorStoreEmbeddingText({ title: marker, mime_type: 'text/plain', authored_at: null, updated_at: null, bounded_text: text })}`));
});
test('counts-only report contains no sample fields even on misses or embedding failure', async () => {
  const rounds = [{ round: 3, sample: { items: [item, { ...item, id: 'p' }, { ...item, id: 'u' }] }, labels: { [marker]: { label: 'private' }, p: { label: 'personal' }, u: { label: 'unsure' } } }] as const;
  const vector = [1, ...new Array(D - 1).fill(0)];
  const report = await scorePrefilter(saved, rounds, async inputs => inputs.map(() => vector));
  expect(report).toEqual({ labelled: { personal: 1, private: 1, unsure: 1 }, uncorrected: { cleared: 0, privateMisses: 0, misses: [] }, corrected: { cleared: 3, privateMisses: 1, misses: [{ p: expect.any(Number), round: 3 }] }, unscorable: 0 });
  expect(report.corrected.misses[0]!.p).toBeCloseTo(0.03, 12);
  expect(JSON.stringify(report)).not.toContain(marker);
  const failed = await scorePrefilter(saved, rounds, async () => { throw new Error(marker); });
  expect(failed.unscorable).toBe(3); expect(JSON.stringify(failed)).not.toContain(marker);
});


test('scores the normalized mean of complete Float32 chunk vectors, not per-chunk probabilities', async () => {
  const model = { ...saved, prior: { ...saved.prior, privateRate: 0.5 }, model: { weights: [10, ...new Array(D - 1).fill(0)], bias: -11 } };
  const report = await scorePrefilter(model, [{ round: 2, sample: { items: [item] }, labels: { [marker]: { label: 'private' } } }],
    async () => [[1, ...new Array(D - 1).fill(0)], [0, 1, ...new Array(D - 2).fill(0)]]);
  expect(report.corrected.privateMisses).toBe(1);
  expect(report.corrected.misses[0]!.p).toBeCloseTo(1 / (1 + Math.exp(11 - 10 / Math.sqrt(2))), 12);
});
test('CLI failure prints only a fixed error count, never the missing input path', () => {
  const result = Bun.spawnSync([process.execPath, '--no-install', new URL('./score-prefilter.ts', import.meta.url).pathname, '--weights', `/missing/${marker}`]);
  expect(result.exitCode).toBe(1);
  expect(result.stdout.toString()).toBe('');
  expect(result.stderr.toString()).toBe('{"errors":1}\n');
});
