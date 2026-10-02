/**
 * Where a Dropbox file opens: its Dropbox web preview, and its copy in the
 * Dropbox folder on this computer when one is synced here. The private
 * answer panel lists a private answer's sources with these (see
 * docs/design/chatgpt-plugin.md, "Private answer panel"): the web address
 * goes into the sealed answer; the local path never leaves this computer (the
 * panel gets a one-time token that opens it, private-answer-jobs.ts).
 *
 * The Dropbox folder is found the way Dropbox itself records it:
 * `~/.dropbox/info.json` (each account's `path`), then the macOS File
 * Provider location `~/Library/CloudStorage/Dropbox*`, then `~/Dropbox`, after
 * any root the owner configured (DROPBOX_LOCAL_ROOT and friends). A local
 * path is offered only for an existing regular file that resolves inside one
 * of those roots.
 */
import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, sep } from 'node:path';
import { parseDropboxLocalFileRootsFromEnv } from './local-file-resolver.ts';

export interface DropboxOpenTarget {
  /** https://www.dropbox.com/home<folder>?preview=<name> */
  url: string;
  /** The synced copy on this computer, when there is one. */
  localPath?: string;
}

export interface DropboxOpenTargetOptions {
  env?: Record<string, string | undefined>;
  home?: string;
  /** Rediscover the Dropbox folder after this long (it can move or appear). */
  rootsTtlMs?: number;
  now?: () => number;
}

/** The Dropbox web preview of a file at a Dropbox display path ("/Folder/name.pdf"). */
export function dropboxPreviewUrl(displayPath: string): string | undefined {
  const segments = dropboxSegments(displayPath);
  if (!segments || segments.length === 0) return undefined;
  const name = segments[segments.length - 1]!;
  const folder = segments.slice(0, -1).map((segment) => `/${encodeURIComponent(segment)}`).join('');
  return `https://www.dropbox.com/home${folder}?preview=${encodeURIComponent(name)}`;
}

/** The Dropbox folders on this computer, most specific first, each resolved and existing. */
export function localDropboxRoots(options: Pick<DropboxOpenTargetOptions, 'env' | 'home'> = {}): string[] {
  const env = options.env ?? process.env;
  const home = options.home ?? homedir();
  const candidates: string[] = [];
  for (const name of ['OLYMPUS_SOURCE_INDEX_DROPBOX_LOCATOR_LOCAL_ROOT', 'DROPBOX_LOCAL_ROOT']) {
    const value = env[name]?.trim();
    if (value) candidates.push(value);
  }
  try {
    for (const root of parseDropboxLocalFileRootsFromEnv(env)) {
      // A root that maps only part of Dropbox cannot place an arbitrary path.
      if (!root.dropboxPathPrefix) candidates.push(root.rootPath);
    }
  } catch {
    // A malformed configured root list adds nothing here.
  }
  try {
    const info = JSON.parse(readFileSync(join(home, '.dropbox', 'info.json'), 'utf8')) as unknown;
    if (info && typeof info === 'object') {
      for (const account of Object.values(info as Record<string, unknown>)) {
        const path = account && typeof account === 'object' ? (account as Record<string, unknown>).path : undefined;
        if (typeof path === 'string' && path.trim()) candidates.push(path.trim());
      }
    }
  } catch {
    // No Dropbox desktop app record.
  }
  try {
    const cloud = join(home, 'Library', 'CloudStorage');
    for (const entry of readdirSync(cloud).sort()) {
      if (/^Dropbox/.test(entry)) candidates.push(join(cloud, entry));
    }
  } catch {
    // No File Provider folders.
  }
  candidates.push(join(home, 'Dropbox'));
  const roots: string[] = [];
  for (const candidate of candidates) {
    try {
      const real = realpathSync.native(candidate);
      if (statSync(real).isDirectory() && !roots.includes(real)) roots.push(real);
    } catch {
      // Not there.
    }
  }
  return roots;
}

/**
 * Resolves a Dropbox display path to its open target. The local path is
 * checked on every call (a file can be synced or removed at any time); the
 * roots are rediscovered after `rootsTtlMs`.
 */
export function createDropboxOpenTargets(options: DropboxOpenTargetOptions = {}): (displayPath: string) => DropboxOpenTarget | undefined {
  const now = options.now ?? Date.now;
  const ttl = options.rootsTtlMs ?? 5 * 60_000;
  let roots: string[] | undefined;
  let foundAt = 0;
  return (displayPath) => {
    const url = dropboxPreviewUrl(displayPath);
    if (!url) return undefined;
    if (!roots || now() - foundAt > ttl) {
      roots = localDropboxRoots(options);
      foundAt = now();
    }
    const segments = dropboxSegments(displayPath)!;
    for (const root of roots) {
      const localPath = localFileUnder(root, segments);
      if (localPath) return { url, localPath };
    }
    return { url };
  };
}

function localFileUnder(root: string, segments: readonly string[]): string | undefined {
  const path = join(root, ...segments);
  try {
    if (!existsSync(path)) return undefined;
    const real = realpathSync.native(path);
    // Never a file outside the Dropbox folder (a symlink out of it).
    if (!real.startsWith(root.endsWith(sep) ? root : `${root}${sep}`)) return undefined;
    return statSync(real).isFile() ? real : undefined;
  } catch {
    return undefined;
  }
}

/** A rooted Dropbox display path's segments; undefined when it is not one, or names a parent or current folder. */
function dropboxSegments(displayPath: string): string[] | undefined {
  const trimmed = displayPath.trim();
  if (!trimmed.startsWith('/') || trimmed.includes('\0') || trimmed.includes('\\')) return undefined;
  const segments = trimmed.split('/').filter((segment) => segment.length > 0);
  if (segments.some((segment) => segment === '.' || segment === '..')) return undefined;
  return segments;
}
