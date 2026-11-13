/** Test-machine diagnostics: read-only queue, names metadata and logs; fresh setup also enables the engine split. */
import { Database } from 'bun:sqlite';
import { closeSync, existsSync, openSync, readFileSync, readSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { sharedDataPath } from '../../src/core/olympus-layout.ts';
import { lifecycleStorePaths } from '../../src/data-lifecycle.ts';
import type { TimingFile } from './on-demand-seeds.ts';

interface LogCursor { path: string; inode: number; bytes: number }
export interface ReadCursor { logs: LogCursor[]; lastRead: number; busy: number }
const logs = (): string[] => {
  const root = process.platform === 'darwin' ? join(homedir(), 'Library/Logs/Olympus') : join(homedir(), '.local/state/olympus/engine');
  return [join(root, 'engine.log'), join(root, 'engine.err')];
};
function queue(path = sharedDataPath('file-extraction-jobs')): Database {
  const db = new Database(path, { readonly: true });
  db.exec('PRAGMA busy_timeout = 10000;');
  return db;
}
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

/** Names and identities only, from the product's store inventory. Never read a body to prepare the benchmark. */
export function resolveTimingFile(file: TimingFile, paths = lifecycleStorePaths()): TimingFile {
  const matches = new Map<string, { provider_item_id: string; source_version: string }>();
  for (const path of paths) {
    if (!existsSync(path)) continue;
    const db = queue(path);
    try {
      const rows = db.query(`SELECT provider_item_id, source_version FROM items
        WHERE provider=? AND title=? AND tombstoned=0`).all(file.source, file.name) as Array<{ provider_item_id: string; source_version: string }>;
      for (const row of rows) matches.set(JSON.stringify(row), row);
    } finally { db.close(); }
  }
  if (matches.size !== 1) throw new Error(`seed metadata missing or ambiguous: ${file.name}`);
  const row = [...matches.values()][0]!;
  if (!row.provider_item_id || !row.source_version) throw new Error(`seed metadata lacks identity/version: ${file.name}`);
  return { ...file, providerItemId: row.provider_item_id, version: row.source_version };
}

/** The CLI supplies the product's installed config path (including receipt-v1); restart uses its lifecycle command. */
export function enableTimingSplit(configPath: string): void {
  const config = JSON.parse(readFileSync(configPath, 'utf8'));
  if (!config || typeof config !== 'object' || Array.isArray(config)) throw new Error('engine config is not an object');
  config.worker = { ...config.worker, engineSplit: true };
  const temporary = `${configPath}.rc-${process.pid}`;
  writeFileSync(temporary, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, configPath);
}

if (import.meta.main) {
  try {
    const input = JSON.parse(await Bun.stdin.text());
    if (input.command === 'enable-split' || input.command === 'preflight') {
      const cli = Bun.spawnSync([join(homedir(), '.local/bin/olympus'), 'engine', 'status']);
      if (cli.exitCode !== 0) throw new Error('engine status failed');
      const status = JSON.parse(cli.stdout.toString());
      if (input.command === 'enable-split') {
        enableTimingSplit(status.config.path);
        const restarted = Bun.spawnSync([join(homedir(), '.local/bin/olympus'), 'engine', 'restart'], { timeout: 180_000 });
        if (restarted.exitCode !== 0) throw new Error('engine restart failed');
        console.log(JSON.stringify({ ok: true }));
        process.exit(0);
      }
      const config = JSON.parse(readFileSync(status.config.path, 'utf8'));
      if (status.ok !== true || status.engine?.state !== 'running' || config.worker?.engineSplit !== true || status.engine?.services?.['olympus-worker']?.state !== 'ok'
        || status.engine?.services?.['olympus-worker-background']?.state !== 'ok') throw new Error('worker.engineSplit must be on, with healthy front and background services');
      console.log(JSON.stringify({ detail: `engine split on; healthy front and background; installed build ${status.engine.build ?? 'unknown'}` }));
    } else if (input.command === 'resolve') console.log(JSON.stringify(resolveTimingFile(input.file)));
    else if (input.command === 'begin') console.log(JSON.stringify(readCursor()));
    else if (input.command === 'finish') console.log(JSON.stringify(finishRead(input.file, input.cursor)));
    else throw new Error('unknown timing diagnostic command');
  } catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exit(1); }
}
