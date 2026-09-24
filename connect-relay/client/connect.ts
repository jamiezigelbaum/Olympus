/**
 * Install-side entry point: identity, relay session, certificate lifecycle.
 *
 * The plugin runs this in a supervised child process (`src/core/remote-relay-runtime.ts`,
 * started by the native relay service); the relay's own end-to-end tests call
 * it directly.
 */
import { X509Certificate } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fetchTermsOfService, obtainCertificate } from './acme.ts';
import {
  ensureStateDir,
  loadOrCreateAcmeAccountKey,
  loadOrCreateIdentity,
  loadOrCreateTlsKey,
  writePrivateFile,
} from './identity.ts';
import { RelayClient, type RelayClientOptions } from './relay-client.ts';

export const LETS_ENCRYPT_DIRECTORY = 'https://acme-v02.api.letsencrypt.org/directory';

/**
 * Where the install's certificate stands. `awaiting_terms` means a new
 * certificate is needed but the user has not accepted the CA's current
 * subscriber agreement (`termsUrl`), so no ACME order was placed.
 */
export type CertificateStatus =
  | { state: 'none' }
  | { state: 'awaiting_terms'; termsUrl: string | undefined }
  | { state: 'issuing' }
  | { state: 'serving'; hostname: string; notAfter: string }
  | { state: 'failed'; reason: string; retryInMs: number };

export interface ConnectOptions extends Omit<RelayClientOptions, 'identity'> {
  readonly stateDir: string;
  readonly acme: {
    readonly directoryUrl?: string;
    /**
     * The user has been shown, and accepted, the CA's subscriber agreement.
     * A function is asked before every new order with the CA's current
     * agreement URL, so an acceptance recorded for an older agreement does
     * not carry over.
     */
    readonly termsOfServiceAgreed: boolean | ((termsUrl: string | undefined) => boolean | Promise<boolean>);
    readonly fetch?: typeof fetch;
    readonly propagationDelayMs?: number;
    readonly pollIntervalMs?: number;
  };
  readonly renewCheckMs?: number;
  /**
   * `true` (default): resolve only once a certificate is served, and reject if
   * the first issuance fails. `false`: return at once and keep trying in the
   * background with `retryBackoff`, reporting through `onCertificate`. A
   * supervised install uses `false`, so a CA outage or a pending agreement
   * never looks like a crash.
   */
  readonly awaitFirstCertificate?: boolean;
  readonly retryBackoff?: { readonly minMs: number; readonly maxMs: number };
  readonly onCertificate?: (status: CertificateStatus) => void;
}

export interface ConnectHandle {
  readonly client: RelayClient;
  /** `https://<install-id>.<zone>/mcp` once the relay session is ready. */
  url(): Promise<string>;
  /** The latest certificate status. */
  certificate(): CertificateStatus;
  /** Re-check now (after the user accepts the agreement, for example). */
  checkCertificate(): Promise<void>;
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

/** Still inside its validity window for `hostname` (usable while a renewal waits). */
function certificateIsValid(pem: string | undefined, hostname: string, now = Date.now()): boolean {
  if (!pem) return false;
  try {
    const certificate = new X509Certificate(pem);
    return Boolean(certificate.checkHost(hostname)) && Date.parse(certificate.validTo) > now;
  } catch {
    return false;
  }
}

function certificateNotAfter(pem: string): string {
  return new Date(Date.parse(new X509Certificate(pem).validTo)).toISOString();
}

export async function startConnect(options: ConnectOptions): Promise<ConnectHandle> {
  const identity = loadOrCreateIdentity(options.stateDir);
  const client = new RelayClient({ ...options, identity });
  const certPath = join(ensureStateDir(options.stateDir), 'tls-cert.pem');
  const tlsKey = loadOrCreateTlsKey(options.stateDir);
  const tlsKeyPem = tlsKey.export({ format: 'pem', type: 'pkcs8' }) as string;
  const directoryUrl = options.acme.directoryUrl ?? LETS_ENCRYPT_DIRECTORY;
  const awaitFirst = options.awaitFirstCertificate !== false;
  const renewCheckMs = options.renewCheckMs ?? 12 * 60 * 60 * 1000;
  const backoff = options.retryBackoff ?? { minMs: 60_000, maxMs: 60 * 60 * 1000 };
  let renewing: Promise<void> | undefined;
  let served: string | undefined;
  let stopped = false;
  let failures = 0;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  let status: CertificateStatus = { state: 'none' };

  const report = (next: CertificateStatus) => {
    status = next;
    options.onCertificate?.(next);
  };

  const serve = async (pem: string, hostname: string) => {
    if (pem !== served) {
      await client.setCertificate({ key: tlsKeyPem, cert: pem });
      served = pem;
    }
    report({ state: 'serving', hostname, notAfter: certificateNotAfter(pem) });
  };

  const agreed = async (): Promise<{ ok: boolean; termsUrl: string | undefined }> => {
    const decision = options.acme.termsOfServiceAgreed;
    if (typeof decision === 'boolean') return { ok: decision, termsUrl: undefined };
    const termsUrl = await fetchTermsOfService(directoryUrl, options.acme.fetch ?? fetch);
    return { ok: await decision(termsUrl), termsUrl };
  };

  const ensureCertificate = async () => {
    const hostname = await client.ready();
    let pem = existsSync(certPath) ? readFileSync(certPath, 'utf8') : undefined;
    if (!certificateIsFresh(pem, hostname)) {
      const terms = await agreed();
      if (!terms.ok) {
        // Never order without consent. A still-valid certificate keeps serving
        // while the renewal waits for the user.
        if (pem && certificateIsValid(pem, hostname)) await serve(pem, hostname);
        report({ state: 'awaiting_terms', termsUrl: terms.termsUrl });
        return;
      }
      report({ state: 'issuing' });
      pem = await obtainCertificate({
        directoryUrl,
        accountKey: loadOrCreateAcmeAccountKey(options.stateDir),
        certificateKey: tlsKey,
        hostname,
        dns: client,
        termsOfServiceAgreed: true,
        ...(options.acme.fetch ? { fetch: options.acme.fetch } : {}),
        propagationDelayMs: options.acme.propagationDelayMs ?? 10_000,
        ...(options.acme.pollIntervalMs ? { pollIntervalMs: options.acme.pollIntervalMs } : {}),
      });
      writePrivateFile(certPath, pem);
    }
    failures = 0;
    await serve(pem!, hostname);
  };

  const check = (): Promise<void> => {
    if (retryTimer) clearTimeout(retryTimer);
    retryTimer = undefined;
    renewing ??= ensureCertificate()
      .catch((error: unknown) => {
        if (stopped) throw error;
        failures += 1;
        const delay = Math.min(backoff.maxMs, backoff.minMs * 2 ** Math.min(failures - 1, 16));
        report({ state: 'failed', reason: error instanceof Error ? error.message : String(error), retryInMs: delay });
        if (!awaitFirst) {
          retryTimer = setTimeout(() => void check().catch(() => {}), delay);
          retryTimer.unref?.();
        }
        throw error;
      })
      .finally(() => {
        renewing = undefined;
      });
    return renewing;
  };

  client.start();
  if (awaitFirst) {
    try {
      await check();
    } catch (error) {
      await client.stop();
      throw error;
    }
  } else {
    void check().catch(() => {});
  }
  const timer = setInterval(() => void check().catch(() => {}), renewCheckMs);
  timer.unref?.();
  return {
    client,
    url: async () => `https://${await client.ready()}/mcp`,
    certificate: () => status,
    checkCertificate: () => check().catch(() => {}),
    stop: async () => {
      stopped = true;
      clearInterval(timer);
      if (retryTimer) clearTimeout(retryTimer);
      await client.stop();
    },
  };
}
