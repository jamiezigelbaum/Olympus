// The parent side of the LiteRT-LM helper (litert-helper.ts): starts it under
// Bun, sends it batches of text and reads back vectors. One request is in
// flight at a time; the provider already runs one forward pass at a time.

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, dirname, isAbsolute, join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import type { LiteRtHelperSettings } from './litert-helper.ts';

export type LiteRtDevice = 'gpu' | 'cpu';

export interface LiteRtEmbedder {
  /** Where the helper runs the model now. */
  readonly device: LiteRtDevice;
  embed(texts: readonly string[]): Promise<Float32Array[]>;
  release(): Promise<void>;
}

export interface LiteRtEmbedderOptions {
  library: string;
  model: string;
  cacheDir: string;
  threads: number;
  /** `cpu` keeps the model off the GPU. */
  device: 'auto' | 'cpu';
  maxInputTokens: number;
  /** Defaults to this process when it is Bun, else Bun found on the machine. */
  bunPath?: string;
  /** Defaults to the helper next to this module (dist or source). */
  helperPath?: string;
  /** How long a first start (GPU shader and model cache build) may take. */
  startTimeoutMs?: number;
}

interface Pending {
  resolve(vectors: Float32Array[]): void;
  reject(error: Error): void;
  count: number;
}

class HelperProcess {
  readonly child: ChildProcessWithoutNullStreams;
  device: LiteRtDevice = 'cpu';
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private stderr = '';
  exited = false;

  private constructor(child: ChildProcessWithoutNullStreams) {
    this.child = child;
  }

  static start(options: LiteRtEmbedderOptions, device: 'auto' | 'cpu'): Promise<HelperProcess> {
    const settings: LiteRtHelperSettings = {
      library: options.library,
      model: options.model,
      cacheDir: options.cacheDir,
      threads: options.threads,
      device,
      maxInputTokens: options.maxInputTokens,
    };
    const child = spawn(options.bunPath ?? resolveBun(), [options.helperPath ?? helperPath(), JSON.stringify(settings)], {
      stdio: ['pipe', 'pipe', 'pipe'],
      // Only what Bun needs to start; the helper reads no other settings.
      env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? homedir(), TMPDIR: process.env.TMPDIR ?? '' },
    });
    const helper = new HelperProcess(child);
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
        let message: { ready?: boolean; device?: LiteRtDevice; fatal?: string; id?: number; error?: string; vectors?: string; dimension?: number };
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
            resolve(helper);
          } else if (message.fatal) {
            started = true;
            clearTimeout(timer);
            reject(new Error(message.fatal));
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
      child.on('exit', (code, signal) => {
        helper.exited = true;
        const reason = new Error(`The built-in search model stopped (${signal ?? `exit ${code}`})${helper.stderr ? `: ${helper.stderr.trim().split('\n').at(-1)}` : ''}.`);
        if (!started) {
          started = true;
          clearTimeout(timer);
          reject(reason);
        }
        for (const pending of helper.pending.values()) pending.reject(reason);
        helper.pending.clear();
      });
    });
  }

  embed(texts: readonly string[]): Promise<Float32Array[]> {
    if (this.exited) return Promise.reject(new Error('The built-in search model is not running.'));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, count: texts.length });
      this.child.stdin.write(`${JSON.stringify({ id, texts })}\n`);
    });
  }

  private settle(message: { id?: number; error?: string; vectors?: string; dimension?: number }): void {
    const pending = message.id === undefined ? undefined : this.pending.get(message.id);
    if (!pending || message.id === undefined) return;
    this.pending.delete(message.id);
    if (message.error || !message.vectors || !message.dimension) {
      pending.reject(new Error(message.error ?? 'The built-in search model returned no vectors.'));
      return;
    }
    const bytes = Buffer.from(message.vectors, 'base64');
    const all = new Float32Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
    const vectors = Array.from({ length: pending.count }, (_, index) => all.subarray(index * message.dimension!, (index + 1) * message.dimension!));
    if (vectors.some((vector) => vector.length !== message.dimension)) {
      pending.reject(new Error('The built-in search model returned the wrong number of values.'));
      return;
    }
    pending.resolve(vectors);
  }

  async stop(): Promise<void> {
    if (this.exited) return;
    const exited = new Promise<void>((resolve) => this.child.once('exit', () => resolve()));
    this.child.stdin.end();
    const timer = setTimeout(() => this.child.kill('SIGKILL'), 5_000);
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
  let device: 'auto' | 'cpu' = options.device;
  let helper = await HelperProcess.start(options, device);
  const releaseAtExit = () => { if (!helper.exited) helper.child.kill('SIGKILL'); };
  process.once('exit', releaseAtExit);
  return {
    get device() { return helper.device; },
    async embed(texts) {
      if (helper.exited) {
        if (helper.device === 'gpu') device = 'cpu';
        helper = await HelperProcess.start(options, device);
      }
      return helper.embed(texts);
    },
    async release() {
      process.removeListener('exit', releaseAtExit);
      await helper.stop();
    },
  };
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
