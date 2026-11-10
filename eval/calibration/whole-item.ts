// Whole-item calibration: the pure parts. A probability sample drawn from a
// defined eligible population, a dev/test split by related group, a frozen
// manifest, and a scorer that reports counts and rates only (issues #883, #864).
//
// Nothing here reads a store or prints item text. The store side is in
// whole-item-stores.ts; the commands are sample-whole.ts and score-whole.ts.

import { createHash } from 'node:crypto';
import { rng, shuffle } from './sample-random.ts';

// ---------------------------------------------------------------------------
// Population and sample design

/** A stratum: items the judge called Private, and everything else. */
export type WholeStratum = 'judge_private' | 'other';

/** One eligible item of the population. Carries no text. */
export interface PopulationUnit {
  /** Unique, stable identity of the item. */
  key: string;
  /** The source (store folder) it came from: the first stratification axis. */
  area: string;
  stratum: WholeStratum;
}

/** A cell of the design: one source and stratum, its population and its draw. */
export interface DesignCell {
  area: string;
  stratum: WholeStratum;
  population: number;
  drawn: number;
  /** drawn / population: every unit of the cell had this chance of being picked. */
  inclusionProbability: number;
}

export const cellKey = (area: string, stratum: string) => `${area}\u0000${stratum}`;

/**
 * How many to draw from each cell. `privateShare` of the total goes to the
 * judge-Private cells (all sources together), the rest to the others; within
 * each, every cell gets at least `minPerCell` (or all of it, if smaller) and
 * the remainder follows population size, by largest remainder. A shortfall in
 * one stratum is made up from the other.
 */
export function allocate(
  populations: ReadonlyMap<string, { area: string; stratum: WholeStratum; population: number }>,
  total: number,
  privateShare: number,
  minPerCell: number,
): Map<string, number> {
  const cells = [...populations.entries()].sort(([a], [b]) => a.localeCompare(b));
  const of = (stratum: WholeStratum) => cells.filter(([, cell]) => cell.stratum === stratum && cell.population > 0);
  const size = (stratum: WholeStratum) => of(stratum).reduce((sum, [, cell]) => sum + cell.population, 0);
  let privateTarget = Math.min(Math.round(total * privateShare), size('judge_private'));
  let otherTarget = Math.min(total - privateTarget, size('other'));
  // Whatever one stratum cannot supply, the other does.
  privateTarget = Math.min(size('judge_private'), total - otherTarget);
  otherTarget = Math.min(size('other'), total - privateTarget);

  const out = new Map<string, number>(cells.map(([key]) => [key, 0]));
  const fill = (stratum: WholeStratum, target: number) => {
    const members = of(stratum);
    for (const [key, cell] of members) out.set(key, Math.min(minPerCell, cell.population));
    let left = target - members.reduce((sum, [key]) => sum + out.get(key)!, 0);
    // Minimums can overshoot a small target: take back from the largest cells first.
    while (left < 0) {
      const [key] = [...members].sort(([ka, a], [kb, b]) => (out.get(kb)! - out.get(ka)!) || b.population - a.population)[0]!;
      out.set(key, out.get(key)! - 1);
      left += 1;
    }
    while (left > 0) {
      const open = members.filter(([key, cell]) => out.get(key)! < cell.population);
      if (open.length === 0) break;
      const weight = open.reduce((sum, [, cell]) => sum + cell.population, 0);
      const shares = open.map(([key, cell]) => ({ key, cell, exact: (left * cell.population) / weight }));
      let given = 0;
      for (const share of shares) {
        const add = Math.min(Math.floor(share.exact), share.cell.population - out.get(share.key)!);
        out.set(share.key, out.get(share.key)! + add);
        given += add;
      }
      if (given === 0) {
        // Largest remainder, one at a time, ties to the bigger cell then the key.
        const next = shares
          .filter((share) => out.get(share.key)! < share.cell.population)
          .sort((a, b) => (b.exact - Math.floor(b.exact)) - (a.exact - Math.floor(a.exact)) || b.cell.population - a.cell.population || a.key.localeCompare(b.key))[0];
        if (!next) break;
        out.set(next.key, out.get(next.key)! + 1);
        given = 1;
      }
      left -= given;
    }
  };
  fill('judge_private', privateTarget);
  fill('other', otherTarget);
  return out;
}

/**
 * A stratified simple random sample without replacement: within each cell,
 * `drawn` units in a seeded random order. No caps, no rejection after the draw,
 * so each unit's inclusion probability is exactly drawn / population.
 */
export function drawStratified<T extends PopulationUnit>(
  units: readonly T[],
  total: number,
  privateShare: number,
  minPerCell: number,
  seed: number,
): { picked: Array<T & { inclusionProbability: number }>; cells: DesignCell[] } {
  const byCell = new Map<string, T[]>();
  for (const unit of units) {
    const key = cellKey(unit.area, unit.stratum);
    const cell = byCell.get(key);
    if (cell) cell.push(unit);
    else byCell.set(key, [unit]);
  }
  const populations = new Map([...byCell.entries()].map(([key, members]) => [key, { area: members[0]!.area, stratum: members[0]!.stratum, population: members.length }]));
  const allocation = allocate(populations, total, privateShare, minPerCell);
  const random = rng(seed);
  const picked: Array<T & { inclusionProbability: number }> = [];
  const cells: DesignCell[] = [];
  for (const [key, members] of [...byCell.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const drawn = allocation.get(key) ?? 0;
    const ordered = shuffle([...members].sort((a, b) => a.key.localeCompare(b.key)), random);
    const inclusionProbability = members.length === 0 ? 0 : drawn / members.length;
    for (const unit of ordered.slice(0, drawn)) picked.push({ ...unit, inclusionProbability });
    cells.push({ area: members[0]!.area, stratum: members[0]!.stratum, population: members.length, drawn, inclusionProbability });
  }
  return { picked, cells };
}

/**
 * Dev/test by related group, never by item id: items that share any group key
 * (a conversation, a folder, an email sender standing in for a template) are
 * joined, and each joined set lands wholly in one half, chosen by a seeded hash.
 */
export function splitByGroup(items: ReadonlyArray<{ id: string; groups: readonly string[] }>, seed: number): {
  split: Map<string, 'dev' | 'test'>;
  components: number;
  largestComponent: number;
} {
  const parent = new Map<string, string>();
  const find = (key: string): string => {
    let root = key;
    while (parent.get(root) !== root) root = parent.get(root)!;
    let walk = key;
    while (parent.get(walk) !== root) { const next = parent.get(walk)!; parent.set(walk, root); walk = next; }
    return root;
  };
  const union = (a: string, b: string) => {
    const [ra, rb] = [find(a), find(b)];
    if (ra !== rb) parent.set(ra < rb ? rb : ra, ra < rb ? ra : rb);
  };
  for (const item of items) {
    const own = `item:${item.id}`;
    parent.set(own, own);
    for (const group of item.groups) if (!parent.has(group)) parent.set(group, group);
  }
  for (const item of items) for (const group of item.groups) union(`item:${item.id}`, group);
  const size = new Map<string, number>();
  for (const item of items) size.set(find(`item:${item.id}`), (size.get(find(`item:${item.id}`)) ?? 0) + 1);
  const split = new Map<string, 'dev' | 'test'>();
  for (const item of items) {
    const root = find(`item:${item.id}`);
    split.set(item.id, createHash('sha256').update(`${seed}\u0000${root}`).digest()[0]! % 2 === 0 ? 'dev' : 'test');
  }
  return { split, components: size.size, largestComponent: Math.max(0, ...size.values()) };
}

// ---------------------------------------------------------------------------
// Freezing

/** JSON with sorted keys, so a hash does not depend on key order. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value as object).sort()
      .filter((key) => (value as Record<string, unknown>)[key] !== undefined)
      .map((key) => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export const sha256 = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');

/** What counts as passing, fixed before anything is scored. */
export interface AcceptanceCriteria {
  /** The half the verdict is read on. */
  split: 'dev' | 'test' | 'all';
  /** Weighted: of what the judge called Private, the share the owner calls Private or Secret. */
  privatePrecisionMin: number;
  /** Weighted: of what the owner calls Private or Secret, the share the judge called Private. */
  privateRecallMin: number;
  /** Owner-Important Private (and Secret) items the judge let through, at most. */
  importantMissesMax: number;
  /** The confidence level of every interval reported. */
  confidence: number;
}

export const MANIFEST_FILE = 'manifest.json';

export interface WholeManifest {
  version: 1;
  kind: 'whole-item';
  frozenAt: string;
  sampleFile: string;
  sampleSha256: string;
  items: number;
  criteria: AcceptanceCriteria;
  /** Hash of everything above, in canonical JSON: changing a field breaks it. */
  manifestSha256: string;
}

export function freezeManifest(sampleBytes: string | Uint8Array, items: number, criteria: AcceptanceCriteria, frozenAt: string, sampleFile = 'sample.json'): WholeManifest {
  const body = { version: 1 as const, kind: 'whole-item' as const, frozenAt, sampleFile, sampleSha256: sha256(sampleBytes), items, criteria };
  return { ...body, manifestSha256: sha256(canonicalJson(body)) };
}

/** Refuses a manifest that was edited, or a sample that changed after freezing. */
export function verifyManifest(manifest: WholeManifest, sampleBytes: string | Uint8Array): void {
  const { manifestSha256, ...body } = manifest;
  if (sha256(canonicalJson(body)) !== manifestSha256) throw new Error('The manifest was changed after it was frozen; its hash no longer matches.');
  if (sha256(sampleBytes) !== manifest.sampleSha256) throw new Error('The sample changed after it was frozen; its hash no longer matches the manifest.');
}

// ---------------------------------------------------------------------------
// Scoring: counts and rates, never text

export type OwnerClass = 'personal' | 'private_important' | 'private_minor' | 'private_untagged' | 'secret';
export const OWNER_CLASSES: readonly OwnerClass[] = ['personal', 'private_important', 'private_minor', 'private_untagged', 'secret'];
export type Verdict = 'personal' | 'private';

/** The owner's label as a scoring class; undefined for Not sure, Skip or no label. */
export function ownerClass(entry: { label: string; importance?: string } | undefined): OwnerClass | undefined {
  if (!entry) return undefined;
  if (entry.label === 'personal') return 'personal';
  if (entry.label === 'secret') return 'secret';
  if (entry.label !== 'private') return undefined;
  return entry.importance === 'important' ? 'private_important' : entry.importance === 'minor' ? 'private_minor' : 'private_untagged';
}

/** The side that must not be Personal: every Private and Secret label. */
export const ownerPrivateSide = (owner: OwnerClass) => owner !== 'personal';

export interface JudgedRow {
  id: string;
  area: string;
  stratum: string;
  split: 'dev' | 'test';
  owner: OwnerClass;
  judge: Verdict;
  /** The injection screen settled the item: counted apart, never in the matrix. */
  injection: boolean;
  /** How many population items this row stands for. */
  weight: number;
}

/**
 * Design weights adjusted for unlabeled items within each cell: a cell's
 * population divided by the rows labeled from it. Every row of the cell then
 * stands for the same share, and the weights sum to the cells' population.
 */
export function cellWeights(rows: ReadonlyArray<{ id: string; area: string; stratum: string }>, populations: ReadonlyMap<string, number>): Map<string, number> {
  const labeled = new Map<string, number>();
  for (const row of rows) labeled.set(cellKey(row.area, row.stratum), (labeled.get(cellKey(row.area, row.stratum)) ?? 0) + 1);
  const out = new Map<string, number>();
  for (const row of rows) {
    const population = populations.get(cellKey(row.area, row.stratum));
    if (population === undefined) throw new Error('A labeled item has no population count for its cell.');
    out.set(row.id, population / labeled.get(cellKey(row.area, row.stratum))!);
  }
  return out;
}

/** Kish's effective sample size: (Σw)² / Σw². */
export function effectiveSampleSize(weights: readonly number[]): number {
  const sum = weights.reduce((a, b) => a + b, 0);
  const squares = weights.reduce((a, b) => a + b * b, 0);
  return squares === 0 ? 0 : (sum * sum) / squares;
}

const Z: Readonly<Record<string, number>> = { '0.9': 1.6448536269514722, '0.95': 1.959963984540054, '0.99': 2.5758293035489004 };
export const zFor = (confidence: number) => {
  const z = Z[String(confidence)];
  if (z === undefined) throw new Error('confidence is 0.9, 0.95 or 0.99.');
  return z;
};

/** Wilson score interval for a proportion seen over n (an effective n for weighted data). */
export function wilson(p: number, n: number, confidence = 0.95): { low: number; high: number } | null {
  if (!(n > 0)) return null;
  const z = zFor(confidence);
  const z2 = z * z;
  const center = (p + z2 / (2 * n)) / (1 + z2 / n);
  const half = (z / (1 + z2 / n)) * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n));
  return { low: Math.max(0, center - half), high: Math.min(1, center + half) };
}

export interface Rate {
  /** Rows in the denominator. */
  items: number;
  /** Rows in the numerator. */
  count: number;
  rate: number | null;
  weightedRate: number | null;
  /** Kish's effective sample size of the denominator. */
  effectiveItems: number;
  /** Wilson interval of the weighted rate at the effective sample size. */
  interval: { low: number; high: number } | null;
}

export function rate(rows: readonly JudgedRow[], inDenominator: (row: JudgedRow) => boolean, inNumerator: (row: JudgedRow) => boolean, confidence: number): Rate {
  const denominator = rows.filter(inDenominator);
  const numerator = denominator.filter(inNumerator);
  const weight = (members: readonly JudgedRow[]) => members.reduce((sum, row) => sum + row.weight, 0);
  const weightedRate = denominator.length === 0 ? null : weight(numerator) / weight(denominator);
  const effectiveItems = effectiveSampleSize(denominator.map((row) => row.weight));
  return {
    items: denominator.length,
    count: numerator.length,
    rate: denominator.length === 0 ? null : numerator.length / denominator.length,
    weightedRate,
    effectiveItems,
    interval: weightedRate === null ? null : wilson(weightedRate, effectiveItems, confidence),
  };
}

/** Owner class by verdict: the whole matrix, both directions. */
export type Matrix = Record<OwnerClass, Record<Verdict, number>>;

function matrix(rows: readonly JudgedRow[], weighted: boolean): Matrix {
  const out = Object.fromEntries(OWNER_CLASSES.map((owner) => [owner, { personal: 0, private: 0 }])) as Matrix;
  for (const row of rows) out[row.owner][row.judge] += weighted ? row.weight : 1;
  return out;
}

export interface JudgeScore {
  items: number;
  /** Items the injection screen held: never in the matrix or the rates. */
  injections: { items: number; ownerPersonal: number; ownerPrivateOrSecret: number };
  matrix: Matrix;
  weightedMatrix: Matrix;
  /** Owner Private or Secret, judge Personal: the harmful miss. */
  privateToPersonal: Rate;
  /** Owner Personal, judge Private: the outage. */
  personalToPrivate: Rate;
  privateRecall: Rate;
  privatePrecision: Rate;
  importantMisses: number;
  balancedAccuracy: number | null;
  weightedBalancedAccuracy: number | null;
}

export function scoreRows(all: readonly JudgedRow[], confidence = 0.95): JudgeScore {
  const injected = all.filter((row) => row.injection);
  const rows = all.filter((row) => !row.injection);
  const privateSide = (row: JudgedRow) => ownerPrivateSide(row.owner);
  const privateToPersonal = rate(rows, privateSide, (row) => row.judge === 'personal', confidence);
  const personalToPrivate = rate(rows, (row) => !privateSide(row), (row) => row.judge === 'private', confidence);
  const privateRecall = rate(rows, privateSide, (row) => row.judge === 'private', confidence);
  const privatePrecision = rate(rows, (row) => row.judge === 'private', privateSide, confidence);
  const balanced = (a: number | null, b: number | null) => (a === null || b === null ? null : (2 - a - b) / 2);
  return {
    items: rows.length,
    injections: {
      items: injected.length,
      ownerPersonal: injected.filter((row) => !privateSide(row)).length,
      ownerPrivateOrSecret: injected.filter(privateSide).length,
    },
    matrix: matrix(rows, false),
    weightedMatrix: matrix(rows, true),
    privateToPersonal,
    personalToPrivate,
    privateRecall,
    privatePrecision,
    importantMisses: rows.filter((row) => (row.owner === 'private_important' || row.owner === 'secret') && row.judge === 'personal').length,
    balancedAccuracy: balanced(privateToPersonal.rate, personalToPrivate.rate),
    weightedBalancedAccuracy: balanced(privateToPersonal.weightedRate, personalToPrivate.weightedRate),
  };
}

export function groupedScores(rows: readonly JudgedRow[], key: (row: JudgedRow) => string, confidence = 0.95): Record<string, JudgeScore> {
  const groups = new Map<string, JudgedRow[]>();
  for (const row of rows) groups.set(key(row), [...(groups.get(key(row)) ?? []), row]);
  return Object.fromEntries([...groups.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([name, members]) => [name, scoreRows(members, confidence)]));
}

export interface CriteriaResult {
  split: string;
  passes: boolean;
  /** Passes on the interval's pessimistic end too. */
  passesWithConfidence: boolean;
  checks: Record<string, { value: number | null; bound: number | null; min?: number; max?: number; passes: boolean; passesWithConfidence: boolean }>;
}

export function judgeAgainst(score: JudgeScore, criteria: AcceptanceCriteria): CriteriaResult {
  const min = (value: Rate, floor: number) => ({
    value: value.weightedRate,
    bound: value.interval?.low ?? null,
    min: floor,
    passes: value.weightedRate !== null && value.weightedRate >= floor,
    passesWithConfidence: value.interval !== null && value.interval.low >= floor,
  });
  const checks = {
    privatePrecision: min(score.privatePrecision, criteria.privatePrecisionMin),
    privateRecall: min(score.privateRecall, criteria.privateRecallMin),
    importantMisses: {
      value: score.importantMisses,
      bound: score.importantMisses,
      max: criteria.importantMissesMax,
      passes: score.importantMisses <= criteria.importantMissesMax,
      passesWithConfidence: score.importantMisses <= criteria.importantMissesMax,
    },
  };
  return {
    split: criteria.split,
    passes: Object.values(checks).every((check) => check.passes),
    passesWithConfidence: Object.values(checks).every((check) => check.passesWithConfidence),
    checks,
  };
}

/** Two-sided exact McNemar p-value from the discordant counts. */
export function mcnemarExact(b: number, c: number): number {
  const n = b + c;
  if (n === 0) return 1;
  const k = Math.min(b, c);
  // Sum C(n,i) / 2^n for i <= k in log space: 2^-n underflows past n ~ 1074.
  const logTerms: number[] = [];
  let logTerm = -n * Math.LN2; // log(C(n,0) / 2^n)
  for (let i = 0; i <= k; i += 1) {
    logTerms.push(logTerm);
    logTerm += Math.log(n - i) - Math.log(i + 1);
  }
  const top = logTerms.reduce((max, value) => Math.max(max, value), -Infinity);
  const tail = Math.exp(top) * logTerms.reduce((sum, value) => sum + Math.exp(value - top), 0);
  return Math.min(1, 2 * tail);
}

export interface PairedComparison {
  items: number;
  verdictsDiffer: number;
  /** a Private where b Personal, and the reverse. */
  aPrivateBPersonal: number;
  aPersonalBPrivate: number;
  bothRight: number;
  onlyARight: number;
  onlyBRight: number;
  bothWrong: number;
  /** Exact McNemar on onlyARight against onlyBRight. */
  mcnemarP: number;
}

/** Two judges on the items both scored, injections left out of both. */
export function paired(a: readonly JudgedRow[], b: readonly JudgedRow[]): PairedComparison {
  const other = new Map(b.filter((row) => !row.injection).map((row) => [row.id, row]));
  const both = a.filter((row) => !row.injection && other.has(row.id));
  const right = (row: JudgedRow) => (row.judge === 'private') === ownerPrivateSide(row.owner);
  const out = { items: both.length, verdictsDiffer: 0, aPrivateBPersonal: 0, aPersonalBPrivate: 0, bothRight: 0, onlyARight: 0, onlyBRight: 0, bothWrong: 0 };
  for (const row of both) {
    const peer = other.get(row.id)!;
    if (row.judge !== peer.judge) {
      out.verdictsDiffer += 1;
      if (row.judge === 'private') out.aPrivateBPersonal += 1;
      else out.aPersonalBPrivate += 1;
    }
    const [ra, rb] = [right(row), right(peer)];
    if (ra && rb) out.bothRight += 1;
    else if (ra) out.onlyARight += 1;
    else if (rb) out.onlyBRight += 1;
    else out.bothWrong += 1;
  }
  return { ...out, mcnemarP: mcnemarExact(out.onlyARight, out.onlyBRight) };
}
