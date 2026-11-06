// A labeling set from a finished replay: items where two models disagreed, plus
// some they agreed on, so the owner can say which model was right. Read-only on
// the store copies. Writes one sample file to an owner-only directory outside
// the repository, and prints counts only.
//
//   bun eval/calibration/sample-replay.ts --stores DIR --replay replay.jsonl --out DIR
//     [--seed N] [--lowered 40] [--raised 10] [--agreed 10]
//
// A stratum says which way the models went and is never shown when labeling.

import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { SAMPLE_FILE, type CalibrationSample, type CalibrationSampleItem } from './files.ts';
import { rng, shuffle } from './sample-random.ts';
import { loadSource, SOURCES, type Result } from './sniffer-replay.ts';

const argv = process.argv.slice(2);
const flag = (name: string) => {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
};
const required = (name: string) => {
  const value = flag(name);
  if (!value) throw new Error(`${name} is required.`);
  return value;
};

export const STRATA = {
  lowered: (row: Result) => row.storedBucket === 'private' && row.newTier === 'personal',
  raised: (row: Result) => row.storedBucket === 'personal' && row.newTier === 'private',
  agreed: (row: Result) => row.storedBucket === 'personal' && row.newTier === 'personal',
} as const;

/** Rows for each stratum, in a seeded order, one per input. */
export function pick(rows: readonly Result[], quotas: Record<keyof typeof STRATA, number>, seed: number) {
  const random = rng(seed);
  const unique = [...new Map(rows.map(row => [row.materialHash, row])).values()].sort((a, b) => a.materialHash.localeCompare(b.materialHash));
  return (Object.keys(STRATA) as Array<keyof typeof STRATA>).flatMap(stratum =>
    shuffle(unique.filter(STRATA[stratum]), random).slice(0, quotas[stratum]).map(row => ({ stratum, row })));
}

function main(): void {
  const seed = Number(flag('--seed') ?? 20261105);
  const out = required('--out');
  const stores = required('--stores');
  const rows = readFileSync(required('--replay'), 'utf8').split('\n').filter(Boolean)
    .map(line => JSON.parse(line) as Result).filter(row => row.type === 'result');
  const quotas = { lowered: Number(flag('--lowered') ?? 40), raised: Number(flag('--raised') ?? 10), agreed: Number(flag('--agreed') ?? 10) };
  const picked = pick(rows, quotas, seed);
  const materials = new Map<string, string>();
  for (const source of SOURCES.filter(name => picked.some(entry => entry.row.source === name))) {
    for (const [hash, found] of loadSource(stores, source).materials) materials.set(hash, found.material);
  }
  const items = shuffle(picked, rng(seed + 1)).map(({ stratum, row }, index): CalibrationSampleItem => {
    const material = materials.get(row.materialHash);
    if (material === undefined) throw new Error('A picked input is missing from the store copies.');
    const id = `r${String(index + 1).padStart(3, '0')}`;
    return { id, path: '', rel: `${row.source}/${id}`, name: id, area: row.source, mimeType: 'text/plain', sizeBytes: material.length,
      modifiedAt: '', recordsHint: false, text: material, source: row.source, stratum, judgeSees: material, judgeSeesExact: false };
  });
  const sample: CalibrationSample = { version: 1, createdAt: new Date().toISOString(), root: 'replay', seed, candidates: rows.length, items, recipe: { quotas } };
  mkdirSync(out, { recursive: true, mode: 0o700 });
  const path = join(out, SAMPLE_FILE);
  writeFileSync(path, JSON.stringify(sample), { mode: 0o600 });
  chmodSync(path, 0o600);
  console.log(JSON.stringify({ items: items.length, byStratum: Object.fromEntries(Object.keys(quotas).map(name => [name, items.filter(item => item.stratum === name).length])) }));
}

if (import.meta.main) main();
