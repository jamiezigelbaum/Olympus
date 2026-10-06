// Pins the built-in EmbeddingGemma 2 model: resolves a Hugging Face revision
// to its commit, reads each file's size and SHA-256 from the Hub's tree API
// (hashing the small non-LFS files itself), and prints — or with --write,
// writes — the PINNED block of
// src/workers/source-index/built-in-embedding/manifest.ts.
//
//   bun scripts/pin-built-in-embedding.ts --list
//   bun scripts/pin-built-in-embedding.ts --model onnx/model_quantized.onnx
//   bun scripts/pin-built-in-embedding.ts --model onnx/model_quantized.onnx --write
//
// --write also renames the model id everywhere the previous pin's id appears
// (presets, the identity registry, docs, tests). Every URL it pins is checked
// to download without a Hugging Face login, because installs fetch them
// anonymously. HF_TOKEN, when set, is used only for the metadata reads.

import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dir, '..');
const MANIFEST = join(ROOT, 'src/workers/source-index/built-in-embedding/manifest.ts');
const BEGIN = '// BEGIN PINNED embeddinggemma-2';
const END = '// END PINNED embeddinggemma-2';
const HUB = 'https://huggingface.co';
/** Google's Gemma 4 tokenizer (gs://gemma-data/tokenizers/tokenizer_gemma4.model): the parity fixture's source. */
const GEMMA4_TOKENIZER_SHA256 = '9f318ac4dc02f8580e3f65ff0b37286e7c3d1e5d664737bb2c8ca812b5453162';
/** Files outside the source tree that name the model id. */
const RENAME_TARGETS = ['config/sovereignty/presets', 'docs/SOVEREIGNTY_CONFIG.md', 'src/workers/source-index/embedding-identity.ts', 'test'];

export interface HubTreeEntry {
  type: 'file' | 'directory';
  path: string;
  size: number;
  oid: string;
  lfs?: { oid: string; size: number };
}

export interface PinnedFileValue {
  name: string;
  path: string;
  bytes: number;
  sha256: string;
}

export interface EmbeddingGemmaPin {
  modelId: string;
  repository: string;
  revision: string;
  model: PinnedFileValue;
  modelData?: PinnedFileValue;
  vocabulary: PinnedFileValue;
}

interface Args {
  repo: string;
  revision: string;
  model?: string;
  tokenizer: string;
  list: boolean;
  write: boolean;
}

function parseArgs(argv: readonly string[]): Args {
  const args: Args = {
    repo: 'onnx-community/embeddinggemma-2-ONNX',
    revision: 'main',
    tokenizer: 'tokenizer.model',
    list: false,
    write: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index]!;
    const value = () => {
      const next = argv[++index];
      if (!next) throw new Error(`${flag} needs a value.`);
      return next;
    };
    if (flag === '--repo') args.repo = value();
    else if (flag === '--revision') args.revision = value();
    else if (flag === '--model') args.model = value();
    else if (flag === '--tokenizer') args.tokenizer = value();
    else if (flag === '--list') args.list = true;
    else if (flag === '--write') args.write = true;
    else throw new Error(`Unknown flag ${flag}.`);
  }
  return args;
}

/** `model_quantized.onnx` → `int8`; `model_q4f16.onnx` → `q4f16`; `model.onnx` → `fp32`. */
export function variantOf(modelPath: string): string {
  const base = modelPath.split('/').pop()!.replace(/\.onnx$/, '');
  const suffix = base.replace(/^[^_]*_?/, '');
  if (base === suffix || suffix === '') return 'fp32';
  return suffix === 'quantized' ? 'int8' : suffix;
}

/** The pin for one model file, its external data (if any) and the tokenizer, from a commit's tree. */
export function pinFromTree(
  tree: readonly HubTreeEntry[],
  options: { repository: string; commit: string; model: string; tokenizer: string; hashes?: ReadonlyMap<string, string> },
): EmbeddingGemmaPin {
  const files = new Map(tree.filter((entry) => entry.type === 'file').map((entry) => [entry.path, entry]));
  const file = (path: string, name = path.split('/').pop()!): PinnedFileValue => {
    const entry = files.get(path);
    if (!entry) throw new Error(`${options.repository}@${options.commit} has no ${path}.`);
    const sha256 = entry.lfs?.oid ?? options.hashes?.get(path);
    if (!sha256 || !/^[0-9a-f]{64}$/.test(sha256)) throw new Error(`No SHA-256 for ${path}; it is not an LFS file and was not hashed.`);
    return { name, path, bytes: entry.lfs?.size ?? entry.size, sha256 };
  };
  const data = [...files.keys()].filter((path) => path.startsWith(`${options.model}_data`));
  if (data.length > 1) throw new Error(`${options.model} keeps its weights in ${data.length} files; the manifest pins one.`);
  return {
    modelId: `embeddinggemma-2-${variantOf(options.model)}-${options.commit.slice(0, 7)}`,
    repository: options.repository,
    revision: options.commit,
    model: file(options.model),
    ...(data[0] ? { modelData: file(data[0]) } : {}),
    vocabulary: file(options.tokenizer),
  };
}

export function renderPinBlock(pin: EmbeddingGemmaPin): string {
  const file = (value: PinnedFileValue) =>
    `{ name: '${value.name}', path: '${value.path}', bytes: ${value.bytes.toLocaleString('en-US').replaceAll(',', '_')}, sha256: '${value.sha256}' }`;
  return [
    BEGIN,
    'const EMBEDDINGGEMMA_2_PIN = {',
    `  modelId: '${pin.modelId}',`,
    `  repository: '${pin.repository}',`,
    `  revision: '${pin.revision}',`,
    `  model: ${file(pin.model)},`,
    `  modelData: ${pin.modelData ? file(pin.modelData) : 'undefined'} as { name: string; path: string; bytes: number; sha256: string } | undefined,`,
    `  vocabulary: ${file(pin.vocabulary)},`,
    '};',
    END,
  ].join('\n');
}

/** The manifest with its PINNED block replaced, and the id the old block carried. */
export function replacePinBlock(manifest: string, block: string): { text: string; previousModelId: string } {
  const start = manifest.indexOf(BEGIN);
  const end = manifest.indexOf(END);
  if (start < 0 || end < start) throw new Error('The manifest has no PINNED embeddinggemma-2 block.');
  const previous = /modelId: '([^']+)'/.exec(manifest.slice(start, end))?.[1];
  if (!previous) throw new Error('The PINNED block names no modelId.');
  return { text: manifest.slice(0, start) + block + manifest.slice(end + END.length), previousModelId: previous };
}

async function hub(path: string): Promise<Response> {
  const token = process.env.HF_TOKEN?.trim();
  const response = await fetch(path.startsWith('http') ? path : `${HUB}${path}`, {
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });
  if (!response.ok) throw new Error(`${path}: HTTP ${response.status}`);
  return response;
}

async function readTree(repo: string, commit: string): Promise<HubTreeEntry[]> {
  const entries: HubTreeEntry[] = [];
  let next: string | undefined = `/api/models/${repo}/tree/${commit}?recursive=true`;
  while (next) {
    const response = await hub(next);
    entries.push(...(await response.json() as HubTreeEntry[]));
    next = /<([^>]+)>;\s*rel="next"/.exec(response.headers.get('link') ?? '')?.[1];
  }
  return entries;
}

async function sha256Of(url: string): Promise<string> {
  const response = await hub(url);
  return createHash('sha256').update(new Uint8Array(await response.arrayBuffer())).digest('hex');
}

/** Installs download anonymously: a gated or private file would fail every install. */
async function assertAnonymous(url: string): Promise<void> {
  const response = await fetch(url, { method: 'HEAD', redirect: 'manual' });
  if (response.status >= 400) {
    throw new Error(`${url} needs a Hugging Face login (HTTP ${response.status}); installs cannot download it.`);
  }
}

function renameEverywhere(previous: string, next: string): string[] {
  if (previous === next) return [];
  const changed: string[] = [];
  const visit = (path: string) => {
    if (!/\.(json|md|ts)$/.test(path)) return;
    const text = readFileSync(path, 'utf8');
    if (!text.includes(previous)) return;
    writeFileSync(path, text.replaceAll(previous, next));
    changed.push(path.slice(ROOT.length + 1));
  };
  for (const target of RENAME_TARGETS) {
    const full = join(ROOT, target);
    let entries: string[];
    try {
      entries = readdirSync(full, { recursive: true }) as string[];
    } catch {
      visit(full);
      continue;
    }
    for (const entry of entries) visit(join(full, entry));
  }
  return changed;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const { sha: commit } = await (await hub(`/api/models/${args.repo}/revision/${encodeURIComponent(args.revision)}`)).json() as { sha: string };
  const tree = await readTree(args.repo, commit);
  if (args.list || !args.model) {
    console.log(`${args.repo}@${commit}`);
    for (const entry of tree.filter((item) => item.type === 'file')) {
      console.log(`${String(entry.lfs?.size ?? entry.size).padStart(14)}  ${entry.path}`);
    }
    if (!args.model) console.log('\nPick the text encoder with --model <path>.');
    return;
  }
  const hashes = new Map<string, string>();
  for (const path of [args.tokenizer]) {
    const entry = tree.find((item) => item.path === path);
    if (entry && !entry.lfs) hashes.set(path, await sha256Of(`${HUB}/${args.repo}/resolve/${commit}/${path}`));
  }
  const pin = pinFromTree(tree, { repository: args.repo, commit, model: args.model, tokenizer: args.tokenizer, hashes });
  for (const file of [pin.model, ...(pin.modelData ? [pin.modelData] : []), pin.vocabulary]) {
    await assertAnonymous(`${HUB}/${pin.repository}/resolve/${pin.revision}/${file.path}`);
  }
  const block = renderPinBlock(pin);
  console.log(block);
  if (pin.vocabulary.sha256 !== GEMMA4_TOKENIZER_SHA256) {
    console.warn(
      '\nThe tokenizer differs from the Gemma 4 tokenizer the parity fixture was generated from:'
      + ' regenerate test/fixtures/gemma-tokenizer-golden.json from this tokenizer.model before trusting the parity test.',
    );
  }
  if (!args.write) return;
  const { text, previousModelId } = replacePinBlock(readFileSync(MANIFEST, 'utf8'), block);
  writeFileSync(MANIFEST, text);
  const renamed = renameEverywhere(previousModelId, pin.modelId);
  console.log(`\nWrote the PINNED block; renamed ${previousModelId} → ${pin.modelId} in ${renamed.length} file(s):`);
  for (const path of renamed) console.log(`  ${path}`);
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
