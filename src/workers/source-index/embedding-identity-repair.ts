// Corrects a contaminated `embedding_models.embedding_epoch` in place, and
// nothing else.
//
// The rows this exists for are real: on the private host the X and Readwise connector
// stores each hold a `gemini-embedding-2` row at dimension 3072 whose epoch
// reads `local:openai-compatible:secure-local-qwen3-embed:2560` — a local
// model's epoch on genuinely-Gemini vectors, stamped by a provider-blind
// environment variable. The vectors are fine. Only the label is wrong.
//
// So the repair is deliberately the smallest thing that can fix the label:
//
//   UPDATE embedding_models SET embedding_epoch = ? WHERE model_id = ? AND embedding_epoch = ?
//
// It never deletes anything, never reads or writes `chunk_embeddings` (or any
// other vector table) except to MEASURE one blob's byte length, and never
// changes `model_id` or `dimension`. A row it is not certain about is refused
// with a named reason rather than nudged toward something plausible — the
// failure mode being avoided is a wrong-but-confident relabel, which is
// indistinguishable from corruption after the fact.
//
// ## What it cannot fix
//
// A connector store's vector-invalidation decision is made against the write
// authority in `sync_runs`, not against this provenance row (see
// `connectorStoreEmbeddingWriteAuthorityMatches`). Repairing the provenance
// row therefore records the truth; it does not by itself defuse a pending
// rebind. The authority row belongs to the bind path and is READ here — never
// written — so the report can name a store whose authority still disagrees.

import type { Database } from 'bun:sqlite';
import { OperationError } from '../../core/operation-error.ts';
import { hashString } from '../connector-store/local-index.ts';
import {
  canonicalEmbeddingIdentityForModel,
  contaminatedEmbeddingEpoch,
} from './embedding-identity.ts';

export type EmbeddingIdentityRepairDecision =
  | 'repaired'
  | 'would_repair'
  | 'already_canonical'
  | 'skipped'
  | 'refused';

export interface EmbeddingIdentityRepairRow {
  modelId: string;
  dimension: number;
  storedEpoch: string;
  canonicalEpoch?: string;
  vectorRows: number;
  vectorByteLength?: number;
  decision: EmbeddingIdentityRepairDecision;
  reason: string;
}

export interface EmbeddingIdentityAuthorityObservation {
  modelId: string;
  authorityEpoch: string;
  canonicalEpoch?: string;
  matchesCanonical: boolean;
}

export interface EmbeddingIdentityAuthorityRepairRow {
  syncRunId: string;
  modelId: string;
  dimension?: number;
  storedEpoch: string;
  canonicalEpoch?: string;
  vectorRows: number;
  vectorByteLength?: number;
  decision: EmbeddingIdentityRepairDecision;
  reason: string;
}

export interface EmbeddingIdentityRepairReport {
  execute: boolean;
  vectorTables: string[];
  rows: EmbeddingIdentityRepairRow[];
  repaired: number;
  wouldRepair: number;
  refused: number;
  /**
   * Read-only: connector-store write-authority epochs that disagree with the
   * canon. Reported because a store can hold a corrected provenance row and
   * still be one embed away from a rebind.
   */
  authority: EmbeddingIdentityAuthorityObservation[];
}

const EMBEDDING_MODELS_TABLE = 'embedding_models';
const WRITE_AUTHORITY_CONNECTOR_ID = 'connector_store_embedding_write_authority';
const FLOAT32_BYTES = 4;

/**
 * Idempotent by construction: the second run sees canonical epochs, which are
 * not in the contaminated set, and reports `already_canonical` for every row
 * it corrected on the first.
 */
export function repairEmbeddingIdentities(
  db: Database,
  options: { execute?: boolean } = {},
): EmbeddingIdentityRepairReport {
  const execute = options.execute === true;
  assertEmbeddingModelsTable(db);
  const vectorTables = discoverVectorTables(db);
  const rows: EmbeddingIdentityRepairRow[] = [];

  const stored = db.query(`
    SELECT model_id, dimension, embedding_epoch
    FROM ${EMBEDDING_MODELS_TABLE}
    ORDER BY model_id ASC
  `).all() as Array<{ model_id: string; dimension: number; embedding_epoch: string }>;

  for (const row of stored) {
    rows.push(assessRow(db, vectorTables, row, execute));
  }

  return {
    execute,
    vectorTables,
    rows,
    repaired: rows.filter((row) => row.decision === 'repaired').length,
    wouldRepair: rows.filter((row) => row.decision === 'would_repair').length,
    refused: rows.filter((row) => row.decision === 'refused').length,
    authority: observeWriteAuthorityEpochs(db),
  };
}

function assessRow(
  db: Database,
  vectorTables: readonly string[],
  row: { model_id: string; dimension: number; embedding_epoch: string },
  execute: boolean,
): EmbeddingIdentityRepairRow {
  const sample = sampleVector(db, vectorTables, row.model_id);
  const base = {
    modelId: row.model_id,
    dimension: row.dimension,
    storedEpoch: row.embedding_epoch,
    vectorRows: sample.rows,
    ...(sample.byteLength !== undefined ? { vectorByteLength: sample.byteLength } : {}),
  };

  const canonical = canonicalEmbeddingIdentityForModel(row.model_id);
  if (!canonical) {
    return { ...base, decision: 'skipped', reason: 'no_canonical_identity_for_model' };
  }
  const withCanonical = { ...base, canonicalEpoch: canonical.epochId };
  if (row.embedding_epoch === canonical.epochId) {
    return { ...withCanonical, decision: 'already_canonical', reason: 'epoch_is_canonical' };
  }
  if (!contaminatedEmbeddingEpoch(row.model_id, row.embedding_epoch)) {
    // Could be a legitimate operator epoch bump. Refusing is the only safe
    // reading: a bump names vectors this tool cannot verify.
    return { ...withCanonical, decision: 'refused', reason: 'unknown_epoch_variant' };
  }
  if (row.dimension !== canonical.dimension) {
    return { ...withCanonical, decision: 'refused', reason: 'dimension_mismatch' };
  }
  if (sample.byteLength !== undefined && sample.byteLength !== canonical.dimension * FLOAT32_BYTES) {
    return { ...withCanonical, decision: 'refused', reason: 'vector_byte_length_mismatch' };
  }
  // A row with no vectors is pure provenance — there is nothing its epoch can
  // mislabel, and canonical embedding import reads this identity before it
  // accepts any exact-compatible vectors, so leaving it wrong is worse.
  const reason = sample.byteLength === undefined
    ? 'provenance_only_no_vectors'
    : 'epoch_corrected_vectors_verified';
  if (!execute) {
    return { ...withCanonical, decision: 'would_repair', reason };
  }
  const updated = db.query(`
    UPDATE ${EMBEDDING_MODELS_TABLE}
    SET embedding_epoch = ?
    WHERE model_id = ? AND embedding_epoch = ?
  `).run(canonical.epochId, row.model_id, row.embedding_epoch);
  if (updated.changes !== 1) {
    return { ...withCanonical, decision: 'refused', reason: 'row_changed_concurrently' };
  }
  return { ...withCanonical, decision: 'repaired', reason };
}

function assertEmbeddingModelsTable(db: Database): void {
  const columns = tableColumns(db, EMBEDDING_MODELS_TABLE);
  const required = ['model_id', 'dimension', 'embedding_epoch'];
  if (columns.length === 0 || required.some((column) => !columns.includes(column))) {
    throw new OperationError(
      'source_index_error',
      `This database has no repairable ${EMBEDDING_MODELS_TABLE} table `
      + `(needs ${required.join(', ')}).`,
      'Point --db at a source store or legacy index that records embedding provenance.',
    );
  }
}

/**
 * Every table that stores vectors keyed by model, whatever a given store calls
 * it (`chunk_embeddings`, `body_chunk_embeddings`,
 * `content_chunk_embeddings_secure_local`, ...). Discovered by shape rather
 * than by a per-store name list, so this stays source-neutral.
 */
function discoverVectorTables(db: Database): string[] {
  const tables = db.query(`
    SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name ASC
  `).all() as Array<{ name: string }>;
  return tables
    .map((table) => table.name)
    .filter((name) => {
      const columns = tableColumns(db, name);
      return columns.includes('model_id') && columns.includes('embedding');
    });
}

function tableColumns(db: Database, table: string): string[] {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(table)) return [];
  const columns = db.query(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  return columns.map((column) => column.name);
}

// Reads one blob's length and a row count. The blob itself is never selected.
function sampleVector(
  db: Database,
  vectorTables: readonly string[],
  modelId: string,
): { rows: number; byteLength?: number } {
  let rows = 0;
  let byteLength: number | undefined;
  for (const table of vectorTables) {
    const counted = db.query(
      `SELECT COUNT(*) AS rows FROM ${table} WHERE model_id = ?`,
    ).get(modelId) as { rows: number } | null;
    rows += counted?.rows ?? 0;
    if (byteLength !== undefined) continue;
    const sampled = db.query(
      `SELECT length(embedding) AS bytes FROM ${table} WHERE model_id = ? LIMIT 1`,
    ).get(modelId) as { bytes: number } | null;
    if (sampled && Number.isFinite(sampled.bytes)) byteLength = sampled.bytes;
  }
  return { rows, ...(byteLength !== undefined ? { byteLength } : {}) };
}

/**
 * Repair the connector-store write-authority rows the read-only observation
 * above can only report on. This is the row `bindEmbeddingWriteAuthority`
 * compares against (via `connectorStoreEmbeddingWriteAuthorityMatches`, which
 * since PR 33 includes the epoch): an authority carrying a contaminated epoch
 * is one embed away from a supersede-rebind that DELETES the model's vectors,
 * because the probe only proves the provider is alive, not that the stored
 * vectors were wrong. Verified live on the private host 2026-08-24: five gemini
 * authorities (gmail, drive, readwise, telegram-internal, x) all carried the
 * qwen3 epoch string — 172,900 telegram vectors sat one pass from deletion.
 *
 * Data repair only, under the exact preconditions of the provenance repair
 * plus receipt integrity: the row must parse, its receipt must equal
 * hashString(cursor) (the bind path's own integrity check — a row that fails
 * it is refused untouched), the model must have a canonical identity, the
 * declared dimension must match it, the stored epoch must be a KNOWN
 * contaminated variant, and any sampled vector's byte width must equal
 * dimension * 4. Only `embeddingEpoch` inside the cursor changes; key order
 * is preserved by mutating the parsed object in place, and the receipt is
 * recomputed with the store's own exported hashString. configHash,
 * providerEpoch and currencyRebuildPending pass through untouched.
 */
export function repairEmbeddingWriteAuthorities(
  db: Database,
  options: { execute?: boolean } = {},
): EmbeddingIdentityAuthorityRepairRow[] {
  const execute = options.execute === true;
  const columns = tableColumns(db, 'sync_runs');
  for (const required of ['sync_run_id', 'connector_id', 'cursor', 'audit_receipt_sha256']) {
    if (!columns.includes(required)) return [];
  }
  const vectorTables = discoverVectorTables(db);
  const authorities = db.query(`
    SELECT sync_run_id, cursor, audit_receipt_sha256
    FROM sync_runs WHERE connector_id = ?
  `).all(WRITE_AUTHORITY_CONNECTOR_ID) as Array<{
    sync_run_id: string;
    cursor: string | null;
    audit_receipt_sha256: string | null;
  }>;
  const rows: EmbeddingIdentityAuthorityRepairRow[] = [];
  for (const authority of authorities) {
    rows.push(assessAuthorityRow(db, vectorTables, authority, execute));
  }
  return rows;
}

function assessAuthorityRow(
  db: Database,
  vectorTables: readonly string[],
  authority: { sync_run_id: string; cursor: string | null; audit_receipt_sha256: string | null },
  execute: boolean,
): EmbeddingIdentityAuthorityRepairRow {
  const base = { syncRunId: authority.sync_run_id, modelId: '', storedEpoch: '', vectorRows: 0 };
  let parsed: Record<string, unknown>;
  try {
    const value = JSON.parse(authority.cursor ?? '');
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('not a record');
    parsed = value as Record<string, unknown>;
  } catch {
    return { ...base, decision: 'refused', reason: 'authority_cursor_unparseable' };
  }
  const modelId = typeof parsed.modelId === 'string' ? parsed.modelId : '';
  const storedEpoch = typeof parsed.embeddingEpoch === 'string' ? parsed.embeddingEpoch : '';
  const dimension = typeof parsed.embeddingDimension === 'number' ? parsed.embeddingDimension : undefined;
  const sample = modelId ? sampleVector(db, vectorTables, modelId) : { rows: 0 };
  const described = {
    ...base,
    modelId,
    storedEpoch,
    ...(dimension !== undefined ? { dimension } : {}),
    vectorRows: sample.rows,
    ...(sample.byteLength !== undefined ? { vectorByteLength: sample.byteLength } : {}),
  };
  if (!modelId || !storedEpoch) {
    return { ...described, decision: 'refused', reason: 'authority_identity_fields_missing' };
  }
  if (authority.audit_receipt_sha256 !== hashString(authority.cursor ?? '')) {
    // The bind path refuses this row too; repairing on top of a broken
    // receipt would launder an integrity failure into a clean-looking row.
    return { ...described, decision: 'refused', reason: 'authority_receipt_integrity_failed' };
  }
  const canonical = canonicalEmbeddingIdentityForModel(modelId);
  if (!canonical) {
    return { ...described, decision: 'skipped', reason: 'no_canonical_identity_for_model' };
  }
  const withCanonical = { ...described, canonicalEpoch: canonical.epochId };
  if (storedEpoch === canonical.epochId) {
    return { ...withCanonical, decision: 'already_canonical', reason: 'epoch_is_canonical' };
  }
  if (!contaminatedEmbeddingEpoch(modelId, storedEpoch)) {
    return { ...withCanonical, decision: 'refused', reason: 'unknown_epoch_variant' };
  }
  if (dimension !== canonical.dimension) {
    return { ...withCanonical, decision: 'refused', reason: 'dimension_mismatch' };
  }
  if (sample.byteLength !== undefined && sample.byteLength !== canonical.dimension * FLOAT32_BYTES) {
    return { ...withCanonical, decision: 'refused', reason: 'vector_byte_length_mismatch' };
  }
  const reason = sample.byteLength === undefined
    ? 'authority_epoch_corrected_no_vectors'
    : 'authority_epoch_corrected_vectors_verified';
  if (!execute) {
    return { ...withCanonical, decision: 'would_repair', reason };
  }
  parsed.embeddingEpoch = canonical.epochId;
  const nextCursor = JSON.stringify(parsed);
  const updated = db.query(`
    UPDATE sync_runs SET cursor = ?, audit_receipt_sha256 = ?
    WHERE sync_run_id = ? AND connector_id = ? AND cursor = ?
  `).run(
    nextCursor,
    hashString(nextCursor),
    authority.sync_run_id,
    WRITE_AUTHORITY_CONNECTOR_ID,
    authority.cursor ?? '',
  );
  if (updated.changes !== 1) {
    return { ...withCanonical, decision: 'refused', reason: 'row_changed_concurrently' };
  }
  return { ...withCanonical, decision: 'repaired', reason };
}

function observeWriteAuthorityEpochs(db: Database): EmbeddingIdentityAuthorityObservation[] {
  const columns = tableColumns(db, 'sync_runs');
  if (!columns.includes('cursor') || !columns.includes('connector_id')) return [];
  const authorities = db.query(`
    SELECT cursor FROM sync_runs WHERE connector_id = ?
  `).all(WRITE_AUTHORITY_CONNECTOR_ID) as Array<{ cursor: string | null }>;
  const observations: EmbeddingIdentityAuthorityObservation[] = [];
  for (const authority of authorities) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(authority.cursor ?? '');
    } catch {
      continue;
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) continue;
    const record = parsed as Record<string, unknown>;
    if (typeof record.modelId !== 'string' || typeof record.embeddingEpoch !== 'string') continue;
    const canonical = canonicalEmbeddingIdentityForModel(record.modelId);
    observations.push({
      modelId: record.modelId,
      authorityEpoch: record.embeddingEpoch,
      ...(canonical ? { canonicalEpoch: canonical.epochId } : {}),
      matchesCanonical: canonical?.epochId === record.embeddingEpoch,
    });
  }
  return observations;
}
