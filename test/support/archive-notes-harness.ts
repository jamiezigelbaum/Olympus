/**
 * Helpers the notes-archive tests share: export files written to a temp
 * folder, a connector opened over them through the scope-safe reader, and an
 * import run through the real runtime and tier lane. Synthetic data only.
 */
import { Database } from 'bun:sqlite';
import { existsSync, mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RawItem, SourceConnector } from '../../src/core/contracts.ts';
import type { ArchiveConnectorInput, ArchiveFormatDefinition, ArchiveImportFinding } from '../../src/core/archive-formats.ts';
import { ScopeRoot } from '../../src/core/scope-safe-fs.ts';
import { SecretLocationsIndex } from '../../src/workers/classification/secret-locations.ts';
import { secretLocationsPathForStore } from '../../src/workers/classification/tier-ledger-path.ts';
import { archiveFileEntries, archiveManifestSha256, buildArchiveManifest } from '../../src/workers/archive-import/manifest.ts';
import { createArchiveImportRuntime, type ArchiveImportRuntime } from '../../src/workers/archive-import/runtime.ts';
import { archiveConnectorStoreDbPath } from '../../src/workers/archive-import/store.ts';
import { pullArchiveImport, type ArchiveImportPullOptions } from '../../src/workers/archive-import/sync.ts';

export function tempFolder(cleanups: Array<() => void>, prefix = 'archive-notes-'): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

export function writeExport(cleanups: Array<() => void>, name: string, content: string | Uint8Array) {
  const dir = tempFolder(cleanups);
  const path = join(dir, name);
  writeFileSync(path, content);
  return { dir, path };
}

export interface OpenedConnector {
  connector: SourceConnector;
  findings: ArchiveImportFinding[];
  positions: Array<{ fileIndex: number; offset: number }>;
  input: ArchiveConnectorInput;
}

/** A connector of `format` over the named files of `dir`, the way a pass builds one. */
export function openConnector(
  cleanups: Array<() => void>,
  dir: string,
  names: readonly string[],
  format: ArchiveFormatDefinition,
  factory: (input: ArchiveConnectorInput) => SourceConnector,
  options: { pageSize?: number; shouldContinue?: () => boolean; manifestSha256?: string; maxBytesPerListing?: number } = {},
): OpenedConnector {
  const root = ScopeRoot.open(dir);
  cleanups.push(() => root.close());
  const files = buildArchiveManifest(root, [...names]);
  const findings: ArchiveImportFinding[] = [];
  const positions: Array<{ fileIndex: number; offset: number }> = [];
  const input: ArchiveConnectorInput = {
    archiveId: 'synthetic-archive',
    connectorId: 'archive.synthetic-archive',
    accountScope: 'synthetic-archive',
    format,
    root,
    files: archiveFileEntries(files),
    manifestSha256: options.manifestSha256 ?? archiveManifestSha256(files),
    report: (finding) => { findings.push(finding); },
    reportPosition: (position) => { positions.push(position); },
    shouldContinue: options.shouldContinue ?? (() => true),
    ...(options.pageSize !== undefined ? { pageSize: options.pageSize } : {}),
    ...(options.maxBytesPerListing !== undefined ? { maxBytesPerListing: options.maxBytesPerListing } : {}),
  };
  return { connector: factory(input), findings, positions, input };
}

export async function listAll(connector: SourceConnector, cursor?: string, limit?: number) {
  const items: RawItem[] = [];
  const cursors: string[] = [];
  const pages: number[] = [];
  let done = false;
  for await (const page of connector.listItems({ ...(cursor ? { cursor } : {}), ...(limit !== undefined ? { limit } : {}) })) {
    items.push(...page.items);
    pages.push(page.items.length);
    if (page.nextCursor) cursors.push(page.nextCursor);
    done = page.done;
  }
  return { items, cursors, pages, done };
}

export function textOf(item: RawItem): string {
  return item.content.kind === 'text' ? item.content.text : '';
}

// --- A whole import through the runtime -------------------------------------

export function importFixture(cleanups: Array<() => void>) {
  const base = tempFolder(cleanups, 'archive-notes-import-');
  const env = { HOME: base, XDG_DATA_HOME: join(base, 'xdg'), OPENCLAW_STATE_DIR: join(base, 'openclaw') };
  const exports = join(base, 'exports');
  mkdirSync(exports);
  const runtime = createArchiveImportRuntime({
    env,
    statePath: join(base, 'xdg', 'archive-imports.json'),
    waitingQuestionsDbPath: join(base, 'waiting-private-questions.sqlite'),
    openSecretLocations: (secureDbPath) => new SecretLocationsIndex({ dbPath: secretLocationsPathForStore(secureDbPath) }),
  });
  cleanups.push(() => {
    for (const lane of runtime.existingLanes()) {
      for (const store of lane.set.openStores()) store.close();
      lane.secretLocations?.close();
      lane.ledger.close();
    }
  });
  const start = (name: string, content: string | Uint8Array): { archiveId: string; format: string; path: string } => {
    const path = join(exports, name);
    writeFileSync(path, content);
    const started = runtime.start(path);
    if (started.kind !== 'started') throw new Error(`expected a start, got ${started.kind}`);
    return { archiveId: started.archive.archive_id, format: started.archive.format, path };
  };
  return { base, env, exports, runtime, start };
}

export function pullNotes(runtime: ArchiveImportRuntime, archiveId: string, options: Partial<ArchiveImportPullOptions> = {}) {
  return pullArchiveImport({ state: runtime.state, lane: runtime.lane('note'), archiveId, ...options });
}

export async function importAllNotes(runtime: ArchiveImportRuntime, archiveId: string, options: Partial<ArchiveImportPullOptions> = {}) {
  for (let pass = 0; pass < 100; pass += 1) {
    const outcome = await pullNotes(runtime, archiveId, options);
    if (!outcome.continueSoon) return outcome;
  }
  throw new Error('the import did not finish');
}

export interface StoredNote {
  domain: 'public_safe' | 'internal' | 'secure_local';
  provider: string;
  family: string;
  accountScope: string;
  providerItemId: string;
  title: string | null;
  authoredAt: string | null;
}

/** Every stored note row across the notes stores, optionally of one archive. */
export function storedNotes(env: Record<string, string>, accountScope?: string): StoredNote[] {
  const rows: StoredNote[] = [];
  for (const domain of ['public_safe', 'internal', 'secure_local'] as const) {
    const path = archiveConnectorStoreDbPath(domain, 'note', env);
    if (!existsSync(path)) continue;
    const db = new Database(path, { readonly: true });
    try {
      const found = (accountScope
        ? db.query('SELECT provider, family, account_scope, provider_item_id, title, authored_at FROM items WHERE account_scope = ?').all(accountScope)
        : db.query('SELECT provider, family, account_scope, provider_item_id, title, authored_at FROM items').all()) as Array<{
          provider: string; family: string; account_scope: string; provider_item_id: string; title: string | null; authored_at: string | null;
        }>;
      for (const row of found) {
        rows.push({
          domain,
          provider: row.provider,
          family: row.family,
          accountScope: row.account_scope,
          providerItemId: row.provider_item_id,
          title: row.title,
          authoredAt: row.authored_at,
        });
      }
    } finally {
      db.close();
    }
  }
  return rows;
}

/** The text of every chunk one archive's notes have in one store (empty when the store does not exist yet). */
export function noteChunkTexts(env: Record<string, string>, domain: 'public_safe' | 'internal' | 'secure_local', accountScope: string): string[] {
  const path = archiveConnectorStoreDbPath(domain, 'note', env);
  if (!existsSync(path)) return [];
  const db = new Database(path, { readonly: true });
  try {
    const rows = db.query(`
      SELECT c.bounded_text AS text FROM chunks c JOIN items i ON i.item_pk = c.item_pk WHERE i.account_scope = ?
    `).all(accountScope) as Array<{ text: string }>;
    return rows.map((row) => row.text);
  } finally {
    db.close();
  }
}

/** How many embeddings one notes store holds. */
export function noteEmbeddingCount(env: Record<string, string>, domain: 'public_safe' | 'internal' | 'secure_local'): number {
  const path = archiveConnectorStoreDbPath(domain, 'note', env);
  if (!existsSync(path)) return 0;
  const db = new Database(path, { readonly: true });
  try {
    return (db.query('SELECT COUNT(*) AS n FROM chunk_embeddings').get() as { n: number }).n;
  } finally {
    db.close();
  }
}
