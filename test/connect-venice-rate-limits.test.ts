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
