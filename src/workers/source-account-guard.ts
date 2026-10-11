import { createHash } from 'node:crypto';
import type { TimeoutFetch } from '../core/http-timeout.ts';
import {
  fetchProviderAccountId,
  type AccountBoundProvider,
  type ProviderIdentityEndpoints,
} from '../core/provider-account-identity.ts';
import {
  decideSourceAccountAction,
  readSourceAccountBindings,
  sourceAccountBindingsPath,
  SourceAccountBindingsUnreadableError,
  updateSourceAccountBinding,
  type AccountBoundSourceId,
  type SourceAccountDecision,
} from '../core/source-account-binding.ts';
import { readConnectedHandleRegistry } from './credential-broker/connected-handles.ts';
import {
  createEnvCredentialBroker,
  invalidateMintedCredentialSessions,
  type CredentialBroker,
} from './credential-broker/index.ts';
import type { SourceSchedulerSource } from './source-scheduler.ts';

/**
 * The check every Dropbox, Google Drive and Gmail scheduler task passes before
 * it touches the provider or the source's stores: the token it would read with
 * belongs to the account the grant authorizes, and that account is the one the
 * source's stored items came from. See source-account-binding.ts for the
 * record it keeps and the 2026-10-10 incident it closes.
 */
export class SourceAccountChangedError extends Error {
  readonly code: 'source_account_changed' | 'source_account_token_mismatch' | 'source_account_unverified' | 'source_stores_reopen_required';

  constructor(code: SourceAccountChangedError['code'], message: string) {
    super(message);
    this.name = 'SourceAccountChangedError';
    this.code = code;
  }
}

export interface SourceAccountGuardOptions {
  sourceId: AccountBoundSourceId;
  provider: AccountBoundProvider;
  /** The registry handle name, re-read on every check so a reconnect is seen at once. */
  handle: string;
  capability: string;
  registryPath: string;
  /** Whether any of the source's stores (every tier) holds an item row. */
  laneHoldsItems: () => boolean;
  /**
   * Whether a store this process holds open was deleted or replaced on disk
   * (a `data delete --source` while the worker stayed up). Its open handle
   * would still report the deleted rows and swallow new writes.
   */
  laneStoresStale?: () => boolean;
  /** Ask a supervised worker to restart and reopen its stores; false when it cannot. */
  requestStoreReopen?: () => boolean;
  /**
   * Evidence of the account for grants whose account cannot be read (Dropbox
   * grants made before `account_info.read`; PR review). `record` names
   * folders only the token's account can open, kept while that grant syncs;
   * `check` says whether a later token owns one of them (the same account).
   * Arbitrary stored items are no evidence: a shared item opens for every
   * account it is shared with (independent review round 13).
   */
  ownAccountEvidence?: {
    record: (accessToken: string) => Promise<string[] | undefined>;
    check: (accessToken: string, folderIds: readonly string[]) => Promise<boolean | undefined>;
  };
  broker?: CredentialBroker;
  fetch?: TimeoutFetch;
  identityEndpoints?: ProviderIdentityEndpoints;
  identityTimeoutMs?: number;
  now?: () => Date;
}

export interface SourceAccountGuard {
  assertAccount(): Promise<void>;
}

export function createSourceAccountGuard(options: SourceAccountGuardOptions): SourceAccountGuard {
  const broker = options.broker ?? createEnvCredentialBroker();
  const now = options.now ?? (() => new Date());
  const bindingsPath = sourceAccountBindingsPath(options.registryPath);
  // One provider lookup per access token, not per task run.
  const verified = new Map<string, string>();
  // The token the last lookup was about, for the reach check below.
  let lastAccessToken: string | undefined;
  // One evidence check per access token and folder set.
  const evidenceChecked = new Map<string, boolean>();
  const evidenceOpens = async (accessToken: string, folderIds: readonly string[]): Promise<boolean | undefined> => {
    const key = createHash('sha256').update(`${accessToken}\n${folderIds.join(',')}`).digest('hex');
    const known = evidenceChecked.get(key);
    if (known !== undefined) return known;
    const answer = await options.ownAccountEvidence?.check(accessToken, folderIds).catch(() => undefined);
    if (answer !== undefined) {
      if (evidenceChecked.size >= 8) evidenceChecked.clear();
      evidenceChecked.set(key, answer);
    }
    return answer;
  };
  let evidenceRecordAttempted = false;

  const tokenAccountId = async (): Promise<string | undefined> => {
    const handle = readConnectedHandleRegistry(options.registryPath).handles
      .find((entry) => entry.handle === options.handle);
    const session = await broker.issueSession({
      handle: options.handle,
      provider: options.provider,
      capability: options.capability,
      ...(handle?.trustDomain ? { trustDomain: handle.trustDomain } : {}),
      purpose: 'Confirm which provider account the source credential belongs to before syncing.',
    });
    if (session.kind !== 'bearer_token') return undefined;
    lastAccessToken = session.token;
    const key = createHash('sha256').update(session.token).digest('hex');
    const known = verified.get(key);
    if (known) return known;
    try {
      const id = await fetchProviderAccountId({
        provider: options.provider,
        accessToken: session.token,
        ...(options.fetch ? { fetchImpl: options.fetch } : {}),
        ...(options.identityEndpoints ? { endpoints: options.identityEndpoints } : {}),
        ...(options.identityTimeoutMs ? { timeoutMs: options.identityTimeoutMs } : {}),
      });
      if (verified.size >= 8) verified.clear();
      verified.set(key, id);
      return id;
    } catch {
      return undefined;
    }
  };

  return {
    async assertAccount(): Promise<void> {
      const handle = readConnectedHandleRegistry(options.registryPath).handles
        .find((entry) => entry.handle === options.handle);
      if (!handle) {
        throw new SourceAccountChangedError('source_account_unverified', `${options.sourceId} is not connected.`);
      }
      if (options.laneStoresStale?.()) {
        // Before anything else: the open stores no longer are the source's
        // stores, so neither the account decision nor the task can use them.
        const restarting = options.requestStoreReopen?.() ?? false;
        throw new SourceAccountChangedError(
          'source_stores_reopen_required',
          restarting
            ? `${options.sourceId}'s stored data was deleted while the worker was running; the worker is restarting to reopen it.`
            : `${options.sourceId}'s stored data was deleted while the worker was running. Restart the Olympus worker so it reopens the source's stores before syncing.`,
        );
      }
      const token = await tokenAccountId();
      const decide = (binding: Parameters<typeof decideSourceAccountAction>[0]['binding']): SourceAccountDecision =>
        decideSourceAccountAction({
          binding,
          grantAccountId: handle.providerAccountId,
          tokenAccountId: token,
          laneHoldsItems: options.laneHoldsItems(),
          now: now(),
        });

      const read = readSourceAccountBindings(bindingsPath);
      if (read.kind === 'malformed') throw new SourceAccountBindingsUnreadableError(bindingsPath);
      let decision = decide(read.bindings.sources[options.sourceId]);
      const current = read.bindings.sources[options.sourceId];
      if (decision.action === 'purge' && decision.reason === 'previous_account_unknown' && token
        && lastAccessToken && current?.previous_account_folders?.length
        && await evidenceOpens(lastAccessToken, current.previous_account_folders) === true) {
        // The new token opens a folder only the previous account could: it is
        // that account. Bound only if neither the grant nor the record moved
        // while the provider was asked; a connect landing meanwhile (its
        // marker may leave a standing purge untouched) means this token may no
        // longer be the grant's, so this run waits (independent review round 14).
        let bound = false;
        updateSourceAccountBinding(bindingsPath, options.sourceId, (latest) => {
          const grantNow = readConnectedHandleRegistry(options.registryPath).handles
            .find((entry) => entry.handle === options.handle);
          if (JSON.stringify(latest ?? null) !== JSON.stringify(current ?? null)
            || grantNow?.connectedAt !== handle.connectedAt
            || grantNow?.providerAccountId !== handle.providerAccountId) return latest;
          bound = true;
          return { provider_account_id: token, bound_at: now().toISOString() };
        });
        if (bound) return;
        throw new SourceAccountChangedError(
          'source_account_unverified',
          `${options.sourceId} was reconnected while its account was being confirmed; it is checked again on the next run.`,
        );
      }
      if (decision.action === 'proceed' && decision.write === undefined && !token && lastAccessToken
        && options.ownAccountEvidence && !evidenceRecordAttempted
        && !current?.provider_account_id && !current?.reconnected_at && !current?.previous_account_folders?.length) {
        // An unreadable account syncing unbound: keep the evidence a later
        // reconnect is checked against, while this grant is the one in force.
        const folders = await options.ownAccountEvidence.record(lastAccessToken).catch(() => undefined);
        // Asked once per process; a provider that could not say is asked again.
        if (folders !== undefined) evidenceRecordAttempted = true;
        if (folders?.length) {
          updateSourceAccountBinding(bindingsPath, options.sourceId, (latest) =>
            latest?.provider_account_id || latest?.reconnected_at || latest?.purge_required
              ? latest
              : { ...latest, previous_account_folders: folders.slice(0, 5) });
        }
      }
      if (decision.action === 'proceed' && decision.write === undefined) return;
      if (decision.action !== 'refuse') {
        // Decide again under the record's lease: a connect may have landed
        // between the read above and now.
        updateSourceAccountBinding(bindingsPath, options.sourceId, (current) => {
          decision = decide(current);
          if (decision.action === 'proceed') {
            return decision.write === undefined ? current : decision.write ?? undefined;
          }
          if (decision.action === 'purge') {
            return current?.purge_required
              ? current
              : { ...current, purge_required: { reason: decision.reason, detected_at: now().toISOString() } };
          }
          return current;
        });
      }
      if (decision.action === 'proceed') return;
      if (decision.action === 'refuse' && decision.reason === 'token_account_mismatch') {
        invalidateMintedCredentialSessions(options.handle);
        verified.clear();
        throw new SourceAccountChangedError(
          'source_account_token_mismatch',
          `${options.sourceId}: the access token in use belongs to a different account than the connected credential; it was discarded and nothing was synced. If a Connect for this source just failed, connect it again.`,
        );
      }
      if (decision.action === 'refuse') {
        throw new SourceAccountChangedError(
          'source_account_unverified',
          `${options.sourceId}: could not confirm which account the credential belongs to; nothing was synced this run.`,
        );
      }
      // Fail closed and say exactly what clears it. Olympus does not delete
      // the previous account's items by itself: the index can hold mail and
      // files the provider no longer has, and whole-source deletion is the
      // deliberate CLI-only flow (docs/V0_4_RELEASE.md).
      throw new SourceAccountChangedError(
        'source_account_changed',
        `${options.sourceId} is now connected to ${decision.reason === 'account_changed' ? 'a different account' : 'an account that could not be matched to the one its items came from'}, `
          + 'so nothing syncs: one source never holds two accounts. To keep the items already stored, reconnect the previous account. '
          + `To replace them, Disconnect the source, run \`olympus data delete --source ${options.sourceId}\` (preview with --dry-run), then connect again.`,
      );
    },
  };
}

/** Put the account check in front of every task of a file-source lane. */
/**
 * Guard each account-bound lane once all of its own tasks are attached. A
 * task appended after the guard (an embedding sweep writes the same stores)
 * would otherwise run on a changed account or on deleted stores
 * (independent review round 10).
 */
export function guardAccountBoundLanes(
  sources: readonly SourceSchedulerSource[],
  guards: ReadonlyMap<string, SourceAccountGuard>,
): SourceSchedulerSource[] {
  return sources.map((source) => {
    const guard = guards.get(source.sourceId);
    return guard ? accountBoundSchedulerSource({ source, guard }) : source;
  });
}

export function accountBoundSchedulerSource(input: {
  source: SourceSchedulerSource;
  guard: SourceAccountGuard;
}): SourceSchedulerSource {
  return {
    ...input.source,
    tasks: input.source.tasks.map((task) => ({
      ...task,
      async run(context) {
        await input.guard.assertAccount();
        return task.run(context);
      },
    })),
  };
}
