/**
 * The photo privacy judge (docs/design/photo-embeddings.md, owner decision
 * 2026-10-08): ordinary photos are Personal, only sensitive ones (intimate
 * images, identity documents, bank cards, financial or medical documents)
 * are Private, and a photo that cannot be judged stays Private.
 *
 * Stub vectors everywhere except the opt-in real test:
 * `OLYMPUS_PHOTO_JUDGE_REAL_TEST=1` with `OLYMPUS_PHOTO_JUDGE_SENSITIVE` and
 * `OLYMPUS_PHOTO_JUDGE_ORDINARY` naming two local pictures (a specimen
 * identity document and an ordinary photo) runs the real EmbeddingGemma 2
 * (OLYMPUS_BUILT_IN_EMBEDDING_DIR, or a download into a temporary directory;
 * macOS, for `sips`).
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RawItem, SourceConnector, SourceConnectorListPage } from '../src/core/contracts.ts';
import { MEDIA_CACHE_DIR_ENV, mediaCacheDir, releaseMediaCacheFile, writeMediaCacheFile } from '../src/core/media-cache.ts';
import { buildSourceSensitivity, type SourceTrustDomain } from '../src/core/source-index/types.ts';
import { SecretLocationsIndex } from '../src/workers/classification/secret-locations.ts';
import {
  classifyContentTier,
  IMAGE_ORDINARY_REASON,
  IMAGE_PRIVATE_DEFAULT_REASON,
  IMAGE_SENSITIVE_REASON_PREFIX,
} from '../src/workers/classification/tier-classifier.ts';
import { TierLedger } from '../src/workers/classification/tier-ledger.ts';
import { LocalConnectorStore } from '../src/workers/connector-store/index.ts';
import { sweepImageContentToPrivate } from '../src/workers/connector-store/tier-image-content-sweep.ts';
import { applyMediaJudgments } from '../src/workers/connector-store/tier-media-judgment-sweep.ts';
import { moveTieredItem } from '../src/workers/connector-store/tier-move.ts';
import { createTieredLaneSet, onDemandTierStore, tieredStoreSetLedgerPath, type TieredStoreSet } from '../src/workers/connector-store/tiered-store-set.ts';
import { IMAGE_MEDIA_DESCRIPTOR } from '../src/workers/file-extraction/extractors/text.ts';
import { createImagePreparation } from '../src/workers/file-extraction/extractors/image-prepare.ts';
import { EXTRACTION_SINK_SKIPPED_IMAGE_PRIVATE_ONLY, createConnectorStoreExtractionSink } from '../src/workers/file-extraction/store-sink.ts';
import { createTieredStoreExtractionSink } from '../src/workers/file-extraction/tiered-store-sink.ts';
import type { ExtractionSink, ExtractionSinkRequest } from '../src/workers/file-extraction/types.ts';
import { BuiltInSourceEmbeddingProvider } from '../src/workers/source-index/built-in-embedding/provider.ts';
import {
  DeterministicSourceEmbeddingProvider,
  SourceEmbeddingInputsFailedError,
  memoizeQueryEmbeddings,
  type SourceEmbeddingImageInput,
  type SourceEmbeddingInput,
  type SourceEmbeddingTaskType,
} from '../src/workers/source-index/embeddings.ts';
import {
  MEDIA_JUDGE_PROMPT_PREFIX,
  MEDIA_JUDGE_PROMPTS,
  MEDIA_JUDGE_THRESHOLDS,
  judgeImageVector,
  judgeMediaImages,
  judgeMediaScores,
  resetMediaJudgePromptVectors,
  type MediaJudgeCategory,
  type MediaJudgment,
} from '../src/workers/source-index/media-judge.ts';

const temporaryDirs: string[] = [];
function temporaryDir(prefix = 'olympus-photo-judge-'): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  temporaryDirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of temporaryDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  resetMediaJudgePromptVectors();
});

// Stores only trust a picture path inside the configured media cache.
const CACHE_BASE = mkdtempSync(join(tmpdir(), 'olympus-photo-judge-cache-'));
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

const CATEGORIES = Object.keys(MEDIA_JUDGE_PROMPTS) as MediaJudgeCategory[];
const DIMENSION = 8;

/** Scores for every category: ordinary at `ordinary`, every sensitive one at `base`, with overrides. */
function scores(ordinary: number, overrides: Partial<Record<MediaJudgeCategory, number>> = {}, base = ordinary - 0.05) {
  return Object.fromEntries(CATEGORIES.map((category) => [category, category === 'ordinary' ? ordinary : overrides[category] ?? base])) as Record<MediaJudgeCategory, number>;
}

/** An image vector whose dot product with category k's basis prompt vector is that category's score. */
function vectorFor(categoryScores: Record<MediaJudgeCategory, number>): number[] {
  const vector = new Array<number>(DIMENSION).fill(0);
  CATEGORIES.forEach((category, index) => {
    vector[index] = categoryScores[category];
  });
  return vector;
}

const basisPrompts = Object.fromEntries(CATEGORIES.map((category, index) => {
  const vector = new Array<number>(DIMENSION).fill(0);
  vector[index] = 1;
  return [category, vector];
})) as Record<MediaJudgeCategory, number[]>;

const ORDINARY = scores(0.62);
const PASSPORT = scores(0.6, { id_document: 0.7 });
const BEACH = scores(0.6, { intimate: 0.625 });

/**
 * A picture-reading provider with the judge's methods: each picture's
 * image-only vector comes from `images` (by digest; ordinary otherwise), and
 * the descriptions embed to one basis vector per category.
 */
class JudgingProvider extends DeterministicSourceEmbeddingProvider {
  readonly calls = { combined: 0, imagesAlone: 0, prompts: 0, embed: 0 };
  vision = true;

  constructor(readonly images = new Map<string, Record<MediaJudgeCategory, number>>(), readonly unreadable = new Set<string>()) {
    super({ dimension: DIMENSION });
  }

  async imageSupport(): Promise<boolean> {
    return this.vision;
  }

  override async embed(inputs: SourceEmbeddingInput[], options: { taskType: SourceEmbeddingTaskType }): Promise<number[][]> {
    this.calls.embed += 1;
    return super.embed(inputs, options);
  }

  async embedWithImageVectors(inputs: SourceEmbeddingInput[]) {
    this.calls.combined += 1;
    const vectors = await super.embed(inputs, { taskType: 'RETRIEVAL_DOCUMENT' });
    return { vectors, imageVectors: inputs.map((input) => (input.image ? this.imageVector(input.image) : undefined)) };
  }

  async embedImageVectors(images: SourceEmbeddingImageInput[]): Promise<Array<number[] | undefined>> {
    this.calls.imagesAlone += 1;
    if (!this.vision) throw new SourceEmbeddingInputsFailedError(images.map((_, index) => index), 'image_encoder_unavailable', 'held');
    return images.map((image) => this.imageVector(image));
  }

  async embedPromptTexts(texts: string[]): Promise<number[][]> {
    this.calls.prompts += 1;
    return texts.map((text) => {
      const category = CATEGORIES.find((candidate) => text === `${MEDIA_JUDGE_PROMPT_PREFIX}${MEDIA_JUDGE_PROMPTS[candidate]}`);
      if (!category) throw new Error(`unexpected prompt ${text}`);
      return basisPrompts[category];
    });
  }

  private imageVector(image: SourceEmbeddingImageInput): number[] | undefined {
    if (this.unreadable.has(image.sha256)) return undefined;
    return vectorFor(this.images.get(image.sha256) ?? ORDINARY);
  }
}

/** A picture-reading provider with no judge (the photo-embeddings build): pictures stay unjudged. */
class PictureOnlyProvider extends DeterministicSourceEmbeddingProvider {
  constructor() {
    super({ dimension: DIMENSION });
  }

  async imageSupport(): Promise<boolean> {
    return true;
  }
}

let seed = 0;
function picture(): { path: string; sha256: string; mimeType: 'image/jpeg'; stagingHolder: string } {
  seed += 1;
  const written = writeMediaCacheFile(cache(), new Uint8Array([0xff, 0xd8, 0xff, 0xe0, seed & 0xff, (seed >> 8) & 0xff, 9, 9]), 'image/jpeg');
  return { path: written.path, sha256: written.sha256, mimeType: 'image/jpeg', stagingHolder: written.stagingHolder };
}

function judgment(verdict: MediaJudgment['verdict'], category?: MediaJudgment['category']): MediaJudgment {
  return { verdict, ...(category ? { category } : {}), judgeId: 'test-judge' };
}

describe('the judge: thresholds and categories', () => {
  test('the closest sensitive description must beat the ordinary one by the margin', () => {
    const passport = judgeMediaScores(PASSPORT, 'j');
    expect(passport).toMatchObject({ verdict: 'sensitive', category: 'id_document', margin: 0.1 });
    for (const category of ['bank_card', 'financial_document', 'medical_document'] as const) {
      expect(judgeMediaScores(scores(0.6, { [category]: 0.6 + MEDIA_JUDGE_THRESHOLDS.margin }), 'j')).toMatchObject({ verdict: 'sensitive', category });
    }
    // Just under the margin, with intimate far below: ordinary.
    const close = judgeMediaScores(scores(0.6, { medical_document: 0.639, intimate: 0.5 }), 'j');
    expect(close).toMatchObject({ verdict: 'ordinary', category: 'medical_document', margin: 0.039 });
    expect(judgeMediaScores(ORDINARY, 'j').verdict).toBe('ordinary');
  });

  test('intimate is judged more cautiously: half the margin is enough', () => {
    expect(MEDIA_JUDGE_THRESHOLDS.intimateMargin).toBeLessThan(MEDIA_JUDGE_THRESHOLDS.margin);
    expect(judgeMediaScores(BEACH, 'j')).toMatchObject({ verdict: 'sensitive', category: 'intimate' });
    expect(judgeMediaScores(scores(0.6, { intimate: 0.619 }), 'j').verdict).toBe('ordinary');
  });

  test('a picture with no vector, or scores that are not numbers, is unjudged', () => {
    expect(judgeImageVector(undefined, basisPrompts, 'j')).toMatchObject({ verdict: 'unjudged', reason: 'image_unreadable' });
    expect(judgeImageVector([], basisPrompts, 'j').verdict).toBe('unjudged');
    expect(judgeImageVector(new Array(8).fill(0), basisPrompts, 'j').verdict).toBe('unjudged');
    expect(judgeMediaScores({ ...ORDINARY, intimate: Number.NaN }, 'j').verdict).toBe('unjudged');
    const { ordinary: _omitted, ...noOrdinary } = ORDINARY;
    expect(judgeMediaScores(noOrdinary, 'j').verdict).toBe('unjudged');
  });

  test('description vectors are made once per model, through any wrapper', async () => {
    const provider = new JudgingProvider(new Map());
    const wrapped = memoizeQueryEmbeddings(provider);
    const first = picture();
    const judged = await judgeMediaImages(wrapped as Parameters<typeof judgeMediaImages>[0], [first, picture()]);
    await judgeMediaImages(wrapped as Parameters<typeof judgeMediaImages>[0], [first]);
    expect(judged.map((entry) => entry.verdict)).toEqual(['ordinary', 'ordinary']);
    expect(provider.calls.prompts).toBe(1);
    expect(judged[0]!.judgeId).toContain(provider.modelId);
  });
});

describe('the tier a judged photo gets', () => {
  const base = { metadataTier: 'private' as const, metadataForced: false, metadataFlagged: false, mimeType: 'image/jpeg' };

  test('unjudged stays Private; sensitive is Private with its category; ordinary is Personal', () => {
    const unjudged = classifyContentTier({ ...base, text: 'Photo' });
    expect(unjudged).toMatchObject({ contentTier: 'secure', reasons: [IMAGE_PRIVATE_DEFAULT_REASON] });
    expect(classifyContentTier({ ...base, text: 'Photo', imageJudgment: { verdict: 'unjudged' } }).contentTier).toBe('secure');
    const sensitive = classifyContentTier({ ...base, text: 'Photo', imageJudgment: { verdict: 'sensitive', category: 'id_document' } });
    expect(sensitive).toMatchObject({ contentTier: 'secure', reasons: [`${IMAGE_SENSITIVE_REASON_PREFIX}id_document`] });
    const ordinary = classifyContentTier({ ...base, text: 'Photo', imageJudgment: { verdict: 'ordinary' } });
    expect(ordinary.contentTier).toBe('private');
    expect(ordinary.reasons).toContain(IMAGE_ORDINARY_REASON);
  });

  test('an account or card number read off an ordinary picture still makes it Private', () => {
    const card = classifyContentTier({ ...base, text: 'Photo\nCard 4111 1111 1111 1111 exp 09/29', imageJudgment: { verdict: 'ordinary' } });
    expect(card.contentTier).toBe('secure');
    const iban = classifyContentTier({ ...base, text: 'Photo\nIBAN GB82 WEST 1234 5698 7654 32', imageJudgment: { verdict: 'ordinary' } });
    expect(iban.contentTier).toBe('secure');
  });

  test('the owner\'s per-item override wins over any verdict', () => {
    expect(classifyContentTier(
      { ...base, text: 'Photo', imageJudgment: { verdict: 'sensitive', category: 'intimate' } },
      { override: { kind: 'tier', tier: 'private' } },
    ).contentTier).toBe('private');
    expect(classifyContentTier(
      { ...base, text: 'Photo', imageJudgment: { verdict: 'ordinary' } },
      { override: { kind: 'tier', tier: 'secure' } },
    ).contentTier).toBe('secure');
  });
});

const CORPUS = (domain: SourceTrustDomain) => `${domain}.judge.files`;

function photoItem(id: string): RawItem {
  return {
    identity: { family: 'file', provider: 'judge', accountScope: 'personal', providerItemId: id, localItemId: `personal:${id}`, sourceVersion: 'v1' },
    mimeType: 'image/jpeg',
    content: { kind: 'metadata_only' },
    metadata: Object.freeze({ name: `${id}.jpg`, title: `${id}.jpg`, pathDisplay: `/Photos/${id}.jpg` }),
    fetchedAt: '2026-10-08T00:00:00.000Z',
  };
}

function connectorFor(ids: readonly string[]): SourceConnector {
  return {
    id: 'judge_lane',
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

function request(id: string, media: ReturnType<typeof picture> | undefined, text = IMAGE_MEDIA_DESCRIPTOR, domain: SourceTrustDomain = 'secure_local'): ExtractionSinkRequest {
  return {
    ref: {
      corpusId: CORPUS(domain),
      provider: 'judge',
      accountScope: 'personal',
      approvedScopeKey: 'judge.personal:/',
      providerItemId: id,
      localItemId: `personal:${id}`,
      sourceVersion: 'v1',
      name: `${id}.jpg`,
      mimeType: 'image/jpeg',
    },
    text,
    extractorKind: 'local_text',
    extractorVersion: 'test',
    fetchedAt: '2026-10-08T01:00:00.000Z',
    ...(media ? { media: { path: media.path, sha256: media.sha256, mimeType: media.mimeType } } : {}),
  };
}

function chunkMedia(dbPath: string): Array<{ media_sha256: string | null }> {
  const db = new Database(dbPath, { readonly: true });
  try {
    return db.query('SELECT media_sha256 FROM chunks ORDER BY chunk_pk').all() as Array<{ media_sha256: string | null }>;
  } finally {
    db.close();
  }
}

function judgmentRows(dbPath: string): Array<{ media_sha256: string; verdict: string; category: string | null; tier_applied: number }> {
  const db = new Database(dbPath, { readonly: true });
  try {
    return db.query('SELECT media_sha256, verdict, category, tier_applied FROM media_judgments ORDER BY media_sha256').all() as Array<{
      media_sha256: string; verdict: string; category: string | null; tier_applied: number;
    }>;
  } finally {
    db.close();
  }
}

function vectorCount(dbPath: string): number {
  const db = new Database(dbPath, { readonly: true });
  try {
    return (db.query('SELECT COUNT(*) AS count FROM chunk_embeddings').get() as { count: number }).count;
  } finally {
    db.close();
  }
}

async function plainStore(domain: SourceTrustDomain, ids: readonly string[]): Promise<{ store: LocalConnectorStore; dbPath: string }> {
  const dbPath = join(temporaryDir(), `${domain}.sqlite`);
  const store = new LocalConnectorStore({ dbPath, corpusId: CORPUS(domain), family: 'file', trustDomain: domain });
  await store.syncFromConnector(connectorFor(ids), { fetchContent: false });
  return { store, dbPath };
}

function plainSink(store: LocalConnectorStore, lookup?: (sha: string) => MediaJudgment | undefined) {
  return createConnectorStoreExtractionSink({
    store,
    classify: () => buildSourceSensitivity({
      trustTier: store.trustDomain === 'secure_local' ? 'S4' : 'S3',
      trustDomain: store.trustDomain,
    }),
    syncConnectorId: 'extraction',
    ownerConnectorId: 'judge-connector',
    ownershipKind: 'observed',
    ...(lookup ? { mediaJudgment: lookup } : {}),
  });
}

describe('where a judged picture may rest', () => {
  test('a Personal store refuses an unjudged or sensitive picture, and takes an ordinary one with its picture', async () => {
    const { store, dbPath } = await plainStore('internal', ['a', 'b', 'c']);
    try {
      const unjudged = picture();
      const sensitive = picture();
      const ordinary = picture();
      const verdicts = new Map([[sensitive.sha256, judgment('sensitive', 'id_document')], [ordinary.sha256, judgment('ordinary')]]);
      const sink = plainSink(store, (sha) => verdicts.get(sha));
      expect((await sink.accept(request('a', unjudged, IMAGE_MEDIA_DESCRIPTOR, 'internal'))).skippedReason).toBe(EXTRACTION_SINK_SKIPPED_IMAGE_PRIVATE_ONLY);
      expect((await sink.accept(request('b', sensitive, IMAGE_MEDIA_DESCRIPTOR, 'internal'))).skippedReason).toBe(EXTRACTION_SINK_SKIPPED_IMAGE_PRIVATE_ONLY);
      // Text read off a picture with no picture to judge is unjudged too.
      expect((await sink.accept(request('a', undefined, 'Photo\nOPEN HOUSE', 'internal'))).skippedReason).toBe(EXTRACTION_SINK_SKIPPED_IMAGE_PRIVATE_ONLY);
      expect((await sink.accept(request('c', ordinary, IMAGE_MEDIA_DESCRIPTOR, 'internal'))).accepted).toBe(true);
      for (const media of [unjudged, sensitive, ordinary]) releaseMediaCacheFile(media.path, media.sha256, media.stagingHolder);
      expect(chunkMedia(dbPath)).toEqual([{ media_sha256: ordinary.sha256 }]);
      // Unapplied: the sweep re-decides every item carrying this picture.
      expect(judgmentRows(dbPath)).toEqual([expect.objectContaining({ media_sha256: ordinary.sha256, verdict: 'ordinary', tier_applied: 0 })]);
      // The store holds the file for the Personal copy; the refused ones are gone.
      expect(existsSync(ordinary.path)).toBe(true);
      expect(existsSync(unjudged.path)).toBe(false);
      expect(existsSync(sensitive.path)).toBe(false);
      // The store itself refuses a picture with no ordinary verdict, whichever path writes it.
      expect(() => store.restoreItemRepresentations({
        items: [{
          item: { ...photoItem('a'), content: { kind: 'text', text: IMAGE_MEDIA_DESCRIPTOR } },
          expectation: {
            sourceItem: photoItem('a').identity,
            sourceVersion: 'v1',
            contentHash: 'x',
            chunkContentHashes: ['y'],
            mediaSha256: unjudged.sha256,
          },
          media: { path: unjudged.path, sha256: unjudged.sha256 },
        }],
        classify: () => buildSourceSensitivity({ trustTier: 'S3', trustDomain: 'internal' }),
        syncConnectorId: 'extraction',
        ownerConnectorId: 'judge-connector',
        ownershipKind: 'observed',
      })).toThrow();
    } finally {
      store.close();
    }
  });

  test('a copy keeps an ordinary picture (and its vector input) in a Personal store, and drops an unjudged one', async () => {
    const { store: secure } = await plainStore('secure_local', ['a', 'b']);
    const personalPath = join(temporaryDir(), 'personal.sqlite');
    const personal = new LocalConnectorStore({ dbPath: personalPath, corpusId: CORPUS('internal'), family: 'file', trustDomain: 'internal' });
    try {
      const ordinary = picture();
      const unjudged = picture();
      await plainSink(secure).accept(request('a', ordinary));
      await plainSink(secure).accept(request('b', unjudged));
      for (const media of [ordinary, unjudged]) releaseMediaCacheFile(media.path, media.sha256, media.stagingHolder);
      const provider = new JudgingProvider(new Map(), new Set([unjudged.sha256]));
      await secure.embedChunks({ provider });
      expect(secure.mediaJudgment(ordinary.sha256)?.verdict).toBe('ordinary');
      expect(secure.mediaJudgment(unjudged.sha256)?.verdict).toBe('unjudged');
      const a = secure.exportItemCopy(photoItem('a').identity)!;
      const b = secure.exportItemCopy(photoItem('b').identity)!;
      expect(a.chunks[0]!.mediaJudgment?.verdict).toBe('ordinary');
      personal.importItemCopy(a, { trustTier: 'S3', syncConnectorId: 'tier-move' });
      personal.importItemCopy(b, { trustTier: 'S3', syncConnectorId: 'tier-move' });
      expect(chunkMedia(personalPath)).toEqual([{ media_sha256: ordinary.sha256 }, { media_sha256: null }]);
      expect(personal.mediaJudgment(ordinary.sha256)?.verdict).toBe('ordinary');
      expect(personal.exportItemCopy(photoItem('a').identity)!.chunks[0]!.embeddingInputHash).toBe(a.chunks[0]!.embeddingInputHash);
      // Nothing for the Personal store's tier set to re-decide: the verdict was applied where it was made.
      expect(personal.unappliedMediaJudgments()).toEqual([]);
      // Released by the Private store, the file stays for the Personal copy.
      secure.stripCopyContent(photoItem('a').identity);
      expect(existsSync(ordinary.path)).toBe(true);
    } finally {
      secure.close();
      personal.close();
    }
  });
});

describe('the judge in the embed pass', () => {
  test('a new photo is judged in the same model call as its embedding', async () => {
    const { store, dbPath } = await plainStore('secure_local', ['a', 'b']);
    try {
      const passport = picture();
      const kitchen = picture();
      await plainSink(store).accept(request('a', passport));
      await plainSink(store).accept(request('b', kitchen));
      const provider = new JudgingProvider(new Map([[passport.sha256, PASSPORT]]));
      expect((await store.embedChunks({ provider })).chunksEmbedded).toBe(2);
      expect(provider.calls).toMatchObject({ combined: 1, imagesAlone: 0, embed: 0 });
      const rows = judgmentRows(dbPath);
      expect(rows).toHaveLength(2);
      expect(rows.find((row) => row.media_sha256 === passport.sha256)).toMatchObject({ verdict: 'sensitive', category: 'id_document', tier_applied: 0 });
      expect(rows.find((row) => row.media_sha256 === kitchen.sha256)).toMatchObject({ verdict: 'ordinary', tier_applied: 0 });
      // Judged once: a later pass asks nothing.
      await store.embedChunks({ provider });
      expect(provider.calls).toMatchObject({ combined: 1, imagesAlone: 0 });
    } finally {
      store.close();
    }
  });

  test('a photo embedded before the judge existed is judged once, from its picture alone', async () => {
    const { store, dbPath } = await plainStore('secure_local', ['a']);
    try {
      const card = picture();
      await plainSink(store).accept(request('a', card));
      await store.embedChunks({ provider: new PictureOnlyProvider() });
      expect(judgmentRows(dbPath)).toEqual([]);
      const provider = new JudgingProvider(new Map([[card.sha256, scores(0.6, { bank_card: 0.7 })]]));
      await store.embedChunks({ provider });
      expect(provider.calls).toMatchObject({ combined: 0, imagesAlone: 1 });
      expect(judgmentRows(dbPath)).toEqual([expect.objectContaining({ verdict: 'sensitive', category: 'bank_card' })]);
      await store.embedChunks({ provider });
      expect(provider.calls.imagesAlone).toBe(1);
    } finally {
      store.close();
    }
  });

  test('a judgment made by an older judge is stale: the picture is judged again and the new verdict applied', async () => {
    const { store, dbPath } = await plainStore('secure_local', ['a']);
    try {
      const card = picture();
      await plainSink(store).accept(request('a', card));
      const provider = new JudgingProvider(new Map([[card.sha256, scores(0.6, { bank_card: 0.7 })]]));
      await store.embedChunks({ provider });
      const db = new Database(dbPath);
      try {
        // As if an earlier judge had found it ordinary and that had been applied.
        db.query("UPDATE media_judgments SET judge_id = 'photo-judge-older', verdict = 'ordinary', category = NULL, tier_applied = 1").run();
      } finally {
        db.close();
      }
      const before = provider.calls.imagesAlone;
      await store.embedChunks({ provider });
      expect(provider.calls.imagesAlone).toBe(before + 1);
      expect(judgmentRows(dbPath)).toEqual([expect.objectContaining({ verdict: 'sensitive', category: 'bank_card', tier_applied: 0 })]);
    } finally {
      store.close();
    }
  });

  test('without the image encoder, or with a model that cannot judge, a photo stays unjudged', async () => {
    const { store, dbPath } = await plainStore('secure_local', ['a']);
    try {
      const photo = picture();
      await plainSink(store).accept(request('a', photo));
      const provider = new JudgingProvider();
      provider.vision = false;
      await store.embedChunks({ provider });
      expect(judgmentRows(dbPath)).toEqual([]);
      await store.embedChunks({ provider: new DeterministicSourceEmbeddingProvider({ modelId: 'text-only', dimension: DIMENSION }) });
      expect(judgmentRows(dbPath)).toEqual([]);
      expect(store.imageJudgmentForItem(photoItem('a').identity)).toBeUndefined();
    } finally {
      store.close();
    }
  });
});

interface Lane {
  set: TieredStoreSet;
  ledger: TierLedger;
  stores: Partial<Record<SourceTrustDomain, LocalConnectorStore>>;
  paths: Record<SourceTrustDomain, string>;
  sink: ExtractionSink;
  close(): void;
}

/** A lane whose text arrives after listing, over per-tier stores (as the Dropbox files lane runs). */
function openLane(dir: string): Lane {
  const paths: Record<SourceTrustDomain, string> = {
    public_safe: join(dir, 'public.sqlite'),
    internal: join(dir, 'internal.sqlite'),
    secure_local: join(dir, 'secure.sqlite'),
  };
  const ledger = new TierLedger({ dbPath: tieredStoreSetLedgerPath(paths.secure_local) });
  const secrets = new SecretLocationsIndex({ dbPath: join(dir, 'secret-locations.sqlite') });
  const stores: Partial<Record<SourceTrustDomain, LocalConnectorStore>> = {
    secure_local: new LocalConnectorStore({ dbPath: paths.secure_local, corpusId: CORPUS('secure_local'), family: 'file', trustDomain: 'secure_local', tierLedger: ledger }),
  };
  const onDemand = (domain: SourceTrustDomain) => onDemandTierStore({
    corpusId: CORPUS(domain),
    dbPath: paths[domain]!,
    create: () => {
      const store = new LocalConnectorStore({ dbPath: paths[domain]!, corpusId: CORPUS(domain), family: 'file', trustDomain: domain, tierLedger: ledger });
      stores[domain] = store;
      return store;
    },
  });
  const set = createTieredLaneSet({
    setId: 'judge.files.personal',
    ledger,
    secretLocations: secrets,
    contentArrivesLater: true,
    legs: {
      public_safe: { onDemand: onDemand('public_safe') },
      internal: { onDemand: onDemand('internal') },
      secure_local: { store: stores.secure_local!, legacy: true },
    },
  });
  const sink = createTieredStoreExtractionSink({ set, syncConnectorId: 'extraction', ownerConnectorId: 'judge-connector', ownershipKind: 'observed' });
  return {
    set,
    ledger,
    stores,
    paths,
    sink,
    close() {
      for (const store of Object.values(stores)) store?.close();
      secrets.close();
      ledger.close();
    },
  };
}

const identity = (id: string) => ({ provider: 'judge', accountScope: 'personal', providerItemId: id });

describe('the judge decides a photo\'s tier through the tier set', () => {
  test('photos land Private unjudged; once judged, ordinary ones move to Personal with picture and vector, sensitive ones stay', async () => {
    const lane = openLane(temporaryDir());
    try {
      const ids = ['kitchen', 'img-0002', 'img-0003', 'img-0004', 'img-0005'];
      await lane.set.sync(connectorFor(ids), { fetchContent: false, placement: () => buildSourceSensitivity({ trustTier: 'S4', trustDomain: 'secure_local' }) });
      const media = Object.fromEntries(ids.map((id) => [id, picture()]));
      lane.ledger.setOverride(identity('img-0005'), { kind: 'tier', tier: 'secure' });
      for (const id of ids.filter((entry) => entry !== 'img-0004')) {
        const accepted = await lane.sink.accept(request(id, media[id]!));
        expect(accepted.accepted).toBe(true);
      }
      // OCR text with an account number, on an otherwise ordinary picture.
      expect((await lane.sink.accept(request('img-0004', media['img-0004']!, `${IMAGE_MEDIA_DESCRIPTOR}\nIBAN GB82 WEST 1234 5698 7654 32`))).accepted).toBe(true);
      for (const entry of Object.values(media)) releaseMediaCacheFile(entry.path, entry.sha256, entry.stagingHolder);

      // Unjudged: content in the Private store only, names Personal.
      expect(lane.ledger.getCurrent(identity('kitchen'))).toMatchObject({ contentTier: 'secure', metadataTier: 'private' });
      expect(lane.ledger.getCurrent(identity('kitchen'))!.reasons).toContain(IMAGE_PRIVATE_DEFAULT_REASON);
      expect(chunkMedia(lane.paths.internal)).toEqual([]);

      // Nothing judged yet: the sweep changes nothing.
      expect(applyMediaJudgments({ set: lane.set })).toMatchObject({ applied: 0, movesQueued: 0 });

      const provider = new JudgingProvider(new Map([
        [media['img-0002']!.sha256, PASSPORT],
        [media['img-0003']!.sha256, BEACH],
        [media['img-0005']!.sha256, ORDINARY],
      ]));
      await lane.stores.secure_local!.embedChunks({ provider });
      const report = applyMediaJudgments({ set: lane.set });
      expect(report).toMatchObject({ applied: 5, movesQueued: 1 });
      // Applied once.
      expect(applyMediaJudgments({ set: lane.set })).toMatchObject({ applied: 0, seen: 0 });

      expect(lane.ledger.getCurrent(identity('img-0002'))).toMatchObject({ contentTier: 'secure', state: 'current' });
      expect(lane.ledger.getCurrent(identity('img-0002'))!.reasons).toContain(`${IMAGE_SENSITIVE_REASON_PREFIX}id_document`);
      expect(lane.ledger.getCurrent(identity('img-0003'))!.reasons).toContain(`${IMAGE_SENSITIVE_REASON_PREFIX}intimate`);
      // The account number read off the picture wins over the ordinary verdict.
      expect(lane.ledger.getCurrent(identity('img-0004'))).toMatchObject({ contentTier: 'secure', state: 'current' });
      // The owner's override wins.
      expect(lane.ledger.getCurrent(identity('img-0005'))).toMatchObject({ contentTier: 'secure', state: 'current' });

      const kitchen = lane.ledger.getCurrent(identity('kitchen'))!;
      expect(kitchen).toMatchObject({ state: 'moving', targetContentTier: 'private' });
      const exported = lane.stores.secure_local!.exportItemCopy(identity('kitchen'))!;
      const moved = await moveTieredItem({
        set: lane.set,
        identity: { ...identity('kitchen'), family: 'file', localItemId: 'personal:kitchen' },
        target: { metadataTier: kitchen.targetMetadataTier!, contentTier: kitchen.targetContentTier! },
        vectorIdentities: { internal: provider },
        replaceOwnSupersededCopy: true,
      });
      expect(moved.destinations).toEqual([expect.objectContaining({ trustDomain: 'internal', vectorsCopied: 1, chunksToEmbed: 0 })]);
      expect(lane.ledger.getCurrent(identity('kitchen'))).toMatchObject({ contentTier: 'private', state: 'current' });
      expect(lane.ledger.copies(identity('kitchen')).filter((copy) => copy.state === 'current')).toEqual([
        expect.objectContaining({ corpusId: CORPUS('internal'), layers: 'both' }),
      ]);
      expect(chunkMedia(lane.paths.internal)).toEqual([{ media_sha256: exported.chunks[0]!.mediaSha256! }]);
      expect(vectorCount(lane.paths.internal)).toBe(1);
      // No sensitive or unjudged picture reached the Personal store.
      const personalShas = chunkMedia(lane.paths.internal).map((row) => row.media_sha256);
      for (const id of ['img-0002', 'img-0003', 'img-0004', 'img-0005']) expect(personalShas).not.toContain(media[id]!.sha256);
      // Its search result carries text only: no path, no bytes.
      const hit = lane.stores.internal!.searchItems('kitchen', 5)[0];
      expect(hit).toBeDefined();
      expect(JSON.stringify(hit)).not.toContain(exported.chunks[0]!.mediaPath!);

      // The one-time sweep of #175 leaves an ordinary photo where it is.
      lane.ledger.writeMeta('image_content_private_sweep', '');
      expect(sweepImageContentToPrivate({ set: lane.set }).raised).toBe(0);
      expect(lane.stores.internal!.stripImageContentOutsidePrivate({ keep: () => false })).toBe(0);
      expect(chunkMedia(lane.paths.internal)).toHaveLength(1);

      // Read again (the same picture): it lands in the Personal store, judged.
      const again = picture();
      const sameBytes = readFileSync(exported.chunks[0]!.mediaPath!);
      const rewritten = writeMediaCacheFile(cache(), sameBytes, 'image/jpeg');
      releaseMediaCacheFile(again.path, again.sha256, again.stagingHolder);
      const relanded = await lane.sink.accept(request('kitchen', { ...rewritten, mimeType: 'image/jpeg' }, `${IMAGE_MEDIA_DESCRIPTOR}\nFRIDGE`));
      releaseMediaCacheFile(rewritten.path, rewritten.sha256, rewritten.stagingHolder);
      expect(relanded.accepted).toBe(true);
      expect(lane.ledger.getCurrent(identity('kitchen'))).toMatchObject({ contentTier: 'private', state: 'current' });
      expect(lane.stores.internal!.searchItems('FRIDGE', 5).map((row) => row.sourceItem.providerItemId)).toEqual(['kitchen']);

      // A newer judge finds the current Personal copy sensitive; the superseded
      // Private copy still holds its old ordinary verdict. The sensitive one wins.
      const personalDb = new Database(lane.paths.internal);
      try {
        personalDb.query("UPDATE media_judgments SET verdict = 'sensitive', category = 'id_document', judge_id = 'photo-judge-newer'").run();
      } finally {
        personalDb.close();
      }
      const third = writeMediaCacheFile(cache(), sameBytes, 'image/jpeg');
      const rejudged = await lane.sink.accept(request('kitchen', { ...third, mimeType: 'image/jpeg' }, `${IMAGE_MEDIA_DESCRIPTOR}\nFRIDGE`));
      releaseMediaCacheFile(third.path, third.sha256, third.stagingHolder);
      expect(rejudged.accepted).toBe(false);
      expect(lane.ledger.getCurrent(identity('kitchen'))).toMatchObject({ state: 'moving', targetContentTier: 'secure' });
    } finally {
      lane.close();
    }
  });
});

const realTest = process.env.OLYMPUS_PHOTO_JUDGE_REAL_TEST === '1' ? test : test.skip;

describe('the judge with the real model (opt-in)', () => {
  realTest('judges a specimen identity document as sensitive and an ordinary photo as ordinary', async () => {
    const sensitivePath = process.env.OLYMPUS_PHOTO_JUDGE_SENSITIVE;
    const ordinaryPath = process.env.OLYMPUS_PHOTO_JUDGE_ORDINARY;
    if (!sensitivePath || !ordinaryPath) throw new Error('Set OLYMPUS_PHOTO_JUDGE_SENSITIVE and OLYMPUS_PHOTO_JUDGE_ORDINARY to two local pictures.');
    const env = {
      ...process.env,
      OLYMPUS_BUILT_IN_EMBEDDING_DIR: process.env.OLYMPUS_BUILT_IN_EMBEDDING_DIR || temporaryDir(),
      [MEDIA_CACHE_DIR_ENV]: CACHE_BASE,
    };
    const prepare = createImagePreparation({ cacheDir: cache() });
    const provider = new BuiltInSourceEmbeddingProvider({ env });
    await provider.prepare();
    expect(await provider.imageSupport()).toBe(true);
    const images: SourceEmbeddingImageInput[] = [];
    for (const path of [sensitivePath, ordinaryPath]) {
      const bytes = new Uint8Array(readFileSync(path));
      const prepared = await prepare({ bytes, sizeBytes: bytes.byteLength, mimeType: path.endsWith('.png') ? 'image/png' : 'image/jpeg' });
      if (prepared.kind !== 'media') throw new Error(`could not prepare ${path}`);
      images.push({ path: prepared.media.path, sha256: prepared.media.sha256, mimeType: 'image/jpeg' });
    }
    const [sensitive, ordinary] = await judgeMediaImages(provider, images);
    expect(sensitive!.verdict).toBe('sensitive');
    expect(ordinary!.verdict).toBe('ordinary');
  }, 900_000);
});
