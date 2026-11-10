/**
 * The engine split's wiring for the worker's `main()` (server.ts): the
 * background's command socket and status publisher, and the front's command
 * client, owner-busy relay and snapshot reader. Kept here so `main()` only
 * chooses by role (core/engine-split.ts).
 */
import { randomUUID } from 'node:crypto';
import { lstatSync } from 'node:fs';
import { ENGINE_BACKGROUND_SOCKET_ENV, prepareEngineBackgroundSocketDirectory, probeEngineBackground } from '../../core/engine-split.ts';
import { sharedDataPath } from '../../core/olympus-layout.ts';
import { removeFileDurablySync } from '../../core/atomic-file.ts';
import { bindWorkerSocket, createUnixSocketFetch, workerSocketListenerStopped, workerSocketServe } from '../../core/worker-transport.ts';
import { EngineCommandClient, OwnerBusyRelay } from './client.ts';
import { createEngineCommandHandler, EngineCommandLedger, type EngineCommandHandlers } from './commands.ts';
import { readEngineStatusSnapshot, startEngineStatusPublisher, type EngineStatusRead, type EngineStatusSnapshot } from './snapshot.ts';

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
}): { instanceId: string; markReady(): void; stop(): void; ledger: EngineCommandLedger } {
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
    stop: () => { void server.stop(true); },
  };
}

export function startEngineBackgroundStatus(input: {
  env: Record<string, string | undefined>;
  instanceId: string;
  collect: () => Omit<EngineStatusSnapshot, 'schema' | 'instance_id' | 'written_at'>;
}): { stop(): void } {
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
  const client = new EngineCommandClient({
    fetch: input.fetch ?? createUnixSocketFetch(input.socketPath),
    authToken: input.authToken,
    onInstance: (instanceId) => relay?.observeInstance(instanceId),
  });
  relay = new OwnerBusyRelay(client, (line) => console.warn(line));
  const path = engineStatusSnapshotPath(input.env);
  let cached: { at: number; read: EngineStatusRead | undefined } | undefined;
  const status = (): EngineStatusRead | undefined => {
    const at = now();
    if (cached && at - cached.at < 1_000) {
      return cached.read ? { ...cached.read, age_ms: cached.read.age_ms + (at - cached.at) } : undefined;
    }
    const read = readEngineStatusSnapshot(path, now);
    cached = { at, read };
    if (read) relay?.observeInstance(read.snapshot.instance_id);
    return read;
  };
  // Notice a background restart even when no page asks for status, so the
  // owner-busy signal reaches the new judge.
  const poll = setInterval(() => { status(); }, 2_000);
  poll.unref?.();
  return { client, ownerBusy: relay, status, stop: () => clearInterval(poll) };
}

/**
 * Owner actions that write background-owned data and have no command yet
 * (the next slice: delete_source_data, tier_override, capture_*,
 * storage_registry_*, and the embedding endpoint). With the split on, the
 * front refuses them plainly instead of writing from the front.
 */
const FRONT_REFUSED_POSTS = new Set([
  '/dashboard/delete-source-data',
  '/cli/data-delete',
  '/cli/tier',
  '/cli/pairing-placement',
  '/cli/pairing-account',
  '/source/index/embed',
  '/dashboard/messaging/start',
  '/dashboard/messaging/respond',
  '/dashboard/messaging/cancel',
  '/dashboard/messaging/scope',
  // Source watches are the background's (it runs their passes); creating or
  // cancelling one has no command yet.
  '/source/watch/create',
  '/source/watch/cancel',
]);

/** Extraction queue writes, under the generic path or a family's alias. The background owns the queue. */
const FRONT_REFUSED_EXTRACTION = /^\/source\/index\/(?:files\/(?:plan|transcribe|recycle-leases|janitor-requeue|extract-pdfs|extract)|dropbox\/(?:content\/(?:plan|recycle-leases|janitor-requeue|extract)|transcribe))$/;

export const ENGINE_FRONT_REFUSAL_CODE = 'not_available_in_split_mode';

export function engineFrontRefusal(request: Request): Response | undefined {
  if (request.method !== 'POST') return undefined;
  const path = new URL(request.url).pathname.replace(/^\/v1(?=\/)/, '').replace(/\/$/, '');
  if (!FRONT_REFUSED_POSTS.has(path) && !FRONT_REFUSED_EXTRACTION.test(path)) return undefined;
  return Response.json({
    error: ENGINE_FRONT_REFUSAL_CODE,
    message: 'This action is not available while Olympus runs its engine split (worker.engineSplit) yet. Turn the switch off to use it.',
  }, { status: 503 });
}
