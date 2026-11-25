// @bun
// src/workers/engine-split/control-worker.ts
import { chmodSync } from "fs";
import { rename, utimes, writeFile } from "fs/promises";

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

// src/core/openclaw-plugin-remote.ts
import { readFileSync } from "fs";
import { homedir } from "os";
import { isAbsolute as isAbsolutePath, join } from "path";
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
import { dirname, isAbsolute, join as join2 } from "path";
var ID = "ai.olympusplugin.Olympus";
function linuxDesktopEntryPaths(layout) {
  return {
    desktop: join2(layout.dataHome, "applications", `${ID}.desktop`),
    icon: join2(layout.dataHome, "icons/hicolor/512x512/apps", `${ID}.png`)
  };
}

// src/core/linux-engine-layout.ts
import fs, { mkdirSync, realpathSync } from "fs";
import { homedir as homedir2 } from "os";
import { dirname as dirname2, isAbsolute as isAbsolute2, join as join3, relative, resolve, sep } from "path";

// src/core/file-lease.ts
import { execFileSync } from "child_process";
import { createRequire } from "module";
var runtimeRequire = createRequire(import.meta.url);
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

// src/core/linux-engine-layout.ts
var layoutMemo = new Map;
var receiptMemo = new Map;
function memoEnabled() {
  const role = process.env.OLYMPUS_WORKER_ENGINE_ROLE?.trim();
  return process.env.OLYMPUS_ENGINE_HOST === "1" || role === "front" || role === "background";
}
function absolute(value, name) {
  if (!isAbsolute2(value) || /[\x00-\x1f\x7f]/.test(value))
    throw new Error(`${name} must be an absolute path without control characters.`);
  return resolve(value);
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
    return !info.isDirectory() || info.isSymbolicLink() || fs.readdirSync(path).some((name) => path !== xdgDataDir || name !== "engine");
  };
  const dataDir = recordedDataDir ?? (hasData(xdgDataDir) ? xdgDataDir : legacyDirs.find(hasData) ?? xdgDataDir);
  const stateDir = join3(stateHome, "olympus/engine"), cacheDir = join3(cacheHome, "olympus/engine");
  const packageDir = dataDir === xdgDataDir ? join3(dataHome, "olympus-engine") : join3(dataHome, "olympus/engine");
  const managedRoots = [configDir, dataDir, stateDir, cacheDir, packageDir];
  for (let i = 0;i < managedRoots.length; i += 1)
    for (let j = i + 1;j < managedRoots.length; j += 1) {
      const forward = relative(managedRoots[i], managedRoots[j]), reverse = relative(managedRoots[j], managedRoots[i]);
      if (forward === "" || !forward.startsWith(`..${sep}`) && forward !== ".." && !isAbsolute2(forward) || !reverse.startsWith(`..${sep}`) && reverse !== ".." && !isAbsolute2(reverse))
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
    return fs.lstatSync(path);
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
    const parent = dirname2(current);
    if (parent === current)
      break;
    current = parent;
  }
}
function readLinuxEngineReceipt(path, uid = process.getuid()) {
  if (!memoEnabled())
    return readLinuxEngineReceiptFromDisk(path, uid);
  const key = JSON.stringify([path, uid]);
  if (!receiptMemo.has(key))
    receiptMemo.set(key, readLinuxEngineReceiptFromDisk(path, uid));
  return structuredClone(receiptMemo.get(key));
}
function readLinuxEngineReceiptFromDisk(path, uid) {
  if (!stat(path))
    return;
  assertLinuxManagedPath(path, uid);
  if ((fs.lstatSync(path).mode & 63) !== 0)
    throw new Error(`${path} must be private (0600).`);
  const receipt = JSON.parse(fs.readFileSync(path, "utf8"));
  if (receipt.schema !== "olympus.engine.install.v1" || receipt.uid !== uid || !receipt.layout)
    throw new Error(`${path} is a foreign or invalid install receipt.`);
  if (!["installed", "recovery_pending", "data_retained"].includes(receipt.installationState))
    throw new Error(`${path} has an invalid installation state.`);
  const l = receipt.layout;
  const expected = rawLayout({ HOME: l.home, XDG_CONFIG_HOME: l.configHome, XDG_DATA_HOME: l.dataHome, XDG_STATE_HOME: l.stateHome, XDG_CACHE_HOME: l.cacheHome, XDG_RUNTIME_DIR: l.runtimeHome }, l.dataDir);
  if (!linuxEngineLayoutsEqual(l, expected) || l.receiptPath !== path)
    throw new Error(`${path} has an inconsistent install layout.`);
  const parentPaths = new Set([dirname2(l.stateDir), dirname2(l.cacheDir)]);
  if (receipt.ownedEmptyParents !== undefined && (!Array.isArray(receipt.ownedEmptyParents) || new Set(receipt.ownedEmptyParents.map((entry) => entry?.path)).size !== receipt.ownedEmptyParents.length || receipt.ownedEmptyParents.some((entry) => !entry || !parentPaths.has(entry.path) || !Number.isSafeInteger(entry.device) || entry.device < 0 || !Number.isSafeInteger(entry.inode) || entry.inode <= 0))) {
    throw new Error(`${path} has invalid empty-directory ownership.`);
  }
  const allowedLinkParents = new Set([join3(l.configHome, "systemd/user"), join3(l.home, ".config/systemd/user")]);
  if (!Array.isArray(receipt.ownedUnitLinks) || receipt.ownedUnitLinks.some((p) => typeof p !== "string" || !isAbsolute2(p) || p === l.unitPath || !allowedLinkParents.has(dirname2(p)) || !p.endsWith("/olympus-engine.service")))
    throw new Error(`${path} has invalid unit links.`);
  if (!Array.isArray(receipt.machineArtifacts) || receipt.machineArtifacts.some((entry) => !entry || typeof entry.path !== "string" || !isAbsolute2(entry.path) || !["file", "symlink", "tree"].includes(entry.kind) || !/^[0-9a-f]{64}$/.test(entry.sha256) || entry.kind === "tree" && (!Number.isSafeInteger(entry.rootDevice) || entry.rootDevice < 0 || !Number.isSafeInteger(entry.rootInode) || entry.rootInode <= 0 || entry.markerPath !== join3(entry.path, ".olympus-generation.json") || !/^[0-9a-f]{64}$/.test(entry.markerSha256 ?? "")) || entry.kind !== "tree" && (entry.rootDevice !== undefined || entry.rootInode !== undefined || entry.markerPath !== undefined || entry.markerSha256 !== undefined))) {
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
    const valid = artifact.kind === "file" ? fileArtifacts.has(artifact.path) : artifact.kind === "symlink" ? unitLinks.has(artifact.path) && artifact.path.endsWith("/olympus-engine.service") : dirname2(artifact.path) === join3(l.packageDir, "generations") && artifact.sha256 === artifact.path.slice(artifact.path.lastIndexOf("/") + 1);
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
  const memo = memoEnabled();
  const uid = process.getuid?.();
  const key = JSON.stringify([home, configHome, env.XDG_DATA_HOME || "", env.XDG_STATE_HOME || "", env.XDG_CACHE_HOME || "", env.XDG_RUNTIME_DIR || "", candidates, uid]);
  const cached = memo ? layoutMemo.get(key) : undefined;
  if (cached)
    return { ...cached };
  const present = candidates.filter((p) => stat(p));
  if (present.length > 1)
    throw new Error(`Found multiple Olympus install receipts: ${present.join(", ")}. Select one installation after moving the other aside.`);
  const receipt = present[0] ? readLinuxEngineReceipt(present[0]) : undefined;
  if (receipt && receipt.layout.home !== home)
    throw new Error(`${present[0]} belongs to another home.`);
  const layout = receipt?.layout ?? rawLayout(env);
  if (memo) {
    layoutMemo.set(key, { ...layout });
    for (const path of candidates)
      if (!present.includes(path))
        receiptMemo.set(JSON.stringify([path, uid]), undefined);
  }
  return layout;
}
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

// src/core/worker-transport.ts
var WORKER_SOCKET_SERVE_OPTIONS = { idleTimeout: 0 };
function workerSocketServe(options) {
  return Object.assign(options, WORKER_SOCKET_SERVE_OPTIONS);
}

// src/workers/answer-activity.ts
import { AsyncLocalStorage as AsyncLocalStorage5 } from "async_hooks";

// src/core/memory-counters.ts
import { AsyncLocalStorage } from "async_hooks";
var payloadScope = new AsyncLocalStorage;

// src/core/model-stream.ts
import { AsyncLocalStorage as AsyncLocalStorage4 } from "async_hooks";

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

// src/core/source-answer-jobs.ts
import { AsyncLocalStorage as AsyncLocalStorage3 } from "async_hooks";

// src/core/secret-patterns.ts
var PROSE_WORDS = new Set([
  "above",
  "again",
  "below",
  "cannot",
  "change",
  "changed",
  "characters",
  "choose",
  "click",
  "contact",
  "enter",
  "expired",
  "expires",
  "forgot",
  "forgotten",
  "guideline",
  "guidelines",
  "hidden",
  "incorrect",
  "information",
  "instruction",
  "instructions",
  "invalid",
  "least",
  "letters",
  "link",
  "manager",
  "maximum",
  "min",
  "minimum",
  "must",
  "need",
  "needed",
  "needs",
  "number",
  "numbers",
  "optional",
  "please",
  "policies",
  "policy",
  "protected",
  "provide",
  "provided",
  "required",
  "requirements",
  "reset",
  "retry",
  "see",
  "send",
  "sent",
  "setting",
  "settings",
  "shared",
  "should",
  "shown",
  "sign",
  "strength",
  "symbols",
  "unchanged",
  "use",
  "used",
  "using",
  "via"
]);
var CREDENTIAL_KEYS = [
  { pattern: String.raw`api[_ -]?key`, legacy: true },
  { pattern: String.raw`access[_ -]?token`, legacy: true },
  { pattern: String.raw`refresh[_ -]?token`, legacy: true },
  { pattern: String.raw`client[_ -]?secret`, legacy: true },
  { pattern: "password", legacy: true },
  { pattern: String.raw`pass(?:wd|phrase|code)|(?<![a-z])pass|pwd` },
  { pattern: String.raw`secret[_ -]?(?:access[_ -]?)?key(?:[_-]?base)?` },
  { pattern: String.raw`private[_ -]?key` },
  { pattern: "secret" },
  { pattern: String.raw`token(?!s)` },
  { pattern: "sig", urlOnly: true }
];
var CREDENTIAL_KEY_WORDS = CREDENTIAL_KEYS.filter((key) => !key.urlOnly).map((key) => key.pattern).join("|");
var LEGACY_KEY_WORDS = CREDENTIAL_KEYS.filter((key) => key.legacy).map((key) => key.pattern).join("|");
var CREDENTIAL_QUERY_KEY = new RegExp(`^(?:${CREDENTIAL_KEYS.map((key) => key.pattern).join("|")})$`, "i");
var PLACEHOLDER_WORDS = new RegExp([
  String.raw`(?:^|[^a-z])your[_ .-]?[a-z_ -]{0,16}(?:api|secret|token|key|pass|password|client|value|here)`,
  String.raw`(?:^|[^a-z])my[_ .-](?:api|secret|token|key|pass|password|client)`,
  String.raw`(?:^|[^a-z])(?:example|dummy|todo|fixme)(?:[^a-z]|$)`,
  "placeholder",
  "redacted",
  "changeme",
  "change[_-]me",
  "replace[_-]?me",
  "insert[_-]?(?:your|here|key|token)",
  "[_-]here$",
  "^n/a$",
  "not[_ -]?set",
  "^unset$"
].join("|"), "i");
var BARE_LITERALS = new Set([
  "password",
  "passwd",
  "passphrase",
  "secret",
  "token",
  "apikey",
  "api_key",
  "api-key",
  "string",
  "null",
  "none",
  "nil",
  "undefined",
  "true",
  "false",
  "empty",
  "hidden",
  "masked",
  "required",
  "optional",
  "changeme",
  "enabled",
  "disabled",
  "encrypted",
  "hashed",
  "unknown",
  "tbd",
  "pending",
  "missing"
]);
var COMMON_OBJECTS = new Set([
  "user",
  "users",
  "body",
  "data",
  "form",
  "state",
  "props",
  "creds",
  "credentials",
  "account",
  "profile",
  "session",
  "auth",
  "db",
  "app",
  "json",
  "response",
  "res",
  "row",
  "record",
  "item",
  "model"
]);
var STRONG_QUALIFIERS = new Set([
  "client",
  "app",
  "api",
  "access",
  "refresh",
  "auth",
  "bearer",
  "id",
  "session",
  "bot",
  "oauth",
  "webhook",
  "signing",
  "jwt",
  "service",
  "personal",
  "consumer",
  "shared",
  "encryption",
  "master",
  "admin",
  "root",
  "user",
  "db",
  "database",
  "wifi",
  "email",
  "login"
]);
var ENV_KEY_WORDS = CREDENTIAL_KEY_WORDS;
var ENV_CREDENTIAL_KEY = new RegExp(ENV_KEY_WORDS, "i");
var KEYWORD = `(?<kw>${CREDENTIAL_KEY_WORDS})`;
var SEPARATOR = String.raw`["'\x60*_]{0,3}[ \t]*(?::=|=>|[:=])[*_]{0,2}[ \t]*(?<nl>\r?\n[ \t]*)?`;
var VALUE = String.raw`(?:"(?<dq>(?:[^"\\\n\r]|\\.)*)"|'(?<sq>(?:[^'\\\n\r]|\\.)*)'|\x60(?<bq>[^\x60\n\r]*)\x60|(?<uv>[^\s"'\x60]+))`;
var CREDENTIAL_ASSIGNMENT = new RegExp(`${KEYWORD}${SEPARATOR}${VALUE}`, "gi");
var ENV_ASSIGNMENT = new RegExp(String.raw`(?<![A-Za-z0-9_.?&/%+=-])(?=(?:--)?[A-Za-z0-9_.-]*?(?:${ENV_KEY_WORDS}))(?<ek>(?:--)?[A-Za-z_][A-Za-z0-9_.-]*)[ \t]*=(?![=~>])[ \t]*${VALUE}`, "gi");
var BLOCK_SCALAR = new RegExp(String.raw`${KEYWORD}["'\x60]{0,2}[ \t]*:[ \t]*[|>](?:[+-][1-9]?|[1-9][+-]?)?[ \t]*(?:#[^\r\n]*)?\r?\n(?:[ \t]*\r?\n)*(?<ind>[ \t]+)(?<bv>[^ \t\r\n][^\r\n]*)`, "gi");
var LABELLED_PASSPHRASE = new RegExp(String.raw`^[ \t>*\u2022-]*(?:[A-Za-z0-9 _.-]{0,30}?)pass(?:word|phrase|code)["'\x60*_]{0,3}[ \t]*(?::=|[:=])[*_]{0,2}[ \t]*(?<mv>[^\s][^\n\r]{5,159})$`, "gim");
var RECOVERY_CODE_LABEL = new RegExp(String.raw`(?<![A-Za-z0-9])(?:recovery|backup)(?:[ \t_-]+(?:verification|security|login|sign[ -]?in|2fa|mfa|two[ -]factor|account))?[ \t_-]+(?:codes?|keys?)["'\x60*_]{0,3}[ \t]*(?:[:=]|(?<![A-Za-z])(?:is|are)(?![A-Za-z])[ \t]*:?)[*_]{0,2}[ \t]*(?<rest>[^\r\n]{0,200})`, "gi");
var LEGACY_CREDENTIAL_ASSIGNMENT = new RegExp(String.raw`\b(${LEGACY_KEY_WORDS})\b\s*[:=]\s*['"]?[^'"\s]{12,}`, "gi");

// src/core/release-manifest.ts
import { AsyncLocalStorage as AsyncLocalStorage2 } from "async_hooks";
var RELEASE_CHUNK_JUDGE_BUDGET_MS = 8000;
var chunkProvenance = new WeakMap;
var storage = new AsyncLocalStorage2;
var withheldAnswers = new WeakSet;

// src/core/source-answer-jobs.ts
var SOURCE_ANSWER_JOB_TTL_MS = 15 * 60000;
var SOURCE_ANSWER_JOB_IDLE_MS = 5 * 60000;
var SOURCE_ANSWER_MAX_RESULT_BYTES = 2 * 1024 * 1024;
var progressSink = new AsyncLocalStorage3;

// src/core/model-stream.ts
var progress = new AsyncLocalStorage4;
function withModelProgress(listener, work) {
  const parent = progress.getStore();
  return progress.run((model) => {
    parent?.(model);
    listener(model);
  }, work);
}
function currentModelProgress() {
  return progress.getStore();
}

// src/workers/answer-activity.ts
var localInferencePriority;
function currentLocalInferencePriority() {
  return localInferencePriority?.getStore() ?? "owner";
}
function runAtLocalInferencePriority(priority, work) {
  localInferencePriority ??= new AsyncLocalStorage5;
  return localInferencePriority.run(priority, work);
}
var DEFAULT_ANSWER_LEASE_MS = 20 * 60000;

// src/core/olympus-layout.ts
import { homedir as homedir3 } from "os";
import { basename, dirname as dirname3, isAbsolute as isAbsolute3, join as join4, relative as relative2, resolve as resolve2, sep as sep2 } from "path";
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
var ENGINE_READY_PATH = "/engine/ready";
var ENGINE_PRIVACY_READY_QUERY = "privacy_raises_settled";
var ENGINE_COMMANDS_PATH = "/engine/commands";
var ENGINE_MODEL_COMPLETE_PATH = "/engine/model/complete";

// src/workers/http.ts
import { createHmac, randomBytes, timingSafeEqual } from "crypto";

// src/workers/engine-split/click-trace.ts
var CLICK_ID_HEADER = "X-Olympus-Click-Id";
var PRIVACY_ITEM_SET_PATH = "/dashboard/privacy/items/set";
function readClickId(request) {
  const id = request.headers.get(CLICK_ID_HEADER);
  return id && id.length <= 80 && !/[^A-Za-z0-9_-]/.test(id) ? id : undefined;
}
var clickTraces = new WeakMap;
function logClickTrace(id, requestId, point, role, details, at = new Date().toISOString()) {
  console.log(`${at} [olympus:click-trace] id=${id} request_id=${requestId ?? "none"} point=${point} role=${role} ${details}`);
}

// src/core/request-peer.ts
var ownerSockets = new WeakSet;
var peers = new WeakMap;

// src/core/open-targets.ts
var OPEN_CONNECT_SOURCES = {
  x: { sourceId: "x.bookmarks", label: "X bookmarks" },
  readwise: { sourceId: "readwise.library", label: "Readwise" },
  telegram: { sourceId: "telegram.messages", label: "Telegram" },
  whatsapp: { sourceId: "whatsapp.personal.messages", label: "WhatsApp" },
  evernote: { sourceId: "evernote.notes", label: "Evernote" }
};
var OPEN_FIX_SECTIONS = ["connect", "reconnect", "answers", "search", "models"];
var OPEN_UNREADABLE_SOURCES = {
  dropbox: { sourceId: "dropbox.files", label: "Dropbox" },
  drive: { sourceId: "google_drive.docs", label: "Google Drive" },
  whatsapp: { sourceId: "whatsapp.personal.messages", label: "WhatsApp" }
};
function allOpenTargets() {
  return [
    { kind: "dashboard" },
    { kind: "private_answers" },
    ...Object.keys(OPEN_CONNECT_SOURCES).map((source) => ({ kind: "connect", source })),
    ...OPEN_FIX_SECTIONS.map((section) => ({ kind: "fix", section })),
    ...Object.keys(OPEN_UNREADABLE_SOURCES).map((source) => ({ kind: "unreadable", source })),
    { kind: "archives" }
  ];
}
function openTargetToken(target) {
  if (target.kind === "private_answers")
    return target.answerId ? `page.private.${target.answerId}` : "page.private";
  if (target.kind === "connect")
    return `connect.${target.source}`;
  if (target.kind === "fix")
    return `fix.${target.section}`;
  if (target.kind === "unreadable")
    return `unreadable.${target.source}`;
  if (target.kind === "archives")
    return "archives";
  return;
}
function openTargetTokenPattern() {
  const tokens = allOpenTargets().map(openTargetToken).filter((token) => token !== undefined);
  return `^(?:page\\.private\\.[A-Za-z0-9_-]{22}|${tokens.map((token) => token.replace(".", "\\.")).join("|")})$`;
}
function isConnectOpenTarget(target) {
  return target.kind === "connect";
}
function isKeysOpenTarget(target) {
  return target.kind === "fix" && (target.section === "models" || target.section === "answers" || target.section === "search");
}
function tokenPattern(filter) {
  const tokens = allOpenTargets().filter(filter).map(openTargetToken).filter((token) => token !== undefined);
  return `^(?:${tokens.map((token) => token.replace(".", "\\.")).join("|")})$`;
}
function keysOpenTargetTokenPattern() {
  return tokenPattern(isKeysOpenTarget);
}
function connectOpenTargetTokenPattern() {
  return tokenPattern(isConnectOpenTarget);
}
function privateAnswersOpenTargetTokenPattern() {
  return "^page\\.private(?:\\.[A-Za-z0-9_-]{22})?$";
}
function isPanelOpenTarget(target) {
  return target.kind === "unreadable" || target.kind === "archives";
}
function panelOpenTargetTokenPattern() {
  const tokens = allOpenTargets().filter(isPanelOpenTarget).map(openTargetToken).filter((token) => token !== undefined);
  return `^(?:${tokens.map((token) => token.replace(".", "\\.")).join("|")})$`;
}
var DASHBOARD_OPEN_FRAGMENT_KEY = "olympus-open";
var DASHBOARD_LAUNCH_OPEN_KEY = "olympus_open";

// src/core/dashboard-launch.ts
var DASHBOARD_LAUNCH_TICKET_FRAGMENT_KEY = "olympus_launch_ticket";
var DASHBOARD_UNLOCK_STORAGE_KEY = "olympus-dashboard-unlock-v1";
var DASHBOARD_UNLOCK_HEADER = "X-Olympus-Dashboard-Unlock";
var DASHBOARD_UNLOCK_SHELL_HEADER = "X-Olympus-Dashboard-Shell";
var DASHBOARD_LAUNCH_PAGE_HTML = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <meta name="referrer" content="no-referrer">
    <title>Olympus</title>
    <style>
      body { margin: 0; padding: 3rem 1.5rem; font: 15px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Noto Sans", Ubuntu, Cantarell, "Liberation Sans", "DejaVu Sans", "Helvetica Neue", Arial, system-ui, sans-serif; color: #e8e6e3; background: #16151a; }
      main { max-width: 32rem; margin: 0 auto; }
      h1 { font-size: 1.05rem; font-weight: 600; margin: 0 0 .5rem; }
      p { margin: 0; color: #a9a4ae; }
      a { color: #cfc7ff; }
    </style>
  </head>
  <body>
    <main>
      <h1 id="status">Opening Olympus\u2026</h1>
      <p id="detail">If this does not continue, <a href="/dashboard">open the dashboard</a>.</p>
    </main>
    <script>
      (function () {
        var KEY = '${DASHBOARD_LAUNCH_TICKET_FRAGMENT_KEY}';
        var OPEN = /${openTargetTokenPattern()}/;
        var KEYS = /${keysOpenTargetTokenPattern()}/;
        var CONNECT = /${connectOpenTargetTokenPattern()}/;
        var PANEL = /${panelOpenTargetTokenPattern()}/;
        var PRIVATE = /${privateAnswersOpenTargetTokenPattern()}/;
        var status = document.getElementById('status');
        var open = '';
        function take() {
          var hash = window.location.hash.slice(1);
          // Clear even malformed fragments before parsing or making a request.
          try { window.history.replaceState(null, '', window.location.pathname + window.location.search); }
          catch (e) { return ''; }
          var params = new URLSearchParams(hash);
          // Where to land: one of a closed list, or the plain dashboard.
          var wanted = params.get('${DASHBOARD_LAUNCH_OPEN_KEY}') || '';
          if (OPEN.test(wanted)) open = wanted;
          return params.get(KEY) || '';
        }
        var ticket = take();
        if (!ticket) {
          // A reload of this page after its ticket was taken: the dashboard has the session, or the way back in.
          window.location.replace('/dashboard');
          return;
        }
        fetch('/dashboard/control/launch/redeem', {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ticket: ticket })
        }).then(function (response) {
          if (!response.ok) return response;
          // This browser's key for later plain navigations (#1187): kept per origin, so per port.
          return response.json().then(function (body) {
            try {
              if (body && typeof body.unlock_key === 'string') window.localStorage.setItem('${DASHBOARD_UNLOCK_STORAGE_KEY}', body.unlock_key);
            } catch (e) {}
            return response;
          }, function () { return response; });
        }).then(function (response) {
          // A link already used or expired (a reload, a second open) still
          // lands on the dashboard: the session it opened is in its cookie,
          // and without one the dashboard itself offers the way back in.
          if (response.ok || response.status === 403) {
            // Connect lands on Connect a source, where the computer's setup sheets live; a
            // model fix lands on Privacy settings (?keys), where the models live. Each only
            // opens something there, never submits anything.
            // A panel target (See why on one source) lands on the dashboard there.
            // Private answers lands on that page, carrying nothing.
            // Everything else (a reconnect, the dashboard itself) lands on the dashboard.
            window.location.replace(CONNECT.test(open)
              ? '/dashboard?connect#${DASHBOARD_OPEN_FRAGMENT_KEY}=' + open
              : KEYS.test(open) ? '/dashboard?keys#${DASHBOARD_OPEN_FRAGMENT_KEY}=' + open
              : PANEL.test(open) ? '/dashboard#${DASHBOARD_OPEN_FRAGMENT_KEY}=' + open
              : PRIVATE.test(open) ? '/dashboard?private-answers' + (open.indexOf('page.private.') === 0 ? '#' + open.slice(13) : '') : '/dashboard');
            return;
          }
          // Anything else: the dashboard is the way in (its session, or how to get one).
          window.location.replace('/dashboard');
        }).catch(function () {
          status.textContent = 'Opening failed.';
        });
      }());
    </script>
  </body>
</html>
`;
var DASHBOARD_UNLOCK_SHELL_HTML = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <meta name="referrer" content="no-referrer">
    <title>Olympus</title>
    <style>
      body { margin: 0; padding: 3rem 1.5rem; font: 15px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Noto Sans", Ubuntu, Cantarell, "Liberation Sans", "DejaVu Sans", "Helvetica Neue", Arial, system-ui, sans-serif; color: #e8e6e3; background: #16151a; }
      main { max-width: 32rem; margin: 0 auto; }
      h1 { font-size: 1.05rem; font-weight: 600; margin: 0 0 .5rem; }
      p { margin: 0; color: #a9a4ae; }
      code { color: #e8e6e3; }
    </style>
  </head>
  <body>
    <main>
      <h1 id="status">Opening Olympus\u2026</h1>
      <p id="detail"></p>
    </main>
    <script>
      (function () {
        var KEY = '${DASHBOARD_UNLOCK_STORAGE_KEY}';
        var SHELL = '${DASHBOARD_UNLOCK_SHELL_HEADER}';
        var HEADER = '${DASHBOARD_UNLOCK_HEADER}';
        var status = document.getElementById('status');
        var detail = document.getElementById('detail');
        function locked() {
          try { window.localStorage.removeItem(KEY); } catch (e) {}
          status.textContent = 'Dashboard controls are locked';
          detail.textContent = 'Run ';
          var command = document.createElement('code');
          command.textContent = 'olympus dashboard';
          detail.appendChild(command);
          detail.appendChild(document.createTextNode(' in a terminal on this computer to open it again.'));
        }
        function failed() {
          status.textContent = 'Opening failed.';
          detail.textContent = 'Reload this page to try again.';
        }
        var key = '';
        try { key = window.localStorage.getItem(KEY) || ''; } catch (e) {}
        if (!key) { locked(); return; }
        var headers = {};
        headers[HEADER] = key;
        fetch(window.location.href, {
          cache: 'no-store',
          credentials: 'same-origin',
          headers: headers
        }).then(function (response) {
          // A page that moved: go there, and its own navigation proves itself the same way.
          if (response.redirected) { window.location.replace(response.url); return; }
          if (response.headers.get(SHELL) || response.status === 401 || response.status === 403) { locked(); return; }
          var type = response.headers.get('Content-Type') || '';
          if (!response.ok || type.indexOf('text/html') !== 0) { failed(); return; }
          return response.text().then(function (html) {
            document.open();
            document.write(html);
            document.close();
          });
        }).catch(failed);
      }());
    </script>
  </body>
</html>
`;

// src/workers/http.ts
var DASHBOARD_CONTROL_SESSION_TTL_SECONDS = 30 * 24 * 60 * 60;
var AGENT_MINT_PATHS = new Set(["/dashboard/agents/pairing-code", "/dashboard/agents/keys"]);
var AGENT_MINT_WINDOW_MS = 10 * 60000;
var REMOTE_ACCESS_TOGGLE_WINDOW_MS = 10 * 60000;
function hasValidWorkerBearerToken(header, expectedToken) {
  if (!header)
    return false;
  const [scheme, ...rest] = header.split(" ");
  if (scheme !== "Bearer" || rest.length !== 1)
    return false;
  return constantTimeStringEqual(rest[0] ?? "", expectedToken);
}
function constantTimeStringEqual(actual, expected) {
  const actualBytes = new TextEncoder().encode(actual);
  const expectedBytes = new TextEncoder().encode(expected);
  const maxLength = Math.max(actualBytes.byteLength, expectedBytes.byteLength, 1);
  const actualPadded = new Uint8Array(maxLength);
  const expectedPadded = new Uint8Array(maxLength);
  actualPadded.set(actualBytes.slice(0, maxLength));
  expectedPadded.set(expectedBytes.slice(0, maxLength));
  return timingSafeEqual(actualPadded, expectedPadded) && actualBytes.byteLength === expectedBytes.byteLength;
}

// src/core/log-redaction.ts
function redactLogLine(line) {
  return line.replace(/\b(Bearer|token|api[_-]?key|secret|password)([=:\s]+)\S+/gi, "$1$2[redacted]").replace(/\b[A-Za-z0-9_-]{40,}\b/g, "[redacted]");
}
var LOG_ERROR_MESSAGE_MAX_CHARS = 200;
function boundedLogErrorMessage(error) {
  const message = error instanceof Error ? error.message : String(error);
  const oneLine = message.replace(/\s+/g, " ").trim();
  return JSON.stringify(redactLogLine(oneLine).slice(0, LOG_ERROR_MESSAGE_MAX_CHARS));
}
function logErrorOrigin(error) {
  if (!(error instanceof Error))
    return JSON.stringify(typeof error);
  const frame = errorFirstFrame(error);
  return JSON.stringify(redactLogLine(frame ? `${error.name} at ${frame}` : error.name).slice(0, LOG_ERROR_MESSAGE_MAX_CHARS));
}
function errorFirstFrame(error) {
  const line = error.stack?.split(`
`).map((entry) => entry.trim()).find((entry) => entry.startsWith("at "));
  if (!line)
    return;
  return line.slice(3).replace(/(?:[A-Za-z]:)?[^\s()]*[\\/]([^\\/\s()]+:\d+(?::\d+)?)/g, "$1").slice(0, 160);
}

// src/workers/engine-split/commands.ts
var ENGINE_RELOAD_KINDS = ["sources", "scope", "exclusions", "embedding", "models", "archive", "extraction", "pacing"];
var ENGINE_JUDGE_BOOST_MAX_IDS = 20;
var ENGINE_JUDGE_BOOST_TTL_MS = 15 * 60000;
var ENGINE_JUDGE_NOW_MAX_BUDGET_MS = RELEASE_CHUNK_JUDGE_BUDGET_MS;
var ENGINE_FORWARDED_ROUTES = {
  archive_remove: ["/dashboard/archive-import/remove"],
  delete_source_data: ["/dashboard/delete-source-data", "/v1/cli/data-delete"],
  tier_override: ["/v1/cli/tier", "/dashboard/privacy/items/set", "/dashboard/privacy/judge-check"],
  people: ["/dashboard/people"],
  source_sync: ["/v1/source/index/sync", "/v1/source/index/x-bookmarks/content/recover"],
  storage_registry: ["/v1/cli/pairing-placement", "/v1/cli/pairing-account"],
  capture: [
    "/dashboard/messaging/start",
    "/dashboard/messaging/status",
    "/dashboard/messaging/respond",
    "/dashboard/messaging/cancel",
    "/dashboard/messaging/chats",
    "/dashboard/messaging/scope"
  ],
  embed_chunks: ["/v1/source/index/embed"],
  source_item_read: ["/v1/source/item/read"],
  deep_read: ["/v1/source/deep-read", "/v1/source/deep-read/status", "/v1/source/deep-read/cancel"],
  data_export: ["/v1/cli/data-export"],
  owner_limits: ["/v1/limits"],
  source_watch: ["/v1/source/watch/create", "/v1/source/watch/cancel"],
  extraction_queue: [
    "/v1/source/index/files/read-on-demand",
    "/dashboard/privacy/items/read",
    "/v1/source/index/files/plan",
    "/v1/source/index/files/transcribe",
    "/v1/source/index/files/recycle-leases",
    "/v1/source/index/files/janitor-requeue",
    "/v1/source/index/files/extract-pdfs",
    "/v1/source/index/files/extract",
    "/v1/source/index/dropbox/content/plan",
    "/v1/source/index/dropbox/content/recycle-leases",
    "/v1/source/index/dropbox/content/janitor-requeue",
    "/v1/source/index/dropbox/content/extract",
    "/v1/source/index/dropbox/transcribe"
  ]
};
var ENGINE_BODY_MAX_BYTES = 16 * 1024 * 1024;
var ENGINE_DASHBOARD_SAMPLES_MAX = 500;

class EngineCommandError extends Error {
  status;
  constructor(status, message) {
    super(message);
    this.status = status;
    this.name = "EngineCommandError";
  }
}
var ID2 = /^[A-Za-z0-9_-]{8,64}$/;
var SOURCE = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,199}$/;
var RESOURCE = /^[\x21-\x7e]{1,200}$/;
function asRecord2(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : undefined;
}
function isDashboardPrivacyRaise(command) {
  if (command.kind !== "tier_override" || command.request.path !== "/dashboard/privacy/items/set")
    return false;
  try {
    return asRecord2(JSON.parse(command.request.body))?.tier === "private";
  } catch (error) {
    if (error instanceof SyntaxError)
      return false;
    throw error;
  }
}
function boundedString(value, max = 512) {
  return typeof value === "string" && value.length > 0 && value.length <= max ? value : undefined;
}
function dashboardSample(value) {
  const sample = asRecord2(value);
  if (!sample)
    return false;
  for (const [key, entry] of Object.entries(sample)) {
    if (key === "source_id" || key === "corpus_id" || key === "sampled_at") {
      if (!boundedString(entry, 200))
        return false;
    } else if (typeof entry === "number") {
      if (!Number.isFinite(entry))
        return false;
    } else if (typeof entry !== "boolean") {
      return false;
    }
  }
  return typeof sample.corpus_id === "string" && typeof sample.source_id === "string";
}
function forwardedRequest(kind, value) {
  const request = asRecord2(value);
  const path = request?.path;
  if (typeof path !== "string" || !ENGINE_FORWARDED_ROUTES[kind].includes(path)) {
    throw new EngineCommandError(400, `${kind} does not carry that route.`);
  }
  const headers = asRecord2(request.headers);
  if (!headers || Object.values(headers).some((entry) => typeof entry !== "string"))
    throw new EngineCommandError(400, "Forwarded headers must be strings.");
  const body = request.body;
  if (typeof body !== "string")
    throw new EngineCommandError(400, "A forwarded body is text.");
  if (body.length > ENGINE_BODY_MAX_BYTES)
    throw new EngineCommandError(413, "The command body is too large.");
  return { path, headers, body };
}
var forwardedRecordIds = new WeakMap;
var HOP_HEADERS = new Set(["host", "content-length", "connection", "transfer-encoding", "keep-alive", "upgrade", CLICK_ID_HEADER.toLowerCase()]);
function parseEngineCommandEnvelope(value) {
  const record = asRecord2(value);
  const id = record?.id;
  if (typeof id !== "string" || !ID2.test(id))
    throw new EngineCommandError(400, "A command needs an id.");
  const command = asRecord2(record?.command);
  const kind = command?.kind;
  const fail = (message) => {
    throw new EngineCommandError(400, message);
  };
  switch (kind) {
    case "reload": {
      const target = command.target;
      if (!ENGINE_RELOAD_KINDS.includes(target))
        fail("reload needs a known kind.");
      const corpora = command.corpora;
      if (corpora !== undefined && (!Array.isArray(corpora) || corpora.length > 200 || corpora.some((entry) => typeof entry !== "string" || !SOURCE.test(entry)))) {
        fail("reload corpora must be corpus ids.");
      }
      const frontPid = command.frontPid;
      if (frontPid !== undefined && (target !== "models" || !Number.isSafeInteger(frontPid) || frontPid <= 0))
        fail("frontPid is a process id, carried by a models reload.");
      return { id, command: {
        kind,
        target,
        ...Array.isArray(corpora) ? { corpora } : {},
        ...frontPid !== undefined ? { frontPid } : {}
      } };
    }
    case "archive_changed":
    case "model_prepare":
      return { id, command: { kind } };
    case "dashboard_samples": {
      const samples = command.samples;
      if (!Array.isArray(samples) || samples.length > ENGINE_DASHBOARD_SAMPLES_MAX || samples.some((sample) => !dashboardSample(sample))) {
        fail("dashboard_samples takes count samples only.");
      }
      return { id, command: { kind, samples } };
    }
    case "archive_remove":
    case "delete_source_data":
    case "tier_override":
    case "storage_registry":
    case "capture":
    case "embed_chunks":
    case "source_item_read":
    case "source_watch":
    case "extraction_queue":
    case "people":
    case "source_sync":
    case "data_export":
    case "owner_limits": {
      const frontPid = command.frontPid;
      if (frontPid !== undefined && (kind !== "delete_source_data" || !Number.isSafeInteger(frontPid) || frontPid <= 0))
        fail("frontPid is a process id, carried by a delete.");
      return { id, command: { kind, request: forwardedRequest(kind, command.request), ...frontPid !== undefined ? { frontPid } : {} } };
    }
    case "revoke_reads": {
      const { source, reason } = command;
      if (typeof source === "string" && SOURCE.test(source) && (reason === "disconnect" || reason === "scope" || reason === "exclusions")) {
        return { id, command: { kind, source, reason } };
      }
      throw new EngineCommandError(400, "revoke_reads needs a source and a revocation reason.");
    }
    case "sync_now":
    case "start_approved": {
      const source = command.source;
      if (typeof source !== "string" || !SOURCE.test(source))
        fail(`${kind} needs a source.`);
      if (kind === "start_approved")
        return { id, command: { kind, source } };
      return { id, command: { kind, source, manual: command.manual === true } };
    }
    case "tier_set_recorded": {
      const locator = boundedString(command.locator, 2048);
      const expected = asRecord2(command.expected);
      const provider = boundedString(expected?.provider, 64);
      const providerItemId = boundedString(expected?.providerItemId);
      const conversation = expected?.providerConversationId;
      if (!locator || !provider || !providerItemId || conversation !== undefined && !boundedString(conversation)) {
        fail("tier_set_recorded needs a locator and the recorded provider and item.");
      }
      return { id, command: { kind, locator, expected: {
        provider,
        providerItemId,
        ...typeof conversation === "string" ? { providerConversationId: conversation } : {}
      } } };
    }
    case "export_data": {
      const destination = boundedString(command.destination, 4096);
      if (!destination || !destination.startsWith("/"))
        fail("export_data needs an absolute destination.");
      return { id, command: { kind, destination } };
    }
    case "capture_stop": {
      const source = command.source;
      if (source !== "telegram" && source !== "whatsapp")
        fail("capture_stop needs telegram or whatsapp.");
      return { id, command: { kind, source } };
    }
    case "owner_busy":
    case "owner_idle": {
      const resource = command.resource;
      if (typeof resource !== "string" || !RESOURCE.test(resource))
        fail(`${kind} needs a resource.`);
      const front = boundedString(command.front, 64);
      const seq = command.seq;
      if (!front || !Number.isSafeInteger(seq) || seq < 1)
        fail(`${kind} needs its front and a sequence number.`);
      return { id, command: { kind, resource, front, seq } };
    }
    case "judge_boost":
    case "judge_now": {
      const raw = kind === "judge_now" ? command.items : command.identities;
      if (!Array.isArray(raw) || raw.length === 0 || raw.length > ENGINE_JUDGE_BOOST_MAX_IDS) {
        fail(`${kind} takes 1 to ${ENGINE_JUDGE_BOOST_MAX_IDS} items.`);
      }
      const identities = raw.map((entry) => {
        const item = asRecord2(entry);
        const provider = boundedString(item?.provider, 64);
        const accountScope = boundedString(item?.accountScope);
        const providerItemId = boundedString(item?.providerItemId);
        const conversation = item?.providerConversationId;
        if (!provider || !accountScope || !providerItemId || conversation !== undefined && !boundedString(conversation)) {
          fail(`${kind} items need provider, accountScope and providerItemId.`);
        }
        let chunks;
        if (kind === "judge_now") {
          const corpusId = boundedString(item?.corpusId);
          const hashes = item?.chunkHashes;
          if (!corpusId || !Array.isArray(hashes) || !hashes.length || hashes.length > 1024 || hashes.some((hash) => !boundedString(hash, 256)))
            fail("judge_now items need a corpusId and chunk hashes.");
          chunks = { corpusId, chunkHashes: [...new Set(hashes)] };
        }
        return {
          ...chunks,
          provider,
          accountScope,
          providerItemId,
          ...typeof conversation === "string" ? { providerConversationId: conversation } : {}
        };
      });
      if (kind === "judge_now") {
        const budgetMs = command.budgetMs;
        if (typeof budgetMs !== "number" || !Number.isFinite(budgetMs) || budgetMs < 0)
          fail("judge_now needs a nonnegative budgetMs.");
        return { id, command: { kind, items: identities, budgetMs: Math.min(budgetMs, ENGINE_JUDGE_NOW_MAX_BUDGET_MS) } };
      }
      return { id, command: { kind, identities } };
    }
    default:
      return fail("Unknown command.");
  }
}
function createEngineCommandHandler(options) {
  const maxWaitMs = options.maxWaitMs ?? 30000;
  const setTimer = options.setTimeout ?? ((callback, ms) => setTimeout(callback, ms));
  const clearTimer = options.clearTimeout ?? ((timer) => clearTimeout(timer));
  return async (request) => {
    if (!hasValidWorkerBearerToken(request.headers.get("authorization"), options.authToken)) {
      return Response.json({ error: "unauthorized" }, { status: 401 });
    }
    const url = new URL(request.url);
    if (url.pathname === ENGINE_READY_PATH && request.method === "GET") {
      const ready = options.ready();
      const body = { ready, instance_id: options.ledger.instanceId, schema_current: ready };
      if (url.searchParams.has(ENGINE_PRIVACY_READY_QUERY))
        body.privacy_raises_settled = !options.ledger.hasPendingPrivacyRaise();
      return Response.json(body, { status: ready ? 200 : 503 });
    }
    if (url.pathname === ENGINE_COMMANDS_PATH && request.method === "POST") {
      if (!options.ready())
        return Response.json({ error: "starting", instance_id: options.ledger.instanceId }, { status: 503 });
      try {
        const envelope = parseEngineCommandEnvelope(await request.json().catch(() => {
          return;
        }));
        const clickId = envelope.command.kind === "tier_override" && envelope.command.request.path === PRIVACY_ITEM_SET_PATH ? readClickId(request) : undefined;
        let receipt = options.ledger.submit(envelope, clickId);
        if (envelope.command.kind === "judge_now" && receipt.state === "received") {
          const waitMs = envelope.command.budgetMs + 100;
          let timer;
          const wait = new Promise((resolve) => {
            timer = setTimer(resolve, waitMs);
          });
          try {
            receipt = await options.ledger.settled(envelope.id, wait) ?? receipt;
          } finally {
            clearTimer(timer);
          }
        }
        return Response.json(receipt, { status: receipt.state === "received" ? 202 : 200 });
      } catch (error) {
        if (error instanceof EngineCommandError)
          return Response.json({ error: error.message }, { status: error.status });
        throw error;
      }
    }
    if (url.pathname === ENGINE_MODEL_COMPLETE_PATH && request.method === "POST") {
      if (!options.ready() || !options.modelComplete)
        return Response.json({ error: "model_unavailable" }, { status: 503 });
      const body = await request.json().catch(() => {
        return;
      });
      const parsed = parseModelRequest(body);
      const priority = parseModelPriority(asRecord2(body)?.priority);
      if (!parsed || !priority)
        return Response.json({ error: "invalid_model_request" }, { status: 400 });
      const modelComplete = options.modelComplete;
      const encoder = new TextEncoder;
      let closed = false;
      let lastProgressMs = -Infinity;
      const stream = new ReadableStream({
        start(controller) {
          const send = (value) => {
            if (closed)
              return;
            try {
              controller.enqueue(encoder.encode(`${JSON.stringify(value)}
`));
            } catch {
              closed = true;
            }
          };
          const progress = (model) => {
            const now = Date.now();
            if (now - lastProgressMs < MODEL_PROGRESS_LINE_MS)
              return;
            lastProgressMs = now;
            send({ progress: model });
          };
          withModelProgress(progress, () => runAtLocalInferencePriority(priority, () => modelComplete({ ...parsed, signal: request.signal }))).then((completion) => send({ completion }), (error) => {
            if (error instanceof OperationError)
              return send({ operation_error: error.toJSON() });
            console.warn(`[engine-split] model completion failed: error_message=${boundedLogErrorMessage(error)} origin=${logErrorOrigin(error)}`);
            send({ error: "model_failed", message: error instanceof Error ? error.message : "unknown error" });
          }).finally(() => {
            if (closed)
              return;
            closed = true;
            try {
              controller.close();
            } catch {}
          });
        },
        cancel() {
          closed = true;
        }
      });
      return new Response(stream, { status: 200, headers: { "content-type": ENGINE_MODEL_STREAM_CONTENT_TYPE } });
    }
    if (url.pathname.startsWith(`${ENGINE_COMMANDS_PATH}/`) && request.method === "GET") {
      const id = decodeURIComponent(url.pathname.slice(ENGINE_COMMANDS_PATH.length + 1));
      if (!ID2.test(id))
        return Response.json({ error: "not_found" }, { status: 404 });
      const waitMs = Math.max(0, Math.min(maxWaitMs, Number(url.searchParams.get("wait") ?? 0) || 0));
      let timer;
      const wait = new Promise((resolve) => {
        timer = setTimer(resolve, waitMs);
      });
      try {
        const receipt = waitMs > 0 ? await options.ledger.settled(id, wait) : options.ledger.get(id);
        if (!receipt)
          return Response.json({ error: "not_found", instance_id: options.ledger.instanceId }, { status: 404 });
        return Response.json(receipt);
      } finally {
        clearTimer(timer);
      }
    }
    return Response.json({ error: "not_found" }, { status: 404 });
  };
}
var ENGINE_MODEL_STREAM_CONTENT_TYPE = "application/x-ndjson";
var MODEL_PROGRESS_LINE_MS = 1000;
var MODEL_PRIORITIES = ["owner", "background", "maintenance"];
function parseModelPriority(value) {
  if (value === undefined)
    return "owner";
  return MODEL_PRIORITIES.find((priority) => priority === value);
}
function parseModelRequest(value) {
  const record = asRecord2(value);
  if (!record)
    return;
  const { system, prompt, localOnly, maxOutputChars, responseSchema } = record;
  if (typeof system !== "string" || typeof prompt !== "string" || typeof localOnly !== "boolean")
    return;
  if (maxOutputChars !== undefined && (!Number.isSafeInteger(maxOutputChars) || maxOutputChars < 1))
    return;
  if (responseSchema !== undefined && !asRecord2(responseSchema))
    return;
  return {
    system,
    prompt,
    localOnly,
    ...maxOutputChars !== undefined ? { maxOutputChars } : {},
    ...responseSchema !== undefined ? { responseSchema } : {}
  };
}

// src/workers/engine-split/control-mirror.ts
import { createHash } from "crypto";
class EngineCommandMirror {
  options;
  entries = new Map;
  now;
  maxSettled;
  retentionMs;
  constructor(options) {
    this.options = options;
    this.now = options.now ?? (() => Date.now());
    this.maxSettled = options.maxSettled ?? 1000;
    this.retentionMs = options.retentionMs ?? 60 * 60000;
  }
  get instanceId() {
    return this.options.instanceId;
  }
  submit(envelope, clickId) {
    this.prune();
    const digest = createHash("sha256").update(JSON.stringify(envelope.command)).digest("hex");
    const existing = this.entries.get(envelope.id);
    if (existing) {
      if (existing.digest !== digest)
        throw new EngineCommandError(409, "That command id was used for a different command.");
      return this.answer(existing);
    }
    let settle;
    const settled = new Promise((resolve) => {
      settle = resolve;
    });
    const entry = {
      digest,
      envelope,
      settled,
      settle,
      privacyRaise: isDashboardPrivacyRaise(envelope.command),
      receipt: { id: envelope.id, state: "received", instance_id: this.options.instanceId }
    };
    this.entries.set(envelope.id, entry);
    if (clickId)
      logClickTrace(clickId, envelope.id, "control_receipt", "background", "served_by=control-thread");
    this.options.send(envelope);
    return this.answer(entry);
  }
  get(id) {
    const entry = this.entries.get(id);
    return entry ? this.answer(entry) : undefined;
  }
  hasPendingPrivacyRaise() {
    for (const entry of this.entries.values()) {
      if (entry.privacyRaise && entry.receipt.state === "received")
        return true;
    }
    return false;
  }
  async settled(id, wait) {
    const entry = this.entries.get(id);
    if (!entry)
      return;
    await Promise.race([entry.settled, wait]);
    return this.answer(entry);
  }
  apply(receipts, unknown = []) {
    for (const receipt of receipts) {
      const entry = this.entries.get(receipt.id);
      if (!entry || entry.settledAt !== undefined)
        continue;
      entry.receipt = { ...receipt };
      if (receipt.state === "received")
        continue;
      entry.settledAt = this.now();
      delete entry.envelope;
      entry.settle();
    }
    for (const id of unknown) {
      const entry = this.entries.get(id);
      if (entry?.envelope && entry.settledAt === undefined)
        this.options.send(entry.envelope);
    }
  }
  unsettled(limit = 500) {
    const ids = [];
    for (const [id, entry] of this.entries) {
      if (entry.settledAt !== undefined)
        continue;
      ids.push(id);
      if (ids.length >= limit)
        break;
    }
    return ids;
  }
  answer(entry) {
    if (entry.receipt.state !== "received")
      return { ...entry.receipt };
    return { ...entry.receipt, loop_held_ms: Math.max(0, Math.round(this.options.loopHeldMs?.() ?? 0)) };
  }
  prune() {
    const cutoff = this.now() - this.retentionMs;
    let settled = 0;
    for (const entry of this.entries.values())
      if (entry.settledAt !== undefined)
        settled += 1;
    for (const [id, entry] of this.entries) {
      if (entry.settledAt === undefined)
        continue;
      if (entry.settledAt >= cutoff && settled <= this.maxSettled)
        break;
      this.entries.delete(id);
      settled -= 1;
    }
  }
}

// src/workers/engine-split/snapshot.ts
var ENGINE_STATUS_SNAPSHOT_SCHEMA = "olympus.engine.background-status.v1";
function describeSnapshotFailure(error) {
  const code = error?.code;
  const runtime = error instanceof TypeError || error instanceof RangeError;
  return `${error instanceof Error ? error.name : "unknown error"}${typeof code === "string" ? ` ${code}` : ""}${runtime ? `: ${error.message.slice(0, 120)}` : ""}`;
}

// src/workers/engine-split/control-plane.ts
var CONTROL_INTS = 4;
var CONTROL_TICK = 0;
var CONTROL_BIND = 1;
var CONTROL_STOPPED = 2;
var CONTROL_MESSAGE_LENGTH = 3;
var CONTROL_MESSAGE_BYTES = 512;
var CONTROL_BIND_BOUND = 1;
var CONTROL_BIND_REFUSED = 2;
var NEVER = new Promise(() => {});

// src/workers/engine-split/control-worker.ts
var RESYNC_MS = 2000;
function start(init) {
  const ints = new Int32Array(init.shared, 0, CONTROL_INTS);
  const post = (message) => self.postMessage(message);
  let lastTick = Atomics.load(ints, CONTROL_TICK);
  let lastTickAt = performance.now();
  const sampleTick = () => {
    const tick = Atomics.load(ints, CONTROL_TICK);
    if (tick !== lastTick) {
      lastTick = tick;
      lastTickAt = performance.now();
    }
    return tick;
  };
  const loopHeldMs = () => {
    sampleTick();
    return Math.max(0, performance.now() - lastTickAt - init.tickMs);
  };
  let ready = false;
  const mirror = new EngineCommandMirror({
    instanceId: init.instanceId,
    send: (envelope) => post({ type: "submit", envelope }),
    loopHeldMs
  });
  let nextModelId = 1;
  const models = new Map;
  const modelComplete = (request) => {
    const { signal, ...body } = request;
    const id = nextModelId++;
    return new Promise((resolve, reject) => {
      const stop = () => {
        if (!models.delete(id))
          return;
        post({ type: "model_stop", id });
        reject(new DOMException("The model request was closed.", "AbortError"));
      };
      if (signal?.aborted) {
        reject(new DOMException("The model request was closed.", "AbortError"));
        return;
      }
      signal?.addEventListener("abort", stop, { once: true });
      const progress = currentModelProgress();
      models.set(id, {
        ...progress ? { progress } : {},
        resolve: (completion) => {
          signal?.removeEventListener("abort", stop);
          resolve(completion);
        },
        reject: (error) => {
          signal?.removeEventListener("abort", stop);
          reject(error);
        }
      });
      post({ type: "model", id, request: body, priority: currentLocalInferencePriority() });
    });
  };
  const handler = createEngineCommandHandler({
    authToken: init.authToken,
    ledger: mirror,
    ready: () => ready,
    ...init.model ? { modelComplete } : {}
  });
  let state;
  let stateError;
  let statusPath;
  let writing = false;
  let owed = false;
  let published;
  let failures = 0;
  let saidAt = 0;
  const EMPTY_STATE = { scheduler: null, judge: { backlog: null, pending: null, spending: null }, captures: null };
  const publish = async () => {
    const path = statusPath;
    if (!path || !state && !stateError)
      return;
    if (writing) {
      owed = true;
      return;
    }
    writing = true;
    const partial = `${path}.control.tmp`;
    try {
      const now = new Date;
      const snapshot = {
        schema: ENGINE_STATUS_SNAPSHOT_SCHEMA,
        instance_id: init.instanceId,
        heartbeat: "mtime",
        ...state ? { state_at: new Date(state.at).toISOString() } : {},
        loop_held_ms: Math.round(loopHeldMs()),
        ...stateError ? { state_error: { attempts: stateError.attempts, error: stateError.error, at: new Date(stateError.at).toISOString() } } : {},
        ...state?.body ?? EMPTY_STATE
      };
      const content = JSON.stringify(snapshot);
      if (published?.path === path && published.content === content) {
        await utimes(path, now, now);
      } else {
        await writeFile(partial, `${JSON.stringify({ ...snapshot, written_at: now.toISOString() })}
`, { mode: 384 });
        await rename(partial, path);
        published = { path, content };
      }
      if (failures > 0)
        post({ type: "log", line: `[engine-split] status snapshot written again after ${failures} failed attempt(s)` });
      failures = 0;
    } catch (error) {
      published = undefined;
      failures += 1;
      if (failures === 1 || performance.now() - saidAt >= 60000) {
        saidAt = performance.now();
        post({ type: "log", line: `[engine-split] status snapshot not written by the control thread (${failures} attempt(s) in a row): ${describeSnapshotFailure(error)}` });
      }
    } finally {
      writing = false;
      if (owed) {
        owed = false;
        publish();
      }
    }
  };
  let server;
  try {
    server = Bun.serve(workerSocketServe({ unix: init.socketPath, fetch: (request) => handler(request) }));
    chmodSync(init.socketPath, 384);
    Atomics.store(ints, CONTROL_BIND, CONTROL_BIND_BOUND);
  } catch (error) {
    const bytes = new TextEncoder().encode(error instanceof Error ? error.message : String(error)).slice(0, CONTROL_MESSAGE_BYTES);
    new Uint8Array(init.shared, CONTROL_INTS * 4).set(bytes);
    Atomics.store(ints, CONTROL_MESSAGE_LENGTH, bytes.length);
    Atomics.store(ints, CONTROL_BIND, CONTROL_BIND_REFUSED);
  }
  Atomics.notify(ints, CONTROL_BIND);
  if (!server)
    return;
  const tickTimer = setInterval(sampleTick, init.tickMs);
  const publishTimer = setInterval(() => {
    publish();
  }, init.publishMs);
  let askedAtTick = -1;
  const resyncTimer = setInterval(() => {
    const tick = sampleTick();
    if (tick === askedAtTick)
      return;
    const ids = mirror.unsettled();
    if (!ids.length)
      return;
    askedAtTick = tick;
    post({ type: "sync", ids });
  }, RESYNC_MS);
  self.onmessage = ({ data }) => {
    switch (data.type) {
      case "ready":
        ready = data.ready;
        return;
      case "receipts":
        mirror.apply(data.receipts, data.unknown);
        return;
      case "state":
        state = { at: data.at, body: data.state };
        stateError = undefined;
        statusPath = data.path;
        publish();
        return;
      case "state_failed":
        stateError = { attempts: data.attempts, error: data.error, at: data.at };
        statusPath = data.path;
        publish();
        return;
      case "model_progress":
        models.get(data.id)?.progress?.(data.model);
        return;
      case "model_result": {
        const waiting = models.get(data.id);
        if (!waiting)
          return;
        models.delete(data.id);
        if (data.completion)
          waiting.resolve(data.completion);
        else if (data.operationError)
          waiting.reject(new OperationError(data.operationError.error, data.operationError.message, data.operationError.suggestion));
        else
          waiting.reject(new Error(data.message ?? "The model call failed."));
        return;
      }
      case "stop":
        clearInterval(tickTimer);
        clearInterval(publishTimer);
        clearInterval(resyncTimer);
        server?.stop(true);
        Atomics.store(ints, CONTROL_STOPPED, 1);
        Atomics.notify(ints, CONTROL_STOPPED);
        return;
      default:
        return;
    }
  };
}
self.onmessage = ({ data }) => {
  if (data.type === "init")
    start(data);
};
