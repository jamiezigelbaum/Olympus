// A CLI command that opens stores never opens them from the CLI process while
// Olympus runs (docs/design/source-storage.md, "Owner lock"): it takes the
// lock when it is free, asks the running worker when the lock is busy, and
// refuses when it is busy and nothing answers. Spawning tests carry an
// explicit per-test timeout (test/spawn-timeout-guard.test.ts).

import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { Database } from 'bun:sqlite';
import { afterEach, describe, expect, test } from 'bun:test';
import {
  DataOwnerBusyError,
  STOP_OLYMPUS_HINT,
  tryDataOwnerLock,
} from '../src/core/data-owner-lock.ts';
import { olympusDataRoot } from '../src/core/olympus-layout.ts';
import { loadConfig } from '../src/core/config.ts';
import { lifecycleSourceSpecs } from '../src/data-lifecycle.ts';
import { OperationError } from '../src/core/operation-error.ts';
import {
  WorkerUnreachableError,
  canonicalDataRoot,
  callWorkerCli,
  runLocallyOrThroughWorker,
} from '../src/core/cli-via-worker.ts';
import { bindWorkerSocket, prepareWorkerSocket } from '../src/core/worker-transport.ts';
import { withWorkerBearerAuth } from '../src/workers/http.ts';
import {
  collectLocalSourceIngestionLedger,
  formatSourceIngestionLedger,
  type SourceIngestionLedgerSnapshot,
} from '../src/workers/source-ingestion-ledger.ts';
import { createEmailSourceWorker } from '../src/workers/email-source/index.ts';

const TOKEN = 'cli-worker-test-token';
const roots: string[] = [];
const children: Array<{ kill(signal?: number | NodeJS.Signals): void }> = [];
const servers: Array<{ stop(closeActiveConnections?: boolean): unknown }> = [];
const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  for (const child of children.splice(0)) {
    try { child.kill('SIGKILL'); } catch { /* already gone */ }
  }
  for (const server of servers.splice(0)) server.stop(true);
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const LOCK_MODULE = join(import.meta.dir, '..', 'src', 'core', 'data-owner-lock.ts');
const CLI = join(import.meta.dir, '..', 'src', 'cli.ts');

/** The test's own isolated home (test/support/isolated-home.ts) and what a child needs to share its data root. */
function sharedEnv(extra: Record<string, string> = {}): Record<string, string> {
  return { PATH: process.env.PATH ?? '', HOME: process.env.HOME!, ...extra };
}

/** A child process that takes the owner lock for `env`'s data root and holds it. */
async function startHolder(env: Record<string, string>) {
  const dir = mkdtempSync(join(tmpdir(), 'olympus-cli-holder-'));
  roots.push(dir);
  const script = join(dir, 'holder.mts');
  await Bun.write(script, `
import { holdDataOwnerLock } from ${JSON.stringify(LOCK_MODULE)};
globalThis.heldDataOwnerLock = holdDataOwnerLock(process.env);
process.stdout.write('HELD\\n');
setInterval(() => {}, 1000);
`);
  const child = Bun.spawn([process.execPath, script], { env, stdout: 'pipe', stderr: 'pipe' });
  children.push(child);
  const reader = child.stdout.getReader();
  let seen = '';
  while (!seen.includes('HELD')) {
    const { value, done } = await reader.read();
    if (done) throw new Error(`holder exited: ${await new Response(child.stderr).text()}`);
    seen += new TextDecoder().decode(value);
  }
  return child;
}

interface ServedWorker {
  /** What a caller needs in its environment to reach this server. */
  env: Record<string, string>;
  requests: Array<{ method: string; path: string; authorization: string | null; body: string }>;
}

/**
 * Serve `handler` the way the worker is reached: its owner Unix socket on
 * Linux, loopback elsewhere. Every request is recorded.
 */
function serveWorker(handler: (request: Request) => Response | Promise<Response>): ServedWorker {
  const requests: ServedWorker['requests'] = [];
  const recording = async (request: Request): Promise<Response> => {
    requests.push({
      method: request.method,
      path: new URL(request.url).pathname,
      authorization: request.headers.get('authorization'),
      body: request.method === 'POST' ? await request.clone().text() : '',
    });
    return handler(request);
  };
  const base = { ...sharedEnv(), OLYMPUS_WORKER_AUTH_TOKEN: TOKEN };
  if (process.platform === 'linux') {
    const runtime = mkdtempSync(join(tmpdir(), 'olympus-cli-rt-'));
    roots.push(runtime);
    const env = { ...base, XDG_RUNTIME_DIR: runtime, OLYMPUS_EMAIL_BASE_URL: 'http://127.0.0.1:9/v1' };
    const socketPath = prepareWorkerSocket({ env })!;
    servers.push(bindWorkerSocket(socketPath, () => Bun.serve({ unix: socketPath, fetch: recording })));
    return { env, requests };
  }
  const server = Bun.serve({ port: 0, fetch: recording });
  servers.push(server);
  return { env: { ...base, OLYMPUS_EMAIL_BASE_URL: `http://127.0.0.1:${server.port}/v1` }, requests };
}

/** An address nothing listens on (a stopped server's port; on Linux, a socket that does not exist). */
function nothingListening(): Record<string, string> {
  const base = { ...sharedEnv(), OLYMPUS_WORKER_AUTH_TOKEN: TOKEN };
  if (process.platform === 'linux') {
    const runtime = mkdtempSync(join(tmpdir(), 'olympus-cli-rt-'));
    roots.push(runtime);
    return { ...base, XDG_RUNTIME_DIR: runtime, OLYMPUS_EMAIL_BASE_URL: 'http://127.0.0.1:9/v1' };
  }
  const server = Bun.serve({ port: 0, fetch: () => new Response('') });
  const port = server.port;
  server.stop(true);
  return { ...base, OLYMPUS_EMAIL_BASE_URL: `http://127.0.0.1:${port}/v1` };
}

const answers = (path: string, value: unknown, status = 200) => (request: Request): Response =>
  new URL(request.url).pathname === '/v1/health'
    ? Response.json({ ok: true })
    : new URL(request.url).pathname === path
      ? Response.json(value, { status })
      : new Response('not found', { status: 404 });

describe('runLocallyOrThroughWorker', () => {
  test('with the lock free it runs the command here, under the lock, and never asks a worker', async () => {
    const env = sharedEnv();
    const calls: string[] = [];
    const value = await runLocallyOrThroughWorker(
      () => {
        calls.push('local');
        // The lock is ours while the command runs: a second try finds it busy.
        expect(tryDataOwnerLock(env)).toBeUndefined();
        return 7;
      },
      async () => { calls.push('worker'); return 8; },
      env,
    );
    expect(value).toBe(7);
    expect(calls).toEqual(['local']);
    const freed = tryDataOwnerLock(env);
    expect(freed).toBeDefined();
    freed!.release();
  });

  test('a command that fails still lets the lock go', async () => {
    const env = sharedEnv();
    await expect(runLocallyOrThroughWorker(() => { throw new Error('command failed'); }, undefined, env)).rejects.toThrow('command failed');
    const freed = tryDataOwnerLock(env);
    expect(freed).toBeDefined();
    freed!.release();
  });

  test('with the lock held by Olympus and a worker answering it asks the worker, over the worker bearer, and runs nothing here', async () => {
    const holderEnv = sharedEnv();
    await startHolder(holderEnv);
    const worker = serveWorker(answers('/v1/cli/tier', { kind: 'from-the-worker' }));
    let ranLocally = false;
    const result = await runLocallyOrThroughWorker(
      () => { ranLocally = true; return { kind: 'local' }; },
      () => callWorkerCli('tier', { args: ['explain', 'x'] }, { env: worker.env }),
      holderEnv,
    );
    expect(result).toEqual({ kind: 'from-the-worker' });
    expect(ranLocally).toBe(false);
    const asked = worker.requests.find((request) => request.path === '/v1/cli/tier')!;
    expect(asked.method).toBe('POST');
    expect(asked.authorization).toBe(`Bearer ${TOKEN}`);
    // With the data root it is for, which the worker checks is its own.
    expect(JSON.parse(asked.body)).toEqual({ args: ['explain', 'x'], data_root: canonicalDataRoot(olympusDataRoot(worker.env)) });
  }, 60_000);

  test('with the lock held and no worker answering it refuses as busy, naming the data and how to stop Olympus', async () => {
    const holderEnv = sharedEnv();
    await startHolder(holderEnv);
    let ranLocally = false;
    let caught: unknown;
    try {
      await runLocallyOrThroughWorker(
        () => { ranLocally = true; },
        () => callWorkerCli('tier', { args: ['explain', 'x'] }, { env: nothingListening() }),
        holderEnv,
      );
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(DataOwnerBusyError);
    expect((caught as DataOwnerBusyError).message).toContain(`Olympus is running and owns its data at ${olympusDataRoot(holderEnv)}`);
    expect((caught as DataOwnerBusyError).message).toContain(STOP_OLYMPUS_HINT);
    expect(ranLocally).toBe(false);
  }, 60_000);

  test('a command with no worker leg refuses as busy while Olympus holds the lock', async () => {
    const holderEnv = sharedEnv();
    await startHolder(holderEnv);
    await expect(runLocallyOrThroughWorker(() => 1, undefined, holderEnv)).rejects.toBeInstanceOf(DataOwnerBusyError);
  }, 60_000);

  test('what the worker says is not mistaken for no worker: its own refusal reaches the caller as it is', async () => {
    const holderEnv = sharedEnv();
    await startHolder(holderEnv);
    const worker = serveWorker(answers('/v1/cli/data-delete', {
      error: { code: 'delete_source_connected', message: 'Disconnect this source before deleting its indexed data.', suggestion: 'Use Disconnect.' },
    }, 409));
    let caught: unknown;
    try {
      await runLocallyOrThroughWorker(() => 1, () => callWorkerCli('data-delete', { source_id: 'dropbox.files' }, { env: worker.env }), holderEnv);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(OperationError);
    expect(caught).toMatchObject({
      code: 'delete_source_connected',
      message: 'Disconnect this source before deleting its indexed data.',
      suggestion: 'Use Disconnect.',
    });
  }, 60_000);
});

describe('callWorkerCli', () => {
  test('a worker that does not answer in time counts as no worker', async () => {
    const worker = serveWorker(() => new Promise<Response>(() => {}));
    await expect(callWorkerCli('tier', { args: [] }, { env: worker.env, connectTimeoutMs: 200 })).rejects.toBeInstanceOf(WorkerUnreachableError);
  }, 30_000);

  test('no worker token counts as no worker: there is nothing to present', async () => {
    const worker = serveWorker(answers('/v1/cli/tier', {}));
    const { OLYMPUS_WORKER_AUTH_TOKEN: _token, ...withoutToken } = worker.env;
    await expect(callWorkerCli('tier', { args: [] }, { env: withoutToken })).rejects.toBeInstanceOf(WorkerUnreachableError);
    expect(worker.requests).toEqual([]);
  }, 30_000);

  test('a worker that refuses the token, or is older than the command, says so and names how to stop Olympus', async () => {
    const refusing = serveWorker(answers('/v1/cli/tier', { error: { code: 'unauthorized', message: 'no' } }, 401));
    await expect(callWorkerCli('tier', { args: [] }, { env: refusing.env })).rejects.toMatchObject({
      code: 'config_error',
      message: expect.stringContaining('did not accept'),
      suggestion: expect.stringContaining(STOP_OLYMPUS_HINT),
    });
    const older = serveWorker((request) => new URL(request.url).pathname === '/v1/health'
      ? Response.json({ ok: true })
      : Response.json({ error: { code: 'not_found', message: 'Email source worker route not found.' } }, { status: 404 }));
    await expect(callWorkerCli('tier', { args: [] }, { env: older.env })).rejects.toMatchObject({
      code: 'config_error',
      message: expect.stringContaining('older than this command'),
      suggestion: expect.stringContaining(STOP_OLYMPUS_HINT),
    });
  }, 30_000);

  test('an answer that is not a result, or a failure with no reason, is reported without a guess', async () => {
    const unreadable = serveWorker(answers('/v1/cli/tier', 'not an object'));
    await expect(callWorkerCli('tier', { args: [] }, { env: unreadable.env })).rejects.toMatchObject({
      code: 'source_index_error',
      message: expect.stringContaining('unreadable'),
    });
    const failing = serveWorker((request) => new URL(request.url).pathname === '/v1/health'
      ? Response.json({ ok: true })
      : new Response('<html>oops</html>', { status: 500 }));
    await expect(callWorkerCli('tier', { args: [] }, { env: failing.env })).rejects.toMatchObject({
      code: 'source_index_error',
      message: expect.stringContaining('HTTP 500'),
    });
  }, 30_000);
});

/** The CLI, as a child process, against an isolated home. */
async function runCli(args: string[], env: Record<string, string>): Promise<{ stdout: string; stderr: string; code: number }> {
  const child = Bun.spawn([process.execPath, CLI, ...args], { env, stdout: 'pipe', stderr: 'pipe' });
  children.push(child);
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  return { stdout, stderr, code };
}

/** The real worker routes on an in-process worker, behind the worker bearer, served as the CLI reaches a worker. */
function serveRealWorker(): ServedWorker {
  const worker = createEmailSourceWorker({});
  const guarded = withWorkerBearerAuth(worker.fetch, { authToken: TOKEN });
  return serveWorker(guarded);
}

describe('the CLI while Olympus runs', () => {
  test('ingestion status: the worker returns what the local function returns, and the text form reads the same', async () => {
    const holderEnv = sharedEnv();
    const local = await collectLocalSourceIngestionLedger({ config: loadConfig(process.env) });

    await startHolder(holderEnv);
    const served = serveRealWorker();
    const viaWorker = await runLocallyOrThroughWorker(
      () => { throw new Error('ran here while Olympus holds the lock'); },
      () => callWorkerCli<SourceIngestionLedgerSnapshot>('ingestion-status', {}, { env: served.env }),
      holderEnv,
    );
    expect(served.requests.map((request) => request.path)).toContain('/v1/cli/ingestion-status');

    // Only the moment it was taken differs.
    const withoutClock = (value: SourceIngestionLedgerSnapshot) => ({ ...value, generated_at: '<time>' });
    expect(JSON.stringify(withoutClock(viaWorker), null, 2)).toBe(JSON.stringify(withoutClock(local), null, 2));
    expect(formatSourceIngestionLedger(withoutClock(viaWorker))).toBe(formatSourceIngestionLedger(withoutClock(local)));
  }, 60_000);

  test('a busy lock on another data root does not send the command to the Olympus that answers', async () => {
    // A script holds an alternate XDG_DATA_HOME's owner lock while the usual
    // Olympus runs and answers on the usual worker URL with the usual token.
    const other = mkdtempSync(join(tmpdir(), 'olympus-cli-other-root-'));
    roots.push(other);
    await startHolder(sharedEnv({ XDG_DATA_HOME: other }));
    const store = lifecycleSourceSpecs().find((entry) => entry.sourceId === 'dropbox.files')!.connectorStorePaths!({})[0]!;
    mkdirSync(dirname(store), { recursive: true });
    writeFileSync(store, 'indexed');
    // Not a database: later tests in this home export and read its stores.
    cleanups.push(() => rmSync(store, { force: true }));
    const served = serveRealWorker();
    const otherEnv = { ...served.env, XDG_DATA_HOME: other };
    let caught: unknown;
    try {
      await runLocallyOrThroughWorker(
        () => { throw new Error('ran here while another process holds the lock'); },
        () => callWorkerCli('data-delete', { source_id: 'dropbox.files', dry_run: false }, { env: otherEnv }),
        otherEnv,
      );
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(OperationError);
    expect((caught as OperationError).code).toBe('config_error');
    expect((caught as OperationError).message).toContain(canonicalDataRoot(olympusDataRoot(otherEnv)));
    expect(existsSync(store)).toBe(true);
  }, 60_000);

  test('data export writes the same export through the worker as it does locally, to the folder it was given', async () => {
    const out = mkdtempSync(join(tmpdir(), 'olympus-cli-export-'));
    roots.push(out);
    const localDir = join(out, 'local');
    const workerDir = join(out, 'worker');
    // One real store to snapshot.
    const store = lifecycleSourceSpecs().find((entry) => entry.sourceId === 'x.bookmarks')!.connectorStorePaths!({})[0]!;
    mkdirSync(dirname(store), { recursive: true });
    const seeded = new Database(store, { create: true });
    seeded.exec('CREATE TABLE rows (id INTEGER PRIMARY KEY, value TEXT NOT NULL);');
    seeded.query('INSERT INTO rows (value) VALUES (?)').run('kept');
    seeded.close();
    const local = await runCli(['data', 'export', '--output', localDir], sharedEnv());
    expect(local.code, local.stderr).toBe(0);

    await startHolder(sharedEnv());
    const served = serveRealWorker();
    const viaWorker = await runCli(['data', 'export', '--output', workerDir], served.env);
    expect(viaWorker.code, viaWorker.stderr).toBe(0);
    expect(served.requests.some((request) => request.path === '/v1/cli/data-export' && JSON.parse(request.body).output === workerDir)).toBe(true);

    const normalize = (text: string, dir: string) => JSON.parse(text.split(dir).join('<out>'));
    expect(normalize(viaWorker.stdout, workerDir)).toEqual(normalize(local.stdout, localDir));
    expect(JSON.parse(viaWorker.stdout).files.some((file: string) => file.includes(join('sources', 'x.bookmarks')))).toBe(true);
    expect(existsSync(join(workerDir, 'manifest.json'))).toBe(true);
    expect(readdirSync(workerDir).sort()).toEqual(readdirSync(localDir).sort());
  }, 120_000);

  test('a relative export folder is the caller\'s: the worker is sent the absolute path, not its own working directory\'s', async () => {
    const out = mkdtempSync(join(tmpdir(), 'olympus-cli-export-'));
    roots.push(out);
    await startHolder(sharedEnv());
    const served = serveRealWorker();
    const run = Bun.spawn([process.execPath, CLI, 'data', 'export', '--output', 'relative-export'], {
      cwd: out, env: served.env, stdout: 'pipe', stderr: 'pipe',
    });
    children.push(run);
    const [stderr, code] = await Promise.all([new Response(run.stderr).text(), run.exited]);
    expect(code, stderr).toBe(0);
    expect(existsSync(join(realpathSync(out), 'relative-export', 'manifest.json'))).toBe(true);
    expect(existsSync(join(process.cwd(), 'relative-export'))).toBe(false);
  }, 120_000);

  test('data delete --all never asks the worker: the lock being held makes it a refusal, not a delete', async () => {
    await startHolder(sharedEnv());
    const served = serveRealWorker();
    const dry = await runCli(['data', 'delete', '--all', '--dry-run'], served.env);
    expect(dry.code, dry.stderr).toBe(0);
    expect(JSON.parse(dry.stdout)).toMatchObject({ ok: true, mode: 'all', dryRun: true });

    const real = await runCli(['data', 'delete', '--all', '--yes-i-am-sure'], served.env);
    expect(real.code).toBe(1);
    // Refused whatever custody observes: with a worker or engine running, by custody's own words; with
    // nothing observed running but the lock held, as busy rather than deleted from under its holder.
    expect(real.stderr).toMatch(/owns its data|Stop the Olympus engine|Stop or uninstall the Olympus worker/);
    expect(served.requests.filter((request) => request.path.startsWith('/v1/cli/'))).toEqual([]);
    expect(existsSync(olympusDataRoot(sharedEnv()))).toBe(true);
  }, 120_000);

  test('tier migrate run does not run beside Olympus, and never reaches the worker', async () => {
    await startHolder(sharedEnv());
    const served = serveRealWorker();
    for (const args of [['migrate', 'run', '--plan', 'p'], ['migrate', 'rollback', '--batch', 'b'], ['migrate', 'purge', '--approve', '--expect', 'd', '--why', 'w']]) {
      const refused = await runCli(['tier', ...args], served.env);
      expect(refused.code, args.join(' ')).toBe(1);
      expect(refused.stderr).toContain('Olympus is running and owns its data');
      expect(refused.stderr).toContain(STOP_OLYMPUS_HINT);
    }
    expect(served.requests.filter((request) => request.path.startsWith('/v1/cli/'))).toEqual([]);
  }, 120_000);

  test('tier migrate status and a refusal from the worker read as they do at the command line', async () => {
    await startHolder(sharedEnv());
    const served = serveRealWorker();
    const status = await runCli(['tier', 'migrate', 'status'], served.env);
    expect(status.code, status.stderr).toBe(0);
    expect(JSON.parse(status.stdout)).toMatchObject({ kind: 'olympus_tier_migration_status' });

    const missing = await runCli(['tier', 'explain', 'no-such-item'], served.env);
    expect(missing.code).toBe(1);
    expect(missing.stderr).toContain('Error [invalid_params]: No stored item matches that locator.');
    expect(missing.stderr).toContain('Fix: Use the locator an answer cited, or the provider item id.');
    expect(served.requests.filter((request) => request.path === '/v1/cli/tier')).toHaveLength(2);
  }, 120_000);

  test('with Olympus holding the lock and nothing answering, a command refuses as busy', async () => {
    await startHolder(sharedEnv());
    const env = nothingListening();
    for (const args of [['tier', 'explain', 'x'], ['data', 'export', '--output', join(tmpdir(), 'olympus-never-written')], ['data', 'delete', '--source', 'dropbox.files', '--dry-run']]) {
      const refused = await runCli(args, env);
      expect(refused.code, args.join(' ')).toBe(1);
      expect(refused.stderr, args.join(' ')).toContain('Olympus is running and owns its data');
    }
    expect(existsSync(join(tmpdir(), 'olympus-never-written'))).toBe(false);
  }, 120_000);

  test('with the lock free the command runs here and never looks for a worker', async () => {
    const served = serveRealWorker();
    const free = await runCli(['tier', 'explain', 'no-such-item'], served.env);
    expect(free.code).toBe(1);
    expect(free.stderr).toContain('No stored item matches that locator.');
    expect(served.requests).toEqual([]);
  }, 60_000);
});
