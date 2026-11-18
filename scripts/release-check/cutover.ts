import { appendFileSync, existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { DASHBOARD_UPDATE_COPY } from '../../src/workers/dashboard/vocabulary.ts';
import type { CheckResult } from './report.ts';

export const CUTOVER_LOG = 'cutover-watch.jsonl';
export const CUTOVER_READY = 'cutover-watch.ready';
export const CUTOVER_STOP = 'cutover-watch.stop';
export const CUTOVER_DONE = 'cutover-watch.done';
const HEALTH_TIMEOUT_MS = 2_000;
const OWNER_TIMEOUT_MS = 5_000; // The worker proxy can take 2.5 s to serve the starting page.
const SAMPLE_MS = 250;
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
type WatchEntry = Sample | { owner_session_minted: boolean } | { owner: Owner } | { owner_session_after_ready_status: number | null };

export interface CutoverSummary {
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

export async function watchCutover(workDir: string, dataDir: string, seconds: number, fetch: WorkerFetch, mint: () => Promise<WorkerFetch | undefined>): Promise<void> {
  const log = join(workDir, CUTOVER_LOG);
  const stop = join(workDir, CUTOVER_STOP);
  writeFileSync(log, '', { mode: 0o600 });
  const append = (entry: WatchEntry) => appendFileSync(log, `${JSON.stringify(entry)}\n`);
  const session = await mint().catch(() => undefined);
  append({ owner_session_minted: session !== undefined });
  const end = performance.now() + seconds * 1000;
  let samples = Promise.resolve();
  let owner: Promise<void> | undefined;
  let ownerAfterReady: Promise<void> | undefined;
  let answered = false;
  let first = true;
  while (performance.now() < end && !existsSync(stop)) {
    const tick = performance.now();
    const at = Date.now();
    const health = sampleHealth(fetch);
    const wal_bytes = walSizes(dataDir);
    // Start a probe at every tick, even if an earlier health request is using its full timeout.
    // Write the observations in sample order so the summary pairs the cutoff with that tick's WAL sizes.
    samples = samples.then(async () => {
      const reply = await health;
      append({ at, ...reply, wal_bytes });
      if (!owner && (reply.starting || (answered && reply.health === null))) {
        owner = observeOwner(fetch, session).then(result => append({ owner: result }));
      }
      if (owner && session && !ownerAfterReady && reply.health === 200) {
        ownerAfterReady = checkOwnerSession(session).then(status => append({ owner_session_after_ready_status: status }));
      }
      if (reply.health !== null) answered = true;
      if (first) {
        writeFileSync(join(workDir, CUTOVER_READY), '');
        first = false;
      }
    });
    await sleep(Math.max(0, SAMPLE_MS - (performance.now() - tick)));
  }
  await samples;
  await Promise.all([owner, ownerAfterReady]);
  writeFileSync(join(workDir, CUTOVER_DONE), '');
}

/** Summarize the evidence in sampling order, even if the watcher stopped before it could finish. */
export async function cutoverReport(workDir: string): Promise<CutoverSummary | undefined> {
  const log = join(workDir, CUTOVER_LOG);
  if (!existsSync(log)) return undefined;
  const done = join(workDir, CUTOVER_DONE);
  if (existsSync(join(workDir, CUTOVER_STOP))) {
    const deadline = performance.now() + HEALTH_TIMEOUT_MS + OWNER_TIMEOUT_MS + 2 * SAMPLE_MS;
    while (!existsSync(done) && performance.now() < deadline) await sleep(SAMPLE_MS);
  }
  const summary: CutoverSummary = {
    old_engine_down_at: null, new_engine_ready_at: null, boot_to_ready_ms: null,
    wals: [], largest_wal: null, owner_session_minted: null, owner_session_after_ready_status: null, owner: null,
  };
  const paths = new Set<string>();
  const bootPeaks = new Map<string, number>();
  let answered = false;
  let down: Sample | undefined;
  for (const line of readFileSync(log, 'utf8').split('\n').slice(0, -1)) {
    const entry = JSON.parse(line) as WatchEntry;
    if ('owner_session_minted' in entry) { summary.owner_session_minted = entry.owner_session_minted; continue; }
    if ('owner' in entry) { summary.owner = entry.owner; continue; }
    if ('owner_session_after_ready_status' in entry) { summary.owner_session_after_ready_status = entry.owner_session_after_ready_status; continue; }
    if (!down && answered && entry.health === null) down = entry;
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
  return summary;
}

export function cutoverChecks(summary: CutoverSummary | undefined): CheckResult[] {
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
  return [
    { id: 'upgrade.cutover.wal', title: 'WAL sizes during the engine cutover', status: overLimit ? 'warn' : 'pass',
      detail: summary?.old_engine_down_at == null && summary ? `Shutdown unobserved · ${walDetail}` : walDetail },
    { id: 'upgrade.cutover.boot', title: 'Time from old engine down to new engine ready', status: 'reported', detail: number(summary?.boot_to_ready_ms, ' ms') },
    { id: 'upgrade.cutover.owner', title: 'Dashboard and owner click during boot', status: 'reported',
      detail: `Dashboard status ${number(dashboard?.status)}, ${number(dashboard?.ms, ' ms')}, starting copy ${starting === true ? 'seen' : starting === false ? 'absent' : 'unobserved'} · Click status ${number(click?.status)}, ${number(click?.ms, ' ms')}, Retry-After ${retryDetail} · ${sessionFinding}` },
  ];
}
