// Reading an owner-edited policy file (the sensitivity map, the tier rules)
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

import { readFileSync, statSync, type Stats } from 'node:fs';

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
