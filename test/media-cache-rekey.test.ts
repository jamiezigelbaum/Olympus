// The media cache's holders when a store moves (docs/design/source-storage.md,
// "Migration of existing installs"). A cache file is kept while some store
// holds it; a holder is named by its store's real path, so a store that moves
// looks gone and the sweep would drop its pictures. `rekeyMediaCacheHolder`
// hands the markers to the new path. Expected results come from the cache's
// rules (a file with a holder is kept, a file with none past its age goes), not
// from the code under test.

import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, renameSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  MediaCacheRekeyStopped,
  addMediaCacheHolder,
  dropMediaCacheHolder,
  mediaHolderDigests,
  nearRealPath,
  rekeyMediaCacheHolder,
  retainMediaCacheFile,
  sweepMediaCache,
  writeMediaCacheFile,
  releaseMediaCacheFile,
} from '../src/core/media-cache.ts';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function workspace(): { dir: string; cache: string } {
  const dir = mkdtempSync(join(tmpdir(), 'olympus-media-rekey-'));
  roots.push(dir);
  const cache = join(dir, 'media-cache');
  mkdirSync(cache, { recursive: true });
  return { dir, cache };
}

/** A store file, and a cache picture it holds. */
function holding(cache: string, store: string, bytes: string): { path: string; sha256: string } {
  mkdirSync(join(store, '..'), { recursive: true });
  writeFileSync(store, 'database');
  const file = writeMediaCacheFile(cache, new TextEncoder().encode(bytes), 'image/jpeg');
  expect(retainMediaCacheFile(file.path, file.sha256, store, cache)).toBe(true);
  releaseStaging(file);
  return { path: file.path, sha256: file.sha256 };
}

function releaseStaging(file: { path: string; sha256: string; stagingHolder: string }): void {
  releaseMediaCacheFile(file.path, file.sha256, file.stagingHolder, undefined);
}

const FAR_FUTURE = { maxAgeMs: 0, now: Date.now() + 10 * 24 * 60 * 60_000 };
const markers = (cache: string, picture: { path: string }): string[] => readdirSync(`${picture.path}.refs`).sort();

describe('a store that moves keeps its pictures', () => {
  test('without the hand-over the sweep drops them (the control), with it they stay', () => {
    const { dir, cache } = workspace();
    const oldStore = join(dir, 'legacy', 'a.sqlite');
    const newStore = join(dir, 'sources', 'x', '1', 'stores', 'a.sqlite');
    const control = holding(cache, oldStore, 'control picture');
    const kept = holding(cache, join(dir, 'legacy', 'b.sqlite'), 'kept picture');
    const digests = mediaHolderDigests(oldStore);
    mkdirSync(join(newStore, '..'), { recursive: true });
    renameSync(oldStore, newStore);
    const keptNew = join(dir, 'sources', 'y', '1', 'stores', 'b.sqlite');
    const digestsB = mediaHolderDigests(join(dir, 'legacy', 'b.sqlite'));
    mkdirSync(join(keptNew, '..'), { recursive: true });
    renameSync(join(dir, 'legacy', 'b.sqlite'), keptNew);

    expect(rekeyMediaCacheHolder(cache, digestsB, keptNew)).toBe(1);
    expect(sweepMediaCache(cache, FAR_FUTURE)).toBe(1);

    expect(existsSync(control.path), 'the picture of the store that was not handed over').toBe(false);
    expect(existsSync(kept.path), 'the picture of the store that was').toBe(true);
    // The hand-over is useful only if it was needed: the control's digests were never used.
    expect(digests.length).toBeGreaterThan(0);
  });

  test('the new marker is written before the old one goes, and nothing else changes', () => {
    const { dir, cache } = workspace();
    const oldStore = join(dir, 'legacy', 'a.sqlite');
    const picture = holding(cache, oldStore, 'one picture');
    const other = holding(cache, join(dir, 'legacy', 'other.sqlite'), 'another store holds this');
    const digests = mediaHolderDigests(oldStore);
    const before = markers(cache, picture);
    expect(before).toHaveLength(1);
    const otherBefore = markers(cache, other);
    const newStore = join(dir, 'sources', 'x', '1', 'stores', 'a.sqlite');
    mkdirSync(join(newStore, '..'), { recursive: true });
    renameSync(oldStore, newStore);

    expect(rekeyMediaCacheHolder(cache, digests, newStore)).toBe(1);

    const after = markers(cache, picture);
    expect(after).toHaveLength(1);
    expect(after).not.toEqual(before);
    expect(markers(cache, other)).toEqual(otherBefore);
    // Handed over again: nothing left to hand, nothing changed.
    expect(rekeyMediaCacheHolder(cache, digests, newStore)).toBe(0);
    expect(markers(cache, picture)).toEqual(after);
  });

  test('a picture two stores hold stays held by the other when one moves', () => {
    const { dir, cache } = workspace();
    const first = join(dir, 'legacy', 'a.sqlite');
    const second = join(dir, 'legacy', 'b.sqlite');
    const picture = holding(cache, first, 'shared picture');
    writeFileSync(second, 'database');
    expect(retainMediaCacheFile(picture.path, picture.sha256, second, cache)).toBe(true);
    expect(markers(cache, picture)).toHaveLength(2);
    const digests = mediaHolderDigests(first);
    const moved = join(dir, 'sources', 'x', '1', 'stores', 'a.sqlite');
    mkdirSync(join(moved, '..'), { recursive: true });
    renameSync(first, moved);

    rekeyMediaCacheHolder(cache, digests, moved);
    expect(markers(cache, picture)).toHaveLength(2);
    // The second store's own release now leaves the first's hold.
    expect(releaseMediaCacheFile(picture.path, picture.sha256, second, cache)).toBe(false);
    expect(existsSync(picture.path)).toBe(true);
    expect(releaseMediaCacheFile(picture.path, picture.sha256, moved, cache)).toBe(true);
  });

  test('moving back is the same hand-over the other way', () => {
    const { dir, cache } = workspace();
    const oldStore = join(dir, 'legacy', 'a.sqlite');
    const picture = holding(cache, oldStore, 'round trip');
    const original = markers(cache, picture);
    const newStore = join(dir, 'sources', 'x', '1', 'stores', 'a.sqlite');
    mkdirSync(join(newStore, '..'), { recursive: true });
    const there = mediaHolderDigests(oldStore);
    renameSync(oldStore, newStore);
    rekeyMediaCacheHolder(cache, there, newStore);
    const back = mediaHolderDigests(newStore);
    renameSync(newStore, oldStore);

    rekeyMediaCacheHolder(cache, back, oldStore);

    expect(markers(cache, picture)).toEqual(original);
    expect(sweepMediaCache(cache, FAR_FUTURE)).toBe(0);
    expect(existsSync(picture.path)).toBe(true);
  });

  test('a hand-over that stopped half way (the new marker written, the old one not yet removed) is finished by the next one', () => {
    const { dir, cache } = workspace();
    const oldStore = join(dir, 'legacy', 'a.sqlite');
    const picture = holding(cache, oldStore, 'half way');
    const digests = mediaHolderDigests(oldStore);
    const newStore = join(dir, 'sources', 'x', '1', 'stores', 'a.sqlite');
    mkdirSync(join(newStore, '..'), { recursive: true });
    renameSync(oldStore, newStore);
    // What a hand-over leaves when it is killed between its two steps: both markers.
    const oldMarkers = markers(cache, picture);
    rekeyMediaCacheHolder(cache, digests, newStore);
    const newMarkers = markers(cache, picture);
    for (const name of oldMarkers) writeFileSync(join(`${picture.path}.refs`, name), join(dir, 'legacy', 'a.sqlite'));
    expect(markers(cache, picture).length).toBeGreaterThan(newMarkers.length - 1);

    // The sweep between the two would have kept the picture (the new marker is there).
    expect(sweepMediaCache(cache, FAR_FUTURE)).toBe(0);
    expect(existsSync(picture.path)).toBe(true);
    rekeyMediaCacheHolder(cache, digests, newStore);

    expect(markers(cache, picture)).toEqual(newMarkers);
    expect(sweepMediaCache(cache, FAR_FUTURE)).toBe(0);
    expect(existsSync(picture.path)).toBe(true);
  });

  test('the name is the same before the folders exist and after: a link above the path does not change it', () => {
    const { dir } = workspace();
    const real = join(dir, 'real');
    mkdirSync(real);
    const link = join(dir, 'link');
    symlinkSync(real, link);
    const future = join(link, 'sources', 'x', '1', 'stores', 'a.sqlite');

    const before = mediaHolderDigests(future);
    expect(nearRealPath(future)).toBe(join(real, 'sources', 'x', '1', 'stores', 'a.sqlite'));
    mkdirSync(join(future, '..'), { recursive: true });
    writeFileSync(future, 'database');

    expect(mediaHolderDigests(future)).toEqual(before);
    // And the path as spelled has a digest of its own, which the first build of picture search used.
    expect(before).toHaveLength(2);
  });

  test('a cache that is not there, or has no markers, hands over nothing and throws nothing', () => {
    const { dir, cache } = workspace();
    expect(rekeyMediaCacheHolder(join(dir, 'no-cache'), ['0'.repeat(32)], join(dir, 'a.sqlite'))).toBe(0);
    expect(rekeyMediaCacheHolder(cache, ['0'.repeat(32)], join(dir, 'a.sqlite'))).toBe(0);
  });
});

describe('the hand-over in two halves, either side of the move', () => {
  function moved(dir: string, cache: string, name: string, count: number): { oldStore: string; newStore: string; pictures: Array<{ path: string; sha256: string }>; digests: string[] } {
    const oldStore = join(dir, 'legacy', `${name}.sqlite`);
    const newStore = join(dir, 'sources', name, '1', 'stores', 'a.sqlite');
    const pictures = Array.from({ length: count }, (_, index) => holding(cache, index === 0 ? oldStore : join(dir, 'scratch', `${name}-${index}.sqlite`), `${name} picture ${index}`));
    // The holders of one store: every picture gets the old store's marker as well.
    for (const picture of pictures.slice(1)) {
      expect(retainMediaCacheFile(picture.path, picture.sha256, oldStore, cache)).toBe(true);
    }
    return { oldStore, newStore, pictures, digests: mediaHolderDigests(oldStore) };
  }

  test('each new marker is on disk (file, then its folder) while the old one is still there', () => {
    const { dir, cache } = workspace();
    const { oldStore, newStore, pictures, digests } = moved(dir, cache, 'a', 3);
    mkdirSync(join(newStore, '..'), { recursive: true });
    const synced: string[] = [];
    const oldStillThere: boolean[] = [];

    expect(addMediaCacheHolder(cache, digests, newStore, {
      sync: (path) => {
        synced.push(path);
        for (const picture of pictures) oldStillThere.push(digests.some((digest) => existsSync(join(`${picture.path}.refs`, digest))));
      },
    })).toBe(3);

    // For every picture: its new marker, then the folder that names it.
    expect(synced.filter((path) => path.endsWith('.refs'))).toHaveLength(3);
    expect(synced.filter((path) => !path.endsWith('.refs'))).toHaveLength(3);
    for (const picture of pictures) {
      const marker = synced.findIndex((path) => path.startsWith(`${picture.path}.refs/`));
      expect(marker, picture.path).toBeGreaterThanOrEqual(0);
      expect(synced[marker + 1], picture.path).toBe(`${picture.path}.refs`);
    }
    expect(oldStillThere.every(Boolean)).toBe(true);
    // The store has not moved yet in this test, and nothing is dropped by the sweep either way.
    expect(sweepMediaCache(cache, FAR_FUTURE)).toBe(0);
    expect(oldStore).toBeTruthy();
  });

  test('the old markers go only in the second half, and only where the new one is', () => {
    const { dir, cache } = workspace();
    const { newStore, pictures, digests } = moved(dir, cache, 'a', 2);
    mkdirSync(join(newStore, '..'), { recursive: true });
    // Nothing added yet: nothing is dropped.
    expect(dropMediaCacheHolder(cache, digests, newStore)).toBe(0);
    for (const picture of pictures) expect(markers(cache, picture).length).toBeGreaterThan(0);

    addMediaCacheHolder(cache, digests, newStore);
    const both = pictures.map((picture) => markers(cache, picture).length);
    expect(both.every((count) => count >= 2)).toBe(true);

    expect(dropMediaCacheHolder(cache, digests, newStore)).toBeGreaterThanOrEqual(2);
    for (const picture of pictures) {
      for (const digest of digests) expect(existsSync(join(`${picture.path}.refs`, digest)), picture.path).toBe(false);
    }
  });

  test('a hand-over that is told to stop throws, keeps every old marker, and the next call goes on from where it stopped', () => {
    const { dir, cache } = workspace();
    const { oldStore, newStore, pictures, digests } = moved(dir, cache, 'a', 130);
    mkdirSync(join(newStore, '..'), { recursive: true });
    let asked = 0;

    let stopped: unknown;
    try {
      addMediaCacheHolder(cache, digests, newStore, { stop: () => (asked += 1) > 1 });
    } catch (error) {
      stopped = error;
    }

    expect(stopped).toBeInstanceOf(MediaCacheRekeyStopped);
    expect((stopped as MediaCacheRekeyStopped).handed).toBeGreaterThan(0);
    expect((stopped as MediaCacheRekeyStopped).handed).toBeLessThan(130);
    // Nothing lost: the old marker is on every picture, whether or not the new one is yet.
    for (const picture of pictures) expect(digests.some((digest) => existsSync(join(`${picture.path}.refs`, digest))), picture.path).toBe(true);

    expect(addMediaCacheHolder(cache, digests, newStore)).toBe(130);
    renameSync(oldStore, newStore);
    expect(dropMediaCacheHolder(cache, digests, newStore)).toBeGreaterThanOrEqual(130);
    expect(sweepMediaCache(cache, FAR_FUTURE)).toBe(0);
    for (const picture of pictures) expect(existsSync(picture.path), picture.path).toBe(true);
  });

  test('a drop that is told to stop throws and leaves the rest as it was; the next call finishes', () => {
    const { dir, cache } = workspace();
    const { oldStore, newStore, pictures, digests } = moved(dir, cache, 'a', 130);
    mkdirSync(join(newStore, '..'), { recursive: true });
    addMediaCacheHolder(cache, digests, newStore);
    renameSync(oldStore, newStore);
    let asked = 0;

    expect(() => dropMediaCacheHolder(cache, digests, newStore, { stop: () => (asked += 1) > 1 })).toThrow(MediaCacheRekeyStopped);

    // Every picture is still held: the new marker everywhere, the old one where the drop had not got to.
    for (const picture of pictures) expect(markers(cache, picture).length, picture.path).toBeGreaterThan(0);
    expect(dropMediaCacheHolder(cache, digests, newStore)).toBeGreaterThan(0);
    expect(sweepMediaCache(cache, FAR_FUTURE)).toBe(0);
  });

  test('a cache too big for one run is finished by the next: pictures already covered are passed over, not written again', () => {
    const { dir, cache } = workspace();
    const { newStore, digests } = moved(dir, cache, 'a', 130);
    mkdirSync(join(newStore, '..'), { recursive: true });
    const syncs: number[] = [0, 0];
    let round = 0;
    const sync = (): void => { syncs[round] = syncs[round]! + 1; };
    let asked = 0;

    expect(() => addMediaCacheHolder(cache, digests, newStore, { sync, stagedBy: dirname(newStore), stop: () => (asked += 1) > 1 })).toThrow(MediaCacheRekeyStopped);
    round = 1;
    expect(addMediaCacheHolder(cache, digests, newStore, { sync, stagedBy: dirname(newStore) })).toBe(130);

    // A staging marker, a marker and the folder, once for each picture across both runs: nothing was written twice.
    expect(syncs[0]).toBeGreaterThan(0);
    expect(syncs[0]! + syncs[1]!).toBe(130 * 3);
  });
});

describe('a sweep by another process in the middle of a move', () => {
  /** The store moves between two names: the sweeps the other process runs are where the pictures are lost or kept. */
  function throughAMove(staged: boolean): { picture: { path: string; sha256: string }; oldStore: string; newStore: string; digests: string[]; cache: string } {
    const { dir, cache } = workspace();
    const oldStore = join(dir, 'legacy', 'a.sqlite');
    const newStore = join(dir, 'sources', 'x', '1', 'stores', 'a.sqlite');
    const picture = holding(cache, oldStore, `a picture ${staged}`);
    // A picture of days ago, as the sweeps the cache really runs see it: unheld, it goes; a fresh staging marker keeps it.
    const longAgo = new Date(Date.now() - 3 * 24 * 60 * 60_000);
    utimesSync(picture.path, longAgo, longAgo);
    const digests = mediaHolderDigests(oldStore);
    addMediaCacheHolder(cache, digests, newStore, staged ? { stagedBy: oldStore } : {});
    // The folders are made, the store is not in them yet: its new name is the name of a store that is not there.
    mkdirSync(dirname(newStore), { recursive: true });
    sweepMediaCache(cache);
    renameSync(oldStore, newStore);
    // And now the old name is.
    sweepMediaCache(cache);
    return { picture, oldStore, newStore, digests, cache };
  }

  test('without a staging marker the picture is lost (the control)', () => {
    const { picture } = throughAMove(false);
    expect(existsSync(picture.path)).toBe(false);
  });

  test('with it the picture is kept through both sweeps, and the second half makes the new marker sure and leaves nothing behind', () => {
    const { picture, oldStore, newStore, digests, cache } = throughAMove(true);
    expect(existsSync(picture.path)).toBe(true);

    dropMediaCacheHolder(cache, digests, newStore, { stagedBy: oldStore });

    const left = markers(cache, picture);
    expect(left).toHaveLength(1);
    expect(left).not.toContain(digests[0]);
    expect(sweepMediaCache(cache)).toBe(0);
    expect(existsSync(picture.path)).toBe(true);
    // Held by the store where it is: the store's own release is the last hold.
    expect(releaseMediaCacheFile(picture.path, picture.sha256, newStore, cache)).toBe(true);
  });

  test('the second half touches nothing while the store is not at its new path', () => {
    const { dir, cache } = workspace();
    const oldStore = join(dir, 'legacy', 'a.sqlite');
    const newStore = join(dir, 'sources', 'x', '1', 'stores', 'a.sqlite');
    const picture = holding(cache, oldStore, 'not there yet');
    const digests = mediaHolderDigests(oldStore);
    addMediaCacheHolder(cache, digests, newStore, { stagedBy: oldStore });
    const before = markers(cache, picture);

    expect(dropMediaCacheHolder(cache, digests, newStore, { stagedBy: oldStore })).toBe(0);

    expect(markers(cache, picture)).toEqual(before);
  });

  test('each picture\'s staging marker, new marker and folder are made durable in that order', () => {
    const { dir, cache } = workspace();
    const oldStore = join(dir, 'legacy', 'a.sqlite');
    const newStore = join(dir, 'sources', 'x', '1', 'stores', 'a.sqlite');
    const picture = holding(cache, oldStore, 'one picture');
    const synced: string[] = [];

    addMediaCacheHolder(cache, mediaHolderDigests(oldStore), newStore, { stagedBy: oldStore, sync: (path) => { synced.push(path); } });

    expect(synced).toHaveLength(3);
    expect(synced[0]!.startsWith(`${picture.path}.refs/staging-`)).toBe(true);
    expect(synced[1]!.startsWith(`${picture.path}.refs/`) && !synced[1]!.includes('staging-')).toBe(true);
    expect(synced[2]).toBe(`${picture.path}.refs`);
  });
});
