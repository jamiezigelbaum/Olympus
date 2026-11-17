// Linux, same user as the target. The only process data emitted are counters,
// the main thread's state and kernel wait symbol. Host counters are contextual.
// The engine logs aggregate freeze durations. The report describes the
// enclosing 30 s of thread activity, excluding epoll idle time.
import { once } from 'node:events';
import { closeSync, createReadStream, openSync, readSync, type WriteStream } from 'node:fs';
import { open } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { finished } from 'node:stream/promises';
import { parseArgs } from 'node:util';

const FREEZE_WINDOW_MS = 30_000;
const LATE_MS = 100;
const HOST_MS = 200;
const SUMMARY_MS = 1_000;
const END_BYTES = 128;
const USAGE = 'bun scripts/front-thread-timeline.ts --pid PID --out FILE [--interval-ms 20] [--seconds N] [--max-mb 200]\n'
  + 'bun scripts/front-thread-timeline.ts --summarize FILE --freezes LOG';

class TimelineError extends Error {}

function errorCode(error: unknown): string {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return typeof code === 'string' && /^E[A-Z_0-9]+$/.test(code) ? code : 'error';
}

export function parseStat(line: string) {
  // comm may contain spaces, newlines and closing parentheses. All fields
  // after its final ')' are delimited by one space in Linux procfs.
  const end = line.lastIndexOf(')');
  const state = line[end + 2];
  if (end < 0 || !state || line[end + 1] !== ' ' || line[end + 3] !== ' ' || !/^[A-Za-z]$/.test(state)) {
    throw new TimelineError('stat_format');
  }

  let offset = end + 4;
  let minflt = 0, majflt = 0, utime = 0, stime = 0, blkioTicks = 0;
  for (let field = 4; field <= 42; field++) {
    const space = line.indexOf(' ', offset);
    if (offset >= line.length || space === offset || (space === -1 && field !== 42)) {
      throw new TimelineError('stat_format');
    }
    switch (field) {
      case 10: minflt = Number(line.slice(offset, space)); break;
      case 12: majflt = Number(line.slice(offset, space)); break;
      case 14: utime = Number(line.slice(offset, space)); break;
      case 15: stime = Number(line.slice(offset, space)); break;
      case 42: blkioTicks = Number(line.slice(offset, space === -1 ? undefined : space)); break;
    }
    offset = space + 1;
  }
  if (![minflt, majflt, utime, stime, blkioTicks].every((value) => Number.isSafeInteger(value) && value >= 0)) {
    throw new TimelineError('stat_format');
  }
  return { state, minflt, majflt, utime, stime, blkioTicks };
}

export function parseSchedstat(line: string) {
  const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s*$/.exec(line);
  if (!match) throw new TimelineError('schedstat_format');
  return { runNs: Number(match[1]), waitNs: Number(match[2]), timeslices: Number(match[3]) };
}

function wchanCode(value: string | null): string | null {
  const code = value?.trim();
  return code && code !== '0' && /^[A-Za-z_][A-Za-z0-9_.]{0,127}$/.test(code) ? code : null;
}

function epollIdle(state: string, wchan: string | null): boolean {
  return state === 'S' && wchan !== null && /^(ep_poll|do_epoll_wait|epoll_wait)(\.|$)/.test(wchan);
}

class ProcFile {
  private fd: number | undefined;
  private missing = false;
  private positional = true;

  constructor(private readonly path: string, private readonly optional = false) {}

  read(buffer: Buffer): string | null {
    if (this.missing) return null;
    try {
      if (!this.positional) {
        const fd = openSync(this.path, 'r');
        try {
          const size = readSync(fd, buffer, 0, buffer.length, null);
          return size ? buffer.toString('utf8', 0, size) : null;
        } finally {
          closeSync(fd);
        }
      }
      this.fd ??= openSync(this.path, 'r');
      const size = readSync(this.fd, buffer, 0, buffer.length, 0);
      return size ? buffer.toString('utf8', 0, size) : null;
    } catch (error) {
      const code = errorCode(error);
      this.close();
      if (this.positional && (code === 'ESPIPE' || code === 'EINVAL')) {
        this.positional = false;
        return this.read(buffer);
      }
      if (code !== 'ENOENT' && code !== 'ESRCH' && !(this.optional && (code === 'EACCES' || code === 'EPERM'))) {
        throw error;
      }
      this.missing = true;
      return null;
    }
  }

  close(): void {
    if (this.fd === undefined) return;
    closeSync(this.fd);
    this.fd = undefined;
  }
}

type Clock = { wallMs: number; monoMs: number };
type Stamp = { at: string; monoMs: number };

function clock(): Clock {
  return { wallMs: Date.now(), monoMs: performance.now() };
}

function stamp(time: Clock): Stamp {
  return { at: new Date(time.wallMs).toISOString(), monoMs: rounded(time.monoMs) };
}

function rounded(ms: number): number {
  return Math.round(ms * 1_000) / 1_000;
}

function delta(previous: number | null, current: number | null): number | null {
  return previous !== null && current !== null && current >= previous ? current - previous : null;
}

function valueAt(text: string | null, key: string): number | null {
  if (text === null) return null;
  const line = text.startsWith(key) ? 0 : text.indexOf(`\n${key}`) + 1;
  if (line === 0 && !text.startsWith(key)) return null;
  let start = line + key.length;
  while (text[start] === ' ' || text[start] === '\t') start++;
  let end = start;
  while (text.charCodeAt(end) >= 48 && text.charCodeAt(end) <= 57) end++;
  return end === start ? null : Number(text.slice(start, end));
}

function pressureTotals(text: string | null) {
  const totals = /^(some|full) .*\btotal=(\d+)$/gm;
  let some: number | null = null;
  let full: number | null = null;
  for (const match of text?.matchAll(totals) ?? []) {
    if (match[1] === 'some') some = Number(match[2]);
    else full = Number(match[2]);
  }
  return { some, full };
}

type Pressure = ReturnType<typeof pressureTotals>;

function pressureDelta(previous: Pressure, current: Pressure): Pressure {
  return { some: delta(previous.some, current.some), full: delta(previous.full, current.full) };
}

type Thread = ReturnType<typeof parseStat> & {
  runNs: number | null;
  waitNs: number | null;
  timeslices: number | null;
  wchan: string | null;
};

function createProcReader(pid: number) {
  const processBase = `/proc/${pid}`;
  const threadBase = `${processBase}/task/${pid}`;
  const stat = new ProcFile(`${threadBase}/stat`);
  const schedstat = new ProcFile(`${threadBase}/schedstat`, true);
  const wchan = new ProcFile(`${threadBase}/wchan`, true);
  const status = new ProcFile(`${processBase}/status`, true);
  const cpu = new ProcFile('/proc/pressure/cpu', true);
  const memory = new ProcFile('/proc/pressure/memory', true);
  const io = new ProcFile('/proc/pressure/io', true);
  const vmstat = new ProcFile('/proc/vmstat', true);
  const buffer = Buffer.allocUnsafe(64 * 1024);

  return {
    thread(): Thread | null {
      const text = stat.read(buffer);
      if (text === null) return null;
      const thread = parseStat(text);
      if (/^[ZXx]$/.test(thread.state)) return null;
      const schedText = schedstat.read(buffer);
      const sched = schedText === null ? { runNs: null, waitNs: null, timeslices: null } : parseSchedstat(schedText);
      return { ...thread, ...sched, wchan: wchanCode(wchan.read(buffer)) };
    },
    host(at: Clock) {
      const statusText = status.read(buffer);
      const vmText = vmstat.read(buffer);
      return {
        ...stamp(at),
        rssAnonKb: valueAt(statusText, 'RssAnon:'),
        rssFileKb: valueAt(statusText, 'RssFile:'),
        vmSwapKb: valueAt(statusText, 'VmSwap:'),
        pswpin: valueAt(vmText, 'pswpin '),
        pswpout: valueAt(vmText, 'pswpout '),
        pgmajfault: valueAt(vmText, 'pgmajfault '),
        pressureUs: {
          cpu: pressureTotals(cpu.read(buffer)),
          memory: pressureTotals(memory.read(buffer)),
          io: pressureTotals(io.read(buffer)),
        },
      };
    },
    close() {
      for (const file of [stat, schedstat, wchan, status, cpu, memory, io, vmstat]) file.close();
    },
  };
}

type Host = ReturnType<ReturnType<typeof createProcReader>['host']>;
type Sample = Stamp & Thread & {
  kind: 'sample';
  spanMs: number;
  dRunNs: number | null;
  dWaitNs: number | null;
  dMajflt: number;
  dBlkioTicks: number;
  lateMs?: number;
};
type LateTick = Stamp & { kind: 'late'; spanMs: number; lateMs: number };
type Summary = Stamp & {
  kind: 'summary';
  // The summary timer can fire between thread reads at slower intervals.
  throughAt: string;
  spanMs: number;
  runNs: number | null;
  waitNs: number | null;
  majflt: number | null;
  blkioTicks: number | null;
  idleRunNs: number;
  pswpin: number | null;
  pressureUs: Host['pressureUs'];
  host: Host[];
};
type EndReason = 'duration' | 'pid_gone' | 'size_cap' | 'signal';
type End = Stamp & { kind: 'end'; reason: EndReason };
type Row = Sample | LateTick | Summary | End;

export class TimelineOutput {
  private bytes = 0;
  private full = false;
  private readonly done: Promise<void>;

  private constructor(private readonly stream: WriteStream, private readonly maxBytes: number) {
    this.done = finished(stream, { cleanup: true });
    // close() awaits this promise, including write errors between samples.
    void this.done.catch(() => undefined);
  }

  static async open(path: string, maxBytes: number): Promise<TimelineOutput> {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < END_BYTES) throw new TimelineError('invalid_max_mb');
    const file = await open(path, 'wx', 0o600);
    return new TimelineOutput(file.createWriteStream(), maxBytes);
  }

  async append(row: Exclude<Row, End>): Promise<boolean> {
    if (this.stream.destroyed) {
      await this.done;
      throw new TimelineError('output_closed');
    }
    const line = JSON.stringify(row) + '\n';
    const size = Buffer.byteLength(line);
    if (this.full || this.bytes + size + END_BYTES > this.maxBytes) {
      this.full = true;
      return false;
    }
    this.bytes += size;
    if (!this.stream.write(line)) await once(this.stream, 'drain');
    return true;
  }

  async close(at?: Stamp, reason?: EndReason): Promise<void> {
    if (at && reason) {
      const end: End = { kind: 'end', ...at, reason: this.full ? 'size_cap' : reason };
      this.stream.end(JSON.stringify(end) + '\n');
    } else {
      this.stream.end();
    }
    await this.done;
  }
}

function nextDeadline(deadline: number, step: number, now: number): number {
  return deadline + (1 + Math.floor((now - deadline) / step)) * step;
}

async function capture(pid: number, path: string, intervalMs: number, seconds: number, maxBytes: number) {
  if (process.platform !== 'linux') throw new TimelineError('linux_required');
  const output = await TimelineOutput.open(path, maxBytes);
  const proc = createProcReader(pid);
  let interrupted = false;
  const stop = () => { interrupted = true; };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  let reason: EndReason | undefined;
  try {
    let threadAt = clock();
    const first = proc.thread();
    if (!first) {
      reason = 'pid_gone';
      return;
    }

    let previous = first;
    let summaryAt = threadAt;
    let summaryThread = previous;
    let summaryHost = proc.host(threadAt);
    let host = [summaryHost];
    let idleRunNs = 0;
    let threadDue = threadAt.monoMs + intervalMs;
    let hostDue = threadAt.monoMs + HOST_MS;
    let summaryDue = threadAt.monoMs + SUMMARY_MS;
    const deadline = threadAt.monoMs + seconds * 1_000;

    const writeSummary = (at: Clock) => {
      const latest = host.at(-1) ?? summaryHost;
      const summary: Summary = {
        kind: 'summary',
        ...stamp(at),
        throughAt: new Date(threadAt.wallMs).toISOString(),
        spanMs: rounded(threadAt.monoMs - summaryAt.monoMs),
        runNs: delta(summaryThread.runNs, previous.runNs),
        waitNs: delta(summaryThread.waitNs, previous.waitNs),
        majflt: delta(summaryThread.majflt, previous.majflt),
        blkioTicks: delta(summaryThread.blkioTicks, previous.blkioTicks),
        idleRunNs,
        pswpin: delta(summaryHost.pswpin, latest.pswpin),
        pressureUs: {
          cpu: pressureDelta(summaryHost.pressureUs.cpu, latest.pressureUs.cpu),
          memory: pressureDelta(summaryHost.pressureUs.memory, latest.pressureUs.memory),
          io: pressureDelta(summaryHost.pressureUs.io, latest.pressureUs.io),
        },
        host,
      };
      summaryThread = previous;
      summaryAt = threadAt;
      summaryHost = latest;
      host = [];
      idleRunNs = 0;
      return output.append(summary);
    };

    const writeLate = (at: Clock) => output.append({
      kind: 'late', ...stamp(at),
      spanMs: rounded(at.monoMs - threadAt.monoMs), lateMs: rounded(at.monoMs - threadDue),
    });

    while (true) {
      const at = clock();
      const lateMs = at.monoMs - threadDue;
      if (interrupted || at.monoMs >= deadline) {
        reason = interrupted ? 'signal' : 'duration';
        if (threadDue <= deadline && lateMs > LATE_MS) await writeLate(at);
        break;
      }

      if (at.monoMs >= threadDue) {
        const current = proc.thread();
        if (!current) {
          reason = 'pid_gone';
          if (lateMs > LATE_MS) await writeLate(at);
          break;
        }
        const spanMs = rounded(at.monoMs - threadAt.monoMs);
        const dRunNs = delta(previous.runNs, current.runNs);
        const dWaitNs = delta(previous.waitNs, current.waitNs);
        const dMajflt = delta(previous.majflt, current.majflt) ?? 0;
        const dBlkioTicks = delta(previous.blkioTicks, current.blkioTicks) ?? 0;
        if (!epollIdle(current.state, current.wchan) || dMajflt || dWaitNs || dBlkioTicks) {
          if (!await output.append({
            kind: 'sample', ...stamp(at), ...current, spanMs, dRunNs, dWaitNs, dMajflt, dBlkioTicks,
            ...(lateMs > LATE_MS ? { lateMs: rounded(lateMs) } : {}),
          })) {
            reason = 'size_cap';
            break;
          }
        } else {
          // A thread can run and return to epoll entirely between ticks.
          idleRunNs += dRunNs ?? 0;
          if (lateMs > LATE_MS && !await writeLate(at)) {
            reason = 'size_cap';
            break;
          }
        }
        previous = current;
        threadAt = at;
        threadDue = nextDeadline(threadDue, intervalMs, at.monoMs);
      }
      if (at.monoMs >= hostDue) {
        host.push(proc.host(clock()));
        hostDue = nextDeadline(hostDue, HOST_MS, at.monoMs);
      }
      if (at.monoMs >= summaryDue) {
        if (!await writeSummary(at)) {
          reason = 'size_cap';
          break;
        }
        summaryDue = nextDeadline(summaryDue, SUMMARY_MS, at.monoMs);
      }

      const wake = Math.min(threadDue, hostDue, summaryDue, deadline);
      const wait = wake - performance.now();
      if (wait > 0) await Bun.sleep(Math.ceil(wait));
    }
    if (reason !== 'size_cap' && (threadAt !== summaryAt || host.length > 0)) await writeSummary(clock());
  } finally {
    process.off('SIGINT', stop);
    process.off('SIGTERM', stop);
    proc.close();
    await output.close(stamp(clock()), reason);
  }
}

type Freeze = { at: string; count: number | null; totalMs: number | null; maxMs: number };

export function parseFreeze(line: string): Freeze | null {
  const match = /(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z) \[olympus:control-path\] freeze frames role=front (?:count=(\d+) )?(?:total_ms=(\d+) )?max_ms=(\d+)(?:\s|$)/.exec(line);
  if (!match || !Number.isFinite(Date.parse(match[1]!))) return null;
  return { at: match[1]!, count: match[2] === undefined ? null : Number(match[2]),
    totalMs: match[3] === undefined ? null : Number(match[3]), maxMs: Number(match[4]) };
}

type Observation = Exclude<Row, End>;

function observationEnd(row: Observation): number {
  return Date.parse(row.kind === 'summary' ? row.throughAt : row.at);
}

export function summarizeFreeze(rows: readonly Observation[], freeze: Freeze) {
  const end = Date.parse(freeze.at);
  const start = end - FREEZE_WINDOW_MS;
  let runningMs = 0, runQueueMs = 0, blockedMajfltMs = 0, blockedBlkioMs = 0, blockedOtherMs = 0;
  let coveredMs = 0, lateTicks = 0, lateMs = 0;
  const waitChannels = new Map<string, number>();
  let block: { endMono: number; wchan: string | null; ms: number; majflt: boolean; blkio: boolean } | undefined;

  const flushBlock = () => {
    if (!block) return;
    if (block.majflt) blockedMajfltMs += block.ms;
    else if (block.blkio) blockedBlkioMs += block.ms;
    else blockedOtherMs += block.ms;
    if (block.wchan && block.ms > 0) waitChannels.set(block.wchan, (waitChannels.get(block.wchan) ?? 0) + block.ms);
    block = undefined;
  };

  for (const row of rows) {
    const wall = observationEnd(row);
    const overlap = Math.min(end, wall) - Math.max(start, wall - row.spanMs);
    if (!(overlap > 0)) continue;
    const weight = overlap / row.spanMs;
    if (row.kind === 'summary') {
      coveredMs += overlap;
      runningMs += row.idleRunNs * weight / 1e6;
      continue;
    }
    if (row.lateMs !== undefined) {
      lateTicks++;
      lateMs += Math.max(0, Math.min(end, wall) - Math.max(start, wall - row.lateMs));
    }
    if (row.kind === 'late') {
      flushBlock();
      continue;
    }

    const run = (row.dRunNs ?? 0) / 1e6;
    const wait = (row.dWaitNs ?? 0) / 1e6;
    // Schedstat can post an entire wait on wakeup. Keep the counter delta
    // even when this tick alone spans less time than the delta.
    runningMs += run * weight;
    runQueueMs += wait * weight;

    const wchan = wchanCode(row.wchan);
    const sleeping = (row.state === 'S' || row.state === 'D' || row.state === 'I') && !epollIdle(row.state, wchan);
    const adjacent = block && Math.abs(row.monoMs - row.spanMs - block.endMono) < 0.01;
    const completion = adjacent && !sleeping && (row.dMajflt > 0 || row.dBlkioTicks > 0);
    if (row.lateMs !== undefined || (!sleeping && !completion)) {
      flushBlock();
      continue;
    }
    if (!adjacent || (sleeping && block?.wchan !== wchan)) flushBlock();
    block ??= { endMono: row.monoMs, wchan, ms: 0, majflt: false, blkio: false };
    block.endMono = row.monoMs;
    block.ms += Math.max(0, row.spanMs - run - wait) * weight;
    // Fault and blkio counters also post on completion, often after the
    // sleeping samples. Attribute a contiguous wait to the observed signal.
    block.majflt ||= row.dMajflt > 0;
    block.blkio ||= row.dBlkioTicks > 0;
    if (completion) flushBlock();
  }
  flushBlock();

  let topWchan: string | null = null, topMs = 0;
  for (const [name, ms] of waitChannels) {
    if (ms > topMs) { topWchan = name; topMs = ms; }
  }
  return {
    ...freeze,
    runningMs: rounded(runningMs), runQueueMs: rounded(runQueueMs),
    blockedMajfltMs: rounded(blockedMajfltMs), blockedBlkioMs: rounded(blockedBlkioMs),
    blockedOtherMs: rounded(blockedOtherMs), topWchan, topWchanMs: rounded(topMs),
    coveredMs: rounded(coveredMs), lateTicks, lateMs: rounded(lateMs),
  };
}

function lines(path: string) {
  return createInterface({ input: createReadStream(path, { encoding: 'utf8' }), crlfDelay: Infinity });
}

async function summarize(timelinePath: string, freezePath: string) {
  const freezes: Freeze[] = [];
  for await (const line of lines(freezePath)) {
    const freeze = parseFreeze(line);
    if (freeze) freezes.push(freeze);
  }
  freezes.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));

  let next = 0;
  let recent: Observation[] = [];
  const reportThrough = (time: number) => {
    while (next < freezes.length && Date.parse(freezes[next]!.at) <= time) {
      console.log(JSON.stringify(summarizeFreeze(recent, freezes[next++]!)));
    }
  };

  for await (const line of lines(timelinePath)) {
    if (next === freezes.length) break;
    const row = JSON.parse(line) as Row;
    if (row.kind === 'end') break;
    recent.push(row);
    // A summary covers suppressed idle ticks, including CPU consumed before
    // a thread returned to epoll. Wait for it before reporting that window.
    if (row.kind === 'summary') {
      const through = observationEnd(row);
      reportThrough(through);
      recent = recent.filter((entry) => observationEnd(entry) > through - FREEZE_WINDOW_MS);
    }
  }
  reportThrough(Infinity);
}

function positive(value: string, integer = false): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0 || (integer && !Number.isSafeInteger(n))) {
    throw new TimelineError('invalid_number');
  }
  return n;
}

async function main() {
  const { values } = parseArgs({
    options: {
      pid: { type: 'string' },
      out: { type: 'string' },
      'interval-ms': { type: 'string' },
      seconds: { type: 'string' },
      'max-mb': { type: 'string' },
      summarize: { type: 'string' },
      freezes: { type: 'string' },
      help: { type: 'boolean' },
    },
  });
  if (values.help) {
    console.log(USAGE);
    return;
  }
  const { pid, out, seconds, summarize: timeline, freezes } = values;
  if (timeline && freezes && ![pid, out, seconds, values['interval-ms'], values['max-mb']].some((value) => value !== undefined)) {
    await summarize(timeline, freezes);
  } else if (pid && out && timeline === undefined && freezes === undefined) {
    await capture(positive(pid, true), out, positive(values['interval-ms'] ?? '20', true),
      seconds === undefined ? Infinity : positive(seconds), Math.floor(positive(values['max-mb'] ?? '200') * 1024 ** 2));
  } else {
    throw new TimelineError('usage');
  }
}

if (import.meta.main) {
  try {
    await main();
  } catch (error) {
    console.error(error instanceof TimelineError ? error.message : errorCode(error));
    process.exitCode = 1;
  }
}
