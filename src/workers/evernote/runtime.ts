/**
 * The Evernote source in the engine: its lane of stores, the live pass for
 * the connected handle, the reading of its attachments, its scheduler source,
 * and the dashboard's facts about its passes. The server wires this once;
 * nothing here is Evernote-specific beyond the module it drives.
 *
 * The lane opens when it is first needed (a connected account, or stores a
 * previous connection left), so an install that never connects Evernote
 * creates no file.
 */
import { existsSync } from 'node:fs';
import type { FetchLike } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { OlympusConfig } from '../../core/config.ts';
import { isMcpSourceError, type McpSourceErrorKind } from '../../core/mcp-source/errors.ts';
import type { McpCallPacer } from '../../core/mcp-source/pacer.ts';
import type { SecretStore } from '../../core/secret-store.ts';
import type { SecretLocationsIndex } from '../classification/secret-locations.ts';
import type { LocalConnectorStore } from '../connector-store/index.ts';
import type { ConnectedCredentialHandle } from '../credential-broker/connected-handles.ts';
import { createChildExtractionRuntime } from '../email-source/child-extraction-runtime.ts';
import type { FileExtractionRuntime } from '../email-source/file-extraction-runtime.ts';
import type { ExtractorRegistryConfig } from '../file-extraction/types.ts';
import type { DashboardLivePass, DashboardLivePassErrorKind } from '../source-dashboard.ts';
import {
  SCHEDULER_SOURCE_IDS,
  SourceSchedulerTaskFailure,
  fileExtractionSchedulerTask,
  type SourceSchedulerSource,
  type SourceSchedulerTask,
} from '../source-scheduler.ts';
import { resolvedStorePath } from '../../core/source-placement.ts';
import { EVERNOTE_PROVIDER, EVERNOTE_SOURCE_ID, type EvernoteNotebookGate } from './connector.ts';
import type { EvernoteNotebook } from './listing.ts';
import {
  EVERNOTE_SECURE_CORPUS_ID,
  createEvernoteLiveSync,
  createEvernoteTierLane,
  evernotePassStatus,
  type EvernoteLiveSync,
  type EvernotePassStatus,
  type EvernoteTierLane,
} from './live-sync.ts';

/** The roster's key for Evernote's attachments (its corpora are the Evernote stores). */
export const EVERNOTE_ATTACHMENT_EXTRACTION_PROVIDER = 'evernote.attachments';
export const EVERNOTE_ATTACHMENT_EXTRACTION_SCOPE_KEY = 'evernote.attachments:extraction';
const EVERNOTE_ATTACHMENT_PLAN_LIMIT = 200;
const EVERNOTE_ATTACHMENT_BATCH_SIZE = 10;
/** How long a pass the provider slowed waits before it is tried again. */
const EVERNOTE_RATE_LIMIT_RETRY_MS = 15 * 60_000;

export interface EvernoteRuntimeOptions {
  env?: Record<string, string | undefined>;
  secretStore: () => SecretStore;
  registryPath: string;
  extractors?: ExtractorRegistryConfig;
  openSecretLocations?: (secureDbPath: string) => SecretLocationsIndex | undefined;
  /** Told once, when the lane opens (the server adopts it like every other lane). */
  onLane?: (lane: EvernoteTierLane) => void;
  onStoreOpened?: (store: LocalConnectorStore) => void;
  /** Test seams: the MCP server and the attachment download hosts. */
  serverUrl?: string;
  fetch?: FetchLike;
  downloadHosts?: readonly string[];
  downloadFetch?: typeof fetch;
  pacer?: McpCallPacer;
}

export interface EvernoteRuntime {
  /** The lane, when its stores already exist; never creates one. */
  existingLane(): EvernoteTierLane | undefined;
  /** The live pass for this handle (the same one while the handle is). */
  liveSync(handle: ConnectedCredentialHandle): EvernoteLiveSync;
  /**
   * The scheduler source for a connected handle: one pass task and the attachment reads. Each pass
   * asks `notebookGate` which notebooks the person approved (it throws when that approval changed).
   */
  schedulerSource(input: {
    config: OlympusConfig;
    handle: ConnectedCredentialHandle;
    notebookGate: () => EvernoteNotebookGate;
    /** Throws once that approval is no longer the saved one: a running pass stops before its next read or write. */
    assertNotebookChoiceCurrent: () => void;
    /** That approval, recorded on every item a pass stores so reads can be held to it. */
    scope: { accountGeneration: string; scopeRevision: string };
  }): SourceSchedulerSource;
  /** The account's notebooks for the picker (no note is read). */
  notebooks(handle: ConnectedCredentialHandle): Promise<EvernoteNotebook[]>;
  /** The dashboard card's facts about the passes; undefined before the first. */
  dashboardPass(): DashboardLivePass | undefined;
}

export function createEvernoteRuntime(options: EvernoteRuntimeOptions): EvernoteRuntime {
  const env = options.env ?? process.env;
  let lane: EvernoteTierLane | undefined;
  const openLane = (): EvernoteTierLane => {
    if (lane) return lane;
    lane = createEvernoteTierLane({
      env,
      ...(options.openSecretLocations ? { openSecretLocations: options.openSecretLocations } : {}),
      ...(options.onStoreOpened ? { onStoreOpened: options.onStoreOpened } : {}),
    });
    options.onLane?.(lane);
    return lane;
  };
  const existingLane = (): EvernoteTierLane | undefined => {
    if (lane) return lane;
    // A previous connection left its stores: serve them, connected or not.
    if (!existsSync(resolvedStorePath(EVERNOTE_SOURCE_ID, 'secure_local', env))) return undefined;
    const opened = openLane();
    for (const leg of [opened.secure, opened.internal]) if (leg.exists()) leg.open();
    return opened;
  };

  let live: { key: string; sync: EvernoteLiveSync } | undefined;
  const liveSync = (handle: ConnectedCredentialHandle): EvernoteLiveSync => {
    const key = `${handle.handle}:${handle.connectedAt ?? ''}`;
    if (live?.key === key) return live.sync;
    live = {
      key,
      sync: createEvernoteLiveSync({
        lane: openLane(),
        secretStore: options.secretStore(),
        handle,
        registryPath: options.registryPath,
        env,
        ...(options.serverUrl ? { serverUrl: options.serverUrl } : {}),
        ...(options.fetch ? { fetch: options.fetch } : {}),
        ...(options.downloadHosts ? { downloadHosts: options.downloadHosts } : {}),
        ...(options.downloadFetch ? { downloadFetch: options.downloadFetch } : {}),
        ...(options.pacer ? { pacer: options.pacer } : {}),
      }),
    };
    return live.sync;
  };

  // The attachment reader over whichever stores are open, rebuilt when that changes. It serves the
  // Private store's corpus only: as the lane's one legacy store it lists the routed Personal store too
  // (tieredExtractionView `home`), so an attachment is read once wherever its note rests.
  // Also rebuilt for a new sync (a reconnect): the attachment connector carries that sync's bound choice.
  let extraction: { key: string; sync: EvernoteLiveSync; runtime: FileExtractionRuntime | undefined } | undefined;
  const extractionRuntime = (sync: EvernoteLiveSync, accountScope: string): FileExtractionRuntime | undefined => {
    const opened = openLane();
    const stores = [opened.secure.current(), opened.internal.current()].filter((store): store is LocalConnectorStore => store !== undefined);
    const key = `${accountScope}|${stores.map((store) => store.corpusId).join(',')}`;
    if (extraction?.key === key && extraction.sync === sync) return extraction.runtime;
    extraction?.runtime?.close();
    const connector = sync.attachmentConnector();
    extraction = {
      key,
      sync,
      runtime: stores.length === 0 ? undefined : createChildExtractionRuntime({
        provider: EVERNOTE_ATTACHMENT_EXTRACTION_PROVIDER,
        scopeKey: EVERNOTE_ATTACHMENT_EXTRACTION_SCOPE_KEY,
        corpusIds: [opened.secure.corpusId],
        stores: [opened.secure.open(), ...stores.filter((store) => store.corpusId !== opened.secure.corpusId)],
        set: opened.set,
        accountScope: () => accountScope,
        connector: (scope) => (scope === accountScope ? connector : undefined),
        ...(options.extractors ? { extractors: options.extractors } : {}),
        env,
      }),
    };
    return extraction.runtime;
  };

  return {
    existingLane,
    liveSync,
    notebooks: (handle) => liveSync(handle).notebooks(),
    schedulerSource({ config, handle, notebookGate, assertNotebookChoiceCurrent, scope }) {
      const sync = liveSync(handle);
      // Attachment reads are held to the same choice as the pass.
      sync.bindNotebookChoice({ gate: notebookGate, assertCurrent: assertNotebookChoiceCurrent });
      const accountScope = handle.accountRole ?? 'personal';
      const opened = openLane();
      const intervalMs = config.worker.scheduler.syncIntervalSeconds * 1_000;
      const freshnessThresholdMs = config.worker.scheduler.freshnessThresholdHours * 60 * 60_000;
      const pass: SourceSchedulerTask = {
        id: 'evernote.notes_pass',
        kind: 'sync',
        writer: true,
        intervalMs,
        freshnessThresholdMs,
        run: async () => {
          try {
            const receipt = await sync.pass({ notebookGate: notebookGate(), assertNotebookChoiceCurrent, scope });
            const stopped = sync.status()?.last_error;
            return {
              status: receipt.status,
              counts: { ...receipt.counts },
              // Slowed by the provider part way: the unread notes wait for the retry, not the next hour.
              ...(receipt.counts.pass_complete === 0 && stopped?.kind === 'rate_limited'
                ? { retryAt: { at: new Date(Date.now() + EVERNOTE_RATE_LIMIT_RETRY_MS).toISOString(), degradedReason: 'rate_limited' } }
                : {}),
            };
          } catch (error) {
            throw evernoteSchedulerFailure(error);
          }
        },
      };
      // One extraction task for the lane (see extractionRuntime); before the pass opens a store there is nothing to read.
      const attachmentTask = (corpusId: string, leg: () => LocalConnectorStore | undefined): SourceSchedulerTask => {
        const laneKey = { corpusId, provider: EVERNOTE_PROVIDER, accountScope, approvedScopeKey: EVERNOTE_ATTACHMENT_EXTRACTION_SCOPE_KEY };
        const id = `evernote.attachments.${corpusId}`;
        return {
          id,
          kind: 'extract',
          writer: true,
          run: async (context) => {
            const runtime = leg() ? extractionRuntime(sync, accountScope) : undefined;
            if (!runtime) return { status: 'idle', counts: {} };
            return fileExtractionSchedulerTask({
              id,
              runner: runtime.runner,
              lane: laneKey,
              planLimit: EVERNOTE_ATTACHMENT_PLAN_LIMIT,
              batchSize: EVERNOTE_ATTACHMENT_BATCH_SIZE,
            }).run(context);
          },
        };
      };
      return {
        sourceId: SCHEDULER_SOURCE_IDS.evernote,
        corpusId: EVERNOTE_SECURE_CORPUS_ID,
        cadence: 'continuous',
        intervalMs,
        freshnessThresholdHours: config.worker.scheduler.freshnessThresholdHours,
        tasks: [
          pass,
          attachmentTask(opened.secure.corpusId, () => opened.secure.current() ?? opened.internal.current()),
        ],
        lastSyncCompletedAt: () => sync.lastStoreRunCompletedAt(),
      };
    },
    dashboardPass: () => evernoteDashboardPass(live?.sync.status() ?? evernotePassStatus(env)),
  };
}

const AUTH_KINDS: ReadonlySet<string> = new Set(['auth_missing', 'auth_expired', 'auth_revoked']);

/** A pass that changed nothing, as the scheduler records it: the provider's kind, and a retry time when it slowed us. */
export function evernoteSchedulerFailure(error: unknown): unknown {
  if (isMcpSourceError(error)) {
    return new SourceSchedulerTaskFailure(error.message, {
      errorKind: AUTH_KINDS.has(error.kind) ? 'credential_missing' : `evernote_${error.kind}`,
      ...(error.kind === 'rate_limited'
        ? { retryAt: { at: new Date(Date.now() + (error.retryAfterMs ?? EVERNOTE_RATE_LIMIT_RETRY_MS)).toISOString(), degradedReason: 'rate_limited' } }
        : {}),
    });
  }
  if ((error as { name?: string } | undefined)?.name === 'EvernoteAccountChanged') {
    return new SourceSchedulerTaskFailure('The connected Evernote account is not the one the stored notes came from; nothing was changed.', { errorKind: 'evernote_account_changed' });
  }
  if ((error as { name?: string } | undefined)?.name === 'EvernoteListingIncomplete') {
    return new SourceSchedulerTaskFailure('The Evernote listing could not be completed; nothing was changed.', { errorKind: 'evernote_listing_incomplete' });
  }
  return error;
}

const PASS_ERROR_KIND: Readonly<Partial<Record<McpSourceErrorKind | 'listing_incomplete' | 'account_changed' | 'pass_failed', DashboardLivePassErrorKind>>> = {
  auth_missing: 'auth',
  auth_expired: 'auth',
  auth_revoked: 'auth',
  rate_limited: 'rate_limited',
  listing_incomplete: 'listing_incomplete',
  account_changed: 'account_changed',
  permission_missing: 'unavailable',
  server_error: 'unavailable',
  tool_refused: 'unavailable',
  pass_failed: 'unavailable',
  // A pass that ran out of its call budget or was stopped resumes on its own: nothing to say.
};

/** The card's facts from the pass record: counts and a closed kind, nothing from a note. */
export function evernoteDashboardPass(status: EvernotePassStatus | undefined): DashboardLivePass | undefined {
  if (!status || (!status.last_completed_at && !status.last_error)) return undefined;
  const counts = status.counts;
  const errorKind = status.last_error ? PASS_ERROR_KIND[status.last_error.kind] : undefined;
  return {
    ...(status.last_completed_at ? { completed_at: status.last_completed_at } : {}),
    notes: counts?.notes_listed ?? 0,
    notebooks: counts?.notebooks ?? 0,
    shared_not_imported: counts?.shared_not_imported ?? 0,
    ...(errorKind && status.last_error ? { error: { kind: errorKind, at: status.last_error.at } } : {}),
  };
}
