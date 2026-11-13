/** Content-free overrides shared with Node transports; this module never opens a store. */
import { readFileSync, mkdirSync, statSync } from 'node:fs';
import { dirname } from 'node:path';
import { sharedDataPath } from './olympus-layout.ts';
import { writePrivateFileAtomicSync } from './atomic-file.ts';
import { withFileLeaseSync } from './file-lease.ts';

export interface DailyCallOverride { to: number; day?: string; keep: boolean; base?: number; heldItems?: Record<string, number> }
export type OwnerLimitKey = 'judge.dailyCalls' | 'zkapi.dailyRequests' | 'zkapi.dailySpend' | 'gmail.dailyRequests' | 'dropbox.max_file_bytes' | 'local_files.max_file_bytes' | 'telegram.media_quota';
type Settings = Record<string, Record<string, DailyCallOverride>>;
export function ownerLimitSettingsPath(): string { return sharedDataPath('limit-settings'); }
let settingsCache: { path: string; stamp: string; value: Settings } | undefined;
function readSettings(path: string): Settings {
  const stat = statSync(path, { throwIfNoEntry: false });
  if (!stat) return {};
  const stamp = `${stat.mtimeMs}:${stat.ctimeMs}:${stat.size}:${stat.ino}`;
  if (settingsCache?.path === path && settingsCache.stamp === stamp) return settingsCache.value;
  let value: Settings;
  try { value = JSON.parse(readFileSync(path, 'utf8')); }
  catch { throw new Error('Owner limit settings could not be read.'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Owner limit settings are invalid.');
  settingsCache = { path, stamp, value };
  return value;
}
export function readOwnerLimitOverride(key: OwnerLimitKey, now: Date, path = ownerLimitSettingsPath(), heldItem?: string): number | undefined {
  const [group, name] = key.split('.') as [string, string];
  const value = readSettings(path)[group]?.[name];
  if (!value) return undefined;
  const valid = (n: number) => Number.isFinite(n) && n >= 0 && (key === 'zkapi.dailySpend' || Number.isSafeInteger(n));
  if (!valid(value.to) || typeof value.keep !== 'boolean' || (value.base !== undefined && !valid(value.base))) throw new Error(`Owner ${key} setting is invalid.`);
  if (isSizeLimitKey(key)) {
    const granted = heldItem === undefined ? undefined : value.heldItems?.[heldItem];
    if (granted !== undefined && !valid(granted)) throw new Error(`Owner ${key} held-file setting is invalid.`);
    return value.keep ? value.to : granted ?? value.base;
  }
  return value.keep || value.day === now.toISOString().slice(0, 10) ? value.to : value.base;
}
export function saveOwnerLimitOverride(key: OwnerLimitKey, to: number, keep: boolean, now: Date, path = ownerLimitSettingsPath(), heldItems?: string[]): void {
  if (!Number.isFinite(to) || to < 0 || (key !== 'zkapi.dailySpend' && !Number.isSafeInteger(to))) throw new TypeError('Invalid owner limit amount.');
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  withFileLeaseSync(path, () => {
    const raw = readSettings(path);
    const [group, name] = key.split('.') as [string, string];
    const prior = raw[group]?.[name];
    const base = prior?.keep ? prior.to : prior?.base;
    const value = { to, keep, ...(!keep ? { ...(isSizeLimitKey(key) ? { heldItems: { ...prior?.heldItems, ...Object.fromEntries((heldItems ?? []).map(item => [item, to])) } } : { day: now.toISOString().slice(0, 10) }), ...(base !== undefined ? { base } : {}) } : {}) };
    writePrivateFileAtomicSync(path, JSON.stringify({ ...raw, [group]: { ...raw[group], [name]: value } }) + '\n');
    settingsCache = undefined;
  });
}
export function readJudgeCallOverride(now: Date, path = ownerLimitSettingsPath()): number | undefined {
  return readOwnerLimitOverride('judge.dailyCalls', now, path);
}
export function saveJudgeCallOverride(to: number, keep: boolean, now: Date, path = ownerLimitSettingsPath()): void {
  saveOwnerLimitOverride('judge.dailyCalls', to, keep, now, path);
}

export function isSizeLimitKey(key: string): boolean {
  return ['dropbox.max_file_bytes', 'local_files.max_file_bytes', 'telegram.media_quota'].includes(key);
}
