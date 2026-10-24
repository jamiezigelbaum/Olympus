import { describe, expect, test } from 'bun:test';
import { ContinuationCache, type ContinuationKey } from '../src/workers/archive-import/continuation-cache.ts';
import { ZipArchive, ZipMemberReader, type ZipContinuation } from '../src/workers/archive-import/zip-reader.ts';
import { buildZip, memoryRangeReader } from './helpers/zip-fixture.ts';

const key = (overrides: Partial<ContinuationKey> = {}): ContinuationKey => ({
  archiveId: 'archive-a',
  manifestTag: 'tag-1',
  fileIndex: 0,
  memberIndex: 3,
  ...overrides,
});

function parked(position: number, retainedBytes = 1000): ZipContinuation {
  return { position, retainedBytes };
}

describe('continuation cache', () => {
  test('gives an inflater back only at the offset it stopped at, and only once', () => {
    const cache = new ContinuationCache();
    const one = parked(500);
    cache.put(key(), one);
    expect(cache.size).toBe(1);
    expect(cache.take(key(), 500)).toBe(one);
    expect(cache.size).toBe(0);
    expect(cache.take(key(), 500)).toBeUndefined();
    // Asked for at another offset, it is stale: not given, and not kept either.
    cache.put(key(), one);
    expect(cache.take(key(), 501)).toBeUndefined();
    expect(cache.size).toBe(0);
  });

  test('a different archive, manifest, file or member never gets it', () => {
    const cache = new ContinuationCache();
    cache.put(key(), parked(10));
    for (const other of [key({ archiveId: 'b' }), key({ manifestTag: 'tag-2' }), key({ fileIndex: 1 }), key({ memberIndex: 4 })]) {
      expect(cache.take(other, 10)).toBeUndefined();
    }
    expect(cache.size).toBe(1);
    expect(cache.take(key(), 10)?.position).toBe(10);
  });

  test('parking again for the same member replaces what was there', () => {
    const cache = new ContinuationCache();
    cache.put(key(), parked(10));
    cache.put(key(), parked(20));
    expect(cache.size).toBe(1);
    expect(cache.take(key(), 10)).toBeUndefined();
  });

  test('holds a few members and a fixed number of bytes, dropping the least recent', () => {
    const cache = new ContinuationCache({ maxEntries: 3, maxBytes: 5000 });
    for (let member = 0; member < 5; member += 1) cache.put(key({ memberIndex: member }), parked(member, 1000));
    expect(cache.size).toBe(3);
    expect(cache.take(key({ memberIndex: 0 }), 0)).toBeUndefined();
    expect(cache.take(key({ memberIndex: 4 }), 4)).toBeDefined();
    const bytes = new ContinuationCache({ maxEntries: 10, maxBytes: 3000 });
    bytes.put(key({ memberIndex: 0 }), parked(0, 2000));
    bytes.put(key({ memberIndex: 1 }), parked(1, 2000));
    expect(bytes.size).toBe(1);
    expect(bytes.retainedBytes).toBe(2000);
    expect(bytes.take(key({ memberIndex: 1 }), 1)).toBeDefined();
    // One alone beyond the limit is not kept at all.
    bytes.put(key({ memberIndex: 2 }), parked(2, 4000));
    expect(bytes.size).toBe(0);
  });

  test('an inflater idle for too long is let go', () => {
    let now = 1_000;
    const cache = new ContinuationCache({ maxIdleMs: 500, now: () => now });
    cache.put(key({ memberIndex: 0 }), parked(0));
    now += 400;
    cache.put(key({ memberIndex: 1 }), parked(1));
    now += 200;
    expect(cache.take(key({ memberIndex: 0 }), 0)).toBeUndefined();
    expect(cache.take(key({ memberIndex: 1 }), 1)).toBeDefined();
  });

  test('removing an archive drops everything parked for it and nothing else', () => {
    const cache = new ContinuationCache();
    cache.put(key({ archiveId: 'a', memberIndex: 0 }), parked(0));
    cache.put(key({ archiveId: 'a', memberIndex: 1 }), parked(1));
    cache.put(key({ archiveId: 'b', memberIndex: 0 }), parked(0));
    cache.dropArchive('a');
    expect(cache.size).toBe(1);
    expect(cache.take(key({ archiveId: 'b', memberIndex: 0 }), 0)).toBeDefined();
    cache.put(key(), parked(1));
    cache.clear();
    expect(cache.size).toBe(0);
  });
});

describe('continuation cache with a real member', () => {
  function readInPasses(useCache: boolean): { bytes: Uint8Array; passes: number; restarted: number; data: Uint8Array } {
    const data = new Uint8Array(700_000);
    let state = 5;
    for (let index = 0; index < data.length; index += 1) {
      state = (state * 1103515245 + 12345) & 0x7fffffff;
      data[index] = index % 3 === 0 ? state >>> 16 : 0x40 + (index % 13);
    }
    const reads: Array<{ offset: number; length: number }> = [];
    const archive = ZipArchive.open(memoryRangeReader(buildZip([{ name: 'm.bin', data, method: 'deflate' }]), { reads }));
    const entry = [...archive.entries()][0]!;
    const dataStart = archive.dataStart(entry);
    const cache = new ContinuationCache();
    const where = key({ memberIndex: entry.index });
    const out: number[] = [];
    let offset = 0;
    let passes = 0;
    let restarted = 0;
    while (offset < data.length) {
      passes += 1;
      const continuation = useCache && offset > 0 ? cache.take(where, offset) : undefined;
      reads.length = 0;
      const member = ZipMemberReader.open(archive, entry, { start: offset, ...(continuation ? { continuation } : {}) });
      let got = 0;
      for (let chunk = member.next(); chunk; chunk = member.next()) {
        for (const byte of chunk) out.push(byte);
        got += chunk.length;
        if (got >= 150_000) break;
      }
      // A pass after the first that reads the member's compressed bytes from their first block inflated it again from its start.
      if (passes > 1 && reads.some((read) => read.offset === dataStart)) restarted += 1;
      offset = member.position;
      const parkedNow = offset < data.length ? member.suspend() : undefined;
      if (parkedNow && useCache) cache.put(where, parkedNow);
      member.close();
    }
    return { bytes: Uint8Array.from(out), passes, restarted, data };
  }

  test('a pass that stops parks the inflater and the next pass goes on from it', () => {
    const run = readInPasses(true);
    expect(run.passes).toBeGreaterThan(3);
    expect(Buffer.from(run.bytes).equals(run.data)).toBe(true);
    expect(run.restarted).toBe(0);
  });

  test('without the cache every later pass inflates the member again from its start (the check can fail)', () => {
    const run = readInPasses(false);
    expect(Buffer.from(run.bytes).equals(run.data)).toBe(true);
    expect(run.restarted).toBe(run.passes - 1);
  });
});
