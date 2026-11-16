// Scans a large text for secrets on a second thread before this thread needs
// the answer.
//
// One large file's secret scan held the worker's thread for up to 16 s on
// Sparta (b8c49e0, 2026-11-05: an extraction accepting a chat export). The
// scan's answer for a large text is already reused by a digest of the text
// (detectSecretFindingKinds), so scanning it here first, off the thread, means
// the classifier that follows finds the answer instead of scanning. The
// decision itself is unchanged: the same scan runs, only elsewhere, and a text
// whose scan this could not make is scanned on this thread exactly as before.

import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { rememberSecretFindingKinds, secretScanRemembered, secretScanReusable } from './engine.ts';

// Check for a finished scan whose reply was lost; never bound a running scan.
const OFF_THREAD_SCAN_TIMEOUT_MS = 120_000;

type Pending = { resolve: (kinds: readonly string[]) => void; reject: (error: Error) => void; timer?: unknown; finishedSeen?: boolean };

interface ScanClock {
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(timer: unknown): void;
}
const REAL_CLOCK: ScanClock = {
  setTimeout: (callback, ms) => setTimeout(callback, ms),
  clearTimeout: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>),
};
let clock = REAL_CLOCK;
let workerFactory = (path: string): Worker => new Worker(path);
let log = (line: string): void => console.warn(line);

/** Tests only: stop the previous scanner before changing its clock or factory. */
export function configureSecretScannerForTests(options: { clock?: ScanClock; workerFactory?: (path: string) => Worker; log?: (line: string) => void } = {}): void {
  if (thread) retire(thread, new Error('secret scanner reset'), false);
  unavailable = false;
  clock = options.clock ?? REAL_CLOCK;
  workerFactory = options.workerFactory ?? ((path) => new Worker(path));
  log = options.log ?? ((line) => console.warn(line));
}

interface ScanThread {
  worker: Worker;
  pending: Map<number, Pending>;
  progress: Int32Array;
  retired?: boolean;
}

let thread: ScanThread | undefined;
let unavailable = false;
let nextId = 1;

function workerPath(): string | undefined {
  const here = dirname(fileURLToPath(import.meta.url));
  // Bundled: dist/secret-scan-worker.js beside dist/cli.js; from source: the .ts sibling.
  for (const name of ['secret-scan-worker.js', 'secret-scan-worker.ts']) {
    const candidate = join(here, name);
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

function scanThread(): ScanThread | undefined {
  if (thread) return thread;
  if (unavailable) return undefined;
  try {
    const path = typeof Worker === 'function' && (globalThis as { Bun?: unknown }).Bun ? workerPath() : undefined;
    if (!path) {
      unavailable = true;
      return undefined;
    }
    const worker = workerFactory(path);
    (worker as Worker & { unref?: () => void }).unref?.();
    const buffer = new SharedArrayBuffer(8);
    const started: ScanThread = { worker, pending: new Map(), progress: new Int32Array(buffer) };
    worker.onmessage = (event: MessageEvent<{ id: number; ok: boolean; kinds?: string[]; error?: string }>) => {
      const message = event.data;
      const waiting = started.pending.get(message.id);
      if (!waiting) return;
      started.pending.delete(message.id);
      clock.clearTimeout(waiting.timer);
      if (message.ok && Array.isArray(message.kinds)) waiting.resolve(message.kinds);
      else waiting.reject(new Error(message.error ?? 'off-thread secret scan failed'));
    };
    worker.onerror = (event: ErrorEvent) => retire(started, new Error(event.message || 'secret scan thread stopped'));
    worker.addEventListener('close', () => retire(started, new Error('secret scan worker closed while waiting for a scan reply')));
    thread = started;
    worker.postMessage({ op: 'progress', buffer });
    return started;
  } catch {
    if (thread) retire(thread, new Error('secret scan worker could not receive its progress buffer'), false);
    unavailable = true;
    return undefined;
  }
}

function retire(stopped: ScanThread, error: Error, report = true): void {
  if (stopped.retired) return;
  stopped.retired = true;
  if (report && stopped.pending.size) log(`[secret-scan] waiting for off-thread secret scan reply: ${error.message}; the classifier will scan locally`);
  if (thread === stopped) thread = undefined;
  for (const waiting of stopped.pending.values()) {
    clock.clearTimeout(waiting.timer);
    waiting.reject(error);
  }
  stopped.pending.clear();
  try {
    stopped.worker.terminate();
  } catch {
    // Already gone.
  }
}

// A queued or executing request is never timed out. Observe completion on
// two separate turns before declaring its reply lost, as the read pool does.
function checkReply(scanner: ScanThread, id: number): void {
  const waiting = scanner.pending.get(id);
  if (!waiting || scanner.retired) return;
  if (Atomics.load(scanner.progress, 1) >= id) {
    if (waiting.finishedSeen) {
      const error = new Error(`worker finished secret scan request ${id}, but its reply was not delivered`);
      log(`[secret-scan] waiting for off-thread secret scan reply: ${error.message}; the classifier will scan locally`);
      scanner.pending.delete(id);
      waiting.reject(error);
      // Other requests can still be scanning: never terminate them to recover
      // this finished request. Replace an idle scanner before its next use.
      if (scanner.pending.size === 0) retire(scanner, error, false);
      return;
    }
    waiting.finishedSeen = true;
  }
  waiting.timer = clock.setTimeout(() => checkReply(scanner, id), OFF_THREAD_SCAN_TIMEOUT_MS);
}

/**
 * Scans a large `text` on the second thread and keeps the answer where the
 * classifier reuses it. Never throws: a text it cannot scan there (too small
 * to be reused, no thread, a failure) is simply left to the classifier.
 */
export async function scanSecretsAhead(text: string): Promise<void> {
  if (!secretScanReusable(text) || secretScanRemembered(text)) return;
  const scanner = scanThread();
  if (!scanner) return;
  const id = nextId++;
  try {
    const kinds = await new Promise<readonly string[]>((resolve, reject) => {
      const waiting: Pending = { resolve, reject };
      scanner.pending.set(id, waiting);
      waiting.timer = clock.setTimeout(() => checkReply(scanner, id), OFF_THREAD_SCAN_TIMEOUT_MS);
      try { scanner.worker.postMessage({ id, text }); }
      catch { retire(scanner, new Error('secret scan request could not be delivered to its worker')); }
    });
    rememberSecretFindingKinds(text, kinds);
  } catch {
    scanner.pending.delete(id);
  }
}
