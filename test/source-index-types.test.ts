import { describe, expect, test } from 'bun:test';
import {
  buildSourceIndexStorageProfile,
  buildSourceSensitivity,
  isSecureTrustTier,
  type RetrievalLaneAudit,
  type SourceChunkIdentity,
  type SourceFamily,
  type SourceIndexProvenance,
  type SourceItemIdentity,
} from '../src/core/source-index/types.ts';

describe('source-index shared contracts', () => {
  test('defaults S4 material to secure-local and cloud-embedding-ineligible', () => {
    expect(buildSourceSensitivity({ trustTier: 'S4' })).toEqual({
      trustTier: 'S4',
      trustDomain: 'secure_local',
      localOnly: true,
      cloudEmbeddingEligible: false,
    });

  expect(buildSourceSensitivity({ trustTier: 'S4+', cloudEmbeddingEligible: true }).cloudEmbeddingEligible).toBe(false);
  expect(buildSourceSensitivity({ trustTier: 'S4', localOnly: false }).localOnly).toBe(true);
  expect(buildSourceSensitivity({ trustTier: 'S5', cloudEmbeddingEligible: true })).toEqual({
    trustTier: 'S5',
    trustDomain: 'secure_local',
    localOnly: true,
    cloudEmbeddingEligible: false,
  });
  });

  test('requires explicit cloud embedding eligibility for lower sensitivity material', () => {
    expect(buildSourceSensitivity({ trustTier: 'S2' })).toEqual({
      trustTier: 'S2',
      trustDomain: 'internal',
      localOnly: false,
      cloudEmbeddingEligible: false,
    });

    expect(buildSourceSensitivity({ trustTier: 'S2', cloudEmbeddingEligible: true }).cloudEmbeddingEligible).toBe(true);
  });

  test('keeps secure-local domains cloud-embedding-ineligible even when requested', () => {
    expect(
      buildSourceSensitivity({
        trustTier: 'S3',
        trustDomain: 'secure_local',
        cloudEmbeddingEligible: true,
      }),
    ).toEqual({
      trustTier: 'S3',
      trustDomain: 'secure_local',
      localOnly: true,
      cloudEmbeddingEligible: false,
    });
  });

  test('supports source-family identity, provenance, chunks, and lane audits without Gmail-only fields', () => {
    const family: SourceFamily = 'x-browser-history';
    const sourceItem: SourceItemIdentity = {
      family,
      provider: 'local-export',
      accountScope: 'personal',
      providerItemId: 'provider-item-1',
      localItemId: 'local-item-1',
    };
    const chunk: SourceChunkIdentity = {
      sourceItem,
      chunkId: 'chunk-1',
      chunkIndex: 0,
      contentHash: 'sha256:abc',
    };
    const provenance: SourceIndexProvenance = {
      sourceItem,
      chunk,
      syncRunId: 'sync-1',
      citation: { title: 'Safe citation metadata' },
    };
    const audit: RetrievalLaneAudit = {
      laneName: 'metadata',
      laneType: 'metadata',
      candidateCount: 4,
      returnedCount: 2,
      backend: 'sqlite',
      localOnly: true,
      rawExposed: false,
    };

    expect(provenance.chunk?.chunkId).toBe('chunk-1');
    expect(audit.rawExposed).toBe(false);
  });

  test('identifies secure trust tiers', () => {
    expect(isSecureTrustTier('S3')).toBe(false);
    expect(isSecureTrustTier('S4')).toBe(true);
    expect(isSecureTrustTier('S4+')).toBe(true);
  });

  test('defaults secure-local storage to local SQLite-family retrieval', () => {
    expect(buildSourceIndexStorageProfile({ trustDomain: 'secure_local' })).toEqual({
      trustDomain: 'secure_local',
      placement: 'local_private',
      storageEngine: 'sqlite',
      lexicalBackend: 'sqlite_fts5',
      vectorBackend: 'exact_scan',
      embeddingBackend: 'local',
      cloudQueryEligible: false,
    });
  });

  test('allows only local SQLite-family vector lanes for secure-local corpora', () => {
    expect(buildSourceIndexStorageProfile({
      trustDomain: 'secure_local',
      vectorBackend: 'sqlite_vec',
    }).vectorBackend).toBe('sqlite_vec');
    expect(buildSourceIndexStorageProfile({
      trustDomain: 'secure_local',
      vectorBackend: 'sqlite_vec1',
    }).vectorBackend).toBe('sqlite_vec1');
  });

  test('rejects cloud or pgvector storage choices for secure-local corpora', () => {
    expect(() =>
      buildSourceIndexStorageProfile({
        trustDomain: 'secure_local',
        placement: 'cloud_managed',
      }),
    ).toThrow('secure_local storage must stay local_private');
    expect(() =>
      buildSourceIndexStorageProfile({
        trustDomain: 'secure_local',
        vectorBackend: 'pgvector',
      }),
    ).toThrow('secure_local vector search must use a local SQLite-family vector lane');
    expect(() =>
      buildSourceIndexStorageProfile({
        trustDomain: 'secure_local',
        embeddingBackend: 'cloud',
      }),
    ).toThrow('secure_local corpora cannot use cloud embeddings');
  });

  test('defaults internal corpora to local-first SQLite storage with local embeddings', () => {
    expect(buildSourceIndexStorageProfile({ trustDomain: 'internal' })).toEqual({
      trustDomain: 'internal',
      placement: 'local_private',
      storageEngine: 'sqlite',
      lexicalBackend: 'sqlite_fts5',
      vectorBackend: 'exact_scan',
      embeddingBackend: 'local',
      cloudQueryEligible: false,
    });

    expect(
      buildSourceIndexStorageProfile({
        trustDomain: 'internal',
        cloudEmbeddingApproved: true,
        cloudQueryApproved: true,
      }),
    ).toEqual({
      trustDomain: 'internal',
      placement: 'local_private',
      storageEngine: 'sqlite',
      lexicalBackend: 'sqlite_fts5',
      vectorBackend: 'exact_scan',
      embeddingBackend: 'cloud',
      cloudQueryEligible: true,
    });
  });

  test('allows Postgres pgvector as an explicit internal escalation path', () => {
    expect(
      buildSourceIndexStorageProfile({
        trustDomain: 'internal',
        storageEngine: 'postgres',
        cloudEmbeddingApproved: true,
        cloudQueryApproved: true,
      }),
    ).toEqual({
      trustDomain: 'internal',
      placement: 'cloud_managed',
      storageEngine: 'postgres',
      lexicalBackend: 'postgres_full_text',
      vectorBackend: 'pgvector',
      embeddingBackend: 'cloud',
      cloudQueryEligible: true,
    });
  });

  test('requires explicit corpus policy before internal cloud embeddings', () => {
    expect(() =>
      buildSourceIndexStorageProfile({
        trustDomain: 'internal',
        embeddingBackend: 'cloud',
      }),
    ).toThrow('Cloud embeddings require explicit corpus policy approval');
  });

  test('defaults public-safe corpora to separate local-first SQLite storage', () => {
    expect(buildSourceIndexStorageProfile({ trustDomain: 'public_safe' })).toEqual({
      trustDomain: 'public_safe',
      placement: 'local_private',
      storageEngine: 'sqlite',
      lexicalBackend: 'sqlite_fts5',
      vectorBackend: 'exact_scan',
      embeddingBackend: 'local',
      cloudQueryEligible: true,
    });

    expect(
      buildSourceIndexStorageProfile({
        trustDomain: 'public_safe',
        cloudEmbeddingApproved: true,
      }),
    ).toEqual({
      trustDomain: 'public_safe',
      placement: 'local_private',
      storageEngine: 'sqlite',
      lexicalBackend: 'sqlite_fts5',
      vectorBackend: 'exact_scan',
      embeddingBackend: 'cloud',
      cloudQueryEligible: true,
    });
  });

  test('requires explicit corpus policy before public-safe cloud embeddings', () => {
    expect(() =>
      buildSourceIndexStorageProfile({
        trustDomain: 'public_safe',
        embeddingBackend: 'cloud',
      }),
    ).toThrow('Cloud embeddings require explicit corpus policy approval');
  });
});
