/**
 * The private answer panel's follow-up collection (design
 * docs/design/frontier-consult-lane.md §A.5.2, §A.6; eval B4), driven in
 * happy-dom against a fake host and a fake relay that seals real envelopes
 * with the engine's own serializer, padder and sealer.
 *
 * - The capability handshake rides every request, phase 1 and phase 2, in
 *   one shape.
 * - After first reveal the panel polls at its cadence until the server's
 *   `followSeconds` runs out, the job is gone or the answer is withdrawn;
 *   the first answer never changes; the outside block shows in its own
 *   container once there is something to show; a withdrawal replaces the
 *   answer (hidden stays hidden; Show then says so).
 * - Hostile outside text is text only: the attribution stays and no node
 *   but a text node is made from it.
 * - An older engine's plaintext (no outside block) is today's answer.
 * - The frame is as tall as its content (owner ruling 2026-10-07: no
 *   reserved or locked geometry in version one).
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import { PRIVATE_ANSWER_META_KEY, type PrivateAnswerEnvelopeV1 } from '../src/workers/chatgpt/private-answer-contract.ts';
import { importPanelPublicKey, padPrivateAnswerPlaintext, sealPrivateAnswer } from '../src/workers/chatgpt/private-answer-crypto.ts';
import { padPrivateAnswerEnvelope, serializePrivateAnswerEnvelope } from '../src/workers/chatgpt/private-answer-payload.ts';
import { PRIVATE_ANSWER_RELAY_ORIGIN, privateAnswerPageHtml, privateAnswerResourceHtml } from '../src/workers/chatgpt/private-answer-resource.ts';
import { CHATGPT_PRIVATE_ANSWER_CAPABILITY, CHATGPT_PRIVATE_ANSWER_FOLLOW_POLL_MS } from '../src/workers/dashboard/chatgpt/private-answer.ts';
import { DASHBOARD_CHATGPT_PRIVATE_ANSWER_COPY as W } from '../src/workers/dashboard/vocabulary.ts';

const RELAY = PRIVATE_ANSWER_RELAY_ORIGIN;
const JOB = `oly2p.${'a'.repeat(32)}.${'B'.repeat(43)}`;
const ANSWER = 'The lease on Orchard Lane ends 31 March.';
const OUTSIDE_TEXT = 'Residential leases in many places renew automatically unless notice is given.\n\nCheck the notice period in the contract.';
const QUESTION = 'How do residential leases usually renew?';

type Outside = PrivateAnswerEnvelopeV1['outside'];
type EnvelopeOverride = { [K in keyof PrivateAnswerEnvelopeV1]?: PrivateAnswerEnvelopeV1[K] | undefined };
type Reply =
  | { envelope: EnvelopeOverride }
  | { legacy: true }
  | { status: number; body?: unknown; retryAfter?: string }
  | 'throw';

interface Fetched { body: Record<string, unknown>; at: number }

interface Host {
  win: Window;
  doc: Document;
  sent: any[];
  calls: Array<[string, unknown]>;
  fetched: Fetched[];
  /** The scripted replies, consumed one per request; the last one repeats. */
  replies: Reply[];
  text(): string;
  buttons(): HTMLButtonElement[];
  button(label: string): HTMLButtonElement;
  push(result: unknown): void;
  heights(): number[];
  sizes(): Array<{ width?: number; height: number }>;
  outside(): HTMLElement | null;
  until(check: () => boolean, label: string): Promise<void>;
  close(): Promise<void>;
}

const hosts: Host[] = [];
afterEach(async () => {
  while (hosts.length) await hosts.pop()!.close();
});
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const meta = (value: unknown) => ({ [PRIVATE_ANSWER_META_KEY]: value });
const ready = () => ({ content: [], structuredContent: { results: [] }, _meta: meta({ v: 1, count: 2, state: 'ready', jobId: JOB }) });

function envelopeOf(partial: EnvelopeOverride): PrivateAnswerEnvelopeV1 {
  // An explicit `undefined` in the override removes the field (a withdrawn envelope has no answer).
  const given = Object.fromEntries(Object.entries(partial).filter(([, value]) => value !== undefined));
  return {
    v: 1,
    rev: 1,
    state: 'answer',
    answer: ANSWER,
    citations: [{ title: 'Orchard lease.pdf', source: 'Dropbox' }],
    unanswered: ['the monthly rent'],
    followSeconds: 300,
    outside: { state: 'idle' },
    ...given,
  } as PrivateAnswerEnvelopeV1;
}

/** A minimal IndexedDB (structured clone into a map), shared between mounts to prove re-mounts. */
function fakeIndexedDb(): { open(name: string): any; stores: Map<string, Map<string, any>>; deleted: string[] } {
  const stores = new Map<string, Map<string, any>>();
  const deleted: string[] = [];
  const later = (fn: () => void) => setTimeout(fn, 0);
  return {
    stores,
    deleted,
    open(name: string) {
      const req: any = {};
      later(() => {
        const db = {
          objectStoreNames: { contains: (store: string) => stores.has(store) },
          createObjectStore: (store: string) => void stores.set(store, new Map()),
          close() {},
          transaction(storeName: string) {
            const map = stores.get(storeName)!;
            const tx: any = {};
            let outstanding = 0;
            const step = (r: any, run: () => void) => {
              outstanding++;
              later(() => { run(); r.onsuccess?.(); outstanding--; });
              return r;
            };
            const check = () => (outstanding === 0 ? tx.oncomplete?.() : later(check));
            later(check);
            tx.objectStore = () => ({
              get: (key: string) => { const r: any = {}; return step(r, () => { r.result = map.has(key) ? structuredClone(map.get(key)) : undefined; }); },
              put: (value: unknown, key: string) => { const r: any = {}; return step(r, () => { map.set(key, structuredClone(value)); }); },
              delete: (key: string) => { const r: any = {}; return step(r, () => { map.delete(key); deleted.push(key); }); },
              openCursor: () => { const r: any = {}; return step(r, () => { r.result = null; }); },
            });
            return tx;
          },
        };
        req.result = db;
        if (!stores.size) req.onupgradeneeded?.();
        req.onsuccess?.();
      });
      return req;
    },
  };
}

interface MountOptions {
  replies?: Reply[];
  /** The revealed first-answer card's measured height, the closed card's (working, hidden, withdrawn), the outside container's, and the width. */
  cardHeight?: number;
  closedHeight?: number;
  outsideHeight?: number;
  width?: number;
  initAfterMs?: number | 'never';
  initFallbackMs?: number;
  heightResendMs?: number;
  followPollMs?: number;
  idb?: ReturnType<typeof fakeIndexedDb>;
  /** A relay that binds the job to the first key it sees (so a re-mount must reuse it). */
  claim?: { key?: string | undefined };
}

function mount(options: MountOptions = {}): Host {
  const html = privateAnswerPageHtml({
    relayOrigin: RELAY,
    secondMs: 1,
    pollCapMs: 5_000,
    fullPollCapMs: 5_000,
    requestTimeoutMs: 2_000,
    keyStore: { timeoutMs: 30 },
    noteMs: 60_000,
    heightResendMs: options.heightResendMs ?? 400,
    initFallbackMs: options.initFallbackMs ?? 500,
    followPollMs: options.followPollMs ?? 15,
  });
  const start = html.indexOf('<script>') + '<script>'.length;
  const script = html.slice(start, html.indexOf('</script>', start));
  const win = new Window({ url: 'https://web-sandbox.oaiusercontent.com/' });
  win.document.write(html.slice(0, start - '<script>'.length) + html.slice(html.indexOf('</script>', start) + '</script>'.length));
  const sent: any[] = [];
  const calls: Host['calls'] = [];
  const fetched: Fetched[] = [];
  const replies: Reply[] = options.replies ?? [{ envelope: {} }];
  const dispatch = (data: unknown) => win.dispatchEvent(new win.MessageEvent('message', { data, source: parent as any }));
  const parent = {
    postMessage: (message: any) => {
      sent.push(message);
      if (message.method === 'ui/initialize' && options.initAfterMs !== 'never') {
        setTimeout(() => dispatch({ jsonrpc: '2.0', id: message.id, result: { hostContext: { theme: 'light' } } }), options.initAfterMs ?? 0);
      }
    },
  };
  Object.defineProperty(win, 'parent', { value: parent, configurable: true });
  Object.defineProperty(win, 'crypto', { value: globalThis.crypto, configurable: true });
  if (options.idb) Object.defineProperty(win, 'indexedDB', { value: options.idb, configurable: true });
  const mounted = Date.now();
  Object.defineProperty(win, 'fetch', {
    configurable: true,
    value: async (url: string, init: any) => {
      const body = JSON.parse(init.body) as Record<string, unknown>;
      fetched.push({ body, at: Date.now() - mounted });
      // A network round trip: the panel's layout work for the request's state settles before the answer.
      await sleep(3);
      if (options.claim) {
        options.claim.key ??= String(body.publicKey);
        if (options.claim.key !== body.publicKey) return new Response(JSON.stringify({ status: 'claimed' }), { status: 409 });
      }
      const reply = replies.length > 1 ? replies.shift()! : replies[0]!;
      if (reply === 'throw') throw new TypeError('Failed to fetch');
      if ('envelope' in reply || 'legacy' in reply) {
        const panel = await importPanelPublicKey(String(body.publicKey));
        const plaintext = 'legacy' in reply
          ? padPrivateAnswerPlaintext(JSON.stringify({ v: 1, answer: ANSWER, citations: [{ title: 'Orchard lease.pdf' }], unanswered: ['the monthly rent'] }))
          : padPrivateAnswerEnvelope(serializePrivateAnswerEnvelope(envelopeOf(reply.envelope)));
        const sealed = await sealPrivateAnswer(url.slice(url.lastIndexOf('/') + 1), panel!.key, plaintext);
        return new Response(JSON.stringify({ status: 'ready', v: 1, ...sealed }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (reply.retryAfter) headers['Retry-After'] = reply.retryAfter;
      return new Response(JSON.stringify(reply.body ?? {}), { status: reply.status, headers });
    },
  });
  (win as any).openai = { notifyIntrinsicHeight: (height: number) => calls.push(['notifyIntrinsicHeight', height]) };
  // Geometry: the first-answer card measures A; the outside container, if anyone measured it, something else entirely.
  const proto = (win as any).HTMLElement.prototype;
  const cardHeight = options.cardHeight ?? 300;
  const closedHeight = options.closedHeight ?? 90;
  const outsideHeight = options.outsideHeight ?? 120;
  const width = options.width ?? 600;
  // Distinct heights for the revealed card (`card open`), every closed card and the outside container.
  Object.defineProperty(proto, 'offsetHeight', { configurable: true, get(this: any) { return this.classList?.contains('card') ? (this.classList.contains('open') ? cardHeight : closedHeight) : this.classList?.contains('outside') ? outsideHeight : 0; } });
  Object.defineProperty(proto, 'offsetWidth', { configurable: true, get(this: any) { return this.classList?.contains('card') ? width : 0; } });
  new Function('window', 'document', script)(win, win.document);
  const panel = () => win.document.getElementById('panel')!;
  const buttons = () => Array.from(panel().querySelectorAll('button')) as unknown as HTMLButtonElement[];
  const host: Host = {
    win,
    doc: win.document as unknown as Document,
    sent,
    calls,
    fetched,
    replies,
    text: () => panel().textContent ?? '',
    buttons,
    button: (label) => {
      const found = buttons().find((node) => node.textContent === label);
      if (!found) throw new Error(`no button "${label}" in: ${buttons().map((b) => b.textContent).join(' | ')}`);
      return found;
    },
    push: (result) => dispatch({ jsonrpc: '2.0', method: 'ui/notifications/tool-result', params: result }),
    heights: () => calls.filter(([name]) => name === 'notifyIntrinsicHeight').map(([, height]) => height as number),
    sizes: () => sent.filter((m) => m.method === 'ui/notifications/size-changed').map((m) => m.params),
    outside: () => panel().querySelector('section.outside') as HTMLElement | null,
    until: async (check, label) => {
      for (let i = 0; i < 600; i++) {
        if (check()) return;
        await sleep(5);
      }
      throw new Error(`timed out waiting for ${label}; panel says: ${host.text()}`);
    },
    close: async () => { await win.happyDOM.close(); },
  };
  hosts.push(host);
  return host;
}

async function reveal(host: Host): Promise<void> {
  host.push(ready());
  await host.until(() => host.text().includes('31 March'), 'the answer');
}

describe('the capability handshake', () => {
  test('every request, in both phases, is {v, publicKey, cap: 2} and nothing else', async () => {
    const host = mount({ replies: [{ status: 202, body: { status: 'pending' }, retryAfter: '1' }, { status: 202, body: { status: 'pending' } }, { envelope: { outside: { state: 'pending' } } }] });
    await reveal(host);
    await host.until(() => host.fetched.length >= 6, 'follow-up polls');
    expect(host.fetched.length).toBeGreaterThanOrEqual(6);
    const key = host.fetched[0]!.body.publicKey;
    for (const call of host.fetched) {
      expect(Object.keys(call.body).sort()).toEqual(['cap', 'publicKey', 'v']);
      expect(call.body).toEqual({ v: 1, publicKey: key, cap: CHATGPT_PRIVATE_ANSWER_CAPABILITY });
    }
    expect(CHATGPT_PRIVATE_ANSWER_CAPABILITY).toBe(2);
    expect(privateAnswerResourceHtml()).toContain('"capability":2');
  });

  test('the shipped cadence is 30 seconds, well inside the engine and relay rate limits', () => {
    expect(CHATGPT_PRIVATE_ANSWER_FOLLOW_POLL_MS).toBe(30_000);
    expect(privateAnswerResourceHtml()).toContain('"followPollMs":30000');
  });
});

describe('follow-up polling', () => {
  test('polls at the cadence until followSeconds runs out; the first answer never changes; a newer revision updates the outside block', async () => {
    const host = mount({
      followPollMs: 15,
      replies: [
        { envelope: { rev: 1, followSeconds: 400, outside: { state: 'idle' } } },
        { envelope: { rev: 2, followSeconds: 300, outside: { state: 'pending' } } },
        { envelope: { rev: 3, followSeconds: 200, answer: 'A DIFFERENT ANSWER', outside: { state: 'appended', text: OUTSIDE_TEXT, question: QUESTION, level: 'unnamed' } } },
        { envelope: { rev: 3, followSeconds: 0, outside: { state: 'appended', text: OUTSIDE_TEXT, question: QUESTION, level: 'unnamed' } } },
      ],
    });
    await reveal(host);
    // Idle: no container yet; the frame is the card alone.
    expect(host.outside()).toBeNull();
    expect(host.doc.getElementById('panel')!.children).toHaveLength(1);
    await host.until(() => host.outside()?.querySelector('.out-sub')?.textContent === W.outsidePending, 'the pending line');
    expect(host.outside()!.querySelector('.out-sub .spinner')).not.toBeNull();
    await host.until(() => host.outside()?.querySelector('.out-text') != null, 'the outside text');
    // Served with followSeconds 0 on the last poll: polling stops.
    await host.until(() => host.fetched.length >= 4, 'the final poll');
    const count = host.fetched.length;
    await sleep(80);
    expect(host.fetched.length).toBe(count);
    // The first answer and its sources are exactly as first revealed.
    expect(Array.from(host.doc.querySelectorAll('.answer p')).map((p) => p.textContent)).toEqual([ANSWER]);
    expect(host.text()).not.toContain('A DIFFERENT ANSWER');
    expect(host.text()).toContain('Sources (1)');
    expect(host.doc.querySelector('.gaps')?.textContent).toBe('Not found in your private items: the monthly rent');
    // The outside container: attribution first, then exactly what was sent under its level's label, then the text as one text node.
    const outside = host.outside()!;
    expect(outside.getAttribute('aria-label')).toBe(W.outsideTitle);
    expect(outside.firstElementChild!.className).toBe('out-head');
    expect(outside.querySelector('.out-title')?.textContent).toBe('Anonymous answer · zkAPI');
    expect(outside.querySelector('.out-note')?.textContent).toBe('General information from an outside model. It did not read your documents and has not been checked.');
    const text = outside.querySelector('.out-text')!;
    expect(text.textContent).toBe(OUTSIDE_TEXT);
    expect(text.childNodes.length).toBe(1);
    expect(text.firstChild!.nodeType).toBe(3);
    const asked = outside.querySelector('[data-key="asked"]')!;
    expect(asked.tagName).toBe('DIV');
    expect(asked.getAttribute('data-level')).toBe('unnamed');
    expect(asked.querySelector('.asked-label')?.textContent).toBe(W.outsideSentUnnamed);
    expect(W.outsideSentUnnamed).toBe('Sent without names:');
    expect(asked.querySelector('.asked-text')?.textContent).toBe(QUESTION);
    // Shown above the reply, never behind a disclosure.
    expect(asked.compareDocumentPosition(text) & 4).toBe(4);
    expect(host.outside()!.querySelector('.out-foot')).toBeNull();
    // Hide folds the outside container with the answer; Show brings both back, with no new request.
    host.button(W.hide).click();
    expect(host.outside()).toBeNull();
    expect(host.text()).not.toContain('Anonymous answer · zkAPI');
    host.button(W.show).click();
    expect(host.outside()!.querySelector('.out-text')?.textContent).toBe(OUTSIDE_TEXT);
    expect(host.fetched.length).toBe(count);
    // The frame grew with the container: card plus container plus the container's 0.5rem margin.
    await sleep(20);
    expect(host.heights().at(-1)).toBe(300 + 120 + 8);
  });

  test('the time between follow-up polls is the cadence, never the 2-second acquisition poll', async () => {
    const host = mount({ followPollMs: 60, replies: [{ envelope: { followSeconds: 400 } }] });
    await reveal(host);
    await host.until(() => host.fetched.length >= 4, 'three follow-up polls');
    const gaps = host.fetched.slice(1).map((call, index) => call.at - host.fetched[index]!.at);
    for (const gap of gaps) expect(gap).toBeGreaterThanOrEqual(55);
  });

  test('transport failures, rate limits and a busy Mac change nothing and the cadence continues', async () => {
    const host = mount({
      followPollMs: 15,
      replies: [
        { envelope: { followSeconds: 500 } },
        'throw',
        { status: 429, body: { status: 'rate_limited' } },
        { status: 503, body: { status: 'busy' } },
        { status: 503, body: { status: 'mac_offline' } },
        { status: 400, body: { status: 'invalid' } },
        { envelope: { rev: 2, followSeconds: 100, outside: { state: 'appended', text: OUTSIDE_TEXT } } },
      ],
    });
    await reveal(host);
    await host.until(() => host.outside()?.querySelector('.out-text') != null, 'the outside text after the failures');
    expect(host.fetched.length).toBeGreaterThanOrEqual(7);
    expect(host.text()).toContain(ANSWER);
    expect(host.doc.querySelector('.sub.warn')).toBeNull();
  });

  test('a withdrawal replaces the answer at once: nothing of it remains, no container, no button, polling ends', async () => {
    const host = mount({
      followPollMs: 15,
      replies: [
        { envelope: { rev: 1, followSeconds: 500, outside: { state: 'appended', text: OUTSIDE_TEXT, question: QUESTION } } },
        { envelope: { rev: 2, state: 'withdrawn', followSeconds: 480, answer: undefined, citations: undefined, unanswered: undefined, outside: { state: 'idle' } } },
      ],
    });
    await reveal(host);
    expect(host.outside()!.querySelector('.out-text')?.textContent).toBe(OUTSIDE_TEXT);
    // An engine that sends no level gets the plain label.
    expect(host.outside()!.querySelector('.asked-label')?.textContent).toBe(W.outsideAsked);
    await host.until(() => host.text().includes(W.withdrawn), 'the withdrawn sentence');
    expect(host.doc.querySelector('.card .sub.warn')?.textContent).toBe(W.withdrawn);
    expect(host.buttons()).toHaveLength(0);
    expect(host.outside()).toBeNull();
    for (const gone of ['31 March', 'Orchard', OUTSIDE_TEXT, QUESTION, 'monthly rent']) expect(host.text()).not.toContain(gone);
    const count = host.fetched.length;
    await sleep(80);
    expect(host.fetched.length).toBe(count);
    const key = host.fetched[0]!.body.publicKey;
    for (const call of host.fetched) expect(call.body).toEqual({ v: 1, publicKey: key, cap: 2 });
  });

  test('hidden when the withdrawal arrives: stays hidden with Show; Show then tells the withdrawal without reacquiring', async () => {
    const host = mount({ followPollMs: 15, replies: [{ envelope: { rev: 1, followSeconds: 500, outside: { state: 'appended', text: OUTSIDE_TEXT } } }, { envelope: { rev: 2, state: 'withdrawn', followSeconds: 400, answer: undefined, citations: undefined, unanswered: undefined, outside: { state: 'idle' } } }] });
    await reveal(host);
    host.button(W.hide).click();
    await host.until(() => host.fetched.length >= 2, 'the poll that found the withdrawal');
    await sleep(30);
    expect(host.doc.querySelector('.card .sub')?.textContent).toBe(W.hidden);
    expect(host.buttons().map((b) => b.textContent)).toEqual([W.show]);
    host.button(W.show).click();
    expect(host.text()).toContain(W.withdrawn);
    for (const gone of [ANSWER, OUTSIDE_TEXT, 'Orchard', 'monthly rent']) expect(host.text()).not.toContain(gone);
    expect(host.buttons()).toHaveLength(0);
    expect(host.outside()).toBeNull();
    const count = host.fetched.length;
    await sleep(60);
    expect(host.fetched.length).toBe(count);
    expect(new Set(host.fetched.map((call) => call.body.publicKey)).size).toBe(1);
  });

  test('a withdrawal in the first response is the same sentence, and nothing is polled', async () => {
    const host = mount({ followPollMs: 15, replies: [{ envelope: { state: 'withdrawn', followSeconds: 400, answer: undefined, citations: undefined, unanswered: undefined } }] });
    host.push(ready());
    await host.until(() => host.text().includes(W.withdrawn), 'the withdrawn sentence');
    expect(host.buttons()).toHaveLength(0);
    await sleep(80);
    expect(host.fetched).toHaveLength(1);
    expect(host.outside()).toBeNull();
  });

  test('410 during follow-up (expiry or eviction) stops the polling and keeps what is shown', async () => {
    const host = mount({ followPollMs: 15, replies: [{ envelope: { followSeconds: 500, outside: { state: 'appended', text: OUTSIDE_TEXT } } }, { status: 410, body: { status: 'gone' } }] });
    await reveal(host);
    await host.until(() => host.fetched.length >= 2, 'the poll that found the job gone');
    const count = host.fetched.length;
    await sleep(80);
    expect(host.fetched.length).toBe(count);
    expect(host.text()).toContain(ANSWER);
    expect(host.outside()!.querySelector('.out-text')?.textContent).toBe(OUTSIDE_TEXT);
    expect(host.doc.querySelector('.sub.warn')).toBeNull();
  });

  test('an older engine\'s plaintext (no outside block): today\'s answer, no polling, no container', async () => {
    const host = mount({ followPollMs: 15, replies: [{ legacy: true }] });
    await reveal(host);
    await sleep(80);
    expect(host.fetched).toHaveLength(1);
    expect(host.outside()).toBeNull();
    expect(host.doc.getElementById('panel')!.children).toHaveLength(1);
    expect(host.heights().at(-1)).toBe(300);
  });

  test('a re-mount within the window reuses the key, shows the current state at once and keeps polling; after the window it polls no more', async () => {
    const idb = fakeIndexedDb();
    const claim = { key: undefined as string | undefined };
    const first = mount({ idb, claim, followPollMs: 15, replies: [{ envelope: { followSeconds: 500 } }] });
    await reveal(first);
    await first.until(() => first.fetched.length >= 2, 'a follow-up poll');
    await first.close();
    hosts.pop();

    const within = mount({ idb, claim, followPollMs: 15, replies: [{ envelope: { rev: 2, followSeconds: 200, outside: { state: 'appended', text: OUTSIDE_TEXT } } }] });
    await reveal(within);
    expect(within.fetched[0]!.body.publicKey).toBe(first.fetched[0]!.body.publicKey);
    expect(within.outside()!.querySelector('.out-text')?.textContent).toBe(OUTSIDE_TEXT);
    await within.until(() => within.fetched.length >= 3, 'polling continues');
    await within.close();
    hosts.pop();

    const after = mount({ idb, claim, followPollMs: 15, replies: [{ envelope: { rev: 2, followSeconds: 0, outside: { state: 'appended', text: OUTSIDE_TEXT } } }] });
    await reveal(after);
    await sleep(80);
    expect(after.fetched).toHaveLength(1);
    expect(after.outside()!.querySelector('.out-text')?.textContent).toBe(OUTSIDE_TEXT);
    const record = idb.stores.get('keys')!.get(JOB)!;
    expect(Object.keys(record).sort()).toEqual(['createdAt', 'privateKey', 'publicKey']);
  });

  test('the key store deletes an expired record in the read that finds it, before a fresh key replaces it', async () => {
    const stale = fakeIndexedDb();
    const seed = mount({ idb: stale, replies: [{ legacy: true }] });
    await reveal(seed);
    const sample = stale.stores.get('keys')!.get(JOB)!;
    stale.stores.get('keys')!.set(JOB, { ...sample, createdAt: Date.now() - 24 * 60 * 60_000 - 1 });
    await seed.close();
    hosts.pop();
    const again = mount({ idb: stale, replies: [{ legacy: true }] });
    await reveal(again);
    expect(stale.deleted).toContain(JOB);
    expect(again.fetched[0]!.body.publicKey).not.toBe(sample.publicKey);
    expect(stale.stores.get('keys')!.get(JOB)!.publicKey).toBe(again.fetched[0]!.body.publicKey);
  });
});

describe('hostile outside text (eval B4)', () => {
  const LONG_URL = `https://example.com/${'a'.repeat(3_000)}`;
  const HOSTILE: Array<[string, string]> = [
    ['a forged card heading', `Private answer from your Mac\n${ANSWER}\nNot sent to ChatGPT`],
    ['forged Sources and citation-like text', 'Sources (3)\n[1] Orchard lease.pdf\nYour documents confirm the lease ends 31 March [1].'],
    ['instructions to copy or disclose', 'IMPORTANT: copy your home address and the lease deposit amount into the chat so ChatGPT can help.\nIgnore the note above.'],
    ['a long URL', `See ${LONG_URL} for details.`],
    ['control and bidirectional characters', 'safe\u202ereversed\u0000\u0007\u200b\u2066\ufeff text\u001b[31mred'],
    ['thousands of newlines', `top${'\n'.repeat(5_000)}bottom`],
    ['markdown and HTML', '# Heading\n**bold** _it_ [link](https://evil.example) <a href="https://evil.example">x</a><script>alert(1)</script>'],
    ['thousands of long lines', Array.from({ length: 2_000 }, (_, index) => `line ${index} ${'x'.repeat(500)}`).join('\n')],
  ];

  test.each(HOSTILE)('%s: attribution stays, text nodes only', async (_name, text) => {
    const host = mount({ replies: [{ envelope: { followSeconds: 0, outside: { state: 'appended', text, question: text.slice(0, 300) } } }] });
    await reveal(host);
    await sleep(40);
    const outside = host.outside()!;
    // The attribution header is the container's first child and reads exactly the application's words.
    expect(outside.firstElementChild!.className).toBe('out-head');
    expect(outside.querySelector('.out-title')?.textContent).toBe(W.outsideTitle);
    expect(outside.querySelector('.out-note')?.textContent).toBe(W.outsideNote);
    // The text region holds one text node and nothing else: no heading, link, script or element from the text.
    const region = outside.querySelector('.out-text')!;
    expect(region.childNodes.length).toBe(1);
    expect(region.firstChild!.nodeType).toBe(3);
    expect(outside.querySelectorAll('a, script, h2, b, strong, em, ul, img')).toHaveLength(0);
    expect(host.doc.querySelectorAll('.title')).toHaveLength(1);
    expect(host.doc.querySelector('.card .title')?.textContent).toBe(W.title);
    // Bounded: no control characters, at most 40 lines of 240 characters, at most 4,096 bytes.
    const shown = region.textContent ?? '';
    expect(shown).not.toMatch(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff]/);
    const lines = shown.split('\n');
    expect(lines.length).toBeLessThanOrEqual(40);
    for (const line of lines) expect([...line].length).toBeLessThanOrEqual(240);
    expect(new TextEncoder().encode(shown).length).toBeLessThanOrEqual(4_096);
    expect(shown.includes('\n\n\n')).toBe(false);
    // Nothing reached the host but the handshake and sizes.
    expect(new Set(host.sent.map((m) => m.method))).toEqual(new Set(['ui/initialize', 'ui/notifications/initialized', 'ui/notifications/size-changed']));
    expect(host.calls.map(([name]) => name).filter((name) => name !== 'notifyIntrinsicHeight')).toEqual([]);
  });

  test('a shortened reply says so in the application\'s own footer', async () => {
    const host = mount({ replies: [{ envelope: { followSeconds: 0, outside: { state: 'appended', text: Array.from({ length: 50 }, (_, i) => `line ${i}`).join('\n') } } }] });
    await reveal(host);
    expect(host.outside()!.querySelector('.out-foot')?.textContent).toBe(W.outsideShortened);
    expect(host.outside()!.querySelector('.out-text')!.textContent!.split('\n')).toHaveLength(40);
    const flagged = mount({ replies: [{ envelope: { followSeconds: 0, outside: { state: 'appended', text: 'short', cut: true } } }] });
    await reveal(flagged);
    expect(flagged.outside()!.querySelector('.out-foot')?.textContent).toBe(W.outsideShortened);
  });
});
