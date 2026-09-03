// OpenAI-compatible AnalystModel adapter (the cloud reasoning lane).
//
// Proves the wire contract a frontier /chat/completions endpoint sees: model,
// reasoning_effort, service_tier, system+user messages, maxOutputChars ->
// max_tokens, and that transport/HTTP failures surface as a clear
// OperationError (so the routing layer can fall back to local).

import { describe, expect, test } from 'bun:test';
import { OperationError } from '../src/core/operation-error.ts';
import {
  createOpenAICompatibleAnalystModel,
  type OpenAIAnalystFetch,
} from '../src/core/analyst-openai.ts';
import type { AnalystModelRequest } from '../src/core/analyst.ts';

const BASE_REQUEST: AnalystModelRequest = {
  system: 'You are an evidence analyst.',
  prompt: 'Question: what is the answer?\n\nEvidence:\n[1] doc',
  localOnly: false,
};

// Captures the single POST so the test can assert the request shape.
interface Captured {
  url: string;
  body: Record<string, unknown>;
  headers: Record<string, string>;
}

function fakeFetch(
  responder: () => Response,
): { fetchImpl: OpenAIAnalystFetch; captured: Captured[] } {
  const captured: Captured[] = [];
  const fetchImpl: OpenAIAnalystFetch = async (url, init) => {
    captured.push({
      url,
      body: JSON.parse(String(init.body)) as Record<string, unknown>,
      headers: init.headers as Record<string, string>,
    });
    return responder();
  };
  return { fetchImpl, captured };
}

function jsonAnswerResponse(): Response {
  // The analyst answer object createAnalyst() expects — returned as the model
  // message content (a JSON string), itself wrapped in the chat/completions
  // envelope.
  const content = JSON.stringify({
    answer: 'The answer is 42.',
    citations: [{ evidence: 1, claim: '42' }],
    unanswered: [],
    sufficient: true,
  });
  return new Response(
    JSON.stringify({ model: 'gpt-5.5', choices: [{ message: { content } }] }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  );
}

describe('createOpenAICompatibleAnalystModel', () => {
  test('sends model, reasoning_effort, service_tier, and system+user messages', async () => {
    const { fetchImpl, captured } = fakeFetch(jsonAnswerResponse);
    const model = createOpenAICompatibleAnalystModel({
      apiKey: 'sk-test',
      model: 'gpt-5.5',
      reasoningEffort: 'high',
      serviceTier: 'priority',
      fetchImpl,
    });

    const completion = await model.complete(BASE_REQUEST);

    expect(captured).toHaveLength(1);
    const { url, body, headers } = captured[0]!;
    expect(url).toBe('https://api.openai.com/v1/chat/completions');
    expect(headers.Authorization).toBe('Bearer sk-test');
    expect(body.model).toBe('gpt-5.5');
    expect(body.reasoning_effort).toBe('high');
    expect(body.service_tier).toBe('priority');
    const messages = body.messages as Array<{ role: string; content: string }>;
    expect(messages).toHaveLength(2);
    expect(messages[0]).toMatchObject({ role: 'system', content: BASE_REQUEST.system });
    expect(messages[1]).toMatchObject({ role: 'user', content: BASE_REQUEST.prompt });

    // createAnalyst() owns parsing; the model just returns text + modelId.
    expect(completion.modelId).toBe('gpt-5.5');
    expect(completion.text).toContain('"answer"');
  });

  test('applies defaults (model, base url, reasoning_effort, service_tier)', async () => {
    const { fetchImpl, captured } = fakeFetch(jsonAnswerResponse);
    const model = createOpenAICompatibleAnalystModel({ apiKey: 'sk-test', fetchImpl });

    await model.complete(BASE_REQUEST);

    const { url, body } = captured[0]!;
    expect(url).toBe('https://api.openai.com/v1/chat/completions');
    expect(body.model).toBe('gpt-5.5');
    expect(body.reasoning_effort).toBe('high');
    expect(body.service_tier).toBe('priority');
  });

  test('maxOutputChars passes through to max_tokens (floored)', async () => {
    const { fetchImpl, captured } = fakeFetch(jsonAnswerResponse);
    const model = createOpenAICompatibleAnalystModel({ apiKey: 'sk-test', fetchImpl });

    // 9000 chars / 3 = 3000 tokens.
    await model.complete({ ...BASE_REQUEST, maxOutputChars: 9000 });
    expect(captured[0]!.body.max_tokens).toBe(3000);

    // A tiny budget is floored to 256 so the JSON object never truncates.
    await model.complete({ ...BASE_REQUEST, maxOutputChars: 30 });
    expect(captured[1]!.body.max_tokens).toBe(256);
  });

  test('can send max_completion_tokens for providers that use the newer field', async () => {
    const { fetchImpl, captured } = fakeFetch(jsonAnswerResponse);
    const model = createOpenAICompatibleAnalystModel({
      apiKey: 'sk-test',
      maxTokensField: 'max_completion_tokens',
      fetchImpl,
    });

    await model.complete({ ...BASE_REQUEST, maxOutputChars: 9000 });
    expect(captured[0]!.body.max_completion_tokens).toBe(3000);
    expect('max_tokens' in captured[0]!.body).toBe(false);
  });

  test('reasoningHeadroomTokens opt-in floors completion tokens for reasoning models', async () => {
    const { fetchImpl, captured } = fakeFetch(jsonAnswerResponse);
    const model = createOpenAICompatibleAnalystModel({
      apiKey: 'sk-test',
      maxTokensField: 'max_completion_tokens',
      reasoningEffort: 'high',
      reasoningHeadroomTokens: 8192,
      fetchImpl,
    });

    await model.complete({ ...BASE_REQUEST, maxOutputChars: 1600 });
    expect(captured[0]!.body.max_completion_tokens).toBe(8192);
  });

  test('reasoningHeadroomTokens is ignored when reasoning is disabled', async () => {
    const { fetchImpl, captured } = fakeFetch(jsonAnswerResponse);
    const model = createOpenAICompatibleAnalystModel({
      apiKey: 'sk-test',
      maxTokensField: 'max_completion_tokens',
      reasoningEffort: 'none',
      reasoningHeadroomTokens: 8192,
      fetchImpl,
    });

    await model.complete({ ...BASE_REQUEST, maxOutputChars: 1600 });
    expect(captured[0]!.body.max_completion_tokens).toBe(534);
  });

  test('omits max_tokens when no maxOutputChars is given', async () => {
    const { fetchImpl, captured } = fakeFetch(jsonAnswerResponse);
    const model = createOpenAICompatibleAnalystModel({ apiKey: 'sk-test', fetchImpl });

    await model.complete(BASE_REQUEST);
    expect('max_tokens' in captured[0]!.body).toBe(false);
  });

  test('honors a custom baseUrl (trailing slash trimmed)', async () => {
    const { fetchImpl, captured } = fakeFetch(jsonAnswerResponse);
    const model = createOpenAICompatibleAnalystModel({
      apiKey: 'sk-test',
      baseUrl: 'https://castor.internal/v1/',
      fetchImpl,
    });

    await model.complete(BASE_REQUEST);
    expect(captured[0]!.url).toBe('https://castor.internal/v1/chat/completions');
  });

  test('can omit service_tier and merge provider-specific body fields', async () => {
    const { fetchImpl, captured } = fakeFetch(jsonAnswerResponse);
    const model = createOpenAICompatibleAnalystModel({
      apiKey: 'sk-test',
      serviceTier: false,
      extraBody: {
        venice_parameters: { enable_web_search: 'off' },
      },
      fetchImpl,
    });

    await model.complete(BASE_REQUEST);
    expect('service_tier' in captured[0]!.body).toBe(false);
    expect(captured[0]!.body.venice_parameters).toEqual({ enable_web_search: 'off' });
  });

  test('transport failure throws a clear OperationError', async () => {
    const fetchImpl: OpenAIAnalystFetch = async () => {
      throw new Error('ECONNREFUSED');
    };
    const model = createOpenAICompatibleAnalystModel({ apiKey: 'sk-test', fetchImpl });

    await expect(model.complete(BASE_REQUEST)).rejects.toBeInstanceOf(OperationError);
    await expect(model.complete(BASE_REQUEST)).rejects.toMatchObject({
      code: 'source_index_error',
    });
  });

  test('non-2xx HTTP throws a clear OperationError with status', async () => {
    const fetchImpl: OpenAIAnalystFetch = async () =>
      new Response('rate limited', { status: 429 });
    const model = createOpenAICompatibleAnalystModel({ apiKey: 'sk-test', fetchImpl });

    await expect(model.complete(BASE_REQUEST)).rejects.toMatchObject({
      code: 'source_index_error',
      message: expect.stringContaining('429'),
    });
  });

  test('missing message content throws OperationError', async () => {
    const fetchImpl: OpenAIAnalystFetch = async () =>
      new Response(JSON.stringify({ choices: [{}] }), { status: 200 });
    const model = createOpenAICompatibleAnalystModel({ apiKey: 'sk-test', fetchImpl });

    await expect(model.complete(BASE_REQUEST)).rejects.toMatchObject({
      code: 'source_index_error',
    });
  });

  test('empty content with reasoning and length finish_reason explains reasoning budget exhaustion', async () => {
    const fetchImpl: OpenAIAnalystFetch = async () =>
      new Response(JSON.stringify({
        choices: [{
          finish_reason: 'length',
          message: {
            content: '',
            reasoning: 'provider-side thinking omitted from final answer',
          },
        }],
      }), { status: 200 });
    const model = createOpenAICompatibleAnalystModel({
      apiKey: 'sk-test',
      providerLabel: 'Venice analyst',
      model: 'e2ee-glm-5-2-p',
      fetchImpl,
    });

    await expect(model.complete(BASE_REQUEST)).rejects.toMatchObject({
      code: 'source_index_error',
      message: expect.stringContaining('completion budget exhausted during reasoning (finish_reason=length)'),
    });
  });

  test('an empty apiKey is a config_error at construction', () => {
    expect(() => createOpenAICompatibleAnalystModel({ apiKey: '   ' })).toThrow(OperationError);
  });
});
