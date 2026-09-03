// WhatsApp voice-note transcription drain.
//
// This lane is LOCAL ONLY. It reuses WhisperCommandTranscriber and
// OLYMPUS_TRANSCRIBE_COMMAND to turn files captured by tools/whatsapp-bridge
// into <media_path>.transcript.txt sidecars consumed by the live connector.
// It must never route WhatsApp personal audio through domain-expert, Gemini,
// GCS, or any cloud ASR lane.

import { mkdir, readdir, readFile, stat } from 'node:fs/promises';
import { dirname, extname, join } from 'node:path';
import { writePrivateFileAtomic } from '../src/core/atomic-file.ts';
import {
  createWhisperCommandTranscriberFromEnv,
  type Transcriber,
} from '../src/workers/file-extraction/extractors/transcription.ts';
import {
  WHATSAPP_TRANSCRIPT_EXTRACTOR_KIND,
  WHATSAPP_TRANSCRIPT_EXTRACTOR_VERSION,
} from '../src/workers/whatsapp/index.ts';

const DEFAULT_STATE_REL = '.local/share/olympus/whatsapp-live';
const DEFAULT_IDLE_SLEEP_SECONDS = 15;
const DEFAULT_ERROR_BACKOFF_SECONDS = 60;
const AUDIO_EXTENSIONS = new Set(['.aac', '.bin', '.m4a', '.mp3', '.ogg', '.opus', '.wav', '.webm']);

type WhatsAppTranscriptionStatusName = 'transcribed' | 'failed_retryable';

interface WhatsAppTranscriptStatusFile {
  kind: 'whatsapp_audio_transcription_status';
  status: WhatsAppTranscriptionStatusName;
  attempts: number;
  error_class: string | null;
  extractor_kind: string;
  extractor_version: string;
  updated_at: string;
  next_retry_at: string | null;
}

interface WhatsAppTranscribeDrainConfig {
  mediaDir: string;
  idleSleepMs: number;
  errorBackoffMs: number;
  maxRuns: number | 'unbounded';
  stopWhenIdle: boolean;
  reportPath?: string;
  extractorKind: string;
  extractorVersion: string;
}

export interface WhatsAppTranscribeDrainSummary {
  kind: 'whatsapp_transcribe_drain';
  runs: number;
  counts: {
    media_files_seen: number;
    transcribed: number;
    skipped_already_transcribed: number;
    skipped_backoff: number;
    failed_retryable: number;
    idle_runs: number;
  };
  extractor_kind: string;
  extractor_version: string;
  stopped_by_signal: boolean;
  policy: {
    local_only: true;
    cloud_asr_allowed: false;
    raw_source_exposed: false;
    source_text_returned: false;
  };
}

interface StopState {
  stopped: boolean;
}

export async function runWhatsAppTranscribeDrain(
  env: Record<string, string | undefined> = process.env,
  options: { transcriber?: Transcriber; stopState?: StopState } = {},
): Promise<WhatsAppTranscribeDrainSummary> {
  const transcriber = options.transcriber ?? createWhisperCommandTranscriberFromEnv(env);
  if (!transcriber) {
    throw new Error('OLYMPUS_TRANSCRIBE_COMMAND is required (argv template with an {input} placeholder; local infrastructure only).');
  }
  const config = resolveConfig(env);
  await mkdir(config.mediaDir, { recursive: true, mode: 0o700 });

  const summary: WhatsAppTranscribeDrainSummary = {
    kind: 'whatsapp_transcribe_drain',
    runs: 0,
    counts: {
      media_files_seen: 0,
      transcribed: 0,
      skipped_already_transcribed: 0,
      skipped_backoff: 0,
      failed_retryable: 0,
      idle_runs: 0,
    },
    extractor_kind: config.extractorKind,
    extractor_version: config.extractorVersion,
    stopped_by_signal: false,
    policy: {
      local_only: true,
      cloud_asr_allowed: false,
      raw_source_exposed: false,
      source_text_returned: false,
    },
  };

  const stopState = options.stopState ?? { stopped: false };
  while (!stopState.stopped && (config.maxRuns === 'unbounded' || summary.runs < config.maxRuns)) {
    const pass = await runOnePass(config, transcriber);
    summary.runs += 1;
    summary.counts.media_files_seen += pass.mediaFilesSeen;
    summary.counts.transcribed += pass.transcribed;
    summary.counts.skipped_already_transcribed += pass.skippedAlreadyTranscribed;
    summary.counts.skipped_backoff += pass.skippedBackoff;
    summary.counts.failed_retryable += pass.failedRetryable;
    if (pass.workDone === 0) summary.counts.idle_runs += 1;
    await writeHeartbeat(config, summary);

    if (config.stopWhenIdle && pass.workDone === 0) break;
    if (config.maxRuns !== 'unbounded' && summary.runs >= config.maxRuns) break;
    if (pass.workDone === 0) await sleep(config.idleSleepMs, stopState);
  }
  summary.stopped_by_signal = stopState.stopped;
  await writeHeartbeat(config, summary);
  return summary;
}

interface DrainPassResult {
  mediaFilesSeen: number;
  transcribed: number;
  skippedAlreadyTranscribed: number;
  skippedBackoff: number;
  failedRetryable: number;
  workDone: number;
}

async function runOnePass(config: WhatsAppTranscribeDrainConfig, transcriber: Transcriber): Promise<DrainPassResult> {
  const result: DrainPassResult = {
    mediaFilesSeen: 0,
    transcribed: 0,
    skippedAlreadyTranscribed: 0,
    skippedBackoff: 0,
    failedRetryable: 0,
    workDone: 0,
  };
  for (const mediaPath of await listAudioMediaFiles(config.mediaDir)) {
    result.mediaFilesSeen += 1;
    if (await hasTranscript(transcriptPath(mediaPath))) {
      result.skippedAlreadyTranscribed += 1;
      continue;
    }
    const previous = await readStatus(statusPath(mediaPath));
    if (previous?.next_retry_at && Date.parse(previous.next_retry_at) > Date.now()) {
      result.skippedBackoff += 1;
      continue;
    }
    const attempts = (previous?.attempts ?? 0) + 1;
    try {
      const transcribed = await transcriber.transcribe({
        inputPath: mediaPath,
      });
      const text = transcribed.text.trim();
      if (!text) throw new Error('empty transcript');
      await writePrivateFile(transcriptPath(mediaPath), `${text}\n`);
      await writeStatus(mediaPath, {
        kind: 'whatsapp_audio_transcription_status',
        status: 'transcribed',
        attempts,
        error_class: null,
        extractor_kind: config.extractorKind,
        extractor_version: config.extractorVersion,
        updated_at: nowIso(),
        next_retry_at: null,
      });
      result.transcribed += 1;
    } catch (error) {
      await writeStatus(mediaPath, {
        kind: 'whatsapp_audio_transcription_status',
        status: 'failed_retryable',
        attempts,
        error_class: classifyTranscriptionError(error),
        extractor_kind: config.extractorKind,
        extractor_version: config.extractorVersion,
        updated_at: nowIso(),
        next_retry_at: new Date(Date.now() + config.errorBackoffMs * attempts).toISOString(),
      });
      result.failedRetryable += 1;
    }
    result.workDone += 1;
  }
  return result;
}

async function listAudioMediaFiles(mediaDir: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(mediaDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const files: string[] = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const name = entry.name;
    if (name.endsWith('.transcript.txt') || name.endsWith('.transcript.status.json') || name.endsWith('.tmp')) continue;
    const ext = extname(name).toLowerCase();
    if (AUDIO_EXTENSIONS.has(ext)) files.push(join(mediaDir, name));
  }
  return files.sort();
}

function resolveConfig(env: Record<string, string | undefined>): WhatsAppTranscribeDrainConfig {
  const stateDir = env.OLYMPUS_WHATSAPP_TRANSCRIBE_STATE_DIR?.trim()
    || env.OLYMPUS_WHATSAPP_STATE_DIR?.trim()
    || join(homeDir(), DEFAULT_STATE_REL);
  return {
    mediaDir: env.OLYMPUS_WHATSAPP_TRANSCRIBE_MEDIA_DIR?.trim() || join(stateDir, 'media', 'audio'),
    idleSleepMs: positiveSeconds(env.OLYMPUS_WHATSAPP_TRANSCRIBE_IDLE_SLEEP_SECONDS, DEFAULT_IDLE_SLEEP_SECONDS, 'OLYMPUS_WHATSAPP_TRANSCRIBE_IDLE_SLEEP_SECONDS') * 1_000,
    errorBackoffMs: positiveSeconds(env.OLYMPUS_WHATSAPP_TRANSCRIBE_ERROR_BACKOFF_SECONDS, DEFAULT_ERROR_BACKOFF_SECONDS, 'OLYMPUS_WHATSAPP_TRANSCRIBE_ERROR_BACKOFF_SECONDS') * 1_000,
    maxRuns: maxRuns(env.OLYMPUS_WHATSAPP_TRANSCRIBE_MAX_RUNS),
    stopWhenIdle: booleanEnv(env.OLYMPUS_WHATSAPP_TRANSCRIBE_STOP_WHEN_IDLE, false),
    ...(env.OLYMPUS_WHATSAPP_TRANSCRIBE_REPORT_PATH?.trim() ? { reportPath: env.OLYMPUS_WHATSAPP_TRANSCRIBE_REPORT_PATH.trim() } : {}),
    extractorKind: env.OLYMPUS_WHATSAPP_TRANSCRIBE_EXTRACTOR_KIND?.trim() || WHATSAPP_TRANSCRIPT_EXTRACTOR_KIND,
    extractorVersion: env.OLYMPUS_WHATSAPP_TRANSCRIBE_EXTRACTOR_VERSION?.trim() || WHATSAPP_TRANSCRIPT_EXTRACTOR_VERSION,
  };
}

async function readStatus(path: string): Promise<WhatsAppTranscriptStatusFile | undefined> {
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8')) as Partial<WhatsAppTranscriptStatusFile>;
    return {
      kind: 'whatsapp_audio_transcription_status',
      status: parsed.status === 'transcribed' ? 'transcribed' : 'failed_retryable',
      attempts: Number.isInteger(parsed.attempts) && parsed.attempts! > 0 ? parsed.attempts! : 0,
      error_class: typeof parsed.error_class === 'string' ? parsed.error_class : null,
      extractor_kind: typeof parsed.extractor_kind === 'string' ? parsed.extractor_kind : WHATSAPP_TRANSCRIPT_EXTRACTOR_KIND,
      extractor_version: typeof parsed.extractor_version === 'string' ? parsed.extractor_version : WHATSAPP_TRANSCRIPT_EXTRACTOR_VERSION,
      updated_at: typeof parsed.updated_at === 'string' ? parsed.updated_at : nowIso(),
      next_retry_at: typeof parsed.next_retry_at === 'string' ? parsed.next_retry_at : null,
    };
  } catch {
    return undefined;
  }
}

async function writeStatus(mediaPath: string, statusFile: WhatsAppTranscriptStatusFile): Promise<void> {
  await writePrivateFile(statusPath(mediaPath), `${JSON.stringify(statusFile, null, 2)}\n`);
}

async function writeHeartbeat(config: WhatsAppTranscribeDrainConfig, summary: WhatsAppTranscribeDrainSummary): Promise<void> {
  if (!config.reportPath) return;
  await mkdir(dirname(config.reportPath), { recursive: true }).catch(() => undefined);
  await writePrivateFile(config.reportPath, `${JSON.stringify({ ...summary, updated_at: nowIso() }, null, 2)}\n`);
}

/**
 * Temp file, fsync, rename. The transcript sidecar IS the message's stored
 * text and its existence is the only record that the work finished, so a
 * partial one written through a crash would be read as a complete transcript
 * for good.
 */
async function writePrivateFile(path: string, text: string): Promise<void> {
  await writePrivateFileAtomic(path, text);
}

/**
 * Non-empty, not merely present: an empty transcript is never written (the
 * pass throws on one), so a zero-byte sidecar is crash residue from before the
 * atomic write and has to be transcribed again rather than skipped forever.
 */
async function hasTranscript(path: string): Promise<boolean> {
  try {
    return (await stat(path)).size > 0;
  } catch {
    return false;
  }
}

export function transcriptPath(mediaPath: string): string {
  return `${mediaPath}.transcript.txt`;
}

export function statusPath(mediaPath: string): string {
  return `${mediaPath}.transcript.status.json`;
}

function classifyTranscriptionError(error: unknown): string {
  const text = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
  if (text.includes('timeout') || text.includes('deadline')) return 'timeout';
  if (text.includes('empty transcript') || text.includes('no transcript')) return 'empty_transcript';
  if (text.includes('enoent') || text.includes('not found')) return 'command_not_found';
  return 'transcriber_failed';
}

function positiveSeconds(value: string | undefined, fallback: number, name: string): number {
  if (value === undefined || value.trim() === '') return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) throw new Error(`${name} must be a non-negative number of seconds.`);
  return parsed;
}

function maxRuns(value: string | undefined): number | 'unbounded' {
  const text = value?.trim();
  if (!text || text === 'unbounded') return 'unbounded';
  const parsed = Number(text);
  if (!Number.isInteger(parsed) || parsed < 1) throw new Error('OLYMPUS_WHATSAPP_TRANSCRIBE_MAX_RUNS must be a positive integer or unbounded.');
  return parsed;
}

function booleanEnv(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value.trim() === '') return fallback;
  return value === '1' || value.toLowerCase() === 'true';
}

async function sleep(ms: number, stopState: StopState): Promise<void> {
  const started = Date.now();
  while (!stopState.stopped && Date.now() - started < ms) {
    await new Promise((resolve) => setTimeout(resolve, Math.min(250, ms)));
  }
}

function homeDir(): string {
  const home = process.env.HOME;
  if (!home) throw new Error('HOME is required when OLYMPUS_WHATSAPP_STATE_DIR is unset.');
  return home;
}

function nowIso(): string {
  return new Date().toISOString();
}

if (import.meta.main) {
  const stopState = { stopped: false };
  process.on('SIGTERM', () => {
    stopState.stopped = true;
  });
  process.on('SIGINT', () => {
    stopState.stopped = true;
  });
  runWhatsAppTranscribeDrain(process.env, { stopState })
    .then((summary) => {
      console.log(JSON.stringify(summary, null, 2));
    })
    .catch((error) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exit(1);
    });
}
