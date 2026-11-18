import { CString, read, type Pointer } from 'bun:ffi';
import { constants, type Database } from 'bun:sqlite';
import { fstatSync } from 'node:fs';

/**
 * SQLite exposes its open file through FILE_POINTER. On the 64-bit Unix VFS
 * the file descriptor follows pMethods, pVfs and pInode in unixFile.
 * HAS_MOVED alone only compares inode numbers against a pathname.
 *
 * The worker embeds this function in its inline source. Keep its runtime
 * dependencies in the arguments so the source also works in a bundle.
 */
export function sqliteFileIdentity(
  db: Database,
  fsStat: typeof fstatSync,
  native: typeof read,
  NativeString: typeof CString,
  opcodes: typeof constants,
): string {
  if (!['darwin', 'linux'].includes(process.platform) || !['arm64', 'x64'].includes(process.arch)) {
    throw new Error('SQLite file identity requires a supported Unix VFS');
  }
  const file = new BigUint64Array(1);
  const vfs = new BigUint64Array(1);
  if (db.fileControl(opcodes.SQLITE_FCNTL_FILE_POINTER, file) !== 0 || !file[0]
    || db.fileControl(opcodes.SQLITE_FCNTL_VFS_POINTER, vfs) !== 0 || !vfs[0]) {
    throw new Error('SQLite did not expose its open file');
  }
  const filePtr = Number(file[0]) as Pointer;
  const vfsPtr = Number(vfs[0]) as Pointer;
  const name = native.ptr(vfsPtr, 24);
  if (!name || String(new NativeString(name as Pointer)) !== 'unix' || native.ptr(filePtr, 8) !== vfsPtr
    || native.i32(vfsPtr, 4) < 28) {
    throw new Error('SQLite file identity requires the Unix file layout');
  }
  const stat = fsStat(native.i32(filePtr, 24), { bigint: true });
  if (!stat.isFile()) throw new Error('SQLite did not open a regular file');
  return stat.dev + ':' + stat.ino;
}

export function openedSqliteFileIdentity(db: Database): string {
  return sqliteFileIdentity(db, fstatSync, read, CString, constants);
}
