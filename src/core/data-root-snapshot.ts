/**
 * The data root as it was before an update, whole (put-back step-back, 16 Nov 2026).
 *
 * With the engine stopped and its locks held, and once the OS shows no process with a file under the root open, the
 * update clones the whole data root beside itself (`<root>.before-update`), and each folder outside it that holds stores
 * the engine opens: a legacy capture folder, or a folder a link in the root points to. A failed update renames the
 * failed root aside (`<root>.failed-update-<ms>`) and renames the clone back, so the previous version starts on exactly
 * the files it left: every store, ledger and JSON status, whatever the new version made, migrated or rewrote. The failed
 * root is kept until the next committed update, since it holds whatever was imported while the update ran. A committed
 * update removes the clone and any failed root an earlier update left, and says so.
 *
 * The clone is APFS clonefile on the Mac and a reflink where the Linux disk has them (btrfs, XFS): instant, and no room
 * used until either side changes. On ext4 it is a real copy, after a check that the disk has room for it; with too
 * little room the update stops before anything changed and says how much it needs. Model files are not cloned: they
 * stay with whichever root is live.
 *
 * The record of the update in flight, and of failed roots kept, is beside the root (`<root>.update.json`), so no swap
 * moves it.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, realpathSync, renameSync, rmSync, statfsSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { removeFileDurablySync, syncDirectorySync, writePrivateFileAtomicSync } from './atomic-file.ts';
import { engineChildrenPath, reapRecordedEngineChildren } from './engine-children.ts';
import { legacyCaptureDataRoot, legacyTelegramStoreRoot, legacyWhatsAppLiveSyncStateDir, legacyWhatsAppServiceStateDir, olympusDataRoot, sharedDataPath, type LayoutEnv } from './olympus-layout.ts';
import { OperationError } from './operation-error.ts';

const RECORD_SCHEMA = 'olympus.update-snapshot.v1';
/** Room kept free on the disk beyond a real copy: a share of it, and a floor. */
const SPACE_MARGIN_SHARE = 0.05;
const SPACE_MARGIN_BYTES = 64 * 1024 ** 2;
/** Top-level folders of the root that are not cloned: they stay with the live root. */
const NOT_CLONED = new Set(['models', 'backup-staging']);
/** How long the proof that no process has a file open waits for a reader that opens one for a moment. */
const HOLDER_PROOF_MS = 5_000;

interface SnapshotPair { live: string; snapshot: string }
interface FailedRoot { live: string; failed: string; at: string }
interface UpdateRecord {
  schema: typeof RECORD_SCHEMA;
  in_flight?: { started_at: string; roots: SnapshotPair[] };
  failed: FailedRoot[];
}

export interface DataRootDeps {
  /** Processes other than this one with a file under one of `roots` open; defaults to the OS (/proc, lsof). */
  holders?: (roots: string[]) => string[] | string;
  freeBytes?: (directory: string) => number;
  /** Whether `directory`'s disk clones files without copying them. */
  clones?: (directory: string) => boolean;
  sleep?: (ms: number) => void;
}

/** `<root>.update.json`: the update in flight and the failed roots kept, beside the root. */
export function updateRecordPath(env: LayoutEnv): string {
  return `${olympusDataRoot(env)}.update.json`;
}

export function snapshotPathOf(live: string): string {
  return `${live}.before-update`;
}

export function failedRootPathOf(live: string, startedMs: number): string {
  return `${live}.failed-update-${startedMs}`;
}

function readRecord(env: LayoutEnv): UpdateRecord {
  let parsed: Partial<UpdateRecord>;
  try {
    parsed = JSON.parse(readFileSync(updateRecordPath(env), 'utf8')) as Partial<UpdateRecord>;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { schema: RECORD_SCHEMA, failed: [] };
    throw new OperationError('config_error', `The record of the update in flight (${updateRecordPath(env)}) cannot be read, so nothing was put back.`, 'Look at that file, then run the installer again.');
  }
  return { schema: RECORD_SCHEMA, ...(parsed.in_flight ? { in_flight: parsed.in_flight } : {}), failed: Array.isArray(parsed.failed) ? parsed.failed : [] };
}

function writeRecord(env: LayoutEnv, record: UpdateRecord): void {
  const path = updateRecordPath(env);
  if (!record.in_flight && record.failed.length === 0) { removeFileDurablySync(path); return; }
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writePrivateFileAtomicSync(path, `${JSON.stringify(record)}\n`);
}

/** When the update in flight started, or undefined when none is. */
export function updateInFlightSince(env: LayoutEnv): string | undefined {
  return readRecord(env).in_flight?.started_at;
}

function inside(path: string, root: string): boolean {
  return path === root || path.startsWith(root.endsWith(sep) ? root : `${root}${sep}`);
}

function realOrSelf(path: string): string {
  try { return realpathSync(path); } catch { return resolve(path); }
}

/**
 * The folders outside the data root that hold stores the engine opens: the legacy capture folder, Telegram's legacy
 * store folder when `XDG_DATA_HOME` moves the root, and every folder a link in any of these points to outside them.
 * A link to a single file outside them refuses the update: its folder could be anything.
 */
export function foldersOutsideRoot(env: LayoutEnv): string[] {
  const root = realOrSelf(olympusDataRoot(env));
  const found: string[] = [];
  const add = (candidate: string): void => {
    let stat;
    try { stat = statSync(candidate); } catch { return; }
    if (!stat.isDirectory()) return;
    const real = realOrSelf(candidate);
    if (inside(real, root) || found.some((folder) => inside(real, folder))) return;
    if (inside(root, real)) {
      throw new OperationError('config_error', `The data root ${root} is inside ${real}, which Olympus also keeps state in, so it cannot be set aside whole before the update.`, 'Move the data root out of that folder, then run the update again. Nothing was changed.');
    }
    for (let index = found.length - 1; index >= 0; index -= 1) if (inside(found[index]!, real)) found.splice(index, 1);
    found.push(real);
  };
  for (const candidate of [legacyCaptureDataRoot(env), legacyTelegramStoreRoot(env), legacyWhatsAppServiceStateDir(env), legacyWhatsAppLiveSyncStateDir(env, env.HOME?.trim() || undefined)]) {
    if (candidate) add(candidate);
  }
  const walked = new Set<string>();
  const walk = (directory: string, top: string): void => {
    let names: string[];
    try { names = readdirSync(directory); } catch { return; }
    for (const name of names) {
      const path = join(directory, name);
      if (directory === top && top === root && NOT_CLONED.has(name)) continue;
      let stat;
      try { stat = lstatSync(path); } catch { continue; }
      if (stat.isDirectory()) { walk(path, top); continue; }
      if (!stat.isSymbolicLink()) continue;
      const target = realOrSelf(path);
      if (inside(target, root) || found.some((folder) => inside(target, folder))) continue;
      let targetStat;
      try { targetStat = statSync(target); } catch { continue; }
      if (!targetStat.isDirectory()) {
        throw new OperationError('config_error', `${path} links to ${readlinkSync(path)}, a file outside the data root, so the update cannot keep it as it was.`, 'Move that file into the data root in place of the link, then run the update again. Nothing was changed.');
      }
      add(target);
    }
  };
  // Folders found through links can hold links too.
  for (let pass = 0; pass < 8; pass += 1) {
    const tops = [root, ...found].filter((top) => !walked.has(top));
    if (tops.length === 0) break;
    for (const top of tops) { walked.add(top); walk(top, top); }
  }
  return found;
}

/**
 * Processes other than this one with a file or their working folder under one of `roots`, as the OS sees them: /proc
 * on Linux, lsof on the Mac. A string when the OS could not be asked.
 */
export function processesWithFilesUnder(roots: string[]): string[] | string {
  const under = (path: string): string | undefined => roots.find((root) => inside(path, root));
  const self = String(process.pid);
  if (process.platform === 'linux') {
    const found = new Set<string>();
    let pids: string[];
    try { pids = readdirSync('/proc').filter((name) => /^\d+$/.test(name)); } catch { return 'no /proc'; }
    for (const pid of pids) {
      if (pid === self) continue;
      const paths: string[] = [];
      try { paths.push(readlinkSync(`/proc/${pid}/cwd`)); } catch { /* gone or not ours */ }
      let fds: string[] = [];
      try { fds = readdirSync(`/proc/${pid}/fd`); } catch { /* gone or not ours */ }
      for (const fd of fds) { try { paths.push(readlinkSync(`/proc/${pid}/fd/${fd}`)); } catch { /* closed */ } }
      const held = paths.find((path) => under(path) !== undefined);
      if (held === undefined) continue;
      let command = '?';
      try { command = readFileSync(`/proc/${pid}/cmdline`, 'utf8').replaceAll('\0', ' ').trim().slice(0, 160); } catch { /* gone */ }
      found.add(`pid ${pid} (${command}) has ${held} open`);
    }
    return [...found];
  }
  const lsof = spawnSync('lsof', ['-n', '-w', '-F', 'pcn'], { encoding: 'utf8', timeout: 30_000, maxBuffer: 256 * 1024 * 1024 });
  if (lsof.error) return `lsof failed: ${lsof.error.message}`;
  const found = new Set<string>();
  let pid = '';
  let command = '';
  for (const line of (lsof.stdout ?? '').split('\n')) {
    if (line.startsWith('p')) pid = line.slice(1);
    else if (line.startsWith('c')) command = line.slice(1);
    else if (line.startsWith('n') && pid !== self && under(line.slice(1)) !== undefined) found.add(`pid ${pid} (${command}) has ${line.slice(1)} open`);
  }
  return [...found];
}

/** The OS shows no other process with a file under `roots`, or the update refuses, naming them. */
function proveNoHolders(roots: string[], what: string, deps: DataRootDeps): void {
  const holders = deps.holders ?? processesWithFilesUnder;
  const sleep = deps.sleep ?? ((ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms));
  const deadline = Date.now() + HOLDER_PROOF_MS;
  for (;;) {
    const held = holders(roots);
    if (Array.isArray(held) && held.length === 0) return;
    if (Date.now() >= deadline) {
      const detail = typeof held === 'string' ? `the OS could not be asked which processes have them open (${held})` : held.slice(0, 5).join('; ');
      throw new OperationError('config_error', `The engine was stopped, but ${what}: ${detail}.`, 'Stop that process (or run olympus engine stop), then run the installer again. Nothing was changed.');
    }
    sleep(250);
  }
}

/** Bytes a real copy of `directory` takes, the folders not cloned left out. */
function treeBytes(directory: string, top = true): number {
  let total = 0;
  let names: string[];
  try { names = readdirSync(directory); } catch { return 0; }
  for (const name of names) {
    if (top && NOT_CLONED.has(name)) continue;
    const path = join(directory, name);
    let stat;
    try { stat = lstatSync(path); } catch { continue; }
    if (stat.isDirectory()) total += treeBytes(path, false);
    else total += stat.isFile() ? Math.max(stat.size, stat.blocks * 512) : 0;
  }
  return total;
}

function defaultFreeBytes(directory: string): number {
  const stats = statfsSync(directory);
  return Number(stats.bavail) * Number(stats.bsize);
}

/** Whether the disk under `directory` clones: APFS on the Mac; a reflink that succeeds on Linux. */
function defaultClones(directory: string): boolean {
  if (process.platform === 'darwin') return true;
  const probe = join(directory, `.olympus-clone-probe-${process.pid}`);
  try {
    writeFileSync(probe, 'probe', { mode: 0o600 });
    return spawnSync('cp', ['--reflink=always', probe, `${probe}.clone`], { stdio: 'ignore' }).status === 0;
  } catch {
    return false;
  } finally {
    rmSync(probe, { force: true });
    rmSync(`${probe}.clone`, { force: true });
  }
}

function formatBytes(bytes: number): string {
  return bytes >= 1024 ** 3 ? `${(bytes / 1024 ** 3).toFixed(1)} GB` : `${Math.ceil(bytes / 1024 ** 2)} MB`;
}

/** Clones `live` to `target`, the folders not cloned left out when `live` is the data root. */
function cloneTree(live: string, target: string, isRoot: boolean): void {
  const partial = `${target}.partial`;
  rmSync(partial, { recursive: true, force: true });
  const mode = statSync(live).mode & 0o777;
  mkdirSync(partial, { mode });
  try {
    const names = readdirSync(live).filter((name) => !(isRoot && NOT_CLONED.has(name)));
    if (names.length > 0) {
      const flags = process.platform === 'darwin' ? ['-pPRc'] : ['-a', '--reflink=auto'];
      const result = spawnSync('cp', [...flags, ...names.map((name) => join(live, name)), `${partial}/`], { encoding: 'utf8', stdio: ['ignore', 'ignore', 'pipe'], maxBuffer: 16 * 1024 * 1024 });
      if (result.status !== 0) {
        const said = (result.error?.message ?? result.stderr ?? '').trim().split('\n').slice(-3).join(' ').slice(0, 400);
        throw new OperationError('config_error', `The update could not set aside ${live} before changing it: ${said || `cp exited ${result.status}`}.`, 'Free up space or fix what cp reports, then run the installer again. Nothing was changed.');
      }
    }
    // A real copy is on disk before anything relies on it.
    spawnSync('sync', process.platform === 'linux' ? ['-f', partial] : [], { stdio: 'ignore' });
    renameSync(partial, target);
    syncDirectorySync(dirname(target));
  } catch (error) {
    rmSync(partial, { recursive: true, force: true });
    throw error;
  }
}

/**
 * With the engine stopped and its locks held: reaps what an earlier version's engine left running from its own record of
 * children, proves that no process has a file under the root or the folders outside it open, checks for room, then clones
 * each. Throws, changing nothing that stays, when it cannot.
 */
export function snapshotDataRoot(env: LayoutEnv, options: { log?: (line: string) => void; deps?: DataRootDeps } = {}): void {
  const deps = options.deps ?? {};
  const log = options.log ?? (() => {});
  const root = olympusDataRoot(env);
  if (!existsSync(root)) return;
  const record = readRecord(env);
  // A copy an earlier update took and nothing put back or removed is older than the data here, which a version has
  // used since: it is replaced, and the log says so.
  for (const pair of record.in_flight?.roots ?? []) {
    if (!existsSync(pair.snapshot)) continue;
    rmSync(pair.snapshot, { recursive: true, force: true });
    log(`Removed the copy of ${pair.live} an earlier update took at ${record.in_flight!.started_at}, which was never put back or removed.`);
  }
  delete record.in_flight;
  const reaped = reapRecordedEngineChildren(engineChildrenPath(env));
  if (reaped.stopped.length > 0) log(`Stopped ${reaped.stopped.length} process ${reaped.stopped.length === 1 ? 'group' : 'groups'} the previous engine left running.`);
  const live = [root, ...foldersOutsideRoot(env)];
  proveNoHolders(live.map(realOrSelf), 'a process still has Olympus data open, so the update did not start', deps);
  for (const folder of live) rmSync(`${snapshotPathOf(folder)}.partial`, { recursive: true, force: true });
  // Room for a real copy, per disk, where the disk cannot clone.
  const needed = new Map<string, { bytes: number; directory: string }>();
  for (const folder of live) {
    const parent = dirname(folder);
    if ((deps.clones ?? defaultClones)(parent)) continue;
    const device = String(statSync(parent).dev);
    const entry = needed.get(device) ?? { bytes: SPACE_MARGIN_BYTES, directory: parent };
    entry.bytes += Math.ceil(treeBytes(folder) * (1 + SPACE_MARGIN_SHARE));
    needed.set(device, entry);
  }
  for (const { bytes, directory } of needed.values()) {
    const free = (deps.freeBytes ?? defaultFreeBytes)(directory);
    if (free < bytes) {
      throw new OperationError('config_error', `The update copies your Olympus data before it changes it: that needs ${formatBytes(bytes)} free on the disk with ${directory}, and ${formatBytes(free)} is free.`, 'Free up space on that disk, then run the installer again. Nothing was changed.');
    }
  }
  const started = performance.now();
  const startedAt = new Date().toISOString();
  const roots: SnapshotPair[] = [];
  try {
    for (const folder of live) {
      const snapshot = snapshotPathOf(folder);
      // A clone a crashed update left, with no record naming it, is from before that update: the live data is newer.
      rmSync(snapshot, { recursive: true, force: true });
      cloneTree(folder, snapshot, folder === live[0]);
      roots.push({ live: folder, snapshot });
    }
    writeRecord(env, { ...record, in_flight: { started_at: startedAt, roots } });
  } catch (error) {
    for (const pair of roots) rmSync(pair.snapshot, { recursive: true, force: true });
    throw error;
  }
  log(`Set aside a copy of the Olympus data (${live.length} ${live.length === 1 ? 'folder' : 'folders'}) in ${Math.round((performance.now() - started) / 1000)} s before the update.`);
}

/**
 * With the new version stopped and the locks held: once the OS shows no process with a file under the data open, each
 * failed folder is renamed aside and its clone renamed back. Model files move back into the restored root. Safe to run
 * again after it was cut short. Returns what the owner is told, or [] when no update was in flight.
 */
export function putDataRootBack(env: LayoutEnv, options: { deps?: DataRootDeps } = {}): string[] {
  const record = readRecord(env);
  const flight = record.in_flight;
  if (!flight) return [];
  const startedMs = Date.parse(flight.started_at);
  proveNoHolders(flight.roots.map((pair) => pair.live).filter(existsSync).map(realOrSelf), 'a process of the new version still has Olympus data open, so it was not put back', options.deps ?? {});
  const kept: FailedRoot[] = [];
  for (const pair of flight.roots) {
    const failed = failedRootPathOf(pair.live, startedMs);
    if (existsSync(pair.snapshot)) {
      if (existsSync(pair.live) && !existsSync(failed)) renameSync(pair.live, failed);
      if (existsSync(pair.live)) {
        throw new OperationError('config_error', `${pair.live} could not be set aside: ${failed} is already there.`, 'Move one of them away by hand, then run the installer again.');
      }
      renameSync(pair.snapshot, pair.live);
      syncDirectorySync(dirname(pair.live));
    }
    if (existsSync(failed)) kept.push({ live: pair.live, failed, at: flight.started_at });
  }
  // Model files were not cloned: they stay with the root that is live.
  const root = olympusDataRoot(env);
  const failedRoot = failedRootPathOf(root, startedMs);
  const models = sharedDataPath('models', env);
  const failedModels = `${failedRoot}${models.slice(root.length)}`;
  if (existsSync(failedModels) && !existsSync(models)) renameSync(failedModels, models);
  writeRecord(env, { schema: RECORD_SCHEMA, failed: [...record.failed.filter((entry) => !kept.some((now) => now.failed === entry.failed)), ...kept] });
  if (kept.length === 0) return ['The Olympus data was put back as it was before the update.'];
  return [
    'The Olympus data was put back as it was before the update.',
    ...kept.map((entry) => `The data as the failed update left it is kept at ${entry.failed} (${formatBytes(treeBytes(entry.failed, false))}): anything imported while the update ran is there, not in the data Olympus uses now. It is removed at the next update that succeeds.`),
  ];
}

/** The update succeeded: its clone goes, and any failed root an earlier update left. Returns what was removed. */
export function commitDataRootSnapshot(env: LayoutEnv): string[] {
  const record = readRecord(env);
  const removed: string[] = [];
  for (const pair of record.in_flight?.roots ?? []) {
    rmSync(pair.snapshot, { recursive: true, force: true });
  }
  for (const entry of record.failed) {
    // Only a folder named as this module names failed roots, beside the folder it failed.
    if (dirname(entry.failed) !== dirname(entry.live) || !basename(entry.failed).startsWith(`${basename(entry.live)}.failed-update-`)) continue;
    if (!existsSync(entry.failed)) continue;
    rmSync(entry.failed, { recursive: true, force: true });
    removed.push(`Removed the data a failed update left at ${entry.failed} (from ${entry.at}).`);
  }
  writeRecord(env, { schema: RECORD_SCHEMA, failed: [] });
  return removed;
}

/**
 * Every copy of the data this module keeps (the clone of an update in flight and the failed roots), for a forget:
 * each still holds the forgotten rows. A dry run removes nothing. Returns how many there are.
 */
export function removeDataRootCopies(env: LayoutEnv, dryRun: boolean): number {
  const record = readRecord(env);
  const copies = [...(record.in_flight?.roots ?? []).map((pair) => pair.snapshot), ...record.failed.map((entry) => entry.failed)].filter(existsSync);
  if (dryRun) return copies.length;
  for (const copy of copies) rmSync(copy, { recursive: true, force: true });
  writeRecord(env, { schema: RECORD_SCHEMA, failed: [] });
  return copies.length;
}

/** For the install log: what the update in flight set aside. */
export function updateRecordSummary(env: LayoutEnv): string {
  const record = readRecord(env);
  return JSON.stringify({ in_flight: record.in_flight ?? null, failed: record.failed.map((entry) => relative(dirname(entry.live), entry.failed)) });
}
