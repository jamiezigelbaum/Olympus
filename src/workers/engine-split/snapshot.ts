/**
 * State the background publishes for the front (docs/design/engine-split.md,
 * part 3, "State from background to front"): scheduler status, the judge's
 * backlog, pending count, rate and spending, and capture status. The
 * background writes the whole snapshot atomically every few seconds; the
 * front reads the last one and shows how old it is. No front request waits
 * on the background for status.
 */
import { readFileSync } from 'node:fs';
import { writePrivateFileAtomicSync } from '../../core/atomic-file.ts';

export const ENGINE_STATUS_SNAPSHOT_SCHEMA = 'olympus.engine.background-status.v1';
export const ENGINE_STATUS_PUBLISH_INTERVAL_MS = 3_000;

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
  };
  captures: unknown;
}

export interface EngineStatusRead {
  snapshot: EngineStatusSnapshot;
  /** How old the snapshot is, for the front to show. */
  age_ms: number;
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
    return { snapshot, age_ms: Math.max(0, now() - written) };
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
