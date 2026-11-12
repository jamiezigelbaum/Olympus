/** Bundled for the test machine. Reads the durable queue and bounded log slices; never writes engine state. */
import { Database } from 'bun:sqlite';
import { closeSync, openSync, readFileSync, readSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { sharedDataPath } from '../../src/core/olympus-layout.ts';
import type { TimingFile } from './on-demand-seeds.ts';

interface LogCursor { path: string; inode: number; bytes: number }
export interface ReadCursor { logs: LogCursor[]; lastRead: number; busy: number }
const logs = (): string[] => {
  const root = process.platform === 'darwin' ? join(homedir(), 'Library/Logs/Olympus') : join(homedir(), '.local/state/olympus/engine');
  return [join(root, 'engine.log'), join(root, 'engine.err')];
};
function queue(path = sharedDataPath('file-extraction-jobs')): Database { return new Database(path, { readonly: true }); }
export function readCursor(options: { dbPath?: string; logPaths?: string[] } = {}): ReadCursor {
  const db = queue(options.dbPath);
  try {
    return { logs: (options.logPaths ?? logs()).map(path => { const s = statSync(path); return { path, inode: s.ino, bytes: s.size }; }),
      lastRead: (db.query('SELECT COALESCE(MAX(rowid),0) AS n FROM on_demand_reads').get() as { n: number }).n,
      busy: (db.query("SELECT COUNT(*) AS n FROM on_demand_reads r JOIN extraction_jobs j ON j.job_id=r.job_id WHERE j.status IN ('queued','leased','failed_retryable')").get() as { n: number }).n };
  } finally { db.close(); }
}
export function finishRead(file: TimingFile, cursor: ReadCursor, dbPath?: string) {
  const db = queue(dbPath);
  try {
    const jobs = db.query(`SELECT j.job_id, j.status FROM on_demand_reads r JOIN extraction_jobs j ON j.job_id=r.job_id
      WHERE r.provider_item_id=? AND j.source_version=?`).all(file.providerItemId, file.version) as Array<{ job_id: string; status: string }>;
    const all = db.query('SELECT job_id FROM on_demand_reads WHERE rowid>?').all(cursor.lastRead) as Array<{ job_id: string }>;
    let rotated = false;
    const lines: string[] = [];
    for (const log of cursor.logs) {
      const s = statSync(log.path);
      if (s.ino !== log.inode || s.size < log.bytes) { rotated = true; continue; }
      const length = s.size - log.bytes;
      if (length > 8 * 1024 * 1024) { rotated = true; continue; }
      const fd = openSync(log.path, 'r');
      try {
        const bytes = Buffer.alloc(length);
        readSync(fd, bytes, 0, length, log.bytes);
        lines.push(...bytes.toString('utf8').split('\n').filter(line => line.includes('[olympus:on-demand] step=')));
      } finally { closeSync(fd); }
    }
    const own = new Set(jobs.map(j => j.job_id));
    const unambiguousSteps = ['fetch', 'extract', 'embed'].every(step => lines.filter(line => line.includes(`step=${step} `)).length <= 1);
    const single = !rotated && cursor.busy === 0 && jobs.length === 1 && all.length === 1 && all.every(j => own.has(j.job_id))
      && unambiguousSteps && lines.every(line => /count=1\b/.test(line));
    return { indexed: jobs.some(j => j.status === 'indexed'), jobIds: [...own], log: lines.join('\n'),
      attribution: rotated ? 'log rotated or interval exceeded 8 MiB; timings incomplete' : single ? 'single read in log interval' : 'ambiguous: concurrent, reused, missing or batched reads' };
  } finally { db.close(); }
}

if (import.meta.main) {
  try {
    const input = JSON.parse(await Bun.stdin.text());
    if (input.command === 'preflight') {
      const cli = Bun.spawnSync([join(homedir(), '.local/bin/olympus'), 'engine', 'status']);
      if (cli.exitCode !== 0) throw new Error('engine status failed');
      const status = JSON.parse(cli.stdout.toString());
      const config = JSON.parse(readFileSync(status.config.path, 'utf8'));
      if (status.ok !== true || status.engine?.state !== 'running' || config.worker?.engineSplit !== true || status.engine?.services?.['olympus-worker']?.state !== 'ok'
        || status.engine?.services?.['olympus-worker-background']?.state !== 'ok') throw new Error('worker.engineSplit must be on, with healthy front and background services');
      console.log(JSON.stringify({ detail: `engine split on; healthy front and background; installed build ${status.engine.build ?? 'unknown'}` }));
    } else if (input.command === 'begin') console.log(JSON.stringify(readCursor()));
    else if (input.command === 'finish') console.log(JSON.stringify(finishRead(input.file, input.cursor)));
    else throw new Error('unknown timing diagnostic command');
  } catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exit(1); }
}
