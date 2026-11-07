// Standalone diagnostic: never construct a worker, model, lease, or writable store.
import type { Database } from 'bun:sqlite';
import { copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { olympusDataRoot } from '../../core/olympus-layout.ts';
import { createStorageSnapshotReaders } from '../../core/source-storage.ts';
import type { LocalConnectorStore } from '../connector-store/local-index.ts';
import { prefilterTrainingCopy } from './embedding-prefilter.ts';
import { countPrefilterTraining, type PrefilterTrainingCounts } from './prefilter-training-counts.ts';
import type { TierLedger } from './tier-ledger.ts';
import type { TierSnifferStore } from './sniffer-store.ts';
import { tierLedgerPathForStore, tierSnifferPathForLedger } from './tier-ledger-path.ts';
import { tierSetLedgerCandidates } from './tier-set-binding.ts';

/** Counts only; ledger array positions replace all account names, paths and identifiers. */
export interface PrefilterDryRunReport {
  ledgers: PrefilterTrainingCounts[];
  errors: number;
  error_reasons: Record<DryRunError, number>;
  snapshot_retries: number;
}

const ERROR_REASONS = ['snapshot_busy', 'snapshot_unsafe', 'snapshot_io', 'database_open',
  'ledger_open', 'store_open', 'sniffer_open', 'training_judge', 'arguments_or_install'] as const;
type DryRunError = typeof ERROR_REASONS[number];
function emptyReport(): PrefilterDryRunReport {
  return { ledgers: [], errors: 0, error_reasons: Object.fromEntries(ERROR_REASONS.map(reason => [reason, 0])) as Record<DryRunError, number>, snapshot_retries: 0 };
}
function reportError(report: PrefilterDryRunReport, reason: DryRunError): void {
  report.errors++;
  report.error_reasons[reason]++;
}
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
export function snapshotPrefilterDatabase(path: string, destination: string, retry: () => void,
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

function* databaseFiles(root: string): Generator<string> {
  for (const entry of readdirSync(root, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) yield* databaseFiles(path);
    else if (entry.isFile() && entry.name.endsWith('.sqlite')) yield path;
  }
}

interface Inspected {
  original: string;
  snapshot: string;
  kind: 'ledger' | 'store' | 'sniffer';
  ledgerId?: string;
  corpusId?: string;
}

/** No exception or database field is sent to stdout/stderr by this entry point. */
export function runPrefilterTrainingDryRun(options: { dataDir?: string; rowLimit?: number;
  inspect?: (context: { judge: string; revisions: string; members: Array<Parameters<typeof countPrefilterTraining>[0]> }) => void;
} = {}): PrefilterDryRunReport {
  if (options.rowLimit !== undefined && (!Number.isSafeInteger(options.rowLimit) || options.rowLimit < 1)) throw new Error('Invalid row limit');
  const root = resolve(options.dataDir ?? olympusDataRoot());
  if (!lstatSync(root).isDirectory() || lstatSync(root).isSymbolicLink()) throw new Error('Invalid data directory');
  const readers = createStorageSnapshotReaders();
  const scratch = readers.directory;
  const opened: Array<{ close(): void }> = [];
  const report = emptyReport();
  try {
    const inspected: Inspected[] = [];
    for (const original of databaseFiles(root)) {
      const dir = join(scratch, String(inspected.length));
      mkdirSync(dir, { mode: 0o700 });
      const target = join(dir, 'snapshot.sqlite');
      let db: Database | undefined;
      try {
        snapshotPrefilterDatabase(original, target, () => { report.snapshot_retries++; });
        db = readers.database(target);
        const tables = new Set((db.query("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map(row => row.name));
        if (tables.has('tier_items') && tables.has('tier_ledger_meta')) {
          const id = db.query("SELECT value FROM tier_ledger_meta WHERE key = 'ledger_id'").get() as { value: string } | null;
          inspected.push({ original, snapshot: target, kind: 'ledger', ...(id ? { ledgerId: id.value } : {}) });
        } else if (tables.has('sniffer_verdicts')) {
          inspected.push({ original, snapshot: target, kind: 'sniffer' });
        } else if (tables.has('items') && tables.has('chunks') && tables.has('sync_runs')) {
          const corpus = db.query('SELECT corpus_id FROM sync_runs LIMIT 1').get() as { corpus_id: string } | null;
          inspected.push({ original, snapshot: target, kind: 'store', ...(corpus ? { corpusId: corpus.corpus_id } : {}) });
        }
      } catch (error) { reportError(report, error instanceof SnapshotError ? error.reason : 'database_open'); }
      finally { db?.close(); }
      // Unrelated files must not collide with the next snapshot directory.
      if (!inspected.some(entry => entry.snapshot === target)) rmSync(dir, { recursive: true, force: true });
    }
    const ledgers = new Map<string, TierLedger>();
    for (const file of inspected.filter(file => file.kind === 'ledger')) {
      try {
        const ledger = readers.ledger(file.snapshot);
        opened.push(ledger);
        ledgers.set(file.original, ledger);
      } catch { reportError(report, 'ledger_open'); }
    }
    const sniffers = new Map<string, TierSnifferStore>();
    for (const file of inspected.filter(file => file.kind === 'sniffer')) {
      try {
        const store = readers.sniffer(file.snapshot);
        opened.push(store);
        sniffers.set(file.original, store);
      } catch { reportError(report, 'sniffer_open'); }
    }
    const stores: Array<{ store: LocalConnectorStore; ledgerPath: string | undefined; bound: boolean }> = [];
    for (const file of inspected.filter(file => file.kind === 'store')) {
      try {
        const store = readers.store(file.snapshot, file.corpusId ?? 'diagnostic');
        opened.push(store);
        const binding = store.tierSetBinding();
        const ledgerPath = binding
          ? tierSetLedgerCandidates(file.original, binding.ledgerPath).find(candidate =>
            inspected.some(entry => entry.original === candidate && entry.ledgerId === binding.ledgerId))
          : tierLedgerPathForStore(file.original);
        stores.push({ store, ledgerPath, bound: !!binding });
      } catch { reportError(report, 'store_open'); }
    }
    // The active attempt records the exact judge identity (including decision mode/owner prompt).
    // Do not infer a judge from individual row labels, which would hide provenance failures.
    const judges = new Set<string>();
    const installState = [...ledgers].filter(([path]) => path.endsWith('.embedding-prefilter.tier-ledger.sqlite'));
    const trainingOwners = installState.length ? installState.map(([, ledger]) => ledger) : [...ledgers.values()];
    for (const ledger of trainingOwners) {
      const raw = ledger.readMeta('embedding-prefilter:training-v1');
      try {
        if (raw) {
          const value = JSON.parse(raw) as { judge?: unknown };
          if (typeof value.judge === 'string' && value.judge) judges.add(value.judge);
        }
      } catch { reportError(report, 'training_judge'); return report; }
    }
    if (judges.size !== 1) { reportError(report, 'training_judge'); return report; }
    const judge = [...judges][0]!;
    const inputs: Array<Parameters<typeof countPrefilterTraining>[0]> = [];
    for (const [path, ledger] of ledgers) {
      // Match the service roster: existing co-located or bound source ledgers only.
      const members = stores.filter(member => member.ledgerPath === path);
      const own = inspected.some(file => file.kind === 'store' && tierLedgerPathForStore(file.original) === path);
      if (!members.length && !own) continue;
      const bound = members.some(member => member.bound);
      const sniffer = sniffers.get(tierSnifferPathForLedger(path));
      inputs.push({ ledger, judge, ...(sniffer ? { sniffer } : {}), ...(options.rowLimit ? { rowLimit: options.rowLimit } : {}),
        copyFor: subject => prefilterTrainingCopy(subject, ledger, bound ? corpusId =>
          members.find(member => member.store.corpusId === corpusId)?.store.exportItemCopy(subject) : undefined,
        () => {
          for (const member of members) {
            const copy = member.store.exportItemCopy(subject);
            if (copy) return copy;
          }
          return undefined;
        }),
      });
    }
    if (!report.errors) {
      if (options.inspect) options.inspect({ judge, members: inputs,
        revisions: JSON.stringify(inputs.map(({ ledger }) => {
          const member = ledger as TierLedger;
          return [member.ledgerId(), member.readMeta('embedding-prefilter:training-revision') ?? '0'];
        }).sort()) + ':' + (trainingOwners[0]?.readMeta('embedding-prefilter:withdrawal') ?? '0') });
      else report.ledgers = inputs.map(input => countPrefilterTraining(input));
    }
    return report;
  } finally {
    try { for (const handle of opened.reverse()) handle.close(); }
    finally { rmSync(scratch, { recursive: true, force: true }); }
  }
}

export function prefilterTrainingDryRunMain(args: readonly string[]): number {
  try {
    let dataDir: string | undefined;
    let rowLimit: number | undefined;
    for (let index = 0; index < args.length; index++) {
      const flag = args[index];
      const value = args[++index];
      if (!value || value.startsWith('--')) throw new Error('Invalid arguments');
      if (flag === '--data-dir' && dataDir === undefined) dataDir = value;
      else if (flag === '--row-limit' && rowLimit === undefined && /^[1-9][0-9]*$/.test(value)) rowLimit = Number(value);
      else throw new Error('Invalid arguments');
    }
    const report = runPrefilterTrainingDryRun({ ...(dataDir ? { dataDir } : {}), ...(rowLimit ? { rowLimit } : {}) });
    console.log(JSON.stringify(report));
    return report.errors ? 1 : 0;
  } catch {
    const report = emptyReport();
    reportError(report, 'arguments_or_install');
    console.log(JSON.stringify(report));
    return 1;
  }
}
