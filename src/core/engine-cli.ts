/**
 * `olympus engine install|uninstall|status|start|stop|restart|rollback|logs`: the standalone
 * macOS engine's command surface. Mechanics live in engine-service.ts; this
 * file parses arguments and assembles the status report.
 */
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { configFromPluginConfig } from './config.ts';
import { engineStatusPath, type EngineStatusFile } from './engine-host.ts';
import {
  engineConflictWarnings,
  enginePaths,
  inspectEngine,
  installEngineVerified,
  readEngineConfig,
  readEngineLogs,
  redactLogLine,
  restartEngine,
  rollbackEngine,
  startEngine,
  stopEngine,
  uninstallEngine,
  verifyEngine,
  type EngineExec,
  type EngineHealthDeps,
} from './engine-service.ts';
import { installOpenHandler, uninstallOpenHandler, type OpenHandlerOptions, type OpenHandlerResult } from './open-handler.ts';
import { resolveOpenClawExecutable } from './openclaw-executable.ts';
import { OperationError } from './operation-error.ts';
import { readRemoteAccessStatus, relayProcessRunning, remoteAccessDirForCli, resolveRemoteAccessMode } from './remote-access.ts';

export const ENGINE_CLI_USAGE = {
  'engine install': 'olympus engine install [--from-checkout <path>] [--bun <path>] [--restart] [--now] [--dry-run]',
  'engine uninstall': 'olympus engine uninstall',
  'engine status': 'olympus engine status',
  'engine start': 'olympus engine start',
  'engine stop': 'olympus engine stop [--now]',
  'engine restart': 'olympus engine restart [--now]',
  'engine rollback': 'olympus engine rollback',
  'engine verify': 'olympus engine verify [--expect-package <path> | --expect-build <build>]',
  'engine logs': 'olympus engine logs [--lines <n>] [--follow]',
} as const;

export interface EngineCliDeps {
  homeDir?: string;
  exec?: EngineExec;
  uid?: number;
  platform?: string;
  env?: Record<string, string | undefined>;
  fetchImpl?: typeof fetch;
  openclawPath?: () => string | undefined;
  /** Test seam for the post-install health proof. */
  health?: EngineHealthDeps;
  /**
   * The olympus:// link handler (open-handler.ts), installed beside the agent
   * and removed with it. A caller that injects `exec` (a test) gets no handler
   * unless it passes this too, so a fake launchctl never builds an applet.
   */
  openHandler?: {
    install(options: OpenHandlerOptions): OpenHandlerResult;
    uninstall(options: OpenHandlerOptions): OpenHandlerResult;
  };
}

const DEFAULT_OPEN_HANDLER = { install: installOpenHandler, uninstall: uninstallOpenHandler };

export async function runEngineCommand(args: string[], deps: EngineCliDeps = {}): Promise<unknown> {
  const [command, ...rest] = args;
  const service = {
    ...(deps.homeDir ? { homeDir: deps.homeDir } : {}),
    ...(deps.exec ? { exec: deps.exec } : {}),
    ...(deps.uid !== undefined ? { uid: deps.uid } : {}),
    ...(deps.platform ? { platform: deps.platform } : {}),
  };
  if (command === 'install') {
    const options = parseInstallArgs(rest);
    const result = await installEngineVerified({ ...service, ...options, ...(deps.health ? { health: deps.health } : {}) });
    const { plist, ...summary } = result;
    // The link handler never decides whether the install worked: a handler
    // that could not be built is a warning, and the Terminal fallback stays.
    const handler = options.dryRun ? undefined : openHandlerFor(deps)?.install({
      ...openHandlerOptions(deps, service),
      program: { runtimePath: result.program.runtimePath, entryPath: result.program.entryPath, workingDirectory: result.program.workingDirectory },
    });
    if (handler && !handler.ok) summary.warnings.push(`olympus:// links will not open Olympus: ${handler.detail ?? 'the link handler could not be installed.'}`);
    return {
      ...summary,
      ...(handler ? { open_handler: handler } : {}),
      ...(options.dryRun ? { plist } : {}),
      next: result.action === 'dry_run'
        ? 'Rerun without --dry-run to write and load the agent.'
        : result.ok
          ? 'Run olympus engine status; the engine links itself to the relay once the worker is ready.'
          : 'Run olympus engine logs to see why the engine did not become healthy.',
    };
  }
  if (command === 'verify') {
    return verifyEngine({ ...service, ...parseVerifyArgs(rest), ...(deps.health ? { health: deps.health } : {}) });
  }
  if (command === 'uninstall') {
    expectNoArgs('uninstall', rest);
    const result = uninstallEngine(service);
    const handler = openHandlerFor(deps)?.uninstall(openHandlerOptions(deps, service));
    return handler ? { ...result, open_handler: handler } : result;
  }
  if (command === 'restart') {
    return restartEngine({ ...service, ...parseNowArg('restart', rest) });
  }
  if (command === 'stop') {
    return stopEngine({ ...service, ...parseNowArg('stop', rest) });
  }
  if (command === 'start') {
    expectNoArgs('start', rest);
    return startEngine(service);
  }
  if (command === 'rollback') {
    expectNoArgs('rollback', rest);
    return rollbackEngine({ ...service, ...(deps.health ? { health: deps.health } : {}) });
  }
  if (command === 'status') {
    expectNoArgs('status', rest);
    return engineStatusReport(deps);
  }
  if (command === 'logs') {
    const options = parseLogsArgs(rest);
    if (options.follow) {
      await followEngineLogs(deps.homeDir ?? homedir(), options.lines);
      return undefined;
    }
    return readEngineLogs({ ...(deps.homeDir ? { homeDir: deps.homeDir } : {}), lines: options.lines });
  }
  throw new OperationError('invalid_params', `Unknown engine command: ${command ?? ''}`.trim(), 'Run olympus engine --help.');
}

function openHandlerFor(deps: EngineCliDeps): EngineCliDeps['openHandler'] {
  return deps.openHandler ?? (deps.exec ? undefined : DEFAULT_OPEN_HANDLER);
}

function openHandlerOptions(deps: EngineCliDeps, service: { homeDir?: string; platform?: string }): OpenHandlerOptions {
  return {
    ...(service.homeDir ? { homeDir: service.homeDir } : {}),
    ...(service.platform ? { platform: service.platform } : {}),
    ...(deps.env ? { env: deps.env } : {}),
  };
}

/** Everything a person needs to know about this install, with OpenClaw absent or present. */
export async function engineStatusReport(deps: EngineCliDeps = {}): Promise<Record<string, unknown>> {
  const homeDir = deps.homeDir ?? homedir();
  const env = { ...(deps.env ?? process.env), HOME: homeDir };
  const paths = enginePaths(homeDir);
  const agent = inspectEngine({
    homeDir,
    ...(deps.exec ? { exec: deps.exec } : {}),
    ...(deps.uid !== undefined ? { uid: deps.uid } : {}),
    ...(deps.platform ? { platform: deps.platform } : {}),
  });
  let configError: string | undefined;
  let pluginConfig: Record<string, unknown> | undefined;
  try {
    pluginConfig = readEngineConfig(paths.configPath);
  } catch (error) {
    configError = error instanceof Error ? error.message : 'unreadable';
  }
  const parsed = pluginConfig ? configFromPluginConfig(pluginConfig, { requireResolvedWorkerSecrets: false }) : undefined;
  const remoteMode = parsed ? resolveRemoteAccessMode(parsed.remote) : { mode: 'off' as const };
  const baseUrl = parsed?.email.baseUrl ?? 'http://127.0.0.1:8010/v1';
  const host = readEngineStatusFile(env);
  const relayDir = remoteAccessDirForCli(env);
  const relayStatus = readRemoteAccessStatus(relayDir);
  const relayRunning = relayProcessRunning(relayDir);
  const openclaw = (deps.openclawPath ?? (() => resolveOpenClawExecutable({ env, homeDir })))();
  const worker = await probeWorker(deps.fetchImpl ?? fetch, baseUrl);
  const missing: string[] = [];
  if (!agent.installed) missing.push('The engine agent is not installed: run olympus engine install.');
  else if (agent.state === 'not_loaded') missing.push('The engine agent is installed but not loaded: run olympus engine install.');
  if (!pluginConfig && !configError) missing.push(`${paths.configPath} is missing: run olympus engine install.`);
  if (configError) missing.push(configError);
  if (agent.state === 'running' && !worker.reachable) missing.push('The worker is not answering yet: see olympus engine logs.');
  // The engine's own service health says only that it started the relay;
  // the relay's status file and pid say whether it is running now.
  if (agent.state === 'running' && remoteMode.mode === 'relay' && !relayRunning) {
    missing.push('Remote access is on but the relay process is not running: see olympus engine logs, or run olympus engine restart.');
  }
  return {
    ok: agent.state === 'running' && worker.reachable && !configError && (remoteMode.mode !== 'relay' || relayRunning),
    host: openclaw
      ? { mode: 'standalone', openclaw: 'installed (optional; not used by the engine)', openclaw_path: openclaw }
      : { mode: 'standalone', openclaw: 'not installed (not needed)' },
    agent,
    engine: host ?? null,
    config: {
      path: paths.configPath,
      present: Boolean(pluginConfig),
      remote_mode: remoteMode.mode,
      ...('relayHost' in remoteMode ? { relay_host: remoteMode.relayHost } : {}),
      ...('error' in remoteMode ? { remote_error: remoteMode.error } : {}),
    },
    worker: { base_url: baseUrl, ...worker },
    relay: relayStatus
      ? { mode: relayStatus.mode, running: relayRunning, state: relayStatus.relay?.state ?? null, reason: relayStatus.relay?.reason ?? null, public_base_url: relayStatus.public_base_url ?? null }
      : null,
    analyst: {
      public_personal: 'answered in ChatGPT from evidence returned by the Olympus MCP tools',
      private: 'answered by the configured local model or Venice; never sent to ChatGPT',
    },
    warnings: engineConflictWarnings(homeDir),
    missing,
  };
}

function readEngineStatusFile(env: Record<string, string | undefined>): EngineStatusFile | undefined {
  try {
    const parsed = JSON.parse(readFileSync(engineStatusPath(env), 'utf8')) as EngineStatusFile;
    return parsed?.schema === 'olympus.engine.status.v1' ? parsed : undefined;
  } catch {
    return undefined;
  }
}

async function probeWorker(fetchImpl: typeof fetch, baseUrl: string): Promise<{ reachable: boolean; detail: string }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 1_500);
  try {
    const response = await fetchImpl(`${baseUrl.replace(/\/$/, '')}/health`, { method: 'GET', signal: controller.signal });
    await response.body?.cancel().catch(() => undefined);
    return { reachable: response.ok, detail: `HTTP ${response.status}` };
  } catch {
    return { reachable: false, detail: 'no answer' };
  } finally {
    clearTimeout(timeout);
  }
}

async function followEngineLogs(homeDir: string, lines: number): Promise<void> {
  const paths = enginePaths(homeDir);
  const child = spawn('tail', ['-n', String(lines), '-F', paths.logPath, paths.errorLogPath], { stdio: ['ignore', 'pipe', 'ignore'] });
  const reader = createInterface({ input: child.stdout });
  reader.on('line', (line) => console.log(redactLogLine(line)));
  await new Promise<void>((resolve) => child.once('exit', () => resolve()));
}

/** `--now`: stop or restart even while a zkAPI question is in flight (the default waits, then refuses). */
function parseNowArg(command: string, args: string[]): { now?: boolean } {
  if (args.length === 0) return {};
  if (args.length === 1 && args[0] === '--now') return { now: true };
  throw new OperationError('invalid_params', `Unknown engine ${command} option: ${args.find((arg) => arg !== '--now') ?? args[0]}`);
}

export function parseInstallArgs(args: string[]): { fromCheckout?: string; bunBin?: string; dryRun?: boolean; restart?: boolean; now?: boolean } {
  const options: { fromCheckout?: string; bunBin?: string; dryRun?: boolean; restart?: boolean; now?: boolean } = {};
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg === '--dry-run') options.dryRun = true;
    else if (arg === '--restart') options.restart = true;
    else if (arg === '--now') options.now = true;
    else if (arg === '--from-checkout' || arg === '--bun') {
      const value = args[index + 1];
      if (!value || value.startsWith('--')) throw new OperationError('invalid_params', `${arg} needs a path.`);
      if (arg === '--from-checkout') options.fromCheckout = value;
      else options.bunBin = value;
      index += 1;
    } else if (arg.startsWith('--from-checkout=')) options.fromCheckout = arg.slice('--from-checkout='.length);
    else if (arg.startsWith('--bun=')) options.bunBin = arg.slice('--bun='.length);
    else throw new OperationError('invalid_params', `Unknown engine install option: ${arg}`);
  }
  return options;
}

/** `--expect-package <path>` or `--expect-build <build>`: the build verify must find running. */
export function parseVerifyArgs(args: string[]): { expectPackage?: string; expectedBuild?: string } {
  const options: { expectPackage?: string; expectedBuild?: string } = {};
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    let name: string;
    let value: string | undefined;
    if (arg === '--expect-package' || arg === '--expect-build') {
      name = arg;
      value = args[index + 1];
      index += 1;
    } else if (arg.startsWith('--expect-package=') || arg.startsWith('--expect-build=')) {
      name = arg.slice(0, arg.indexOf('='));
      value = arg.slice(arg.indexOf('=') + 1);
    } else {
      throw new OperationError('invalid_params', `Unknown engine verify option: ${arg}`);
    }
    if (!value || value.startsWith('--')) throw new OperationError('invalid_params', `${name} needs a value.`);
    if (name === '--expect-package') options.expectPackage = value;
    else options.expectedBuild = value;
  }
  return options;
}

export function parseLogsArgs(args: string[]): { lines: number; follow: boolean } {
  let lines = 100;
  let follow = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg === '--follow' || arg === '-f') follow = true;
    else if (arg === '--lines' || arg === '-n') {
      lines = Number(args[index + 1]);
      index += 1;
    } else if (arg.startsWith('--lines=')) lines = Number(arg.slice('--lines='.length));
    else throw new OperationError('invalid_params', `Unknown engine logs option: ${arg}`);
  }
  if (!Number.isSafeInteger(lines) || lines < 1 || lines > 5_000) {
    throw new OperationError('invalid_params', '--lines must be between 1 and 5000.');
  }
  return { lines, follow };
}

function expectNoArgs(command: string, args: string[]): void {
  if (args.length > 0) throw new OperationError('invalid_params', `Unknown engine ${command} option: ${args[0]}`);
}
