/**
 * The private answer panel (ui://olympus/private-answer), driven in happy-dom
 * against a fake MCP Apps host and a fake relay that seals real answers with
 * the engine's own helpers (private-answer-crypto.ts) to the key the panel
 * posted, so decryption is proven end to end.
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
const ready = (count = 3, jobId = JOB) => ({ content: [], structuredContent: { results: [] }, _meta: meta({ v: 1, count, state: 'ready', jobId }) });

function mount(options: { openai?: Record<string, any>; pollCapMs?: number; replies?: RelayReply[]; plaintext?: unknown } = {}): Host {
  const html = privateAnswerPageHtml({ relayOrigin: RELAY, secondMs: 1, pollCapMs: options.pollCapMs ?? 5_000 });
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
  Object.defineProperty(win, 'fetch', {
    configurable: true,
    value: async (url: string, init: any) => {
      const body = JSON.parse(init.body);
      fetched.push({ url, init, body });
      const reply = replies.length > 1 ? replies.shift()! : replies[0]!;
      if (reply === 'throw') throw new TypeError('Failed to fetch');
      if (reply === 'ready') {
        const panel = await importPanelPublicKey(body.publicKey);
        const plaintext = padPrivateAnswerPlaintext(JSON.stringify(options.plaintext ?? PLAINTEXT));
        const sealed = await sealPrivateAnswer(JOB, panel!.key, plaintext);
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

async function reveal(host: Host): Promise<void> {
  host.push(ready());
  host.button(W.show).click();
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
    expect(host.fetched).toHaveLength(0);
  });

  test('a match that goes away collapses back to zero height', () => {
    const host = mount();
    host.push(ready());
    expect(host.text()).toContain(W.title);
    host.push({ content: [], _meta: {} });
    expect(host.text()).toBe('');
    expect(host.heights().at(-1)).toBe(0);
  });
});

describe('the collapsed card', () => {
  test('lock, title, badge, the count and one Show button', () => {
    const host = mount();
    host.push(ready(3));
    const panel = host.doc.getElementById('panel')!;
    expect(panel.querySelector('svg.lock')?.getAttribute('aria-hidden')).toBe('true');
    expect(panel.querySelector('.title')?.textContent).toBe('Private answer from your Mac');
    expect(panel.querySelector('.badge')?.textContent).toBe('Not sent to ChatGPT');
    expect(host.text()).toContain('3 private items match');
    expect(host.buttons().map((b) => b.textContent)).toEqual(['Show private answer']);
    expect(host.buttons()[0]!.className).toBe('btn');
    expect(host.heights().length).toBeGreaterThan(0);
    expectNoJargon(host);
  });

  test('one item, and the 50 cap', () => {
    const host = mount();
    host.push(ready(1));
    expect(host.text()).toContain('1 private item matches');
    host.push(ready(50, `oly2p.${'b'.repeat(32)}.${'C'.repeat(43)}`));
    expect(host.text()).toContain('50+ private items match');
  });

  test('reads window.openai.toolResponseMetadata, never toolOutput', () => {
    const host = mount({ openai: { toolOutput: meta({ v: 1, count: 9, state: 'ready', jobId: JOB }), toolResponseMetadata: meta({ v: 1, count: 2, state: 'ready', jobId: JOB }) } });
    expect(host.text()).toContain('2 private items match');
  });

  test('no private model: the sentence, no button', () => {
    const host = mount();
    host.push({ content: [], _meta: meta({ v: 1, count: 4, state: 'no_model' }) });
    expect(host.text()).toContain('4 private items match');
    expect(host.text()).toContain('Private answers need the private model on your Mac.');
    expect(host.buttons()).toHaveLength(0);
    expectNoJargon(host);
  });

  test('model downloading: the percent, a thin bar, no button', () => {
    const host = mount();
    host.push({ content: [], _meta: meta({ v: 1, count: 2, state: 'model_downloading', percent: 40 }) });
    expect(host.text()).toContain('The private model is downloading (40%)…');
    expect(host.doc.querySelector('[role=progressbar]')?.getAttribute('aria-valuenow')).toBe('40');
    expect(host.buttons()).toHaveLength(0);
    host.push({ content: [], _meta: meta({ v: 1, count: 2, state: 'model_downloading' }) });
    expect(host.text()).toContain('The private model is downloading…');
    expect(host.doc.querySelector('[role=progressbar]')).toBeNull();
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

describe('Show private answer', () => {
  test('a job id that is not a private answer id never reaches the network', async () => {
    for (const bad of ['oly2x.abc.def', `oly2p.${'a'.repeat(32)}.${'B'.repeat(43)}/../mcp`, '../../mcp']) {
      const host = mount();
      host.push(ready(3, bad));
      host.button(W.show).click();
      await sleep(10);
      expect(host.fetched).toHaveLength(0);
      expect(host.text()).toContain(W.generic);
    }
  });

  test('polls with the same key on 202, then decrypts and renders the answer as text', async () => {
    const host = mount({ replies: [{ status: 202, body: { status: 'pending' }, retryAfter: '2' }, { status: 202, body: { status: 'pending' } }, 'ready'] });
    host.push(ready());
    host.button(W.show).click();
    expect(host.text()).toContain('Preparing the answer on your Mac…');
    expect(host.doc.querySelector('.spinner')).not.toBeNull();
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
    expect(host.doc.querySelector('.badge')?.textContent).toBe(W.badge);
    expectNoJargon(host);
  });

  test('Hide collapses to the card; Show again reuses the answer in memory without a new request', async () => {
    const host = mount();
    await reveal(host);
    host.button(W.hide).click();
    expect(host.text()).not.toContain('31 March');
    expect(host.text()).toContain('3 private items match');
    expect(host.doc.activeElement?.textContent).toBe(W.show);
    host.button(W.show).click();
    await host.until(() => host.text().includes('31 March'), 'the answer again');
    expect(host.fetched).toHaveLength(1);
  });

  test('a new result forgets the previous answer', async () => {
    const host = mount();
    await reveal(host);
    host.push(ready(2, `oly2p.${'c'.repeat(32)}.${'D'.repeat(43)}`));
    expect(host.text()).not.toContain('31 March');
    expect(host.text()).toContain('2 private items match');
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
      host.button(W.show).click();
      await host.until(() => host.text().includes(sentence), sentence);
      expect(host.buttons().map((b) => b.textContent)).toEqual(retry ? [W.tryAgain] : []);
      expectNoJargon(host);
    });
  }

  test('Try again after the Mac comes back uses the same key and shows the answer', async () => {
    const host = mount({ replies: [{ status: 503, body: { status: 'mac_offline' } }, 'ready'] });
    host.push(ready());
    host.button(W.show).click();
    await host.until(() => host.text().includes(W.macOffline), 'offline');
    host.button(W.tryAgain).click();
    await host.until(() => host.text().includes('31 March'), 'the answer');
    expect(new Set(host.fetched.map((call) => call.body.publicKey)).size).toBe(1);
  });

  test('a busy Mac (503 busy) keeps polling', async () => {
    const host = mount({ replies: [{ status: 503, body: { status: 'busy' }, retryAfter: '1' }, 'ready'] });
    host.push(ready());
    host.button(W.show).click();
    await host.until(() => host.text().includes('31 March'), 'the answer');
  });

  test('polling stops at the cap and offers Try again', async () => {
    const host = mount({ pollCapMs: 30, replies: [{ status: 202, body: { status: 'pending' }, retryAfter: '2' }] });
    host.push(ready());
    host.button(W.show).click();
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
    host.button(W.show).click();
    await host.until(() => host.text().includes(W.generic), 'generic error');
  });
});

describe('privacy', () => {
  test('the decrypted answer and its sources never leave the frame', async () => {
    const logged: unknown[] = [];
    const original = { log: console.log, info: console.info, warn: console.warn, error: console.error, debug: console.debug };
    for (const name of Object.keys(original) as Array<keyof typeof original>) {
      console[name] = (...args: unknown[]) => logged.push(args);
    }
    try {
      const host = mount();
      await reveal(host);
      host.button(W.hide).click();
      host.button(W.show).click();
      await host.until(() => host.text().includes('31 March'), 'the answer again');

      const secrets = ['31 March', 'Orchard', '90 days', SECRET_GAP, ...SECRET_TITLES];
      const outbound = JSON.stringify({ sent: host.sent, calls: host.calls, fetched: host.fetched.map((f) => [f.url, f.init]) });
      for (const secret of secrets) expect(outbound).not.toContain(secret);
      // The host hears only the handshake and sizes: no widget state, model context, messages or tool calls.
      expect(new Set(host.sent.map((m) => m.method))).toEqual(new Set(['ui/initialize', 'ui/notifications/initialized', 'ui/notifications/size-changed']));
      expect(host.calls.map(([name]) => name).filter((name) => name !== 'notifyIntrinsicHeight')).toEqual([]);
      // The job id goes only to the relay URL.
      expect(JSON.stringify({ sent: host.sent, calls: host.calls })).not.toContain(JOB);
      expect(host.win.localStorage.length).toBe(0);
      expect(host.win.sessionStorage.length).toBe(0);
      expect(host.win.location.href).toBe('https://web-sandbox.oaiusercontent.com/');
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
    for (const forbidden of ['innerHTML', 'outerHTML', 'insertAdjacentHTML', 'document.write', 'localStorage', 'sessionStorage', 'setWidgetState', 'update-model-context', 'ui/message', 'tools/call', 'console.', 'confirm(', 'clipboard', 'eval(']) {
      expect(html).not.toContain(forbidden);
    }
    expect(html).not.toMatch(/<script[^>]+src=|<link[^>]+href=|@import|[^A-Za-z0-9]url\(/);
  });
});
