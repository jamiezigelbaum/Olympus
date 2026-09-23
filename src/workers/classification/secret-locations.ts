// The secret-locations index (design docs/design/per-item-four-tier-classification.md,
// section 2.3): where the owner's Secrets live, and nothing else.
//
// An item whose content is Secrets is never stored in any tier store: no
// chunks, no FTS rows, no vectors. The owner still needs to find it ("where is
// my AWS key"), so this source-neutral local SQLite file (0600) keeps, per
// item: identity (with its conversation), source, locator, a title, the
// finding KINDS, the scope facts reads are filtered by, a content hash and the
// detection time.
//
// Custody rules, pinned by test/secret-locations.test.ts:
// - never a byte of the item's text, a chunk, an excerpt or a vector;
// - a title is stored only when it passes the secret scan AND the item's
//   metadata tier is below Private; the locator of a Private-metadata item is
//   kept for scope filtering but never released: such an item is located by
//   an opaque reference;
// - no full-text index: search is a keyword match over locator, title and
//   finding kind, so the file holds nothing a model could be fed;
// - every search is scoped to what the caller could read (account, approved
//   folder or path scope, conversation); a filter it cannot evaluate returns
//   nothing, fail closed;
// - results ride BESIDE the evidence pack (EvidencePackBuildDetail) and no
//   model ever sees them.

import { Database } from 'bun:sqlite';
import { createHash } from 'node:crypto';
import { chmodSync, closeSync, existsSync, mkdirSync, openSync } from 'node:fs';
import { dirname } from 'node:path';
import type { SourceItemIdentity } from '../../core/source-index/types.ts';
import { runSqliteMigrations, type SqliteMigration } from '../../core/sqlite-migrations.ts';
import { closeSqliteStore } from '../../core/sqlite-store.ts';
import { detectSecretFindingKinds } from './engine.ts';

import { SECRET_LOCATIONS_SQLITE_STORE_ID, secretLocationsPathForStore } from './tier-ledger-path.ts';

export { SECRET_LOCATIONS_SQLITE_STORE_ID, secretLocationsPathForStore };
export const SECRET_LOCATIONS_SCHEMA_VERSION = 1;

export type SecretLocationIdentity = Pick<SourceItemIdentity, 'provider' | 'accountScope' | 'providerItemId'>
  & Partial<Pick<SourceItemIdentity, 'providerConversationId'>>;

export interface SecretLocationInput {
  identity: SecretLocationIdentity;
  /** Where the owner can find the item: a path, a link or a provider locator. */
  locator?: string;
  /** The item's title. Stored only when it carries no secret and `namesReleasable`. */
  title?: string;
  /**
   * Whether the item's metadata tier is below Private. Default false: names
   * are withheld unless the caller says the metadata is Public or Personal.
   */
  namesReleasable?: boolean;
  /** Trusted provider folder identities (or conversation keys), for scope filters. */
  folderKeys?: readonly string[];
  /** The approved-scope stamp the lane put on the item, for scope filters. */
  scopeGeneration?: string;
  scopeRevision?: string;
  /** Finding kinds from the secret detector, never the matched values. */
  findingKinds: readonly string[];
  /** The text the kinds were found in. Only its SHA-256 is kept. */
  text?: string;
}

export interface SecretLocation {
  source: string;
  accountScope: string;
  conversationKey: string;
  providerItemId: string;
  locator: string | null;
  title: string | null;
  namesReleasable: boolean;
  folderKeys: string[];
  scopeGeneration: string | null;
  scopeRevision: string | null;
  findingKinds: string[];
  contentHash: string | null;
  detectedAt: string;
}

/**
 * What a search hands back beside the evidence pack: location only. `locator`
 * and `title` are null for an item whose metadata is Private; `ref` is an
 * opaque, stable reference either way.
 */
export interface SecretLocationMatch {
  source: string;
  ref: string;
  locator: string | null;
  title: string | null;
  findingKinds: string[];
  detectedAt: string;
}

/**
 * The read scope a search is confined to: the same account and filters the
 * caller's corpus search ran under. The filter names mirror the connector
 * store's search filters; see `secretLocationWithinScope`.
 */
export interface SecretLocationScope {
  accountScope?: string;
  filters?: {
    provider?: string;
    conversationId?: string;
    locatorPathScope?: string;
    locatorPathScopes?: readonly string[];
    locatorPathExcludedScopes?: readonly string[];
    sourceScopeGeneration?: string;
    sourceScopeRevision?: string;
    sourceScopeFolderAnyKeys?: readonly string[];
    sourceScopeFolderNoneKeys?: readonly string[];
    senderId?: string;
    senderLabel?: string;
    authoredAfter?: string;
    authoredBefore?: string;
    searchTextExactLines?: readonly string[];
    metadataOnlyLocatorPathScopes?: readonly string[];
    metadataOnlySourceScopeFolderKeys?: readonly string[];
  };
}

export class SecretLocationsIndex {
  readonly dbPath: string;
  private readonly db: Database;
  private readonly now: () => Date;

  constructor(options: { dbPath: string; now?: () => Date; readOnly?: boolean }) {
    this.dbPath = options.dbPath;
    this.now = options.now ?? (() => new Date());
    if (options.readOnly === true) {
      this.db = new Database(this.dbPath, { readonly: true, create: false });
      this.db.exec('PRAGMA busy_timeout = 10000; PRAGMA query_only = ON;');
      return;
    }
    const onDisk = this.dbPath !== ':memory:';
    if (onDisk) {
      mkdirSync(dirname(this.dbPath), { recursive: true, mode: 0o700 });
      // Owner-only from the first byte, with an explicit file mode rather than
      // a process-wide umask. SQLite gives its -wal and -shm sidecars the
      // database file's permissions.
      if (!existsSync(this.dbPath)) closeSync(openSync(this.dbPath, 'a', 0o600));
      chmodSync(this.dbPath, 0o600);
    }
    this.db = new Database(this.dbPath, { create: true });
    try {
      this.db.exec('PRAGMA busy_timeout = 10000; PRAGMA journal_mode = WAL;');
      runSqliteMigrations(this.db, SECRET_LOCATIONS_SQLITE_STORE_ID, secretLocationsMigrations());
    } catch (error) {
      closeSqliteStore(this.db);
      throw error;
    }
  }

  close(): void {
    closeSqliteStore(this.db);
  }

  /** Record (or refresh) where a Secret lives. Returns false when nothing changed. */
  record(input: SecretLocationInput): boolean {
    const kinds = [...new Set(input.findingKinds.map((kind) => kind.trim()).filter(Boolean))].sort();
    if (kinds.length === 0) throw new Error('A secret location needs at least one finding kind.');
    const namesReleasable = input.namesReleasable === true;
    const title = namesReleasable && input.title?.trim() && detectSecretFindingKinds(input.title).length === 0
      ? input.title.trim().slice(0, 300)
      : null;
    const locator = input.locator?.trim() && detectSecretFindingKinds(input.locator).length === 0
      ? input.locator.trim().slice(0, 1_000)
      : null;
    const folderKeys = [...new Set((input.folderKeys ?? []).map((key) => key.trim()).filter(Boolean))].sort();
    const contentHash = input.text !== undefined
      ? createHash('sha256').update(input.text, 'utf8').digest('hex')
      : null;
    const existing = this.get(input.identity);
    if (existing
      && existing.locator === locator
      && existing.title === title
      && existing.namesReleasable === namesReleasable
      && JSON.stringify(existing.folderKeys) === JSON.stringify(folderKeys)
      && existing.scopeGeneration === (input.scopeGeneration ?? null)
      && existing.scopeRevision === (input.scopeRevision ?? null)
      && JSON.stringify(existing.findingKinds) === JSON.stringify(kinds)
      && existing.contentHash === contentHash) {
      return false;
    }
    this.db.query(`
      INSERT INTO secret_locations (
        provider, account_scope, conversation_key, provider_item_id, locator, title, names_releasable,
        folder_keys_json, scope_generation, scope_revision, finding_kinds_json, content_hash, detected_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (provider, account_scope, conversation_key, provider_item_id) DO UPDATE SET
        locator = excluded.locator, title = excluded.title, names_releasable = excluded.names_releasable,
        folder_keys_json = excluded.folder_keys_json, scope_generation = excluded.scope_generation,
        scope_revision = excluded.scope_revision, finding_kinds_json = excluded.finding_kinds_json,
        content_hash = excluded.content_hash, detected_at = excluded.detected_at
    `).run(
      input.identity.provider,
      input.identity.accountScope,
      input.identity.providerConversationId ?? '',
      input.identity.providerItemId,
      locator,
      title,
      namesReleasable ? 1 : 0,
      JSON.stringify(folderKeys),
      input.scopeGeneration ?? null,
      input.scopeRevision ?? null,
      JSON.stringify(kinds),
      contentHash,
      this.now().toISOString(),
    );
    return true;
  }

  /** The provider deleted the item, or it no longer carries a secret. */
  remove(identity: SecretLocationIdentity): boolean {
    return this.db.query(`
      DELETE FROM secret_locations
      WHERE provider = ? AND account_scope = ? AND conversation_key = ? AND provider_item_id = ?
    `).run(identity.provider, identity.accountScope, identity.providerConversationId ?? '', identity.providerItemId).changes > 0;
  }

  get(identity: SecretLocationIdentity): SecretLocation | undefined {
    const row = this.db.query(`
      SELECT * FROM secret_locations
      WHERE provider = ? AND account_scope = ? AND conversation_key = ? AND provider_item_id = ?
    `).get(identity.provider, identity.accountScope, identity.providerConversationId ?? '', identity.providerItemId) as SecretLocationRow | null;
    return row ? locationFromRow(row) : undefined;
  }

  count(): number {
    return (this.db.query('SELECT COUNT(*) AS n FROM secret_locations').get() as { n: number }).n;
  }

  /**
   * Keyword search over locator, title and finding kind, confined to `scope`.
   * A row matches when any query term (stop words dropped) appears in one of
   * them; rows matching more distinct terms rank first. Location only: never
   * text, and never the names of a Private-metadata item.
   */
  search(query: string, scope: SecretLocationScope, options: { limit?: number } = {}): SecretLocationMatch[] {
    const terms = secretLocationQueryTerms(query);
    if (terms.length === 0) return [];
    const limit = Math.max(1, Math.min(options.limit ?? 10, 100));
    const rows = this.db.query(`
      SELECT * FROM secret_locations
      ${scope.accountScope ? 'WHERE account_scope = ?' : ''}
      ORDER BY detected_at DESC
    `).all(...(scope.accountScope ? [scope.accountScope] : [])) as SecretLocationRow[];
    const scored: Array<{ location: SecretLocation; score: number }> = [];
    for (const row of rows) {
      const location = locationFromRow(row);
      if (!secretLocationWithinScope(location, scope)) continue;
      // A withheld name is not searchable either: matching on it would say it.
      const haystack = [
        location.namesReleasable ? location.locator ?? '' : '',
        location.title ?? '',
        location.findingKinds.join(' ').replaceAll('_', ' '),
      ].join('\n').toLowerCase();
      const score = terms.filter((term) => haystack.includes(term)).length;
      if (score > 0) scored.push({ location, score });
    }
    return scored
      .sort((left, right) => right.score - left.score || right.location.detectedAt.localeCompare(left.location.detectedAt))
      .slice(0, limit)
      .map(({ location }) => ({
        source: location.source,
        ref: secretLocationRef(location),
        locator: location.namesReleasable ? location.locator : null,
        title: location.namesReleasable ? location.title : null,
        findingKinds: location.findingKinds,
        detectedAt: location.detectedAt,
      }));
  }
}

/** An opaque, stable reference to a located Secret: no name, no path. */
export function secretLocationRef(location: Pick<SecretLocation, 'source' | 'accountScope' | 'conversationKey' | 'providerItemId'>): string {
  return `secret:${createHash('sha256')
    .update(`${location.source}\u0000${location.accountScope}\u0000${location.conversationKey}\u0000${location.providerItemId}`)
    .digest('hex')
    .slice(0, 16)}`;
}

/**
 * Whether a located Secret falls inside a read scope. Every filter the index
 * records a fact for is evaluated; a filter it holds no fact for (sender,
 * authored time, facet lines) excludes everything, fail closed.
 */
export function secretLocationWithinScope(location: SecretLocation, scope: SecretLocationScope): boolean {
  if (scope.accountScope && location.accountScope !== scope.accountScope) return false;
  const filters = scope.filters;
  if (!filters) return true;
  if (filters.senderId || filters.senderLabel || filters.authoredAfter || filters.authoredBefore
    || (filters.searchTextExactLines?.length ?? 0) > 0) {
    return false;
  }
  if (filters.provider && location.source !== filters.provider) return false;
  if (filters.conversationId !== undefined && location.conversationKey !== filters.conversationId) return false;
  if (filters.sourceScopeGeneration !== undefined && location.scopeGeneration !== filters.sourceScopeGeneration) return false;
  if (filters.sourceScopeRevision !== undefined && location.scopeRevision !== filters.sourceScopeRevision) return false;
  if (filters.sourceScopeFolderAnyKeys !== undefined
    && !filters.sourceScopeFolderAnyKeys.some((key) => location.folderKeys.includes(key))) {
    return false;
  }
  if (filters.sourceScopeFolderNoneKeys?.some((key) => location.folderKeys.includes(key))) return false;
  const pathScopes = [
    ...(filters.locatorPathScope ? [filters.locatorPathScope] : []),
    ...(filters.locatorPathScopes ?? []),
  ];
  if (pathScopes.length > 0 && !pathScopes.some((scopePath) => locatorWithin(location.locator, scopePath))) return false;
  if (filters.locatorPathExcludedScopes?.some((scopePath) => locatorWithin(location.locator, scopePath))) return false;
  return true;
}

function locatorWithin(locator: string | null, scopePath: string): boolean {
  if (!locator) return false;
  const path = locator.toLowerCase();
  const root = scopePath.toLowerCase().replace(/\/+$/, '');
  return path === root || path.startsWith(`${root}/`);
}

const STOP_WORDS = new Set([
  'a', 'an', 'and', 'are', 'did', 'do', 'does', 'find', 'for', 'have', 'i', 'in', 'is', 'it', 'kept',
  'keep', 'me', 'my', 'of', 'on', 'or', 'put', 'saved', 'show', 'stored', 'the', 'there', 'to', 'what',
  'where', 'which', 'who', 'with',
]);

export function secretLocationQueryTerms(query: string): string[] {
  return [...new Set(
    query
      .toLowerCase()
      .split(/[^\p{L}\p{N}]+/u)
      .filter((term) => term.length >= 2 && !STOP_WORDS.has(term)),
  )];
}

interface SecretLocationRow {
  provider: string;
  account_scope: string;
  conversation_key: string;
  provider_item_id: string;
  locator: string | null;
  title: string | null;
  names_releasable: number;
  folder_keys_json: string;
  scope_generation: string | null;
  scope_revision: string | null;
  finding_kinds_json: string;
  content_hash: string | null;
  detected_at: string;
}

function locationFromRow(row: SecretLocationRow): SecretLocation {
  return {
    source: row.provider,
    accountScope: row.account_scope,
    conversationKey: row.conversation_key,
    providerItemId: row.provider_item_id,
    locator: row.locator,
    title: row.title,
    namesReleasable: row.names_releasable === 1,
    folderKeys: JSON.parse(row.folder_keys_json) as string[],
    scopeGeneration: row.scope_generation,
    scopeRevision: row.scope_revision,
    findingKinds: JSON.parse(row.finding_kinds_json) as string[],
    contentHash: row.content_hash,
    detectedAt: row.detected_at,
  };
}

function secretLocationsMigrations(): SqliteMigration[] {
  return [
    {
      version: SECRET_LOCATIONS_SCHEMA_VERSION,
      name: 'create_secret_locations',
      up(db) {
        db.exec(`
          CREATE TABLE IF NOT EXISTS secret_locations (
            provider TEXT NOT NULL,
            account_scope TEXT NOT NULL,
            conversation_key TEXT NOT NULL DEFAULT '',
            provider_item_id TEXT NOT NULL,
            locator TEXT,
            title TEXT,
            names_releasable INTEGER NOT NULL DEFAULT 0 CHECK (names_releasable IN (0, 1)),
            folder_keys_json TEXT NOT NULL DEFAULT '[]',
            scope_generation TEXT,
            scope_revision TEXT,
            finding_kinds_json TEXT NOT NULL,
            content_hash TEXT,
            detected_at TEXT NOT NULL,
            PRIMARY KEY (provider, account_scope, conversation_key, provider_item_id)
          );
        `);
      },
    },
  ];
}
