import { describe, expect, test } from 'bun:test';
import { createDelphiAnalystModel } from '../src/core/analyst-delphi.ts';
import { defaultConfig } from '../src/core/config.ts';
import { DelphiClient, type DelphiTransport } from '../src/core/delphi.ts';

interface CapturedCall {
  url: string;
  body: Record<string, unknown>;
}

function fakeDelphi(content: string): { delphi: DelphiClient; calls: CapturedCall[] } {
  const calls: CapturedCall[] = [];
  const transport: DelphiTransport = {
    async requestJson(url, init) {
      calls.push({ url, body: JSON.parse(String(init.body)) as Record<string, unknown> });
      return { choices: [{ message: { content } }], model: 'local-test-model' };
    },
  };
  return { delphi: new DelphiClient(defaultConfig(), transport), calls };
}

describe('Delphi AnalystModel adapter', () => {
  test('maps an analyst request to a Delphi chat completion on the configured lane', async () => {
    const { delphi, calls } = fakeDelphi('{"answer":"ok"}');
    const model = createDelphiAnalystModel(delphi, { lane: 'fast', preflightTimeoutMs: 0 });

    const completion = await model.complete({
      system: 'SYS',
      prompt: 'PROMPT',
      localOnly: true,
    });

    expect(completion.text).toBe('{"answer":"ok"}');
    expect(completion.modelId).toBe('local-test-model');
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(`${defaultConfig().argus.lanes.fast.baseUrl}/chat/completions`);
    expect(calls[0]!.body.messages).toEqual([
      { role: 'system', content: 'SYS' },
      { role: 'user', content: 'PROMPT' },
    ]);
    expect(calls[0]!.body.temperature).toBe(0);
  });

  test('derives a max_tokens budget from maxOutputChars', async () => {
    const { delphi, calls } = fakeDelphi('{}');
    const model = createDelphiAnalystModel(delphi, { lane: 'deep', preflightTimeoutMs: 0 });

    await model.complete({ system: 'S', prompt: 'P', localOnly: false, maxOutputChars: 900 });

    expect(calls[0]!.url).toBe(`${defaultConfig().argus.lanes.deep.baseUrl}/chat/completions`);
    expect(calls[0]!.body.max_tokens).toBe(300);
  });

  test('omits max_tokens when no budget is given (uses the client default)', async () => {
    const { delphi, calls } = fakeDelphi('{}');
    const model = createDelphiAnalystModel(delphi, { lane: 'fast', preflightTimeoutMs: 0 });

    await model.complete({ system: 'S', prompt: 'P', localOnly: false });

    expect(calls[0]!.body.max_tokens).toBe(2048);
  });
});

describe('Delphi AnalystModel preflight', () => {
  test('fails fast with argus_unreachable when the lane does not answer', async () => {
    const transport: DelphiTransport = {
      requestJson() {
        return new Promise(() => {}); // lane accepts but never answers (loading)
      },
    };
    const delphi = new DelphiClient(defaultConfig(), transport);
    const model = createDelphiAnalystModel(delphi, { lane: 'fast', preflightTimeoutMs: 50 });

    await expect(model.complete({ system: 'S', prompt: 'P', localOnly: true })).rejects.toThrow(
      /did not answer the preflight/,
    );
  });

  test('passes the preflight and completes when the lane answers', async () => {
    const calls: string[] = [];
    const transport: DelphiTransport = {
      async requestJson(url) {
        calls.push(String(url));
        if (String(url).endsWith('/models')) return { data: [{ id: 'm' }] };
        return { choices: [{ message: { content: 'ok' } }], model: 'm' };
      },
    };
    const delphi = new DelphiClient(defaultConfig(), transport);
    const model = createDelphiAnalystModel(delphi, { lane: 'fast', preflightTimeoutMs: 1000 });

    const completion = await model.complete({ system: 'S', prompt: 'P', localOnly: false });
    expect(completion.text).toBe('ok');
    expect(calls[0]).toContain('/models');
    expect(calls[1]).toContain('/chat/completions');
  });
});
