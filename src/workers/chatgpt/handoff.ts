/**
 * One-time hand-off links for connecting sources from ChatGPT.
 *
 * The ChatGPT dashboard can open only links on the plugin's own domain, so a
 * connect is handed out as `https://<relay>/go/oly2g.<installId>.<secret>`
 * (connect-relay/shared/tokens.ts). The relay routes it to this engine, which
 * answers it once. Two kinds:
 *
 * - `redirect`: a 302 to the provider's authorize URL that the dashboard's
 *   own OAuth start produced (Gmail, Drive, Dropbox). The sign-in's callback
 *   comes back through the publisher callback page and the relay, verified
 *   against the signed state (docs/design/chatgpt-plugin.md, "Setup from
 *   ChatGPT").
 * - `key_page`: a key-entry page for a keyed source (Readwise, X bookmarks;
 *   connect-page.ts, docs/design/connect-pages.md). Opening it spends the
 *   link, makes a key pair for that view, and arms a submission: a POST of
 *   ciphertext to the same path, sealed in the page to that key. The engine
 *   answers the GET with a descriptor only (source and public key); the
 *   relay renders the page from its own template. A submission that opens
 *   goes into the dashboard's own connect route.
 *
 * No key is ever entered through ChatGPT (owner decision 2026-10-01): a key
 * is typed only on the page, in the owner's browser, and reaches the engine
 * encrypted to it.
 *
 * Links and armed pages are single use, expire after ten minutes, live in
 * memory (a restart invalidates them) and are never logged; neither are the
 * bodies posted to them.
 */
import { HANDOFF_PATH_PREFIX, credentialInstallId, mintCredential } from '../../../connect-relay/shared/tokens.ts';
import { CONNECT_PAGE_MAX_REQUEST_BYTES } from '../../../connect-relay/shared/connect-page.ts';
import {
  connectPageDescriptorResponse,
  connectPageMessage,
  createConnectPageKey,
  openConnectPageSubmission,
  type ConnectPageKey,
  type KeyPageSource,
} from './connect-page.ts';

export const HANDOFF_TTL_MS = 10 * 60_000;
const MAX_LIVE = 64;

export type HandoffTarget =
  | {
    kind: 'redirect';
    /** The provider's authorize URL (already origin-checked by the start route). */
    location: string;
  }
  | {
    kind: 'key_page';
    source: KeyPageSource;
  };

interface LiveLink {
  target: HandoffTarget;
  expiresAt: number;
}

/** One served key page, waiting for its one submission. */
export interface ArmedPage {
  source: KeyPageSource;
  key: ConnectPageKey;
}

interface LiveArmedPage extends ArmedPage {
  expiresAt: number;
  failures: number;
}

/** Submissions that do not open before a page is spent (junk from someone holding the link id). */
export const MAX_FAILED_SUBMISSIONS = 3;

export interface ChatGptHandoffs {
  /** A one-time link id naming `installId`, so the relay can route it. */
  mint(installId: string, target: HandoffTarget): { id: string; expiresAt: string };
  /** The link's target, once: a taken, expired or unknown id yields nothing. */
  take(id: string): HandoffTarget | undefined;
  /** Arms one submission for a key page just served for `id` (ten minutes from now). */
  arm(id: string, page: ArmedPage): void;
  /** Whether `id` has an armed, unexpired page (nothing is taken). */
  isArmed(id: string): boolean;
  /** The armed page for `id`, once: a taken, expired or unknown id yields nothing. */
  takeArmed(id: string): ArmedPage | undefined;
  /**
   * Puts back a page whose submission did not open, keeping its expiry, until
   * MAX_FAILED_SUBMISSIONS such attempts have been made.
   */
  rearmAfterFailure(id: string, page: ArmedPage): void;
}

// A closure, not a class with field initializers: this module is in the
// worker bundle (see the Bun tree-shake note on class fields).
export function createChatGptHandoffs(options: { now?: () => number; ttlMs?: number } = {}): ChatGptHandoffs {
  const links = new Map<string, LiveLink>();
  const armed = new Map<string, LiveArmedPage>();
  // A page taken for one submission attempt, until the attempt is decided.
  const taken = new WeakMap<ConnectPageKey, LiveArmedPage>();
  const now = options.now ?? Date.now;
  const ttlMs = options.ttlMs ?? HANDOFF_TTL_MS;
  const prune = <T extends { expiresAt: number }>(map: Map<string, T>, at: number) => {
    for (const [id, entry] of map) if (entry.expiresAt <= at) map.delete(id);
    while (map.size >= MAX_LIVE) {
      const oldest = map.keys().next().value;
      if (oldest === undefined) break;
      map.delete(oldest);
    }
  };
  return {
    mint(installId, target) {
      const at = now();
      prune(links, at);
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
    arm(id, page) {
      const at = now();
      prune(armed, at);
      armed.set(id, { source: page.source, key: page.key, expiresAt: at + ttlMs, failures: 0 });
    },
    isArmed(id) {
      const page = armed.get(id);
      return page !== undefined && page.expiresAt > now();
    },
    takeArmed(id) {
      const page = armed.get(id);
      armed.delete(id);
      if (!page || page.expiresAt <= now()) return undefined;
      taken.set(page.key, page);
      return { source: page.source, key: page.key };
    },
    rearmAfterFailure(id, page) {
      const live = taken.get(page.key);
      taken.delete(page.key);
      if (!live || live.expiresAt <= now() || live.failures + 1 >= MAX_FAILED_SUBMISSIONS || armed.has(id)) return;
      armed.set(id, { ...live, failures: live.failures + 1 });
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

/** What a submitted key page leads to. Fixed outcomes; the page owns the words. */
export type KeyPageOutcome =
  | { status: 'connected' }
  /** X: the app is saved; the owner continues to the provider's sign-in. */
  | { status: 'continue'; location: string }
  | { status: 'rejected' }
  | { status: 'models_not_ready' }
  | { status: 'already_connected' }
  | { status: 'failed' };

export interface ConnectPageOptions {
  /** The relay's public origin for this install (`https://<relay>`); undefined when not linked. */
  publicOrigin(): string | undefined;
  /** X only: the callback address its app must list (the computer's own dashboard). */
  xCallbackUri?(): string | undefined;
  /** Feeds the opened fields into the dashboard's own connect route. Never logs them. */
  submit(source: KeyPageSource, fields: Record<string, string>): Promise<KeyPageOutcome>;
}

const EXPIRED = 'This Olympus link has expired or was already used. Go back to ChatGPT and try again.';
const LABELS: Readonly<Record<KeyPageSource, string>> = { readwise: 'Readwise', x: 'X bookmarks' };
const FORM_TYPE = 'application/x-www-form-urlencoded';

/**
 * `GET /go/<id>`: the stored redirect or key page, once; `POST /go/<id>`: the
 * one submission of a key page served for it. Every other case is one
 * "expired" page.
 */
export function createChatGptHandoffHandler(
  handoffs: ChatGptHandoffs,
  connectPage?: ConnectPageOptions,
): (request: Request) => Promise<Response> {
  return async (request) => {
    const id = new URL(request.url).pathname.slice(HANDOFF_PATH_PREFIX.length);
    const valid = credentialInstallId('handoff', id) !== undefined;
    if (request.method === 'POST') return submit(request, id, valid);
    if (request.method !== 'GET') return page(405, 'This link opens in a browser.', { Allow: 'GET, POST' });
    const target = valid ? handoffs.take(id) : undefined;
    if (!target) return page(404, EXPIRED);
    if (target.kind === 'redirect') {
      return new Response(null, {
        status: 302,
        headers: { Location: target.location, 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' },
      });
    }
    if (!connectPage || !connectPage.publicOrigin()) return page(404, EXPIRED);
    const key = await createConnectPageKey();
    handoffs.arm(id, { source: target.source, key });
    const xCallbackUri = target.source === 'x' ? connectPage.xCallbackUri?.() : undefined;
    return connectPageDescriptorResponse({ source: target.source, key, ...(xCallbackUri ? { xCallbackUri } : {}) });
  };

  async function submit(request: Request, id: string, valid: boolean): Promise<Response> {
    const origin = connectPage?.publicOrigin();
    if (!valid || !connectPage || !origin) return page(404, EXPIRED);
    // Nothing is read for a link with no armed page.
    if (!handoffs.isArmed(id)) return page(404, EXPIRED);
    // A cross-site form cannot spend the page: the browser names its origin,
    // and only the page itself (sandboxed: "null") or the relay may post.
    // An absent Origin (a non-browser client) is let through: what protects
    // the page is the per-view key the ciphertext must open with.
    const from = request.headers.get('origin');
    if (from !== null && from !== 'null' && from !== origin) return page(403, 'This form can only be sent from its own page.');
    const contentType = (request.headers.get('content-type') ?? '').split(';', 1)[0]!.trim().toLowerCase();
    if (contentType !== FORM_TYPE) return page(415, 'This link opens in a browser.');
    const text = await readCapped(request, CONNECT_PAGE_MAX_REQUEST_BYTES);
    if (text === undefined) return page(413, 'That was too long to be a key.');
    // Taken here, before anything is opened: one attempt at a time. A body
    // that does not open puts the page back, up to MAX_FAILED_SUBMISSIONS.
    const armed = handoffs.takeArmed(id);
    if (!armed) return page(404, EXPIRED);
    const label = LABELS[armed.source];
    const fields = await openConnectPageSubmission({ key: armed.key, linkId: id, source: armed.source, form: new URLSearchParams(text) });
    if (!fields) {
      handoffs.rearmAfterFailure(id, armed);
      return page(400, `Olympus could not read what was sent, so nothing was saved. Go back to ChatGPT and press Connect on ${label} again.`);
    }
    let outcome: KeyPageOutcome;
    try {
      outcome = await connectPage.submit(armed.source, fields);
    } catch {
      outcome = { status: 'failed' };
    }
    return outcomePage(armed.source, outcome);
  }
}

/** The body as text, or undefined once it passes `max` bytes (read no further). */
async function readCapped(request: Request, max: number): Promise<string | undefined> {
  const declared = Number(request.headers.get('content-length') ?? '0');
  if (!Number.isFinite(declared) || declared > max) return undefined;
  if (!request.body) return '';
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > max) {
        await reader.cancel().catch(() => {});
        return undefined;
      }
      chunks.push(value);
    }
  } catch {
    return undefined;
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

function outcomePage(source: KeyPageSource, outcome: KeyPageOutcome): Response {
  const label = LABELS[source];
  const again = `Go back to ChatGPT and press Connect on ${label} to try again.`;
  switch (outcome.status) {
    case 'connected':
      return connectPageMessage(200, `${label} is connected. Olympus starts reading it on your computer. You can close this tab and go back to ChatGPT.`);
    case 'continue':
      return connectPageMessage(
        200,
        'Your X app is saved on your computer. Next, X asks you to allow Olympus. X then returns to Olympus on your computer, so open the next step on the computer Olympus runs on.',
        { href: outcome.location, label: 'Continue to X' },
      );
    case 'rejected':
      return connectPageMessage(400, source === 'readwise'
        ? `Readwise did not accept that token, so nothing was saved. ${again}`
        : `X did not accept those app details, so nothing was saved. ${again}`);
    case 'models_not_ready':
      return connectPageMessage(409, `Olympus on your computer is still setting up its models, so nothing was saved. ${again} once setup has finished.`);
    case 'already_connected':
      return connectPageMessage(409, `Another ${label} account is already connected. Disconnect it in ChatGPT first, then connect this one.`);
    default:
      return connectPageMessage(502, `Olympus could not connect ${label} just now, so nothing was saved. ${again}`);
  }
}

function page(status: number, sentence: string, headers: Record<string, string> = {}): Response {
  const response = connectPageMessage(status, sentence);
  for (const [name, value] of Object.entries(headers)) response.headers.set(name, value);
  return response;
}
