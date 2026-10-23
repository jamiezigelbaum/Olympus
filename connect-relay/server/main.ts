/**
 * Relay process entry point (compiled with `bun build --compile`; see
 * deploy/deploy.sh). Configuration comes from the environment:
 *
 *   RELAY_PUBLIC_HOST     the one public name Caddy serves (default mcp.olympusplugin.ai)
 *   RELAY_LISTEN_HOST     default 127.0.0.1 (Caddy proxies to it)
 *   RELAY_LISTEN_PORT     default 8787
 *   RELAY_ENGINE_PORT     the engine worker's loopback port for the authorize bridge (default 8010)
 *   RELAY_INSTALL_URL     where "Install Olympus" leads (authorize bridge, not-connected dashboard)
 *   RELAY_DEMO_INSTALL_ID the demo install reviewers sign in to (unset: no demo)
 *   RELAY_DEMO_CLIENT_INSTALLS  `<client_id>=<install id>` pairs, space separated:
 *                         a demo install for one app's reviewers (relay.ts demoInstallsByClient)
 *   RELAY_OPENAI_APPS_CHALLENGE / RELAY_OPENAI_APPS_CHALLENGE_FILE
 *                         OpenAI's domain verification token (unset: 404)
 *   RELAY_CIMD_OFF_FILE   while this file exists the OAuth metadata leaves out
 *                         CIMD support (oauth-metadata.ts); checked per request
 *   RELAY_REGISTRY_PATH   default /var/lib/olympus-relay/registry.jsonl
 *   RELAY_ADMIN_SOCKET    default <registry dir>/admin.sock
 *   RELAY_USAGE_PATH      daily usage totals, default <registry dir>/usage.json (server/usage.ts)
 *   RELAY_LEGACY_AUTH     `off` closes the legacy signature window (default on;
 *                         docs/design/chatgpt-plugin.md, "Relay protocol compatibility")
 *
 * `main.ts admin <status|usage|revoke|restore|internal|external> ...` runs the operator command
 * instead of the relay (server/admin.ts), so the compiled binary carries both.
 * `main.ts count-installers` adds the site's installer downloads to their
 * daily counts (server/installer-counts.ts), run hourly by a systemd timer.
 */
import { existsSync, readFileSync } from 'node:fs';
import { adminSocketPath, DEFAULT_REGISTRY_PATH, runAdmin, startAdminSocket, usagePath } from './admin.ts';
import { jsonLineLog } from './log.ts';
import { FileInstallRegistry } from './registry.ts';
import { startRelay } from './relay.ts';

if (process.argv[2] === 'count-installers') {
  const { runCountInstallers } = await import('./installer-counts.ts');
  const { code, out } = runCountInstallers(process.argv.slice(3));
  (code === 0 ? process.stdout : process.stderr).write(out);
  process.exit(code);
}

if (process.argv[2] === 'admin') {
  const { code, out } = await runAdmin(process.argv.slice(3));
  (code === 0 ? process.stdout : process.stderr).write(out);
  process.exit(code);
}

/** The legacy signature window: open unless RELAY_LEGACY_AUTH says off. */
function legacyAuth(): boolean {
  const value = (process.env.RELAY_LEGACY_AUTH ?? 'on').trim().toLowerCase();
  if (['off', '0', 'false', 'no'].includes(value)) return false;
  if (['on', '1', 'true', 'yes', ''].includes(value)) return true;
  throw new Error('RELAY_LEGACY_AUTH must be on or off');
}

function port(name: string, fallback: number): number {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isInteger(value) || value < 1 || value > 65535) throw new Error(`${name} must be a TCP port`);
  return value;
}

/** The domain verification token: the variable, else the file (re-read per request), else none. */
function appsChallenge(): string | undefined {
  if (process.env.RELAY_OPENAI_APPS_CHALLENGE) return process.env.RELAY_OPENAI_APPS_CHALLENGE;
  const file = process.env.RELAY_OPENAI_APPS_CHALLENGE_FILE;
  if (!file) return undefined;
  try {
    return readFileSync(file, 'utf8').slice(0, 4096);
  } catch {
    return undefined;
  }
}

/** `<client_id>=<install id>` pairs, space separated (a client_id URL holds no space). */
function demoClientInstalls(value: string): Record<string, string> {
  const pairs: Record<string, string> = {};
  for (const pair of value.trim().split(/\s+/)) {
    const at = pair.lastIndexOf('=');
    if (at <= 0) throw new Error('RELAY_DEMO_CLIENT_INSTALLS takes <client_id>=<install id> pairs');
    pairs[pair.slice(0, at)] = pair.slice(at + 1);
  }
  return pairs;
}

/** CIMD is advertised unless the operator's switch file exists (checked per request). */
function advertiseCimd(): boolean {
  const file = process.env.RELAY_CIMD_OFF_FILE;
  return !file || !existsSync(file);
}

const log = jsonLineLog();
// Operator commands: a 0600 Unix socket in the state directory, opened BEFORE
// the registry is read and compacted, so the admin command never mistakes a
// starting relay for a stopped one and appends to the log underneath it.
let relay: Awaited<ReturnType<typeof startRelay>> | undefined;
const admin = await startAdminSocket(adminSocketPath(), () => relay);

relay = await startRelay({
  publicHost: process.env.RELAY_PUBLIC_HOST ?? 'mcp.olympusplugin.ai',
  registry: new FileInstallRegistry(process.env.RELAY_REGISTRY_PATH ?? DEFAULT_REGISTRY_PATH),
  usagePath: usagePath(),
  listen: { host: process.env.RELAY_LISTEN_HOST ?? '127.0.0.1', port: port('RELAY_LISTEN_PORT', 8787) },
  enginePort: port('RELAY_ENGINE_PORT', 8010),
  ...(process.env.RELAY_INSTALL_URL ? { installUrl: process.env.RELAY_INSTALL_URL } : {}),
  ...(process.env.RELAY_DEMO_INSTALL_ID ? { demoInstallId: process.env.RELAY_DEMO_INSTALL_ID } : {}),
  ...(process.env.RELAY_DEMO_CLIENT_INSTALLS ? { demoInstallsByClient: demoClientInstalls(process.env.RELAY_DEMO_CLIENT_INSTALLS) } : {}),
  appsChallenge,
  advertiseCimd,
  limits: { acceptLegacyAuth: legacyAuth() },
  trustProxy: true,
  log,
});

console.log(JSON.stringify({ at: new Date().toISOString(), event: 'relay_listening', port: relay.port }));
const shutdown = () => void admin.close().then(() => relay?.close()).then(() => process.exit(0));
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
