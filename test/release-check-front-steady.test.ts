// The release check's split-front stage (scripts/release-check/front-steady.ts): the rc.4 install crashed its front on every
// start (ops#151) and every leg passed, so the stage's judgment and its Gmail fixture are held here.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'bun:test';
import { ScopeRoot } from '../src/core/scope-safe-fs.ts';
import { archiveFileEntries, buildArchiveManifest } from '../src/workers/archive-import/manifest.ts';
import { identifyGmailExport } from '../src/workers/archive-import/mbox/gmail-account.ts';
import {
  archiveStatusOf, crashLines, frontChurn, frontGmailMbox, frontSteadyChecks, type FrontSteadyObservation,
} from '../scripts/release-check/front-steady.ts';
import { enginePidsIn, staleAgentOnPort } from '../scripts/release-check/machine-agent.ts';
import { OWNER_ADDRESS } from './support/archive-fixtures-gmail.ts';

const steady = (over: Partial<FrontSteadyObservation> = {}): FrontSteadyObservation => ({
  ok: true,
  gmail: { started: 'needs_approval', approved: true, settled: true, status: 'imported' },
  telegram: { ok: true, detail: 'seeded' },
  lanes: [
    { source: 'gmail.email', tier: 'internal', exists: true, items: 1 },
    { source: 'gmail.email', tier: 'secure_local', exists: true, items: 1 },
    { source: 'telegram.messages', tier: 'internal', exists: true, items: 2 },
    { source: 'telegram.messages', tier: 'secure_local', exists: true, items: 0 },
  ],
  archives: 5,
  restart: { ok: true, ms: 20_000 },
  samples: Array.from({ length: 50 }, () => ({ front: [200], background: [100] })),
  watchMs: 150_000,
  logHits: { frontStoreWrite: 0, exitedUnexpectedly: 0 },
  traces: [],
  ...over,
});
const status = (checks: ReturnType<typeof frontSteadyChecks>, id: string) => checks.find((check) => check.id === id);

describe('front steadiness', () => {
  test('a front that keeps one process and logs no crash passes, on a store set with every lane it needs', () => {
    const checks = frontSteadyChecks(steady());
    expect(checks.map((check) => [check.id, check.status])).toEqual([['front.store-set', 'pass'], ['front.steady', 'pass']]);
  });

  test('the rc.4 front fails: it answered ready, then crashed and was started again, with front_store_write in the log', () => {
    const samples = [
      ...Array.from({ length: 5 }, () => ({ front: [200], background: [100] })),
      { front: [], background: [100] },
      ...Array.from({ length: 5 }, () => ({ front: [201], background: [100] })),
    ];
    const check = status(frontSteadyChecks(steady({ samples, logHits: { frontStoreWrite: 2, exitedUnexpectedly: 2 } })), 'front.steady')!;
    expect(check.status).toBe('fail');
    expect(check.detail).toContain('2 different front processes');
    expect(check.detail).toContain('no front running in 1 of 11 samples');
    expect(check.detail).toContain('front_store_write 2 time(s)');
  });

  test('the log alone fails it, as does an engine that never came back or a stage that took no sample', () => {
    expect(status(frontSteadyChecks(steady({ logHits: { frontStoreWrite: 1, exitedUnexpectedly: 0 } })), 'front.steady')!.status).toBe('fail');
    expect(status(frontSteadyChecks(steady({ restart: { ok: false, ms: 600_000, detail: 'not ready' } })), 'front.steady')!.status).toBe('fail');
    expect(status(frontSteadyChecks(steady({ samples: [] })), 'front.steady')!.detail).toContain('no process sample');
    expect(frontSteadyChecks(undefined).map((check) => check.status)).toEqual(['fail']);
  });

  test('a store set without Gmail mail or Telegram fails its own check, so a pass is never on an empty machine', () => {
    const lanes = steady().lanes.map((lane) => ({ ...lane, items: 0 }));
    const check = status(frontSteadyChecks(steady({ lanes, telegram: { ok: false, detail: 'no hook' } })), 'front.store-set')!;
    expect(check.status).toBe('fail');
    expect(check.detail).toContain('the Gmail stores hold no mail');
    expect(check.detail).toContain('Telegram was not seeded');
  });

  test('a restart before the background made the extraction job queue proves nothing, so the store set fails', () => {
    const check = status(frontSteadyChecks(steady({ jobQueue: false })), 'front.store-set')!;
    expect(check.status).toBe('fail');
    expect(check.detail).toContain('never made the extraction job queue');
    expect(status(frontSteadyChecks(steady({ jobQueue: true })), 'front.store-set')!.status).toBe('pass');
  });

  test('churn counts distinct processes per role and samples without one', () => {
    expect(frontChurn([{ front: [1], background: [9] }, { front: [], background: [9] }, { front: [2], background: [9] }]))
      .toEqual({ fronts: 2, withoutFront: 1, backgrounds: 1, withoutBackground: 0 });
  });

  test('only the top process of a role counts: a helper that inherits the role\'s environment is not a second front', () => {
    expect(enginePidsIn([
      { pid: 10, ppid: 1, role: undefined },
      { pid: 11, ppid: 10, role: 'background' },
      { pid: 12, ppid: 10, role: 'front' },
      { pid: 13, ppid: 12, role: 'front' },
      { pid: 14, ppid: 11, role: 'background' },
    ])).toEqual({ front: [12], background: [11] });
  });

  test('crash lines are counted, never quoted', () => {
    expect(crashLines('ok\nError [front_store_write]: x\nOlympus front exited unexpectedly.\nError [front_store_write]: y\n'))
      .toEqual({ frontStoreWrite: 2, exitedUnexpectedly: 1, brokenFront: 0 });
  });

  test('the agent\'s status names the archive\'s state', () => {
    expect(archiveStatusOf({ archives: [{ name: 'a.mbox', status: 'imported' }] }, 'a.mbox')).toBe('imported');
    expect(archiveStatusOf({ archives: [] }, 'a.mbox')).toBeUndefined();
  });

  test('the fixture is a Gmail export the import attributes to one account, with an attachment', () => {
    const dir = mkdtempSync(join(tmpdir(), 'front-gmail-'));
    try {
      const text = frontGmailMbox('tok123');
      expect(text).toContain('Content-Disposition: attachment; filename="front-check-notes.txt"');
      writeFileSync(join(dir, 'export.mbox'), text);
      const root = ScopeRoot.open(dir);
      try {
        expect(identifyGmailExport(root, archiveFileEntries(buildArchiveManifest(root, ['export.mbox'])))).toEqual({ kind: 'gmail', address: OWNER_ADDRESS });
      } finally { root.close(); }
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

describe('a browser step after an agent the run lost track of', () => {
  test.skipIf(process.platform !== 'linux')('the earlier agent still holding the bridge port is found by its pid, and nothing else is', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'rc-stale-'));
    const port = 20_000 + Math.floor(Math.random() * 20_000);
    mkdirSync(join(dir, 'rc'));
    writeFileSync(join(dir, 'rc', 'agent.js'), `Bun.listen({ hostname: '127.0.0.1', port: ${port}, socket: { data() {} } }); console.log('up'); setInterval(() => {}, 1000);\n`);
    const child = Bun.spawn([process.execPath, join(dir, 'rc', 'agent.js')], { stdout: 'pipe' });
    try {
      const reader = child.stdout.getReader();
      await reader.read();
      expect(staleAgentOnPort(port)).toBe(child.pid);
      expect(staleAgentOnPort(port + 1)).toBeUndefined();
    } finally { child.kill(); rmSync(dir, { recursive: true, force: true }); }
  }, 30_000);
});
