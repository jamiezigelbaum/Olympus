import { beginLinuxOpenHandlerMutation, linuxInstalledBuild, linuxLayoutFor, syncLinuxOpenHandlerReceipt, withLinuxEngineLifecycleLockAsync } from './linux-engine-service.ts';
import { workerFetch } from './worker-transport.ts';
/**
 * `olympus engine install|uninstall|status|start|stop|restart|rollback|logs`: the standalone
 * macOS engine's command surface. Mechanics live in engine-service.ts; this
 * file parses arguments and assembles the status report.
 */
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { configFromPluginConfig } from './config.ts';
import { engineBriefReport } from './engine-brief.ts';
import { engineStatusPath, type EngineStatusFile } from './engine-host.ts';
import {
  engineConflictWarnings,
  enginePaths,
  engineServicePaths,
  waitForEngineHealthy,
  inspectEngine,
  installEngineVerified,
  installedEngineHelper,
  installedProgram,
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
import { installEngineHelper, type EngineHelperInstallOptions, type EngineHelperInstallResult } from './engine-helper.ts';
import { installOpenHandler, uninstallOpenHandler, type OpenHandlerOptions, type OpenHandlerResult } from './open-handler.ts';
import { resolveOpenClawExecutable } from './openclaw-executable.ts';
import { OperationError } from './operation-error.ts';
import { readRemoteAccessStatus, relayProcessRunning, remoteAccessDirForCli, resolveRemoteAccessMode } from './remote-access.ts';

export const ENGINE_CLI_USAGE = {
  'engine install': 'olympus engine install [--from-checkout <path>] [--bun <path>] [--restart] [--now] [--dry-run]',
  'engine install-helper': 'olympus engine install-helper [--from <signed app>] [--identity <Developer ID name or SHA-1>]  (restarts an installed engine so it starts through the helper)',
  'engine uninstall': 'olympus engine uninstall',
  'engine status': 'olympus engine status [--brief]',
  'engine start': 'olympus engine start',
  'engine stop': 'olympus engine stop [--now]',
  'engine restart': 'olympus engine restart [--now]',
  'engine rollback': 'olympus engine rollback',
  'engine verify': 'olympus engine verify [--expect-package <path> | --expect-build <build>]',
  'engine logs': 'olympus engine logs [--lines <n>] [--follow]',
} as const;

export interface EngineCliDeps {
  /** Internal reentrant marker: the public Linux lifecycle command already owns kernel custody. */
  lifecycleLocked?: boolean;
  homeDir?: string;
  exec?: EngineExec;
  uid?: number;
  platform?: string;
  env?: Record<string, string | undefined>;
  fetchImpl?: typeof fetch;
  openclawPath?: () => string | undefined;
  /** Test seam: put the signed helper app in place (engine-helper.ts). */
  installHelper?: (options: EngineHelperInstallOptions) => EngineHelperInstallResult;
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
  if((deps.platform??process.platform)==='linux'&&!deps.lifecycleLocked&&['install','uninstall','rollback'].includes(command??'')){
    const layout=linuxLayoutFor(deps);
    return withLinuxEngineLifecycleLockAsync(layout,()=>runEngineCommand(args,{...deps,lifecycleLocked:true}));
  }
  const service = {
    ...(deps.env ? { env: deps.env } : {}),
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
    const linux=(deps.platform ?? process.platform)==='linux';
    const handlerApi=options.dryRun || (linux&&!result.ok)?undefined:openHandlerFor(deps);
    if(linux&&handlerApi)beginLinuxOpenHandlerMutation(service);
    let handler = handlerApi?.install({
      ...openHandlerOptions(deps, service),
      program: { runtimePath: result.program.runtimePath, entryPath: result.program.entryPath, workingDirectory: result.program.workingDirectory },
    });
    if(linux&&handler&&handler.action==='installed'){
      try{syncLinuxOpenHandlerReceipt(service,true);}
      catch(error){openHandlerFor(deps)?.uninstall(openHandlerOptions(deps,service));try{syncLinuxOpenHandlerReceipt(service,false);}catch{}handler={...handler,ok:false,action:'failed',detail:`The Linux handler ownership receipt could not be committed: ${error instanceof Error?error.message:'unknown error'}`};}
    }
    else if(linux&&handlerApi)syncLinuxOpenHandlerReceipt(service,false);
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
  if (command === 'install-helper') {
    const options = parseInstallHelperArgs(rest);
    const helper = (deps.installHelper ?? installEngineHelper)({
      ...(deps.homeDir ? { homeDir: deps.homeDir } : {}),
      ...(deps.platform ? { platform: deps.platform } : {}),
      ...(deps.env ? { env: deps.env } : {}),
      ...(deps.exec ? { exec: deps.exec } : {}),
      ...options,
    });
    // An installed engine is reloaded so its agent starts through the helper.
    const paths = engineServicePaths({ ...service, homeDir: deps.homeDir ?? homedir() });
    if (!existsSync(paths.plistPath)) {
      return { ...helper, engine: 'not_installed', next: 'Run olympus engine install; the engine will start through the Olympus helper app.' };
    }
    // Keep the build and runtime the agent already runs; only its launcher changes.
    const current = installedProgram(paths.plistPath);
    const engine = await installEngineVerified({
      ...service,
      ...(current ? { fromCheckout: dirname(dirname(current.entryPath)), bunBin: current.runtimePath } : {}),
      ...(deps.health ? { health: deps.health } : {}),
    });
    const { plist: _plist, ...summary } = engine;
    return { ...helper, engine: summary, restarted_engine: true, note: 'The engine was restarted so its agent starts through the helper app.', next: engine.ok ? 'Pick a folder under Desktop, Documents or Downloads in the Olympus folder picker; macOS will ask once, in the name of Olympus.' : 'Run olympus engine logs to see why the engine did not become healthy.' };
  }
  if (command === 'verify') {
    return verifyEngine({ ...service, ...parseVerifyArgs(rest), ...(deps.health ? { health: deps.health } : {}) });
  }
  if (command === 'uninstall') {
    expectNoArgs('uninstall', rest);
    const result = uninstallEngine(service);
    const handler = openHandlerFor(deps)?.uninstall(openHandlerOptions(deps, service));
    if((deps.platform??process.platform)==='linux'&&handler?.ok)syncLinuxOpenHandlerReceipt(service,false);
    return handler ? { ...result, open_handler: handler } : result;
  }
  if (command === 'restart') {
    const since = Date.now();
    const result = restartEngine({ ...service, ...parseNowArg('restart', rest) });
    if ((deps.platform ?? process.platform) !== 'linux') return result;
    const health = await waitForEngineHealthy({ paths: engineServicePaths(service), expectedBuild: linuxInstalledBuild(service), since }, { ...deps.health, exec: deps.exec });
    return { ...result, ok: health.ok, health };
  }
  if (command === 'stop') {
    return stopEngine({ ...service, ...parseNowArg('stop', rest) });
  }
  if (command === 'start') {
    expectNoArgs('start', rest);
    const since = Date.now();
    const result = startEngine(service);
    if ((deps.platform ?? process.platform) !== 'linux') return result;
    const health = await waitForEngineHealthy({ paths: engineServicePaths(service), expectedBuild: linuxInstalledBuild(service), ...(result.action === 'already_running' ? {} : { since }) }, { ...deps.health, exec: deps.exec });
    return { ...result, ok: health.ok, health };
  }
  if (command === 'rollback') {
    expectNoArgs('rollback', rest);
    const result=await rollbackEngine({ ...service, ...(deps.health ? { health: deps.health } : {}) });
    if((deps.platform??process.platform)!=='linux'||!result.ok)return result;
    const handlerApi=openHandlerFor(deps);if(handlerApi)beginLinuxOpenHandlerMutation(service);
    let handler=handlerApi?.install({...openHandlerOptions(deps,service),program:{runtimePath:join(dirname(result.app_dir),'runtime/bun'),entryPath:join(result.app_dir,'dist/cli.js'),workingDirectory:result.app_dir}});
    if(handler?.action==='installed'){
      try{syncLinuxOpenHandlerReceipt(service,true);}catch(error){openHandlerFor(deps)?.uninstall(openHandlerOptions(deps,service));try{syncLinuxOpenHandlerReceipt(service,false);}catch{}
       handler={...handler,ok:false,action:'failed',detail:`The Linux handler ownership receipt could not be committed: ${error instanceof Error?error.message:'unknown error'}`};}
    }
    else if(handlerApi)syncLinuxOpenHandlerReceipt(service,false);
    return handler?{...result,open_handler:handler}:result;
  }
  if (command === 'status') {
    // The bar widget's one-line read (engine-brief.ts): no token, no slow checks.
    if (rest.length === 1 && rest[0] === '--brief') return engineBriefReport(deps);
    expectNoArgs('status', rest);
    return engineStatusReport(deps);
  }
  if (command === 'logs') {
    const options = parseLogsArgs(rest);
    if (options.follow) {
      await followEngineLogs(deps, options.lines);
      return undefined;
    }
    return readEngineLogs({ ...service, lines: options.lines });
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
  const paths = engineServicePaths({ ...deps, homeDir });
  const agent = inspectEngine({
    homeDir, env,
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
  const worker = await probeWorker(deps.fetchImpl ?? workerFetch, baseUrl, paths.linux?.workerSocketPath);
  const linuxHealth = paths.linux ? await waitForEngineHealthy({ paths, expectedBuild: linuxInstalledBuild({ ...deps, homeDir }) }, { ...deps.health, timeoutMs: 0, fetchImpl: deps.fetchImpl, exec: deps.exec }) : undefined;
  const missing: string[] = [];
  if (linuxHealth && !linuxHealth.ok) missing.push(linuxHealth.reason ?? 'Linux engine health is unknown.');
  if (!agent.installed) missing.push('The engine agent is not installed: run olympus engine install.');
  else if (agent.state === 'not_loaded') missing.push('The engine agent is installed but not loaded: run olympus engine install.');
  if (!pluginConfig && !configError) missing.push(`${paths.configPath} is missing: run olympus engine install.`);
  if (configError) missing.push(configError);
  // macOS: the signed helper app is what the Mac names when it asks about Desktop, Documents and the like.
  const helperPath = paths.linux ? undefined : installedEngineHelper(paths);
  const helperInUse = Boolean(installedProgram(paths.plistPath)?.helperPath);
  if (helperPath && agent.installed && !helperInUse) missing.push('The Olympus helper app is installed but the engine agent does not use it yet: run olympus engine install.');
  if (agent.state === 'running' && !worker.reachable) missing.push('The worker is not answering yet: see olympus engine logs.');
  // The engine's own service health says only that it started the relay;
  // the relay's status file and pid say whether it is running now.
  if (agent.state === 'running' && remoteMode.mode === 'relay' && !relayRunning) {
    missing.push('Remote access is on but the relay process is not running: see olympus engine logs, or run olympus engine restart.');
  }
  return {
    ok: (!linuxHealth || linuxHealth.ok) && agent.state === 'running' && worker.reachable && !configError && (remoteMode.mode !== 'relay' || relayRunning),
    host: openclaw
      ? { mode: 'standalone', openclaw: 'installed (optional; not used by the engine)', openclaw_path: openclaw }
      : { mode: 'standalone', openclaw: 'not installed (not needed)' },
    agent,
    ...(paths.linux ? {} : { helper: { installed: Boolean(helperPath), in_use: helperInUse, ...(paths.helperAppPath ? { path: paths.helperAppPath } : {}) } }),
    engine: host ?? null,
    config: {
      path: paths.configPath,
      present: Boolean(pluginConfig),
      remote_mode: remoteMode.mode,
      ...('relayHost' in remoteMode ? { relay_host: remoteMode.relayHost } : {}),
      ...('error' in remoteMode ? { remote_error: remoteMode.error } : {}),
    },
    worker: { base_url: baseUrl, ...worker },
    ...(worker.update_available ? { update_available: worker.update_available } : {}),
    relay: relayStatus
      ? { mode: relayStatus.mode, running: relayRunning, state: relayStatus.relay?.state ?? null, reason: relayStatus.relay?.reason ?? null, public_base_url: relayStatus.public_base_url ?? null }
      : null,
    analyst: {
      public_personal: 'answered in ChatGPT from evidence returned by the Olympus MCP tools',
      private: 'answered by the configured local model or Venice; never sent to ChatGPT',
    },
    warnings: engineConflictWarnings(homeDir, deps.platform ?? process.platform, env),
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

async function probeWorker(fetchImpl: typeof fetch, baseUrl: string, socket?: string): Promise<{ reachable: boolean; detail: string; built_in_models?: unknown; desktop_bridge?: unknown; update_available?: { version: string } }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 1_500);
  try {
    const response = await fetchImpl(`${baseUrl.replace(/\/$/, '')}/health`, { method: 'GET', signal: controller.signal, ...(socket ? { unix: socket } : {}) });
    const health = response.ok ? await response.json().catch(() => undefined) as { built_in_models?: unknown; desktop_bridge?: unknown; update_available?: { version?: unknown } } : undefined;
    await response.body?.cancel().catch(() => undefined);
    return { reachable: response.ok, detail: `HTTP ${response.status}`, ...(health?.built_in_models ? { built_in_models: health.built_in_models } : {}), ...(health?.desktop_bridge ? { desktop_bridge: health.desktop_bridge } : {}), ...(typeof health?.update_available?.version === 'string' ? { update_available: { version: health.update_available.version } } : {}) };
  } catch {
    return { reachable: false, detail: 'no answer' };
  } finally {
    clearTimeout(timeout);
  }
}

async function followEngineLogs(deps: EngineCliDeps, lines: number): Promise<void> {
  const paths = engineServicePaths(deps);
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

export function parseInstallHelperArgs(args: string[]): { from?: string; identity?: string } {
  const options: { from?: string; identity?: string } = {};
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg === '--from' || arg === '--identity') {
      const value = args[index + 1];
      if (!value || value.startsWith('--')) throw new OperationError('invalid_params', `${arg} needs a value.`);
      if (arg === '--from') options.from = value;
      else options.identity = value;
      index += 1;
    } else throw new OperationError('invalid_params', `Unknown engine install-helper option: ${arg}`);
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
