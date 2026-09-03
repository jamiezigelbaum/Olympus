import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'bun:test';
import { runWhatsAppTranscribeDrain, transcriptPath } from '../scripts/whatsapp-transcribe-drain.ts';

describe('WhatsApp transcription drain durability', () => {
  test('a zero-byte transcript sidecar is retranscribed, not counted as done', async () => {
    const dir = makeMediaDir();
    const audio = join(dir, 'voice-crash.ogg');
    writeFileSync(audio, 'fake-audio');
    // What an unclean shutdown leaves behind: the sidecar exists and holds
    // nothing. Existence alone must not mean the work finished, or the message
    // keeps that empty text forever.
    writeFileSync(transcriptPath(audio), '');
    const fake = fakeCommand(`
      const input = process.argv[2];
      await Bun.write(input + '.txt', 'recovered local transcript\\n');
    `);

    const summary = await runWhatsAppTranscribeDrain(envFor(dir, fake));

    expect(summary.counts.transcribed).toBe(1);
    expect(summary.counts.skipped_already_transcribed).toBe(0);
    expect(readFileSync(transcriptPath(audio), 'utf8')).toBe('recovered local transcript\n');
  });

  test('a completed pass leaves no partial sidecar behind', async () => {
    const dir = makeMediaDir();
    const audio = join(dir, 'voice-ok.ogg');
    writeFileSync(audio, 'fake-audio');
    const fake = fakeCommand(`
      const input = process.argv[2];
      await Bun.write(input + '.txt', 'known local transcript\\n');
    `);

    const summary = await runWhatsAppTranscribeDrain(envFor(dir, fake));

    expect(summary.counts.transcribed).toBe(1);
    expect(readdirSync(dir).filter((name) => name.endsWith('.tmp'))).toEqual([]);
    expect(readFileSync(transcriptPath(audio), 'utf8')).toBe('known local transcript\n');
  });
});

function makeMediaDir(): string {
  const dir = join(mkdtempSync(join(tmpdir(), 'whatsapp-transcribe-durability-')), 'media', 'audio');
  mkdirSync(dir, { recursive: true });
  return dir;
}

function fakeCommand(source: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'whatsapp-transcribe-durability-command-'));
  const path = join(dir, 'fake-transcriber.js');
  writeFileSync(path, source);
  chmodSync(path, 0o700);
  return path;
}

function envFor(mediaDir: string, fakePath: string): Record<string, string> {
  return {
    OLYMPUS_WHATSAPP_TRANSCRIBE_MEDIA_DIR: mediaDir,
    OLYMPUS_WHATSAPP_TRANSCRIBE_MAX_RUNS: '1',
    OLYMPUS_WHATSAPP_TRANSCRIBE_STOP_WHEN_IDLE: 'true',
    OLYMPUS_WHATSAPP_TRANSCRIBE_IDLE_SLEEP_SECONDS: '0',
    OLYMPUS_TRANSCRIBE_COMMAND: `${process.execPath} ${fakePath} {input}`,
  };
}
