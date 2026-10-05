// Local model lanes refuse Ollama cloud-forwarding model ids. The rule is on
// the tag only (`:cloud`, or a tag ending in `-cloud`); a name that merely
// contains "cloud" elsewhere is still a local model.
import { describe, expect, test } from 'bun:test';
import { defaultConfig } from '../src/core/config.ts';
import { DelphiClient, type DelphiTransport } from '../src/core/delphi.ts';
import { assertLocalModelIdNotCloudForwarding, isCloudForwardingModelId } from '../src/core/local-model-policy.ts';
import { OperationError } from '../src/core/operation-error.ts';
import { assertSnifferProfileAllowed } from '../src/workers/classification/sniffer-lane.ts';
import { OpenAICompatibleVlmClient } from '../src/workers/file-extraction/extractors/openai-compatible-client.ts';
import { OpenAICompatibleSourceEmbeddingProvider } from '../src/workers/source-index/embeddings.ts';

const CLOUD_IDS = [
  'gpt-oss:120b-cloud',
  'gpt-oss:20b-cloud',
  'qwen3-coder:480b-cloud',
  'deepseek-v3.1:671b-cloud',
  'gemma4:cloud',
  'GPT-OSS:120B-CLOUD',
  '  gemma4:cloud  ',
  'library/gpt-oss:120b-cloud',
  'registry.ollama.ai/library/gpt-oss:120b-cloud',
];

const LOCAL_IDS = [
  'gpt-oss:120b',
  'gpt-oss',
  'cloudllama:7b',
  'my-cloud-model',
  'my-cloud-model:latest',
  'cloud',
  'qwen3:cloudy',
  'qwen3:cloud-q4',
  'org/cloud-tools:latest',
  'cloud-provider/model:8b',
  'delphi/source-answer',
  'secure-local-qwen3-embed',
  'localhost:11434/llama3:8b',
];

describe('isCloudForwardingModelId', () => {
  test.each(CLOUD_IDS)('matches cloud tag %p', (id) => {
    expect(isCloudForwardingModelId(id)).toBe(true);
  });

  test.each(LOCAL_IDS)('accepts %p', (id) => {
    expect(isCloudForwardingModelId(id)).toBe(false);
  });

  test('the refusal is a config_error that says the model runs in the provider cloud', () => {
    let error: unknown;
    try {
      assertLocalModelIdNotCloudForwarding('Local lane', 'gpt-oss:120b-cloud');
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(OperationError);
    expect((error as OperationError).code).toBe('config_error');
    expect((error as Error).message).toContain("runs in the provider's cloud and cannot serve as a local model");
    expect(() => assertLocalModelIdNotCloudForwarding('Local lane', 'gpt-oss:120b')).not.toThrow();
  });
});

describe('separately configured local model ids', () => {
  test('local embeddings refuse a cloud tag', () => {
    expect(() => new OpenAICompatibleSourceEmbeddingProvider({
      baseUrl: 'http://127.0.0.1:11434/v1',
      model: 'embeddinggemma:cloud',
    })).toThrow("cannot serve as a local model");
    expect(() => new OpenAICompatibleSourceEmbeddingProvider({
      baseUrl: 'http://127.0.0.1:11434/v1',
      model: 'nomic-embed-text:latest',
    })).not.toThrow();
  });

  test('local vision refuses a cloud tag', () => {
    expect(() => new OpenAICompatibleVlmClient({
      baseUrl: 'http://127.0.0.1:11434/v1',
      model: 'qwen3-vl:235b-cloud',
    })).toThrow("cannot serve as a local model");
    expect(() => new OpenAICompatibleVlmClient({
      baseUrl: 'http://127.0.0.1:11434/v1',
      model: 'qwen3-vl:8b',
    })).not.toThrow();
  });

  test('the privacy sniffer re-checks a local profile at dispatch', () => {
    const profile = {
      provider: 'local-openai-compatible' as const,
      trust: 'local' as const,
      baseUrl: 'http://127.0.0.1:11434/v1',
      model: 'gpt-oss:20b-cloud',
      purpose: 'classification' as const,
    };
    expect(() => assertSnifferProfileAllowed('sniff', profile)).toThrow("cannot serve as a local model");
    expect(assertSnifferProfileAllowed('sniff', { ...profile, model: 'gpt-oss:20b' })).toBe('local');
  });

  test('an Argus route naming a cloud tag is refused before any request', async () => {
    const config = defaultConfig();
    config.argus.lanes.fast.model = 'gpt-oss:120b-cloud';
    const requests: string[] = [];
    const transport: DelphiTransport = {
      async requestJson(url) {
        requests.push(url);
        return { choices: [{ message: { content: 'ok' } }] };
      },
    };
    const client = new DelphiClient(config, transport);
    await expect(client.complete({ lane: 'fast', prompt: 'hello' })).rejects.toThrow("cannot serve as a local model");
    expect(requests).toEqual([]);
    await expect(client.complete({ lane: 'fast', prompt: 'hello', model: 'gpt-oss:120b' })).resolves.toMatchObject({ text: 'ok' });
  });
});
