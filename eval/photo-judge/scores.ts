// Photo judge calibration: the score matrix (docs/design/photo-embeddings.md,
// "Photo judge"). Stands apart from the plugin: it reads pictures and the
// built-in model, never an Olympus store.
//
// Every picture in a folder (or listed in a manifest) is read by the built-in
// EmbeddingGemma 2 exactly as the judge reads it (prepared, image-only
// vector), and scored against every candidate description below. The output
// is the whole matrix, so any prompt set and threshold can be tried
// afterwards without the pictures or the model (eval/photo-judge/replay.ts).
//
//   bun eval/photo-judge/scores.ts --dir <folder> --label <sensitive|ordinary> \
//     --group <name> [--anonymize] --out <scores.json>
//   bun eval/photo-judge/scores.ts --manifest <manifest.json> --out <scores.json>
//
// A manifest is [{ "file": "<path>", "label": "sensitive" | "ordinary", "group": "<name>" }].
// `--anonymize` records each picture by a digest prefix instead of its name
// (the owner's own photos). Runs on a Mac with the model (macOS `sips`
// prepares pictures). OLYMPUS_BUILT_IN_EMBEDDING_DIR reuses an installed model.

import { createHash } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, extname, join, resolve } from 'node:path';
import { MEDIA_CACHE_DIR_ENV, mediaCacheDir } from '../../src/core/media-cache.ts';
import { createImagePreparation } from '../../src/workers/file-extraction/extractors/image-prepare.ts';
import { BuiltInSourceEmbeddingProvider } from '../../src/workers/source-index/built-in-embedding/provider.ts';
import { MEDIA_JUDGE_PROMPT_PREFIX } from '../../src/workers/source-index/media-judge.ts';
import { PHOTO_JUDGE_CANDIDATE_DESCRIPTIONS } from './candidates.ts';

interface ManifestEntry { file: string; label: 'sensitive' | 'ordinary'; group: string }

const IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.heic', '.heif', '.webp', '.gif', '.tif', '.tiff', '.bmp']);

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function entries(): ManifestEntry[] {
  const manifest = argument('manifest');
  if (manifest) {
    const base = resolve(manifest, '..');
    return (JSON.parse(readFileSync(manifest, 'utf8')) as ManifestEntry[]).map((entry) => ({ ...entry, file: resolve(base, entry.file) }));
  }
  const dir = argument('dir');
  const label = argument('label');
  if (!dir || (label !== 'sensitive' && label !== 'ordinary')) {
    throw new Error('Give --manifest <file>, or --dir <folder> with --label sensitive|ordinary.');
  }
  const group = argument('group') ?? basename(dir);
  const walk = (folder: string): string[] => readdirSync(folder).sort().flatMap((name) => {
    const path = join(folder, name);
    if (statSync(path).isDirectory()) return walk(path);
    return IMAGE_EXTENSIONS.has(extname(name).toLowerCase()) ? [path] : [];
  });
  return walk(resolve(dir)).map((file) => ({ file, label, group }));
}

function dot(left: readonly number[], right: readonly number[]): number {
  let sum = 0;
  for (let index = 0; index < Math.min(left.length, right.length); index += 1) sum += left[index]! * right[index]!;
  return sum;
}

async function main(): Promise<void> {
  const out = argument('out');
  if (!out) throw new Error('Give --out <scores.json>.');
  const anonymize = process.argv.includes('--anonymize');
  const list = entries();
  const cacheBase = mkdtempSync(join(tmpdir(), 'olympus-photo-judge-scores-'));
  process.env[MEDIA_CACHE_DIR_ENV] = cacheBase;
  try {
    const provider = new BuiltInSourceEmbeddingProvider({ env: { ...process.env, [MEDIA_CACHE_DIR_ENV]: cacheBase } });
    await provider.prepare();
    if (!(await provider.imageSupport())) throw new Error('The built-in model cannot read pictures on this machine.');
    const keys = Object.keys(PHOTO_JUDGE_CANDIDATE_DESCRIPTIONS);
    const descriptionVectors = await provider.embedPromptTexts(keys.map((key) => `${MEDIA_JUDGE_PROMPT_PREFIX}${PHOTO_JUDGE_CANDIDATE_DESCRIPTIONS[key]}`));
    const prepare = createImagePreparation({ cacheDir: mediaCacheDir({ [MEDIA_CACHE_DIR_ENV]: cacheBase }) });
    const images: Array<{ id: string; label: string; group: string; scores?: Record<string, number>; error?: string }> = [];
    for (const entry of list) {
      const bytes = new Uint8Array(readFileSync(entry.file));
      const id = anonymize ? createHash('sha256').update(bytes).digest('hex').slice(0, 12) : basename(entry.file);
      try {
        const ext = extname(entry.file).toLowerCase();
        const prepared = await prepare({ bytes, sizeBytes: bytes.byteLength, mimeType: ext === '.png' ? 'image/png' : ext === '.heic' ? 'image/heic' : 'image/jpeg' });
        if (prepared.kind !== 'media') throw new Error('not prepared');
        const [vector] = await provider.embedImageVectors([{ path: prepared.media.path, sha256: prepared.media.sha256, mimeType: 'image/jpeg' }]);
        if (!vector || vector.length === 0) throw new Error('unreadable');
        const scores = Object.fromEntries(keys.map((key, index) => [key, Math.round(dot(vector, descriptionVectors[index]!) * 1e5) / 1e5]));
        images.push({ id, label: entry.label, group: entry.group, scores });
      } catch (error) {
        images.push({ id, label: entry.label, group: entry.group, error: error instanceof Error ? error.message : String(error) });
      }
      process.stderr.write(`\r${images.length}/${list.length}`);
    }
    process.stderr.write('\n');
    writeFileSync(out, `${JSON.stringify({ model: provider.modelId, configHash: provider.configHash, descriptions: PHOTO_JUDGE_CANDIDATE_DESCRIPTIONS, images }, null, 1)}\n`);
  } finally {
    rmSync(cacheBase, { recursive: true, force: true });
  }
}

await main();
// The model's helper process would keep the script alive.
process.exit(0);
