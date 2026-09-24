/**
 * Relay process entry point. Configuration comes from the environment; see
 * docs/design/relay.md ("Runbook") and deploy/olympus-connect-relay.service.
 */
import { readFileSync } from 'node:fs';
import { CloudflareDnsProvider } from './dns.ts';
import { FileInstallRegistry } from './registry.ts';
import { startRelay } from './relay.ts';

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

/** Reads a secret from a systemd credential file when `<NAME>_FILE` is set, else the variable itself. */
function secret(name: string): string {
  const file = process.env[`${name}_FILE`];
  return file ? readFileSync(file, 'utf8').trim() : required(name);
}

// Publishing AAAA records while listening on IPv4 only would send IPv6 agents
// to a closed port: listen on `::` (dual stack) whenever IPv6 is published.
const listenHost = process.env.RELAY_LISTEN_HOST ?? (process.env.RELAY_PUBLIC_IPV6 ? '::' : '0.0.0.0');
if (process.env.RELAY_PUBLIC_IPV6 && !listenHost.includes(':')) {
  throw new Error('RELAY_PUBLIC_IPV6 is set but RELAY_LISTEN_HOST is IPv4-only; use :: or unset RELAY_LISTEN_HOST');
}

const relay = await startRelay({
  zone: required('RELAY_ZONE'),
  controlHost: required('RELAY_CONTROL_HOST'),
  ...(process.env.RELAY_DATA_HOST ? { dataHost: process.env.RELAY_DATA_HOST } : {}),
  controlTls: {
    key: readFileSync(required('RELAY_CONTROL_KEY_PATH')),
    cert: readFileSync(required('RELAY_CONTROL_CERT_PATH')),
  },
  registry: new FileInstallRegistry(required('RELAY_REGISTRY_PATH')),
  dns: new CloudflareDnsProvider({
    zoneId: required('RELAY_CLOUDFLARE_ZONE_ID'),
    apiToken: secret('RELAY_CLOUDFLARE_API_TOKEN'),
    ...(process.env.RELAY_PUBLIC_IPV4 ? { ipv4: process.env.RELAY_PUBLIC_IPV4 } : {}),
    ...(process.env.RELAY_PUBLIC_IPV6 ? { ipv6: process.env.RELAY_PUBLIC_IPV6 } : {}),
  }),
  listen: { host: listenHost, port: Number(process.env.RELAY_LISTEN_PORT ?? 443) },
  // One JSON line per event. Install ids are logged; agent addresses and payloads never are.
  log: (event, fields) => console.log(JSON.stringify({ at: new Date().toISOString(), event, ...fields })),
});

console.log(JSON.stringify({ at: new Date().toISOString(), event: 'relay_listening', port: relay.port }));
const shutdown = () => void relay.close().then(() => process.exit(0));
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
