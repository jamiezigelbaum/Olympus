import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { redactLogLine } from './log-redaction.ts';

const BACKGROUND_POINTS = [
  'bg_socket_received', 'bg_received', 'queue_enter', 'queue_admit',
  'http_sent', 'first_sse', 'last_sse', 'bg_result_posted',
] as const;
const POINTS = ['guards_done', 'forward_sent', ...BACKGROUND_POINTS, 'front_result', 'main_end'] as const;
type Point = typeof POINTS[number];
type Stage = 'main' | 'audit';
const CALLERS = ['keyword_translation', 'tier_sniffer', 'private_answer', 'untagged'] as const;
const PRIORITIES = ['owner', 'background', 'maintenance'] as const;
export type ModelQueueOccupant = { priority: typeof PRIORITIES[number]; caller: typeof CALLERS[number] };

export interface ModelCallTraceStart { id: string; startedAt: number }
export interface ModelCallTrace extends ModelCallTraceStart {
  offsets: Partial<Record<Point, number>>;
  queuedBehind?: readonly ModelQueueOccupant[];
  bgLoopLagMaxMs?: number;
}

const active = new AsyncLocalStorage<ModelCallTrace | undefined>();
export const currentModelCallTrace = () => active.getStore();
export const withModelCallTrace = <T>(trace: ModelCallTrace | undefined, run: () => T): T => active.run(trace, run);

// The same host clock across processes and the control thread. Within a
// process it advances monotonically, including when the loop is blocked.
export const modelTraceClock = (): number => performance.timeOrigin + performance.now();
export const startModelCallTrace = (): ModelCallTrace => ({ id: randomUUID(), startedAt: modelTraceClock(), offsets: {} });

export function readModelCallTraceStart(value: unknown): ModelCallTrace | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const { id, startedAt } = value as Partial<ModelCallTraceStart>;
  if (typeof id !== 'string' || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(id)
    || typeof startedAt !== 'number' || !Number.isFinite(startedAt) || startedAt <= 0) return undefined;
  return { id, startedAt, offsets: {} };
}

export function markModelCall(point: Point, trace = currentModelCallTrace(), at?: number): void {
  if (trace) trace.offsets[point] = Math.max(0, Math.round((at ?? modelTraceClock()) - trace.startedAt));
}

/** The front accepts only timing numbers and fixed caller tags for its own call. */
export function mergeBackgroundModelTrace(trace: ModelCallTrace, value: unknown): void {
  if (!value || typeof value !== 'object') return;
  const background = value as Partial<ModelCallTrace>;
  if (background.id !== trace.id) return;
  for (const point of BACKGROUND_POINTS) {
    const ms = background.offsets?.[point];
    if (typeof ms === 'number' && Number.isFinite(ms) && ms >= 0) trace.offsets[point] = ms;
  }
  const lag = background.bgLoopLagMaxMs;
  if (typeof lag === 'number' && Number.isFinite(lag) && lag >= 0) trace.bgLoopLagMaxMs = lag;
  if (Array.isArray(background.queuedBehind)) {
    trace.queuedBehind = background.queuedBehind.flatMap((entry: ModelQueueOccupant) =>
      PRIORITIES.includes(entry?.priority) && CALLERS.includes(entry?.caller)
        ? [{ priority: entry.priority, caller: entry.caller }] : []);
  }
}

export function logModelCallTrace(trace: ModelCallTrace, stage: Stage, ok: boolean): void {
  const offsets = Object.fromEntries(POINTS.map(point => [point, trace.offsets[point] ?? null]));
  const line = JSON.stringify({
    call_id: trace.id, stage, ok, main_start: 0, ...offsets,
    queued_behind: trace.queuedBehind ?? [], bg_loop_lag_max_ms: trace.bgLoopLagMaxMs ?? null,
  });
  console.log(redactLogLine(`[private-model-call] ${line}`));
}
