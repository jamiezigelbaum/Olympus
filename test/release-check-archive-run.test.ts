// OLYMPUS_TEST_LANE: deploy
// The archive-import leg's place in a release-check run (run.ts runArchiveLeg), against a scripted stand-in for a machine: the order
// the in-machine verbs run in, what each is told, that a machine that cannot do any of it fails the run, that the private model is
// switched back on and the machine cleaned up whatever happened, and that the traces come back. What each verb does on a machine is
// tested in release-check-archive-stages.test.ts, on the product's real panel.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { newRunId, runReleaseCheck, type RunConfigFile } from '../scripts/release-check/run.ts';

/** A machine that is just enough of one: the install verbs answer, and each archive verb answers what FAKE_ARCHIVE says. */
const SCRIPTED_DRIVER = String.raw`#!/usr/bin/env bun
import { appendFileSync, copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
const [verb, ...rest] = process.argv.slice(2);
const state = process.env.FAKE_STATE;
const arg = (name) => rest[rest.indexOf(name) + 1];
const say = (value) => console.log(JSON.stringify(value));
appendFileSync(state + '/driver.log', [verb, ...rest].join(' ') + '\n');
if (verb === 'provision') {
  console.log('{"machine":"fake-' + arg('--run-id') + '","label":"Scripted machine","os":"' + (process.env.FAKE_OS ?? 'linux') + '","driver":"fake"}');
} else if (verb === 'get') {
  if (/archive\.tgz$/.test(arg('--from')) && existsSync(state + '/archive.tgz')) copyFileSync(state + '/archive.tgz', arg('--to'));
  else writeFileSync(arg('--to'), 'x');
} else if (verb === 'exec') {
  const script = await new Response(Bun.stdin.stream()).text();
  const call = /agent\.js (.*)/.exec(script)?.[1] ?? '';
  const sub = call.split(' ')[0];
  appendFileSync(state + '/agent.log', call + '\n');
  const life = JSON.parse(readFileSync(state + '/life.json', 'utf8'));
  const counts = { seen: life.seen, indexed: life.stored, contentReady: life.stored, embedded: life.stored, secretsLocated: life.secrets, pending: 0, queueWaiting: 0, queueActive: 0, personal: life.personal, privateItems: life.privateItems };
  const mode = process.env.FAKE_ARCHIVE ?? 'silent';
  if (sub === 'engine-build') say({ ok: true, build: '1.1.0+abc', version: '1.1.0', remoteMode: 'relay', relay: {} });
  else if (sub === 'prepare-source') say({ ok: true, rules: 2, engineReadyMs: 1000 });
  else if (sub === 'connect-source') say({ ok: true, message: 'Connected' });
  else if (sub === 'sync') say({ ok: true, status: 200 });
  else if (sub === 'settle') say({ ok: true, settled: true, polls: 2, waitedMs: 1000, snapshot: counts });
  else if (sub === 'dashboard-json') say({ ok: true, status: 200, body: '{}' });
  else if (sub === 'collect-logs') say({ ok: true, files: [] });
  else if (sub === 'archive-cleanup') say(mode === 'cleanup-fails' ? { ok: false, detail: 'an archive would not go' } : { ok: true, removed: ['left-over.mbox'] });
  else if (sub === 'archive-collect') say(mode === 'collect-fails' ? { ok: false, detail: 'tar failed' } : { ok: true, archive: '/home/test/rc/archive.tgz' });
  else if (sub.startsWith('archive-')) say({ ok: false, detail: 'scripted: ' + sub + ' did nothing' });
  else say({ ok: false, detail: 'scripted machine: unknown ' + sub });
} else if (verb === 'destroy') {
  writeFileSync(state + '/destroyed', '');
}
`;

let dir: string;
let driverPath: string;
let candidateDir: string;
const saved: Record<string, string | undefined> = {};
const ENV_KEYS = ['FAKE_STATE', 'FAKE_ARCHIVE', 'FAKE_OS'];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'rc-archive-run-'));
  driverPath = join(dir, 'driver.ts');
  writeFileSync(driverPath, SCRIPTED_DRIVER);
  chmodSync(driverPath, 0o755);
  candidateDir = join(dir, 'candidate');
  mkdirSync(candidateDir);
  writeFileSync(join(candidateDir, 'olympus-1.1.0.tgz'), 'x');
  writeFileSync(join(dir, 'life.json'), JSON.stringify({ seen: 10, stored: 9, secrets: 1, personal: 4, privateItems: 3 }));
  writeFileSync(join(dir, 'agent.log'), '');
  for (const key of ENV_KEYS) saved[key] = process.env[key];
  process.env.FAKE_STATE = dir;
  delete process.env.FAKE_ARCHIVE;
  delete process.env.FAKE_OS;
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  for (const key of ENV_KEYS) { if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key]; }
});

const agentLog = (): string[] => readFileSync(join(dir, 'agent.log'), 'utf8').split('\n').filter(Boolean);
const archiveCalls = (): string[] => agentLog().filter((line) => line.startsWith('archive-'));
const verbs = (): string[] => archiveCalls().map((line) => line.split(' ')[0]!);

function options(extra: Record<string, unknown> = {}) {
  const runId = newRunId();
  const config: RunConfigFile = { driver: [driverPath], agents: [], settleTimeoutS: 5 };
  return { runId, candidateDir, candidateLabel: 'archive test', outDir: join(dir, 'out', runId), config, skipRelay: true, skipScreenshots: true, skipInbox: true, skipJourneys: true, skipExplore: true, skipSuite: true, ...extra };
}
type Report = Awaited<ReturnType<typeof runReleaseCheck>>;
const checksOf = (report: Report) => report.machines[0]!.checks;
const failedIds = (report: Report): string[] => checksOf(report).filter((c) => c.status === 'fail').map((c) => c.id);

describe('the archive-import leg in a run', () => {
  test('runs after the install checks, in the order the machine needs, and tells each verb what to do', async () => {
    const report = await runReleaseCheck(options());
    expect(verbs()).toEqual(['archive-import', 'archive-import', 'archive-model', 'archive-model', 'archive-remove', 'archive-changed', 'archive-cleanup', 'archive-collect']);
    const [picker, agent, off, on, remove, changed] = archiveCalls();
    // The picker goes first, on an empty list, with the folder reset; the agent path waits for the model to judge, then searches.
    expect(picker).toMatch(/^archive-import --role picker --format mbox --seed \S+ --via picker --reset-folder --clean$/);
    expect(agent).toMatch(/^archive-import --role agent --format mbox --seed \S+ --via request --drain-s \d+ --search$/);
    expect(off).toBe('archive-model --mode off');
    expect(on).toBe('archive-model --mode on');
    expect(remove).toMatch(/^archive-remove --targets '?agent:mbox,picker:mbox,held:mbox'? --seed \S+$/);
    expect(changed).toMatch(/^archive-changed --seed \S+ --sizes \d+(,\d+)*$/);
    // One seed for the whole leg: every archive of the run has its own token and file from it.
    const seeds = new Set(archiveCalls().map((line) => /--seed '?(\w+)'?/.exec(line)?.[1]).filter(Boolean));
    expect(seeds.size).toBe(1);
    expect(report.machines[0]!.checks.some((c) => c.id.startsWith('archive.'))).toBe(true);
  }, 120_000);

  test('a machine that does none of it fails the run on each part, never passing for want of a result', async () => {
    const report = await runReleaseCheck(options());
    expect(report.verdict).toBe('fail');
    const failed = failedIds(report);
    for (const id of ['archive.picker.mbox.ran', 'archive.agent.mbox.ran']) expect(failed).toContain(id);
    // The held archive was not imported because the private model could not be turned off, and said so.
    const held = checksOf(report).find((c) => c.id === 'archive.held.mbox.ran')!;
    expect(held.status).toBe('fail');
    expect(held.detail).toContain('private model could not be turned off');
    // And the restored drain says it did not run, rather than leaving a gap.
    expect(checksOf(report).find((c) => c.id === 'archive.held.mbox.restored.drain')?.status).toBe('fail');
    expect(checksOf(report).filter((c) => c.id.startsWith('archive.') && c.status === 'pass').map((c) => c.id)).toEqual(['archive.cleanup']);
    // The model was asked to go back on after it was asked to go off, the machine was cleaned up, and the run still ended by destroying it.
    expect(archiveCalls().filter((line) => line.startsWith('archive-model'))).toEqual(['archive-model --mode off', 'archive-model --mode on']);
    expect(verbs().slice(-2)).toEqual(['archive-cleanup', 'archive-collect']);
    expect(existsSync(join(dir, 'destroyed'))).toBe(true);
  }, 120_000);

  test('a cleanup that leaves an archive behind fails the run', async () => {
    process.env.FAKE_ARCHIVE = 'cleanup-fails';
    const report = await runReleaseCheck(options());
    const cleanup = checksOf(report).find((c) => c.id === 'archive.cleanup')!;
    expect(cleanup.status).toBe('fail');
    expect(cleanup.detail).toContain('an archive would not go');
  }, 120_000);

  test('traces that cannot be brought back fail the run on archive.fetch', async () => {
    process.env.FAKE_ARCHIVE = 'collect-fails';
    const report = await runReleaseCheck(options());
    const fetched = checksOf(report).find((c) => c.id === 'archive.fetch')!;
    expect(fetched.status).toBe('fail');
    expect(fetched.detail).toContain('tar failed');
  }, 120_000);

  test('the traces the machine packed are in the run folder', async () => {
    const pack = join(dir, 'pack');
    mkdirSync(join(pack, 'traces'), { recursive: true });
    writeFileSync(join(pack, 'traces', 'archive-agent-approve.json'), '{"id":"archive-agent-approve"}');
    expect(spawnSync('tar', ['-czf', join(dir, 'archive.tgz'), '-C', pack, 'traces']).status).toBe(0);
    const opts = options();
    const report = await runReleaseCheck(opts);
    expect(checksOf(report).some((c) => c.id === 'archive.fetch')).toBe(false);
    expect(readFileSync(join(opts.outDir, 'traces', 'archive-agent-approve.json'), 'utf8')).toContain('archive-agent-approve');
  }, 120_000);

  test('--skip-archive leaves the leg out: no archive verb is called, nothing is checked', async () => {
    const report = await runReleaseCheck(options({ skipArchive: true }));
    expect(archiveCalls()).toEqual([]);
    expect(checksOf(report).some((c) => c.id.startsWith('archive.'))).toBe(false);
  }, 120_000);
});
