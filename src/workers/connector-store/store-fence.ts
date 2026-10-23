/**
 * A cross-process fence for a connector store file, for the one reader that is
 * not the worker: the supervised embedding drain in direct mode, a separate
 * process that caches open stores. Two sidecar files sit beside the store:
 *
 *   <store>.fence          raised by Delete indexed data, lifted when it is done
 *   <store>.holder-<pid>   written by a process while it holds the store open
 *
 * The delete raises the fence, then waits until no live process holds the
 * store. A holder sees the fence, closes the store, removes its mark, and does
 * not reopen it while the fence stands. A mark whose process is gone is stale
 * and ignored. Nothing here needs the supervisor: liveness is the pid.
 */
import { closeSync, existsSync, openSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

const HOLDER_INFIX = '.holder-';

export const storeFencePath = (dbPath: string): string => `${dbPath}.fence`;
export const storeHolderPath = (dbPath: string, pid = process.pid): string => `${dbPath}${HOLDER_INFIX}${pid}`;

export function raiseStoreFence(dbPath: string): void {
  writeFileSync(storeFencePath(dbPath), `${JSON.stringify({ pid: process.pid, raised_at: new Date().toISOString() })}\n`, { mode: 0o600 });
}

export function liftStoreFence(dbPath: string): void {
  rmSync(storeFencePath(dbPath), { force: true });
}

export function isStoreFenced(dbPath: string): boolean {
  return existsSync(storeFencePath(dbPath));
}

/** Mark this process as holding the store open. */
export function markStoreHeld(dbPath: string): void {
  closeSync(openSync(storeHolderPath(dbPath), 'w', 0o600));
}

export function releaseStoreHeld(dbPath: string): void {
  rmSync(storeHolderPath(dbPath), { force: true });
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Pids of other live processes that hold the store open; stale marks are removed. */
export function liveStoreHolders(dbPath: string): number[] {
  const dir = dirname(dbPath);
  const prefix = `${basename(dbPath)}${HOLDER_INFIX}`;
  let names: string[];
  try {
    names = readdirSync(dir).filter((name) => name.startsWith(prefix));
  } catch {
    return [];
  }
  const pids: number[] = [];
  for (const name of names) {
    const pid = Number(name.slice(prefix.length));
    if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) continue;
    if (alive(pid)) pids.push(pid);
    else rmSync(join(dir, name), { force: true });
  }
  return pids;
}

/** Resolves true once no other live process holds any of the stores, false at the timeout. */
export async function waitForStoreHoldersGone(dbPaths: readonly string[], timeoutMs: number): Promise<boolean> {
  const until = Date.now() + timeoutMs;
  for (;;) {
    if (dbPaths.every((path) => liveStoreHolders(path).length === 0)) return true;
    if (Date.now() >= until) return false;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}
