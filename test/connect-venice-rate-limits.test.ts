import { expect, test } from 'bun:test';
import { connectApiKeySource, connectPublicApiKeySource } from '../src/core/connect.ts';
import type { SecretStore } from '../src/core/secret-store.ts';

for (const connect of [connectApiKeySource, connectPublicApiKeySource]) {
  test(`${connect.name} checks access and credit before saving`, async () => {
    const saved: string[] = [];
    const store: SecretStore = { label: 'test', async get() { return undefined; }, async set(_key, value) { saved.push(value); }, async delete() {}, async list() { return []; } };
    const fetch = async (url: string | URL | Request) => {
      expect(String(url)).toBe('https://api.venice.ai/api/v1/api_keys/rate_limits');
      return Response.json({ data: { accessPermitted: true, balances: { USD: 0, DIEM: 0, BUNDLED_CREDITS: 0 } } });
    };
    await expect(connect({ source: 'venice', apiKey: 'fixture', secretStore: store, fetch })).rejects.toThrow('credit');
    expect(saved).toEqual([]);
  });
}

test('Venice validation times out when the response body stalls after headers', async () => {
  const saved: string[] = [];
  const store: SecretStore = { label: 'test', async get() { return undefined; }, async set(_key, value) { saved.push(value); }, async delete() {}, async list() { return []; } };
  const pending = connectApiKeySource({ source: 'venice', apiKey: 'fixture', secretStore: store, validationTimeoutMs: 20,
    fetch: async () => new Response(new ReadableStream({ start() {} })) }).then(() => 'saved', () => 'refused');
  expect(await Promise.race([pending, new Promise(resolve => setTimeout(() => resolve('hung'), 200))])).toBe('refused');
  expect(saved).toEqual([]);
});

test('Venice accepts the documented funded response without bundled credits', async () => {
  const saved: string[] = [];
  const store: SecretStore = { label: 'test', async get() { return undefined; }, async set(_key, value) { saved.push(value); }, async delete() {}, async list() { return []; } };
  await connectApiKeySource({ source: 'venice', apiKey: 'fixture', secretStore: store,
    fetch: async () => Response.json({ data: { accessPermitted: true, balances: { USD: 50.23, DIEM: 100.023 } } }) });
  expect(saved).toEqual(['fixture']);
});
