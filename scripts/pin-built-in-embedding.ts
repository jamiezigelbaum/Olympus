// Pins the built-in EmbeddingGemma 2 model: resolves Hugging Face revisions
// to commits, reads each file's size and SHA-256 from the Hub's tree API
// (hashing the small non-LFS files itself), and prints — or with --write,
// writes — the PINNED block of
// src/workers/source-index/built-in-embedding/manifest.ts.
//
//   bun scripts/pin-built-in-embedding.ts --list
//   bun scripts/pin-built-in-embedding.ts --model onnx/model_quantized.onnx
//   bun scripts/pin-built-in-embedding.ts --model onnx/model_quantized.onnx --write
//
// The ONNX conversion ships only the Hugging Face `tokenizer.json`, so the
// SentencePiece `tokenizer.model` is pinned from Google's own repository
// (--tokenizer-repo, default google/embeddinggemma-2) at its own commit.
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
/** The parity fixture: reference-library encodings of one tokenizer.model, named by its SHA-256. */
const TOKENIZER_GOLDEN = join(ROOT, 'test/fixtures/gemma-tokenizer-golden.json');
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
  /** Where the tokenizer is pinned from, when that is not the model's repository. */
  tokenizerRepository: string;
  tokenizerRevision: string;
  vocabulary: PinnedFileValue;
}

interface Args {
  repo: string;
  revision: string;
  model?: string;
  tokenizer: string;
  tokenizerRepo: string;
  tokenizerRevision: string;
  list: boolean;
  write: boolean;
}

function parseArgs(argv: readonly string[]): Args {
  const args: Args = {
    repo: 'onnx-community/embeddinggemma-2-ONNX',
    revision: 'main',
    tokenizer: 'tokenizer.model',
    tokenizerRepo: 'google/embeddinggemma-2',
    tokenizerRevision: 'main',
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
    else if (flag === '--tokenizer-repo') args.tokenizerRepo = value();
    else if (flag === '--tokenizer-revision') args.tokenizerRevision = value();
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

function fileIn(
  tree: readonly HubTreeEntry[],
  where: { repository: string; commit: string; hashes?: ReadonlyMap<string, string> | undefined },
): (path: string) => PinnedFileValue {
  const files = new Map(tree.filter((entry) => entry.type === 'file').map((entry) => [entry.path, entry]));
  return (path) => {
    const entry = files.get(path);
    if (!entry) throw new Error(`${where.repository}@${where.commit} has no ${path}.`);
    const sha256 = entry.lfs?.oid ?? where.hashes?.get(path);
    if (!sha256 || !/^[0-9a-f]{64}$/.test(sha256)) throw new Error(`No SHA-256 for ${path}; it is not an LFS file and was not hashed.`);
    return { name: path.split('/').pop()!, path, bytes: entry.lfs?.size ?? entry.size, sha256 };
  };
}

/**
 * The pin for one model file, its external data (if any) and the tokenizer.
 * The tokenizer comes from `tokenizerTree` (another repository's commit) when
 * given, and from the model's own tree otherwise.
 */
export function pinFromTree(
  tree: readonly HubTreeEntry[],
  options: {
    repository: string;
    commit: string;
    model: string;
    tokenizer: string;
    hashes?: ReadonlyMap<string, string>;
    tokenizerTree?: { tree: readonly HubTreeEntry[]; repository: string; commit: string; hashes?: ReadonlyMap<string, string> };
  },
): EmbeddingGemmaPin {
  const file = fileIn(tree, options);
  const tokenizerSource = options.tokenizerTree ?? { tree, repository: options.repository, commit: options.commit, hashes: options.hashes };
  const data = tree.filter((entry) => entry.type === 'file' && entry.path.startsWith(`${options.model}_data`)).map((entry) => entry.path);
  if (data.length > 1) throw new Error(`${options.model} keeps its weights in ${data.length} files; the manifest pins one.`);
  return {
    modelId: `embeddinggemma-2-${variantOf(options.model)}-${options.commit.slice(0, 7)}`,
    repository: options.repository,
    revision: options.commit,
    model: file(options.model),
    ...(data[0] ? { modelData: file(data[0]) } : {}),
    tokenizerRepository: tokenizerSource.repository,
    tokenizerRevision: tokenizerSource.commit,
    vocabulary: fileIn(tokenizerSource.tree, tokenizerSource)(options.tokenizer),
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
    `  tokenizerRepository: '${pin.tokenizerRepository}',`,
    `  tokenizerRevision: '${pin.tokenizerRevision}',`,
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

async function resolveCommit(repo: string, revision: string): Promise<string> {
  const { sha } = await (await hub(`/api/models/${repo}/revision/${encodeURIComponent(revision)}`)).json() as { sha: string };
  return sha;
}

/** SHA-256s of the named files that are not LFS (the Hub lists only a git oid for those). */
async function hashSmallFiles(repo: string, commit: string, tree: readonly HubTreeEntry[], paths: readonly string[]): Promise<Map<string, string>> {
  const hashes = new Map<string, string>();
  for (const path of paths) {
    const entry = tree.find((item) => item.path === path);
    if (entry && !entry.lfs) hashes.set(path, await sha256Of(`${HUB}/${repo}/resolve/${commit}/${path}`));
  }
  return hashes;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const commit = await resolveCommit(args.repo, args.revision);
  const tree = await readTree(args.repo, commit);
  if (args.list || !args.model) {
    console.log(`${args.repo}@${commit}`);
    for (const entry of tree.filter((item) => item.type === 'file')) {
      console.log(`${String(entry.lfs?.size ?? entry.size).padStart(14)}  ${entry.path}`);
    }
    if (!args.model) console.log('\nPick the text encoder with --model <path>.');
    return;
  }
  const tokenizerCommit = args.tokenizerRepo === args.repo ? commit : await resolveCommit(args.tokenizerRepo, args.tokenizerRevision);
  const tokenizerTree = args.tokenizerRepo === args.repo ? tree : await readTree(args.tokenizerRepo, tokenizerCommit);
  const pin = pinFromTree(tree, {
    repository: args.repo,
    commit,
    model: args.model,
    tokenizer: args.tokenizer,
    tokenizerTree: {
      tree: tokenizerTree,
      repository: args.tokenizerRepo,
      commit: tokenizerCommit,
      hashes: await hashSmallFiles(args.tokenizerRepo, tokenizerCommit, tokenizerTree, [args.tokenizer]),
    },
  });
  for (const file of [pin.model, ...(pin.modelData ? [pin.modelData] : [])]) {
    await assertAnonymous(`${HUB}/${pin.repository}/resolve/${pin.revision}/${file.path}`);
  }
  await assertAnonymous(`${HUB}/${pin.tokenizerRepository}/resolve/${pin.tokenizerRevision}/${pin.vocabulary.path}`);
  const block = renderPinBlock(pin);
  console.log(block);
  const golden = (JSON.parse(readFileSync(TOKENIZER_GOLDEN, 'utf8')) as { sha256: string }).sha256;
  if (pin.vocabulary.sha256 !== golden) {
    console.warn(
      '\nThe tokenizer differs from the one the parity fixture was generated from:'
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
