import { describe, expect, test } from 'bun:test';
import { createVeniceAnalystModel } from '../src/core/analyst-venice.ts';
import type { AnalystModelRequest } from '../src/core/analyst.ts';
import type { OpenAIAnalystFetch } from '../src/core/analyst-openai.ts';
import { normalizeVeniceAnalystModelId } from '../src/core/venice-models.ts';

const BASE_REQUEST: AnalystModelRequest = {
  system: 'You are an evidence analyst.',
  prompt: 'Question: what is supported?\n\nEvidence:\n[1] doc',
  localOnly: false,
};

describe('createVeniceAnalystModel', () => {
  test('uses Venice chat completions with native thinking enabled by default', async () => {
    const captured: Array<{ url: string; body: Record<string, unknown> }> = [];
    const fetchImpl: OpenAIAnalystFetch = async (url, init) => {
      captured.push({
        url,
        body: JSON.parse(String(init.body)) as Record<string, unknown>,
      });
      return new Response(
        JSON.stringify({
          model: 'kimi-k3',
          choices: [{ message: { content: '{"answer":"ok","citations":[],"unanswered":[]}' } }],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    };

    const model = createVeniceAnalystModel({ apiKey: 'venice-test', fetchImpl });
    const completion = await model.complete({ ...BASE_REQUEST, maxOutputChars: 9000 });

    expect(captured[0]!.url).toBe('https://api.venice.ai/api/v1/chat/completions');
    expect(captured[0]!.body.model).toBe('kimi-k3');
    expect(captured[0]!.body.reasoning_effort).toBe('high');
    expect(captured[0]!.body.max_completion_tokens).toBe(8192);
    expect('max_tokens' in captured[0]!.body).toBe(false);
    expect('service_tier' in captured[0]!.body).toBe(false);
    expect(captured[0]!.body.venice_parameters).toEqual({
      enable_web_search: 'off',
      enable_web_scraping: false,
      enable_web_citations: false,
      include_venice_system_prompt: false,
      strip_thinking_response: true,
      disable_thinking: false,
    });
    expect(completion.modelId).toBe('kimi-k3');
  });

  test('normalizes owner-facing Venice model labels to provider ids', () => {
    expect(normalizeVeniceAnalystModelId('GLM 5.2 EE2E')).toBe('e2ee-glm-5-2-p');
    expect(normalizeVeniceAnalystModelId('faster reasoning')).toBe('inkling');
    expect(normalizeVeniceAnalystModelId('strong')).toBe('kimi-k3');
    expect(normalizeVeniceAnalystModelId('Kimi K3')).toBe('kimi-k3');
    expect(normalizeVeniceAnalystModelId('normal')).toBe('inkling');
    expect(normalizeVeniceAnalystModelId('secure vision')).toBe('kimi-k3');
    expect(normalizeVeniceAnalystModelId('qwen vision')).toBe('qwen3-vl-235b-a22b');
    expect(normalizeVeniceAnalystModelId('qwen3 vl 235b')).toBe('qwen3-vl-235b-a22b');
    expect(normalizeVeniceAnalystModelId('qwen3-vl-30b-a3b-e2ee')).toBe('e2ee-qwen3-vl-30b-a3b-p');
    expect(normalizeVeniceAnalystModelId('fast multimodal')).toBe('kimi-k3');
    expect(normalizeVeniceAnalystModelId('private Grok 4.3')).toBe('grok-4-3');
    expect(normalizeVeniceAnalystModelId('vision escalation')).toBe('kimi-k3');
    expect(normalizeVeniceAnalystModelId('private Grok 4.5')).toBe('grok-4-5');
    expect(normalizeVeniceAnalystModelId('some-other-venice-model')).toBe('some-other-venice-model');
  });

  test('only allows the approved Venice HTTPS endpoint', async () => {
    expect(() => createVeniceAnalystModel({
      apiKey: 'venice-test',
      baseUrl: 'http://api.venice.ai/api/v1',
    })).toThrow('approved Venice HTTPS endpoint');
    expect(() => createVeniceAnalystModel({
      apiKey: 'venice-test',
      baseUrl: 'http://127.0.0.1:8000/v1',
    })).toThrow('approved Venice HTTPS endpoint');
    expect(() => createVeniceAnalystModel({
      apiKey: 'venice-test',
      baseUrl: 'http://169.254.169.254/latest',
    })).toThrow('approved Venice HTTPS endpoint');
    expect(() => createVeniceAnalystModel({
      apiKey: 'venice-test',
      baseUrl: 'https://venice.example.com/api/v1',
    })).toThrow('approved Venice HTTPS endpoint');

    const captured: string[] = [];
    const fetchImpl: OpenAIAnalystFetch = async (url) => {
      captured.push(url);
      return new Response(
        JSON.stringify({
          model: 'e2ee-glm-5-2-p',
          choices: [{ message: { content: '{"answer":"ok","citations":[],"unanswered":[]}' } }],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    };
    const model = createVeniceAnalystModel({
      apiKey: 'venice-test',
      baseUrl: 'https://api.venice.ai/api/v1/',
      fetchImpl,
    });
    await model.complete(BASE_REQUEST);
    expect(captured).toEqual(['https://api.venice.ai/api/v1/chat/completions']);
  });

  test('can explicitly disable Venice thinking for a model that needs no-thinking mode', async () => {
    const captured: Array<{ body: Record<string, unknown> }> = [];
    const fetchImpl: OpenAIAnalystFetch = async (_url, init) => {
      captured.push({
        body: JSON.parse(String(init.body)) as Record<string, unknown>,
      });
      return new Response(
        JSON.stringify({
          model: 'zai-org-glm-5-1',
          choices: [{ message: { content: '{"answer":"ok","citations":[],"unanswered":[]}' } }],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    };

    const model = createVeniceAnalystModel({ apiKey: 'venice-test', thinking: 'disabled', fetchImpl });
    await model.complete(BASE_REQUEST);

    expect(captured[0]!.body.venice_parameters).toMatchObject({
      strip_thinking_response: true,
      disable_thinking: true,
    });
  });

  test('can override the Venice reasoning headroom budget', async () => {
    const captured: Array<{ body: Record<string, unknown> }> = [];
    const fetchImpl: OpenAIAnalystFetch = async (_url, init) => {
      captured.push({
        body: JSON.parse(String(init.body)) as Record<string, unknown>,
      });
      return new Response(
        JSON.stringify({
          model: 'e2ee-glm-5-2-p',
          choices: [{ message: { content: '{"answer":"ok","citations":[],"unanswered":[]}' } }],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    };

    const model = createVeniceAnalystModel({
      apiKey: 'venice-test',
      reasoningHeadroomTokens: 12_288,
      fetchImpl,
    });
    await model.complete({ ...BASE_REQUEST, maxOutputChars: 1600 });

    expect(captured[0]!.body.max_completion_tokens).toBe(12_288);
  });
});
