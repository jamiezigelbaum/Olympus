import { describe, expect, test } from 'bun:test';
import { defaultConfig } from '../src/core/config.ts';
import { DelphiClient, DirectHttpDelphiTransport } from '../src/core/delphi.ts';

describe('DelphiClient', () => {
  test('lists OpenAI-compatible models', async () => {
    const client = new DelphiClient(
      defaultConfig(),
      new DirectHttpDelphiTransport(async () => jsonResponse({
        data: [{ id: 'mlx-community/test-model' }],
      })),
    );

    await expect(client.listModels('fast')).resolves.toEqual([
      { id: 'mlx-community/test-model' },
    ]);
  });

  test('sends chat completions to the selected lane', async () => {
    const requests: Request[] = [];
    const client = new DelphiClient(
      defaultConfig(),
      new DirectHttpDelphiTransport(async (input, init) => {
        requests.push(new Request(input, init));
        return jsonResponse({
          model: 'mlx-community/test-model',
          choices: [{ message: { content: 'local answer' } }],
          usage: { completion_tokens: 2 },
        });
      }),
    );

    const result = await client.complete({
      lane: 'deep',
      prompt: 'hello',
      model: 'mlx-community/test-model',
      system: 'be concise',
    });

    expect(result.text).toBe('local answer');
    expect(result.lane).toBe('deep');
    expect(requests[0]?.url).toBe('http://127.0.0.1:28090/v1/chat/completions');
    expect(await requests[0]?.json()).toMatchObject({
      model: 'mlx-community/test-model',
      messages: [
        { role: 'system', content: 'be concise' },
        { role: 'user', content: 'hello' },
      ],
      chat_template_kwargs: { enable_thinking: false },
    });
  });

  test('sends chat completions through a model profile', async () => {
    const requests: Request[] = [];
    const client = new DelphiClient(
      defaultConfig(),
      new DirectHttpDelphiTransport(async (input, init) => {
        requests.push(new Request(input, init));
        return jsonResponse({
          model: 'mlx-community/profile-model',
          choices: [{ message: { content: 'profile answer' } }],
        });
      }),
    );

    const result = await client.complete({
      profile: 'source_answer',
      prompt: 'hello',
    });

    expect(result.text).toBe('profile answer');
    expect(result.profile).toBe('source_answer');
    expect(requests[0]?.url).toBe('http://127.0.0.1:28090/v1/chat/completions');
    expect(await requests[0]?.json()).toMatchObject({
      model: defaultConfig().argus.modelProfiles.source_answer.model,
    });
  });

  test('sends Authorization when the selected OpenAI-compatible profile has a secretRef', async () => {
    const requests: Request[] = [];
    const config = defaultConfig();
    config.argus.modelProfiles.source_answer.secretRef = 'env:HOSTED_ARGUS_API_KEY';
    const client = new DelphiClient(
      config,
      new DirectHttpDelphiTransport(async (input, init) => {
        requests.push(new Request(input, init));
        return jsonResponse({
          model: 'hosted-openai-compatible-model',
          choices: [{ message: { content: 'hosted answer' } }],
        });
      }),
      { resolveSecretRef: () => 'hosted-secret-token' },
    );

    await client.complete({
      profile: 'source_answer',
      prompt: 'hello',
    });

    expect(requests[0]?.headers.get('Authorization')).toBe('Bearer hosted-secret-token');
  });

  test('does not send Authorization when no secretRef is configured', async () => {
    const requests: Request[] = [];
    const client = new DelphiClient(
      defaultConfig(),
      new DirectHttpDelphiTransport(async (input, init) => {
        requests.push(new Request(input, init));
        return jsonResponse({
          model: 'mlx-community/profile-model',
          choices: [{ message: { content: 'profile answer' } }],
        });
      }),
    );

    await client.complete({
      profile: 'source_answer',
      prompt: 'hello',
    });

    expect(requests[0]?.headers.get('Authorization')).toBeNull();
  });

  test('lists OpenAI-compatible models through a profile', async () => {
    const client = new DelphiClient(
      defaultConfig(),
      new DirectHttpDelphiTransport(async () => jsonResponse({
        data: [{ id: 'mlx-community/profile-model' }],
      })),
    );

    await expect(client.listModelsForProfile('default_chat')).resolves.toEqual([
      { id: 'mlx-community/profile-model' },
    ]);
  });

  test('aborts a local model request at the configured transport timeout', async () => {
    const signals: AbortSignal[] = [];
    const client = new DelphiClient(
      defaultConfig(),
      new DirectHttpDelphiTransport((_input, init) => {
        const signal = init.signal as AbortSignal;
        signals.push(signal);
        return new Promise<Response>((_, reject) => {
          signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
        });
      }, 10),
    );

    await expect(client.complete({
      lane: 'fast',
      prompt: 'hello',
      model: 'mlx-community/test-model',
    })).rejects.toThrow(/timed out/);

    expect(signals).toHaveLength(1);
    expect(signals[0]!.aborted).toBe(true);
  });
});

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}
