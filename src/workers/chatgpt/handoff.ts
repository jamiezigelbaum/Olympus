/**
 * One-time hand-off links for connecting sources from ChatGPT.
 *
 * The ChatGPT dashboard can open only links on the plugin's own domain, so a
 * provider sign-in is handed out as `https://<relay>/go/oly2g.<installId>.<secret>`
 * (connect-relay/shared/tokens.ts). The relay routes it to this engine, which
 * answers once with a 302 to the provider's authorize URL that the
 * dashboard's own OAuth start produced. The sign-in's callback comes back
 * through the publisher callback page and the relay, verified against the
 * signed state (docs/design/chatgpt-plugin.md, "Setup from ChatGPT").
 *
 * OAuth only: no API key is ever entered through ChatGPT (owner decision
 * 2026-10-01); optional keyed providers are set up on the Mac.
 *
 * Google is the exception (owner, 2026-10-13): its sign-in happens on the
 * computer where Olympus runs, returning to this engine on loopback, so no
 * Olympus server sits in the token path. A `computer` link's relayed visit
 * only forwards the browser to the relay's bridge page (`/connect/signin`),
 * which checks that this computer's engine answers on loopback and then
 * opens `http://127.0.0.1:<port>/go/<id>` here; that direct visit is the one
 * that spends the link and redirects to Google. On a phone the bridge says
 * to open the link on the computer instead.
 *
 * Links are single use, expire after ten minutes, live in memory (a restart
 * invalidates them) and are never logged.
 */
import { HANDOFF_PATH_PREFIX, SIGNIN_BRIDGE_PATH, credentialInstallId, mintCredential } from '../../../connect-relay/shared/tokens.ts';

export const HANDOFF_TTL_MS = 10 * 60_000;
const MAX_LIVE = 64;

export type HandoffTarget =
  | {
    kind: 'redirect';
    /** The provider's authorize URL (already origin-checked by the start route). */
    location: string;
  }
  | {
    /** A Google sign-in that runs on the computer and returns to it on loopback. */
    kind: 'computer';
    source: ComputerSignInSource;
    /** Google's authorize URL, with this engine's loopback redirect (origin-checked by the start route). */
    location: string;
  };

/** The sources whose ChatGPT sign-in runs on the computer. */
export type ComputerSignInSource = 'gmail' | 'google-drive';

interface LiveLink {
  target: HandoffTarget;
  expiresAt: number;
}

export interface ChatGptHandoffs {
  /** A one-time link id naming `installId`, so the relay can route it. */
  mint(installId: string, target: HandoffTarget): { id: string; expiresAt: string };
  /** The link's target, once: a taken, expired or unknown id yields nothing. */
  take(id: string): HandoffTarget | undefined;
  /** The link's target without spending it (a `computer` link's relayed visit). */
  peek(id: string): HandoffTarget | undefined;
}

// A closure, not a class with field initializers: this module is in the
// worker bundle (see the Bun tree-shake note on class fields).
export function createChatGptHandoffs(options: { now?: () => number; ttlMs?: number } = {}): ChatGptHandoffs {
  const links = new Map<string, LiveLink>();
  const now = options.now ?? Date.now;
  const ttlMs = options.ttlMs ?? HANDOFF_TTL_MS;
  return {
    mint(installId, target) {
      const at = now();
      for (const [id, link] of links) if (link.expiresAt <= at) links.delete(id);
      while (links.size >= MAX_LIVE) {
        const oldest = links.keys().next().value;
        if (oldest === undefined) break;
        links.delete(oldest);
      }
      const id = mintCredential('handoff', installId);
      const expiresAt = at + ttlMs;
      links.set(id, { target, expiresAt });
      return { id, expiresAt: new Date(expiresAt).toISOString() };
    },
    take(id) {
      const link = links.get(id);
      links.delete(id);
      if (!link || link.expiresAt <= now()) return undefined;
      return link.target;
    },
    peek(id) {
      const link = links.get(id);
      if (!link || link.expiresAt <= now()) return undefined;
      return link.target;
    },
  };
}

export function isChatGptHandoffRequest(request: Request): boolean {
  return new URL(request.url).pathname.startsWith(HANDOFF_PATH_PREFIX);
}

export function withChatGptHandoffRoutes(
  handoff: (request: Request) => Promise<Response>,
  rest: (request: Request) => Promise<Response>,
): (request: Request) => Promise<Response> {
  return (request) => (isChatGptHandoffRequest(request) ? handoff(request) : rest(request));
}

export interface ChatGptHandoffHandlerOptions {
  /**
   * Whether the request came through the relay. Any relay marker counts,
   * verified or not, so a doubtful request never spends a `computer` link.
   */
  isRelayed(request: Request): boolean;
}

const EXPIRED = 'This Olympus link has expired or was already used. Go back to ChatGPT and try again.';

/**
 * `GET /go/<id>`: the stored redirect, once; every other case is one "expired" page.
 *
 * A `computer` link answers its relayed visit with the relay's bridge page,
 * which brings the browser back here directly on loopback, and only that
 * direct visit spends the link.
 */
export function createChatGptHandoffHandler(
  handoffs: ChatGptHandoffs,
  options: ChatGptHandoffHandlerOptions = { isRelayed: () => false },
): (request: Request) => Promise<Response> {
  return async (request) => {
    if (request.method !== 'GET') return page(405, 'This link opens in a browser.', { Allow: 'GET' });
    const id = new URL(request.url).pathname.slice(HANDOFF_PATH_PREFIX.length);
    const known = credentialInstallId('handoff', id) ? handoffs.peek(id) : undefined;
    if (!known) return page(404, EXPIRED);
    if (known.kind === 'computer' && options.isRelayed(request)) {
      // Relative: the relay resolves it against its own origin, the only
      // non-provider, non-loopback place it lets an install redirect to.
      const bridge = `${SIGNIN_BRIDGE_PATH}?${new URLSearchParams({ go: id, source: known.source }).toString()}`;
      return new Response(null, {
        status: 302,
        headers: { Location: bridge, 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' },
      });
    }
    const target = handoffs.take(id);
    if (!target) return page(404, EXPIRED);
    return new Response(null, {
      status: 302,
      headers: { Location: target.location, 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' },
    });
  };
}

function page(status: number, sentence: string, headers: Record<string, string> = {}): Response {
  return new Response(
    `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Olympus</title><p style="font:16px/1.5 system-ui,sans-serif;max-width:32rem;margin:3rem auto;padding:0 1rem">${sentence}</p></html>`,
    {
      status,
      headers: {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
        'Referrer-Policy': 'no-referrer',
        'X-Frame-Options': 'DENY',
        'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'",
        ...headers,
      },
    },
  );
}
