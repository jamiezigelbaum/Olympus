// Fetches, verifies and installs the built-in embedding model and its runtime
// into the Olympus data directory, once. Every file is checked against the
// pinned manifest before it is used; a file that does not match is deleted,
// never loaded. Progress is written to a small status file so another process
// (the dashboard engine) can show "installing" with a percent and a label.

import { createHash, randomUUID } from 'node:crypto';
import {
  closeSync,
  createReadStream,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import {
  BUILT_IN_EMBEDDING_MODEL,
  ONNX_RUNTIME_PACK,
  type BuiltInEmbeddingModelSpec,
  type OnnxRuntimePackSpec,
  type PinnedDownload,
  type PinnedNpmPackage,
} from './manifest.ts';
import { readTarGz } from './tar.ts';

export type BuiltInEmbeddingState = 'not_started' | 'downloading' | 'verifying' | 'loading' | 'ready' | 'failed';

export type BuiltInEmbeddingFailureReason =
  | 'unsupported_platform'
  | 'download_failed'
  | 'checksum_mismatch'
  | 'disk_write_failed'
  | 'runtime_load_failed';

export interface BuiltInEmbeddingStatus {
  state: BuiltInEmbeddingState;
  modelId: string;
  /** 0-100, whole numbers. */
  percent: number;
  label: string;
  bytesDone: number;
  bytesTotal: number;
  updatedAt: string;
  failure?: { reason: BuiltInEmbeddingFailureReason; message: string };
}

export type BuiltInEmbeddingProgressListener = (status: BuiltInEmbeddingStatus) => void;

export interface BuiltInEmbeddingPaths {
  root: string;
  modelDir: string;
  runtimeDir: string;
  statusPath: string;
  lockPath: string;
}

export interface InstalledBuiltInEmbedding {
  modelPath: string;
  vocabularyPath: string;
  /** Directory whose `node_modules` holds onnxruntime-node and onnxruntime-common. */
  runtimeDir: string;
}

export interface BuiltInEmbeddingInstallerOptions {
  env?: Record<string, string | undefined>;
  model?: BuiltInEmbeddingModelSpec;
  runtime?: OnnxRuntimePackSpec;
  /** `${platform}-${arch}`; defaults to this process. */
  platform?: string;
  fetchImpl?: typeof fetch;
  onProgress?: BuiltInEmbeddingProgressListener;
  now?: () => Date;
  /** How long to wait for another process that holds the install lock. */
  lockWaitMs?: number;
  /** Skip the runtime pack (tests that inject a runtime). */
  skipRuntime?: boolean;
  /** Longest a download may go without receiving a byte before it is abandoned. */
  downloadStallMs?: number;
}

export const BUILT_IN_EMBEDDING_DIR_ENV = 'OLYMPUS_BUILT_IN_EMBEDDING_DIR';
const STALE_LOCK_MS = 30 * 60_000;
const LOCK_POLL_MS = 1_000;
const PROGRESS_WRITE_INTERVAL_MS = 500;
/** No byte for this long and a download is abandoned (the next attempt starts it again). */
const DOWNLOAD_STALL_MS = 2 * 60_000;

export class BuiltInEmbeddingInstallError extends Error {
  readonly reason: BuiltInEmbeddingFailureReason;

  constructor(reason: BuiltInEmbeddingFailureReason, message: string) {
    super(message);
    this.name = 'BuiltInEmbeddingInstallError';
    this.reason = reason;
  }
}

/** `<XDG_DATA_HOME or ~/.local/share>/openclaw/olympus/models/built-in-embedding`. */
export function builtInEmbeddingPaths(
  env: Record<string, string | undefined> = process.env,
  model: BuiltInEmbeddingModelSpec = BUILT_IN_EMBEDDING_MODEL,
  runtime: OnnxRuntimePackSpec = ONNX_RUNTIME_PACK,
  platform = currentPlatform(),
): BuiltInEmbeddingPaths {
  const configured = env[BUILT_IN_EMBEDDING_DIR_ENV]?.trim();
  const dataRoot = env.XDG_DATA_HOME?.trim() || join(env.HOME?.trim() || homedir(), '.local', 'share');
  const root = configured || join(dataRoot, 'openclaw', 'olympus', 'models', 'built-in-embedding');
  if (!isAbsolute(root)) throw new TypeError('The built-in embedding directory must be an absolute path.');
  return {
    root,
    modelDir: join(root, model.modelId),
    runtimeDir: join(root, `onnxruntime-${runtime.version}-${platform}`),
    statusPath: join(root, 'status.json'),
    lockPath: join(root, 'install.lock'),
  };
}

export function currentPlatform(): string {
  return `${process.platform}-${process.arch}`;
}

/** The last status any process wrote, or `not_started`. Never throws. */
export function readBuiltInEmbeddingStatus(
  env: Record<string, string | undefined> = process.env,
  model: BuiltInEmbeddingModelSpec = BUILT_IN_EMBEDDING_MODEL,
): BuiltInEmbeddingStatus {
  const fallback: BuiltInEmbeddingStatus = {
    state: 'not_started',
    modelId: model.modelId,
    percent: 0,
    label: 'Built-in search model not downloaded yet',
    bytesDone: 0,
    bytesTotal: 0,
    updatedAt: new Date(0).toISOString(),
  };
  try {
    const parsed = JSON.parse(readFileSync(builtInEmbeddingPaths(env, model).statusPath, 'utf8')) as BuiltInEmbeddingStatus;
    return parsed && typeof parsed === 'object' && parsed.modelId === model.modelId ? parsed : fallback;
  } catch {
    return fallback;
  }
}

/**
 * Ensures the model and runtime are on disk and verified, downloading what is
 * missing. Safe to call from several processes: one installs, the others wait.
 */
export async function installBuiltInEmbedding(
  options: BuiltInEmbeddingInstallerOptions = {},
): Promise<InstalledBuiltInEmbedding> {
  const model = options.model ?? BUILT_IN_EMBEDDING_MODEL;
  const runtime = options.runtime ?? ONNX_RUNTIME_PACK;
  const platform = options.platform ?? currentPlatform();
  const paths = builtInEmbeddingPaths(options.env, model, runtime, platform);
  const reporter = new ProgressReporter(paths.statusPath, model.modelId, options.now, options.onProgress);
  const installed: InstalledBuiltInEmbedding = {
    modelPath: join(paths.modelDir, model.model.name),
    vocabularyPath: join(paths.modelDir, model.vocabulary.name),
    runtimeDir: paths.runtimeDir,
  };

  try {
    if (!options.skipRuntime && !runtime.platforms.includes(platform)) {
      throw new BuiltInEmbeddingInstallError(
        'unsupported_platform',
        `The built-in search model does not run on ${platform}.`,
      );
    }
    ensureDirectory(paths.root);

    const modelFiles = [model.model, model.vocabulary];
    const runtimePackages = options.skipRuntime ? [] : [runtime.common, runtime.runtime];
    if (installComplete(paths, modelFiles, runtimePackages)) {
      await verifyModelFiles(paths.modelDir, modelFiles, reporter);
      return installed;
    }

    await withInstallLock(paths.lockPath, options.lockWaitMs ?? STALE_LOCK_MS, async () => {
      // Another process may have finished while this one waited.
      if (installComplete(paths, modelFiles, runtimePackages)) return;
      const fetchImpl = options.fetchImpl ?? fetch;
      const stallMs = options.downloadStallMs ?? DOWNLOAD_STALL_MS;
      const pending = [
        ...modelFiles.filter((file) => !existsSync(join(paths.modelDir, file.name))),
      ];
      const pendingPackages = runtimePackages.length > 0 && !runtimeInstalled(paths.runtimeDir, runtimePackages)
        ? runtimePackages
        : [];
      const bytesTotal = pending.reduce((sum, file) => sum + file.bytes, 0)
        + pendingPackages.reduce((sum, pack) => sum + pack.bytes, 0);
      reporter.begin(bytesTotal);

      ensureDirectory(paths.modelDir);
      for (const file of pending) {
        await downloadVerified(fetchImpl, file.url, join(paths.modelDir, file.name), file.bytes, {
          kind: 'sha256',
          expected: file.sha256,
        }, reporter, labelFor(file), stallMs);
      }
      if (pendingPackages.length > 0) {
        await installRuntime(fetchImpl, paths.runtimeDir, pendingPackages, platform, reporter, stallMs);
      }
    });
    await verifyModelFiles(paths.modelDir, modelFiles, reporter);
    if (runtimePackages.length > 0 && !runtimeInstalled(paths.runtimeDir, runtimePackages)) {
      throw new BuiltInEmbeddingInstallError('runtime_load_failed', 'The built-in search runtime did not install completely.');
    }
    return installed;
  } catch (error) {
    const failure = error instanceof BuiltInEmbeddingInstallError
      ? error
      : new BuiltInEmbeddingInstallError('disk_write_failed', error instanceof Error ? error.message : String(error));
    reporter.fail(failure.reason, failure.message);
    throw failure;
  }
}

/** Marks the lane loading or ready once the session is (being) created. */
export function reportBuiltInEmbeddingState(
  options: Pick<BuiltInEmbeddingInstallerOptions, 'env' | 'model' | 'now' | 'onProgress'>,
  state: 'loading' | 'ready' | 'failed',
  failure?: { reason: BuiltInEmbeddingFailureReason; message: string },
): void {
  const model = options.model ?? BUILT_IN_EMBEDDING_MODEL;
  const paths = builtInEmbeddingPaths(options.env, model);
  const reporter = new ProgressReporter(paths.statusPath, model.modelId, options.now, options.onProgress);
  if (state === 'failed' && failure) reporter.fail(failure.reason, failure.message);
  else reporter.set(state, state === 'ready' ? 'Built-in search model ready' : 'Starting the built-in search model', 100);
}

function labelFor(file: PinnedDownload): string {
  return file.name.endsWith('.onnx') ? 'Downloading the built-in search model' : 'Downloading the model vocabulary';
}

function installComplete(
  paths: BuiltInEmbeddingPaths,
  modelFiles: readonly PinnedDownload[],
  runtimePackages: readonly PinnedNpmPackage[],
): boolean {
  return modelFiles.every((file) => existsSync(join(paths.modelDir, file.name)))
    && (runtimePackages.length === 0 || runtimeInstalled(paths.runtimeDir, runtimePackages));
}

// Lazily created: a module-level initializer would keep this module alive in
// every bundle that merely imports a type from it.
let verifiedThisProcess: Set<string> | undefined;

async function verifyModelFiles(
  dir: string,
  files: readonly PinnedDownload[],
  reporter: ProgressReporter,
): Promise<void> {
  for (const file of files) {
    const path = join(dir, file.name);
    const key = `${path}:${file.sha256}`;
    verifiedThisProcess ??= new Set<string>();
    if (verifiedThisProcess.has(key)) continue;
    const size = statSync(path).size;
    const digest = size === file.bytes ? await sha256File(path) : undefined;
    if (digest !== file.sha256) {
      rmSync(path, { force: true });
      throw new BuiltInEmbeddingInstallError(
        'checksum_mismatch',
        `${file.name} did not match its pinned checksum and was removed; it will download again.`,
      );
    }
    verifiedThisProcess.add(key);
  }
  reporter.touch();
}

// ---------------------------------------------------------------------------
// Runtime pack

const RUNTIME_MARKER = 'olympus-runtime.json';

interface RuntimeMarker {
  packages: Array<{ name: string; integrity: string }>;
}

function runtimeInstalled(runtimeDir: string, packages: readonly PinnedNpmPackage[]): boolean {
  try {
    const marker = JSON.parse(readFileSync(join(runtimeDir, RUNTIME_MARKER), 'utf8')) as RuntimeMarker;
    return packages.every((pack) => marker.packages.some(
      (entry) => entry.name === pack.name && entry.integrity === pack.integrity,
    ));
  } catch {
    return false;
  }
}

async function installRuntime(
  fetchImpl: typeof fetch,
  runtimeDir: string,
  packages: readonly PinnedNpmPackage[],
  platform: string,
  reporter: ProgressReporter,
  stallMs: number,
): Promise<void> {
  const staging = `${runtimeDir}.staging-${randomUUID()}`;
  ensureDirectory(staging);
  try {
    for (const pack of packages) {
      const archivePath = join(staging, `${pack.name}.tgz`);
      await downloadVerified(fetchImpl, pack.url, archivePath, pack.bytes, {
        kind: 'integrity',
        expected: pack.integrity,
      }, reporter, 'Downloading the search runtime', stallMs);
      reporter.set('verifying', 'Unpacking the search runtime');
      const archive = readFileSync(archivePath);
      const files = readTarGz(archive, (path) => runtimeEntryWanted(pack.name, path, platform));
      if (files.length === 0) {
        throw new BuiltInEmbeddingInstallError('runtime_load_failed', `${pack.name} had no files for ${platform}.`);
      }
      for (const file of files) {
        const target = join(staging, 'node_modules', pack.name, file.path.replace(/^package\//, ''));
        ensureDirectory(dirname(target));
        writeFileSync(target, file.data, { mode: file.mode & 0o755 || 0o644 });
      }
      rmSync(archivePath, { force: true });
    }
    const marker: RuntimeMarker = {
      packages: packages.map((pack) => ({ name: pack.name, integrity: pack.integrity })),
    };
    writeFileSync(join(staging, RUNTIME_MARKER), `${JSON.stringify(marker, null, 2)}\n`);
    rmSync(runtimeDir, { recursive: true, force: true });
    renameSync(staging, runtimeDir);
  } catch (error) {
    rmSync(staging, { recursive: true, force: true });
    throw error;
  }
}

function runtimeEntryWanted(packageName: string, path: string, platform: string): boolean {
  if (!path.startsWith('package/')) return false;
  if (packageName !== 'onnxruntime-node') return true;
  const [os, arch] = platform.split('-');
  // macOS ships the library twice; the binding links `libonnxruntime.1.dylib`
  // (@rpath), so the fully versioned copy is 43 MB of dead weight.
  if (/\/libonnxruntime\.\d+\.\d+\.\d+\.dylib$/.test(path)) return false;
  return path === 'package/package.json'
    || path.startsWith('package/dist/')
    || path.startsWith(`package/bin/napi-v6/${os}/${arch}/`)
    || path === 'package/LICENSE'
    || path === 'package/ThirdPartyNotices.txt';
}

// ---------------------------------------------------------------------------
// Downloads

type Expected = { kind: 'sha256'; expected: string } | { kind: 'integrity'; expected: string };

async function downloadVerified(
  fetchImpl: typeof fetch,
  url: string,
  target: string,
  expectedBytes: number,
  expected: Expected,
  reporter: ProgressReporter,
  label: string,
  stallMs: number,
): Promise<void> {
  const partial = `${target}.partial-${process.pid}-${randomUUID()}`;
  const algorithm = expected.kind === 'sha256' ? 'sha256' : integrityAlgorithm(expected.expected);
  const hash = createHash(algorithm);
  let received = 0;
  let response: Response;
  // One controller covers the request and every read: a wait longer than
  // `stallMs` for the next byte abandons the download instead of leaving the
  // status on "downloading" forever with nothing moving.
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
    response = await fetchImpl(url, { redirect: 'follow', signal: controller.signal });
  } catch (error) {
    disarmStall();
    throw new BuiltInEmbeddingInstallError(
      'download_failed',
      `Could not reach the download server for the built-in search model (${error instanceof Error ? error.message : String(error)}).`,
    );
  }
  if (!response.ok || !response.body) {
    disarmStall();
    await response.body?.cancel().catch(() => undefined);
    throw new BuiltInEmbeddingInstallError(
      'download_failed',
      `The built-in search model download failed (HTTP ${response.status}).`,
    );
  }
  reporter.set('downloading', label);
  let fd: number;
  try {
    fd = openSync(partial, 'w', 0o644);
  } catch (error) {
    disarmStall();
    await response.body.cancel().catch(() => undefined);
    throw new BuiltInEmbeddingInstallError('disk_write_failed', `Could not write ${partial}: ${String(error)}`);
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
        throw new BuiltInEmbeddingInstallError('checksum_mismatch', `${url} is larger than its pinned size.`);
      }
      hash.update(value);
      try {
        writeSync(fd, value);
      } catch (error) {
        throw new BuiltInEmbeddingInstallError('disk_write_failed', `Could not write the download: ${String(error)}`);
      }
      reporter.advance(value.byteLength, label);
    }
  } catch (error) {
    disarmStall();
    closeSync(fd);
    rmSync(partial, { force: true });
    if (error instanceof BuiltInEmbeddingInstallError) throw error;
    throw new BuiltInEmbeddingInstallError(
      'download_failed',
      `The built-in search model download was interrupted (${error instanceof Error ? error.message : String(error)}).`,
    );
  }
  disarmStall();
  closeSync(fd);
  const digest = expected.kind === 'sha256'
    ? hash.digest('hex')
    : `${algorithm}-${hash.digest('base64')}`;
  if (received !== expectedBytes || digest !== expected.expected) {
    rmSync(partial, { force: true });
    throw new BuiltInEmbeddingInstallError(
      'checksum_mismatch',
      `${url} did not match its pinned checksum; nothing was installed.`,
    );
  }
  renameSync(partial, target);
}

function integrityAlgorithm(integrity: string): string {
  const algorithm = integrity.split('-', 1)[0];
  if (algorithm !== 'sha512' && algorithm !== 'sha384' && algorithm !== 'sha256') {
    throw new BuiltInEmbeddingInstallError('checksum_mismatch', `Unsupported integrity algorithm ${algorithm}.`);
  }
  return algorithm;
}

/** Never waits forever: a pass that has not ended in `timeoutMs` (or closes early) fails. */
export function sha256File(path: string, timeoutMs = 10 * 60_000): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
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
        resolve(hash.digest('hex'));
      }
    };
    const timer = setTimeout(() => finish(new BuiltInEmbeddingInstallError(
      'checksum_mismatch',
      `Checking ${path} did not finish within ${Math.round(timeoutMs / 60_000)} min.`,
    )), timeoutMs);
    stream
      .on('data', (chunk) => hash.update(chunk))
      .on('error', (error) => finish(error))
      .on('end', () => finish())
      .on('close', () => finish(new Error(`Reading ${path} stopped before the end.`)));
  });
}

// ---------------------------------------------------------------------------
// Cross-process install lock

async function withInstallLock(lockPath: string, waitMs: number, run: () => Promise<void>): Promise<void> {
  const deadline = Date.now() + waitMs;
  for (;;) {
    if (tryAcquireLock(lockPath)) break;
    if (Date.now() > deadline) {
      throw new BuiltInEmbeddingInstallError('download_failed', 'Another Olympus process is still installing the built-in search model.');
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
    // Unreadable (a writer mid-write, or garbage): stale only once old.
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
    throw new BuiltInEmbeddingInstallError('disk_write_failed', `Could not create ${path}: ${String(error)}`);
  }
}

// ---------------------------------------------------------------------------
// Progress

class ProgressReporter {
  private readonly statusPath: string;
  private readonly modelId: string;
  private readonly now: () => Date;
  private readonly listener: BuiltInEmbeddingProgressListener | undefined;
  private status: BuiltInEmbeddingStatus;
  private lastWriteMs: number;

  constructor(
    statusPath: string,
    modelId: string,
    now: (() => Date) | undefined,
    listener: BuiltInEmbeddingProgressListener | undefined,
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
    this.set('downloading', 'Downloading the built-in search model', 0);
  }

  advance(bytes: number, label: string): void {
    const bytesDone = this.status.bytesDone + bytes;
    const percent = this.status.bytesTotal > 0
      ? Math.min(99, Math.floor((bytesDone / this.status.bytesTotal) * 100))
      : 0;
    this.status = { ...this.status, bytesDone, percent, label, state: 'downloading' };
    this.emit(false);
  }

  set(state: BuiltInEmbeddingState, label: string, percent = this.status.percent): void {
    const { failure: _failure, ...rest } = this.status;
    this.status = { ...rest, state, label, percent };
    this.emit(true);
  }

  touch(): void {
    if (this.status.state === 'downloading') this.set('verifying', 'Checking the built-in search model', 99);
  }

  fail(reason: BuiltInEmbeddingFailureReason, message: string): void {
    this.status = {
      ...this.status,
      state: 'failed',
      label: 'The built-in search model could not be installed',
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
