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
import { afterEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { solidPng } from './helpers/solid-png.ts';
import type { RawItem, SourceConnector, SourceConnectorListPage } from '../src/core/contracts.ts';
import { mediaCacheDir, writeMediaCacheFile } from '../src/core/media-cache.ts';
import { defaultDropboxIngestionPolicy } from '../src/core/source-ingestion-policy.ts';
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
import { IMAGE_MEDIA_DESCRIPTOR, createTextExtractor } from '../src/workers/file-extraction/extractors/text.ts';
import { LocalFileExtractionJobStore } from '../src/workers/file-extraction/job-store.ts';
import { buildExtractorRegistry, createDefaultExtractorRegistry } from '../src/workers/file-extraction/registry.ts';
import { createFileExtractionRunner } from '../src/workers/file-extraction/runner.ts';
import { createConnectorStoreExtractionSink } from '../src/workers/file-extraction/store-sink.ts';
import type {
  ExtractionItemRef,
  ExtractionSinkRequest,
  Extractor,
  ExtractorInput,
} from '../src/workers/file-extraction/types.ts';
import {
  DeterministicSourceEmbeddingProvider,
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

const JPEG_MAGIC = [0xff, 0xd8, 0xff, 0xe0];

/** A stand-in for `sips`: writes a "JPEG" whose bytes depend on the input. */
function fakeSips(calls: string[][] = [], behaviour: 'ok' | 'fail' | 'timeout' | 'missing' | 'not-jpeg' = 'ok'): ExtractionCommandRunner {
  return async (request) => {
    calls.push([request.command, ...request.args]);
    if (behaviour === 'missing') throw Object.assign(new Error('spawn sips ENOENT'), { code: 'ENOENT' });
    if (behaviour === 'timeout') throw new ExtractionCommandTimeoutError({ command: request.command, timeoutMs: request.timeoutMs });
    if (behaviour === 'fail') throw new ExtractionCommandError({ command: request.command, exitCode: 13, stdout: '', stderr: '' });
    const input = readFileSync(request.args[request.args.length - 3]!);
    const output = request.args[request.args.length - 1]!;
    writeFileSync(output, behaviour === 'not-jpeg' ? Buffer.from('nope') : Buffer.concat([Buffer.from(JPEG_MAGIC), input]));
    return { stdout: '', stderr: '' };
  };
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

describe('the default ingestion policy reads still images and keeps video names-only', () => {
  test('photos are admitted for extraction; video and the book shelf stay metadata-only', () => {
    const policy = defaultDropboxIngestionPolicy();
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

  test('the readiness ladder no longer expects pictures to be metadata-only', () => {
    const sql = defaultDeferredContentReadinessSql();
    expect(sql).not.toContain("'image/%'");
    expect(sql).not.toContain('.jpg');
    expect(sql).toContain("'video/%'");
  });
});

describe('image preparation in the shared text lane', () => {
  test('a picture becomes an owner-only, content-addressed JPEG in the media cache', async () => {
    const cacheDir = join(temporaryDir(), 'media-cache');
    const calls: string[][] = [];
    const prepare = createImagePreparation({ cacheDir, commandRunner: fakeSips(calls) });
    const result = await prepare({ bytes: new Uint8Array([1, 2, 3]), mimeType: 'image/heic', sizeBytes: 3 });
    expect(result.kind).toBe('media');
    if (result.kind !== 'media') return;
    expect(calls[0]!.slice(0, 6)).toEqual(['/usr/bin/sips', '-s', 'format', 'jpeg', '-Z', '1024']);
    expect(calls[0]![6]!.endsWith('.heic')).toBe(true);
    expect(result.media.path).toBe(join(cacheDir, `${result.media.sha256}.jpg`));
    expect(statSync(cacheDir).mode & 0o777).toBe(0o700);
    expect(statSync(result.media.path).mode & 0o777).toBe(0o600);
    // The same picture again is the same file.
    const again = await prepare({ bytes: new Uint8Array([1, 2, 3]), mimeType: 'image/heic', sizeBytes: 3 });
    expect(again).toEqual(result);
  });

  test('a too-large picture is skipped and a refused one is a normal extraction failure', async () => {
    const cacheDir = join(temporaryDir(), 'media-cache');
    const input = { bytes: new Uint8Array(10), mimeType: 'image/png', sizeBytes: 10 };
    expect(await createImagePreparation({ cacheDir, commandRunner: fakeSips(), maxInputBytes: 5 })(input))
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

  test('the text lane indexes a prepared picture: a descriptor, any OCR text, and the copy as media', async () => {
    const cacheDir = join(temporaryDir(), 'media-cache');
    const extractor = createTextExtractor({
      imagePreparation: createImagePreparation({ cacheDir, commandRunner: fakeSips() }),
      imageOcr: async () => ({ status: 'indexed', text: 'OPEN HOUSE SUNDAY' }),
    });
    const output = await extractor.extract(extractorInput(new Uint8Array([9, 9, 9])));
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
    const plain = await quiet.extract(extractorInput(new Uint8Array([7])));
    expect(plain.status === 'indexed' ? plain.text : undefined).toBe(IMAGE_MEDIA_DESCRIPTOR);
  });

  test('without preparation (off macOS) an image is exactly as before', async () => {
    const extractor = createTextExtractor();
    expect(await extractor.extract(extractorInput(new Uint8Array([1])))).toEqual({ status: 'metadata_only' });
    const registry = createDefaultExtractorRegistry({
      media: { cacheDir: join(temporaryDir(), 'media-cache'), platform: 'linux' },
      ocr: { platform: 'linux' },
    });
    const text = registry.get('local_text')!;
    expect(await text.extract(extractorInput(new Uint8Array([1]), 'image/jpeg'))).toEqual({ status: 'metadata_only' });
  });

  test('the media cache lives under the Olympus data directory unless overridden', () => {
    expect(mediaCacheDir({ HOME: '/home/owner' })).toBe('/home/owner/.local/share/openclaw/olympus/media-cache');
    expect(mediaCacheDir({ XDG_DATA_HOME: '/data' })).toBe('/data/openclaw/olympus/media-cache');
    expect(mediaCacheDir({ OLYMPUS_MEDIA_CACHE_DIR: '/cache/media' })).toBe('/cache/media');
    expect(() => mediaCacheDir({ OLYMPUS_MEDIA_CACHE_DIR: 'relative' })).toThrow('absolute');
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

async function photoStore(dbPath = join(temporaryDir(), 'store.sqlite'), ids = ['photo-1']): Promise<LocalConnectorStore> {
  const store = new LocalConnectorStore({ dbPath, corpusId: CORPUS_ID, family: 'file', trustDomain: 'secure_local' });
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

function jpeg(seed: number): Uint8Array {
  return new Uint8Array([...JPEG_MAGIC, seed, seed + 1, seed + 2]);
}

class CapturingProvider extends DeterministicSourceEmbeddingProvider {
  readonly inputs: SourceEmbeddingInput[] = [];
  override async embed(inputs: SourceEmbeddingInput[], options: { taskType: SourceEmbeddingTaskType }): Promise<number[][]> {
    this.inputs.push(...inputs);
    return super.embed(inputs, options);
  }
}

describe('a prepared picture through runner, sink and store', () => {
  test('the runner hands the extractor\'s media to the sink with the text', async () => {
    const jobs = new LocalFileExtractionJobStore(':memory:');
    try {
      const media = { path: '/cache/abc.jpg', sha256: 'a'.repeat(64), mimeType: 'image/jpeg' as const };
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
            async fetch() { return { bytes: jpeg(1), mimeType: 'image/jpeg' }; },
          },
          sink: { async accept(sinkRequest) { accepted.push(sinkRequest); return { accepted: true, chunksIndexed: 1, chunksAwaitingEmbedding: 1 }; } },
        }],
      });
      const result = await runner.run({ corpusId: CORPUS_ID, provider: 'fake', accountScope: 'personal', approvedScopeKey: 'scope' });
      expect(result.counts.indexed).toBe(1);
      expect(accepted[0]!.media).toEqual(media);
    } finally {
      jobs.close();
    }
  });

  test('the store attaches the picture to the first chunk, and its digest is in the embedding input hash', async () => {
    const cacheDir = join(temporaryDir(), 'media-cache');
    const dbPath = join(temporaryDir(), 'store.sqlite');
    const textOnlyPath = join(temporaryDir(), 'text-only.sqlite');
    const store = await photoStore(dbPath);
    const textOnly = await photoStore(textOnlyPath);
    try {
      const media = writeMediaCacheFile(cacheDir, jpeg(1), 'image/jpeg');
      const result = await sinkFor(store).accept(request({ path: media.path, sha256: media.sha256, mimeType: 'image/jpeg' }));
      expect(result).toMatchObject({ accepted: true, chunksIndexed: 1, chunksAwaitingEmbedding: 1 });
      await sinkFor(textOnly).accept(request(undefined));
      const [withMedia] = chunkRows(dbPath);
      const [plain] = chunkRows(textOnlyPath);
      expect(withMedia).toMatchObject({ chunk_index: 0, media_path: media.path, media_sha256: media.sha256 });
      expect(plain).toMatchObject({ media_path: null, media_sha256: null });
      expect(withMedia!.embedding_input_hash).not.toBe(plain!.embedding_input_hash);

      // The same picture again is unchanged; a changed picture behind the
      // same text is a changed representation with a new input hash.
      const same = await sinkFor(store).accept(request({ path: media.path, sha256: media.sha256, mimeType: 'image/jpeg' }));
      expect(same.chunksAwaitingEmbedding).toBe(0);
      const changed = writeMediaCacheFile(cacheDir, jpeg(2), 'image/jpeg');
      await sinkFor(store).accept(request({ path: changed.path, sha256: changed.sha256, mimeType: 'image/jpeg' }));
      const [after] = chunkRows(dbPath);
      expect(after!.media_sha256).toBe(changed.sha256);
      expect(after!.embedding_input_hash).not.toBe(withMedia!.embedding_input_hash);
      // The replaced picture had no other holder: it is gone from the cache.
      expect(existsSync(media.path)).toBe(false);
      expect(existsSync(changed.path)).toBe(true);
    } finally {
      store.close();
      textOnly.close();
    }
  });

  test('the embed lane hands the picture to the provider, re-embeds a changed one, and skips a missing one', async () => {
    const cacheDir = join(temporaryDir(), 'media-cache');
    const store = await photoStore(undefined, ['photo-1', 'photo-2']);
    try {
      const first = writeMediaCacheFile(cacheDir, jpeg(1), 'image/jpeg');
      await sinkFor(store).accept(request({ path: first.path, sha256: first.sha256, mimeType: 'image/jpeg' }));
      await sinkFor(store).accept(request(undefined, 'A note about the kitchen', 'photo-2'));
      const provider = new CapturingProvider({ dimension: 8 });
      const summary = await store.embedChunks({ provider });
      expect(summary.chunksEmbedded).toBe(2);
      const withImage = provider.inputs.find((input) => input.image);
      expect(withImage?.image).toEqual({ path: first.path, sha256: first.sha256, mimeType: 'image/jpeg' });
      expect(withImage?.text.endsWith(IMAGE_MEDIA_DESCRIPTOR)).toBe(true);
      expect(provider.inputs.filter((input) => !input.image)).toHaveLength(1);

      const second = writeMediaCacheFile(cacheDir, jpeg(3), 'image/jpeg');
      await sinkFor(store).accept(request({ path: second.path, sha256: second.sha256, mimeType: 'image/jpeg' }));
      provider.inputs.length = 0;
      await store.embedChunks({ provider });
      expect(provider.inputs.map((input) => input.image?.sha256)).toEqual([second.sha256]);

      // A picture gone from the cache is not embedded as text alone.
      const third = writeMediaCacheFile(cacheDir, jpeg(5), 'image/jpeg');
      await sinkFor(store).accept(request({ path: third.path, sha256: third.sha256, mimeType: 'image/jpeg' }));
      rmSync(third.path);
      provider.inputs.length = 0;
      const skipped = await store.embedChunks({ provider });
      expect(provider.inputs).toHaveLength(0);
      expect(skipped.chunksEmbedded).toBe(0);
    } finally {
      store.close();
    }
  });

  test('a picture another store still references is kept when one store lets it go', async () => {
    const cacheDir = join(temporaryDir(), 'media-cache');
    const a = await photoStore(join(temporaryDir(), 'a.sqlite'));
    const b = await photoStore(join(temporaryDir(), 'b.sqlite'));
    try {
      const media = writeMediaCacheFile(cacheDir, jpeg(1), 'image/jpeg');
      const asMedia = { path: media.path, sha256: media.sha256, mimeType: 'image/jpeg' as const };
      await sinkFor(a).accept(request(asMedia));
      await sinkFor(b).accept(request(asMedia));
      await sinkFor(a).accept(request(undefined, 'Now just text'));
      expect(existsSync(media.path)).toBe(true);
      await sinkFor(b).accept(request(undefined, 'Now just text'));
      expect(existsSync(media.path)).toBe(false);
    } finally {
      a.close();
      b.close();
    }
  });

  test('a tier move\'s copy carries the picture to the other store', async () => {
    const cacheDir = join(temporaryDir(), 'media-cache');
    const from = await photoStore(join(temporaryDir(), 'from.sqlite'));
    const toPath = join(temporaryDir(), 'to.sqlite');
    const to = new LocalConnectorStore({ dbPath: toPath, corpusId: 'internal.fake.files', family: 'file', trustDomain: 'internal' });
    try {
      const media = writeMediaCacheFile(cacheDir, jpeg(1), 'image/jpeg');
      await sinkFor(from).accept(request({ path: media.path, sha256: media.sha256, mimeType: 'image/jpeg' }));
      const copy = from.exportItemCopy(photoItem().identity)!;
      expect(copy.chunks[0]).toMatchObject({ mediaPath: media.path, mediaSha256: media.sha256 });
      to.importItemCopy(copy, { trustTier: 'S3', syncConnectorId: 'tier-move' });
      expect(chunkRows(toPath)[0]).toMatchObject({ media_path: media.path, media_sha256: media.sha256 });
      // Both stores hold it now: the first letting go keeps the file.
      await sinkFor(from).accept(request(undefined, 'Now just text'));
      expect(existsSync(media.path)).toBe(true);
    } finally {
      from.close();
      to.close();
    }
  });

  test('an older store gains the media columns by an additive migration', async () => {
    const dbPath = join(temporaryDir(), 'old.sqlite');
    const seeded = await photoStore(dbPath);
    await sinkFor(seeded).accept(request(undefined, 'Text from before photos'));
    seeded.close();
    const db = new Database(dbPath);
    db.exec(`
      DROP TRIGGER connector_store_chunk_media_release;
      DROP TABLE chunk_media_releases;
      ALTER TABLE chunks DROP COLUMN media_path;
      ALTER TABLE chunks DROP COLUMN media_sha256;
      UPDATE schema_version SET version = 12 WHERE store_id = 'connector-store';
    `);
    db.close();
    const reopened = new LocalConnectorStore({ dbPath, corpusId: CORPUS_ID, family: 'file', trustDomain: 'secure_local' });
    reopened.close();
    const check = new Database(dbPath, { readonly: true });
    try {
      const version = check.query("SELECT version FROM schema_version WHERE store_id = 'connector-store'").get() as { version: number };
      expect(version.version).toBe(13);
      const columns = (check.query('PRAGMA table_info(chunks)').all() as Array<{ name: string }>).map((column) => column.name);
      expect(columns).toContain('media_path');
      expect(columns).toContain('media_sha256');
      const rows = check.query('SELECT bounded_text, media_sha256 FROM chunks').all() as Array<{ bounded_text: string; media_sha256: string | null }>;
      expect(rows).toEqual([{ bounded_text: 'Text from before photos', media_sha256: null }]);
    } finally {
      check.close();
    }
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
    const secret = classifyContentTier({ ...base, text: 'Photo\nAKIAIOSFODNN7EXAMPLE wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY', mimeType: 'image/jpeg' });
    expect(secret.contentTier).toBe('secrets');
  });
});

describe('coverage for a picture', () => {
  test('an image with a stored chunk is not an extraction gap; one without is', () => {
    expect(connectorStoreCoverageGaps({ storedChunks: 1, truncated: false, mimeType: 'image/jpeg' })).toEqual([]);
    expect(connectorStoreCoverageGaps({ storedChunks: 0, truncated: false, mimeType: 'image/jpeg' })[0]).toContain('image');
  });
});
