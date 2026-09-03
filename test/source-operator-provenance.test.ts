// Operator-initiated runs of the gmail / google-drive / readwise lanes are
// never refused by those lanes' OWN daily request budgets (owner ruling
// 2026-08-19: budgets gate ROUTINE operations only), while every other
// property of those guards is unchanged.
//
// Four claims are pinned per lane, because three of them are the ways this
// exemption could be quietly wrong rather than absent:
//
//  1. An operator run proceeds where a scheduled run was refused.
//  2. Its real usage still lands in the day ledger UNCLAMPED, so the next
//     SCHEDULED run is guarded against what the operator actually spent. An
//     exemption that skipped the count would read as "generous" and would in
//     fact hand the provider an unbounded day.
//  3. A provider-owned refusal (a real 429) binds an operator run too: the
//     waiver is of Olympus's constraint, never of the provider's.
//  4. Anything that is not the exact literal 'operator' fails closed to
//     scheduled.
//
// The scheduler leg is pinned separately: a scheduled task context must reach
// each handler byte-identical to what it received before provenance existed
// (R62 finding 2), and only an operator tick may carry the marker.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'bun:test';
import type { SourceInvocationProvenance } from '../src/core/invocation-provenance.ts';
import { LocalConnectorStore } from '../src/workers/connector-store/index.ts';
import { StaticCredentialBroker } from '../src/workers/credential-broker/index.ts';
import type { CredentialBroker } from '../src/workers/credential-broker/index.ts';
import {
  GMAIL_INTERNAL_CONNECTOR_CORPUS_ID,
  GMAIL_SECURE_CONNECTOR_CORPUS_ID,
  GOOGLE_DRIVE_INTERNAL_CONNECTOR_CORPUS_ID,
  GOOGLE_DRIVE_SECURE_CONNECTOR_CORPUS_ID,
  GoogleDailyRequestBudget,
  GoogleGmailSourceConnector,
  GoogleRequestBudgetError,
  createGmailConnectorStoreSyncHandler,
  createGmailDailyRequestBudget,
  createGoogleDriveConnectorStoreSyncHandler,
  createGoogleDriveDailyRequestBudget,
  type GmailApiClient,
  type GmailConnectorStoreSyncHandler,
  type GoogleDriveApiClient,
  type GoogleDriveConnectorStoreSyncHandler,
} from '../src/workers/google-connectors/index.ts';
import type {
  GmailListMessagesRequest,
  GmailMessage,
} from '../src/workers/google-connectors/gmail.ts';
import type {
  GmailStorePullRequest,
  GmailStoreReconcileRequest,
} from '../src/workers/google-connectors/gmail-live-sync.ts';
import {
  createRestGoogleDriveApiClient,
  type GoogleDriveFile,
  type GoogleDriveListFilesRequest,
} from '../src/workers/google-connectors/drive.ts';
import type {
  GoogleDriveStorePullRequest,
  GoogleDriveStoreReconcileRequest,
} from '../src/workers/google-connectors/drive-live-sync.ts';
import {
  READWISE_LIBRARY_CORPUS_ID,
  ReadwiseApiError,
  ReadwiseDailyRequestBudget,
  ReadwiseRequestBudgetError,
  createReadwiseConnectorStore,
  createReadwiseConnectorStoreSyncHandler,
  type ReadwiseConnectorStoreSyncHandler,
  type ReadwiseFetch,
  type ReadwiseStorePullRequest,
  type ReadwiseStoreReconcileRequest,
} from '../src/workers/readwise/index.ts';
import {
  SCHEDULER_SOURCE_IDS,
  SourceScheduler,
  createGmailConnectorStoreSchedulerSource,
  createGoogleDriveConnectorStoreSchedulerSource,
  createReadwiseSchedulerSource,
} from '../src/workers/source-scheduler.ts';
import { LocalSourceSchedulerStateStore } from '../src/workers/source-scheduler-state.ts';
import type { SourceEmbeddingProvider } from '../src/workers/source-index/embeddings.ts';
import type { OlympusConfig } from '../src/core/config.ts';

const DAY_START = new Date('2026-08-19T09:00:00.000Z');
/** Not the union member: the point is that a near-miss is refused. */
const NOT_OPERATOR = 'Operator' as unknown as SourceInvocationProvenance;

const openStores: LocalConnectorStore[] = [];
const tempDirs: string[] = [];

afterEach(() => {
  while (openStores.length > 0) openStores.pop()!.close();
  while (tempDirs.length > 0) rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

describe('Gmail lane: an operator run is never refused by the daily request budget', () => {
  test('operator proceeds past a line that refused scheduled, and the ledger keeps the true spend', async () => {
    const budget = gmailBudget(2);
    const client = fakeGmailClient(gmailMessages(3));
    const lane = gmailLane({ client, maxMessages: 10, budget });

    // Scheduled: the day's two requests are spent inside the traversal and the
    // third is refused mid-run.
    await expect(lane.handler.pull({ max_items: 10 })).rejects.toThrow(GoogleRequestBudgetError);
    expect(budget.status().requests).toBe(2);

    // A second scheduled run is refused BEFORE any provider request, which is
    // the behavior the exemption must leave untouched.
    const spentBefore = client.listCalls + client.getCalls.length;
    await expect(lane.handler.pull({ max_items: 10 })).rejects.toThrow(GoogleRequestBudgetError);
    expect(client.listCalls + client.getCalls.length).toBe(spentBefore);

    // Operator: the same run, admitted.
    const operator = await lane.handler.pull({ max_items: 10, provenance: 'operator' });
    expect(operator.receipt.counts.items_seen).toBe(3);
    expect(operator.receipt.counts.internal_items_indexed).toBe(3);

    // One list plus one get per message, all of it counted past the daily line.
    // Clamping here would under-report the day and admit the next scheduled run
    // against spend that already happened.
    expect(budget.status().requests).toBe(2 + 4);
    expect(operator.receipt.counts.api_requests).toBe(6);

    // And the next scheduled run is still guarded — now against the operator's
    // real spend, not against the line it was admitted past.
    await expect(lane.handler.pull({ max_items: 10 })).rejects.toThrow(GoogleRequestBudgetError);
    expect(budget.status().requests).toBe(6);
  });

  test('a reconcile carries the same exemption, and an unknown provenance fails closed', async () => {
    const budget = gmailBudget(1);
    const client = fakeGmailClient(gmailMessages(2));
    const lane = gmailLane({ client, maxMessages: 10, budget });

    await expect(lane.handler.reconcile()).rejects.toThrow(GoogleRequestBudgetError);
    // A near-miss label is not an exemption: only the exact literal counts.
    await expect(lane.handler.reconcile({ provenance: NOT_OPERATOR }))
      .rejects.toThrow(GoogleRequestBudgetError);
    await expect(lane.handler.pull({ max_items: 10, provenance: NOT_OPERATOR }))
      .rejects.toThrow(GoogleRequestBudgetError);

    const reconciled = await lane.handler.reconcile({ provenance: 'operator' });
    expect(reconciled.receipt.counts.items_seen).toBe(2);
  });

  test("Gmail's own rate limit refuses an operator run, and the attempt is still counted", async () => {
    const budget = gmailBudget(50);
    let requests = 0;
    const connector = new GoogleGmailSourceConnector({
      credentialBroker: gmailBroker(),
      credentialHandle: 'gmail.personal',
      account: 'personal',
      requestBudget: budget,
      provenance: 'operator',
      // No retries: the first 429 is the provider's answer.
      maxRetries: 0,
      fetch: async () => {
        requests += 1;
        return new Response('rate limited', { status: 429 });
      },
      env: {},
    });

    await expect(drain(connector.listItems())).rejects.toThrow(/Gmail API request failed \(429\)/);
    expect(requests).toBe(1);
    // The exemption waives Olympus's daily line, never the provider's refusal —
    // and the request the provider did receive is still on the ledger.
    expect(budget.status().requests).toBe(1);
  });
});

describe('Google Drive lane: an operator run is never refused by the daily request budget', () => {
  test('operator proceeds past a line that refused scheduled, and the ledger keeps the true spend', async () => {
    const budget = driveBudget(2);
    const client = fakeDriveClient(driveFiles(3));
    const lane = driveLane({ client, maxFiles: 10, budget });

    await expect(lane.handler.pull({ max_items: 10 })).rejects.toThrow(GoogleRequestBudgetError);
    expect(budget.status().requests).toBe(2);

    const spentBefore = client.listCalls + client.contentCalls.length;
    await expect(lane.handler.pull({ max_items: 10 })).rejects.toThrow(GoogleRequestBudgetError);
    expect(client.listCalls + client.contentCalls.length).toBe(spentBefore);

    const operator = await lane.handler.pull({ max_items: 10, provenance: 'operator' });
    expect(operator.receipt.counts.items_seen).toBe(3);
    expect(operator.receipt.counts.internal_items_indexed).toBe(3);

    // One list plus one content read per file, recorded unclamped.
    expect(budget.status().requests).toBe(2 + 4);
    expect(operator.receipt.counts.api_requests).toBe(6);

    await expect(lane.handler.pull({ max_items: 10 })).rejects.toThrow(GoogleRequestBudgetError);
    expect(budget.status().requests).toBe(6);
  });

  test('a reconcile carries the same exemption, and an unknown provenance fails closed', async () => {
    const budget = driveBudget(1);
    const client = fakeDriveClient(driveFiles(2));
    const lane = driveLane({ client, maxFiles: 10, budget });

    await expect(lane.handler.reconcile()).rejects.toThrow(GoogleRequestBudgetError);
    await expect(lane.handler.reconcile({ provenance: NOT_OPERATOR }))
      .rejects.toThrow(GoogleRequestBudgetError);
    await expect(lane.handler.pull({ max_items: 10, provenance: NOT_OPERATOR }))
      .rejects.toThrow(GoogleRequestBudgetError);

    const reconciled = await lane.handler.reconcile({ provenance: 'operator' });
    expect(reconciled.receipt.counts.items_seen).toBe(2);
  });

  test("Drive's own rate limit refuses an operator run, and the attempt is still counted", async () => {
    const budget = driveBudget(50);
    let requests = 0;
    const client = createRestGoogleDriveApiClient({
      token: 'drive-test-token',
      requestBudget: budget,
      provenance: 'operator',
      maxRetries: 0,
      fetch: async () => {
        requests += 1;
        return new Response('rate limited', { status: 429 });
      },
    });

    await expect(client.listFiles({ pageSize: 10 }))
      .rejects.toThrow(/Google Drive API request failed \(429\)/);
    expect(requests).toBe(1);
    expect(budget.status().requests).toBe(1);
  });
});

describe('Readwise lane: an operator run is never refused by the daily request budget', () => {
  test('operator proceeds past a line that refused scheduled, and the ledger keeps the true spend', async () => {
    const budget = new ReadwiseDailyRequestBudget({
      dailyRequestBudget: 1,
      now: () => DAY_START,
    });
    const harness = readwiseHarness({ requestBudget: budget });
    try {
      // Scheduled: the day's single request is spent here.
      const first = await harness.handler.pull({ max_items: 2 });
      expect(first.receipt.counts.items_seen).toBe(2);
      expect(budget.status().requests).toBe(1);

      // Scheduled again: refused before the provider is touched.
      await expect(harness.handler.pull({ max_items: 2 }))
        .rejects.toThrow(ReadwiseRequestBudgetError);
      expect(harness.calls).toHaveLength(1);

      // Resumes from the stored cursor and reads the next bounded slice.
      const operator = await harness.handler.pull({ max_items: 2, provenance: 'operator' });
      expect(operator.receipt.counts.items_seen).toBe(2);
      expect(operator.receipt.counts.resumed_from_checkpoint).toBe(1);
      expect(harness.calls).toHaveLength(2);
      // Recorded past the line rather than clamped to it.
      expect(budget.status().requests).toBe(2);

      // The following scheduled run is still guarded.
      await expect(harness.handler.pull({ max_items: 2 }))
        .rejects.toThrow(ReadwiseRequestBudgetError);
      expect(harness.calls).toHaveLength(2);
      expect(budget.status().requests).toBe(2);
    } finally {
      harness.close();
    }
  });

  test('a reconcile carries the same exemption, and an unknown provenance fails closed', async () => {
    const budget = new ReadwiseDailyRequestBudget({
      dailyRequestBudget: 1,
      now: () => DAY_START,
    });
    const harness = readwiseHarness({ requestBudget: budget });
    try {
      await harness.handler.pull({ max_items: 2 });
      await expect(harness.handler.reconcile()).rejects.toThrow(ReadwiseRequestBudgetError);
      await expect(harness.handler.reconcile({ provenance: NOT_OPERATOR }))
        .rejects.toThrow(ReadwiseRequestBudgetError);
      await expect(harness.handler.pull({ max_items: 2, provenance: NOT_OPERATOR }))
        .rejects.toThrow(ReadwiseRequestBudgetError);

      const reconciled = await harness.handler.reconcile({ provenance: 'operator' });
      expect(reconciled.receipt.counts.items_seen).toBe(7);
    } finally {
      harness.close();
    }
  });

  test("Readwise's own refusal binds an operator run, and the attempt is still counted", async () => {
    const budget = new ReadwiseDailyRequestBudget({
      dailyRequestBudget: 50,
      now: () => DAY_START,
    });
    let requests = 0;
    const harness = readwiseHarness({
      requestBudget: budget,
      fetch: async () => {
        requests += 1;
        return new Response('rate limited', { status: 429 });
      },
    });
    try {
      await expect(harness.handler.pull({ max_items: 2, provenance: 'operator' }))
        .rejects.toThrow(ReadwiseApiError);
      expect(requests).toBe(1);
      expect(budget.status().requests).toBe(1);
    } finally {
      harness.close();
    }
  });
});

describe('Scheduler: only an operator tick marks itself, on every budgeted lane', () => {
  test('Gmail scheduled requests stay byte-identical and an operator run is labelled', async () => {
    const seen: Array<GmailStorePullRequest | GmailStoreReconcileRequest> = [];
    const scheduledRuns = await runBothProvenances(
      SCHEDULER_SOURCE_IDS.gmail,
      createGmailConnectorStoreSchedulerSource({
        config: schedulerConfig(),
        sync: gmailRecordingHandler(seen),
      })!,
      seen,
    );

    expectProvenanceMarkers(seen, scheduledRuns);
  });

  test('Drive scheduled requests stay byte-identical and an operator run is labelled', async () => {
    const seen: Array<GoogleDriveStorePullRequest | GoogleDriveStoreReconcileRequest> = [];
    const scheduledRuns = await runBothProvenances(
      SCHEDULER_SOURCE_IDS.googleDrive,
      createGoogleDriveConnectorStoreSchedulerSource({
        config: schedulerConfig(),
        liveSync: driveRecordingHandler(seen),
      })!,
      seen,
    );

    expectProvenanceMarkers(seen, scheduledRuns);
  });

  test('Readwise scheduled requests stay byte-identical and an operator run is labelled', async () => {
    const seen: Array<ReadwiseStorePullRequest | ReadwiseStoreReconcileRequest> = [];
    const scheduledRuns = await runBothProvenances(
      SCHEDULER_SOURCE_IDS.readwise,
      createReadwiseSchedulerSource({
        config: schedulerConfig(),
        liveSync: readwiseRecordingHandler(seen),
      })!,
      seen,
    );

    expectProvenanceMarkers(seen, scheduledRuns);
  });
});

describe('Daily request budget primitives', () => {
  test('the process-local Google seam exempts operator from the line but never from the count', () => {
    const budget = new GoogleDailyRequestBudget({
      provider: 'Gmail',
      dailyRequestBudget: 1,
      now: () => DAY_START,
    });

    budget.reserve();
    expect(() => budget.reserve()).toThrow(GoogleRequestBudgetError);
    expect(() => budget.reserve(NOT_OPERATOR)).toThrow(GoogleRequestBudgetError);
    expect(budget.status().requests).toBe(1);

    budget.reserve('operator');
    budget.reserve('operator');
    expect(budget.status().requests).toBe(3);
    // Scheduled work is measured against the operator's real spend.
    expect(() => budget.reserve()).toThrow(GoogleRequestBudgetError);
  });

  test('a clock regression refuses every provenance, operator included', () => {
    const clock = { now: new Date('2026-08-19T09:00:00.000Z') };
    const budget = new GoogleDailyRequestBudget({
      provider: 'Gmail',
      dailyRequestBudget: 10,
      now: () => clock.now,
    });
    budget.reserve();
    clock.now = new Date('2026-08-18T09:00:00.000Z');

    // Not a budget: the durable counter cannot be trusted, and an operator
    // exemption from a trust failure would be an exemption from arithmetic.
    let refused: GoogleRequestBudgetError | undefined;
    try {
      budget.reserve('operator');
    } catch (error) {
      refused = error as GoogleRequestBudgetError;
    }
    expect(refused?.reason).toBe('future_utc_day');
  });

  test('the durable Google ledger counts an operator request past the daily line', () => {
    const dir = mkdtempSync(join(tmpdir(), 'olympus-operator-ledger-'));
    tempDirs.push(dir);
    const budget = new GoogleDailyRequestBudget({
      provider: 'Gmail',
      dailyRequestBudget: 1,
      statePath: join(dir, 'gmail-daily-request-budget.sqlite'),
      now: () => DAY_START,
    });

    budget.reserve();
    expect(() => budget.reserve()).toThrow(GoogleRequestBudgetError);
    budget.reserve('operator');
    budget.reserve('operator');

    // Read back through the ledger, not an in-memory field: the durable row is
    // what the next scheduled run in any process will consult.
    expect(budget.status().requests).toBe(3);
  });

  test('the Readwise seam exempts operator from the line but never from the count', () => {
    const budget = new ReadwiseDailyRequestBudget({
      dailyRequestBudget: 1,
      now: () => DAY_START,
    });

    budget.reserve();
    expect(() => budget.reserve()).toThrow(ReadwiseRequestBudgetError);
    expect(() => budget.reserve(NOT_OPERATOR)).toThrow(ReadwiseRequestBudgetError);
    budget.reserve('operator');
    expect(budget.status().requests).toBe(2);
    expect(() => budget.reserve()).toThrow(ReadwiseRequestBudgetError);
  });
});

// --- Scheduler helpers -----------------------------------------------------

/**
 * Runs one cadence tick and then one explicit operator run over the same
 * source, so both provenances are observed against one recording handler.
 */
async function runBothProvenances(
  sourceId: string,
  source: Parameters<typeof buildScheduler>[0],
  seen: readonly unknown[],
): Promise<number> {
  const { scheduler, stateStore } = buildScheduler(source);
  try {
    await scheduler.runDueTasks();
    // Everything recorded up to here was a cadence tick; everything after it
    // was the explicit operator run over the same tasks.
    const scheduledRuns = seen.length;
    await scheduler.runSource(sourceId, undefined, 'operator');
    return scheduledRuns;
  } finally {
    scheduler.stop();
    stateStore.close();
  }
}

function buildScheduler(source: NonNullable<ReturnType<typeof createReadwiseSchedulerSource>>): {
  scheduler: SourceScheduler;
  stateStore: LocalSourceSchedulerStateStore;
} {
  const stateStore = new LocalSourceSchedulerStateStore(':memory:');
  return {
    stateStore,
    scheduler: new SourceScheduler({
      enabled: true,
      tickMs: 60_000,
      errorBackoffMs: 1_000,
      maxTransientRetries: 1,
      now: () => DAY_START,
      stateStore,
      sources: [source],
    }),
  };
}

/**
 * Every scheduled request must be free of the marker — not merely "not
 * operator". An enumerable `provenance: 'scheduled'` would satisfy a
 * not-operator assertion while changing what every task observes (R62).
 */
function expectProvenanceMarkers(
  seen: Array<{ provenance?: unknown }>,
  scheduledRuns: number,
): void {
  // Both store tasks of the lane, once per provenance.
  expect(scheduledRuns).toBe(2);
  expect(seen.length).toBe(4);
  const scheduled = seen.slice(0, scheduledRuns);
  const operator = seen.slice(scheduledRuns);
  expect(scheduled.every((request) => !('provenance' in request))).toBe(true);
  expect(operator.every((request) => request.provenance === 'operator')).toBe(true);
}

function schedulerConfig(): OlympusConfig {
  return {
    worker: {
      scheduler: {
        enabled: true,
        sourceIds: [
          SCHEDULER_SOURCE_IDS.gmail,
          SCHEDULER_SOURCE_IDS.googleDrive,
          SCHEDULER_SOURCE_IDS.readwise,
        ],
        tickSeconds: 1,
        syncIntervalSeconds: 300,
        freshnessThresholdHours: 24,
        errorBackoffSeconds: 30,
        maxTransientRetries: 1,
      },
    },
  } as OlympusConfig;
}

function gmailRecordingHandler(
  seen: Array<GmailStorePullRequest | GmailStoreReconcileRequest>,
): GmailConnectorStoreSyncHandler {
  return {
    sync: async () => { throw new Error('unused'); },
    pull: async (request = {}) => {
      seen.push(request);
      return emptyGmailOutcome();
    },
    reconcile: async (request = {}) => {
      seen.push(request);
      return emptyGmailOutcome();
    },
    lastStoreRunCompletedAt: () => undefined,
    requestBudgetStatus: () => undefined,
  };
}

function driveRecordingHandler(
  seen: Array<GoogleDriveStorePullRequest | GoogleDriveStoreReconcileRequest>,
): GoogleDriveConnectorStoreSyncHandler {
  return {
    sync: async () => { throw new Error('unused'); },
    pull: async (request = {}) => {
      seen.push(request);
      return emptyDriveOutcome();
    },
    reconcile: async (request = {}) => {
      seen.push(request);
      return emptyDriveOutcome();
    },
    lastStoreRunCompletedAt: () => undefined,
    requestBudgetStatus: () => undefined,
  };
}

function readwiseRecordingHandler(
  seen: Array<ReadwiseStorePullRequest | ReadwiseStoreReconcileRequest>,
): ReadwiseConnectorStoreSyncHandler {
  return {
    sync: async () => { throw new Error('unused'); },
    pull: async (request = {}) => {
      seen.push(request);
      return emptyReadwiseOutcome();
    },
    reconcile: async (request = {}) => {
      seen.push(request);
      return emptyReadwiseOutcome();
    },
    lastStoreRunCompletedAt: () => undefined,
    requestBudgetStatus: () => ({
      utcDay: DAY_START.toISOString().slice(0, 10),
      requests: 0,
      dailyRequestBudget: 1_000,
    }),
  };
}

function emptyGmailOutcome(): Awaited<ReturnType<GmailConnectorStoreSyncHandler['pull']>> {
  return {
    receipt: {
      kind: 'gmail_connector_store_pull_receipt',
      status: 'idle',
      counts: {} as never,
      api_usage: { utc_day: DAY_START.toISOString().slice(0, 10) },
      policy: {
        counts_only: true,
        raw_source_exposed: false,
        source_text_returned: false,
        provider_cursor_exposed: false,
        absence_authority: 'partial_window',
        tombstones_applied: false,
      },
      receipt_sha256: 'test',
    },
    checkpoint: null,
  };
}

function emptyDriveOutcome(): Awaited<ReturnType<GoogleDriveConnectorStoreSyncHandler['pull']>> {
  return {
    receipt: {
      kind: 'google_drive_connector_store_pull_receipt',
      status: 'idle',
      counts: {} as never,
      api_usage: { utc_day: DAY_START.toISOString().slice(0, 10) },
      policy: {
        counts_only: true,
        raw_source_exposed: false,
        source_text_returned: false,
        provider_cursor_exposed: false,
        absence_authority: 'partial_window',
        tombstones_applied: false,
      },
      receipt_sha256: 'test',
    },
    checkpoint: null,
  };
}

function emptyReadwiseOutcome(): Awaited<ReturnType<ReadwiseConnectorStoreSyncHandler['pull']>> {
  return {
    receipt: {
      kind: 'readwise_connector_store_pull_receipt',
      status: 'idle',
      counts: {} as never,
      api_usage: { utc_day: DAY_START.toISOString().slice(0, 10) },
      policy: {
        counts_only: true,
        raw_source_exposed: false,
        source_text_returned: false,
        provider_cursor_exposed: false,
        absence_authority: 'partial_window',
        tombstones_applied: false,
      },
      receipt_sha256: 'test',
    },
    checkpoint: null,
  };
}

// --- Gmail helpers ---------------------------------------------------------

function gmailBudget(dailyRequestBudget: number): GoogleDailyRequestBudget {
  const dir = mkdtempSync(join(tmpdir(), 'olympus-gmail-operator-'));
  tempDirs.push(dir);
  // The durable ledger, not the process-local seam: it is the production path
  // and the one whose reservation statement the exemption changes.
  return createGmailDailyRequestBudget({
    env: { OLYMPUS_SOURCE_INDEX_GMAIL_DAILY_API_REQUEST_BUDGET: String(dailyRequestBudget) },
    statePath: join(dir, 'gmail-daily-request-budget.json'),
    now: () => DAY_START,
  });
}

interface CountingGmailApiClient extends GmailApiClient {
  listCalls: number;
  getCalls: string[];
}

function gmailLane(input: {
  client: CountingGmailApiClient;
  maxMessages: number;
  budget: GoogleDailyRequestBudget;
}): { handler: GmailConnectorStoreSyncHandler } {
  const internalStore = new LocalConnectorStore({
    dbPath: ':memory:',
    corpusId: GMAIL_INTERNAL_CONNECTOR_CORPUS_ID,
    family: 'email',
    trustDomain: 'internal',
  });
  const secureStore = new LocalConnectorStore({
    dbPath: ':memory:',
    corpusId: GMAIL_SECURE_CONNECTOR_CORPUS_ID,
    family: 'email',
    trustDomain: 'secure_local',
  });
  openStores.push(internalStore, secureStore);
  const provider = testEmbeddingProvider();
  return {
    handler: createGmailConnectorStoreSyncHandler({
      internalStore,
      secureStore,
      account: 'personal',
      apiClient: input.client,
      maxMessages: input.maxMessages,
      internalEmbeddingProvider: provider,
      secureEmbeddingProvider: provider,
      requestBudget: input.budget,
      env: {},
    }),
  };
}

function fakeGmailClient(messages: GmailMessage[]): CountingGmailApiClient {
  return {
    listCalls: 0,
    getCalls: [],
    async listMessages(request: GmailListMessagesRequest) {
      this.listCalls += 1;
      const offset = request.pageToken ? Number(request.pageToken) : 0;
      const slice = messages.slice(offset, offset + request.maxResults);
      const nextOffset = offset + slice.length;
      return {
        messages: slice.map((message) => ({
          id: message.id,
          ...(message.threadId ? { threadId: message.threadId } : {}),
        })),
        ...(nextOffset < messages.length ? { nextPageToken: String(nextOffset) } : {}),
      };
    },
    async getMessage(id: string) {
      this.getCalls.push(id);
      const message = messages.find((candidate) => candidate.id === id);
      if (!message) throw new Error(`unknown message ${id}`);
      return message;
    },
  };
}

function gmailMessages(count: number): GmailMessage[] {
  return Array.from({ length: count }, (_unused, offset) => {
    const index = offset + 1;
    const internalDateMs = Date.parse('2026-08-01T00:00:00.000Z') + index * 86_400_000;
    return {
      id: `msg-${index}`,
      threadId: `thread-${index}`,
      historyId: `${900_000 + index}`,
      internalDate: String(internalDateMs),
      labelIds: ['INBOX'],
      snippet: `Apollo status ${index}`,
      payload: {
        mimeType: 'text/plain',
        headers: [
          { name: 'Subject', value: `Apollo status ${index}` },
          { name: 'From', value: 'Alex <alex@example.com>' },
          { name: 'To', value: 'Team <team@example.com>' },
          { name: 'Date', value: new Date(internalDateMs).toUTCString() },
        ],
        body: { data: Buffer.from(`Apollo roadmap notes ${index}.`).toString('base64url') },
      },
    };
  });
}

function gmailBroker(): CredentialBroker {
  return {
    async issueSession() {
      return {
        kind: 'bearer_token',
        handle: 'gmail.personal',
        provider: 'gmail',
        capability: 'gmail.email.sync',
        token: 'gmail-test-token',
        expiresAt: '2099-01-01T00:00:00.000Z',
        audit: {
          handle: 'gmail.personal',
          provider: 'gmail',
          capability: 'gmail.email.sync',
          trustDomain: 'secure_local',
          scopes: ['gmail.email.sync'],
          outcome: 'issued',
          issuedAt: '2026-08-19T00:00:00.000Z',
          rawCredentialExposed: false,
        },
      };
    },
  };
}

// --- Drive helpers ---------------------------------------------------------

function driveBudget(dailyRequestBudget: number): GoogleDailyRequestBudget {
  const dir = mkdtempSync(join(tmpdir(), 'olympus-drive-operator-'));
  tempDirs.push(dir);
  return createGoogleDriveDailyRequestBudget({
    env: {
      OLYMPUS_SOURCE_INDEX_GOOGLE_DRIVE_DAILY_API_REQUEST_BUDGET: String(dailyRequestBudget),
    },
    statePath: join(dir, 'google-drive-daily-request-budget.json'),
    now: () => DAY_START,
  });
}

interface CountingDriveApiClient extends GoogleDriveApiClient {
  listCalls: number;
  contentCalls: string[];
}

function driveLane(input: {
  client: CountingDriveApiClient;
  maxFiles: number;
  budget: GoogleDailyRequestBudget;
}): { handler: GoogleDriveConnectorStoreSyncHandler } {
  const internalStore = new LocalConnectorStore({
    dbPath: ':memory:',
    corpusId: GOOGLE_DRIVE_INTERNAL_CONNECTOR_CORPUS_ID,
    family: 'file',
    trustDomain: 'internal',
  });
  const secureStore = new LocalConnectorStore({
    dbPath: ':memory:',
    corpusId: GOOGLE_DRIVE_SECURE_CONNECTOR_CORPUS_ID,
    family: 'file',
    trustDomain: 'secure_local',
  });
  openStores.push(internalStore, secureStore);
  const provider = testEmbeddingProvider();
  return {
    handler: createGoogleDriveConnectorStoreSyncHandler({
      internalStore,
      secureStore,
      account: 'personal',
      apiClient: input.client,
      maxFiles: input.maxFiles,
      maxContentFiles: 50,
      internalEmbeddingProvider: provider,
      secureEmbeddingProvider: provider,
      requestBudget: input.budget,
      env: {},
    }),
  };
}

function fakeDriveClient(files: GoogleDriveFile[]): CountingDriveApiClient {
  return {
    listCalls: 0,
    contentCalls: [],
    async listFiles(request: GoogleDriveListFilesRequest) {
      this.listCalls += 1;
      const offset = request.pageToken ? Number(request.pageToken) : 0;
      const slice = files.slice(offset, offset + request.pageSize);
      const nextOffset = offset + slice.length;
      return {
        files: slice,
        ...(nextOffset < files.length ? { nextPageToken: String(nextOffset) } : {}),
      };
    },
    async exportGoogleDocText(fileId: string) {
      this.contentCalls.push(fileId);
      return `Apollo roadmap notes for ${fileId}.`;
    },
    async downloadTextFile(fileId: string) {
      this.contentCalls.push(fileId);
      return `Apollo roadmap notes for ${fileId}.`;
    },
    async downloadFileBytes(fileId: string) {
      this.contentCalls.push(fileId);
      const bytes = new TextEncoder().encode(`Apollo roadmap notes for ${fileId}.`);
      return { bytes, sizeBytes: bytes.byteLength };
    },
  };
}

function driveFiles(count: number): GoogleDriveFile[] {
  return Array.from({ length: count }, (_unused, offset) => {
    const index = offset + 1;
    return {
      id: `file-${index}`,
      name: `apollo-${index}.txt`,
      mimeType: 'text/plain',
      modifiedTime: `2026-08-0${index}T00:00:00.000Z`,
      version: String(index),
      size: '48',
      webViewLink: `https://drive.google.com/file/d/file-${index}/view`,
    };
  });
}

// --- Readwise helpers ------------------------------------------------------

interface ReadwiseHarness {
  handler: ReadwiseConnectorStoreSyncHandler;
  calls: string[];
  close(): void;
}

function readwiseHarness(options: {
  requestBudget: ReadwiseDailyRequestBudget;
  fetch?: ReadwiseFetch;
}): ReadwiseHarness {
  const root = mkdtempSync(join(tmpdir(), 'olympus-readwise-operator-'));
  const store = createReadwiseConnectorStore(join(root, 'readwise-connector.sqlite'));
  const calls: string[] = [];
  const handler = createReadwiseConnectorStoreSyncHandler({
    store,
    embeddingProvider: testEmbeddingProvider(),
    account: 'person@example.com',
    credentialBroker: new StaticCredentialBroker([{
      handle: 'readwise.personal',
      provider: 'readwise',
      allowedCapabilities: ['readwise.sync'],
      token: 'broker-token',
      scopes: ['readwise.reader:read', 'readwise.export:read'],
      trustDomain: 'internal',
    }]),
    fetch: options.fetch ?? readwiseFetch(calls),
    requestBudget: options.requestBudget,
    now: () => DAY_START,
  });
  return {
    handler,
    calls,
    close: () => {
      store.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

function readwiseFetch(calls: string[]): ReadwiseFetch {
  return async (url) => {
    calls.push(url);
    const parsed = new URL(url);
    const pageCursor = parsed.searchParams.get('pageCursor');
    if (parsed.pathname === '/api/v3/list/' && !pageCursor) {
      return jsonResponse({
        count: 2,
        nextPageCursor: 'reader-2',
        results: [
          { id: 'reader-1', title: 'Reader one', summary: 'Summary one' },
          { id: 'reader-2', title: 'Reader two', summary: 'Summary two' },
        ],
      });
    }
    if (parsed.pathname === '/api/v3/list/') {
      return jsonResponse({
        count: 2,
        results: [
          { id: 'reader-3', title: 'Reader three', summary: 'Summary three' },
          { id: 'reader-4', title: 'Reader four', summary: 'Summary four' },
        ],
      });
    }
    if (parsed.pathname === '/api/v2/export/' && !pageCursor) {
      return jsonResponse({
        nextPageCursor: 'export-2',
        results: [{
          user_book_id: 'book-42',
          title: 'Book 42',
          highlights: [
            { id: 'highlight-7', text: 'Highlight seven' },
            { id: 'highlight-8', text: 'Highlight eight' },
          ],
        }],
      });
    }
    if (parsed.pathname === '/api/v2/export/') {
      return jsonResponse({
        results: [{
          user_book_id: 'book-99',
          title: 'Book 99',
          highlights: [{ id: 'highlight-9', text: 'Highlight nine' }],
        }],
      });
    }
    return jsonResponse({ error: 'unexpected URL' }, 404);
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

// --- Shared helpers --------------------------------------------------------

function testEmbeddingProvider(): SourceEmbeddingProvider {
  return {
    provider: 'local-operator-test',
    backend: 'local',
    modelId: 'local-operator-test-model',
    dimension: 2,
    configHash: 'local-operator-test-config',
    epochId: 'local-operator-test:2026-08-19',
    async embed(inputs) {
      return inputs.map(() => [1, 0]);
    },
  };
}

async function drain(pages: AsyncIterable<unknown>): Promise<void> {
  for await (const _page of pages) {
    // Exhaust the traversal so every guarded request is attempted.
  }
}
