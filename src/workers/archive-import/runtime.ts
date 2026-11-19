/**
 * The worker's handle on imported archives: the archive record, and one tier
 * lane per source family, built only when that family has an archive or a
 * store from one. An install that never imported anything creates no file.
 *
 * A host (the source runtime) adopts each lane as it is built, so its stores
 * are served, embedded and governed by their set ledger like every other
 * lane's, and registers each store as it opens.
 */
import { existsSync } from 'node:fs';
import { archiveImportFamilies } from '../../core/archive-formats.ts';
import { resolveRemoteConnectionsDbPath } from '../../core/remote-connections.ts';
import {
  openWaitingPrivateQuestionStore,
  waitingPrivateQuestionsDbPath,
  type WaitingQuestionStore,
} from '../../core/waiting-private-questions.ts';
import type { SourceFamily } from '../../core/source-index/types.ts';
import type { SecretLocationsIndex } from '../classification/secret-locations.ts';
import type { LocalConnectorStore } from '../connector-store/index.ts';
import { registerArchiveFormatConnectors } from './format-connectors.ts';
import { createArchiveTierLane, type ArchiveTierLane } from './lane.ts';
import {
  archiveMediaBindingsPath,
  createArchiveMediaBindings,
  defaultArchiveMediaBindingsPath,
  type ArchiveMediaBindings,
} from './media-bindings.ts';
import { archiveSourceTargets, type ArchiveSourceTargets } from './source-targets.ts';
import { startArchiveImport, type ArchiveImportStart } from './start.ts';
import { ArchiveImportStateStore, defaultArchiveImportStatePath } from './state.ts';
import { archiveConnectorStoreDbPaths } from './store.ts';

export interface ArchiveImportRuntime {
  readonly state: ArchiveImportStateStore;
  /**
   * The sources an archive can be an input of (source-targets.ts). Imports
   * of the formats they read join the source's account at approval; with none
   * registered every import stays under Archives.
   */
  readonly targets: ArchiveSourceTargets;
  /**
   * The media bindings of the archives (media-bindings.ts), opened when the
   * first one is needed; the file sits beside the record.
   */
  readonly media: ArchiveMediaBindings;
  /**
   * Every family archives are imported into.
   */
  families(): SourceFamily[];
  /**
   * The family's lane, built on first need.
   */
  lane(family: string): ArchiveTierLane;
  /**
   * The lanes of families that have an archive or a store already (built now).
   */
  existingLanes(only?: ReadonlySet<string>): ArchiveTierLane[];
  laneMounted(family: string): boolean;
  /**
   * The private inbox, opened for one removal (the caller closes it); undefined when there is none.
   */
  openWaitingQuestions(): WaitingQuestionStore | undefined;
  /**
   * Starts importing the canonical path the person approved (start.ts).
   */
  start(path: string): ArchiveImportStart;
  /**
   * The scheduler's push wake (`subscribeChanges`) for the archive tasks:
   * `wake` runs them now, not at their cadence. One function for the life of
   * the runtime, so the scheduler subscribes once. It also wakes at once when
   * subscribed while a removal or an import is waiting, which is a restart or
   * an update in the middle of one, or the archive source coming back to the
   * roster for it.
   */
  readonly subscribeWork: (wake: () => void) => () => void;
  /**
   * Wakes every subscriber: there is work to run now (a removal was asked for).
   */
  notifyWork(): void;
}

export interface ArchiveImportRuntimeOptions {
  env?: Record<string, string | undefined>;
  /**
   * Test seam: the sources an archive can be an input of (default: the registered ones).
   */
  targets?: ArchiveSourceTargets;
  /**
   * Test seam: the record's path.
   */
  statePath?: string;
  openSecretLocations?: (secureDbPath: string) => SecretLocationsIndex | undefined;
  /**
   * Told once per lane, when it is built.
   */
  onLane?: (lane: ArchiveTierLane) => void;
  /**
   * Told once per store, when it opens.
   */
  onStoreOpened?: (store: LocalConnectorStore, lane: ArchiveTierLane) => void;
  /**
   * Test seam: where the private inbox lives.
   */
  waitingQuestionsDbPath?: string;
}

export function createArchiveImportRuntime(options: ArchiveImportRuntimeOptions = {}): ArchiveImportRuntime {
  registerArchiveFormatConnectors();
  const env = options.env ?? process.env;
  const state = new ArchiveImportStateStore({ path: options.statePath ?? defaultArchiveImportStatePath(env), env });
  const media = createArchiveMediaBindings({
    // Beside the record, wherever the layout resolvers (or a test) put it.
    path: options.statePath ? archiveMediaBindingsPath(options.statePath) : defaultArchiveMediaBindingsPath(env),
    env,
  });
  const families = archiveImportFamilies();
  const lanes = new Map<string, ArchiveTierLane>();

  const lane = (family: string): ArchiveTierLane => {
    const known = families.find((candidate) => candidate === family);
    if (!known) throw new Error('No archive format imports into this family.');
    const existing = lanes.get(known);
    if (existing) return existing;
    let built: ArchiveTierLane | undefined;
    const pending: LocalConnectorStore[] = [];
    built = createArchiveTierLane({
      family: known,
      env,
      ...(options.openSecretLocations ? { openSecretLocations: options.openSecretLocations } : {}),
      onStoreOpened: (store) => {
        if (built) options.onStoreOpened?.(store, built);
        else pending.push(store);
      },
    });
    lanes.set(known, built);
    options.onLane?.(built);
    for (const store of pending) options.onStoreOpened?.(store, built);
    return built;
  };

  const subscribers = new Set<() => void>();
  // An import still reading is work waiting too: the durable schedule of its last pass says the source's interval (30 minutes)
  // after it, and that slot outlives a restart or an update, which held a 2-message mbox for 30 minutes (run 43736059061).
  const workWaiting = (): boolean => {
    try {
      return state.list().some((record) => record.status === 'removing' || record.status === 'importing');
    } catch {
      return false;
    }
  };

  const hasData = (family: SourceFamily): boolean => {
    if (archiveConnectorStoreDbPaths([family], env).some((path) => existsSync(path))) return true;
    try {
      return state.list().some((record) => record.family === family);
    } catch {
      // An unreadable record still has stores to serve only if they exist (above).
      return false;
    }
  };

  return {
    state,
    media,
    targets: options.targets ?? archiveSourceTargets,
    families: () => [...families],
    lane,
    existingLanes: (only) => {
      // One family's unfinished ledger must not stop a ready family from mounting.
      const built: ArchiveTierLane[] = [];
      let failed: { error: unknown } | undefined;
      for (const family of families) {
        if ((only && !only.has(family)) || !hasData(family)) continue;
        try { built.push(lane(family)); } catch (error) { failed ??= { error }; }
      }
      if (failed) throw failed.error;
      return built;
    },
    laneMounted: (family) => lanes.has(family),
    openWaitingQuestions: () => {
      const path = options.waitingQuestionsDbPath
        ?? waitingPrivateQuestionsDbPath(resolveRemoteConnectionsDbPath(env));
      return existsSync(path) ? openWaitingPrivateQuestionStore(path) : undefined;
    },
    start: (path) => startArchiveImport({ state, path }),
    subscribeWork: (wake) => {
      subscribers.add(wake);
      if (workWaiting()) {
        try {
          wake();
        } catch {
          // A subscriber that fails is not this caller's failure.
        }
      }
      return () => { subscribers.delete(wake); };
    },
    notifyWork: () => {
      for (const wake of [...subscribers]) {
        try {
          wake();
        } catch {
          // One subscriber's failure never stops the others.
        }
      }
    },
  };
}
