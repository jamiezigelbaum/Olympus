/**
 * Receiving an archive the person dropped on the dashboard
 * (docs/design/archive-import.md, "Upload, not a picker", owner 2026-10-26).
 *
 * The dashboard is a browser page, and a browser gives file contents, never
 * paths. So the files are streamed here, one request each, into a staging
 * folder in Olympus's own storage, keeping their relative paths. Nothing is
 * read from the person's disk by Olympus itself; the import then runs on the
 * staging folder exactly as it runs on a folder the agent tool names.
 *
 * - Every relative path is checked before a byte is written: no `..`, no
 *   absolute path, no empty or control-character name, and the resolved
 *   folder must stay inside the upload's own staging folder.
 * - A file is written as it arrives, a chunk at a time, awaiting each write:
 *   a tens-of-gigabytes archive costs one chunk of memory, and a slow disk
 *   slows the sender through ordinary backpressure.
 * - No size limits. The one stop is the computer's free disk: below the
 *   headroom the receive PAUSES (the sender simply waits), says so through
 *   `status`, and goes on by itself once space is free.
 * - A cancel, or an upload nobody finishes, removes the staging copy. A
 *   staging copy that an import still reads is kept (`sweep` is told which);
 *   one nothing reads is deleted.
 *
 * The route layer (email-source/index.ts) owns authentication: only the
 * dashboard's local-grade control session reaches this.
 */
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, realpathSync, rmSync, statSync, statfsSync, utimesSync } from 'node:fs';
import { open, type FileHandle } from 'node:fs/promises';
import { sep, join, resolve } from 'node:path';

/** Free space an upload leaves on the disk, so receiving never fills it (the built-in model download keeps the same headroom). */
export const ARCHIVE_UPLOAD_SPACE_HEADROOM_BYTES = 2 * 1024 ** 3;
/**
 * A file travels as pieces of this size, one request each, in order. An archive has no size limit (owner, 2026-10-26),
 * but the engine's server (Bun) keeps a request body it has been sent in memory until it is read, and does not hold
 * the sender back: a whole 50 GB file in one request could fill memory when the disk is slow or paused for space
 * (measured 2026-10-26: a stalled reader of a 1.5 GB body grew the server by 2.7 GB). Pieces keep what the engine
 * holds to a few of these at once, and the sender waits for each to be written before it sends the next.
 */
export const ARCHIVE_UPLOAD_CHUNK_BYTES = 8 * 1024 * 1024;
/** The most one piece may be, whatever a caller sends: past this the request is refused, and the file must be sent in smaller pieces. */
export const ARCHIVE_UPLOAD_MAX_CHUNK_BYTES = 64 * 1024 * 1024;
/** How often a running receive looks at the free space, in bytes written. */
const SPACE_CHECK_EVERY_BYTES = 16 * 1024 * 1024;
/** How long a receive that found the disk full waits before it looks again. */
const SPACE_POLL_MS = 2_000;
/** An upload no request has touched for this long was abandoned (the page closed): its staging copy is deleted. */
export const ARCHIVE_UPLOAD_IDLE_MS = 30 * 60_000;
/** The deepest folder nesting and longest path accepted; far past anything an export holds. */
const MAX_DEPTH = 64;
const MAX_PATH_CHARS = 4096;
const MAX_NAME_BYTES = 255;
const ID = /^[0-9a-f]{32}$/;

export type ArchiveUploadErrorCode =
  | 'bad_path'
  | 'duplicate_file'
  | 'bad_offset'
  | 'chunk_too_large'
  | 'unknown_upload'
  | 'upload_closed'
  | 'cancelled'
  | 'unreadable'
  | 'write_failed';

export class ArchiveUploadError extends Error {
  constructor(readonly code: ArchiveUploadErrorCode, message: string, readonly status = 400) {
    super(message);
    this.name = 'ArchiveUploadError';
  }
}

/** Plain words for every refusal; the codes are the contract. */
export const ARCHIVE_UPLOAD_COPY: Record<ArchiveUploadErrorCode, string> = {
  bad_path: 'Olympus could not take a file with that name or place in the folder. Choose the folder again.',
  duplicate_file: 'The same file came twice in one upload. Choose the folder again.',
  bad_offset: 'A part of a file arrived out of order. Choose the folder again.',
  chunk_too_large: 'A part of a file was larger than Olympus takes in one piece. Choose the folder again.',
  unknown_upload: 'This upload is no longer here. Choose the folder again.',
  upload_closed: 'This upload was already finished. Choose the folder again.',
  cancelled: 'This upload was cancelled.',
  unreadable: 'Olympus could not read what was sent. Choose the folder again.',
  write_failed: 'Olympus could not save the file on this computer. Check that its disk has room, then choose the folder again.',
};

/**
 * One upload's relative path as folder names: refused when it could leave the
 * staging folder or name nothing. Exported for its test.
 */
export function sanitizeUploadPath(raw: unknown): string[] {
  const bad = (): never => {
    throw new ArchiveUploadError('bad_path', ARCHIVE_UPLOAD_COPY.bad_path);
  };
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > MAX_PATH_CHARS) return bad();
  // Control characters (a NUL included) have no place in a name here.
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(raw)) return bad();
  // Absolute (POSIX, a Windows drive or a UNC share): an upload's paths are always relative.
  if (raw.startsWith('/') || raw.startsWith('\\') || /^[A-Za-z]:/.test(raw)) return bad();
  const parts = raw.split('/');
  if (parts.length > MAX_DEPTH) return bad();
  for (const part of parts) {
    if (part === '' || part === '.' || part === '..') return bad();
    // Backslash-separated traversal never reaches a name here either.
    if (part.split('\\').some((piece) => piece === '..')) return bad();
    if (Buffer.byteLength(part, 'utf8') > MAX_NAME_BYTES) return bad();
  }
  return parts;
}

export type ArchiveUploadState = 'receiving' | 'paused_disk_full' | 'idle';

export interface ArchiveUploadStatus {
  /** `paused_disk_full`: a file is waiting for free space on this computer and goes on by itself. */
  state: ArchiveUploadState;
  /** Files received whole. */
  files: number;
  /** Bytes received, the file in flight included. */
  bytes: number;
}

export interface ArchiveUploadsOptions {
  /** The staging folder (created when the first upload begins). */
  root: string;
  /** Free bytes on the volume holding `path` (default: statfs). */
  freeBytes?: (path: string) => number;
  headroomBytes?: number;
  /** Waits before the free space is looked at again (tests make it instant). */
  pause?: (ms: number) => Promise<void>;
  now?: () => number;
}

interface Session {
  id: string;
  dir: string;
  files: string;
  fileCount: number;
  bytes: number;
  /** Receives running now. */
  active: number;
  paused: boolean;
  cancelled: boolean;
  /** When a request last touched it (a receive started, a chunk arrived). */
  lastTouch: number;
  abort: Set<() => void>;
  paths: Set<string>;
  /** Files whose pieces are still arriving: the bytes written so far, and whether a piece is being written now. */
  partials: Map<string, { written: number; busy: boolean }>;
}

export interface ArchiveUploads {
  /** A new, empty upload. */
  begin(): { uploadId: string };
  /**
   * Streams one file, or one piece of it, into the upload. A file sent whole is `offset` 0 and `final` (the defaults);
   * a larger one comes as pieces in order, each at the `offset` the earlier ones ended at, the last one `final`. Resolves with
   * the bytes written once the stream has ended; a file whose piece breaks is deleted whole, and is sent again from its start.
   * `signal` is the request's: once the sender has gone, a wait for disk space ends instead of keeping the upload alive.
   */
  receive(uploadId: string, relPath: string, body: ReadableStream<Uint8Array> | null, options?: { modified?: number; declaredBytes?: number; offset?: number; final?: boolean; signal?: AbortSignal }): Promise<{ bytes: number }>;
  status(uploadId: string): ArchiveUploadStatus;
  /**
   * Stops what is running and removes the staging copy, unless `keep` says an
   * import reads it (given the copy's own folder). Answers whether it was removed.
   */
  cancel(uploadId: string, keep?: (stagingDir: string) => boolean): boolean;
  /**
   * The canonical path of what was uploaded (the folder dropped, or the one file),
   * for the import. Refuses an upload with a receive still running.
   */
  chosenPath(uploadId: string): string;
  /**
   * The upload is over and an import now reads its copy: it stops counting as an upload in progress, so the sweep
   * removes the copy as soon as nothing reads it, not only after the idle time.
   */
  handOver(uploadId: string): void;
  /** Deletes the upload's staging copy when `keep` does not say an import reads it. */
  release(uploadId: string, keep?: (stagingDir: string) => boolean): void;
  /**
   * Deletes every staging copy nobody needs: not an upload still in progress,
   * and not one `needed` says an import still reads (given the copy's own folder, whose canonical path
   * an import's root is inside).
   */
  sweep(needed: (stagingDir: string) => boolean): void;
  close(): void;
}

export function createArchiveUploads(options: ArchiveUploadsOptions): ArchiveUploads {
  const freeBytes = options.freeBytes ?? ((path: string): number => {
    const stats = statfsSync(path);
    return Number(stats.bavail) * Number(stats.bsize);
  });
  // A small volume (a 2 GB one) would never reach a fixed 2 GB headroom, so the default is also capped at a quarter of the volume.
  const headroomFor = (path: string): number => {
    if (options.headroomBytes !== undefined) return options.headroomBytes;
    if (options.freeBytes) return ARCHIVE_UPLOAD_SPACE_HEADROOM_BYTES;
    try {
      const stats = statfsSync(path);
      return Math.min(ARCHIVE_UPLOAD_SPACE_HEADROOM_BYTES, (Number(stats.blocks) * Number(stats.bsize)) / 4);
    } catch {
      return ARCHIVE_UPLOAD_SPACE_HEADROOM_BYTES;
    }
  };
  const pause = options.pause ?? ((ms: number) => new Promise<void>((done) => setTimeout(done, ms)));
  const now = options.now ?? (() => Date.now());
  const sessions = new Map<string, Session>();
  let rootPath: string | undefined;
  let closed = false;

  // The folder exists, and is the canonical one: the import refuses a path a link leads to.
  const stagingRoot = (): string => {
    if (rootPath) return rootPath;
    mkdirSync(options.root, { recursive: true, mode: 0o700 });
    rootPath = realpathSync.native(options.root);
    return rootPath;
  };
  const contained = (parent: string, child: string): boolean => child === parent || child.startsWith(parent + sep);
  const session = (uploadId: string): Session => {
    const found = typeof uploadId === 'string' && ID.test(uploadId) ? sessions.get(uploadId) : undefined;
    if (!found) throw new ArchiveUploadError('unknown_upload', ARCHIVE_UPLOAD_COPY.unknown_upload, 404);
    return found;
  };
  const drop = (found: Session): void => {
    sessions.delete(found.id);
    rmSync(found.dir, { recursive: true, force: true });
  };

  // Waits while the disk has less than the headroom beyond `needed`; false when the upload was cancelled or its sender went
  // meanwhile. A wait refreshes the upload's last touch, so one nobody can finish any more must end here for the sweep to take it.
  const roomFor = async (found: Session, needed: number, signal: AbortSignal | undefined): Promise<boolean> => {
    let waited = false;
    try {
      for (;;) {
        if (found.cancelled || closed || signal?.aborted) return false;
        let free: number;
        try {
          free = freeBytes(found.files);
        } catch {
          // A volume that will not say is not a reason to stop.
          return true;
        }
        if (free - needed >= headroomFor(found.files)) return true;
        waited = true;
        found.paused = true;
        found.lastTouch = now();
        await pause(SPACE_POLL_MS);
      }
    } finally {
      if (waited) found.paused = false;
    }
  };

  const receive: ArchiveUploads['receive'] = async (uploadId, relPath, body, receiveOptions = {}) => {
    const found = session(uploadId);
    if (found.cancelled) throw new ArchiveUploadError('cancelled', ARCHIVE_UPLOAD_COPY.cancelled, 409);
    const segments = sanitizeUploadPath(relPath);
    const key = segments.join('/');
    const offset = receiveOptions.offset ?? 0;
    const final = receiveOptions.final ?? true;
    if (!Number.isSafeInteger(offset) || offset < 0) throw new ArchiveUploadError('bad_offset', ARCHIVE_UPLOAD_COPY.bad_offset, 400);
    const declared = receiveOptions.declaredBytes;
    if (declared !== undefined && Number.isFinite(declared) && declared > ARCHIVE_UPLOAD_MAX_CHUNK_BYTES) throw new ArchiveUploadError('chunk_too_large', ARCHIVE_UPLOAD_COPY.chunk_too_large, 413);
    if (offset === 0) {
      if (found.paths.has(key)) throw new ArchiveUploadError('duplicate_file', ARCHIVE_UPLOAD_COPY.duplicate_file, 409);
      found.paths.add(key);
      found.partials.set(key, { written: 0, busy: true });
    } else {
      // A later piece goes where the earlier ones ended, one at a time: anything else is not the file the earlier pieces began.
      const partial = found.partials.get(key);
      if (!partial || partial.busy || partial.written !== offset) throw new ArchiveUploadError('bad_offset', ARCHIVE_UPLOAD_COPY.bad_offset, 409);
      partial.busy = true;
    }
    found.active += 1;
    found.lastTouch = now();
    let handle: FileHandle | undefined;
    let target = '';
    // Only a file this receive made is ever deleted again; whatever else is at the path is not ours.
    let created = false;
    let written = 0;
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    const stop = (): void => { reader?.cancel().catch(() => undefined); };
    found.abort.add(stop);
    try {
      const parent = join(found.files, ...segments.slice(0, -1));
      try {
        mkdirSync(parent, { recursive: true, mode: 0o700 });
        // Whatever is there, the folder the file lands in must still be inside this upload's own copy.
        if (!contained(realpathSync.native(found.files), realpathSync.native(parent))) throw new ArchiveUploadError('bad_path', ARCHIVE_UPLOAD_COPY.bad_path);
      } catch (error) {
        if (error instanceof ArchiveUploadError) throw error;
        // A file where a folder is wanted (or the reverse): the paths of one export cannot do both.
        throw new ArchiveUploadError('bad_path', ARCHIVE_UPLOAD_COPY.bad_path, 409);
      }
      target = join(parent, segments[segments.length - 1]!);
      if (!contained(found.files, resolve(target))) throw new ArchiveUploadError('bad_path', ARCHIVE_UPLOAD_COPY.bad_path);
      if (!(await roomFor(found, declared !== undefined && Number.isFinite(declared) && declared > 0 ? declared : 0, receiveOptions.signal))) {
        throw new ArchiveUploadError('cancelled', ARCHIVE_UPLOAD_COPY.cancelled, 409);
      }
      try {
        // 'wx': never over an existing file, never through a link someone left there. A later piece goes into the file the
        // earlier ones made (checked above to be this upload's own).
        handle = await open(target, offset === 0 ? 'wx' : 'r+', 0o600);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException | undefined)?.code;
        throw code === 'EEXIST'
          ? new ArchiveUploadError('duplicate_file', ARCHIVE_UPLOAD_COPY.duplicate_file, 409)
          : new ArchiveUploadError('write_failed', ARCHIVE_UPLOAD_COPY.write_failed, 500);
      }
      created = offset === 0;
      // A later piece's file is ours as well, though an earlier request made it.
      if (offset > 0) created = true;
      if (body) {
        reader = body.getReader();
        let sinceCheck = 0;
        for (;;) {
          let step: Awaited<ReturnType<ReadableStreamDefaultReader<Uint8Array>['read']>>;
          try {
            step = await reader.read();
          } catch {
            throw new ArchiveUploadError('unreadable', ARCHIVE_UPLOAD_COPY.unreadable, 400);
          }
          if (step.done) break;
          const chunk = step.value;
          if (found.cancelled) throw new ArchiveUploadError('cancelled', ARCHIVE_UPLOAD_COPY.cancelled, 409);
          found.lastTouch = now();
          if (written + chunk.byteLength > ARCHIVE_UPLOAD_MAX_CHUNK_BYTES) throw new ArchiveUploadError('chunk_too_large', ARCHIVE_UPLOAD_COPY.chunk_too_large, 413);
          sinceCheck += chunk.byteLength;
          if (sinceCheck >= SPACE_CHECK_EVERY_BYTES) {
            sinceCheck = 0;
            if (!(await roomFor(found, chunk.byteLength, receiveOptions.signal))) throw new ArchiveUploadError('cancelled', ARCHIVE_UPLOAD_COPY.cancelled, 409);
          }
          try {
            // Awaited, a whole chunk at a time: the sender waits for the disk.
            let done = 0;
            while (done < chunk.byteLength) {
              const { bytesWritten } = await handle.write(chunk, done, chunk.byteLength - done, offset + written + done);
              done += bytesWritten;
            }
          } catch {
            throw new ArchiveUploadError('write_failed', ARCHIVE_UPLOAD_COPY.write_failed, 507);
          }
          written += chunk.byteLength;
          found.bytes += chunk.byteLength;
        }
        // A cancel ends the stream like a finished file does; it must not pass for one.
        if (found.cancelled) throw new ArchiveUploadError('cancelled', ARCHIVE_UPLOAD_COPY.cancelled, 409);
      }
      await handle.close();
      handle = undefined;
      if (!final) {
        // More of this file follows: nothing more is known of it yet.
        found.partials.set(key, { written: offset + written, busy: false });
        return { bytes: written };
      }
      found.partials.delete(key);
      // The file keeps the modification time it had on the person's disk: a copy of an earlier import is told by its bytes, but a
      // file's own date is part of what an export says.
      const modified = receiveOptions.modified;
      if (modified !== undefined && Number.isFinite(modified) && modified > 0 && modified < 4_102_444_800_000) {
        try {
          const when = new Date(modified);
          utimesSync(target, when, when);
        } catch {
          // The date is a courtesy; the bytes are what matter.
        }
      }
      found.fileCount += 1;
      return { bytes: written };
    } catch (error) {
      if (handle) await handle.close().catch(() => undefined);
      // A partial file is never left to be imported.
      if (created && existsSync(target)) rmSync(target, { force: true });
      found.paths.delete(key);
      found.partials.delete(key);
      // What the file's earlier pieces and this one had counted goes with it.
      found.bytes -= offset + written;
      // A cancel stops the read or the write under it, or deletes the folder it writes to: whichever fails, it was the cancel.
      throw found.cancelled ? new ArchiveUploadError('cancelled', ARCHIVE_UPLOAD_COPY.cancelled, 409) : error;
    } finally {
      found.abort.delete(stop);
      found.active -= 1;
      found.lastTouch = now();
    }
  };

  return {
    begin() {
      if (closed) throw new ArchiveUploadError('cancelled', ARCHIVE_UPLOAD_COPY.cancelled, 409);
      const root = stagingRoot();
      const uploadId = randomBytes(16).toString('hex');
      const dir = join(root, uploadId);
      mkdirSync(join(dir, 'files'), { recursive: true, mode: 0o700 });
      sessions.set(uploadId, {
        id: uploadId, dir, files: join(dir, 'files'), fileCount: 0, bytes: 0, active: 0, paused: false, cancelled: false,
        lastTouch: now(), abort: new Set(), paths: new Set(), partials: new Map(),
      });
      return { uploadId };
    },
    receive,
    status(uploadId) {
      const found = session(uploadId);
      return {
        state: found.paused ? 'paused_disk_full' : found.active > 0 ? 'receiving' : 'idle',
        files: found.fileCount,
        bytes: found.bytes,
      };
    },
    cancel(uploadId, keep) {
      if (typeof uploadId !== 'string' || !ID.test(uploadId)) return false;
      const found = sessions.get(uploadId);
      const dir = found?.dir ?? (existsSync(options.root) ? join(stagingRoot(), uploadId) : undefined);
      if (!dir) return false;
      if (keep?.(dir)) {
        // An import reads it: the upload is over, the copy stays until the import needs it no more.
        if (found) {
          found.cancelled = true;
          for (const stop of [...found.abort]) stop();
          sessions.delete(uploadId);
        }
        return false;
      }
      if (found) {
        found.cancelled = true;
        for (const stop of [...found.abort]) stop();
        sessions.delete(uploadId);
      }
      rmSync(dir, { recursive: true, force: true });
      return true;
    },
    chosenPath(uploadId) {
      const found = session(uploadId);
      if (found.cancelled) throw new ArchiveUploadError('cancelled', ARCHIVE_UPLOAD_COPY.cancelled, 409);
      if (found.active > 0 || found.partials.size > 0) throw new ArchiveUploadError('upload_closed', 'Files are still arriving. Wait until the upload has finished.', 409);
      const entries = readdirSync(found.files);
      const top = entries.length === 1 ? join(found.files, entries[0]!) : found.files;
      const canonical = realpathSync.native(top);
      if (!contained(realpathSync.native(found.dir), canonical)) throw new ArchiveUploadError('bad_path', ARCHIVE_UPLOAD_COPY.bad_path);
      return canonical;
    },
    handOver(uploadId) {
      const found = typeof uploadId === 'string' && ID.test(uploadId) ? sessions.get(uploadId) : undefined;
      if (!found) return;
      found.cancelled = true;
      for (const stop of [...found.abort]) stop();
      sessions.delete(uploadId);
    },
    release(uploadId, keep) {
      if (typeof uploadId !== 'string' || !ID.test(uploadId)) return;
      const found = sessions.get(uploadId);
      const dir = found?.dir ?? (existsSync(options.root) ? join(stagingRoot(), uploadId) : undefined);
      if (!dir || keep?.(dir)) return;
      sessions.delete(uploadId);
      rmSync(dir, { recursive: true, force: true });
    },
    sweep(needed) {
      // Nothing was ever uploaded: no folder is made to look in it.
      if (!rootPath && !existsSync(options.root)) return;
      let root: string;
      try {
        root = stagingRoot();
      } catch {
        return;
      }
      let names: string[];
      try {
        names = readdirSync(root);
      } catch {
        return;
      }
      for (const name of names) {
        if (!ID.test(name)) continue;
        const dir = join(root, name);
        const found = sessions.get(name);
        // Running, or touched lately: still being uploaded.
        if (found && (found.active > 0 || now() - found.lastTouch < ARCHIVE_UPLOAD_IDLE_MS)) continue;
        try {
          if (!statSync(dir).isDirectory()) continue;
        } catch {
          continue;
        }
        // An import that reads it keeps it; the upload itself is over either way.
        if (needed(dir)) {
          sessions.delete(name);
          continue;
        }
        if (found) found.cancelled = true;
        sessions.delete(name);
        rmSync(dir, { recursive: true, force: true });
      }
    },
    close() {
      closed = true;
      for (const found of sessions.values()) {
        found.cancelled = true;
        for (const stop of [...found.abort]) stop();
      }
    },
  };
}

