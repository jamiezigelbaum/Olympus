import { chmodSync, lstatSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import {
  assertManagedPathParentsSync,
  ensurePrivateDirectoryTreeSync,
  removeFileDurablySync,
  writePrivateFileAtomicSync,
} from './atomic-file.ts';

export const WORKER_CLI_LAUNCHER_MARKER = '# Olympus OpenClaw CLI launcher v1';

export function workerCliLauncherPath(homeDir: string): string {
  return join(homeDir, '.local', 'bin', 'olympus');
}

/** undefined = absent; null = a launcher owned by the user or another installer. */
export function readWorkerCliLauncher(homeDir: string): string | null | undefined {
  const path = workerCliLauncherPath(homeDir);
  assertManagedPathParentsSync(homeDir, path, 'CLI launcher');
  let stat: ReturnType<typeof lstatSync>;
  try {
    stat = lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
  if (!stat.isFile() || (process.getuid && stat.uid !== process.getuid())) return null;
  const text = readFileSync(path, 'utf8');
  return text.split('\n')[1] === WORKER_CLI_LAUNCHER_MARKER ? text : null;
}

export function quoteCliArgument(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

export function renderWorkerCliLauncher(runtime: string, cli: string, workingDirectory = dirname(dirname(cli))): string {
  for (const path of [runtime, cli, workingDirectory]) {
    if (!isAbsolute(path) || /[\0\r\n]/.test(path)) throw new Error('CLI launcher requires absolute paths without control characters.');
  }
  return `#!/bin/sh\n${WORKER_CLI_LAUNCHER_MARKER}\ncd ${quoteCliArgument(workingDirectory)} || exit 78\nexec ${quoteCliArgument(runtime)} ${quoteCliArgument(cli)} "$@"\n`;
}

export function writeWorkerCliLauncher(homeDir: string, text: string): boolean {
  const previous = readWorkerCliLauncher(homeDir);
  if (previous === null) return false;
  const path = workerCliLauncherPath(homeDir);
  if (previous === text && (lstatSync(path).mode & 0o777) === 0o700) return false;
  ensurePrivateDirectoryTreeSync(homeDir, dirname(path));
  writePrivateFileAtomicSync(path, text);
  chmodSync(path, 0o700);
  return true;
}

/** Rollback never replaces a launcher the owner has taken over meanwhile. */
export function restoreWorkerCliLauncher(homeDir: string, previous: string | undefined): void {
  if (readWorkerCliLauncher(homeDir) === null) return;
  if (previous === undefined) removeFileDurablySync(workerCliLauncherPath(homeDir));
  else writeWorkerCliLauncher(homeDir, previous);
}
