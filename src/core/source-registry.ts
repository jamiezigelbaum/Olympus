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
 */
export const SOURCE_REGISTRY_SCHEMA = 1;
export const SOURCE_REGISTRY_FOLDER_SCHEMA = 2;
const KNOWN_SCHEMAS: readonly unknown[] = [SOURCE_REGISTRY_SCHEMA, SOURCE_REGISTRY_FOLDER_SCHEMA];

/** Every source has one account slot today (docs/design/source-storage.md, "Registry"). */
export const DEFAULT_ACCOUNT_SLOT = '1';

export type SourceRegistryAccountState = 'active' | 'deleting' | 'deleted';
export type SourceRegistryAccountLayout = 'legacy' | 'folder';

export interface SourceRegistryAccount {
  source_id: string;
  slot: string;
  state: SourceRegistryAccountState;
  /** `legacy`: the files are still at today's paths. `folder`: inside `sources/<source_id>/<slot>/`. */
  layout: SourceRegistryAccountLayout;
  corpus_ids: string[];
  provider_account_hash?: string;
  created_at: string;
}

export interface SourceRegistry {
  schema: typeof SOURCE_REGISTRY_SCHEMA | typeof SOURCE_REGISTRY_FOLDER_SCHEMA;
  accounts: SourceRegistryAccount[];
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
    // The schema follows the content: 2 once any account lives in a folder.
    next.schema = next.accounts.some((account) => account.layout === 'folder')
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
    && nonEmptyString(value.created_at);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
