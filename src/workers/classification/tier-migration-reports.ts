/**
 * Where the tier migration keeps its files, and the forget steps on them
 * (core/source-forget-registry.ts).
 *
 * `olympus tier migrate plan` writes `<dir>/reports/<plan id>.json`: counts
 * and, per source, the top patterns that decide where items move (the owner's
 * folder paths, senders and chat keys, with item counts). Those are names from
 * the source's items, so a per-source Delete takes the source's patterns out of
 * them. The plan's counts stay.
 *
 * The state file, `<dir>/state.json`, is not name-free either: each batch of a
 * plan records the owner's raw selector (`folder:/...`, `label:...`,
 * `sender:...`, `chat:...`) so a stopped batch can resume by it. A selector
 * carries no source tag, but each plan lists its lanes, so a Delete replaces
 * the selectors of every plan that has the source as a lane.
 *
 * Kept apart from tier-migration.ts so the forget registry can reach it without
 * loading the migration (and, through it, every store).
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { writePrivateFileAtomicSync } from '../../core/atomic-file.ts';
import { sharedDataPath, type LayoutEnv } from '../../core/olympus-layout.ts';

export const TIER_MIGRATION_DIR_ENV = 'OLYMPUS_TIER_MIGRATION_DIR';

/** The migration's folder: its state file and its reports sit in it. */
export function tierMigrationDir(env: LayoutEnv): string {
  return env[TIER_MIGRATION_DIR_ENV]?.trim() || sharedDataPath('tier-migration', env);
}

export function tierMigrationReportDir(env: LayoutEnv): string {
  return join(tierMigrationDir(env), 'reports');
}

export function tierMigrationStatePath(env: LayoutEnv): string {
  return join(tierMigrationDir(env), 'state.json');
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * One source's forget step: its patterns leave every plan report. A report that
 * is not a plan report, or cannot be read, is left alone. Returns how many
 * patterns went (on a dry run, would go).
 */
export function forgetTierMigrationReports(
  reportDir: string,
  sourceIds: readonly string[],
  options: { dryRun?: boolean } = {},
): number {
  if (!existsSync(reportDir)) return 0;
  let forgotten = 0;
  for (const name of readdirSync(reportDir).filter((entry) => entry.endsWith('.json')).sort()) {
    const path = join(reportDir, name);
    let report: unknown;
    try {
      report = JSON.parse(readFileSync(path, 'utf8'));
    } catch {
      continue;
    }
    if (!isRecord(report) || report.kind !== 'olympus_tier_migration_plan' || !Array.isArray(report.topPatterns)) continue;
    const kept = report.topPatterns.filter((pattern) =>
      !(isRecord(pattern) && typeof pattern.source === 'string' && sourceIds.includes(pattern.source)));
    const gone = report.topPatterns.length - kept.length;
    if (gone === 0) continue;
    forgotten += gone;
    if (options.dryRun !== true) {
      writePrivateFileAtomicSync(path, `${JSON.stringify({ ...report, topPatterns: kept }, null, 2)}\n`);
    }
  }
  return forgotten;
}

/** What replaces the value of a forgotten batch selector: the kind stays, the name does not. */
export const FORGOTTEN_SELECTOR_VALUE = '<forgotten>';

/**
 * One source's forget step on the state file: in every plan that has the source
 * as a lane, each batch selector other than `source:<id>` becomes the same kind
 * with a non-identifying value (`folder:<forgotten>`). `source:` selectors name
 * a source, not an item, and every other field stays. The selectors are not
 * tagged by source, so in a plan that spans several sources all of its
 * selectors go; a plan without the source keeps its own.
 *
 * A batch that was stopped before the Delete no longer resumes by its selector
 * (the owner's next run with the same selector starts a new batch); its counts
 * and its place in the plan are untouched.
 *
 * A missing, malformed or unrecognised file is left alone. Returns how many
 * selectors went (on a dry run, would go).
 */
export function forgetTierMigrationSelectors(
  statePath: string,
  sourceIds: readonly string[],
  options: { dryRun?: boolean } = {},
): number {
  if (!existsSync(statePath)) return 0;
  let state: unknown;
  try {
    state = JSON.parse(readFileSync(statePath, 'utf8'));
  } catch {
    return 0;
  }
  if (!isRecord(state) || !Array.isArray(state.plans)) return 0;
  let forgotten = 0;
  const plans = state.plans.map((plan: unknown) => {
    if (!isRecord(plan) || !Array.isArray(plan.lanes) || !Array.isArray(plan.batches)) return plan;
    const hasSource = plan.lanes.some((lane) => isRecord(lane) && typeof lane.sourceId === 'string' && sourceIds.includes(lane.sourceId));
    if (!hasSource) return plan;
    const batches = plan.batches.map((batch: unknown) => {
      if (!isRecord(batch) || typeof batch.selector !== 'string') return batch;
      const forgottenSelector = forgottenSelectorOf(batch.selector);
      if (forgottenSelector === batch.selector) return batch;
      forgotten += 1;
      return { ...batch, selector: forgottenSelector };
    });
    return { ...plan, batches };
  });
  if (forgotten > 0 && options.dryRun !== true) {
    writePrivateFileAtomicSync(statePath, `${JSON.stringify({ ...state, plans }, null, 2)}\n`);
  }
  return forgotten;
}

/** The selector with its value forgotten; `source:` selectors and ones already forgotten come back as they are. */
function forgottenSelectorOf(selector: string): string {
  const colon = selector.indexOf(':');
  const kind = colon > 0 ? selector.slice(0, colon) : 'selector';
  if (kind === 'source') return selector;
  return `${kind}:${FORGOTTEN_SELECTOR_VALUE}`;
}
