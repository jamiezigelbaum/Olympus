// src/workers/source-index/built-in-reasoning/model-worker.ts
import { parentPort, workerData } from "node:worker_threads";

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

// src/core/olympus-layout.ts
import { homedir as homedir3 } from "node:os";
import { basename, dirname as dirname5, isAbsolute as isAbsolute4, join as join4, relative as relative3, resolve as resolve3, sep as sep3 } from "node:path";

// src/core/openclaw-plugin-remote.ts
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute as isAbsolutePath, join } from "node:path";
function openClawConfigPath(homeDir, env) {
  const explicit = env.OPENCLAW_CONFIG_PATH?.trim();
  if (explicit && isAbsolutePath(explicit))
    return explicit;
  const stateDir = env.OPENCLAW_STATE_DIR?.trim();
  return join(stateDir && isAbsolutePath(stateDir) ? stateDir : join(homeDir, ".openclaw"), "openclaw.json");
}
function readOpenClawPluginRemote(env) {
  const path = openClawConfigPath(env.HOME?.trim() || homedir(), env);
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
import { dirname as dirname2, isAbsolute as isAbsolute2, join as join2 } from "node:path";

// src/core/atomic-file.ts
import { randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  renameSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
function writePrivateFileAtomicSync(path, text, options = {}) {
  const temp = temporaryPathFor(path);
  try {
    const descriptor = openSync(temp, "wx", 384);
    try {
      writeFileSync(descriptor, text, { encoding: "utf8" });
      fsyncSync(descriptor);
    } finally {
      closeSync(descriptor);
    }
    renameSync(temp, path);
    options.onPublished?.();
  } catch (error) {
    try {
      rmSync(temp, { force: true });
    } catch {}
    throw error;
  }
  syncDirectorySync(dirname(path));
}
function removeFileDurablySync(path) {
  try {
    rmSync(path);
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT")
      return false;
    throw error;
  }
  syncDirectorySync(dirname(path));
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
    if (existsSync(current)) {
      assertDirectoryComponent(current);
      continue;
    }
    mkdirSync(current, { mode: 448 });
    syncDirectorySync(dirname(current));
    syncDirectorySync(current);
  }
}
function ensurePrivateRootDirectorySync(root) {
  const normalizedRoot = resolveTrustedRoot(root);
  if (existsSync(normalizedRoot)) {
    assertDirectoryComponent(normalizedRoot, "managed custody root");
    return;
  }
  let ancestor = dirname(normalizedRoot);
  while (!existsSync(ancestor)) {
    const parent = dirname(ancestor);
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
  const descriptor = openSync(path, "r");
  try {
    try {
      fsyncSync(descriptor);
    } catch (error) {
      if (!isUnsupportedDirectorySyncError(error))
        throw error;
    }
  } finally {
    closeSync(descriptor);
  }
}
function resolveTrustedRoot(root) {
  if (!isAbsolute(root) || /[\0\r\n]/.test(root)) {
    throw new Error(`Managed path root must be absolute: ${root}`);
  }
  return resolve(root);
}
function resolveWithinRoot(root, path) {
  if (!isAbsolute(path) || /[\0\r\n]/.test(path)) {
    throw new Error(`Managed path must be absolute: ${path}`);
  }
  const normalized = resolve(path);
  const suffix = relative(root, normalized);
  if (suffix === ".." || suffix.startsWith(`..${sep}`) || isAbsolute(suffix)) {
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
    desktop: join2(layout.dataHome, "applications", `${ID}.desktop`),
    icon: join2(layout.dataHome, "icons/hicolor/512x512/apps", `${ID}.png`)
  };
}

// src/core/linux-engine-layout.ts
import { lstatSync as lstatSync2, mkdirSync as mkdirSync3, readFileSync as readFileSync3, readdirSync, realpathSync } from "node:fs";
import { homedir as homedir2 } from "node:os";
import { dirname as dirname4, isAbsolute as isAbsolute3, join as join3, relative as relative2, resolve as resolve2, sep as sep2 } from "node:path";

// src/core/file-lease.ts
import { execFileSync } from "node:child_process";
import { closeSync as closeSync2, existsSync as existsSync2, mkdirSync as mkdirSync2, openSync as openSync2, readFileSync as readFileSync2 } from "node:fs";
import { createRequire } from "node:module";
import { dirname as dirname3 } from "node:path";
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
  mkdirSync2(dirname3(lockPath), { recursive: true, mode: 448 });
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
    const connection = new Database(path);
    connection.exec("PRAGMA busy_timeout = 0");
    return connection;
  }
  const { DatabaseSync } = runtimeRequire("node:sqlite");
  const connection = new DatabaseSync(path);
  connection.exec("PRAGMA busy_timeout = 0");
  return connection;
}
function tryKernelLock(lockPath, mode) {
  if (!existsSync2(lockPath)) {
    try {
      closeSync2(openSync2(lockPath, "wx", 384));
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
  if (!isAbsolute3(value) || /[\x00-\x1f\x7f]/.test(value))
    throw new Error(`${name} must be an absolute path without control characters.`);
  return resolve2(value);
}
function rawLayout(env, recordedDataDir) {
  const home = absolute(env.HOME || homedir2(), "HOME");
  const root = (key, fallback) => absolute(env[key] || join3(home, fallback), key);
  const configHome = root("XDG_CONFIG_HOME", ".config");
  const dataHome = root("XDG_DATA_HOME", ".local/share");
  const stateHome = root("XDG_STATE_HOME", ".local/state");
  const cacheHome = root("XDG_CACHE_HOME", ".cache");
  const runtimeHome = env.XDG_RUNTIME_DIR ? absolute(env.XDG_RUNTIME_DIR, "XDG_RUNTIME_DIR") : "";
  const configDir = join3(configHome, "olympus");
  const runtimeDir = runtimeHome ? join3(runtimeHome, "olympus") : "";
  const xdgDataDir = join3(dataHome, "olympus");
  const legacyDirs = [...new Set([join3(dataHome, "openclaw/olympus"), join3(home, ".local/share/openclaw/olympus")])];
  if (recordedDataDir && ![xdgDataDir, ...legacyDirs].includes(recordedDataDir))
    throw new Error("Invalid Linux data root in install receipt.");
  const hasData = (path) => {
    const info = stat(path);
    if (!info)
      return false;
    return !info.isDirectory() || info.isSymbolicLink() || readdirSync(path).some((name) => path !== xdgDataDir || name !== "engine");
  };
  const dataDir = recordedDataDir ?? (hasData(xdgDataDir) ? xdgDataDir : legacyDirs.find(hasData) ?? xdgDataDir);
  const stateDir = join3(stateHome, "olympus/engine"), cacheDir = join3(cacheHome, "olympus/engine");
  const packageDir = dataDir === xdgDataDir ? join3(dataHome, "olympus-engine") : join3(dataHome, "olympus/engine");
  const managedRoots = [configDir, dataDir, stateDir, cacheDir, packageDir];
  for (let i = 0;i < managedRoots.length; i += 1)
    for (let j = i + 1;j < managedRoots.length; j += 1) {
      const forward = relative2(managedRoots[i], managedRoots[j]), reverse = relative2(managedRoots[j], managedRoots[i]);
      if (forward === "" || !forward.startsWith(`..${sep2}`) && forward !== ".." && !isAbsolute3(forward) || !reverse.startsWith(`..${sep2}`) && reverse !== ".." && !isAbsolute3(reverse))
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
    unitPath: join3(configHome, "systemd/user/olympus-engine.service"),
    configPath: join3(configDir, "engine.json"),
    sovereigntyPath: join3(configDir, "sovereignty.json"),
    workerEnvPath: join3(configDir, "worker.env"),
    workerSocketPath: runtimeDir ? join3(runtimeDir, "worker.sock") : "",
    lifecycleLockPath: runtimeDir ? join3(runtimeDir, "lifecycle.lock") : "",
    launcherPath: join3(home, ".local/bin/olympus"),
    openHandlerPath: join3(dataHome, "applications/ai.olympusplugin.open.desktop"),
    mimeappsPath: join3(configHome, "mimeapps.list"),
    receiptPath: join3(configDir, "install-receipt.json"),
    secretsPath: join3(configDir, "secrets.enc"),
    secretsKeyPath: join3(configDir, "secrets.key")
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
    const parent = dirname4(current);
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
  const parentPaths = new Set([dirname4(l.stateDir), dirname4(l.cacheDir)]);
  if (receipt.ownedEmptyParents !== undefined && (!Array.isArray(receipt.ownedEmptyParents) || new Set(receipt.ownedEmptyParents.map((entry) => entry?.path)).size !== receipt.ownedEmptyParents.length || receipt.ownedEmptyParents.some((entry) => !entry || !parentPaths.has(entry.path) || !Number.isSafeInteger(entry.device) || entry.device < 0 || !Number.isSafeInteger(entry.inode) || entry.inode <= 0))) {
    throw new Error(`${path} has invalid empty-directory ownership.`);
  }
  const allowedLinkParents = new Set([join3(l.configHome, "systemd/user"), join3(l.home, ".config/systemd/user")]);
  if (!Array.isArray(receipt.ownedUnitLinks) || receipt.ownedUnitLinks.some((p) => typeof p !== "string" || !isAbsolute3(p) || p === l.unitPath || !allowedLinkParents.has(dirname4(p)) || !p.endsWith("/olympus-engine.service")))
    throw new Error(`${path} has invalid unit links.`);
  if (!Array.isArray(receipt.machineArtifacts) || receipt.machineArtifacts.some((entry) => !entry || typeof entry.path !== "string" || !isAbsolute3(entry.path) || !["file", "symlink", "tree"].includes(entry.kind) || !/^[0-9a-f]{64}$/.test(entry.sha256) || entry.kind === "tree" && (!Number.isSafeInteger(entry.rootDevice) || entry.rootDevice < 0 || !Number.isSafeInteger(entry.rootInode) || entry.rootInode <= 0 || entry.markerPath !== join3(entry.path, ".olympus-generation.json") || !/^[0-9a-f]{64}$/.test(entry.markerSha256 ?? "")) || entry.kind !== "tree" && (entry.rootDevice !== undefined || entry.rootInode !== undefined || entry.markerPath !== undefined || entry.markerSha256 !== undefined))) {
    throw new Error(`${path} has invalid machine artifacts.`);
  }
  if (receipt.mimeOwnership && (receipt.mimeOwnership.path !== l.mimeappsPath || receipt.mimeOwnership.scheme !== "x-scheme-handler/olympus" || receipt.mimeOwnership.desktopId !== "ai.olympusplugin.open.desktop"))
    throw new Error(`${path} has invalid MIME ownership.`);
  if (receipt.openHandlerPending !== undefined && typeof receipt.openHandlerPending !== "boolean")
    throw new Error(`${path} has invalid open-handler transaction state.`);
  const fileArtifacts = new Set([...Object.values(linuxDesktopEntryPaths(l)), l.unitPath, l.launcherPath, l.openHandlerPath, join3(l.stateDir, "service-current.json"), join3(l.stateDir, "service-previous.json"), join3(l.stateDir, "install-transaction.json")]);
  const unitLinks = new Set(receipt.ownedUnitLinks);
  const artifactPaths = new Set;
  for (const artifact of receipt.machineArtifacts) {
    if (artifactPaths.has(artifact.path))
      throw new Error(`${path} has duplicate machine artifacts.`);
    artifactPaths.add(artifact.path);
    const valid = artifact.kind === "file" ? fileArtifacts.has(artifact.path) : artifact.kind === "symlink" ? unitLinks.has(artifact.path) && artifact.path.endsWith("/olympus-engine.service") : dirname4(artifact.path) === join3(l.packageDir, "generations") && artifact.sha256 === artifact.path.slice(artifact.path.lastIndexOf("/") + 1);
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
  const home = absolute(env.HOME || homedir2(), "HOME");
  const configHome = absolute(env.XDG_CONFIG_HOME || join3(home, ".config"), "XDG_CONFIG_HOME");
  const candidates = [...new Set([join3(home, ".config/olympus/install-receipt.json"), join3(configHome, "olympus/install-receipt.json")])];
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
  return env.HOME?.trim() || homedir3();
}
function xdgDataHome(env = process.env) {
  return env.XDG_DATA_HOME?.trim() || join4(layoutHome(env), ".local", "share");
}
function legacyCaptureDataRoot(env = process.env) {
  return join4(xdgDataHome(env), "olympus");
}
function legacyTelegramStoreRoot(env = process.env) {
  return standaloneLinuxDataDir(env) ?? join4(layoutHome(env), ".local", "share", "openclaw", "olympus");
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
  return env.OLYMPUS_WHATSAPP_STATE_DIR?.trim() || join4(legacyCaptureDataRoot(env), "whatsapp-live");
}
function whatsappStateDirs() {
  return { resolved: legacyWhatsAppStateDir, default: (env) => join4(legacyCaptureDataRoot(env), "whatsapp-live") };
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
function controlPathFreezeSubject(role) {
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
    this.turn = options.turn ?? ((ms) => new Promise((resolve) => {
      setTimeout(resolve, ms);
    }));
    this.log = options.log ?? ((line) => console.error(line));
    this.freezeLogMs = options.freezeLogMs ?? CONTROL_PATH_FREEZE_LOG_MS;
    this.freezeSubject = controlPathFreezeSubject(options.role ?? roleFromEnv());
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
import { closeSync as closeSync3, createReadStream, existsSync as existsSync3, openSync as openSync3, renameSync as renameSync2, rmSync as rmSync2, statSync, writeSync } from "node:fs";
var REQUEST_BYTES = 256 * 1024 ** 2;
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
      closeSync3(open);
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
    if (existsSync3(partial)) {
      const size = statSync(partial).size;
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
            fd = openSync3(partial, "w", 420);
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
            fd = openSync3(partial, received > 0 ? "a" : "w", 420);
          } catch (cause) {
            throw disk(cause);
          }
        }
        reader = response.body.getReader();
        for (;; ) {
          armStall();
          let part;
          try {
            part = await untilAborted(reader.read(), controller.signal);
          } catch (cause) {
            throw new InterruptedRead(message(cause));
          }
          if (part.done)
            break;
          if (received + part.value.byteLength > responseEnd + 1) {
            throw mismatch(`${url} is larger than its pinned size or requested range.`);
          }
          try {
            (options.write ?? writeDownloadChunk)(fd, part.value);
          } catch (cause) {
            throw disk(cause);
          }
          hash.update(part.value);
          received += part.value.byteLength;
          options.onProgress(part.value.byteLength);
          const turn = (options.turn ?? ingestionTurn)();
          if (turn)
            await turn;
        }
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
        await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS * 2 ** (retries - 1)));
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

// src/workers/source-index/built-in-reasoning/install.ts
import { isMainThread } from "node:worker_threads";

// src/workers/source-index/built-in-reasoning/off-thread.ts
import { Worker } from "node:worker_threads";
import { existsSync as existsSync4 } from "node:fs";
import { dirname as dirname6, join as join5 } from "node:path";
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
      this.pending.set(id, { resolve: (result) => resolve(result), reject, cleanup, progress: options.progress, log: options.log });
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
  const here = dirname6(fileURLToPath(import.meta.url));
  for (const name of ["model-worker.js", "model-worker.ts"]) {
    const path = join5(here, name);
    if (existsSync4(path))
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

// src/workers/source-index/built-in-reasoning/install.ts
import { spawn } from "node:child_process";
import { createHash as createHash2, randomUUID as randomUUID2 } from "node:crypto";
import {
  closeSync as closeSync4,
  createReadStream as createReadStream2,
  existsSync as existsSync5,
  mkdirSync as mkdirSync4,
  openSync as openSync4,
  readFileSync as readFileSync4,
  readdirSync as readdirSync2,
  renameSync as renameSync3,
  rmSync as rmSync3,
  statSync as statSync2,
  statfsSync,
  writeFileSync as writeFileSync2,
  writeSync as writeSync2
} from "node:fs";
import { dirname as dirname7, isAbsolute as isAbsolute5, join as join6 } from "node:path";

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
var STALE_LOCK_MS = 60 * 60000;
var LOCK_REFRESH_MS = 30000;
var LOCK_POLL_MS = 1000;
var BUILT_IN_REASONING_SPACE_HEADROOM_BYTES = 2 * 1024 ** 3;
var RUNTIME_UNPACK_FACTOR = 4;
var SPACE_BACKOFF_MS = 15 * 60000;
var PROGRESS_WRITE_INTERVAL_MS = 500;
var DOWNLOAD_STALL_MS = 2 * 60000;
var VERIFY_TIMEOUT_MS = 15 * 60000;
var EXTRACT_TIMEOUT_MS = 5 * 60000;
var LOG_PREFIX = "[built-in-model]";
var RUNTIME_MARKER = "olympus-runtime.json";
var SERVER_BINARY = "llama-server";

class BuiltInReasoningInstallError extends Error {
  reason;
  shortfall;
  constructor(reason, message, shortfall) {
    super(message);
    this.name = "BuiltInReasoningInstallError";
    this.reason = reason;
    this.shortfall = shortfall;
  }
}
function currentPlatform() {
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
    const parsed = JSON.parse(readFileSync4(statusPath, "utf8"));
    return parsed && typeof parsed === "object" && parsed.modelId === modelId ? parsed : fallback;
  } catch {
    return fallback;
  }
}
async function installPinnedModel(options) {
  const { onProgress, log: installLog, ...serializable } = options;
  if (isMainThread && !Object.values(serializable).some((value) => typeof value === "function")) {
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
  const platform = options.platform ?? currentPlatform();
  const reporter = new ProgressReporter(paths.statusPath, bundle.modelId, noun, options.now, options.onProgress);
  const files = bundle.files.map((file) => ({ file, path: join6(paths.modelDir, file.name) }));
  const filesPresent = () => files.every(({ path }) => existsSync5(path));
  const log = options.log ?? ((line) => console.log(line));
  const timing = {
    downloadStallMs: options.downloadStallMs ?? DOWNLOAD_STALL_MS,
    verifyTimeoutMs: options.verifyTimeoutMs ?? VERIFY_TIMEOUT_MS
  };
  const lockWaitMs = options.lockWaitMs ?? STALE_LOCK_MS;
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
    ensureDirectory(paths.root);
    const installed = () => ({
      filePaths: files.map(({ path }) => path),
      serverPath: findServerBinary(paths.runtimeDir),
      gpu: archive.gpu
    });
    if (filesPresent() && runtimeInstalled(paths.runtimeDir, archive)) {
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
    await stage("install", () => withInstallLock(paths.lockPath, lockWaitMs, lockRefreshMs, noun, async () => {
      if (filesPresent() && runtimeInstalled(paths.runtimeDir, archive))
        return;
      const fetchImpl = options.fetchImpl ?? fetch;
      const missing = files.filter(({ path }) => !existsSync5(path));
      const needRuntime = !runtimeInstalled(paths.runtimeDir, archive);
      const missingBytes = missing.reduce((total, { file, path }) => total + Math.max(0, file.bytes - fileSize(`${path}.partial`)), 0);
      assertSpaceFor(paths.root, space, missingBytes + (needRuntime ? archive.bytes * RUNTIME_UNPACK_FACTOR : 0));
      reporter.begin(missing.reduce((total, { file }) => total + file.bytes, 0) + (needRuntime ? archive.bytes : 0));
      if (needRuntime) {
        await stage("runtime", () => withInstallLock(paths.runtimeLockPath, lockWaitMs, lockRefreshMs, noun, async () => {
          if (runtimeInstalled(paths.runtimeDir, archive))
            return;
          await installRuntime(fetchImpl, paths.runtimeDir, archive, reporter, options.extractArchive ?? extractWithTar, timing.downloadStallMs, space);
        }));
      }
      if (missing.length > 0) {
        ensureDirectory(paths.modelDir);
        for (const { file, path } of missing) {
          await stage("download", () => downloadVerified(fetchImpl, file.url, path, file.bytes, file.sha256, reporter, `Downloading the ${noun} (${bundle.displayName})`, timing.downloadStallMs, space));
        }
      }
    }));
    await stage("verify", verifyAll);
    if (!runtimeInstalled(paths.runtimeDir, archive)) {
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
    return statSync2(path).size;
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
  const reporter = new ProgressReporter(target.statusPath, target.modelId, target.noun, target.now, target.onProgress);
  if (state === "failed" && failure)
    reporter.fail(failure.reason, failure.message);
  else
    reporter.set(state, state === "ready" ? `${capitalize(target.noun)} ready` : `Starting the ${target.noun}`, 100);
}
function findServerBinary(runtimeDir) {
  const marker = readRuntimeMarker(runtimeDir);
  if (marker?.serverPath)
    return join6(runtimeDir, marker.serverPath);
  throw new BuiltInReasoningInstallError("runtime_load_failed", "The built-in model server is not installed.");
}
var verifiedThisProcess;
async function verifyPinnedFile(path, file, noun, reporter, timeoutMs) {
  const key = `${path}:${file.sha256}`;
  verifiedThisProcess ??= new Set;
  if (verifiedThisProcess.has(key))
    return;
  const size = statSync2(path).size;
  const label = `Checking the ${noun}`;
  reporter.verifying(label, 0, file.bytes);
  const digest = size === file.bytes ? await sha256File(path, timeoutMs, (done) => reporter.verifying(label, done, file.bytes)) : undefined;
  if (digest !== file.sha256) {
    rmSync3(path, { force: true });
    throw new BuiltInReasoningInstallError("checksum_mismatch", `${file.name} did not match its pinned checksum and was removed; it will download again.`);
  }
  verifiedThisProcess.add(key);
}
function readRuntimeMarker(runtimeDir) {
  try {
    return JSON.parse(readFileSync4(join6(runtimeDir, RUNTIME_MARKER), "utf8"));
  } catch {
    return;
  }
}
function runtimeInstalled(runtimeDir, archive) {
  const marker = readRuntimeMarker(runtimeDir);
  return marker !== undefined && marker.sha256 === archive.sha256 && existsSync5(join6(runtimeDir, marker.serverPath));
}
async function installRuntime(fetchImpl, runtimeDir, archive, reporter, extract, stallMs, space) {
  const staging = `${runtimeDir}.staging-${randomUUID2()}`;
  ensureDirectory(staging);
  try {
    const archivePath = join6(staging, archive.name);
    await downloadVerified(fetchImpl, archive.url, archivePath, archive.bytes, archive.sha256, reporter, "Downloading the built-in model server", stallMs, space);
    reporter.set("verifying", "Unpacking the built-in model server");
    try {
      await extract(archivePath, staging);
    } catch (error) {
      if (isNoSpaceError(error)) {
        throw spaceShortfallError(space, archive.bytes * RUNTIME_UNPACK_FACTOR + space.headroomBytes, space.freeBytes(dirname7(runtimeDir)) ?? 0, "the disk filled up while unpacking");
      }
      throw new BuiltInReasoningInstallError("runtime_load_failed", `The built-in model server could not be unpacked (${error instanceof Error ? error.message : String(error)}).`);
    }
    rmSync3(archivePath, { force: true });
    const server = locateFile(staging, SERVER_BINARY);
    if (!server) {
      throw new BuiltInReasoningInstallError("runtime_load_failed", `${archive.name} did not contain ${SERVER_BINARY}.`);
    }
    const marker = { archive: archive.name, sha256: archive.sha256, serverPath: server };
    writeFileSync2(join6(staging, RUNTIME_MARKER), `${JSON.stringify(marker, null, 2)}
`);
    rmSync3(runtimeDir, { recursive: true, force: true });
    renameSync3(staging, runtimeDir);
  } catch (error) {
    rmSync3(staging, { recursive: true, force: true });
    throw error;
  }
}
function extractWithTar(archivePath, targetDir) {
  return new Promise((resolve, reject) => {
    const child = spawn("tar", ["-xzf", archivePath, "-C", targetDir], { stdio: ["ignore", "ignore", "pipe"] });
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
        resolve();
      else
        reject(new Error(stderr.trim() || `tar exited with ${status ?? signal}`));
    });
  });
}
function locateFile(root, name, depth = 0, prefix = "") {
  let entries;
  try {
    entries = readdirSync2(join6(root, prefix));
  } catch {
    return;
  }
  if (entries.includes(name)) {
    const relative = prefix ? `${prefix}/${name}` : name;
    try {
      if (statSync2(join6(root, relative)).isFile())
        return relative;
    } catch {}
  }
  if (depth >= 2)
    return;
  for (const entry of entries) {
    const child = prefix ? `${prefix}/${entry}` : entry;
    try {
      if (!statSync2(join6(root, child)).isDirectory())
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
async function downloadVerified(fetchImpl, url, target, expectedBytes, expectedSha256, reporter, label, stallMs, space) {
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
    error: (reason, message) => new BuiltInReasoningInstallError(reason, message),
    diskError: (error) => isNoSpaceError(error) ? spaceShortfallError(space, expectedBytes + space.headroomBytes, space.freeBytes(dirname7(target)) ?? 0, "the disk filled up during the download") : new BuiltInReasoningInstallError("disk_write_failed", `Could not write the download: ${String(error)}`),
    write: space.write,
    onStart: () => reporter.set("downloading", label),
    onProgress: (bytes) => reporter.advance(bytes, label)
  });
}
function hashInto(path, hash, timeoutMs, onProgress) {
  return new Promise((resolve, reject) => {
    let done = 0;
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
        resolve();
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
async function sha256File(path, timeoutMs, onProgress) {
  const hash = createHash2("sha256");
  await hashInto(path, hash, timeoutMs, onProgress);
  return hash.digest("hex");
}
async function withInstallLock(lockPath, waitMs, refreshMs, noun, run) {
  const deadline = Date.now() + waitMs;
  const token = randomUUID2();
  for (;; ) {
    if (tryAcquireLock(lockPath, token))
      break;
    if (Date.now() > deadline) {
      throw new BuiltInReasoningInstallError("download_failed", `Another Olympus process is still installing the ${noun}.`);
    }
    await new Promise((resolve) => setTimeout(resolve, LOCK_POLL_MS));
  }
  const refresh = setInterval(() => refreshLock(lockPath, token), refreshMs);
  refresh.unref?.();
  try {
    await run();
  } finally {
    clearInterval(refresh);
    if (lockHolder(lockPath)?.token === token)
      rmSync3(lockPath, { force: true });
  }
}
function lockHolder(lockPath) {
  try {
    return JSON.parse(readFileSync4(lockPath, "utf8"));
  } catch {
    return;
  }
}
function refreshLock(lockPath, token) {
  if (lockHolder(lockPath)?.token !== token)
    return;
  try {
    const temporary = `${lockPath}.${process.pid}.tmp`;
    writeFileSync2(temporary, JSON.stringify({ pid: process.pid, at: Date.now(), token }), { mode: 384 });
    renameSync3(temporary, lockPath);
  } catch {}
}
function tryAcquireLock(lockPath, token) {
  try {
    const fd = openSync4(lockPath, "wx", 384);
    writeSync2(fd, JSON.stringify({ pid: process.pid, at: Date.now(), token }));
    closeSync4(fd);
    return true;
  } catch {
    if (lockIsStale(lockPath)) {
      rmSync3(lockPath, { force: true });
      return tryAcquireLock(lockPath, token);
    }
    return false;
  }
}
function lockIsStale(lockPath) {
  try {
    const holder = JSON.parse(readFileSync4(lockPath, "utf8"));
    if (typeof holder.pid === "number" && holder.pid !== process.pid) {
      try {
        process.kill(holder.pid, 0);
      } catch (error) {
        if (error.code === "ESRCH")
          return true;
      }
    }
    return typeof holder.at === "number" && Date.now() - holder.at > STALE_LOCK_MS;
  } catch {
    try {
      return Date.now() - statSync2(lockPath).mtimeMs > STALE_LOCK_MS;
    } catch {
      return true;
    }
  }
}
function ensureDirectory(path) {
  try {
    mkdirSync4(path, { recursive: true, mode: 448 });
  } catch (error) {
    throw new BuiltInReasoningInstallError("disk_write_failed", `Could not create ${path}: ${String(error)}`);
  }
}

class ProgressReporter {
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
  fail(reason, message, shortfall) {
    this.status = {
      ...this.status,
      state: "failed",
      label: reason === "insufficient_space" ? `Waiting for free disk space to download the ${this.noun}` : `The ${this.noun} could not be installed`,
      failure: { reason, message, ...shortfall ?? {} }
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
      mkdirSync4(dirname7(this.statusPath), { recursive: true, mode: 448 });
      const temporary = `${this.statusPath}.${process.pid}.tmp`;
      writeFileSync2(temporary, `${JSON.stringify(this.status)}
`, { mode: 384 });
      renameSync3(temporary, this.statusPath);
    } catch {}
  }
}

// src/workers/source-index/built-in-reasoning/server.ts
import { isMainThread as isMainThread2 } from "node:worker_threads";
import { spawn as spawn2 } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync as rmSync4, writeFileSync as writeFileSync3 } from "node:fs";
import { createServer } from "node:net";
import { availableParallelism, setPriority, tmpdir } from "node:os";
import { join as join8 } from "node:path";

// src/core/owner-config-read.ts
import { chmodSync, linkSync, readFileSync as readFileSync5, statSync as statSync3, lstatSync as lstatSync3 } from "node:fs";
import { randomUUID as randomUUID3 } from "node:crypto";
import { homedir as homedir4 } from "node:os";
import { dirname as dirname8, join as join7 } from "node:path";
function linuxOwnerConfigPath(name, env = process.env) {
  if (process.platform !== "linux")
    return;
  const layout = resolveLinuxEngineLayout(env);
  const owned = !!readLinuxEngineReceipt(layout.receiptPath) || env.OLYMPUS_ENGINE_HOST === "1" || env.OLYMPUS_STANDALONE === "1";
  if (!owned && name !== "sovereignty.json")
    return join7(layout.home, ".olympus", name);
  if (!owned)
    migrateHostedSovereignty(join7(layout.home, ".olympus", name), join7(layout.configDir, name));
  if ((owned ? [name, ...LEGACY_LINUX_POLICY_FILES] : [name]).some((file) => lstatSync3(join7(layout.home, ".olympus", file), { throwIfNoEntry: false }))) {
    throw new Error("Legacy Olympus settings still need migration. Complete the Linux engine upgrade, or back up and migrate an unreceipted installation, before using its settings; existing privacy protections were not ignored.");
  }
  return join7(layout.configDir, name);
}
function migrateHostedSovereignty(legacy, target) {
  if (!lstatSync3(legacy, { throwIfNoEntry: false }))
    return;
  const backup = `${legacy}.pre-xdg-migration.bak`;
  for (const path of [legacy, target, backup])
    assertLinuxManagedPath(path);
  ensurePrivateRootDirectorySync(dirname8(target));
  withFileLeaseSync(legacy, () => withFileLeaseSync(target, (lease) => {
    if (!lstatSync3(legacy, { throwIfNoEntry: false }))
      return;
    for (const path of [legacy, target, backup])
      assertLinuxManagedPath(path);
    const original = readOwnerConfigFile(legacy);
    if (original.status !== "ok")
      throw new Error("Olympus could not safely move your old privacy settings. Your existing settings were kept. Ask the person who installed Olympus to check the file permissions.");
    for (const path of [target, backup]) {
      if (lstatSync3(path, { throwIfNoEntry: false }) && readFileSync5(path, "utf8") !== original.text) {
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
  if (lstatSync3(path, { throwIfNoEntry: false })) {
    assertLinuxManagedPath(path);
    if (readFileSync5(path, "utf8") !== text)
      throw new Error(`Olympus found different privacy settings at ${path}. Both copies were kept. Ask the person who installed Olympus to choose which settings to keep before restarting.`);
    chmodSync(path, 384);
    return;
  }
  const temp = `${path}.${randomUUID3()}.tmp`;
  try {
    writePrivateFileAtomicSync(temp, text);
    linkSync(temp, path);
    syncDirectorySync(dirname8(path));
  } finally {
    removeFileDurablySync(temp);
  }
}
function defaultSovereigntyConfigPath(env = process.env) {
  return linuxOwnerConfigPath("sovereignty.json", env) ?? join7(env.HOME?.trim() || homedir4(), ".olympus", "sovereignty.json");
}
function readOwnerConfigFile(path) {
  let before;
  try {
    before = statSync3(path);
  } catch (error) {
    return error.code === "ENOENT" ? { status: "missing" } : { status: "refused", reason: "unreadable", stamp: "unreadable" };
  }
  const stamp = stampOf(before);
  if (!before.isFile() || (before.mode & 18) !== 0 || !ownedByThisUser(before)) {
    return { status: "refused", reason: "unsafe_permissions", stamp };
  }
  let text;
  try {
    text = readFileSync5(path, "utf8");
  } catch {
    return { status: "refused", reason: "unreadable", stamp };
  }
  let after;
  try {
    after = statSync3(path);
  } catch {
    return { status: "refused", reason: "torn_read", stamp };
  }
  if (stampOf(after) !== stamp || Buffer.byteLength(text, "utf8") !== before.size) {
    return { status: "refused", reason: "torn_read", stamp: stampOf(after) };
  }
  return { status: "ok", text, stamp };
}
function stampOf(stat) {
  return `${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
}
function ownedByThisUser(stat) {
  const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
  return uid === undefined || stat.uid === uid;
}

// src/core/zkapi-consult-settings.ts
import { readFileSync as readFileSync6, statSync as statSync4 } from "node:fs";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

// src/core/operation-error.ts
class OperationError extends Error {
  code;
  suggestion;
  constructor(code, message, suggestion) {
    super(message);
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

// src/core/zkapi-consult-settings.ts
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
    const stat = statSync4(path);
    stamp = `${path}:${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
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
    const ports = zkapiPortsInPolicy(JSON.parse(readFileSync6(path, "utf8")));
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
  constructor(reason, message, policyPath) {
    super("config_error", message, refusalSuggestion(reason, policyPath));
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
    const cancelled = response.body?.cancel();
    if (cancelled && typeof cancelled.catch === "function") {
      cancelled.catch(() => {
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

// src/workers/source-index/built-in-reasoning/server.ts
class LlamaServerStartError extends Error {
  constructor(message) {
    super(message);
    this.name = "LlamaServerStartError";
  }
}

class LlamaServerStillExitingError extends LlamaServerStartError {
  constructor(message) {
    super(message);
    this.name = "LlamaServerStillExitingError";
  }
}

class LlamaServerStopError extends Error {
  constructor(message) {
    super(message);
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
  if (isMainThread2 && !options.spawnImpl && !options.fetchImpl && !options.onPid) {
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
  const spawnImpl = options.spawnImpl ?? spawn2;
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
    const tokenDir = mkdtempSync(join8(tmpdir(), "olympus-built-in-model-"));
    const tokenFile = join8(tokenDir, "token");
    let spawnedProcess;
    try {
      writeFileSync3(tokenFile, `${token}
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
      await new Promise((resolve) => setTimeout(resolve, HEALTH_POLL_MS));
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
        const cancelled = starting;
        try {
          await abortable(cancelled.promise.then(() => {
            return;
          }, () => {
            return;
          }), signal);
        } catch {
          throw callerCancelled(signal?.reason);
        }
        if (generation !== callerGeneration)
          throw new LlamaServerStartError(STOPPED_WHILE_STARTING);
        if (starting === cancelled)
          starting = undefined;
        if (endpoint && current && !current.exited)
          return endpoint;
      }
      if (!starting) {
        const controller = new AbortController;
        const shared = {
          controller,
          waiters: 0,
          promise: start(generation, controller.signal).finally(() => {
            if (starting === shared)
              starting = undefined;
          })
        };
        shared.promise.catch(() => {
          return;
        });
        starting = shared;
      }
      const shared = starting;
      if (!signal) {
        shared.waiters = Number.POSITIVE_INFINITY;
        return shared.promise;
      }
      shared.waiters += 1;
      try {
        return await abortable(shared.promise, signal);
      } catch (error) {
        if (signal.aborted) {
          shared.waiters -= 1;
          if (shared.waiters <= 0)
            shared.controller.abort(signal.reason);
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
    rmSync4(tokenDir, { recursive: true, force: true });
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
      return new Promise((resolve) => {
        const settle = (value) => {
          clearTimeout(timer);
          exitWaiters.delete(onExited);
          resolve(value);
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
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then((value) => {
      signal.removeEventListener("abort", onAbort);
      resolve(value);
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
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close(() => port > 0 ? resolve(port) : reject(new LlamaServerStartError("No free loopback port.")));
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
var handles = new Map;
var controllers = new Map;
var send = (reply) => port.postMessage(reply);
port.on("message", async (message) => {
  if (message.shutdown) {
    try {
      await Promise.all([...handles.values()].map((handle) => handle.stop()));
    } finally {
      Atomics.store(workerData.shutdown, 0, 1);
      Atomics.notify(workerData.shutdown, 0);
    }
    return;
  }
  if (message.cancel !== undefined) {
    controllers.get(message.cancel)?.abort();
    return;
  }
  const { id, request } = message;
  const controller = new AbortController;
  controllers.set(id, controller);
  try {
    let result;
    switch (request.kind) {
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
        await Promise.all([...handles.values()].map((handle) => handle.stop()));
        break;
    }
    send({ id, result });
    if (request.kind === "shutdown")
      port.close();
  } catch (error) {
    const failure = error;
    send({ id, error: { name: failure.name, message: failure.message, reason: failure.reason, shortfall: failure.shortfall } });
  } finally {
    controllers.delete(id);
  }
});
