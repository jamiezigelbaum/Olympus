// The seeded states of the sources besides Readwise (scripts/release-check/explore-seeds.ts), against a small stand-in for the engine's
// routes: Files on this computer is populated with a real folder chosen through the picker's tools. A source that cannot reach a state is named, and the others go on.

import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { exploreChecks, type ExploreResult, type Seed } from '../scripts/release-check/explore.ts';
import { composeSeeds, localFilesDriver, LOCAL_FILES_FOLDER, type SeedContext, type SourceDriver } from '../scripts/release-check/explore-seeds.ts';

const dirs: string[] = [];
const temp = (): string => { const dir = mkdtempSync(join(tmpdir(), 'rc-seeds-')); dirs.push(dir); return dir; };
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

/** Just enough of the engine: cards that follow the files and the routes, as the dashboard's would. */
class FakeEngine {
  readonly home = temp();
  readonly env: Record<string, string | undefined> = { HOME: this.home };
  readonly calls: string[] = [];
  local = { connected: false, approved: false, items: 0, missing: false, refuseList: false };
  ctx: SeedContext = {
    call: async (method, path, body) => this.route(method, path, body),
    cardOf: async (provider) => this.card(provider),
    sleep: async () => { this.tick(); },
    now: (() => { let t = 0; return () => (t += 1_000); })(),
    home: this.home,
    env: this.env,
  };
  /** Time passing: the engine reads what is in the folder. */
  private tick(): void {
    if (this.local.connected && this.local.approved) {
      const folder = join(this.home, LOCAL_FILES_FOLDER);
      this.local.missing = !existsSync(folder);
      if (!this.local.missing) this.local.items = readdirSync(folder).length;
    }
  }
  private card(provider: string): any {
    this.tick();
    if (provider === 'local_files') {
      const l = this.local;
      return { provider, connection: { state: l.connected ? 'synced' : 'not_connected', label: 'x' }, coverage: { indexed_items: l.items }, scope_selection: { connected: l.connected, status: l.approved ? 'approved' : 'scope_pending' }, schedule: { missing_folders: l.missing ? ['f'] : [], ...(l.missing ? { degraded_reason: 'scope_root_missing' } : {}) } };
    }
    return { provider, connection: { state: 'not_connected' }, coverage: { indexed_items: 0 } };
  }
  private route(method: string, path: string, body: any): { status: number; json: any; text: string } {
    this.calls.push(`${method} ${path}${body?.source_id ? ` ${body.source_id}` : body?.source ? ` ${body.source}` : body?.name ? ` ${body.name}` : ''}`);
    const ok = (json: any = { ok: true }) => ({ status: 200, json, text: JSON.stringify(json) });
    if (path === '/dashboard/delete-source-data') {
      this.local.items = 0;
      return ok();
    }
    if (path === '/dashboard/connect/this-computer') { this.local.connected = true; return ok(); }
    if (path === '/dashboard/disconnect') { this.local.connected = false; return ok(); }
    if (path === '/dashboard/sync-now') return ok();
    if (path === '/dashboard/tools/call' && body.name === 'olympus_scope_list') {
      const nodes = this.local.refuseList ? [] : [{ key: 'k:docs', name: 'Documents' }, { key: `k:${LOCAL_FILES_FOLDER}`, name: LOCAL_FILES_FOLDER }];
      return ok({ _meta: { 'olympus/scope': { kind: 'folders', account_generation: 'g1', scope_revision: 'r1', nodes } } });
    }
    if (path === '/dashboard/tools/call' && body.name === 'olympus_scope_set') {
      if (body.arguments.selections?.[0]?.key !== `k:${LOCAL_FILES_FOLDER}`) return { status: 400, json: undefined, text: 'bad selection' };
      this.local.approved = true;
      return ok({ structuredContent: { status: 'saved' } });
    }
    return { status: 404, json: undefined, text: 'no route' };
  }
}

describe('Files on this computer', () => {
  test('populated makes a real folder, connects, chooses it with the picker\'s tools and waits for it to be indexed', async () => {
    const engine = new FakeEngine();
    const result = await localFilesDriver(engine.ctx).states.populated!();
    expect(result.ok).toBe(true);
    expect(readdirSync(join(engine.home, LOCAL_FILES_FOLDER)).sort()).toEqual(['budget.txt', 'recipes.txt', 'trip-notes.txt']);
    expect(engine.calls).toEqual(expect.arrayContaining(['POST /dashboard/connect/this-computer local.files', 'POST /dashboard/tools/call olympus_scope_list', 'POST /dashboard/tools/call olympus_scope_set', 'POST /dashboard/sync-now local.files']));
    expect(engine.local).toMatchObject({ connected: true, approved: true, items: 3 });
  });

  test('failed moves the folder away until the card reports it missing; populated brings it back', async () => {
    const engine = new FakeEngine();
    const driver = localFilesDriver(engine.ctx);
    expect((await driver.states.failed!()).ok).toBe(true);
    expect(engine.local.missing).toBe(true);
    expect((await driver.states.populated!()).ok).toBe(true);
    expect(engine.local.missing).toBe(false);
  });

  test('disconnected keeps the data, and empty deletes it', async () => {
    const engine = new FakeEngine();
    const driver = localFilesDriver(engine.ctx);
    expect((await driver.states.disconnected!()).ok).toBe(true);
    expect(engine.local).toMatchObject({ connected: false, items: 3 });
    expect((await driver.states.empty!()).ok).toBe(true);
    expect(engine.local.items).toBe(0);
  });

  test('a picker that does not list the folder fails the state and says so', async () => {
    const engine = new FakeEngine();
    engine.local.refuseList = true;
    const result = await localFilesDriver(engine.ctx).states.populated!();
    expect(result.ok).toBe(false);
    expect(result.detail).toContain('did not list the folder');
  });
});

describe('putting the sources together', () => {
  const primary = (ok: boolean): Seed[] => [{ id: 'populated', title: 'populated', apply: async () => ({ ok, detail: ok ? 'readwise ready' : 'readwise broke' }) }];
  const driver = (label: string, result: () => Promise<{ ok: boolean; detail: string }>): SourceDriver => ({ label, states: { populated: result } });

  test('a source that cannot reach the state is named and the seed still stands; one that throws is named too', async () => {
    const seeds = composeSeeds(primary(true), [driver('Fine', async () => ({ ok: true, detail: 'fine' })), driver('Stuck', async () => ({ ok: false, detail: 'never indexed' })), driver('Throws', async () => { throw new Error('boom'); })]);
    const applied = await seeds[0]!.apply();
    expect(applied.ok).toBe(true);
    expect(applied.failedSources).toEqual([{ source: 'Stuck', detail: 'never indexed' }, { source: 'Throws', detail: 'boom' }]);
    expect(applied.detail).toContain('Stuck NOT PRODUCED');
  });

  test('the primary source failing is the seed failing, and the others are not asked', async () => {
    let asked = false;
    const seeds = composeSeeds(primary(false), [driver('Other', async () => { asked = true; return { ok: true, detail: '' }; })]);
    expect(await seeds[0]!.apply()).toEqual({ ok: false, detail: 'readwise broke' });
    expect(asked).toBe(false);
  });

  test('a state a source does not have leaves it as it is', async () => {
    const seeds = composeSeeds([{ id: 'failed', title: 'failed', apply: async () => ({ ok: true, detail: 'rw' }) }], [driver('OnlyPopulated', async () => ({ ok: false, detail: 'should not run' }))]);
    expect(await seeds[0]!.apply()).toEqual({ ok: true, detail: 'rw' });
  });

  test('a source that could not be driven fails the sources check; none failing adds no check', () => {
    const base = { seeds: [], traces: [], coverage: [], unlisted: [], summary: { listed: 0, found: 0, pressed: 0, missed: 0, unlisted: 0, presses: 0 }, accessibility: { status: 'skipped' as const, reason: 'x' } };
    expect(exploreChecks({ ...base } as ExploreResult).some((check) => check.id === 'explore.sources')).toBe(false);
    const failing = exploreChecks({ ...base, sourceFailures: [{ seed: 'populated', source: 'Files on this computer', detail: 'never indexed' }] } as ExploreResult).find((check) => check.id === 'explore.sources')!;
    expect(failing.status).toBe('fail');
    expect(failing.detail).toContain('Files on this computer (populated): never indexed');
  });
});
