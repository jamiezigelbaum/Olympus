import { describe, expect, test } from 'bun:test';
import {
  buildSourceIndexCorpusRegistry,
  defineSourceIndexCorpus,
} from '../src/core/source-index/corpus.ts';

describe('source-index corpus registry', () => {
  test('defaults secure-local corpora to S4 local SQLite-family storage', () => {
    const corpus = defineSourceIndexCorpus({
      corpusId: 'secure_local.email.private',
      family: 'email',
      trustDomain: 'secure_local',
      description: 'Private Gmail source packets.',
    });

    expect(corpus).toMatchObject({
      corpusId: 'secure_local.email.private',
      family: 'email',
      trustDomain: 'secure_local',
      activationMode: 'lexical_only',
      embeddingPolicy: 'local_only',
      defaultSensitivity: {
        trustTier: 'S4',
        trustDomain: 'secure_local',
        localOnly: true,
        cloudEmbeddingEligible: false,
      },
      storageProfile: {
        trustDomain: 'secure_local',
        placement: 'local_private',
        storageEngine: 'sqlite',
        lexicalBackend: 'sqlite_fts5',
        vectorBackend: 'exact_scan',
        embeddingBackend: 'local',
        cloudQueryEligible: false,
      },
    });
  });

  test('defines an internal corpus as local-first while allowing approved cloud query and embeddings', () => {
    const corpus = defineSourceIndexCorpus({
      corpusId: 'internal.drive.docs',
      family: 'file',
      trustDomain: 'internal',
      activationMode: 'hybrid_shadow',
      storageProfileInput: {
        cloudEmbeddingApproved: true,
        cloudQueryApproved: true,
      },
    });

    expect(corpus.storageProfile).toMatchObject({
      placement: 'local_private',
      storageEngine: 'sqlite',
      lexicalBackend: 'sqlite_fts5',
      vectorBackend: 'exact_scan',
      embeddingBackend: 'cloud',
      cloudQueryEligible: true,
    });
    expect(corpus.embeddingPolicy).toBe('cloud_allowed_by_policy');
    expect(corpus.defaultSensitivity.trustTier).toBe('S3');
  });

  test('rejects mismatched storage and sensitivity trust domains', () => {
    expect(() =>
      defineSourceIndexCorpus({
        corpusId: 'bad.storage',
        family: 'file',
        trustDomain: 'secure_local',
        storageProfile: {
          trustDomain: 'internal',
          placement: 'cloud_managed',
          storageEngine: 'postgres',
          lexicalBackend: 'postgres_full_text',
          vectorBackend: 'pgvector',
          embeddingBackend: 'local',
          cloudQueryEligible: false,
        },
      }),
    ).toThrow('storage profile trust domain must match');

    expect(() =>
      defineSourceIndexCorpus({
        corpusId: 'bad.sensitivity',
        family: 'file',
        trustDomain: 'internal',
        defaultSensitivity: {
          trustTier: 'S4',
        },
      }),
    ).toThrow('default sensitivity trust domain must match');
  });

  test('selects corpora by id, family, and trust domain', () => {
    const secureEmail = defineSourceIndexCorpus({
      corpusId: 'secure_local.email.private',
      family: 'email',
      trustDomain: 'secure_local',
    });
    const internalDrive = defineSourceIndexCorpus({
      corpusId: 'internal.drive.docs',
      family: 'file',
      trustDomain: 'internal',
    });
    const registry = buildSourceIndexCorpusRegistry([secureEmail, internalDrive]);

    expect(registry.require('secure_local.email.private')).toBe(secureEmail);
    expect(registry.select({ families: ['file'] })).toEqual([internalDrive]);
    expect(registry.select({ trustDomains: ['secure_local'] })).toEqual([secureEmail]);
    expect(registry.select({ corpusIds: ['missing'] })).toEqual([]);
  });

  test('rejects duplicate corpus ids', () => {
    const corpus = defineSourceIndexCorpus({
      corpusId: 'internal.notes',
      family: 'note',
      trustDomain: 'internal',
    });

    expect(() => buildSourceIndexCorpusRegistry([corpus, corpus])).toThrow('Duplicate source-index corpus id');
  });
});
