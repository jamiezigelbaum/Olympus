/**
 * The private answer panel: the `ui://olympus/private-answer` page rendered
 * under every Olympus search or answer result in ChatGPT.
 *
 * It renders nothing (zero height) unless the result's widget-only `_meta`
 * says Private items match (private-answer-contract.ts). Then it is one
 * compact card that collects the answer straight from the relay as soon as it
 * renders, sealed to a key that exists only on this device, and shows it as
 * text inside the card ("Hide" folds it away; "Show" brings it back from
 * memory).
 *
 * `chatgptPrivateAnswerProgram` runs only in the sandboxed iframe: the page
 * inlines its source (`Function.prototype.toString`) with a JSON config, so it
 * stays self-contained, and it builds every node with `textContent`.
 *
 * Privacy: the decrypted answer and its sources live only in this program's
 * memory. Nothing goes to widget state, model context, follow-up messages,
 * tool calls, storage, the console or a URL. The network calls are POSTs to
 * `<relayOrigin>/private/<job id>` (the resource CSP's one connect domain) and,
 * when the person opens a source on their Mac, `<relayOrigin>/private/<job
 * id>/open` with that source's opaque token. A source that carries a web
 * address (https only) is handed to the host to open: that address is the one
 * thing the host ever sees, and only on the person's click.
 *
 * The key pair is kept per job id in this origin's IndexedDB (database
 * `olympus-private-answer`, store `keys`): ChatGPT re-mounts the widget on
 * scroll, history and follow-ups, and a fresh key would be refused (the job
 * is bound to the first key that claimed it). IndexedDB stores the private
 * CryptoKey by structured clone, still non-extractable, and it never crosses
 * to the host. Widget state does cross to the host (OpenAI), so the key never
 * goes there: whoever holds the private key and can re-collect the sealed
 * answer could open it. Entries older than a day are deleted when the panel
 * next stores one. Without IndexedDB (a sandbox or private mode) the key
 * lives in memory and a re-mount says the answer was opened elsewhere.
 *
 * Crypto mirrors private-answer-crypto.ts exactly: ECDH P-256 (the panel's
 * private key non-extractable), HKDF-SHA256 with an empty salt and
 * info = UTF-8(job id), AES-256-GCM with aad = UTF-8(job id); the plaintext
 * JSON is padded with trailing spaces.
 *
 * Follow-up collection (private-answer-contract.ts, AD-2; design
 * docs/design/frontier-consult-lane.md §A.5–A.6, stage C4a). Every request
 * body carries `cap: 2`, unconditionally. A decrypted plaintext that carries
 * an `outside` block is a follow-up envelope: the panel keeps the first
 * answer exactly as revealed, shows the outside block in its own container
 * under the card (application-owned attribution pinned while the text
 * scrolls, plain text only, bounded), and polls the same request every 30 s
 * until the server-computed `followSeconds` runs out; a `withdrawn` state
 * replaces the answer. The reported geometry is locked by a numeric rule,
 * not by silencing the notifications: `H = min(A + R, 640)` where `A` is
 * the first-answer card alone and `R` = 176 px, the outside container,
 * always present and always the same height; the card scrolls inside
 * `640 − R` when it is taller. A plaintext without `outside` (an older
 * engine) is today's answer: no polling, no strip, no error.
 */
import { DASHBOARD_CHATGPT_PRIVATE_ANSWER_COPY } from '../vocabulary.ts';
import { PRIVATE_ANSWER_META_KEY } from '../../chatgpt/private-answer-contract.ts';
import { CHATGPT_DASHBOARD_DARK, CHATGPT_DASHBOARD_LIGHT } from './page.ts';

export interface ChatGptPrivateAnswerConfig {
  relayOrigin: string;
  metaKey: string;
  /** Source of the job id pattern (connect-relay/shared/private-answer.ts). */
  jobIdPattern: string;
  copy: typeof DASHBOARD_CHATGPT_PRIVATE_ANSWER_COPY;
  /** One Retry-After second, in ms (tests shrink it). */
  secondMs: number;
  /** How long one collection keeps polling before offering Try again. */
  pollCapMs: number;
  /** The same, for a full-detail answer (`detail: 'full'`). */
  fullPollCapMs: number;
  /** One relay request (response and body) is abandoned after this long; polling continues until the cap. */
  requestTimeoutMs: number;
  /** How long "Opened on your Mac" (or its failure) stays beside a source. */
  noteMs: number;
  /** The handshake: re-send the height this long after initialized, and send anyway if the host never answers. */
  heightResendMs: number;
  initFallbackMs: number;
  /** Where the key pair per job id is kept across re-mounts. */
  keyStore: { database: string; store: string; maxAgeMs: number; timeoutMs: number };
  /** The capability declared in every request body (`cap`). */
  capability: number;
  /** Follow-up collection: the cadence of the uniform request after first reveal. */
  followPollMs: number;
  /** The outside container's reserved allocation (R, its gap above included), the gap itself, and the frame cap, in px. */
  outsideHeightPx: number;
  outsideGapPx: number;
  frameCapPx: number;
  /** The outside text's line policy. */
  outsideLines: number;
  outsideLineChars: number;
  outsideBytes: number;
}

export interface ChatGptPrivateAnswerPageOptions {
  relayOrigin: string;
  secondMs?: number;
  pollCapMs?: number;
  fullPollCapMs?: number;
  requestTimeoutMs?: number;
  noteMs?: number;
  heightResendMs?: number;
  initFallbackMs?: number;
  /** Tests shorten the store's timeout. */
  keyStore?: Partial<ChatGptPrivateAnswerConfig['keyStore']>;
  followPollMs?: number;
}

export const CHATGPT_PRIVATE_ANSWER_POLL_CAP_MS = 2 * 60_000;
/** A full-detail answer reads selected parts more closely: the engine allows it 240 s, the panel waits a little longer. */
export const CHATGPT_PRIVATE_ANSWER_FULL_POLL_CAP_MS = 250_000;
/** The relay answers a poll at once (202 with Retry-After); a request this slow has hung. */
export const CHATGPT_PRIVATE_ANSWER_REQUEST_TIMEOUT_MS = 20_000;
/** The panel's IndexedDB: one key pair per job id (key path: the job id). */
export const CHATGPT_PRIVATE_ANSWER_KEY_STORE = {
  database: 'olympus-private-answer',
  store: 'keys',
  /** Older entries are deleted; jobs themselves live ten minutes. */
  maxAgeMs: 24 * 60 * 60_000,
  /** A store that never answers (some sandboxes) falls back to memory after this. */
  timeoutMs: 1500,
} as const;
/** The job ids the panel will put in a URL: exactly the relay's routable shape. */
export const CHATGPT_PRIVATE_ANSWER_JOB_ID = /^oly2p\.[a-z2-7]{32}\.[A-Za-z0-9_-]{43}$/;
/** The capability every request declares (`cap`): follow-up collection (private-answer-contract.ts PRIVATE_ANSWER_PANEL_CAPABILITY). */
export const CHATGPT_PRIVATE_ANSWER_CAPABILITY = 2;
/** Follow-up polling cadence: far below the engine's and relay's rate limits. */
export const CHATGPT_PRIVATE_ANSWER_FOLLOW_POLL_MS = 30_000;
/** The outside container's reserved allocation (R, design §A.5.5): its box plus the gap above it; and the frame cap. */
export const CHATGPT_PRIVATE_ANSWER_OUTSIDE_HEIGHT_PX = 176;
export const CHATGPT_PRIVATE_ANSWER_OUTSIDE_GAP_PX = 8;
export const CHATGPT_PRIVATE_ANSWER_FRAME_CAP_PX = 640;
/** The outside text's line policy (design §A.6), mirrored from the engine's payload contract. */
export const CHATGPT_PRIVATE_ANSWER_OUTSIDE_LINES = 40;
export const CHATGPT_PRIVATE_ANSWER_OUTSIDE_LINE_CHARS = 240;
export const CHATGPT_PRIVATE_ANSWER_OUTSIDE_BYTES = 4_096;

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
  let info: { count: number; state: string; jobId: string; percent: number; full: boolean } | null = null;
  // idle | working | slow | revealed | hidden | withdrawn | error. A ready
  // job starts collecting as soon as it arrives; idle lasts only until then.
  let phase = 'idle';
  let errorText = '';
  let canRetry = false;
  // The decrypted answer, in memory only, for this job, until the frame unloads.
  let answer: Answer | null = null;
  // The Sources disclosure (closed by default) and each source's brief open
  // result, by index. Memory only; a new answer resets both.
  let sourcesOpen = false;
  let askedOpen = false;
  let notes: Record<number, { text: string; warn: boolean }> = {};
  // The key pair this job is claimed with: retries, polls and re-mounts reuse it.
  let pair: { jobId: string; privateKey: CryptoKey; publicKey: string } | null = null;
  let run = 0;
  let theme = '';
  let focusAfter = '';
  type Open = { kind: 'mac'; token: string } | { kind: 'web'; url: string };
  type Source = { name: string; open: Open | null };
  type Outside = { state: string; text: string; cut: boolean; question: string };
  // `follow`: a follow-up envelope (the plaintext carried an outside block):
  // the reserved container, the geometry rule and the polling apply.
  type Answer = { text: string; sources: Source[]; unanswered: string[]; follow: boolean; rev: number; followSeconds: number; outside: Outside };
  type Opened = { kind: 'answer'; answer: Answer } | { kind: 'withdrawn'; rev: number; followSeconds: number };
  // Follow-up collection for the current job, independent of what is shown:
  // the polling deadline and the revision, kept through a withdrawal and on
  // reopen, so neither the relay (polls) nor the host (height) learns of it.
  let follow: { rev: number; until: number } | null = null;
  // The answer was withdrawn on the Mac: its payload is gone; what is shown
  // (revealed or hidden) is a separate matter, so Hide and Show keep working.
  let gone = false;
  // The geometry of the revealed follow-up answer, measured as soon as it is
  // laid out (before and regardless of the host handshake) and kept in the
  // key store for a re-mount: a withdrawal keeps reporting it. A re-mount
  // that never showed the answer at this width settles its height once.
  let lockedHeight = -1;
  let lockedWidth = 0;

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
  // The host announces globals often (its own layout changes included). Redraw
  // only for a new theme; a new result redraws through accept.
  window.addEventListener('openai:set_globals', () => {
    const host = openai();
    if (!host) return;
    const before = theme;
    if (host.theme === 'light' || host.theme === 'dark') theme = host.theme;
    if (host.toolResponseMetadata) accept(host.toolResponseMetadata);
    if (theme !== before) render();
  });

  // ---- the tool result ---------------------------------------------------
  /** Reads `_meta[metaKey]`; anything unexpected renders nothing. */
  function accept(meta: Any, quiet?: boolean): void {
    const value = meta && typeof meta === 'object' ? meta[config.metaKey] : undefined;
    // The host re-delivers results and globals while the answer loads, some
    // without our key. Absence is no news: only an explicit value replaces
    // what is shown (live 2026-10-02, the card closed and reopened 3-4 times
    // while loading because a bare re-delivery cleared it).
    if (value === undefined && info) return;
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
        full: value.detail === 'full',
      };
    }
    const same = !!info && !!next && info.count === next.count && info.state === next.state
      && info.jobId === next.jobId && info.percent === next.percent && info.full === next.full;
    if (same || (!info && !next)) return;
    if (!next || !info || next.jobId !== info.jobId) {
      // Another result: forget everything about the last one.
      run++;
      phase = 'idle';
      errorText = '';
      canRetry = false;
      answer = null;
      follow = null;
      gone = false;
      lockedHeight = -1;
      lockedWidth = 0;
      sourcesOpen = false;
      askedOpen = false;
      notes = {};
      pair = null;
    }
    info = next;
    if (info && info.state === 'ready' && phase === 'idle') void collect(false);
    else if (!quiet) render();
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
    await keepKey(jobId, fresh.privateKey, fresh.publicKey);
    pair = fresh;
    return pair;
  }

  // ---- the key store (IndexedDB, this origin only) --------------------------
  // Every failure here means "no stored key": the panel then keeps the pair in
  // memory. Nothing in this section ever sees the answer.
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

  /** One transaction on the key store; resolves with the request's result, or undefined on any failure. */
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

  async function keptKey(jobId: string): Promise<{ privateKey: CryptoKey; publicKey: string } | null> {
    try {
      const value = await inStore('readonly', (store) => store.get(jobId));
      if (!value || typeof value !== 'object') return null;
      const privateKey = value.privateKey;
      const fresh = typeof value.createdAt === 'number' && Date.now() - value.createdAt < KS.maxAgeMs;
      if (!fresh || !privateKey || typeof privateKey !== 'object' || privateKey.type !== 'private') return null;
      if (typeof value.publicKey !== 'string' || !/^[A-Za-z0-9_-]{87}$/.test(value.publicKey)) return null;
      // The revealed geometry kept with the key (bounded: two numbers), for a re-mount at the same width.
      const geometry = value.geometry;
      const width = cardWidth();
      if (geometry && typeof geometry === 'object' && typeof geometry.width === 'number' && typeof geometry.height === 'number'
        && geometry.width > 0 && geometry.width < 10_000 && geometry.height > 0 && geometry.height <= config.frameCapPx
        && (width === 0 || width === geometry.width) && lockedHeight < 0) {
        lockedHeight = Math.floor(geometry.height);
        lockedWidth = Math.floor(geometry.width);
      }
      return { privateKey, publicKey: value.publicKey };
    } catch {
      return null;
    }
  }

  async function keepKey(jobId: string, privateKey: CryptoKey, publicKey: string): Promise<void> {
    try {
      await inStore('readwrite', (store) => {
        store.put({ privateKey, publicKey, createdAt: Date.now() }, jobId);
      });
    } catch { /* memory only */ }
    void dropOldKeys();
  }

  /** Records the revealed geometry beside the job's key: a re-mount keeps reporting it through a withdrawal. */
  let keptGeometry = '';
  async function keepGeometry(jobId: string, width: number, height: number): Promise<void> {
    const mark = jobId + ':' + width + ':' + height;
    if (mark === keptGeometry) return;
    keptGeometry = mark;
    try {
      const value = await inStore('readonly', (store) => store.get(jobId));
      if (!value || typeof value !== 'object' || !value.privateKey) return;
      await inStore('readwrite', (store) => {
        store.put({ privateKey: value.privateKey, publicKey: value.publicKey, createdAt: value.createdAt, geometry: { width, height } }, jobId);
      });
    } catch { /* memory only */ }
  }

  /** Opportunistic: deletes pairs older than a day. Never waited on. */
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

  /**
   * A citation's optional open target. Only two shapes count, and anything
   * else (another kind, a malformed token, a non-https address) is ignored, so
   * the source shows as plain text.
   */
  function readOpen(value: Any): Open | null {
    if (!value || typeof value !== 'object') return null;
    if (value.kind === 'mac' && typeof value.token === 'string' && /^[A-Za-z0-9._~-]{1,1024}$/.test(value.token)) {
      return { kind: 'mac', token: value.token };
    }
    if (value.kind === 'web' && typeof value.url === 'string' && value.url.length <= 4096) {
      try {
        const parsed = new URL(value.url);
        if (parsed.protocol === 'https:' && parsed.hostname && !parsed.username && !parsed.password) {
          return { kind: 'web', url: parsed.href };
        }
      } catch { /* not an address */ }
    }
    return null;
  }

  /**
   * The outside text under the line policy, mirrored from the engine
   * (private-answer-payload.ts boundOutsideText): line endings normalized,
   * control, bidirectional and zero-width characters stripped, runs of blank
   * lines collapsed, at most 40 lines of 240 characters, at most 4,096 bytes
   * with "…" inside. The text is only ever set with textContent.
   */
  function boundOutside(value: Any): { text: string; cut: boolean } {
    if (typeof value !== 'string') return { text: '', cut: false };
    let text: string = value;
    if (typeof (text as Any).toWellFormed === 'function') text = (text as Any).toWellFormed();
    text = text.replace(/\r\n?/g, '\n')
      .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff]/g, '')
      .replace(/\t/g, ' ');
    let cut = false;
    const lines: string[] = [];
    let blank = false;
    const parts = text.split('\n');
    for (let i = 0; i < parts.length; i++) {
      const line = parts[i]!.replace(/\s+$/, '');
      if (line === '') {
        if (blank || lines.length === 0) continue;
        blank = true;
        lines.push('');
        continue;
      }
      blank = false;
      const points = Array.from(line);
      if (points.length > config.outsideLineChars) {
        cut = true;
        lines.push(points.slice(0, config.outsideLineChars - 1).join('') + '…');
      } else {
        lines.push(line);
      }
    }
    while (lines.length && lines[lines.length - 1] === '') lines.pop();
    if (lines.length > config.outsideLines) {
      cut = true;
      lines.length = config.outsideLines;
    }
    let joined = lines.join('\n');
    const encoder = new TextEncoder();
    if (encoder.encode(joined).length + 2 > config.outsideBytes) {
      cut = true;
      const all = Array.from(joined);
      let kept = '';
      let room = config.outsideBytes - 2 - 3;
      for (let i = 0; i < all.length; i++) {
        const bytes = encoder.encode(all[i]!).length;
        if (bytes > room) break;
        room -= bytes;
        kept += all[i];
      }
      joined = kept + '…';
    }
    return { text: joined, cut };
  }

  function readOutside(value: Any): Outside | null {
    if (!value || typeof value !== 'object') return null;
    const state = value.state === 'pending' || value.state === 'appended' || value.state === 'paused' ? value.state : 'idle';
    if (state !== 'appended') return { state, text: '', cut: false, question: '' };
    const bounded = boundOutside(value.text);
    const question = typeof value.question === 'string' ? boundOutside(value.question).text : '';
    return { state, text: bounded.text, cut: bounded.cut || value.cut === true, question };
  }

  /** The decrypted plaintext, checked and reduced to what the panel shows: an answer, or a withdrawal. */
  function readAnswer(value: Any): Opened | null {
    if (!value || typeof value !== 'object' || value.v !== 1) return null;
    const rev = typeof value.rev === 'number' && isFinite(value.rev) && value.rev >= 0 ? Math.floor(value.rev) : 0;
    if (value.state === 'withdrawn') {
      const left = typeof value.followSeconds === 'number' && isFinite(value.followSeconds) && value.followSeconds > 0 ? Math.floor(value.followSeconds) : 0;
      return { kind: 'withdrawn', rev, followSeconds: left };
    }
    if (typeof value.answer !== 'string') return null;
    const sources: Source[] = [];
    const seen: Record<string, boolean> = {};
    const citations = Array.isArray(value.citations) ? value.citations : [];
    for (let i = 0; i < citations.length; i++) {
      const c = citations[i];
      if (!c || typeof c !== 'object') continue;
      const name = typeof c.title === 'string' && c.title.trim() ? c.title.trim()
        : typeof c.source === 'string' && c.source.trim() ? c.source.trim() : '';
      if (name && !seen[name]) {
        seen[name] = true;
        sources.push({ name, open: readOpen(c.open) });
      }
    }
    const unanswered = (Array.isArray(value.unanswered) ? value.unanswered : [])
      .filter((item: Any) => typeof item === 'string' && item.trim())
      .map((item: string) => item.trim());
    const outside = readOutside(value.outside);
    // No outside block: an older engine's plaintext, treated exactly as before.
    const followSeconds = typeof value.followSeconds === 'number' && isFinite(value.followSeconds) && value.followSeconds > 0 ? Math.floor(value.followSeconds) : 0;
    return {
      kind: 'answer',
      answer: {
        text: value.answer,
        sources,
        unanswered,
        follow: outside !== null,
        rev,
        followSeconds: outside ? followSeconds : 0,
        outside: outside || { state: 'idle', text: '', cut: false, question: '' },
      },
    };
  }

  // ---- collecting --------------------------------------------------------
  function wait(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Settles with `work`, or rejects with 'timeout' after `ms` and aborts the
   * request: a fetch (or its body) that never settles cannot hold the panel,
   * even where the abort signal is ignored.
   */
  function bounded<V>(work: Promise<V>, ms: number, controller: AbortController | null): Promise<V> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (controller) try { controller.abort(); } catch { /* already done */ }
        reject(new Error('timeout'));
      }, Math.max(0, ms));
      work.then((value) => { clearTimeout(timer); resolve(value); }, (error) => { clearTimeout(timer); reject(error); });
    });
  }

  function slow(byUser: boolean): void {
    phase = 'slow';
    errorText = T.slow;
    canRetry = true;
    focusAfter = byUser ? 'retry' : '';
    render();
  }

  function fail(text: string, retry: boolean, byUser: boolean): void {
    phase = 'error';
    errorText = text;
    canRetry = retry;
    focusAfter = byUser ? (retry ? 'retry' : 'status') : '';
    render();
  }

  /** Shows the answer kept in memory again (or, once withdrawn, says so); never a new request. */
  function show(): void {
    if (gone) {
      phase = 'withdrawn';
      focusAfter = 'status';
      render();
      return;
    }
    if (!answer) return void collect(true);
    phase = 'revealed';
    focusAfter = 'answer';
    render();
  }

  /**
   * Collects the answer for the current job. Starts by itself when a ready
   * result arrives (`byUser` false: focus stays where it is) and again on
   * Try again.
   */
  async function collect(byUser: boolean): Promise<void> {
    if (!info || info.state !== 'ready' || phase === 'working') return;
    const jobId = info.jobId;
    if (!JOB_ID.test(jobId) || !subtle || typeof (window as Any).fetch !== 'function') {
      fail(T.generic, false, byUser);
      return;
    }
    const mine = ++run;
    phase = 'working';
    errorText = '';
    canRetry = false;
    focusAfter = byUser ? 'status' : '';
    render();
    // One collection deadline over everything (the key, every request, the
    // decryption): whatever stalls, the panel stops waiting here, and a step
    // that finishes later is ignored.
    const deadline = Date.now() + (info.full ? config.fullPollCapMs : config.pollCapMs);
    const isTimeout = (error: unknown) => error instanceof Error && error.message === 'timeout';
    try {
      let keys: Awaited<ReturnType<typeof keyPair>>;
      try {
        keys = await bounded(keyPair(jobId), deadline - Date.now(), null);
      } catch (error) {
        if (mine !== run) return;
        if (isTimeout(error)) return slow(byUser);
        throw error;
      }
      for (;;) {
        if (mine !== run) return;
        const left = deadline - Date.now();
        if (left <= 0) return slow(byUser);
        // One request deadline over its response and its body, never past the collection's.
        const requestEnd = Date.now() + Math.min(config.requestTimeoutMs, left);
        const controller = typeof (window as Any).AbortController === 'function' ? new (window as Any).AbortController() as AbortController : null;
        let response: Response;
        let body: Any = null;
        try {
          response = await bounded<Response>((window as Any).fetch(config.relayOrigin + '/private/' + jobId, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(requestBody(keys.publicKey)),
            credentials: 'omit',
            cache: 'no-store',
            referrerPolicy: 'no-referrer',
            mode: 'cors',
            signal: controller ? controller.signal : undefined,
          }), requestEnd - Date.now(), controller);
          if (mine !== run) return;
          try {
            body = await bounded<Any>(response.json(), requestEnd - Date.now(), controller);
          } catch (error) {
            if (isTimeout(error)) throw error;
            body = null;
          }
        } catch (error) {
          if (mine !== run) return;
          // A hung request is abandoned; the job may still be ready, so ask
          // again until the deadline, then offer Try again.
          if (isTimeout(error)) {
            if (Date.now() >= deadline) return slow(byUser);
            continue;
          }
          fail(T.unreachable, true, byUser);
          return;
        }
        if (mine !== run) return;
        const status = body && typeof body.status === 'string' ? body.status : '';
        const code = response.status;
        if (code === 200 && status === 'ready') {
          let opened: ReturnType<typeof readAnswer> = null;
          try {
            opened = readAnswer(await bounded(open(jobId, keys.privateKey, body), deadline - Date.now(), null));
          } catch (error) {
            if (mine !== run) return;
            if (isTimeout(error)) return slow(byUser);
            opened = null;
          }
          if (mine !== run) return;
          if (!opened) {
            fail(T.generic, false, byUser);
            return;
          }
          if (opened.kind === 'withdrawn') {
            follow = { rev: opened.rev, until: Date.now() + opened.followSeconds * config.secondMs };
            withdrawn(byUser);
            void followUp(mine, jobId, keys);
            return;
          }
          answer = opened.answer;
          sourcesOpen = false;
          askedOpen = false;
          notes = {};
          phase = 'revealed';
          focusAfter = byUser ? 'answer' : '';
          render();
          if (answer.follow) {
            follow = { rev: answer.rev, until: Date.now() + answer.followSeconds * config.secondMs };
            void followUp(mine, jobId, keys);
          }
          return;
        }
        if (code === 200 && status === 'failed') return fail(T.failed, false, byUser);
        if (code === 409) return fail(T.claimed, false, byUser);
        if (code === 410 || code === 404) return fail(T.expired, false, byUser);
        if (code === 429) return fail(T.rateLimited, true, byUser);
        const keepWaiting = code === 202 || (code === 503 && status === 'busy');
        if (code === 503 && !keepWaiting) return fail(T.macOffline, true, byUser);
        if (!keepWaiting) return fail(T.generic, false, byUser);
        const header = Number(response.headers && response.headers.get ? response.headers.get('retry-after') : NaN);
        const seconds = isFinite(header) && header > 0 ? Math.min(30, header) : 2;
        if (Date.now() + seconds * config.secondMs > deadline) return slow(byUser);
        await wait(seconds * config.secondMs);
      }
    } catch {
      if (mine === run) fail(T.generic, false, byUser);
    }
  }

  function hide(): void {
    phase = 'hidden';
    focusAfter = 'show';
    render();
  }

  /** The one request body, in both phases: the key and the capability, nothing that depends on an outcome. */
  function requestBody(publicKey: string): Any {
    return { v: 1, publicKey, cap: config.capability };
  }

  /**
   * The answer was withdrawn on the Mac (an item is no longer eligible): its
   * text, sources, gaps and outside block are gone from here at once. The
   * follow-up polling and the reported geometry carry on exactly as before,
   * so the withdrawal is not told to the relay or the host.
   */
  function withdrawn(byUser: boolean): void {
    answer = null;
    gone = true;
    sourcesOpen = false;
    askedOpen = false;
    notes = {};
    errorText = T.withdrawn;
    canRetry = false;
    // Hidden stays hidden (Show then says it was withdrawn); shown turns into the withdrawn presentation.
    if (phase !== 'hidden') {
      phase = 'withdrawn';
      focusAfter = byUser ? 'status' : '';
    }
    render();
  }

  /**
   * Follow-up collection: the same request, at the same cadence, until the
   * server says the window has ended (followSeconds 0) or the job is gone.
   * Whatever comes back is one of two things to show: a newer revision's
   * outside block, or a withdrawal. Anything else (a transport failure, a
   * rate limit, a busy Mac) changes nothing and the cadence continues. The
   * first answer and its sources are never replaced.
   */
  async function followUp(mine: number, jobId: string, keys: { publicKey: string; privateKey: CryptoKey }): Promise<void> {
    for (;;) {
      if (mine !== run || !follow) return;
      const left = follow.until - Date.now();
      if (left <= 0) return;
      await wait(Math.min(config.followPollMs, left));
      if (mine !== run || !follow) return;
      const controller = typeof (window as Any).AbortController === 'function' ? new (window as Any).AbortController() as AbortController : null;
      let response: Response;
      let body: Any = null;
      try {
        response = await bounded<Response>((window as Any).fetch(config.relayOrigin + '/private/' + jobId, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(requestBody(keys.publicKey)),
          credentials: 'omit',
          cache: 'no-store',
          referrerPolicy: 'no-referrer',
          mode: 'cors',
          signal: controller ? controller.signal : undefined,
        }), config.requestTimeoutMs, controller);
        if (mine !== run) return;
        try {
          body = await bounded<Any>(response.json(), config.requestTimeoutMs, controller);
        } catch {
          body = null;
        }
      } catch {
        continue;
      }
      if (mine !== run || !follow) return;
      const code = response.status;
      // The job is gone (expired or evicted), or claimed by another key: nothing more will come.
      if (code === 410 || code === 404 || code === 409) return;
      if (code !== 200 || !body || body.status !== 'ready') continue;
      let opened: Opened | null = null;
      try {
        opened = readAnswer(await open(jobId, keys.privateKey, body));
      } catch {
        opened = null;
      }
      if (mine !== run || !follow || !opened) continue;
      if (opened.kind === 'withdrawn') {
        follow.until = Date.now() + opened.followSeconds * config.secondMs;
        if (opened.rev >= follow.rev) follow.rev = opened.rev;
        if (!gone) withdrawn(false);
        continue;
      }
      if (!opened.answer.follow) continue;
      follow.until = Date.now() + opened.answer.followSeconds * config.secondMs;
      if (answer && opened.answer.rev >= follow.rev) {
        follow.rev = opened.answer.rev;
        answer.rev = opened.answer.rev;
        answer.followSeconds = opened.answer.followSeconds;
        answer.outside = opened.answer.outside;
        if (phase === 'revealed') render();
      }
    }
  }

  function toggleAsked(): void {
    askedOpen = !askedOpen;
    focusAfter = 'asked';
    render();
  }

  function toggleSources(): void {
    sourcesOpen = !sourcesOpen;
    focusAfter = 'sources';
    render();
  }

  /** Opens one source: a web address through the host, a Mac item through the relay. */
  function openSource(index: number): void {
    const shown = answer;
    const source = shown ? shown.sources[index] : undefined;
    if (!shown || !source || !source.open) return;
    const target = source.open;
    if (target.kind === 'web') {
      const host = openai();
      if (host && typeof host.openExternal === 'function') {
        try { host.openExternal({ href: target.url }); } catch { /* the host declined */ }
      } else {
        request('ui/open-link', { url: target.url }, () => undefined);
      }
      return;
    }
    const jobId = info ? info.jobId : '';
    const done = (ok: boolean) => {
      if (answer !== shown) return;
      const note = { text: ok ? T.openedOnMac : T.openFailed, warn: !ok };
      notes[index] = note;
      render();
      setTimeout(() => {
        if (answer !== shown || notes[index] !== note) return;
        delete notes[index];
        render();
      }, config.noteMs);
    };
    if (!JOB_ID.test(jobId) || typeof (window as Any).fetch !== 'function') return done(false);
    let posting: Promise<Response>;
    try {
      posting = (window as Any).fetch(config.relayOrigin + '/private/' + jobId + '/open', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ v: 1, open: target.token }),
        credentials: 'omit',
        cache: 'no-store',
        referrerPolicy: 'no-referrer',
        mode: 'cors',
      });
    } catch {
      return done(false);
    }
    posting.then((response) => done(!!response && response.status === 204), () => done(false));
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

  function chevron(): Element {
    const svg = doc.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('class', 'chev');
    svg.setAttribute('viewBox', '0 0 12 12');
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('focusable', 'false');
    const path = doc.createElementNS(SVG_NS, 'path');
    path.setAttribute('d', 'M3 4.5l3 3 3-3');
    svg.appendChild(path);
    return svg;
  }

  // Enter and Space toggle on the key itself (and the click a browser then
  // synthesises is ignored), so the toggle works the same in every host.
  let keyedAt = 0;
  function onActivate(node: HTMLElement, action: () => void): void {
    node.addEventListener('click', (event: Any) => {
      if (event && event.detail === 0 && Date.now() - keyedAt < 500) return;
      action();
    });
    node.addEventListener('keydown', (event: Any) => {
      if (event.key !== 'Enter' && event.key !== ' ' && event.key !== 'Spacebar') return;
      event.preventDefault();
      if (event.repeat) return;
      keyedAt = Date.now();
      action();
    });
  }

  /** The collapsed "Sources (n)" disclosure and, when open, one row per source. */
  function sourcesView(sources: Source[]): HTMLElement {
    const wrap = el('div', 'sources');
    const toggle = el('button', 'src-toggle') as HTMLButtonElement;
    toggle.type = 'button';
    toggle.setAttribute('data-key', 'sources');
    toggle.setAttribute('aria-expanded', sourcesOpen ? 'true' : 'false');
    toggle.appendChild(doc.createTextNode(fill(T.sourcesToggle, { n: String(sources.length) })));
    toggle.appendChild(chevron());
    onActivate(toggle, toggleSources);
    wrap.appendChild(toggle);
    if (!sourcesOpen) return wrap;
    const list = el('ul', 'src-list');
    list.id = 'olympus-sources';
    toggle.setAttribute('aria-controls', list.id);
    sources.forEach((source, index) => {
      const item = el('li', 'src');
      if (source.open) {
        const link = el('button', 'src-link', source.name) as HTMLButtonElement;
        link.type = 'button';
        link.setAttribute('data-key', 'source-' + index);
        link.addEventListener('click', () => openSource(index));
        item.appendChild(link);
      } else {
        item.appendChild(el('span', 'src-name', source.name));
      }
      const note = notes[index];
      if (note) {
        const said = el('span', note.warn ? 'src-note warn' : 'src-note', note.text);
        said.setAttribute('role', 'status');
        item.appendChild(said);
      }
      list.appendChild(item);
    });
    wrap.appendChild(list);
    return wrap;
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
    if (phase === 'error' || phase === 'slow' || phase === 'withdrawn') {
      line.className = 'sub warn';
      line.textContent = errorText;
      if (canRetry) view.row.appendChild(button(T.tryAgain, 'retry', () => void collect(true)));
      return view.card;
    }
    if (phase === 'hidden' && (answer || gone)) {
      line.textContent = T.hidden;
      view.row.appendChild(button(T.show, 'show', show, T.showLabel));
      return view.card;
    }
    // idle (about to start) and working: the answer is on its way.
    line.className = 'sub working';
    line.appendChild(el('span', 'spinner'));
    line.appendChild(doc.createTextNode(info && info.full ? T.preparingFull : T.preparing));
    return view.card;
  }

  /**
   * The outside block's own container, below and outside the first-answer
   * card (design §A.6): always present for a follow-up answer, always the
   * same height, its attribution header application-owned and pinned while
   * the body scrolls. The body is one text node; nothing in it is markup, a
   * link or a heading, whatever the text says.
   */
  function outsideView(shown: Answer | null): HTMLElement {
    const box = el('section', 'outside');
    box.setAttribute('aria-label', T.outsideTitle);
    // The box plus its gap above (CSS .outside margin-top) is exactly the reserved allocation R.
    box.style.height = (config.outsideHeightPx - config.outsideGapPx) + 'px';
    const head = el('div', 'out-head');
    head.appendChild(el('h3', 'out-title', T.outsideTitle));
    head.appendChild(el('p', 'out-note', T.outsideNote));
    box.appendChild(head);
    const body = el('div', 'out-body');
    const state = shown ? shown.outside.state : 'idle';
    if (shown && state === 'appended') {
      const text = el('div', 'out-text');
      text.setAttribute('data-key', 'outside');
      text.textContent = shown.outside.text;
      body.appendChild(text);
      if (shown.outside.question) {
        const asked = el('div', 'asked');
        const toggle = el('button', 'src-toggle') as HTMLButtonElement;
        toggle.type = 'button';
        toggle.setAttribute('data-key', 'asked');
        toggle.setAttribute('aria-expanded', askedOpen ? 'true' : 'false');
        toggle.appendChild(doc.createTextNode(T.outsideAsked));
        toggle.appendChild(chevron());
        onActivate(toggle, toggleAsked);
        asked.appendChild(toggle);
        if (askedOpen) {
          const question = el('p', 'asked-text');
          question.textContent = shown.outside.question;
          asked.appendChild(question);
        }
        body.appendChild(asked);
      }
      if (shown.outside.cut) body.appendChild(el('p', 'out-foot', T.outsideShortened));
    } else if (state === 'pending') {
      const line = el('p', 'out-sub working');
      line.appendChild(el('span', 'spinner'));
      line.appendChild(doc.createTextNode(T.outsidePending));
      body.appendChild(line);
    } else if (state === 'paused') {
      body.appendChild(el('p', 'out-sub', T.outsidePaused));
    } else {
      body.appendChild(el('p', 'out-sub', T.outsideIdle));
    }
    box.appendChild(body);
    return box;
  }

  function revealedView(shown: Answer): HTMLElement {
    const view = card(true);
    if (shown.follow) view.card.classList.add('follow');
    view.line.textContent = T.notSent;
    view.row.appendChild(button(T.hide, 'hide', hide, T.hideLabel));
    const body = el('div', 'answer');
    body.setAttribute('tabindex', '-1');
    body.setAttribute('data-key', 'answer');
    const paragraphs = shown.text.split(/\n\s*\n/).map((part) => part.trim()).filter(Boolean);
    for (const part of paragraphs) body.appendChild(el('p', '', part));
    view.card.appendChild(body);
    if (shown.sources.length) view.card.appendChild(sourcesView(shown.sources));
    // The backend marks a cut-off item with its own ellipsis; the panel adds none.
    const gaps = shown.unanswered.map((item) => item.trim()).filter(Boolean);
    if (gaps.length) view.card.appendChild(el('p', 'gaps', fill(T.unanswered, { list: gaps.join('; ') })));
    return view.card;
  }

  function render(): void {
    if (theme) doc.documentElement.setAttribute('data-theme', theme);
    else doc.documentElement.removeAttribute('data-theme');
    // A redraw keeps focus on the control that had it (a source being opened).
    const active = doc.activeElement as HTMLElement | null;
    const had = active && root.contains(active) ? active.getAttribute('data-key') || '' : '';
    root.textContent = '';
    if (info) {
      const revealed = phase === 'revealed' && answer;
      root.appendChild(revealed ? revealedView(answer!) : cardView(info));
      if (revealed && answer!.follow) root.appendChild(outsideView(answer!));
      else if (phase === 'withdrawn' && follow) root.appendChild(outsideView(null));
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

  /**
   * What the host is told (design §A.5.5): for a revealed follow-up answer,
   * `H = min(A + R, cap)` where `A` is the first-answer card alone (the
   * outside container is never measured, so `H` never depends on what a
   * consult did) and `R` the container's fixed height. The card itself
   * scrolls inside `cap − R` when it is taller (CSS). A withdrawal keeps
   * reporting the height last reported for the revealed answer (or, on a
   * reopen that never showed it, the same rule over the withdrawn card), so
   * the host sees no change. Every other state reports the card as before;
   * Hide reports the hidden card.
   */
  function frameHeight(): number {
    const card = cardHeight();
    if (phase === 'revealed' && answer && answer.follow) {
      lockedHeight = Math.min(card + config.outsideHeightPx, config.frameCapPx);
      lockedWidth = cardWidth();
      if (info && lockedWidth > 0) void keepGeometry(info.jobId, lockedWidth, lockedHeight);
      return lockedHeight;
    }
    if (phase === 'withdrawn' && follow) {
      // Never shown here (a re-mount without a record for this width): the rule over the withdrawn card, settled once.
      if (lockedHeight < 0) {
        lockedHeight = Math.min(card + config.outsideHeightPx, config.frameCapPx);
        lockedWidth = cardWidth();
      }
      return lockedHeight;
    }
    return card;
  }

  function cardWidth(): number {
    return info && root.firstChild ? Math.ceil((root.firstChild as HTMLElement).offsetWidth || 0) : 0;
  }

  // One report per real change, at most once a frame: repeated reports of the
  // same size made the host re-lay out the frame on every poll.
  //
  // Nothing is reported before the host answers ui/initialize: a host drops
  // sizes sent before the handshake and keeps the height the frame inherited
  // (live 2026-10-02, a precomputed answer arrived at once and its card sat
  // about 150px taller than its content). The handshake then sends the current
  // height (forced, even if unchanged), again a moment later and on load; a
  // host that never answers gets it after a short fallback.
  let initialized = false;
  let lastHeight = -1;
  function reportHeight(force?: boolean): void {
    // Measured (and the revealed geometry locked) whether or not the host has
    // answered the handshake yet; only the report waits for it.
    const height = frameHeight();
    if (!initialized) return;
    if (height === lastHeight && !force) return;
    lastHeight = height;
    const host = openai();
    if (host && typeof host.notifyIntrinsicHeight === 'function') host.notifyIntrinsicHeight(height);
    const width = cardWidth();
    notify('ui/notifications/size-changed', width > 0 ? { width, height } : { height });
  }

  /** Measures again once layout (and the next frame) has settled. */
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
    const node = info ? root.firstChild as Element | null : null;
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
    appInfo: { name: 'olympus-private-answer', version: '1' },
    appCapabilities: {},
  }, (result: Any) => {
    if (result && result.hostContext) hostContext(result.hostContext);
    notify('ui/notifications/initialized');
    markInitialized();
  });
  setTimeout(markInitialized, config.initFallbackMs);
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
html:root>body #panel>.card.follow{max-height:464px!important;overflow:auto!important}
.card{margin:0;padding:0.75rem 0.875rem;border-radius:14px;background:var(--tint)}
.outside{display:block;box-sizing:border-box;margin:8px 0 0;padding:0;border-radius:14px;background:var(--tint);border:1px solid var(--hair);overflow:auto;overflow-wrap:anywhere}
.out-head{position:sticky;top:0;z-index:1;padding:0.625rem 0.875rem 0.375rem;background:var(--tint);border-bottom:1px solid var(--hair)}
.out-title{margin:0;font-size:0.8125rem;font-weight:600;line-height:1.35}
.out-note{margin:0.0625rem 0 0;font-size:0.75rem;line-height:1.4;color:var(--muted)}
.out-body{padding:0.5rem 0.875rem 0.75rem}
.out-text{font-size:0.875rem;line-height:1.5;white-space:pre-wrap}
.out-sub{margin:0;font-size:0.8125rem;line-height:1.4;color:var(--muted)}
.out-foot{margin:0.375rem 0 0;font-size:0.75rem;line-height:1.4;color:var(--muted)}
.asked{margin-top:0.375rem}
.asked-text{margin:0.25rem 0 0;font-size:0.8125rem;line-height:1.45;color:var(--muted);white-space:pre-wrap}
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
.sources{margin-top:0.5rem}
.src-toggle{display:inline-flex;align-items:center;gap:0.25rem;font:inherit;font-size:0.8125rem;font-weight:500;line-height:1.4;color:var(--muted);background:none;border:0;border-radius:6px;padding:0.125rem 0;margin:0;cursor:pointer;-webkit-appearance:none;appearance:none}
.src-toggle:hover{color:var(--text)}
.src-toggle:focus{outline:none}
.src-toggle:focus-visible{outline:2px solid var(--focus);outline-offset:2px}
.chev{width:0.75rem;height:0.75rem;fill:none;stroke:currentColor;stroke-width:1.6;stroke-linecap:round;stroke-linejoin:round;transition:transform 0.15s}
.src-toggle[aria-expanded=true] .chev{transform:rotate(180deg)}
.src-list{list-style:none;margin:0.25rem 0 0;padding:0;display:flex;flex-direction:column;gap:0.125rem;font-size:0.8125rem;line-height:1.45}
.src-name{color:var(--text)}
.src-link{font:inherit;color:var(--text);background:none;border:0;padding:0;margin:0;text-align:left;cursor:pointer;text-decoration:underline;text-decoration-color:var(--line);text-underline-offset:2px;-webkit-appearance:none;appearance:none}
.src-link:hover{text-decoration-color:currentColor}
.src-link:focus{outline:none}
.src-link:focus-visible{outline:2px solid var(--focus);outline-offset:2px;border-radius:2px}
.src-note{margin-left:0.5rem;font-size:0.75rem;color:var(--muted)}
.src-note.warn{color:var(--warning)}
.gaps{margin-top:0.5rem;font-size:0.75rem;line-height:1.4;color:var(--muted)}
.btn{flex:none;font:inherit;font-size:0.875rem;font-weight:500;line-height:1.25;min-height:2rem;padding:0.375rem 0.875rem;border-radius:999px;border:1px solid var(--line);background:var(--raise);color:var(--text);cursor:pointer;-webkit-appearance:none;appearance:none;box-shadow:none}
.btn:hover{background:var(--hover)}
.btn:focus{outline:none}
.btn:focus-visible{outline:2px solid var(--focus);outline-offset:2px}
@media (prefers-reduced-motion:reduce){.spinner{animation-duration:3s}.chev{transition:none}}
`;

/** The panel page, with every string it prints inlined as data. */
export function chatgptPrivateAnswerPageHtml(options: ChatGptPrivateAnswerPageOptions): string {
  const config: ChatGptPrivateAnswerConfig = {
    relayOrigin: options.relayOrigin,
    metaKey: PRIVATE_ANSWER_META_KEY,
    jobIdPattern: CHATGPT_PRIVATE_ANSWER_JOB_ID.source,
    copy: DASHBOARD_CHATGPT_PRIVATE_ANSWER_COPY,
    secondMs: options.secondMs ?? 1000,
    pollCapMs: options.pollCapMs ?? CHATGPT_PRIVATE_ANSWER_POLL_CAP_MS,
    fullPollCapMs: options.fullPollCapMs ?? CHATGPT_PRIVATE_ANSWER_FULL_POLL_CAP_MS,
    requestTimeoutMs: options.requestTimeoutMs ?? CHATGPT_PRIVATE_ANSWER_REQUEST_TIMEOUT_MS,
    noteMs: options.noteMs ?? 4000,
    heightResendMs: options.heightResendMs ?? 400,
    initFallbackMs: options.initFallbackMs ?? 500,
    keyStore: { ...CHATGPT_PRIVATE_ANSWER_KEY_STORE, ...options.keyStore },
    capability: CHATGPT_PRIVATE_ANSWER_CAPABILITY,
    followPollMs: options.followPollMs ?? CHATGPT_PRIVATE_ANSWER_FOLLOW_POLL_MS,
    outsideHeightPx: CHATGPT_PRIVATE_ANSWER_OUTSIDE_HEIGHT_PX,
    outsideGapPx: CHATGPT_PRIVATE_ANSWER_OUTSIDE_GAP_PX,
    frameCapPx: CHATGPT_PRIVATE_ANSWER_FRAME_CAP_PX,
    outsideLines: CHATGPT_PRIVATE_ANSWER_OUTSIDE_LINES,
    outsideLineChars: CHATGPT_PRIVATE_ANSWER_OUTSIDE_LINE_CHARS,
    outsideBytes: CHATGPT_PRIVATE_ANSWER_OUTSIDE_BYTES,
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
