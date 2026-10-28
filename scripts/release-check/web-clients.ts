/**
 * The web-client canary (release testing design, layer 5): the real ChatGPT, Claude.ai and Grok web apps, signed in with
 * dedicated test accounts, asked a few questions that only the canary machine's Olympus can answer.
 *
 * The browser runs on the canary machine itself, not here: connecting an app to Olympus ends on the engine's consent page on
 * the machine's own loopback address, so the browser that connected it, and keeps its sign-ins, is the machine's. The
 * canary starts that Chrome with its own profile and a debugging port on the machine's loopback, reaches the port through
 * the driver's `tunnel` verb, and drives each app over the DevTools protocol the way a person would: a new chat, the
 * question typed into the message box, Enter, and the reply read off the page once it stops changing.
 *
 * What a question is held to (all exact string matches on the page text after the question, nothing asks a model):
 *   - the app answered, and Olympus was used: one of the machine's app connections was used while the question was asked
 *     (its last use moved on), not just the name Olympus on the page;
 *   - every expected string is in the turn; a personal question names the items to cite, and one of them is in the turn;
 *   - no forbidden string is anywhere in the turn: the question's own, and every other question's (a Private fact or a
 *     Secret must not surface in any reply), except the strings this question expects;
 *   - a Private question gets the private note in the reply, and in ChatGPT the private answer panel under it;
 *   - a Secret question gets a refusal: the reply says it was withheld, or that it cannot be shared or found.
 * A bot check, a signed-out app, an app whose Olympus connection needs renewing or a page with no message box is
 * inconclusive, not a product failure: the report says which sign-in to renew. Each question gets a picture of the page.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Machine } from './machine.ts';
import type { CheckResult } from './report.ts';

export type WebClientId = 'chatgpt' | 'claude' | 'grok';
export const WEB_CLIENT_IDS: readonly WebClientId[] = ['chatgpt', 'claude', 'grok'];

export interface ClientQuestion {
  id: string;
  /** Exactly what is typed, for example "Use Olympus to find what Maya said about picking up the kids." */
  prompt: string;
  kind: 'personal' | 'private' | 'secret';
  /** Short strings the turn must contain (case and spacing ignored). */
  expect?: string[];
  /** Strings that must never appear in the turn: Private facts, Secrets. */
  forbid?: string[];
  /** A Private question in ChatGPT: strings its private answer panel must show (the panel is the only place they may appear). */
  panel_expect?: string[];
  /** Titles or senders of the items the answer should cite; when given, at least one must appear. */
  cite?: string[];
  /** The clients this question is asked in; all when left out. */
  clients?: WebClientId[];
}

interface ClientAdapter {
  label: string;
  /** A new, empty chat. */
  newChat: string;
  /** The message box, first match wins. */
  composer: string[];
  /** The panel ChatGPT renders under a Private match; other apps have none. */
  privatePanel?: RegExp;
}

export const CLIENT_ADAPTERS: Record<WebClientId, ClientAdapter> = {
  chatgpt: { label: 'ChatGPT', newChat: 'https://chatgpt.com/', composer: ['#prompt-textarea', 'div[contenteditable="true"]', 'textarea'], privatePanel: /Private answer from your (computer|Mac)|Not sent to ChatGPT/i },
  claude: { label: 'Claude.ai', newChat: 'https://claude.ai/new', composer: ['div[contenteditable="true"].ProseMirror', 'div[contenteditable="true"]', 'textarea'] },
  grok: { label: 'Grok', newChat: 'https://grok.com/', composer: ['textarea', 'div[contenteditable="true"]'] },
};

/** The note an agent gets for a Private match, as the apps reword it: the answer is in Olympus, on the computer. */
const PRIVATE_NOTE = /privately|private (answer|panel)|on (your|the) (computer|mac)\b|not sent to/i;
/** A reply that says the app cannot reach Olympus: its connection needs renewing, not the product fixing. */
const NOT_CONNECTED = /(connect|reconnect|authori[sz]e|sign in to) olympus|olympus (isn't|is not) (connected|available)|couldn't (reach|access) olympus|no (access|connection) to olympus/i;
/** A refusal, as the apps reword Olympus's withheld answer (core/remote-result.ts REMOTE_ANSWER_WITHHELD) or a search with nothing it may show. */
const REFUSAL = /withh(e|o)ld|privacy (rules|settings)|(can['’]t|cannot|can not|couldn['’]t|could not|didn['’]t|did not|won['’]t|will not|unable to|not able to|wasn['’]t able to|not allowed to) (share|provide|reveal|show|disclose|access|give|retrieve|find|locate)|no (matching )?(results|records|matches)|(is|are|was|were|marked( as)?) (a )?(secret|private)\b/i;

export const WEB_DEBUG_PORT = 9333;
export const WEB_PROFILE = '.olympus-canary/web-clients';

export interface PageState {
  url: string;
  title: string;
  /** A bot check stands in front of the app. */
  challenge: boolean;
  /** The app offers Log in or Sign in: the test account is signed out. */
  signedOut: boolean;
  composer: boolean;
  /** What the message box still holds: a question that is still there was not sent. */
  composerText: string;
  /** A Stop control is showing: the reply is still being written. */
  busy: boolean;
  text: string;
}

export type Inconclusive = { inconclusive: string };

/** Why a page cannot be asked anything, or undefined when it can. */
export function blockedReason(client: WebClientId, state: PageState): string | undefined {
  const label = CLIENT_ADAPTERS[client].label;
  if (state.challenge) return `${label} showed a bot check ("${state.title.slice(0, 60)}"); open it once in the canary browser and pass the check`;
  if (state.signedOut) return `${label} is signed out; sign the test account in again in the canary browser`;
  if (!state.composer) return `${label} showed no message box at ${state.url.slice(0, 120)}; the page may have changed (CLIENT_ADAPTERS in scripts/release-check/web-clients.ts)`;
  return undefined;
}

const fold = (text: string): string => text.replace(/[  \s]+/g, ' ').toLowerCase().trim();
export const turnContains = (turn: string, needle: string): boolean => fold(turn).includes(fold(needle));

/**
 * The turn: everything on the page after the question as it was typed (the app's tool chips, the reply, its citations).
 * Fresh chats hold one question, so the first place the question appears is where the turn starts: a reply that repeats the
 * question keeps everything it said before the repeat, so nothing it leaked is cut away.
 */
export function turnText(pageText: string, prompt: string): string {
  const head = prompt.trim().slice(0, 60);
  const at = pageText.indexOf(head);
  if (at === -1) return pageText;
  const after = pageText.slice(at + head.length);
  const rest = prompt.trim().slice(60);
  return rest && after.startsWith(rest) ? after.slice(rest.length) : after;
}

/** Replaces each forbidden string with its index, so a report never repeats what leaked. */
export function redactForbidden(text: string, forbid: readonly string[]): string {
  let out = text;
  forbid.forEach((value, index) => {
    if (!value) return;
    const pattern = new RegExp(value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+'), 'gi');
    out = out.replace(pattern, `[forbidden ${index + 1}]`);
  });
  return out;
}

export interface TurnObservation {
  turn: string;
  /** Text of the frames under the reply (ChatGPT's panels). */
  frames: string;
  ms: number;
  /** The reply was still coming when the answer time ran out: what it said so far is not a finished answer. */
  unfinished?: boolean;
  /** Whether one of the machine's app connections was used while the question was asked; left out when it was not read. */
  olympus?: OlympusUse;
}

export type OlympusUse = { used: boolean; detail: string } | { unreadable: string };

/**
 * The strings a question is held not to say: its own forbidden ones, and every other question's, less those it expects.
 * Another question's string that this question's own prompt contains is left out too: a reply that repeats the question
 * ("the new parenting plan") is not a leak.
 */
export function forbiddenFor(q: ClientQuestion, shared: readonly string[] = []): string[] {
  const allowed = new Set([...(q.expect ?? []), ...(q.cite ?? [])].map(fold));
  const own = q.forbid ?? [];
  const out: string[] = [];
  for (const value of [...own, ...shared]) {
    if (!value || allowed.has(fold(value)) || out.some((have) => fold(have) === fold(value))) continue;
    if (!own.includes(value) && turnContains(q.prompt, value)) continue;
    out.push(value);
  }
  return out;
}

/** An evidence id as Olympus hands it out ([E1]); every entry it names carries its source. */
const EVIDENCE_ID = /\[E\d+\]/;

/** The checks for one asked question. Never repeats a forbidden string. */
export function evaluateTurn(client: WebClientId, q: ClientQuestion, obs: TurnObservation | Inconclusive, sharedForbid: readonly string[] = []): CheckResult[] {
  const prefix = `web.${client}.${q.id}`;
  const label = CLIENT_ADAPTERS[client].label;
  if ('inconclusive' in obs) return [{ id: prefix, title: `${label}: ${q.id}`, status: 'skip', detail: `Inconclusive: ${obs.inconclusive}` }];
  const forbid = forbiddenFor(q, sharedForbid);
  const turn = obs.turn.trim();
  const shown = redactForbidden(turn.replace(/\s+/g, ' '), forbid).slice(0, 400);
  const checks: CheckResult[] = [];
  const add = (id: string, title: string, ok: boolean, detail: string): void => {
    checks.push({ id: `${prefix}.${id}`, title: `${label}: ${q.id}: ${title}`, status: ok ? 'pass' : 'fail', detail, ms: obs.ms });
  };
  if (turn.length === 0) {
    add('answered', 'the app answered', false, 'no reply appeared after the question');
    return checks;
  }
  // ChatGPT's private panel shows the Private answer on purpose (its model never receives it), so only the turn is searched.
  const leaked = forbid.map((value, index) => ({ index, hit: value !== '' && turnContains(turn, value) })).filter((row) => row.hit);
  // A reply that cannot reach Olympus is a connection to renew, unless it leaked something on the way.
  if (leaked.length === 0 && NOT_CONNECTED.test(turn) && !(q.expect ?? []).some((value) => turnContains(turn, value))) {
    return [{ id: prefix, title: `${label}: ${q.id}`, status: 'skip', detail: `Inconclusive: ${label} could not reach Olympus; connect Olympus again in the test account (reply: ${shown.slice(0, 200)})` }];
  }
  add('answered', 'the app answered', !obs.unfinished, obs.unfinished ? `the reply was still coming after ${Math.round(obs.ms / 1000)} s (${turn.length} characters so far)` : `${turn.length} characters in ${Math.round(obs.ms / 1000)} s`);
  // The word Olympus on the page proves nothing (the question names it); a connection used while it was asked does.
  const use = obs.olympus ?? { unreadable: 'the machine\'s app connections were not read' };
  if ('unreadable' in use) checks.push({ id: `${prefix}.used-olympus`, title: `${label}: ${q.id}: Olympus was used`, status: 'skip', detail: `Inconclusive: ${use.unreadable}`, ms: obs.ms });
  else add('used-olympus', 'Olympus was used', use.used, use.used ? use.detail : `${use.detail}, so the app answered without Olympus: ${shown}`);
  add('no-leak', 'nothing forbidden in the reply', leaked.length === 0,
    leaked.length === 0 ? `none of ${forbid.length} forbidden string(s)` : `forbidden string(s) ${leaked.map((row) => row.index + 1).join(', ')} of ${forbid.length} appeared`);
  if (q.kind === 'secret') add('refused', 'the reply refuses the Secret', REFUSAL.test(turn), REFUSAL.test(turn) ? 'the reply says it is withheld or cannot be shared' : `the reply neither withholds nor refuses: ${shown}`);
  if (q.kind === 'private') {
    add('private-note', 'the reply says the answer is private, on the computer', PRIVATE_NOTE.test(turn), PRIVATE_NOTE.test(turn) ? 'the reply points to the private answer' : `no private note in the reply: ${shown}`);
    const panel = CLIENT_ADAPTERS[client].privatePanel;
    if (panel) {
      add('private-panel', 'the private answer panel shows under the reply', panel.test(obs.frames), panel.test(obs.frames) ? 'the panel is on the page' : 'no private answer panel appeared within the wait');
      const wanted = q.panel_expect ?? [];
      if (wanted.length > 0 && panel.test(obs.frames)) {
        // The panel's own text holds Private facts by design; only which expected strings are missing is reported.
        const missing = wanted.filter((value) => !turnContains(obs.frames, value));
        add('private-panel-facts', 'the private answer panel states the expected facts', missing.length === 0, missing.length === 0 ? `all ${wanted.length} stated in the panel` : `${missing.length} of ${wanted.length} expected string(s) missing from the panel`);
      }
    }
  }
  const expect = q.expect ?? [];
  if (expect.length > 0) {
    const missing = expect.filter((value) => !turnContains(turn, value));
    add('facts', 'the expected facts are stated', missing.length === 0, missing.length === 0 ? `all ${expect.length} stated` : `missing ${missing.map((value) => `"${value}"`).join(', ')}: ${shown}`);
  }
  const cite = q.cite ?? [];
  if (cite.length > 0) {
    const cited = cite.filter((value) => turnContains(turn, value));
    // A bare [E1] cites an Olympus evidence entry, which carries its source, so it counts when Olympus was used.
    // Naming the source in the answer is a product question for after 1.2.0 (src/workers/chatgpt/response-builder.ts SEARCH_INSTRUCTION).
    const evidence = cited.length === 0 && EVIDENCE_ID.test(turn) && 'used' in use && use.used;
    add('cited', 'a source item is cited', cited.length > 0 || evidence,
      cited.length > 0 ? `cites ${cited.map((value) => `"${value}"`).join(', ')}`
        : evidence ? 'cites Olympus evidence by id ([E1]); the source is not named in the reply'
          : `none of ${cite.map((value) => `"${value}"`).join(', ')} is cited`);
  } else if (q.kind === 'personal') {
    // A personal answer comes from items; a question that names none to cite cannot tell a cited answer from a guess.
    add('cited', 'a source item is cited', false, 'the question names no items to cite (cite in the questions file)');
  }
  return checks;
}

/** The questions file: a list, or an object holding one under "questions" (the demo kit's shape). */
export function parseClientQuestions(raw: unknown): ClientQuestion[] {
  const list = Array.isArray(raw) ? raw : (raw as { questions?: unknown } | null)?.questions;
  if (!Array.isArray(list)) throw new Error('the questions file holds no list of questions');
  const strings = (value: unknown, field: string, id: string): string[] | undefined => {
    if (value === undefined) return undefined;
    if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) throw new Error(`question ${id}: ${field} must be a list of strings`);
    return value as string[];
  };
  const seen = new Set<string>();
  return list.map((entry, index) => {
    const q = entry as Record<string, unknown>;
    const id = typeof q.id === 'string' && /^[a-z0-9][a-z0-9-]{0,62}$/.test(q.id) ? q.id : undefined;
    if (!id) throw new Error(`question ${index + 1}: id must be lowercase letters, digits and dashes`);
    if (seen.has(id)) throw new Error(`question ${id} is listed twice`);
    seen.add(id);
    if (typeof q.prompt !== 'string' || q.prompt.trim().length === 0) throw new Error(`question ${id}: prompt is missing`);
    if (q.kind !== 'personal' && q.kind !== 'private' && q.kind !== 'secret') throw new Error(`question ${id}: kind is personal, private or secret`);
    const clients = strings(q.clients, 'clients', id);
    if (clients?.some((client) => !WEB_CLIENT_IDS.includes(client as WebClientId))) throw new Error(`question ${id}: clients are ${WEB_CLIENT_IDS.join(', ')}`);
    const optional = (field: 'expect' | 'forbid' | 'panel_expect' | 'cite') => { const value = strings(q[field], field, id); return value ? { [field]: value } : {}; };
    return {
      id, prompt: q.prompt, kind: q.kind,
      ...optional('expect'), ...optional('forbid'), ...optional('panel_expect'), ...optional('cite'),
      ...(clients ? { clients: clients as WebClientId[] } : {}),
    };
  });
}

/**
 * When each of the machine's app connections was last used, by id: active ones only, the canary's own left out.
 * The engine rewrites a connection's last use at most once a minute (core/remote-connections.ts
 * REMOTE_CONNECTION_LAST_USED_RESOLUTION_MS), so questions are asked at least CONNECTION_USE_GAP_MS apart.
 */
export const CONNECTION_USE_GAP_MS = 61_000;
const CANARY_CONNECTION = 'release-canary';

export function connectionUses(listed: unknown): Map<string, { name: string; at: string }> | undefined {
  const rows = (listed as { connections?: unknown } | null)?.connections;
  if (!Array.isArray(rows)) return undefined;
  const out = new Map<string, { name: string; at: string }>();
  for (const row of rows as Array<Record<string, unknown>>) {
    if (typeof row?.id !== 'string' || row.status !== 'active' || row.name === CANARY_CONNECTION) continue;
    out.set(row.id, { name: String(row.name ?? row.id), at: typeof row.last_used_at === 'string' ? row.last_used_at : '' });
  }
  return out;
}

/** Whether a connection was used between two readings: its last use moved on, or it is new and has been used. */
export function olympusUse(before: Map<string, { name: string; at: string }> | string, after: Map<string, { name: string; at: string }> | string): OlympusUse {
  if (typeof before === 'string') return { unreadable: before };
  if (typeof after === 'string') return { unreadable: after };
  const moved = [...after].filter(([id, now]) => now.at !== '' && now.at !== before.get(id)?.at).map(([, now]) => now.name);
  if (moved.length > 0) return { used: true, detail: `the connection ${moved.map((name) => `"${name}"`).join(', ')} was used while it was asked` };
  return { used: false, detail: after.size === 0 ? 'the machine has no app connection' : `none of the machine's ${after.size} app connection(s) was used while it was asked` };
}

async function readConnectionUses(machine: Machine): Promise<Map<string, { name: string; at: string }> | string> {
  const result = await machine.exec('"$HOME/.local/bin/olympus" connections list', { timeoutMs: 60_000 }).catch((error: unknown) => ({ code: 1, stdout: '', stderr: error instanceof Error ? error.message : String(error) }));
  if (result.code !== 0) return `olympus connections list failed: ${(result.stdout + result.stderr).trim().slice(-200) || `exit ${result.code}`}`;
  let listed: unknown;
  try { listed = JSON.parse(result.stdout); } catch { return `olympus connections list printed something that is not JSON: ${result.stdout.slice(0, 120)}`; }
  return connectionUses(listed) ?? 'olympus connections list printed no connections list';
}

export const isInconclusive = (check: CheckResult): boolean => check.status === 'skip' && (check.detail ?? '').startsWith('Inconclusive');

// ---------------------------------------------------------------------------
// The DevTools connection: one browser socket, sessions flattened onto it

interface BrowserSession {
  send(method: string, params?: Record<string, unknown>, sessionId?: string): Promise<any>;
  on(method: string, handler: (params: any, sessionId?: string) => void): void;
  close(): void;
}

async function connectBrowser(wsUrl: string): Promise<BrowserSession> {
  const ws = new WebSocket(wsUrl);
  await new Promise<void>((resolve, reject) => { ws.onopen = () => resolve(); ws.onerror = () => reject(new Error('the canary browser refused the debugging connection')); });
  let nextId = 1;
  const pending = new Map<number, { resolve(v: any): void; reject(e: Error): void }>();
  const listeners = new Map<string, Array<(params: any, sessionId?: string) => void>>();
  ws.onmessage = (event) => {
    const message = JSON.parse(String(event.data)) as { id?: number; result?: any; error?: { message: string }; method?: string; params?: any; sessionId?: string };
    if (message.id === undefined) {
      for (const handler of listeners.get(message.method ?? '') ?? []) handler(message.params, message.sessionId);
      return;
    }
    const waiter = pending.get(message.id);
    if (!waiter) return;
    pending.delete(message.id);
    if (message.error) waiter.reject(new Error(message.error.message)); else waiter.resolve(message.result);
  };
  ws.onclose = () => { for (const waiter of pending.values()) waiter.reject(new Error('the canary browser closed the debugging connection')); pending.clear(); };
  return {
    send: (method, params = {}, sessionId) => new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    }),
    on: (method, handler) => { listeners.set(method, [...(listeners.get(method) ?? []), handler]); },
    close: () => ws.close(),
  };
}

/** What the page shows, read in the page. Visible elements only: apps keep hidden copies of their controls. */
export const PAGE_STATE_SCRIPT = (composers: readonly string[]): string => `(() => {
  const visible = (el) => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none'; };
  const controls = [...document.querySelectorAll('button, a, [role="button"]')].filter(visible);
  const named = (el) => (el.getAttribute('aria-label') || el.innerText || '').trim();
  const composer = ${JSON.stringify(composers)}.map((sel) => [...document.querySelectorAll(sel)].find(visible)).find(Boolean);
  const text = (document.querySelector('main') || document.body)?.innerText || '';
  return {
    url: location.href,
    title: document.title,
    challenge: /just a moment|verify you are human|attention required/i.test(document.title) || !!document.querySelector('iframe[src*="challenges.cloudflare.com"], #challenge-form, #cf-challenge-running'),
    signedOut: /\\/(log-?in|sign-?in|auth)\\b/i.test(location.pathname) || controls.some((el) => /^(log ?in|sign ?in)$/i.test(named(el))),
    composer: !!composer,
    composerText: composer ? (composer.value ?? composer.innerText ?? '') : '',
    busy: controls.some((el) => /^stop\\b/i.test(named(el)) || /stop-button/.test(el.getAttribute('data-testid') || '')),
    text,
  };
})()`;

/** Presses a permission the app asks for a tool call (Claude.ai asks before a connector's first use): the test account allows it. */
const ALLOW_SCRIPT = `(() => {
  const visible = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
  const button = [...document.querySelectorAll('button')].filter(visible).find((el) => /^(always allow|allow always|allow for this chat|allow once|allow)$/i.test((el.innerText || '').trim()));
  if (!button) return false;
  button.click();
  return true;
})()`;

const FOCUS_SCRIPT = (composers: readonly string[]): string => `(() => {
  const el = ${JSON.stringify(composers)}.map((sel) => document.querySelector(sel)).find(Boolean);
  if (!el) return false;
  el.focus();
  return true;
})()`;

const SEND_BUTTON_SCRIPT = `(() => {
  const button = [...document.querySelectorAll('button')].find((el) => /send/i.test(el.getAttribute('aria-label') || '') || el.getAttribute('data-testid') === 'send-button');
  if (!button || button.disabled) return false;
  button.click();
  return true;
})()`;

const FRAME_TEXT_SCRIPT = `(() => [...document.querySelectorAll('iframe')].map((frame) => { try { return frame.contentDocument?.body?.innerText || ''; } catch { return ''; } }).join('\\n'))()`;

interface Tab {
  evaluate<T>(expression: string): Promise<T>;
  /** Text of every frame the page holds, cross-origin ones included. */
  framesText(): Promise<string>;
  goto(url: string): Promise<void>;
  type(text: string): Promise<void>;
  enter(): Promise<void>;
  screenshot(path: string): Promise<void>;
  close(): Promise<void>;
}

async function openTab(browser: BrowserSession): Promise<Tab> {
  const { targetId } = await browser.send('Target.createTarget', { url: 'about:blank' }) as { targetId: string };
  const { sessionId } = await browser.send('Target.attachToTarget', { targetId, flatten: true }) as { sessionId: string };
  // Cross-origin frames (ChatGPT's app panels) are their own targets; each one attached here is read for framesText().
  const frames = new Set<string>();
  browser.on('Target.attachedToTarget', (params, parent) => {
    if (parent !== sessionId && !frames.has(parent ?? '')) return;
    const child = params.sessionId as string;
    frames.add(child);
    void browser.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true }, child).catch(() => {});
    void browser.send('Runtime.runIfWaitingForDebugger', {}, child).catch(() => {});
  });
  browser.on('Target.detachedFromTarget', (params) => { frames.delete(params.sessionId as string); });
  await browser.send('Page.enable', {}, sessionId);
  await browser.send('Runtime.enable', {}, sessionId);
  await browser.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true }, sessionId);
  const evaluateIn = async <T>(session: string, expression: string): Promise<T> => {
    const out = await browser.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, session) as { result?: { value?: T }; exceptionDetails?: { text?: string } };
    if (out.exceptionDetails) throw new Error(`page script failed: ${out.exceptionDetails.text ?? 'exception'}`);
    return out.result?.value as T;
  };
  return {
    evaluate: (expression) => evaluateIn(sessionId, expression),
    framesText: async () => {
      const parts = [await evaluateIn<string>(sessionId, FRAME_TEXT_SCRIPT).catch(() => '')];
      for (const frame of frames) parts.push(await evaluateIn<string>(frame, 'document.body ? document.body.innerText : ""').catch(() => ''));
      return parts.join('\n');
    },
    goto: async (url) => { await browser.send('Page.navigate', { url }, sessionId); },
    type: async (text) => { await browser.send('Input.insertText', { text }, sessionId); },
    enter: async () => {
      for (const type of ['keyDown', 'keyUp']) await browser.send('Input.dispatchKeyEvent', { type, key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13, ...(type === 'keyDown' ? { text: '\r' } : {}) }, sessionId);
    },
    screenshot: async (path) => {
      const shot = await browser.send('Page.captureScreenshot', { format: 'png' }, sessionId) as { data: string };
      writeFileSync(path, Buffer.from(shot.data, 'base64'));
    },
    close: async () => { await browser.send('Target.closeTarget', { targetId }).catch(() => {}); },
  };
}

// ---------------------------------------------------------------------------
// Asking

export interface AskTimings {
  pollMs: number;
  /** How long a page may take to show its message box. */
  loadMs: number;
  /** How long a reply may take, tool calls included (a Private answer can take a minute). */
  answerMs: number;
  /** How long the reply must stay unchanged to count as finished. */
  settleMs: number;
  /** How long ChatGPT's private panel may take to appear after the reply. */
  panelMs: number;
  sleep: (ms: number) => Promise<void>;
}

export const DEFAULT_TIMINGS: AskTimings = {
  pollMs: 2_000, loadMs: 45_000, answerMs: 300_000, settleMs: 8_000, panelMs: 90_000,
  sleep: (ms) => new Promise((done) => setTimeout(done, ms)),
};

async function waitForPage(tab: Tab, client: WebClientId, t: AskTimings): Promise<PageState> {
  const script = PAGE_STATE_SCRIPT(CLIENT_ADAPTERS[client].composer);
  const deadline = Date.now() + t.loadMs;
  let state: PageState;
  for (;;) {
    state = await tab.evaluate<PageState>(script).catch(() => ({ url: '', title: '', challenge: false, signedOut: false, composer: false, composerText: '', busy: false, text: '' }));
    if ((state.composer && !state.signedOut) || Date.now() >= deadline) return state;
    await t.sleep(t.pollMs);
  }
}

/** Asks one question in a new chat and reads the turn once it stops changing. */
export async function askQuestion(tab: Tab, client: WebClientId, q: ClientQuestion, t: AskTimings = DEFAULT_TIMINGS, newChat = CLIENT_ADAPTERS[client].newChat): Promise<TurnObservation | Inconclusive> {
  const adapter = CLIENT_ADAPTERS[client];
  await tab.goto(newChat);
  await t.sleep(t.pollMs);
  const ready = await waitForPage(tab, client, t);
  const blocked = blockedReason(client, ready);
  if (blocked) return { inconclusive: blocked };
  if (!await tab.evaluate<boolean>(FOCUS_SCRIPT(adapter.composer))) return { inconclusive: `${adapter.label}'s message box could not be focused` };
  await tab.type(q.prompt);
  await tab.enter();
  const started = Date.now();
  const script = PAGE_STATE_SCRIPT(adapter.composer);
  let last = '';
  let stableSince = Date.now();
  let sendRetried = false;
  let settled = false;
  for (;;) {
    await t.sleep(t.pollMs);
    await tab.evaluate<boolean>(ALLOW_SCRIPT).catch(() => false);
    const state = await tab.evaluate<PageState>(script);
    if (state.challenge || state.signedOut) return { inconclusive: blockedReason(client, state)! };
    const turn = turnText(state.text, q.prompt);
    // Some apps keep the text in the box when Enter only adds a line; their send button sends it.
    if (!sendRetried && Date.now() - started >= 2 * t.pollMs && state.composerText.includes(q.prompt.trim().slice(0, 40))) {
      sendRetried = true;
      await tab.evaluate<boolean>(SEND_BUTTON_SCRIPT).catch(() => false);
    }
    if (turn !== last || state.busy) { last = turn; stableSince = Date.now(); }
    settled = !state.busy && turn.trim().length > 0 && Date.now() - stableSince >= t.settleMs;
    if (settled || Date.now() - started >= t.answerMs) break;
  }
  const ms = Date.now() - started;
  let frames = await tab.framesText();
  const panel = adapter.privatePanel;
  // The panel shows its heading while it still prepares the answer, so it is ready only once its facts are there too.
  const panelReady = (text: string): boolean => !!panel && panel.test(text) && (q.panel_expect ?? []).every((fact) => turnContains(text, fact));
  if (q.kind === 'private' && panel && !panelReady(frames)) {
    const deadline = Date.now() + t.panelMs;
    while (!panelReady(frames) && Date.now() < deadline) {
      await t.sleep(t.pollMs);
      frames = await tab.framesText();
    }
  }
  // The turn is read again: a panel that arrived late can come with more reply text.
  const final = await tab.evaluate<PageState>(script);
  const turn = turnText(final.text, q.prompt);
  // A reply that was empty at the deadline is judged as no reply; one cut off mid-way is unfinished.
  return { turn, frames, ms, ...(!settled && turn.trim().length > 0 ? { unfinished: true } : {}) };
}

export interface WebClientsOptions {
  clients: WebClientId[];
  questions: ClientQuestion[];
  os: 'linux' | 'macos';
  screensDir: string;
  timings?: AskTimings;
  debugPort?: number;
  /** Where each app's new chat opens; the apps' own addresses when left out (tests serve stand-ins). */
  newChatUrls?: Partial<Record<WebClientId, string>>;
  /** The least time between questions, so each one's connection use shows (CONNECTION_USE_GAP_MS when left out). */
  useGapMs?: number;
}

const shellQuote = (value: string): string => `'${value.replace(/'/g, `'\\''`)}'`;

/** Starts the canary's Chrome on the machine (a window on its desktop, with its own profile), unless it already runs. */
export function startBrowserScript(os: 'linux' | 'macos', port: number, urls: readonly string[] = []): string {
  const flags = [`--user-data-dir="$HOME/${WEB_PROFILE}"`, `--remote-debugging-port=${port}`, '--remote-debugging-address=127.0.0.1', '--no-first-run', '--no-default-browser-check'];
  const open = urls.map(shellQuote).join(' ');
  // A browser that already runs opens the pages as new tabs through its own debugging port.
  const tabs = urls.map((url) => `curl -fsS --max-time 5 -X PUT ${shellQuote(`http://127.0.0.1:${port}/json/new?${url}`)} >/dev/null || true`).join('\n  ');
  const launch = os === 'macos'
    ? `open -na 'Google Chrome' --args ${flags.join(' ')} ${open}`
    : `b="$(command -v google-chrome-stable || command -v google-chrome || command -v chromium)"; [ -n "$b" ] || { echo "no Chrome or Chromium on the machine"; exit 1; }; setsid "$b" ${flags.join(' ')} ${open} >/dev/null 2>&1 < /dev/null &`;
  return `mkdir -p "$HOME/${WEB_PROFILE}"
if curl -fsS --max-time 3 http://127.0.0.1:${port}/json/version >/dev/null 2>&1; then
  ${tabs || 'true'}
else
  ${launch}
fi
for i in $(seq 1 40); do curl -fsS --max-time 3 http://127.0.0.1:${port}/json/version && exit 0; sleep 1; done
echo "the canary browser did not open its debugging port ${port}"; exit 1`;
}

/** Runs every client's questions. Never throws for an app or product problem: each one is a check. */
export async function runWebClients(machine: Machine, options: WebClientsOptions): Promise<{ checks: CheckResult[]; screens: Array<{ label: string; path: string }> }> {
  const checks: CheckResult[] = [];
  const screens: Array<{ label: string; path: string }> = [];
  const port = options.debugPort ?? WEB_DEBUG_PORT;
  const t = options.timings ?? DEFAULT_TIMINGS;
  const started = Date.now();
  const stop = (detail: string): { checks: CheckResult[]; screens: typeof screens } => {
    checks.push({ id: 'web.browser', title: 'The canary browser on the machine', status: 'skip', detail: `Inconclusive: ${detail}`, ms: Date.now() - started });
    return { checks, screens };
  };
  if (!machine.tunnel) return stop('the driver has no tunnel verb, so the browser on the machine cannot be reached');
  const launched = await machine.exec(startBrowserScript(options.os, port), { timeoutMs: 90_000 });
  if (launched.code !== 0) return stop((launched.stdout + launched.stderr).trim().slice(-300) || `the browser did not start (exit ${launched.code})`);
  let tunnel;
  try { tunnel = await machine.tunnel(port); } catch (error) { return stop(error instanceof Error ? error.message : String(error)); }
  let browser: BrowserSession | undefined;
  try {
    const version = await (await fetch(`http://127.0.0.1:${tunnel.port}/json/version`)).json() as { webSocketDebuggerUrl?: string };
    if (!version.webSocketDebuggerUrl) return stop('the browser gave no debugging address');
    // The address names the machine's own port; here it is the tunnel's.
    const wsUrl = version.webSocketDebuggerUrl.replace(/^ws:\/\/[^/]+/, `ws://127.0.0.1:${tunnel.port}`);
    browser = await connectBrowser(wsUrl);
    checks.push({ id: 'web.browser', title: 'The canary browser on the machine', status: 'pass', detail: `reached through the tunnel in ${Math.round((Date.now() - started) / 1000)} s`, ms: Date.now() - started });
    mkdirSync(options.screensDir, { recursive: true });
    const gap = options.useGapMs ?? CONNECTION_USE_GAP_MS;
    // Each question is held to every other question's forbidden strings too.
    const sharedForbid = options.questions.flatMap((question) => question.forbid ?? []);
    // A use in the last minute before the first question would hide that question's own.
    let lastAsked = Date.now();
    for (const client of options.clients) {
      const tab = await openTab(browser);
      try {
        for (const q of options.questions.filter((question) => !question.clients || question.clients.includes(client))) {
          await t.sleep(Math.max(0, gap - (Date.now() - lastAsked)));
          const before = await readConnectionUses(machine);
          let obs: TurnObservation | Inconclusive;
          try { obs = await askQuestion(tab, client, q, t, options.newChatUrls?.[client]); } catch (error) { obs = { inconclusive: `${CLIENT_ADAPTERS[client].label} could not be driven: ${error instanceof Error ? error.message : String(error)}` }; }
          lastAsked = Date.now();
          if (!('inconclusive' in obs)) obs = { ...obs, olympus: olympusUse(before, await readConnectionUses(machine)) };
          const picture = join(options.screensDir, `web-${client}-${q.id}.png`);
          try { await tab.screenshot(picture); screens.push({ label: `${CLIENT_ADAPTERS[client].label}: ${q.id}`, path: picture }); } catch { /* no picture */ }
          const results = evaluateTurn(client, q, obs, sharedForbid);
          checks.push(...results);
          // A signed-out app or a bot check stops that app: every later question would say the same.
          if (results.length === 1 && isInconclusive(results[0]!) && !/could not reach Olympus/.test(results[0]!.detail ?? '')) break;
        }
      } finally {
        await tab.close();
      }
    }
  } catch (error) {
    checks.push({ id: 'web.driver', title: 'Driving the web clients', status: 'skip', detail: `Inconclusive: ${error instanceof Error ? error.message : String(error)}` });
  } finally {
    browser?.close();
    tunnel.close();
  }
  return { checks, screens };
}

/** Opens the canary browser on the machine at each app, for a person to sign the test accounts in and connect Olympus. */
export async function openForSignIn(machine: Machine, os: 'linux' | 'macos', clients: readonly WebClientId[], port = WEB_DEBUG_PORT): Promise<string> {
  const urls = clients.map((client) => CLIENT_ADAPTERS[client].newChat);
  const result = await machine.exec(startBrowserScript(os, port, urls), { timeoutMs: 90_000 });
  if (result.code !== 0) throw new Error((result.stdout + result.stderr).trim().slice(-300));
  return `The canary browser is open on ${machine.handle} at ${clients.map((client) => CLIENT_ADAPTERS[client].label).join(', ')}.`;
}
