// The boot migration in a real worker (docs/design/source-storage.md, delivery
// step 4c): the worker is started on an isolated home that holds a source the
// way a build from before the folders left it, once with the switch off and
// once with it on. Off, nothing moves. On, the files are renamed into the
// account's folder before the worker listens, and every later boot, switch or
// no switch, opens the stores there and makes no empty ones at the old places.
// Spawning tests carry an explicit timeout (test/spawn-timeout-guard.test.ts).

import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { publishLinuxEngineReceipt, resolveLinuxEngineLayout } from '../src/core/linux-engine-layout.ts';
import { accountFolder, legacyAccountFiles, olympusDataRoot } from '../src/core/olympus-layout.ts';
import { MIGRATE_ACCOUNT_FOLDERS_ENV } from '../src/core/source-account-migration.ts';
import { LocalConnectorStore } from '../src/workers/connector-store/index.ts';
import { FIXTURE_PLACEMENT, fixtureConnector, snapshotStore, type FixtureSpec } from './helpers/tier-fixtures.ts';

const SERVER = join(import.meta.dir, '..', 'src', 'workers', 'email-source', 'server.ts');
const REPO = join(import.meta.dir, '..');

const roots: string[] = [];
const children: Array<ReturnType<typeof Bun.spawn>> = [];
afterEach(() => {
  for (const child of children.splice(0)) child.kill('SIGKILL');
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

type Env = Record<string, string>;

function freshHome(): Env {
  const home = mkdtempSync(join(tmpdir(), 'olympus-migration-worker-'));
  roots.push(home);
  // On Linux the worker listens on a Unix socket under the user session's runtime
  // directory and exits at once when that directory is missing or not private.
  mkdirSync(join(home, 'run'), { mode: 0o700 });
  return {
    HOME: home,
    XDG_DATA_HOME: join(home, '.local', 'share'),
    XDG_STATE_HOME: join(home, '.local', 'state'),
    XDG_CONFIG_HOME: join(home, '.config'),
    XDG_RUNTIME_DIR: join(home, 'run'),
  };
}

const SPECS: FixtureSpec[] = [
  { id: 'plan', name: 'orchard-plan.txt', text: 'Orchard pruning plan for the apple trees this winter.' },
  { id: 'lab', name: 'orchard-lab.txt', text: 'Orchard lab panel notes kept in the private store.', legacyDomain: 'secure_local' },
];

/** Dropbox as a build from before the folders left it: two tier stores with content, at the old places. */
async function seedLegacyDropbox(env: Env): Promise<Record<'internal' | 'secure_local', string>> {
  const files = legacyAccountFiles('dropbox.files', env, []);
  const at = (tier: string): string => files.find((file) => file.area === 'store' && file.name === tier)!.legacy;
  const paths = { internal: at('internal'), secure_local: at('secure_local') };
  mkdirSync(join(paths.internal, '..'), { recursive: true });
  for (const tier of ['internal', 'secure_local'] as const) {
    const store = new LocalConnectorStore({ dbPath: paths[tier], corpusId: `${tier}.dropbox.files`, family: 'file', trustDomain: tier });
    try {
      await store.syncFromConnector(fixtureConnector(() => SPECS), { fetchContent: true, placement: FIXTURE_PLACEMENT });
    } finally {
      store.close();
    }
  }
  return paths;
}

interface Booted {
  output: () => string;
  errors: () => string;
  exitCode: () => number | null;
  stop: () => Promise<void>;
}

/** Starts the real worker on `env` and waits until it listens (or says why it will not). */
async function boot(env: Env, extra: Env = {}): Promise<Booted> {
  // A worker that was killed leaves its socket behind, and the next one will not take over a path that is occupied.
  for (const name of readdirSync(env.XDG_RUNTIME_DIR!)) rmSync(join(env.XDG_RUNTIME_DIR!, name), { recursive: true, force: true });
  const child = Bun.spawn([process.execPath, SERVER], {
    env: { PATH: process.env.PATH ?? '', ...env, OLYMPUS_EMAIL_SOURCE_PORT: String(await freePort()), ...extra },
    cwd: REPO,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  children.push(child);
  let output = '';
  let errors = '';
  const collect = (stream: ReadableStream<Uint8Array>, add: (text: string) => void): void => {
    void (async () => {
      const decoder = new TextDecoder();
      const reader = stream.getReader();
      for (;;) {
        const { value, done } = await reader.read();
        if (done) return;
        add(decoder.decode(value));
      }
    })();
  };
  collect(child.stdout as ReadableStream<Uint8Array>, (text) => { output += text; });
  collect(child.stderr as ReadableStream<Uint8Array>, (text) => { errors += text; });
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline && !output.includes('worker listening') && child.exitCode === null) await Bun.sleep(100);
  // A little longer: the lines after the listening line are the mounts'.
  await Bun.sleep(300);
  return {
    output: () => output,
    errors: () => errors,
    exitCode: () => child.exitCode,
    stop: async () => {
      child.kill('SIGKILL');
      await child.exited;
    },
  };
}

async function freePort(): Promise<number> {
  const server = Bun.listen({ hostname: '127.0.0.1', port: 0, socket: { data() {} } });
  const port = server.port;
  server.stop(true);
  return port;
}

const registryOf = (env: Env): { schema: number; accounts: Array<{ source_id: string; layout: string; state: string; migration?: { state: string } }> } =>
  JSON.parse(readFileSync(join(olympusDataRoot(env), 'registry.json'), 'utf8'));

const atOldPlaces = (env: Env): string[] => readdirSync(olympusDataRoot(env)).filter((name) => /^dropbox-files/.test(name) && !/-(wal|shm)$/.test(name)).sort();

describe('the boot migration, in a real worker', () => {
  test('with the switch off nothing moves, and the worker opens the stores where they are', async () => {
    const env = freshHome();
    const paths = await seedLegacyDropbox(env);
    const inodes = Object.values(paths).map((path) => lstatSync(path).ino);
    const before = atOldPlaces(env);
    expect(before.length).toBeGreaterThanOrEqual(2);

    const worker = await boot(env, { [MIGRATE_ACCOUNT_FOLDERS_ENV]: '0' });
    try {
      expect(worker.output(), `the worker did not listen (exit ${worker.exitCode()}): ${worker.errors().slice(0, 2000)}`).toContain('worker listening');
      expect(worker.output()).not.toContain('[storage]');
    } finally {
      await worker.stop();
    }

    // What the worker makes beside the stores when it mounts them (their tier ledgers) is its own business; nothing of the account's left.
    expect(atOldPlaces(env)).toEqual(expect.arrayContaining(before));
    expect(Object.values(paths).map((path) => lstatSync(path).ino)).toEqual(inodes);
    expect(existsSync(accountFolder({ source_id: 'dropbox.files', slot: '1' }, env))).toBe(false);
    const dropbox = registryOf(env).accounts.find((account) => account.source_id === 'dropbox.files');
    expect(dropbox?.layout ?? 'legacy').toBe('legacy');
    expect(dropbox?.migration).toBeUndefined();
  }, 120_000);

  test('with the switch on the files are renamed into the folder before the worker listens, and every later boot opens them there', async () => {
    const env = freshHome();
    const paths = await seedLegacyDropbox(env);
    const itemsBefore = { internal: snapshotStore(paths.internal).items.length, secure_local: snapshotStore(paths.secure_local).items.length };
    const inodes = Object.fromEntries(Object.entries(paths).map(([tier, path]) => [tier, lstatSync(path).ino]));
    expect(itemsBefore.internal).toBeGreaterThan(0);
    expect(itemsBefore.secure_local).toBeGreaterThan(0);
    const folder = accountFolder({ source_id: 'dropbox.files', slot: '1' }, env);

    const first = await boot(env, { [MIGRATE_ACCOUNT_FOLDERS_ENV]: '1' });
    try {
      const output = first.output();
      expect(output, `the worker did not listen (exit ${first.exitCode()}): ${first.errors().slice(0, 2000)}`).toContain('worker listening');
      const moved = output.indexOf('[storage] dropbox.files moved into its account folder.');
      expect(moved, output.slice(0, 3000)).toBeGreaterThanOrEqual(0);
      expect(moved).toBeLessThan(output.indexOf('worker listening'));
    } finally {
      await first.stop();
    }

    expect(atOldPlaces(env)).toEqual([]);
    for (const tier of ['internal', 'secure_local'] as const) {
      const moved = join(folder, 'stores', `${tier}.sqlite`);
      expect(lstatSync(moved).ino, tier).toBe(inodes[tier]!);
      expect(snapshotStore(moved).items.length, tier).toBe(itemsBefore[tier]);
    }
    const registry = registryOf(env);
    expect(registry.schema).toBe(2);
    expect(registry.accounts.find((account) => account.source_id === 'dropbox.files')).toMatchObject({ layout: 'folder', state: 'active', migration: { state: 'done' } });

    // The next boot, with the switch back off: the stores are where the registry says, and no empty ones appear at the old places.
    const second = await boot(env, { [MIGRATE_ACCOUNT_FOLDERS_ENV]: '0' });
    try {
      expect(second.output(), `the worker did not listen (exit ${second.exitCode()}): ${second.errors().slice(0, 2000)}`).toContain('worker listening');
      expect(second.output()).not.toContain('[storage]');
    } finally {
      await second.stop();
    }
    expect(atOldPlaces(env)).toEqual([]);
    for (const tier of ['internal', 'secure_local'] as const) {
      expect(snapshotStore(join(folder, 'stores', `${tier}.sqlite`)).items.length, tier).toBe(itemsBefore[tier]);
    }
  }, 180_000);

  // The standalone Linux engine finds its data folder in the install receipt, not in a switch or in the shell it was started from.
  test.skipIf(process.platform !== 'linux')('through an install receipt: the worker moves the files inside the folder the receipt names', async () => {
    const env = freshHome();
    const layout = resolveLinuxEngineLayout(env);
    publishLinuxEngineReceipt(layout);
    mkdirSync(layout.dataDir, { recursive: true, mode: 0o700 });
    expect(olympusDataRoot(env)).toBe(layout.dataDir);
    const paths = await seedLegacyDropbox(env);
    const inodes = Object.fromEntries(Object.entries(paths).map(([tier, path]) => [tier, lstatSync(path).ino]));
    const folder = accountFolder({ source_id: 'dropbox.files', slot: '1' }, env);
    expect(folder.startsWith(`${layout.dataDir}/sources/`)).toBe(true);

    const worker = await boot(env, { [MIGRATE_ACCOUNT_FOLDERS_ENV]: '1' });
    try {
      expect(worker.output(), `the worker did not listen (exit ${worker.exitCode()}): ${worker.errors().slice(0, 2000)}`).toContain('worker listening');
      expect(worker.output()).toContain('[storage] dropbox.files moved into its account folder.');
    } finally {
      await worker.stop();
    }

    expect(atOldPlaces(env)).toEqual([]);
    for (const tier of ['internal', 'secure_local'] as const) expect(lstatSync(join(folder, 'stores', `${tier}.sqlite`)).ino, tier).toBe(inodes[tier]!);
    expect(olympusDataRoot(env)).toBe(layout.dataDir);
    expect(registryOf(env).accounts.find((account) => account.source_id === 'dropbox.files')).toMatchObject({ layout: 'folder', migration: { state: 'done' } });
  }, 180_000);

  test('a registry that cannot be read leaves the migration out and the worker boots as it always did', async () => {
    const env = freshHome();
    const paths = await seedLegacyDropbox(env);
    const before = atOldPlaces(env);
    mkdirSync(olympusDataRoot(env), { recursive: true });
    await Bun.write(join(olympusDataRoot(env), 'registry.json'), '{ not json');

    const worker = await boot(env, { [MIGRATE_ACCOUNT_FOLDERS_ENV]: '1' });
    try {
      // Whatever the rest of the boot does with an unreadable registry, the migration did not touch a file.
      expect(worker.output() + worker.errors()).toContain('Could not check which accounts to move into folders');
    } finally {
      await worker.stop();
    }
    expect(atOldPlaces(env)).toEqual(before);
    expect(existsSync(accountFolder({ source_id: 'dropbox.files', slot: '1' }, env))).toBe(false);
    expect(Object.values(paths).every((path) => existsSync(path))).toBe(true);
  }, 120_000);
});
