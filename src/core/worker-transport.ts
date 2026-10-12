/** Linux's owner-only worker transport. HTTP origins remain stable for browser
 * cookies/CSRF; they are not listening TCP endpoints on the engine host. */
import { lstatSync, mkdirSync, realpathSync, chmodSync } from 'node:fs';
import { dirname, isAbsolute, join, normalize, parse } from 'node:path';

export interface WorkerTransportOptions {
  platform?: string;
  env?: Record<string, string | undefined>;
  uid?: number;
}

function ownerId(options: WorkerTransportOptions): number {
  const uid = options.uid ?? process.getuid?.();
  if (uid === undefined) throw new Error('Worker socket requires a Unix owner.');
  return uid;
}

/** No aliases, symlinks, foreign owners or replaceable ancestors. Root-owned
 * sticky ancestors (e.g. /tmp in isolated tests) cannot replace our directory. */
function validateDirectory(path: string, uid: number, privateMode: boolean): void {
  if (!isAbsolute(path) || normalize(path) !== path || /[\x00-\x1f\x7f]/.test(path)) throw new Error('Unsafe worker socket directory.');
  let current = parse(path).root;
  for (const part of path.slice(current.length).split('/').filter(Boolean)) {
    current = join(current, part);
    const stat = lstatSync(current);
    if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.uid !== uid && stat.uid !== 0)) throw new Error('Unsafe worker socket ancestor.');
    if ((stat.mode & 0o022) && !(stat.uid === 0 && (stat.mode & 0o1000))) throw new Error('Writable worker socket ancestor.');
  }
  const stat = lstatSync(path);
  if (privateMode && (stat.uid !== uid || (stat.mode & 0o777) !== 0o700)) throw new Error('Worker runtime directory must be owner-owned and 0700.');
  if (realpathSync(path) !== path) throw new Error('Worker socket directory must not contain symlinks.');
}

export function workerSocketPath(options: WorkerTransportOptions = {}): string | undefined {
  if ((options.platform ?? process.platform) !== 'linux') return undefined;
  const runtime = (options.env ?? process.env).XDG_RUNTIME_DIR;
  if (!runtime) throw new Error('Linux requires an owner-owned 0700 XDG_RUNTIME_DIR from the user session.');
  validateDirectory(runtime, ownerId(options), true);
  if (!/^\/[A-Za-z0-9_./-]+$/.test(runtime)) throw new Error('XDG_RUNTIME_DIR must be a shell-safe absolute path for SSH socket forwarding.');
  const path = join(runtime, 'olympus', 'worker.sock');
  if (Buffer.byteLength(path) > 107) throw new Error('Worker Unix socket path exceeds the Linux limit.');
  return path;
}

export function validateWorkerSocket(options: WorkerTransportOptions = {}): string | undefined {
  const path = workerSocketPath(options);
  if (!path) return undefined;
  const uid = ownerId(options);
  validateDirectory(dirname(path), uid, true);
  const stat = lstatSync(path);
  if (!stat.isSocket() || stat.uid !== uid || (stat.mode & 0o777) !== 0o600) throw new Error('Worker socket must be owner-owned and 0600.');
  return path;
}

/** Before bind: never delete, chmod or adopt an occupied path, even a stale socket. */
export function prepareWorkerSocket(options: WorkerTransportOptions = {}): string | undefined {
  const path = workerSocketPath(options);
  if (!path) return undefined;
  try { mkdirSync(dirname(path), { mode: 0o700 }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
  validateDirectory(dirname(path), ownerId(options), true);
  try { lstatSync(path); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return path; throw error; }
  throw new Error('Worker socket path is occupied; stop its owner and resolve the path before starting Olympus.');
}

/** Bind synchronously under a private umask, before any request can run. */
export function bindWorkerSocket<T>(path: string, bind: () => T): T {
  const previous = process.umask(0o177);
  try {
    const server = bind();
    chmodSync(path, 0o600);
    return server;
  } finally { process.umask(previous); }
}

export function createWorkerFetch(options: WorkerTransportOptions = {}, fetchImpl: typeof fetch = globalThis.fetch): typeof fetch {
  if ((options.platform ?? process.platform) !== 'linux') return fetchImpl;
  return ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || url.username || url.password) {
      throw new Error('Linux worker requests require a loopback HTTP origin over the owner socket.');
    }
    const unix = validateWorkerSocket(options)!;
    // Bun's native Unix transport is also used by the standalone CLI and relay.
    // A non-Bun host must refuse, never silently fall back to loopback TCP.
    if (typeof Bun === 'undefined') throw new Error('Linux worker socket requests require the Bun runtime.');
    return fetchImpl(input, { ...init, unix, redirect: init?.redirect === 'manual' ? 'manual' : 'error' } as RequestInit);
  }) as typeof fetch;
}

export const workerFetch: typeof fetch = ((input: RequestInfo | URL, init?: RequestInit) =>
  createWorkerFetch()(input, init)) as typeof fetch;
