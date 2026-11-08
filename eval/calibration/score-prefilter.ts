// Offline, counts-only comparison. Never writes samples, text, vectors or scores.
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CALIBRATION_DIR_DEFAULT, readSample, type CalibrationSampleItem, type CalibrationLabel } from './files.ts';
import { chunkText, DEFAULT_MAX_CHUNK_CHARS, buildConnectorStoreEmbeddingText } from '../../src/workers/connector-store/local-index.ts';
import { prefilterVector, type SavedModel } from '../../src/workers/classification/embedding-prefilter.ts';
import { privateProbability, EMBEDDING_PREFILTER_MODEL_ID } from '../../src/workers/classification/embedding-logistic.ts';
import { promptText, normalize } from '../../src/workers/source-index/built-in-embedding/provider.ts';
import { builtInEmbeddingPaths, installedBuiltInEmbedding } from '../../src/workers/source-index/built-in-embedding/assets.ts';
import { EMBEDDINGGEMMA_2 } from '../../src/workers/source-index/built-in-embedding/manifest.ts';
import { startLiteRtEmbedder } from '../../src/workers/source-index/built-in-embedding/litert-runtime.ts';
import type { SourceEmbeddingInput } from '../../src/workers/source-index/embeddings.ts';

type Round = { round: number; sample: { items: readonly CalibrationSampleItem[] }; labels: Readonly<Record<string, { label: CalibrationLabel }>> };
type Scores = { cleared: number; privateMisses: number; misses: Array<{ p: number; round: number }> };

/** Production recipe applied to the saved sample's fields. No label/context/judge excerpt is added.
 * Message names are sampling ids, not titles. Historical samples omit search_text and may
 * contain bounded/rejoined text; this cannot reconstruct the original store bytes. */
export function calibrationEmbeddingInputs(item: CalibrationSampleItem): SourceEmbeddingInput[] {
  const title = item.source ? item.signals?.title ?? null : item.name || null;
  return chunkText(item.text, DEFAULT_MAX_CHUNK_CHARS).map(bounded_text => ({
    ...(title ? { title } : {}),
    text: buildConnectorStoreEmbeddingText({ title, mime_type: item.mimeType || null,
      authored_at: null, updated_at: item.modifiedAt || null, bounded_text }),
  }));
}

export async function scorePrefilter(saved: SavedModel, rounds: readonly Round[],
  embed: (inputs: SourceEmbeddingInput[]) => Promise<number[][]>) {
  const report = { labelled: { personal: 0, private: 0, unsure: 0 },
    cutoffs: { '0.001': { cleared: 0, privateMisses: 0, misses: [] } as Scores,
      '0.002': { cleared: 0, privateMisses: 0, misses: [] } as Scores,
      '0.01': { cleared: 0, privateMisses: 0, misses: [] } as Scores,
      '0.02': { cleared: 0, privateMisses: 0, misses: [] } as Scores,
      '0.05': { cleared: 0, privateMisses: 0, misses: [] } as Scores }, unscorable: 0 };
  for (const { round, sample, labels } of rounds) for (const item of sample.items) {
    const label = labels[item.id]?.label;
    if (label !== 'personal' && label !== 'private' && label !== 'unsure') continue;
    report.labelled[label]++;
    try {
      const inputs = calibrationEmbeddingInputs(item);
      const chunks = chunkText(item.text, DEFAULT_MAX_CHUNK_CHARS);
      const embeddings = await embed(inputs);
      // Match production's Float32 storage before prefilterVector's arithmetic mean.
      const vector = prefilterVector({ chunks: chunks.map((boundedText, chunkIndex) => ({ chunkIndex, boundedText, embeddingInputHash: String(chunkIndex) })),
        vectors: embeddings.map((values, chunkIndex) => ({ chunkIndex, modelId: EMBEDDING_PREFILTER_MODEL_ID,
          contentHash: String(chunkIndex), embedding: new Uint8Array(new Float32Array(values).buffer) })) });
      const raw = vector && privateProbability(saved.model, vector);
      if (raw === undefined) { report.unscorable++; continue; }
      const p = raw;
      for (const [cutoff, scores] of Object.entries(report.cutoffs)) if (p < Number(cutoff)) {
        scores.cleared++;
        if (label === 'private') { scores.privateMisses++; scores.misses.push({ p, round }); }
      }
    } catch { report.unscorable++; } // Never echo native errors, input text or paths.
  }
  return report;
}

function loadRounds(root: string): Round[] {
  return ['', 'round2', 'round3', 'round4'].map((directory, index) => {
    const dir = join(root, directory);
    const labels = JSON.parse(readFileSync(join(dir, index === 2 ? 'labels.final.json' : 'labels.json'), 'utf8'));
    if (labels.version !== 1 || !labels.labels || typeof labels.labels !== 'object') throw new Error('invalid_labels');
    const sample = readSample(dir);
    if (sample.version !== 1 || !Array.isArray(sample.items)) throw new Error('invalid_sample');
    return { round: index + 1, sample, labels: labels.labels };
  });
}
function flag(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index < 0 ? undefined : process.argv[index + 1];
}
async function main(): Promise<void> {
  const weights = flag('--weights');
  if (!weights) throw new Error('weights_required');
  const saved = JSON.parse(readFileSync(weights, 'utf8')) as SavedModel;
  if (privateProbability(saved.model, [1, ...new Array(767).fill(0)]) === undefined) throw new Error('invalid_model');
  const synthetic = process.argv.includes('--synthetic');
  const rounds: Round[] = synthetic ? [{ round: 1, sample: { items: [{ id: 'synthetic', name: 'Picnic', text: 'Bring sandwiches to the picnic.', mimeType: 'text/plain', modifiedAt: '', path: '', rel: '', area: '', sizeBytes: 29, recordsHint: false }] }, labels: { synthetic: { label: 'private' } } }]
    : loadRounds(flag('--calibration-dir') ?? CALIBRATION_DIR_DEFAULT);
  // Resolve installed files only. No installer, provider configuration, remote URL,
  // token file or fetch implementation is reachable from this tool.
  const env = { OLYMPUS_BUILT_IN_EMBEDDING_DIR: flag('--embedding-dir') ?? process.env.OLYMPUS_BUILT_IN_EMBEDDING_DIR };
  const installed = installedBuiltInEmbedding(builtInEmbeddingPaths(env, EMBEDDINGGEMMA_2), EMBEDDINGGEMMA_2);
  if (!installed.libraryPath || !existsSync(installed.libraryPath) || !existsSync(installed.modelPath)) throw new Error('runtime_missing');
  const cacheDir = mkdtempSync(join(tmpdir(), 'olympus-prefilter-score-'));
  try {
    const runtime = await startLiteRtEmbedder({ library: installed.libraryPath, model: installed.modelPath,
      cacheDir, threads: 4, device: 'cpu', maxInputTokens: EMBEDDINGGEMMA_2.maxTokens });
    try {
      const report = await scorePrefilter(saved, rounds, async inputs => {
        const vectors: number[][] = [];
        for (let offset = 0; offset < inputs.length; offset += 8) {
          const batch = await runtime.embed(inputs.slice(offset, offset + 8).map(input => promptText(EMBEDDINGGEMMA_2, input, 'RETRIEVAL_DOCUMENT')));
          vectors.push(...batch.map(normalize));
        }
        return vectors;
      });
      process.stdout.write(`${JSON.stringify(report)}\n`);
    } finally { await runtime.release(); }
  } finally { rmSync(cacheDir, { recursive: true, force: true }); }
}
if (import.meta.main) main().catch(() => { process.stderr.write('{"errors":1}\n'); process.exitCode = 1; });
