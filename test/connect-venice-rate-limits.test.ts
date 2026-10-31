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
for (const connect of [connectApiKeySource, connectPublicApiKeySource]) {
  test(`${connect.name} aborts and cancels a stalled Venice body without replacing the saved key`, async () => {
    const saved: string[] = [];
    const deleted: string[] = [];
    const store: SecretStore = { label: 'test', async get() { return 'existing-key'; }, async set(_key, value) { saved.push(value); }, async delete(key) { deleted.push(key); }, async list() { return []; } };
    let signal: AbortSignal | null | undefined;
    let cancelled = false;
    let bodyController!: ReadableStreamDefaultController<Uint8Array>;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        bodyController = controller;
        // Even a syntactically complete payload is not complete until EOF.
        controller.enqueue(new TextEncoder().encode('{"data":{"accessPermitted":true,"balances":{"USD":1}}}'));
      },
      cancel() { cancelled = true; },
    });
    const pending = connect({ source: 'venice', apiKey: 'fixture', secretStore: store, validationTimeoutMs: 20,
      fetch: async (_url, init) => {
        signal = init?.signal;
        return new Response(body);
      } }).then(() => 'saved', (error: Error) => error.message);
    let watchdog: ReturnType<typeof setTimeout> | undefined;
    try {
      const outcome = await Promise.race([pending, new Promise<string>(resolve => {
        watchdog = setTimeout(() => resolve('hung'), 500);
      })]);
      expect(outcome).toBe('Venice could not be reached to check your key. No credentials were stored; try again.');
      expect(signal?.aborted).toBe(true);
      expect(cancelled).toBe(true);
      expect(body.locked).toBe(false);
      expect(saved).toEqual([]);
      expect(deleted).toEqual([]);
    } finally {
      clearTimeout(watchdog);
      // Clean up the deliberately stalled stream even when testing the old bug.
      if (!cancelled) bodyController.error(new Error('test cleanup'));
      await pending;
    }
  });
}

test('Venice accepts the documented funded response without bundled credits', async () => {
  const saved: string[] = [];
  const store: SecretStore = { label: 'test', async get() { return undefined; }, async set(_key, value) { saved.push(value); }, async delete() {}, async list() { return []; } };
  await connectApiKeySource({ source: 'venice', apiKey: 'fixture', secretStore: store,
    fetch: async () => Response.json({ data: { accessPermitted: true, balances: { USD: 50.23, DIEM: 100.023 } } }) });
  expect(saved).toEqual(['fixture']);
});
