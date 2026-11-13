/**
 * The update to a split engine, as the owner runs it (ops#151, 2026-11-13).
 *
 * rc.4 failed on the owner's machine twice over: its front crashed on every start, and the failed update left the data root
 * one ledger file short. The upgrade leg with the split on now does what that machine did: the earlier release holds a store
 * set (Gmail with an attachment, Telegram), the owner's engine.json has `worker.engineSplit` on, and the candidate's public
 * installer runs over it. It runs twice:
 * - first a copy of the candidate whose front exits as soon as it would serve, which is after the background has finished its boot
 *   work and migrated the stores: the installer must report the failure, and the earlier release must be running and healthy
 *   again with every store file it had, the ones the candidate retires included;
 * - then the candidate itself, whose front must then stay up (front-steady.ts) with every store file still there except the
 *   ones it retires on purpose (the removed pre-filter's ledger, #1415).
 */
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { embeddingPrefilterDirectory, embeddingPrefilterInstallLedgerPath } from '../../src/workers/classification/tier-ledger-path.ts';
import type { CheckResult } from './report.ts';

/** What the broken copy's front prints before it exits, so its own log says why. */
export const BROKEN_FRONT_LINE = '[release-check] this build\'s front exits on purpose as it starts to serve (forced update failure)';
/**
 * The front waits for the background to finish its boot work (the lock, deletions, the stores' migration) before it serves, so
 * its first Bun.serve is the earliest point where the update has changed the stores. An exit before that would fail the update
 * before any store migrated, and its rollback would prove nothing (plan thread, 13 Nov).
 */
const BROKEN_FRONT_GUARD = `if (process.env.OLYMPUS_WORKER_ENGINE_ROLE === 'front' && typeof Bun !== 'undefined') { Bun.serve = () => { console.error(${JSON.stringify(BROKEN_FRONT_LINE)}); process.exit(70); }; }\n`;

/** Puts the guard at the top of an entry file, after its shebang if it has one. */
export function breakFront(source: string): string {
  if (!source.startsWith('#!')) return BROKEN_FRONT_GUARD + source;
  const end = source.indexOf('\n') + 1;
  return source.slice(0, end) + BROKEN_FRONT_GUARD + source.slice(end);
}

const sha256 = (path: string): string => createHash('sha256').update(readFileSync(path)).digest('hex');

/** Rewrites an installer's pins for the tarball (`OLYMPUS_SHA256=`, `OLYMPUS_BYTES=`), keeping every other line. */
export function repinInstaller(text: string, hash: string, bytes: number): string {
  const pinned = text.replace(/^OLYMPUS_SHA256=.*$/m, `OLYMPUS_SHA256=${hash}`).replace(/^OLYMPUS_BYTES=.*$/m, `OLYMPUS_BYTES=${bytes}`);
  if (pinned === text || !/^OLYMPUS_SHA256=[0-9a-f]{64}$/m.test(pinned)) throw new Error('the installer has no OLYMPUS_SHA256/OLYMPUS_BYTES pins to rewrite');
  return pinned;
}

/** Rewrites the SHA256SUMS lines of the named files, keeping the rest. */
export function rehash(sums: string, hashes: Record<string, string>): string {
  return sums.split('\n').map((line) => {
    const match = /^([0-9a-f]{64})(\s+\*?)(.+)$/.exec(line);
    const next = match ? hashes[match[3]!] : undefined;
    return match && next ? `${next}${match[2]}${match[3]}` : line;
  }).join('\n');
}

/**
 * A copy of the candidate's installer bundle whose front exits as soon as it starts, with the installer's pins and the
 * bundle's SHA256SUMS made to match, so the installer accepts it as it would the real one. The background and the CLI run.
 */
export function brokenBundle(candidateDir: string, outDir: string): string {
  const dir = join(outDir, 'upgrade-broken-front');
  rmSync(dir, { recursive: true, force: true });
  cpSync(candidateDir, dir, { recursive: true });
  const tarball = readdirSync(dir).find((name) => /^olympus-.*\.tgz$/.test(name));
  if (!tarball) throw new Error(`no olympus-*.tgz in ${candidateDir}`);
  const scratch = mkdtempSync(join(tmpdir(), 'rc-broken-'));
  try {
    const tar = (args: string[]): void => {
      const p = Bun.spawnSync(['tar', ...args], { stdout: 'pipe', stderr: 'pipe' });
      if (p.exitCode !== 0) throw new Error(`tar ${args[0]} failed: ${p.stderr.toString().slice(0, 200)}`);
    };
    tar(['-xzf', join(dir, tarball), '-C', scratch]);
    const entry = join(scratch, 'package', 'dist', 'cli.js');
    if (!existsSync(entry)) throw new Error('the tarball has no package/dist/cli.js');
    writeFileSync(entry, breakFront(readFileSync(entry, 'utf8')));
    tar(['-czf', join(dir, tarball), '-C', scratch, 'package']);
  } finally { rmSync(scratch, { recursive: true, force: true }); }
  const hash = sha256(join(dir, tarball));
  const hashes: Record<string, string> = { [tarball]: hash };
  for (const installer of ['install-linux.sh', 'install-macos.sh']) {
    const path = join(dir, installer);
    if (!existsSync(path)) continue;
    writeFileSync(path, repinInstaller(readFileSync(path, 'utf8'), hash, statSync(join(dir, tarball)).size));
    hashes[installer] = sha256(path);
  }
  const sums = join(dir, 'SHA256SUMS');
  if (existsSync(sums)) writeFileSync(sums, rehash(readFileSync(sums, 'utf8'), hashes));
  return dir;
}

/**
 * The store files under the engine's data root, relative to it: the SQLite stores and the ledgers. Backups the engine keeps
 * beside them are not stores. The list stays on the machine; only counts leave it.
 */
export function storeFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    let entries: import('node:fs').Dirent[];
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (/backup/i.test(entry.name)) continue;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile() && /(\.sqlite|\.db|ledger\.jsonl)$/.test(entry.name)) out.push(relative(root, path));
    }
  };
  walk(root);
  return out.sort();
}

/** `missing` leaves out `retired`: the files a newer version moves aside on purpose (the removed pre-filter's ledger and weights, #1415). */
export interface StoreFileCount { count: number; missing: number; retired: number; extra: number; leftovers?: number }

const RETIRED_LEDGER_SUFFIX = embeddingPrefilterInstallLedgerPath('');
const RETIRED_DIRECTORY_SUFFIX = embeddingPrefilterDirectory('');

/** Whether a store file is one the candidate retires on purpose: the pre-filter's install ledger, or a file in its weights folder. */
export function retiredStoreFile(path: string): boolean {
  return path.endsWith(RETIRED_LEDGER_SUFFIX) || path.split(/[\\/]/).slice(0, -1).some((part) => part.endsWith(RETIRED_DIRECTORY_SUFFIX));
}

/** Files an update leaves only while it runs: schema backups, partial copies and SQLite journals. None may outlast it. */
export function leftoverFiles(root: string): number {
  let count = 0;
  const walk = (dir: string): void => {
    let entries: import('node:fs').Dirent[];
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (/\.pre-schema-.*\.bak$|\.partial|-journal$/.test(entry.name)) count += 1;
    }
  };
  walk(root);
  return count;
}

/** What the installer says on stderr when it rolled the stores back (L1, floor c013270b). */
export const STORES_PUT_BACK = 'Stores put back as they were before the update';

export function compareStoreFiles(before: readonly string[], now: readonly string[]): StoreFileCount {
  const had = new Set(before);
  const has = new Set(now);
  const gone = before.filter((path) => !has.has(path));
  const retired = gone.filter(retiredStoreFile).length;
  return { count: now.length, missing: gone.length - retired, retired, extra: now.filter((path) => !had.has(path)).length };
}

const filesDetail = (before: number, after: StoreFileCount): string =>
  `${before} before, ${after.count} after: ${after.missing} missing, ${after.retired ?? 0} retired on purpose, ${after.extra} new, ${after.leftovers ?? 'uncounted'} backup, partial or journal file(s) left`;

export interface ForcedFailureObservation {
  /** The installer's own verdict on the broken copy: it must report a failure. */
  installer: { failed: boolean; detail?: string };
  /** How many times the broken front's own line reached the engine log: proof the update got as far as starting it. */
  frontRan?: number;
  /** The engine after it: ready, and the earlier release's version. */
  engine: { ready: boolean; detail?: string; version?: string | null };
  beforeVersion?: string | null;
  storeFiles?: { before: number; after?: StoreFileCount };
}

export function forcedFailureChecks(obs: ForcedFailureObservation): CheckResult[] {
  // A failure before the broken front started (a copy or transfer error in the driver) exercised no rollback: the untouched
  // release would read as rolled back. Every check fails then, and says so.
  if (obs.installer.failed && !(Number(obs.frontRan) > 0)) {
    const detail = `the update failed before the broken front started, so no rollback was exercised: ${obs.installer.detail ?? 'no detail'}`;
    return forcedFailureCheckShapes().map((check) => ({ ...check, status: 'fail' as const, detail }));
  }
  const version = obs.engine.version ?? null;
  const back = obs.engine.ready && version !== null && version === (obs.beforeVersion ?? null);
  const files = obs.storeFiles?.after;
  // A rollback puts back what the update retired too, so nothing may be gone, retired or not.
  const kept = files !== undefined && files.missing === 0 && !(files.retired > 0) && files.count === obs.storeFiles!.before && files.leftovers === 0;
  const putBack = obs.installer.failed && (obs.installer.detail ?? '').includes(STORES_PUT_BACK);
  const [installer, rollback, stores] = forcedFailureCheckShapes();
  return [
    {
      ...installer!,
      status: putBack ? 'pass' : 'fail',
      detail: !obs.installer.failed
        ? 'the installer reported a usable install of a build whose front cannot start'
        : putBack ? obs.installer.detail! : `the installer failed without saying the stores were put back: ${obs.installer.detail ?? 'no detail'}`,
    },
    {
      ...rollback!,
      status: back ? 'pass' : 'fail',
      detail: back
        ? `the engine is ready on ${version}`
        : !obs.engine.ready ? `the engine is not ready: ${obs.engine.detail ?? 'no detail'}` : `the engine reports ${version ?? 'no version'}, not ${obs.beforeVersion ?? 'the earlier release'}`,
    },
    {
      ...stores!,
      status: kept ? 'pass' : 'fail',
      detail: files === undefined
        ? 'the store files were not counted'
        : filesDetail(obs.storeFiles!.before, files),
    },
  ];
}

function forcedFailureCheckShapes(): Array<Pick<CheckResult, 'id' | 'title'>> {
  return [
    { id: 'upgrade.forced-failure.installer', title: 'An update whose front crashes on start is reported as failed by the installer, which says it put the stores back' },
    { id: 'upgrade.forced-failure.rollback', title: 'After the failed update, the earlier release is running and healthy' },
    { id: 'upgrade.forced-failure.stores', title: 'After the failed update, every store file is still there, the retired ones put back, as many as before, and no backup, partial or journal file left' },
  ];
}

/** After the real update: every store file the earlier release had is still there, except the ones the candidate retires (it may add its own). */
export function storesKeptCheck(before: number | undefined, after: StoreFileCount | undefined): CheckResult {
  const kept = before !== undefined && after !== undefined && after.missing === 0 && after.leftovers === 0;
  return {
    id: 'upgrade.split.stores',
    title: 'After the update to the split engine, every store file the earlier release had is still there, except the ones it retires on purpose, and no backup, partial or journal file is left',
    status: kept ? 'pass' : 'fail',
    detail: before === undefined || after === undefined ? 'the store files were not counted' : filesDetail(before, after),
  };
}
