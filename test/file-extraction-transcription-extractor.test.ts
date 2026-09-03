// B7 parity: the transcription lane.
//
// The temp-file policy gets real assertions rather than a comment: the
// production result carried a `temp_bytes_cleaned: true` guarantee that has no
// field on the landed seam, so it is pinned here on the success path, the
// throw path, and the supplied-path path where the cleanup must NOT happen.

import { describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  ExtractionCommandError,
  ExtractionCommandTimeoutError,
  type ExtractionCommandRunner,
} from '../src/workers/file-extraction/extractors/command-runner.ts';
import {
  MAX_TRANSCRIPT_CHARS,
  TRANSCRIPTION_EXTRACTOR_KIND,
  TRANSCRIPTION_EXTRACTOR_VERSION,
  WhisperCommandTranscriber,
  createTranscriptionExtractor,
  normalizeTranscriptText,
  parseTranscriberArgvTemplate,
  sidecarPathForInput,
  tempAudioFileName,
  type Transcriber,
} from '../src/workers/file-extraction/extractors/transcription.ts';
import { extractorInput, textBytes } from './fixtures/file-extraction-extractor-fixtures.ts';

const AUDIO_MIME = 'audio/mpeg';

function recordingTranscriber(
  transcribe: (inputPath: string) => Promise<{ text: string; language?: string }>,
): Transcriber & { paths: string[] } {
  const paths: string[] = [];
  return {
    paths,
    async transcribe(input) {
      paths.push(input.inputPath);
      return transcribe(input.inputPath);
    },
  };
}

describe('transcription extractor: registry surface', () => {
  test('declares the live kind, version, byte need and egress', () => {
    const extractor = createTranscriptionExtractor();
    expect(extractor.kind).toBe(TRANSCRIPTION_EXTRACTOR_KIND);
    expect(extractor.kind).toBe('whisper_transcription');
    expect(extractor.version).toBe(TRANSCRIPTION_EXTRACTOR_VERSION);
    expect(extractor.version).toBe('2026-06-12');
    expect(extractor.needsBytes).toBe(true);
    expect(extractor.egress).toBe('local');
  });

  test('accepts audio and video containers by mime and by extension', () => {
    const extractor = createTranscriptionExtractor();
    expect(extractor.accepts('audio/mpeg')).toBe(true);
    expect(extractor.accepts('audio/x-m4a')).toBe(true);
    expect(extractor.accepts('video/quicktime')).toBe(true);
    expect(extractor.accepts('application/octet-stream', 'voice memo.m4a')).toBe(true);
    expect(extractor.accepts(undefined, 'clip.MOV')).toBe(true);
    expect(extractor.accepts('text/plain')).toBe(false);
    expect(extractor.accepts(undefined, 'notes.txt')).toBe(false);
    expect(extractor.accepts(undefined)).toBe(false);
  });
});

describe('transcription extractor: transcripts', () => {
  test('indexes a transcript as a transcript derivation', async () => {
    const transcriber = recordingTranscriber(async () => ({ text: 'Spoken words, written down.' }));
    const result = await createTranscriptionExtractor({ transcriber }).extract(extractorInput({
      bytes: textBytes('audio bytes'),
      mimeType: AUDIO_MIME,
    }));
    expect(result.status).toBe('indexed');
    if (result.status !== 'indexed') return;
    expect(result.text).toBe('Spoken words, written down.');
    const derivation = result.derivations?.[0];
    expect(derivation?.artifactKind).toBe('transcript');
    expect(derivation?.structuralRef).toMatchObject({
      kind: 'whole_file',
      label: 'audio transcript',
    });
    expect(derivation?.chars).toBe('Spoken words, written down.'.length);
    expect(derivation?.structuralRef).not.toHaveProperty('language');
  });

  test('a detected language rides structuralRef rather than being dropped', async () => {
    const transcriber = recordingTranscriber(async () => ({
      text: 'Bonjour tout le monde.',
      language: 'fr',
    }));
    const result = await createTranscriptionExtractor({ transcriber }).extract(extractorInput({
      bytes: textBytes('audio bytes'),
      mimeType: AUDIO_MIME,
    }));
    if (result.status !== 'indexed') throw new Error('expected indexed');
    expect(result.derivations?.[0]?.structuralRef).toMatchObject({
      kind: 'whole_file',
      label: 'audio transcript',
      language: 'fr',
    });
  });

  test('an empty transcript is empty output, never an indexed empty string', async () => {
    const transcriber = recordingTranscriber(async () => ({ text: '   \n  ' }));
    const result = await createTranscriptionExtractor({ transcriber }).extract(extractorInput({
      bytes: textBytes('audio bytes'),
      mimeType: AUDIO_MIME,
    }));
    expect(result.status).toBe('empty_output');
    expect(result).not.toHaveProperty('text');
  });

  test('the transcript is capped at the character ceiling', async () => {
    const transcriber = recordingTranscriber(async () => ({ text: 'abcdefghij' }));
    const result = await createTranscriptionExtractor({
      transcriber,
      maxTranscriptChars: 4,
    }).extract(extractorInput({ bytes: textBytes('audio'), mimeType: AUDIO_MIME }));
    expect(result.status).toBe('indexed');
    if (result.status !== 'indexed') return;
    expect(result.text).toBe('abcd');
    expect(MAX_TRANSCRIPT_CHARS).toBe(200_000);
  });

  test('a timeout and a non-zero exit are both retryable, under distinct tokens', async () => {
    const timingOut: ExtractionCommandRunner = async () => {
      throw new ExtractionCommandTimeoutError({ command: 'transcribe', timeoutMs: 5 });
    };
    const timedOut = await createTranscriptionExtractor({
      command: 'transcribe {input}',
      commandRunner: timingOut,
    }).extract(extractorInput({ bytes: textBytes('audio'), mimeType: AUDIO_MIME }));
    expect(timedOut.status).toBe('failed_retryable');
    if (timedOut.status !== 'failed_retryable') return;
    expect(timedOut.errorKind).toBe('transcribe_command_timeout');

    const failing: ExtractionCommandRunner = async () => {
      throw new ExtractionCommandError({
        command: 'transcribe',
        exitCode: 3,
        stdout: '',
        stderr: 'model file /home/private/model.bin missing',
      });
    };
    const failed = await createTranscriptionExtractor({
      command: 'transcribe {input}',
      commandRunner: failing,
    }).extract(extractorInput({ bytes: textBytes('audio'), mimeType: AUDIO_MIME }));
    expect(failed.status).toBe('failed_retryable');
    if (failed.status !== 'failed_retryable') return;
    expect(failed.errorKind).toBe('transcribe_command_failed');
    expect(JSON.stringify(failed)).not.toContain('/home/private');
  });

  test('an unconfigured transcriber is retryable under a bounded token', async () => {
    const result = await createTranscriptionExtractor().extract(extractorInput({
      bytes: textBytes('audio'),
      mimeType: AUDIO_MIME,
    }));
    expect(result.status).toBe('failed_retryable');
    if (result.status !== 'failed_retryable') return;
    expect(result.errorKind).toBe('transcriber_not_configured');
  });

  test('neither bytes nor a path is a terminal invariant failure', async () => {
    const transcriber = recordingTranscriber(async () => ({ text: 'unused' }));
    const result = await createTranscriptionExtractor({ transcriber }).extract(extractorInput({
      mimeType: AUDIO_MIME,
    }));
    expect(result.status).toBe('failed_terminal');
    expect(transcriber.paths).toHaveLength(0);
  });
});

describe('transcription extractor: the temp-file policy', () => {
  test('the spilled temp directory is removed on the success path', async () => {
    const transcriber = recordingTranscriber(async (path) => {
      expect(existsSync(path)).toBe(true);
      return { text: 'transcribed' };
    });
    const result = await createTranscriptionExtractor({ transcriber }).extract(extractorInput({
      bytes: textBytes('audio bytes'),
      mimeType: AUDIO_MIME,
    }));
    expect(result.status).toBe('indexed');
    const spilled = transcriber.paths[0]!;
    expect(existsSync(spilled)).toBe(false);
    expect(existsSync(dirname(spilled))).toBe(false);
  });

  test('the spilled temp directory is removed on the throw path too', async () => {
    const seen: string[] = [];
    const transcriber: Transcriber = {
      async transcribe(input) {
        seen.push(input.inputPath);
        throw new Error('transcriber blew up mid-run');
      },
    };
    const result = await createTranscriptionExtractor({ transcriber }).extract(extractorInput({
      bytes: textBytes('audio bytes'),
      mimeType: AUDIO_MIME,
    }));
    expect(result.status).toBe('failed_retryable');
    expect(seen).toHaveLength(1);
    expect(existsSync(dirname(seen[0]!))).toBe(false);
  });

  test('the spilled bytes are exactly what was handed in', async () => {
    let observed = '';
    const transcriber = recordingTranscriber(async (path) => {
      observed = await readFile(path, 'utf8');
      return { text: 'ok' };
    });
    await createTranscriptionExtractor({ transcriber }).extract(extractorInput({
      bytes: textBytes('the audio payload'),
      mimeType: AUDIO_MIME,
    }));
    expect(observed).toBe('the audio payload');
  });

  test('a supplied localPath is used and is NOT removed', async () => {
    const ownedDir = await mkdtemp(join(tmpdir(), 'olympus-transcribe-owner-'));
    const ownedPath = join(ownedDir, 'supplied.m4a');
    await writeFile(ownedPath, 'runner-owned bytes', 'utf8');
    try {
      const transcriber = recordingTranscriber(async () => ({ text: 'from the supplied path' }));
      const result = await createTranscriptionExtractor({ transcriber }).extract(extractorInput({
        bytes: textBytes('audio bytes'),
        localPath: ownedPath,
        mimeType: AUDIO_MIME,
      }));
      expect(result.status).toBe('indexed');
      expect(transcriber.paths).toEqual([ownedPath]);
      expect(existsSync(ownedPath)).toBe(true);
      expect(await readFile(ownedPath, 'utf8')).toBe('runner-owned bytes');
    } finally {
      await rm(ownedDir, { recursive: true, force: true });
    }
  });

  test('a supplied localPath survives a throwing transcriber', async () => {
    const ownedDir = await mkdtemp(join(tmpdir(), 'olympus-transcribe-owner-'));
    const ownedPath = join(ownedDir, 'supplied.wav');
    await writeFile(ownedPath, 'runner-owned bytes', 'utf8');
    try {
      const transcriber: Transcriber = {
        async transcribe() {
          throw new Error('boom');
        },
      };
      const result = await createTranscriptionExtractor({ transcriber }).extract(extractorInput({
        bytes: textBytes('audio bytes'),
        localPath: ownedPath,
        mimeType: AUDIO_MIME,
      }));
      expect(result.status).toBe('failed_retryable');
      expect(existsSync(ownedPath)).toBe(true);
    } finally {
      await rm(ownedDir, { recursive: true, force: true });
    }
  });

  test('a supplied localPath means no bytes are spilled at all', async () => {
    const ownedDir = await mkdtemp(join(tmpdir(), 'olympus-transcribe-owner-'));
    const ownedPath = join(ownedDir, 'supplied.mp3');
    await writeFile(ownedPath, 'runner-owned bytes', 'utf8');
    try {
      const transcriber = recordingTranscriber(async (path) => ({
        text: await readFile(path, 'utf8'),
      }));
      const result = await createTranscriptionExtractor({ transcriber }).extract(extractorInput({
        bytes: textBytes('these bytes must not be written anywhere'),
        localPath: ownedPath,
        mimeType: AUDIO_MIME,
      }));
      if (result.status !== 'indexed') throw new Error('expected indexed');
      expect(result.text).toBe('runner-owned bytes');
    } finally {
      await rm(ownedDir, { recursive: true, force: true });
    }
  });
});

describe('transcription extractor: the command-backed transcriber', () => {
  test('prefers a sidecar transcript next to the input', async () => {
    const runner: ExtractionCommandRunner = async (request) => {
      const inputPath = request.args[request.args.length - 1]!;
      await writeFile(`${inputPath}.txt`, 'sidecar transcript\n\n\n\nsecond part', 'utf8');
      return { stdout: 'stdout transcript that must lose', stderr: '' };
    };
    const result = await createTranscriptionExtractor({
      command: 'transcribe --out {input}',
      commandRunner: runner,
    }).extract(extractorInput({ bytes: textBytes('audio'), mimeType: AUDIO_MIME }));
    expect(result.status).toBe('indexed');
    if (result.status !== 'indexed') return;
    expect(result.text).toBe('sidecar transcript\n\nsecond part');
  });

  test('accepts the stem-replaced sidecar spelling as well', async () => {
    const runner: ExtractionCommandRunner = async (request) => {
      const inputPath = request.args[request.args.length - 1]!;
      await writeFile(sidecarPathForInput(inputPath), 'stem sidecar transcript', 'utf8');
      return { stdout: '', stderr: '' };
    };
    const result = await createTranscriptionExtractor({
      command: 'transcribe {input}',
      commandRunner: runner,
    }).extract(extractorInput({ bytes: textBytes('audio'), mimeType: AUDIO_MIME }));
    expect(result.status).toBe('indexed');
    if (result.status !== 'indexed') return;
    expect(result.text).toBe('stem sidecar transcript');
  });

  test('falls back to stdout when no sidecar appears', async () => {
    const runner: ExtractionCommandRunner = async () => ({
      stdout: 'stdout transcript',
      stderr: '',
    });
    const result = await createTranscriptionExtractor({
      command: 'transcribe {input}',
      commandRunner: runner,
    }).extract(extractorInput({ bytes: textBytes('audio'), mimeType: AUDIO_MIME }));
    expect(result.status).toBe('indexed');
    if (result.status !== 'indexed') return;
    expect(result.text).toBe('stdout transcript');
  });

  test('every {input} token in the template is substituted', async () => {
    let observed: string[] = [];
    const runner: ExtractionCommandRunner = async (request) => {
      observed = [request.command, ...request.args];
      return { stdout: 'done', stderr: '' };
    };
    await new WhisperCommandTranscriber({
      command: 'wrap --in {input} --also {input}',
      commandRunner: runner,
    }).transcribe({ inputPath: '/tmp/example.m4a' });
    expect(observed).toEqual(['wrap', '--in', '/tmp/example.m4a', '--also', '/tmp/example.m4a']);
  });

  test('the template must be non-empty and must carry the placeholder', () => {
    expect(() => parseTranscriberArgvTemplate('   ')).toThrow(/non-empty command template/);
    expect(() => parseTranscriberArgvTemplate('transcribe --fast'))
      .toThrow(/\{input\} placeholder/);
    expect(parseTranscriberArgvTemplate('  transcribe   {input}  '))
      .toEqual(['transcribe', '{input}']);
  });
});

describe('transcription extractor: name and text helpers', () => {
  test('the temp audio name is sanitized and keeps a plausible extension', () => {
    expect(tempAudioFileName('job-1', 'Voice Memo.M4A')).toBe('audio-job-1.m4a');
    expect(tempAudioFileName('job/../2', 'clip.mp3')).toBe('audio-job2.mp3');
    expect(tempAudioFileName('job-3', 'no-extension')).toBe('audio-job-3.audio');
    expect(tempAudioFileName('job-4', undefined)).toBe('audio-job-4.audio');
    expect(tempAudioFileName('job-5', 'weird.thisistoolongtobeanext')).toBe('audio-job-5.audio');
  });

  test('the sidecar path swaps the extension for .txt', () => {
    expect(sidecarPathForInput('/tmp/dir/audio-job-1.m4a')).toBe('/tmp/dir/audio-job-1.txt');
    expect(sidecarPathForInput('/tmp/dir/noext')).toBe('/tmp/dir/noext.txt');
  });

  test('transcript normalization strips nulls and caps blank runs', () => {
    expect(normalizeTranscriptText('  a\r\nb\n\n\n\nc  ')).toBe('a\nb\n\nc');
  });
});
