// Pins the embedding identity to ONE constructor.
//
// Two things are being held still here. First, the canonical epoch strings:
// they are the identity of vectors already stored across live corpora, so a
// change to the derivation that would relabel them has to fail here, in a
// test, and not on a machine holding 170k vectors. Second, the number of
// places that can build such a string: exactly one.

import { Glob } from 'bun';
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  CANONICAL_EMBEDDING_IDENTITIES,
  KNOWN_CONTAMINATED_EMBEDDING_EPOCHS,
  buildEmbeddingEpoch,
  canonicalEmbeddingDimension,
  canonicalEmbeddingIdentityForModel,
  contaminatedEmbeddingEpoch,
  embeddingEpochFamilyPrefix,
  resolveEmbeddingEpoch,
} from '../src/workers/source-index/embedding-identity.ts';
import {
  DeterministicSourceEmbeddingProvider,
  GeminiSourceEmbeddingProvider,
  OpenAICompatibleSourceEmbeddingProvider,
} from '../src/workers/source-index/embeddings.ts';

const repoRoot = join(import.meta.dir, '..');

// The frozen canon. These are not derived in the test on purpose: the whole
// point is to compare the code's derivation against a literal that matches
// what live stores hold.
const QWEN3_EPOCH = 'local:openai-compatible:secure-local-qwen3-embed:2560';
const GEMINI_EPOCH = 'cloud:google-gemini:gemini-embedding-2:provider-reported';

// The variant the alternation produced. No exported constructor may be able
// to emit it again.
const BANNED_LOCAL_PROVIDER_TOKEN = 'local:local-openai-compatible:';

describe('embedding identity canon', () => {
  test('derives the exact epochs live corpora were minted under', () => {
    expect(canonicalEmbeddingIdentityForModel('secure-local-qwen3-embed')).toEqual({
      provider: 'local-openai-compatible',
      modelId: 'secure-local-qwen3-embed',
      backend: 'local',
      dimension: 2560,
      epochId: QWEN3_EPOCH,
    });
    expect(canonicalEmbeddingIdentityForModel('gemini-embedding-2')).toEqual({
      provider: 'google-gemini',
      modelId: 'gemini-embedding-2',
      backend: 'cloud',
      dimension: 3072,
      epochId: GEMINI_EPOCH,
    });
    expect(canonicalEmbeddingDimension('secure-local-qwen3-embed')).toBe(2560);
    expect(canonicalEmbeddingDimension('unknown-model')).toBeUndefined();
    expect(canonicalEmbeddingIdentityForModel('unknown-model')).toBeUndefined();
  });

  test('spells the local family without the redundant provider prefix', () => {
    expect(buildEmbeddingEpoch({
      provider: 'local-openai-compatible',
      modelId: 'secure-local-qwen3-embed',
      backend: 'local',
      dimension: 2560,
    })).toBe(QWEN3_EPOCH);
    expect(embeddingEpochFamilyPrefix({ provider: 'local-openai-compatible', backend: 'local' }))
      .toBe('local:openai-compatible:');
  });

  test('keeps the Gemini dimension token stable across configured dimensions', () => {
    // Dimension is its own field in the write-authority tuple, so the epoch
    // does not restate it. When it briefly did (2026-08-17), new Gemini writes
    // desynchronized from every vector already stored.
    for (const dimension of [undefined, 768, 3072]) {
      expect(buildEmbeddingEpoch({
        provider: 'google-gemini',
        modelId: 'gemini-embedding-2',
        backend: 'cloud',
        dimension,
      })).toBe(GEMINI_EPOCH);
    }
  });

  test('renders an unknown dimension as provider-reported for declared families', () => {
    for (const dimension of [undefined, 0, -1, 1.5, Number.NaN]) {
      expect(buildEmbeddingEpoch({
        provider: 'local-openai-compatible',
        modelId: 'some-local-model',
        backend: 'local',
        dimension,
      })).toBe('local:openai-compatible:some-local-model:provider-reported');
    }
  });

  test('leaves providers outside a declared family exactly as they were', () => {
    expect(buildEmbeddingEpoch({
      provider: 'deterministic-source-test',
      modelId: 'olympus-deterministic-source-embedding-v1',
      backend: 'local',
      dimension: 48,
    })).toBe('local:deterministic-source-test:olympus-deterministic-source-embedding-v1:48');
  });
});

describe('embedding epoch overrides', () => {
  test('accepts a same-family override so an operator can still bump an epoch', () => {
    expect(resolveEmbeddingEpoch({
      provider: 'google-gemini',
      modelId: 'gemini-embedding-2',
      backend: 'cloud',
      dimension: 3072,
      epochOverride: 'cloud:google-gemini:gemini-embedding-2:2026-09',
    })).toBe('cloud:google-gemini:gemini-embedding-2:2026-09');
  });

  test('accepts a dated operator bump with a hand-written provider spelling', () => {
    // A live shape: the local lane has carried router-named, dated epochs.
    // Same backend, same model, so it is a generation marker, not a relabel.
    expect(resolveEmbeddingEpoch({
      provider: 'local-openai-compatible',
      modelId: 'secure-local-qwen3-embed',
      backend: 'local',
      dimension: 2560,
      epochOverride: 'local:delphi:secure-local-qwen3-embed:2026-07-09',
    })).toBe('local:delphi:secure-local-qwen3-embed:2026-07-09');
  });

  test('refuses the cross-provider override that contaminated the live stores', () => {
    // Exactly what the private host did: the local qwen3 epoch handed to the Gemini
    // provider. Both signals fire — wrong backend, and it names another
    // canonical model.
    expect(() => resolveEmbeddingEpoch({
      provider: 'google-gemini',
      modelId: 'gemini-embedding-2',
      backend: 'cloud',
      dimension: 3072,
      epochOverride: QWEN3_EPOCH,
    })).toThrow('it names the local backend');
  });

  test('refuses an override naming another canonical model on the same backend', () => {
    expect(() => resolveEmbeddingEpoch({
      provider: 'local-openai-compatible',
      modelId: 'secure-local-qwen3-embed',
      backend: 'local',
      dimension: 2560,
      epochOverride: 'local:openai-compatible:gemini-embedding-2:2560',
    })).toThrow('it names the model gemini-embedding-2');
  });

  test('lets a provider without a declared family carry any epoch', () => {
    // Test doubles stand in for real providers and carry their epochs. They
    // never write to a live corpus, so the family gate would cost fixtures
    // without protecting anything.
    expect(resolveEmbeddingEpoch({
      provider: 'deterministic-source-test',
      modelId: 'gemini-embedding-2-test',
      backend: 'local',
      dimension: 16,
      epochOverride: 'cloud:google-gemini:gemini-embedding-2:test',
    })).toBe('cloud:google-gemini:gemini-embedding-2:test');
  });

  test('ignores an empty override and derives instead', () => {
    expect(resolveEmbeddingEpoch({
      provider: 'local-openai-compatible',
      modelId: 'secure-local-qwen3-embed',
      backend: 'local',
      dimension: 2560,
      epochOverride: '   ',
    })).toBe(QWEN3_EPOCH);
  });
});

describe('embedding provider constructors', () => {
  test('every provider for a canonical model reports the canonical epoch', () => {
    const local = new OpenAICompatibleSourceEmbeddingProvider({
      baseUrl: 'http://127.0.0.1:28090/v1',
      model: 'secure-local-qwen3-embed',
      dimension: 2560,
    });
    expect(local.epochId).toBe(QWEN3_EPOCH);

    const gemini = new GeminiSourceEmbeddingProvider({
      apiKey: 'gemini-secret',
      model: 'gemini-embedding-2',
      outputDimensionality: 3072,
    });
    expect(gemini.epochId).toBe(GEMINI_EPOCH);

  });

  test('no exported constructor can produce the alternation variant', () => {
    const constructed = [
      new OpenAICompatibleSourceEmbeddingProvider({
        baseUrl: 'http://127.0.0.1:28090/v1',
        model: 'secure-local-qwen3-embed',
        dimension: 2560,
      }),
      new OpenAICompatibleSourceEmbeddingProvider({
        baseUrl: 'http://127.0.0.1:28090/v1',
        model: 'secure-local-qwen3-embed',
      }),
      new GeminiSourceEmbeddingProvider({ apiKey: 'k', model: 'gemini-embedding-2' }),
      new DeterministicSourceEmbeddingProvider(),
    ];
    for (const provider of constructed) {
      expect(provider.epochId.startsWith(BANNED_LOCAL_PROVIDER_TOKEN)).toBe(false);
    }
    // Including via the override seam: both spellings of the banned variant
    // are registered as contaminated, so configuration cannot re-introduce
    // what the repair tool erases.
    for (const banned of [
      `${BANNED_LOCAL_PROVIDER_TOKEN}secure-local-qwen3-embed:2560`,
      `${BANNED_LOCAL_PROVIDER_TOKEN}secure-local-qwen3-embed:provider-reported`,
    ]) {
      expect(() => resolveEmbeddingEpoch({
        provider: 'local-openai-compatible',
        modelId: 'secure-local-qwen3-embed',
        backend: 'local',
        dimension: 2560,
        epochOverride: banned,
      })).toThrow('known contaminated epoch');
    }
  });
});

describe('single-constructor guard', () => {
  // Files allowed to contain an epoch-shaped literal, and why.
  const ALLOWED_EPOCH_LITERAL_PATHS = new Set<string>([
    // The canon and the contaminated set both live here by design.
    'src/workers/source-index/embedding-identity.ts',
    // Owned by the embedding-ledger work; it records the historical qwen3
    // epoch as ledger provenance rather than constructing one for a write.
    'src/workers/embedding-ledger.ts',
  ]);

  // Matches a source-level epoch literal: a quoted or template string that
  // starts with a backend segment and carries at least two more segments.
  const EPOCH_LITERAL = /['"`](?:local|cloud):[A-Za-z0-9._-]+:[^'"`]*:/;

  function isCommentLine(line: string): boolean {
    const trimmed = line.trim();
    return trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*');
  }

  test('only the identity module builds an epoch string', async () => {
    const offenders: string[] = [];
    for await (const file of new Glob('src/**/*.ts').scan(repoRoot)) {
      if (ALLOWED_EPOCH_LITERAL_PATHS.has(file)) continue;
      const source = readFileSync(join(repoRoot, file), 'utf8');
      for (const line of source.split('\n')) {
        // Prose may quote an epoch — that is how these strings get explained.
        // The guard is about code that constructs one.
        if (isCommentLine(line)) continue;
        if (EPOCH_LITERAL.test(line)) offenders.push(`${file}: ${line.trim()}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  test('the guard actually catches an epoch literal', () => {
    expect(EPOCH_LITERAL.test("const epoch = 'local:openai-compatible:m:2560';")).toBe(true);
    expect(EPOCH_LITERAL.test('const epoch = `cloud:google-gemini:${model}:provider-reported`;'))
      .toBe(true);
    expect(EPOCH_LITERAL.test("const provider = 'local-openai-compatible';")).toBe(false);
  });

  test('every contaminated variant names a canonical model and differs from its epoch', () => {
    for (const entry of KNOWN_CONTAMINATED_EMBEDDING_EPOCHS) {
      const canonical = canonicalEmbeddingIdentityForModel(entry.modelId);
      expect(canonical).toBeDefined();
      expect(entry.epochId).not.toBe(canonical!.epochId);
      expect(entry.origin.length).toBeGreaterThan(0);
      expect(contaminatedEmbeddingEpoch(entry.modelId, entry.epochId)).toEqual(entry);
    }
    // A canonical epoch is never itself correctable.
    for (const identity of CANONICAL_EMBEDDING_IDENTITIES) {
      expect(contaminatedEmbeddingEpoch(identity.modelId, identity.epochId)).toBeUndefined();
    }
  });
});
