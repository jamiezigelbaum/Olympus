-- Synthetic connector-store fixture generated through LocalConnectorStore at
-- beta1 commit 29c71fa6. It contains no owner or live source data.
PRAGMA foreign_keys = OFF;
BEGIN TRANSACTION;

CREATE TABLE sync_runs (
  sync_run_id TEXT PRIMARY KEY,
  corpus_id TEXT NOT NULL,
  connector_id TEXT NOT NULL,
  status TEXT NOT NULL,
  cursor TEXT,
  items_seen INTEGER NOT NULL DEFAULT 0,
  items_indexed INTEGER NOT NULL DEFAULT 0,
  started_at TEXT NOT NULL,
  completed_at TEXT,
  error TEXT,
  audit_receipt_sha256 TEXT
);
INSERT INTO sync_runs VALUES (
  'connector-sync-beta1-synthetic',
  'secure_local.dropbox.files',
  'beta1-synthetic',
  'completed',
  NULL,
  1,
  1,
  '2026-09-10T12:00:00.000Z',
  '2026-09-10T12:00:01.000Z',
  NULL,
  NULL
);

CREATE TABLE items (
  item_pk INTEGER PRIMARY KEY,
  provider TEXT NOT NULL,
  family TEXT NOT NULL,
  account_scope TEXT NOT NULL,
  provider_item_id TEXT NOT NULL,
  provider_thread_id TEXT,
  provider_conversation_id TEXT,
  normalized_conversation TEXT GENERATED ALWAYS AS (
    COALESCE(provider_conversation_id, '')
  ) STORED NOT NULL,
  provider_file_id TEXT,
  provider_event_id TEXT,
  local_item_id TEXT NOT NULL,
  source_version TEXT,
  title TEXT,
  search_text TEXT,
  locator_uri TEXT,
  mime_type TEXT NOT NULL,
  authored_at TEXT,
  updated_at TEXT,
  fetched_at TEXT NOT NULL,
  indexed_at TEXT NOT NULL,
  content_hash TEXT,
  trust_tier TEXT NOT NULL,
  tombstoned INTEGER NOT NULL DEFAULT 0,
  deleted_at TEXT,
  sync_run_id TEXT NOT NULL,
  sender_id TEXT,
  sender_label TEXT,
  sender_is_owner INTEGER CHECK(sender_is_owner IS NULL OR sender_is_owner IN (0, 1)),
  reactions_json TEXT,
  source_scope_generation TEXT,
  source_scope_revision TEXT,
  source_scope_folder_keys_json TEXT,
  UNIQUE(provider, account_scope, normalized_conversation, provider_item_id),
  FOREIGN KEY(sync_run_id) REFERENCES sync_runs(sync_run_id)
);
INSERT INTO items (
  item_pk, provider, family, account_scope, provider_item_id,
  provider_file_id, local_item_id, source_version, title, search_text,
  locator_uri, mime_type, fetched_at, indexed_at, content_hash, trust_tier,
  tombstoned, sync_run_id, source_scope_generation, source_scope_revision,
  source_scope_folder_keys_json
) VALUES (
  1,
  'dropbox',
  'file',
  'personal',
  'synthetic-beta1-item',
  'id:synthetic-beta1-item',
  'personal:synthetic-beta1-item',
  'rev-1',
  'Synthetic beta1 compatibility document',
  'Synthetic beta1 compatibility document',
  '/Approved/Compatibility/document.txt',
  'text/plain',
  '2026-09-10T12:00:00.000Z',
  '2026-09-10T12:00:01.000Z',
  'e2b0404afb20074bcb9bfabd4dab37bd26b577cd16ed6ef2fad764f87431cffe',
  'S4',
  0,
  'connector-sync-beta1-synthetic',
  'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  '11111111-1111-4111-8111-111111111111',
  '["id:approved-folder"]'
);

CREATE TABLE chunks (
  chunk_pk INTEGER PRIMARY KEY,
  item_pk INTEGER NOT NULL,
  chunk_index INTEGER NOT NULL,
  bounded_text TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  embedding_input_hash TEXT,
  indexed_at TEXT NOT NULL,
  UNIQUE(item_pk, chunk_index),
  FOREIGN KEY(item_pk) REFERENCES items(item_pk) ON DELETE CASCADE
);
INSERT INTO chunks VALUES (
  1,
  1,
  0,
  'Synthetic beta one searchable covenant content.',
  'e2b0404afb20074bcb9bfabd4dab37bd26b577cd16ed6ef2fad764f87431cffe',
  'bf6721a9ff20aac241d80191a5a594f24830147b3332b67245998534cd6ed80d',
  '2026-09-10T12:00:01.000Z'
);

CREATE TABLE chunk_embeddings (
  chunk_pk INTEGER NOT NULL,
  model_id TEXT NOT NULL,
  item_pk INTEGER NOT NULL,
  content_hash TEXT NOT NULL,
  embedding BLOB NOT NULL,
  embedded_at TEXT NOT NULL,
  PRIMARY KEY (chunk_pk, model_id),
  FOREIGN KEY(chunk_pk) REFERENCES chunks(chunk_pk) ON DELETE CASCADE
);

CREATE TABLE item_owners (
  item_pk INTEGER NOT NULL,
  connector_id TEXT NOT NULL,
  ownership_kind TEXT NOT NULL CHECK(ownership_kind IN ('observed', 'preservation')),
  first_seen_sync_run_id TEXT NOT NULL,
  last_seen_sync_run_id TEXT NOT NULL,
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  PRIMARY KEY(item_pk, connector_id),
  FOREIGN KEY(item_pk) REFERENCES items(item_pk) ON DELETE CASCADE,
  FOREIGN KEY(first_seen_sync_run_id) REFERENCES sync_runs(sync_run_id),
  FOREIGN KEY(last_seen_sync_run_id) REFERENCES sync_runs(sync_run_id)
);
INSERT INTO item_owners VALUES (
  1,
  'beta1-synthetic',
  'observed',
  'connector-sync-beta1-synthetic',
  'connector-sync-beta1-synthetic',
  '2026-09-10T12:00:01.000Z',
  '2026-09-10T12:00:01.000Z'
);

CREATE TABLE schema_version (
  store_id TEXT PRIMARY KEY,
  version INTEGER NOT NULL,
  applied_at TEXT NOT NULL
);
INSERT INTO schema_version VALUES ('connector-store', 12, '2026-09-10T12:00:01.000Z');

CREATE TABLE source_index_maintenance_tasks (
  task_id TEXT PRIMARY KEY,
  task_kind TEXT NOT NULL,
  target TEXT NOT NULL,
  status TEXT NOT NULL,
  details_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
INSERT INTO source_index_maintenance_tasks VALUES (
  'fts_tokenizer_rebuild:connector_store_fts',
  'fts_tokenizer_rebuild',
  'connector_store_fts',
  'completed',
  '{"tokenizer":"tokenize = ''porter unicode61''","indexed_rows":0,"inline_rebuild_limit":25000,"recovery":"reingest through the canonical connector store"}',
  '2026-09-10T12:00:01.000Z'
);

CREATE VIRTUAL TABLE connector_store_fts USING fts5(
  title,
  bounded_text,
  item_pk UNINDEXED,
  chunk_pk UNINDEXED,
  tokenize = 'porter unicode61'
);
INSERT INTO connector_store_fts (rowid, title, bounded_text, item_pk, chunk_pk) VALUES
  (1, 'Synthetic beta1 compatibility document', 'Synthetic beta1 compatibility document', 1, NULL),
  (2, 'Synthetic beta1 compatibility document', 'Synthetic beta1 compatibility document\nSynthetic beta one searchable covenant content.', 1, 1);

CREATE TABLE connector_store_fts_rows (
  fts_rowid INTEGER PRIMARY KEY,
  item_pk INTEGER NOT NULL,
  chunk_pk INTEGER
);
INSERT INTO connector_store_fts_rows VALUES (1, 1, NULL), (2, 1, 1);

CREATE TABLE embedding_models (
  model_id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  dimension INTEGER NOT NULL,
  embedding_backend TEXT NOT NULL CHECK(embedding_backend IN ('local', 'cloud')),
  embedding_epoch TEXT NOT NULL,
  cloud_embedding_eligible INTEGER NOT NULL CHECK(cloud_embedding_eligible IN (0, 1)),
  created_at TEXT NOT NULL
);

CREATE TABLE item_write_claims (
  item_pk INTEGER NOT NULL,
  claim_scope TEXT NOT NULL,
  claim_authority TEXT NOT NULL,
  claim_ordinal INTEGER NOT NULL,
  claim_holder TEXT NOT NULL,
  claim_generation TEXT NOT NULL,
  accepted_at TEXT NOT NULL,
  PRIMARY KEY(item_pk, claim_scope),
  FOREIGN KEY(item_pk) REFERENCES items(item_pk) ON DELETE CASCADE
);

CREATE TABLE item_locator_identities (
  item_pk INTEGER PRIMARY KEY,
  provider TEXT NOT NULL,
  account_scope TEXT NOT NULL,
  normalized_conversation TEXT NOT NULL,
  normalized_locator TEXT NOT NULL,
  FOREIGN KEY(item_pk) REFERENCES items(item_pk) ON DELETE CASCADE
);
INSERT INTO item_locator_identities VALUES (
  1, 'dropbox', 'personal', '', '/approved/compatibility/document.txt'
);

CREATE TABLE locator_identity_index_state (
  singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
  cursor_item_pk INTEGER NOT NULL,
  completed INTEGER NOT NULL CHECK(completed IN (0, 1))
);
INSERT INTO locator_identity_index_state VALUES (1, 0, 1);

CREATE TRIGGER connector_store_locator_identity_insert
AFTER INSERT ON items
WHEN NEW.tombstoned = 0 AND NEW.locator_uri IS NOT NULL
BEGIN
  INSERT INTO item_locator_identities (
    item_pk, provider, account_scope, normalized_conversation, normalized_locator
  ) VALUES (
    NEW.item_pk,
    NEW.provider,
    NEW.account_scope,
    NEW.normalized_conversation,
    LOWER(NEW.locator_uri)
  )
  ON CONFLICT(item_pk) DO UPDATE SET
    provider = excluded.provider,
    account_scope = excluded.account_scope,
    normalized_conversation = excluded.normalized_conversation,
    normalized_locator = excluded.normalized_locator;
END;

CREATE TRIGGER connector_store_locator_identity_update
AFTER UPDATE OF provider, account_scope, provider_conversation_id, locator_uri, tombstoned ON items
BEGIN
  DELETE FROM item_locator_identities WHERE item_pk = NEW.item_pk;
  INSERT INTO item_locator_identities (
    item_pk, provider, account_scope, normalized_conversation, normalized_locator
  )
  SELECT
    NEW.item_pk,
    NEW.provider,
    NEW.account_scope,
    NEW.normalized_conversation,
    LOWER(NEW.locator_uri)
  WHERE NEW.tombstoned = 0 AND NEW.locator_uri IS NOT NULL;
END;

CREATE INDEX idx_items_local_item_id ON items(local_item_id);
CREATE INDEX idx_connector_store_chunk_embeddings_item ON chunk_embeddings(item_pk, model_id);
CREATE INDEX idx_connector_store_chunk_embeddings_model ON chunk_embeddings(model_id);
CREATE INDEX idx_connector_store_item_owners_connector
  ON item_owners(connector_id, ownership_kind, last_seen_sync_run_id);
CREATE INDEX idx_connector_store_fts_rows_item ON connector_store_fts_rows(item_pk);
CREATE INDEX idx_connector_store_items_sender_id ON items(sender_id);
CREATE INDEX idx_connector_store_items_sender_label ON items(sender_label);
CREATE INDEX idx_connector_store_items_sender_owner ON items(sender_is_owner, sender_id);
CREATE INDEX idx_connector_store_locator_identity ON item_locator_identities(
  provider,
  account_scope,
  normalized_conversation,
  normalized_locator,
  item_pk
);

COMMIT;
