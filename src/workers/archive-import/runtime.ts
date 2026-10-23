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
import { ArchiveImportStateStore, defaultArchiveImportStatePath } from './state.ts';
import { archiveConnectorStoreDbPaths } from './store.ts';

export interface ArchiveImportRuntime {
  readonly state: ArchiveImportStateStore;
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
  const state = new ArchiveImportStateStore({ path: options.statePath ?? defaultArchiveImportStatePath(env) });
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
    families: () => [...families],
    lane,
    existingLanes: () => families.filter(hasData).map((family) => lane(family)),
    openWaitingQuestions: () => {
      const path = options.waitingQuestionsDbPath
        ?? waitingPrivateQuestionsDbPath(resolveRemoteConnectionsDbPath(env));
      return existsSync(path) ? openWaitingPrivateQuestionStore(path) : undefined;
    },
  };
}
