/**
 * B7 — the transcription lane.
 *
 * Port of the standalone transcription drain into a registry extractor. The
 * lease, the record and the count moved to the job store and the runner; what
 * survives here is the part that turns audio bytes into text.
 *
 * THE PATH CONTRACT. This extractor consumes a local file PATH, not a byte
 * buffer, because it shells out to a local command that opens a file. The
 * landed `ExtractorInput` carries `localPath` alongside `bytes` for exactly
 * this reason, and ownership follows creation:
 *
 *   - When `localPath` is supplied, it is used and NEVER deleted. This
 *     extractor did not create it and the runner's cleanup owns it.
 *   - When it is absent, the bytes are spilled to a private temp directory
 *     which IS deleted, on every path including the throw path.
 *
 * `needsBytes` is true: the runner has to fetch bytes for a path to exist at
 * all, and the landed `Extractor` has no separate local-path flag.
 *
 * Doc comments here are always multi-line blocks, and every regex lives inside
 * a named function enrolled in the architecture guard's allowlist — which is
 * why the command template is parsed by a free function rather than inline in
 * the transcriber's constructor, where the guard could not attribute it.
 */

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { extname, join } from 'node:path';
import type { Extractor, ExtractorInput, ExtractorOutput } from '../types.ts';
import { boundText, buildDerivation, normalizeMimeType } from './bounded-text.ts';
import {
  ExtractionCommandError,
  ExtractionCommandTimeoutError,
  runExtractionCommand,
  type ExtractionCommandRunner,
} from './command-runner.ts';
import { missingBytesFailure } from './text.ts';

export const TRANSCRIPTION_EXTRACTOR_KIND = 'whisper_transcription';
export const TRANSCRIPTION_EXTRACTOR_VERSION = '2026-06-12';
export const DEFAULT_TRANSCRIBE_TIMEOUT_MS = 1_800_000;
export const MAX_TRANSCRIPT_CHARS = 200_000;

const TEMP_DIR_PREFIX = 'olympus-transcribe-';

/**
 * Hosts the transcription command's remote lane may address. The only remote
 * this lane knows is the owner's Delphi appliance reached through the
 * existing loopback SSH tunnel from the worker host, the same trust class as
 * the local VLM extractor's `127.0.0.1:28090`. Anything else is cloud egress
 * and is refused here and, independently, by the wrapper itself (exit 78).
 */
export const TRANSCRIBE_REMOTE_LANE_HOSTS: readonly string[] = ['127.0.0.1', 'localhost'];

/**
 * Wrapper exit codes whose meaning is deterministic: running the same
 * command on the same file again cannot succeed until an operator changes
 * something. Each maps to a bounded `errorKind`; the extractor reports them
 * as `failed_terminal` so the scheduler and the drain callers stop
 * rescheduling them. Every other non-zero exit (no slot, 5xx fallback that
 * then failed, whisper crash, signal) stays retryable. Mirrors the exit-code
 * table at the top of config/systemd/user/olympus-whisper-transcribe.sh.
 */
export const TRANSCRIBE_TERMINAL_EXIT_KINDS: Readonly<Record<number, string>> = {
  64: 'transcribe_command_usage',
  65: 'transcribe_input_refused',
  66: 'transcribe_input_unreadable',
  76: 'transcribe_remote_lane_rejected',
  78: 'transcribe_remote_lane_misconfigured',
};

/**
 * The transcription command reported a deterministic failure (see
 * `TRANSCRIBE_TERMINAL_EXIT_KINDS`). Carries the bounded kind and the exit
 * code; the command's streams stay on the wrapped cause and are never copied
 * into a stored field.
 */
export class TranscriptionTerminalError extends Error {
  readonly exitCode: number;
  readonly errorKind: string;
  readonly commandError: ExtractionCommandError;

  constructor(cause: ExtractionCommandError, errorKind: string) {
    super(`${cause.command} exited with terminal status ${cause.exitCode} (${errorKind}).`);
    this.name = 'TranscriptionTerminalError';
    this.exitCode = cause.exitCode ?? -1;
    this.errorKind = errorKind;
    this.commandError = cause;
  }
}

export function isTerminalTranscriptionError(error: unknown): error is TranscriptionTerminalError {
  return error instanceof TranscriptionTerminalError;
}

export interface TranscribeRemoteLane {
  url: string;
  host: string;
}

/**
 * Reads `OLYMPUS_TRANSCRIBE_URL` and enforces the loopback boundary. Returns
 * the lane when it is set and loopback, `undefined` when unset, and throws
 * when it names any other host: a process that would hand audio to a
 * non-loopback URL must not start at all.
 */
export function resolveTranscribeRemoteLane(
  env: Record<string, string | undefined> = process.env,
): TranscribeRemoteLane | undefined {
  const raw = env.OLYMPUS_TRANSCRIBE_URL?.trim();
  if (!raw) return undefined;
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error('OLYMPUS_TRANSCRIBE_URL is not a valid URL; the transcription remote lane must be a loopback http(s) URL.');
  }
  const host = parsed.hostname.toLowerCase();
  const isHttp = parsed.protocol === 'http:' || parsed.protocol === 'https:';
  if (!isHttp || !TRANSCRIBE_REMOTE_LANE_HOSTS.includes(host) || parsed.username || parsed.password) {
    throw new Error(
      `OLYMPUS_TRANSCRIBE_URL host '${parsed.hostname}' is not loopback; the transcription remote lane is the Delphi tunnel on 127.0.0.1/localhost only and never cloud ASR.`,
    );
  }
  return { url: raw, host };
}

/**
 * Mime types the lane plans for. Video containers are included because voice
 * memos and screen recordings routinely carry an audio track inside one.
 */
export const TRANSCRIPTION_AUDIO_MIME_TYPES: readonly string[] = [
  'audio/wav', 'audio/x-wav', 'audio/wave',
  'audio/mpeg', 'audio/mp3',
  'audio/mp4', 'audio/x-m4a', 'audio/m4a',
  'audio/aac', 'audio/aacp',
  'audio/flac', 'audio/x-flac',
  'audio/ogg', 'audio/opus',
  'video/mp4', 'video/quicktime',
];

/**
 * Extensions the lane plans for, because synced entries often carry a generic
 * or absent mime type.
 */
export const TRANSCRIPTION_AUDIO_EXTENSIONS: readonly string[] = [
  'wav', 'mp3', 'm4a', 'aac', 'flac', 'ogg', 'mp4', 'mov',
];

export interface TranscriberInput {
  inputPath: string;
  mimeType?: string;
}

export interface TranscriberResult {
  text: string;
  language?: string;
}

/**
 * Injectable transcriber seam. Tests supply a fake; wiring supplies the
 * command-backed implementation below.
 */
export interface Transcriber {
  transcribe(input: TranscriberInput): Promise<TranscriberResult>;
}

export interface WhisperCommandTranscriberOptions {
  /**
   * Command template, whitespace-split into argv. Every `{input}` token is
   * replaced with the temp audio path, and the template MUST contain one:
   * a template without it would transcribe nothing and silently succeed.
   *
   * The command must be LOCAL infrastructure only. The one remote it may
   * reach is the owner's Delphi appliance over the loopback tunnel (see
   * `resolveTranscribeRemoteLane`); no cloud ASR rides this lane.
   */
  command: string;
  timeoutMs?: number;
  commandRunner?: ExtractionCommandRunner;
}

/**
 * Split a command template into argv and validate the placeholder.
 *
 * A free function rather than constructor-inline code so the architecture
 * guard can attribute its regex: the guard only recognizes named function
 * declarations, so a regex inside a class body is unattributable.
 */
export function parseTranscriberArgvTemplate(command: string): string[] {
  const argv = command.trim().split(/\s+/).filter(Boolean);
  if (argv.length === 0) {
    throw new Error('Transcriber requires a non-empty command template.');
  }
  if (!argv.some((arg) => arg.includes('{input}'))) {
    throw new Error('Transcriber command template must contain an {input} placeholder.');
  }
  return argv;
}

export class WhisperCommandTranscriber implements Transcriber {
  private readonly argvTemplate: string[];
  private readonly timeoutMs: number;
  private readonly commandRunner: ExtractionCommandRunner;

  constructor(options: WhisperCommandTranscriberOptions) {
    this.argvTemplate = parseTranscriberArgvTemplate(options.command);
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TRANSCRIBE_TIMEOUT_MS;
    this.commandRunner = options.commandRunner ?? runExtractionCommand;
  }

  async transcribe(input: TranscriberInput): Promise<TranscriberResult> {
    const argv = this.argvTemplate.map((arg) => arg.replaceAll('{input}', input.inputPath));
    const [command, ...args] = argv;
    let result;
    try {
      result = await this.commandRunner({
        command: command!,
        args,
        timeoutMs: this.timeoutMs,
      });
    } catch (error) {
      if (error instanceof ExtractionCommandError && error.exitCode !== null) {
        const kind = TRANSCRIBE_TERMINAL_EXIT_KINDS[error.exitCode];
        if (kind) throw new TranscriptionTerminalError(error, kind);
      }
      throw error;
    }
    // Whisper-style runners emit a sidecar .txt next to the input; fall back to
    // stdout when no sidecar appears. Both shapes are live.
    const sidecar = await readFirstExisting([
      `${input.inputPath}.txt`,
      sidecarPathForInput(input.inputPath),
    ]);
    return { text: normalizeTranscriptText(sidecar ?? result.stdout) };
  }
}

export function createWhisperCommandTranscriberFromEnv(
  env: Record<string, string | undefined> = process.env,
): WhisperCommandTranscriber | undefined {
  const command = env.OLYMPUS_TRANSCRIBE_COMMAND?.trim();
  if (!command) return undefined;
  // Fail closed before any process starts: the wrapper checks the same
  // boundary, but a caller must not even be constructed with cloud egress.
  resolveTranscribeRemoteLane(env);
  const timeoutSeconds = env.OLYMPUS_TRANSCRIBE_TIMEOUT_SECONDS?.trim();
  let timeoutMs: number | undefined;
  if (timeoutSeconds) {
    const parsed = Number(timeoutSeconds);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      throw new Error('OLYMPUS_TRANSCRIBE_TIMEOUT_SECONDS must be a positive number of seconds.');
    }
    timeoutMs = Math.round(parsed * 1_000);
  }
  return new WhisperCommandTranscriber({
    command,
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
  });
}

export interface TranscriptionExtractorOptions {
  kind?: string;
  version?: string;
  command?: string;
  timeoutMs?: number;
  maxTranscriptChars?: number;
  transcriber?: Transcriber;
  commandRunner?: ExtractionCommandRunner;
  tempDirPrefix?: string;
}

export function createTranscriptionExtractor(
  options: TranscriptionExtractorOptions = {},
): Extractor {
  const kind = options.kind ?? TRANSCRIPTION_EXTRACTOR_KIND;
  const version = options.version ?? TRANSCRIPTION_EXTRACTOR_VERSION;
  const maxTranscriptChars = options.maxTranscriptChars ?? MAX_TRANSCRIPT_CHARS;
  const tempDirPrefix = options.tempDirPrefix ?? TEMP_DIR_PREFIX;
  const transcriber = options.transcriber ?? (options.command
    ? new WhisperCommandTranscriber({
      command: options.command,
      ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
      ...(options.commandRunner !== undefined ? { commandRunner: options.commandRunner } : {}),
    })
    : undefined);
  return {
    kind,
    version,
    needsBytes: true,
    egress: 'local',
    accepts(mimeType, name) {
      return transcriptionLaneAccepts(mimeType, name);
    },
    async extract(input: ExtractorInput): Promise<ExtractorOutput> {
      if (!transcriber) {
        return { status: 'failed_retryable', errorKind: 'transcriber_not_configured' };
      }
      const bytes = input.bytes;
      if (!bytes && !input.localPath) return missingBytesFailure();
      const mimeType = normalizeMimeType(input.mimeType ?? input.ref.mimeType);
      let tempDir: string | undefined;
      try {
        let inputPath = input.localPath;
        if (!inputPath) {
          tempDir = await mkdtemp(join(tmpdir(), tempDirPrefix));
          inputPath = join(tempDir, tempAudioFileName(input.job.jobId, input.ref.name));
          await writeFile(inputPath, bytes!);
        }
        const transcribed = await transcriber.transcribe({
          inputPath,
          ...(mimeType ? { mimeType } : {}),
        });
        // The cap is applied by `boundText` and nowhere else. Slicing first
        // would make `sourceChars` equal the cap, so an over-long transcript
        // would be recorded as a complete read of a partially-read file.
        const text = transcribed.text.trim();
        if (!text) {
          return { status: 'empty_output' };
        }
        const bounded = boundText(text, maxTranscriptChars);
        const derivation = buildDerivation({
          artifact: 'text',
          artifactKind: 'transcript',
          structural: { kind: 'whole_file', label: 'audio transcript' },
          bounded,
        });
        return {
          status: 'indexed',
          text: bounded.text,
          derivations: [{
            ...derivation,
            // The detected language has no field on the landed seam. It rides
            // structuralRef, which is free-form, rather than being dropped.
            ...(transcribed.language
              ? {
                  structuralRef: {
                    ...derivation.structuralRef,
                    language: transcribed.language,
                  },
                }
              : {}),
          }],
          ...(bounded.warnings.length > 0 ? { warnings: [...bounded.warnings] } : {}),
        };
      } catch (error) {
        if (error instanceof TranscriptionTerminalError) {
          return { status: 'failed_terminal', errorKind: error.errorKind };
        }
        if (error instanceof ExtractionCommandTimeoutError) {
          // A timeout whose kill failed is still retryable (the runner has no
          // way to finish the work), but under its own token so the operator
          // sees that a process may be lingering.
          return {
            status: 'failed_retryable',
            errorKind: error.terminationFailed
              ? 'transcribe_command_timeout_kill_failed'
              : 'transcribe_command_timeout',
          };
        }
        return { status: 'failed_retryable', errorKind: 'transcribe_command_failed' };
      } finally {
        // Only ever remove a directory this extractor created. A supplied
        // localPath belongs to the runner and outlives this call.
        if (tempDir) {
          await rm(tempDir, { recursive: true, force: true }).catch(() => {});
        }
      }
    },
  };
}

export function transcriptionLaneAccepts(
  mimeType: string | undefined,
  name?: string,
): boolean {
  const normalized = normalizeMimeType(mimeType);
  if (normalized && TRANSCRIPTION_AUDIO_MIME_TYPES.includes(normalized)) return true;
  if (!name) return false;
  const extension = extname(name.trim()).toLowerCase().replace('.', '');
  return extension.length > 0 && TRANSCRIPTION_AUDIO_EXTENSIONS.includes(extension);
}

export function tempAudioFileName(jobId: string, name: string | undefined): string {
  const extension = name ? extname(name).toLowerCase() : '';
  const safeExtension = /^\.[a-z0-9]{1,8}$/.test(extension) ? extension : '.audio';
  return `audio-${jobId.replace(/[^a-zA-Z0-9_-]/g, '')}${safeExtension}`;
}

export function sidecarPathForInput(inputPath: string): string {
  const extension = extname(inputPath);
  const stem = extension ? inputPath.slice(0, -extension.length) : inputPath;
  return `${stem}.txt`;
}

export async function readFirstExisting(paths: string[]): Promise<string | undefined> {
  for (const path of [...new Set(paths)]) {
    try {
      return await readFile(path, 'utf8');
    } catch {
      // try the next candidate
    }
  }
  return undefined;
}

export function normalizeTranscriptText(input: string): string {
  return input
    .replace(/\u0000/g, '')
    .replace(/\r\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
