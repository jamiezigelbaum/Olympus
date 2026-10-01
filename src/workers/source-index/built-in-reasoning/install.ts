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
  type PinnedRuntimeArchive,
} from './manifest.ts';

export type BuiltInReasoningState = 'not_started' | 'downloading' | 'verifying' | 'loading' | 'ready' | 'failed';

export type BuiltInReasoningFailureReason =
  | 'unsupported_platform'
  | 'insufficient_memory'
  | 'download_failed'
  | 'checksum_mismatch'
  | 'disk_write_failed'
  | 'runtime_load_failed';

export interface BuiltInReasoningStatus {
  state: BuiltInReasoningState;
  modelId: string;
  /** 0-100, whole numbers. */
  percent: number;
  label: string;
  bytesDone: number;
  bytesTotal: number;
  updatedAt: string;
  failure?: { reason: BuiltInReasoningFailureReason; message: string };
}

export type BuiltInReasoningProgressListener = (status: BuiltInReasoningStatus) => void;

export interface BuiltInReasoningPaths {
  root: string;
  modelDir: string;
  runtimeDir: string;
  statusPath: string;
  lockPath: string;
}

export interface InstalledBuiltInReasoning {
  modelPath: string;
  serverPath: string;
  gpu: boolean;
}

export interface BuiltInReasoningInstallerOptions {
  model: BuiltInReasoningModelSpec;
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
}

export const BUILT_IN_REASONING_DIR_ENV = 'OLYMPUS_BUILT_IN_REASONING_DIR';
const STALE_LOCK_MS = 60 * 60_000;
const LOCK_POLL_MS = 1_000;
const PROGRESS_WRITE_INTERVAL_MS = 500;
const RUNTIME_MARKER = 'olympus-runtime.json';
const SERVER_BINARY = 'llama-server';

export class BuiltInReasoningInstallError extends Error {
  readonly reason: BuiltInReasoningFailureReason;

  constructor(reason: BuiltInReasoningFailureReason, message: string) {
    super(message);
    this.name = 'BuiltInReasoningInstallError';
    this.reason = reason;
  }
}

/** `<XDG_DATA_HOME or ~/.local/share>/openclaw/olympus/models/built-in-reasoning`. */
export function builtInReasoningPaths(
  model: Pick<BuiltInReasoningModelSpec, 'modelId'>,
  env: Record<string, string | undefined> = process.env,
  runtime: LlamaServerRuntimeSpec = LLAMA_SERVER_RUNTIME,
  platform = currentPlatform(),
): BuiltInReasoningPaths {
  const configured = env[BUILT_IN_REASONING_DIR_ENV]?.trim();
  const dataRoot = env.XDG_DATA_HOME?.trim() || join(env.HOME?.trim() || homedir(), '.local', 'share');
  const root = configured || join(dataRoot, 'openclaw', 'olympus', 'models', 'built-in-reasoning');
  if (!isAbsolute(root)) throw new TypeError('The built-in reasoning directory must be an absolute path.');
  return {
    root,
    modelDir: join(root, model.modelId),
    runtimeDir: join(root, `llama.cpp-${runtime.release}-${platform}`),
    statusPath: join(root, 'status.json'),
    lockPath: join(root, 'install.lock'),
  };
}

export function currentPlatform(): string {
  return `${process.platform}-${process.arch}`;
}

/** The last status any process wrote for `model`, or `not_started`. Never throws. */
export function readBuiltInReasoningStatus(
  model: Pick<BuiltInReasoningModelSpec, 'modelId'>,
  env: Record<string, string | undefined> = process.env,
): BuiltInReasoningStatus {
  const fallback: BuiltInReasoningStatus = {
    state: 'not_started',
    modelId: model.modelId,
    percent: 0,
    label: 'Built-in private model not downloaded yet',
    bytesDone: 0,
    bytesTotal: 0,
    updatedAt: new Date(0).toISOString(),
  };
  try {
    const parsed = JSON.parse(readFileSync(builtInReasoningPaths(model, env).statusPath, 'utf8')) as BuiltInReasoningStatus;
    return parsed && typeof parsed === 'object' && parsed.modelId === model.modelId ? parsed : fallback;
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
  const model = options.model;
  const runtime = options.runtime ?? LLAMA_SERVER_RUNTIME;
  const platform = options.platform ?? currentPlatform();
  const paths = builtInReasoningPaths(model, options.env, runtime, platform);
  const reporter = new ProgressReporter(paths.statusPath, model.modelId, options.now, options.onProgress);
  const modelPath = join(paths.modelDir, model.file.name);

  try {
    const archive = runtimeArchiveFor(platform, runtime);
    if (!archive) {
      throw new BuiltInReasoningInstallError(
        'unsupported_platform',
        `The built-in private model does not run on ${platform}.`,
      );
    }
    ensureDirectory(paths.root);
    const installed = (): InstalledBuiltInReasoning => ({
      modelPath,
      serverPath: findServerBinary(paths.runtimeDir),
      gpu: archive.gpu,
    });

    if (existsSync(modelPath) && runtimeInstalled(paths.runtimeDir, archive)) {
      await verifyModelFile(modelPath, model, reporter);
      return installed();
    }

    await withInstallLock(paths.lockPath, options.lockWaitMs ?? STALE_LOCK_MS, async () => {
      if (existsSync(modelPath) && runtimeInstalled(paths.runtimeDir, archive)) return;
      const fetchImpl = options.fetchImpl ?? fetch;
      const needModel = !existsSync(modelPath);
      const needRuntime = !runtimeInstalled(paths.runtimeDir, archive);
      reporter.begin((needModel ? model.file.bytes : 0) + (needRuntime ? archive.bytes : 0));
      if (needRuntime) {
        await installRuntime(fetchImpl, paths.runtimeDir, archive, reporter, options.extractArchive ?? extractWithTar);
      }
      if (needModel) {
        ensureDirectory(paths.modelDir);
        await downloadVerified(fetchImpl, model.file.url, modelPath, model.file.bytes, model.file.sha256, reporter,
          `Downloading the built-in private model (${model.displayName})`);
      }
    });
    await verifyModelFile(modelPath, model, reporter);
    if (!runtimeInstalled(paths.runtimeDir, archive)) {
      throw new BuiltInReasoningInstallError('runtime_load_failed', 'The built-in model server did not install completely.');
    }
    return installed();
  } catch (error) {
    const failure = error instanceof BuiltInReasoningInstallError
      ? error
      : new BuiltInReasoningInstallError('disk_write_failed', error instanceof Error ? error.message : String(error));
    reporter.fail(failure.reason, failure.message);
    throw failure;
  }
}

/** Marks the lane loading, ready or failed once the server is (being) started. */
export function reportBuiltInReasoningState(
  options: Pick<BuiltInReasoningInstallerOptions, 'env' | 'model' | 'now' | 'onProgress'>,
  state: 'loading' | 'ready' | 'failed',
  failure?: { reason: BuiltInReasoningFailureReason; message: string },
): void {
  const paths = builtInReasoningPaths(options.model, options.env);
  const reporter = new ProgressReporter(paths.statusPath, options.model.modelId, options.now, options.onProgress);
  if (state === 'failed' && failure) reporter.fail(failure.reason, failure.message);
  else reporter.set(state, state === 'ready' ? 'Built-in private model ready' : 'Starting the built-in private model', 100);
}

function findServerBinary(runtimeDir: string): string {
  const marker = readRuntimeMarker(runtimeDir);
  if (marker?.serverPath) return join(runtimeDir, marker.serverPath);
  throw new BuiltInReasoningInstallError('runtime_load_failed', 'The built-in model server is not installed.');
}

// Lazily created: a module-level initializer would keep this module alive in
// every bundle that merely imports a type from it.
let verifiedThisProcess: Set<string> | undefined;

async function verifyModelFile(
  path: string,
  model: BuiltInReasoningModelSpec,
  reporter: ProgressReporter,
): Promise<void> {
  const key = `${path}:${model.file.sha256}`;
  verifiedThisProcess ??= new Set<string>();
  if (verifiedThisProcess.has(key)) return;
  reporter.set('verifying', 'Checking the built-in private model', 99);
  const size = statSync(path).size;
  const digest = size === model.file.bytes ? await sha256File(path) : undefined;
  if (digest !== model.file.sha256) {
    rmSync(path, { force: true });
    throw new BuiltInReasoningInstallError(
      'checksum_mismatch',
      `${model.file.name} did not match its pinned checksum and was removed; it will download again.`,
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
): Promise<void> {
  const staging = `${runtimeDir}.staging-${randomUUID()}`;
  ensureDirectory(staging);
  try {
    const archivePath = join(staging, archive.name);
    await downloadVerified(fetchImpl, archive.url, archivePath, archive.bytes, archive.sha256, reporter,
      'Downloading the built-in model server');
    reporter.set('verifying', 'Unpacking the built-in model server');
    try {
      extract(archivePath, staging);
    } catch (error) {
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
  const result = spawnSync('tar', ['-xzf', archivePath, '-C', targetDir], { stdio: ['ignore', 'ignore', 'pipe'] });
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
): Promise<void> {
  // One writer holds the install lock, so a fixed partial name is safe and lets
  // a multi-gigabyte download resume after a restart instead of starting over.
  const partial = `${target}.partial`;
  const hash = createHash('sha256');
  let received = 0;
  if (existsSync(partial)) {
    const size = statSync(partial).size;
    if (size > 0 && size < expectedBytes) {
      await hashInto(partial, hash);
      received = size;
      reporter.advance(size, label);
    } else {
      rmSync(partial, { force: true });
    }
  }
  let response: Response;
  try {
    response = await fetchImpl(url, {
      redirect: 'follow',
      ...(received > 0 ? { headers: { Range: `bytes=${received}-` } } : {}),
    });
  } catch (error) {
    throw new BuiltInReasoningInstallError(
      'download_failed',
      `Could not reach the download server for the built-in private model (${error instanceof Error ? error.message : String(error)}).`,
    );
  }
  if (received > 0 && response.status !== 206) {
    // The server ignored the range: start over from byte zero.
    rmSync(partial, { force: true });
    await response.body?.cancel().catch(() => undefined);
    reporter.advance(-received, label);
    return downloadVerified(fetchImpl, url, target, expectedBytes, expectedSha256, reporter, label);
  }
  if (!response.ok || !response.body) {
    await response.body?.cancel().catch(() => undefined);
    throw new BuiltInReasoningInstallError(
      'download_failed',
      `The built-in private model download failed (HTTP ${response.status}).`,
    );
  }
  reporter.set('downloading', label);
  let fd: number;
  try {
    fd = openSync(partial, received > 0 ? 'a' : 'w', 0o644);
  } catch (error) {
    throw new BuiltInReasoningInstallError('disk_write_failed', `Could not write ${partial}: ${String(error)}`);
  }
  try {
    const reader = response.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
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
        writeSync(fd, value);
      } catch (error) {
        throw new BuiltInReasoningInstallError('disk_write_failed', `Could not write the download: ${String(error)}`);
      }
      reporter.advance(value.byteLength, label);
    }
  } catch (error) {
    try {
      closeSync(fd);
    } catch {
      // already closed
    }
    if (error instanceof BuiltInReasoningInstallError) throw error;
    // Keep the partial file: the next attempt resumes from it.
    throw new BuiltInReasoningInstallError(
      'download_failed',
      `The built-in private model download was interrupted (${error instanceof Error ? error.message : String(error)}).`,
    );
  }
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

function hashInto(path: string, hash: ReturnType<typeof createHash>): Promise<void> {
  return new Promise((resolve, reject) => {
    createReadStream(path)
      .on('data', (chunk) => hash.update(chunk))
      .on('error', reject)
      .on('end', () => resolve());
  });
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash('sha256');
  await hashInto(path, hash);
  return hash.digest('hex');
}

// ---------------------------------------------------------------------------
// Cross-process install lock

async function withInstallLock(lockPath: string, waitMs: number, run: () => Promise<void>): Promise<void> {
  const deadline = Date.now() + waitMs;
  for (;;) {
    if (tryAcquireLock(lockPath)) break;
    if (Date.now() > deadline) {
      throw new BuiltInReasoningInstallError('download_failed', 'Another Olympus process is still installing the built-in private model.');
    }
    await new Promise((resolve) => setTimeout(resolve, LOCK_POLL_MS));
  }
  try {
    await run();
  } finally {
    rmSync(lockPath, { force: true });
  }
}

function tryAcquireLock(lockPath: string): boolean {
  try {
    const fd = openSync(lockPath, 'wx', 0o600);
    writeSync(fd, JSON.stringify({ pid: process.pid, at: Date.now() }));
    closeSync(fd);
    return true;
  } catch {
    if (lockIsStale(lockPath)) {
      rmSync(lockPath, { force: true });
      return tryAcquireLock(lockPath);
    }
    return false;
  }
}

function lockIsStale(lockPath: string): boolean {
  try {
    const holder = JSON.parse(readFileSync(lockPath, 'utf8')) as { pid?: number; at?: number };
    if (typeof holder.at === 'number' && Date.now() - holder.at > STALE_LOCK_MS) return true;
    if (typeof holder.pid === 'number' && holder.pid !== process.pid) {
      try {
        process.kill(holder.pid, 0);
        return false;
      } catch (error) {
        return (error as NodeJS.ErrnoException).code === 'ESRCH';
      }
    }
    return false;
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
  private readonly now: () => Date;
  private readonly listener: BuiltInReasoningProgressListener | undefined;
  private status: BuiltInReasoningStatus;
  private lastWriteMs: number;

  constructor(
    statusPath: string,
    modelId: string,
    now: (() => Date) | undefined,
    listener: BuiltInReasoningProgressListener | undefined,
  ) {
    this.statusPath = statusPath;
    this.modelId = modelId;
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
    this.set('downloading', 'Downloading the built-in private model', 0);
  }

  advance(bytes: number, label: string): void {
    const bytesDone = Math.max(0, this.status.bytesDone + bytes);
    const percent = this.status.bytesTotal > 0
      ? Math.min(99, Math.floor((bytesDone / this.status.bytesTotal) * 100))
      : 0;
    this.status = { ...this.status, bytesDone, percent, label, state: 'downloading' };
    this.emit(false);
  }

  set(state: BuiltInReasoningState, label: string, percent = this.status.percent): void {
    const { failure: _failure, ...rest } = this.status;
    this.status = { ...rest, state, label, percent };
    this.emit(true);
  }

  fail(reason: BuiltInReasoningFailureReason, message: string): void {
    this.status = {
      ...this.status,
      state: 'failed',
      label: 'The built-in private model could not be installed',
      failure: { reason, message },
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
