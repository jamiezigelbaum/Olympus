import { spawnSync } from 'node:child_process';
import { lstatSync, readdirSync, readFileSync, readlinkSync } from 'node:fs';
import { join, relative } from 'node:path';
import { olympusDataRoot, sharedDataPath, type LayoutEnv } from './olympus-layout.ts';

/** Bounds, so a large root writes a readable line rather than megabytes into the install log. */
const MAX_FILES = 2_000;
const MAX_TEXT = 20_000;

/**
 * What a put-back works from, written to the install log before and after it puts stores back, so a failed rollback
 * explains itself: every file under the data root (size, mtime, or where a link points), the upgrade mark, the record
 * of copies, and the processes that hold a file under the root open (as the OS sees them, whatever lock they know).
 * Names and sizes only, never contents (step-back, 16 Nov 2026).
 */
export function putBackManifest(env: LayoutEnv, label: string): string {
  const root = olympusDataRoot(env);
  const files: string[] = [];
  let omitted = 0;
  const walk = (directory: string): void => {
    let names: string[];
    try { names = readdirSync(directory); } catch { return; }
    for (const name of names.sort()) {
      const path = join(directory, name);
      let stat;
      try { stat = lstatSync(path); } catch { continue; }
      if (stat.isDirectory()) { if (relative(root, path) !== 'models') walk(path); continue; }
      if (files.length >= MAX_FILES) { omitted += 1; continue; }
      const id = relative(root, path);
      if (stat.isSymbolicLink()) {
        let target = '?';
        try { target = readlinkSync(path); } catch { /* unreadable link */ }
        files.push(`${id} -> ${target}`);
      } else files.push(`${id} ${stat.size} ${new Date(stat.mtimeMs).toISOString()}`);
    }
  };
  walk(root);
  const text = (path: string): string | null => {
    try { return readFileSync(path, 'utf8').slice(0, MAX_TEXT); } catch { return null; }
  };
  return JSON.stringify({
    put_back_manifest: label,
    at: new Date().toISOString(),
    root,
    files,
    ...(omitted > 0 ? { files_omitted: omitted } : {}),
    mark: text(sharedDataPath('upgrade-in-flight', env)),
    copies: text(sharedDataPath('schema-backups', env)),
    holders: openFileHolders(root),
  });
}

/** Processes with a file under `root` open, from the OS: /proc on Linux, lsof on the Mac. */
function openFileHolders(root: string): string[] | string {
  if (process.platform === 'linux') {
    const holders = new Set<string>();
    let pids: string[] = [];
    try { pids = readdirSync('/proc').filter((name) => /^\d+$/.test(name)); } catch { return 'no /proc'; }
    for (const pid of pids) {
      let fds: string[] = [];
      try { fds = readdirSync(`/proc/${pid}/fd`); } catch { continue; }
      for (const fd of fds) {
        let target = '';
        try { target = readlinkSync(`/proc/${pid}/fd/${fd}`); } catch { continue; }
        if (target === root || target.startsWith(`${root}/`)) {
          let command = '';
          try { command = readFileSync(`/proc/${pid}/cmdline`, 'utf8').replaceAll('\0', ' ').trim().slice(0, 200); } catch { /* gone */ }
          holders.add(`${pid} ${command} ${relative(root, target)}`);
        }
      }
    }
    return [...holders].slice(0, 200);
  }
  const lsof = spawnSync('lsof', ['-n', '-F', 'pcn', '+D', root], { encoding: 'utf8', timeout: 15_000 });
  if (lsof.error) return `lsof failed: ${lsof.error.message}`;
  const lines: string[] = [];
  let pid = '';
  let command = '';
  for (const line of (lsof.stdout ?? '').split('\n')) {
    if (line.startsWith('p')) pid = line.slice(1);
    else if (line.startsWith('c')) command = line.slice(1);
    else if (line.startsWith('n')) lines.push(`${pid} ${command} ${relative(root, line.slice(1))}`);
  }
  return lines.slice(0, 200);
}
