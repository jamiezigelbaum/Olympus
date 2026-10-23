/**
 * Visual baselines: each dashboard screen, at phone and desktop width, in light and dark, compared with a reference screenshot the
 * owner approved once. A difference beyond a small tolerance fails the screen's check until the new look is approved.
 *
 * The harness is generic: it takes a folder of reference PNGs (`--baselines <dir>`, one `<screen>.png` each). The references
 * themselves are the owner's, and live in the private deployment repository, because a screenshot is an image the leak scan cannot
 * read. `--update-baselines` writes the run's screens as candidate references into that folder; nothing is approved by writing them:
 * the owner approves by merging the change that holds them.
 *
 * What is allowed to differ between two runs of the same product is removed before the picture is taken, by a fixed, documented
 * mechanism (never by a loose tolerance): the times and counts that legitimately vary are normalised to fixed text, animation and
 * caret are frozen, and the lists whose length depends on what the run asked (the Inbox) are left out of the picture.
 *
 * This file runs on the computer that runs the harness (it holds the image library); the in-machine agent only takes the pictures,
 * and `maskScript` is the one thing of it the machine runs.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import pixelmatch from 'pixelmatch';
import { PNG } from 'pngjs';
import { findChange, outline, zoomCrop } from './visual-boxes.ts';
import type { CheckResult } from './report.ts';

import { MASK_SELECTORS_HIDDEN, SCREENS, screenName, type Screen } from './visual-capture.ts';

export * from './visual-capture.ts';

// ---------------------------------------------------------------------------
// Comparing

/** The share of pixels that may differ, and how different a pixel must be to count (pixelmatch's own 0..1 scale). */
export const DEFAULT_TOLERANCE = { maxDiffRatio: 0.002, pixelThreshold: 0.1 } as const;

export interface Comparison {
  status: 'match' | 'different' | 'size' | 'missing' | 'unreadable';
  diffPixels: number;
  diffRatio: number;
  width: number;
  height: number;
  baselineSize?: { width: number; height: number };
  /** The image of what differs (red on a faded copy of the baseline); only when the sizes agree and something differs. */
  diffPng?: Buffer;
}

export function compareImages(baseline: Buffer | undefined, actual: Buffer, tolerance: { maxDiffRatio: number; pixelThreshold: number } = DEFAULT_TOLERANCE): Comparison {
  let now: PNG;
  try { now = PNG.sync.read(actual); } catch { return { status: 'unreadable', diffPixels: 0, diffRatio: 0, width: 0, height: 0 }; }
  const base = { status: 'missing' as const, diffPixels: 0, diffRatio: 0, width: now.width, height: now.height };
  if (!baseline) return base;
  let reference: PNG;
  try { reference = PNG.sync.read(baseline); } catch { return { ...base, status: 'unreadable' }; }
  if (reference.width !== now.width || reference.height !== now.height) {
    return { status: 'size', diffPixels: 0, diffRatio: 1, width: now.width, height: now.height, baselineSize: { width: reference.width, height: reference.height } };
  }
  const diff = new PNG({ width: now.width, height: now.height });
  const diffPixels = pixelmatch(reference.data, now.data, diff.data, now.width, now.height, { threshold: tolerance.pixelThreshold });
  const diffRatio = diffPixels / (now.width * now.height);
  const ok = diffRatio <= tolerance.maxDiffRatio;
  return { status: ok ? 'match' : 'different', diffPixels, diffRatio, width: now.width, height: now.height, ...(ok || diffPixels === 0 ? {} : { diffPng: PNG.sync.write(diff) }) };
}

export interface VisualResult {
  screen: string;
  title: string;
  width: number;
  theme: string;
  comparison: Omit<Comparison, 'diffPng'>;
  /** Files, relative to the run's folder (written only where they are shown). */
  baseline?: string;
  actual: string;
  diff?: string;
  /** The run wrote this picture as the new candidate reference. */
  updated?: boolean;
  /** Where old and new differ: a sentence, the pictures with the changed region outlined, and zoomed crops of it (files relative to the run's folder). */
  change?: { caption: string; baselineBoxed: string; actualBoxed: string; cropBaseline: string; cropActual: string };
  /** The picture differed, but the owner has approved a design change since the references were taken: the reference was refreshed. */
  approvedRefresh?: boolean;
}

export interface VisualRun {
  results: VisualResult[];
  baselinesDir: string;
  update: boolean;
}

// ---------------------------------------------------------------------------
// The owner's approval of a design change

/** Where the references record which design approval they were taken under (beside the pictures). */
export const APPROVAL_FILE = 'approval.json';

/**
 * A short fingerprint of the owner's design approvals: the approved design review and each reviewed state's approved rendering, from
 * `config/dashboard-design-review.json`. It changes only when the owner approves a design (the guard digests are re-pinned for that),
 * never for a change nobody approved, so a changed look under a new fingerprint is an approved change and under the same one is a defect.
 */
export function approvalDigestOf(review: unknown): string {
  const r = (review ?? {}) as { design_review?: unknown; reviewed_states?: Array<{ id?: string; rendered_html_sha256?: string }> };
  const states = (r.reviewed_states ?? []).map((state) => [state.id ?? '', state.rendered_html_sha256 ?? '']);
  return createHash('sha256').update(JSON.stringify({ design_review: r.design_review ?? null, states })).digest('hex');
}

/** The fingerprint for the harness's own source (the review file beside it); undefined where there is no such file. */
export function currentApprovalDigest(configPath = join(import.meta.dir, '..', '..', 'config', 'dashboard-design-review.json')): string | undefined {
  try { return approvalDigestOf(JSON.parse(readFileSync(configPath, 'utf8'))); } catch { return undefined; }
}

function readApprovalDigest(baselinesDir: string): string | undefined {
  try {
    const value = (JSON.parse(readFileSync(join(baselinesDir, APPROVAL_FILE), 'utf8')) as { approvalDigest?: unknown }).approvalDigest;
    return typeof value === 'string' && value !== '' ? value : undefined;
  } catch { return undefined; }
}

if (import.meta.main) console.log(currentApprovalDigest() ?? '');

/**
 * Compares the pictures the machine took (in `actualDir`, `<screen>-<width>-<theme>.png`) with the references in `baselinesDir`, and
 * writes what the report shows (the picture, the reference and the difference) under `outDir/visual`. With `update`, the pictures
 * become the candidate references in `baselinesDir`.
 */
/** Writes the outlined pictures and the zoomed crops for one screen; undefined when either picture cannot be read or nothing differs beyond the pixel tolerance. */
function describeChange(baseline: Buffer, actual: Buffer, outDir: string, name: string): NonNullable<VisualResult['change']> | undefined {
  try {
    const before = PNG.sync.read(baseline);
    const after = PNG.sync.read(actual);
    const change = findChange(before, after);
    if (!change) return undefined;
    const files = {
      baselineBoxed: `visual/${name}.baseline.boxed.png`, actualBoxed: `visual/${name}.actual.boxed.png`,
      cropBaseline: `visual/${name}.baseline.crop.png`, cropActual: `visual/${name}.actual.crop.png`,
    };
    writeFileSync(join(outDir, files.baselineBoxed), PNG.sync.write(outline(before, change.oldBoxes)));
    writeFileSync(join(outDir, files.actualBoxed), PNG.sync.write(outline(after, change.newBoxes)));
    writeFileSync(join(outDir, files.cropBaseline), PNG.sync.write(zoomCrop(before, change.oldBoxes)));
    writeFileSync(join(outDir, files.cropActual), PNG.sync.write(zoomCrop(after, change.newBoxes)));
    return { caption: change.caption, ...files };
  } catch { return undefined; }
}

function isReadablePng(bytes: Buffer): boolean {
  try { PNG.sync.read(bytes); return true; } catch { return false; }
}

export function compareScreens(input: { actualDir: string; baselinesDir: string; outDir: string; update: boolean; approvalDigest?: string | undefined; names: readonly { name: string; screen: Screen; width: number; theme: string }[]; tolerance?: { maxDiffRatio: number; pixelThreshold: number } }): VisualRun {
  const visualDir = join(input.outDir, 'visual');
  mkdirSync(visualDir, { recursive: true });
  if (input.update) mkdirSync(input.baselinesDir, { recursive: true });
  const results: VisualResult[] = [];
  // The references were taken under an earlier design approval than this build's: a changed look is then an approved change.
  const recorded = readApprovalDigest(input.baselinesDir);
  const approvedSince = input.approvalDigest !== undefined && recorded !== undefined && recorded !== input.approvalDigest;
  let refreshed = false;
  for (const item of input.names) {
    const actualPath = join(input.actualDir, `${item.name}.png`);
    if (!existsSync(actualPath)) continue;
    const actual = readFileSync(actualPath);
    const baselinePath = join(input.baselinesDir, `${item.name}.png`);
    const baseline = existsSync(baselinePath) ? readFileSync(baselinePath) : undefined;
    const comparison = compareImages(baseline, actual, input.tolerance);
    const actualCopy = `visual/${item.name}.actual.png`;
    writeFileSync(join(input.outDir, actualCopy), actual);
    const { diffPng, ...rest } = comparison;
    const result: VisualResult = { screen: item.screen.id, title: item.screen.title, width: item.width, theme: item.theme, comparison: rest, actual: actualCopy };
    if (baseline && comparison.status !== 'match') {
      const baselineCopy = `visual/${item.name}.baseline.png`;
      writeFileSync(join(input.outDir, baselineCopy), baseline);
      result.baseline = baselineCopy;
      const change = describeChange(baseline, actual, input.outDir, item.name);
      if (change) result.change = change;
    }
    if (diffPng) {
      const diffCopy = `visual/${item.name}.diff.png`;
      writeFileSync(join(input.outDir, diffCopy), diffPng);
      result.diff = diffCopy;
    }
    // A candidate that cannot be read as a PNG never replaces an approved picture (the check then fails, below).
    if (input.update && isReadablePng(actual)) {
      writeFileSync(baselinePath, actual);
      result.updated = true;
    } else if (approvedSince && (comparison.status === 'different' || comparison.status === 'size') && isReadablePng(actual)) {
      writeFileSync(baselinePath, actual);
      result.approvedRefresh = true;
      refreshed = true;
    }
    results.push(result);
  }
  if (input.approvalDigest !== undefined && (input.update || refreshed)) writeFileSync(join(input.baselinesDir, APPROVAL_FILE), `${JSON.stringify({ approvalDigest: input.approvalDigest }, null, 2)}\n`);
  return { results, baselinesDir: input.baselinesDir, update: input.update };
}

/** One check per screen: `visual.<screen>-<width>-<theme>`. A new look fails until it is approved; a candidate written this run is a warning. */
export function visualChecks(run: VisualRun): CheckResult[] {
  return run.results.map((result) => {
    const name = screenName(result.screen, result.width, result.theme);
    const title = `${result.title} at ${result.width} px, ${result.theme}, matches the approved picture`;
    const c = result.comparison;
    if (result.approvedRefresh) {
      return { id: `visual.${name}`, title, status: 'warn', detail: `approved change, references refreshed: the owner approved a design change since the references were taken, and this screen differs by ${(c.diffRatio * 100).toFixed(2)}% of pixels (old and new are side by side in the report); the new picture is in the candidate set for commit` } satisfies CheckResult;
    }
    if (result.updated) {
      return { id: `visual.${name}`, title, status: 'warn', detail: `written as the candidate approved picture (${c.status === 'missing' ? 'there was none' : c.status === 'match' ? 'unchanged' : `it differed from the one before: ${(c.diffRatio * 100).toFixed(2)}% of pixels`}); the owner approves it by merging it` } satisfies CheckResult;
    }
    const detail = c.status === 'match' ? `${(c.diffRatio * 100).toFixed(3)}% of ${c.width * c.height} pixels differ (up to ${(DEFAULT_TOLERANCE.maxDiffRatio * 100).toFixed(1)}% is allowed)`
      : c.status === 'missing' ? 'there is no approved picture for this screen; run with --update-baselines and have the owner approve the candidate'
        : c.status === 'size' ? `the page is ${c.width}x${c.height} px; the approved picture is ${c.baselineSize?.width}x${c.baselineSize?.height}`
          : c.status === 'unreadable' ? 'the picture or the approved picture could not be read as a PNG'
            : `${(c.diffRatio * 100).toFixed(2)}% of ${c.width * c.height} pixels differ from the approved picture (up to ${(DEFAULT_TOLERANCE.maxDiffRatio * 100).toFixed(1)}% is allowed)`;
    return { id: `visual.${name}`, title, status: c.status === 'match' ? 'pass' : 'fail', detail } satisfies CheckResult;
  });
}
