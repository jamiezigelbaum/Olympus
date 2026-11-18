import { Database } from 'bun:sqlite';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createUnixSocketFetch } from '../../src/core/worker-transport.ts';
import { TierLedger } from '../../src/workers/classification/tier-ledger.ts';
import { ownerTierItemId } from '../../src/workers/classification/tier-owner-items.ts';
import { DEFAULT_WORKER_BIND_HOST } from '../../src/workers/http.ts';
import { ownerLocalMint } from './owner-local-mint.ts';
import { waitFor } from './test-clock.ts';
import { CORPORA, FIXTURE_PLACEMENT, fixtureConnector, identityOf, openTierFixture } from './tier-fixtures.ts';

type Choice = 'private' | 'personal';
const backgroundScript = join(import.meta.dir, '../fixtures/engine-control-blocked-child.ts');
const frontScript = join(import.meta.dir, '../fixtures/engine-privacy-front-child.ts');
const identity = identityOf('restart-item');
const itemId = ownerTierItemId(identity);
const privacyPath = '/dashboard/privacy/items/';

export async function privacyRestartFixture(choice: Choice, options: { waitForVisibility?: boolean } = {}) {
  const root = mkdtempSync('/tmp/olympus-privacy-restart-');
  const env = {
    HOME: root, XDG_DATA_HOME: root, PATH: process.env.PATH ?? '',
    FIXTURE_TOKEN: randomUUID(), FIXTURE_SESSION_SECRET: randomUUID(),
    ...(options.waitForVisibility ? { FIXTURE_WAIT_FOR_VISIBILITY: '1' } : {}),
  };
  const backgroundSocket = join(root, 'bg.sock');
  const frontSocket = join(root, 'front.sock');
  const fetchFront = createUnixSocketFetch(frontSocket);
  const origin = `http://${DEFAULT_WORKER_BIND_HOST}:8010`;
  const lockPath = join(root, 'held.sqlite');
  const lock = new Database(lockPath);
  lock.exec('CREATE TABLE held (at INTEGER)');
  let locked = false;
  type Role = 'background' | 'front';
  const child: Partial<Record<Role, ReturnType<typeof Bun.spawn>>> = {};
  let reader: TierLedger | undefined;
  const stop = async (role: Role) => {
    const instance = child[role];
    if (!instance) return;
    instance.kill('SIGKILL');
    await instance.exited;
    delete child[role];
  };
  const close = async () => {
    await stop('front');
    await stop('background');
    reader?.close();
    lock.close();
    rmSync(root, { recursive: true, force: true });
  };
  const spawn = (role: Role, args: string[]) => {
    child[role] = Bun.spawn([process.execPath, ...args], { env, stdout: 'ignore', stderr: 'inherit' });
  };
  const waitForMarker = async (role: Role, ...markers: string[]) => {
    const instance = child[role]!;
    const seen = await waitFor(() => instance.exitCode !== null ? 'exited' : markers.find(marker => existsSync(join(root, marker))),
      { description: `${role} ${markers.join(' or ')}` });
    if (seen === 'exited') throw new Error(`Privacy fixture ${role} exited (${instance.exitCode})`);
    return seen;
  };
  const clear = (names: readonly string[]) => {
    for (const name of names) rmSync(join(root, name), { force: true });
  };
  try {
    const before = choice === 'private' ? 'private' : 'secure';
    const after = choice === 'private' ? 'secure' : 'private';
    const seed = openTierFixture(root, { embed: false });
    try {
      seed.ledger.setOverride(identity, { kind: 'tier', tier: before });
      await seed.set.sync(fixtureConnector(() => [{ id: identity.providerItemId, name: 'Orchard', text: 'Synthetic orchard notes.' }]), {
        fetchContent: true, placement: FIXTURE_PLACEMENT,
      });
    } finally {
      seed.close();
    }
    const ledger = new TierLedger({ dbPath: seed.ledger.dbPath, readOnly: true });
    reader = ledger;
    const readStored = () => {
      const override = ledger.getOverride(identity);
      return { overrideTier: override?.kind === 'tier' ? override.tier : undefined, contentTier: ledger.getCurrent(identity)?.contentTier };
    };
    const storePaths = [seed.paths.internal, seed.paths.secure_local];
    const startBackground = async () => {
      clear(['ready', 'block', 'blocking', 'released']);
      spawn('background', [backgroundScript, backgroundSocket, lockPath, root, ...storePaths]);
      await waitForMarker('background', 'ready');
    };
    const startFront = async () => {
      clear(['front.sock', 'front-listening', 'front-ready', 'front-private-held']);
      spawn('front', [frontScript, root, frontSocket, backgroundSocket, ledger.dbPath, ...storePaths]);
      await waitForMarker('front', 'front-listening');
    };
    const pauseBeforeCommit = async () => {
      lock.exec('BEGIN IMMEDIATE');
      locked = true;
      writeFileSync(join(root, 'block'), '');
      await waitForMarker('background', 'blocking');
    };
    const allowCommit = () => {
      if (locked) lock.exec('COMMIT');
      locked = false;
    };
    if (options.waitForVisibility) {
      await startFront();
      await startBackground();
    } else {
      await startBackground();
      await startFront();
    }
    await waitForMarker('front', 'front-ready');
    const local = await ownerLocalMint(fetchFront, origin, env.FIXTURE_TOKEN);
    const { csrf_token: csrf } = await local.json() as { csrf_token: string };
    const cookie = local.headers.get('Set-Cookie')?.split(';')[0];
    if (local.status !== 200 || !cookie || !csrf) throw new Error(`Privacy fixture local session failed (HTTP ${local.status})`);
    const post = (path: string, body: object, headers: Record<string, string>) => fetchFront(origin + path, {
      method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body),
    });
    const bearer = { Authorization: `Bearer ${env.FIXTURE_TOKEN}` };
    const dashboard = (path: string, body: object) => post(path, body, { Cookie: cookie, 'X-Olympus-CSRF': csrf });
    return {
      itemId, before, after, readStored, pauseBeforeCommit, allowCommit, dashboard, close,
      visibilityWaiting: () => !existsSync(join(root, 'visibility-building'))
        && readFileSync(join(root, 'visibility-step'), 'utf8').startsWith('waiting for the front'),
      async search() {
        const response = await post('/v1/source/index/search', { corpus_id: CORPORA.internal, query: 'orchard', all_tiers: false }, bearer);
        const result = await response.json() as { hits?: Array<{ sourceItem: { providerItemId: string } }> };
        return { status: response.status, released: result.hits?.some(hit => hit.sourceItem.providerItemId === identity.providerItemId) === true };
      },
      async answerRelease() {
        const response = await post('/fixture/answer-release', {}, bearer);
        const result = await response.json() as { released?: boolean };
        return { status: response.status, released: result.released === true };
      },
      async restartFront() { await stop('front'); await startFront(); },
      async restartBackground(whileStopped: () => Promise<void>) {
        await stop('background');
        await whileStopped();
        allowCommit();
        await startBackground();
      },
      waitForFrontReady: () => waitForMarker('front', 'front-ready'),
      frontWaitingForPrivacyRaise: async () => await waitForMarker('front', 'front-private-held', 'front-ready') === 'front-private-held',
      set: () => dashboard(privacyPath + 'set', { item_id: itemId, tier: choice }),
      status: (requestId: string) => dashboard(privacyPath + 'status', { request_id: requestId }),
      find: () => dashboard(privacyPath + 'find', { recent: true }),
    } as const;
  } catch (error) {
    await close();
    throw error;
  }
}
