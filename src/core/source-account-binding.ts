import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { writePrivateFileAtomicSync } from './atomic-file.ts';
import { withFileLeaseSync } from './file-lease.ts';
import type { AccountBoundProvider } from './provider-account-identity.ts';

/**
 * One source, one provider account: which account a file source's stored items
 * came from, and whether a reconnect has put that in doubt.
 *
 * A source's stores are filled by whichever account its credential belonged to
 * at the time. When a reconnect hands the source a different account, the items
 * already stored belong to an account the install no longer holds a credential
 * for, and syncing on top of them mixes two people's files in one source (the
 * 2026-10-10 reviewer-demo incident). This file is the durable record that
 * keeps that from happening:
 *
 * - `provider_account_id` is the account the source's stores were filled from.
 *   The worker binds it on the first sync it verifies.
 * - `reconnected_at` is written by every connect that could not prove it is
 *   the same account (no earlier binding, or the provider did not say). The
 *   worker settles it against the token's own account before syncing.
 * - `purge_required` is written when the accounts are known to differ. Nothing
 *   syncs while it stands. Olympus never removes the previous account's items
 *   by itself: the index can hold mail and files the provider no longer has,
 *   and whole-source deletion is the deliberate CLI-only flow
 *   (`olympus data delete --source`, docs/V0_4_RELEASE.md). Once the owner has
 *   removed them the new account is bound; reconnecting the previous account
 *   instead lifts the marker and sync resumes where it was.
 *
 * It sits beside the connected-handle registry so the CLI and the dashboard
 * connect paths, and the worker, all read and write the same file.
 */
export type AccountBoundSourceId = 'dropbox.files' | 'google_drive.docs' | 'gmail.email';

export const ACCOUNT_BOUND_SOURCE_IDS: readonly AccountBoundSourceId[] = ['dropbox.files', 'google_drive.docs', 'gmail.email'];

export type SourceAccountPurgeReason = 'account_changed' | 'previous_account_unknown';

export interface SourceAccountBinding {
  provider_account_id?: string;
  bound_at?: string;
  reconnected_at?: string;
  purge_required?: {
    reason: SourceAccountPurgeReason;
    detected_at: string;
  };
  /**
   * For a grant whose account cannot be read (Dropbox grants made before
   * `account_info.read`): ids of folders only that account can open,
   * recorded while it was connected. A reconnect that opens all of them is
   * the same account.
   */
  previous_account_folders?: string[];
}

export interface SourceAccountBindings {
  version: 1;
  sources: Partial<Record<AccountBoundSourceId, SourceAccountBinding>>;
}

export type SourceAccountBindingsRead =
  | { kind: 'ok'; bindings: SourceAccountBindings }
  | { kind: 'malformed' };

export class SourceAccountBindingsUnreadableError extends Error {
  constructor(path: string) {
    super(`The source account record at ${path} is unreadable; no file source syncs until it is repaired or removed.`);
    this.name = 'SourceAccountBindingsUnreadableError';
  }
}

export function sourceAccountBindingsPath(registryPath: string): string {
  return join(dirname(registryPath), 'source-account-bindings.json');
}

export function accountBoundSourceIdForProvider(provider: string): AccountBoundSourceId | undefined {
  if (provider === 'dropbox') return 'dropbox.files';
  if (provider === 'google_drive') return 'google_drive.docs';
  if (provider === 'gmail') return 'gmail.email';
  return undefined;
}

export function readSourceAccountBindings(path: string): SourceAccountBindingsRead {
  if (!existsSync(path)) return { kind: 'ok', bindings: { version: 1, sources: {} } };
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown;
    return normalizeBindings(parsed);
  } catch {
    return { kind: 'malformed' };
  }
}

/** Read-modify-write one source's entry under the file's cross-process lease. */
export function updateSourceAccountBinding(
  path: string,
  sourceId: AccountBoundSourceId,
  mutate: (current: SourceAccountBinding | undefined) => SourceAccountBinding | undefined,
): SourceAccountBinding | undefined {
  return withFileLeaseSync(path, (lease) => {
    const read = readSourceAccountBindings(path);
    if (read.kind === 'malformed') throw new SourceAccountBindingsUnreadableError(path);
    const next = mutate(read.bindings.sources[sourceId]);
    const sources = { ...read.bindings.sources };
    if (next) sources[sourceId] = prune(next);
    else delete sources[sourceId];
    lease.commit(() => writePrivateFileAtomicSync(path, `${JSON.stringify({ version: 1, sources }, null, 2)}\n`));
    return next;
  });
}

export type FileSourceConnectOutcome = 'same_account' | 'reconnected' | 'purge_required';

/**
 * First half of a connect, before it replaces a file source's grant: leave
 * the marker the worker re-verifies against if the connect stops anywhere
 * after this point (Codex round 2 on this change). Written after the grant
 * instead, a crash between the two left the new account connected over the
 * old account's items with nothing to say so.
 *
 * The marker alone never purges a bound source whose token still names its
 * account, so a connect that fails to store its grant costs one identity
 * check. A never-bound, never-reconnected source (an install from before
 * bindings existed) first adopts the account of the grant being replaced,
 * when connect could identify it: its items came from that grant, and
 * without it a same-account reconnect could not be told from a change.
 */
export function recordFileSourceConnectIntent(input: {
  registryPath: string;
  provider: AccountBoundProvider;
  previousAccountId: string | undefined;
  now: Date;
}): void {
  const sourceId = accountBoundSourceIdForProvider(input.provider)!;
  updateSourceAccountBinding(sourceAccountBindingsPath(input.registryPath), sourceId, (current) => {
    if (current?.purge_required) return current;
    const at = input.now.toISOString();
    const adopt = !current?.provider_account_id && !current?.reconnected_at ? input.previousAccountId : undefined;
    return {
      ...current,
      ...(adopt ? { provider_account_id: adopt, bound_at: at } : {}),
      reconnected_at: at,
    };
  });
}

/**
 * Second half of a connect, once the new grant is fully stored: what it means
 * for the source's stored items.
 */
export function recordFileSourceConnect(input: {
  registryPath: string;
  provider: AccountBoundProvider;
  providerAccountId: string | undefined;
  now: Date;
}): FileSourceConnectOutcome {
  const sourceId = accountBoundSourceIdForProvider(input.provider)!;
  let outcome: FileSourceConnectOutcome = 'reconnected';
  updateSourceAccountBinding(sourceAccountBindingsPath(input.registryPath), sourceId, (current) => {
    const at = input.now.toISOString();
    if (current?.purge_required) {
      // The previous account reconnected: its own items are what the source
      // holds, so the source resumes as it was.
      if (current.provider_account_id && current.provider_account_id === input.providerAccountId) {
        outcome = 'same_account';
        const { purge_required: _lifted, reconnected_at: _settled, ...rest } = current;
        return rest;
      }
      outcome = 'purge_required';
      return current;
    }
    if (current?.provider_account_id && input.providerAccountId) {
      if (current.provider_account_id === input.providerAccountId) {
        outcome = 'same_account';
        const { reconnected_at: _settled, ...rest } = current;
        return rest;
      }
      outcome = 'purge_required';
      return { ...current, purge_required: { reason: 'account_changed', detected_at: at } };
    }
    return { ...current, reconnected_at: at };
  });
  return outcome;
}

export type SourceAccountDecision =
  | { action: 'proceed'; write?: SourceAccountBinding | null }
  | { action: 'refuse'; reason: 'token_account_mismatch' | 'account_unverified' }
  | { action: 'purge'; reason: SourceAccountPurgeReason };

/**
 * The worker's decision before a file source touches its provider or stores.
 *
 * `grantAccountId` is the account the registry says the grant authorizes
 * (written at connect); `tokenAccountId` is what the provider says about the
 * access token this run would use, or undefined when it could not be asked.
 * `write` is the entry to store (null removes it; absent leaves it).
 */
export function decideSourceAccountAction(input: {
  binding: SourceAccountBinding | undefined;
  grantAccountId: string | undefined;
  tokenAccountId: string | undefined;
  laneHoldsItems: boolean;
  now: Date;
}): SourceAccountDecision {
  const { binding, grantAccountId, tokenAccountId: token } = input;
  // The incident's own shape: a token minted for one account serving a grant
  // that belongs to another. Never read with it.
  if (grantAccountId && token && grantAccountId !== token) {
    return { action: 'refuse', reason: 'token_account_mismatch' };
  }
  const bindTo = (id: string | undefined): SourceAccountDecision => ({
    action: 'proceed',
    write: id ? { provider_account_id: id, bound_at: input.now.toISOString() } : null,
  });

  if (binding?.purge_required) {
    // The previous account is back (reconnected, or the token in hand is its
    // own): its items are what the source holds, so the marker lifts.
    if (binding.provider_account_id && token === binding.provider_account_id) return bindTo(token);
    if (input.laneHoldsItems) return { action: 'purge', reason: binding.purge_required.reason };
    // Nothing of the previous account is left. Bind only an account the token
    // itself proved; otherwise leave the source unbound.
    return bindTo(token);
  }
  if (!binding?.provider_account_id && !binding?.reconnected_at) {
    // Never bound and never reconnected since this record existed: the stores
    // were filled by the grant that is still connected. Adopt the account the
    // token proves, or carry on unbound when the provider cannot say.
    return token ? bindTo(token) : { action: 'proceed' };
  }
  // Bound or reconnected: only the token's own account counts (Codex round 1
  // on 6475d315). The grant's recorded account says what the token SHOULD be,
  // not what it is; an environment token or a stale mint could be another.
  // Unverifiable this run: wait, never purge on a blip.
  if (!token) return { action: 'refuse', reason: 'account_unverified' };
  if (binding.provider_account_id === token) {
    return binding.reconnected_at ? bindTo(token) : { action: 'proceed' };
  }
  if (!input.laneHoldsItems) return bindTo(token);
  return {
    action: 'purge',
    reason: binding.provider_account_id ? 'account_changed' : 'previous_account_unknown',
  };
}

function normalizeBindings(value: unknown): SourceAccountBindingsRead {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { kind: 'malformed' };
  const record = value as Record<string, unknown>;
  if (record.version !== 1 || !record.sources || typeof record.sources !== 'object' || Array.isArray(record.sources)) {
    return { kind: 'malformed' };
  }
  const sources: SourceAccountBindings['sources'] = {};
  for (const [key, raw] of Object.entries(record.sources as Record<string, unknown>)) {
    if (!(ACCOUNT_BOUND_SOURCE_IDS as readonly string[]).includes(key)) continue;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { kind: 'malformed' };
    const entry = raw as Record<string, unknown>;
    const purge = entry.purge_required as Record<string, unknown> | undefined;
    if (purge !== undefined && (
      !purge || typeof purge !== 'object'
      || (purge.reason !== 'account_changed' && purge.reason !== 'previous_account_unknown')
      || typeof purge.detected_at !== 'string'
    )) return { kind: 'malformed' };
    const folders = Array.isArray(entry.previous_account_folders)
      ? entry.previous_account_folders.filter((id): id is string => typeof id === 'string' && /^id:[A-Za-z0-9_-]{1,200}$/.test(id)).slice(0, 5)
      : [];
    sources[key as AccountBoundSourceId] = prune({
      ...(typeof entry.provider_account_id === 'string' && entry.provider_account_id.trim()
        ? { provider_account_id: entry.provider_account_id.trim() }
        : {}),
      ...(typeof entry.bound_at === 'string' ? { bound_at: entry.bound_at } : {}),
      ...(typeof entry.reconnected_at === 'string' ? { reconnected_at: entry.reconnected_at } : {}),
      ...(folders.length > 0 ? { previous_account_folders: folders } : {}),
      ...(purge
        ? {
            purge_required: {
              reason: purge.reason as SourceAccountPurgeReason,
              detected_at: purge.detected_at as string,
            },
          }
        : {}),
    });
  }
  return { kind: 'ok', bindings: { version: 1, sources } };
}

function prune(entry: SourceAccountBinding): SourceAccountBinding {
  return Object.fromEntries(Object.entries(entry).filter(([, value]) => value !== undefined)) as SourceAccountBinding;
}
