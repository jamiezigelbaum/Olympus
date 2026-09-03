// Source-specific control plane around the real Readwise SourceConnector.
// Provider I/O stays inside Contract 1; shared ingest and embedding stay in the
// generic connector-store runner. Everything that leaves this module is
// counts-only: the resume cursor is handed to the scheduler as an opaque
// checkpoint and never appears in a receipt, warning, or log line.

import { createHash } from 'node:crypto';
import {
  sourceInvocationProvenance,
  type SourceInvocationProvenance,
} from '../../core/invocation-provenance.ts';
import {
  syncAndEmbedFromConnector,
  type ConnectorStoreSyncAndEmbedSummary,
  type LocalConnectorStore,
} from '../connector-store/index.ts';
import type { CredentialBroker } from '../credential-broker/index.ts';
import type { SourceEmbeddingProvider } from '../source-index/embeddings.ts';
import { ReadwiseApiError, type ReadwiseApiClientOptions } from './api.ts';
import {
  READWISE_CONNECTOR_ID,
  READWISE_PROVIDER,
  ReadwiseDailyRequestBudget,
  createReadwiseSourceConnector,
  isReadwiseConnectorCursor,
  type ReadwiseRequestBudgetStatus,
} from './connector.ts';
import {
  defaultReadwiseLiveSyncConfig,
  type ReadwiseLiveSyncConfig,
} from './live-control.ts';

export const READWISE_STORE_PULL_RECEIPT_KIND = 'readwise_connector_store_pull_receipt';
export const READWISE_STORE_RECONCILE_RECEIPT_KIND = 'readwise_connector_store_reconcile_receipt';
export const READWISE_RESUME_REJECTED_WARNING = 'readwise_store_resume_cursor_rejected';

export interface ReadwiseConnectorStoreSyncResult {
  status: 'progress' | 'idle';
  counts: {
    api_requests: number;
    daily_api_request_budget: number;
    items_seen: number;
    items_indexed: number;
    items_tombstoned: number;
    chunks_indexed: number;
    chunks_embedded: number;
  };
  api_usage: {
    utc_day: string;
  };
  policy: {
    counts_only: true;
    raw_source_exposed: false;
    source_text_returned: false;
    provider_cursor_exposed: false;
  };
}

export interface ReadwiseConnectorStoreReceipt {
  kind: typeof READWISE_STORE_PULL_RECEIPT_KIND | typeof READWISE_STORE_RECONCILE_RECEIPT_KIND;
  status: 'progress' | 'idle';
  counts: {
    api_requests: number;
    daily_api_request_budget: number;
    items_seen: number;
    items_indexed: number;
    /**
     * Of `items_indexed`, the upserts that actually changed a stored row.
     * `items_indexed` counts writes, so it reads healthy while a lane rewrites
     * rows it already had; this is the count the scheduler's not-advancing
     * gate reads.
     */
    items_changed: number;
    items_tombstoned: number;
    items_rejected: number;
    chunks_indexed: number;
    chunks_embedded: number;
    /** 1 when the run continued a durable checkpoint instead of starting over. */
    resumed_from_checkpoint: number;
    /**
     * 1 when a resume point was present but unusable and the run traversed
     * fresh. Carried as a count because the shared scheduler collapses unknown
     * warning tokens, and this signal must stay legible in scheduler status.
     */
    resume_cursor_rejected: number;
    /** 1 when the provider traversal reached its final page in this run. */
    traversal_complete: number;
    /** Always 0 for Readwise: export deletion semantics are unverified. */
    absence_authoritative: number;
  };
  api_usage: {
    utc_day: string;
  };
  warnings?: string[];
  policy: {
    counts_only: true;
    raw_source_exposed: false;
    source_text_returned: false;
    provider_cursor_exposed: false;
    absence_authority: 'partial_window';
    tombstones_applied: false;
  };
  receipt_sha256: string;
}

export interface ReadwiseConnectorStoreTaskOutcome {
  receipt: ReadwiseConnectorStoreReceipt;
  /**
   * Scheduler-private durable resume point. `null` clears the checkpoint after
   * a completed traversal. It crosses only the scheduler state store, never a
   * counts-only surface.
   */
  checkpoint: string | null;
}

export interface ReadwiseStorePullRequest {
  attempted_at?: string;
  /** Durable scheduler checkpoint; never returned from this surface. */
  checkpoint?: string;
  max_items?: number;
  /**
   * Who initiated this run. An operator run is never refused by the Readwise
   * daily request budget (owner ruling 2026-08-19); anything but the exact
   * literal 'operator' fails closed to 'scheduled', and the provider's own
   * refusals bind either way.
   */
  provenance?: SourceInvocationProvenance;
}

export interface ReadwiseStoreReconcileRequest {
  attempted_at?: string;
  /** Same contract as ReadwiseStorePullRequest.provenance. */
  provenance?: SourceInvocationProvenance;
}

export interface ReadwiseConnectorStoreSyncHandler {
  sync(): Promise<ReadwiseConnectorStoreSyncResult>;
  pull(request?: ReadwiseStorePullRequest): Promise<ReadwiseConnectorStoreTaskOutcome>;
  reconcile(request?: ReadwiseStoreReconcileRequest): Promise<ReadwiseConnectorStoreTaskOutcome>;
  lastStoreRunCompletedAt(): string | undefined;
  requestBudgetStatus(): ReadwiseRequestBudgetStatus;
}

export interface ReadwiseConnectorStoreSyncHandlerOptions {
  store: LocalConnectorStore;
  embeddingProvider: SourceEmbeddingProvider;
  /** Required: the one runtime day counter shared with every connector it builds. */
  requestBudget: ReadwiseDailyRequestBudget;
  account?: string;
  credentialBroker?: CredentialBroker;
  credentialHandle?: string;
  fetch?: ReadwiseApiClientOptions['fetch'];
  apiV2BaseUrl?: string;
  readerApiV3BaseUrl?: string;
  timeoutMs?: number;
  pageSize?: number;
  config?: ReadwiseLiveSyncConfig;
  env?: Record<string, string | undefined>;
  now?: () => Date;
}

export function createReadwiseConnectorStoreSyncHandler(
  options: ReadwiseConnectorStoreSyncHandlerOptions,
): ReadwiseConnectorStoreSyncHandler {
  const env = options.env ?? process.env;
  const config = options.config ?? defaultReadwiseLiveSyncConfig(env);
  const account = options.account?.trim() || 'personal';
  const requestBudget = options.requestBudget;
  // Provenance is an argument, never a handler field: the handler is built once
  // for the process and serves both scheduled ticks and operator runs, so an
  // exemption stored on it would outlive the run that earned it.
  const buildConnector = (provenance?: SourceInvocationProvenance) => createReadwiseSourceConnector({
    ...(options.account ? { account: options.account } : {}),
    ...(options.credentialBroker ? { credentialBroker: options.credentialBroker } : {}),
    ...(options.credentialHandle ? { credentialHandle: options.credentialHandle } : {}),
    ...(options.fetch ? { fetch: options.fetch } : {}),
    ...(options.apiV2BaseUrl ? { apiV2BaseUrl: options.apiV2BaseUrl } : {}),
    ...(options.readerApiV3BaseUrl ? { readerApiV3BaseUrl: options.readerApiV3BaseUrl } : {}),
    ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}),
    ...(options.pageSize ? { pageSize: options.pageSize } : {}),
    requestBudget,
    provenance: sourceInvocationProvenance(provenance),
    env,
    ...(options.now ? { now: options.now } : {}),
  });

  return {
    async sync(): Promise<ReadwiseConnectorStoreSyncResult> {
      const connector = buildConnector();
      const run = await syncAndEmbedFromConnector({
        store: options.store,
        connector,
        embeddingProvider: options.embeddingProvider,
        sync: {
          fetchContent: true,
        },
      });
      const usage = connector.requestBudgetStatus();
      const changed = run.sync.itemsIndexed > 0
        || run.sync.itemsTombstoned > 0
        || run.embed.chunksEmbedded > 0;
      return {
        status: changed ? 'progress' : 'idle',
        counts: {
          api_requests: usage.requests,
          daily_api_request_budget: usage.dailyRequestBudget,
          items_seen: run.sync.itemsSeen,
          items_indexed: run.sync.itemsIndexed,
          items_tombstoned: run.sync.itemsTombstoned,
          chunks_indexed: run.sync.chunksIndexed,
          chunks_embedded: run.embed.chunksEmbedded,
        },
        api_usage: {
          utc_day: usage.utcDay,
        },
        policy: {
          counts_only: true,
          raw_source_exposed: false,
          source_text_returned: false,
          provider_cursor_exposed: false,
        },
      };
    },

    async pull(
      request: ReadwiseStorePullRequest = {},
    ): Promise<ReadwiseConnectorStoreTaskOutcome> {
      const maxItems = boundedMaxItems(request.max_items, config.storePullMaxItems);
      const warnings: string[] = [];
      // This connector's own last COMPLETED run is the freshest durable
      // traversal position: it is written after every run, including a run the
      // budget guard cut short. The scheduler checkpoint covers the case where
      // the last run was an uncursored reconcile (which stores no cursor).
      const candidate = options.store.lastCompletedSyncRun(READWISE_CONNECTOR_ID)?.cursor
        ?? request.checkpoint?.trim()
        ?? undefined;
      let resume = isReadwiseConnectorCursor(candidate) ? candidate : undefined;
      if (candidate !== undefined && resume === undefined) {
        warnings.push(READWISE_RESUME_REJECTED_WARNING);
      }

      const provenance = sourceInvocationProvenance(request.provenance);
      let connector = buildConnector(provenance);
      let run: ConnectorStoreSyncAndEmbedSummary;
      try {
        run = await syncAndEmbedFromConnector({
          store: options.store,
          connector,
          embeddingProvider: options.embeddingProvider,
          sync: {
            fetchContent: true,
            maxItems,
            ...(resume ? { cursor: resume } : {}),
          },
        });
      } catch (error) {
        // Cursor validity across days is unverified provider behavior. A
        // provider that rejects the resume point must not park the lane: drop
        // the checkpoint and traverse fresh, with a counts-only warning.
        if (resume === undefined || !isRejectedCursorError(error)) throw error;
        warnings.push(READWISE_RESUME_REJECTED_WARNING);
        resume = undefined;
        connector = buildConnector(provenance);
        run = await syncAndEmbedFromConnector({
          store: options.store,
          connector,
          embeddingProvider: options.embeddingProvider,
          sync: {
            fetchContent: true,
            maxItems,
          },
        });
      }

      return taskOutcome({
        kind: READWISE_STORE_PULL_RECEIPT_KIND,
        run,
        usage: connector.requestBudgetStatus(),
        resumed: resume !== undefined,
        warnings,
      });
    },

    async reconcile(
      request: ReadwiseStoreReconcileRequest = {},
    ): Promise<ReadwiseConnectorStoreTaskOutcome> {
      const connector = buildConnector(sourceInvocationProvenance(request.provenance));
      // Deliberately un-cursored and un-bounded: the shared spine only treats a
      // traversal as a full snapshot when neither a cursor nor a maxItems bound
      // was supplied and it reached a done page.
      const run = await syncAndEmbedFromConnector({
        store: options.store,
        connector,
        embeddingProvider: options.embeddingProvider,
        sync: {
          fetchContent: true,
          reconcileFullSnapshot: true,
          reconcileFullSnapshotScope: { provider: READWISE_PROVIDER, accountScope: account },
          // Weakest honest authority: Readwise export deletion semantics are
          // unverified, so absence is never evidence of removal and nothing is
          // tombstoned. Upgrading this is a later tranche with its own proof.
          reconcileAbsenceAuthority: 'partial_window',
        },
      });
      return taskOutcome({
        kind: READWISE_STORE_RECONCILE_RECEIPT_KIND,
        run,
        usage: connector.requestBudgetStatus(),
        resumed: false,
        warnings: [],
      });
    },

    lastStoreRunCompletedAt: () => options.store.status().lastSyncRun?.completedAt,
    requestBudgetStatus: () => requestBudget.status(),
  };
}

function taskOutcome(input: {
  kind: ReadwiseConnectorStoreReceipt['kind'];
  run: ConnectorStoreSyncAndEmbedSummary;
  usage: ReadwiseRequestBudgetStatus;
  resumed: boolean;
  warnings: string[];
}): ReadwiseConnectorStoreTaskOutcome {
  const checkpoint = input.run.sync.cursor ?? null;
  const changed = input.run.sync.itemsIndexed > 0
    || input.run.sync.itemsTombstoned > 0
    || input.run.embed.chunksEmbedded > 0;
  const warnings = [...new Set(input.warnings)];
  const receipt: Omit<ReadwiseConnectorStoreReceipt, 'receipt_sha256'> = {
    kind: input.kind,
    status: changed ? 'progress' : 'idle',
    counts: {
      api_requests: input.usage.requests,
      daily_api_request_budget: input.usage.dailyRequestBudget,
      items_seen: input.run.sync.itemsSeen,
      items_indexed: input.run.sync.itemsIndexed,
      items_changed: input.run.sync.itemsChanged,
      items_tombstoned: input.run.sync.itemsTombstoned,
      items_rejected: input.run.sync.itemsRejected,
      chunks_indexed: input.run.sync.chunksIndexed,
      chunks_embedded: input.run.embed.chunksEmbedded,
      resumed_from_checkpoint: Number(input.resumed),
      resume_cursor_rejected: Number(warnings.includes(READWISE_RESUME_REJECTED_WARNING)),
      // The spine's own record of whether the listing ran out. The cursor
      // cannot answer this: a completed pull still leaves one (the done page
      // publishes the next sweep's watermark), and the reconcile lane clears it
      // by policy, so "checkpoint absent" would read as a complete traversal on
      // exactly the pass whose coverage is least certain.
      traversal_complete: Number(input.run.sync.traversalComplete),
      absence_authoritative: 0,
    },
    api_usage: {
      utc_day: input.usage.utcDay,
    },
    ...(warnings.length > 0 ? { warnings } : {}),
    policy: {
      counts_only: true,
      raw_source_exposed: false,
      source_text_returned: false,
      provider_cursor_exposed: false,
      absence_authority: 'partial_window',
      tombstones_applied: false,
    },
  };
  return {
    receipt: { ...receipt, receipt_sha256: readwiseReceiptDigest(receipt) },
    checkpoint,
  };
}

/**
 * Self-digest over every field the receipt carries except the digest itself.
 * A verifier recomputes it from the receipt alone; nothing private is needed.
 */
export function readwiseReceiptDigest(
  receipt: Omit<ReadwiseConnectorStoreReceipt, 'receipt_sha256'>,
): string {
  return createHash('sha256').update(JSON.stringify(receipt)).digest('hex');
}

function isRejectedCursorError(error: unknown): boolean {
  if (error instanceof TypeError) return /cursor is invalid/i.test(error.message);
  if (!(error instanceof ReadwiseApiError)) return false;
  return error.status !== undefined
    && error.status >= 400
    && error.status < 500
    && error.status !== 401
    && error.status !== 403
    && error.status !== 429;
}

function boundedMaxItems(value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError('Readwise store pull max_items must be a positive integer.');
  }
  return Math.min(value, fallback);
}
