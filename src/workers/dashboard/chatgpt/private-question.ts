/**
 * The private question panel (`ui://olympus/private-question`): a question
 * ChatGPT never sees, asked anonymously through zkAPI from the user's own
 * computer (contract: src/workers/chatgpt/private-question-contract.ts;
 * design ~/Code/Claude/olympus-zkapi-rethink/DESIGN-2026-10-10.md).
 *
 * Rendered under an `open_private_question` result. It reads the job id and
 * the engine's job key from the widget-only `_meta`, shows a question field
 * with the Strict/Standard choice, seals what the user typed to that key with
 * its own per-job key pair (kept in this origin's IndexedDB, so a re-mount
 * while the answer is on its way collects it instead of losing it), posts it
 * to `<relayOrigin>/private/<jobId>/ask`, then collects the sealed outcome
 * like the private answer panel does (`POST /private/<jobId>`, pending →
 * ready) and renders it as text only.
 *
 * Nothing about the question or the outcome goes back to the host: no
 * tools/call, no widget state, no follow-up message. Like the private answer
 * panel, the page is self-contained (no external scripts, styles or fonts)
 * and builds every node with `textContent`.
 */
import { PRIVATE_QUESTION_META_KEY } from '../../chatgpt/private-question-contract.ts';
import { DASHBOARD_CHATGPT_PRIVATE_QUESTION_COPY } from '../vocabulary.ts';
import { CHATGPT_PRIVATE_ANSWER_CSS, CHATGPT_PRIVATE_ANSWER_JOB_ID, CHATGPT_PRIVATE_ANSWER_KEY_STORE } from './private-answer.ts';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

export interface ChatGptPrivateQuestionConfig {
  relayOrigin: string;
  metaKey: string;
  jobIdPattern: string;
  copy: typeof DASHBOARD_CHATGPT_PRIVATE_QUESTION_COPY;
  secondMs: number;
  /** How long one collection keeps polling: the ask lane may take up to 20 minutes. */
  pollCapMs: number;
  requestTimeoutMs: number;
  heightResendMs: number;
  initFallbackMs: number;
  keyStore: { database: string; store: string; maxAgeMs: number; timeoutMs: number };
}

export interface ChatGptPrivateQuestionPageOptions {
  relayOrigin: string;
  secondMs?: number;
  pollCapMs?: number;
  requestTimeoutMs?: number;
  heightResendMs?: number;
  initFallbackMs?: number;
  keyStore?: Partial<ChatGptPrivateQuestionConfig['keyStore']>;
}

/** The ask lane waits up to 20 minutes for a zkAPI answer; the panel waits a little longer. */
export const CHATGPT_PRIVATE_QUESTION_POLL_CAP_MS = 22 * 60_000;
export const CHATGPT_PRIVATE_QUESTION_REQUEST_TIMEOUT_MS = 20_000;
/** Its own store: a question's key must never be confused with an answer's. */
export const CHATGPT_PRIVATE_QUESTION_KEY_STORE = { ...CHATGPT_PRIVATE_ANSWER_KEY_STORE, database: 'olympus-private-question' };

export function chatgptPrivateQuestionProgram(config: ChatGptPrivateQuestionConfig): void {
  const doc = document;
  const root = doc.getElementById('panel') as HTMLElement;
  const T = config.copy;
  const JOB_ID = new RegExp(config.jobIdPattern);
  const SVG_NS = 'http://www.w3.org/2000/svg';

  type Meta = { jobId: string; askKey: string; level: string; cleanup: string; customInstruction: boolean; maxChars: number };
  type Result =
    | { state: 'answered'; answer: string; model: string; level: string; cleanup: string; rewritten: boolean; sent: string; route: string; network: string }
    | { state: 'refused'; message: string };
  let info: Meta | null = null;
  // compose | sending | waiting | done | error | gone
  let phase = 'compose';
  let result: Result | null = null;
  let errorText = '';
  let canRetry = false;
  let draft = '';
  let level = '';
  let cleanup = '';
  let sentOpen = false;
  let pair: { jobId: string; privateKey: CryptoKey; publicKey: string } | null = null;
  let run = 0;
  let theme = '';
  let focusAfter = '';

  // ---- host bridge -------------------------------------------------------
  let nextId = 1;
  const pending: Record<number, (result: Any) => void> = {};
  function post(message: Any): void {
    if (window.parent && window.parent !== window) window.parent.postMessage(message, '*');
  }
  function request(method: string, params: Any, onResult: (result: Any) => void): void {
    const id = nextId++;
    pending[id] = onResult;
    post({ jsonrpc: '2.0', id, method, params });
  }
  function notify(method: string, params?: Any): void {
    post({ jsonrpc: '2.0', method, params: params || {} });
  }
  function openai(): Any {
    return (window as Any).openai || null;
  }
  window.addEventListener('message', (event: MessageEvent) => {
    if (event.source !== window.parent) return;
    const message = event.data;
    if (!message || message.jsonrpc !== '2.0') return;
    if (message.id !== undefined && pending[message.id]) {
      const done = pending[message.id]!;
      delete pending[message.id];
      done(message.result);
      return;
    }
    if (message.method === 'ui/notifications/tool-result' && message.params) accept(message.params._meta);
    else if (message.method === 'ui/notifications/host-context-changed') hostContext(message.params);
  });
  function hostContext(context: Any): void {
    if (!context || typeof context !== 'object') return;
    if (context.theme === 'light' || context.theme === 'dark') {
      theme = context.theme;
      render();
    }
  }
  function readGlobals(): void {
    const host = openai();
    if (!host) return;
    if (host.theme === 'light' || host.theme === 'dark') theme = host.theme;
    if (host.toolResponseMetadata) accept(host.toolResponseMetadata, true);
  }
  window.addEventListener('openai:set_globals', () => {
    const host = openai();
    if (!host) return;
    const before = theme;
    if (host.theme === 'light' || host.theme === 'dark') theme = host.theme;
    if (host.toolResponseMetadata) accept(host.toolResponseMetadata);
    if (theme !== before) render();
  });

  // ---- the tool result ---------------------------------------------------
  function accept(meta: Any, quiet?: boolean): void {
    const value = meta && typeof meta === 'object' ? meta[config.metaKey] : undefined;
    if (value === undefined && info) return;
    let next: Meta | null = null;
    if (value && typeof value === 'object' && value.v === 1 && typeof value.jobId === 'string' && JOB_ID.test(value.jobId)
      && typeof value.askKey === 'string' && /^[A-Za-z0-9_-]{87}$/.test(value.askKey)) {
      next = {
        jobId: value.jobId,
        askKey: value.askKey,
        level: value.level === 'strict' ? 'strict' : 'standard',
        cleanup: value.cleanup === 'light_cleanup' || value.cleanup === 'custom' ? value.cleanup : 'as_written',
        customInstruction: value.customInstruction === true,
        maxChars: typeof value.maxChars === 'number' && isFinite(value.maxChars) && value.maxChars > 0 ? Math.floor(value.maxChars) : 4000,
      };
    }
    if (info && next && info.jobId === next.jobId) return;
    if (!info && !next) return;
    run++;
    info = next;
    phase = 'compose';
    result = null;
    errorText = '';
    canRetry = false;
    draft = '';
    level = next ? next.level : '';
    cleanup = next ? next.cleanup : '';
    sentOpen = false;
    pair = null;
    if (!quiet || next) render();
    // A re-mount after the question went: collect instead of asking again.
    if (next) void resume(next.jobId);
  }

  async function resume(jobId: string): Promise<void> {
    const mine = run;
    const kept = await keptKey(jobId);
    if (mine !== run || !kept || !kept.asked) return;
    pair = { jobId, privateKey: kept.privateKey, publicKey: kept.publicKey };
    phase = 'waiting';
    render();
    void collect(false);
  }

  // ---- crypto ------------------------------------------------------------
  const subtle: SubtleCrypto | null = (window as Any).crypto && (window as Any).crypto.subtle ? (window as Any).crypto.subtle : null;
  const utf8 = (text: string) => new TextEncoder().encode(text);
  function fromB64url(text: Any): Uint8Array | null {
    if (typeof text !== 'string' || !text || !/^[A-Za-z0-9_-]+$/.test(text)) return null;
    let s = text.replace(/-/g, '+').replace(/_/g, '/');
    while (s.length % 4) s += '=';
    const bin = atob(s);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  function toB64url(bytes: Uint8Array): string {
    let bin = '';
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]!);
    return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }
  async function keyPair(jobId: string): Promise<{ jobId: string; privateKey: CryptoKey; publicKey: string }> {
    if (pair && pair.jobId === jobId) return pair;
    const kept = await keptKey(jobId);
    if (kept) {
      pair = { jobId, privateKey: kept.privateKey, publicKey: kept.publicKey };
      return pair;
    }
    const made = await subtle!.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']) as CryptoKeyPair;
    const raw = new Uint8Array(await subtle!.exportKey('raw', made.publicKey));
    const fresh = { jobId, privateKey: made.privateKey, publicKey: toB64url(raw) };
    await keepKey(jobId, fresh.privateKey, fresh.publicKey, false);
    pair = fresh;
    return pair;
  }
  async function aesKey(privateKey: CryptoKey, peerRaw: Uint8Array, jobId: string, usage: KeyUsage): Promise<CryptoKey> {
    const peer = await subtle!.importKey('raw', peerRaw as BufferSource, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
    const shared = await subtle!.deriveBits({ name: 'ECDH', public: peer }, privateKey, 256);
    const ikm = await subtle!.importKey('raw', shared, 'HKDF', false, ['deriveKey']);
    return subtle!.deriveKey(
      { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: utf8(jobId) },
      ikm,
      { name: 'AES-GCM', length: 256 },
      false,
      [usage],
    );
  }
  /** Seals the question to the engine's job key with this panel's private key. */
  async function seal(jobId: string, privateKey: CryptoKey, askKey: string, plaintext: string): Promise<{ iv: string; ciphertext: string }> {
    const engineRaw = fromB64url(askKey);
    if (!engineRaw || engineRaw.length !== 65) throw new Error('malformed');
    const key = await aesKey(privateKey, engineRaw, jobId, 'encrypt');
    const iv = (window as Any).crypto.getRandomValues(new Uint8Array(12));
    const ciphertext = await subtle!.encrypt({ name: 'AES-GCM', iv, additionalData: utf8(jobId) }, key, utf8(plaintext));
    return { iv: toB64url(iv), ciphertext: toB64url(new Uint8Array(ciphertext)) };
  }
  async function open(jobId: string, privateKey: CryptoKey, sealed: Any): Promise<Any> {
    const macRaw = fromB64url(sealed.macPublicKey);
    const iv = fromB64url(sealed.iv);
    const ciphertext = fromB64url(sealed.ciphertext);
    if (!macRaw || macRaw.length !== 65 || !iv || iv.length !== 12 || !ciphertext) throw new Error('malformed');
    const key = await aesKey(privateKey, macRaw, jobId, 'decrypt');
    const plain = await subtle!.decrypt({ name: 'AES-GCM', iv: iv as BufferSource, additionalData: utf8(jobId) }, key, ciphertext as BufferSource);
    return JSON.parse(new TextDecoder().decode(plain).replace(/\s+$/, ''));
  }

  // ---- the key store (IndexedDB, this origin only) --------------------------
  const KS = config.keyStore;
  function openStore(): Promise<IDBDatabase | null> {
    return new Promise((resolve) => {
      let settled = false;
      const finish = (db: IDBDatabase | null) => {
        if (settled) {
          if (db) try { db.close(); } catch { /* closed */ }
          return;
        }
        settled = true;
        resolve(db);
      };
      try {
        const factory = (window as Any).indexedDB;
        if (!factory || typeof factory.open !== 'function') return finish(null);
        const opening = factory.open(KS.database, 1);
        opening.onupgradeneeded = () => {
          try {
            const db = opening.result;
            if (!db.objectStoreNames.contains(KS.store)) db.createObjectStore(KS.store);
          } catch { /* the open then fails */ }
        };
        opening.onsuccess = () => finish(opening.result);
        opening.onerror = () => finish(null);
        opening.onblocked = () => finish(null);
        setTimeout(() => finish(null), KS.timeoutMs);
      } catch {
        finish(null);
      }
    });
  }
  async function inStore(mode: IDBTransactionMode, work: (store: IDBObjectStore) => IDBRequest | void): Promise<Any> {
    const db = await openStore();
    if (!db) return undefined;
    return new Promise((resolve) => {
      let settled = false;
      const finish = (value: Any) => {
        if (settled) return;
        settled = true;
        try { db.close(); } catch { /* closed */ }
        resolve(value);
      };
      try {
        const tx = db.transaction(KS.store, mode);
        const req = work(tx.objectStore(KS.store));
        tx.oncomplete = () => finish(req ? req.result : true);
        tx.onerror = () => finish(undefined);
        tx.onabort = () => finish(undefined);
        setTimeout(() => finish(undefined), KS.timeoutMs);
      } catch {
        finish(undefined);
      }
    });
  }
  async function keptKey(jobId: string): Promise<{ privateKey: CryptoKey; publicKey: string; asked: boolean } | null> {
    try {
      const value = await inStore('readwrite', (store) => {
        const read = store.get(jobId);
        read.onsuccess = () => {
          const found = read.result;
          if (found && (typeof found.createdAt !== 'number' || Date.now() - found.createdAt >= KS.maxAgeMs)) store.delete(jobId);
        };
        return read;
      });
      if (!value || typeof value !== 'object') return null;
      const privateKey = value.privateKey;
      const fresh = typeof value.createdAt === 'number' && Date.now() - value.createdAt < KS.maxAgeMs;
      if (!fresh || !privateKey || typeof privateKey !== 'object' || privateKey.type !== 'private') return null;
      if (typeof value.publicKey !== 'string' || !/^[A-Za-z0-9_-]{87}$/.test(value.publicKey)) return null;
      return { privateKey, publicKey: value.publicKey, asked: value.asked === true };
    } catch {
      return null;
    }
  }
  async function keepKey(jobId: string, privateKey: CryptoKey, publicKey: string, asked: boolean): Promise<void> {
    try {
      await inStore('readwrite', (store) => {
        store.put({ privateKey, publicKey, asked, createdAt: Date.now() }, jobId);
      });
    } catch { /* memory only */ }
    void dropOldKeys();
  }
  async function dropOldKeys(): Promise<void> {
    try {
      const cutoff = Date.now() - KS.maxAgeMs;
      await inStore('readwrite', (store) => {
        const walk = store.openCursor();
        walk.onsuccess = () => {
          const cursor = walk.result;
          if (!cursor) return;
          const value = cursor.value;
          if (!value || typeof value.createdAt !== 'number' || value.createdAt < cutoff) cursor.delete();
          cursor.continue();
        };
      });
    } catch { /* nothing to drop */ }
  }

  // ---- sending and collecting ---------------------------------------------
  function wait(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
  function bounded<V>(work: Promise<V>, ms: number, controller: AbortController | null): Promise<V> {
    return new Promise<V>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (controller) try { controller.abort(); } catch { /* aborted */ }
        reject(new Error('timeout'));
      }, Math.max(0, ms));
      work.then((value) => { clearTimeout(timer); resolve(value); }, (error) => { clearTimeout(timer); reject(error); });
    });
  }
  function fail(text: string, retry: boolean): void {
    phase = 'error';
    errorText = text;
    canRetry = retry;
    focusAfter = 'status';
    render();
  }
  function readResult(value: Any): Result | null {
    if (!value || typeof value !== 'object' || value.v !== 1) return null;
    if (value.state === 'refused') return typeof value.message === 'string' ? { state: 'refused', message: value.message } : null;
    if (value.state !== 'answered' || typeof value.answer !== 'string') return null;
    return {
      state: 'answered',
      answer: value.answer,
      model: typeof value.model === 'string' ? value.model : '',
      level: value.level === 'strict' ? 'strict' : 'standard',
      cleanup: typeof value.cleanup === 'string' ? value.cleanup : '',
      rewritten: value.rewritten === true,
      sent: typeof value.sent === 'string' ? value.sent : '',
      route: typeof value.route === 'string' ? value.route : '',
      network: value.networkIdentity === 'hidden' || value.networkIdentity === 'visible' ? value.networkIdentity : 'not_verified',
    };
  }

  async function send(): Promise<void> {
    if (!info || (phase !== 'compose' && phase !== 'error')) return;
    const question = draft.trim();
    if (!question) return fail(T.empty, true);
    if (question.length > info.maxChars) return fail(T.tooLong, true);
    if (!subtle || typeof (window as Any).fetch !== 'function') return fail(T.generic, false);
    const mine = ++run;
    const jobId = info.jobId;
    phase = 'sending';
    errorText = '';
    render();
    try {
      const keys = await keyPair(jobId);
      if (mine !== run) return;
      const plaintext = JSON.stringify({ v: 1, question, level, ...(level === 'standard' && cleanup ? { cleanup } : {}) });
      const sealed = await seal(jobId, keys.privateKey, info.askKey, plaintext);
      if (mine !== run) return;
      const controller = typeof (window as Any).AbortController === 'function' ? new (window as Any).AbortController() as AbortController : null;
      const response = await bounded<Response>((window as Any).fetch(config.relayOrigin + '/private/' + jobId + '/ask', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ v: 1, publicKey: keys.publicKey, iv: sealed.iv, ciphertext: sealed.ciphertext }),
        ...(controller ? { signal: controller.signal } : {}),
      }), config.requestTimeoutMs, controller);
      if (mine !== run) return;
      if (response.status === 202 || response.status === 200) {
        await keepKey(jobId, keys.privateKey, keys.publicKey, true);
        phase = 'waiting';
        render();
        return void collect(true);
      }
      if (response.status === 409) return fail(T.claimed, false);
      if (response.status === 410 || response.status === 404) return fail(T.expired, false);
      if (response.status === 503) return fail(T.macOffline, true);
      if (response.status === 429) return fail(T.rateLimited, true);
      return fail(T.generic, true);
    } catch (error) {
      if (mine !== run) return;
      fail(error instanceof Error && error.message === 'timeout' ? T.unreachable : T.unreachable, true);
    }
  }

  async function collect(byUser: boolean): Promise<void> {
    if (!info || !pair) return;
    const jobId = info.jobId;
    const keys = pair;
    const mine = run;
    phase = 'waiting';
    render();
    const deadline = Date.now() + config.pollCapMs;
    try {
      for (;;) {
        if (mine !== run) return;
        const left = deadline - Date.now();
        if (left <= 0) return fail(T.slow, true);
        const controller = typeof (window as Any).AbortController === 'function' ? new (window as Any).AbortController() as AbortController : null;
        let response: Response;
        let body: Any = null;
        try {
          response = await bounded<Response>((window as Any).fetch(config.relayOrigin + '/private/' + jobId, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ v: 1, publicKey: keys.publicKey }),
            ...(controller ? { signal: controller.signal } : {}),
          }), Math.min(config.requestTimeoutMs, left), controller);
          try { body = await bounded(response.json(), Math.min(config.requestTimeoutMs, deadline - Date.now()), controller); } catch { body = null; }
        } catch {
          if (mine !== run) return;
          await wait(config.secondMs * 5);
          continue;
        }
        if (mine !== run) return;
        if (response.status === 202) {
          const retry = parseInt(response.headers.get('retry-after') || '', 10);
          await wait(Math.min(Math.max(1, isFinite(retry) ? retry : 5), 30) * config.secondMs);
          continue;
        }
        if (response.status === 429) {
          await wait(config.secondMs * 5);
          continue;
        }
        if (response.status === 200 && body && body.status === 'ready') {
          const opened = readResult(await open(jobId, keys.privateKey, body));
          if (mine !== run) return;
          if (!opened) return fail(T.generic, false);
          result = opened;
          phase = 'done';
          focusAfter = 'answer';
          render();
          return;
        }
        if (response.status === 200 && body && body.status === 'failed') return fail(T.failed, false);
        if (response.status === 409) return fail(T.claimed, false);
        if (response.status === 410 || response.status === 404) return fail(T.expired, false);
        if (response.status === 503) {
          await wait(config.secondMs * 10);
          continue;
        }
        return fail(T.generic, false);
      }
    } catch {
      if (mine !== run) return;
      fail(T.generic, byUser);
    }
  }

  // ---- rendering ---------------------------------------------------------
  function el(tag: string, cls?: string, text?: string): HTMLElement {
    const node = doc.createElement(tag);
    if (cls) node.className = cls;
    if (text) node.textContent = text;
    return node;
  }
  function lockIcon(): HTMLElement {
    const wrap = el('div', 'icon');
    const svg = doc.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('class', 'lock');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('aria-hidden', 'true');
    const body = doc.createElementNS(SVG_NS, 'rect');
    body.setAttribute('x', '5'); body.setAttribute('y', '11'); body.setAttribute('width', '14'); body.setAttribute('height', '9'); body.setAttribute('rx', '2');
    const shackle = doc.createElementNS(SVG_NS, 'path');
    shackle.setAttribute('d', 'M8 11V7a4 4 0 0 1 8 0v4');
    svg.appendChild(body);
    svg.appendChild(shackle);
    wrap.appendChild(svg);
    return wrap;
  }
  function head(sub: string, warn?: boolean): HTMLElement {
    const row = el('div', 'row');
    row.appendChild(lockIcon());
    const text = el('div', 'text');
    text.appendChild(el('h2', 'title', T.title));
    const line = el('p', 'sub' + (warn ? ' warn' : ''), sub);
    line.setAttribute('data-key', 'status');
    line.setAttribute('tabindex', '-1');
    line.setAttribute('role', 'status');
    text.appendChild(line);
    row.appendChild(text);
    return row;
  }
  function composeView(current: Meta): HTMLElement {
    const card = el('div', 'card');
    card.appendChild(head(phase === 'error' ? errorText : T.notSeen, phase === 'error'));
    const form = el('div', 'q-form');
    const label = el('label', 'q-label', T.questionLabel);
    label.setAttribute('for', 'q-text');
    form.appendChild(label);
    const field = doc.createElement('textarea');
    field.className = 'q-field';
    field.id = 'q-text';
    field.rows = 4;
    field.maxLength = current.maxChars;
    field.value = draft;
    field.setAttribute('data-key', 'question');
    field.addEventListener('input', () => { draft = field.value; });
    field.addEventListener('keydown', (event: KeyboardEvent) => {
      if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) { event.preventDefault(); void send(); }
    });
    form.appendChild(field);
    const options = el('div', 'q-opts');
    options.appendChild(radio('level', 'strict', T.strict, T.strictHint, level === 'strict', () => { level = 'strict'; render(); }));
    options.appendChild(radio('level', 'standard', T.standard, T.standardHint, level === 'standard', () => { level = 'standard'; render(); }));
    form.appendChild(options);
    if (level === 'standard') {
      const prep = el('div', 'q-prep');
      const prepLabel = el('label', 'q-label', T.prepLabel);
      prepLabel.setAttribute('for', 'q-prep');
      prep.appendChild(prepLabel);
      const select = doc.createElement('select');
      select.className = 'q-select';
      select.id = 'q-prep';
      const choices: Array<[string, string]> = [['as_written', T.asWritten], ['light_cleanup', T.lightCleanup]];
      if (current.customInstruction) choices.push(['custom', T.custom]);
      for (const [value, text] of choices) {
        const option = doc.createElement('option');
        option.value = value;
        option.textContent = text;
        if (value === cleanup) option.selected = true;
        select.appendChild(option);
      }
      if (!choices.some(([value]) => value === cleanup)) cleanup = 'as_written';
      select.value = cleanup;
      select.addEventListener('change', () => { cleanup = select.value; });
      prep.appendChild(select);
      form.appendChild(prep);
    }
    const actions = el('div', 'q-actions');
    const button = el('button', 'btn q-send', T.send) as HTMLButtonElement;
    button.type = 'button';
    button.setAttribute('data-key', 'send');
    button.addEventListener('click', () => { void send(); });
    actions.appendChild(button);
    actions.appendChild(el('span', 'q-note', T.cost));
    form.appendChild(actions);
    card.appendChild(form);
    return card;
  }
  function radio(name: string, value: string, text: string, hint: string, checked: boolean, onPick: () => void): HTMLElement {
    const wrap = el('label', 'q-radio');
    const input = doc.createElement('input');
    input.type = 'radio';
    input.name = name;
    input.value = value;
    input.checked = checked;
    input.setAttribute('data-key', name + '-' + value);
    input.addEventListener('change', () => { if (input.checked) onPick(); });
    wrap.appendChild(input);
    const body = el('span', 'q-radio-text');
    body.appendChild(el('span', 'q-radio-name', text));
    body.appendChild(el('span', 'q-radio-hint', hint));
    wrap.appendChild(body);
    return wrap;
  }
  function workingView(text: string): HTMLElement {
    const card = el('div', 'card');
    card.appendChild(head(T.notSeen));
    const line = el('div', 'working');
    line.appendChild(el('span', 'spinner'));
    line.appendChild(el('span', 'sub', text));
    card.appendChild(line);
    return card;
  }
  function doneView(shown: Result): HTMLElement {
    const card = el('div', 'card');
    if (shown.state === 'refused') {
      card.appendChild(head(T.notSent, true));
      const text = el('div', 'answer', shown.message);
      text.setAttribute('data-key', 'answer');
      text.setAttribute('tabindex', '-1');
      card.appendChild(text);
      card.appendChild(againButton());
      return card;
    }
    card.appendChild(head(T.notSeen));
    const text = el('div', 'answer', shown.answer);
    text.setAttribute('data-key', 'answer');
    text.setAttribute('tabindex', '-1');
    card.appendChild(text);
    const how = shown.level === 'strict'
      ? T.howStrict
      : shown.cleanup === 'as_written' ? T.howAsWritten : shown.cleanup === 'custom' ? T.howCustom : T.howLightCleanup;
    const foot = [shown.model ? fill(T.answeredBy, { model: shown.model }) : '', how].filter(Boolean).join(' · ');
    card.appendChild(el('p', 'q-foot', foot));
    if (shown.network === 'visible') card.appendChild(el('p', 'q-foot warn', T.networkVisible));
    else if (shown.network === 'not_verified') card.appendChild(el('p', 'q-foot', T.networkUnverified));
    if (shown.rewritten && shown.sent) {
      const toggle = el('button', 'src-toggle', sentOpen ? T.hideSent : T.showSent) as HTMLButtonElement;
      toggle.type = 'button';
      toggle.setAttribute('aria-expanded', sentOpen ? 'true' : 'false');
      toggle.setAttribute('data-key', 'sent-toggle');
      toggle.addEventListener('click', () => { sentOpen = !sentOpen; focusAfter = 'sent-toggle'; render(); });
      card.appendChild(toggle);
      if (sentOpen) card.appendChild(el('pre', 'asked-text', shown.sent));
    }
    card.appendChild(againButton());
    return card;
  }
  function againButton(): HTMLElement {
    const actions = el('div', 'q-actions');
    const button = el('button', 'btn', T.askAnother) as HTMLButtonElement;
    button.type = 'button';
    button.setAttribute('data-key', 'again');
    button.addEventListener('click', () => {
      // A new question needs a new job (one sealed question per job): the user asks ChatGPT to open one.
      phase = 'gone';
      render();
    });
    actions.appendChild(button);
    return actions;
  }
  function fill(text: string, values: Record<string, string>): string {
    return text.replace(/\{(\w+)\}/g, (match, key: string) => (key in values ? values[key]! : match));
  }
  function render(): void {
    if (theme) doc.documentElement.setAttribute('data-theme', theme);
    else doc.documentElement.removeAttribute('data-theme');
    const active = doc.activeElement as HTMLElement | null;
    const had = active && root.contains(active) ? active.getAttribute('data-key') || '' : '';
    root.textContent = '';
    if (info) {
      if (phase === 'compose' || (phase === 'error' && canRetry)) root.appendChild(composeView(info));
      else if (phase === 'sending') root.appendChild(workingView(T.sending));
      else if (phase === 'waiting') root.appendChild(workingView(T.waiting));
      else if (phase === 'done' && result) root.appendChild(doneView(result));
      else if (phase === 'gone') {
        const card = el('div', 'card');
        card.appendChild(head(T.askAgain));
        root.appendChild(card);
      } else {
        const card = el('div', 'card');
        card.appendChild(head(errorText || T.generic, true));
        root.appendChild(card);
      }
    }
    if (!focusAfter && had) focusAfter = had;
    if (focusAfter) {
      const key = focusAfter;
      focusAfter = '';
      const target = root.querySelector('[data-key="' + key + '"]') as HTMLElement | null;
      if (target && typeof target.focus === 'function') target.focus();
    }
    observeCard();
    afterLayout();
  }

  // ---- height reporting (as the private answer panel does it) -------------
  function cardHeight(): number {
    return info && root.firstChild ? Math.ceil((root.firstChild as HTMLElement).offsetHeight || 0) : 0;
  }
  function cardWidth(): number {
    return info && root.firstChild ? Math.ceil((root.firstChild as HTMLElement).offsetWidth || 0) : 0;
  }
  let initialized = false;
  let lastHeight = -1;
  function reportHeight(force?: boolean): void {
    if (!initialized) return;
    const height = cardHeight();
    if (height === lastHeight && !force) return;
    lastHeight = height;
    const host = openai();
    if (host && typeof host.notifyIntrinsicHeight === 'function') host.notifyIntrinsicHeight(height);
    const width = cardWidth();
    notify('ui/notifications/size-changed', width > 0 ? { width, height } : { height });
  }
  let scheduled = false;
  function afterLayout(): void {
    if (scheduled) return;
    scheduled = true;
    const measure = () => { scheduled = false; reportHeight(); };
    const frame = (window as Any).requestAnimationFrame;
    if (typeof frame === 'function') frame.call(window, measure);
    else setTimeout(measure, 0);
  }
  let observer: Any = null;
  let observed: Element | null = null;
  function observeCard(): void {
    if (!observer && typeof (window as Any).ResizeObserver === 'function') {
      observer = new (window as Any).ResizeObserver(() => afterLayout());
    }
    const node = info ? root : null;
    if (!observer || node === observed) return;
    if (observed) observer.unobserve(observed);
    observed = node;
    if (node) observer.observe(node);
  }
  const fonts = (doc as Any).fonts;
  if (fonts && fonts.ready && typeof fonts.ready.then === 'function') fonts.ready.then(() => afterLayout());
  function markInitialized(): void {
    if (initialized) return;
    initialized = true;
    reportHeight(true);
    setTimeout(() => reportHeight(true), config.heightResendMs);
  }
  window.addEventListener('load', () => reportHeight(true));

  // ---- start -------------------------------------------------------------
  readGlobals();
  render();
  request('ui/initialize', {
    protocolVersion: '2026-01-26',
    appInfo: { name: 'olympus-private-question', version: '1' },
    appCapabilities: {},
  }, (result: Any) => {
    if (result && result.hostContext) hostContext(result.hostContext);
    notify('ui/notifications/initialized');
    markInitialized();
  });
  setTimeout(markInitialized, config.initFallbackMs);
}

/** The private answer panel's styles plus the question form's. */
export const CHATGPT_PRIVATE_QUESTION_CSS = `${CHATGPT_PRIVATE_ANSWER_CSS}
.q-form{margin-top:0.625rem;display:flex;flex-direction:column;gap:0.5rem}
.q-label{font-size:0.8125rem;font-weight:500;color:var(--muted)}
.q-field{width:100%;font:inherit;font-size:0.9375rem;line-height:1.45;color:var(--text);background:var(--raise);border:1px solid var(--hair);border-radius:10px;padding:0.5rem 0.625rem;resize:vertical;min-height:4.5rem}
.q-field:focus{outline:2px solid var(--focus);outline-offset:1px}
.q-opts{display:flex;flex-direction:column;gap:0.25rem}
.q-radio{display:flex;align-items:flex-start;gap:0.5rem;cursor:pointer;font-size:0.875rem;line-height:1.4}
.q-radio input{margin:0.2rem 0 0;flex:none}
.q-radio-text{display:flex;flex-direction:column}
.q-radio-name{font-weight:500}
.q-radio-hint{color:var(--muted);font-size:0.8125rem}
.q-prep{display:flex;align-items:center;gap:0.5rem;flex-wrap:wrap}
.q-select{font:inherit;font-size:0.875rem;color:var(--text);background:var(--raise);border:1px solid var(--hair);border-radius:8px;padding:0.25rem 0.5rem}
.q-actions{display:flex;align-items:center;gap:0.75rem;flex-wrap:wrap;margin-top:0.25rem}
.q-note{color:var(--muted);font-size:0.8125rem}
.q-foot{margin:0.5rem 0 0;color:var(--muted);font-size:0.8125rem;line-height:1.4}
.q-foot.warn{color:var(--warning)}
`;

export function chatgptPrivateQuestionPageHtml(options: ChatGptPrivateQuestionPageOptions): string {
  const config: ChatGptPrivateQuestionConfig = {
    relayOrigin: options.relayOrigin,
    metaKey: PRIVATE_QUESTION_META_KEY,
    jobIdPattern: CHATGPT_PRIVATE_ANSWER_JOB_ID.source,
    copy: DASHBOARD_CHATGPT_PRIVATE_QUESTION_COPY,
    secondMs: options.secondMs ?? 1000,
    pollCapMs: options.pollCapMs ?? CHATGPT_PRIVATE_QUESTION_POLL_CAP_MS,
    requestTimeoutMs: options.requestTimeoutMs ?? CHATGPT_PRIVATE_QUESTION_REQUEST_TIMEOUT_MS,
    heightResendMs: options.heightResendMs ?? 400,
    initFallbackMs: options.initFallbackMs ?? 500,
    keyStore: { ...CHATGPT_PRIVATE_QUESTION_KEY_STORE, ...options.keyStore },
  };
  return [
    '<!doctype html>',
    '<html lang="en">',
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>${DASHBOARD_CHATGPT_PRIVATE_QUESTION_COPY.pageTitle}</title>`,
    `<style>${CHATGPT_PRIVATE_QUESTION_CSS}</style>`,
    '</head>',
    '<body>',
    '<div id="panel"></div>',
    `<script>(${chatgptPrivateQuestionProgram.toString()})(${scriptJson(config)});</script>`,
    '</body>',
    '</html>',
    '',
  ].join('\n');
}

/** JSON that cannot close the script element it sits in. */
function scriptJson(value: unknown): string {
  return JSON.stringify(value).split('<').join('\\u003c').split('\u2028').join('\\u2028').split('\u2029').join('\\u2029');
}
