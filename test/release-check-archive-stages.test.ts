// The archive-import leg's in-machine stages (scripts/release-check/archive-stages.ts), run against a stand-in machine and the product's
// real dashboard panel in a DOM. The stand-in keeps one consistent world: the agent's CLI, the panel's tool calls, the stores, the engine
// restart and the private model all read and change the same archives, so a stage is walked the way it runs on a VM, and its observation is
// then judged by the leg's own evaluators (archive-leg.ts). Faults are made in the world (an import that never settles, a removal that
// leaves content, a connection that left the machine, an engine that does not come back) and must fail the check that guards them.
// Not covered here, and only a VM run shows: Chrome and its real presses, the engine and its models, the real stores, the real CLI.

import { afterEach, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import {
  ARCHIVE_APPROVE_TOOL_NAME,
  ARCHIVE_BROWSE_TOOL_NAME,
  ARCHIVE_REMOVE_TOOL_NAME,
  DASHBOARD_TOOL_NAME,
  type ComputerArchiveEntry,
  type ComputerArchivesMeta,
} from '../src/workers/chatgpt/dashboard-contract.ts';
import { archivesOpenTarget, createArchiveImportAgent } from '../src/workers/archive-import/agent.ts';
import { FIXTURE_FOLDER, legFixture, writeFixture, type LegFixture } from '../scripts/release-check/archive-fixtures.ts';
import {
  changedChecks, drainChecks, heldOffChecks, importChecks, modelChecks, removeChecks, searchChecks, shownPath,
  type StoreView,
} from '../scripts/release-check/archive-leg.ts';
import {
  SNIFFER_ENABLED_KEY, changedStage, drainStage, envWith, importStage, modelStage, removeAllStage, removeStage,
  type ArchiveBrowserSession, type ArchiveHost,
} from '../scripts/release-check/archive-stages.ts';
import type { CheckResult } from '../scripts/release-check/report.ts';
import { PanelDriver, browseFixtures, closeWindows, dashboardAnswer, entryFor, mountPanel, settle } from './helpers/release-check-panel.ts';

// Each stage walks several journeys in real time (the runner looks again every 0.4 s), so a test takes seconds on a loaded runner.
setDefaultTimeout(60_000);

const cleanups: Array<() => void> = [];
afterEach(async () => {
  await closeWindows();
  while (cleanups.length) cleanups.pop()!();
});

const SEED = 'seed-stages';
const failing = (checks: readonly CheckResult[]) => checks.filter((check) => check.status === 'fail').map((check) => check.id);
const TOKEN_IN_QUESTION = /rcarch[0-9a-f]{14}/;

interface World {
  /** Faults and shapes the world can take. */
  settle: 'at-once' | 'never';
  /** A large archive finishes before the file is changed, up to this many messages. */
  finishesFirstUpTo: number;
  removalLeavesContent: boolean;
  egressFresh: string[];
  engineFails: boolean;
  /** The Remove tool answers and nothing is removed: the row stays on the page. */
  removeIgnored: boolean;
  /** The page's probe throws, as a page that is gone or not yet loaded does. */
  panelUnreadable: boolean;
  /** The page shows the archive gone but the engine still lists it. */
  engineKeepsRemoved: boolean;
}

/** A stand-in machine: the product's state, the agent's CLI over it, the stores, the engine restart, the private model. */
class FakeMachine implements ArchiveHost {
  readonly os = 'linux' as const;
  readonly home = mkdtempSync(join(tmpdir(), 'archive-stages-home-'));
  readonly workDir = mkdtempSync(join(tmpdir(), 'archive-stages-work-'));
  readonly workerEnvPath = join(this.workDir, 'worker.env');
  readonly lines: string[] = [];
  readonly restarts: Array<{ env: string | null }> = [];
  readonly fixtures = new Map<string, LegFixture>();
  archives: ComputerArchiveEntry[] = [];
  requests: ComputerArchivesMeta['requests'] = [];
  privateModel: 'ready' | 'off' = 'ready';
  world: World = { settle: 'at-once', finishesFirstUpTo: 0, removalLeavesContent: false, egressFresh: [], engineFails: false, removeIgnored: false, panelUnreadable: false, engineKeepsRemoved: false };
  /** Archives the engine still lists after the page lost them. */
  ghosts: ComputerArchiveEntry[] = [];
  private clock = 0;
  private nextRequest = 1;
  private readonly initialSize = new Map<string, number>();
  private readonly contentKept = new Set<string>();
  searches = 0;
  /** The family and provider each store read asked for, with the word it looked for: an archive is read in its own format's stores. */
  readonly storeReads: Array<{ family: string; provider: string; token: string }> = [];

  constructor() {
    cleanups.push(() => { rmSync(this.home, { recursive: true, force: true }); rmSync(this.workDir, { recursive: true, force: true }); });
  }

  know(...fixtures: LegFixture[]): void { for (const fx of fixtures) this.fixtures.set(fx.fileName, fx); }
  fixtureOf(entry: ComputerArchiveEntry): LegFixture { return this.fixtures.get(entry.name)!; }

  say = (line: string): void => { this.lines.push(line); };
  sleep = async (ms: number): Promise<void> => { this.clock += ms; await settle(0); };
  now = (): number => this.clock;

  /** Background work between looks: the private model judges what is held, an import settles, a changed file stops one. */
  private tick(): void {
    this.archives = this.archives.map((entry) => {
      const fx = this.fixtureOf(entry);
      if (entry.status === 'importing') {
        const path = join(this.home, FIXTURE_FOLDER, entry.name);
        const changed = existsSync(path) && statSync(path).size !== this.initialSize.get(entry.name);
        if (changed) return { ...entry, status: 'stopped', stop: { code: 'file_changed', file: entry.name } };
        if (this.world.settle === 'at-once' && fx.expect.messages <= this.world.finishesFirstUpTo) return this.settled(fx, entry);
        return entry;
      }
      if (entry.status === 'imported' && entry.held > 0 && this.privateModel === 'ready') {
        const judging = Math.min(entry.held, 2);
        return { ...entry, judged: entry.judged + judging, held: entry.held - judging };
      }
      return entry;
    });
  }

  private settled(fx: LegFixture, over: Partial<ComputerArchiveEntry> = {}): ComputerArchiveEntry {
    const ready = this.privateModel === 'ready';
    const { percent: _percent, ...rest } = entryFor(fx, over);
    return { ...rest, status: 'imported', judged: ready ? fx.expect.messages : 0, held: ready ? 0 : fx.expect.messages };
  }

  private meta(): ComputerArchivesMeta {
    return { sourceId: 'archive.imports', archives: this.archives, requests: this.requests, privateModel: this.privateModel };
  }

  /** What the agent's status reads: the page's list, and the archives the engine still holds that the page lost. */
  private statusMeta(): ComputerArchivesMeta {
    return { ...this.meta(), archives: [...this.archives, ...this.ghosts] };
  }

  cli(args: string[]) {
    if (args[0] === 'start') {
      const path = args[2] ?? '';
      if (!existsSync(path)) return { code: 1, json: { ok: false, code: 'invalid_path' }, stderr: '' };
      const id = `req-${this.nextRequest++}`;
      this.requests = [...this.requests, { id, name: basename(path), where: `~/${FIXTURE_FOLDER}`, path: shownPath(this.home, path), origin: 'agent', status: 'pending' }];
      return { code: 1, json: { ok: false, code: 'needs_approval', request_id: id, message: 'Waiting for the owner.', open: archivesOpenTarget() }, stderr: '' };
    }
    if (args[0] === 'status') {
      this.tick();
      const json = createArchiveImportAgent({ state: {} as never, requests: {} as never, view: () => this.statusMeta() }).status();
      return { code: 0, json, stderr: '' };
    }
    return { code: 2, json: undefined, stderr: 'usage' };
  }

  async withBrowser<T>(work: (session: ArchiveBrowserSession) => Promise<T>): Promise<T> {
    const world = this.world;
    class Driver extends PanelDriver {
      override async probe(frame: 'host' | 'panel', call: string): Promise<unknown> {
        if (world.panelUnreadable) throw new Error('the page is not there');
        return super.probe(frame, call);
      }
    }
    const driver = new Driver(async () => (await mountPanel(this.serve())).win);
    await driver.go();
    return await work({ driver, pid: undefined, requests: [] });
  }

  private serve() {
    return {
      [DASHBOARD_TOOL_NAME]: () => { this.tick(); return dashboardAnswer(this.archives, this.requests, this.privateModel); },
      [ARCHIVE_BROWSE_TOOL_NAME]: (args: { parent_key?: unknown }) => browseFixtures([...this.fixtures.keys()])(args),
      [ARCHIVE_APPROVE_TOOL_NAME]: (args: { request_id?: string; key?: string }) => {
        const name = args.request_id ? this.requests.find((request) => request.id === args.request_id)?.name : basename(args.key ?? '');
        const fx = name ? this.fixtures.get(name) : undefined;
        if (!fx) return { content: [{ type: 'text', text: 'No.' }], structuredContent: { error: 'unsupported' }, isError: true };
        this.requests = this.requests.filter((request) => request.id !== args.request_id);
        const path = join(this.home, FIXTURE_FOLDER, fx.fileName);
        this.initialSize.set(fx.fileName, existsSync(path) ? statSync(path).size : 0);
        const started = entryFor(fx, { status: 'importing', percent: 5, items: 10, judged: 0, held: 10 });
        const { importedAt: _importedAt, ...importing } = started;
        this.archives = [...this.archives, this.world.settle === 'at-once' && fx.expect.messages <= 100 ? this.settled(fx) : importing];
        return { content: [{ type: 'text', text: 'Importing.' }], structuredContent: { status: 'started', name: fx.fileName } };
      },
      [ARCHIVE_REMOVE_TOOL_NAME]: (args: { archive_id: string }) => {
        const gone = this.archives.find((entry) => entry.id === args.archive_id);
        if (this.world.removeIgnored) return { content: [{ type: 'text', text: 'Removing.' }], structuredContent: { ok: true } };
        if (gone && this.world.engineKeepsRemoved) this.ghosts.push(gone);
        this.archives = this.archives.filter((entry) => entry.id !== args.archive_id);
        if (gone && this.world.removalLeavesContent) this.contentKept.add(gone.name);
        return { content: [{ type: 'text', text: 'Removing.' }], structuredContent: { ok: true } };
      },
    };
  }

  async watchEgress() {
    return { stop: () => ({ samples: 40, intervalMs: 150, baseline: 2, fresh: this.world.egressFresh }) };
  }

  async search(question: string) {
    this.searches += 1;
    const token = TOKEN_IN_QUESTION.exec(question)?.[0];
    const hits = this.archives.filter((entry) => entry.status === 'imported' && entry.held === 0 && this.fixtureOf(entry)?.token === token);
    return { ok: true, isError: false, structured: { evidence: hits.map((entry) => ({ id: 'E1', source: this.fixtureOf(entry).expect.citationLabel, title: 'A note', excerpt: `the reference word ${token}` })) } };
  }

  /** The three stores by what the private model has cleared: held messages sit in Private, judged ones in Personal. */
  readStores(spec: { family: string; provider: string }, archiveId: string | undefined, token: string): StoreView[] {
    this.storeReads.push({ family: spec.family, provider: spec.provider, token });
    const entry = this.archives.find((candidate) => this.fixtureOf(candidate)?.token === token);
    const kept = [...this.contentKept].some((name) => this.fixtures.get(name)?.token === token);
    if (!entry) return ['private', 'personal', 'public'].map((tier) => ({ tier: tier as StoreView['tier'], exists: true, live: 0, tokenRows: tier === 'personal' && kept ? 2 : 0 }));
    void archiveId;
    return [
      { tier: 'private', exists: true, live: entry.held, tokenRows: entry.held > 0 ? 2 : 0 },
      { tier: 'personal', exists: true, live: entry.judged, tokenRows: entry.judged > 0 ? 2 : 0 },
      { tier: 'public', exists: true, live: 0, tokenRows: 0 },
    ];
  }

  async restartEngine(_timeoutMs: number) {
    const env = existsSync(this.workerEnvPath) ? readFileSync(this.workerEnvPath, 'utf8') : null;
    this.restarts.push({ env });
    if (this.world.engineFails) return { ok: false, ms: 420_000, detail: 'the engine was not ready (models included) within 420 s' };
    this.privateModel = env !== null && new RegExp(`^${SNIFFER_ENABLED_KEY}=0$`, 'm').test(env) ? 'off' : 'ready';
    return { ok: true, ms: 90_000 };
  }
}

/** A machine that knows these archives: a role is the mbox of that role, `role:format` is that role's archive in another format (keyed `role-format`). */
const machine = (...kinds: string[]): { machine: FakeMachine; fx: Record<string, LegFixture> } => {
  const fake = new FakeMachine();
  const fx = Object.fromEntries(kinds.map((kind) => {
    const [role, format] = kind.split(':') as [Parameters<typeof legFixture>[0], string | undefined];
    return [format ? `${role}-${format}` : role, format ? legFixture(role, SEED, format) : legFixture(role, SEED)];
  }));
  fake.know(...Object.values(fx));
  return { machine: fake, fx };
};

describe('the environment setting that switches the private model', () => {
  test('envWith sets or removes one key and leaves every other line as it was', () => {
    expect(envWith('A=1\nB=2\n', 'C', '3')).toBe('A=1\nB=2\nC=3\n');
    expect(envWith('A=1\nC=9\nB=2\n', 'C', '0')).toBe('A=1\nB=2\nC=0\n');
    expect(envWith('A=1\nC=0\nB=2\n', 'C', null)).toBe('A=1\nB=2\n');
    expect(envWith('', 'C', null)).toBe('');
    expect(envWith('C=1\n', 'C', null)).toBe('');
    // A key that only starts with the same letters is another key.
    expect(envWith('CC=1\n', 'C', '2')).toBe('CC=1\nC=2\n');
  });
});

describe('the private model, off and back on', () => {
  test('off writes the setting and restarts the engine; on puts the file back exactly, whatever it held', async () => {
    const { machine: fake } = machine();
    const original = 'OLYMPUS_SOMETHING=1\nOLYMPUS_OTHER=two\n';
    writeFileSync(fake.workerEnvPath, original);
    const off = await modelStage(fake, 'off');
    expect(off).toMatchObject({ ok: true, mode: 'off', privateModel: 'off', readyMs: 90_000 });
    expect(readFileSync(fake.workerEnvPath, 'utf8')).toBe(`${original}${SNIFFER_ENABLED_KEY}=0\n`);
    expect(failing(modelChecks(off, 'off'))).toEqual([]);
    const on = await modelStage(fake, 'on');
    expect(on).toMatchObject({ ok: true, mode: 'on', privateModel: 'ready' });
    expect(readFileSync(fake.workerEnvPath, 'utf8')).toBe(original);
    expect(failing(modelChecks(on, 'on'))).toEqual([]);
    expect(fake.restarts.map((restart) => restart.env?.includes(`${SNIFFER_ENABLED_KEY}=0`))).toEqual([true, false]);
    // The saved copy is gone: the next off starts from the file as it is.
    expect(existsSync(join(fake.workDir, 'worker.env.before-archive.json'))).toBe(false);
  });

  test('a machine with no settings file gets one for the test and none after; a key that was already there comes back', async () => {
    const { machine: bare } = machine();
    expect((await modelStage(bare, 'off')).ok).toBe(true);
    expect(existsSync(bare.workerEnvPath)).toBe(true);
    expect((await modelStage(bare, 'on')).ok).toBe(true);
    expect(existsSync(bare.workerEnvPath)).toBe(false);

    const { machine: preset } = machine();
    writeFileSync(preset.workerEnvPath, `${SNIFFER_ENABLED_KEY}=1\nOTHER=1\n`);
    await modelStage(preset, 'off');
    expect(readFileSync(preset.workerEnvPath, 'utf8')).toBe(`OTHER=1\n${SNIFFER_ENABLED_KEY}=0\n`);
    await modelStage(preset, 'on');
    expect(readFileSync(preset.workerEnvPath, 'utf8')).toBe(`${SNIFFER_ENABLED_KEY}=1\nOTHER=1\n`);
  });

  test('turning it off twice keeps the first copy as the original', async () => {
    const { machine: fake } = machine();
    writeFileSync(fake.workerEnvPath, 'ORIGINAL=1\n');
    await modelStage(fake, 'off');
    await modelStage(fake, 'off');
    await modelStage(fake, 'on');
    expect(readFileSync(fake.workerEnvPath, 'utf8')).toBe('ORIGINAL=1\n');
  });

  test('on with nothing saved removes a leftover setting; with none there it changes nothing and does not restart', async () => {
    const { machine: stray } = machine();
    writeFileSync(stray.workerEnvPath, `A=1\n${SNIFFER_ENABLED_KEY}=0\n`);
    const fixed = await modelStage(stray, 'on');
    expect(fixed.ok).toBe(true);
    expect(readFileSync(stray.workerEnvPath, 'utf8')).toBe('A=1\n');
    const { machine: clean } = machine();
    writeFileSync(clean.workerEnvPath, 'A=1\n');
    const nothing = await modelStage(clean, 'on');
    expect(nothing).toMatchObject({ ok: true, unchanged: true });
    expect(clean.restarts).toEqual([]);
  });

  test('an engine that does not come back fails the check with the machine\'s reason, and on still puts the file back', async () => {
    const { machine: fake } = machine();
    writeFileSync(fake.workerEnvPath, 'A=1\n');
    fake.world.engineFails = true;
    const off = await modelStage(fake, 'off');
    expect(off.ok).toBe(false);
    expect(failing(modelChecks(off, 'off'))).toEqual(['archive.model-off']);
    expect(modelChecks(off, 'off')[0]!.detail).toContain('420 s');
    fake.world.engineFails = false;
    expect((await modelStage(fake, 'on')).ok).toBe(true);
    expect(readFileSync(fake.workerEnvPath, 'utf8')).toBe('A=1\n');
  });
});

describe('importing an archive', () => {
  test('the agent path: a request, the owner\'s press, the row settles, the held messages drain, a search is cited', async () => {
    const { machine: fake, fx } = machine('agent');
    const agent = fx.agent!;
    const observation = await importStage(fake, { role: 'agent', format: 'mbox', via: 'request', seed: SEED, resetFolder: true, drainS: 900, search: true, settleS: 5, startS: 5 });
    expect(observation.ok).toBe(true);
    expect(observation.start).toMatchObject({ code: 'needs_approval', hasOpenTarget: true, carriesContent: false });
    expect(observation.waiting!.requestStates).toEqual(['waiting_for_approval']);
    expect(observation.waiting!.archives).toEqual([]);
    expect(observation.settled).toBe(true);
    expect(observation.archiveId).toBeDefined();
    expect(observation.drain).toMatchObject({ drained: true });
    expect(observation.search!.evidence).toEqual([{ source: 'Imported mail', hasToken: true }]);
    // The fixture was written where the stage said, owner-only, and the product was asked about that path.
    expect(existsSync(join(fake.home, FIXTURE_FOLDER, agent.fileName))).toBe(true);
    const checks = importChecks(observation, agent, 'linux');
    expect(failing(checks)).toEqual([]);
  });

  test('the Telegram archive by the agent path: the same request, press, settle and drain, and the search is cited "Telegram"', async () => {
    const { machine: fake, fx } = machine('agent:telegram_json');
    const chat = fx['agent-telegram_json']!;
    const observation = await importStage(fake, { role: 'agent', format: 'telegram_json', via: 'request', seed: SEED, resetFolder: true, drainS: 900, search: true, settleS: 5, startS: 5 });
    expect(observation.ok).toBe(true);
    expect(observation.start).toMatchObject({ code: 'needs_approval', hasOpenTarget: true, carriesContent: false });
    expect(observation.settled).toBe(true);
    expect(observation.drain).toMatchObject({ drained: true });
    expect(observation.search!.evidence).toEqual([{ source: 'Telegram', hasToken: true }]);
    // The file the product was asked about is the Telegram one, written owner-only under the fixtures folder.
    expect(existsSync(join(fake.home, FIXTURE_FOLDER, 'rc-agent-telegram_json.json'))).toBe(true);
    expect(chat.format).toBe('telegram_json');
    expect(failing(importChecks(observation, chat, 'linux'))).toEqual([]);
    // A search that cites the wrong source fails this archive's check, whatever the other formats call themselves.
    const wrong = { ...observation, search: { ...observation.search!, evidence: [{ source: 'Imported mail', hasToken: true }] } };
    expect(failing(importChecks(wrong, chat, 'linux'))).toContain('archive.agent.telegram_json.search');
  });

  test('the notes archives by the agent path: the same request, press, settle and drain, the search cited by each export\'s own name, and read in the notes stores', async () => {
    for (const [format, citation, provider, fileName] of [
      ['reflect-json', 'Reflect', 'reflect', 'rc-agent-reflect-json.json'],
      ['roam-json', 'Roam', 'roam', 'rc-agent-roam-json.zip'],
    ] as const) {
      const { machine: fake, fx } = machine(`agent:${format}`);
      const notes = fx[`agent-${format}`]!;
      const observation = await importStage(fake, { role: 'agent', format, via: 'request', seed: SEED, resetFolder: true, drainS: 900, search: true, settleS: 5, startS: 5 });
      expect(observation.ok).toBe(true);
      expect(observation.start).toMatchObject({ code: 'needs_approval', hasOpenTarget: true, carriesContent: false });
      expect(observation.settled).toBe(true);
      expect(observation.drain).toMatchObject({ drained: true });
      expect(observation.search!.evidence).toEqual([{ source: citation, hasToken: true }]);
      expect(existsSync(join(fake.home, FIXTURE_FOLDER, fileName))).toBe(true);
      expect(fake.storeReads.length).toBeGreaterThan(0);
      expect(fake.storeReads.every((read) => read.family === 'note' && read.provider === provider && read.token === notes.token)).toBe(true);
      expect(failing(importChecks(observation, notes, 'linux'))).toEqual([]);
      // A search that cites another source fails this archive's check, whatever the other formats call themselves.
      const wrong = { ...observation, search: { ...observation.search!, evidence: [{ source: 'Imported mail', hasToken: true }] } };
      expect(failing(importChecks(wrong, notes, 'linux'))).toContain(`archive.agent.${format}.search`);
    }
  });

  test('the picker path needs an empty Archives line: a leftover from an earlier attempt is removed first', async () => {
    const { machine: fake, fx } = machine('picker');
    const leftover = legFixture('agent', 'an-earlier-seed');
    fake.know(leftover);
    fake.archives = [entryFor(leftover)];
    const observation = await importStage(fake, { role: 'picker', format: 'mbox', via: 'picker', seed: SEED, resetFolder: true, clean: true, settleS: 5, startS: 5 });
    expect(observation.ok).toBe(true);
    expect(fake.archives.map((entry) => entry.name)).toEqual([fx.picker!.fileName]);
    expect(fake.lines.some((line) => line.includes('removing leftover archive'))).toBe(true);
    expect(failing(importChecks(observation, fx.picker!, 'linux'))).toEqual([]);
  });

  test('a leftover that cannot be removed stops the picker import with the reason, rather than pressing a button that is not there', async () => {
    const { machine: fake } = machine('picker');
    const leftover = legFixture('agent', 'an-earlier-seed');
    fake.know(leftover);
    fake.archives = [entryFor(leftover)];
    fake.world.removeIgnored = true;
    const observation = await importStage(fake, { role: 'picker', format: 'mbox', via: 'picker', seed: SEED, resetFolder: true, clean: true, settleS: 2, startS: 2, openS: 2, removeS: 2 });
    expect(observation.ok).toBe(false);
    expect(observation.detail).toContain('archives an earlier attempt left could not be removed');
    expect(observation.detail).toContain(leftover.fileName);
    expect(observation.traces).toEqual([]);
    expect(failing(importChecks(observation, legFixture('picker', SEED), 'linux'))).toEqual(['archive.picker.mbox.ran']);
  });

  test('an import that never settles is reported by the journey and the imported check, not hidden', async () => {
    const { machine: fake, fx } = machine('agent');
    fake.world.settle = 'never';
    const observation = await importStage(fake, { role: 'agent', format: 'mbox', via: 'request', seed: SEED, resetFolder: true, settleS: 1, startS: 3 });
    expect(observation.ok).toBe(true);
    expect(observation.settled).toBe(false);
    expect(failing(importChecks(observation, fx.agent!, 'linux'))).toEqual(expect.arrayContaining(['journey.archive-agent-mbox-import', 'archive.agent.mbox.imported']));
  });

  test('a start the product refuses stops the request check, with the code it answered', async () => {
    const { machine: fake, fx } = machine('agent');
    fake.cli = () => ({ code: 1, json: { ok: false, code: 'invalid_path' }, stderr: '' });
    const observation = await importStage(fake, { role: 'agent', format: 'mbox', via: 'request', seed: SEED, resetFolder: true, settleS: 1, startS: 1, openS: 2 });
    const requested = importChecks(observation, fx.agent!, 'linux').find((check) => check.id === 'archive.agent.mbox.requested')!;
    expect(requested.status).toBe('fail');
    expect(requested.detail).toContain('invalid_path');
  });
});

describe('importing with the private model off', () => {
  test('held Private, nothing lower, nothing found, nothing sent; back on, it drains and a search is cited', async () => {
    const { machine: fake, fx } = machine('held');
    const held = fx.held!;
    expect((await modelStage(fake, 'off')).ok).toBe(true);
    const observation = await importStage(fake, { role: 'held', format: 'mbox', via: 'request', seed: SEED, resetFolder: true, search: true, watchEgress: true, settleS: 5, startS: 5 });
    expect(observation.ok).toBe(true);
    expect(observation.egress).toMatchObject({ samples: 40, fresh: [], pageRequests: 0, pageOutside: [] });
    expect(observation.stores.find((store) => store.tier === 'private')!.tokenRows).toBeGreaterThan(0);
    expect(observation.stores.filter((store) => store.tier !== 'private').map((store) => store.tokenRows)).toEqual([0, 0]);
    expect(failing(heldOffChecks(observation, held))).toEqual([]);

    expect((await modelStage(fake, 'on')).ok).toBe(true);
    const drained = await drainStage(fake, { role: 'held', format: 'mbox', seed: SEED, os: 'linux', search: true });
    expect(drained.ok).toBe(true);
    expect(drained.drain).toMatchObject({ drained: true, boundMs: 1_500_000 });
    expect(failing([...drainChecks('archive.held.mbox.restored.drain', drained.drain, held, 'linux', 'restored'), ...searchChecks('archive.held.mbox.restored', drained.search, held, 'cited')])).toEqual([]);
  });

  test('a connection that left the machine fails the stays-here check', async () => {
    const { machine: fake, fx } = machine('held');
    await modelStage(fake, 'off');
    fake.world.egressFresh = ['203.0.113.7:443'];
    const observation = await importStage(fake, { role: 'held', format: 'mbox', via: 'request', seed: SEED, resetFolder: true, search: true, watchEgress: true, settleS: 5, startS: 5 });
    expect(failing(heldOffChecks(observation, fx.held!))).toEqual(['archive.held.mbox.stays-here']);
  });

  test('content in the lower stores while the model is off fails the stores check', async () => {
    const { machine: fake, fx } = machine('held');
    await modelStage(fake, 'off');
    const stores = fake.readStores.bind(fake);
    fake.readStores = (spec, archiveId, token) => stores(spec, archiveId, token).map((store) => (store.tier === 'personal' ? { ...store, tokenRows: 1 } : store));
    const observation = await importStage(fake, { role: 'held', format: 'mbox', via: 'request', seed: SEED, resetFolder: true, search: true, watchEgress: true, settleS: 5, startS: 5 });
    expect(failing(heldOffChecks(observation, fx.held!))).toEqual(['archive.held.mbox.stores']);
  });

  test('a drain that never finishes within its bound fails with the count still waiting', async () => {
    const { machine: fake, fx } = machine('held');
    await modelStage(fake, 'off');
    await importStage(fake, { role: 'held', format: 'mbox', via: 'request', seed: SEED, resetFolder: true, settleS: 5, startS: 5 });
    // The model comes back on, but the engine never judges anything.
    fake.privateModel = 'off';
    const stuck = await drainStage(fake, { role: 'held', format: 'mbox', seed: SEED, os: 'macos', boundS: 60 });
    expect(stuck.drain).toMatchObject({ drained: false });
    const checks = drainChecks('d', stuck.drain, fx.held!, 'macos', 'restored');
    expect(failing(checks)).toEqual(['d']);
    expect(checks[0]!.detail).toContain('still waiting');
  });
});

describe('Remove', () => {
  async function importedThree() {
    const { machine: fake, fx } = machine('agent', 'picker', 'held');
    await importStage(fake, { role: 'picker', format: 'mbox', via: 'picker', seed: SEED, resetFolder: true, clean: true, settleS: 5, startS: 5 });
    await importStage(fake, { role: 'agent', format: 'mbox', via: 'request', seed: SEED, settleS: 5, startS: 5 });
    await importStage(fake, { role: 'held', format: 'mbox', via: 'request', seed: SEED, settleS: 5, startS: 5 });
    return { fake, fx };
  }
  const targets = (fx: Record<string, LegFixture>) => ['agent', 'picker', 'held'].map((role) => ({ role: fx[role]!.role, format: 'mbox', fileName: fx[role]!.fileName, token: fx[role]!.token }));

  test('each archive is removed from its row and only that one: counts reach zero, the others keep their content', async () => {
    const { fake, fx } = await importedThree();
    expect(fake.archives).toHaveLength(3);
    const observation = await removeStage(fake, { targets: targets(fx), removeS: 5 });
    expect(observation.ok).toBe(true);
    expect(fake.archives).toEqual([]);
    expect(observation.removals.map((removal) => removal.role)).toEqual(['agent', 'picker', 'held']);
    expect(observation.removals.every((removal) => removal.gone && removal.unlisted)).toBe(true);
    // The first removal saw the other two still holding theirs.
    expect(observation.removals[0]!.others.map((other) => other.fileName)).toEqual([fx.picker!.fileName, fx.held!.fileName]);
    expect(observation.removals[0]!.others.every((other) => other.stores.some((store) => store.tokenRows > 0))).toBe(true);
    expect(failing(removeChecks(observation, Object.values(fx)))).toEqual([]);
  });

  test('with a Telegram archive among the mail ones, each is removed alone, the others are read in their own format\'s stores, and the checks pass for all', async () => {
    const { machine: fake, fx } = machine('agent', 'agent:telegram_json', 'picker', 'held');
    await importStage(fake, { role: 'picker', format: 'mbox', via: 'picker', seed: SEED, resetFolder: true, clean: true, settleS: 5, startS: 5 });
    await importStage(fake, { role: 'agent', format: 'mbox', via: 'request', seed: SEED, settleS: 5, startS: 5 });
    await importStage(fake, { role: 'agent', format: 'telegram_json', via: 'request', seed: SEED, settleS: 5, startS: 5 });
    await importStage(fake, { role: 'held', format: 'mbox', via: 'request', seed: SEED, settleS: 5, startS: 5 });
    expect(fake.archives).toHaveLength(4);
    const chat = fx['agent-telegram_json']!;
    const all = [fx.agent!, chat, fx.picker!, fx.held!];
    const targets = all.map((one) => ({ role: one.role, format: one.format, fileName: one.fileName, token: one.token }));
    fake.storeReads.length = 0;
    const observation = await removeStage(fake, { targets, removeS: 5 });
    expect(observation.ok).toBe(true);
    expect(fake.archives).toEqual([]);
    expect(observation.removals.map((removal) => `${removal.role}:${removal.format}`)).toEqual(['agent:mbox', 'agent:telegram_json', 'picker:mbox', 'held:mbox']);
    expect(observation.removals.every((removal) => removal.gone && removal.unlisted)).toBe(true);
    // While the mail archive was removed, the Telegram one still held its content, and was read as a chat archive; the mail ones as mail.
    const first = observation.removals[0]!;
    expect(first.others.map((other) => `${other.role}:${other.format}`)).toEqual(['agent:telegram_json', 'picker:mbox', 'held:mbox']);
    expect(first.others.every((other) => other.stores.some((store) => store.tokenRows > 0))).toBe(true);
    const reads = (token: string) => fake.storeReads.filter((read) => read.token === token);
    expect(reads(chat.token).length).toBeGreaterThan(0);
    for (const read of reads(chat.token)) expect(read).toMatchObject({ family: 'chat', provider: 'telegram_export' });
    for (const read of reads(fx.agent!.token)) expect(read).toMatchObject({ family: 'email' });
    // The Telegram archive's own removal is judged under its own key.
    expect(failing(removeChecks(observation, all))).toEqual([]);
    expect(removeChecks(observation, all).map((check) => check.id)).toContain('archive.agent.telegram_json.removed');
  });

  test('a Telegram removal that leaves its content behind fails that archive\'s removed check and none of the mail ones', async () => {
    const { machine: fake, fx } = machine('agent', 'agent:telegram_json');
    await importStage(fake, { role: 'agent', format: 'mbox', via: 'request', seed: SEED, resetFolder: true, settleS: 5, startS: 5 });
    await importStage(fake, { role: 'agent', format: 'telegram_json', via: 'request', seed: SEED, settleS: 5, startS: 5 });
    const chat = fx['agent-telegram_json']!;
    const targets = [fx.agent!, chat].map((one) => ({ role: one.role, format: one.format, fileName: one.fileName, token: one.token }));
    fake.world.removalLeavesContent = true;
    const observation = await removeStage(fake, { targets: targets.slice(1), removeS: 5 });
    expect(failing(removeChecks(observation, [chat]))).toEqual(['archive.agent.telegram_json.removed']);
  });

  test('a removal that leaves content behind fails the removed check for that archive', async () => {
    const { fake, fx } = await importedThree();
    fake.world.removalLeavesContent = true;
    const observation = await removeStage(fake, { targets: targets(fx).slice(0, 1), removeS: 5 });
    expect(failing(removeChecks(observation, [fx.agent!]))).toEqual(['archive.agent.mbox.removed']);
  });

  test('cleaning up removes whatever archives are left, and says which', async () => {
    const { fake } = await importedThree();
    const cleaned = await removeAllStage(fake);
    expect(cleaned.ok).toBe(true);
    expect(cleaned.removed).toHaveLength(3);
    expect(cleaned.failed).toEqual([]);
    expect(cleaned.remaining).toEqual([]);
    expect(fake.archives).toEqual([]);
    expect(await removeAllStage(fake)).toMatchObject({ ok: true, removed: [] });
  });

  test('cleaning up when a removal does not take the archive off the page is not ok: the archive is named as failed and as still listed', async () => {
    const { fake } = await importedThree();
    fake.world.removeIgnored = true;
    const cleaned = await removeAllStage(fake, { removeS: 2, openS: 2, verifyS: 6 });
    expect(cleaned.ok).toBe(false);
    expect(cleaned.removed).toEqual([]);
    expect(cleaned.failed).toHaveLength(3);
    expect(cleaned.remaining).toHaveLength(3);
    expect(cleaned.detail).toContain('Remove did not take');
    expect(cleaned.detail).toContain('still listed');
    expect(fake.archives).toHaveLength(3);
  });

  test('cleaning up when the engine still lists an archive the page lost is not ok, though every Remove journey passed', async () => {
    const { fake, fx } = await importedThree();
    fake.world.engineKeepsRemoved = true;
    const cleaned = await removeAllStage(fake, { removeS: 5, verifyS: 6 });
    expect(cleaned.ok).toBe(false);
    expect(cleaned.failed).toEqual([]);
    expect(cleaned.removed).toHaveLength(3);
    expect([...cleaned.remaining].sort()).toEqual([fx.agent!.fileName, fx.held!.fileName, fx.picker!.fileName].sort());
    expect(cleaned.detail).toContain('still listed after the removals');
  });

  test('cleaning up when the page cannot be read is not ok and removes nothing: an unreadable page is not an empty one', async () => {
    const { fake } = await importedThree();
    fake.world.panelUnreadable = true;
    const cleaned = await removeAllStage(fake, { removeS: 2, openS: 2, verifyS: 6 });
    expect(cleaned.ok).toBe(false);
    expect(cleaned.removed).toEqual([]);
    expect(cleaned.detail).toContain('the dashboard could not be read');
    expect(fake.archives).toHaveLength(3);
  });

  test('cleaning up when the agent\'s status cannot be read is not ok either', async () => {
    const { fake } = await importedThree();
    fake.cli = () => ({ code: 1, json: undefined, stderr: 'engine down' });
    const cleaned = await removeAllStage(fake, { removeS: 2, openS: 2, verifyS: 6 });
    expect(cleaned.ok).toBe(false);
    expect(cleaned.removed).toEqual([]);
    expect(cleaned.detail).toContain('status of the archives could not be read');
    expect(fake.archives).toHaveLength(3);
  });
});

describe('a file changed while it is imported', () => {
  test('a first size that finishes first is removed, a larger one is caught importing, changed, stopped and removed', async () => {
    const { machine: fake } = machine();
    fake.know(legFixture('bulk', SEED, 'mbox', 8_000), legFixture('bulk', SEED, 'mbox', 40_000));
    fake.world.finishesFirstUpTo = 8_000;
    const observation = await changedStage(fake, { seed: SEED, sizes: [8_000, 40_000], startS: 5, stopS: 5, removeS: 5 });
    expect(observation.ok).toBe(true);
    expect(observation.attempts.map((attempt) => `${attempt.messages} ${attempt.outcome}`)).toEqual(['8000 finished-first', '40000 changed']);
    expect(observation.row).toMatchObject({ status: 'stopped' });
    expect(observation.status!.archives[0]).toMatchObject({ status: 'stopped', stopCode: 'file_changed' });
    expect(observation.removed).toMatchObject({ gone: true, unlisted: true });
    expect(fake.archives).toEqual([]);
    const failedSteps = observation.traces.flatMap((trace) => trace.steps.filter((step) => !step.ok).map((step) => `${trace.id} / ${step.name}: expected ${step.expected}; got ${step.actual}`));
    expect(failedSteps).toEqual([]);
    expect(failing(changedChecks(observation))).toEqual([]);
  });

  test('when no size is caught importing the check fails and names each attempt', async () => {
    const { machine: fake } = machine();
    fake.know(legFixture('bulk', SEED, 'mbox', 8_000), legFixture('bulk', SEED, 'mbox', 40_000));
    fake.world.finishesFirstUpTo = 1_000_000;
    const observation = await changedStage(fake, { seed: SEED, sizes: [8_000, 40_000], startS: 5, stopS: 5, removeS: 5 });
    expect(observation.attempts.map((attempt) => attempt.outcome)).toEqual(['finished-first', 'finished-first']);
    const checks = changedChecks(observation);
    expect(failing(checks)).toContain('archive.changed.stops');
    expect(checks.find((check) => check.id === 'archive.changed.stops')!.detail).toContain('40000 messages finished-first');
  });

  test('a start the product refuses is recorded as refused and stops the stage', async () => {
    const { machine: fake } = machine();
    fake.cli = () => ({ code: 1, json: { ok: false, code: 'invalid_path' }, stderr: '' });
    const observation = await changedStage(fake, { seed: SEED, sizes: [8_000], startS: 2, stopS: 2, removeS: 2 });
    expect(observation.attempts).toEqual([{ messages: 8_000, outcome: 'refused', detail: 'start answered "invalid_path"' }]);
    expect(failing(changedChecks(observation))).toEqual(['archive.changed.stops']);
  });

  test('the fixtures the stages write are the ones the leg describes', () => {
    const fx = legFixture('bulk', SEED, 'mbox', 8_000);
    const home = mkdtempSync(join(tmpdir(), 'archive-stages-write-'));
    cleanups.push(() => rmSync(home, { recursive: true, force: true }));
    const path = writeFixture(home, fx);
    expect(basename(path)).toBe('rc-bulk-8000.mbox');
    expect(statSync(path).size).toBeGreaterThan(8_000);
    mkdirSync(join(home, 'x'), { recursive: true });
  });
});
