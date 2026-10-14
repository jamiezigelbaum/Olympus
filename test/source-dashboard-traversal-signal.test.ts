/**
 * A source that reports no provider walk is not "still listing".
 *
 * The dashboard stamps `last_run.traversal_complete` from the counts its sync
 * tasks last reported. X bookmarks reports its walk as
 * `global_traversal_exhausted` (never `traversal_complete`) and Telegram's
 * spool pull reports no walk at all; both were read as "not finished" from the
 * missing counter alone, so a source that had indexed and could answer showed
 * "listing", an unknown total and 0% for good. The answer is derived on every
 * read from the stored counts, so the rows a worker wrote before this rule
 * (counts only, no verdict) heal on the next read.
 */
import { describe, expect, test } from 'bun:test';
import { buildEnvBridgeSovereigntyConfig, createSovereigntyEngine } from '../src/core/sovereignty.ts';
import { dashboardSourceProgress } from '../src/workers/dashboard/phases.ts';
import { buildSourceDashboardViewModel } from '../src/workers/source-dashboard.ts';
import type { ConnectedHandleRegistry } from '../src/workers/credential-broker/connected-handles.ts';
import type { SourceIndexStatusResult } from '../src/workers/source-index/status.ts';
import type { SourceSchedulerStatus } from '../src/workers/source-scheduler.ts';

const NOW = new Date('2026-07-28T12:00:00.000Z');

type Corpus = SourceIndexStatusResult['corpora'][number];
type TaskResult = { status: 'progress' | 'idle' | 'failed'; counts?: Record<string, number> } | undefined;

function corpus(input: { id: string; family: string; provider: string; items: number }): Corpus {
  return {
    corpus_id: input.id,
    family: input.family,
    trust_domain: 'internal',
    activation_mode: 'hybrid_primary',
    embedding_policy: 'cloud_allowed_by_policy',
    configured: true,
    provider: input.provider,
    counts: { indexed_items: input.items, tombstoned_items: 0, chunks: input.items, embedded_chunks: input.items, sync_runs: 1 },
    last_refresh: {
      sync_run_id: 'run-1',
      status: 'completed',
      started_at: '2026-07-28T11:00:00.000Z',
      completed_at: '2026-07-28T11:05:00.000Z',
      items_seen: input.items,
      items_indexed: input.items,
    },
    item_metadata_returned: false,
    skipped_item_metadata_reason: 'connector_store_item_metadata_not_exposed_to_castor',
  } as unknown as Corpus;
}

function build(input: { corpus: Corpus; sourceId: string; tasks: Array<{ id: string; last_result?: TaskResult }>; handles?: ConnectedHandleRegistry }) {
  const status: SourceIndexStatusResult = {
    kind: 'source_index_status',
    generated_at: NOW.toISOString(),
    corpora: [input.corpus],
    policy: {
      read_only: true,
      raw_source_exposed: false,
      source_packets_exposed: false,
      source_text_returned: false,
      secure_local_item_metadata_exposed: false,
      castor_visible: true,
    },
  };
  const scheduler: SourceSchedulerStatus = {
    kind: 'source_scheduler_status',
    enabled: true,
    running: true,
    generated_at: NOW.toISOString(),
    sources: [{
      source_id: input.sourceId,
      corpus_id: input.corpus.corpus_id,
      sync_cadence: 'continuous',
      sync_interval_seconds: 300,
      freshness_threshold_hours: 26,
      freshness_hours: 1,
      stale_sync_anomaly: false,
      tasks: input.tasks.map((task) => ({
        id: task.id,
        kind: 'sync' as const,
        running: false,
        consecutive_failures: 0,
        last_success_at: '2026-07-28T11:05:00.000Z',
        last_attempt_at: '2026-07-28T11:05:00.000Z',
        ...(task.last_result ? { last_result: task.last_result } : {}),
      })),
    }],
    policy: {
      raw_source_exposed: false,
      source_text_returned: false,
      source_scope_keys_exposed: false,
      counts_only: true,
    },
  } as unknown as SourceSchedulerStatus;
  const view = buildSourceDashboardViewModel({
    sourceIndexStatus: status,
    schedulerStatus: scheduler,
    sovereigntyEngine: createSovereigntyEngine(buildEnvBridgeSovereigntyConfig({})),
    ...(input.handles ? { connectedHandleRegistry: input.handles } : {}),
    oauthClientIds: { x: 'x-client-id-fixture' },
    oauthClientSecretAvailability: { x: true },
    now: NOW,
  });
  const card = view.sources.find((source) => source.source_id === input.sourceId)!;
  return { card, progress: dashboardSourceProgress(card) };
}

const X_HANDLES: ConnectedHandleRegistry = {
  version: 1,
  handles: [{
    handle: 'x.bookmarks.personal',
    provider: 'x',
    accountRole: 'personal',
    trustDomain: 'internal',
    allowedCapabilities: ['x.bookmarks.sync'],
    scopes: ['tweet.read'],
    connectedAt: '2026-07-02T10:00:00.000Z',
  }],
};

const X_HEAD = { id: 'x.bookmarks_head', last_result: { status: 'idle' as const, counts: { api_requests: 1, items_seen: 3, items_indexed: 3 } } };
const xReconcile = (exhausted: number | undefined) => ({
  id: 'x.bookmarks_reconcile',
  last_result: { status: 'idle' as const, counts: { api_requests: 12, items_seen: 812, items_indexed: 812, ...(exhausted === undefined ? {} : { global_traversal_exhausted: exhausted }) } },
});
const xCorpus = () => corpus({ id: 'internal.x.bookmarks', family: 'x', provider: 'x', items: 812 });

describe('X bookmarks: its own completion signal', () => {
  test('a reconcile that exhausted the provider list settles the card (no listing, a known total)', () => {
    const { card, progress } = build({ corpus: xCorpus(), sourceId: 'x.bookmarks', tasks: [X_HEAD, xReconcile(1)], handles: X_HANDLES });
    expect(card.last_run?.traversal_complete).toBe(true);
    const metadata = progress.phases[0]!;
    expect(metadata.measure.kind).not.toBe('indeterminate');
  });

  test('a reconcile that has not exhausted the list still reads as listing', () => {
    const { card, progress } = build({ corpus: xCorpus(), sourceId: 'x.bookmarks', tasks: [X_HEAD, xReconcile(0)], handles: X_HANDLES });
    expect(card.last_run?.traversal_complete).toBe(false);
    expect(progress.settled).toBe(false);
    expect(progress.phases[0]!.measure.kind).toBe('indeterminate');
  });

  test('a head sync that reports no walk takes no part; a reconcile that never reported keeps it listing', () => {
    expect(build({ corpus: xCorpus(), sourceId: 'x.bookmarks', tasks: [X_HEAD, xReconcile(1)], handles: X_HANDLES }).card.last_run?.traversal_complete).toBe(true);
    expect(build({ corpus: xCorpus(), sourceId: 'x.bookmarks', tasks: [X_HEAD, { id: 'x.bookmarks_reconcile' }], handles: X_HANDLES }).card.last_run?.traversal_complete).toBe(false);
  });

  test('rows stored before the rule (counts with the signal, no verdict) heal on read, and a later sync cannot undo it', () => {
    // The stored shape: counts only. The same counts, read again after a later
    // head sync replaced the head's result, give the same answer.
    const stored = [X_HEAD, xReconcile(1)];
    const first = build({ corpus: xCorpus(), sourceId: 'x.bookmarks', tasks: stored, handles: X_HANDLES });
    const later = build({
      corpus: xCorpus(),
      sourceId: 'x.bookmarks',
      tasks: [{ id: 'x.bookmarks_head', last_result: { status: 'progress', counts: { api_requests: 1, items_seen: 5, items_indexed: 5, items_changed: 2 } } }, xReconcile(1)],
      handles: X_HANDLES,
    });
    expect(first.card.last_run?.traversal_complete).toBe(true);
    expect(later.card.last_run?.traversal_complete).toBe(true);
  });
});

describe('a source with no provider walk (Telegram)', () => {
  const telegram = () => corpus({ id: 'internal.telegram.messages', family: 'chat', provider: 'telegram', items: 185_000 });
  const pull = { id: 'telegram.messages_store_pull', last_result: { status: 'idle' as const, counts: { items_seen: 40, items_indexed: 40, items_changed: 0 } } };

  test('its receipt has no traversal counter, so the card carries no verdict and settles on its other evidence', () => {
    const { card, progress } = build({ corpus: telegram(), sourceId: 'telegram.messages', tasks: [pull] });
    expect(card.last_run).toBeDefined();
    expect(card.last_run).not.toHaveProperty('traversal_complete');
    expect(progress.phases[0]!.measure.kind).not.toBe('indeterminate');
  });

  test('before its first pull has reported anything it is still not settled', () => {
    const { card } = build({ corpus: telegram(), sourceId: 'telegram.messages', tasks: [{ id: 'telegram.messages_store_pull' }] });
    expect(card.last_run?.traversal_complete).toBe(false);
  });
});

describe('sources that do report the walk keep their verdict', () => {
  const gmail = () => corpus({ id: 'internal.email', family: 'email', provider: 'gmail', items: 40 });
  const counted = (id: string, traversal: number) => ({ id, last_result: { status: 'progress' as const, counts: { items_seen: 10, traversal_complete: traversal } } });

  test('traversal_complete 0 on any task means not finished, even beside a finished one', () => {
    expect(build({ corpus: gmail(), sourceId: 'gmail.email', tasks: [counted('gmail.pull', 1), counted('gmail.reconcile', 0)] }).card.last_run?.traversal_complete).toBe(false);
  });

  test('every task finished means finished', () => {
    expect(build({ corpus: gmail(), sourceId: 'gmail.email', tasks: [counted('gmail.pull', 1), counted('gmail.reconcile', 1)] }).card.last_run?.traversal_complete).toBe(true);
  });

  test('traversal_complete wins over the X signal when a task carries both', () => {
    const task = { id: 'x.bookmarks_reconcile', last_result: { status: 'idle' as const, counts: { traversal_complete: 0, global_traversal_exhausted: 1 } } };
    expect(build({ corpus: xCorpus(), sourceId: 'x.bookmarks', tasks: [task], handles: X_HANDLES }).card.last_run?.traversal_complete).toBe(false);
  });

  test('a task that has not run its walk yet keeps the source listing', () => {
    expect(build({ corpus: gmail(), sourceId: 'gmail.email', tasks: [counted('gmail.pull', 1), { id: 'gmail.reconcile' }] }).card.last_run?.traversal_complete).toBe(false);
  });
});
