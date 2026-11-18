/**
 * Stall clocks for model calls that read a file (owner rule, 16 Nov 2026: a
 * call that is still producing tokens is never cancelled).
 *
 * A vision or transcription call asks the model to stream. The clock is idle
 * time, not total time: it starts when the request goes out and restarts on
 * the response's headers and on every streamed chunk, so a long page or a slow
 * model that keeps answering runs to the end, and only a model that has gone
 * silent for the window is stopped.
 *
 * Doc comments in this directory are always multi-line blocks: the
 * architecture guard reads a single-line block comment as a regex literal.
 */

import { addMemoryPayloadBytes, noteMemoryPayloadResponse } from '../../../core/memory-counters.ts';
import { untilAborted } from '../../../core/http-timeout.ts';

export interface IdleClock {
  /**
   * Aborts once the window passes with no `touch`.
   */
  signal: AbortSignal;
  touch(): void;
  clear(): void;
}

export function idleClock(windowMs: number): IdleClock {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const usable = Number.isFinite(windowMs) && windowMs > 0;
  const arm = (): void => {
    if (!usable || controller.signal.aborted) return;
    if (timer !== undefined) clearTimeout(timer);
    timer = setTimeout(() => {
      const error = new Error(`The model sent nothing for ${Math.round(windowMs / 1000)} s.`);
      error.name = 'AbortError';
      controller.abort(error);
    }, windowMs);
    (timer as { unref?: () => void }).unref?.();
  };
  arm();
  return {
    signal: controller.signal,
    touch: arm,
    clear: () => {
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
    },
  };
}

/**
 * The response as the non-streaming shape (`choices[0].message.content`),
 * whether the server streamed it (server-sent events of `choices[0].delta`)
 * or answered at once. Every streamed chunk touches the clock.
 */
export async function readChatCompletion(response: Response, clock: Pick<IdleClock, 'touch' | 'signal'>): Promise<unknown> {
  clock.touch();
  const contentType = response.headers.get('content-type') ?? '';
  if (!contentType.includes('text/event-stream') || !response.body) {
    noteMemoryPayloadResponse(response);
    return response.json();
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffered = '';
  let content = '';
  let finished = false;
  const takeLine = (line: string): void => {
    const trimmed = line.trim();
    if (!trimmed.startsWith('data:')) return;
    const data = trimmed.slice(5).trim();
    if (data === '[DONE]') {
      finished = true;
      return;
    }
    let event: { choices?: Array<{ delta?: { content?: unknown }; message?: { content?: unknown } }> };
    try {
      event = JSON.parse(data);
    } catch {
      return;
    }
    const piece = event.choices?.[0]?.delta?.content ?? event.choices?.[0]?.message?.content;
    if (typeof piece === 'string') content += piece;
  };
  while (!finished) {
    let next: Awaited<ReturnType<typeof reader.read>>;
    try {
      // Raced against the clock: a stream that ignores the abort still ends at the window.
      next = await untilAborted(reader.read(), clock.signal);
    } catch (error) {
      reader.cancel().catch(() => undefined);
      throw error;
    }
    const { done, value } = next;
    if (done) break;
    addMemoryPayloadBytes(value.byteLength);
    clock.touch();
    buffered += decoder.decode(value, { stream: true });
    let newline = buffered.indexOf('\n');
    while (newline >= 0) {
      takeLine(buffered.slice(0, newline));
      buffered = buffered.slice(newline + 1);
      newline = buffered.indexOf('\n');
    }
  }
  if (buffered) takeLine(buffered);
  if (finished) await reader.cancel().catch(() => undefined);
  return { choices: [{ message: { content } }] };
}
