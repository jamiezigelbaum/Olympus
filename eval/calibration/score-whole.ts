// Score any number of judges on the frozen whole-item sample (issues #883, #864).
//
//   bun eval/calibration/score-whole.ts [--dir DIR] --judge NAME=FILE [--judge NAME=FILE ...]
//
// Each FILE is a saved result of score.ts (the built-in model through the
// production classifier) or judge-run.ts (a llama.cpp server, or Venice).
// Only judge verdicts are scored; production placement per component is #1159.
//
// It refuses to score unless manifest.json still matches the sample and its own
// hash, so the sample and the acceptance criteria were fixed before scoring.
//
// For every judge: the whole matrix of owner label (Personal, Private important,
// minor or untagged, Secret) by verdict, both mistakes (Private->Personal and
// Personal->Private) as counts, unweighted and weighted rates with Wilson
// intervals at Kish's effective sample size, injections apart, per-source
// counts, the frozen criteria on their split, and the same broken down by how
// the text was read (extraction, OCR, failures), whether the judge read all of
// it, and where the owner said the sensitive part is (excerpt selection). Then
// paired disagreements between every two judges, with an exact McNemar test.
// Output is counts and rates only: no text, no names, no item ids.

import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CALIBRATION_DIR_DEFAULT, readLabels, SAMPLE_FILE, type CalibrationLabels, type CalibrationSample, type CalibrationSampleItem } from './files.ts';
import {
  cellKey,
  cellWeights,
  groupedScores,
  judgeAgainst,
  MANIFEST_FILE,
  OWNER_CLASSES,
  ownerClass,
  ownerPrivateSide,
  paired,
  scoreRows,
  verifyManifest,
  type CriteriaResult,
  type DesignCell,
  type JudgedRow,
  type Verdict,
  type WholeManifest,
} from './whole-item.ts';

/** One judge's verdict on one item, as read from a saved result. */
export interface JudgeVerdict {
  judge: Verdict;
  injection: boolean;
}

/** Reads a score.ts or judge-run.ts result: per-item verdicts by id, and the sample it was run on if it says. */
export function readJudgeFile(raw: unknown): { verdicts: Map<string, JudgeVerdict>; sampleSha256?: string } {
  const file = raw as { rows?: Array<Record<string, unknown>>; sampleSha256?: string };
  if (!Array.isArray(file.rows)) throw new Error('A judge file has no rows: pass a full result saved by score.ts or judge-run.ts.');
  const verdicts = new Map<string, JudgeVerdict>();
  for (const row of file.rows) {
    const id = String(row['id']);
    const judge: Verdict | undefined = row['judge'] === 'private' || row['judge'] === 'personal'
      ? row['judge']
      : typeof row['madePrivate'] === 'boolean' ? (row['madePrivate'] ? 'private' : 'personal') : undefined;
    if (!judge) throw new Error('A judge row has no verdict.');
    const why = Array.isArray(row['why']) ? (row['why'] as unknown[]).join(' ') : '';
    verdicts.set(id, { judge, injection: row['via'] === 'injection' || /:injection:/.test(why) });
  }
  return { verdicts, ...(typeof file.sampleSha256 === 'string' ? { sampleSha256: file.sampleSha256 } : {}) };
}

/** Acceptance needs a verdict on every labeled item: a subset never passes. */
function withCoverage(result: CriteriaResult, coverage: { labeled: number; withVerdict: number; missing: number }): CriteriaResult {
  const complete = coverage.missing === 0;
  return {
    ...result,
    passes: result.passes && complete,
    passesWithConfidence: result.passesWithConfidence && complete,
    checks: { ...result.checks, coverage: { value: coverage.missing, bound: coverage.missing, max: 0, passes: complete, passesWithConfidence: complete } },
  };
}

/** Weights recomputed inside one subset (a split): each cell's population over its labeled rows there. */
function reweigh(rows: readonly JudgedRow[], populations: ReadonlyMap<string, number>): JudgedRow[] {
  const weights = cellWeights(rows, populations);
  return rows.map((row) => ({ ...row, weight: weights.get(row.id)! }));
}

export function scoreWhole(input: {
  sample: CalibrationSample;
  sampleBytes: string;
  manifest: WholeManifest;
  labels: CalibrationLabels;
  judges: Record<string, { verdicts: Map<string, JudgeVerdict>; sampleSha256?: string }>;
}) {
  const { sample, manifest, labels } = input;
  verifyManifest(manifest, input.sampleBytes);
  const criteria = manifest.criteria;
  const confidence = criteria.confidence;
  const cells = ((sample.recipe as { cells?: DesignCell[] } | undefined)?.cells ?? []);
  const populations = new Map(cells.map((cell) => [cellKey(cell.area, cell.stratum), cell.population]));
  const items = sample.items;
  const byId = new Map(items.map((item) => [item.id, item]));

  const labeled = items.flatMap((item) => {
    const owner = ownerClass(labels.labels[item.id]);
    return owner ? [{ item, owner }] : [];
  });
  const weights = cellWeights(labeled.map(({ item }) => ({ id: item.id, area: item.area, stratum: item.stratum ?? '' })), populations);
  const notSure = items.filter((item) => labels.labels[item.id]?.label === 'unsure');

  const count = (values: readonly string[]) => {
    const out: Record<string, number> = {};
    for (const value of values) out[value] = (out[value] ?? 0) + 1;
    return out;
  };
  const bySource: Record<string, unknown> = {};
  for (const area of [...new Set(items.map((item) => item.area))].sort()) {
    const mine = labeled.filter(({ item }) => item.area === area);
    bySource[area] = {
      population: cells.filter((cell) => cell.area === area).reduce((sum, cell) => sum + cell.population, 0),
      sampled: items.filter((item) => item.area === area).length,
      labeled: mine.length,
      byLabel: Object.fromEntries(OWNER_CLASSES.map((owner) => [owner, mine.filter((row) => row.owner === owner).length])),
      notSure: notSure.filter((item) => item.area === area).length,
    };
  }

  const all = { ...Object.fromEntries(Object.entries(input.judges).map(([name, file]) => {
    // A result that does not name its sample cannot be shown to be from this one.
    if (file.sampleSha256 === undefined) throw new Error(`${name} does not record the sample it was run on: rerun it with this version of score.ts or judge-run.ts.`);
    if (file.sampleSha256 !== manifest.sampleSha256) throw new Error(`${name} was run on a different sample.`);
    return [name, file.verdicts];
  })) };
  const rowsOf = (verdicts: Map<string, JudgeVerdict>): JudgedRow[] => labeled.flatMap(({ item, owner }) => {
    const verdict = verdicts.get(item.id);
    if (!verdict) return [];
    return [{
      id: item.id,
      area: item.area,
      stratum: item.stratum ?? '',
      split: item.split ?? 'dev',
      owner,
      judge: verdict.judge,
      // The shared screen holds the same items for every judge.
      injection: verdict.injection || item.whole?.injection === true,
      weight: weights.get(item.id)!,
    }];
  });

  const judges: Record<string, unknown> = {};
  const rowsByJudge: Record<string, JudgedRow[]> = {};
  for (const [name, verdicts] of Object.entries(all)) {
    const rows = rowsOf(verdicts);
    // Every labeled item needs a verdict: a subset (--limit, --split, --exclude, a crash) cannot pass.
    const coverage = { labeled: labeled.length, withVerdict: rows.length, missing: labeled.length - rows.length };
    rowsByJudge[name] = rows;
    const inSplit = criteria.split === 'all' ? rows : reweigh(rows.filter((row) => row.split === criteria.split), populations);
    const splitScores = Object.fromEntries((['dev', 'test'] as const).map((split) => {
      const members = rows.filter((row) => row.split === split);
      return [split, members.length > 0 ? scoreRows(reweigh(members, populations), confidence) : null];
    }));
    const privateRows = rows.filter((row) => ownerPrivateSide(row.owner));
    judges[name] = {
      itemsWithVerdict: rows.length,
      coverage,
      all: scoreRows(rows, confidence),
      criteria: withCoverage(judgeAgainst(scoreRows(inSplit, confidence), criteria), coverage),
      bySplit: splitScores,
      bySource: groupedScores(rows, (row) => row.area, confidence),
      notSure: {
        items: notSure.filter((item) => verdicts.has(item.id)).length,
        calledPrivate: notSure.filter((item) => verdicts.get(item.id)?.judge === 'private').length,
      },
      stages: {
        // Extraction: how the item's own text was read.
        byExtraction: groupedScores(rows, (row) => byId.get(row.id)!.whole?.extraction?.outcome ?? 'none', confidence),
        byAttachments: groupedScores(rows, (row) => ((byId.get(row.id)!.whole?.children.length ?? 0) > 0 ? 'with' : 'without'), confidence),
        // Excerpt selection: did the judge read all of it, and where the owner says the sensitive part is.
        byJudgeReads: groupedScores(rows, (row) => (byId.get(row.id)!.whole?.judgeReadsAll === false ? 'excerpt' : 'all'), confidence),
        privateMissesByWhere: Object.fromEntries(['excerpt', 'outside', 'attachment', 'names', 'unanswered'].map((where) => {
          const members = privateRows.filter((row) => !row.injection && (labels.labels[row.id]?.where ?? 'unanswered') === where);
          return [where, { items: members.length, missed: members.filter((row) => row.judge === 'personal').length }];
        })),
      },
    };
  }

  const names = Object.keys(rowsByJudge);
  const pairs: Record<string, unknown> = {};
  for (let i = 0; i < names.length; i += 1) {
    for (let j = i + 1; j < names.length; j += 1) pairs[`${names[i]} vs ${names[j]}`] = paired(rowsByJudge[names[i]!]!, rowsByJudge[names[j]!]!);
  }

  const privateSide = labeled.filter(({ owner }) => ownerPrivateSide(owner));
  return {
    frozen: { sampleSha256: manifest.sampleSha256, manifestSha256: manifest.manifestSha256, frozenAt: manifest.frozenAt, criteria },
    labels: {
      sampled: items.length,
      labeled: labeled.length,
      byLabel: Object.fromEntries(OWNER_CLASSES.map((owner) => [owner, labeled.filter((row) => row.owner === owner).length])),
      notSure: notSure.length,
      unlabeled: items.filter((item) => !labels.labels[item.id]).length,
      whereSensitive: count(privateSide.map(({ item }) => labels.labels[item.id]?.where ?? 'unanswered')),
      bySplit: count(labeled.map(({ item }) => item.split ?? 'dev')),
      bySource,
    },
    extraction: count(items.map((item) => item.whole?.extraction?.outcome ?? 'none')),
    judges,
    paired: pairs,
  };
}

function main(): void {
  const argv = process.argv.slice(2);
  const index = argv.indexOf('--dir');
  const dir = index >= 0 ? argv[index + 1]! : join(CALIBRATION_DIR_DEFAULT, 'whole');
  const judges: Record<string, ReturnType<typeof readJudgeFile>> = {};
  argv.forEach((arg, at) => {
    if (arg !== '--judge') return;
    const spec = argv[at + 1] ?? '';
    const eq = spec.indexOf('=');
    if (eq <= 0) throw new Error('--judge takes NAME=FILE.');
    judges[spec.slice(0, eq)] = readJudgeFile(JSON.parse(readFileSync(spec.slice(eq + 1), 'utf8')));
  });
  const manifestPath = join(dir, MANIFEST_FILE);
  if (!existsSync(manifestPath)) throw new Error(`No frozen manifest at ${manifestPath}: draw the sample with sample-whole.ts.`);
  const sampleBytes = readFileSync(join(dir, SAMPLE_FILE), 'utf8');
  const result = scoreWhole({
    sample: JSON.parse(sampleBytes) as CalibrationSample,
    sampleBytes,
    manifest: JSON.parse(readFileSync(manifestPath, 'utf8')) as WholeManifest,
    labels: readLabels(dir),
    judges,
  });
  const at = new Date().toISOString();
  const path = join(dir, `score-whole-${at.replace(/[:.]/g, '-')}.json`);
  writeFileSync(path, JSON.stringify({ at, ...result }, null, 1), { mode: 0o600 });
  chmodSync(path, 0o600);
  console.log(JSON.stringify(result, null, 1));
  console.log(`Saved: ${path}`);
}

if (import.meta.main) main();
