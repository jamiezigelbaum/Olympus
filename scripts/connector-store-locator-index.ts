// Bounded operator for the shared connector-store locator identity projection.
// Dry-run is the default and never upgrades a schema. `--execute` applies the
// additive schema migration when needed and advances exactly one bounded
// item-primary-key window. Output is counts/state only: no store path, locator,
// filename, item identity, or source content is emitted.

import { Database } from 'bun:sqlite';
import { lstatSync } from 'node:fs';
import {
  LocalConnectorStore,
  type ConnectorStoreLocatorIdentityIndexStatus,
} from '../src/workers/connector-store/index.ts';
import { resolveConnectorStoreOptions } from './connector-store-embed.ts';

const STORE_ID = 'connector-store';
const CURRENT_SCHEMA_VERSION = 11;
const DEFAULT_BATCH_ITEMS = 1_000;
const USAGE = 'Usage: bun run connector-store:locator-index --db <path> '
  + '[--max-items N] [--corpus-id <id> --family <family> --trust-domain <domain>] [--execute]';

export interface ConnectorStoreLocatorIndexCliArgs {
  db: string;
  maxItems: number;
  execute: boolean;
  corpusId?: string;
  family?: string;
  trustDomain?: string;
}

export interface ConnectorStoreLocatorIndexReceipt {
  kind: 'connector_store_locator_identity_index';
  execute: boolean;
  schemaVersionBefore: number;
  schemaVersionAfter: number;
  before: ConnectorStoreLocatorIdentityIndexStatus | { state: 'schema_upgrade_required' };
  after: ConnectorStoreLocatorIdentityIndexStatus | { state: 'schema_upgrade_required' };
  batch: {
    scannedItems: number;
    cursorItemPk: number;
  } | null;
  policy: {
    countsOnly: true;
    sourceIdentifiersExposed: false;
    sourceTextExposed: false;
  };
}

export function parseConnectorStoreLocatorIndexCliArgs(
  argv: readonly string[],
): ConnectorStoreLocatorIndexCliArgs {
  let db: string | undefined;
  let maxItems = DEFAULT_BATCH_ITEMS;
  let execute = false;
  let corpusId: string | undefined;
  let family: string | undefined;
  let trustDomain: string | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index]!;
    const value = (): string => {
      const next = argv[index + 1]?.trim();
      if (!next) throw new Error(`${flag} requires a value. ${USAGE}`);
      index += 1;
      return next;
    };
    if (flag === '--db') db = value();
    else if (flag === '--max-items') {
      const parsed = Number(value());
      if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 10_000) {
        throw new Error('--max-items must be an integer between 1 and 10,000.');
      }
      maxItems = parsed;
    } else if (flag === '--corpus-id') corpusId = value();
    else if (flag === '--family') family = value();
    else if (flag === '--trust-domain') trustDomain = value();
    else if (flag === '--execute') execute = true;
    else throw new Error(`Unknown flag ${flag}. ${USAGE}`);
  }
  if (!db) throw new Error(USAGE);
  const identityFlags = [corpusId, family, trustDomain].filter(Boolean).length;
  if (identityFlags !== 0 && identityFlags !== 3) {
    throw new Error('--corpus-id, --family, and --trust-domain must be supplied together.');
  }
  return {
    db,
    maxItems,
    execute,
    ...(corpusId ? { corpusId } : {}),
    ...(family ? { family } : {}),
    ...(trustDomain ? { trustDomain } : {}),
  };
}

export function runConnectorStoreLocatorIndex(
  argv: readonly string[],
  env: Record<string, string | undefined> = process.env,
): ConnectorStoreLocatorIndexReceipt {
  const args = parseConnectorStoreLocatorIndexCliArgs(argv);
  const stat = lstatSync(args.db);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error('Connector store locator-index maintenance requires a regular non-symlink database file.');
  }
  const schemaVersionBefore = readSchemaVersion(args.db);
  const options = resolveConnectorStoreOptions(args, env);
  if (!args.execute && schemaVersionBefore < CURRENT_SCHEMA_VERSION) {
    return receipt({
      execute: false,
      schemaVersionBefore,
      schemaVersionAfter: schemaVersionBefore,
      before: { state: 'schema_upgrade_required' },
      after: { state: 'schema_upgrade_required' },
      batch: null,
    });
  }

  const store = new LocalConnectorStore({ ...options, readOnly: !args.execute });
  try {
    const before = store.locatorIdentityIndexStatus();
    if (!args.execute) {
      return receipt({
        execute: false,
        schemaVersionBefore,
        schemaVersionAfter: schemaVersionBefore,
        before,
        after: before,
        batch: null,
      });
    }
    const batch = store.backfillLocatorIdentityIndex({ maxItems: args.maxItems });
    return receipt({
      execute: true,
      schemaVersionBefore,
      schemaVersionAfter: CURRENT_SCHEMA_VERSION,
      before,
      after: {
        state: batch.state,
        cursorItemPk: batch.cursorItemPk,
        indexedItems: batch.indexedItems,
      },
      batch: {
        scannedItems: batch.scannedItems,
        cursorItemPk: batch.cursorItemPk,
      },
    });
  } finally {
    store.close();
  }
}

function readSchemaVersion(dbPath: string): number {
  const db = new Database(dbPath, { readonly: true, create: false });
  try {
    db.exec('PRAGMA busy_timeout = 10000;');
    const row = db.query(`
      SELECT version FROM schema_version WHERE store_id = ?
    `).get(STORE_ID) as { version: number } | null;
    if (!row) throw new Error('Connector store schema version is missing.');
    return row.version;
  } finally {
    db.close();
  }
}

function receipt(
  value: Omit<ConnectorStoreLocatorIndexReceipt, 'kind' | 'policy'>,
): ConnectorStoreLocatorIndexReceipt {
  return {
    kind: 'connector_store_locator_identity_index',
    ...value,
    policy: {
      countsOnly: true,
      sourceIdentifiersExposed: false,
      sourceTextExposed: false,
    },
  };
}

if (import.meta.main) {
  try {
    console.log(JSON.stringify(runConnectorStoreLocatorIndex(process.argv.slice(2)), null, 2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
