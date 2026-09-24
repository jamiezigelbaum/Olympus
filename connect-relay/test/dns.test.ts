import { describe, expect, test } from 'bun:test';
import { CloudflareDnsProvider } from '../server/dns.ts';

interface Call {
  method: string;
  url: string;
  body?: unknown;
  auth: string | null;
}

function fakeCloudflare(records: Array<{ id: string; type: string; name: string; content: string }>) {
  const calls: Call[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method, url, body, auth: new Headers(init?.headers).get('authorization') });
    const parsed = new URL(url);
    if (method === 'GET') {
      const result = records.filter((record) => record.type === parsed.searchParams.get('type') && record.name === parsed.searchParams.get('name'));
      return Response.json({ success: true, result });
    }
    if (method === 'POST') {
      records.push({ id: `r${records.length + 1}`, ...body });
      return Response.json({ success: true, result: {} });
    }
    if (method === 'DELETE') {
      const id = parsed.pathname.split('/').pop();
      records.splice(records.findIndex((record) => record.id === id), 1);
      return Response.json({ success: true, result: {} });
    }
    return Response.json({ success: false }, { status: 400 });
  }) as typeof fetch;
  return { calls, fetchImpl, records };
}

describe('Cloudflare DNS provider', () => {
  const name = '_acme-challenge.abcdefghijklmnopqrstuvwxyz234567.connect.olympus.test';
  const value = 'V'.repeat(43);

  test('publishes and withdraws a quoted TXT value idempotently with a scoped bearer token', async () => {
    const cf = fakeCloudflare([{ id: 'keep', type: 'TXT', name, content: `"${'K'.repeat(43)}"` }]);
    const provider = new CloudflareDnsProvider({ zoneId: 'zone1', apiToken: 'test-token', fetch: cf.fetchImpl, apiBase: 'https://cf.test/v4' });
    await provider.setTxt(name, value);
    await provider.setTxt(name, value);
    expect(cf.calls.filter((call) => call.method === 'POST')).toHaveLength(1);
    expect(cf.calls.find((call) => call.method === 'POST')?.body).toEqual({ type: 'TXT', name, content: `"${value}"`, ttl: 60 });
    expect(cf.calls.every((call) => call.auth === 'Bearer test-token' && call.url.startsWith('https://cf.test/v4/zones/zone1/dns_records'))).toBe(true);
    await provider.clearTxt(name, value);
    expect(cf.records.map((record) => record.id)).toEqual(['keep']);
  });

  test('creates explicit, unproxied address records once', async () => {
    const cf = fakeCloudflare([]);
    const provider = new CloudflareDnsProvider({ zoneId: 'z', apiToken: 't', ipv4: '192.0.2.10', ipv6: '2001:db8::10', fetch: cf.fetchImpl });
    const host = 'abcdefghijklmnopqrstuvwxyz234567.connect.olympus.test';
    await provider.ensureAddress(host);
    await provider.ensureAddress(host);
    const posts = cf.calls.filter((call) => call.method === 'POST').map((call) => call.body);
    expect(posts).toEqual([
      { type: 'A', name: host, content: '192.0.2.10', ttl: 300, proxied: false },
      { type: 'AAAA', name: host, content: '2001:db8::10', ttl: 300, proxied: false },
    ]);
  });

  test('errors do not echo the API token', async () => {
    const provider = new CloudflareDnsProvider({
      zoneId: 'z',
      apiToken: 'super-secret-token',
      fetch: (async () => Response.json({ success: false, errors: [{ message: 'bad token super-secret-token' }] }, { status: 403 })) as unknown as typeof fetch,
    });
    const error = await provider.setTxt(name, value).catch((caught: Error) => caught);
    expect(String(error)).toContain('HTTP 403');
    expect(String(error)).not.toContain('super-secret-token');
  });
});
