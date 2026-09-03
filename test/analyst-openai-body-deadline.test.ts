// The adapter's timeoutMs must bound the whole exchange, not only the header
// phase. A peer that returns 200 headers and then stalls the body is the case
// that hangs a cloud analyst leg with no caller budget behind it.

import { describe, expect, test } from 'bun:test';
import { OperationError } from '../src/core/operation-error.ts';
import { createOpenAICompatibleAnalystModel } from '../src/core/analyst-openai.ts';
import type { AnalystModelRequest } from '../src/core/analyst.ts';

const BASE_REQUEST: AnalystModelRequest = {
  system: 'You are an evidence analyst.',
  prompt: 'Question: what is the answer?\n\nEvidence:\n[1] doc',
  localOnly: false,
};

// Mirrors fetch semantics: the body stream fails only when the request signal
// aborts, so an adapter that has already unhooked its deadline waits forever.
function stalledBodyResponse(signal: AbortSignal | null | undefined, status = 200): Response {
  const stream = new ReadableStream({
    start(controller) {
      signal?.addEventListener('abort', () => {
        controller.error(new DOMException('The operation was aborted.', 'AbortError'));
      }, { once: true });
    },
  });
  return new Response(stream, { status, headers: { 'Content-Type': 'application/json' } });
}

async function settledWithin<T>(work: Promise<T>, ms: number): Promise<T | OperationError | 'hung'> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work.catch((error: unknown) => error as OperationError),
      new Promise<'hung'>((resolve) => {
        timer = setTimeout(() => resolve('hung'), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

describe('OpenAI-compatible analyst deadline', () => {
  test('a stalled response body fails at timeoutMs instead of hanging', async () => {
    const model = createOpenAICompatibleAnalystModel({
      apiKey: 'test-key',
      timeoutMs: 50,
      fetchImpl: async (_url, init) => stalledBodyResponse(init.signal as AbortSignal | undefined),
    });

    const outcome = await settledWithin(model.complete(BASE_REQUEST), 2_000);

    expect(outcome).toBeInstanceOf(OperationError);
    expect((outcome as OperationError).message).toContain('did not complete within 50ms');
  });

  test('a stalled error-detail body still fails at timeoutMs', async () => {
    const model = createOpenAICompatibleAnalystModel({
      apiKey: 'test-key',
      timeoutMs: 50,
      fetchImpl: async (_url, init) => stalledBodyResponse(init.signal as AbortSignal | undefined, 500),
    });

    const outcome = await settledWithin(model.complete(BASE_REQUEST), 2_000);

    expect(outcome).toBeInstanceOf(OperationError);
    expect((outcome as OperationError).message).toContain('HTTP 500');
  });
});
