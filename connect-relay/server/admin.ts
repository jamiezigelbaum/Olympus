/**
 * Operator commands for a running relay, over a local Unix socket.
 *
 *   olympus-relay admin status
 *   olympus-relay admin usage [--json]
 *   olympus-relay admin revoke <install-id>
 *   olympus-relay admin restore <install-id>
 *   olympus-relay admin internal <install-id>
 *   olympus-relay admin external <install-id>
 *
 * (`bun server/admin.ts ...` from a source checkout.) Run it on the relay host
 * as the service user, for example `sudo -u relay olympus-relay admin status`.
 * The socket lives in the relay's 0700 state directory and is itself 0600, so
 * only that user and root can reach it; nothing here listens on the network.
 *
 * `status` prints counts only and names no install. `usage` prints the daily
 * usage totals (server/usage.ts), counts only too; `internal` marks one of the
 * team's own installs so those totals leave it out, `external` undoes that. `revoke` records the
 * revocation durably (fsync) before it answers, ends the install's session,
 * and refuses the id from then on (an install otherwise re-registers by
 * itself). No restart. If the relay is not running, `revoke` records the
 * revocation in the registry log instead and the relay applies it on its next
 * start; `status` then reads the log.
 *
 * Paths: RELAY_ADMIN_SOCKET (default `<registry dir>/admin.sock`),
 * RELAY_REGISTRY_PATH (default `/var/lib/olympus-relay/registry.jsonl`) and
 * RELAY_USAGE_PATH (default `<registry dir>/usage.json`).
 */
import { chmodSync, existsSync, lstatSync, mkdirSync, statSync, unlinkSync } from 'node:fs';
import net from 'node:net';
import { dirname, join } from 'node:path';
import { INSTALL_ID_PATTERN } from '../shared/protocol.ts';
import { appendOfflineRevocation, readRegistrySnapshot } from './registry.ts';
import type { RelayHandle, RelayStatus, RevokeResult } from './relay.ts';
import { readUsageFile, type UsageDay } from './usage.ts';

const MAX_ADMIN_LINE_BYTES = 4096;

function encodeLine(message: object): string {
  return `${JSON.stringify(message)}\n`;
}

/** Reads the first JSON-object line from `socket` (the admin protocol is one line each way). */
function readLine(socket: net.Socket, onLine: (message: Record<string, unknown>) => void, onError: (reason: string) => void): void {
  let buffered = '';
  const onData = (chunk: Buffer) => {
    buffered += chunk.toString('utf8');
    const newline = buffered.indexOf('\n');
    if (newline === -1) {
      if (buffered.length > MAX_ADMIN_LINE_BYTES) {
        socket.removeListener('data', onData);
        onError('line too long');
      }
      return;
    }
    socket.removeListener('data', onData);
    try {
      const parsed: unknown = JSON.parse(buffered.slice(0, newline));
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) onLine(parsed as Record<string, unknown>);
      else onError('not an object');
    } catch {
      onError('not JSON');
    }
  };
  socket.on('data', onData);
}

export const DEFAULT_REGISTRY_PATH = '/var/lib/olympus-relay/registry.jsonl';

export type AdminRequest =
  | { op: 'status' }
  | { op: 'usage' }
  | { op: 'revoke'; installId: string }
  | { op: 'restore'; installId: string }
  | { op: 'internal' | 'external'; installId: string };

export type AdminResponse =
  | { ok: true; op: 'status'; status: RelayStatus }
  | { ok: true; op: 'revoke'; result: RevokeResult }
  | { ok: true; op: 'restore'; restored: boolean }
  | { ok: true; op: 'usage'; days: UsageDay[] }
  | { ok: true; op: 'internal' | 'external'; changed: boolean }
  | { ok: false; error: string };

export function adminSocketPath(env: NodeJS.ProcessEnv = process.env): string {
  return env.RELAY_ADMIN_SOCKET ?? join(dirname(env.RELAY_REGISTRY_PATH ?? DEFAULT_REGISTRY_PATH), 'admin.sock');
}

export function usagePath(env: NodeJS.ProcessEnv = process.env): string {
  return env.RELAY_USAGE_PATH ?? join(dirname(env.RELAY_REGISTRY_PATH ?? DEFAULT_REGISTRY_PATH), 'usage.json');
}

type AdminTarget = Pick<RelayHandle, 'status' | 'revoke' | 'restore' | 'usage' | 'setInternal'>;

/**
 * Serves operator requests on a Unix socket at `path` (mode 0600). `relay` may
 * be a getter answering undefined while the relay starts: main.ts opens the
 * socket before it touches the registry, so the admin command's offline
 * fallback (which appends to the registry log) can never run beside a relay
 * that is starting up and compacting that log.
 */
export async function startAdminSocket(path: string, relay: AdminTarget | (() => AdminTarget | undefined)): Promise<{ close(): Promise<void> }> {
  const target = typeof relay === 'function' ? relay : () => relay;
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
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
    readLine(
      socket,
      (message) => {
        void handle(message).then((response) => socket.end(encodeLine(response)));
      },
      () => socket.end(encodeLine({ ok: false, error: 'malformed request' } satisfies AdminResponse)),
    );
  });
  const handle = async (message: Record<string, unknown>): Promise<AdminResponse> => {
    const relay = target();
    if (!relay) return { ok: false, error: 'the relay is starting; try again in a few seconds' };
    try {
      if (message.op === 'status') return { ok: true, op: 'status', status: relay.status() };
      if (message.op === 'usage') return { ok: true, op: 'usage', days: relay.usage() };
      const installId = typeof message.installId === 'string' ? message.installId : '';
      if (!INSTALL_ID_PATTERN.test(installId)) return { ok: false, error: 'installId must be a 32-character install id' };
      if (message.op === 'revoke') return { ok: true, op: 'revoke', result: await relay.revoke(installId) };
      if (message.op === 'restore') return { ok: true, op: 'restore', restored: await relay.restore(installId) };
      if (message.op === 'internal' || message.op === 'external') {
        return { ok: true, op: message.op, changed: await relay.setInternal(installId, message.op === 'internal') };
      }
      return { ok: false, error: 'op must be status, usage, revoke, restore, internal or external' };
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
    readLine(
      socket,
      (message) => {
        clearTimeout(timer);
        resolve(message as unknown as AdminResponse);
        socket.end();
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
    `Registered installs:        ${status.registered}`,
  ];
  if (running) {
    lines.push(
      `Online now:                 ${status.online}`,
      `Requests in flight:         ${status.inFlight}`,
      `Uploads in progress:        ${status.uploading}`,
      `Request bytes held:         ${status.heldRequestBytes}`,
      `Bytes queued for callers:   ${status.queuedBytes}`,
    );
  }
  lines.push(`Revoked installs:           ${status.revoked}`);
  lines.push(`Internal installs:          ${status.internal}`);
  return `${lines.join('\n')}\n`;
}

export function formatRevoke(result: RevokeResult): string {
  if (!result.revoked) return `${result.installId} was already revoked.\n`;
  const parts = [
    `Revoked ${result.installId} (recorded durably).`,
    result.wasRegistered ? 'Its registration was removed.' : 'It was not registered; it cannot register now.',
    result.wasOnline ? 'Its session was ended.' : 'It was offline.',
  ];
  return `${parts.join(' ')}\n`;
}

/** Days as a table, newest last. */
export function formatUsage(days: readonly UsageDay[]): string {
  if (days.length === 0) return 'No usage recorded yet.\n';
  const header = 'Day         Active  New  Back  Gone  Requests  Registered  7-day  30-day';
  const rows = days.map((day) => [
    day.day.padEnd(10),
    String(day.active).padStart(7),
    String(day.newInstalls).padStart(4),
    String(day.returning).padStart(5),
    String(day.removed).padStart(5),
    String(day.requests).padStart(9),
    String(day.registered).padStart(11),
    String(day.active7).padStart(6),
    String(day.active30).padStart(7),
  ].join(' '));
  return `${[header, ...rows].join('\n')}\n`;
}

const USAGE = 'Usage: olympus-relay admin status | usage [--json] | revoke <install-id> | restore <install-id> | internal <install-id> | external <install-id>\n';
const ID_OPS = new Set(['revoke', 'restore', 'internal', 'external']);

export async function runAdmin(
  argv: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
  /** The caller's uid (tests); defaults to this process's. */
  uid: number | undefined = process.getuid?.(),
): Promise<{ code: number; out: string }> {
  const [op, argument, ...extra] = argv;
  const json = op === 'usage' && argument === '--json';
  const installId = op !== undefined && ID_OPS.has(op) ? argument : undefined;
  const valid = op === 'status'
    ? argument === undefined
    : op === 'usage'
      ? argument === undefined || json
      : op !== undefined && ID_OPS.has(op) && argument !== undefined;
  if (extra.length > 0 || !valid) return { code: 2, out: USAGE };
  if (installId !== undefined && !INSTALL_ID_PATTERN.test(installId)) {
    return { code: 2, out: 'An install id is 32 characters of a-z and 2-7.\n' };
  }
  const socketPath = adminSocketPath(env);
  const registryPath = env.RELAY_REGISTRY_PATH ?? DEFAULT_REGISTRY_PATH;
  const request: AdminRequest = op === 'status' || op === 'usage'
    ? { op }
    : { op: op as 'revoke' | 'restore' | 'internal' | 'external', installId: installId! };
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
      return { code: 0, out: formatStatus({ ...counts, online: 0, inFlight: 0, uploading: 0, heldRequestBytes: 0, queuedBytes: 0, startedAt: '' }, false) };
    }
    if (request.op === 'usage') {
      const days = readUsageFile(usagePath(env));
      return { code: 0, out: json ? `${JSON.stringify({ running: false, days })}\n` : `Relay not running (last saved totals)\n${formatUsage(days)}` };
    }
    if (request.op === 'internal' || request.op === 'external') return { code: 1, out: 'The relay is not running; start it, then try again.\n' };
    if (request.op === 'revoke') {
      // Only the service user writes the log: an append by root (or anyone
      // else) could create a registry the relay then cannot open or rewrite.
      const owner = existsSync(dirname(registryPath)) ? statSync(dirname(registryPath)).uid : undefined;
      if (owner === undefined || (uid !== undefined && uid !== owner)) {
        return {
          code: 1,
          out: owner === undefined
            ? `The relay is not running and ${dirname(registryPath)} does not exist; nothing was recorded.\n`
            : `The relay is not running. Recording a revocation writes ${registryPath}; run this as the relay's service user `
              + `(uid ${owner}, for example sudo -u relay), not uid ${uid}. Nothing was recorded.\n`,
        };
      }
      if (readRegistrySnapshot(registryPath).isRevoked(request.installId)) return { code: 0, out: `${request.installId} was already revoked.\n` };
      appendOfflineRevocation(registryPath, request.installId);
      return {
        code: 0,
        out: `The relay is not running. Recorded the revocation of ${request.installId} in ${registryPath}; `
          + 'it applies when the relay starts.\n',
      };
    }
    return { code: 1, out: 'The relay is not running; start it, then restore.\n' };
  }
  if (!response.ok) return { code: 1, out: `The relay refused: ${response.error}\n` };
  if (response.op === 'status') return { code: 0, out: formatStatus(response.status) };
  if (response.op === 'usage') return { code: 0, out: json ? `${JSON.stringify({ running: true, days: response.days })}\n` : formatUsage(response.days) };
  if (response.op === 'internal') return { code: 0, out: response.changed ? `Marked ${installId} internal; usage totals leave it out.\n` : `${installId} is not registered or already internal.\n` };
  if (response.op === 'external') return { code: 0, out: response.changed ? `${installId} counts in usage totals again.\n` : `${installId} is not registered or not internal.\n` };
  if (response.op === 'revoke') return { code: 0, out: formatRevoke(response.result) };
  if (response.op !== 'restore') return { code: 1, out: 'The relay gave an unexpected answer.\n' };
  return { code: 0, out: response.restored ? `Restored ${installId}; it may register again.\n` : `${installId} was not revoked.\n` };
}

if (import.meta.main) {
  const { code, out } = await runAdmin(process.argv.slice(2));
  (code === 0 ? process.stdout : process.stderr).write(out);
  process.exit(code);
}
