/**
 * Scope-safe filesystem access for sources that read this computer's files.
 *
 * A symlink, or a folder swapped for a symlink between listing and reading,
 * must never pull anything from outside the approved folder. Reading by path
 * cannot promise that, so everything here works from a descriptor held on the
 * approved root and opens each name relative to it:
 *
 *  - Linux: one `openat2` call with RESOLVE_BENEATH | RESOLVE_NO_SYMLINKS |
 *    RESOLVE_NO_XDEV (kernel 5.6+). The kernel refuses links, `..` escapes
 *    and mount-point crossings (bind mounts included) for the whole path.
 *  - macOS: a chain of `openat(..., O_NOFOLLOW)` calls, one per component,
 *    comparing each component's device with its parent's, so a mount point
 *    in the middle of the path is refused.
 *
 * Bun has no binding for these calls, so they go through `bun:ffi` to libc.
 * When they cannot be used (no FFI, `openat2` answering ENOSYS or EPERM) the
 * read FAILS CLOSED with `unsupported`; it never falls back to a path read.
 *
 * Directory listing goes through `fdopendir` on a duplicate of a verified
 * descriptor, so names come only from the directory that was opened.
 *
 * Every open reports its (device, inode) identity. A caller that listed an
 * item passes the identity it saw; a different file at the same name counts
 * as `changed`, and the item is listed again rather than read.
 */
import { createRequire } from 'node:module';
import * as fs from 'node:fs';
import { posix } from 'node:path';

const runtimeRequire = createRequire(import.meta.url);

export type ScopeSafeErrorCode =
  | 'unsupported' // the safe open is not available here: fail closed
  | 'escape' // a link, `..`, or a mount point on the way
  | 'changed' // the file is not the one that was listed
  | 'not_found'
  | 'permission'
  | 'too_large'
  | 'not_regular'
  | 'io';

export class ScopeSafeError extends Error {
  readonly code: ScopeSafeErrorCode;
  constructor(code: ScopeSafeErrorCode, detail?: string) {
    super(detail ? `${code}: ${detail}` : code);
    this.name = 'ScopeSafeError';
    this.code = code;
  }
}

export interface ScopeIdentity {
  dev: string;
  ino: string;
}

export function scopeIdentityKey(identity: ScopeIdentity): string {
  return `${identity.dev}:${identity.ino}`;
}

/**
 * One version of a file: its identity plus the size and modification time it
 * had when it was opened. A reader holding a version refuses to read once the
 * file under its descriptor no longer matches it.
 */
export interface ScopeFileVersion extends ScopeIdentity {
  size: number;
  mtimeMs: number;
}

export function scopeFileVersionKey(version: ScopeFileVersion): string {
  return `${version.dev}:${version.ino}:${version.size}:${version.mtimeMs}`;
}

export function sameScopeFileVersion(a: ScopeFileVersion, b: ScopeFileVersion): boolean {
  return a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs;
}

/** The most one `readAt` call returns, so no caller can load a whole large file at once. */
export const SCOPE_FILE_MAX_RANGE_BYTES = 64 * 1024 * 1024;

export type ScopeEntryKind = 'file' | 'directory' | 'symlink' | 'other';

export interface ScopeStat extends ScopeIdentity {
  kind: ScopeEntryKind;
  size: number;
  mtimeMs: number;
  /** macOS: the file is an iCloud placeholder; reading it would start a download. */
  dataless: boolean;
}

export interface ScopeDirEntry {
  name: string;
  /** From the directory itself; `undefined` when the filesystem did not say. */
  kind: ScopeEntryKind | undefined;
}

interface Native {
  openat(dirfd: number, name: string, flags: number): number;
  openat2Beneath(dirfd: number, relPath: string, flags: number): number;
  fdopendirDup(fd: number): number | bigint | undefined;
  readdirNames(dir: number | bigint): Array<{ name: string; type: number }>;
  closedir(dir: number | bigint): void;
  fstatFlags(fd: number): number | undefined;
  lastErrno(): number;
  /** True where a listing can name a placeholder (a file kept only in the cloud); needs a descriptor to tell. */
  placeholders: boolean;
}

const ERRNO = {
  darwin: { ENOENT: 2, EACCES: 13, EPERM: 1, ENOTDIR: 20, ELOOP: 62, EXDEV: 18, ENOSYS: 78, EMFILE: 24, ENXIO: 6, EOPNOTSUPP: 45 },
  linux: { ENOENT: 2, EACCES: 13, EPERM: 1, ENOTDIR: 20, ELOOP: 40, EXDEV: 18, ENOSYS: 38, EMFILE: 24, ENXIO: 6, EOPNOTSUPP: 95 },
} as const;

const SF_DATALESS = 0x40000000;
const DT_DIR = 4;
const DT_REG = 8;
const DT_LNK = 10;
const RESOLVE_NO_XDEV = 0x01;
const RESOLVE_NO_SYMLINKS = 0x04;
const RESOLVE_BENEATH = 0x08;
const SYS_OPENAT2 = 437; // the same number on x86_64 and arm64
const O_CLOEXEC_LINUX = 0x80000;
const O_CLOEXEC_DARWIN = 0x01000000;

let cachedNative: Native | null | undefined;

/** Test seam: the binding in use, so a test can wrap it (for example to report a placeholder). */
export function scopeSafeNativeForTests(): Native | null {
  return loadNative();
}

/** Test seam: replace or clear the native binding. */
export function resetScopeSafeNativeForTests(value?: Native | null): void {
  cachedNative = value;
}

function platformErrno() {
  return process.platform === 'darwin' ? ERRNO.darwin : ERRNO.linux;
}

function loadNative(): Native | null {
  if (cachedNative !== undefined) return cachedNative;
  cachedNative = null;
  if (process.platform !== 'darwin' && process.platform !== 'linux') return null;
  try {
    const ffi = runtimeRequire('bun:ffi') as typeof import('bun:ffi');
    const { dlopen, FFIType, ptr, read, CString, toArrayBuffer } = ffi;
    const darwin = process.platform === 'darwin';
    const intel = process.arch === 'x64';
    // Intel macOS exposes the 64-bit-inode layout under a suffixed symbol.
    const suffix = darwin && intel ? '$INODE64' : '';
    const libc = dlopen(darwin ? '/usr/lib/libSystem.B.dylib' : 'libc.so.6', {
      openat: { args: [FFIType.i32, FFIType.ptr, FFIType.i32], returns: FFIType.i32 },
      ...(darwin ? {} : { syscall: { args: [FFIType.i64, FFIType.i64, FFIType.ptr, FFIType.ptr, FFIType.u64], returns: FFIType.i64 } }),
      dup: { args: [FFIType.i32], returns: FFIType.i32 },
      close: { args: [FFIType.i32], returns: FFIType.i32 },
      [`fdopendir${darwin && intel ? '$INODE64' : ''}`]: { args: [FFIType.i32], returns: FFIType.ptr },
      [`readdir${suffix}`]: { args: [FFIType.ptr], returns: FFIType.ptr },
      closedir: { args: [FFIType.ptr], returns: FFIType.i32 },
      ...(darwin ? { [`fstat${suffix}`]: { args: [FFIType.i32, FFIType.ptr], returns: FFIType.i32 } } : {}),
      [darwin ? '__error' : '__errno_location']: { args: [], returns: FFIType.ptr },
    } as const) as unknown as { symbols: Record<string, (...args: unknown[]) => unknown> };
    const s = libc.symbols;
    const errnoFn = s[darwin ? '__error' : '__errno_location'] as () => number;
    const cstr = (value: string): Buffer => Buffer.from(`${value}\0`, 'utf8');
    const errno = (): number => read.i32(errnoFn() as never, 0);
    const clearErrno = (): void => { new Int32Array(toArrayBuffer(errnoFn() as never, 0, 4))[0] = 0; };
    /** Keeps a buffer reachable until the foreign call that was handed its address has returned. */
    const keepAlive = (...buffers: Buffer[]): void => { if (buffers.some((buffer) => buffer.length < 0)) throw new Error('unreachable'); };
    const cloexec = darwin ? O_CLOEXEC_DARWIN : O_CLOEXEC_LINUX;
    const native: Native = {
      lastErrno: errno,
      placeholders: darwin,
      openat(dirfd, name, flags) {
        const nameBuffer = cstr(name);
        const result = s.openat!(dirfd, ptr(nameBuffer), flags | cloexec) as number;
        const failure = result < 0 ? errno() : 0;
        keepAlive(nameBuffer);
        return result < 0 ? -failure : result;
      },
      openat2Beneath(dirfd, relPath, flags) {
        // struct open_how { u64 flags; u64 mode; u64 resolve; }
        const how = Buffer.alloc(24);
        how.writeBigUInt64LE(BigInt(flags | cloexec), 0);
        how.writeBigUInt64LE(0n, 8);
        how.writeBigUInt64LE(BigInt(RESOLVE_BENEATH | RESOLVE_NO_SYMLINKS | RESOLVE_NO_XDEV), 16);
        const pathBuffer = cstr(relPath);
        const result = Number(s.syscall!(BigInt(SYS_OPENAT2), BigInt(dirfd), ptr(pathBuffer), ptr(how), 24n) as bigint | number);
        const failure = result < 0 ? errno() : 0;
        keepAlive(pathBuffer, how);
        return result < 0 ? -failure : result;
      },
      fdopendirDup(fd) {
        const copy = s.dup!(fd) as number;
        if (copy < 0) return undefined;
        const dir = s[`fdopendir${darwin && intel ? '$INODE64' : ''}`]!(copy);
        if (!dir) {
          s.close!(copy);
          return undefined;
        }
        return dir as number | bigint;
      },
      readdirNames(dir) {
        const out: Array<{ name: string; type: number }> = [];
        for (;;) {
          // readdir returns NULL both at the end and on an error; only errno
          // (cleared first) tells them apart, and a failed listing is not a
          // complete one.
          clearErrno();
          const entry = s[`readdir${suffix}`]!(dir as never) as number | bigint | null;
          if (!entry) {
            const failure = errno();
            if (failure !== 0) throw new ScopeSafeError('io', `readdir errno ${failure}`);
            break;
          }
          // macOS (64-bit inode): d_type @20, d_name @21. Linux: d_type @18, d_name @19.
          const typeOffset = darwin ? 20 : 18;
          const nameOffset = darwin ? 21 : 19;
          const type = read.u8(entry as never, typeOffset);
          const name = new CString(entry as never, nameOffset).toString();
          if (name === '.' || name === '..') continue;
          out.push({ name, type });
        }
        return out;
      },
      closedir(dir) {
        s.closedir!(dir as never);
      },
      fstatFlags(fd) {
        if (!darwin) return undefined;
        const buffer = Buffer.alloc(144);
        const result = s[`fstat${suffix}`]!(fd, ptr(buffer)) as number;
        return result === 0 ? buffer.readUInt32LE(116) : undefined;
      },
    };
    cachedNative = native;
  } catch {
    cachedNative = null;
  }
  return cachedNative;
}

/** True when this process can open files scope-safely (otherwise every read fails closed). */
export function scopeSafeFsAvailable(): boolean {
  return loadNative() !== null;
}

function toError(code: number): ScopeSafeError {
  const e = platformErrno();
  switch (code) {
    case e.ENOENT: return new ScopeSafeError('not_found');
    case e.EACCES: return new ScopeSafeError('permission');
    case e.ELOOP: case e.EXDEV: case e.ENOTDIR: return new ScopeSafeError('escape', `errno ${code}`);
    case e.ENOSYS: return new ScopeSafeError('unsupported', 'openat2 unavailable');
    case e.EPERM:
      // On Linux a seccomp filter answers EPERM for a call it blocks. The
      // safe open cannot be told apart from a plain denial, so fail closed.
      return new ScopeSafeError(process.platform === 'linux' ? 'unsupported' : 'permission', `errno ${code}`);
    default: return new ScopeSafeError('io', `errno ${code}`);
  }
}

function kindFromMode(mode: number): ScopeEntryKind {
  const type = mode & 0o170000;
  if (type === 0o100000) return 'file';
  if (type === 0o040000) return 'directory';
  if (type === 0o120000) return 'symlink';
  return 'other';
}

function statFd(native: Native, fd: number): ScopeStat {
  const st = fs.fstatSync(fd, { bigint: true });
  const dataless = (native.fstatFlags(fd) ?? 0) & SF_DATALESS ? true : false;
  return {
    dev: st.dev.toString(),
    ino: st.ino.toString(),
    kind: kindFromMode(Number(st.mode)),
    size: Number(st.size),
    mtimeMs: Number(st.mtimeMs),
    dataless,
  };
}

function checkComponent(name: string): void {
  if (!name || name === '.' || name === '..' || name.includes('/') || name.includes('\0')) {
    throw new ScopeSafeError('escape', 'bad path component');
  }
}

export function splitRelative(relPath: string): string[] {
  if (relPath === '' || relPath === '.') return [];
  if (relPath.startsWith('/') || relPath.includes('\0')) throw new ScopeSafeError('escape', 'not relative');
  const parts = relPath.split('/').filter((part) => part !== '');
  for (const part of parts) checkComponent(part);
  return parts;
}

/**
 * A held descriptor on an approved folder. Open it once per pass, close it
 * with `close()`.
 */
export class ScopeRoot {
  readonly path: string;
  readonly identity: ScopeIdentity;
  private fd: number;
  private readonly native: Native;
  private readonly dev: string;

  private constructor(path: string, fd: number, native: Native, stat: ScopeStat) {
    this.path = path;
    this.fd = fd;
    this.native = native;
    this.identity = { dev: stat.dev, ino: stat.ino };
    this.dev = stat.dev;
  }

  /**
   * Opens the approved folder. `path` must be the folder's canonical path: it
   * is opened without following a link in its last component, and refused
   * unless its real path is itself.
   */
  static open(path: string): ScopeRoot {
    const native = loadNative();
    if (!native) throw new ScopeSafeError('unsupported', 'no descriptor-relative open here');
    if (!path.startsWith('/') || path.includes('\0')) throw new ScopeSafeError('escape', 'root must be absolute');
    let canonical: string;
    try {
      canonical = fs.realpathSync.native(path);
    } catch {
      throw new ScopeSafeError('not_found');
    }
    if (canonical !== path) throw new ScopeSafeError('changed', 'root is not its own real path');
    let fd: number;
    try {
      fd = fs.openSync(path, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
    } catch (error) {
      throw mapNodeError(error);
    }
    const stat = statFd(native, fd);
    if (stat.kind !== 'directory') {
      fs.closeSync(fd);
      throw new ScopeSafeError('not_found');
    }
    return new ScopeRoot(path, fd, native, stat);
  }

  close(): void {
    if (this.fd >= 0) {
      try { fs.closeSync(this.fd); } catch { /* already closed */ }
      this.fd = -1;
    }
  }

  private assertOpen(): void {
    if (this.fd < 0) throw new ScopeSafeError('io', 'root closed');
  }

  /**
   * Opens `relPath` under the root and returns a descriptor the caller owns,
   * with the identity it found. Throws if any component is a link or a mount
   * point.
   */
  openRelative(relPath: string, options: { directory?: boolean } = {}): { fd: number; stat: ScopeStat } {
    this.assertOpen();
    const parts = splitRelative(relPath);
    const nodeConstants = fs.constants;
    const base = nodeConstants.O_RDONLY | nodeConstants.O_NONBLOCK;
    if (parts.length === 0) {
      const fd = fs.openSync(this.path, nodeConstants.O_RDONLY | nodeConstants.O_DIRECTORY | nodeConstants.O_NOFOLLOW);
      const stat = statFd(this.native, fd);
      if (stat.dev !== this.identity.dev || stat.ino !== this.identity.ino) {
        fs.closeSync(fd);
        throw new ScopeSafeError('changed', 'root was replaced');
      }
      return { fd, stat };
    }
    if (process.platform === 'linux') {
      const flags = base | nodeConstants.O_NOFOLLOW | (options.directory ? nodeConstants.O_DIRECTORY : 0);
      const fd = this.native.openat2Beneath(this.fd, parts.join('/'), flags);
      if (fd < 0) throw toError(-fd);
      try {
        return { fd, stat: statFd(this.native, fd) };
      } catch (error) {
        fs.closeSync(fd);
        throw error;
      }
    }
    // macOS: one O_NOFOLLOW open per component, each on the same device as its parent.
    let parent = -1;
    let parentDev = this.dev;
    try {
      for (let index = 0; index < parts.length; index += 1) {
        const last = index === parts.length - 1;
        const flags = base | nodeConstants.O_NOFOLLOW
          | (!last || options.directory ? nodeConstants.O_DIRECTORY : 0);
        const fd = this.native.openat(parent < 0 ? this.fd : parent, parts[index]!, flags);
        if (fd < 0) throw toError(-fd);
        let stat: ScopeStat;
        try {
          stat = statFd(this.native, fd);
        } catch (error) {
          fs.closeSync(fd);
          throw error;
        }
        if (stat.dev !== parentDev) {
          fs.closeSync(fd);
          throw new ScopeSafeError('escape', 'mount point');
        }
        if (parent >= 0) fs.closeSync(parent);
        parent = fd;
        parentDev = stat.dev;
        if (last) {
          const result = { fd, stat };
          parent = -1;
          return result;
        }
      }
      throw new ScopeSafeError('io', 'empty path');
    } finally {
      if (parent >= 0) fs.closeSync(parent);
    }
  }

  /** Stat of `relPath` without following links (a link itself is reported only by `list`). */
  statRelative(relPath: string): ScopeStat {
    const { fd, stat } = this.openRelative(relPath);
    fs.closeSync(fd);
    return stat;
  }

  /**
   * Metadata of an entry a listing already named, without opening it where the
   * platform allows: a file whose mode refuses reading still has a size and a
   * time. A placeholder flag (macOS) needs a descriptor, so there the open is
   * tried first and lstat answers when the open is refused. A link is
   * reported as a link; an entry on another device is refused.
   */
  statEntry(relPath: string): ScopeStat {
    this.assertOpen();
    splitRelative(relPath);
    if (this.native.placeholders) {
      try {
        return this.statRelative(relPath);
      } catch (error) {
        // Refused, a link, a mount point: lstat below says which.
        if (!(error instanceof ScopeSafeError)) throw error;
      }
    }
    let st: fs.BigIntStats;
    try {
      st = fs.lstatSync(posix.join(this.path, relPath), { bigint: true });
    } catch (error) {
      throw mapNodeError(error);
    }
    const kind = kindFromMode(Number(st.mode));
    if (kind !== 'symlink' && st.dev.toString() !== this.dev) throw new ScopeSafeError('escape', 'mount point');
    return {
      dev: st.dev.toString(),
      ino: st.ino.toString(),
      kind,
      size: Number(st.size),
      mtimeMs: Number(st.mtimeMs),
      dataless: false,
    };
  }

  /**
   * The names directly inside a directory, read from a descriptor on that
   * directory and so only from the directory that was opened.
   */
  list(relDir: string): ScopeDirEntry[] {
    this.assertOpen();
    const { fd } = this.openRelative(relDir, { directory: true });
    let dir: number | bigint | undefined;
    try {
      dir = this.native.fdopendirDup(fd);
      if (dir === undefined) throw new ScopeSafeError('io', 'fdopendir');
      return this.native.readdirNames(dir).map(({ name, type }) => ({
        name,
        kind: type === DT_REG ? 'file' as const
          : type === DT_DIR ? 'directory' as const
          : type === DT_LNK ? 'symlink' as const
          : type === 0 ? undefined : 'other' as const,
      }));
    } finally {
      if (dir !== undefined) this.native.closedir(dir);
      fs.closeSync(fd);
    }
  }

  /**
   * Opens a regular file for bounded range reads (`ScopeFileReader.readAt`)
   * instead of loading it whole. `expected` is the identity, or the whole
   * version, seen before: another file at that name, or the same file at
   * another size or time when a version is given, is `changed`. A link, a
   * mount point on the way, or a placeholder that would need downloading is
   * refused. The caller closes the reader.
   */
  openFile(relPath: string, options: { expected?: ScopeIdentity | ScopeFileVersion } = {}): ScopeFileReader {
    const { fd, stat } = this.openRelative(relPath);
    try {
      if (stat.kind !== 'file') throw new ScopeSafeError('not_regular');
      if (stat.dataless) throw new ScopeSafeError('not_regular', 'placeholder');
      const version: ScopeFileVersion = { dev: stat.dev, ino: stat.ino, size: stat.size, mtimeMs: stat.mtimeMs };
      const expected = options.expected;
      if (expected) {
        if (stat.dev !== expected.dev || stat.ino !== expected.ino) {
          throw new ScopeSafeError('changed', 'identity differs from the one seen before');
        }
        if ('size' in expected && !sameScopeFileVersion(version, expected)) {
          throw new ScopeSafeError('changed', 'the file changed since it was seen');
        }
      }
      return new ScopeFileReader(relPath, fd, version);
    } catch (error) {
      fs.closeSync(fd);
      if (error instanceof ScopeSafeError) throw error;
      throw mapNodeError(error);
    }
  }

  /**
   * Reads a regular file. `expected` is the identity the listing saw; another
   * file (or a link, or a different mount) at that name is `changed`/`escape`.
   * A placeholder that would need downloading is never read.
   */
  readFile(relPath: string, options: { expected?: ScopeIdentity; maxBytes?: number } = {}): Uint8Array {
    const { fd, stat } = this.openRelative(relPath);
    try {
      if (stat.kind !== 'file') throw new ScopeSafeError('not_regular');
      if (options.expected && (stat.dev !== options.expected.dev || stat.ino !== options.expected.ino)) {
        throw new ScopeSafeError('changed', 'identity differs from the listing');
      }
      if (stat.dataless) throw new ScopeSafeError('not_regular', 'placeholder');
      const max = options.maxBytes;
      if (max !== undefined && stat.size > max) throw new ScopeSafeError('too_large');
      const out = Buffer.allocUnsafe(stat.size);
      let offset = 0;
      while (offset < stat.size) {
        const read = fs.readSync(fd, out, offset, stat.size - offset, null);
        if (read === 0) break;
        offset += read;
      }
      // The file may have changed length while it was read; what was read is
      // returned and the next listing sees the new version.
      return new Uint8Array(out.buffer, out.byteOffset, offset);
    } catch (error) {
      if (error instanceof ScopeSafeError) throw error;
      throw mapNodeError(error);
    } finally {
      fs.closeSync(fd);
    }
  }
}

/**
 * A descriptor on one regular file below an approved root, read in bounded
 * ranges. It was opened through the same link- and mount-refusing walk as
 * every other read, and each range first checks that the file under the
 * descriptor is still the version that was opened (same identity, size and
 * modification time); a file that grew, shrank or was rewritten is `changed`.
 */
export class ScopeFileReader {
  readonly relPath: string;
  readonly version: ScopeFileVersion;
  private fd: number;

  constructor(relPath: string, fd: number, version: ScopeFileVersion) {
    this.relPath = relPath;
    this.fd = fd;
    this.version = version;
  }

  get size(): number {
    return this.version.size;
  }

  /** Throws `changed` when the open file is no longer the version it was opened at. */
  assertUnchanged(): void {
    if (this.fd < 0) throw new ScopeSafeError('io', 'file closed');
    let st: fs.BigIntStats;
    try {
      st = fs.fstatSync(this.fd, { bigint: true });
    } catch (error) {
      throw mapNodeError(error);
    }
    const now: ScopeFileVersion = {
      dev: st.dev.toString(),
      ino: st.ino.toString(),
      size: Number(st.size),
      mtimeMs: Number(st.mtimeMs),
    };
    if (!sameScopeFileVersion(now, this.version)) throw new ScopeSafeError('changed', 'the file changed while it was read');
  }

  /**
   * Up to `length` bytes starting at `offset`, never past the end of the
   * version that was opened. `length` is capped at SCOPE_FILE_MAX_RANGE_BYTES.
   */
  readAt(offset: number, length: number): Uint8Array {
    if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length < 0) {
      throw new ScopeSafeError('io', 'bad range');
    }
    if (length > SCOPE_FILE_MAX_RANGE_BYTES) throw new ScopeSafeError('too_large', 'range too large');
    this.assertUnchanged();
    const end = Math.min(this.version.size, offset + length);
    if (offset >= end) return new Uint8Array(0);
    const out = Buffer.allocUnsafe(end - offset);
    let filled = 0;
    try {
      while (filled < out.length) {
        const read = fs.readSync(this.fd, out, filled, out.length - filled, offset + filled);
        if (read === 0) break;
        filled += read;
      }
    } catch (error) {
      throw mapNodeError(error);
    }
    if (filled < out.length) throw new ScopeSafeError('changed', 'the file is shorter than it was');
    return new Uint8Array(out.buffer, out.byteOffset, filled);
  }

  close(): void {
    if (this.fd >= 0) {
      try { fs.closeSync(this.fd); } catch { /* already closed */ }
      this.fd = -1;
    }
  }
}

function mapNodeError(error: unknown): ScopeSafeError {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  if (code === 'ENOENT') return new ScopeSafeError('not_found');
  if (code === 'EACCES' || code === 'EPERM') return new ScopeSafeError('permission');
  if (code === 'ELOOP' || code === 'ENOTDIR') return new ScopeSafeError('escape', String(code));
  return new ScopeSafeError('io', String(code ?? 'unknown'));
}

/** Joins a root-relative directory and a name into a root-relative path. */
export function joinRelative(dir: string, name: string): string {
  return dir === '' ? name : posix.join(dir, name);
}
