/**
 * Operator commands for a running relay, over a local Unix socket.
 *
 *   bun server/admin.ts status
 *   bun server/admin.ts revoke <install-id>
 *   bun server/admin.ts restore <install-id>
 *
 * Run it on the relay host as the service user (or root), for example
 * `sudo -u olympus-relay /usr/local/bin/bun server/admin.ts status`. The socket
 * lives in the relay's 0700 state directory and is itself 0600, so only that
 * user and root can reach it; nothing here listens on the network, and the
 * relay's public listener has no HTTP surface at all.
 *
 * `status` prints counts only and names no install. `revoke` removes the
 * install, ends its session, removes its DNS address record within the relay's
 * DNS budget, and refuses the id from then on (an install otherwise
 * re-registers by itself). No restart. If the relay is not running, `revoke`
 * records the revocation in the registry log instead and the relay applies it
 * on its next start; `status` then reads the log.
 *
 * Paths: RELAY_ADMIN_SOCKET (default `<registry dir>/admin.sock`) and
 * RELAY_REGISTRY_PATH (default `/var/lib/olympus-connect-relay/registry.jsonl`).
 */
import { chmodSync, existsSync, lstatSync, unlinkSync } from 'node:fs';
import net from 'node:net';
import { dirname, join } from 'node:path';
import { INSTALL_ID_PATTERN, readLines, encodeLine } from '../shared/protocol.ts';
import { appendOfflineRevocation, readRegistrySnapshot } from './registry.ts';
import type { RelayHandle, RelayStatus, RevokeResult } from './relay.ts';

export const DEFAULT_REGISTRY_PATH = '/var/lib/olympus-connect-relay/registry.jsonl';

export type AdminRequest =
  | { op: 'status' }
  | { op: 'revoke'; installId: string }
  | { op: 'restore'; installId: string };

export type AdminResponse =
  | { ok: true; op: 'status'; status: RelayStatus }
  | { ok: true; op: 'revoke'; result: RevokeResult }
  | { ok: true; op: 'restore'; restored: boolean }
  | { ok: false; error: string };

export function adminSocketPath(env: NodeJS.ProcessEnv = process.env): string {
  return env.RELAY_ADMIN_SOCKET ?? join(dirname(env.RELAY_REGISTRY_PATH ?? DEFAULT_REGISTRY_PATH), 'admin.sock');
}

/** Serves operator requests for `relay` on a Unix socket at `path` (mode 0600). */
export async function startAdminSocket(path: string, relay: Pick<RelayHandle, 'status' | 'revoke' | 'restore'>): Promise<{ close(): Promise<void> }> {
  // A socket left by a crashed relay would make listen fail; never remove anything else.
  if (existsSync(path)) {
    if (!lstatSync(path).isSocket()) throw new Error(`${path} exists and is not a socket`);
    unlinkSync(path);
  }
  const sockets = new Set<net.Socket>();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
    socket.on('error', () => socket.destroy());
    socket.setTimeout(10_000, () => socket.destroy());
    readLines(
      socket,
      (message) => {
        void handle(message).then((response) => socket.end(encodeLine(response)));
        return 'stop';
      },
      () => socket.end(encodeLine({ ok: false, error: 'malformed request' } satisfies AdminResponse)),
    );
  });
  const handle = async (message: Record<string, unknown>): Promise<AdminResponse> => {
    try {
      if (message.op === 'status') return { ok: true, op: 'status', status: relay.status() };
      const installId = typeof message.installId === 'string' ? message.installId : '';
      if (!INSTALL_ID_PATTERN.test(installId)) return { ok: false, error: 'installId must be a 32-character install id' };
      if (message.op === 'revoke') return { ok: true, op: 'revoke', result: await relay.revoke(installId) };
      if (message.op === 'restore') return { ok: true, op: 'restore', restored: relay.restore(installId) };
      return { ok: false, error: 'op must be status, revoke or restore' };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  };
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(path, () => resolve());
  });
  chmodSync(path, 0o600);
  return {
    close: () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
      }),
  };
}

/** Sends one request to a running relay. Rejects with `code` ENOENT/ECONNREFUSED when none is listening. */
export function adminRequest(path: string, request: AdminRequest, timeoutMs = 15_000): Promise<AdminResponse> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(path);
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error('the relay did not answer in time'));
    }, timeoutMs);
    socket.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    socket.once('connect', () => socket.write(encodeLine(request)));
    readLines(
      socket,
      (message) => {
        clearTimeout(timer);
        resolve(message as unknown as AdminResponse);
        socket.end();
        return 'stop';
      },
      (why) => {
        clearTimeout(timer);
        reject(new Error(why));
      },
    );
  });
}

export function formatStatus(status: RelayStatus, running = true): string {
  const lines = [
    running ? `Relay running since ${status.startedAt}` : 'Relay not running (counts read from the registry log)',
    `Registered installs:        ${status.registered} (${status.activated} have requested a certificate)`,
  ];
  if (running) {
    lines.push(
      `Online now:                 ${status.online}`,
      `Public connections:         ${status.publicConnections} open, ${status.pendingPublicConnections} waiting for an install`,
    );
  }
  lines.push(
    `Address records:            ${status.addressRecords} (${status.pendingAddressRemovals} queued for removal)`,
    `Revoked installs:           ${status.revoked}`,
  );
  return `${lines.join('\n')}\n`;
}

export function formatRevoke(result: RevokeResult): string {
  if (!result.revoked) return `${result.installId} was already revoked.\n`;
  const parts = [
    `Revoked ${result.installId}.`,
    result.wasRegistered ? 'Its registration was removed.' : 'It was not registered; it cannot register now.',
    result.wasOnline ? 'Its session was ended.' : 'It was offline.',
    {
      removed: 'Its DNS address record was removed.',
      pending: 'Its DNS address record is queued; the hourly sweep removes it within the DNS budget.',
      none: 'It had no DNS address record.',
    }[result.addressRecord],
  ];
  return `${parts.join(' ')}\n`;
}

const USAGE = 'Usage: bun server/admin.ts status | revoke <install-id> | restore <install-id>\n';

export async function runAdmin(argv: readonly string[], env: NodeJS.ProcessEnv = process.env): Promise<{ code: number; out: string }> {
  const [op, installId, ...extra] = argv;
  if (extra.length > 0 || !(op === 'status' ? installId === undefined : (op === 'revoke' || op === 'restore') && installId !== undefined)) {
    return { code: 2, out: USAGE };
  }
  if (installId !== undefined && !INSTALL_ID_PATTERN.test(installId)) {
    return { code: 2, out: 'An install id is 32 characters of a-z and 2-7 (the first label of its hostname).\n' };
  }
  const socketPath = adminSocketPath(env);
  const registryPath = env.RELAY_REGISTRY_PATH ?? DEFAULT_REGISTRY_PATH;
  const request: AdminRequest = op === 'status' ? { op } : { op: op as 'revoke' | 'restore', installId: installId! };
  let response: AdminResponse;
  try {
    response = await adminRequest(socketPath, request);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT' && code !== 'ECONNREFUSED') {
      return { code: 1, out: `Could not reach the relay at ${socketPath}: ${(error as Error).message}\n` };
    }
    // Nothing is listening: the relay is stopped, so the log has no other writer.
    if (request.op === 'status') {
      const counts = readRegistrySnapshot(registryPath).counts();
      return { code: 0, out: formatStatus({ ...counts, online: 0, publicConnections: 0, pendingPublicConnections: 0, startedAt: '' }, false) };
    }
    if (request.op === 'revoke') {
      if (readRegistrySnapshot(registryPath).isRevoked(request.installId)) return { code: 0, out: `${request.installId} was already revoked.\n` };
      appendOfflineRevocation(registryPath, request.installId);
      return {
        code: 0,
        out: `The relay is not running. Recorded the revocation of ${request.installId} in ${registryPath}; `
          + 'it applies when the relay starts, and the first hourly sweep removes the DNS address record.\n',
      };
    }
    return { code: 1, out: 'The relay is not running; start it, then restore.\n' };
  }
  if (!response.ok) return { code: 1, out: `The relay refused: ${response.error}\n` };
  if (response.op === 'status') return { code: 0, out: formatStatus(response.status) };
  if (response.op === 'revoke') return { code: 0, out: formatRevoke(response.result) };
  return { code: 0, out: response.restored ? `Restored ${installId}; it may register again.\n` : `${installId} was not revoked.\n` };
}

if (import.meta.main) {
  const { code, out } = await runAdmin(process.argv.slice(2));
  (code === 0 ? process.stdout : process.stderr).write(out);
  process.exit(code);
}
