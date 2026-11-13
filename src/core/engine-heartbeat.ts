// The engine's heartbeat: written by a small Worker thread, not by the
// engine's own loop, so it keeps beating while that loop sits in one long
// synchronous SQLite call (a store backup, a migration, row checks). It says
// which process is alive, what it is doing, and how long its loop has been
// held. The supervisor and the upgrade's wait read it instead of judging a
// process by how fast it answers: a slow answer is not a dead process.
//
// The worker (single) or the split's background writes it; the front does
// not, since it does no long work of its own. The file holds a pid, times and
// a step label made of store ids, never a path, a source name or item content.
// The Worker never touches SQLite or anything else that can block.

import { readFileSync } from 'node:fs';
import { sharedDataPath, type LayoutEnv } from './olympus-layout.ts';

export const ENGINE_HEARTBEAT_SCHEMA = 'olympus.engine-heartbeat.v1';
/** How often the Worker writes the file. */
const HEARTBEAT_WRITE_MS = 1_000;
/** How often the engine's loop ticks: a tick that stops means the loop is held. */
const LOOP_TICK_MS = 250;
/** A heartbeat older than this has stopped: its process is gone or frozen. */
export const HEARTBEAT_STALE_MS = 15_000;
const STEP_BYTES = 200;

export interface EngineHeartbeat {
  schema: typeof ENGINE_HEARTBEAT_SCHEMA;
  pid: number;
  role: string;
  startedAt: string;
  writtenAt: string;
  /** How long the engine's loop has gone without a turn. */
  blockedMs: number;
  /** What the engine says it is doing ("backing up tier-ledger"), and since when. */
  step?: string;
  stepSince?: string;
}

// [0] loop ticks, [1] step length in bytes, [2] step changes; then the step's bytes.
let beat: { ints: Int32Array; bytes: Uint8Array; tick: ReturnType<typeof setInterval>; worker: Worker } | undefined;

const HEARTBEAT_WORKER_SOURCE = `
import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
self.onmessage = ({ data }) => {
  const { sab, path, pid, role, writeMs, startedAt } = data;
  const ints = new Int32Array(sab, 0, 4);
  const bytes = new Uint8Array(sab, 16);
  const decoder = new TextDecoder();
  let lastTick = -1, lastTickAt = Date.now(), lastChange = -1, stepSince = Date.now();
  const write = () => {
    const now = Date.now();
    const tick = Atomics.load(ints, 0);
    if (tick !== lastTick) { lastTick = tick; lastTickAt = now; }
    const change = Atomics.load(ints, 2);
    if (change !== lastChange) { lastChange = change; stepSince = now; }
    const length = Atomics.load(ints, 1);
    const step = length > 0 ? decoder.decode(bytes.slice(0, length)) : undefined;
    const body = { schema: '${ENGINE_HEARTBEAT_SCHEMA}', pid, role, startedAt, writtenAt: new Date(now).toISOString(),
      blockedMs: Math.max(0, now - lastTickAt - ${LOOP_TICK_MS}),
      ...(step ? { step, stepSince: new Date(stepSince).toISOString() } : {}) };
    try {
      const partial = path + '.' + pid + '.tmp';
      writeFileSync(partial, JSON.stringify(body) + '\\n', { mode: 0o600 });
      renameSync(partial, path);
    } catch {}
  };
  try { mkdirSync(dirname(path), { recursive: true, mode: 0o700 }); } catch {}
  write();
  setInterval(write, writeMs);
};
`;

/** Starts this process's heartbeat. Once per process; a second call does nothing. */
export function startEngineHeartbeat(env: LayoutEnv, role: string): void {
  if (beat || typeof Worker === 'undefined') return;
  try {
    const sab = new SharedArrayBuffer(16 + STEP_BYTES);
    const ints = new Int32Array(sab, 0, 4);
    const bytes = new Uint8Array(sab, 16);
    const worker = new Worker(URL.createObjectURL(new Blob([HEARTBEAT_WORKER_SOURCE], { type: 'text/javascript' })));
    // It must never hold the process open: it goes when the process goes.
    (worker as Worker & { unref?: () => void }).unref?.();
    worker.postMessage({ sab, path: sharedDataPath('engine-heartbeat', env), pid: process.pid, role, writeMs: HEARTBEAT_WRITE_MS, startedAt: new Date().toISOString() });
    const tick = setInterval(() => { Atomics.add(ints, 0, 1); }, LOOP_TICK_MS);
    tick.unref?.();
    beat = { ints, bytes, tick, worker };
  } catch {
    // No heartbeat: the waits then see no live process and fall back to their caps.
  }
}

/** What the engine is doing now, said before a long step; `undefined` clears it. */
export function setEngineStep(step: string | undefined): void {
  if (!beat) return;
  const encoded = new TextEncoder().encode(step ?? '').slice(0, STEP_BYTES);
  beat.bytes.set(encoded);
  Atomics.store(beat.ints, 1, encoded.length);
  Atomics.add(beat.ints, 2, 1);
}

/** Stops the heartbeat (tests; a process that exits takes it with it). */
export function stopEngineHeartbeat(): void {
  if (!beat) return;
  clearInterval(beat.tick);
  beat.worker.terminate();
  beat = undefined;
}

export function readEngineHeartbeat(env: LayoutEnv = process.env): EngineHeartbeat | undefined {
  try {
    const value = JSON.parse(readFileSync(sharedDataPath('engine-heartbeat', env), 'utf8')) as Partial<EngineHeartbeat>;
    if (value.schema !== ENGINE_HEARTBEAT_SCHEMA || typeof value.pid !== 'number' || typeof value.writtenAt !== 'string'
      || typeof value.startedAt !== 'string' || typeof value.blockedMs !== 'number') return undefined;
    return value as EngineHeartbeat;
  } catch {
    return undefined;
  }
}

/**
 * The heartbeat is beating: written in the last HEARTBEAT_STALE_MS by a live
 * process, and by `pid` when one is named. Busy or not does not matter.
 */
export function engineHeartbeatBeating(
  heartbeat: EngineHeartbeat | undefined,
  options: { pid?: number; now?: number; alive?: (pid: number) => boolean } = {},
): boolean {
  if (!heartbeat) return false;
  if (options.pid !== undefined && heartbeat.pid !== options.pid) return false;
  if ((options.now ?? Date.now()) - Date.parse(heartbeat.writtenAt) >= HEARTBEAT_STALE_MS) return false;
  return (options.alive ?? processAlive)(heartbeat.pid);
}

/** The longest a start is waited for: 30 minutes, plus a minute per GB of stores. */
export const STARTUP_CAP_BASE_MS = 30 * 60_000;
export const STARTUP_CAP_PER_GB_MS = 60_000;

export function startupCapMs(storeBytes: number): number {
  return STARTUP_CAP_BASE_MS + Math.ceil(storeBytes / 1024 ** 3) * STARTUP_CAP_PER_GB_MS;
}

/**
 * What a supervisor's start wait asks once a child's deadline has passed
 * without an answer: keep waiting? Yes for a live child until the cap, on
 * the supervisor's own monotonic clock, whatever its heartbeat says. A
 * stopped heartbeat during a start is reported, never a reason to replace
 * it: that is where the heavy disk work is, and a kill there means a
 * rollback. A laptop that slept, or a clock that jumped, changes nothing.
 * A child that exits is replaced by the kernel at once.
 */
export function createStartupWatch(input: {
  env: LayoutEnv;
  capMs: () => number;
  now?: () => number;
  log?: (line: string) => void;
}): (pid: number | undefined) => boolean {
  const now = input.now ?? (() => performance.now());
  const log = input.log ?? ((line: string) => console.log(line));
  const firstAsked = new Map<number, { at: number; capMs: number }>();
  return (pid) => {
    if (pid === undefined || !processAlive(pid)) return false;
    let watch = firstAsked.get(pid);
    if (!watch) { watch = { at: now(), capMs: input.capMs() }; firstAsked.set(pid, watch); }
    const heartbeat = readEngineHeartbeat(input.env);
    const state = heartbeat?.pid !== pid ? 'no heartbeat from it yet'
      : engineHeartbeatBeating(heartbeat, { pid }) ? engineHeartbeatLine(heartbeat)
        : `its heartbeat was last written at ${heartbeat.writtenAt}`;
    if (now() - watch.at >= watch.capMs) {
      log(`[native-process] the worker has not answered within ${Math.round(watch.capMs / 60_000)} min of waiting; giving up on this start: ${state}`);
      return false;
    }
    log(`[native-process] the worker is alive and has not answered yet: ${state}`);
    return true;
  };
}

/** One line for a person waiting: "busy 86 s: backing up tier-ledger". */
export function engineHeartbeatLine(heartbeat: EngineHeartbeat, now: number = Date.now()): string {
  const step = heartbeat.step ?? 'working';
  const since = heartbeat.stepSince ? Math.max(0, Math.round((now - Date.parse(heartbeat.stepSince)) / 1000)) : undefined;
  return since === undefined ? step : `${step} (${since} s)`;
}

export function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}
