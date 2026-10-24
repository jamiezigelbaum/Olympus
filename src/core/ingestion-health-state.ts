/**
 * The ingestion-health baseline the doctor compares each run against:
 * `source-ingestion-doctor-state.json` in the data root, one entry per
 * ingestion-ledger source (`email`, `dropbox`, ...) with its stuck-work and
 * terminal-failure counts. Counts only. It sits beside the dashboard
 * database and is rewritten by every doctor run.
 *
 * Kept apart from doctor.ts so the forget registry can reach it without
 * loading the doctor (and, through it, the ingestion ledger).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { writePrivateFileAtomicSync } from './atomic-file.ts';
import { olympusDataPath, type LayoutEnv } from './olympus-layout.ts';

export interface IngestionHealthDoctorState {
  generated_at: string;
  sources: Record<string, {
    actionable_stuck: number;
    failed_terminal_by_class: Record<string, number>;
  }>;
}

export function defaultIngestionHealthStatePath(env: LayoutEnv = process.env): string {
  return olympusDataPath(env, 'source-ingestion-doctor-state.json');
}

export function readIngestionHealthState(path: string): IngestionHealthDoctorState | undefined {
  try {
    if (!existsSync(path)) return undefined;
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown;
    const record = asRecord(parsed);
    const sources = asRecord(record.sources);
    const normalized: IngestionHealthDoctorState['sources'] = {};
    for (const [sourceId, sourceValue] of Object.entries(sources)) {
      const source = asRecord(sourceValue);
      const terminal = asRecord(source.failed_terminal_by_class);
      normalized[sourceId] = {
        actionable_stuck: asCount(source.actionable_stuck),
        failed_terminal_by_class: Object.fromEntries(Object.entries(terminal)
          .map(([key, value]) => [key, asCount(value)])),
      };
    }
    return {
      generated_at: typeof record.generated_at === 'string' ? record.generated_at : new Date(0).toISOString(),
      sources: normalized,
    };
  } catch {
    return undefined;
  }
}

export function writeIngestionHealthState(path: string, state: IngestionHealthDoctorState): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, `${JSON.stringify(state, null, 2)}\n`);
}

/**
 * One source's forget step: its entries leave the baseline, so the doctor's
 * "growing across runs" comparison starts again for it. `ledgerSourceIds` are
 * the ledger's ids for the source, not its registry ids. A missing or
 * unreadable file has nothing to forget (the next doctor run replaces it).
 * Returns how many entries went (or, on a dry run, would).
 */
export function forgetIngestionHealthState(
  path: string,
  ledgerSourceIds: readonly string[],
  options: { dryRun?: boolean } = {},
): number {
  const state = readIngestionHealthState(path);
  if (!state) return 0;
  const doomed = Object.keys(state.sources).filter((id) => ledgerSourceIds.includes(id));
  if (doomed.length === 0 || options.dryRun === true) return doomed.length;
  const kept = Object.fromEntries(Object.entries(state.sources).filter(([id]) => !doomed.includes(id)));
  writePrivateFileAtomicSync(path, `${JSON.stringify({ ...state, sources: kept }, null, 2)}\n`);
  return doomed.length;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function asCount(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0;
}
