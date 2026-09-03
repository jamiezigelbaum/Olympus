import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'bun:test';
import { DOMAIN_LIBRARY_CORPUS_ID, runDomainLibrarySync } from '../scripts/domain-library-sync.ts';
import { defaultConfig } from '../src/core/config.ts';
import { operationToolSchema, operations, type OperationContext } from '../src/core/operations.ts';
import { exposedOperations } from '../src/core/operation-exposure.ts';
import {
  LEGACY_TELEGRAM_MESSAGES_CORPUS_ID,
  PROTECTED_TELEGRAM_MESSAGES_CORPUS_ID,
  createSourceCorpusRegistry,
  defaultSourceCorpusRegistryConfig,
  parsePublicSourceCorpusRegistryConfig,
  parseSourceCorpusRegistryConfig,
} from '../src/core/source-corpus-registry.ts';
import { listMcpTools } from '../src/mcp/tools.ts';
import {
  defaultDropboxIngestionPolicy,
  dropboxPolicyApprovedScopeKeys,
  loadDropboxIngestionPolicy,
  parseSourceIngestionPolicy,
} from '../src/core/source-ingestion-policy.ts';
import { createEmailSourceWorker } from '../src/workers/email-source/index.ts';
import type {
  ExtractionPlanRequest,
  FileExtractionRunner,
} from '../src/workers/file-extraction/runner.ts';
import { LocalConnectorStore } from '../src/workers/connector-store/index.ts';
import {
  createSourceIndexStatusHandler,
  type SourceIndexStatusRetrievalAvailability,
} from '../src/workers/source-index/status.ts';
import { defineGoogleDriveDocsCorpus } from '../src/workers/google-connectors/corpora.ts';

describe('config-driven source corpus registry', () => {
  test('declares the R3 roster plus Telegram v5 in hybrid shadow while no-lane corpora stay lexical', () => {
    const registry = createSourceCorpusRegistry(defaultSourceCorpusRegistryConfig());
    const modes = Object.fromEntries(
      registry.definitions().map((definition) => [definition.corpusId, definition.activationMode]),
    );

    expect(modes).toMatchObject({
      'secure_local.dropbox.files': 'hybrid_shadow',
      'secure_local.email.private': 'hybrid_shadow',
      'secure_local.whatsapp.messages': 'hybrid_shadow',
      'internal.x.bookmarks': 'hybrid_shadow',
      'internal.drive.docs': 'hybrid_primary',
      'internal.readwise.library': 'lexical_only',
      'internal.telegram.messages': 'hybrid_primary',
      'secure_local.telegram.protected.messages': 'hybrid_primary',
    });
  });

  test('canonicalizes the former Readwise id without adding a search capability or duplicate fan-out lane', () => {
    const registry = createSourceCorpusRegistry(defaultSourceCorpusRegistryConfig());
    const legacyConfig = defaultSourceCorpusRegistryConfig();
    legacyConfig.corpora.find((corpus) => corpus.sourceId === 'readwise.library')!.corpusId =
      'public_safe.readwise.library';
    const registryFromLegacyConfig = createSourceCorpusRegistry(legacyConfig);

    expect(registry.require('public_safe.readwise.library', 'answer')).toBe('internal.readwise.library');
    expect(registry.require('public_safe.readwise.library', 'status')).toBe('internal.readwise.library');
    expect(registry.require('public_safe.readwise.library', 'sync')).toBe('internal.readwise.library');
    expect(registry.ids('answer').filter((corpusId) => corpusId.includes('readwise'))).toEqual([
      'internal.readwise.library',
    ]);
    expect(registry.ids('search')).not.toContain('internal.readwise.library');
    expect(registryFromLegacyConfig.ids('answer')).toContain('internal.readwise.library');
    expect(registryFromLegacyConfig.ids('answer')).not.toContain('public_safe.readwise.library');
    expect(() => registry.require('public_safe.readwise.library', 'search')).toThrow(
      'configured search corpora',
    );
  }, 10_000);

  test('canonicalizes the former protected Telegram id without duplicate fan-out', () => {
    const registry = createSourceCorpusRegistry(defaultSourceCorpusRegistryConfig());
    const legacyConfig = defaultSourceCorpusRegistryConfig();
    legacyConfig.corpora.find((corpus) => corpus.corpusId === PROTECTED_TELEGRAM_MESSAGES_CORPUS_ID)!.corpusId =
      LEGACY_TELEGRAM_MESSAGES_CORPUS_ID;
    const registryFromLegacyConfig = createSourceCorpusRegistry(legacyConfig);

    for (const capability of ['status', 'sync', 'search'] as const) {
      expect(registry.require(LEGACY_TELEGRAM_MESSAGES_CORPUS_ID, capability))
        .toBe(PROTECTED_TELEGRAM_MESSAGES_CORPUS_ID);
      expect(registry.ids(capability).filter((corpusId) => corpusId.includes('telegram')))
        .not.toContain(LEGACY_TELEGRAM_MESSAGES_CORPUS_ID);
      expect(registryFromLegacyConfig.ids(capability)).toContain(PROTECTED_TELEGRAM_MESSAGES_CORPUS_ID);
      expect(registryFromLegacyConfig.ids(capability)).not.toContain(LEGACY_TELEGRAM_MESSAGES_CORPUS_ID);
    }
  });

  test('a configured corpus activation mode survives its full definition', () => {
    const config = defaultSourceCorpusRegistryConfig();
    const driveConfig = config.corpora.find((corpus) => corpus.corpusId === 'internal.drive.docs')!;
    driveConfig.activationMode = 'hybrid_shadow';
    const registry = createSourceCorpusRegistry(config);

    expect(registry.definitions('answer', [defineGoogleDriveDocsCorpus()])
      .find((definition) => definition.corpusId === 'internal.drive.docs')?.activationMode)
      .toBe('hybrid_shadow');
  });

  test('unified definitions retain Drive activation mode and storage approvals intact', () => {
    const registry = createSourceCorpusRegistry(defaultSourceCorpusRegistryConfig());
    const drive = defineGoogleDriveDocsCorpus();
    const unifiedDrive = registry.definitions('answer', [drive])
      .find((definition) => definition.corpusId === drive.corpusId);

    expect(unifiedDrive).toBe(drive);
    expect(unifiedDrive).toMatchObject({
      activationMode: 'hybrid_primary',
      storageProfile: {
        embeddingBackend: 'cloud',
        cloudQueryEligible: true,
      },
      embeddingPolicy: 'cloud_allowed_by_policy',
    });
  });

  test('status exposes declared-hybrid degradation and exact embedding parity', async () => {
    const drive = defineGoogleDriveDocsCorpus();
    const statusHandler = createSourceIndexStatusHandler({
      corpusDefinitions: [drive],
      retrievalAvailability: {
        [drive.corpusId]: {
          servable: false,
          reason: 'no_current_embedding_artifacts',
          modelId: 'fixture-model',
          embeddingEpoch: 'fixture-epoch',
          backend: 'cloud',
        },
      },
    });

    const status = await statusHandler.status({ corpus_id: drive.corpusId, include_items: false });
    expect(status.corpora[0]).toMatchObject({
      activation_mode: 'hybrid_primary',
      retrieval: {
        declared_mode: 'hybrid_primary',
        servable_mode: 'keyword',
        state: 'degraded',
        reason: 'no_current_embedding_artifacts',
      },
      embedding_parity: {
        required: true,
        chunks: 0,
        embedded_chunks: 0,
        missing_chunks: 0,
        refresh_needed: false,
      },
    });
  });

  test('status reports the R3 hybrid-shadow corpora as hybrid at parity and loud during backfill', async () => {
    const corpusIds = [
      'secure_local.dropbox.files',
      'secure_local.email.private',
      'secure_local.whatsapp.messages',
      'internal.x.bookmarks',
    ] as const;
    const definitions = createSourceCorpusRegistry(defaultSourceCorpusRegistryConfig())
      .definitions('status')
      .filter((definition) => corpusIds.includes(definition.corpusId as typeof corpusIds[number]));
    const availability: Record<string, SourceIndexStatusRetrievalAvailability> = Object.fromEntries(
      corpusIds.map((corpusId) => [corpusId, {
      servable: true,
      modelId: `${corpusId}:model`,
      embeddingEpoch: `${corpusId}:epoch`,
      backend: corpusId.startsWith('secure_local.') ? 'local' : 'cloud',
      }]),
    );
    const statusHandler = createSourceIndexStatusHandler({
      corpusDefinitions: definitions,
      retrievalAvailability: availability,
    });

    for (const corpusId of corpusIds) {
      const parity = await statusHandler.status({ corpus_id: corpusId, include_items: false });
      expect(parity.corpora[0]).toMatchObject({
        corpus_id: corpusId,
        activation_mode: 'hybrid_shadow',
        retrieval: {
          declared_mode: 'hybrid_shadow',
          servable_mode: 'hybrid',
          state: 'ready',
          model_id: `${corpusId}:model`,
          embedding_epoch: `${corpusId}:epoch`,
        },
      });

      availability[corpusId] = {
        servable: false,
        reason: 'no_current_embedding_artifacts',
        modelId: `${corpusId}:model`,
        embeddingEpoch: `${corpusId}:epoch`,
        backend: corpusId.startsWith('secure_local.') ? 'local' : 'cloud',
      };
      const backfill = await statusHandler.status({ corpus_id: corpusId, include_items: false });
      expect(backfill.corpora[0]).toMatchObject({
        corpus_id: corpusId,
        activation_mode: 'hybrid_shadow',
        retrieval: {
          declared_mode: 'hybrid_shadow',
          servable_mode: 'keyword',
          state: 'degraded',
          reason: 'no_current_embedding_artifacts',
        },
      });
    }
  });

  test('repository-only corpora cannot widen the positive public operation surface', async () => {
    const config = defaultConfig();
    config.sourceIndex.corpusRegistry = {
      schemaVersion: 1,
      corpora: [
        ...defaultSourceCorpusRegistryConfig().corpora,
        {
          corpusId: 'internal.fake.files',
          sourceId: 'fake.files',
          provider: 'fake',
          family: 'file',
          trustDomain: 'internal',
          capabilities: ['status', 'search'],
        },
      ],
    };
    const status = operations.find((operation) => operation.name === 'source_index_status')!;
    const search = operations.find((operation) => operation.name === 'source_index_search')!;
    for (const operation of [status, search]) {
      const schema = operationToolSchema(operation, { config }) as {
        properties: { corpus_id: { enum: string[] } };
      };
      expect(schema.properties.corpus_id.enum).not.toContain('internal.fake.files');
      expect(schema.properties.corpus_id.enum).toContain('internal.email');
    }

    const calls: unknown[] = [];
    const ctx: OperationContext = {
      config,
      delphi: {} as OperationContext['delphi'],
      email: {
        sourceIndexSearch: async (options: unknown) => {
          calls.push(options);
          return {
            kind: 'source_index_search',
            corpus_id: 'internal.fake.files',
            retrieval_source: 'local_index',
            hits: [],
            audit: { raw_source_exposed: false, source_text_returned: false },
            policy: {
              raw_source_exposed: false,
              source_text_returned: false,
              source_packets_exposed: false,
              local_only: true,
              trust_domain: 'internal',
            },
          };
        },
      } as unknown as OperationContext['email'],
    };
    await expect(search.handler(ctx, { corpus_id: 'internal.fake.files', query: 'policy' }))
      .rejects.toThrow('must be one of the configured search corpora');
    expect(calls).toEqual([]);

    const registry = createSourceCorpusRegistry(config.sourceIndex.corpusRegistry);
    const statusHandler = createSourceIndexStatusHandler({
      corpusDefinitions: registry.definitions('status'),
    });
    const statusResult = await statusHandler.status({ corpus_id: 'internal.fake.files' });
    expect(statusResult.corpora).toEqual([expect.objectContaining({
      corpus_id: 'internal.fake.files',
      family: 'file',
      trust_domain: 'internal',
      configured: false,
      item_metadata_returned: false,
      skipped_item_metadata_reason: 'source_index_not_configured',
    })]);
  });

  test('an undeclared corpus narrows the public enum instead of taking the tool surface down', () => {
    const config = defaultConfig();
    const corpora = defaultSourceCorpusRegistryConfig().corpora;
    // A declared corpus whose configured capabilities reach past its
    // declaration: the public view keeps the declared ones and drops the rest.
    corpora.find((corpus) => corpus.corpusId === 'internal.readwise.library')!.capabilities
      .push('search');
    config.sourceIndex.corpusRegistry = parseSourceCorpusRegistryConfig({
      schemaVersion: 1,
      corpora: [
        ...corpora,
        // A public sourceId under a corpusId v0.4 never declared: the strict
        // public parser rejects it, the permissive loader every private
        // consumer runs accepts it.
        {
          corpusId: 'internal.dropbox.work',
          sourceId: 'dropbox.files',
          provider: 'dropbox',
          family: 'file',
          trustDomain: 'internal',
          capabilities: ['answer', 'status', 'search'],
        },
      ],
    });

    // Every public tool renders, not just the corpus-carrying ones: the schema
    // map that builds the MCP/CLI/native tool lists aborts on the first throw.
    expect(listMcpTools(config).map((tool) => tool.name)).toEqual(
      exposedOperations(operations, { config, surface: 'mcp' }).map((operation) => operation.name),
    );

    const answerEnum = (operationToolSchema(
      operations.find((operation) => operation.name === 'source_answer')!,
      { config },
    ) as { properties: { corpus_id: { enum: string[] } } }).properties.corpus_id.enum;
    expect(answerEnum).toEqual(createSourceCorpusRegistry(defaultSourceCorpusRegistryConfig()).ids('answer'));

    const searchEnum = (operationToolSchema(
      operations.find((operation) => operation.name === 'source_index_search')!,
      { config },
    ) as { properties: { corpus_id: { enum: string[] } } }).properties.corpus_id.enum;
    expect(searchEnum).not.toContain('internal.dropbox.work');
    expect(searchEnum).not.toContain('internal.readwise.library');

    // The private surface still sees everything the permissive loader accepted.
    expect(createSourceCorpusRegistry(config.sourceIndex.corpusRegistry).ids('search'))
      .toContain('internal.dropbox.work');
    // ...and the public plugin-config path still refuses both entries outright,
    // where the operator wrote them and can act on the message.
    expect(() => parsePublicSourceCorpusRegistryConfig(config.sourceIndex.corpusRegistry))
      .toThrow('Public sourceIndex corpus internal.readwise.library cannot add capabilities: search.');
    expect(() => parsePublicSourceCorpusRegistryConfig({
      schemaVersion: 1,
      corpora: config.sourceIndex.corpusRegistry.corpora
        .filter((corpus) => corpus.corpusId !== 'internal.readwise.library'),
    })).toThrow('Public sourceIndex corpusId is not declared by v0.4: internal.dropbox.work.');
  });

  test('connector-store-backed config corpus reports configured counts when mounted', async () => {
    const root = mkdtempSync(join(tmpdir(), 'source-corpus-registry-config-'));
    const registryRelativePath = 'castor-solon/references/source-registry.jsonl';
    mkdirSync(join(root, 'castor-solon', 'references'), { recursive: true });
    mkdirSync(join(root, 'castor-solon', 'sources'), { recursive: true });
    const derivativePath = 'castor-solon/sources/approved.md';
    const text = 'approved connector-store status derivative';
    writeFileSync(join(root, derivativePath), text);
    writeFileSync(join(root, registryRelativePath), `${JSON.stringify({
      source_id: 'approved-status',
      domain_id: 'governance',
      workspace_relative_path: derivativePath,
      trust_domain: 'internal',
      tier: 'S3',
      classification_status: 'approved',
      content_hash: createHash('sha256').update(text).digest('hex'),
    })}\n`);
    const dbPath = join(root, 'connector-store.db');
    await runDomainLibrarySync({ workspaceRoot: root, registryRelativePath, dbPath });

    const config = defaultConfig();
    // The domain-library corpus left the default roster with the 2026-07-28
    // retirement, so an operator now has to register it explicitly for the
    // mounted store to be visible at all. That is the shape this asserts.
    config.sourceIndex.corpusRegistry = {
      schemaVersion: 1,
      corpora: [
        {
          corpusId: DOMAIN_LIBRARY_CORPUS_ID,
          sourceId: 'domain_library.agent_library',
          provider: 'domain_library',
          family: 'file',
          trustDomain: 'internal',
          activationMode: 'lexical_only',
          capabilities: ['status', 'search'],
        },
      ],
    };
    const registry = createSourceCorpusRegistry(config.sourceIndex.corpusRegistry);
    const store = new LocalConnectorStore({
      dbPath,
      corpusId: DOMAIN_LIBRARY_CORPUS_ID,
      family: 'file',
      trustDomain: 'internal',
    });
    try {
      const statusHandler = createSourceIndexStatusHandler({
        corpusDefinitions: registry.definitions('status'),
        connectorStores: [store],
      });
      const statusResult = await statusHandler.status({ corpus_id: DOMAIN_LIBRARY_CORPUS_ID });
      expect(statusResult.corpora).toEqual([expect.objectContaining({
        corpus_id: DOMAIN_LIBRARY_CORPUS_ID,
        family: 'file',
        trust_domain: 'internal',
        configured: true,
        counts: {
          indexed_items: 1,
          tombstoned_items: 0,
          chunks: 1,
          embedded_chunks: 0,
          sync_runs: 1,
          items_with_text: 1,
        },
        item_metadata_returned: false,
        skipped_item_metadata_reason: 'connector_store_item_metadata_not_exposed_to_castor',
      })]);
    } finally {
      store.close();
    }
  });

  test('private-host-shaped generated config reproduces the current corpus roster and Dropbox planner decisions', async () => {
    const config = defaultConfig();
    const registry = createSourceCorpusRegistry(config.sourceIndex.corpusRegistry);
    expect(registry.ids('answer')).toEqual([
      'secure_local.email.private',
      'internal.email',
      'internal.drive.docs',
      'secure_local.drive.docs',
      'internal.telegram.messages',
      'internal.readwise.library',
      'internal.x.bookmarks',
      'secure_local.dropbox.files',
      'secure_local.telegram.protected.messages',
      'secure_local.whatsapp.messages',
    ]);
    expect(registry.ids('status')).toEqual([
      'secure_local.email.private',
      'internal.email',
      'internal.drive.docs',
      'secure_local.drive.docs',
      'internal.telegram.messages',
      'internal.readwise.library',
      'internal.x.bookmarks',
      'secure_local.dropbox.files',
      'secure_local.telegram.protected.messages',
      'secure_local.whatsapp.messages',
    ]);
    expect(registry.ids('sync')).toEqual([
      'internal.email',
      'secure_local.email.private',
      'internal.drive.docs',
      'secure_local.drive.docs',
      'internal.readwise.library',
      'internal.x.bookmarks',
      'secure_local.dropbox.files',
      'internal.telegram.messages',
      'secure_local.telegram.protected.messages',
      'secure_local.whatsapp.messages',
    ]);
    expect(registry.ids('search')).toEqual([
      'internal.email',
      'secure_local.email.private',
      'internal.drive.docs',
      'secure_local.drive.docs',
      'secure_local.dropbox.files',
      'internal.x.bookmarks',
      'internal.telegram.messages',
      'secure_local.telegram.protected.messages',
      'secure_local.whatsapp.messages',
    ]);

    const generatedPolicy = loadDropboxIngestionPolicy({
      inlinePolicy: JSON.parse(readFileSync(join(import.meta.dir, '..', 'config', 'source-ingestion', 'dropbox.personal.ingestion.json'), 'utf8')) as unknown,
    });
    const defaultPolicy = defaultDropboxIngestionPolicy();
    expect(generatedPolicy).toEqual(defaultPolicy);
    expect(dropboxPolicyApprovedScopeKeys(generatedPolicy)).toEqual([
      'dropbox.personal:/',
    ]);

    expect(loadDropboxIngestionPolicy({
      inlinePolicy: JSON.parse(readFileSync(join(import.meta.dir, '..', 'config', 'source-ingestion', 'dropbox.personal.ingestion.json'), 'utf8')) as unknown,
    }).corpusId).toBe('secure_local.dropbox.files');
    // A policy naming any other corpus is refused: the Dropbox loader serves
    // exactly one corpus and must not silently accept a foreign band.
    expect(() => loadDropboxIngestionPolicy({
      inlinePolicy: { ...defaultPolicy, corpusId: 'internal.dropbox.other-band' },
    })).toThrow('secure_local.dropbox.files');

    const planRequests: ExtractionPlanRequest[] = [];
    const worker = createEmailSourceWorker({
      dropboxIngestionPolicy: generatedPolicy,
      fileExtraction: {
        corpusIds: () => ['secure_local.dropbox.files'],
        async plan(request: ExtractionPlanRequest) {
          planRequests.push(request);
          return {
            kind: 'file_extraction_plan' as const,
            corpusId: request.corpusId,
            candidates: 0,
            jobsQueued: 0,
            jobsExisting: 0,
            jobsForced: 0,
            jobsSkippedTooLarge: 0,
            jobsUnroutable: 0,
            extractorKinds: [],
            done: true,
            policy: {
              workerPrivateSurface: true as const,
              rawSourceExposed: false as const,
              sourceTextReturned: false as const,
              fileBytesDownloaded: false as const,
              localOnly: true,
              trustDomain: 'secure_local' as const,
            },
          };
        },
      } as unknown as FileExtractionRunner,
    });
    const response = await worker.fetch(new Request('http://worker.test/v1/source/index/dropbox/content/plan', {
      method: 'POST',
      body: JSON.stringify({
        corpus_id: 'secure_local.dropbox.files',
        account: 'personal',
        approved_scope_key: 'dropbox.personal:/1 Projects',
        extractor_kind: generatedPolicy.content.default_extractor_kind,
        extractor_version: generatedPolicy.content.default_extractor_version,
        limit: generatedPolicy.content.plan_limit,
      }),
    }));
    expect(response.status).toBe(200);
    expect(planRequests[0]).toMatchObject({
      approvedScopeKey: 'dropbox.personal:/1 Projects',
      corpusId: 'secure_local.dropbox.files',
      provider: 'dropbox',
      accountScope: 'personal',
      extractorKind: 'local_text',
      limit: 25,
    });
  });
});
