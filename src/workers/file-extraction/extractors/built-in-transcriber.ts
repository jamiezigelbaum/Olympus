/**
 * The built-in transcriber: Qwen3-ASR 0.6B run by the pinned llama-server,
 * on this machine. Owner decision 2026-10-07; audio never leaves the machine.
 *
 * One file is read in four steps:
 *
 *   1. The system decoder converts it to 16 kHz mono 16-bit WAV
 *      (`/usr/bin/afconvert` on macOS, nothing to install; `ffmpeg` from
 *      PATH on Linux when the owner turns the engine on there).
 *   2. The samples are cut into chunks of at most thirty seconds, each cut at
 *      the quietest moment near the limit (audio-wav.ts). Silent chunks are
 *      skipped, so the model is never asked to invent words for silence.
 *   3. Each chunk goes to a loopback-only llama-server as one `input_audio`
 *      part of a chat completion, at temperature 0, with no text prompt at
 *      all: Qwen3-ASR is a speech recognizer, and its template treats any
 *      system text as recognition context that biases the words it hears.
 *      Instructions spoken in the audio come back as transcript, never as
 *      behaviour (verified; see docs/design/built-in-transcription.md).
 *   4. The chunk transcripts are concatenated in order. A per-file time
 *      budget and the lane's character cap bound the work; a file cut short
 *      says so in a warning.
 *
 * The model downloads the first time an audio file needs it. Until it is
 * verified the transcriber answers `TranscriberPendingError`, which the lane
 * settles as "not read yet" without spending a retry; the runner reads those
 * files again once `prepare()` reports ready. A host that cannot run it (no
 * pinned runtime, too little memory, no decoder) answers
 * `TranscriberUnavailableError` and is remembered as unavailable.
 *
 * Doc comments here are always multi-line blocks, and this module contains
 * no regular expressions (architecture guard).
 */

import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir, totalmem } from 'node:os';
import { join } from 'node:path';
import { fetchModelEndpoint } from '../../../core/model-transport.ts';
import {
  BuiltInReasoningInstallError,
  currentPlatform,
} from '../../source-index/built-in-reasoning/install.ts';
import { QWEN3_ASR_06B, type BuiltInTranscriptionModelSpec } from '../../source-index/built-in-reasoning/manifest.ts';
import {
  builtInReasoningThreads,
  createLlamaServerHandle,
  LlamaServerStartError,
  type LlamaServerHandle,
  type LlamaServerLaunch,
} from '../../source-index/built-in-reasoning/server.ts';
import {
  builtInTranscriptionEnabled,
  builtInTranscriptionLayout,
  installBuiltInTranscription,
  reportBuiltInTranscriptionState,
  type BuiltInTranscriptionInstallerOptions,
  type InstalledBuiltInTranscription,
} from '../../source-index/built-in-reasoning/transcription-model.ts';
import type { BuiltInTranscriptionEngine } from '../types.ts';
import { encodeWav16Mono, meanAmplitude, parseWav16Mono, planAudioChunks, WavFormatError } from './audio-wav.ts';
import {
  ExtractionCommandError,
  runExtractionCommand,
  type ExtractionCommandRunner,
} from './command-runner.ts';

/**
 * Warning on a transcript the per-file time budget cut short.
 */
export const TRANSCRIPT_TIME_BUDGET_WARNING = 'transcript_time_budget_reached';

const DEFAULT_IDLE_SHUTDOWN_SECONDS = 180;
const DEFAULT_STARTUP_TIMEOUT_MS = 120_000;
const DEFAULT_CHUNK_TIMEOUT_MS = 180_000;
const DEFAULT_FILE_DEADLINE_MS = 30 * 60_000;
const DEFAULT_CONVERT_TIMEOUT_MS = 5 * 60_000;
const DEFAULT_INSTALL_RETRY_MS = 15 * 60_000;
const DEFAULT_INSTALL_RETRY_CEILING_MS = 24 * 60 * 60_000;
/**
 * With the model already on disk, how long a file waits for this process's
 * checksum pass (about a second per gigabyte) before it settles unread.
 */
const DEFAULT_VERIFY_WAIT_MS = 5 * 60_000;
/**
 * Time kept back from a lease for the runner to record the result.
 */
const LEASE_MARGIN_MS = 60_000;
const DEFAULT_CHUNK_SECONDS = 30;
const MAX_TOKENS_PER_CHUNK = 512;
/**
 * Mean absolute amplitude (of 32768) below which a chunk is silence.
 */
const SILENCE_LEVEL = 24;
const ASR_TEXT_MARKER = '<asr_text>';
const LANGUAGE_PREFIX = 'language ';
const TARGET_SAMPLE_RATE = 16_000;
const TEMP_DIR_PREFIX = 'olympus-asr-';
const MACOS_AUDIO_CONVERTER = '/usr/bin/afconvert';

/**
 * The model is still downloading or verifying, or its last install attempt
 * failed and is waiting to try again. Not the file's fault.
 */
export class TranscriberPendingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TranscriberPendingError';
  }
}

/**
 * This host cannot run the built-in transcriber at all.
 */
export class TranscriberUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TranscriberUnavailableError';
  }
}

/**
 * The system decoder could not read this file: a damaged file or a codec it
 * does not know. The same bytes fail the same way every time.
 */
export class AudioUndecodableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AudioUndecodableError';
  }
}

/**
 * Converts `inputPath` to 16 kHz mono 16-bit WAV at `outputPath`.
 */
export type AudioConverter = (inputPath: string, outputPath: string) => Promise<void>;

export interface BuiltInTranscriberOptions {
  model?: BuiltInTranscriptionModelSpec;
  env?: Record<string, string | undefined>;
  platform?: string;
  totalMemoryBytes?: number;
  install?: (options: BuiltInTranscriptionInstallerOptions) => Promise<InstalledBuiltInTranscription>;
  installOptions?: BuiltInTranscriptionInstallerOptions;
  createServer?: (launch: LlamaServerLaunch) => LlamaServerHandle;
  fetchImpl?: typeof fetch;
  convert?: AudioConverter;
  commandRunner?: ExtractionCommandRunner;
  idleShutdownSeconds?: number;
  chunkSeconds?: number;
  chunkTimeoutMs?: number;
  fileDeadlineMs?: number;
  /**
   * Stop reading chunks once this many transcript characters are collected.
   */
  maxTranscriptChars?: number;
  /**
   * After a failed install, how long before the next attempt; it doubles
   * with each consecutive failure up to `installRetryCeilingMs`.
   */
  installRetryMs?: number;
  installRetryCeilingMs?: number;
  /**
   * Whether the model's files are already on disk (so only the checksum pass
   * is left); defaults to checking the install directory.
   */
  filesOnDisk?: () => boolean;
  /**
   * How long `transcribe` waits for that checksum pass.
   */
  verifyWaitMs?: number;
  now?: () => number;
}

/**
 * The system converter for this platform: afconvert on macOS (it decodes
 * AAC/M4A, MP3, WAV, AIFF, CAF, FLAC and Ogg Opus/Vorbis), ffmpeg on Linux.
 */
export function defaultAudioConverter(
  platform: string,
  runner: ExtractionCommandRunner = runExtractionCommand,
  timeoutMs = DEFAULT_CONVERT_TIMEOUT_MS,
): AudioConverter {
  const darwin = platform.startsWith('darwin-');
  return async (inputPath, outputPath) => {
    const request = darwin
      ? {
          command: MACOS_AUDIO_CONVERTER,
          args: ['-f', 'WAVE', '-d', `LEI16@${TARGET_SAMPLE_RATE}`, '-c', '1', inputPath, outputPath],
        }
      : {
          command: 'ffmpeg',
          args: ['-nostdin', '-hide_banner', '-loglevel', 'error', '-y', '-i', inputPath,
            '-vn', '-ac', '1', '-ar', String(TARGET_SAMPLE_RATE), '-c:a', 'pcm_s16le', '-f', 'wav', outputPath],
        };
    try {
      await runner({ ...request, timeoutMs });
    } catch (error) {
      if ((error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT') {
        throw new TranscriberUnavailableError(`No audio decoder on this host (${request.command} is missing).`);
      }
      if (error instanceof ExtractionCommandError) {
        throw new AudioUndecodableError(`${request.command} could not decode the audio (exit ${error.exitCode ?? 'signal'}).`);
      }
      throw error;
    }
  };
}

/**
 * Splits Qwen3-ASR output (`language English<asr_text>the words`) into the
 * transcript and the detected language. `language None` means no speech.
 */
export function parseAsrOutput(content: string): { text: string; language?: string } {
  const at = content.indexOf(ASR_TEXT_MARKER);
  if (at < 0) return { text: content.trim() };
  const head = content.slice(0, at).trim();
  const text = content.slice(at + ASR_TEXT_MARKER.length).trim();
  const language = head.startsWith(LANGUAGE_PREFIX) ? head.slice(LANGUAGE_PREFIX.length).trim() : '';
  return language && language !== 'None' ? { text, language } : { text };
}

export function createBuiltInTranscriber(options: BuiltInTranscriberOptions = {}): BuiltInTranscriptionEngine {
  const model = options.model ?? QWEN3_ASR_06B;
  const env = options.env ?? process.env;
  const platform = options.platform ?? currentPlatform();
  const install = options.install ?? installBuiltInTranscription;
  const fetchImpl = options.fetchImpl ?? fetch;
  const now = options.now ?? Date.now;
  const convert = options.convert ?? defaultAudioConverter(platform, options.commandRunner);
  const installRetryMs = options.installRetryMs ?? DEFAULT_INSTALL_RETRY_MS;
  const installRetryCeilingMs = options.installRetryCeilingMs ?? DEFAULT_INSTALL_RETRY_CEILING_MS;
  const verifyWaitMs = options.verifyWaitMs ?? DEFAULT_VERIFY_WAIT_MS;
  const filesOnDisk = options.filesOnDisk ?? (() => {
    try {
      const layout = builtInTranscriptionLayout(model, env, options.installOptions?.runtime, platform);
      return model.files.every((file) => existsSync(join(layout.modelDir, file.name)));
    } catch {
      return false;
    }
  });
  const chunkSeconds = options.chunkSeconds ?? DEFAULT_CHUNK_SECONDS;
  const chunkTimeoutMs = options.chunkTimeoutMs ?? DEFAULT_CHUNK_TIMEOUT_MS;
  const fileDeadlineMs = options.fileDeadlineMs ?? DEFAULT_FILE_DEADLINE_MS;
  const maxChars = options.maxTranscriptChars ?? Number.POSITIVE_INFINITY;
  let unavailable: string | undefined = (options.totalMemoryBytes ?? totalmem()) < model.minimumMemoryBytes
    ? 'This computer does not have enough memory for the built-in transcription model.'
    : undefined;
  let installed: InstalledBuiltInTranscription | undefined;
  let installing: Promise<void> | undefined;
  let failedAt: number | undefined;
  let consecutiveFailures = 0;
  let server: LlamaServerHandle | undefined;

  const prepare = (): 'ready' | 'pending' | 'unavailable' => {
    if (unavailable) return 'unavailable';
    if (installed) return 'ready';
    if (installing) return 'pending';
    // A non-space failure (a broken download, a checksum mismatch) backs off
    // exponentially, so a persistent fault does not re-download a gigabyte
    // every quarter hour. A full disk has its own backoff in the installer.
    const backoff = Math.min(installRetryCeilingMs, installRetryMs * 2 ** Math.max(0, consecutiveFailures - 1));
    if (failedAt !== undefined && now() - failedAt < backoff) return 'pending';
    installing = install({ ...options.installOptions, model, env, platform })
      .then((result) => {
        installed = result;
        failedAt = undefined;
        consecutiveFailures = 0;
      }, (error: unknown) => {
        if (error instanceof BuiltInReasoningInstallError
          && (error.reason === 'unsupported_platform' || error.reason === 'insufficient_memory')) {
          unavailable = error.message;
        } else {
          failedAt = now();
          consecutiveFailures = error instanceof BuiltInReasoningInstallError && error.reason === 'insufficient_space'
            ? 1
            : consecutiveFailures + 1;
        }
      })
      .finally(() => {
        installing = undefined;
      });
    return 'pending';
  };

  const ensureServer = (paths: InstalledBuiltInTranscription): LlamaServerHandle => {
    server ??= (options.createServer ?? createLlamaServerHandle)({
      serverPath: paths.serverPath,
      modelPath: paths.modelPath,
      mmprojPath: paths.mmprojPath,
      contextTokens: model.contextTokens,
      gpu: paths.gpu,
      threads: builtInReasoningThreads(),
      idleShutdownSeconds: options.idleShutdownSeconds ?? DEFAULT_IDLE_SHUTDOWN_SECONDS,
      startupTimeoutMs: DEFAULT_STARTUP_TIMEOUT_MS,
      batchSize: 512,
    });
    return server;
  };

  const startServer = async (paths: InstalledBuiltInTranscription) => {
    const handle = ensureServer(paths);
    try {
      if (!handle.pid) reportBuiltInTranscriptionState(env, model, 'loading');
      const endpoint = await handle.ensureRunning();
      reportBuiltInTranscriptionState(env, model, 'ready');
      return { handle, endpoint };
    } catch (error) {
      reportBuiltInTranscriptionState(env, model, 'failed', {
        reason: 'runtime_load_failed',
        message: error instanceof Error ? error.message : String(error),
      });
      throw error instanceof LlamaServerStartError ? error : new LlamaServerStartError(String(error));
    }
  };

  return {
    prepare,
    async stop() {
      await server?.stop();
    },
    async transcribe(input) {
      const started = now();
      // The earlier of the file budget and the caller's deadline (the job's
      // lease, less a margin): a transcript that outlives its lease is thrown
      // away, so the work stops in time and keeps what it has.
      const deadline = Math.min(
        started + fileDeadlineMs,
        input.deadlineAt !== undefined && Number.isFinite(input.deadlineAt) ? input.deadlineAt : Number.POSITIVE_INFINITY,
      );
      let state = prepare();
      // After a restart the files are on disk and only this process's
      // checksum pass is running: wait for it (bounded) rather than settling
      // a file that was just queued to be read again.
      if (state === 'pending' && installing && filesOnDisk()) {
        const pending = installing;
        const waitMs = Math.max(0, Math.min(verifyWaitMs, deadline - now()));
        await Promise.race([pending, new Promise((resolve) => setTimeout(resolve, waitMs).unref?.())]);
        state = prepare();
      }
      if (state === 'unavailable') throw new TranscriberUnavailableError(unavailable ?? 'Built-in transcription is unavailable.');
      if (state === 'pending' || !installed) {
        throw new TranscriberPendingError('The built-in transcription model is still being set up.');
      }
      const paths = installed;
      const tempDir = await mkdtemp(join(tmpdir(), TEMP_DIR_PREFIX));
      try {
        const wavPath = join(tempDir, 'audio.wav');
        try {
          await convert(input.inputPath, wavPath);
        } catch (error) {
          if (error instanceof TranscriberUnavailableError) unavailable = error.message;
          throw error;
        }
        let audio;
        try {
          audio = parseWav16Mono(new Uint8Array(await readFile(wavPath)));
        } catch (error) {
          if (error instanceof WavFormatError) throw new AudioUndecodableError(error.message);
          throw error;
        }
        await rm(wavPath, { force: true });
        const chunks = planAudioChunks(audio, { maxSeconds: chunkSeconds });
        const parts: string[] = [];
        const languages = new Map<string, number>();
        const warnings: string[] = [];
        let chars = 0;
        let handle: LlamaServerHandle | undefined;
        try {
          for (const chunk of chunks) {
            if (chars >= maxChars) break;
            if (now() >= deadline) {
              warnings.push(TRANSCRIPT_TIME_BUDGET_WARNING);
              break;
            }
            if (meanAmplitude(audio.samples, chunk.start, chunk.end) < SILENCE_LEVEL) continue;
            const running = await startServer(paths);
            handle = running.handle;
            const wav = encodeWav16Mono(audio.samples.subarray(chunk.start, chunk.end), audio.sampleRate);
            const remaining = deadline - now();
            if (remaining <= 0) {
              warnings.push(TRANSCRIPT_TIME_BUDGET_WARNING);
              break;
            }
            const content = await transcribeChunk(fetchImpl, running.endpoint, wav, Math.min(chunkTimeoutMs, remaining));
            const parsed = parseAsrOutput(content);
            if (parsed.language) languages.set(parsed.language, (languages.get(parsed.language) ?? 0) + 1);
            if (parsed.text) {
              parts.push(parsed.text);
              chars += parsed.text.length + 1;
            }
          }
        } finally {
          handle?.touch();
        }
        const language = [...languages.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
        return {
          text: parts.join(' '),
          ...(language ? { language } : {}),
          ...(warnings.length > 0 ? { warnings } : {}),
        };
      } finally {
        await rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
      }
    },
  };
}

async function transcribeChunk(
  fetchImpl: typeof fetch,
  endpoint: { baseUrl: string; token: string },
  wav: Uint8Array,
  timeoutMs: number,
): Promise<string> {
  // The audio and the server's bearer token ride this request to loopback
  // only; a redirect is refused, never followed.
  const response = await fetchModelEndpoint(fetchImpl, `${endpoint.baseUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${endpoint.token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      messages: [{
        role: 'user',
        content: [{ type: 'input_audio', input_audio: { data: Buffer.from(wav).toString('base64'), format: 'wav' } }],
      }],
      temperature: 0,
      max_tokens: MAX_TOKENS_PER_CHUNK,
    }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error(`The built-in transcription model returned HTTP ${response.status}.`);
  }
  const payload = await response.json() as { choices?: Array<{ message?: { content?: unknown } }> };
  const content = payload.choices?.[0]?.message?.content;
  if (typeof content !== 'string') throw new Error('The built-in transcription model returned no text.');
  return content;
}

let sharedTranscriber: BuiltInTranscriptionEngine | undefined;

/**
 * The process's built-in transcriber if one was created, for shutdown;
 * never creates one.
 */
export function runningBuiltInTranscriber(): BuiltInTranscriptionEngine | undefined {
  return sharedTranscriber;
}

/**
 * The lease-derived deadline for one job: its lease expiry less a margin for
 * recording the result, or undefined when the expiry is not a time.
 */
export function transcriptionDeadlineFromLease(leaseExpiresAt: string | undefined): number | undefined {
  const at = leaseExpiresAt ? Date.parse(leaseExpiresAt) : Number.NaN;
  return Number.isFinite(at) ? at - LEASE_MARGIN_MS : undefined;
}

/**
 * The process's one built-in transcriber, or undefined where it is off
 * (`OLYMPUS_BUILT_IN_TRANSCRIPTION`, default on for Apple silicon only).
 */
export function sharedBuiltInTranscriber(
  env: Record<string, string | undefined> = process.env,
): BuiltInTranscriptionEngine | undefined {
  if (!builtInTranscriptionEnabled(env)) return undefined;
  sharedTranscriber ??= createBuiltInTranscriber({ env });
  return sharedTranscriber;
}
