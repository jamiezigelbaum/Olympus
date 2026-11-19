// The background engine's control plane runs on its own thread
// (src/workers/engine-split/control-plane.ts), so what the owner and the
// front wait on never waits on the engine's loop. On 16 Nov the loop on a
// large store was held about a fifth of the time, worst 30 s, and once for
// minutes with no status: forwarded owner actions waited, and the dashboard
// lost its status after 30 s.
//
// The blocked-loop test is the proof: a real background holds its loop in one
// synchronous SQLite call for 60 s, and through all of it (a) a forwarded
// owner command is acknowledged within a second as received, to be applied;
// (b) the status snapshot keeps being published and says how old the loop's
// state is; (c) the front waits on the held loop for neither.
import { Database } from 'bun:sqlite';
import { afterEach, describe, expect, test } from 'bun:test';
import { spawn as spawnProcess } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createUnixSocketFetch } from '../src/core/worker-transport.ts';
import { answerReleaseWithheldReasonOffThread } from '../src/core/release-manifest.ts';
import { ownerTierItemId } from '../src/workers/classification/tier-owner-items.ts';
import { TierLedger } from '../src/workers/classification/tier-ledger.ts';
import { LocalConnectorStore } from '../src/workers/connector-store/local-index.ts';
import { createPendingItemProtection, createReleaseTierCheck, createTierVisibilityGate } from '../src/workers/connector-store/tier-visibility.ts';
import { createEmailSourceWorker } from '../src/workers/engine/index.ts';
import { withWorkerBearerAuth } from '../src/workers/http.ts';
import { EngineCommandClient } from '../src/workers/engine-split/client.ts';
import { frontEngineState } from '../src/workers/engine-split/front-state.ts';
import { EngineCommandError, type EngineCommandEnvelope, type EngineForwardedRequest, type EngineForwardedResponse } from '../src/workers/engine-split/commands.ts';
import { EngineCommandMirror } from '../src/workers/engine-split/control-mirror.ts';
import { CONTROL_BIND, CONTROL_BIND_BOUND, CONTROL_INTS, CONTROL_MESSAGE_BYTES, type ControlToThread } from '../src/workers/engine-split/control-plane.ts';
import { createEngineFront, createEngineFrontRoutes, createFrontGate, engineStatusSnapshotPath, startEngineBackgroundServer, startEngineBackgroundStatus } from '../src/workers/engine-split/runtime.ts';
import { ENGINE_STATUS_STALE_MS, readEngineStatusSnapshot, readEngineStatusSnapshotAsync, type EngineStatusRead } from '../src/workers/engine-split/snapshot.ts';
import { waitFor } from './helpers/test-clock.ts';
import { ownerLocalMint } from './helpers/owner-local-mint.ts';
import { CORPORA, FIXTURE_PLACEMENT, fixtureConnector, identityOf, openTierFixture } from './helpers/tier-fixtures.ts';

const TOKEN = 'control-plane-fixture-token-0123456789abcdef';
const CHILD = join(import.meta.dir, 'fixtures', 'engine-control-blocked-child.ts');

const roots: string[] = [];
const stops: Array<() => void> = [];
afterEach(() => {
  for (const stop of stops.splice(0)) stop();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function home(): { root: string; env: Record<string, string>; socketPath: string } {
  const root = mkdtempSync(join(tmpdir(), 'olympus-control-'));
  roots.push(root);
  const env = { HOME: root, XDG_DATA_HOME: join(root, '.local', 'share'), PATH: process.env.PATH ?? '' };
  mkdirSync(dirname(engineStatusSnapshotPath(env)), { recursive: true });
  return { root, env, socketPath: join(root, 'run', 'background.sock') };
}

const override = (note: string): EngineCommandEnvelope['command'] => ({
  kind: 'tier_override', request: { path: '/v1/cli/tier', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ note }) },
});

test('unchanged status stays fresh over several publishes without replacing or flushing the file', async () => {
  const { env, socketPath } = home();
  mkdirSync(dirname(socketPath), { recursive: true });
  const path = engineStatusSnapshotPath(env);
  const worker = new Worker(join(import.meta.dir, 'fixtures', 'engine-control-no-sync-worker.ts'));
  stops.push(() => worker.terminate());
  await new Promise<void>((resolve, reject) => {
    worker.addEventListener('message', () => resolve(), { once: true });
    worker.addEventListener('error', (error) => reject(error), { once: true });
  });
  const send = (message: ControlToThread) => worker.postMessage(message);
  const shared = new SharedArrayBuffer(CONTROL_INTS * 4 + CONTROL_MESSAGE_BYTES);
  const ints = new Int32Array(shared, 0, CONTROL_INTS);
  // No new collection or held-loop reading should change the payload in this test.
  send({ type: 'init', socketPath, authToken: TOKEN, instanceId: 'fixture', shared, tickMs: 60_000, publishMs: 75, model: false });
  await waitFor(() => Atomics.load(ints, CONTROL_BIND) === CONTROL_BIND_BOUND, { description: 'control socket bind' });
  const at = Date.now();
  const state = { scheduler: null, judge: { backlog: null, pending: 1, spending: null }, captures: null };
  send({ type: 'state', state, at, path });
  const first = await waitFor(() => readEngineStatusSnapshot(path));
  const original = readFileSync(path, 'utf8');
  const inode = statSync(path).ino;
  let last = Date.parse(first.snapshot.written_at);
  for (let period = 0; period < 3; period++) {
    const read = await waitFor(() => {
      const status = readEngineStatusSnapshot(path);
      return status && Date.parse(status.snapshot.written_at) > last ? status : undefined;
    });
    expect(read.stale).toBe(false);
    expect(read.snapshot.state_at).toBe(first.snapshot.state_at);
    expect(statSync(path).ino).toBe(inode);
    expect(readFileSync(path, 'utf8')).toBe(original);
    last = Date.parse(read.snapshot.written_at);
  }
  const asyncRead = await readEngineStatusSnapshotAsync(path);
  expect(Date.parse(asyncRead!.written_at)).toBeGreaterThan(Date.parse(first.snapshot.written_at));

  send({ type: 'state', state: { ...state, judge: { ...state.judge, pending: 2 } }, at, path });
  const changed = await waitFor(() => {
    const read = readEngineStatusSnapshot(path);
    return read?.snapshot.judge.pending === 2 ? read : undefined;
  });
  expect(statSync(path).ino).not.toBe(inode);
  worker.terminate();
  expect(readEngineStatusSnapshot(path, () => Date.parse(changed.snapshot.written_at) + ENGINE_STATUS_STALE_MS + 1_000)?.stale).toBe(true);
}, 30_000);

test('Make Private returns a receipt during a held background, protects one item, and reports settlement', async () => {
  const { root, env, socketPath } = home();
  const dbPath = join(root, 'held.sqlite');
  const lock = new Database(dbPath);
  stops.push(() => lock.close());
  lock.exec('PRAGMA journal_mode = WAL');
  lock.exec('CREATE TABLE held (at INTEGER)');
  const fixture = openTierFixture(root, { embed: false });
  const specs = [
    { id: 'raise', name: 'orchard raise', text: 'Ordinary orchard notes.' },
    { id: 'raise', conversation: 'another', name: 'orchard other', text: 'Other orchard notes.' },
    { id: 'lower', name: 'orchard lower', text: 'More orchard notes.' },
  ];
  const lowered = identityOf('lower');
  fixture.ledger.setOverride(lowered, { kind: 'tier', tier: 'secure' });
  await fixture.set.sync(fixtureConnector(() => specs), { fetchContent: true, placement: FIXTURE_PLACEMENT });
  const ledgerPath = fixture.ledger.dbPath;
  const storePaths = [fixture.paths.internal, fixture.paths.secure_local];
  fixture.close();

  const ledger = new TierLedger({ dbPath: ledgerPath, readOnly: true });
  const store = new LocalConnectorStore({ dbPath: storePaths[0]!, corpusId: CORPORA.internal, trustDomain: 'internal', family: 'file', tierLedger: ledger, readOnly: true });
  stops.push(() => { store.close(); ledger.close(); });
  const child = spawnProcess(process.execPath, [CHILD, socketPath, dbPath, root, ...storePaths], { env: { ...env, FIXTURE_TOKEN: TOKEN }, stdio: 'inherit' });
  stops.push(() => child.kill('SIGKILL'));
  const front = createEngineFront({ env, socketPath, authToken: TOKEN });
  stops.push(() => front.stop());
  const protection = createPendingItemProtection();
  const scopes = () => [{ ledger, corpusIds: new Set([CORPORA.internal]), stores: () => [store] }];
  const visibility = createTierVisibilityGate(scopes, undefined, protection);
  const release = createReleaseTierCheck(scopes, () => 'allow', {}, protection);
  const worker = createEmailSourceWorker({ connectorStores: [store], sourceIndexVisibilityGate: visibility });
  const routes = createEngineFrontRoutes({ client: front.client, pendingItemProtection: protection, gate: createFrontGate(), restartFront: () => {} });
  const serve = withWorkerBearerAuth(async request => (await routes(request)) ?? worker.fetch(request), { authToken: TOKEN });
  const origin = 'http://127.0.0.1:28190';
  const local = await ownerLocalMint(serve, origin, TOKEN);
  expect(local.status).toBe(200);
  const csrf = (await local.json() as { csrf_token: string }).csrf_token;
  const cookie = local.headers.get('Set-Cookie')!.split(';')[0]!;
  const post = (path: string, body: object, headers: Record<string, string> = {}) => serve(new Request(origin + path, {
    method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body),
  }));
  const dashboard = (action: string, body: object) => post('/dashboard/privacy/items/' + action, body, { Cookie: cookie, 'X-Olympus-CSRF': csrf });
  const search = async () => {
    const result = await post('/v1/source/index/search', { corpus_id: CORPORA.internal, query: 'orchard', all_tiers: false }, { Authorization: `Bearer ${TOKEN}` });
    expect(result.status).toBe(200);
    return (await result.json() as { hits: Array<{ sourceItem: { providerItemId: string; providerConversationId?: string } }> }).hits
      .map(hit => hit.sourceItem.providerConversationId ?? hit.sourceItem.providerItemId).sort();
  };
  const raised = identityOf('raise');
  const missing = { ...raised, providerItemId: 'missing' };
  const input = { ...raised, corpusId: CORPORA.internal, privateAtAnswer: false, layer: 'names' as const };
  const answer = [{ inputs: [input], constraints: { secureDerivativeDefault: 'allow' as const, includeSecureLocalContent: false } }];
  const lowerInput = { ...input, ...lowered };
  const begin = async (identity: Parameters<typeof ownerTierItemId>[0], tier: string) => {
    const start = performance.now();
    const response = await dashboard('set', { item_id: ownerTierItemId(identity), tier });
    expect(response.status).toBe(202);
    const receipt = await response.json() as { request_id: string; state: string };
    expect(receipt.state).toBe('pending');
    expect(performance.now() - start).toBeLessThan(1_000);
    return receipt.request_id;
  };
  const poll = async (request_id: string) => (await dashboard('status', { request_id })).json() as Promise<Record<string, unknown>>;

  await waitFor(() => readEngineStatusSnapshot(engineStatusSnapshotPath(env)), { timeoutMs: 30_000 });
  expect(await search()).toEqual(['another', 'raise']);
  expect(await answerReleaseWithheldReasonOffThread(answer, release)).toBeUndefined();
  lock.exec('BEGIN IMMEDIATE');
  writeFileSync(join(root, 'block'), '');
  await waitFor(() => (front.status()?.snapshot.loop_held_ms ?? 0) > 1_000, { timeoutMs: 30_000 });

  const raiseId = await begin(raised, 'private');
  const refusalId = await begin(missing, 'private');
  const lowerId = await begin(lowered, 'personal');
  expect(new Set([raiseId, refusalId, lowerId]).size).toBe(3);
  expect(protection.has(raised)).toBe(true);
  expect(protection.has(missing)).toBe(true);
  expect(protection.has(lowered)).toBe(false);
  expect(await poll(raiseId)).toMatchObject({ state: 'pending', request_id: raiseId });
  expect((await post('/dashboard/privacy/items/status', { request_id: raiseId }, { Authorization: `Bearer ${TOKEN}` })).status).toBe(403);
  expect(await search()).toEqual(['another']);
  expect(await release.inputsOffThread!([lowerInput])).toMatchObject([{ tier: 'private' }]);
  expect(await answerReleaseWithheldReasonOffThread(answer, release)).toBeDefined();
  expect(existsSync(join(root, 'released'))).toBe(false);

  lock.exec('COMMIT');
  const settled = (id: string) => waitFor(async () => {
    const result = await poll(id);
    return result.state === 'pending' ? undefined : result;
  }, { timeoutMs: 30_000 });
  expect(await settled(raiseId)).toMatchObject({ ok: true, changed: 'set' });
  expect(await settled(refusalId)).toMatchObject({ ok: false, code: 'not_found', message: 'Olympus no longer holds that item.' });
  expect(await settled(lowerId)).toMatchObject({ ok: true, changed: 'set' });
  expect(protection.has(raised)).toBe(false);
  expect(protection.has(missing)).toBe(false);
  expect(await search()).toEqual(['another']);
  expect(await answerReleaseWithheldReasonOffThread(answer, release)).toBeDefined();
}, 60_000);

describe('the background loop held in synchronous SQLite for 60 s', () => {
  test('commands are acknowledged within 1 s, status keeps publishing with its age, and the front waits on the loop for neither', async () => {
    const { root, env, socketPath } = home();
    const dbPath = join(root, 'held.sqlite');
    const lock = new Database(dbPath);
    lock.exec('PRAGMA journal_mode = WAL');
    lock.exec('CREATE TABLE held (at INTEGER)');
    const child = spawnProcess(process.execPath, [CHILD, socketPath, dbPath, root], { env: { ...env, FIXTURE_TOKEN: TOKEN }, stdio: 'inherit' });
    stops.push(() => { child.kill('SIGKILL'); lock.close(); });
    const front = createEngineFront({ env, socketPath, authToken: TOKEN });
    stops.push(() => front.stop());
    const statusPath = engineStatusSnapshotPath(env);
    const appliedNotes = () => (existsSync(join(root, 'applied')) ? readFileSync(join(root, 'applied'), 'utf8').trim().split('\n').map((line) => (JSON.parse(line) as { note: string }).note) : []);
    /** One acknowledgement, and how long the front waited for it. */
    const acknowledge = async (note: string) => {
      const started = performance.now();
      const receipt = await front.client.post(override(note), { timeoutMs: 5_000 });
      return { receipt, waitedMs: performance.now() - started };
    };

    await waitFor(() => existsSync(join(root, 'ready')), { timeoutMs: 30_000, intervalMs: 50 });
    expect(readFileSync(join(root, 'ready'), 'utf8')).toBe('control-thread');
    // With the loop turning, a command goes through as it always did.
    expect(await front.client.send(override('before'), { timeoutMs: 30_000 })).toMatchObject({ state: 'done', result: { status: 200 } });
    const before = await waitFor(() => readEngineStatusSnapshot(statusPath), { timeoutMs: 10_000, intervalMs: 50 });
    expect(before.snapshot.loop_held_ms).toBeLessThan(1_000);

    // The hold: this process takes the write lock, and the background's loop waits for it inside SQLite.
    lock.exec('BEGIN IMMEDIATE');
    writeFileSync(join(root, 'block'), '');
    const held = await waitFor(() => {
      const read = readEngineStatusSnapshot(statusPath);
      return read && (read.snapshot.loop_held_ms ?? 0) > 1_500 ? read : undefined;
    }, { timeoutMs: 30_000, intervalMs: 100 });
    const stateAtHold = held.snapshot.state_at!;

    // (a) early in the hold: acknowledged at once as received, with how long the loop has been held.
    const early = await acknowledge('early');
    expect(early.waitedMs).toBeLessThan(1_000);
    expect(early.receipt.state).toBe('received');
    expect(early.receipt.loop_held_ms).toBeGreaterThan(1_000);
    // A command the front waits out stays in progress: answered, never "unavailable".
    let waitedOut: Awaited<ReturnType<typeof front.client.send>> | undefined;
    const waiting = front.client.send(override('waited-out'), { timeoutMs: 15_000 }).then((receipt) => { waitedOut = receipt; return receipt; });

    // (b) through the hold: the snapshot is written every few seconds, the
    // loop's state stays the one from before the hold, and its age grows.
    let worstWriteAgeMs = 0;
    let worstReadMs = 0;
    const late = await waitFor(() => {
      const started = performance.now();
      const read = front.status();
      worstReadMs = Math.max(worstReadMs, performance.now() - started);
      if (!read) return undefined;
      worstWriteAgeMs = Math.max(worstWriteAgeMs, read.age_ms);
      expect(read.stale).toBe(false);
      expect(read.snapshot.state_at).toBe(stateAtHold);
      return (read.snapshot.loop_held_ms ?? 0) >= 60_000 ? read : undefined;
    }, { timeoutMs: 90_000, intervalMs: 250 });
    expect(late.state_age_ms!).toBeGreaterThanOrEqual(60_000);
    expect(worstWriteAgeMs).toBeLessThan(10_000);
    // (c) the front's status read never touched the held loop: it is a file read.
    expect(worstReadMs).toBeLessThan(1_000);
    expect(existsSync(join(root, 'released'))).toBe(false);
    expect(waitedOut).toBeUndefined();
    expect(appliedNotes()).toEqual(['before']);

    // (a) and (c) again, 60 s into the hold.
    const lateAck = await acknowledge('late');
    expect(lateAck.waitedMs).toBeLessThan(1_000);
    expect(lateAck.receipt.state).toBe('received');
    expect(lateAck.receipt.loop_held_ms).toBeGreaterThanOrEqual(60_000);
    // The same id again is answered from the record, as fast, and not taken twice.
    const again = await front.client.post(override('late'), { id: lateAck.receipt.id, timeoutMs: 5_000 });
    expect(again).toMatchObject({ id: lateAck.receipt.id, state: 'received' });

    // The loop turns again: every accepted command is applied once, in order, and the status is of now.
    lock.exec('COMMIT');
    expect(await waiting).toMatchObject({ state: 'done', result: { status: 200 } });
    await waitFor(() => appliedNotes().length === 4, { timeoutMs: 30_000, intervalMs: 50 });
    expect(appliedNotes()).toEqual(['before', 'early', 'waited-out', 'late']);
    const after = await waitFor(() => {
      const read = readEngineStatusSnapshot(statusPath);
      return read && read.snapshot.state_at !== stateAtHold && (read.snapshot.loop_held_ms ?? 0) < 1_000 ? read : undefined;
    }, { timeoutMs: 30_000, intervalMs: 100 });
    expect(after.state_age_ms!).toBeLessThan(10_000);
    expect(existsSync(join(root, 'released'))).toBe(true);
  }, 240_000);
});

describe('the control thread and the engine loop', () => {
  /** A forwarded owner action's handler: answers with the body it was sent. */
  const echo = (seen: (body: string) => void = () => {}) => ({
    tier_override: ({ request }: { request: EngineForwardedRequest }): EngineForwardedResponse => { seen(request.body); return { status: 200, headers: {}, body: request.body }; },
  });

  test('a background serves from the control thread; stopped, its socket is free for the next one', async () => {
    const { env, socketPath } = home();
    const applied: string[] = [];
    const start = (instanceId: string) => startEngineBackgroundServer({
      socketPath, authToken: TOKEN, instanceId,
      handlers: echo((body) => applied.push(`${instanceId}:${body}`)),
    });
    const first = start('first');
    stops.push(() => first.stop());
    expect(first.servedBy()).toBe('control-thread');
    first.markReady();
    const status = startEngineBackgroundStatus({ env, instanceId: 'first', collect: () => ({ scheduler: null, judge: { backlog: null, pending: 7, spending: null }, captures: null }) });
    stops.push(() => status.stop());
    const client = new EngineCommandClient({ fetch: createUnixSocketFetch(socketPath), authToken: TOKEN });
    expect(await client.send(override('one'), { timeoutMs: 20_000 })).toMatchObject({ state: 'done', instance_id: 'first' });
    const read = await waitFor(() => readEngineStatusSnapshot(engineStatusSnapshotPath(env)), { timeoutMs: 10_000, intervalMs: 50 });
    expect(read.snapshot).toMatchObject({ instance_id: 'first', judge: { pending: 7 }, control_plane: 'thread' });
    expect(typeof read.snapshot.state_at).toBe('string');
    status.stop();
    first.stop();
    const second = start('second');
    stops.push(() => second.stop());
    second.markReady();
    expect(await client.send(override('two'), { timeoutMs: 20_000 })).toMatchObject({ state: 'done', instance_id: 'second' });
    expect(applied).toEqual([`first:${JSON.stringify({ note: 'one' })}`, `second:${JSON.stringify({ note: 'two' })}`]);
  }, 60_000);

  test('the control thread ends: the loop takes the socket over, with every command the ledger holds', async () => {
    const { env, socketPath } = home();
    const lines: string[] = [];
    let thread: Worker | undefined;
    const background = startEngineBackgroundServer({
      socketPath, authToken: TOKEN, instanceId: 'takeover', log: (line) => lines.push(line),
      createControlWorker: (path) => { thread = new Worker(path); return thread; },
      handlers: echo(),
    });
    stops.push(() => background.stop());
    background.markReady();
    const status = startEngineBackgroundStatus({ env, instanceId: 'takeover', collect: () => ({ scheduler: null, judge: { backlog: null, pending: 1, spending: null }, captures: null }) });
    stops.push(() => status.stop());
    const client = new EngineCommandClient({ fetch: createUnixSocketFetch(socketPath), authToken: TOKEN });
    const done = await client.send(override('kept'), { timeoutMs: 20_000 });
    expect(done.state).toBe('done');
    thread!.terminate();
    await waitFor(() => background.servedBy() === 'loop', { timeoutMs: 20_000, intervalMs: 20 });
    expect(lines.join('\n')).toContain('the control thread ended');
    // The record from before is still answered, and a new command is applied.
    expect(await client.send(override('kept'), { id: done.id, timeoutMs: 20_000 })).toMatchObject({ id: done.id, state: 'done' });
    expect(await client.send(override('after'), { timeoutMs: 20_000 })).toMatchObject({ state: 'done', result: { body: JSON.stringify({ note: 'after' }) } });
    // And the loop writes the snapshot itself: no state_at, as before the thread existed.
    rmSync(engineStatusSnapshotPath(env), { force: true });
    status.publish();
    expect(readEngineStatusSnapshot(engineStatusSnapshotPath(env))?.snapshot.state_at).toBeUndefined();
    // Health reads this to say the engine runs without its control thread.
    await waitFor(() => readEngineStatusSnapshot(engineStatusSnapshotPath(env))?.snapshot.control_plane === 'loop', { timeoutMs: 10_000, intervalMs: 50 });
  }, 60_000);

  test('a collect that throws does not lose the snapshot: the thread publishes what it has and says the state could not be collected', async () => {
    const { env, socketPath } = home();
    const background = startEngineBackgroundServer({ socketPath, authToken: TOKEN, instanceId: 'collect', handlers: {} });
    stops.push(() => background.stop());
    let fail = true;
    const status = startEngineBackgroundStatus({
      env, instanceId: 'collect',
      collect: () => {
        if (fail) throw new RangeError('fixture collect failure');
        return { scheduler: null, judge: { backlog: null, pending: 3, spending: null }, captures: null };
      },
    });
    stops.push(() => status.stop());
    const path = engineStatusSnapshotPath(env);
    // Never collected: an empty state, published, with the failure in it.
    const first = await waitFor(() => readEngineStatusSnapshot(path), { timeoutMs: 10_000, intervalMs: 50 });
    expect(first.snapshot).toMatchObject({ instance_id: 'collect', judge: { pending: null }, state_error: { attempts: 1, error: 'RangeError: fixture collect failure' } });
    expect(first.snapshot.state_at).toBeUndefined();
    // Collected: the state, and no failure.
    fail = false;
    status.publish();
    const good = await waitFor(() => { const read = readEngineStatusSnapshot(path); return read?.snapshot.judge.pending === 3 ? read : undefined; }, { timeoutMs: 10_000, intervalMs: 50 });
    expect(good.snapshot.state_error).toBeUndefined();
    // Failing again: the last state stays, with its time, and the failure beside it.
    fail = true;
    status.publish();
    const kept = await waitFor(() => { const read = readEngineStatusSnapshot(path); return read?.snapshot.state_error ? read : undefined; }, { timeoutMs: 10_000, intervalMs: 50 });
    expect(kept.snapshot).toMatchObject({ judge: { pending: 3 }, state_at: good.snapshot.state_at, state_error: { attempts: 1 } });
  }, 30_000);

  test('no thread to use: the loop serves, and says so', async () => {
    const { socketPath } = home();
    const lines: string[] = [];
    const background = startEngineBackgroundServer({
      socketPath, authToken: TOKEN, log: (line) => lines.push(line),
      createControlWorker: () => { throw new Error('no threads here'); },
      handlers: echo(),
    });
    stops.push(() => background.stop());
    background.markReady();
    expect(background.servedBy()).toBe('loop');
    expect(lines.join('\n')).toContain('could not be started: no threads here');
    const client = new EngineCommandClient({ fetch: createUnixSocketFetch(socketPath), authToken: TOKEN });
    expect((await client.send(override('loop'), { timeoutMs: 20_000 })).state).toBe('done');
  }, 30_000);
});

describe('the control thread\'s record of commands', () => {
  const envelope = (id: string, note: string): EngineCommandEnvelope => ({ id, command: override(note) });

  test('received at once with how long the loop is held; the loop\'s word settles it', async () => {
    const sent: EngineCommandEnvelope[] = [];
    const mirror = new EngineCommandMirror({ instanceId: 'bg', send: (item) => sent.push(item), loopHeldMs: () => 4_200.4 });
    expect(mirror.submit(envelope('command-0001', 'a'))).toEqual({ id: 'command-0001', state: 'received', instance_id: 'bg', loop_held_ms: 4_200 });
    expect(sent).toHaveLength(1);
    // The same id again is the same record, handed over once; another command under it is refused.
    expect(mirror.submit(envelope('command-0001', 'a')).state).toBe('received');
    expect(sent).toHaveLength(1);
    expect(() => mirror.submit(envelope('command-0001', 'b'))).toThrow(EngineCommandError);
    const settled = mirror.settled('command-0001', new Promise(() => {}));
    mirror.apply([{ id: 'command-0001', state: 'done', instance_id: 'bg', result: { ok: true } }]);
    expect(await settled).toEqual({ id: 'command-0001', state: 'done', instance_id: 'bg', result: { ok: true } });
    expect(mirror.get('command-0001')).toEqual({ id: 'command-0001', state: 'done', instance_id: 'bg', result: { ok: true } });
    expect(mirror.unsettled()).toEqual([]);
    expect(mirror.get('command-9999')).toBeUndefined();
  });

  test('a command the loop never heard of is handed over again; a settled one is not', () => {
    const sent: string[] = [];
    const mirror = new EngineCommandMirror({ instanceId: 'bg', send: (item) => sent.push(item.id) });
    mirror.submit(envelope('command-0001', 'a'));
    mirror.submit(envelope('command-0002', 'b'));
    expect(mirror.unsettled()).toEqual(['command-0001', 'command-0002']);
    mirror.apply([{ id: 'command-0001', state: 'failed', instance_id: 'bg', error: 'no' }], ['command-0001', 'command-0002']);
    expect(sent).toEqual(['command-0001', 'command-0002', 'command-0002']);
    expect(mirror.get('command-0001')).toMatchObject({ state: 'failed', error: 'no' });
    expect(mirror.unsettled()).toEqual(['command-0002']);
  });
});

describe('what the front says of a busy background', () => {
  test('an owner action the background received and has not finished is counted until its result arrives; the engine\'s own traffic is not', async () => {
    let now = 1_000;
    let waits = 0;
    // The result wait is held open until the test lets the background finish.
    let finish!: () => void;
    let finished = new Promise<void>((resolve) => { finish = resolve; });
    const client = new EngineCommandClient({
      authToken: TOKEN, now: () => now, sleep: async () => undefined, newId: () => 'command-0001',
      fetch: (async (url: unknown, init: RequestInit) => {
        if (init.method === 'POST') return Response.json({ id: (JSON.parse(init.body as string) as { id: string }).id, state: 'received', instance_id: 'fixture' }, { status: 202 });
        waits += 1;
        await finished;
        return Response.json({ id: String(url).split('/').pop()!.split('?')[0]!, state: 'done', instance_id: 'fixture' }, { status: 200 });
      }) as typeof fetch,
    });
    expect(client.applying()).toEqual({ count: 0, oldestMs: 0 });
    const sent = client.send({ kind: 'capture_stop', source: 'telegram' }, { timeoutMs: 60_000 });
    await waitFor(() => client.applying().count === 1, { timeoutMs: 5_000, intervalMs: 5 });
    now += 4_000;
    expect(client.applying()).toEqual({ count: 1, oldestMs: 4_000 });
    finish();
    expect((await sent).state).toBe('done');
    expect(client.applying()).toEqual({ count: 0, oldestMs: 0 });

    finished = new Promise<void>((resolve) => { finish = resolve; });
    const traffic = client.send({ kind: 'archive_changed' }, { id: 'command-0002', timeoutMs: 60_000 });
    await waitFor(() => waits === 2, { timeoutMs: 5_000, intervalMs: 5 });
    expect(client.applying().count).toBe(0);
    finish();
    expect((await traffic).state).toBe('done');
  });

  test('nothing to say while the state is fresh and nothing waits; the age from ten seconds, a waiting change from three', () => {
    let read: EngineStatusRead | undefined = { snapshot: { v: 1, written_at: '2026-11-16T12:00:00.000Z', pid: 1, instance_id: 'fixture', scheduler: null, judge: { backlog: null, pending: 0, spending: null }, captures: null } as unknown as EngineStatusRead['snapshot'], age_ms: 1_000, stale: false, state_age_ms: 4_000 };
    let held = { count: 0, oldestMs: 0 };
    const say = frontEngineState(() => read, { applying: () => held });
    expect(say()).toBeUndefined();
    read = { ...read, state_age_ms: 45_400 };
    expect(say()).toEqual({ state_age_seconds: 45 });
    held = { count: 2, oldestMs: 2_000 };
    expect(say()).toEqual({ state_age_seconds: 45 });
    held = { count: 2, oldestMs: 3_000 };
    expect(say()).toEqual({ state_age_seconds: 45, applying: 2 });
    // A background that stopped publishing is not "busy": the front shows nothing from it.
    read = { ...read, stale: true };
    expect(say()).toEqual({ applying: 2 });
    read = undefined;
    held = { count: 0, oldestMs: 0 };
    expect(say()).toBeUndefined();
  });
});
