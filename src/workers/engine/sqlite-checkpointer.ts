// Checkpoints off the loop (16 Nov 2026 gate: a 6 GB ledger WAL, and every
// commit past 1000 pages ran SQLite's automatic checkpoint inline on the
// committing thread, so keyed writes on the loop took 1 to 3 s on a busy
// disk). In the engine's background the loop's writable connections turn the
// automatic checkpoint off (core/sqlite-store.ts, loopWalAutocheckpointPragma)
// and worker threads checkpoint each file PASSIVE: PASSIVE never waits on a
// reader or the writer and never takes the writer lock.
//
// PASSIVE alone does not bound a WAL (gate on ced5a461: 134 to 379 MB against
// a 64 MB limit, every pass busy=0 and most of them complete). SQLite rewinds
// a WAL only when a write transaction starts while every frame is already
// copied and no read still uses the file. A writer that keeps committing adds
// frames during each pass, so that moment never comes and the file grows
// until writing pauses by chance. So the policy has two parts:
//
// 1. Passes follow the writing. A file that changed since its last pass is
//    checkpointed again a second later (SQLite's own default checkpoints
//    every 4 MB), a quiet one every five seconds.
// 2. Bulk work makes room. Once a file's WAL holds SQLITE_WAL_ROOM_BYTES that
//    a rewind would free, the loop's next turn (control-path-headroom.ts,
//    ingestionTurn) waits, as an awaited promise and never a blocked thread,
//    for one pass over that file and for the reads already open on it to
//    end. No bulk write lands meanwhile, so the pass ends complete and the
//    writer's next commit rewinds the WAL; journal_size_limit then cuts a
//    grown file back. This is backpressure: the disk has to take those pages
//    anyway, and the wait is one pass long.
//
// A WAL a long read holds cannot be rewound by anyone. That file is named in
// the log with the read's site and bulk work does not wait on it.

import { oldestOffThreadSnapshot } from '../connector-store/off-thread-reads.ts';

/** WAL file size below which a pass is skipped (SQLite's own default is 1000 pages, about 4 MB). */
export const SQLITE_CHECKPOINT_AT_BYTES = 4 * 1024 * 1024;
/** WAL content at which bulk work waits for a pass, so the next commit rewinds the file. Passes trail the writing by a second, so this sits well under the 64 MB limit. */
export const SQLITE_WAL_ROOM_BYTES = 24 * 1024 * 1024;
/** A file that changed since its last pass is checkpointed again this soon; a quiet one at the idle pace. */
export const SQLITE_CHECKPOINT_HOT_MS = 1_000;
export const SQLITE_CHECKPOINT_IDLE_MS = 5_000;
/**
 * How long bulk work stands back for reads that were open when a pass ended
 * (they hold the WAL until they finish). Pacing, not a cancel: when it passes
 * the work goes on, the rewind is tried again after the next pass, and the
 * miss is counted.
 */
export const SQLITE_WAL_ROOM_READER_WAIT_MS = 2_000;
const READER_POLL_MS = 20;
/** One long catch-up pass (a WAL already large at an upgrade) must not hold every other file's passes. */
const WORKERS = 2;
/** A checkpoint is logged when it ran this long or the WAL was this large. */
const CHECKPOINT_NOTABLE_MS = 1_000;
const CHECKPOINT_NOTABLE_BYTES = 32 * 1024 * 1024;
/** Passes one wait may take to find the WAL level; each after the first copies only what landed during the one before. */
const ROOM_PASSES = 6;
const ROOM_NOTABLE_MS = 1_000;
const ROOM_SUMMARY_MS = 60_000;

// One writable connection per file and worker, kept for the next pass (opening
// and closing SQLite connections on worker threads is what Bun 1.3 crashed
// on), reopened when the path names a different file. The worker stores the
// id of each pass it finished before it answers, so a lost answer is told
// from a pass still running.
const WORKER_SOURCE = `
import { Database } from 'bun:sqlite';
import { statSync } from 'node:fs';
const connections = new Map();
let finished;
self.onmessage = ({ data }) => {
  if (data.finished) { finished = new Int32Array(data.finished); return; }
  const { id, path, atBytes } = data;
  let reply;
  try {
    let walBytes = 0;
    try { walBytes = statSync(path + '-wal').size; } catch (error) { if (!error || error.code !== 'ENOENT') throw error; }
    if (walBytes < atBytes) {
      reply = { id, ok: true, skipped: true, walBytes };
    } else {
      const stat = statSync(path);
      const file = stat.dev + ':' + stat.ino;
      let held = connections.get(path);
      if (held && held.file !== file) { try { held.db.close(); } catch {} held = undefined; }
      if (!held) {
        const db = new Database(path, { create: false });
        db.exec('PRAGMA busy_timeout = 0; PRAGMA journal_size_limit = 67108864; PRAGMA wal_autocheckpoint = 0;');
        held = { db, file, frameBytes: db.query('PRAGMA page_size').get().page_size + 24 };
        connections.set(path, held);
      }
      const started = performance.now();
      // PASSIVE only. TRUNCATE takes the writer lock and holds it through its
      // fsync and truncate, which on a busy disk outlasted a loop writer's 10 s
      // busy wait: syncs failed with "database is locked" on the lane 6 gate
      // (16 Nov).
      const row = held.db.query('PRAGMA wal_checkpoint(PASSIVE)').get();
      reply = { id, ok: true, ms: performance.now() - started, busy: row.busy, log: row.log, checkpointed: row.checkpointed, walBytes, frameBytes: held.frameBytes };
    }
  } catch (error) {
    reply = { id, ok: false, error: error && error.name ? error.name : 'Error' };
  }
  if (finished) Atomics.store(finished, 0, id);
  postMessage(reply);
};`;

export interface SqliteCheckpointFile { label: string; dbPath: string }

export interface SqliteCheckpointRoomStats { waits: number; totalMs: number; worstMs: number; rewinds: number; rewindsMissed: number }

export interface SqliteCheckpointer {
  /** The files to keep checkpointed; called whenever the set may have changed. */
  tick(files: readonly SqliteCheckpointFile[]): void;
  /**
   * Undefined while no WAL needs room (one field read, for a hot loop).
   * Otherwise a promise that settles once the fullest WAL has had a pass with
   * no bulk write in it; every caller waits on the same one. Never rejects.
   */
  room(): Promise<void> | undefined;
  roomStats(): SqliteCheckpointRoomStats;
  stop(): void;
}

interface PassReply {
  id: number; ok: boolean; skipped?: boolean; lost?: boolean; ms?: number; busy?: number; log?: number; checkpointed?: number;
  walBytes?: number; frameBytes?: number; error?: string;
}

interface FileState extends SqliteCheckpointFile {
  /** WAL content a rewind would free, as of the last pass. */
  live: number;
  lastLog: number | undefined;
  lastCheckpointed: number | undefined;
  lastPassAt: number;
  hot: boolean;
  /** A read holds the WAL: passes copy nothing new, so bulk work does not wait on this file. */
  held: boolean;
  /** A WAL already large at open is caught up by one free-running pass before any work waits on it. */
  firstDone: boolean;
  /** Bulk work made room; the next pass says whether the writer's commit rewound the file. */
  awaitRewind: boolean;
  running: boolean;
  queued: Job | undefined;
}

interface Job { id: number; state: FileState; resolve: (reply: PassReply) => void; seenFinished: number }
interface PoolWorker { worker: Worker; finished: Int32Array | undefined; job: Job | undefined }

export function startSqliteCheckpointer(options: {
  log?: (line: string) => void; atBytes?: number; roomBytes?: number; hotMs?: number; idleMs?: number; readerWaitMs?: number;
} = {}): SqliteCheckpointer | undefined {
  if (typeof Worker === 'undefined') return undefined;
  const log = options.log ?? ((line: string) => console.warn(line));
  const atBytes = options.atBytes ?? SQLITE_CHECKPOINT_AT_BYTES;
  const roomBytes = options.roomBytes ?? SQLITE_WAL_ROOM_BYTES;
  const hotMs = options.hotMs ?? SQLITE_CHECKPOINT_HOT_MS;
  const idleMs = options.idleMs ?? SQLITE_CHECKPOINT_IDLE_MS;
  const readerWaitMs = options.readerWaitMs ?? SQLITE_WAL_ROOM_READER_WAIT_MS;
  const now = (): number => performance.now();

  const states = new Map<string, FileState>();
  const queue: Job[] = [];
  const pool: PoolWorker[] = [];
  let nextId = 1;
  let stopped = false;
  let needRoom: FileState | undefined;
  let gate: Promise<void> | undefined;
  const stats: SqliteCheckpointRoomStats = { waits: 0, totalMs: 0, worstMs: 0, rewinds: 0, rewindsMissed: 0 };
  let summarized = { ...stats };
  let summarizedAt = now();

  const finish = (entry: PoolWorker, reply: PassReply): void => {
    const job = entry.job;
    if (!job || job.id !== reply.id) return;
    entry.job = undefined;
    job.state.running = false;
    job.resolve(reply);
    pump();
  };
  const retire = (entry: PoolWorker): void => {
    const index = pool.indexOf(entry);
    if (index < 0) return;
    pool.splice(index, 1);
    try { entry.worker.terminate(); } catch { /* already gone */ }
    const job = entry.job;
    entry.job = undefined;
    if (job) { job.state.running = false; job.resolve({ id: job.id, ok: false, error: 'WorkerStopped' }); }
    if (pool.length === 0 && !stopped) {
      // No silent stop: without a worker nothing checkpoints these files, and no work waits on room.
      needRoom = undefined;
      log('[olympus] sqlite checkpoint: every checkpoint worker stopped; WALs are not being checkpointed until the engine restarts.');
    }
    pump();
  };
  try {
    for (let n = 0; n < WORKERS; n += 1) {
      const worker = new Worker(URL.createObjectURL(new Blob([WORKER_SOURCE], { type: 'text/javascript' })));
      (worker as unknown as { unref?: () => void }).unref?.();
      const entry: PoolWorker = { worker, finished: undefined, job: undefined };
      if (typeof SharedArrayBuffer === 'function') {
        const buffer = new SharedArrayBuffer(4);
        entry.finished = new Int32Array(buffer);
        worker.postMessage({ finished: buffer });
      }
      worker.onmessage = ({ data }) => finish(entry, data as PassReply);
      worker.onerror = () => retire(entry);
      pool.push(entry);
    }
  } catch {
    for (const entry of pool) { try { entry.worker.terminate(); } catch { /* already gone */ } }
    return undefined;
  }

  function pump(): void {
    if (stopped) return;
    for (const entry of pool) {
      if (entry.job) continue;
      // Two passes never run on one file at once.
      const index = queue.findIndex((job) => !job.state.running);
      if (index < 0) return;
      const job = queue.splice(index, 1)[0]!;
      job.state.queued = undefined;
      job.state.running = true;
      entry.job = job;
      entry.worker.postMessage({ id: job.id, path: job.state.dbPath, atBytes });
    }
  }

  /** One pass over a file. A pass that makes room goes ahead of the paced ones and replaces this file's waiting one. */
  function pass(state: FileState, makesRoom: boolean): Promise<PassReply> {
    return new Promise((resolve) => {
      if (stopped || pool.length === 0) { resolve({ id: 0, ok: false, error: 'WorkerStopped' }); return; }
      const waiting = state.queued;
      if (waiting) {
        queue.splice(queue.indexOf(waiting), 1);
        waiting.resolve({ id: waiting.id, ok: true, lost: true });
      }
      const job: Job = { id: nextId++, state, resolve, seenFinished: 0 };
      state.queued = job;
      if (makesRoom) queue.unshift(job); else queue.push(job);
      pump();
    });
  }

  function chooseRoom(): void {
    needRoom = undefined;
    if (stopped || pool.length === 0) return;
    for (const state of states.values()) {
      if (!state.firstDone || state.held || state.awaitRewind || state.live < roomBytes) continue;
      if (!needRoom || state.live > needRoom.live) needRoom = state;
    }
  }

  function record(state: FileState, reply: PassReply, madeRoom: boolean): void {
    state.lastPassAt = now();
    if (!reply.ok) {
      log(`[olympus] sqlite checkpoint: ${state.label} failed (${reply.error ?? 'Error'}); tried again at the next pass.`);
      return;
    }
    if (reply.lost) return;
    const expectedRewind = state.awaitRewind;
    state.awaitRewind = madeRoom;
    state.firstDone = true;
    if (reply.skipped) {
      if (expectedRewind) stats.rewinds += 1;
      state.live = 0; state.hot = false; state.held = false; state.lastLog = undefined; state.lastCheckpointed = undefined;
      return;
    }
    const frames = Math.max(0, reply.log ?? 0);
    const copied = Math.max(0, reply.checkpointed ?? 0);
    const rewound = state.lastLog !== undefined && frames < state.lastLog;
    if (expectedRewind && !madeRoom) { if (rewound) stats.rewinds += 1; else stats.rewindsMissed += 1; }
    // Frames left over while the copied count stands still: a read holds them. (A writer adding frames during the pass moves the count.)
    const stuck = copied < frames && !rewound && state.lastCheckpointed !== undefined && copied <= state.lastCheckpointed;
    const held = reply.busy === 1 || stuck;
    const walBytes = reply.walBytes ?? 0;
    if (held && !state.held) {
      const read = oldestOffThreadSnapshot(state.dbPath);
      log(`[olympus] sqlite wal held: ${state.label} wal_bytes=${walBytes} frames=${frames} checkpointed=${copied} oldest_read_ms=${Math.round(read?.ageMs ?? 0)}${read ? ` oldest_read_lane=${read.lane} oldest_read_site=${read.site}` : ' (no read open in this process)'}; no work waits on this file until the read ends.`);
    }
    if ((reply.ms ?? 0) >= CHECKPOINT_NOTABLE_MS || (walBytes >= CHECKPOINT_NOTABLE_BYTES && state.lastCheckpointed !== copied)) {
      log(`[olympus] sqlite checkpoint: ${state.label} wal_bytes=${walBytes} ms=${Math.round(reply.ms ?? 0)} busy=${reply.busy} frames=${frames} checkpointed=${copied}`);
    }
    state.hot = state.lastLog === undefined || frames !== state.lastLog || copied < frames;
    state.held = held;
    state.live = frames * (reply.frameBytes ?? 4120);
    state.lastLog = frames;
    state.lastCheckpointed = copied;
  }

  function paced(state: FileState): void {
    void pass(state, false).then((reply) => { record(state, reply, false); chooseRoom(); });
  }

  /** Reads opened before the pass ended still use the WAL; ones opened after it read the database file and hold nothing. */
  async function readsFromBeforeEnd(dbPath: string, endedAt: number): Promise<number> {
    const started = now();
    for (;;) {
      const read = oldestOffThreadSnapshot(dbPath);
      const waited = now() - started;
      if (!read || read.ageMs < now() - endedAt || waited >= readerWaitMs || stopped) return waited;
      await new Promise<void>((resolve) => { setTimeout(resolve, READER_POLL_MS); });
    }
  }

  async function makeRoom(state: FileState): Promise<void> {
    const started = now();
    const live = state.live;
    // Bulk work is waiting, but a write outside a turn (a verdict arriving, an
    // owner's change) can still land during a pass and leave it a few frames
    // behind. A pass with nothing to copy takes about a millisecond, so pass
    // again until one finds the WAL as the last left it, fully copied.
    let level = false;
    let before: number | undefined;
    let reply = await pass(state, true);
    for (let again = 0; ; again += 1) {
      record(state, reply, true);
      if (!reply.ok || reply.lost || reply.skipped || state.held) break;
      const frames = reply.log ?? 0;
      if (before !== undefined && frames < before) break; // A write already rewound it.
      level = (reply.checkpointed ?? 0) >= frames && before === frames;
      if (level || again >= ROOM_PASSES - 1) break;
      before = frames;
      reply = await pass(state, true);
    }
    const passMs = now() - started;
    const readersMs = level ? await readsFromBeforeEnd(state.dbPath, now()) : 0;
    state.lastPassAt = now();
    const waited = now() - started;
    stats.waits += 1;
    stats.totalMs += waited;
    if (waited > stats.worstMs) stats.worstMs = waited;
    if (waited >= ROOM_NOTABLE_MS) {
      log(`[olympus] sqlite wal room: ${state.label} work waited_ms=${Math.round(waited)} pass_ms=${Math.round(passMs)} reads_ms=${Math.round(readersMs)} wal_content_bytes=${live}`);
    }
  }

  function drive(): void {
    if (stopped) return;
    const at = now();
    for (const entry of [...pool]) {
      const job = entry.job;
      // The worker stored this pass as finished and its answer has not come by the next beat: the answer was lost.
      if (job && entry.finished && Atomics.load(entry.finished, 0) === job.id && (job.seenFinished += 1) >= 2) {
        finish(entry, { id: job.id, ok: true, lost: true });
      }
    }
    for (const state of states.values()) {
      if (state.running || state.queued) continue;
      if (at - state.lastPassAt >= (state.hot || state.awaitRewind ? hotMs : idleMs)) paced(state);
    }
    if (at - summarizedAt >= ROOM_SUMMARY_MS) {
      const waits = stats.waits - summarized.waits;
      const missed = stats.rewindsMissed - summarized.rewindsMissed;
      if (waits > 0 || missed > 0) {
        log(`[olympus] sqlite wal room: last minute waits=${waits} total_ms=${Math.round(stats.totalMs - summarized.totalMs)} worst_ms=${Math.round(stats.worstMs)} rewinds=${stats.rewinds - summarized.rewinds} rewinds_missed=${missed}`);
      }
      summarized = { ...stats };
      summarizedAt = at;
    }
  }
  const timer = setInterval(drive, Math.min(hotMs, idleMs));
  timer.unref?.();

  return {
    tick(files) {
      if (stopped) return;
      const current = new Set<string>();
      for (const file of files) {
        current.add(file.dbPath);
        const known = states.get(file.dbPath);
        if (known) { known.label = file.label; continue; }
        states.set(file.dbPath, {
          ...file, live: 0, lastLog: undefined, lastCheckpointed: undefined, lastPassAt: -Infinity, hot: false, held: false,
          firstDone: false, awaitRewind: false, running: false, queued: undefined,
        });
      }
      for (const path of [...states.keys()]) if (!current.has(path)) states.delete(path);
      chooseRoom();
      drive();
    },
    room() {
      if (gate) return gate;
      const state = needRoom;
      if (!state) return undefined;
      needRoom = undefined;
      gate = makeRoom(state).catch((error: unknown) => {
        log(`[olympus] sqlite wal room: ${state.label} failed (${error instanceof Error ? error.name : 'Error'}); work goes on.`);
      }).then(() => { gate = undefined; chooseRoom(); });
      return gate;
    },
    roomStats: () => ({ ...stats }),
    stop() {
      stopped = true;
      clearInterval(timer);
      needRoom = undefined;
      for (const job of queue.splice(0)) job.resolve({ id: job.id, ok: false, error: 'WorkerStopped' });
      for (const entry of pool.splice(0)) {
        try { entry.worker.terminate(); } catch { /* already gone */ }
        if (entry.job) entry.job.resolve({ id: entry.job.id, ok: false, error: 'WorkerStopped' });
      }
    },
  };
}
