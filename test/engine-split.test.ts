// The engine split, part 3 (docs/design/engine-split.md, #1064): the command
// channel front → background, the owner-busy relay, the status snapshot, the
// front's write guard, and the host's background-then-front order. With
// worker.engineSplit off nothing here changes what runs.
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { configFromPluginConfig } from '../src/core/config.ts';
import { engineHostServices } from '../src/core/engine-host.ts';
import { ENGINE_BACKGROUND_ORIGIN, ENGINE_ROLE_ENV, engineRoleFromEnv } from '../src/core/engine-split.ts';
import { FrontStoreWriteError, forbidWritableStoreOpens, resetStoreWriteGuardForTests } from '../src/core/store-write-guard.ts';
import { TierLedger } from '../src/workers/classification/tier-ledger.ts';
import { classifyItemTiers } from '../src/workers/classification/tier-classifier.ts';
import { createReleaseTierCheck, registerGovernedStore } from '../src/workers/connector-store/tier-visibility.ts';
import { SecretLocationsIndex as SecretLocations } from '../src/workers/classification/secret-locations.ts';
import { TierSnifferStore } from '../src/workers/classification/sniffer-store.ts';
import { LocalConnectorStore } from '../src/workers/connector-store/local-index.ts';
import { createExistingStoreTierLane, createLaneTieredStoreSet, createTieredLaneSet, tieredStoreSetLedgerPath } from '../src/workers/connector-store/tiered-store-set.ts';
import { EngineCommandClient, EngineCommandUnavailableError, OwnerBusyRelay } from '../src/workers/engine-split/client.ts';
import {
  createEngineCommandHandler,
  EngineCommandLedger,
  parseEngineCommandEnvelope,
  type EngineCommand,
  type EngineCommandHandlers,
} from '../src/workers/engine-split/commands.ts';
import { BackgroundSyncFailedError, createFrontScheduler } from '../src/workers/engine-split/front-scheduler.ts';
import { frontArchiveViews, frontCaptureStop, frontJudgeBoost, frontJudgeState, frontModelReload, frontSetItemPrivate, frontUnreadableFiles } from '../src/workers/engine-split/front-state.ts';
import { ENGINE_FORWARDED_ROUTES } from '../src/workers/engine-split/commands.ts';
import { readFileSync } from 'node:fs';
import { createFrontDashboardHistory, openReadOnlyDashboardHistory, openWritableDashboardHistory } from '../src/workers/engine-split/front-history.ts';
import { SqliteSourceDashboardHistory } from '../src/workers/source-dashboard.ts';
import { SqliteSourceIngestionLedgerStore } from '../src/workers/source-ingestion-ledger.ts';
import { createTrustedSourceWatchOwnerContext, LocalSourceWatchStore } from '../src/core/source-watch.ts';
import { LocalPeopleIndex } from '../src/core/people-index.ts';
import { LocalFileExtractionJobStore } from '../src/workers/file-extraction/job-store.ts';
import {
  createEngineFront,
  createEngineFrontRoutes,
  createFrontGate,
  engineStatusSnapshotPath,
  OwnerBusyMarks,
  tierCommandOnlyReads,
  waitForProcessExit,
} from '../src/workers/engine-split/runtime.ts';
import {
  forwardedRecordId,
  forwardedRequestToRequest,
  requestToForwarded,
  tagForwardedRequest,
  responseToForwarded,
  type EngineCommandReceipt,
  type EngineForwardedRequest,
} from '../src/workers/engine-split/commands.ts';
import { runTierCommand } from '../src/workers/classification/tier-cli.ts';
import { FIXTURE_PLACEMENT, fixtureConnector, tempDir } from './helpers/tier-fixtures.ts';
import { ENGINE_STATUS_SNAPSHOT_SCHEMA, ENGINE_STATUS_STALE_MS, readEngineStatusSnapshot, startEngineStatusPublisher } from '../src/workers/engine-split/snapshot.ts';
import { createTestClock, DEFAULT_TEST_CLOCK_START, flushMicrotasks } from './helpers/test-clock.ts';

const TOKEN = 'engine-split-test-token';
const roots: string[] = [];

afterEach(async () => {
  resetStoreWriteGuardForTests();
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

  test('a background that never answers, or never finishes its body, is aborted at the deadline', async () => {
    const clock = createTestClock();
    const signals: AbortSignal[] = [];
    const silent = ((_input: RequestInfo | URL, init?: RequestInit) => { signals.push(init!.signal!); return new Promise<Response>(() => {}); }) as typeof fetch;
    const client = new EngineCommandClient({
      fetch: silent, authToken: TOKEN, sleep: clock.sleep, now: clock.now, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout as (timer: unknown) => void, newId: () => 'command-0040',
    });
    let outcome: unknown;
    void client.send({ kind: 'reload', target: 'sources' }, { timeoutMs: 20_000 }).then((value) => { outcome = value; }, (error) => { outcome = error; });
    await flushMicrotasks();
    await clock.advance(20_000);
    await flushMicrotasks();
    expect(outcome).toBeInstanceOf(EngineCommandUnavailableError);
    expect(signals.length).toBeGreaterThan(0);
    expect(signals.every((signal) => signal.aborted)).toBe(true);

    // Headers arrive but the body never does: the body read is bounded too.
    const stalledSignals: AbortSignal[] = [];
    const stalled = ((_input: RequestInfo | URL, init?: RequestInit) => {
      stalledSignals.push(init!.signal!);
      return Promise.resolve({ status: 202, json: () => new Promise(() => {}) } as unknown as Response);
    }) as typeof fetch;
    const bodyClient = new EngineCommandClient({
      fetch: stalled, authToken: TOKEN, sleep: clock.sleep, now: clock.now, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout as (timer: unknown) => void, newId: () => 'command-0041',
    });
    let bodyOutcome: unknown;
    void bodyClient.post({ kind: 'reload', target: 'sources' }, { timeoutMs: 20_000 }).then((value) => { bodyOutcome = value; }, (error) => { bodyOutcome = error; });
    await flushMicrotasks();
    await clock.advance(20_000);
    await flushMicrotasks();
    expect(bodyOutcome).toBeInstanceOf(EngineCommandUnavailableError);
    expect(stalledSignals.every((signal) => signal.aborted)).toBe(true);
    expect(clock.pendingTimers()).toBe(0);
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
    const relay = new OwnerBusyRelay({ post: async (command) => { sent.push(command); return { id: 'x', state: 'done', instance_id: 'b' }; } }, () => {}, { front: 'front-1' });
    relay.observeInstance('background-1');
    relay.busy('built_in');
    relay.observeInstance('background-1');
    expect(sent).toEqual([{ kind: 'owner_busy', resource: 'built_in', front: 'front-1', seq: 1 }]);
    relay.observeInstance('background-2');
    expect(sent).toEqual([{ kind: 'owner_busy', resource: 'built_in', front: 'front-1', seq: 1 }, { kind: 'owner_busy', resource: 'built_in', front: 'front-1', seq: 2 }]);
    relay.idle('built_in');
    relay.observeInstance('background-3');
    expect(sent.at(-1)).toEqual({ kind: 'owner_idle', resource: 'built_in', front: 'front-1', seq: 3 });
    expect(sent).toHaveLength(3);
  });

  test('a delayed or retried change never overrides a newer one', () => {
    const clock = createTestClock();
    const marks = new OwnerBusyMarks({ now: clock.now });
    const change = (kind: 'owner_busy' | 'owner_idle', seq: number, front = 'front-1') => ({ kind, resource: 'built_in', front, seq });
    expect(marks.apply(change('owner_busy', 1))).toBe(true);
    expect(marks.apply(change('owner_idle', 2))).toBe(true);
    // The busy's retry arrives after the idle: ignored, the judge is not held back.
    expect(marks.apply(change('owner_busy', 1))).toBe(false);
    expect(marks.busy('built_in')).toBe(false);
    expect(marks.apply(change('owner_busy', 3))).toBe(true);
    // A delayed idle from before that busy does not clear it.
    expect(marks.apply(change('owner_idle', 2))).toBe(false);
    expect(marks.busy('built_in')).toBe(true);
    // A new front (a restart) starts its own count and supersedes the old marks.
    expect(marks.apply(change('owner_idle', 1, 'front-2'))).toBe(true);
    expect(marks.busy('built_in')).toBe(false);
    // A busy mark lapses after ten minutes.
    marks.apply(change('owner_busy', 2, 'front-2'));
    clock.set(clock.now() + 10 * 60_000 + 1);
    expect(marks.busy('built_in')).toBe(false);
    expect(() => parseEngineCommandEnvelope({ id: 'command-0095', command: { kind: 'owner_busy', resource: 'built_in' } })).toThrow('sequence number');
    const server = readFileSync(join(import.meta.dir, '../src/workers/email-source/server.ts'), 'utf8');
    expect(server).toMatch(/owner_busy: \(change\) => \{\s*if \(!remoteOwnerMarks\.apply\(change\)\)/);
    expect(server).toMatch(/owner_idle: \(change\) => \{\s*if \(!remoteOwnerMarks\.apply\(change\)\)/);
  });
});

describe('owner busy stays current through a long owner call', () => {
  test('the front says busy again every three minutes while the call runs, and stops when it ends', async () => {
    const clock = createTestClock();
    const sent: EngineCommand[] = [];
    const relay = new OwnerBusyRelay(
      { post: async (command) => { sent.push(command); return { id: 'x', state: 'done', instance_id: 'b' }; } },
      () => {},
      { setInterval: (callback, ms) => clock.setInterval(callback, ms), clearInterval: (timer) => clock.clearInterval(timer as never), front: 'front-1' },
    );
    relay.busy('built_in');
    expect(sent).toEqual([{ kind: 'owner_busy', resource: 'built_in', front: 'front-1', seq: 1 }]);
    // A call longer than the background's ten-minute lapse is renewed before it lapses.
    await clock.advance(12 * 60_000);
    expect(sent.filter((command) => command.kind === 'owner_busy')).toHaveLength(5);
    relay.idle('built_in');
    expect(sent.at(-1)).toEqual({ kind: 'owner_idle', resource: 'built_in', front: 'front-1', seq: 6 });
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
    // The one-item privacy change (dashboard and agent) is a tier write too; a CLI-shaped body does not make it a read.
    for (const path of ['/dashboard/privacy/items/set', '/v1/privacy-item/raise']) {
      const response = await routes(post(path, { args: ['explain', 'm7'] }));
      expect(await response!.json(), path).toEqual({ ran: 'tier_override' });
    }
    expect(routes(post('/dashboard/privacy/items/find', {}))).toBeUndefined();
    expect(routes(post('/v1/privacy-item/find', {}))).toBeUndefined();
    // Not a forwarded route, or not a POST: the front's own handler serves it.
    expect(routes(new Request('http://127.0.0.1/v1/cli/tier'))).toBeUndefined();
    expect(routes(post('/dashboard/connect', {}))).toBeUndefined();
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
    ]) {
      const gate = createFrontGate();
      let restarts = 0;
      const routes = createEngineFrontRoutes({ client: { send: async () => reply }, gate, restartFront: () => { restarts += 1; } });
      await routes(new Request('http://127.0.0.1/v1/cli/data-delete', { method: 'POST', body: '{}' }));
      expect(gate.isOpen()).toBe(true);
      expect(restarts).toBe(0);
    }
  });

  test('a delete whose outcome is unknown keeps the gate closed and restarts the front', async () => {
    for (const send of [
      async (): Promise<EngineCommandReceipt> => { throw new Error('The background did not answer in time.'); },
      async (): Promise<EngineCommandReceipt> => ({ id: 'c', state: 'failed', instance_id: 'b', error: 'boom' }),
    ]) {
      const gate = createFrontGate();
      let restarts = 0;
      const routes = createEngineFrontRoutes({ client: { send }, gate, restartFront: () => { restarts += 1; } });
      const response = await routes(new Request('http://127.0.0.1/v1/cli/data-delete', { method: 'POST', body: '{}' }));
      expect(response!.status).toBe(503);
      expect(await response!.json()).toMatchObject({ error: { code: 'worker_restarting' } });
      // The background may have marked the account: nothing is read again until the front has restarted.
      expect(gate.isOpen()).toBe(false);
      expect(restarts).toBe(1);
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

describe('a forwarded create is idempotent across a background restart', () => {
  test('the command id reaches the handler, and a watch created twice under it is one watch', async () => {
    const ids: string[] = [];
    const ledger = new EngineCommandLedger({ instanceId: 'background-1', handlers: { source_watch: (_command, { id }) => { ids.push(id); } } });
    const forwarded = { path: '/v1/source/watch/create', headers: {}, body: '{}' };
    ledger.submit({ id: 'command-0090', command: { kind: 'source_watch', request: forwarded } });
    // A second background (after a restart) gets the same id again.
    new EngineCommandLedger({ instanceId: 'background-2', handlers: { source_watch: (_command, { id }) => { ids.push(id); } } })
      .submit({ id: 'command-0090', command: { kind: 'source_watch', request: forwarded } });
    await flushMicrotasks();
    expect(ids).toEqual(['command-0090', 'command-0090']);

    // Only the background's own Request carries an id; a client cannot set one.
    const tagged = tagForwardedRequest(forwardedRequestToRequest('http://olympus-worker.internal', forwarded), 'command-0090');
    const untagged = forwardedRequestToRequest('http://olympus-worker.internal', forwarded);
    expect(forwardedRecordId(untagged)).toBeUndefined();
    const watchId = forwardedRecordId(tagged)!;
    expect(watchId).toBe('engine-command-0090');
    const again = forwardedRecordId(tagForwardedRequest(forwardedRequestToRequest('http://olympus-worker.internal', forwarded), 'command-0090'));
    expect(again).toBe(watchId);

    const store = new LocalSourceWatchStore(join(tempRoot(), 'watches.sqlite'));
    const owner = createTrustedSourceWatchOwnerContext({ ownerId: 'owner-a', routeKind: 'openclaw_task', routeTargetId: '019f6ff4-2fb0-70a3-91dd-3ef3ada9354f' });
    const input = { corpusId: 'internal.telegram.messages', queryText: 'the lease renewal', mode: 'continuous' as const };
    store.createWatch({ ...input, watchId }, owner);
    store.createWatch({ ...input, watchId: again! }, owner);
    expect(store.listWatches(owner).items.map((watch) => watch.watchId)).toEqual([watchId]);
    store.close();

    const index = readFileSync(join(import.meta.dir, '../src/workers/email-source/index.ts'), 'utf8');
    expect(index).toMatch(/const recordId = sourceWatch\.recordId\?\.\(request\);/);
    const server = readFileSync(join(import.meta.dir, '../src/workers/email-source/server.ts'), 'utf8');
    expect(server).toMatch(/recordId: forwardedRecordId,/);
    expect(server).toMatch(/source_watch: \(\{ request \}, \{ id \}\) => runForwarded\(request, id\)/);
  });
});

describe('a model change restarts both processes', () => {
  test('the background is told first; the front restarts once it has answered', async () => {
    const sent: EngineCommand[] = [];
    let answer!: (receipt: EngineCommandReceipt) => void;
    const restarts: unknown[] = [];
    const logs: string[] = [];
    const reload = frontModelReload<string>({
      client: { send: (command) => { sent.push(command); return new Promise((resolve) => { answer = resolve; }); } },
      restartSelf: (request) => { restarts.push(request); return true; },
      managed: true, pid: 4242, log: (line) => logs.push(line),
    });
    expect(reload('judge')).toBe(true);
    expect(reload('judge-again')).toBe(true);
    expect(sent).toEqual([{ kind: 'reload', target: 'models', frontPid: 4242 }]);
    await flushMicrotasks();
    expect(restarts).toEqual([]);
    answer({ id: 'c', state: 'done', instance_id: 'b', result: { reloaded: 'models', restarting: true } });
    await flushMicrotasks();
    expect(restarts).toEqual(['judge']);
    expect(logs).toEqual([]);
    // No answer: the front still restarts and says so.
    const away = frontModelReload({ client: { send: async () => { throw new Error('gone'); } }, restartSelf: () => { restarts.push('away'); return true; }, managed: true, pid: 4242, log: (line) => logs.push(line) });
    away();
    await flushMicrotasks();
    expect(restarts).toEqual(['judge', 'away']);
    expect(logs).toHaveLength(1);
    // A front that cannot restart itself asks nothing.
    const unmanaged = frontModelReload({ client: { send: async () => { throw new Error('not sent'); } }, restartSelf: () => true, managed: false });
    expect(unmanaged()).toBe(false);
    expect(() => parseEngineCommandEnvelope({ id: 'command-0080', command: { kind: 'reload', target: 'sources', frontPid: 4242 } })).toThrow('models reload');
    expect(parseEngineCommandEnvelope({ id: 'command-0081', command: { kind: 'reload', target: 'models', frontPid: 4242 } }).command).toEqual({ kind: 'reload', target: 'models', frontPid: 4242 });
    const server = readFileSync(join(import.meta.dir, '../src/workers/email-source/server.ts'), 'utf8');
    expect(server).toMatch(/const reloadModels = engineFront\s*\?\s*frontModelReload\(/);
    expect(server).toMatch(/if \(target === 'models'\) \{[\s\S]{0,400}?waitForProcessExit\(frontPid\)\.then\(\(\) => \{ requestModelReload\(\); \}\)/);
    // After a delete only the front restarts: the background is already on its way.
    expect(server).toMatch(/if \(!restartFrontOnly\(\)\) console\.warn/);
  });
});

describe('matched-first judging across the split', () => {
  test('a question in the front raises its matched items in the background judge', async () => {
    const posted: EngineCommand[] = [];
    const boost = frontJudgeBoost({ post: async (command) => { posted.push(command); return { id: 'c', state: 'received', instance_id: 'b' }; } });
    const item = (n: number) => ({ provider: 'gmail', accountScope: 'me', providerItemId: `m${n}`, ...(n === 0 ? { providerConversationId: 't0' } : {}) });
    boost(Array.from({ length: 25 }, (_, n) => item(n)));
    boost([]);
    expect(posted).toHaveLength(1);
    const sent = posted[0] as Extract<EngineCommand, { kind: 'judge_boost' }>;
    expect(sent.identities).toHaveLength(20);
    expect(sent.identities[0]).toEqual(item(0));
    // What the front sends is what the background accepts.
    expect(parseEngineCommandEnvelope({ id: 'command-0070', command: sent }).command).toEqual(sent);
    const server = readFileSync(join(import.meta.dir, '../src/workers/email-source/server.ts'), 'utf8');
    expect(server).toMatch(/const raiseJudgeBoosts = engineFront \? frontJudgeBoost\(engineFront\.client\)/);
    expect(server).toMatch(/judge_boost: \(\{ identities \}\) => \{\s*judgeBoosts\.raise\(identities\);/);
  });
});

describe('the private-answer queue has one consumer', () => {
  test('only the front (or the single worker) starts the queue and the unchecked retry', () => {
    const server = readFileSync(join(import.meta.dir, '../src/workers/email-source/server.ts'), 'utf8');
    expect(server).toMatch(/const frontOwnsPrivateAnswerQueue = engineRole !== 'background';/);
    const starts = server.match(/^.*localPrivateAnswers\.start\(\);.*$/gm) ?? [];
    expect(starts.length).toBeGreaterThan(0);
    for (const line of starts) expect(line).toContain('if (frontOwnsPrivateAnswerQueue) localPrivateAnswers.start();');
    const retries = server.match(/^.*retryUnchecked\(\).*$/gm) ?? [];
    expect(retries.length).toBe(1);
    expect(server).toMatch(/const uncheckedRetry = frontOwnsPrivateAnswerQueue \? setInterval\(/);
  });
});

describe('scheduled backups have one exporter', () => {
  test('the background does not run the backup tick beside the front', () => {
    const server = readFileSync(join(import.meta.dir, '../src/workers/email-source/server.ts'), 'utf8');
    const ticks = server.match(/^.*backupService\.tick\(\).*$/gm) ?? [];
    expect(ticks).toHaveLength(1);
    expect(ticks[0]).toContain("if (engineRole !== 'background') setInterval(");
  });
});

describe('configured mounts are governed by their ledgers', () => {
  test('a ledger-backed configured store (Reflect, Roam) is registered, in the front as in the single worker', () => {
    const root = tempRoot();
    const path = join(root, 'reflect.sqlite');
    const identity = { provider: 'reflect', accountScope: 'reflect:me', providerItemId: 'note-1' };
    const writer = new LocalConnectorStore({ dbPath: path, corpusId: 'internal.reflect.notes', family: 'note', trustDomain: 'internal' });
    writer.tierLedger()!.recordDecision(identity, classifyItemTiers({ signals: { title: 'note-1' }, text: 'A plain note.', subject: identity }));
    writer.close();
    const bare = new LocalConnectorStore({ dbPath: join(root, 'roam.sqlite'), corpusId: 'internal.roam.pages', family: 'note', trustDomain: 'internal' });
    const newLane = (ledger: TierLedger) => ({ ledger, corpusIds: new Set<string>() });
    const input = { corpusId: 'internal.reflect.notes', ...identity, privateAtAnswer: false };
    for (const front of [false, true]) {
      if (front) forbidWritableStoreOpens();
      const store = new LocalConnectorStore({ dbPath: path, corpusId: 'internal.reflect.notes', family: 'note', trustDomain: 'internal', ...(front ? { readOnly: true } : {}) });
      const lanes: Array<{ ledger: TierLedger; corpusIds: Set<string> }> = [];
      const check = createReleaseTierCheck(() => lanes, () => 'approval');
      // Unregistered, its item is read as legacy: a later Private verdict would not hold an answer back.
      expect(check.inputs([input])[0]!.tier).toBe('legacy');
      expect(registerGovernedStore(lanes, store, (ledger) => { const lane = newLane(ledger); lane.corpusIds.add(store.corpusId); return lane; })).toBe('registered');
      expect(check.inputs([input])[0]!.tier).toBe('public_or_personal');
      expect(registerGovernedStore(lanes, store, newLane)).toBe('already');
      // A store with no ledger yet holds only legacy items and waits; nothing is created for it.
      if (!front) expect(registerGovernedStore(lanes, bare, newLane)).toBe('no_ledger');
      store.close();
    }
    bare.close();
    const server = readFileSync(join(import.meta.dir, '../src/workers/email-source/server.ts'), 'utf8');
    expect(server).toMatch(/for \(const store of configuredConnectorStores\) registerConfiguredTierStore\(store\);/);
    expect(server).toMatch(/adoptConfiguredPrincipal\(mount\);\s*registerConfiguredTierStore\(mount\.store\);/);
  });
});

describe('in-process callers go through the forwarding layer', () => {
  test('remote agents, the ChatGPT surface and the panel tools reach routes as the listener does', () => {
    const server = readFileSync(join(import.meta.dir, '../src/workers/email-source/server.ts'), 'utf8');
    // No in-process caller is handed the bare worker: privacy_item_set over MCP would hit the front's write guard.
    expect(server).not.toMatch(/workerFetch: worker\.fetch\b/);
    expect(server.match(/workerFetch: workerFetchInProcess,/g)?.length).toBe(3);
    expect(server).toMatch(/const frontWorkerFetch = frontRoutes[\s\S]{0,200}?\n  inProcessFetch = frontWorkerFetch;/);
  });
});

describe('Make Private from the front', () => {
  test('the recorded item goes to the background with its identity; a refusal marks nothing', async () => {
    const seen: EngineCommand[] = [];
    let refuse = false;
    const bg = background({ tier_set_recorded: (command) => {
      seen.push(command);
      if (refuse) throw new Error('That locator no longer names the item it was recorded for, so nothing was changed.');
      return { set: 'private' };
    } });
    const clock = createTestClock();
    const setPrivate = frontSetItemPrivate(new EngineCommandClient({ fetch: bg.fetch, authToken: TOKEN, sleep: clock.sleep, now: clock.now }));
    expect(await setPrivate({ locator: 'telegram:chat-1:m7', provider: 'telegram', providerItemId: 'm7', providerConversationId: 'chat-1' })).toEqual({ set: 'private' });
    expect(seen).toEqual([{ kind: 'tier_set_recorded', locator: 'telegram:chat-1:m7', expected: { provider: 'telegram', providerItemId: 'm7', providerConversationId: 'chat-1' } }]);
    refuse = true;
    await expect(setPrivate({ locator: 'telegram:chat-1:m8', provider: 'telegram', providerItemId: 'm8' })).rejects.toThrow('no longer names');
    expect(() => parseEngineCommandEnvelope({ id: 'command-0060', command: { kind: 'tier_set_recorded', locator: 'x', expected: { provider: 'telegram' } } })).toThrow('recorded provider and item');
    const server = readFileSync(join(import.meta.dir, '../src/workers/email-source/server.ts'), 'utf8');
    expect(server).toMatch(/setItemPrivate: engineFront\s*\?\s*frontSetItemPrivate\(engineFront\.client\)/);
    expect(server).toMatch(/tier_set_recorded: async \(\{ locator, expected \}\) => \{[\s\S]{0,200}?runTierSetOnRecordedItem\(locator, 'private', expected\)/);
  });
});

describe('messaging capture across the split', () => {
  test('Unpair and Disconnect stop the background capture and wait for its answer', async () => {
    const stopped: string[] = [];
    let fail = false;
    const bg = background({ capture_stop: async ({ source }) => { if (fail) throw new Error('helper did not exit'); stopped.push(source); return { stopped: source }; } });
    const clock = createTestClock();
    const client = new EngineCommandClient({ fetch: bg.fetch, authToken: TOKEN, sleep: clock.sleep, now: clock.now });
    const stop = frontCaptureStop(client);
    await stop('telegram');
    expect(stopped).toEqual(['telegram']);
    // A stop the background could not confirm keeps the caller from tearing the grant down.
    fail = true;
    await expect(stop('whatsapp')).rejects.toThrow('helper did not exit');
    expect(() => parseEngineCommandEnvelope({ id: 'command-0050', command: { kind: 'capture_stop', source: 'signal' } })).toThrow('telegram or whatsapp');
    // The front's route wiring uses it: the front's own supervisors are empty.
    const server = readFileSync(join(import.meta.dir, '../src/workers/email-source/server.ts'), 'utf8');
    expect(server).toMatch(/const stopMessagingCapture = engineFront\s*\?\s*frontCaptureStop\(engineFront\.client\)/);
    expect(server).toMatch(/capture_stop: async \(\{ source \}\) => \{\s*await captureOwnership\.stopForUnpair\(source\);/);
  });

  test('pairing status and chats go to the background that holds the pairing', () => {
    expect([...ENGINE_FORWARDED_ROUTES.capture].sort()).toEqual([
      '/dashboard/messaging/cancel', '/dashboard/messaging/chats', '/dashboard/messaging/respond',
      '/dashboard/messaging/scope', '/dashboard/messaging/start', '/dashboard/messaging/status',
    ]);
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
    // Ten missed publishes later the reading is stale.
    clock.set(clock.now() + ENGINE_STATUS_STALE_MS);
    expect(readEngineStatusSnapshot(path, clock.now)).toMatchObject({ stale: false });
    clock.set(clock.now() + 1);
    expect(readEngineStatusSnapshot(path, clock.now)).toMatchObject({ stale: true, age_ms: ENGINE_STATUS_STALE_MS + 1 });
    publisher.stop();
    expect(readEngineStatusSnapshot(join(root, 'missing.json'))).toBeUndefined();
  });

  test('the front scheduler answers from the snapshot and turns wakes into commands', async () => {
    const sent: EngineCommand[] = [];
    const status = { kind: 'source_scheduler_status', enabled: true, running: true, generated_at: 'now', sources: [{ source_id: 'gmail.email', corpus_id: 'gmail', tasks: [{ running: true }] }], policy: {} };
    const clock = createTestClock();
    const scheduler = createFrontScheduler({
      client: { post: async (command) => { sent.push(command); return { id: 'x', state: 'received', instance_id: 'b' }; } },
      snapshot: () => ({ age_ms: 10, stale: false, snapshot: { scheduler: status, manual_syncs: { 'gmail.email': { started_at: clock.date().toISOString(), state: 'done' } } } as never }),
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
    let stale = false;
    let writtenAt = DEFAULT_TEST_CLOCK_START;
    return {
      read: () => (current ? { age_ms: 5, stale, snapshot: { judge: { backlog: null, pending: null, spending: null }, written_at: new Date(writtenAt).toISOString(), ...current } as never } : undefined),
      set: (next: Record<string, unknown> | undefined) => { current = next; },
      setStale: (value: boolean) => { stale = value; },
      setWrittenAt: (value: number) => { writtenAt = value; },
    };
  }

  test('a stale snapshot neither holds Disconnect back nor settles a Sync now', async () => {
    const clock = createTestClock();
    const status = {
      kind: 'source_scheduler_status', enabled: true, running: true, generated_at: 'yesterday', policy: {},
      sources: [{ source_id: 'gmail.email', corpus_id: 'internal.gmail', tasks: [{ kind: 'sync', running: true }] }],
    };
    const snapshot = snapshotWith({ scheduler: status, manual_syncs: { 'gmail.email': { started_at: clock.date().toISOString(), state: 'done' } } });
    const scheduler = createFrontScheduler({
      client: { post: async () => ({ id: 'x', state: 'received', instance_id: 'b' }) },
      snapshot: snapshot.read, now: clock.date, sleep: clock.sleep, manualSyncWaitMs: 10_000,
    });
    expect(scheduler.hasExecutingTask(new Set(['gmail.email']))).toBe(true);
    // The publisher stopped a day ago: its last running task is not running now.
    snapshot.setStale(true);
    expect(scheduler.hasExecutingTask(new Set(['gmail.email']))).toBe(false);
    expect(scheduler.status().sources).toEqual([]);
    // Nor does its record settle a press: the press waits out its time instead.
    let settled = false;
    void scheduler.runSource('gmail.email', undefined, 'operator').then(() => { settled = true; });
    await flushMicrotasks();
    await clock.advance(5_000);
    expect(settled).toBe(false);
    await clock.advance(6_000);
    expect(settled).toBe(true);
  });

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

  test('a snapshot from a background other than the one answering commands is stale', async () => {
    const root = tempRoot();
    const env = { HOME: root, XDG_DATA_HOME: join(root, 'data') };
    const clock = createTestClock();
    const answer = (instance: string) => (async () => Response.json({ id: 'command-0110', state: 'done', instance_id: instance })) as unknown as typeof fetch;
    let fetchImpl = answer('background-1');
    const front = createEngineFront({ env, socketPath: join(root, 'engine.sock'), authToken: TOKEN, now: clock.now, fetch: ((input: RequestInfo | URL, init?: RequestInit) => fetchImpl(input, init)) as typeof fetch });
    try {
      mkdirSync(dirname(engineStatusSnapshotPath(env)), { recursive: true });
      const publisher = startEngineStatusPublisher({
        path: engineStatusSnapshotPath(env), instanceId: 'background-1', now: clock.date,
        setInterval: clock.setInterval, clearInterval: (timer) => clock.clearInterval(timer as never),
        collect: () => ({ scheduler: null, judge: { backlog: null, pending: null, spending: null }, captures: {} }),
      });
      await front.client.post({ kind: 'archive_changed' });
      expect(front.status()).toMatchObject({ stale: false });
      // The background restarted: its successor answers, the old file is still on disk.
      fetchImpl = answer('background-2');
      await front.client.post({ kind: 'archive_changed' });
      expect(front.status()).toMatchObject({ stale: true });
      publisher.stop();
      // The other way round: the background that answered restarts, and its
      // successor publishes before any command answers. Its fresh snapshots are current.
      await clock.advance(2_000);
      const successor = startEngineStatusPublisher({
        path: engineStatusSnapshotPath(env), instanceId: 'background-3', now: clock.date,
        setInterval: clock.setInterval, clearInterval: (timer) => clock.clearInterval(timer as never),
        collect: () => ({ scheduler: null, judge: { backlog: null, pending: null, spending: null }, captures: {} }),
      });
      await clock.advance(1_000);
      expect(front.status()).toMatchObject({ stale: false, snapshot: { instance_id: 'background-3' } });
      await clock.advance(3_000);
      expect(front.status()).toMatchObject({ stale: false });
      successor.stop();
    } finally {
      front.stop();
    }
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
    // A stale snapshot is not shown as current: nothing pending, no counts, and the front's own archive read.
    snapshot.setStale(true);
    expect(judge.backlog()).toBeUndefined();
    expect(judge.busy()).toBe(false);
    expect(unreadable.recheck('dropbox.files')).toBeUndefined();
    expect(views.view()).toEqual({ archives: ['local'] } as never);
    snapshot.setStale(false);
    // A snapshot written before the front's own last archive change is not shown either.
    let changedAt: number | undefined = DEFAULT_TEST_CLOCK_START + 1_000;
    const afterChange = frontArchiveViews({
      view: () => ({ archives: ['local'] } as never), cardViews: () => [], sourceImports: () => [], archiveSources: () => [],
    }, snapshot.read, () => changedAt);
    expect(afterChange.view()).toEqual({ archives: ['local'] } as never);
    snapshot.setWrittenAt(DEFAULT_TEST_CLOCK_START + 2_000);
    expect(afterChange.view()).toEqual({ archives: ['from-background'] } as never);
    changedAt = undefined;
    read.length = 0;
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
    expect(() => openWritableDashboardHistory(dashboard)).toThrow(FrontStoreWriteError);
    expect(() => new SqliteSourceIngestionLedgerStore(dashboard)).toThrow(FrontStoreWriteError);
    expect(() => new LocalSourceWatchStore(watches)).toThrow(FrontStoreWriteError);
    expect(() => new LocalFileExtractionJobStore(jobs)).toThrow(FrontStoreWriteError);
    openReadOnlyDashboardHistory(dashboard).close();
    new LocalSourceWatchStore(watches, { readOnly: true }).close();
    new LocalFileExtractionJobStore(jobs, { readonly: true }).close();
  });

  test('a read-only store in the front reads its tier ledger read-only, so its lane keeps its privacy checks', async () => {
    const root = tempRoot();
    const internalPath = join(root, 'internal.sqlite');
    const securePath = join(root, 'secure.sqlite');
    const stores = [
      new LocalConnectorStore({ dbPath: internalPath, corpusId: 'internal.fixture', family: 'file', trustDomain: 'internal' }),
      new LocalConnectorStore({ dbPath: securePath, corpusId: 'secure_local.fixture', family: 'file', trustDomain: 'secure_local' }),
    ] as const;
    createLaneTieredStoreSet({ setId: 'front-set', internalStore: stores[0], secureStore: stores[1], registerWithLedger: false });
    await flushMicrotasks(50);
    for (const store of stores) store.close();
    forbidWritableStoreOpens();
    const secure = new LocalConnectorStore({ dbPath: securePath, corpusId: 'secure_local.fixture', family: 'file', trustDomain: 'secure_local', readOnly: true });
    const ledger = secure.tierLedger();
    expect(ledger).toBeDefined();
    expect(ledger!.dbPath).toBe(tieredStoreSetLedgerPath(securePath));
    // Each factory takes that ledger; none falls back to a writable open.
    const internal = new LocalConnectorStore({ dbPath: internalPath, corpusId: 'internal.fixture', family: 'file', trustDomain: 'internal', readOnly: true });
    // WhatsApp, Readwise and X: an existing Personal store, with Private created on first need.
    expect(() => createExistingStoreTierLane({
      setId: 'front-existing', store: internal,
      newLegs: { secure_local: { corpusId: 'secure_local.fixture', dbPath: securePath, create: () => { throw new Error('not created in the front'); } } },
    })).not.toThrow();
    expect(() => createTieredLaneSet({ setId: 'front-lane', legs: { secure_local: { onDemand: { corpusId: 'secure_local.fixture', dbPath: securePath } }, internal: { store: internal } } } as never)).not.toThrow();
    await flushMicrotasks(50);
    internal.close();
    secure.close();
  });

  test('a lane\'s tiered set in the front opens read-only and does no write work', async () => {
    const root = tempRoot();
    const internalPath = join(root, 'internal.sqlite');
    const securePath = join(root, 'secure.sqlite');
    const writableStores = [
      new LocalConnectorStore({ dbPath: internalPath, corpusId: 'internal.fixture', family: 'file', trustDomain: 'internal' }),
      new LocalConnectorStore({ dbPath: securePath, corpusId: 'secure_local.fixture', family: 'file', trustDomain: 'secure_local' }),
    ] as const;
    createLaneTieredStoreSet({ setId: 'front-set', internalStore: writableStores[0], secureStore: writableStores[1], registerWithLedger: false });
    await flushMicrotasks(50);
    for (const store of writableStores) store.close();
    forbidWritableStoreOpens();
    const internalStore = new LocalConnectorStore({ dbPath: internalPath, corpusId: 'internal.fixture', family: 'file', trustDomain: 'internal', readOnly: true });
    const secureStore = new LocalConnectorStore({ dbPath: securePath, corpusId: 'secure_local.fixture', family: 'file', trustDomain: 'secure_local', readOnly: true });
    const failures: unknown[] = [];
    const onRejection = (reason: unknown) => { failures.push(reason); };
    process.on('unhandledRejection', onRejection);
    try {
      createLaneTieredStoreSet({ setId: 'front-set', internalStore, secureStore, registerWithLedger: false });
      await flushMicrotasks(50);
      internalStore.close();
      secureStore.close();
    } finally {
      process.off('unhandledRejection', onRejection);
    }
    expect(failures).toEqual([]);
  });

  test('the people index is the background\'s: the front opens it read-only and picks up each rebuild', () => {
    const root = tempRoot();
    const path = join(root, 'people-index.sqlite');
    const writer = new LocalPeopleIndex({ dbPath: path });
    writer.rebuild([]);
    forbidWritableStoreOpens();
    expect(() => new LocalPeopleIndex({ dbPath: path })).toThrow(FrontStoreWriteError);
    const reader = new LocalPeopleIndex({ dbPath: path, readOnly: true });
    expect(reader.list()).toEqual([]);
    expect(() => reader.rebuild([])).toThrow();
    resetStoreWriteGuardForTests();
    writer.rebuild([{ provider: 'gmail', senderId: 'ada@example.com', senderLabel: 'Ada Lovelace', corpusId: 'gmail', itemCount: 2, isOwner: false } as never]);
    reader.reload();
    expect(reader.list().map((person) => person.displayName)).toEqual(writer.list().map((person) => person.displayName));
    expect(reader.list().length).toBeGreaterThan(0);
    reader.close();
    writer.close();
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

  test('source watches and the extraction queue are forwarded to the background, not refused', async () => {
    const sent: EngineCommand[] = [];
    const routes = createEngineFrontRoutes({
      client: { send: async (command) => { sent.push(command); return { id: 'c', state: 'done', instance_id: 'b', result: { status: 200, headers: {}, body: JSON.stringify({ ran: command.kind }) } }; } },
      gate: createFrontGate(),
      restartFront: () => {},
    });
    const forwarded = {
      source_watch: ['/v1/source/watch/create', '/v1/source/watch/cancel'],
      extraction_queue: [
        '/v1/source/index/files/plan', '/v1/source/index/files/transcribe', '/v1/source/index/files/recycle-leases',
        '/v1/source/index/files/janitor-requeue', '/v1/source/index/files/extract-pdfs', '/v1/source/index/files/extract',
        '/v1/source/index/dropbox/content/plan', '/v1/source/index/dropbox/content/recycle-leases',
        '/v1/source/index/dropbox/content/janitor-requeue', '/v1/source/index/dropbox/content/extract', '/v1/source/index/dropbox/transcribe',
      ],
    } as const;
    for (const [kind, paths] of Object.entries(forwarded)) {
      for (const path of paths) {
        const response = await routes(new Request(`http://127.0.0.1${path}`, { method: 'POST', body: '{}' }));
        expect(response?.status, path).toBe(200);
        expect(await response!.json(), path).toEqual({ ran: kind });
        expect(sent.at(-1), path).toMatchObject({ kind, request: { path } });
      }
    }
    // Each kind carries only its own routes.
    expect(() => parseEngineCommandEnvelope({ id: 'command-0101', command: { kind: 'source_watch', request: { path: '/v1/source/index/files/extract', headers: {}, body: '{}' } } })).toThrow();
    expect(() => parseEngineCommandEnvelope({ id: 'command-0102', command: { kind: 'extraction_queue', request: { path: '/v1/source/watch/create', headers: {}, body: '{}' } } })).toThrow();
    // Reads of the same families stay in the front.
    for (const path of ['/v1/source/watches', '/v1/source/index/files/status']) {
      expect(routes(new Request(`http://127.0.0.1${path}`, { method: 'POST', body: '{}' })), path).toBeUndefined();
    }
  });
});
