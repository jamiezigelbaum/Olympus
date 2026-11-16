/**
 * State the background publishes for the front (docs/design/engine-split.md,
 * part 3, "State from background to front"): scheduler status, the judge's
 * backlog, pending count, rate and spending, capture status, unreadable-file
 * counts and Sync now runs. The background writes the whole snapshot
 * atomically every few seconds; the
 * front reads the last one and shows how old it is. No front request waits
 * on the background for status.
 */
import { readFileSync } from 'node:fs';
import { writePrivateFileAtomicSync } from '../../core/atomic-file.ts';

export const ENGINE_STATUS_SNAPSHOT_SCHEMA = 'olympus.engine.background-status.v1';
export const ENGINE_STATUS_PUBLISH_INTERVAL_MS = 3_000;
/**
 * A snapshot older than this (ten missed publishes) no longer says how things
 * are now: the background stopped publishing or cannot write the file.
 */
export const ENGINE_STATUS_STALE_MS = 30_000;

export interface EngineStatusSnapshot {
  schema: typeof ENGINE_STATUS_SNAPSHOT_SCHEMA;
  /** The background instance that wrote it; a new one means it restarted. */
  instance_id: string;
  written_at: string;
  /**
   * When the engine's loop collected this state. The control thread
   * (control-worker.ts) writes the snapshot again every interval whether the
   * loop turns or not, so `written_at` says the background is alive and this
   * says how old what it shows is. Absent when the loop wrote the file itself.
   */
  state_at?: string;
  /** How long the engine's loop had gone without a turn at `written_at` (the control thread's reading). */
  loop_held_ms?: number;
  /**
   * The loop could not collect its state (the collect threw): how many times
   * in a row, the error's class and code, and when it last did. The state
   * shown is the last one collected, or an empty one when there never was one.
   */
  state_error?: { attempts: number; error: string; at: string };
  /**
   * What answers commands and writes this file: the control thread, or the
   * engine's own loop when the thread could not start or ended. On the loop,
   * commands and status wait whenever the engine is busy, so health says so.
   */
  control_plane?: 'thread' | 'loop';
  scheduler: unknown;
  judge: {
    backlog: unknown;
    pending: number | null;
    spending: unknown;
    /** The judge is ahead of the lanes (it has priority): the front's "busy classifying". */
    busy?: boolean;
    /** Whether the judge can take imported archive items now (archive-import/dashboard.ts). */
    archive_private_model?: string;
  };
  captures: unknown;
  /** Each corpus's last unreadable count (file-extraction/unreadable-files.ts), counted in the background. */
  unreadable?: Record<string, { unreadable: number; blocked: number }>;
  /** Sync now runs the background started for the front, by scheduler source id: the latest per source. */
  manual_syncs?: Record<string, EngineManualSyncRun>;
  /** How many times a background restarted itself on memory, carried from one to the next (rss-restart.ts). */
  rss_restarts?: { count: number; last?: { at: string; rss_mb: number } };
  /** How late the background's loop turned (control-path-headroom.ts): the last beat, the worst since start, beats over 250 ms. */
  loop_lag?: { last_ms: number; max_ms: number; over_budget: number };
  /** Statements that held the background's loop past the slow-log threshold (main-thread-sql-trace.ts). */
  loop_slow_sql?: import('../connector-store/main-thread-sql-trace.ts').SlowMainThreadSqlHealth;
  /** The background's largest WALs and longest-held reads at its last sample. */
  sqlite_files?: ReturnType<typeof import('../engine/sqlite-wal-sampler.ts').sqliteFilesHealth>;
  /** How many stores and sidecars the background has opened (source-storage.ts): the front looks for new ones when it changes. */
  stores_opened?: number;
  /** The background's paced status recount (status-recount.ts). */
  status_recount?: { runs: number; failures: number; last_ms?: number; age_ms?: number; counting: boolean };
}

export interface EngineManualSyncRun {
  started_at: string;
  state: 'running' | 'done' | 'failed';
  /** `failed` only: the error's code, when it had one, for the front's closed failure word. */
  failure_code?: string;
}

export interface EngineStatusRead {
  snapshot: EngineStatusSnapshot;
  /** How old the snapshot's last write is: the background published this long ago. */
  age_ms: number;
  /**
   * How old the state in it is, for the front to show ("status is N s old"):
   * a background whose loop is held keeps publishing its last state, and
   * this grows. The same as `age_ms` when the snapshot does not say.
   */
  state_age_ms?: number;
  /**
   * Not a reading of this background: last written more than
   * ENGINE_STATUS_STALE_MS ago, or written by a background other than the one
   * answering commands. The front then shows nothing from it as current. A
   * background that is alive with its loop held is not stale: it publishes
   * its last state, and `state_age_ms` says how old that is.
   */
  stale: boolean;
}

export function writeEngineStatusSnapshot(path: string, snapshot: EngineStatusSnapshot): void {
  writePrivateFileAtomicSync(path, `${JSON.stringify(snapshot)}\n`);
}

/** The last snapshot, or undefined when there is none or it cannot be read. Never throws. */
export function readEngineStatusSnapshot(path: string, now: () => number = () => Date.now()): EngineStatusRead | undefined {
  try {
    const snapshot = JSON.parse(readFileSync(path, 'utf8')) as EngineStatusSnapshot;
    if (snapshot?.schema !== ENGINE_STATUS_SNAPSHOT_SCHEMA || typeof snapshot.instance_id !== 'string') return undefined;
    const written = Date.parse(snapshot.written_at);
    if (!Number.isFinite(written)) return undefined;
    const at = now();
    const age = Math.max(0, at - written);
    const collected = typeof snapshot.state_at === 'string' ? Date.parse(snapshot.state_at) : Number.NaN;
    return { snapshot, age_ms: age, state_age_ms: Number.isFinite(collected) ? Math.max(0, at - collected) : age, stale: age > ENGINE_STATUS_STALE_MS };
  } catch {
    return undefined;
  }
}

/**
 * A failed collect or write, for the log and the snapshot: the error's class
 * and code; the message only for the runtime's own type and range errors,
 * which describe the code and not the data. Any other message can carry a
 * path or a name.
 */
export function describeSnapshotFailure(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  const runtime = error instanceof TypeError || error instanceof RangeError;
  return `${error instanceof Error ? error.name : 'unknown error'}${typeof code === 'string' ? ` ${code}` : ''}${runtime ? `: ${error.message.slice(0, 120)}` : ''}`;
}

export interface EngineStatusPublisherOptions {
  path: string;
  instanceId: string;
  collect: () => Omit<EngineStatusSnapshot, 'schema' | 'instance_id' | 'written_at'>;
  /**
   * Hands the collected state to the control thread, which writes the file
   * (control-plane.ts). Absent, or answering false (the thread is gone), the
   * loop writes the file itself.
   */
  hand?: (state: Record<string, unknown>, at: number) => boolean;
  /** Tells the control thread a collect failed, so the snapshot it keeps publishing says so. */
  handFailure?: (failure: { attempts: number; error: string; at: number }) => void;
  now?: () => Date;
  intervalMs?: number;
  setInterval?: (callback: () => void, ms: number) => unknown;
  clearInterval?: (timer: unknown) => void;
  log?: (line: string) => void;
}

/**
 * The background's publisher: one snapshot at once, then every interval. A
 * failed collect or write keeps the last file. The collect runs on the
 * engine's loop; with a control thread the write does not.
 */
export function startEngineStatusPublisher(options: EngineStatusPublisherOptions): { publish(): void; stop(): void } {
  const now = options.now ?? (() => new Date());
  // A snapshot that cannot be written is said at once, then once a minute
  // with the count for as long as it lasts, and once when it is written again:
  // the front shows a stale status meanwhile, and the log must say why.
  let failures = 0;
  let saidAtMs = 0;
  const publish = () => {
    const at = now();
    try {
      const state = options.collect();
      if (!options.hand?.(state as Record<string, unknown>, at.getTime())) {
        writeEngineStatusSnapshot(options.path, {
          schema: ENGINE_STATUS_SNAPSHOT_SCHEMA,
          instance_id: options.instanceId,
          written_at: at.toISOString(),
          ...state,
        });
      }
      if (failures > 0) options.log?.(`[engine-split] status snapshot written again after ${failures} failed attempt(s)`);
      failures = 0;
    } catch (error) {
      failures += 1;
      const atMs = at.getTime();
      const what = describeSnapshotFailure(error);
      // The control thread keeps publishing the last state: the snapshot itself then says its state could not be collected.
      options.handFailure?.({ attempts: failures, error: what, at: atMs });
      if (failures === 1 || atMs - saidAtMs >= 60_000) {
        saidAtMs = atMs;
        options.log?.(`[engine-split] status snapshot not written (${failures} attempt(s) in a row): ${what}`);
      }
    }
  };
  publish();
  const setTimer = options.setInterval ?? ((callback, ms) => { const timer = setInterval(callback, ms); timer.unref?.(); return timer; });
  const clearTimer = options.clearInterval ?? ((timer) => clearInterval(timer as ReturnType<typeof setInterval>));
  const timer = setTimer(publish, options.intervalMs ?? ENGINE_STATUS_PUBLISH_INTERVAL_MS);
  return { publish, stop: () => clearTimer(timer) };
}
