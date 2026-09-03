// scripts/whatsapp-live-sync.ts is a diagnostic/convergence utility that runs
// against the SAME store db and the SAME item identities as the product lane.
// Media messages list as metadata_only and fetchItem restates them that way, so
// a sync that does not defer metadata-only content drives the store's single
// chunk funnel into its "authoritatively no text" branch and deletes chunks the
// shared extraction factory wrote. The loss does not self-heal: the extraction
// job is already recorded as succeeded, so it never re-runs.

import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'bun:test';
import type { OlympusConfig } from '../src/core/config.ts';
import { createWhatsAppSchedulerSource } from '../src/workers/source-scheduler.ts';
import { createFileExtractionRuntime } from '../src/workers/email-source/file-extraction-runtime.ts';
import {
  WHATSAPP_EXTRACTION_SCOPE_KEY,
  WHATSAPP_LIVE_CORPUS_ID,
  WHATSAPP_PERSONAL_SOURCE_ID,
  WHATSAPP_PRODUCT_CONNECTOR_ID,
  createWhatsAppConnectorStore,
  createWhatsAppConnectorStoreSyncHandler,
} from '../src/workers/whatsapp/index.ts';

const ACCOUNT = 'personal';
const TRANSCRIPT = 'preserved voicemail transcript';
const SCRIPT = join(import.meta.dir, '..', 'scripts', 'whatsapp-live-sync.ts');
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('whatsapp live sync extraction preservation', () => {
  test('re-observing a media message through the script keeps extraction-owned chunks', async () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'whatsapp-live-sync-extraction-'));
    roots.push(stateDir);
    const spoolDir = join(stateDir, 'spool');
    const mediaDir = join(stateDir, 'media', 'audio');
    mkdirSync(spoolDir, { recursive: true });
    mkdirSync(mediaDir, { recursive: true });
    const mediaPath = join(mediaDir, 'voice-1.ogg');
    writeFileSync(mediaPath, 'fixture-audio-bytes');
    writeFileSync(join(spoolDir, '2026-08-31.jsonl'), mediaSpoolLine('voice-1', mediaPath));

    const transcriber = join(stateDir, 'fixture-transcriber.sh');
    writeFileSync(transcriber, `#!/bin/sh\nprintf "${TRANSCRIPT}"\n`);
    chmodSync(transcriber, 0o700);

    const env = { OLYMPUS_WHATSAPP_STATE_DIR: stateDir };
    const extractedHash = await extractTranscript(stateDir, env, transcriber);
    expect(extractedHash).toBeDefined();

    const run = Bun.spawnSync([process.execPath, SCRIPT, '--account', ACCOUNT], {
      cwd: join(import.meta.dir, '..'),
      env: { ...process.env, ...env },
    });
    expect(run.stderr.toString()).toBe('');
    expect(run.exitCode).toBe(0);
    // The script must see the media item — otherwise this test proves nothing.
    expect(JSON.parse(run.stdout.toString()).summary.itemsIndexed).toBe(1);

    const store = createWhatsAppConnectorStore(env);
    try {
      const hits = store.searchItems(TRANSCRIPT, 5);
      expect(hits).toHaveLength(1);
      expect(store.itemMetadataSnapshot(hits[0]!.sourceItem)?.contentHash).toBe(extractedHash);
    } finally {
      store.close();
    }
  }, 30_000);
});

// Runs the product lane's store pull plus the shared extraction factory, which
// is what writes the transcript chunks the script must not destroy. Returns the
// stored content hash of the extracted representation.
async function extractTranscript(
  stateDir: string,
  env: Record<string, string>,
  transcriber: string,
): Promise<string | undefined> {
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
  try {
    const source = createWhatsAppSchedulerSource({
      config: schedulerConfig(),
      sync: createWhatsAppConnectorStoreSyncHandler({ store, env }),
      fileExtraction: runtime!.runner,
      extractionPlanLimit: 1,
      extractionBatchSize: 1,
    });
    await source!.tasks[0]!.run();
    const extraction = await source!.tasks[1]!.run();
    expect(extraction.counts?.jobs_indexed).toBe(1);
    const hits = store.searchItems(TRANSCRIPT, 5);
    expect(hits).toHaveLength(1);
    return store.itemMetadataSnapshot(hits[0]!.sourceItem)?.contentHash;
  } finally {
    runtime?.close();
    store.close();
  }
}

function mediaSpoolLine(id: string, mediaPath: string): string {
  return `${JSON.stringify({
    id,
    chat_jid: 'chat-1@s.whatsapp.net',
    chat_name: 'Pilot chat',
    sender_jid: 'sender-1@s.whatsapp.net',
    sender_name: 'Pilot',
    from_me: false,
    timestamp: '2026-08-31T10:00:00Z',
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
