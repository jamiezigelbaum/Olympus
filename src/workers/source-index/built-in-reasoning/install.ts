// Fetches, verifies and installs the built-in private reasoning model and the
// llama.cpp server that runs it into the Olympus data directory, once. Every
// file is checked against the pinned manifest before it is used; a file that
// does not match is deleted, never loaded. Progress goes to a small status
// file (the same shape the built-in embedding lane writes) so the dashboard
// engine can show "installing" with a percent and a label.

import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  closeSync,
  createReadStream,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  statfsSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import {
  LLAMA_SERVER_RUNTIME,
  runtimeArchiveFor,
  type BuiltInReasoningModelSpec,
  type LlamaServerRuntimeSpec,
  type PinnedReasoningFile,
  type PinnedRuntimeArchive,
} from './manifest.ts';

export type BuiltInReasoningState = 'not_started' | 'downloading' | 'verifying' | 'loading' | 'ready' | 'failed';

export type BuiltInReasoningFailureReason =
  | 'unsupported_platform'
  | 'insufficient_memory'
  | 'download_failed'
  | 'checksum_mismatch'
  | 'disk_write_failed'
  | 'insufficient_space'
  | 'runtime_load_failed';

/** Set on an `insufficient_space` failure: what the download needs and what the disk has. */
export interface BuiltInReasoningSpaceShortfall {
  /** Free bytes needed before the download (re)starts: what is left to fetch plus headroom. */
  bytesNeeded: number;
  bytesFree: number;
  /** No new attempt (not even a disk check) before this time. */
  retryAfter: string;
}

export interface BuiltInReasoningStatus {
  state: BuiltInReasoningState;
  modelId: string;
  /** 0-100, whole numbers. */
  percent: number;
  label: string;
  bytesDone: number;
  bytesTotal: number;
  updatedAt: string;
  failure?: { reason: BuiltInReasoningFailureReason; message: string } & Partial<BuiltInReasoningSpaceShortfall>;
}

export type BuiltInReasoningProgressListener = (status: BuiltInReasoningStatus) => void;

export interface BuiltInReasoningPaths {
  root: string;
  modelDir: string;
  runtimeDir: string;
  statusPath: string;
  lockPath: string;
  /** Guards the shared llama.cpp runtime, which every built-in model uses. */
  runtimeLockPath: string;
}

export interface InstalledBuiltInReasoning {
  modelPath: string;
  serverPath: string;
  gpu: boolean;
}

/** The knobs every pinned-model install shares (the reasoning and transcription models alike). */
export interface PinnedInstallTuning {
  env?: Record<string, string | undefined>;
  runtime?: LlamaServerRuntimeSpec;
  /** `${platform}-${arch}`; defaults to this process. */
  platform?: string;
  fetchImpl?: typeof fetch;
  onProgress?: BuiltInReasoningProgressListener;
  now?: () => Date;
  /** How long to wait for another process that holds the install lock. */
  lockWaitMs?: number;
  /** Unpacks a verified runtime archive into a directory (tests substitute it). */
  extractArchive?: (archivePath: string, targetDir: string) => void;
  /** Longest a download may go without receiving a byte before it is abandoned (resumable). */
  downloadStallMs?: number;
  /** Longest the checksum pass over the model file may take. */
  verifyTimeoutMs?: number;
  /** One line per install stage; defaults to the worker log. */
  log?: (line: string) => void;
  /** Free bytes on the volume holding `path`; defaults to statfs. */
  freeBytes?: (path: string) => number | undefined;
  /** Free space the download must leave on the disk. */
  spaceHeadroomBytes?: number;
  /** After the disk ran out of space, how long before the next attempt. */
  spaceBackoffMs?: number;
  /** How often the install lock holder refreshes its lock. */
  lockRefreshMs?: number;
  /** Writes one downloaded chunk (tests simulate a full disk with it). */
  writeChunk?: (fd: number, chunk: Uint8Array) => void;
}

export interface BuiltInReasoningInstallerOptions extends PinnedInstallTuning {
  model: BuiltInReasoningModelSpec;
}

/**
 * One installable model: every file it needs (a GGUF, and for an audio or
 * vision model its projector), each pinned by URL, size and SHA-256.
 */
export interface PinnedModelBundle {
  modelId: string;
  displayName: string;
  files: readonly PinnedReasoningFile[];
}

/** Where a bundle lives, and the words its status file uses ("built-in private model"). */
export interface PinnedModelLayout extends BuiltInReasoningPaths {
  noun: string;
}

export interface InstalledPinnedModel {
  /** One path per bundle file, in the bundle's order. */
  filePaths: string[];
  serverPath: string;
  gpu: boolean;
}

export interface PinnedModelInstallerOptions extends PinnedInstallTuning {
  bundle: PinnedModelBundle;
  layout: PinnedModelLayout;
}

export const BUILT_IN_REASONING_DIR_ENV = 'OLYMPUS_BUILT_IN_REASONING_DIR';
const REASONING_NOUN = 'built-in private model';
/**
 * A lock whose holder has not refreshed it for this long is abandoned even if
 * its PID is alive (the PID was reused, or the holder is wedged). A holder
 * that is still installing refreshes it every LOCK_REFRESH_MS, so a slow
 * multi-hour download keeps its lock.
 */
const STALE_LOCK_MS = 60 * 60_000;
const LOCK_REFRESH_MS = 30_000;
const LOCK_POLL_MS = 1_000;
/** Free space a model download must leave behind, so it never fills the disk. */
export const BUILT_IN_REASONING_SPACE_HEADROOM_BYTES = 2 * 1024 ** 3;
/** Runtime archives are unpacked next to themselves; budget a few times their size. */
const RUNTIME_UNPACK_FACTOR = 4;
const SPACE_BACKOFF_MS = 15 * 60_000;
const PROGRESS_WRITE_INTERVAL_MS = 500;
/** No byte for this long and a download is abandoned; the partial file is kept and resumes on retry. */
const DOWNLOAD_STALL_MS = 2 * 60_000;
/** A checksum pass over a few gigabytes takes seconds to a minute or two; far past that, something is wrong. */
const VERIFY_TIMEOUT_MS = 15 * 60_000;
const EXTRACT_TIMEOUT_MS = 5 * 60_000;
const LOG_PREFIX = '[built-in-model]';
const RUNTIME_MARKER = 'olympus-runtime.json';
const SERVER_BINARY = 'llama-server';

export class BuiltInReasoningInstallError extends Error {
  readonly reason: BuiltInReasoningFailureReason;
  readonly shortfall: BuiltInReasoningSpaceShortfall | undefined;

  constructor(reason: BuiltInReasoningFailureReason, message: string, shortfall?: BuiltInReasoningSpaceShortfall) {
    super(message);
    this.name = 'BuiltInReasoningInstallError';
    this.reason = reason;
    this.shortfall = shortfall;
  }
}

/** `<XDG_DATA_HOME or ~/.local/share>/openclaw/olympus/models/built-in-reasoning`. */
export function builtInReasoningPaths(
  model: Pick<BuiltInReasoningModelSpec, 'modelId'>,
  env: Record<string, string | undefined> = process.env,
  runtime: LlamaServerRuntimeSpec = LLAMA_SERVER_RUNTIME,
  platform = currentPlatform(),
): BuiltInReasoningPaths {
  const root = builtInReasoningRoot(env);
  return {
    root,
    modelDir: join(root, model.modelId),
    runtimeDir: llamaServerRuntimeDir(env, runtime, platform),
    statusPath: join(root, 'status.json'),
    lockPath: join(root, 'install.lock'),
    runtimeLockPath: join(root, 'runtime.lock'),
  };
}

function builtInReasoningRoot(env: Record<string, string | undefined>): string {
  const root = env[BUILT_IN_REASONING_DIR_ENV]?.trim() || join(olympusModelsDir(env), 'built-in-reasoning');
  if (!isAbsolute(root)) throw new TypeError('The built-in reasoning directory must be an absolute path.');
  return root;
}

/** `<XDG_DATA_HOME or ~/.local/share>/openclaw/olympus/models`. */
export function olympusModelsDir(env: Record<string, string | undefined> = process.env): string {
  const dataRoot = env.XDG_DATA_HOME?.trim() || join(env.HOME?.trim() || homedir(), '.local', 'share');
  return join(dataRoot, 'openclaw', 'olympus', 'models');
}

/**
 * The one llama.cpp runtime every built-in model runs on. It lives beside the
 * reasoning model (where the first release put it), is installed once, and is
 * guarded by its own lock, so a second model never downloads it again.
 */
export function llamaServerRuntimeDir(
  env: Record<string, string | undefined> = process.env,
  runtime: LlamaServerRuntimeSpec = LLAMA_SERVER_RUNTIME,
  platform = currentPlatform(),
): string {
  return join(builtInReasoningRoot(env), `llama.cpp-${runtime.release}-${platform}`);
}

/** The shared runtime's lock file. */
export function llamaServerRuntimeLockPath(env: Record<string, string | undefined> = process.env): string {
  return join(builtInReasoningRoot(env), 'runtime.lock');
}

export function currentPlatform(): string {
  return `${process.platform}-${process.arch}`;
}

/** The last status any process wrote for `model`, or `not_started`. Never throws. */
export function readBuiltInReasoningStatus(
  model: Pick<BuiltInReasoningModelSpec, 'modelId'>,
  env: Record<string, string | undefined> = process.env,
): BuiltInReasoningStatus {
  return readPinnedModelStatus(builtInReasoningPaths(model, env).statusPath, model.modelId, REASONING_NOUN);
}

/** The last status written to `statusPath` for `modelId`, or `not_started`. Never throws. */
export function readPinnedModelStatus(statusPath: string, modelId: string, noun: string): BuiltInReasoningStatus {
  const fallback: BuiltInReasoningStatus = {
    state: 'not_started',
    modelId,
    percent: 0,
    label: `${capitalize(noun)} not downloaded yet`,
    bytesDone: 0,
    bytesTotal: 0,
    updatedAt: new Date(0).toISOString(),
  };
  try {
    const parsed = JSON.parse(readFileSync(statusPath, 'utf8')) as BuiltInReasoningStatus;
    return parsed && typeof parsed === 'object' && parsed.modelId === modelId ? parsed : fallback;
  } catch {
    return fallback;
  }
}

/**
 * Ensures the model and the server are on disk and verified, downloading what
 * is missing (resuming a partial model download). Safe to call from several
 * processes: one installs, the others wait.
 */
export async function installBuiltInReasoning(
  options: BuiltInReasoningInstallerOptions,
): Promise<InstalledBuiltInReasoning> {
  const { model, ...tuning } = options;
  const runtime = options.runtime ?? LLAMA_SERVER_RUNTIME;
  const platform = options.platform ?? currentPlatform();
  const installed = await installPinnedModel({
    ...tuning,
    bundle: { modelId: model.modelId, displayName: model.displayName, files: [model.file] },
    layout: { ...builtInReasoningPaths(model, options.env, runtime, platform), noun: REASONING_NOUN },
  });
  return { modelPath: installed.filePaths[0]!, serverPath: installed.serverPath, gpu: installed.gpu };
}

/**
 * Installs one pinned bundle and the shared runtime: verify what is on disk,
 * download (resuming) what is missing, check every byte against the manifest,
 * and report each stage to the bundle's status file. The reasoning and the
 * transcription models both go through here.
 */
export async function installPinnedModel(options: PinnedModelInstallerOptions): Promise<InstalledPinnedModel> {
  const { bundle, layout: paths } = options;
  const noun = paths.noun;
  const runtime = options.runtime ?? LLAMA_SERVER_RUNTIME;
  const platform = options.platform ?? currentPlatform();
  const reporter = new ProgressReporter(paths.statusPath, bundle.modelId, noun, options.now, options.onProgress);
  const files = bundle.files.map((file) => ({ file, path: join(paths.modelDir, file.name) }));
  const filesPresent = (): boolean => files.every(({ path }) => existsSync(path));
  const log = options.log ?? ((line: string) => console.log(line));
  const timing = {
    downloadStallMs: options.downloadStallMs ?? DOWNLOAD_STALL_MS,
    verifyTimeoutMs: options.verifyTimeoutMs ?? VERIFY_TIMEOUT_MS,
  };
  const lockWaitMs = options.lockWaitMs ?? STALE_LOCK_MS;
  const lockRefreshMs = options.lockRefreshMs ?? LOCK_REFRESH_MS;
  const stage = async <T>(name: string, run: () => Promise<T> | T): Promise<T> => {
    const started = Date.now();
    log(`${LOG_PREFIX} model=${bundle.modelId} stage=${name} started`);
    try {
      const result = await run();
      log(`${LOG_PREFIX} model=${bundle.modelId} stage=${name} done ms=${Date.now() - started}`);
      return result;
    } catch (error) {
      const reason = error instanceof BuiltInReasoningInstallError ? error.reason : 'disk_write_failed';
      log(`${LOG_PREFIX} model=${bundle.modelId} stage=${name} failed reason=${reason} ms=${Date.now() - started}`);
      throw error;
    }
  };
  const verifyAll = async (): Promise<void> => {
    for (const { file, path } of files) await verifyPinnedFile(path, file, noun, reporter, timing.verifyTimeoutMs);
  };
  // The install has finished only when the status file says so. Leaving the
  // last stage's "verifying" behind kept every later boot reading the model
  // as not ready, and nothing ever moved it on (owner fresh install,
  // 2026-10-01). The server itself starts on demand and reports "loading"
  // while it does.
  const finished = (): void => reporter.set('ready', `${capitalize(noun)} ready`, 100);

  try {
    const archive = runtimeArchiveFor(platform, runtime);
    if (!archive) {
      throw new BuiltInReasoningInstallError(
        'unsupported_platform',
        `The ${noun} does not run on ${platform}.`,
      );
    }
    ensureDirectory(paths.root);
    const installed = (): InstalledPinnedModel => ({
      filePaths: files.map(({ path }) => path),
      serverPath: findServerBinary(paths.runtimeDir),
      gpu: archive.gpu,
    });

    if (filesPresent() && runtimeInstalled(paths.runtimeDir, archive)) {
      await stage('verify', verifyAll);
      finished();
      return installed();
    }

    // The disk ran out during an earlier attempt: wait out the backoff
    // instead of re-downloading into a disk that just filled up.
    const now = (options.now ?? (() => new Date()))();
    const previous = readPinnedModelStatus(paths.statusPath, bundle.modelId, noun);
    if (previous.state === 'failed' && previous.failure?.reason === 'insufficient_space'
      && previous.failure.retryAfter && Date.parse(previous.failure.retryAfter) > now.getTime()) {
      throw new BuiltInReasoningInstallError('insufficient_space', previous.failure.message, {
        bytesNeeded: previous.failure.bytesNeeded ?? 0,
        bytesFree: previous.failure.bytesFree ?? 0,
        retryAfter: previous.failure.retryAfter,
      });
    }

    const space: SpacePolicy = {
      noun,
      freeBytes: options.freeBytes ?? volumeFreeBytes,
      headroomBytes: options.spaceHeadroomBytes ?? BUILT_IN_REASONING_SPACE_HEADROOM_BYTES,
      backoffMs: options.spaceBackoffMs ?? SPACE_BACKOFF_MS,
      now: () => (options.now ?? (() => new Date()))(),
      write: options.writeChunk ?? ((fd: number, chunk: Uint8Array) => { writeSync(fd, chunk); }),
    };
    await stage('install', () => withInstallLock(paths.lockPath, lockWaitMs, lockRefreshMs, noun, async () => {
      if (filesPresent() && runtimeInstalled(paths.runtimeDir, archive)) return;
      const fetchImpl = options.fetchImpl ?? fetch;
      const missing = files.filter(({ path }) => !existsSync(path));
      const needRuntime = !runtimeInstalled(paths.runtimeDir, archive);
      // Before any byte is fetched or any partial file is re-hashed: is there
      // room for what is left, plus headroom?
      const missingBytes = missing.reduce(
        (total, { file, path }) => total + Math.max(0, file.bytes - fileSize(`${path}.partial`)),
        0,
      );
      assertSpaceFor(paths.root, space,
        missingBytes + (needRuntime ? archive.bytes * RUNTIME_UNPACK_FACTOR : 0));
      reporter.begin(missing.reduce((total, { file }) => total + file.bytes, 0) + (needRuntime ? archive.bytes : 0));
      if (needRuntime) {
        // The runtime is shared by every built-in model, so it has its own
        // lock: a second model never unpacks over a runtime another installed.
        await stage('runtime', () => withInstallLock(paths.runtimeLockPath, lockWaitMs, lockRefreshMs, noun, async () => {
          if (runtimeInstalled(paths.runtimeDir, archive)) return;
          await installRuntime(fetchImpl, paths.runtimeDir, archive, reporter,
            options.extractArchive ?? extractWithTar, timing.downloadStallMs, space);
        }));
      }
      if (missing.length > 0) {
        ensureDirectory(paths.modelDir);
        for (const { file, path } of missing) {
          await stage('download', () => downloadVerified(fetchImpl, file.url, path, file.bytes, file.sha256,
            reporter, `Downloading the ${noun} (${bundle.displayName})`, timing.downloadStallMs, space));
        }
      }
    }));
    await stage('verify', verifyAll);
    if (!runtimeInstalled(paths.runtimeDir, archive)) {
      throw new BuiltInReasoningInstallError('runtime_load_failed', 'The built-in model server did not install completely.');
    }
    finished();
    return installed();
  } catch (error) {
    const failure = error instanceof BuiltInReasoningInstallError
      ? error
      : new BuiltInReasoningInstallError('disk_write_failed', error instanceof Error ? error.message : String(error));
    reporter.fail(failure.reason, failure.message, failure.shortfall);
    throw failure;
  }
}

interface SpacePolicy {
  /** What the messages call the model being installed. */
  noun: string;
  freeBytes: (path: string) => number | undefined;
  headroomBytes: number;
  backoffMs: number;
  now: () => Date;
  write: (fd: number, chunk: Uint8Array) => void;
}

/** Free bytes for an unprivileged user on the volume holding `path`, or undefined when unknown. */
function volumeFreeBytes(path: string): number | undefined {
  try {
    const stats = statfsSync(path);
    return Number(stats.bavail) * Number(stats.bsize);
  } catch {
    return undefined;
  }
}

function fileSize(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

function spaceShortfallError(space: SpacePolicy, bytesNeeded: number, bytesFree: number, cause?: string): BuiltInReasoningInstallError {
  const retryAfter = new Date(space.now().getTime() + space.backoffMs).toISOString();
  return new BuiltInReasoningInstallError(
    'insufficient_space',
    `Not enough free disk space for the ${space.noun}: it needs ${formatGb(bytesNeeded)} free and the disk has ${formatGb(bytesFree)}${cause ? ` (${cause})` : ''}. Free up space; Olympus tries again after ${retryAfter}.`,
    { bytesNeeded, bytesFree, retryAfter },
  );
}

/** Throws `insufficient_space` unless `bytes` plus headroom fit. An unknown free size does not block. */
function assertSpaceFor(dir: string, space: SpacePolicy, bytes: number): void {
  if (bytes <= 0) return;
  const free = space.freeBytes(dir);
  if (free === undefined) return;
  const needed = bytes + space.headroomBytes;
  if (free < needed) throw spaceShortfallError(space, needed, free);
}

function isNoSpaceError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return code === 'ENOSPC' || code === 'EDQUOT' || /ENOSPC|no space left/i.test(String(error));
}

function formatGb(bytes: number): string {
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
}

function capitalize(text: string): string {
  return text.length > 0 ? `${text[0]!.toUpperCase()}${text.slice(1)}` : text;
}

/** Marks the lane loading, ready or failed once the server is (being) started. */
export function reportBuiltInReasoningState(
  options: Pick<BuiltInReasoningInstallerOptions, 'env' | 'model' | 'now' | 'onProgress'>,
  state: 'loading' | 'ready' | 'failed',
  failure?: { reason: BuiltInReasoningFailureReason; message: string },
): void {
  const paths = builtInReasoningPaths(options.model, options.env);
  reportPinnedModelState({ statusPath: paths.statusPath, modelId: options.model.modelId, noun: REASONING_NOUN,
    ...(options.now ? { now: options.now } : {}), ...(options.onProgress ? { onProgress: options.onProgress } : {}) }, state, failure);
}

/** The same, for any pinned bundle's status file. */
export function reportPinnedModelState(
  target: { statusPath: string; modelId: string; noun: string; now?: () => Date; onProgress?: BuiltInReasoningProgressListener },
  state: 'loading' | 'ready' | 'failed',
  failure?: { reason: BuiltInReasoningFailureReason; message: string },
): void {
  const reporter = new ProgressReporter(target.statusPath, target.modelId, target.noun, target.now, target.onProgress);
  if (state === 'failed' && failure) reporter.fail(failure.reason, failure.message);
  else reporter.set(state, state === 'ready' ? `${capitalize(target.noun)} ready` : `Starting the ${target.noun}`, 100);
}

function findServerBinary(runtimeDir: string): string {
  const marker = readRuntimeMarker(runtimeDir);
  if (marker?.serverPath) return join(runtimeDir, marker.serverPath);
  throw new BuiltInReasoningInstallError('runtime_load_failed', 'The built-in model server is not installed.');
}

// Lazily created: a module-level initializer would keep this module alive in
// every bundle that merely imports a type from it.
let verifiedThisProcess: Set<string> | undefined;

async function verifyPinnedFile(
  path: string,
  file: PinnedReasoningFile,
  noun: string,
  reporter: ProgressReporter,
  timeoutMs: number,
): Promise<void> {
  const key = `${path}:${file.sha256}`;
  verifiedThisProcess ??= new Set<string>();
  if (verifiedThisProcess.has(key)) return;
  const size = statSync(path).size;
  const label = `Checking the ${noun}`;
  reporter.verifying(label, 0, file.bytes);
  const digest = size === file.bytes
    ? await sha256File(path, timeoutMs, (done) => reporter.verifying(label, done, file.bytes))
    : undefined;
  if (digest !== file.sha256) {
    rmSync(path, { force: true });
    throw new BuiltInReasoningInstallError(
      'checksum_mismatch',
      `${file.name} did not match its pinned checksum and was removed; it will download again.`,
    );
  }
  verifiedThisProcess.add(key);
}

// ---------------------------------------------------------------------------
// Runtime (llama.cpp release archive)

interface RuntimeMarker {
  archive: string;
  sha256: string;
  serverPath: string;
}

function readRuntimeMarker(runtimeDir: string): RuntimeMarker | undefined {
  try {
    return JSON.parse(readFileSync(join(runtimeDir, RUNTIME_MARKER), 'utf8')) as RuntimeMarker;
  } catch {
    return undefined;
  }
}

function runtimeInstalled(runtimeDir: string, archive: PinnedRuntimeArchive): boolean {
  const marker = readRuntimeMarker(runtimeDir);
  return marker !== undefined
    && marker.sha256 === archive.sha256
    && existsSync(join(runtimeDir, marker.serverPath));
}

async function installRuntime(
  fetchImpl: typeof fetch,
  runtimeDir: string,
  archive: PinnedRuntimeArchive,
  reporter: ProgressReporter,
  extract: (archivePath: string, targetDir: string) => void,
  stallMs: number,
  space: SpacePolicy,
): Promise<void> {
  const staging = `${runtimeDir}.staging-${randomUUID()}`;
  ensureDirectory(staging);
  try {
    const archivePath = join(staging, archive.name);
    await downloadVerified(fetchImpl, archive.url, archivePath, archive.bytes, archive.sha256, reporter,
      'Downloading the built-in model server', stallMs, space);
    reporter.set('verifying', 'Unpacking the built-in model server');
    try {
      extract(archivePath, staging);
    } catch (error) {
      if (isNoSpaceError(error)) {
        throw spaceShortfallError(space, archive.bytes * RUNTIME_UNPACK_FACTOR + space.headroomBytes,
          space.freeBytes(dirname(runtimeDir)) ?? 0, 'the disk filled up while unpacking');
      }
      throw new BuiltInReasoningInstallError(
        'runtime_load_failed',
        `The built-in model server could not be unpacked (${error instanceof Error ? error.message : String(error)}).`,
      );
    }
    rmSync(archivePath, { force: true });
    const server = locateFile(staging, SERVER_BINARY);
    if (!server) {
      throw new BuiltInReasoningInstallError('runtime_load_failed', `${archive.name} did not contain ${SERVER_BINARY}.`);
    }
    const marker: RuntimeMarker = { archive: archive.name, sha256: archive.sha256, serverPath: server };
    writeFileSync(join(staging, RUNTIME_MARKER), `${JSON.stringify(marker, null, 2)}\n`);
    rmSync(runtimeDir, { recursive: true, force: true });
    renameSync(staging, runtimeDir);
  } catch (error) {
    rmSync(staging, { recursive: true, force: true });
    throw error;
  }
}

/**
 * The archive is checksum-verified before this runs. The system `tar` keeps
 * the release's shared-library symlinks, which the server binary links against.
 */
function extractWithTar(archivePath: string, targetDir: string): void {
  const result = spawnSync('tar', ['-xzf', archivePath, '-C', targetDir], {
    stdio: ['ignore', 'ignore', 'pipe'],
    timeout: EXTRACT_TIMEOUT_MS,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(result.stderr?.toString().trim() || `tar exited with ${result.status ?? result.signal}`);
  }
}

/** Relative path of the first regular file named `name`, at most two levels down. */
function locateFile(root: string, name: string, depth = 0, prefix = ''): string | undefined {
  let entries: string[];
  try {
    entries = readdirSync(join(root, prefix));
  } catch {
    return undefined;
  }
  if (entries.includes(name)) {
    const relative = prefix ? `${prefix}/${name}` : name;
    try {
      if (statSync(join(root, relative)).isFile()) return relative;
    } catch {
      // fall through to subdirectories
    }
  }
  if (depth >= 2) return undefined;
  for (const entry of entries) {
    const child = prefix ? `${prefix}/${entry}` : entry;
    try {
      if (!statSync(join(root, child)).isDirectory()) continue;
    } catch {
      continue;
    }
    const found = locateFile(root, name, depth + 1, child);
    if (found) return found;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Downloads

async function downloadVerified(
  fetchImpl: typeof fetch,
  url: string,
  target: string,
  expectedBytes: number,
  expectedSha256: string,
  reporter: ProgressReporter,
  label: string,
  stallMs: number,
  space: SpacePolicy,
): Promise<void> {
  // One writer holds the install lock, so a fixed partial name is safe and lets
  // a multi-gigabyte download resume after a restart instead of starting over.
  const partial = `${target}.partial`;
  const hash = createHash('sha256');
  let received = 0;
  if (existsSync(partial)) {
    const size = statSync(partial).size;
    if (size > 0 && size < expectedBytes) {
      await hashInto(partial, hash, VERIFY_TIMEOUT_MS);
      received = size;
      reporter.advance(size, label);
    } else {
      rmSync(partial, { force: true });
    }
  }
  let response: Response;
  // One controller covers the request and every read: any wait longer than
  // `stallMs` for the next byte abandons the attempt (the partial file stays
  // and the next attempt resumes from it) instead of leaving the status on
  // "downloading" with nothing moving.
  const controller = new AbortController();
  let stallTimer: ReturnType<typeof setTimeout> | undefined;
  const armStall = (): void => {
    if (stallTimer) clearTimeout(stallTimer);
    stallTimer = setTimeout(() => controller.abort(new Error(`no data for ${Math.round(stallMs / 1000)} s`)), stallMs);
  };
  const disarmStall = (): void => {
    if (stallTimer) clearTimeout(stallTimer);
    stallTimer = undefined;
  };
  armStall();
  try {
    response = await fetchImpl(url, {
      redirect: 'follow',
      signal: controller.signal,
      ...(received > 0 ? { headers: { Range: `bytes=${received}-` } } : {}),
    });
  } catch (error) {
    disarmStall();
    throw new BuiltInReasoningInstallError(
      'download_failed',
      `Could not reach the download server for the ${space.noun} (${error instanceof Error ? error.message : String(error)}).`,
    );
  }
  if (received > 0 && response.status !== 206) {
    // The server ignored the range: start over from byte zero.
    disarmStall();
    rmSync(partial, { force: true });
    await response.body?.cancel().catch(() => undefined);
    reporter.advance(-received, label);
    return downloadVerified(fetchImpl, url, target, expectedBytes, expectedSha256, reporter, label, stallMs, space);
  }
  if (!response.ok || !response.body) {
    disarmStall();
    await response.body?.cancel().catch(() => undefined);
    throw new BuiltInReasoningInstallError(
      'download_failed',
      `The ${space.noun} download failed (HTTP ${response.status}).`,
    );
  }
  reporter.set('downloading', label);
  let fd: number;
  try {
    fd = openSync(partial, received > 0 ? 'a' : 'w', 0o644);
  } catch (error) {
    disarmStall();
    await response.body.cancel().catch(() => undefined);
    if (isNoSpaceError(error)) {
      rmSync(partial, { force: true });
      throw spaceShortfallError(space, expectedBytes + space.headroomBytes, space.freeBytes(dirname(target)) ?? 0, 'the disk is full');
    }
    throw new BuiltInReasoningInstallError('disk_write_failed', `Could not write ${partial}: ${String(error)}`);
  }
  try {
    const reader = response.body.getReader();
    const aborted = new Promise<never>((_resolve, reject) => {
      controller.signal.addEventListener('abort', () => reject(controller.signal.reason), { once: true });
    });
    aborted.catch(() => undefined);
    for (;;) {
      armStall();
      const { done, value } = await Promise.race([reader.read(), aborted]);
      if (done) break;
      received += value.byteLength;
      if (received > expectedBytes) {
        await reader.cancel().catch(() => undefined);
        closeSync(fd);
        rmSync(partial, { force: true });
        throw new BuiltInReasoningInstallError('checksum_mismatch', `${url} is larger than its pinned size.`);
      }
      hash.update(value);
      try {
        space.write(fd, value);
      } catch (error) {
        await reader.cancel().catch(() => undefined);
        if (isNoSpaceError(error)) {
          // A partial that filled the disk is not worth resuming: delete it
          // so the disk has its space back, and wait out the backoff.
          try {
            closeSync(fd);
          } catch {
            // closed below
          }
          rmSync(partial, { force: true });
          throw spaceShortfallError(space, expectedBytes + space.headroomBytes, space.freeBytes(dirname(target)) ?? 0, 'the disk filled up during the download');
        }
        throw new BuiltInReasoningInstallError('disk_write_failed', `Could not write the download: ${String(error)}`);
      }
      reporter.advance(value.byteLength, label);
    }
  } catch (error) {
    disarmStall();
    try {
      closeSync(fd);
    } catch {
      // already closed
    }
    if (error instanceof BuiltInReasoningInstallError) throw error;
    // Keep the partial file: the next attempt resumes from it.
    throw new BuiltInReasoningInstallError(
      'download_failed',
      `The ${space.noun} download was interrupted (${error instanceof Error ? error.message : String(error)}).`,
    );
  }
  disarmStall();
  closeSync(fd);
  if (received !== expectedBytes || hash.digest('hex') !== expectedSha256) {
    rmSync(partial, { force: true });
    throw new BuiltInReasoningInstallError(
      'checksum_mismatch',
      `${url} did not match its pinned checksum; nothing was installed.`,
    );
  }
  renameSync(partial, target);
}

/**
 * Hashes `path` into `hash`, reporting bytes read. A pass that has not ended
 * within `timeoutMs` (or whose stream closes without ending) fails instead of
 * leaving its caller waiting forever.
 */
function hashInto(
  path: string,
  hash: ReturnType<typeof createHash>,
  timeoutMs: number,
  onProgress?: (bytesDone: number) => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    let done = 0;
    let settled = false;
    const stream = createReadStream(path);
    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) {
        stream.destroy();
        reject(error);
      } else {
        resolve();
      }
    };
    const timer = setTimeout(() => finish(new BuiltInReasoningInstallError(
      'checksum_mismatch',
      `Checking ${path} did not finish within ${Math.round(timeoutMs / 60_000)} min.`,
    )), timeoutMs);
    stream
      .on('data', (chunk) => {
        hash.update(chunk);
        done += chunk.length;
        onProgress?.(done);
      })
      .on('error', (error) => finish(error))
      .on('end', () => finish())
      .on('close', () => finish(new Error(`Reading ${path} stopped before the end.`)));
  });
}

async function sha256File(path: string, timeoutMs: number, onProgress?: (bytesDone: number) => void): Promise<string> {
  const hash = createHash('sha256');
  await hashInto(path, hash, timeoutMs, onProgress);
  return hash.digest('hex');
}

// ---------------------------------------------------------------------------
// Cross-process install lock

async function withInstallLock(lockPath: string, waitMs: number, refreshMs: number, noun: string, run: () => Promise<void>): Promise<void> {
  const deadline = Date.now() + waitMs;
  const token = randomUUID();
  for (;;) {
    if (tryAcquireLock(lockPath, token)) break;
    if (Date.now() > deadline) {
      throw new BuiltInReasoningInstallError('download_failed', `Another Olympus process is still installing the ${noun}.`);
    }
    await new Promise((resolve) => setTimeout(resolve, LOCK_POLL_MS));
  }
  // The holder keeps its lock fresh for as long as it installs, however long
  // the download takes; only an unrefreshed lock can go stale.
  const refresh = setInterval(() => refreshLock(lockPath, token), refreshMs);
  refresh.unref?.();
  try {
    await run();
  } finally {
    clearInterval(refresh);
    if (lockHolder(lockPath)?.token === token) rmSync(lockPath, { force: true });
  }
}

interface LockHolder {
  pid?: number;
  at?: number;
  token?: string;
}

function lockHolder(lockPath: string): LockHolder | undefined {
  try {
    return JSON.parse(readFileSync(lockPath, 'utf8')) as LockHolder;
  } catch {
    return undefined;
  }
}

function refreshLock(lockPath: string, token: string): void {
  if (lockHolder(lockPath)?.token !== token) return;
  try {
    const temporary = `${lockPath}.${process.pid}.tmp`;
    writeFileSync(temporary, JSON.stringify({ pid: process.pid, at: Date.now(), token }), { mode: 0o600 });
    renameSync(temporary, lockPath);
  } catch {
    // The next refresh tries again; an hour of failures would let another process take over.
  }
}

function tryAcquireLock(lockPath: string, token: string): boolean {
  try {
    const fd = openSync(lockPath, 'wx', 0o600);
    writeSync(fd, JSON.stringify({ pid: process.pid, at: Date.now(), token }));
    closeSync(fd);
    return true;
  } catch {
    if (lockIsStale(lockPath)) {
      rmSync(lockPath, { force: true });
      return tryAcquireLock(lockPath, token);
    }
    return false;
  }
}

/**
 * Stale: the holder process is gone, or the lock has not been refreshed for
 * STALE_LOCK_MS (a reused PID or a wedged holder). A live holder refreshes it,
 * so its lock is never taken however long its download runs.
 */
function lockIsStale(lockPath: string): boolean {
  try {
    const holder = JSON.parse(readFileSync(lockPath, 'utf8')) as LockHolder;
    if (typeof holder.pid === 'number' && holder.pid !== process.pid) {
      try {
        process.kill(holder.pid, 0);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ESRCH') return true;
      }
    }
    return typeof holder.at === 'number' && Date.now() - holder.at > STALE_LOCK_MS;
  } catch {
    try {
      return Date.now() - statSync(lockPath).mtimeMs > STALE_LOCK_MS;
    } catch {
      return true;
    }
  }
}

function ensureDirectory(path: string): void {
  try {
    mkdirSync(path, { recursive: true, mode: 0o700 });
  } catch (error) {
    throw new BuiltInReasoningInstallError('disk_write_failed', `Could not create ${path}: ${String(error)}`);
  }
}

// ---------------------------------------------------------------------------
// Progress

class ProgressReporter {
  private readonly statusPath: string;
  private readonly modelId: string;
  private readonly noun: string;
  private readonly now: () => Date;
  private readonly listener: BuiltInReasoningProgressListener | undefined;
  private status: BuiltInReasoningStatus;
  private lastWriteMs: number;

  constructor(
    statusPath: string,
    modelId: string,
    noun: string,
    now: (() => Date) | undefined,
    listener: BuiltInReasoningProgressListener | undefined,
  ) {
    this.statusPath = statusPath;
    this.modelId = modelId;
    this.noun = noun;
    this.now = now ?? (() => new Date());
    this.listener = listener;
    this.lastWriteMs = 0;
    this.status = {
      state: 'not_started',
      modelId,
      percent: 0,
      label: '',
      bytesDone: 0,
      bytesTotal: 0,
      updatedAt: this.now().toISOString(),
    };
  }

  begin(bytesTotal: number): void {
    this.status = { ...this.status, bytesTotal, bytesDone: 0 };
    this.set('downloading', `Downloading the ${this.noun}`, 0);
  }

  advance(bytes: number, label: string): void {
    const bytesDone = Math.max(0, this.status.bytesDone + bytes);
    const percent = this.status.bytesTotal > 0
      ? Math.min(99, Math.floor((bytesDone / this.status.bytesTotal) * 100))
      : 0;
    this.status = { ...this.status, bytesDone, percent, label, state: 'downloading' };
    this.emit(false);
  }

  /** The checksum pass: real bytes read over the file's size. */
  verifying(label: string, bytesDone: number, bytesTotal: number): void {
    const percent = bytesTotal > 0 ? Math.min(99, Math.floor((bytesDone / bytesTotal) * 100)) : 0;
    const { failure: _failure, ...rest } = this.status;
    const first = this.status.state !== 'verifying' || bytesDone === 0;
    this.status = { ...rest, state: 'verifying', label, percent, bytesDone, bytesTotal };
    this.emit(first || bytesDone >= bytesTotal);
  }

  set(state: BuiltInReasoningState, label: string, percent = this.status.percent): void {
    const { failure: _failure, ...rest } = this.status;
    this.status = { ...rest, state, label, percent };
    this.emit(true);
  }

  fail(reason: BuiltInReasoningFailureReason, message: string, shortfall?: BuiltInReasoningSpaceShortfall): void {
    this.status = {
      ...this.status,
      state: 'failed',
      label: reason === 'insufficient_space'
        ? `Waiting for free disk space to download the ${this.noun}`
        : `The ${this.noun} could not be installed`,
      failure: { reason, message, ...(shortfall ?? {}) },
    };
    this.emit(true);
  }

  private emit(force: boolean): void {
    const nowMs = this.now().getTime();
    this.status = { ...this.status, modelId: this.modelId, updatedAt: new Date(nowMs).toISOString() };
    this.listener?.(this.status);
    if (!force && nowMs - this.lastWriteMs < PROGRESS_WRITE_INTERVAL_MS) return;
    this.lastWriteMs = nowMs;
    try {
      mkdirSync(dirname(this.statusPath), { recursive: true, mode: 0o700 });
      const temporary = `${this.statusPath}.${process.pid}.tmp`;
      writeFileSync(temporary, `${JSON.stringify(this.status)}\n`, { mode: 0o600 });
      renameSync(temporary, this.statusPath);
    } catch {
      // Progress is advisory; a status write never fails the install.
    }
  }
}
