import { beforeEach, describe, expect, test } from 'bun:test';
import {
  GOOGLE_SIGNIN_FULL_SENTENCE,
  googlePublisherSignInFull,
  resetGooglePublisherCapacityCache,
} from '../src/core/google-publisher-capacity.ts';
import { DEFAULT_GOOGLE_PUBLISHER_EXCHANGE_URL, googlePublisherCapacityUrl } from '../src/core/oauth-relay.ts';

// The engine's side of GET /exchange/capacity: asked before Olympus sends
// someone to Google through its own app. Only a well-formed "full" closes the
// door; every other outcome is "open".

beforeEach(() => resetGooglePublisherCapacityCache());

function answering(body: unknown, status = 200): { fetch: typeof fetch; calls: Array<{ url: string; init?: RequestInit }> } {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  return {
    calls,
    fetch: (async (input: unknown, init?: RequestInit) => {
      calls.push({ url: String(input), ...(init ? { init } : {}) });
      return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status });
    }) as unknown as typeof fetch,
  };
}

describe('capacity URL', () => {
  test('is the exchange Worker\'s /exchange/capacity on the same host', () => {
    expect(DEFAULT_GOOGLE_PUBLISHER_EXCHANGE_URL).toBe('https://auth.olympusplugin.ai/exchange/google');
    expect(googlePublisherCapacityUrl({})).toBe('https://auth.olympusplugin.ai/exchange/capacity');
  });

  test('follows a staging exchange override and never points at a different host than the exchange', () => {
    expect(googlePublisherCapacityUrl({ OLYMPUS_GOOGLE_PUBLISHER_EXCHANGE_URL: 'https://staging.example/exchange/google' }))
      .toBe('https://staging.example/exchange/capacity');
    expect(googlePublisherCapacityUrl({ OLYMPUS_GOOGLE_PUBLISHER_EXCHANGE_URL: 'http://evil.example/exchange/google' }))
      .toBe('https://auth.olympusplugin.ai/exchange/capacity');
  });
});

describe('googlePublisherSignInFull', () => {
  test('full only for exactly {"google":"full"}', async () => {
    expect(await googlePublisherSignInFull({ fetch: answering({ google: 'full' }).fetch, env: {} })).toBe(true);
  });

  test('open for exactly {"google":"open"}', async () => {
    expect(await googlePublisherSignInFull({ fetch: answering({ google: 'open' }).fetch, env: {} })).toBe(false);
  });

  test('sends a plain GET with no credentials and refuses redirects', async () => {
    const fake = answering({ google: 'open' });
    await googlePublisherSignInFull({ fetch: fake.fetch, env: {} });
    expect(fake.calls[0]?.url).toBe('https://auth.olympusplugin.ai/exchange/capacity');
    expect(fake.calls[0]?.init?.method).toBe('GET');
    expect(fake.calls[0]?.init?.redirect).toBe('error');
    expect(fake.calls[0]?.init?.credentials).toBe('omit');
    expect(fake.calls[0]?.init?.body).toBeUndefined();
  });

  const cases: Array<[string, unknown, number]> = [
    ['an unknown state', { google: 'closed' }, 200],
    ['an extra field', { google: 'full', count: 99 }, 200],
    ['a missing field', {}, 200],
    ['text', 'full', 200],
    ['a server error carrying "full"', { google: 'full' }, 500],
    ['a 404', { error: 'not_found' }, 404],
  ];
  for (const [name, body, status] of cases) {
    test(`reads ${name} as open`, async () => {
      expect(await googlePublisherSignInFull({ fetch: answering(body, status).fetch, env: {} })).toBe(false);
    });
  }

  test('reads a thrown fetch as open', async () => {
    const throwing = (async () => { throw new Error('offline'); }) as unknown as typeof fetch;
    expect(await googlePublisherSignInFull({ fetch: throwing, env: {} })).toBe(false);
  });

  test('reads a hung Worker as open once the timeout passes', async () => {
    const hung = ((_url: unknown, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
    })) as unknown as typeof fetch;
    const startedAt = Date.now();
    expect(await googlePublisherSignInFull({ fetch: hung, env: {}, timeoutMs: 50 })).toBe(false);
    expect(Date.now() - startedAt).toBeLessThan(2_000);
  });

  test('remembers an answer for a minute, then asks again', async () => {
    const nowMs = 1_000_000;
    const fake = answering({ google: 'full' });
    expect(await googlePublisherSignInFull({ fetch: fake.fetch, env: {}, now: () => nowMs })).toBe(true);
    expect(await googlePublisherSignInFull({ fetch: fake.fetch, env: {}, now: () => nowMs + 59_000 })).toBe(true);
    expect(fake.calls.length).toBe(1);
    await googlePublisherSignInFull({ fetch: fake.fetch, env: {}, now: () => nowMs + 61_000 });
    expect(fake.calls.length).toBe(2);
  });

  test('a failed check is remembered briefly, so an unreachable Worker is not retried on every poll', async () => {
    const nowMs = 1_000_000;
    let calls = 0;
    const down = (async () => { calls += 1; throw new Error('offline'); }) as unknown as typeof fetch;
    await googlePublisherSignInFull({ fetch: down, env: {}, now: () => nowMs });
    await googlePublisherSignInFull({ fetch: down, env: {}, now: () => nowMs + 10_000 });
    expect(calls).toBe(1);
    await googlePublisherSignInFull({ fetch: down, env: {}, now: () => nowMs + 31_000 });
    expect(calls).toBe(2);
  });

  test('concurrent callers share one request', async () => {
    const fake = answering({ google: 'full' });
    const results = await Promise.all([1, 2, 3].map(() => googlePublisherSignInFull({ fetch: fake.fetch, env: {} })));
    expect(results).toEqual([true, true, true]);
    expect(fake.calls.length).toBe(1);
  });

  test('stays off the network under test unless a fetch is supplied', async () => {
    expect(await googlePublisherSignInFull({ env: { NODE_ENV: 'test' } })).toBe(false);
  });
});

describe('the words', () => {
  test('are the owner\'s, verbatim', () => {
    expect(GOOGLE_SIGNIN_FULL_SENTENCE).toBe(
      'Google sign-in is full for the moment. We\'re working on it. For now, you can still connect Google by using your own Google app.',
    );
  });
});
