// The engine split, part 3 (docs/design/engine-split.md, #1064): the command
// channel front → background, the owner-busy relay, the status snapshot, the
// front's write guard, and the host's background-then-front order. With
// worker.engineSplit off nothing here changes what runs.
import { afterEach, describe, expect, test } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { configFromPluginConfig } from '../src/core/config.ts';
import { engineHostServices } from '../src/core/engine-host.ts';
import { ENGINE_BACKGROUND_ORIGIN, ENGINE_ROLE_ENV, engineRoleFromEnv } from '../src/core/engine-split.ts';
import {
  createNativeEngineBackgroundService,
  createNativeWorkerService,
  WORKER_BACKGROUND_STARTING_MESSAGE,
  type NativeWorkerServiceDefinition,
} from '../src/core/native-worker-service.ts';
import { FrontStoreWriteError, forbidWritableStoreOpens, resetStoreWriteGuardForTests } from '../src/core/store-write-guard.ts';
import { TierLedger } from '../src/workers/classification/tier-ledger.ts';
import { SecretLocationsIndex as SecretLocations } from '../src/workers/classification/secret-locations.ts';
import { TierSnifferStore } from '../src/workers/classification/sniffer-store.ts';
import { LocalConnectorStore } from '../src/workers/connector-store/local-index.ts';
import { EngineCommandClient, OwnerBusyRelay } from '../src/workers/engine-split/client.ts';
import {
  createEngineCommandHandler,
  EngineCommandLedger,
  parseEngineCommandEnvelope,
  type EngineCommand,
  type EngineCommandHandlers,
} from '../src/workers/engine-split/commands.ts';
import { BackgroundSyncFailedError, createFrontScheduler } from '../src/workers/engine-split/front-scheduler.ts';
import { frontArchiveViews, frontJudgeState, frontUnreadableFiles } from '../src/workers/engine-split/front-state.ts';
import { createFrontDashboardHistory } from '../src/workers/engine-split/front-history.ts';
import { SqliteSourceDashboardHistory } from '../src/workers/source-dashboard.ts';
import { SqliteSourceIngestionLedgerStore } from '../src/workers/source-ingestion-ledger.ts';
import { LocalSourceWatchStore } from '../src/core/source-watch.ts';
import { LocalFileExtractionJobStore } from '../src/workers/file-extraction/job-store.ts';
import {
  createEngineFrontRoutes,
  createFrontGate,
  engineFrontRefusal,
  tierCommandOnlyReads,
  waitForEngineBackground,
  waitForProcessExit,
} from '../src/workers/engine-split/runtime.ts';
import {
  forwardedRequestToRequest,
  requestToForwarded,
  responseToForwarded,
  type EngineCommandReceipt,
  type EngineForwardedRequest,
} from '../src/workers/engine-split/commands.ts';
import { runTierCommand } from '../src/workers/classification/tier-cli.ts';
import { FIXTURE_PLACEMENT, fixtureConnector, tempDir } from './helpers/tier-fixtures.ts';
import { ENGINE_STATUS_SNAPSHOT_SCHEMA, readEngineStatusSnapshot, startEngineStatusPublisher } from '../src/workers/engine-split/snapshot.ts';
import { createTestClock, flushMicrotasks, waitFor } from './helpers/test-clock.ts';

const TOKEN = 'engine-split-test-token';
const roots: string[] = [];
const services: NativeWorkerServiceDefinition[] = [];

afterEach(async () => {
  resetStoreWriteGuardForTests();
  await Promise.all(services.splice(0).map((service) => service.stop()));
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'olympus-engine-split-'));
  roots.push(root);
  return root;
}

/** A background reached in-process: the client's fetch calls the handler directly. */
function background(handlers: EngineCommandHandlers, instanceId = 'background-1', clock?: ReturnType<typeof createTestClock>) {
  let ready = true;
  const ledger = new EngineCommandLedger({ instanceId, handlers });
  const handler = createEngineCommandHandler({
    authToken: TOKEN, ledger, ready: () => ready,
    ...(clock ? { setTimeout: (callback: () => void, ms: number) => clock.setTimeout(callback, ms), clearTimeout: (timer: unknown) => clock.clearTimeout(timer as never) } : {}),
  });
  const fetchBackground = ((input: RequestInfo | URL, init?: RequestInit) => handler(new Request(input, init))) as typeof fetch;
  return { ledger, handler, fetch: fetchBackground, setReady: (value: boolean) => { ready = value; } };
}

describe('the switch and roles', () => {
  test('worker.engineSplit is off by default and parses only a boolean', () => {
    expect(configFromPluginConfig({}).worker.engineSplit).toBe(false);
    expect(configFromPluginConfig({ worker: { engineSplit: true } }).worker.engineSplit).toBe(true);
    expect(() => configFromPluginConfig({ worker: { engineSplit: 'yes' } })).toThrow('worker.engineSplit');
  });

  test('no role is the one worker of today; anything else than background or front refuses', () => {
    expect(engineRoleFromEnv({})).toBe('single');
    expect(engineRoleFromEnv({ [ENGINE_ROLE_ENV]: 'background' })).toBe('background');
    expect(engineRoleFromEnv({ [ENGINE_ROLE_ENV]: 'front' })).toBe('front');
    expect(() => engineRoleFromEnv({ [ENGINE_ROLE_ENV]: 'both' })).toThrow();
  });

  test('switch off: the engine host runs exactly the services it ran before', () => {
    const config = { worker: { authToken: TOKEN, service: { enabled: true } }, email: { baseUrl: 'http://127.0.0.1:8010/v1' } };
    expect(engineHostServices(config, 'file:///fixture/dist/cli.js').map((service) => service.id)).toEqual([
      'olympus-worker', 'olympus-remote-relay', 'olympus-source-embedding-drain',
    ]);
  });

  test('switch on: the background is started before the worker, and so stopped after it', () => {
    const config = { worker: { authToken: TOKEN, engineSplit: true, service: { enabled: true } }, email: { baseUrl: 'http://127.0.0.1:8010/v1' } };
    expect(engineHostServices(config, 'file:///fixture/dist/cli.js').map((service) => service.id)).toEqual([
      'olympus-worker-background', 'olympus-worker', 'olympus-remote-relay', 'olympus-source-embedding-drain',
    ]);
  });
});

describe('commands from the front to the background', () => {
  test('a command is applied once under retry, and its result comes back', async () => {
    const applied: string[] = [];
    const bg = background({ reload: ({ target }) => { applied.push(target); return { reloaded: target }; } });
    // The first answer is lost on the way back: the client posts again under the same id.
    let dropped = false;
    const lossy = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const response = await bg.fetch(input, init);
      if (!dropped && init?.method === 'POST') { dropped = true; throw new TypeError('connection reset'); }
      return response;
    }) as typeof fetch;
    const clock = createTestClock();
    const client = new EngineCommandClient({ fetch: lossy, authToken: TOKEN, sleep: clock.sleep, now: clock.now, newId: () => 'command-0001' });
    const sending = client.send({ kind: 'reload', target: 'sources' });
    await flushMicrotasks();
    await clock.advance(100);
    const receipt = await sending;
    expect(receipt).toMatchObject({ id: 'command-0001', state: 'done', result: { reloaded: 'sources' } });
    expect(applied).toEqual(['sources']);
    // And an explicit resend of the same id is answered from the record.
    const again = await client.send({ kind: 'reload', target: 'sources' }, { id: 'command-0001' });
    expect(again.state).toBe('done');
    expect(applied).toEqual(['sources']);
  });

  test('a used id for a different command is refused, not applied', async () => {
    const applied: string[] = [];
    const bg = background({ reload: ({ target }) => { applied.push(target); } });
    bg.ledger.submit({ id: 'command-0002', command: { kind: 'reload', target: 'sources' } });
    const response = await bg.handler(new Request(`${ENGINE_BACKGROUND_ORIGIN}/engine/commands`, {
      method: 'POST', headers: { Authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ id: 'command-0002', command: { kind: 'reload', target: 'scope' } }),
    }));
    expect(response.status).toBe(409);
    await flushMicrotasks();
    expect(applied).toEqual(['sources']);
  });

  test('receipt at once, result when committed; commands about one source keep their order', async () => {
    const order: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const bg = background({
      sync_now: async ({ source }) => { order.push(`sync:${source}:start`); if (order.length === 1) await gate; order.push(`sync:${source}:end`); return { outcome: 'started' }; },
      start_approved: ({ source }) => { order.push(`start:${source}`); return { outcome: 'ingestion_started' }; },
    });
    const first = bg.ledger.submit({ id: 'command-0003', command: { kind: 'sync_now', source: 'dropbox.files', manual: true } });
    const second = bg.ledger.submit({ id: 'command-0004', command: { kind: 'start_approved', source: 'dropbox.files' } });
    expect(first.state).toBe('received');
    expect(second.state).toBe('received');
    await flushMicrotasks();
    expect(order).toEqual(['sync:dropbox.files:start']);
    release();
    await flushMicrotasks();
    expect(order).toEqual(['sync:dropbox.files:start', 'sync:dropbox.files:end', 'start:dropbox.files']);
    expect(bg.ledger.get('command-0004')).toMatchObject({ state: 'done', result: { outcome: 'ingestion_started' } });
  });

  test('the socket wants the worker bearer, and takes no command before the background is ready', async () => {
    const bg = background({});
    const unauthorized = await bg.handler(new Request(`${ENGINE_BACKGROUND_ORIGIN}/engine/ready`));
    expect(unauthorized.status).toBe(401);
    bg.setReady(false);
    const ready = await bg.handler(new Request(`${ENGINE_BACKGROUND_ORIGIN}/engine/ready`, { headers: { Authorization: `Bearer ${TOKEN}` } }));
    expect(ready.status).toBe(503);
    const post = await bg.handler(new Request(`${ENGINE_BACKGROUND_ORIGIN}/engine/commands`, {
      method: 'POST', headers: { Authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ id: 'command-0005', command: { kind: 'reload', target: 'sources' } }),
    }));
    expect(post.status).toBe(503);
    expect(bg.ledger.get('command-0005')).toBeUndefined();
  });

  test('a background restart loses its record: the id is posted again and applied once there', async () => {
    const applied: string[] = [];
    const clock = createTestClock();
    const first = background({ sync_now: () => { applied.push('first'); return new Promise(() => {}); } }, 'background-1', clock);
    const second = background({ sync_now: () => { applied.push('second'); return { outcome: 'started' }; } }, 'background-2', clock);
    let current = first;
    const fetchCurrent = ((input: RequestInfo | URL, init?: RequestInit) => current.fetch(input, init)) as typeof fetch;
    const client = new EngineCommandClient({ fetch: fetchCurrent, authToken: TOKEN, sleep: clock.sleep, now: clock.now, newId: () => 'command-0006' });
    // The first background takes the command and never finishes it; then it is replaced.
    const sending = client.send({ kind: 'sync_now', source: 'gmail.email', manual: true }, { timeoutMs: 600_000 });
    await flushMicrotasks();
    current = second;
    await clock.advance(10_000);
    const receipt = await sending;
    expect(receipt).toMatchObject({ state: 'done', instance_id: 'background-2' });
    expect(applied).toEqual(['first', 'second']);
  });

  test('judge_boost takes at most 20 items; unknown commands are refused', () => {
    const item = (n: number) => ({ provider: 'p', accountScope: 'a', providerItemId: `i${n}` });
    expect(parseEngineCommandEnvelope({ id: 'command-0007', command: { kind: 'judge_boost', identities: Array.from({ length: 20 }, (_, n) => item(n)) } }).command.kind).toBe('judge_boost');
    expect(() => parseEngineCommandEnvelope({ id: 'command-0008', command: { kind: 'judge_boost', identities: Array.from({ length: 21 }, (_, n) => item(n)) } })).toThrow('1 to 20');
    expect(() => parseEngineCommandEnvelope({ id: 'command-0009', command: { kind: 'drop_everything' } })).toThrow('Unknown command');
    expect(() => parseEngineCommandEnvelope({ id: 'short', command: { kind: 'reload', target: 'sources' } })).toThrow('id');
  });
});

describe('the owner-busy signal across the split', () => {
  test('busy and idle reach the background; a restarted background is told busy again', async () => {
    const sent: EngineCommand[] = [];
    const relay = new OwnerBusyRelay({ post: async (command) => { sent.push(command); return { id: 'x', state: 'done', instance_id: 'b' }; } });
    relay.observeInstance('background-1');
    relay.busy('built_in');
    relay.observeInstance('background-1');
    expect(sent).toEqual([{ kind: 'owner_busy', resource: 'built_in' }]);
    relay.observeInstance('background-2');
    expect(sent).toEqual([{ kind: 'owner_busy', resource: 'built_in' }, { kind: 'owner_busy', resource: 'built_in' }]);
    relay.idle('built_in');
    relay.observeInstance('background-3');
    expect(sent.at(-1)).toEqual({ kind: 'owner_idle', resource: 'built_in' });
    expect(sent).toHaveLength(3);
  });
});

describe('owner busy stays current through a long owner call', () => {
  test('the front says busy again every three minutes while the call runs, and stops when it ends', async () => {
    const clock = createTestClock();
    const sent: EngineCommand[] = [];
    const relay = new OwnerBusyRelay(
      { post: async (command) => { sent.push(command); return { id: 'x', state: 'done', instance_id: 'b' }; } },
      () => {},
      { setInterval: (callback, ms) => clock.setInterval(callback, ms), clearInterval: (timer) => clock.clearInterval(timer as never) },
    );
    relay.busy('built_in');
    expect(sent).toEqual([{ kind: 'owner_busy', resource: 'built_in' }]);
    // A call longer than the background's ten-minute lapse is renewed before it lapses.
    await clock.advance(12 * 60_000);
    expect(sent.filter((command) => command.kind === 'owner_busy')).toHaveLength(5);
    relay.idle('built_in');
    expect(sent.at(-1)).toEqual({ kind: 'owner_idle', resource: 'built_in' });
    const settled = sent.length;
    await clock.advance(30 * 60_000);
    expect(sent).toHaveLength(settled);
    expect(clock.pendingTimers()).toBe(0);
  });
});

describe('owner actions the background runs, forwarded from the front', () => {
  function sentReceipt(result: { status: number; body: unknown }): EngineCommandReceipt {
    return { id: 'c', state: 'done', instance_id: 'b', result: { status: result.status, headers: { 'content-type': 'application/json' }, body: JSON.stringify(result.body) } };
  }

  test('a forwarded route crosses the socket whole, and a kind carries only its own routes', async () => {
    const original = new Request('http://127.0.0.1:8787/v1/cli/tier', {
      method: 'POST',
      headers: { authorization: 'Bearer owner', 'content-type': 'application/json', connection: 'keep-alive', 'x-olympus-relay': 'marker' },
      body: JSON.stringify({ args: ['set', 'm7', 'private'] }),
    });
    const forwarded = await requestToForwarded(original);
    expect(forwarded.path).toBe('/v1/cli/tier');
    expect(forwarded.headers.connection).toBeUndefined();
    // Headers a route checks (the relay marker among them) travel with it.
    expect(forwarded.headers['x-olympus-relay']).toBe('marker');
    const envelope = parseEngineCommandEnvelope(JSON.parse(JSON.stringify({ id: 'command-0001', command: { kind: 'tier_override', request: forwarded } })));
    expect(envelope.command).toEqual({ kind: 'tier_override', request: forwarded });
    const rebuilt = forwardedRequestToRequest('http://olympus-worker.internal', (envelope.command as { request: EngineForwardedRequest }).request);
    expect(new URL(rebuilt.url).pathname).toBe('/v1/cli/tier');
    expect(await rebuilt.json()).toEqual({ args: ['set', 'm7', 'private'] });
    const answer = await responseToForwarded(new Response('{"ok":true}', { status: 201, headers: { 'content-type': 'application/json', 'set-cookie': 'x=1' } }));
    expect(answer).toEqual({ status: 201, headers: { 'content-type': 'application/json' }, body: '{"ok":true}' });

    // A kind cannot carry another kind's route, and only a delete names the front's process.
    expect(() => parseEngineCommandEnvelope({ id: 'command-0002', command: { kind: 'capture', request: forwarded } })).toThrow();
    expect(() => parseEngineCommandEnvelope({ id: 'command-0003', command: { kind: 'tier_override', request: forwarded, frontPid: 42 } })).toThrow();
    expect(() => parseEngineCommandEnvelope({ id: 'command-0004', command: { kind: 'tier_override', request: { ...forwarded, body: { args: [] } } } })).toThrow();
    const deleting = { path: '/dashboard/delete-source-data', headers: {}, body: '{}' };
    expect(parseEngineCommandEnvelope({ id: 'command-0005', command: { kind: 'delete_source_data', request: deleting, frontPid: 42 } }).command)
      .toEqual({ kind: 'delete_source_data', request: deleting, frontPid: 42 });
  });

  test('tier reads stay in the front; every tier write and the other owner actions go to the background', async () => {
    const sent: EngineCommand[] = [];
    const routes = createEngineFrontRoutes({
      client: { send: async (command) => { sent.push(command); return sentReceipt({ status: 200, body: { ran: command.kind } }); } },
      gate: createFrontGate(),
      restartFront: () => { throw new Error('no restart'); },
    });
    const post = (path: string, body: unknown) => new Request(`http://127.0.0.1${path}`, { method: 'POST', body: JSON.stringify(body) });
    expect(tierCommandOnlyReads(JSON.stringify({ args: ['explain', 'm7'] }))).toBe(true);
    expect(tierCommandOnlyReads(JSON.stringify({ args: ['migrate', 'status'] }))).toBe(true);
    expect(tierCommandOnlyReads(JSON.stringify({ args: ['migrate', 'plan'] }))).toBe(false);
    expect(tierCommandOnlyReads('not json')).toBe(false);
    expect(await routes(post('/v1/cli/tier', { args: ['explain', 'm7'] }))).toBeUndefined();
    expect(sent).toEqual([]);
    for (const [path, kind] of [
      ['/v1/cli/tier', 'tier_override'],
      ['/v1/cli/pairing-placement', 'storage_registry'],
      ['/dashboard/messaging/respond', 'capture'],
      ['/v1/source/index/embed', 'embed_chunks'],
    ] as const) {
      const response = await routes(post(path, { args: ['set', 'm7', 'private'] }));
      expect(await response!.json(), path).toEqual({ ran: kind });
    }
    expect(sent.map((command) => command.kind)).toEqual(['tier_override', 'storage_registry', 'capture', 'embed_chunks']);
    // Not a forwarded route, or not a POST: the front's own handler serves it.
    expect(routes(new Request('http://127.0.0.1/v1/cli/tier'))).toBeUndefined();
    expect(routes(post('/dashboard/messaging/status', {}))).toBeUndefined();
    // The background's failure and its absence read as such.
    const failing = createEngineFrontRoutes({ client: { send: async () => ({ id: 'c', state: 'failed', instance_id: 'b', error: 'no' }) }, gate: createFrontGate(), restartFront: () => {} });
    expect((await failing(post('/v1/cli/pairing-account', {})))!.status).toBe(502);
    const away = createEngineFrontRoutes({ client: { send: async () => { throw new Error('gone'); } }, gate: createFrontGate(), restartFront: () => {} });
    expect((await away(post('/v1/cli/pairing-account', {})))!.status).toBe(503);
  });

  test('tier explain runs in the front on read-only opens', async () => {
    const workspace = tempDir('olympus-engine-split-tier-');
    roots.push(workspace.dir);
    const dbPath = join(workspace.dir, 'chat-store.sqlite');
    const store = new LocalConnectorStore({ dbPath, corpusId: 'secure_local.fixture.chat', family: 'file', trustDomain: 'secure_local' });
    await store.syncFromConnector(fixtureConnector(() => [{ id: 'm7', name: 'hello', text: 'See you at noon.', legacyDomain: 'secure_local' }]), { fetchContent: true, placement: FIXTURE_PLACEMENT });
    store.close();
    forbidWritableStoreOpens();
    expect(await runTierCommand(['explain', 'm7'], { storePaths: [dbPath] })).toMatchObject({ item: { providerItemId: 'm7' }, stores: [{ recorded: true }] });
    await expect(runTierCommand(['set', 'm7', 'private'], { storePaths: [dbPath] })).rejects.toBeInstanceOf(FrontStoreWriteError);
  });

  test('a delete closes the gate before it is sent, drops reads in flight, and restarts the front once answered', async () => {
    const gate = createFrontGate();
    let answer!: (receipt: EngineCommandReceipt) => void;
    const sent: EngineCommand[] = [];
    let restarts = 0;
    const routes = createEngineFrontRoutes({
      client: { send: (command) => { sent.push(command); return new Promise((resolve) => { answer = resolve; }); } },
      gate,
      restartFront: () => { restarts += 1; },
      pid: 4242,
    });
    // The front's handler: forwarded routes first, then the reads.
    let releaseRead!: () => void;
    const reading = new Promise<void>((resolve) => { releaseRead = resolve; });
    const serve = gate.wrap(async (request: Request, _server: undefined) => {
      const routed = routes(request);
      if (routed) { const response = await routed; if (response) return response; }
      if (new URL(request.url).pathname === '/slow-read') await reading;
      return Response.json({ rows: ['private'] });
    });
    const inFlight = serve(new Request('http://127.0.0.1/slow-read'), undefined);
    await flushMicrotasks();
    const deleting = serve(new Request('http://127.0.0.1/dashboard/delete-source-data', { method: 'POST', body: JSON.stringify({ source_id: 'gmail:a', acknowledge: true }) }), undefined);
    await flushMicrotasks();
    // Closed before the background is asked; the front's process goes with the command.
    expect(gate.isOpen()).toBe(false);
    expect(sent).toEqual([expect.objectContaining({ kind: 'delete_source_data', frontPid: 4242 })]);
    expect((await serve(new Request('http://127.0.0.1/read'), undefined)).status).toBe(503);
    releaseRead();
    const dropped = await inFlight;
    expect(dropped.status).toBe(503);
    expect(await dropped.json()).toMatchObject({ error: { code: 'worker_restarting' } });
    answer(sentReceipt({ status: 200, body: { ok: true, worker_restarting: true } }));
    const response = await deleting;
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, worker_restarting: true });
    expect(restarts).toBe(1);
    expect(gate.isOpen()).toBe(false);
  });

  test('a delete the background refuses, or a dry run, reopens the gate without a restart', async () => {
    for (const reply of [
      sentReceipt({ status: 409, body: { error: { code: 'disconnect_first' } } }),
      sentReceipt({ status: 200, body: { ok: true, worker_restarting: false } }),
      { id: 'c', state: 'failed', instance_id: 'b', error: 'boom' } as EngineCommandReceipt,
    ]) {
      const gate = createFrontGate();
      let restarts = 0;
      const routes = createEngineFrontRoutes({ client: { send: async () => reply }, gate, restartFront: () => { restarts += 1; } });
      await routes(new Request('http://127.0.0.1/v1/cli/data-delete', { method: 'POST', body: '{}' }));
      expect(gate.isOpen()).toBe(true);
      expect(restarts).toBe(0);
    }
  });

  test('the background waits out the front before it restarts to delete', async () => {
    const clock = createTestClock();
    let alive = true;
    let ended: boolean | undefined;
    void waitForProcessExit(4242, { now: clock.now, sleep: clock.sleep, alive: () => alive }).then((value) => { ended = value; });
    await clock.advance(5_000);
    expect(ended).toBeUndefined();
    alive = false;
    await clock.advance(250);
    expect(ended).toBe(true);
    let gaveUp: boolean | undefined;
    void waitForProcessExit(4243, { now: clock.now, sleep: clock.sleep, alive: () => true, timeoutMs: 60_000 }).then((value) => { gaveUp = value; });
    await clock.advance(61_000);
    expect(gaveUp).toBe(false);
  });
});

describe('the status snapshot', () => {
  test('published atomically every interval and read with its age', async () => {
    const root = tempRoot();
    const path = join(root, 'status.json');
    const clock = createTestClock();
    let backlog = 5;
    const publisher = startEngineStatusPublisher({
      path, instanceId: 'background-1', now: clock.date, intervalMs: 3_000,
      setInterval: clock.setInterval, clearInterval: (timer) => clock.clearInterval(timer as never),
      collect: () => ({ scheduler: null, judge: { backlog, pending: null, spending: null }, captures: {} }),
    });
    expect(readEngineStatusSnapshot(path, clock.now)).toMatchObject({ age_ms: 0, snapshot: { schema: ENGINE_STATUS_SNAPSHOT_SCHEMA, judge: { backlog: 5 } } });
    backlog = 3;
    await clock.advance(2_000);
    expect(readEngineStatusSnapshot(path, clock.now)).toMatchObject({ age_ms: 2_000, snapshot: { judge: { backlog: 5 } } });
    await clock.advance(1_000);
    expect(readEngineStatusSnapshot(path, clock.now)).toMatchObject({ age_ms: 0, snapshot: { judge: { backlog: 3 } } });
    publisher.stop();
    expect(readEngineStatusSnapshot(join(root, 'missing.json'))).toBeUndefined();
  });

  test('the front scheduler answers from the snapshot and turns wakes into commands', async () => {
    const sent: EngineCommand[] = [];
    const status = { kind: 'source_scheduler_status', enabled: true, running: true, generated_at: 'now', sources: [{ source_id: 'gmail.email', corpus_id: 'gmail', tasks: [{ running: true }] }], policy: {} };
    const clock = createTestClock();
    const scheduler = createFrontScheduler({
      client: { post: async (command) => { sent.push(command); return { id: 'x', state: 'received', instance_id: 'b' }; } },
      snapshot: () => ({ age_ms: 10, snapshot: { scheduler: status, manual_syncs: { 'gmail.email': { started_at: clock.date().toISOString(), state: 'done' } } } as never }),
      now: clock.date,
      sleep: clock.sleep,
    });
    expect(scheduler.status()).toBe(status as never);
    expect(scheduler.hasExecutingTask(new Set(['gmail.email']))).toBe(true);
    await scheduler.runSource('gmail.email', undefined, 'operator');
    scheduler.updateSources([]);
    scheduler.wakeTasksOfKind('extract');
    await flushMicrotasks();
    expect(sent).toEqual([
      { kind: 'sync_now', source: 'gmail.email', manual: true },
      { kind: 'reload', target: 'sources' },
      { kind: 'reload', target: 'extraction' },
    ]);
  });
});

describe('state the front shows from the snapshot', () => {
  function snapshotWith(fields: Record<string, unknown>) {
    let current: Record<string, unknown> | undefined = fields;
    return {
      read: () => (current ? { age_ms: 5, snapshot: { judge: { backlog: null, pending: null, spending: null }, ...current } as never } : undefined),
      set: (next: Record<string, unknown> | undefined) => { current = next; },
    };
  }

  test('Sync now in the front settles when the background says its pass ended, and reads a failure as one', async () => {
    const clock = createTestClock();
    const status = { kind: 'source_scheduler_status', enabled: true, running: false, generated_at: 'now', sources: [], policy: {} };
    const snapshot = snapshotWith({ scheduler: status, manual_syncs: { 'gmail.email': { started_at: new Date(clock.now() - 60_000).toISOString(), state: 'done' } } });
    const sent: EngineCommand[] = [];
    const scheduler = createFrontScheduler({
      client: { post: async (command) => { sent.push(command); return { id: 'x', state: 'received', instance_id: 'b' }; } },
      snapshot: snapshot.read, now: clock.date, sleep: clock.sleep,
    });
    let settled: unknown;
    void scheduler.runSource('gmail.email', undefined, 'operator').then((value) => { settled = value; });
    await flushMicrotasks();
    // An older press's record is not this one's.
    await clock.advance(5_000);
    expect(settled).toBeUndefined();
    snapshot.set({ scheduler: status, manual_syncs: { 'gmail.email': { started_at: clock.date().toISOString(), state: 'running' } } });
    await clock.advance(5_000);
    expect(settled).toBeUndefined();
    snapshot.set({ scheduler: status, manual_syncs: { 'gmail.email': { started_at: new Date(clock.now() - 5_000).toISOString(), state: 'done' } } });
    await clock.advance(1_000);
    expect(settled).toBe(status);

    snapshot.set({ scheduler: status, manual_syncs: { 'gmail.email': { started_at: clock.date().toISOString(), state: 'failed', failure_code: 'auth_expired' } } });
    const failure = await scheduler.runSource('gmail.email', undefined, 'operator').catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(BackgroundSyncFailedError);
    expect((failure as BackgroundSyncFailedError).code).toBe('auth_expired');

    // A scheduled run answers at once; an operator run that never reports is read as it stands after the wait.
    snapshot.set({ scheduler: status });
    expect(await scheduler.runSource('gmail.email')).toBe(status as never);
    let gaveUp: unknown;
    void scheduler.runSource('gmail.email', undefined, 'operator').then((value) => { gaveUp = value; });
    await flushMicrotasks();
    await clock.advance(31 * 60_000);
    expect(gaveUp).toBe(status);
    expect(sent.map((command) => (command as { manual?: boolean }).manual)).toEqual([true, true, false, true]);
  });

  test('judge backlog, unreadable counts and the archive views come from the snapshot', () => {
    const backlog = { checkingItems: 3, remainingQuestions: 2, pendingItems: 3, summary: 'Checking 3 items.', awaitingOwnerApproval: false };
    const snapshot = snapshotWith({
      judge: { backlog, pending: 3, spending: null, busy: true, archive_private_model: 'ready' },
      unreadable: { 'dropbox.files': { unreadable: 4, blocked: 1 } },
      archive: { view: { archives: ['from-background'] }, cards: [{ sourceId: 'card' }], source_imports: [], sources: [{ sourceId: 'whatsapp' }] },
    });
    const judge = frontJudgeState(snapshot.read);
    expect(judge.backlog()).toEqual(backlog as never);
    expect(judge.busy()).toBe(true);
    expect(judge.archivePrivateModel()).toBe('ready' as never);
    const counted: string[] = [];
    const local = {
      recheck: (corpusId: string) => { counted.push(corpusId); return { unreadable: 99, blocked: 0 }; },
      names: () => ['report.pdf'],
    } as never as Parameters<typeof frontUnreadableFiles>[0];
    const unreadable = frontUnreadableFiles(local, snapshot.read);
    expect(unreadable.recheck('dropbox.files')).toEqual({ unreadable: 4, blocked: 1 });
    expect(unreadable.recheck('gmail')).toBeUndefined();
    // The front counts nothing itself; names stay its own reads.
    expect(counted).toEqual([]);
    expect(unreadable.names(['dropbox.files'], 5)).toEqual(['report.pdf']);
    const read: string[] = [];
    const views = frontArchiveViews({
      view: () => { read.push('view'); return { archives: ['local'] } as never; },
      cardViews: () => { read.push('cards'); return []; },
      sourceImports: () => { read.push('imports'); return []; },
      archiveSources: () => { read.push('sources'); return []; },
    }, snapshot.read);
    expect(views.view()).toEqual({ archives: ['from-background'] } as never);
    expect(views.cardViews()).toEqual([{ sourceId: 'card' }] as never);
    expect(views.archiveSources()).toEqual([{ sourceId: 'whatsapp' }] as never);
    expect(read).toEqual([]);
    // Before any snapshot: nothing pending, and the front's own read of the archives.
    snapshot.set(undefined);
    expect(judge.backlog()).toBeUndefined();
    expect(judge.busy()).toBe(false);
    expect(judge.archivePrivateModel()).toBe('waiting');
    expect(views.view()).toEqual({ archives: ['local'] } as never);
  });
});

describe('the front writes nothing the background owns', () => {
  test('with the guard on, every writable store and ledger open throws; read-only opens work', () => {
    const root = tempRoot();
    const storePath = join(root, 'internal.sqlite');
    new LocalConnectorStore({ corpusId: 'c', family: 'note', dbPath: storePath, trustDomain: 'internal', tierLedger: null }).close();
    const ledgerPath = join(root, 'ledger.sqlite');
    new TierLedger({ dbPath: ledgerPath }).close();
    forbidWritableStoreOpens();
    expect(() => new LocalConnectorStore({ corpusId: 'c', family: 'note', dbPath: storePath, trustDomain: 'internal', tierLedger: null })).toThrow(FrontStoreWriteError);
    expect(() => new TierLedger({ dbPath: ledgerPath })).toThrow(FrontStoreWriteError);
    expect(() => new TierSnifferStore({ dbPath: join(root, 'sniffer.sqlite') })).toThrow(FrontStoreWriteError);
    expect(() => new SecretLocations({ dbPath: join(root, 'secrets.sqlite') })).toThrow(FrontStoreWriteError);
    new LocalConnectorStore({ corpusId: 'c', family: 'note', dbPath: storePath, trustDomain: 'internal', readOnly: true }).close();
    new TierLedger({ dbPath: ledgerPath, readOnly: true }).close();
  });

  test('the shared files the background owns: writable opens throw in the front, read-only opens work', () => {
    const root = tempRoot();
    const dashboard = join(root, 'source-dashboard.sqlite');
    const watches = join(root, 'source-watches.sqlite');
    const jobs = join(root, 'file-extraction-jobs.sqlite');
    new SqliteSourceDashboardHistory(dashboard).close();
    new LocalSourceWatchStore(watches).close();
    new LocalFileExtractionJobStore(jobs).close();
    forbidWritableStoreOpens();
    expect(() => new SqliteSourceDashboardHistory(dashboard)).toThrow(FrontStoreWriteError);
    expect(() => new SqliteSourceIngestionLedgerStore(dashboard)).toThrow(FrontStoreWriteError);
    expect(() => new LocalSourceWatchStore(watches)).toThrow(FrontStoreWriteError);
    expect(() => new LocalFileExtractionJobStore(jobs)).toThrow(FrontStoreWriteError);
    new SqliteSourceDashboardHistory(dashboard, { readOnly: true }).close();
    new LocalSourceWatchStore(watches, { readOnly: true }).close();
    new LocalFileExtractionJobStore(jobs, { readonly: true }).close();
  });

  test('the front reads dashboard progress read-only and sends its samples for the background to record', async () => {
    const root = tempRoot();
    const path = join(root, 'source-dashboard.sqlite');
    const writer = new SqliteSourceDashboardHistory(path);
    const sent: EngineCommand[] = [];
    const clock = createTestClock();
    const history = createFrontDashboardHistory({
      path, now: clock.now, minIntervalMs: 30_000,
      client: { post: async (command) => { sent.push(command); return { id: 'x', state: 'received', instance_id: 'b' }; } },
    });
    const sample = { source_id: 'gmail.email', corpus_id: 'gmail', sampled_at: clock.date().toISOString(), indexed_items: 5, content_ready_items: 5, queue_waiting: 0, queue_active: 0, queue_attention: 0 };
    forbidWritableStoreOpens();
    history.record([sample]);
    history.record([sample]);
    expect(sent).toEqual([{ kind: 'dashboard_samples', samples: [sample] }]);
    expect(history.sampleCount()).toBe(0);
    writer.record([sample]);
    expect(history.sampleCount()).toBe(1);
    await clock.advance(30_000);
    history.record([sample]);
    expect(sent).toHaveLength(2);
    writer.close();
    // Text never travels as a sample.
    expect(() => parseEngineCommandEnvelope({ id: 'command-0010', command: { kind: 'dashboard_samples', samples: [{ ...sample, title: 'secret' }] } })).toThrow('count samples');
  });

  test('owner actions without a command yet are refused in the front, everything else passes', () => {
    for (const path of ['/v1/source/watch/create', '/v1/source/index/files/extract', '/v1/source/index/dropbox/content/plan', '/v1/source/index/dropbox/transcribe']) {
      expect(engineFrontRefusal(new Request(`http://127.0.0.1${path}`, { method: 'POST' }))?.status, path).toBe(503);
    }
    // The forwarded owner actions are no longer refused: they run in the background.
    for (const path of ['/dashboard/delete-source-data', '/v1/cli/tier', '/v1/source/index/embed', '/dashboard/messaging/start']) {
      expect(engineFrontRefusal(new Request(`http://127.0.0.1${path}`, { method: 'POST' })), path).toBeUndefined();
    }
    expect(engineFrontRefusal(new Request('http://127.0.0.1/dashboard/sync-now', { method: 'POST' }))).toBeUndefined();
    expect(engineFrontRefusal(new Request('http://127.0.0.1/dashboard/messaging/status', { method: 'POST' }))).toBeUndefined();
    expect(engineFrontRefusal(new Request('http://127.0.0.1/v1/cli/tier'))).toBeUndefined();
    expect(engineFrontRefusal(new Request('http://127.0.0.1/v1/source/index/files/status', { method: 'POST' }))).toBeUndefined();
    expect(engineFrontRefusal(new Request('http://127.0.0.1/v1/source/watches', { method: 'POST' }))).toBeUndefined();
  });
});

describe('the host starts the background, then the front', () => {
  test('the front waits for its background and gives up with a retryable start while it is not ready', async () => {
    const bg = background({});
    bg.setReady(false);
    const clock = createTestClock();
    const waiting = waitForEngineBackground({ socketPath: '/unused', authToken: TOKEN, fetch: bg.fetch, sleep: clock.sleep, now: clock.now, timeoutMs: 1_000, pollMs: 250 });
    let settled = false;
    void waiting.then(() => { settled = true; }, () => { settled = true; });
    await flushMicrotasks();
    await clock.advance(500);
    expect(settled).toBe(false);
    bg.setReady(true);
    await clock.advance(250);
    await waiting;
  });

  test('a front worker service does not start while its background is not ready', async () => {
    const fixture = fakeWorker(tempRoot());
    const service = track(createNativeWorkerService({
      initialPluginConfig: fixture.pluginConfig({ engineSplit: true }), moduleUrl: import.meta.url, workerEnvPath: fixture.envPath,
      fetch, startupTimeoutMs: 2_000, readinessPollMs: 10, stopGraceMs: 50, restartDelaysMs: [60_000],
      engineBackground: { isReady: () => false }, engineBackgroundWaitMs: 0,
    }));
    await expect(service.start({})).rejects.toThrow(WORKER_BACKGROUND_STARTING_MESSAGE);
    expect(service.isReady()).toBe(false);
  });

  test('switch on: the front starts with the front role once the background is ready; switch off: no role', async () => {
    for (const engineSplit of [true, false]) {
      const fixture = fakeWorker(tempRoot());
      const service = track(createNativeWorkerService({
        initialPluginConfig: fixture.pluginConfig({ engineSplit }), moduleUrl: import.meta.url, workerEnvPath: fixture.envPath,
        fetch, startupTimeoutMs: 10_000, readinessPollMs: 10, stopGraceMs: 50,
        engineBackground: { isReady: () => true },
      }));
      await service.start({});
      expect(service.isReady()).toBe(true);
      const env = JSON.parse(readFileSync(fixture.rolePath, 'utf8')) as Record<string, string | undefined>;
      expect(env.role).toBe(engineSplit ? 'front' : undefined);
      expect(Boolean(env.socket)).toBe(engineSplit);
      await service.stop();
    }
  }, 30_000);

  test('the background is ready on its command socket, and is restarted when it exits', async () => {
    const fixture = fakeWorker(tempRoot());
    const background = createNativeEngineBackgroundService({
      initialPluginConfig: fixture.pluginConfig({ engineSplit: true }), moduleUrl: import.meta.url, workerEnvPath: fixture.envPath,
      startupTimeoutMs: 10_000, readinessPollMs: 10, stopGraceMs: 50, restartDelaysMs: [10],
    });
    track(background);
    await background.start({});
    expect(background.isReady()).toBe(true);
    const firstPid = Number(readFileSync(fixture.pidPath, 'utf8'));
    process.kill(firstPid, 'SIGKILL');
    await waitFor(() => background.isReady() && Number(readFileSync(fixture.pidPath, 'utf8')) !== firstPid, { timeoutMs: 20_000 });
    expect(JSON.parse(readFileSync(fixture.rolePath, 'utf8')).role).toBe('background');
  }, 30_000);

  test('switch off: the background service starts nothing', async () => {
    const fixture = fakeWorker(tempRoot());
    const background = track(createNativeEngineBackgroundService({
      initialPluginConfig: fixture.pluginConfig({ engineSplit: false }), moduleUrl: import.meta.url, workerEnvPath: fixture.envPath,
    }));
    await background.start({});
    expect(background.isReady()).toBe(false);
    expect(() => readFileSync(fixture.pidPath)).toThrow();
  });
});

function track<T extends NativeWorkerServiceDefinition>(service: T): T {
  services.push(service);
  return service;
}

/**
 * A stand-in worker: it records its role, serves the readiness route on its
 * port as a front or single worker, and as a background serves /engine/ready
 * on the command socket the host named.
 */
function fakeWorker(root: string) {
  const scriptPath = join(root, 'fake-worker.mjs');
  const envPath = join(root, 'worker.env');
  const rolePath = join(root, 'role.json');
  const pidPath = join(root, 'worker.pid');
  mkdirSync(join(root, 'run'), { recursive: true, mode: 0o700 });
  const server = Bun.serve({ port: 0, fetch: () => new Response('') });
  const port = server.port!;
  server.stop(true);
  writeFileSync(scriptPath, `
import { rmSync, writeFileSync } from 'node:fs';
const env = process.env;
// The real background removes a stopped background's socket after taking the data lock.
if (env.OLYMPUS_WORKER_ENGINE_ROLE === 'background') rmSync(env.OLYMPUS_ENGINE_BACKGROUND_SOCKET, { force: true });
writeFileSync(env.FAKE_ROLE_PATH, JSON.stringify({ role: env.OLYMPUS_WORKER_ENGINE_ROLE, socket: env.OLYMPUS_ENGINE_BACKGROUND_SOCKET }));
writeFileSync(env.FAKE_PID_PATH, String(process.pid));
const token = env.OLYMPUS_WORKER_AUTH_TOKEN;
const authed = (request) => request.headers.get('authorization') === 'Bearer ' + token;
const server = env.OLYMPUS_WORKER_ENGINE_ROLE === 'background'
  ? Bun.serve({ unix: env.OLYMPUS_ENGINE_BACKGROUND_SOCKET, fetch(request) {
      if (!authed(request)) return new Response('', { status: 401 });
      return Response.json({ ready: true, schema_current: true, instance_id: env.OLYMPUS_NATIVE_SERVICE_INSTANCE_ID });
    } })
  : Bun.serve({ hostname: '127.0.0.1', port: Number(env.OLYMPUS_EMAIL_SOURCE_PORT), fetch(request) {
      if (!authed(request)) return new Response('', { status: 401 });
      return Response.json({ instance_id: env.OLYMPUS_NATIVE_SERVICE_INSTANCE_ID });
    } });
process.once('SIGTERM', () => { server.stop(true); process.exit(0); });
setInterval(() => {}, 1000);
`, { mode: 0o700 });
  writeFileSync(envPath, [
    `OLYMPUS_EMAIL_SOURCE_PORT=${port}`,
    `OLYMPUS_WORKER_AUTH_TOKEN=${TOKEN}`,
    `FAKE_ROLE_PATH=${rolePath}`,
    `FAKE_PID_PATH=${pidPath}`,
    `HOME=${root}`,
    `XDG_DATA_HOME=${join(root, 'data')}`,
    `XDG_RUNTIME_DIR=${join(root, 'run')}`,
    '',
  ].join('\n'), { mode: 0o600 });
  chmodSync(envPath, 0o600);
  return {
    envPath, rolePath, pidPath,
    pluginConfig: (worker: { engineSplit: boolean }) => ({
      worker: { authToken: TOKEN, engineSplit: worker.engineSplit, service: { enabled: true, runtimePath: process.execPath, executablePath: scriptPath } },
      email: { baseUrl: `http://127.0.0.1:${port}/v1` },
    }),
  };
}
