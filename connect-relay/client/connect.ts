/**
 * Install-side entry point: identity, relay session, certificate lifecycle.
 *
 * This is what the follow-up wires into the plugin (a `registerService` and the
 * `olympus connect` URL). Until then it lives beside the relay service so the
 * public product does not carry an unwired module.
 */
import { X509Certificate } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { obtainCertificate } from './acme.ts';
import {
  ensureStateDir,
  loadOrCreateAcmeAccountKey,
  loadOrCreateIdentity,
  loadOrCreateTlsKey,
  writePrivateFile,
} from './identity.ts';
import { RelayClient, type RelayClientOptions } from './relay-client.ts';

export const LETS_ENCRYPT_DIRECTORY = 'https://acme-v02.api.letsencrypt.org/directory';

export interface ConnectOptions extends Omit<RelayClientOptions, 'identity'> {
  readonly stateDir: string;
  readonly acme: {
    readonly directoryUrl?: string;
    /** The user has been shown, and accepted, the CA's subscriber agreement. */
    readonly termsOfServiceAgreed: boolean;
    readonly fetch?: typeof fetch;
    readonly propagationDelayMs?: number;
    readonly pollIntervalMs?: number;
  };
  readonly renewCheckMs?: number;
}

export interface ConnectHandle {
  readonly client: RelayClient;
  /** `https://<install-id>.<zone>/mcp` once the relay session is ready. */
  url(): Promise<string>;
  stop(): Promise<void>;
}

/**
 * True when `pem` exists, names `hostname`, and has more than a third of its
 * lifetime left. Proportional, so it keeps working as CA lifetimes shrink
 * (Let's Encrypt is moving from 90-day toward 45-day certificates).
 */
export function certificateIsFresh(pem: string | undefined, hostname: string, now = Date.now()): boolean {
  if (!pem) return false;
  try {
    const certificate = new X509Certificate(pem);
    if (!certificate.checkHost(hostname)) return false;
    const notBefore = Date.parse(certificate.validFrom);
    const notAfter = Date.parse(certificate.validTo);
    return notAfter - now > (notAfter - notBefore) / 3;
  } catch {
    return false;
  }
}

export async function startConnect(options: ConnectOptions): Promise<ConnectHandle> {
  const identity = loadOrCreateIdentity(options.stateDir);
  const client = new RelayClient({ ...options, identity });
  const certPath = join(ensureStateDir(options.stateDir), 'tls-cert.pem');
  const tlsKey = loadOrCreateTlsKey(options.stateDir);
  const tlsKeyPem = tlsKey.export({ format: 'pem', type: 'pkcs8' }) as string;
  let renewing: Promise<void> | undefined;
  let served: string | undefined;

  const ensureCertificate = async () => {
    const hostname = await client.ready();
    let pem = existsSync(certPath) ? readFileSync(certPath, 'utf8') : undefined;
    if (!certificateIsFresh(pem, hostname)) {
      pem = await obtainCertificate({
        directoryUrl: options.acme.directoryUrl ?? LETS_ENCRYPT_DIRECTORY,
        accountKey: loadOrCreateAcmeAccountKey(options.stateDir),
        certificateKey: tlsKey,
        hostname,
        dns: client,
        termsOfServiceAgreed: options.acme.termsOfServiceAgreed,
        ...(options.acme.fetch ? { fetch: options.acme.fetch } : {}),
        propagationDelayMs: options.acme.propagationDelayMs ?? 10_000,
        ...(options.acme.pollIntervalMs ? { pollIntervalMs: options.acme.pollIntervalMs } : {}),
      });
      writePrivateFile(certPath, pem);
    }
    if (pem !== served) {
      await client.setCertificate({ key: tlsKeyPem, cert: pem! });
      served = pem;
    }
  };
  const check = () => {
    renewing ??= ensureCertificate().finally(() => {
      renewing = undefined;
    });
    return renewing;
  };

  client.start();
  try {
    await check();
  } catch (error) {
    await client.stop();
    throw error;
  }
  const timer = setInterval(() => void check().catch(() => {}), options.renewCheckMs ?? 12 * 60 * 60 * 1000);
  timer.unref?.();
  return {
    client,
    url: async () => `https://${await client.ready()}/mcp`,
    stop: async () => {
      clearInterval(timer);
      await client.stop();
    },
  };
}
