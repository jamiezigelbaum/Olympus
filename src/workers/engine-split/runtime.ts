/**
 * The engine split's wiring for the worker's `main()` (server.ts): the
 * background's command socket and status publisher, and the front's command
 * client, owner-busy relay and snapshot reader. Kept here so `main()` only
 * chooses by role (core/engine-split.ts).
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { lstatSync } from 'node:fs';
import { ENGINE_BACKGROUND_SOCKET_ENV, prepareEngineBackgroundSocketDirectory, probeEngineBackground } from '../../core/engine-split.ts';
import { sharedDataPath } from '../../core/olympus-layout.ts';
import { removeFileDurablySync } from '../../core/atomic-file.ts';
import { bindWorkerSocket, createUnixSocketFetch, workerSocketListenerStopped, workerSocketServe } from '../../core/worker-transport.ts';
import { EngineCommandClient, OwnerBusyRelay } from './client.ts';
import { createEngineCommandHandler, ENGINE_FORWARDED_ROUTES, EngineCommandLedger, requestToForwarded, type EngineCommandHandlers, type EngineForwardedKind, type EngineForwardedResponse } from './commands.ts';
import { ENGINE_STATUS_STALE_MS, readEngineStatusSnapshot, startEngineStatusPublisher, type EngineStatusRead, type EngineStatusSnapshot } from './snapshot.ts';

export function engineBackgroundSocketFromEnv(env: Record<string, string | undefined>): string {
  const path = env[ENGINE_BACKGROUND_SOCKET_ENV]?.trim();
  if (!path) throw new Error(`${ENGINE_BACKGROUND_SOCKET_ENV} is required when the worker runs split.`);
  return path;
}

export function engineStatusSnapshotPath(env: Record<string, string | undefined>): string {
  return sharedDataPath('engine-status', env);
}

/**
 * Bind the background's command socket. Called after the data-owner lock is
 * held, so a socket left on the path belongs to a stopped background of this
 * data root: it is removed once no listener answers on it, and refused
 * otherwise.
 */
export function startEngineBackgroundServer(input: {
  socketPath: string;
  authToken: string;
  handlers: EngineCommandHandlers;
  instanceId?: string;
  log?: (line: string) => void;
}): { instanceId: string; markReady(): void; markStopping(): void; stop(): void; ledger: EngineCommandLedger } {
  const instanceId = input.instanceId ?? randomUUID();
  prepareEngineBackgroundSocketDirectory(input.socketPath);
  let present = false;
  try { present = lstatSync(input.socketPath).isSocket(); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  if (present) {
    if (workerSocketListenerStopped(input.socketPath) !== true) throw new Error('The background command socket is held by a running process.');
    removeFileDurablySync(input.socketPath);
    input.log?.('[engine-split] removed the command socket a stopped background left.');
  }
  let ready = false;
  const ledger = new EngineCommandLedger({ instanceId, handlers: input.handlers });
  const handler = createEngineCommandHandler({ authToken: input.authToken, ledger, ready: () => ready });
  const server = bindWorkerSocket(input.socketPath, () => Bun.serve(workerSocketServe({
    unix: input.socketPath,
    fetch: (request: Request) => handler(request),
  })));
  return {
    instanceId,
    ledger,
    markReady: () => { ready = true; },
    /** Stop answering ready (the probe and new commands) while results stay readable: the background is about to restart. */
    markStopping: () => { ready = false; },
    stop: () => { void server.stop(true); },
  };
}

export function startEngineBackgroundStatus(input: {
  env: Record<string, string | undefined>;
  instanceId: string;
  collect: () => Omit<EngineStatusSnapshot, 'schema' | 'instance_id' | 'written_at'>;
}): { publish(): void; stop(): void } {
  return startEngineStatusPublisher({
    path: engineStatusSnapshotPath(input.env),
    instanceId: input.instanceId,
    collect: input.collect,
    log: (line) => console.warn(line),
  });
}

/** The front waits here, before it opens anything, until the background has done its boot work. */
export async function waitForEngineBackground(input: {
  socketPath: string;
  authToken: string;
  timeoutMs?: number;
  pollMs?: number;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}): Promise<void> {
  const fetchBackground = input.fetch ?? createUnixSocketFetch(input.socketPath);
  const now = input.now ?? (() => Date.now());
  const sleep = input.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  const deadline = now() + (input.timeoutMs ?? 120_000);
  for (;;) {
    if (await probeEngineBackground(fetchBackground, input.authToken, undefined, 1_000)) return;
    if (now() >= deadline) throw new Error('The background engine did not become ready; the front is not serving.');
    await sleep(input.pollMs ?? 250);
  }
}

export interface EngineFront {
  client: EngineCommandClient;
  ownerBusy: OwnerBusyRelay;
  /** The background's last status snapshot and its age; read from disk at most once a second. */
  status(): EngineStatusRead | undefined;
  stop(): void;
}

export function createEngineFront(input: {
  env: Record<string, string | undefined>;
  socketPath: string;
  authToken: string;
  fetch?: typeof fetch;
  now?: () => number;
}): EngineFront {
  const now = input.now ?? (() => Date.now());
  let relay: OwnerBusyRelay | undefined;
  // The background instance that last answered a command: a snapshot another
  // instance wrote is not about the background running now.
  let answering: string | undefined;
  const client = new EngineCommandClient({
    fetch: input.fetch ?? createUnixSocketFetch(input.socketPath),
    authToken: input.authToken,
    onInstance: (instanceId) => { answering = instanceId; relay?.observeInstance(instanceId); },
  });
  relay = new OwnerBusyRelay(client, (line) => console.warn(line));
  const path = engineStatusSnapshotPath(input.env);
  let cached: { at: number; read: EngineStatusRead | undefined } | undefined;
  const judged = (read: EngineStatusRead, age: number): EngineStatusRead => ({
    ...read,
    age_ms: age,
    stale: age > ENGINE_STATUS_STALE_MS || (answering !== undefined && answering !== read.snapshot.instance_id),
  });
  const status = (): EngineStatusRead | undefined => {
    const at = now();
    if (cached && at - cached.at < 1_000) {
      return cached.read ? judged(cached.read, cached.read.age_ms + (at - cached.at)) : undefined;
    }
    const read = readEngineStatusSnapshot(path, now);
    cached = { at, read };
    if (read) relay?.observeInstance(read.snapshot.instance_id);
    return read ? judged(read, read.age_ms) : undefined;
  };
  // Notice a background restart even when no page asks for status, so the
  // owner-busy signal reaches the new judge.
  const poll = setInterval(() => { status(); }, 2_000);
  poll.unref?.();
  return { client, ownerBusy: relay, status, stop: () => { clearInterval(poll); relay?.stop(); } };
}

function restartingResponse(): Response {
  return Response.json({ error: { code: 'worker_restarting', message: 'Olympus is restarting; try again in a moment.' } }, { status: 503 });
}

/**
 * The front's read gate. Closed, every request is answered "restarting",
 * and a response that was being produced when it closed is dropped for the
 * same answer, so nothing read before a delete reaches anyone after it. The
 * one request that closed the gate (the delete itself) is answered.
 */
export function createFrontGate() {
  let open = true;
  let generation = 0;
  const current = new AsyncLocalStorage<{ closedTheGate: boolean }>();
  return {
    isOpen: () => open,
    close() {
      open = false;
      generation += 1;
      const request = current.getStore();
      if (request) request.closedTheGate = true;
    },
    reopen() { open = true; },
    wrap<S>(handler: (request: Request, server: S) => Response | Promise<Response>) {
      return async (request: Request, server: S): Promise<Response> => {
        if (!open) return restartingResponse();
        const started = generation;
        const context = { closedTheGate: false };
        const response = await current.run(context, () => handler(request, server));
        if (!context.closedTheGate && (started !== generation || !open)) {
          await response.body?.cancel().catch(() => undefined);
          return restartingResponse();
        }
        return response;
      };
    },
  };
}

export type FrontGate = ReturnType<typeof createFrontGate>;

function forwardedKindFor(path: string): EngineForwardedKind | undefined {
  for (const [kind, paths] of Object.entries(ENGINE_FORWARDED_ROUTES) as Array<[EngineForwardedKind, readonly string[]]>) {
    if (paths.includes(path)) return kind;
  }
  return undefined;
}

/**
 * The tier commands that only read: `explain`, `rules list`, `classifier
 * status` and `migrate status`. They run in the front on read-only opens;
 * every other tier command writes and runs in the background.
 */
export function tierCommandOnlyReads(body: string): boolean {
  try {
    const args = (JSON.parse(body) as { args?: unknown }).args;
    if (!Array.isArray(args)) return false;
    const [command, sub] = args;
    return command === 'explain'
      || (command === 'rules' && sub === 'list')
      || (command === 'classifier' && sub === 'status')
      || (command === 'migrate' && sub === 'status');
  } catch {
    return false;
  }
}

/**
 * The front's handling of the owner actions that write background-owned
 * data: each is forwarded to the background as its command and answered
 * with the background's response. Called behind the front's own
 * authorization (the worker bearer or the dashboard session), which the
 * request has passed; the background runs the route's own handler, with its
 * own checks of the body. Tier reads stay in the front, read-only.
 *
 * Deleting a source's data follows the design note's order: the front stops
 * admitting reads and drops results in flight (the gate), then the
 * background checks custody, marks the account deleting, stops answering
 * ready, and waits for this front's process to end before it restarts and
 * deletes at boot; this front restarts as soon as the delete is answered,
 * which closes every connection it holds on every thread, the off-thread
 * pool's included. The new front waits for the background to be ready,
 * which comes only after the deletion. A crash anywhere resumes from the
 * mark.
 */
export function createEngineFrontRoutes(input: {
  client: Pick<EngineCommandClient, 'send'>;
  gate: FrontGate;
  restartFront: () => void;
  timeoutMs?: number;
  /** This front's process, which the background waits out before it deletes. */
  pid?: number;
}): (request: Request) => Promise<Response | undefined> | undefined {
  const pid = input.pid ?? process.pid;
  /** The background's answer, or why there is none: the command was not answered, or it failed there. */
  const exchange = async (kind: EngineForwardedKind, request: Request): Promise<
    { answer: EngineForwardedResponse } | { unanswered: string } | { failed: string }
  > => {
    const forwarded = await requestToForwarded(request);
    let receipt;
    try {
      receipt = await input.client.send(
        { kind, request: forwarded, ...(kind === 'delete_source_data' ? { frontPid: pid } : {}) },
        // Extraction and embedding batches can run for minutes, as they did in the one process.
        { timeoutMs: input.timeoutMs ?? (kind === 'extraction_queue' || kind === 'embed_chunks' ? 15 * 60_000 : 120_000) },
      );
    } catch (error) {
      return { unanswered: error instanceof Error ? error.message : 'The background engine is not answering.' };
    }
    if (receipt.state !== 'done') return { failed: receipt.error ?? 'The background could not run this.' };
    return { answer: receipt.result as EngineForwardedResponse };
  };
  const send = async (kind: EngineForwardedKind, request: Request): Promise<Response> => {
    const outcome = await exchange(kind, request);
    if ('unanswered' in outcome) return Response.json({ error: { code: 'engine_background_unavailable', message: outcome.unanswered } }, { status: 503 });
    if ('failed' in outcome) return Response.json({ error: { code: 'engine_background_failed', message: outcome.failed } }, { status: 502 });
    return new Response(outcome.answer.body, { status: outcome.answer.status, headers: outcome.answer.headers });
  };
  return (request) => {
    if (request.method !== 'POST') return undefined;
    const path = new URL(request.url).pathname;
    const kind = forwardedKindFor(path);
    if (!kind) return undefined;
    return (async (): Promise<Response | undefined> => {
      if (!input.gate.isOpen()) return restartingResponse();
      if (path === '/v1/cli/tier' && tierCommandOnlyReads(await request.clone().text())) return undefined;
      if (kind !== 'delete_source_data') return send(kind, request);
      input.gate.close();
      let outcome: Awaited<ReturnType<typeof exchange>>;
      try {
        outcome = await exchange(kind, request);
      } catch {
        outcome = { unanswered: 'The delete could not be sent.' };
      }
      if (!('answer' in outcome)) {
        // Unknown whether the background marked the account: reads stay
        // closed, and the front restarts, which closes every connection; the
        // new front waits for the background, which deletes at its boot if it
        // marked the account and otherwise changed nothing.
        input.restartFront();
        return restartingResponse();
      }
      const response = new Response(outcome.answer.body, { status: outcome.answer.status, headers: outcome.answer.headers });
      const restarting = response.status === 200
        && (await response.clone().json().catch(() => undefined) as { worker_restarting?: unknown } | undefined)?.worker_restarting === true;
      // The background's own answer: a refusal or a dry run changed nothing.
      if (restarting) input.restartFront();
      else input.gate.reopen();
      return response;
    })();
  };
}

/**
 * Wait for a process to end: the background waits out the front before it
 * deletes a source's files. Gives up after `timeoutMs`, which only a front
 * that hangs on its way out reaches.
 */
export async function waitForProcessExit(pid: number, options: {
  timeoutMs?: number;
  intervalMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  alive?: (pid: number) => boolean;
} = {}): Promise<boolean> {
  const now = options.now ?? (() => Date.now());
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const alive = options.alive ?? ((target: number) => {
    try { process.kill(target, 0); return true; }
    catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM'; }
  });
  const deadline = now() + (options.timeoutMs ?? 60_000);
  while (alive(pid)) {
    if (now() >= deadline) return false;
    await sleep(options.intervalMs ?? 250);
  }
  return true;
}

/**
 * The background's record of the owner's own calls on a shared local model.
 * Busy and idle travel as separate commands that can be retried or delayed,
 * so each carries its front and a sequence number: a change older than the
 * last one applied for that resource is ignored. A new front (a restart)
 * supersedes the old one's marks. A busy mark lapses after `lapseMs`, so a
 * front that died mid-call cannot hold the judge back for good.
 */
export class OwnerBusyMarks {
  private readonly marks = new Map<string, { front: string; seq: number; busyUntil: number }>();
  private readonly lapseMs: number;
  private readonly now: () => number;

  constructor(options: { lapseMs?: number; now?: () => number } = {}) {
    this.lapseMs = options.lapseMs ?? 10 * 60_000;
    this.now = options.now ?? (() => Date.now());
  }

  /** Apply a busy or idle change; false when it is stale and changed nothing. */
  apply(change: { kind: 'owner_busy' | 'owner_idle'; resource: string; front: string; seq: number }): boolean {
    const last = this.marks.get(change.resource);
    if (last && last.front === change.front && change.seq <= last.seq) return false;
    this.marks.set(change.resource, { front: change.front, seq: change.seq, busyUntil: change.kind === 'owner_busy' ? this.now() + this.lapseMs : 0 });
    return true;
  }

  busy(resource: string): boolean {
    return (this.marks.get(resource)?.busyUntil ?? 0) > this.now();
  }
}
