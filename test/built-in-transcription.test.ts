// Built-in transcription (Qwen3-ASR 0.6B on the pinned llama-server).
//
// Everything here runs with fakes: no download, no server, no decoder. The
// real model is exercised by the opt-in end-to-end check recorded in
// docs/design/built-in-transcription.md.

import { afterEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  encodeWav16Mono,
  parseWav16Mono,
  planAudioChunks,
  WavFormatError,
} from '../src/workers/file-extraction/extractors/audio-wav.ts';
import {
  AudioUndecodableError,
  TRANSCRIPT_TIME_BUDGET_WARNING,
  TranscriberPendingError,
  TranscriberUnavailableError,
  createBuiltInTranscriber,
  defaultAudioConverter,
  parseAsrOutput,
  runningBuiltInTranscriber,
  sharedBuiltInTranscriber,
  transcriptionDeadlineFromLease,
  wireBuiltInTranscriptionAtBoot,
  type AudioConverter,
} from '../src/workers/file-extraction/extractors/built-in-transcriber.ts';
import { SourceScheduler } from '../src/workers/source-scheduler.ts';
import { ExtractionCommandError } from '../src/workers/file-extraction/extractors/command-runner.ts';
import {
  LEGACY_TRANSCRIBER_NOT_CONFIGURED_KIND,
  TRANSCRIBER_SETTING_UP_WARNING,
  TRANSCRIPTION_EXTRACTOR_KIND,
  TRANSCRIPTION_REQUIRED_WARNING,
  createTranscriptionExtractor,
} from '../src/workers/file-extraction/extractors/transcription.ts';
import { LocalFileExtractionJobStore } from '../src/workers/file-extraction/job-store.ts';
import { buildExtractorRegistry } from '../src/workers/file-extraction/registry.ts';
import { createFileExtractionRunner } from '../src/workers/file-extraction/runner.ts';
import type {
  BuiltInTranscriptionEngine,
  Extractor,
  ExtractorOutput,
} from '../src/workers/file-extraction/types.ts';
import { BuiltInReasoningInstallError, installBuiltInReasoning } from '../src/workers/source-index/built-in-reasoning/install.ts';
import {
  QWEN35_4B,
  QWEN3_ASR_06B,
  type LlamaServerRuntimeSpec,
} from '../src/workers/source-index/built-in-reasoning/manifest.ts';
import { llamaServerArguments, type LlamaServerHandle, type LlamaServerLaunch } from '../src/workers/source-index/built-in-reasoning/server.ts';
import {
  builtInTranscriptionEnabled,
  builtInTranscriptionLayout,
  installBuiltInTranscription,
  readBuiltInTranscriptionStatus,
} from '../src/workers/source-index/built-in-reasoning/transcription-model.ts';
import { stopBuiltInModelOnShutdown } from '../src/workers/email-source/server.ts';
import { extractorInput } from './fixtures/file-extraction-extractor-fixtures.ts';

const roots: string[] = [];
afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'olympus-asr-test-'));
  roots.push(dir);
  return dir;
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** Speech-like noise for `speech` seconds, then `silence` seconds of silence, repeated. */
function syntheticAudio(pattern: Array<{ speech?: number; silence?: number }>, rate = 16_000): Int16Array {
  const parts: number[] = [];
  let seed = 7;
  for (const part of pattern) {
    for (let i = 0; i < Math.round((part.speech ?? 0) * rate); i += 1) {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      parts.push((seed % 16000) - 8000);
    }
    for (let i = 0; i < Math.round((part.silence ?? 0) * rate); i += 1) parts.push(0);
  }
  return Int16Array.from(parts);
}

function engineStub(overrides: Partial<BuiltInTranscriptionEngine> = {}): BuiltInTranscriptionEngine & { calls: number } {
  const stub = {
    calls: 0,
    prepare: () => 'ready' as const,
    async stop() {},
    async transcribe() {
      stub.calls += 1;
      return { text: 'built-in words', language: 'English' };
    },
    ...overrides,
  };
  return stub;
}

const audioInput = () => extractorInput({
  bytes: new Uint8Array([1, 2, 3]),
  mimeType: 'audio/mp4',
  ref: { name: 'note.m4a', mimeType: 'audio/mp4' },
  job: { extractorKind: TRANSCRIPTION_EXTRACTOR_KIND },
});

describe('engine selection', () => {
  test('an owner-configured command wins over the built-in engine', async () => {
    const builtIn = engineStub();
    const extractor = createTranscriptionExtractor({
      builtIn,
      transcriber: { async transcribe() { return { text: 'command words' }; } },
    });
    const output = await extractor.extract(audioInput());
    expect(output).toMatchObject({ status: 'indexed', text: 'command words' });
    expect(builtIn.calls).toBe(0);
  });

  test('with no command, the built-in engine reads the audio', async () => {
    const builtIn = engineStub();
    const output = await createTranscriptionExtractor({ builtIn }).extract(audioInput());
    expect(output).toMatchObject({ status: 'indexed', text: 'built-in words' });
    expect(builtIn.calls).toBe(1);
  });

  test('the job lease, less a margin, is the transcription deadline', async () => {
    let seen: number | undefined;
    const builtIn = engineStub({
      async transcribe(input) {
        seen = input.deadlineAt;
        return { text: 'words' };
      },
    });
    const input = audioInput();
    const leaseExpiresAt = new Date(Date.now() + 900_000).toISOString();
    await createTranscriptionExtractor({ builtIn }).extract({ ...input, job: { ...input.job, leaseExpiresAt } });
    expect(seen).toBe(Date.parse(leaseExpiresAt) - 60_000);
    expect(transcriptionDeadlineFromLease('not a time')).toBeUndefined();
  });

  test('with neither, audio is a named gap and the lane has no reread policy', async () => {
    const extractor = createTranscriptionExtractor();
    expect(extractor.reread).toBeUndefined();
    const output = await extractor.extract(audioInput());
    expect(output.status).toBe('metadata_only');
    expect(output.warnings).toEqual([TRANSCRIPTION_REQUIRED_WARNING]);
  });

  test('while the model installs, audio settles unread without a retry and says it is being set up', async () => {
    const builtIn = engineStub({
      prepare: () => 'pending',
      async transcribe() { throw new TranscriberPendingError('installing'); },
    });
    const extractor = createTranscriptionExtractor({ builtIn });
    const output = await extractor.extract(audioInput());
    expect(output.status).toBe('metadata_only');
    expect(output.warnings).toEqual([TRANSCRIPTION_REQUIRED_WARNING, TRANSCRIBER_SETTING_UP_WARNING]);
    expect(output.derivations?.[0]?.warnings).toEqual([TRANSCRIPTION_REQUIRED_WARNING, TRANSCRIBER_SETTING_UP_WARNING]);
    expect(extractor.reread?.unreadWarnings).toEqual([TRANSCRIPTION_REQUIRED_WARNING]);
    expect(extractor.reread?.notReadyWarnings).toEqual([TRANSCRIBER_SETTING_UP_WARNING]);
    expect(extractor.reread?.unreadTerminalErrorKinds).toEqual([LEGACY_TRANSCRIBER_NOT_CONFIGURED_KIND]);
    expect(extractor.reread?.prepare()).toBe('pending');
  });

  test('an unavailable engine is remembered: later files never reach it', async () => {
    const builtIn = engineStub({
      async transcribe() {
        builtIn.calls += 1;
        throw new TranscriberUnavailableError('no decoder');
      },
    });
    const extractor = createTranscriptionExtractor({ builtIn });
    const first = await extractor.extract(audioInput());
    const second = await extractor.extract(audioInput());
    expect(first.status).toBe('metadata_only');
    expect(second.status).toBe('metadata_only');
    expect(builtIn.calls).toBe(1);
  });

  test('undecodable audio is terminal; an engine fault is retryable', async () => {
    const undecodable = createTranscriptionExtractor({
      builtIn: engineStub({ async transcribe() { throw new AudioUndecodableError('bad'); } }),
    });
    expect(await undecodable.extract(audioInput())).toEqual({ status: 'failed_terminal', errorKind: 'transcribe_audio_undecodable' });
    const faulty = createTranscriptionExtractor({
      builtIn: engineStub({ async transcribe() { throw new Error('HTTP 500'); } }),
    });
    expect(await faulty.extract(audioInput())).toEqual({ status: 'failed_retryable', errorKind: 'transcriber_failed' });
  });

  test('on by default on Apple silicon only; the env switch wins; no runtime, no engine', () => {
    expect(builtInTranscriptionEnabled({}, 'darwin-arm64')).toBe(true);
    expect(builtInTranscriptionEnabled({}, 'linux-x64')).toBe(false);
    expect(builtInTranscriptionEnabled({ OLYMPUS_BUILT_IN_TRANSCRIPTION: 'on' }, 'linux-x64')).toBe(true);
    expect(builtInTranscriptionEnabled({ OLYMPUS_BUILT_IN_TRANSCRIPTION: 'off' }, 'darwin-arm64')).toBe(false);
    expect(builtInTranscriptionEnabled({ OLYMPUS_BUILT_IN_TRANSCRIPTION: 'on' }, 'win32-x64')).toBe(false);
  });
});

describe('audio conversion, chunking and stitching', () => {
  test('WAV round-trips, and chunks past padding are found', () => {
    const samples = syntheticAudio([{ speech: 0.5 }]);
    const wav = encodeWav16Mono(samples, 16_000);
    expect(parseWav16Mono(wav).samples).toEqual(samples);
    // The system encoder writes a padding chunk before the data.
    const padded = new Uint8Array(wav.length + 12);
    padded.set(wav.subarray(0, 36), 0);
    padded.set(new TextEncoder().encode('FLLR'), 36);
    new DataView(padded.buffer).setUint32(40, 4, true);
    padded.set(wav.subarray(36), 48);
    expect(parseWav16Mono(padded).samples).toEqual(samples);
    expect(() => parseWav16Mono(new Uint8Array(10))).toThrow(WavFormatError);
  });

  test('chunks stay under the limit, cover every sample, and cut in the quiet', () => {
    // 25 s speech, 1 s silence, 25 s speech, 1 s silence, 10 s speech.
    const samples = syntheticAudio([{ speech: 25, silence: 1 }, { speech: 25, silence: 1 }, { speech: 10 }]);
    const chunks = planAudioChunks({ sampleRate: 16_000, samples }, { maxSeconds: 30 });
    expect(chunks.length).toBe(3);
    expect(chunks[0]!.start).toBe(0);
    expect(chunks.at(-1)!.end).toBe(samples.length);
    for (let i = 1; i < chunks.length; i += 1) expect(chunks[i]!.start).toBe(chunks[i - 1]!.end);
    for (const chunk of chunks) expect(chunk.end - chunk.start).toBeLessThanOrEqual(30 * 16_000);
    // The first cut falls inside the first silence (25 s to 26 s).
    expect(chunks[0]!.end).toBeGreaterThanOrEqual(25 * 16_000);
    expect(chunks[0]!.end).toBeLessThanOrEqual(26 * 16_000);
  });

  test('Qwen3-ASR output is split into words and language; "None" means no speech', () => {
    expect(parseAsrOutput('language English<asr_text>Hello there.')).toEqual({ text: 'Hello there.', language: 'English' });
    expect(parseAsrOutput('language None<asr_text>')).toEqual({ text: '' });
    expect(parseAsrOutput('plain words')).toEqual({ text: 'plain words' });
  });

  test('the macOS converter is the system afconvert to 16 kHz mono; a decode failure is terminal, a missing tool is unavailability', async () => {
    const seen: Array<{ command: string; args: string[] }> = [];
    const ok = defaultAudioConverter('darwin-arm64', async (request) => {
      seen.push(request);
      return { stdout: '', stderr: '' };
    });
    await ok('/in.ogg', '/out.wav');
    expect(seen[0]).toEqual({ command: '/usr/bin/afconvert', args: ['-f', 'WAVE', '-d', 'LEI16@16000', '-c', '1', '/in.ogg', '/out.wav'], timeoutMs: 300_000 } as never);
    const bad = defaultAudioConverter('darwin-arm64', async () => {
      throw new ExtractionCommandError({ command: 'afconvert', exitCode: 1, stdout: '', stderr: 'fmt?' } as never);
    });
    await expect(bad('/in', '/out')).rejects.toBeInstanceOf(AudioUndecodableError);
    const missing = defaultAudioConverter('linux-x64', async () => {
      throw Object.assign(new Error('spawn ffmpeg ENOENT'), { code: 'ENOENT' });
    });
    await expect(missing('/in', '/out')).rejects.toBeInstanceOf(TranscriberUnavailableError);
  });
});

describe('the built-in transcriber with a fake model', () => {
  const installed = { modelPath: '/m/model.gguf', mmprojPath: '/m/mmproj.gguf', serverPath: '/rt/llama-server', gpu: true };

  function fakeServer(): LlamaServerHandle & { launches: LlamaServerLaunch[]; touches: number } {
    const handle = {
      launches: [] as LlamaServerLaunch[],
      touches: 0,
      pid: 4242 as number | undefined,
      async ensureRunning() { return { baseUrl: 'http://127.0.0.1:49999', token: 'secret' }; },
      touch() { handle.touches += 1; },
      async stop() {},
    };
    return handle;
  }

  function fakeConverter(samples: Int16Array): AudioConverter & { inputs: string[] } {
    const inputs: string[] = [];
    const convert = Object.assign(async (input: string, output: string) => {
      inputs.push(input);
      await writeFile(output, encodeWav16Mono(samples, 16_000));
    }, { inputs });
    return convert;
  }

  test('installs on first need, then reads each spoken chunk once, in order, and stitches them', async () => {
    let finishInstall!: () => void;
    const installGate = new Promise<void>((resolve) => { finishInstall = resolve; });
    const server = fakeServer();
    const bodies: Array<Record<string, unknown>> = [];
    let chunkNumber = 0;
    const fetchImpl = (async (_url: RequestInfo | URL, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)));
      chunkNumber += 1;
      return Response.json({ choices: [{ message: { content: `language English<asr_text>part ${chunkNumber}.` } }] });
    }) as typeof fetch;
    // 25 s speech, 1 s silence, 31 s of silence, 10 s speech: the middle chunk is silent.
    const samples = syntheticAudio([{ speech: 25, silence: 1 }, { silence: 31 }, { speech: 10 }]);
    const engine = createBuiltInTranscriber({
      env: { OLYMPUS_BUILT_IN_TRANSCRIPTION_DIR: tempDir(), OLYMPUS_BUILT_IN_REASONING_DIR: tempDir() },
      platform: 'darwin-arm64',
      totalMemoryBytes: 16 * 1024 ** 3,
      install: async () => { await installGate; return installed; },
      createServer: (launch) => { server.launches.push(launch); return server; },
      fetchImpl,
      convert: fakeConverter(samples),
    });
    expect(engine.prepare()).toBe('pending');
    await expect(engine.transcribe({ inputPath: '/audio/note.m4a' })).rejects.toBeInstanceOf(TranscriberPendingError);
    finishInstall();
    await installGate;
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(engine.prepare()).toBe('ready');
    const result = await engine.transcribe({ inputPath: '/audio/note.m4a' });
    expect(result).toEqual({ text: 'part 1. part 2.', language: 'English' });
    expect(bodies.length).toBe(2);
    // Audio only, deterministic: no text prompt, temperature 0.
    const message = (bodies[0]!.messages as Array<{ role: string; content: Array<{ type: string }> }>);
    expect(message.length).toBe(1);
    expect(message[0]!.content.map((part) => part.type)).toEqual(['input_audio']);
    expect(bodies[0]!.temperature).toBe(0);
    expect(server.launches[0]).toMatchObject({ mmprojPath: '/m/mmproj.gguf', modelPath: '/m/model.gguf', batchSize: 512 });
    expect(server.touches).toBe(1);
  });

  test('the per-file time budget stops a long file and says so', async () => {
    let clock = 0;
    const samples = syntheticAudio([{ speech: 90 }]);
    const engine = createBuiltInTranscriber({
      env: { OLYMPUS_BUILT_IN_TRANSCRIPTION_DIR: tempDir(), OLYMPUS_BUILT_IN_REASONING_DIR: tempDir() },
      platform: 'darwin-arm64',
      totalMemoryBytes: 16 * 1024 ** 3,
      install: async () => installed,
      createServer: () => fakeServer(),
      fetchImpl: (async () => {
        clock += 60_000;
        return Response.json({ choices: [{ message: { content: 'language English<asr_text>words' } }] });
      }) as unknown as typeof fetch,
      convert: fakeConverter(samples),
      fileDeadlineMs: 90_000,
      now: () => clock,
    });
    engine.prepare();
    await new Promise((resolve) => setTimeout(resolve, 0));
    const result = await engine.transcribe({ inputPath: '/a.m4a' });
    expect(result.text).toBe('words words');
    expect(result.warnings).toEqual([TRANSCRIPT_TIME_BUDGET_WARNING]);
  });

  test('a failed install waits out its retry window; an unsupported platform or too little memory is unavailable', async () => {
    let clock = 0;
    let attempts = 0;
    const engine = createBuiltInTranscriber({
      env: { OLYMPUS_BUILT_IN_TRANSCRIPTION_DIR: tempDir(), OLYMPUS_BUILT_IN_REASONING_DIR: tempDir() },
      platform: 'darwin-arm64',
      totalMemoryBytes: 16 * 1024 ** 3,
      install: async () => { attempts += 1; throw new BuiltInReasoningInstallError('download_failed', 'offline'); },
      installRetryMs: 1_000,
      now: () => clock,
    });
    expect(engine.prepare()).toBe('pending');
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(engine.prepare()).toBe('pending');
    expect(attempts).toBe(1);
    clock = 2_000;
    engine.prepare();
    expect(attempts).toBe(2);

    const unsupported = createBuiltInTranscriber({
      totalMemoryBytes: 16 * 1024 ** 3,
      install: async () => { throw new BuiltInReasoningInstallError('unsupported_platform', 'no'); },
    });
    unsupported.prepare();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(unsupported.prepare()).toBe('unavailable');
    await expect(unsupported.transcribe({ inputPath: '/a' })).rejects.toBeInstanceOf(TranscriberUnavailableError);

    const small = createBuiltInTranscriber({ totalMemoryBytes: 4 * 1024 ** 3, install: async () => installed });
    expect(small.prepare()).toBe('unavailable');
  });

  test('the transcription server loads the audio projector beside the model', () => {
    const args = llamaServerArguments({
      serverPath: '/rt/llama-server', modelPath: '/m/model.gguf', mmprojPath: '/m/mmproj.gguf', contextTokens: 4096,
      gpu: true, threads: 4, idleShutdownSeconds: 180, startupTimeoutMs: 1, batchSize: 512,
    }, 1234, '/tok');
    expect(args.slice(0, 4)).toEqual(['--model', '/m/model.gguf', '--mmproj', '/m/mmproj.gguf']);
    expect(args[args.indexOf('--batch-size') + 1]).toBe('512');
    expect(args[args.indexOf('--host') + 1]).toBe('127.0.0.1');
  });
});

describe('restarts, leases, backoff and shutdown', () => {
  const installed = { modelPath: '/m/model.gguf', mmprojPath: '/m/mmproj.gguf', serverPath: '/rt/llama-server', gpu: true };
  const server = (): LlamaServerHandle => ({
    pid: 1,
    async ensureRunning() { return { baseUrl: 'http://127.0.0.1:49999', token: 't' }; },
    touch() {},
    async stop() {},
  });
  const converter = (samples: Int16Array): AudioConverter => async (_input, output) => {
    await writeFile(output, encodeWav16Mono(samples, 16_000));
  };
  const answer = (async () => Response.json({ choices: [{ message: { content: 'language English<asr_text>words' } }] })) as unknown as typeof fetch;
  const base = () => ({
    env: { OLYMPUS_BUILT_IN_TRANSCRIPTION_DIR: tempDir(), OLYMPUS_BUILT_IN_REASONING_DIR: tempDir() },
    platform: 'darwin-arm64',
    totalMemoryBytes: 16 * 1024 ** 3,
    createServer: () => server(),
    fetchImpl: answer,
  });

  test('after a restart, with the model on disk, a file waits for the checksum pass instead of settling unread', async () => {
    const engine = createBuiltInTranscriber({
      ...base(),
      // The fresh process's install is only the checksum pass over files already on disk.
      install: async () => { await new Promise((resolve) => setTimeout(resolve, 30)); return installed; },
      filesOnDisk: () => true,
      convert: converter(syntheticAudio([{ speech: 3 }])),
    });
    const result = await engine.transcribe({ inputPath: '/a.m4a' });
    expect(result.text).toBe('words');

    const fresh = createBuiltInTranscriber({
      ...base(),
      install: () => new Promise(() => undefined),
      filesOnDisk: () => false,
      convert: converter(syntheticAudio([{ speech: 3 }])),
    });
    await expect(fresh.transcribe({ inputPath: '/a.m4a' })).rejects.toBeInstanceOf(TranscriberPendingError);
  });

  test('the deadline (the lease) stops a long file between chunks and keeps the partial transcript', async () => {
    let clock = 1_000_000;
    const engine = createBuiltInTranscriber({
      ...base(),
      install: async () => installed,
      convert: converter(syntheticAudio([{ speech: 90 }])),
      fetchImpl: (async () => {
        clock += 40_000;
        return Response.json({ choices: [{ message: { content: 'language English<asr_text>words' } }] });
      }) as unknown as typeof fetch,
      now: () => clock,
    });
    engine.prepare();
    await new Promise((resolve) => setTimeout(resolve, 0));
    const result = await engine.transcribe({ inputPath: '/a.m4a', deadlineAt: clock + 50_000 });
    expect(result.text).toBe('words words');
    expect(result.warnings).toEqual([TRANSCRIPT_TIME_BUDGET_WARNING]);
  });

  test('repeated install failures back off exponentially up to the ceiling', async () => {
    let clock = 0;
    let attempts = 0;
    const engine = createBuiltInTranscriber({
      ...base(),
      install: async () => { attempts += 1; throw new BuiltInReasoningInstallError('checksum_mismatch', 'bad'); },
      installRetryMs: 1_000,
      installRetryCeilingMs: 3_000,
      now: () => clock,
    });
    const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
    engine.prepare(); await settle();
    expect(attempts).toBe(1);
    clock += 1_000; engine.prepare(); await settle();
    expect(attempts).toBe(2);
    clock += 1_500; engine.prepare(); await settle();
    expect(attempts).toBe(2); // second failure waits 2 s
    clock += 500; engine.prepare(); await settle();
    expect(attempts).toBe(3);
    clock += 3_000; engine.prepare(); await settle();
    expect(attempts).toBe(4); // capped at 3 s, not 4 s
  });

  test('worker shutdown stops the process\'s built-in transcriber', async () => {
    const shared = sharedBuiltInTranscriber({ OLYMPUS_BUILT_IN_TRANSCRIPTION: 'on' });
    if (!shared) return; // no pinned runtime for this platform
    expect(runningBuiltInTranscriber()).toBe(shared);
    let stops = 0;
    const original = shared.stop;
    shared.stop = async () => { stops += 1; };
    try {
      stopBuiltInModelOnShutdown(runningBuiltInTranscriber());
      expect(stops).toBe(1);
    } finally {
      shared.stop = original;
    }
  });
});

describe('install: pinned files and the shared runtime', () => {
  test('the transcription model is pinned to a commit, Apache-2.0, with both files by size and digest', () => {
    expect(QWEN3_ASR_06B.license).toBe('Apache-2.0');
    expect(QWEN3_ASR_06B.revision).toMatch(/^[0-9a-f]{40}$/);
    for (const file of QWEN3_ASR_06B.files) {
      expect(file.url).toContain(`/resolve/${QWEN3_ASR_06B.revision}/`);
      expect(file.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(file.bytes).toBeGreaterThan(100_000_000);
    }
  });

  test('installs both files into its own directory and reuses the runtime the reasoning model installed', async () => {
    const runtimeBytes = new Uint8Array([9, 8, 7, 6]);
    const reasoningBytes = new Uint8Array(Array.from({ length: 2_048 }, (_, i) => i % 7));
    const asrBytes = new Uint8Array(Array.from({ length: 1_024 }, (_, i) => i % 11));
    const projectorBytes = new Uint8Array(Array.from({ length: 512 }, (_, i) => i % 13));
    const runtime: LlamaServerRuntimeSpec = {
      release: 'b0',
      license: 'MIT',
      archives: [{ platform: 'darwin-arm64', name: 'llama.tar.gz', url: 'https://runtime.test/llama.tar.gz', bytes: runtimeBytes.length, sha256: sha256(runtimeBytes), gpu: true }],
    };
    const fetched: string[] = [];
    const bytesFor: Record<string, Uint8Array<ArrayBuffer>> = {
      'https://runtime.test/llama.tar.gz': runtimeBytes,
      'https://models.test/reasoning.gguf': reasoningBytes,
      'https://models.test/asr.gguf': asrBytes,
      'https://models.test/mmproj.gguf': projectorBytes,
    };
    const fetchImpl = (async (input: RequestInfo | URL) => {
      fetched.push(String(input));
      return new Response(bytesFor[String(input)]!);
    }) as typeof fetch;
    const extractArchive = (_archive: string, target: string) => {
      mkdirSync(join(target, 'llama-b0'), { recursive: true });
      writeFileSync(join(target, 'llama-b0', 'llama-server'), '#!/bin/sh\n', { mode: 0o755 });
    };
    const env = { OLYMPUS_BUILT_IN_REASONING_DIR: tempDir(), OLYMPUS_BUILT_IN_TRANSCRIPTION_DIR: tempDir() };
    const common = { env, runtime, platform: 'darwin-arm64', fetchImpl, extractArchive, log: () => undefined };
    const reasoning = await installBuiltInReasoning({
      ...common,
      model: { ...QWEN35_4B, modelId: 'test-reasoning', file: { name: 'r.gguf', url: 'https://models.test/reasoning.gguf', bytes: reasoningBytes.length, sha256: sha256(reasoningBytes) } },
    });
    const asr = await installBuiltInTranscription({
      ...common,
      model: {
        ...QWEN3_ASR_06B,
        modelId: 'test-asr',
        files: [
          { name: 'asr.gguf', url: 'https://models.test/asr.gguf', bytes: asrBytes.length, sha256: sha256(asrBytes) },
          { name: 'mmproj.gguf', url: 'https://models.test/mmproj.gguf', bytes: projectorBytes.length, sha256: sha256(projectorBytes) },
        ],
      },
    });
    expect(fetched.filter((url) => url.endsWith('llama.tar.gz')).length).toBe(1);
    expect(asr.serverPath).toBe(reasoning.serverPath);
    expect(asr.modelPath.startsWith(env.OLYMPUS_BUILT_IN_TRANSCRIPTION_DIR)).toBe(true);
    expect(asr.mmprojPath.endsWith('mmproj.gguf')).toBe(true);
    const status = readBuiltInTranscriptionStatus(env, { modelId: 'test-asr' });
    expect(status.state).toBe('ready');
    expect(status.label).toBe('Built-in transcription model ready');
    expect(builtInTranscriptionLayout({ modelId: 'test-asr' }, env).runtimeLockPath)
      .toBe(join(env.OLYMPUS_BUILT_IN_REASONING_DIR, 'runtime.lock'));
  });
});

describe('reading unread audio again once a reader is ready', () => {
  const LANE = { corpusId: 'secure_local.fake.files', provider: 'fake', accountScope: 'personal', approvedScopeKey: 'fake.personal:/Audio' };

  function setup(firstOutputs: ExtractorOutput[], count = firstOutputs.length) {
    const jobs = new LocalFileExtractionJobStore(':memory:');
    let readerState: 'ready' | 'pending' | 'unavailable' = 'pending';
    let prepares = 0;
    let call = 0;
    const extractor: Extractor = {
      kind: TRANSCRIPTION_EXTRACTOR_KIND,
      version: 'v1',
      needsBytes: false,
      egress: 'local',
      accepts: () => true,
      reread: {
        unreadWarnings: [TRANSCRIPTION_REQUIRED_WARNING],
        unreadTerminalErrorKinds: [LEGACY_TRANSCRIBER_NOT_CONFIGURED_KIND],
        notReadyWarnings: [TRANSCRIBER_SETTING_UP_WARNING],
        prepare: () => { prepares += 1; return readerState; },
      },
      async extract() {
        const output = firstOutputs[call] ?? { status: 'indexed', text: 'the transcript' };
        call += 1;
        return output;
      },
    };
    const runner = createFileExtractionRunner({
      jobs,
      registry: buildExtractorRegistry([extractor]),
      corpora: [{
        corpusId: LANE.corpusId,
        trustDomain: 'secure_local',
        source: {
          id: 'fake', corpusId: LANE.corpusId, provider: LANE.provider,
          async listCandidates() { return { candidates: [], done: true }; },
          async fetch() { return { bytes: new Uint8Array([1]) }; },
        },
        sink: { async accept() { return { accepted: true, chunksIndexed: 1, chunksAwaitingEmbedding: 1 }; } },
      }],
    });
    if (count > 0) jobs.enqueue({
      refs: Array.from({ length: count }, (_unused, index) => ({
        ...LANE, providerItemId: `audio-${index}`, localItemId: `personal:audio-${index}`, name: `audio-${index}.m4a`,
      })),
      extractorKind: TRANSCRIPTION_EXTRACTOR_KIND,
      extractorVersion: 'v1',
      policyDecision: 'index_allowed',
    });
    return {
      jobs,
      runner,
      setReader: (state: typeof readerState) => { readerState = state; },
      prepares: () => prepares,
    };
  }

  const unread: ExtractorOutput = {
    status: 'metadata_only',
    derivations: [{ artifactKind: 'transcript', chars: 10, warnings: [TRANSCRIPTION_REQUIRED_WARNING] }],
    warnings: [TRANSCRIPTION_REQUIRED_WARNING],
  };

  test('unread audio and the legacy terminal kind are requeued once when the reader is ready, with a fresh retry budget', async () => {
    const lane = setup([unread, { status: 'failed_terminal', errorKind: LEGACY_TRANSCRIBER_NOT_CONFIGURED_KIND }]);
    try {
      const first = await lane.runner.run({ ...LANE });
      expect(first.counts.metadata_only).toBe(1);
      expect(first.counts.failed_terminal).toBe(1);

      // Not ready yet: asked, nothing requeued.
      const waiting = await lane.runner.run({ ...LANE });
      expect(waiting.rereadRequeued).toBeUndefined();
      expect(lane.prepares()).toBeGreaterThan(0);

      lane.setReader('ready');
      const reread = await lane.runner.run({ ...LANE });
      expect(reread.rereadRequeued).toBe(2);
      expect(reread.counts.indexed).toBe(2);
      for (const record of reread.records) expect(record.attempts).toBe(1);
    } finally {
      lane.jobs.close();
    }
  });

  test('a job settled while the reader was still getting ready is read again, even after its one requeue', async () => {
    const settingUp: ExtractorOutput = {
      status: 'metadata_only',
      derivations: [{ artifactKind: 'transcript', chars: 10, warnings: [TRANSCRIPTION_REQUIRED_WARNING, TRANSCRIBER_SETTING_UP_WARNING] }],
      warnings: [TRANSCRIPTION_REQUIRED_WARNING, TRANSCRIBER_SETTING_UP_WARNING],
    };
    // Run 1: no transcript (no reader). Ready: requeued once, but a restart
    // lands first and the read settles "still being set up". Ready again: read.
    const lane = setup([unread, settingUp], 1);
    try {
      await lane.runner.run({ ...LANE });
      lane.setReader('ready');
      expect((await lane.runner.run({ ...LANE })).rereadRequeued).toBe(1);
      const again = await lane.runner.run({ ...LANE });
      expect(again.rereadRequeued).toBe(1);
      expect(again.counts.indexed).toBe(1);
    } finally {
      lane.jobs.close();
    }
  });

  test('each job is read again at most once, and a lane with nothing unread never asks its reader', async () => {
    const lane = setup([unread, unread], 1);
    try {
      await lane.runner.run({ ...LANE });
      lane.setReader('ready');
      const reread = await lane.runner.run({ ...LANE });
      // The reader is ready but still cannot read it (second output is unread again).
      expect(reread.rereadRequeued).toBe(1);
      const again = await lane.runner.run({ ...LANE });
      expect(again.rereadRequeued).toBeUndefined();
      expect(again.leasedJobs).toBe(0);
    } finally {
      lane.jobs.close();
    }
    const empty = setup([]);
    try {
      empty.setReader('ready');
      await empty.runner.run({ ...LANE });
      expect(empty.prepares()).toBe(0);
    } finally {
      empty.jobs.close();
    }
  });
});

describe('download only when the chosen sources contain audio', () => {
  const LANE = { corpusId: 'secure_local.fake.files', provider: 'fake', accountScope: 'personal', approvedScopeKey: 'fake.personal:/Files' };

  function lane(candidates: Array<{ name: string; mimeType?: string }>) {
    const jobs = new LocalFileExtractionJobStore(':memory:');
    let prepares = 0;
    const builtIn = engineStub({ prepare: () => { prepares += 1; return 'pending'; } });
    const text: Extractor = {
      kind: 'fake_text', version: 'v1', needsBytes: false, egress: 'local',
      accepts: () => true,
      async extract() { return { status: 'indexed', text: 'words' }; },
    };
    const listed = { candidates };
    const runner = createFileExtractionRunner({
      jobs,
      registry: buildExtractorRegistry([createTranscriptionExtractor({ builtIn }), text], [TRANSCRIPTION_EXTRACTOR_KIND, 'fake_text']),
      corpora: [{
        corpusId: LANE.corpusId,
        trustDomain: 'secure_local',
        source: {
          id: 'fake', corpusId: LANE.corpusId, provider: LANE.provider,
          async listCandidates() {
            return {
              candidates: listed.candidates.map((item, index) => ({
                ...LANE, providerItemId: `item-${index}`, localItemId: `personal:item-${index}`, ...item,
              })),
              done: true,
            };
          },
          async fetch() { return { bytes: new Uint8Array([1]) }; },
        },
        sink: { async accept() { return { accepted: true, chunksIndexed: 1, chunksAwaitingEmbedding: 1 }; } },
      }],
    });
    return { jobs, runner, listed, prepares: () => prepares };
  }

  test('no audio in the chosen sources: nothing asks the transcriber to download', async () => {
    const { jobs, runner, prepares } = lane([{ name: 'notes.txt', mimeType: 'text/plain' }, { name: 'scan.pdf' }]);
    try {
      expect(runner.prepareReadersWithWaitingWork?.()).toEqual([]);
      await runner.plan({ ...LANE, limit: 10 });
      expect(runner.prepareReadersWithWaitingWork?.()).toEqual([]);
      expect(prepares()).toBe(0);
    } finally {
      jobs.close();
    }
  });

  test('audio appearing after a sync starts the download at plan time, and at the next engine start', async () => {
    const { jobs, runner, listed, prepares } = lane([{ name: 'notes.txt', mimeType: 'text/plain' }]);
    try {
      await runner.plan({ ...LANE, limit: 10 });
      expect(prepares()).toBe(0);
      // The next sync catalogues a voice note, recognised by its extension only.
      listed.candidates = [...listed.candidates, { name: 'voice-note.ogg' }];
      const plan = await runner.plan({ ...LANE, limit: 10 });
      expect(plan.extractorKinds).toContain(TRANSCRIPTION_EXTRACTOR_KIND);
      expect(prepares()).toBe(1);
      // A restart with that audio still queued asks again at boot.
      expect(runner.prepareReadersWithWaitingWork?.()).toEqual([TRANSCRIPTION_EXTRACTOR_KIND]);
      expect(prepares()).toBe(2);
    } finally {
      jobs.close();
    }
  });

  test('the boot wiring keeps the command gate, and a ready model wakes the extraction tasks within seconds', async () => {
    const T0 = Date.parse('2026-10-07T20:00:00.000Z');
    const clock = { now: T0 };
    const runs: string[] = [];
    const sched = new SourceScheduler({
      enabled: true,
      tickMs: 60_000,
      errorBackoffMs: 60_000,
      maxTransientRetries: 1,
      now: () => new Date(clock.now),
      sources: [{
        sourceId: 'files.fixture', corpusId: 'secure_local.files.fixture', cadence: 'continuous',
        intervalMs: 30 * 60_000, freshnessThresholdHours: 26,
        tasks: [
          { id: 'sync', kind: 'sync', writer: true, run: async () => { runs.push('sync'); return { status: 'idle' }; } },
          { id: 'extract', kind: 'extract', writer: true, run: async () => { runs.push('extract'); return { status: 'idle' }; } },
        ],
      }],
    });
    await sched.runDueTasks(new Date(clock.now));
    expect(runs).toEqual(['sync', 'extract']);

    let finish!: () => void;
    const gate = new Promise<void>((resolve) => { finish = resolve; });
    const engine = createBuiltInTranscriber({
      env: { OLYMPUS_BUILT_IN_TRANSCRIPTION_DIR: tempDir(), OLYMPUS_BUILT_IN_REASONING_DIR: tempDir() },
      platform: 'darwin-arm64',
      totalMemoryBytes: 16 * 1024 ** 3,
      install: async () => { await gate; return { modelPath: '/m', mmprojPath: '/p', serverPath: '/s', gpu: true }; },
    });
    let asked = 0;
    // An owner command wins: nothing is wired or asked.
    expect(wireBuiltInTranscriptionAtBoot({
      env: { OLYMPUS_TRANSCRIBE_COMMAND: 'whisper {input}' }, engine, prepareWaitingReaders: () => { asked += 1; },
    })).toBeUndefined();
    expect(asked).toBe(0);
    wireBuiltInTranscriptionAtBoot({
      env: {},
      engine,
      wake: () => { sched.wakeTasksOfKind('extract'); },
      prepareWaitingReaders: () => { asked += 1; engine.prepare(); },
    });
    expect(asked).toBe(1);
    clock.now = T0 + 2 * 60_000;
    finish();
    await gate;
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(engine.prepare()).toBe('ready');
    const tasks = sched.status().sources[0]!.tasks;
    expect(Date.parse(tasks.find((task) => task.id === 'extract')!.next_run_at!)).toBe(clock.now);
    expect(Date.parse(tasks.find((task) => task.id === 'sync')!.next_run_at!)).toBe(T0 + 30 * 60_000);
  });
});
