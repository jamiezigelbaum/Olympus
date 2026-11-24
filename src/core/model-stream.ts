import { addMemoryPayloadBytes, addMemoryPayloadText } from './memory-counters.ts';
import { AsyncLocalStorage } from 'node:async_hooks';
import { fetchModelEndpoint, type ModelTransportFetch } from './model-transport.ts';
import { noteSourceAnswerProgress } from './source-answer-jobs.ts';

export const MODEL_IDLE_TIMEOUT_MS = 60_000;
const progress = new AsyncLocalStorage<(model: string) => void>();

/** Nested clocks all observe the same model bytes, without mixing concurrent answers. */
export function withModelProgress<T>(listener: (model: string) => void, work: () => T): T {
  const parent = progress.getStore();
  return progress.run(model => { parent?.(model); listener(model); }, work);
}

/** Tell the current clocks that the model made progress somewhere they cannot see (another process). */
export function noteModelProgress(model: string): void {
  progress.getStore()?.(model);
}

export class ModelStreamError extends Error {
  constructor(readonly model: string) {
    super(`Model ${model} stream failed before completion.`);
  }
}

export class ModelIdleError extends Error {
  constructor(model: string, idleMs: number) {
    super(`Model ${model} timed out: no progress for ${idleMs}ms.`);
    this.name = 'AbortError';
  }
}

/** Read SSE incrementally, retaining the ordinary completion envelope for existing callers. */
export async function fetchStreamingModel(
  fetchImpl: ModelTransportFetch, url: string, init: RequestInit,
  model: string, idleMs = MODEL_IDLE_TIMEOUT_MS,
): Promise<Response> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let rejectStopped: (reason: unknown) => void = () => {};
  const stopped = new Promise<never>((_, reject) => { rejectStopped = reject; });
  stopped.catch(() => {});
  const stop = (reason: unknown) => { rejectStopped(reason); controller.abort(reason); };
  const follow = () => stop(init.signal?.reason);
  const arm = () => {
    clearTimeout(timer);
    if (idleMs > 0) timer = setTimeout(() => stop(new ModelIdleError(model, idleMs)), idleMs);
  };
  if (init.signal?.aborted) follow();
  else init.signal?.addEventListener('abort', follow, { once: true });
  arm();
  progress.getStore()?.(model);
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let lastNote = -Infinity;
  const token = () => {
    if (Date.now() - lastNote >= 1000) {
      lastNote = Date.now();
      noteSourceAnswerProgress('writing the answer');
    }
  };
  try {
    if (typeof init.body === 'string') addMemoryPayloadText(init.body);
    const response = await Promise.race([fetchModelEndpoint(fetchImpl, url, { ...init, signal: controller.signal }), stopped]);
    if (!response.body) return response;
    reader = response.body.getReader();
    const sse = response.ok && response.headers.get('content-type')?.includes('text/event-stream');
    const decoder = new TextDecoder();
    let buffer = '';
    let raw = '';
    let content = '';
    let reasoning = '';
    let resolvedModel = model;
    let finish: unknown;
    let usage: unknown;
    let timings: unknown;
    let done = false;
    const event = (block: string) => {
      const data = block.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
      if (!data) return;
      if (data.trim() === '[DONE]') { done = true; return; }
      const parsed = JSON.parse(data);
      if (parsed.error || parsed.type === 'error') throw new Error('Model stream reported an error.');
      resolvedModel = parsed.model ?? parsed.message?.model ?? resolvedModel;
      usage = parsed.usage ?? usage;
      timings = parsed.timings ?? timings;
      const choice = parsed.choices?.[0];
      const delta = choice?.delta;
      const text = delta?.content ?? (parsed.type === 'content_block_delta' ? parsed.delta?.text : undefined);
      const thought = delta?.reasoning_content ?? delta?.reasoning ?? parsed.delta?.thinking;
      if (typeof text === 'string') { content += text; if (text) token(); }
      if (typeof thought === 'string') { reasoning += thought; if (thought) token(); }
      finish = choice?.finish_reason ?? finish;
      if (parsed.type === 'message_stop') done = true;
    };
    while (!done) {
      let next: Awaited<ReturnType<typeof reader.read>>;
      try {
        next = await Promise.race([reader.read(), stopped]);
      } catch (error) {
        // Keep HTTP failures categorical even if their optional detail body stalls.
        if (!response.ok && error instanceof ModelIdleError) return new Response(null, { status: response.status });
        throw error;
      }
      if (next.done) break;
      addMemoryPayloadBytes(next.value.byteLength);
      if (next.value.byteLength) { arm(); progress.getStore()?.(model); }
      const text = decoder.decode(next.value, { stream: true });
      if (!sse) { raw += text; continue; }
      buffer += text;
      buffer = buffer.replace(/\r\n/g, '\n');
      let end: number;
      while ((end = buffer.indexOf('\n\n')) >= 0) {
        event(buffer.slice(0, end));
        buffer = buffer.slice(end + 2);
        if (done) break;
      }
    }
    const tail = decoder.decode();
    if (sse) {
      buffer += tail;
      if (!done && buffer.trim()) event(buffer);
      if (!done && finish == null) throw new Error('Model stream ended before completion.');
      raw = JSON.stringify({ model: resolvedModel, usage, timings,
        choices: [{ message: { content, ...(reasoning ? { reasoning } : {}) }, finish_reason: finish }],
        content: [{ type: 'text', text: content }],
      });
    } else raw += tail;
    return new Response(raw, { status: response.status, statusText: response.statusText,
      headers: { 'content-type': sse ? 'application/json' : response.headers.get('content-type') ?? 'application/json' } });
  } catch (error) {
    if (reader && !controller.signal.aborted) throw new ModelStreamError(model);
    throw error;
  } finally {
    clearTimeout(timer);
    init.signal?.removeEventListener('abort', follow);
    if (reader) void reader.cancel().catch(() => {});
  }
}
