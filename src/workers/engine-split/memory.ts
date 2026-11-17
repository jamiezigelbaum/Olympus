import { readFileSync } from 'node:fs';
import { heapStats } from 'bun:jsc';
import type { EngineRole } from '../../core/engine-split.ts';
import { memoryHolderCounts, type MemoryActivityLabel } from '../../core/memory-counters.ts';

const MB = 1024 * 1024;
export const MEMORY_SAMPLE_INTERVAL_MS = 5_000;
export const MEMORY_LOG_INTERVAL_MS = 5 * 60_000;
export interface ProcessMemory {
  rss: number;
  anon?: number;
  file?: number;
  swap?: number;
}
/** /proc has distinct resident anonymous and file pages; total RSS elsewhere is never called anonymous. */
export function processMemory(status?: string, platform: string = process.platform): ProcessMemory {
  const rss = process.memoryUsage.rss();
  if (platform !== 'linux') return { rss };
  // A vanished/unavailable proc mount leaves only the correctly named total.
  if (status === undefined) {
    try { status = readFileSync('/proc/self/status', 'utf8'); }
    catch { return { rss }; }
  }
  const kb = (key: string): number | undefined => {
    const found = new RegExp(`^${key}:\\s+(\\d+)\\s+kB$`, 'm').exec(status);
    return found ? Number(found[1]) * 1024 : undefined;
  };
  const anon = kb('RssAnon'), file = kb('RssFile'), swap = kb('VmSwap');
  return { rss, ...(anon === undefined ? {} : { anon }), ...(file === undefined ? {} : { file }), ...(swap === undefined ? {} : { swap }) };
}

export interface MemoryContext {
  role: EngineRole;
  activity: string;
  pid: number;
  uptime_s: number;
  read_workers: number;
  read_connections: number;
}
interface MemoryPeak {
  anon: number;
  at: string;
  activity: string;
  heapSize: number;
}
/** Fixed schema only: no caller-supplied labels, ids, paths or names enter the line. */
export function memoryFields(context: MemoryContext, memory: ProcessMemory, peak: MemoryPeak | undefined, heap = heapStats()): string {
  const mb = (bytes: number) => Math.round(bytes / MB * 100) / 100;
  const holders = memoryHolderCounts();
  const fields = {
    ...context,
    rss_total_mb: mb(memory.rss),
    ...(memory.anon === undefined ? {} : { rss_anon_mb: mb(memory.anon) }),
    ...(memory.file === undefined ? {} : { rss_file_mb: mb(memory.file) }),
    ...(memory.swap === undefined ? {} : { swap_mb: mb(memory.swap) }),
    ...(peak === undefined ? {} : {
      peak_anon_mb: mb(peak.anon), peak_at: peak.at, peak_activity: peak.activity, peak_heap_size_mb: mb(peak.heapSize),
    }),
    heap_size_mb: mb(heap.heapSize), heap_capacity_mb: mb(heap.heapCapacity),
    extra_memory_mb: mb(heap.extraMemorySize), object_count: heap.objectCount,
    ...holders,
  };
  return Object.entries(fields).map(([key, value]) => `${key}=${value}`).join(' ');
}

export function createMemoryDiagnostic(input: {
  role: EngineRole;
  activity?: () => readonly MemoryActivityLabel[];
  readers?: () => { read_workers: number; read_connections: number };
  now?: () => number;
  uptime?: () => number;
  heap?: typeof heapStats;
  log?: (line: string) => void;
}) {
  const now = input.now ?? Date.now;
  const log = input.log ?? ((line: string) => console.warn(line));
  const activity = () => input.activity?.().join(',') || 'idle';
  const heap = input.heap ?? heapStats;
  let lastLineAt = now();
  let peak: MemoryPeak | undefined;
  let checksSinceLine = 0;
  return {
    sample(memory: ProcessMemory): void {
      if (memory.anon === undefined || (peak && memory.anon <= peak.anon)) return;
      peak = { anon: memory.anon, at: new Date(now()).toISOString(), activity: activity(), heapSize: heap().heapSize };
    },
    // Called on the minute check. Counting those checks keeps timer jitter from skipping to minute six.
    dueOnMinuteCheck(): boolean { return ++checksSinceLine >= 5 || now() - lastLineAt >= MEMORY_LOG_INTERVAL_MS; },
    /** Returns the same fields for the restart line. */
    write(memory: ProcessMemory): string {
      const at = new Date(now()).toISOString();
      const fields = memoryFields({ role: input.role, pid: process.pid,
        uptime_s: Math.floor((input.uptime ?? process.uptime)()), activity: activity(),
        ...(input.readers?.() ?? { read_workers: 0, read_connections: 0 }),
      }, memory, peak, heap());
      log(`${at} [olympus] memory ${fields}`);
      peak = undefined;
      checksSinceLine = 0;
      lastLineAt = now();
      return `at=${at} ${fields}`;
    },
  };
}
