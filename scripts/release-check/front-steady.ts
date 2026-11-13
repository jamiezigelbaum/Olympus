/**
 * The split front stays up on a store set like a real one (engine split, #1240).
 *
 * The rc.4 install on Sparta (ops#151, 2026-11-13) crashed its front on every start: with the split on, the front built the
 * extraction runtimes of Gmail attachments, Telegram media, Evernote and the archive imports, which open their job store for
 * writing, and the front may open none (`front_store_write`). Every leg passed on that build, because no leg restarted the split
 * engine on an install that holds those lanes.
 *
 * This stage builds such a store set on the machine and restarts the engine the way its own unit does:
 * - Gmail mail with an attachment, from a Google Takeout mbox the agent asks to import and the owner approves (no account yet, so
 *   the import makes the Gmail account and fills its stores);
 * - the Telegram account and a live input, through Telegram's own pull (archive-live-seed-telegram.ts);
 * - whatever archives the archive leg left (its notes and mail lanes).
 * Evernote's own account needs its MCP server and cannot be seeded here; the report says so.
 *
 * Then `olympus engine restart`, and a watch of a couple of minutes: the front must keep one process the whole time, and the
 * engine's log must say no process exited unexpectedly and no front opened a store for writing. One read of health would not do:
 * the rc.4 front answered "ready" each time before it crashed.
 */
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { sharedDataPath } from '../../src/core/olympus-layout.ts';
import { DASHBOARD_ARCHIVE_COPY as A } from '../../src/workers/dashboard/vocabulary.ts';
import { mail as gmailMail, takeoutMbox } from '../../test/support/archive-fixtures-gmail.ts';
import { FIXTURE_FOLDER } from './archive-fixtures.ts';
import { ALL_SOURCES_PATH } from './archive-leg.ts';
import { until, type ArchiveHost } from './archive-stages.ts';
import { runJourney, type Journey, type JourneyTrace } from './journey.ts';
import { OPEN_ALL_SOURCES } from './journeys.ts';
import type { CheckResult } from './report.ts';
import { BROKEN_FRONT_LINE } from './upgrade-split.ts';

export const FRONT_WATCH_S = 150;
const SAMPLE_MS = 3_000;
const GMAIL_SOURCE = 'gmail.email';
const TELEGRAM_SOURCE = 'telegram.messages';
export const FRONT_GMAIL_FILE = 'rc-front-gmail.mbox';

export interface EnginePids { front: number[]; background: number[] }

export interface FrontHost extends ArchiveHost {
  /** The engine's processes by role, from their environments; null where the platform cannot tell. */
  enginePids(): EnginePids | null;
  /** How many live rows a source's store holds in a tier, read-only (the agent, which may open stores, does the reading). */
  laneItems(source: string, tier: 'internal' | 'secure_local'): LaneView;
  /** The engine's own log files (stdout and stderr of the unit). */
  engineLogPaths: readonly string[];
}

export interface LaneView { source: string; tier: string; exists: boolean; items: number; error?: string }

export interface FrontSteadyObservation {
  ok: boolean;
  detail?: string;
  gmail: { started?: string; approved: boolean; settled: boolean; status?: string };
  telegram: { ok: boolean; detail?: string };
  lanes: LaneView[];
  archives: number;
  /** Whether the background had made the extraction job queue before the restart (the front opens it only once it exists). */
  jobQueue?: boolean;
  restart?: { ok: boolean; ms: number; detail?: string };
  /** The front's and background's processes at each sample after the restart. */
  samples: EnginePids[];
  watchMs: number;
  /** Lines of the engine's log written since just before the restart that name a crash (counts by kind, never the text). */
  logHits: { frontStoreWrite: number; exitedUnexpectedly: number; brokenFront?: number };
  traces: JourneyTrace[];
}

/** A Takeout mbox of the owner's Gmail: two messages, one with a text attachment the attachment lane reads. */
export function frontGmailMbox(token: string): string {
  return takeoutMbox([
    gmailMail(201, { date: '2024-05-02T12:00:00.000Z', body: `Front check, plain message. Word: ${token}.` }),
    gmailMail(202, {
      date: '2024-05-03T12:00:00.000Z',
      body: `Front check, message with an attachment. Word: ${token}.`,
      attachment: { name: 'front-check-notes.txt', mime: 'text/plain', text: `Notes attached to the front check. Word: ${token}.` },
    }),
  ]);
}

/** The owner presses Import on the agent's waiting request for the file; the request is then no longer waiting. */
export function approveFileJourney(fileName: string, openS = 120, startS = 180): Journey {
  const pending = { css: 'li.archive.request[data-request="pending"]' };
  return {
    id: 'front-gmail-import',
    title: 'The owner approves an agent\'s request to import a Gmail Takeout mbox',
    source: 'front steadiness: a store set with Gmail mail and an attachment',
    mutates: true,
    steps: [
      { name: 'Open the dashboard', do: { go: ALL_SOURCES_PATH }, expect: [], timeoutMs: openS * 1_000 },
      OPEN_ALL_SOURCES,
      { name: 'The agent\'s request is waiting', do: { observe: true }, expect: [{ present: pending, frame: 'panel' }, { text: fileName, frame: 'panel' }], timeoutMs: openS * 1_000 },
      {
        name: 'Press Import on the request',
        do: { click: { role: 'button', name: A.approve, within: pending }, frame: 'panel' },
        expect: [{ absent: pending, frame: 'panel' }],
        timeoutMs: startS * 1_000,
      },
    ],
  };
}

const asRecord = (value: unknown): Record<string, unknown> => (value && typeof value === 'object' ? value as Record<string, unknown> : {});

/** The status the agent's own view gives the named archive, or undefined while it is not listed. */
export function archiveStatusOf(json: unknown, fileName: string): string | undefined {
  const archives = asRecord(json).archives;
  if (!Array.isArray(archives)) return undefined;
  const found = archives.map(asRecord).find((archive) => archive.name === fileName);
  return typeof found?.status === 'string' ? found.status : undefined;
}

const archiveCount = (json: unknown): number => {
  const archives = asRecord(json).archives;
  return Array.isArray(archives) ? archives.length : 0;
};


const sizeOf = (path: string): number => { try { return statSync(path).size; } catch { return 0; } };

/** Counts the crash lines in what the logs gained since `offsets`. Only counts leave the machine. */
export function crashLines(text: string): { frontStoreWrite: number; exitedUnexpectedly: number; brokenFront: number } {
  return {
    frontStoreWrite: (text.match(/front_store_write/g) ?? []).length,
    exitedUnexpectedly: (text.match(/exited unexpectedly/g) ?? []).length,
    // The forced failed update's own front (upgrade-split.ts): proof it started before it exited.
    brokenFront: text.split(BROKEN_FRONT_LINE).length - 1,
  };
}

function logSince(paths: readonly string[], offsets: readonly number[]): string {
  return paths.map((path, index) => {
    try {
      const all = readFileSync(path);
      // A log that is shorter than at the mark was started again (an install can replace it): all of it is new.
      const from = offsets[index] ?? 0;
      return all.subarray(from <= all.length ? from : 0).toString('utf8');
    } catch { return ''; }
  }).join('\n');
}

/** Where each engine log ends now, so a later watch reads only what came after. */
export const logMark = (paths: readonly string[]): number[] => paths.map(sizeOf);

export type FrontStoreSet = Pick<FrontSteadyObservation, 'gmail' | 'telegram' | 'lanes' | 'archives' | 'jobQueue' | 'traces'> & { ok: boolean; detail?: string };
export type FrontWatch = Pick<FrontSteadyObservation, 'samples' | 'watchMs' | 'logHits'>;

/**
 * Builds the store set: the agent asks to import a Gmail Takeout mbox, the owner approves, the import settles; Telegram is
 * seeded through its own pull; then what each lane holds is read. Beside the archive leg's files, which its imports still
 * name: nothing there is removed.
 */
export async function seedFrontStoreSet(host: FrontHost, args: { seed: string; settleS?: number }): Promise<FrontStoreSet> {
  const set: FrontStoreSet = { ok: false, gmail: { approved: false, settled: false }, telegram: { ok: false }, lanes: [], archives: 0, traces: [] };
  try {
    const folder = join(host.home, FIXTURE_FOLDER);
    mkdirSync(folder, { recursive: true, mode: 0o700 });
    const path = join(folder, FRONT_GMAIL_FILE);
    writeFileSync(path, frontGmailMbox(`front${args.seed}`), { mode: 0o600 });
    const started = host.cli(['start', '--path', path]);
    set.gmail.started = String(asRecord(started.json).code ?? (asRecord(started.json).ok === true ? 'started' : `exit ${started.code}`));
    await host.withBrowser(async ({ driver }) => {
      const trace = await runJourney(driver, approveFileJourney(FRONT_GMAIL_FILE));
      set.traces.push(trace);
      set.gmail.approved = trace.ok;
    });
    const settled = await until(host, async () => {
      const status = archiveStatusOf(host.cli(['status']).json, FRONT_GMAIL_FILE);
      if (status !== undefined) set.gmail.status = status;
      return status === 'imported' ? status : undefined;
    }, (args.settleS ?? 900) * 1_000, 5_000);
    set.gmail.settled = settled !== undefined;
    host.say(`front: Gmail import ${set.gmail.settled ? 'settled' : `not settled (${set.gmail.status ?? 'not listed'})`}`);
    if (host.seedLive) {
      const seeded = await host.seedLive('telegram');
      set.telegram = { ok: seeded.ok, ...(seeded.detail !== undefined ? { detail: seeded.detail } : {}) };
    } else set.telegram = { ok: false, detail: 'this machine cannot run a live seed hook' };
    set.archives = archiveCount(host.cli(['status']).json);
    set.lanes = [GMAIL_SOURCE, TELEGRAM_SOURCE].flatMap((source) => (['internal', 'secure_local'] as const).map((tier) => host.laneItems(source, tier)));
    // rc.4's front built an extraction runtime only for stores that already exist, the background's job queue among them, so the
    // restart or update waits for the background to have made it (L1, 13 Nov).
    const queue = sharedDataPath('file-extraction-jobs');
    set.jobQueue = (await until(host, async () => (existsSync(queue) ? true : undefined), 600_000, 5_000)) === true;
    host.say(`front: extraction job queue ${set.jobQueue ? 'present' : 'never made'}`);
    set.ok = true;
  } catch (error) {
    set.detail = error instanceof Error ? error.message.slice(0, 300) : String(error).slice(0, 300);
  }
  return set;
}

/** Samples the engine's processes every few seconds for `watchMs`, then counts the crash lines the logs gained since `offsets`. */
export async function watchFront(host: FrontHost, offsets: readonly number[], watchMs: number): Promise<FrontWatch> {
  const samples: EnginePids[] = [];
  const end = host.now() + watchMs;
  while (host.now() < end) {
    const pids = host.enginePids();
    if (pids) samples.push(pids);
    await host.sleep(SAMPLE_MS);
  }
  return { samples, watchMs, logHits: crashLines(logSince(host.engineLogPaths, offsets)) };
}

export async function frontSteadyStage(host: FrontHost, args: { seed: string; watchS?: number; settleS?: number }): Promise<FrontSteadyObservation> {
  const watchMs = (args.watchS ?? FRONT_WATCH_S) * 1_000;
  const set = await seedFrontStoreSet(host, { seed: args.seed, ...(args.settleS !== undefined ? { settleS: args.settleS } : {}) });
  const obs: FrontSteadyObservation = { ...set, ok: false, samples: [], watchMs, logHits: { frontStoreWrite: 0, exitedUnexpectedly: 0 } };
  if (!set.ok) return obs;
  try {
    // The restart, as the owner's unit does it, then the watch.
    const offsets = logMark(host.engineLogPaths);
    obs.restart = await host.restartEngine(600_000);
    host.say(`front: engine restart ${obs.restart.ok ? 'ok' : `FAILED (${obs.restart.detail ?? ''})`} after ${Math.round(obs.restart.ms / 1000)} s`);
    Object.assign(obs, await watchFront(host, offsets, watchMs));
    obs.ok = true;
  } catch (error) {
    obs.detail = error instanceof Error ? error.message.slice(0, 300) : String(error).slice(0, 300);
  }
  return obs;
}

/** What the samples say of the front: how many distinct front processes were seen, and how many samples had none. */
export function frontChurn(samples: readonly EnginePids[]): { fronts: number; withoutFront: number; backgrounds: number; withoutBackground: number } {
  const fronts = new Set(samples.flatMap((sample) => sample.front));
  const backgrounds = new Set(samples.flatMap((sample) => sample.background));
  return {
    fronts: fronts.size,
    withoutFront: samples.filter((sample) => sample.front.length === 0).length,
    backgrounds: backgrounds.size,
    withoutBackground: samples.filter((sample) => sample.background.length === 0).length,
  };
}

/** `after` names what started the engine the checks watch: a restart as the unit runs it (the default), or an update. */
export function frontSteadyChecks(obs: FrontSteadyObservation | undefined, after = 'a restart as the unit runs it'): CheckResult[] {
  const steadyTitle = `After ${after}, the split front stays up: one front process throughout, no crash in the engine log`;
  // A machine that answered with something else (an older agent, a fake) has not reported this stage.
  if (!obs || !Array.isArray(obs.lanes) || !Array.isArray(obs.samples) || !obs.gmail || !obs.telegram || !obs.logHits) {
    return [{ id: 'front.steady', title: steadyTitle, status: 'fail', detail: 'the stage did not report' }];
  }
  const out: CheckResult[] = [];
  const held = (source: string): number => obs.lanes.filter((lane) => lane.source === source).reduce((sum, lane) => sum + lane.items, 0);
  const gmailItems = held(GMAIL_SOURCE);
  const telegramItems = held(TELEGRAM_SOURCE);
  const setProblems = [
    ...(obs.gmail.settled ? [] : [`the Gmail import did not settle (${obs.gmail.status ?? obs.gmail.started ?? 'no status'})`]),
    ...(gmailItems > 0 ? [] : ['the Gmail stores hold no mail']),
    ...(obs.jobQueue === false ? ['the background never made the extraction job queue, so the front had no extraction runtime to build'] : []),
    ...(obs.telegram.ok && telegramItems > 0 ? [] : [`Telegram was not seeded (${obs.telegram.detail ?? 'no detail'})`]),
  ];
  out.push({
    id: 'front.store-set',
    title: 'The machine holds the lanes whose extraction the front must not open for writing: Gmail with an attachment, Telegram, archives',
    status: setProblems.length === 0 ? 'pass' : 'fail',
    detail: setProblems.length === 0
      ? `Gmail ${gmailItems} item(s) from an approved Takeout import with an attachment; Telegram ${telegramItems} item(s); ${obs.archives} archive(s) listed; the extraction job queue existed before the restart; Evernote's own account is not seeded on this machine`
      : setProblems.join('; '),
  });
  const churn = frontChurn(obs.samples);
  const problems = [
    ...(obs.detail ? [`the stage stopped: ${obs.detail}`] : []),
    ...(obs.restart && !obs.restart.ok ? [`the engine did not come back: ${obs.restart.detail ?? 'no detail'}`] : []),
    ...(obs.samples.length === 0 ? ['no process sample was taken'] : []),
    ...(churn.fronts > 1 ? [`${churn.fronts} different front processes in ${Math.round(obs.watchMs / 1000)} s (it restarted ${churn.fronts - 1} time(s))`] : []),
    ...(obs.samples.length > 0 && churn.withoutFront > 0 ? [`no front running in ${churn.withoutFront} of ${obs.samples.length} samples`] : []),
    ...(churn.backgrounds > 1 ? [`${churn.backgrounds} different background processes`] : []),
    ...(obs.logHits.frontStoreWrite > 0 ? [`the engine log says front_store_write ${obs.logHits.frontStoreWrite} time(s)`] : []),
    ...(obs.logHits.exitedUnexpectedly > 0 ? [`the engine log says a process exited unexpectedly ${obs.logHits.exitedUnexpectedly} time(s)`] : []),
  ];
  out.push({
    id: 'front.steady',
    title: steadyTitle,
    status: problems.length === 0 ? 'pass' : 'fail',
    detail: problems.length === 0
      ? `one front and one background for ${Math.round(obs.watchMs / 1000)} s after ${after} (${obs.samples.length} samples); no crash line in the log`
      : problems.join('; '),
  });
  return out;
}
