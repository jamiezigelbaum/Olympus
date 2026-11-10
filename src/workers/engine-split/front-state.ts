/**
 * State the engine split's front shows from the background's status snapshot
 * (docs/design/engine-split.md, part 3, "State the front reads"): the judge's
 * backlog and pending count, unreadable-file counts and the archive
 * dashboard. The background is the process that classifies, recounts
 * unreadable files and runs the imports, so the front reads what it last
 * published instead of doing that work itself. Before the first snapshot
 * the front answers as a background with nothing to report would.
 */
import type { ArchiveImportDashboard, ArchivePrivateModelState } from '../archive-import/dashboard.ts';
import type { TierClassificationBacklog } from '../classification/sniffer-service.ts';
import type { UnreadableFiles } from '../file-extraction/unreadable-files.ts';
import type { EngineCommandClient } from './client.ts';
import { ENGINE_JUDGE_BOOST_MAX_IDS, type EngineItemIdentity } from './commands.ts';
import type { EngineStatusRead } from './snapshot.ts';

type Snapshot = () => EngineStatusRead | undefined;

function isBacklog(value: unknown): value is TierClassificationBacklog {
  return typeof value === 'object' && value !== null
    && typeof (value as TierClassificationBacklog).checkingItems === 'number'
    && typeof (value as TierClassificationBacklog).summary === 'string';
}

/** The judge as the front shows it: its backlog, whether it is ahead of the lanes, and whether it takes archive items. */
export function frontJudgeState(snapshot: Snapshot): {
  backlog: () => TierClassificationBacklog | undefined;
  busy: () => boolean;
  archivePrivateModel: () => ArchivePrivateModelState;
} {
  return {
    backlog: () => {
      const backlog = snapshot()?.snapshot.judge.backlog;
      return isBacklog(backlog) ? backlog : undefined;
    },
    busy: () => snapshot()?.snapshot.judge.busy === true,
    archivePrivateModel: () => (snapshot()?.snapshot.judge.archive_private_model as ArchivePrivateModelState | undefined) ?? 'waiting',
  };
}

/** Unreadable files with the counts the background last counted; names and opening stay the front's reads. */
export function frontUnreadableFiles(local: UnreadableFiles, snapshot: Snapshot): UnreadableFiles {
  return {
    ...local,
    recheck: (corpusId) => snapshot()?.snapshot.unreadable?.[corpusId],
  };
}

export type ArchiveViews = Pick<ArchiveImportDashboard, 'view' | 'cardViews' | 'sourceImports' | 'archiveSources'>;

/**
 * The archive dashboard as the background, which runs the imports, last saw
 * it. Only before any snapshot does the front read the files itself.
 */
export function frontArchiveViews(local: ArchiveViews, snapshot: Snapshot): ArchiveViews {
  const archive = () => snapshot()?.snapshot.archive;
  return {
    view: () => (archive()?.view as ReturnType<ArchiveViews['view']> | undefined) ?? local.view(),
    cardViews: () => (archive()?.cards as ReturnType<ArchiveViews['cardViews']> | undefined) ?? local.cardViews(),
    sourceImports: () => (archive()?.source_imports as ReturnType<ArchiveViews['sourceImports']> | undefined) ?? local.sourceImports(),
    archiveSources: () => (archive()?.sources as ReturnType<ArchiveViews['archiveSources']> | undefined) ?? local.archiveSources(),
  };
}

/**
 * Stop a messaging capture from the front. The background runs capture, so
 * the stop goes there and the caller (Disconnect, Unpair) goes on to remove
 * the grant only once the background answers that the capture stopped; any
 * other outcome throws, and the route keeps the credentials.
 */
export function frontCaptureStop(client: Pick<EngineCommandClient, 'send'>): (source: 'telegram' | 'whatsapp') => Promise<void> {
  return async (source) => {
    const receipt = await client.send({ kind: 'capture_stop', source }, { timeoutMs: 30_000 });
    if (receipt.state !== 'done') throw new Error(receipt.error ?? `The background did not confirm the ${source} capture stopped.`);
  };
}

/**
 * "Make Private" from the front's apps-received panel. The background owns the
 * tier ledgers, so the override goes there and runs the same recorded-item
 * check (`runTierSetOnRecordedItem`); a refusal or no answer throws, and the
 * panel marks nothing.
 */
export function frontSetItemPrivate(client: Pick<EngineCommandClient, 'send'>): (item: { locator: string; provider: string; providerItemId: string; providerConversationId?: string }) => Promise<Record<string, unknown>> {
  return async ({ locator, ...expected }) => {
    const receipt = await client.send({ kind: 'tier_set_recorded', locator, expected }, { timeoutMs: 30_000 });
    if (receipt.state !== 'done') throw new Error(receipt.error ?? 'The background did not record the override.');
    return (receipt.result ?? {}) as Record<string, unknown>;
  };
}

/**
 * Matched-first judging across the split (#1062): the judge runs in the
 * background, so a question's matched pending items are raised there. Order
 * only, and best effort: a lost raise leaves the queue's own order.
 */
export function frontJudgeBoost(client: Pick<EngineCommandClient, 'post'>): (identities: readonly EngineItemIdentity[]) => void {
  return (identities) => {
    const top = identities.slice(0, ENGINE_JUDGE_BOOST_MAX_IDS).map((identity) => ({
      provider: identity.provider, accountScope: identity.accountScope, providerItemId: identity.providerItemId,
      ...(identity.providerConversationId ? { providerConversationId: identity.providerConversationId } : {}),
    }));
    if (top.length === 0) return;
    void client.post({ kind: 'judge_boost', identities: top }, { timeoutMs: 10_000 }).catch(() => undefined);
  };
}
