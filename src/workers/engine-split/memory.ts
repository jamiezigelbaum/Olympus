import { readFileSync } from 'node:fs';
import { heapStats } from 'bun:jsc';
import type { EngineRole } from '../../core/engine-split.ts';
import { memoryHolderCounts, type MemoryActivityLabel } from '../../core/memory-counters.ts';

const MB = 1024 * 1024;
export const MEMORY_SAMPLE_INTERVAL_MS = 5_000;
export const MEMORY_LOG_INTERVAL_MS = 5 * 60_000;
// Over three hours on a live box, bursts came about once a minute. The median
// rise was 34 s and fall 8 s, with a few rises of 2–5 min and one of 20 min.
export const MEMORY_FLOOR_WINDOW_MAX_SAMPLES = 5 * 60_000 / MEMORY_SAMPLE_INTERVAL_MS;
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
interface MemoryFloor {
  rss: number;
  anon: number | undefined;
  full: boolean;
}
const mb = (bytes: number) => Math.round(bytes / MB * 100) / 100;

/** Fixed schema only: no caller-supplied labels, ids, paths or names enter the line. */
export function memoryFields(
  context: MemoryContext, memory: ProcessMemory, peak: MemoryPeak | undefined, heap = heapStats(),
  floor?: MemoryFloor, burstsOverThreshold = 0,
): string {
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
    ...(floor === undefined ? {} : floor.anon === undefined
      ? { floor_rss_mb: mb(floor.rss) }
      : { floor_anon_mb: mb(floor.anon) }),
    bursts_over_threshold: burstsOverThreshold,
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
  const samples: Pick<MemoryFloor, 'rss' | 'anon'>[] = [];
  let nextSample = 0;
  let checksSinceLine = 0;
  let burstsSinceLine = 0;
  const floor = (): MemoryFloor | undefined => {
    if (samples.length === 0) return undefined;
    let rss = Infinity;
    let anon: number | undefined = Infinity;
    for (const sample of samples) {
      rss = Math.min(rss, sample.rss);
      anon = anon === undefined || sample.anon === undefined ? undefined : Math.min(anon, sample.anon);
    }
    return { rss, anon, full: samples.length === MEMORY_FLOOR_WINDOW_MAX_SAMPLES };
  };
  return {
    sample(memory: ProcessMemory, rss = memory.anon ?? memory.rss): void {
      samples[nextSample] = { rss, anon: memory.anon };
      nextSample = (nextSample + 1) % MEMORY_FLOOR_WINDOW_MAX_SAMPLES;
      if (memory.anon === undefined || (peak && memory.anon <= peak.anon)) return;
      peak = { anon: memory.anon, at: new Date(now()).toISOString(), activity: activity(), heapSize: heap().heapSize };
    },
    floor,
    recordBurst(rss: number, floorRss: number, thresholdMb: number): void {
      if (++burstsSinceLine === 1) {
        log(`[olympus] memory restart not taken: burst rss_mb=${mb(rss)} floor_mb=${mb(floorRss)} threshold_mb=${thresholdMb}`);
      }
    },
    // Called on the minute check. Counting those checks keeps timer jitter from skipping to minute six.
    dueOnMinuteCheck(): boolean { return ++checksSinceLine >= 5 || now() - lastLineAt >= MEMORY_LOG_INTERVAL_MS; },
    /** Returns the same fields for the restart line. */
    write(memory: ProcessMemory): string {
      const at = new Date(now()).toISOString();
      const fields = memoryFields({ role: input.role, pid: process.pid,
        uptime_s: Math.floor((input.uptime ?? process.uptime)()), activity: activity(),
        ...(input.readers?.() ?? { read_workers: 0, read_connections: 0 }),
      }, memory, peak, heap(), floor(), burstsSinceLine);
      log(`${at} [olympus] memory ${fields}`);
      peak = undefined;
      checksSinceLine = 0;
      burstsSinceLine = 0;
      lastLineAt = now();
      return `at=${at} ${fields}`;
    },
  };
}
