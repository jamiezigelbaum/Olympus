import { expect, test } from 'bun:test';
import { withFirstRunPrivacyGate } from '../src/workers/first-run-privacy-gate.ts';
import { recordRequestPeer, withRequestPeer } from '../src/core/request-peer.ts';

const payload = { names: ['SENTINEL_FOLDER', 'SENTINEL_LABEL', 'SENTINEL_SENDER'] };
const request = (path: string, headers: Record<string, string> = {}) => new Request(`http://127.0.0.1:8010${path}`, { method: 'POST', headers });

test('pending blocks bearer reads, REST, source OAuth and all nonlocal dashboard paths without consulting sources', async () => {
  let reads = 0;
  const guarded = withFirstRunPrivacyGate(() => { reads++; return Response.json(payload); }, { pending: () => true });
  for (const path of ['/dashboard/dispositions', '/dashboard.json', '/dashboard/tools/call', '/dashboard/connect/oauth/start', '/v1/source/index/query', '/api/v1/tools/source_answer', '/private/answer']) {
    const response = await guarded(request(path, { Authorization: 'Bearer synthetic', 'X-Olympus-Control-Session-Grade': 'local' }));
    expect(response.status).toBe(403);
    expect(await response.text()).not.toContain('SENTINEL');
  }
  expect(reads).toBe(0);
});

test('only a recorded local browser can browse pending; relayed and bearer calls cannot claim the exception', async () => {
  const guarded = withFirstRunPrivacyGate(() => Response.json(payload), { pending: () => true, isRelayed: r => r.headers.has('x-relay') });
  const local = request('/dashboard/dispositions');
  recordRequestPeer(local, '127.0.0.1');
  expect(await (await guarded(local)).json()).toEqual(payload);
  for (const headers of [{}, { 'x-relay': 'yes' }, { Authorization: 'Bearer synthetic' }, { 'x-olympus-gateway-public-origin': 'https://remote.test' }]) {
    const remote = request('/dashboard/dispositions', headers);
    // First has no peer; others are remote requests forwarded over loopback.
    if (Object.keys(headers).length) recordRequestPeer(remote, '127.0.0.1');
    expect((await guarded(remote)).status).toBe(403);
  }
  const ownerSocket = withRequestPeer(guarded, true);
  expect(await (await ownerSocket(request('/dashboard/dispositions'), { requestIP: () => null })).json()).toEqual(payload);
});

test('unknown policy fails closed and health never probes a source while pending', async () => {
  let reads = 0;
  const guarded = withFirstRunPrivacyGate(() => { reads++; return Response.json(payload); }, { pending: () => { throw new Error('unreadable'); } });
  expect((await guarded(request('/v1/source/index/query'))).status).toBe(403);
  const health = await guarded(new Request('http://127.0.0.1:8010/v1/health?deep=true'));
  expect(health.status).toBe(200);
  expect(await health.text()).not.toContain('SENTINEL');
  expect(reads).toBe(0);
});

test('session establishment and static discovery remain available; a chosen policy opens reads', async () => {
  let pending = true;
  const guarded = withFirstRunPrivacyGate(() => Response.json({ reached: true }), { pending: () => pending });
  for (const path of ['/dashboard/control/session', '/dashboard/control/launch', '/dashboard/launch', '/connect/authorize', '/openapi.json']) {
    expect((await guarded(request(path, { Authorization: 'Bearer synthetic' }))).status).toBe(200);
  }
  pending = false;
  expect((await guarded(request('/dashboard/dispositions', { Authorization: 'Bearer synthetic' }))).status).toBe(200);
});
