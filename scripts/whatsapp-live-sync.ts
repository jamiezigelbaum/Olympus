// Periodic ingest for the live WhatsApp spool: reads the JSONL spool written
// by tools/whatsapp-bridge through the live SourceConnector and syncs it into
// the shared connector store (corpus secure_local.whatsapp.messages). Resumes
// from the cursor persisted by the previous sync run, so each invocation only
// ingests new spool lines. Run it from cron or a systemd timer:
//
//   OLYMPUS_WHATSAPP_STATE_DIR=~/.local/share/olympus/whatsapp-live \
//     bun scripts/whatsapp-live-sync.ts [--db <path>] [--account personal] [--max-items N]
//
// The store db defaults to <state dir>/connector-store.db, which the product
// worker now mounts directly (an account kept in its own account folder uses
// that folder's spool and secure_local store instead). This command remains a diagnostic/convergence
// utility; normal runtime sync is owned by the shared scheduler.
// Output is a Castor-safe JSON summary (counts + spool gap diagnostics only,
// never message text).

import {
  WHATSAPP_PERSONAL_SOURCE_ID,
  WHATSAPP_STORE_PLACEMENT,
  whatsAppLiveSyncScriptPaths,
} from '../src/workers/whatsapp/store-sync.ts';
import { runUnderDataOwnerLock } from '../src/core/data-owner-lock.ts';
import { openConnectorStore } from '../src/core/source-storage.ts';
import { repairConnectorStoreSendersFromConnector } from '../src/workers/connector-store/index.ts';
import {
  WHATSAPP_LIVE_CONNECTOR_ID,
  createWhatsAppLiveSourceConnector,
  readWhatsAppLiveSpoolStatus,
  sanitizeWhatsAppLiveCursor,
} from '../src/workers/whatsapp/index.ts';

const CORPUS_ID = 'secure_local.whatsapp.messages';

interface Args {
  mode: 'sync' | 'repair-senders';
  dbPath?: string;
  account?: string;
  maxItems?: number;
  cursor?: string;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  // An account in a folder is where the worker has it; any other keeps the paths this script always used.
  const paths = whatsAppLiveSyncScriptPaths(process.env);
  const spoolDir = paths.spoolDir;
  const dbPath = args.dbPath ?? paths.dbPath;

  const connector = createWhatsAppLiveSourceConnector({
    spoolDir,
    ...(args.account ? { account: args.account } : {}),
  });
  const store = openConnectorStore({ sourceId: WHATSAPP_PERSONAL_SOURCE_ID }, {
    dbPath,
    corpusId: CORPUS_ID,
    family: 'chat',
    trustDomain: 'secure_local',
  });
  try {
    if (args.mode === 'repair-senders') {
      const repair = await repairConnectorStoreSendersFromConnector({
        store,
        connector,
        ...(args.cursor ? { cursor: args.cursor } : {}),
        ...(args.maxItems !== undefined ? { maxItems: args.maxItems } : {}),
      });
      console.log(JSON.stringify({
        kind: 'whatsapp_sender_repair_receipt',
        ...repair,
        policy: {
          counts_only: true,
          raw_source_exposed: false,
          source_text_returned: false,
        },
      }, null, 2));
      return;
    }
    // Scoped to this connector's own completed runs, and sanitized: the store
    // may hold runs of an earlier export import, whose cursors are a different
    // format, and an unfinished row hands back the cursor its run STARTED from.
    const cursor = sanitizeWhatsAppLiveCursor(
      store.lastCompletedSyncRun(WHATSAPP_LIVE_CONNECTOR_ID)?.cursor,
    );
    const summary = await store.syncFromConnector(connector, {
      placement: WHATSAPP_STORE_PLACEMENT,
      ...(cursor ? { cursor } : {}),
      ...(args.maxItems !== undefined ? { maxItems: args.maxItems } : {}),
      fetchContent: true,
      // Same hazard, same disposition as the product lane in store-sync.ts:
      // text messages carry their body in the spool listing, media bodies are
      // owned by the shared extraction factory. This script writes the same db
      // and the same item identities the product lane does, so a metadata-only
      // observation here must preserve the transcript that factory wrote
      // instead of deleting it as "authoritatively no text".
      deferMetadataOnlyContent: true,
    });
    const spool = readWhatsAppLiveSpoolStatus(spoolDir);
    console.log(JSON.stringify({ summary, spool }, null, 2));
    if (spool.malformedLines > 0) {
      console.error(`whatsapp-live-sync: ${spool.malformedLines} malformed spool line(s) skipped (gap).`);
    }
  } finally {
    store.close();
  }
}

function parseArgs(argv: string[]): Args {
  const args: Args = { mode: 'sync' };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = argv[index + 1];
    switch (flag) {
      case '--mode':
        if (value !== 'sync' && value !== 'repair-senders') {
          fail('--mode must be sync or repair-senders.');
        }
        args.mode = value;
        index += 1;
        break;
      case '--db':
        if (!value) fail('--db requires a path.');
        args.dbPath = value;
        index += 1;
        break;
      case '--account':
        if (!value) fail('--account requires a value.');
        args.account = value;
        index += 1;
        break;
      case '--max-items': {
        const parsed = Number(value);
        if (!Number.isInteger(parsed) || parsed < 1) fail('--max-items requires a positive integer.');
        args.maxItems = parsed;
        index += 1;
        break;
      }
      case '--cursor':
        if (!value?.trim()) fail('--cursor requires a connector cursor.');
        args.cursor = value;
        index += 1;
        break;
      default:
        fail(`Unknown argument ${flag}. Usage: whatsapp-live-sync.ts [--mode sync|repair-senders] [--db <path>] [--account <scope>] [--max-items N] [--cursor <cursor>]`);
    }
  }
  return args;
}

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

// Held for the whole run: it refuses while Olympus runs (core/data-owner-lock.ts).
await runUnderDataOwnerLock(main);
