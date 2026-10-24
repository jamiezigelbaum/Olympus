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
import { existsSync, readFileSync } from 'node:fs';
import { writePrivateFileAtomicSync } from './atomic-file.ts';
import { withFileLeaseSync } from './file-lease.ts';
import { olympusDataPath, type LayoutEnv } from './olympus-layout.ts';

export const SOURCE_REGISTRY_SCHEMA = 1;

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
  schema: 1;
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
  if (!existsSync(path)) return { schema: SOURCE_REGISTRY_SCHEMA, accounts: [] };
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new SourceRegistryError(path, error instanceof SyntaxError ? 'not JSON' : 'cannot be read');
  }
  return validateRegistry(parsed, path);
}

const STATES: readonly string[] = ['active', 'deleting', 'deleted'];
const LAYOUTS: readonly string[] = ['legacy', 'folder'];

function validateRegistry(value: unknown, path: string): SourceRegistry {
  if (!isRecord(value)) throw new SourceRegistryError(path, 'not an object');
  if (value.schema !== SOURCE_REGISTRY_SCHEMA) throw new SourceRegistryError(path, `unknown schema ${JSON.stringify(value.schema)}`);
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
