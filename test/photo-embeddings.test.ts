/**
 * Photos are searchable by content (docs/design/photo-embeddings.md).
 *
 * Covers, end to end through the shared seams and with no source branch:
 * the ingestion-policy split (still images read, video names-only), the
 * text lane's image preparation (an injected `sips` so this runs on Linux;
 * the real tool is opt-in on macOS), the prepared copy travelling runner ->
 * sink -> store onto the item's chunk, the embedding input hash naming the
 * picture, the embed lane handing the picture to the provider, the media
 * cache's clean-up, the additive schema migration, the Private content
 * default for images, and the coverage statement.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { solidPng } from './helpers/solid-png.ts';
import {
  ACCOUNT as TIER_ACCOUNT,
  FIXTURE_PLACEMENT,
  PROVIDER as TIER_PROVIDER,
  fixtureConnector,
  openTierFixture,
  tempDir,
} from './helpers/tier-fixtures.ts';
import { sweepImageContentToPrivate } from '../src/workers/connector-store/tier-image-content-sweep.ts';
import type { RawItem, SourceConnector, SourceConnectorListPage } from '../src/core/contracts.ts';
import {
  MEDIA_CACHE_DIR_ENV,
  isMediaCachePath,
  mediaCacheDir,
  releaseMediaCacheFile,
  retainMediaCacheFile,
  sweepMediaCache,
  writeMediaCacheFile,
} from '../src/core/media-cache.ts';
import { deleteOlympusData } from '../src/data-lifecycle.ts';
import { defaultDropboxConnectorStoreDbPath } from '../src/workers/dropbox-files/connector-store.ts';
import { DEFAULT_STILL_IMAGE_EXTENSIONS, defaultDropboxIngestionPolicy } from '../src/core/source-ingestion-policy.ts';
import { SOURCE_INGESTION_EXCLUSIONS_PATH_ENV } from '../src/core/source-ingestion-exclusions.ts';
import { buildSourceSensitivity } from '../src/core/source-index/types.ts';
import { classifyContentTier, IMAGE_PRIVATE_DEFAULT_REASON } from '../src/workers/classification/tier-classifier.ts';
import { LocalConnectorStore, connectorStoreCoverageGaps } from '../src/workers/connector-store/index.ts';
import { dropboxCanonicalIngestionMatcher } from '../src/workers/dropbox-files/connector-store.ts';
import { defaultDeferredContentReadinessSql } from '../src/workers/dropbox-files/extraction-readiness.ts';
import { ExtractionCommandError, ExtractionCommandTimeoutError, type ExtractionCommandRunner } from '../src/workers/file-extraction/extractors/command-runner.ts';
import {
  IMAGE_PREPARE_ERROR_FAILED,
  IMAGE_PREPARE_ERROR_TIMEOUT,
  createImagePreparation,
} from '../src/workers/file-extraction/extractors/image-prepare.ts';
import {
  IMAGE_MEDIA_DESCRIPTOR,
  IMAGE_MEDIA_VERSION_SUFFIX,
  createTextExtractor,
} from '../src/workers/file-extraction/extractors/text.ts';
import { LocalFileExtractionJobStore } from '../src/workers/file-extraction/job-store.ts';
import { buildExtractorRegistry, createDefaultExtractorRegistry } from '../src/workers/file-extraction/registry.ts';
import { createFileExtractionRunner } from '../src/workers/file-extraction/runner.ts';
import {
  EXTRACTION_SINK_SKIPPED_IMAGE_PRIVATE_ONLY,
  createConnectorStoreExtractionSink,
} from '../src/workers/file-extraction/store-sink.ts';
import type {
  ExtractionItemRef,
  ExtractionSinkRequest,
  Extractor,
  ExtractorInput,
} from '../src/workers/file-extraction/types.ts';
import {
  DeterministicSourceEmbeddingProvider,
  SourceEmbeddingInputsFailedError,
  type SourceEmbeddingInput,
  type SourceEmbeddingTaskType,
} from '../src/workers/source-index/embeddings.ts';

const temporaryDirs: string[] = [];
function temporaryDir(prefix = 'olympus-photo-'): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  temporaryDirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of temporaryDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

// Stores only trust a picture path inside the configured media cache, so this
// file runs with its own cache (restored afterwards: test files share a process).
const CACHE_BASE = mkdtempSync(join(tmpdir(), 'olympus-photo-cache-'));
let previousCacheEnv: string | undefined;
beforeAll(() => {
  previousCacheEnv = process.env[MEDIA_CACHE_DIR_ENV];
  process.env[MEDIA_CACHE_DIR_ENV] = CACHE_BASE;
});
afterAll(() => {
  if (previousCacheEnv === undefined) delete process.env[MEDIA_CACHE_DIR_ENV];
  else process.env[MEDIA_CACHE_DIR_ENV] = previousCacheEnv;
  rmSync(CACHE_BASE, { recursive: true, force: true });
});
const cache = () => mediaCacheDir({ [MEDIA_CACHE_DIR_ENV]: CACHE_BASE });

const JPEG_MAGIC = [0xff, 0xd8, 0xff, 0xe0];

/** A stand-in for `sips`: writes a "JPEG" whose bytes depend on the input. */
function fakeSips(calls: string[][] = [], behaviour: 'ok' | 'fail' | 'timeout' | 'missing' | 'not-jpeg' | 'thumbnail' = 'ok'): ExtractionCommandRunner {
  return async (request) => {
    calls.push([request.command, ...request.args]);
    if (behaviour === 'missing') throw Object.assign(new Error('spawn sips ENOENT'), { code: 'ENOENT' });
    if (behaviour === 'timeout') throw new ExtractionCommandTimeoutError({ command: request.command, timeoutMs: request.timeoutMs });
    if (behaviour === 'fail') throw new ExtractionCommandError({ command: request.command, exitCode: 13, stdout: '', stderr: '' });
    const input = readFileSync(request.args[request.args.length - 3]!);
    const output = request.args[request.args.length - 1]!;
    // A thumbnail: a start-of-frame segment naming 32 x 32 pixels.
    const thumbnail = Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x00, 0x20, 0x00, 0x20, 0x03]);
    writeFileSync(output, behaviour === 'not-jpeg'
      ? Buffer.from('nope')
      : behaviour === 'thumbnail' ? thumbnail : Buffer.concat([Buffer.from(JPEG_MAGIC), input]));
    return { stdout: '', stderr: '' };
  };
}

/** Original picture bytes, distinct per seed and over the small-file floor. */
function picture(seed: number): Uint8Array {
  return new Uint8Array(2048).fill(seed);
}

function extractorInput(bytes: Uint8Array, mimeType = 'image/heic'): ExtractorInput {
  return {
    ref: {
      corpusId: 'secure_local.fake.files',
      provider: 'fake',
      accountScope: 'personal',
      approvedScopeKey: 'scope',
      providerItemId: 'photo-1',
      localItemId: 'local:photo-1',
      mimeType,
    },
    job: {
      jobId: 'job-1',
      extractorKind: 'local_text',
      extractorVersion: '1',
      policyDecision: 'index_allowed',
      attempts: 1,
      leaseExpiresAt: '2099-01-01T00:00:00.000Z',
    },
    bytes,
    mimeType,
    sizeBytes: bytes.byteLength,
  };
}

describe('the default ingestion policy reads still images where they can be prepared, and keeps video names-only', () => {
  test('photos are admitted for extraction; video and the book shelf stay metadata-only', () => {
    const policy = defaultDropboxIngestionPolicy({ stillImagesRead: true });
    const media = policy.rules.find((rule) => rule.reason === 'media_default_metadata_only')!;
    expect(media.match.mime_type_prefixes).toEqual(['video/']);
    for (const extension of ['jpeg', 'jpg', 'png', 'heic', 'heif', 'webp', 'gif', 'tif', 'tiff', 'bmp']) {
      expect(media.match.extensions).not.toContain(extension);
    }
    const matcher = dropboxCanonicalIngestionMatcher(policy, {
      [SOURCE_INGESTION_EXCLUSIONS_PATH_ENV]: join(temporaryDir(), 'missing-exclusions.json'),
    });
    expect(matcher.evaluateItem({ path: '/Photos/kitchen.jpg', mimeType: 'image/jpeg' }).disposition).toBe('admit');
    expect(matcher.evaluateItem({ path: '/Photos/IMG_0001.HEIC', mimeType: 'image/heic' }).disposition).toBe('admit');
    expect(matcher.evaluateItem({ path: '/Videos/tour.mov', mimeType: 'video/quicktime' }).disposition).toBe('metadata_only');
    expect(matcher.evaluateItem({ path: '/Calibre Library/Author/cover.jpg', mimeType: 'image/jpeg' }).disposition).toBe('metadata_only');
  });

  test('a machine that cannot prepare pictures keeps them names-only, so none is downloaded for nothing', () => {
    const policy = defaultDropboxIngestionPolicy({ stillImagesRead: false });
    const media = policy.rules.find((rule) => rule.reason === 'media_default_metadata_only')!;
    expect(media.match.mime_type_prefixes).toEqual(['image/', 'video/']);
    for (const extension of DEFAULT_STILL_IMAGE_EXTENSIONS) expect(media.match.extensions).toContain(extension);
    const matcher = dropboxCanonicalIngestionMatcher(policy, {
      [SOURCE_INGESTION_EXCLUSIONS_PATH_ENV]: join(temporaryDir(), 'missing-exclusions.json'),
    });
    expect(matcher.evaluateItem({ path: '/Photos/kitchen.jpg', mimeType: 'image/jpeg' }).disposition).toBe('metadata_only');
    // The readiness ladder agrees in both cases.
    expect(defaultDeferredContentReadinessSql(false)).toContain("'image/%'");
    expect(defaultDeferredContentReadinessSql(true)).not.toContain("'image/%'");
    expect(defaultDeferredContentReadinessSql(true)).not.toContain('.jpg');
    expect(defaultDeferredContentReadinessSql(true)).toContain("'video/%'");
  });
});

describe('image preparation in the shared text lane', () => {
  test('a picture becomes an owner-only, content-addressed JPEG in the media cache', async () => {
    const cacheDir = join(temporaryDir(), 'media-cache');
    const calls: string[][] = [];
    const prepare = createImagePreparation({ cacheDir, commandRunner: fakeSips(calls) });
    const result = await prepare({ bytes: picture(1), mimeType: 'image/heic', sizeBytes: 2048 });
    expect(result.kind).toBe('media');
    if (result.kind !== 'media') return;
    expect(calls[0]!.slice(0, 6)).toEqual(['/usr/bin/sips', '-s', 'format', 'jpeg', '-Z', '1024']);
    expect(calls[0]![6]!.endsWith('.heic')).toBe(true);
    expect(result.media.path).toBe(join(cacheDir, `${result.media.sha256}.jpg`));
    expect(statSync(cacheDir).mode & 0o777).toBe(0o700);
    expect(statSync(result.media.path).mode & 0o777).toBe(0o600);
    // The same picture again is the same file.
    const again = await prepare({ bytes: picture(1), mimeType: 'image/heic', sizeBytes: 2048 });
    expect(again.kind === 'media' ? [again.media.path, again.media.sha256] : []).toEqual([result.media.path, result.media.sha256]);
  });

  test('a too-large picture is skipped and a refused one is a normal extraction failure', async () => {
    const cacheDir = join(temporaryDir(), 'media-cache');
    const input = { bytes: picture(2), mimeType: 'image/png', sizeBytes: 2048 };
    expect(await createImagePreparation({ cacheDir, commandRunner: fakeSips(), maxInputBytes: 1000 })(input))
      .toEqual({ kind: 'settled', output: { status: 'skipped_too_large' } });
    expect(await createImagePreparation({ cacheDir, commandRunner: fakeSips([], 'fail') })(input))
      .toEqual({ kind: 'settled', output: { status: 'failed_terminal', errorKind: IMAGE_PREPARE_ERROR_FAILED } });
    expect(await createImagePreparation({ cacheDir, commandRunner: fakeSips([], 'not-jpeg') })(input))
      .toEqual({ kind: 'settled', output: { status: 'failed_terminal', errorKind: IMAGE_PREPARE_ERROR_FAILED } });
    expect(await createImagePreparation({ cacheDir, commandRunner: fakeSips([], 'timeout') })(input))
      .toEqual({ kind: 'settled', output: { status: 'failed_retryable', errorKind: IMAGE_PREPARE_ERROR_TIMEOUT } });
    expect(await createImagePreparation({ cacheDir, commandRunner: fakeSips([], 'missing') })(input))
      .toEqual({ kind: 'unavailable' });
  });

  test('a tiny picture (a logo, a tracking pixel) gets no picture vector', async () => {
    const cacheDir = join(temporaryDir(), 'media-cache');
    expect(await createImagePreparation({ cacheDir, commandRunner: fakeSips() })({ bytes: new Uint8Array(200), mimeType: 'image/png', sizeBytes: 200 }))
      .toEqual({ kind: 'too_small' });
    expect(await createImagePreparation({ cacheDir, commandRunner: fakeSips([], 'thumbnail') })({ bytes: picture(5), mimeType: 'image/png', sizeBytes: 2048 }))
      .toEqual({ kind: 'too_small' });
    // The text lane then treats it as it did before (here: names only).
    const extractor = createTextExtractor({ imagePreparation: createImagePreparation({ cacheDir, commandRunner: fakeSips([], 'thumbnail') }) });
    expect(await extractor.extract(extractorInput(picture(6)))).toEqual({ status: 'metadata_only' });
  });

  test('a picture whose OCR fails leaves nothing in the cache', async () => {
    const cacheDir = join(temporaryDir(), 'media-cache');
    const extractor = createTextExtractor({
      imagePreparation: createImagePreparation({ cacheDir, commandRunner: fakeSips() }),
      imageOcr: async () => ({ status: 'failed_retryable', errorKind: 'ocr_command_failed' }),
    });
    expect(await extractor.extract(extractorInput(picture(7)))).toEqual({ status: 'failed_retryable', errorKind: 'ocr_command_failed' });
    expect(readdirSync(cacheDir).filter((name) => name.endsWith('.jpg'))).toEqual([]);
  });

  test('pictures are queued once more under an image-scoped version; other files keep theirs', () => {
    const plain = createTextExtractor();
    expect(plain.versionFor).toBeUndefined();
    const extractor = createTextExtractor({ imagePreparation: createImagePreparation({ cacheDir: '/unused', commandRunner: fakeSips() }) });
    expect(extractor.versionFor!('image/heic')).toBe(`${extractor.version}${IMAGE_MEDIA_VERSION_SUFFIX}`);
    expect(extractor.versionFor!('application/pdf')).toBe(extractor.version);
  });

  test('the image-scoped version is a key the real job store accepts', () => {
    const extractor = createTextExtractor({ imagePreparation: createImagePreparation({ cacheDir: '/unused', commandRunner: fakeSips() }) });
    const store = new LocalFileExtractionJobStore(join(temporaryDir(), 'jobs.sqlite'));
    const lane = { corpusId: 'secure_local.fixture.files', provider: 'fixture', accountScope: 'personal', approvedScopeKey: 'fixture.personal:/photos' };
    const result = store.enqueue({
      refs: [{ ...lane, providerItemId: 'id:photo-1', localItemId: 'personal:id:photo-1', mimeType: 'image/heic', name: 'photo.heic' }],
      extractorKind: extractor.kind,
      extractorVersion: extractor.versionFor!('image/heic'),
      policyDecision: 'index_allowed',
    });
    expect(result.jobsQueued).toBe(1);
  });

  test('the text lane indexes a prepared picture: a descriptor, any OCR text, and the copy as media', async () => {
    const cacheDir = join(temporaryDir(), 'media-cache');
    const extractor = createTextExtractor({
      imagePreparation: createImagePreparation({ cacheDir, commandRunner: fakeSips() }),
      imageOcr: async () => ({ status: 'indexed', text: 'OPEN HOUSE SUNDAY' }),
    });
    const output = await extractor.extract(extractorInput(picture(3)));
    expect(output.status).toBe('indexed');
    if (output.status !== 'indexed') return;
    expect(output.text).toBe(`${IMAGE_MEDIA_DESCRIPTOR}\nOPEN HOUSE SUNDAY`);
    expect(output.media?.mimeType).toBe('image/jpeg');
    expect(existsSync(output.media!.path)).toBe(true);

    // No text on the picture: still indexed, as a photo.
    const quiet = createTextExtractor({
      imagePreparation: createImagePreparation({ cacheDir, commandRunner: fakeSips() }),
      imageOcr: async () => ({ status: 'metadata_only' }),
    });
    const plain = await quiet.extract(extractorInput(picture(4)));
    expect(plain.status === 'indexed' ? plain.text : undefined).toBe(IMAGE_MEDIA_DESCRIPTOR);
  });

  test('without preparation (off macOS) an image is exactly as before', async () => {
    const extractor = createTextExtractor();
    expect(await extractor.extract(extractorInput(picture(8)))).toEqual({ status: 'metadata_only' });
    const registry = createDefaultExtractorRegistry({
      media: { cacheDir: join(temporaryDir(), 'media-cache'), platform: 'linux' },
      ocr: { platform: 'linux' },
    });
    const text = registry.get('local_text')!;
    expect(await text.extract(extractorInput(picture(8), 'image/jpeg'))).toEqual({ status: 'metadata_only' });
  });

  test('the media cache lives under the Olympus data directory unless overridden', () => {
    expect(mediaCacheDir({ HOME: '/home/owner' })).toBe('/home/owner/.local/share/openclaw/olympus/media-cache');
    expect(mediaCacheDir({ XDG_DATA_HOME: '/data' })).toBe('/data/openclaw/olympus/media-cache');
    // A directory the owner names gets a dedicated subdirectory: Olympus never
    // changes the permissions of a directory it did not create.
    expect(mediaCacheDir({ OLYMPUS_MEDIA_CACHE_DIR: '/cache/media' })).toBe('/cache/media/olympus-media');
    expect(() => mediaCacheDir({ OLYMPUS_MEDIA_CACHE_DIR: 'relative' })).toThrow('absolute');
  });

  test('a cache path is recognised by its shape, whatever root this process is configured with', () => {
    const sha = 'a'.repeat(64);
    expect(isMediaCachePath(`/elsewhere/olympus-media/${sha}.jpg`, sha)).toBe(true);
    expect(isMediaCachePath(`/home/owner/.local/share/openclaw/olympus/media-cache/${sha}.jpg`, sha)).toBe(true);
    expect(isMediaCachePath(`/elsewhere/photos/${sha}.jpg`, sha)).toBe(false);
    expect(isMediaCachePath(`/elsewhere/olympus-media/../olympus-media/${sha}.jpg`, sha)).toBe(false);
    // A link in place of the file is not a cache file.
    const dir = join(temporaryDir(), 'olympus-media');
    mkdirSync(dir);
    const target = join(temporaryDir(), 'target.jpg');
    writeFileSync(target, 'x');
    symlinkSync(target, join(dir, `${sha}.jpg`));
    expect(isMediaCachePath(join(dir, `${sha}.jpg`), sha)).toBe(false);
  });

  test('a store\'s marker matches whatever spelling of its path a caller uses', () => {
    const base = temporaryDir();
    const real = join(base, 'real');
    mkdirSync(real);
    const storePath = join(real, 'store.sqlite');
    writeFileSync(storePath, '');
    const linked = join(base, 'linked');
    symlinkSync(real, linked);
    const written = writeMediaCacheFile(cache(), jpegBytes(900), 'image/jpeg');
    retainMediaCacheFile(written.path, written.sha256, storePath);
    releaseMediaCacheFile(written.path, written.sha256, written.stagingHolder);
    expect(existsSync(written.path)).toBe(true);
    expect(releaseMediaCacheFile(written.path, written.sha256, join(linked, 'store.sqlite'))).toBe(true);
    expect(existsSync(written.path)).toBe(false);
  });

  test('only the cache\'s own <sha256>.jpg files are ever marked or removed', () => {
    const dir = join(temporaryDir(), 'media-cache');
    const outside = join(temporaryDir(), 'precious.jpg');
    writeFileSync(outside, 'keep me');
    const sha = 'e'.repeat(64);
    expect(isMediaCachePath(join(dir, `${sha}.jpg`), sha, dir)).toBe(true);
    expect(isMediaCachePath(join(temporaryDir(), 'media-cache', `${sha}.jpg`), sha, dir)).toBe(false);
    expect(isMediaCachePath(join(dir, `${'f'.repeat(64)}.jpg`), sha, dir)).toBe(false);
    expect(retainMediaCacheFile(outside, sha, 'store', dir)).toBe(false);
    expect(releaseMediaCacheFile(outside, sha, 'store', dir)).toBe(false);
    expect(existsSync(outside)).toBe(true);
    expect(existsSync(`${outside}.refs`)).toBe(false);
  });

  test('the sweep removes what nothing holds once it is old, and keeps what is held', () => {
    const dir = join(temporaryDir(), 'media-cache');
    const orphan = writeMediaCacheFile(dir, jpegBytes(101), 'image/jpeg');
    const held = writeMediaCacheFile(dir, jpegBytes(102), 'image/jpeg');
    const fresh = writeMediaCacheFile(dir, jpegBytes(103), 'image/jpeg');
    retainMediaCacheFile(held.path, held.sha256, 'store', dir);
    // Every staging hold is from an extraction that died two days ago.
    const old = (Date.now() - 2 * 24 * 60 * 60_000) / 1000;
    for (const media of [orphan, held]) {
      utimesSync(media.path, old, old);
      for (const marker of readdirSync(`${media.path}.refs`)) utimesSync(join(`${media.path}.refs`, marker), old, old);
    }
    expect(sweepMediaCache(dir)).toBe(1);
    expect(existsSync(orphan.path)).toBe(false);
    expect(existsSync(held.path)).toBe(true);
    expect(existsSync(fresh.path)).toBe(true);
  });

  const realSips = process.platform === 'darwin' && process.env.OLYMPUS_MEDIA_REAL_SIPS_TEST === '1' ? test : test.skip;
  realSips('the real sips turns a PNG into a bounded JPEG (opt-in, macOS)', async () => {
    const cacheDir = join(temporaryDir(), 'media-cache');
    const png = solidPng(1600, 900, [200, 30, 30]);
    const result = await createImagePreparation({ cacheDir })({ bytes: png, mimeType: 'image/png', sizeBytes: png.byteLength });
    expect(result.kind).toBe('media');
    if (result.kind !== 'media') return;
    const info = execFileSync('/usr/bin/sips', ['-g', 'pixelWidth', '-g', 'pixelHeight', result.media.path]).toString();
    expect(info).toContain('pixelWidth: 1024');
    expect(info).toContain('pixelHeight: 576');
  });
});

// --- Store ------------------------------------------------------------------

const CORPUS_ID = 'secure_local.fake.files';

function photoItem(id = 'photo-1'): RawItem {
  return {
    identity: { family: 'file', provider: 'fake', accountScope: 'personal', providerItemId: id, localItemId: `local:${id}`, sourceVersion: 'rev-1' },
    mimeType: 'image/jpeg',
    content: { kind: 'metadata_only' },
    metadata: { name: `${id}.jpg`, pathDisplay: `/Photos/${id}.jpg` },
    fetchedAt: '2026-10-07T00:00:00.000Z',
  };
}

function connectorFor(items: readonly RawItem[]): SourceConnector {
  return {
    id: 'fake-metadata-sync',
    family: 'file',
    async authenticate() {},
    async *listItems(): AsyncIterable<SourceConnectorListPage> {
      yield { items, done: true };
    },
    async fetchItem(localItemId: string): Promise<RawItem> {
      return items.find((item) => item.identity.localItemId === localItemId)!;
    },
    classificationSignals: () => ({}),
  };
}

async function photoStore(
  dbPath = join(temporaryDir(), 'store.sqlite'),
  ids = ['photo-1'],
  options: { now?: () => Date; stillImagesRead?: boolean } = {},
): Promise<LocalConnectorStore> {
  const store = new LocalConnectorStore({ dbPath, corpusId: CORPUS_ID, family: 'file', trustDomain: 'secure_local', ...options });
  await store.syncFromConnector(connectorFor(ids.map((id) => photoItem(id))), { fetchContent: false });
  return store;
}

function sinkFor(store: LocalConnectorStore) {
  return createConnectorStoreExtractionSink({
    store,
    classify: () => buildSourceSensitivity({ trustTier: 'S4', trustDomain: 'secure_local' }),
    syncConnectorId: 'extraction',
    ownerConnectorId: 'fake-connector',
    ownershipKind: 'observed',
  });
}

function photoRef(id = 'photo-1'): ExtractionItemRef {
  return {
    corpusId: CORPUS_ID,
    provider: 'fake',
    accountScope: 'personal',
    approvedScopeKey: 'scope',
    providerItemId: id,
    localItemId: `local:${id}`,
    sourceVersion: 'rev-1',
    name: `${id}.jpg`,
    mimeType: 'image/jpeg',
  };
}

function request(media: ExtractionSinkRequest['media'], text = IMAGE_MEDIA_DESCRIPTOR, id = 'photo-1'): ExtractionSinkRequest {
  return {
    ref: photoRef(id),
    text,
    extractorKind: 'local_text',
    extractorVersion: '1',
    fetchedAt: '2026-10-07T01:00:00.000Z',
    ...(media ? { media } : {}),
  };
}

function chunkRows(dbPath: string) {
  const db = new Database(dbPath, { readonly: true });
  try {
    return db.query('SELECT chunk_index, media_path, media_sha256, embedding_input_hash FROM chunks ORDER BY chunk_pk').all() as Array<{
      chunk_index: number; media_path: string | null; media_sha256: string | null; embedding_input_hash: string;
    }>;
  } finally {
    db.close();
  }
}

/** Prepared-JPEG bytes, distinct per seed. */
function jpegBytes(seed: number): Uint8Array {
  return new Uint8Array([...JPEG_MAGIC, seed & 0xff, (seed >> 8) & 0xff, (seed >> 16) & 0xff, 7]);
}
let seedCounter = 0;

/**
 * What the runner does for one prepared picture: the text lane writes it (with
 * its staging hold), the sink stores it, and the hold is released.
 */
async function landPicture(store: LocalConnectorStore, id = 'photo-1', text: string = IMAGE_MEDIA_DESCRIPTOR) {
  const written = writeMediaCacheFile(cache(), jpegBytes(1_000 + (seedCounter += 1)), 'image/jpeg');
  const media = { path: written.path, sha256: written.sha256, mimeType: 'image/jpeg' as const };
  const result = await sinkFor(store).accept(request(media, text, id));
  releaseMediaCacheFile(written.path, written.sha256, written.stagingHolder);
  return { media, result, stagingHolder: written.stagingHolder };
}

class CapturingProvider extends DeterministicSourceEmbeddingProvider {
  readonly inputs: SourceEmbeddingInput[] = [];
  override async embed(inputs: SourceEmbeddingInput[], options: { taskType: SourceEmbeddingTaskType }): Promise<number[][]> {
    this.inputs.push(...inputs);
    return super.embed(inputs, options);
  }
}

/**
 * A provider whose model reads pictures. `poison` names pictures it cannot
 * read; `mode` 'held' acts as a helper restarted without its encoder, and
 * 'engine_fault' as an engine that fails every picture (the helper's probe
 * then fails too, so it throws an ordinary error).
 */
class PictureProvider extends CapturingProvider {
  mode: 'ok' | 'held' | 'engine_fault' = 'ok';

  constructor(private readonly vision = true, private readonly poison = new Set<string>()) {
    super({ dimension: 8 });
  }

  async imageSupport(): Promise<boolean> {
    return this.vision;
  }

  override async embed(inputs: SourceEmbeddingInput[], options: { taskType: SourceEmbeddingTaskType }): Promise<number[][]> {
    const pictures = inputs.flatMap((input, index) => (input.image ? [index] : []));
    if (pictures.length > 0 && this.mode === 'engine_fault') throw new Error('The built-in search model failed while embedding.');
    if (pictures.length > 0 && this.mode === 'held') throw new SourceEmbeddingInputsFailedError(pictures, 'image_encoder_unavailable', 'held');
    const failed = inputs.flatMap((input, index) => (input.image && this.poison.has(input.image.sha256) ? [index] : []));
    if (failed.length > 0) throw new SourceEmbeddingInputsFailedError(failed, 'image_unreadable');
    return super.embed(inputs, options);
  }
}

function mediaFailures(dbPath: string): Array<{ media_sha256: string; attempts: number }> {
  const db = new Database(dbPath, { readonly: true });
  try {
    return db.query('SELECT media_sha256, attempts FROM chunk_media_failures').all() as Array<{ media_sha256: string; attempts: number }>;
  } finally {
    db.close();
  }
}

describe('a prepared picture through runner, sink and store', () => {
  test('the runner hands the extractor\'s media to the sink, then gives up its own hold', async () => {
    for (const accept of [true, false]) {
      const jobs = new LocalFileExtractionJobStore(':memory:');
      try {
        const written = writeMediaCacheFile(cache(), jpegBytes(1 + (accept ? 0 : 1)), 'image/jpeg');
        const media = { path: written.path, sha256: written.sha256, mimeType: 'image/jpeg' as const, stagingHolder: written.stagingHolder };
        const extractor: Extractor = {
          kind: 'fake_text', version: '1', needsBytes: true, egress: 'local', accepts: () => true,
          async extract() { return { status: 'indexed', text: IMAGE_MEDIA_DESCRIPTOR, media }; },
        };
        const accepted: ExtractionSinkRequest[] = [];
        jobs.enqueue({ refs: [photoRef()], extractorKind: 'fake_text', extractorVersion: '1', policyDecision: 'index_allowed' });
        const runner = createFileExtractionRunner({
          jobs,
          registry: buildExtractorRegistry([extractor]),
          corpora: [{
            corpusId: CORPUS_ID,
            trustDomain: 'secure_local',
            source: {
              id: 'fake', corpusId: CORPUS_ID, provider: 'fake',
              async listCandidates() { return { candidates: [], done: true }; },
              async fetch() { return { bytes: picture(1), mimeType: 'image/jpeg' }; },
            },
            sink: {
              async accept(sinkRequest) {
                accepted.push(sinkRequest);
                // A store that takes the picture holds its own reference.
                if (accept) retainMediaCacheFile(sinkRequest.media!.path, sinkRequest.media!.sha256, 'store');
                return accept
                  ? { accepted: true, chunksIndexed: 1, chunksAwaitingEmbedding: 1 }
                  : { accepted: false, chunksIndexed: 0, chunksAwaitingEmbedding: 0, skippedReason: EXTRACTION_SINK_SKIPPED_IMAGE_PRIVATE_ONLY };
              },
            },
          }],
        });
        const result = await runner.run({ corpusId: CORPUS_ID, provider: 'fake', accountScope: 'personal', approvedScopeKey: 'scope' });
        expect(accepted[0]!.media).toEqual(media);
        // Taken: kept. Refused: nothing holds it, so it is gone.
        expect(existsSync(written.path)).toBe(accept);
        expect(accept ? result.counts.indexed : result.counts.metadata_only).toBe(1);
      } finally {
        jobs.close();
      }
    }
  });

  test('the store attaches the picture to the first chunk, and its digest is in the embedding input hash', async () => {
    const dbPath = join(temporaryDir(), 'store.sqlite');
    const textOnlyPath = join(temporaryDir(), 'text-only.sqlite');
    const store = await photoStore(dbPath);
    const textOnly = await photoStore(textOnlyPath);
    try {
      const { media, result } = await landPicture(store);
      expect(result).toMatchObject({ accepted: true, chunksIndexed: 1, chunksAwaitingEmbedding: 1 });
      await sinkFor(textOnly).accept(request(undefined));
      const [withMedia] = chunkRows(dbPath);
      const [plain] = chunkRows(textOnlyPath);
      expect(withMedia).toMatchObject({ chunk_index: 0, media_path: media.path, media_sha256: media.sha256 });
      expect(plain).toMatchObject({ media_path: null, media_sha256: null });
      expect(withMedia!.embedding_input_hash).not.toBe(plain!.embedding_input_hash);

      // The same picture again is unchanged; a changed picture behind the
      // same text is a changed representation with a new input hash.
      const same = await sinkFor(store).accept(request(media));
      expect(same.chunksAwaitingEmbedding).toBe(0);
      const changed = await landPicture(store);
      const [after] = chunkRows(dbPath);
      expect(after!.media_sha256).toBe(changed.media.sha256);
      expect(after!.embedding_input_hash).not.toBe(withMedia!.embedding_input_hash);
      // The replaced picture had no other holder: it is gone from the cache.
      expect(existsSync(media.path)).toBe(false);
      expect(existsSync(changed.media.path)).toBe(true);
    } finally {
      store.close();
      textOnly.close();
    }
  });

  test('a Personal (or Public) store never receives a picture or a photo\'s text, from any lane', async () => {
    for (const trustDomain of ['internal', 'public_safe'] as const) {
      const dbPath = join(temporaryDir(), `${trustDomain}.sqlite`);
      const store = new LocalConnectorStore({ dbPath, corpusId: `${trustDomain}.fake.files`, family: 'file', trustDomain });
      try {
        await store.syncFromConnector(connectorFor([photoItem()]), { fetchContent: false });
        const sink = createConnectorStoreExtractionSink({
          store,
          classify: () => buildSourceSensitivity({ trustTier: trustDomain === 'internal' ? 'S3' : 'S1', trustDomain }),
          syncConnectorId: 'extraction',
          ownerConnectorId: 'fake-connector',
          ownershipKind: 'observed',
        });
        const written = writeMediaCacheFile(cache(), jpegBytes(500), 'image/jpeg');
        const withPicture = await sink.accept(request({ path: written.path, sha256: written.sha256, mimeType: 'image/jpeg' }));
        const ocrOnly = await sink.accept(request(undefined, 'Photo\nOPEN HOUSE SUNDAY'));
        releaseMediaCacheFile(written.path, written.sha256, written.stagingHolder);
        expect(withPicture.skippedReason).toBe(EXTRACTION_SINK_SKIPPED_IMAGE_PRIVATE_ONLY);
        expect(ocrOnly.skippedReason).toBe(EXTRACTION_SINK_SKIPPED_IMAGE_PRIVATE_ONLY);
        expect(chunkRows(dbPath)).toEqual([]);
        expect(existsSync(written.path)).toBe(false);
      } finally {
        store.close();
      }
    }
  });

  test('a copy into a Personal store keeps the text and drops the picture; into a Private store it keeps both', async () => {
    const from = await photoStore(join(temporaryDir(), 'from.sqlite'));
    const personalPath = join(temporaryDir(), 'personal.sqlite');
    const privatePath = join(temporaryDir(), 'private.sqlite');
    const personal = new LocalConnectorStore({ dbPath: personalPath, corpusId: 'internal.fake.files', family: 'file', trustDomain: 'internal' });
    const secure = new LocalConnectorStore({ dbPath: privatePath, corpusId: 'secure_local.other.files', family: 'file', trustDomain: 'secure_local' });
    try {
      const { media } = await landPicture(from);
      const copy = from.exportItemCopy(photoItem().identity)!;
      expect(copy.chunks[0]).toMatchObject({ mediaPath: media.path, mediaSha256: media.sha256 });
      personal.importItemCopy(copy, { trustTier: 'S3', syncConnectorId: 'tier-move' });
      const [personalChunk] = chunkRows(personalPath);
      expect(personalChunk).toMatchObject({ media_path: null, media_sha256: null });
      // Re-hashed as text, so it embeds as text there.
      expect(personalChunk!.embedding_input_hash).not.toBe(copy.chunks[0]!.embeddingInputHash);
      secure.importItemCopy(copy, { trustTier: 'S4', syncConnectorId: 'tier-move' });
      expect(chunkRows(privatePath)[0]).toMatchObject({ media_path: media.path, media_sha256: media.sha256 });
      // Both Private stores hold it now: the first letting go keeps the file.
      await sinkFor(from).accept(request(undefined, 'Now just text'));
      expect(existsSync(media.path)).toBe(true);
    } finally {
      from.close();
      personal.close();
      secure.close();
    }
  });

  test('a twin photo deleted while the other is mid-extraction does not take the file', async () => {
    const a = await photoStore(join(temporaryDir(), 'a.sqlite'));
    const b = await photoStore(join(temporaryDir(), 'b.sqlite'));
    try {
      const bytes = jpegBytes(700);
      const first = writeMediaCacheFile(cache(), bytes, 'image/jpeg');
      await sinkFor(a).accept(request({ path: first.path, sha256: first.sha256, mimeType: 'image/jpeg' }));
      releaseMediaCacheFile(first.path, first.sha256, first.stagingHolder);
      // The twin's extraction writes the same bytes (its hold taken) ...
      const twin = writeMediaCacheFile(cache(), bytes, 'image/jpeg');
      // ... the first copy's item is stripped meanwhile ...
      a.stripCopyContent(photoItem().identity);
      expect(existsSync(first.path)).toBe(true);
      // ... and the twin lands on a file that is still there.
      await sinkFor(b).accept(request({ path: twin.path, sha256: twin.sha256, mimeType: 'image/jpeg' }));
      releaseMediaCacheFile(twin.path, twin.sha256, twin.stagingHolder);
      expect(existsSync(twin.path)).toBe(true);
    } finally {
      a.close();
      b.close();
    }
  });

  test('deleting paths release a picture at once: strip, purge, close', async () => {
    const store = await photoStore(undefined, ['photo-1', 'photo-2']);
    const one = await landPicture(store, 'photo-1');
    const two = await landPicture(store, 'photo-2');
    store.stripCopyContent(photoItem('photo-1').identity);
    expect(existsSync(one.media.path)).toBe(false);
    expect(existsSync(two.media.path)).toBe(true);
    store.close();
    expect(existsSync(two.media.path)).toBe(true);
  });

  test('the embed lane hands the picture to a provider that reads pictures; others embed the text', async () => {
    const store = await photoStore(undefined, ['photo-1', 'photo-2']);
    try {
      const first = await landPicture(store);
      await sinkFor(store).accept(request(undefined, 'A note about the kitchen', 'photo-2'));
      const provider = new PictureProvider();
      const summary = await store.embedChunks({ provider });
      expect(summary.chunksEmbedded).toBe(2);
      const withImage = provider.inputs.find((input) => input.image);
      expect(withImage?.image).toEqual({ path: first.media.path, sha256: first.media.sha256, mimeType: 'image/jpeg' });
      expect(withImage?.text.endsWith(IMAGE_MEDIA_DESCRIPTOR)).toBe(true);

      const second = await landPicture(store);
      provider.inputs.length = 0;
      await store.embedChunks({ provider });
      expect(provider.inputs.map((input) => input.image?.sha256)).toEqual([second.media.sha256]);

      // A provider that does not read pictures embeds the photo's text, even
      // with the cache file gone.
      const textModel = new CapturingProvider({ modelId: 'text-only-model', dimension: 8 });
      rmSync(second.media.path);
      expect((await store.embedChunks({ provider: textModel })).chunksEmbedded).toBe(2);
    } finally {
      store.close();
    }
  });

  test('a picture gone from the cache is dropped, and the photo embeds as text instead of waiting for ever', async () => {
    const dbPath = join(temporaryDir(), 'store.sqlite');
    const store = await photoStore(dbPath);
    try {
      const { media } = await landPicture(store);
      rmSync(media.path);
      const provider = new PictureProvider();
      expect((await store.embedChunks({ provider })).chunksEmbedded).toBe(0);
      expect(chunkRows(dbPath)[0]).toMatchObject({ media_path: null, media_sha256: null });
      expect((await store.embedChunks({ provider })).chunksEmbedded).toBe(1);
      expect(provider.inputs.every((input) => !input.image)).toBe(true);
    } finally {
      store.close();
    }
  });

  test('without the image encoder, photos are held and text keeps embedding', async () => {
    const dbPath = join(temporaryDir(), 'store.sqlite');
    const store = await photoStore(dbPath, ['photo-1', 'photo-2']);
    try {
      const { media } = await landPicture(store);
      await sinkFor(store).accept(request(undefined, 'A note', 'photo-2'));
      const blind = new PictureProvider(false);
      expect((await store.embedChunks({ provider: blind })).chunksEmbedded).toBe(1);
      expect(blind.inputs.some((input) => input.image)).toBe(false);
      // The photo still carries its picture, and embeds once the encoder runs.
      expect(chunkRows(dbPath)[0]).toMatchObject({ media_sha256: media.sha256 });
      expect((await store.embedChunks({ provider: new PictureProvider(true) })).chunksEmbedded).toBe(1);
    } finally {
      store.close();
    }
  });

  test('an unreadable picture backs off, never holds up the rest, and after three tries embeds as text', async () => {
    const dbPath = join(temporaryDir(), 'store.sqlite');
    let clock = Date.parse('2026-10-08T00:00:00.000Z');
    const store = await photoStore(dbPath, ['photo-1', 'photo-2', 'photo-3'], { now: () => new Date(clock) });
    try {
      const bad = await landPicture(store, 'photo-1');
      await landPicture(store, 'photo-2');
      await sinkFor(store).accept(request(undefined, 'A note', 'photo-3'));
      const provider = new PictureProvider(true, new Set([bad.media.sha256]));
      expect((await store.embedChunks({ provider })).chunksEmbedded).toBe(2);
      expect(mediaFailures(dbPath)).toEqual([{ media_sha256: bad.media.sha256, attempts: 1 }]);
      // Within the back-off it is not sent again.
      provider.inputs.length = 0;
      expect((await store.embedChunks({ provider })).chunksEmbedded).toBe(0);
      expect(provider.inputs).toEqual([]);
      // Retried after the back-off (1 h, then 2 h); the third failure drops
      // the picture, and the photo embeds as text.
      clock += 61 * 60_000;
      await store.embedChunks({ provider });
      expect(mediaFailures(dbPath)[0]?.attempts).toBe(2);
      clock += 121 * 60_000;
      await store.embedChunks({ provider });
      expect(mediaFailures(dbPath)).toEqual([]);
      expect(chunkRows(dbPath)[0]).toMatchObject({ media_sha256: null });
      provider.inputs.length = 0;
      expect((await store.embedChunks({ provider })).chunksEmbedded).toBe(1);
      expect(provider.inputs.every((input) => !input.image)).toBe(true);
    } finally {
      store.close();
    }
  });

  test('an engine fault on an all-photo batch marks nothing and stops the pass', async () => {
    const dbPath = join(temporaryDir(), 'store.sqlite');
    const store = await photoStore(dbPath, ['photo-1', 'photo-2']);
    try {
      await landPicture(store, 'photo-1');
      await landPicture(store, 'photo-2');
      const provider = new PictureProvider(true);
      provider.mode = 'engine_fault';
      await expect(store.embedChunks({ provider })).rejects.toThrow('failed while embedding');
      expect(mediaFailures(dbPath)).toEqual([]);
      // The engine back (the helper replaced): both embed with their pictures.
      provider.mode = 'ok';
      expect((await store.embedChunks({ provider })).chunksEmbedded).toBe(2);
    } finally {
      store.close();
    }
  });

  test('a helper restarted without its encoder mid-pass holds photos, marks nothing, and text embeds', async () => {
    const dbPath = join(temporaryDir(), 'store.sqlite');
    const store = await photoStore(dbPath, ['photo-1', 'photo-2']);
    try {
      await landPicture(store, 'photo-1');
      await sinkFor(store).accept(request(undefined, 'A note', 'photo-2'));
      // imageSupport said yes at the start of the pass; the helper then
      // restarted without its encoder.
      const provider = new PictureProvider(true);
      provider.mode = 'held';
      expect((await store.embedChunks({ provider })).chunksEmbedded).toBe(1);
      expect(mediaFailures(dbPath)).toEqual([]);
      expect(chunkRows(dbPath)[0]!.media_sha256).not.toBeNull();
      provider.mode = 'ok';
      expect((await store.embedChunks({ provider })).chunksEmbedded).toBe(1);
    } finally {
      store.close();
    }
  });

  test('an image read before pictures is listed once; one read since (with or without a picture) is not', async () => {
    const store = await photoStore(undefined, ['photo-1', 'photo-2'], { stillImagesRead: true });
    try {
      // photo-1: OCR text from before pictures were read (no reading recorded).
      await sinkFor(store).accept(request(undefined, 'Photo\nOPEN HOUSE', 'photo-1'));
      const db = new Database(store.dbPath);
      db.exec('DELETE FROM image_media_reads');
      db.close();
      // photo-2: read since, and it ended without a picture (a tiny one).
      await sinkFor(store).accept(request(undefined, 'Photo', 'photo-2'));
      const listed = () => store.extractionCandidates({ limit: 10, withoutChunksOnly: true }).candidates
        .map((candidate) => candidate.identity.providerItemId);
      expect(listed()).toEqual(['photo-1']);
      await landPicture(store, 'photo-1');
      expect(listed()).toEqual([]);
      // Off a Mac nothing is listed again.
      const offMac = new LocalConnectorStore({ dbPath: store.dbPath, corpusId: CORPUS_ID, family: 'file', trustDomain: 'secure_local', stillImagesRead: false });
      expect(offMac.extractionCandidates({ limit: 10, withoutChunksOnly: true }).candidates).toEqual([]);
      offMac.close();
    } finally {
      store.close();
    }
  });

  test('a store opened by an earlier build of schema 13 heals its missing media objects', async () => {
    const dbPath = join(temporaryDir(), 'early13.sqlite');
    const seeded = await photoStore(dbPath);
    seeded.close();
    const db = new Database(dbPath);
    db.exec(`
      DROP TABLE image_media_reads;
      DROP INDEX idx_connector_store_chunks_media;
      ALTER TABLE chunk_media_failures DROP COLUMN attempts;
    `);
    db.close();
    const reopened = new LocalConnectorStore({ dbPath, corpusId: CORPUS_ID, family: 'file', trustDomain: 'secure_local' });
    reopened.close();
    const check = new Database(dbPath, { readonly: true });
    try {
      const tables = (check.query("SELECT name FROM sqlite_master").all() as Array<{ name: string }>).map((row) => row.name);
      expect(tables).toEqual(expect.arrayContaining(['image_media_reads', 'idx_connector_store_chunks_media']));
      const columns = (check.query('PRAGMA table_info(chunk_media_failures)').all() as Array<{ name: string }>).map((column) => column.name);
      expect(columns).toContain('attempts');
    } finally {
      check.close();
    }
  });

  test('releases drain completely, however many a bulk strip queues', async () => {
    const dbPath = join(temporaryDir(), 'bulk.sqlite');
    const store = await photoStore(dbPath);
    store.close();
    // 1,500 synthetic queued releases of cache files only this store holds.
    const again = Array.from({ length: 1_500 }, (_, index) => writeMediaCacheFile(cache(), jpegBytes(20_000 + index), 'image/jpeg'));
    const db = new Database(dbPath);
    const insert = db.query('INSERT INTO chunk_media_releases (media_sha256, media_path) VALUES (?, ?)');
    for (const media of again) {
      retainMediaCacheFile(media.path, media.sha256, dbPath);
      releaseMediaCacheFile(media.path, media.sha256, media.stagingHolder);
      insert.run(media.sha256, media.path);
    }
    db.close();
    const reopened = new LocalConnectorStore({ dbPath, corpusId: CORPUS_ID, family: 'file', trustDomain: 'secure_local' });
    reopened.close();
    const check = new Database(dbPath, { readonly: true });
    try {
      expect((check.query('SELECT COUNT(*) AS n FROM chunk_media_releases').get() as { n: number }).n).toBe(0);
    } finally {
      check.close();
    }
    expect(again.filter((media) => existsSync(media.path))).toEqual([]);
  }, 60_000);

  test('an older store gains the media columns by an additive migration', async () => {
    const dbPath = join(temporaryDir(), 'old.sqlite');
    const seeded = await photoStore(dbPath);
    await sinkFor(seeded).accept(request(undefined, 'Text from before photos'));
    seeded.close();
    const db = new Database(dbPath);
    db.exec(`
      DROP TRIGGER connector_store_chunk_media_release;
      DROP TABLE chunk_media_releases;
      DROP TABLE chunk_media_failures;
      DROP INDEX idx_connector_store_chunks_media;
      ALTER TABLE chunks DROP COLUMN media_path;
      ALTER TABLE chunks DROP COLUMN media_sha256;
      DROP INDEX idx_connector_store_media_judgments_unapplied;
      DROP TABLE media_judgments;
      UPDATE schema_version SET version = 12 WHERE store_id = 'connector-store';
    `);
    db.close();
    const reopened = new LocalConnectorStore({ dbPath, corpusId: CORPUS_ID, family: 'file', trustDomain: 'secure_local' });
    reopened.close();
    const check = new Database(dbPath, { readonly: true });
    try {
      const version = check.query("SELECT version FROM schema_version WHERE store_id = 'connector-store'").get() as { version: number };
      expect(version.version).toBe(14);
      const columns = (check.query('PRAGMA table_info(chunks)').all() as Array<{ name: string }>).map((column) => column.name);
      expect(columns).toContain('media_path');
      expect(columns).toContain('media_sha256');
      const indexes = (check.query('PRAGMA index_list(chunks)').all() as Array<{ name: string }>).map((index) => index.name);
      expect(indexes).toContain('idx_connector_store_chunks_media');
      const rows = check.query('SELECT bounded_text, media_sha256 FROM chunks').all() as Array<{ bounded_text: string; media_sha256: string | null }>;
      expect(rows).toEqual([{ bounded_text: 'Text from before photos', media_sha256: null }]);
    } finally {
      check.close();
    }
  });
});

describe('data lifecycle and the media cache', () => {
  test('deleting a source releases its photos; deleting everything names the cache, wherever it is', async () => {
    const home = temporaryDir('olympus-photo-home-');
    // XDG_DATA_HOME is set so the store path is under this temporary home,
    // never the real one.
    const env = { HOME: home, XDG_DATA_HOME: join(home, '.local', 'share'), [MEDIA_CACHE_DIR_ENV]: CACHE_BASE };
    const dbPath = defaultDropboxConnectorStoreDbPath(env);
    expect(dbPath.startsWith(home)).toBe(true);
    mkdirSync(join(dbPath, '..'), { recursive: true });
    const store = await photoStore(dbPath);
    const { media } = await landPicture(store);
    store.close();
    const all = deleteOlympusData({ all: true, dryRun: true, homeDir: home, env });
    expect([...all.removed, ...all.missing]).toContain(cache());
    const result = deleteOlympusData({ sourceId: 'dropbox.files', homeDir: home, env });
    expect(result.removed).toContain(media.path);
    expect(existsSync(media.path)).toBe(false);
  });

  test('a store whose picture references cannot be read stops the delete, and nothing is deleted', async () => {
    const home = temporaryDir('olympus-photo-home-');
    const env = { HOME: home, XDG_DATA_HOME: join(home, '.local', 'share'), [MEDIA_CACHE_DIR_ENV]: CACHE_BASE };
    const dbPath = defaultDropboxConnectorStoreDbPath(env);
    mkdirSync(join(dbPath, '..'), { recursive: true });
    // A SQLite file whose pages are damaged past the header.
    const header = Buffer.from('SQLite format 3\u0000', 'latin1');
    writeFileSync(dbPath, Buffer.concat([header, Buffer.alloc(4096, 0xab)]));
    expect(() => deleteOlympusData({ sourceId: 'dropbox.files', homeDir: home, env })).toThrow('nothing was deleted');
    expect(existsSync(dbPath)).toBe(true);
  });
});

describe('photo content rests Private by default', () => {
  const base = { metadataTier: 'private' as const, metadataForced: false, metadataFlagged: false };

  test('an image\'s content is Private whatever text was read off it; its names keep their tier', () => {
    const decision = classifyContentTier({ ...base, text: 'Photo\nOPEN HOUSE SUNDAY', mimeType: 'image/jpeg' });
    expect(decision.contentTier).toBe('secure');
    expect(decision.reasons).toEqual([IMAGE_PRIVATE_DEFAULT_REASON]);
    expect(decision.contentPending).toBe(false);
    // Even when an owner rule forced the names Public.
    expect(classifyContentTier({ ...base, metadataTier: 'public', metadataForced: true, text: 'Photo', mimeType: 'image/png' }).contentTier).toBe('secure');
    // Text that is not a picture is judged as before.
    expect(classifyContentTier({ ...base, text: 'Photo', mimeType: 'text/plain' }).contentTier).toBe('private');
  });

  test('the owner\'s per-item override still decides, and a secret read off a picture is still Secrets', () => {
    expect(classifyContentTier({ ...base, text: 'Photo', mimeType: 'image/jpeg' }, { override: { kind: 'tier', tier: 'private' } }).contentTier).toBe('private');
    // Built from parts so the repository's credential scanner does not read a literal key.
    const fakeKey = ['AKIA', 'ABCDEFGHIJKLMNOP'].join('');
    const secret = classifyContentTier({ ...base, text: `Photo\n${fakeKey}`, mimeType: 'image/jpeg' });
    expect(secret.contentTier).toBe('secrets');
  });
});

describe('coverage for a picture', () => {
  test('an image with a stored chunk is not an extraction gap; one without is', () => {
    expect(connectorStoreCoverageGaps({ storedChunks: 1, truncated: false, mimeType: 'image/jpeg' })).toEqual([]);
    expect(connectorStoreCoverageGaps({ storedChunks: 0, truncated: false, mimeType: 'image/jpeg' })[0]).toContain('image');
  });
});

describe('picture content stored outside Private before pictures were Private-only', () => {
  test('a routed photo\'s text in the Personal store is raised to Private (a move queued); an override stays', async () => {
    const { dir, cleanup } = tempDir('olympus-photo-tier-');
    const tiered = openTierFixture(dir, { embed: false });
    try {
      await tiered.set.sync(fixtureConnector(() => [
        { id: 'p1', name: 'kitchen.jpg', text: 'Photo OPEN HOUSE' },
        { id: 'p2', name: 'pool.jpg', text: 'Photo POOL PARTY' },
      ]), { fetchContent: true, placement: FIXTURE_PLACEMENT });
      const p1 = { provider: TIER_PROVIDER, accountScope: TIER_ACCOUNT, providerItemId: 'p1' };
      const p2 = { provider: TIER_PROVIDER, accountScope: TIER_ACCOUNT, providerItemId: 'p2' };
      expect(tiered.ledger.getCurrent(p1)).toMatchObject({ contentTier: 'private' });
      // As an earlier build stored them: photos with their text in Personal.
      const db = new Database(tiered.paths.internal);
      db.exec("UPDATE items SET mime_type = 'image/jpeg'");
      db.close();
      tiered.ledger.setOverride(p2, { kind: 'tier', tier: 'private' });
      tiered.ledger.writeMeta('image_content_private_sweep', '');
      const report = sweepImageContentToPrivate({ set: tiered.set });
      expect(report).toMatchObject({ raised: 1, complete: true });
      expect(tiered.ledger.getCurrent(p1)).toMatchObject({ state: 'moving', targetContentTier: 'secure' });
      expect(tiered.ledger.getCurrent(p1)!.reasons).toContain(IMAGE_PRIVATE_DEFAULT_REASON);
      expect(tiered.ledger.getCurrent(p2)).toMatchObject({ contentTier: 'private' });
      // Once.
      expect(sweepImageContentToPrivate({ set: tiered.set })).toMatchObject({ scanned: 0, raised: 0 });
    } finally {
      tiered.close();
      cleanup();
    }
  });

  test('a plain non-Private store loses picture text once, keeps the names, and notes it', async () => {
    const dbPath = join(temporaryDir(), 'drive-internal.sqlite');
    const store = new LocalConnectorStore({ dbPath, corpusId: 'internal.fake.files', family: 'file', trustDomain: 'internal' });
    try {
      const photo: RawItem = { ...photoItem(), content: { kind: 'text', text: 'Photo\nOPEN HOUSE SUNDAY' } };
      const note: RawItem = { ...photoItem('note-1'), mimeType: 'text/plain', content: { kind: 'text', text: 'A note' } };
      await store.syncFromConnector(connectorFor([photo, note]), { fetchContent: true });
      expect(chunkRows(dbPath)).toHaveLength(2);
      expect(store.stripImageContentOutsidePrivate()).toBe(1);
      expect(chunkRows(dbPath)).toHaveLength(1);
      expect(store.extractionCandidates({ limit: 10 }).candidates.map((row) => row.identity.providerItemId).sort())
        .toEqual(['note-1', 'photo-1']);
      const check = new Database(dbPath, { readonly: true });
      expect((check.query("SELECT items_seen FROM sync_runs WHERE connector_id = 'olympus_image_content_private_only'").get() as { items_seen: number }).items_seen).toBe(1);
      check.close();
      expect(store.stripImageContentOutsidePrivate()).toBe(0);
    } finally {
      store.close();
    }
  });
});
