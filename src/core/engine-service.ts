/**
 * The standalone Olympus engine on macOS: one per-user LaunchAgent that runs
 * the engine host (core/engine-host.ts), which supervises the worker, the
 * remote relay client and the embedding drain the way the OpenClaw Gateway
 * does. OpenClaw is an optional host; this is the one for an install that has
 * only Olympus (docs/design/chatgpt-plugin.md, "Standalone engine").
 *
 * Everything is per-user and needs no administrator password:
 *   ~/Library/LaunchAgents/ai.olympusplugin.engine.plist   the agent
 *   ~/Library/Logs/Olympus/engine.log|engine.err           host + child output
 *   ~/.olympus/engine.json                                 host config
 *   ~/.config/olympus/worker.env                           worker environment
 *   ~/.local/share/openclaw/olympus/                       data (unchanged)
 *
 * engine.json has exactly the schema of `plugins.entries.olympus.config` in
 * openclaw.json, so the services read it with the same parser either way.
 */
import { spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, lstatSync, readdirSync, readFileSync, renameSync, statSync } from 'node:fs';
import { homedir, platform as osPlatform } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve as resolvePath } from 'node:path';
import {
  assertManagedPathParentsSync,
  ensurePrivateDirectoryTreeSync,
  ensurePrivateRootDirectorySync,
  removeFileDurablySync,
  writePrivateFileAtomicSync,
} from './atomic-file.ts';
import { engineChildrenPath, reapRecordedEngineChildren, type EngineChildReapDeps, type EngineChildReapResult } from './engine-children.ts';
import { OperationError } from './operation-error.ts';
import { olympusPackageRoot } from './package-root.ts';
import { olympusDataDir, remoteAccessDir } from './remote-access.ts';
import { loadSovereigntyPreset, writeSovereigntyConfigFile, type SovereigntyPresetName } from './sovereignty.ts';
import { workerAuthTokenFromSetupEnv } from './worker-auth.ts';
import { ensureManagedWorkerEnvironment, workerServicePaths } from './worker-service.ts';

export const ENGINE_LABEL = 'ai.olympusplugin.engine';
/** The one public relay host for standalone (ChatGPT) installs. */
export const STANDALONE_RELAY_HOST = 'mcp.olympusplugin.ai';
export const ENGINE_RUN_COMMAND = '__engine-run';
/**
 * The build launchd runs, in the agent's environment: the package version and
 * a digest of the bundled entrypoints. An upgrade keeps every path the same,
 * so without this the plist would not change and launchd would keep the old
 * host running, now supervising children from the new files.
 */
export const ENGINE_BUILD_ENV = 'OLYMPUS_ENGINE_BUILD';
const BUILD_DIGEST_FILES = ['cli.js', 'index.js', 'embedding-drain.js'] as const;
const ENGINE_THROTTLE_SECONDS = 30;
const PACKAGE_NAMES = new Set(['olympus', 'olympus-source-checkout']);

export interface EngineExecResult {
  status: number | null;
  stdout: string;
  stderr: string;
}
export type EngineExec = (command: string, args: string[]) => EngineExecResult;

export interface EnginePaths {
  label: string;
  plistPath: string;
  logDir: string;
  logPath: string;
  errorLogPath: string;
  configPath: string;
  /** The owner's privacy and model policy, seeded on first install. */
  sovereigntyPath: string;
  appSupportDir: string;
  /** Where scripts/install-macos.sh unpacks the package, and the one it replaced. */
  appDir: string;
  previousAppDir: string;
  /** The Bun the installer fetched when none was installed. */
  runtimeDir: string;
  workerEnvPath: string;
  /** The running host's status file (core/engine-host.ts). */
  statusPath: string;
  /** Process groups the host started (core/engine-children.ts). */
  childrenPath: string;
  /** Downloaded built-in models. */
  modelsDir: string;
  /** This Mac's relay registration and keys. */
  remoteAccessDir: string;
}

export function enginePaths(homeDir: string): EnginePaths {
  const home = absolute(homeDir, 'home directory');
  const logDir = join(home, 'Library', 'Logs', 'Olympus');
  const appSupportDir = join(home, 'Library', 'Application Support', 'Olympus');
  // The agent runs with HOME only (no XDG_DATA_HOME), so its data root is the default one.
  const dataEnv = { HOME: home };
  return {
    label: ENGINE_LABEL,
    plistPath: join(home, 'Library', 'LaunchAgents', `${ENGINE_LABEL}.plist`),
    logDir,
    logPath: join(logDir, 'engine.log'),
    errorLogPath: join(logDir, 'engine.err'),
    configPath: join(home, '.olympus', 'engine.json'),
    sovereigntyPath: join(home, '.olympus', 'sovereignty.json'),
    appSupportDir,
    appDir: join(appSupportDir, 'app'),
    previousAppDir: join(appSupportDir, 'app.previous'),
    runtimeDir: join(appSupportDir, 'runtime'),
    workerEnvPath: join(home, '.config', 'olympus', 'worker.env'),
    statusPath: engineStatusPath(dataEnv),
    childrenPath: engineChildrenPath(dataEnv),
    modelsDir: join(olympusDataDir(dataEnv), 'models'),
    remoteAccessDir: remoteAccessDir(dataEnv),
  };
}

export function engineStatusPath(env: Record<string, string | undefined> = process.env): string {
  return join(olympusDataDir(env), 'engine', 'status.json');
}

/** What launchd runs: an absolute Bun and the packaged CLI entrypoint. */
export interface EngineProgram {
  runtimePath: string;
  entryPath: string;
  workingDirectory: string;
  source: 'checkout' | 'package';
  /** `<version>+<digest>`; see ENGINE_BUILD_ENV. */
  build?: string;
}

/** `<package version>+<first 16 hex of a SHA-256 over the bundled entrypoints>`. */
export function engineBuildIdentity(packageRoot: string): string {
  let version = 'unknown';
  try {
    const manifest = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8')) as { version?: unknown };
    if (typeof manifest.version === 'string' && /^[0-9A-Za-z.+-]{1,64}$/.test(manifest.version)) version = manifest.version;
  } catch {
    // An unreadable manifest still gets a digest.
  }
  const hash = createHash('sha256');
  for (const name of BUILD_DIGEST_FILES) {
    try {
      const bytes = readFileSync(join(packageRoot, 'dist', name));
      hash.update(`${name}\0${bytes.length}\0`);
      hash.update(bytes);
    } catch {
      hash.update(`${name}\0absent\0`);
    }
  }
  return `${version}+${hash.digest('hex').slice(0, 16)}`;
}

export function resolveEngineProgram(options: {
  fromCheckout?: string;
  bunBin?: string;
  cwd?: string;
} = {}): EngineProgram {
  const runtimePath = resolveBun(options.bunBin);
  if (options.fromCheckout !== undefined) {
    const root = resolvePath(options.cwd ?? process.cwd(), options.fromCheckout);
    assertOlympusPackage(root, '--from-checkout');
    const entryPath = join(root, 'dist', 'cli.js');
    assertFile(entryPath, `${entryPath} is missing; run bun run build in the checkout first.`);
    return { runtimePath, entryPath, workingDirectory: root, source: 'checkout', build: engineBuildIdentity(root) };
  }
  let root: string;
  try {
    root = olympusPackageRoot();
  } catch {
    throw new OperationError('config_error', 'The installed Olympus package could not be found.', 'Pass --from-checkout <path> to install from a local checkout.');
  }
  const entryPath = join(root, 'dist', 'cli.js');
  assertFile(entryPath, `The installed Olympus package has no ${entryPath}.`);
  return { runtimePath, entryPath, workingDirectory: root, source: 'package', build: engineBuildIdentity(root) };
}

export function renderEnginePlist(input: { paths: EnginePaths; program: EngineProgram; homeDir: string }): string {
  const { paths, program } = input;
  const path = [dirname(program.runtimePath), '/usr/bin', '/bin', '/usr/sbin', '/sbin']
    .filter((entry, index, all) => all.indexOf(entry) === index)
    .join(':');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${xml(paths.label)}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xml(program.runtimePath)}</string>
    <string>--no-env-file</string>
    <string>${xml(program.entryPath)}</string>
    <string>${ENGINE_RUN_COMMAND}</string>
  </array>
  <key>WorkingDirectory</key>
  <string>${xml(program.workingDirectory)}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>HOME</key>
    <string>${xml(input.homeDir)}</string>
    <key>PATH</key>
    <string>${xml(path)}</string>
    <key>OLYMPUS_ENGINE_HOST</key>
    <string>1</string>${program.build ? `
    <key>${ENGINE_BUILD_ENV}</key>
    <string>${xml(program.build)}</string>` : ''}
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>ThrottleInterval</key>
  <integer>${ENGINE_THROTTLE_SECONDS}</integer>
  <key>StandardOutPath</key>
  <string>${xml(paths.logPath)}</string>
  <key>StandardErrorPath</key>
  <string>${xml(paths.errorLogPath)}</string>
</dict>
</plist>
`;
}

// ---------------------------------------------------------------------------
// engine.json

/** Defaults for a new standalone install: worker on, relay mode to the one public host. */
export function defaultEngineConfig(): Record<string, unknown> {
  return {
    worker: {
      service: { enabled: true },
      scheduler: { enabled: true },
    },
    email: { baseUrl: 'http://127.0.0.1:8010/v1' },
    remote: { enabled: true, relayHost: STANDALONE_RELAY_HOST },
  };
}

export function readEngineConfig(path: string): Record<string, unknown> | undefined {
  if (!existsSync(path)) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    throw new OperationError('config_error', `${path} is not valid JSON.`, 'Fix or remove it, then run olympus engine install again.');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new OperationError('config_error', `${path} must hold a JSON object.`);
  }
  return parsed as Record<string, unknown>;
}

/**
 * Write the defaults where nothing is set; never overwrite a value the owner
 * set. A `remote` block the owner wrote (even `enabled: false`) is kept whole.
 */
export function reconcileEngineConfig(path: string): { wrote: boolean; config: Record<string, unknown> } {
  const current = readEngineConfig(path);
  const defaults = defaultEngineConfig();
  if (!current) {
    writePrivateFileAtomicSync(path, `${JSON.stringify(defaults, null, 2)}\n`);
    return { wrote: true, config: defaults };
  }
  const next = structuredClone(current);
  const worker = objectAt(next, 'worker');
  const service = objectAt(worker, 'service');
  if (service.enabled === undefined) service.enabled = true;
  const scheduler = objectAt(worker, 'scheduler');
  if (scheduler.enabled === undefined) scheduler.enabled = true;
  if (next.email === undefined) next.email = defaults.email;
  if (next.remote === undefined) next.remote = defaults.remote;
  if (JSON.stringify(next) === JSON.stringify(current)) return { wrote: false, config: current };
  writePrivateFileAtomicSync(path, `${JSON.stringify(next, null, 2)}\n`);
  return { wrote: true, config: next };
}

// ---------------------------------------------------------------------------
// launchctl

export interface EngineServiceOptions {
  homeDir?: string;
  exec?: EngineExec;
  uid?: number;
  /** Test seam; the engine is macOS-only. */
  platform?: string;
}

export interface EngineInstallOptions extends EngineServiceOptions {
  fromCheckout?: string;
  bunBin?: string;
  cwd?: string;
  dryRun?: boolean;
  /** Restart a loaded engine even when nothing changed (the installer passes it after an upgrade). */
  restart?: boolean;
  /** Where to look for an OpenClaw config; defaults to process.env. */
  env?: Record<string, string | undefined>;
}

export interface EngineSovereigntyPlan {
  /** `seeded`: the preset was written. `present`: a policy file exists. `skipped`: another host's policy is in place. */
  action: 'seeded' | 'present' | 'skipped' | 'would_seed';
  path: string;
  preset?: SovereigntyPresetName;
  reason?: string;
}

export interface EngineInstallResult {
  ok: true;
  label: string;
  plist_path: string;
  config_path: string;
  worker_env_path: string;
  log_path: string;
  error_log_path: string;
  program: EngineProgram;
  wrote_plist: boolean;
  wrote_config: boolean;
  wrote_worker_env: boolean;
  /** The preset seeded into a missing sovereignty.json; absent when one existed or seeding was skipped. */
  seeded_sovereignty?: SovereigntyPresetName;
  sovereignty: EngineSovereigntyPlan;
  /**
   * `bootstrapped` (was not loaded), `reloaded` (plist changed), `restarted`
   * (same plist, but the running host is another build or a restart was
   * asked for), `unchanged`, or `dry_run`.
   */
  action: 'bootstrapped' | 'reloaded' | 'restarted' | 'unchanged' | 'dry_run';
  warnings: string[];
  plist: string;
}

export function installEngine(options: EngineInstallOptions = {}): EngineInstallResult {
  assertDarwin(options.platform);
  const homeDir = absolute(options.homeDir ?? homedir(), 'home directory');
  const paths = enginePaths(homeDir);
  const program = resolveEngineProgram({
    ...(options.fromCheckout !== undefined ? { fromCheckout: options.fromCheckout } : {}),
    ...(options.bunBin ? { bunBin: options.bunBin } : {}),
    ...(options.cwd ? { cwd: options.cwd } : {}),
  });
  const plist = renderEnginePlist({ paths, program, homeDir });
  const warnings = engineConflictWarnings(homeDir);
  const sovereigntyBlocker = existsSync(paths.sovereigntyPath)
    ? undefined
    : engineSovereigntySeedBlocker({ homeDir, workerEnvPath: paths.workerEnvPath, env: options.env ?? process.env });
  const base = {
    ok: true as const,
    label: paths.label,
    plist_path: paths.plistPath,
    config_path: paths.configPath,
    worker_env_path: paths.workerEnvPath,
    log_path: paths.logPath,
    error_log_path: paths.errorLogPath,
    program,
    warnings,
    plist,
  };
  if (options.dryRun) {
    return {
      ...base,
      wrote_plist: false,
      wrote_config: false,
      wrote_worker_env: false,
      sovereignty: existsSync(paths.sovereigntyPath)
        ? { action: 'present', path: paths.sovereigntyPath }
        : sovereigntyBlocker
          ? { action: 'skipped', path: paths.sovereigntyPath, reason: sovereigntyBlocker }
          : { action: 'would_seed', path: paths.sovereigntyPath, preset: STANDALONE_SOVEREIGNTY_PRESET },
      action: 'dry_run',
    };
  }

  // Every path is checked before the first write, so an unusable layout
  // (a symlinked ~/.config, a directory where the plist goes) fails with
  // nothing half-written.
  preflightEnginePaths(homeDir, paths);
  ensurePrivateRootDirectorySync(homeDir);
  ensurePrivateDirectoryTreeSync(homeDir, dirname(paths.plistPath));
  ensurePrivateDirectoryTreeSync(homeDir, paths.logDir);
  ensurePrivateDirectoryTreeSync(homeDir, dirname(paths.configPath));
  const config = reconcileEngineConfig(paths.configPath);
  let sovereignty: EngineSovereigntyPlan;
  if (sovereigntyBlocker) {
    sovereignty = { action: 'skipped', path: paths.sovereigntyPath, reason: sovereigntyBlocker };
    warnings.push(`${paths.sovereigntyPath} was not created: ${sovereigntyBlocker} The engine's worker uses that policy too; run olympus sovereignty init --preset ${STANDALONE_SOVEREIGNTY_PRESET} to choose this install's policy explicitly.`);
  } else {
    const seeded = seedEngineSovereignty(paths.sovereigntyPath);
    sovereignty = seeded
      ? { action: 'seeded', path: paths.sovereigntyPath, preset: seeded }
      : { action: 'present', path: paths.sovereigntyPath };
  }
  const workerEnv = ensureManagedWorkerEnvironment({
    homeDir,
    envPath: paths.workerEnvPath,
    bunBin: program.runtimePath,
    schedulerEnabled: true,
    authToken: workerAuthTokenFromSetupEnv({ homeDir }) ?? randomBytes(32).toString('base64url'),
  });
  const wrotePlist = writeIfChanged(paths.plistPath, plist);

  const exec = options.exec ?? defaultExec;
  const target = serviceTarget(options.uid);
  const loaded = launchctlLoaded(exec, target);
  let action: EngineInstallResult['action'] = 'unchanged';
  if (loaded && wrotePlist) {
    mustSucceed(exec('launchctl', ['bootout', target]), 'unload the previous engine agent');
    action = 'reloaded';
  } else if (!loaded) {
    action = 'bootstrapped';
  } else if (options.restart || runningBuildDiffers(paths.statusPath, program.build)) {
    // Same plist, but the host launchd is running is another build (or the
    // caller just swapped the package): restart it in place.
    mustSucceed(exec('launchctl', ['kickstart', '-k', target]), 'restart the engine agent');
    action = 'restarted';
  }
  if (action === 'bootstrapped' || action === 'reloaded') {
    // A label an owner once disabled refuses bootstrap; enabling is idempotent.
    exec('launchctl', ['enable', target]);
    bootstrapAgent(exec, target, guiDomain(options.uid), paths.plistPath, action === 'reloaded');
  }
  return {
    ...base,
    wrote_plist: wrotePlist,
    wrote_config: config.wrote,
    wrote_worker_env: workerEnv.wrote,
    ...(sovereignty.action === 'seeded' && sovereignty.preset ? { seeded_sovereignty: sovereignty.preset } : {}),
    sovereignty,
    action,
  };
}

// ---------------------------------------------------------------------------
// Health proof: an install or rollback is done when the new build is serving

/** Default bound on waiting for the engine to prove the new build healthy. */
export const ENGINE_HEALTH_TIMEOUT_MS = 60_000;
const ENGINE_HEALTH_POLL_MS = 500;
const WORKER_SERVICE_ID = 'olympus-worker';
const DEFAULT_WORKER_BASE_URL = 'http://127.0.0.1:8010/v1';

export interface EngineHealthDeps {
  /** Longest wait for proof (default 60 s). */
  timeoutMs?: number;
  pollMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** Whether the host pid in the status file is alive; defaults to signal 0. */
  pidAlive?: (pid: number) => boolean;
  fetchImpl?: typeof fetch;
}

export interface EngineHealthProof {
  ok: boolean;
  /** The build the engine was expected to run, and the one its status file reports. */
  expected_build: string | null;
  running_build: string | null;
  pid: number | null;
  /** `ok`: the worker service is ready and /health answered; `off`: the config turns the worker off. */
  worker: 'ok' | 'off' | 'not_ready';
  waited_ms: number;
  /** Why there is no proof yet (the last check that failed), when ok is false. */
  reason?: string;
}

/**
 * Waits, bounded, for fresh proof that the engine runs `expectedBuild`: its
 * status file (written by the host launchd started) reports that build, is
 * running, was started at or after `since` when given (so a status file from
 * before the restart proves nothing), names a live pid, and reports the
 * worker service ready; and the worker answers GET <baseUrl>/health.
 */
export async function waitForEngineHealthy(
  input: { paths: EnginePaths; expectedBuild: string | null; since?: number },
  deps: EngineHealthDeps = {},
): Promise<EngineHealthProof> {
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const timeoutMs = deps.timeoutMs ?? ENGINE_HEALTH_TIMEOUT_MS;
  const pidAlive = deps.pidAlive ?? defaultPidAlive;
  const fetchImpl = deps.fetchImpl ?? fetch;
  const started = now();
  let last: EngineHealthProof = {
    ok: false,
    expected_build: input.expectedBuild,
    running_build: null,
    pid: null,
    worker: 'not_ready',
    waited_ms: 0,
    reason: 'the engine has not written its status yet',
  };
  for (;;) {
    last = { ...(await checkEngineHealthOnce(input, pidAlive, fetchImpl)), waited_ms: now() - started };
    if (last.ok || now() - started >= timeoutMs) return last;
    await sleep(Math.min(deps.pollMs ?? ENGINE_HEALTH_POLL_MS, Math.max(0, timeoutMs - (now() - started))));
  }
}

async function checkEngineHealthOnce(
  input: { paths: EnginePaths; expectedBuild: string | null; since?: number },
  pidAlive: (pid: number) => boolean,
  fetchImpl: typeof fetch,
): Promise<Omit<EngineHealthProof, 'waited_ms'>> {
  const base = { ok: false as const, expected_build: input.expectedBuild, running_build: null, pid: null, worker: 'not_ready' as const };
  let status: { schema?: unknown; state?: unknown; build?: unknown; pid?: unknown; started_at?: unknown; services?: Record<string, { state?: unknown; message?: unknown }> };
  try {
    status = JSON.parse(readFileSync(input.paths.statusPath, 'utf8'));
  } catch {
    return { ...base, reason: 'the engine has not written its status yet' };
  }
  const runningBuild = typeof status.build === 'string' ? status.build : null;
  const pid = typeof status.pid === 'number' && Number.isSafeInteger(status.pid) && status.pid > 0 ? status.pid : null;
  const seen = { ...base, running_build: runningBuild, pid };
  if (status?.schema !== 'olympus.engine.status.v1') return { ...seen, reason: 'the engine status file is not one this version reads' };
  if (input.since !== undefined) {
    const startedAt = typeof status.started_at === 'string' ? Date.parse(status.started_at) : Number.NaN;
    if (!Number.isFinite(startedAt) || startedAt < input.since) return { ...seen, reason: 'the engine has not restarted yet' };
  }
  if (status.state !== 'running') return { ...seen, reason: `the engine is ${typeof status.state === 'string' ? status.state : 'not running'}` };
  if (input.expectedBuild !== null && runningBuild !== input.expectedBuild) {
    return { ...seen, reason: `the engine runs build ${runningBuild ?? 'unknown'}, not ${input.expectedBuild}` };
  }
  if (pid === null || !pidAlive(pid)) return { ...seen, reason: 'the engine process named in its status is not running' };
  const worker = status.services?.[WORKER_SERVICE_ID];
  if (worker?.state === 'off') return { ...seen, ok: true, worker: 'off' };
  if (worker?.state !== 'ok') {
    const message = typeof worker?.message === 'string' && worker.message ? `: ${worker.message.slice(0, 200)}` : '';
    return { ...seen, reason: `the worker is not ready yet${message}` };
  }
  const baseUrl = engineWorkerBaseUrl(input.paths);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 2_000);
  try {
    const response = await fetchImpl(`${baseUrl.replace(/\/$/, '')}/health`, { method: 'GET', signal: controller.signal });
    await response.body?.cancel().catch(() => undefined);
    if (!response.ok) return { ...seen, reason: `the worker /health answered HTTP ${response.status}` };
  } catch {
    return { ...seen, reason: 'the worker /health did not answer' };
  } finally {
    clearTimeout(timer);
  }
  return { ...seen, ok: true, worker: 'ok' };
}

/** The worker's loopback API base from engine.json (`email.baseUrl`), or the default. */
export function engineWorkerBaseUrl(paths: EnginePaths): string {
  try {
    const value = (readEngineConfig(paths.configPath)?.email as { baseUrl?: unknown } | undefined)?.baseUrl;
    if (typeof value === 'string') {
      const url = new URL(value);
      if (url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) return value;
    }
  } catch {
    // The default below.
  }
  return DEFAULT_WORKER_BASE_URL;
}

function defaultPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** What `olympus engine install` reports: the launchd outcome, and whether the build proved healthy. */
export type EngineVerifiedInstallResult = Omit<EngineInstallResult, 'ok'> & {
  ok: boolean;
  /** Absent for a dry run. */
  health?: EngineHealthProof;
  reason?: string;
};

/**
 * Install (or upgrade) and load the agent, then wait for proof that the
 * engine runs this build and its worker is healthy. `ok` is false, with the
 * reason, when that proof does not arrive in time: launchd accepting the
 * agent is not success.
 */
export async function installEngineVerified(options: EngineInstallOptions & { health?: EngineHealthDeps } = {}): Promise<EngineVerifiedInstallResult> {
  const now = options.health?.now ?? Date.now;
  const since = now();
  const result = installEngine(options);
  if (result.action === 'dry_run') return result;
  const health = await waitForEngineHealthy({
    paths: enginePaths(absolute(options.homeDir ?? homedir(), 'home directory')),
    expectedBuild: result.program.build ?? null,
    // Nothing was restarted for an unchanged agent: the running host is the proof.
    ...(result.action === 'unchanged' ? {} : { since }),
  }, options.health);
  return health.ok
    ? { ...result, ok: true, health }
    : { ...result, ok: false, health, reason: `The engine did not prove build ${result.program.build ?? 'unknown'} healthy within ${Math.round(health.waited_ms / 1000)} s: ${health.reason}.` };
}

/** The build the installed agent's plist names (OLYMPUS_ENGINE_BUILD), or null. */
export function installedEngineBuild(plistPath: string): string | null {
  try {
    const text = readFileSync(plistPath, 'utf8');
    const match = new RegExp(`<key>${ENGINE_BUILD_ENV}</key>\\s*<string>([^<]*)</string>`).exec(text);
    return match ? unxml(match[1]!) : null;
  } catch {
    return null;
  }
}

/**
 * `olympus engine verify`: wait for proof that the engine runs the expected
 * build, and that the installed agent names it. The expected build is given
 * explicitly (`expectedBuild`, or `expectPackage`: the build of the package
 * in that folder); without either it is the build of the package this command
 * runs from. It is never taken from the installed agent: an upgrade cut short
 * after the new files went in leaves the agent naming, and launchd running,
 * the old build, and that must not pass as the new one. The installer passes
 * the verified download, and uses it to check a restored previous version,
 * whose own CLI may predate health checks.
 */
export async function verifyEngine(
  options: EngineServiceOptions & { health?: EngineHealthDeps; expectedBuild?: string; expectPackage?: string } = {},
): Promise<{ ok: boolean; expected_build: string; installed_build: string | null; health?: EngineHealthProof; reason?: string }> {
  assertDarwin(options.platform);
  const paths = enginePaths(absolute(options.homeDir ?? homedir(), 'home directory'));
  if (!existsSync(paths.plistPath)) {
    throw new OperationError('config_error', 'The engine is not installed.', 'Run olympus engine install.');
  }
  const expectedBuild = expectedEngineBuild(options);
  const installedBuild = installedEngineBuild(paths.plistPath);
  if (installedBuild !== expectedBuild) {
    return {
      ok: false,
      expected_build: expectedBuild,
      installed_build: installedBuild,
      reason: `The installed engine agent runs build ${installedBuild ?? 'unknown'}, not ${expectedBuild}: run olympus engine install --restart.`,
    };
  }
  const health = await waitForEngineHealthy({ paths, expectedBuild }, options.health);
  return health.ok
    ? { ok: true, expected_build: expectedBuild, installed_build: installedBuild, health }
    : { ok: false, expected_build: expectedBuild, installed_build: installedBuild, health, reason: `The engine is not healthy: ${health.reason}.` };
}

function expectedEngineBuild(options: { expectedBuild?: string; expectPackage?: string }): string {
  if (options.expectedBuild !== undefined && options.expectPackage !== undefined) {
    throw new OperationError('invalid_params', 'Pass --expect-build or --expect-package, not both.');
  }
  if (options.expectedBuild !== undefined) {
    if (!/^[0-9A-Za-z.+-]{1,96}$/.test(options.expectedBuild)) throw new OperationError('invalid_params', `--expect-build ${JSON.stringify(options.expectedBuild)} is not a build identity.`);
    return options.expectedBuild;
  }
  let root: string;
  if (options.expectPackage !== undefined) {
    root = resolvePath(options.expectPackage);
  } else {
    try {
      root = olympusPackageRoot();
    } catch {
      throw new OperationError('config_error', 'The Olympus package this command runs from could not be found.', 'Pass --expect-package <folder> or --expect-build <build>.');
    }
  }
  assertOlympusPackage(root, '--expect-package');
  assertFile(join(root, 'dist', 'cli.js'), `${root} has no dist/cli.js, so it is not a runnable Olympus package.`);
  return engineBuildIdentity(root);
}

/**
 * Refuse, before anything is written, a layout the install would refuse
 * halfway: a symlink or file in a managed directory chain, or a non-regular
 * file where a managed file goes. Symlinked directories are refused rather
 * than followed: these files hold the worker's bearer token and the owner's
 * policy, and the custody rules that guard them are shared with the worker
 * installer.
 */
export function preflightEnginePaths(homeDir: string, paths: EnginePaths = enginePaths(homeDir), ownerUid: number | undefined = process.getuid?.()): void {
  // The folders scripts/install-macos.sh manages, which hold the Bun and the
  // package launchd runs: real folders owned by this user, or absent.
  const installed: Array<[string, string]> = [
    [paths.appSupportDir, 'Olympus application'],
    [paths.appDir, 'Olympus application'],
    [`${paths.appDir}.next`, 'Olympus application'],
    [paths.previousAppDir, 'Olympus application'],
    [paths.runtimeDir, 'Olympus runtime'],
  ];
  for (const [dir, label] of installed) {
    let problem: string | undefined;
    try {
      assertManagedPathParentsSync(homeDir, dir, label);
      const stat = existsSync(dir) || isSymlink(dir) ? lstatSync(dir) : undefined;
      if (stat && (stat.isSymbolicLink() || !stat.isDirectory())) problem = `${dir} is not a real folder (a symbolic link or a file).`;
      else if (stat && ownerUid !== undefined && stat.uid !== ownerUid) problem = `${dir} belongs to another user.`;
    } catch (error) {
      problem = error instanceof Error ? error.message : String(error);
    }
    if (problem) {
      throw new OperationError(
        'config_error',
        `Olympus cannot install here: ${problem}`,
        `Olympus runs only from real folders that belong to you. Move ${dir} aside, then run the Olympus installer again. Nothing was changed.`,
      );
    }
  }
  const managed: Array<[string, string]> = [
    [paths.plistPath, 'LaunchAgent'],
    [paths.logPath, 'engine log'],
    [paths.configPath, 'engine config'],
    [paths.sovereigntyPath, 'privacy policy'],
    [paths.workerEnvPath, 'worker environment'],
  ];
  for (const [path, label] of managed) {
    try {
      assertManagedPathParentsSync(homeDir, path, label);
    } catch (error) {
      throw new OperationError(
        'config_error',
        `Olympus cannot install here: ${error instanceof Error ? error.message : String(error)}`,
        `Olympus keeps ${label} files in real directories it can lock down. Replace the symbolic link or file at that path with a directory (or remove it), then run olympus engine install again. Nothing was changed.`,
      );
    }
    if (!existsSync(path)) continue;
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new OperationError(
        'config_error',
        `Olympus cannot install here: ${path} is not a regular file.`,
        'Remove it by hand, then run olympus engine install again. Nothing was changed.',
      );
    }
  }
}

function runningBuildDiffers(statusPath: string, build: string | undefined): boolean {
  if (!build) return false;
  try {
    const status = JSON.parse(readFileSync(statusPath, 'utf8')) as { schema?: unknown; state?: unknown; build?: unknown };
    if (status?.schema !== 'olympus.engine.status.v1' || status.state !== 'running') return false;
    // A host from before build identities wrote none: it is another build.
    return status.build !== build;
  } catch {
    return false;
  }
}

/**
 * The policy a new standalone install starts with: the shipped preset that
 * needs nothing from the owner. Every tier embeds with the built-in model
 * (downloaded on first use, no key), Private items stay metadata-only and
 * unanswerable, and no answer model is required: ChatGPT answers from
 * olympus_search. An existing sovereignty.json is never touched.
 */
export const STANDALONE_SOVEREIGNTY_PRESET: SovereigntyPresetName = 'no-sensitive';

export function seedEngineSovereignty(path: string): SovereigntyPresetName | undefined {
  if (existsSync(path)) return undefined;
  writeSovereigntyConfigFile({ config: loadSovereigntyPreset(STANDALONE_SOVEREIGNTY_PRESET), path });
  return STANDALONE_SOVEREIGNTY_PRESET;
}

/**
 * Environment names the env-bridge policy (sovereignty.ts
 * buildEnvBridgeSovereigntyConfig) or an explicit policy path reads. A worker
 * environment that sets any of them already has a policy without
 * sovereignty.json, and a seeded file would silently replace it.
 */
const ENV_POLICY_KEY = /^\s*(?:export\s+)?(OLYMPUS_SOVEREIGNTY_CONFIG(?:_PATH)?|OLYMPUS_ARGUS_[A-Z_]+|OLYMPUS_SOURCE_INDEX_(?:CLOUD_ANALYST|VENICE|GEMINI|EMBEDDING)_[A-Z_]+|VENICE_API_KEY|API_KEY_VENICE|Venice-API-Key|GEMINI_API_KEY)=/m;

/**
 * Why seeding sovereignty.json would change a policy someone already has, or
 * undefined when nothing else hosts Olympus here. sovereignty.json is read by
 * every worker on this Mac, including one an OpenClaw Gateway or the legacy
 * worker LaunchAgent runs, so it is only seeded on a Mac where the engine is
 * the only host and no environment policy exists.
 */
export function engineSovereigntySeedBlocker(input: {
  homeDir: string;
  workerEnvPath: string;
  env?: Record<string, string | undefined>;
}): string | undefined {
  try {
    if (existsSync(input.workerEnvPath)) {
      const key = ENV_POLICY_KEY.exec(readFileSync(input.workerEnvPath, 'utf8'))?.[1];
      if (key) return `${input.workerEnvPath} already sets ${key}, which chooses this worker's models and privacy routes.`;
    }
  } catch {
    return `${input.workerEnvPath} could not be read to check for an existing policy.`;
  }
  const legacy = workerServicePaths('darwin', input.homeDir).unitPath;
  if (existsSync(legacy)) return `the worker LaunchAgent from olympus worker install (${legacy}) already runs Olympus with its own environment.`;
  const openclawConfig = openClawConfigPath(input.homeDir, input.env ?? process.env);
  if (existsSync(openclawConfig)) {
    let text: string;
    try {
      text = readFileSync(openclawConfig, 'utf8');
    } catch {
      return `${openclawConfig} could not be read to check for an OpenClaw-hosted Olympus.`;
    }
    if (openClawConfigHasOlympus(text)) return `OpenClaw is configured to run Olympus (${openclawConfig}).`;
  }
  return undefined;
}

function openClawConfigPath(homeDir: string, env: Record<string, string | undefined>): string {
  const explicit = env.OPENCLAW_CONFIG_PATH?.trim();
  if (explicit && isAbsolute(explicit)) return explicit;
  const stateDir = env.OPENCLAW_STATE_DIR?.trim();
  return join(stateDir && isAbsolute(stateDir) ? stateDir : join(homeDir, '.openclaw'), 'openclaw.json');
}

function openClawConfigHasOlympus(text: string): boolean {
  try {
    const parsed = JSON.parse(text) as { plugins?: { entries?: Record<string, unknown> } };
    return Boolean(parsed?.plugins?.entries && Object.hasOwn(parsed.plugins.entries, 'olympus'));
  } catch {
    // openclaw.json may be JSON5; when it cannot be parsed, any mention of an
    // olympus key counts as an Olympus entry (skipping the seed is the safe side).
    return /["']?\bolympus\b["']?\s*:/.test(text);
  }
}

export interface EngineKeptItem {
  path: string;
  what: string;
  /** Size on disk, for the large ones. */
  bytes?: number;
}

export interface EngineUninstallResult {
  ok: true;
  plist_path: string;
  unloaded: boolean;
  removed_plist: boolean;
  /** Child process groups a dead host had left running, stopped now. */
  stopped_leftover_processes: number;
  kept: EngineKeptItem[];
  next: string;
}

/**
 * Unload and remove the agent. Everything else stays, and `kept` says what and
 * where: config, policy, worker environment, logs, the app and runtime the
 * installer unpacked, downloaded models, and this Mac's relay registration.
 * `olympus data delete --all` removes data.
 */
export function uninstallEngine(options: EngineServiceOptions & { reap?: EngineChildReapDeps } = {}): EngineUninstallResult {
  assertDarwin(options.platform);
  const homeDir = absolute(options.homeDir ?? homedir(), 'home directory');
  const paths = enginePaths(homeDir);
  const exec = options.exec ?? defaultExec;
  const target = serviceTarget(options.uid);
  const loaded = launchctlLoaded(exec, target);
  if (loaded) mustSucceed(exec('launchctl', ['bootout', target]), 'unload the engine agent');
  let removed = false;
  if (existsSync(paths.plistPath)) {
    const stat = lstatSync(paths.plistPath);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new OperationError('config_error', `${paths.plistPath} is not a regular file; remove it by hand.`);
    }
    removed = removeFileDurablySync(paths.plistPath);
  }
  const reaped = reapRecordedEngineChildren(paths.childrenPath, options.reap);
  return {
    ok: true,
    plist_path: paths.plistPath,
    unloaded: loaded,
    removed_plist: removed,
    stopped_leftover_processes: reaped.stopped.length,
    kept: engineKeptItems(paths),
    next: 'To remove Olympus data too (indexes, models, relay keys), run olympus data delete --all. Remove the app and runtime folders by hand if you want them gone.',
  };
}

function engineKeptItems(paths: EnginePaths): EngineKeptItem[] {
  const candidates: EngineKeptItem[] = [
    { path: paths.configPath, what: 'engine settings' },
    { path: paths.sovereigntyPath, what: 'privacy policy (sovereignty.json)' },
    { path: paths.workerEnvPath, what: 'worker environment, including its access token' },
    { path: paths.logDir, what: 'engine logs' },
    { path: paths.appDir, what: 'the Olympus app the installer unpacked' },
    { path: paths.previousAppDir, what: 'the previous Olympus app (rollback copy)' },
    { path: paths.runtimeDir, what: 'the Bun runtime the installer downloaded' },
    { path: paths.modelsDir, what: 'downloaded built-in models', bytes: directoryBytes(paths.modelsDir) },
    { path: paths.remoteAccessDir, what: "this Mac's relay registration and keys; ChatGPT stays linked until you disconnect it or delete this data" },
  ];
  return candidates.filter((item) => existsSync(item.path));
}

/** Bytes under `path` (no symlinks followed); bounded so a huge tree cannot stall uninstall. */
function directoryBytes(path: string, budget = { entries: 20_000 }): number {
  let total = 0;
  let entries: string[];
  try {
    entries = readdirSync(path);
  } catch {
    return 0;
  }
  for (const name of entries) {
    if (--budget.entries < 0) break;
    const child = join(path, name);
    try {
      const stat = lstatSync(child);
      if (stat.isDirectory()) total += directoryBytes(child, budget);
      else if (stat.isFile()) total += stat.size;
    } catch {
      // Skip what disappears or cannot be read.
    }
  }
  return total;
}

export interface EngineStopResult {
  ok: true;
  stopped: boolean;
  /** Child process groups a dead host had left running, stopped now. */
  stopped_leftover_processes: number;
  next: string;
}

/**
 * Stop the engine and keep it stopped: unload it from launchd (bootout) and
 * disable the label so the next login does not start it either. The plist,
 * config and data stay. `olympus engine start` (or `olympus engine install`)
 * enables and loads it again.
 */
export function stopEngine(options: EngineServiceOptions & { reap?: EngineChildReapDeps } = {}): EngineStopResult {
  assertDarwin(options.platform);
  const homeDir = absolute(options.homeDir ?? homedir(), 'home directory');
  const paths = enginePaths(homeDir);
  const exec = options.exec ?? defaultExec;
  const target = serviceTarget(options.uid);
  const loaded = launchctlLoaded(exec, target);
  if (loaded) mustSucceed(exec('launchctl', ['bootout', target]), 'stop the engine agent');
  mustSucceed(exec('launchctl', ['disable', target]), 'keep the engine agent from starting at login');
  const reaped: EngineChildReapResult = reapRecordedEngineChildren(paths.childrenPath, options.reap);
  return {
    ok: true,
    stopped: loaded,
    stopped_leftover_processes: reaped.stopped.length,
    next: 'Olympus stays stopped, also after a restart of the Mac, until you run olympus engine start.',
  };
}

/** Enable and load an installed engine that `olympus engine stop` stopped. */
export function startEngine(options: EngineServiceOptions = {}): { ok: true; action: 'started' | 'already_running' } {
  assertDarwin(options.platform);
  const homeDir = absolute(options.homeDir ?? homedir(), 'home directory');
  const paths = enginePaths(homeDir);
  if (!existsSync(paths.plistPath)) {
    throw new OperationError('config_error', 'The engine is not installed.', 'Run olympus engine install.');
  }
  const exec = options.exec ?? defaultExec;
  const target = serviceTarget(options.uid);
  mustSucceed(exec('launchctl', ['enable', target]), 'enable the engine agent');
  if (launchctlLoaded(exec, target)) return { ok: true, action: 'already_running' };
  bootstrapAgent(exec, target, guiDomain(options.uid), paths.plistPath, false);
  return { ok: true, action: 'started' };
}

export interface EngineRollbackResult {
  /** True only when the swapped-in build proved healthy. */
  ok: boolean;
  /** The build now installed in app/, and the one kept as app.previous (rolling back again returns to it). */
  running_build: string;
  previous_build: string;
  app_dir: string;
  previous_app_dir: string;
  action: EngineInstallResult['action'];
  health: EngineHealthProof;
  /** Why the rollback failed, when ok is false. */
  reason?: string;
  /**
   * When the rolled-back-to build failed: the version that was running was
   * put back, and whether it proved healthy again.
   */
  restored?: { ok: boolean; build: string; reason?: string };
}

/**
 * Swap the installed app with the one the last upgrade replaced
 * (app.previous), then reload the agent so launchd runs it, and wait for
 * proof that it is healthy. Running it again swaps back. Only for an engine
 * scripts/install-macos.sh installed: the agent must run app/dist/cli.js. A
 * checkout install has no previous copy to return to; reinstall from the
 * checkout you want instead.
 *
 * If the previous build cannot be loaded or does not prove healthy, the
 * version that was running is put back and verified too; a failure of that
 * recovery is reported, never swallowed.
 */
export async function rollbackEngine(options: EngineServiceOptions & { bunBin?: string; health?: EngineHealthDeps } = {}): Promise<EngineRollbackResult> {
  assertDarwin(options.platform);
  const homeDir = absolute(options.homeDir ?? homedir(), 'home directory');
  const paths = enginePaths(homeDir);
  const installed = installedProgram(paths.plistPath);
  const appEntry = join(paths.appDir, 'dist', 'cli.js');
  if (!installed) {
    throw new OperationError('config_error', 'The engine is not installed, so there is nothing to roll back.', 'Run the Olympus installer.');
  }
  if (installed.entryPath !== appEntry) {
    throw new OperationError(
      'config_error',
      `This engine runs ${installed.entryPath}, not the installed app, so it has no previous version to return to.`,
      'Reinstall from the checkout or package you want with olympus engine install.',
    );
  }
  preflightEnginePaths(homeDir, paths);
  assertOlympusPackage(paths.previousAppDir, 'The previous app');
  assertFile(join(paths.previousAppDir, 'dist', 'cli.js'), `${paths.previousAppDir} has no dist/cli.js, so it cannot run.`);
  const bunBin = options.bunBin ?? installed.runtimePath;

  swapAppDirectories(paths);
  const reinstall = (): Promise<EngineVerifiedInstallResult> => installEngineVerified({
    ...(options.homeDir ? { homeDir: options.homeDir } : {}),
    ...(options.exec ? { exec: options.exec } : {}),
    ...(options.uid !== undefined ? { uid: options.uid } : {}),
    ...(options.platform ? { platform: options.platform } : {}),
    ...(options.health ? { health: options.health } : {}),
    fromCheckout: paths.appDir,
    bunBin,
    restart: true,
  });
  /** Put the version that was running back, and prove it healthy again. */
  const restore = async (): Promise<{ ok: boolean; build: string; reason?: string }> => {
    swapAppDirectories(paths);
    const build = engineBuildIdentity(paths.appDir);
    try {
      const back = await reinstall();
      return back.ok ? { ok: true, build } : { ok: false, build, reason: back.reason ?? 'it did not prove healthy' };
    } catch (error) {
      return { ok: false, build, reason: error instanceof Error ? error.message : String(error) };
    }
  };
  let result: EngineVerifiedInstallResult;
  try {
    result = await reinstall();
  } catch (error) {
    const restored = await restore();
    if (restored.ok) throw error;
    const message = error instanceof Error ? error.message : String(error);
    throw new OperationError(
      'config_error',
      `${message} Putting back build ${restored.build} failed too: ${restored.reason}`,
      'Run olympus engine logs, then the Olympus installer again.',
    );
  }
  if (result.ok) {
    return {
      ok: true,
      running_build: result.program.build ?? engineBuildIdentity(paths.appDir),
      previous_build: engineBuildIdentity(paths.previousAppDir),
      app_dir: paths.appDir,
      previous_app_dir: paths.previousAppDir,
      action: result.action,
      health: result.health!,
    };
  }
  const failedBuild = result.program.build ?? 'unknown';
  const restored = await restore();
  return {
    ok: false,
    running_build: engineBuildIdentity(paths.appDir),
    previous_build: engineBuildIdentity(paths.previousAppDir),
    app_dir: paths.appDir,
    previous_app_dir: paths.previousAppDir,
    action: result.action,
    health: result.health!,
    reason: restored.ok
      ? `Rolling back to build ${failedBuild} failed (${result.reason}); build ${restored.build} was put back and is healthy.`
      : `Rolling back to build ${failedBuild} failed (${result.reason}); putting back build ${restored.build} failed too: ${restored.reason}`,
    restored,
  };
}

/**
 * Exchange app/ and app.previous/ with three renames, undone in reverse if
 * one fails, so app/ is never missing for longer than one rename and never lost.
 */
function swapAppDirectories(paths: EnginePaths): void {
  const parking = `${paths.appDir}.rollback-${process.pid}-${randomBytes(4).toString('hex')}`;
  renameSync(paths.appDir, parking);
  try {
    renameSync(paths.previousAppDir, paths.appDir);
  } catch (error) {
    renameSync(parking, paths.appDir);
    throw error;
  }
  try {
    renameSync(parking, paths.previousAppDir);
  } catch (error) {
    renameSync(paths.appDir, paths.previousAppDir);
    renameSync(parking, paths.appDir);
    throw error;
  }
}

/** The runtime and entrypoint the installed plist runs, or undefined when there is none. */
export function installedProgram(plistPath: string): { runtimePath: string; entryPath: string } | undefined {
  let text: string;
  try {
    const stat = lstatSync(plistPath);
    if (!stat.isFile() || stat.isSymbolicLink()) return undefined;
    text = readFileSync(plistPath, 'utf8');
  } catch {
    return undefined;
  }
  const block = /<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/.exec(text)?.[1];
  if (!block) return undefined;
  const strings = [...block.matchAll(/<string>([\s\S]*?)<\/string>/g)].map((match) => unxml(match[1]!));
  const runtimePath = strings[0];
  const entryPath = strings.find((value, index) => index > 0 && !value.startsWith('--'));
  if (!runtimePath || !entryPath) return undefined;
  return { runtimePath, entryPath };
}

export type EngineAgentState = 'running' | 'loaded' | 'not_loaded' | 'unknown';

export interface EngineInspection {
  label: string;
  installed: boolean;
  plist_path: string;
  state: EngineAgentState;
  pid: number | null;
  last_exit_code: number | null;
  config_path: string;
  config_present: boolean;
  log_path: string;
  error_log_path: string;
  detail: string;
}

export function inspectEngine(options: EngineServiceOptions = {}): EngineInspection {
  const homeDir = absolute(options.homeDir ?? homedir(), 'home directory');
  const paths = enginePaths(homeDir);
  const installed = existsSync(paths.plistPath);
  const base = {
    label: paths.label,
    installed,
    plist_path: paths.plistPath,
    config_path: paths.configPath,
    config_present: existsSync(paths.configPath),
    log_path: paths.logPath,
    error_log_path: paths.errorLogPath,
  };
  if (normalizedPlatform(options.platform) !== 'darwin') {
    return { ...base, state: 'unknown', pid: null, last_exit_code: null, detail: 'The standalone engine agent is macOS-only.' };
  }
  const result = (options.exec ?? defaultExec)('launchctl', ['print', serviceTarget(options.uid)]);
  if (isNotLoaded(result)) {
    return {
      ...base,
      state: 'not_loaded',
      pid: null,
      last_exit_code: null,
      detail: installed ? 'The agent is installed but not loaded; run olympus engine install.' : 'The engine is not installed; run olympus engine install.',
    };
  }
  if (result.status !== 0) {
    return { ...base, state: 'unknown', pid: null, last_exit_code: null, detail: boundedDetail(result) };
  }
  const parsed = parseLaunchctlPrint(result.stdout);
  return {
    ...base,
    state: parsed.state === 'running' ? 'running' : 'loaded',
    pid: parsed.pid,
    last_exit_code: parsed.lastExitCode,
    detail: parsed.state === 'running'
      ? `Running (pid ${parsed.pid ?? 'unknown'}).`
      : `Loaded, not running${parsed.lastExitCode !== null ? ` (last exit code ${parsed.lastExitCode})` : ''}; see olympus engine logs.`,
  };
}

/**
 * What the engine means for deleting Olympus data. `loaded`: launchd has the
 * agent (running, or waiting to restart it), so its worker is or will be up.
 * `unknown`: installed, but launchctl could not say. `none`: not loaded.
 */
export function engineDataCustody(inspection: Pick<EngineInspection, 'state' | 'installed'>): 'loaded' | 'unknown' | 'none' {
  if (inspection.state === 'running' || inspection.state === 'loaded') return 'loaded';
  if (inspection.state === 'unknown' && inspection.installed) return 'unknown';
  return 'none';
}

export function restartEngine(options: EngineServiceOptions = {}): { ok: true; command: string[] } {
  assertDarwin(options.platform);
  const exec = options.exec ?? defaultExec;
  const target = serviceTarget(options.uid);
  if (!launchctlLoaded(exec, target)) {
    throw new OperationError('config_error', 'The engine agent is not loaded.', 'Run olympus engine install.');
  }
  const command = ['launchctl', 'kickstart', '-k', target];
  mustSucceed(exec(command[0]!, command.slice(1)), 'restart the engine agent');
  return { ok: true, command };
}

export function parseLaunchctlPrint(text: string): { state: string | null; pid: number | null; lastExitCode: number | null } {
  const field = (name: string): string | undefined => text.match(new RegExp(`^\\s*${name} = (.+)$`, 'm'))?.[1]?.trim();
  const pid = Number(field('pid'));
  const exit = Number(field('last exit code'));
  return {
    state: field('state') ?? null,
    pid: Number.isSafeInteger(pid) && pid > 0 ? pid : null,
    lastExitCode: Number.isSafeInteger(exit) ? exit : null,
  };
}

/** Last `lines` lines of each engine log, scrubbed of anything token-shaped. */
export function readEngineLogs(options: { homeDir?: string; lines?: number } = {}): { log_path: string; error_log_path: string; stdout: string[]; stderr: string[] } {
  const paths = enginePaths(absolute(options.homeDir ?? homedir(), 'home directory'));
  const lines = Math.max(1, Math.min(options.lines ?? 100, 5_000));
  return {
    log_path: paths.logPath,
    error_log_path: paths.errorLogPath,
    stdout: tailLines(paths.logPath, lines),
    stderr: tailLines(paths.errorLogPath, lines),
  };
}

const LOG_TAIL_BYTES = 512 * 1024;

function tailLines(path: string, lines: number): string[] {
  try {
    const text = readFileSync(path);
    const slice = text.subarray(Math.max(0, text.length - LOG_TAIL_BYTES)).toString('utf8');
    return slice.split(/\r?\n/).filter(Boolean).slice(-lines).map(redactLogLine);
  } catch {
    return [];
  }
}

export function redactLogLine(line: string): string {
  return line
    .replace(/\b(Bearer|token|api[_-]?key|secret|password)([=:\s]+)\S+/gi, '$1$2[redacted]')
    .replace(/\b[A-Za-z0-9_-]{40,}\b/g, '[redacted]');
}

/** Other hosts of the same worker on this Mac: they would compete for its port. */
export function engineConflictWarnings(homeDir: string): string[] {
  const warnings: string[] = [];
  const legacy = workerServicePaths('darwin', homeDir).unitPath;
  if (existsSync(legacy)) {
    warnings.push(`The worker LaunchAgent from olympus worker install is present (${legacy}); it serves the same port. Run olympus worker uninstall so the engine owns the worker.`);
  }
  return warnings;
}

// ---------------------------------------------------------------------------

function guiDomain(uid: number | undefined): string {
  return `gui/${uid ?? process.getuid?.() ?? 501}`;
}

function serviceTarget(uid: number | undefined): string {
  return `${guiDomain(uid)}/${ENGINE_LABEL}`;
}

/**
 * Loads the agent. `launchctl bootout` returns before launchd has finished
 * removing the job, and a bootstrap in that window fails with
 * "Bootstrap failed: 5: Input/output error" (seen live 2026-10-02, which left
 * the engine unloaded). Wait until the label is gone, then bootstrap, retrying
 * that one transient error briefly.
 */
function bootstrapAgent(exec: EngineExec, target: string, domain: string, plistPath: string, afterBootout: boolean, sleep: (ms: number) => void = sleepSync): void {
  if (afterBootout) for (let waited = 0; waited < 10_000 && launchctlLoaded(exec, target); waited += 250) sleep(250);
  let result = exec('launchctl', ['bootstrap', domain, plistPath]);
  for (let attempt = 1; result.status !== 0 && attempt < 8 && /\b5: Input\/output error\b/.test(`${result.stderr ?? ''}`); attempt += 1) {
    sleep(500);
    if (launchctlLoaded(exec, target)) return;
    result = exec('launchctl', ['bootstrap', domain, plistPath]);
  }
  mustSucceed(result, 'load the engine agent');
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function launchctlLoaded(exec: EngineExec, target: string): boolean {
  const result = exec('launchctl', ['print', target]);
  if (result.status === 0) return true;
  if (isNotLoaded(result)) return false;
  throw new OperationError('config_error', `Could not read the engine agent state: ${boundedDetail(result)}`);
}

/** launchctl print exits 113 (older macOS: 3) for a label that is not loaded. */
function isNotLoaded(result: EngineExecResult): boolean {
  return result.status === 113 || result.status === 3
    || /could not find service/i.test(`${result.stderr}${result.stdout}`);
}

function mustSucceed(result: EngineExecResult, what: string): void {
  if (result.status === 0) return;
  throw new OperationError('config_error', `launchctl could not ${what}: ${boundedDetail(result)}`, 'Run olympus engine logs, then olympus engine install again.');
}

function boundedDetail(result: EngineExecResult): string {
  const text = `${result.stderr || result.stdout}`.trim().split(/\r?\n/).slice(0, 3).join(' ');
  return (text || `exit ${result.status ?? 'unknown'}`).slice(0, 300);
}

function defaultExec(command: string, args: string[]): EngineExecResult {
  const result = spawnSync(command, args, { encoding: 'utf8' });
  return {
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? (result.error ? `${command}: ${result.error.message}` : ''),
  };
}

function writeIfChanged(path: string, text: string): boolean {
  if (existsSync(path)) {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new OperationError('config_error', `${path} is not a regular file; remove it by hand.`);
    }
    if (readFileSync(path, 'utf8') === text) return false;
  }
  writePrivateFileAtomicSync(path, text);
  return true;
}

function resolveBun(explicit: string | undefined): string {
  const candidates = [
    explicit,
    isBunName(process.execPath) ? process.execPath : undefined,
    typeof Bun !== 'undefined' ? Bun.which('bun') ?? undefined : undefined,
    process.env.BUN_INSTALL ? join(process.env.BUN_INSTALL, 'bin', 'bun') : undefined,
    join(homedir(), '.bun', 'bin', 'bun'),
    '/opt/homebrew/bin/bun',
    '/usr/local/bin/bun',
  ];
  for (const candidate of candidates) {
    if (!candidate || !isAbsolute(candidate) || !isBunName(candidate)) continue;
    try {
      if (statSync(candidate).isFile()) return candidate;
    } catch {
      // Next candidate.
    }
  }
  throw new OperationError('config_error', 'Olympus needs Bun 1.2+ and could not find it.', 'Install Bun from https://bun.sh, or pass --bun <absolute path>.');
}

function isSymlink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}

function isBunName(path: string): boolean {
  return basename(path).toLowerCase() === 'bun';
}

function assertOlympusPackage(root: string, label: string): void {
  try {
    const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { name?: unknown };
    if (typeof manifest.name === 'string' && PACKAGE_NAMES.has(manifest.name)) return;
  } catch {
    // Fall through to the categorical error.
  }
  throw new OperationError('invalid_params', `${label} ${root} is not an Olympus checkout or package.`);
}

function assertFile(path: string, message: string): void {
  try {
    if (statSync(path).isFile()) return;
  } catch {
    // Fall through.
  }
  throw new OperationError('config_error', message);
}

function assertDarwin(platform: string | undefined): void {
  if (normalizedPlatform(platform) === 'darwin') return;
  throw new OperationError('invalid_params', 'olympus engine is the macOS LaunchAgent host.', 'On Linux, use OpenClaw or olympus worker install.');
}

function normalizedPlatform(platform: string | undefined): string {
  return platform ?? osPlatform();
}

function absolute(value: string, label: string): string {
  const trimmed = value.trim();
  if (trimmed && isAbsolute(trimmed) && !/[\0\r\n]/.test(trimmed)) return trimmed;
  throw new OperationError('config_error', `Could not resolve an absolute ${label} path.`);
}

function objectAt(parent: Record<string, unknown>, key: string): Record<string, unknown> {
  const existing = parent[key];
  if (existing && typeof existing === 'object' && !Array.isArray(existing)) return existing as Record<string, unknown>;
  if (existing !== undefined) {
    throw new OperationError('config_error', `engine.json "${key}" must be an object.`);
  }
  const created: Record<string, unknown> = {};
  parent[key] = created;
  return created;
}

function unxml(value: string): string {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

function xml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}
