import type { Machine } from './machine.ts';
import type { CheckResult } from './report.ts';
import type { RunClock } from './run.ts';

/** Real-machine legs share the VM harness's declared limits, without changing their models. */
export class LegBudget {
  readonly started: number;
  readonly deadline: number;
  readonly timings: Record<string, number> = {};
  private phaseDeadline = Infinity;
  private cleaningUp = false;
  private result?: CheckResult;
  private readonly timer: unknown;

  constructor(readonly kind: string, readonly budgetMs: number, readonly record: (check: CheckResult) => void, readonly clock: RunClock = { now: Date.now, setTimeout, clearTimeout }) {
    this.started = this.clock.now();
    this.deadline = this.started + budgetMs;
    console.error(`leg ${kind}: budget ${budgetMs / 60_000} minutes`);
    this.timer = this.clock.setTimeout(() => this.report('fail'), budgetMs);
  }

  private report(status: 'pass' | 'fail'): void {
    const ms = this.clock.now() - this.started;
    const detail = `${this.kind}: ${Math.round(ms / 1000)}s / ${this.budgetMs / 1000}s; ${JSON.stringify(this.timings)}`;
    if (this.result) { this.result.detail = detail; this.result.ms = ms; return; }
    this.result = { id: 'leg.time-budget', title: 'The leg finishes within its wall-clock budget', status, ms, detail };
    this.record(this.result);
  }

  async phase<T>(name: string, budgetMs: number, work: () => Promise<T>): Promise<T> {
    const start = this.clock.now();
    const prior = this.phaseDeadline;
    this.phaseDeadline = Math.min(this.cleaningUp ? Infinity : this.deadline, start + budgetMs);
    let failed = false;
    const fail = () => {
      if (failed) return;
      failed = true;
      this.record({ id: `phase.${name}.time-budget`, title: `${name} finishes within its bound`, status: 'fail',
        detail: `${name}: ${this.clock.now() - start}ms / ${budgetMs}ms; ${JSON.stringify(this.timings)}` });
    };
    const timer = this.clock.setTimeout(fail, budgetMs);
    try { return await work(); } finally {
      this.clock.clearTimeout(timer);
      this.timings[name] = this.clock.now() - start;
      if (this.clock.now() - start > budgetMs) fail();
      this.phaseDeadline = prior;
    }
  }

  machine(machine: Machine): Machine {
    return { ...machine,
      upgrade: (candidate, options = {}) => machine.upgrade(candidate, { ...options,
        timeoutMs: Math.min(options.timeoutMs ?? 25 * 60_000, Math.max(1, this.deadline - this.clock.now())) }),
      exec: (script, options = {}) => machine.exec(script, { ...options,
      timeoutMs: Math.min(options.timeoutMs ?? 120_000, Math.max(1, Math.min(this.cleaningUp ? Infinity : this.deadline, this.phaseDeadline) - this.clock.now())) }),
    };
  }

  cleanup(): void { this.cleaningUp = true; this.phaseDeadline = Infinity; }

  finish(): void {
    this.clock.clearTimeout(this.timer);
    this.report(this.clock.now() > this.deadline ? 'fail' : 'pass');
  }
}
