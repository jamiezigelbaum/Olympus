// The secret-locations index (design docs/design/per-item-four-tier-classification.md,
// section 2.3): where the owner's Secrets live, and nothing else.
//
// An item whose content is Secrets is never stored in any tier store: no
// chunks, no FTS rows, no vectors. The owner still needs to find it ("where is
// my AWS key"), so this source-neutral local SQLite file (0600) keeps, per
// item: identity, source, locator, a title that itself passed the secret scan,
// the finding KINDS, a content hash and the detection time.
//
// Custody rules, pinned by test/secret-locations.test.ts:
// - never a byte of the item's text, a chunk, an excerpt or a vector;
// - a title that trips the secret scan is not stored (the row keeps the
//   locator and kinds only);
// - no full-text index: search is a keyword match over locator, title and
//   finding kind, so the file holds nothing a model could be fed;
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

export type SecretLocationIdentity = Pick<SourceItemIdentity, 'provider' | 'accountScope' | 'providerItemId'>;

export interface SecretLocationInput {
  identity: SecretLocationIdentity;
  /** Where the owner can find the item: a path, a link or a provider locator. */
  locator?: string;
  /** The item's title. Stored only when the title itself carries no secret. */
  title?: string;
  /** Finding kinds from the secret detector, never the matched values. */
  findingKinds: readonly string[];
  /** The text the kinds were found in. Only its SHA-256 is kept. */
  text?: string;
}

export interface SecretLocation {
  source: string;
  accountScope: string;
  providerItemId: string;
  locator: string | null;
  title: string | null;
  findingKinds: string[];
  contentHash: string | null;
  detectedAt: string;
}

/** What a search hands back beside the evidence pack: location only. */
export interface SecretLocationMatch {
  source: string;
  locator: string | null;
  title: string | null;
  findingKinds: string[];
  detectedAt: string;
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
    const title = input.title?.trim() && detectSecretFindingKinds(input.title).length === 0
      ? input.title.trim().slice(0, 300)
      : null;
    const locator = input.locator?.trim() && detectSecretFindingKinds(input.locator).length === 0
      ? input.locator.trim().slice(0, 1_000)
      : null;
    const contentHash = input.text !== undefined
      ? createHash('sha256').update(input.text, 'utf8').digest('hex')
      : null;
    const existing = this.get(input.identity);
    if (existing
      && existing.locator === locator
      && existing.title === title
      && JSON.stringify(existing.findingKinds) === JSON.stringify(kinds)
      && existing.contentHash === contentHash) {
      return false;
    }
    this.db.query(`
      INSERT INTO secret_locations (
        provider, account_scope, provider_item_id, locator, title, finding_kinds_json, content_hash, detected_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (provider, account_scope, provider_item_id) DO UPDATE SET
        locator = excluded.locator, title = excluded.title,
        finding_kinds_json = excluded.finding_kinds_json, content_hash = excluded.content_hash,
        detected_at = excluded.detected_at
    `).run(
      input.identity.provider,
      input.identity.accountScope,
      input.identity.providerItemId,
      locator,
      title,
      JSON.stringify(kinds),
      contentHash,
      this.now().toISOString(),
    );
    return true;
  }

  /** The provider deleted the item, or it no longer carries a secret. */
  remove(identity: SecretLocationIdentity): boolean {
    return this.db.query(`
      DELETE FROM secret_locations WHERE provider = ? AND account_scope = ? AND provider_item_id = ?
    `).run(identity.provider, identity.accountScope, identity.providerItemId).changes > 0;
  }

  get(identity: SecretLocationIdentity): SecretLocation | undefined {
    const row = this.db.query(`
      SELECT * FROM secret_locations WHERE provider = ? AND account_scope = ? AND provider_item_id = ?
    `).get(identity.provider, identity.accountScope, identity.providerItemId) as SecretLocationRow | null;
    return row ? locationFromRow(row) : undefined;
  }

  count(): number {
    return (this.db.query('SELECT COUNT(*) AS n FROM secret_locations').get() as { n: number }).n;
  }

  /**
   * Keyword search over locator, title and finding kind. A row matches when
   * any query term (stop words dropped) appears in one of them; rows matching
   * more distinct terms rank first. Location only: never text.
   */
  search(query: string, options: { limit?: number; sources?: readonly string[] } = {}): SecretLocationMatch[] {
    const terms = secretLocationQueryTerms(query);
    if (terms.length === 0) return [];
    const limit = Math.max(1, Math.min(options.limit ?? 10, 100));
    const sources = options.sources?.filter((source) => source.trim()) ?? [];
    const rows = this.db.query(`
      SELECT * FROM secret_locations
      ${sources.length > 0 ? `WHERE provider IN (${sources.map(() => '?').join(', ')})` : ''}
      ORDER BY detected_at DESC
    `).all(...sources) as SecretLocationRow[];
    const scored: Array<{ row: SecretLocationRow; score: number }> = [];
    for (const row of rows) {
      const haystack = [row.locator ?? '', row.title ?? '', row.finding_kinds_json.replaceAll('_', ' ')]
        .join('\n')
        .toLowerCase();
      const score = terms.filter((term) => haystack.includes(term)).length;
      if (score > 0) scored.push({ row, score });
    }
    return scored
      .sort((left, right) => right.score - left.score || right.row.detected_at.localeCompare(left.row.detected_at))
      .slice(0, limit)
      .map(({ row }) => {
        const location = locationFromRow(row);
        return {
          source: location.source,
          locator: location.locator,
          title: location.title,
          findingKinds: location.findingKinds,
          detectedAt: location.detectedAt,
        };
      });
  }
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
  provider_item_id: string;
  locator: string | null;
  title: string | null;
  finding_kinds_json: string;
  content_hash: string | null;
  detected_at: string;
}

function locationFromRow(row: SecretLocationRow): SecretLocation {
  return {
    source: row.provider,
    accountScope: row.account_scope,
    providerItemId: row.provider_item_id,
    locator: row.locator,
    title: row.title,
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
            provider_item_id TEXT NOT NULL,
            locator TEXT,
            title TEXT,
            finding_kinds_json TEXT NOT NULL,
            content_hash TEXT,
            detected_at TEXT NOT NULL,
            PRIMARY KEY (provider, account_scope, provider_item_id)
          );
        `);
      },
    },
  ];
}
