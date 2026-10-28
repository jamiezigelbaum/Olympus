/**
 * One pacer per MCP server: calls to the same server are spaced at least
 * `minIntervalMs` apart however many passes or sessions share it, and a
 * rate-limit answer pushes the next allowed call out by its backoff. The
 * pacer belongs to the server, not to a pass, so a manual sync started beside
 * a scheduled one cannot double the rate.
 */

export const MCP_SOURCE_DEFAULT_MIN_INTERVAL_MS = 1_000;

export interface McpCallPacerOptions {
  minIntervalMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export class McpCallPacer {
  readonly minIntervalMs: number;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private nextAt = 0;
  /** Waiters queue in order, so two passes take turns rather than racing. */
  private tail: Promise<void> = Promise.resolve();

  constructor(options: McpCallPacerOptions = {}) {
    const interval = options.minIntervalMs ?? MCP_SOURCE_DEFAULT_MIN_INTERVAL_MS;
    if (!Number.isFinite(interval) || interval < 0) throw new TypeError('An MCP pacer interval must be a non-negative number of milliseconds.');
    this.minIntervalMs = interval;
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  /** Waits for this call's turn, then reserves the next slot. */
  turn(): Promise<void> {
    const mine = this.tail.then(async () => {
      const wait = this.nextAt - this.now();
      if (wait > 0) await this.sleep(wait);
      this.nextAt = this.now() + this.minIntervalMs;
    });
    // A failed sleep must not stall every later caller.
    this.tail = mine.catch(() => undefined);
    return mine;
  }

  /** The provider said slow down: no call before `ms` from now. */
  backoff(ms: number): void {
    if (!Number.isFinite(ms) || ms <= 0) return;
    this.nextAt = Math.max(this.nextAt, this.now() + ms);
  }
}

const pacers = new Map<string, McpCallPacer>();

/**
 * The process's pacer for a server, keyed by its origin and path. The first
 * caller's options set its interval; later callers share it.
 */
export function mcpServerPacer(serverUrl: string, options: McpCallPacerOptions = {}): McpCallPacer {
  const url = new URL(serverUrl);
  const key = `${url.origin}${url.pathname}`;
  let pacer = pacers.get(key);
  if (!pacer) {
    pacer = new McpCallPacer(options);
    pacers.set(key, pacer);
  }
  return pacer;
}
