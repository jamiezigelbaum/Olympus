/**
 * The local command seam.
 *
 * Every extractor that shells out to a local binary goes through this type, and
 * every test injects a fake in its place. The landed `ExtractorRegistryConfig`
 * carries no command-runner field on purpose: injection points are extra
 * optional constructor options on each factory, not additions to the shared
 * seam.
 *
 * Ported from the production lane's command runner. Two properties are
 * load-bearing and were preserved exactly:
 *
 *   - A non-zero exit rejects with a structured error carrying the command,
 *     the exit code and both streams, because the deterministic-rejection
 *     classifier reads all four.
 *   - A stall (no output and no CPU use for the request's window) SIGKILLs
 *     the child and rejects; it never resolves with whatever partial output
 *     had arrived. Work that keeps progressing is never cut.
 *
 * One property was added after the 2026-09-08 sparta incident: the child is
 * spawned DETACHED, as the leader of its own process group, and a timeout
 * kills that whole group. The old runner killed only the direct child. Every
 * transcription command is a shell wrapper around a `whisper` python process,
 * so the SIGKILL reaped the wrapper and orphaned the grandchild, which kept
 * burning four to seven cores for hours after the extractor had already
 * reported a timeout. Seven of them took a sixteen-core host to load 60.
 *
 * Doc comments in this directory are always multi-line blocks: the
 * architecture guard reads a single-line block comment as a regex literal.
 */

import { addMemoryPayloadText, memoryPayloadByteCounter } from '../../../core/memory-counters.ts';
import { Buffer } from 'node:buffer';
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { readFile, readdir } from 'node:fs/promises';
import { promisify } from 'node:util';
import { accessSync, constants as fsConstants, statSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { descendantGroupsRecorder, descendantGroupsSupported } from '../../../core/descendant-groups.ts';
import { DESCENDANT_GROUPS_ENV } from '../../../core/native-process-service.ts';

export interface ExtractionCommandRunRequest {
  command: string;
  args: string[];
  /**
   * The stall window, not a total clock (owner rule, 16 Nov 2026: work that is
   * still progressing is never cancelled). The command is killed only after it
   * has made no progress for this long: no new output on either stream and no
   * CPU time used by any process in its group. A big scan or a long recording
   * that keeps working runs to the end.
   */
  timeoutMs: number;
  /**
   * Extra environment for the child, laid over the process environment.
   * Absent leaves the child with the process environment exactly as before.
   */
  env?: Readonly<Record<string, string>>;
}

export interface ExtractionCommandRunResult {
  stdout: string;
  stderr: string;
}

export type ExtractionCommandRunner = (
  request: ExtractionCommandRunRequest,
) => Promise<ExtractionCommandRunResult>;

/**
 * A local command exited non-zero. Carries both streams so a caller can
 * classify the failure; callers must never copy any of it into `errorKind` or
 * `warnings`, which are bounded categorical tokens.
 */
export class ExtractionCommandError extends Error {
  readonly command: string;
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;

  constructor(input: {
    command: string;
    exitCode: number | null;
    stdout: string;
    stderr: string;
  }) {
    super(input.exitCode === null
      ? `${input.command} exited without an exit code.`
      : `${input.command} exited with status ${input.exitCode}.`);
    this.name = 'ExtractionCommandError';
    this.command = input.command;
    this.exitCode = input.exitCode;
    this.stdout = input.stdout;
    this.stderr = input.stderr;
  }
}

/**
 * A local command exceeded its timeout and was killed.
 *
 * The production lane threw a bare `Error` here. It is a distinct class now
 * only so an extractor can map it onto its own bounded `errorKind` without
 * pattern-matching a message string; the disposition is unchanged.
 */
export class ExtractionCommandTimeoutError extends Error {
  readonly command: string;
  readonly timeoutMs: number;
  /**
   * Set when the timeout fired but the child (and its group) could not be
   * signalled for a reason other than already being gone: the errno code,
   * e.g. `EPERM`. The work may still be running.
   */
  readonly terminationFailed: string | undefined;

  constructor(input: { command: string; timeoutMs: number; terminationFailed?: string }) {
    super(input.terminationFailed
      ? `${input.command} timed out (no progress for ${Math.round(input.timeoutMs / 1000)} s) and could not be terminated (${input.terminationFailed}); it may still be running.`
      : `${input.command} timed out: no output and no CPU use for ${Math.round(input.timeoutMs / 1000)} s.`);
    this.name = 'ExtractionCommandTimeoutError';
    this.command = input.command;
    this.timeoutMs = input.timeoutMs;
    this.terminationFailed = input.terminationFailed;
  }
}

/**
 * How an injected kill is invoked: the same shape as `process.kill`. Tests
 * stub it to exercise the EPERM path without a process they cannot signal.
 */
export type ExtractionKillFn = (pid: number, signal: NodeJS.Signals) => void;

/**
 * What `killExtractionProcessGroup` managed to do. `ok: false` means neither
 * the group kill nor the direct kill went through for a reason other than the
 * target being gone already, which is the one outcome an operator has to hear
 * about: the child is still burning cores after its timeout.
 */
export type ExtractionKillOutcome =
  | { ok: true }
  | { ok: false; code: string };

function errnoCode(error: unknown): string {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return typeof code === 'string' && code.length > 0 ? code : 'UNKNOWN';
}

/**
 * Kills the child and everything it started. `detached: true` made the child
 * the leader of a process group whose id equals its pid, so a negative pid
 * addresses the group. ESRCH from the group kill is benign (the group is
 * already gone, or the platform has no group semantics) and only the direct
 * child gets a courtesy signal. Any other failure (EPERM in practice) still
 * attempts the direct kill, and if that fails too the outcome reports it
 * rather than pretending the timeout ended the work.
 */
export function killExtractionProcessGroup(
  child: ChildProcess,
  signal: NodeJS.Signals = 'SIGKILL',
  kill: ExtractionKillFn = process.kill,
): ExtractionKillOutcome {
  const pid = child.pid;
  if (pid === undefined || pid <= 0) {
    return { ok: true };
  }
  let groupFailure: string | undefined;
  if (process.platform !== 'win32') {
    try {
      kill(-pid, signal);
      return { ok: true };
    } catch (error) {
      const code = errnoCode(error);
      if (code !== 'ESRCH') groupFailure = code;
    }
  }
  try {
    kill(pid, signal);
    return { ok: true };
  } catch (error) {
    const code = errnoCode(error);
    if (code === 'ESRCH') {
      // The child itself is gone. A non-ESRCH group failure before it is
      // still a termination failure: the grandchildren may live on.
      return groupFailure ? { ok: false, code: groupFailure } : { ok: true };
    }
    return { ok: false, code: groupFailure ?? code };
  }
}

export interface ExtractionCommandRunInternals {
  kill?: ExtractionKillFn;
  /**
   * CPU time used so far by a process group, in ms; undefined where it cannot
   * be read. Tests stub it.
   */
  groupCpuMs?: (pgid: number) => Promise<number | undefined> | number | undefined;
}

/**
 * How often a running command's progress is checked: often enough to notice a
 * stall near its window, never more than every 15 s.
 */
export function stallCheckIntervalMs(windowMs: number): number {
  return Math.max(10, Math.min(15_000, Math.floor(windowMs / 4)));
}

const execFileAsync = promisify(execFile);

async function linuxGroupCpuMs(pgid: number): Promise<number | undefined> {
  let entries: string[];
  try { entries = await readdir('/proc'); } catch { return undefined; }
  const ticksPerSecond = 100;
  let ticks = 0;
  let found = false;
  for (const entry of entries) {
    if (!entry || [...entry].some((char) => char < '0' || char > '9')) continue;
    let stat: string;
    try { stat = await readFile(`/proc/${entry}/stat`, 'utf8'); } catch { continue; }
    // Fields after the command name, which is in parentheses and may contain spaces.
    const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    if (Number(fields[2]) !== pgid) continue;
    found = true;
    ticks += Number(fields[11]) + Number(fields[12]);
  }
  return found ? (ticks * 1000) / ticksPerSecond : undefined;
}

function cpuTimeMs(text: string): number {
  const [days, clock] = text.includes('-') ? text.split('-') as [string, string] : ['0', text];
  const parts = clock.split(':').map(Number);
  let seconds = 0;
  for (const part of parts) seconds = seconds * 60 + part;
  return (Number(days) * 86_400 + seconds) * 1000;
}

async function psGroupCpuMs(pgid: number): Promise<number | undefined> {
  try {
    const { stdout: out } = await execFileAsync('ps', ['-A', '-o', 'pgid=,time='], { encoding: 'utf8', timeout: 5_000 });
    let total = 0;
    let found = false;
    for (const line of out.split('\n')) {
      const [group, time] = line.trim().split(' ').filter(Boolean);
      if (Number(group) !== pgid || !time) continue;
      found = true;
      total += cpuTimeMs(time);
    }
    return found ? total : undefined;
  } catch {
    return undefined;
  }
}

/**
 * CPU time used by every process in a group, in ms: Linux reads /proc, macOS
 * asks ps.
 */
export async function processGroupCpuMs(pgid: number): Promise<number | undefined> {
  if (process.platform === 'win32') return undefined;
  return process.platform === 'linux' ? linuxGroupCpuMs(pgid) : psGroupCpuMs(pgid);
}

/**
 * Where package managers put the extraction tools when the service's PATH
 * does not name them. A launchd agent starts with a minimal PATH (the
 * runtime's own directory and the system directories), so a Homebrew
 * `pdftotext`, `pdftoppm` or `tesseract` the owner installed is invisible to
 * it: every PDF then fell back to the inline text-layer decoder, which reads
 * CID-font PDFs as control characters (fresh-install diagnosis, 2026-10-01).
 */
export const EXTRACTION_COMMAND_FALLBACK_DIRS: readonly string[] = ['/opt/homebrew/bin', '/usr/local/bin', '/opt/local/bin'];

const resolvedCommands = new Map<string, string>();

/**
 * The absolute path of a bare command name: the first executable regular
 * file named `command` on PATH, then in the fallback directories. A command
 * that already names a path, or one found nowhere, is returned unchanged (the
 * spawn then fails with ENOENT exactly as before, and callers degrade).
 */
export function resolveExtractionCommand(
  command: string,
  options: { path?: string; fallbackDirs?: readonly string[]; isExecutable?: (path: string) => boolean } = {},
): string {
  if (!command || command.includes('/') || command.includes('\\')) return command;
  const path = options.path ?? process.env.PATH ?? '';
  const fallbackDirs = options.fallbackDirs ?? EXTRACTION_COMMAND_FALLBACK_DIRS;
  const cacheable = options.path === undefined && options.fallbackDirs === undefined && options.isExecutable === undefined;
  const cacheKey = `${path}\u0000${command}`;
  if (cacheable) {
    const cached = resolvedCommands.get(cacheKey);
    if (cached) return cached;
  }
  const isExecutable = options.isExecutable ?? executableFile;
  const directories = [...path.split(delimiter).filter(Boolean), ...fallbackDirs];
  for (const directory of directories) {
    const candidate = join(directory, command);
    if (isExecutable(candidate)) {
      if (cacheable) resolvedCommands.set(cacheKey, candidate);
      return candidate;
    }
  }
  return command;
}

function executableFile(path: string): boolean {
  try {
    if (!statSync(path).isFile()) return false;
    accessSync(path, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * A detached group outlives the process that started it. When this process is
 * supervised with a record of such groups (DESCENDANT_GROUPS_ENV, set by the
 * supervision kernel), each command's group is recorded there while it runs,
 * so that if this process dies, or restarts itself, mid-command, its
 * supervisor stops the command before the replacement starts: the timeout
 * that would have ended it died with this process.
 */
let groupRecorder: { path: string; recorder: ReturnType<typeof descendantGroupsRecorder> } | undefined;

function commandGroupRecorder(): ReturnType<typeof descendantGroupsRecorder> | undefined {
  const path = process.env[DESCENDANT_GROUPS_ENV]?.trim();
  if (!path || !descendantGroupsSupported()) return undefined;
  if (groupRecorder?.path !== path) groupRecorder = { path, recorder: descendantGroupsRecorder(path) };
  return groupRecorder.recorder;
}

export async function runExtractionCommand(
  request: ExtractionCommandRunRequest,
  internals: ExtractionCommandRunInternals = {},
): Promise<ExtractionCommandRunResult> {
  const kill = internals.kill ?? process.kill;
  const command = resolveExtractionCommand(request.command);
  for (const argument of request.args) addMemoryPayloadText(argument);
  return new Promise((resolve, reject) => {
    const child = spawn(command, request.args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
      ...(request.env ? { env: { ...process.env, ...request.env } } : {}),
    });
    const recorder = commandGroupRecorder();
    const pid = child.pid;
    if (recorder && pid) {
      try { recorder.spawned(pid); } catch { /* Advisory. */ }
      // 'close': the command and its output are done; a group killed on
      // timeout is gone by then too.
      child.once('close', () => { try { recorder.stopped(pid); } catch { /* Advisory. */ } });
    }
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    const notePipeBytes = memoryPayloadByteCounter();
    let pipeBytes = 0;
    const collect = (chunks: Buffer[]) => (chunk: Buffer) => {
      chunks.push(chunk);
      pipeBytes += chunk.byteLength;
      notePipeBytes?.(chunk.byteLength);
      lastProgress = Date.now();
    };
    let settled = false;
    // A stall clock: any output, or any CPU time used by the group, counts as progress and restarts it.
    const useTimeout = Number.isFinite(request.timeoutMs) && request.timeoutMs > 0;
    const groupCpuMs = internals.groupCpuMs ?? processGroupCpuMs;
    const groupId = process.platform !== 'win32' ? child.pid : undefined;
    let lastProgress = Date.now();
    let lastCpu: number | undefined;
    let sampling = false;
    const timer = useTimeout
      ? setInterval(async () => {
          if (settled || sampling) return;
          sampling = true;
          let cpu: number | undefined;
          try { cpu = groupId ? await groupCpuMs(groupId) : undefined; } catch { cpu = undefined; } finally { sampling = false; }
          if (settled) return;
          if (cpu !== undefined && (lastCpu === undefined ? cpu > 0 : cpu > lastCpu)) lastProgress = Date.now();
          if (cpu !== undefined) lastCpu = cpu;
          if (Date.now() - lastProgress < request.timeoutMs) return;
          settled = true;
          clearInterval(timer);
          const outcome = killExtractionProcessGroup(child, 'SIGKILL', kill);
          reject(new ExtractionCommandTimeoutError({
            command: request.command,
            timeoutMs: request.timeoutMs,
            ...(outcome.ok ? {} : { terminationFailed: outcome.code }),
          }));
        }, stallCheckIntervalMs(request.timeoutMs))
      : undefined;
    child.stdout.on('data', collect(stdout));
    child.stderr.on('data', collect(stderr));
    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      if (timer) clearInterval(timer);
      killExtractionProcessGroup(child, 'SIGKILL', kill);
      reject(error);
    });
    child.on('close', (code) => {
      notePipeBytes?.(-pipeBytes);
      if (settled) return;
      settled = true;
      if (timer) clearInterval(timer);
      const result = {
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
      };
      if (code === 0) {
        resolve(result);
        return;
      }
      reject(new ExtractionCommandError({
        command: request.command,
        exitCode: code,
        stdout: result.stdout,
        stderr: result.stderr,
      }));
    });
  });
}
