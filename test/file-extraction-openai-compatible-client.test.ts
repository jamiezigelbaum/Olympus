import { describe, expect, test } from 'bun:test';
import {
  OpenAICompatibleVlmClient,
  listedVlmProfileIds,
} from '../src/workers/file-extraction/extractors/openai-compatible-client.ts';
import { VlmRouterError } from '../src/workers/file-extraction/extractors/vlm.ts';

describe('shared local vision client', () => {
  test('refuses non-loopback endpoints before any bytes can leave the host', () => {
    expect(() => new OpenAICompatibleVlmClient({
      baseUrl: 'https://vision.example.com/v1',
      model: 'vision-deep',
    })).toThrow('must use a loopback HTTP(S) endpoint');
  });

  test('sends an OpenAI-compatible vision request to the pinned loopback endpoint', async () => {
    let requestUrl = '';
    let requestBody: unknown;
    const client = new OpenAICompatibleVlmClient({
      baseUrl: 'http://127.0.0.1:28090/v1/',
      model: 'delphi/vision-deep',
      fetchImpl: (async (input, init) => {
        requestUrl = String(input);
        requestBody = JSON.parse(String(init?.body));
        return Response.json({
          choices: [{ message: { content: '  Visible heading\n\nrow 1  ' } }],
        });
      }) as typeof fetch,
    });

    const result = await client.describe({
      bytes: new Uint8Array([1, 2, 3]),
      mimeType: 'image/png',
      prompt: 'Read this image.',
      maxOutputChars: 100,
      maxTokens: 222,
    });

    expect(requestUrl).toBe('http://127.0.0.1:28090/v1/chat/completions');
    expect(requestBody).toMatchObject({
      model: 'delphi/vision-deep',
      max_tokens: 222,
      chat_template_kwargs: { enable_thinking: false },
    });
    expect(JSON.stringify(requestBody)).toContain('data:image/png;base64,AQID');
    expect(result).toEqual({
      text: 'Visible heading\n\nrow 1',
      confidence: 0.65,
      warnings: ['local_private_model'],
    });
  });

  test('classifies endpoint refusal without copying response prose into the error', async () => {
    const client = new OpenAICompatibleVlmClient({
      baseUrl: 'http://localhost:28090/v1',
      model: 'vision-deep',
      fetchImpl: (async () => new Response('private document bytes echoed here', {
        status: 503,
      })) as unknown as typeof fetch,
    });

    const error = await client.describe({
      bytes: new Uint8Array([9]),
      mimeType: 'image/jpeg',
      prompt: 'Read.',
      maxOutputChars: 20,
    }).catch((caught) => caught);

    expect(error).toBeInstanceOf(VlmRouterError);
    expect(error.errorKind).toBe('vlm_backend_unavailable');
    expect(String(error.message)).not.toContain('private document');
  });

  test('health probe requires a readable model list containing the configured profile', async () => {
    const client = new OpenAICompatibleVlmClient({
      baseUrl: 'http://127.0.0.1:28090/v1',
      model: 'vision-deep',
      fetchImpl: (async () => Response.json({ data: [{ id: 'other-profile' }] })) as unknown as typeof fetch,
    });

    const error = await client.probe().catch((caught) => caught);
    expect(error).toBeInstanceOf(VlmRouterError);
    expect(error.errorKind).toBe('vlm_router_profile_unknown');
    expect(error.retryable).toBe(false);
  });

  test('model-list parser fails closed for malformed shapes', () => {
    expect(listedVlmProfileIds({ data: [{ id: 'a' }, {}, { id: 3 }] })).toEqual(['a']);
    expect(listedVlmProfileIds({ data: 'not-an-array' })).toEqual([]);
  });
});
