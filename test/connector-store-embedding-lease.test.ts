import { afterEach, describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { FileLeaseBusyError, type FileLeaseTimers } from '../src/core/file-lease.ts';
import {
  CONNECTOR_STORE_EMBEDDING_LEASE_SUFFIX,
  CONNECTOR_STORE_EMBEDDING_LEASE_WAIT_MS,
  LocalConnectorStore,
} from '../src/workers/connector-store/local-index.ts';
import { createTestClock, waitFor, type TestTimer } from './helpers/test-clock.ts';
import { fixtureConnector, FIXTURE_PLACEMENT, localProvider, tempDir } from './helpers/tier-fixtures.ts';

const cleanups: Array<() => void> = [];
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); });

async function fixture() {
  const { dir, cleanup } = tempDir('olympus-embedding-lease-');
  cleanups.push(cleanup);
  const clock = createTestClock();
  const heartbeats: TestTimer[] = [];
  const timers: FileLeaseTimers = {
    now: clock.now,
    sleep: clock.sleep,
    setInterval: (callback, ms) => {
      const timer = clock.setInterval(callback, ms);
      heartbeats.push(timer);
      return timer;
    },
    clearInterval: (timer) => clock.clearInterval(timer as TestTimer),
  };
  const store = new LocalConnectorStore({
    dbPath: join(dir, 'store.sqlite'),
    corpusId: 'secure_local.fixture.files',
    family: 'file',
    trustDomain: 'secure_local',
    tierLedger: null,
    embeddingLeaseTimers: timers,
  });
  cleanups.push(() => store.close());
  await store.syncFromConnector(fixtureConnector(() => [{
    id: 'note', name: 'note.txt', text: 'A note about the orchard.', legacyDomain: 'secure_local',
  }]), { fetchContent: true, placement: FIXTURE_PLACEMENT });
  const provider = localProvider();
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  let calls = 0;
  const embed = provider.embed.bind(provider);
  provider.embed = async (inputs) => { calls += 1; await held; return embed(inputs); };
  return { store, provider, clock, heartbeats, release, calls: () => calls };
}

describe('embedding lease waits for holder heartbeats, not total time', () => {
  test('a renewing holder is waited out beyond 120 s, then its vectors are reused', async () => {
    const f = await fixture();
    const holder = f.store.embedChunks({ provider: f.provider });
    await waitFor(() => f.calls() === 1);
    let settled = false;
    const contender = f.store.embedChunks({ provider: f.provider }).finally(() => { settled = true; });
    void contender.catch(() => {});
    try {
      await waitFor(() => f.clock.pendingTimers() === 2);
      await f.clock.advance(CONNECTOR_STORE_EMBEDDING_LEASE_WAIT_MS * 3);
      expect(settled).toBe(false);
      expect(f.calls()).toBe(1);
    } finally {
      f.release();
      await holder;
      await f.clock.advance(25);
    }
    expect((await contender).chunksEmbedded).toBe(0);
    expect(f.calls()).toBe(1);
    expect(f.clock.pendingTimers()).toBe(0);
  });

  test('120 s without renewal returns busy for a live holder and preserves its fence', async () => {
    const f = await fixture();
    const holder = f.store.embedChunks({ provider: f.provider });
    await waitFor(() => f.calls() === 1);
    // Model a holder whose event loop no longer publishes heartbeats.
    f.clock.clearInterval(f.heartbeats[0]);
    let outcome: unknown;
    const contender = f.store.embedChunks({ provider: f.provider }).catch((error: unknown) => { outcome = error; });
    try {
      await waitFor(() => f.clock.pendingTimers() === 1);
      await f.clock.advance(CONNECTOR_STORE_EMBEDDING_LEASE_WAIT_MS - 25);
      expect(outcome).toBeUndefined();
      await f.clock.advance(25);
      await contender;
      expect(outcome).toBeInstanceOf(FileLeaseBusyError);
      expect(f.calls()).toBe(1);
    } finally {
      f.release();
      await holder;
    }
    expect((await f.store.embedChunks({ provider: f.provider })).chunksEmbedded).toBe(0);
    expect(f.clock.pendingTimers()).toBe(0);
  });

  test('a dead holder stops renewing and the contender takes over immediately', async () => {
    const f = await fixture();
    const leaseTarget = `${f.store.dbPath}${CONNECTOR_STORE_EMBEDDING_LEASE_SUFFIX}`;
    const modulePath = join(import.meta.dir, '..', 'src', 'core', 'file-lease.ts');
    const child = Bun.spawn([process.execPath, '--eval', `
      import { withFileLease } from ${JSON.stringify(modulePath)};
      await withFileLease(${JSON.stringify(leaseTarget)}, async () => {
        console.log('held');
        await new Promise(() => {});
      }, { heartbeat: { stallMs: ${CONNECTOR_STORE_EMBEDDING_LEASE_WAIT_MS}, intervalMs: 30000 } });
    `], { stdout: 'pipe', stderr: 'pipe' });
    let output = '';
    const reading = (async () => {
      for await (const bytes of child.stdout) output += new TextDecoder().decode(bytes);
    })();
    let contender: ReturnType<LocalConnectorStore['embedChunks']> | undefined;
    try {
      await waitFor(() => output.includes('held'), { description: 'child holds the embedding lease' });
      contender = f.store.embedChunks({ provider: f.provider });
      void contender.catch(() => {});
      await waitFor(() => f.clock.pendingTimers() === 1);
      await f.clock.advance(CONNECTOR_STORE_EMBEDDING_LEASE_WAIT_MS - 25);
      expect(f.calls()).toBe(0);
      child.kill('SIGKILL');
      await child.exited;
      // The OS releases ownership at death; no stale-expiry grace is needed.
      f.release();
      await f.clock.advance(25);
      expect((await contender).chunksEmbedded).toBe(1);
      expect(f.clock.pendingTimers()).toBe(0);
    } finally {
      if (child.exitCode === null) child.kill('SIGKILL');
      await child.exited;
      await reading;
      f.release();
      await f.clock.advance(25);
      await contender;
    }
  }, 20_000);
});
