/**
 * Telegram's live seed for the archive leg's import beside a live input (archive-live-seeds.ts): the account as pairing leaves it (the
 * registry entry naming the paired account, hashed as pairing hashes it) and a synthetic live input written the way the Telethon helper
 * writes its spool, then read by Telegram's own pull. Nothing writes the stores but that pull.
 */
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { TELEGRAM_SOURCE_ID } from '../../src/core/olympus-layout.ts';
import { resolvedStorePath } from '../../src/core/source-placement.ts';
import { placeOwnedAccount, recordProviderAccount } from '../../src/core/source-storage.ts';
import {
  TELEGRAM_PERSONAL_ACCOUNT_SCOPE,
  createTelegramConnectorStores,
  createTelegramConnectorStoreSyncHandler,
  defaultTelegramCaptureSpoolDir,
} from '../../src/workers/telegram-messages/index.ts';
import { telegramProviderAccountId } from '../../src/workers/telegram-messages/archive-target.ts';
import { liveSpoolLine } from '../../test/support/telegram-spool-fixtures.ts';
import { TELEGRAM_BESIDE_LIVE, TELEGRAM_SEEDED_USER_ID } from './archive-fixtures.ts';
import { registerLiveSeedHook, seedSpoolRecords } from './archive-live-seeds.ts';

registerLiveSeedHook('telegram', {
  provider: 'telegram',
  stores: ({ env }) => [
    { tier: 'private', path: resolvedStorePath(TELEGRAM_SOURCE_ID, 'secure_local', env) },
    { tier: 'personal', path: resolvedStorePath(TELEGRAM_SOURCE_ID, 'internal', env) },
  ],
  async seed({ env }) {
    const account = { sourceId: TELEGRAM_SOURCE_ID };
    placeOwnedAccount(account, env);
    const recorded = recordProviderAccount(account, telegramProviderAccountId(String(TELEGRAM_SEEDED_USER_ID)), env);
    if (recorded !== 'recorded' && recorded !== 'same') {
      return { ok: false, detail: `the Telegram account could not be recorded (${recorded})`, liveItems: 0 };
    }
    const spoolDir = defaultTelegramCaptureSpoolDir(env);
    mkdirSync(spoolDir, { recursive: true, mode: 0o700 });
    const chat = `-${TELEGRAM_BESIDE_LIVE.chatId}`;
    const records = TELEGRAM_BESIDE_LIVE.shared.map((message) => {
      const id = String(1000 + message.index);
      const line = liveSpoolLine({
        chat,
        id,
        text: message.text,
        sentAt: `${message.day}T12:00:00Z`,
        chatTitle: TELEGRAM_BESIDE_LIVE.chatName,
        sender: { id: String(TELEGRAM_SEEDED_USER_ID), name: 'Sam Example' },
      });
      return { id, line };
    });
    const stores = createTelegramConnectorStores(env);
    try {
      return await seedSpoolRecords({
        path: join(spoolDir, '2024-04-02.jsonl'),
        records,
        provider: 'telegram',
        accountScope: TELEGRAM_PERSONAL_ACCOUNT_SCOPE,
        providerConversationId: chat,
        stores: () => [stores.internal, stores.secureLocal],
        pull: () => createTelegramConnectorStoreSyncHandler({ stores, spoolDir, env }).pull(),
      });
    } finally {
      stores.internal.close();
      stores.secureLocal.close();
    }
  },
});
