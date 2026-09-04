import { chmodSync, closeSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync, readSync, statSync } from 'node:fs';
import { homedir, platform as osPlatform } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, sep } from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  assertManagedPathParentsSync,
  ensurePrivateDirectoryTreeSync,
  ensurePrivateRootDirectorySync,
  removeFileDurablySync,
  writePrivateFileAtomicSync,
} from './atomic-file.ts';
import { OperationError } from './operation-error.ts';
import { isWorkerAuthTokenPlaceholder } from './worker-auth.ts';

export type WorkerServicePlatform = 'darwin' | 'linux';
export type WorkerServiceAction = 'install' | 'status' | 'start' | 'stop' | 'restart' | 'uninstall';
export type WorkerServiceState = 'active' | 'inactive' | 'failed' | 'missing' | 'unknown';

export interface WorkerServiceExecResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

export type WorkerServiceExec = (command: string, args: string[]) => WorkerServiceExecResult;

export interface WorkerServiceInstallOptions {
  platform?: WorkerServicePlatform;
  homeDir?: string;
  olympusBin?: string;
  bunBin?: string;
  workingDirectory?: string;
  envPath?: string;
  authToken?: string;
  port?: number;
  schedulerEnabled?: boolean;
  dryRun?: boolean;
}

export interface WorkerServiceInstallResult {
  ok: true;
  platform: WorkerServicePlatform;
  unit_path: string;
  env_path: string;
  log_path: string;
  error_log_path: string;
  wrote_unit: boolean;
  wrote_env: boolean;
  unit: string;
  commands: {
    install: string[];
    status: string[];
    start: string[];
    stop: string[];
    restart: string[];
    uninstall: string[];
  };
}

export interface WorkerServiceInspection {
  platform: WorkerServicePlatform;
  state: WorkerServiceState;
  unit_present: boolean;
  env_present: boolean;
  command: string[];
  exit_code: number | null;
  detail: string;
}

export function installWorkerService(options: WorkerServiceInstallOptions = {}): WorkerServiceInstallResult {
  const platform = normalizePlatform(options.platform ?? osPlatform());
  const homeDir = validatedAbsolutePath(options.homeDir ?? homedir(), 'home directory');
  const paths = workerServicePaths(platform, homeDir);
  const envPath = options.envPath ?? paths.envPath;
  validateManagedPath(envPath, 'worker environment');
  const unit = platform === 'darwin'
    ? renderLaunchdWorkerUnit({ ...options, envPath, paths })
    : renderSystemdWorkerUnit({ ...options, envPath, paths });
  let wroteUnit = false;
  let wroteEnv = false;
  if (!options.dryRun) {
    ensurePrivateRootDirectorySync(homeDir);
    assertManagedParentSafety(homeDir, paths.unitPath, 'worker unit');
    assertManagedParentSafety(homeDir, paths.logPath, 'worker log');
    if (pathIsWithin(homeDir, envPath)) assertManagedParentSafety(homeDir, envPath, 'worker environment');
    ensurePrivateDirectoryTreeSync(homeDir, dirname(paths.unitPath));
    ensurePrivateDirectoryTreeSync(homeDir, dirname(paths.logPath));
    if (pathIsWithin(homeDir, envPath)) ensurePrivateDirectoryTreeSync(homeDir, dirname(envPath));
    else mkdirSync(dirname(envPath), { recursive: true });
    wroteUnit = writeManagedFileAtomicIfChanged(paths.unitPath, unit, 'worker unit');
    wroteEnv = reconcileWorkerEnv(envPath, options);
  }
  return {
    ok: true,
    platform,
    unit_path: paths.unitPath,
    env_path: envPath,
    log_path: paths.logPath,
    error_log_path: paths.errorLogPath,
    wrote_unit: wroteUnit,
    wrote_env: wroteEnv,
    unit,
    commands: {
      install: workerServiceCommand(platform, 'install', paths.unitPath),
      status: workerServiceCommand(platform, 'status', paths.unitPath),
      start: workerServiceCommand(platform, 'start', paths.unitPath),
      stop: workerServiceCommand(platform, 'stop', paths.unitPath),
      restart: workerServiceCommand(platform, 'restart', paths.unitPath),
      uninstall: platform === 'darwin'
        ? workerServiceCommand(platform, 'stop', paths.unitPath)
        : ['systemctl', '--user', 'disable', '--now', 'olympus-worker.service'],
    },
  };
}

export function runWorkerServiceAction(
  action: WorkerServiceAction,
  options: { platform?: WorkerServicePlatform; homeDir?: string; exec?: WorkerServiceExec } = {},
): { ok: true; command: string[]; stdout: string; stderr: string } {
  const platform = normalizePlatform(options.platform ?? osPlatform());
  const homeDir = validatedAbsolutePath(options.homeDir ?? homedir(), 'home directory');
  const paths = workerServicePaths(platform, homeDir);
  const exec = options.exec ?? defaultWorkerServiceExec;
  if (platform === 'darwin' && action === 'install') {
    return runDarwinWorkerServiceInstall(paths, exec);
  }
  if (platform === 'linux' && action === 'install') {
    return runLinuxWorkerServiceInstall(paths, exec);
  }
  if (platform === 'darwin' && (action === 'start' || action === 'restart')) {
    assertManagedParentSafety(homeDir, paths.unitPath, 'worker unit');
    return runDarwinWorkerServiceActivation(action, paths, exec);
  }
  if (platform === 'darwin' && action === 'stop') {
    return runDarwinWorkerServiceStop(paths, exec);
  }
  if (action === 'uninstall') {
    assertManagedParentSafety(homeDir, paths.unitPath, 'worker unit');
    return platform === 'darwin'
      ? runDarwinWorkerServiceUninstall(paths, exec)
      : runLinuxWorkerServiceUninstall(paths, exec);
  }
  const command = workerServiceCommand(platform, action, paths.unitPath);
  const result = runWorkerServiceCommand(command, exec);
  if (result.status !== 0) {
    throwWorkerServiceActionError(action, result);
  }
  return {
    ok: true,
    command,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

/** How much of a worker log tail is read when explaining a failed activation. */
const WORKER_LOG_TAIL_BYTES = 64 * 1024;
/** A log line is an explanation, not a transcript: keep it to one screen. */
const WORKER_LOG_LINE_MAX_CHARS = 300;

/**
 * The last line the worker itself wrote, for a lifecycle failure to quote.
 *
 * A worker that exits immediately leaves the service manager reporting only
 * "inactive", which is true and useless: the reason is in the worker's own
 * stderr. Standard error is read first because a boot refusal lands there;
 * stdout is the fallback for a worker that refused before its error stream
 * carried anything.
 */
export function workerServiceFailureLogLine(
  options: { platform?: WorkerServicePlatform; homeDir?: string } = {},
): string | undefined {
  let paths: ReturnType<typeof workerServicePaths>;
  try {
    paths = workerServicePaths(
      normalizePlatform(options.platform ?? osPlatform()),
      validatedAbsolutePath(options.homeDir ?? homedir(), 'home directory'),
    );
  } catch {
    return undefined;
  }
  return lastLogLine(paths.errorLogPath) ?? lastLogLine(paths.logPath);
}

function lastLogLine(path: string): string | undefined {
  let text: string;
  try {
    const size = statSync(path).size;
    if (size === 0) return undefined;
    const length = Math.min(size, WORKER_LOG_TAIL_BYTES);
    const buffer = Buffer.alloc(length);
    const handle = openSync(path, 'r');
    try {
      readSync(handle, buffer, 0, length, size - length);
    } finally {
      closeSync(handle);
    }
    text = buffer.toString('utf8');
  } catch {
    return undefined;
  }
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const line = lines.at(-1);
  if (!line) return undefined;
  return redactWorkerLogLine(line).slice(0, WORKER_LOG_LINE_MAX_CHARS);
}

/**
 * Logs are written under a scrubbing discipline, but this line is about to be
 * reprinted into a command's own output, so anything token-shaped is dropped
 * here too rather than trusted to have been scrubbed upstream.
 */
function redactWorkerLogLine(line: string): string {
  return line
    .replace(/\b(Bearer|token|api[_-]?key|secret|password)([=:\s]+)\S+/gi, '$1$2[redacted]')
    .replace(/\b[A-Za-z0-9_-]{40,}\b/g, '[redacted]');
}

export function inspectWorkerService(
  options: {
    platform?: WorkerServicePlatform;
    homeDir?: string;
    envPath?: string;
    exec?: WorkerServiceExec;
  } = {},
): WorkerServiceInspection {
  const platform = normalizePlatform(options.platform ?? osPlatform());
  const homeDir = validatedAbsolutePath(options.homeDir ?? homedir(), 'home directory');
  const paths = workerServicePaths(platform, homeDir);
  // An install may point the unit at an environment file outside the default
  // managed location; report custody of the file this installation actually
  // uses rather than of a default path it never wrote.
  const envPath = options.envPath ?? paths.envPath;
  const command = workerServiceCommand(platform, 'status', paths.unitPath);
  const result = runWorkerServiceCommand(command, options.exec ?? defaultWorkerServiceExec);
  const unitPresent = isManagedRegularFile(paths.unitPath);
  const unitPathPresent = existsSync(paths.unitPath);
  const envPathPresent = existsSync(envPath);
  const unsafeParentDetail = managedParentSafetyDetail(homeDir, paths.unitPath, envPath);
  const nonRegularDetail = unsafeParentDetail ?? (unitPathPresent && !unitPresent
    ? 'managed worker unit path is not a regular file'
    : envPathPresent && !isManagedRegularFile(envPath)
      ? 'managed worker environment path is not a regular file'
      : undefined);
  const state = nonRegularDetail
    ? 'unknown'
    : classifyWorkerServiceState(platform, result, unitPresent);
  return {
    platform,
    state,
    unit_present: unitPresent,
    env_present: isManagedRegularFile(envPath),
    command,
    exit_code: result.status,
    detail: nonRegularDetail ?? boundedServiceDetail(result),
  };
}

function runDarwinWorkerServiceInstall(
  paths: ReturnType<typeof workerServicePaths>,
  exec: WorkerServiceExec,
): { ok: true; command: string[]; stdout: string; stderr: string } {
  const statusCommand = workerServiceCommand('darwin', 'status', paths.unitPath);
  const stopCommand = workerServiceCommand('darwin', 'stop', paths.unitPath);
  const installCommand = workerServiceCommand('darwin', 'install', paths.unitPath);
  const status = runWorkerServiceCommand(statusCommand, exec);
  const outputs: WorkerServiceExecResult[] = [];

  if (status.status === 0) {
    outputs.push(status);
    const stopped = runWorkerServiceCommand(stopCommand, exec);
    outputs.push(stopped);
    if (stopped.status !== 0) {
      throwWorkerServiceActionError('install', stopped, 'failed to unload the existing macOS worker service before reinstalling');
    }
  }

  const installed = runWorkerServiceCommand(installCommand, exec);
  outputs.push(installed);
  if (installed.status !== 0) {
    throwWorkerServiceActionError('install', installed);
  }

  return {
    ok: true,
    command: installCommand,
    stdout: outputs.map((result) => result.stdout).join(''),
    stderr: outputs.map((result) => result.stderr).join(''),
  };
}

function runLinuxWorkerServiceInstall(
  paths: ReturnType<typeof workerServicePaths>,
  exec: WorkerServiceExec,
): { ok: true; command: string[]; stdout: string; stderr: string } {
  const installCommand = workerServiceCommand('linux', 'install', paths.unitPath);
  const reloaded = reloadLinuxWorkerServiceManager({ exec });

  const installed = runWorkerServiceCommand(installCommand, exec);
  if (installed.status !== 0) {
    throwWorkerServiceActionError('install', installed);
  }

  return {
    ok: true,
    command: installCommand,
    stdout: `${reloaded.stdout}${installed.stdout}`,
    stderr: `${reloaded.stderr}${installed.stderr}`,
  };
}

export function reloadLinuxWorkerServiceManager(
  options: { exec?: WorkerServiceExec } = {},
): { ok: true; command: string[]; stdout: string; stderr: string } {
  const command = ['systemctl', '--user', 'daemon-reload'];
  const result = runWorkerServiceCommand(command, options.exec ?? defaultWorkerServiceExec);
  if (result.status !== 0) {
    throwWorkerServiceActionError(
      'install',
      result,
      'failed to reload the user systemd manager after changing the worker unit',
    );
  }
  return { ok: true, command, stdout: result.stdout, stderr: result.stderr };
}

/**
 * Clear a latched systemd failure for the managed worker unit.
 *
 * `systemctl --user stop` succeeds without clearing a unit that is already in
 * the `failed` result state, so a stopped-but-failed unit keeps reporting
 * `failed` to `is-active`. Only `reset-failed` retires that record, which is
 * what lets a rollback prove the attempted worker is really down.
 */
export function resetFailedLinuxWorkerService(
  options: { exec?: WorkerServiceExec } = {},
): { ok: true; command: string[]; stdout: string; stderr: string } {
  const command = ['systemctl', '--user', 'reset-failed', 'olympus-worker.service'];
  const result = runWorkerServiceCommand(command, options.exec ?? defaultWorkerServiceExec);
  if (result.status !== 0) {
    throwWorkerServiceActionError(
      'stop',
      result,
      'failed to clear the latched systemd failure for the managed worker unit',
    );
  }
  return { ok: true, command, stdout: result.stdout, stderr: result.stderr };
}

function runDarwinWorkerServiceActivation(
  action: 'start' | 'restart',
  paths: ReturnType<typeof workerServicePaths>,
  exec: WorkerServiceExec,
): { ok: true; command: string[]; stdout: string; stderr: string } {
  const status = runWorkerServiceCommand(workerServiceCommand('darwin', 'status', paths.unitPath), exec);
  const unloaded = status.status === 3 || status.status === 113;
  if (!unloaded && status.status !== 0) throwWorkerServiceActionError(action, status);
  if (unloaded && !isManagedRegularFile(paths.unitPath)) {
    throwWorkerServiceActionError(action, status, 'the managed macOS worker unit is not installed');
  }
  const command = unloaded
    ? workerServiceCommand('darwin', 'install', paths.unitPath)
    : workerServiceCommand('darwin', action, paths.unitPath);
  const result = runWorkerServiceCommand(command, exec);
  if (result.status !== 0) throwWorkerServiceActionError(action, result);
  return { ok: true, command, stdout: result.stdout, stderr: result.stderr };
}

function runDarwinWorkerServiceStop(
  paths: ReturnType<typeof workerServicePaths>,
  exec: WorkerServiceExec,
): { ok: true; command: string[]; stdout: string; stderr: string } {
  const command = workerServiceCommand('darwin', 'stop', paths.unitPath);
  const status = runWorkerServiceCommand(workerServiceCommand('darwin', 'status', paths.unitPath), exec);
  if (status.status === 3 || status.status === 113) {
    return { ok: true, command, stdout: '', stderr: status.stderr };
  }
  if (status.status !== 0) throwWorkerServiceActionError('stop', status);
  const result = runWorkerServiceCommand(command, exec);
  if (result.status !== 0) throwWorkerServiceActionError('stop', result);
  return { ok: true, command, stdout: result.stdout, stderr: result.stderr };
}

function runDarwinWorkerServiceUninstall(
  paths: ReturnType<typeof workerServicePaths>,
  exec: WorkerServiceExec,
): { ok: true; command: string[]; stdout: string; stderr: string } {
  const statusCommand = workerServiceCommand('darwin', 'status', paths.unitPath);
  const stopCommand = workerServiceCommand('darwin', 'stop', paths.unitPath);
  const status = runWorkerServiceCommand(statusCommand, exec);
  const outputs = [status];
  if (status.status === 0) {
    const stopped = runWorkerServiceCommand(stopCommand, exec);
    outputs.push(stopped);
    if (stopped.status !== 0) throwWorkerServiceActionError('uninstall', stopped);
  } else if (status.status !== 3 && status.status !== 113 && isManagedRegularFile(paths.unitPath)) {
    throwWorkerServiceActionError('uninstall', status, 'could not determine whether the macOS worker service was loaded');
  }
  const removed = removeManagedFile(paths.unitPath, 'worker unit');
  return {
    ok: true,
    command: stopCommand,
    stdout: `${outputs.map((result) => result.stdout).join('')}${removed ? 'removed worker unit\n' : 'worker unit already absent\n'}`,
    stderr: outputs.map((result) => result.stderr).join(''),
  };
}

function runLinuxWorkerServiceUninstall(
  paths: ReturnType<typeof workerServicePaths>,
  exec: WorkerServiceExec,
): { ok: true; command: string[]; stdout: string; stderr: string } {
  const disableCommand = ['systemctl', '--user', 'disable', '--now', 'olympus-worker.service'];
  const reloadCommand = ['systemctl', '--user', 'daemon-reload'];
  const outputs: WorkerServiceExecResult[] = [];
  const unitPresent = isManagedRegularFile(paths.unitPath);
  const status = runWorkerServiceCommand(workerServiceCommand('linux', 'status', paths.unitPath), exec);
  if (unitPresent || classifyWorkerServiceState('linux', status, unitPresent) === 'active') {
    const disabled = runWorkerServiceCommand(disableCommand, exec);
    outputs.push(disabled);
    if (disabled.status !== 0) throwWorkerServiceActionError('uninstall', disabled);
  }
  const removed = removeManagedFile(paths.unitPath, 'worker unit');
  const reloaded = runWorkerServiceCommand(reloadCommand, exec);
  outputs.push(reloaded);
  if (reloaded.status !== 0) throwWorkerServiceActionError('uninstall', reloaded);
  return {
    ok: true,
    command: disableCommand,
    stdout: `${outputs.map((result) => result.stdout).join('')}${removed ? 'removed worker unit\n' : 'worker unit already absent\n'}`,
    stderr: outputs.map((result) => result.stderr).join(''),
  };
}

function runWorkerServiceCommand(command: string[], exec: WorkerServiceExec): WorkerServiceExecResult {
  const [cmd, ...args] = command;
  return exec(cmd!, args);
}

function throwWorkerServiceActionError(
  action: WorkerServiceAction,
  result: WorkerServiceExecResult,
  detail?: string,
): never {
  throw new OperationError(
    'config_error',
    `olympus worker ${action} failed with exit code ${result.status ?? 'unknown'}.`,
    detail ?? (result.stderr.trim() || result.stdout.trim() || undefined),
  );
}

function classifyWorkerServiceState(
  platform: WorkerServicePlatform,
  result: WorkerServiceExecResult,
  unitPresent: boolean,
): WorkerServiceState {
  const output = `${result.stdout}\n${result.stderr}`.trim().toLowerCase();
  if (platform === 'linux') {
    const status = result.stdout.trim().toLowerCase();
    if (result.status === 0 && status === 'active') return 'active';
    if (status === 'inactive') return unitPresent ? 'inactive' : 'missing';
    if (status === 'failed') return 'failed';
    if (!unitPresent && (result.status === 3 || result.status === 4)) return 'missing';
    return 'unknown';
  }
  if (result.status === 0) {
    if (/\bstate\s*=\s*running\b/.test(output)) return 'active';
    const lastExit = output.match(/\blast exit code\s*=\s*(-?\d+)\b/);
    if (lastExit && Number(lastExit[1]) !== 0) return 'failed';
    return 'inactive';
  }
  if ((result.status === 3 || result.status === 113) && !unitPresent) return 'missing';
  if (result.status === 3 || result.status === 113) return 'inactive';
  return 'unknown';
}

function boundedServiceDetail(result: WorkerServiceExecResult): string {
  const text = (result.stderr.trim() || result.stdout.trim() || `exit ${result.status ?? 'unknown'}`)
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return text.slice(0, 240);
}

function defaultWorkerServiceExec(command: string, args: string[]): WorkerServiceExecResult {
  const result = spawnSync(command, args, { encoding: 'utf8' });
  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

export function workerServicePaths(platform: WorkerServicePlatform, homeDir: string): {
  label: string;
  unitPath: string;
  envPath: string;
  logPath: string;
  errorLogPath: string;
} {
  homeDir = validatedAbsolutePath(homeDir, 'home directory');
  if (platform === 'darwin') {
    const logDir = join(homeDir, 'Library', 'Logs', 'Olympus');
    return {
      label: 'com.openclaw.olympus.worker',
      unitPath: join(homeDir, 'Library', 'LaunchAgents', 'com.openclaw.olympus.worker.plist'),
      envPath: join(homeDir, '.config', 'olympus', 'worker.env'),
      logPath: join(logDir, 'worker.log'),
      errorLogPath: join(logDir, 'worker.err'),
    };
  }
  const stateDir = join(homeDir, '.local', 'state', 'olympus', 'worker');
  return {
    label: 'olympus-worker',
    unitPath: join(homeDir, '.config', 'systemd', 'user', 'olympus-worker.service'),
    envPath: join(homeDir, '.config', 'olympus', 'worker.env'),
    logPath: join(stateDir, 'worker.log'),
    errorLogPath: join(stateDir, 'worker.err'),
  };
}

function renderLaunchdWorkerUnit(input: WorkerServiceInstallOptions & {
  envPath: string;
  paths: ReturnType<typeof workerServicePaths>;
}): string {
  const command = workerServiceExecCommand(input);
  const workingDirectory = input.workingDirectory ?? process.cwd();
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${input.paths.label}</string>
  <key>WorkingDirectory</key>
  <string>${escapeXml(workingDirectory)}</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/sh</string>
    <string>-c</string>
    <string>${escapeXml(launchdEnvSourcingExec(input.envPath, command))}</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>ThrottleInterval</key>
  <integer>60</integer>
  <key>StandardOutPath</key>
  <string>${escapeXml(input.paths.logPath)}</string>
  <key>StandardErrorPath</key>
  <string>${escapeXml(input.paths.errorLogPath)}</string>
</dict>
</plist>
`;
}

function renderSystemdWorkerUnit(input: WorkerServiceInstallOptions & {
  envPath: string;
  paths: ReturnType<typeof workerServicePaths>;
}): string {
  const command = workerServiceExecCommand(input);
  const workingDirectory = input.workingDirectory ?? process.cwd();
  return `[Unit]
Description=Olympus source worker
After=network-online.target

[Service]
Type=simple
WorkingDirectory=${workingDirectory}
EnvironmentFile=-${input.envPath}
ExecStart=${command.map(systemdExecArg).join(' ')}
Restart=on-failure
RestartSec=5
StandardOutput=append:${input.paths.logPath}
StandardError=append:${input.paths.errorLogPath}

[Install]
WantedBy=default.target
`;
}

function workerServiceCommand(platform: WorkerServicePlatform, action: WorkerServiceAction | 'install', unitPath: string): string[] {
  if (platform === 'darwin') {
    const uid = process.getuid?.() ?? 501;
    const guiTarget = `gui/${uid}`;
    const target = `${guiTarget}/com.openclaw.olympus.worker`;
    if (action === 'install') return ['launchctl', 'bootstrap', guiTarget, unitPath];
    if (action === 'status') return ['launchctl', 'print', target];
    if (action === 'start') return ['launchctl', 'kickstart', target];
    if (action === 'restart') return ['launchctl', 'kickstart', '-k', target];
    return ['launchctl', 'bootout', target];
  }
  if (action === 'install') return ['systemctl', '--user', 'enable', '--now', 'olympus-worker.service'];
  if (action === 'status') return ['systemctl', '--user', 'is-active', 'olympus-worker.service'];
  return ['systemctl', '--user', action, 'olympus-worker.service'];
}

function defaultWorkerEnv(options: WorkerServiceInstallOptions): string {
  const trimmedAuthToken = options.authToken?.trim();
  const authToken = isWorkerAuthTokenPlaceholder(trimmedAuthToken) ? undefined : trimmedAuthToken;
  const bunBin = resolveBunBin(options);
  return [
    '# Olympus source worker environment.',
    `PATH=${defaultWorkerPath(bunBin)}`,
    `OLYMPUS_EMAIL_SOURCE_PORT=${options.port ?? 8010}`,
    `OLYMPUS_WORKER_SCHEDULER_ENABLED=${options.schedulerEnabled === true ? 'true' : 'false'}`,
    'OLYMPUS_SOURCE_INDEX_ANSWER_ENABLED=true',
    authToken ? `OLYMPUS_WORKER_AUTH_TOKEN=${authToken}` : '# OLYMPUS_WORKER_AUTH_TOKEN=replace-with-generated-token',
    '',
  ].join('\n');
}

// launchd has no EnvironmentFile equivalent (systemd gets one below), so the
// worker command sources worker.env itself; without this, macOS workers run
// with the bare launchd PATH and cannot spawn openclaw for the cloud analyst.
function launchdEnvSourcingExec(envPath: string, command: string[]): string {
  const source = `set -a; [ -f ${shellQuote(envPath)} ] && . ${shellQuote(envPath)}; set +a;`;
  return `${source} exec ${command.map(shellQuote).join(' ')}`;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function workerServiceExecCommand(options: WorkerServiceInstallOptions): string[] {
  const bunBin = resolveBunBin(options);
  return [bunBin, defaultOlympusCliJs(options), '__worker-service-run'];
}

function nextWorkerEnvAuthToken(text: string, authToken: string | undefined): string {
  const token = authToken?.trim();
  if (!token || isWorkerAuthTokenPlaceholder(token)) return text;
  const existing = text.match(/^OLYMPUS_WORKER_AUTH_TOKEN=(.+)$/m)?.[1];
  if (existing && !isWorkerAuthTokenPlaceholder(existing)) return text;
  return /^#?\s*OLYMPUS_WORKER_AUTH_TOKEN=.*$/m.test(text)
    ? text.replace(/^#?\s*OLYMPUS_WORKER_AUTH_TOKEN=.*$/m, `OLYMPUS_WORKER_AUTH_TOKEN=${token}`)
    : `${text.replace(/\n?$/, '\n')}OLYMPUS_WORKER_AUTH_TOKEN=${token}\n`;
}

function nextWorkerEnvPath(text: string, options: WorkerServiceInstallOptions): string {
  const bunBin = resolveBunBin(options);
  const desiredPath = defaultWorkerPath(bunBin, text.match(/^PATH=(.*)$/m)?.[1]);
  return /^PATH=.*$/m.test(text)
    ? text.replace(/^PATH=.*$/m, `PATH=${desiredPath}`)
    : `${text.replace(/\n?$/, '\n')}PATH=${desiredPath}\n`;
}

function reconcileWorkerEnv(envPath: string, options: WorkerServiceInstallOptions): boolean {
  mkdirSync(dirname(envPath), { recursive: true });
  if (!existsSync(envPath)) {
    writePrivateFileAtomicSync(envPath, defaultWorkerEnv(options));
    return true;
  }
  assertManagedRegularFile(envPath, 'worker environment');
  const current = readFileSync(envPath, 'utf8');
  let next = nextWorkerEnvAuthToken(current, options.authToken);
  next = nextWorkerEnvPath(next, options);
  if (!/^OLYMPUS_SOURCE_INDEX_ANSWER_ENABLED=/m.test(next)) {
    next = `${next.replace(/\n?$/, '\n')}OLYMPUS_SOURCE_INDEX_ANSWER_ENABLED=true\n`;
  }
  const mode = statSync(envPath).mode & 0o777;
  if (next !== current) {
    writePrivateFileAtomicSync(envPath, next);
    return true;
  }
  if (mode !== 0o600) {
    chmodSync(envPath, 0o600);
    return true;
  }
  return false;
}

/**
 * The environment names a connect command may write into the installed worker
 * environment. worker.env is the worker's whole environment and the install
 * guide forbids editing it by hand, so the set of keys a command may put there
 * is a positive list — not "whatever the caller passes".
 */
export const MANAGED_WORKER_ENV_SECRET_KEYS = ['OLYMPUS_SOURCE_INDEX_GEMINI_API_KEY'] as const;
export type ManagedWorkerEnvSecretKey = typeof MANAGED_WORKER_ENV_SECRET_KEYS[number];

/**
 * Store one API key in the installed worker environment.
 *
 * The supervised worker reads this key from ITS process environment, which
 * launchd/systemd load from worker.env, so an `export` in the operator's shell
 * never reaches it. This is the only supported way to put such a key where the
 * worker will actually find it.
 */
export function writeManagedWorkerEnvSecret(input: {
  key: ManagedWorkerEnvSecretKey;
  value: string;
  platform?: WorkerServicePlatform;
  homeDir?: string;
  envPath?: string;
}): { ok: true; path: string; key: ManagedWorkerEnvSecretKey; wrote: boolean } {
  if (!(MANAGED_WORKER_ENV_SECRET_KEYS as readonly string[]).includes(input.key)) {
    throw new OperationError('invalid_params', `${input.key} is not a managed worker environment key.`);
  }
  const value = input.value.trim();
  if (!value) {
    throw new OperationError('invalid_params', `${input.key} must not be empty.`);
  }
  // A newline would forge a second assignment in worker.env; NUL and CR would
  // survive the parser differently in the shell that sources it.
  if (/[\0\r\n]/.test(value)) {
    throw new OperationError('invalid_params', `${input.key} must not contain line breaks or NUL bytes.`);
  }
  const platform = normalizePlatform(input.platform ?? osPlatform());
  const homeDir = validatedAbsolutePath(input.homeDir ?? homedir(), 'home directory');
  const envPath = input.envPath ?? workerServicePaths(platform, homeDir).envPath;
  validateManagedPath(envPath, 'worker environment');
  if (!existsSync(envPath)) {
    throw new OperationError(
      'config_error',
      `No Olympus worker environment exists at ${envPath}.`,
      'Run olympus setup --preset <preset> --yes first; it creates the worker environment this key is stored in.',
    );
  }
  assertManagedRegularFile(envPath, 'worker environment');
  const current = readFileSync(envPath, 'utf8');
  const assignment = `${input.key}=${value}`;
  // Horizontal whitespace only: `\s` would let a bare `#` line swallow the
  // newline after it and take the assignment below with it.
  const pattern = new RegExp(`^#?[ \\t]*${input.key}=.*$`, 'm');
  const next = pattern.test(current)
    ? current.replace(pattern, assignment)
    : `${current.replace(/\n?$/, '\n')}${assignment}\n`;
  let wrote = false;
  if (next !== current) {
    writePrivateFileAtomicSync(envPath, next);
    wrote = true;
  }
  if ((statSync(envPath).mode & 0o777) !== 0o600) {
    chmodSync(envPath, 0o600);
    wrote = true;
  }
  return { ok: true, path: envPath, key: input.key, wrote };
}

function normalizePlatform(value: string): WorkerServicePlatform {
  if (value === 'darwin' || value === 'linux') return value;
  throw new OperationError('invalid_params', 'olympus worker install supports macOS launchd and Linux user-systemd.');
}

function resolveBunBin(options: WorkerServiceInstallOptions): string {
  if (options.bunBin) return validateBunBin(validatedAbsolutePath(options.bunBin, 'Bun executable'));
  const runtimePath = process.execPath;
  if (runtimePath && isAbsolute(runtimePath) && isBunExecutableName(runtimePath)) {
    return validateBunBin(runtimePath);
  }
  const bunWhich = typeof Bun !== 'undefined' ? Bun.which('bun') : null;
  if (!bunWhich || !isAbsolute(bunWhich)) {
    throw new OperationError('config_error', 'Could not resolve an absolute Bun executable path for the worker service.');
  }
  return validateBunBin(bunWhich);
}

function validateBunBin(bunBin: string): string {
  if (!isBunExecutableName(bunBin)) {
    throw new OperationError('config_error', `Could not validate the resolved Bun executable path: ${bunBin}`);
  }
  try {
    if (!statSync(bunBin).isFile()) {
      throw new OperationError('config_error', `Resolved Bun path is not a file: ${bunBin}`);
    }
  } catch (error) {
    if (error instanceof OperationError) throw error;
    throw new OperationError('config_error', `Resolved Bun executable does not exist: ${bunBin}`);
  }
  return bunBin;
}

function isBunExecutableName(path: string): boolean {
  const base = basename(path).toLowerCase();
  return base === 'bun' || base === 'bun.exe';
}

function validatedAbsolutePath(value: string, label: string): string {
  const trimmed = value.trim();
  if (trimmed && isAbsolute(trimmed) && !/[\0\r\n]/.test(trimmed)) return trimmed;
  throw new OperationError('config_error', `Could not resolve an absolute ${label} path for the worker service.`);
}

function defaultOlympusCliJs(options: WorkerServiceInstallOptions): string {
  if (options.workingDirectory) {
    return join(validatedAbsolutePath(options.workingDirectory, 'working directory'), 'dist', 'cli.js');
  }
  const invoked = process.argv[1]?.trim();
  if (invoked && !invoked.startsWith('-') && basename(invoked) === 'cli.js') {
    return isAbsolute(invoked) ? invoked : join(process.cwd(), invoked);
  }
  return join(process.cwd(), 'dist', 'cli.js');
}

function defaultWorkerPath(bunBin: string, existingPath?: string): string {
  const entries = [
    dirname(bunBin),
    ...(existingPath ? existingPath.split(':') : []),
    '/opt/homebrew/bin',
    '/usr/local/bin',
    '/usr/bin',
    '/bin',
    '/usr/sbin',
    '/sbin',
  ].map((entry) => entry.trim()).filter(Boolean);
  return Array.from(new Set(entries)).join(':');
}

function systemdExecArg(value: string): string {
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(value)) return value;
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function validateManagedPath(path: string, label: string): void {
  validatedAbsolutePath(path, label);
}

/** True when `path` is the custody root itself or a descendant of it. */
export function pathIsWithin(root: string, path: string): boolean {
  const suffix = relative(root, path);
  return suffix === '' || (!isAbsolute(suffix) && suffix !== '..' && !suffix.startsWith(`..${sep}`));
}

function assertManagedParentSafety(homeDir: string, path: string, label: string): void {
  try {
    assertManagedPathParentsSync(homeDir, path, label);
  } catch (error) {
    throw new OperationError(
      'config_error',
      `Refusing unsafe managed ${label} parent path: ${path}`,
      error instanceof Error ? error.message : undefined,
    );
  }
}

function managedParentSafetyDetail(
  homeDir: string,
  unitPath: string,
  envPath: string,
): string | undefined {
  try {
    assertManagedPathParentsSync(homeDir, unitPath, 'worker unit');
    // Custody assertions only describe paths inside the home root; an env file
    // deliberately placed outside it is the operator's to own, exactly as
    // installWorkerService treats it.
    if (pathIsWithin(homeDir, envPath)) {
      assertManagedPathParentsSync(homeDir, envPath, 'worker environment');
    }
    return undefined;
  } catch {
    return 'managed worker path has an unsafe parent directory component';
  }
}

function isManagedRegularFile(path: string): boolean {
  try {
    return lstatSync(path).isFile();
  } catch {
    return false;
  }
}

function assertManagedRegularFile(path: string, label: string): void {
  let stats: ReturnType<typeof lstatSync>;
  try {
    stats = lstatSync(path);
  } catch {
    throw new OperationError('config_error', `Could not inspect the managed ${label} path: ${path}`);
  }
  if (!stats.isFile()) {
    throw new OperationError('config_error', `Refusing a non-regular managed ${label} path: ${path}`);
  }
}

function writeManagedFileAtomicIfChanged(path: string, text: string, label: string): boolean {
  validateManagedPath(path, label);
  if (existsSync(path)) {
    assertManagedRegularFile(path, label);
    if (readFileSync(path, 'utf8') === text) {
      if ((statSync(path).mode & 0o777) !== 0o600) {
        chmodSync(path, 0o600);
        return true;
      }
      return false;
    }
  }
  writePrivateFileAtomicSync(path, text);
  return true;
}

function removeManagedFile(path: string, label: string): boolean {
  validateManagedPath(path, label);
  if (!existsSync(path)) return false;
  assertManagedRegularFile(path, label);
  return removeFileDurablySync(path);
}
