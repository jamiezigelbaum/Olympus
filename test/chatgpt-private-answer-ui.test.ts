/**
 * The private answer panel (ui://olympus/private-answer), driven in happy-dom
 * against a fake MCP Apps host and a fake relay that seals real answers with
 * the engine's own helpers (private-answer-crypto.ts) to the key the panel
 * posted, so decryption is proven end to end. A fake IndexedDB (structured
 * clone into an in-memory map, the way a browser stores a CryptoKey) stands in
 * for the frame's key store, shared between mounts to prove re-mounts.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import { PRIVATE_ANSWER_META_KEY } from '../src/workers/chatgpt/private-answer-contract.ts';
import { importPanelPublicKey, padPrivateAnswerPlaintext, sealPrivateAnswer } from '../src/workers/chatgpt/private-answer-crypto.ts';
import { PRIVATE_ANSWER_RELAY_ORIGIN, privateAnswerPageHtml, privateAnswerResourceHtml, privateAnswerResourceMeta } from '../src/workers/chatgpt/private-answer-resource.ts';
import { DASHBOARD_CHATGPT_PRIVATE_ANSWER_COPY as W } from '../src/workers/dashboard/vocabulary.ts';

const RELAY = PRIVATE_ANSWER_RELAY_ORIGIN;
const JOB = `oly2p.${'a'.repeat(32)}.${'B'.repeat(43)}`;
const SECRET_ANSWER = 'The lease on Orchard Lane ends 31 March.\n\nRenewal needs <b>90 days</b> notice.';
const SECRET_TITLES = ['Orchard lease.pdf', 'Landlord email', 'Renewal terms', 'Deposit receipt'];
const SECRET_GAP = 'the monthly rent';
const PLAINTEXT = { v: 1, answer: SECRET_ANSWER, citations: SECRET_TITLES.map((title) => ({ title, source: 'Dropbox' })), unanswered: [SECRET_GAP] };

type RelayReply = { status: number; body?: unknown; retryAfter?: string } | 'ready' | 'throw';

interface Fetched {
  url: string;
  init: any;
  body: { v: number; publicKey: string };
}

interface Host {
  win: Window;
  doc: Document;
  sent: any[];
  calls: Array<[string, unknown]>;
  fetched: Fetched[];
  replies: RelayReply[];
  text(): string;
  buttons(): HTMLButtonElement[];
  button(label: string): HTMLButtonElement;
  push(result: unknown): void;
  heights(): number[];
  until(check: () => boolean, label: string): Promise<void>;
}

const hosts: Host[] = [];
afterEach(async () => {
  while (hosts.length) await hosts.pop()!.win.happyDOM.close();
});
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const meta = (value: unknown) => ({ [PRIVATE_ANSWER_META_KEY]: value });
const DAY_MS = 24 * 60 * 60_000;

/** A minimal IndexedDB: one versioned database, out-of-line keys, get/put/openCursor. */
interface FakeIdb {
  factory: unknown;
  opened: string[];
  /** store name -> key -> stored (structured-cloned) value */
  stores: Map<string, Map<string, any>>;
}
function fakeIndexedDb(mode: 'ok' | 'throw' | 'error' | 'hang' = 'ok'): FakeIdb {
  const stores = new Map<string, Map<string, any>>();
  const opened: string[] = [];
  const later = (fn: () => void) => setTimeout(fn, 0);
  const factory = {
    open(name: string, version: number) {
      if (mode === 'throw') throw new Error('SecurityError: storage is not allowed here');
      opened.push(`${name}@${version}`);
      const req: any = {};
      later(() => {
        if (mode === 'hang') return;
        if (mode === 'error') return req.onerror?.();
        const db = {
          objectStoreNames: { contains: (store: string) => stores.has(store) },
          createObjectStore: (store: string) => void stores.set(store, new Map()),
          close() {},
          transaction(storeName: string) {
            const map = stores.get(storeName);
            if (!map) throw new Error('NotFoundError');
            const tx: any = {};
            let outstanding = 0;
            const step = (req: any, run: () => void) => {
              outstanding++;
              later(() => {
                run();
                req.onsuccess?.();
                outstanding--;
              });
              return req;
            };
            const check = () => (outstanding === 0 ? tx.oncomplete?.() : later(check));
            later(check);
            tx.objectStore = () => ({
              get: (key: string) => {
                const req: any = {};
                return step(req, () => { req.result = map.has(key) ? structuredClone(map.get(key)) : undefined; });
              },
              put: (value: unknown, key: string) => {
                const req: any = {};
                return step(req, () => { map.set(key, structuredClone(value)); req.result = key; });
              },
              openCursor: () => {
                const req: any = {};
                const keys = [...map.keys()];
                const at = (i: number): any => step(req, () => {
                  const key = keys[i];
                  req.result = key === undefined ? null : {
                    key,
                    value: structuredClone(map.get(key)),
                    delete: () => void map.delete(key),
                    continue: () => void at(i + 1),
                  };
                });
                return at(0);
              },
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
  return { factory, opened, stores };
}

const ready = (count = 3, jobId = JOB) => ({ content: [], structuredContent: { results: [] }, _meta: meta({ v: 1, count, state: 'ready', jobId }) });

/** A relay that binds the job to the first key that claims it, like the engine. */
interface Claim { key?: string }

function mount(options: { openai?: Record<string, any>; pollCapMs?: number; replies?: RelayReply[]; plaintext?: unknown; idb?: FakeIdb; claim?: Claim } = {}): Host {
  const html = privateAnswerPageHtml({ relayOrigin: RELAY, secondMs: 1, pollCapMs: options.pollCapMs ?? 5_000, keyStore: { timeoutMs: 30 } });
  const start = html.indexOf('<script>') + '<script>'.length;
  const script = html.slice(start, html.indexOf('</script>', start));
  const win = new Window({ url: 'https://web-sandbox.oaiusercontent.com/' });
  win.document.write(html.slice(0, start - '<script>'.length) + html.slice(html.indexOf('</script>', start) + '</script>'.length));
  const sent: any[] = [];
  const calls: Host['calls'] = [];
  const fetched: Fetched[] = [];
  const replies: RelayReply[] = options.replies ?? ['ready'];
  const dispatch = (data: unknown) => win.dispatchEvent(new win.MessageEvent('message', { data, source: parent as any }));
  const parent = {
    postMessage: (message: any) => {
      sent.push(message);
      if (message.method === 'ui/initialize') {
        setTimeout(() => dispatch({ jsonrpc: '2.0', id: message.id, result: { hostContext: { theme: 'light' } } }), 0);
      }
    },
  };
  Object.defineProperty(win, 'parent', { value: parent, configurable: true });
  Object.defineProperty(win, 'crypto', { value: globalThis.crypto, configurable: true });
  if (options.idb) Object.defineProperty(win, 'indexedDB', { value: options.idb.factory, configurable: true });
  Object.defineProperty(win, 'fetch', {
    configurable: true,
    value: async (url: string, init: any) => {
      const body = JSON.parse(init.body);
      fetched.push({ url, init, body });
      if (options.claim) {
        options.claim.key ??= body.publicKey;
        if (options.claim.key !== body.publicKey) return new Response(JSON.stringify({ status: 'claimed' }), { status: 409 });
      }
      const reply = replies.length > 1 ? replies.shift()! : replies[0]!;
      if (reply === 'throw') throw new TypeError('Failed to fetch');
      if (reply === 'ready') {
        const panel = await importPanelPublicKey(body.publicKey);
        const plaintext = padPrivateAnswerPlaintext(JSON.stringify(options.plaintext ?? PLAINTEXT));
        const sealed = await sealPrivateAnswer(url.slice(url.lastIndexOf('/') + 1), panel!.key, plaintext);
        return new Response(JSON.stringify({ status: 'ready', v: 1, ...sealed }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (reply.retryAfter) headers['Retry-After'] = reply.retryAfter;
      return new Response(JSON.stringify(reply.body ?? {}), { status: reply.status, headers });
    },
  });
  (win as any).openai = {
    ...options.openai,
    notifyIntrinsicHeight: (height: number) => calls.push(['notifyIntrinsicHeight', height]),
    setWidgetState: (args: unknown) => calls.push(['setWidgetState', args]),
    sendFollowUpMessage: (args: unknown) => calls.push(['sendFollowUpMessage', args]),
    callTool: (...args: unknown[]) => calls.push(['callTool', args]),
    openExternal: (args: unknown) => calls.push(['openExternal', args]),
  };
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
    until: async (check, label) => {
      for (let i = 0; i < 400; i++) {
        if (check()) return;
        await sleep(5);
      }
      throw new Error(`timed out waiting for ${label}; panel says: ${host.text()}`);
    },
  };
  hosts.push(host);
  return host;
}

const JARGON = ['lane', 'guard', 'job', 'token', 'key', 'relay', 'decrypt', 'encrypt', 'cipher', 'tier', 'secure_local', 'oly2p', 'model_downloading', 'no_model', 'undefined', 'null', 'NaN'];
function expectNoJargon(host: Host) {
  const text = host.text();
  for (const word of JARGON) expect(text).not.toContain(word);
}

async function reveal(host: Host, result = ready()): Promise<void> {
  host.push(result);
  await host.until(() => host.text().includes('31 March'), 'the answer');
}

describe('nothing to show', () => {
  test('renders nothing and reports zero height without a private match', async () => {
    const host = mount();
    await sleep(5);
    expect(host.text()).toBe('');
    expect(host.heights()).toEqual(expect.arrayContaining([0]));
    expect(host.heights().every((height) => height === 0)).toBe(true);
    const sizes = host.sent.filter((m) => m.method === 'ui/notifications/size-changed').map((m) => m.params.height);
    expect(sizes.length).toBeGreaterThan(0);
    expect(sizes.every((height) => height === 0)).toBe(true);

    for (const value of [undefined, { v: 1, count: 0, state: 'ready', jobId: JOB }, { v: 2, count: 3, state: 'ready', jobId: JOB }, { v: 1, count: 3, state: 'other' }]) {
      host.push({ content: [], _meta: value === undefined ? {} : meta(value) });
      expect(host.text()).toBe('');
    }
    // A count only in structuredContent is never read.
    host.push({ content: [], structuredContent: meta({ v: 1, count: 3, state: 'ready', jobId: JOB }) });
    expect(host.text()).toBe('');
    await sleep(10);
    expect(host.fetched).toHaveLength(0);
  });

  test('a match that goes away collapses back to zero height', () => {
    const host = mount({ replies: [{ status: 202, body: { status: 'pending' }, retryAfter: '30' }] });
    host.push(ready());
    expect(host.text()).toContain(W.title);
    host.push({ content: [], _meta: {} });
    expect(host.text()).toBe('');
    expect(host.heights().at(-1)).toBe(0);
  });
});

describe('the card while the answer is prepared', () => {
  test('a ready result starts collecting at once: lock circle, title, spinner line, no button', () => {
    const host = mount({ replies: [{ status: 202, body: { status: 'pending' }, retryAfter: '30' }] });
    host.push(ready(3));
    const panel = host.doc.getElementById('panel')!;
    expect(panel.querySelectorAll('section.card')).toHaveLength(1);
    expect(panel.querySelector('.card > .row > .icon > svg.lock')?.getAttribute('aria-hidden')).toBe('true');
    expect(panel.querySelector('.title')?.textContent).toBe('Private answer from your Mac');
    expect(panel.querySelector('.sub')?.textContent).toBe('Preparing the answer on your Mac…');
    expect(panel.querySelector('.sub .spinner')).not.toBeNull();
    expect(panel.querySelector('.badge')).toBeNull();
    expect(host.buttons()).toHaveLength(0);
    expect(host.heights().length).toBeGreaterThan(0);
    expectNoJargon(host);
  });

  test('reads window.openai.toolResponseMetadata, never toolOutput', async () => {
    const host = mount({ openai: { toolOutput: meta({ v: 1, count: 9, state: 'ready', jobId: JOB }), toolResponseMetadata: meta({ v: 1, count: 2, state: 'no_model' }) } });
    expect(host.text()).toContain(W.noModel);
    await sleep(10);
    expect(host.fetched).toHaveLength(0);
  });

  test('a ready result already in window.openai collects on first render', async () => {
    const host = mount({ openai: { toolResponseMetadata: meta({ v: 1, count: 2, state: 'ready', jobId: JOB }) } });
    await host.until(() => host.text().includes('31 March'), 'the answer');
    expect(host.fetched).toHaveLength(1);
  });

  test('no private model: the sentence, no button, no request', async () => {
    const host = mount();
    host.push({ content: [], _meta: meta({ v: 1, count: 4, state: 'no_model' }) });
    expect(host.doc.querySelector('.sub')?.textContent).toBe('Private answers need the private model on your Mac.');
    expect(host.buttons()).toHaveLength(0);
    await sleep(10);
    expect(host.fetched).toHaveLength(0);
    expectNoJargon(host);
  });

  test('model downloading: the percent, a thin bar, no button', () => {
    const host = mount();
    host.push({ content: [], _meta: meta({ v: 1, count: 2, state: 'model_downloading', percent: 40 }) });
    expect(host.doc.querySelector('.sub')?.textContent).toBe('The private model is downloading (40%)…');
    expect(host.doc.querySelector('[role=progressbar]')?.getAttribute('aria-valuenow')).toBe('40');
    expect(host.buttons()).toHaveLength(0);
    host.push({ content: [], _meta: meta({ v: 1, count: 2, state: 'model_downloading' }) });
    expect(host.text()).toContain('The private model is downloading…');
    expect(host.doc.querySelector('[role=progressbar]')).toBeNull();
    expect(host.fetched).toHaveLength(0);
    expectNoJargon(host);
  });

  test('the host theme sets the page theme', async () => {
    const host = mount();
    await sleep(5);
    expect(host.doc.documentElement.getAttribute('data-theme')).toBe('light');
    host.win.dispatchEvent(new host.win.MessageEvent('message', {
      data: { jsonrpc: '2.0', method: 'ui/notifications/host-context-changed', params: { theme: 'dark' } },
      source: (host.win as any).parent,
    }));
    expect(host.doc.documentElement.getAttribute('data-theme')).toBe('dark');
  });
});

describe('the reported height is the card, not the frame', () => {
  test('notifyIntrinsicHeight and size-changed carry the card\'s offsetHeight', async () => {
    const host = mount({ replies: [{ status: 202, body: { status: 'pending' }, retryAfter: '30' }] });
    const proto = (host.win as any).HTMLElement.prototype;
    Object.defineProperty(proto, 'offsetHeight', { configurable: true, get(this: any) { return this.classList?.contains('card') ? 74 : 0; } });
    Object.defineProperty(proto, 'offsetWidth', { configurable: true, get(this: any) { return this.classList?.contains('card') ? 640 : 0; } });
    Object.defineProperty(host.win.document.documentElement, 'clientHeight', { configurable: true, value: 150 });
    Object.defineProperty(host.win.document.documentElement, 'scrollHeight', { configurable: true, value: 224 });
    Object.defineProperty(host.win, 'innerHeight', { configurable: true, value: 150 });
    host.push(ready(1));
    await sleep(40);
    expect(host.heights().at(-1)).toBe(74);
    const sizes = host.sent.filter((m) => m.method === 'ui/notifications/size-changed').map((m) => m.params);
    expect(sizes.at(-1)).toEqual({ width: 640, height: 74 });
    for (const height of [...host.heights(), ...sizes.map((size) => size.height)]) {
      expect([0, 74]).toContain(height);
    }
    host.push({ content: [], _meta: {} });
    expect(host.heights().at(-1)).toBe(0);
  });

  test('the page has no margin, min-height, viewport height or background of its own', () => {
    const html = privateAnswerResourceHtml();
    expect(html).toContain('html:root,html:root>body{margin:0!important;padding:0!important;height:auto!important;min-height:0!important;display:block!important;background:transparent');
    // Only the download bar fills its own 4px track.
    expect(html).not.toMatch(/100vh|(?<!bar-fill\{)height:100%/);
  });
});

describe('collecting the private answer', () => {
  test('a job id that is not a private answer id never reaches the network', async () => {
    for (const bad of ['oly2x.abc.def', `oly2p.${'a'.repeat(32)}.${'B'.repeat(43)}/../mcp`, '../../mcp']) {
      const host = mount();
      host.push(ready(3, bad));
      await sleep(10);
      expect(host.fetched).toHaveLength(0);
      expect(host.text()).toContain(W.generic);
    }
  });

  test('polls with the same key on 202, then decrypts and reveals the answer in the card by itself', async () => {
    const host = mount({ replies: [{ status: 202, body: { status: 'pending' }, retryAfter: '2' }, { status: 202, body: { status: 'pending' } }, 'ready'] });
    host.push(ready());
    expect(host.doc.querySelector('.card .sub')?.textContent).toBe('Preparing the answer on your Mac…');
    expect(host.buttons()).toHaveLength(0);
    await host.until(() => host.text().includes('31 March'), 'the answer');

    expect(host.fetched).toHaveLength(3);
    const keys = new Set(host.fetched.map((call) => call.body.publicKey));
    expect(keys.size).toBe(1);
    for (const call of host.fetched) {
      expect(call.url).toBe(`${RELAY}/private/${JOB}`);
      expect(call.init.method).toBe('POST');
      expect(call.init.credentials).toBe('omit');
      expect(call.init.headers).toEqual({ 'content-type': 'application/json' });
      expect(Object.keys(call.body).sort()).toEqual(['publicKey', 'v']);
      expect(call.body.v).toBe(1);
      expect(call.body.publicKey).toMatch(/^[A-Za-z0-9_-]{87}$/);
    }

    const paragraphs = Array.from(host.doc.querySelectorAll('.answer p')).map((p) => p.textContent);
    expect(paragraphs).toEqual(['The lease on Orchard Lane ends 31 March.', 'Renewal needs <b>90 days</b> notice.']);
    expect(host.doc.querySelector('.answer b')).toBeNull();
    expect(host.text()).toContain('From: Orchard lease.pdf, Landlord email, Renewal terms and 1 more');
    expect(host.text()).toContain(`Not found in your private items: ${SECRET_GAP}`);
    expect(host.buttons().map((b) => b.textContent)).toEqual([W.hide]);
    expect(host.doc.querySelector('.row')!.lastElementChild!.textContent).toBe(W.hide);
    expect(host.doc.querySelector('.row .sub')?.textContent).toBe('Not sent to ChatGPT');
    // Everything stays inside the one card.
    const card = host.doc.querySelector('section.card')!;
    expect(host.doc.getElementById('panel')!.children).toHaveLength(1);
    expect(card.querySelector('.answer')).not.toBeNull();
    expect(card.querySelectorAll('.foot')).toHaveLength(2);
    // Revealing by itself does not pull focus into the frame.
    expect(host.doc.activeElement?.getAttribute('data-key')).toBeNull();
    expectNoJargon(host);
  });

  test('Hide collapses to "Private answer hidden · Show"; Show reuses the answer in memory without a new request', async () => {
    const host = mount();
    await reveal(host);
    host.button(W.hide).click();
    expect(host.text()).not.toContain('31 March');
    expect(host.doc.querySelector('.card .sub')?.textContent).toBe(W.hidden);
    expect(host.buttons().map((b) => b.textContent)).toEqual([W.show]);
    expect(host.buttons()[0]!.getAttribute('aria-label')).toBe('Show private answer');
    expect(host.doc.activeElement?.textContent).toBe(W.show);
    host.button(W.show).click();
    expect(host.text()).toContain('31 March');
    expect(host.doc.activeElement?.getAttribute('data-key')).toBe('answer');
    await sleep(10);
    expect(host.fetched).toHaveLength(1);
  });

  test('a new result forgets the previous answer and collects its own', async () => {
    const host = mount({ replies: ['ready', { status: 202, body: { status: 'pending' }, retryAfter: '30' }] });
    await reveal(host);
    host.push(ready(2, `oly2p.${'c'.repeat(32)}.${'D'.repeat(43)}`));
    expect(host.text()).not.toContain('31 March');
    expect(host.text()).toContain(W.preparing);
    await host.until(() => host.fetched.length === 2, 'the second collection');
    expect(host.fetched[1]!.url).toBe(`${RELAY}/private/oly2p.${'c'.repeat(32)}.${'D'.repeat(43)}`);
    expect(host.fetched[1]!.body.publicKey).not.toBe(host.fetched[0]!.body.publicKey);
  });

  const ERRORS: Array<[string, RelayReply, string, boolean]> = [
    ['200 failed', { status: 200, body: { status: 'failed' } }, 'Olympus couldn\'t answer this on your Mac.', false],
    ['409 claimed', { status: 409, body: { status: 'claimed' } }, 'This answer was already opened in another window.', false],
    ['410 gone', { status: 410, body: { status: 'gone' } }, 'This answer has expired. Ask again to get a new one.', false],
    ['429', { status: 429, body: { status: 'rate_limited' }, retryAfter: '5' }, 'Too many requests — try again in a moment.', true],
    ['503 mac offline', { status: 503, body: { status: 'mac_offline' } }, 'Your Mac is offline, so the private answer can\'t be shown.', true],
    ['network error', 'throw', W.unreachable, true],
    ['400', { status: 400, body: { status: 'invalid' } }, W.generic, false],
    ['403', { status: 403, body: { status: 'forbidden' } }, W.generic, false],
  ];
  for (const [name, reply, sentence, retry] of ERRORS) {
    test(`${name}: says so${retry ? ', with Try again' : ''}`, async () => {
      const host = mount({ replies: [reply] });
      host.push(ready());
      await host.until(() => host.text().includes(sentence), sentence);
      expect(host.doc.querySelector('.card .sub.warn')?.textContent).toBe(sentence);
      expect(host.buttons().map((b) => b.textContent)).toEqual(retry ? [W.tryAgain] : []);
      expectNoJargon(host);
    });
  }

  test('the claimed sentence is the 409 copy', () => {
    expect(W.claimed).toBe('This answer was already opened in another window.');
  });

  test('Try again after the Mac comes back uses the same key and shows the answer', async () => {
    const host = mount({ replies: [{ status: 503, body: { status: 'mac_offline' } }, 'ready'] });
    host.push(ready());
    await host.until(() => host.text().includes(W.macOffline), 'offline');
    host.button(W.tryAgain).click();
    await host.until(() => host.text().includes('31 March'), 'the answer');
    expect(new Set(host.fetched.map((call) => call.body.publicKey)).size).toBe(1);
  });

  test('a busy Mac (503 busy) keeps polling', async () => {
    const host = mount({ replies: [{ status: 503, body: { status: 'busy' }, retryAfter: '1' }, 'ready'] });
    await reveal(host);
  });

  test('polling stops at the cap and offers Try again', async () => {
    const host = mount({ pollCapMs: 30, replies: [{ status: 202, body: { status: 'pending' }, retryAfter: '2' }] });
    host.push(ready());
    await host.until(() => host.text().includes(W.slow), 'the slow notice');
    expect(host.buttons().map((b) => b.textContent)).toEqual([W.tryAgain]);
    const before = host.fetched.length;
    expect(before).toBeGreaterThan(1);
    host.replies.splice(0, host.replies.length, 'ready');
    host.button(W.tryAgain).click();
    await host.until(() => host.text().includes('31 March'), 'the answer');
    expect(new Set(host.fetched.map((call) => call.body.publicKey)).size).toBe(1);
  });

  test('a sealed answer that does not open is a plain error, not a crash', async () => {
    const host = mount({ plaintext: { v: 2, nope: true } });
    host.push(ready());
    await host.until(() => host.text().includes(W.generic), 'generic error');
  });
});

describe('the key across re-mounts', () => {
  test('a re-mounted panel finds the job\'s key in IndexedDB and posts the same public key', async () => {
    const idb = fakeIndexedDb();
    const claim: Claim = {};
    const first = mount({ idb, claim });
    await reveal(first);
    // ChatGPT re-mounts the widget (scroll, history, a follow-up).
    const second = mount({ idb, claim });
    await reveal(second);
    expect(second.fetched[0]!.body.publicKey).toBe(first.fetched[0]!.body.publicKey);

    expect(idb.opened.every((name) => name === 'olympus-private-answer@1')).toBe(true);
    const keys = idb.stores.get('keys')!;
    expect([...keys.keys()]).toEqual([JOB]);
    const stored = keys.get(JOB)!;
    expect(Object.keys(stored).sort()).toEqual(['createdAt', 'privateKey', 'publicKey']);
    expect(stored.publicKey).toBe(first.fetched[0]!.body.publicKey);
    expect(stored.privateKey.type).toBe('private');
    expect(stored.privateKey.extractable).toBe(false);
    expect(Math.abs(Date.now() - stored.createdAt)).toBeLessThan(10_000);
  });

  test('entries older than a day are deleted, and a stale entry for this job is not reused', async () => {
    const idb = fakeIndexedDb();
    // Mount once so the store exists, then plant old and fresh entries.
    await reveal(mount({ idb }), ready(3, `oly2p.${'f'.repeat(32)}.${'F'.repeat(43)}`));
    const keys = idb.stores.get('keys')!;
    const sample = keys.get(`oly2p.${'f'.repeat(32)}.${'F'.repeat(43)}`)!;
    keys.set(JOB, { ...sample, createdAt: Date.now() - DAY_MS - 1 });
    keys.set('oly2p.old', { ...sample, createdAt: Date.now() - 2 * DAY_MS });
    keys.set('oly2p.fresh', { ...sample, createdAt: Date.now() - 60_000 });

    const host = mount({ idb });
    await reveal(host);
    expect(host.fetched[0]!.body.publicKey).not.toBe(sample.publicKey);
    await sleep(30);
    expect(keys.has('oly2p.old')).toBe(false);
    expect(keys.has('oly2p.fresh')).toBe(true);
    expect(keys.get(JOB)!.publicKey).toBe(host.fetched[0]!.body.publicKey);
  });

  for (const mode of ['throw', 'error', 'hang'] as const) {
    test(`IndexedDB that ${mode === 'hang' ? 'never answers' : mode === 'throw' ? 'throws' : 'fails to open'}: the key lives in memory; a re-mount is told the answer was opened elsewhere`, async () => {
      const claim: Claim = {};
      const first = mount({ idb: fakeIndexedDb(mode), claim });
      await reveal(first);
      const second = mount({ idb: fakeIndexedDb(mode), claim });
      second.push(ready());
      await second.until(() => second.text().includes(W.claimed), 'the claimed sentence');
      expect(second.fetched[0]!.body.publicKey).not.toBe(first.fetched[0]!.body.publicKey);
    });
  }

  test('without IndexedDB at all the panel still answers', async () => {
    const host = mount();
    expect((host.win as any).indexedDB).toBeUndefined();
    await reveal(host);
  });
});

describe('privacy', () => {
  test('the decrypted answer, its sources and the key never leave the frame or reach storage', async () => {
    const logged: unknown[] = [];
    const original = { log: console.log, info: console.info, warn: console.warn, error: console.error, debug: console.debug };
    for (const name of Object.keys(original) as Array<keyof typeof original>) {
      console[name] = (...args: unknown[]) => logged.push(args);
    }
    try {
      const idb = fakeIndexedDb();
      const host = mount({ idb, openai: { widgetState: { note: 'host state' } } });
      await reveal(host);
      host.button(W.hide).click();
      host.button(W.show).click();
      expect(host.text()).toContain('31 March');
      const again = mount({ idb });
      await reveal(again);

      const secrets = ['31 March', 'Orchard', '90 days', SECRET_GAP, ...SECRET_TITLES];
      const publicKey = host.fetched[0]!.body.publicKey;
      for (const panel of [host, again]) {
        const outbound = JSON.stringify({ sent: panel.sent, calls: panel.calls, fetched: panel.fetched.map((f) => [f.url, f.init.headers, f.init.method]) });
        for (const secret of secrets) expect(outbound).not.toContain(secret);
        // The host hears only the handshake and sizes: no widget state, model context, messages or tool calls.
        expect(new Set(panel.sent.map((m) => m.method))).toEqual(new Set(['ui/initialize', 'ui/notifications/initialized', 'ui/notifications/size-changed']));
        expect(panel.calls.map(([name]) => name).filter((name) => name !== 'notifyIntrinsicHeight')).toEqual([]);
        // Neither the job id nor any key material reaches the host.
        const hostBound = JSON.stringify({ sent: panel.sent, calls: panel.calls, widgetState: (panel.win as any).openai.widgetState ?? null });
        expect(hostBound).not.toContain(JOB);
        expect(hostBound).not.toContain(publicKey);
        expect(hostBound).not.toContain('privateKey');
        expect(panel.win.localStorage.length).toBe(0);
        expect(panel.win.sessionStorage.length).toBe(0);
        expect(panel.win.location.href).toBe('https://web-sandbox.oaiusercontent.com/');
      }
      // IndexedDB holds the key pair only: never the answer or its sources.
      for (const value of idb.stores.get('keys')!.values()) {
        expect(Object.keys(value).sort()).toEqual(['createdAt', 'privateKey', 'publicKey']);
        const plain = JSON.stringify({ publicKey: value.publicKey, createdAt: value.createdAt });
        for (const secret of secrets) expect(plain).not.toContain(secret);
      }
      expect(logged).toEqual([]);
    } finally {
      Object.assign(console, original);
    }
  });

  test('the page contacts only the relay, builds text only and reaches no other origin', () => {
    const html = privateAnswerResourceHtml();
    const urls = html.match(/https?:\/\/[^\s"'<>)\\]+/g) ?? [];
    // The SVG namespace is an identifier, not a request.
    expect([...new Set(urls)].sort()).toEqual(['http://www.w3.org/2000/svg', RELAY]);
    expect(privateAnswerResourceMeta()).toMatchObject({ ui: { csp: { connectDomains: [RELAY], resourceDomains: [] } } });
    for (const forbidden of ['innerHTML', 'outerHTML', 'insertAdjacentHTML', 'document.write', 'localStorage', 'sessionStorage', 'setWidgetState', 'widgetState', 'update-model-context', 'ui/message', 'tools/call', 'console.', 'confirm(', 'clipboard', 'eval(', 'extractable']) {
      expect(html).not.toContain(forbidden);
    }
    expect(html).not.toMatch(/<script[^>]+src=|<link[^>]+href=|@import|[^A-Za-z0-9]url\(/);
  });
});

describe('the card never fills the host frame', () => {
  // Live 2026-10-01: ChatGPT desktop drew a one-line card about 440px tall,
  // the grey surface stretched to the frame's starting height.
  test('sizing rules beat host styles that stretch the page', () => {
    const html = privateAnswerResourceHtml();
    expect(html).toContain('html:root,html:root>body{margin:0!important;padding:0!important;height:auto!important;min-height:0!important;display:block!important');
    expect(html).toContain('html:root>body #panel{display:block!important;height:auto!important;min-height:0!important}');
    expect(html).toContain('html:root>body #panel>.card{display:block!important;height:auto!important;min-height:0!important;max-height:none!important;flex:none!important;align-self:flex-start!important}');
  });
});
