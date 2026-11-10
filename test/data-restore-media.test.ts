// A backup carries the prepared pictures its stores' chunks point at, and a
// restore on another computer puts them in that install's media cache and
// points the chunks there (PR #1149 review): before, the rows came back
// naming the old computer's cache, and every reader skipped the picture.
import { Database } from 'bun:sqlite';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'bun:test';
import type { RawItem, SourceConnector, SourceConnectorListPage } from '../src/core/contracts.ts';
import { mediaCacheDir, releaseMediaCacheFile, writeMediaCacheFile } from '../src/core/media-cache.ts';
import { buildSourceSensitivity } from '../src/core/source-index/types.ts';
import { exportOlympusData, lifecycleEnv } from '../src/data-lifecycle.ts';
import { restoreOlympusData } from '../src/data-restore.ts';
import { LocalConnectorStore } from '../src/workers/connector-store/index.ts';
import { IMAGE_MEDIA_DESCRIPTOR } from '../src/workers/file-extraction/extractors/text.ts';
import { createConnectorStoreExtractionSink } from '../src/workers/file-extraction/store-sink.ts';
import type { ExtractionSinkRequest } from '../src/workers/file-extraction/types.ts';
import {
  DeterministicSourceEmbeddingProvider,
  type SourceEmbeddingImageInput,
} from '../src/workers/source-index/embeddings.ts';
import { MEDIA_JUDGE_PROMPT_PREFIX, MEDIA_JUDGE_PROMPTS, type MediaJudgeCategory } from '../src/workers/source-index/media-judge.ts';
import { lifecycleViews } from './helpers/lifecycle-view.ts';

const storeOf = (homeDir: string) => lifecycleViews().find((entry) => entry.sourceId === 'x.bookmarks')!.connectorStorePaths!({ homeDir })[0]!;
const cacheOf = (homeDir: string) => mediaCacheDir(lifecycleEnv({ homeDir }));
const CORPUS = 'secure_local.restore.files';
const CATEGORIES = Object.keys(MEDIA_JUDGE_PROMPTS) as MediaJudgeCategory[];
const DIMENSION = 8;

function photoItem(id: string): RawItem {
  return {
    identity: { family: 'file', provider: 'restore', accountScope: 'personal', providerItemId: id, localItemId: `personal:${id}`, sourceVersion: 'v1' },
    mimeType: 'image/jpeg',
    content: { kind: 'metadata_only' },
    metadata: Object.freeze({ name: `${id}.jpg`, title: `${id}.jpg`, pathDisplay: `/Photos/${id}.jpg` }),
    fetchedAt: '2026-11-10T00:00:00.000Z',
  };
}

function connectorFor(ids: readonly string[]): SourceConnector {
  return {
    id: 'restore_lane',
    family: 'file',
    async authenticate() {},
    listItems(): AsyncIterable<SourceConnectorListPage> {
      const items = ids.map(photoItem);
      return (async function* () {
        yield { items, done: true };
      })();
    },
    async fetchItem(localItemId) {
      return photoItem(localItemId.replace('personal:', ''));
    },
    classificationSignals: (item) => ({ title: String(item.metadata['name']), path: String(item.metadata['pathDisplay']) }),
  };
}

function request(id: string, media: { path: string; sha256: string }): ExtractionSinkRequest {
  return {
    ref: {
      corpusId: CORPUS,
      provider: 'restore',
      accountScope: 'personal',
      approvedScopeKey: 'restore.personal:/',
      providerItemId: id,
      localItemId: `personal:${id}`,
      sourceVersion: 'v1',
      name: `${id}.jpg`,
      mimeType: 'image/jpeg',
    },
    text: IMAGE_MEDIA_DESCRIPTOR,
    extractorKind: 'local_text',
    extractorVersion: 'test',
    fetchedAt: '2026-11-10T01:00:00.000Z',
    media: { path: media.path, sha256: media.sha256, mimeType: 'image/jpeg' },
  };
}

/** Reads pictures but cannot judge them: the photo is embedded and left unjudged. */
class PictureOnlyProvider extends DeterministicSourceEmbeddingProvider {
  constructor() {
    super({ dimension: DIMENSION });
  }

  async imageSupport(): Promise<boolean> {
    return true;
  }
}

/** Judges pictures, recording each one it is handed to read on its own. */
class JudgingProvider extends DeterministicSourceEmbeddingProvider {
  readonly judged: SourceEmbeddingImageInput[] = [];

  constructor() {
    super({ dimension: DIMENSION });
  }

  async imageSupport(): Promise<boolean> {
    return true;
  }

  async embedImageVectors(images: SourceEmbeddingImageInput[]): Promise<Array<number[] | undefined>> {
    this.judged.push(...images);
    // Ordinary: its score leads every sensitive category's by a wide margin.
    return images.map(() => CATEGORIES.map((category) => (category === 'ordinary' ? 0.9 : 0.1)));
  }

  async embedPromptTexts(texts: string[]): Promise<number[][]> {
    return texts.map((text) => {
      const index = CATEGORIES.findIndex((category) => text === `${MEDIA_JUDGE_PROMPT_PREFIX}${MEDIA_JUDGE_PROMPTS[category]}`);
      if (index < 0) throw new Error(`unexpected prompt ${text}`);
      return Array.from({ length: DIMENSION }, (_, position) => (position === index ? 1 : 0));
    });
  }
}

function chunkMedia(dbPath: string): Array<{ media_path: string | null; media_sha256: string | null }> {
  const db = new Database(dbPath, { readonly: true });
  try {
    return db.query('SELECT media_path, media_sha256 FROM chunks WHERE media_sha256 IS NOT NULL ORDER BY chunk_pk').all() as Array<{ media_path: string | null; media_sha256: string | null }>;
  } finally {
    db.close();
  }
}

describe('data restore of pictures', () => {
  test('a picture travels with its store and is read from the new install\'s cache; a missing one is counted', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'olympus-restore-media-'));
    const homeA = join(dir, 'a');
    const homeB = join(dir, 'b');
    const backup = join(dir, 'backup');
    try {
      const storeA = storeOf(homeA);
      const store = new LocalConnectorStore({ dbPath: storeA, corpusId: CORPUS, family: 'file', trustDomain: 'secure_local' });
      const kept = writeMediaCacheFile(cacheOf(homeA), new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]), 'image/jpeg');
      const lost = writeMediaCacheFile(cacheOf(homeA), new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 5, 6, 7, 8]), 'image/jpeg');
      try {
        await store.syncFromConnector(connectorFor(['kept', 'lost']), { fetchContent: false });
        const sink = createConnectorStoreExtractionSink({
          store,
          classify: () => buildSourceSensitivity({ trustTier: 'S4', trustDomain: 'secure_local' }),
          syncConnectorId: 'extraction',
          ownerConnectorId: 'restore-connector',
          ownershipKind: 'observed',
        });
        expect((await sink.accept(request('kept', kept))).accepted).toBe(true);
        expect((await sink.accept(request('lost', lost))).accepted).toBe(true);
        for (const media of [kept, lost]) releaseMediaCacheFile(media.path, media.sha256, media.stagingHolder);
        // Embedded before the judge existed, so the new install judges it.
        await store.embedChunks({ provider: new PictureOnlyProvider() });
      } finally {
        store.close();
      }
      // One picture is gone from this computer by the time of the backup.
      rmSync(lost.path);

      const exported = exportOlympusData({ destination: backup, homeDir: homeA });
      expect(exported.media).toEqual({ exported: 1, missing: 1 });
      const carried = exported.artifacts.filter((artifact) => artifact.role === 'media');
      expect(carried.map((artifact) => artifact.relativePath)).toEqual([`media/${kept.sha256}.jpg`]);
      expect(JSON.parse(readFileSync(join(backup, 'manifest.json'), 'utf8')).media).toEqual({ exported: 1, missing: 1 });

      restoreOlympusData({ input: backup, homeDir: homeB });
      const storeB = storeOf(homeB);
      const pictureB = join(cacheOf(homeB), `${kept.sha256}.jpg`);
      expect(pictureB).not.toBe(kept.path);
      expect(existsSync(pictureB)).toBe(true);
      expect(readFileSync(pictureB)).toEqual(readFileSync(kept.path));
      const rows = chunkMedia(storeB);
      expect(rows.find((row) => row.media_sha256 === kept.sha256)?.media_path).toBe(pictureB);
      // The missing one keeps the path it had; no reader finds a file there.
      expect(rows.find((row) => row.media_sha256 === lost.sha256)?.media_path).toBe(lost.path);

      // The restored store's reader of unjudged pictures finds the picture at its new path.
      const restored = new LocalConnectorStore({ dbPath: storeB, corpusId: CORPUS, family: 'file', trustDomain: 'secure_local' });
      try {
        const provider = new JudgingProvider();
        await restored.embedChunks({ provider });
        expect(provider.judged.map((image) => image.path)).toEqual([pictureB]);
      } finally {
        restored.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
