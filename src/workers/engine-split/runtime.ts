import type { MemoryActivity } from '../../core/memory-counters.ts';
/**
 * The engine split's wiring for the worker's `main()` (server.ts): the
 * background's command socket and status publisher, and the front's command
 * client, owner-busy relay and snapshot reader. Kept here so `main()` only
 * chooses by role (core/engine-split.ts).
 */
import { readBootProgressAsync, type BootProgress } from '../../core/boot-progress.ts';
import { engineHeartbeatBeating, engineHeartbeatLine, processAlive, readEngineHeartbeat } from '../../core/engine-heartbeat.ts';
import { engineStartingAnswer, engineStartingResponse } from '../../core/worker-front-proxy.ts';
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { lstatSync } from 'node:fs';
import { ENGINE_BACKGROUND_ORIGIN, ENGINE_BACKGROUND_SOCKET_ENV, ENGINE_MODEL_COMPLETE_PATH, prepareEngineBackgroundSocketDirectory, probeEngineBackground } from '../../core/engine-split.ts';
import type { AnalystModelCompletion, AnalystModelRequest } from '../../core/analyst.ts';
import { OperationError, type OperationErrorCode } from '../../core/operation-error.ts';
import { sharedDataPath } from '../../core/olympus-layout.ts';
import { removeFileDurablySync } from '../../core/atomic-file.ts';
import { bindWorkerSocket, createUnixSocketFetch, prepareWorkerSocket, releaseSystemdWorkerSocket, WORKER_SOCKET_SERVE_OPTIONS, workerSocketListenerStopped, workerSocketServe } from '../../core/worker-transport.ts';
import { EngineCommandClient, OwnerBusyRelay } from './client.ts';
import { clickTraces, PRIVACY_ITEM_SET_PATH, type ClickTrace } from './click-trace.ts';
import { startEngineControlPlane, type EngineControlPlane } from './control-plane.ts';
import { currentLocalInferencePriority } from '../answer-activity.ts';
import { createEngineCommandHandler, ENGINE_FORWARDED_ROUTES, EngineCommandLedger, requestToForwarded, type EngineCommandHandlers, type EngineCommandReceipt, type EngineForwardedKind, type EngineForwardedRequest, type EngineForwardedResponse } from './commands.ts';
import { engineStatusAge, engineStatusCollectedAt, readEngineStatusSnapshotAsync, startEngineStatusPublisher, type EngineStatusRead, type EngineStatusSnapshot } from './snapshot.ts';
import { parseOwnerTierItemId } from '../classification/tier-owner-items.ts';
import type { PendingItemProtection } from '../connector-store/tier-visibility.ts';
import { DASHBOARD_CONTROL_GRADE_CONTEXT_HEADER } from '../http.ts';

export function engineBackgroundSocketFromEnv(env: Record<string, string | undefined>): string {
  const path = env[ENGINE_BACKGROUND_SOCKET_ENV]?.trim();
  if (!path) throw new Error(`${ENGINE_BACKGROUND_SOCKET_ENV} is required when the worker runs split.`);
  return path;
}

export function engineStatusSnapshotPath(env: Record<string, string | undefined>): string {
  return sharedDataPath('engine-status', env);
}

/** Each running background's control thread, for its status publisher (startEngineBackgroundStatus). */
const controlPlanes = new Map<string, EngineControlPlane>();

/**
 * Bind the background's command socket. Called after the data-owner lock is
 * held, so a socket left on the path belongs to a stopped background of this
 * data root: it is removed once no listener answers on it, and refused
 * otherwise.
 *
 * The socket is served by the control thread (control-plane.ts), so a command
 * is accepted and answered while this loop is held; the ledger here still
 * applies it. Where there is no thread to use, or it ends, the loop serves
 * the socket itself, as it did before, and says so.
 */
export function startEngineBackgroundServer(input: {
  socketPath: string;
  authToken: string;
  handlers: EngineCommandHandlers;
  /** The built-in private model's completions, for the front (commands.ts). */
  modelComplete?: (request: AnalystModelRequest) => Promise<AnalystModelCompletion>;
  instanceId?: string;
  log?: (line: string) => void;
  /** False serves the socket from this loop (tests of the loop's own handler). */
  controlThread?: boolean;
  /** Tests only: how the control thread is made. */
  createControlWorker?: (path: string) => Worker;
}): { instanceId: string; markReady(): void; markStopping(): void; stop(): void; ledger: EngineCommandLedger; servedBy(): 'control-thread' | 'loop' } {
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
  let loopServer: { stop(closeActiveConnections?: boolean): unknown } | undefined;
  const serveFromLoop = (): void => {
    const handler = createEngineCommandHandler({ authToken: input.authToken, ledger, ready: () => ready, ...(input.modelComplete ? { modelComplete: input.modelComplete } : {}) });
    loopServer = bindWorkerSocket(input.socketPath, () => Bun.serve(workerSocketServe({
      unix: input.socketPath,
      fetch: (request: Request) => handler(request),
    })));
  };
  const log = input.log ?? ((line: string) => console.warn(line));
  let stopped = false;
  let control = input.controlThread === false ? undefined : startEngineControlPlane({
    socketPath: input.socketPath,
    authToken: input.authToken,
    instanceId,
    ledger,
    ...(input.modelComplete ? { modelComplete: input.modelComplete } : {}),
    ...(input.createControlWorker ? { createWorker: input.createControlWorker } : {}),
    log,
    // The thread ended: its socket went with it. The ledger here holds every
    // command, so the loop takes the socket over and nothing is lost.
    onLost: (reason) => {
      controlPlanes.delete(instanceId);
      control = undefined;
      if (stopped) return;
      log(`[engine-split] the control thread ended (${reason}); the engine loop answers commands and publishes status from here on.`);
      try {
        removeFileDurablySync(input.socketPath);
        serveFromLoop();
      } catch (error) {
        log(`[engine-split] the engine loop could not take over the command socket: ${error instanceof Error ? error.message : String(error)}`);
      }
    },
  });
  if (control) {
    controlPlanes.set(instanceId, control);
  } else {
    if (input.controlThread !== false) log('[engine-split] no control thread here; the engine loop answers commands and publishes status.');
    serveFromLoop();
  }
  return {
    instanceId,
    ledger,
    markReady: () => { ready = true; control?.setReady(true); },
    /** Stop answering ready (the probe and new commands) while results stay readable: the background is about to restart. */
    markStopping: () => { ready = false; control?.setReady(false); },
    stop: () => {
      stopped = true;
      controlPlanes.delete(instanceId);
      control?.stop();
      void loopServer?.stop(true);
    },
    servedBy: () => (control ? 'control-thread' : 'loop'),
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
    collect: () => ({ ...input.collect(), control_plane: controlPlanes.has(input.instanceId) ? 'thread' as const : 'loop' as const }),
    // The loop collects; this background's control thread writes, and keeps
    // writing while the loop is held. With no thread the loop writes.
    hand: (state, at) => controlPlanes.get(input.instanceId)?.publishState(state, at, engineStatusSnapshotPath(input.env)) ?? false,
    handFailure: (failure) => controlPlanes.get(input.instanceId)?.publishFailure(failure, engineStatusSnapshotPath(input.env)),
    log: (line) => console.warn(line),
  });
}

/**
 * The background's receipt that its boot work is done: its boot file says
 * done, written by a process that is still alive. The file lives in the data
 * root and names its writer's pid; a new background starts it over before
 * any boot work, and a background about to restart for a delete or a model
 * change withdraws it, so a receipt from an earlier boot is never taken as
 * current. No clock is read: a laptop that slept or a late heartbeat write
 * changes nothing.
 */
export function backgroundBootDone(boot: BootProgress | undefined, alive: (pid: number) => boolean = processAlive): boolean {
  return boot?.phase === 'done' && Number.isSafeInteger(boot.pid) && boot.pid > 0 && alive(boot.pid);
}

/**
 * The front waits here, before it opens anything, until the background's
 * boot work is done: on its receipt, never on its answer. A background that
 * is busy (an 86 s first-open backup on the gate7 success leg for 893087f5)
 * answers late, and the front no longer waits for that. It never gives up: a
 * background that exits is restarted by its supervisor, and the front opens
 * its stores once that one's boot is done.
 */
export async function waitForBackgroundBootDone(input: {
  env: Record<string, string | undefined>;
  pollMs?: number;
  sleep?: (ms: number) => Promise<void>;
  read?: () => BootProgress | undefined | Promise<BootProgress | undefined>;
  alive?: (pid: number) => boolean;
}): Promise<void> {
  const sleep = input.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  const read = input.read ?? (() => readBootProgressAsync(input.env));
  while (!backgroundBootDone(await read(), input.alive)) await sleep(input.pollMs ?? 250);
}

/**
 * The front listens at once and answers "starting" with its boot progress.
 * Once ready it reloads the fetch handler on this same listener.
 */
export function listenWhileStarting(input: {
  env: Record<string, string | undefined>;
  hostname: string;
  port: number;
  log?: (line: string) => void;
}): { socketPath: string | undefined; server: Bun.Server<undefined> } | undefined {
  const answer = (request: Request) => engineStartingResponse(request, input.env);
  try {
    if (releaseSystemdWorkerSocket()) (input.log ?? console.warn)('[olympus:worker] removed the socket left by the previous worker run');
    const socketPath = prepareWorkerSocket();
    const server = socketPath
      ? bindWorkerSocket(socketPath, () => Bun.serve(workerSocketServe({ unix: socketPath, fetch: answer })))
      : Bun.serve({ hostname: input.hostname, port: input.port, ...WORKER_SOCKET_SERVE_OPTIONS, fetch: answer });
    return { socketPath, server };
  } catch (error) {
    // Not listening yet is what the front did before: its own server reports a bind failure.
    (input.log ?? console.warn)(`[engine-split] the front could not answer while starting: ${error instanceof Error ? error.message : String(error)}`);
    return undefined;
  }
}

export interface EngineFront {
  client: EngineCommandClient;
  ownerBusy: OwnerBusyRelay;
  /** The background's last status snapshot and its age; refreshed asynchronously at most once a second. */
  status(): EngineStatusRead | undefined;
  cachedStatus(): EngineStatusRead | undefined;
  refreshStatus(): Promise<void>;
  /** The held count accepted from the ready writer. */
  heldItems(): { pendingCount: number; pendingCountObservedAt: string } | undefined;
  /** The last snapshot read, with no disk read and no refresh. */
  cachedSnapshot(): EngineStatusRead['snapshot'] | undefined;
  /** The polled activity, with no disk read or status refresh on the log path. */
  backgroundActivity(): MemoryActivity;
  /** One built-in model completion, run by the background, which holds the model. */
  completeModel(request: AnalystModelRequest): Promise<AnalystModelCompletion>;
  /** Whether the background's boot work is done and its process is alive, busy or not (the front's health reports it). */
  backgroundReady(): Promise<boolean>;
  /** Keep the starting listener in place while the previous front's Private clicks can still commit. */
  waitForPendingPrivacyRaises(): Promise<void>;
  stop(): void;
}

export function createEngineFront(input: {
  env: Record<string, string | undefined>;
  socketPath: string;
  authToken: string;
  fetch?: typeof fetch;
  now?: () => number;
  alive?: (pid: number) => boolean;
}): EngineFront {
  const now = input.now ?? (() => Date.now());
  const fetchBackground = input.fetch ?? createUnixSocketFetch(input.socketPath);
  let relay: OwnerBusyRelay | undefined;
  // The background instance that last answered a command: a snapshot another
  // instance wrote is not about the background running now.
  // A fresh snapshot written after that answer by another instance is from
  // its successor (the background restarted): it becomes the instance now.
  let answering: { instance: string; at: number } | undefined;
  const client = new EngineCommandClient({
    fetch: fetchBackground,
    authToken: input.authToken,
    onInstance: (instanceId) => { answering = { instance: instanceId, at: now() }; relay?.observeInstance(instanceId); },
  });
  relay = new OwnerBusyRelay(client, (line) => console.warn(line));
  const path = engineStatusSnapshotPath(input.env);
  let cached: EngineStatusSnapshot | undefined;
  let heldWriter: number | undefined;
  const alive = input.alive ?? processAlive;
  let lastReadAt = -Infinity;
  let pending: Promise<void> | undefined;
  let stopped = false;
  const judged = (snapshot: EngineStatusSnapshot, at: number): EngineStatusRead => {
    const read = engineStatusAge(snapshot, at);
    const written = engineStatusCollectedAt(snapshot);
    if (!read.stale && answering && answering.instance !== snapshot.instance_id && written > answering.at) {
      answering = { instance: snapshot.instance_id, at: written };
    }
    return { ...read, stale: read.stale || (answering !== undefined && answering.instance !== snapshot.instance_id) };
  };
  const refreshStatus = async () => {
    if (pending) return pending;
    const at = now();
    if (stopped || at - lastReadAt < 1_000) return;
    lastReadAt = at;
    pending = readEngineStatusSnapshotAsync(path).then(async (snapshot) => {
      let writer: number | undefined;
      if (snapshot?.held_items) {
        const boot = await readBootProgressAsync(input.env);
        const held = snapshot.held_items;
        if (boot && backgroundBootDone(boot, alive) && boot.instanceId === snapshot.instance_id
          && Number.isSafeInteger(held.count) && held.count >= 0 && Array.isArray(held.counted_scope)
          && typeof held.observed_at === 'string'
          && Date.parse(held.observed_at) >= Date.parse(boot.startedAt)) writer = boot.pid;
        else delete snapshot.held_items;
      }
      if (stopped) return;
      heldWriter = writer;
      cached = snapshot;
      if (snapshot && !judged(snapshot, now()).stale) relay?.observeInstance(snapshot.instance_id);
    }).finally(() => { pending = undefined; });
    return pending;
  };
  const cachedStatus = (): EngineStatusRead | undefined => {
    if (!cached) return undefined;
    const read = judged(cached, now());
    if (!cached.held_items || (!stopped && !read.stale && heldWriter !== undefined && alive(heldWriter))) return read;
    const { held_items: _held, ...snapshot } = cached;
    return { ...read, snapshot };
  };
  const heldItems = () => {
    const held = cachedStatus()?.snapshot.held_items;
    return held && { pendingCount: held.count, pendingCountObservedAt: held.observed_at };
  };
  const status = () => { void refreshStatus(); return cachedStatus(); };
  // Notice a background restart even when no page asks for status, so the
  // owner-busy signal reaches the new judge.
  const poll = setInterval(() => { void refreshStatus(); }, 2_000);
  poll.unref?.();
  const completeModel = (request: AnalystModelRequest) => completeModelInBackground(fetchBackground, input.authToken, request);
  // Busy is not unreachable: the background's receipt and heartbeat say it is up.
  const backgroundReady = async () => backgroundBootDone(await readBootProgressAsync(input.env));
  const waitForPendingPrivacyRaises = async () => {
    // The control thread can answer even when the background's loop is held.
    // This only bounds each readiness probe. The writer keeps applying its commands.
    const probeMs = 250;
    while (!await probeEngineBackground(fetchBackground, input.authToken, undefined, probeMs, true)) await Bun.sleep(probeMs);
  };
  return { client, ownerBusy: relay, status, cachedStatus, refreshStatus, heldItems, cachedSnapshot: () => cached, backgroundActivity: () => cached?.activity ?? 'idle', completeModel, backgroundReady,
    waitForPendingPrivacyRaises, stop: () => { stopped = true; clearInterval(poll); relay?.stop(); } };
}

// How long the front waits on a background that has stopped answering. A
// command the background still holds is never cut: each answer that says so
// starts the wait again (EngineCommandClient.send). These bound only a
// background that is gone or stalled; it can stall for over a minute under
// embedding and judging load (78 s in a release check), so none is shorter.
/** A forwarded sync answers when its pass ends, however long that is. */
export const SOURCE_SYNC_WAIT_MS = 35 * 60_000;
/** An export runs as long as a large install's copies take. */
export const DATA_EXPORT_WAIT_MS = 3 * 60 * 60_000;
/** An owner's action (Unpair's capture stop, Make Private) and a forwarded reload. */
export const OWNER_ACTION_WAIT_MS = 5 * 60_000;

function restartingResponse(request: Request): Response {
  // A browser gets the page that loads itself again until Olympus is back.
  if ((request.headers.get('accept') ?? '').includes('text/html')) {
    const answer = engineStartingAnswer({ step: 'restarting', acceptsHtml: true });
    return new Response(answer.body, { status: answer.status, headers: { 'content-type': answer.contentType, 'retry-after': '5' } });
  }
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
        if (!open) return restartingResponse(request);
        const started = generation;
        const context = { closedTheGate: false };
        const response = await current.run(context, () => handler(request, server));
        if (!context.closedTheGate && (started !== generation || !open)) {
          await response.body?.cancel().catch(() => undefined);
          return restartingResponse(request);
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
  pendingItemProtection?: PendingItemProtection;
  /** This front's process, which the background waits out before it deletes. */
  pid?: number;
  /**
   * After the background answered a forwarded action, before the front
   * answers: the front re-reads what the background just wrote (People's
   * corrections rebuild the index there; the front reloads its read-only copy).
   */
  afterAnswer?: (kind: EngineForwardedKind) => void;
}): (request: Request) => Promise<Response | undefined> | undefined {
  const pid = input.pid ?? process.pid;
  type Outcome = { answer: EngineForwardedResponse } | { unanswered: string } | { failed: string };
  const exchange = async (kind: EngineForwardedKind, forwarded: EngineForwardedRequest, onReceived?: (receipt: EngineCommandReceipt) => void, clickTrace?: ClickTrace): Promise<Outcome> => {
    let receipt;
    try {
      receipt = await input.client.send(
        { kind, request: forwarded, ...(kind === 'delete_source_data' ? { frontPid: pid } : {}) },
        // Extraction and embedding batches can run for minutes, as they did in the one process.
        { timeoutMs: input.timeoutMs ?? (kind === 'data_export' ? DATA_EXPORT_WAIT_MS : kind === 'source_sync' ? SOURCE_SYNC_WAIT_MS : kind === 'extraction_queue' || kind === 'embed_chunks' ? 15 * 60_000 : OWNER_ACTION_WAIT_MS), ...(onReceived ? { onReceived } : {}), ...(clickTrace ? { clickTrace } : {}) },
      );
    } catch (error) {
      return { unanswered: error instanceof Error ? error.message : 'The background engine is not answering.' };
    }
    if (receipt.state !== 'done') return { failed: receipt.error ?? 'The background could not run this.' };
    return { answer: receipt.result as EngineForwardedResponse };
  };
  const responseFor = (outcome: Outcome): Response => {
    if ('unanswered' in outcome) return Response.json({ error: { code: 'engine_background_unavailable', message: outcome.unanswered } }, { status: 503 });
    if ('failed' in outcome) return Response.json({ error: { code: 'engine_background_failed', message: outcome.failed } }, { status: 502 });
    return new Response(outcome.answer.body, { status: outcome.answer.status, headers: outcome.answer.headers });
  };
  const answer = (kind: EngineForwardedKind, outcome: Outcome): Response => {
    if ('answer' in outcome) {
      try { input.afterAnswer?.(kind); } catch { /* the front's own timer re-reads it */ }
    }
    return responseFor(outcome);
  };
  // The dashboard sees the same command status the client receives from the
  // socket. Keep active ids through a background restart and retain recent
  // results in memory so a browser poll can still see the outcome.
  const pendingPrivacyItems = new Set<string>();
  const settledPrivacyItems = new Map<string, Outcome>();
  const pending = (id: string, status: number) => Response.json(
    { ok: true, request_id: id, state: 'pending' }, { status, headers: { 'Cache-Control': 'no-store' } },
  );
  const changePrivacyItem = async (request: Request, protection: PendingItemProtection): Promise<Response> => {
    const forwarded = await requestToForwarded(request);
    const body = await new Response(forwarded.body).json().then(
      value => value as { item_id?: unknown; tier?: unknown } | null,
      () => null, // The background returns the route's validation error.
    );
    let identity: ReturnType<typeof parseOwnerTierItemId> | undefined;
    if (body?.tier === 'private' && typeof body.item_id === 'string' && body.item_id.trim()) {
      try {
        identity = parseOwnerTierItemId(body.item_id);
      } catch (error) {
        if (!(error instanceof OperationError)) throw error;
        return Response.json({ error: error.toJSON() }, { status: 400 });
      }
    }
    const received = Promise.withResolvers<Response>();
    let id: string | undefined;
    let release: (() => void) | undefined;
    const settling = exchange('tier_override', forwarded, (receipt) => {
      id = receipt.id;
      if (identity) release = protection.hold(identity);
      pendingPrivacyItems.add(id);
      received.resolve(pending(id, 202));
    }, clickTraces.get(request)).then(outcome => {
      release?.();
      if (id) {
        pendingPrivacyItems.delete(id);
        settledPrivacyItems.set(id, outcome);
        if (settledPrivacyItems.size > 1_000) settledPrivacyItems.delete(settledPrivacyItems.keys().next().value!);
      }
      return outcome;
    });
    return Promise.race([received.promise, settling.then(outcome => answer('tier_override', outcome))]);
  };
  const privacyItemStatus = async (request: Request): Promise<Response> => {
    const id = (await request.json().then(value => value as { request_id?: unknown } | null, () => null))?.request_id;
    if (typeof id === 'string') {
      if (pendingPrivacyItems.has(id)) return pending(id, 200);
      const outcome = settledPrivacyItems.get(id);
      if (outcome) return responseFor(outcome);
    }
    // A restart lost the receipt: the page reloads the item's true state and says so.
    return Response.json({ ok: false, unknown: true, message: 'Not saved. Olympus restarted before this change was saved. Press again.' }, { status: 404 });
  };
  return (request) => {
    if (request.method !== 'POST') return undefined;
    const path = new URL(request.url).pathname;
    if (input.pendingItemProtection && (path === PRIVACY_ITEM_SET_PATH || path === '/dashboard/privacy/items/status')
      && request.headers.get(DASHBOARD_CONTROL_GRADE_CONTEXT_HEADER) === 'local') {
      if (!input.gate.isOpen()) return Promise.resolve(restartingResponse(request));
      return path.endsWith('/status') ? privacyItemStatus(request) : changePrivacyItem(request, input.pendingItemProtection);
    }
    const kind = forwardedKindFor(path);
    if (!kind) return undefined;
    return (async (): Promise<Response | undefined> => {
      if (!input.gate.isOpen()) return restartingResponse(request);
      if (path === '/v1/cli/tier' && tierCommandOnlyReads(await request.clone().text())) return undefined;
      if (kind !== 'delete_source_data') return answer(kind, await exchange(kind, await requestToForwarded(request)));
      input.gate.close();
      let outcome: Awaited<ReturnType<typeof exchange>>;
      try {
        outcome = await exchange(kind, await requestToForwarded(request));
      } catch {
        outcome = { unanswered: 'The delete could not be sent.' };
      }
      if (!('answer' in outcome)) {
        // Unknown whether the background marked the account: reads stay
        // closed, and the front restarts, which closes every connection; the
        // new front waits for the background, which deletes at its boot if it
        // marked the account and otherwise changed nothing.
        input.restartFront();
        return restartingResponse(request);
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
 * The background's record of owner questions and calls on shared local models.
 * Busy and idle travel as separate commands that can be retried or delayed,
 * so each carries its front and a sequence number: a change older than the
 * last one applied for that resource is ignored. A new front (a restart)
 * supersedes the old one's marks. A busy mark lapses after `lapseMs`, so a
 * front that died mid-call cannot hold background work back for good.
 */
export class OwnerBusyMarks {
  private readonly marks = new Map<string, { front: string; seq: number; busyUntil: number; endedAt: number | undefined }>();
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
    this.marks.set(change.resource, { front: change.front, seq: change.seq, busyUntil: change.kind === 'owner_busy' ? this.now() + this.lapseMs : 0,
      endedAt: change.kind === 'owner_idle' ? this.now() : last?.endedAt });
    return true;
  }

  /** Receipt time of idle; a crashed front conservatively ends at lease expiry. */
  lastEndedAt(resource: string): number | undefined {
    const mark = this.marks.get(resource);
    if (mark && mark.busyUntil > 0 && mark.busyUntil <= this.now()) return Math.max(mark.endedAt ?? 0, mark.busyUntil);
    return mark?.endedAt;
  }

  busy(resource: string): boolean {
    return (this.marks.get(resource)?.busyUntil ?? 0) > this.now();
  }
}

/**
 * The background restarts after the front that asked for it has ended: a
 * delete, a model or judge change, a restore (#1224). It first stops answering
 * ready, so no new front can pass readiness against this background, open
 * stores or load settings before the restart; the answer to the command that
 * asked stays readable. Then it waits the front out (at most a minute) and
 * restarts. Returns whether the restart was scheduled.
 */
export function restartAfterFront(input: {
  frontPid: number;
  markStopping: () => void;
  restart: () => boolean;
  waitForExit?: (pid: number) => Promise<boolean>;
  log?: (line: string) => void;
}): boolean {
  input.markStopping();
  void (input.waitForExit ?? waitForProcessExit)(input.frontPid).then((ended) => {
    if (!ended) input.log?.('[engine-split] the front did not end within a minute; restarting anyway.');
    input.restart();
  });
  return true;
}

/**
 * One completion from the background's built-in model. Its typed refusals
 * (still downloading, failed to start) come back as the same OperationError
 * the model raises in one process; a background that does not answer is
 * unavailable. The caller's signal closes the request, which stops the call.
 */
export async function completeModelInBackground(
  fetchBackground: typeof fetch,
  authToken: string,
  request: AnalystModelRequest,
): Promise<AnalystModelCompletion> {
  const { signal, ...body } = request;
  let response: Response;
  try {
    response = await fetchBackground(`${ENGINE_BACKGROUND_ORIGIN}${ENGINE_MODEL_COMPLETE_PATH}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', Authorization: `Bearer ${authToken}` },
      body: JSON.stringify({ ...body, priority: currentLocalInferencePriority() }),
      ...(signal ? { signal } : {}),
    });
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new OperationError('argus_unreachable', 'The built-in private model is not answering: the background engine is not reachable.', 'Try again in a moment.');
  }
  const payload = await response.json().catch(() => undefined) as Record<string, unknown> | undefined;
  if (response.ok && payload && typeof payload.text === 'string' && typeof payload.modelId === 'string') return payload as unknown as AnalystModelCompletion;
  const typed = payload?.operation_error as { error?: unknown; message?: unknown; suggestion?: unknown } | undefined;
  if (typed && typeof typed.error === 'string' && typeof typed.message === 'string') {
    throw new OperationError(typed.error as OperationErrorCode, typed.message, typeof typed.suggestion === 'string' ? typed.suggestion : undefined);
  }
  throw new OperationError('argus_unreachable', `The built-in private model did not answer (HTTP ${response.status}).`, 'Try again in a moment.');
}
