/**
 * The front's side of the engine split's command channel (commands.ts).
 *
 * `send` posts a command under one id and retries with the same id until the
 * background has a record of it, then waits for the result; a retry is
 * never applied twice. A background that restarts loses its records: an id
 * it no longer holds is posted again and applied once by the new process.
 * The front never waits on the background to answer a page: callers that
 * only need the wake delivered use `post` (receipt only).
 *
 * OwnerBusyRelay carries the owner-busy signal for the shared local model
 * (`localModelActivity.onBusy → tierSniffer.preempt()`, server.ts) across the
 * split, and sends it again when a new background instance appears.
 */
import { ENGINE_BACKGROUND_ORIGIN, ENGINE_COMMANDS_PATH } from '../../core/engine-split.ts';
import { newEngineCommandId, type EngineCommand, type EngineCommandReceipt } from './commands.ts';

export interface EngineCommandClientOptions {
  /** A fetch bound to the background's socket (createUnixSocketFetch). */
  fetch: typeof fetch;
  authToken: string;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  newId?: () => string;
  /** Called with the background instance id each answer names. */
  onInstance?: (instanceId: string) => void;
}

export interface EngineSendOptions {
  /** Give up after this long; the command may still be applied later under its id. */
  timeoutMs?: number;
  /** Reuse an id (the caller's own retry). */
  id?: string;
}

export class EngineCommandUnavailableError extends Error {
  readonly code = 'engine_background_unavailable';
  constructor(message = 'The background engine is not answering; try again in a moment.') {
    super(message);
    this.name = 'EngineCommandUnavailableError';
  }
}

const RETRY_DELAYS_MS = [100, 250, 500, 1_000, 2_000];
const RESULT_WAIT_MS = 10_000;

export class EngineCommandClient {
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;
  private readonly newId: () => string;

  constructor(private readonly options: EngineCommandClientOptions) {
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.now = options.now ?? (() => Date.now());
    this.newId = options.newId ?? newEngineCommandId;
  }

  /** Deliver the command and return its receipt; does not wait for the result. */
  async post(command: EngineCommand, options: EngineSendOptions = {}): Promise<EngineCommandReceipt> {
    const id = options.id ?? this.newId();
    const deadline = this.now() + (options.timeoutMs ?? 30_000);
    return this.postUntil(id, command, deadline);
  }

  /** Deliver the command and wait for the background to apply it. */
  async send(command: EngineCommand, options: EngineSendOptions = {}): Promise<EngineCommandReceipt> {
    const id = options.id ?? this.newId();
    const deadline = this.now() + (options.timeoutMs ?? 60_000);
    let receipt = await this.postUntil(id, command, deadline);
    let attempt = 0;
    while (receipt.state === 'received') {
      if (this.now() >= deadline) throw new EngineCommandUnavailableError('The background engine has not finished this command yet.');
      const wait = Math.max(0, Math.min(RESULT_WAIT_MS, deadline - this.now()));
      const answer = await this.request(`${ENGINE_COMMANDS_PATH}/${encodeURIComponent(id)}?wait=${wait}`, { method: 'GET' });
      if (answer?.status === 200) { receipt = answer.body as EngineCommandReceipt; attempt = 0; continue; }
      // 404: the background restarted and lost the record; post it again under the same id.
      if (answer?.status === 404) { receipt = await this.postUntil(id, command, deadline); continue; }
      await this.sleep(RETRY_DELAYS_MS[Math.min(attempt++, RETRY_DELAYS_MS.length - 1)]!);
    }
    return receipt;
  }

  private async postUntil(id: string, command: EngineCommand, deadline: number): Promise<EngineCommandReceipt> {
    let attempt = 0;
    for (;;) {
      const answer = await this.request(ENGINE_COMMANDS_PATH, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id, command }),
      });
      if (answer && (answer.status === 200 || answer.status === 202)) return answer.body as EngineCommandReceipt;
      // A refusal of the command itself is final; anything else is the background not being there yet.
      if (answer && answer.status >= 400 && answer.status < 500 && answer.status !== 404) {
        throw new Error(typeof (answer.body as { error?: unknown })?.error === 'string' ? (answer.body as { error: string }).error : 'The background refused the command.');
      }
      if (this.now() >= deadline) throw new EngineCommandUnavailableError();
      await this.sleep(RETRY_DELAYS_MS[Math.min(attempt++, RETRY_DELAYS_MS.length - 1)]!);
    }
  }

  private async request(path: string, init: RequestInit): Promise<{ status: number; body: unknown } | undefined> {
    try {
      const response = await this.options.fetch(ENGINE_BACKGROUND_ORIGIN + path, {
        ...init,
        headers: { ...(init.headers as Record<string, string> | undefined), Authorization: `Bearer ${this.options.authToken}` },
      });
      const body = await response.json().catch(() => undefined) as { instance_id?: unknown } | undefined;
      if (typeof body?.instance_id === 'string') this.options.onInstance?.(body.instance_id);
      return { status: response.status, body };
    } catch {
      return undefined;
    }
  }
}

/**
 * The owner's own call on a shared local model, carried to the background.
 * busy()/idle() follow the front's localModelActivity for that resource;
 * the relay sends the change, and when it learns of a new background
 * instance (a restart) while busy, sends owner_busy again so the new
 * judge steps aside too.
 */
export class OwnerBusyRelay {
  private readonly busyResources = new Set<string>();
  private instanceId: string | undefined;
  private renewal: unknown;
  private readonly renewEveryMs: number;
  private readonly setTimer: (callback: () => void, ms: number) => unknown;
  private readonly clearTimer: (timer: unknown) => void;

  /**
   * The background lets an owner-busy mark lapse after 10 minutes, so a front
   * that died mid-call cannot hold the judge back for good. While an owner
   * call is still running the front says busy again every `renewEveryMs`
   * (3 minutes), so a long call keeps the judge preempted to its end.
   */
  constructor(
    private readonly client: Pick<EngineCommandClient, 'post'>,
    private readonly log: (line: string) => void = () => {},
    options: { renewEveryMs?: number; setInterval?: (callback: () => void, ms: number) => unknown; clearInterval?: (timer: unknown) => void } = {},
  ) {
    this.renewEveryMs = options.renewEveryMs ?? 3 * 60_000;
    this.setTimer = options.setInterval ?? ((callback, ms) => { const timer = setInterval(callback, ms); timer.unref?.(); return timer; });
    this.clearTimer = options.clearInterval ?? ((timer) => clearInterval(timer as ReturnType<typeof setInterval>));
  }

  busy(resource: string): void {
    this.busyResources.add(resource);
    this.deliver({ kind: 'owner_busy', resource });
    if (this.renewal === undefined) {
      this.renewal = this.setTimer(() => {
        for (const busy of this.busyResources) this.deliver({ kind: 'owner_busy', resource: busy });
      }, this.renewEveryMs);
    }
  }

  idle(resource: string): void {
    if (!this.busyResources.delete(resource)) return;
    this.deliver({ kind: 'owner_idle', resource });
    if (this.busyResources.size === 0) this.stopRenewal();
  }

  /** Each background instance id the front sees (command answers, the status snapshot). */
  observeInstance(instanceId: string): void {
    if (instanceId === this.instanceId) return;
    const restarted = this.instanceId !== undefined;
    this.instanceId = instanceId;
    if (!restarted) return;
    for (const resource of this.busyResources) this.deliver({ kind: 'owner_busy', resource });
  }

  stop(): void {
    this.stopRenewal();
  }

  private stopRenewal(): void {
    if (this.renewal === undefined) return;
    this.clearTimer(this.renewal);
    this.renewal = undefined;
  }

  isBusy(resource: string): boolean {
    return this.busyResources.has(resource);
  }

  private deliver(command: EngineCommand): void {
    void this.client.post(command, { timeoutMs: 30_000 }).catch(() => {
      this.log(`[engine-split] ${command.kind} could not reach the background engine; it is sent again when the background is back.`);
    });
  }
}
