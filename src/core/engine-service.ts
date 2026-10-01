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
import { randomBytes } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, statSync } from 'node:fs';
import { homedir, platform as osPlatform } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve as resolvePath } from 'node:path';
import {
  ensurePrivateDirectoryTreeSync,
  ensurePrivateRootDirectorySync,
  removeFileDurablySync,
  writePrivateFileAtomicSync,
} from './atomic-file.ts';
import { OperationError } from './operation-error.ts';
import { olympusPackageRoot } from './package-root.ts';
import { workerAuthTokenFromSetupEnv } from './worker-auth.ts';
import { ensureManagedWorkerEnvironment, workerServicePaths } from './worker-service.ts';

export const ENGINE_LABEL = 'ai.olympusplugin.engine';
/** The one public relay host for standalone (ChatGPT) installs. */
export const STANDALONE_RELAY_HOST = 'mcp.olympusplugin.ai';
export const ENGINE_RUN_COMMAND = '__engine-run';
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
  appSupportDir: string;
  workerEnvPath: string;
}

export function enginePaths(homeDir: string): EnginePaths {
  const home = absolute(homeDir, 'home directory');
  const logDir = join(home, 'Library', 'Logs', 'Olympus');
  return {
    label: ENGINE_LABEL,
    plistPath: join(home, 'Library', 'LaunchAgents', `${ENGINE_LABEL}.plist`),
    logDir,
    logPath: join(logDir, 'engine.log'),
    errorLogPath: join(logDir, 'engine.err'),
    configPath: join(home, '.olympus', 'engine.json'),
    appSupportDir: join(home, 'Library', 'Application Support', 'Olympus'),
    workerEnvPath: join(home, '.config', 'olympus', 'worker.env'),
  };
}

/** What launchd runs: an absolute Bun and the packaged CLI entrypoint. */
export interface EngineProgram {
  runtimePath: string;
  entryPath: string;
  workingDirectory: string;
  source: 'checkout' | 'package';
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
    return { runtimePath, entryPath, workingDirectory: root, source: 'checkout' };
  }
  let root: string;
  try {
    root = olympusPackageRoot();
  } catch {
    throw new OperationError('config_error', 'The installed Olympus package could not be found.', 'Pass --from-checkout <path> to install from a local checkout.');
  }
  const entryPath = join(root, 'dist', 'cli.js');
  assertFile(entryPath, `The installed Olympus package has no ${entryPath}.`);
  return { runtimePath, entryPath, workingDirectory: root, source: 'package' };
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
    <string>1</string>
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
  /** `bootstrapped` (was not loaded), `reloaded` (plist changed), `unchanged`, or `dry_run`. */
  action: 'bootstrapped' | 'reloaded' | 'unchanged' | 'dry_run';
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
    return { ...base, wrote_plist: false, wrote_config: false, wrote_worker_env: false, action: 'dry_run' };
  }

  ensurePrivateRootDirectorySync(homeDir);
  ensurePrivateDirectoryTreeSync(homeDir, dirname(paths.plistPath));
  ensurePrivateDirectoryTreeSync(homeDir, paths.logDir);
  ensurePrivateDirectoryTreeSync(homeDir, dirname(paths.configPath));
  const config = reconcileEngineConfig(paths.configPath);
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
  }
  if (action !== 'unchanged') {
    // A label an owner once disabled refuses bootstrap; enabling is idempotent.
    exec('launchctl', ['enable', target]);
    mustSucceed(exec('launchctl', ['bootstrap', guiDomain(options.uid), paths.plistPath]), 'load the engine agent');
  }
  return {
    ...base,
    wrote_plist: wrotePlist,
    wrote_config: config.wrote,
    wrote_worker_env: workerEnv.wrote,
    action,
  };
}

export interface EngineUninstallResult {
  ok: true;
  plist_path: string;
  unloaded: boolean;
  removed_plist: boolean;
  kept: string[];
}

/** Unload and remove the agent. Config, worker.env and data stay; `olympus data delete --all` removes data. */
export function uninstallEngine(options: EngineServiceOptions = {}): EngineUninstallResult {
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
  return {
    ok: true,
    plist_path: paths.plistPath,
    unloaded: loaded,
    removed_plist: removed,
    kept: [paths.configPath, paths.workerEnvPath, paths.logDir],
  };
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

function xml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}
