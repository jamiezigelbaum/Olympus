// Fixture-only calibration. No store, engine or sovereignty configuration is read.
// Run on Xanthos (credential-bearing API measurement, not a build/test job):
// VENICE_API_KEY=$(secret get Venice-API-Key) bun eval/calibration/venice-relevance.ts
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { OpenAICompatibleSourceEmbeddingProvider, VENICE_SOURCE_EMBEDDING_QUERY_INSTRUCTION, DEFAULT_VENICE_SOURCE_EMBEDDING_DIMENSION } from '../../src/workers/source-index/embeddings.ts';
import { VERSIONED_FIXTURE_ITEMS, VERSIONED_FIXTURE_QUESTIONS } from '../fixtures/versioned-documents.ts';
import { consultLeakCorpora } from '../consult-leak/corpus.ts';
import { HELD_OUT_BLIND_2 } from '../consult-leak/held-out-blind-2.ts';

const key = process.env.VENICE_API_KEY;
if (!key) throw new Error('VENICE_API_KEY is required');
const provider = new OpenAICompatibleSourceEmbeddingProvider({
  backend: 'cloud', provider: 'venice', baseUrl: 'https://api.venice.ai/api/v1',
  model: 'text-embedding-qwen3-8b', apiKeyProvider: () => key,
  dimension: DEFAULT_VENICE_SOURCE_EMBEDDING_DIMENSION, sendDimensions: true,
  requireDimension: true, requireIndexedResponses: true,
  queryInstructionPrefix: VENICE_SOURCE_EMBEDDING_QUERY_INSTRUCTION,
});
const corpora = consultLeakCorpora();
const documents = [
  ...VERSIONED_FIXTURE_ITEMS.map(({ title, text }) => ({ title, text })),
  ...corpora.flatMap(corpus => corpus.pack.candidates.map(candidate => ({
    title: candidate.provenance.citation?.title ?? corpus.id, text: candidate.chunks.join('\n'),
  }))),
];
const positives = [
  ...VERSIONED_FIXTURE_QUESTIONS.map(({ question }) => question),
  ...corpora.map(corpus => corpus.pack.question),
];
// Existing frozen blind set: none of these general questions has an answer
// in the synthetic fixture documents. Includes housing near misses.
const negatives = [...HELD_OUT_BLIND_2];
const vectors = await provider.embed(documents, { taskType: 'RETRIEVAL_DOCUMENT' });
const questions = [...positives, ...negatives];
const queryVectors = await provider.embed(questions.map(text => ({ text })), { taskType: 'RETRIEVAL_QUERY' });
function cosine(a: number[], b: number[]): number {
  const dot = a.reduce((sum, value, i) => sum + value * b[i]!, 0);
  return dot / Math.sqrt(a.reduce((sum, v) => sum + v * v, 0) * b.reduce((sum, v) => sum + v * v, 0));
}
const rows = questions.map((question, i) => {
  const scores = vectors.map(vector => cosine(queryVectors[i]!, vector));
  // Both version questions concern the offer versions; each consult fixture
  // question must match its own candidate, not an unrelated nearest neighbour.
  const expectedIndexes = i < 2 ? [0, 1, 2, 3] : [7 + i - 2];
  return {
    question, answerable: i < positives.length,
    bestCosine: Math.max(...scores),
    ...(i < positives.length ? { truePositiveCosine: Math.max(...expectedIndexes.map(index => scores[index]!)) } : {}),
  };
});
const offDomainPeak = Math.max(...rows.filter(row => !row.answerable).map(row => row.bestCosine));
const truePositiveFloor = Math.min(...rows.filter(row => row.answerable).map(row => row.truePositiveCosine!));
// Smallest hundredth strictly above the off-domain peak, as with Gemini.
const bar = Math.ceil((offDomainPeak + Number.EPSILON) * 100) / 100;
const report = {
  recordedAt: new Date().toISOString(), model: provider.modelId, dimension: provider.dimension,
  queryInstruction: VENICE_SOURCE_EMBEDDING_QUERY_INSTRUCTION,
  fixtureDigest: createHash('sha256').update(JSON.stringify({ documents, questions })).digest('hex'),
  documents: documents.length, positiveQuestions: positives.length, negativeQuestions: negatives.length,
  offDomainPeak, truePositiveFloor, bar, separates: bar <= truePositiveFloor, rows,
};
writeFileSync(new URL('./venice-relevance-result.json', import.meta.url), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ ...report, rows: undefined }, null, 2));
if (!report.separates) process.exitCode = 1;
