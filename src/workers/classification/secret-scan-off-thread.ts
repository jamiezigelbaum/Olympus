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

// Past this a scan is presumed stuck: the thread is replaced and the classifier scans itself.
const OFF_THREAD_SCAN_TIMEOUT_MS = 120_000;

type Pending = { resolve: (kinds: readonly string[]) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> };

interface ScanThread {
  worker: Worker;
  pending: Map<number, Pending>;
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
    const worker = new Worker(path);
    (worker as Worker & { unref?: () => void }).unref?.();
    const started: ScanThread = { worker, pending: new Map() };
    worker.onmessage = (event: MessageEvent<{ id: number; ok: boolean; kinds?: string[]; error?: string }>) => {
      const message = event.data;
      const waiting = started.pending.get(message.id);
      if (!waiting) return;
      started.pending.delete(message.id);
      clearTimeout(waiting.timer);
      if (message.ok && Array.isArray(message.kinds)) waiting.resolve(message.kinds);
      else waiting.reject(new Error(message.error ?? 'off-thread secret scan failed'));
    };
    worker.onerror = (event: ErrorEvent) => retire(started, new Error(event.message || 'secret scan thread stopped'));
    thread = started;
    return started;
  } catch {
    unavailable = true;
    return undefined;
  }
}

function retire(stopped: ScanThread, error: Error): void {
  if (thread === stopped) thread = undefined;
  for (const waiting of stopped.pending.values()) {
    clearTimeout(waiting.timer);
    waiting.reject(error);
  }
  stopped.pending.clear();
  try {
    stopped.worker.terminate();
  } catch {
    // Already gone.
  }
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
      const timer = setTimeout(() => retire(scanner, new Error('off-thread secret scan timed out')), OFF_THREAD_SCAN_TIMEOUT_MS);
      scanner.pending.set(id, { resolve, reject, timer });
      scanner.worker.postMessage({ id, text });
    });
    rememberSecretFindingKinds(text, kinds);
  } catch {
    scanner.pending.delete(id);
  }
}
