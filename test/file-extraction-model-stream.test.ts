import { describe, expect, test } from 'bun:test';
import { idleClock, readChatCompletion } from '../src/workers/file-extraction/extractors/model-stream.ts';

/** Server-sent events, one token every 25 ms, for 10 tokens: a model still answering. */
function streamedAnswer(tokens = 10, everyMs = 25, finish = true): Response {
  let sent = 0;
  let timer: ReturnType<typeof setInterval> | undefined;
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      timer = setInterval(() => {
        if (sent < tokens) {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: `w${sent} ` } }] })}\n\n`));
          sent += 1;
          return;
        }
        clearInterval(timer);
        if (!finish) return;
        controller.enqueue(encoder.encode('data: [DONE]\n\n'));
        controller.close();
      }, everyMs);
    },
    cancel() {
      clearInterval(timer);
    },
  });
  return new Response(body, { headers: { 'content-type': 'text/event-stream' } });
}

describe('model calls stop only on silence', () => {
  test('a streamed answer that runs past the window arrives whole', async () => {
    const clock = idleClock(120);
    try {
      const payload = await readChatCompletion(streamedAnswer(), clock) as { choices: Array<{ message: { content: string } }> };
      expect(payload.choices[0]!.message.content.trim().split(' ')).toHaveLength(10);
      expect(clock.signal.aborted).toBe(false);
    } finally {
      clock.clear();
    }
  });

  test('a stream that goes silent is stopped one window after its last token, naming the silence', async () => {
    const clock = idleClock(80);
    try {
      const failure = await readChatCompletion(streamedAnswer(3, 10, false), clock).then(() => undefined, (error: unknown) => error);
      expect((failure as Error).name).toBe('AbortError');
      expect((failure as Error).message).toContain('sent nothing');
    } finally {
      clock.clear();
    }
  });

  test('a server that answers at once with JSON still reads', async () => {
    const clock = idleClock(1_000);
    try {
      const payload = await readChatCompletion(Response.json({ choices: [{ message: { content: 'whole' } }] }), clock);
      expect(payload).toEqual({ choices: [{ message: { content: 'whole' } }] });
    } finally {
      clock.clear();
    }
  });
});
