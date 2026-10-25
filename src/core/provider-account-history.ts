// The provider account a source's history belongs to, as its registry entry
// names it (docs/design/source-storage.md, "One account, live and imported"),
// read and followed by connect and pairing. Kept apart from the storage
// service (core/source-storage.ts), which opens stores: connect needs only the
// registry.

import { compareProviderAccounts } from './provider-account-identity.ts';
import { TELEGRAM_SOURCE_ID, type LayoutEnv } from './olympus-layout.ts';
import {
  DEFAULT_ACCOUNT_SLOT,
  findRegistryAccount,
  readSourceRegistry,
  sourceAccountMovePending,
  SourceRegistryError,
  updateSourceRegistry,
  type SourceRegistry,
} from './source-registry.ts';

/** An account of a source: `slot` is `1` by default. */
export interface HistoryAccount {
  sourceId: string;
  slot?: string;
}

/**
 * The provider account an account's history belongs to, as its registry entry
 * names it; undefined when it has no entry, names none, or is not `active`.
 */
export function recordedProviderAccount(account: HistoryAccount, env: LayoutEnv = process.env): string | undefined {
  const entry = findRegistryAccount(readSourceRegistry(env), account.sourceId, account.slot ?? DEFAULT_ACCOUNT_SLOT);
  return entry?.state === 'active' ? entry.provider_account_hash : undefined;
}

/**
 * A connect that followed an address-only binding to what the replaced
 * grant's own token names now (followFileSourceRename) follows the history the
 * same way: an entry that names `from`'s account, by that address alone, takes
 * `to`. Otherwise the binding names the renamed account while the entry still
 * names the old address, and every sync is refused (PR #530 review). An entry
 * that knows an immutable label is left as it is: the next sync decides it by
 * that label. No entry, or one being deleted or moved, changes nothing.
 */
export function followProviderAccountRename(
  account: HistoryAccount,
  from: string,
  to: string,
  env: LayoutEnv = process.env,
): boolean {
  const slot = account.slot ?? DEFAULT_ACCOUNT_SLOT;
  const follows = (registry: SourceRegistry): boolean => {
    const entry = findRegistryAccount(registry, account.sourceId, slot);
    return entry?.state === 'active' && !sourceAccountMovePending(entry)
      && entry.provider_account_hash !== undefined
      && compareProviderAccounts(entry.provider_account_hash, from) === 'same'
      && entry.provider_account_hash !== to;
  };
  if (!follows(readSourceRegistry(env))) return false;
  let followed = false;
  updateSourceRegistry(env, (registry) => {
    if (!follows(registry)) return;
    findRegistryAccount(registry, account.sourceId, slot)!.provider_account_hash = to;
    followed = true;
  });
  return followed;
}

/**
 * The Telegram account the account's history names (docs/design/source-storage.md,
 * "One account, live and imported"), or undefined when it names none. An
 * unreadable registry fails the call; a data folder that cannot be worked out
 * names none, as placement records nothing there.
 */
export function telegramHistoryAccount(env: LayoutEnv): string | undefined {
  try {
    return recordedProviderAccount({ sourceId: TELEGRAM_SOURCE_ID }, env);
  } catch (error) {
    if (error instanceof SourceRegistryError) throw error;
    return undefined;
  }
}

/**
 * Refuses a Telegram session over a history that names another account, or a
 * session whose account nothing proved (one given by its path), when the
 * history names one. Every registration of a Telegram session passes it: the
 * pairing with the account it proved, `connect --session-path` with none.
 */
export function assertTelegramHistoryAccount(provedAccount: string | undefined, env: LayoutEnv): void {
  const recorded = telegramHistoryAccount(env);
  if (recorded === undefined) return;
  if (provedAccount !== undefined && compareProviderAccounts(recorded, provedAccount) === 'same') return;
  throw telegramHistoryAccountError(provedAccount === undefined ? 'unproved' : 'different');
}

export function telegramHistoryAccountError(kind: 'different' | 'unproved'): Error {
  const delete_ = 'Unpair Telegram, run `olympus data delete --source telegram.messages` (preview with --dry-run), then connect again.';
  return new Error(kind === 'different'
    ? 'This Telegram account is not the one whose messages Olympus already holds, so it was not connected: one source never holds two accounts. '
      + `To keep that history, pair the Telegram account it came from. To connect this one instead, delete that history first: ${delete_}`
    : 'The Telegram messages Olympus holds belong to a paired Telegram account, and a session given by its path cannot show which account it is, so it was not connected. '
      + `Pair with \`olympus connect telegram --pair\` so Olympus can check the account, or delete that history first: ${delete_}`);
}
