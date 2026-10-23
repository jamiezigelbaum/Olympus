/**
 * Test preload: every test runs against a throwaway HOME, XDG tree and
 * temp dir, never the owner's real one. A test that forgets to isolate itself
 * (2026-10-23: a delete fixture overwrote the live Dropbox store because the
 * resolver reads os.homedir(), not the env the fixture passed) writes into
 * this directory and nothing else.
 *
 * Also clears OLYMPUS_* and XDG_* so an ambient engine/worker setting cannot steer a
 * test onto the real data. A test that needs a variable sets it itself.
 */
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { homedir, tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import * as osModule from 'node:os';
import { createRequire } from 'node:module';
import { afterAll, mock } from 'bun:test';

const realHome = (() => { try { return userInfo().homedir; } catch { return process.env.HOME ?? ''; } })();
const root = realpathSync(mkdtempSync(join(tmpdir(), 'olympus-test-home-')));
const home = join(root, 'home');
mkdirSync(home, { recursive: true });

process.env.HOME = home;
// XDG roots are unset, not redirected: every default then derives from the
// throwaway HOME, and a test that passes its own homeDir still gets its own tree.
for (const name of Object.keys(process.env)) {
  if (name.startsWith('OLYMPUS_') || name.startsWith('XDG_')) delete process.env[name];
}
process.env.OLYMPUS_TEST_ISOLATED_HOME = home;
process.env.OLYMPUS_TEST_REAL_HOME = realHome;

// Bun reads HOME for os.homedir() once, at process start, so changing the env
// here is not enough: make every os.homedir() (ESM import and require) follow
// the live HOME, which is now the throwaway one.
const liveHome = () => process.env.HOME ?? home;
const osCopy = { ...osModule } as Record<string, unknown>;
mock.module('node:os', () => ({ ...osCopy, default: { ...osCopy, homedir: liveHome }, homedir: liveHome }));
try { (createRequire(import.meta.url)('node:os') as { homedir: () => string }).homedir = liveHome; } catch { /* import form above still covers ESM */ }

afterAll(() => {
  if (realHome && homedir() === realHome) {
    throw new Error(`a test moved HOME back to the real home ${realHome}; tests must never run against it`);
  }
});
process.once('exit', () => {
  try { rmSync(root, { recursive: true, force: true }); } catch { /* best effort */ }
});
