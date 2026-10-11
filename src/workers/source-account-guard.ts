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
  readonly code: 'source_account_changed' | 'source_account_token_mismatch' | 'source_account_unverified';

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
   * Ask the supervised worker to restart, so its start-up purge removes the
   * previous account's stored data before any store is open. False when this
   * worker cannot restart itself.
   */
  requestPurgeRestart: () => boolean;
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
      const what = `${options.sourceId} was reconnected to ${decision.reason === 'account_changed' ? 'a different account' : 'an account that could not be matched to the previous one'}. `
        + 'Nothing syncs until the previous account\'s stored items are removed; ';
      const current = readSourceAccountBindings(bindingsPath);
      if (current.kind === 'ok' && current.bindings.sources[options.sourceId]?.purge_required?.failed_at) {
        // The start-up removal already failed once: another restart would fail
        // the same way and take every other source down with it.
        throw new SourceAccountChangedError(
          'source_account_changed',
          `${what}removing them at start-up failed. Disconnect the source, run \`olympus data delete --source ${options.sourceId}\`, then connect again.`,
        );
      }
      const restarting = options.requestPurgeRestart();
      throw new SourceAccountChangedError(
        'source_account_changed',
        what + (restarting
          ? 'the worker is restarting to remove them.'
          : 'restart the Olympus worker to remove them.'),
      );
    },
  };
}

/** Put the account check in front of every task of a file-source lane. */
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
