import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

// ---------------------------------------------------------------------------
// The relay page is the ONE redirect_uri registered with Google and Dropbox, so
// it is reachable by anyone who can craft a query string, and it turns that one
// registered URI into "any origin the state names". That is a real cost, not a
// technicality: an attacker can run the publisher's own OAuth app against a
// victim and receive the code at their own origin (docs/ops/OAUTH_RELAY.md).
//
// Three properties keep the page as narrow as it can be, and these tests hold
// all three: it only bounces to an origin the state named, in a shape this file
// enumerates; it forwards nothing but the four OAuth parameters; and a
// destination that is not loopback is never auto-followed — the person is shown
// the origin and has to choose it.
//
// The page ships as static HTML with an inline script, so the tests load the
// real file and run the real script rather than a copy that can drift.
// ---------------------------------------------------------------------------

const RELAY_PATH = join(import.meta.dir, '..', 'relay', 'oauth', 'callback', 'index.html');
const HTML = readFileSync(RELAY_PATH, 'utf8');

interface RelayPlan {
  ok: boolean;
  reason?: string;
  message?: string;
  origin?: string;
  host?: string;
  source?: string;
  loopback?: boolean;
  url?: string;
}

interface RelayModule {
  STATE_VERSION: number;
  ALLOWED_SOURCES: string[];
  PASSTHROUGH_KEYS: string[];
  MAX_STATE_LENGTH: number;
  decodeStatePayload(state: unknown): Record<string, unknown> | null;
  parseOrigin(value: unknown): { origin: string; host: string; port: string; loopback: boolean } | null;
  isAllowedSource(source: unknown): boolean;
  planRelay(query: string): RelayPlan;
  boot(doc: unknown, loc: unknown, win?: unknown): RelayPlan;
}

function section(tag: 'script' | 'style'): string {
  const match = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`).exec(HTML);
  if (!match) throw new Error(`The relay page has no <${tag}> block.`);
  return match[1]!;
}

/**
 * Run the page's own script with `globalThis`, `document`, and `location`
 * shadowed: the script attaches its functions to the object it is handed and
 * skips its own boot when there is no document, so the test drives `boot`
 * explicitly against a stub instead of racing a real navigation.
 */
function loadRelay(): RelayModule {
  const scope = {} as { OlympusOAuthRelay: RelayModule };
  new Function('globalThis', 'window', 'document', 'location', section('script'))(scope, undefined, undefined, undefined);
  return scope.OlympusOAuthRelay;
}

const relay = loadRelay();

const base64Url = (value: string): string => Buffer.from(value, 'utf8').toString('base64url');

function state(payload: Record<string, unknown>, signature = 'c2lnbmF0dXJl'): string {
  return `${base64Url(JSON.stringify(payload))}.${signature}`;
}

const NONCE = 'n0Ncevaluewith32chars0123456789ab';

function validState(overrides: Record<string, unknown> = {}): string {
  return state({ v: 1, origin: 'https://dash.example.com', source: 'gmail', nonce: NONCE, iat: 1_800_000_000, ...overrides });
}

describe('OAuth relay page shape', () => {
  test('is self-contained: no external script, style, image, or form target', () => {
    expect(HTML).not.toMatch(/<script[^>]+src=/i);
    expect(HTML).not.toMatch(/<link[^>]+rel=["']?stylesheet/i);
    expect(HTML).not.toMatch(/<img\b/i);
    expect(HTML).not.toMatch(/<iframe\b/i);
    expect(HTML).not.toMatch(/<form\b/i);
    // Inline handlers would need 'unsafe-inline' or their own hashes; the page
    // wires the cancel control with addEventListener instead.
    expect(HTML).not.toMatch(/<[^>]+\son[a-z]+\s*=/i);
  });

  test('the content security policy pins the exact inline script and style', () => {
    const policy = /content="(default-src[^"]+)"/.exec(HTML)?.[1];
    expect(policy).toBeDefined();
    const digest = (text: string) => createHash('sha256').update(text, 'utf8').digest('base64');
    // A silent mismatch here is a page that does nothing at all in a real browser.
    expect(policy).toContain(`script-src 'sha256-${digest(section('script'))}'`);
    expect(policy).toContain(`style-src 'sha256-${digest(section('style'))}'`);
    expect(policy).toContain("default-src 'none'");
    expect(policy).toContain("connect-src 'none'");
    expect(policy).toContain("base-uri 'none'");
    expect(policy).toContain("form-action 'none'");
  });

  test('tells the person what is happening and stores nothing', () => {
    expect(HTML).toContain('Returning you to your Olympus dashboard');
    expect(HTML).toMatch(/id="continue"/);
    expect(HTML).not.toMatch(/localStorage|sessionStorage|indexedDB|document\.cookie|fetch\(|XMLHttpRequest/);
    // No deferred navigation: an interstitial that redirects itself after a
    // pause is not an interstitial.
    expect(HTML).not.toMatch(/setTimeout|setInterval|requestAnimationFrame/);
    expect(HTML).not.toMatch(/http-equiv=["']?refresh/i);
  });

  test('the allowlist is exactly the four sources Olympus relays', () => {
    expect(relay.ALLOWED_SOURCES).toEqual(['gmail', 'google-drive', 'dropbox', 'x']);
    expect(relay.PASSTHROUGH_KEYS).toEqual(['code', 'state', 'error', 'error_description']);
    expect(relay.STATE_VERSION).toBe(1);
  });
});

describe('relay plan: accepted flow', () => {
  test('a valid state redirects to the dashboard the state named', () => {
    const value = validState();
    const plan = relay.planRelay(`?code=auth-code-123&state=${encodeURIComponent(value)}`);
    expect(plan.ok).toBe(true);
    expect(plan.origin).toBe('https://dash.example.com');
    expect(plan.source).toBe('gmail');
    expect(plan.url).toBe(`https://dash.example.com/oauth/callback/gmail?code=auth-code-123&state=${value}`);
  });

  test.each([
    ['loopback IPv4 with a port', 'http://127.0.0.1:8787', true],
    ['loopback name with a port', 'http://localhost:3000', true],
    ['loopback IPv6 with a port', 'http://[::1]:8787', true],
    ['loopback over TLS', 'https://localhost:8443', true],
    ['loopback IPv4 over TLS', 'https://127.0.0.1:8443', true],
    ['a public dashboard host', 'https://olympus.example.org', false],
    ['a public host with a port', 'https://olympus.example.org:8443', false],
  ])('accepts %s', (_label, origin, loopback) => {
    const plan = relay.planRelay(`?code=c&state=${encodeURIComponent(validState({ origin }))}`);
    expect(plan.ok).toBe(true);
    expect(plan.url!.startsWith(`${origin}/oauth/callback/gmail?`)).toBe(true);
    // The loopback branch is what decides auto-redirect vs. interstitial, so it
    // is part of the plan rather than something the page re-derives.
    expect(plan.loopback).toBe(loopback);
    expect(relay.parseOrigin(origin)!.loopback).toBe(loopback);
  });

  test.each(['gmail', 'google-drive', 'dropbox', 'x'])('relays the %s source', (source) => {
    const plan = relay.planRelay(`?code=c&state=${encodeURIComponent(validState({ source }))}`);
    expect(plan.ok).toBe(true);
    expect(plan.url).toContain(`/oauth/callback/${source}?`);
  });

  test('forwards only the four OAuth parameters, dropping everything else', () => {
    const value = validState();
    const plan = relay.planRelay(
      `?code=c&state=${encodeURIComponent(value)}&scope=drive.readonly&authuser=0&prompt=consent&hd=example.com`,
    );
    expect(plan.ok).toBe(true);
    expect([...new URL(plan.url!).searchParams.keys()]).toEqual(['code', 'state']);
  });

  test('forwards a provider error instead of swallowing it', () => {
    const value = validState({ source: 'dropbox' });
    const plan = relay.planRelay(
      `?error=access_denied&error_description=${encodeURIComponent('The user denied the request')}&state=${encodeURIComponent(value)}`,
    );
    expect(plan.ok).toBe(true);
    const forwarded = new URL(plan.url!);
    expect(forwarded.pathname).toBe('/oauth/callback/dropbox');
    expect(forwarded.searchParams.get('error')).toBe('access_denied');
    expect(forwarded.searchParams.get('error_description')).toBe('The user denied the request');
    expect(forwarded.searchParams.get('code')).toBeNull();
  });

  test('preserves parameter values exactly, including characters that need encoding', () => {
    const value = validState();
    const code = '4/0Ab_c-d/e f+g&h';
    const plan = relay.planRelay(`?code=${encodeURIComponent(code)}&state=${encodeURIComponent(value)}`);
    expect(new URL(plan.url!).searchParams.get('code')).toBe(code);
    expect(new URL(plan.url!).searchParams.get('state')).toBe(value);
  });
});

describe('relay plan: refusals', () => {
  test('refuses when the response carries no state', () => {
    expect(relay.planRelay('?code=c')).toMatchObject({ ok: false, reason: 'missing_state' });
    expect(relay.planRelay('')).toMatchObject({ ok: false, reason: 'missing_state' });
    expect(relay.planRelay('?code=c&state=')).toMatchObject({ ok: false, reason: 'missing_state' });
  });

  test('refuses an oversized state before decoding it', () => {
    const oversized = `${'A'.repeat(relay.MAX_STATE_LENGTH)}.c2ln`;
    expect(relay.planRelay(`?code=c&state=${oversized}`)).toMatchObject({ ok: false, reason: 'state_too_large' });
  });

  test.each([
    ['not two segments', 'onlyonesegment'],
    ['three segments', `${base64Url('{"v":1}')}.a.b`],
    ['an empty signature segment', `${base64Url('{"v":1}')}.`],
    ['non-base64url characters', `${base64Url('{"v":1}')}!.c2ln`],
    ['undecodable payload bytes', 'AAAA.c2ln'],
  ])('refuses a state that is %s', (_label, value) => {
    expect(relay.planRelay(`?code=c&state=${encodeURIComponent(value)}`)).toMatchObject({ ok: false, reason: 'invalid_state' });
  });

  test.each([
    ['a JSON array', state([1, 2, 3] as unknown as Record<string, unknown>)],
    ['a wrong version', state({ v: 2, origin: 'https://dash.example.com', source: 'gmail', nonce: NONCE, iat: 1 })],
    ['a missing nonce', state({ v: 1, origin: 'https://dash.example.com', source: 'gmail', iat: 1 })],
    ['a short nonce', state({ v: 1, origin: 'https://dash.example.com', source: 'gmail', nonce: 'short', iat: 1 })],
    ['a non-numeric iat', state({ v: 1, origin: 'https://dash.example.com', source: 'gmail', nonce: NONCE, iat: 'now' })],
    ['a non-string origin', state({ v: 1, origin: 42, source: 'gmail', nonce: NONCE, iat: 1 })],
  ])('refuses a state payload with %s', (_label, value) => {
    expect(relay.planRelay(`?code=c&state=${encodeURIComponent(value)}`)).toMatchObject({ ok: false, reason: 'invalid_state' });
  });

  test.each([
    ['plain http on a public host', 'http://dash.example.com'],
    ['http on a public host with a port', 'http://dash.example.com:8080'],
    ['a path', 'https://dash.example.com/oauth'],
    ['a trailing slash', 'https://dash.example.com/'],
    ['a query string', 'https://dash.example.com?next=1'],
    ['a fragment', 'https://dash.example.com#x'],
    ['userinfo', 'https://user:password@dash.example.com'],
    ['a bare username', 'https://user@dash.example.com'],
    ['uppercase characters', 'https://Dash.Example.com'],
    ['a protocol-relative address', '//evil.example.com'],
    ['a javascript scheme', 'javascript:alert(1)'],
    ['a data scheme', 'data:text/html,hello'],
    ['a file scheme', 'file:///etc/passwd'],
    ['the explicit default TLS port', 'https://dash.example.com:443'],
    ['a single-label host', 'https://dashboard'],
    ['a bare IPv4 address over TLS', 'https://203.0.113.4'],
    ['a non-loopback IPv6 address', 'https://[2001:db8::1]'],
    ['a port out of range', 'https://dash.example.com:70000'],
    ['a trailing dot host', 'https://dash.example.com.'],
    ['trailing whitespace', 'https://dash.example.com '],
    ['an embedded newline', 'https://dash.example.com\nX'],
    ['an empty string', ''],
    ['an oversized origin', `https://${'a'.repeat(250)}.example.com`],
    ['a non-ASCII lookalike host', 'https://\u0430\u0440\u0440\u04cf\u0435.com'],
  ])('refuses an origin with %s', (_label, origin) => {
    expect(relay.parseOrigin(origin)).toBeNull();
    expect(relay.planRelay(`?code=c&state=${encodeURIComponent(validState({ origin }))}`)).toMatchObject({
      ok: false,
      reason: 'invalid_origin',
    });
  });

  test.each(['google-docs', 'Gmail', 'gmail ', '../gmail', 'gmail/../x', '', 'notion'])(
    'refuses the source %p',
    (source) => {
      expect(relay.isAllowedSource(source)).toBe(false);
      expect(relay.planRelay(`?code=c&state=${encodeURIComponent(validState({ source }))}`)).toMatchObject({
        ok: false,
        reason: 'invalid_source',
      });
    },
  );

  test.each([
    ['neither parameter', ''],
    ['an empty code', '&code='],
    ['an empty error', '&error='],
    ['both empty', '&code=&error='],
  ])('refuses a response carrying %s', (_label, extra) => {
    expect(relay.planRelay(`?state=${encodeURIComponent(validState())}${extra}`)).toMatchObject({
      ok: false,
      reason: 'missing_result',
    });
  });

  test('does not forward an empty parameter alongside a real one', () => {
    const plan = relay.planRelay(`?code=real&error=&state=${encodeURIComponent(validState())}`);
    expect(plan.ok).toBe(true);
    expect([...new URL(plan.url!).searchParams.keys()]).toEqual(['code', 'state']);
  });

  test('refuses an oversized authorization code', () => {
    expect(relay.planRelay(`?code=${'c'.repeat(4097)}&state=${encodeURIComponent(validState())}`)).toMatchObject({
      ok: false,
      reason: 'parameter_too_large',
    });
  });

  test('every refusal carries a human explanation', () => {
    const queries = ['?code=c', `?code=c&state=${encodeURIComponent(validState({ origin: 'http://evil.example.com' }))}`];
    for (const query of queries) {
      const plan = relay.planRelay(query);
      expect(plan.ok).toBe(false);
      expect(typeof plan.message).toBe('string');
      expect(plan.message!.length).toBeGreaterThan(20);
    }
  });
});

describe('page behaviour', () => {
  interface StubElement {
    textContent: string;
    href: string;
    hidden: boolean;
    className: string;
    listeners: Array<() => void>;
    addEventListener(type: string, handler: () => void): void;
  }

  function element(hidden: boolean): StubElement {
    const listeners: Array<() => void> = [];
    return {
      textContent: '',
      href: '',
      hidden,
      className: '',
      listeners,
      addEventListener(_type: string, handler: () => void) {
        listeners.push(handler);
      },
    };
  }

  function stubDocument() {
    const elements: Record<string, StubElement> = {
      status: element(false),
      detail: element(false),
      destination: element(true),
      continue: element(true),
      cancel: element(true),
    };
    return { elements, getElementById: (id: string) => elements[id] };
  }

  function run(query: string, framed = false) {
    const doc = stubDocument();
    const replaced: string[] = [];
    const top = {};
    const win = framed ? { top, self: {} } : { top, self: top };
    const plan = relay.boot(doc, { search: query, replace: (url: string) => replaced.push(url) }, win);
    return { doc, replaced, plan };
  }

  test('a loopback destination continues on its own', () => {
    const value = validState({ origin: 'http://127.0.0.1:8787', source: 'dropbox' });
    const { doc, replaced, plan } = run(`?code=c&state=${encodeURIComponent(value)}`);
    expect(plan.ok).toBe(true);
    expect(plan.loopback).toBe(true);
    expect(replaced).toEqual([plan.url!]);
    // The fallback link still works if the scripted navigation is blocked.
    expect(doc.elements.continue!.hidden).toBe(false);
    expect(doc.elements.continue!.href).toBe(plan.url!);
    expect(plan.url!.startsWith('http://127.0.0.1:8787/oauth/callback/dropbox?')).toBe(true);
  });

  // The defence that matters. An attacker who forges a state picks the
  // destination, so a destination that is not the person's own machine is never
  // followed without them seeing it and choosing it.
  test('a remote destination is never auto-followed', () => {
    const value = validState({ origin: 'https://attacker.example', source: 'dropbox' });
    const { doc, replaced, plan } = run(`?code=c&state=${encodeURIComponent(value)}`);
    expect(plan.ok).toBe(true);
    expect(plan.loopback).toBe(false);
    expect(replaced).toEqual([]);
    expect(doc.elements.status!.textContent).toBe('Olympus is returning you to attacker.example');
    expect(doc.elements.destination!.textContent).toBe('https://attacker.example');
    expect(doc.elements.destination!.hidden).toBe(false);
    expect(doc.elements.continue!.hidden).toBe(false);
    expect(doc.elements.continue!.href).toBe(plan.url!);
    expect(doc.elements.continue!.textContent).toBe('Continue');
    expect(doc.elements.cancel!.hidden).toBe(false);
    expect(doc.elements.detail!.textContent).toContain('Continue only if that is your own Olympus dashboard');
  });

  test('cancelling the interstitial sends nothing and says so', () => {
    const value = validState({ origin: 'https://attacker.example' });
    const { doc, replaced } = run(`?code=c&state=${encodeURIComponent(value)}`);
    expect(doc.elements.cancel!.listeners).toHaveLength(1);
    doc.elements.cancel!.listeners[0]!();
    expect(replaced).toEqual([]);
    expect(doc.elements.continue!.hidden).toBe(true);
    expect(doc.elements.cancel!.hidden).toBe(true);
    expect(doc.elements.destination!.hidden).toBe(true);
    expect(doc.elements.status!.textContent).toBe('Nothing was sent.');
    expect(doc.elements.detail!.textContent).toContain('https://attacker.example');
  });

  test('a provider error on a remote destination also stops at the interstitial', () => {
    const value = validState({ origin: 'https://olympus.example.org' });
    const { doc, replaced } = run(`?error=access_denied&state=${encodeURIComponent(value)}`);
    expect(replaced).toEqual([]);
    expect(doc.elements.cancel!.hidden).toBe(false);
  });

  // Headers are the host's promise; the page keeps its own copy of it.
  test('refuses to run inside another site\'s frame, valid state or not', () => {
    const value = validState({ origin: 'http://127.0.0.1:8787' });
    const { doc, replaced, plan } = run(`?code=c&state=${encodeURIComponent(value)}`, true);
    expect(plan.ok).toBe(false);
    expect(plan.reason).toBe('framed');
    expect(replaced).toEqual([]);
    expect(doc.elements.continue!.hidden).toBe(true);
    expect(doc.elements.status!.textContent).toContain('could not be returned');
    expect(doc.elements.detail!.textContent).toContain('frame');
  });

  // A lookalike host must not be able to launder itself through the display.
  test('shows a punycode host as punycode, never decoded', () => {
    const { doc } = run(`?code=c&state=${encodeURIComponent(validState({ origin: 'https://xn--80ak6aa92e.com' }))}`);
    expect(doc.elements.status!.textContent).toBe('Olympus is returning you to xn--80ak6aa92e.com');
    expect(doc.elements.destination!.textContent).toBe('https://xn--80ak6aa92e.com');
    expect(doc.elements.destination!.textContent).not.toMatch(/[^\u0000-\u007f]/);
  });

  test('a refused callback navigates nowhere and says why', () => {
    const value = validState({ origin: 'https://evil.example.com/steal' });
    const { doc, replaced, plan } = run(`?code=c&state=${encodeURIComponent(value)}`);
    expect(plan.ok).toBe(false);
    expect(replaced).toEqual([]);
    expect(doc.elements.continue!.hidden).toBe(true);
    expect(doc.elements.continue!.href).toBe('');
    expect(doc.elements.cancel!.hidden).toBe(true);
    expect(doc.elements.destination!.hidden).toBe(true);
    expect(doc.elements.status!.textContent).toContain('could not be returned');
    expect(doc.elements.detail!.textContent).toContain('will not redirect to');
  });
});

describe('hosting headers', () => {
  const HEADERS = readFileSync(join(import.meta.dir, '..', 'relay', '_headers'), 'utf8');

  function headerValue(name: string): string {
    const match = new RegExp(`^\\s+${name}: (.+)$`, 'm').exec(HEADERS);
    if (!match) throw new Error(`relay/_headers does not set ${name}.`);
    return match[1]!.trim();
  }

  test('applies to every path', () => {
    expect(HEADERS).toMatch(/^\/\*$/m);
  });

  // Two copies of one policy is a drift bug waiting to happen, so the test owns
  // the relationship: identical directives, plus the one a meta tag cannot say.
  test('the header policy matches the meta policy plus frame-ancestors', () => {
    const meta = /content="(default-src[^"]+)"/.exec(HTML)?.[1];
    expect(meta).toBeDefined();
    expect(headerValue('Content-Security-Policy')).toBe(`${meta}; frame-ancestors 'none'`);
  });

  test('sends the transport and sniffing headers, without committing to preload', () => {
    expect(headerValue('Strict-Transport-Security')).toBe('max-age=63072000; includeSubDomains');
    expect(headerValue('Strict-Transport-Security')).not.toContain('preload');
    expect(headerValue('X-Content-Type-Options')).toBe('nosniff');
    expect(headerValue('X-Frame-Options')).toBe('DENY');
    // This page's own URL carries the authorization code.
    expect(headerValue('Referrer-Policy')).toBe('no-referrer');
    expect(headerValue('Cross-Origin-Opener-Policy')).toBe('same-origin');
  });

  test('the relay directory is a site root with no build step', () => {
    // Cloudflare Pages serves relay/ as the root, so this path is the callback.
    expect(existsSync(join(import.meta.dir, '..', 'relay', 'oauth', 'callback', 'index.html'))).toBe(true);
    // The GitHub Pages workflow was replaced by Cloudflare Pages; it must not
    // come back and start publishing this repository from a second place.
    expect(existsSync(join(import.meta.dir, '..', '.github', 'workflows', 'pages.yml'))).toBe(false);
  });
});
