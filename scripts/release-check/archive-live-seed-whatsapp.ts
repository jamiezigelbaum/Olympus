/**
 * WhatsApp's live seed hook for the archive leg's import beside a live input (archive-live-seeds.ts): the account a pairing would leave,
 * and a few synthetic messages in the bridge's spool, read into the account's stores by WhatsApp's own pull. The stores are never
 * written by hand. The messages are the two of `whatsappBesideLive` the export shares with live capture, at the instants their wall
 * times name in UTC, so the export's zone is found by matching (whatever zone the machine is set to).
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { WHATSAPP_SOURCE_ID } from '../../src/core/olympus-layout.ts';
import { placeOwnedAccount } from '../../src/core/source-storage.ts';
import {
  createWhatsAppConnectorStore,
  createWhatsAppConnectorStoreSyncHandler,
  createWhatsAppTierLane,
  defaultWhatsAppConnectorStoreDbPath,
  defaultWhatsAppInternalConnectorStoreDbPath,
  defaultWhatsAppSpoolDir,
} from '../../src/workers/whatsapp/store-sync.ts';
import { registerLiveSeedHook } from './archive-live-seeds.ts';

export const WHATSAPP_SEED_HOOK = 'whatsapp';
/** The direct chat the export and the live spool share, and its people. Made up. */
export const WHATSAPP_BESIDE_CHAT = 'Sam Example';
export const WHATSAPP_BESIDE_OWNER = 'Jo Owner';
const CHAT_JID = '15550100001@s.whatsapp.net';

/** The messages live capture holds: [wall time, sender (undefined: the owner), text]. */
export const WHATSAPP_BESIDE_SHARED: ReadonlyArray<readonly [string, string | undefined, string]> = [
  ['2024-04-14T12:00:00', WHATSAPP_BESIDE_CHAT, 'Ferry tickets are booked for the morning.'],
  ['2024-04-14T12:05:00', undefined, 'Great, I will bring the map.'],
];

function spoolLine(index: number, [at, sender, text]: readonly [string, string | undefined, string]): string {
  return `${JSON.stringify({
    id: `RCSEED${index}`,
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
    { tier: 'private', path: defaultWhatsAppConnectorStoreDbPath(env) },
    { tier: 'personal', path: defaultWhatsAppInternalConnectorStoreDbPath(env) },
  ],
  async seed({ env }) {
    // What pairing leaves: the account, and the bridge's spool in its folder.
    placeOwnedAccount({ sourceId: WHATSAPP_SOURCE_ID }, env);
    const spoolDir = defaultWhatsAppSpoolDir(env);
    mkdirSync(spoolDir, { recursive: true, mode: 0o700 });
    writeFileSync(join(spoolDir, '2024-04-14.jsonl'), WHATSAPP_BESIDE_SHARED.map((message, index) => spoolLine(index, message)).join(''), { mode: 0o600 });
    // WhatsApp's own pull reads the spool into the account's stores.
    const store = createWhatsAppConnectorStore(env);
    const lane = createWhatsAppTierLane({ store, env });
    try {
      const receipt = await createWhatsAppConnectorStoreSyncHandler({ store, spoolDir, env, tierSet: lane.set }).pull();
      const liveItems = receipt.counts.items_seen;
      return { ok: liveItems === WHATSAPP_BESIDE_SHARED.length, detail: `${liveItems} live message(s) pulled`, liveItems };
    } finally {
      lane.newStores.internal?.current()?.close();
      store.close();
    }
  },
});
