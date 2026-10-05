/**
 * A handshake's authentication result that arrives after the handshake was
 * given up on must never be sent -- in particular not over the NEXT session's
 * socket, which is open and current by then.
 *
 * The client builds its answer with `installAuthMessage`; here that is
 * replaced by one whose result the script releases by hand, so the late
 * result is ordered deterministically instead of by a proof-of-work race.
 * Run as a child process by relay-compat-and-budgets.test.ts: `mock.module`
 * is process-wide in Bun and would leak into the other relay test files.
 *
 * Prints `{ first, second }`: the text frames each relay session received.
 */
import { mock } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const real = await import('../../shared/protocol.ts');
const pending: Array<{ nonce: string; release: (message: unknown) => void }> = [];
mock.module('../../shared/protocol.ts', () => ({
  ...real,
  installAuthMessage: (input: { nonce: string }) => new Promise((release) => pending.push({ nonce: input.nonce, release })),
}));
const { RelayClient } = await import('../../client/relay-client.ts');
const { loadOrCreateIdentity } = await import('../../client/identity.ts');

async function until(condition: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('condition not met in time');
    await Bun.sleep(5);
  }
}

type Session = { ws: import('bun').ServerWebSocket<{ index: number }>; frames: string[] };
const sessions: Session[] = [];
const server = Bun.serve<{ index: number }, never>({
  hostname: '127.0.0.1',
  port: 0,
  fetch: (request, srv) => (srv.upgrade(request, { data: { index: sessions.length } }) ? undefined : new Response('no', { status: 400 })),
  websocket: {
    open(ws) {
      sessions[ws.data.index] = { ws, frames: [] };
      ws.send(JSON.stringify({ type: 'challenge', v: real.PROTOCOL_VERSION, nonce: `session-${ws.data.index}`, pow: 0, auth: real.AUTH_BOUND }));
    },
    message(ws, data) {
      sessions[ws.data.index]!.frames.push(String(data));
    },
  },
});

const stateDir = mkdtempSync(join(tmpdir(), 'olympus-relay-late-auth-'));
const client = new RelayClient({
  relayHost: 'mcp.olympus.test',
  relayUrl: `ws://127.0.0.1:${server.port}/v2/connect`,
  identity: loadOrCreateIdentity(stateDir),
  target: 'http://127.0.0.1:9',
  relaySecret: real.base64url(crypto.getRandomValues(new Uint8Array(32))),
  handshakeTimeoutMs: 60_000,
  backoff: { minMs: 0, maxMs: 0 },
});
(client as unknown as { register: boolean }).register = true;
try {
  client.start();
  // Session 0's answer is being built; the relay then drops session 0, and
  // the client reconnects at once (first contact registers right away).
  await until(() => pending.length === 1);
  sessions[0]!.ws.close(1011, 'going away');
  await until(() => pending.length === 2 && pending[1]!.nonce === 'session-1');
  // Session 0's result lands only now, while session 1 is open and current;
  // then session 1's own. Released in that order, so a late send would be
  // session 1's first frame.
  pending[0]!.release({ type: 'register', marker: 'late-session-0' });
  pending[1]!.release({ type: 'register', marker: 'session-1' });
  await until(() => (sessions[1]?.frames.length ?? 0) >= 1);
  await Bun.sleep(20);
  process.stdout.write(JSON.stringify({ first: sessions[0]!.frames, second: sessions[1]!.frames }));
} finally {
  await client.stop();
  server.stop(true);
  rmSync(stateDir, { recursive: true, force: true });
}
