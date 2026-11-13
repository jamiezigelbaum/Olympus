// src/workers/source-index/built-in-reasoning/model-worker.ts
import { parentPort, workerData } from "node:worker_threads";

// src/workers/source-index/built-in-embedding/litert-runtime.ts
import { isMainThread } from "node:worker_threads";

// src/workers/source-index/built-in-reasoning/off-thread.ts
import { Worker } from "node:worker_threads";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
var shared;
var nextHandle = 1;
function modelThreadHandleId() {
  return nextHandle++;
}

class ModelThread {
  worker;
  nextId = 1;
  pending = new Map;
  pids = new Map;
  constructor(path = modelWorkerPath()) {
    const shutdown = new Int32Array(new SharedArrayBuffer(4));
    this.worker = new Worker(path, { workerData: { shutdown } });
    const onExit = () => {
      this.worker.postMessage({ shutdown: true });
      Atomics.wait(shutdown, 0, 0, 15000);
    };
    process.once("exit", onExit);
    this.worker.on("message", (reply) => {
      if (reply.handle !== undefined) {
        if (reply.pid === undefined)
          this.pids.delete(reply.handle);
        else
          this.pids.set(reply.handle, reply.pid);
      }
      const pending = this.pending.get(reply.id);
      if (!pending)
        return;
      if (reply.embeddingProgress) {
        pending.embeddingProgress?.(reply.embeddingProgress);
        return;
      }
      if (reply.progress) {
        pending.progress?.(reply.progress);
        return;
      }
      if (reply.log !== undefined) {
        pending.log?.(reply.log);
        return;
      }
      this.pending.delete(reply.id);
      pending.cleanup();
      if (this.pending.size === 0)
        this.worker.unref();
      if (reply.error) {
        const error = Object.assign(new Error(reply.error.message), reply.error);
        pending.reject(error);
      } else
        pending.resolve(reply.result);
    });
    const failed = (error) => {
      if (shared === this)
        shared = undefined;
      for (const pending of this.pending.values()) {
        pending.cleanup();
        pending.reject(error);
      }
      this.pending.clear();
      this.pids.clear();
    };
    this.worker.on("error", failed);
    this.worker.on("exit", () => {
      process.removeListener("exit", onExit);
      failed(new Error("The built-in model worker stopped."));
    });
    this.worker.unref();
  }
  call(request, options = {}) {
    if (options.signal?.aborted)
      return Promise.reject(cancelled());
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const abort = () => this.worker.postMessage({ cancel: id });
      const timer = setTimeout(() => {
        abort();
        this.pending.delete(id);
        cleanup();
        if (this.pending.size === 0)
          this.worker.unref();
        reject(new Error("The built-in model worker operation timed out."));
      }, options.timeoutMs ?? 2 * 60 * 60000);
      const cleanup = () => {
        clearTimeout(timer);
        options.signal?.removeEventListener("abort", abort);
      };
      options.signal?.addEventListener("abort", abort, { once: true });
      this.pending.set(id, { resolve: (result) => resolve(result), reject, cleanup, progress: options.progress, log: options.log, embeddingProgress: options.embeddingProgress });
      this.worker.ref();
      try {
        this.worker.postMessage({ id, request });
      } catch (error) {
        this.pending.delete(id);
        cleanup();
        if (this.pending.size === 0)
          this.worker.unref();
        reject(error);
      }
    });
  }
}
function cancelled() {
  return Object.assign(new Error("The request was cancelled."), { name: "AbortError" });
}
function modelWorkerPath() {
  const here = dirname(fileURLToPath(import.meta.url));
  for (const name of ["model-worker.js", "model-worker.ts"]) {
    const path = join(here, name);
    if (existsSync(path))
      return path;
  }
  throw new Error("The built-in model worker is not installed.");
}
function modelThread() {
  if (!shared) {
    shared = new ModelThread;
    const current = shared;
    process.once("beforeExit", () => {
      if (shared === current)
        current.call({ kind: "shutdown" }).catch(() => {});
    });
  }
  return shared;
}

// src/workers/source-index/built-in-embedding/litert-runtime.ts
import { spawn } from "node:child_process";
import { closeSync, constants, existsSync as existsSync2, fstatSync, openSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname as dirname2, isAbsolute, join as join2 } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath as fileURLToPath2 } from "node:url";

class LiteRtImagesUnavailableError extends Error {
  indexes;
  constructor(indexes) {
    super("The built-in search model is running without its image encoder.");
    this.name = "LiteRtImagesUnavailableError";
    this.indexes = indexes;
  }
}

class LiteRtPictureEngineFaultError extends Error {
  constructor(message) {
    super(message);
    this.name = "LiteRtPictureEngineFaultError";
  }
}
var REQUEST_TIMEOUT_MS = 3 * 60000;
function helperEnvironment() {
  const env = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (value === undefined)
      continue;
    if (["PATH", "HOME", "TMPDIR", "XDG_RUNTIME_DIR", "DISPLAY", "WAYLAND_DISPLAY"].includes(name) || name.startsWith("VK_")) {
      env[name] = value;
    }
  }
  env.HOME ??= homedir();
  return env;
}

class HelperProcess {
  child;
  device = "cpu";
  vision = false;
  nextId = 1;
  pending = new Map;
  stderr = "";
  requestTimeoutMs;
  stopTimeoutMs;
  exited = false;
  constructor(child, options) {
    this.child = child;
    this.requestTimeoutMs = options.requestTimeoutMs ?? REQUEST_TIMEOUT_MS;
    this.stopTimeoutMs = options.stopTimeoutMs ?? 5000;
  }
  failAll(reason) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(reason);
    }
    this.pending.clear();
  }
  static start(options, device) {
    const settings = {
      library: options.library,
      model: options.model,
      cacheDir: options.cacheDir,
      threads: options.threads,
      device,
      maxInputTokens: options.maxInputTokens,
      ...options.visionTokensPerImage !== undefined ? { visionTokensPerImage: options.visionTokensPerImage } : {}
    };
    const child = spawn(options.bunPath ?? resolveBun(), [options.helperPath ?? helperPath(), JSON.stringify(settings)], {
      stdio: ["pipe", "pipe", "pipe"],
      env: helperEnvironment()
    });
    const helper = new HelperProcess(child, options);
    child.stdin.on("error", (error) => {
      helper.exited = true;
      helper.failAll(new Error(`The built-in search model stopped: ${error.message}.`));
      child.kill("SIGKILL");
    });
    return new Promise((resolve, reject) => {
      let started = false;
      const timer = setTimeout(() => {
        if (started)
          return;
        child.kill("SIGKILL");
        reject(new Error("The built-in search model took too long to start."));
      }, options.startTimeoutMs ?? 5 * 60000);
      child.stderr.on("data", (chunk) => {
        helper.stderr = (helper.stderr + chunk.toString("utf8")).slice(-4000);
      });
      createInterface({ input: child.stdout }).on("line", (line) => {
        let message;
        try {
          message = JSON.parse(line);
        } catch {
          return;
        }
        if (!started) {
          if (message.ready) {
            started = true;
            clearTimeout(timer);
            helper.device = message.device === "gpu" ? "gpu" : "cpu";
            helper.vision = message.vision === true;
            resolve(helper);
          } else if (message.fatal) {
            started = true;
            clearTimeout(timer);
            reject(Object.assign(new Error(message.fatal), { fatal: true }));
          }
          return;
        }
        helper.settle(message);
      });
      child.on("error", (error) => {
        if (!started) {
          started = true;
          clearTimeout(timer);
          reject(error);
        }
      });
      child.on("exit", () => {
        helper.exited = true;
      });
      child.on("close", (code, signal) => {
        helper.exited = true;
        const reason = new Error(`The built-in search model stopped (${signal ?? `exit ${code}`})${helper.stderr ? `: ${helper.stderr.trim().split(`
`).at(-1)}` : ""}.`);
        if (!started) {
          started = true;
          clearTimeout(timer);
          reject(reason);
        }
        helper.failAll(reason);
      });
    });
  }
  embed(items) {
    if (this.exited)
      return Promise.reject(new Error("The built-in search model is not running."));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.child.kill("SIGKILL");
        this.exited = true;
        this.failAll(new Error("The built-in search model stopped responding and was restarted."));
      }, this.requestTimeoutMs);
      this.pending.set(id, { resolve, reject, count: items.length, timer });
      const request = items.every((item) => typeof item === "string") ? { id, texts: items } : { id, items: items.map((item) => typeof item === "string" ? { text: item } : item) };
      this.child.stdin.write(`${JSON.stringify(request)}
`);
    });
  }
  settle(message) {
    const pending = message.id === undefined ? undefined : this.pending.get(message.id);
    if (!pending || message.id === undefined)
      return;
    this.pending.delete(message.id);
    clearTimeout(pending.timer);
    if (!message.error && Array.isArray(message.unsupported) && message.unsupported.length > 0) {
      pending.reject(new LiteRtImagesUnavailableError(message.unsupported));
      return;
    }
    const failed = new Set(Array.isArray(message.failed) ? message.failed : []);
    if (!message.error && failed.size === pending.count) {
      pending.resolve(Array.from({ length: pending.count }, () => new Float32Array(0)));
      return;
    }
    if (message.error || !message.vectors || !message.dimension) {
      pending.reject(message.error && message.pictures ? new LiteRtPictureEngineFaultError(message.error) : new Error(message.error ?? "The built-in search model returned no vectors."));
      if (message.native) {
        this.exited = true;
        this.child.kill("SIGKILL");
      }
      return;
    }
    const bytes = Buffer.from(message.vectors, "base64");
    const all = new Float32Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
    const vectors = Array.from({ length: pending.count }, (_, index) => failed.has(index) ? new Float32Array(0) : all.subarray(index * message.dimension, (index + 1) * message.dimension));
    if (vectors.some((vector, index) => !failed.has(index) && vector.length !== message.dimension)) {
      pending.reject(new Error("The built-in search model returned the wrong number of values."));
      return;
    }
    pending.resolve(vectors);
  }
  async stop() {
    if (this.exited)
      return;
    const exited = new Promise((resolve) => this.child.once("close", () => resolve()));
    this.child.stdin.end();
    const timer = setTimeout(() => this.child.kill("SIGKILL"), this.stopTimeoutMs);
    await exited;
    clearTimeout(timer);
  }
}
async function startLiteRtEmbedder(options) {
  if (isMainThread && !options.gpuAvailable) {
    const handle = modelThreadHandleId();
    let state = await modelThread().call({ kind: "litert-start", handle, options });
    return {
      get device() {
        return state.device;
      },
      get vision() {
        return state.vision;
      },
      async embed(items) {
        try {
          const result = await modelThread().call({ kind: "litert-run", handle, items });
          state = result;
          return result.vectors;
        } catch (error) {
          const failure = error;
          if (failure.device !== undefined && failure.vision !== undefined)
            state = { device: failure.device, vision: failure.vision };
          if (failure.name === "LiteRtImagesUnavailableError")
            throw new LiteRtImagesUnavailableError(failure.indexes ?? []);
          if (failure.name === "LiteRtPictureEngineFaultError")
            throw new LiteRtPictureEngineFaultError(failure.message);
          throw error;
        }
      },
      async release() {
        await modelThread().call({ kind: "litert-release", handle });
      }
    };
  }
  let device = options.device === "auto" && process.platform === "linux" && !(options.gpuAvailable ?? linuxGpuAvailable)() ? "cpu" : options.device;
  let helper;
  try {
    helper = await HelperProcess.start(options, device);
  } catch (error) {
    if (device === "cpu" || error.fatal)
      throw error;
    device = "cpu";
    helper = await HelperProcess.start(options, device);
  }
  const releaseAtExit = () => {
    if (!helper.exited)
      helper.child.kill("SIGKILL");
  };
  process.once("exit", releaseAtExit);
  return {
    get device() {
      return helper.device;
    },
    get vision() {
      return helper.vision;
    },
    async embed(items) {
      if (helper.exited) {
        if (helper.device === "gpu")
          device = "cpu";
        helper = await HelperProcess.start(options, device);
      }
      const pictures = items.flatMap((item, index) => typeof item !== "string" && item.image ? [index] : []);
      if (pictures.length > 0 && !helper.vision)
        throw new LiteRtImagesUnavailableError(pictures);
      return helper.embed(items);
    },
    async release() {
      process.removeListener("exit", releaseAtExit);
      await helper.stop();
    }
  };
}
function linuxGpuAvailable(deviceDirectory = "/dev/dri") {
  try {
    return readdirSync(deviceDirectory).some((name) => {
      if (!/^renderD[0-9]+$/.test(name))
        return false;
      let fd;
      try {
        fd = openSync(join2(deviceDirectory, name), constants.O_RDWR | constants.O_NONBLOCK);
        return fstatSync(fd).isCharacterDevice();
      } catch {
        return false;
      } finally {
        if (fd !== undefined)
          closeSync(fd);
      }
    });
  } catch {
    return false;
  }
}
function helperPath() {
  const here = dirname2(fileURLToPath2(import.meta.url));
  for (const name of ["litert-helper.js", "litert-helper.ts"]) {
    const candidate = join2(here, name);
    if (existsSync2(candidate))
      return candidate;
  }
  throw new Error("The built-in search model helper is missing from this install.");
}
function resolveBun() {
  const bunName = process.platform === "win32" ? "bun.exe" : "bun";
  const candidates = [
    process.versions.bun ? process.execPath : undefined,
    process.env.BUN_INSTALL ? join2(process.env.BUN_INSTALL, "bin", bunName) : undefined,
    ...(process.env.PATH ?? "").split(delimiter).filter(Boolean).map((directory) => join2(directory, bunName)),
    join2(homedir(), ".bun", "bin", bunName)
  ];
  for (const candidate of candidates) {
    if (!candidate || !isAbsolute(candidate))
      continue;
    try {
      if (statSync(candidate).isFile())
        return candidate;
    } catch {}
  }
  throw new Error("The built-in search model needs Bun, and none was found.");
}

// src/workers/source-index/built-in-embedding/assets.ts
import { isMainThread as isMainThread3 } from "node:worker_threads";

// src/workers/source-index/pinned-download.ts
import { createHash } from "node:crypto";

// src/core/http-timeout.ts
function untilAborted(work, signal) {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      work.catch(() => {
        return;
      });
      reject(signal.reason);
      return;
    }
    const onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    work.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}
var NULL_BODY_STATUSES = new Set([101, 204, 205, 304]);
var DEFAULT_BOUNDED_RESPONSE_LIMIT_BYTES = 64 * 1024;

// src/workers/control-path-headroom.ts
import { isMainThread as isMainThread2 } from "node:worker_threads";

// src/core/olympus-layout.ts
import { homedir as homedir4 } from "node:os";
import { basename, dirname as dirname7, isAbsolute as isAbsolute5, join as join6, relative as relative3, resolve as resolve3, sep as sep3 } from "node:path";

// src/core/openclaw-plugin-remote.ts
import { readFileSync } from "node:fs";
import { homedir as homedir2 } from "node:os";
import { isAbsolute as isAbsolutePath, join as join3 } from "node:path";
function openClawConfigPath(homeDir, env) {
  const explicit = env.OPENCLAW_CONFIG_PATH?.trim();
  if (explicit && isAbsolutePath(explicit))
    return explicit;
  const stateDir = env.OPENCLAW_STATE_DIR?.trim();
  return join3(stateDir && isAbsolutePath(stateDir) ? stateDir : join3(homeDir, ".openclaw"), "openclaw.json");
}
function readOpenClawPluginRemote(env) {
  const path = openClawConfigPath(env.HOME?.trim() || homedir2(), env);
  let text;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT")
      return { hosted: false };
    return { hosted: true, path, unreadable: true };
  }
  const parsed = parseOpenClawConfigText(text);
  if (parsed === undefined)
    return { hosted: true, path, unreadable: true };
  const entries = asRecord(asRecord(asRecord(parsed)?.plugins)?.entries);
  const entry = entries && Object.hasOwn(entries, "olympus") ? asRecord(entries.olympus) : undefined;
  if (!entry || entry.enabled === false)
    return { hosted: false };
  return { hosted: true, path, remote: asRecord(asRecord(entry.config)?.remote) };
}
function parseOpenClawConfigText(text) {
  try {
    return JSON.parse(text);
  } catch {
    const json5 = globalThis.Bun?.JSON5;
    if (!json5)
      return;
    try {
      return json5.parse(text);
    } catch {
      return;
    }
  }
}
function asRecord(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : undefined;
}

// src/core/linux-desktop-entry.ts
import { dirname as dirname4, isAbsolute as isAbsolute3, join as join4 } from "node:path";

// src/core/atomic-file.ts
import { randomUUID } from "node:crypto";
import {
  closeSync as closeSync2,
  existsSync as existsSync3,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync as openSync2,
  renameSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { dirname as dirname3, isAbsolute as isAbsolute2, relative, resolve, sep } from "node:path";
function writePrivateFileAtomicSync(path, text, options = {}) {
  const temp = temporaryPathFor(path);
  try {
    const descriptor = openSync2(temp, "wx", 384);
    try {
      writeFileSync(descriptor, text, { encoding: "utf8" });
      fsyncSync(descriptor);
    } finally {
      closeSync2(descriptor);
    }
    renameSync(temp, path);
    options.onPublished?.();
  } catch (error) {
    try {
      rmSync(temp, { force: true });
    } catch {}
    throw error;
  }
  syncDirectorySync(dirname3(path));
}
function removeFileDurablySync(path) {
  try {
    rmSync(path);
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT")
      return false;
    throw error;
  }
  syncDirectorySync(dirname3(path));
  return true;
}
function ensurePrivateDirectoryTreeSync(root, target) {
  const normalizedRoot = resolveTrustedRoot(root);
  const normalizedTarget = resolveWithinRoot(normalizedRoot, target);
  assertDirectoryComponent(normalizedRoot);
  const suffix = relative(normalizedRoot, normalizedTarget);
  if (!suffix)
    return;
  let current = normalizedRoot;
  for (const component of suffix.split(sep)) {
    current = resolve(current, component);
    if (existsSync3(current)) {
      assertDirectoryComponent(current);
      continue;
    }
    mkdirSync(current, { mode: 448 });
    syncDirectorySync(dirname3(current));
    syncDirectorySync(current);
  }
}
function ensurePrivateRootDirectorySync(root) {
  const normalizedRoot = resolveTrustedRoot(root);
  if (existsSync3(normalizedRoot)) {
    assertDirectoryComponent(normalizedRoot, "managed custody root");
    return;
  }
  let ancestor = dirname3(normalizedRoot);
  while (!existsSync3(ancestor)) {
    const parent = dirname3(ancestor);
    if (parent === ancestor)
      break;
    ancestor = parent;
  }
  assertDirectoryComponent(ancestor, "managed custody root ancestor");
  ensurePrivateDirectoryTreeSync(ancestor, normalizedRoot);
}
function temporaryPathFor(path) {
  return `${path}.${randomUUID()}.tmp`;
}
function syncDirectorySync(path) {
  const descriptor = openSync2(path, "r");
  try {
    try {
      fsyncSync(descriptor);
    } catch (error) {
      if (!isUnsupportedDirectorySyncError(error))
        throw error;
    }
  } finally {
    closeSync2(descriptor);
  }
}
function resolveTrustedRoot(root) {
  if (!isAbsolute2(root) || /[\0\r\n]/.test(root)) {
    throw new Error(`Managed path root must be absolute: ${root}`);
  }
  return resolve(root);
}
function resolveWithinRoot(root, path) {
  if (!isAbsolute2(path) || /[\0\r\n]/.test(path)) {
    throw new Error(`Managed path must be absolute: ${path}`);
  }
  const normalized = resolve(path);
  const suffix = relative(root, normalized);
  if (suffix === ".." || suffix.startsWith(`..${sep}`) || isAbsolute2(suffix)) {
    throw new Error(`Managed path escapes its custody root: ${path}`);
  }
  return normalized;
}
function assertDirectoryComponent(path, label = "managed path") {
  let stats;
  try {
    stats = lstatSync(path);
  } catch {
    throw new Error(`Could not inspect ${label} directory component: ${path}`);
  }
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    throw new Error(`Refusing non-directory or symlink ${label} component: ${path}`);
  }
}
function isUnsupportedDirectorySyncError(error) {
  if (!error || typeof error !== "object" || !("code" in error))
    return false;
  return error.code === "EINVAL" || error.code === "EBADF" || error.code === "ENOTSUP";
}

// src/core/linux-desktop-entry.ts
var ID = "ai.olympusplugin.Olympus";
function linuxDesktopEntryPaths(layout) {
  return {
    desktop: join4(layout.dataHome, "applications", `${ID}.desktop`),
    icon: join4(layout.dataHome, "icons/hicolor/512x512/apps", `${ID}.png`)
  };
}

// src/core/linux-engine-layout.ts
import { lstatSync as lstatSync2, mkdirSync as mkdirSync3, readFileSync as readFileSync3, readdirSync as readdirSync2, realpathSync } from "node:fs";
import { homedir as homedir3 } from "node:os";
import { dirname as dirname6, isAbsolute as isAbsolute4, join as join5, relative as relative2, resolve as resolve2, sep as sep2 } from "node:path";

// src/core/file-lease.ts
import { execFileSync } from "node:child_process";
import { closeSync as closeSync3, existsSync as existsSync4, mkdirSync as mkdirSync2, openSync as openSync3, readFileSync as readFileSync2 } from "node:fs";
import { createRequire } from "node:module";
import { dirname as dirname5 } from "node:path";
var DEFAULT_OPTIONS = {
  acquireTimeoutMs: 1e4,
  pollIntervalMs: 25
};
var runtimeRequire = createRequire(import.meta.url);

class FileLeaseBusyError extends Error {
  code = "file_lease_busy";
  targetPath;
  retryable = true;
  retryAfterMs = 30000;
  constructor(targetPath) {
    super(`A writer already holds the lease for ${targetPath}.`);
    this.targetPath = targetPath;
  }
}

class FileLeaseLostError extends Error {
  code = "file_lease_lost";
  targetPath;
  constructor(targetPath) {
    super(`The writer lease for ${targetPath} is no longer owned by this process.`);
    this.targetPath = targetPath;
  }
}
function withFileLeaseSync(targetPath, callback, options = {}) {
  const owner = acquireFileLeaseSync(targetPath, normalizeOptions(options));
  try {
    return callback(owner);
  } finally {
    owner.release();
  }
}
class SyncFileLeaseOwner {
  targetPath;
  lockPath;
  lock;
  constructor(targetPath, lockPath, lock) {
    this.targetPath = targetPath;
    this.lockPath = lockPath;
    this.lock = lock;
  }
  assertOwned() {
    if (!this.lock)
      throw new FileLeaseLostError(this.targetPath);
  }
  commit(write) {
    this.assertOwned();
    return write();
  }
  release() {
    const lock = this.lock;
    this.lock = undefined;
    lock?.release();
  }
}
function acquireFileLeaseSync(targetPath, options) {
  const lockPath = lockPathFor(targetPath);
  const deadline = Date.now() + options.acquireTimeoutMs;
  mkdirSync2(dirname5(lockPath), { recursive: true, mode: 448 });
  while (true) {
    const lock = tryKernelLock(lockPath, options.mode);
    if (lock)
      return new SyncFileLeaseOwner(targetPath, lockPath, lock);
    if (Date.now() >= deadline)
      throw new FileLeaseBusyError(targetPath);
    sleepSync(options.pollIntervalMs);
  }
}
function openSqlite(path) {
  if (typeof globalThis.Bun !== "undefined") {
    const { Database } = runtimeRequire("bun:sqlite");
    const connection2 = new Database(path);
    connection2.exec("PRAGMA busy_timeout = 0");
    return connection2;
  }
  const { DatabaseSync } = runtimeRequire("node:sqlite");
  const connection = new DatabaseSync(path);
  connection.exec("PRAGMA busy_timeout = 0");
  return connection;
}
function tryKernelLock(lockPath, mode) {
  if (!existsSync4(lockPath)) {
    try {
      closeSync3(openSync3(lockPath, "wx", 384));
    } catch (error) {
      if (!isNodeErrorWithCode(error, "EEXIST"))
        throw error;
    }
  }
  const connection = openSqlite(lockPath);
  try {
    connection.exec(mode === "shared" ? "BEGIN; SELECT count(*) FROM sqlite_master;" : "BEGIN EXCLUSIVE");
  } catch (error) {
    closeQuietly(connection);
    if (isSqliteBusy(error))
      return;
    throw error;
  }
  return {
    release() {
      try {
        connection.exec("ROLLBACK");
      } catch {}
      closeQuietly(connection);
    }
  };
}
function closeQuietly(connection) {
  try {
    connection.close();
  } catch {}
}
function isSqliteBusy(error) {
  if (!error || typeof error !== "object")
    return false;
  const { code, errcode, errno } = error;
  return code === "SQLITE_BUSY" || code === "SQLITE_LOCKED" || errcode === 5 || errcode === 6 || errno === 5 || errno === 6;
}
var CURRENT_BOOT_ID = process.platform === "darwin" ? darwinBootId() : undefined;
function darwinBootId() {
  try {
    const bootSessionUuid = execFileSync("/usr/sbin/sysctl", ["-n", "kern.bootsessionuuid"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"]
    }).trim();
    return validatedBootId("darwin", bootSessionUuid);
  } catch {
    return;
  }
}
function validatedBootId(platform, value) {
  if (typeof value !== "string")
    return;
  if (platform === "linux") {
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value) ? value.toLowerCase() : undefined;
  }
  return /^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}$/.test(value) ? value : undefined;
}
function lockPathFor(targetPath) {
  return `${targetPath}.lock.db`;
}
function normalizeOptions(options) {
  return {
    mode: options.mode ?? "exclusive",
    acquireTimeoutMs: positiveInteger(options.acquireTimeoutMs, DEFAULT_OPTIONS.acquireTimeoutMs),
    pollIntervalMs: positiveInteger(options.pollIntervalMs, DEFAULT_OPTIONS.pollIntervalMs)
  };
}
function positiveInteger(value, fallback) {
  return value === undefined || !Number.isFinite(value) || value <= 0 ? fallback : Math.floor(value);
}
function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}
function isNodeErrorWithCode(error, code) {
  return !!error && typeof error === "object" && "code" in error && error.code === code;
}

// src/core/linux-engine-layout.ts
function absolute(value, name) {
  if (!isAbsolute4(value) || /[\x00-\x1f\x7f]/.test(value))
    throw new Error(`${name} must be an absolute path without control characters.`);
  return resolve2(value);
}
function rawLayout(env, recordedDataDir) {
  const home = absolute(env.HOME || homedir3(), "HOME");
  const root = (key, fallback) => absolute(env[key] || join5(home, fallback), key);
  const configHome = root("XDG_CONFIG_HOME", ".config");
  const dataHome = root("XDG_DATA_HOME", ".local/share");
  const stateHome = root("XDG_STATE_HOME", ".local/state");
  const cacheHome = root("XDG_CACHE_HOME", ".cache");
  const runtimeHome = env.XDG_RUNTIME_DIR ? absolute(env.XDG_RUNTIME_DIR, "XDG_RUNTIME_DIR") : "";
  const configDir = join5(configHome, "olympus");
  const runtimeDir = runtimeHome ? join5(runtimeHome, "olympus") : "";
  const xdgDataDir = join5(dataHome, "olympus");
  const legacyDirs = [...new Set([join5(dataHome, "openclaw/olympus"), join5(home, ".local/share/openclaw/olympus")])];
  if (recordedDataDir && ![xdgDataDir, ...legacyDirs].includes(recordedDataDir))
    throw new Error("Invalid Linux data root in install receipt.");
  const hasData = (path) => {
    const info = stat(path);
    if (!info)
      return false;
    return !info.isDirectory() || info.isSymbolicLink() || readdirSync2(path).some((name) => path !== xdgDataDir || name !== "engine");
  };
  const dataDir = recordedDataDir ?? (hasData(xdgDataDir) ? xdgDataDir : legacyDirs.find(hasData) ?? xdgDataDir);
  const stateDir = join5(stateHome, "olympus/engine"), cacheDir = join5(cacheHome, "olympus/engine");
  const packageDir = dataDir === xdgDataDir ? join5(dataHome, "olympus-engine") : join5(dataHome, "olympus/engine");
  const managedRoots = [configDir, dataDir, stateDir, cacheDir, packageDir];
  for (let i = 0;i < managedRoots.length; i += 1)
    for (let j = i + 1;j < managedRoots.length; j += 1) {
      const forward = relative2(managedRoots[i], managedRoots[j]), reverse = relative2(managedRoots[j], managedRoots[i]);
      if (forward === "" || !forward.startsWith(`..${sep2}`) && forward !== ".." && !isAbsolute4(forward) || !reverse.startsWith(`..${sep2}`) && reverse !== ".." && !isAbsolute4(reverse))
        throw new Error(`Linux Olympus managed roots must not overlap: ${managedRoots[i]} and ${managedRoots[j]}.`);
    }
  return {
    home,
    configHome,
    dataHome,
    stateHome,
    cacheHome,
    runtimeHome,
    configDir,
    dataDir,
    stateDir,
    cacheDir,
    runtimeDir,
    packageDir,
    unitPath: join5(configHome, "systemd/user/olympus-engine.service"),
    configPath: join5(configDir, "engine.json"),
    sovereigntyPath: join5(configDir, "sovereignty.json"),
    workerEnvPath: join5(configDir, "worker.env"),
    workerSocketPath: runtimeDir ? join5(runtimeDir, "worker.sock") : "",
    lifecycleLockPath: runtimeDir ? join5(runtimeDir, "lifecycle.lock") : "",
    launcherPath: join5(home, ".local/bin/olympus"),
    openHandlerPath: join5(dataHome, "applications/ai.olympusplugin.open.desktop"),
    mimeappsPath: join5(configHome, "mimeapps.list"),
    receiptPath: join5(configDir, "install-receipt.json"),
    secretsPath: join5(configDir, "secrets.enc"),
    secretsKeyPath: join5(configDir, "secrets.key")
  };
}
function stat(path) {
  try {
    return lstatSync2(path);
  } catch (e) {
    if (e.code === "ENOENT")
      return;
    throw e;
  }
}
function linuxEngineLayoutsEqual(left, right) {
  if (!left || typeof left !== "object" || Array.isArray(left))
    return false;
  const record = left, expected = right;
  const keys = Object.keys(record).sort(), expectedKeys = Object.keys(expected).sort();
  return keys.length === expectedKeys.length && keys.every((key, index) => key === expectedKeys[index] && record[key] === expected[key]);
}
function assertLinuxManagedPath(path, uid = process.getuid(), leaf = "file") {
  const full = absolute(path, "managed path");
  let current = full;
  while (true) {
    const info = stat(current);
    if (info) {
      if (info.isSymbolicLink())
        throw new Error(`${current} is a symbolic link; nothing was changed.`);
      if (info.uid !== uid && info.uid !== 0)
        throw new Error(`${current} has a foreign owner; nothing was changed.`);
      if ((info.mode & 18) !== 0 && !(info.uid === 0 && info.isDirectory() && (info.mode & 512) !== 0))
        throw new Error(`${current} has unsafe writable permissions.`);
      if (current === full) {
        if (info.uid !== uid)
          throw new Error(`${current} has a foreign owner.`);
        if (leaf === "directory" ? !info.isDirectory() : leaf === "socket" ? !info.isSocket() : !info.isFile())
          throw new Error(`${current} is not a regular ${leaf}.`);
      } else if (!info.isDirectory())
        throw new Error(`${current} is not a directory.`);
    }
    const parent = dirname6(current);
    if (parent === current)
      break;
    current = parent;
  }
}
function readLinuxEngineReceipt(path, uid = process.getuid()) {
  if (!stat(path))
    return;
  assertLinuxManagedPath(path, uid);
  if ((lstatSync2(path).mode & 63) !== 0)
    throw new Error(`${path} must be private (0600).`);
  const receipt = JSON.parse(readFileSync3(path, "utf8"));
  if (receipt.schema !== "olympus.engine.install.v1" || receipt.uid !== uid || !receipt.layout)
    throw new Error(`${path} is a foreign or invalid install receipt.`);
  if (!["installed", "recovery_pending", "data_retained"].includes(receipt.installationState))
    throw new Error(`${path} has an invalid installation state.`);
  const l = receipt.layout;
  const expected = rawLayout({ HOME: l.home, XDG_CONFIG_HOME: l.configHome, XDG_DATA_HOME: l.dataHome, XDG_STATE_HOME: l.stateHome, XDG_CACHE_HOME: l.cacheHome, XDG_RUNTIME_DIR: l.runtimeHome }, l.dataDir);
  if (!linuxEngineLayoutsEqual(l, expected) || l.receiptPath !== path)
    throw new Error(`${path} has an inconsistent install layout.`);
  const parentPaths = new Set([dirname6(l.stateDir), dirname6(l.cacheDir)]);
  if (receipt.ownedEmptyParents !== undefined && (!Array.isArray(receipt.ownedEmptyParents) || new Set(receipt.ownedEmptyParents.map((entry) => entry?.path)).size !== receipt.ownedEmptyParents.length || receipt.ownedEmptyParents.some((entry) => !entry || !parentPaths.has(entry.path) || !Number.isSafeInteger(entry.device) || entry.device < 0 || !Number.isSafeInteger(entry.inode) || entry.inode <= 0))) {
    throw new Error(`${path} has invalid empty-directory ownership.`);
  }
  const allowedLinkParents = new Set([join5(l.configHome, "systemd/user"), join5(l.home, ".config/systemd/user")]);
  if (!Array.isArray(receipt.ownedUnitLinks) || receipt.ownedUnitLinks.some((p) => typeof p !== "string" || !isAbsolute4(p) || p === l.unitPath || !allowedLinkParents.has(dirname6(p)) || !p.endsWith("/olympus-engine.service")))
    throw new Error(`${path} has invalid unit links.`);
  if (!Array.isArray(receipt.machineArtifacts) || receipt.machineArtifacts.some((entry) => !entry || typeof entry.path !== "string" || !isAbsolute4(entry.path) || !["file", "symlink", "tree"].includes(entry.kind) || !/^[0-9a-f]{64}$/.test(entry.sha256) || entry.kind === "tree" && (!Number.isSafeInteger(entry.rootDevice) || entry.rootDevice < 0 || !Number.isSafeInteger(entry.rootInode) || entry.rootInode <= 0 || entry.markerPath !== join5(entry.path, ".olympus-generation.json") || !/^[0-9a-f]{64}$/.test(entry.markerSha256 ?? "")) || entry.kind !== "tree" && (entry.rootDevice !== undefined || entry.rootInode !== undefined || entry.markerPath !== undefined || entry.markerSha256 !== undefined))) {
    throw new Error(`${path} has invalid machine artifacts.`);
  }
  if (receipt.mimeOwnership && (receipt.mimeOwnership.path !== l.mimeappsPath || receipt.mimeOwnership.scheme !== "x-scheme-handler/olympus" || receipt.mimeOwnership.desktopId !== "ai.olympusplugin.open.desktop"))
    throw new Error(`${path} has invalid MIME ownership.`);
  if (receipt.openHandlerPending !== undefined && typeof receipt.openHandlerPending !== "boolean")
    throw new Error(`${path} has invalid open-handler transaction state.`);
  const fileArtifacts = new Set([...Object.values(linuxDesktopEntryPaths(l)), l.unitPath, l.launcherPath, l.openHandlerPath, join5(l.stateDir, "service-current.json"), join5(l.stateDir, "service-previous.json"), join5(l.stateDir, "install-transaction.json")]);
  const unitLinks = new Set(receipt.ownedUnitLinks);
  const artifactPaths = new Set;
  for (const artifact of receipt.machineArtifacts) {
    if (artifactPaths.has(artifact.path))
      throw new Error(`${path} has duplicate machine artifacts.`);
    artifactPaths.add(artifact.path);
    const valid = artifact.kind === "file" ? fileArtifacts.has(artifact.path) : artifact.kind === "symlink" ? unitLinks.has(artifact.path) && artifact.path.endsWith("/olympus-engine.service") : dirname6(artifact.path) === join5(l.packageDir, "generations") && artifact.sha256 === artifact.path.slice(artifact.path.lastIndexOf("/") + 1);
    if (!valid)
      throw new Error(`${path} has a machine artifact outside the install contract.`);
  }
  if (receipt.installationState !== "installed" && (receipt.machineArtifacts.length !== 0 || receipt.ownedUnitLinks.length !== 0 || receipt.mimeOwnership || receipt.openHandlerPending))
    throw new Error(`${path} has machinery in a non-installed receipt.`);
  if (receipt.installationState === "recovery_pending" && typeof receipt.lingerPredated !== "boolean")
    throw new Error(`${path} recovery receipt has no original linger state.`);
  return receipt;
}
function resolveLinuxEngineLayout(env = process.env) {
  const home = absolute(env.HOME || homedir3(), "HOME");
  const configHome = absolute(env.XDG_CONFIG_HOME || join5(home, ".config"), "XDG_CONFIG_HOME");
  const candidates = [...new Set([join5(home, ".config/olympus/install-receipt.json"), join5(configHome, "olympus/install-receipt.json")])];
  const present = candidates.filter((p) => stat(p));
  if (present.length > 1)
    throw new Error(`Found multiple Olympus install receipts: ${present.join(", ")}. Select one installation after moving the other aside.`);
  const receipt = present[0] ? readLinuxEngineReceipt(present[0]) : undefined;
  if (receipt && receipt.layout.home !== home)
    throw new Error(`${present[0]} belongs to another home.`);
  return receipt?.layout ?? rawLayout(env);
}
var LEGACY_LINUX_POLICY_FILES = [
  "privacy.json",
  "tier-rules.json",
  "consult.json",
  "sources/dropbox.personal.ingestion.json",
  "sources/ingestion-exclusions.json"
];
function standaloneLinuxDataDir(env = process.env) {
  if (process.platform !== "linux")
    return;
  if (env.OLYMPUS_STANDALONE === "1" || env.OLYMPUS_ENGINE_HOST === "1")
    return resolveLinuxEngineLayout(env).dataDir;
  if (env.OPENCLAW_STATE_DIR || env.OPENCLAW_CONFIG_PATH || readOpenClawPluginRemote(env).hosted)
    return;
  const layout = resolveLinuxEngineLayout(env);
  if (readLinuxEngineReceipt(layout.receiptPath))
    return layout.dataDir;
  return;
}

// src/core/olympus-layout.ts
function layoutHome(env = process.env) {
  return env.HOME?.trim() || homedir4();
}
function xdgDataHome(env = process.env) {
  return env.XDG_DATA_HOME?.trim() || join6(layoutHome(env), ".local", "share");
}
function olympusDataRoot(env = process.env) {
  const standalone = standaloneLinuxDataDir(env);
  if (standalone)
    return standalone;
  return join6(xdgDataHome(env), "openclaw", "olympus");
}
function olympusDataPath(env, ...segments) {
  return join6(olympusDataRoot(env), ...segments);
}
var SHARED_DATA_FILES = {
  registry: "registry.json",
  "data-owner-lock": "data-owner.lock",
  "remote-connections": "remote-connections.sqlite",
  "source-dashboard": "source-dashboard.sqlite",
  "source-scheduler": "source-scheduler.sqlite",
  "limit-settings": "limits.json",
  "source-watches": "source-watches.sqlite",
  "file-extraction-jobs": "file-extraction-jobs.sqlite",
  "ingestion-doctor-state": "source-ingestion-doctor-state.json",
  "embedding-ledger": "embedding-ledger.jsonl",
  "classification-ledger": "classification-ledger.jsonl",
  "answer-latency": "source-answer-latency.jsonl",
  "x-usage": "x-bookmarks-api-usage.sqlite",
  "readwise-request-budget": "readwise-daily-request-budget.json",
  "gmail-request-budget": "gmail-daily-request-budget.json",
  "google-drive-request-budget": "google-drive-daily-request-budget.json",
  "credential-broker-state": "credential-broker-state.json",
  "waiting-private-questions": "waiting-private-questions.sqlite",
  "app-release-log": "app-release-log.sqlite",
  "tier-migration": "tier-migration",
  "engine-run": "engine-run",
  "engine-status": "engine-background-status.json",
  "backup-staging": "backup-staging",
  "people-index": "people-index.sqlite",
  "boot-progress": "boot-progress.json",
  "front-progress": "front-progress.json",
  "schema-backups": "schema-backups.jsonl",
  models: "models",
  "built-in-embedding": "models/built-in-embedding",
  "built-in-reasoning": "models/built-in-reasoning",
  "built-in-transcription": "models/built-in-transcription"
};
function sharedDataPath(name, env = process.env) {
  return olympusDataPath(env, SHARED_DATA_FILES[name]);
}
function legacyCaptureDataRoot(env = process.env) {
  return join6(xdgDataHome(env), "olympus");
}
function legacyTelegramStoreRoot(env = process.env) {
  return standaloneLinuxDataDir(env) ?? join6(layoutHome(env), ".local", "share", "openclaw", "olympus");
}
var gmailStore = (infix) => ({ file: `gmail-${infix}connector-store.sqlite` });
var driveStore = (infix) => ({ file: `google-drive-${infix}connector-store.sqlite` });
var dropboxStore = (infix) => ({ file: `dropbox-files-${infix}connector-store.sqlite` });
var localFilesStore = (infix) => ({ file: `local-files-${infix}connector-store.sqlite` });
var LEGACY_STORES = {
  "gmail.email": {
    internal: gmailStore(""),
    secure_local: gmailStore("secure-"),
    public_safe: gmailStore("public-")
  },
  "google_drive.docs": {
    internal: driveStore(""),
    secure_local: driveStore("secure-"),
    public_safe: driveStore("public-")
  },
  "dropbox.files": {
    secure_local: dropboxStore(""),
    internal: dropboxStore("internal-"),
    public_safe: dropboxStore("public-")
  },
  "local.files": {
    secure_local: localFilesStore(""),
    internal: localFilesStore("internal-"),
    public_safe: localFilesStore("public-")
  },
  "readwise.library": {
    internal: { file: "readwise-connector-store.sqlite" },
    secure_local: { file: "readwise-secure-connector-store.sqlite" },
    public_safe: undefined
  },
  "x.bookmarks": {
    internal: { file: "x-bookmarks-connector-store.sqlite" },
    secure_local: { file: "x-bookmarks-secure-connector-store.sqlite" },
    public_safe: undefined
  },
  "archive.imports": { secure_local: undefined, internal: undefined, public_safe: undefined },
  "telegram.messages": {
    internal: { file: "telegram-internal-connector-store.sqlite", dir: telegramStoreDirs() },
    secure_local: { file: "telegram-protected-connector-store.sqlite", dir: telegramStoreDirs() },
    public_safe: undefined
  },
  "whatsapp.personal.messages": {
    internal: { file: "connector-store-internal.db", dir: whatsappStateDirs() },
    secure_local: { file: "connector-store.db", dir: whatsappStateDirs() },
    public_safe: undefined
  }
};
var ARCHIVE_IMPORTS = "archive.imports";
var FOLDER_ONLY_STORES = {
  "evernote.notes": ["secure_local", "internal"]
};
var FOLDER_LAYOUT_SOURCES = [...Object.keys(LEGACY_STORES), ...Object.keys(FOLDER_ONLY_STORES)];
var RAW_OWNER = {
  watch: "local.files",
  "x-reconcile.sqlite": "x.bookmarks",
  "archive-imports.json": ARCHIVE_IMPORTS,
  "archive-import-requests.json": ARCHIVE_IMPORTS,
  "archive-media-bindings.sqlite": ARCHIVE_IMPORTS,
  "archive-staging": ARCHIVE_IMPORTS,
  "evernote-pass.json": "evernote.notes",
  ...messagingRawOwners()
};
function messagingRawOwners() {
  return {
    "telegram-spool": "telegram.messages",
    "telegram-gateway": "telegram.messages",
    whatsapp: "whatsapp.personal.messages",
    "whatsapp-spool": "whatsapp.personal.messages",
    "whatsapp-media": "whatsapp.personal.messages",
    "whatsapp-media-root": "whatsapp.personal.messages"
  };
}
function telegramStoreDirs() {
  return { resolved: legacyTelegramStoreRoot, default: legacyTelegramStoreRoot };
}
function legacyWhatsAppStateDir(env) {
  return env.OLYMPUS_WHATSAPP_STATE_DIR?.trim() || join6(legacyCaptureDataRoot(env), "whatsapp-live");
}
function whatsappStateDirs() {
  return { resolved: legacyWhatsAppStateDir, default: (env) => join6(legacyCaptureDataRoot(env), "whatsapp-live") };
}

// src/core/engine-split.ts
var ENGINE_ROLE_ENV = "OLYMPUS_WORKER_ENGINE_ROLE";
function engineRoleFromEnv(env = process.env) {
  const value = env[ENGINE_ROLE_ENV]?.trim();
  if (!value)
    return "single";
  if (value === "background" || value === "front")
    return value;
  throw new Error(`${ENGINE_ROLE_ENV} must be background or front.`);
}

// src/workers/control-path-headroom.ts
var CONTROL_PATH_SLICE_MS = 20;
var CONTROL_PATH_LAG_REST_THRESHOLD_MS = 200;
var CONTROL_PATH_REST_MS = 25;
var HEARTBEAT_MS = 50;
var CONTROL_PATH_FREEZE_LOG_MS = 2000;
function controlPathFreezeSubject(role, mainThread = true) {
  if (!mainThread)
    return "a background thread was blocked";
  if (role === "front")
    return "the front process could not answer requests";
  if (role === "background")
    return "the background process was blocked";
  return "the worker could not answer requests";
}
function roleFromEnv() {
  try {
    return engineRoleFromEnv();
  } catch {
    return "single";
  }
}

class ControlPathHeadroom {
  sliceMs;
  lagRestThresholdMs;
  restMs;
  now;
  turn;
  lastTurnAt;
  pendingTurn;
  lastLagMs = 0;
  heartbeat;
  expectedBeatAt = 0;
  turns = 0;
  rests = 0;
  freezes = 0;
  active = new Map;
  log;
  freezeLogMs;
  freezeSubject;
  constructor(options = {}) {
    this.sliceMs = options.sliceMs ?? CONTROL_PATH_SLICE_MS;
    this.lagRestThresholdMs = options.lagRestThresholdMs ?? CONTROL_PATH_LAG_REST_THRESHOLD_MS;
    this.restMs = options.restMs ?? CONTROL_PATH_REST_MS;
    this.now = options.now ?? (() => performance.now());
    this.turn = options.turn ?? ((ms) => new Promise((resolve4) => {
      setTimeout(resolve4, ms);
    }));
    this.log = options.log ?? ((line) => console.error(line));
    this.freezeLogMs = options.freezeLogMs ?? CONTROL_PATH_FREEZE_LOG_MS;
    this.freezeSubject = controlPathFreezeSubject(options.role ?? roleFromEnv(), isMainThread2);
    this.lastTurnAt = this.now();
  }
  enter(label) {
    this.ensureHeartbeat();
    this.active.set(label, (this.active.get(label) ?? 0) + 1);
    let left = false;
    return () => {
      if (left)
        return;
      left = true;
      const count = (this.active.get(label) ?? 1) - 1;
      if (count <= 0)
        this.active.delete(label);
      else
        this.active.set(label, count);
    };
  }
  ingestionTurn() {
    this.ensureHeartbeat();
    if (this.pendingTurn)
      return this.pendingTurn;
    const now = this.now();
    if (now - this.lastTurnAt < this.sliceMs)
      return;
    const rest = this.lastLagMs >= this.lagRestThresholdMs;
    if (rest)
      this.rests += 1;
    this.turns += 1;
    const pending = this.turn(rest ? this.restMs : 0).then(() => {
      this.pendingTurn = undefined;
      this.lastTurnAt = this.now();
    });
    this.pendingTurn = pending;
    return pending;
  }
  snapshot() {
    return { turns: this.turns, rests: this.rests, freezes: this.freezes, lagMs: Math.round(this.lastLagMs) };
  }
  stop() {
    if (this.heartbeat)
      clearInterval(this.heartbeat);
    this.heartbeat = undefined;
  }
  ensureHeartbeat() {
    if (this.heartbeat)
      return;
    this.expectedBeatAt = this.now() + HEARTBEAT_MS;
    this.heartbeat = setInterval(() => {
      const now = this.now();
      this.lastLagMs = Math.max(0, now - this.expectedBeatAt);
      this.expectedBeatAt = now + HEARTBEAT_MS;
      if (this.lastLagMs >= this.freezeLogMs) {
        this.freezes += 1;
        const running = [...this.active.keys()].sort().join(",") || "none";
        this.log(`${new Date().toISOString()} [olympus:control-path] ${this.freezeSubject} for ${Math.round(this.lastLagMs)} ms; background work running: ${running}`);
      }
    }, HEARTBEAT_MS);
    this.heartbeat.unref?.();
  }
}
var controlPathHeadroom = new ControlPathHeadroom;
function ingestionTurn() {
  return controlPathHeadroom.ingestionTurn();
}

// src/workers/source-index/pinned-download.ts
import { closeSync as closeSync4, createReadStream, existsSync as existsSync5, openSync as openSync4, renameSync as renameSync2, rmSync as rmSync2, statSync as statSync2, writeSync } from "node:fs";
var REQUEST_BYTES = 256 * 1024 ** 2;
var WRITE_SLICE_BYTES = 64 * 1024;
var READ_RETRIES = 3;
var RETRY_DELAY_MS = 250;

class InterruptedRead extends Error {
}
async function downloadPinnedFile(options) {
  const { fetchImpl, url, target, partial, expectedBytes, algorithm, encoding, noun, stallMs, error } = options;
  let hash = createHash(algorithm);
  let received = 0;
  let fd;
  let discard = false;
  const close = () => {
    if (fd !== undefined) {
      const open = fd;
      fd = undefined;
      closeSync4(open);
    }
  };
  const mismatch = (message) => {
    discard = true;
    return error("checksum_mismatch", message);
  };
  const disk = (cause) => {
    discard = true;
    close();
    rmSync2(partial, { force: true });
    return options.diskError?.(cause) ?? error("disk_write_failed", `Could not write the download: ${String(cause)}`);
  };
  try {
    if (existsSync5(partial)) {
      const size = statSync2(partial).size;
      if (size > 0 && size < expectedBytes) {
        await hashPartial(partial, hash, options.verifyTimeoutMs);
        received = size;
        options.onProgress(size);
      } else
        rmSync2(partial, { force: true });
    }
    let retries = 0;
    while (received < expectedBytes) {
      const start = received;
      const end = Math.min(expectedBytes - 1, start + REQUEST_BYTES - 1);
      const controller = new AbortController;
      let timer;
      const armStall = () => {
        clearTimeout(timer);
        timer = setTimeout(() => controller.abort(new Error(`no data for ${Math.round(stallMs / 1000)} s`)), stallMs);
      };
      let response;
      let reader;
      let retry = false;
      try {
        armStall();
        try {
          response = await untilAborted(fetchImpl(url, {
            redirect: "follow",
            signal: controller.signal,
            headers: { Range: `bytes=${start}-${end}`, "Accept-Encoding": "identity" }
          }), controller.signal);
        } catch (cause) {
          throw error("download_failed", `Could not reach the download server for the ${noun} (${message(cause)}).`);
        }
        if (response.status !== 200 && response.status !== 206 || !response.body) {
          throw error("download_failed", `The ${noun} download failed (HTTP ${response.status}).`);
        }
        let responseEnd = expectedBytes - 1;
        if (response.status === 206) {
          const range = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(response.headers.get("Content-Range") ?? "");
          if (!range || Number(range[1]) !== start || Number(range[2]) !== end || Number(range[3]) !== expectedBytes) {
            throw error("download_failed", `The ${noun} download returned an invalid Content-Range.`);
          }
          responseEnd = end;
        } else if (received > 0) {
          try {
            close();
            fd = openSync4(partial, "w", 420);
          } catch (cause) {
            throw disk(cause);
          }
          hash = createHash(algorithm);
          options.onProgress(-received);
          received = 0;
        }
        options.onStart();
        if (fd === undefined) {
          try {
            fd = openSync4(partial, received > 0 ? "a" : "w", 420);
          } catch (cause) {
            throw disk(cause);
          }
        }
        const bodyReader = response.body.getReader();
        reader = bodyReader;
        const readNext = async () => {
          armStall();
          let part;
          try {
            part = await untilAborted(bodyReader.read(), controller.signal);
          } catch (cause) {
            throw new InterruptedRead(message(cause));
          }
          if (part.done)
            return false;
          if (received + part.value.byteLength > responseEnd + 1) {
            throw mismatch(`${url} is larger than its pinned size or requested range.`);
          }
          for (let offset = 0;offset < part.value.byteLength; offset += WRITE_SLICE_BYTES) {
            const slice = part.value.subarray(offset, offset + WRITE_SLICE_BYTES);
            try {
              (options.write ?? writeDownloadChunk)(fd, slice);
            } catch (cause) {
              throw disk(cause);
            }
            hash.update(slice);
            received += slice.byteLength;
            options.onProgress(slice.byteLength);
            const turn = (options.turn ?? ingestionTurn)();
            if (turn)
              await turn;
          }
          return true;
        };
        while (await readNext()) {}
        if (received !== responseEnd + 1)
          throw mismatch(`${url} did not match its pinned size; nothing was installed.`);
      } catch (cause) {
        if (!(cause instanceof InterruptedRead))
          throw cause;
        if (retries >= READ_RETRIES) {
          throw error("download_failed", `The ${noun} download was interrupted (${cause.message}).`);
        }
        retries += 1;
        retry = true;
      } finally {
        clearTimeout(timer);
        if (reader) {
          reader.cancel().catch(() => {
            return;
          });
          reader.releaseLock();
        } else if (response?.body)
          response.body.cancel().catch(() => {
            return;
          });
        controller.abort();
      }
      if (retry)
        await new Promise((resolve4) => setTimeout(resolve4, RETRY_DELAY_MS * 2 ** (retries - 1)));
    }
    close();
    if (received !== expectedBytes || hash.digest(encoding) !== options.digest) {
      throw mismatch(`${url} did not match its pinned checksum; nothing was installed.`);
    }
    renameSync2(partial, target);
  } catch (cause) {
    close();
    if (discard || !options.keepPartial)
      rmSync2(partial, { force: true });
    throw cause;
  }
}
function writeDownloadChunk(fd, bytes) {
  let offset = 0;
  while (offset < bytes.byteLength) {
    const written = writeSync(fd, bytes, offset, bytes.byteLength - offset);
    if (written === 0)
      throw new Error("The disk stopped accepting data.");
    offset += written;
  }
}
async function hashPartial(path, hash, timeoutMs) {
  const stream = createReadStream(path);
  const timer = setTimeout(() => stream.destroy(new Error(`Checking ${path} did not finish in time.`)), timeoutMs);
  try {
    for await (const bytes of stream)
      hash.update(bytes);
  } finally {
    clearTimeout(timer);
    stream.destroy();
  }
}
function message(cause) {
  return cause instanceof Error ? cause.message : String(cause);
}

// src/workers/source-index/built-in-embedding/assets.ts
import { createHash as createHash2, randomUUID as randomUUID2 } from "node:crypto";
import {
  closeSync as closeSync5,
  createReadStream as createReadStream2,
  existsSync as existsSync6,
  mkdirSync as mkdirSync4,
  openSync as openSync5,
  readFileSync as readFileSync4,
  renameSync as renameSync3,
  rmSync as rmSync3,
  statSync as statSync3,
  writeFileSync as writeFileSync2,
  writeSync as writeSync2
} from "node:fs";
import { basename as basename2, dirname as dirname8, isAbsolute as isAbsolute6, join as join7 } from "node:path";

// src/workers/source-index/built-in-embedding/manifest.ts
var ARCTIC_M_REVISION = "e58a8f756156a1293d763f17e3aae643474e9b8a";
var ARCTIC_M_BASE = `https://huggingface.co/Snowflake/snowflake-arctic-embed-m-v1.5/resolve/${ARCTIC_M_REVISION}`;
var ARCTIC_EMBED_M_V1_5 = {
  modelId: "arctic-embed-m-v1.5-int8-e58a8f7",
  repository: "Snowflake/snowflake-arctic-embed-m-v1.5",
  revision: ARCTIC_M_REVISION,
  license: "Apache-2.0",
  dimension: 768,
  maxTokens: 512,
  pooling: "cls",
  queryPrefix: "Represent this sentence for searching relevant passages: ",
  documentPrefix: "",
  model: {
    name: "model_quantized.onnx",
    url: `${ARCTIC_M_BASE}/onnx/model_quantized.onnx`,
    bytes: 110145162,
    sha256: "a18f437b2466863901a0bdc14904cf93246f5ecce0b656fc773bc2b7b2f84f6e"
  },
  vocabulary: {
    name: "vocab.txt",
    url: `${ARCTIC_M_BASE}/vocab.txt`,
    bytes: 231508,
    sha256: "07eced375cec144d27c900241f3e339478dec958f92fddbc551f295c992038a3"
  }
};
var EMBEDDINGGEMMA_2_REVISION = "24d962e906c7d332c6428e71c9676855024569e2";
var EMBEDDINGGEMMA_2_BASE = `https://huggingface.co/litert-community/embeddinggemma-2-740m-litert-lm/resolve/${EMBEDDINGGEMMA_2_REVISION}`;
var EMBEDDINGGEMMA_2 = {
  modelId: "embeddinggemma-2-litert-24d962e",
  repository: "litert-community/embeddinggemma-2-740m-litert-lm",
  revision: EMBEDDINGGEMMA_2_REVISION,
  license: "Apache-2.0",
  runtime: "litert",
  dimension: 768,
  maxTokens: 2048,
  pooling: "model",
  queryPrefix: "task: search result | query: ",
  documentPrefix: "title: {title} | text: ",
  vision: { tokensPerImage: 140 },
  model: {
    name: "embeddinggemma-2-740m.litertlm",
    url: `${EMBEDDINGGEMMA_2_BASE}/embeddinggemma-2-740m.litertlm`,
    bytes: 484622336,
    sha256: "e7a8a2204b91e0f96e92960e84a09a89212e1633dcb7575a9bf3378b4df77f4c"
  }
};
var BUILT_IN_EMBEDDING_MODEL = EMBEDDINGGEMMA_2;
function builtInEmbeddingModelFiles(model) {
  return [model.model, ...model.vocabulary ? [model.vocabulary] : []];
}
var ONNX_RUNTIME_PACK = {
  version: "1.30.0",
  runtime: {
    name: "onnxruntime-node",
    version: "1.30.0",
    url: "https://registry.npmjs.org/onnxruntime-node/-/onnxruntime-node-1.30.0.tgz",
    bytes: 113507888,
    integrity: "sha512-twhs1C2C/BFkz1yc5OY0KIU2GUq6DURO7hD4bx5Q2Qy3nAMJwRXW8xU3NVczE29VA9lolLOYepoD8fjTGOfIqw=="
  },
  common: {
    name: "onnxruntime-common",
    version: "1.30.0",
    url: "https://registry.npmjs.org/onnxruntime-common/-/onnxruntime-common-1.30.0.tgz",
    bytes: 66795,
    integrity: "sha512-7fdVWjAID1dVhH/G8qK3APARunV4VkBFoCQAP7qp4Wkab0mrorvmc+sqiT+mKXOzDqdjN5j+/Z9nb4gzNPWcyA=="
  },
  platforms: ["darwin-arm64", "linux-x64", "linux-arm64"]
};
var LITERT_WHEELS = "https://files.pythonhosted.org/packages";
var LITERT_RUNTIME_PACK = {
  version: "0.18.0",
  platforms: {
    "darwin-arm64": {
      name: "litert_lm_api-0.18.0-py3-none-macosx_12_0_arm64.whl",
      url: `${LITERT_WHEELS}/cc/df/147e5fa60cf8964bdcbc022cbd38502f91ea415bf82bed2c9335fcf9be9d/litert_lm_api-0.18.0-py3-none-macosx_12_0_arm64.whl`,
      bytes: 21430649,
      sha256: "9fd0c55835e469a035c1b75cde4797b26292963c2c36d9fcdfceb965ffa08a37",
      library: "litert_lm/liblitert-lm.dylib"
    },
    "linux-x64": {
      name: "litert_lm_api-0.18.0-py3-none-manylinux_2_27_x86_64.whl",
      url: `${LITERT_WHEELS}/c9/8f/eb7a5203be1d48440c6b8d6e6382c3f744dd6d338fe400555718b4d695a1/litert_lm_api-0.18.0-py3-none-manylinux_2_27_x86_64.whl`,
      bytes: 47051760,
      sha256: "b64e2cf6d7dcb90ff094b74af595cc5d53faa07e0889f967d15df8d3e696b53c",
      library: "litert_lm/liblitert-lm.so"
    },
    "linux-arm64": {
      name: "litert_lm_api-0.18.0-py3-none-manylinux_2_27_aarch64.whl",
      url: `${LITERT_WHEELS}/cf/f2/60707ac6860248e5f3601926c7cfe44794db350b60c1f14cb6e7e8874ae4/litert_lm_api-0.18.0-py3-none-manylinux_2_27_aarch64.whl`,
      bytes: 46425934,
      sha256: "d066db0c2bcd832b2b9cf8532b5fff385f7cff8562a1b482f8da0b51f810c47c",
      library: "litert_lm/liblitert-lm.so"
    }
  }
};

// src/workers/source-index/built-in-embedding/tar.ts
import { gunzipSync } from "node:zlib";
var BLOCK = 512;
function readTarGz(archive, include) {
  return readTar(gunzipSync(archive), include);
}
function readTar(tar, include) {
  const files = [];
  let offset = 0;
  let paxPath;
  let longName;
  while (offset + BLOCK <= tar.length) {
    const header = tar.subarray(offset, offset + BLOCK);
    if (header.every((byte) => byte === 0))
      break;
    const size = parseOctal(header.subarray(124, 136));
    const type = String.fromCharCode(header[156] ?? 0);
    const dataStart = offset + BLOCK;
    const data = tar.subarray(dataStart, dataStart + size);
    offset = dataStart + Math.ceil(size / BLOCK) * BLOCK;
    if (type === "x") {
      paxPath = parsePaxPath(data) ?? paxPath;
      continue;
    }
    if (type === "g")
      continue;
    if (type === "L") {
      longName = cString(data);
      continue;
    }
    const name = cString(header.subarray(0, 100));
    const prefix = isUstar(header) ? cString(header.subarray(345, 500)) : "";
    const path = paxPath ?? longName ?? (prefix ? `${prefix}/${name}` : name);
    paxPath = undefined;
    longName = undefined;
    if (type !== "0" && type !== "\x00")
      continue;
    if (!isSafeRelativePath(path) || !include(path))
      continue;
    files.push({ path, mode: parseOctal(header.subarray(100, 108)), data: data.slice() });
  }
  return files;
}
function isUstar(header) {
  return cString(header.subarray(257, 263)).startsWith("ustar");
}
function cString(bytes) {
  const end = bytes.indexOf(0);
  return new TextDecoder().decode(end === -1 ? bytes : bytes.subarray(0, end));
}
function parseOctal(bytes) {
  const text = cString(bytes).trim();
  return text ? Number.parseInt(text, 8) : 0;
}
function parsePaxPath(data) {
  const text = new TextDecoder().decode(data);
  for (const record of text.split(`
`)) {
    const match = /^\d+ path=(.*)$/.exec(record);
    if (match)
      return match[1];
  }
  return;
}
function isSafeRelativePath(path) {
  if (!path || path.startsWith("/") || path.includes("\\"))
    return false;
  return path.split("/").every((segment) => segment !== "..");
}

// src/workers/source-index/built-in-embedding/zip.ts
import { inflateRawSync } from "node:zlib";
var END_OF_CENTRAL_DIRECTORY = 101010256;
var CENTRAL_DIRECTORY_ENTRY = 33639248;
var LOCAL_FILE_HEADER = 67324752;
function readZipEntry(archive, name) {
  const view = new DataView(archive.buffer, archive.byteOffset, archive.byteLength);
  let end = -1;
  for (let offset2 = archive.length - 22;offset2 >= Math.max(0, archive.length - 22 - 65535); offset2 -= 1) {
    if (view.getUint32(offset2, true) === END_OF_CENTRAL_DIRECTORY) {
      end = offset2;
      break;
    }
  }
  if (end < 0)
    throw new Error("Not a ZIP archive: no end of central directory.");
  const entries = view.getUint16(end + 10, true);
  let offset = view.getUint32(end + 16, true);
  const inBounds = (start, length) => start >= 0 && length >= 0 && start + length <= archive.length;
  const decoder = new TextDecoder;
  for (let index = 0;index < entries; index += 1) {
    if (!inBounds(offset, 46) || view.getUint32(offset, true) !== CENTRAL_DIRECTORY_ENTRY)
      throw new Error("Corrupt ZIP central directory.");
    const flags = view.getUint16(offset + 8, true);
    const method = view.getUint16(offset + 10, true);
    const compressedSize = view.getUint32(offset + 20, true);
    const size = view.getUint32(offset + 24, true);
    const nameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    const localOffset = view.getUint32(offset + 42, true);
    const entryName = decoder.decode(archive.subarray(offset + 46, offset + 46 + nameLength));
    offset += 46 + nameLength + extraLength + commentLength;
    if (entryName !== name)
      continue;
    if (flags & 1)
      throw new Error(`${name} is encrypted.`);
    if (!inBounds(localOffset, 30) || view.getUint32(localOffset, true) !== LOCAL_FILE_HEADER)
      throw new Error("Corrupt ZIP local header.");
    const dataStart = localOffset + 30 + view.getUint16(localOffset + 26, true) + view.getUint16(localOffset + 28, true);
    if (!inBounds(dataStart, compressedSize))
      throw new Error(`${name} runs past the end of the archive.`);
    const compressed = archive.subarray(dataStart, dataStart + compressedSize);
    const data = method === 0 ? compressed : method === 8 ? new Uint8Array(inflateRawSync(compressed, { maxOutputLength: Math.max(1, size) })) : undefined;
    if (!data)
      throw new Error(`${name} uses unsupported ZIP compression method ${method}.`);
    if (data.length !== size)
      throw new Error(`${name} unpacked to ${data.length} bytes, expected ${size}.`);
    return data;
  }
  return;
}

// src/workers/source-index/built-in-embedding/assets.ts
var BUILT_IN_EMBEDDING_DIR_ENV = "OLYMPUS_BUILT_IN_EMBEDDING_DIR";
var STALE_LOCK_MS = 30 * 60000;
var LOCK_POLL_MS = 1000;
var PROGRESS_WRITE_INTERVAL_MS = 500;
var DOWNLOAD_STALL_MS = 2 * 60000;

class BuiltInEmbeddingInstallError extends Error {
  reason;
  constructor(reason, message2) {
    super(message2);
    this.name = "BuiltInEmbeddingInstallError";
    this.reason = reason;
  }
}
function builtInEmbeddingPaths(env = process.env, model = BUILT_IN_EMBEDDING_MODEL, runtime = ONNX_RUNTIME_PACK, platform = currentPlatform(), liteRtRuntime = LITERT_RUNTIME_PACK) {
  const configured = env[BUILT_IN_EMBEDDING_DIR_ENV]?.trim();
  const root = configured || sharedDataPath("built-in-embedding", env);
  if (!isAbsolute6(root))
    throw new TypeError("The built-in embedding directory must be an absolute path.");
  return {
    root,
    modelDir: join7(root, model.modelId),
    runtimeDir: model.runtime === "litert" ? join7(root, `litert-lm-${liteRtRuntime.version}-${platform}`) : join7(root, `onnxruntime-${runtime.version}-${platform}`),
    statusPath: join7(root, "status.json"),
    lockPath: join7(root, "install.lock")
  };
}
function installedBuiltInEmbedding(paths, model = BUILT_IN_EMBEDDING_MODEL, platform = currentPlatform(), liteRtRuntime = LITERT_RUNTIME_PACK) {
  const liteRt = model.runtime === "litert" ? liteRtRuntime.platforms[platform] : undefined;
  return {
    modelPath: join7(paths.modelDir, model.model.name),
    ...model.vocabulary ? { vocabularyPath: join7(paths.modelDir, model.vocabulary.name) } : {},
    runtimeDir: paths.runtimeDir,
    ...liteRt ? { libraryPath: join7(paths.runtimeDir, basename2(liteRt.library)) } : {}
  };
}
function currentPlatform() {
  return `${process.platform}-${process.arch}`;
}
function readBuiltInEmbeddingStatus(env = process.env, model = BUILT_IN_EMBEDDING_MODEL) {
  const fallback = {
    state: "not_started",
    modelId: model.modelId,
    percent: 0,
    label: "Built-in search model not downloaded yet",
    bytesDone: 0,
    bytesTotal: 0,
    updatedAt: new Date(0).toISOString()
  };
  try {
    const parsed = JSON.parse(readFileSync4(builtInEmbeddingPaths(env, model).statusPath, "utf8"));
    return parsed && typeof parsed === "object" && parsed.modelId === model.modelId ? parsed : fallback;
  } catch {
    return fallback;
  }
}
function reportBuiltInEmbeddingVision(vision, options = {}) {
  const model = options.model ?? BUILT_IN_EMBEDDING_MODEL;
  if (!model.vision)
    return;
  let temporary;
  try {
    const root = builtInEmbeddingPaths(options.env, model).root;
    mkdirSync4(root, { recursive: true, mode: 448 });
    const path = join7(root, "vision.json");
    temporary = `${path}.${process.pid}.tmp`;
    writeFileSync2(temporary, `${JSON.stringify({
      modelId: model.modelId,
      vision,
      checkedAt: (options.now?.() ?? new Date).toISOString()
    })}
`, { mode: 384 });
    renameSync3(temporary, path);
  } catch {
    if (temporary)
      rmSync3(temporary, { force: true });
  }
}
async function installBuiltInEmbedding(options = {}) {
  const { onProgress, ...serializable } = options;
  if (isMainThread3 && !Object.values(serializable).some((value) => typeof value === "function")) {
    try {
      return await modelThread().call({
        kind: "embedding-install",
        options: { ...serializable, env: options.env ?? process.env }
      }, { embeddingProgress: onProgress });
    } catch (error) {
      const failure = error;
      throw new BuiltInEmbeddingInstallError(failure.reason ?? "runtime_load_failed", failure.message);
    }
  }
  const model = options.model ?? BUILT_IN_EMBEDDING_MODEL;
  const runtime = options.runtime ?? ONNX_RUNTIME_PACK;
  const platform = options.platform ?? currentPlatform();
  const paths = builtInEmbeddingPaths(options.env, model, runtime, platform, options.liteRtRuntime);
  const reporter = new ProgressReporter(paths.statusPath, model.modelId, options.now, options.onProgress);
  const installed = installedBuiltInEmbedding(paths, model, platform, options.liteRtRuntime);
  if (model.runtime === "litert")
    return installLiteRt(options, model, paths, platform, reporter, installed);
  try {
    if (!options.skipRuntime && !runtime.platforms.includes(platform)) {
      throw new BuiltInEmbeddingInstallError("unsupported_platform", `The built-in search model does not run on ${platform}.`);
    }
    ensureDirectory(paths.root);
    const modelFiles = builtInEmbeddingModelFiles(model);
    const runtimePackages = options.skipRuntime ? [] : [runtime.common, runtime.runtime];
    if (installComplete(paths, modelFiles, runtimePackages)) {
      await verifyModelFiles(paths.modelDir, modelFiles, reporter);
      return installed;
    }
    await withInstallLock(paths.lockPath, options.lockWaitMs ?? STALE_LOCK_MS, async () => {
      if (installComplete(paths, modelFiles, runtimePackages))
        return;
      const fetchImpl = options.fetchImpl ?? fetch;
      const stallMs = options.downloadStallMs ?? DOWNLOAD_STALL_MS;
      const pending = [
        ...modelFiles.filter((file) => !existsSync6(join7(paths.modelDir, file.name)))
      ];
      const pendingPackages = runtimePackages.length > 0 && !runtimeInstalled(paths.runtimeDir, runtimePackages) ? runtimePackages : [];
      const bytesTotal = pending.reduce((sum, file) => sum + file.bytes, 0) + pendingPackages.reduce((sum, pack) => sum + pack.bytes, 0);
      reporter.begin(bytesTotal);
      ensureDirectory(paths.modelDir);
      for (const file of pending) {
        await downloadVerified(fetchImpl, file.url, join7(paths.modelDir, file.name), file.bytes, {
          kind: "sha256",
          expected: file.sha256
        }, reporter, labelFor(file), stallMs);
      }
      if (pendingPackages.length > 0) {
        await installRuntime(fetchImpl, paths.runtimeDir, pendingPackages, platform, reporter, stallMs);
      }
    });
    await verifyModelFiles(paths.modelDir, modelFiles, reporter);
    if (runtimePackages.length > 0 && !runtimeInstalled(paths.runtimeDir, runtimePackages)) {
      throw new BuiltInEmbeddingInstallError("runtime_load_failed", "The built-in search runtime did not install completely.");
    }
    return installed;
  } catch (error) {
    const failure = error instanceof BuiltInEmbeddingInstallError ? error : new BuiltInEmbeddingInstallError("disk_write_failed", error instanceof Error ? error.message : String(error));
    reporter.fail(failure.reason, failure.message);
    throw failure;
  }
}
async function installLiteRt(options, model, paths, platform, reporter, installed) {
  const pack = options.liteRtRuntime ?? LITERT_RUNTIME_PACK;
  const wheel = pack.platforms[platform];
  try {
    if (!wheel && !options.skipRuntime) {
      throw new BuiltInEmbeddingInstallError("unsupported_platform", `The built-in search model does not run on ${platform}.`);
    }
    ensureDirectory(paths.root);
    const modelFiles = builtInEmbeddingModelFiles(model);
    const wantsRuntime = Boolean(wheel) && !options.skipRuntime;
    if (wantsRuntime && liteRtInstalled(paths.runtimeDir, wheel) && !await liteRtLibraryIntact(paths.runtimeDir, wheel)) {
      rmSync3(paths.runtimeDir, { recursive: true, force: true });
    }
    const complete = () => modelFiles.every((file) => existsSync6(join7(paths.modelDir, file.name))) && (!wantsRuntime || liteRtInstalled(paths.runtimeDir, wheel));
    if (!complete()) {
      await withInstallLock(paths.lockPath, options.lockWaitMs ?? STALE_LOCK_MS, async () => {
        if (complete())
          return;
        const fetchImpl = options.fetchImpl ?? fetch;
        const stallMs = options.downloadStallMs ?? DOWNLOAD_STALL_MS;
        const pending = modelFiles.filter((file) => !existsSync6(join7(paths.modelDir, file.name)));
        const runtimePending = wantsRuntime && !liteRtInstalled(paths.runtimeDir, wheel);
        reporter.begin(pending.reduce((sum, file) => sum + file.bytes, 0) + (runtimePending ? wheel.bytes : 0));
        ensureDirectory(paths.modelDir);
        for (const file of pending) {
          await downloadVerified(fetchImpl, file.url, join7(paths.modelDir, file.name), file.bytes, {
            kind: "sha256",
            expected: file.sha256
          }, reporter, "Downloading the built-in search model", stallMs);
        }
        if (runtimePending)
          await installLiteRtRuntime(fetchImpl, paths.runtimeDir, wheel, reporter, stallMs);
      });
    }
    await verifyModelFiles(paths.modelDir, modelFiles, reporter);
    if (wantsRuntime && !liteRtInstalled(paths.runtimeDir, wheel)) {
      throw new BuiltInEmbeddingInstallError("runtime_load_failed", "The built-in search runtime did not install completely.");
    }
    return installed;
  } catch (error) {
    const failure = error instanceof BuiltInEmbeddingInstallError ? error : new BuiltInEmbeddingInstallError("disk_write_failed", error instanceof Error ? error.message : String(error));
    reporter.fail(failure.reason, failure.message);
    throw failure;
  }
}
function readLiteRtMarker(runtimeDir) {
  try {
    return JSON.parse(readFileSync4(join7(runtimeDir, RUNTIME_MARKER), "utf8"));
  } catch {
    return;
  }
}
function liteRtInstalled(runtimeDir, wheel) {
  const marker = readLiteRtMarker(runtimeDir);
  return marker?.sha256 === wheel.sha256 && /^[0-9a-f]{64}$/.test(marker.librarySha256 ?? "") && existsSync6(join7(runtimeDir, basename2(wheel.library)));
}
async function liteRtLibraryIntact(runtimeDir, wheel) {
  const expected = readLiteRtMarker(runtimeDir)?.librarySha256;
  return expected !== undefined && await sha256File(join7(runtimeDir, basename2(wheel.library))) === expected;
}
async function installLiteRtRuntime(fetchImpl, runtimeDir, wheel, reporter, stallMs) {
  const staging = `${runtimeDir}.staging-${randomUUID2()}`;
  ensureDirectory(staging);
  try {
    const archivePath = join7(staging, wheel.name);
    await downloadVerified(fetchImpl, wheel.url, archivePath, wheel.bytes, {
      kind: "sha256",
      expected: wheel.sha256
    }, reporter, "Downloading the search runtime", stallMs);
    reporter.set("verifying", "Unpacking the search runtime");
    const library = readZipEntry(readFileSync4(archivePath), wheel.library);
    if (!library)
      throw new BuiltInEmbeddingInstallError("runtime_load_failed", `${wheel.name} has no ${wheel.library}.`);
    writeFileSync2(join7(staging, basename2(wheel.library)), library, { mode: 493 });
    rmSync3(archivePath, { force: true });
    const marker = {
      wheel: wheel.name,
      sha256: wheel.sha256,
      librarySha256: createHash2("sha256").update(library).digest("hex")
    };
    writeFileSync2(join7(staging, RUNTIME_MARKER), `${JSON.stringify(marker, null, 2)}
`);
    rmSync3(runtimeDir, { recursive: true, force: true });
    renameSync3(staging, runtimeDir);
  } catch (error) {
    rmSync3(staging, { recursive: true, force: true });
    throw error;
  }
}
function reportBuiltInEmbeddingState(options, state, failure) {
  const model = options.model ?? BUILT_IN_EMBEDDING_MODEL;
  const paths = builtInEmbeddingPaths(options.env, model);
  const reporter = new ProgressReporter(paths.statusPath, model.modelId, options.now, options.onProgress);
  if (state === "failed" && failure)
    reporter.fail(failure.reason, failure.message);
  else
    reporter.set(state, state === "ready" ? "Built-in search model ready" : "Starting the built-in search model", 100);
}
function labelFor(file) {
  return file.name.endsWith(".onnx") ? "Downloading the built-in search model" : "Downloading the model vocabulary";
}
function installComplete(paths, modelFiles, runtimePackages) {
  return modelFiles.every((file) => existsSync6(join7(paths.modelDir, file.name))) && (runtimePackages.length === 0 || runtimeInstalled(paths.runtimeDir, runtimePackages));
}
var verifiedThisProcess;
async function verifyModelFiles(dir, files, reporter) {
  for (const file of files) {
    const path = join7(dir, file.name);
    const key = `${path}:${file.sha256}`;
    verifiedThisProcess ??= new Set;
    if (verifiedThisProcess.has(key))
      continue;
    const size = statSync3(path).size;
    const digest = size === file.bytes ? await sha256File(path) : undefined;
    if (digest !== file.sha256) {
      rmSync3(path, { force: true });
      throw new BuiltInEmbeddingInstallError("checksum_mismatch", `${file.name} did not match its pinned checksum and was removed; it will download again.`);
    }
    verifiedThisProcess.add(key);
  }
  reporter.touch();
}
var RUNTIME_MARKER = "olympus-runtime.json";
function runtimeInstalled(runtimeDir, packages) {
  try {
    const marker = JSON.parse(readFileSync4(join7(runtimeDir, RUNTIME_MARKER), "utf8"));
    return packages.every((pack) => marker.packages.some((entry) => entry.name === pack.name && entry.integrity === pack.integrity));
  } catch {
    return false;
  }
}
async function installRuntime(fetchImpl, runtimeDir, packages, platform, reporter, stallMs) {
  const staging = `${runtimeDir}.staging-${randomUUID2()}`;
  ensureDirectory(staging);
  try {
    for (const pack of packages) {
      const archivePath = join7(staging, `${pack.name}.tgz`);
      await downloadVerified(fetchImpl, pack.url, archivePath, pack.bytes, {
        kind: "integrity",
        expected: pack.integrity
      }, reporter, "Downloading the search runtime", stallMs);
      reporter.set("verifying", "Unpacking the search runtime");
      const archive = readFileSync4(archivePath);
      const files = readTarGz(archive, (path) => runtimeEntryWanted(pack.name, path, platform));
      if (files.length === 0) {
        throw new BuiltInEmbeddingInstallError("runtime_load_failed", `${pack.name} had no files for ${platform}.`);
      }
      for (const file of files) {
        const target = join7(staging, "node_modules", pack.name, file.path.replace(/^package\//, ""));
        ensureDirectory(dirname8(target));
        writeFileSync2(target, file.data, { mode: file.mode & 493 || 420 });
      }
      rmSync3(archivePath, { force: true });
    }
    const marker = {
      packages: packages.map((pack) => ({ name: pack.name, integrity: pack.integrity }))
    };
    writeFileSync2(join7(staging, RUNTIME_MARKER), `${JSON.stringify(marker, null, 2)}
`);
    rmSync3(runtimeDir, { recursive: true, force: true });
    renameSync3(staging, runtimeDir);
  } catch (error) {
    rmSync3(staging, { recursive: true, force: true });
    throw error;
  }
}
function runtimeEntryWanted(packageName, path, platform) {
  if (!path.startsWith("package/"))
    return false;
  if (packageName !== "onnxruntime-node")
    return true;
  const [os, arch] = platform.split("-");
  if (/\/libonnxruntime\.\d+\.\d+\.\d+\.dylib$/.test(path))
    return false;
  return path === "package/package.json" || path.startsWith("package/dist/") || path.startsWith(`package/bin/napi-v6/${os}/${arch}/`) || path === "package/LICENSE" || path === "package/ThirdPartyNotices.txt";
}
async function downloadVerified(fetchImpl, url, target, expectedBytes, expected, reporter, label, stallMs) {
  const algorithm = expected.kind === "sha256" ? "sha256" : integrityAlgorithm(expected.expected);
  await downloadPinnedFile({
    fetchImpl,
    url,
    target,
    partial: `${target}.partial-${process.pid}-${randomUUID2()}`,
    expectedBytes,
    algorithm,
    digest: expected.kind === "sha256" ? expected.expected : expected.expected.slice(algorithm.length + 1),
    encoding: expected.kind === "sha256" ? "hex" : "base64",
    noun: "built-in search model",
    stallMs,
    verifyTimeoutMs: 10 * 60000,
    keepPartial: false,
    error: (reason, message2) => new BuiltInEmbeddingInstallError(reason, message2),
    onStart: () => reporter.set("downloading", label),
    onProgress: (bytes) => reporter.advance(bytes, label)
  });
}
function integrityAlgorithm(integrity) {
  const algorithm = integrity.split("-", 1)[0];
  if (algorithm !== "sha512" && algorithm !== "sha384" && algorithm !== "sha256") {
    throw new BuiltInEmbeddingInstallError("checksum_mismatch", `Unsupported integrity algorithm ${algorithm}.`);
  }
  return algorithm;
}
function sha256File(path, timeoutMs = 10 * 60000) {
  return new Promise((resolve4, reject) => {
    const hash = createHash2("sha256");
    let settled = false;
    const stream = createReadStream2(path);
    const finish = (error) => {
      if (settled)
        return;
      settled = true;
      clearTimeout(timer);
      if (error) {
        stream.destroy();
        reject(error);
      } else {
        resolve4(hash.digest("hex"));
      }
    };
    const timer = setTimeout(() => finish(new BuiltInEmbeddingInstallError("checksum_mismatch", `Checking ${path} did not finish within ${Math.round(timeoutMs / 60000)} min.`)), timeoutMs);
    stream.on("data", (chunk) => hash.update(chunk)).on("error", (error) => finish(error)).on("end", () => finish()).on("close", () => finish(new Error(`Reading ${path} stopped before the end.`)));
  });
}
async function withInstallLock(lockPath, waitMs, run) {
  const deadline = Date.now() + waitMs;
  for (;; ) {
    if (tryAcquireLock(lockPath))
      break;
    if (Date.now() > deadline) {
      throw new BuiltInEmbeddingInstallError("download_failed", "Another Olympus process is still installing the built-in search model.");
    }
    await new Promise((resolve4) => setTimeout(resolve4, LOCK_POLL_MS));
  }
  try {
    await run();
  } finally {
    rmSync3(lockPath, { force: true });
  }
}
function tryAcquireLock(lockPath) {
  try {
    const fd = openSync5(lockPath, "wx", 384);
    writeSync2(fd, JSON.stringify({ pid: process.pid, at: Date.now() }));
    closeSync5(fd);
    return true;
  } catch {
    if (lockIsStale(lockPath)) {
      rmSync3(lockPath, { force: true });
      return tryAcquireLock(lockPath);
    }
    return false;
  }
}
function lockIsStale(lockPath) {
  try {
    const holder = JSON.parse(readFileSync4(lockPath, "utf8"));
    if (typeof holder.at === "number" && Date.now() - holder.at > STALE_LOCK_MS)
      return true;
    if (typeof holder.pid === "number" && holder.pid !== process.pid) {
      try {
        process.kill(holder.pid, 0);
        return false;
      } catch (error) {
        return error.code === "ESRCH";
      }
    }
    return false;
  } catch {
    try {
      return Date.now() - statSync3(lockPath).mtimeMs > STALE_LOCK_MS;
    } catch {
      return true;
    }
  }
}
function ensureDirectory(path) {
  try {
    mkdirSync4(path, { recursive: true, mode: 448 });
  } catch (error) {
    throw new BuiltInEmbeddingInstallError("disk_write_failed", `Could not create ${path}: ${String(error)}`);
  }
}

class ProgressReporter {
  statusPath;
  modelId;
  now;
  listener;
  status;
  lastWriteMs;
  constructor(statusPath, modelId, now, listener) {
    this.statusPath = statusPath;
    this.modelId = modelId;
    this.now = now ?? (() => new Date);
    this.listener = listener;
    this.lastWriteMs = 0;
    let previouslyReady = false;
    try {
      const previous = JSON.parse(readFileSync4(statusPath, "utf8"));
      previouslyReady = previous.modelId === modelId && (previous.state === "ready" || previous.previouslyReady === true);
    } catch {}
    this.status = {
      ...previouslyReady ? { previouslyReady: true } : {},
      state: "not_started",
      modelId,
      percent: 0,
      label: "",
      bytesDone: 0,
      bytesTotal: 0,
      updatedAt: this.now().toISOString()
    };
  }
  begin(bytesTotal) {
    this.status = { ...this.status, bytesTotal, bytesDone: 0 };
    this.set("downloading", "Downloading the built-in search model", 0);
  }
  advance(bytes, label) {
    const bytesDone = this.status.bytesDone + bytes;
    const percent = this.status.bytesTotal > 0 ? Math.min(99, Math.floor(bytesDone / this.status.bytesTotal * 100)) : 0;
    this.status = { ...this.status, bytesDone, percent, label, state: "downloading" };
    this.emit(false);
  }
  set(state, label, percent = this.status.percent) {
    const { failure: _failure, ...rest } = this.status;
    this.status = { ...rest, state, label, percent, ...state === "ready" ? { previouslyReady: true } : {} };
    this.emit(true);
  }
  touch() {
    if (this.status.state === "downloading")
      this.set("verifying", "Checking the built-in search model", 99);
  }
  fail(reason, message2) {
    this.status = {
      ...this.status,
      state: "failed",
      label: "The built-in search model could not be installed",
      failure: { reason, message: message2 }
    };
    this.emit(true);
  }
  emit(force) {
    const nowMs = this.now().getTime();
    this.status = { ...this.status, modelId: this.modelId, updatedAt: new Date(nowMs).toISOString() };
    this.listener?.(this.status);
    if (!force && nowMs - this.lastWriteMs < PROGRESS_WRITE_INTERVAL_MS)
      return;
    this.lastWriteMs = nowMs;
    try {
      mkdirSync4(dirname8(this.statusPath), { recursive: true, mode: 448 });
      const temporary = `${this.statusPath}.${process.pid}.tmp`;
      writeFileSync2(temporary, `${JSON.stringify(this.status)}
`, { mode: 384 });
      renameSync3(temporary, this.statusPath);
    } catch {}
  }
}

// src/workers/source-index/built-in-embedding/provider.ts
import { isMainThread as isMainThread4 } from "node:worker_threads";
import { createHash as createHash3 } from "node:crypto";
import { readFileSync as readFileSync9 } from "node:fs";
import { availableParallelism } from "node:os";
import { dirname as dirname11, join as join11 } from "node:path";

// src/core/operation-error.ts
class OperationError extends Error {
  code;
  suggestion;
  constructor(code, message2, suggestion) {
    super(message2);
    this.name = "OperationError";
    this.code = code;
    this.suggestion = suggestion;
  }
  toJSON() {
    return {
      error: this.code,
      message: this.message,
      ...this.suggestion ? { suggestion: this.suggestion } : {}
    };
  }
}

// src/workers/source-index/embedding-identity.ts
var PROVIDER_REPORTED_DIMENSION_TOKEN = "provider-reported";
var EMBEDDING_PROVIDER_FAMILIES = [
  {
    providerKind: "local-openai-compatible",
    epochProviderToken: "openai-compatible",
    dimensionToken: "declared"
  },
  {
    providerKind: "google-gemini",
    epochProviderToken: "google-gemini",
    dimensionToken: PROVIDER_REPORTED_DIMENSION_TOKEN
  },
  {
    providerKind: "venice",
    epochProviderToken: "venice",
    dimensionToken: "declared"
  },
  {
    providerKind: "built-in",
    epochProviderToken: "built-in",
    dimensionToken: "declared"
  }
];
function embeddingProviderFamily(providerKind) {
  return declaredEmbeddingProviderFamily(providerKind) ?? { providerKind, epochProviderToken: providerKind, dimensionToken: "declared" };
}
function declaredEmbeddingProviderFamily(providerKind) {
  return EMBEDDING_PROVIDER_FAMILIES.find((family) => family.providerKind === providerKind);
}
function buildEmbeddingEpoch(input) {
  const family = embeddingProviderFamily(input.provider);
  const dimension = family.dimensionToken === PROVIDER_REPORTED_DIMENSION_TOKEN ? PROVIDER_REPORTED_DIMENSION_TOKEN : declaredDimensionToken(input.dimension);
  return `${input.backend}:${family.epochProviderToken}:${input.modelId}:${dimension}`;
}
function declaredDimensionToken(dimension) {
  return dimension !== undefined && Number.isSafeInteger(dimension) && dimension >= 1 ? String(dimension) : PROVIDER_REPORTED_DIMENSION_TOKEN;
}
function canonicalIdentity(input) {
  return { ...input, epochId: buildEmbeddingEpoch(input) };
}
var CANONICAL_EMBEDDING_IDENTITIES = [
  canonicalIdentity({
    provider: "local-openai-compatible",
    modelId: "secure-local-qwen3-embed",
    backend: "local",
    dimension: 2560
  }),
  canonicalIdentity({
    provider: "google-gemini",
    modelId: "gemini-embedding-2",
    backend: "cloud",
    dimension: 3072
  }),
  canonicalIdentity({
    provider: "venice",
    modelId: "text-embedding-qwen3-8b",
    backend: "cloud",
    dimension: 4096
  }),
  canonicalIdentity({
    provider: "built-in",
    modelId: "arctic-embed-m-v1.5-int8-e58a8f7",
    backend: "local",
    dimension: 768
  }),
  canonicalIdentity({
    provider: "built-in",
    modelId: "embeddinggemma-2-litert-24d962e",
    backend: "local",
    dimension: 768
  })
];
function canonicalEmbeddingIdentityForModel(modelId) {
  return CANONICAL_EMBEDDING_IDENTITIES.find((identity) => identity.modelId === modelId);
}
function resolveEmbeddingEpoch(input) {
  const derived = buildEmbeddingEpoch(input);
  const override = input.epochOverride?.trim();
  if (!override || override === derived)
    return derived;
  if (!declaredEmbeddingProviderFamily(input.provider))
    return override;
  const [overrideBackend, , overrideModelId] = override.split(":");
  if ((overrideBackend === "local" || overrideBackend === "cloud") && overrideBackend !== input.backend) {
    throw refusedEmbeddingEpoch(override, input, `it names the ${overrideBackend} backend`);
  }
  if (overrideModelId !== undefined && overrideModelId !== input.modelId && canonicalEmbeddingIdentityForModel(overrideModelId)) {
    throw refusedEmbeddingEpoch(override, input, `it names the model ${overrideModelId}`);
  }
  const contaminated = contaminatedEmbeddingEpoch(input.modelId, override);
  if (contaminated) {
    throw refusedEmbeddingEpoch(override, input, `it is a known contaminated epoch (${contaminated.origin})`);
  }
  return override;
}
function refusedEmbeddingEpoch(override, input, because) {
  return new OperationError("config_error", `Embedding epoch "${override}" cannot label ${input.backend} provider ${input.provider} ` + `model ${input.modelId}: ${because}.`, "An epoch names the vectors a specific provider minted. Configure a per-provider epoch " + "instead of sharing one variable across the local and cloud embedding lanes.");
}
var KNOWN_CONTAMINATED_EMBEDDING_EPOCHS = [
  {
    modelId: "secure-local-qwen3-embed",
    epochId: "local:local-openai-compatible:secure-local-qwen3-embed:2560",
    origin: "code default before the provider token was pinned (dimension configured)"
  },
  {
    modelId: "secure-local-qwen3-embed",
    epochId: "local:local-openai-compatible:secure-local-qwen3-embed:provider-reported",
    origin: "code default before the provider token was pinned (dimension unconfigured)"
  },
  {
    modelId: "gemini-embedding-2",
    epochId: "local:openai-compatible:secure-local-qwen3-embed:2560",
    origin: "provider-blind OLYMPUS_SOURCE_INDEX_EMBEDDING_EPOCH stamped onto a Gemini provider"
  },
  {
    modelId: "gemini-embedding-2",
    epochId: "local:local-openai-compatible:secure-local-qwen3-embed:provider-reported",
    origin: "provider-blind local code-default epoch stamped onto a Gemini provider"
  },
  {
    modelId: "gemini-embedding-2",
    epochId: "cloud:google-gemini:gemini-embedding-2:3072",
    origin: "derived Gemini epoch drift after output dimensionality became required (2026-08-17)"
  }
];
function contaminatedEmbeddingEpoch(modelId, epochId) {
  return KNOWN_CONTAMINATED_EMBEDDING_EPOCHS.find((entry) => entry.modelId === modelId && entry.epochId === epochId);
}

// src/core/media-cache.ts
import {
  chmodSync,
  closeSync as closeSync6,
  existsSync as existsSync7,
  fsyncSync as fsyncSync2,
  mkdirSync as mkdirSync5,
  lstatSync as lstatSync3,
  openSync as openSync6,
  readFileSync as readFileSync5,
  readdirSync as readdirSync3,
  realpathSync as realpathSync2,
  renameSync as renameSync4,
  rmSync as rmSync4,
  rmdirSync,
  statSync as statSync4,
  writeFileSync as writeFileSync3
} from "node:fs";
import { basename as basename3, dirname as dirname9, isAbsolute as isAbsolute7, join as join8, resolve as resolve4 } from "node:path";

// connect-relay/shared/directory-tools.ts
var DEMO_GRANT_REMOTE_TOOLS = Object.freeze(["olympus_search", "source_index_status"]);
var DIRECTORY_TOOL_NAMES = Object.freeze([
  "olympus_dashboard",
  "olympus_search",
  "source_index_status",
  "source_answer",
  "source_answer_result",
  "ask_anonymously",
  "open_private_question",
  "olympus_connect_source",
  "olympus_scope_list",
  "olympus_scope_set",
  "olympus_disconnect_source",
  "olympus_delete_source_data",
  "olympus_model_set",
  "olympus_model_retry",
  "olympus_privacy_get",
  "olympus_privacy_set",
  "olympus_privacy_questions",
  "olympus_privacy_check",
  "olympus_sync_source"
]);
var DIRECTORY_TOOLS = new Set(DIRECTORY_TOOL_NAMES);

// src/core/remote-public-url.ts
var LOOPBACK_HOSTNAMES = new Set(["127.0.0.1", "localhost", "[::1]"]);

// src/core/remote-access.ts
var LOOPBACK_HOSTNAMES2 = new Set(["127.0.0.1", "localhost", "[::1]"]);

// src/core/archive-formats.ts
var FROM_LINE = [70, 114, 111, 109, 32];
function startsWithFromLine(head) {
  if (!head || head.length < FROM_LINE.length)
    return false;
  return FROM_LINE.every((byte, index) => head[index] === byte);
}
var MBOX_ARCHIVE_FORMAT = Object.freeze({
  id: "mbox",
  label: "Mail (mbox)",
  family: "email",
  provider: "mbox",
  chooseHint: "a mail export (an .mbox file from Google Takeout or Thunderbird, or an .mbox folder from Apple Mail)",
  citationLabel: "Imported mail",
  exportGuide: Object.freeze({
    title: "Gmail, from Google Takeout",
    provider: "Google",
    steps: Object.freeze([
      { title: "Choose your mail", instructions: ["Choose **Deselect all**.", "Scroll to **Mail** and tick it.", "Choose **Next step** at the bottom of the page."], link: { label: "Google Takeout", url: "https://takeout.google.com/" } },
      { title: "Ask for the export", instructions: ["Keep **Send download link via email** and **Export once**.", "Keep **.zip** as the file type.", "Choose **Create export**."] }
    ]),
    ready: "Google emails you a download link when the export is ready. Download it, open the zip, and drop the .mbox file from its Mail folder."
  }),
  detect(probe) {
    if (probe.chosen.kind === "file")
      return startsWithFromLine(probe.chosen.head) ? [""] : undefined;
    if (!probe.chosen.name.toLowerCase().endsWith(".mbox"))
      return;
    const inner = probe.children.find((entry) => entry.kind === "file" && entry.name === "mbox" && startsWithFromLine(entry.head));
    return inner ? [inner.relPath] : undefined;
  }
});
var WHATSAPP_DATE = String.raw`\d{1,4}[./-]\s?\d{1,2}[./-]\s?\d{1,4}`;
var WHATSAPP_TIME = String.raw`\d{1,2}[:.]\d{2}(?:[:.]\d{2})?(?:\s?[ap]\.?\s?m\.?)?`;
var WHATSAPP_FIRST_LINE = new RegExp(`^(?:\\[\\s?${WHATSAPP_DATE},?\\s+${WHATSAPP_TIME}\\s?\\]|${WHATSAPP_DATE},?\\s+${WHATSAPP_TIME}\\s[-\\u2013]\\s)`, "i");
var WHATSAPP_LINE_NOISE = new RegExp("[\\u200e\\u200f\\u202a-\\u202e\\u2066-\\u2069\\ufeff]", "g");
var WHATSAPP_NARROW_SPACES = new RegExp("[\\u00a0\\u202f\\u2007\\u2009]", "g");
var WHATSAPP_TEXT_NAME = /^(?:_chat|whatsapp chat (?:with|-)\s+\S.*)\.txt$/i;
function lastNameOf(name) {
  return name.split("/").pop() ?? name;
}
function whatsAppNoiseName(name) {
  const base = lastNameOf(name);
  return name.endsWith("/") || name.startsWith("__MACOSX/") || name.includes("/__MACOSX/") || base.startsWith("._") || base === ".DS_Store";
}
function whatsAppNamed(name) {
  return !whatsAppNoiseName(name) && WHATSAPP_TEXT_NAME.test(lastNameOf(name));
}
function startsLikeWhatsAppChat(head) {
  if (!head || head.length < 10 || head.includes(0))
    return false;
  for (const raw of new TextDecoder("utf-8").decode(head).split(`
`).slice(0, 8)) {
    const line = raw.replace(WHATSAPP_LINE_NOISE, "").replace(WHATSAPP_NARROW_SPACES, " ").replace(/\r$/, "");
    if (line.trim() === "")
      continue;
    return WHATSAPP_FIRST_LINE.test(line);
  }
  return false;
}
function whatsAppIsExport(entry, needName) {
  if (entry.kind !== "file")
    return false;
  if (entry.members) {
    return entry.members.some((member) => member.kind === "file" && !whatsAppNoiseName(member.relPath) && member.relPath.toLowerCase().endsWith(".txt") && (!needName || whatsAppNamed(member.relPath)) && startsLikeWhatsAppChat(member.head));
  }
  return entry.name.toLowerCase().endsWith(".txt") && (!needName || whatsAppNamed(entry.name)) && startsLikeWhatsAppChat(entry.head);
}
var WHATSAPP_ARCHIVE_FORMAT = Object.freeze({
  id: "whatsapp_chat",
  label: "WhatsApp chat export",
  family: "chat",
  provider: "whatsapp_export",
  chooseHint: "a WhatsApp chat export (the .zip or the text file from Export Chat, or a folder of them)",
  citationLabel: "WhatsApp",
  probeNames: Object.freeze(["*.txt", "*.zip"]),
  signatureNames: Object.freeze(["_chat.txt", "WhatsApp Chat with *.txt", "WhatsApp Chat - *.txt", "WhatsApp Chat*.zip"]),
  exportGuide: Object.freeze({
    title: "A WhatsApp chat",
    provider: "WhatsApp",
    steps: Object.freeze([
      { title: "Open the chat", instructions: ["On your phone, open WhatsApp and the chat you want.", "Tap the chat's name at the top (on Android, tap **⋮** then **More**)."] },
      { title: "Export it", instructions: ["Choose **Export chat**.", "Choose **Attach media** (on Android, **Include media**) to keep photos and voice notes, or **Without media** for a smaller file.", "Send the file to this computer, for example by AirDrop or to yourself by email."] }
    ]),
    ready: "WhatsApp makes the file straight away. Drop the .zip or the .txt file it sent."
  }),
  detect(probe) {
    if (probe.chosen.kind === "file")
      return whatsAppIsExport(probe.chosen, false) ? [""] : undefined;
    const found = probe.children.filter((entry) => whatsAppIsExport(entry, true)).map((entry) => entry.relPath).sort();
    return found.length > 0 ? found : undefined;
  },
  unconfirmed(probe) {
    if (probe.chosen.kind === "file")
      return 0;
    return probe.children.filter((entry) => !whatsAppIsExport(entry, true) && whatsAppIsExport(entry, false)).length;
  }
});
var leniencyDecoder = new TextDecoder("utf-8");
function archiveHeadText(head) {
  return head && head.length > 0 ? leniencyDecoder.decode(head) : "";
}
function isJunkArchiveMember(name) {
  const parts = name.split("/").filter((part) => part !== "");
  return parts.includes("__MACOSX") || (parts[parts.length - 1] ?? "").startsWith(".");
}
var WEEKDAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];
var MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
var DAILY_NOTE_FILE = /^([a-z]+),?\s+([a-z]+)\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})(?:\.(?:md|markdown))?$/i;
function reflectDailyNoteDate(fileName) {
  const match = DAILY_NOTE_FILE.exec(fileName.trim());
  if (!match)
    return;
  const weekday = match[1].slice(0, 3).toLowerCase();
  const month = MONTHS.indexOf(match[2].slice(0, 3).toLowerCase());
  const day = Number(match[3]);
  const year = Number(match[4]);
  if (!WEEKDAYS.includes(weekday) || month < 0 || day < 1 || day > 31)
    return;
  const at = new Date(Date.UTC(year, month, day, 12));
  return at.getUTCMonth() === month && at.getUTCDate() === day ? at.toISOString() : undefined;
}
var REFLECT_NOTES_LIST_KEY = "notes";
function headRecordKeys(head) {
  const text = archiveHeadText(head);
  const n = text.length;
  let i = 0;
  const isSpace = (char) => char === " " || char === "\t" || char === `
` || char === "\r";
  while (i < n && isSpace(text[i]))
    i += 1;
  const stack = [];
  let shape;
  let listDepth = 0;
  let closed = false;
  let hasElements = false;
  let objectRoot = false;
  let notesNotAList = false;
  if (text[i] === "[") {
    shape = "list";
    listDepth = 1;
    stack.push("a");
  } else if (text[i] === "{") {
    objectRoot = true;
    stack.push("o");
  } else {
    return;
  }
  i += 1;
  const records = [];
  let current;
  while (i < n) {
    const char = text[i];
    if (listDepth > 0 && stack.length === listDepth && !isSpace(char) && char !== "," && char !== "]")
      hasElements = true;
    if (char === '"') {
      let end = i + 1;
      while (end < n && text[end] !== '"')
        end += text[end] === "\\" ? 2 : 1;
      if (end >= n)
        break;
      const raw = text.slice(i + 1, end);
      let after = end + 1;
      while (after < n && isSpace(text[after]))
        after += 1;
      if (text[after] === ":" && stack[stack.length - 1] === "o") {
        if (listDepth > 0 && stack.length === listDepth + 1) {
          current?.add(raw);
        } else if (shape === undefined && stack.length === 1 && raw === REFLECT_NOTES_LIST_KEY) {
          let value = after + 1;
          while (value < n && isSpace(text[value]))
            value += 1;
          if (text[value] === "[") {
            shape = "notes";
            listDepth = 2;
          } else if (value < n) {
            notesNotAList = true;
          }
        }
      }
      i = end + 1;
      continue;
    }
    if (char === "[" || char === "{") {
      stack.push(char === "[" ? "a" : "o");
      if (char === "{" && listDepth > 0 && stack.length === listDepth + 1) {
        current = new Set;
        records.push(current);
      }
    } else if (char === "]" || char === "}") {
      stack.pop();
      if (listDepth > 0 && stack.length < listDepth) {
        closed = true;
        listDepth = 0;
      }
      if (stack.length === 0)
        break;
      if (listDepth > 0 && stack.length === listDepth)
        current = undefined;
    }
    i += 1;
  }
  if (!shape) {
    if (objectRoot && !notesNotAList && stack.length > 0) {
      return { shape: "notes", records: [], empty: false, firstRecordCut: true, unreached: true };
    }
    return;
  }
  const open = listDepth > 0;
  return { shape, records, empty: closed && !hasElements, firstRecordCut: open && records.length === 1 && current !== undefined, unreached: false };
}
var REFLECT_BODY_KEYS = ["content", "body", "document_json", "documentJson"];
var REFLECT_NOTE_KEYS = ["subject", "title", "created_at", "createdAt", "updated_at", "updatedAt"];
var ROAM_TIME_KEYS = ["create-time", "edit-time", "create-email", "edit-email"];
function isReflectRecord(keys) {
  return REFLECT_BODY_KEYS.some((key) => keys.has(key)) && REFLECT_NOTE_KEYS.some((key) => keys.has(key));
}
function isRoamRecord(keys) {
  return keys.has("title") && (ROAM_TIME_KEYS.some((key) => keys.has(key)) || keys.has("children") && keys.has("uid"));
}
function isChatGptConversation(keys) {
  return keys.has("mapping") && (keys.has("current_node") || keys.has("create_time") || keys.has("title"));
}
function isClaudeConversation(keys) {
  return keys.has("chat_messages") && (keys.has("uuid") || keys.has("name") || keys.has("created_at"));
}
var JSON_EXPORT_RECORDS = [
  ["reflect", isReflectRecord],
  ["roam", isRoamRecord],
  ["chatgpt", isChatGptConversation],
  ["claude", isClaudeConversation]
];
function anyJsonExportRecord(keys) {
  return JSON_EXPORT_RECORDS.some(([, is]) => is(keys));
}
function recordsFormat(records, shape) {
  const found = JSON_EXPORT_RECORDS.filter(([, is]) => records.some(is)).map(([kind]) => kind);
  if (found.length !== 1)
    return;
  const only = found[0];
  return only === "reflect" || shape === "list" ? only : undefined;
}
function jsonExportFormat(probe) {
  const parsed = headRecordKeys(probe.head);
  if (!parsed)
    return;
  const fromHead = recordsFormat(parsed.records, parsed.shape);
  if (fromHead || !parsed.firstRecordCut || !probe.firstRecordKeys)
    return fromHead;
  let scanned = SCANNED.get(probe);
  if (!scanned) {
    const keys = probe.firstRecordKeys(parsed.shape === "list" ? [] : [REFLECT_NOTES_LIST_KEY], anyJsonExportRecord);
    scanned = { keys };
    SCANNED.set(probe, scanned);
  }
  return scanned.keys ? recordsFormat([scanned.keys], parsed.shape) : undefined;
}
var SCANNED = new WeakMap;
function detectFile(probe, reads) {
  if (probe.chosen.kind === "file")
    return reads(probe.chosen) ? [""] : undefined;
  const found = probe.children.filter((entry) => entry.kind === "file" && !isJunkArchiveMember(entry.name) && reads(entry));
  return found.length === 1 ? [found[0].relPath] : undefined;
}
function zipJsonMembers(entry) {
  return (entry.members ?? []).filter((member) => member.kind === "file" && /\.json$/i.test(member.name) && !isJunkArchiveMember(member.relPath));
}
function readsJsonExport(entry, format) {
  if (entry.members) {
    const members = zipJsonMembers(entry).map((member) => jsonExportFormat(member)).filter((kind) => kind !== undefined);
    return members.includes(format) && members.every((kind) => kind === format);
  }
  return jsonExportFormat(entry) === format;
}
var REFLECT_JSON_ARCHIVE_FORMAT = Object.freeze({
  id: "reflect-json",
  label: "Reflect notes (JSON)",
  family: "note",
  provider: "reflect",
  chooseHint: "a Reflect export in JSON (the .json file, or the .zip that holds it)",
  citationLabel: "Reflect",
  sourceCard: Object.freeze({ id: "reflect.archive", label: "Reflect" }),
  probeNames: Object.freeze(["*.json"]),
  exportGuide: Object.freeze({
    title: "Reflect",
    provider: "Reflect",
    steps: Object.freeze([
      { title: "Export your notes", instructions: ["In Reflect, open **Settings**.", "Find the export option and choose **JSON** (Markdown works too).", "Save the file in **Downloads**."], link: { label: "Reflect", url: "https://reflect.app/" } }
    ]),
    ready: "Drop the .json file, or the .zip Reflect saved."
  }),
  detect: (probe) => detectFile(probe, (entry) => readsJsonExport(entry, "reflect"))
});
var REFLECT_MARKDOWN_ARCHIVE_FORMAT = Object.freeze({
  id: "reflect-markdown",
  label: "Reflect notes (Markdown zip)",
  family: "note",
  provider: "reflect",
  chooseHint: "a Reflect export as Markdown (the .zip file)",
  citationLabel: "Reflect",
  sourceCard: Object.freeze({ id: "reflect.archive", label: "Reflect" }),
  probeNames: Object.freeze(["*, *, ????.md"]),
  detect: (probe) => detectFile(probe, (entry) => {
    if (!entry.members || /^roam/i.test(entry.name))
      return false;
    const files = entry.members.filter((member) => member.kind === "file" && !isJunkArchiveMember(member.relPath));
    if (files.some((member) => /\.json$/i.test(member.name)))
      return false;
    const notes = files.filter((member) => /\.(?:md|markdown)$/i.test(member.name));
    if (notes.length === 0)
      return false;
    return /reflect/i.test(entry.name) || notes.some((member) => reflectDailyNoteDate(member.name) !== undefined) || notes.some((member) => /reflect\.app\//i.test(archiveHeadText(member.head)));
  })
});
var ROAM_JSON_ARCHIVE_FORMAT = Object.freeze({
  id: "roam-json",
  label: "Roam notes (JSON)",
  family: "note",
  provider: "roam",
  chooseHint: "a Roam export in JSON (the .json file from Export All, or the .zip that holds it)",
  citationLabel: "Roam",
  sourceCard: Object.freeze({ id: "roam.archive", label: "Roam" }),
  probeNames: Object.freeze(["*.json"]),
  exportGuide: Object.freeze({
    title: "Roam",
    provider: "Roam",
    steps: Object.freeze([
      { title: "Export your graph", instructions: ["Open your graph in Roam.", "Choose **⋯** at the top right, then **Export All**.", "Set the format to **JSON** and choose **Export All**."], link: { label: "Roam", url: "https://roamresearch.com/" } }
    ]),
    ready: "Drop the .zip Roam saved, or the .json file inside it."
  }),
  detect: (probe) => detectFile(probe, (entry) => readsJsonExport(entry, "roam"))
});
function detectFiles(probe, reads) {
  if (probe.chosen.kind === "file")
    return reads(probe.chosen) ? [""] : undefined;
  const found = probe.children.filter((entry) => entry.kind === "file" && !isJunkArchiveMember(entry.name) && reads(entry)).map((entry) => entry.relPath).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  return found.length > 0 ? found : undefined;
}
var AI_CONVERSATION_NAMES = Object.freeze(["conversations.json", "conversations-*.json"]);
var CHATGPT_ARCHIVE_FORMAT = Object.freeze({
  id: "chatgpt-export",
  label: "ChatGPT conversations (data export)",
  family: "chat",
  provider: "chatgpt_export",
  chooseHint: "a ChatGPT data export (the .zip from Settings, Data controls, Export data, or the conversations.json in it)",
  citationLabel: "ChatGPT",
  probeNames: Object.freeze(["*.json"]),
  signatureNames: AI_CONVERSATION_NAMES,
  detect: (probe) => detectFiles(probe, (entry) => readsJsonExport(entry, "chatgpt"))
});
var CLAUDE_ARCHIVE_FORMAT = Object.freeze({
  id: "claude-export",
  label: "Claude conversations (data export)",
  family: "chat",
  provider: "claude_export",
  chooseHint: "a Claude data export (the .zip from Settings, Privacy, Export data, or the conversations.json in it)",
  citationLabel: "Claude",
  probeNames: Object.freeze(["*.json"]),
  signatureNames: AI_CONVERSATION_NAMES,
  detect: (probe) => detectFiles(probe, (entry) => readsJsonExport(entry, "claude"))
});
function looksLikeEnex(head) {
  const text = archiveHeadText(head).replace(/^\ufeff/, "");
  const start = /^\s*(?:<\?xml[\s\S]*?\?>)?(?:\s*<!--[\s\S]*?-->)*\s*(?:<!DOCTYPE\s+([A-Za-z_][\w.:-]*)|<([A-Za-z_][\w.:-]*))/i.exec(text);
  return start !== null && (start[1] ?? start[2]) === "en-export";
}
var EVERNOTE_ENEX_ARCHIVE_FORMAT = Object.freeze({
  id: "evernote-enex",
  label: "Evernote export (.enex)",
  family: "note",
  provider: "evernote",
  chooseHint: "an Evernote export (the .enex file, or a folder of them)",
  citationLabel: "Evernote",
  sourceCard: Object.freeze({ id: "evernote.notes", label: "Evernote" }),
  probeNames: Object.freeze(["*.enex"]),
  exportGuide: Object.freeze({
    title: "Evernote",
    provider: "Evernote",
    steps: Object.freeze([
      { title: "Open the Evernote app", instructions: ["Export works in the Evernote app on a computer, not on the web.", "Install it if you do not have it, and sign in."], link: { label: "Evernote", url: "https://evernote.com/download" } },
      { title: "Export a notebook", instructions: ["In **Notebooks**, choose **⋯** beside a notebook.", "Choose **Export notebook…** and keep the **ENEX** format.", "Save the file. Repeat for each notebook you want."] }
    ]),
    ready: "Drop the .enex file, or a folder holding several."
  }),
  detect(probe) {
    if (probe.chosen.kind === "file")
      return looksLikeEnex(probe.chosen.head) ? [""] : undefined;
    const files = probe.children.filter((entry) => entry.kind === "file" && !isJunkArchiveMember(entry.name) && looksLikeEnex(entry.head)).map((entry) => entry.relPath).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
    return files.length > 0 ? files : undefined;
  }
});
var JSON_STRING = String.raw`"(?:[^"\\]|\\.)*"`;
var TELEGRAM_EXPORT_SECTIONS = Object.freeze([
  "personal_information",
  "profile_pictures",
  "stories",
  "profile_music",
  "contacts",
  "frequent_contacts",
  "sessions",
  "web_sessions",
  "other_data",
  "chats",
  "left_chats"
]);
var TELEGRAM_FULL_HEAD = new RegExp(String.raw`^\s*\{\s*(?:"about"\s*:\s*${JSON_STRING}\s*,\s*)?"(?:${TELEGRAM_EXPORT_SECTIONS.join("|")})"\s*:\s*[\[{]`);
var TELEGRAM_CHAT_HEAD = new RegExp(String.raw`^\s*\{\s*(?:"name"\s*:\s*(?:null|${JSON_STRING})\s*,\s*)?"type"\s*:\s*(?:null|${JSON_STRING})\s*,\s*"id"\s*:\s*-?\d+\s*,\s*"messages"\s*:\s*\[`);
var TELEGRAM_HTML_NAME = /^(?:messages\d*|export_results)\.html?$/i;
function isTelegramJsonHead(head) {
  if (!head || head.length === 0)
    return false;
  const text = new TextDecoder("utf-8").decode(head);
  return TELEGRAM_FULL_HEAD.test(text) || TELEGRAM_CHAT_HEAD.test(text);
}
var TELEGRAM_JSON_ARCHIVE_FORMAT = Object.freeze({
  id: "telegram_json",
  label: "Telegram Desktop export (JSON)",
  family: "chat",
  provider: "telegram_export",
  chooseHint: "a Telegram Desktop export (its result.json file, or the folder that holds it; export it as Machine-readable JSON)",
  citationLabel: "Telegram",
  probeNames: ["result.json", "messages.html", "export_results.html"],
  unsupportedVariants: Object.freeze([
    Object.freeze({
      matches(probe) {
        if (probe.chosen.kind === "file")
          return TELEGRAM_HTML_NAME.test(probe.chosen.name);
        return probe.children.some((entry) => entry.kind === "file" && TELEGRAM_HTML_NAME.test(entry.name));
      },
      advice: "This looks like a Telegram Desktop export in its HTML form, which Olympus cannot read. In Telegram Desktop, export again (Settings, Advanced, Export Telegram data, or Export chat history in a chat's menu) and set the format to Machine-readable JSON, or Both. Then choose the new result.json or the folder that holds it."
    })
  ]),
  exportGuide: Object.freeze({
    title: "Telegram",
    provider: "Telegram",
    steps: Object.freeze([
      { title: "Open Telegram Desktop", instructions: ["Export works in Telegram Desktop, not in the phone app.", "Install it if you do not have it, and sign in."], link: { label: "Telegram Desktop", url: "https://desktop.telegram.org/" } },
      { title: "Ask for the export", instructions: ["Open **Settings**, then **Advanced**.", "Choose **Export Telegram data**.", "Tick the chats you want and set the format to **Machine-readable JSON**.", "Choose **Export**. Telegram may ask you to confirm on your phone and wait before it starts."] }
    ]),
    ready: "Drop the folder Telegram saved, or the result.json file in it."
  }),
  detect(probe) {
    if (probe.chosen.kind === "file")
      return isTelegramJsonHead(probe.chosen.head) ? [""] : undefined;
    const inner = probe.children.find((entry) => entry.kind === "file" && entry.name.toLowerCase() === "result.json" && isTelegramJsonHead(entry.head));
    return inner ? [inner.relPath] : undefined;
  }
});
var ARCHIVE_FORMATS = Object.freeze([
  MBOX_ARCHIVE_FORMAT,
  WHATSAPP_ARCHIVE_FORMAT,
  REFLECT_JSON_ARCHIVE_FORMAT,
  REFLECT_MARKDOWN_ARCHIVE_FORMAT,
  ROAM_JSON_ARCHIVE_FORMAT,
  TELEGRAM_JSON_ARCHIVE_FORMAT,
  EVERNOTE_ENEX_ARCHIVE_FORMAT,
  CHATGPT_ARCHIVE_FORMAT,
  CLAUDE_ARCHIVE_FORMAT
]);
var CONNECTOR_FACTORIES = new Map;

// src/workers/file-extraction/extractors/image-preparers.ts
var MAX_PREPARED_BYTES = 16 * 1024 * 1024;

// src/core/still-image-formats.ts
var HEIC_BRANDS = new Set([
  "heic",
  "heix",
  "heim",
  "heis",
  "hevc",
  "hevx",
  "hevm",
  "hevs",
  "mif1",
  "msf1",
  "heif"
]);
var IMAGE_MAX_DECLARED_PIXELS = 16384 * 16384;

// src/core/still-image-readiness.ts
var clock = Date.now;

// src/core/media-cache.ts
var MEDIA_CACHE_ORPHAN_AGE_MS = 24 * 60 * 60000;
function isSha256(value) {
  if (value.length !== 64)
    return false;
  for (const character of value) {
    if (!"0123456789abcdef".includes(character))
      return false;
  }
  return true;
}
var MEDIA_CACHE_DIR_NAMES = new Set(["media-cache", "olympus-media"]);
function isMediaCachePath(path, sha256, dir) {
  if (!isAbsolute7(path) || !isSha256(sha256) || resolve4(path) !== path)
    return false;
  if (basename3(path) !== `${sha256}.jpg` || !MEDIA_CACHE_DIR_NAMES.has(basename3(dirname9(path))))
    return false;
  if (dir !== undefined && dirname9(path) !== resolve4(dir))
    return false;
  try {
    const stat2 = lstatSync3(path);
    if (!stat2.isFile())
      return false;
  } catch {}
  return true;
}

// src/workers/source-index/embeddings.ts
import { AsyncLocalStorage } from "node:async_hooks";

// src/core/owner-config-read.ts
import { chmodSync as chmodSync2, linkSync, readFileSync as readFileSync6, statSync as statSync5, lstatSync as lstatSync4 } from "node:fs";
import { randomUUID as randomUUID3 } from "node:crypto";
import { homedir as homedir5 } from "node:os";
import { dirname as dirname10, join as join9 } from "node:path";
function linuxOwnerConfigPath(name, env = process.env) {
  if (process.platform !== "linux")
    return;
  const layout = resolveLinuxEngineLayout(env);
  const owned = !!readLinuxEngineReceipt(layout.receiptPath) || env.OLYMPUS_ENGINE_HOST === "1" || env.OLYMPUS_STANDALONE === "1";
  if (!owned && name !== "sovereignty.json")
    return join9(layout.home, ".olympus", name);
  if (!owned)
    migrateHostedSovereignty(join9(layout.home, ".olympus", name), join9(layout.configDir, name));
  if ((owned ? [name, ...LEGACY_LINUX_POLICY_FILES] : [name]).some((file) => lstatSync4(join9(layout.home, ".olympus", file), { throwIfNoEntry: false }))) {
    throw new Error("Legacy Olympus settings still need migration. Complete the Linux engine upgrade, or back up and migrate an unreceipted installation, before using its settings; existing privacy protections were not ignored.");
  }
  return join9(layout.configDir, name);
}
function migrateHostedSovereignty(legacy, target) {
  if (!lstatSync4(legacy, { throwIfNoEntry: false }))
    return;
  const backup = `${legacy}.pre-xdg-migration.bak`;
  for (const path of [legacy, target, backup])
    assertLinuxManagedPath(path);
  ensurePrivateRootDirectorySync(dirname10(target));
  withFileLeaseSync(legacy, () => withFileLeaseSync(target, (lease) => {
    if (!lstatSync4(legacy, { throwIfNoEntry: false }))
      return;
    for (const path of [legacy, target, backup])
      assertLinuxManagedPath(path);
    const original = readOwnerConfigFile(legacy);
    if (original.status !== "ok")
      throw new Error("Olympus could not safely move your old privacy settings. Your existing settings were kept. Ask the person who installed Olympus to check the file permissions.");
    for (const path of [target, backup]) {
      if (lstatSync4(path, { throwIfNoEntry: false }) && readFileSync6(path, "utf8") !== original.text) {
        throw new Error(`Olympus found different privacy settings at ${path}. Both copies were kept. Ask the person who installed Olympus to choose which settings to keep before restarting.`);
      }
    }
    lease.commit(() => {
      publishOwnerCopy(backup, original.text);
      publishOwnerCopy(target, original.text);
      const current = readOwnerConfigFile(legacy);
      if (current.status !== "ok" || current.stamp !== original.stamp)
        throw new Error("Your old privacy settings changed during migration. Both copies were kept. Restart Olympus to try again.");
      removeFileDurablySync(legacy);
    });
  }));
}
function publishOwnerCopy(path, text) {
  if (lstatSync4(path, { throwIfNoEntry: false })) {
    assertLinuxManagedPath(path);
    if (readFileSync6(path, "utf8") !== text)
      throw new Error(`Olympus found different privacy settings at ${path}. Both copies were kept. Ask the person who installed Olympus to choose which settings to keep before restarting.`);
    chmodSync2(path, 384);
    return;
  }
  const temp = `${path}.${randomUUID3()}.tmp`;
  try {
    writePrivateFileAtomicSync(temp, text);
    linkSync(temp, path);
    syncDirectorySync(dirname10(path));
  } finally {
    removeFileDurablySync(temp);
  }
}
function defaultSovereigntyConfigPath(env = process.env) {
  return linuxOwnerConfigPath("sovereignty.json", env) ?? join9(env.HOME?.trim() || homedir5(), ".olympus", "sovereignty.json");
}
function readOwnerConfigFile(path) {
  let before;
  try {
    before = statSync5(path);
  } catch (error) {
    return error.code === "ENOENT" ? { status: "missing" } : { status: "refused", reason: "unreadable", stamp: "unreadable" };
  }
  const stamp = stampOf(before);
  if (!before.isFile() || (before.mode & 18) !== 0 || !ownedByThisUser(before)) {
    return { status: "refused", reason: "unsafe_permissions", stamp };
  }
  let text;
  try {
    text = readFileSync6(path, "utf8");
  } catch {
    return { status: "refused", reason: "unreadable", stamp };
  }
  let after;
  try {
    after = statSync5(path);
  } catch {
    return { status: "refused", reason: "torn_read", stamp };
  }
  if (stampOf(after) !== stamp || Buffer.byteLength(text, "utf8") !== before.size) {
    return { status: "refused", reason: "torn_read", stamp: stampOf(after) };
  }
  return { status: "ok", text, stamp };
}
function stampOf(stat2) {
  return `${stat2.ino}:${stat2.size}:${stat2.mtimeMs}:${stat2.ctimeMs}`;
}
function ownedByThisUser(stat2) {
  const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
  return uid === undefined || stat2.uid === uid;
}

// src/core/zkapi-consult-settings.ts
import { readFileSync as readFileSync7, statSync as statSync6 } from "node:fs";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
var ZKAPI_DAEMON_DEFAULT_PORT = 8787;
var ZKAPI_DAEMON_DEFAULT_BASE_URL = `http://127.0.0.1:${ZKAPI_DAEMON_DEFAULT_PORT}/v1`;
var ZKAPI_DEFAULT_TOR_SOCKS_PORT = 19050;
var DEFAULTS = {
  tor: "per_consult",
  torSocksPort: ZKAPI_DEFAULT_TOR_SOCKS_PORT,
  timeoutMs: 6 * 60 * 1000,
  torBootstrapTimeoutMs: 210 * 1000,
  daemonReadyTimeoutMs: 120 * 1000,
  policyWarmTimeoutMs: 180 * 1000,
  settleTimeoutMs: 300 * 1000,
  maxResponseBytes: 256 * 1024
};
var INTEGER_BOUNDS = {
  torSocksPort: [1024, 65535],
  dailyRequestCap: [1, 1e6],
  timeoutMs: [30000, 30 * 60000],
  torBootstrapTimeoutMs: [1e4, 10 * 60000],
  daemonReadyTimeoutMs: [5000, 10 * 60000],
  policyWarmTimeoutMs: [5000, 10 * 60000],
  settleTimeoutMs: [5000, 30 * 60000],
  maxResponseBytes: [1024, 4 * 1024 * 1024]
};
var SETTINGS_KEYS = new Set([
  ...Object.keys(INTEGER_BOUNDS),
  "tor",
  "fundingDate",
  "depositUsd",
  "acknowledgements",
  "dailySpendCapUsd",
  "daemonExecutable",
  "torExecutable"
]);
var zkapiDaemonPorts = new Set([ZKAPI_DAEMON_DEFAULT_PORT]);
var policyFile = { seen: undefined, unreadable: undefined };
function sovereigntyPolicyPath(env = process.env) {
  return env.OLYMPUS_SOVEREIGNTY_CONFIG?.trim() || env.OLYMPUS_SOVEREIGNTY_CONFIG_PATH?.trim() || defaultSovereigntyConfigPath(env);
}
function refreshZkapiPortsFromPolicyFile(env = process.env) {
  let path;
  try {
    path = sovereigntyPolicyPath(env);
  } catch {
    policyFile.seen = undefined;
    policyFile.unreadable = "the sovereignty settings (layout discovery refused)";
    return;
  }
  let stamp;
  try {
    const stat2 = statSync6(path);
    stamp = `${path}:${stat2.dev}:${stat2.ino}:${stat2.size}:${stat2.mtimeMs}:${stat2.ctimeMs}`;
  } catch (error) {
    if (error.code === "ENOENT") {
      policyFile.seen = `${path}:absent`;
      policyFile.unreadable = undefined;
    } else {
      policyFile.seen = undefined;
      policyFile.unreadable = path;
    }
    return;
  }
  if (policyFile.seen === stamp && policyFile.unreadable === undefined)
    return;
  try {
    const ports = zkapiPortsInPolicy(JSON.parse(readFileSync7(path, "utf8")));
    for (const port of ports)
      zkapiDaemonPorts.add(port);
    policyFile.seen = stamp;
    policyFile.unreadable = undefined;
  } catch {
    policyFile.seen = undefined;
    policyFile.unreadable = path;
  }
}
function zkapiPortsInPolicy(parsed) {
  const record = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : undefined;
  if (!record)
    throw new Error("not a policy object");
  const inner = record.sovereignty && typeof record.sovereignty === "object" ? record.sovereignty : record;
  const profiles = inner.modelProfiles;
  if (!profiles || typeof profiles !== "object" || Array.isArray(profiles))
    throw new Error("policy has no modelProfiles");
  const ports = [];
  for (const profile of Object.values(profiles)) {
    if (!profile || typeof profile !== "object")
      throw new Error("malformed profile");
    const entry = profile;
    if (entry.provider !== "zkapi")
      continue;
    const port = loopbackPort(typeof entry.baseUrl === "string" ? entry.baseUrl : undefined);
    if (port === undefined)
      throw new Error("zkapi profile without a loopback baseUrl");
    ports.push(port);
  }
  return ports;
}
function endpointPort(parsed) {
  return parsed.port ? Number(parsed.port) : parsed.protocol === "https:" ? 443 : 80;
}
function assertNotZkapiDaemonEndpoint(url, label) {
  refreshZkapiPortsFromPolicyFile();
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:")
    return;
  const port = endpointPort(parsed);
  const local = loopbackPort(url) !== undefined;
  if (local && policyFile.unreadable) {
    throw new ZkapiDaemonEndpointRefusal("policy_unreadable", `${label} is a local endpoint, and the sovereignty policy at ${policyFile.unreadable} cannot be read to rule out a zkAPI daemon on port ${port}.`, policyFile.unreadable);
  }
  if (!zkapiDaemonPorts.has(port))
    return;
  if (local) {
    throw new ZkapiDaemonEndpointRefusal("daemon_port", `${label} points at port ${port}, where a zkAPI daemon serves; it forwards to cloud providers and may never receive evidence.`);
  }
  if (!isIP(parsed.hostname.replace(/^\[|\]$/g, ""))) {
    throw new ZkapiDaemonEndpointRefusal("hostname_on_daemon_port", `${label} names a host on port ${port}, a zkAPI daemon port; a host name could point at this machine.`);
  }
}
async function assertNotZkapiDaemonEndpointResolved(url, label, lookupAll = defaultLookupAll) {
  assertNotZkapiDaemonEndpoint(url, label);
  const unreadable = policyFile.unreadable;
  if (!unreadable)
    return;
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:")
    return;
  const host = parsed.hostname.replace(/^\[|\]$/g, "");
  if (isIP(host))
    return;
  const port = endpointPort(parsed);
  const refuse = () => {
    throw new ZkapiDaemonEndpointRefusal("policy_unreadable", `${label} may be a local endpoint, and the sovereignty policy at ${unreadable} cannot be read to rule out a zkAPI daemon on port ${port}.`, unreadable);
  };
  let addresses;
  try {
    addresses = await Promise.race([
      lookupAll(host),
      new Promise((_, reject) => setTimeout(() => reject(new Error("lookup timed out")), 2000).unref?.())
    ]);
  } catch {
    return refuse();
  }
  if (addresses.some((address) => loopbackPort(`http://${address.includes(":") ? `[${address}]` : address}:${port}`) !== undefined))
    refuse();
}
async function defaultLookupAll(hostname) {
  return (await lookup(hostname, { all: true })).map((entry) => entry.address);
}

class ZkapiDaemonEndpointRefusal extends OperationError {
  reason;
  constructor(reason, message2, policyPath) {
    super("config_error", message2, refusalSuggestion(reason, policyPath));
    this.name = "ZkapiDaemonEndpointRefusal";
    this.reason = reason;
  }
}
function refusalSuggestion(reason, policyPath) {
  if (reason === "policy_unreadable") {
    return `Fix or remove the sovereignty policy file at ${policyPath ?? "its configured path"}; until it can be read, Olympus refuses every local model endpoint.`;
  }
  if (reason === "hostname_on_daemon_port") {
    return "Use a numeric address: a cloud endpoint on its own port, or 127.0.0.1 for a local model, which must then not share a zkAPI daemon port.";
  }
  return "This address is the zkAPI daemon, which only carries consults. Point this model at a local model server on another port.";
}
function loopbackPort(baseUrl) {
  if (!baseUrl)
    return;
  let url;
  try {
    url = new URL(baseUrl);
  } catch {
    return;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:" || !isLoopbackHost(url.hostname))
    return;
  if (url.port)
    return Number(url.port);
  return url.protocol === "https:" ? 443 : 80;
}
function isLoopbackHost(hostname) {
  const host = hostname.toLowerCase().replace(/\.$/, "");
  if (host === "localhost" || host.endsWith(".localhost"))
    return true;
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (v4)
    return Number(v4[1]) === 127 || host === "0.0.0.0";
  if (!host.startsWith("[") || !host.endsWith("]"))
    return false;
  const words = ipv6Words(host.slice(1, -1));
  if (!words)
    return false;
  if (words.slice(0, 7).every((word) => word === 0) && (words[7] === 1 || words[7] === 0))
    return true;
  const mapped = words.slice(0, 5).every((word) => word === 0) && (words[5] === 65535 || words[5] === 0);
  return mapped && (words[6] >> 8 === 127 || words[6] === 0 && words[7] === 0);
}
function ipv6Words(text) {
  let body = text;
  const tail = [];
  const dotted = /(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(body);
  if (dotted) {
    const bytes = dotted.slice(1).map(Number);
    if (bytes.some((byte) => byte > 255))
      return;
    tail.push(bytes[0] << 8 | bytes[1], bytes[2] << 8 | bytes[3]);
    body = text.slice(0, dotted.index);
    if (!body.endsWith("::"))
      body = body.replace(/:$/, "");
  }
  const halves = body.split("::");
  if (halves.length > 2)
    return;
  const parse = (part) => part ? part.split(":").map((word) => parseInt(word, 16)) : [];
  const head = parse(halves[0] ?? "");
  const rest = halves.length === 2 ? parse(halves[1] ?? "") : [];
  if ([...head, ...rest].some((word) => Number.isNaN(word) || word < 0 || word > 65535))
    return;
  const fill = 8 - head.length - rest.length - tail.length;
  if (fill < 0 || halves.length === 1 && fill !== 0)
    return;
  return [...head, ...Array(fill).fill(0), ...rest, ...tail];
}

// src/core/model-transport.ts
var MODEL_ENDPOINT_REDIRECT_MESSAGE = "The model endpoint answered with a redirect. Olympus refuses redirects on model transports and did not use the answer.";

class ModelEndpointRedirectError extends Error {
  code = "model_endpoint_redirect";
  status;
  constructor(status) {
    super(MODEL_ENDPOINT_REDIRECT_MESSAGE);
    this.name = "ModelEndpointRedirectError";
    this.status = status;
  }
}
async function fetchModelEndpoint(fetchImpl, url, init) {
  await assertNotZkapiDaemonEndpointResolved(url, "Model endpoint");
  let response;
  try {
    response = await fetchImpl(url, { ...init, redirect: "error" });
  } catch (error) {
    if (isFetchRedirectRefusal(error))
      throw new ModelEndpointRedirectError;
    throw error;
  }
  if (isRedirectResponse(response)) {
    discardBody(response);
    throw new ModelEndpointRedirectError(response.status >= 300 && response.status <= 399 ? response.status : undefined);
  }
  return response;
}
function isRedirectResponse(response) {
  return response.type === "opaqueredirect" || response.redirected === true || response.status >= 300 && response.status <= 399;
}
function discardBody(response) {
  try {
    const cancelled2 = response.body?.cancel();
    if (cancelled2 && typeof cancelled2.catch === "function") {
      cancelled2.catch(() => {
        return;
      });
    }
  } catch {}
}
function isFetchRedirectRefusal(error) {
  if (error instanceof ModelEndpointRedirectError)
    return true;
  if (!(error instanceof Error))
    return false;
  if (error.code === "UnexpectedRedirect")
    return true;
  const cause = error.cause;
  const causeMessage = cause instanceof Error ? cause.message : typeof cause === "string" ? cause : "";
  return /unexpected redirect/i.test(causeMessage) || /unexpected ?redirect/i.test(error.message);
}

// src/workers/source-index/embeddings.ts
var priorityQueryEmbedding = new AsyncLocalStorage;
function withPriorityQueryEmbedding(run) {
  return priorityQueryEmbedding.run(true, run);
}
function priorityQueryEmbeddingRequested() {
  return priorityQueryEmbedding.getStore() === true;
}

class SourceEmbeddingInputsFailedError extends Error {
  failedIndexes;
  reason;
  disposition;
  constructor(failedIndexes, reason, disposition = "failed") {
    super(`${failedIndexes.length} embedding input(s) could not be embedded: ${reason}.`);
    this.name = "SourceEmbeddingInputsFailedError";
    this.failedIndexes = failedIndexes;
    this.reason = reason;
    this.disposition = disposition;
  }
}
var SUPPORTED_IMAGE_MIME_TYPES = new Set(["image/jpeg", "image/png"]);
var TRANSIENT_EMBEDDING_STATUSES = new Set([429, 500, 502, 503, 504]);
function transientEmbeddingMessage(provider, reason, attempts, budgetMs) {
  const tries = `${attempts} attempt${attempts === 1 ? "" : "s"}`;
  if (reason === 429) {
    return {
      message: `${provider} source embedding endpoint refused the request with HTTP 429 (rate limit or quota) after ${tries}.`,
      suggestion: "The provider is throttling this account or its quota may be exhausted. Check the provider quota and billing before retrying; the key and model are not implicated."
    };
  }
  if (reason === "network") {
    return {
      message: `${provider} source embedding endpoint could not be reached (network error after ${tries}).`,
      suggestion: "A connection or DNS failure, not a key or model problem. Retry the same request shortly; if it persists, check the Gateway host network."
    };
  }
  if (reason === "timeout") {
    return {
      message: `${provider} source embedding endpoint did not answer within its ${budgetMs}ms budget (${tries}).`,
      suggestion: "The provider was slow or unavailable, not misconfigured. Retry the same request shortly."
    };
  }
  return {
    message: `${provider} source embedding endpoint is temporarily unavailable (HTTP ${reason} after ${tries}).`,
    suggestion: "This is a transient provider outage, not a key or model problem. Retry the same request in a few seconds."
  };
}

class TransientSourceEmbeddingError extends OperationError {
  reason;
  modelStarting;
  constructor(provider, reason, attempts, budgetMs = 0, options = {}) {
    const { message: message2, suggestion } = transientEmbeddingMessage(provider, reason, attempts, budgetMs);
    super("source_index_error", message2, suggestion);
    this.name = "TransientSourceEmbeddingError";
    this.reason = reason;
    this.modelStarting = options.modelStarting === true;
  }
}

// src/workers/source-index/built-in-embedding/remote-litert-runtime.ts
import { readFileSync as readFileSync8 } from "node:fs";

class RemoteLiteRtEmbedder {
  options;
  device = "cpu";
  vision = false;
  verified = false;
  retryAt = 0;
  state = "unused";
  slot = Promise.resolve();
  url;
  constructor(options) {
    this.options = options;
    try {
      this.url = new URL(options.url);
    } catch {
      throw new Error("Invalid built-in embedding remote URL.");
    }
    const loopback = this.url.hostname === "localhost" || this.url.hostname === "[::1]" || /^127(?:\.\d{1,3}){3}$/.test(this.url.hostname);
    if (this.url.protocol !== "https:" && !(this.url.protocol === "http:" && loopback) || this.url.username || this.url.password || this.url.search || this.url.hash) {
      throw new Error("Built-in embedding remote requires HTTPS or loopback HTTP, without URL credentials, query or fragment.");
    }
  }
  get active() {
    return this.state === "remote";
  }
  async embed(items) {
    const previous = this.slot;
    let unlock;
    this.slot = new Promise((resolve5) => {
      unlock = resolve5;
    });
    await previous;
    try {
      const now = this.options.now ?? Date.now;
      if (now() < this.retryAt)
        throw new Error("Remote embedding cooling down.");
      try {
        if (items.length === 0 || items.length > 8 || items.some((item) => typeof item !== "string")) {
          throw new Error("Remote embedding requires a text-only batch.");
        }
        if (!this.verified) {
          const handshake = await this.request("/v1/handshake");
          for (const [field, value] of Object.entries(this.options.identity)) {
            if (handshake[field] !== value)
              throw new Error("Remote embedding identity mismatch.");
          }
          if (handshake.device !== "cpu" && handshake.device !== "gpu")
            throw new Error("Invalid remote device.");
          if (handshake.vision !== false)
            throw new Error("Invalid remote vision capability.");
          this.device = handshake.device;
          this.verified = true;
        }
        const response = await this.request("/v1/embed", items);
        const identity = this.options.identity;
        if (typeof response.vectors !== "string" || Object.entries(identity).some(([field, value]) => response[field] !== value)) {
          throw new Error("Remote embedding identity mismatch.");
        }
        const bytes = Buffer.from(response.vectors, "base64");
        if (bytes.length !== items.length * identity.dimension * 4)
          throw new Error("Invalid remote vector length.");
        const vectors = items.map((_, row) => Float32Array.from({ length: identity.dimension }, (_2, column) => bytes.readFloatLE((row * identity.dimension + column) * 4)));
        if (vectors.some((vector) => vector.some((value) => !Number.isFinite(value)) || !vector.some((value) => value !== 0))) {
          throw new Error("Invalid remote vector values.");
        }
        this.transition("remote");
        return vectors;
      } catch {
        this.verified = false;
        this.retryAt = now() + 60000;
        this.transition("local");
        throw new Error("Remote embedding unavailable; using local helper.");
      }
    } finally {
      unlock();
    }
  }
  async release() {
    this.verified = false;
  }
  transition(state) {
    if (this.state === state)
      return;
    this.state = state;
    console.warn(state === "remote" ? "[built-in embedding] document text embedding is using the remote helper." : "[built-in embedding] remote helper unavailable; document text embedding is using the local helper.");
  }
  async request(path, texts) {
    const headers = {};
    if (this.options.tokenFile) {
      const token = readFileSync8(this.options.tokenFile, "utf8").trim();
      if (!token)
        throw new Error("Empty remote token file.");
      headers.Authorization = `Bearer ${token}`;
    }
    if (texts)
      headers["Content-Type"] = "application/json";
    const response = await fetch(new URL(path, this.url), {
      method: texts ? "POST" : "GET",
      headers,
      ...texts ? { body: JSON.stringify({ texts }) } : {},
      signal: AbortSignal.timeout(this.options.requestTimeoutMs ?? 30000),
      redirect: "error"
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error("Remote request failed.");
    }
    return await response.json();
  }
}

// src/workers/source-index/built-in-embedding/runtime.ts
import { createRequire as createRequire2 } from "node:module";
import { join as join10 } from "node:path";
function onnxRuntimeFromDirectory(runtimeDir) {
  return {
    async createSession(modelPath, options) {
      const requireFromPack = createRequire2(join10(runtimeDir, "olympus-runtime.json"));
      const ort = requireFromPack("onnxruntime-node");
      const session = await ort.InferenceSession.create(modelPath, {
        executionProviders: ["cpu"],
        intraOpNumThreads: options.threads,
        interOpNumThreads: 1,
        executionMode: "sequential",
        graphOptimizationLevel: "all",
        enableCpuMemArena: false
      });
      const releaseAtExit = () => {
        session.release().catch(() => {
          return;
        });
      };
      process.once("exit", releaseAtExit);
      const wantsTokenTypes = session.inputNames.includes("token_type_ids");
      const outputName = session.outputNames.includes("last_hidden_state") ? "last_hidden_state" : session.outputNames[0];
      if (!outputName)
        throw new Error("The built-in search model has no outputs.");
      return {
        async run(batch) {
          const dims = [batch.batchSize, batch.sequenceLength];
          const feeds = {
            input_ids: new ort.Tensor("int64", batch.inputIds, dims),
            attention_mask: new ort.Tensor("int64", batch.attentionMask, dims)
          };
          if (wantsTokenTypes)
            feeds.token_type_ids = new ort.Tensor("int64", batch.tokenTypeIds, dims);
          const output = (await session.run(feeds))[outputName];
          if (!output || !(output.data instanceof Float32Array)) {
            throw new Error("The built-in search model returned an unexpected output.");
          }
          return { data: output.data, dims: output.dims };
        },
        release: () => {
          process.removeListener("exit", releaseAtExit);
          return session.release();
        }
      };
    }
  };
}

// src/workers/source-index/built-in-embedding/pair-tokenizer.ts
function truncatePair(a, b, room, tiePolicy = "wordpiece") {
  let keepA = a.length;
  let keepB = b.length;
  room = Math.max(0, room);
  while (keepA + keepB > room) {
    if (keepB > keepA || keepB === keepA && (tiePolicy === "wordpiece" || a.length > b.length))
      keepB -= 1;
    else
      keepA -= 1;
  }
  return { a: a.slice(0, keepA), b: b.slice(0, keepB), truncated: keepA < a.length || keepB < b.length };
}

// src/workers/source-index/built-in-embedding/wordpiece.ts
var MAX_INPUT_CHARS_PER_WORD = 100;
var CONTINUING_SUBWORD_PREFIX = "##";

class WordPieceTokenizer {
  vocab;
  clsId;
  sepId;
  unkId;
  padId;
  constructor(vocabText) {
    const vocab = new Map;
    const lines = vocabText.split(`
`);
    for (let index = 0;index < lines.length; index += 1) {
      const token = lines[index].replace(/\r$/, "");
      if (token.length === 0 && index === lines.length - 1)
        continue;
      if (!vocab.has(token))
        vocab.set(token, index);
    }
    this.vocab = vocab;
    this.clsId = requireToken(vocab, "[CLS]");
    this.sepId = requireToken(vocab, "[SEP]");
    this.unkId = requireToken(vocab, "[UNK]");
    this.padId = requireToken(vocab, "[PAD]");
  }
  tokenize(text) {
    const ids = [];
    for (const word of preTokenize(normalize(text))) {
      this.wordPiece(word, ids);
    }
    return ids;
  }
  encode(text, maxLength) {
    const content = this.tokenize(text);
    const room = Math.max(0, maxLength - 2);
    const truncated = content.length > room;
    return {
      ids: [this.clsId, ...truncated ? content.slice(0, room) : content, this.sepId],
      truncated
    };
  }
  encodePair(first, second, maxLength) {
    const { a, b, truncated } = truncatePair(this.tokenize(first), this.tokenize(second), maxLength - 3);
    const ids = [this.clsId, ...a, this.sepId, ...b, this.sepId];
    const typeIds = ids.map((_, index) => index < a.length + 2 ? 0 : 1);
    return { ids, typeIds, truncated };
  }
  wordPiece(word, out) {
    const chars = Array.from(word);
    if (chars.length > MAX_INPUT_CHARS_PER_WORD) {
      out.push(this.unkId);
      return;
    }
    const pieces = [];
    let start = 0;
    while (start < chars.length) {
      let end = chars.length;
      let found;
      while (start < end) {
        const piece = (start > 0 ? CONTINUING_SUBWORD_PREFIX : "") + chars.slice(start, end).join("");
        const id = this.vocab.get(piece);
        if (id !== undefined) {
          found = id;
          break;
        }
        end -= 1;
      }
      if (found === undefined) {
        out.push(this.unkId);
        return;
      }
      pieces.push(found);
      start = end;
    }
    out.push(...pieces);
  }
}
function requireToken(vocab, token) {
  const id = vocab.get(token);
  if (id === undefined)
    throw new Error(`WordPiece vocabulary is missing ${token}.`);
  return id;
}
var CONTROL = /[\p{Cc}\p{Cf}\p{Co}\p{Cn}]/u;
var WHITESPACE = /[\s\p{Zs}]/u;
var COMBINING_MARK = /\p{Mn}/gu;
var PUNCTUATION = /\p{P}/u;
function normalize(text) {
  let cleaned = "";
  for (const char of text) {
    const code = char.codePointAt(0);
    if (code === 0 || code === 65533)
      continue;
    if (char === "\t" || char === `
` || char === "\r") {
      cleaned += " ";
      continue;
    }
    if (CONTROL.test(char))
      continue;
    if (WHITESPACE.test(char)) {
      cleaned += " ";
      continue;
    }
    cleaned += isChineseChar(code) ? ` ${char} ` : char;
  }
  return cleaned.toLowerCase().normalize("NFD").replace(COMBINING_MARK, "");
}
function preTokenize(text) {
  const words = [];
  let current = "";
  for (const char of text) {
    if (char === " " || WHITESPACE.test(char)) {
      if (current)
        words.push(current);
      current = "";
    } else if (isPunctuation(char)) {
      if (current)
        words.push(current);
      words.push(char);
      current = "";
    } else {
      current += char;
    }
  }
  if (current)
    words.push(current);
  return words;
}
function isPunctuation(char) {
  const code = char.codePointAt(0);
  if (code >= 33 && code <= 47 || code >= 58 && code <= 64 || code >= 91 && code <= 96 || code >= 123 && code <= 126) {
    return true;
  }
  return PUNCTUATION.test(char);
}
function isChineseChar(code) {
  return code >= 19968 && code <= 40959 || code >= 13312 && code <= 19903 || code >= 131072 && code <= 173791 || code >= 173824 && code <= 177983 || code >= 177984 && code <= 178207 || code >= 178208 && code <= 183983 || code >= 63744 && code <= 64255 || code >= 194560 && code <= 195103;
}

// src/workers/source-index/built-in-embedding/provider.ts
var BUILT_IN_EMBEDDING_PROVIDER = "built-in";
var BUILT_IN_EMBEDDING_THREADS_ENV = "OLYMPUS_BUILT_IN_EMBEDDING_THREADS";
var BUILT_IN_EMBEDDING_DEVICE_ENV = "OLYMPUS_BUILT_IN_EMBEDDING_DEVICE";
var BUILT_IN_EMBEDDING_REMOTE_URL_ENV = "OLYMPUS_BUILT_IN_EMBEDDING_REMOTE_URL";
var BUILT_IN_EMBEDDING_REMOTE_TOKEN_FILE_ENV = "OLYMPUS_BUILT_IN_EMBEDDING_REMOTE_TOKEN_FILE";
var MAX_WINDOWS_PER_DOCUMENT = 8;
var MAX_BATCH_TOKENS = 2048;
var MAX_BATCH_ROWS = 32;
var LITERT_BATCH = 8;
var RETRY_AFTER_FAILURE_MS = 2 * 60000;
var PICTURE_ENGINE_FAULT_LIMIT = 2;
var PICTURE_HOLD_MS = 60 * 60000;
class BuiltInSourceEmbeddingProvider {
  provider;
  modelId;
  dimension;
  configHash;
  epochId;
  backend;
  threads;
  device;
  remote;
  spec;
  env;
  onnxOffThread;
  runtimeFactory;
  liteRtFactory;
  install;
  installerOptions;
  now;
  loading;
  loaded;
  priorityLoaded;
  prioritySlotBusy = false;
  priorityWaiting = [];
  lastFailure;
  slotBusy = false;
  imageSupportWarned = false;
  pictureFaults;
  waiting = { query: [], document: [] };
  runsOnThisComputer() {
    return this.remote === undefined;
  }
  constructor(options = {}) {
    this.spec = options.model ?? BUILT_IN_EMBEDDING_MODEL;
    this.env = options.env ?? process.env;
    this.provider = BUILT_IN_EMBEDDING_PROVIDER;
    this.backend = "local";
    this.modelId = this.spec.modelId;
    this.dimension = this.spec.dimension;
    this.threads = resolveThreads(options.threads, this.env);
    this.device = resolveDevice(this.env);
    this.onnxOffThread = isMainThread4 && !options.runtime;
    this.runtimeFactory = options.runtime ?? ((installed) => onnxRuntimeFromDirectory(installed.runtimeDir));
    this.liteRtFactory = options.liteRt ?? startLiteRtEmbedder;
    this.install = options.install ?? installBuiltInEmbedding;
    this.installerOptions = options.installerOptions ?? {};
    this.now = options.now ?? Date.now;
    const remoteUrl = this.env[BUILT_IN_EMBEDDING_REMOTE_URL_ENV]?.trim();
    if (remoteUrl && this.spec.runtime === "litert") {
      this.remote = new RemoteLiteRtEmbedder({
        url: remoteUrl,
        tokenFile: this.env[BUILT_IN_EMBEDDING_REMOTE_TOKEN_FILE_ENV],
        now: this.now,
        requestTimeoutMs: options.remoteRequestTimeoutMs,
        identity: {
          modelId: this.modelId,
          weightsSha256: this.spec.model.sha256,
          runtime: `litert-lm-${LITERT_RUNTIME_PACK.version}`,
          dimension: this.dimension,
          maxTokens: this.spec.maxTokens,
          overflow: "chunk-and-average"
        }
      });
    }
    this.epochId = resolveEmbeddingEpoch({
      provider: this.provider,
      modelId: this.modelId,
      dimension: this.dimension,
      backend: this.backend,
      ...options.epochId ? { epochOverride: options.epochId } : {}
    });
    this.configHash = createHash3("sha256").update(JSON.stringify({
      provider: this.provider,
      model: this.modelId,
      repository: this.spec.repository,
      revision: this.spec.revision,
      weights: this.spec.model.sha256,
      ...this.spec.vocabulary ? { vocabulary: this.spec.vocabulary.sha256 } : {},
      ...this.spec.runtime === "litert" ? { runtime: `litert-lm-${LITERT_RUNTIME_PACK.version}` } : {},
      dimension: this.dimension,
      maxTokens: this.spec.maxTokens,
      pooling: this.spec.pooling,
      queryPrefix: this.spec.queryPrefix,
      documentPrefix: this.spec.documentPrefix,
      ...this.spec.runtime === "litert" ? { overflow: "chunk-and-average" } : { windows: MAX_WINDOWS_PER_DOCUMENT },
      backend: this.backend
    })).digest("hex");
  }
  status() {
    const status = readBuiltInEmbeddingStatus(this.env, this.spec);
    return this.remote ? { ...status, remoteDocuments: this.remote.active } : status;
  }
  async prepare() {
    await this.load();
  }
  async warm() {
    await this.load();
    await this.embed([{ text: "warm up" }], { taskType: "RETRIEVAL_QUERY" });
  }
  async imageSupport() {
    if (this.spec.runtime !== "litert" || !this.spec.vision)
      return false;
    if (this.picturesHeld())
      return false;
    const model = await this.ready();
    const supported = model.kind === "litert" && model.embedder.vision;
    if (!supported && !this.imageSupportWarned) {
      this.imageSupportWarned = true;
      console.warn("[built-in embedding] the image encoder could not start on this machine; photos keep keyword search and wait for their picture vectors.");
    }
    return supported;
  }
  async retry() {
    if (!this.loading)
      this.lastFailure = undefined;
    await this.load();
  }
  async embed(inputs, options) {
    if (inputs.length === 0)
      return [];
    if (options.taskType === "RETRIEVAL_QUERY" && !this.loaded) {
      const status = this.status();
      if (this.spec.runtime === "litert" || status.state !== "ready" && status.state !== "loading") {
        this.load().catch(() => {
          return;
        });
        const now = this.status();
        throw new BuiltInEmbeddingNotReadyError(now, undefined, {
          modelStarting: this.loading !== undefined && (now.state === "ready" || now.state === "loading")
        });
      }
    }
    const model = await this.ready();
    return this.embedLoaded(model, inputs, options.taskType);
  }
  loadedOnly() {
    return {
      provider: this.provider,
      modelId: this.modelId,
      dimension: this.dimension,
      configHash: this.configHash,
      epochId: this.epochId,
      backend: this.backend,
      embed: async (inputs, options) => {
        if (inputs.length === 0)
          return [];
        const model = this.loaded;
        if (!model)
          throw new BuiltInEmbeddingNotReadyError(this.status());
        return this.embedLoaded(model, inputs, options.taskType);
      }
    };
  }
  async ready() {
    if (this.loaded)
      return this.loaded;
    try {
      return await this.load();
    } catch (error) {
      throw new BuiltInEmbeddingNotReadyError(this.status(), error);
    }
  }
  load() {
    if (this.loading)
      return this.loading;
    if (this.lastFailure && this.now() - this.lastFailure.atMs < RETRY_AFTER_FAILURE_MS) {
      return Promise.reject(this.lastFailure.error);
    }
    const loading = this.loadOnce();
    this.loading = loading;
    loading.then((model) => {
      this.loaded = model;
      this.lastFailure = undefined;
    }, (error) => {
      this.lastFailure = { atMs: this.now(), error };
      if (this.loading === loading)
        this.loading = undefined;
    });
    return loading;
  }
  async loadOnce() {
    const reporterOptions = {
      env: this.env,
      model: this.spec,
      ...this.installerOptions.now ? { now: this.installerOptions.now } : {},
      ...this.installerOptions.onProgress ? { onProgress: this.installerOptions.onProgress } : {}
    };
    let installed;
    try {
      installed = await this.install({ ...this.installerOptions, env: this.env, model: this.spec });
    } catch (error) {
      throw builtInEmbeddingOperationError(error);
    }
    try {
      reportBuiltInEmbeddingState(reporterOptions, "loading");
      let model;
      if (this.spec.runtime === "litert") {
        if (!installed.libraryPath)
          throw new Error("the LiteRT-LM runtime is not installed.");
        const settings = {
          library: installed.libraryPath,
          model: installed.modelPath,
          cacheDir: join11(dirname11(installed.modelPath), "cache"),
          threads: this.threads,
          device: this.device,
          maxInputTokens: this.spec.maxTokens,
          ...this.spec.vision ? { visionTokensPerImage: this.spec.vision.tokensPerImage } : {}
        };
        const embedder = await this.liteRtFactory(settings);
        model = { kind: "litert", embedder };
        try {
          const { visionTokensPerImage: _vision, ...querySettings } = settings;
          this.priorityLoaded = { kind: "litert", embedder: await this.liteRtFactory(querySettings) };
        } catch (error) {
          await embedder.release().catch(() => {
            return;
          });
          throw error;
        }
        if (this.spec.vision)
          reportBuiltInEmbeddingVision(embedder.vision, { env: this.env, model: this.spec });
      } else if (this.onnxOffThread) {
        const handle = modelThreadHandleId();
        await modelThread().call({ kind: "embedding-load", handle, installed, model: this.spec, env: this.env, threads: this.threads });
        model = { kind: "thread", handle };
      } else {
        if (!installed.vocabularyPath)
          throw new Error("the model vocabulary is not installed.");
        const tokenizer = loadTokenizer(installed.vocabularyPath);
        const session = await this.runtimeFactory(installed).createSession(installed.modelPath, { threads: this.threads });
        model = { kind: "onnx", session, tokenizer };
        try {
          const querySession = await this.runtimeFactory(installed).createSession(installed.modelPath, { threads: this.threads });
          this.priorityLoaded = { kind: "onnx", session: querySession, tokenizer };
        } catch (error) {
          await session.release?.().catch(() => {
            return;
          });
          throw error;
        }
      }
      reportBuiltInEmbeddingState(reporterOptions, "ready");
      return model;
    } catch (error) {
      const failure = new BuiltInEmbeddingInstallError("runtime_load_failed", `The built-in search model could not start: ${error instanceof Error ? error.message : String(error)}`);
      reportBuiltInEmbeddingState(reporterOptions, "failed", { reason: failure.reason, message: failure.message });
      throw builtInEmbeddingOperationError(failure);
    }
  }
  async withSlot(taskType, run) {
    if (taskType === "RETRIEVAL_QUERY" && priorityQueryEmbeddingRequested()) {
      if (this.prioritySlotBusy)
        await new Promise((resolve5) => this.priorityWaiting.push(resolve5));
      else
        this.prioritySlotBusy = true;
      try {
        return await run();
      } finally {
        const next = this.priorityWaiting.shift();
        if (next)
          next();
        else
          this.prioritySlotBusy = false;
      }
    }
    if (this.slotBusy) {
      await new Promise((resolve5) => this.waiting[taskType === "RETRIEVAL_QUERY" ? "query" : "document"].push(resolve5));
    } else {
      this.slotBusy = true;
    }
    try {
      return await run();
    } finally {
      const next = this.waiting.query.shift() ?? this.waiting.document.shift();
      if (next)
        next();
      else
        this.slotBusy = false;
    }
  }
  async embedLoaded(model, inputs, taskType) {
    if (model.kind === "thread") {
      return modelThread().call({ kind: "embedding-run", handle: model.handle, inputs, taskType, priority: priorityQueryEmbeddingRequested() });
    }
    if (taskType === "RETRIEVAL_QUERY" && priorityQueryEmbeddingRequested()) {
      if (!this.priorityLoaded)
        throw new BuiltInEmbeddingNotReadyError(this.status());
      model = this.priorityLoaded;
    }
    if (model.kind === "litert")
      return this.embedLiteRt(model.embedder, inputs, taskType);
    const windowTokens = this.spec.maxTokens - 2;
    const windows = [];
    inputs.forEach((input, index) => {
      const ids = model.tokenizer.tokenize(promptText(this.spec, input, taskType));
      const maxWindows = taskType === "RETRIEVAL_QUERY" ? 1 : MAX_WINDOWS_PER_DOCUMENT;
      const count = Math.max(1, Math.min(maxWindows, Math.ceil(ids.length / windowTokens)));
      for (let window = 0;window < count; window += 1) {
        windows.push({
          input: index,
          ids: [model.tokenizer.startId, ...ids.slice(window * windowTokens, (window + 1) * windowTokens), model.tokenizer.endId]
        });
      }
    });
    const sums = inputs.map(() => new Float64Array(this.dimension));
    for (const batch of planBatches(windows)) {
      const vectors = await this.withSlot(taskType, () => this.forward(model, batch));
      batch.forEach((window, row) => {
        const vector = vectors[row];
        const weight = window.ids.length - 2;
        const sum = sums[window.input];
        for (let d = 0;d < this.dimension; d += 1)
          sum[d] += vector[d] * Math.max(1, weight);
      });
    }
    return sums.map((sum) => normalize2(sum));
  }
  async embedWithImageVectors(inputs) {
    if (inputs.length === 0)
      return { vectors: [], imageVectors: [] };
    const model = await this.ready();
    if (model.kind !== "litert" || !this.spec.vision) {
      return { vectors: await this.embedLoaded(model, inputs, "RETRIEVAL_DOCUMENT"), imageVectors: inputs.map(() => {
        return;
      }) };
    }
    const extra = inputs.flatMap((input, index) => input.image && isMediaCachePath(input.image.path, input.image.sha256) ? [index] : []);
    const { vectors, failed } = await this.liteRtVectors(model.embedder, [...this.liteRtItems(inputs, "RETRIEVAL_DOCUMENT"), ...extra.map((index) => ({ text: "", image: inputs[index].image.path }))], "RETRIEVAL_DOCUMENT", new Set(this.refusedPictures(inputs)));
    const documentFailures = failed.filter((index) => index < inputs.length);
    if (documentFailures.length > 0)
      throw new SourceEmbeddingInputsFailedError(documentFailures, "image_unreadable");
    const imageVectors = inputs.map(() => {
      return;
    });
    extra.forEach((input, row) => {
      imageVectors[input] = vectors[inputs.length + row];
    });
    return { vectors: vectors.slice(0, inputs.length), imageVectors };
  }
  async embedImageVectors(images) {
    if (images.length === 0)
      return [];
    const model = await this.ready();
    if (model.kind !== "litert" || !this.spec.vision) {
      throw new SourceEmbeddingInputsFailedError(images.map((_, index) => index), "image_encoder_unavailable", "held");
    }
    const refused = new Set(images.flatMap((image, index) => isMediaCachePath(image.path, image.sha256) ? [] : [index]));
    const live = images.flatMap((image, index) => refused.has(index) ? [] : [{ index, image }]);
    const out = images.map(() => {
      return;
    });
    if (live.length === 0)
      return out;
    const { vectors } = await this.liteRtVectors(model.embedder, live.map(({ image }) => ({ text: "", image: image.path })), "RETRIEVAL_DOCUMENT", new Set);
    live.forEach(({ index }, row) => {
      out[index] = vectors[row];
    });
    return out;
  }
  async embedPromptTexts(texts) {
    if (texts.length === 0)
      return [];
    const model = await this.ready();
    if (model.kind !== "litert")
      throw new Error("The photo judge needs the LiteRT model.");
    const { vectors, failed } = await this.liteRtVectors(model.embedder, texts, "RETRIEVAL_DOCUMENT", new Set);
    if (failed.length > 0)
      throw new Error("The photo judge's descriptions could not be embedded.");
    return vectors;
  }
  refusedPictures(inputs) {
    if (!this.spec.vision)
      return [];
    return inputs.flatMap((input, index) => input.image && !isMediaCachePath(input.image.path, input.image.sha256) ? [index] : []);
  }
  liteRtItems(inputs, taskType) {
    return inputs.map((input) => {
      const text = promptText(this.spec, input, taskType);
      if (taskType !== "RETRIEVAL_DOCUMENT" || !this.spec.vision || !input.image)
        return text;
      return { text, image: input.image.path };
    });
  }
  async embedLiteRt(embedder, inputs, taskType) {
    const { vectors, failed } = await this.liteRtVectors(embedder, this.liteRtItems(inputs, taskType), taskType, new Set(taskType === "RETRIEVAL_DOCUMENT" ? this.refusedPictures(inputs) : []), new Set(inputs.flatMap((input, index) => input.image ? [index] : [])));
    if (failed.length > 0)
      throw new SourceEmbeddingInputsFailedError(failed, "image_unreadable");
    return vectors;
  }
  async liteRtVectors(embedder, prompts, taskType, refused, localOnly = new Set) {
    const out = [];
    const pictures = prompts.flatMap((prompt, index) => typeof prompt !== "string" && !refused.has(index) ? [index] : []);
    if (pictures.length > 0 && this.picturesHeld()) {
      throw new SourceEmbeddingInputsFailedError(pictures, "image_encoder_failing", "held");
    }
    const failed = [...refused];
    for (let offset = 0;offset < prompts.length; offset += LITERT_BATCH) {
      const batch = prompts.slice(offset, offset + LITERT_BATCH).map((prompt, row) => refused.has(offset + row) && typeof prompt !== "string" ? prompt.text : prompt);
      const batchPictures = batch.flatMap((prompt, row) => typeof prompt !== "string" ? [offset + row] : []);
      let vectors;
      try {
        let remoteVectors;
        if (this.remote && taskType === "RETRIEVAL_DOCUMENT" && batch.every((prompt) => typeof prompt === "string") && !prompts.slice(offset, offset + LITERT_BATCH).some((prompt, row) => typeof prompt !== "string" || localOnly.has(offset + row))) {
          try {
            remoteVectors = await this.remote.embed(batch);
          } catch {}
        }
        vectors = remoteVectors ?? await this.withSlot(taskType, () => embedder.embed(batch));
        if (batchPictures.length > 0)
          this.pictureFaults = undefined;
      } catch (error) {
        if (error instanceof LiteRtPictureEngineFaultError) {
          const count = (this.pictureFaults?.count ?? 0) + 1;
          if (count < PICTURE_ENGINE_FAULT_LIMIT) {
            this.pictureFaults = { count };
            offset -= LITERT_BATCH;
            continue;
          }
          this.pictureFaults = { count: 0, heldUntilMs: this.now() + PICTURE_HOLD_MS };
          console.warn(`[built-in embedding] the image encoder keeps failing a known-good picture; photos wait ${PICTURE_HOLD_MS / 60000} minutes while text keeps embedding.`);
          throw new SourceEmbeddingInputsFailedError(pictures, "image_encoder_failing", "held");
        }
        if (error instanceof LiteRtImagesUnavailableError) {
          throw new SourceEmbeddingInputsFailedError(error.indexes.map((index) => offset + index), "image_encoder_unavailable", "held");
        }
        throw new OperationError("source_index_error", `The built-in search model failed while embedding: ${error instanceof Error ? error.message : String(error)}`, "This is a local runtime failure; Olympus restarts the model on the next try.");
      }
      for (const [row, vector] of vectors.entries()) {
        if (vector.length === 0) {
          failed.push(offset + row);
          out.push(undefined);
          continue;
        }
        if (vector.length !== this.dimension) {
          throw new OperationError("source_index_error", `The built-in search model returned ${vector.length} values, expected ${this.dimension}.`);
        }
        out.push(refused.has(offset + row) ? undefined : normalize2(vector));
      }
    }
    return { vectors: out, failed: [...new Set(failed)].sort((left, right) => left - right) };
  }
  picturesHeld() {
    const heldUntilMs = this.pictureFaults?.heldUntilMs;
    return heldUntilMs !== undefined && this.now() < heldUntilMs;
  }
  async forward(model, batch) {
    const rows = batch.length;
    const length = Math.max(...batch.map((window) => window.ids.length));
    const inputIds = new BigInt64Array(rows * length);
    const attentionMask = new BigInt64Array(rows * length);
    const tokenTypeIds = new BigInt64Array(rows * length);
    if (model.tokenizer.padId !== 0)
      inputIds.fill(BigInt(model.tokenizer.padId));
    batch.forEach((window, row) => {
      window.ids.forEach((id, column) => {
        inputIds[row * length + column] = BigInt(id);
        attentionMask[row * length + column] = 1n;
      });
    });
    let output;
    try {
      output = await model.session.run({ inputIds, attentionMask, tokenTypeIds, batchSize: rows, sequenceLength: length });
    } catch (error) {
      throw new OperationError("source_index_error", `The built-in search model failed while embedding: ${error instanceof Error ? error.message : String(error)}`, "This is a local runtime failure; restarting Olympus reloads the model.");
    }
    const expected = [rows, length, this.dimension];
    if (output.dims.length !== expected.length || output.dims.some((size, axis) => size !== expected[axis])) {
      throw new OperationError("source_index_error", `The built-in search model returned shape [${output.dims.join(", ")}], expected [${expected.join(", ")}].`);
    }
    const hidden = this.dimension;
    return batch.map((window, row) => {
      const vector = new Float64Array(hidden);
      const base = row * length * hidden;
      if (this.spec.pooling === "cls") {
        for (let d = 0;d < hidden; d += 1)
          vector[d] = output.data[base + d];
      } else {
        for (let token = 0;token < window.ids.length; token += 1) {
          const offset = base + token * hidden;
          for (let d = 0;d < hidden; d += 1)
            vector[d] += output.data[offset + d];
        }
        for (let d = 0;d < hidden; d += 1)
          vector[d] /= window.ids.length;
      }
      return Float64Array.from(normalize2(vector));
    });
  }
}
function loadTokenizer(path) {
  const tokenizer = new WordPieceTokenizer(readFileSync9(path, "utf8"));
  return {
    tokenize: (text) => tokenizer.tokenize(text),
    startId: tokenizer.clsId,
    endId: tokenizer.sepId,
    padId: tokenizer.padId
  };
}
function promptText(spec, input, taskType) {
  if (taskType === "RETRIEVAL_QUERY")
    return `${spec.queryPrefix}${input.title ? `${input.title}
` : ""}${input.text}`;
  if (spec.documentPrefix.includes("{title}")) {
    const title = input.title?.replace(/\s+/g, " ").trim() || "none";
    return `${spec.documentPrefix.replace("{title}", () => title)}${input.text}`;
  }
  return `${spec.documentPrefix}${input.title ? `${input.title}
` : ""}${input.text}`;
}

class BuiltInEmbeddingNotReadyError extends TransientSourceEmbeddingError {
  status;
  constructor(status, cause, options = {}) {
    super(BUILT_IN_EMBEDDING_PROVIDER, "timeout", 0, 0, options);
    this.name = "BuiltInEmbeddingNotReadyError";
    this.status = status;
    this.message = status.state === "failed" ? `The built-in search model is not available: ${status.failure?.message ?? "install failed"}.` : cause !== undefined ? `The built-in search model is not available: ${cause instanceof Error ? cause.message : String(cause)}.` : `The built-in search model is still being prepared (${status.percent}%).`;
    this.suggestion = "Answers use keyword search until it is ready; nothing needs to be done.";
  }
}
function builtInEmbeddingOperationError(error) {
  if (error instanceof OperationError)
    return error;
  const message2 = error instanceof Error ? error.message : String(error);
  const reason = error instanceof BuiltInEmbeddingInstallError ? error.reason : undefined;
  return new OperationError("source_index_error", message2, reason === "unsupported_platform" ? "Choose another embedding provider for this machine in the model settings." : reason === "download_failed" ? "Check the internet connection; Olympus tries the download again automatically." : reason === "disk_write_failed" ? "Free some disk space; Olympus tries again automatically." : "Olympus removes the bad file and downloads it again automatically.");
}
function planBatches(windows) {
  const ordered = [...windows].sort((left, right) => right.ids.length - left.ids.length);
  const batches = [];
  let current = [];
  let currentLength = 0;
  for (const window of ordered) {
    const length = Math.max(currentLength, window.ids.length);
    if (current.length > 0 && (current.length >= MAX_BATCH_ROWS || length * (current.length + 1) > MAX_BATCH_TOKENS)) {
      batches.push(current);
      current = [];
      currentLength = 0;
    }
    current.push(window);
    currentLength = Math.max(currentLength, window.ids.length);
  }
  if (current.length > 0)
    batches.push(current);
  return batches;
}
function normalize2(vector) {
  let norm = 0;
  for (let index = 0;index < vector.length; index += 1)
    norm += vector[index] * vector[index];
  norm = Math.sqrt(norm);
  const out = new Array(vector.length);
  for (let index = 0;index < vector.length; index += 1)
    out[index] = norm > 0 ? vector[index] / norm : 0;
  return out;
}
function resolveDevice(env) {
  const configured = env[BUILT_IN_EMBEDDING_DEVICE_ENV]?.trim().toLowerCase();
  if (configured && configured !== "cpu" && configured !== "auto") {
    throw new OperationError("config_error", `${BUILT_IN_EMBEDDING_DEVICE_ENV} must be "auto" or "cpu".`);
  }
  return configured === "cpu" ? "cpu" : "auto";
}
function resolveThreads(explicit, env) {
  const configured = explicit ?? (env[BUILT_IN_EMBEDDING_THREADS_ENV]?.trim() ? Number(env[BUILT_IN_EMBEDDING_THREADS_ENV]) : undefined);
  if (configured !== undefined) {
    if (!Number.isSafeInteger(configured) || configured < 1) {
      throw new OperationError("config_error", `${BUILT_IN_EMBEDDING_THREADS_ENV} must be a positive whole number.`);
    }
    return configured;
  }
  return Math.max(1, Math.min(4, Math.floor(availableParallelism() / 2)));
}

// src/workers/source-index/built-in-reranker.ts
import { isMainThread as isMainThread5 } from "node:worker_threads";
import { availableParallelism as availableParallelism2 } from "node:os";
import { existsSync as existsSync8, readFileSync as readFileSync10 } from "node:fs";
import { isAbsolute as isAbsolute8, join as join12 } from "node:path";

// src/core/evidence-reranker.ts
var DEFAULT_RERANK_POOL_SIZE = 30;

// node_modules/@huggingface/tokenizers/dist/tokenizers.mjs
var DictionarySplitter = class {
  constructor(dictionary) {
    this.trie = this._build_trie(dictionary);
  }
  _build_trie(dictionary) {
    const trie = /* @__PURE__ */ Object.create(null);
    for (const word of dictionary) {
      let node = trie;
      for (let i = 0;i < word.length; ++i) {
        const char = word[i];
        node = node[char] ??= /* @__PURE__ */ Object.create(null);
      }
      node.end = word;
    }
    return trie;
  }
  split(text) {
    const result = [];
    const n = text.length;
    let start = 0;
    let i = 0;
    while (i < n) {
      let node = this.trie;
      let match = null;
      let j = i;
      while (j < n && (node = node[text[j]])) {
        if (node.end) {
          match = node.end;
        }
        ++j;
      }
      if (match) {
        if (i > start) {
          result.push(text.slice(start, i));
        }
        result.push(match);
        i += match.length;
        start = i;
      } else {
        ++i;
      }
    }
    if (start < n) {
      result.push(text.slice(start));
    }
    return result;
  }
};
var DictionarySplitter_default = DictionarySplitter;
var AddedToken = class {
  constructor(config) {
    this.content = config.content;
    this.id = config.id;
    this.single_word = config.single_word ?? false;
    this.lstrip = config.lstrip ?? false;
    this.rstrip = config.rstrip ?? false;
    this.special = config.special ?? false;
    this.normalized = config.normalized ?? !this.special;
  }
};
var AddedToken_default = AddedToken;
var compile_unicode_regexp = (source, flags) => {
  try {
    return new RegExp(source, flags);
  } catch (error) {
    if (!(error instanceof SyntaxError))
      throw error;
    const property_names = /* @__PURE__ */ new Map;
    const rewritten = source.replace(/(\\[pP])\{([^}=]+)\}/g, (text, p, n, offset) => {
      let preceding_backslashes = 0;
      for (let i = offset - 1;i >= 0 && source[i] === "\\"; --i) {
        ++preceding_backslashes;
      }
      if (preceding_backslashes % 2 === 1)
        return text;
      let property_name = property_names.get(n);
      if (property_name === undefined) {
        try {
          new RegExp(`\\p{${n}}`, "u");
          property_name = n;
        } catch {
          property_name = `Script=${n}`;
        }
        property_names.set(n, property_name);
      }
      return `${p}{${property_name}}`;
    });
    if (rewritten === source)
      throw error;
    try {
      return new RegExp(rewritten, flags);
    } catch {
      throw error;
    }
  }
};
var clean_up_tokenization = (text) => text.replace(/ \./g, ".").replace(/ \?/g, "?").replace(/ \!/g, "!").replace(/ ,/g, ",").replace(/ \' /g, "'").replace(/ n't/g, "n't").replace(/ 'm/g, "'m").replace(/ 's/g, "'s").replace(/ 've/g, "'ve").replace(/ 're/g, "'re");
var create_pattern = (pattern, invert = true) => {
  if (pattern.Regex !== undefined) {
    const regex = rewrite_oniguruma_to_js(normalize_bloom_split_char_class(pattern.Regex));
    return compile_unicode_regexp(regex, "gu");
  } else if (pattern.String !== undefined) {
    const escaped = escape_reg_exp(pattern.String);
    return new RegExp(invert ? escaped : `(${escaped})`, "gu");
  } else {
    console.warn("Unknown pattern type:", pattern);
    return null;
  }
};
var UNICODE_WORD_CHARS_IN_CLASS = "\\p{Alphabetic}\\p{M}\\p{Nd}\\p{Pc}";
var UNICODE_WORD_CHARS = `${UNICODE_WORD_CHARS_IN_CLASS}\\u00B2\\u00B3\\u00B9\\u00BC-\\u00BE`;
var UNICODE_WORD_CLASS = `[${UNICODE_WORD_CHARS}]`;
var UNICODE_NON_WORD_CLASS = `[^${UNICODE_WORD_CHARS}]`;
var UNICODE_WORD_BOUNDARY = `(?:(?<!${UNICODE_WORD_CLASS})(?=${UNICODE_WORD_CLASS})|(?<=${UNICODE_WORD_CLASS})(?!${UNICODE_WORD_CLASS}))`;
var UNICODE_NON_WORD_BOUNDARY = `(?:(?<!${UNICODE_WORD_CLASS})(?!${UNICODE_WORD_CLASS})|(?<=${UNICODE_WORD_CLASS})(?=${UNICODE_WORD_CLASS}))`;
var LINE_START_ANCHOR = "(?:(?<![\\s\\S])|(?<=\\n))";
var LINE_END_ANCHOR = "(?:(?=\\n)|(?![\\s\\S]))";
var HEX_DIGIT_CHARS = "0-9A-Fa-f";
var ESCAPE_REWRITES = /* @__PURE__ */ new Map([
  ["A", "(?<![\\s\\S])"],
  ["z", "(?![\\s\\S])"],
  ["Z", "(?=\\n?(?![\\s\\S]))"],
  ["h", `[${HEX_DIGIT_CHARS}]`],
  ["H", `[^${HEX_DIGIT_CHARS}]`],
  ["w", UNICODE_WORD_CLASS],
  ["W", UNICODE_NON_WORD_CLASS],
  ["d", "\\p{Nd}"],
  ["D", "\\P{Nd}"],
  ["s", "\\p{White_Space}"],
  ["S", "\\P{White_Space}"],
  ["b", UNICODE_WORD_BOUNDARY],
  ["B", UNICODE_NON_WORD_BOUNDARY],
  ["a", "\\x07"],
  ["e", "\\x1B"]
]);
var CLASS_ESCAPE_REWRITES = /* @__PURE__ */ new Map([
  ["h", HEX_DIGIT_CHARS],
  ["w", UNICODE_WORD_CHARS_IN_CLASS],
  ["d", "\\p{Nd}"],
  ["D", "\\P{Nd}"],
  ["s", "\\p{White_Space}"],
  ["S", "\\P{White_Space}"],
  ["a", "\\x07"],
  ["e", "\\x1B"]
]);
var CLASS_COMPLEMENT_ALTERNATIVES = /* @__PURE__ */ new Map([
  ["W", `[^${UNICODE_WORD_CHARS_IN_CLASS}]`],
  ["H", `[^${HEX_DIGIT_CHARS}]`]
]);
var RAW_WHITESPACE_ESCAPES = /* @__PURE__ */ new Map([
  [`
`, "\\n"],
  ["\r", "\\r"],
  ["\t", "\\t"],
  ["\f", "\\f"],
  ["\v", "\\v"]
]);
var POSIX_CLASS_FRAGMENTS = /* @__PURE__ */ new Map([
  ["alpha", "\\p{Alphabetic}"],
  ["alnum", "\\p{Alphabetic}\\p{Nd}"],
  ["digit", "\\p{Nd}"],
  ["lower", "\\p{Lowercase}"],
  ["upper", "\\p{Uppercase}"],
  ["space", "\\p{White_Space}"],
  ["blank", "\\t\\p{Zs}"],
  ["punct", "\\p{P}\\p{S}"],
  ["cntrl", "\\p{Cc}"],
  ["word", UNICODE_WORD_CHARS_IN_CLASS],
  ["xdigit", HEX_DIGIT_CHARS]
]);
var JS_SYNTAX_CHARS = "^$\\.*+?()[]{}|/";
var GROUP_PREFIX_RE = /^\(\?(?:<[=!]|<[A-Za-z_][A-Za-z0-9_]*>|[:=!>])/;
var BRACED_ESCAPE_RE = /^\\([pPxu])\{([^}]*)\}/;
var QUANTIFIER_BRACE_RE = /^\{(\d+(?:,\d*)?|,\d+)\}/;
var POSIX_BRACKET_RE = /^\[:(\^?)(\p{Alphabetic}+):\]/u;
var EMPTY_NEGATED_POSIX_BRACKET_RE = /^\[:\^:\]/;
var UNSUPPORTED_POSIX_BRACKET_RE = /^\[(?:\.[^\]]*\.\]|=[^\]]*=\])/;
var FIXED_WIDTH_ESCAPE_RE = /^(?:\\x[0-9A-Fa-f]{2}|\\u[0-9A-Fa-f]{4}|\\c[A-Za-z])/;
var is_ascii_letter = (char) => char >= "A" && char <= "Z" || char >= "a" && char <= "z";
var character_at = (text, index) => String.fromCodePoint(text.codePointAt(index));
var get_ascii_folded_hex_atom = (hex) => {
  if (!/^[0-9A-Fa-f]{1,8}$/.test(hex))
    return null;
  const code_point = Number.parseInt(hex, 16);
  if (code_point > 127)
    return null;
  const letter = String.fromCharCode(code_point);
  return is_ascii_letter(letter) ? `[${letter.toLowerCase()}${letter.toUpperCase()}]` : null;
};
var normalize_bloom_split_char_class = (regex) => regex.replace(/\[\^\(\\s\|\[([^\]]+)\]\)\]/g, "[^()|\\s$1]");
var ANY_CODE_POINT = "[\\s\\S]";
var MAX_CHARACTER_CLASS_NESTING_DEPTH = 256;
var create_character_class_operand = () => ({
  fragment: "",
  alternatives: [],
  tail: null,
  contains_complex_set: false
});
var throw_character_class_range_error = (index) => {
  throw new SyntaxError(`Unsupported range with a set-valued character-class operand at index ${index}`);
};
var add_character_class_atom = (operand, atom, index, contains_complex_set = true) => {
  if (operand.tail === "range")
    throw_character_class_range_error(index);
  operand.alternatives.push(atom);
  operand.tail = "set";
  operand.contains_complex_set = operand.contains_complex_set || contains_complex_set;
};
var append_character_class_fragment = (operand, fragment, set_valued = false, index = -1) => {
  if (set_valued && operand.tail === "range") {
    throw_character_class_range_error(index);
  }
  if (operand.tail === "range") {
    operand.fragment += fragment;
    operand.tail = "complete_range";
    return;
  }
  operand.fragment += fragment;
  operand.tail = set_valued ? "set" : "scalar";
  operand.contains_complex_set = operand.contains_complex_set || set_valued;
};
var rewrite_character_class_escape = (regex, index, operand) => {
  const braced = BRACED_ESCAPE_RE.exec(regex.slice(index));
  if (braced) {
    const [text, kind, body] = braced;
    if (kind === "P" && body === "Word") {
      add_character_class_atom(operand, `[^${UNICODE_WORD_CHARS_IN_CLASS}]`, index);
    } else {
      const replacement2 = kind === "x" ? `\\u{${body}}` : kind === "p" && body === "Word" ? UNICODE_WORD_CHARS_IN_CLASS : text;
      append_character_class_fragment(operand, replacement2, kind === "p" || kind === "P", index);
    }
    return index + text.length;
  }
  const fixed_width = FIXED_WIDTH_ESCAPE_RE.exec(regex.slice(index));
  if (fixed_width) {
    append_character_class_fragment(operand, fixed_width[0]);
    return index + fixed_width[0].length;
  }
  if (index + 1 >= regex.length) {
    throw new SyntaxError(`Unterminated escape in character class at index ${index}`);
  }
  const next = character_at(regex, index + 1);
  const next_end = index + 1 + next.length;
  const raw_whitespace = RAW_WHITESPACE_ESCAPES.get(next);
  if (raw_whitespace !== undefined) {
    append_character_class_fragment(operand, raw_whitespace);
    return next_end;
  }
  const complement = CLASS_COMPLEMENT_ALTERNATIVES.get(next);
  if (complement !== undefined) {
    add_character_class_atom(operand, complement, index);
    return next_end;
  }
  const rewrite = CLASS_ESCAPE_REWRITES.get(next);
  let replacement;
  let set_valued = false;
  if (rewrite !== undefined) {
    replacement = rewrite;
    set_valued = next !== "a" && next !== "e";
  } else if (/[A-Za-z0-9]/.test(next)) {
    replacement = `\\${next}`;
  } else if (JS_SYNTAX_CHARS.includes(next) || next === "-") {
    replacement = `\\${next}`;
  } else {
    replacement = next;
  }
  append_character_class_fragment(operand, replacement, set_valued, index);
  return next_end;
};
var compile_character_set_union = (pieces) => {
  if (pieces.length === 1)
    return pieces[0];
  return `(?:(?=(?:${pieces.join("|")}))${ANY_CODE_POINT})`;
};
var compile_character_class_operand = (operand) => {
  const pieces = operand.fragment.length === 0 ? operand.alternatives : [`[${operand.fragment}]`, ...operand.alternatives];
  return compile_character_set_union(pieces);
};
var get_ascii_fold_additions = (positive_atom) => {
  const membership = compile_unicode_regexp(`^(?:${positive_atom})$`, "u");
  let additions = "";
  for (let offset = 0;offset < 26; ++offset) {
    const upper = String.fromCharCode(65 + offset);
    const lower = String.fromCharCode(97 + offset);
    const has_upper = membership.test(upper);
    const has_lower = membership.test(lower);
    if (has_upper !== has_lower)
      additions += has_upper ? lower : upper;
  }
  return additions;
};
var parse_character_class = (regex, start, ascii_fold, apply_ascii_fold = true, nesting_depth = 1) => {
  if (nesting_depth > MAX_CHARACTER_CLASS_NESTING_DEPTH) {
    throw new SyntaxError(`Maximum character-class nesting depth of ${MAX_CHARACTER_CLASS_NESTING_DEPTH} exceeded at index ${start}`);
  }
  let i = start + 1;
  const negated = regex[i] === "^";
  if (negated)
    ++i;
  const first_content_index = i;
  const operands = [create_character_class_operand()];
  let operand = operands[0];
  let contains_nested_negated_complex_set = false;
  while (i < regex.length) {
    const char = character_at(regex, i);
    if (char === "\\") {
      i = rewrite_character_class_escape(regex, i, operand);
      continue;
    }
    if (char === "]") {
      if (i === first_content_index) {
        append_character_class_fragment(operand, "\\]");
        ++i;
        continue;
      }
      if (operand.tail === null) {
        if (operands.length > 1) {
          throw new SyntaxError(`Malformed character-class intersection with an empty operand at index ${i}`);
        }
        throw new SyntaxError(`Empty character class at index ${start}`);
      }
      const contains_complex_set = operands.some((candidate) => candidate.contains_complex_set);
      if (negated && operands.length > 1 && contains_nested_negated_complex_set) {
        throw new SyntaxError(`Unsupported outer-negated character-class intersection with a nested negated class containing a Unicode property, POSIX class, or shorthand at index ${start}`);
      }
      const first_atom = compile_character_class_operand(operands[0]);
      let positive_atom = first_atom;
      if (operands.length > 1) {
        let lookaheads = "";
        for (let j = 1;j < operands.length; ++j) {
          lookaheads += `(?=${compile_character_class_operand(operands[j])})`;
        }
        positive_atom = `(?:${lookaheads}${first_atom})`;
      }
      const is_direct_class = operands.length === 1 && operand.alternatives.length === 0;
      let direct_fragment = operand.fragment;
      if (ascii_fold && apply_ascii_fold) {
        const additions = get_ascii_fold_additions(positive_atom);
        if (additions.length > 0) {
          if (is_direct_class) {
            direct_fragment += additions;
            positive_atom = `[${direct_fragment}]`;
          } else {
            positive_atom = compile_character_set_union([
              positive_atom,
              `[${additions}]`
            ]);
          }
        }
      }
      const atom = negated ? is_direct_class ? `[^${direct_fragment}]` : `(?:(?!${positive_atom})${ANY_CODE_POINT})` : positive_atom;
      return {
        atom,
        end: i + 1,
        negated,
        contains_complex_set,
        contains_nested_negated_complex_set
      };
    }
    if (regex.startsWith("&&", i)) {
      if (operand.tail === null) {
        throw new SyntaxError(`Malformed character-class intersection with an empty operand at index ${i}`);
      }
      operand = create_character_class_operand();
      operands.push(operand);
      i += 2;
      continue;
    }
    if (char === "[") {
      const suffix = regex.slice(i);
      if (EMPTY_NEGATED_POSIX_BRACKET_RE.test(suffix)) {
        throw new SyntaxError(`Malformed empty negated POSIX character class at index ${i}`);
      }
      const posix = POSIX_BRACKET_RE.exec(suffix);
      if (posix) {
        const [, posix_negated, name] = posix;
        const fragment = POSIX_CLASS_FRAGMENTS.get(name);
        if (fragment === undefined) {
          throw new SyntaxError(`Unsupported POSIX character class "${name}" at index ${i}`);
        }
        if (ascii_fold && posix_negated && (name === "lower" || name === "upper")) {
          throw new SyntaxError(`Unsupported negated POSIX ${name} class inside an inline case-insensitive group`);
        }
        if (posix_negated) {
          add_character_class_atom(operand, `[^${fragment}]`, i);
        } else {
          append_character_class_fragment(operand, fragment, true, i);
        }
        i += posix[0].length;
        continue;
      }
      if (UNSUPPORTED_POSIX_BRACKET_RE.test(suffix)) {
        throw new SyntaxError(`Unsupported POSIX collating or equivalence bracket expression at index ${i}`);
      }
      const nested = parse_character_class(regex, i, ascii_fold, false, nesting_depth + 1);
      add_character_class_atom(operand, nested.atom, i, nested.contains_complex_set);
      contains_nested_negated_complex_set ||= nested.contains_nested_negated_complex_set || nested.negated && nested.contains_complex_set;
      i = nested.end;
      continue;
    }
    if (char === "-") {
      const is_terminal_literal = regex[i + 1] === "]" || regex.startsWith("&&", i + 1);
      if (operand.tail === "set" && !is_terminal_literal) {
        throw_character_class_range_error(i);
      }
      if (operand.tail === null || operand.tail === "range" || operand.tail === "complete_range" || is_terminal_literal) {
        append_character_class_fragment(operand, "\\-");
      } else {
        operand.fragment += "-";
        operand.tail = "range";
      }
      ++i;
      continue;
    }
    append_character_class_fragment(operand, char === "^" && operand.fragment.length === 0 ? "\\^" : char);
    i += char.length;
  }
  throw new SyntaxError(`${operands.length > 1 ? "Unterminated character-class intersection" : "Unterminated character class"} at index ${start}`);
};
var rewrite_oniguruma_to_js = (regex) => {
  let out = "";
  let atom_start = -1;
  let last_was_quantifier = false;
  let ascii_fold = false;
  const group_states = [];
  const emit_atom = (text) => {
    atom_start = out.length;
    out += text;
    last_was_quantifier = false;
  };
  for (let i = 0;i < regex.length; ) {
    const char = character_at(regex, i);
    if (char === "\\") {
      const braced = BRACED_ESCAPE_RE.exec(regex.slice(i));
      if (braced) {
        const [text, kind, body] = braced;
        let replacement2 = text;
        if (kind === "x") {
          const code_point_escape = `\\u{${body}}`;
          replacement2 = ascii_fold ? get_ascii_folded_hex_atom(body) ?? code_point_escape : code_point_escape;
        } else if (body === "Word") {
          replacement2 = kind === "p" ? UNICODE_WORD_CLASS : UNICODE_NON_WORD_CLASS;
        }
        emit_atom(replacement2);
        i += text.length;
        continue;
      }
      const fixed_width = FIXED_WIDTH_ESCAPE_RE.exec(regex.slice(i));
      if (fixed_width) {
        const text = fixed_width[0];
        const replacement2 = ascii_fold && text[1] !== "c" ? get_ascii_folded_hex_atom(text.slice(2)) ?? text : text;
        emit_atom(replacement2);
        i += text.length;
        continue;
      }
      if (i + 1 >= regex.length) {
        out += char;
        break;
      }
      const next = character_at(regex, i + 1);
      i += 1 + next.length;
      if (next === "G") {
        continue;
      }
      const raw_whitespace = RAW_WHITESPACE_ESCAPES.get(next);
      if (raw_whitespace !== undefined) {
        emit_atom(raw_whitespace);
        continue;
      }
      const rewrite = ESCAPE_REWRITES.get(next);
      let replacement;
      if (rewrite !== undefined) {
        replacement = rewrite;
      } else if (/[A-Za-z0-9]/.test(next)) {
        replacement = `\\${next}`;
      } else if (JS_SYNTAX_CHARS.includes(next)) {
        replacement = `\\${next}`;
      } else {
        replacement = next;
      }
      emit_atom(replacement);
      continue;
    }
    switch (char) {
      case "[": {
        const parsed = parse_character_class(regex, i, ascii_fold);
        emit_atom(parsed.atom);
        i = parsed.end;
        continue;
      }
      case "]":
        emit_atom("\\]");
        ++i;
        continue;
      case ".":
        emit_atom("[^\\n]");
        ++i;
        continue;
      case "^":
        emit_atom(LINE_START_ANCHOR);
        ++i;
        continue;
      case "$":
        emit_atom(LINE_END_ANCHOR);
        ++i;
        continue;
      case "(": {
        const inline_case_insensitive = regex.startsWith("(?i:", i);
        const source_prefix = inline_case_insensitive ? "(?i:" : GROUP_PREFIX_RE.exec(regex.slice(i))?.[0] ?? "(";
        const output_prefix = inline_case_insensitive ? "(?:" : source_prefix === "(?>" ? "(?:" : source_prefix;
        group_states.push([out.length, ascii_fold]);
        if (inline_case_insensitive)
          ascii_fold = true;
        out += output_prefix;
        last_was_quantifier = false;
        i += source_prefix.length;
        continue;
      }
      case ")":
        out += char;
        [atom_start, ascii_fold] = group_states.pop() ?? [-1, false];
        last_was_quantifier = false;
        ++i;
        continue;
      case "|":
        out += char;
        atom_start = -1;
        last_was_quantifier = false;
        ++i;
        continue;
      case "{": {
        const quant = QUANTIFIER_BRACE_RE.exec(regex.slice(i));
        if (!quant || atom_start < 0) {
          emit_atom("\\{");
          ++i;
          continue;
        }
        const body = quant[1].startsWith(",") ? `0${quant[1]}` : quant[1];
        i += quant[0].length;
        const following = regex[i];
        if (following === "+" || following === "*") {
          out = `${out.slice(0, atom_start)}(?:${out.slice(atom_start)}{${body}})${following}`;
          ++i;
        } else {
          out += `{${body}}`;
        }
        last_was_quantifier = true;
        continue;
      }
      case "}":
        emit_atom("\\}");
        ++i;
        continue;
      case "+":
        if (last_was_quantifier) {
          ++i;
          continue;
        }
        out += char;
        last_was_quantifier = true;
        ++i;
        continue;
      case "*":
      case "?":
        out += char;
        last_was_quantifier = true;
        ++i;
        continue;
      default:
        emit_atom(ascii_fold && is_ascii_letter(char) ? `[${char.toLowerCase()}${char.toUpperCase()}]` : char);
        i += char.length;
        continue;
    }
  }
  return out;
};
var escape_reg_exp = (string) => string.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
var fuse_unk = (arr, tokens_to_ids, unk_token_id) => {
  const fused = [];
  let i = 0;
  while (i < arr.length) {
    fused.push(arr[i]);
    const token_id = tokens_to_ids.get(arr[i]) ?? unk_token_id;
    if (token_id !== unk_token_id) {
      ++i;
      continue;
    }
    while (++i < arr.length && (tokens_to_ids.get(arr[i]) ?? unk_token_id) === unk_token_id) {
      if (tokens_to_ids.get(fused.at(-1)) !== unk_token_id) {
        fused[fused.length - 1] += arr[i];
      }
    }
  }
  return fused;
};
var is_chinese_char = (cp) => cp >= 19968 && cp <= 40959 || cp >= 13312 && cp <= 19903 || cp >= 131072 && cp <= 173791 || cp >= 173824 && cp <= 177983 || cp >= 177984 && cp <= 178207 || cp >= 178208 && cp <= 183983 || cp >= 63744 && cp <= 64255 || cp >= 194560 && cp <= 195103;
var is_integral_number = (x) => Number.isInteger(x) || typeof x === "bigint";
var len = (s) => {
  let length = 0;
  for (const c of s)
    ++length;
  return length;
};
var lowercase_and_remove_accents = (text) => remove_accents(text.toLowerCase());
var merge_arrays = (...arrs) => Array.prototype.concat.apply([], arrs);
var object_to_map = (obj) => new Map(Object.entries(obj));
var regex_split = (text, regex) => {
  const result = [];
  let prev = 0;
  for (const match of text.matchAll(regex)) {
    const full_match = match[0];
    if (prev < match.index) {
      result.push(text.slice(prev, match.index));
    }
    if (full_match.length > 0) {
      result.push(full_match);
    }
    prev = match.index + full_match.length;
  }
  if (prev < text.length) {
    result.push(text.slice(prev));
  }
  return result;
};
var remove_accents = (text) => text.replace(/\p{M}/gu, "");
var validate_object = (obj, name, required_keys = []) => {
  if (!obj || Array.isArray(obj) || typeof obj !== "object") {
    return `${name} must be a valid object`;
  }
  for (const key of required_keys) {
    if (!(key in obj)) {
      return `${name} must contain a "${key}" property`;
    }
  }
  return null;
};
var whitespace_split = (text) => text.match(/\S+/g) || [];
var Callable = class {
  constructor() {
    const closure = function(...args) {
      return closure._call(...args);
    };
    return Object.setPrototypeOf(closure, new.target.prototype);
  }
};
var Callable_default = Callable;
var Normalizer = class extends Callable_default {
  constructor(config) {
    super();
    this.config = config;
  }
  _call(text) {
    return this.normalize(text);
  }
};
var Normalizer_default = Normalizer;
var BertNormalizer = class extends Normalizer_default {
  tokenize_chinese_chars(text) {
    const output = [];
    for (let i = 0;i < text.length; ++i) {
      const char = text[i];
      const cp = char.charCodeAt(0);
      if (is_chinese_char(cp)) {
        output.push(" ");
        output.push(char);
        output.push(" ");
      } else {
        output.push(char);
      }
    }
    return output.join("");
  }
  strip_accents(text) {
    return text.normalize("NFD").replace(/\p{Mn}/gu, "");
  }
  is_control(char) {
    switch (char) {
      case "\t":
      case `
`:
      case "\r":
        return false;
      default:
        return /^\p{Cc}|\p{Cf}|\p{Co}|\p{Cs}$/u.test(char);
    }
  }
  clean_text(text) {
    const output = [];
    for (const char of text) {
      const cp = char.charCodeAt(0);
      if (cp === 0 || cp === 65533 || this.is_control(char)) {
        continue;
      }
      if (/^\s$/.test(char)) {
        output.push(" ");
      } else {
        output.push(char);
      }
    }
    return output.join("");
  }
  normalize(text) {
    if (this.config.clean_text) {
      text = this.clean_text(text);
    }
    if (this.config.handle_chinese_chars) {
      text = this.tokenize_chinese_chars(text);
    }
    if (this.config.lowercase) {
      text = text.toLowerCase();
      if (this.config.strip_accents !== false) {
        text = this.strip_accents(text);
      }
    } else if (this.config.strip_accents) {
      text = this.strip_accents(text);
    }
    return text;
  }
};
var BertNormalizer_default = BertNormalizer;
var Precompiled = class extends Normalizer_default {
  constructor(config) {
    super(config);
    this.charsmap = config.precompiled_charsmap ?? null;
  }
  normalize(text) {
    text = text.replace(/[\u0001-\u0008\u000B\u000E-\u001F\u007F\u008F\u009F]/gm, "");
    text = text.replace(/[\u0009\u000A\u000C\u000D\u00A0\u1680\u2000-\u200F\u2028\u2029\u202F\u205F\u2581\u3000\uFEFF\uFFFD]/gm, " ");
    if (text.includes("～")) {
      const parts = text.split("～");
      text = parts.map((part) => part.normalize("NFKC")).join("～");
    } else {
      text = text.normalize("NFKC");
    }
    return text;
  }
};
var Precompiled_default = Precompiled;
var Sequence = class extends Normalizer_default {
  constructor(config) {
    super(config);
    this.normalizers = (config.normalizers ?? []).map((x) => create_normalizer_default(x));
  }
  normalize(text) {
    return this.normalizers.reduce((t, normalizer) => {
      return normalizer ? normalizer.normalize(t) : t;
    }, text);
  }
};
var Sequence_default = Sequence;
var Replace = class extends Normalizer_default {
  constructor(config) {
    super(config);
    this.pattern = create_pattern(this.config.pattern ?? {});
  }
  normalize(text) {
    return this.pattern === null ? text : text.replaceAll(this.pattern, this.config.content ?? "");
  }
};
var Replace_default = Replace;
var UnicodeNormalizer = class extends Normalizer_default {
  constructor() {
    super(...arguments);
    this.form = "NFC";
  }
  normalize(text) {
    text = text.normalize(this.form);
    return text;
  }
};
var UnicodeNormalizer_default = UnicodeNormalizer;
var NFC = class extends UnicodeNormalizer_default {
  constructor() {
    super(...arguments);
    this.form = "NFC";
  }
};
var NFC_default = NFC;
var NFD = class extends UnicodeNormalizer_default {
  constructor() {
    super(...arguments);
    this.form = "NFD";
  }
};
var NFD_default = NFD;
var NFKC = class extends UnicodeNormalizer_default {
  constructor() {
    super(...arguments);
    this.form = "NFKC";
  }
};
var NFKC_default = NFKC;
var NFKD = class extends UnicodeNormalizer_default {
  constructor() {
    super(...arguments);
    this.form = "NFKD";
  }
};
var NFKD_default = NFKD;
var Strip = class extends Normalizer_default {
  normalize(text) {
    if (this.config.strip_left && this.config.strip_right) {
      text = text.trim();
    } else {
      if (this.config.strip_left) {
        text = text.trimStart();
      }
      if (this.config.strip_right) {
        text = text.trimEnd();
      }
    }
    return text;
  }
};
var Strip_default = Strip;
var StripAccents = class extends Normalizer_default {
  normalize(text) {
    return remove_accents(text);
  }
};
var StripAccents_default = StripAccents;
var Lowercase = class extends Normalizer_default {
  normalize(text) {
    return text.toLowerCase();
  }
};
var Lowercase_default = Lowercase;
var Prepend = class extends Normalizer_default {
  normalize(text) {
    text = this.config.prepend + text;
    return text;
  }
};
var Prepend_default = Prepend;
function create_normalizer(config) {
  if (config === null)
    return null;
  switch (config.type) {
    case "BertNormalizer":
      return new BertNormalizer_default(config);
    case "Precompiled":
      return new Precompiled_default(config);
    case "Sequence":
      return new Sequence_default(config);
    case "Replace":
      return new Replace_default(config);
    case "NFC":
      return new NFC_default(config);
    case "NFD":
      return new NFD_default(config);
    case "NFKC":
      return new NFKC_default(config);
    case "NFKD":
      return new NFKD_default(config);
    case "Strip":
      return new Strip_default(config);
    case "StripAccents":
      return new StripAccents_default(config);
    case "Lowercase":
      return new Lowercase_default(config);
    case "Prepend":
      return new Prepend_default(config);
    default:
      throw new Error(`Unknown Normalizer type: ${config.type}`);
  }
}
var create_normalizer_default = create_normalizer;
var PreTokenizer = class extends Callable_default {
  pre_tokenize(text, options) {
    return (Array.isArray(text) ? text.map((x) => this.pre_tokenize_text(x, options)) : this.pre_tokenize_text(text, options)).flat();
  }
  _call(text, options) {
    return this.pre_tokenize(text, options);
  }
};
var PreTokenizer_default = PreTokenizer;
var BYTES_TO_UNICODE = (() => {
  const bs = [
    ...Array.from({ length: 126 - 33 + 1 }, (_, i) => i + 33),
    ...Array.from({ length: "¬".charCodeAt(0) - "¡".charCodeAt(0) + 1 }, (_, i) => i + "¡".charCodeAt(0)),
    ...Array.from({ length: "ÿ".charCodeAt(0) - "®".charCodeAt(0) + 1 }, (_, i) => i + "®".charCodeAt(0))
  ];
  const cs = bs.slice();
  let n = 0;
  for (let b = 0;b < 256; ++b) {
    if (!bs.includes(b)) {
      bs.push(b);
      cs.push(256 + n);
      n += 1;
    }
  }
  const ccs = cs.map((n2) => String.fromCharCode(n2));
  return Object.fromEntries(bs.map((b, i) => [b, ccs[i]]));
})();
var reverse_dictionary = (data) => Object.fromEntries(Object.entries(data).map(([key, value]) => [value, key]));
var UNICODE_TO_BYTES = reverse_dictionary(BYTES_TO_UNICODE);
var PUNCTUATION_REGEX = "\\p{P}\\u0021-\\u002F\\u003A-\\u0040\\u005B-\\u0060\\u007B-\\u007E";
var ByteLevel = class extends PreTokenizer_default {
  constructor(config) {
    super();
    this.config = config;
    this.add_prefix_space = this.config.add_prefix_space ?? false;
    this.trim_offsets = this.config.trim_offsets ?? false;
    this.use_regex = this.config.use_regex ?? true;
    this.pattern = /'s|'t|'re|'ve|'m|'ll|'d| ?\p{L}+| ?\p{N}+| ?[^\s\p{L}\p{N}]+|\s+(?!\S)|\s+/gu;
    this.byte_encoder = BYTES_TO_UNICODE;
    this.text_encoder = new TextEncoder;
  }
  pre_tokenize_text(text, options) {
    if (this.add_prefix_space && !text.startsWith(" ")) {
      text = " " + text;
    }
    const tokens = this.use_regex ? text.match(this.pattern) || [] : [text];
    return tokens.map((token) => Array.from(this.text_encoder.encode(token), (byte) => this.byte_encoder[byte]).join(""));
  }
};
var ByteLevel_default = ByteLevel;
var Whitespace = class extends PreTokenizer_default {
  pre_tokenize_text(text, options) {
    return text.match(/\w+|[^\w\s]+/g) || [];
  }
};
var Whitespace_default = Whitespace;
var Metaspace = class extends PreTokenizer_default {
  constructor(config) {
    super();
    this.replacement = config.replacement ?? "▁";
    this.str_rep = config.str_rep || this.replacement;
    this.prepend_scheme = config.prepend_scheme ?? "always";
  }
  pre_tokenize_text(text, options) {
    const { section_index = undefined } = options ?? {};
    let normalized = text.replaceAll(" ", this.str_rep);
    if (!normalized.startsWith(this.replacement) && (this.prepend_scheme === "always" || this.prepend_scheme === "first" && section_index === 0)) {
      normalized = this.str_rep + normalized;
    }
    return [normalized];
  }
};
var Metaspace_default = Metaspace;
var Split = class extends PreTokenizer_default {
  constructor(config) {
    super();
    this.config = config;
    this.pattern = create_pattern(this.config.pattern ?? {}, this.config.invert ?? true);
  }
  pre_tokenize_text(text) {
    if (this.pattern === null) {
      return [];
    }
    if (this.config.invert) {
      return (text.match(this.pattern) || []).filter((x) => x);
    } else if (this.config.behavior?.toLowerCase() === "removed") {
      return text.split(this.pattern).filter((x) => x);
    } else {
      return regex_split(text, this.pattern);
    }
  }
};
var Split_default = Split;
var Punctuation = class extends PreTokenizer_default {
  constructor(config) {
    super();
    this.config = config;
    this.pattern = new RegExp(`[^${PUNCTUATION_REGEX}]+|[${PUNCTUATION_REGEX}]+`, "gu");
  }
  pre_tokenize_text(text) {
    return text.match(this.pattern) || [];
  }
};
var Punctuation_default = Punctuation;
var Digits = class extends PreTokenizer_default {
  constructor(config) {
    super();
    this.config = config;
    const digit_pattern = `[^\\d]+|\\d${this.config.individual_digits ? "" : "+"}`;
    this.pattern = new RegExp(digit_pattern, "gu");
  }
  pre_tokenize_text(text) {
    return text.match(this.pattern) || [];
  }
};
var Digits_default = Digits;
var BertPreTokenizer = class extends PreTokenizer_default {
  constructor() {
    super();
    this.pattern = new RegExp(`[^\\s${PUNCTUATION_REGEX}]+|[${PUNCTUATION_REGEX}]`, "gu");
  }
  pre_tokenize_text(text, options) {
    return text.trim().match(this.pattern) || [];
  }
};
var BertPreTokenizer_default = BertPreTokenizer;
var Replace2 = class extends PreTokenizer_default {
  constructor(config) {
    super();
    this.config = config;
    this.pattern = create_pattern(this.config.pattern ?? {});
    this.content = this.config.content ?? "";
  }
  pre_tokenize_text(text) {
    if (this.pattern === null) {
      return [text];
    }
    return [text.replaceAll(this.pattern, this.config.content ?? "")];
  }
};
var Replace_default2 = Replace2;
var Sequence2 = class extends PreTokenizer_default {
  constructor(config) {
    super();
    this.tokenizers = (config.pretokenizers ?? []).map((x) => create_pre_tokenizer_default(x));
  }
  pre_tokenize_text(text, options) {
    return this.tokenizers.reduce((pre_tokenized_text, tokenizer) => {
      return tokenizer ? tokenizer.pre_tokenize(pre_tokenized_text, options) : pre_tokenized_text;
    }, [text]);
  }
};
var Sequence_default2 = Sequence2;
var WhitespaceSplit = class extends PreTokenizer_default {
  pre_tokenize_text(text) {
    return whitespace_split(text);
  }
};
var WhitespaceSplit_default = WhitespaceSplit;
var FixedLength = class extends PreTokenizer_default {
  constructor(config) {
    super();
    this.config = config;
    this._length = config.length;
  }
  pre_tokenize_text(text) {
    const tokens = [];
    for (let i = 0;i < text.length; i += this._length) {
      tokens.push(text.slice(i, i + this._length));
    }
    return tokens;
  }
};
var FixedLength_default = FixedLength;
function create_pre_tokenizer(config) {
  if (config === null)
    return null;
  switch (config.type) {
    case "BertPreTokenizer":
      return new BertPreTokenizer_default;
    case "Sequence":
      return new Sequence_default2(config);
    case "Whitespace":
      return new Whitespace_default;
    case "WhitespaceSplit":
      return new WhitespaceSplit_default;
    case "Metaspace":
      return new Metaspace_default(config);
    case "ByteLevel":
      return new ByteLevel_default(config);
    case "Split":
      return new Split_default(config);
    case "Punctuation":
      return new Punctuation_default(config);
    case "Digits":
      return new Digits_default(config);
    case "Replace":
      return new Replace_default2(config);
    case "FixedLength":
      return new FixedLength_default(config);
    default:
      throw new Error(`Unknown PreTokenizer type: ${config.type}`);
  }
}
var create_pre_tokenizer_default = create_pre_tokenizer;
var TokenizerModel = class extends Callable_default {
  constructor(config) {
    super();
    this.config = config;
    this.vocab = [];
    this.tokens_to_ids = /* @__PURE__ */ new Map;
    this.unk_token_id = undefined;
    this.unk_token = undefined;
    this.end_of_word_suffix = undefined;
    this.fuse_unk = this.config.fuse_unk ?? false;
  }
  _call(tokens) {
    let result = this.encode(tokens);
    if (this.fuse_unk) {
      result = fuse_unk(result, this.tokens_to_ids, this.unk_token_id);
    }
    return result;
  }
};
var TokenizerModel_default = TokenizerModel;
var WordPieceTokenizer2 = class extends TokenizerModel_default {
  constructor(config) {
    super(config);
    this.max_input_chars_per_word = 100;
    this.tokens_to_ids = object_to_map(config.vocab);
    this.unk_token_id = this.tokens_to_ids.get(config.unk_token);
    this.unk_token = config.unk_token;
    this.max_input_chars_per_word = config.max_input_chars_per_word ?? 100;
    this.vocab = new Array(this.tokens_to_ids.size);
    for (const [key, value] of this.tokens_to_ids) {
      this.vocab[value] = key;
    }
  }
  encode(tokens) {
    const output_tokens = [];
    for (const token of tokens) {
      const chars = [...token];
      if (chars.length > this.max_input_chars_per_word) {
        output_tokens.push(this.unk_token);
        continue;
      }
      let is_unknown = false;
      let start = 0;
      const sub_tokens = [];
      while (start < chars.length) {
        let end = chars.length;
        let current_substring = null;
        while (start < end) {
          let substr = chars.slice(start, end).join("");
          if (start > 0) {
            substr = this.config.continuing_subword_prefix + substr;
          }
          if (this.tokens_to_ids.has(substr)) {
            current_substring = substr;
            break;
          }
          --end;
        }
        if (current_substring === null) {
          is_unknown = true;
          break;
        }
        sub_tokens.push(current_substring);
        start = end;
      }
      if (is_unknown) {
        output_tokens.push(this.unk_token);
      } else {
        output_tokens.push(...sub_tokens);
      }
    }
    return output_tokens;
  }
};
var WordPiece_default = WordPieceTokenizer2;
var CharTrieNode = class _CharTrieNode {
  constructor(is_leaf, children) {
    this.is_leaf = is_leaf;
    this.children = children;
  }
  static default() {
    return new _CharTrieNode(false, /* @__PURE__ */ new Map);
  }
};
var CharTrie = class {
  constructor() {
    this.root = CharTrieNode.default();
  }
  extend(texts) {
    for (const text of texts) {
      this.push(text);
    }
  }
  push(text) {
    let node = this.root;
    for (const ch of text) {
      let child = node.children.get(ch);
      if (child === undefined) {
        child = CharTrieNode.default();
        node.children.set(ch, child);
      }
      node = child;
    }
    node.is_leaf = true;
  }
  *common_prefix_search(chars, start = 0) {
    let node = this.root;
    if (node === undefined)
      return;
    let prefix = "";
    for (let i = start;i < chars.length; ++i) {
      const ch = chars[i];
      prefix += ch;
      node = node.children.get(ch);
      if (node === undefined)
        return;
      if (node.is_leaf) {
        yield prefix;
      }
    }
  }
};
var CharTrie_default = CharTrie;
var TokenLatticeNode = class _TokenLatticeNode {
  constructor(token_id, node_id, pos, length, score) {
    this.token_id = token_id;
    this.node_id = node_id;
    this.pos = pos;
    this.length = length;
    this.score = score;
    this.prev = null;
    this.backtrace_score = 0;
  }
  clone() {
    const n = new _TokenLatticeNode(this.token_id, this.node_id, this.pos, this.length, this.score);
    n.prev = this.prev;
    n.backtrace_score = this.backtrace_score;
    return n;
  }
};
var TokenLattice = class {
  constructor(sentence, bos_token_id, eos_token_id) {
    this.chars = Array.from(sentence);
    this.len = this.chars.length;
    this.bos_token_id = bos_token_id;
    this.eos_token_id = eos_token_id;
    this.nodes = [];
    this.begin_nodes = Array.from({ length: this.len + 1 }, () => []);
    this.end_nodes = Array.from({ length: this.len + 1 }, () => []);
    const bos = new TokenLatticeNode(this.bos_token_id ?? 0, 0, 0, 0, 0);
    const eos = new TokenLatticeNode(this.eos_token_id ?? 0, 1, this.len, 0, 0);
    this.nodes.push(bos.clone());
    this.nodes.push(eos.clone());
    this.begin_nodes[this.len].push(eos);
    this.end_nodes[0].push(bos);
  }
  insert(pos, length, score, token_id) {
    const node_id = this.nodes.length;
    const node = new TokenLatticeNode(token_id, node_id, pos, length, score);
    this.begin_nodes[pos].push(node);
    this.end_nodes[pos + length].push(node);
    this.nodes.push(node);
  }
  viterbi() {
    const len2 = this.len;
    let pos = 0;
    while (pos <= len2) {
      if (this.begin_nodes[pos].length == 0) {
        return [];
      }
      for (let rnode of this.begin_nodes[pos]) {
        rnode.prev = null;
        let best_score = 0;
        let best_node = null;
        for (let lnode of this.end_nodes[pos]) {
          const score = lnode.backtrace_score + rnode.score;
          if (best_node === null || score > best_score) {
            best_node = lnode.clone();
            best_score = score;
          }
        }
        if (best_node !== null) {
          rnode.prev = best_node;
          rnode.backtrace_score = best_score;
        } else {
          return [];
        }
      }
      ++pos;
    }
    const results = [];
    const root = this.begin_nodes[len2][0];
    const prev = root.prev;
    if (prev === null) {
      return [];
    }
    let node = prev.clone();
    while (node.prev !== null) {
      results.push(node.clone());
      const n = node.clone();
      node = n.prev.clone();
    }
    results.reverse();
    return results;
  }
  piece(node) {
    return this.chars.slice(node.pos, node.pos + node.length).join("");
  }
  tokens() {
    const nodes = this.viterbi();
    return nodes.map((x) => this.piece(x));
  }
  token_ids() {
    const nodes = this.viterbi();
    return nodes.map((x) => x.token_id);
  }
};
var TokenLattice_default = TokenLattice;
function min(arr) {
  if (arr.length === 0)
    throw new Error("Array must not be empty");
  let min_value = arr[0];
  let index_of_min = 0;
  for (let i = 1;i < arr.length; ++i) {
    if (arr[i] < min_value) {
      min_value = arr[i];
      index_of_min = i;
    }
  }
  return [min_value, index_of_min];
}
var Unigram = class extends TokenizerModel_default {
  constructor(config, eos_token) {
    super(config);
    const vocab_size = config.vocab.length;
    this.vocab = new Array(vocab_size);
    this.scores = new Array(vocab_size);
    for (let i = 0;i < vocab_size; ++i) {
      [this.vocab[i], this.scores[i]] = config.vocab[i];
    }
    this.unk_token_id = config.unk_id;
    this.unk_token = this.vocab[config.unk_id];
    this.tokens_to_ids = new Map(this.vocab.map((x, i) => [x, i]));
    this.bos_token = " ";
    this.bos_token_id = this.tokens_to_ids.get(this.bos_token);
    this.eos_token = eos_token;
    this.eos_token_id = this.tokens_to_ids.get(this.eos_token);
    this.unk_token = this.vocab[this.unk_token_id];
    this.min_score = min(this.scores)[0];
    this.unk_score = this.min_score - 10;
    this.scores[this.unk_token_id] = this.unk_score;
    this.trie = new CharTrie_default;
    this.trie.extend(this.vocab);
    this.fuse_unk = true;
  }
  populate_nodes(lattice) {
    const chars = lattice.chars;
    const mblen = 1;
    let begin_pos = 0;
    while (begin_pos < chars.length) {
      let has_single_node = false;
      const prefixed_tokens = this.trie.common_prefix_search(chars, begin_pos);
      for (const token of prefixed_tokens) {
        const token_id = this.tokens_to_ids.get(token);
        const token_score = this.scores[token_id];
        const n = len(token);
        lattice.insert(begin_pos, n, token_score, token_id);
        if (!has_single_node && n === mblen) {
          has_single_node = true;
        }
      }
      if (!has_single_node) {
        lattice.insert(begin_pos, mblen, this.unk_score, this.unk_token_id);
      }
      begin_pos += mblen;
    }
  }
  tokenize(normalized) {
    const lattice = new TokenLattice_default(normalized, this.bos_token_id, this.eos_token_id);
    this.populate_nodes(lattice);
    return lattice.tokens();
  }
  encode(tokens) {
    const to_return = [];
    for (const token of tokens) {
      const tokenized = this.tokenize(token);
      to_return.push(...tokenized);
    }
    return to_return;
  }
};
var Unigram_default = Unigram;
var PriorityQueue = class {
  constructor(comparator = (a, b) => a > b, max_size = Infinity) {
    this._heap = [];
    this._comparator = comparator;
    this._max_size = max_size;
  }
  get size() {
    return this._heap.length;
  }
  is_empty() {
    return this.size === 0;
  }
  peek() {
    return this._heap[0];
  }
  push(...values) {
    return this.extend(values);
  }
  extend(values) {
    for (const value of values) {
      if (this.size < this._max_size) {
        this._heap.push(value);
        this._sift_up();
      } else {
        const smallest = this._smallest();
        if (this._comparator(value, this._heap[smallest])) {
          this._heap[smallest] = value;
          this._sift_up_from(smallest);
        }
      }
    }
    return this.size;
  }
  pop() {
    const popped_value = this.peek();
    const bottom = this.size - 1;
    if (bottom > 0) {
      this._swap(0, bottom);
    }
    this._heap.pop();
    this._sift_down();
    return popped_value;
  }
  replace(value) {
    const replaced_value = this.peek();
    this._heap[0] = value;
    this._sift_down();
    return replaced_value;
  }
  _parent(i) {
    return (i + 1 >>> 1) - 1;
  }
  _left(i) {
    return (i << 1) + 1;
  }
  _right(i) {
    return i + 1 << 1;
  }
  _greater(i, j) {
    return this._comparator(this._heap[i], this._heap[j]);
  }
  _swap(i, j) {
    const temp = this._heap[i];
    this._heap[i] = this._heap[j];
    this._heap[j] = temp;
  }
  _sift_up() {
    this._sift_up_from(this.size - 1);
  }
  _sift_up_from(node) {
    while (node > 0 && this._greater(node, this._parent(node))) {
      this._swap(node, this._parent(node));
      node = this._parent(node);
    }
  }
  _sift_down() {
    let node = 0;
    while (this._left(node) < this.size && this._greater(this._left(node), node) || this._right(node) < this.size && this._greater(this._right(node), node)) {
      const max_child = this._right(node) < this.size && this._greater(this._right(node), this._left(node)) ? this._right(node) : this._left(node);
      this._swap(node, max_child);
      node = max_child;
    }
  }
  _smallest() {
    return 2 ** Math.floor(Math.log2(this.size)) - 1;
  }
};
var PriorityQueue_default = PriorityQueue;
var LRUCache = class {
  constructor(capacity) {
    this.capacity = capacity;
    this.cache = /* @__PURE__ */ new Map;
  }
  get(key) {
    if (!this.cache.has(key))
      return;
    const value = this.cache.get(key);
    this.cache.delete(key);
    this.cache.set(key, value);
    return value;
  }
  put(key, value) {
    if (this.cache.has(key)) {
      this.cache.delete(key);
    }
    this.cache.set(key, value);
    if (this.cache.size > this.capacity) {
      this.cache.delete(this.cache.keys().next().value);
    }
  }
  clear() {
    this.cache.clear();
  }
};
var LRUCache_default = LRUCache;
var BPE = class extends TokenizerModel_default {
  constructor(config) {
    super(config);
    this.tokens_to_ids = object_to_map(config.vocab);
    this.unk_token_id = this.tokens_to_ids.get(config.unk_token);
    this.unk_token = config.unk_token;
    this.vocab = new Array(this.tokens_to_ids.size);
    for (const [key, value] of this.tokens_to_ids) {
      this.vocab[value] = key;
    }
    const use_new_merge_format = Array.isArray(config.merges[0]);
    this.merges = use_new_merge_format ? config.merges : config.merges.map((x) => x.split(" ", 2));
    this.bpe_ranks = new Map(this.merges.map((x, i) => [JSON.stringify(x), i]));
    this.end_of_word_suffix = config.end_of_word_suffix;
    this.continuing_subword_suffix = config.continuing_subword_suffix ?? null;
    this.byte_fallback = this.config.byte_fallback ?? false;
    if (this.byte_fallback) {
      this.text_encoder = new TextEncoder;
    }
    this.ignore_merges = this.config.ignore_merges ?? false;
    this.max_length_to_cache = 256;
    this.cache_capacity = 1e4;
    this.cache = new LRUCache_default(this.cache_capacity);
  }
  clear_cache() {
    this.cache.clear();
  }
  bpe(token) {
    if (token.length === 0) {
      return [];
    }
    const cached = this.cache.get(token);
    if (cached !== undefined) {
      return cached;
    }
    const word = Array.from(token);
    if (this.end_of_word_suffix) {
      word[word.length - 1] += this.end_of_word_suffix;
    }
    let result = [];
    if (word.length > 1) {
      const queue = new PriorityQueue_default((a, b) => a.score < b.score);
      let starting_node = {
        token: word[0],
        bias: 0,
        prev: null,
        next: null
      };
      let previous_node = starting_node;
      for (let i = 1;i < word.length; ++i) {
        const current_node = {
          bias: i / word.length,
          token: word[i],
          prev: previous_node,
          next: null
        };
        previous_node.next = current_node;
        this.add_node(queue, previous_node);
        previous_node = current_node;
      }
      while (!queue.is_empty()) {
        const node = queue.pop();
        if (node.deleted || !node.next || node.next.deleted)
          continue;
        node.deleted = true;
        node.next.deleted = true;
        if (node.prev) {
          const new_previous_node = { ...node.prev };
          node.prev.deleted = true;
          node.prev = new_previous_node;
          if (new_previous_node.prev) {
            new_previous_node.prev.next = new_previous_node;
          } else {
            starting_node = new_previous_node;
          }
        }
        const merged = {
          token: node.token + node.next.token,
          bias: node.bias,
          prev: node.prev,
          next: node.next.next
        };
        if (merged.prev) {
          merged.prev.next = merged;
          this.add_node(queue, merged.prev);
        } else {
          starting_node = merged;
        }
        if (merged.next) {
          merged.next.prev = merged;
          this.add_node(queue, merged);
        }
      }
      for (let current_node = starting_node;current_node !== null; current_node = current_node.next) {
        result.push(current_node.token);
      }
    } else {
      result = word;
    }
    if (this.continuing_subword_suffix) {
      for (let i = 0;i < result.length - 1; ++i) {
        result[i] += this.continuing_subword_suffix;
      }
    }
    if (token.length < this.max_length_to_cache) {
      this.cache.put(token, result);
    }
    return result;
  }
  add_node(queue, node) {
    const rank = this.bpe_ranks.get(JSON.stringify([node.token, node.next.token]));
    if (rank !== undefined) {
      node.score = rank + node.bias;
      queue.push(node);
    }
  }
  encode(tokens) {
    const output_tokens = [];
    for (const token of tokens) {
      if (this.ignore_merges && this.tokens_to_ids.has(token)) {
        output_tokens.push(token);
        continue;
      }
      const bpe_token_list = this.bpe(token);
      for (const t of bpe_token_list) {
        if (this.tokens_to_ids.has(t)) {
          output_tokens.push(t);
        } else if (this.byte_fallback) {
          const byte_tokens = Array.from(this.text_encoder.encode(t)).map((x) => `<0x${x.toString(16).toUpperCase().padStart(2, "0")}>`);
          if (byte_tokens.every((x) => this.tokens_to_ids.has(x))) {
            output_tokens.push(...byte_tokens);
          } else if (this.unk_token != null) {
            output_tokens.push(this.unk_token);
          }
        } else if (this.unk_token != null) {
          output_tokens.push(this.unk_token);
        }
      }
    }
    return output_tokens;
  }
};
var BPE_default = BPE;
var Legacy = class extends TokenizerModel_default {
  constructor(config, more_config) {
    super(config);
    const vocab = config.vocab;
    this.tokens_to_ids = object_to_map(more_config.target_lang ? vocab[more_config.target_lang] : vocab);
    this.bos_token = more_config.bos_token;
    this.bos_token_id = this.tokens_to_ids.get(this.bos_token);
    this.eos_token = more_config.eos_token;
    this.eos_token_id = this.tokens_to_ids.get(this.eos_token);
    this.pad_token = more_config.pad_token;
    this.pad_token_id = this.tokens_to_ids.get(this.pad_token);
    this.unk_token = more_config.unk_token;
    this.unk_token_id = this.tokens_to_ids.get(this.unk_token);
    this.vocab = new Array(this.tokens_to_ids.size);
    for (const [key, value] of this.tokens_to_ids) {
      this.vocab[value] = key;
    }
  }
  encode(tokens) {
    return tokens;
  }
};
var Legacy_default = Legacy;
function create_tokenizer_model(model_config, config) {
  switch (model_config.type) {
    case "WordPiece":
      return new WordPiece_default(model_config);
    case "Unigram":
      return new Unigram_default(model_config, config.eos_token);
    case "BPE":
      return new BPE_default(model_config);
    default:
      if (model_config.vocab) {
        if (Array.isArray(model_config.vocab)) {
          return new Unigram_default(model_config, config.eos_token);
        } else if (Object.hasOwn(model_config, "continuing_subword_prefix") && Object.hasOwn(model_config, "unk_token")) {
          if (Object.hasOwn(model_config, "merges")) {
            return new BPE_default(model_config);
          } else {
            return new WordPiece_default(model_config);
          }
        } else {
          return new Legacy_default(model_config, {
            target_lang: config.target_lang,
            bos_token: config.bos_token,
            eos_token: config.eos_token,
            pad_token: config.pad_token,
            unk_token: config.unk_token
          });
        }
      }
      throw new Error(`Unknown TokenizerModel type: ${model_config?.type}`);
  }
}
var create_tokenizer_model_default = create_tokenizer_model;
var PostProcessor = class extends Callable_default {
  constructor(config) {
    super();
    this.config = config;
  }
  _call(tokens, ...args) {
    return this.post_process(tokens, ...args);
  }
};
var PostProcessor_default = PostProcessor;
var TemplateProcessing = class extends PostProcessor_default {
  post_process(tokens, tokens_pair = null, add_special_tokens = true) {
    const type = tokens_pair === null ? this.config.single : this.config.pair;
    let processed_tokens = [];
    let types = [];
    for (const item of type) {
      if ("SpecialToken" in item) {
        if (add_special_tokens) {
          processed_tokens.push(item.SpecialToken.id);
          types.push(item.SpecialToken.type_id);
        }
      } else if ("Sequence" in item) {
        if (item.Sequence.id === "A") {
          processed_tokens = merge_arrays(processed_tokens, tokens);
          types = merge_arrays(types, new Array(tokens.length).fill(item.Sequence.type_id));
        } else if (item.Sequence.id === "B") {
          processed_tokens = merge_arrays(processed_tokens, tokens_pair);
          types = merge_arrays(types, new Array(tokens_pair.length).fill(item.Sequence.type_id));
        }
      }
    }
    return { tokens: processed_tokens, token_type_ids: types };
  }
};
var TemplateProcessing_default = TemplateProcessing;
var ByteLevel2 = class extends PostProcessor_default {
  post_process(tokens, tokens_pair = null) {
    return { tokens, tokens_pair };
  }
};
var ByteLevel_default2 = ByteLevel2;
var BertProcessing = class extends PostProcessor_default {
  constructor(config) {
    super(config);
    this.sep = config.sep;
    this.cls = config.cls;
  }
  post_process(tokens, tokens_pair = null, add_special_tokens = true) {
    if (add_special_tokens) {
      tokens = merge_arrays([this.cls[0]], tokens, [this.sep[0]]);
    }
    let token_type_ids = new Array(tokens.length).fill(0);
    if (tokens_pair) {
      const middle = [];
      const after = add_special_tokens ? [this.sep[0]] : [];
      tokens = merge_arrays(tokens, middle, tokens_pair, after);
      token_type_ids = merge_arrays(token_type_ids, new Array(tokens_pair.length + middle.length + after.length).fill(1));
    }
    return { tokens, token_type_ids };
  }
};
var BertProcessing_default = BertProcessing;
var RobertaProcessing = class extends PostProcessor_default {
  constructor(config) {
    super(config);
    this.sep = config.sep;
    this.cls = config.cls;
  }
  post_process(tokens, tokens_pair, add_special_tokens = true) {
    if (add_special_tokens) {
      tokens = merge_arrays([this.cls[0]], tokens, [this.sep[0]]);
    }
    let token_type_ids = new Array(tokens.length).fill(0);
    if (tokens_pair) {
      const middle = add_special_tokens ? [this.sep[0]] : [];
      const after = add_special_tokens ? [this.sep[0]] : [];
      tokens = merge_arrays(tokens, middle, tokens_pair, after);
      token_type_ids = merge_arrays(token_type_ids, new Array(tokens_pair.length + middle.length + after.length).fill(1));
    }
    return { tokens, token_type_ids };
  }
};
var RobertaProcessing_default = RobertaProcessing;
var Sequence3 = class extends PostProcessor_default {
  constructor(config) {
    super(config);
    this.processors = (config.processors ?? []).map((x) => create_post_processor_default(x));
  }
  post_process(tokens, tokens_pair = null, add_special_tokens = true) {
    let processed_tokens = { tokens, tokens_pair };
    for (const processor of this.processors) {
      processed_tokens = processor.post_process(processed_tokens.tokens, processed_tokens.tokens_pair, add_special_tokens);
    }
    return processed_tokens;
  }
};
var Sequence_default3 = Sequence3;
function create_post_processor(config) {
  if (config === null)
    return null;
  switch (config.type) {
    case "TemplateProcessing":
      return new TemplateProcessing_default(config);
    case "ByteLevel":
      return new ByteLevel_default2(config);
    case "BertProcessing":
      return new BertProcessing_default(config);
    case "RobertaProcessing":
      return new RobertaProcessing_default(config);
    case "Sequence":
      return new Sequence_default3(config);
    default:
      throw new Error(`Unknown PostProcessor type: ${config.type}`);
  }
}
var create_post_processor_default = create_post_processor;
var Decoder = class extends Callable_default {
  constructor(config) {
    super();
    this.config = config;
    this.added_tokens = [];
    this.end_of_word_suffix = null;
    this.trim_offsets = "trim_offsets" in config ? config.trim_offsets : false;
  }
  _call(tokens) {
    return this.decode(tokens);
  }
  decode(tokens) {
    return this.decode_chain(tokens).join("");
  }
};
var Decoder_default = Decoder;
var ByteLevel3 = class extends Decoder_default {
  constructor(config) {
    super(config);
    this.byte_decoder = UNICODE_TO_BYTES;
    this.text_decoder = new TextDecoder("utf-8", {
      fatal: false,
      ignoreBOM: true
    });
    this.end_of_word_suffix = null;
  }
  convert_tokens_to_string(tokens) {
    const text = tokens.join("");
    const byte_array = new Uint8Array([...text].map((c) => this.byte_decoder[c]));
    return this.text_decoder.decode(byte_array);
  }
  decode_chain(tokens) {
    const sub_texts = [];
    let current_sub_text = [];
    for (const token of tokens) {
      if (this.added_tokens.find((x) => x.content === token) !== undefined) {
        if (current_sub_text.length > 0) {
          sub_texts.push(this.convert_tokens_to_string(current_sub_text));
          current_sub_text = [];
        }
        sub_texts.push(token);
      } else {
        current_sub_text.push(token);
      }
    }
    if (current_sub_text.length > 0) {
      sub_texts.push(this.convert_tokens_to_string(current_sub_text));
    }
    return sub_texts;
  }
};
var ByteLevel_default3 = ByteLevel3;
var WordPiece = class extends Decoder_default {
  constructor(config) {
    super(config);
    this.cleanup = config.cleanup;
  }
  decode_chain(tokens) {
    return tokens.map((token, i) => {
      if (i !== 0) {
        const prefix = this.config.prefix;
        if (prefix && token.startsWith(prefix)) {
          token = token.replace(prefix, "");
        } else {
          token = " " + token;
        }
      }
      if (this.cleanup) {
        token = clean_up_tokenization(token);
      }
      return token;
    });
  }
};
var WordPiece_default2 = WordPiece;
var Metaspace2 = class extends Decoder_default {
  constructor(config) {
    super(config);
    this.replacement = config.replacement ?? "▁";
  }
  decode_chain(tokens) {
    const result = [];
    for (let i = 0;i < tokens.length; ++i) {
      let normalized = tokens[i].replaceAll(this.replacement, " ");
      if (i == 0 && normalized.startsWith(" ")) {
        normalized = normalized.substring(1);
      }
      result.push(normalized);
    }
    return result;
  }
};
var Metaspace_default2 = Metaspace2;
var BPE2 = class extends Decoder_default {
  constructor(config) {
    super(config);
    this.suffix = config.suffix ?? "";
  }
  decode_chain(tokens) {
    return tokens.map((token, i) => {
      return token.replaceAll(this.suffix, i === tokens.length - 1 ? "" : " ");
    });
  }
};
var BPE_default2 = BPE2;
var CTC = class extends Decoder_default {
  constructor(config) {
    super(config);
    this.pad_token = config.pad_token ?? "";
    this.word_delimiter_token = config.word_delimiter_token ?? "";
    this.cleanup = config.cleanup;
  }
  convert_tokens_to_string(tokens) {
    if (tokens.length === 0)
      return "";
    const grouped_tokens = [tokens[0]];
    for (let i = 1;i < tokens.length; ++i) {
      if (tokens[i] !== grouped_tokens.at(-1)) {
        grouped_tokens.push(tokens[i]);
      }
    }
    const filtered_tokens = grouped_tokens.filter((token) => token !== this.pad_token);
    let text = filtered_tokens.join("");
    if (this.cleanup) {
      text = clean_up_tokenization(text).replaceAll(this.word_delimiter_token, " ").trim();
    }
    return text;
  }
  decode_chain(tokens) {
    return [this.convert_tokens_to_string(tokens)];
  }
};
var CTC_default = CTC;
var Sequence4 = class extends Decoder_default {
  constructor(config) {
    super(config);
    this.decoders = (config.decoders ?? []).map((x) => create_decoder_default(x));
  }
  decode_chain(tokens) {
    return this.decoders.reduce((toks, decoder) => {
      return decoder.decode_chain(toks);
    }, tokens);
  }
};
var Sequence_default4 = Sequence4;
var Replace3 = class extends Decoder_default {
  constructor(config) {
    super(config);
    this.pattern = create_pattern(this.config.pattern);
  }
  decode_chain(tokens) {
    const content = this.config.content ?? "";
    const pattern = this.pattern;
    return pattern === null ? tokens : tokens.map((token) => token.replaceAll(pattern, content));
  }
};
var Replace_default3 = Replace3;
var Fuse = class extends Decoder_default {
  decode_chain(tokens) {
    return [tokens.join("")];
  }
};
var Fuse_default = Fuse;
var Strip2 = class extends Decoder_default {
  constructor(config) {
    super(config);
    this.content = config.content ?? "";
    this.start = config.start ?? 0;
    this.stop = config.stop ?? 0;
  }
  decode_chain(tokens) {
    return tokens.map((token) => {
      let start_cut = 0;
      for (let i = 0;i < this.start; ++i) {
        if (token[i] === this.content) {
          start_cut = i + 1;
          continue;
        } else {
          break;
        }
      }
      let stop_cut = token.length;
      for (let i = 0;i < this.stop; ++i) {
        const index = token.length - i - 1;
        if (token[index] === this.content) {
          stop_cut = index;
          continue;
        } else {
          break;
        }
      }
      return token.slice(start_cut, stop_cut);
    });
  }
};
var Strip_default2 = Strip2;
var ByteFallback = class extends Decoder_default {
  constructor(config) {
    super(config);
    this.text_decoder = new TextDecoder;
  }
  decode_chain(tokens) {
    const new_tokens = [];
    let previous_byte_tokens = [];
    for (const token of tokens) {
      let bytes = null;
      if (token.length === 6 && token.startsWith("<0x") && token.endsWith(">")) {
        const byte = parseInt(token.slice(3, 5), 16);
        if (!isNaN(byte)) {
          bytes = byte;
        }
      }
      if (bytes !== null) {
        previous_byte_tokens.push(bytes);
      } else {
        if (previous_byte_tokens.length > 0) {
          const string = this.text_decoder.decode(Uint8Array.from(previous_byte_tokens));
          new_tokens.push(string);
          previous_byte_tokens = [];
        }
        new_tokens.push(token);
      }
    }
    if (previous_byte_tokens.length > 0) {
      const string = this.text_decoder.decode(Uint8Array.from(previous_byte_tokens));
      new_tokens.push(string);
      previous_byte_tokens = [];
    }
    return new_tokens;
  }
};
var ByteFallback_default = ByteFallback;
function create_decoder(config) {
  if (config === null)
    return null;
  switch (config.type) {
    case "ByteLevel":
      return new ByteLevel_default3(config);
    case "WordPiece":
      return new WordPiece_default2(config);
    case "Metaspace":
      return new Metaspace_default2(config);
    case "BPEDecoder":
      return new BPE_default2(config);
    case "CTC":
      return new CTC_default(config);
    case "Sequence":
      return new Sequence_default4(config);
    case "Replace":
      return new Replace_default3(config);
    case "Fuse":
      return new Fuse_default(config);
    case "Strip":
      return new Strip_default2(config);
    case "ByteFallback":
      return new ByteFallback_default(config);
    default:
      throw new Error(`Unknown Decoder type: ${config.type}`);
  }
}
var create_decoder_default = create_decoder;
var Tokenizer = class {
  constructor(tokenizer, config) {
    const tokenizer_error = validate_object(tokenizer, "Tokenizer", [
      "model",
      "decoder",
      "post_processor",
      "pre_tokenizer",
      "normalizer"
    ]);
    if (tokenizer_error) {
      throw new Error(tokenizer_error);
    }
    const config_error = validate_object(config, "Config");
    if (config_error) {
      throw new Error(config_error);
    }
    this.tokenizer = tokenizer;
    this.config = config;
    this.normalizer = create_normalizer_default(this.tokenizer.normalizer);
    this.pre_tokenizer = create_pre_tokenizer_default(this.tokenizer.pre_tokenizer);
    this.model = create_tokenizer_model_default(this.tokenizer.model, this.config);
    this.post_processor = create_post_processor_default(this.tokenizer.post_processor);
    this.decoder = create_decoder_default(this.tokenizer.decoder);
    this.special_tokens = [];
    this.all_special_ids = [];
    this.added_tokens = [];
    const unnormalized_contents = [];
    const normalized_contents = [];
    this.added_tokens_map = /* @__PURE__ */ new Map;
    for (const added_token of this.tokenizer.added_tokens) {
      const token = new AddedToken_default(added_token);
      this.added_tokens.push(token);
      this.model.tokens_to_ids.set(token.content, token.id);
      this.model.vocab[token.id] = token.content;
      if (token.special) {
        this.special_tokens.push(token.content);
        this.all_special_ids.push(token.id);
      }
      this.added_tokens_map.set(token.content, token);
      if (token.normalized && this.normalizer !== null) {
        const normalized_content = this.normalizer(token.content);
        normalized_contents.push(normalized_content);
        this.added_tokens_map.set(normalized_content, token);
      } else {
        unnormalized_contents.push(token.content);
      }
    }
    (this.config.additional_special_tokens ?? []).forEach((token) => {
      if (!this.special_tokens.includes(token))
        this.special_tokens.push(token);
    });
    if (this.decoder) {
      this.decoder.added_tokens = this.added_tokens;
      this.decoder.end_of_word_suffix = this.model.end_of_word_suffix;
    }
    this.splitter_unnormalized = new DictionarySplitter_default(unnormalized_contents);
    this.splitter_normalized = new DictionarySplitter_default(normalized_contents);
    this.remove_space = this.config.remove_space;
    this.clean_up_tokenization_spaces = this.config.clean_up_tokenization_spaces ?? true;
    this.do_lowercase_and_remove_accent = this.config.do_lowercase_and_remove_accent ?? false;
  }
  encode(text, {
    text_pair = null,
    add_special_tokens = true,
    return_token_type_ids = null
  } = {}) {
    const { tokens, token_type_ids } = this.tokenize_helper(text, {
      text_pair,
      add_special_tokens
    });
    const input_ids = tokens.map((t) => this.added_tokens_map.get(t)?.id ?? this.model.tokens_to_ids.get(t) ?? this.model.unk_token_id);
    const result = {
      ids: input_ids,
      tokens,
      attention_mask: new Array(input_ids.length).fill(1)
    };
    if (return_token_type_ids && token_type_ids) {
      result.token_type_ids = token_type_ids;
    }
    return result;
  }
  decode(token_ids, options = {}) {
    if (!Array.isArray(token_ids) || token_ids.length === 0 || !is_integral_number(token_ids[0])) {
      throw Error("token_ids must be a non-empty array of integers.");
    }
    let tokens = token_ids.map((i) => this.model.vocab[Number(i)] ?? this.model.unk_token);
    if (options.skip_special_tokens) {
      tokens = tokens.filter((x) => !this.special_tokens.includes(x));
    }
    let decoded = this.decoder ? this.decoder(tokens) : tokens.join(" ");
    if (this.decoder && this.decoder.end_of_word_suffix) {
      decoded = decoded.replaceAll(this.decoder.end_of_word_suffix, " ");
      if (options.skip_special_tokens) {
        decoded = decoded.trim();
      }
    }
    if (options.clean_up_tokenization_spaces ?? this.clean_up_tokenization_spaces) {
      decoded = clean_up_tokenization(decoded);
    }
    return decoded;
  }
  tokenize(text, { text_pair = null, add_special_tokens = false } = {}) {
    return this.tokenize_helper(text, { text_pair, add_special_tokens }).tokens;
  }
  encode_text(text) {
    if (text === null) {
      return null;
    }
    const sections = this.splitter_unnormalized.split(text);
    sections.forEach((section, i) => {
      const added_token = this.added_tokens_map.get(section);
      if (added_token) {
        if (added_token.lstrip && i > 0) {
          sections[i - 1] = sections[i - 1].trimEnd();
        }
        if (added_token.rstrip && i < sections.length - 1) {
          sections[i + 1] = sections[i + 1].trimStart();
        }
      }
    });
    return sections.flatMap((processed_text, section_index) => {
      if (processed_text.length === 0) {
        return [];
      }
      if (this.added_tokens_map.has(processed_text)) {
        return [processed_text];
      }
      if (this.remove_space === true) {
        processed_text = processed_text.trim().split(/\s+/).join(" ");
      }
      if (this.do_lowercase_and_remove_accent) {
        processed_text = lowercase_and_remove_accents(processed_text);
      }
      if (this.normalizer !== null) {
        processed_text = this.normalizer(processed_text);
      }
      if (processed_text.length === 0) {
        return [];
      }
      const subsections = this.splitter_normalized.split(processed_text);
      subsections.forEach((subsection, j) => {
        const added_token = this.added_tokens_map.get(subsection);
        if (added_token) {
          if (added_token.lstrip && j > 0) {
            subsections[j - 1] = subsections[j - 1].trimEnd();
          }
          if (added_token.rstrip && j < subsections.length - 1) {
            subsections[j + 1] = subsections[j + 1].trimStart();
          }
        }
      });
      return subsections.flatMap((subsection) => {
        if (subsection.length === 0) {
          return [];
        }
        if (this.added_tokens_map.has(subsection)) {
          return [subsection];
        }
        const section_tokens = this.pre_tokenizer !== null ? this.pre_tokenizer(subsection, {
          section_index
        }) : [subsection];
        return this.model(section_tokens);
      });
    });
  }
  tokenize_helper(text, { text_pair = null, add_special_tokens = true }) {
    const tokens1 = this.encode_text(text);
    const tokens2 = this.encode_text(text_pair || null);
    return this.post_processor ? this.post_processor(tokens1, tokens2, add_special_tokens) : { tokens: merge_arrays(tokens1 ?? [], tokens2 ?? []) };
  }
  token_to_id(token) {
    return this.model.tokens_to_ids.get(token);
  }
  id_to_token(id) {
    return this.model.vocab[id];
  }
  get_added_tokens_decoder() {
    const decoder = /* @__PURE__ */ new Map;
    for (const token of this.added_tokens) {
      decoder.set(token.id, token);
    }
    return decoder;
  }
  get_vocab(with_added_tokens = true) {
    const vocab = /* @__PURE__ */ new Map;
    for (let i = 0;i < this.model.vocab.length; ++i) {
      const token = this.model.vocab[i];
      if (with_added_tokens || !this.added_tokens_map.has(token)) {
        vocab.set(token, i);
      }
    }
    return vocab;
  }
};
var Tokenizer_default = Tokenizer;

// src/workers/source-index/built-in-embedding/precompiled-charsmap.ts
class CharsmapNormalizer extends Precompiled_default {
  trie;
  replacements;
  graphemes = new Intl.Segmenter("und", { granularity: "grapheme" });
  constructor(charsmap) {
    super({ type: "Precompiled", precompiled_charsmap: charsmap });
    const data = Buffer.from(charsmap, "base64");
    if (data.length < 8)
      throw new Error("Invalid precompiled character map.");
    const bytes = data.readUInt32LE(0);
    if (bytes < 4 || bytes % 4 || bytes + 4 >= data.length)
      throw new Error("Invalid precompiled character map.");
    this.trie = new Uint32Array(bytes / 4);
    for (let i = 0;i < this.trie.length; i += 1)
      this.trie[i] = data.readUInt32LE(4 + i * 4);
    this.replacements = data.subarray(4 + bytes);
  }
  transform(text) {
    const offset = (unit) => unit >>> 10 << ((unit & 512) >>> 6) >>> 0;
    let node = offset(this.trie[0]);
    for (const byte of Buffer.from(text, "utf8")) {
      if (byte === 0)
        break;
      node = (node ^ byte) >>> 0;
      const unit = this.trie[node];
      if (unit === undefined || (unit & 2147483903) >>> 0 !== byte)
        return;
      node = (node ^ offset(unit)) >>> 0;
      if (unit & 256) {
        const leaf = this.trie[node];
        if (leaf === undefined)
          throw new Error("Invalid precompiled character map leaf.");
        const start = leaf & 2147483647;
        const end = this.replacements.indexOf(0, start);
        if (end < 0)
          throw new Error("Invalid precompiled character map replacement.");
        return this.replacements.toString("utf8", start, end);
      }
    }
    return;
  }
  normalize(text) {
    let result = "";
    for (const { segment } of this.graphemes.segment(text)) {
      const mapped = Buffer.byteLength(segment) < 6 ? this.transform(segment) : undefined;
      result += mapped ?? Array.from(segment, (char) => this.transform(char) ?? char).join("");
    }
    return result;
  }
}

// src/workers/source-index/built-in-embedding/json-tokenizer.ts
function exactCharsmaps(normalizer) {
  if (normalizer instanceof Precompiled_default)
    return new CharsmapNormalizer(normalizer.charsmap);
  if (normalizer instanceof Sequence_default)
    normalizer.normalizers = normalizer.normalizers.map(exactCharsmaps);
  return normalizer;
}

class JsonPairTokenizer {
  tokenizer;
  specialCount;
  padId;
  constructor(json) {
    const data = JSON.parse(json);
    if (data.model?.type !== "Unigram" && data.model?.type !== "BPE") {
      throw new Error("The reranker tokenizer.json must use Unigram or BPE.");
    }
    if (!data.post_processor)
      throw new Error("The reranker tokenizer.json needs a pair post_processor.");
    this.tokenizer = new Tokenizer_default(data, {});
    this.tokenizer.normalizer = exactCharsmaps(this.tokenizer.normalizer);
    const pad = data.padding?.pad_id ?? this.tokenizer.token_to_id("<pad>") ?? this.tokenizer.token_to_id("[PAD]");
    if (!Number.isSafeInteger(pad) || pad < 0)
      throw new Error("The reranker tokenizer.json is missing a padding token.");
    this.padId = pad;
    this.specialCount = this.postProcess([], []).ids.length;
  }
  postProcess(a, b) {
    const output = this.tokenizer.post_processor.post_process(a, b, true);
    const tokens = [...output.tokens, ...output.tokens_pair ?? []];
    const ids = tokens.map((token) => {
      const id = this.tokenizer.token_to_id(token) ?? this.tokenizer.model?.unk_token_id;
      if (id === undefined)
        throw new Error("The reranker pair template contains a token outside its vocabulary.");
      return id;
    });
    return { ids, typeIds: output.token_type_ids ?? ids.map(() => 0) };
  }
  encodePair(first, second, maxLength) {
    if (!Number.isSafeInteger(maxLength) || maxLength < this.specialCount) {
      throw new Error("The reranker token window cannot hold its pair template.");
    }
    const { a, b, truncated } = truncatePair(this.tokenizer.tokenize(first), this.tokenizer.tokenize(second), maxLength - this.specialCount, "huggingface");
    return { ...this.postProcess(a, b), truncated };
  }
}

// src/workers/source-index/built-in-reranker-manifest.ts
function candidate(modelId, repository, revision, modelFile, modelBytes, modelSha256, tokenizerFile, tokenizerBytes, tokenizerSha256) {
  const base = `https://huggingface.co/${repository}/resolve/${revision}`;
  return {
    modelId,
    repository,
    revision,
    license: "Apache-2.0",
    maxTokens: 512,
    model: { name: "model.onnx", url: `${base}/${modelFile}`, bytes: modelBytes, sha256: modelSha256 },
    tokenizer: { name: tokenizerFile, url: `${base}/${tokenizerFile}`, bytes: tokenizerBytes, sha256: tokenizerSha256 }
  };
}
var MS_MARCO_MINILM_L6_V2 = candidate("ms-marco-MiniLM-L6-v2-fp32-233902d", "cross-encoder/ms-marco-MiniLM-L6-v2", "233902d25c440f23af6f7d6e94d2946bac0bee0a", "onnx/model.onnx", 91011230, "5d3e70fd0c9ff14b9b5169a51e957b7a9c74897afd0a35ce4bd318150c1d4d4a", "vocab.txt", 231508, "07eced375cec144d27c900241f3e339478dec958f92fddbc551f295c992038a3");
var MMARCO_MMINILMV2_L12_H384_V1 = candidate("mmarco-mMiniLMv2-L12-H384-v1-int8-1427fd6", "cross-encoder/mmarco-mMiniLMv2-L12-H384-v1", "1427fd652930e4ba29e8149678df786c240d8825", "onnx/model_qint8_arm64.onnx", 118620017, "1825907d6c1a9001ff78124780bbde20a614a8c3df3b63409cf3c72c6fe5c8b4", "tokenizer.json", 17082660, "62c24cdc13d4c9952d63718d6c9fa4c287974249e16b7ade6d5a85e7bbb75626");

// src/workers/source-index/built-in-reranker.ts
var SOURCE_RERANKER_ENV = "OLYMPUS_SOURCE_RERANKER";
var SOURCE_RERANKER_MODEL_DIR_ENV = "OLYMPUS_SOURCE_RERANKER_MODEL_DIR";
var SOURCE_RERANKER_POOL_ENV = "OLYMPUS_SOURCE_RERANKER_POOL";
var SOURCE_RERANKER_THREADS_ENV = "OLYMPUS_SOURCE_RERANKER_THREADS";
var SOURCE_RERANKER_RUNTIME_DIR_ENV = "OLYMPUS_SOURCE_RERANKER_ONNX_RUNTIME_DIR";
var SOURCE_RERANKER_MAX_TOKENS_ENV = "OLYMPUS_SOURCE_RERANKER_MAX_TOKENS";
var MAX_PAIR_TOKENS = 512;
var BATCH_SIZE = 8;
function createCrossEncoderReranker(options) {
  const maxPairTokens = options.maxPairTokens ?? MAX_PAIR_TOKENS;
  const batchSize = Math.max(1, options.batchSize ?? BATCH_SIZE);
  let loading;
  const session = () => {
    loading ??= options.session().catch((error) => {
      loading = undefined;
      throw error;
    });
    return loading;
  };
  return {
    id: options.id,
    localOnly: true,
    poolSize: options.poolSize ?? DEFAULT_RERANK_POOL_SIZE,
    async prepare() {
      await session();
    },
    async score(request) {
      const model = await session();
      const scores = [];
      for (let start = 0;start < request.passages.length; start += batchSize) {
        if (request.signal.aborted)
          throw new Error("Reranking was abandoned.");
        const pairs = request.passages.slice(start, start + batchSize).map((passage) => options.tokenizer.encodePair(request.query, passage, maxPairTokens));
        const sequenceLength = Math.max(...pairs.map((pair) => pair.ids.length));
        const size = pairs.length * sequenceLength;
        const inputIds = new BigInt64Array(size).fill(BigInt(options.tokenizer.padId));
        const attentionMask = new BigInt64Array(size);
        const tokenTypeIds = new BigInt64Array(size);
        pairs.forEach((pair, row) => {
          pair.ids.forEach((id, column) => {
            const at = row * sequenceLength + column;
            inputIds[at] = BigInt(id);
            attentionMask[at] = 1n;
            tokenTypeIds[at] = BigInt(pair.typeIds[column]);
          });
        });
        const output = await model.run({ inputIds, attentionMask, tokenTypeIds, batchSize: pairs.length, sequenceLength });
        if (output.dims.length !== 2 || output.dims[0] !== pairs.length || output.dims[1] !== 1) {
          throw new Error("The reranker model returned an unexpected output.");
        }
        scores.push(...output.data);
      }
      return scores;
    }
  };
}
function builtInRerankerFromEnv(options = {}) {
  const env = options.env ?? process.env;
  if (env[SOURCE_RERANKER_ENV]?.trim().toLowerCase() !== "built-in")
    return;
  const modelDir = env[SOURCE_RERANKER_MODEL_DIR_ENV]?.trim();
  if (!modelDir || !isAbsolute8(modelDir))
    return;
  const modelPath = join12(modelDir, "model.onnx");
  const vocabularyPath = join12(modelDir, "vocab.txt");
  const tokenizerPath = join12(modelDir, "tokenizer.json");
  if (!existsSync8(modelPath) || !existsSync8(vocabularyPath) && !existsSync8(tokenizerPath))
    return;
  if (isMainThread5 && !options.runtime) {
    const handle = modelThreadHandleId();
    let loading;
    const prepare = () => loading ??= modelThread().call({ kind: "reranker-load", handle, env }).catch((error) => {
      loading = undefined;
      throw error;
    });
    return {
      id: `cross-encoder:${modelDir.split(/[\\/]/).filter(Boolean).pop() ?? "model"}`,
      localOnly: true,
      poolSize: positiveInteger2(env[SOURCE_RERANKER_POOL_ENV]) ?? DEFAULT_RERANK_POOL_SIZE,
      prepare,
      async score({ signal, ...request }) {
        if (signal.aborted)
          throw new Error("Reranking was abandoned.");
        await prepare();
        return modelThread().call({ kind: "reranker-run", handle, request }, { signal });
      }
    };
  }
  const runtimeDir = env[SOURCE_RERANKER_RUNTIME_DIR_ENV]?.trim() || builtInEmbeddingPaths(env, ARCTIC_EMBED_M_V1_5).runtimeDir;
  const runtime = options.runtime ?? onnxRuntimeFromDirectory(runtimeDir);
  const threads = positiveInteger2(env[SOURCE_RERANKER_THREADS_ENV]) ?? Math.max(1, Math.min(4, Math.floor(availableParallelism2() / 2)));
  const poolSize = positiveInteger2(env[SOURCE_RERANKER_POOL_ENV]);
  const maxTokens = positiveInteger2(env[SOURCE_RERANKER_MAX_TOKENS_ENV]);
  const maxPairTokens = maxTokens === undefined ? undefined : Math.min(MAX_PAIR_TOKENS, Math.max(32, maxTokens));
  return createCrossEncoderReranker({
    id: `cross-encoder:${modelDir.split(/[\\/]/).filter(Boolean).pop() ?? "model"}`,
    session: () => runtime.createSession(modelPath, { threads }),
    tokenizer: existsSync8(vocabularyPath) ? new WordPieceTokenizer(readFileSync10(vocabularyPath, "utf8")) : new JsonPairTokenizer(readFileSync10(tokenizerPath, "utf8")),
    ...poolSize !== undefined ? { poolSize } : {},
    ...maxPairTokens !== undefined ? { maxPairTokens } : {}
  });
}
function positiveInteger2(value) {
  const parsed = Number(value?.trim());
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

// src/workers/source-index/built-in-reasoning/install.ts
import { isMainThread as isMainThread6 } from "node:worker_threads";
import { spawn as spawn2 } from "node:child_process";
import { createHash as createHash4, randomUUID as randomUUID4 } from "node:crypto";
import {
  closeSync as closeSync7,
  createReadStream as createReadStream3,
  existsSync as existsSync9,
  mkdirSync as mkdirSync6,
  openSync as openSync7,
  readFileSync as readFileSync11,
  readdirSync as readdirSync4,
  renameSync as renameSync5,
  rmSync as rmSync5,
  statSync as statSync7,
  statfsSync,
  writeFileSync as writeFileSync4,
  writeSync as writeSync3
} from "node:fs";
import { dirname as dirname12, isAbsolute as isAbsolute9, join as join13 } from "node:path";

// src/workers/source-index/built-in-reasoning/manifest.ts
var GIB = 1024 ** 3;
function unslothQwen(size, revision, bytes, sha256) {
  const name = `Qwen3.5-${size}-Q4_K_M.gguf`;
  return {
    name,
    url: `https://huggingface.co/unsloth/Qwen3.5-${size}-GGUF/resolve/${revision}/${name}`,
    bytes,
    sha256
  };
}
var QWEN35_2B_REVISION = "f6d5376be1edb4d416d56da11e5397a961aca8ae";
var QWEN35_4B_REVISION = "e87f176479d0855a907a41277aca2f8ee7a09523";
var QWEN35_9B_REVISION = "3885219b6810b007914f3a7950a8d1b469d598a5";
var QWEN35_2B = {
  modelId: "qwen3.5-2b-q4_k_m-f6d5376",
  displayName: "Qwen3.5 2B",
  sizeClass: "small",
  baseRepository: "Qwen/Qwen3.5-2B",
  license: "Apache-2.0",
  repository: "unsloth/Qwen3.5-2B-GGUF",
  revision: QWEN35_2B_REVISION,
  file: unslothQwen("2B", QWEN35_2B_REVISION, 1280835840, "aaf42c8b7c3cab2bf3d69c355048d4a0ee9973d48f16c731c0520ee914699223"),
  minimumMemoryBytes: 7 * GIB,
  contextTokens: 12288
};
var QWEN35_4B = {
  modelId: "qwen3.5-4b-q4_k_m-e87f176",
  displayName: "Qwen3.5 4B",
  sizeClass: "standard",
  baseRepository: "Qwen/Qwen3.5-4B",
  license: "Apache-2.0",
  repository: "unsloth/Qwen3.5-4B-GGUF",
  revision: QWEN35_4B_REVISION,
  file: unslothQwen("4B", QWEN35_4B_REVISION, 2740937888, "00fe7986ff5f6b463e62455821146049db6f9313603938a70800d1fb69ef11a4"),
  minimumMemoryBytes: 15 * GIB,
  contextTokens: 12288
};
var QWEN35_9B = {
  modelId: "qwen3.5-9b-q4_k_m-3885219",
  displayName: "Qwen3.5 9B",
  sizeClass: "large",
  baseRepository: "Qwen/Qwen3.5-9B",
  license: "Apache-2.0",
  repository: "unsloth/Qwen3.5-9B-GGUF",
  revision: QWEN35_9B_REVISION,
  file: unslothQwen("9B", QWEN35_9B_REVISION, 5680522464, "03b74727a860a56338e042c4420bb3f04b2fec5734175f4cb9fa853daf52b7e8"),
  minimumMemoryBytes: 15 * GIB,
  contextTokens: 12288
};
var LLAMA_CPP_RELEASE = "b11320";
var LLAMA_CPP_BASE = `https://github.com/ggml-org/llama.cpp/releases/download/${LLAMA_CPP_RELEASE}`;
var LLAMA_SERVER_RUNTIME = {
  release: LLAMA_CPP_RELEASE,
  license: "MIT",
  archives: [
    {
      platform: "darwin-arm64",
      name: `llama-${LLAMA_CPP_RELEASE}-bin-macos-arm64.tar.gz`,
      url: `${LLAMA_CPP_BASE}/llama-${LLAMA_CPP_RELEASE}-bin-macos-arm64.tar.gz`,
      bytes: 11827796,
      sha256: "f6f337fc7d2ff9260f53177cf4fe6bbf6b0f7faa75a49fb224aaf66885a5c956",
      gpu: true
    },
    {
      platform: "linux-x64",
      name: `llama-${LLAMA_CPP_RELEASE}-bin-ubuntu-x64.tar.gz`,
      url: `${LLAMA_CPP_BASE}/llama-${LLAMA_CPP_RELEASE}-bin-ubuntu-x64.tar.gz`,
      bytes: 17544875,
      sha256: "ef1856938dc1434138ce53688791eb0d2d64cf46e309a0942a12bba3366c0919",
      gpu: false
    },
    {
      platform: "linux-arm64",
      name: `llama-${LLAMA_CPP_RELEASE}-bin-ubuntu-arm64.tar.gz`,
      url: `${LLAMA_CPP_BASE}/llama-${LLAMA_CPP_RELEASE}-bin-ubuntu-arm64.tar.gz`,
      bytes: 13590823,
      sha256: "88589b963d8e2ffd2d4df2f542ed7e301fb636b637c99081f5d58646aee20a9a",
      gpu: false
    }
  ]
};
var QWEN3_ASR_06B_REVISION = "928ab958557df9aa2ef1c93e0e83c7ad0933fae2";
function ggmlOrgAsrFile(name, bytes, sha256) {
  return {
    name,
    url: `https://huggingface.co/ggml-org/Qwen3-ASR-0.6B-GGUF/resolve/${QWEN3_ASR_06B_REVISION}/${name}`,
    bytes,
    sha256
  };
}
var QWEN3_ASR_06B = {
  modelId: "qwen3-asr-0.6b-q8_0-928ab95",
  displayName: "Qwen3-ASR 0.6B",
  baseRepository: "Qwen/Qwen3-ASR-0.6B",
  license: "Apache-2.0",
  repository: "ggml-org/Qwen3-ASR-0.6B-GGUF",
  revision: QWEN3_ASR_06B_REVISION,
  files: [
    ggmlOrgAsrFile("Qwen3-ASR-0.6B-Q8_0.gguf", 804749248, "bca259818b50ca7c4c05e9bdb35a5dc04fa039653a6d6f3f0f331f96f6aa1971"),
    ggmlOrgAsrFile("mmproj-Qwen3-ASR-0.6B-Q8_0.gguf", 214392480, "41a342b5e4c514e968cb756de6cd1b7be39eff43c44c57a2ef5fc6522e36603d")
  ],
  minimumMemoryBytes: 7 * GIB,
  contextTokens: 4096
};
function runtimeArchiveFor(platform, runtime = LLAMA_SERVER_RUNTIME) {
  return runtime.archives.find((archive) => archive.platform === platform);
}

// src/workers/source-index/built-in-reasoning/install.ts
var STALE_LOCK_MS2 = 60 * 60000;
var LOCK_REFRESH_MS = 30000;
var LOCK_POLL_MS2 = 1000;
var BUILT_IN_REASONING_SPACE_HEADROOM_BYTES = 2 * 1024 ** 3;
var RUNTIME_UNPACK_FACTOR = 4;
var SPACE_BACKOFF_MS = 15 * 60000;
var PROGRESS_WRITE_INTERVAL_MS2 = 500;
var DOWNLOAD_STALL_MS2 = 2 * 60000;
var VERIFY_TIMEOUT_MS = 15 * 60000;
var EXTRACT_TIMEOUT_MS = 5 * 60000;
var LOG_PREFIX = "[built-in-model]";
var RUNTIME_MARKER2 = "olympus-runtime.json";
var SERVER_BINARY = "llama-server";

class BuiltInReasoningInstallError extends Error {
  reason;
  shortfall;
  constructor(reason, message2, shortfall) {
    super(message2);
    this.name = "BuiltInReasoningInstallError";
    this.reason = reason;
    this.shortfall = shortfall;
  }
}
function currentPlatform2() {
  return `${process.platform}-${process.arch}`;
}
function readPinnedModelStatus(statusPath, modelId, noun) {
  const fallback = {
    state: "not_started",
    modelId,
    percent: 0,
    label: `${capitalize(noun)} not downloaded yet`,
    bytesDone: 0,
    bytesTotal: 0,
    updatedAt: new Date(0).toISOString()
  };
  try {
    const parsed = JSON.parse(readFileSync11(statusPath, "utf8"));
    return parsed && typeof parsed === "object" && parsed.modelId === modelId ? parsed : fallback;
  } catch {
    return fallback;
  }
}
async function installPinnedModel(options) {
  const { onProgress, log: installLog, ...serializable } = options;
  if (isMainThread6 && !Object.values(serializable).some((value) => typeof value === "function")) {
    try {
      return await modelThread().call({ kind: "install", options: serializable }, {
        progress: onProgress,
        log: installLog ?? ((line) => console.log(line))
      });
    } catch (error) {
      const failure = error;
      const reason = failure.reason ?? "disk_write_failed";
      if (!failure.reason) {
        reportPinnedModelState({ statusPath: options.layout.statusPath, modelId: options.bundle.modelId, noun: options.layout.noun }, "failed", { reason, message: failure.message });
      }
      throw new BuiltInReasoningInstallError(reason, failure.message, failure.shortfall);
    }
  }
  const { bundle, layout: paths } = options;
  const noun = paths.noun;
  const runtime = options.runtime ?? LLAMA_SERVER_RUNTIME;
  const platform = options.platform ?? currentPlatform2();
  const reporter = new ProgressReporter2(paths.statusPath, bundle.modelId, noun, options.now, options.onProgress);
  const files = bundle.files.map((file) => ({ file, path: join13(paths.modelDir, file.name) }));
  const filesPresent = () => files.every(({ path }) => existsSync9(path));
  const log = options.log ?? ((line) => console.log(line));
  const timing = {
    downloadStallMs: options.downloadStallMs ?? DOWNLOAD_STALL_MS2,
    verifyTimeoutMs: options.verifyTimeoutMs ?? VERIFY_TIMEOUT_MS
  };
  const lockWaitMs = options.lockWaitMs ?? STALE_LOCK_MS2;
  const lockRefreshMs = options.lockRefreshMs ?? LOCK_REFRESH_MS;
  const stage = async (name, run) => {
    const started = Date.now();
    log(`${LOG_PREFIX} model=${bundle.modelId} stage=${name} started`);
    try {
      const result = await run();
      log(`${LOG_PREFIX} model=${bundle.modelId} stage=${name} done ms=${Date.now() - started}`);
      return result;
    } catch (error) {
      const reason = error instanceof BuiltInReasoningInstallError ? error.reason : "disk_write_failed";
      log(`${LOG_PREFIX} model=${bundle.modelId} stage=${name} failed reason=${reason} ms=${Date.now() - started}`);
      throw error;
    }
  };
  const verifyAll = async () => {
    for (const { file, path } of files)
      await verifyPinnedFile(path, file, noun, reporter, timing.verifyTimeoutMs);
  };
  const finished = () => reporter.set("ready", `${capitalize(noun)} ready`, 100);
  try {
    const archive = runtimeArchiveFor(platform, runtime);
    if (!archive) {
      throw new BuiltInReasoningInstallError("unsupported_platform", `The ${noun} does not run on ${platform}.`);
    }
    ensureDirectory2(paths.root);
    const installed = () => ({
      filePaths: files.map(({ path }) => path),
      serverPath: findServerBinary(paths.runtimeDir),
      gpu: archive.gpu
    });
    if (filesPresent() && runtimeInstalled2(paths.runtimeDir, archive)) {
      await stage("verify", verifyAll);
      finished();
      return installed();
    }
    const now = (options.now ?? (() => new Date))();
    const previous = readPinnedModelStatus(paths.statusPath, bundle.modelId, noun);
    if (previous.state === "failed" && previous.failure?.reason === "insufficient_space" && previous.failure.retryAfter && Date.parse(previous.failure.retryAfter) > now.getTime()) {
      throw new BuiltInReasoningInstallError("insufficient_space", previous.failure.message, {
        bytesNeeded: previous.failure.bytesNeeded ?? 0,
        bytesFree: previous.failure.bytesFree ?? 0,
        retryAfter: previous.failure.retryAfter
      });
    }
    const space = {
      noun,
      freeBytes: options.freeBytes ?? volumeFreeBytes,
      headroomBytes: options.spaceHeadroomBytes ?? BUILT_IN_REASONING_SPACE_HEADROOM_BYTES,
      backoffMs: options.spaceBackoffMs ?? SPACE_BACKOFF_MS,
      now: () => (options.now ?? (() => new Date))(),
      write: options.writeChunk ?? writeDownloadChunk
    };
    await stage("install", () => withInstallLock2(paths.lockPath, lockWaitMs, lockRefreshMs, noun, async () => {
      if (filesPresent() && runtimeInstalled2(paths.runtimeDir, archive))
        return;
      const fetchImpl = options.fetchImpl ?? fetch;
      const missing = files.filter(({ path }) => !existsSync9(path));
      const needRuntime = !runtimeInstalled2(paths.runtimeDir, archive);
      const missingBytes = missing.reduce((total, { file, path }) => total + Math.max(0, file.bytes - fileSize(`${path}.partial`)), 0);
      assertSpaceFor(paths.root, space, missingBytes + (needRuntime ? archive.bytes * RUNTIME_UNPACK_FACTOR : 0));
      reporter.begin(missing.reduce((total, { file }) => total + file.bytes, 0) + (needRuntime ? archive.bytes : 0));
      if (needRuntime) {
        await stage("runtime", () => withInstallLock2(paths.runtimeLockPath, lockWaitMs, lockRefreshMs, noun, async () => {
          if (runtimeInstalled2(paths.runtimeDir, archive))
            return;
          await installRuntime2(fetchImpl, paths.runtimeDir, archive, reporter, options.extractArchive ?? extractWithTar, timing.downloadStallMs, space);
        }));
      }
      if (missing.length > 0) {
        ensureDirectory2(paths.modelDir);
        for (const { file, path } of missing) {
          await stage("download", () => downloadVerified2(fetchImpl, file.url, path, file.bytes, file.sha256, reporter, `Downloading the ${noun} (${bundle.displayName})`, timing.downloadStallMs, space));
        }
      }
    }));
    await stage("verify", verifyAll);
    if (!runtimeInstalled2(paths.runtimeDir, archive)) {
      throw new BuiltInReasoningInstallError("runtime_load_failed", "The built-in model server did not install completely.");
    }
    finished();
    return installed();
  } catch (error) {
    const failure = error instanceof BuiltInReasoningInstallError ? error : new BuiltInReasoningInstallError("disk_write_failed", error instanceof Error ? error.message : String(error));
    reporter.fail(failure.reason, failure.message, failure.shortfall);
    throw failure;
  }
}
function volumeFreeBytes(path) {
  try {
    const stats = statfsSync(path);
    return Number(stats.bavail) * Number(stats.bsize);
  } catch {
    return;
  }
}
function fileSize(path) {
  try {
    return statSync7(path).size;
  } catch {
    return 0;
  }
}
function spaceShortfallError(space, bytesNeeded, bytesFree, cause) {
  const retryAfter = new Date(space.now().getTime() + space.backoffMs).toISOString();
  return new BuiltInReasoningInstallError("insufficient_space", `Not enough free disk space for the ${space.noun}: it needs ${formatGb(bytesNeeded)} free and the disk has ${formatGb(bytesFree)}${cause ? ` (${cause})` : ""}. Free up space; Olympus tries again after ${retryAfter}.`, { bytesNeeded, bytesFree, retryAfter });
}
function assertSpaceFor(dir, space, bytes) {
  if (bytes <= 0)
    return;
  const free = space.freeBytes(dir);
  if (free === undefined)
    return;
  const needed = bytes + space.headroomBytes;
  if (free < needed)
    throw spaceShortfallError(space, needed, free);
}
function isNoSpaceError(error) {
  const code = error?.code;
  return code === "ENOSPC" || code === "EDQUOT" || /ENOSPC|no space left/i.test(String(error));
}
function formatGb(bytes) {
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
}
function capitalize(text) {
  return text.length > 0 ? `${text[0].toUpperCase()}${text.slice(1)}` : text;
}
function reportPinnedModelState(target, state, failure) {
  const reporter = new ProgressReporter2(target.statusPath, target.modelId, target.noun, target.now, target.onProgress);
  if (state === "failed" && failure)
    reporter.fail(failure.reason, failure.message);
  else
    reporter.set(state, state === "ready" ? `${capitalize(target.noun)} ready` : `Starting the ${target.noun}`, 100);
}
function findServerBinary(runtimeDir) {
  const marker = readRuntimeMarker(runtimeDir);
  if (marker?.serverPath)
    return join13(runtimeDir, marker.serverPath);
  throw new BuiltInReasoningInstallError("runtime_load_failed", "The built-in model server is not installed.");
}
var verifiedThisProcess2;
async function verifyPinnedFile(path, file, noun, reporter, timeoutMs) {
  const key = `${path}:${file.sha256}`;
  verifiedThisProcess2 ??= new Set;
  if (verifiedThisProcess2.has(key))
    return;
  const size = statSync7(path).size;
  const label = `Checking the ${noun}`;
  reporter.verifying(label, 0, file.bytes);
  const digest = size === file.bytes ? await sha256File2(path, timeoutMs, (done) => reporter.verifying(label, done, file.bytes)) : undefined;
  if (digest !== file.sha256) {
    rmSync5(path, { force: true });
    throw new BuiltInReasoningInstallError("checksum_mismatch", `${file.name} did not match its pinned checksum and was removed; it will download again.`);
  }
  verifiedThisProcess2.add(key);
}
function readRuntimeMarker(runtimeDir) {
  try {
    return JSON.parse(readFileSync11(join13(runtimeDir, RUNTIME_MARKER2), "utf8"));
  } catch {
    return;
  }
}
function runtimeInstalled2(runtimeDir, archive) {
  const marker = readRuntimeMarker(runtimeDir);
  return marker !== undefined && marker.sha256 === archive.sha256 && existsSync9(join13(runtimeDir, marker.serverPath));
}
async function installRuntime2(fetchImpl, runtimeDir, archive, reporter, extract, stallMs, space) {
  const staging = `${runtimeDir}.staging-${randomUUID4()}`;
  ensureDirectory2(staging);
  try {
    const archivePath = join13(staging, archive.name);
    await downloadVerified2(fetchImpl, archive.url, archivePath, archive.bytes, archive.sha256, reporter, "Downloading the built-in model server", stallMs, space);
    reporter.set("verifying", "Unpacking the built-in model server");
    try {
      await extract(archivePath, staging);
    } catch (error) {
      if (isNoSpaceError(error)) {
        throw spaceShortfallError(space, archive.bytes * RUNTIME_UNPACK_FACTOR + space.headroomBytes, space.freeBytes(dirname12(runtimeDir)) ?? 0, "the disk filled up while unpacking");
      }
      throw new BuiltInReasoningInstallError("runtime_load_failed", `The built-in model server could not be unpacked (${error instanceof Error ? error.message : String(error)}).`);
    }
    rmSync5(archivePath, { force: true });
    const server = locateFile(staging, SERVER_BINARY);
    if (!server) {
      throw new BuiltInReasoningInstallError("runtime_load_failed", `${archive.name} did not contain ${SERVER_BINARY}.`);
    }
    const marker = { archive: archive.name, sha256: archive.sha256, serverPath: server };
    writeFileSync4(join13(staging, RUNTIME_MARKER2), `${JSON.stringify(marker, null, 2)}
`);
    rmSync5(runtimeDir, { recursive: true, force: true });
    renameSync5(staging, runtimeDir);
  } catch (error) {
    rmSync5(staging, { recursive: true, force: true });
    throw error;
  }
}
function extractWithTar(archivePath, targetDir) {
  return new Promise((resolve5, reject) => {
    const child = spawn2("tar", ["-xzf", archivePath, "-C", targetDir], { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr?.on("data", (chunk) => {
      if (stderr.length < 4000)
        stderr += chunk.toString();
    });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`tar did not finish within ${Math.round(EXTRACT_TIMEOUT_MS / 60000)} min`));
    }, EXTRACT_TIMEOUT_MS);
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (status, signal) => {
      clearTimeout(timer);
      if (status === 0)
        resolve5();
      else
        reject(new Error(stderr.trim() || `tar exited with ${status ?? signal}`));
    });
  });
}
function locateFile(root, name, depth = 0, prefix = "") {
  let entries;
  try {
    entries = readdirSync4(join13(root, prefix));
  } catch {
    return;
  }
  if (entries.includes(name)) {
    const relative4 = prefix ? `${prefix}/${name}` : name;
    try {
      if (statSync7(join13(root, relative4)).isFile())
        return relative4;
    } catch {}
  }
  if (depth >= 2)
    return;
  for (const entry of entries) {
    const child = prefix ? `${prefix}/${entry}` : entry;
    try {
      if (!statSync7(join13(root, child)).isDirectory())
        continue;
    } catch {
      continue;
    }
    const found = locateFile(root, name, depth + 1, child);
    if (found)
      return found;
  }
  return;
}
async function downloadVerified2(fetchImpl, url, target, expectedBytes, expectedSha256, reporter, label, stallMs, space) {
  await downloadPinnedFile({
    fetchImpl,
    url,
    target,
    partial: `${target}.partial`,
    expectedBytes,
    algorithm: "sha256",
    digest: expectedSha256,
    encoding: "hex",
    noun: space.noun,
    stallMs,
    verifyTimeoutMs: VERIFY_TIMEOUT_MS,
    keepPartial: true,
    error: (reason, message2) => new BuiltInReasoningInstallError(reason, message2),
    diskError: (error) => isNoSpaceError(error) ? spaceShortfallError(space, expectedBytes + space.headroomBytes, space.freeBytes(dirname12(target)) ?? 0, "the disk filled up during the download") : new BuiltInReasoningInstallError("disk_write_failed", `Could not write the download: ${String(error)}`),
    write: space.write,
    onStart: () => reporter.set("downloading", label),
    onProgress: (bytes) => reporter.advance(bytes, label)
  });
}
function hashInto(path, hash, timeoutMs, onProgress) {
  return new Promise((resolve5, reject) => {
    let done = 0;
    let settled = false;
    const stream = createReadStream3(path);
    const finish = (error) => {
      if (settled)
        return;
      settled = true;
      clearTimeout(timer);
      if (error) {
        stream.destroy();
        reject(error);
      } else {
        resolve5();
      }
    };
    const timer = setTimeout(() => finish(new BuiltInReasoningInstallError("checksum_mismatch", `Checking ${path} did not finish within ${Math.round(timeoutMs / 60000)} min.`)), timeoutMs);
    stream.on("data", (chunk) => {
      hash.update(chunk);
      done += chunk.length;
      onProgress?.(done);
    }).on("error", (error) => finish(error)).on("end", () => finish()).on("close", () => finish(new Error(`Reading ${path} stopped before the end.`)));
  });
}
async function sha256File2(path, timeoutMs, onProgress) {
  const hash = createHash4("sha256");
  await hashInto(path, hash, timeoutMs, onProgress);
  return hash.digest("hex");
}
async function withInstallLock2(lockPath, waitMs, refreshMs, noun, run) {
  const deadline = Date.now() + waitMs;
  const token = randomUUID4();
  for (;; ) {
    if (tryAcquireLock2(lockPath, token))
      break;
    if (Date.now() > deadline) {
      throw new BuiltInReasoningInstallError("download_failed", `Another Olympus process is still installing the ${noun}.`);
    }
    await new Promise((resolve5) => setTimeout(resolve5, LOCK_POLL_MS2));
  }
  const refresh = setInterval(() => refreshLock(lockPath, token), refreshMs);
  refresh.unref?.();
  try {
    await run();
  } finally {
    clearInterval(refresh);
    if (lockHolder(lockPath)?.token === token)
      rmSync5(lockPath, { force: true });
  }
}
function lockHolder(lockPath) {
  try {
    return JSON.parse(readFileSync11(lockPath, "utf8"));
  } catch {
    return;
  }
}
function refreshLock(lockPath, token) {
  if (lockHolder(lockPath)?.token !== token)
    return;
  try {
    const temporary = `${lockPath}.${process.pid}.tmp`;
    writeFileSync4(temporary, JSON.stringify({ pid: process.pid, at: Date.now(), token }), { mode: 384 });
    renameSync5(temporary, lockPath);
  } catch {}
}
function tryAcquireLock2(lockPath, token) {
  try {
    const fd = openSync7(lockPath, "wx", 384);
    writeSync3(fd, JSON.stringify({ pid: process.pid, at: Date.now(), token }));
    closeSync7(fd);
    return true;
  } catch {
    if (lockIsStale2(lockPath)) {
      rmSync5(lockPath, { force: true });
      return tryAcquireLock2(lockPath, token);
    }
    return false;
  }
}
function lockIsStale2(lockPath) {
  try {
    const holder = JSON.parse(readFileSync11(lockPath, "utf8"));
    if (typeof holder.pid === "number" && holder.pid !== process.pid) {
      try {
        process.kill(holder.pid, 0);
      } catch (error) {
        if (error.code === "ESRCH")
          return true;
      }
    }
    return typeof holder.at === "number" && Date.now() - holder.at > STALE_LOCK_MS2;
  } catch {
    try {
      return Date.now() - statSync7(lockPath).mtimeMs > STALE_LOCK_MS2;
    } catch {
      return true;
    }
  }
}
function ensureDirectory2(path) {
  try {
    mkdirSync6(path, { recursive: true, mode: 448 });
  } catch (error) {
    throw new BuiltInReasoningInstallError("disk_write_failed", `Could not create ${path}: ${String(error)}`);
  }
}

class ProgressReporter2 {
  statusPath;
  modelId;
  noun;
  now;
  listener;
  status;
  lastWriteMs;
  constructor(statusPath, modelId, noun, now, listener) {
    this.statusPath = statusPath;
    this.modelId = modelId;
    this.noun = noun;
    this.now = now ?? (() => new Date);
    this.listener = listener;
    this.lastWriteMs = 0;
    this.status = {
      state: "not_started",
      modelId,
      percent: 0,
      label: "",
      bytesDone: 0,
      bytesTotal: 0,
      updatedAt: this.now().toISOString()
    };
  }
  begin(bytesTotal) {
    this.status = { ...this.status, bytesTotal, bytesDone: 0 };
    this.set("downloading", `Downloading the ${this.noun}`, 0);
  }
  advance(bytes, label) {
    const bytesDone = Math.max(0, this.status.bytesDone + bytes);
    const percent = this.status.bytesTotal > 0 ? Math.min(99, Math.floor(bytesDone / this.status.bytesTotal * 100)) : 0;
    this.status = { ...this.status, bytesDone, percent, label, state: "downloading" };
    this.emit(false);
  }
  verifying(label, bytesDone, bytesTotal) {
    const percent = bytesTotal > 0 ? Math.min(99, Math.floor(bytesDone / bytesTotal * 100)) : 0;
    const { failure: _failure, ...rest } = this.status;
    const first = this.status.state !== "verifying" || bytesDone === 0;
    this.status = { ...rest, state: "verifying", label, percent, bytesDone, bytesTotal };
    this.emit(first || bytesDone >= bytesTotal);
  }
  set(state, label, percent = this.status.percent) {
    const { failure: _failure, ...rest } = this.status;
    this.status = { ...rest, state, label, percent };
    this.emit(true);
  }
  fail(reason, message2, shortfall) {
    this.status = {
      ...this.status,
      state: "failed",
      label: reason === "insufficient_space" ? `Waiting for free disk space to download the ${this.noun}` : `The ${this.noun} could not be installed`,
      failure: { reason, message: message2, ...shortfall ?? {} }
    };
    this.emit(true);
  }
  emit(force) {
    const nowMs = this.now().getTime();
    this.status = { ...this.status, modelId: this.modelId, updatedAt: new Date(nowMs).toISOString() };
    this.listener?.(this.status);
    if (!force && nowMs - this.lastWriteMs < PROGRESS_WRITE_INTERVAL_MS2)
      return;
    this.lastWriteMs = nowMs;
    try {
      mkdirSync6(dirname12(this.statusPath), { recursive: true, mode: 448 });
      const temporary = `${this.statusPath}.${process.pid}.tmp`;
      writeFileSync4(temporary, `${JSON.stringify(this.status)}
`, { mode: 384 });
      renameSync5(temporary, this.statusPath);
    } catch {}
  }
}

// src/workers/source-index/built-in-reasoning/server.ts
import { isMainThread as isMainThread7 } from "node:worker_threads";
import { spawn as spawn3 } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync as rmSync6, writeFileSync as writeFileSync5 } from "node:fs";
import { createServer } from "node:net";
import { availableParallelism as availableParallelism3, setPriority, tmpdir } from "node:os";
import { join as join14 } from "node:path";
class LlamaServerStartError extends Error {
  constructor(message2) {
    super(message2);
    this.name = "LlamaServerStartError";
  }
}

class LlamaServerStillExitingError extends LlamaServerStartError {
  constructor(message2) {
    super(message2);
    this.name = "LlamaServerStillExitingError";
  }
}

class LlamaServerStopError extends Error {
  constructor(message2) {
    super(message2);
    this.name = "LlamaServerStopError";
  }
}
var HEALTH_POLL_MS = 250;
var STOPPED_WHILE_STARTING = "The built-in model server was stopped while starting.";
var DEFAULT_STOP_GRACE_MS = 5000;
var DEFAULT_KILL_WAIT_MS = 5000;
var LLAMA_SERVER_ENV_ALLOWLIST = ["PATH", "HOME", "TMPDIR", "LANG", "LC_ALL"];
function llamaServerEnvironment(parent, alias) {
  const env = {};
  for (const name of LLAMA_SERVER_ENV_ALLOWLIST) {
    const value = parent[name];
    if (value !== undefined)
      env[name] = value;
  }
  env.LLAMA_ARG_HOST = "127.0.0.1";
  env.LLAMA_ARG_ALIAS = alias;
  return env;
}
function llamaServerArguments(launch, port, tokenFile) {
  return [
    "--model",
    launch.modelPath,
    ...launch.mmprojPath ? ["--mmproj", launch.mmprojPath] : [],
    "--host",
    "127.0.0.1",
    "--port",
    String(port),
    "--api-key-file",
    tokenFile,
    "--ctx-size",
    String(launch.contextTokens),
    "--parallel",
    "1",
    "--batch-size",
    String(launch.batchSize ?? 64),
    "--ubatch-size",
    String(launch.batchSize ?? 64),
    "--threads",
    String(launch.threads),
    "--threads-batch",
    String(launch.threads),
    "--n-gpu-layers",
    launch.gpu ? "999" : "0",
    "--prio",
    "-1",
    "--reasoning",
    "off",
    "--no-webui",
    "--cache-ram",
    "0",
    "--no-slots",
    "--log-disable",
    ...launch.idleShutdownSeconds > 0 ? ["--sleep-idle-seconds", String(launch.idleShutdownSeconds)] : []
  ];
}
function createLlamaServerHandle(launch, options = {}) {
  if (isMainThread7 && !options.spawnImpl && !options.fetchImpl && !options.onPid) {
    const thread = modelThread();
    const handle = modelThreadHandleId();
    const translateError = (error) => {
      const failure = error;
      if (failure.name === "LlamaServerStillExitingError")
        throw new LlamaServerStillExitingError(failure.message);
      if (failure.name === "LlamaServerStopError")
        throw new LlamaServerStopError(failure.message);
      if (failure.name === "LlamaServerStartError")
        throw new LlamaServerStartError(failure.message);
      throw error;
    };
    return {
      ensureRunning: (signal) => thread.call({
        kind: "start",
        handle,
        launch,
        env: options.env,
        stopGraceMs: options.stopGraceMs,
        killWaitMs: options.killWaitMs,
        immediateKill: options.immediateKill
      }, { signal, timeoutMs: launch.startupTimeoutMs + 30000 }).catch((error) => {
        if (signal?.aborted)
          throw callerCancelled(signal.reason);
        return translateError(error);
      }),
      touch: () => {
        thread.call({ kind: "touch", handle }).catch(() => {});
      },
      stop: () => thread.call({ kind: "stop", handle }, { timeoutMs: (options.stopGraceMs ?? DEFAULT_STOP_GRACE_MS) + (options.killWaitMs ?? DEFAULT_KILL_WAIT_MS) + 5000 }).catch(translateError),
      get pid() {
        return thread.pids.get(handle);
      }
    };
  }
  const spawnImpl = options.spawnImpl ?? spawn3;
  const fetchImpl = options.fetchImpl ?? fetch;
  const stopGraceMs = options.stopGraceMs ?? DEFAULT_STOP_GRACE_MS;
  const killWaitMs = options.killWaitMs ?? DEFAULT_KILL_WAIT_MS;
  const immediateKill = options.immediateKill === true;
  let current;
  const retiring = new Set;
  let endpoint;
  let starting;
  let generation = 0;
  let idleTimer;
  let exitHookInstalled = false;
  const clearIdle = () => {
    if (idleTimer)
      clearTimeout(idleTimer);
    idleTimer = undefined;
  };
  const retireCurrent = () => {
    const server = current;
    current = undefined;
    options.onPid?.(undefined);
    endpoint = undefined;
    if (!server)
      return;
    if (!server.exited) {
      retiring.add(server);
      terminate(server).catch(() => {
        return;
      });
    }
    server.cleanupTokenDir();
  };
  const terminate = (server) => {
    if (server.exited)
      return Promise.resolve();
    server.terminating ??= (async () => {
      if (!server.killed && !immediateKill) {
        server.signal("SIGTERM");
        if (await server.waitExit(stopGraceMs))
          return;
      }
      server.killed = true;
      server.signal("SIGKILL");
      if (await server.waitExit(killWaitMs))
        return;
      throw new LlamaServerStopError(`The built-in model server (pid ${server.pid ?? "unknown"}) has not exited ${Math.round((stopGraceMs + killWaitMs) / 1000)}s after it was told to stop.`);
    })().catch((error) => {
      server.terminating = undefined;
      throw error;
    });
    return server.terminating;
  };
  const awaitRetired = async () => {
    const results = await Promise.allSettled([...retiring].map((server) => terminate(server)));
    const failed = results.find((result) => result.status === "rejected");
    if (failed)
      throw failed.reason;
  };
  const stopAll = async () => {
    clearIdle();
    generation += 1;
    const superseded = starting;
    starting = undefined;
    superseded?.controller.abort(new LlamaServerStartError(STOPPED_WHILE_STARTING));
    retireCurrent();
    await awaitRetired();
  };
  const armIdle = () => {
    clearIdle();
    if (launch.idleShutdownSeconds <= 0 || !current)
      return;
    idleTimer = setTimeout(() => {
      idleTimer = undefined;
      stopAll().catch(() => {
        return;
      });
    }, launch.idleShutdownSeconds * 1000);
    idleTimer.unref?.();
  };
  const start = async (startGeneration, signal) => {
    const superseded = () => {
      if (signal?.aborted) {
        throw signal.reason instanceof Error ? signal.reason : new LlamaServerStartError("The request was cancelled.");
      }
      if (generation !== startGeneration)
        throw new LlamaServerStartError(STOPPED_WHILE_STARTING);
    };
    superseded();
    const retired = awaitRetired();
    retired.catch(() => {
      return;
    });
    try {
      await abortable(retired, signal);
    } catch (error) {
      superseded();
      throw new LlamaServerStillExitingError(`A previous built-in model server has not exited yet, so a new one was not started. ${error instanceof Error ? error.message : ""}`.trim());
    }
    superseded();
    const port = await freeLoopbackPort();
    superseded();
    const token = randomBytes(24).toString("base64url");
    const alias = `olympus-${randomBytes(12).toString("hex")}`;
    const tokenDir = mkdtempSync(join14(tmpdir(), "olympus-built-in-model-"));
    const tokenFile = join14(tokenDir, "token");
    let spawnedProcess;
    try {
      writeFileSync5(tokenFile, `${token}
`, { mode: 384 });
      spawnedProcess = spawnImpl(launch.serverPath, llamaServerArguments(launch, port, tokenFile), {
        stdio: ["ignore", "ignore", "pipe"],
        env: llamaServerEnvironment(options.env ?? process.env, alias),
        detached: false
      });
    } catch (error) {
      removeTokenDir(tokenDir);
      throw error;
    }
    const spawned = trackServerProcess(spawnedProcess, tokenDir, (server) => {
      retiring.delete(server);
      if (current === server) {
        current = undefined;
        options.onPid?.(undefined);
        endpoint = undefined;
      }
    });
    current = spawned;
    options.onPid?.(spawned.pid);
    let stderrTail = "";
    spawnedProcess.stderr?.on("data", (chunk) => {
      stderrTail = `${stderrTail}${chunk.toString()}`.slice(-2000);
    });
    if (spawned.pid !== undefined) {
      try {
        setPriority(spawned.pid, 10);
      } catch {}
    }
    if (!exitHookInstalled) {
      exitHookInstalled = true;
      process.once("exit", () => {
        for (const server of [current, ...retiring]) {
          server?.signal("SIGKILL");
          server?.cleanupTokenDir();
        }
      });
    }
    const baseUrl = `http://127.0.0.1:${port}`;
    const deadline = Date.now() + launch.startupTimeoutMs;
    const fail = (error) => {
      if (current === spawned)
        retireCurrent();
      throw error;
    };
    for (;; ) {
      if (signal?.aborted) {
        fail(signal.reason instanceof Error ? signal.reason : new LlamaServerStartError("The request was cancelled."));
      }
      if (current !== spawned || spawned.exited) {
        if (current === spawned)
          current = undefined;
        if (generation !== startGeneration)
          throw new LlamaServerStartError(STOPPED_WHILE_STARTING);
        throw new LlamaServerStartError(`The built-in model server exited while starting.${stderrTail ? ` ${lastLine(stderrTail)}` : ""}`);
      }
      if (await healthy(fetchImpl, baseUrl)) {
        if (current !== spawned)
          continue;
        if (await servesAlias(fetchImpl, baseUrl, token, alias))
          break;
        fail(new LlamaServerStartError("The built-in model server's port was taken by another process; it will start again on a new port."));
      }
      if (Date.now() > deadline) {
        fail(new LlamaServerStartError(`The built-in model server did not load within ${Math.round(launch.startupTimeoutMs / 1000)}s.`));
      }
      await new Promise((resolve5) => setTimeout(resolve5, HEALTH_POLL_MS));
    }
    if (current !== spawned || spawned.exited) {
      throw new LlamaServerStartError(STOPPED_WHILE_STARTING);
    }
    if (signal?.aborted) {
      fail(signal.reason instanceof Error ? signal.reason : new LlamaServerStartError("The request was cancelled."));
    }
    endpoint = { baseUrl, token };
    return endpoint;
  };
  return {
    async ensureRunning(signal) {
      if (signal?.aborted)
        throw callerCancelled(signal.reason);
      clearIdle();
      if (endpoint && current && !current.exited)
        return endpoint;
      const callerGeneration = generation;
      while (starting?.controller.signal.aborted) {
        const cancelled2 = starting;
        try {
          await abortable(cancelled2.promise.then(() => {
            return;
          }, () => {
            return;
          }), signal);
        } catch {
          throw callerCancelled(signal?.reason);
        }
        if (generation !== callerGeneration)
          throw new LlamaServerStartError(STOPPED_WHILE_STARTING);
        if (starting === cancelled2)
          starting = undefined;
        if (endpoint && current && !current.exited)
          return endpoint;
      }
      if (!starting) {
        const controller = new AbortController;
        const shared3 = {
          controller,
          waiters: 0,
          promise: start(generation, controller.signal).finally(() => {
            if (starting === shared3)
              starting = undefined;
          })
        };
        shared3.promise.catch(() => {
          return;
        });
        starting = shared3;
      }
      const shared2 = starting;
      if (!signal) {
        shared2.waiters = Number.POSITIVE_INFINITY;
        return shared2.promise;
      }
      shared2.waiters += 1;
      try {
        return await abortable(shared2.promise, signal);
      } catch (error) {
        if (signal.aborted) {
          shared2.waiters -= 1;
          if (shared2.waiters <= 0)
            shared2.controller.abort(signal.reason);
          throw callerCancelled(signal.reason);
        }
        throw error;
      }
    },
    touch() {
      armIdle();
    },
    stop() {
      return stopAll();
    },
    get pid() {
      return current?.pid;
    }
  };
}
function callerCancelled(reason) {
  if (reason instanceof Error && reason.name === "AbortError")
    return reason;
  const error = new Error(reason instanceof Error ? reason.message : "The request was cancelled.", { cause: reason });
  error.name = "AbortError";
  return error;
}
function removeTokenDir(tokenDir) {
  try {
    rmSync6(tokenDir, { recursive: true, force: true });
    return true;
  } catch {
    console.warn("Olympus built-in model: could not remove a model server token directory.");
    return false;
  }
}
function trackServerProcess(child, tokenDir, onExit) {
  let exited = child.exitCode !== null || child.signalCode !== null;
  let tokenDirPresent = true;
  const exitWaiters = new Set;
  const server = {
    pid: child.pid,
    get exited() {
      return exited;
    },
    killed: false,
    terminating: undefined,
    waitExit(timeoutMs) {
      if (exited)
        return Promise.resolve(true);
      return new Promise((resolve5) => {
        const settle = (value) => {
          clearTimeout(timer);
          exitWaiters.delete(onExited);
          resolve5(value);
        };
        const onExited = () => settle(true);
        const timer = setTimeout(() => settle(false), timeoutMs);
        exitWaiters.add(onExited);
      });
    },
    signal(signal) {
      if (exited)
        return;
      try {
        child.kill(signal);
      } catch {}
    },
    cleanupTokenDir() {
      if (!tokenDirPresent)
        return;
      tokenDirPresent = !removeTokenDir(tokenDir);
    }
  };
  const finish = () => {
    if (exited)
      return;
    exited = true;
    for (const waiter of [...exitWaiters])
      waiter();
    onExit(server);
    server.cleanupTokenDir();
  };
  child.once("exit", finish);
  child.once("error", () => {
    if (child.pid === undefined)
      finish();
  });
  if (exited)
    server.cleanupTokenDir();
  return server;
}
function abortable(promise, signal) {
  if (!signal)
    return promise;
  if (signal.aborted)
    return Promise.reject(signal.reason);
  return new Promise((resolve5, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then((value) => {
      signal.removeEventListener("abort", onAbort);
      resolve5(value);
    }, (error) => {
      signal.removeEventListener("abort", onAbort);
      reject(error);
    });
  });
}
async function healthy(fetchImpl, baseUrl) {
  try {
    const response = await fetchImpl(`${baseUrl}/health`, { signal: AbortSignal.timeout(2000) });
    await response.body?.cancel().catch(() => {
      return;
    });
    return response.ok;
  } catch {
    return false;
  }
}
async function servesAlias(fetchImpl, baseUrl, token, alias) {
  try {
    const response = await fetchModelEndpoint(fetchImpl, `${baseUrl}/v1/models`, {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(5000)
    });
    if (!response.ok) {
      await response.body?.cancel().catch(() => {
        return;
      });
      return false;
    }
    const text = await response.text();
    return text.length <= 1e6 && text.includes(alias);
  } catch {
    return false;
  }
}
function freeLoopbackPort() {
  return new Promise((resolve5, reject) => {
    const server = createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close(() => port > 0 ? resolve5(port) : reject(new LlamaServerStartError("No free loopback port.")));
    });
  });
}
function lastLine(text) {
  const lines = text.trim().split(`
`);
  return (lines[lines.length - 1] ?? "").slice(0, 300);
}

// src/workers/source-index/built-in-reasoning/model-worker.ts
var port = parentPort;
var liteRtHelpers = new Map;
var embedders = new Map;
var rerankers = new Map;
var handles = new Map;
var controllers = new Map;
var stopAll = () => Promise.all([
  ...[...handles.values()].map((handle) => handle.stop()),
  ...[...liteRtHelpers.values()].map((helper) => helper.release())
]);
var send = (reply) => port.postMessage(reply);
port.on("message", async (message2) => {
  if (message2.shutdown) {
    try {
      await stopAll();
    } finally {
      Atomics.store(workerData.shutdown, 0, 1);
      Atomics.notify(workerData.shutdown, 0);
    }
    return;
  }
  if (message2.cancel !== undefined) {
    controllers.get(message2.cancel)?.abort();
    return;
  }
  const { id, request } = message2;
  const controller = new AbortController;
  controllers.set(id, controller);
  try {
    let result;
    switch (request.kind) {
      case "litert-start": {
        const helper = await startLiteRtEmbedder(request.options);
        liteRtHelpers.set(request.handle, helper);
        result = { device: helper.device, vision: helper.vision };
        break;
      }
      case "litert-run": {
        const helper = liteRtHelpers.get(request.handle);
        if (!helper)
          throw new Error("The built-in search helper is not running.");
        const vectors = await helper.embed(request.items);
        result = { vectors, device: helper.device, vision: helper.vision };
        break;
      }
      case "litert-release":
        await liteRtHelpers.get(request.handle)?.release();
        liteRtHelpers.delete(request.handle);
        break;
      case "embedding-install":
        result = await installBuiltInEmbedding({ ...request.options, onProgress: (embeddingProgress) => send({ id, embeddingProgress }) });
        break;
      case "embedding-load": {
        const provider = new BuiltInSourceEmbeddingProvider({
          env: request.env,
          model: request.model,
          threads: request.threads,
          install: async () => request.installed
        });
        await provider.prepare();
        embedders.set(request.handle, provider);
        break;
      }
      case "embedding-run": {
        const provider = embedders.get(request.handle);
        if (!provider)
          throw new Error("The built-in search model is not loaded.");
        const run = () => provider.embed(request.inputs, { taskType: request.taskType });
        result = await (request.priority ? withPriorityQueryEmbedding(run) : run());
        break;
      }
      case "reranker-load": {
        const reranker = builtInRerankerFromEnv({ env: request.env });
        if (!reranker)
          throw new Error("The built-in reranker is not configured.");
        await reranker.prepare();
        rerankers.set(request.handle, reranker);
        break;
      }
      case "reranker-run": {
        const reranker = rerankers.get(request.handle);
        if (!reranker)
          throw new Error("The built-in reranker is not loaded.");
        result = await reranker.score({ ...request.request, signal: controller.signal });
        break;
      }
      case "install":
        result = await installPinnedModel({
          ...request.options,
          onProgress: (progress) => send({ id, progress }),
          log: (log) => send({ id, log })
        });
        break;
      case "start": {
        let handle = handles.get(request.handle);
        if (!handle) {
          handle = createLlamaServerHandle(request.launch, {
            ...request.env ? { env: request.env } : {},
            ...request.stopGraceMs !== undefined ? { stopGraceMs: request.stopGraceMs } : {},
            ...request.killWaitMs !== undefined ? { killWaitMs: request.killWaitMs } : {},
            ...request.immediateKill !== undefined ? { immediateKill: request.immediateKill } : {},
            onPid: (pid) => send({ id: 0, handle: request.handle, pid })
          });
          handles.set(request.handle, handle);
        }
        result = await handle.ensureRunning(controller.signal);
        break;
      }
      case "touch":
        handles.get(request.handle)?.touch();
        break;
      case "stop":
        await handles.get(request.handle)?.stop();
        break;
      case "shutdown":
        await stopAll();
        break;
    }
    send({ id, result });
    if (request.kind === "shutdown")
      port.close();
  } catch (error) {
    const failure = error;
    const helper = request.kind === "litert-run" ? liteRtHelpers.get(request.handle) : undefined;
    send({ id, error: {
      name: failure.name,
      message: failure.message,
      reason: failure.reason,
      shortfall: failure.shortfall,
      indexes: failure.indexes,
      device: helper?.device,
      vision: helper?.vision
    } });
  } finally {
    controllers.delete(id);
  }
});
