import { expect, spyOn, test } from 'bun:test';
import { createPendingItemProtection } from '../src/workers/connector-store/tier-visibility.ts';
import { EngineCommandClient } from '../src/workers/engine-split/client.ts';
import { createEngineCommandHandler, EngineCommandLedger } from '../src/workers/engine-split/commands.ts';
import { EngineCommandMirror } from '../src/workers/engine-split/control-mirror.ts';
import { createEngineFrontRoutes, createFrontGate } from '../src/workers/engine-split/runtime.ts';
import { withWorkerBearerAuth } from '../src/workers/http.ts';
import { ownerLocalMint } from './helpers/owner-local-mint.ts';

const AUTH = 'click-trace-fixture-token-0123456789abcdef';
const ORIGIN = 'http://127.0.0.1:28190';

async function dashboardClick(servedBy: 'control-thread' | 'loop', clickId?: string) {
  const instanceId = 'test-background';
  const ledger = new EngineCommandLedger({ instanceId, handlers: { tier_override: () => ({ status: 200, headers: {}, body: '{}' }) } });
  const mirror = new EngineCommandMirror({
    instanceId,
    send: envelope => {
      ledger.submit(envelope);
      void ledger.settled(envelope.id, new Promise<void>(() => {})).then(receipt => {
        if (receipt) mirror.apply([receipt]);
      });
    },
  });
  const handler = createEngineCommandHandler({ authToken: AUTH, ledger: servedBy === 'loop' ? ledger : mirror, ready: () => true });
  const client = new EngineCommandClient({
    authToken: AUTH,
    fetch: (async (url, init) => handler(new Request(url, init))) as typeof fetch,
  });
  const routes = createEngineFrontRoutes({ client, pendingItemProtection: createPendingItemProtection(), gate: createFrontGate(), restartFront: () => {} });
  const serve = withWorkerBearerAuth(async request => (await routes(request)) ?? new Response(null, { status: 404 }), {
    authToken: AUTH,
    tracePrivacyClicks: true,
  });
  const session = await ownerLocalMint(serve, ORIGIN, AUTH);
  expect(session.status).toBe(200);
  const { csrf_token } = await session.json() as { csrf_token: string };
  const response = await serve(new Request(ORIGIN + '/dashboard/privacy/items/set', {
    method: 'POST',
    headers: {
      Origin: ORIGIN,
      Cookie: session.headers.get('Set-Cookie')!.split(';')[0]!,
      'Content-Type': 'application/json',
      'X-Olympus-CSRF': csrf_token,
      ...(clickId === undefined ? {} : { 'X-Olympus-Click-Id': clickId }),
    },
    body: JSON.stringify({ tier: 'private' }),
  }));
  expect(response.status).toBe(202);
  const receipt = await response.json() as { request_id: string; state: string };
  expect(receipt.state).toBe('pending');
  expect(receipt.request_id).toMatch(/^[A-Za-z0-9_-]+$/);
  return receipt.request_id;
}

test('a tagged privacy click traces the front and whichever background serves the socket', async () => {
  const log = spyOn(console, 'log').mockImplementation(() => {});
  try {
    for (const servedBy of ['control-thread', 'loop'] as const) {
      log.mockClear();
      const clickId = 'gate-click_1';
      const requestId = await dashboardClick(servedBy, clickId);
      const lines = log.mock.calls.map(([line]) => String(line)).filter(line => line.includes('[olympus:click-trace]'));
      const [ingress, receipt, attempt, answer] = lines;
      expect(lines).toHaveLength(4);
      expect(ingress).toEndWith(`id=${clickId} request_id=none point=ingress role=front stage=before_session_csrf`);
      expect(receipt).toEndWith(`id=${clickId} request_id=${requestId} point=control_receipt role=background served_by=${servedBy}`);
      expect(attempt).toMatch(new RegExp(`id=${clickId} request_id=${requestId} point=post_attempt role=front attempt=1 status=202 elapsed_ms=\\d+$`));
      expect(answer).toMatch(new RegExp(`id=${clickId} request_id=${requestId} point=answer role=front total_ms=\\d+$`));
      // The attempt is logged after the receipt, but carries its start time.
      const timestamps = [ingress!, attempt!, receipt!, answer!].map(line => line.split(' ')[0]!);
      for (const timestamp of timestamps) expect(new Date(timestamp).toISOString()).toBe(timestamp);
      expect(timestamps).toEqual([...timestamps].sort());
    }
  } finally {
    log.mockRestore();
  }
});

test('a privacy click without a valid trace header emits no trace lines', async () => {
  const log = spyOn(console, 'log').mockImplementation(() => {});
  try {
    for (const clickId of [undefined, 'invalid/id', 'x'.repeat(81)]) await dashboardClick('control-thread', clickId);
    expect(log.mock.calls.filter(([line]) => String(line).includes('[olympus:click-trace]'))).toEqual([]);
  } finally {
    log.mockRestore();
  }
});
