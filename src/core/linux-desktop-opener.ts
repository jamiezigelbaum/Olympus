import { accessSync, constants as fsConstants, lstatSync, realpathSync, type BigIntStats } from 'node:fs';
import { execFile, spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { dirname, extname, isAbsolute, join } from 'node:path';
import { OPENABLE_EXTENSIONS, localOpenArguments } from '../workers/dropbox-files/open-target.ts';

const SYSTEMCTL = '/usr/bin/systemctl';
const SYSTEMD_RUN = '/usr/bin/systemd-run';
const XDG_OPEN = '/usr/bin/xdg-open';
const XDG_MIME = '/usr/bin/xdg-mime';
const FILE = '/usr/bin/file';
const COMMAND_TIMEOUT_MS = 3_000;
const LAUNCH_OBSERVATION_MS = 3_000;
// `systemctl --user show-environment` exceeds 4 KiB on a stock Omarchy desktop (6.2 KiB measured).
const MAX_COMMAND_OUTPUT = 65_536;

export interface LinuxDesktopExecutables {
  systemctl: string;
  systemdRun: string;
  xdgOpen: string;
  xdgMime: string;
  file: string;
}

const DEFAULT_EXECUTABLES: LinuxDesktopExecutables = {
  systemctl: SYSTEMCTL,
  systemdRun: SYSTEMD_RUN,
  xdgOpen: XDG_OPEN,
  xdgMime: XDG_MIME,
  file: FILE,
};

export interface LinuxCommandResult {
  status: number | null;
  stdout: string;
  stderr: string;
  timedOut?: boolean;
}

export interface LinuxPathInspection {
  kind: 'directory' | 'file' | 'socket' | 'other';
  uid: number;
  mode: number;
  symbolicLink: boolean;
}

export interface LinuxGraphicalSession {
  ready: true;
  kind: 'wayland' | 'x11';
  environment: Readonly<Record<string, string>>;
  displaySocket: string;
}

export interface LinuxGraphicalSessionUnavailable {
  ready: false;
  reason: 'untrusted_systemctl' | 'inactive_graphical_session' | 'manager_environment_unavailable' | 'unsafe_runtime_directory' | 'unsupported_desktop' | 'stale_display';
}

export type LinuxGraphicalSessionReadiness = LinuxGraphicalSession | LinuxGraphicalSessionUnavailable;

export interface LinuxGraphicalSessionDependencies {
  executables?: Partial<LinuxDesktopExecutables>;
  runSync?: (argv: readonly string[], timeoutMs: number) => LinuxCommandResult;
  inspectPath?: (path: string) => LinuxPathInspection | undefined;
  realpath?: (path: string) => string | undefined;
  trustExecutable?: (path: string) => boolean;
  uid?: number;
}

/**
 * Reads the current graphical session from the user manager on every call.
 * The engine's inherited DISPLAY is deliberately not consulted: a lingering
 * engine can predate login or outlive the display it inherited.
 */
export function linuxGraphicalSessionReadiness(
  dependencies: LinuxGraphicalSessionDependencies = {},
): LinuxGraphicalSessionReadiness {
  const executables = { ...DEFAULT_EXECUTABLES, ...dependencies.executables };
  const trustExecutable = dependencies.trustExecutable ?? isTrustedExecutable;
  if (!absoluteExecutables(executables) || !trustExecutable(executables.systemctl)) {
    return { ready: false, reason: 'untrusted_systemctl' };
  }
  const runSync = dependencies.runSync ?? runCommandSync;
  const active = runSync([executables.systemctl, '--user', 'is-active', 'graphical-session.target'], COMMAND_TIMEOUT_MS);
  if (active.status !== 0 || active.timedOut === true || active.stdout.trim() !== 'active') {
    return { ready: false, reason: 'inactive_graphical_session' };
  }
  const shown = runSync([executables.systemctl, '--user', 'show-environment'], COMMAND_TIMEOUT_MS);
  if (shown.status !== 0 || shown.timedOut === true) {
    return { ready: false, reason: 'manager_environment_unavailable' };
  }
  const manager = parseManagerEnvironment(shown.stdout);
  const uid = dependencies.uid ?? (typeof process.getuid === 'function' ? process.getuid() : -1);
  const inspectPath = dependencies.inspectPath ?? inspectLinuxPath;
  const runtime = manager.XDG_RUNTIME_DIR;
  if (!runtime || !isAbsolute(runtime) || runtime.includes('\0') || runtime.includes('\n') || runtime.includes('\r')) {
    return { ready: false, reason: 'unsafe_runtime_directory' };
  }
  const runtimeInfo = inspectPath(runtime);
  const resolveRealpath = dependencies.realpath ?? resolvedRealpath;
  if (resolveRealpath(runtime) !== runtime || !runtimeInfo || runtimeInfo.symbolicLink || runtimeInfo.kind !== 'directory' || runtimeInfo.uid !== uid || (runtimeInfo.mode & 0o077) !== 0) {
    return { ready: false, reason: 'unsafe_runtime_directory' };
  }

  const desktop = manager.XDG_CURRENT_DESKTOP;
  if (!desktop?.split(':').some((name) => /^(?:gnome|hyprland)$/i.test(name))) {
    return { ready: false, reason: 'unsupported_desktop' };
  }

  const baseEnvironment = sanitizedDesktopEnvironment(manager, runtime, uid, inspectPath);
  const wayland = manager.WAYLAND_DISPLAY;
  if (wayland && /^[A-Za-z0-9_.-]{1,128}$/.test(wayland)) {
    const socket = join(runtime, wayland);
    const socketInfo = inspectPath(socket);
    if (resolveRealpath(socket) === socket && socketInfo && !socketInfo.symbolicLink && socketInfo.kind === 'socket' && socketInfo.uid === uid) {
      return {
        ready: true,
        kind: 'wayland',
        environment: { ...baseEnvironment, XDG_RUNTIME_DIR: runtime, WAYLAND_DISPLAY: wayland },
        displaySocket: socket,
      };
    }
  }

  const display = manager.DISPLAY;
  const displayMatch = display?.match(/^(?:(?:unix)?)(?::)(\d{1,4})(?:\.\d+)?$/);
  if (display && displayMatch) {
    const socket = `/tmp/.X11-unix/X${Number(displayMatch[1])}`;
    const socketInfo = inspectPath(socket);
    if (resolveRealpath(socket) === socket && socketInfo && !socketInfo.symbolicLink && socketInfo.kind === 'socket' && (socketInfo.uid === uid || socketInfo.uid === 0)) {
      return {
        ready: true,
        kind: 'x11',
        environment: { ...baseEnvironment, XDG_RUNTIME_DIR: runtime, DISPLAY: display },
        displaySocket: socket,
      };
    }
  }
  return { ready: false, reason: 'stale_display' };
}

/** Same readiness contract without blocking the worker event loop. The HTTP
 * bridge uses a coalesced observer, never a subprocess for each request. */
export async function linuxGraphicalSessionReadinessAsync(dependencies: LinuxDesktopOpenerDependencies = {}): Promise<LinuxGraphicalSessionReadiness> {
  const executables = { ...DEFAULT_EXECUTABLES, ...dependencies.executables };
  if (!absoluteExecutables(executables) || !(dependencies.trustExecutable ?? isTrustedExecutable)(executables.systemctl)) return { ready: false, reason: 'untrusted_systemctl' };
  const run = dependencies.run ?? runCommand;
  const options = { timeoutMs: COMMAND_TIMEOUT_MS, env: process.env as Record<string, string> };
  const active = await run([executables.systemctl, '--user', 'is-active', 'graphical-session.target'], options);
  if (!successfulProbe(active) || active.stdout.trim() !== 'active') return { ready: false, reason: 'inactive_graphical_session' };
  const shown = await run([executables.systemctl, '--user', 'show-environment'], options);
  return linuxGraphicalSessionReadiness({ ...dependencies, runSync: argv => argv.includes('is-active') ? active : shown });
}

export type LinuxDesktopOpenErrorCode =
  | 'desktop_unavailable'
  | 'untrusted_executable'
  | 'invalid_target'
  | 'target_changed'
  | 'eligibility_revoked'
  | 'dispatch_failed';

export class LinuxDesktopOpenError extends Error {
  constructor(readonly code: LinuxDesktopOpenErrorCode, message: string) {
    super(message);
    this.name = 'LinuxDesktopOpenError';
  }
}

export interface LinuxDesktopOpenResult {
  opened: 'file' | 'folder';
  path: string;
  /** Why an otherwise valid file was reduced to opening its folder. */
  fallback?: 'unsupported_extension' | 'mime_probe_failed' | 'mime_mismatch';
  mimeType?: string;
}

export interface LinuxDesktopOpenerDependencies extends LinuxGraphicalSessionDependencies {
  readiness?: () => LinuxGraphicalSessionReadiness;
  run?: (argv: readonly string[], options: { timeoutMs: number; env: Readonly<Record<string, string>> }) => Promise<LinuxCommandResult>;
  launch?: (argv: readonly string[], options: { observeMs: number; env: Readonly<Record<string, string>>; scopeUnit: string; systemctl: string }) => Promise<LinuxScopeLaunchResult>;
  scopeUnit?: () => string;
}

export interface LinuxScopeLaunchResult {
  established: boolean;
  stderr: string;
}

export function isActiveLinuxScope(output: string, scopeUnit: string): boolean {
  if (!/^olympus-open-[a-z0-9-]{1,80}$/.test(scopeUnit)) return false;
  const fields = new Map<string, string>();
  for (const line of output.trim().split(/\r?\n/)) {
    const separator = line.indexOf('=');
    if (separator <= 0) continue;
    fields.set(line.slice(0, separator), line.slice(separator + 1));
  }
  const controlGroup = fields.get('ControlGroup');
  return fields.get('ActiveState') === 'active'
    && typeof controlGroup === 'string'
    && controlGroup.startsWith('/')
    && controlGroup.endsWith(`/${scopeUnit}.scope`)
    && !/[\0\r\n]/.test(controlGroup);
}

export interface LinuxDesktopOpenInput {
  path: string;
  roots: readonly string[];
  /** Rechecks the private/unreadable capability immediately before dispatch. */
  revalidateEligibility: () => boolean | Promise<boolean>;
  dependencies?: LinuxDesktopOpenerDependencies;
}

/**
 * Opens one already-authorized local source on Linux. Callers retain their
 * capability/eligibility policy; this adapter revalidates the target after each awaited preparation step.
 */
export async function openLinuxDesktopPath(input: LinuxDesktopOpenInput): Promise<LinuxDesktopOpenResult> {
  const dependencies = input.dependencies ?? {};
  const executables = { ...DEFAULT_EXECUTABLES, ...dependencies.executables };
  const trustExecutable = dependencies.trustExecutable ?? isTrustedExecutable;
  if (!absoluteExecutables(executables) || ![executables.systemctl, executables.systemdRun, executables.xdgOpen, executables.xdgMime, executables.file].every(trustExecutable)) {
    throw new LinuxDesktopOpenError('untrusted_executable', 'Linux desktop opening requires trusted absolute system executables.');
  }
  const readReadiness = (): LinuxGraphicalSessionReadiness => dependencies.readiness?.() ?? linuxGraphicalSessionReadiness(dependencies);
  const readiness = readReadiness();
  if (!readiness.ready) {
    throw new LinuxDesktopOpenError('desktop_unavailable', `No live graphical session is available (${readiness.reason}). Start a systemd-integrated GNOME/Hyprland session or use the remote panel/provider preview.`);
  }
  const original = validateOpenTarget(input.path, input.roots);
  if (!original) throw new LinuxDesktopOpenError('invalid_target', 'The local source is no longer a regular file inside an approved root.');

  if (!await input.revalidateEligibility()) {
    throw new LinuxDesktopOpenError('eligibility_revoked', 'The source is no longer eligible to open.');
  }
  assertSameGraphicalSession(readiness, readReadiness());
  assertUnchanged(input.path, input.roots, original);

  const run = dependencies.run ?? runCommand;
  let fallback: LinuxDesktopOpenResult['fallback'];
  let mimeType: string | undefined;
  if (!original.openable) {
    fallback = 'unsupported_extension';
  } else {
    const mimeFromDesktop = await run(
      [executables.xdgMime, 'query', 'filetype', input.path],
      { timeoutMs: COMMAND_TIMEOUT_MS, env: readiness.environment },
    );
    assertSameGraphicalSession(readiness, readReadiness());
    assertUnchanged(input.path, input.roots, original);
    const mimeFromFile = await run(
      [executables.file, '--brief', '--mime-type', '--', input.path],
      { timeoutMs: COMMAND_TIMEOUT_MS, env: readiness.environment },
    );
    assertSameGraphicalSession(readiness, readReadiness());
    assertUnchanged(input.path, input.roots, original);
    if (!successfulProbe(mimeFromDesktop) || !successfulProbe(mimeFromFile)) {
      fallback = 'mime_probe_failed';
    } else {
      const desktopMime = normalizedMime(mimeFromDesktop.stdout);
      const fileMime = normalizedMime(mimeFromFile.stdout);
      const expected = EXPECTED_MIME_TYPES[original.extension];
      if (!desktopMime || !fileMime || !expected?.has(desktopMime) || !expected.has(fileMime)) {
        fallback = 'mime_mismatch';
      } else {
        mimeType = fileMime;
      }
    }
  }

  if (!await input.revalidateEligibility()) {
    throw new LinuxDesktopOpenError('eligibility_revoked', 'The source is no longer eligible to open.');
  }
  assertSameGraphicalSession(readiness, readReadiness());
  const current = assertUnchanged(input.path, input.roots, original);
  const dispatchPath = fallback ? current.parentPath : input.path;
  if (fallback) assertParentUnchanged(current.parentPath, original.parentIdentity);

  const launch = dependencies.launch ?? launchInUserScope;
  const scopeUnit = dependencies.scopeUnit?.() ?? `olympus-open-${process.pid}-${randomBytes(8).toString('hex')}`;
  if (!/^olympus-open-[a-z0-9-]{1,80}$/.test(scopeUnit)) {
    throw new LinuxDesktopOpenError('dispatch_failed', 'The desktop opener could not allocate a safe scope name.');
  }
  const launched = await launch(
    [executables.systemdRun, '--user', '--scope', `--unit=${scopeUnit}`, '--', executables.xdgOpen, dispatchPath],
    { observeMs: LAUNCH_OBSERVATION_MS, env: readiness.environment, scopeUnit, systemctl: executables.systemctl },
  );
  if (!launched.established) {
    throw new LinuxDesktopOpenError('dispatch_failed', 'The desktop opener could not start a viewer.');
  }
  return fallback
    ? { opened: 'folder', path: dispatchPath, fallback }
    : { opened: 'file', path: dispatchPath, ...(mimeType ? { mimeType } : {}) };
}

/** Explicit extension-to-content contract. Both MIME probes must land here. */
export const EXPECTED_MIME_TYPES: Readonly<Record<string, ReadonlySet<string>>> = Object.freeze({
  pdf: mime('application/pdf'),
  txt: mime('text/plain'), md: mime('text/markdown', 'text/plain'), markdown: mime('text/markdown', 'text/plain'),
  rtf: mime('application/rtf', 'text/rtf'), csv: mime('text/csv', 'text/plain'), tsv: mime('text/tab-separated-values', 'text/plain'),
  epub: mime('application/epub+zip'),
  doc: mime('application/msword'), docx: mime('application/vnd.openxmlformats-officedocument.wordprocessingml.document'),
  xls: mime('application/vnd.ms-excel'), xlsx: mime('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'),
  ppt: mime('application/vnd.ms-powerpoint'), pptx: mime('application/vnd.openxmlformats-officedocument.presentationml.presentation'),
  odt: mime('application/vnd.oasis.opendocument.text'), ods: mime('application/vnd.oasis.opendocument.spreadsheet'),
  odp: mime('application/vnd.oasis.opendocument.presentation'),
  pages: mime('application/vnd.apple.pages', 'application/x-iwork-pages-sffpages'),
  numbers: mime('application/vnd.apple.numbers', 'application/x-iwork-numbers-sffnumbers'),
  key: mime('application/vnd.apple.keynote', 'application/x-iwork-keynote-sffkey'),
  png: mime('image/png'), jpg: mime('image/jpeg'), jpeg: mime('image/jpeg'), gif: mime('image/gif'),
  heic: mime('image/heic', 'image/heif'), heif: mime('image/heif', 'image/heic'), tif: mime('image/tiff'), tiff: mime('image/tiff'),
  bmp: mime('image/bmp', 'image/x-ms-bmp'), webp: mime('image/webp'),
  mp3: mime('audio/mpeg'), m4a: mime('audio/mp4', 'audio/x-m4a'), aac: mime('audio/aac', 'audio/x-aac'),
  wav: mime('audio/wav', 'audio/x-wav'), aiff: mime('audio/aiff', 'audio/x-aiff'), aif: mime('audio/aiff', 'audio/x-aiff'),
  flac: mime('audio/flac', 'audio/x-flac'), mp4: mime('video/mp4'), m4v: mime('video/x-m4v', 'video/mp4'), mov: mime('video/quicktime'),
});

interface ValidatedOpenTarget {
  identity: FileIdentity;
  parentIdentity: FileIdentity;
  parentPath: string;
  extension: string;
  openable: boolean;
}

interface FileIdentity {
  dev: bigint;
  ino: bigint;
  size: bigint;
  mtimeNs: bigint;
  ctimeNs: bigint;
}

function validateOpenTarget(path: string, roots: readonly string[]): ValidatedOpenTarget | undefined {
  if (/[\0\r\n]/.test(path)) return undefined;
  const argumentsForMac = localOpenArguments(path, roots);
  if (!argumentsForMac) return undefined;
  const parentPath = dirname(path);
  try {
    if (realpathSync.native(parentPath) !== parentPath) return undefined;
    const file = lstatSync(path, { bigint: true });
    const parent = lstatSync(parentPath, { bigint: true });
    if (!file.isFile() || file.isSymbolicLink() || !parent.isDirectory() || parent.isSymbolicLink()) return undefined;
    const extension = extname(path).slice(1).toLowerCase();
    return {
      identity: identity(file),
      parentIdentity: identity(parent),
      parentPath,
      extension,
      openable: argumentsForMac.length === 1 && OPENABLE_EXTENSIONS.has(extension),
    };
  } catch {
    return undefined;
  }
}

function assertUnchanged(path: string, roots: readonly string[], original: ValidatedOpenTarget): ValidatedOpenTarget {
  const current = validateOpenTarget(path, roots);
  if (!current || !sameIdentity(current.identity, original.identity) || current.parentPath !== original.parentPath || !sameIdentity(current.parentIdentity, original.parentIdentity)) {
    throw new LinuxDesktopOpenError('target_changed', 'The local source changed while it was being checked.');
  }
  return current;
}

function assertParentUnchanged(path: string, expected: FileIdentity): void {
  try {
    const current = lstatSync(path, { bigint: true });
    if (!current.isDirectory() || current.isSymbolicLink() || realpathSync.native(path) !== path || !sameIdentity(identity(current), expected)) throw new Error('changed');
  } catch {
    throw new LinuxDesktopOpenError('target_changed', 'The source folder changed while it was being checked.');
  }
}

function identity(stats: BigIntStats): FileIdentity {
  return { dev: stats.dev, ino: stats.ino, size: stats.size, mtimeNs: stats.mtimeNs, ctimeNs: stats.ctimeNs };
}

function sameIdentity(left: FileIdentity, right: FileIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size && left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs;
}

function assertSameGraphicalSession(expected: LinuxGraphicalSession, current: LinuxGraphicalSessionReadiness): void {
  if (!current.ready
    || current.kind !== expected.kind
    || current.displaySocket !== expected.displaySocket
    || !sameEnvironment(current.environment, expected.environment)) {
    throw new LinuxDesktopOpenError('desktop_unavailable', 'The graphical session changed while the source was being checked.');
  }
}

function sameEnvironment(left: Readonly<Record<string, string>>, right: Readonly<Record<string, string>>): boolean {
  const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
  return [...keys].every((key) => left[key] === right[key]);
}

function parseManagerEnvironment(output: string): Record<string, string> {
  const allowed = new Set([
    'XDG_RUNTIME_DIR', 'WAYLAND_DISPLAY', 'DISPLAY', 'DBUS_SESSION_BUS_ADDRESS', 'XAUTHORITY',
    'XDG_CURRENT_DESKTOP', 'XDG_SESSION_DESKTOP', 'XDG_SESSION_TYPE', 'HOME', 'USER', 'LOGNAME',
    'LANG', 'LC_ALL', 'LC_CTYPE',
  ]);
  const parsed: Record<string, string> = {};
  for (const line of output.split('\n')) {
    const separator = line.indexOf('=');
    if (separator <= 0) continue;
    const key = line.slice(0, separator);
    const value = line.slice(separator + 1);
    if (allowed.has(key) && value.length <= 4_096 && !/[\0\r\n]/.test(value)) parsed[key] = value;
  }
  return parsed;
}

function sanitizedDesktopEnvironment(
  manager: Readonly<Record<string, string>>,
  runtime: string,
  uid: number,
  inspectPath: (path: string) => LinuxPathInspection | undefined,
): Record<string, string> {
  const environment: Record<string, string> = { PATH: '/usr/bin:/bin' };
  const safeText = /^(?:[A-Za-z0-9_.@+,:/ -]){1,512}$/;
  for (const key of ['XDG_CURRENT_DESKTOP', 'XDG_SESSION_DESKTOP', 'XDG_SESSION_TYPE', 'USER', 'LOGNAME', 'LANG', 'LC_ALL', 'LC_CTYPE'] as const) {
    const value = manager[key];
    if (value && safeText.test(value)) environment[key] = value;
  }
  const home = manager.HOME;
  if (home && isAbsolute(home) && !/[\0\r\n]/.test(home)) environment.HOME = home;
  const bus = manager.DBUS_SESSION_BUS_ADDRESS;
  if (bus === `unix:path=${join(runtime, 'bus')}`) environment.DBUS_SESSION_BUS_ADDRESS = bus;
  const authority = manager.XAUTHORITY;
  if (authority && isAbsolute(authority)) {
    const info = inspectPath(authority);
    if (info && !info.symbolicLink && info.kind === 'file' && info.uid === uid) environment.XAUTHORITY = authority;
  }
  return environment;
}

function inspectLinuxPath(path: string): LinuxPathInspection | undefined {
  try {
    const stat = lstatSync(path);
    return {
      kind: stat.isDirectory() ? 'directory' : stat.isFile() ? 'file' : stat.isSocket() ? 'socket' : 'other',
      uid: stat.uid,
      mode: stat.mode,
      symbolicLink: stat.isSymbolicLink(),
    };
  } catch {
    return undefined;
  }
}

function resolvedRealpath(path: string): string | undefined {
  try {
    return realpathSync.native(path);
  } catch {
    return undefined;
  }
}

function isTrustedExecutable(path: string): boolean {
  if (!isAbsolute(path)) return false;
  try {
    accessSync(path, fsConstants.X_OK);
    const stat = lstatSync(path);
    const uid = typeof process.getuid === 'function' ? process.getuid() : -1;
    return stat.isFile() && !stat.isSymbolicLink() && (stat.uid === 0 || stat.uid === uid) && (stat.mode & 0o022) === 0;
  } catch {
    return false;
  }
}

function absoluteExecutables(executables: LinuxDesktopExecutables): boolean {
  return Object.values(executables).every((path) => isAbsolute(path) && !/[\0\r\n]/.test(path));
}

function runCommandSync(argv: readonly string[], timeoutMs: number): LinuxCommandResult {
  const result = spawnSync(argv[0]!, argv.slice(1), { encoding: 'utf8', timeout: timeoutMs, maxBuffer: MAX_COMMAND_OUTPUT });
  return {
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    ...(result.error && (result.error as NodeJS.ErrnoException).code === 'ETIMEDOUT' ? { timedOut: true } : {}),
  };
}

function runCommand(
  argv: readonly string[],
  options: { timeoutMs: number; env: Readonly<Record<string, string>> },
): Promise<LinuxCommandResult> {
  return new Promise((resolve) => {
    execFile(argv[0]!, argv.slice(1), {
      encoding: 'utf8', timeout: options.timeoutMs, maxBuffer: MAX_COMMAND_OUTPUT, env: { ...options.env }, windowsHide: true,
    }, (error, stdout, stderr) => {
      const failure = error as { code?: string | number; killed?: boolean } | null;
      const status = typeof failure?.code === 'number' ? failure.code : failure ? null : 0;
      resolve({ status, stdout, stderr, ...(failure?.killed === true ? { timedOut: true } : {}) });
    });
  });
}

function launchInUserScope(
  argv: readonly string[],
  options: { observeMs: number; env: Readonly<Record<string, string>>; scopeUnit: string; systemctl: string },
): Promise<LinuxScopeLaunchResult> {
  return new Promise((resolve) => {
    let settled = false;
    let exited = false;
    let overallTimer: ReturnType<typeof setTimeout> | undefined;
    const child = spawn(argv[0]!, argv.slice(1), {
      detached: true, stdio: 'ignore', env: { ...options.env }, windowsHide: true,
    });
    const finish = (result: LinuxScopeLaunchResult): void => {
      if (settled) return;
      settled = true;
      if (overallTimer) clearTimeout(overallTimer);
      child.unref();
      resolve(result);
    };
    child.once('error', (error) => finish({ established: false, stderr: error.message }));
    child.once('exit', (code) => {
      exited = true;
      finish({ established: code === 0, stderr: '' });
    });
    const verifyScope = async (): Promise<void> => {
      if (settled || exited) return;
      const shown = await runCommand([
        options.systemctl, '--user', 'show', `${options.scopeUnit}.scope`,
        '--property=ActiveState', '--property=ControlGroup',
      ], { timeoutMs: COMMAND_TIMEOUT_MS, env: options.env });
      if (settled || exited) return;
      if (shown.status === 0 && shown.timedOut !== true && isActiveLinuxScope(shown.stdout, options.scopeUnit)) {
        finish({ established: true, stderr: '' });
        return;
      }
      const retry = setTimeout(() => { void verifyScope(); }, 50);
      retry.unref();
    };
    child.once('spawn', () => { void verifyScope(); });
    overallTimer = setTimeout(() => {
      finish({ established: false, stderr: 'systemd scope was not confirmed before the launch deadline' });
    }, options.observeMs);
    overallTimer.unref();
  });
}

function successfulProbe(result: LinuxCommandResult): boolean {
  return result.status === 0 && result.timedOut !== true;
}

function normalizedMime(value: string): string | undefined {
  const normalized = value.trim().toLowerCase();
  return /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/.test(normalized) ? normalized : undefined;
}

function mime(...values: string[]): ReadonlySet<string> {
  return new Set(values);
}

for (const extension of OPENABLE_EXTENSIONS) {
  if (!EXPECTED_MIME_TYPES[extension]) throw new Error(`Missing Linux MIME contract for .${extension}`);
}

/** Only engine-generated private ticket HTML may use this opener. Source files
 * still use openLinuxDesktopPath and its MIME/eligibility checks. */
export async function openLinuxOwnerTicketFile(path: string, dependencies: LinuxDesktopOpenerDependencies = {}): Promise<void> {
  const executables = { ...DEFAULT_EXECUTABLES, ...dependencies.executables };
  const trusted = dependencies.trustExecutable ?? isTrustedExecutable;
  if (![executables.systemctl, executables.systemdRun, executables.xdgOpen].every(trusted)) throw new Error('Trusted desktop opener unavailable.');
  const readiness = dependencies.readiness?.() ?? linuxGraphicalSessionReadiness(dependencies);
  if (!readiness.ready) throw new Error('No live graphical session.');
  const runtime = readiness.environment.XDG_RUNTIME_DIR;
  if (!runtime || dirname(path) !== `${runtime}/olympus` || !/^owner-ticket-[a-f0-9]{32}\.html$/.test(path.slice(dirname(path).length + 1))) throw new Error('Invalid owner ticket path.');
  const stat = lstatSync(path);
  const parent = lstatSync(dirname(path));
  const uid = dependencies.uid ?? process.getuid?.();
  if (realpathSync(path) !== path || !stat.isFile() || stat.isSymbolicLink() || stat.uid !== uid || (stat.mode & 0o777) !== 0o600
    || !parent.isDirectory() || parent.isSymbolicLink() || parent.uid !== uid || (parent.mode & 0o777) !== 0o700) throw new Error('Unsafe owner ticket file.');
  const scopeUnit = `olympus-open-${process.pid}-${randomBytes(8).toString('hex')}`;
  const result = await (dependencies.launch ?? launchInUserScope)(
    [executables.systemdRun, '--user', '--scope', `--unit=${scopeUnit}`, '--', executables.xdgOpen, path],
    { observeMs: LAUNCH_OBSERVATION_MS, env: readiness.environment, scopeUnit, systemctl: executables.systemctl },
  );
  if (!result.established) throw new Error('Desktop browser did not open the owner ticket.');
}
