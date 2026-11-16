import { describe, expect, test } from 'bun:test';
import { defaultConfig } from '../src/core/config.ts';
import { DelphiClient, DirectHttpDelphiTransport } from '../src/core/delphi.ts';
import { createOpenAICompatibleAnalystModel } from '../src/core/analyst-openai.ts';
import { createAnthropicAnalystModel } from '../src/core/analyst-anthropic.ts';
import { fetchStreamingModel, withModelProgress } from '../src/core/model-stream.ts';

const request = { system: 'Return the supplied value.', prompt: 'Synthetic input.', localOnly: false };
const modelId = 'synthetic-model';
const encode = new TextEncoder();

function streamingResponse(parts: string[], gapMs = 20): Response {
  let index = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  return new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      const send = () => {
        if (index === parts.length) { controller.close(); return; }
        controller.enqueue(encode.encode(parts[index++]!));
        timer = setTimeout(send, gapMs);
      };
      send();
    },
    cancel() { clearTimeout(timer); },
  }), { headers: { 'content-type': 'text/event-stream' } });
}

function chunks(): string[] {
  return [...Array.from({ length: 8 }, () => `data: ${JSON.stringify({ model: modelId, choices: [{ delta: { content: 'x' } }] })}\n\n`),
    'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"completion_tokens":8}}\n\n',
    'data: [DONE]\n\n'];
}

for (const backend of ['delphi', 'openai'] as const) {
  describe(`${backend} streaming idle limit`, () => {
    function complete(fetchImpl: (url: string, init: RequestInit) => Promise<Response>, signal?: AbortSignal) {
      if (backend === 'delphi') return new DelphiClient(defaultConfig(), new DirectHttpDelphiTransport(fetchImpl, 100))
        .complete({ model: modelId, prompt: request.prompt, ...(signal ? { signal } : {}) });
      return createOpenAICompatibleAnalystModel({ model: modelId, apiKey: 'synthetic-key', timeoutMs: 100, fetchImpl })
        .complete({ ...request, ...(signal ? { signal } : {}) });
    }

    test('tokens continue past the former total clock and preserve content', async () => {
      let bytes = 0;
      const started = Date.now();
      const result = await withModelProgress(() => { bytes++; }, () => complete(async (_url, init) => {
        expect(JSON.parse(String(init.body)).stream).toBe(true);
        return streamingResponse(chunks());
      }));
      expect(result.text).toBe('xxxxxxxx');
      expect(Date.now() - started).toBeGreaterThan(100);
      expect(bytes).toBeGreaterThan(8);
    });

    test('a silent stream stops and names the model even if fetch ignores abort', async () => {
      await expect(complete(async () => new Response(new ReadableStream(), {
        headers: { 'content-type': 'text/event-stream' },
      }))).rejects.toThrow(`Model ${modelId} timed out: no progress for 100ms`);
    });

    test('caller cancellation remains an AbortError during generation', async () => {
      const controller = new AbortController();
      const reason = new DOMException('Synthetic cancellation.', 'AbortError');
      const work = complete(async () => streamingResponse(chunks()), controller.signal);
      const timer = setTimeout(() => controller.abort(reason), 40);
      try { await expect(work).rejects.toBe(reason); }
      finally { clearTimeout(timer); }
    });
  });
}

test('SSE preserves split UTF-8, CRLF, reasoning, model and usage', async () => {
  const wire = 'data: {"model":"resolved-model","choices":[{"delta":{"reasoning_content":"thinking"}}]}\r\n\r\n'
    + 'data: {"choices":[{"delta":{"content":"é"}}]}\r\n\r\n'
    + 'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"completion_tokens":1}}\r\n\r\n'
    + 'data: [DONE]\r\n\r\n';
  const data = encode.encode(wire);
  const response = await fetchStreamingModel(async () => new Response(new ReadableStream({
    start(controller) { for (const byte of data) controller.enqueue(new Uint8Array([byte])); controller.close(); },
  }), { headers: { 'content-type': 'text/event-stream' } }), 'http://127.0.0.1/v1/chat/completions', {}, modelId, 100);
  expect(await response.json()).toMatchObject({ model: 'resolved-model', usage: { completion_tokens: 1 },
    choices: [{ message: { content: 'é', reasoning: 'thinking' }, finish_reason: 'stop' }] });
});

test('Anthropic streams text deltas with the same idle semantics', async () => {
  const model = createAnthropicAnalystModel({ apiKey: 'synthetic-key', model: modelId, timeoutMs: 100,
    fetchImpl: async (_url, init) => {
      expect(JSON.parse(String(init.body)).stream).toBe(true);
      return streamingResponse([
        'data: {"type":"message_start","message":{"model":"resolved-model"}}\n\n',
        ...Array.from({ length: 8 }, () => 'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"x"}}\n\n'),
        'data: {"type":"message_stop"}\n\n',
      ]);
    },
  });
  expect(await model.complete(request)).toEqual({ text: 'xxxxxxxx', modelId: 'resolved-model' });
});

test('real HTTP SSE completes after several idle periods of elapsed time', async () => {
  const server = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => streamingResponse(chunks()) });
  try {
    const model = createOpenAICompatibleAnalystModel({ apiKey: 'synthetic-key', model: modelId,
      baseUrl: `http://127.0.0.1:${server.port}/v1`, timeoutMs: 100 });
    expect((await model.complete(request)).text).toBe('xxxxxxxx');
  } finally { await server.stop(true); }
});

test('a truncated stream fails without replaying a partially generated answer', async () => {
  let calls = 0;
  const client = new DelphiClient(defaultConfig(), new DirectHttpDelphiTransport(async () => {
    calls++;
    return streamingResponse(chunks().slice(0, 2));
  }, 100));
  await expect(client.complete({ model: modelId, prompt: request.prompt })).rejects.toThrow('stream failed before completion');
  expect(calls).toBe(1);
});

test('private analysis and claim clocks follow model progress beyond their old total', async () => {
  const { PrivateAnswerJobs } = await import('../src/workers/chatgpt/private-answer-jobs.ts');
  const { generatePanelKeyPair } = await import('../src/workers/chatgpt/private-answer-crypto.ts');
  const evidence = [{ id: 'synthetic-item', trust_domain: 'secure_local' }];
  let resets = 0;
  const jobs = new PrivateAnswerJobs({
    installId: () => 'a'.repeat(32), eligible: async items => items.map(() => true),
    analysisTimeoutMs: 100, fullAnalysisTimeoutMs: 100, claimHoldMs: 1000,
    precompute: false, log: () => {}, audit: () => {},
    model: () => ({ status: () => ({ state: 'ready' }), reset: async () => { resets++; },
      async answerPrivately() {
        await fetchStreamingModel(async () => streamingResponse(chunks()),
          'http://127.0.0.1/v1/chat/completions', {}, modelId, 100);
        return { answer: 'Synthetic result.', citations: [] };
      },
    }),
  });
  const job = jobs.begin({ question: 'Synthetic input.', count: 1, evidence, refresh: async () => evidence });
  const panel = await generatePanelKeyPair();
  const result = await jobs.claim(job.jobId!, panel.publicKey);
  expect(result.body.status).toBe('ready');
  expect(resets).toBe(0);
});
