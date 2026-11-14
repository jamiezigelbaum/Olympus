// The upgrade's store copy under a real systemd user manager (CI's deploy
// shard 1 sets OLYMPUS_REAL_SYSTEMD=1 after enabling lingering; skipped
// elsewhere). It writes the real worker unit, with its Restart= policy and its
// hold condition, and runs a stand-in engine that keeps a store open. A
// restarter keeps asking systemd to start the unit, standing in for whatever
// started the engine 15 s after the upgrade's stop on the gate7 rc.11 legs.
//
// Without the hold, the restarted engine opens the store under the copy and
// the copy fails, as it did on those legs. With it, no start gets through
// until the hold is let go, and the copy completes.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { olympusDataRoot } from '../src/core/olympus-layout.ts';
import { copyStoresBeforeUpgrade, upgradeCopyPath } from '../src/core/upgrade-store-copies.ts';
import { holdLinuxWorkerStopped, installWorkerService, workerServicePaths } from '../src/core/worker-service.ts';
import { waitFor } from './helpers/test-clock.ts';

const REAL = process.platform === 'linux' && process.env.OLYMPUS_REAL_SYSTEMD === '1';
const UNIT = 'olympus-worker.service';
const systemctl = (...args: string[]) => spawnSync('systemctl', ['--user', ...args], { encoding: 'utf8' });
const activeState = () => systemctl('show', '-p', 'ActiveState', '--value', UNIT).stdout.trim();

describe.skipIf(!REAL)('the upgrade copy under a real systemd user unit', () => {
  const home = homedir();
  const scratch = mkdtempSync(join(tmpdir(), 'olympus-real-systemd-'));
  const env = { HOME: scratch, XDG_DATA_HOME: join(scratch, 'data') };
  const store = join(olympusDataRoot(env), 'tier-ledger.sqlite');
  const opened = join(scratch, 'opened');
  let restarter: ChildProcess | undefined;

  beforeAll(() => {
    mkdirSync(olympusDataRoot(env), { recursive: true });
    const db = new Database(store, { create: true });
    db.exec("PRAGMA journal_mode = WAL; CREATE TABLE kept (value TEXT); INSERT INTO kept (value) VALUES ('before the upgrade');");
    db.close();
    // The stand-in engine: opens the store, writes to it, then holds a read
    // open, so a checkpoint under it cannot finish (as a real engine's reads do).
    const engine = join(scratch, 'engine.ts');
    writeFileSync(engine, `
      import { Database } from 'bun:sqlite';
      import { appendFileSync } from 'node:fs';
      const db = new Database(${JSON.stringify(store)});
      db.exec("PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0; INSERT INTO kept (value) VALUES ('engine');");
      db.exec('BEGIN'); db.query('SELECT COUNT(*) FROM kept').get();
      appendFileSync(${JSON.stringify(opened)}, process.pid + '\\n');
      setInterval(() => {}, 60_000);
    `);
    const installed = installWorkerService({ platform: 'linux', homeDir: home, workingDirectory: scratch });
    // The real unit, with the stand-in as its engine.
    const unit = readFileSync(installed.unit_path, 'utf8').replace(/^ExecStart=.*$/m, `ExecStart=${process.execPath} ${engine}`);
    writeFileSync(installed.unit_path, unit);
    expect(systemctl('daemon-reload').status).toBe(0);
    expect(systemctl('start', UNIT).status).toBe(0);
    restarter = spawn('sh', ['-c', `while :; do systemctl --user start ${UNIT} >/dev/null 2>&1; sleep 0.3; done`], { stdio: 'ignore' });
  });

  afterAll(() => {
    restarter?.kill('SIGKILL');
    systemctl('stop', UNIT);
    const paths = workerServicePaths('linux', home);
    rmSync(paths.unitPath, { force: true });
    rmSync(paths.envPath, { force: true });
    systemctl('daemon-reload');
    rmSync(scratch, { recursive: true, force: true });
  });

  test('without the hold, an engine started under the copy makes it fail (the rc.11 failure)', async () => {
    await waitFor(() => existsSync(opened) && activeState() === 'active', { timeoutMs: 20_000 });
    expect(systemctl('stop', UNIT).status).toBe(0);
    // The restarter starts it again, and it opens the store.
    await waitFor(() => activeState() === 'active' && readFileSync(opened, 'utf8').trim().split('\n').length >= 2, { timeoutMs: 20_000 });
    expect(() => copyStoresBeforeUpgrade(env, { bunBin: process.execPath })).toThrow(/could not copy a store before updating it; it is open in pid \d+/);
    expect(existsSync(upgradeCopyPath(store))).toBe(false);
  }, 60_000);

  test('with the hold, nothing starts the engine until the copy is done', async () => {
    await waitFor(() => activeState() === 'active', { timeoutMs: 20_000 });
    const starts = readFileSync(opened, 'utf8').trim().split('\n').length;
    const held = holdLinuxWorkerStopped({ homeDir: home });
    try {
      expect(['inactive', 'failed']).toContain(activeState());
      // The restarter keeps trying for a while; every start is skipped.
      const until = performance.now() + 3_000;
      await waitFor(() => performance.now() >= until, { timeoutMs: 5_000 });
      expect(['inactive', 'failed']).toContain(activeState());
      expect(readFileSync(opened, 'utf8').trim().split('\n').length).toBe(starts);
      const copied = copyStoresBeforeUpgrade(env, { bunBin: process.execPath });
      expect(copied.stores).toBe(1);
    } finally {
      held.release();
    }
    const copy = new Database(upgradeCopyPath(store), { readonly: true });
    expect(copy.query('PRAGMA integrity_check').get()).toEqual({ integrity_check: 'ok' });
    copy.close();
    // Let go, the next start gets through.
    await waitFor(() => activeState() === 'active', { timeoutMs: 20_000 });
  }, 60_000);
});
