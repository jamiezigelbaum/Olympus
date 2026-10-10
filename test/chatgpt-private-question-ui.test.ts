/**
 * The private question panel (ui://olympus/private-question), driven in
 * happy-dom against a fake MCP Apps host and a fake relay. The relay opens
 * the question the panel sealed with the engine's own helpers
 * (private-answer-crypto.ts) and seals the outcome back to the panel's key,
 * so both directions are proven end to end. A fake IndexedDB stands in for
 * the frame's key store, shared between mounts to prove a re-mount collects
 * instead of asking twice.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import { PRIVATE_QUESTION_META_KEY, type PrivateQuestionResultV1 } from '../src/workers/chatgpt/private-question-contract.ts';
import {
  generateEngineKeyPair,
  importPanelPublicKey,
  openPrivateQuestion,
  padPrivateAnswerPlaintext,
  sealPrivateAnswer,
} from '../src/workers/chatgpt/private-answer-crypto.ts';
import { PRIVATE_ANSWER_RELAY_ORIGIN } from '../src/workers/chatgpt/private-answer-resource.ts';
import { privateQuestionPageHtml, privateQuestionResourceHtml, privateQuestionResourceMeta } from '../src/workers/chatgpt/private-question-resource.ts';
import { DASHBOARD_CHATGPT_PRIVATE_QUESTION_COPY as W } from '../src/workers/dashboard/vocabulary.ts';

const RELAY = PRIVATE_ANSWER_RELAY_ORIGIN;
const JOB = `oly2p.${'a'.repeat(32)}.${'B'.repeat(43)}`;
const SECRET_QUESTION = 'My landlord at Orchard Lane wants 40% more rent next year. What are my options?';
const SECRET_ANSWER = 'A commercial tenant can usually negotiate, invoke a renewal clause, or move.';
const ANSWERED: PrivateQuestionResultV1 = {
  v: 1, state: 'answered', answer: SECRET_ANSWER, model: 'anthropic/claude-sonnet-5.5', level: 'strict', rewritten: true,
  sent: 'What options does a small business tenant usually have when a landlord proposes a large rent increase?', route: 'zkapi', networkIdentity: 'hidden',
};

interface Asked { url: string; body: any; opened: unknown }
interface Collected { url: string; body: any }
interface Host {
  win: Window;
  sent: any[];
  calls: Array<[string, unknown]>;
  asks: Asked[];
  collects: Collected[];
  anothers: Collected[];
  text(): string;
  field(): HTMLTextAreaElement;
  button(label: string): HTMLButtonElement;
  push(result: unknown): void;
  until(check: () => boolean, label: string): Promise<void>;
}

const hosts: Host[] = [];
afterEach(async () => {
  while (hosts.length) await hosts.pop()!.win.happyDOM.close();
});
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** A minimal IndexedDB: one versioned database, out-of-line keys, get/put/delete/openCursor. */
function fakeIndexedDb() {
  const stores = new Map<string, Map<string, any>>();
  const later = (fn: () => void) => setTimeout(fn, 0);
  const factory = {
    open(name: string, version: number) {
      const req: any = {};
      later(() => {
        const db = {
          objectStoreNames: { contains: (store: string) => stores.has(`${name}/${store}`) },
          createObjectStore: (store: string) => void stores.set(`${name}/${store}`, new Map()),
          close() {},
          transaction(storeName: string) {
            const map = stores.get(`${name}/${storeName}`);
            if (!map) throw new Error('NotFoundError');
            const tx: any = {};
            let outstanding = 0;
            const step = (req: any, run: () => void) => {
              outstanding++;
              later(() => { run(); req.onsuccess?.(); outstanding--; });
              return req;
            };
            const check = () => (outstanding === 0 ? tx.oncomplete?.() : later(check));
            later(check);
            tx.objectStore = () => ({
              get: (key: string) => { const r: any = {}; return step(r, () => { r.result = map.has(key) ? structuredClone(map.get(key)) : undefined; }); },
              put: (value: unknown, key: string) => { const r: any = {}; return step(r, () => { map.set(key, structuredClone(value)); }); },
              delete: (key: string) => { const r: any = {}; return step(r, () => { map.delete(key); }); },
              openCursor: () => {
                const r: any = {};
                const keys = [...map.keys()];
                const at = (i: number): any => step(r, () => {
                  const key = keys[i];
                  r.result = key === undefined ? null : { key, value: structuredClone(map.get(key)), delete: () => void map.delete(key), continue: () => void at(i + 1) };
                });
                return at(0);
              },
            });
            return tx;
          },
        };
        req.result = db;
        if (!stores.has(`${name}/keys`)) req.onupgradeneeded?.();
        req.onsuccess?.();
      });
      return req;
    },
  };
  return { factory, stores };
}

interface Engine { publicKey: string; privateKey: CryptoKey }
interface MountOptions {
  engine: Engine;
  idb?: ReturnType<typeof fakeIndexedDb>;
  /** The relay's reply to /ask: a status (202 accepts), or a network failure. */
  askReply?: number | 'throw';
  /** The relay's replies to a collection, in order; 'ready' seals `result`. */
  collectReplies?: Array<number | 'ready' | 'throw'>;
  result?: PrivateQuestionResultV1;
  pollCapMs?: number;
  /** The relay's reply to /another: 'opened' (a new job, JOB2, with the same engine key) or a status. */
  anotherReply?: number | 'opened';
}
const JOB2 = `oly2p.${'a'.repeat(32)}.${'C'.repeat(43)}`;
const jobOf = (url: string) => url.slice(url.indexOf('/private/') + '/private/'.length).split('/')[0]!;

function metaFor(engine: Engine, extra: Record<string, unknown> = {}) {
  return { [PRIVATE_QUESTION_META_KEY]: { v: 1, jobId: JOB, askKey: engine.publicKey, level: 'strict', cleanup: 'as_written', customInstruction: false, maxChars: 4000, ...extra } };
}

function mount(options: MountOptions): Host {
  const html = privateQuestionPageHtml({ relayOrigin: RELAY, secondMs: 1, pollCapMs: options.pollCapMs ?? 5_000, keyStore: { timeoutMs: 30 }, heightResendMs: 10, initFallbackMs: 20 });
  const start = html.indexOf('<script>') + '<script>'.length;
  const script = html.slice(start, html.indexOf('</script>', start));
  const win = new Window({ url: 'https://web-sandbox.oaiusercontent.com/' });
  win.document.write(html.slice(0, start - '<script>'.length) + html.slice(html.indexOf('</script>', start) + '</script>'.length));
  const sent: any[] = [];
  const calls: Host['calls'] = [];
  const asks: Asked[] = [];
  const collects: Collected[] = [];
  const anothers: Collected[] = [];
  const collectReplies = options.collectReplies ?? ['ready'];
  const dispatch = (data: unknown) => win.dispatchEvent(new win.MessageEvent('message', { data, source: parent as any }));
  const parent = {
    postMessage: (message: any) => {
      sent.push(message);
      if (message.method === 'ui/initialize') setTimeout(() => dispatch({ jsonrpc: '2.0', id: message.id, result: { hostContext: { theme: 'light' } } }), 0);
    },
  };
  Object.defineProperty(win, 'parent', { value: parent, configurable: true });
  Object.defineProperty(win, 'crypto', { value: globalThis.crypto, configurable: true });
  if (options.idb) Object.defineProperty(win, 'indexedDB', { value: options.idb.factory, configurable: true });
  const claimed = new Map<string, string>();
  Object.defineProperty(win, 'fetch', {
    configurable: true,
    value: async (url: string, init: any) => {
      const body = JSON.parse(init.body);
      const json = (status: number, value: unknown, headers: Record<string, string> = {}) =>
        new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json', ...headers } });
      if (url.endsWith('/ask')) {
        if (options.askReply === 'throw') throw new TypeError('Failed to fetch');
        const panel = await importPanelPublicKey(body.publicKey);
        let opened: unknown = 'undecipherable';
        if (panel) {
          try {
            opened = JSON.parse(await openPrivateQuestion(jobOf(url), options.engine.privateKey, panel.key, { iv: body.iv, ciphertext: body.ciphertext }));
          } catch { /* stays undecipherable */ }
        }
        asks.push({ url, body, opened });
        if (options.askReply !== undefined && options.askReply !== 202) return json(options.askReply, { status: 'x' });
        if (!claimed.has(jobOf(url))) claimed.set(jobOf(url), body.publicKey);
        return json(202, { status: 'pending' }, { 'Retry-After': '1' });
      }
      if (url.endsWith('/another')) {
        anothers.push({ url, body });
        if (options.anotherReply !== undefined && options.anotherReply !== 'opened') return json(options.anotherReply, { status: 'x' });
        return json(200, { status: 'opened', v: 1, meta: { v: 1, jobId: JOB2, askKey: options.engine.publicKey, level: 'standard', cleanup: 'light_cleanup', customInstruction: false, maxChars: 4000 } });
      }
      collects.push({ url, body });
      if (claimed.has(jobOf(url)) && claimed.get(jobOf(url)) !== body.publicKey) return json(409, { status: 'claimed' });
      const reply = collectReplies.length > 1 ? collectReplies.shift()! : collectReplies[0]!;
      if (reply === 'throw') throw new TypeError('Failed to fetch');
      if (reply === 'ready') {
        const panel = await importPanelPublicKey(body.publicKey);
        const sealed = await sealPrivateAnswer(jobOf(url), panel!.key, padPrivateAnswerPlaintext(JSON.stringify(options.result ?? ANSWERED)));
        return json(200, { status: 'ready', v: 1, ...sealed });
      }
      return json(reply, reply === 202 ? { status: 'pending' } : { status: 'x' }, reply === 202 ? { 'Retry-After': '1' } : {});
    },
  });
  (win as any).openai = {
    notifyIntrinsicHeight: (height: number) => calls.push(['notifyIntrinsicHeight', height]),
    setWidgetState: (args: unknown) => calls.push(['setWidgetState', args]),
    sendFollowUpMessage: (args: unknown) => calls.push(['sendFollowUpMessage', args]),
    callTool: (...args: unknown[]) => calls.push(['callTool', args]),
  };
  new Function('window', 'document', script)(win, win.document);
  const panel = () => win.document.getElementById('panel')!;
  const host: Host = {
    win,
    sent,
    calls,
    asks,
    collects,
    anothers,
    text: () => panel().textContent ?? '',
    field: () => panel().querySelector('textarea') as unknown as HTMLTextAreaElement,
    button: (label) => {
      const found = (Array.from(panel().querySelectorAll('button')) as unknown as HTMLButtonElement[]).find((node) => node.textContent === label);
      if (!found) throw new Error(`no button "${label}" in: ${host.text()}`);
      return found;
    },
    push: (result) => dispatch({ jsonrpc: '2.0', method: 'ui/notifications/tool-result', params: result }),
    until: async (check, label) => {
      for (let i = 0; i < 600; i++) {
        if (check()) return;
        await sleep(5);
      }
      throw new Error(`timed out waiting for ${label}; panel says: ${host.text()}`);
    },
  };
  hosts.push(host);
  return host;
}

function type(host: Host, text: string): void {
  const field = host.field();
  field.value = text;
  field.dispatchEvent(new host.win.Event('input') as unknown as Event);
}

/** Nothing of the question or the answer may reach the host: no tool call, no widget state, no follow-up, no message body. */
function expectNothingLeaked(host: Host): void {
  expect(host.calls.filter(([name]) => name !== 'notifyIntrinsicHeight')).toEqual([]);
  const toHost = JSON.stringify(host.sent);
  for (const secret of ['Orchard Lane', '40%', SECRET_ANSWER.slice(0, 20), JOB.split('.')[2]!]) expect(toHost).not.toContain(secret);
}

describe('the resource', () => {
  test('is self-contained and may contact only the relay', () => {
    const html = privateQuestionResourceHtml();
    expect(html).toContain(`${RELAY}`);
    expect(html).not.toMatch(/<script[^>]+src=/);
    expect(html).not.toMatch(/<link[^>]+href=/);
    expect(html).toContain('/ask');
    expect(privateQuestionResourceMeta()).toMatchObject({ ui: { csp: { connectDomains: [RELAY], resourceDomains: [] } } });
  });
});

describe('asking', () => {
  test('nothing shows without the tool result; then the form, sealed to the engine key, then the answer', async () => {
    const engine = await generateEngineKeyPair();
    const host = mount({ engine });
    await sleep(10);
    expect(host.text()).toBe('');
    host.push({ content: [], _meta: metaFor(engine) });
    expect(host.text()).toContain(W.title);
    expect(host.text()).toContain(W.notSeen);
    expect(host.field()).toBeTruthy();

    // Empty: told, nothing sent.
    host.button(W.send).click();
    await host.until(() => host.text().includes(W.empty), 'the empty notice');
    expect(host.asks).toHaveLength(0);

    // Too long: never clipped by the box; the count and the notice say how far over, nothing sent.
    expect(host.field().hasAttribute('maxlength')).toBe(false);
    type(host, 'x'.repeat(4_321));
    expect(host.text()).toContain('4,321 / 4,000 characters');
    host.button(W.send).click();
    await host.until(() => host.text().includes('The question is 4,321 characters; keep it under 4,000.'), 'the too-long notice');
    expect(host.asks).toHaveLength(0);

    type(host, SECRET_QUESTION);
    expect(host.text()).toContain(`${SECRET_QUESTION.length} / 4,000 characters`);
    host.button(W.send).click();
    await host.until(() => host.text().includes(SECRET_ANSWER), 'the answer');
    expect(host.asks).toHaveLength(1);
    const ask = host.asks[0]!;
    expect(ask.url).toBe(`${RELAY}/private/${JOB}/ask`);
    expect(ask.body).toMatchObject({ v: 1 });
    expect(Object.keys(ask.body).sort()).toEqual(['ciphertext', 'iv', 'publicKey', 'v']);
    expect(ask.body.publicKey).toMatch(/^[A-Za-z0-9_-]{87}$/);
    // The relay saw ciphertext only; the engine side opened the question.
    expect(JSON.stringify(ask.body)).not.toContain('Orchard');
    expect(ask.opened).toEqual({ v: 1, question: SECRET_QUESTION, level: 'strict' });
    // Collected with the same key the ask used.
    expect(host.collects.length).toBeGreaterThan(0);
    expect(host.collects.every((c) => c.body.publicKey === ask.body.publicKey)).toBe(true);
    expect(host.text()).toContain('anthropic/claude-sonnet-5.5');
    expect(host.text()).toContain(W.howStrict);
    // What was sent is behind a toggle.
    expect(host.text()).not.toContain('small business tenant');
    host.button(W.showSent).click();
    expect(host.text()).toContain('small business tenant');
    expectNothingLeaked(host);
  });

  test('Standard with the saved preparation goes out as chosen; a refusal shows its message', async () => {
    const engine = await generateEngineKeyPair();
    const refusal: PrivateQuestionResultV1 = { v: 1, state: 'refused', code: 'spend_cap_reached', message: 'Today\'s spending limit is reached.' };
    const host = mount({ engine, result: refusal });
    host.push({ content: [], _meta: metaFor(engine, { level: 'standard', cleanup: 'custom', customInstruction: true }) });
    const select = host.win.document.getElementById('q-prep') as unknown as HTMLSelectElement;
    expect(select.value).toBe('custom');
    type(host, 'q');
    host.button(W.send).click();
    await host.until(() => host.text().includes('spending limit'), 'the refusal');
    expect(host.asks[0]!.opened).toEqual({ v: 1, question: 'q', level: 'standard', cleanup: 'custom' });
    expect(host.text()).toContain(W.notSent);
    expect(host.text()).not.toContain(W.mayHaveLeft);
    expectNothingLeaked(host);

    // A send that failed after the question left is never called "not sent": the panel says it may have been charged and shows what left.
    const left: PrivateQuestionResultV1 = { v: 1, state: 'refused', code: 'session_spent', message: 'The session ended before a reply.', outcome: 'unknown', sent: 'What options does a tenant usually have?' };
    const leftHost = mount({ engine, result: left });
    leftHost.push({ content: [], _meta: metaFor(engine) });
    type(leftHost, 'q');
    leftHost.button(W.send).click();
    await leftHost.until(() => leftHost.text().includes('before a reply'), 'the failed send');
    expect(leftHost.text()).toContain(W.mayHaveLeft);
    expect(leftHost.text()).not.toContain(W.notSent);
    leftHost.button(W.showSent).click();
    expect(leftHost.text()).toContain('tenant usually have');
    expectNothingLeaked(leftHost);
  });

  test('a re-mount while the answer is on its way collects it with the kept key instead of asking again', async () => {
    const engine = await generateEngineKeyPair();
    const idb = fakeIndexedDb();
    const first = mount({ engine, idb, collectReplies: [202] });
    first.push({ content: [], _meta: metaFor(engine) });
    type(first, SECRET_QUESTION);
    first.button(W.send).click();
    await first.until(() => first.collects.length > 0, 'the first collection');
    expect(first.text()).toContain(W.waiting);
    const key = first.asks[0]!.body.publicKey;
    await first.win.happyDOM.close();
    hosts.pop();

    const again = mount({ engine, idb });
    again.push({ content: [], _meta: metaFor(engine) });
    await again.until(() => again.text().includes(SECRET_ANSWER), 'the answer on re-mount');
    expect(again.asks).toHaveLength(0);
    expect(again.collects[0]!.body.publicKey).toBe(key);
    expectNothingLeaked(again);
  });

  test('the answer renders as Markdown built from text, never as HTML', async () => {
    const engine = await generateEngineKeyPair();
    const answer = '# Options\n\n**Bold** and <b>tag</b> with `code`\n\n- one\n- two\n  - deeper\n\n| A | B |\n|---|---|\n| 1 | 2 |\n\n> quoted\n\nSee [the site](https://example.com) not [this](javascript:alert(1)).';
    const host = mount({ engine, result: { ...ANSWERED, answer } });
    host.push({ _meta: metaFor(engine) });
    await host.until(() => !!host.field(), 'the form');
    host.field().value = SECRET_QUESTION;
    host.field().dispatchEvent(new host.win.Event('input') as unknown as Event);
    host.button(W.send).click();
    await host.until(() => host.text().includes('Options'), 'the answer');
    const doc = host.win.document;
    expect(doc.querySelector('.answer.md h3')?.textContent).toBe('Options');
    expect(doc.querySelector('.answer strong')?.textContent).toBe('Bold');
    expect(doc.querySelector('.answer code')?.textContent).toBe('code');
    expect(doc.querySelector('.answer b')).toBeNull();
    expect(host.text()).toContain('<b>tag</b>');
    expect(doc.querySelectorAll('.answer li').length).toBe(3);
    expect(doc.querySelector('.answer li ul')).not.toBeNull();
    expect(Array.from(doc.querySelectorAll('.answer td')).map((cell) => cell.textContent)).toEqual(['1', '2']);
    expect(doc.querySelector('.answer blockquote p')?.textContent).toBe('quoted');
    const links = Array.from(doc.querySelectorAll('.answer a'));
    expect(links.map((a) => [a.getAttribute('href'), a.getAttribute('rel'), a.getAttribute('target')])).toEqual([['https://example.com', 'noopener noreferrer', '_blank']]);
    expect(host.text()).toContain('[this](javascript:alert(1))');
    expect(doc.querySelector('.answer')?.innerHTML).not.toContain('<b>');
  });

  test('Ask another opens a new question in place from this computer; when it cannot, the host\'s way is shown', async () => {
    const engine = await generateEngineKeyPair();
    const idb = fakeIndexedDb();
    const host = mount({ engine, idb });
    host.push({ _meta: metaFor(engine) });
    await host.until(() => !!host.field(), 'the form');
    host.field().value = SECRET_QUESTION;
    host.field().dispatchEvent(new host.win.Event('input') as unknown as Event);
    host.button(W.send).click();
    await host.until(() => host.text().includes(SECRET_ANSWER), 'the answer');
    const askingKey = host.asks[0]!.body.publicKey;
    host.button(W.askAnother).click();
    await host.until(() => !!host.field(), 'the new form');
    expect(host.anothers).toEqual([{ url: `${RELAY}/private/${JOB}/another`, body: { v: 1, publicKey: askingKey } }]);
    expect(host.text()).not.toContain(W.askAgain);
    expect(host.text()).not.toContain(SECRET_ANSWER);
    // The new job's defaults (Standard, lightly cleaned) and a second question sealed to it, under its own id.
    host.field().value = 'Is ibuprofen safe with a blood thinner?';
    host.field().dispatchEvent(new host.win.Event('input') as unknown as Event);
    // The host re-delivers the original tool result on every event (live 2026-10-10: typing and the level were reset): the followed job stays.
    (host.win as any).openai.toolResponseMetadata = metaFor(engine);
    host.win.dispatchEvent(new host.win.Event('openai:set_globals'));
    host.push({ _meta: metaFor(engine) });
    await sleep(20);
    expect(host.field().value).toBe('Is ibuprofen safe with a blood thinner?');
    expect(host.anothers).toHaveLength(1);
    host.button(W.send).click();
    await host.until(() => host.asks.length === 2, 'the second ask');
    expect(host.asks[1]!.url).toBe(`${RELAY}/private/${JOB2}/ask`);
    expect(host.asks[1]!.opened).toEqual({ v: 1, question: 'Is ibuprofen safe with a blood thinner?', level: 'standard', cleanup: 'light_cleanup' });
    await host.until(() => host.text().includes(SECRET_ANSWER), 'the second answer');
    // A re-mount with the original tool result follows to the newest job instead of the first one's answer.
    const again = mount({ engine, idb });
    again.push({ _meta: metaFor(engine) });
    await again.until(() => again.text().includes(SECRET_ANSWER), 'the newest answer after a re-mount');
    expect([...new Set(again.collects.map((call) => call.url))]).toEqual([`${RELAY}/private/${JOB2}`]);
    expect(again.asks).toHaveLength(0);
    // Nothing of the questions reached the host.
    for (const h of [host, again]) expect(JSON.stringify([h.sent, h.calls])).not.toContain('ibuprofen');

    const gone = mount({ engine, anotherReply: 410 });
    gone.push({ _meta: metaFor(engine) });
    await gone.until(() => !!gone.field(), 'the form');
    gone.field().value = SECRET_QUESTION;
    gone.field().dispatchEvent(new gone.win.Event('input') as unknown as Event);
    gone.button(W.send).click();
    await gone.until(() => gone.text().includes(SECRET_ANSWER), 'the answer');
    gone.button(W.askAnother).click();
    await gone.until(() => gone.text().includes(W.askAgain), 'the host\'s way');
  });

  test('relay failures are told in plain words: unreachable, claimed, expired, offline, too slow', async () => {
    const engine = await generateEngineKeyPair();
    for (const [askReply, expected] of [['throw', W.unreachable], [409, W.claimed], [410, W.expired], [503, W.macOffline], [429, W.rateLimited]] as const) {
      const host = mount({ engine, askReply });
      host.push({ content: [], _meta: metaFor(engine) });
      type(host, 'q');
      host.button(W.send).click();
      await host.until(() => host.text().includes(expected), `${String(askReply)} → ${expected}`);
      expectNothingLeaked(host);
    }
    const slow = mount({ engine, collectReplies: [202], pollCapMs: 30 });
    slow.push({ content: [], _meta: metaFor(engine) });
    type(slow, 'q');
    slow.button(W.send).click();
    await slow.until(() => slow.text().includes(W.slow), 'the slow notice');
  });

  test('a malformed tool result shows nothing; a bad engine key never sends', async () => {
    const engine = await generateEngineKeyPair();
    const host = mount({ engine });
    for (const value of [{ v: 2, jobId: JOB, askKey: engine.publicKey }, { v: 1, jobId: 'nope', askKey: engine.publicKey }, { v: 1, jobId: JOB, askKey: 'short' }]) {
      host.push({ content: [], _meta: { [PRIVATE_QUESTION_META_KEY]: value } });
      expect(host.text()).toBe('');
    }
    await sleep(10);
    expect(host.asks).toHaveLength(0);
  });
});
