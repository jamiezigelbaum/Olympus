/**
 * The Let's Encrypt subscriber agreement URL, read from the CA directory's
 * `meta.termsOfService` with a 10 second bound. Shared by
 * `olympus connections terms` and the dashboard's Turn on remote access, which
 * resolve the current agreement the same way (`resolveCurrentTermsUrl`).
 *
 * The ACME client is imported lazily, only when the relay has not already
 * reported the agreement.
 */
export async function fetchLetsEncryptTermsUrl(): Promise<string | undefined> {
  const { fetchTermsOfService } = await import('../../connect-relay/client/acme.ts');
  const { LETS_ENCRYPT_DIRECTORY } = await import('../../connect-relay/client/connect.ts');
  const bounded = ((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) =>
    fetch(input, { ...init, signal: AbortSignal.timeout(10_000) })) as typeof fetch;
  return fetchTermsOfService(LETS_ENCRYPT_DIRECTORY, bounded);
}
