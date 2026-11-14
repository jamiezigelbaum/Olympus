/**
 * The engine split on a real Mac (lane 1's brief, 14 Nov 2026): the engine host holds the worker's loopback port (8010) and
 * the front and background run behind it, so a model change restarts both while the page stays up.
 *
 * - `split.restart`: with the dashboard open, the answer model is changed and saved on Privacy settings. Every request to
 *   127.0.0.1:8010 meanwhile must get a 200 or the host's 503 "starting" answer, never a refused connection; within the startup
 *   cap health is back at 200, with a new front process and the same engine host. The model is put back afterwards.
 * - `split.memory`: resident memory of each Olympus process (engine host, front, background, model processes, embedding drain,
 *   relay), sampled while the account checks ran, as peak and steady, with the machine's RAM and what else was running.
 *
 * Only numbers and process names leave the machine: the samplers read process environments on the machine (to tell the front
 * from the background) and print pids, sizes and roles, never an environment or a command line's arguments.
 */
import type { Machine } from './machine.ts';
import type { CheckResult } from './report.ts';

export const SPLIT_PORT = 8010;
/** How long the engine may take to be back after a model change (the startup cap). */
export const SPLIT_STARTUP_CAP_S = 180;

const quote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;

/**
 * One line per Olympus process, `role pid rss_kb`, then `ram <bytes>` and `other <name> <rss_kb>` for the five largest other
 * processes. The role comes from the command (model processes, embedding drain, relay), the engine host from the port's
 * listener, then the split role from the environment (OLYMPUS_WORKER_ENGINE_ROLE). Works on macOS and Linux.
 */
export const RSS_SAMPLE = `host=$( (lsof -nP -iTCP:${SPLIT_PORT} -sTCP:LISTEN -t 2>/dev/null || ss -ltnpH "sport = :${SPLIT_PORT}" 2>/dev/null | sed -n 's/.*pid=\\([0-9]*\\).*/\\1/p') | head -n 1)
out=$(ps axeww -o pid=,rss=,command= 2>/dev/null | awk -v host="$host" '
  function base(path,  n, a) { n = split(path, a, "/"); return a[n] }
  {
    pid = $1; rss = $2; cmd = $0; role = "";
    if (cmd ~ /ps axeww|awk -v host=/) next;
    if (cmd ~ /litert-helper\\.js/) role = "embedding-model";
    else if (cmd ~ /model-worker\\.js/) role = "answer-model";
    else if (base($3) == "llama-server") role = "private-model";
    else if (cmd ~ /embedding-drain\\.js/) role = "embedding-drain";
    else if (cmd ~ /secret-scan-worker\\.js/) role = "secret-scan";
    else if (cmd ~ /__relay-service-run/) role = "relay";
    else if (pid == host) role = "engine-host";
    else if (cmd ~ /OLYMPUS_WORKER_ENGINE_ROLE=front/) role = "front";
    else if (cmd ~ /OLYMPUS_WORKER_ENGINE_ROLE=background/) role = "background";
    else if (cmd ~ /[Oo]lympus/ && cmd ~ /(bun|node)/) role = "other-olympus";
    sw = 0; f = "/proc/" pid "/status";
    if (role != "") { while ((getline l < f) > 0) if (l ~ /^VmSwap:/) { split(l, v, " "); sw = v[2] } close(f); print role, pid, rss, sw }
    else if (rss > 0) other[base($3)] += rss;
  }
  END { for (name in other) print "other", name, other[name] }')
printf '%s\\n' "$out" | grep -v '^other '
printf '%s\\n' "$out" | grep '^other ' | sort -k3,3nr | head -n 5
printf 'ram %s\\n' "$( (sysctl -n hw.memsize 2>/dev/null) || awk '/MemTotal/ { print $2 * 1024 }' /proc/meminfo)"
printf 'swap %s\\n' "$( (awk '/SwapTotal/ { t = $2 } /SwapFree/ { f = $2 } END { if (t != "") print t - f }' /proc/meminfo 2>/dev/null) || true)"`;

/** The engine host (the port's listener) and the top front process, as `host=<pid> front=<pid>`. */
export const SPLIT_PIDS = `host=$( (lsof -nP -iTCP:${SPLIT_PORT} -sTCP:LISTEN -t 2>/dev/null || ss -ltnpH "sport = :${SPLIT_PORT}" 2>/dev/null | sed -n 's/.*pid=\\([0-9]*\\).*/\\1/p') | head -n 1)
front=$(ps axeww -o pid=,ppid=,command= 2>/dev/null | awk '/OLYMPUS_WORKER_ENGINE_ROLE=front/ && !/ps axeww|awk / { r[$1] = $2 } END { for (p in r) if (!(r[p] in r)) { print p; exit } }')
printf 'host=%s front=%s\\n' "\${host:-}" "\${front:-}"`;

export function parsePids(text: string): { host?: number; front?: number } {
  const host = Number(/host=(\d+)/.exec(text)?.[1]);
  const front = Number(/front=(\d+)/.exec(text)?.[1]);
  return { ...(host ? { host } : {}), ...(front ? { front } : {}) };
}

/** A machine-side loop that asks the port's health every quarter second and writes one code a line: 200, 503s ("starting"), 503, 000 (refused) or other. */
export function probeLoop(file: string, stopFile: string): string {
  return `touch ${quote(stopFile)}
nohup sh -c ${quote(`while [ -e ${quote(stopFile)} ]; do
  body=$(curl -s --max-time 3 -w '\\n%{http_code}' http://127.0.0.1:${SPLIT_PORT}/v1/health 2>/dev/null); code=$(printf '%s' "$body" | tail -n 1)
  case "$code" in 503) printf '%s' "$body" | grep -q '"starting"' && code=503s;; esac
  echo "$code" >> ${quote(file)}; sleep 0.25
done`)} > /dev/null 2>&1 < /dev/null &`;
}

export interface ProbeCounts { ok: number; starting: number; refused: number; other: Record<string, number>; total: number }

export function probeCounts(text: string): ProbeCounts {
  const counts: ProbeCounts = { ok: 0, starting: 0, refused: 0, other: {}, total: 0 };
  for (const line of text.split('\n').map((l) => l.trim()).filter(Boolean)) {
    counts.total += 1;
    if (line === '200') counts.ok += 1;
    else if (line === '503s') counts.starting += 1;
    else if (line === '000') counts.refused += 1;
    else counts.other[line] = (counts.other[line] ?? 0) + 1;
  }
  return counts;
}

export interface RssSample { roles: Array<{ role: string; pid: number; kb: number; swapKb?: number }>; others: Array<{ name: string; kb: number }>; ramBytes?: number; swapUsedKb?: number }

export function parseRssSample(text: string): RssSample {
  const sample: RssSample = { roles: [], others: [] };
  for (const line of text.split('\n')) {
    const [a, b, c, d] = line.trim().split(/\s+/);
    if (a === 'ram' && b) { const n = Number(b); if (n > 0) sample.ramBytes = n; continue; }
    if (a === 'swap') { if (b && /^\d+$/.test(b)) sample.swapUsedKb = Number(b); continue; }
    if (a === 'other' && b && c) { sample.others.push({ name: b, kb: Number(c) || 0 }); continue; }
    if (a && b && c && /^\d+$/.test(b)) sample.roles.push({ role: a, pid: Number(b), kb: Number(c) || 0, ...(d && /^\d+$/.test(d) ? { swapKb: Number(d) } : {}) });
  }
  return sample;
}

/** Per role: the peak and the steady size (the median of the last third of the samples), in MB, summing a role's processes in each sample. */
export function summarizeRss(samples: readonly RssSample[]): Array<{ role: string; peakMb: number; steadyMb: number; processes: number; swapPeakMb: number }> {
  const roles = [...new Set(samples.flatMap((s) => s.roles.map((r) => r.role)))].sort();
  return roles.map((role) => {
    const series = samples.map((s) => s.roles.filter((r) => r.role === role).reduce((sum, r) => sum + r.kb, 0));
    const tail = series.slice(Math.floor(series.length * 2 / 3)).filter((kb) => kb > 0).sort((x, y) => x - y);
    const steady = tail.length ? tail[Math.floor(tail.length / 2)]! : 0;
    const processes = Math.max(0, ...samples.map((s) => s.roles.filter((r) => r.role === role).length));
    const swapPeak = Math.max(0, ...samples.map((s) => s.roles.filter((r) => r.role === role).reduce((sum, r) => sum + (r.swapKb ?? 0), 0)));
    return { role, peakMb: Math.round(Math.max(0, ...series) / 1024), steadyMb: Math.round(steady / 1024), processes, swapPeakMb: Math.round(swapPeak / 1024) };
  });
}

export function memoryCheck(samples: readonly RssSample[], during: string, limit?: string): CheckResult {
  const id = 'split.memory';
  const title = 'Engine split: memory of each Olympus process while it ingests and judges';
  if (samples.length === 0) return { id, title, status: 'skip', detail: 'no memory samples were taken' };
  const rows = summarizeRss(samples);
  const ram = samples.find((s) => s.ramBytes)?.ramBytes;
  const ramGb = ram ? Math.round(ram / 2 ** 30) : undefined;
  const last = samples[samples.length - 1]!;
  const others = last.others.map((o) => `${o.name} ${Math.round(o.kb / 1024)} MB`).join(', ');
  const total = rows.reduce((sum, r) => sum + r.peakMb, 0);
  const machine = limit ? `machine RAM ${ramGb ?? '?'} GB; ${limit}` : ramGb === undefined ? 'machine RAM unknown' : ramGb === 8 ? 'machine RAM 8 GB (the 8 GB case)' : `machine RAM ${ramGb} GB (not the 8 GB measurement)`;
  const swapRead = samples.some((s) => s.swapUsedKb !== undefined || s.roles.some((r) => r.swapKb !== undefined));
  const swapUsed = samples.map((s) => s.swapUsedKb).filter((n): n is number => n !== undefined);
  const swapped = rows.filter((r) => r.swapPeakMb > 0);
  const swap = !swapRead ? 'swap not read on this machine'
    : `swap: ${swapped.length ? swapped.map((r) => `${r.role} ${r.swapPeakMb} MB`).join(', ') : 'no Olympus process swapped'}; machine swap used ${swapUsed.length ? `${Math.round(Math.min(...swapUsed) / 1024)} to ${Math.round(Math.max(...swapUsed) / 1024)} MB` : 'not read'}`;
  return {
    id, title, status: 'pass',
    detail: `${samples.length} samples ${during}; ${machine}; `
      + rows.map((r) => `${r.role}${r.processes > 1 ? ` (${r.processes} processes)` : ''} peak ${r.peakMb} MB, steady ${r.steadyMb} MB`).join('; ')
      + `; Olympus peaks sum to ${total} MB; ${swap}; largest other processes at the end: ${others || 'none read'}`,
  };
}

/** A sampler left running on the machine while the account checks run; `stop` reads its samples back. */
export async function startRssSampler(machine: Machine, intervalS = 10): Promise<{ stop(): Promise<RssSample[]> }> {
  const id = crypto.randomUUID();
  const file = `/tmp/olympus-rss-${id}.txt`;
  const stopFile = `/tmp/olympus-rss-${id}.run`;
  const script = `${RSS_SAMPLE}\necho ---`;
  await machine.exec(`touch ${quote(stopFile)}
nohup sh -c ${quote(`while [ -e ${quote(stopFile)} ]; do { ${script}; } >> ${quote(file)} 2>/dev/null; sleep ${intervalS}; done`)} > /dev/null 2>&1 < /dev/null &`, { timeoutMs: 30_000 });
  return {
    stop: async () => {
      const read = await machine.exec(`rm -f ${quote(stopFile)}; cat ${quote(file)} 2>/dev/null; rm -f ${quote(file)}`, { timeoutMs: 30_000 });
      return read.stdout.split('\n---').map((chunk) => parseRssSample(chunk)).filter((s) => s.roles.length > 0);
    },
  };
}

export interface ModelSaver { saveAnswerModel(want?: { provider: string; model: string }): Promise<{ provider: string; from: string; to: string }> }

/** The model change under watch (split.restart), then the model put back. */
export async function splitRestartCheck(machine: Machine, dashboard: ModelSaver, options: { sleep?: (ms: number) => Promise<void>; capS?: number } = {}): Promise<CheckResult> {
  const id = 'split.restart';
  const title = 'Engine split: a model change restarts front and background while the page stays up';
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((done) => setTimeout(done, ms)));
  const capS = options.capS ?? SPLIT_STARTUP_CAP_S;
  const started = Date.now();
  const pids = async () => parsePids((await machine.exec(SPLIT_PIDS, { timeoutMs: 30_000 })).stdout);
  const healthy = async () => (await machine.exec(`curl -s -o /dev/null --max-time 3 -w '%{http_code}' http://127.0.0.1:${SPLIT_PORT}/v1/health`, { timeoutMs: 15_000 })).stdout.trim() === '200';
  const before = await pids();
  if (!before.host || !before.front) return { id, title, status: 'fail', detail: `the split is not running here: engine host ${before.host ?? 'not found'} on port ${SPLIT_PORT}, front ${before.front ?? 'not found'}`, ms: Date.now() - started };
  const tag = crypto.randomUUID();
  const file = `/tmp/olympus-split-probe-${tag}.txt`;
  const stopFile = `/tmp/olympus-split-probe-${tag}.run`;
  await machine.exec(probeLoop(file, stopFile), { timeoutMs: 30_000 });
  let change: { provider: string; from: string; to: string } | undefined;
  let crashed: string | undefined;
  let after: { host?: number; front?: number } = {};
  let backMs: number | undefined;
  let problem: string | undefined;
  let counts = probeCounts('');
  try {
    await sleep(2_000);
    try { change = await dashboard.saveAnswerModel(); } catch (error) {
      const said = error instanceof Error ? error.message : String(error);
      if (!said.includes('no picker with another model')) throw error;
      // Nothing on this machine reloads without a cloud provider (a zkAPI-only Mac with the local judge): the front is
      // killed instead, the failure the held port also covers, and the engine host's supervisor starts a new one.
      const killed = await machine.exec(`kill -9 ${before.front}`, { timeoutMs: 15_000 });
      if (killed.code !== 0) throw new Error(`the front ${before.front} could not be killed: ${(killed.stdout + killed.stderr).trim().slice(-200)}`);
      crashed = said.replace(/^answer model could not be changed: /, '');
    }
    const saved = Date.now();
    const deadline = saved + capS * 1000;
    while (Date.now() < deadline) {
      await sleep(1_000);
      after = await pids();
      if (after.front && after.front !== before.front && await healthy()) { backMs = Date.now() - saved; break; }
    }
    await sleep(3_000);
  } catch (error) {
    problem = error instanceof Error ? error.message : String(error);
  } finally {
    const read = await machine.exec(`rm -f ${quote(stopFile)}; sleep 1; cat ${quote(file)} 2>/dev/null; rm -f ${quote(file)}`, { timeoutMs: 30_000 });
    counts = probeCounts(read.stdout);
  }
  let restored = '';
  if (change) {
    try {
      // Put the owner's model back, and wait for that restart too, so the machine is left as it was.
      await dashboard.saveAnswerModel({ provider: change.provider, model: change.from });
      const deadline = Date.now() + capS * 1000;
      let back = false;
      while (!back && Date.now() < deadline) { await sleep(2_000); back = await healthy(); }
      restored = back ? `; ${change.from} put back` : `; ${change.from} put back but health did not return within ${capS} s`;
    } catch (error) { restored = `; putting ${change.from} back failed: ${error instanceof Error ? error.message : String(error)}`; }
  }
  const other = Object.entries(counts.other).map(([code, n]) => `${n}×${code}`).join(', ');
  const said = `${counts.total} requests: ${counts.ok} 200, ${counts.starting} 503 starting, ${counts.refused} refused${other ? `, other ${other}` : ''}`;
  const pidsSaid = `engine host ${before.host}→${after.host ?? '?'}, front ${before.front}→${after.front ?? '?'}`;
  const changeSaid = crashed ? `front crash, not a settings reload (${crashed})` : change ? `${change.provider === 'judge' ? 'judge' : `${change.provider} answer model`} ${change.from}→${change.to}` : 'no model change';
  const faults = [
    problem,
    counts.refused > 0 ? `${counts.refused} refused connection(s)` : undefined,
    other ? `unexpected answers ${other}` : undefined,
    backMs === undefined && !problem ? `not back at 200 with a new front within ${capS} s` : undefined,
    after.host !== undefined && after.host !== before.host ? 'the engine host restarted' : undefined,
  ].filter(Boolean);
  return {
    id, title, status: faults.length ? 'fail' : 'pass',
    detail: `${faults.length ? `${faults.join('; ')}: ` : ''}${changeSaid}; ${said}; ${pidsSaid}${backMs !== undefined ? `; back in ${Math.round(backMs / 1000)} s` : ''}${restored}`,
    ms: Date.now() - started,
  };
}

/** The Mac's clock, load and busiest processes, for each poll of the fresh-item wait (live.timeline). */
export const MAC_MACHINE_SAMPLE = `{ printf 'clock %s | load %s of %s cpus | ' "$(date -u +%H:%M:%S)" "$(sysctl -n vm.loadavg | awk '{ print $2 }')" "$(sysctl -n hw.ncpu)"; ps -U "$(id -u)" -r -o pcpu=,rss=,comm= | head -n 4 | awk '{ n=split($3, a, "/"); printf "%s%% %sMB %s; ", $1, int($2/1024), a[n] }'; } 2>/dev/null || true`;

/** The Mac engine's log lines about judging, embedding, the privacy check and Gmail: counts and the last 80 lines. */
export const MAC_ENGINE_LOG = `{ d="$HOME/Library/Logs/Olympus"; log=$( { tail -n 20000 "$d/engine.log"; tail -n 20000 "$d/engine.err"; } 2>/dev/null | grep -iE 'embed|judg|sniffer|classif|privacy check|tier|source-scheduler|gmail' || true); printf 'log %s, last 20000 lines of each file: matching lines %s (embed %s, judge %s); whole log %s lines\\n' "$d/engine.log" "$(printf '%s\\n' "$log" | grep -c . || true)" "$(printf '%s\\n' "$log" | grep -ic embed || true)" "$(printf '%s\\n' "$log" | grep -icE 'judg|sniffer|classif' || true)" "$(cat "$d/engine.log" "$d/engine.err" 2>/dev/null | wc -l | tr -d ' ')"; printf '%s\\n' "$log" | grep -v 'Olympus tier sniffer:' | tail -n 60 | cut -c1-240; short() { awk '{ i = index($0, "pass_ms="); print (i > 0 ? substr($0, 1, 150) " … " substr($0, i) : substr($0, 1, 320)) }'; }; passes=$(cat "$d/engine.log" "$d/engine.err" 2>/dev/null | grep 'Olympus tier sniffer: [0-9]* call(s)' || true); printf 'judge passes in the whole log: %s; with new arrivals (arrivals_waiting or arrivals_taken above 0), last 40:\\n' "$(printf '%s\\n' "$passes" | grep -c . || true)"; printf '%s\\n' "$passes" | grep -E 'arrivals_(waiting|taken)=[1-9]' | tail -n 40 | short; printf 'last 10 judge passes:\\n'; printf '%s\\n' "$passes" | tail -n 10 | short; printf 'tier moves with work (moves or backlog above 0), last 30:\\n'; cat "$d/engine.log" "$d/engine.err" 2>/dev/null | grep 'Olympus tier sniffer: [0-9]* automatic tier move' | grep -Ev 'sniffer: 0 automatic tier move\\(s\\), 0 failed;.* backlog=0 ' | tail -n 30 | cut -c1-360; } || true`;
