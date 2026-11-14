/** Linux's owner-only worker transport. HTTP origins remain stable for browser
 * cookies/CSRF; they are not listening TCP endpoints on the engine host. */
import { lstatSync, mkdirSync, realpathSync, chmodSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { request as httpRequest } from 'node:http';
import { Readable } from 'node:stream';
import { dirname, isAbsolute, join, normalize, parse } from 'node:path';
import { resolveLinuxEngineLayout } from './linux-engine-layout.ts';
import { removeFileDurablySync } from './atomic-file.ts';

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
  const layout = resolveLinuxEngineLayout(options.env ?? process.env);
  const runtime = layout.runtimeHome;
  if (!runtime) throw new Error('Linux requires an owner-owned 0700 XDG_RUNTIME_DIR from the user session.');
  validateDirectory(runtime, ownerId(options), true);
  if (!/^\/[A-Za-z0-9_./-]+$/.test(runtime)) throw new Error('XDG_RUNTIME_DIR must be a shell-safe absolute path for SSH socket forwarding.');
  const path = layout.workerSocketPath;
  if (Buffer.byteLength(path) > 107) throw new Error('Worker Unix socket path exceeds the Linux limit.');
  return path;
}

/** Owner state can be revoked before bind or after the socket is released. */
export function validateWorkerSocketDirectory(options: WorkerTransportOptions = {}): string | undefined {
  const path = workerSocketPath(options);
  if (!path) return undefined;
  validateDirectory(dirname(path), ownerId(options), true);
  return path;
}

export function validateWorkerSocket(options: WorkerTransportOptions = {}): string | undefined {
  const path = validateWorkerSocketDirectory(options);
  if (!path) return undefined;
  const uid = ownerId(options);
  const stat = lstatSync(path);
  if (!stat.isSocket() || stat.uid !== uid || (stat.mode & 0o777) !== 0o600) throw new Error('Worker socket must be owner-owned and 0600.');
  return path;
}

/** Before bind: never delete, chmod or adopt an occupied path, even a stale socket. */
/**
 * Where a front under the worker unit's split listens instead of the worker
 * socket: the unit's own process owns the worker socket and forwards to this
 * one, so the worker socket stays up while the front restarts
 * (worker-front-proxy.ts). Always `front.sock` beside the worker socket.
 */
export const WORKER_LISTEN_SOCKET_ENV = 'OLYMPUS_WORKER_LISTEN_SOCKET';

/**
 * Off Linux the worker listens on loopback TCP: under the engine split the
 * engine host holds the worker's port and the front binds this one instead
 * (worker-front-proxy.ts). Only the bind changes; every URL the front builds
 * keeps the worker's own port.
 */
export const WORKER_LISTEN_PORT_ENV = 'OLYMPUS_WORKER_LISTEN_PORT';

/** A fetch that sends loopback worker requests to the front's own port. */
export function createLoopbackPortFetch(port: number, fetchImpl: typeof fetch = globalThis.fetch): typeof fetch {
  return ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) throw new Error('Front requests require a loopback HTTP origin.');
    url.port = String(port);
    return fetchImpl(input instanceof Request ? new Request(url, input) : url, init);
  }) as typeof fetch;
}

export function workerFrontSocketPath(options: WorkerTransportOptions = {}): string | undefined {
  const path = workerSocketPath(options);
  return path ? join(dirname(path), 'front.sock') : undefined;
}

/** The socket this process binds: the worker socket, or the front's own under the unit's split. */
export function workerListenSocketPath(options: WorkerTransportOptions = {}): string | undefined {
  const requested = (options.env ?? process.env)[WORKER_LISTEN_SOCKET_ENV]?.trim();
  if (!requested) return workerSocketPath(options);
  const front = workerFrontSocketPath(options);
  if (requested !== front) throw new Error(`${WORKER_LISTEN_SOCKET_ENV} must name front.sock beside the worker socket.`);
  return front;
}

export function prepareWorkerSocket(options: WorkerTransportOptions = {}): string | undefined {
  const path = workerListenSocketPath(options);
  if (!path) return undefined;
  try { mkdirSync(dirname(path), { mode: 0o700 }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
  validateDirectory(dirname(path), ownerId(options), true);
  try { lstatSync(path); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return path; throw error; }
  throw new Error('Worker socket path is occupied; stop its owner and resolve the path before starting Olympus.');
}

/** Probe only: true means ENOENT/ECONNREFUSED, false means a listener, undefined means custody is unknown. */
export function workerSocketListenerStopped(path: string): boolean | undefined {
 const result=spawnSync(process.execPath,['-e',`const s=Bun.connect({unix:process.argv[1],socket:{data(){},open(s){s.end();process.exit(1)},error(){process.exit(2)}}});s.catch(e=>process.exit(['ENOENT','ECONNREFUSED'].includes(e.code)?0:2));setTimeout(()=>process.exit(2),1500);`,path],{timeout:2000});
 return result.status===0?true:result.status===1?false:undefined;
}

/**
 * A supervisor may remove a retained inode only after its own process/group
 * custody proved the previous worker released. This function adds independent
 * listener and inode provenance checks; callers cannot request generic stale
 * unlinking.
 */
export function removeReleasedWorkerSocket(
 options: WorkerTransportOptions,
 custody: { previousWorkerReleased: boolean },
): boolean {
 const path=workerSocketPath(options);
 if(!path)return false;
 try{lstatSync(path);}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return false;throw error;}
 if(!custody.previousWorkerReleased)throw new Error('Previous worker process custody is not released; the socket was retained.');
 validateWorkerSocket(options);
 if(workerSocketListenerStopped(path)!==true)throw new Error('Worker socket listener custody is live or unknown; the socket was retained.');
 removeFileDurablySync(path);
 return true;
}

/**
 * The worker's own start under its systemd unit (OLYMPUS_MANAGED_WORKER=1 and
 * systemd's INVOCATION_ID): systemd runs ExecStart only once every process of
 * the unit's previous run has exited, so a socket still on the path was left
 * by a worker it already stopped (Sparta, 2026-11-04: a hung worker took the
 * stop timeout and SIGKILL, and the next start failed until someone removed
 * the file by hand). That is the supervisor custody removeReleasedWorkerSocket
 * asks for; it still refuses a socket a listener answers on, or one that is not
 * owner-owned 0600. Anywhere else this does nothing. Returns true when a
 * socket was removed; a refusal is left for prepareWorkerSocket to report.
 */
export function releaseSystemdWorkerSocket(options: WorkerTransportOptions = {}): boolean {
 const env=options.env??process.env;
 if((options.platform??process.platform)!=='linux'||env.OLYMPUS_MANAGED_WORKER!=='1'||!env.INVOCATION_ID)return false;
 // A front under the unit's split: the unit's process owns the worker socket,
 // and clears the front's own before each start (worker-service-split.ts).
 if(env[WORKER_LISTEN_SOCKET_ENV]?.trim())return false;
 try{return removeReleasedWorkerSocket(options,{previousWorkerReleased:true});}catch{return false;}
}

/**
 * Options every Bun server on a worker's unix socket takes. Bun closes a request
 * its handler has not answered within 10 s, and on a unix socket
 * `server.timeout(request, 0)` does not lift that (Bun 1.3.14), so a slow owner
 * read (a status build while imports run) came back empty (Sparta, 2026-11-04).
 * The socket is the owner's alone; each client bounds its own wait.
 */
export const WORKER_SOCKET_SERVE_OPTIONS: { idleTimeout: number } = { idleTimeout: 0 };

/** A unix-socket server's options with WORKER_SOCKET_SERVE_OPTIONS (Bun's types list idleTimeout for TCP only; Bun applies it to both). */
export function workerSocketServe<T extends object>(options: T): T {
  return Object.assign(options, WORKER_SOCKET_SERVE_OPTIONS);
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
    if (typeof Bun === 'undefined') return nodeWorkerFetch(unix, input, init, options);
    return fetchImpl(input, { ...init, unix, redirect: init?.redirect === 'manual' ? 'manual' : 'error' } as RequestInit);
  }) as typeof fetch;
}

/**
 * A fetch that always connects to one unix socket, under Bun or Node, for a
 * private socket that is not the worker's own (the engine split's background
 * command socket, core/engine-split.ts). The URL's origin only names the
 * route; `validate` runs before each dispatch.
 */
export function createUnixSocketFetch(socketPath: string, validate: () => void = () => {}): typeof fetch {
  return ((input: RequestInfo | URL, init?: RequestInit) => {
    validate();
    if (typeof Bun === 'undefined') return nodeWorkerFetch(socketPath, input, init, validate);
    return globalThis.fetch(input, { ...init, unix: socketPath, redirect: 'error' } as RequestInit);
  }) as typeof fetch;
}

/** The Gateway loads plugins under Node. Keep its HTTP origin, body and abort
 * semantics while connecting exclusively to the same validated owner socket. */
async function nodeWorkerFetch(unix: string, input: RequestInfo | URL, init: RequestInit | undefined, options: WorkerTransportOptions | (() => void)): Promise<Response> {
  const request = new Request(input, init);
  const body = request.body ? Buffer.from(await request.arrayBuffer()) : undefined;
  const url = new URL(request.url);
  // Recheck after an asynchronous body read, immediately before dispatch.
  if (typeof options === 'function') options();
  else validateWorkerSocket(options);
  return new Promise((resolve, reject) => {
    const outgoing = httpRequest(url, {
      socketPath: unix,
      method: request.method,
      headers: Object.fromEntries(request.headers),
      signal: request.signal,
      agent: false,
    }, incoming => {
      const status = incoming.statusCode ?? 500;
      if (status >= 300 && status < 400 && init?.redirect !== 'manual') {
        incoming.destroy();
        reject(new TypeError('Worker request redirect refused.'));
        return;
      }
      const headers = new Headers();
      for (let i = 0; i < incoming.rawHeaders.length; i += 2) headers.append(incoming.rawHeaders[i]!, incoming.rawHeaders[i + 1]!);
      const noBody = request.method === 'HEAD' || [204, 205, 304].includes(status);
      const response = new Response(noBody ? null : Readable.toWeb(incoming) as unknown as ReadableStream<Uint8Array>, {
        status, statusText: incoming.statusMessage ?? '', headers,
      });
      if (noBody) incoming.resume();
      Object.defineProperty(response, 'url', { value: request.url });
      resolve(response);
    });
    outgoing.on('error', reject);
    outgoing.end(body);
  });
}

export const workerFetch: typeof fetch = ((input: RequestInfo | URL, init?: RequestInit) =>
  createWorkerFetch()(input, init)) as typeof fetch;
