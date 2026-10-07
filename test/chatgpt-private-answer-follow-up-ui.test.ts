/**
 * The private answer panel's follow-up collection (design
 * docs/design/frontier-consult-lane.md §A.5.2, §A.5.5, §A.6; evals B3 and
 * B4), driven in happy-dom against a fake host and a fake relay that seals
 * real envelopes with the engine's own serializer, padder and sealer.
 *
 * - The capability handshake rides every request, phase 1 and phase 2, in
 *   one shape.
 * - After first reveal the panel polls at its cadence until the server's
 *   `followSeconds` runs out; the first answer never changes; the outside
 *   block shows in its own container; a withdrawal replaces the answer.
 * - The host transcript (every height the panel reports) is identical across
 *   outside outcomes wherever the first answer and the width are the same:
 *   `H = min(A + 176, 640)`, the outside container never measured.
 * - Hostile outside text is text only: the attribution stays, no node but a
 *   text node is made from it, and the geometry is unchanged.
 * - An older engine's plaintext (no outside block) is today's answer.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import { PRIVATE_ANSWER_META_KEY, type PrivateAnswerEnvelopeV1 } from '../src/workers/chatgpt/private-answer-contract.ts';
import { importPanelPublicKey, padPrivateAnswerPlaintext, sealPrivateAnswer } from '../src/workers/chatgpt/private-answer-crypto.ts';
import { padPrivateAnswerEnvelope, serializePrivateAnswerEnvelope } from '../src/workers/chatgpt/private-answer-payload.ts';
import { PRIVATE_ANSWER_RELAY_ORIGIN, privateAnswerPageHtml, privateAnswerResourceHtml } from '../src/workers/chatgpt/private-answer-resource.ts';
import {
  CHATGPT_PRIVATE_ANSWER_CAPABILITY,
  CHATGPT_PRIVATE_ANSWER_FOLLOW_POLL_MS,
  CHATGPT_PRIVATE_ANSWER_FRAME_CAP_PX,
  CHATGPT_PRIVATE_ANSWER_OUTSIDE_GAP_PX,
  CHATGPT_PRIVATE_ANSWER_OUTSIDE_HEIGHT_PX,
} from '../src/workers/dashboard/chatgpt/private-answer.ts';
import { DASHBOARD_CHATGPT_PRIVATE_ANSWER_COPY as W } from '../src/workers/dashboard/vocabulary.ts';

const RELAY = PRIVATE_ANSWER_RELAY_ORIGIN;
const JOB = `oly2p.${'a'.repeat(32)}.${'B'.repeat(43)}`;
const ANSWER = 'The lease on Orchard Lane ends 31 March.';
const OUTSIDE_TEXT = 'Residential leases in many places renew automatically unless notice is given.\n\nCheck the notice period in the contract.';
const QUESTION = 'How do residential leases usually renew?';
const R = CHATGPT_PRIVATE_ANSWER_OUTSIDE_HEIGHT_PX;
const CAP = CHATGPT_PRIVATE_ANSWER_FRAME_CAP_PX;

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
function fakeIndexedDb(): { open(name: string): any; stores: Map<string, Map<string, any>> } {
  const stores = new Map<string, Map<string, any>>();
  const later = (fn: () => void) => setTimeout(fn, 0);
  return {
    stores,
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
  /** The revealed first-answer card's measured height (A), the closed card's (working, hidden, withdrawn), and the width. */
  cardHeight?: number;
  closedHeight?: number;
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
  const width = options.width ?? 600;
  // Distinct heights for the revealed card (`card open`) and every closed card, so a report of the wrong one shows.
  Object.defineProperty(proto, 'offsetHeight', { configurable: true, get(this: any) { return this.classList?.contains('card') ? (this.classList.contains('open') ? cardHeight : closedHeight) : this.classList?.contains('outside') ? 999 : 0; } });
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
        { envelope: { rev: 3, followSeconds: 200, answer: 'A DIFFERENT ANSWER', outside: { state: 'appended', text: OUTSIDE_TEXT, question: QUESTION } } },
        { envelope: { rev: 3, followSeconds: 0, outside: { state: 'appended', text: OUTSIDE_TEXT, question: QUESTION } } },
      ],
    });
    await reveal(host);
    const box = host.outside()!;
    expect(box).not.toBeNull();
    expect(box.querySelector('.out-sub')?.textContent).toBe(W.outsideIdle);
    await host.until(() => host.outside()?.querySelector('.out-sub')?.textContent === W.outsidePending, 'the pending line');
    expect(host.outside()!.querySelector('.out-sub .spinner')).not.toBeNull();
    await host.until(() => host.outside()?.querySelector('.out-text') !== null, 'the outside text');
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
    // The outside container: attribution first, text as one text node, the question behind its disclosure.
    const outside = host.outside()!;
    expect(outside.getAttribute('aria-label')).toBe(W.outsideTitle);
    expect(outside.firstElementChild!.className).toBe('out-head');
    expect(outside.querySelector('.out-title')?.textContent).toBe('Outside background — not from your documents');
    expect(outside.querySelector('.out-note')?.textContent).toBe('General information from an outside model. It did not read your documents and has not been checked.');
    const text = outside.querySelector('.out-text')!;
    expect(text.textContent).toBe(OUTSIDE_TEXT);
    expect(text.childNodes.length).toBe(1);
    expect(text.firstChild!.nodeType).toBe(3);
    expect(host.text()).not.toContain(QUESTION);
    const asked = outside.querySelector('[data-key="asked"]') as HTMLButtonElement;
    expect(asked.textContent).toBe(W.outsideAsked);
    asked.click();
    expect(host.outside()!.querySelector('.asked-text')?.textContent).toBe(QUESTION);
    expect(host.outside()!.querySelector('.out-foot')).toBeNull();
    // Hide folds the outside container with the answer; Show brings both back, with no new request.
    host.button(W.hide).click();
    expect(host.outside()).toBeNull();
    expect(host.text()).not.toContain('Outside background');
    host.button(W.show).click();
    expect(host.outside()!.querySelector('.out-text')?.textContent).toBe(OUTSIDE_TEXT);
    expect(host.fetched.length).toBe(count);
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
    await host.until(() => host.outside()?.querySelector('.out-text') !== null, 'the outside text after the failures');
    expect(host.fetched.length).toBeGreaterThanOrEqual(7);
    expect(host.text()).toContain(ANSWER);
    expect(host.doc.querySelector('.sub.warn')).toBeNull();
  });

  test('a withdrawal replaces the answer at once; the polling cadence and the reported height carry on unchanged', async () => {
    const host = mount({
      followPollMs: 15,
      replies: [
        { envelope: { rev: 1, followSeconds: 500, outside: { state: 'appended', text: OUTSIDE_TEXT, question: QUESTION } } },
        { envelope: { rev: 2, state: 'withdrawn', followSeconds: 480, answer: undefined, citations: undefined, unanswered: undefined, outside: { state: 'idle' } } },
      ],
    });
    await reveal(host);
    expect(host.outside()!.querySelector('.out-text')?.textContent).toBe(OUTSIDE_TEXT);
    const revealedHeight = host.heights().at(-1);
    expect(revealedHeight).toBe(300 + R);
    await host.until(() => host.text().includes(W.withdrawn), 'the withdrawn sentence');
    expect(host.doc.querySelector('.card .sub.warn')?.textContent).toBe(W.withdrawn);
    expect(host.buttons()).toHaveLength(0);
    // The reserved container stays, empty; nothing of the answer or the outside block remains.
    expect(host.outside()).not.toBeNull();
    expect(host.outside()!.querySelector('.out-text')).toBeNull();
    for (const gone of ['31 March', 'Orchard', OUTSIDE_TEXT, QUESTION, 'monthly rent']) expect(host.text()).not.toContain(gone);
    // Polling continues at the cadence for the rest of the window, with the same body.
    const count = host.fetched.length;
    await host.until(() => host.fetched.length >= count + 3, 'polls after the withdrawal');
    const key = host.fetched[0]!.body.publicKey;
    for (const call of host.fetched) expect(call.body).toEqual({ v: 1, publicKey: key, cap: 2 });
    // The host was told nothing new: every height is still the revealed one.
    await sleep(30);
    expect(host.heights().filter((height) => height !== 0 && height !== 90).every((height) => height === revealedHeight)).toBe(true);
    expect(host.heights()).not.toContain(90 + R);
    expect(host.heights().at(-1)).toBe(revealedHeight);
  });

  test('hidden when the withdrawal arrives: stays hidden with Show; Show tells the withdrawal at the retained height; host messages equal hide-live-show', async () => {
    const script = async (second: Reply) => {
      const host = mount({ followPollMs: 15, replies: [{ envelope: { rev: 1, followSeconds: 500, outside: { state: 'appended', text: OUTSIDE_TEXT } } }, second] });
      await sleep(50);
      await reveal(host);
      host.button(W.hide).click();
      await host.until(() => host.fetched.length >= 3, 'polls while hidden');
      await sleep(30);
      expect(host.doc.querySelector('.card .sub')?.textContent).toBe(W.hidden);
      expect(host.buttons().map((b) => b.textContent)).toEqual([W.show]);
      host.button(W.show).click();
      await sleep(30);
      return host;
    };
    const live = await script({ envelope: { rev: 1, followSeconds: 400, outside: { state: 'appended', text: OUTSIDE_TEXT } } });
    const withdrawn = await script({ envelope: { rev: 2, state: 'withdrawn', followSeconds: 400, answer: undefined, citations: undefined, unanswered: undefined, outside: { state: 'idle' } } });
    expect(live.text()).toContain(ANSWER);
    expect(withdrawn.text()).toContain(W.withdrawn);
    for (const gone of [ANSWER, OUTSIDE_TEXT, 'Orchard', 'monthly rent']) expect(withdrawn.text()).not.toContain(gone);
    expect(withdrawn.buttons()).toHaveLength(0);
    expect(withdrawn.outside()).not.toBeNull();
    // No reacquisition: the same key, polls only.
    expect(new Set(withdrawn.fetched.map((call) => call.body.publicKey)).size).toBe(1);
    expect(withdrawn.heights()).toEqual(live.heights());
    expect(withdrawn.sizes()).toEqual(live.sizes());
    expect(withdrawn.sent.map((m) => m.method)).toEqual(live.sent.map((m) => m.method));
    expect(withdrawn.heights().at(-1)).toBe(300 + R);
  });

  test('a withdrawal in the first response is the same sentence, keeps the window, and reports the same rule', async () => {
    const host = mount({ followPollMs: 15, replies: [{ envelope: { state: 'withdrawn', followSeconds: 400, answer: undefined, citations: undefined, unanswered: undefined } }] });
    host.push(ready());
    await host.until(() => host.text().includes(W.withdrawn), 'the withdrawn sentence');
    expect(host.buttons()).toHaveLength(0);
    await host.until(() => host.fetched.length >= 3, 'polls after a withdrawn first response');
    await sleep(20);
    // Never shown here and no record: the rule over the withdrawn (closed) card, settled once.
    expect(host.heights().at(-1)).toBe(Math.min(90 + R, CAP));
    expect(host.outside()).not.toBeNull();
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
    expect(host.doc.querySelector('.card.follow')).toBeNull();
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
    expect(after.heights().at(-1)).toBe(Math.min(300 + R, CAP));
    await after.close();
    hosts.pop();

    // Reopened after a withdrawal, inside the window, at the same width: the
    // sentence, the same polling, and the height the revealed answer had
    // (kept beside the key), not the withdrawn card's.
    const withdrawn = mount({ idb, claim, followPollMs: 15, replies: [{ envelope: { rev: 3, state: 'withdrawn', followSeconds: 200, answer: undefined, citations: undefined, unanswered: undefined, outside: { state: 'idle' } } }] });
    withdrawn.push(ready());
    await withdrawn.until(() => withdrawn.text().includes(W.withdrawn), 'the withdrawn sentence');
    expect(withdrawn.fetched[0]!.body.publicKey).toBe(first.fetched[0]!.body.publicKey);
    await withdrawn.until(() => withdrawn.fetched.length >= 3, 'polling continues after a withdrawn reopen');
    expect(withdrawn.heights().at(-1)).toBe(Math.min(300 + R, CAP));
    expect(withdrawn.heights()).not.toContain(90 + R);
    const record = idb.stores.get('keys')!.get(JOB)!;
    expect(Object.keys(record).sort()).toEqual(['createdAt', 'geometry', 'privateKey', 'publicKey']);
    expect(record.geometry).toEqual({ width: 600, height: 300 + R });
    await withdrawn.close();
    hosts.pop();

    // At another width the record does not apply: the rule over the withdrawn card, settled once (the acknowledged residual).
    const narrow = mount({ idb, claim, width: 420, followPollMs: 15, replies: [{ envelope: { rev: 3, state: 'withdrawn', followSeconds: 200, answer: undefined, citations: undefined, unanswered: undefined, outside: { state: 'idle' } } }] });
    narrow.push(ready());
    await narrow.until(() => narrow.text().includes(W.withdrawn), 'the withdrawn sentence');
    await sleep(30);
    expect(narrow.heights().at(-1)).toBe(90 + R);
  });

  test('the revealed geometry is locked before the host answers the handshake, so an early withdrawal still reports it', async () => {
    const host = mount({ initAfterMs: 300, heightResendMs: 20, followPollMs: 15, replies: [{ envelope: { followSeconds: 400 } }, { envelope: { rev: 2, state: 'withdrawn', followSeconds: 300, answer: undefined, citations: undefined, unanswered: undefined, outside: { state: 'idle' } } }] });
    await reveal(host);
    await host.until(() => host.text().includes(W.withdrawn), 'the withdrawal, before initialization');
    expect(host.heights()).toEqual([]);
    await host.until(() => host.heights().length >= 2, 'the handshake heights');
    expect(host.heights().every((height) => height === 300 + R)).toBe(true);
  });
});

describe('fixed reported geometry (host transcript)', () => {
  interface Scenario { name: string; replies: Reply[]; expectWithdrawn?: boolean }
  const outcomes: Scenario[] = [
    { name: 'idle (nothing triggered, refused, skipped or failed alike)', replies: [{ envelope: { followSeconds: 120, outside: { state: 'idle' } } }] },
    { name: 'pending', replies: [{ envelope: { followSeconds: 120, outside: { state: 'pending' } } }] },
    { name: 'appended', replies: [{ envelope: { followSeconds: 120, outside: { state: 'appended', text: OUTSIDE_TEXT.repeat(8), question: QUESTION, cut: true } } }] },
    { name: 'paused', replies: [{ envelope: { followSeconds: 120, outside: { state: 'paused' } } }] },
    { name: 'idle then appended', replies: [{ envelope: { followSeconds: 120 } }, { envelope: { rev: 2, followSeconds: 60, outside: { state: 'appended', text: OUTSIDE_TEXT } } }] },
    { name: 'follow-up expiry (followSeconds 0)', replies: [{ envelope: { followSeconds: 0, outside: { state: 'appended', text: OUTSIDE_TEXT } } }] },
    { name: '410 after reveal', replies: [{ envelope: { followSeconds: 120 } }, { status: 410, body: { status: 'gone' } }] },
    { name: 'withdrawn after reveal', replies: [{ envelope: { followSeconds: 120, outside: { state: 'appended', text: OUTSIDE_TEXT } } }, { envelope: { rev: 2, state: 'withdrawn', followSeconds: 60, answer: undefined, citations: undefined, unanswered: undefined, outside: { state: 'idle' } } }] },
    { name: 'withdrawn after pending', replies: [{ envelope: { followSeconds: 120, outside: { state: 'pending' } } }, { envelope: { rev: 2, state: 'withdrawn', followSeconds: 60, answer: undefined, citations: undefined, unanswered: undefined, outside: { state: 'idle' } } }] },
  ];

  async function transcript(scenario: Scenario, options: MountOptions = {}): Promise<{ heights: number[]; sizes: unknown[] }> {
    // The scripted replies are consumed as they are served: each mount gets its own copy.
    const host = mount({ followPollMs: 15, heightResendMs: 20, ...options, replies: [...scenario.replies] });
    // The handshake's forced resend fires first (height 0), so what follows is the card's own story.
    await sleep(50);
    await reveal(host);
    // Let the follow-up polls run through the scripted outcomes, then a load event.
    await sleep(120);
    host.win.dispatchEvent(new host.win.Event('load'));
    await sleep(40);
    return { heights: host.heights(), sizes: host.sizes() };
  }

  for (const [cardHeight, width] of [[300, 600], [100, 420], [500, 760]] as const) {
    test(`A=${cardHeight} width=${width}: identical host messages for every outside outcome; H = min(A + ${R}, ${CAP})`, async () => {
      const H = Math.min(cardHeight + R, CAP);
      const baseline = await transcript(outcomes[0]!, { cardHeight, width });
      expect(baseline.heights).toContain(H);
      // Working card (closed), then revealed (H), whatever follows: never a measured total, never a change on withdrawal.
      expect(baseline.heights.every((height) => height === 0 || height === 90 || height === H)).toBe(true);
      expect(baseline.sizes.every((size: any) => size.height === 0 || size.height === 90 || size.height === H)).toBe(true);
      expect(baseline.sizes.filter((size: any) => size.height === H).every((size: any) => size.width === width)).toBe(true);
      for (const scenario of outcomes.slice(1)) {
        const other = await transcript(scenario, { cardHeight, width });
        expect(other.heights, scenario.name).toEqual(baseline.heights);
        expect(other.sizes, scenario.name).toEqual(baseline.sizes);
      }
    }, 20_000);
  }

  test('a card taller than 640 − R scrolls inside the card: the follow class is set, the cap holds', async () => {
    const host = mount({ cardHeight: 2_000, replies: [{ envelope: { followSeconds: 0 } }] });
    await reveal(host);
    await sleep(30);
    expect(host.doc.querySelector('section.card.follow')).not.toBeNull();
    expect(host.heights().at(-1)).toBe(CAP);
    const html = privateAnswerResourceHtml();
    expect(html).toContain('html:root>body #panel>.card.follow{max-height:464px!important;overflow:auto!important}');
    expect(html).toContain('.out-head{position:sticky;top:0;');
    expect(CAP - R).toBe(464);
  });

  test('the reserved allocation R is the outside box plus its gap above, from the CSS constants', async () => {
    // happy-dom does no layout, so the bound is asserted from what the CSS and the inline style say.
    const host = mount({ replies: [{ envelope: { followSeconds: 0 } }] });
    await reveal(host);
    const box = host.outside()!;
    const boxHeight = Number.parseInt(box.style.height, 10);
    const margin = /\.outside\{[^}]*margin:(\d+)px 0 0;/.exec(privateAnswerResourceHtml())![1];
    expect(boxHeight + Number(margin)).toBe(R);
    expect(CHATGPT_PRIVATE_ANSWER_OUTSIDE_GAP_PX).toBe(Number(margin));
    expect(boxHeight).toBe(R - CHATGPT_PRIVATE_ANSWER_OUTSIDE_GAP_PX);
    // Padding stays off the box itself, so the inline height is the whole border box (box-sizing: border-box).
    expect(privateAnswerResourceHtml()).toMatch(/\.outside\{[^}]*box-sizing:border-box;[^}]*padding:0;/);
  });

  test('a delayed handshake and the fallback both report H, never a measured total', async () => {
    const late = mount({ initAfterMs: 400, heightResendMs: 20, replies: [{ envelope: { followSeconds: 0, outside: { state: 'appended', text: OUTSIDE_TEXT } } }] });
    await reveal(late);
    expect(late.heights()).toEqual([]);
    await late.until(() => late.heights().length >= 2, 'the handshake heights');
    expect(late.heights().every((height) => height === 300 + R)).toBe(true);
    const silent = mount({ initAfterMs: 'never', initFallbackMs: 40, heightResendMs: 20, replies: [{ envelope: { followSeconds: 0, outside: { state: 'pending' } } }] });
    await reveal(silent);
    await silent.until(() => silent.heights().length >= 1, 'the fallback height');
    expect(silent.heights().every((height) => height === 300 + R)).toBe(true);
  });

  test('a withdrawal from any prior outcome keeps reporting H, through a later load event and a width change', async () => {
    const withdrawnReply: Reply = { envelope: { rev: 5, state: 'withdrawn', followSeconds: 100, answer: undefined, citations: undefined, unanswered: undefined, outside: { state: 'idle' } } };
    const runs: number[][] = [];
    for (const prior of [{ state: 'idle' }, { state: 'pending' }, { state: 'appended', text: OUTSIDE_TEXT }] as Outside[]) {
      const host = mount({ followPollMs: 15, replies: [{ envelope: { followSeconds: 300, outside: prior } }, withdrawnReply] });
      await sleep(50);
      await reveal(host);
      await host.until(() => host.text().includes(W.withdrawn), 'the withdrawal');
      await sleep(30);
      // A later notification, and a width change that shrinks the withdrawn card: still H.
      host.win.dispatchEvent(new host.win.Event('load'));
      const proto = (host.win as any).HTMLElement.prototype;
      Object.defineProperty(proto, 'offsetHeight', { configurable: true, get(this: any) { return this.classList?.contains('card') ? 60 : 0; } });
      host.win.dispatchEvent(new host.win.Event('load'));
      await sleep(20);
      runs.push(host.heights());
      expect(host.heights().at(-1)).toBe(300 + R);
      for (const wrong of [60, 60 + R, 90 + R]) expect(host.heights()).not.toContain(wrong);
    }
    expect(runs[1]).toEqual(runs[0]);
    expect(runs[2]).toEqual(runs[0]);
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

  test.each(HOSTILE)('%s: attribution stays, text nodes only, geometry unchanged', async (_name, text) => {
    const benign = mount({ replies: [{ envelope: { followSeconds: 0, outside: { state: 'appended', text: OUTSIDE_TEXT } } }] });
    await reveal(benign);
    await sleep(40);
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
    // The geometry is exactly the benign transcript.
    expect(host.heights()).toEqual(benign.heights());
    expect(host.sizes()).toEqual(benign.sizes());
    expect(outside.style.height).toBe(`${R - CHATGPT_PRIVATE_ANSWER_OUTSIDE_GAP_PX}px`);
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
