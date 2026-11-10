/**
 * The engine split's shared names (docs/design/engine-split.md, part 3).
 *
 * With `worker.engineSplit` on, the host runs the worker twice: a background
 * process that is the only writer (scheduler, ingestion, extraction,
 * embedding, the privacy judge and tier moves, and the boot work that needs
 * the data root to itself) and a front process that serves HTTP and opens
 * stores and ledgers read-only. The host tells each child its role through
 * ENGINE_ROLE_ENV and where the background's private command socket is
 * through ENGINE_BACKGROUND_SOCKET_ENV. With the switch off neither is set
 * and the worker runs as one process, exactly as before.
 *
 * This module is loaded by the hosts (the OpenClaw Gateway runs it under
 * Node), so it holds names, the socket path and the readiness probe only.
 * The command protocol is in workers/engine-split/.
 */
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { sharedDataPath, type LayoutEnv } from './olympus-layout.ts';
import { workerSocketPath, type WorkerTransportOptions } from './worker-transport.ts';

export const ENGINE_ROLE_ENV = 'OLYMPUS_WORKER_ENGINE_ROLE';
export const ENGINE_BACKGROUND_SOCKET_ENV = 'OLYMPUS_ENGINE_BACKGROUND_SOCKET';

/** `single` is today's one process; the other two exist only with the switch on. */
export type EngineRole = 'single' | 'background' | 'front';

/** The role a host gave this worker; unset is `single`. Anything else refuses to start. */
export function engineRoleFromEnv(env: Record<string, string | undefined> = process.env): EngineRole {
  const value = env[ENGINE_ROLE_ENV]?.trim();
  if (!value) return 'single';
  if (value === 'background' || value === 'front') return value;
  throw new Error(`${ENGINE_ROLE_ENV} must be background or front.`);
}

/** The origin command URLs use. The request goes to the socket; the host name only names the route. */
export const ENGINE_BACKGROUND_ORIGIN = 'http://olympus-background';
export const ENGINE_READY_PATH = '/engine/ready';
export const ENGINE_COMMANDS_PATH = '/engine/commands';

/**
 * The background's command socket. On Linux it sits beside the worker socket
 * in the owner's 0700 runtime folder; elsewhere in a 0700 folder of its own
 * under the data root. The folder is created here; the socket is bound by
 * the background with bindWorkerSocket (0600 under a private umask).
 */
export function engineBackgroundSocketPath(options: WorkerTransportOptions = {}): string {
  const workerSocket = workerSocketPath(options);
  const path = workerSocket
    ? join(dirname(workerSocket), 'background.sock')
    : join(sharedDataPath('engine-run', (options.env ?? process.env) as LayoutEnv), 'background.sock');
  // macOS allows 104 bytes and Linux 108, both counting the terminator.
  if (Buffer.byteLength(path) > 103) throw new Error('Engine background socket path is too long for a unix socket.');
  return path;
}

/** Create the socket's folder owner-only. An existing folder is kept as it is. */
export function prepareEngineBackgroundSocketDirectory(socketPath: string): void {
  mkdirSync(dirname(socketPath), { recursive: true, mode: 0o700 });
}

export interface EngineReadyBody {
  ready: boolean;
  instance_id: string;
  /** Set once the background's boot work (lock, deletions, storage migration) is done. */
  schema_current: boolean;
}

/**
 * Whether the background with this instance id is up and has finished its
 * boot work. Any failure, timeout or other instance is `false`.
 */
export async function probeEngineBackground(
  fetchBackground: typeof fetch,
  authToken: string,
  instanceId: string | undefined,
  timeoutMs: number,
): Promise<boolean> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  timeout.unref?.();
  try {
    const response = await fetchBackground(ENGINE_BACKGROUND_ORIGIN + ENGINE_READY_PATH, {
      method: 'GET',
      headers: { Authorization: `Bearer ${authToken}` },
      signal: controller.signal,
    });
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      return false;
    }
    const body = await response.json().catch(() => undefined) as Partial<EngineReadyBody> | undefined;
    return body?.ready === true && body.schema_current === true
      && (instanceId === undefined || body.instance_id === instanceId);
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
  }
}
