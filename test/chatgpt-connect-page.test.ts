// Connect pages (docs/design/connect-pages.md): a keyed source (Readwise,
// X bookmarks) connects from ChatGPT through a one-time link to a key-entry
// page. The engine answers the link with a descriptor (source and a one-view
// public key); the relay renders the page from its own fixed template. The
// key is encrypted in the page to the engine and posted back as ciphertext.
//
// Under test:
// - the `key_page` hand-off kind: single view, armed submissions, expiry of
//   both, another install's link, replay, cross-site posts, junk posts;
// - the descriptor's closed shape and the relay-owned template;
// - the real in-page script (connect-relay/shared/connect-page.ts) sealing to
//   the engine and the engine opening it, and every tampered variant failing;
// - the decrypt-and-connect path into the dashboard's own connect routes;
// - gating on the relay's capability;
// - that no key value appears in any response, tool result or log line.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import {
  CONNECT_PAGE_CAPABILITY,
  CONNECT_PAGE_DESCRIPTOR_TYPE,
  CONNECT_PAGE_SCRIPT,
  CONNECT_PAGE_SCRIPT_HASH,
  connectPageContext,
  connectPageCsp,
  isConnectPageSubmission,
  parseConnectPageDescriptor,
  renderConnectPage,
} from '../connect-relay/shared/connect-page.ts';
import { createResponsePolicies } from '../connect-relay/server/response-policy.ts';
import { submitThroughScript } from '../connect-relay/test/fixtures/connect-page-browser.ts';
import { RELAY_CONNECT_PAGE_CAPABILITY } from '../src/core/remote-access.ts';
import {
  createChatGptHandoffHandler,
  createChatGptHandoffs,
  MAX_FAILED_SUBMISSIONS,
  type HandoffTarget,
  type KeyPageOutcome,
} from '../src/workers/chatgpt/handoff.ts';
import { createConnectPageKey, openConnectPageSubmission, toBase64Url, type KeyPageSource } from '../src/workers/chatgpt/connect-page.ts';
import { createKeyPageConnector } from '../src/workers/chatgpt/setup-backend.ts';
import { callSetupTool, type ChatGptSetupBackend } from '../src/workers/chatgpt/setup-tools.ts';

const INSTALL_ID = 'abcdefghijklmnopqrstuvwxyz234567';
const OTHER_INSTALL = 'zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz';
const RELAY_ORIGIN = 'https://mcp.olympusplugin.ai';
const ENGINE = 'http://127.0.0.1:8010';
const SECRET = 'SENTINEL_READWISE_TOKEN_7f3a';
const X_SECRET = 'SENTINEL_X_CLIENT_SECRET_7f3a';
const SENTINEL_PATTERN = /SENTINEL_[A-Z_]+_7f3a/;
const FORM = { 'content-type': 'application/x-www-form-urlencoded' };
const SHAPED_KEY = 'B'.padEnd(87, 'A');

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
  /** What the relay does with the engine's answer: render its own template from the descriptor. */
  const page = async (id: string) => {
    const response = await get(id);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe(CONNECT_PAGE_DESCRIPTOR_TYPE);
    const descriptor = parseConnectPageDescriptor(await response.text());
    expect(descriptor).toBeDefined();
    return renderConnectPage({ descriptor: descriptor!, linkId: id, relayOrigin: RELAY_ORIGIN });
  };
  const post = (id: string, body: string, headers: Record<string, string> = { ...FORM, origin: 'null' }) =>
    handler(new Request(`${ENGINE}/go/${id}`, { method: 'POST', headers, body }));
  return { handoffs, handler, submissions, mint, get, page, post };
}

async function expectNoSecret(response: Response): Promise<string> {
  const text = await response.text();
  expect(text).not.toMatch(SENTINEL_PATTERN);
  for (const [, value] of response.headers) expect(value).not.toMatch(SENTINEL_PATTERN);
  return text;
}

/** A body in the exact submission shape that no engine key opens. */
async function junkSubmission(): Promise<string> {
  const other = await createConnectPageKey();
  const html = renderConnectPage({ descriptor: { v: 1, source: 'readwise', key: toBase64Url(other.publicKey) }, linkId: 'oly2g.junk', relayOrigin: RELAY_ORIGIN });
  return (await submitThroughScript(html, { token: 'junk' })).body;
}

/* ------------------------------------------------------------------ */

describe('key page hand-off kind', () => {
  test('a key-page link answers once, with a descriptor only: the source and a fresh public key', async () => {
    const h = harness();
    const id = h.mint('readwise');
    const first = await h.get(id);
    expect(first.status).toBe(200);
    expect(first.headers.get('content-type')).toBe(CONNECT_PAGE_DESCRIPTOR_TYPE);
    expect(first.headers.get('cache-control')).toBe('no-store');
    const text = await first.text();
    const body = JSON.parse(text) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(['key', 'source', 'v']);
    expect(body.source).toBe('readwise');
    expect(parseConnectPageDescriptor(text)).toEqual(body as never);
    // A second view (a reload, or anyone else holding the link) is expired.
    const again = await h.get(id);
    expect(again.status).toBe(404);
    expect(await again.text()).toContain('expired or was already used');
    // X's descriptor names the loopback callback its app must list.
    const x = JSON.parse(await (await h.get(h.mint('x'))).text()) as Record<string, unknown>;
    expect(x.callback).toBe(`${ENGINE}/oauth/callback/x`);
  });

  test('round trip: the relay-rendered page seals, the engine opens and connects, exactly once', async () => {
    const h = harness();
    const id = h.mint('readwise');
    const sent = await submitThroughScript(await h.page(id), { token: SECRET });
    expect(sent.clearedInputs).toBe(true);
    expect(sent.actionUrl).toBe(`${RELAY_ORIGIN}/go/${id}`);
    // What leaves the browser, and so what the relay sees, carries no key and has the one accepted shape.
    expect(sent.body).not.toContain(SECRET);
    expect(isConnectPageSubmission(sent.body)).toBe(true);
    const done = await h.post(id, sent.body);
    expect(done.status).toBe(200);
    expect(await expectNoSecret(done)).toContain('Readwise is connected');
    expect(h.submissions).toEqual([{ source: 'readwise', fields: { token: SECRET } }]);
    const replay = await h.post(id, sent.body);
    expect(replay.status).toBe(404);
    await expectNoSecret(replay);
    expect(h.submissions).toHaveLength(1);
  });

  test('X: both app values arrive, and the page continues to X\'s sign-in', async () => {
    const h = harness({ outcome: async () => ({ status: 'continue', location: 'https://x.com/i/oauth2/authorize?client_id=c&state=s' }) });
    const id = h.mint('x');
    const sent = await submitThroughScript(await h.page(id), { client_id: 'client-id-1', client_secret: X_SECRET });
    const done = await h.post(id, sent.body);
    expect(done.status).toBe(200);
    const text = await expectNoSecret(done);
    expect(text).toContain('href="https://x.com/i/oauth2/authorize?client_id=c&amp;state=s"');
    expect(done.headers.get('content-security-policy')).toContain("form-action 'none'");
    expect(h.submissions).toEqual([{ source: 'x', fields: { client_id: 'client-id-1', client_secret: X_SECRET } }]);
  });

  test('a POST before the page was viewed reads nothing and does not spend the link', async () => {
    const h = harness();
    const id = h.mint('readwise');
    expect((await h.post(id, await junkSubmission())).status).toBe(404);
    expect((await h.get(id)).status).toBe(200);
  });

  test('a cross-site post and a wrong content type are refused without spending the page; an absent Origin is let through', async () => {
    const h = harness();
    const id = h.mint('readwise');
    const sent = await submitThroughScript(await h.page(id), { token: SECRET });
    expect((await h.post(id, sent.body, { ...FORM, origin: 'https://evil.example' })).status).toBe(403);
    expect((await h.post(id, sent.body, { 'content-type': 'text/plain', origin: 'null' })).status).toBe(415);
    expect((await h.post(id, sent.body, { 'content-type': 'application/json', origin: 'null' })).status).toBe(415);
    expect(h.submissions).toHaveLength(0);
    // A non-browser client sends no Origin; what protects the page is the per-view key.
    expect((await h.post(id, sent.body, { ...FORM })).status).toBe(200);
    expect(h.submissions).toHaveLength(1);
  });

  test('the relay origin is accepted as the page origin', async () => {
    const h = harness();
    const id = h.mint('readwise');
    const sent = await submitThroughScript(await h.page(id), { token: SECRET });
    expect((await h.post(id, sent.body, { ...FORM, origin: RELAY_ORIGIN })).status).toBe(200);
  });

  test('an oversized body is refused without spending the page', async () => {
    const h = harness();
    const id = h.mint('readwise');
    const html = await h.page(id);
    expect((await h.post(id, `ct=${'a'.repeat(9000)}`)).status).toBe(413);
    expect(h.handoffs.isArmed(id)).toBe(true);
    const sent = await submitThroughScript(html, { token: SECRET });
    expect((await h.post(id, sent.body)).status).toBe(200);
  });

  test('junk that does not open does not spend the owner\'s page, up to a limit', async () => {
    const h = harness();
    const id = h.mint('readwise');
    const html = await h.page(id);
    const junk = await junkSubmission();
    expect((await h.post(id, junk)).status).toBe(400);
    const sent = await submitThroughScript(html, { token: SECRET });
    expect((await h.post(id, sent.body)).status).toBe(200);
    expect(h.submissions).toHaveLength(1);

    const spent = h.mint('readwise');
    await h.get(spent);
    for (let attempt = 0; attempt < MAX_FAILED_SUBMISSIONS; attempt += 1) expect((await h.post(spent, junk)).status).toBe(400);
    expect((await h.post(spent, junk)).status).toBe(404);
  });

  test('expiry: an unviewed link after ten minutes, and a viewed page after ten more', async () => {
    let now = 1_000_000;
    const h = harness({ now: () => now });
    const stale = h.mint('readwise');
    now += 10 * 60_000 + 1;
    expect((await h.get(stale)).status).toBe(404);

    const id = h.mint('readwise');
    const sent = await submitThroughScript(await h.page(id), { token: SECRET });
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
    const sentFirst = await submitThroughScript(await h.page(first), { token: SECRET });
    await h.get(second);
    const crossed = await h.post(second, sentFirst.body);
    expect(crossed.status).toBe(400);
    await expectNoSecret(crossed);
    expect(h.submissions).toHaveLength(0);
    expect((await h.post(first, sentFirst.body)).status).toBe(200);
  });

  test('an engine not linked to the relay serves nothing', async () => {
    const handoffs = createChatGptHandoffs();
    const handler = createChatGptHandoffHandler(handoffs, { publicOrigin: () => undefined, submit: async () => ({ status: 'connected' }) });
    const { id } = handoffs.mint(INSTALL_ID, { kind: 'key_page', source: 'readwise' });
    expect((await handler(new Request(`${ENGINE}/go/${id}`))).status).toBe(404);
  });

  test('a connector that throws with the key in its message shows a fixed sentence', async () => {
    const h = harness({ outcome: async (_source, fields) => { throw new Error(`provider said no to ${fields.token}`); } });
    const id = h.mint('readwise');
    const sent = await submitThroughScript(await h.page(id), { token: SECRET });
    const failed = await h.post(id, sent.body);
    expect(failed.status).toBe(502);
    expect(await expectNoSecret(failed)).toContain('could not connect Readwise');
  });
});

describe('the relay-owned page', () => {
  test('the page is the relay\'s template: fixed labels and fields, the one pinned script, an error shown until it runs', () => {
    const html = renderConnectPage({ descriptor: { v: 1, source: 'readwise', key: SHAPED_KEY }, linkId: 'oly2g.id', relayOrigin: RELAY_ORIGIN });
    const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((match) => match[1]!);
    expect(scripts).toEqual([CONNECT_PAGE_SCRIPT]);
    expect(`'sha256-${createHash('sha256').update(scripts[0]!).digest('base64')}'`).toBe(CONNECT_PAGE_SCRIPT_HASH);
    expect([...html.matchAll(/data-field="([a-z_]+)"/g)].map((match) => match[1])).toEqual(['token']);
    expect(html).toContain('Readwise access token');
    // No typed input has a name: its plain value is never part of a form post.
    expect(html).not.toMatch(/<input[^>]*data-field[^>]* name=/);
    // Without script: the button is disabled and the error is visible.
    expect(html).toContain('<button type="submit" id="olympus-connect-submit" disabled>');
    expect(html).toContain('<p id="olympus-connect-error">');
    expect(html).toContain(`action="${RELAY_ORIGIN}/go/oly2g.id"`);
    expect(html).toContain(`data-context="${connectPageContext('oly2g.id', 'readwise')}"`);
    expect(html).not.toMatch(/\bMac\b/);
    const x = renderConnectPage({ descriptor: { v: 1, source: 'x', key: SHAPED_KEY, callback: `${ENGINE}/oauth/callback/x` }, linkId: 'oly2g.id', relayOrigin: RELAY_ORIGIN });
    expect([...x.matchAll(/data-field="([a-z_]+)"/g)].map((match) => match[1])).toEqual(['client_id', 'client_secret']);
    expect(x).toContain(`${ENGINE}/oauth/callback/x`);
  });

  test('the page policy: opaque-origin sandbox, the pinned script, a form back to /go/ only', () => {
    const csp = connectPageCsp(RELAY_ORIGIN);
    expect(csp).toMatch(/^sandbox allow-scripts allow-forms;/);
    expect(csp).not.toContain('allow-same-origin');
    expect(csp).toContain(`script-src ${CONNECT_PAGE_SCRIPT_HASH};`);
    expect(csp).not.toMatch(/script-src[^;]*unsafe/);
    expect(csp).toContain(`form-action ${RELAY_ORIGIN}/go/;`);
    // An install's own answers on /go/ (and every browser route) get no script and no form.
    const policies = createResponsePolicies({ relayOrigin: RELAY_ORIGIN, enginePort: 8010 });
    for (const kind of ['handoff', 'browser'] as const) {
      expect(policies[kind].csp).not.toContain('allow-scripts');
      expect(policies[kind].csp).not.toContain('allow-forms');
      expect(policies[kind].csp).toContain("form-action 'none'");
    }
  });

  test('a descriptor is taken only in its closed shape: nothing an install writes reaches the page', () => {
    const ok = { v: 1, source: 'readwise', key: SHAPED_KEY };
    expect(parseConnectPageDescriptor(JSON.stringify(ok))).toEqual(ok as never);
    for (const bad of [
      { ...ok, label: 'Google password' },
      { ...ok, fields: ['password'] },
      { ...ok, source: 'google' },
      { ...ok, v: 2 },
      { ...ok, key: 'not-a-key' },
      { ...ok, key: `${SHAPED_KEY}"><script>` },
      { ...ok, callback: `${ENGINE}/oauth/callback/x` },
      { v: 1, source: 'x', key: SHAPED_KEY, callback: 'https://evil.example/oauth/callback/x' },
      { v: 1, source: 'x', key: SHAPED_KEY, callback: `${ENGINE}/oauth/callback/x<b>` },
      [ok],
    ]) {
      expect(parseConnectPageDescriptor(JSON.stringify(bad))).toBeUndefined();
    }
    expect(parseConnectPageDescriptor('<form><input name=password></form>')).toBeUndefined();
  });

  test('a POST body is accepted only as exactly epk, iv and ct', async () => {
    const good = await junkSubmission();
    expect(isConnectPageSubmission(good)).toBe(true);
    for (const bad of [
      'password=hunter2',
      'ct=a',
      `token=${'a'.repeat(20)}`,
      'epk=a&iv=b&ct=c',
      `${good}&password=x`,
      `${good}&ct=again`,
      `epk=${SHAPED_KEY}&iv=${'a'.repeat(16)}&ct=has%20space${'a'.repeat(30)}`,
      good.replace('epk=', 'EPK='),
    ]) {
      expect(isConnectPageSubmission(bad)).toBe(false);
    }
  });

  test('the relay and the Gateway name the same capability', () => {
    expect(RELAY_CONNECT_PAGE_CAPABILITY).toBe(CONNECT_PAGE_CAPABILITY);
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
    expect(await openConnectPageSubmission({ key: await createConnectPageKey(), linkId: 'oly2g.id', source: 'readwise', form })).toBeUndefined();
    expect(await openConnectPageSubmission({ key, linkId: 'oly2g.other', source: 'readwise', form })).toBeUndefined();
    expect(await openConnectPageSubmission({ key, linkId: 'oly2g.id', source: 'x', form })).toBeUndefined();
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
    const short = await sealed('x', { client_id: 'c' });
    expect(await openConnectPageSubmission({ key: short.key, linkId: 'oly2g.id', source: 'x', form: short.form })).toBeUndefined();
    const wrong = await sealed('readwise', { client_id: 'c' });
    expect(await openConnectPageSubmission({ key: wrong.key, linkId: 'oly2g.id', source: 'readwise', form: wrong.form })).toBeUndefined();
  });

  test('the script seals only the fixed field names', async () => {
    const key = await createConnectPageKey();
    const html = `<form id="olympus-connect" data-key="${toBase64Url(key.publicKey)}" data-context="c"><input data-field="password"></form>`;
    const outcome = await Promise.race([
      submitThroughScript(html, { password: 'x' }).then(() => 'submitted'),
      Bun.sleep(200).then(() => 'refused'),
    ]);
    expect(outcome).toBe('refused');
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
  function backend(minted: HandoffTarget[], keyPages = true): ChatGptSetupBackend {
    const handoffs = createChatGptHandoffs();
    return {
      async startOAuth() { throw new Error('not for keyed sources'); },
      keyPagesAvailable: () => keyPages,
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

  test('a relay that does not render key pages gets no key-page link', async () => {
    const minted: HandoffTarget[] = [];
    await expect(callSetupTool('olympus_connect_source', { source: 'readwise' }, backend(minted, false))).rejects.toThrow('connect_unavailable');
    expect(minted).toEqual([]);
  });
});
