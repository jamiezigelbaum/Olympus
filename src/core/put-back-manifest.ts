import { lstatSync, readdirSync, readFileSync, readlinkSync } from 'node:fs';
import { join, relative } from 'node:path';
import { processesWithFilesUnder, updateRecordPath } from './data-root-snapshot.ts';
import { olympusDataRoot, type LayoutEnv } from './olympus-layout.ts';

/** Bounds, so a large root writes a readable line rather than megabytes into the install log. */
const MAX_FILES = 2_000;
const MAX_TEXT = 20_000;

/**
 * What a put-back works from, written to the install log before and after it puts stores back, so a failed rollback
 * explains itself: every file under the data root (size, mtime, or where a link points), the record of the update in
 * flight, and the processes that hold a file under the root open (as the OS sees them, whatever lock they know).
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
    update: text(updateRecordPath(env)),
    holders: processesWithFilesUnder([root]),
  });
}
