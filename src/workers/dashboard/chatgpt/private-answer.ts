/**
 * The private answer panel: the `ui://olympus/private-answer` page rendered
 * under every Olympus search or answer result in ChatGPT.
 *
 * It renders nothing (zero height) unless the result's widget-only `_meta`
 * says Private items match (private-answer-contract.ts). Then it is one
 * compact card: how many private items match, and "Show private answer",
 * which collects the answer straight from the relay, sealed to a key that
 * exists only in this frame, and shows it as text.
 *
 * `chatgptPrivateAnswerProgram` runs only in the sandboxed iframe: the page
 * inlines its source (`Function.prototype.toString`) with a JSON config, so it
 * stays self-contained, and it builds every node with `textContent`.
 *
 * Privacy: the decrypted answer, its sources and the job id live only in this
 * program's memory. Nothing goes to widget state, model context, follow-up
 * messages, tool calls, storage, the console or a URL. The one network call is
 * the POST to `<relayOrigin>/private/<job id>` (the resource CSP's one
 * connect domain).
 *
 * Crypto mirrors private-answer-crypto.ts exactly: ECDH P-256 (the panel's
 * private key non-extractable), HKDF-SHA256 with an empty salt and
 * info = UTF-8(job id), AES-256-GCM with aad = UTF-8(job id); the plaintext
 * JSON is padded with trailing spaces.
 */
import { DASHBOARD_CHATGPT_PRIVATE_ANSWER_COPY } from '../vocabulary.ts';
import { PRIVATE_ANSWER_META_KEY, PRIVATE_MATCH_COUNT_CAP } from '../../chatgpt/private-answer-contract.ts';
import { CHATGPT_DASHBOARD_DARK, CHATGPT_DASHBOARD_LIGHT } from './page.ts';

export interface ChatGptPrivateAnswerConfig {
  relayOrigin: string;
  metaKey: string;
  countCap: number;
  /** Source of the job id pattern (connect-relay/shared/private-answer.ts). */
  jobIdPattern: string;
  copy: typeof DASHBOARD_CHATGPT_PRIVATE_ANSWER_COPY;
  /** One Retry-After second, in ms (tests shrink it). */
  secondMs: number;
  /** How long one Show keeps polling before offering Try again. */
  pollCapMs: number;
}

export interface ChatGptPrivateAnswerPageOptions {
  relayOrigin: string;
  secondMs?: number;
  pollCapMs?: number;
}

export const CHATGPT_PRIVATE_ANSWER_POLL_CAP_MS = 2 * 60_000;
/** The job ids the panel will put in a URL: exactly the relay's routable shape. */
export const CHATGPT_PRIVATE_ANSWER_JOB_ID = /^oly2p\.[a-z2-7]{32}\.[A-Za-z0-9_-]{43}$/;

// Loose shapes: the page validates what it reads instead of trusting a type.
/* eslint-disable @typescript-eslint/no-explicit-any */
type Any = any;

export function chatgptPrivateAnswerProgram(config: ChatGptPrivateAnswerConfig): void {
  const doc = document;
  const root = doc.getElementById('panel') as HTMLElement;
  const T = config.copy;
  const JOB_ID = new RegExp(config.jobIdPattern);
  const SVG_NS = 'http://www.w3.org/2000/svg';

  // What the tool result said; null renders nothing.
  let info: { count: number; state: string; jobId: string; percent: number } | null = null;
  // idle | working | slow | revealed | hidden | error
  let phase = 'idle';
  let errorText = '';
  let canRetry = false;
  // The decrypted answer, in memory only, for this job, until the frame unloads.
  let answer: { text: string; sources: string[]; unanswered: string[] } | null = null;
  // The key pair this frame claimed the job with: retries and polls reuse it.
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
    readGlobals();
    render();
  });

  // ---- the tool result ---------------------------------------------------
  /** Reads `_meta[metaKey]`; anything unexpected renders nothing. */
  function accept(meta: Any, quiet?: boolean): void {
    const value = meta && typeof meta === 'object' ? meta[config.metaKey] : null;
    let next: typeof info = null;
    if (value && typeof value === 'object' && value.v === 1 && typeof value.count === 'number'
      && isFinite(value.count) && value.count >= 1
      && (value.state === 'ready' || value.state === 'no_model' || value.state === 'model_downloading')) {
      const percent = typeof value.percent === 'number' && isFinite(value.percent)
        ? Math.max(0, Math.min(100, Math.round(value.percent))) : -1;
      next = {
        count: Math.floor(value.count),
        state: value.state,
        jobId: value.state === 'ready' && typeof value.jobId === 'string' ? value.jobId : '',
        percent: value.state === 'model_downloading' ? percent : -1,
      };
    }
    const same = !!info && !!next && info.count === next.count && info.state === next.state
      && info.jobId === next.jobId && info.percent === next.percent;
    if (same || (!info && !next)) return;
    if (!next || !info || next.jobId !== info.jobId) {
      // Another result: forget everything about the last one.
      run++;
      phase = 'idle';
      errorText = '';
      canRetry = false;
      answer = null;
      pair = null;
    }
    info = next;
    if (!quiet) render();
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
    const made = await subtle!.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']) as CryptoKeyPair;
    const raw = new Uint8Array(await subtle!.exportKey('raw', made.publicKey));
    pair = { jobId, privateKey: made.privateKey, publicKey: toB64url(raw) };
    return pair;
  }

  async function open(jobId: string, privateKey: CryptoKey, sealed: Any): Promise<Any> {
    const macRaw = fromB64url(sealed.macPublicKey);
    const iv = fromB64url(sealed.iv);
    const ciphertext = fromB64url(sealed.ciphertext);
    if (!macRaw || macRaw.length !== 65 || !iv || iv.length !== 12 || !ciphertext) throw new Error('malformed');
    const macKey = await subtle!.importKey('raw', macRaw as BufferSource, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
    const shared = await subtle!.deriveBits({ name: 'ECDH', public: macKey }, privateKey, 256);
    const ikm = await subtle!.importKey('raw', shared, 'HKDF', false, ['deriveKey']);
    const key = await subtle!.deriveKey(
      { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: utf8(jobId) },
      ikm,
      { name: 'AES-GCM', length: 256 },
      false,
      ['decrypt'],
    );
    const plain = await subtle!.decrypt({ name: 'AES-GCM', iv: iv as BufferSource, additionalData: utf8(jobId) }, key, ciphertext as BufferSource);
    // The engine pads the JSON with trailing spaces to a size bucket.
    return JSON.parse(new TextDecoder().decode(plain).replace(/\s+$/, ''));
  }

  /** The decrypted plaintext, checked and reduced to what the panel shows. */
  function readAnswer(value: Any): { text: string; sources: string[]; unanswered: string[] } | null {
    if (!value || typeof value !== 'object' || value.v !== 1 || typeof value.answer !== 'string') return null;
    const sources: string[] = [];
    const seen: Record<string, boolean> = {};
    const citations = Array.isArray(value.citations) ? value.citations : [];
    for (let i = 0; i < citations.length; i++) {
      const c = citations[i];
      if (!c || typeof c !== 'object') continue;
      const name = typeof c.title === 'string' && c.title.trim() ? c.title.trim()
        : typeof c.source === 'string' && c.source.trim() ? c.source.trim() : '';
      if (name && !seen[name]) {
        seen[name] = true;
        sources.push(name);
      }
    }
    const unanswered = (Array.isArray(value.unanswered) ? value.unanswered : [])
      .filter((item: Any) => typeof item === 'string' && item.trim())
      .map((item: string) => item.trim());
    return { text: value.answer, sources, unanswered };
  }

  // ---- collecting --------------------------------------------------------
  function wait(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function fail(text: string, retry: boolean): void {
    phase = 'error';
    errorText = text;
    canRetry = retry;
    focusAfter = retry ? 'retry' : 'status';
    render();
  }

  async function show(): Promise<void> {
    if (!info || info.state !== 'ready' || phase === 'working') return;
    if (answer) {
      phase = 'revealed';
      focusAfter = 'answer';
      render();
      return;
    }
    const jobId = info.jobId;
    if (!JOB_ID.test(jobId) || !subtle || typeof (window as Any).fetch !== 'function') {
      fail(T.generic, false);
      return;
    }
    const mine = ++run;
    phase = 'working';
    errorText = '';
    canRetry = false;
    focusAfter = 'status';
    render();
    const started = Date.now();
    try {
      const keys = await keyPair(jobId);
      for (;;) {
        if (mine !== run) return;
        let response: Response;
        try {
          response = await (window as Any).fetch(config.relayOrigin + '/private/' + jobId, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ v: 1, publicKey: keys.publicKey }),
            credentials: 'omit',
            cache: 'no-store',
            referrerPolicy: 'no-referrer',
            mode: 'cors',
          });
        } catch {
          if (mine === run) fail(T.unreachable, true);
          return;
        }
        if (mine !== run) return;
        let body: Any = null;
        try {
          body = await response.json();
        } catch {
          body = null;
        }
        if (mine !== run) return;
        const status = body && typeof body.status === 'string' ? body.status : '';
        const code = response.status;
        if (code === 200 && status === 'ready') {
          let opened: ReturnType<typeof readAnswer> = null;
          try {
            opened = readAnswer(await open(jobId, keys.privateKey, body));
          } catch {
            opened = null;
          }
          if (mine !== run) return;
          if (!opened) {
            fail(T.generic, false);
            return;
          }
          answer = opened;
          phase = 'revealed';
          focusAfter = 'answer';
          render();
          return;
        }
        if (code === 200 && status === 'failed') return fail(T.failed, false);
        if (code === 409) return fail(T.claimed, false);
        if (code === 410 || code === 404) return fail(T.expired, false);
        if (code === 429) return fail(T.rateLimited, true);
        const keepWaiting = code === 202 || (code === 503 && status === 'busy');
        if (code === 503 && !keepWaiting) return fail(T.macOffline, true);
        if (!keepWaiting) return fail(T.generic, false);
        const header = Number(response.headers && response.headers.get ? response.headers.get('retry-after') : NaN);
        const seconds = isFinite(header) && header > 0 ? Math.min(30, header) : 2;
        if (Date.now() - started + seconds * config.secondMs > config.pollCapMs) {
          phase = 'slow';
          errorText = T.slow;
          canRetry = true;
          focusAfter = 'retry';
          render();
          return;
        }
        await wait(seconds * config.secondMs);
      }
    } catch {
      if (mine === run) fail(T.generic, false);
    }
  }

  function hide(): void {
    phase = 'hidden';
    focusAfter = 'show';
    render();
  }

  // ---- view --------------------------------------------------------------
  function el(tag: string, cls?: string, text?: string): HTMLElement {
    const node = doc.createElement(tag);
    if (cls) node.className = cls;
    if (text) node.textContent = text;
    return node;
  }
  function fill(template: string, values: Record<string, string>): string {
    return template.replace(/\{(\w+)\}/g, (whole, key) => (key in values ? values[key]! : whole));
  }
  function button(label: string, key: string, onClick: () => void, name?: string): HTMLElement {
    const node = el('button', 'btn', label) as HTMLButtonElement;
    node.type = 'button';
    node.setAttribute('data-key', key);
    if (name) node.setAttribute('aria-label', name);
    node.addEventListener('click', onClick);
    return node;
  }

  function lock(): Element {
    const svg = doc.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('class', 'lock');
    svg.setAttribute('viewBox', '0 0 16 16');
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('focusable', 'false');
    const body = doc.createElementNS(SVG_NS, 'rect');
    body.setAttribute('x', '3.5');
    body.setAttribute('y', '7');
    body.setAttribute('width', '9');
    body.setAttribute('height', '7');
    body.setAttribute('rx', '1.5');
    const shackle = doc.createElementNS(SVG_NS, 'path');
    shackle.setAttribute('d', 'M5.5 7V5a2.5 2.5 0 0 1 5 0v2');
    svg.appendChild(body);
    svg.appendChild(shackle);
    return svg;
  }

  function countLine(count: number): string {
    if (count >= config.countCap) return fill(T.count.many, { n: T.capped });
    return count === 1 ? T.count.one : fill(T.count.many, { n: String(count) });
  }

  function sourcesLine(sources: string[]): string {
    const shown = sources.slice(0, 3);
    let list = shown.join(', ');
    if (sources.length > shown.length) list += ' ' + fill(T.more, { n: String(sources.length - shown.length) });
    return fill(T.sources, { list });
  }

  /**
   * The one card every state shares: the lock in its circle, the title with
   * one muted line under it (the live status), and at most one button.
   */
  function card(open: boolean): { card: HTMLElement; text: HTMLElement; line: HTMLElement; row: HTMLElement } {
    const node = el('section', open ? 'card open' : 'card');
    node.setAttribute('aria-label', T.title);
    const row = el('div', 'row');
    const icon = el('div', 'icon');
    icon.appendChild(lock());
    row.appendChild(icon);
    const text = el('div', 'text');
    text.appendChild(el('h2', 'title', T.title));
    const line = el('p', 'sub');
    line.setAttribute('role', 'status');
    line.setAttribute('aria-live', 'polite');
    line.setAttribute('tabindex', '-1');
    line.setAttribute('data-key', 'status');
    text.appendChild(line);
    row.appendChild(text);
    node.appendChild(row);
    return { card: node, text, line, row };
  }

  function cardView(current: NonNullable<typeof info>): HTMLElement {
    const view = card(false);
    const line = view.line;

    if (current.state === 'no_model') {
      line.textContent = T.noModel;
      return view.card;
    }
    if (current.state === 'model_downloading') {
      const known = current.percent >= 0;
      line.textContent = known ? fill(T.downloading, { percent: String(current.percent) }) : T.downloadingUnknown;
      if (known) {
        const bar = el('div', 'bar');
        bar.setAttribute('role', 'progressbar');
        bar.setAttribute('aria-label', T.downloadingLabel);
        bar.setAttribute('aria-valuemin', '0');
        bar.setAttribute('aria-valuemax', '100');
        bar.setAttribute('aria-valuenow', String(current.percent));
        const fillBar = el('div', 'bar-fill');
        fillBar.style.width = current.percent + '%';
        bar.appendChild(fillBar);
        view.text.appendChild(bar);
      }
      return view.card;
    }
    if (phase === 'working') {
      line.className = 'sub working';
      line.appendChild(el('span', 'spinner'));
      line.appendChild(doc.createTextNode(T.preparing));
      return view.card;
    }
    if (phase === 'error' || phase === 'slow') {
      line.className = 'sub warn';
      line.textContent = errorText;
      if (canRetry) view.row.appendChild(button(T.tryAgain, 'retry', () => void show()));
      return view.card;
    }
    line.textContent = countLine(current.count) + T.notSentAfterCount;
    view.row.appendChild(button(T.show, 'show', () => void show(), T.showLabel));
    return view.card;
  }

  function revealedView(shown: NonNullable<typeof answer>): HTMLElement {
    const view = card(true);
    view.line.textContent = T.notSent;
    view.row.appendChild(button(T.hide, 'hide', hide, T.hideLabel));
    const body = el('div', 'answer');
    body.setAttribute('tabindex', '-1');
    body.setAttribute('data-key', 'answer');
    const paragraphs = shown.text.split(/\n\s*\n/).map((part) => part.trim()).filter(Boolean);
    for (const part of paragraphs) body.appendChild(el('p', '', part));
    view.card.appendChild(body);
    if (shown.sources.length) view.card.appendChild(el('p', 'sub foot', sourcesLine(shown.sources)));
    if (shown.unanswered.length) view.card.appendChild(el('p', 'sub foot', fill(T.unanswered, { list: shown.unanswered.join('; ') })));
    return view.card;
  }

  function render(): void {
    if (theme) doc.documentElement.setAttribute('data-theme', theme);
    else doc.documentElement.removeAttribute('data-theme');
    root.textContent = '';
    if (info) root.appendChild(phase === 'revealed' && answer ? revealedView(answer) : cardView(info));
    if (focusAfter) {
      const key = focusAfter;
      focusAfter = '';
      const target = root.querySelector('[data-key="' + key + '"]') as HTMLElement | null;
      if (target && typeof target.focus === 'function') target.focus();
    }
    observeCard();
    reportHeight(true);
    afterLayout();
  }

  // ---- height --------------------------------------------------------------
  // The frame is exactly the card: its border box plus its margins. Never the
  // document's or viewport's height, which are at least the frame's current
  // size and would hold it open at whatever height the host started it.
  function cardHeight(): number {
    const node = info ? root.firstChild as HTMLElement | null : null;
    if (!node) return 0;
    let margins = 0;
    if (typeof (window as Any).getComputedStyle === 'function') {
      const style = (window as Any).getComputedStyle(node);
      margins = (parseFloat(style.marginTop) || 0) + (parseFloat(style.marginBottom) || 0);
    }
    return Math.ceil((node.offsetHeight || 0) + margins);
  }

  let lastHeight = -1;
  function reportHeight(force?: boolean): void {
    const height = cardHeight();
    if (!force && height === lastHeight) return;
    lastHeight = height;
    const host = openai();
    if (host && typeof host.notifyIntrinsicHeight === 'function') host.notifyIntrinsicHeight(height);
    const width = info && root.firstChild ? Math.ceil((root.firstChild as HTMLElement).offsetWidth || 0) : 0;
    notify('ui/notifications/size-changed', width > 0 ? { width, height } : { height });
  }

  /** Measures again once layout (and the next frame) has settled. */
  function afterLayout(): void {
    const frame = (window as Any).requestAnimationFrame;
    if (typeof frame === 'function') frame.call(window, () => reportHeight());
    else setTimeout(() => reportHeight(), 0);
  }

  let observer: Any = null;
  let observed: Element | null = null;
  function observeCard(): void {
    if (!observer && typeof (window as Any).ResizeObserver === 'function') {
      observer = new (window as Any).ResizeObserver(() => reportHeight());
    }
    const node = info ? root.firstChild as Element | null : null;
    if (!observer || node === observed) return;
    if (observed) observer.unobserve(observed);
    observed = node;
    if (node) observer.observe(node);
  }
  const fonts = (doc as Any).fonts;
  if (fonts && fonts.ready && typeof fonts.ready.then === 'function') fonts.ready.then(() => reportHeight());

  // ---- start -------------------------------------------------------------
  readGlobals();
  render();
  request('ui/initialize', {
    protocolVersion: '2026-01-26',
    appInfo: { name: 'olympus-private-answer', version: '1' },
    appCapabilities: {},
  }, (result: Any) => {
    if (result && result.hostContext) hostContext(result.hostContext);
    notify('ui/notifications/initialized');
  });
}

// The card's own surfaces: a soft tint over ChatGPT's page and a raised
// circle/pill on it. AA: text and muted on the tint, warning on the tint.
const CARD_LIGHT = { tint: '#f7f7f8', raise: '#ffffff', hair: '#e3e3e3', hover: '#ececec', warning: CHATGPT_DASHBOARD_LIGHT.warnLine };
const CARD_DARK = { tint: '#2f2f2f', raise: '#3a3a3a', hair: '#4a4a4a', hover: '#444444', warning: CHATGPT_DASHBOARD_DARK.warnLine };

function vars(palette: typeof CHATGPT_DASHBOARD_LIGHT, card: typeof CARD_LIGHT): string {
  return [
    `--text:${palette.text}`, `--muted:${palette.muted}`, `--line:${palette.line}`,
    `--focus:${palette.focus}`, `--run:${palette.run}`,
    `--tint:${card.tint}`, `--raise:${card.raise}`, `--hair:${card.hair}`, `--hover:${card.hover}`, `--warning:${card.warning}`,
  ].join(';');
}

// The ChatGPT desktop host stretched the card to the frame's initial height
// (live 2026-10-01: a one-line card drawn about 440px tall), so the sizing
// rules below win over anything the host injects.
// The page is transparent and exactly as tall as the card: no min-height,
// no viewport units, no margins outside the card.
export const CHATGPT_PRIVATE_ANSWER_CSS = `
:root{${vars(CHATGPT_DASHBOARD_LIGHT, CARD_LIGHT)};color-scheme:light dark}
@media (prefers-color-scheme:dark){:root:not([data-theme=light]){${vars(CHATGPT_DASHBOARD_DARK, CARD_DARK)}}}
:root[data-theme=dark]{${vars(CHATGPT_DASHBOARD_DARK, CARD_DARK)};color-scheme:dark}
:root[data-theme=light]{color-scheme:light}
*{box-sizing:border-box}
html{font-family:system-ui,-apple-system,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;font-size:100%;line-height:1.45}
html:root,html:root>body{margin:0!important;padding:0!important;height:auto!important;min-height:0!important;display:block!important;background:transparent;color:var(--text);overflow:hidden}
body{font-size:0.9375rem;overflow-wrap:anywhere}
p,h2{margin:0}
html:root>body #panel{display:block!important;height:auto!important;min-height:0!important}
#panel:empty{display:none!important}
html:root>body #panel>.card{display:block!important;height:auto!important;min-height:0!important;max-height:none!important;flex:none!important;align-self:flex-start!important}
.card{margin:0;padding:0.75rem 0.875rem;border-radius:14px;background:var(--tint)}
.row{display:flex;align-items:center;gap:0.75rem}
.icon{flex:none;display:flex;align-items:center;justify-content:center;width:2rem;height:2rem;border-radius:50%;background:var(--raise);border:1px solid var(--hair)}
.lock{width:1rem;height:1rem;fill:none;stroke:var(--text);stroke-width:1.4;stroke-linecap:round;stroke-linejoin:round}
.text{flex:1 1 auto;min-width:0}
.title{font-size:0.9375rem;font-weight:600;line-height:1.35}
.sub{color:var(--muted);font-size:0.8125rem;line-height:1.4;margin-top:0.0625rem}
.sub:focus{outline:none}
.sub.warn{color:var(--warning)}
.working{display:flex;align-items:center;gap:0.5rem}
.spinner{flex:none;width:0.75rem;height:0.75rem;border-radius:50%;border:2px solid var(--hair);border-top-color:var(--muted);animation:spin 0.9s linear infinite}
@keyframes spin{to{transform:rotate(360deg)}}
.bar{height:0.25rem;margin-top:0.375rem;border-radius:999px;background:var(--hair);overflow:hidden}
.bar-fill{height:100%;background:var(--run)}
.answer{margin-top:0.625rem;display:flex;flex-direction:column;gap:0.625rem;font-size:0.9375rem;line-height:1.6;white-space:pre-line}
.answer:focus{outline:none}
.foot{margin-top:0.5rem}
.btn{flex:none;font:inherit;font-size:0.875rem;font-weight:500;line-height:1.25;min-height:2rem;padding:0.375rem 0.875rem;border-radius:999px;border:1px solid var(--line);background:var(--raise);color:var(--text);cursor:pointer;-webkit-appearance:none;appearance:none;box-shadow:none}
.btn:hover{background:var(--hover)}
.btn:focus{outline:none}
.btn:focus-visible{outline:2px solid var(--focus);outline-offset:2px}
@media (prefers-reduced-motion:reduce){.spinner{animation-duration:3s}}
`;

/** The panel page, with every string it prints inlined as data. */
export function chatgptPrivateAnswerPageHtml(options: ChatGptPrivateAnswerPageOptions): string {
  const config: ChatGptPrivateAnswerConfig = {
    relayOrigin: options.relayOrigin,
    metaKey: PRIVATE_ANSWER_META_KEY,
    countCap: PRIVATE_MATCH_COUNT_CAP,
    jobIdPattern: CHATGPT_PRIVATE_ANSWER_JOB_ID.source,
    copy: DASHBOARD_CHATGPT_PRIVATE_ANSWER_COPY,
    secondMs: options.secondMs ?? 1000,
    pollCapMs: options.pollCapMs ?? CHATGPT_PRIVATE_ANSWER_POLL_CAP_MS,
  };
  return [
    '<!doctype html>',
    '<html lang="en">',
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>${DASHBOARD_CHATGPT_PRIVATE_ANSWER_COPY.pageTitle}</title>`,
    `<style>${CHATGPT_PRIVATE_ANSWER_CSS}</style>`,
    '</head>',
    '<body>',
    '<div id="panel"></div>',
    `<script>(${chatgptPrivateAnswerProgram.toString()})(${scriptJson(config)});</script>`,
    '</body>',
    '</html>',
    '',
  ].join('\n');
}

/** JSON that cannot close the script element it sits in. */
function scriptJson(value: unknown): string {
  return JSON.stringify(value).split('<').join('\\u003c').split('\u2028').join('\\u2028').split('\u2029').join('\\u2029');
}
