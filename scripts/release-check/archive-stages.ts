/**
 * The in-machine stages of the archive-import leg (archive-leg.ts): the pressing, the waiting and the reading, one function per verb
 * the harness calls. machine-agent.ts gives each a `host` (the machine's own CLI, browser, stores and engine); nothing here reaches
 * the machine except through it, so the stages run against a stand-in in the tests (test/release-check-archive-stages.test.ts) with
 * the product's real panel in a DOM.
 *
 * A stage never judges: it observes, and archive-leg.ts turns what it saw into checks. A step that could not be taken (a control that is
 * not on the page, a wait that ran out) is recorded where it happened, in the journey's trace or the observation, and the stage goes on
 * to whatever can still be observed, so a failure names the first thing that was wrong and not only that the stage ended.
 */
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  STRESS_FORMAT, changeFixture, legFixture, resetFixtureFolder, writeFixture, formatSpec,
  type FixtureRole, type LegFixture,
} from './archive-fixtures.ts';
import {
  ARCHIVE_BOUNDS, ARCHIVE_PANEL_PROBE, agentImportJourney, approveRequestSteps, drainBoundS, panelArchivesOf, pickerImportJourney, removeJourney, rowNamed,
  startViewOf, statusViewOf, stoppedJourney,
  type ChangedObservation, type DrainView, type ImportObservation, type ModelObservation, type PanelArchives, type RemoveObservation, type RowView,
  type SearchView, type StatusView, type StoreView,
} from './archive-leg.ts';
import { requestsOutsideMachine } from './egress.ts';
import type { EgressView } from './inbox.ts';
import { runJourney, type Journey, type JourneyDriver, type JourneyTrace } from './journey.ts';

export interface ArchiveBrowserSession {
  /** The owner's browser on the machine, signed in with the Unlock step, on the dashboard. */
  driver: JourneyDriver;
  /** The browser's process, for the watch of the machine's connections (its own traffic is judged apart). */
  pid?: number | undefined;
  /** Every address the page asked for, so far. */
  requests: string[];
}

export interface CliAnswer { code: number; json: unknown; stderr: string }

export interface ArchiveHost {
  os: 'linux' | 'macos';
  home: string;
  /** The folder the harness collects (screenshots and traces land under it). */
  workDir: string;
  workerEnvPath: string;
  say(line: string): void;
  sleep(ms: number): Promise<void>;
  now(): number;
  /** `olympus archive <args>`: the agent tool's own CLI form. */
  cli(args: string[]): CliAnswer;
  /** One browser for the whole of `work`: opened signed in, closed after. */
  withBrowser<T>(work: (session: ArchiveBrowserSession) => Promise<T>): Promise<T>;
  /** Starts sampling the machine's connections; `stop` gives what was seen. */
  watchEgress(browserPid: () => number | undefined): Promise<{ stop(): Omit<EgressView, 'pageRequests' | 'pageOutside'> }>;
  /** `olympus_search` over the engine's MCP endpoint, as a connected agent asks. */
  search(question: string): Promise<{ ok: boolean; isError: boolean; structured: unknown; error?: string }>;
  /** The archive's three tier stores. `archiveId` narrows to its own items when known. */
  readStores(archive: { family: string; provider: string }, archiveId: string | undefined, token: string): StoreView[];
  /** `olympus engine restart`, then until the engine is ready (models included). */
  restartEngine(timeoutMs: number): Promise<{ ok: boolean; ms: number; detail?: string }>;
}

const SETTLE_POLL_MS = 2_000;

async function until<T>(host: ArchiveHost, read: () => Promise<T | undefined>, timeoutMs: number, everyMs: number): Promise<T | undefined> {
  const stop = host.now() + timeoutMs;
  for (;;) {
    const got = await read().catch(() => undefined);
    if (got !== undefined) return got;
    if (host.now() >= stop) return undefined;
    await host.sleep(everyMs);
  }
}

/** The engine's answer to `status`, tried again while the engine is busy or restarting. */
async function statusNow(host: ArchiveHost, token: string, waitMs = 60_000): Promise<StatusView | undefined> {
  return until(host, async () => {
    const answer = host.cli(['status']);
    const view = statusViewOf(answer.json, token);
    return answer.code === 0 && view.ok ? view : undefined;
  }, waitMs, 3_000);
}

async function readPanel(driver: JourneyDriver): Promise<PanelArchives | undefined> {
  try {
    return panelArchivesOf(await driver.probe('panel', ARCHIVE_PANEL_PROBE));
  } catch {
    return undefined;
  }
}

/** The row for a file, read again for a short while: the page may be redrawing. */
async function rowNow(host: ArchiveHost, driver: JourneyDriver, fileName: string, waitMs = 15_000): Promise<RowView | undefined> {
  return until(host, async () => rowNamed(await readPanel(driver), fileName), waitMs, 500);
}

const stepMs = (trace: JourneyTrace, startsWith: string): { ok: boolean; ms: number } => {
  const step = trace.steps.find((candidate) => candidate.name.startsWith(startsWith));
  return { ok: step?.ok === true, ms: step?.ms ?? 0 };
};

// ---------------------------------------------------------------------------
// Import

export interface ImportArgs {
  role: FixtureRole;
  format: string;
  via: 'request' | 'picker';
  seed: string;
  /** Empties the fixtures folder first (the leg's first stage). */
  resetFolder?: boolean;
  /** Removes archives an earlier attempt left, so the picker's Import an archive is where this stage looks for it. */
  clean?: boolean;
  /** After the import settles, wait this long for the held messages to be judged (the private model is on). */
  drainS?: number;
  /** Search for the archive's word once it is imported (and drained, when asked). */
  search?: boolean;
  /** Watch the machine's connections from before the request until the stage's end. */
  watchEgress?: boolean;
  settleS?: number;
  startS?: number;
}

export async function importStage(host: ArchiveHost, args: ImportArgs): Promise<ImportObservation> {
  const fx = legFixture(args.role, args.seed, args.format);
  const obs: ImportObservation = { ok: false, role: fx.role, format: fx.format, fileName: fx.fileName, token: fx.token, via: args.via, traces: [], settled: false, settleMs: 0, stores: [] };
  if (args.resetFolder) resetFixtureFolder(host.home);
  const path = writeFixture(host.home, fx);
  try {
    await host.withBrowser(async (session) => {
      const driver = session.driver;
      let browserPid = session.pid;
      const watch = args.watchEgress ? await host.watchEgress(() => browserPid) : undefined;
      try {
        if (args.clean) await removeLeftovers(host, driver, fx.token);
        if (args.via === 'request') {
          const started = host.cli(['start', '--path', path]);
          obs.start = startViewOf(started.json, fx.token);
          host.say(`start: ${obs.start.code || `exit ${started.code}`}${started.json === undefined ? ` ${started.stderr.slice(0, 120)}` : ''}`);
          const waiting = host.cli(['status']);
          obs.waiting = statusViewOf(waiting.json, fx.token);
        }
        const bounds = { ...(args.startS !== undefined ? { startS: args.startS } : {}), ...(args.settleS !== undefined ? { settleS: args.settleS } : {}) };
        const journey = args.via === 'request' ? agentImportJourney(fx, path, bounds) : pickerImportJourney(fx, bounds);
        const trace = await runJourney(driver, journey);
        obs.traces.push(trace);
        const settle = stepMs(trace, 'The import settles');
        obs.settled = settle.ok;
        obs.settleMs = settle.ms;
        host.say(`${journey.id}: ${trace.ok ? 'ok' : 'FAILED'} (${Math.round(trace.ms / 1000)} s)`);
        // The row as the journey left it (See what was not read open, when the fixture has gaps).
        obs.row = await rowNow(host, driver, fx.fileName, 5_000);
        const status = await statusNow(host, fx.token, 30_000);
        if (status) {
          obs.status = status;
          obs.archiveId = status.archives.find((archive) => archive.name === fx.fileName)?.id;
        }
        obs.stores = host.readStores(formatSpec(fx.format), obs.archiveId, fx.token);
        if (obs.settled && args.drainS !== undefined) obs.drain = await drainWait(host, driver, fx, args.drainS * 1_000);
        if (args.search) obs.search = await searchFor(host, fx);
      } finally {
        if (watch) {
          const seen = watch.stop();
          obs.egress = { ...seen, pageRequests: session.requests.length, pageOutside: requestsOutsideMachine(session.requests) };
        }
        browserPid = undefined;
      }
    });
    obs.ok = true;
  } catch (error) {
    obs.detail = error instanceof Error ? error.message.slice(0, 300) : String(error).slice(0, 300);
  }
  return obs;
}

/** Archives an earlier attempt left on the machine, removed from their rows, so a stage starts from an empty Archives line. */
async function removeLeftovers(host: ArchiveHost, driver: JourneyDriver, token: string): Promise<void> {
  const status = await statusNow(host, token, 20_000);
  for (const archive of status?.archives ?? []) {
    host.say(`removing leftover archive ${archive.name} (${archive.status})`);
    await runJourney(driver, removeJourney('leftover', archive.name));
  }
}

async function searchFor(host: ArchiveHost, fx: LegFixture): Promise<SearchView> {
  let answer: Awaited<ReturnType<ArchiveHost['search']>>;
  try {
    answer = await host.search(`Which message mentions the reference word ${fx.token}?`);
  } catch (error) {
    return { ok: false, isError: true, evidence: [], error: error instanceof Error ? error.message.slice(0, 160) : String(error).slice(0, 160) };
  }
  const record = (answer.structured && typeof answer.structured === 'object' ? answer.structured : {}) as { evidence?: unknown };
  const evidence = (Array.isArray(record.evidence) ? record.evidence : []).map((entry: any) => ({
    source: typeof entry?.source === 'string' ? entry.source : '',
    hasToken: [entry?.excerpt, entry?.title].some((field) => typeof field === 'string' && field.includes(fx.token)),
  }));
  return { ok: answer.ok && !answer.isError, isError: answer.isError, evidence, ...(answer.error ? { error: answer.error } : {}) };
}

/** Waits until the archive has no message waiting for the private model, or the bound; reads the dashboard row after. */
async function drainWait(host: ArchiveHost, driver: JourneyDriver, fx: LegFixture, boundMs: number): Promise<DrainView> {
  const started = host.now();
  const last: DrainView['last'] = {};
  let privateModel: string | undefined;
  let drained = false;
  for (;;) {
    const answer = host.cli(['status']);
    const view = statusViewOf(answer.json, fx.token);
    if (answer.code === 0 && view.ok) {
      privateModel = view.privateModel ?? privateModel;
      const mine = view.archives.find((archive) => archive.name === fx.fileName);
      if (mine) {
        if (mine.messages !== undefined) last.messages = mine.messages;
        if (mine.judged !== undefined) last.judged = mine.judged;
        if (mine.waiting !== undefined) last.waiting = mine.waiting;
        if (mine.status === 'imported' && mine.waiting === 0) { drained = true; break; }
      }
    }
    if (host.now() - started >= boundMs) break;
    await host.sleep(10_000);
  }
  const ms = host.now() - started;
  let row: RowView | undefined;
  try {
    await driver.go('/dashboard');
    row = await rowNow(host, driver, fx.fileName, 30_000);
  } catch { /* the row stays unread; the check says so */ }
  host.say(`drain: ${drained ? 'done' : 'NOT done'} after ${Math.round(ms / 1000)} s (${last.waiting ?? '?'} waiting)`);
  return { drained, ms, boundMs, last, ...(privateModel ? { privateModel } : {}), ...(row ? { row } : {}) };
}

/** The wait after the private model is back on: the held messages of an archive already imported. */
export async function drainStage(host: ArchiveHost, args: { role: FixtureRole; format: string; seed: string; os: string; search?: boolean; boundS?: number }): Promise<ImportObservation> {
  const fx = legFixture(args.role, args.seed, args.format);
  const obs: ImportObservation = { ok: false, role: fx.role, format: fx.format, fileName: fx.fileName, token: fx.token, via: 'request', traces: [], settled: true, settleMs: 0, stores: [] };
  try {
    await host.withBrowser(async (session) => {
      obs.drain = await drainWait(host, session.driver, fx, (args.boundS ?? drainBoundS(args.os)) * 1_000);
      obs.row = obs.drain.row;
      const status = await statusNow(host, fx.token, 30_000);
      if (status) {
        obs.status = status;
        obs.archiveId = status.archives.find((archive) => archive.name === fx.fileName)?.id;
      }
      obs.stores = host.readStores(formatSpec(fx.format), obs.archiveId, fx.token);
      if (args.search) obs.search = await searchFor(host, fx);
    });
    obs.ok = true;
  } catch (error) {
    obs.detail = error instanceof Error ? error.message.slice(0, 300) : String(error).slice(0, 300);
  }
  return obs;
}

// ---------------------------------------------------------------------------
// Remove

export interface RemoveTarget { role: FixtureRole; format: string; fileName: string; token: string }

export async function removeStage(host: ArchiveHost, args: { targets: readonly RemoveTarget[]; removeS?: number }): Promise<RemoveObservation> {
  const obs: RemoveObservation = { ok: false, removals: [] };
  try {
    await host.withBrowser(async (session) => {
      const driver = session.driver;
      for (const [index, target] of args.targets.entries()) {
        const before = await statusNow(host, target.token, 30_000);
        const archiveId = before?.archives.find((archive) => archive.name === target.fileName)?.id;
        const journey = removeJourney(target.role, target.fileName, args.removeS);
        const trace = await runJourney(driver, journey);
        host.say(`${journey.id}: ${trace.ok ? 'ok' : 'FAILED'}`);
        const gone = stepMs(trace, 'Confirm');
        const after = await statusNow(host, target.token, 30_000);
        const spec = formatSpec(target.format);
        const others = args.targets.slice(index + 1).map((other) => ({
          role: other.role, fileName: other.fileName, stores: host.readStores(spec, undefined, other.token),
        }));
        obs.removals.push({
          role: target.role,
          fileName: target.fileName,
          ...(archiveId ? { archiveId } : {}),
          traces: [trace],
          gone: gone.ok,
          goneMs: gone.ms,
          unlisted: after !== undefined && !after.archives.some((archive) => archive.name === target.fileName),
          stores: host.readStores(spec, archiveId, target.token),
          others,
        });
      }
    });
    obs.ok = true;
  } catch (error) {
    obs.detail = error instanceof Error ? error.message.slice(0, 300) : String(error).slice(0, 300);
  }
  return obs;
}

/** Every archive on the machine removed from its row; the best-effort clean-up after a leg that stopped early. */
export async function removeAllStage(host: ArchiveHost): Promise<{ ok: boolean; removed: string[]; detail?: string }> {
  const removed: string[] = [];
  try {
    await host.withBrowser(async (session) => {
      const panel = await readPanel(session.driver);
      for (const row of panel?.rows ?? []) {
        const trace = await runJourney(session.driver, removeJourney('cleanup', row.name));
        host.say(`cleanup ${row.name}: ${trace.ok ? 'removed' : 'FAILED'}`);
        if (trace.ok) removed.push(row.name);
      }
    });
    return { ok: true, removed };
  } catch (error) {
    return { ok: false, removed, detail: error instanceof Error ? error.message.slice(0, 300) : String(error).slice(0, 300) };
  }
}

// ---------------------------------------------------------------------------
// A file that changes while it is imported

export async function changedStage(host: ArchiveHost, args: { seed: string; sizes: readonly number[]; startS?: number; stopS?: number; removeS?: number }): Promise<ChangedObservation> {
  const obs: ChangedObservation = { ok: false, attempts: [], traces: [] };
  try {
    await host.withBrowser(async (session) => {
      const driver = session.driver;
      for (const size of args.sizes) {
        const fx = legFixture('bulk', args.seed, STRESS_FORMAT, size);
        obs.fileName = fx.fileName;
        const path = writeFixture(host.home, fx);
        const started = startViewOf(host.cli(['start', '--path', path]).json, fx.token);
        if (started.code !== 'needs_approval') {
          obs.attempts.push({ messages: size, outcome: 'refused', detail: `start answered "${started.code || 'nothing'}"` });
          break;
        }
        const approve: Journey = {
          id: `archive-bulk-${size}-approve`,
          title: `The owner approves the large archive's import (${size} messages)`,
          source: 'archive import: a file that changes while it is imported',
          mutates: true,
          steps: approveRequestSteps(fx, path, args.startS ?? ARCHIVE_BOUNDS.startS),
        };
        const approved = await runJourney(driver, approve);
        obs.traces.push(approved);
        if (!approved.ok) {
          obs.attempts.push({ messages: size, outcome: 'never-started', detail: 'the import did not show on the dashboard after Import was pressed' });
          break;
        }
        const caught = await catchImporting(host, fx, (args.startS ?? ARCHIVE_BOUNDS.startS) * 1_000);
        if (caught.state === 'importing') {
          changeFixture(path, fx);
          obs.attempts.push({ messages: size, outcome: 'changed', detail: `a message was added to the file while ${caught.items ?? '?'} messages were read` });
          break;
        }
        obs.attempts.push({
          messages: size,
          outcome: caught.state === 'imported' ? 'finished-first' : 'never-started',
          detail: caught.state === 'imported' ? 'the import finished before the file could be changed' : `the archive read "${caught.state}"`,
        });
        // A finished archive is removed before the next, larger one.
        await runJourney(driver, removeJourney('bulk', fx.fileName, args.removeS));
        if (caught.state !== 'imported') break;
      }
      const last = obs.attempts[obs.attempts.length - 1];
      if (last?.outcome === 'changed' && obs.fileName) {
        const fx = legFixture('bulk', args.seed, STRESS_FORMAT, last.messages);
        const stopped = await runJourney(driver, stoppedJourney('bulk', fx.fileName, args.stopS));
        obs.traces.push(stopped);
        host.say(`${stopped.id}: ${stopped.ok ? 'ok' : 'FAILED'}`);
        obs.row = await rowNow(host, driver, fx.fileName, 10_000);
        const status = await statusNow(host, fx.token, 30_000);
        if (status) obs.status = status;
        const archiveId = status?.archives.find((archive) => archive.name === fx.fileName)?.id;
        const removal = await runJourney(driver, removeJourney('bulk', fx.fileName, args.removeS));
        obs.traces.push(removal);
        const after = await statusNow(host, fx.token, 30_000);
        obs.removed = {
          gone: stepMs(removal, 'Confirm').ok,
          unlisted: after !== undefined && !after.archives.some((archive) => archive.name === fx.fileName),
          stores: host.readStores(formatSpec(fx.format), archiveId, fx.token),
        };
      }
    });
    obs.ok = true;
  } catch (error) {
    obs.detail = error instanceof Error ? error.message.slice(0, 300) : String(error).slice(0, 300);
  }
  return obs;
}

/** Polls the agent's status until the archive is importing (with some messages in), finished, or the wait runs out. */
async function catchImporting(host: ArchiveHost, fx: LegFixture, timeoutMs: number): Promise<{ state: string; items?: number }> {
  const stop = host.now() + timeoutMs;
  let state = 'not listed';
  for (;;) {
    const answer = host.cli(['status']);
    const view = statusViewOf(answer.json, fx.token);
    const mine = answer.code === 0 && view.ok ? view.archives.find((archive) => archive.name === fx.fileName) : undefined;
    if (mine) {
      state = mine.status;
      if (mine.status === 'importing') return { state: 'importing', ...(mine.messages !== undefined ? { items: mine.messages } : {}) };
      if (mine.status !== 'removing') return { state: mine.status, ...(mine.messages !== undefined ? { items: mine.messages } : {}) };
    }
    if (host.now() >= stop) return { state };
    await host.sleep(150);
  }
}

// ---------------------------------------------------------------------------
// The private model, off and on

export const SNIFFER_ENABLED_KEY = 'OLYMPUS_TIER_SNIFFER_ENABLED';

/** An env file's text with `key` set to `value`, or removed when `value` is null; every other line is as it was. */
export function envWith(text: string, key: string, value: string | null): string {
  const lines = text.split('\n').filter((line) => line.split('=')[0] !== key);
  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  if (value !== null) lines.push(`${key}=${value}`);
  return lines.length === 0 ? '' : `${lines.join('\n')}\n`;
}

interface EnvBackup { existed: boolean; text: string }

export async function modelStage(host: ArchiveHost, mode: 'off' | 'on', token: string): Promise<ModelObservation> {
  const backupPath = join(host.workDir, 'worker.env.before-archive.json');
  const obs: ModelObservation = { ok: false, mode };
  try {
    if (mode === 'off') {
      // The first backup is the real original: turning it off twice does not overwrite it.
      if (!existsSync(backupPath)) {
        const existed = existsSync(host.workerEnvPath);
        const backup: EnvBackup = { existed, text: existed ? readFileSync(host.workerEnvPath, 'utf8') : '' };
        writeFileSync(backupPath, JSON.stringify(backup), { mode: 0o600 });
      }
      const current = existsSync(host.workerEnvPath) ? readFileSync(host.workerEnvPath, 'utf8') : '';
      writeFileSync(host.workerEnvPath, envWith(current, SNIFFER_ENABLED_KEY, '0'), { mode: 0o600 });
    } else if (existsSync(backupPath)) {
      const backup = JSON.parse(readFileSync(backupPath, 'utf8')) as EnvBackup;
      if (backup.existed) writeFileSync(host.workerEnvPath, backup.text, { mode: 0o600 });
      else rmSync(host.workerEnvPath, { force: true });
      rmSync(backupPath, { force: true });
    } else {
      const current = existsSync(host.workerEnvPath) ? readFileSync(host.workerEnvPath, 'utf8') : '';
      if (new RegExp(`^${SNIFFER_ENABLED_KEY}=`, 'm').test(current)) {
        // Nothing was saved, but the setting is there: take that one line out.
        writeFileSync(host.workerEnvPath, envWith(current, SNIFFER_ENABLED_KEY, null), { mode: 0o600 });
      } else {
        obs.unchanged = true;
      }
    }
    if (mode === 'on' && obs.unchanged) {
      // Already on: no restart is needed, and the state is still read.
      obs.readyMs = 0;
    } else {
      const restarted = await host.restartEngine(ARCHIVE_BOUNDS.engineS * 1_000);
      obs.readyMs = restarted.ms;
      if (!restarted.ok) { obs.detail = restarted.detail ?? 'the engine did not come back ready'; return obs; }
    }
    const status = await statusNow(host, token, 60_000);
    if (status?.privateModel) obs.privateModel = status.privateModel;
    obs.ok = true;
  } catch (error) {
    obs.detail = error instanceof Error ? error.message.slice(0, 300) : String(error).slice(0, 300);
  }
  return obs;
}

export { SETTLE_POLL_MS };
