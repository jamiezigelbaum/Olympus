/**
 * WhatsApp's live seed hook for the archive leg's import beside a live input (archive-live-seeds.ts): the account a pairing would leave,
 * and a few synthetic messages in the bridge's spool, read into the account's stores by WhatsApp's own pull. The stores are never
 * written by hand. The messages are the two of `whatsappBesideLive` the export shares with live capture, at the instants their wall
 * times name in UTC, so the export's zone is found by matching (whatever zone the machine is set to).
 */
import { fixtureText } from './fixture-judge.ts';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { WHATSAPP_SOURCE_ID } from '../../src/core/olympus-layout.ts';
import { placeOwnedAccount } from '../../src/core/source-storage.ts';
import { resolvedStorePath } from '../../src/core/source-placement.ts';
import {
  WHATSAPP_PERSONAL_ACCOUNT_SCOPE,
  createWhatsAppConnectorStore,
  createWhatsAppConnectorStoreSyncHandler,
  createWhatsAppTierLane,
  defaultWhatsAppSpoolDir,
} from '../../src/workers/whatsapp/store-sync.ts';
import { registerLiveSeedHook, seedSpoolRecords } from './archive-live-seeds.ts';

export const WHATSAPP_SEED_HOOK = 'whatsapp';
/** The direct chat the export and the live spool share, and its people. Made up. */
export const WHATSAPP_BESIDE_CHAT = 'Sam Example';
export const WHATSAPP_BESIDE_OWNER = 'Jo Owner';
const CHAT_JID = '15550100001@s.whatsapp.net';

/** The messages live capture holds: [wall time, sender (undefined: the owner), text]. */
export const WHATSAPP_BESIDE_SHARED: ReadonlyArray<readonly [string, string | undefined, string]> = [
  ['2024-04-14T12:00:00', WHATSAPP_BESIDE_CHAT, fixtureText('Ferry tickets are booked for the morning.')],
  ['2024-04-14T12:05:00', undefined, fixtureText('Great, I will bring the map.')],
];

function spoolLine(id: string, [at, sender, text]: readonly [string, string | undefined, string]): string {
  return `${JSON.stringify({
    id,
    chat_jid: CHAT_JID,
    chat_name: WHATSAPP_BESIDE_CHAT,
    sender_jid: sender === undefined ? '' : CHAT_JID,
    sender_name: sender === undefined ? '' : 'sam',
    ...(sender === undefined ? {} : { sender_contact_name: sender }),
    from_me: sender === undefined,
    timestamp: `${at}Z`,
    text,
  })}\n`;
}

registerLiveSeedHook(WHATSAPP_SEED_HOOK, {
  provider: 'whatsapp',
  stores: ({ env }) => [
    { tier: 'private', path: resolvedStorePath(WHATSAPP_SOURCE_ID, 'secure_local', env) },
    { tier: 'personal', path: resolvedStorePath(WHATSAPP_SOURCE_ID, 'internal', env) },
  ],
  async seed({ env }) {
    // What pairing leaves: the account, and the bridge's spool in its folder.
    placeOwnedAccount({ sourceId: WHATSAPP_SOURCE_ID }, env);
    const spoolDir = defaultWhatsAppSpoolDir(env);
    mkdirSync(spoolDir, { recursive: true, mode: 0o700 });
    const records = WHATSAPP_BESIDE_SHARED.map((message, index) => {
      const id = `RCSEED${index}`;
      return { id, line: spoolLine(id, message) };
    });
    // WhatsApp's own pull reads the spool into the account's stores.
    const store = createWhatsAppConnectorStore(env);
    const lane = createWhatsAppTierLane({ store, env });
    try {
      return await seedSpoolRecords({
        path: join(spoolDir, '2024-04-14.jsonl'),
        records,
        provider: 'whatsapp',
        accountScope: WHATSAPP_PERSONAL_ACCOUNT_SCOPE,
        providerConversationId: CHAT_JID,
        stores: () => [store, lane.set.store('internal')],
        pull: () => createWhatsAppConnectorStoreSyncHandler({ store, spoolDir, env, tierSet: lane.set }).pull(),
      });
    } finally {
      lane.newStores.internal?.current()?.close();
      store.close();
    }
  },
});
