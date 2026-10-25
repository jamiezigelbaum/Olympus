// The routes the CLI uses while the worker owns the data (`POST /v1/cli/*`,
// workers/cli-operations.ts): reachable only with the worker bearer, never
// through the relay, and each answers with what the CLI's own function
// returns (core/cli-via-worker.ts, docs/design/source-storage.md, "Owner lock").

import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, test } from 'bun:test';
import { forwardPath } from '../connect-relay/client/forward.ts';
import { WORKER_CLI_OPERATIONS, WORKER_CLI_ROUTE_PREFIX } from '../src/core/cli-via-worker.ts';
import { loadConfig } from '../src/core/config.ts';
import { RELAYED_REQUEST_HEADER } from '../src/core/remote-access.ts';
import { buildEnvBridgeSovereigntyConfig, createSovereigntyEngine } from '../src/core/sovereignty.ts';
import { connectThisComputerSource } from '../src/core/this-computer.ts';
import { findRegistryAccount, readSourceRegistry } from '../src/core/source-registry.ts';
import { dashboardQueryTokenFromWorkerAuthToken } from '../src/core/worker-auth.ts';
import { deleteOlympusDataWithCustody, exportOlympusData, lifecycleDataRoot, lifecycleSourceSpecs, type LifecyclePathContext } from '../src/data-lifecycle.ts';
import { runTierCommand } from '../src/workers/classification/tier-cli.ts';
import { writeConnectedHandleRegistry, readConnectedHandleRegistry, type ConnectedHandleRegistry } from '../src/workers/credential-broker/connected-handles.ts';
import { createEmailSourceWorker } from '../src/workers/email-source/index.ts';
import { withWorkerBearerAuth } from '../src/workers/http.ts';
import { collectLocalSourceIngestionLedger } from '../src/workers/source-ingestion-ledger.ts';

const TOKEN = 'cli-routes-test-token';
const ORIGIN = 'http://127.0.0.1:8787';
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) {
    try { chmodSync(root, 0o700); } catch { /* gone */ }
    rmSync(root, { recursive: true, force: true });
  }
});

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  roots.push(dir);
  return dir;
}

const path = (operation: string) => `${ORIGIN}/v1${WORKER_CLI_ROUTE_PREFIX}${operation}`;
const post = (operation: string, body: unknown, headers: Record<string, string> = {}) =>
  new Request(path(operation), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
const bearer = { Authorization: `Bearer ${TOKEN}` };
/** A body as the CLI sends it: naming the data root it is for, here the worker's own. */
const forRoot = (body: unknown, context: LifecyclePathContext = { env: process.env }) =>
  body && typeof body === 'object' && !Array.isArray(body) && !('data_root' in body)
    ? { ...body, data_root: lifecycleDataRoot(context) }
    : body;

/** A body that would do real work if the route ran. */
const WORK: Record<string, Record<string, unknown>> = {
  'ingestion-status': {},
  'data-export': { output: '/nonexistent/olympus-refused-export' },
  'data-delete': { source_id: 'dropbox.files', dry_run: true },
  tier: { args: ['migrate', 'status'] },
  'pairing-placement': { source_id: 'telegram.messages' },
  'pairing-account': { source_id: 'telegram.messages', account_id: 'telegram:0123456789abcdef' },
};

describe('who can reach the CLI routes', () => {
  function guarded() {
    const calls: string[] = [];
    const worker = createEmailSourceWorker({});
    const reaching = async (request: Request) => {
      calls.push(new URL(request.url).pathname);
      return worker.fetch(request);
    };
    return { calls, fetch: withWorkerBearerAuth(reaching, { authToken: TOKEN }) };
  }

  test('every operation has a work body here, so a new one is tested too', () => {
    expect(Object.keys(WORK).sort()).toEqual([...WORKER_CLI_OPERATIONS].sort());
  });

  for (const operation of WORKER_CLI_OPERATIONS) {
    test(`${operation}: refused without the worker bearer, whatever else is presented`, async () => {
      const f = guarded();
      const unauthorized = async (request: Request) => {
        const response = await f.fetch(request);
        expect(response.status, request.headers.get('Authorization') ?? request.headers.get('Cookie') ?? 'no credentials').toBe(401);
      };
      await unauthorized(post(operation, WORK[operation]));
      await unauthorized(post(operation, WORK[operation], { Authorization: 'Bearer not-the-token' }));
      await unauthorized(post(operation, WORK[operation], { Authorization: `Bearer ${dashboardQueryTokenFromWorkerAuthToken(TOKEN)}` }));
      // A remote agent's connection credential is not the worker bearer.
      await unauthorized(post(operation, WORK[operation], { Authorization: 'Bearer olympus_conn_0123456789abcdef0123456789abcdef' }));
      // The dash_ read token in the URL does not open a control route either.
      const viaQuery = new Request(`${path(operation)}?token=${dashboardQueryTokenFromWorkerAuthToken(TOKEN)}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(WORK[operation]),
      });
      await unauthorized(viaQuery);
      expect(f.calls).toEqual([]);
    });

    test(`${operation}: a live dashboard session cookie alone does not reach it`, async () => {
      const f = guarded();
      const minted = await f.fetch(new Request(`${ORIGIN}/dashboard/control/session`, {
        method: 'POST', headers: { ...bearer, Origin: ORIGIN },
      }));
      expect(minted.status).toBe(200);
      const cookie = minted.headers.get('Set-Cookie')!.split(';')[0]!;
      const csrf = ((await minted.json()) as { csrf_token: string }).csrf_token;
      const callsBefore = f.calls.length;
      // The session is live: it renews itself with its cookie, CSRF and origin alone.
      const renewed = await f.fetch(new Request(`${ORIGIN}/dashboard/control/session`, {
        method: 'POST', headers: { Cookie: cookie, Origin: ORIGIN, 'X-Olympus-CSRF': csrf },
      }));
      expect(renewed.status).toBe(200);
      const response = await f.fetch(post(operation, WORK[operation], {
        Cookie: cookie, Origin: ORIGIN, 'X-Olympus-CSRF': csrf,
      }));
      expect(response.status).toBe(401);
      expect(f.calls.length).toBe(callsBefore);
    });

    test(`${operation}: a request that came through the relay is refused even with the bearer`, async () => {
      const f = guarded();
      const response = await f.fetch(post(operation, WORK[operation], { ...bearer, [RELAYED_REQUEST_HEADER]: 'anything' }));
      expect(response.status).toBe(403);
      await expect(response.json()).resolves.toMatchObject({ error: { code: 'cli_route_not_relayed' } });
    });

    test(`${operation}: the relay's forwarding refuses it, by any method and under either spelling`, () => {
      for (const method of ['GET', 'POST', 'DELETE']) {
        for (const spelling of [`/v1${WORKER_CLI_ROUTE_PREFIX}${operation}`, `${WORKER_CLI_ROUTE_PREFIX}${operation}`, `/v1${WORKER_CLI_ROUTE_PREFIX}${operation}?x=1`]) {
          expect(forwardPath(spelling, undefined, method), `${method} ${spelling}`).toBeUndefined();
        }
      }
    });
  }

  test('only POST reaches a CLI route, and an unknown operation is not found', async () => {
    const f = guarded();
    const get = await f.fetch(new Request(path('tier'), { headers: bearer }));
    expect(get.status).toBe(404);
    const unknown = await f.fetch(post('made-up', {}, bearer));
    expect(unknown.status).toBe(404);
  });
});

describe('what the CLI routes return', () => {
  const run = (operation: string, body: unknown) => createEmailSourceWorker({}).fetch(post(operation, forRoot(body)));

  test('ingestion-status is the ledger the CLI collects itself', async () => {
    const response = await run('ingestion-status', {});
    expect(response.status).toBe(200);
    const local = await collectLocalSourceIngestionLedger({ config: loadConfig() });
    const withoutClock = (value: object) => ({ ...value, generated_at: '<time>' });
    expect(withoutClock(await response.json() as object)).toEqual(withoutClock(JSON.parse(JSON.stringify(local))));
  });

  test('data-export writes the export the CLI writes itself, where it is told', async () => {
    const dir = tempDir('olympus-cli-route-export-');
    const store = lifecycleSourceSpecs().find((entry) => entry.sourceId === 'x.bookmarks')!.connectorStorePaths!({})[0]!;
    mkdirSync(dirname(store), { recursive: true });
    writeFileSync(store, 'not a database');
    const viaRoute = join(dir, 'via-route');
    const direct = join(dir, 'direct');
    const response = await run('data-export', { output: viaRoute, source_id: 'telegram.messages' });
    expect(response.status).toBe(200);
    const expected = exportOlympusData({ destination: direct, sourceId: 'telegram.messages' });
    const normalize = (value: unknown, root: string) => JSON.parse(JSON.stringify(value).split(root).join('<out>'));
    expect(normalize(await response.json(), viaRoute)).toEqual(normalize(JSON.parse(JSON.stringify(expected)), direct));
    expect(JSON.parse(readFileSync(join(viaRoute, 'manifest.json'), 'utf8'))).toMatchObject({ kind: 'olympus_data_export', secrets_excluded: true });
  });

  test('data-export keeps the export checks: a source it does not know, a folder that is not absolute', async () => {
    const unknown = await run('data-export', { output: join(tempDir('olympus-cli-route-export-'), 'out'), source_id: 'made.up' });
    expect(unknown.status).toBe(400);
    await expect(unknown.json()).resolves.toMatchObject({ error: { code: 'invalid_params', message: 'Unknown Olympus source id "made.up".' } });
    for (const output of ['relative/out', '', undefined]) {
      const refused = await run('data-export', { output });
      expect(refused.status).toBe(400);
      await expect(refused.json()).resolves.toMatchObject({ error: { code: 'invalid_params' } });
    }
  });

  test.skipIf(process.getuid?.() === 0)('data-export into a folder the worker may not write says why, not a bare failure', async () => {
    const dir = tempDir('olympus-cli-route-readonly-');
    chmodSync(dir, 0o500);
    const response = await run('data-export', { output: join(dir, 'out') });
    expect(response.status).toBe(500);
    const body = await response.json() as { error: { code: string; message: string; suggestion?: string } };
    expect(body.error.code).toBe('source_index_error');
    expect(body.error.message).toContain(`The running Olympus could not write the export to ${join(dir, 'out')}`);
    expect(body.error.suggestion).toContain('writes the export itself');
    expect(body.error.suggestion).toContain('Choose');
    expect(existsSync(join(dir, 'out'))).toBe(false);
  });

  test('pairing-placement records where a new account goes from the worker\'s own environment, and says so', async () => {
    const home = tempDir('olympus-cli-route-placement-');
    const saved = { HOME: process.env.HOME, XDG_DATA_HOME: process.env.XDG_DATA_HOME };
    process.env.HOME = home;
    delete process.env.XDG_DATA_HOME;
    try {
      const response = await run('pairing-placement', { source_id: 'telegram.messages' });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ layout: 'folder' });
      expect(findRegistryAccount(readSourceRegistry(process.env), 'telegram.messages', '1')?.layout).toBe('folder');
      // Asked again, it follows the entry it made.
      expect(await (await run('pairing-placement', { source_id: 'telegram.messages' })).json()).toEqual({ layout: 'folder' });
    } finally {
      for (const [name, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  });

  test('pairing-placement answers for the messaging accounts only', async () => {
    for (const source_id of ['dropbox.files', 'made.up', '', undefined]) {
      const refused = await run('pairing-placement', { source_id });
      expect(refused.status, String(source_id)).toBe(400);
      await expect(refused.json()).resolves.toMatchObject({ error: { code: 'invalid_params' } });
    }
  });

  test('tier answers what the CLI command answers, and its refusals read the same', async () => {
    const response = await run('tier', { args: ['migrate', 'status'] });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(JSON.parse(JSON.stringify(await runTierCommand(['migrate', 'status']))));

    const missing = await run('tier', { args: ['explain', 'no-such-item'] });
    expect(missing.status).toBe(400);
    await expect(missing.json()).resolves.toMatchObject({
      error: { code: 'invalid_params', message: 'No stored item matches that locator.', suggestion: 'Use the locator an answer cited, or the provider item id.' },
    });
  });

  test('tier will not run a command that rewrites the stores the worker writes, or one that needs no worker', async () => {
    for (const args of [['migrate', 'run', '--plan', 'p'], ['migrate', 'rollback', '--batch', 'b'], ['migrate', 'purge', '--approve', '--expect', 'd', '--why', 'w']]) {
      const refused = await run('tier', { args });
      expect(refused.status, args.join(' ')).toBe(400);
      const body = await refused.json() as { error: { code: string; message: string; suggestion: string } };
      expect(body.error.message).toContain('rewrites stores Olympus is writing');
      expect(body.error.suggestion).toContain('olympus engine stop');
    }
    for (const args of [['rules', 'list'], ['classifier', 'status'], []]) {
      expect((await run('tier', { args })).status, args.join(' ')).toBe(400);
    }
    for (const args of [undefined, 'migrate status', [1], new Array(65).fill('x')]) {
      expect((await run('tier', { args })).status, JSON.stringify(args)).toBe(400);
    }
  });
});

describe('data-delete: the dashboard\'s delete, by id', () => {
  function fixture(options: { connected?: boolean; canRestart?: boolean; busy?: boolean; sourceId?: string } = {}) {
    const root = tempDir('olympus-cli-route-delete-');
    const homeDir = join(root, 'home');
    const registryPath = join(root, 'handles.json');
    const registry: ConnectedHandleRegistry = options.connected === true
      ? {
          version: 1,
          handles: [{
            handle: 'dropbox.personal',
            provider: 'dropbox',
            accountRole: 'personal',
            trustDomain: 'secure_local',
            allowedCapabilities: ['dropbox.files.sync'],
            scopes: ['files.content.read'],
            connectedAt: '2026-08-30T00:00:00.000Z',
          }],
        }
      : { version: 1, handles: [] };
    writeConnectedHandleRegistry(registry, registryPath);
    const context = { homeDir, env: {} };
    const store = lifecycleSourceSpecs().find((entry) => entry.sourceId === (options.sourceId ?? 'dropbox.files'))!.connectorStorePaths!(context)[0]!;
    mkdirSync(dirname(store), { recursive: true });
    writeFileSync(store, 'indexed');
    const restarts = { requested: 0 };
    const worker = createEmailSourceWorker({
      ...(options.busy === true
        ? {
            sourceScheduler: {
              status: () => ({ enabled: true, running: true, sources: [] }),
              hasExecutingTask: () => true,
              updateSources: () => undefined,
            } as never,
          }
        : {}),
      sourceDashboard: {
        sovereigntyEngine: createSovereigntyEngine(buildEnvBridgeSovereigntyConfig({})),
        registryPath,
        registryAdoptionIntervalMs: 0,
        dataLifecyclePathContext: context,
        ...(options.canRestart === false
          ? {}
          : { workerRestart: { canRestart: () => true, request: () => { restarts.requested += 1; return true; } } }),
      },
    });
    const del = (body: Record<string, unknown>) => worker.fetch(post('data-delete', forRoot(body, context)));
    return { registryPath, context, store, restarts, del };
  }

  test('deletes a disconnected source\'s indexed data and asks the worker to reopen its stores', async () => {
    const f = fixture();
    const response = await f.del({ source_id: 'dropbox.files', dry_run: false });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      mode: 'source',
      sourceId: 'dropbox.files',
      dryRun: false,
      // The store, then the account folder that held it.
      removed: [f.store, dirname(dirname(f.store))],
      custody: { requirement: 'source_disconnected', ready: true, observed: 'disconnected' },
      worker_restarting: true,
    });
    expect(existsSync(f.store)).toBe(false);
    expect(f.restarts.requested).toBe(1);
  });

  test('refuses, deleting nothing, a command for a data root this worker does not own, or for none', async () => {
    // A script holds another XDG_DATA_HOME's owner lock while this Olympus runs:
    // the CLI's busy lock is that root's, and this worker must not act for it.
    const f = fixture();
    const elsewhere = tempDir('olympus-cli-route-other-root-');
    const other = await f.del({ source_id: 'dropbox.files', dry_run: false, data_root: elsewhere });
    expect(other.status).toBe(409);
    const refusal = await other.json() as { error: { code: string; message: string; suggestion: string } };
    expect(refusal.error.code).toBe('config_error');
    expect(refusal.error.message).toContain(elsewhere);
    expect(refusal.error.message).toContain(lifecycleDataRoot(f.context));
    const unnamed = await f.del({ source_id: 'dropbox.files', dry_run: false, data_root: '' });
    expect(unnamed.status).toBe(409);
    expect(existsSync(f.store)).toBe(true);
    expect(f.restarts.requested).toBe(0);
    for (const operation of WORKER_CLI_OPERATIONS) {
      const response = await createEmailSourceWorker({}).fetch(post(operation, { ...WORK[operation], data_root: elsewhere }));
      expect(response.status, operation).toBe(409);
    }
  });

  test('a dry run answers what the CLI\'s own dry run answers, and changes nothing', async () => {
    const f = fixture({ connected: true });
    const response = await f.del({ source_id: 'dropbox.files', dry_run: true });
    expect(response.status).toBe(200);
    const local = deleteOlympusDataWithCustody({
      sourceId: 'dropbox.files',
      dryRun: true,
      connectedRegistry: readConnectedHandleRegistry(f.registryPath),
      thisComputerSources: [],
      ...f.context,
    });
    expect(await response.json()).toEqual({ ...JSON.parse(JSON.stringify(local)), worker_restarting: false });
    expect(existsSync(f.store)).toBe(true);
    expect(f.restarts.requested).toBe(0);
  });

  test('keeps the dashboard\'s custody: Disconnect first, no read running, a worker that can restart', async () => {
    const connected = fixture({ connected: true });
    const refusedConnected = await connected.del({ source_id: 'dropbox.files', dry_run: false });
    expect(refusedConnected.status).toBe(409);
    await expect(refusedConnected.json()).resolves.toMatchObject({ error: { code: 'delete_source_connected' } });
    expect(existsSync(connected.store)).toBe(true);

    const onThisComputer = fixture({ sourceId: 'local.files' });
    connectThisComputerSource(onThisComputer.registryPath, 'local.files');
    const refusedHere = await onThisComputer.del({ source_id: 'local.files', dry_run: false });
    expect(refusedHere.status).toBe(409);
    await expect(refusedHere.json()).resolves.toMatchObject({ error: { code: 'delete_source_connected' } });

    const busy = fixture({ busy: true });
    const refusedBusy = await busy.del({ source_id: 'dropbox.files', dry_run: false });
    expect(refusedBusy.status).toBe(409);
    await expect(refusedBusy.json()).resolves.toMatchObject({ error: { code: 'delete_source_busy' } });
    expect(existsSync(busy.store)).toBe(true);

    const cannotRestart = fixture({ canRestart: false });
    const refusedRestart = await cannotRestart.del({ source_id: 'dropbox.files', dry_run: false });
    expect(refusedRestart.status).toBe(501);
    await expect(refusedRestart.json()).resolves.toMatchObject({ error: { code: 'delete_reopen_unavailable' } });
    expect(existsSync(cannotRestart.store)).toBe(true);
    for (const f of [connected, onThisComputer, busy, cannotRestart]) expect(f.restarts.requested).toBe(0);
  });

  test('a source with no public capability is deleted only with Olympus stopped, and an unknown source is refused', async () => {
    const f = fixture();
    const stopped = await f.del({ source_id: 'reflect.notes', dry_run: false });
    expect(stopped.status).toBe(409);
    await expect(stopped.json()).resolves.toMatchObject({
      error: { code: 'delete_unavailable', message: 'This source can be deleted only while Olympus is stopped. Stop it first, then retry.' },
    });
    for (const body of [{ source_id: 'made.up', dry_run: false }, { dry_run: false }]) {
      const unknown = await f.del(body);
      expect(unknown.status).toBe(400);
      await expect(unknown.json()).resolves.toMatchObject({ error: { code: 'invalid_params' } });
    }
    expect(existsSync(f.store)).toBe(true);
  });
});
