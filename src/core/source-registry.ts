/**
 * The account registry: which connected accounts exist, what state each is
 * in, and which corpora it holds (docs/design/source-storage.md, "Registry").
 *
 * `<data>/registry.json`, written atomically under the file's cross-process
 * lease. A missing file is an empty registry. A file that cannot be read or
 * parsed, or names a schema this engine does not know, is never treated as
 * empty: an account it marks as being deleted must not be opened just
 * because the marker could not be read.
 *
 * Deliberately light (no SQLite, no workers): the storage service reads it
 * before every store open.
 */
import { readFileSync } from 'node:fs';
import { writePrivateFileAtomicSync } from './atomic-file.ts';
import { withFileLeaseSync } from './file-lease.ts';
import { olympusDataPath, type LayoutEnv } from './olympus-layout.ts';

/**
 * The schema of a registry with no `folder` account. The file is written as
 * `SOURCE_REGISTRY_FOLDER_SCHEMA` from the moment one account is: a build that
 * only knows schema 1 (delivery step 3) then fails closed on it, as on any
 * unknown schema, instead of ignoring `layout` and opening empty stores at the
 * legacy paths beside the folder that holds the data.
 *
 * It is `SOURCE_REGISTRY_MOVING_SCHEMA` for as long as any account has a move
 * pending (the boot migration, step 4c): an account that is `legacy` with half
 * of its files already in its folder looks, to a build that does not know the
 * plan (4a and 4b), like any other legacy account, and that build would open
 * empty stores at the legacy paths beside the folder that holds the rest.
 */
export const SOURCE_REGISTRY_SCHEMA = 1;
export const SOURCE_REGISTRY_FOLDER_SCHEMA = 2;
export const SOURCE_REGISTRY_MOVING_SCHEMA = 3;
const KNOWN_SCHEMAS: readonly unknown[] = [SOURCE_REGISTRY_SCHEMA, SOURCE_REGISTRY_FOLDER_SCHEMA, SOURCE_REGISTRY_MOVING_SCHEMA];

/** Every source has one account slot today (docs/design/source-storage.md, "Registry"). */
export const DEFAULT_ACCOUNT_SLOT = '1';

export type SourceRegistryAccountState = 'active' | 'deleting' | 'deleted';
export type SourceRegistryAccountLayout = 'legacy' | 'folder';

/**
 * The boot migration's record on an entry (core/source-account-migration.ts;
 * additive, absent on an account that was never considered):
 *
 * - `moving` and `reverting` are pending: the plan is written, the files are
 *   partly in each place, and the account is closed (never opened) until a
 *   boot finishes it. Only these carry `moves`.
 * - `done`, `skipped` and `failed` are records. `skipped` left the account at
 *   its legacy paths and says why (`reason` is a short code, `detail` plain
 *   words); `failed` moved everything back after a check failed.
 */
export type SourceRegistryMigrationState = 'moving' | 'reverting' | 'done' | 'skipped' | 'failed';

/** What a moved file is, so the plan can find a store's sidecars and the ledgers a store is bound to. */
export type SourceRegistryMoveRole = 'store' | 'ledger' | 'secrets' | 'sniffer' | 'raw';

/**
 * One rename of the plan. Paths are relative to the data root (the registry
 * names no home folder), `from` where the file has always been and `to` inside
 * the account's folder. `dev`, `ino` and `size` are the file's identity when the
 * plan was written: the same three must be found at `to`. A directory has no
 * size that means anything and records 0.
 */
export interface SourceRegistryMove {
  role: SourceRegistryMoveRole;
  from: string;
  to: string;
  kind: 'file' | 'dir';
  /** A SQLite database: opened read-only after the move to see that it still reads. */
  db?: true;
  dev: string;
  ino: string;
  size: number;
}

/**
 * A store's media-cache holder before the move: the marker names (digests) the
 * cache holds for it, and the store's new path, relative to the data root. The
 * markers are re-keyed to the new path before the layout flips, so the cache
 * drops no picture and keeps no marker for a store that has moved.
 */
export interface SourceRegistryMediaHolder {
  store: string;
  digests: string[];
}

export interface SourceRegistryMigration {
  state: SourceRegistryMigrationState;
  at: string;
  reason?: string;
  detail?: string;
  moves?: SourceRegistryMove[];
  holders?: SourceRegistryMediaHolder[];
  /** The renames are complete and every file has its recorded identity; later steps change file sizes. */
  verified?: true;
  /** `PRAGMA quick_check` of each database before the move, to record how it was; never a reason to stop. */
  checked?: Array<{ file: string; result: 'ok' | 'damaged' | 'not_checked' }>;
}

export interface SourceRegistryAccount {
  source_id: string;
  slot: string;
  state: SourceRegistryAccountState;
  /** `legacy`: the files are still at today's paths. `folder`: inside `sources/<source_id>/<slot>/`. */
  layout: SourceRegistryAccountLayout;
  corpus_ids: string[];
  provider_account_hash?: string;
  created_at: string;
  migration?: SourceRegistryMigration;
}

export interface SourceRegistry {
  schema: typeof SOURCE_REGISTRY_SCHEMA | typeof SOURCE_REGISTRY_FOLDER_SCHEMA | typeof SOURCE_REGISTRY_MOVING_SCHEMA;
  accounts: SourceRegistryAccount[];
}

/** Whether a move of the account's files is partly done: its plan decides where they are, so nothing may open it. */
export function sourceAccountMovePending(account: Pick<SourceRegistryAccount, 'migration'>): boolean {
  return account.migration?.state === 'moving' || account.migration?.state === 'reverting';
}

/**
 * What the boot migration left that the owner has to hear about, for the
 * dashboard's Needs you list (never a skip that explains itself, such as an
 * override the owner set):
 *
 * - `moved_back`: a check failed after the files moved, so they were put back;
 * - `stuck`: a move is part way and the account is closed until a boot ends it;
 * - `unreadable`: a place its files are in cannot be looked at;
 * - `in_the_way`: its files are at their old place and in the new folder too.
 */
export type SourceStorageNoticeKind = 'moved_back' | 'stuck' | 'unreadable' | 'in_the_way';

export interface SourceStorageNotice {
  source_id: string;
  kind: SourceStorageNoticeKind;
}

export function sourceStorageNotices(env: LayoutEnv = process.env): SourceStorageNotice[] {
  let registry: SourceRegistry;
  try {
    registry = readSourceRegistry(env);
  } catch {
    return [];
  }
  const notices: SourceStorageNotice[] = [];
  for (const account of registry.accounts) {
    const migration = account.migration;
    if (account.state !== 'active' || !migration) continue;
    const kind: SourceStorageNoticeKind | undefined = sourceAccountMovePending(account)
      ? 'stuck'
      : migration.state === 'failed'
        ? 'moved_back'
        : migration.state === 'skipped' && migration.reason === 'unreadable'
          ? 'unreadable'
          : migration.state === 'skipped' && migration.reason === 'destination_exists'
            ? 'in_the_way'
            : undefined;
    if (kind) notices.push({ source_id: account.source_id, kind });
  }
  return notices;
}

export class SourceRegistryError extends Error {
  readonly code = 'source_registry_unreadable';
  readonly path: string;

  constructor(path: string, detail: string) {
    super(`The source registry at ${path} is unreadable (${detail}); no source store opens until it is repaired.`);
    this.name = 'SourceRegistryError';
    this.path = path;
  }
}

export function sourceRegistryPath(env: LayoutEnv = process.env): string {
  return olympusDataPath(env, 'registry.json');
}

export function readSourceRegistry(env: LayoutEnv = process.env): SourceRegistry {
  return readSourceRegistryAt(sourceRegistryPath(env));
}

/**
 * Read the registry once no writer is partway through a decision: the lease is
 * taken, so a writer that read before this call has committed, and one that
 * reads after it sees whatever this caller did before calling.
 */
export function readSourceRegistryUnderLease(env: LayoutEnv = process.env): SourceRegistry {
  const path = sourceRegistryPath(env);
  return withFileLeaseSync(path, () => readSourceRegistryAt(path));
}

/**
 * Read-modify-write the registry under its lease. `mutate` may change the
 * registry in place or return a replacement; a throw writes nothing.
 */
export function updateSourceRegistry(
  env: LayoutEnv,
  mutate: (registry: SourceRegistry) => SourceRegistry | void,
): SourceRegistry {
  const path = sourceRegistryPath(env);
  return withFileLeaseSync(path, (lease) => {
    const current = readSourceRegistryAt(path);
    const next = mutate(current) ?? current;
    // The schema follows the content: 3 while a move is pending, else 2 once any account lives in a folder.
    next.schema = next.accounts.some(sourceAccountMovePending)
      ? SOURCE_REGISTRY_MOVING_SCHEMA
      : next.accounts.some((account) => account.layout === 'folder')
        ? SOURCE_REGISTRY_FOLDER_SCHEMA
        : SOURCE_REGISTRY_SCHEMA;
    const text = `${JSON.stringify(validateRegistry(next, path), null, 2)}\n`;
    lease.commit(() => writePrivateFileAtomicSync(path, text));
    return next;
  });
}

export function findRegistryAccount(
  registry: SourceRegistry,
  sourceId: string,
  slot: string,
): SourceRegistryAccount | undefined {
  return registry.accounts.find((account) => account.source_id === sourceId && account.slot === slot);
}

function readSourceRegistryAt(path: string): SourceRegistry {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    // Only a file that is not there is an empty registry. A folder that cannot
    // be searched hides a registry that may mark an account as being deleted.
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return { schema: SOURCE_REGISTRY_SCHEMA, accounts: [] };
    throw new SourceRegistryError(path, 'cannot be read');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new SourceRegistryError(path, 'not JSON');
  }
  return validateRegistry(parsed, path);
}

const STATES: readonly string[] = ['active', 'deleting', 'deleted'];
const LAYOUTS: readonly string[] = ['legacy', 'folder'];

function validateRegistry(value: unknown, path: string): SourceRegistry {
  if (!isRecord(value)) throw new SourceRegistryError(path, 'not an object');
  if (!KNOWN_SCHEMAS.includes(value.schema)) throw new SourceRegistryError(path, `unknown schema ${JSON.stringify(value.schema)}`);
  if (!Array.isArray(value.accounts)) throw new SourceRegistryError(path, 'accounts is not a list');
  const seen = new Set<string>();
  for (const [index, account] of value.accounts.entries()) {
    if (!isValidAccount(account)) throw new SourceRegistryError(path, `account #${index + 1} is malformed`);
    const key = `${account.source_id}\u0000${account.slot}`;
    if (seen.has(key)) throw new SourceRegistryError(path, `${account.source_id} slot ${account.slot} is listed twice`);
    seen.add(key);
  }
  return value as unknown as SourceRegistry;
}

function isValidAccount(value: unknown): value is SourceRegistryAccount {
  return isRecord(value)
    && nonEmptyString(value.source_id)
    && nonEmptyString(value.slot)
    && typeof value.state === 'string' && STATES.includes(value.state)
    && typeof value.layout === 'string' && LAYOUTS.includes(value.layout)
    && Array.isArray(value.corpus_ids) && value.corpus_ids.every(nonEmptyString)
    && (value.provider_account_hash === undefined || nonEmptyString(value.provider_account_hash))
    && nonEmptyString(value.created_at)
    && (value.migration === undefined || isValidMigration(value.migration));
}

const MIGRATION_STATES: readonly string[] = ['moving', 'reverting', 'done', 'skipped', 'failed'];
const MOVE_ROLES: readonly string[] = ['store', 'ledger', 'secrets', 'sniffer', 'raw'];

// A pending plan that cannot be read must close the registry, like any malformed
// entry: nothing says where the account's files are.
function isValidMigration(value: unknown): value is SourceRegistryMigration {
  if (!isRecord(value)) return false;
  const pending = value.state === 'moving' || value.state === 'reverting';
  return typeof value.state === 'string' && MIGRATION_STATES.includes(value.state)
    && nonEmptyString(value.at)
    && (value.reason === undefined || nonEmptyString(value.reason))
    && (value.detail === undefined || typeof value.detail === 'string')
    && (value.moves === undefined || (Array.isArray(value.moves) && value.moves.every(isValidMove)))
    && (!pending || Array.isArray(value.moves))
    && (value.holders === undefined || (Array.isArray(value.holders) && value.holders.every(isValidHolder)))
    && (value.verified === undefined || value.verified === true)
    && (value.checked === undefined || (Array.isArray(value.checked) && value.checked.every(isValidCheck)));
}

function isValidMove(value: unknown): value is SourceRegistryMove {
  return isRecord(value)
    && typeof value.role === 'string' && MOVE_ROLES.includes(value.role)
    && nonEmptyString(value.from)
    && nonEmptyString(value.to)
    && (value.kind === 'file' || value.kind === 'dir')
    && (value.db === undefined || value.db === true)
    && nonEmptyString(value.dev)
    && nonEmptyString(value.ino)
    && typeof value.size === 'number' && Number.isSafeInteger(value.size) && value.size >= 0;
}

function isValidHolder(value: unknown): value is SourceRegistryMediaHolder {
  return isRecord(value) && nonEmptyString(value.store)
    && Array.isArray(value.digests) && value.digests.every(nonEmptyString);
}

function isValidCheck(value: unknown): boolean {
  return isRecord(value) && nonEmptyString(value.file)
    && (value.result === 'ok' || value.result === 'damaged' || value.result === 'not_checked');
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
