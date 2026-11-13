// The one-item privacy change's surfaces (issue #1060): the agent operations
// privacy_item_find and privacy_item_set, the worker's agent routes behind the
// bearer, and the dashboard's local routes. An agent can only raise an item to
// Private: the operation refuses anything else before sending, and the agent
// routes have no way to lower. Lowering, and putting an item back to the
// judge, take this computer's own (local-grade) dashboard session.

import { describe, expect, test } from 'bun:test';
import { defaultConfig } from '../src/core/config.ts';
import { DirectHttpEmailTransport, EmailClient } from '../src/core/email.ts';
import { exposedOperations, type OperationSurface } from '../src/core/operation-exposure.ts';
import { operations, type OperationContext } from '../src/core/operations.ts';
import { V0_4_PUBLIC_DASHBOARD_ROUTES, V0_4_PUBLIC_REMOTE_MCP_TOOLS } from '../src/core/public-surface.ts';
import { ownerLocalMint } from './helpers/owner-local-mint.ts';
import { buildEnvBridgeSovereigntyConfig, createSovereigntyEngine } from '../src/core/sovereignty.ts';
import type { OwnerTierItems, OwnerTierItemFindInput, OwnerTierItemSetInput } from '../src/workers/classification/tier-owner-items.ts';
import { createEmailSourceWorker } from '../src/workers/engine/index.ts';
import {
  DASHBOARD_CONTROL_GRADE_CONTEXT_HEADER,
  DASHBOARD_PRIVACY_ITEM_PATHS,
  withWorkerBearerAuth,
} from '../src/workers/http.ts';

const TOKEN = 'privacy-item-worker-secret';
const ORIGIN = 'http://127.0.0.1:28193';
const ITEM_ID = 'oti_WyJnbWFpbCIsImEiLCIiLCJtMSJd';
const find = operations.find((operation) => operation.name === 'privacy_item_find')!;
const set = operations.find((operation) => operation.name === 'privacy_item_set')!;

function fixture() {
  const finds: OwnerTierItemFindInput[] = [];
  const sets: OwnerTierItemSetInput[] = [];
  const engine: OwnerTierItems = {
    find(input) { finds.push(input); return { items: [] }; },
    set(input) {
      sets.push(input);
      return { ok: false, code: 'not_found', message: 'Olympus no longer holds that item.' };
    },
  };
  const worker = createEmailSourceWorker({
    ownerTierItems: engine,
    readOwnerItem: async (itemId) => ({ state: itemId === ITEM_ID ? 'queued' : 'refused', etaSeconds: 60 }),
    sourceDashboard: { sovereigntyEngine: createSovereigntyEngine(buildEnvBridgeSovereigntyConfig({})) },
  });
  const guarded = withWorkerBearerAuth((request: Request) => worker.fetch(request), { authToken: TOKEN });
  const config = defaultConfig();
  config.email.enabled = true;
  let sent = 0;
  const email = new EmailClient(config, new DirectHttpEmailTransport((input, init) => {
    sent += 1;
    return guarded(new Request(input, init));
  }, TOKEN));
  const ctx: OperationContext = { config, delphi: {} as OperationContext['delphi'], email };
  return { worker, guarded, ctx, finds, sets, sent: () => sent };
}

const surfaceNames = (surface: OperationSurface) =>
  exposedOperations(operations, { config: defaultConfig(), surface }).map((operation) => operation.name);

describe('the agent operations', () => {
  test('are on the native, MCP and CLI surfaces, and not on the remote one', () => {
    for (const surface of ['native', 'mcp', 'cli'] as const) {
      expect(surfaceNames(surface)).toContain('privacy_item_find');
      expect(surfaceNames(surface)).toContain('privacy_item_set');
    }
    expect(V0_4_PUBLIC_REMOTE_MCP_TOOLS as readonly string[]).not.toContain('privacy_item_set');
    expect(set.mutating).toBe(true);
    expect(find.mutating).toBe(false);
    expect(set.params.tier?.enum).toEqual(['private']);
  });

  test('privacy_item_set can only raise: Personal, the judge\'s label or anything else is refused before anything is sent', async () => {
    const f = fixture();
    for (const tier of ['personal', 'judge', 'public', 'secrets', 'Personal', 'PRIVATE']) {
      await expect(set.handler(f.ctx, { item_id: ITEM_ID, tier })).rejects.toMatchObject({ code: 'invalid_params' });
    }
    await expect(set.handler(f.ctx, { item_id: ITEM_ID, tier: 'private', allow_lower: true })).rejects.toThrow('undeclared property');
    expect(f.sent()).toBe(0);
    expect(f.sets).toEqual([]);

    // Private goes to the worker's raise route, which asks the engine for a raise and nothing else.
    expect(await set.handler(f.ctx, { item_id: ITEM_ID, tier: 'private' })).toMatchObject({ ok: false, code: 'not_found' });
    expect(f.sets).toEqual([{ itemId: ITEM_ID, choice: 'private', allowLower: false }]);
  });

  test('privacy_item_find asks for items whose names are Personal only', async () => {
    const f = fixture();
    expect(await find.handler(f.ctx, { query: 'bank letter' })).toEqual({ items: [] });
    expect(await find.handler(f.ctx, { recent: true, limit: 5 })).toEqual({ items: [] });
    await expect(find.handler(f.ctx, {})).rejects.toMatchObject({ code: 'invalid_params' });
    await expect(find.handler(f.ctx, { query: 'x', recent: true })).rejects.toMatchObject({ code: 'invalid_params' });
    expect(f.finds).toEqual([
      { query: 'bank letter', personalNamesOnly: true },
      { recent: true, limit: 5, personalNamesOnly: true },
    ]);
  });

  test('the worker\'s agent routes have no way to lower an item', async () => {
    const f = fixture();
    for (const action of ['set', 'lower', 'judge', 'clear']) {
      const response = await f.guarded(new Request(`${ORIGIN}/v1/privacy-item/${action}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ item_id: ITEM_ID, tier: 'personal', allowLower: true }),
      }));
      expect(response.status).toBe(404);
    }
    // A raise ignores whatever else the body says.
    await f.guarded(new Request(`${ORIGIN}/v1/privacy-item/raise`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ item_id: ITEM_ID, tier: 'personal', allow_lower: true }),
    }));
    expect(f.sets).toEqual([{ itemId: ITEM_ID, choice: 'private', allowLower: false }]);
  });
});

function cookieOf(response: Response): string {
  const cookie = (response.headers.get('Set-Cookie') ?? '').split(';')[0] ?? '';
  if (!cookie.startsWith('olympus_dashboard_control=')) throw new Error('no control cookie');
  return cookie;
}

function post(path: string, headers: Record<string, string>, body: unknown): Request {
  return new Request(`${ORIGIN}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: ORIGIN, ...headers },
    body: JSON.stringify(body),
  });
}

async function localSession(fetch: (request: Request) => Promise<Response>) {
  const mint = await ownerLocalMint(fetch, ORIGIN, TOKEN);
  expect(mint.status).toBe(200);
  return { Cookie: cookieOf(mint), 'X-Olympus-CSRF': ((await mint.json()) as { csrf_token: string }).csrf_token };
}

async function bearerSession(fetch: (request: Request) => Promise<Response>) {
  const mint = await fetch(new Request(`${ORIGIN}/dashboard/control/session`, { method: 'POST', headers: { Authorization: `Bearer ${TOKEN}`, Origin: ORIGIN } }));
  expect(mint.status).toBe(200);
  return { Cookie: cookieOf(mint), 'X-Olympus-CSRF': ((await mint.json()) as { csrf_token: string }).csrf_token };
}

describe('the dashboard\'s routes', () => {
  test('are public dashboard routes, held to this computer\'s own session', async () => {
    const f = fixture();
    const published = V0_4_PUBLIC_DASHBOARD_ROUTES.map((route) => route.path);
    for (const path of DASHBOARD_PRIVACY_ITEM_PATHS) expect(published).toContain(path);
    const bearer = await bearerSession(f.guarded);
    for (const path of DASHBOARD_PRIVACY_ITEM_PATHS) {
      const body = { query: 'bank', item_id: ITEM_ID, tier: 'personal' };
      for (const headers of [
        { Authorization: `Bearer ${TOKEN}` },
        { Authorization: `Bearer ${TOKEN}`, [DASHBOARD_CONTROL_GRADE_CONTEXT_HEADER]: 'local' },
        bearer,
      ]) {
        const refused = await f.guarded(post(path, headers, body));
        expect(refused.status).toBe(403);
      }
      // An in-process caller without the boundary's grade is refused by the route itself.
      expect((await f.worker.fetch(post(path, {}, body))).status).toBe(403);
    }
    expect(f.finds).toEqual([]);
    expect(f.sets).toEqual([]);
  });

  test('a local session finds any item and sets Personal, Private or back to the judge', async () => {
    const f = fixture();
    const session = await localSession(f.guarded);
    const found = await f.guarded(post('/dashboard/privacy/items/find', session, { query: 'bank' }));
    expect(found.status).toBe(200);
    expect(await found.json()).toEqual({ ok: true, items: [] });
    expect(f.finds).toEqual([{ query: 'bank', withPreview: true }]);
    for (const tier of ['personal', 'private', 'judge']) {
      expect((await f.guarded(post('/dashboard/privacy/items/set', session, { item_id: ITEM_ID, tier }))).status).toBe(200);
    }
    expect(f.sets).toEqual([
      { itemId: ITEM_ID, choice: 'personal', allowLower: true },
      { itemId: ITEM_ID, choice: 'private', allowLower: true },
      { itemId: ITEM_ID, choice: 'judge', allowLower: true },
    ]);
    expect((await f.guarded(post('/dashboard/privacy/items/set', session, { item_id: ITEM_ID, tier: 'secrets' }))).status).toBe(400);
  });

  test('Read this file uses the owner operation only from a local session', async () => {
    const f = fixture();
    const session = await localSession(f.guarded);
    const response = await f.guarded(post('/dashboard/privacy/items/read', session, { item_id: ITEM_ID }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, state: 'queued', etaSeconds: 60 });
    expect((await f.guarded(post('/dashboard/privacy/items/read', session, {}))).status).toBe(400);
  });

  test('Check the judge answers a local session only, and says when it is not set up', async () => {
    const f = fixture();
    const session = await localSession(f.guarded);
    const response = await f.guarded(post('/dashboard/privacy/judge-check', session, { action: 'status' }));
    expect(response.status).toBe(501);
  });
});
