/**
 * State the background publishes for the front (docs/design/engine-split.md,
 * part 3, "State from background to front"): scheduler status, the judge's
 * backlog, pending count, rate and spending, capture status, unreadable-file
 * counts, the archive dashboard view, and Sync now runs. The
 * background writes the whole snapshot atomically every few seconds; the
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
  /** The archive dashboard as the background, which runs the imports, sees it. */
  archive?: { view: unknown; cards: unknown[]; source_imports: unknown[]; sources: unknown[] };
  /** Sync now runs the background started for the front, by scheduler source id: the latest per source. */
  manual_syncs?: Record<string, EngineManualSyncRun>;
  /** How many times a background restarted itself on memory, carried from one to the next (rss-restart.ts). */
  rss_restarts?: { count: number; last?: { at: string; rss_mb: number } };
}

export interface EngineManualSyncRun {
  started_at: string;
  state: 'running' | 'done' | 'failed';
  /** `failed` only: the error's code, when it had one, for the front's closed failure word. */
  failure_code?: string;
}

export interface EngineStatusRead {
  snapshot: EngineStatusSnapshot;
  /** How old the snapshot is, for the front to show. */
  age_ms: number;
  /**
   * Not a reading of now: older than ENGINE_STATUS_STALE_MS, or written by a
   * background other than the one answering commands. The front then shows
   * nothing from it as current.
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
    const age = Math.max(0, now() - written);
    return { snapshot, age_ms: age, stale: age > ENGINE_STATUS_STALE_MS };
  } catch {
    return undefined;
  }
}

export interface EngineStatusPublisherOptions {
  path: string;
  instanceId: string;
  collect: () => Omit<EngineStatusSnapshot, 'schema' | 'instance_id' | 'written_at'>;
  now?: () => Date;
  intervalMs?: number;
  setInterval?: (callback: () => void, ms: number) => unknown;
  clearInterval?: (timer: unknown) => void;
  log?: (line: string) => void;
}

/** The background's publisher: one snapshot at once, then every interval. A failed collect or write keeps the last file. */
export function startEngineStatusPublisher(options: EngineStatusPublisherOptions): { publish(): void; stop(): void } {
  const now = options.now ?? (() => new Date());
  let warned = false;
  const publish = () => {
    try {
      writeEngineStatusSnapshot(options.path, {
        schema: ENGINE_STATUS_SNAPSHOT_SCHEMA,
        instance_id: options.instanceId,
        written_at: now().toISOString(),
        ...options.collect(),
      });
      warned = false;
    } catch (error) {
      if (!warned) options.log?.(`[engine-split] status snapshot not written: ${error instanceof Error ? error.message : 'unknown error'}`);
      warned = true;
    }
  };
  publish();
  const setTimer = options.setInterval ?? ((callback, ms) => { const timer = setInterval(callback, ms); timer.unref?.(); return timer; });
  const clearTimer = options.clearInterval ?? ((timer) => clearInterval(timer as ReturnType<typeof setInterval>));
  const timer = setTimer(publish, options.intervalMs ?? ENGINE_STATUS_PUBLISH_INTERVAL_MS);
  return { publish, stop: () => clearTimer(timer) };
}
