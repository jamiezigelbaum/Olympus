// Where the built-in transcription model lives and how it is installed. It is
// the second user of the pinned-model installer (install.ts): its two files
// (the Qwen3-ASR weights and their audio projector) download into their own
// directory with their own status file, and it runs on the same verified
// llama.cpp runtime the reasoning model uses, installed once. Nothing here
// sends audio anywhere; this module only fetches the pinned model files.

import { isAbsolute, join } from 'node:path';
import { modelInstallFailedReason, type ModelInstallFailedReason } from '../../../core/model-install-failure.ts';
import {
  currentPlatform,
  installPinnedModel,
  llamaServerRuntimeDir,
  llamaServerRuntimeLockPath,
  olympusModelsDir,
  readPinnedModelStatus,
  reportPinnedModelState,
  type BuiltInReasoningFailureReason,
  type BuiltInReasoningStatus,
  type PinnedInstallTuning,
  type PinnedModelLayout,
} from './install.ts';
import {
  LLAMA_SERVER_RUNTIME,
  QWEN3_ASR_06B,
  runtimeArchiveFor,
  type BuiltInTranscriptionModelSpec,
  type LlamaServerRuntimeSpec,
} from './manifest.ts';

/** Overrides where the transcription model's files live (an absolute path). */
export const BUILT_IN_TRANSCRIPTION_DIR_ENV = 'OLYMPUS_BUILT_IN_TRANSCRIPTION_DIR';
/** `on`, `off`, or unset (on for Apple-silicon Macs, off elsewhere). */
export const BUILT_IN_TRANSCRIPTION_ENV = 'OLYMPUS_BUILT_IN_TRANSCRIPTION';
export const BUILT_IN_TRANSCRIPTION_NOUN = 'built-in transcription model';

export interface InstalledBuiltInTranscription {
  modelPath: string;
  mmprojPath: string;
  serverPath: string;
  gpu: boolean;
}

export interface BuiltInTranscriptionInstallerOptions extends PinnedInstallTuning {
  model?: BuiltInTranscriptionModelSpec;
}

/** `<models dir>/built-in-transcription`, with the runtime shared from the reasoning directory. */
export function builtInTranscriptionLayout(
  model: Pick<BuiltInTranscriptionModelSpec, 'modelId'> = QWEN3_ASR_06B,
  env: Record<string, string | undefined> = process.env,
  runtime: LlamaServerRuntimeSpec = LLAMA_SERVER_RUNTIME,
  platform = currentPlatform(),
): PinnedModelLayout {
  const root = env[BUILT_IN_TRANSCRIPTION_DIR_ENV]?.trim() || join(olympusModelsDir(env), 'built-in-transcription');
  if (!isAbsolute(root)) throw new TypeError('The built-in transcription directory must be an absolute path.');
  return {
    root,
    modelDir: join(root, model.modelId),
    runtimeDir: llamaServerRuntimeDir(env, runtime, platform),
    runtimeLockPath: llamaServerRuntimeLockPath(env),
    statusPath: join(root, 'status.json'),
    lockPath: join(root, 'install.lock'),
    noun: BUILT_IN_TRANSCRIPTION_NOUN,
  };
}

/** Downloads (once), verifies and returns the transcription model and the shared server. */
export async function installBuiltInTranscription(
  options: BuiltInTranscriptionInstallerOptions = {},
): Promise<InstalledBuiltInTranscription> {
  const { model = QWEN3_ASR_06B, ...tuning } = options;
  const runtime = options.runtime ?? LLAMA_SERVER_RUNTIME;
  const platform = options.platform ?? currentPlatform();
  const installed = await installPinnedModel({
    ...tuning,
    bundle: { modelId: model.modelId, displayName: model.displayName, files: model.files },
    layout: builtInTranscriptionLayout(model, options.env, runtime, platform),
  });
  return {
    modelPath: installed.filePaths[0]!,
    mmprojPath: installed.filePaths[1]!,
    serverPath: installed.serverPath,
    gpu: installed.gpu,
  };
}

/** The status file's last word on the transcription model. Never throws, never downloads. */
export function readBuiltInTranscriptionStatus(
  env: Record<string, string | undefined> = process.env,
  model: Pick<BuiltInTranscriptionModelSpec, 'modelId'> = QWEN3_ASR_06B,
): BuiltInReasoningStatus {
  try {
    return readPinnedModelStatus(builtInTranscriptionLayout(model, env).statusPath, model.modelId, BUILT_IN_TRANSCRIPTION_NOUN);
  } catch {
    return readPinnedModelStatus('', model.modelId, BUILT_IN_TRANSCRIPTION_NOUN);
  }
}

/** Marks the transcription model loading, ready or failed as its server starts. */
export function reportBuiltInTranscriptionState(
  env: Record<string, string | undefined>,
  model: Pick<BuiltInTranscriptionModelSpec, 'modelId'>,
  state: 'loading' | 'ready' | 'failed',
  failure?: { reason: BuiltInReasoningFailureReason; message: string },
): void {
  try {
    reportPinnedModelState({
      statusPath: builtInTranscriptionLayout(model, env).statusPath,
      modelId: model.modelId,
      noun: BUILT_IN_TRANSCRIPTION_NOUN,
    }, state, failure);
  } catch {
    // Status is advisory.
  }
}

/**
 * Whether audio may be transcribed by the built-in model here: explicitly on
 * or off by env, otherwise on for Apple silicon only (the Metal build and the
 * system audio decoder), so a Linux host never downloads a model it did not
 * ask for. A platform without a pinned runtime never qualifies.
 */
export function builtInTranscriptionEnabled(
  env: Record<string, string | undefined> = process.env,
  platform = currentPlatform(),
): boolean {
  const raw = env[BUILT_IN_TRANSCRIPTION_ENV]?.trim().toLowerCase();
  if (raw === 'off' || raw === 'false' || raw === '0' || raw === 'no') return false;
  if (!runtimeArchiveFor(platform)) return false;
  if (raw === 'on' || raw === 'true' || raw === '1' || raw === 'yes') return true;
  return platform === 'darwin-arm64';
}

/**
 * What the dashboard shows for the built-in transcription model. Its install
 * starts only when the owner's chosen sources contain audio, so a model never
 * started reads `not_needed`. Downloading and checking read as such; a model
 * on disk whose server is starting reads ready.
 */
export interface BuiltInTranscriptionDashboardState {
  state: 'not_needed' | 'downloading' | 'verifying' | 'ready' | 'failed';
  percent?: number;
  bytesDone?: number;
  bytesTotal?: number;
  failedReason?: ModelInstallFailedReason;
}

export function builtInTranscriptionDashboardState(status: BuiltInReasoningStatus): BuiltInTranscriptionDashboardState {
  if (status.state === 'not_started') return { state: 'not_needed' };
  if (status.state === 'ready' || status.state === 'loading') return { state: 'ready' };
  if (status.state === 'failed') return { state: 'failed', failedReason: modelInstallFailedReason(status.failure) };
  return {
    state: status.state === 'verifying' ? 'verifying' : 'downloading',
    percent: status.percent,
    ...(status.bytesTotal > 0 ? { bytesDone: status.bytesDone, bytesTotal: status.bytesTotal } : {}),
  };
}
