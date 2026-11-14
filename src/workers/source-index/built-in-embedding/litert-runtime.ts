// The parent side of the LiteRT-LM helper (litert-helper.ts): starts it under
// Bun, sends it batches of text (and, for a model that reads images, text with
// a picture) and reads back vectors. One request is in flight at a time; the
// provider already runs one forward pass at a time.

import { isMainThread } from 'node:worker_threads';
import { modelThread, modelThreadHandleId, type ModelThreadFailure } from '../built-in-reasoning/off-thread.ts';
import { execFileSync, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { closeSync, constants, existsSync, fstatSync, openSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, dirname, isAbsolute, join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import type { LiteRtHelperSettings } from './litert-helper.ts';

export type LiteRtDevice = 'gpu' | 'cpu';

/**
 * One input: text alone, or text with a picture (an absolute path to a
 * prepared JPEG) that the model embeds together into one vector.
 */
export type LiteRtEmbedItem = string | { text: string; image?: string };

/**
 * Pictures were sent to a helper running without its image encoder (it may
 * have been restarted without it). Nothing about the pictures is wrong: the
 * caller holds them until the encoder runs again.
 */
export class LiteRtImagesUnavailableError extends Error {
  readonly indexes: readonly number[];

  constructor(indexes: readonly number[]) {
    super('The built-in search model is running without its image encoder.');
    this.name = 'LiteRtImagesUnavailableError';
    this.indexes = indexes;
  }
}

/**
 * The helper's image encoder failed even the known-good picture
 * (litert-isolation.ts): pictures cannot be read now, though text may be.
 * The helper is replaced, as for any engine fault; the caller decides whether
 * to try the pictures again or hold them for a while.
 */
export class LiteRtPictureEngineFaultError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LiteRtPictureEngineFaultError';
  }
}

/**
 * The helper was replaced while a batch was out: it stopped (a signal or an
 * exit) or showed no sign of life for a whole window. `done` holds the items
 * it had already answered, so the batch resumes after them, never from the
 * start.
 */
export class LiteRtHelperReplacedError extends Error {
  readonly done: ReadonlyMap<number, Float32Array>;
  readonly reason: string;

  constructor(message: string, reason: string, done: ReadonlyMap<number, Float32Array>) {
    super(message);
    this.name = 'LiteRtHelperReplacedError';
    this.reason = reason;
    this.done = done;
  }
}

/** Helper replacements in this process, said in each replacement's log line. */
let helperReplacements = 0;
export function liteRtHelperReplacements(): number {
  return helperReplacements;
}

export interface LiteRtEmbedder {
  /** Where the helper runs the model now. */
  readonly device: LiteRtDevice;
  /** Whether the helper started the image encoder (it may run without it). */
  readonly vision: boolean;
  /**
   * One vector per item. An item whose picture could not be read gets an
   * EMPTY vector (length 0) while the rest are embedded.
   */
  embed(items: readonly LiteRtEmbedItem[]): Promise<Float32Array[]>;
  release(): Promise<void>;
}

export interface LiteRtEmbedderOptions {
  library: string;
  model: string;
  cacheDir: string;
  threads: number;
  /** `cpu` keeps the model off the GPU. */
  device: 'auto' | 'cpu';
  /** Test seam for the Linux render-device check; other platforms keep their native auto selection. */
  gpuAvailable?: () => boolean;
  maxInputTokens: number;
  /**
   * Image tokens per picture for a model that reads images; absent keeps the
   * vision encoder off and the helper refuses pictures.
   */
  visionTokensPerImage?: number;
  /** Defaults to this process when it is Bun, else Bun found on the machine. */
  bunPath?: string;
  /** Defaults to the helper next to this module (dist or source). */
  helperPath?: string;
  /** How long a first start (GPU shader and model cache build) may take. */
  startTimeoutMs?: number;
  /**
   * How long a batch may go with no answered item and no processor time
   * used before the helper is presumed stuck and replaced. A helper that is
   * slow but working (busy processors, a large picture) is never replaced.
   */
  requestTimeoutMs?: number;
  /** How long `release` waits for the helper to exit before killing it. */
  stopTimeoutMs?: number;
}

/**
 * A window with no answered item and no processor time used: a native call
 * that neither finishes nor computes is stuck (a GPU or driver stall), and it
 * holds the provider's only slot, so every question would wait behind it.
 * Time alone never decides it. On Sparta (rc.13, 14 Nov 2026) a three-minute
 * limit on the whole batch killed the picture helper mid-batch under busy
 * processors about every ten minutes, and the batch started over each time.
 */
const REQUEST_TIMEOUT_MS = 3 * 60_000;
/** Processor time a helper must have used over a window to count as working. */
const HELPER_WORKING_CPU_MS = 1_000;

/** The helper's own processor time so far, or undefined where it cannot be read. */
export function helperCpuMs(pid: number | undefined, platform: NodeJS.Platform = process.platform): number | undefined {
  if (pid === undefined) return undefined;
  try {
    if (platform === 'linux') {
      // Fields after the command name: utime and stime are the 12th and 13th, in clock ticks.
      const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
      const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
      const ticks = Number(fields[11]) + Number(fields[12]);
      return Number.isFinite(ticks) ? ticks * 10 : undefined;
    }
    if (platform === 'darwin') {
      // [[dd-]hh:]mm:ss.cc
      const text = execFileSync('/bin/ps', ['-o', 'time=', '-p', String(pid)], { encoding: 'utf8', timeout: 2_000 }).trim();
      const [days, clock] = text.includes('-') ? text.split('-') as [string, string] : ['0', text];
      const parts = clock.split(':').map(Number);
      const seconds = parts.reduce((sum, part) => sum * 60 + part, 0) + Number(days) * 86_400;
      return Number.isFinite(seconds) ? seconds * 1_000 : undefined;
    }
  } catch {
    // Unreadable: the window then decides on answered items alone.
  }
  return undefined;
}

/** What the helper's environment keeps: enough for Bun to start and for a GPU to be found. */
function helperEnvironment(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    if (['PATH', 'HOME', 'TMPDIR', 'XDG_RUNTIME_DIR', 'DISPLAY', 'WAYLAND_DISPLAY'].includes(name) || name.startsWith('VK_')) {
      env[name] = value;
    }
  }
  env.HOME ??= homedir();
  return env;
}

interface Pending {
  resolve(vectors: Float32Array[]): void;
  reject(error: Error): void;
  count: number;
  pictures: number;
  timer: ReturnType<typeof setTimeout>;
  startedAt: number;
  /** Items the helper answered one at a time (a batch with a picture), by index. */
  done: Map<number, Float32Array>;
  progressed: boolean;
  cpuMs: number | undefined;
}

class HelperProcess {
  readonly child: ChildProcessWithoutNullStreams;
  device: LiteRtDevice = 'cpu';
  vision = false;
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private stderr = '';
  private requestTimeoutMs: number;
  private stopTimeoutMs: number;
  exited = false;

  private constructor(child: ChildProcessWithoutNullStreams, options: LiteRtEmbedderOptions) {
    this.child = child;
    this.requestTimeoutMs = options.requestTimeoutMs ?? REQUEST_TIMEOUT_MS;
    this.stopTimeoutMs = options.stopTimeoutMs ?? 5_000;
  }

  /** Every waiting batch fails with `reason`; the helper is gone or about to be. */
  private failAll(reason: Error, why = 'stopped'): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      helperReplacements += 1;
      console.warn(`[built-in embedding] helper replaced (${why}) after ${Math.round((Date.now() - pending.startedAt) / 1_000)} s on a batch of ${pending.count} item(s), ${pending.pictures} with a picture, ${pending.done.size} already answered; replacement ${helperReplacements} in this process.`);
      pending.reject(new LiteRtHelperReplacedError(reason.message, why, pending.done));
    }
    this.pending.clear();
  }

  static start(options: LiteRtEmbedderOptions, device: 'auto' | 'cpu'): Promise<HelperProcess> {
    const settings: LiteRtHelperSettings = {
      library: options.library,
      model: options.model,
      cacheDir: options.cacheDir,
      threads: options.threads,
      device,
      maxInputTokens: options.maxInputTokens,
      ...(options.visionTokensPerImage !== undefined ? { visionTokensPerImage: options.visionTokensPerImage } : {}),
    };
    const child = spawn(options.bunPath ?? resolveBun(), [options.helperPath ?? helperPath(), JSON.stringify(settings)], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: helperEnvironment(),
    });
    const helper = new HelperProcess(child, options);
    // A write to a helper that has just died fails asynchronously (EPIPE);
    // unheard, that error would take this process down with it.
    child.stdin.on('error', (error) => {
      helper.exited = true;
      helper.failAll(new Error(`The built-in search model stopped: ${error.message}.`));
      child.kill('SIGKILL');
    });
    return new Promise((resolve, reject) => {
      let started = false;
      const timer = setTimeout(() => {
        if (started) return;
        child.kill('SIGKILL');
        reject(new Error('The built-in search model took too long to start.'));
      }, options.startTimeoutMs ?? 5 * 60_000);
      child.stderr.on('data', (chunk: Buffer) => {
        helper.stderr = (helper.stderr + chunk.toString('utf8')).slice(-4_000);
      });
      createInterface({ input: child.stdout }).on('line', (line) => {
        let message: { ready?: boolean; device?: LiteRtDevice; vision?: boolean; fatal?: string; id?: number; error?: string; native?: boolean; pictures?: boolean; vectors?: string; dimension?: number; failed?: number[]; unsupported?: number[] };
        try {
          message = JSON.parse(line);
        } catch {
          return; // A library writing to stdout is not a protocol message.
        }
        if (!started) {
          if (message.ready) {
            started = true;
            clearTimeout(timer);
            helper.device = message.device === 'gpu' ? 'gpu' : 'cpu';
            helper.vision = message.vision === true;
            resolve(helper);
          } else if (message.fatal) {
            started = true;
            clearTimeout(timer);
            // The helper has already tried every device it was allowed: retrying would only load the model again.
            reject(Object.assign(new Error(message.fatal), { fatal: true }));
          }
          return;
        }
        helper.settle(message);
      });
      child.on('error', (error) => {
        if (!started) {
          started = true;
          clearTimeout(timer);
          reject(error);
        }
      });
      // No new batch goes to a helper that has exited.
      child.on('exit', () => { helper.exited = true; });
      // Fail on `close`, which follows the last output line: a helper's final
      // message (its fatal reason, a last answer) arrives before its exit is acted on.
      child.on('close', (code, signal) => {
        helper.exited = true;
        const reason = new Error(`The built-in search model stopped (${signal ?? `exit ${code}`})${helper.stderr ? `: ${helper.stderr.trim().split('\n').at(-1)}` : ''}.`);
        if (!started) {
          started = true;
          clearTimeout(timer);
          reject(reason);
        }
        if (helper.replacing) return; // Already failed and logged by its own reason.
        helper.failAll(reason, signal ?? `exit ${code}`);
      });
    });
  }

  replacing = false;

  /**
   * Arms the batch's liveness window. When it ends, a helper that answered
   * an item or used processor time in it is working, and gets another window;
   * one that did neither is stuck, and is replaced.
   */
  private watch(id: number): ReturnType<typeof setTimeout> {
    return setTimeout(() => {
      const pending = this.pending.get(id);
      if (!pending) return;
      const cpuMs = helperCpuMs(this.child.pid);
      const working = pending.progressed
        || (cpuMs !== undefined && pending.cpuMs !== undefined
          && cpuMs - pending.cpuMs >= Math.min(HELPER_WORKING_CPU_MS, this.requestTimeoutMs / 4));
      if (working) {
        pending.progressed = false;
        pending.cpuMs = cpuMs;
        pending.timer = this.watch(id);
        return;
      }
      // Replaced, not waited on: the next batch starts a new helper.
      this.replacing = true;
      this.exited = true;
      this.child.kill('SIGKILL');
      this.failAll(new Error('The built-in search model stopped responding and was restarted.'), 'no answer and no processor time for a whole window');
    }, this.requestTimeoutMs);
  }

  embed(items: readonly LiteRtEmbedItem[]): Promise<Float32Array[]> {
    if (this.exited) return Promise.reject(new Error('The built-in search model is not running.'));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const pictures = items.filter((item) => typeof item !== 'string' && item.image).length;
      this.pending.set(id, {
        resolve, reject, count: items.length, pictures, timer: this.watch(id),
        startedAt: Date.now(), done: new Map(), progressed: false, cpuMs: helperCpuMs(this.child.pid),
      });
      // Text alone keeps the original request shape; a batch with a picture
      // sends items, each its text and the picture's path.
      const request = items.every((item) => typeof item === 'string')
        ? { id, texts: items }
        : { id, items: items.map((item) => (typeof item === 'string' ? { text: item } : item)) };
      this.child.stdin.write(`${JSON.stringify(request)}\n`);
    });
  }

  private settle(message: { id?: number; error?: string; native?: boolean; pictures?: boolean; vectors?: string; dimension?: number; failed?: number[]; unsupported?: number[]; progress?: number; vector?: string; itemFailed?: boolean }): void {
    const pending = message.id === undefined ? undefined : this.pending.get(message.id);
    if (!pending || message.id === undefined) return;
    if (typeof message.progress === 'number') {
      // One item of a picture batch answered: alive, and kept for a resume.
      pending.progressed = true;
      if (message.itemFailed) pending.done.set(message.progress, new Float32Array(0));
      else if (message.vector) {
        const bytes = Buffer.from(message.vector, 'base64');
        pending.done.set(message.progress, new Float32Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)));
      }
      return;
    }
    this.pending.delete(message.id);
    clearTimeout(pending.timer);
    if (!message.error && Array.isArray(message.unsupported) && message.unsupported.length > 0) {
      pending.reject(new LiteRtImagesUnavailableError(message.unsupported));
      return;
    }
    const failed = new Set(Array.isArray(message.failed) ? message.failed : []);
    if (!message.error && failed.size === pending.count) {
      // Every item's picture failed: nothing to decode, nothing wrong with the engine.
      pending.resolve(Array.from({ length: pending.count }, () => new Float32Array(0)));
      return;
    }
    if (message.error || !message.vectors || !message.dimension) {
      pending.reject(message.error && message.pictures
        ? new LiteRtPictureEngineFaultError(message.error)
        : new Error(message.error ?? 'The built-in search model returned no vectors.'));
      // LiteRT-LM itself failed (a GPU dispatch failure, say): the helper is
      // replaced on the next batch, on the CPU if it was on the GPU, instead of
      // sending every later batch to the same failing engine. A bad request
      // fails only itself.
      if (message.native) {
        this.exited = true;
        this.child.kill('SIGKILL');
      }
      return;
    }
    const bytes = Buffer.from(message.vectors, 'base64');
    const all = new Float32Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
    const vectors = Array.from({ length: pending.count }, (_, index) => (failed.has(index)
      ? new Float32Array(0)
      : all.subarray(index * message.dimension!, (index + 1) * message.dimension!)));
    if (vectors.some((vector, index) => !failed.has(index) && vector.length !== message.dimension)) {
      pending.reject(new Error('The built-in search model returned the wrong number of values.'));
      return;
    }
    pending.resolve(vectors);
  }

  async stop(): Promise<void> {
    if (this.exited) return;
    const exited = new Promise<void>((resolve) => this.child.once('close', () => resolve()));
    this.child.stdin.end();
    const timer = setTimeout(() => this.child.kill('SIGKILL'), this.stopTimeoutMs);
    await exited;
    clearTimeout(timer);
  }
}

/**
 * Starts the helper. A helper that stops (a native fault, a lost GPU) is
 * started again on the next batch; one that stopped while on the GPU comes
 * back on the CPU, whose vectors match the GPU's (cosine 0.9996, M3).
 */
export async function startLiteRtEmbedder(options: LiteRtEmbedderOptions): Promise<LiteRtEmbedder> {
  // The native engine already lives in a helper, but spawning/restarting that
  // helper can itself block. Keep its lifecycle on the model thread as well.
  if (isMainThread && !options.gpuAvailable) {
    const handle = modelThreadHandleId();
    let state = await modelThread().call<{ device: LiteRtDevice; vision: boolean }>({ kind: 'litert-start', handle, options });
    return {
      get device() { return state.device; },
      get vision() { return state.vision; },
      async embed(items) {
        try {
          const result = await modelThread().call<{ device: LiteRtDevice; vision: boolean; vectors: Float32Array[] }>({ kind: 'litert-run', handle, items });
          state = result;
          return result.vectors;
        } catch (error) {
          const failure = error as Error & ModelThreadFailure;
          if (failure.device !== undefined && failure.vision !== undefined) state = { device: failure.device, vision: failure.vision };
          if (failure.name === 'LiteRtImagesUnavailableError') throw new LiteRtImagesUnavailableError(failure.indexes ?? []);
          if (failure.name === 'LiteRtPictureEngineFaultError') throw new LiteRtPictureEngineFaultError(failure.message);
          throw error;
        }
      },
      async release() { await modelThread().call({ kind: 'litert-release', handle }); },
    };
  }
  let device: 'auto' | 'cpu' = options.device === 'auto' && process.platform === 'linux'
    && !(options.gpuAvailable ?? linuxGpuAvailable)() ? 'cpu' : options.device;
  let helper: HelperProcess;
  try {
    helper = await HelperProcess.start(options, device);
  } catch (error) {
    // A GPU start that kills the helper outright (a driver fault rather than
    // a refused engine) leaves the CPU untried; try it once before failing.
    if (device === 'cpu' || (error as { fatal?: boolean }).fatal) throw error;
    device = 'cpu';
    helper = await HelperProcess.start(options, device);
  }
  const releaseAtExit = () => { if (!helper.exited) helper.child.kill('SIGKILL'); };
  process.once('exit', releaseAtExit);
  return {
    get device() { return helper.device; },
    get vision() { return helper.vision; },
    async embed(items) {
      if (helper.exited) {
        if (helper.device === 'gpu') device = 'cpu';
        helper = await HelperProcess.start(options, device);
      }
      // Checked against the helper that will run this batch, which a restart
      // may have brought back without its image encoder.
      const pictures = items.flatMap((item, index) => (typeof item !== 'string' && item.image ? [index] : []));
      if (pictures.length > 0 && !helper.vision) throw new LiteRtImagesUnavailableError(pictures);
      try {
        return await helper.embed(items);
      } catch (error) {
        // A replaced helper's batch resumes once, on a new helper, after the
        // items it had answered; a second replacement fails the batch.
        if (!(error instanceof LiteRtHelperReplacedError)) throw error;
        if (helper.device === 'gpu') device = 'cpu';
        helper = await HelperProcess.start(options, device);
        const rest = items.map((_, index) => index).filter((index) => !error.done.has(index));
        const restPictures = rest.filter((index) => pictures.includes(index));
        if (restPictures.length > 0 && !helper.vision) throw new LiteRtImagesUnavailableError(restPictures);
        const vectors = rest.length > 0 ? await helper.embed(rest.map((index) => items[index]!)) : [];
        const resumed = new Map(rest.map((index, row) => [index, vectors[row]!]));
        return items.map((_, index) => error.done.get(index) ?? resumed.get(index)!);
      }
    },
    async release() {
      process.removeListener('exit', releaseAtExit);
      await helper.stop();
    },
  };
}

/** No native GPU initialization on headless Linux or when the service cannot
 * open a render device. Merely having a driver library (including a software
 * renderer) is not evidence of hardware access. A driver failure after this
 * check still uses the isolated helper's existing CPU fallback. */
export function linuxGpuAvailable(deviceDirectory = '/dev/dri'): boolean {
  try {
    return readdirSync(deviceDirectory).some(name => {
      if (!/^renderD[0-9]+$/.test(name)) return false;
      let fd: number | undefined;
      try {
        fd = openSync(join(deviceDirectory, name), constants.O_RDWR | constants.O_NONBLOCK);
        return fstatSync(fd).isCharacterDevice();
      } catch { return false; }
      finally { if (fd !== undefined) closeSync(fd); }
    });
  } catch { return false; }
}

function helperPath(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  // Bundled: dist/litert-helper.js beside dist/index.js; from source: the .ts sibling.
  for (const name of ['litert-helper.js', 'litert-helper.ts']) {
    const candidate = join(here, name);
    if (existsSync(candidate)) return candidate;
  }
  throw new Error('The built-in search model helper is missing from this install.');
}

function resolveBun(): string {
  const bunName = process.platform === 'win32' ? 'bun.exe' : 'bun';
  const candidates = [
    process.versions.bun ? process.execPath : undefined,
    process.env.BUN_INSTALL ? join(process.env.BUN_INSTALL, 'bin', bunName) : undefined,
    ...(process.env.PATH ?? '').split(delimiter).filter(Boolean).map((directory) => join(directory, bunName)),
    join(homedir(), '.bun', 'bin', bunName),
  ];
  for (const candidate of candidates) {
    if (!candidate || !isAbsolute(candidate)) continue;
    try {
      if (statSync(candidate).isFile()) return candidate;
    } catch {
      // Next candidate.
    }
  }
  throw new Error('The built-in search model needs Bun, and none was found.');
}
