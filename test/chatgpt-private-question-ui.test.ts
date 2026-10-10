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
}

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
  let claimed: string | undefined;
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
            opened = JSON.parse(await openPrivateQuestion(JOB, options.engine.privateKey, panel.key, { iv: body.iv, ciphertext: body.ciphertext }));
          } catch { /* stays undecipherable */ }
        }
        asks.push({ url, body, opened });
        if (options.askReply !== undefined && options.askReply !== 202) return json(options.askReply, { status: 'x' });
        claimed ??= body.publicKey;
        return json(202, { status: 'pending' }, { 'Retry-After': '1' });
      }
      collects.push({ url, body });
      if (claimed && claimed !== body.publicKey) return json(409, { status: 'claimed' });
      const reply = collectReplies.length > 1 ? collectReplies.shift()! : collectReplies[0]!;
      if (reply === 'throw') throw new TypeError('Failed to fetch');
      if (reply === 'ready') {
        const panel = await importPanelPublicKey(body.publicKey);
        const sealed = await sealPrivateAnswer(JOB, panel!.key, padPrivateAnswerPlaintext(JSON.stringify(options.result ?? ANSWERED)));
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

    type(host, SECRET_QUESTION);
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
    expectNothingLeaked(host);
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
