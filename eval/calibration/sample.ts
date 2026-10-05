// Calibration sample (design docs/design/categorization-precision.md, step 1).
//
// A stand-alone, read-only tool. It walks a local folder tree (the owner's
// Dropbox by default), picks a stratified sample of real files, extracts their
// text with the same extractor Olympus uses, and writes the sample to an
// owner-only directory OUTSIDE the repository and outside Olympus's data. It
// never opens an Olympus store, ledger or engine, and never writes under the
// folder it reads.
//
//   bun eval/calibration/sample.ts [--root DIR] [--count 150] [--seed N] [--out DIR] [--force]
//
// Strata: every file belongs to its area (its first two path segments, e.g.
// "2 Areas/Health"). Files whose path or name looks like someone's own records
// (health, money, legal, identity, family...) are oversampled so the sample
// carries enough real private items to measure recall; the rest are spread
// across every area, at most a few per folder, so no one folder dominates.

import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, extname, join, relative } from 'node:path';
import { createTextExtractor } from '../../src/workers/file-extraction/extractors/text.ts';
import type { ExtractorInput } from '../../src/workers/file-extraction/types.ts';
import { CALIBRATION_DIR_DEFAULT, SAMPLE_FILE, type CalibrationSample, type CalibrationSampleItem } from './files.ts';

// Documents a person writes or receives. Machine files (JSON, XML) are left
// out: they are mostly app data and would crowd the sample.
const MIME_BY_EXTENSION: Readonly<Record<string, string>> = {
  '.pdf': 'application/pdf',
  '.txt': 'text/plain',
  '.md': 'text/markdown',
  '.markdown': 'text/markdown',
  '.csv': 'text/csv',
  '.tsv': 'text/tab-separated-values',
  '.html': 'text/html',
  '.htm': 'text/html',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
};

/** Words in a path or file name that suggest a person's own records. Only steers sampling. */
const RECORDS_HINT = /\b(health|medical|labs?|doctor|clinic|hospital|therapy|therapist|prescriptions?|insurance|reimbursement|tax(es)?|bank|statements?|invoices?|receipts?|payroll|salary|finances?|financial|mortgage|lease|legal|contracts?|lawyer|court|passport|visa|identity)\b/i;

const SKIP_DIRS = new Set(['.Trash', '.git', 'node_modules', '.dropbox.cache', 'Apps']);
const MAX_FILE_BYTES = 25 * 1024 * 1024;
const MIN_TEXT_CHARS = 150;
/** Text kept per item: enough for the classifier's excerpt and for labeling. */
const MAX_TEXT_CHARS = 60_000;
const PER_FOLDER_CAP = 3;
const PER_AREA_CAP = 8;
const RECORDS_SHARE = 0.5;

interface Candidate {
  path: string;
  rel: string;
  area: string;
  folder: string;
  mimeType: string;
  sizeBytes: number;
  modifiedAt: string;
  recordsHint: boolean;
}

function parseArgs(argv: readonly string[]) {
  const value = (flag: string) => {
    const index = argv.indexOf(flag);
    return index >= 0 ? argv[index + 1] : undefined;
  };
  return {
    root: value('--root') ?? join(homedir(), 'Library', 'CloudStorage', 'Dropbox'),
    count: Number(value('--count') ?? 150),
    seed: Number(value('--seed') ?? 20261004),
    out: value('--out') ?? CALIBRATION_DIR_DEFAULT,
    force: argv.includes('--force'),
  };
}

/** Deterministic PRNG (mulberry32), so a sample can be reproduced from its seed. */
function rng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

function shuffle<T>(items: T[], random: () => number): T[] {
  for (let i = items.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    [items[i], items[j]] = [items[j]!, items[i]!];
  }
  return items;
}

function walk(root: string): Candidate[] {
  const found: Candidate[] = [];
  const visit = (dir: string) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.') || SKIP_DIRS.has(entry.name)) continue;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        visit(path);
        continue;
      }
      if (!entry.isFile()) continue;
      const mimeType = MIME_BY_EXTENSION[extname(entry.name).toLowerCase()];
      if (!mimeType) continue;
      let stat;
      try {
        stat = statSync(path);
      } catch {
        continue;
      }
      // Online-only (dataless) files report no blocks: reading one would
      // download it. Only files already on this Mac are sampled.
      if (stat.size === 0 || stat.size > MAX_FILE_BYTES || stat.blocks === 0) continue;
      const rel = relative(root, path);
      const parts = rel.split('/');
      found.push({
        path,
        rel,
        area: parts.length > 2 ? parts.slice(0, 2).join('/') : parts[0]!,
        folder: dirname(rel),
        mimeType,
        sizeBytes: stat.size,
        modifiedAt: stat.mtime.toISOString(),
        recordsHint: RECORDS_HINT.test(rel.replace(/[_\-.]+/g, ' ')),
      });
    }
  };
  visit(root);
  return found;
}

/**
 * Per-area queues: each area's files in a random order that rotates through
 * its folders, at most PER_FOLDER_CAP per folder.
 */
function areaQueues(pool: Candidate[], random: () => number): Map<string, Candidate[]> {
  const byFolder = new Map<string, Map<string, Candidate[]>>();
  for (const candidate of shuffle([...pool], random)) {
    const folders = byFolder.get(candidate.area) ?? new Map<string, Candidate[]>();
    byFolder.set(candidate.area, folders);
    const list = folders.get(candidate.folder);
    if (list) list.push(candidate);
    else folders.set(candidate.folder, [candidate]);
  }
  const queues = new Map<string, Candidate[]>();
  for (const [area, folders] of byFolder) {
    const lists = shuffle([...folders.values()], random).map((list) => list.slice(0, PER_FOLDER_CAP));
    const queue: Candidate[] = [];
    for (let round = 0; round < PER_FOLDER_CAP; round += 1) {
      for (const list of lists) if (list[round]) queue.push(list[round]!);
    }
    queues.set(area, queue);
  }
  return queues;
}

/**
 * Each area's share of `total`, by a weight of its size, capped at
 * PER_AREA_CAP files per area across both pools (water-filling: what a capped area cannot take goes to the
 * rest). Big areas get several files without crowding out the others, and no
 * area with candidates is lost to the number of other areas.
 */
function areaQuotas(
  queues: Map<string, Candidate[]>,
  total: number,
  used: ReadonlyMap<string, number>,
  weigh: (size: number) => number,
): Map<string, number> {
  const quotas = new Map<string, number>();
  let open = [...queues.entries()]
    .map(([area, queue]) => ({ area, limit: Math.max(0, Math.min(PER_AREA_CAP - (used.get(area) ?? 0), queue.length)), weight: weigh(queue.length) }))
    .filter((entry) => entry.limit > 0);
  let left = total;
  while (left > 0 && open.length > 0) {
    const sum = open.reduce((acc, entry) => acc + entry.weight, 0);
    const capped = open.filter((entry) => (left * entry.weight) / sum >= entry.limit);
    if (capped.length === 0) {
      const exact = open.map((entry) => ({ ...entry, exact: (left * entry.weight) / sum }));
      for (const entry of exact) quotas.set(entry.area, Math.floor(entry.exact));
      let rest = left - exact.reduce((acc, entry) => acc + Math.floor(entry.exact), 0);
      for (const entry of exact.sort((a, b) => (b.exact % 1) - (a.exact % 1))) {
        if (rest <= 0) break;
        quotas.set(entry.area, quotas.get(entry.area)! + 1);
        rest -= 1;
      }
      break;
    }
    for (const entry of capped) {
      quotas.set(entry.area, entry.limit);
      left -= entry.limit;
    }
    open = open.filter((entry) => !capped.includes(entry));
  }
  return quotas;
}

async function extractText(candidate: Candidate): Promise<string | undefined> {
  const extractor = createTextExtractor({ maxBoundedTextChars: MAX_TEXT_CHARS });
  const bytes = new Uint8Array(readFileSync(candidate.path));
  const input = {
    ref: {
      corpusId: 'calibration',
      provider: 'calibration',
      accountScope: 'owner',
      approvedScopeKey: 'calibration',
      providerItemId: candidate.rel,
      localItemId: candidate.rel,
      mimeType: candidate.mimeType,
      name: basename(candidate.path),
    },
    job: { jobId: 'calibration', extractorKind: extractor.kind, extractorVersion: extractor.version, policyDecision: 'index_allowed', attempts: 1 },
    bytes,
    mimeType: candidate.mimeType,
    sizeBytes: candidate.sizeBytes,
  } as unknown as ExtractorInput;
  try {
    const output = await extractor.extract(input);
    if (output.status !== 'indexed') return undefined;
    const text = output.text.trim();
    return text.length >= MIN_TEXT_CHARS ? text.slice(0, MAX_TEXT_CHARS) : undefined;
  } catch {
    return undefined;
  }
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const outPath = join(options.out, SAMPLE_FILE);
  if (existsSync(outPath) && !options.force) {
    console.error(`A sample already exists at ${outPath}. Labels refer to it; pass --force to replace it.`);
    process.exit(1);
  }
  if (!existsSync(options.root)) {
    console.error(`No folder at ${options.root}.`);
    process.exit(1);
  }
  const random = rng(options.seed);
  const all = walk(options.root);
  const wantRecords = Math.round(options.count * RECORDS_SHARE);

  const items: CalibrationSampleItem[] = [];
  let tried = 0;
  let noText = 0;
  const tryOne = async (candidate: Candidate): Promise<boolean> => {
    tried += 1;
    const text = await extractText(candidate);
    if (tried % 25 === 0) process.stdout.write(`  read ${tried} files, kept ${items.length}\n`);
    if (!text) {
      noText += 1;
      return false;
    }
    items.push({
      id: `c${String(items.length + 1).padStart(3, '0')}`,
      path: candidate.path,
      rel: candidate.rel,
      name: basename(candidate.path),
      area: candidate.area,
      mimeType: candidate.mimeType,
      sizeBytes: candidate.sizeBytes,
      modifiedAt: candidate.modifiedAt,
      recordsHint: candidate.recordsHint,
      text,
    });
    return true;
  };
  /** Fill each area's quota from its own queue; return the queues' leftovers. */
  const fill = async (pool: Candidate[], total: number, weigh: (size: number) => number): Promise<Candidate[]> => {
    const queues = areaQueues(pool, random);
    const used = new Map<string, number>();
    for (const item of items) used.set(item.area, (used.get(item.area) ?? 0) + 1);
    const quotas = areaQuotas(queues, total, used, weigh);
    for (const [area, queue] of queues) {
      let taken = 0;
      while (taken < (quotas.get(area) ?? 0) && queue.length > 0) {
        if (await tryOne(queue.shift()!)) taken += 1;
      }
    }
    return shuffle([...queues.values()].flat(), random);
  };
  // Records-like files go where they are densest (weight by count), so a
  // records folder such as Health is never thinned out by many small areas;
  // everything else is spread for breadth (weight by square root).
  const recordsLeft = await fill(all.filter((candidate) => candidate.recordsHint), wantRecords, (size) => size);
  const othersLeft = await fill(all.filter((candidate) => !candidate.recordsHint), options.count - items.length, Math.sqrt);
  // An area without enough readable files leaves a gap: fill it from what is left.
  for (const candidate of [...othersLeft, ...recordsLeft]) {
    if (items.length >= options.count) break;
    await tryOne(candidate);
  }

  const sample: CalibrationSample = {
    version: 1,
    createdAt: new Date().toISOString(),
    root: options.root,
    seed: options.seed,
    candidates: all.length,
    items: shuffle(items, random),
  };
  mkdirSync(options.out, { recursive: true, mode: 0o700 });
  chmodSync(options.out, 0o700);
  writeFileSync(outPath, JSON.stringify(sample, null, 1), { mode: 0o600 });
  chmodSync(outPath, 0o600);

  const areas = new Map<string, number>();
  for (const item of items) areas.set(item.area, (areas.get(item.area) ?? 0) + 1);
  console.log(`Sampled ${items.length} files from ${all.length} candidates (${tried} read, ${noText} had no usable text).`);
  console.log(`Records-like by path or name: ${items.filter((item) => item.recordsHint).length}.`);
  console.log(`Areas: ${[...areas.entries()].sort((a, b) => b[1] - a[1]).map(([area, n]) => `${area} ${n}`).join(', ')}`);
  console.log(`Written to ${outPath} (owner-only). Next: bun eval/calibration/label.ts`);
}

await main();
