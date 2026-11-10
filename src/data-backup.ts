/**
 * Backups (#1065): one file that holds a whole export, encrypted with the
 * owner's passphrase when there is one.
 *
 * `olympus data backup --output <folder>` exports (data-lifecycle.ts, version
 * 3) into a private staging folder, packs it as a tar stream and writes ONE
 * file, `olympus-backup-<YYYY-MM-DD-HHMM>.olympusbackup`, into the folder.
 * `olympus data restore --input <file>` opens that file into a private staging
 * folder, restores from it (data-restore.ts), then removes the staging folder.
 *
 * The file:
 *
 *   "OLYMPUS-BACKUP\n"  4-byte big-endian header length  header (JSON)
 *   body                the tar stream; with a passphrase, AES-256-GCM of it
 *   trailer             the GCM tag (16 bytes), or without a passphrase the
 *                       SHA-256 of everything before it (32 bytes)
 *
 * The header names the format version, whether the body is encrypted, the
 * scrypt parameters and random salt the key came from, the random nonce, and
 * a key check (an HMAC of a fixed label under the key), so a wrong passphrase
 * is told apart from a changed file before anything is decrypted. The header
 * is the GCM associated data, so changing any byte of it fails the tag.
 *
 * The passphrase itself is never stored. Scheduled backups need a key, so
 * setting a passphrase in the dashboard keeps the key derived from it (never
 * the passphrase) in an owner-only file under the owner config folder
 * (data-backup-settings.ts), and the Settings page says so.
 */
import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, randomUUID, scryptSync, timingSafeEqual, type CipherGCM, type DecipherGCM, type Hash } from 'node:crypto';
import { closeSync, existsSync, lstatSync, mkdirSync, openSync, readdirSync, readSync, renameSync, rmSync, statSync, unlinkSync, writeSync, chmodSync, fsyncSync } from 'node:fs';
import { open as openAsync, type FileHandle } from 'node:fs/promises';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { OperationError } from './core/operation-error.ts';
import { syncDirectorySync } from './core/atomic-file.ts';
import { sharedDataPath } from './core/olympus-layout.ts';
import { lifecycleEnv, type LifecyclePathContext } from './data-lifecycle.ts';
import { restoreOlympusData, type DataRestoreResult } from './data-restore.ts';

export const BACKUP_FILE_EXTENSION = '.olympusbackup';
export const BACKUP_FORMAT_VERSION = 1;
/** How many backups a backup folder keeps (the dashboard's and the schedule's). */
export const BACKUP_KEEP = 7;

const MAGIC = Buffer.from('OLYMPUS-BACKUP\n', 'ascii');
const KEY_CHECK_LABEL = 'olympus-backup-key-check-v1';
const CHUNK = 1024 * 1024;
const TAG_BYTES = 16;
const DIGEST_BYTES = 32;
const MAX_HEADER_BYTES = 64 * 1024;
/** `olympus-backup-2026-11-10-0310.olympusbackup`, and `-2` and on for a second one in the same minute. */
const BACKUP_NAME = /^olympus-backup-\d{4}-\d{2}-\d{2}-\d{4}(?:-\d{1,3})?\.olympusbackup$/;

/** scrypt cost: N = 2^17 (about 128 MB, a fraction of a second on a laptop). */
export const DEFAULT_SCRYPT = { N: 131_072, r: 8, p: 1 } as const;
/** A header may ask for no less than this (and no more than 2^20), so a file cannot make a restore weak or hang. */
const MIN_SCRYPT_N = 16_384;
const MAX_SCRYPT_N = 1_048_576;

export interface BackupKdf {
  name: 'scrypt';
  N: number;
  r: number;
  p: number;
  /** base64 */
  salt: string;
}

/** A key derived from the owner's passphrase, with how it was derived. */
export interface BackupKey {
  key: Buffer;
  kdf: BackupKdf;
}

interface BackupHeader {
  kind: 'olympus_backup';
  format: number;
  encrypted: boolean;
  created_at: string;
  kdf?: BackupKdf;
  cipher?: 'aes-256-gcm';
  /** base64, 12 bytes */
  nonce?: string;
  /** base64: HMAC-SHA256(key, label), first 16 bytes */
  key_check?: string;
}

export interface BackupFileInfo {
  path: string;
  name: string;
  bytes: number;
  encrypted: boolean;
  createdAt: string;
}

function normalizePassphrase(passphrase: string): string {
  const value = passphrase.normalize('NFC');
  if (value.trim().length === 0) throw new OperationError('invalid_params', 'The passphrase is empty.');
  return value;
}

/**
 * Throws unless `kdf` is a key setting Olympus derives and opens backups with:
 * what a backup's header, a key kept for scheduled backups and a backup about
 * to be written must all name.
 */
export function checkKdf(kdf: BackupKdf): void {
  if (!kdf || typeof kdf !== 'object') throw new OperationError('invalid_params', 'This backup names a key setting Olympus does not accept.');
  const powerOfTwo = (n: number) => Number.isInteger(n) && n > 1 && (n & (n - 1)) === 0;
  if (kdf.name !== 'scrypt' || !powerOfTwo(kdf.N) || kdf.N < MIN_SCRYPT_N || kdf.N > MAX_SCRYPT_N
    || !Number.isInteger(kdf.r) || kdf.r < 1 || kdf.r > 32 || !Number.isInteger(kdf.p) || kdf.p < 1 || kdf.p > 16
    || typeof kdf.salt !== 'string' || Buffer.from(kdf.salt, 'base64').length < 16) {
    throw new OperationError('invalid_params', 'This backup names a key setting Olympus does not accept.');
  }
}

/**
 * Derive the backup key from a passphrase: scrypt with a random salt, or with
 * the salt and parameters a backup's header names when opening it.
 */
export function deriveBackupKey(passphrase: string, kdf?: Partial<BackupKdf>): BackupKey {
  const full: BackupKdf = {
    name: 'scrypt',
    N: kdf?.N ?? DEFAULT_SCRYPT.N,
    r: kdf?.r ?? DEFAULT_SCRYPT.r,
    p: kdf?.p ?? DEFAULT_SCRYPT.p,
    salt: kdf?.salt ?? randomBytes(16).toString('base64'),
  };
  checkKdf(full);
  const key = scryptSync(normalizePassphrase(passphrase), Buffer.from(full.salt, 'base64'), 32, {
    N: full.N, r: full.r, p: full.p, maxmem: 256 * full.N * full.r + 1024 * 1024,
  });
  return { key, kdf: full };
}

export function backupKeyCheck(key: Buffer): string {
  return createHmac('sha256', key).update(KEY_CHECK_LABEL).digest().subarray(0, 16).toString('base64');
}

/** `olympus-backup-YYYY-MM-DD-HHMM.olympusbackup`, in this computer's local time. */
export function backupFileName(now: Date): string {
  const two = (n: number) => String(n).padStart(2, '0');
  return `olympus-backup-${now.getFullYear()}-${two(now.getMonth() + 1)}-${two(now.getDate())}-${two(now.getHours())}${two(now.getMinutes())}${BACKUP_FILE_EXTENSION}`;
}

function encodeHeader(header: BackupHeader): Buffer {
  const json = Buffer.from(JSON.stringify(header), 'utf8');
  const length = Buffer.alloc(4);
  length.writeUInt32BE(json.length);
  return Buffer.concat([MAGIC, length, json]);
}

// ---- tar (ustar) ------------------------------------------------------------

/** The largest size an ustar header's 12-byte size field holds (8^11 - 1 bytes). */
export const USTAR_MAX_SIZE = 0o77777777777;

function octal(value: number, width: number): string {
  return value.toString(8).padStart(width - 1, '0') + '\0';
}

/** One ustar header block. Names that do not fit ustar's name and prefix fields are refused. */
function tarHeader(name: string, size: number, type: '0' | '5', mtime: number): Buffer {
  const block = Buffer.alloc(512);
  let fullName = Buffer.from(name, 'utf8');
  let prefix = Buffer.alloc(0);
  if (fullName.length > 100) {
    const cut = name.lastIndexOf('/', name.length - 1);
    const split = (() => {
      for (let at = cut; at > 0; at = name.lastIndexOf('/', at - 1)) {
        const head = Buffer.from(name.slice(0, at), 'utf8');
        const tail = Buffer.from(name.slice(at + 1), 'utf8');
        if (head.length <= 155 && tail.length <= 100) return { head, tail };
      }
      return undefined;
    })();
    if (!split) throw new OperationError('source_index_error', `A file in the export has a path too long to back up: ${name}`);
    prefix = split.head;
    fullName = split.tail;
  }
  fullName.copy(block, 0);
  block.write(octal(type === '5' ? 0o700 : 0o600, 8), 100, 'ascii');
  block.write(octal(0, 8), 108, 'ascii');
  block.write(octal(0, 8), 116, 'ascii');
  block.write(octal(size, 12), 124, 'ascii');
  block.write(octal(Math.floor(mtime / 1000), 12), 136, 'ascii');
  block.write('        ', 148, 'ascii');
  block.write(type, 156, 'ascii');
  block.write('ustar\0', 257, 'ascii');
  block.write('00', 263, 'ascii');
  prefix.copy(block, 345);
  let sum = 0;
  for (const byte of block) sum += byte;
  block.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 'ascii');
  return block;
}

/** Every folder and regular file under `root`, relative, parents first, in a stable order. */
function exportEntries(root: string): Array<{ rel: string; type: 'file' | 'dir'; size: number; mtime: number }> {
  const out: Array<{ rel: string; type: 'file' | 'dir'; size: number; mtime: number }> = [];
  const walk = (dir: string, rel: string) => {
    for (const name of readdirSync(dir).sort()) {
      const path = join(dir, name);
      const childRel = rel ? `${rel}/${name}` : name;
      const stat = lstatSync(path);
      if (stat.isDirectory()) {
        out.push({ rel: `${childRel}/`, type: 'dir', size: 0, mtime: stat.mtimeMs });
        walk(path, childRel);
      } else if (stat.isFile()) {
        out.push({ rel: childRel, type: 'file', size: stat.size, mtime: stat.mtimeMs });
      } else {
        throw new OperationError('source_index_error', `The export holds something that is not a file or a folder: ${childRel}`);
      }
    }
  };
  walk(root, '');
  return out;
}

/** Streams body bytes through the cipher (or the digest) into the open file. */
class BodyWriter {
  private readonly hash: Hash | undefined;
  private readonly cipher: CipherGCM | undefined;
  bytes = 0;

  constructor(private readonly handle: FileHandle, header: Buffer, key: Buffer | undefined, nonce: Buffer | undefined) {
    if (key && nonce) {
      this.cipher = createCipheriv('aes-256-gcm', key, nonce, { authTagLength: TAG_BYTES }) as CipherGCM;
      this.cipher.setAAD(header);
    } else {
      this.hash = createHash('sha256').update(header);
    }
  }

  async write(plain: Buffer): Promise<void> {
    const out = this.cipher ? this.cipher.update(plain) : plain;
    this.hash?.update(out);
    if (out.length > 0) await this.handle.write(out);
    this.bytes += out.length;
  }

  async finish(): Promise<void> {
    if (this.cipher) {
      const rest = this.cipher.final();
      if (rest.length > 0) await this.handle.write(rest);
      await this.handle.write(this.cipher.getAuthTag());
    } else {
      await this.handle.write(this.hash!.digest());
    }
  }
}

/**
 * Pack an export folder into one backup file in `folder`. The file is written
 * under a temporary name beside its final one and renamed only when complete,
 * so a backup that stops part way never looks like a backup.
 */
export async function writeBackupFile(options: {
  exportDir: string;
  folder: string;
  key?: BackupKey;
  now?: Date;
}): Promise<BackupFileInfo> {
  const now = options.now ?? new Date();
  // A backup no restore could open is never written: its key setting is checked first.
  if (options.key) checkKdf(options.key.kdf);
  const folder = resolve(options.folder);
  mkdirSync(folder, { recursive: true });
  let name = backupFileName(now);
  for (let n = 2; existsSync(join(folder, name)); n += 1) name = backupFileName(now).replace(BACKUP_FILE_EXTENSION, `-${n}${BACKUP_FILE_EXTENSION}`);
  const target = join(folder, name);
  const staging = join(folder, `.${name}.${randomUUID()}.partial`);
  const nonce = options.key ? randomBytes(12) : undefined;
  const header = encodeHeader({
    kind: 'olympus_backup',
    format: BACKUP_FORMAT_VERSION,
    encrypted: options.key !== undefined,
    created_at: now.toISOString(),
    ...(options.key ? {
      kdf: options.key.kdf,
      cipher: 'aes-256-gcm' as const,
      nonce: nonce!.toString('base64'),
      key_check: backupKeyCheck(options.key.key),
    } : {}),
  });
  // ustar keeps a size in 11 octal digits: refuse a file it can't describe
  // before anything is written, so no backup is published that can't be read.
  const entries = exportEntries(options.exportDir);
  const tooLarge = entries.find((entry) => entry.size > USTAR_MAX_SIZE);
  if (tooLarge) throw new OperationError('source_index_error', `A file in the export is too large to back up (64 GiB or more): ${tooLarge.rel}`);
  const handle = await openAsync(staging, 'wx', 0o600);
  try {
    await handle.write(header);
    const body = new BodyWriter(handle, header, options.key?.key, nonce);
    const buffer = Buffer.alloc(CHUNK);
    for (const entry of entries) {
      await body.write(tarHeader(entry.rel, entry.size, entry.type === 'dir' ? '5' : '0', entry.mtime));
      if (entry.type === 'dir') continue;
      const source = await openAsync(join(options.exportDir, entry.rel), 'r');
      try {
        let left = entry.size;
        while (left > 0) {
          const { bytesRead } = await source.read(buffer, 0, Math.min(CHUNK, left), null);
          if (bytesRead === 0) throw new OperationError('source_index_error', `A file in the export changed while it was backed up: ${entry.rel}`);
          await body.write(Buffer.from(buffer.subarray(0, bytesRead)));
          left -= bytesRead;
        }
      } finally {
        await source.close();
      }
      const pad = (512 - (entry.size % 512)) % 512;
      if (pad > 0) await body.write(Buffer.alloc(pad));
    }
    await body.write(Buffer.alloc(1024));
    await body.finish();
    await handle.sync();
  } catch (error) {
    await handle.close().catch(() => undefined);
    rmSync(staging, { force: true });
    throw error;
  }
  await handle.close();
  renameSync(staging, target);
  syncDirectorySync(folder);
  return { path: target, name, bytes: statSync(target).size, encrypted: options.key !== undefined, createdAt: now.toISOString() };
}

// ---- reading ----------------------------------------------------------------

function readExactly(fd: number, length: number, position: number): Buffer {
  const out = Buffer.alloc(length);
  let done = 0;
  while (done < length) {
    const read = readSync(fd, out, done, length - done, position + done);
    if (read === 0) break;
    done += read;
  }
  return out.subarray(0, done);
}

function notABackup(path: string): OperationError {
  return new OperationError('invalid_params', `${basename(path)} is not an Olympus backup.`, 'Choose a file whose name ends in .olympusbackup, or a folder made by olympus data export.');
}

/** The header of a backup file, and where its body starts. */
export function readBackupHeader(path: string): { header: BackupHeader; headerBytes: Buffer; bodyStart: number; size: number } {
  const fd = openSync(path, 'r');
  try {
    const size = statSync(path).size;
    const lead = readExactly(fd, MAGIC.length + 4, 0);
    if (lead.length < MAGIC.length + 4 || !lead.subarray(0, MAGIC.length).equals(MAGIC)) throw notABackup(path);
    const length = lead.readUInt32BE(MAGIC.length);
    if (length === 0 || length > MAX_HEADER_BYTES) throw notABackup(path);
    const json = readExactly(fd, length, MAGIC.length + 4);
    if (json.length !== length) throw notABackup(path);
    let header: BackupHeader;
    try { header = JSON.parse(json.toString('utf8')) as BackupHeader; } catch { throw notABackup(path); }
    if (header.kind !== 'olympus_backup' || typeof header.encrypted !== 'boolean') throw notABackup(path);
    if (header.format !== BACKUP_FORMAT_VERSION) {
      throw new OperationError('invalid_params', 'This backup was made by a newer version of Olympus.', 'Update Olympus, then restore again.');
    }
    const bodyStart = MAGIC.length + 4 + length;
    if (size < bodyStart + (header.encrypted ? TAG_BYTES : DIGEST_BYTES)) throw new OperationError('invalid_params', 'This backup is incomplete: it ends early.');
    return { header, headerBytes: Buffer.concat([lead, json]), bodyStart, size };
  } finally {
    closeSync(fd);
  }
}

/** True when a file starts like an Olympus backup (retention deletes nothing else). */
export function isBackupFile(path: string): boolean {
  try {
    const fd = openSync(path, 'r');
    try { return readExactly(fd, MAGIC.length, 0).equals(MAGIC); } finally { closeSync(fd); }
  } catch {
    return false;
  }
}

/**
 * A streaming ustar reader that writes what it reads under `root`: regular
 * files and folders only, every path inside `root`, nothing else accepted.
 */
class TarExtractor {
  private pending = Buffer.alloc(0);
  private file: { fd: number; left: number; pad: number } | undefined;
  private skip = 0;
  private ended = false;

  constructor(private readonly root: string) {}

  private target(name: string): string {
    if (name === '' || name.startsWith('/') || name.includes('\0') || name.includes('\\')) throw this.bad();
    const parts = name.split('/').filter((part) => part !== '');
    if (parts.length === 0 || parts.some((part) => part === '.' || part === '..')) throw this.bad();
    const path = join(this.root, ...parts);
    if (!path.startsWith(this.root + sep)) throw this.bad();
    return path;
  }

  private bad(): OperationError {
    return new OperationError('invalid_params', 'This backup holds something Olympus will not restore.');
  }

  push(chunk: Buffer): void {
    let data = this.pending.length ? Buffer.concat([this.pending, chunk]) : chunk;
    this.pending = Buffer.alloc(0);
    while (data.length > 0) {
      if (this.file) {
        const take = Math.min(this.file.left, data.length);
        if (take > 0) {
          let written = 0;
          while (written < take) written += writeSync(this.file.fd, data, written, take - written);
          this.file.left -= take;
          data = data.subarray(take);
        }
        if (this.file.left === 0) {
          fsyncSync(this.file.fd);
          closeSync(this.file.fd);
          this.skip = this.file.pad;
          this.file = undefined;
        }
        continue;
      }
      if (this.skip > 0) {
        const take = Math.min(this.skip, data.length);
        this.skip -= take;
        data = data.subarray(take);
        continue;
      }
      if (this.ended) {
        // Only zero blocks may follow the end.
        if (data.some((byte) => byte !== 0)) throw this.bad();
        return;
      }
      if (data.length < 512) {
        this.pending = Buffer.from(data);
        return;
      }
      const block = data.subarray(0, 512);
      data = data.subarray(512);
      if (block.every((byte) => byte === 0)) {
        this.ended = true;
        continue;
      }
      const field = (start: number, length: number) => {
        const raw = block.subarray(start, start + length);
        const end = raw.indexOf(0);
        return (end >= 0 ? raw.subarray(0, end) : raw).toString('utf8');
      };
      let sum = 0;
      for (let i = 0; i < 512; i += 1) sum += i >= 148 && i < 156 ? 32 : block[i]!;
      if (Number.parseInt(field(148, 8).trim(), 8) !== sum || field(257, 6) !== 'ustar') throw this.bad();
      const prefix = field(345, 155);
      const name = prefix ? `${prefix}/${field(0, 100)}` : field(0, 100);
      const size = Number.parseInt(field(124, 12).trim() || '0', 8);
      const type = field(156, 1) || '0';
      if (!Number.isSafeInteger(size) || size < 0) throw this.bad();
      const path = this.target(name);
      if (type === '5') {
        mkdirSync(path, { recursive: true, mode: 0o700 });
        continue;
      }
      if (type !== '0') throw this.bad();
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      const fd = openSync(path, 'wx', 0o600);
      this.file = { fd, left: size, pad: (512 - (size % 512)) % 512 };
      if (size === 0) {
        closeSync(fd);
        this.file = undefined;
      }
    }
  }

  finish(): void {
    if (this.file || this.pending.length > 0 || !this.ended) throw new OperationError('invalid_params', 'This backup is incomplete: it ends early.');
  }

  abort(): void {
    if (this.file) {
      try { closeSync(this.file.fd); } catch { /* already closed */ }
      this.file = undefined;
    }
  }
}

export const BACKUP_WRONG_PASSPHRASE = 'That passphrase does not open this backup.';
export const BACKUP_CHANGED = 'This backup has been changed or damaged since it was made, so nothing was restored.';

/**
 * Open a backup file into `into` (which must not exist yet): checks the
 * passphrase against the header's key check first, then decrypts and unpacks.
 * Only once the tag (or digest) checks out is the result returned; on any
 * failure `into` is removed, so nothing from a changed file is ever used.
 */
export function openBackupFile(options: { file: string; into: string; passphrase?: string; key?: BackupKey }): { exportDir: string; encrypted: boolean } {
  const { header, headerBytes, bodyStart, size } = readBackupHeader(options.file);
  let decipher: DecipherGCM | undefined;
  let hash: Hash | undefined;
  const trailerBytes = header.encrypted ? TAG_BYTES : DIGEST_BYTES;
  const bodyEnd = size - trailerBytes;
  if (header.encrypted) {
    if (!header.kdf || header.cipher !== 'aes-256-gcm' || typeof header.nonce !== 'string' || typeof header.key_check !== 'string') throw notABackup(options.file);
    checkKdf(header.kdf);
    let key: Buffer;
    if (options.key && options.key.kdf.salt === header.kdf.salt && options.key.kdf.N === header.kdf.N && options.key.kdf.r === header.kdf.r && options.key.kdf.p === header.kdf.p) {
      key = options.key.key;
    } else if (options.passphrase !== undefined) {
      key = deriveBackupKey(options.passphrase, header.kdf).key;
    } else {
      throw new OperationError('invalid_params', 'This backup is encrypted. Enter its passphrase.', 'Run it again with --passphrase-stdin and type the passphrase.');
    }
    const check = Buffer.from(backupKeyCheck(key), 'base64');
    const stored = Buffer.from(header.key_check, 'base64');
    if (stored.length !== check.length || !timingSafeEqual(stored, check)) throw new OperationError('invalid_params', BACKUP_WRONG_PASSPHRASE);
    const nonce = Buffer.from(header.nonce, 'base64');
    if (nonce.length !== 12) throw notABackup(options.file);
    decipher = createDecipheriv('aes-256-gcm', key, nonce, { authTagLength: TAG_BYTES }) as DecipherGCM;
    decipher.setAAD(headerBytes);
  } else {
    hash = createHash('sha256').update(headerBytes);
  }

  const into = resolve(options.into);
  if (existsSync(into)) throw new OperationError('invalid_params', `${into} already exists.`);
  mkdirSync(into, { recursive: true, mode: 0o700 });
  chmodSync(into, 0o700);
  const exportDir = join(into, 'export');
  mkdirSync(exportDir, { mode: 0o700 });
  const extractor = new TarExtractor(exportDir);
  // A malformed archive inside a body that fails its check is a changed file,
  // not a bad archive: unpacking stops, the check still runs to the end.
  let archiveError: unknown;
  const unpack = (plain: Buffer) => {
    if (archiveError !== undefined) return;
    try { extractor.push(plain); } catch (error) { archiveError = error; }
  };
  const fd = openSync(options.file, 'r');
  try {
    const buffer = Buffer.alloc(CHUNK);
    for (let at = bodyStart; at < bodyEnd;) {
      const read = readSync(fd, buffer, 0, Math.min(CHUNK, bodyEnd - at), at);
      if (read === 0) throw new OperationError('invalid_params', 'This backup is incomplete: it ends early.');
      const chunk = buffer.subarray(0, read);
      at += read;
      if (hash) hash.update(chunk);
      unpack(decipher ? decipher.update(chunk) : Buffer.from(chunk));
    }
    const trailer = readExactly(fd, trailerBytes, bodyEnd);
    if (decipher) {
      decipher.setAuthTag(trailer);
      let rest: Buffer;
      try { rest = decipher.final(); } catch { throw new OperationError('invalid_params', BACKUP_CHANGED); }
      unpack(rest);
    } else if (!hash!.digest().equals(trailer)) {
      throw new OperationError('invalid_params', BACKUP_CHANGED);
    }
    if (archiveError !== undefined) throw archiveError;
    extractor.finish();
    return { exportDir, encrypted: header.encrypted };
  } catch (error) {
    extractor.abort();
    rmSync(into, { recursive: true, force: true });
    throw error;
  } finally {
    closeSync(fd);
  }
}

// ---- a backup folder ----------------------------------------------------------

/**
 * The Olympus backups in a folder, newest first (by the time each says it was
 * made). By default only files named as Olympus names its backups, which is
 * what retention may delete. `anyName` lists every `.olympusbackup` file whose
 * header reads as a backup, whatever it was renamed to (a copy downloaded
 * twice is `... (1).olympusbackup`): what a restore can open.
 */
export function listBackups(folder: string, options: { anyName?: boolean } = {}): BackupFileInfo[] {
  let names: string[];
  try { names = readdirSync(folder); } catch { return []; }
  const out: BackupFileInfo[] = [];
  for (const name of names) {
    if (options.anyName === true ? !name.endsWith(BACKUP_FILE_EXTENSION) : !BACKUP_NAME.test(name)) continue;
    const path = join(folder, name);
    try {
      const stat = lstatSync(path);
      if (!stat.isFile()) continue;
      const { header } = readBackupHeader(path);
      out.push({ path, name, bytes: stat.size, encrypted: header.encrypted, createdAt: header.created_at });
    } catch {
      // Not one of ours, or unreadable: never listed, never deleted.
    }
  }
  const order = (backup: BackupFileInfo) => `${backup.createdAt}|${backup.name.replace(BACKUP_FILE_EXTENSION, '').padEnd(40, ' ')}`;
  return out.sort((a, b) => (order(a) < order(b) ? 1 : order(a) > order(b) ? -1 : 0));
}

/**
 * Keep the newest `keep` backups in a folder and delete older ones. Only
 * files named and shaped like Olympus backups are ever deleted.
 */
export function pruneBackups(folder: string, keep = BACKUP_KEEP): string[] {
  const removed: string[] = [];
  for (const backup of listBackups(folder).slice(keep)) {
    if (!isBackupFile(backup.path)) continue;
    unlinkSync(backup.path);
    removed.push(backup.name);
  }
  if (removed.length > 0) syncDirectorySync(folder);
  return removed;
}

// ---- backup and restore, whole --------------------------------------------------

/** A private folder of its own under the data root's backup staging folder. */
export function backupStagingDir(env: Record<string, string | undefined>): string {
  const root = sharedDataPath('backup-staging', env);
  mkdirSync(root, { recursive: true, mode: 0o700 });
  chmodSync(root, 0o700);
  return join(root, randomUUID());
}

export interface DataBackupResult {
  ok: true;
  file: string;
  bytes: number;
  encrypted: boolean;
  createdAt: string;
  /** Older backups this one replaced in the folder (only with `keep`). */
  removed: string[];
}

/**
 * Export, then pack the export into one backup file in `folder`. `exportInto`
 * writes the export (the CLI routes it through a running worker; the worker
 * calls exportOlympusData itself, as owner). The staging folder is always removed.
 */
export async function backupOlympusData(options: {
  folder: string;
  key?: BackupKey;
  now?: Date;
  /** Keep only this many backups in the folder afterwards. */
  keep?: number;
  /** Throws to keep every older backup: asked after the new one is written, before any is removed. */
  beforePrune?: () => void;
  exportInto: (destination: string) => unknown | Promise<unknown>;
} & LifecyclePathContext): Promise<DataBackupResult> {
  const folder = resolve(options.folder);
  const staging = backupStagingDir(lifecycleEnv(options));
  try {
    mkdirSync(staging, { mode: 0o700 });
    const exportDir = join(staging, 'export');
    await options.exportInto(exportDir);
    const written = await writeBackupFile({ exportDir, folder, ...(options.key ? { key: options.key } : {}), ...(options.now ? { now: options.now } : {}) });
    if (options.keep) options.beforePrune?.();
    const removed = options.keep ? pruneBackups(folder, options.keep) : [];
    return { ok: true, file: written.path, bytes: written.bytes, encrypted: written.encrypted, createdAt: written.createdAt, removed };
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

/**
 * Restore from a backup file or an export folder. A file is opened into a
 * private staging folder first (decrypted and checked whole before anything
 * is restored from it), and the staging folder is removed afterwards.
 */
export function restoreOlympusBackup(options: { input: string; passphrase?: string; key?: BackupKey; dryRun?: boolean } & LifecyclePathContext): DataRestoreResult & { encrypted?: boolean } {
  const input = resolve(options.input);
  const context: LifecyclePathContext = {
    ...(options.homeDir ? { homeDir: options.homeDir } : {}),
    ...(options.env ? { env: options.env } : {}),
  };
  if (!existsSync(input)) throw new OperationError('invalid_params', `${input} does not exist.`);
  if (statSync(input).isDirectory()) return restoreOlympusData({ input, ...(options.dryRun ? { dryRun: true } : {}), ...context });
  const staging = backupStagingDir(lifecycleEnv(context));
  try {
    const opened = openBackupFile({
      file: input,
      into: staging,
      ...(options.passphrase !== undefined ? { passphrase: options.passphrase } : {}),
      ...(options.key ? { key: options.key } : {}),
    });
    const result = restoreOlympusData({ input: opened.exportDir, ...(options.dryRun ? { dryRun: true } : {}), ...context });
    return { ...result, input, encrypted: opened.encrypted };
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}
