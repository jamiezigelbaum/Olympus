// Shared fixtures for the P1b tier tests: a source-neutral file lane with
// three tier stores, fake embedding providers with the real identity shapes
// (a cloud Gemini-like identity for Public/Personal, a local one for Private),
// and byte-level snapshots of stored rows, chunks and vectors.

import { Database } from 'bun:sqlite';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RawItem, SourceConnector, SourceConnectorListPage } from '../../src/core/contracts.ts';
import { buildSourceSensitivity, type SourceTrustDomain } from '../../src/core/source-index/types.ts';
import { SecretLocationsIndex } from '../../src/workers/classification/secret-locations.ts';
import { TierLedger } from '../../src/workers/classification/tier-ledger.ts';
import { LocalConnectorStore } from '../../src/workers/connector-store/index.ts';
import type { ConnectorStorePlacement } from '../../src/workers/connector-store/tier-placement.ts';
import { TieredStoreSet, tieredStoreSetLedgerPath } from '../../src/workers/connector-store/tiered-store-set.ts';
import type { SourceEmbeddingInput, SourceEmbeddingProvider } from '../../src/workers/source-index/embeddings.ts';

export const ACCOUNT = 'personal';
export const PROVIDER = 'fixture';

export interface FixtureSpec {
  id: string;
  name: string;
  text?: string;
  sharing?: 'public_link';
  /** Where the lane's own (legacy) placement puts the item. */
  legacyDomain?: 'internal' | 'secure_local';
  deleted?: boolean;
  version?: string;
}

export function fixtureItem(spec: FixtureSpec): RawItem {
  return {
    identity: {
      family: 'file',
      provider: PROVIDER,
      accountScope: ACCOUNT,
      providerItemId: spec.id,
      localItemId: `${ACCOUNT}:${spec.id}`,
      sourceVersion: spec.version ?? 'v1',
    },
    mimeType: 'text/plain',
    content: spec.text === undefined ? { kind: 'metadata_only' } : { kind: 'text', text: spec.text },
    metadata: Object.freeze({
      name: spec.name,
      title: spec.name,
      pathDisplay: `/Files/${spec.name}`,
      legacyDomain: spec.legacyDomain ?? 'internal',
      ...(spec.deleted ? { deleted: true } : {}),
    }),
    fetchedAt: '2026-09-23T00:00:00.000Z',
  };
}

/** A lane over a mutable list of specs, listed as one page. */
export function fixtureConnector(specs: () => readonly FixtureSpec[], options: { id?: string; cursor?: string } = {}): SourceConnector {
  return {
    id: options.id ?? 'fixture_lane',
    family: 'file',
    async authenticate() {},
    listItems(): AsyncIterable<SourceConnectorListPage> {
      const items = specs().map(fixtureItem);
      const cursor = options.cursor;
      return (async function* () {
        await Promise.resolve();
        yield { items, done: true, ...(cursor ? { nextCursor: cursor } : {}) };
      })();
    },
    async fetchItem(localItemId) {
      const spec = specs().find((entry) => `${ACCOUNT}:${entry.id}` === localItemId);
      if (!spec) throw new Error('unknown fixture item');
      return fixtureItem(spec);
    },
    classificationSignals(item) {
      const spec = specs().find((entry) => entry.id === item.identity.providerItemId);
      return {
        title: spec?.name ?? String(item.metadata['name'] ?? ''),
        path: `/Files/${spec?.name ?? ''}`,
        ...(spec?.sharing ? { sharing: spec.sharing } : {}),
      };
    },
  };
}

/** The lane's own placement: exactly what it did before P1b. */
export const FIXTURE_PLACEMENT: ConnectorStorePlacement = (item) => (
  item.metadata['legacyDomain'] === 'secure_local'
    ? buildSourceSensitivity({ trustTier: 'S4', trustDomain: 'secure_local' })
    : buildSourceSensitivity({ trustTier: 'S3', trustDomain: 'internal' })
);

export class RecordingProvider implements SourceEmbeddingProvider {
  readonly inputs: string[] = [];
  constructor(
    readonly provider: string,
    readonly modelId: string,
    readonly backend: 'local' | 'cloud',
    readonly dimension = 4,
    readonly epochId = `${backend}:${provider}:${modelId}:4`,
    readonly configHash = `${provider}-config`,
  ) {}

  async embed(inputs: SourceEmbeddingInput[]): Promise<number[][]> {
    for (const input of inputs) this.inputs.push(input.text);
    return inputs.map((input) => {
      const text = input.text;
      return [text.length % 7 + 1, text.length % 11 + 1, text.length % 13 + 1, 1];
    });
  }
}

export function cloudProvider(): RecordingProvider {
  return new RecordingProvider('google-gemini', 'gemini-embedding-2', 'cloud');
}

export function localProvider(): RecordingProvider {
  return new RecordingProvider('openai-compatible', 'secure-local-qwen3-embed', 'local');
}

export const CORPORA: Readonly<Record<SourceTrustDomain, string>> = {
  public_safe: 'public_safe.fixture.files',
  internal: 'internal.fixture.files',
  secure_local: 'secure_local.fixture.files',
};

export interface TierFixture {
  dir: string;
  paths: Record<SourceTrustDomain, string>;
  ledger: TierLedger;
  secrets: SecretLocationsIndex;
  set: TieredStoreSet;
  stores: Partial<Record<SourceTrustDomain, LocalConnectorStore>>;
  cloud: RecordingProvider;
  local: RecordingProvider;
  close(): void;
}

export function tempDir(prefix = 'olympus-tier-p1b-'): { dir: string; cleanup(): void } {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

export function storePaths(dir: string): Record<SourceTrustDomain, string> {
  return {
    public_safe: join(dir, 'fixture-public-store.sqlite'),
    internal: join(dir, 'fixture-internal-store.sqlite'),
    secure_local: join(dir, 'fixture-secure-store.sqlite'),
  };
}

export function openLegStore(
  paths: Record<SourceTrustDomain, string>,
  domain: SourceTrustDomain,
  tierLedger?: TierLedger | null,
): LocalConnectorStore {
  return new LocalConnectorStore({
    dbPath: paths[domain]!,
    corpusId: CORPORA[domain]!,
    family: 'file',
    trustDomain: domain,
    ...(tierLedger !== undefined ? { tierLedger } : {}),
  });
}

/**
 * The P1b set over (possibly pre-existing) store files: internal and secure
 * are the lane's legacy stores; public is created lazily.
 */
export function openTierFixture(dir: string, options: { embed?: boolean; splitLayers?: boolean } = {}): TierFixture {
  const paths = storePaths(dir);
  const ledger = new TierLedger({ dbPath: tieredStoreSetLedgerPath(paths.secure_local) });
  const secrets = new SecretLocationsIndex({ dbPath: join(dir, 'secret-locations.sqlite') });
  const stores: Partial<Record<SourceTrustDomain, LocalConnectorStore>> = {
    internal: openLegStore(paths, 'internal', ledger),
    secure_local: openLegStore(paths, 'secure_local', ledger),
  };
  const cloud = cloudProvider();
  const local = localProvider();
  const embed = options.embed !== false;
  const set = new TieredStoreSet({
    setId: 'fixture.personal',
    ledger,
    secretLocations: secrets,
    ...(options.splitLayers === false ? { splitLayers: false } : {}),
    legs: [
      {
        trustDomain: 'public_safe',
        corpusId: CORPORA.public_safe,
        open: () => {
          const store = openLegStore(paths, 'public_safe', ledger);
          stores.public_safe = store;
          return store;
        },
        exists: () => existsSync(paths.public_safe),
        ...(embed ? { embeddingProvider: cloud } : {}),
      },
      { trustDomain: 'internal', corpusId: CORPORA.internal, store: stores.internal!, legacy: true, ...(embed ? { embeddingProvider: cloud } : {}) },
      { trustDomain: 'secure_local', corpusId: CORPORA.secure_local, store: stores.secure_local!, legacy: true, ...(embed ? { embeddingProvider: local } : {}) },
    ],
  });
  return {
    dir,
    paths,
    ledger,
    secrets,
    set,
    stores,
    cloud,
    local,
    close() {
      for (const store of Object.values(stores)) store?.close();
      secrets.close();
      ledger.close();
    },
  };
}

export interface StoreSnapshot {
  items: Array<Record<string, unknown>>;
  chunks: Array<Record<string, unknown>>;
  vectors: Array<Record<string, unknown>>;
  owners: Array<Record<string, unknown>>;
  authority: Array<Record<string, unknown>>;
}

/** Every byte a tier change could touch, for one store file, optionally limited to some items. */
export function snapshotStore(dbPath: string, localItemIds?: readonly string[]): StoreSnapshot {
  const db = new Database(dbPath, { readonly: true });
  const only = (rows: Array<Record<string, unknown>>) => localItemIds
    ? rows.filter((row) => localItemIds.includes(String(row['local_item_id'])))
    : rows;
  try {
    return {
      items: only(db.query(`
        -- indexed_at and sync_run_id are re-stamped by every re-sync (P1a
        -- behaviour too); everything that carries meaning is compared.
        SELECT item_pk, local_item_id, title, search_text, trust_tier, tombstoned, content_hash, source_version,
          locator_uri, mime_type, deleted_at
        FROM items ORDER BY local_item_id
      `).all() as Array<Record<string, unknown>>),
      chunks: only(db.query(`
        SELECT i.local_item_id, c.chunk_pk, c.chunk_index, c.content_hash, c.embedding_input_hash, c.bounded_text, c.indexed_at
        FROM chunks c JOIN items i ON i.item_pk = c.item_pk
        ORDER BY i.local_item_id, c.chunk_index
      `).all() as Array<Record<string, unknown>>),
      vectors: only(db.query(`
        SELECT i.local_item_id, e.chunk_pk, e.model_id, e.content_hash, hex(e.embedding) AS bytes, e.embedded_at
        FROM chunk_embeddings e JOIN items i ON i.item_pk = e.item_pk
        ORDER BY i.local_item_id, e.chunk_pk
      `).all() as Array<Record<string, unknown>>),
      owners: only(db.query(`
        SELECT i.local_item_id, o.connector_id, o.ownership_kind, o.first_seen_at
        FROM item_owners o JOIN items i ON i.item_pk = o.item_pk
        ORDER BY i.local_item_id, o.connector_id
      `).all() as Array<Record<string, unknown>>),
      authority: db.query(`
        SELECT sync_run_id, status, cursor, audit_receipt_sha256
        FROM sync_runs WHERE connector_id = 'connector_store_embedding_write_authority'
        ORDER BY sync_run_id
      `).all() as Array<Record<string, unknown>>,
    };
  } finally {
    db.close();
  }
}

export function localId(id: string): string {
  return `${ACCOUNT}:${id}`;
}

export function identityOf(id: string) {
  return fixtureItem({ id, name: id }).identity;
}
