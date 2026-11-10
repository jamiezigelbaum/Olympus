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

/** The snapshot only while it is a reading of now (snapshot.ts, `stale`). */
function current(snapshot: Snapshot): EngineStatusRead | undefined {
  const read = snapshot();
  return read && !read.stale ? read : undefined;
}

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
      const backlog = current(snapshot)?.snapshot.judge.backlog;
      return isBacklog(backlog) ? backlog : undefined;
    },
    busy: () => current(snapshot)?.snapshot.judge.busy === true,
    archivePrivateModel: () => (current(snapshot)?.snapshot.judge.archive_private_model as ArchivePrivateModelState | undefined) ?? 'waiting',
  };
}

/** Unreadable files with the counts the background last counted; names and opening stay the front's reads. */
export function frontUnreadableFiles(local: UnreadableFiles, snapshot: Snapshot): UnreadableFiles {
  return {
    ...local,
    recheck: (corpusId) => current(snapshot)?.snapshot.unreadable?.[corpusId],
  };
}

export type ArchiveViews = Pick<ArchiveImportDashboard, 'view' | 'cardViews' | 'sourceImports' | 'archiveSources'>;

/**
 * The archive dashboard as the background, which runs the imports, last saw
 * it. The front reads the files itself when there is no current snapshot
 * (none yet, a stale one, or one written before the front's own last archive
 * change, `changedAt`), so a removed archive is not shown from an old reading.
 */
export function frontArchiveViews(local: ArchiveViews, snapshot: Snapshot, changedAt: () => number | undefined = () => undefined): ArchiveViews {
  const archive = () => {
    const read = current(snapshot);
    if (!read) return undefined;
    const changed = changedAt();
    if (changed !== undefined && Date.parse(read.snapshot.written_at) < changed) return undefined;
    return read.snapshot.archive;
  };
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

/**
 * A model, judge or policy change saved through the front. Both processes
 * read the models at boot, so both restart: the background is told first and
 * the front restarts only once the background has answered that it is
 * restarting (or the ask ran out, which is logged). The background waits for
 * this front to end before it restarts, so the answer is never cut off. One ask at a time; a
 * second change while one is in flight rides along.
 */
export function frontModelReload<R>(options: {
  client: Pick<EngineCommandClient, 'send'>;
  /** The front's own restart (the single worker's model reload). */
  restartSelf: (request?: R) => boolean;
  /** Whether this front restarts itself; the answer the settings page shows. */
  managed: boolean;
  log?: (line: string) => void;
  /** This front's process id: the background restarts after it ends. */
  pid?: number;
}): (request?: R) => boolean {
  const log = options.log ?? (() => {});
  let pending: Promise<void> | undefined;
  return (request) => {
    if (!options.managed) return false;
    if (pending) return true;
    pending = options.client.send({ kind: 'reload', target: 'models', frontPid: options.pid ?? process.pid }, { timeoutMs: 30_000 }).then((receipt) => {
      if (receipt.state !== 'done' || (receipt.result as { restarting?: unknown } | undefined)?.restarting !== true) {
        log('[engine-split] the background did not confirm it is restarting for the model change; restart Olympus if the new model does not take effect.');
      }
    }, () => {
      log('[engine-split] the background did not answer the model change; restart Olympus if the new model does not take effect.');
    }).finally(() => {
      pending = undefined;
      options.restartSelf(request);
    });
    return true;
  };
}
