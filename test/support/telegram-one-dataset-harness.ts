// The real Telegram source with its two inputs, for tests: the live capture
// spool (synthetic records written the way the helper writes them) and a
// Telegram Desktop export imported through the real archive import, dashboard
// approval, tier store set and intake rule (docs/design/archive-live-one-dataset.md).
// Nothing here is real data: every chat, name and message is made up.

import { Database } from 'bun:sqlite';
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { placeOwnedAccount, recordProviderAccount } from '../../src/core/source-storage.ts';
import { TELEGRAM_SOURCE_ID } from '../../src/core/olympus-layout.ts';
import { SecretLocationsIndex } from '../../src/workers/classification/secret-locations.ts';
import { secretLocationsPathForStore } from '../../src/workers/classification/tier-ledger-path.ts';
import { createArchiveImportDashboard, type ArchiveImportDashboard } from '../../src/workers/archive-import/dashboard.ts';
import { createArchiveImportRuntime, type ArchiveImportRuntime } from '../../src/workers/archive-import/runtime.ts';
import { ArchiveSourceTargets } from '../../src/workers/archive-import/source-targets.ts';
import { pullArchiveImport, type ArchiveImportPullOptions } from '../../src/workers/archive-import/sync.ts';
import { createArchivePathResolver } from '../../src/workers/local-files/scope-browser.ts';
import { approveStaged } from './stage-upload.ts';
import { MacPermissions } from '../../src/workers/local-files/mac-permissions.ts';
import { VolumeResolver } from '../../src/workers/local-files/volume-identity.ts';
import {
  INTERNAL_TELEGRAM_MESSAGES_CORPUS_ID,
  PROTECTED_TELEGRAM_MESSAGES_CORPUS_ID,
  TELEGRAM_PERSONAL_ACCOUNT_SCOPE,
  createTelegramConnectorStores,
  createTelegramConnectorStoreSyncHandler,
  defaultTelegramCaptureSpoolDir,
  type TelegramConnectorStores,
  type TelegramConnectorStoreSyncHandler,
} from '../../src/workers/telegram-messages/index.ts';
import { telegramJson, writeTelegramExport } from './archive-fixtures-telegram.ts';
import { liveSpoolLine, type LiveMessage } from './telegram-spool-fixtures.ts';

const ACCOUNT = TELEGRAM_PERSONAL_ACCOUNT_SCOPE;

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export { liveSpoolLine, type LiveMessage } from './telegram-spool-fixtures.ts';

export interface TelegramOneDatasetHarness {
  home: string;
  env: Record<string, string>;
  stores: TelegramConnectorStores;
  live: TelegramConnectorStoreSyncHandler;
  runtime: ArchiveImportRuntime;
  targets: ArchiveSourceTargets;
  dashboard: ArchiveImportDashboard;
  spoolDir: string;
  exportsDir: string;
  /** The account is there as pairing leaves it: its entry, naming the paired account. */
  pairLive(userId?: string | null): void;
  /** Appends live records to the spool (one day's file). */
  capture(messages: readonly LiveMessage[], day?: string): void;
  /** Writes an export folder (result.json and any media) and returns the folder's path. */
  writeExport(name: string, value: unknown, media?: Record<string, string>): string;
  startImport(path: string, answer?: { confirmAccount?: true; keepApart?: true }): Promise<Awaited<ReturnType<ArchiveImportDashboard['approve']>>>;
  importAll(archiveId: string, options?: Partial<ArchiveImportPullOptions>): Promise<Awaited<ReturnType<typeof pullArchiveImport>>>;
  /** Active rows across both stores: id is `<conversation>:<message>` (children with their key). */
  rows(): Array<{ domain: 'internal' | 'secure_local'; conversation: string; id: string; version: string | null; chunks: number; parent: string | null; locator: string | null; available: number | null }>;
  textOf(conversation: string, id: string): string;
  close(): void;
}

export function telegramOneDatasetHarness(cleanups: Array<() => void>): TelegramOneDatasetHarness {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'telegram-one-dataset-')));
  const home = join(base, 'home');
  const exportsDir = join(home, 'Exports');
  mkdirSync(exportsDir, { recursive: true });
  const env = { HOME: home, XDG_DATA_HOME: join(home, '.local', 'share'), XDG_STATE_HOME: join(home, '.local', 'state') };
  placeOwnedAccount({ sourceId: TELEGRAM_SOURCE_ID }, env);
  const stores = createTelegramConnectorStores(env);
  const spoolDir = defaultTelegramCaptureSpoolDir(env);
  mkdirSync(spoolDir, { recursive: true });
  const secrets = new SecretLocationsIndex({ dbPath: secretLocationsPathForStore(stores.secureLocal.dbPath) });
  const live = createTelegramConnectorStoreSyncHandler({ stores, spoolDir, env, secretLocations: secrets });
  const targets = new ArchiveSourceTargets();
  targets.register(live.archiveTarget());
  const runtime = createArchiveImportRuntime({
    env,
    waitingQuestionsDbPath: join(base, 'waiting-private-questions.sqlite'),
    openSecretLocations: (secureDbPath) => new SecretLocationsIndex({ dbPath: secretLocationsPathForStore(secureDbPath) }),
    targets,
  });
  const volumes = new VolumeResolver({ platform: 'darwin', home, readMounts: () => '/dev/disk3s1s1 on / (apfs, local)', diskutilPlist: () => undefined });
  const permissions = new MacPermissions({ home, memoryPath: join(base, 'folder-access.json'), platform: 'linux' });
  const resolver = createArchivePathResolver({ volumes, home, permissions });
  const dashboard = createArchiveImportDashboard({ runtime, resolver, refreshScheduler: () => undefined, privateModel: () => 'ready', home });
  let closed = false;
  const close = (): void => {
    if (closed) return;
    closed = true;
    dashboard.close();
    runtime.media.close();
    for (const lane of runtime.existingLanes()) {
      for (const store of lane.set.openStores()) store.close();
      lane.secretLocations?.close();
      lane.ledger.close();
    }
    stores.internal.close();
    stores.secureLocal.close();
    secrets.close();
    rmSync(base, { recursive: true, force: true });
  };
  cleanups.push(close);
  const h: TelegramOneDatasetHarness = {
    home, env, stores, live, runtime, targets, dashboard, spoolDir, exportsDir,
    pairLive(userId = '1001') {
      if (userId !== null) recordProviderAccount({ sourceId: TELEGRAM_SOURCE_ID }, `telegram:${sha256(userId).slice(0, 16)}`, env);
    },
    capture(messages, day = '2026-10-20') {
      appendFileSync(join(spoolDir, `${day}.jsonl`), messages.map((message) => liveSpoolLine(message)).join(''));
    },
    writeExport(name, value, media = {}) {
      const dir = join(exportsDir, name);
      writeTelegramExport(dir, telegramJson(value));
      for (const [relPath, text] of Object.entries(media)) {
        const path = join(dir, relPath);
        mkdirSync(join(path, '..'), { recursive: true });
        appendFileSync(path, text);
      }
      return dir;
    },
    async startImport(path, answer = {}) {
      return approveStaged(dashboard, path, answer);
    },
    async importAll(archiveId, options = {}) {
      for (let attempt = 0; attempt < 200; attempt += 1) {
        const outcome = await pullArchiveImport({ state: runtime.state, archiveId, targets, media: runtime.media, ...options });
        if (!outcome.continueSoon) return outcome;
      }
      throw new Error('the import did not finish');
    },
    rows() {
      const found: ReturnType<TelegramOneDatasetHarness['rows']> = [];
      for (const [domain, store] of [['internal', stores.internal], ['secure_local', stores.secureLocal]] as const) {
        if (!existsSync(store.dbPath)) continue;
        const db = new Database(store.dbPath, { readonly: true });
        try {
          const rows = db.query(`
            SELECT i.provider_conversation_id AS conversation, i.provider_item_id AS id, i.source_version AS version,
              i.parent_local_item_id AS parent, i.deferred_locator AS locator, i.bytes_available AS available,
              (SELECT COUNT(*) FROM chunks c WHERE c.item_pk = i.item_pk) AS chunks
            FROM items i WHERE i.tombstoned = 0 ORDER BY i.item_pk
          `).all() as Array<{ conversation: string; id: string; version: string | null; parent: string | null; locator: string | null; available: number | null; chunks: number }>;
          for (const row of rows) found.push({ domain, ...row });
        } finally {
          db.close();
        }
      }
      return found;
    },
    textOf(conversation, id) {
      const localItemId = `${ACCOUNT}:${conversation}:${id}`;
      return [stores.internal, stores.secureLocal].flatMap((store) => store.localContent(localItemId)?.chunks ?? []).join(' ');
    },
    close,
  };
  return h;
}
