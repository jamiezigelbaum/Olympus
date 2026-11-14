/**
 * The worker socket under the worker unit's engine split. The unit's own
 * process (worker-service-split.ts) holds the worker socket for as long as
 * the unit runs, and pipes each connection's bytes to the front, which listens
 * on front.sock beside it. A front restart (a model change, a delete, a crash)
 * therefore never takes the socket away: a connection that arrives while the
 * front is down waits for it, briefly, and then is told what Olympus is doing
 * ("starting: <step>"), as the front itself says while it starts.
 *
 * The standard answer is an inherited listening socket (systemd socket
 * activation, nginx reloads): the supervisor binds once and each front accepts
 * on the descriptor. Bun 1.4.4 cannot serve HTTP on one: Bun.serve ignores
 * `fd`, and a parent that keeps the descriptor accepts on it itself (checked
 * 14 Nov 2026). So this is a byte pipe, nothing more: it reads no request
 * beyond its Accept header, and only when it has to answer "starting" itself.
 */
import { rmSync } from 'node:fs';
import { engineHeartbeatBeating, engineHeartbeatLine, readEngineHeartbeat } from './engine-heartbeat.ts';
import type { LayoutEnv } from './olympus-layout.ts';
import { bindWorkerSocket, prepareWorkerSocket, releaseSystemdWorkerSocket, removeReleasedWorkerSocket, workerFrontSocketPath, workerSocketListenerStopped } from './worker-transport.ts';

/** How long a connection waits for a front that is restarting before it is told "starting": under the 3 s the health check gives an answer. */
export const FRONT_PROXY_WAIT_MS = 2_500;

/** What Olympus is doing, from the heartbeat: the step a starting engine reports. */
export function engineStartingStep(env: LayoutEnv): string {
  const heartbeat = readEngineHeartbeat(env);
  return heartbeat && engineHeartbeatBeating(heartbeat) ? engineHeartbeatLine(heartbeat) : 'starting';
}

const escapeHtml = (text: string) => text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/**
 * The answer while the front is not serving yet. A browser gets a page that
 * says so and loads itself again; everything else the JSON the front's
 * readiness callers read.
 */
export function engineStartingAnswer(input: { step: string; acceptsHtml: boolean }): { status: number; contentType: string; body: string } {
  if (input.acceptsHtml) {
    return {
      status: 503,
      contentType: 'text/html; charset=utf-8',
      body: `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="refresh" content="3"><title>Olympus is starting</title></head>`
        + `<body style="font-family:system-ui,sans-serif;margin:3rem"><p>Olympus is starting: ${escapeHtml(input.step)}.</p><p>This page loads again on its own.</p></body></html>`,
    };
  }
  return { status: 503, contentType: 'application/json', body: JSON.stringify({ reachable: false, status: 'starting', step: input.step }) };
}

export function engineStartingResponse(request: Request, env: LayoutEnv): Response {
  const answer = engineStartingAnswer({ step: engineStartingStep(env), acceptsHtml: (request.headers.get('accept') ?? '').includes('text/html') });
  return new Response(answer.body, { status: answer.status, headers: { 'content-type': answer.contentType, 'retry-after': '5' } });
}

function rawStartingAnswer(head: string, env: LayoutEnv): Uint8Array {
  const accept = /^accept:(.*)$/im.exec(head)?.[1] ?? '';
  const answer = engineStartingAnswer({ step: engineStartingStep(env), acceptsHtml: accept.includes('text/html') });
  const body = Buffer.from(answer.body);
  return Buffer.concat([Buffer.from(`HTTP/1.1 ${answer.status} Service Unavailable\r\ncontent-type: ${answer.contentType}\r\ncontent-length: ${body.length}\r\nretry-after: 5\r\nconnection: close\r\n\r\n`), body]);
}

type Socket = { write(data: Uint8Array): number; end(): void; flush?(): void; data: Side };
/** One end of a pipe: `queue` waits for this socket's drain; `pending` (the client end) for the front to answer. */
interface Side {
  peer?: Socket | undefined; queue: Uint8Array[]; pending: Uint8Array[]; ended: boolean; startedAt: number; timer?: ReturnType<typeof setTimeout>;
  /**
   * The client end: what went to the front before it answered anything, kept
   * so a read the front took and then dropped unanswered (it was exiting) is
   * sent to the next front. Undefined once the front answers, or for a
   * request that writes (`replay`).
   */
  unanswered: Uint8Array[];
  /** Whether `unanswered` may go to a second front: decided on the first bytes, off once the front answers. */
  replay: 'unknown' | 'yes' | 'no';
}

/** Only a request that reads may go to a second front: one that writes may have been done by the first. */
const READS = /^(GET|HEAD|OPTIONS) /;

/** Write what the socket takes now; keep the rest for its drain. */
function send(socket: Socket, chunk: Uint8Array): void {
  const side = socket.data;
  if (side.queue.length > 0) { side.queue.push(chunk); return; }
  const written = socket.write(chunk);
  if (written < chunk.length) side.queue.push(chunk.subarray(Math.max(written, 0)));
}

function drain(socket: Socket): void {
  const side = socket.data;
  while (side.queue.length > 0) {
    const chunk = side.queue[0]!;
    const written = socket.write(chunk);
    if (written < chunk.length) { side.queue[0] = chunk.subarray(Math.max(written, 0)); return; }
    side.queue.shift();
  }
  if (side.ended) socket.end();
}

/** A client's bytes on their way to the front, kept while the front has not answered a read. */
function toFront(client: Socket, front: Socket, chunk: Uint8Array): void {
  const side = client.data;
  if (side.replay === 'unknown') side.replay = READS.test(Buffer.from(chunk.subarray(0, 8)).toString('latin1')) ? 'yes' : 'no';
  if (side.replay === 'yes') side.unanswered.push(chunk);
  send(front, chunk);
}

function endWhenSent(socket: Socket | undefined): void {
  if (!socket) return;
  socket.data.ended = true;
  if (socket.data.queue.length === 0) socket.end();
}

/**
 * Listen on the worker socket and pipe to the front. Returns the stop, which
 * closes the listener (the socket file goes with it).
 */
export function startWorkerFrontProxy(input: {
  env: LayoutEnv;
  /** The front's socket; front.sock beside the worker socket. */
  frontSocket?: string;
  waitMs?: number;
  retryMs?: number;
  log?: (line: string) => void;
  /**
   * The engine host: a worker socket no listener answers on was left by a
   * host that died (its children are reaped before this runs), and is removed;
   * one a listener answers on is kept, and the bind below refuses it.
   */
  clearStale?: boolean;
}): { socketPath: string; stop(): void } {
  const env = input.env as NodeJS.ProcessEnv;
  const log = input.log ?? ((line: string) => console.warn(line));
  const frontSocket = input.frontSocket ?? workerFrontSocketPath({ env, platform: 'linux' })!;
  const waitMs = input.waitMs ?? FRONT_PROXY_WAIT_MS;
  const retryMs = input.retryMs ?? 100;
  if (releaseSystemdWorkerSocket({ env })) log('[olympus:worker] removed the socket left by the previous worker run');
  else if (input.clearStale && removeReleasedWorkerSocket({ env, platform: 'linux' }, { previousWorkerReleased: true })) log('removed the worker socket a previous engine left');
  const socketPath = prepareWorkerSocket({ env, platform: 'linux' })!;

  const connectFront = (client: Socket): void => {
    const side = client.data;
    void Bun.connect<Side>({
      unix: frontSocket,
      data: { queue: [], pending: [], ended: false, startedAt: side.startedAt, unanswered: [], replay: 'no' },
      socket: {
        open(front) {
          if (side.ended) { front.end(); return; }
          front.data.peer = client as Socket;
          side.peer = front as unknown as Socket;
          // What the client sent while the front was down goes first.
          for (const chunk of side.pending.splice(0)) toFront(client, front as unknown as Socket, chunk);
        },
        data(front, chunk) {
          side.replay = 'no';
          side.unanswered = [];
          if (front.data.peer) send(front.data.peer, chunk);
        },
        drain(front) { drain(front as unknown as Socket); },
        close() { frontGone(); },
        error() { frontGone(); },
      },
    }).catch(() => {
      if (side.ended) return;
      retry();
    });
    // The front took the request and went away without a word (it was exiting).
    function frontGone(): void {
      side.peer = undefined;
      const replay = side.replay === 'yes' ? side.unanswered.splice(0) : [];
      if (side.ended || replay.length === 0) { endWhenSent(client); return; }
      side.pending.unshift(...replay);
      side.startedAt = performance.now();
      side.timer = setTimeout(() => connectFront(client), retryMs);
    }
    function retry(): void {
      if (performance.now() - side.startedAt >= waitMs) {
        const head = Buffer.concat(side.pending).toString('latin1');
        side.pending.length = 0;
        side.ended = true;
        client.write(rawStartingAnswer(head, env));
        client.end();
        return;
      }
      side.timer = setTimeout(() => connectFront(client), retryMs);
    }
  };

  const server = bindWorkerSocket(socketPath, () => Bun.listen<Side>({
    unix: socketPath,
    data: undefined as unknown as Side,
    socket: {
      open(client) {
        client.data = { queue: [], pending: [], ended: false, startedAt: performance.now(), unanswered: [], replay: 'unknown' };
        connectFront(client as unknown as Socket);
      },
      data(client, chunk) {
        const front = client.data.peer;
        // Until the front answers, the bytes wait here (copied: Bun reuses the buffer).
        if (!front) client.data.pending.push(Uint8Array.from(chunk));
        else toFront(client as unknown as Socket, front, Uint8Array.from(chunk));
      },
      drain(client) { drain(client as unknown as Socket); },
      close(client) {
        client.data.ended = true;
        if (client.data.timer) clearTimeout(client.data.timer);
        endWhenSent(client.data.peer);
      },
      error(client) {
        client.data.ended = true;
        if (client.data.timer) clearTimeout(client.data.timer);
        endWhenSent(client.data.peer);
      },
    },
  }));
  return {
    socketPath,
    stop() {
      server.stop(true);
      rmSync(socketPath, { force: true });
    },
  };
}

/**
 * Before each front start: the previous front has exited (the supervision
 * kernel starts no child over a live one), so a front.sock with no listener
 * is the one it left. One a listener answers on is kept, for the front's own
 * bind to refuse.
 */
export function clearLeftFrontSocket(frontSocket: string): void {
  if (workerSocketListenerStopped(frontSocket) === true) rmSync(frontSocket, { force: true });
}
