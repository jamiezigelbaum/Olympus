/**
 * Where the tier migration keeps its plan reports, and the forget step on them
 * (core/source-forget-registry.ts).
 *
 * `olympus tier migrate plan` writes `<dir>/reports/<plan id>.json`: counts
 * and, per source, the top patterns that decide where items move (the owner's
 * folder paths, senders and chat keys, with item counts). Those are names from
 * the source's items, so a per-source Delete takes the source's patterns out of
 * them. The plan's counts and the state file hold no names and stay.
 *
 * Kept apart from tier-migration.ts so the forget registry can reach it without
 * loading the migration (and, through it, every store).
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { writePrivateFileAtomicSync } from '../../core/atomic-file.ts';
import { olympusDataPath, type LayoutEnv } from '../../core/olympus-layout.ts';

export const TIER_MIGRATION_DIR_ENV = 'OLYMPUS_TIER_MIGRATION_DIR';

/** The migration's folder: its state file and its reports sit in it. */
export function tierMigrationDir(env: LayoutEnv): string {
  return env[TIER_MIGRATION_DIR_ENV]?.trim() || olympusDataPath(env, 'tier-migration');
}

export function tierMigrationReportDir(env: LayoutEnv): string {
  return join(tierMigrationDir(env), 'reports');
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
