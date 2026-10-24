// The media cache's holders when a store moves (docs/design/source-storage.md,
// "Migration of existing installs"). A cache file is kept while some store
// holds it; a holder is named by its store's real path, so a store that moves
// looks gone and the sweep would drop its pictures. `rekeyMediaCacheHolder`
// hands the markers to the new path. Expected results come from the cache's
// rules (a file with a holder is kept, a file with none past its age goes), not
// from the code under test.

import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
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
