/**
 * File-change notifications for the local files source.
 *
 * `@parcel/watcher` (FSEvents on a Mac, inotify on Linux) is a native addon:
 * it cannot be bundled into `dist`, so it is loaded at run time by name, and a
 * machine where it cannot be loaded is not broken. The source then lists on
 * its poll interval, and the dashboard says the live updates are off and why.
 *
 * The hub does three things:
 *  - keeps one live subscription per watched folder and tells the scheduler
 *    (`subscribeChanges`) that something changed;
 *  - writes and replays change snapshots, so after a restart, sleep or an
 *    unmounted disk the source catches up from history instead of rescanning;
 *  - on Linux, refuses to spend more inotify watches than the machine has,
 *    and says so: such a folder is rescanned on a timer instead.
 */
import { createRequire } from 'node:module';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { DefaultExclusionContext } from './paths.ts';

export interface WatchEvent {
  type: 'create' | 'update' | 'delete';
  path: string;
}

/** The part of `@parcel/watcher` the hub uses. */
export interface ParcelWatcherModule {
  subscribe(
    dir: string,
    fn: (error: Error | null, events: WatchEvent[]) => void,
    options?: { ignore?: string[] },
  ): Promise<{ unsubscribe(): Promise<void> }>;
  writeSnapshot(dir: string, snapshotPath: string, options?: { ignore?: string[] }): Promise<string>;
  getEventsSince(dir: string, snapshotPath: string, options?: { ignore?: string[] }): Promise<WatchEvent[]>;
}

export type WatchProblem =
  | { kind: 'watcher_unavailable'; detail: string }
  | { kind: 'watch_limit_reached'; limit: number; wanted: number }
  | { kind: 'watch_failed'; root: string; detail: string };

export class WatchHistoryUnavailableError extends Error {
  constructor(detail: string) {
    super(`watch history unavailable: ${detail}`);
    this.name = 'WatchHistoryUnavailableError';
  }
}

export interface WatchHubOptions {
  /** Test seam: the watcher module, or a loader for it. Default: load `@parcel/watcher`. */
  load?: () => Promise<ParcelWatcherModule>;
  platform?: NodeJS.Platform;
  /** Test seam: the inotify watch limit (Linux). */
  inotifyLimit?: () => number | undefined;
  /** Where the packaged native modules live, besides the plugin's own `node_modules`. */
  nativeModuleDirs?: readonly string[];
}

const IGNORE_SEGMENTS = [
  '.git', 'node_modules', '.Trash', '.Trashes', '.cache', '__pycache__', '.venv', 'DerivedData', '.next', '.gradle',
];

/** Paths a live watch never reports: the folders that are off by default, and Olympus's own data. */
export function watchIgnoreGlobs(context: DefaultExclusionContext, extra: readonly string[] = []): string[] {
  const home = context.home;
  const globs = IGNORE_SEGMENTS.map((segment) => `**/${segment}`);
  globs.push(`${home}/.olympus`, `${home}/.openclaw`, `${home}/.local/share/openclaw`, `${home}/.local/share/Trash`);
  if ((context.platform ?? process.platform) === 'darwin') globs.push(`${home}/Library`);
  for (const root of context.syncedRoots ?? []) globs.push(root);
  // Wherever Olympus's environment and install put its own folders. A watch
  // above one never reports it; no folder chosen by name sits inside one
  // (`localFilesRoots`), so `ignoreGlobsForRoot` never has to keep one apart.
  for (const root of context.ownRoots ?? []) globs.push(root);
  return [...globs, ...extra];
}

/**
 * The ignore globs that apply to a watch on `rootReal`. A folder the person
 * chose by name is watched even when it is, or lies inside, a place that is
 * off by default (iCloud Drive inside Library, a chosen `.git`): dropping the
 * glob that would hide it keeps its deletions, renames and edits visible. The
 * connector's own scope decision still keeps everything else out.
 */
export function ignoreGlobsForRoot(globs: readonly string[], rootReal: string): string[] {
  const segments = new Set(rootReal.split('/').filter(Boolean).map((part) => part.toLowerCase()));
  const lowerRoot = rootReal.toLowerCase();
  return globs.filter((glob) => {
    if (glob.startsWith('**/')) return !segments.has(glob.slice(3).toLowerCase());
    const lowerGlob = glob.toLowerCase();
    return !(lowerRoot === lowerGlob || lowerRoot.startsWith(`${lowerGlob}/`));
  });
}

/**
 * Whether a watch on `rootReal` (with `globs` adjusted for that root) would
 * drop what happens at `path`: some folder between the root and the path is
 * one the watch leaves out. A chosen folder inside such a place (iCloud Drive
 * inside Library, say) gets no wake from the outer watch and needs its own.
 */
export function watchWouldIgnore(globs: readonly string[], rootReal: string, path: string): boolean {
  const effective = ignoreGlobsForRoot(globs, rootReal);
  const lowerPath = path.toLowerCase();
  const below = lowerPath.startsWith(`${rootReal.toLowerCase()}/`) ? lowerPath.slice(rootReal.length + 1).split('/') : lowerPath.split('/').filter(Boolean);
  return effective.some((glob) => {
    if (glob.startsWith('**/')) return below.includes(glob.slice(3).toLowerCase());
    const lowerGlob = glob.toLowerCase();
    return lowerPath === lowerGlob || lowerPath.startsWith(`${lowerGlob}/`);
  });
}

export class WatchHub {
  private readonly options: WatchHubOptions;
  private module: Promise<ParcelWatcherModule> | undefined;
  private unavailable: string | undefined;
  private readonly listeners = new Set<() => void>();
  private readonly subscriptions = new Map<string, { unsubscribe(): Promise<void> } | 'pending'>();
  private readonly problems = new Map<string, WatchProblem>();
  private readonly directoryCounts = new Map<string, number>();
  private wanted: Array<{ root: string; ignore: string[] }> = [];
  private closed = false;

  constructor(options: WatchHubOptions = {}) {
    this.options = options;
  }

  /** A function with a stable identity, which is what the scheduler needs. */
  readonly subscribeChanges = (wake: () => void): (() => void) => {
    this.listeners.add(wake);
    void this.reconcile();
    return () => { this.listeners.delete(wake); };
  };

  /** The folders to watch now. Replaces the previous set. */
  setRoots(roots: ReadonlyArray<{ root: string; ignore?: readonly string[] }>): void {
    this.wanted = roots.map((entry) => ({ root: entry.root, ignore: [...(entry.ignore ?? [])] }));
    void this.reconcile();
  }

  /** How many folders a pass under `root` found, so the inotify budget can be checked. */
  noteDirectoryCount(root: string, directories: number): void {
    this.directoryCounts.set(root, directories);
    void this.reconcile();
  }

  problemsNow(): WatchProblem[] {
    const out: WatchProblem[] = [...this.problems.values()];
    if (this.unavailable !== undefined) out.unshift({ kind: 'watcher_unavailable', detail: this.unavailable });
    return out;
  }

  /** True when live notifications cannot be relied on: the folders are rescanned on the poll instead. */
  rescanOnly(): boolean {
    return this.unavailable !== undefined || this.problems.size > 0;
  }

  /** Whether the native watcher loads at all (loading it if it has not been tried). */
  async available(): Promise<boolean> {
    try {
      await this.watcher();
      return true;
    } catch {
      return false;
    }
  }

  async writeSnapshot(root: string, snapshotPath: string, ignore: readonly string[] = []): Promise<void> {
    const watcher = await this.watcherOrHistoryError();
    await watcher.writeSnapshot(root, snapshotPath, { ignore: [...ignore] });
  }

  async eventsSince(root: string, snapshotPath: string, ignore: readonly string[] = []): Promise<WatchEvent[]> {
    const watcher = await this.watcherOrHistoryError();
    if (!existsSync(snapshotPath)) throw new WatchHistoryUnavailableError('the snapshot is gone');
    try {
      return await watcher.getEventsSince(root, snapshotPath, { ignore: [...ignore] });
    } catch (error) {
      throw new WatchHistoryUnavailableError(error instanceof Error ? error.message : 'replay failed');
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    this.listeners.clear();
    const live = [...this.subscriptions.values()];
    this.subscriptions.clear();
    await Promise.all(live.map((entry) => entry === 'pending' ? undefined : entry.unsubscribe().catch(() => undefined)));
  }

  private async watcherOrHistoryError(): Promise<ParcelWatcherModule> {
    try {
      return await this.watcher();
    } catch (error) {
      throw new WatchHistoryUnavailableError(error instanceof Error ? error.message : 'the watcher is not available');
    }
  }

  private watcher(): Promise<ParcelWatcherModule> {
    if (!this.module) {
      this.module = (this.options.load ?? (() => loadParcelWatcher(this.options.nativeModuleDirs)))()
        .catch((error: unknown) => {
          this.unavailable = error instanceof Error ? error.message : 'the file watcher could not be loaded';
          throw error;
        });
    }
    return this.module;
  }

  private inotifyBudgetExceeded(): WatchProblem | undefined {
    if ((this.options.platform ?? process.platform) !== 'linux') return undefined;
    const limit = (this.options.inotifyLimit ?? readInotifyLimit)();
    if (limit === undefined) return undefined;
    let wanted = 0;
    for (const entry of this.wanted) wanted += this.directoryCounts.get(entry.root) ?? 0;
    // Other programs share the limit; leave them a fifth of it.
    return wanted > limit * 0.8 ? { kind: 'watch_limit_reached', limit, wanted } : undefined;
  }

  private async reconcile(): Promise<void> {
    if (this.closed || this.listeners.size === 0) return;
    let watcher: ParcelWatcherModule;
    try {
      watcher = await this.watcher();
    } catch {
      return;
    }
    const exceeded = this.inotifyBudgetExceeded();
    if (exceeded) this.problems.set('limit', exceeded);
    else this.problems.delete('limit');

    const wantedRoots = new Set(this.wanted.map((entry) => entry.root));
    for (const [root, entry] of [...this.subscriptions]) {
      if (wantedRoots.has(root) && !exceeded) continue;
      this.subscriptions.delete(root);
      if (entry !== 'pending') await entry.unsubscribe().catch(() => undefined);
    }
    if (exceeded) return;
    for (const { root, ignore } of this.wanted) {
      if (this.subscriptions.has(root)) continue;
      this.subscriptions.set(root, 'pending');
      try {
        const subscription = await watcher.subscribe(root, (error, events) => {
          if (error) {
            this.problems.set(`failed:${root}`, { kind: 'watch_failed', root, detail: error.message });
            this.wake();
            return;
          }
          if (events.length > 0) this.wake();
        }, { ignore });
        if (this.closed || !this.wanted.some((entry) => entry.root === root)) {
          await subscription.unsubscribe().catch(() => undefined);
          this.subscriptions.delete(root);
        } else {
          this.subscriptions.set(root, subscription);
          this.problems.delete(`failed:${root}`);
        }
      } catch (error) {
        this.subscriptions.delete(root);
        this.problems.set(`failed:${root}`, {
          kind: 'watch_failed',
          root,
          detail: error instanceof Error ? error.message : 'subscribe failed',
        });
      }
    }
  }

  private wake(): void {
    for (const listener of [...this.listeners]) {
      try { listener(); } catch { /* a listener never breaks the hub */ }
    }
  }
}

export function readInotifyLimit(): number | undefined {
  try {
    const value = Number.parseInt(readFileSync('/proc/sys/fs/inotify/max_user_watches', 'utf8').trim(), 10);
    return Number.isFinite(value) && value > 0 ? value : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Loads `@parcel/watcher` by name, so the bundler leaves it alone. It is found
 * in the plugin's own `node_modules` first (a checkout, or a package that ships
 * it), then in the extra directories named by `nativeModuleDirs` and
 * `OLYMPUS_NATIVE_MODULES_DIR`.
 */
export async function loadParcelWatcher(extraDirs: readonly string[] = []): Promise<ParcelWatcherModule> {
  const specifier = '@parcel/watcher';
  const failures: string[] = [];
  try {
    return unwrap(await import(/* @vite-ignore */ specifier));
  } catch (error) {
    failures.push(error instanceof Error ? error.message : String(error));
  }
  const dirs = [...extraDirs, ...(process.env.OLYMPUS_NATIVE_MODULES_DIR ? [process.env.OLYMPUS_NATIVE_MODULES_DIR] : [])];
  for (const dir of dirs) {
    const candidate = join(dir, 'node_modules');
    if (!existsSync(join(candidate, '@parcel', 'watcher'))) continue;
    try {
      const requireFrom = createRequire(join(dirname(candidate), 'package.json'));
      return unwrap(requireFrom(specifier));
    } catch (error) {
      failures.push(error instanceof Error ? error.message : String(error));
    }
  }
  throw new Error(`the file watcher could not be loaded (${failures[0] ?? 'not installed'})`);
}

function unwrap(loaded: unknown): ParcelWatcherModule {
  const candidate = (loaded as { default?: unknown })?.default ?? loaded;
  const module = candidate as Partial<ParcelWatcherModule>;
  if (typeof module.subscribe !== 'function' || typeof module.writeSnapshot !== 'function') {
    throw new Error('the file watcher module has an unexpected shape');
  }
  return module as ParcelWatcherModule;
}
