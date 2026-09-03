import { describe, expect, test } from 'bun:test';
import { createAnthropicAnalystModel, type AnthropicAnalystFetch } from '../src/core/analyst-anthropic.ts';
import type { AnalystModelRequest } from '../src/core/analyst.ts';

const BASE_REQUEST: AnalystModelRequest = {
  system: 'You are an evidence analyst.',
  prompt: 'Question: what is the answer?\n\nEvidence:\n[1] doc',
  localOnly: false,
};

function jsonAnswerResponse(): Response {
  const content = JSON.stringify({
    answer: 'Anthropic answer.',
    citations: [{ evidence: 1, claim: 'Anthropic claim' }],
    unanswered: [],
    sufficient: true,
  });
  return new Response(
    JSON.stringify({ model: 'claude-sonnet-4-5', content: [{ type: 'text', text: content }] }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  );
}

describe('createAnthropicAnalystModel', () => {
  test('sends Anthropic messages API shape without bearer auth', async () => {
    const captured: Array<{
      url: string;
      body: Record<string, unknown>;
      headers: Record<string, string>;
    }> = [];
    const fetchImpl: AnthropicAnalystFetch = async (url, init) => {
      captured.push({
        url,
        body: JSON.parse(String(init.body)) as Record<string, unknown>,
        headers: init.headers as Record<string, string>,
      });
      return jsonAnswerResponse();
    };
    const model = createAnthropicAnalystModel({
      apiKey: 'anthropic-test',
      model: 'claude-sonnet-4-5',
      baseUrl: 'https://api.anthropic.com/',
      fetchImpl,
    });

    const completion = await model.complete(BASE_REQUEST);

    expect(captured).toHaveLength(1);
    expect(captured[0]!.url).toBe('https://api.anthropic.com/v1/messages');
    expect(captured[0]!.headers['x-api-key']).toBe('anthropic-test');
    expect(captured[0]!.headers.Authorization).toBeUndefined();
    expect(captured[0]!.body).toMatchObject({
      model: 'claude-sonnet-4-5',
      system: BASE_REQUEST.system,
      messages: [{ role: 'user', content: BASE_REQUEST.prompt }],
    });
    expect(completion.modelId).toBe('claude-sonnet-4-5');
    expect(completion.text).toContain('Anthropic answer');
  });
});
