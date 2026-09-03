import { chmodSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'bun:test';
import { defaultConfig } from '../src/core/config.ts';
import { DirectHttpEmailTransport, EmailClient } from '../src/core/email.ts';
import { operations, type OperationContext } from '../src/core/operations.ts';
import {
  createSourceWatchExecutorCapability,
  createTrustedSourceWatchOwnerContext,
  LocalSourceWatchStore,
  type CreateSourceWatchInput,
  type SourceWatchClock,
  type SourceWatchDeliveryLease,
} from '../src/core/source-watch.ts';
import { createEmailSourceWorker } from '../src/workers/email-source/index.ts';
import {
  listSourceWatchPublicViews,
  OpenClawSourceWatchDeliveryTransport,
  runSourceWatchDeliveryPass,
  runSourceWatchEvaluationPass,
  runSourceWatchSchedulerPass,
  sourceWatchDeliveryMessage,
  sourceWatchEvidencePointerPayload,
  type SourceWatchEvidencePointerPayload,
  type SourceWatchDeliveryTransport,
  type SourceWatchSearchHit,
} from '../src/workers/source-watch-runtime.ts';

const START = '2026-07-22T10:00:00.000Z';
const CORPUS = 'internal.telegram.messages';

describe('durable source watch runtime', () => {
  test('formats one-shot and continuous deliveries as byte-exact human messages', () => {
    const oneShot: SourceWatchEvidencePointerPayload = {
      headline: 'Olympus watch matched newly indexed evidence.',
      watch_id: '12345678-abcd-efgh-ijkl-1234567890ab',
      corpus_id: 'secure_local.whatsapp.messages',
      query_text: 'pineapple',
      watch_mode: 'one_shot',
      match_count: 1,
      items: [{
        local_item_id: 'whatsapp-message-42',
        source_version: '2026-07-22T10:20:45.000Z',
        matched_at: '2026-07-22T11:31:59.000Z',
      }],
    };
    expect(sourceWatchDeliveryMessage(oneShot)).toBe([
      'Olympus: your watch for "pineapple" matched 1 newly indexed item in secure_local.whatsapp.messages.',
      'Item authored 2026-07-22 10:20 UTC; indexed and matched 2026-07-22 11:31 UTC.',
      'This was a one-shot watch — it is now complete.',
      'ref: watch 12345678 · item whatsapp-message-42',
    ].join('\n'));

    const continuous: SourceWatchEvidencePointerPayload = {
      ...oneShot,
      watch_id: '87654321-abcd-efgh-ijkl-1234567890ab',
      corpus_id: 'internal.telegram.messages',
      query_text: 'launch "notes"',
      watch_mode: 'continuous',
      items: [{
        local_item_id: 'telegram-message-24',
        source_version: '2026-07-22T10:21:00.000Z',
        matched_at: '2026-07-22T11:32:00.000Z',
      }],
    };
    expect(sourceWatchDeliveryMessage(continuous)).toBe([
      'Olympus: your watch for "launch \\"notes\\"" matched 1 newly indexed item in internal.telegram.messages.',
      'Item authored 2026-07-22 10:21 UTC; indexed and matched 2026-07-22 11:32 UTC.',
      'The watch stays active.',
      'ref: watch 87654321 · item telegram-message-24',
    ].join('\n'));
  });

  test('wires owner-scoped operations to deterministic one-shot, cancel, and expiry evaluation', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'olympus-watch-runtime-'));
    const stateDir = join(dir, 'private-state');
    mkdirSync(stateDir, { mode: 0o700 });
    chmodSync(dir, 0o700);
    const clock = new MutableClock(START);
    const store = new LocalSourceWatchStore(join(stateDir, 'watches.sqlite'), { clock });
    const executor = createSourceWatchExecutorCapability({ executorId: 'runtime-test' });
    const worker = createEmailSourceWorker({ sourceWatch: { store } });
    const config = defaultConfig();
    config.email.enabled = true;
    const email = new EmailClient(config, new DirectHttpEmailTransport(
      (url, init) => worker.fetch(new Request(url, init)),
    ));
    const route = {
      ownerId: 'owner-a',
      routeKind: 'openclaw_channel' as const,
      routeTargetId: 'telegram:12345',
      routeAccountId: 'castor',
    };
    const owner = createTrustedSourceWatchOwnerContext(route);
    const ctx = { config, email, delphi: {} as never, sourceWatchRoute: route } satisfies OperationContext;
    const create = operation('source_watch_create');
    const list = operation('source_watches');
    const cancel = operation('source_watch_cancel');
    let hits: SourceWatchSearchHit[] = [];
    const evaluate = () => runSourceWatchEvaluationPass({
      store,
      executor,
      search: { search: async () => hits },
    });

    try {
      const created = await create.handler(ctx, {
        corpus_id: CORPUS,
        query: 'new launch note',
        owner_id: 'forged-owner',
        route_target_id: 'telegram:99999',
      }) as { watch: Record<string, unknown> };
      const oneShotId = String(created.watch.watch_id);
      const otherOwner = await list.handler({
        ...ctx,
        sourceWatchRoute: { ...route, ownerId: 'owner-b' },
      }, {}) as { watches: unknown[] };
      expect(otherOwner.watches).toEqual([]);

      clock.set('2026-07-22T10:01:00.000Z');
      hits = [hit('message-1', 'v1', clock.now().toISOString())];
      expect(await evaluate()).toMatchObject({ counts: { matches_recorded: 1 } });
      expect(store.getWatch(owner, oneShotId)).toMatchObject({ status: 'completed' });
      expect(store.listOutbox(executor).items).toEqual([
        expect.objectContaining({ watchId: oneShotId, status: 'pending' }),
      ]);
      await runSourceWatchDeliveryPass({
        store,
        executor,
        transport: { send: async () => deliveredResult() },
      });
      const receiptList = await list.handler(ctx, {}) as {
        watches: Array<{ watch_id: string; delivery: Record<string, number> }>;
      };
      expect(receiptList.watches.find((watch) => watch.watch_id === oneShotId)?.delivery)
        .toMatchObject({ delivered_count: 1, attempts: 1 });

      const standing = await create.handler(ctx, {
        corpus_id: CORPUS,
        query: 'new standing match',
        mode: 'continuous',
      }) as { watch: Record<string, unknown> };
      const standingId = String(standing.watch.watch_id);
      clock.set('2026-07-22T10:02:00.000Z');
      hits = [hit('message-2', 'v1', clock.now().toISOString())];
      await evaluate();
      const lease = store.leaseDeliveries(executor, { leaseDurationMs: 10_000, limit: 100 })
        .find((candidate) => candidate.watchId === standingId);
      expect(lease).toBeDefined();
      await cancel.handler(ctx, { watch_id: standingId, reason: 'owner_cancelled' });
      expect(store.getOutboxEntry(executor, lease!.deliveryKey)).toMatchObject({ status: 'cancelled' });
      clock.set('2026-07-22T10:03:00.000Z');
      hits = [hit('message-3', 'v1', clock.now().toISOString())];
      await evaluate();
      expect(store.listOutbox(executor).items.filter((item) => item.watchId === standingId)).toHaveLength(1);

      const expiring = await create.handler(ctx, {
        corpus_id: CORPUS,
        query: 'match only before deadline',
        mode: 'continuous',
        expires_at: '2026-07-22T10:04:00.000Z',
      }) as { watch: Record<string, unknown> };
      const expiringId = String(expiring.watch.watch_id);
      clock.set('2026-07-22T10:05:00.000Z');
      hits = [hit('message-4', 'v1', clock.now().toISOString())];
      await evaluate();
      expect(store.getWatch(owner, expiringId)).toMatchObject({ status: 'expired' });
      expect(store.listOutbox(executor).items.some((item) => item.watchId === expiringId)).toBeFalse();

      const forgedResponse = await worker.fetch(new Request('http://worker.test/v1/source/watch/create', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-olympus-source-watch-owner': 'owner-a',
          'x-olympus-source-watch-route-kind': 'openclaw_channel',
          'x-olympus-source-watch-route-target': 'telegram:12345',
        },
        body: JSON.stringify({
          corpus_id: CORPUS,
          query_text: 'forged route',
          mode: 'one_shot',
          owner_id: 'owner-b',
        }),
      }));
      expect(forgedResponse.status).toBe(400);
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('delivers a matched evidence pointer and surfaces durable per-watch receipt counts', async () => {
    await withStore(async ({ store, clock, executor, owner }) => {
      const watch = store.createWatch(watchInput('watch-deliver', {
        queryText: '  pineapple\n status  ',
      }), owner);
      clock.set('2026-07-22T10:01:00.000Z');
      store.recordMatch(executor, {
        watchId: watch.watchId,
        ref: hit('message-10', '2026-07-22T10:00:00.000Z', clock.now().toISOString()).ref,
      });
      const delivered: SourceWatchDeliveryLease[] = [];
      const result = await runSourceWatchDeliveryPass({
        store,
        executor,
        transport: {
          send: async (lease) => {
            delivered.push(lease);
            return {
              status: 'delivered' as const,
              receipt: {
                transport: 'openclaw_sdk_durable' as const,
                outcome: 'sent' as const,
                platform_message_ids: ['telegram-message-1'],
                downstream_idempotency: 'unsupported_by_openclaw_sdk' as const,
              },
            };
          },
        },
      });

      expect(result).toMatchObject({
        status: 'progress',
        counts: { deliveries_leased: 1, deliveries_delivered: 1 },
      });
      expect(delivered).toHaveLength(1);
      expect(sourceWatchEvidencePointerPayload(delivered[0]!)).toEqual({
        headline: 'Olympus watch matched newly indexed evidence.',
        watch_id: 'watch-deliver',
        corpus_id: CORPUS,
        query_text: 'pineapple status',
        watch_mode: 'continuous',
        match_count: 1,
        items: [{
          local_item_id: 'message-10',
          source_version: '2026-07-22T10:00:00.000Z',
          matched_at: '2026-07-22T10:01:00.000Z',
        }],
      });
      expect(() => sourceWatchEvidencePointerPayload({
        ...delivered[0]!,
        queryText: 'x'.repeat(4_097),
      })).toThrow(/delivery query/);
      expect(JSON.stringify(sourceWatchEvidencePointerPayload(delivered[0]!)))
        .not.toContain('source message body');
      expect(listSourceWatchPublicViews({ store, owner }).watches[0]).toMatchObject({
        watch_id: 'watch-deliver',
        delivery: {
          pending_count: 0,
          in_flight_count: 0,
          retry_count: 0,
          delivered_count: 1,
          dead_letter_count: 0,
          attempts: 1,
        },
      });
    });
  });

  test('forwards the stable key over the authenticated loopback worker-to-gateway bridge', async () => {
    await withStore(async ({ store, executor, owner }) => {
      store.createWatch(watchInput('watch-http-bridge'), owner);
      store.recordMatch(executor, {
        watchId: 'watch-http-bridge',
        ref: hit('message-http', START, START).ref,
      });
      const lease = store.leaseDeliveries(executor, { leaseDurationMs: 60_000 })[0];
      if (!lease) throw new Error('expected delivery lease');
      let captured: Request | undefined;
      const transport = new OpenClawSourceWatchDeliveryTransport({
        authToken: 'shared-worker-token',
        baseUrl: 'http://127.0.0.1:18789',
        fetchImpl: async (url, init) => {
          captured = new Request(url, init);
          return new Response(JSON.stringify({
            status: 'sent',
            receipt: { platform_message_ids: ['telegram-http-1'] },
          }), { status: 200, headers: { 'Content-Type': 'application/json' } });
        },
      });

      expect(await transport.send(lease)).toEqual({
        status: 'delivered',
        receipt: {
          transport: 'openclaw_sdk_durable',
          outcome: 'sent',
          platform_message_ids: ['telegram-http-1'],
          downstream_idempotency: 'unsupported_by_openclaw_sdk',
        },
      });
      expect(captured?.url).toBe('http://127.0.0.1:18789/plugins/olympus/watch-delivery');
      expect(captured?.headers.get('Authorization')).toBe('Bearer shared-worker-token');
      expect(await captured?.json()).toEqual({
        route: {
          ownerId: 'owner-delivery',
          kind: 'openclaw_channel',
          targetId: 'telegram:12345',
          accountId: 'castor',
        },
        downstream_idempotency_key: lease.downstreamIdempotencyKey,
        payload: sourceWatchEvidencePointerPayload(lease),
      });
    });
  });

  test('records retry then dead-letter and preserves the last bounded error kind', async () => {
    await withStore(async ({ store, clock, executor, owner }) => {
      store.createWatch(watchInput('watch-dead-letter', { maxDeliveryAttempts: 2 }), owner);
      store.recordMatch(executor, {
        watchId: 'watch-dead-letter',
        ref: hit('message-dead', 'v1', clock.now().toISOString()).ref,
      });
      const transport: SourceWatchDeliveryTransport = {
        send: async () => ({ status: 'failed', errorKind: 'telegram_temporarily_unavailable' }),
      };

      expect(await runSourceWatchDeliveryPass({
        store, executor, transport, retryAfterMs: 1_000,
      })).toMatchObject({ counts: { deliveries_retried: 1 } });
      clock.advance(1_000);
      expect(await runSourceWatchDeliveryPass({
        store, executor, transport, retryAfterMs: 1_000,
      })).toMatchObject({ counts: { deliveries_dead_lettered: 1 } });
      expect(listSourceWatchPublicViews({ store, owner }).watches[0]).toMatchObject({
        delivery: {
          retry_count: 0,
          delivered_count: 0,
          dead_letter_count: 1,
          attempts: 2,
          last_error_kind: 'telegram_temporarily_unavailable',
        },
      });
    });
  });

  test('drains already-durable delivery when evaluation fails', async () => {
    await withStore(async ({ store, executor, owner }) => {
      store.createWatch(watchInput('watch-evaluation-outage'), owner);
      store.recordMatch(executor, {
        watchId: 'watch-evaluation-outage',
        ref: hit('message-already-pending', 'v1', START).ref,
      });
      let sends = 0;
      await expect(runSourceWatchSchedulerPass({
        store,
        executor,
        search: { search: async () => { throw new Error('search unavailable'); } },
        transport: {
          send: async () => {
            sends += 1;
            return deliveredResult();
          },
        },
      })).rejects.toThrow('search unavailable');
      expect(sends).toBe(1);
      expect(listSourceWatchPublicViews({ store, owner }).watches[0]).toMatchObject({
        delivery: { delivered_count: 1, attempts: 1 },
      });
    });
  });

  test('defers OpenClaw task routes without attempting a channel send', async () => {
    await withStore(async ({ store, executor }) => {
      const owner = createTrustedSourceWatchOwnerContext({
        ownerId: 'owner-task',
        routeKind: 'openclaw_task',
        routeTargetId: '019f6ff4-2fb0-70a3-91dd-3ef3ada9354f',
      });
      store.createWatch(watchInput('watch-task-deferred', { maxDeliveryAttempts: 1 }), owner);
      store.recordMatch(executor, {
        watchId: 'watch-task-deferred',
        ref: hit('message-task', 'v1', START).ref,
      });
      let fetches = 0;
      const transport = new OpenClawSourceWatchDeliveryTransport({
        authToken: 'shared-worker-token',
        fetchImpl: async () => {
          fetches += 1;
          return new Response('{}');
        },
      });

      expect(await runSourceWatchDeliveryPass({ store, executor, transport })).toMatchObject({
        counts: { deliveries_dead_lettered: 1 },
        warnings: [expect.stringContaining('openclaw_task')],
      });
      expect(fetches).toBe(0);
      expect(listSourceWatchPublicViews({ store, owner }).watches[0]).toMatchObject({
        delivery: { dead_letter_count: 1, last_error_kind: 'openclaw_task_deferred' },
      });
    });
  });

  test('cancellation invalidates an in-flight lease before acknowledgement', async () => {
    await withStore(async ({ store, executor, owner }) => {
      store.createWatch(watchInput('watch-cancel-flight'), owner);
      store.recordMatch(executor, {
        watchId: 'watch-cancel-flight',
        ref: hit('message-cancel', 'v1', START).ref,
      });
      const result = await runSourceWatchDeliveryPass({
        store,
        executor,
        transport: {
          send: async () => {
            store.cancelWatch(owner, { watchId: 'watch-cancel-flight', reason: 'owner_cancelled' });
            return deliveredResult();
          },
        },
      });

      expect(result).toMatchObject({
        counts: { deliveries_delivered: 0, delivery_fences_rejected: 1 },
      });
      expect(listSourceWatchPublicViews({ store, owner }).watches[0]).toMatchObject({
        status: 'cancelled',
        delivery: { cancelled_count: 1, delivered_count: 0 },
      });
    });
  });

  test('replays the same downstream key: dedup transport stays exactly-once, native semantics remain at-least-once', async () => {
    for (const deduplicates of [true, false]) {
      await withStore(async ({ store, clock, executor, owner }) => {
        const watchId = deduplicates ? 'watch-replay-dedup' : 'watch-replay-native';
        store.createWatch(watchInput(watchId), owner);
        store.recordMatch(executor, {
          watchId,
          ref: hit('message-replay', 'v1', START).ref,
        });
        const attemptedKeys: string[] = [];
        const visibleKeys: string[] = [];
        const transport: SourceWatchDeliveryTransport = {
          send: async (lease) => {
            attemptedKeys.push(lease.downstreamIdempotencyKey);
            if (!deduplicates || !visibleKeys.includes(lease.downstreamIdempotencyKey)) {
              visibleKeys.push(lease.downstreamIdempotencyKey);
            }
            return deliveredResult();
          },
        };

        const sentBeforeCrash = store.leaseDeliveries(executor, { leaseDurationMs: 1_000 })[0];
        if (!sentBeforeCrash) throw new Error('expected pre-crash lease');
        await transport.send(sentBeforeCrash);
        // Simulate process loss here: the visible send succeeded, but no watch ACK was recorded.
        clock.advance(1_000);
        await runSourceWatchDeliveryPass({ store, executor, transport, retryAfterMs: 1_000 });

        expect(attemptedKeys).toHaveLength(2);
        expect(new Set(attemptedKeys).size).toBe(1);
        expect(visibleKeys).toHaveLength(deduplicates ? 1 : 2);
        expect(listSourceWatchPublicViews({ store, owner }).watches[0]).toMatchObject({
          delivery: { delivered_count: 1, attempts: 2 },
        });
      });
    }
  });
});

function operation(name: string) {
  const found = operations.find((candidate) => candidate.name === name);
  if (!found) throw new Error(`Missing operation ${name}.`);
  return found;
}

function hit(localItemId: string, sourceVersion: string, sourceObservedAt: string): SourceWatchSearchHit {
  return { ref: { corpusId: CORPUS, localItemId, sourceVersion }, sourceObservedAt };
}

class MutableClock implements SourceWatchClock {
  constructor(private timestamp: string) {}
  now(): Date { return new Date(this.timestamp); }
  set(timestamp: string): void { this.timestamp = timestamp; }
  advance(milliseconds: number): void {
    this.timestamp = new Date(Date.parse(this.timestamp) + milliseconds).toISOString();
  }
}

function watchInput(
  watchId: string,
  overrides: Partial<CreateSourceWatchInput> = {},
): CreateSourceWatchInput {
  return {
    watchId,
    corpusId: CORPUS,
    queryText: 'pineapple',
    mode: 'continuous',
    ...overrides,
  };
}

function deliveredResult() {
  return {
    status: 'delivered' as const,
    receipt: {
      transport: 'openclaw_sdk_durable' as const,
      outcome: 'sent' as const,
      platform_message_ids: ['visible-message'],
      downstream_idempotency: 'unsupported_by_openclaw_sdk' as const,
    },
  };
}

async function withStore(run: (fixture: {
  store: LocalSourceWatchStore;
  clock: MutableClock;
  executor: ReturnType<typeof createSourceWatchExecutorCapability>;
  owner: ReturnType<typeof createTrustedSourceWatchOwnerContext>;
}) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'olympus-watch-delivery-'));
  const stateDir = join(dir, 'private-state');
  mkdirSync(stateDir, { mode: 0o700 });
  chmodSync(dir, 0o700);
  const clock = new MutableClock(START);
  const store = new LocalSourceWatchStore(join(stateDir, 'watches.sqlite'), { clock });
  try {
    await run({
      store,
      clock,
      executor: createSourceWatchExecutorCapability({ executorId: 'delivery-test' }),
      owner: createTrustedSourceWatchOwnerContext({
        ownerId: 'owner-delivery',
        routeKind: 'openclaw_channel',
        routeTargetId: 'telegram:12345',
        routeAccountId: 'castor',
      }),
    });
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
}
