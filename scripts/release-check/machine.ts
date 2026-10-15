/**
 * The seam between the generic release check and a host-specific driver.
 *
 * A driver is any executable that implements these verbs (argv after the
 * driver's own fixed arguments). The harness never imports a driver and the
 * driver never imports the harness; they meet only at this process boundary,
 * so host names, accounts and VM tooling stay out of the public repository and
 * a Mac driver can follow the Linux one without changing the harness.
 *
 *   provision --run-id <id> --candidate <dir> --workdir <dir>
 *       Creates a throwaway machine, installs the candidate on it through the
 *       product's public installer for its platform, and sets up its owner the
 *       supported way. Prints a single JSON line on stdout:
 *       {"machine":"<handle>","label":"...","os":"linux|macos","driver":"..."}
 *       Diagnostics go to stderr. Exit 0 only when the install is usable.
 *   exec --machine <handle> --timeout-s <n>
 *       Reads a bash script on stdin and runs it on the machine as its normal
 *       (non-root) test user in a login/session environment with the user's
 *       service manager reachable. stdout/stderr and the exit status pass
 *       through. Exit status 124 means the timeout expired.
 *   put --machine <handle> --from <local path> --to <machine path>
 *   get --machine <handle> --from <machine path> --to <local path>
 *   destroy --machine <handle> | --run-id <id>
 *       Deletes the machine. Idempotent: destroying a missing machine exits 0.
 *       `--run-id` removes whatever a run created, even when provision failed
 *       before it printed a handle, so the driver names its machine from the run id.
 *   reap --older-than-min <n>
 *       Optional. Destroys leftovers from earlier runs of this driver.
 */
import { spawn } from 'node:child_process';

export interface ExecOptions {
  stdin?: string;
  timeoutMs?: number;
}

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  ms: number;
}

export interface MachineInfo {
  handle: string;
  label: string;
  os: 'linux' | 'macos';
  driver: string;
}

export interface Machine extends MachineInfo {
  exec(script: string, options?: ExecOptions): Promise<ExecResult>;
  put(from: string, to: string): Promise<void>;
  get(from: string, to: string): Promise<void>;
}

interface RunOptions extends ExecOptions {
  /** Where driver diagnostics are copied, when given. */
  onStderr?: (chunk: string) => void;
}

function run(argv: readonly string[], options: RunOptions = {}): Promise<ExecResult> {
  const started = Date.now();
  return new Promise((resolve) => {
    const child = spawn(argv[0]!, argv.slice(1), { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = options.timeoutMs === undefined ? undefined : setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 5_000).unref();
    }, options.timeoutMs);
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8'); });
    child.stderr.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8');
      stderr += text;
      options.onStderr?.(text);
    });
    child.on('error', (error) => {
      if (timer) clearTimeout(timer);
      resolve({ code: 127, stdout, stderr: `${stderr}${error.message}\n`, timedOut, ms: Date.now() - started });
    });
    child.on('close', (code) => {
      if (timer) clearTimeout(timer);
      resolve({ code: timedOut ? 124 : (code ?? 1), stdout, stderr, timedOut, ms: Date.now() - started });
    });
    if (options.stdin !== undefined) child.stdin.end(options.stdin); else child.stdin.end();
  });
}

export interface DriverOptions {
  /** The driver executable and its fixed leading arguments. */
  argv: readonly string[];
  /** Receives every driver diagnostic line, so the run's log has the full story. */
  onLog?: (line: string) => void;
}

export function parseProvisionLine(stdout: string): MachineInfo {
  // Progress meters redraw with carriage returns and can leave the JSON on their last line, so
  // the object is taken from the last occurrence of the machine key rather than the whole line.
  const at = stdout.lastIndexOf('{"machine"');
  const end = stdout.indexOf('}', at);
  let parsed: Record<string, unknown>;
  try {
    if (at === -1 || end === -1) throw new Error('no object');
    parsed = JSON.parse(stdout.slice(at, end + 1)) as Record<string, unknown>;
  } catch {
    throw new Error('driver provision did not end with a JSON line');
  }
  const { machine, label, os, driver } = parsed;
  if (typeof machine !== 'string' || machine.length === 0 || /[^A-Za-z0-9._:-]/.test(machine)) throw new Error('driver provision returned an unusable machine handle');
  if (os !== 'linux' && os !== 'macos') throw new Error('driver provision returned an unknown os');
  return {
    handle: machine,
    label: typeof label === 'string' && label ? label : machine,
    os,
    driver: typeof driver === 'string' && driver ? driver : 'driver',
  };
}

export class CommandDriver {
  constructor(private readonly options: DriverOptions) {}

  private log = (text: string): void => {
    // Transfer meters redraw one line with carriage returns; keep a finished transfer, drop the redraws and bare dots.
    for (const line of text.split(/[\r\n]+/)) {
      const trimmed = line.trim();
      if (!trimmed || /^\.+$/.test(trimmed)) continue;
      if (/^(Pushing|Pulling) .*\d+%/.test(trimmed) && !trimmed.includes('100%')) continue;
      this.options.onLog?.(trimmed);
    }
  };

  async provision(args: { runId: string; candidateDir: string; workdir: string; timeoutMs: number }): Promise<Machine> {
    const result = await run(
      [...this.options.argv, 'provision', '--run-id', args.runId, '--candidate', args.candidateDir, '--workdir', args.workdir],
      { timeoutMs: args.timeoutMs, onStderr: this.log },
    );
    if (result.code !== 0) {
      // A failed provision may have left a machine behind; the caller destroys it by run id.
      throw new Error(`driver provision failed (exit ${result.code}${result.timedOut ? ', timed out' : ''})`);
    }
    return this.machineFor(parseProvisionLine(result.stdout));
  }

  machineFor(info: MachineInfo): Machine {
    const base = this.options.argv;
    const log = this.log;
    return {
      ...info,
      exec: (script, options = {}) => run(
        [...base, 'exec', '--machine', info.handle, '--timeout-s', String(Math.ceil((options.timeoutMs ?? 120_000) / 1000))],
        // The harness always sends the script on stdin; data goes through put.
        { stdin: script, timeoutMs: (options.timeoutMs ?? 120_000) + 15_000 },
      ),
      put: async (from, to) => {
        const r = await run([...base, 'put', '--machine', info.handle, '--from', from, '--to', to], { timeoutMs: 120_000, onStderr: log });
        if (r.code !== 0) throw new Error(`driver put failed (exit ${r.code})`);
      },
      get: async (from, to) => {
        const r = await run([...base, 'get', '--machine', info.handle, '--from', from, '--to', to], { timeoutMs: 120_000, onStderr: log });
        if (r.code !== 0) throw new Error(`driver get failed (exit ${r.code})`);
      },
    };
  }

  /** Deletes the machine by handle, or everything a run created by run id when it never got a handle. */
  async destroy(target: { handle: string } | { runId: string }): Promise<void> {
    const selector = 'handle' in target ? ['--machine', target.handle] : ['--run-id', target.runId];
    const r = await run([...this.options.argv, 'destroy', ...selector], { timeoutMs: 180_000, onStderr: this.log });
    if (r.code !== 0) {
      // The driver's last line says which machine may be left and how to remove it by hand; the report carries it.
      const last = r.stderr.split(/[\r\n]+/).map((line) => line.trim()).filter(Boolean).pop();
      throw new Error(`driver destroy failed (exit ${r.code})${last ? `: ${last.slice(0, 400)}` : ''}`);
    }
  }

  async reap(olderThanMin: number): Promise<void> {
    await run([...this.options.argv, 'reap', '--older-than-min', String(olderThanMin)], { timeoutMs: 180_000, onStderr: this.log });
  }
}
