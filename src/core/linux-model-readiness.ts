/** Content-free local status; does not download models or change W2 selection. */
import { builtInAnalystEnabled, builtInPrivateModelStatus } from './analyst-built-in.ts';
import { BUILT_IN_EMBEDDING_MODEL } from '../workers/source-index/built-in-embedding/manifest.ts';
import { readBuiltInEmbeddingStatus } from '../workers/source-index/built-in-embedding/assets.ts';
import { BUILT_IN_TRANSCRIPTION_ENV, audioDecoderPresent, builtInTranscriptionEnabled, readBuiltInTranscriptionStatusFile, builtInTranscriptionDashboardState } from '../workers/source-index/built-in-reasoning/transcription-model.ts';
import { QWEN3_ASR_06B } from '../workers/source-index/built-in-reasoning/manifest.ts';

export interface LocalModelReadiness {
  name: string; state: string; detail: string; downloadBytes: number;
  /** The model's display name ("Qwen3.5 4B"), when known. */
  model?: string;
  /** Unavailable only: the one cause that applies, in a short clause (#1043). */
  cause?: string;
}
export function linuxModelReadiness(env: Record<string, string | undefined> = process.env, options: {
  totalMemoryBytes?: number; decoderPresent?: () => boolean;
} = {}): LocalModelReadiness[] {
  const embedding = readBuiltInEmbeddingStatus(env, BUILT_IN_EMBEDDING_MODEL);
  const privateModel = builtInPrivateModelStatus(env, options.totalMemoryBytes);
  const privateOn = builtInAnalystEnabled(env, `linux-${process.arch}`);
  const privateEnabled = privateOn && privateModel.enabled;
  const transcriptionEnabled = builtInTranscriptionEnabled(env, `linux-${process.arch}`, options.decoderPresent);
  const transcription = builtInTranscriptionDashboardState(readBuiltInTranscriptionStatusFile(env));
  return [
    { name: 'Embedding', state: embedding.state, detail: `${BUILT_IN_EMBEDDING_MODEL.modelId}: ${embedding.state}. Downloads and warms at first worker start.`, downloadBytes: BUILT_IN_EMBEDDING_MODEL.model.bytes },
    { name: 'Private answers', state: privateEnabled ? privateModel.state : 'unavailable', detail: privateEnabled
      ? `${privateModel.displayName}: ${privateModel.state}. Downloads when needed; Private-source policy still applies.`
      : privateOn ? privateModel.label : 'Built-in private model is off (OLYMPUS_BUILT_IN_ANALYST).', downloadBytes: privateModel.downloadBytes ?? 0,
      ...(privateModel.displayName ? { model: privateModel.displayName } : {}),
      ...(privateEnabled ? {} : { cause: privateOn ? 'this computer does not have enough memory for it' : 'OLYMPUS_BUILT_IN_ANALYST is set to off' }) },
    { name: 'Transcription', state: transcriptionEnabled ? transcription.state : 'unavailable', detail: env.OLYMPUS_TRANSCRIBE_COMMAND?.trim()
      ? 'An external transcription command is configured.'
      : transcriptionEnabled ? `Qwen3-ASR 0.6B: ${transcription.state}. Downloads when audio is chosen.`
      : transcriptionOffReason(env, options.decoderPresent ?? (() => audioDecoderPresent(`linux-${process.arch}`, env))),
      downloadBytes: QWEN3_ASR_06B.files.reduce((sum, file) => sum + file.bytes, 0), model: 'Qwen3-ASR 0.6B',
      ...(transcriptionEnabled || env.OLYMPUS_TRANSCRIBE_COMMAND?.trim() ? {} : { cause: transcriptionOffCause(env, options.decoderPresent ?? (() => audioDecoderPresent(`linux-${process.arch}`, env))) }) },
  ];
}

/** Names the one cause that applies (#1046): turned off by setting, or no audio decoder. */
function transcriptionOffReason(env: Record<string, string | undefined>, decoderPresent: () => boolean): string {
  const raw = env[BUILT_IN_TRANSCRIPTION_ENV]?.trim().toLowerCase();
  if (raw === 'off' || raw === 'false' || raw === '0' || raw === 'no') {
    return `Built-in transcription is turned off by ${BUILT_IN_TRANSCRIPTION_ENV}=${raw}. Remove that setting to turn it on, then restart Olympus.`;
  }
  if (decoderPresent()) return 'Built-in transcription is not available for this kind of computer.';
  return 'Built-in transcription needs ffmpeg, which is not installed. Install ffmpeg, then restart Olympus.';
}

/** The same one cause, as a clause after "off:" on Settings › Models on this computer. */
function transcriptionOffCause(env: Record<string, string | undefined>, decoderPresent: () => boolean): string {
  const raw = env[BUILT_IN_TRANSCRIPTION_ENV]?.trim().toLowerCase();
  if (raw === 'off' || raw === 'false' || raw === '0' || raw === 'no') return `${BUILT_IN_TRANSCRIPTION_ENV} is set to ${raw}`;
  if (decoderPresent()) return 'not available for this kind of computer';
  return 'ffmpeg is not installed';
}
