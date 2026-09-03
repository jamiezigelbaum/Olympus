// Bounded operator for the one-time Telegram trust reconciliation sweep: every
// identity the secure-local store actively holds gives up its internal-lane
// copy. The live sync runs the same sweep in small windows; this script drains
// it immediately, or previews it. Dry-run is the default and opens both stores
// read-only. Output is counts/state only: no store path, identity, or source
// content is emitted.

import { lstatSync } from 'node:fs';
import { LocalConnectorStore } from '../src/workers/connector-store/index.ts';
import {
  INTERNAL_TELEGRAM_MESSAGES_CORPUS_ID,
  PROTECTED_TELEGRAM_MESSAGES_CORPUS_ID,
  TELEGRAM_CAPTURE_CONNECTOR_IDS,
  TELEGRAM_TRUST_RECONCILIATION_CONNECTOR_ID,
  defaultInternalTelegramConnectorStoreDbPath,
  defaultProtectedTelegramConnectorStoreDbPath,
  reconcileTelegramTrustStores,
  type TelegramConnectorStores,
} from '../src/workers/telegram-messages/index.ts';

const DEFAULT_BATCH_ITEMS = 1_000;
// A full drain by default: the operator lane exists to finish the sweep now
// rather than wait for the live schedule's small windows.
const DEFAULT_MAX_WINDOWS = 10_000;
const USAGE = 'Usage: bun run telegram:trust-reconcile '
  + '[--internal-db <path>] [--protected-db <path>] [--max-items N] [--max-windows N] [--execute]';

export interface TelegramTrustReconcileCliArgs {
  internalDb: string;
  protectedDb: string;
  maxItems: number;
  maxWindows: number;
  execute: boolean;
}

export interface TelegramTrustReconcileReceipt {
  kind: 'telegram_trust_reconciliation';
  execute: boolean;
  before: { state: 'ready' | 'in_progress'; cursorItemPk: number };
  after: { state: 'ready' | 'in_progress'; cursorItemPk: number };
  counts: {
    internal_active_items: number;
    internal_tombstoned_items: number;
    secure_local_active_items: number;
    identities_scanned: number;
    items_relinquished: number;
    items_would_relinquish: number;
  };
  policy: {
    countsOnly: true;
    sourceIdentifiersExposed: false;
    sourceTextExposed: false;
  };
}

export function parseTelegramTrustReconcileCliArgs(
  argv: readonly string[],
  env: Record<string, string | undefined> = process.env,
): TelegramTrustReconcileCliArgs {
  let internalDb = defaultInternalTelegramConnectorStoreDbPath(env);
  let protectedDb = defaultProtectedTelegramConnectorStoreDbPath(env);
  let maxItems = DEFAULT_BATCH_ITEMS;
  let maxWindows = DEFAULT_MAX_WINDOWS;
  let execute = false;
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index]!;
    const value = (): string => {
      const next = argv[index + 1]?.trim();
      if (!next) throw new Error(`${flag} requires a value. ${USAGE}`);
      index += 1;
      return next;
    };
    const bounded = (limit: number): number => {
      const parsed = Number(value());
      if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > limit) {
        throw new Error(`${flag} must be an integer between 1 and ${limit.toLocaleString('en-US')}.`);
      }
      return parsed;
    };
    if (flag === '--internal-db') internalDb = value();
    else if (flag === '--protected-db') protectedDb = value();
    else if (flag === '--max-items') maxItems = bounded(10_000);
    else if (flag === '--max-windows') maxWindows = bounded(100_000);
    else if (flag === '--execute') execute = true;
    else throw new Error(`Unknown flag ${flag}. ${USAGE}`);
  }
  return { internalDb, protectedDb, maxItems, maxWindows, execute };
}

export function runTelegramTrustReconcile(
  argv: readonly string[],
  env: Record<string, string | undefined> = process.env,
): TelegramTrustReconcileReceipt {
  const args = parseTelegramTrustReconcileCliArgs(argv, env);
  const files = [args.internalDb, args.protectedDb].map((dbPath) => {
    const stat = lstatSync(dbPath);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new Error('Telegram trust reconciliation requires regular non-symlink database files.');
    }
    return stat;
  });
  // One database handed in as both stores would enumerate its own rows as the
  // secure lane's claims and tombstone every one of them. Device+inode also
  // catches hard links and symlinked ancestors, which path equality does not.
  if (files[0]!.dev === files[1]!.dev && files[0]!.ino === files[1]!.ino) {
    throw new Error('Telegram trust reconciliation refuses one database as both stores.');
  }
  const stores: TelegramConnectorStores = {
    internal: new LocalConnectorStore({
      dbPath: args.internalDb,
      corpusId: INTERNAL_TELEGRAM_MESSAGES_CORPUS_ID,
      family: 'chat',
      trustDomain: 'internal',
      readOnly: !args.execute,
    }),
    secureLocal: new LocalConnectorStore({
      dbPath: args.protectedDb,
      corpusId: PROTECTED_TELEGRAM_MESSAGES_CORPUS_ID,
      family: 'chat',
      trustDomain: 'secure_local',
      readOnly: true,
    }),
  };
  try {
    // The flags NAME lanes; a swapped pair would invert the sweep and evict
    // the protected store's copies. Each live lane store carries its own
    // lane-suffixed capture lineage, so a store holding the OTHER lane's
    // lineage is proof the flags are crossed. A fresh store carries no
    // evidence and passes — sweeping genuinely fresh stores is a no-op.
    if (stores.internal.lastCompletedSyncRun(TELEGRAM_CAPTURE_CONNECTOR_IDS.secure_local)
      || stores.secureLocal.lastCompletedSyncRun(TELEGRAM_CAPTURE_CONNECTOR_IDS.internal)) {
      throw new Error('Telegram trust reconciliation refuses a store whose run history belongs to the other lane.');
    }
    const before = stores.internal.trustReconciliationStatus(
      TELEGRAM_TRUST_RECONCILIATION_CONNECTOR_ID,
    );
    let after = before;
    let identitiesScanned = 0;
    let itemsRelinquished = 0;
    let itemsWouldRelinquish = 0;
    if (args.execute) {
      const sweep = reconcileTelegramTrustStores(stores, {
        maxItems: args.maxItems,
        maxWindows: args.maxWindows,
      });
      after = { state: sweep.state, cursorItemPk: sweep.cursorItemPk };
      identitiesScanned = sweep.identitiesScanned;
      itemsRelinquished = sweep.itemsRelinquished;
    } else {
      // The same walk the sweep would take, probing instead of relinquishing,
      // and leaving the durable cursor untouched.
      let cursorItemPk = before.cursorItemPk;
      let exhausted = before.state === 'ready';
      for (let window = 0; !exhausted && window < args.maxWindows; window += 1) {
        const page = stores.secureLocal.activeItemIdentities({
          afterItemPk: cursorItemPk,
          maxItems: args.maxItems,
        });
        for (const identity of page.identities) {
          if (stores.internal.itemPresence(identity).active) itemsWouldRelinquish += 1;
        }
        identitiesScanned += page.identities.length;
        cursorItemPk = page.cursorItemPk;
        exhausted = page.exhausted;
      }
    }
    const internalStatus = stores.internal.status();
    const secureStatus = stores.secureLocal.status();
    return {
      kind: 'telegram_trust_reconciliation',
      execute: args.execute,
      before,
      after,
      counts: {
        internal_active_items: internalStatus.counts.items,
        internal_tombstoned_items: internalStatus.counts.tombstonedItems,
        secure_local_active_items: secureStatus.counts.items,
        identities_scanned: identitiesScanned,
        items_relinquished: itemsRelinquished,
        items_would_relinquish: itemsWouldRelinquish,
      },
      policy: {
        countsOnly: true,
        sourceIdentifiersExposed: false,
        sourceTextExposed: false,
      },
    };
  } finally {
    stores.secureLocal.close();
    stores.internal.close();
  }
}

if (import.meta.main) {
  try {
    console.log(JSON.stringify(runTelegramTrustReconcile(process.argv.slice(2)), null, 2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
