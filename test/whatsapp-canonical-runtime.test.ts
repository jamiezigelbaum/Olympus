import { appendFileSync, chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'bun:test';
import type { OlympusConfig } from '../src/core/config.ts';
import { createWhatsAppSchedulerSource } from '../src/workers/source-scheduler.ts';
import { createFileExtractionRuntime } from '../src/workers/email-source/file-extraction-runtime.ts';
import { createWhatsAppLiveSourceConnector } from '../src/workers/whatsapp/live-connector.ts';
import {
  WHATSAPP_EXTRACTION_SCOPE_KEY,
  WHATSAPP_LIVE_CORPUS_ID,
  WHATSAPP_LIVE_CONNECTOR_ID,
  WHATSAPP_CAPTURE_STALE_WARNING,
  WHATSAPP_CAPTURE_UNAVAILABLE_WARNING,
  WHATSAPP_MALFORMED_SPOOL_WARNING,
  WHATSAPP_PERSONAL_SOURCE_ID,
  WHATSAPP_PRODUCT_CONNECTOR_ID,
  createWhatsAppConnectorStore,
  createWhatsAppConnectorStoreSyncHandler,
  defaultWhatsAppConnectorStoreDbPath,
  defaultWhatsAppSpoolDir,
  defaultWhatsAppStateDir,
} from '../src/workers/whatsapp/index.ts';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('WhatsApp canonical product runtime', () => {
  test('keeps the existing state paths and honors explicit product overrides', () => {
    const stateDir = fixtureRoot();
    const dataHome = join(stateDir, 'xdg-data');
    expect(defaultWhatsAppStateDir({ XDG_DATA_HOME: dataHome }))
      .toBe(join(dataHome, 'olympus', 'whatsapp-live'));
    expect(defaultWhatsAppSpoolDir({ OLYMPUS_WHATSAPP_STATE_DIR: stateDir }))
      .toBe(join(stateDir, 'spool'));
    expect(defaultWhatsAppConnectorStoreDbPath({ OLYMPUS_WHATSAPP_STATE_DIR: stateDir }))
      .toBe(join(stateDir, 'connector-store.db'));
    expect(defaultWhatsAppConnectorStoreDbPath({
      OLYMPUS_WHATSAPP_STATE_DIR: stateDir,
      OLYMPUS_WHATSAPP_CONNECTOR_STORE_DB_PATH: join(stateDir, 'preserved.db'),
    })).toBe(join(stateDir, 'preserved.db'));
    expect(defaultWhatsAppConnectorStoreDbPath({
      OLYMPUS_WHATSAPP_LIVE_DRAIN_DB_PATH: join(stateDir, 'legacy.db'),
      OLYMPUS_WHATSAPP_CONNECTOR_STORE_DB_PATH: join(stateDir, 'product.db'),
    })).toBe(join(stateDir, 'product.db'));
  });

  test('runs spool to shared store, resumes without duplicates, and reports malformed gaps', async () => {
    const stateDir = fixtureRoot();
    const spoolDir = join(stateDir, 'spool');
    mkdirSync(spoolDir, { recursive: true });
    const spool = join(spoolDir, '2026-08-26.jsonl');
    writeFileSync(spool, spoolLine('first') + '{broken json}\n');
    const env = { OLYMPUS_WHATSAPP_STATE_DIR: stateDir };
    const store = createWhatsAppConnectorStore(env);
    try {
      const sync = createWhatsAppConnectorStoreSyncHandler({
        store,
        env,
        spoolStaleThresholdSeconds: 3_600,
        now: () => new Date('2026-08-26T10:30:00Z'),
      });
      const source = createWhatsAppSchedulerSource({ config: schedulerConfig(), sync });
      expect(WHATSAPP_PRODUCT_CONNECTOR_ID).not.toBe(WHATSAPP_LIVE_CONNECTOR_ID);
      expect(source).toMatchObject({
        sourceId: WHATSAPP_PERSONAL_SOURCE_ID,
        corpusId: WHATSAPP_LIVE_CORPUS_ID,
        cadence: 'continuous',
      });

      const first = await source!.tasks[0]!.run();
      expect(first.status).toBe('progress');
      expect(first.counts).toMatchObject({
        items_changed: 1,
        malformed_spool_lines: 1,
        capture_fresh: 1,
        capture_stale: 0,
        capture_age_seconds: 1_800,
        capture_stale_threshold_seconds: 3_600,
      });
      expect(first.warnings).toContain(WHATSAPP_MALFORMED_SPOOL_WARNING);
      expect(store.status().counts.items).toBe(1);

      const idle = await source!.tasks[0]!.run();
      expect(idle.status).toBe('idle');
      expect(store.status().counts.items).toBe(1);

      appendFileSync(spool, spoolLine('second'));
      const resumed = await source!.tasks[0]!.run();
      expect(resumed.status).toBe('progress');
      expect(resumed.counts?.items_changed).toBe(1);
      expect(store.status().counts.items).toBe(2);
      expect(source!.lastSyncCompletedAt?.()).toBeDefined();
    } finally {
      store.close();
    }
  });

  test('reports stale and unavailable capture freshness without returning timestamps', async () => {
    const stateDir = fixtureRoot();
    const spoolDir = join(stateDir, 'spool');
    mkdirSync(spoolDir, { recursive: true });
    const env = { OLYMPUS_WHATSAPP_STATE_DIR: stateDir };
    const store = createWhatsAppConnectorStore(env);
    try {
      const unavailable = createWhatsAppConnectorStoreSyncHandler({
        store,
        env,
        now: () => new Date('2026-08-26T12:00:00Z'),
      });
      const emptyReceipt = await unavailable.pull();
      expect(emptyReceipt.capture.status).toBe('unavailable');
      expect(emptyReceipt.warnings).toContain(WHATSAPP_CAPTURE_UNAVAILABLE_WARNING);

      writeFileSync(join(spoolDir, '2026-08-26.jsonl'), spoolLine('stale'));
      const stale = createWhatsAppConnectorStoreSyncHandler({
        store,
        env,
        spoolStaleThresholdSeconds: 60,
        now: () => new Date('2026-08-26T12:00:00Z'),
      });
      const staleReceipt = await stale.pull();
      expect(staleReceipt.capture).toEqual({
        status: 'stale',
        threshold_seconds: 60,
        age_seconds: 7_200,
      });
      expect(staleReceipt.warnings).toContain(WHATSAPP_CAPTURE_STALE_WARNING);
      expect(JSON.stringify(staleReceipt)).not.toContain('2026-08-26T10:00:00Z');
    } finally {
      store.close();
    }
  });

  test('transcribes media through the shared factory and preserves it on metadata refresh', async () => {
    const stateDir = fixtureRoot();
    const spoolDir = join(stateDir, 'spool');
    const mediaDir = join(stateDir, 'media', 'audio');
    mkdirSync(spoolDir, { recursive: true });
    mkdirSync(mediaDir, { recursive: true });
    const mediaPath = join(mediaDir, 'voice-shared.ogg');
    writeFileSync(mediaPath, 'fixture-audio-bytes');
    writeFileSync(join(spoolDir, '2026-08-26.jsonl'), mediaSpoolLine('voice-shared', mediaPath));

    const transcriber = join(stateDir, 'fixture-transcriber.sh');
    writeFileSync(transcriber, '#!/bin/sh\nprintf "shared factory transcript"\n');
    chmodSync(transcriber, 0o700);

    const env = { OLYMPUS_WHATSAPP_STATE_DIR: stateDir };
    const store = createWhatsAppConnectorStore(env);
    const runtime = createFileExtractionRuntime({
      env,
      enabled: true,
      connectorStores: [store],
      corpora: [{
        corpusId: WHATSAPP_LIVE_CORPUS_ID,
        provider: 'whatsapp',
        scopes: [WHATSAPP_EXTRACTION_SCOPE_KEY],
        ownerConnectorId: WHATSAPP_PRODUCT_CONNECTOR_ID,
      }],
      extractors: { transcription: { command: `${transcriber} {input}` } },
      jobsDbPath: join(stateDir, 'file-extraction-jobs.sqlite'),
    });
    expect(runtime).toBeDefined();
    try {
      const sync = createWhatsAppConnectorStoreSyncHandler({ store, env });
      const source = createWhatsAppSchedulerSource({
        config: schedulerConfig(),
        sync,
        fileExtraction: runtime!.runner,
        extractionPlanLimit: 1,
        extractionBatchSize: 1,
      });
      expect(source?.tasks.map((task) => task.id)).toEqual([
        'whatsapp.personal.messages_store_pull',
        'whatsapp.personal.messages_extract',
      ]);

      await source!.tasks[0]!.run();
      const extraction = await source!.tasks[1]!.run();
      expect(extraction).toMatchObject({
        status: 'progress',
        counts: {
          candidates_seen: 1,
          jobs_queued: 1,
          jobs_processed: 1,
          jobs_indexed: 1,
          jobs_failed_retryable: 0,
          jobs_failed_terminal: 0,
        },
      });
      const first = store.searchItems('shared factory', 5);
      expect(first).toHaveLength(1);
      expect(first[0]?.sourceItem).toMatchObject({
        providerItemId: 'voice-shared',
        providerConversationId: 'chat-1@s.whatsapp.net',
      });
      const extractedHash = store.itemMetadataSnapshot(first[0]!.sourceItem)?.contentHash;
      expect(extractedHash).toBeDefined();

      // A complete later observation of the same metadata-only media record
      // must leave extraction-owned chunks alone.
      const refresh = await store.syncFromConnector(
        createWhatsAppLiveSourceConnector({ spoolDir, account: 'personal' }),
        { fetchContent: true, deferMetadataOnlyContent: true },
      );
      expect(refresh.itemsIndexed).toBe(1);
      const afterRefresh = store.searchItems('shared factory', 5);
      expect(afterRefresh).toHaveLength(1);
      expect(afterRefresh[0]?.sourceItem.providerConversationId)
        .toBe('chat-1@s.whatsapp.net');
      expect(store.itemMetadataSnapshot(afterRefresh[0]!.sourceItem)?.contentHash)
        .toBe(extractedHash);
    } finally {
      runtime?.close();
      store.close();
    }
  });
});

function fixtureRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'olympus-whatsapp-runtime-'));
  roots.push(root);
  return root;
}

function spoolLine(id: string): string {
  return `${JSON.stringify({
    id,
    chat_jid: 'chat-1@s.whatsapp.net',
    chat_name: 'Pilot chat',
    sender_jid: 'sender-1@s.whatsapp.net',
    sender_name: 'Pilot',
    from_me: false,
    timestamp: '2026-08-26T10:00:00Z',
    text: `message ${id}`,
  })}\n`;
}

function mediaSpoolLine(id: string, mediaPath: string): string {
  return `${JSON.stringify({
    id,
    chat_jid: 'chat-1@s.whatsapp.net',
    chat_name: 'Pilot chat',
    sender_jid: 'sender-1@s.whatsapp.net',
    sender_name: 'Pilot',
    from_me: false,
    timestamp: '2026-08-26T10:00:00Z',
    text: '',
    media_type: 'audio',
    media_path: mediaPath,
    media_mime: 'audio/ogg; codecs=opus',
    media_size_bytes: 19,
    download_status: 'ok',
  })}\n`;
}

function schedulerConfig(): OlympusConfig {
  return {
    worker: {
      scheduler: {
        enabled: true,
        sourceIds: [WHATSAPP_PERSONAL_SOURCE_ID],
        tickSeconds: 1,
        syncIntervalSeconds: 60,
        freshnessThresholdHours: 24,
        errorBackoffSeconds: 30,
        maxTransientRetries: 1,
      },
    },
  } as OlympusConfig;
}
