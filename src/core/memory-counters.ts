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
const payloadScope = new AsyncLocalStorage<(bytes: number) => void>();

/** Count logical payload sizes at their existing materialization points. */
export async function withMemoryPayload<T>(kind: keyof typeof payloads, run: () => Promise<T>): Promise<T> {
  const counter = payloads[kind];
  let bytes = 0;
  let active = true;
  counter.count++;
  try {
    return await payloadScope.run(delta => {
      if (!active) return;
      bytes += delta;
      counter.bytes += delta;
    }, run);
  } finally {
    active = false;
    counter.count--;
    counter.bytes -= bytes;
  }
}

export function addMemoryPayloadBytes(bytes: number): void {
  payloadScope.getStore()?.(bytes);
}

/** Capture the owner before subscribing to callbacks dispatched by an external handle. */
export function memoryPayloadByteCounter() {
  return payloadScope.getStore();
}

export function addMemoryPayloadText(text: string): void {
  const add = payloadScope.getStore();
  if (add) add(Buffer.byteLength(text));
}

export function memoryPayloadJson(value: object): string {
  const json = JSON.stringify(value);
  addMemoryPayloadText(json);
  return json;
}

/** Fetch's native body buffer has no byte counter. Use its declared size when present. */
export function noteMemoryPayloadResponse(response: Response): void {
  const bytes = Number(response.headers.get('content-length'));
  if (Number.isSafeInteger(bytes) && bytes > 0) addMemoryPayloadBytes(bytes);
}

export function memoryPayloadCounts() {
  return {
    judge_payloads: payloads.judge.count, judge_payload_bytes: payloads.judge.bytes,
    embed_payloads: payloads.embed.count, embed_payload_bytes: payloads.embed.bytes,
    extract_payloads: payloads.extract.count, extract_payload_bytes: payloads.extract.bytes,
  };
}
export type MemoryActivity = 'judging' | 'embedding' | 'recount' | 'import' | 'extract' | 'idle';
const scopedActivity = {
  visibility_rebuild_bootstrap: 0,
  visibility_rebuild_incremental: 0,
  people_refresh: 0,
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
  if (scopedActivity.visibility_rebuild_bootstrap > 0) labels.push('visibility_rebuild_bootstrap');
  if (scopedActivity.visibility_rebuild_incremental > 0) labels.push('visibility_rebuild_incremental');
  if (scopedActivity.people_refresh > 0) labels.push('people_refresh');
  return labels.length ? labels : ['idle'];
}
