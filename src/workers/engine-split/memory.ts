import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import type { EngineRole } from '../../core/engine-split.ts';
import { memoryHolderCounts, memoryPayloadCounts, type MemoryActivityLabel } from '../../core/memory-counters.ts';

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
  return parseProcMemory(rss, status);
}

export async function processMemoryAsync(): Promise<ProcessMemory> {
  if (process.platform !== 'linux') return { rss: process.memoryUsage.rss() };
  try {
    const status = await readFile('/proc/self/status', 'utf8');
    return parseProcMemory(process.memoryUsage.rss(), status);
  } catch {
    // An unavailable proc mount leaves only the correctly named total.
    return { rss: process.memoryUsage.rss() };
  }
}

function parseProcMemory(rss: number, status: string): ProcessMemory {
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
}
interface MemoryPeak {
  anon: number;
  at: string;
  activity: string;
  attribution: MemoryAttribution;
}
interface MemoryFloor {
  rss: number;
  anon: number | undefined;
  full: boolean;
  attribution?: MemoryAttribution;
}
const mb = (bytes: number) => Math.round(bytes / MB * 100) / 100;

/** Numeric fields named *_mb hold bytes until formatting. */
type MemoryAttribution = Record<string, number | string>;

function attributionFields(fields: MemoryAttribution | undefined, prefix = ''): MemoryAttribution {
  return Object.fromEntries(Object.entries(fields ?? {}).map(([key, value]) =>
    [prefix + key, key.endsWith('_mb') && typeof value === 'number' ? mb(value) : value]));
}

/** Fixed schema only: no caller-supplied labels, ids, paths or names enter the line. */
function memoryFields(
  context: MemoryContext, memory: ProcessMemory, peak: MemoryPeak | undefined,
  floor?: MemoryFloor, burstsOverThreshold = 0, attribution?: MemoryAttribution,
): string {
  const holders = memoryHolderCounts();
  const fields = {
    ...context,
    rss_total_mb: mb(memory.rss),
    ...(memory.anon === undefined ? {} : { rss_anon_mb: mb(memory.anon) }),
    ...(memory.file === undefined ? {} : { rss_file_mb: mb(memory.file) }),
    ...(memory.swap === undefined ? {} : { swap_mb: mb(memory.swap) }),
    ...(peak === undefined ? {} : {
      peak_anon_mb: mb(peak.anon), peak_at: peak.at, peak_activity: peak.activity,
      ...attributionFields(peak.attribution, 'peak_'),
    }),
    ...(floor === undefined ? {} : floor.anon === undefined
      ? { floor_rss_mb: mb(floor.rss) }
      : { floor_anon_mb: mb(floor.anon) }),
    bursts_over_threshold: burstsOverThreshold,
    ...holders,
    ...attributionFields(attribution),
    ...attributionFields(floor?.attribution, 'floor_'),
  };
  return Object.entries(fields).map(([key, value]) => `${key}=${value}`).join(' ');
}

export function createMemoryDiagnostic(input: {
  role: EngineRole;
  activity?: () => readonly MemoryActivityLabel[];
  readers?: () => { read_workers: number; read_connections: number };
  now?: () => number;
  uptime?: () => number;
  heap?: () => Pick<NodeJS.MemoryUsage, 'heapUsed' | 'heapTotal' | 'external' | 'arrayBuffers'>;
  sampleHolders?: () => MemoryAttribution;
  workerPayloads?: () => BigInt64Array | undefined;
  log?: (line: string) => void;
}) {
  const now = input.now ?? Date.now;
  const log = input.log ?? ((line: string) => console.warn(line));
  const activity = () => input.activity?.().join(',') || 'idle';
  const heap = input.heap ?? process.memoryUsage;
  const readAttribution = (): MemoryAttribution => {
    const usage = heap();
    return {
      heap_size_mb: usage.heapUsed, heap_capacity_mb: usage.heapTotal, extra_memory_mb: usage.external,
      ...(input.readers?.() ?? { read_workers: 0, read_connections: 0 }),
      ...(usage.arrayBuffers > 0 ? { array_buffers_mb: usage.arrayBuffers } : {}),
      ...memoryPayloadCounts(input.workerPayloads?.()), ...input.sampleHolders?.(),
    };
  };
  let lastLineAt = now();
  let peak: MemoryPeak | undefined;
  const samples: Pick<MemoryFloor, 'rss' | 'anon' | 'attribution'>[] = [];
  let latest: MemoryAttribution | undefined;
  let nextSample = 0;
  let checksSinceLine = 0;
  const floor = (): MemoryFloor | undefined => {
    if (samples.length === 0) return undefined;
    let rss = Infinity;
    let anon: number | undefined = Infinity;
    let rssAttribution: MemoryAttribution | undefined;
    let anonAttribution: MemoryAttribution | undefined;
    for (const sample of samples) {
      if (sample.rss < rss) { rss = sample.rss; rssAttribution = sample.attribution; }
      if (sample.anon === undefined) anon = undefined;
      else if (anon !== undefined && sample.anon < anon) {
        anon = sample.anon;
        anonAttribution = sample.attribution;
      }
    }
    const attribution = anon === undefined ? rssAttribution : anonAttribution;
    return { rss, anon, full: samples.length === MEMORY_FLOOR_WINDOW_MAX_SAMPLES, ...(attribution && { attribution }) };
  };
  return {
    sample(memory: ProcessMemory, rss = memory.anon ?? memory.rss): void {
      latest = readAttribution();
      samples[nextSample] = { rss, anon: memory.anon, attribution: latest };
      nextSample = (nextSample + 1) % MEMORY_FLOOR_WINDOW_MAX_SAMPLES;
      if (memory.anon === undefined || (peak && memory.anon <= peak.anon)) return;
      peak = { anon: memory.anon, at: new Date(now()).toISOString(), activity: activity(), attribution: latest };
    },
    floor,
    // Called on the minute check. Counting those checks keeps timer jitter from skipping to minute six.
    dueOnMinuteCheck(): boolean { return ++checksSinceLine >= 5 || now() - lastLineAt >= MEMORY_LOG_INTERVAL_MS; },
    /** Returns the same fields for the restart line. */
    write(memory: ProcessMemory, burst?: { count: number; rss: number; floor: number; thresholdMb: number }): string {
      const at = new Date(now()).toISOString();
      if (burst) {
        log(`${at} [olympus] memory restart not taken: burst rss_mb=${mb(burst.rss)} floor_mb=${mb(burst.floor)} threshold_mb=${burst.thresholdMb}`);
      }
      const fields = memoryFields({ role: input.role, pid: process.pid,
        uptime_s: Math.floor((input.uptime ?? process.uptime)()), activity: activity(),
      }, memory, peak, floor(), burst?.count ?? 0, latest ?? readAttribution());
      log(`${at} [olympus] memory ${fields}`);
      peak = undefined;
      checksSinceLine = 0;
      lastLineAt = now();
      return `at=${at} ${fields}`;
    },
  };
}
