import { describe, expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  assertEmbeddingProviderForLane,
  DirectSourceEmbeddingDrainClient,
  optionsFromEnv,
  publishNativeEmbeddingDrainReadiness,
  runSourceEmbeddingDrain,
  sourceEmbeddingLaneRosterFromEnv,
  type CorpusEmbeddingRequest,
  type SourceEmbeddingDrainClient,
} from '../scripts/source-embedding-drain.ts';
import type { RawItem, SourceConnector } from '../src/core/contracts.ts';
import { LocalConnectorStore } from '../src/workers/connector-store/index.ts';
import type { SourceEmbeddingProvider } from '../src/workers/source-index/embeddings.ts';

class FakeClient implements SourceEmbeddingDrainClient {
  readonly calls: CorpusEmbeddingRequest[] = [];

  constructor(private readonly fail = false) {}

  async embedConnectorStore(request: CorpusEmbeddingRequest) {
    this.calls.push(request);
    if (this.fail) throw new Error('synthetic connector-store failure');
    return {
      chunks_seen: 2,
      chunks_embedded: 1,
      chunks_skipped: 1,
      status: 'completed',
    };
  }
}

describe('canonical connector-store embedding drain', () => {
  test('drains the explicit corpus roster without exposing target keys', async () => {
    const client = new FakeClient();
    const lanes = sourceEmbeddingLaneRosterFromEnv(client, {
      OLYMPUS_SOURCE_EMBEDDING_DRAIN_EMAIL_ENABLED: 'true',
      OLYMPUS_SOURCE_EMBEDDING_DRAIN_EMAIL_MAX_PENDING_CHUNKS: '7',
    }, 5);

    const report = await runSourceEmbeddingDrain({
      client,
      lanes,
      maxRuns: 2,
      maxRuntimeSeconds: 30,
      idleSleepMs: 0,
      errorBackoffMs: 0,
      stopWhenIdle: true,
      now: new Date('2026-08-29T12:00:00.000Z'),
    });

    expect(client.calls).toEqual([
      {
        corpus_id: 'secure_local.dropbox.files',
        max_pending_chunks: 5,
      },
      {
        corpus_id: 'secure_local.email.private',
        max_pending_chunks: 7,
      },
    ]);
    expect(report).toMatchObject({
      status: 'progress',
      run_state: 'complete',
      chunks_seen: 4,
      chunks_embedded: 2,
      chunks_skipped: 2,
      policy: {
        raw_source_exposed: false,
        source_text_returned: false,
        source_scope_keys_exposed: false,
        direct_db_mutation: false,
        local_only: true,
      },
    });
    expect(report.corpus_ids).toEqual([
      'secure_local.dropbox.files',
      'secure_local.email.private',
    ]);
    expect(JSON.stringify(report)).not.toContain('targetKeys');
  });

  test('turns a connector-store failure into bounded attention', async () => {
    const client = new FakeClient(true);
    const report = await runSourceEmbeddingDrain({
      client,
      maxRuns: 1,
      maxConsecutiveFailures: 1,
      maxRuntimeSeconds: 30,
      idleSleepMs: 0,
      errorBackoffMs: 0,
      now: new Date('2026-08-29T12:00:00.000Z'),
    });

    expect(report.status).toBe('attention');
    expect(report.consecutive_failures).toBe(1);
    expect(report.scopes[0]?.errors).toHaveLength(1);
    expect(report.scopes[0]?.errors[0]).toHaveLength(64);
    expect(JSON.stringify(report)).not.toContain('synthetic connector-store failure');
  });

  test('builds only connector-store lanes from environment policy', () => {
    const client = new FakeClient();
    const lanes = sourceEmbeddingLaneRosterFromEnv(client, {
      OLYMPUS_SOURCE_EMBEDDING_DRAIN_X_BOOKMARKS_ENABLED: 'true',
      OLYMPUS_SOURCE_EMBEDDING_DRAIN_DRIVE_INTERNAL_ENABLED: 'true',
      OLYMPUS_SOURCE_EMBEDDING_DRAIN_INTERNAL_TELEGRAM_ENABLED: 'true',
    });

    expect(lanes.map((lane) => [lane.corpusId, lane.trustDomain])).toEqual([
      ['secure_local.dropbox.files', 'secure_local'],
      ['internal.telegram.messages', 'internal'],
      ['internal.x.bookmarks', 'internal'],
      ['internal.drive.docs', 'internal'],
    ]);
  });

  test('enforces provider sovereignty per trust domain', () => {
    const local = provider('local-openai-compatible', 'local');
    const gemini = provider('google-gemini', 'cloud');

    expect(() => assertEmbeddingProviderForLane('secure_local', local)).not.toThrow();
    expect(() => assertEmbeddingProviderForLane('internal', gemini)).not.toThrow();
    expect(() => assertEmbeddingProviderForLane('secure_local', gemini))
      .toThrow('local/private embedding provider');
    expect(() => assertEmbeddingProviderForLane('internal', local))
      .toThrow('sovereignty-resolved Gemini provider');
  });

  test('requires an explicit write enable before constructing runtime options', () => {
    expect(() => optionsFromEnv({})).toThrow(
      'OLYMPUS_SOURCE_EMBEDDING_DRAIN_ENABLED=true',
    );
  });

  test('the actual Dropbox store switch constructs the roster and can disable the lane', () => {
    const options = optionsFromEnv({
      OLYMPUS_SOURCE_EMBEDDING_DRAIN_ENABLED: 'true',
      OLYMPUS_SOURCE_EMBEDDING_DRAIN_DROPBOX_STORE_ENABLED: 'false',
    });
    expect(options.lanes).toEqual([]);
  });

  test('direct mode refuses a retained file-family chunk before the cloud provider is invoked', async () => {
    const root = mkdtempSync(join(tmpdir(), 'olympus-embedding-direct-file-scope-'));
    const dbPath = join(root, 'drive.sqlite');
    const store = new LocalConnectorStore({
      dbPath,
      corpusId: 'internal.drive.docs',
      family: 'file',
      trustDomain: 'internal',
    });
    const item: RawItem = {
      identity: {
        family: 'file',
        provider: 'google_drive',
        accountScope: 'personal',
        providerItemId: 'retained-out-of-scope',
        providerFileId: 'retained-out-of-scope',
        localItemId: 'personal:retained-out-of-scope',
        sourceVersion: 'r1',
      },
      mimeType: 'text/plain',
      content: { kind: 'text', text: 'retained content from a superseded folder approval' },
      metadata: Object.freeze({ name: 'retained.txt' }),
      fetchedAt: '2026-09-10T10:00:00.000Z',
    };
    const connector: SourceConnector = {
      id: 'direct-file-scope-fixture',
      family: 'file',
      async authenticate() {},
      async *listItems() { yield { items: [item], done: true }; },
      async fetchItem() { return item; },
      classify() { return { trustTier: 'S3', trustDomain: 'internal', cloudEmbeddingEligible: true, localOnly: false }; },
    };
    await store.syncFromConnector(connector, { fetchContent: true });
    store.close();
    let providerCalls = 0;
    const cloud = provider('google-gemini', 'cloud');
    cloud.embed = async (inputs) => {
      providerCalls += 1;
      return inputs.map(() => Array(8).fill(0));
    };
    const client = new DirectSourceEmbeddingDrainClient({
      connectorStores: [{
        corpusId: 'internal.drive.docs',
        dbPath,
        family: 'file',
        trustDomain: 'internal',
      }],
      secureLocalProvider: provider('local-openai-compatible', 'local'),
      internalProvider: cloud,
    });
    try {
      await expect(client.embedConnectorStore({ corpus_id: 'internal.drive.docs' }))
        .rejects.toThrow('Use the default HTTP drain mode');
      expect(providerCalls).toBe(0);
    } finally {
      client.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('publishes a private content-free readiness receipt bound to the native nonce and pid', () => {
    const root = mkdtempSync(join(tmpdir(), 'olympus-embedding-ready-'));
    const path = join(root, 'state', 'readiness.json');
    try {
      publishNativeEmbeddingDrainReadiness({
        OLYMPUS_SOURCE_EMBEDDING_DRAIN_INSTANCE_ID: '85f6c04a-e3cd-4d0c-91d4-d38954bd90dd',
        OLYMPUS_SOURCE_EMBEDDING_DRAIN_READINESS_PATH: path,
      }, 4242);
      expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({
        kind: 'source_embedding_drain_service_readiness',
        schema_version: 1,
        instance_id: '85f6c04a-e3cd-4d0c-91d4-d38954bd90dd',
        pid: 4242,
        options_validated: true,
        content_free: true,
      });
      expect(statSync(path).mode & 0o077).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('does not publish readiness into a directory writable by other users', () => {
    const root = mkdtempSync(join(tmpdir(), 'olympus-embedding-shared-'));
    const path = join(root, 'readiness.json');
    try {
      chmodSync(root, 0o777);
      expect(() => publishNativeEmbeddingDrainReadiness({
        OLYMPUS_SOURCE_EMBEDDING_DRAIN_INSTANCE_ID: '85f6c04a-e3cd-4d0c-91d4-d38954bd90dd',
        OLYMPUS_SOURCE_EMBEDDING_DRAIN_READINESS_PATH: path,
      })).toThrow('owner-controlled report directory');
      expect(existsSync(path)).toBe(false);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test('refuses invalid native identity before any provider write', async () => {
    const root = mkdtempSync(join(tmpdir(), 'olympus-embedding-invalid-native-'));
    let requests = 0;
    const server = Bun.serve({
      port: 0,
      fetch() {
        requests += 1;
        return Response.json({ ok: true });
      },
    });
    try {
      const child = Bun.spawn([
        process.execPath,
        join(import.meta.dir, '..', 'scripts', 'source-embedding-drain.ts'),
        '--report',
        join(root, 'report.json'),
      ], {
        env: {
          HOME: root,
          PATH: process.env.PATH ?? '',
          OLYMPUS_CONFIG: join(root, 'missing-config.json'),
          OLYMPUS_SOURCE_EMBEDDING_DRAIN_ENABLED: 'true',
          OLYMPUS_SOURCE_EMBEDDING_DRAIN_BASE_URL: `http://127.0.0.1:${server.port}/v1`,
          OLYMPUS_SOURCE_EMBEDDING_DRAIN_INSTANCE_ID: 'not-a-uuid',
          OLYMPUS_SOURCE_EMBEDDING_DRAIN_READINESS_PATH: join(root, 'readiness.json'),
        },
        stdout: 'pipe',
        stderr: 'pipe',
      });
      expect(await child.exited).not.toBe(0);
      expect(requests).toBe(0);
      expect(await new Response(child.stderr).text()).toContain('must be a canonical UUID');
    } finally {
      server.stop(true);
      rmSync(root, { recursive: true, force: true });
    }
  }, 15_000);
});

function provider(
  providerName: string,
  backend: 'local' | 'cloud',
): SourceEmbeddingProvider {
  return {
    provider: providerName,
    modelId: 'fixture',
    dimension: 8,
    configHash: 'fixture',
    epochId: `${backend}:${providerName}:fixture:8`,
    backend,
    async embed(inputs) {
      return inputs.map(() => Array(8).fill(0));
    },
  };
}
