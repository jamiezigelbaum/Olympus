import { copyFileSync, existsSync, lstatSync, rmSync, statSync } from 'node:fs';

class SnapshotError extends Error {
  constructor(readonly reason: 'snapshot_busy' | 'snapshot_unsafe' | 'snapshot_io') { super(reason); }
}

function stamp(path: string): string {
  if (!existsSync(path)) return 'absent';
  const s = statSync(path, { bigint: true });
  return `${s.dev}:${s.ino}:${s.size}:${s.mtimeNs}:${s.ctimeNs}`;
}

/** No SQLite handle ever opens an install file: even a read-only WAL open can write -shm.
 * Copy main + WAL into a 0700 scratch directory, rejecting an overlapping writer/checkpoint.
 * SQLite opens only the snapshots readonly; any shared-memory sidecars stay in scratch.
 * No SQL writes or checkpoints run. All private scratch bytes are removed in finally, including failures.
 */
function snapshot(path: string, destination: string, copy: typeof copyFileSync): void {
  const sources = [path, `${path}-wal`];
  const before = sources.map(stamp);
  for (let index = 0; index < sources.length; index++) {
    const source = sources[index]!;
    if (before[index] === 'absent') continue;
    if (!lstatSync(source).isFile() || lstatSync(source).isSymbolicLink()) throw new SnapshotError('snapshot_unsafe');
    copy(source, `${destination}${index ? '-wal' : ''}`);
  }
  if (sources.some((source, index) => stamp(source) !== before[index])) throw new SnapshotError('snapshot_busy');
}

/** Four attempts only for overlapping writes; each starts with no stale WAL/SHM bytes. */
export function snapshotDatabase(path: string, destination: string, retry: () => void,
  copy: typeof copyFileSync = copyFileSync): void {
  for (let attempt = 0; attempt < 4; attempt++) {
    for (const suffix of ['', '-wal', '-shm']) rmSync(`${destination}${suffix}`, { force: true });
    try { snapshot(path, destination, copy); return; }
    catch (error) {
      const reason = error instanceof SnapshotError ? error.reason
        : (error as NodeJS.ErrnoException)?.code === 'ENOENT' ? 'snapshot_busy' : 'snapshot_io';
      if (reason !== 'snapshot_busy' || attempt === 3) throw new SnapshotError(reason);
      retry();
      Bun.sleepSync(25 * (attempt + 1));
    }
  }
}

