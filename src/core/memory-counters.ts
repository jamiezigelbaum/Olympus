import { AsyncLocalStorage } from 'node:async_hooks';

/** Process-local holder sizes. Writers update at mutation sites; readers never walk or query. */
const counts = {
  connector_stores: 0,
  tier_visibility_items: 0,
  hidden_child_items: 0,
  embedding_queue: 0,
  people: 0,
  identities: 0,
  tasks_embed: 0,
  tasks_sync: 0,
  tasks_extract: 0,
  tasks_watch: 0,
};
export type MemoryCounter = keyof typeof counts;
export function changeMemoryCounter(key: MemoryCounter, delta: number): void { counts[key] += delta; }
export function memoryHolderCounts() {
  const { tasks_embed, tasks_sync, tasks_extract, tasks_watch, ...holders } = counts;
  return holders;
}

const payloads = {
  judge: { count: 0, bytes: 0 },
  embed: { count: 0, bytes: 0 },
  extract: { count: 0, bytes: 0 },
};
const payloadScope = new AsyncLocalStorage<{ kind: keyof typeof payloads; add: (bytes: number) => void; active: boolean }>();

const payloadSlots = { judge: 0, embed: 2, extract: 4 };
let workerPayloads: BigInt64Array | undefined;

export function createMemoryPayloadBuffer(): SharedArrayBuffer {
  return new SharedArrayBuffer(Object.keys(payloadSlots).length * 2 * BigInt64Array.BYTES_PER_ELEMENT);
}

/** Give the process sampler live totals even when the model worker is busy. */
export function publishWorkerMemoryPayloads(buffer: SharedArrayBuffer): void {
  workerPayloads = new BigInt64Array(buffer);
}

/** Count logical payload sizes at their existing materialization points. */
export async function withMemoryPayload<T>(kind: keyof typeof payloads, run: () => Promise<T>): Promise<T> {
  const owner = payloadScope.getStore();
  if (owner?.active && owner.kind === kind) return run();
  const counter = payloads[kind];
  const shared = workerPayloads;
  const slot = payloadSlots[kind];
  let bytes = 0;
  const scope = {
    kind,
    active: true,
    add(delta: number) {
      if (!scope.active) return;
      bytes += delta;
      counter.bytes += delta;
      if (shared) Atomics.add(shared, slot + 1, BigInt(delta));
    },
  };
  counter.count++;
  if (shared) Atomics.add(shared, slot, 1n);
  try {
    return await payloadScope.run(scope, run);
  } finally {
    scope.active = false;
    counter.count--;
    counter.bytes -= bytes;
    if (shared) {
      Atomics.sub(shared, slot + 1, BigInt(bytes));
      Atomics.sub(shared, slot, 1n);
    }
  }
}

export function addMemoryPayloadBytes(bytes: number): void {
  payloadScope.getStore()?.add(bytes);
}

/** Capture the owner before subscribing to callbacks dispatched by an external handle. */
export function memoryPayloadByteCounter() {
  return payloadScope.getStore()?.add;
}

export function addMemoryPayloadText(text: string): void {
  const add = payloadScope.getStore()?.add;
  if (add) add(Buffer.byteLength(text));
}

export function memoryPayloadJson(value: object): string {
  const json = JSON.stringify(value);
  addMemoryPayloadText(json);
  return json;
}

/**
 * Fetch's native body buffer has no byte counter. Use its declared size when present.
 * A response without readable headers counts as nothing: measuring never fails a call.
 */
export function noteMemoryPayloadResponse(response: Response): void {
  const bytes = Number((response as { headers?: { get?: (name: string) => string | null } }).headers?.get?.('content-length'));
  if (Number.isSafeInteger(bytes) && bytes > 0) addMemoryPayloadBytes(bytes);
}

export function memoryPayloadCounts(worker?: BigInt64Array) {
  const total = (kind: keyof typeof payloads, field: 'count' | 'bytes') =>
    payloads[kind][field] + (worker ? Number(Atomics.load(worker, payloadSlots[kind] + Number(field === 'bytes'))) : 0);
  return {
    judge_payloads: total('judge', 'count'), judge_payload_bytes: total('judge', 'bytes'),
    embed_payloads: total('embed', 'count'), embed_payload_bytes: total('embed', 'bytes'),
    extract_payloads: total('extract', 'count'), extract_payload_bytes: total('extract', 'bytes'),
  };
}
export type MemoryActivity = 'judging' | 'embedding' | 'recount' | 'import' | 'extract' | 'idle';
const scopedActivity = {
  visibility_rebuild_bootstrap: 0,
  visibility_rebuild_incremental: 0,
  people_refresh: 0,
  visibility_refresh: 0,
  embedding_repair: 0,
  embedding_settlement: 0,
};
type ScopedMemoryActivity = keyof typeof scopedActivity;
export type MemoryActivityLabel = MemoryActivity | ScopedMemoryActivity;

/** Count overlapping jobs independently, including while their workers reply. */
export function changeMemoryActivity(label: ScopedMemoryActivity, delta: 1 | -1): void {
  scopedActivity[label] += delta;
}

function taskActivities(judging: boolean, recount: boolean): MemoryActivity[] {
  const labels: MemoryActivity[] = [];
  if (judging) labels.push('judging');
  if (counts.tasks_embed > 0) labels.push('embedding');
  if (recount) labels.push('recount');
  if (counts.tasks_sync > 0 || counts.tasks_watch > 0) labels.push('import');
  if (counts.tasks_extract > 0) labels.push('extract');
  return labels;
}

/** The status snapshot continues to carry the primary background task. */
export function statusMemoryActivity(judging: boolean, recount: boolean): MemoryActivity {
  return taskActivities(judging, recount)[0] ?? 'idle';
}

export function memoryActivity(judging: boolean, recount: boolean, background?: MemoryActivity): MemoryActivityLabel[] {
  const labels: MemoryActivityLabel[] = background === undefined ? taskActivities(judging, recount)
    : background === 'idle' ? [] : [background];
  for (const label of Object.keys(scopedActivity) as ScopedMemoryActivity[]) {
    if (scopedActivity[label] > 0) labels.push(label);
  }
  return labels.length ? labels : ['idle'];
}
