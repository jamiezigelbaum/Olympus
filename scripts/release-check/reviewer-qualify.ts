/**
 * Qualifies the AI reviewer (reviewer.ts) against the pictures of a qualification run (`run.ts --reviewer-plants`, reviewer-plants.ts):
 *
 *   RELEASE_CHECK_REVIEWER_KEY=... bun scripts/release-check/reviewer-qualify.ts --plants <report folder>/plants [--trials <n>]
 *
 * Every picture, planted or not, is put to the reviewer the way a run puts a screen (the same words; nothing says what was planted),
 * several times over, in a shuffled order. The score: for each kind of bug, how often the reviewer reports that kind where it was
 * planted (recall) and how often a report of that kind is of a bug planted there (precision); the same recall over the held-out bugs
 * alone; how often it reports a problem on a picture with nothing planted; and how often it gives no usable answer. The thresholds are
 * in config/release-check-reviewer.json. Writes qualification.json beside the pictures and prints the summary.
 *
 * Findings on the pictures with nothing planted are listed in full: some may be real problems in the product, which a person decides.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { PlantedPicture } from './reviewer-plants.ts';
import { chatModel, loadReviewerConfig, review, screenUnit, REVIEW_KINDS, type QualificationThresholds, type ReviewFinding, type ReviewKind, type ReviewResult, type ReviewUnit } from './reviewer.ts';

export interface KindScore { planted: number; found: number; recall: number | null; reported: number; correct: number; precision: number | null }

export interface QualificationScore {
  model: string;
  trials: number;
  pictures: number;
  perKind: Partial<Record<ReviewKind, KindScore>>;
  perPlant: Array<{ plant: string; kind: ReviewKind; heldOut: boolean; looked: number; found: number }>;
  heldOut: { looked: number; found: number; recall: number | null };
  clean: { looked: number; withFindings: number; falseAlarmRate: number | null; findings: Array<Pick<ReviewFinding, 'picture' | 'kind' | 'what' | 'where'>> };
  inconclusive: { asked: number; unanswered: number; rate: number | null };
  qualified: boolean;
  /** Each threshold missed, in words; empty when qualified. */
  shortfalls: string[];
}

const ratio = (part: number, whole: number): number | null => (whole === 0 ? null : part / whole);
const percent = (value: number | null): string => (value === null ? 'n/a' : `${Math.round(value * 100)}%`);

/** The unit id a picture is asked under: its place in the index, so nothing in it says what was planted. */
const unitId = (index: number): string => `picture:${index + 1}`;

/** Scores trials of the reviewer over a qualification run's pictures. Pure: the trials' results in, the score out. */
export function scoreQualification(pictures: readonly PlantedPicture[], trials: readonly ReviewResult[], thresholds: QualificationThresholds): QualificationScore {
  const perKind: Partial<Record<ReviewKind, KindScore>> = {};
  const kindScore = (kind: ReviewKind): KindScore => (perKind[kind] ??= { planted: 0, found: 0, recall: null, reported: 0, correct: 0, precision: null });
  const perPlant = new Map<string, { plant: string; kind: ReviewKind; heldOut: boolean; looked: number; found: number }>();
  const heldOut = { looked: 0, found: 0 };
  const clean = { looked: 0, withFindings: 0, findings: [] as QualificationScore['clean']['findings'] };
  let asked = 0;
  let unanswered = 0;
  for (const trial of trials) {
    const unansweredHere = new Set(trial.inconclusive.map((entry) => entry.unit));
    pictures.forEach((picture, index) => {
      const id = unitId(index);
      asked += 1;
      if (unansweredHere.has(id)) { unanswered += 1; return; }
      const findings = trial.findings.filter((finding) => finding.unit === id);
      const kinds = new Set(findings.map((finding) => finding.kind));
      for (const kind of kinds) {
        const score = kindScore(kind);
        score.reported += 1;
        if (kind === picture.kind) score.correct += 1;
      }
      if (!picture.plant || !picture.kind) {
        clean.looked += 1;
        if (findings.length > 0) clean.withFindings += 1;
        for (const finding of findings) clean.findings.push({ picture: picture.picture, kind: finding.kind, what: finding.what, where: finding.where });
        return;
      }
      const found = kinds.has(picture.kind);
      const score = kindScore(picture.kind);
      score.planted += 1;
      if (found) score.found += 1;
      const entry = perPlant.get(picture.plant) ?? { plant: picture.plant, kind: picture.kind, heldOut: picture.heldOut, looked: 0, found: 0 };
      entry.looked += 1;
      if (found) entry.found += 1;
      perPlant.set(picture.plant, entry);
      if (picture.heldOut) { heldOut.looked += 1; if (found) heldOut.found += 1; }
    });
  }
  for (const score of Object.values(perKind)) {
    score.recall = ratio(score.found, score.planted);
    score.precision = ratio(score.correct, score.reported);
  }
  const shortfalls: string[] = [];
  for (const [kind, score] of Object.entries(perKind) as Array<[ReviewKind, KindScore]>) {
    if (score.recall !== null && score.recall < thresholds.minRecall) shortfalls.push(`${kind}: found ${score.found} of ${score.planted} planted (${percent(score.recall)}; at least ${percent(thresholds.minRecall)} needed)`);
    if (score.precision !== null && score.precision < thresholds.minPrecision) shortfalls.push(`${kind}: ${score.correct} of ${score.reported} reports were of a bug planted there (${percent(score.precision)}; at least ${percent(thresholds.minPrecision)} needed)`);
  }
  const heldOutRecall = ratio(heldOut.found, heldOut.looked);
  if (heldOutRecall === null || heldOutRecall < thresholds.minHeldOutRecall) shortfalls.push(`held-out bugs: found ${heldOut.found} of ${heldOut.looked} (${percent(heldOutRecall)}; at least ${percent(thresholds.minHeldOutRecall)} needed)`);
  const falseAlarmRate = ratio(clean.withFindings, clean.looked);
  if (falseAlarmRate === null || falseAlarmRate > thresholds.maxCleanFalseAlarm) shortfalls.push(`pictures with nothing planted: a problem was reported in ${clean.withFindings} of ${clean.looked} looks (${percent(falseAlarmRate)}; at most ${percent(thresholds.maxCleanFalseAlarm)} allowed)`);
  const unansweredRate = ratio(unanswered, asked);
  if (unansweredRate === null || unansweredRate > thresholds.maxInconclusive) shortfalls.push(`no usable answer for ${unanswered} of ${asked} looks (${percent(unansweredRate)}; at most ${percent(thresholds.maxInconclusive)} allowed)`);
  for (const kind of new Set(pictures.flatMap((picture) => (picture.kind ? [picture.kind] : [])))) {
    if (!perKind[kind] || perKind[kind]!.planted === 0) shortfalls.push(`${kind}: every look at its planted pictures went unanswered`);
  }
  return {
    model: trials[0]?.model ?? 'none', trials: trials.length, pictures: pictures.length,
    perKind, perPlant: [...perPlant.values()], heldOut: { ...heldOut, recall: heldOutRecall },
    clean: { ...clean, falseAlarmRate }, inconclusive: { asked, unanswered, rate: unansweredRate },
    qualified: shortfalls.length === 0, shortfalls,
  };
}

/** The units a qualification asks about: each picture as a run's screen, under an id that says nothing of what was planted. */
export function qualificationUnits(pictures: readonly PlantedPicture[]): ReviewUnit[] {
  return pictures.map((picture, index) => screenUnit(picture.screen, picture.width, picture.theme, picture.picture, unitId(index)));
}

/** The summary, in a few lines a person reads. */
export function summarise(score: QualificationScore): string {
  const kinds = (Object.entries(score.perKind) as Array<[ReviewKind, KindScore]>).map(([kind, s]) => `  ${kind}: found ${s.found}/${s.planted} (${percent(s.recall)}), reports right ${s.correct}/${s.reported} (${percent(s.precision)})`);
  return [
    `${score.model}: ${score.qualified ? 'QUALIFIED' : 'NOT QUALIFIED'} over ${score.trials} trial(s) of ${score.pictures} picture(s)`,
    ...kinds,
    `  held-out bugs: found ${score.heldOut.found}/${score.heldOut.looked} (${percent(score.heldOut.recall)})`,
    `  nothing planted: a problem reported in ${score.clean.withFindings}/${score.clean.looked} looks (${percent(score.clean.falseAlarmRate)})`,
    `  no usable answer: ${score.inconclusive.unanswered}/${score.inconclusive.asked} (${percent(score.inconclusive.rate)})`,
    ...score.shortfalls.map((line) => `  short: ${line}`),
  ].join('\n');
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const option = (name: string): string | undefined => { const at = argv.indexOf(name); return at >= 0 ? argv[at + 1] : undefined; };
  const dir = option('--plants');
  if (!dir) {
    console.error('usage: bun scripts/release-check/reviewer-qualify.ts --plants <report folder>/plants [--trials <n>]');
    process.exit(2);
  }
  const config = loadReviewerConfig();
  const key = process.env[config.keyEnv];
  if (!key) {
    console.error(`set ${config.keyEnv} to the reviewer's API key (${config.baseUrl})`);
    process.exit(2);
  }
  const root = resolve(dir);
  const pictures = JSON.parse(readFileSync(join(root, 'index.json'), 'utf8')) as PlantedPicture[];
  const units = qualificationUnits(pictures);
  const trials: ReviewResult[] = [];
  const count = Number(option('--trials') ?? config.qualification.trials);
  const model = chatModel({ baseUrl: config.baseUrl, model: config.model, key });
  for (let trial = 0; trial < count; trial += 1) {
    const shuffled = [...units].sort(() => Math.random() - 0.5);
    trials.push(await review(shuffled, model, { concurrency: config.concurrency, timeoutMs: config.timeoutMs, minConfidence: config.minConfidence, status: 'advisory', read: (path) => readFileSync(join(root, path)) }));
    console.error(`trial ${trial + 1} of ${count}: ${trials[trial]!.findings.length} finding(s), ${trials[trial]!.inconclusive.length} unanswered`);
  }
  const score = scoreQualification(pictures, trials, config.qualification);
  writeFileSync(join(root, 'qualification.json'), `${JSON.stringify({ at: new Date().toISOString(), kinds: REVIEW_KINDS, thresholds: config.qualification, score, trials }, null, 2)}\n`);
  console.log(summarise(score));
}
