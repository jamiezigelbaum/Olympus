import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { DASHBOARD_PAGES, dashboardAvailabilityCheck, summarizePages, type PageSample } from './cutover.ts';
import type { AskObservation } from './qualify.ts';
import type { CheckResult } from './report.ts';

interface QuietSnapshot {
  sample: string;
  topCpu: string;
  privateModel: string;
}

export interface CanaryTimingReceipt {
  before?: QuietSnapshot;
  after?: QuietSnapshot;
  interference: string[];
  startup?: { started: number; readyAt?: number; through: number; pages: PageSample[]; problem?: string };
  front?: { pages: PageSample[]; restarts: number };
  click?: { ackMs?: number; problem?: string };
  ask?: AskObservation;
  problem?: string;
}

function percentiles(times: number[]): string {
  if (!times.length) return 'p50 unavailable, p95 unavailable, max unavailable (n=0)';
  times.sort((a, b) => a - b);
  const at = (p: number) => times[Math.ceil(p * times.length) - 1];
  return `p50 ${at(0.5)} ms, p95 ${at(0.95)} ms, max ${at(1)} ms (n=${times.length})`;
}

export function canaryTimingChecks(receipt?: CanaryTimingReceipt, problem?: string): CheckResult[] {
  const { before, after, startup, front, click, ask } = receipt ?? {};
  const snapshot = (s?: QuietSnapshot) => s
    ? `${s.sample} · top CPU (all users): ${s.topCpu} · private model: ${s.privateModel}` : 'unavailable';
  const interference = receipt && [
    ...receipt.interference, ...(!before || !after ? ['quiet-machine snapshots incomplete'] : []),
  ].join(', ');
  const quiet = `Before: ${snapshot(before)} · After: ${snapshot(after)} · Other Olympus/release-check work and sustained CPU: ${interference || (receipt ? 'none observed' : 'unavailable')}`;
  const check = (id: string, title: string, observed: boolean, pass: boolean, detail: string): CheckResult => ({
    id: `canary.timing.${id}`, title, status: !observed ? 'fail' : interference ? 'warn' : pass ? 'pass' : 'fail',
    detail: [!observed ? 'Required timing samples were not recorded' : undefined,
      interference ? `not clean: ${interference}` : undefined, detail, problem ?? receipt?.problem,
      id !== 'startup' && !observed ? startup?.problem : undefined, quiet].filter(Boolean).join(' · '),
  });
  const startupWindow = startup && summarizePages(startup.pages, startup.started, startup.readyAt ?? startup.through);
  const startupStatus = dashboardAvailabilityCheck(startupWindow, true, startup?.readyAt !== undefined);
  const startupDetail = startupWindow && Object.entries(startupWindow.pages).map(([page, result]) =>
    `${page} longest unanswered gap ${result.longestMs} ms`).join(' · ');
  const frontPages = DASHBOARD_PAGES.map(page => {
    const probes = front?.pages.filter(sample => sample.page === page) ?? [];
    return {
      observed: probes.length > 0,
      pass: probes.length > 0 && probes.every(probe => probe.answered && probe.ms <= 1_000),
      detail: `${page}: ${percentiles(probes.map(probe => probe.ms))}, ${probes.filter(probe => !probe.answered).length} unanswered`,
    };
  });
  return [
    check('startup', 'Home and Sources stay within a 10 s gap from restart to ready',
      startup?.readyAt !== undefined && DASHBOARD_PAGES.every(page => startup.pages.some(probe => probe.page === page && probe.at <= startup.readyAt!)),
      startupStatus.status === 'pass' && !startup?.problem,
      [`Boot to ready: ${startup?.readyAt !== undefined ? `${startup.readyAt - startup.started} ms` : 'unobserved'}`, startupDetail, startup?.problem].filter(Boolean).join(' · ')),
    check('front', 'Ready Home and Sources answer every probe within 1 s', frontPages.every(page => page.observed), frontPages.every(page => page.pass) && front?.restarts === 0,
      `${frontPages.map(page => page.detail).join(' · ')}${front?.restarts ? ` · ${front.restarts} engine self-restart(s)` : ''}`),
    check('click', 'Make Private is acknowledged within 1 s', click?.ackMs !== undefined, click?.ackMs !== undefined && click.ackMs <= 1_000 && !click.problem,
      [percentiles(click?.ackMs === undefined ? [] : [click.ackMs]), click?.problem].filter(Boolean).join(' · ')),
    check('ask', 'Known-answer Ask retrieves evidence within 10 s and answers within 20 s', !!ask,
      !!ask?.answered && ask.factsStated && ask.cited && ask.firstEvidenceMs !== undefined && ask.firstEvidenceMs <= 10_000 && ask.ms <= 20_000,
      `Evidence: ${ask?.firstEvidenceMs === undefined ? 'unobserved' : `${ask.firstEvidenceMs} ms (engine retrieval)`} · Whole answer: ${ask ? `${ask.ms} ms` : 'unobserved'} · Cited: ${ask ? (ask.cited ? 'yes' : 'no') : 'unobserved'}${ask && !ask.factsStated ? ' · expected facts missing' : ''}`),
  ];
}

interface ProcessSample {
  pid: number;
  parent: number;
  cpuSeconds?: number;
  cpuPercent: number;
  name: string;
  args: string;
}

/** Compare CPU time over a six-second interval. A high lifetime %CPU or a momentary spike alone doesn't invalidate a run. */
export function canaryQuietWatch(olympusBin: string, readProcesses: () => { status: number | null; stdout?: string } = () => spawnSync('ps', ['-axww', '-o', 'pid=,ppid=,time=,pcpu=,comm=,args='], {
  encoding: 'utf8', timeout: 2_000, env: { ...process.env, LC_ALL: 'C' },
})) {
  const interference = new Set<string>();
  const linux = process.platform === 'linux';
  const ticksPerSecond = linux
    ? Number(spawnSync('getconf', ['CLK_TCK'], { encoding: 'utf8', timeout: 2_000 }).stdout?.trim()) : 0;
  if (linux && !(ticksPerSecond > 0)) interference.add('CPU clock resolution unavailable');
  const cpuTime = (pid: number, time: string) => {
    if (!linux) {
      return time.replace('-', ':').split(':').reverse().reduce((sum, value, index) =>
        sum + Number(value) * [1, 60, 3600, 86400][index]!, 0);
    }
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
      const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
      // The remainder starts at field 3. Fields 14 and 15 are user and system CPU ticks.
      return (Number(fields[11]) + Number(fields[12])) / ticksPerSecond;
    } catch {
      // A process can exit between ps and the proc read.
      return undefined;
    }
  };
  let history: { at: number; processes: Map<number, ProcessSample> }[] = [];
  const sample = () => {
    const out = readProcesses();
    const processes = new Map<number, ProcessSample>();
    for (const line of (out.stdout ?? '').split('\n')) {
      const match = /^\s*(\d+)\s+(\d+)\s+([\d:.\-]+)\s+([\d.]+)\s+(\S+)\s+(.*)$/.exec(line);
      if (!match) continue;
      const [, pid, parent, time, cpu, command, args] = match;
      const cpuSeconds = cpuTime(Number(pid), time!);
      processes.set(Number(pid), {
        pid: Number(pid), parent: Number(parent), ...(cpuSeconds !== undefined ? { cpuSeconds } : {}),
        cpuPercent: Number(cpu), name: basename(command!).replace(/[^\w.+-]/g, '_'), args: args!,
      });
    }
    if (out.status !== 0 || !processes.has(process.pid)) interference.add('process sample unavailable');
    const at = performance.now();
    const baseline = history.filter(row => at - row.at >= 6_000).pop();
    history = [...history.filter(row => row.at > (baseline?.at ?? -Infinity)), { at, processes }];
    const owned = (entry: ProcessSample, root: (row: ProcessSample) => boolean): boolean => {
      for (let row: ProcessSample | undefined = entry; row; row = processes.get(row.parent)) {
        if (root(row)) return true;
        if (row.parent <= 1 || row.parent === row.pid) break;
      }
      return false;
    };
    const engine = (row: ProcessSample) => /(?:^|\s)__engine-run(?:\s|$)/.test(row.args);
    // The SSH driver execs this agent through a login shell. Exclude that
    // session and its helpers, but keep sibling SSH sessions independent.
    const ancestors = new Set<number>();
    let sshSession: number | undefined;
    for (let pid = process.pid; pid > 1 && !ancestors.has(pid); pid = processes.get(pid)?.parent ?? 0) {
      ancestors.add(pid);
      const row = processes.get(pid);
      if (row && (/^sshd-session(?:$|_)/.test(row.name) || /^sshd_?$/.test(row.name) && /^sshd: \S+(?:@| \[priv\])/.test(row.args))) {
        sshSession = pid;
      }
    }
    const others = [...processes.values()].filter(entry => !ancestors.has(entry.pid)
      && !owned(entry, row => row.pid === process.pid || row.pid === sshSession));
    const engineRoots = others.filter(row => engine(row) && !owned(row, parent => parent.pid !== row.pid && engine(parent)));
    if (engineRoots.length > 1) interference.add('multiple Olympus engines');
    for (const entry of others) {
      const releaseCheck = /release-check\/[^\s]*\.(?:ts|js|sh)\b|\/(?:rc\/agent|machine-agent)\.js\b|\bchatgpt-live-smoke\.(?:ts|js)\b/.test(entry.args);
      if (releaseCheck) interference.add(`another release-check process (${entry.name}, PID ${entry.pid})`);
      if (owned(entry, engine)) continue;
      const [command, script] = entry.args.split(/\s+/, 2);
      const isOlympus = (value?: string) => value === olympusBin || /^(?:olympus|olympus\.js)$/.test(basename(value ?? ''));
      // A shell can mention Olympus in an inline command without running
      // another Olympus process. Its actual CLI child is counted separately.
      if (isOlympus(command) || (/^(?:sh|bash|zsh|bun|node)$/.test(entry.name) && isOlympus(script))
          || /(?:^|\s)__(?:worker|relay)-service-run(?:\s|$)/.test(entry.args)) {
        interference.add(`another Olympus process (${entry.name}, PID ${entry.pid})`);
      }
      const previous = baseline?.processes.get(entry.pid);
      if (baseline && previous?.cpuSeconds !== undefined && entry.cpuSeconds !== undefined && previous.args === entry.args) {
        const percent = (entry.cpuSeconds - previous.cpuSeconds) * 100_000 / (at - baseline.at);
        if (percent > 20) interference.add(`${entry.name} (PID ${entry.pid}) averaged ${Math.round(percent)}% CPU over ${((at - baseline.at) / 1000).toFixed(1)} s`);
      }
    }
    return [...processes.values()].sort((a, b) => b.cpuPercent - a.cpuPercent).slice(0, 5)
      .map(row => `${row.name} (${row.pid}) ${row.cpuPercent}%`).join(', ') || 'unavailable';
  };
  return { sample, interference };
}
