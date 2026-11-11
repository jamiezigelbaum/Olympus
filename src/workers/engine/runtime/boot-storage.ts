import { LocalPeopleIndex, peopleIndexPath } from '../../../core/people-index.ts';
import { existsSync } from 'node:fs';
import {
  replaceEmptyLegacyAccounts,
} from '../../../core/source-storage.ts';
import { accountFolderMigrationEnabled, migrateAccountFolders, type AccountMigrationOptions, type AccountMigrationReport } from '../../../core/source-account-migration.ts';
import { messagingMoveFacts, repointMovedMessagingAccounts } from '../../../core/messaging-account-move.ts';
import { deleteMarkedAccounts, type DeleteMarkedAccountsReport } from '../../../data-lifecycle.ts';
import { TierLedgerSchemaError } from '../../classification/tier-ledger.ts';
import { assertStoreTierLedgerCanOpen } from '../../classification/tier-set-binding.ts';
import { createDefaultSecretStore, type SecretStore } from '../../../core/secret-store.ts';

/**
 * The least time between two scheduler status snapshots for the ingestion
 * ledger. A snapshot reads every store's counts; on a large library that is
 * seconds of the worker's thread, so at 30 s it was most of the thread's time
 * during an import (Sparta, 2026-11-03). The ledger is a record for doctor and
 * Castor, so two minutes stale is fine.
 */
export const SOURCE_STATUS_PUBLISH_MIN_INTERVAL_MS = 120_000;

const DROPBOX_SOURCE_ANSWER_SELF_HEAL_RETRY_AFTER_MS = 5_000;

const DROPBOX_SOURCE_ANSWER_SELF_HEAL_PRIORITY = 1_000_000;

/** How long one live Gmail attachment reader (and the messages it fetched) serves before a fresh one is made. */
export const GMAIL_ATTACHMENT_READER_REUSE_MS = 5 * 60_000;

/**
 * Per-item tier overrides of a chat lane written before identities carried
 * their conversation: re-homed at boot where the conversation is derivable,
 * otherwise kept (applying to nothing) and reported as orphaned. Counts only.
 */
export function reportRehomedChatOverrides(lane: string, result: { rehomed: number; orphaned: number }): void {
  if (result.rehomed === 0 && result.orphaned === 0) return;
  console.warn(
    `[tier] ${lane}: ${result.rehomed} per-item override(s) re-homed under their conversation; `
    + `${result.orphaned} orphaned (conversation not derivable; kept, applying to nothing, until reset).`,
  );
}

/** The analyst's own test for a candidate it matched but could not read. */




export const PEOPLE_INDEX_FIRST_REFRESH_MS = 60_000;

/** How often the worker checks whether a sync or a tier visibility change needs a rebuild. */
export const PEOPLE_INDEX_CHECK_MS = 60_000;

export function openPeopleIndexOrUndefined(options: { readOnly?: boolean } = {}): LocalPeopleIndex | undefined {
  const dbPath = peopleIndexPath(process.env);
  // The engine split's front reads the index the background rebuilds, once it exists.
  if (options.readOnly && !existsSync(dbPath)) return undefined;
  try {
    return new LocalPeopleIndex({ dbPath, ...(options.readOnly ? { readOnly: true } : {}) });
  } catch (error) {
    console.warn(`[olympus] people index unavailable: ${error instanceof Error ? error.message : String(error)}`);
    return undefined;
  }
}

/**
 * Under the owner lock, first, before anything mounts or any capture starts
 * (docs/design/source-storage.md, "Delete"): removes each account a Delete
 * marked `deleting` (data-lifecycle.ts, `deleteMarkedAccounts`). An account
 * that cannot be removed stays marked, and closed, until a later boot; the
 * other accounts and the worker start as always.
 */
export function deleteMarkedAccountsAtBoot(env: Record<string, string | undefined>): DeleteMarkedAccountsReport | undefined {
  try {
    const report = deleteMarkedAccounts({ env });
    for (const { sourceId, removed } of report.deleted) console.log(`[storage] ${sourceId}'s data was deleted (${removed} files and folders).`);
    for (const { sourceId, message } of report.failed) console.warn(`[storage] ${sourceId}'s data could not be deleted yet (${message}); it stays closed and the next start tries again.`);
    return report;
  } catch (error) {
    console.warn(`[storage] Could not check which accounts are being deleted (${error instanceof Error ? error.message : 'unknown error'}); every account stays closed until the registry is repaired.`);
    return undefined;
  }
}

/**
 * Under the owner lock and before anything mounts (core/source-storage.ts,
 * `replaceEmptyLegacyAccounts`). A failure here changes nothing and does not
 * stop the worker: the accounts stay where the registry has them.
 */
export function replaceEmptyAccountsAtBoot(env: Record<string, string | undefined>): string[] {
  try {
    const replaced = replaceEmptyLegacyAccounts(env);
    for (const sourceId of replaced) console.log(`[storage] ${sourceId} holds nothing yet; its files will live in its account folder.`);
    return replaced;
  } catch (error) {
    console.warn(`[storage] Could not check which empty accounts to place in folders (${error instanceof Error ? error.message : 'unknown error'}); they stay as recorded.`);
    return [];
  }
}

/** Schema refusal is a lane outage, not a process failure. Called before any tier store opens. */
export function workerTierLedgerProblem(storePaths: readonly string[], readOnly = false): string | undefined {
  try {
    // A bound store is checked against the ledger that governs it, never a
    // former per-leg ledger left beside it. An unbound or not-yet-created store
    // is checked against the ledger beside it (the set ledger may exist before
    // its secure store does).
    for (const path of storePaths) assertStoreTierLedgerCanOpen(path, readOnly);
    return undefined;
  } catch (error) {
    if (error instanceof TierLedgerSchemaError) return error.message;
    throw error;
  }
}

/**
 * Under the owner lock, after the empty accounts are placed and before
 * adoption is on and anything mounts (core/source-account-migration.ts): moves
 * each existing account's files into its folder unless
 * `OLYMPUS_MIGRATE_ACCOUNT_FOLDERS=0`, and finishes or undoes a move an earlier
 * boot left part way whatever the switch says. A registry that cannot be read
 * leaves every account where it is and the worker boots as it always did.
 */
export function migrateAccountFoldersAtBoot(env: Record<string, string | undefined>, options: AccountMigrationOptions = {}): AccountMigrationReport | undefined {
  if (!accountFolderMigrationEnabled(env)) {
    console.log(`[storage] Moving accounts into their folders is off (OLYMPUS_MIGRATE_ACCOUNT_FOLDERS=${env.OLYMPUS_MIGRATE_ACCOUNT_FOLDERS?.trim()}); a move already under way is still finished or undone.`);
  }
  try {
    const report = migrateAccountFolders(env, options);
    for (const sourceId of report.moved) console.log(`[storage] ${sourceId} moved into its account folder.`);
    for (const { sourceId, reason } of report.movedBack) console.warn(`[storage] ${sourceId} could not be moved (${reason}); its files were put back where they were.`);
    for (const { sourceId, reason } of report.skipped) console.log(`[storage] ${sourceId} stays where it is (${reason}).`);
    for (const { sourceId, detail } of report.stuck) console.warn(`[storage] ${sourceId} is part way through a move and stays closed until a restart finishes it: ${detail}`);
    for (const sourceId of report.deferred) console.log(`[storage] ${sourceId} will be moved at a later start; this one ran out of time.`);
    for (const { sourceId, message } of report.errors) console.warn(`[storage] ${sourceId} was not moved (${message}).`);
    return report;
  } catch (error) {
    console.warn(`[storage] Could not check which accounts to move into folders (${error instanceof Error ? error.message : 'unknown error'}); they stay as recorded.`);
    return undefined;
  }
}

/**
 * The boot's whole account-folder step for the messaging sources too
 * (core/messaging-account-move.ts): with the switch on, what each Telegram and
 * WhatsApp account's records outside the data folder say is gathered first, so
 * the pass can weigh them; after it, every record that still names the old
 * place of an account a move finished is rewritten (switch or no switch, like
 * a plan left part way). Before any capture child or service starts: the
 * worker's capture supervisors are made after this, and the Gateway-run
 * services wait for the worker's readiness.
 */
export async function moveAccountsAtBoot(env: Record<string, string | undefined>, secretStore: SecretStore = lazySecretStore(env)): Promise<AccountMigrationReport | undefined> {
  const messaging = accountFolderMigrationEnabled(env) ? await messagingMoveFacts(env, secretStore) : undefined;
  const report = migrateAccountFoldersAtBoot(env, messaging ? { messaging } : {});
  const repointed = await repointMovedMessagingAccounts(env, secretStore);
  for (const record of repointed.rewritten) console.log(`[storage] ${record} now names the account folder.`);
  for (const { sourceId, message } of repointed.errors) console.warn(`[storage] ${sourceId} still has a record that names its old place (${message}); the next start tries again.`);
  return report;
}

/** The secret store, made only if a boot step reads it (most boots do not). */
export function lazySecretStore(env: Record<string, string | undefined>): SecretStore {
  let store: SecretStore | undefined;
  const real = (): SecretStore => (store ??= createDefaultSecretStore({ env }));
  return {
    get label() { return real().label; },
    get: (key) => real().get(key),
    set: (key, value) => real().set(key, value),
    delete: (key) => real().delete(key),
    list: () => real().list(),
  };
}
