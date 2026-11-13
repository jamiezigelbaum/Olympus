/** Content-free owner settings and stops, shared by workers and owner surfaces. */
import { readFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { writePrivateFileAtomicSync } from './atomic-file.ts';
import { LocalSourceSchedulerStateStore, defaultSourceSchedulerStateDbPath } from '../workers/source-scheduler-state.ts';
import { sharedDataPath } from './olympus-layout.ts';
import type { LimitStop } from './limit-stops.ts';

export interface DailyCallOverride { to: number; day?: string; keep: boolean; base?: number }
export function ownerLimitSettingsPath(): string {
  return sharedDataPath('limit-settings');
}

/** Owner config key judge.dailyCalls; a temporary value belongs to one UTC day. */
export function readJudgeCallOverride(now: Date, path = ownerLimitSettingsPath()): number | undefined {
  let raw: { judge?: { dailyCalls?: DailyCallOverride } };
  try { raw = JSON.parse(readFileSync(path, 'utf8')); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw new Error('Owner limit settings could not be read.');
  }
  const value = raw.judge?.dailyCalls;
  if (!value) return undefined;
  if (!Number.isSafeInteger(value.to) || value.to < 0 || typeof value.keep !== 'boolean') throw new Error('Owner judge.dailyCalls setting is invalid.');
  if (value.base !== undefined && (!Number.isSafeInteger(value.base) || value.base < 0)) throw new Error('Owner judge.dailyCalls base setting is invalid.');
  return value.keep || value.day === now.toISOString().slice(0, 10) ? value.to : value.base;
}

export function saveJudgeCallOverride(to: number, keep: boolean, now: Date, path = ownerLimitSettingsPath()): void {
  if (!Number.isSafeInteger(to) || to < 0) throw new TypeError('The daily call limit must be a non-negative integer.');
  let prior: DailyCallOverride | undefined;
  try { prior = JSON.parse(readFileSync(path, 'utf8')).judge?.dailyCalls; }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('Owner limit settings could not be read.'); }
  // A one-day raise above a permanent choice falls back to that choice tomorrow.
  const base = prior?.keep ? prior.to : prior?.base;
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writePrivateFileAtomicSync(path, JSON.stringify({ judge: { dailyCalls: { to, keep,
    ...(!keep ? { day: now.toISOString().slice(0, 10), ...(base !== undefined ? { base } : {}) } : {}) } } }) + '\n');
}

/** The existing store owns opening, migrations and deterministic closing. */
export function withOwnerLimitStore<T>(use: (store: LocalSourceSchedulerStateStore) => T, dbPath = defaultSourceSchedulerStateDbPath()): T {
  const store = new LocalSourceSchedulerStateStore(dbPath);
  try { return use(store); } finally { store.close(); }
}
export function recordOwnerLimitStop(stop: LimitStop): void {
  withOwnerLimitStore(store => store.reportLimitStop(stop));
}
export function clearOwnerLimitStop(id: string, subject: string): void {
  if (!existsSync(defaultSourceSchedulerStateDbPath())) return;
  withOwnerLimitStore(store => store.clearLimitStop(id, subject));
}
