import { appendFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export type AskBenchSqlSample = { read_bytes: number; majflt: number };
export type AskBenchSqlRow = AskBenchSqlSample & {
  at: number;
  db_path: string;
  site: string;
  count: number;
  ms: number;
};
export type AskBenchSqlThread = { tid: string; db_path?: string };

// Loaded only by the gated Ask benchmark. Each thread writes its own stream, so
// a stalled engine loop or a lost pool reply cannot hold back a worker's samples.
export function createAskBenchSqlRecorder(dir: string, dbPath?: string) {
  let file: string | undefined;
  const rows = new Map<string, AskBenchSqlRow>();
  const fail = (error: unknown) => {
    console.error('[ask-bench] SQL disk sampling stopped on this thread:', error);
    file = undefined;
  };
  try {
    const tid = readFileSync('/proc/thread-self/stat', 'utf8').split(' ', 1)[0]!;
    file = join(dir, `${process.pid}.${tid}.sql.jsonl`);
    const thread: AskBenchSqlThread = dbPath === undefined ? { tid } : { tid, db_path: dbPath };
    appendFileSync(file, JSON.stringify(thread) + '\n');
  } catch (error) {
    fail(error);
  }

  function sample(): AskBenchSqlSample | undefined {
    if (!file) return undefined;
    try {
      const io = readFileSync('/proc/thread-self/io', 'utf8');
      const stat = readFileSync('/proc/thread-self/stat', 'utf8');
      const read_bytes = Number(/^read_bytes: (\d+)$/m.exec(io)?.[1]);
      // After the parenthesized comm, state is field 3 and majflt is field 12.
      const majflt = Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[9]);
      if (!Number.isFinite(read_bytes) || !Number.isFinite(majflt)) throw new Error('Missing read_bytes or majflt in procfs.');
      return { read_bytes, majflt };
    } catch (error) {
      fail(error);
      return undefined;
    }
  }

  function flush(): void {
    if (file) {
      try {
        appendFileSync(file, [...rows.values()].map(row => JSON.stringify(row) + '\n').join(''));
      } catch (error) {
        fail(error);
      }
    }
    rows.clear();
  }

  function record(before: AskBenchSqlSample | undefined, ms: number, path: string, getSite: string | (() => string), count = 1): void {
    if (!before) return;
    const after = sample();
    if (!after) return;
    const at = Date.now();
    const site = typeof getSite === 'string' ? getSite : getSite();
    const key = JSON.stringify([at, path, site]);
    if (rows.size === 0) queueMicrotask(flush);
    const row = rows.get(key) ?? { at, db_path: path, site, count: 0, ms: 0, read_bytes: 0, majflt: 0 };
    row.count += count;
    row.ms += ms;
    row.read_bytes += after.read_bytes - before.read_bytes;
    row.majflt += after.majflt - before.majflt;
    rows.set(key, row);
  }
  return { sample, record };
}
