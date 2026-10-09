// Connect pages (docs/design/connect-pages.md): a keyed source (Readwise,
// X bookmarks) connects from ChatGPT through a one-time link to a key-entry
// page the owner's engine serves. The key is encrypted in the page to a
// one-view engine key and posted back as ciphertext.
//
// Under test:
// - the `key_page` hand-off kind: single view, single submission, expiry of
//   both, another install's link, replay, cross-site posts;
// - the real in-page script (connect-relay/shared/connect-page.ts) sealing to
//   the engine and the engine opening it, and every tampered variant failing;
// - the decrypt-and-connect path into the dashboard's own connect routes;
// - that no key value appears in any response, tool result or log line.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import {
  CONNECT_PAGE_SCRIPT,
  CONNECT_PAGE_SCRIPT_HASH,
  connectPageContext,
} from '../connect-relay/shared/connect-page.ts';
import { createResponsePolicies } from '../connect-relay/server/response-policy.ts';
import { submitThroughScript } from '../connect-relay/test/fixtures/connect-page-browser.ts';
import { createChatGptHandoffHandler, createChatGptHandoffs, type KeyPageOutcome } from '../src/workers/chatgpt/handoff.ts';
import { createConnectPageKey, openConnectPageSubmission, toBase64Url, type KeyPageSource } from '../src/workers/chatgpt/connect-page.ts';
import { createKeyPageConnector } from '../src/workers/chatgpt/setup-backend.ts';
import { callSetupTool, type ChatGptSetupBackend } from '../src/workers/chatgpt/setup-tools.ts';
import type { HandoffTarget } from '../src/workers/chatgpt/handoff.ts';

const INSTALL_ID = 'abcdefghijklmnopqrstuvwxyz234567';
const OTHER_INSTALL = 'zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz';
const RELAY_ORIGIN = 'https://mcp.olympusplugin.ai';
const ENGINE = 'http://127.0.0.1:8010';
const SECRET = 'SENTINEL_READWISE_TOKEN_7f3a';
const X_SECRET = 'SENTINEL_X_CLIENT_SECRET_7f3a';
const SENTINEL_PATTERN = /SENTINEL_[A-Z_]+_7f3a/;
const FORM = { 'content-type': 'application/x-www-form-urlencoded' };

/* ------------------------------------------------------------------ */
/* Log capture: nothing anywhere may print a key                       */
/* ------------------------------------------------------------------ */

const logged: string[] = [];
const originals: Partial<Record<'log' | 'info' | 'warn' | 'error' | 'debug', (...args: unknown[]) => void>> = {};
beforeEach(() => {
  logged.length = 0;
  for (const level of ['log', 'info', 'warn', 'error', 'debug'] as const) {
    originals[level] = console[level];
    console[level] = (...args: unknown[]) => { logged.push(args.map((arg) => (arg instanceof Error ? `${arg.message} ${arg.stack}` : typeof arg === 'string' ? arg : JSON.stringify(arg))).join(' ')); };
  }
});
afterEach(() => {
  for (const level of ['log', 'info', 'warn', 'error', 'debug'] as const) console[level] = originals[level]!;
  expect(logged.join('\n')).not.toMatch(SENTINEL_PATTERN);
});

function idOf(url: string): string {
  return new URL(url).pathname.slice('/go/'.length);
}

function harness(options: { now?: () => number; outcome?: (source: KeyPageSource, fields: Record<string, string>) => Promise<KeyPageOutcome> } = {}) {
  const handoffs = createChatGptHandoffs(options.now ? { now: options.now } : {});
  const submissions: Array<{ source: KeyPageSource; fields: Record<string, string> }> = [];
  const handler = createChatGptHandoffHandler(handoffs, {
    publicOrigin: () => RELAY_ORIGIN,
    xCallbackUri: () => `${ENGINE}/oauth/callback/x`,
    submit: async (source, fields) => {
      submissions.push({ source, fields });
      return options.outcome ? options.outcome(source, fields) : { status: 'connected' };
    },
  });
  const mint = (source: KeyPageSource = 'readwise', install = INSTALL_ID) => handoffs.mint(install, { kind: 'key_page', source }).id;
  const get = (id: string) => handler(new Request(`${ENGINE}/go/${id}`, { headers: { 'x-olympus-relay': 's' } }));
  const post = (id: string, body: string, headers: Record<string, string> = { ...FORM, origin: 'null' }) =>
    handler(new Request(`${ENGINE}/go/${id}`, { method: 'POST', headers, body }));
  return { handoffs, handler, submissions, mint, get, post };
}

async function expectNoSecret(response: Response): Promise<string> {
  const text = await response.text();
  expect(text).not.toMatch(SENTINEL_PATTERN);
  for (const [, value] of response.headers) expect(value).not.toMatch(SENTINEL_PATTERN);
  return text;
}

/* ------------------------------------------------------------------ */

describe('key page hand-off kind', () => {
  test('a key page is served once, with a pinned script, a sandbox and the link as its only form target', async () => {
    const h = harness();
    const id = h.mint('readwise');
    const page = await h.get(id);
    expect(page.status).toBe(200);
    expect(page.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(page.headers.get('cache-control')).toBe('no-store');
    expect(page.headers.get('referrer-policy')).toBe('no-referrer');
    expect(page.headers.get('x-frame-options')).toBe('DENY');
    const csp = page.headers.get('content-security-policy')!;
    expect(csp).toContain('sandbox allow-scripts allow-forms');
    expect(csp).not.toContain('allow-same-origin');
    expect(csp).toContain(`script-src ${CONNECT_PAGE_SCRIPT_HASH}`);
    expect(csp).toContain(`form-action ${RELAY_ORIGIN}`);
    expect(csp).toContain("default-src 'none'");
    const html = await page.text();
    // The one script on the page is the pinned one, byte for byte.
    const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((match) => match[1]!);
    expect(scripts).toEqual([CONNECT_PAGE_SCRIPT]);
    expect(`'sha256-${createHash('sha256').update(scripts[0]!).digest('base64')}'`).toBe(CONNECT_PAGE_SCRIPT_HASH);
    expect(html).toContain(`action="${RELAY_ORIGIN}/go/${id}"`);
    expect(html).not.toMatch(/\bMac\b/);
    // A second view (a reload, or anyone else holding the link) is expired.
    const again = await h.get(id);
    expect(again.status).toBe(404);
    expect(await again.text()).toContain('expired or was already used');
  });

  test('the relay pins the same script on /go/ answers, posts only back to /go/, and keeps the sandbox', () => {
    const policy = createResponsePolicies({ relayOrigin: RELAY_ORIGIN, enginePort: 8010 }).handoff;
    expect(policy.csp).toContain(`script-src ${CONNECT_PAGE_SCRIPT_HASH}`);
    expect(policy.csp).toContain(`form-action ${RELAY_ORIGIN}/go/`);
    expect(policy.csp).toMatch(/^sandbox allow-scripts allow-forms;/);
    expect(policy.csp).not.toContain('allow-same-origin');
    expect(policy.csp).not.toMatch(/script-src[^;]*unsafe/);
    // Other browser routes are unchanged: no script at all.
    expect(createResponsePolicies({ relayOrigin: RELAY_ORIGIN, enginePort: 8010 }).browser.csp).not.toContain('allow-scripts');
  });

  test('the X page names the callback address its own app must list', async () => {
    const h = harness();
    const html = await (await h.get(h.mint('x'))).text();
    expect(html).toContain(`${ENGINE}/oauth/callback/x`);
    expect(html).toContain('data-field="client_id"');
    expect(html).toContain('data-field="client_secret"');
  });

  test('round trip: the page script seals, the engine opens and connects, exactly once', async () => {
    const h = harness();
    const id = h.mint('readwise');
    const html = await (await h.get(id)).text();
    const sent = await submitThroughScript(html, { token: SECRET });
    expect(sent.clearedInputs).toBe(true);
    expect(sent.actionUrl).toBe(`${RELAY_ORIGIN}/go/${id}`);
    // What leaves the browser, and so what the relay sees, carries no key.
    expect(sent.body).not.toContain(SECRET);
    expect(decodeURIComponent(sent.body)).not.toContain(SECRET);
    const done = await h.post(id, sent.body);
    expect(done.status).toBe(200);
    expect(await expectNoSecret(done)).toContain('Readwise is connected');
    expect(h.submissions).toEqual([{ source: 'readwise', fields: { token: SECRET } }]);
    // Replay of the same ciphertext: spent.
    const replay = await h.post(id, sent.body);
    expect(replay.status).toBe(404);
    await expectNoSecret(replay);
    expect(h.submissions).toHaveLength(1);
  });

  test('X: both app values arrive, and the page continues to X\'s sign-in', async () => {
    const h = harness({ outcome: async () => ({ status: 'continue', location: 'https://x.com/i/oauth2/authorize?client_id=c&state=s' }) });
    const id = h.mint('x');
    const sent = await submitThroughScript(await (await h.get(id)).text(), { client_id: 'client-id-1', client_secret: X_SECRET });
    const done = await h.post(id, sent.body);
    expect(done.status).toBe(200);
    const text = await expectNoSecret(done);
    expect(text).toContain('href="https://x.com/i/oauth2/authorize?client_id=c&amp;state=s"');
    expect(text).toContain('Continue to X');
    expect(h.submissions).toEqual([{ source: 'x', fields: { client_id: 'client-id-1', client_secret: X_SECRET } }]);
  });

  test('a POST before the page was viewed opens nothing and does not spend the link', async () => {
    const h = harness();
    const id = h.mint('readwise');
    expect((await h.post(id, 'epk=a&iv=b&ct=c')).status).toBe(404);
    expect((await h.get(id)).status).toBe(200);
  });

  test('a cross-site post and a wrong content type are refused without spending the page', async () => {
    const h = harness();
    const id = h.mint('readwise');
    const sent = await submitThroughScript(await (await h.get(id)).text(), { token: SECRET });
    expect((await h.post(id, sent.body, { ...FORM, origin: 'https://evil.example' })).status).toBe(403);
    expect((await h.post(id, sent.body, { 'content-type': 'text/plain', origin: 'null' })).status).toBe(415);
    expect((await h.post(id, sent.body, { 'content-type': 'application/json', origin: 'null' })).status).toBe(415);
    expect(h.submissions).toHaveLength(0);
    // The relay's own origin is the page's origin when not sandboxed; accepted.
    expect((await h.post(id, sent.body, { ...FORM, origin: RELAY_ORIGIN })).status).toBe(200);
    expect(h.submissions).toHaveLength(1);
  });

  test('an oversized body is refused', async () => {
    const h = harness();
    const id = h.mint('readwise');
    await h.get(id);
    expect((await h.post(id, `ct=${'a'.repeat(9000)}`)).status).toBe(413);
  });

  test('expiry: an unviewed link after ten minutes, and a viewed page after ten more', async () => {
    let now = 1_000_000;
    const h = harness({ now: () => now });
    const stale = h.mint('readwise');
    now += 10 * 60_000 + 1;
    expect((await h.get(stale)).status).toBe(404);

    const id = h.mint('readwise');
    const html = await (await h.get(id)).text();
    const sent = await submitThroughScript(html, { token: SECRET });
    now += 10 * 60_000 + 1;
    expect((await h.post(id, sent.body)).status).toBe(404);
    expect(h.submissions).toHaveLength(0);
  });

  test('another install\'s link and a malformed id open nothing', async () => {
    const h = harness();
    const foreign = createChatGptHandoffs().mint(OTHER_INSTALL, { kind: 'key_page', source: 'readwise' }).id;
    expect((await h.get(foreign)).status).toBe(404);
    expect((await h.post(foreign, 'epk=a')).status).toBe(404);
    expect((await h.get('oly2g.not-a-link')).status).toBe(404);
    expect((await h.post('oly2g.not-a-link', 'epk=a')).status).toBe(404);
  });

  test('a sealed submission for one link cannot be replayed against another', async () => {
    const h = harness();
    const first = h.mint('readwise');
    const second = h.mint('readwise');
    const sentFirst = await submitThroughScript(await (await h.get(first)).text(), { token: SECRET });
    await h.get(second);
    const crossed = await h.post(second, sentFirst.body);
    expect(crossed.status).toBe(400);
    await expectNoSecret(crossed);
    expect(h.submissions).toHaveLength(0);
    // The failed attempt spent the second page; the first still opens once.
    expect((await h.post(second, sentFirst.body)).status).toBe(404);
    expect((await h.post(first, sentFirst.body)).status).toBe(200);
  });

  test('a page that is not linked to the relay serves nothing', async () => {
    const handoffs = createChatGptHandoffs();
    const handler = createChatGptHandoffHandler(handoffs, { publicOrigin: () => undefined, submit: async () => ({ status: 'connected' }) });
    const { id } = handoffs.mint(INSTALL_ID, { kind: 'key_page', source: 'readwise' });
    expect((await handler(new Request(`${ENGINE}/go/${id}`))).status).toBe(404);
  });

  test('a connector that throws with the key in its message shows a fixed sentence', async () => {
    const h = harness({ outcome: async (_source, fields) => { throw new Error(`provider said no to ${fields.token}`); } });
    const id = h.mint('readwise');
    const sent = await submitThroughScript(await (await h.get(id)).text(), { token: SECRET });
    const failed = await h.post(id, sent.body);
    expect(failed.status).toBe(502);
    expect(await expectNoSecret(failed)).toContain('could not connect Readwise');
  });
});

describe('sealing and opening', () => {
  async function sealed(source: KeyPageSource, fields: Record<string, string>) {
    const key = await createConnectPageKey();
    const html = `<form id="olympus-connect" data-key="${toBase64Url(key.publicKey)}" data-context="${connectPageContext('oly2g.id', source)}">${Object.keys(fields).map((name) => `<input data-field="${name}">`).join('')}</form>`;
    const sent = await submitThroughScript(html, fields);
    return { key, form: new URLSearchParams(sent.body) };
  }

  test('only the exact key, link, source and bytes open', async () => {
    const { key, form } = await sealed('readwise', { token: SECRET });
    expect(await openConnectPageSubmission({ key, linkId: 'oly2g.id', source: 'readwise', form })).toEqual({ token: SECRET });
    // Wrong engine key.
    expect(await openConnectPageSubmission({ key: await createConnectPageKey(), linkId: 'oly2g.id', source: 'readwise', form })).toBeUndefined();
    // Wrong link, wrong source.
    expect(await openConnectPageSubmission({ key, linkId: 'oly2g.other', source: 'readwise', form })).toBeUndefined();
    expect(await openConnectPageSubmission({ key, linkId: 'oly2g.id', source: 'x', form })).toBeUndefined();
    // A flipped ciphertext bit, a swapped page key, a missing part.
    const ct = Buffer.from(form.get('ct')!, 'base64url');
    ct[0] = ct[0]! ^ 1;
    const tampered = new URLSearchParams(form);
    tampered.set('ct', ct.toString('base64url'));
    expect(await openConnectPageSubmission({ key, linkId: 'oly2g.id', source: 'readwise', form: tampered })).toBeUndefined();
    const swapped = new URLSearchParams(form);
    swapped.set('epk', toBase64Url((await createConnectPageKey()).publicKey));
    expect(await openConnectPageSubmission({ key, linkId: 'oly2g.id', source: 'readwise', form: swapped })).toBeUndefined();
    const missing = new URLSearchParams(form);
    missing.delete('iv');
    expect(await openConnectPageSubmission({ key, linkId: 'oly2g.id', source: 'readwise', form: missing })).toBeUndefined();
  });

  test('a field set other than the source\'s own is refused', async () => {
    const extra = await sealed('readwise', { token: SECRET, other: 'x' });
    expect(await openConnectPageSubmission({ key: extra.key, linkId: 'oly2g.id', source: 'readwise', form: extra.form })).toBeUndefined();
    const short = await sealed('x', { client_id: 'c' });
    expect(await openConnectPageSubmission({ key: short.key, linkId: 'oly2g.id', source: 'x', form: short.form })).toBeUndefined();
  });

  test('the engine key pair is fresh per view and its private half cannot be exported', async () => {
    const a = await createConnectPageKey();
    const b = await createConnectPageKey();
    expect(a.publicKey).toHaveLength(65);
    expect(toBase64Url(a.publicKey)).not.toBe(toBase64Url(b.publicKey));
    expect(a.privateKey.extractable).toBe(false);
  });
});

describe('decrypt and connect', () => {
  function connector(answer: (path: string, body: Record<string, unknown>) => Response) {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    const connect = createKeyPageConnector({
      loopbackOrigin: ENGINE,
      workerFetch: async (request) => {
        const body = await request.json() as Record<string, unknown>;
        calls.push({ url: request.url, body });
        return answer(new URL(request.url).pathname, body);
      },
    });
    return { connect, calls };
  }

  test('Readwise goes to the dashboard\'s own API-key route', async () => {
    const { connect, calls } = connector(() => Response.json({ ok: true, source: 'readwise' }));
    expect(await connect('readwise', { token: SECRET })).toEqual({ status: 'connected' });
    expect(calls).toEqual([{ url: `${ENGINE}/dashboard/connect/api-key`, body: { source: 'readwise', api_key: SECRET } }]);
  });

  test('X goes to the dashboard\'s own OAuth start on the computer\'s address, and continues only to x.com', async () => {
    const { connect, calls } = connector(() => Response.json({ ok: true, authorization_url: 'https://x.com/i/oauth2/authorize?state=s' }));
    expect(await connect('x', { client_id: 'c', client_secret: X_SECRET })).toEqual({ status: 'continue', location: 'https://x.com/i/oauth2/authorize?state=s' });
    expect(calls).toEqual([{ url: `${ENGINE}/dashboard/connect/oauth/start`, body: { source: 'x', client_id: 'c', client_secret: X_SECRET } }]);
    const elsewhere = connector(() => Response.json({ ok: true, authorization_url: 'https://evil.example/authorize' }));
    expect(await elsewhere.connect('x', { client_id: 'c', client_secret: X_SECRET })).toEqual({ status: 'failed' });
  });

  test('worker refusals become fixed outcomes; their messages never pass', async () => {
    const refusal = (code: string) => connector(() => Response.json({ ok: false, error: { code, message: `bad ${SECRET}` } }, { status: 400 }));
    expect(await refusal('api_key_validation_failed').connect('readwise', { token: SECRET })).toEqual({ status: 'rejected' });
    expect(await refusal('model_setup_required').connect('readwise', { token: SECRET })).toEqual({ status: 'models_not_ready' });
    expect(await refusal('dashboard_account_cardinality_violation').connect('readwise', { token: SECRET })).toEqual({ status: 'already_connected' });
    expect(await refusal('something_else').connect('readwise', { token: SECRET })).toEqual({ status: 'failed' });
    expect(await refusal('oauth_client_secret_missing').connect('x', { client_id: 'c', client_secret: X_SECRET })).toEqual({ status: 'rejected' });
  });
});

describe('the connect tool', () => {
  function backend(minted: HandoffTarget[]): ChatGptSetupBackend {
    const handoffs = createChatGptHandoffs();
    return {
      async startOAuth() { throw new Error('not for keyed sources'); },
      handoffLink(target: HandoffTarget) {
        minted.push(target);
        const link = handoffs.mint(INSTALL_ID, target);
        return { url: `${RELAY_ORIGIN}/go/${link.id}`, expiresAt: link.expiresAt };
      },
    } as unknown as ChatGptSetupBackend;
  }

  test('Readwise and X get a one-time key page link; no key argument is accepted', async () => {
    for (const source of ['readwise', 'x'] as const) {
      const minted: HandoffTarget[] = [];
      const result = await callSetupTool('olympus_connect_source', { source }, backend(minted));
      expect(minted).toEqual([{ kind: 'key_page', source }]);
      const structured = result.structuredContent as { status: string; source: string; openUrl: string };
      expect(structured.status).toBe('open_link');
      expect(structured.source).toBe(source);
      expect(idOf(structured.openUrl)).toMatch(new RegExp(`^oly2g\\.${INSTALL_ID}\\.`));
      expect(JSON.stringify(result.content)).toContain('never in this chat');
      await expect(callSetupTool('olympus_connect_source', { source, api_key: SECRET }, backend([]))).rejects.toThrow();
    }
  });
});
