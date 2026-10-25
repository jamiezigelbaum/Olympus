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
import { startArchiveImport, type ArchiveImportStart } from './start.ts';
import { ArchiveImportStateStore, defaultArchiveImportStatePath } from './state.ts';
import { archiveConnectorStoreDbPaths } from './store.ts';

export interface ArchiveImportRuntime {
  readonly state: ArchiveImportStateStore;
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
  existingLanes(): ArchiveTierLane[];
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
   * subscribed while a removal is waiting, which is a restart in the middle of
   * one, or the archive source coming back to the roster for it.
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
  const removalWaiting = (): boolean => {
    try {
      return state.list().some((record) => record.status === 'removing');
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
    families: () => [...families],
    lane,
    existingLanes: () => families.filter(hasData).map((family) => lane(family)),
    openWaitingQuestions: () => {
      const path = options.waitingQuestionsDbPath
        ?? waitingPrivateQuestionsDbPath(resolveRemoteConnectionsDbPath(env));
      return existsSync(path) ? openWaitingPrivateQuestionStore(path) : undefined;
    },
    start: (path) => startArchiveImport({ state, path }),
    subscribeWork: (wake) => {
      subscribers.add(wake);
      if (removalWaiting()) wake();
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
