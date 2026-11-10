// Whole-item calibration sample (issue #883): a probability sample of whole
// items from an install's own stores, frozen before anything is scored.
//
//   bun eval/calibration/sample-whole.ts --from-install [--out DIR] [--count 200]
//   bun eval/calibration/sample-whole.ts --install-home DIR [--out DIR] [--count 200]
//   bun eval/calibration/sample-whole.ts --stores DIR [--out DIR] [--count 200]
//     [--seed N] [--since YYYY-MM-DD] [--private-share 0.3] [--min-per-cell 3]
//     [--min-text-chars 15] [--criteria FILE] [--keep-stores] [--force]
//
// --from-install copies this machine's stores (found exactly as the running
// Olympus finds them, imported archives included) into <out>/stores with
// production's snapshot (no SQLite handle ever opens an install file), samples,
// and removes the copies unless --keep-stores. Run it on the machine that holds
// the stores (Sparta), then copy <out> to the machine you label on.
// --install-home DIR does the same for a COPY of another machine's home folder,
// read with Olympus's default layout under it. --stores reads copies already made.
//
// Population: every item in a tier ledger that is not moving, not in Secrets,
// still stored, top-level (attachments are shown with their parent), authored
// since --since, and either read with at least --min-text-chars of text or one
// whose extraction failed. Counts are taken AFTER these filters, per source and
// stratum, and the sample is a stratified simple random sample from exactly
// that population: no per-group caps, no rejection after the draw. So each
// item's inclusion probability is its cell's drawn / population, recorded on
// the item, and a score reweights exactly.
//
// Strata: source by judge-Private (the judge's own Private verdict in the
// ledger) or other. --private-share of the count comes from judge-Private, for
// recall; every cell gets at least --min-per-cell, the rest is proportional.
//
// Split: dev/test by related group (conversation, folder, an email's sender),
// never by item id, so related items never straddle the halves.
//
// Freezing: manifest.json records the sample's SHA-256 and the acceptance
// criteria, hashed together. The scorer refuses a sample or manifest that
// changed. Prints counts only, never text or names.

import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { CALIBRATION_DIR_DEFAULT, LABELS_FILE, SAMPLE_FILE, type CalibrationSample } from './files.ts';
import { rng, shuffle } from './sample-random.ts';
import { buildPopulation, buildWholeItems, installEnv, snapshotInstall } from './whole-item-stores.ts';
import { drawStratified, freezeManifest, MANIFEST_FILE, splitByGroup, type AcceptanceCriteria } from './whole-item.ts';

const argv = process.argv.slice(2);
const flag = (name: string) => {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
};

export const DEFAULT_CRITERIA_FILE = join(import.meta.dir, 'whole-item-criteria.json');
export const WHOLE_DIR_DEFAULT = join(CALIBRATION_DIR_DEFAULT, 'whole');

function twoYearsAgo(): string {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear() - 2, now.getUTCMonth(), now.getUTCDate())).toISOString().slice(0, 10);
}

function main(): void {
  const out = flag('--out') ?? WHOLE_DIR_DEFAULT;
  const installHome = flag('--install-home');
  const fromInstall = argv.includes('--from-install') || installHome !== undefined;
  const storesFlag = flag('--stores');
  if (fromInstall === (storesFlag !== undefined)) throw new Error('Pass --from-install, --install-home DIR, or --stores DIR of store copies (one of them).');
  const count = Number(flag('--count') ?? 200);
  const seed = Number(flag('--seed') ?? 20261110);
  const since = flag('--since') ?? twoYearsAgo();
  const privateShare = Number(flag('--private-share') ?? 0.3);
  const minPerCell = Number(flag('--min-per-cell') ?? 3);
  const minTextChars = Number(flag('--min-text-chars') ?? 15);
  if (!(count > 0) || !(privateShare >= 0 && privateShare <= 1) || !(minPerCell >= 0)) throw new Error('--count, --private-share or --min-per-cell is out of range.');
  const criteria = JSON.parse(readFileSync(flag('--criteria') ?? DEFAULT_CRITERIA_FILE, 'utf8')) as AcceptanceCriteria;

  const samplePath = join(out, SAMPLE_FILE);
  if (existsSync(samplePath) && !argv.includes('--force')) {
    throw new Error(`A sample already exists at ${samplePath}. Labels refer to it; pass --force to replace it.`);
  }
  if (existsSync(join(out, LABELS_FILE)) && argv.includes('--force')) {
    throw new Error(`Labels exist in ${out}. Move them away before drawing a new sample: they would no longer match it.`);
  }
  mkdirSync(out, { recursive: true, mode: 0o700 });
  chmodSync(out, 0o700);

  const stores = storesFlag ?? join(out, 'stores');
  let snapshot: ReturnType<typeof snapshotInstall> | undefined;
  try {
    if (fromInstall) {
      rmSync(stores, { recursive: true, force: true });
      snapshot = snapshotInstall(stores, installHome ? installEnv(resolve(installHome)) : process.env);
    }
    const population = buildPopulation(stores, { since, minTextChars });
    const { picked, cells } = drawStratified(population.units, count, privateShare, minPerCell, seed);
    const ids = picked.map((_, index) => `w${String(index + 1).padStart(3, '0')}`);
    const items = buildWholeItems(stores, picked, ids);
    const halves = splitByGroup(items.map((item) => ({ id: item.id, groups: item.whole!.groups })), seed);
    for (const item of items) item.split = halves.split.get(item.id)!;
    // The labeling order is random too, so the page never runs source by source.
    const ordered = shuffle([...items], rng(seed + 1));

    const recipe = {
      kind: 'whole-item',
      seed,
      since,
      count,
      privateShare,
      minPerCell,
      minTextChars,
      population: {
        definition: 'tier-ledger items, not moving, not Secrets, stored, top-level, authored since `since`, read with >= minTextChars of text or extraction failed',
        ledgerRows: population.ledgerRows,
        exclusions: population.exclusions,
        eligible: population.units.length,
      },
      cells,
      split: { by: 'conversation, folder or email sender', components: halves.components, largestComponent: halves.largestComponent },
    };
    const sample: CalibrationSample = {
      version: 1,
      createdAt: new Date().toISOString(),
      root: 'whole-item store copies',
      seed,
      candidates: population.units.length,
      items: ordered,
      recipe,
    };
    const bytes = JSON.stringify(sample, null, 1);
    writeFileSync(samplePath, bytes, { mode: 0o600 });
    chmodSync(samplePath, 0o600);
    const manifest = freezeManifest(bytes, items.length, criteria, sample.createdAt);
    const manifestPath = join(out, MANIFEST_FILE);
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 1), { mode: 0o600 });
    chmodSync(manifestPath, 0o600);

    const tally = (key: (item: (typeof items)[number]) => string) => {
      const counts: Record<string, number> = {};
      for (const item of items) counts[key(item)] = (counts[key(item)] ?? 0) + 1;
      return counts;
    };
    console.log(JSON.stringify({
      ...(snapshot ? { copied: snapshot } : {}),
      population: recipe.population,
      cells,
      sampled: items.length,
      bySplit: tally((item) => item.split!),
      withAttachments: items.filter((item) => item.whole!.children.length > 0).length,
      longerThanJudgeReads: items.filter((item) => !item.whole!.judgeReadsAll).length,
      extraction: tally((item) => item.whole!.extraction?.outcome ?? 'none'),
      injectionHeld: items.filter((item) => item.whole!.injection).length,
      frozen: { manifest: manifestPath, sampleSha256: manifest.sampleSha256, manifestSha256: manifest.manifestSha256 },
    }, null, 1));
  } finally {
    if (fromInstall && !argv.includes('--keep-stores')) rmSync(stores, { recursive: true, force: true });
  }
}

if (import.meta.main) main();
