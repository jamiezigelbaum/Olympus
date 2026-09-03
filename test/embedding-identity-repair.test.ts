// The repair tool's preconditions, stated as tests.
//
// The tool exists because live stores hold genuinely-correct vectors under a
// wrong epoch label. Its whole value is that it corrects the label and does
// nothing else, so most of what is pinned here is what it REFUSES to do.

import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { repairEmbeddingIdentities } from '../src/workers/source-index/embedding-identity-repair.ts';
import {
  formatEmbeddingIdentityRepairReport,
  parseEmbeddingIdentityRepairCliArgs,
} from '../scripts/embedding-identity-repair.ts';

const QWEN3_EPOCH = 'local:openai-compatible:secure-local-qwen3-embed:2560';
const GEMINI_EPOCH = 'cloud:google-gemini:gemini-embedding-2:provider-reported';
const CONTAMINATED_GEMINI_EPOCH = 'local:openai-compatible:secure-local-qwen3-embed:2560';

function vector(dimension: number): Uint8Array {
  return new Uint8Array(new Float32Array(dimension).buffer);
}

// A connector store, reduced to the three tables the repair touches or reads.
function connectorStoreDb(): Database {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE embedding_models (
      model_id TEXT PRIMARY KEY,
      provider TEXT NOT NULL,
      dimension INTEGER NOT NULL,
      embedding_backend TEXT NOT NULL,
      embedding_epoch TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE chunk_embeddings (
      chunk_pk INTEGER NOT NULL,
      model_id TEXT NOT NULL,
      item_pk INTEGER NOT NULL,
      content_hash TEXT NOT NULL,
      embedding BLOB NOT NULL,
      embedded_at TEXT NOT NULL,
      PRIMARY KEY (chunk_pk, model_id)
    );
    CREATE TABLE sync_runs (
      sync_run_id TEXT NOT NULL,
      connector_id TEXT NOT NULL,
      status TEXT NOT NULL,
      cursor TEXT
    );
  `);
  return db;
}

function insertModel(db: Database, row: {
  modelId: string;
  provider: string;
  dimension: number;
  backend: string;
  epoch: string;
}): void {
  db.query(`
    INSERT INTO embedding_models
      (model_id, provider, dimension, embedding_backend, embedding_epoch, created_at)
    VALUES (?, ?, ?, ?, ?, '2026-08-24T00:00:00.000Z')
  `).run(row.modelId, row.provider, row.dimension, row.backend, row.epoch);
}

function insertVectors(db: Database, modelId: string, dimension: number, count: number): void {
  for (let index = 0; index < count; index += 1) {
    db.query(`
      INSERT INTO chunk_embeddings
        (chunk_pk, model_id, item_pk, content_hash, embedding, embedded_at)
      VALUES (?, ?, ?, 'hash', ?, '2026-08-24T00:00:00.000Z')
    `).run(index + 1, modelId, index + 1, vector(dimension));
  }
}

function contaminatedGeminiStore(): Database {
  const db = connectorStoreDb();
  insertModel(db, {
    modelId: 'gemini-embedding-2',
    provider: 'google-gemini',
    dimension: 3072,
    backend: 'cloud',
    epoch: CONTAMINATED_GEMINI_EPOCH,
  });
  insertVectors(db, 'gemini-embedding-2', 3072, 3);
  return db;
}

function row(report: ReturnType<typeof repairEmbeddingIdentities>, modelId: string) {
  const found = report.rows.find((entry) => entry.modelId === modelId);
  expect(found).toBeDefined();
  return found!;
}

describe('embedding identity repair', () => {
  test('corrects only the epoch on a verified contaminated row', () => {
    const db = contaminatedGeminiStore();
    try {
      const dryRun = repairEmbeddingIdentities(db);
      expect(dryRun.execute).toBe(false);
      expect(dryRun.vectorTables).toEqual(['chunk_embeddings']);
      expect(row(dryRun, 'gemini-embedding-2')).toMatchObject({
        decision: 'would_repair',
        reason: 'epoch_corrected_vectors_verified',
        storedEpoch: CONTAMINATED_GEMINI_EPOCH,
        canonicalEpoch: GEMINI_EPOCH,
        dimension: 3072,
        vectorRows: 3,
        vectorByteLength: 3072 * 4,
      });
      expect(dryRun.wouldRepair).toBe(1);
      expect(dryRun.repaired).toBe(0);

      // A dry run writes nothing.
      expect(db.query('SELECT embedding_epoch AS epoch FROM embedding_models').get())
        .toEqual({ epoch: CONTAMINATED_GEMINI_EPOCH });

      const applied = repairEmbeddingIdentities(db, { execute: true });
      expect(applied.repaired).toBe(1);
      expect(applied.refused).toBe(0);
      expect(row(applied, 'gemini-embedding-2').decision).toBe('repaired');

      const stored = db.query(`
        SELECT model_id, provider, dimension, embedding_backend, embedding_epoch
        FROM embedding_models
      `).get();
      expect(stored).toEqual({
        model_id: 'gemini-embedding-2',
        provider: 'google-gemini',
        dimension: 3072,
        embedding_backend: 'cloud',
        embedding_epoch: GEMINI_EPOCH,
      });
    } finally {
      db.close();
    }
  });

  test('leaves every vector exactly where it was', () => {
    const db = contaminatedGeminiStore();
    try {
      const before = db.query(`
        SELECT chunk_pk, model_id, length(embedding) AS bytes FROM chunk_embeddings ORDER BY chunk_pk
      `).all();
      repairEmbeddingIdentities(db, { execute: true });
      const after = db.query(`
        SELECT chunk_pk, model_id, length(embedding) AS bytes FROM chunk_embeddings ORDER BY chunk_pk
      `).all();
      expect(after).toEqual(before);
      expect(after).toHaveLength(3);
    } finally {
      db.close();
    }
  });

  test('is idempotent: the second run finds nothing left to do', () => {
    const db = contaminatedGeminiStore();
    try {
      repairEmbeddingIdentities(db, { execute: true });
      const second = repairEmbeddingIdentities(db, { execute: true });
      expect(second.repaired).toBe(0);
      expect(second.refused).toBe(0);
      expect(row(second, 'gemini-embedding-2')).toMatchObject({
        decision: 'already_canonical',
        reason: 'epoch_is_canonical',
      });
    } finally {
      db.close();
    }
  });

  test('refuses a row whose declared dimension is not the canonical one', () => {
    const db = connectorStoreDb();
    try {
      insertModel(db, {
        modelId: 'gemini-embedding-2',
        provider: 'google-gemini',
        dimension: 1536,
        backend: 'cloud',
        epoch: CONTAMINATED_GEMINI_EPOCH,
      });
      insertVectors(db, 'gemini-embedding-2', 1536, 1);
      const report = repairEmbeddingIdentities(db, { execute: true });
      expect(row(report, 'gemini-embedding-2')).toMatchObject({
        decision: 'refused',
        reason: 'dimension_mismatch',
      });
      expect(report.refused).toBe(1);
      expect(db.query('SELECT embedding_epoch AS epoch FROM embedding_models').get())
        .toEqual({ epoch: CONTAMINATED_GEMINI_EPOCH });
    } finally {
      db.close();
    }
  });

  test('refuses a row whose stored vectors are the wrong width', () => {
    const db = connectorStoreDb();
    try {
      insertModel(db, {
        modelId: 'gemini-embedding-2',
        provider: 'google-gemini',
        dimension: 3072,
        backend: 'cloud',
        epoch: CONTAMINATED_GEMINI_EPOCH,
      });
      // Declared 3072, but the blob is a 2560-float vector: the row may well
      // describe qwen3 output, so its label is not safely correctable.
      insertVectors(db, 'gemini-embedding-2', 2560, 1);
      const report = repairEmbeddingIdentities(db, { execute: true });
      expect(row(report, 'gemini-embedding-2')).toMatchObject({
        decision: 'refused',
        reason: 'vector_byte_length_mismatch',
        vectorByteLength: 2560 * 4,
      });
      expect(db.query('SELECT embedding_epoch AS epoch FROM embedding_models').get())
        .toEqual({ epoch: CONTAMINATED_GEMINI_EPOCH });
    } finally {
      db.close();
    }
  });

  test('refuses an epoch variant it has never seen', () => {
    const db = connectorStoreDb();
    try {
      insertModel(db, {
        modelId: 'gemini-embedding-2',
        provider: 'google-gemini',
        dimension: 3072,
        backend: 'cloud',
        // A same-family operator bump. Legitimate, unverifiable here.
        epoch: 'cloud:google-gemini:gemini-embedding-2:2026-09',
      });
      insertVectors(db, 'gemini-embedding-2', 3072, 1);
      const report = repairEmbeddingIdentities(db, { execute: true });
      expect(row(report, 'gemini-embedding-2')).toMatchObject({
        decision: 'refused',
        reason: 'unknown_epoch_variant',
      });
      expect(db.query('SELECT embedding_epoch AS epoch FROM embedding_models').get())
        .toEqual({ epoch: 'cloud:google-gemini:gemini-embedding-2:2026-09' });
    } finally {
      db.close();
    }
  });

  test('skips a model with no canonical identity', () => {
    const db = connectorStoreDb();
    try {
      insertModel(db, {
        modelId: 'olympus-deterministic-source-embedding-v1',
        provider: 'deterministic-source-test',
        dimension: 48,
        backend: 'local',
        epoch: 'local:deterministic-source-test:olympus-deterministic-source-embedding-v1:48',
      });
      const report = repairEmbeddingIdentities(db, { execute: true });
      expect(row(report, 'olympus-deterministic-source-embedding-v1')).toMatchObject({
        decision: 'skipped',
        reason: 'no_canonical_identity_for_model',
      });
      expect(report.repaired).toBe(0);
      expect(report.refused).toBe(0);
    } finally {
      db.close();
    }
  });

  test('reports connector-store authority drift without touching it', () => {
    const db = contaminatedGeminiStore();
    try {
      const cursor = JSON.stringify({
        kind: 'connector_store_embedding_write_authority_v2',
        modelId: 'gemini-embedding-2',
        embeddingProvider: 'google-gemini',
        embeddingBackend: 'cloud',
        embeddingDimension: 3072,
        embeddingEpoch: CONTAMINATED_GEMINI_EPOCH,
        embeddingConfigHash: 'hash',
        providerEpoch: 1,
      });
      db.query(`
        INSERT INTO sync_runs (sync_run_id, connector_id, status, cursor)
        VALUES ('authority', 'connector_store_embedding_write_authority', 'running', ?)
      `).run(cursor);

      const report = repairEmbeddingIdentities(db, { execute: true });
      expect(report.authority).toEqual([{
        modelId: 'gemini-embedding-2',
        authorityEpoch: CONTAMINATED_GEMINI_EPOCH,
        canonicalEpoch: GEMINI_EPOCH,
        matchesCanonical: false,
      }]);
      // Read-only: the bind path owns this row.
      expect(db.query('SELECT cursor FROM sync_runs').get()).toEqual({ cursor });
    } finally {
      db.close();
    }
  });

  test('handles the legacy Dropbox index shape, stray Gemini row included', () => {
    const db = new Database(':memory:');
    try {
      db.exec(`
        CREATE TABLE embedding_models (
          model_id TEXT PRIMARY KEY,
          provider TEXT NOT NULL,
          dimension INTEGER NOT NULL,
          config_hash TEXT NOT NULL,
          embedding_backend TEXT NOT NULL,
          embedding_epoch TEXT NOT NULL
        );
        CREATE TABLE content_chunk_embeddings_secure_local (
          chunk_id INTEGER NOT NULL,
          model_id TEXT NOT NULL,
          local_entry_id TEXT NOT NULL,
          source_content_hash TEXT NOT NULL,
          embedding BLOB NOT NULL
        );
      `);
      const insert = db.query(`
        INSERT INTO embedding_models
          (model_id, provider, dimension, config_hash, embedding_backend, embedding_epoch)
        VALUES (?, ?, ?, 'hash', ?, ?)
      `);
      insert.run('secure-local-qwen3-embed', 'local-openai-compatible', 2560, 'local', QWEN3_EPOCH);
      // The stray: a Gemini row carrying the local model's epoch, with no
      // vectors of its own.
      insert.run('gemini-embedding-2', 'google-gemini', 3072, 'cloud', CONTAMINATED_GEMINI_EPOCH);
      db.query(`
        INSERT INTO content_chunk_embeddings_secure_local
          (chunk_id, model_id, local_entry_id, source_content_hash, embedding)
        VALUES (1, 'secure-local-qwen3-embed', 'entry', 'hash', ?)
      `).run(vector(2560));

      const report = repairEmbeddingIdentities(db, { execute: true });
      expect(report.vectorTables).toEqual(['content_chunk_embeddings_secure_local']);
      expect(row(report, 'secure-local-qwen3-embed')).toMatchObject({
        decision: 'already_canonical',
        vectorRows: 1,
        vectorByteLength: 2560 * 4,
      });
      expect(row(report, 'gemini-embedding-2')).toMatchObject({
        decision: 'repaired',
        reason: 'provenance_only_no_vectors',
        vectorRows: 0,
      });
      expect(db.query(`
        SELECT model_id, embedding_epoch FROM embedding_models ORDER BY model_id
      `).all()).toEqual([
        { model_id: 'gemini-embedding-2', embedding_epoch: GEMINI_EPOCH },
        { model_id: 'secure-local-qwen3-embed', embedding_epoch: QWEN3_EPOCH },
      ]);
      // The qwen3 vector is untouched.
      expect(db.query(`
        SELECT COUNT(*) AS rows FROM content_chunk_embeddings_secure_local
      `).get()).toEqual({ rows: 1 });
    } finally {
      db.close();
    }
  });

  test('corrects the qwen3 alternation variants', () => {
    for (const contaminated of [
      'local:local-openai-compatible:secure-local-qwen3-embed:2560',
      'local:local-openai-compatible:secure-local-qwen3-embed:provider-reported',
    ]) {
      const db = connectorStoreDb();
      try {
        insertModel(db, {
          modelId: 'secure-local-qwen3-embed',
          provider: 'local-openai-compatible',
          dimension: 2560,
          backend: 'local',
          epoch: contaminated,
        });
        insertVectors(db, 'secure-local-qwen3-embed', 2560, 2);
        const report = repairEmbeddingIdentities(db, { execute: true });
        expect(row(report, 'secure-local-qwen3-embed').decision).toBe('repaired');
        expect(db.query('SELECT embedding_epoch AS epoch FROM embedding_models').get())
          .toEqual({ epoch: QWEN3_EPOCH });
      } finally {
        db.close();
      }
    }
  });

  test('refuses a database with no embedding provenance table', () => {
    const db = new Database(':memory:');
    try {
      db.exec('CREATE TABLE items (item_pk INTEGER PRIMARY KEY)');
      expect(() => repairEmbeddingIdentities(db)).toThrow('no repairable embedding_models table');
    } finally {
      db.close();
    }
  });
});

describe('embedding identity repair CLI', () => {
  test('is dry run unless --execute is passed', () => {
    expect(parseEmbeddingIdentityRepairCliArgs(['--db', '/tmp/store.sqlite']))
      .toEqual({ db: '/tmp/store.sqlite', execute: false, json: false, authority: false });
    expect(parseEmbeddingIdentityRepairCliArgs(['--db', '/tmp/store.sqlite', '--execute', '--json']))
      .toEqual({ db: '/tmp/store.sqlite', execute: true, json: true, authority: false });
    expect(parseEmbeddingIdentityRepairCliArgs(['--db', '/tmp/store.sqlite', '--authority']))
      .toEqual({ db: '/tmp/store.sqlite', execute: false, json: false, authority: true });
    expect(() => parseEmbeddingIdentityRepairCliArgs([])).toThrow('Usage:');
    expect(() => parseEmbeddingIdentityRepairCliArgs(['--db'])).toThrow('--db requires a value.');
    expect(() => parseEmbeddingIdentityRepairCliArgs(['--nope'])).toThrow('Unknown flag --nope');
  });

  test('prints the stored and canonical epoch for every row it reports', () => {
    const db = contaminatedGeminiStore();
    try {
      const printed = formatEmbeddingIdentityRepairReport(repairEmbeddingIdentities(db));
      expect(printed).toContain('dry run');
      expect(printed).toContain('would_repair');
      expect(printed).toContain(CONTAMINATED_GEMINI_EPOCH);
      expect(printed).toContain(GEMINI_EPOCH);
      expect(printed).toContain('repaired=0 would_repair=1 refused=0');
    } finally {
      db.close();
    }
  });
});

// The write-authority half. Its preconditions mirror the provenance repair's,
// plus one of its own: the receipt must already equal hashString(cursor) —
// the bind path's integrity check — or the row is refused untouched.
import {
  repairEmbeddingWriteAuthorities,
} from '../src/workers/source-index/embedding-identity-repair.ts';
import { hashString } from '../src/workers/connector-store/local-index.ts';

function authorityDb(): Database {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE embedding_models (
      model_id TEXT PRIMARY KEY,
      provider TEXT NOT NULL,
      dimension INTEGER NOT NULL,
      embedding_backend TEXT NOT NULL,
      embedding_epoch TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE chunk_embeddings (
      chunk_pk INTEGER NOT NULL,
      model_id TEXT NOT NULL,
      item_pk INTEGER NOT NULL,
      content_hash TEXT NOT NULL,
      embedding BLOB NOT NULL,
      embedded_at TEXT NOT NULL,
      PRIMARY KEY (chunk_pk, model_id)
    );
    CREATE TABLE sync_runs (
      sync_run_id TEXT NOT NULL,
      connector_id TEXT NOT NULL,
      status TEXT NOT NULL,
      cursor TEXT,
      audit_receipt_sha256 TEXT
    );
  `);
  return db;
}

// Field order matches the live rows observed on the private host 2026-08-24.
function insertAuthority(db: Database, record: Record<string, unknown>, options?: {
  corruptReceipt?: boolean;
}): string {
  const cursor = JSON.stringify(record);
  db.query(`
    INSERT INTO sync_runs (sync_run_id, connector_id, status, cursor, audit_receipt_sha256)
    VALUES ('authority-1', 'connector_store_embedding_write_authority', 'running', ?, ?)
  `).run(cursor, options?.corruptReceipt ? 'not-the-hash' : hashString(cursor));
  return cursor;
}

function geminiAuthorityRecord(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    kind: 'connector_store_embedding_write_authority_v2',
    modelId: 'gemini-embedding-2',
    embeddingProvider: 'google-gemini',
    embeddingBackend: 'cloud',
    embeddingDimension: 3072,
    embeddingEpoch: CONTAMINATED_GEMINI_EPOCH,
    embeddingConfigHash: '5932c86ef3b0a2ff036995be64dbac0ebab7b35ce638d0aeef9162281b3b0574',
    providerEpoch: 2,
    currencyRebuildPending: true,
    ...overrides,
  };
}

describe('embedding write-authority repair', () => {
  test('corrects the epoch, recomputes the receipt, and preserves every other field', () => {
    const db = authorityDb();
    try {
      insertVectors(db, 'gemini-embedding-2', 3072, 2);
      insertAuthority(db, geminiAuthorityRecord());

      const rows = repairEmbeddingWriteAuthorities(db, { execute: true });
      expect(rows).toHaveLength(1);
      expect(rows[0]!.decision).toBe('repaired');
      expect(rows[0]!.reason).toBe('authority_epoch_corrected_vectors_verified');

      const stored = db.query(
        "SELECT cursor, audit_receipt_sha256 FROM sync_runs WHERE connector_id = 'connector_store_embedding_write_authority'",
      ).get() as { cursor: string; audit_receipt_sha256: string };
      const parsed = JSON.parse(stored.cursor);
      expect(parsed.embeddingEpoch).toBe(GEMINI_EPOCH);
      // The bind path's own integrity check must hold on the rewritten row.
      expect(stored.audit_receipt_sha256).toBe(hashString(stored.cursor));
      // Nothing but the epoch moved.
      expect(parsed.embeddingConfigHash).toBe('5932c86ef3b0a2ff036995be64dbac0ebab7b35ce638d0aeef9162281b3b0574');
      expect(parsed.providerEpoch).toBe(2);
      expect(parsed.currencyRebuildPending).toBe(true);
      // Key order is preserved: epoch replaced in place, not re-shaped.
      expect(Object.keys(parsed)).toEqual(Object.keys(geminiAuthorityRecord()));

      // Idempotent: the second run reports already_canonical and writes nothing.
      const again = repairEmbeddingWriteAuthorities(db, { execute: true });
      expect(again[0]!.decision).toBe('already_canonical');
    } finally {
      db.close();
    }
  });

  test('dry run reports would_repair and writes nothing', () => {
    const db = authorityDb();
    try {
      insertVectors(db, 'gemini-embedding-2', 3072, 1);
      const cursor = insertAuthority(db, geminiAuthorityRecord());

      const rows = repairEmbeddingWriteAuthorities(db);
      expect(rows[0]!.decision).toBe('would_repair');
      const stored = db.query('SELECT cursor FROM sync_runs').get() as { cursor: string };
      expect(stored.cursor).toBe(cursor);
    } finally {
      db.close();
    }
  });

  test('refuses a row whose receipt fails the bind path integrity check', () => {
    const db = authorityDb();
    try {
      insertVectors(db, 'gemini-embedding-2', 3072, 1);
      insertAuthority(db, geminiAuthorityRecord(), { corruptReceipt: true });

      const rows = repairEmbeddingWriteAuthorities(db, { execute: true });
      expect(rows[0]!.decision).toBe('refused');
      expect(rows[0]!.reason).toBe('authority_receipt_integrity_failed');
    } finally {
      db.close();
    }
  });

  test('refuses on dimension mismatch and on vectors of the wrong width', () => {
    const db = authorityDb();
    try {
      insertAuthority(db, geminiAuthorityRecord({ embeddingDimension: 2560 }));
      const rows = repairEmbeddingWriteAuthorities(db, { execute: true });
      expect(rows[0]!.decision).toBe('refused');
      expect(rows[0]!.reason).toBe('dimension_mismatch');
    } finally {
      db.close();
    }
    const db2 = authorityDb();
    try {
      insertVectors(db2, 'gemini-embedding-2', 2560, 1);
      insertAuthority(db2, geminiAuthorityRecord());
      const rows = repairEmbeddingWriteAuthorities(db2, { execute: true });
      expect(rows[0]!.decision).toBe('refused');
      expect(rows[0]!.reason).toBe('vector_byte_length_mismatch');
    } finally {
      db2.close();
    }
  });

  test('refuses an epoch that is not a known contaminated variant', () => {
    const db = authorityDb();
    try {
      insertAuthority(db, geminiAuthorityRecord({
        embeddingEpoch: 'cloud:google-gemini:gemini-embedding-2:2026-09-01',
      }));
      const rows = repairEmbeddingWriteAuthorities(db, { execute: true });
      expect(rows[0]!.decision).toBe('refused');
      expect(rows[0]!.reason).toBe('unknown_epoch_variant');
    } finally {
      db.close();
    }
  });

  test('returns nothing on a store without the receipt column instead of guessing', () => {
    const db = connectorStoreDb();
    try {
      expect(repairEmbeddingWriteAuthorities(db, { execute: true })).toEqual([]);
    } finally {
      db.close();
    }
  });
});
