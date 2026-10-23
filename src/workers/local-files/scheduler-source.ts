// The local files lane as a scheduler source: one sync task per approved
// folder, extraction per folder that is read in full, and embedding. Instant
// updates come from the watch hub (`subscribeChanges`); the interval is the
// backstop and, where the watcher cannot run, the way changes are found.

import type { OlympusConfig } from '../../core/config.ts';
import type { SourceIngestionPolicy } from '../../core/source-ingestion-policy.ts';
import { isApprovedSecureSourceEmbeddingProvider, type SourceEmbeddingProvider } from '../source-index/embeddings.ts';
import type { LocalConnectorStore } from '../connector-store/index.ts';
import type { FileExtractionRunner } from '../file-extraction/runner.ts';
import {
  DROPBOX_EMBED_MAX_CHUNKS_PER_PASS,
  SCHEDULER_SOURCE_IDS,
  SourceSchedulerTaskFailure,
  embedPassResult,
  fileExtractionSchedulerTask,
  progressFromCounts,
  schedulerScopeHash,
  type SourceSchedulerSource,
  type SourceSchedulerTask,
  type SourceSchedulerTaskRunContext,
} from '../source-scheduler.ts';
import { realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { MacPermissions } from './mac-permissions.ts';
import { LocalFilesRootMissingError, LocalFilesRootPermissionError } from './connector.ts';
import { realPathOfScopePath } from './locations.ts';
import { isWithinScopePath } from './paths.ts';
import type { LocalFilesProviderStoreSyncHandler } from './provider-store-sync.ts';
import { LOCAL_FILES_ACCOUNT_SCOPE, LOCAL_FILES_PROVIDER } from './scope.ts';
import type { VolumeResolver } from './volume-identity.ts';
import { ignoreGlobsForRoot, watchWouldIgnore, type WatchHub } from './watch-hub.ts';

const DAY_MS = 24 * 60 * 60 * 1000;
/** A folder the computer would not open is checked again soon: the person may have just allowed it. */
const PERMISSION_RETRY_MS = 10 * 60 * 1000;

export interface LocalFilesSchedulerSourceInput {
  /** The base policy with one root per approved folder (`fileSourceScopeLocalFilesPolicy`). */
  policy: SourceIngestionPolicy;
  config: OlympusConfig;
  providerSync?: LocalFilesProviderStoreSyncHandler;
  store?: LocalConnectorStore;
  fileExtraction?: FileExtractionRunner;
  embeddingProvider?: SourceEmbeddingProvider;
  tierEmbeddings?: ReadonlyArray<{
    corpusId: string;
    store: () => LocalConnectorStore | undefined;
    provider: SourceEmbeddingProvider;
  }>;
  /** Live change notifications for the approved folders, and what they must not report. */
  watch?: { hub: WatchHub; volumes: VolumeResolver; ignore: readonly string[] };
  /** The Mac's folder rules; defaults to this computer's. */
  macPermissions?: MacPermissions;
  volumes?: VolumeResolver;
}

function retryTomorrow(context: SourceSchedulerTaskRunContext | undefined, reason: string, afterMs: number = DAY_MS): {
  at: string;
  effectiveIntervalMs: number;
  degradedReason: string;
} {
  const attempted = Date.parse(context?.attemptedAt ?? new Date().toISOString());
  return { at: new Date(attempted + afterMs).toISOString(), effectiveIntervalMs: afterMs, degradedReason: reason };
}

export function createLocalFilesSchedulerSource(input: LocalFilesSchedulerSourceInput): SourceSchedulerSource | undefined {
  if (!input.providerSync || !input.store) return undefined;
  if (input.embeddingProvider && !isApprovedSecureSourceEmbeddingProvider(input.embeddingProvider)) {
    throw new Error('Local files secure_local embeddings require a local/private or approved Venice embedding provider.');
  }
  const roots = input.policy.roots;
  const tasks: SourceSchedulerTask[] = [];
  // Defence in depth: whatever was saved, a guarded folder is not read unless
  // the engine runs under the helper app (a read from Bun would be asked in
  // Bun's name). Those folders stay idle and report that the helper is needed.
  const macPermissions = input.macPermissions ?? new MacPermissions({ home: realpathSync(homedir()) });
  const volumeResolver = input.volumes ?? input.watch?.volumes;
  const needsHelper = (scopePath: string): boolean => {
    if (!macPermissions.active || macPermissions.hasHelper()) return false;
    if (scopePath === '/') return true;
    const real = volumeResolver ? realPathOfScopePath(volumeResolver, scopePath) : scopePath;
    return real !== undefined && macPermissions.blocksReadWithoutHelper(real, volumeResolver?.volumeOf(real));
  };
  const blockedRoots = new Set(roots.filter((root) => needsHelper(root.path)).map((root) => root.path));

  for (const root of roots) {
    const approvedScopeKey = root.approved_scope_key;
    tasks.push({
      id: `local.files_store_pull.${schedulerScopeHash(approvedScopeKey)}`,
      scopePath: root.path,
      kind: 'sync',
      writer: true,
      run: async (context?: SourceSchedulerTaskRunContext) => {
        if (blockedRoots.has(root.path)) {
          // The fix is the helper app (or, under OpenClaw's own worker, a
          // different host), not System Settings: its own reason, so the
          // dashboard offers no privacy-settings button for it.
          throw new SourceSchedulerTaskFailure(macPermissions.helperNeededCopy(), {
            errorKind: 'scope_root_helper_needed',
            retryAt: retryTomorrow(context, 'scope_root_helper_needed', PERMISSION_RETRY_MS),
          });
        }
        let outcome;
        try {
          outcome = await input.providerSync!.pull({
            approved_scope_key: approvedScopeKey,
            ...(context?.checkpoint ? { checkpoint: context.checkpoint } : {}),
          });
        } catch (error) {
          // A folder that is gone (renamed, or its disk is not mounted) or that
          // the system will not let Olympus read is not an outage: it keeps a
          // daily recovery check while every other folder runs as usual.
          if (error instanceof LocalFilesRootMissingError) {
            throw new SourceSchedulerTaskFailure('A chosen folder is missing.', {
              errorKind: 'scope_root_missing',
              retryAt: retryTomorrow(context, 'scope_root_missing'),
            });
          }
          if (error instanceof LocalFilesRootPermissionError) {
            // The Mac's privacy rule (a Files & Folders switch fixes it) is a
            // different problem from the account's own file permissions
            // (System Settings cannot fix those).
            const real = root.path === '/' ? '/' : volumeResolver ? realPathOfScopePath(volumeResolver, root.path) : root.path;
            const privacy = real !== undefined
              && macPermissions.isPrivacyRefusal(real, error.errno, volumeResolver?.volumeOf(real));
            // A privacy refusal with no helper behind the read (a saved
            // ~/Library/Mail scope after the helper was deleted) cannot be
            // answered in System Settings: no app is there to switch on.
            const noHelper = privacy && !macPermissions.hasHelper();
            const errorKind = noHelper ? 'scope_root_helper_needed' : privacy ? 'scope_root_permission_needed' : 'scope_root_unreadable';
            throw new SourceSchedulerTaskFailure(
              noHelper ? macPermissions.helperNeededCopy()
                : privacy ? 'Your Mac did not allow Olympus to read a chosen folder.' : 'Your user account is not allowed to read a chosen folder.',
              { errorKind, retryAt: retryTomorrow(context, errorKind, PERMISSION_RETRY_MS) },
            );
          }
          throw error;
        }
        return {
          status: outcome.receipt.status,
          counts: outcome.receipt.counts,
          ...(outcome.receipt.warnings ? { warnings: outcome.receipt.warnings } : {}),
          checkpoint: outcome.checkpoint,
        };
      },
    });
  }

  if (input.fileExtraction) {
    for (const root of roots) {
      if (root.default_action !== 'full_extract' || blockedRoots.has(root.path)) continue;
      tasks.push(fileExtractionSchedulerTask({
        id: `local.files_extract.${schedulerScopeHash(root.approved_scope_key)}`,
        runner: input.fileExtraction,
        lane: {
          corpusId: input.policy.corpusId,
          provider: LOCAL_FILES_PROVIDER,
          accountScope: LOCAL_FILES_ACCOUNT_SCOPE,
          approvedScopeKey: root.approved_scope_key,
        },
        planLimit: input.policy.content.plan_limit,
        batchSize: input.policy.content.batch_size,
      }));
    }
  }

  if (input.embeddingProvider) {
    tasks.push({
      id: 'local.files_embeddings',
      kind: 'embed',
      writer: true,
      run: async () => {
        const result = await input.store!.embedChunks({
          provider: input.embeddingProvider!,
          limit: DROPBOX_EMBED_MAX_CHUNKS_PER_PASS,
        });
        return embedPassResult(result, DROPBOX_EMBED_MAX_CHUNKS_PER_PASS);
      },
    });
  }

  for (const tier of input.tierEmbeddings ?? []) {
    tasks.push({
      id: `local.files_embeddings.${schedulerScopeHash(tier.corpusId)}`,
      kind: 'embed',
      writer: true,
      run: async () => {
        const store = tier.store();
        if (!store) return progressFromCounts({ chunks_seen: 0, chunks_embedded: 0, chunks_skipped: 0 });
        if (store.trustDomain === 'secure_local' && !isApprovedSecureSourceEmbeddingProvider(tier.provider)) {
          throw new Error('A secure_local tier store requires a local/private or approved Venice embedding provider.');
        }
        const result = await store.embedChunks({ provider: tier.provider, limit: DROPBOX_EMBED_MAX_CHUNKS_PER_PASS });
        return embedPassResult(result, DROPBOX_EMBED_MAX_CHUNKS_PER_PASS);
      },
    });
  }

  if (input.watch) watchApprovedFolders(input.watch, roots.filter((root) => !blockedRoots.has(root.path)).map((root) => root.path));

  return {
    sourceId: SCHEDULER_SOURCE_IDS.localFiles,
    corpusId: input.policy.corpusId,
    cadence: input.policy.sync.cadence,
    intervalMs: input.config.worker.scheduler.syncIntervalSeconds * 1_000,
    freshnessThresholdHours: input.config.worker.scheduler.freshnessThresholdHours,
    tasks,
    lastSyncCompletedAt: () => {
      const completions = roots.map((root) =>
        input.store!.lastCompletedSyncRun(input.providerSync!.connectorIdForScope(root.approved_scope_key))?.completedAt);
      if (completions.length === 0 || completions.some((completedAt) => completedAt === undefined)) return undefined;
      return completions.sort()[0];
    },
    // A stable function: the scheduler re-subscribes whenever its identity changes.
    ...(input.watch ? { subscribeChanges: input.watch.hub.subscribeChanges } : {}),
  };
}

/**
 * Points the hub at the approved folders that exist right now. A folder
 * inside another approved folder is covered by it, and a folder that is gone
 * (a disk that is not mounted) is watched again when it returns, on the next
 * build. A nested folder the outer watch cannot see keeps its own watch: one
 * on another disk (inotify and FSEvents do not follow a mount into another
 * device) or inside a place the outer watch leaves out (iCloud Drive inside
 * Library, a chosen `.git`).
 */
export function watchApprovedFolders(
  watch: { hub: WatchHub; volumes: VolumeResolver; ignore: readonly string[] },
  scopePaths: readonly string[],
): void {
  const resolved = [...new Set(scopePaths)].flatMap((path) => {
    const real = realPathOfScopePath(watch.volumes, path);
    return real ? [{ path, real }] : [];
  });
  const mountOf = (real: string): string => watch.volumes.volumeOf(real).mountPoint;
  const covers = (outer: { real: string }, inner: { real: string }): boolean =>
    mountOf(outer.real) === mountOf(inner.real) && !watchWouldIgnore(watch.ignore, outer.real, inner.real);
  const watched = resolved.filter((entry) =>
    !resolved.some((other) => other !== entry && isWithinScopePath(entry.path, other.path) && covers(other, entry)));
  watch.hub.setRoots(watched.map(({ real }) => ({ root: real, ignore: ignoreGlobsForRoot(watch.ignore, real) })));
}
