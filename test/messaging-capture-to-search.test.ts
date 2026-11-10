// #609: a captured WhatsApp or Telegram message becomes findable within the
// change-wake debounce, not on the 30-minute scheduled cycle. Real spool, real
// spool watcher wiring (with an injected fs.watch), real store sync, tier set
// and embedding sweep, driven by the real scheduler on an injected clock whose
// interval timer never fires.

import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { EventEmitter } from 'node:events';
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { OlympusConfig } from '../src/core/config.ts';
import { LocalConnectorStore } from '../src/workers/connector-store/index.ts';
import { TIER_DOMAIN_ORDER, createLaneTieredStoreSet, type TieredStoreSet } from '../src/workers/connector-store/tiered-store-set.ts';
import { createSpoolChangeSubscription } from '../src/workers/messaging-spool-wake.ts';
import {
  SOURCE_SCHEDULER_CHANGE_DEBOUNCE_MS,
  SourceScheduler,
  createTelegramSchedulerSource,
  createWhatsAppSchedulerSource,
  withEmbeddingSweep,
  type SourceSchedulerSource,
} from '../src/workers/source-scheduler.ts';
import {
  INTERNAL_TELEGRAM_MESSAGES_CORPUS_ID,
  PROTECTED_TELEGRAM_MESSAGES_CORPUS_ID,
  createTelegramConnectorStoreSyncHandler,
} from '../src/workers/telegram-messages/index.ts';
import {
  createWhatsAppConnectorStore,
  createWhatsAppConnectorStoreSyncHandler,
  createWhatsAppTierLane,
} from '../src/workers/whatsapp/index.ts';
import { createTestClock, flushMicrotasks } from './helpers/test-clock.ts';
import { localProvider } from './helpers/tier-fixtures.ts';
import { liveSpoolLine } from './support/telegram-spool-fixtures.ts';

const SCHEDULED_INTERVAL_MS = 30 * 60_000;
const cleanups: Array<() => void> = [];
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); });
beforeEach(() => {
  // The embedding sweep's counts-only diagnostics.
  const info = spyOn(console, 'info').mockImplementation(() => {});
  cleanups.push(() => info.mockRestore());
});

/**
 * The scheduler on the shared test clock. Its polling intervals (the 30-minute
 * tick, fast-wake ticks) are never fired: only the change debounce and the
 * wakes it schedules can run a pass.
 */
function clockedScheduler(sources: SourceSchedulerSource[], start: Date) {
  const clock = createTestClock(start.getTime());
  const scheduler = new SourceScheduler({
    enabled: true,
    tickMs: SCHEDULED_INTERVAL_MS,
    errorBackoffMs: SCHEDULED_INTERVAL_MS,
    maxTransientRetries: 1,
    sources,
    now: clock.date,
    setTimeoutImpl: clock.setTimeout as unknown as typeof setTimeout,
    clearTimeoutImpl: clock.clearTimeout as unknown as typeof clearTimeout,
    setIntervalImpl: (() => ({ unref() {} })) as unknown as typeof setInterval,
    clearIntervalImpl: (() => {}) as unknown as typeof clearInterval,
  });
  cleanups.push(() => scheduler.stop());
  // Every pass the scheduler starts (start, a change wake, a continuation) is
  // awaited to its end, so the test waits on the work, never on a real timer.
  const passes = new Set<Promise<unknown>>();
  const runDueTasks = scheduler.runDueTasks.bind(scheduler);
  scheduler.runDueTasks = (now?: Date) => {
    const pass = runDueTasks(now);
    passes.add(pass);
    void pass.finally(() => passes.delete(pass));
    return pass;
  };
  const settle = async (): Promise<void> => {
    await flushMicrotasks();
    while (passes.size > 0) {
      await Promise.allSettled([...passes]);
      // A pass that made progress schedules its downstream work due now.
      await clock.advance(0);
    }
  };
  return {
    scheduler,
    /** Moves the clock forward, letting each pass a timer starts finish. */
    async advance(ms: number): Promise<void> {
      await settle();
      await clock.advance(ms);
      await settle();
    },
  };
}

/** fs.watch stand-in: records listeners so the test can report a spool file change. */
function fakeWatch() {
  const listeners = new Map<string, (event: string, name: string | null) => void>();
  const watch = ((dir: string, _options: unknown, listener: (event: string, name: string | null) => void) => {
    listeners.set(dir, listener);
    return Object.assign(new EventEmitter(), { close: () => { listeners.delete(dir); } });
  }) as unknown as typeof import('node:fs').watch;
  return {
    watch,
    changed(spoolDir: string, file: string): void {
      const listener = listeners.get(spoolDir);
      expect(listener).toBeDefined();
      listener!('change', file);
    },
  };
}

function config(): OlympusConfig {
  return {
    worker: {
      scheduler: {
        enabled: true,
        sourceIds: [],
        tickSeconds: SCHEDULED_INTERVAL_MS / 1_000,
        syncIntervalSeconds: SCHEDULED_INTERVAL_MS / 1_000,
        freshnessThresholdHours: 24,
        errorBackoffSeconds: 30,
        maxTransientRetries: 1,
      },
    },
  } as unknown as OlympusConfig;
}

function storesOf(set: TieredStoreSet): LocalConnectorStore[] {
  return TIER_DOMAIN_ORDER.flatMap((domain) => {
    const store = set.store(domain);
    return store ? [store] : [];
  });
}

/** Found by keyword search in some store of the set, or held there waiting for its judgment. */
function findable(set: TieredStoreSet, word: string): boolean {
  return storesOf(set).some((store) => store.searchItems(word, 5).length > 0);
}

function embeddedTexts(provider: ReturnType<typeof localProvider>): string {
  return JSON.stringify(provider.inputs);
}

describe('#609 capture to search without the scheduled pass', () => {
  test('a new WhatsApp spool line is stored, keyword-searchable, recorded for judging and embedded within the debounce', async () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'olympus-609-wa-'));
    cleanups.push(() => rmSync(stateDir, { recursive: true, force: true }));
    const spoolDir = join(stateDir, 'spool');
    mkdirSync(spoolDir, { recursive: true });
    const spool = join(spoolDir, '2026-11-10.jsonl');
    writeFileSync(spool, whatsappLine('m1', 'Lunch moved to the harbour terrace'));
    const env = { OLYMPUS_WHATSAPP_STATE_DIR: stateDir, HOME: stateDir };
    const store = createWhatsAppConnectorStore(env);
    const set = createWhatsAppTierLane({ store, env }).set;
    cleanups.push(() => { for (const opened of storesOf(set)) opened.close(); set.ledger.close(); });
    const provider = localProvider();
    const sync = createWhatsAppConnectorStoreSyncHandler({ store, tierSet: set, env, spoolDir });
    const watcher = fakeWatch();
    const sources = withEmbeddingSweep([createWhatsAppSchedulerSource({
      config: config(),
      sync,
      subscribeChanges: createSpoolChangeSubscription(spoolDir, { watch: watcher.watch }),
    })!], () => () => storesOf(set).map((target) => ({ store: target, provider, wholeStore: true })));
    const clock = clockedScheduler(sources, new Date('2026-11-10T09:00:00Z'));

    clock.scheduler.start();
    await clock.advance(0);
    expect(findable(set, 'harbour')).toBe(true);

    // Ten minutes on, well inside the 30-minute interval, a new message is captured.
    await clock.advance(10 * 60_000);
    appendFileSync(spool, whatsappLine('m2', 'Bring the zeppelin tickets'));
    expect(findable(set, 'zeppelin')).toBe(false);
    watcher.changed(spoolDir, '2026-11-10.jsonl');
    await clock.advance(SOURCE_SCHEDULER_CHANGE_DEBOUNCE_MS - 1);
    expect(findable(set, 'zeppelin')).toBe(false);
    await clock.advance(1);

    expect(findable(set, 'zeppelin')).toBe(true);
    expect(set.ledger.getCurrent({
      provider: 'whatsapp',
      accountScope: 'personal',
      providerConversationId: 'chat-609@s.whatsapp.net',
      providerItemId: 'm2',
    })).toBeDefined();
    expect(embeddedTexts(provider)).toContain('zeppelin');
  });

  test('a new Telegram spool line is stored, keyword-searchable and recorded for judging within the debounce', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'olympus-609-tg-'));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const spoolDir = join(dir, 'spool');
    mkdirSync(spoolDir);
    const spool = join(spoolDir, '2026-11-10.jsonl');
    writeFileSync(spool, liveSpoolLine({ chat: 'tiago', id: '1', text: 'The ferry leaves at noon.',
      chatTitle: 'Tiago', sentAt: '2026-11-10T08:59:00Z', trust: 'internal' }));
    const internal = new LocalConnectorStore({ dbPath: join(dir, 'internal.sqlite'), corpusId: INTERNAL_TELEGRAM_MESSAGES_CORPUS_ID, family: 'chat', trustDomain: 'internal' });
    const secureLocal = new LocalConnectorStore({ dbPath: join(dir, 'secure.sqlite'), corpusId: PROTECTED_TELEGRAM_MESSAGES_CORPUS_ID, family: 'chat', trustDomain: 'secure_local' });
    const set = createLaneTieredStoreSet({ setId: 'telegram.messages', internalStore: internal, secureStore: secureLocal, splitLayers: false });
    cleanups.push(() => { internal.close(); secureLocal.close(); set.ledger.close(); });
    const sync = createTelegramConnectorStoreSyncHandler({ stores: { internal, secureLocal }, spoolDir, tierSet: set });
    const watcher = fakeWatch();
    const clock = clockedScheduler([createTelegramSchedulerSource({
      config: config(),
      sync,
      subscribeChanges: createSpoolChangeSubscription(spoolDir, { watch: watcher.watch }),
    })!], new Date('2026-11-10T09:00:00Z'));

    clock.scheduler.start();
    await clock.advance(0);
    expect(findable(set, 'ferry')).toBe(true);

    await clock.advance(10 * 60_000);
    appendFileSync(spool, liveSpoolLine({ chat: 'tiago', id: '2', text: 'Pack the umbrella too.',
      chatTitle: 'Tiago', sentAt: '2026-11-10T09:10:00Z', trust: 'internal' }, '2026-11-10T09:10:00Z'));
    expect(findable(set, 'umbrella')).toBe(false);
    watcher.changed(spoolDir, '2026-11-10.jsonl');
    await clock.advance(SOURCE_SCHEDULER_CHANGE_DEBOUNCE_MS - 1);
    expect(findable(set, 'umbrella')).toBe(false);
    await clock.advance(1);

    expect(findable(set, 'umbrella')).toBe(true);
    expect(set.ledger.getCurrent({
      provider: 'telegram', accountScope: 'telegram.personal', providerConversationId: 'tiago', providerItemId: '2',
    })).toBeDefined();
  });
});

function whatsappLine(id: string, text: string): string {
  return `${JSON.stringify({
    id,
    chat_jid: 'chat-609@s.whatsapp.net',
    chat_name: 'Pilot chat',
    sender_jid: 'sender-1@s.whatsapp.net',
    sender_name: 'Pilot',
    from_me: false,
    timestamp: '2026-11-10T09:10:00Z',
    text,
  })}\n`;
}
