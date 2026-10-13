/**
 * `olympus connect finish <address>`: finish a Google sign-in whose browser
 * could not reach the engine.
 *
 * Google sign-in returns to the engine on loopback,
 * `http://127.0.0.1:<port>/oauth/callback/<source>?code=…&state=…` (owner
 * decision 2026-10-13, docs/ops/OAUTH_RELAY.md). When Olympus runs on a
 * server and the browser is on another computer without the SSH tunnel, that
 * page does not load, but its address still carries the result. The person
 * copies it and runs this command on the server, which hands the same
 * callback to the engine on the server's own loopback, the way rclone's
 * remote setup does.
 *
 * Nothing here is trusted more than a browser visit would be: the engine's
 * callback route verifies the state against the sign-in it started, spends
 * the code once, and refuses everything else with one answer. Only `code`,
 * `state` and `error` are forwarded; the code is never printed.
 */

export const PASTE_SOURCES = ['gmail', 'google-drive', 'google', 'dropbox', 'x'] as const;
export type PasteSource = typeof PASTE_SOURCES[number];

export class PastedCallbackError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PastedCallbackError';
  }
}

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);
const MAX_ADDRESS_LENGTH = 8 * 1024;

/** The source and the forwarded query of a pasted callback address, or why it is not one. */
export function parsePastedOAuthCallback(input: string): { source: PasteSource; query: URLSearchParams } {
  const text = input.trim().replace(/^['"<]+|['">]+$/g, '');
  if (!text) throw new PastedCallbackError('Paste the full address of the page your browser opened after you allowed access.');
  if (text.length > MAX_ADDRESS_LENGTH) throw new PastedCallbackError('That address is too long to be a sign-in address.');
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw new PastedCallbackError('That is not a web address. Copy the whole address from the browser\'s address bar.');
  }
  if (url.protocol !== 'http:' || !LOOPBACK_HOSTS.has(url.hostname) || url.username || url.password) {
    throw new PastedCallbackError('That address is not an Olympus sign-in address. It starts with http://127.0.0.1.');
  }
  const match = /^\/oauth\/callback\/([a-z-]+)$/.exec(url.pathname);
  const source = match?.[1];
  if (!source || !(PASTE_SOURCES as readonly string[]).includes(source)) {
    throw new PastedCallbackError('That address is not an Olympus sign-in address. Its path starts with /oauth/callback/.');
  }
  const query = new URLSearchParams();
  for (const name of ['code', 'state', 'error'] as const) {
    const values = url.searchParams.getAll(name);
    if (values.length > 1) throw new PastedCallbackError('That address repeats a sign-in value. Copy it again from the address bar.');
    if (values[0]) query.set(name, values[0]);
  }
  if (!query.has('state') || (!query.has('code') && !query.has('error'))) {
    throw new PastedCallbackError('That address is missing part of the sign-in result. Copy the whole address from the address bar.');
  }
  return { source: source as PasteSource, query };
}

export interface FinishPastedCallbackOptions {
  /** The engine's own root, e.g. `http://127.0.0.1:8010` (never the pasted host or port). */
  workerRoot: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

export interface FinishPastedCallbackResult {
  ok: true;
  source: PasteSource;
  connected: true;
  next: string;
}

/**
 * The engine root on this machine's loopback, or a refusal: the code and state
 * go nowhere else, whatever worker.env or the status file say. An engine bound
 * to every address (`0.0.0.0`, `::`) is reached on its loopback.
 */
function loopbackEngineRoot(workerRoot: string): string {
  let url: URL | undefined;
  try {
    url = new URL(workerRoot.trim());
  } catch {
    url = undefined;
  }
  if (url?.hostname === '0.0.0.0') url.hostname = '127.0.0.1';
  else if (url?.hostname === '[::]') url.hostname = '[::1]';
  if (!url || url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) {
    throw new PastedCallbackError('Olympus on this computer is not set up on a local address, so the sign-in was not sent. Choose Connect again in the Olympus dashboard instead.');
  }
  return url.origin;
}

/** Hands a pasted callback to this machine's engine; resolves when the engine says connected. */
export async function finishPastedOAuthCallback(
  input: string,
  options: FinishPastedCallbackOptions,
): Promise<FinishPastedCallbackResult> {
  const { source, query } = parsePastedOAuthCallback(input);
  const root = loopbackEngineRoot(options.workerRoot);
  const fetchImpl = options.fetch ?? fetch;
  let response: Response;
  try {
    response = await fetchImpl(`${root}/oauth/callback/${source}?${query.toString()}`, {
      method: 'GET',
      redirect: 'manual',
      headers: { Accept: 'text/html' },
      signal: AbortSignal.timeout(options.timeoutMs ?? 60_000),
    });
  } catch {
    throw new PastedCallbackError(`Olympus did not answer at ${root}. Run this on the computer where Olympus runs, while it is running.`);
  }
  // The engine answers a finished sign-in with a redirect to its own
  // query-free "connected" page, and everything else with a page that says why.
  const location = response.headers.get('location') ?? '';
  if (response.status >= 300 && response.status < 400 && location.startsWith(`/oauth/callback/${source}/done`)) {
    await response.body?.cancel().catch(() => undefined);
    return {
      ok: true,
      source,
      connected: true,
      next: 'Connected. Go back to the Olympus dashboard; it picks the connection up on its own.',
    };
  }
  const reason = engineReason(await response.text().catch(() => ''));
  throw new PastedCallbackError(response.status === 410
    ? 'This sign-in is no longer active. Press Connect again in the Olympus dashboard, then paste the new address within 10 minutes.'
    : reason ?? 'The sign-in did not finish.');
}

/** The engine's own sentence from its failure page ("Could not connect Gmail: …"), entities decoded. */
function engineReason(html: string): string | undefined {
  const paragraphs = [...html.slice(0, 64 * 1024).matchAll(/<p>([^<]{1,500})<\/p>/g)].map((match) => match[1]!);
  const text = paragraphs[0];
  if (!text) return undefined;
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .trim() || undefined;
}
