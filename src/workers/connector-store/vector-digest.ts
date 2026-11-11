import type { Database } from 'bun:sqlite';
import { decodeEmbedding } from '../source-index/embeddings.ts';
import { encodeVectorDigest } from '../source-index/vector-digest.ts';

/** Additive v16 migration. Vector bytes are never walked during schema migration. */
export function createVectorDigestSchema(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS chunk_vector_digest (
      chunk_pk INTEGER PRIMARY KEY,
      model_id TEXT NOT NULL,
      item_pk INTEGER NOT NULL,
      account_scope TEXT,
      digest BLOB NOT NULL,
      FOREIGN KEY(chunk_pk) REFERENCES chunks(chunk_pk) ON DELETE CASCADE
    );
    -- Per-model store metadata: physical rowid cursor resumes without the
    -- random primary-key-index reads that made the old lane IO-bound.
    CREATE TABLE IF NOT EXISTS chunk_vector_digest_meta (
      model_id TEXT PRIMARY KEY, cursor_rowid INTEGER NOT NULL, completed INTEGER NOT NULL
    );
    CREATE TRIGGER IF NOT EXISTS connector_store_vector_digest_delete
    AFTER DELETE ON chunk_embeddings BEGIN
      DELETE FROM chunk_vector_digest WHERE chunk_pk = OLD.chunk_pk AND model_id = OLD.model_id;
    END;
    CREATE TRIGGER IF NOT EXISTS connector_store_vector_digest_account
    AFTER UPDATE OF account_scope ON items WHEN OLD.account_scope IS NOT NEW.account_scope BEGIN
      UPDATE chunk_vector_digest SET account_scope = NEW.account_scope
        WHERE chunk_pk IN (SELECT chunk_pk FROM chunks WHERE item_pk = NEW.item_pk);
    END;
  `);
}

export function vectorDigestState(db: Database, modelId: string): { cursorRowid: number; completed: boolean } {
  const row = db.query('SELECT cursor_rowid, completed FROM chunk_vector_digest_meta WHERE model_id = ?')
    .get(modelId) as { cursor_rowid: number; completed: number } | null;
  return { cursorRowid: row?.cursor_rowid ?? 0, completed: row?.completed === 1 };
}

/** Caller holds the same transaction as the embedding upsert. */
export function writeVectorDigest(db: Database, chunkPk: number, modelId: string, itemPk: number, embedding: unknown): void {
  // One slot per chunk, as specified by the table contract. Displacing another
  // model invalidates that model's completion receipt and restarts its cursor.
  db.query(`UPDATE chunk_vector_digest_meta SET completed = 0, cursor_rowid = 0
    WHERE model_id = (SELECT model_id FROM chunk_vector_digest WHERE chunk_pk = ? AND model_id <> ?)`)
    .run(chunkPk, modelId);
  db.query(`INSERT INTO chunk_vector_digest(chunk_pk, model_id, item_pk, account_scope, digest)
    SELECT ?, ?, ?, account_scope, ? FROM items WHERE item_pk = ?
    ON CONFLICT(chunk_pk) DO UPDATE SET model_id = excluded.model_id,
      item_pk = excluded.item_pk, account_scope = excluded.account_scope, digest = excluded.digest`)
    .run(chunkPk, modelId, itemPk, encodeVectorDigest(decodeEmbedding(embedding)), itemPk);
  // A newly written model starts complete: its first vector and this receipt
  // commit together, and every subsequent vector maintains its digest. A
  // legacy model with other rows starts incomplete. The model-leading index
  // needs at most two entries to distinguish these cases; never COUNT/scan it.
  db.query(`INSERT OR IGNORE INTO chunk_vector_digest_meta(model_id, cursor_rowid, completed)
    SELECT ?, 0, NOT EXISTS(
      SELECT 1 FROM chunk_embeddings WHERE model_id = ? AND chunk_pk <> ? LIMIT 1
    )`).run(modelId, modelId, chunkPk);
}

export function backfillVectorDigests(db: Database, modelId: string, maxRows = 128): { cursorRowid: number; completed: boolean; scanned: number } {
  if (!Number.isInteger(maxRows) || maxRows < 1 || maxRows > 256) throw new Error('Vector digest slice must contain 1 to 256 rows.');
  // A competing writer must not turn a small background slice into a
  // ten-second busy_timeout wait on the worker's request thread.
  const timeout = (db.query('PRAGMA busy_timeout').get() as { timeout: number }).timeout;
  db.exec('PRAGMA busy_timeout = 25');
  try {
    return db.transaction(() => {
      const state = vectorDigestState(db, modelId);
      if (state.completed) return { ...state, scanned: 0 };
      // Range over the rowid table, not its (chunk_pk,model_id) index. Walk all
      // models in bounded physical windows so a rare model cannot cause a long
      // synchronous statement while searching for the next matching row.
      const rows = db.query(`SELECT rowid, chunk_pk, model_id, item_pk, embedding FROM chunk_embeddings
        WHERE rowid > ? ORDER BY rowid LIMIT ?`).all(state.cursorRowid, maxRows) as Array<{
          rowid: number; chunk_pk: number; model_id: string; item_pk: number; embedding: Uint8Array;
        }>;
      for (const row of rows) if (row.model_id === modelId) writeVectorDigest(db, row.chunk_pk, modelId, row.item_pk, row.embedding);
      const cursorRowid = rows.at(-1)?.rowid ?? state.cursorRowid;
      const completed = rows.length < maxRows;
      db.query(`INSERT INTO chunk_vector_digest_meta VALUES (?, ?, ?)
        ON CONFLICT(model_id) DO UPDATE SET cursor_rowid = excluded.cursor_rowid, completed = excluded.completed`)
        .run(modelId, cursorRowid, Number(completed));
      return { cursorRowid, completed, scanned: rows.length };
    })();
  } finally { db.exec(`PRAGMA busy_timeout = ${timeout}`); }
}
