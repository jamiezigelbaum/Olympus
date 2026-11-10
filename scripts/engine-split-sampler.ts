// Read-only live sampler for the engine split's done-when (#1064,
// docs/design/engine-split.md, "Done when"). It asks a running install's
// worker the questions an owner would, over the worker's existing read
// surfaces, and reads process memory from the operating system:
//
//   dashboard_read_ms  a few GETs of the dashboard's JSON view (/dashboard.json)
//   heartbeat_ms       a GET of /v1/health every --heartbeat-ms; its max is the
//                      longest control-path freeze the sampler saw
//   judge              the judge's backlog from /v1/source/index/status and its
//                      net change a minute (see below)
//   rss_mb             resident memory of the worker (single or front) and of
//                      the background process, when there is one
//
// One JSON line per interval, to stdout or appended to --out.
//
//   bun scripts/engine-split-sampler.ts [--interval-s 60] [--heartbeat-ms 1000]
//     [--dashboard-reads 3] [--intervals N] [--timeout-s 120] [--out FILE]
//     [--worker-pid PID] [--background-pid PID]
//
// It never writes to the install: it sends GETs only, opens no store, and
// refuses an --out inside the Olympus data root. It reaches the worker the
// way the CLI does (the configured worker URL, the owner socket on Linux)
// and presents the worker token the way `callWorkerCli` resolves it; the
// token goes only in the Authorization header and is never printed.
//
// Judge rate: no read surface counts verdicts today (the sniffer's own
// throughput totals stay in its process), so `net_verdicts_per_min` is the
// drop in items still being checked, a minute. New items arriving during an
// import raise the backlog, so it is a lower bound while an import runs.
//
// Process ids: given with --worker-pid / --background-pid, or found on Linux
// as the processes running `__worker-service-run`; a process whose
// environment carries OLYMPUS_WORKER_ENGINE_ROLE=background is the
// background. Only that one entry is compared; nothing else in the
// environment is kept or printed.

import { appendFileSync, readdirSync, readFileSync } from 'node:fs';
import { relative, resolve, isAbsolute } from 'node:path';
import { loadConfig, normalizeSourceWorkerBaseUrl } from '../src/core/config.ts';
import { ENGINE_ROLE_ENV } from '../src/core/engine-split.ts';
import { olympusDataRoot } from '../src/core/olympus-layout.ts';
import { resolveWorkerAuthToken } from '../src/core/worker-auth.ts';
import { createWorkerFetch } from '../src/core/worker-transport.ts';

export interface SamplerClock {
  now(): number;
  sleep(ms: number): Promise<void>;
}

export interface SamplerOptions {
  /** The worker's /v1 API base, e.g. http://127.0.0.1:8787/v1. */
  apiBase: string;
  /** The worker bearer; sent only as an Authorization header. */
  authToken?: string;
  fetchImpl?: typeof fetch;
  clock?: SamplerClock;
  intervalMs?: number;
  heartbeatMs?: number;
  dashboardReads?: number;
  /** Stop after this many intervals; unbounded when absent. */
  intervals?: number;
  timeoutMs?: number;
  /** Resident memory in MB for a pid, or undefined when it cannot be read. */
  rssMb?: (pid: number) => number | undefined;
  /** The worker (single or front) and background pids, looked up each interval. */
  pids?: () => { worker?: number; background?: number };
  emit: (line: Record<string, unknown>) => void;
}

const REAL_CLOCK: SamplerClock = {
  now: () => performance.timeOrigin + performance.now(),
  sleep: (ms) => new Promise((done) => setTimeout(done, ms)),
};

function stats(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  const at = (q: number) => Math.round(sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? 0);
  return sorted.length ? { n: sorted.length, p50: at(0.5), p95: at(0.95), max: Math.round(sorted.at(-1)!) } : { n: 0 };
}

/** Linux resident memory from /proc; elsewhere `ps`. Undefined when the process is gone. */
export function processRssMb(pid: number): number | undefined {
  try {
    const line = readFileSync(`/proc/${pid}/status`, 'utf8').split('\n').find((entry) => entry.startsWith('VmRSS:'));
    return line ? Math.round(Number(line.replace(/\D+/g, '')) / 1024) : undefined;
  } catch {
    if (process.platform === 'linux') return undefined;
    const result = Bun.spawnSync(['ps', '-o', 'rss=', '-p', String(pid)], { stdout: 'pipe', stderr: 'ignore', timeout: 5_000 });
    const kb = Number(result.stdout.toString().trim());
    return result.exitCode === 0 && Number.isFinite(kb) && kb > 0 ? Math.round(kb / 1024) : undefined;
  }
}

/** The worker processes on Linux, by their command line; the background by its one role entry. */
export function findWorkerPids(procRoot = '/proc'): { worker?: number; background?: number } {
  const found: { worker?: number; background?: number } = {};
  let entries: string[];
  try { entries = readdirSync(procRoot); } catch { return found; }
  const roleEntry = Buffer.from(`${ENGINE_ROLE_ENV}=background\0`);
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      const argv = readFileSync(`${procRoot}/${entry}/cmdline`).toString('utf8').split('\0');
      if (!argv.includes('__worker-service-run')) continue;
      // Compared in place and dropped; nothing from the environment is kept.
      const background = Buffer.concat([readFileSync(`${procRoot}/${entry}/environ`), Buffer.from('\0')]).includes(roleEntry);
      if (background) found.background ??= Number(entry);
      else found.worker ??= Number(entry);
    } catch { /* gone, or not ours to read */ }
  }
  return found;
}

/** Runs the sampler until `intervals` are done (or forever). */
export async function runSampler(options: SamplerOptions): Promise<void> {
  const clock = options.clock ?? REAL_CLOCK;
  const fetchImpl = options.fetchImpl ?? fetch;
  const intervalMs = options.intervalMs ?? 60_000;
  const heartbeatMs = options.heartbeatMs ?? 1_000;
  const dashboardReads = options.dashboardReads ?? 3;
  const timeoutMs = options.timeoutMs ?? 120_000;
  const rssMb = options.rssMb ?? processRssMb;
  const pids: () => { worker?: number; background?: number } = options.pids ?? (() => ({}));
  const apiBase = options.apiBase.replace(/\/+$/, '');
  const root = apiBase.replace(/\/v1$/, '');
  const headers: Record<string, string> = options.authToken ? { Authorization: `Bearer ${options.authToken}` } : {};

  /** One timed GET. A timeout or refusal is counted as a failure with its time. */
  const timedGet = async (url: string, auth: boolean): Promise<{ ms: number; ok: boolean; body?: unknown; error?: string }> => {
    const started = clock.now();
    try {
      const response = await fetchImpl(url, { method: 'GET', headers: auth ? headers : {}, redirect: 'error', signal: AbortSignal.timeout(timeoutMs) });
      const text = await response.text();
      const ms = clock.now() - started;
      if (!response.ok) return { ms, ok: false, error: `HTTP ${response.status}` };
      try { return { ms, ok: true, body: JSON.parse(text) }; } catch { return { ms, ok: true }; }
    } catch (error) {
      const name = error instanceof Error ? error.name : 'Error';
      return { ms: clock.now() - started, ok: false, error: name === 'TimeoutError' ? 'timeout' : 'unreachable' };
    }
  };

  let previous: { at: number; checking: number } | undefined;
  for (let interval = 0; options.intervals === undefined || interval < options.intervals; interval++) {
    const started = clock.now();
    const dashboard: number[] = [];
    let dashboardFailures = 0;
    for (let n = 0; n < dashboardReads; n++) {
      const read = await timedGet(`${root}/dashboard.json`, true);
      if (read.ok) dashboard.push(read.ms); else dashboardFailures++;
    }
    const status = await timedGet(`${apiBase}/source/index/status?include_items=false`, true);
    const tier = (status.body as { tier_classification?: { checking_items?: unknown; remaining_questions?: unknown } } | undefined)?.tier_classification;
    const checking = typeof tier?.checking_items === 'number' ? tier.checking_items : undefined;
    const remaining = typeof tier?.remaining_questions === 'number' ? tier.remaining_questions : undefined;
    const statusAt = clock.now();
    const netPerMin = checking !== undefined && previous && statusAt > previous.at
      ? Math.round(((previous.checking - checking) * 60_000 / (statusAt - previous.at)) * 10) / 10
      : null;
    if (checking !== undefined) previous = { at: statusAt, checking };

    const beats: number[] = [];
    let beatFailures = 0;
    while (clock.now() - started < intervalMs) {
      const beat = await timedGet(`${apiBase}/health`, false);
      beats.push(beat.ms);
      if (!beat.ok) beatFailures++;
      const wait = Math.min(heartbeatMs - beat.ms, intervalMs - (clock.now() - started));
      if (wait > 0) await clock.sleep(wait);
    }

    const found = pids();
    options.emit({
      at: new Date(clock.now()).toISOString(),
      interval_s: Math.round((clock.now() - started) / 1000),
      dashboard_read_ms: { ...stats(dashboard), failures: dashboardFailures },
      heartbeat_ms: { ...stats(beats), failures: beatFailures },
      judge: status.ok
        ? { checking_items: checking ?? null, remaining_questions: remaining ?? null, net_verdicts_per_min: netPerMin }
        : { error: status.error ?? 'unreadable' },
      rss_mb: {
        worker: found.worker !== undefined ? rssMb(found.worker) ?? null : null,
        background: found.background !== undefined ? rssMb(found.background) ?? null : null,
      },
    });
  }
}

function inside(parent: string, child: string): boolean {
  const path = relative(resolve(parent), resolve(child));
  return path === '' || (!path.startsWith('..') && !isAbsolute(path));
}

async function main(): Promise<void> {
  const args = new Map<string, string>();
  for (let n = 2; n < process.argv.length; n += 2) args.set(process.argv[n]!.replace(/^--/, ''), process.argv[n + 1] ?? '');
  const number = (name: string) => (args.has(name) ? Number(args.get(name)) : undefined);
  const out = args.get('out');
  if (out && inside(olympusDataRoot(process.env), out)) {
    console.error('engine-split-sampler: --out is inside the Olympus data root; the sampler never writes to the install.');
    process.exit(2);
  }
  const env = process.env;
  const config = loadConfig(env);
  const workerPid = number('worker-pid');
  const backgroundPid = number('background-pid');
  await runSampler({
    apiBase: normalizeSourceWorkerBaseUrl(config.email.baseUrl),
    ...(resolveWorkerAuthToken(env, config) ? { authToken: resolveWorkerAuthToken(env, config)! } : {}),
    fetchImpl: createWorkerFetch({ env }),
    ...(number('interval-s') !== undefined ? { intervalMs: number('interval-s')! * 1000 } : {}),
    ...(number('heartbeat-ms') !== undefined ? { heartbeatMs: number('heartbeat-ms')! } : {}),
    ...(number('dashboard-reads') !== undefined ? { dashboardReads: number('dashboard-reads')! } : {}),
    ...(number('intervals') !== undefined ? { intervals: number('intervals')! } : {}),
    ...(number('timeout-s') !== undefined ? { timeoutMs: number('timeout-s')! * 1000 } : {}),
    pids: () => {
      const found = workerPid === undefined || backgroundPid === undefined ? findWorkerPids() : {};
      return { ...found, ...(workerPid !== undefined ? { worker: workerPid } : {}), ...(backgroundPid !== undefined ? { background: backgroundPid } : {}) };
    },
    emit: (line) => {
      const text = `${JSON.stringify(line)}\n`;
      if (out) appendFileSync(out, text, { mode: 0o600 }); else process.stdout.write(text);
    },
  });
}

if (import.meta.main) await main();
