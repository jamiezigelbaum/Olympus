// Receiving a dropped archive (workers/archive-import/staging.ts): the paths it will and will not take, what lands on
// disk and where, streaming (never held whole), the free-disk pause that goes on by itself, cancel and the sweep of
// copies nothing reads. Every expectation here is written from the rules the owner gave (2026-10-26) and from what a
// path means, not from the implementation.

import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, lstatSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ARCHIVE_UPLOAD_IDLE_MS,
  ARCHIVE_UPLOAD_CHUNK_BYTES,
  ARCHIVE_UPLOAD_MAX_CHUNK_BYTES,
  ArchiveUploadError,
  createArchiveUploads,
  sanitizeUploadPath,
  type ArchiveUploads,
} from '../src/workers/archive-import/staging.ts';

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

function fixture(options: { freeBytes?: (path: string) => number; pause?: (ms: number) => Promise<void>; now?: () => number } = {}) {
  const base = mkdtempSync(join(tmpdir(), 'archive-staging-'));
  const root = join(base, 'archive-staging');
  const uploads = createArchiveUploads({ root, ...options });
  cleanups.push(() => {
    uploads.close();
    rmSync(base, { recursive: true, force: true });
  });
  return { base, root, uploads };
}

const bytesOf = (text: string): ReadableStream<Uint8Array> => new Response(text).body!;
const code = async (work: Promise<unknown>): Promise<string | undefined> => {
  try {
    await work;
    return undefined;
  } catch (error) {
    return error instanceof ArchiveUploadError ? error.code : `other: ${String(error)}`;
  }
};
const settle = (ms = 5): Promise<void> => new Promise<void>((resolve) => setTimeout(resolve, ms));
async function until(ready: () => boolean, ms = 2000): Promise<void> {
  const end = Date.now() + ms;
  while (!ready() && Date.now() < end) await settle();
}

/** A body the test feeds by hand, so it can look at the disk while the sender is still sending. */
function liveBody() {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const body = new ReadableStream<Uint8Array>({ start(c) { controller = c; } });
  return { body, send: (text: string) => controller.enqueue(new TextEncoder().encode(text)), end: () => controller.close(), fail: () => controller.error(new Error('the connection dropped')) };
}

describe('which relative paths are taken', () => {
  test('ordinary folder and file names, at any depth, with spaces and non-Latin letters', () => {
    expect(sanitizeUploadPath('result.json')).toEqual(['result.json']);
    expect(sanitizeUploadPath('DataExport 2026-10-20/chats/chat_01/messages 1.json')).toEqual(['DataExport 2026-10-20', 'chats', 'chat_01', 'messages 1.json']);
    expect(sanitizeUploadPath('Ünïcode/聊天/файл.txt')).toEqual(['Ünïcode', '聊天', 'файл.txt']);
    expect(sanitizeUploadPath('.hidden/.DS_Store')).toEqual(['.hidden', '.DS_Store']);
    // A name that merely contains dots is a name.
    expect(sanitizeUploadPath('a..b/c...d')).toEqual(['a..b', 'c...d']);
  });

  test('anything that could leave the upload\'s own folder, or names nothing, is refused', () => {
    const refused = [
      '', '/', '/etc/passwd', '../outside', 'a/../../outside', 'a/..', '..', '.', './a', 'a/./b', 'a//b', 'a/', '/a',
      '\\windows\\system32', 'C:\\Users\\me\\x', 'C:/Users/me/x', '\\\\server\\share\\x', 'a\\..\\..\\b',
      'a\u0000b', 'a/b\nc', 'tab\there', 'del\u007f',
      'a/'.repeat(65) + 'b', 'x'.repeat(256), 'y'.repeat(5000),
    ];
    for (const path of refused) {
      expect(() => sanitizeUploadPath(path), JSON.stringify(path).slice(0, 40)).toThrow(ArchiveUploadError);
    }
    for (const notAPath of [undefined, null, 7, {}, ['a']] as unknown[]) expect(() => sanitizeUploadPath(notAPath)).toThrow(ArchiveUploadError);
  });
});

describe('what lands on disk', () => {
  test('a folder\'s files keep their relative paths under the upload\'s own folder, with the dates they had', async () => {
    const f = fixture();
    const { uploadId } = f.uploads.begin();
    expect(uploadId).toMatch(/^[0-9a-f]{32}$/);
    const modified = Date.parse('2024-03-04T05:06:07.000Z');
    expect(await f.uploads.receive(uploadId, 'Export/result.json', bytesOf('{"a":1}'), { modified })).toEqual({ bytes: 7 });
    await f.uploads.receive(uploadId, 'Export/chats/one/messages.json', bytesOf('[]'));
    await f.uploads.receive(uploadId, 'Export/empty.txt', bytesOf(''));
    const files = join(f.root, uploadId, 'files');
    expect(readFileSync(join(files, 'Export/result.json'), 'utf8')).toBe('{"a":1}');
    expect(readFileSync(join(files, 'Export/chats/one/messages.json'), 'utf8')).toBe('[]');
    expect(statSync(join(files, 'Export/empty.txt')).size).toBe(0);
    expect(statSync(join(files, 'Export/result.json')).mtimeMs).toBe(modified);
    // Private to the owner.
    expect(statSync(files).mode & 0o077).toBe(0);
    expect(statSync(join(files, 'Export/result.json')).mode & 0o077).toBe(0);
    expect(f.uploads.status(uploadId)).toEqual({ state: 'idle', files: 3, bytes: 9 });
    // One folder dropped is the thing to import: its own path, canonical.
    expect(f.uploads.chosenPath(uploadId)).toBe(statSyncReal(join(files, 'Export')));
  });

  test('one dropped file is the thing to import; several things dropped together are imported from their common folder', async () => {
    const f = fixture();
    const one = f.uploads.begin().uploadId;
    await f.uploads.receive(one, 'Takeout.mbox', bytesOf('From a@b\n'));
    expect(f.uploads.chosenPath(one)).toBe(statSyncReal(join(f.root, one, 'files', 'Takeout.mbox')));
    const two = f.uploads.begin().uploadId;
    await f.uploads.receive(two, 'a.mbox', bytesOf('x'));
    await f.uploads.receive(two, 'b.mbox', bytesOf('y'));
    expect(f.uploads.chosenPath(two)).toBe(statSyncReal(join(f.root, two, 'files')));
  });

  test('a refused path writes nothing, inside or outside the staging folder', async () => {
    const f = fixture();
    const { uploadId } = f.uploads.begin();
    for (const path of ['../escape.txt', 'a/../../escape.txt', '/tmp/escape.txt', 'C:\\escape.txt', '']) {
      expect(await code(f.uploads.receive(uploadId, path, bytesOf('x')))).toBe('bad_path');
    }
    expect(readdirSync(join(f.root, uploadId, 'files'))).toEqual([]);
    expect(readdirSync(f.base)).toEqual(['archive-staging']);
    expect(readdirSync(f.root)).toEqual([uploadId]);
    expect(f.uploads.status(uploadId)).toEqual({ state: 'idle', files: 0, bytes: 0 });
  });

  test('the same path twice is refused, and a file and a folder cannot share a name', async () => {
    const f = fixture();
    const { uploadId } = f.uploads.begin();
    await f.uploads.receive(uploadId, 'a/b.txt', bytesOf('first'));
    expect(await code(f.uploads.receive(uploadId, 'a/b.txt', bytesOf('second')))).toBe('duplicate_file');
    expect(readFileSync(join(f.root, uploadId, 'files/a/b.txt'), 'utf8')).toBe('first');
    expect(await code(f.uploads.receive(uploadId, 'a/b.txt/c.txt', bytesOf('x')))).toBe('bad_path');
    await f.uploads.receive(uploadId, 'folder/file', bytesOf('x'));
    expect(await code(f.uploads.receive(uploadId, 'folder', bytesOf('x')))).toBe('duplicate_file');
  });

  test('a link planted inside the staging copy is never followed out of it', async () => {
    const f = fixture();
    const { uploadId } = f.uploads.begin();
    const outside = join(f.base, 'outside');
    rmSync(outside, { recursive: true, force: true });
    writeFileSync(join(f.base, 'secret.txt'), 'secret');
    // Somebody leaves a link where a folder of the upload would be made.
    symlinkSync(f.base, join(f.root, uploadId, 'files', 'link'));
    expect(await code(f.uploads.receive(uploadId, 'link/planted.txt', bytesOf('x')))).toBe('bad_path');
    expect(existsSync(join(f.base, 'planted.txt'))).toBe(false);
    // A link where the file itself goes is not written through either.
    symlinkSync(join(f.base, 'secret.txt'), join(f.root, uploadId, 'files', 'through.txt'));
    expect(await code(f.uploads.receive(uploadId, 'through.txt', bytesOf('overwritten')))).toBe('duplicate_file');
    expect(readFileSync(join(f.base, 'secret.txt'), 'utf8')).toBe('secret');
    expect(lstatSync(join(f.root, uploadId, 'files', 'through.txt')).isSymbolicLink()).toBe(true);
  });

  test('an id that is not an upload\'s own names nothing: no file is written, nothing outside is deleted', async () => {
    const f = fixture();
    f.uploads.begin();
    writeFileSync(join(f.base, 'keep.txt'), 'keep');
    for (const id of ['../..', '..', '', '0'.repeat(32), `${'a'.repeat(31)}/`, 'not hex at all']) {
      expect(await code(f.uploads.receive(id, 'a.txt', bytesOf('x')))).toBe('unknown_upload');
      expect(() => f.uploads.status(id)).toThrow(ArchiveUploadError);
      // A well-formed id nothing has ever been made under has nothing to delete either way.
      if (!/^[0-9a-f]{32}$/.test(id)) expect(f.uploads.cancel(id)).toBe(false);
      f.uploads.release(id);
      expect(() => f.uploads.chosenPath(id)).toThrow(ArchiveUploadError);
    }
    expect(readFileSync(join(f.base, 'keep.txt'), 'utf8')).toBe('keep');
  });
});

describe('streaming, with no size limit', () => {
  test('a file of any size goes in pieces, each small enough that the server never holds a large body', () => {
    // Bun keeps a request body it was sent in memory and does not hold the sender back (measured 2026-10-26), and refuses one
    // over 128 MiB: a piece is far under both, and a file has no limit because it is any number of pieces.
    expect(ARCHIVE_UPLOAD_CHUNK_BYTES).toBeGreaterThan(0);
    expect(ARCHIVE_UPLOAD_CHUNK_BYTES).toBeLessThanOrEqual(ARCHIVE_UPLOAD_MAX_CHUNK_BYTES);
    expect(ARCHIVE_UPLOAD_MAX_CHUNK_BYTES).toBeLessThan(128 * 1024 * 1024);
  });

  test('a file is on disk as it arrives, a chunk at a time, never held until it ends', async () => {
    const f = fixture();
    const { uploadId } = f.uploads.begin();
    const live = liveBody();
    const receiving = f.uploads.receive(uploadId, 'big.bin', live.body);
    const target = join(f.root, uploadId, 'files', 'big.bin');
    live.send('0123456789');
    await until(() => existsSync(target) && statSync(target).size === 10);
    // The sender has not finished, and ten bytes are already on disk and counted.
    expect(statSync(target).size).toBe(10);
    expect(f.uploads.status(uploadId)).toEqual({ state: 'receiving', files: 0, bytes: 10 });
    live.send('abcdef');
    await until(() => statSync(target).size === 16);
    live.end();
    expect(await receiving).toEqual({ bytes: 16 });
    expect(readFileSync(target, 'utf8')).toBe('0123456789abcdef');
    expect(f.uploads.status(uploadId)).toEqual({ state: 'idle', files: 1, bytes: 16 });
  });

  test('a generated 600 MB file arrives as pieces without the engine holding more than a piece, and has no limit on its size', async () => {
    const f = fixture({ freeBytes: () => 1024 ** 5 });
    const { uploadId } = f.uploads.begin();
    const chunk = new Uint8Array(ARCHIVE_UPLOAD_CHUNK_BYTES).fill(7);
    const pieces = 75; // 600 MiB
    const total = pieces * chunk.byteLength;
    const before = process.memoryUsage().rss;
    let peak = before;
    for (let index = 0; index < pieces; index += 1) {
      const body = new ReadableStream<Uint8Array>({ pull(controller) { controller.enqueue(chunk); controller.close(); } });
      const result = await f.uploads.receive(uploadId, 'huge.bin', body, { offset: index * chunk.byteLength, final: index === pieces - 1, declaredBytes: chunk.byteLength });
      expect(result.bytes).toBe(chunk.byteLength);
      peak = Math.max(peak, process.memoryUsage().rss);
    }
    expect(statSync(join(f.root, uploadId, 'files', 'huge.bin')).size).toBe(total);
    expect(f.uploads.status(uploadId)).toEqual({ state: 'idle', files: 1, bytes: total });
    // Held whole it would add 600 MB; in pieces it adds a small, flat amount.
    expect(peak - before).toBeLessThan(200 * 1024 * 1024);
  });

  test('a file in pieces is put together in order, counted once whole, and cannot be imported while pieces are still to come', async () => {
    const f = fixture();
    const { uploadId } = f.uploads.begin();
    const modified = Date.parse('2024-03-04T05:06:07.000Z');
    expect(await f.uploads.receive(uploadId, 'Export/big.json', bytesOf('0123'), { offset: 0, final: false, modified })).toEqual({ bytes: 4 });
    expect(f.uploads.status(uploadId)).toEqual({ state: 'idle', files: 0, bytes: 4 });
    expect(() => f.uploads.chosenPath(uploadId)).toThrow(ArchiveUploadError);
    await f.uploads.receive(uploadId, 'Export/big.json', bytesOf('4567'), { offset: 4, final: false, modified });
    expect(f.uploads.status(uploadId)).toEqual({ state: 'idle', files: 0, bytes: 8 });
    expect(await f.uploads.receive(uploadId, 'Export/big.json', bytesOf('89'), { offset: 8, final: true, modified })).toEqual({ bytes: 2 });
    const path = join(f.root, uploadId, 'files/Export/big.json');
    expect(readFileSync(path, 'utf8')).toBe('0123456789');
    expect(statSync(path).mtimeMs).toBe(modified);
    expect(f.uploads.status(uploadId)).toEqual({ state: 'idle', files: 1, bytes: 10 });
    expect(() => f.uploads.chosenPath(uploadId)).not.toThrow();
    // Whole now: a file of that name cannot begin again.
    expect(await code(f.uploads.receive(uploadId, 'Export/big.json', bytesOf('x')))).toBe('duplicate_file');
  });

  test('a piece out of order, repeated, for a file never begun, or at a place that is not a number is refused and changes nothing', async () => {
    const f = fixture();
    const { uploadId } = f.uploads.begin();
    await f.uploads.receive(uploadId, 'a.bin', bytesOf('0123'), { offset: 0, final: false });
    const path = join(f.root, uploadId, 'files/a.bin');
    // Skipping ahead, going back (a piece sent twice) and beginning a file with a later piece.
    expect(await code(f.uploads.receive(uploadId, 'a.bin', bytesOf('zz'), { offset: 6, final: false }))).toBe('bad_offset');
    expect(await code(f.uploads.receive(uploadId, 'a.bin', bytesOf('zz'), { offset: 2, final: false }))).toBe('bad_offset');
    expect(await code(f.uploads.receive(uploadId, 'never.bin', bytesOf('zz'), { offset: 4, final: false }))).toBe('bad_offset');
    for (const offset of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(await code(f.uploads.receive(uploadId, 'a.bin', bytesOf('zz'), { offset, final: false })), String(offset)).toBe('bad_offset');
    }
    // A file already begun cannot be begun again.
    expect(await code(f.uploads.receive(uploadId, 'a.bin', bytesOf('zz'), { offset: 0, final: false }))).toBe('duplicate_file');
    expect(readFileSync(path, 'utf8')).toBe('0123');
    expect(f.uploads.status(uploadId)).toEqual({ state: 'idle', files: 0, bytes: 4 });
    // The file goes on from where it was.
    await f.uploads.receive(uploadId, 'a.bin', bytesOf('45'), { offset: 4, final: true });
    expect(readFileSync(path, 'utf8')).toBe('012345');
  });

  test('two pieces of one file at the same time are refused: a file is written in order, one piece at a time', async () => {
    const f = fixture();
    const { uploadId } = f.uploads.begin();
    await f.uploads.receive(uploadId, 'a.bin', bytesOf('0123'), { offset: 0, final: false });
    const live = liveBody();
    const second = f.uploads.receive(uploadId, 'a.bin', live.body, { offset: 4, final: false });
    await until(() => f.uploads.status(uploadId).state === 'receiving');
    expect(await code(f.uploads.receive(uploadId, 'a.bin', bytesOf('zz'), { offset: 4, final: false }))).toBe('bad_offset');
    live.send('45');
    live.end();
    await second;
    expect(readFileSync(join(f.root, uploadId, 'files/a.bin'), 'utf8')).toBe('012345');
  });

  test('a piece that breaks takes its whole file with it, so the file is sent again from its start', async () => {
    const f = fixture();
    const { uploadId } = f.uploads.begin();
    await f.uploads.receive(uploadId, 'dir/a.bin', bytesOf('0123'), { offset: 0, final: false });
    const live = liveBody();
    const second = f.uploads.receive(uploadId, 'dir/a.bin', live.body, { offset: 4, final: false });
    live.send('45');
    await until(() => f.uploads.status(uploadId).bytes === 6);
    live.fail();
    expect(await code(second)).toBe('unreadable');
    expect(existsSync(join(f.root, uploadId, 'files/dir/a.bin'))).toBe(false);
    expect(f.uploads.status(uploadId)).toEqual({ state: 'idle', files: 0, bytes: 0 });
    // Nothing is left half-begun: the upload can be imported, and the file can come again whole.
    expect(() => f.uploads.chosenPath(uploadId)).not.toThrow();
    await f.uploads.receive(uploadId, 'dir/a.bin', bytesOf('0123456'), { offset: 0, final: true });
    expect(readFileSync(join(f.root, uploadId, 'files/dir/a.bin'), 'utf8')).toBe('0123456');
  });

  test('a piece larger than the most one request may hold is refused: by its own length without reading a byte, or as soon as it passes the most', async () => {
    const f = fixture();
    const { uploadId } = f.uploads.begin();
    let read = false;
    const body = new ReadableStream<Uint8Array>({ pull(controller) { read = true; controller.close(); } }, { highWaterMark: 0 });
    expect(await code(f.uploads.receive(uploadId, 'a.bin', body, { declaredBytes: ARCHIVE_UPLOAD_MAX_CHUNK_BYTES + 1 }))).toBe('chunk_too_large');
    expect(read).toBe(false);
    expect(existsSync(join(f.root, uploadId, 'files/a.bin'))).toBe(false);
    // No length given: stopped once it has passed the most, and nothing is kept.
    const chunk = new Uint8Array(8 * 1024 * 1024);
    let sent = 0;
    const endless = new ReadableStream<Uint8Array>({ pull(controller) { sent += 1; controller.enqueue(chunk); } });
    expect(await code(f.uploads.receive(uploadId, 'b.bin', endless))).toBe('chunk_too_large');
    expect(sent).toBeLessThan(ARCHIVE_UPLOAD_MAX_CHUNK_BYTES / chunk.byteLength + 4);
    expect(existsSync(join(f.root, uploadId, 'files/b.bin'))).toBe(false);
    expect(f.uploads.status(uploadId)).toEqual({ state: 'idle', files: 0, bytes: 0 });
  });

  test('a sender that drops the connection leaves no partial file, and the same path can be sent again', async () => {
    const f = fixture();
    const { uploadId } = f.uploads.begin();
    const live = liveBody();
    const receiving = f.uploads.receive(uploadId, 'dir/part.bin', live.body);
    live.send('half of it');
    await until(() => f.uploads.status(uploadId).bytes === 10);
    live.fail();
    expect(await code(receiving)).toBe('unreadable');
    expect(existsSync(join(f.root, uploadId, 'files/dir/part.bin'))).toBe(false);
    expect(f.uploads.status(uploadId)).toEqual({ state: 'idle', files: 0, bytes: 0 });
    await f.uploads.receive(uploadId, 'dir/part.bin', bytesOf('whole'));
    expect(readFileSync(join(f.root, uploadId, 'files/dir/part.bin'), 'utf8')).toBe('whole');
  });

  test('the import cannot start while a file is still arriving', async () => {
    const f = fixture();
    const { uploadId } = f.uploads.begin();
    const live = liveBody();
    const receiving = f.uploads.receive(uploadId, 'a.bin', live.body);
    await until(() => f.uploads.status(uploadId).state === 'receiving');
    expect(() => f.uploads.chosenPath(uploadId)).toThrow(ArchiveUploadError);
    live.end();
    await receiving;
    expect(() => f.uploads.chosenPath(uploadId)).not.toThrow();
  });
});

describe('the free-disk floor', () => {
  test('below the floor the receive waits and says so; it goes on by itself once space is free; nothing is refused for size', async () => {
    let free = 1 * 1024 ** 3; // less than the 2 GiB headroom
    const waits: number[] = [];
    let release!: () => void;
    let gate = new Promise<void>((resolve) => { release = resolve; });
    const f = fixture({
      freeBytes: () => free,
      pause: async (ms) => { waits.push(ms); await gate; },
    });
    const { uploadId } = f.uploads.begin();
    const receiving = f.uploads.receive(uploadId, 'a.bin', bytesOf('payload'), { declaredBytes: 7 });
    await until(() => f.uploads.status(uploadId).state === 'paused_disk_full');
    expect(f.uploads.status(uploadId)).toEqual({ state: 'paused_disk_full', files: 0, bytes: 0 });
    expect(waits.length).toBeGreaterThan(0);
    // Still waiting: space is looked at again, and is still short.
    release();
    gate = new Promise<void>((resolve) => { release = resolve; });
    await until(() => waits.length >= 2);
    expect(f.uploads.status(uploadId).state).toBe('paused_disk_full');
    // Space is freed: it goes on without being asked.
    free = 50 * 1024 ** 3;
    release();
    expect(await receiving).toEqual({ bytes: 7 });
    expect(f.uploads.status(uploadId)).toEqual({ state: 'idle', files: 1, bytes: 7 });
    expect(readFileSync(join(f.root, uploadId, 'files/a.bin'), 'utf8')).toBe('payload');
  });

  test('the floor is looked at again while a long file arrives, not only at its start', async () => {
    let free = 100 * 1024 ** 3;
    let looks = 0;
    const f = fixture({ freeBytes: () => { looks += 1; return free; }, pause: () => settle(20) });
    const { uploadId } = f.uploads.begin();
    const live = liveBody();
    const receiving = f.uploads.receive(uploadId, 'long.bin', live.body);
    await until(() => looks >= 1);
    const atStart = looks;
    live.send('x'.repeat(1024));
    // Plenty of room: more bytes is not more looks until a whole stretch has passed.
    await settle(20);
    expect(looks).toBe(atStart);
    free = 0;
    live.send('y'.repeat(20 * 1024 * 1024));
    await until(() => f.uploads.status(uploadId).state === 'paused_disk_full');
    expect(f.uploads.status(uploadId).state).toBe('paused_disk_full');
    // The wait ends with the owner's cancel: nothing is left.
    expect(f.uploads.cancel(uploadId)).toBe(true);
    expect(await code(receiving)).toBe('cancelled');
    expect(existsSync(join(f.root, uploadId))).toBe(false);
  });

  test('a sender that goes away while the disk is full ends the wait, and the copy is swept once it is idle', async () => {
    let clock = 1_000_000;
    const f = fixture({ freeBytes: () => 0, pause: () => settle(5), now: () => clock });
    const { uploadId } = f.uploads.begin();
    const gone = new AbortController();
    const receiving = f.uploads.receive(uploadId, 'second.bin', liveBody().body, { declaredBytes: 7, signal: gone.signal });
    await until(() => f.uploads.status(uploadId).state === 'paused_disk_full');
    gone.abort();
    expect(await code(receiving)).toBe('cancelled');
    // Nothing touches it any more: past the idle limit the sweep takes the whole copy.
    clock += ARCHIVE_UPLOAD_IDLE_MS + 1;
    f.uploads.sweep(() => false);
    expect(existsSync(join(f.root, uploadId))).toBe(false);
  });
});

describe('cancel and the copies nothing reads', () => {
  test('cancel stops a file mid-way, deletes the whole copy, and the upload is gone', async () => {
    const f = fixture();
    const { uploadId } = f.uploads.begin();
    await f.uploads.receive(uploadId, 'Export/one.json', bytesOf('1'));
    const live = liveBody();
    const receiving = f.uploads.receive(uploadId, 'Export/two.json', live.body);
    live.send('half');
    await until(() => f.uploads.status(uploadId).state === 'receiving');
    expect(f.uploads.cancel(uploadId)).toBe(true);
    expect(await code(receiving)).toBe('cancelled');
    expect(existsSync(join(f.root, uploadId))).toBe(false);
    expect(await code(f.uploads.receive(uploadId, 'Export/three.json', bytesOf('3')))).toBe('unknown_upload');
  });

  test('a cancel is refused its deletion while an import still reads the copy, and the copy then stays', async () => {
    const f = fixture();
    const { uploadId } = f.uploads.begin();
    await f.uploads.receive(uploadId, 'a.mbox', bytesOf('From x\n'));
    expect(f.uploads.cancel(uploadId, () => true)).toBe(false);
    expect(readFileSync(join(f.root, uploadId, 'files/a.mbox'), 'utf8')).toBe('From x\n');
    // The upload itself is over.
    expect(await code(f.uploads.receive(uploadId, 'b.mbox', bytesOf('x')))).toBe('unknown_upload');
    // Released later, when nothing reads it, it goes.
    f.uploads.release(uploadId, () => false);
    expect(existsSync(join(f.root, uploadId))).toBe(false);
  });

  test('release deletes a copy unless something reads it', async () => {
    const f = fixture();
    const a = f.uploads.begin().uploadId;
    await f.uploads.receive(a, 'a.txt', bytesOf('a'));
    f.uploads.release(a, () => true);
    expect(existsSync(join(f.root, a))).toBe(true);
    f.uploads.release(a, () => false);
    expect(existsSync(join(f.root, a))).toBe(false);
  });

  test('an upload handed to an import stops being in progress at once: the sweep then removes its copy as soon as nothing reads it', async () => {
    const f = fixture();
    const { uploadId } = f.uploads.begin();
    await f.uploads.receive(uploadId, 'a.mbox', bytesOf('From x\n'));
    f.uploads.handOver(uploadId);
    f.uploads.sweep(() => true);
    expect(existsSync(join(f.root, uploadId))).toBe(true);
    // Not idle for any length of time: it was in use a moment ago, and the import has finished with it.
    f.uploads.sweep(() => false);
    expect(existsSync(join(f.root, uploadId))).toBe(false);
  });

  test('the sweep deletes what nobody reads and keeps what an import reads, what is arriving, and what was touched lately', async () => {
    let clock = 1_000_000;
    const f = fixture({ now: () => clock });
    const abandoned = f.uploads.begin().uploadId;
    await f.uploads.receive(abandoned, 'a.txt', bytesOf('a'));
    const read = f.uploads.begin().uploadId;
    await f.uploads.receive(read, 'b.txt', bytesOf('b'));
    const arriving = f.uploads.begin().uploadId;
    const live = liveBody();
    const receiving = f.uploads.receive(arriving, 'c.txt', live.body);
    await until(() => f.uploads.status(arriving).state === 'receiving');
    const recent = f.uploads.begin().uploadId;
    await f.uploads.receive(recent, 'd.txt', bytesOf('d'));

    // Soon after: nobody has been idle long enough to be called abandoned.
    f.uploads.sweep(() => false);
    expect(readdirSync(f.root).sort()).toEqual([abandoned, arriving, read, recent].sort());

    clock += ARCHIVE_UPLOAD_IDLE_MS + 1;
    // Idle past the limit: deleted unless an import reads it. The one still arriving is never swept.
    live.send('c');
    await until(() => f.uploads.status(arriving).bytes === 1);
    f.uploads.sweep((dir) => dir.endsWith(read));
    expect(readdirSync(f.root).sort()).toEqual([arriving, read].sort());
    live.end();
    await receiving;
  });

  test('copies left by an earlier run of the engine are swept too, and a name that is not an upload\'s is left alone', async () => {
    const f = fixture();
    const { uploadId } = f.uploads.begin();
    await f.uploads.receive(uploadId, 'a.txt', bytesOf('a'));
    // A new engine process: nothing remembers the upload.
    const again = createArchiveUploads({ root: f.root });
    cleanups.push(() => again.close());
    const foreign = join(f.root, 'not-an-upload');
    writeFileSync(foreign, 'mine');
    again.sweep(() => false);
    expect(existsSync(join(f.root, uploadId))).toBe(false);
    expect(readFileSync(foreign, 'utf8')).toBe('mine');
  });

  test('closing the engine stops the uploads in flight', async () => {
    const f = fixture();
    const { uploadId } = f.uploads.begin();
    const live = liveBody();
    const receiving = f.uploads.receive(uploadId, 'a.bin', live.body);
    live.send('x');
    await until(() => f.uploads.status(uploadId).bytes === 1);
    f.uploads.close();
    expect(await code(receiving)).toBe('cancelled');
    expect(() => f.uploads.begin()).toThrow(ArchiveUploadError);
  });
});

function statSyncReal(path: string): string {
  return realpathSync.native(path);
}

// Keeps the type used: the uploads API is what the dashboard hands the route.
export type { ArchiveUploads };
