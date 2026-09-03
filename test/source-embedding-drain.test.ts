import { describe, expect, test } from 'bun:test';
import {
  assertEmbeddingProviderForLane,
  optionsFromEnv,
  runSourceEmbeddingDrain,
  sourceEmbeddingLaneRosterFromEnv,
  type CorpusEmbeddingRequest,
  type SourceEmbeddingDrainClient,
} from '../scripts/source-embedding-drain.ts';
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
