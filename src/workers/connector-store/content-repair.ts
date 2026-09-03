// Source-neutral repair for connector-store items whose provider metadata
// reached the shared spine without searchable content.
//
// The repair capability deliberately owns no ingestion mechanics. It selects
// bounded zero-chunk candidates through LocalConnectorStore's public paging
// seam, asks the supplied Contract 1 connector for each current item, then
// replays that RawItem through syncAndEmbedFromConnector. Classification,
// trust routing, exclusions, chunking, FTS, and embeddings therefore remain
// the ordinary sync path's decisions.
//
// Terminal state lives in a small sidecar rather than schema-v9 connector
// stores. Only a SHA-256 item key, one categorical outcome, and timestamps are
// durable. No source id, subject, address, path, locator, or text is stored.

import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { Database } from 'bun:sqlite';
import type {
  RawItem,
  SourceConnector,
  SourceConnectorListPage,
} from '../../core/contracts.ts';
import { closeSqliteStore } from '../../core/sqlite-store.ts';
import type { SourceEmbeddingProvider } from '../source-index/embeddings.ts';
import {
  LocalConnectorStore,
  syncAndEmbedFromConnector,
  type ConnectorStoreClassificationOptions,
  type ConnectorStoreExtractionCandidate,
} from './local-index.ts';

const CONTENT_REPAIR_STATE_VERSION = 1;

export type ConnectorStoreContentRepairTerminalState =
  | 'repaired'
  | 'still_bodyless'
  | 'unavailable';

export interface ConnectorStoreContentRepairOptions {
  store: LocalConnectorStore;
  connector: SourceConnector;
  /** Separate sidecar; the frozen connector-store schema is never extended. */
  statePath: string;
  /** Maximum candidates examined and provider fetches attempted in this run. */
  limit: number;
  /** Defaults true. A dry run selects only and performs no provider call. */
  dryRun?: boolean;
  /** Required for an applied run so repaired chunks leave fully embedded. */
  embeddingProvider?: SourceEmbeddingProvider;
  /** The same shared classification policy an ordinary sync uses, when any. */
  classification?: ConnectorStoreClassificationOptions;
  /**
   * Cumulative request count from the connector's existing budget.
   *
   * Supplying this makes retrying connectors report every network attempt,
   * rather than merely counting one fetchItem invocation.
   */
  providerRequestCount?: () => number;
  /** Connector-owned typed budget refusal predicate; keeps this module source-neutral. */
  isBudgetRefusal?: (error: unknown) => boolean;
  maxChunkChars?: number;
}

export interface ConnectorStoreContentRepairReceipt {
  kind: 'connector_store_content_repair';
  corpus_id: string;
  dry_run: boolean;
  limit: number;
  stop_reason: 'completed' | 'budget_refused';
  counts: {
    selected: number;
    repaired: number;
    still_bodyless: number;
    unavailable: number;
    provider_requests_spent: number;
    /**
     * Selected candidates not completed in this run. On budget refusal this
     * is the exact resumable tail; in dry-run it equals selected.
     */
    remaining: number;
  };
  policy: {
    counts_only: true;
    source_text_returned: false;
  };
}

export async function repairConnectorStoreContent(
  options: ConnectorStoreContentRepairOptions,
): Promise<ConnectorStoreContentRepairReceipt> {
  const limit = positiveInteger(options.limit, 'Content repair limit');
  const dryRun = options.dryRun !== false;
  if (options.connector.family !== options.store.family) {
    throw new Error('Content repair connector family does not match the connector store.');
  }
  if (!dryRun && !options.embeddingProvider) {
    throw new Error('Applied content repair requires an embedding provider.');
  }

  const state = new ContentRepairState(options.statePath, options.store.corpusId);
  try {
    const page = state.selectPage(options.store, limit);
    const candidates = page.candidates.filter((candidate) => (
      !state.isSettled(itemKey(options.store.corpusId, candidate))
    ));
    const counts = {
      selected: candidates.length,
      repaired: 0,
      still_bodyless: 0,
      unavailable: 0,
      provider_requests_spent: 0,
      remaining: candidates.length,
    };

    if (dryRun) {
      return receipt(options.store.corpusId, true, limit, 'completed', counts);
    }
    if (candidates.length === 0) {
      // Terminal body-less/unavailable items never gain chunks, so they stay
      // candidates forever. A page consumed entirely by them still has to move
      // the scan, or the sweep re-reads that settled prefix on every later run
      // and never reaches items behind it.
      state.advance(page);
      return receipt(options.store.corpusId, false, limit, 'completed', counts);
    }

    const embeddingProvider = options.embeddingProvider!;
    await options.connector.authenticate();
    const requestsBefore = requestCount(options.providerRequestCount);
    let fetchInvocationsSpent = 0;
    let stopReason: ConnectorStoreContentRepairReceipt['stop_reason'] = 'completed';

    for (const candidate of candidates) {
      let fetched: RawItem;
      try {
        fetched = await options.connector.fetchItem(candidate.identity.localItemId);
        fetchInvocationsSpent += 1;
      } catch (error) {
        if (options.isBudgetRefusal?.(error) === true) {
          stopReason = 'budget_refused';
          break;
        }
        fetchInvocationsSpent += 1;
        state.settle(itemKey(options.store.corpusId, candidate), 'unavailable');
        counts.unavailable += 1;
        counts.remaining -= 1;
        continue;
      }

      const run = await syncAndEmbedFromConnector({
        store: options.store,
        connector: singleItemConnector(options.connector, fetched),
        embeddingProvider,
        sync: {
          fetchContent: true,
          maxItems: 1,
          // A by-id refetch proves the item still serves content, not that the
          // provider still lists it; a listing claim here would shield the item
          // from the window-removal fences.
          ownerObservation: 'local_write',
          ...(options.classification ? { classification: options.classification } : {}),
          ...(options.maxChunkChars !== undefined
            ? { maxChunkChars: options.maxChunkChars }
            : {}),
        },
      });

      let terminal: ConnectorStoreContentRepairTerminalState;
      if (run.sync.itemsRejected > 0 || run.sync.itemsIndexed !== 1) {
        // Provider content that belongs to another trust domain is unavailable
        // to THIS store. The ordinary sync path made the routing decision and
        // wrote no content here; the matching store's own repair pass may take
        // the item independently.
        terminal = 'unavailable';
      } else if (rawItemIsBodyless(fetched)) {
        terminal = 'still_bodyless';
      } else {
        const coverage = options.store.currentItemRepresentationCoverage(
          fetched.identity,
          embeddingProvider.modelId,
        );
        // A non-text payload that the ordinary ingest path cannot represent is
        // not mislabeled body-less. It is terminally unavailable to this
        // capability and remains visible as such in the categorical receipt.
        terminal = coverage.representationComplete && coverage.embeddingsComplete
          ? 'repaired'
          : 'unavailable';
      }

      state.settle(itemKey(options.store.corpusId, candidate), terminal);
      counts[terminal] += 1;
      counts.remaining -= 1;
    }

    const requestsAfter = requestCount(options.providerRequestCount);
    counts.provider_requests_spent = requestsBefore !== undefined && requestsAfter !== undefined
      ? Math.max(0, requestsAfter - requestsBefore)
      : fetchInvocationsSpent;

    // A refused fetch did not consume the page. Keep the old scan cursor so a
    // repeat re-reads the exact page, skips its newly settled prefix by hash,
    // and resumes at the refusal. Fully processed pages advance atomically.
    if (stopReason === 'completed') state.advance(page);

    return receipt(options.store.corpusId, false, limit, stopReason, counts);
  } finally {
    state.close();
  }
}

function singleItemConnector(
  connector: SourceConnector,
  item: RawItem,
): SourceConnector {
  return {
    // Repair runs must never overwrite the live connector's traversal
    // checkpoint. A distinct generic owner id keeps the one-item replay in the
    // same ingest machinery without becoming the head sync's latest run.
    id: `${connector.id}.content_repair`,
    family: connector.family,
    async authenticate(): Promise<void> {},
    listItems(): AsyncIterable<SourceConnectorListPage> {
      return (async function* (): AsyncGenerator<SourceConnectorListPage> {
        yield { items: [item], done: true };
      })();
    },
    // The provider was already asked immediately before this replay. Normal
    // sync may call fetchItem once more for a metadata-only RawItem; serving
    // the same authoritative response from this one-item cache preserves the
    // ordinary path without double-spending the provider budget.
    async fetchItem(localItemId): Promise<RawItem> {
      if (localItemId !== item.identity.localItemId) {
        throw new Error('Content repair replay requested an item outside its bounded selection.');
      }
      return item;
    },
    classify: (rawItem) => connector.classify(rawItem),
  };
}

function rawItemIsBodyless(item: RawItem): boolean {
  if (item.content.kind === 'metadata_only') return true;
  if (item.content.kind === 'text') return item.content.text.trim() === '';
  return item.content.bytes.byteLength === 0;
}

function requestCount(read: (() => number) | undefined): number | undefined {
  if (!read) return undefined;
  const value = read();
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError('Provider request count must be a non-negative integer.');
  }
  return value;
}

function itemKey(
  corpusId: string,
  candidate: ConnectorStoreExtractionCandidate,
): string {
  const identity = candidate.identity;
  return createHash('sha256').update(JSON.stringify([
    corpusId,
    identity.family,
    identity.provider,
    identity.accountScope,
    identity.providerItemId,
    identity.providerConversationId ?? null,
  ])).digest('hex');
}

function corpusKey(corpusId: string): string {
  return createHash('sha256').update(corpusId).digest('hex');
}

function receipt(
  corpusId: string,
  dryRun: boolean,
  limit: number,
  stopReason: ConnectorStoreContentRepairReceipt['stop_reason'],
  counts: ConnectorStoreContentRepairReceipt['counts'],
): ConnectorStoreContentRepairReceipt {
  return {
    kind: 'connector_store_content_repair',
    corpus_id: corpusId,
    dry_run: dryRun,
    limit,
    stop_reason: stopReason,
    counts,
    policy: {
      counts_only: true,
      source_text_returned: false,
    },
  };
}

interface SelectedCandidatePage {
  candidates: readonly ConnectorStoreExtractionCandidate[];
  nextCursor?: string;
  done: boolean;
}

class ContentRepairState {
  private readonly db: Database;
  private readonly progressKey: string;

  constructor(statePathValue: string, corpusId: string) {
    const statePath = statePathValue.trim();
    if (!statePath) throw new TypeError('Content repair state path must be non-empty.');
    mkdirSync(dirname(statePath), { recursive: true, mode: 0o700 });
    this.db = new Database(statePath, { create: true, strict: true });
    this.progressKey = corpusKey(corpusId);
    try {
      this.db.exec(`
        PRAGMA busy_timeout = 10000;
        PRAGMA journal_mode = WAL;
        CREATE TABLE IF NOT EXISTS content_repair_meta (
          singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
          version INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS content_repair_settlements (
          item_key_sha256 TEXT PRIMARY KEY CHECK (
            length(item_key_sha256) = 64
            AND item_key_sha256 NOT GLOB '*[^a-f0-9]*'
          ),
          terminal_state TEXT NOT NULL CHECK (
            terminal_state IN ('repaired', 'still_bodyless', 'unavailable')
          ),
          settled_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS content_repair_progress (
          corpus_key_sha256 TEXT PRIMARY KEY CHECK (
            length(corpus_key_sha256) = 64
            AND corpus_key_sha256 NOT GLOB '*[^a-f0-9]*'
          ),
          scan_cursor TEXT,
          updated_at TEXT NOT NULL
        );
      `);
      const meta = this.db.query(
        'SELECT version FROM content_repair_meta WHERE singleton = 1',
      ).get() as { version: number } | null;
      if (meta && meta.version !== CONTENT_REPAIR_STATE_VERSION) {
        throw new Error('Content repair state version is unsupported.');
      }
      if (!meta) {
        this.db.query(
          'INSERT INTO content_repair_meta (singleton, version) VALUES (1, ?)',
        ).run(CONTENT_REPAIR_STATE_VERSION);
      }
      chmodSync(statePath, 0o600);
    } catch (error) {
      closeSqliteStore(this.db);
      throw error;
    }
  }

  close(): void {
    closeSqliteStore(this.db);
  }

  isSettled(key: string): boolean {
    return this.db.query(
      'SELECT 1 AS present FROM content_repair_settlements WHERE item_key_sha256 = ?',
    ).get(key) !== null;
  }

  settle(key: string, terminalState: ConnectorStoreContentRepairTerminalState): void {
    this.db.query(`
      INSERT INTO content_repair_settlements (
        item_key_sha256, terminal_state, settled_at
      ) VALUES (?, ?, ?)
      ON CONFLICT(item_key_sha256) DO UPDATE SET
        terminal_state = excluded.terminal_state,
        settled_at = excluded.settled_at
    `).run(key, terminalState, new Date().toISOString());
  }

  selectPage(store: LocalConnectorStore, limit: number): SelectedCandidatePage {
    const row = this.db.query(
      'SELECT scan_cursor FROM content_repair_progress WHERE corpus_key_sha256 = ?',
    ).get(this.progressKey) as { scan_cursor: string | null } | null;
    return store.extractionCandidates({
      limit,
      ...(row?.scan_cursor ? { cursor: row.scan_cursor } : {}),
      withoutChunksOnly: true,
    });
  }

  advance(page: SelectedCandidatePage): void {
    if (page.done || !page.nextCursor) {
      this.db.query(
        'DELETE FROM content_repair_progress WHERE corpus_key_sha256 = ?',
      ).run(this.progressKey);
      return;
    }
    this.db.query(`
      INSERT INTO content_repair_progress (
        corpus_key_sha256, scan_cursor, updated_at
      ) VALUES (?, ?, ?)
      ON CONFLICT(corpus_key_sha256) DO UPDATE SET
        scan_cursor = excluded.scan_cursor,
        updated_at = excluded.updated_at
    `).run(this.progressKey, page.nextCursor, new Date().toISOString());
  }
}

function positiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError(`${label} must be a positive integer.`);
  }
  return value;
}
