/**
 * Who could have an Olympus store open right now, found in the process table.
 *
 * Delete indexed data removes store files, which is safe only while nothing
 * holds them. Several different supervisors start store-opening processes: the
 * standalone engine host (worker and embedding drain as children), the
 * OpenClaw Gateway (which registers the worker and the drain as services of
 * its own), a worker started by hand in a terminal, a drain started by hand or
 * by a private-host unit. A stopped engine or worker unit proves none of the
 * others. This lists every such process, so the CLI and the engine host can
 * require an empty list and so hold the line whatever started the holder.
 *
 * `ok: false` means the process table could not be read: that is "cannot
 * prove", never "nobody".
 */
import { listProcessTable, type ProcessTableEntry } from './engine-children.ts';

export type StoreHolderKind = 'engine' | 'gateway' | 'worker' | 'drain';

export interface StoreHolder {
  pid: number;
  kind: StoreHolderKind;
}

const PATTERNS: Array<{ kind: StoreHolderKind; test: RegExp }> = [
  { kind: 'engine', test: /(^|[\s/])__engine-run(\s|$)/ },
  { kind: 'worker', test: /(^|[\s/])__worker-service-run(\s|$)/ },
  { kind: 'worker', test: /(^|[\s/])cli\.(js|ts)\s+worker\s+run(\s|$)/ },
  { kind: 'worker', test: /workers\/email-source\/server\.ts/ },
  { kind: 'drain', test: /(^|[\s/])(embedding-drain\.js|source-embedding-drain\.ts)(\s|$)/ },
  // The Gateway's process title, or `openclaw gateway` started to serve
  // (status, restart, stop and the other subcommands hold nothing).
  { kind: 'gateway', test: /(^|[\s/])openclaw-gateway(\s|$)/ },
  { kind: 'gateway', test: /(^|[\s/])openclaw(\.mjs)?\s+gateway(\s+(run|start|--[\w-]+(=\S+)?))*\s*$/ },
];

export function findStoreHolders(input: {
  listProcesses?: () => ProcessTableEntry[] | undefined;
  /** Processes that are the caller itself and never count. */
  ignorePids?: readonly number[];
} = {}): { ok: true; holders: StoreHolder[] } | { ok: false } {
  const table = (input.listProcesses ?? listProcessTable)();
  if (!table) return { ok: false };
  const ignore = new Set([process.pid, ...(input.ignorePids ?? [])]);
  const holders: StoreHolder[] = [];
  for (const entry of table) {
    if (ignore.has(entry.pid)) continue;
    const match = PATTERNS.find((pattern) => pattern.test.test(entry.command));
    if (match) holders.push({ pid: entry.pid, kind: match.kind });
  }
  return { ok: true, holders };
}

/** True only when the process table was read and shows no holder. */
export function storeHoldersVerifiedReleased(input: Parameters<typeof findStoreHolders>[0] = {}): boolean {
  const found = findStoreHolders(input);
  return found.ok && found.holders.length === 0;
}
