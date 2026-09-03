import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'bun:test';
import {
  runWhatsAppTranscribeDrain,
  statusPath,
  transcriptPath,
} from '../scripts/whatsapp-transcribe-drain.ts';
import {
  WHATSAPP_TRANSCRIPT_EXTRACTOR_KIND,
  WHATSAPP_TRANSCRIPT_EXTRACTOR_VERSION,
} from '../src/workers/whatsapp/index.ts';

describe('WhatsApp local transcription drain', () => {
  test('fake command happy path writes transcript sidecar and durable status', async () => {
    const dir = makeMediaDir();
    const audio = join(dir, 'voice-1.ogg');
    writeFileSync(audio, 'fake-audio');
    const fake = fakeCommand(`
      const input = process.argv[2];
      await Bun.write(input + '.txt', 'known local transcript\\n');
    `);

    const summary = await runWhatsAppTranscribeDrain(envFor(dir, fake));

    expect(summary).toMatchObject({
      kind: 'whatsapp_transcribe_drain',
      runs: 1,
      counts: {
        media_files_seen: 1,
        transcribed: 1,
        failed_retryable: 0,
        skipped_already_transcribed: 0,
      },
      extractor_kind: WHATSAPP_TRANSCRIPT_EXTRACTOR_KIND,
      extractor_version: WHATSAPP_TRANSCRIPT_EXTRACTOR_VERSION,
      policy: {
        local_only: true,
        cloud_asr_allowed: false,
        raw_source_exposed: false,
        source_text_returned: false,
      },
    });
    expect(readFileSync(transcriptPath(audio), 'utf8')).toBe('known local transcript\n');
    expect(statSync(transcriptPath(audio)).mode & 0o777).toBe(0o600);
    const status = JSON.parse(readFileSync(statusPath(audio), 'utf8'));
    expect(status).toMatchObject({
      kind: 'whatsapp_audio_transcription_status',
      status: 'transcribed',
      attempts: 1,
      error_class: null,
      extractor_kind: WHATSAPP_TRANSCRIPT_EXTRACTOR_KIND,
      extractor_version: WHATSAPP_TRANSCRIPT_EXTRACTOR_VERSION,
      next_retry_at: null,
    });
  });

  test('failure then retry records attempts and succeeds when backoff permits', async () => {
    const dir = makeMediaDir();
    const audio = join(dir, 'voice-2.ogg');
    const marker = join(dir, 'first-failure-marker');
    writeFileSync(audio, 'fake-audio');
    const fake = fakeCommand(`
      const input = process.argv[2];
      const marker = process.argv[3];
      if (!await fileExists(marker)) {
        await Bun.write(marker, 'failed once');
        process.exit(3);
      }
      await Bun.write(input + '.txt', 'retry transcript\\n');
      async function fileExists(path) {
        try { await Bun.file(path).arrayBuffer(); return true; } catch { return false; }
      }
    `);

    const summary = await runWhatsAppTranscribeDrain({
      ...envFor(dir, fake, marker),
      OLYMPUS_WHATSAPP_TRANSCRIBE_MAX_RUNS: '2',
      OLYMPUS_WHATSAPP_TRANSCRIBE_ERROR_BACKOFF_SECONDS: '0',
      OLYMPUS_WHATSAPP_TRANSCRIBE_STOP_WHEN_IDLE: 'false',
    });

    expect(summary.counts.failed_retryable).toBe(1);
    expect(summary.counts.transcribed).toBe(1);
    expect(readFileSync(transcriptPath(audio), 'utf8')).toBe('retry transcript\n');
    const status = JSON.parse(readFileSync(statusPath(audio), 'utf8'));
    expect(status.status).toBe('transcribed');
    expect(status.attempts).toBe(2);
    expect(status.extractor_version).toBe(WHATSAPP_TRANSCRIPT_EXTRACTOR_VERSION);
  });

  test('already-transcribed media is skipped without invoking the command', async () => {
    const dir = makeMediaDir();
    const audio = join(dir, 'voice-3.ogg');
    const called = join(dir, 'called');
    writeFileSync(audio, 'fake-audio');
    writeFileSync(transcriptPath(audio), 'existing transcript\n');
    const fake = fakeCommand(`
      await Bun.write(process.argv[3], 'called');
    `);

    const summary = await runWhatsAppTranscribeDrain(envFor(dir, fake, called));

    expect(summary.counts.skipped_already_transcribed).toBe(1);
    expect(summary.counts.transcribed).toBe(0);
    expect(existsSync(called)).toBe(false);
  });

  test('heartbeat report is counts-only', async () => {
    const dir = makeMediaDir();
    const reportPath = join(dir, 'report.json');
    const audio = join(dir, 'voice-4.ogg');
    writeFileSync(audio, 'fake-audio');
    const fake = fakeCommand(`
      const input = process.argv[2];
      await Bun.write(input + '.txt', 'report transcript\\n');
    `);

    await runWhatsAppTranscribeDrain({
      ...envFor(dir, fake),
      OLYMPUS_WHATSAPP_TRANSCRIBE_REPORT_PATH: reportPath,
    });

    const report = readFileSync(reportPath, 'utf8');
    expect(report).toContain('"transcribed": 1');
    expect(report).not.toContain(audio);
    expect(report).not.toContain('report transcript');
  });
});

function makeMediaDir(): string {
  const dir = join(mkdtempSync(join(tmpdir(), 'whatsapp-transcribe-drain-')), 'media', 'audio');
  mkdirSync(dir, { recursive: true });
  return dir;
}

function fakeCommand(source: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'whatsapp-transcribe-command-'));
  const path = join(dir, 'fake-transcriber.js');
  writeFileSync(path, source);
  chmodSync(path, 0o700);
  return path;
}

function envFor(mediaDir: string, fakePath: string, extraArg?: string): Record<string, string> {
  return {
    OLYMPUS_WHATSAPP_TRANSCRIBE_MEDIA_DIR: mediaDir,
    OLYMPUS_WHATSAPP_TRANSCRIBE_MAX_RUNS: '1',
    OLYMPUS_WHATSAPP_TRANSCRIBE_STOP_WHEN_IDLE: 'true',
    OLYMPUS_WHATSAPP_TRANSCRIBE_IDLE_SLEEP_SECONDS: '0',
    OLYMPUS_TRANSCRIBE_COMMAND: `${process.execPath} ${fakePath} {input}${extraArg ? ` ${extraArg}` : ''}`,
  };
}
