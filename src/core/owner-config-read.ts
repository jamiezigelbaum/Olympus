// Reading an owner-edited policy file (the tier rules, the privacy profile)
// so that a half-written or tampered file can never be mistaken for a valid
// one. Three refusals, each distinct from "the file is absent":
//
// - unsafe_permissions: the file is group- or world-writable, not a regular
//   file, or owned by another user. Anything else on the machine could then
//   lower the owner's tiers.
// - torn_read: the file changed while it was being read (its identity, size
//   or modification time differs before and after), so the bytes may be a
//   mix of two versions or a partial write.
// - unreadable: it exists but could not be read.
//
// The caller decides what a refusal means; the classifiers treat it as
// "hold everything pending", never as "no policy".

import { readFileSync, statSync, lstatSync, type Stats } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { LEGACY_LINUX_POLICY_FILES, resolveLinuxEngineLayout, readLinuxEngineReceipt } from './linux-engine-layout.ts';

/** Only receipt-owned or explicitly standalone processes use the install layout.
 * Unreceipted CLI and OpenClaw policies keep their existing roots; sovereignty
 * already uses XDG, so its writer, loader and dispatch guard must agree. */
export function linuxOwnerConfigPath(name: string, env: Record<string, string | undefined> = process.env): string | undefined {
  if (process.platform !== 'linux') return undefined;
  const layout = resolveLinuxEngineLayout(env);
  const owned = !!readLinuxEngineReceipt(layout.receiptPath) || env.OLYMPUS_ENGINE_HOST === '1' || env.OLYMPUS_STANDALONE === '1';
  if (!owned && name !== 'sovereignty.json') return join(layout.home, '.olympus', name);
  if ((owned ? [name, ...LEGACY_LINUX_POLICY_FILES] : [name]).some(file => lstatSync(join(layout.home, '.olympus', file), { throwIfNoEntry: false }))) {
    throw new Error('Legacy Olympus settings still need migration. Complete the Linux engine upgrade, or back up and migrate an unreceipted installation, before using its settings; existing privacy protections were not ignored.');
  }
  return join(layout.configDir, name);
}
/** Owner policy files share the installed Linux layout; Mac keeps its historical root. */
export function defaultOwnerConfigPath(name: string, env: Record<string, string | undefined> = process.env): string {
  return linuxOwnerConfigPath(name, env) ?? join(homedir(), '.olympus', name);
}

/** Sovereignty has one default for CLI publication, loading and endpoint guards. */
export function defaultSovereigntyConfigPath(env: Record<string, string | undefined> = process.env): string {
  return linuxOwnerConfigPath('sovereignty.json', env) ?? join(env.HOME?.trim() || homedir(), '.olympus', 'sovereignty.json');
}

export type OwnerConfigRead =
  | { status: 'missing' }
  | { status: 'ok'; text: string; stamp: string }
  | { status: 'refused'; reason: 'unsafe_permissions' | 'torn_read' | 'unreadable'; stamp: string };

export function ownerConfigStamp(path: string): string {
  try {
    return stampOf(statSync(path));
  } catch {
    return 'missing';
  }
}

export function readOwnerConfigFile(path: string): OwnerConfigRead {
  let before: Stats;
  try {
    before = statSync(path);
  } catch (error) {
    return (error as { code?: unknown }).code === 'ENOENT' ? { status: 'missing' } : { status: 'refused', reason: 'unreadable', stamp: 'unreadable' };
  }
  const stamp = stampOf(before);
  if (!before.isFile() || (before.mode & 0o022) !== 0 || !ownedByThisUser(before)) {
    return { status: 'refused', reason: 'unsafe_permissions', stamp };
  }
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return { status: 'refused', reason: 'unreadable', stamp };
  }
  let after: Stats;
  try {
    after = statSync(path);
  } catch {
    return { status: 'refused', reason: 'torn_read', stamp };
  }
  if (stampOf(after) !== stamp || Buffer.byteLength(text, 'utf8') !== before.size) {
    return { status: 'refused', reason: 'torn_read', stamp: stampOf(after) };
  }
  return { status: 'ok', text, stamp };
}

function stampOf(stat: Stats): string {
  return `${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
}

function ownedByThisUser(stat: Stats): boolean {
  const uid = typeof process.getuid === 'function' ? process.getuid() : undefined;
  return uid === undefined || stat.uid === uid;
}
