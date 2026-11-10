/**
 * The standalone dashboard's bounded opening handoff.
 *
 * `olympus dashboard` used to hand the reader a `?token=dash_` link and tell
 * them to unlock the controls by pasting the worker bearer token into the page.
 * This module carries the replacement: the CLI — which already resolves the
 * worker token privately (worker.env outranks a stale config) — asks its OWN
 * configured worker, over the bearer it already holds, for a ticket; the
 * browser redeems that ticket from a page that reaches the worker's origin.
 *
 * What this deliberately is NOT:
 * - The ticket is never derived from the worker token or the derived `dash_`
 *   read token: it is 256 bits from `randomBytes`, so seeing one ticket says
 *   nothing about the worker token or about any other ticket.
 * - It is never persisted. One process, one `Map`, in memory; a restart simply
 *   invalidates outstanding tickets, and the reader runs the CLI again.
 * - It is single-use and short-lived (15 minutes) and bound to the origin that minted
 *   it, so a copied ticket grants at most one redemption at the intended origin
 *   before it expires. Anyone holding an unused ticket can use it there.
 *
 * The redeem response reuses the existing control-session cookie and CSRF
 * machinery in `src/workers/http.ts`; this module only owns the ticket.
 */
import { createHash, randomBytes } from 'node:crypto';
import { DASHBOARD_LAUNCH_OPEN_KEY, DASHBOARD_OPEN_FRAGMENT_KEY, openTargetTokenPattern, keysOpenTargetTokenPattern, connectOpenTargetTokenPattern, panelOpenTargetTokenPattern, privateAnswersOpenTargetTokenPattern } from './open-targets.ts';

/** GET here renders the ticket-redeeming page. No private data; no token. */
export const DASHBOARD_LAUNCH_PAGE_PATH = '/dashboard/launch';
/** Bearer-only POST here mints a ticket. Same origin check as a control POST. */
export const DASHBOARD_LAUNCH_MINT_PATH = '/dashboard/control/launch';
/** POST here consumes a ticket and answers with the existing control cookie. */
export const DASHBOARD_LAUNCH_REDEEM_PATH = '/dashboard/control/launch/redeem';
/** The URL fragment key the opening page reads and clears. */
export const DASHBOARD_LAUNCH_TICKET_FRAGMENT_KEY = 'olympus_launch_ticket';
/**
 * Long enough for an operator to receive the link in chat and open it (owner
 * decision, 2026-09-24: two minutes routinely expired before the click), short
 * enough that a copied ticket has limited exposure: one redemption before
 * expiry.
 */
export const DASHBOARD_LAUNCH_TICKET_TTL_SECONDS = 900;
/**
 * A bound on the in-memory store. The CLI mints one ticket per invocation and
 * the browser consumes it; anything approaching this cap is a caller that is
 * not the CLI, so the oldest tickets are pruned first.
 */
export const DASHBOARD_LAUNCH_MAX_TICKETS = 32;
/**
 * A remote opening ticket (`olympus_open_remote`): the owner's assistant runs
 * the tunnel and the open within a minute, so it lives two minutes, and it
 * passes through an agent transcript, so minting one revokes any earlier
 * remote ticket not yet redeemed (review of 2026-10-10).
 */
export const DASHBOARD_REMOTE_LAUNCH_TICKET_TTL_SECONDS = 120;
/** `POST /dashboard/control/launch?purpose=remote` mints a remote ticket. */
export const DASHBOARD_LAUNCH_REMOTE_PURPOSE = 'remote';

/**
 * Where the owner's browser keeps this engine's dashboard unlock key, so a
 * later plain navigation to `/dashboard` can prove it (#1187, owner decision
 * 2026-11-10: per-port browser storage).
 *
 * Browsers share cookies across every port of a host (RFC 6265 §8.5), so a
 * server on another loopback port can be handed the dashboard cookie. Browser
 * storage is kept per origin, port included, so only a page this engine served
 * can read this value. The cookie alone renders the content-free shell below;
 * the shell reads this value and fetches the real page with it.
 *
 * The key is one per engine origin (workers/http.ts, dashboardUnlockKey), so
 * it stays the same when this browser's session is renewed or upgraded to a
 * local one. It is handed out only with a control session (the opening link,
 * a worker token, the desktop bridge) and proves nothing without that
 * session's cookie. Only this one value is kept, never the worker bearer,
 * a CSRF token or a read token.
 */
export const DASHBOARD_UNLOCK_STORAGE_KEY = 'olympus-dashboard-unlock-v1';
/** The header a fetch of a dashboard page carries the stored key in. */
export const DASHBOARD_UNLOCK_HEADER = 'X-Olympus-Dashboard-Unlock';
/** Marks the shell's response, so its own fetch never writes a shell into a shell. */
export const DASHBOARD_UNLOCK_SHELL_HEADER = 'X-Olympus-Dashboard-Shell';

export interface DashboardLaunchTicketStoreOptions {
  now?: () => number;
  maxTickets?: number;
}

export type DashboardLaunchTicketConsumeStatus =
  | 'ok'
  | 'unknown'
  | 'expired'
  | 'origin_mismatch';

/**
 * A redeemed ticket carries the ticket it consumed, so the caller can bind
 * whatever it does next to exactly the value that was accepted. Refusals carry
 * the reason and nothing else.
 */
export type DashboardLaunchTicketConsumeResult =
  | { status: 'ok'; ticket: string }
  | { status: Exclude<DashboardLaunchTicketConsumeStatus, 'ok'> };

interface DashboardLaunchTicketRecord {
  expiresAtMs: number;
  originTag: string;
  remote?: true;
}

/**
 * Bounded, single-use, origin-bound, in-memory tickets.
 *
 * The store is injected into the worker's auth wrapper so a test can drive a
 * clock; production uses exactly one instance for the process.
 */
export class DashboardLaunchTickets {
  private readonly tickets = new Map<string, DashboardLaunchTicketRecord>();
  private readonly now: () => number;
  private readonly maxTickets: number;

  constructor(options: DashboardLaunchTicketStoreOptions = {}) {
    this.now = options.now ?? Date.now;
    this.maxTickets = options.maxTickets ?? DASHBOARD_LAUNCH_MAX_TICKETS;
    if (!Number.isInteger(this.maxTickets) || this.maxTickets < 1 || this.maxTickets > 1024) {
      throw new Error('Dashboard launch capacity must be an integer from 1 to 1024.');
    }
  }

  /**
   * `remote`: a two-minute ticket, and any earlier remote ticket still
   * outstanding is revoked first, so at most one is ever live.
   */
  mint(origin: string, options: { remote?: boolean } = {}): string {
    const nowMs = this.now();
    this.prune(nowMs);
    if (options.remote === true) {
      for (const [ticket, record] of this.tickets) {
        if (record.remote) this.tickets.delete(ticket);
      }
    }
    const ttlSeconds = options.remote === true ? DASHBOARD_REMOTE_LAUNCH_TICKET_TTL_SECONDS : DASHBOARD_LAUNCH_TICKET_TTL_SECONDS;
    const expiresAtMs = nowMs + ttlSeconds * 1000;
    const ticket = randomBytes(32).toString('base64url');
    this.tickets.set(ticket, {
      expiresAtMs,
      originTag: dashboardLaunchOriginTag(origin),
      ...(options.remote === true ? { remote: true as const } : {}),
    });
    // Boundary is inclusive enough to be simple: an evicted ticket is no worse
    // than a spent one, and both are refusals the caller already handles.
    while (this.tickets.size > this.maxTickets) {
      const oldest = this.tickets.keys().next();
      if (oldest.done) break;
      this.tickets.delete(oldest.value);
    }
    return ticket;
  }

  /**
   * Consume one ticket, once.
   *
   * Single-use is enforced by DELETING before the ticket is returned, so two
   * concurrent redeems cannot both win: the loser sees `unknown`, exactly the
   * answer any later presentation gets. The delete happens after the origin
   * check on purpose — a page that is not the minting origin must not be able
   * to burn somebody else's ticket, but the answer it receives is still just
   * "no", so it learns nothing about whether that ticket existed.
   */
  consume(ticket: string | undefined | null, origin: string | undefined | null): DashboardLaunchTicketConsumeResult {
    if (!isWellFormedDashboardLaunchTicket(ticket)) return { status: 'unknown' };
    const record = this.tickets.get(ticket);
    if (!record) return { status: 'unknown' };
    if (typeof origin !== 'string' || dashboardLaunchOriginTag(origin) !== record.originTag) {
      return { status: 'origin_mismatch' };
    }
    this.tickets.delete(ticket);
    if (record.expiresAtMs <= this.now()) return { status: 'expired' };
    return { status: 'ok', ticket };
  }

  /** Outstanding tickets. Test seam; the CLI never reads it. */
  get size(): number {
    return this.tickets.size;
  }

  private prune(nowMs: number): void {
    for (const [ticket, record] of this.tickets) {
      if (record.expiresAtMs <= nowMs) this.tickets.delete(ticket);
    }
  }
}

/**
 * The origin tag a ticket is bound to.
 *
 * A tag rather than the origin itself: the stored record then names no host
 * the worker was ever asked about, and a tag never matches an origin that was
 * not the one that minted it. SHA-256 is truncated to 43 base64url chars.
 */
function dashboardLaunchOriginTag(origin: string): string {
  return createHash('sha256').update('olympus-dashboard-launch-origin-v1\0').update(origin).digest('base64url').slice(0, 43);
}

/** A ticket is 32 random bytes as base64url; anything else is refused unread. */
function isWellFormedDashboardLaunchTicket(value: string | undefined | null): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{43}$/.test(value);
}

/**
 * The page the CLI's opening URL points at.
 *
 * It exists so the ticket can travel in the URL FRAGMENT, which browsers never
 * send to a server, and then be cleared from the address bar BEFORE any
 * cross-origin request (or any bookmark, history entry, or Referer) can carry
 * it. The page itself contains no install fact, no token, and no counts — it is
 * a constant, and it is exactly why this route needs no authorization.
 *
 * No inline event handlers and no markup the ticket is ever interpolated into:
 * the only script reads `location.hash`, clears it, and POSTs a JSON body to
 * this same origin.
 */
export const DASHBOARD_LAUNCH_PAGE_HTML = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <meta name="referrer" content="no-referrer">
    <title>Olympus</title>
    <style>
      body { margin: 0; padding: 3rem 1.5rem; font: 15px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Noto Sans", Ubuntu, Cantarell, "Liberation Sans", "DejaVu Sans", "Helvetica Neue", Arial, system-ui, sans-serif; color: #e8e6e3; background: #16151a; }
      main { max-width: 32rem; margin: 0 auto; }
      h1 { font-size: 1.05rem; font-weight: 600; margin: 0 0 .5rem; }
      p { margin: 0; color: #a9a4ae; }
      a { color: #cfc7ff; }
    </style>
  </head>
  <body>
    <main>
      <h1 id="status">Opening Olympus…</h1>
      <p id="detail">If this does not continue, <a href="/dashboard">open the dashboard</a>.</p>
    </main>
    <script>
      (function () {
        var KEY = '${DASHBOARD_LAUNCH_TICKET_FRAGMENT_KEY}';
        var OPEN = /${openTargetTokenPattern()}/;
        var KEYS = /${keysOpenTargetTokenPattern()}/;
        var CONNECT = /${connectOpenTargetTokenPattern()}/;
        var PANEL = /${panelOpenTargetTokenPattern()}/;
        var PRIVATE = /${privateAnswersOpenTargetTokenPattern()}/;
        var status = document.getElementById('status');
        var open = '';
        function take() {
          var hash = window.location.hash.slice(1);
          // Clear even malformed fragments before parsing or making a request.
          try { window.history.replaceState(null, '', window.location.pathname + window.location.search); }
          catch (e) { return ''; }
          var params = new URLSearchParams(hash);
          // Where to land: one of a closed list, or the plain dashboard.
          var wanted = params.get('${DASHBOARD_LAUNCH_OPEN_KEY}') || '';
          if (OPEN.test(wanted)) open = wanted;
          return params.get(KEY) || '';
        }
        var ticket = take();
        if (!ticket) {
          // A reload of this page after its ticket was taken: the dashboard has the session, or the way back in.
          window.location.replace('/dashboard');
          return;
        }
        fetch('/dashboard/control/launch/redeem', {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ticket: ticket })
        }).then(function (response) {
          if (!response.ok) return response;
          // This browser's key for later plain navigations (#1187): kept per origin, so per port.
          return response.json().then(function (body) {
            try {
              if (body && typeof body.unlock_key === 'string') window.localStorage.setItem('${DASHBOARD_UNLOCK_STORAGE_KEY}', body.unlock_key);
            } catch (e) {}
            return response;
          }, function () { return response; });
        }).then(function (response) {
          // A link already used or expired (a reload, a second open) still
          // lands on the dashboard: the session it opened is in its cookie,
          // and without one the dashboard itself offers the way back in.
          if (response.ok || response.status === 403) {
            // Connect lands on Connect a source, where the computer's setup sheets live; a
            // model fix lands on Privacy settings (?keys), where the models live. Each only
            // opens something there, never submits anything.
            // A panel target (See why on one source) lands on the dashboard there.
            // Private answers lands on that page, carrying nothing.
            // Everything else (a reconnect, the dashboard itself) lands on the dashboard.
            window.location.replace(CONNECT.test(open)
              ? '/dashboard?connect#${DASHBOARD_OPEN_FRAGMENT_KEY}=' + open
              : KEYS.test(open) ? '/dashboard?keys#${DASHBOARD_OPEN_FRAGMENT_KEY}=' + open
              : PANEL.test(open) ? '/dashboard#${DASHBOARD_OPEN_FRAGMENT_KEY}=' + open
              : PRIVATE.test(open) ? '/dashboard?private-answers' + (open.indexOf('page.private.') === 0 ? '#' + open.slice(13) : '') : '/dashboard');
            return;
          }
          // Anything else: the dashboard is the way in (its session, or how to get one).
          window.location.replace('/dashboard');
        }).catch(function () {
          status.textContent = 'Opening failed.';
        });
      }());
    </script>
  </body>
</html>
`;

/**
 * The opening page's response headers.
 *
 * `no-store` so no cache keeps the page (or the fact it was opened) around,
 * `no-referrer` so the URL of the page never accompanies any navigation, and a
 * policy that allows exactly the one inline script this page carries — no
 * external origin, no framing, no forms, no base rewriting.
 */
export function dashboardLaunchPageHeaders(): Record<string, string> {
  const script = DASHBOARD_LAUNCH_PAGE_HTML.split('<script>')[1]!.split('</script>')[0]!;
  const scriptHash = createHash('sha256').update(script).digest('base64');
  return {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
    'Referrer-Policy': 'no-referrer',
    'X-Frame-Options': 'DENY',
    'Content-Security-Policy': `default-src 'none'; script-src 'sha256-${scriptHash}'; style-src 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'`,
  };
}


/**
 * The page a navigation to `/dashboard` gets with the cookie alone: no install
 * fact, no token, no data. Its script reads this origin's stored unlock key,
 * fetches the same address with it, and writes the answer into this window, so
 * the address, the fragment and the back button stay as they were. Without a
 * stored token (another port, another browser, a cleared one) it says how to
 * open Olympus again.
 */
export const DASHBOARD_UNLOCK_SHELL_HTML = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <meta name="referrer" content="no-referrer">
    <title>Olympus</title>
    <style>
      body { margin: 0; padding: 3rem 1.5rem; font: 15px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Noto Sans", Ubuntu, Cantarell, "Liberation Sans", "DejaVu Sans", "Helvetica Neue", Arial, system-ui, sans-serif; color: #e8e6e3; background: #16151a; }
      main { max-width: 32rem; margin: 0 auto; }
      h1 { font-size: 1.05rem; font-weight: 600; margin: 0 0 .5rem; }
      p { margin: 0; color: #a9a4ae; }
      code { color: #e8e6e3; }
    </style>
  </head>
  <body>
    <main>
      <h1 id="status">Opening Olympus…</h1>
      <p id="detail"></p>
    </main>
    <script>
      (function () {
        var KEY = '${DASHBOARD_UNLOCK_STORAGE_KEY}';
        var SHELL = '${DASHBOARD_UNLOCK_SHELL_HEADER}';
        var HEADER = '${DASHBOARD_UNLOCK_HEADER}';
        var status = document.getElementById('status');
        var detail = document.getElementById('detail');
        function locked() {
          try { window.localStorage.removeItem(KEY); } catch (e) {}
          status.textContent = 'Dashboard controls are locked';
          detail.textContent = 'Run ';
          var command = document.createElement('code');
          command.textContent = 'olympus dashboard';
          detail.appendChild(command);
          detail.appendChild(document.createTextNode(' in a terminal on this computer to open it again.'));
        }
        function failed() {
          status.textContent = 'Opening failed.';
          detail.textContent = 'Reload this page to try again.';
        }
        var key = '';
        try { key = window.localStorage.getItem(KEY) || ''; } catch (e) {}
        if (!key) { locked(); return; }
        var headers = {};
        headers[HEADER] = key;
        fetch(window.location.href, {
          cache: 'no-store',
          credentials: 'same-origin',
          headers: headers
        }).then(function (response) {
          // A page that moved: go there, and its own navigation proves itself the same way.
          if (response.redirected) { window.location.replace(response.url); return; }
          if (response.headers.get(SHELL) || response.status === 401 || response.status === 403) { locked(); return; }
          var type = response.headers.get('Content-Type') || '';
          if (!response.ok || type.indexOf('text/html') !== 0) { failed(); return; }
          return response.text().then(function (html) {
            document.open();
            document.write(html);
            document.close();
          });
        }).catch(failed);
      }());
    </script>
  </body>
</html>
`;

/**
 * The shell's response headers. Its policy is the policy of the page it will
 * write into this window (the document keeps the shell's policy), so the
 * caller passes that page's own.
 */
export function dashboardUnlockShellHeaders(contentSecurityPolicy: string): Record<string, string> {
  return {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
    'Referrer-Policy': 'no-referrer',
    'X-Frame-Options': 'DENY',
    'Content-Security-Policy': contentSecurityPolicy,
    [DASHBOARD_UNLOCK_SHELL_HEADER]: '1',
  };
}
