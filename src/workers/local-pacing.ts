// "Go easy on this computer" (#922): local work runs at full speed only while
// the owner is away or the computer is plugged in overnight, and as a trickle
// while they work.
//
// Two parts, both off the hot path:
// - A probe that reads seconds since the last keyboard or mouse input and
//   the power source. macOS: `ioreg` HIDIdleTime, `pmset -g batt`, the lid
//   (AppleClamshellState). Linux, best effort: /sys/class/power_supply and
//   logind's IdleHint. Every read is bounded and never throws; anything it
//   cannot tell is `undefined`.
// - A pacer that caches the last reading (refreshed about every 30 s in the
//   background) and answers `trickle()` synchronously from it.
//
// Only local work asks: the built-in privacy judge and built-in embedding on
// this computer. Cloud judging (Venice) and remote judges (Delphi, another
// model server) are network work and never ask. On a computer with no
// battery (a desktop or a server) the setting is off unless the owner turns
// it on, and with no idle reading it runs at full speed.
//
// While local work is waiting and a Mac is on AC power with its lid open, the
// pacer holds `caffeinate -i -w <engine pid>`, so the Mac does not idle-sleep
// mid-run; the assertion ends with the work, the setting's process, or the
// engine.

import { execFile, spawn } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { writePrivateFileAtomicSync } from '../core/atomic-file.ts';

/** Embedding that runs on this computer's own processor, which going easy paces (scope wrappers included). */
export function embedsOnThisComputer(provider: { runsOnThisComputer?(): boolean } | undefined): boolean {
  try {
    return provider?.runsOnThisComputer?.() === true;
  } catch {
    return false;
  }
}

export type PowerSource = 'ac' | 'battery' | 'no_battery';

export interface IdlePowerReading {
  /** Seconds since the last keyboard or mouse input; undefined when unknown. */
  idleSeconds?: number;
  /** undefined when unknown. `no_battery`: a desktop or a server. */
  power?: PowerSource;
  /** macOS only: false while the lid is closed; undefined when unknown or not a laptop. */
  lidOpen?: boolean;
}

export interface IdlePowerProbe {
  /** Never rejects. */
  read(): Promise<IdlePowerReading>;
}

/** Full speed after this long without input. */
export const GO_EASY_IDLE_FULL_SPEED_MS = 5 * 60_000;
/** How long a reading is used before it is read again. */
export const GO_EASY_REFRESH_MS = 30_000;
/** Overnight, on AC power: local hours [from, to). */
export const GO_EASY_NIGHT = { fromHour: 22, toHour: 7 } as const;
/**
 * Local work that ran this recently still counts as waiting, for the power
 * assertion: a missing-vector backlog found after a restart is not in the
 * in-memory queue, and counting it in the store on every read is the kind
 * of synchronous scan that froze the worker (#1079).
 */
export const GO_EASY_LOCAL_WORK_RECENT_MS = 3 * 60_000;
/** While trickling: the pause between one local judge call and the next. */
export const GO_EASY_TRICKLE_GAP_MS = 20_000;
/** While trickling: items per store per embedding sweep (a sweep runs about once a minute). */
export const GO_EASY_TRICKLE_EMBED_ITEMS = 1;

type Exec = (command: string, args: readonly string[]) => Promise<string | undefined>;

const defaultExec: Exec = (command, args) => new Promise((resolve) => {
  try {
    execFile(command, [...args], { timeout: 3_000, maxBuffer: 256 * 1024, encoding: 'utf8' }, (error, stdout) => {
      resolve(error ? undefined : stdout);
    });
  } catch {
    resolve(undefined);
  }
});

/** `"HIDIdleTime" = 12345678901` (nanoseconds) in `ioreg -c IOHIDSystem` output. */
export function parseMacIdleSeconds(text: string | undefined): number | undefined {
  const match = /"HIDIdleTime"\s*=\s*(\d+)/.exec(text ?? '');
  if (!match) return undefined;
  const seconds = Number(match[1]) / 1e9;
  return Number.isFinite(seconds) ? seconds : undefined;
}

/** `pmset -g batt`: "Now drawing from 'AC Power'", with an InternalBattery line on a laptop. */
export function parseMacPower(text: string | undefined): PowerSource | undefined {
  if (!text) return undefined;
  const ac = /'AC Power'/.test(text);
  const battery = /'Battery Power'/.test(text);
  if (!ac && !battery) return undefined;
  if (!/InternalBattery/.test(text)) return 'no_battery';
  return ac ? 'ac' : 'battery';
}

/** `"AppleClamshellState" = No` while the lid is open. */
export function parseMacLidOpen(text: string | undefined): boolean | undefined {
  const match = /"AppleClamshellState"\s*=\s*(Yes|No)/.exec(text ?? '');
  return match ? match[1] === 'No' : undefined;
}

/** logind's `IdleHint` and `IdleSinceHint` (microseconds since the epoch). */
export function parseLogindIdleSeconds(text: string | undefined, nowMs: number): number | undefined {
  if (!text) return undefined;
  const hint = /^IdleHint=(yes|no)$/m.exec(text)?.[1];
  if (hint === 'no') return 0;
  if (hint !== 'yes') return undefined;
  const since = Number(/^IdleSinceHint=(\d+)$/m.exec(text)?.[1]);
  if (!Number.isFinite(since) || since <= 0) return undefined;
  return Math.max(0, (nowMs - since / 1_000) / 1_000);
}

/** /sys/class/power_supply: a Mains supply's `online`, and whether any Battery exists. */
export function readLinuxPower(root = '/sys/class/power_supply'): PowerSource | undefined {
  try {
    if (!existsSync(root)) return 'no_battery';
    let battery = false;
    let online: boolean | undefined;
    for (const name of readdirSync(root)) {
      const read = (file: string) => { try { return readFileSync(join(root, name, file), 'utf8').trim(); } catch { return undefined; } };
      const type = read('type');
      if (type === 'Battery') battery = true;
      if (type === 'Mains' || type === 'USB') {
        const value = read('online');
        if (value === '1') online = true;
        else if (value === '0' && online === undefined) online = false;
      }
    }
    if (!battery) return 'no_battery';
    return online === undefined ? undefined : online ? 'ac' : 'battery';
  } catch {
    return undefined;
  }
}

export function systemIdlePowerProbe(options: {
  platform?: NodeJS.Platform;
  exec?: Exec;
  env?: Record<string, string | undefined>;
  powerSupplyRoot?: string;
  now?: () => number;
} = {}): IdlePowerProbe {
  const platform = options.platform ?? process.platform;
  const exec = options.exec ?? defaultExec;
  const env = options.env ?? process.env;
  const now = options.now ?? Date.now;
  return {
    async read() {
      try {
        if (platform === 'darwin') {
          const [idle, batt, lid] = await Promise.all([
            exec('/usr/sbin/ioreg', ['-c', 'IOHIDSystem', '-d', '4', '-r', '-k', 'HIDIdleTime']),
            exec('/usr/bin/pmset', ['-g', 'batt']),
            exec('/usr/sbin/ioreg', ['-r', '-k', 'AppleClamshellState', '-d', '4']),
          ]);
          return compact({ idleSeconds: parseMacIdleSeconds(idle), power: parseMacPower(batt), lidOpen: parseMacLidOpen(lid) });
        }
        if (platform === 'linux') {
          const session = env.XDG_SESSION_ID?.trim();
          const idle = session && /^[A-Za-z0-9_-]+$/.test(session)
            ? parseLogindIdleSeconds(await exec('loginctl', ['show-session', session, '-p', 'IdleHint', '-p', 'IdleSinceHint']), now())
            : undefined;
          return compact({ idleSeconds: idle, power: readLinuxPower(options.powerSupplyRoot) });
        }
      } catch {
        // Unknown: every field stays undefined.
      }
      return {};
    },
  };
}

function compact(reading: { idleSeconds: number | undefined; power?: PowerSource | undefined; lidOpen?: boolean | undefined }): IdlePowerReading {
  const out: IdlePowerReading = {};
  if (reading.idleSeconds !== undefined) out.idleSeconds = reading.idleSeconds;
  if (reading.power !== undefined) out.power = reading.power;
  if (reading.lidOpen !== undefined) out.lidOpen = reading.lidOpen;
  return out;
}

/** The saved choice: `undefined` until the owner sets it (then the default applies). */
export function readGoEasySetting(path: string): boolean | undefined {
  try {
    const value = (JSON.parse(readFileSync(path, 'utf8')) as { go_easy?: unknown }).go_easy;
    return typeof value === 'boolean' ? value : undefined;
  } catch {
    return undefined;
  }
}

export function saveGoEasySetting(path: string, on: boolean): void {
  writePrivateFileAtomicSync(path, `${JSON.stringify({ go_easy: on })}\n`);
}

export interface PowerAssertionChild {
  kill(): void;
  once(event: 'exit', listener: () => void): unknown;
}

export interface LocalWorkPacerOptions {
  probe: IdlePowerProbe;
  /** Where the owner's choice is saved; absent: the default only (tests). */
  settingPath?: string;
  now?: () => Date;
  idleFullSpeedMs?: number;
  refreshMs?: number;
  trickleGapMs?: number;
  /** True while local judging or embedding has work waiting; drives the power assertion. */
  pendingLocalWork?: () => boolean;
  platform?: NodeJS.Platform;
  /** Test seam for `caffeinate`. */
  spawnAssertion?: () => PowerAssertionChild | undefined;
  setInterval?: (callback: () => void, ms: number) => { unref?: () => unknown };
  clearInterval?: (timer: { unref?: () => unknown } | undefined) => void;
  log?: (line: string) => void;
}

export type LocalPace = 'full' | 'trickle';

export class LocalWorkPacer {
  private reading: IdlePowerReading | undefined;
  private readAtMs = Number.NEGATIVE_INFINITY;
  private reading$: Promise<void> | undefined;
  private setting: boolean | undefined;
  private timer: { unref?: () => unknown } | undefined;
  private assertion: PowerAssertionChild | undefined;
  private stopped = false;
  private lastPace: LocalPace | undefined;
  private localWorkAtMs = Number.NEGATIVE_INFINITY;

  constructor(private readonly options: LocalWorkPacerOptions) {
    this.setting = options.settingPath ? readGoEasySetting(options.settingPath) : undefined;
  }

  get trickleGapMs(): number {
    return this.options.trickleGapMs ?? GO_EASY_TRICKLE_GAP_MS;
  }

  /** Reads now and then about every 30 s, holding the power assertion as needed. */
  start(): void {
    if (this.timer || this.stopped) return;
    void this.refresh();
    const every = this.options.setInterval ?? ((callback, ms) => setInterval(callback, ms));
    this.timer = every(() => { void this.refresh(); }, this.options.refreshMs ?? GO_EASY_REFRESH_MS);
    this.timer.unref?.();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) (this.options.clearInterval ?? ((timer) => clearInterval(timer as ReturnType<typeof setInterval>)))(this.timer);
    this.timer = undefined;
    this.release();
  }

  /** What the checkbox shows: the owner's choice, or on for a computer with a battery. */
  goEasy(): boolean {
    if (this.setting !== undefined) return this.setting;
    return this.reading?.power !== 'no_battery';
  }

  /** Read the owner's choice again: another process (the engine split's front) saved it. */
  reloadSetting(): void {
    if (this.options.settingPath) this.setting = readGoEasySetting(this.options.settingPath);
  }

  save(on: boolean): { ok: true; status_message: string } {
    if (this.options.settingPath) saveGoEasySetting(this.options.settingPath, on);
    this.setting = on;
    return { ok: true, status_message: on
      ? 'Saved. Olympus sorts at full speed when you\'re away or it\'s plugged in overnight.'
      : 'Saved. Olympus sorts at full speed whenever it has work.' };
  }

  /**
   * Synchronous and cheap: decided from the cached reading, which is read
   * again in the background once it is older than the refresh period.
   */
  pace(): LocalPace {
    const nowMs = this.nowMs();
    if (!this.stopped && nowMs - this.readAtMs >= (this.options.refreshMs ?? GO_EASY_REFRESH_MS)) void this.refresh();
    const pace = this.decide(nowMs);
    if (pace !== this.lastPace) {
      this.lastPace = pace;
      this.options.log?.(`Olympus local work: ${pace === 'full' ? 'full speed' : 'going easy while this computer is in use'}.`);
    }
    return pace;
  }

  trickle(): boolean {
    return this.pace() === 'trickle';
  }

  /** Local work just made progress (an embedding sweep embedded on this computer): hold the assertion for a while. */
  noteLocalWork(): void {
    this.localWorkAtMs = this.nowMs();
    if (!this.assertion) this.updateAssertion();
  }

  /** Reads the probe once (single flight), then updates the power assertion. */
  refresh(): Promise<void> {
    if (this.reading$) return this.reading$;
    this.reading$ = (async () => {
      try {
        this.reading = await this.options.probe.read();
      } catch {
        this.reading = {};
      }
      this.readAtMs = this.nowMs();
      this.updateAssertion();
    })().finally(() => { this.reading$ = undefined; });
    return this.reading$;
  }

  private decide(nowMs: number): LocalPace {
    const reading = this.reading;
    if (!reading) return 'full';
    const on = this.setting ?? (reading.power !== 'no_battery');
    if (!on) return 'full';
    if (reading.idleSeconds !== undefined && reading.idleSeconds * 1_000 >= (this.options.idleFullSpeedMs ?? GO_EASY_IDLE_FULL_SPEED_MS)) return 'full';
    if (reading.power === 'ac' && isNight(new Date(nowMs))) return 'full';
    // Nothing says anyone is at the keyboard of a computer with no battery.
    if (reading.idleSeconds === undefined && reading.power !== 'ac' && reading.power !== 'battery') return 'full';
    return 'trickle';
  }

  private updateAssertion(): void {
    if ((this.options.platform ?? process.platform) !== 'darwin') return;
    let pending = false;
    try { pending = this.options.pendingLocalWork?.() === true; } catch { pending = false; }
    pending ||= this.nowMs() - this.localWorkAtMs < GO_EASY_LOCAL_WORK_RECENT_MS;
    // On mains power: a laptop on AC with its lid open, or a desktop (no battery).
    const mains = this.reading?.power === 'ac' || this.reading?.power === 'no_battery';
    const hold = !this.stopped && pending && mains && this.reading?.lidOpen !== false;
    if (hold && !this.assertion) {
      try {
        const child = (this.options.spawnAssertion ?? spawnCaffeinate)();
        if (!child) return;
        this.assertion = child;
        child.once('exit', () => { if (this.assertion === child) this.assertion = undefined; });
      } catch {
        this.assertion = undefined;
      }
    } else if (!hold) {
      this.release();
    }
  }

  /** True while the power assertion is held (status and tests). */
  holdingAssertion(): boolean {
    return this.assertion !== undefined;
  }

  private release(): void {
    const child = this.assertion;
    this.assertion = undefined;
    try { child?.kill(); } catch { /* already gone */ }
  }

  private nowMs(): number {
    return (this.options.now?.() ?? new Date()).getTime();
  }
}

export function isNight(at: Date): boolean {
  const hour = at.getHours();
  return GO_EASY_NIGHT.fromHour > GO_EASY_NIGHT.toHour
    ? hour >= GO_EASY_NIGHT.fromHour || hour < GO_EASY_NIGHT.toHour
    : hour >= GO_EASY_NIGHT.fromHour && hour < GO_EASY_NIGHT.toHour;
}

/** `caffeinate -i -w <pid>`: prevents idle sleep, and exits by itself when the engine does. */
function spawnCaffeinate(): PowerAssertionChild | undefined {
  const child = spawn('/usr/bin/caffeinate', ['-i', '-w', String(process.pid)], { stdio: 'ignore', detached: false });
  child.on('error', () => undefined);
  child.unref();
  return child;
}
