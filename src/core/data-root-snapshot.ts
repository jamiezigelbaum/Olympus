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
import { declaredConnectorStoreMounts } from './source-placement.ts';

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
  /** `cloning` until every clone is whole: a clone a crash cut short is then known to be ours and incomplete. */
  in_flight?: { started_at: string; state: 'cloning' | 'ready'; roots: SnapshotPair[] };
  failed: FailedRoot[];
  /** Copies a committed update (or a forget) is removing: the removal finishes before anything else runs. */
  removing?: string[];
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

const FAILED_SUFFIX = /^\.failed-update-\d+$/;

function isFailedPathOf(failed: string, live: string): boolean {
  return failed.startsWith(live) && FAILED_SUFFIX.test(failed.slice(live.length));
}

/** A path the record may name for removal: a clone, a clone cut short, or a failed root, of an absolute folder. */
function isOwnCopyPath(path: string): boolean {
  if (!path.startsWith('/')) return false;
  if (path.endsWith('.before-update') || path.endsWith('.before-update.partial')) return true;
  return /^.+\.failed-update-\d+$/.test(basename(path));
}

function readRecord(env: LayoutEnv): UpdateRecord {
  const path = updateRecordPath(env);
  const unreadable = (why: string): OperationError => new OperationError('config_error', `The record of the update in flight (${path}) ${why}, so no Olympus data was moved or removed.`, 'Look at that file, then run the installer again.');
  let parsed: Partial<UpdateRecord>;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<UpdateRecord>;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { schema: RECORD_SCHEMA, failed: [] };
    throw unreadable('cannot be read');
  }
  const root = olympusDataRoot(env);
  const absolute = (value: unknown): value is string => typeof value === 'string' && value.startsWith('/') && resolve(value) === value;
  const record: UpdateRecord = { schema: RECORD_SCHEMA, failed: [] };
  if (parsed.in_flight !== undefined) {
    const flight = parsed.in_flight as Partial<NonNullable<UpdateRecord['in_flight']>>;
    const roots = Array.isArray(flight.roots) ? flight.roots : undefined;
    if (!roots || typeof flight.started_at !== 'string' || Number.isNaN(Date.parse(flight.started_at))) throw unreadable('names no valid update in flight');
    for (const pair of roots) {
      if (!absolute(pair?.live) || pair.snapshot !== snapshotPathOf(pair.live)) throw unreadable(`names a copy not named <folder>.before-update`);
    }
    if (roots.length > 0 && roots[0]!.live !== root) throw unreadable(`does not start with the data root ${root}`);
    // Records written before the cloning state was added are from builds that wrote them only once every clone was whole.
    record.in_flight = { started_at: flight.started_at, state: flight.state === 'cloning' ? 'cloning' : 'ready', roots };
  }
  for (const entry of Array.isArray(parsed.failed) ? parsed.failed : []) {
    if (!absolute(entry?.live) || !absolute(entry.failed) || !isFailedPathOf(entry.failed, entry.live)) throw unreadable('names a kept copy not named as this update names them');
    record.failed.push({ live: entry.live, failed: entry.failed, at: String(entry.at ?? '') });
  }
  if (Array.isArray(parsed.removing)) {
    for (const entry of parsed.removing) {
      if (!absolute(entry) || !isOwnCopyPath(entry)) throw unreadable(`names ${String(entry)} for removal, which is not a copy this update takes`);
    }
    if (parsed.removing.length > 0) record.removing = parsed.removing;
  }
  return record;
}

function writeRecord(env: LayoutEnv, record: UpdateRecord): void {
  const path = updateRecordPath(env);
  if (!record.in_flight && record.failed.length === 0 && !record.removing?.length) { removeFileDurablySync(path); return; }
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writePrivateFileAtomicSync(path, `${JSON.stringify(record)}\n`);
}

/** When the update in flight started, or undefined when none is. */
export function updateInFlightSince(env: LayoutEnv): string | undefined {
  const flight = readRecord(env).in_flight;
  return flight?.state === 'ready' ? flight.started_at : undefined;
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
  // Stores the install declares outside the root: the folder each is in.
  const declared = declaredConnectorStoreMounts(env);
  if (declared === 'unreadable') {
    throw new OperationError('config_error', 'The setting that says where connector stores live outside the data root cannot be read, so the update cannot keep them as they were.', 'Fix that setting, then run the update again. Nothing was changed.');
  }
  for (const mount of declared) if (mount.dbPath) add(dirname(resolve(mount.dbPath)));
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

/** The names of the lock files at the top of the data root that the update holds while it runs. */
function lockNames(env: LayoutEnv): string[] {
  return [basename(sharedDataPath('data-owner-lock', env)), basename(sharedDataPath('engine-process-lock', env))];
}

/** A folder that is gone, or holds nothing but the lock files a step's own locks made. */
function holdsOnlyLocks(path: string, env: LayoutEnv): boolean {
  let names: string[];
  try { names = readdirSync(path); } catch { return !existsSync(path); }
  const locks = new Set(lockNames(env));
  return names.every((name) => locks.has(name));
}

/**
 * Renames `snapshot` into `live`'s place. The lock files the caller holds are in `lockHolder` (the root set aside, or a
 * root the locks alone made again): they are moved into the clone first, over its copies, so the locks held stay the
 * locks at the live path and no other process can take them while this step runs. `live` is then gone, or holds only
 * locks, which is removed.
 */
function swapIn(pair: SnapshotPair, lockHolder: string | undefined, env: LayoutEnv): void {
  if (lockHolder !== undefined) {
    for (const name of lockNames(env)) {
      if (existsSync(join(lockHolder, name))) renameSync(join(lockHolder, name), join(pair.snapshot, name));
    }
  }
  if (existsSync(pair.live)) {
    if (!holdsOnlyLocks(pair.live, env)) {
      throw new OperationError('config_error', `${pair.live} could not be put back: there is data there again.`, 'Move it away by hand, then run the installer again.');
    }
    rmSync(pair.live, { recursive: true, force: true });
  }
  renameSync(pair.snapshot, pair.live);
  syncDirectorySync(dirname(pair.live));
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

/** The file system type of the mount `directory` is on, from `mount` (the Mac), or undefined. */
function macFileSystem(directory: string): string | undefined {
  const result = spawnSync('mount', [], { encoding: 'utf8', timeout: 10_000 });
  if (result.status !== 0) return undefined;
  const real = realOrSelf(directory);
  let best: { point: string; type: string } | undefined;
  for (const line of (result.stdout ?? '').split('\n')) {
    const match = /^.+? on (.+) \(([^,)]+)/.exec(line);
    if (!match) continue;
    const point = match[1]!;
    if (!inside(real, point) && point !== '/') continue;
    if (!best || point.length > best.point.length) best = { point, type: match[2]!.trim() };
  }
  return best?.type;
}

/** Whether the disk under `directory` clones: APFS on the Mac; a reflink that succeeds on Linux. */
function defaultClones(directory: string): boolean {
  if (process.platform === 'darwin') return macFileSystem(directory) === 'apfs';
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
function cloneTree(live: string, target: string, isRoot: boolean, clones: boolean): void {
  const partial = `${target}.partial`;
  const mode = statSync(live).mode & 0o777;
  mkdirSync(partial, { mode });
  try {
    const names = readdirSync(live).filter((name) => !(isRoot && NOT_CLONED.has(name)));
    if (names.length > 0) {
      const flags = process.platform === 'darwin' ? [clones ? '-pPRc' : '-pPR'] : ['-a', '--reflink=auto'];
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

/** Finishes a removal a committed update or a forget began: each copy it named goes before anything else runs. */
function finishRemoving(env: LayoutEnv, record: UpdateRecord): void {
  if (!record.removing?.length) return;
  for (const copy of record.removing) rmSync(copy, { recursive: true, force: true });
  delete record.removing;
  writeRecord(env, record);
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
  const record = readRecord(env);
  finishRemoving(env, record);
  const flight = record.in_flight;
  if (flight?.state === 'cloning') {
    // A crash while cloning: the update never ran, and these copies are this module's own, incomplete.
    for (const pair of flight.roots) {
      rmSync(`${pair.snapshot}.partial`, { recursive: true, force: true });
      rmSync(pair.snapshot, { recursive: true, force: true });
    }
    delete record.in_flight;
    writeRecord(env, record);
  } else if (flight) {
    const startedMs = Date.parse(flight.started_at);
    for (const [index, pair] of flight.roots.entries()) {
      if (!existsSync(pair.snapshot)) continue;
      if (holdsOnlyLocks(pair.live, env)) {
        // A put-back cut short between its renames: the failed root is aside, and taking the locks for this step made the
        // root again, empty but for them.
        swapIn(pair, index === 0 ? pair.live : undefined, env);
        log(`Finished putting ${pair.live} back as it was before the update of ${flight.started_at}.`);
        continue;
      }
      // A copy an earlier update took that nothing put back or removed is older than the data here, which a version has
      // used since. It is kept with the failed roots, named in the log, until the next update that succeeds.
      const kept = failedRootPathOf(pair.live, startedMs);
      if (existsSync(kept)) continue;
      renameSync(pair.snapshot, kept);
      record.failed.push({ live: pair.live, failed: kept, at: flight.started_at });
      log(`An earlier update's copy of ${pair.live} from ${flight.started_at} was never put back or removed; it is kept at ${kept} until the next update that succeeds.`);
    }
    delete record.in_flight;
    writeRecord(env, record);
  }
  if (!existsSync(root)) return;
  const reaped = reapRecordedEngineChildren(engineChildrenPath(env));
  if (reaped.stopped.length > 0) log(`Stopped ${reaped.stopped.length} process ${reaped.stopped.length === 1 ? 'group' : 'groups'} the previous engine left running.`);
  const live = [root, ...foldersOutsideRoot(env)];
  proveNoHolders(live.map(realOrSelf), 'a process still has Olympus data open, so the update did not start', deps);
  // A copy beside a folder that no record names is not this module's to remove.
  for (const folder of live) {
    for (const stray of [snapshotPathOf(folder), `${snapshotPathOf(folder)}.partial`]) {
      if (existsSync(stray)) {
        throw new OperationError('config_error', `${stray} is already there and no record of an update names it, so the update did not start.`, 'Move it away (it may be a copy of your data from an earlier update), then run the installer again. Nothing was changed.');
      }
    }
  }
  // Room for a real copy, per disk, where the disk cannot clone.
  const clones = new Map<string, boolean>();
  const needed = new Map<string, { bytes: number; directory: string }>();
  for (const folder of live) {
    const parent = dirname(folder);
    const cloning = (deps.clones ?? defaultClones)(parent);
    clones.set(folder, cloning);
    if (cloning) continue;
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
  const roots: SnapshotPair[] = live.map((folder) => ({ live: folder, snapshot: snapshotPathOf(folder) }));
  writeRecord(env, { ...record, in_flight: { started_at: startedAt, state: 'cloning', roots } });
  try {
    for (const [index, pair] of roots.entries()) cloneTree(pair.live, pair.snapshot, index === 0, clones.get(pair.live) ?? false);
    writeRecord(env, { ...record, in_flight: { started_at: startedAt, state: 'ready', roots } });
  } catch (error) {
    for (const pair of roots) rmSync(pair.snapshot, { recursive: true, force: true });
    writeRecord(env, record);
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
  finishRemoving(env, record);
  const flight = record.in_flight;
  if (!flight) return [];
  if (flight.state === 'cloning') {
    // The clones were never whole, so the update never ran: nothing to put back.
    for (const pair of flight.roots) {
      rmSync(`${pair.snapshot}.partial`, { recursive: true, force: true });
      rmSync(pair.snapshot, { recursive: true, force: true });
    }
    delete record.in_flight;
    writeRecord(env, record);
    return [];
  }
  const startedMs = Date.parse(flight.started_at);
  proveNoHolders(flight.roots.map((pair) => pair.live).filter(existsSync).map(realOrSelf), 'a process of the new version still has Olympus data open, so it was not put back', options.deps ?? {});
  const kept: FailedRoot[] = [];
  for (const [index, pair] of flight.roots.entries()) {
    const failed = failedRootPathOf(pair.live, startedMs);
    if (existsSync(pair.snapshot)) {
      let lockHolder: string | undefined;
      if (existsSync(pair.live) && !holdsOnlyLocks(pair.live, env)) {
        if (existsSync(failed)) {
          throw new OperationError('config_error', `${pair.live} could not be set aside: ${failed} is already there.`, 'Move one of them away by hand, then run the installer again.');
        }
        renameSync(pair.live, failed);
        lockHolder = failed;
      } else if (existsSync(pair.live)) {
        // Cut short after the failed root went aside: the locks made the root again.
        lockHolder = pair.live;
      } else if (existsSync(failed)) {
        lockHolder = failed;
      }
      swapIn(pair, index === 0 ? lockHolder : undefined, env);
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

/**
 * The update succeeded: its clone goes, and any failed root an earlier update left. The record says the update is
 * committed, with what it is removing, before anything is removed, so a crash part way never leaves a half-removed clone
 * that a put-back would restore. Returns what was removed.
 */
export function commitDataRootSnapshot(env: LayoutEnv): string[] {
  const record = readRecord(env);
  const failed = record.failed.filter((entry) => existsSync(entry.failed));
  const removing = [...(record.removing ?? []), ...(record.in_flight?.roots ?? []).map((pair) => pair.snapshot), ...failed.map((entry) => entry.failed)];
  writeRecord(env, { schema: RECORD_SCHEMA, failed: [], removing });
  finishRemoving(env, { schema: RECORD_SCHEMA, failed: [], removing });
  return failed.map((entry) => `Removed the data a failed update left at ${entry.failed} (from ${entry.at}).`);
}

/**
 * Every copy of the data this module keeps (the clone of an update in flight and the failed roots), for a forget:
 * each still holds the forgotten rows. A dry run removes nothing. Returns how many there are.
 */
export function removeDataRootCopies(env: LayoutEnv, dryRun: boolean): number {
  const record = readRecord(env);
  const copies = [...(record.removing ?? []), ...(record.in_flight?.roots ?? []).map((pair) => pair.snapshot), ...record.failed.map((entry) => entry.failed)].filter(existsSync);
  if (dryRun) return copies.length;
  writeRecord(env, { schema: RECORD_SCHEMA, failed: [], removing: copies });
  finishRemoving(env, { schema: RECORD_SCHEMA, failed: [], removing: copies });
  return copies.length;
}

/** For the install log: what the update in flight set aside. */
export function updateRecordSummary(env: LayoutEnv): string {
  const record = readRecord(env);
  return JSON.stringify({ in_flight: record.in_flight ?? null, failed: record.failed.map((entry) => relative(dirname(entry.live), entry.failed)) });
}
