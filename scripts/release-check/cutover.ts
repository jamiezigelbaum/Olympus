import { appendFileSync, existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { DASHBOARD_UPDATE_COPY } from '../../src/workers/dashboard/vocabulary.ts';
import { DASHBOARD_TOOL_NAME } from '../../src/workers/chatgpt/dashboard-contract.ts';
import type { CheckResult } from './report.ts';

export const CUTOVER_LOG = 'cutover-watch.jsonl';
export const CUTOVER_READY = 'cutover-watch.ready';
export const CUTOVER_STOP = 'cutover-watch.stop';
export const CUTOVER_DONE = 'cutover-watch.done';
const HEALTH_TIMEOUT_MS = 2_000;
const OWNER_TIMEOUT_MS = 5_000; // The worker proxy can take 2.5 s to serve the starting page.
const SAMPLE_MS = 250;
const PAGE_SAMPLE_MS = 2_000;
const PAGE_BOUND_MS = 10_000;
const PAGES = { Home: '/dashboard', Sources: '/dashboard?connect' } as const;
type Page = keyof typeof PAGES;
const watchNow = () => Math.round(performance.timeOrigin + performance.now());
type PageSample = { page: Page; at: number; ms: number; answered: boolean; timeout: boolean; authRefused?: boolean };
type PageWindow = { started: number; ended: number; pages: Record<Page, { longestMs: number; answers: number; timeouts: number; over1s: number; firstGapAt?: number }> };
type BuildRole = 'front' | 'background';
export interface HiddenCopyBuilds {
  finished: Partial<Record<BuildRole, { stores: number; ms: number }>>;
  backgroundWait?: { ms: number; reason: string };
  warnings: BuildRole[];
}

export function hiddenCopyBuilds(log: string): HiddenCopyBuilds {
  const evidence: HiddenCopyBuilds = { finished: {}, warnings: [] };
  for (const line of log.split('\n')) {
    const built = /\[olympus\] (front|background): built (\d+) stores' hidden-copy sets in (\d+) ms/.exec(line);
    if (built) evidence.finished[built[1] as BuildRole] ??= { stores: Number(built[2]), ms: Number(built[3]) };
    const wait = /\[olympus\] background: starting hidden-copy build after waiting (\d+) ms \(([^)]*)\)/.exec(line);
    if (wait) evidence.backgroundWait ??= { ms: Number(wait[1]), reason: wait[2]! };
    // Save the role only. The exception text can name a store or a local file.
    const warning = /\[olympus\] (front|background): a store's hidden-copy set could not be built yet/.exec(line);
    if (warning) evidence.warnings.push(warning[1] as BuildRole);
  }
  return evidence;
}

export function summarizePages(samples: readonly PageSample[], started: number, ended: number): PageWindow {
  const pageStats = (page: Page) => {
    const requests = samples.filter(sample => sample.page === page && sample.at >= started && sample.at <= ended);
    const answers = requests.filter(sample => sample.answered && sample.at + sample.ms <= ended)
      .map(sample => sample.at + sample.ms).sort((a, b) => a - b);
    let previous = started;
    let longestMs = 0;
    let firstGapAt: number | undefined;
    for (const answer of [...answers, ended]) {
      longestMs = Math.max(longestMs, answer - previous);
      if (answer - previous > PAGE_BOUND_MS) firstGapAt ??= previous + PAGE_BOUND_MS + 1;
      previous = answer;
    }
    return {
      longestMs, answers: answers.length,
      ...(firstGapAt !== undefined ? { firstGapAt } : {}),
      timeouts: requests.filter(sample => sample.timeout && sample.at + sample.ms <= ended).length,
      over1s: requests.filter(sample => Math.min(sample.ms, ended - sample.at) > 1_000).length,
    };
  };
  return { started, ended, pages: { Home: pageStats('Home'), Sources: pageStats('Sources') } };
}

export function dashboardAvailabilityCheck(window: PageWindow | undefined, startup = false, bothBuilds = false): CheckResult {
  const detail = window ? Object.entries(window.pages).map(([page, stats]) =>
    `${page}: longest unanswered ${stats.longestMs} ms, ${stats.answers} answers, ${stats.timeouts} timeouts, ${stats.over1s} over 1 s`).join(' · ') : 'No dashboard window observed';
  // Start-up (first answer until READY): never unanswered over 10 s, a starting page counts. After READY: every probe answered
  // and none over 1 s (owner-run-24h.md, one definition of ready, 19 Nov 2026).
  const pass = window && Object.values(window.pages).every(stats => startup
    ? stats.longestMs <= PAGE_BOUND_MS
    : stats.answers > 0 && stats.longestMs <= PAGE_BOUND_MS && stats.timeouts === 0 && stats.over1s === 0);
  const gapAt = window && Math.min(...Object.values(window.pages).map(stats => stats.firstGapAt ?? Infinity));
  return {
    ...(gapAt !== undefined && Number.isFinite(gapAt) ? { observedAt: new Date(gapAt).toISOString() } : {}),
    id: startup ? 'upgrade.cutover.startup' : 'qualify.dashboard',
    title: startup ? 'Home and Sources never go unanswered over 10 s during start-up' : 'After ready, Home and Sources answer every probe within 1 s through the archive stage',
    status: pass && (!startup || bothBuilds) ? 'pass' : 'fail',
    detail: startup ? `${detail} · ${bothBuilds ? 'both hidden-copy builds finished' : 'both hidden-copy build completions were not observed'}` : detail,
  };
}

export async function samplePage(fetch: WorkerFetch, page: Page, at: number): Promise<PageSample> {
  const signal = AbortSignal.timeout(PAGE_BOUND_MS);
  let authRefused = false;
  const answered = await (async () => {
    const init = { headers: { accept: 'text/html' }, redirect: 'manual' as const, signal };
    const response = await fetch(PAGES[page], init);
    const body = await response.text();
    authRefused = response.status === 401 || response.status === 403;
    if (response.status === 503 && body.includes('Olympus is starting:')) return true;
    if (response.status !== 200 || !response.headers.get('content-type')?.includes('text/html')) return false;
    if (page === 'Sources') return body.includes('class="srcrows"');
    if (!body.includes('id="olympus-panel"')) return false;
    // Home is a shell. Its panel is populated by the dashboard tool through this same owner-session request.
    const panel = await fetch('/dashboard/tools/call', {
      ...init, method: 'POST', headers: { accept: 'application/json', 'content-type': 'application/json' },
      body: JSON.stringify({ name: DASHBOARD_TOOL_NAME, arguments: {} }),
    });
    authRefused = panel.status === 401 || panel.status === 403;
    const result = await panel.json() as { structuredContent?: unknown; isError?: boolean };
    return panel.ok && Boolean(result.structuredContent) && result.isError !== true;
  })().catch(() => false);
  return { page, at, ms: watchNow() - at, answered, timeout: signal.aborted, ...(authRefused ? { authRefused } : {}) };
}

const LEDGER_WAL_SUFFIX = '.tier-ledger.sqlite-wal';
const WAL_WARNING_BYTES = 1_000_000_000;

type WorkerFetch = (path: string, init?: RequestInit) => Promise<Response>;
type WalSizes = Record<string, number>;
type Sample = { at: number; health: number | null; starting: boolean; wal_bytes: WalSizes };
type RetryAfter = { seconds: number } | { date_ms: number } | 'invalid' | null;
type Owner = {
  dashboard: { status: number | null; ms: number; starting_copy_seen: boolean | null };
  click: { status: number | null; ms: number; retry_after: RetryAfter } | null;
};
type WatchEntry = Sample | { pageSample: PageSample } | { startupStarted: number }
  | { startupEnded: number; bothBuilds: boolean } | { hiddenCopy: HiddenCopyBuilds }
  | { qualifyStarted: number } | { startupAsk: StartupAsk } | { watchEnded: number; stopped: boolean } | { owner_session_minted: boolean } | { owner: Owner } | { owner_session_after_ready_status: number | null };

/** An Ask accepted during start-up: judged only on saying it is still starting and completing by itself; its time is reported. */
export interface StartupAsk { status: number | null; ms: number; saidStarting: boolean; completed: boolean; error?: string }

export function startupAskCheck(ask: StartupAsk | undefined): CheckResult {
  const id = 'qualify.ask-startup';
  const title = 'An Ask accepted during start-up says Olympus is still starting and completes by itself (time reported)';
  if (!ask) return { id, title, status: 'skip', detail: 'No Ask was taken during start-up (start-up unobserved or too short)' };
  const ok = ask.completed && ask.saidStarting;
  const why = !ask.completed ? (ask.status === null ? `lost or cancelled (${ask.error ?? 'no response'})` : `cancelled (HTTP ${ask.status})`) : !ask.saidStarting ? 'silent: the answer never said Olympus was still starting' : 'completed and said it was still starting';
  return { id, title, status: ok ? 'pass' : 'fail', ms: ask.ms, detail: `${why} · ${ask.ms} ms` };
}

export interface CutoverSummary {
  startupAsk?: StartupAsk;
  startup?: PageWindow;
  bothBuilds?: boolean;
  hiddenCopy?: HiddenCopyBuilds;
  qualification?: PageWindow;
  old_engine_down_at: number | null;
  new_engine_ready_at: number | null;
  boot_to_ready_ms: number | null;
  wals: { path: string; ledger: boolean; at_down_bytes: number | null; boot_peak_bytes: number | null }[];
  largest_wal: { path: string; bytes: number } | null;
  owner_session_minted: boolean | null;
  owner_session_after_ready_status: number | null;
  owner: Owner | null;
}

/** The data root can be moved or replaced between listing a directory and statting a file. */
function walSizes(root: string): WalSizes {
  const sizes: [string, number][] = [];
  const walk = (dir: string): void => {
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory() && entry.name !== 'models') walk(path);
      if (entry.isFile() && entry.name.endsWith('.sqlite-wal')) {
        try { sizes.push([relative(root, path), statSync(path).size]); } catch { /* the WAL can disappear during checkpoint */ }
      }
    }
  };
  walk(root);
  return Object.fromEntries(sizes);
}

async function sampleHealth(fetch: WorkerFetch): Promise<Pick<Sample, 'health' | 'starting'>> {
  const response = await fetch('/v1/health', { signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS), redirect: 'manual' }).catch(() => undefined);
  if (!response) return { health: null, starting: false };
  if (response.status !== 503) {
    void response.body?.cancel().catch(() => {});
    return { health: response.status, starting: false };
  }
  const body = await response.json().catch(() => undefined) as { status?: string; worker_restarting?: boolean; error?: { code?: string } } | undefined;
  return { health: response.status, starting: body?.status === 'starting' || body?.worker_restarting === true || body?.error?.code === 'worker_restarting' };
}

function retryAfter(header: string | null): RetryAfter {
  if (header === null) return null;
  if (/^\d+$/.test(header) && Number.isSafeInteger(Number(header))) return { seconds: Number(header) };
  const date = Date.parse(header);
  return /^[A-Za-z]{3}, /.test(header) && Number.isFinite(date) ? { date_ms: date } : 'invalid';
}

async function observeOwner(fetch: WorkerFetch, sessionFetch: WorkerFetch | undefined): Promise<Owner> {
  const dashboard = async (): Promise<Owner['dashboard']> => {
    const started = performance.now();
    const response = await (sessionFetch ?? fetch)('/dashboard', {
      headers: { accept: 'text/html' }, signal: AbortSignal.timeout(OWNER_TIMEOUT_MS), redirect: 'manual',
    }).catch(() => undefined);
    const body = await response?.text().catch(() => undefined);
    return {
      status: response?.status ?? null,
      ms: Math.round(performance.now() - started),
      // worker-front-proxy renders the first phrase; the dashboard vocabulary supplies the update view's restart copy.
      starting_copy_seen: body === undefined ? null : body.includes('Olympus is starting:')
        || (response?.status === 503 && body.includes(DASHBOARD_UPDATE_COPY.unreachable)),
    };
  };
  const click = async (): Promise<Owner['click']> => {
    if (!sessionFetch) return null;
    const started = performance.now();
    // Lock in the dashboard only clears this probe's cookie. Authentication is the pre-upgrade session and its CSRF token.
    const response = await sessionFetch('/dashboard/control/session/lock', {
      method: 'POST', headers: { accept: 'application/json' }, signal: AbortSignal.timeout(OWNER_TIMEOUT_MS), redirect: 'manual',
    }).catch(() => undefined);
    void response?.body?.cancel().catch(() => {});
    return { status: response?.status ?? null, ms: Math.round(performance.now() - started), retry_after: retryAfter(response?.headers.get('retry-after') ?? null) };
  };
  const [page, action] = await Promise.all([dashboard(), click()]);
  return { dashboard: page, click: action };
}

async function checkOwnerSession(session: WorkerFetch): Promise<number | null> {
  // The starting front can return 503 before authenticating either boot request. Once healthy, read with the same cookie.
  const response = await session('/dashboard', {
    headers: { accept: 'text/html' }, signal: AbortSignal.timeout(OWNER_TIMEOUT_MS), redirect: 'manual',
  }).catch(() => undefined);
  void response?.body?.cancel().catch(() => {});
  return response?.status ?? null;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export async function watchCutover(workDir: string, dataDir: string, seconds: number, fetch: WorkerFetch, mint: () => Promise<WorkerFetch | undefined>, options: { fresh?: boolean; newFront?: () => string | undefined; observeBuilds?: () => HiddenCopyBuilds | undefined; startupAsk?: () => Promise<StartupAsk> } = {}): Promise<void> {
  const log = join(workDir, CUTOVER_LOG);
  const stop = join(workDir, CUTOVER_STOP);
  writeFileSync(log, '', { mode: 0o600 });
  const append = (entry: WatchEntry) => appendFileSync(log, `${JSON.stringify(entry)}\n`);
  const session = options.fresh ? undefined : await mint().catch(() => undefined);
  append({ owner_session_minted: session !== undefined });
  const end = performance.now() + seconds * 1000;
  let samples = Promise.resolve();
  let owner: Promise<void> | undefined;
  let ownerAfterReady: Promise<void> | undefined;
  let answered = false;
  let first = true;
  let candidate = options.fresh === true;
  let qualified = false;
  let startupEnded = options.fresh === true;
  let lastBuildReceipt = '';
  let nextPage = 0;
  let pageSession = session;
  let minting: Promise<void> | undefined;
  const refreshSession = () => {
    minting ??= mint().then(next => { if (next) pageSession = next; }, () => {}).finally(() => { minting = undefined; });
  };
  if (options.fresh) refreshSession();
  const pages = new Set<Promise<void>>();
  let startupAsking: Promise<void> | undefined;
  while (performance.now() < end && !existsSync(stop)) {
    const tick = performance.now();
    const at = watchNow();
    if (!qualified) {
      const frontAtDispatch = options.newFront?.();
      const health = sampleHealth(fetch).then(reply => ({ reply, seenAt: watchNow() }));
      const wal_bytes = options.fresh ? {} : walSizes(dataDir);
      samples = samples.then(async () => {
        const { reply, seenAt } = await health;
        if (qualified) return;
        append({ at, ...reply, wal_bytes });
        if (!options.fresh && !owner && (reply.starting || (answered && reply.health === null))) {
          owner = observeOwner(fetch, session).then(result => append({ owner: result }));
        }
        const newFrontAnswered = options.observeBuilds
          ? frontAtDispatch && (reply.starting || reply.health === 200)
          : reply.starting || (reply.health === 200 && (frontAtDispatch || owner));
        if (!candidate && newFrontAnswered) {
          candidate = true;
          append({ startupStarted: seenAt });
        }
        if (candidate && reply.health === 200 && (options.fresh || !options.observeBuilds || frontAtDispatch)) {
          qualified = true;
          append({ qualifyStarted: seenAt });
          if (owner && session) ownerAfterReady = checkOwnerSession(session).then(status => append({ owner_session_after_ready_status: status }));
        }
        if (reply.health !== null) answered = true;
        if (first) {
          writeFileSync(join(workDir, CUTOVER_READY), '');
          first = false;
        }
      });
    }
    if (candidate && !startupEnded && options.startupAsk && !startupAsking) {
      // One Ask while starting, in the first minutes; no clock of ours ends it.
      startupAsking = options.startupAsk().then(ask => append({ startupAsk: ask }), error => append({ startupAsk: { status: null, ms: 0, saidStarting: false, completed: false, error: String(error).slice(0, 200) } }));
    }
    if (candidate && !startupEnded) {
      const hiddenCopy = options.observeBuilds?.();
      if (hiddenCopy) {
        const receipt = JSON.stringify(hiddenCopy);
        if (receipt !== lastBuildReceipt) {
          append({ hiddenCopy });
          lastBuildReceipt = receipt;
        }
        if (hiddenCopy.finished.front && hiddenCopy.finished.background) {
          append({ startupEnded: at, bothBuilds: true });
          startupEnded = true;
        }
      }
    }
    if (candidate && at >= nextPage) {
      nextPage = at + PAGE_SAMPLE_MS;
      // Remint after restarts if the old cookie no longer opens either page.
      for (const page of Object.keys(PAGES) as Page[]) {
        const reading = samplePage(pageSession ?? fetch, page, at).then(sample => {
          append({ pageSample: sample });
          if (qualified && (!pageSession || sample.authRefused)) refreshSession();
        });
        pages.add(reading);
        void reading.then(() => pages.delete(reading));
      }
    }
    await sleep(Math.max(0, SAMPLE_MS - (performance.now() - tick)));
  }
  append({ watchEnded: watchNow(), stopped: existsSync(stop) });
  await samples;
  await Promise.all([owner, ownerAfterReady, ...pages, minting, startupAsking]);
  writeFileSync(join(workDir, CUTOVER_DONE), '');
}

/** Summarize the evidence in sampling order, even if the watcher stopped before it could finish. */
export async function cutoverReport(workDir: string): Promise<CutoverSummary | undefined> {
  const log = join(workDir, CUTOVER_LOG);
  if (!existsSync(log)) return undefined;
  const done = join(workDir, CUTOVER_DONE);
  if (existsSync(join(workDir, CUTOVER_STOP))) {
    const deadline = performance.now() + PAGE_BOUND_MS + 2 * SAMPLE_MS;
    while (!existsSync(done) && performance.now() < deadline) await sleep(SAMPLE_MS);
  }
  return summarizeCutover(readFileSync(log, 'utf8'));
}

export function summarizeCutover(log: string): CutoverSummary {
  const summary: CutoverSummary = {
    old_engine_down_at: null, new_engine_ready_at: null, boot_to_ready_ms: null,
    wals: [], largest_wal: null, owner_session_minted: null, owner_session_after_ready_status: null, owner: null,
  };
  const paths = new Set<string>();
  const bootPeaks = new Map<string, number>();
  let answered = false;
  let down: Sample | undefined;
  const pageSamples: PageSample[] = [];
  let startupStarted: number | undefined, startupEnded: number | undefined, qualifyStarted: number | undefined, watchEnded: number | undefined;
  let stopped = false;
  for (const line of log.split('\n').slice(0, -1)) {
    const entry = JSON.parse(line) as WatchEntry;
    if ('pageSample' in entry) { pageSamples.push(entry.pageSample); continue; }
    if ('startupStarted' in entry) { startupStarted = entry.startupStarted; continue; }
    if ('startupEnded' in entry) { startupEnded = entry.startupEnded; summary.bothBuilds = entry.bothBuilds; continue; }
    if ('hiddenCopy' in entry) { summary.hiddenCopy = entry.hiddenCopy; continue; }
    if ('qualifyStarted' in entry) { qualifyStarted = entry.qualifyStarted; continue; }
    if ('startupAsk' in entry) { summary.startupAsk = entry.startupAsk; continue; }
    if ('watchEnded' in entry) { watchEnded = entry.watchEnded; stopped = entry.stopped; continue; }
    if ('owner_session_minted' in entry) { summary.owner_session_minted = entry.owner_session_minted; continue; }
    if ('owner' in entry) { summary.owner = entry.owner; continue; }
    if ('owner_session_after_ready_status' in entry) { summary.owner_session_after_ready_status = entry.owner_session_after_ready_status; continue; }
    if (!down && answered && (entry.health === null || entry.starting)) down = entry;
    if (entry.health !== null) answered = true;
    const boot = down !== undefined && summary.new_engine_ready_at === null;
    for (const [path, bytes] of Object.entries(entry.wal_bytes)) {
      paths.add(path);
      if (!summary.largest_wal || bytes > summary.largest_wal.bytes) summary.largest_wal = { path, bytes };
      if (boot) bootPeaks.set(path, Math.max(bytes, bootPeaks.get(path) ?? 0));
    }
    if (boot && entry.health === 200) summary.new_engine_ready_at = entry.at;
  }
  summary.old_engine_down_at = down?.at ?? null;
  if (down && summary.new_engine_ready_at !== null) summary.boot_to_ready_ms = summary.new_engine_ready_at - down.at;
  summary.wals = [...paths].sort().map(path => ({
    path, ledger: path.endsWith(LEDGER_WAL_SUFFIX),
    at_down_bytes: down ? down.wal_bytes[path] ?? 0 : null,
    boot_peak_bytes: down ? bootPeaks.get(path) ?? 0 : null,
  }));
  const through = watchEnded ?? pageSamples.reduce((last, sample) => Math.max(last, sample.at + sample.ms), Math.max(startupStarted ?? 0, qualifyStarted ?? 0));
  if (startupStarted !== undefined) summary.startup = summarizePages(pageSamples, startupStarted, startupEnded ?? through);
  // After READY (both hidden-copy builds logged) the 1 s rule applies; without a build receipt, from the first healthy reply.
  const readyAt = startupEnded ?? qualifyStarted;
  if (readyAt !== undefined && watchEnded !== undefined && stopped) summary.qualification = summarizePages(pageSamples, readyAt, watchEnded);
  return summary;
}

export function cutoverChecks(summary: CutoverSummary | undefined, gateStartup = true): CheckResult[] {
  const number = (value: number | null | undefined, unit = '') => Number.isFinite(value) ? `${value}${unit}` : 'unobserved';
  const wals = Array.isArray(summary?.wals) ? summary.wals.filter(wal => wal && typeof wal === 'object') : [];
  const overLimit = wals.some(wal => wal.ledger === true && Number.isFinite(wal.at_down_bytes) && (wal.at_down_bytes ?? 0) > WAL_WARNING_BYTES);
  const sizes = wals.map((wal, i) => `${wal.ledger === true ? 'Ledger' : 'Other'} WAL ${i + 1}: ${number(wal.at_down_bytes, ' B')} at shutdown, ${number(wal.boot_peak_bytes, ' B')} boot peak`);
  const walDetail = summary ? [...sizes, `Overall peak: ${number(summary.largest_wal?.bytes, ' B')}`].join(' · ') : 'Cutover watch unavailable';
  const dashboard = summary?.owner?.dashboard;
  const click = summary?.owner?.click;
  const retry = click?.retry_after;
  const retryDetail = retry && typeof retry === 'object' ? ('seconds' in retry ? number(retry.seconds, ' s') : `${number(retry.date_ms, ' ms')} since epoch`) : retry === 'invalid' ? 'invalid' : 'absent';
  const starting = dashboard?.starting_copy_seen;
  const refused = (status: number | null | undefined) => status === 401 || status === 403;
  const afterReady = summary?.owner_session_after_ready_status;
  let sessionFinding = 'Pre-upgrade owner session survival unobserved';
  if (summary?.owner_session_minted === false) sessionFinding = 'Pre-upgrade owner session could not be minted';
  else if (refused(afterReady)) sessionFinding = 'Pre-upgrade owner session was refused after restart';
  else if (afterReady === 200) sessionFinding = 'Pre-upgrade owner session survived the restart';
  else if (refused(click?.status) || refused(dashboard?.status)) sessionFinding = 'Pre-upgrade owner session was refused during boot';
  const startup = dashboardAvailabilityCheck(summary?.startup, true, summary?.bothBuilds);
  const hiddenCopy = summary?.hiddenCopy;
  if (hiddenCopy) {
    const notes = Object.entries(hiddenCopy.finished).map(([role, build]) =>
      `${role} built ${build.stores} stores in ${build.ms} ms`);
    if (hiddenCopy.backgroundWait) notes.push(`background waited ${hiddenCopy.backgroundWait.ms} ms (${hiddenCopy.backgroundWait.reason})`);
    for (const role of ['front', 'background'] as const) {
      const count = hiddenCopy.warnings.filter(warning => warning === role).length;
      if (count) notes.push(`${role} logged ${count} hidden-copy build warning(s)`);
    }
    if (notes.length) startup.detail += ` · ${notes.join(' · ')}`;
  }
  return [
    ...(gateStartup ? [startup, startupAskCheck(summary?.startupAsk)] : []),
    { id: 'upgrade.cutover.wal', title: 'WAL sizes during the engine cutover', status: overLimit ? 'warn' : 'pass',
      detail: summary?.old_engine_down_at == null && summary ? `Shutdown unobserved · ${walDetail}` : walDetail },
    { id: 'upgrade.cutover.boot', title: 'Time from old engine down to new engine ready', status: 'reported', detail: number(summary?.boot_to_ready_ms, ' ms') },
    { id: 'upgrade.cutover.owner', title: 'Dashboard and owner click during boot', status: 'reported',
      detail: `Dashboard status ${number(dashboard?.status)}, ${number(dashboard?.ms, ' ms')}, starting copy ${starting === true ? 'seen' : starting === false ? 'absent' : 'unobserved'} · Click status ${number(click?.status)}, ${number(click?.ms, ' ms')}, Retry-After ${retryDetail} · ${sessionFinding}` },
  ];
}
