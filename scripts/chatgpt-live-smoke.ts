/**
 * Live smoke for the Olympus ChatGPT surface: calls the tools exactly as
 * ChatGPT does, over the public relay, and acts as the private answer panel.
 * Read-only: it calls tools and collects panel answers; it restarts nothing
 * and changes no settings. See docs/design/chatgpt-plugin.md, "Live smoke".
 *
 *   bun scripts/chatgpt-live-smoke.ts --question "What do I have about integral theory?"
 *   bun scripts/chatgpt-live-smoke.ts --quiet --expect-private \
 *     --question "What did my June 2026 blood work show? Use Olympus." \
 *     --follow-up "Give me all the details from the June 2026 blood work lab." --follow-up-detail full
 *
 * Token: the supported local-operator path. In relay mode the engine lets a
 * local development client register and be approved only by a direct
 * loopback visit (src/workers/remote-oauth/handler.ts: being at the Mac is the
 * proof of ownership). The script registers one client, "Olympus live smoke",
 * with a loopback redirect (its id is kept in ~/.olympus/live-smoke-client.json;
 * it is a public client, no secret), approves it on 127.0.0.1, exchanges the
 * code with PKCE at the relay's token endpoint like ChatGPT does, and revokes
 * the grant when the run ends. Tokens are never printed or stored.
 *
 * Exit status: 0 all checks passed; 1 a check failed (private content in tool
 * output, panel failure, a private answer slower than the panel waits: 120 s
 * summary, its full-detail cap for full); 2 the run could not start (token,
 * relay, arguments).
 */
import { createHash, randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { PRIVATE_ANSWER_META_KEY } from '../src/workers/chatgpt/private-answer-contract.ts';
import { generatePanelKeyPair, openPrivateAnswer } from '../src/workers/chatgpt/private-answer-crypto.ts';
import {
  PRIVATE_MATCH_NOTE,
  PRIVATE_MATCH_PANEL_FULL_NOTE,
  PRIVATE_MATCH_PANEL_NOTE,
  PRIVATE_MATCH_PANEL_SETUP_NOTE,
} from '../src/workers/chatgpt/response-builder.ts';
import {
  CHATGPT_PRIVATE_ANSWER_FULL_POLL_CAP_MS,
  CHATGPT_PRIVATE_ANSWER_POLL_CAP_MS,
} from '../src/workers/dashboard/chatgpt/private-answer.ts';

/** The panel's own poll caps, read from the panel itself so the smoke waits exactly as long as it does. */
export const PANEL_POLL_CAP_MS = CHATGPT_PRIVATE_ANSWER_POLL_CAP_MS;
export const PANEL_FULL_POLL_CAP_MS = CHATGPT_PRIVATE_ANSWER_FULL_POLL_CAP_MS;
/** A private answer slower than the panel waits is one the owner never sees. */
export const SUMMARY_BUDGET_MS = PANEL_POLL_CAP_MS;
export const FULL_BUDGET_MS = PANEL_FULL_POLL_CAP_MS;
const TOOL_TIMEOUT_MS = 180_000;
const SMOKE_CLIENT_NAME = 'Olympus live smoke';
const SMOKE_REDIRECT_URI = 'http://127.0.0.1:53682/olympus-live-smoke/callback';
/** The only fields the response builder copies into the panel's `_meta`. */
const PANEL_META_FIELDS = new Set(['v', 'count', 'state', 'jobId', 'percent', 'detail']);
/** Names that mean key material or a sealed answer reached tool output. */
const FORBIDDEN_KEYS = new Set(['publicKey', 'macPublicKey', 'ciphertext', 'iv', 'privateKey', 'answerPlaintext']);
const SHINGLE_WORDS = 6;

// ---------------------------------------------------------------------------
// Arguments

export interface SmokeQuestion {
  question: string;
  detail: 'summary' | 'full';
}

export interface SmokeOptions {
  questions: SmokeQuestion[];
  quiet: boolean;
  expectPrivate: boolean;
  dashboard: boolean;
  relay: string;
  engine: string;
  origin: string;
  stateFile: string;
}

export function parseSmokeArgs(argv: readonly string[], home = homedir()): SmokeOptions {
  const options: SmokeOptions = {
    questions: [],
    quiet: false,
    expectPrivate: false,
    dashboard: true,
    relay: 'https://mcp.olympusplugin.ai',
    engine: 'http://127.0.0.1:8010',
    origin: desktopSandboxOrigin(),
    stateFile: join(home, '.olympus', 'live-smoke-client.json'),
  };
  let question: string | undefined;
  let detail: 'summary' | 'full' = 'summary';
  let followUp: string | undefined;
  let followUpDetail: 'summary' | 'full' = 'summary';
  const value = (index: number, flag: string): string => {
    const next = argv[index + 1];
    if (next === undefined || next.startsWith('--')) throw new Error(`${flag} needs a value`);
    return next;
  };
  const detailValue = (raw: string, flag: string): 'summary' | 'full' => {
    if (raw !== 'summary' && raw !== 'full') throw new Error(`${flag} is summary or full`);
    return raw;
  };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i]!;
    switch (flag) {
      case '--question': question = value(i, flag); i += 1; break;
      case '--detail': detail = detailValue(value(i, flag), flag); i += 1; break;
      case '--follow-up': followUp = value(i, flag); i += 1; break;
      case '--follow-up-detail': followUpDetail = detailValue(value(i, flag), flag); i += 1; break;
      case '--quiet': options.quiet = true; break;
      case '--expect-private': options.expectPrivate = true; break;
      case '--no-dashboard': options.dashboard = false; break;
      case '--relay': options.relay = value(i, flag).replace(/\/+$/, ''); i += 1; break;
      case '--engine': options.engine = value(i, flag).replace(/\/+$/, ''); i += 1; break;
      case '--origin': options.origin = value(i, flag); i += 1; break;
      case '--state': options.stateFile = value(i, flag); i += 1; break;
      default: throw new Error(`unknown argument ${flag}`);
    }
  }
  if (question) options.questions.push({ question, detail });
  if (followUp) {
    if (!question) throw new Error('--follow-up needs --question');
    options.questions.push({ question: followUp, detail: followUpDetail });
  }
  if (!/^http:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/.test(options.engine)) {
    throw new Error('--engine must be a loopback http address (approval is loopback-only)');
  }
  return options;
}

/** The ChatGPT desktop app's widget origin shape (connect-relay/shared/private-answer.ts). */
export function desktopSandboxOrigin(): string {
  return `codex-sandbox://mcp-app-${randomBytes(8).toString('hex')}.web-sandbox.oaiusercontent.com`;
}

// ---------------------------------------------------------------------------
// The ChatGPT-eye view of a tool result, and the leak checks

export interface ToolResultLike {
  content?: Array<{ type?: string; text?: string }>;
  structuredContent?: Record<string, unknown>;
  _meta?: Record<string, unknown>;
  isError?: boolean;
}

export interface PanelMeta {
  v?: unknown;
  count?: number;
  state?: string;
  jobId?: string;
  detail?: string;
  percent?: number;
}

export function resultText(result: ToolResultLike): string {
  return (result.content ?? []).filter((part) => part?.type === 'text').map((part) => part.text ?? '').join('\n');
}

export function panelMeta(result: ToolResultLike): PanelMeta | undefined {
  const raw = result._meta?.[PRIVATE_ANSWER_META_KEY];
  return raw && typeof raw === 'object' ? raw as PanelMeta : undefined;
}

/** Which fixed Private note the model-visible text carries, if any. */
export function privateNoteKind(text: string): 'panel' | 'panel_full' | 'panel_setup' | 'no_panel' | undefined {
  if (text.includes(PRIVATE_MATCH_PANEL_FULL_NOTE)) return 'panel_full';
  if (text.includes(PRIVATE_MATCH_PANEL_NOTE)) return 'panel';
  if (text.includes(PRIVATE_MATCH_PANEL_SETUP_NOTE)) return 'panel_setup';
  if (text.includes(PRIVATE_MATCH_NOTE)) return 'no_panel';
  return undefined;
}

/** A job id as safe to print: the install part only. */
export function redactJobId(jobId: string | undefined): string | undefined {
  if (!jobId) return undefined;
  const [kind, install] = jobId.split('.');
  return `${kind}.${install}.<redacted>`;
}

function words(value: string): string[] {
  return value.toLowerCase().normalize('NFKC').match(/[\p{L}\p{N}]+(?:[.,][\p{N}]+)*/gu) ?? [];
}

function shingles(value: string, size: number): Set<string> {
  const list = words(value);
  const out = new Set<string>();
  if (list.length > 0 && list.length < size) {
    if (list.length >= 3) out.add(list.join(' '));
    return out;
  }
  for (let i = 0; i + size <= list.length; i += 1) out.add(list.slice(i, i + size).join(' '));
  return out;
}

function walkKeys(value: unknown, visit: (key: string, path: string) => void, path = ''): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) => walkKeys(item, visit, `${path}[${index}]`));
  } else if (value && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      visit(key, `${path}.${key}`);
      walkKeys(child, visit, `${path}.${key}`);
    }
  }
}

export interface PrivateAnswerSeen {
  answer: string;
  /** Open tokens and anything else from inside the sealed plaintext that must never surface. */
  secrets?: string[];
}

export interface LeakReport {
  violations: string[];
  warnings: string[];
}

/**
 * Checks one tool result as ChatGPT receives it:
 * - the panel `_meta` carries only its allowlisted fields;
 * - the job id never reaches the model-visible text or structuredContent;
 * - no key material or sealed answer appears anywhere in the result;
 * - no run of SHINGLE_WORDS consecutive words of any decrypted private answer
 *   (that is not also in the question) appears anywhere in the result, and no
 *   token from inside a sealed answer does.
 * Decimal values shared with a private answer are warnings only (they can be
 * coincidental).
 */
export function findPrivateLeaks(
  result: ToolResultLike,
  privateAnswers: readonly PrivateAnswerSeen[] = [],
  question = '',
): LeakReport {
  const violations: string[] = [];
  const warnings: string[] = [];
  const text = resultText(result);
  const structured = JSON.stringify(result.structuredContent ?? {});
  const whole = JSON.stringify(result);
  const meta = panelMeta(result);
  if (meta) {
    for (const key of Object.keys(meta)) if (!PANEL_META_FIELDS.has(key)) violations.push(`panel _meta carries an unexpected field "${key}"`);
    if (meta.jobId && (text.includes(meta.jobId) || structured.includes(meta.jobId))) {
      violations.push('the private answer job id appears in model-visible output');
    }
  }
  walkKeys(result, (key, path) => {
    if (FORBIDDEN_KEYS.has(key)) violations.push(`key material field "${key}" at ${path}`);
  });
  const questionShingles = shingles(question, SHINGLE_WORDS);
  const visibleShingles = shingles(`${text}\n${structured}\n${JSON.stringify(result._meta ?? {})}`, SHINGLE_WORDS);
  const visibleWords = new Set(words(whole));
  for (const [index, seen] of privateAnswers.entries()) {
    const label = `private answer #${index + 1}`;
    const overlap = [...shingles(seen.answer, SHINGLE_WORDS)].filter((s) => !questionShingles.has(s) && visibleShingles.has(s));
    if (overlap.length > 0) violations.push(`${overlap.length} phrase(s) of ${label} appear in tool output`);
    for (const secret of seen.secrets ?? []) {
      if (secret && whole.includes(secret)) violations.push(`a value from inside ${label}'s sealed plaintext appears in tool output`);
    }
    const decimals = words(seen.answer).filter((w) => /^\p{N}+[.,]\p{N}+$/u.test(w) && visibleWords.has(w));
    if (decimals.length > 0) warnings.push(`${decimals.length} decimal value(s) of ${label} also appear in tool output`);
  }
  return { violations, warnings };
}

// ---------------------------------------------------------------------------
// The panel: claim, poll, decrypt

export interface PanelCitation {
  title?: string;
  source?: string;
  date?: string;
  open?: { kind?: string; token?: string; url?: string };
}

export interface PanelAnswer {
  answer: string;
  citations: PanelCitation[];
  unanswered: string[];
}

export type PanelOutcome =
  | { ok: true; answer: PanelAnswer; polls: number; claimMs: number }
  | { ok: false; status: string; detail: string; polls: number; claimMs: number };

export interface PanelOptions {
  relay: string;
  jobId: string;
  origin: string;
  full: boolean;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  /** Ms per Retry-After second (tests shrink it). */
  secondMs?: number;
}

/** What the panel decrypts, read the way the panel reads it; undefined when malformed. */
export function readPanelPlaintext(plaintext: string): PanelAnswer | undefined {
  let value: unknown;
  try {
    value = JSON.parse(plaintext);
  } catch {
    return undefined;
  }
  const record = value as Record<string, unknown> | null;
  if (!record || typeof record !== 'object' || record.v !== 1 || typeof record.answer !== 'string') return undefined;
  const citations = (Array.isArray(record.citations) ? record.citations : [])
    .filter((c): c is PanelCitation => !!c && typeof c === 'object');
  const unanswered = (Array.isArray(record.unanswered) ? record.unanswered : [])
    .filter((u): u is string => typeof u === 'string' && u.trim().length > 0);
  return { answer: record.answer, citations, unanswered };
}

/**
 * Acts as the panel (src/workers/dashboard/chatgpt/private-answer.ts collect):
 * one ECDH P-256 key per job, a CORS preflight like the browser's, then POST
 * `{v:1, publicKey}` with the same key until `ready`/`failed`, honoring
 * Retry-After (default 2 s, at most 30 s) and the panel's poll cap
 * (PANEL_POLL_CAP_MS, or PANEL_FULL_POLL_CAP_MS for a full-detail job).
 */
export async function collectPrivateAnswer(options: PanelOptions): Promise<PanelOutcome> {
  const doFetch = options.fetch ?? fetch;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const now = options.now ?? Date.now;
  const secondMs = options.secondMs ?? 1000;
  const cap = options.full ? PANEL_FULL_POLL_CAP_MS : PANEL_POLL_CAP_MS;
  const url = `${options.relay}/private/${options.jobId}`;
  const started = now();
  let polls = 0;
  const failed = (status: string, detail: string): PanelOutcome => ({ ok: false, status, detail, polls, claimMs: now() - started });

  const preflight = await doFetch(url, {
    method: 'OPTIONS',
    headers: { Origin: options.origin, 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'content-type' },
  }).catch(() => undefined);
  if (!preflight) return failed('unreachable', 'preflight did not reach the relay');
  if (preflight.headers.get('access-control-allow-origin') !== options.origin) {
    return failed('cors', `preflight ${preflight.status} did not allow the panel origin`);
  }

  const keys = await generatePanelKeyPair();
  for (;;) {
    polls += 1;
    let response: Response;
    try {
      response = await doFetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', Origin: options.origin },
        body: JSON.stringify({ v: 1, publicKey: keys.publicKey }),
      });
    } catch {
      return failed('unreachable', 'the relay did not answer');
    }
    // A browser drops a response its CORS headers do not allow.
    if (response.headers.get('access-control-allow-origin') !== options.origin) {
      return failed('cors', `response ${response.status} did not allow the panel origin`);
    }
    let body: Record<string, unknown> | null = null;
    try {
      body = await response.json() as Record<string, unknown>;
    } catch {
      body = null;
    }
    const status = body && typeof body.status === 'string' ? body.status : '';
    const code = response.status;
    if (code === 200 && status === 'ready') {
      try {
        const plaintext = await openPrivateAnswer(options.jobId, keys.privateKey, {
          macPublicKey: String(body!.macPublicKey),
          iv: String(body!.iv),
          ciphertext: String(body!.ciphertext),
        });
        const answer = readPanelPlaintext(plaintext);
        if (!answer) return failed('malformed', 'the decrypted answer is not a v1 private answer');
        return { ok: true, answer, polls, claimMs: now() - started };
      } catch {
        return failed('decrypt', 'the sealed answer did not open with the panel key');
      }
    }
    if (code === 200 && status === 'failed') return failed('failed', 'the private model could not answer');
    if (code === 409) return failed('claimed', 'already opened elsewhere');
    if (code === 410 || code === 404) return failed('gone', 'expired or unknown job');
    if (code === 429) return failed('rate_limited', 'rate limited');
    const keepWaiting = code === 202 || (code === 503 && status === 'busy');
    if (code === 503 && !keepWaiting) return failed(status || 'mac_offline', 'the Mac is offline');
    if (!keepWaiting) return failed(status || `http_${code}`, `unexpected ${code}`);
    const header = Number(response.headers.get('retry-after'));
    const seconds = Number.isFinite(header) && header > 0 ? Math.min(30, header) : 2;
    if (now() - started + seconds * secondMs > cap) return failed('slow', `still pending after the panel's ${cap / 1000} s cap`);
    await sleep(seconds * secondMs);
  }
}

// ---------------------------------------------------------------------------
// Token: the local operator's loopback approval of a local development client

interface SmokeClientState {
  clientId: string;
  redirectUri: string;
}

export interface SmokeGrant {
  accessToken: string;
  revoke(): Promise<void>;
}

function form(values: Record<string, string>): { body: string; headers: Record<string, string> } {
  return { body: new URLSearchParams(values).toString(), headers: { 'content-type': 'application/x-www-form-urlencoded' } };
}

function readState(path: string): SmokeClientState | undefined {
  if (!existsSync(path)) return undefined;
  try {
    const value = JSON.parse(readFileSync(path, 'utf8')) as Partial<SmokeClientState>;
    return typeof value.clientId === 'string' && typeof value.redirectUri === 'string'
      ? { clientId: value.clientId, redirectUri: value.redirectUri }
      : undefined;
  } catch {
    return undefined;
  }
}

async function registerSmokeClient(engine: string, stateFile: string): Promise<SmokeClientState> {
  const response = await fetch(`${engine}/connect/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ client_name: SMOKE_CLIENT_NAME, redirect_uris: [SMOKE_REDIRECT_URI], grant_types: ['authorization_code', 'refresh_token'] }),
  });
  const body = await response.json().catch(() => ({})) as Record<string, unknown>;
  if (response.status !== 201 || typeof body.client_id !== 'string') {
    throw new Error(`registering the smoke client failed: ${response.status} ${String(body.error ?? '')}`);
  }
  const state = { clientId: body.client_id, redirectUri: SMOKE_REDIRECT_URI };
  mkdirSync(dirname(stateFile), { recursive: true });
  writeFileSync(stateFile, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  chmodSync(stateFile, 0o600);
  return state;
}

/**
 * Mints a grant for the smoke client: loopback consent at the engine (the
 * relay-mode approval path), PKCE code exchange at the public token endpoint.
 * The caller revokes it when done; the access token also expires in an hour.
 */
export async function obtainSmokeGrant(options: Pick<SmokeOptions, 'engine' | 'relay' | 'stateFile'>): Promise<SmokeGrant> {
  const metadata = await (await fetch(`${options.relay}/.well-known/oauth-protected-resource/mcp`)).json() as { resource?: string };
  const asMeta = await (await fetch(`${options.relay}/.well-known/oauth-authorization-server`)).json() as Record<string, string>;
  const resource = metadata.resource;
  if (!resource || !asMeta.token_endpoint || !asMeta.issuer) throw new Error('the relay did not serve OAuth metadata');

  const pkce = { verifier: '', state: randomBytes(16).toString('base64url') };
  const authorize = async (state: SmokeClientState): Promise<Response> => {
    const verifierLocal = randomBytes(48).toString('base64url');
    pkce.verifier = verifierLocal;
    const query = new URLSearchParams({
      response_type: 'code',
      client_id: state.clientId,
      redirect_uri: state.redirectUri,
      code_challenge: createHash('sha256').update(verifierLocal).digest('base64url'),
      code_challenge_method: 'S256',
      state: pkce.state,
      resource,
    });
    return fetch(`${options.engine}/connect/authorize?${query}`, { redirect: 'manual' });
  };

  let client = readState(options.stateFile) ?? await registerSmokeClient(options.engine, options.stateFile);
  let page = await authorize(client);
  if (page.status === 400) {
    // The engine forgot the client (a fresh connection store): register again once.
    client = await registerSmokeClient(options.engine, options.stateFile);
    page = await authorize(client);
  }
  if (page.status !== 200) throw new Error(`the loopback approval page answered ${page.status}`);
  const html = await page.text();
  const requestId = /name="request_id" value="([a-f0-9]{32})"/.exec(html)?.[1];
  const csrf = /name="csrf" value="([A-Za-z0-9_-]+)"/.exec(html)?.[1];
  const cookie = (page.headers.getSetCookie?.() ?? [page.headers.get('set-cookie') ?? ''])
    .map((line) => line.split(';')[0]!.trim())
    .find((pair) => requestId !== undefined && pair.startsWith(`olympus_consent_${requestId}=`));
  if (!requestId || !csrf || !cookie) throw new Error('the loopback approval page was not the expected form');

  const approve = form({ request_id: requestId, csrf, action: 'approve' });
  const approved = await fetch(`${options.engine}/connect/authorize`, {
    method: 'POST',
    redirect: 'manual',
    headers: { ...approve.headers, cookie, origin: options.engine },
    body: approve.body,
  });
  const location = approved.headers.get('location');
  if (approved.status !== 303 || !location) throw new Error(`loopback approval answered ${approved.status}`);
  const back = new URL(location);
  const code = back.searchParams.get('code');
  if (back.searchParams.get('state') !== pkce.state || back.searchParams.get('iss') !== asMeta.issuer || !code) {
    throw new Error(`loopback approval did not return a code (${back.searchParams.get('error') ?? 'no code'})`);
  }

  const exchange = form({
    grant_type: 'authorization_code',
    code,
    code_verifier: pkce.verifier,
    redirect_uri: client.redirectUri,
    client_id: client.clientId,
    resource,
  });
  const tokenResponse = await fetch(asMeta.token_endpoint, { method: 'POST', headers: exchange.headers, body: exchange.body });
  const tokens = await tokenResponse.json().catch(() => ({})) as Record<string, unknown>;
  if (tokenResponse.status !== 200 || typeof tokens.access_token !== 'string' || typeof tokens.refresh_token !== 'string') {
    throw new Error(`the token exchange answered ${tokenResponse.status} ${String(tokens.error ?? '')}`);
  }
  const refreshToken = tokens.refresh_token;
  const revocation = asMeta.revocation_endpoint ?? `${options.relay}/connect/revoke`;
  return {
    accessToken: tokens.access_token,
    async revoke() {
      // Revoking the refresh token revokes the whole grant (and its access token).
      const body = form({ token: refreshToken });
      await fetch(revocation, { method: 'POST', headers: body.headers, body: body.body }).catch(() => undefined);
    },
  };
}

// ---------------------------------------------------------------------------
// The run

interface QuestionRun {
  question: SmokeQuestion;
  result: ToolResultLike;
  privateAnswer?: PanelAnswer;
}

function print(line = ''): void {
  console.log(line);
}

function printView(label: string, result: ToolResultLike, quiet: boolean, ms: number): void {
  const text = resultText(result);
  print(`\n=== ${label} (${(ms / 1000).toFixed(1)} s)${result.isError ? ' [isError]' : ''}`);
  if (quiet) {
    print(`-- model-visible text: ${text.length} chars (hidden: --quiet)`);
  } else {
    print('-- model-visible text --');
    print(text);
    print('-- end text --');
  }
  const note = privateNoteKind(text);
  if (note) print(`-- private note in text: ${note}`);
  print(`-- structuredContent keys: ${Object.keys(result.structuredContent ?? {}).join(', ') || '(none)'}`);
  print(`-- _meta keys: ${Object.keys(result._meta ?? {}).join(', ') || '(none)'}`);
  const meta = panelMeta(result);
  if (meta) print(`-- panel _meta: ${JSON.stringify({ ...meta, ...(meta.jobId ? { jobId: redactJobId(meta.jobId) } : {}) })}`);
}

function printPanel(answer: PanelAnswer, quiet: boolean): void {
  const titles = answer.citations.map((c) => c.title?.trim() || c.source?.trim() || '(untitled)');
  if (quiet) {
    print(`-- private answer: ${answer.answer.length} chars, ${answer.unanswered.length} gap line(s)`);
  } else {
    print('-- private answer (panel only) --');
    print(answer.answer);
    for (const gap of answer.unanswered) print(`   gap: ${gap}`);
  }
  print(`-- cited: ${titles.length ? '' : '(none)'}`);
  answer.citations.forEach((c, i) => {
    print(`   ${i + 1}. ${titles[i]}${c.date ? ` (${c.date})` : ''}${c.open?.kind ? ` [opens: ${c.open.kind}]` : ''}`);
  });
}

async function callTool(client: Client, name: string, args: Record<string, unknown>): Promise<ToolResultLike> {
  return await client.callTool({ name, arguments: args }, undefined, { timeout: TOOL_TIMEOUT_MS }) as ToolResultLike;
}

export async function runSmoke(options: SmokeOptions): Promise<number> {
  const failures: string[] = [];
  const warnings: string[] = [];
  let grant: SmokeGrant;
  try {
    grant = await obtainSmokeGrant(options);
  } catch (error) {
    print(`cannot start: ${(error as Error).message}`);
    return 2;
  }
  const client = new Client({ name: 'olympus-live-smoke', version: '1.0.0' });
  const transport = new StreamableHTTPClientTransport(new URL(`${options.relay}/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${grant.accessToken}` } },
  });
  const runs: QuestionRun[] = [];
  const others: Array<{ label: string; result: ToolResultLike }> = [];
  try {
    await client.connect(transport as unknown as Parameters<Client['connect']>[0]);
    print(`relay ${options.relay} · panel origin ${options.origin.replace(/mcp-app-[0-9a-f]+/, 'mcp-app-…')}`);
    const tools = await client.listTools();
    print(`\n=== tools/list: ${tools.tools.length} tools`);
    for (const tool of tools.tools) {
      const ui = (tool._meta as Record<string, unknown> | undefined)?.ui as { resourceUri?: string } | undefined;
      print(`   ${tool.name}${ui?.resourceUri ? `  ui=${ui.resourceUri}` : ''}`);
    }

    if (options.dashboard) {
      const started = Date.now();
      const result = await callTool(client, 'olympus_dashboard', {});
      printView('olympus_dashboard {}', result, options.quiet, Date.now() - started);
      others.push({ label: 'olympus_dashboard', result });
    }

    for (const question of options.questions) {
      const args: Record<string, unknown> = { question: question.question, ...(question.detail === 'full' ? { detail: 'full' } : {}) };
      const started = Date.now();
      const result = await callTool(client, 'olympus_search', args);
      const searchMs = Date.now() - started;
      printView(`olympus_search ${JSON.stringify(args)}`, result, options.quiet, searchMs);
      const run: QuestionRun = { question, result };
      runs.push(run);
      const meta = panelMeta(result);
      if (result.isError) failures.push(`olympus_search errored for "${question.question}"`);
      if (meta?.state === 'ready' && meta.jobId) {
        const full = meta.detail === 'full';
        const outcome = await collectPrivateAnswer({ relay: options.relay, jobId: meta.jobId, origin: options.origin, full });
        const totalMs = Date.now() - started;
        const budget = full ? FULL_BUDGET_MS : SUMMARY_BUDGET_MS;
        print(`-- panel: ${outcome.ok ? 'ready' : `${outcome.status} (${outcome.detail})`} · search ${(searchMs / 1000).toFixed(1)} s · claim→settled ${(outcome.claimMs / 1000).toFixed(1)} s · search→ready ${(totalMs / 1000).toFixed(1)} s · polls ${outcome.polls} · budget ${budget / 1000} s`);
        if (!outcome.ok) {
          failures.push(`panel ${outcome.status} for "${question.question}"`);
        } else {
          run.privateAnswer = outcome.answer;
          printPanel(outcome.answer, options.quiet);
          if (totalMs > budget) failures.push(`private answer took ${(totalMs / 1000).toFixed(1)} s > ${budget / 1000} s for "${question.question}"`);
        }
      } else if (options.expectPrivate) {
        failures.push(`no ready private answer job for "${question.question}" (panel state ${meta?.state ?? 'absent'})`);
      }
    }
  } catch (error) {
    print(`run failed: ${(error as Error).message}`);
    failures.push(`run failed: ${(error as Error).message}`);
  } finally {
    await client.close().catch(() => undefined);
    await grant.revoke();
  }

  // Every tool result checked against every private answer this run decrypted.
  const seen: PrivateAnswerSeen[] = runs.filter((r) => r.privateAnswer).map((r) => ({
    answer: r.privateAnswer!.answer,
    secrets: r.privateAnswer!.citations.map((c) => c.open?.token ?? '').filter(Boolean),
  }));
  const checked = [
    ...runs.map((r) => ({ label: `olympus_search "${r.question.question}"`, result: r.result, question: r.question.question })),
    ...others.map((o) => ({ ...o, question: '' })),
  ];
  for (const item of checked) {
    const report = findPrivateLeaks(item.result, seen, item.question);
    for (const v of report.violations) failures.push(`${item.label}: ${v}`);
    for (const w of report.warnings) warnings.push(`${item.label}: ${w}`);
  }
  print('\n=== checks');
  print(`   private-content checks: ${checked.length} result(s) against ${seen.length} private answer(s)`);
  for (const w of warnings) print(`   warn: ${w}`);
  for (const f of failures) print(`   FAIL: ${f}`);
  print(failures.length === 0 ? '   PASS' : `   ${failures.length} failure(s)`);
  return failures.length === 0 ? 0 : 1;
}

if (import.meta.main) {
  let options: SmokeOptions;
  try {
    options = parseSmokeArgs(process.argv.slice(2));
  } catch (error) {
    console.error(`${(error as Error).message}\nusage: bun scripts/chatgpt-live-smoke.ts [--question Q [--detail full] [--follow-up Q2 [--follow-up-detail full]]] [--quiet] [--expect-private] [--no-dashboard] [--relay URL] [--engine URL] [--origin ORIGIN] [--state FILE]`);
    process.exit(2);
  }
  process.exit(await runSmoke(options));
}
