/**
 * The release check's in-machine half. The harness bundles this file, a driver
 * puts the bundle on a throwaway machine, and the harness then runs one
 * subcommand at a time through the driver's `exec`. Each subcommand does one
 * job against the installed product and prints a single JSON object as its
 * last stdout line (diagnostics go to stderr), so the harness needs nothing
 * from the machine but a shell and the Bun runtime the engine already ships.
 *
 * Everything here goes through surfaces a normal install has: the engine's
 * Unix-socket worker, the dashboard's control routes (what the dashboard page
 * itself calls), `olympus` CLI commands, and the engine's MCP endpoint. The
 * only test-specific input is the Readwise stand-in, reached through the
 * connector's own base-URL settings (readwise-fake.ts).
 *
 * Linux and macOS. The differences are confined to `platform()` (paths, how the
 * engine's worker is reached), `findBrowser()` and `collectLogs()`: on Linux the
 * worker listens on an owner-only Unix socket that a bridge forwards to the port
 * a browser expects; on macOS the engine itself listens on that loopback port.
 */
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { desktopSandboxOrigin, runSmoke, type SmokeObservation, privateNoteKind, panelMeta, resultText } from '../chatgpt-live-smoke.ts';
import { privateNoteKindIn } from './private-note.ts';
import { FAKE_READWISE_PORT, FAKE_READWISE_TOKEN, startFakeReadwise } from './readwise-fake.ts';

// ---------------------------------------------------------------------------
// Configuration the harness puts on the machine

export interface AgentConfig {
  /** Readwise documents the stand-in serves. */
  documents: unknown[];
  /** Owner tier rules to pin before the first sync. */
  tierRules: Array<{ id: string; label: string; tier: 'personal' | 'private' | 'secrets' }>;
  fakePort: number;
  fakeToken: string;
  /** How many documents the stand-in serves, and how many of them the engine may refuse as Secrets. */
  expectedItems: number;
  expectedSecrets: number;
  relay: string;
  /** Per-question private facts, checked inside the machine so Private plaintext never leaves it. */
  privateFacts: Record<string, string[]>;
  /** Port the owner-socket bridge listens on; the engine's logical origin port. */
  enginePort: number;
}

const WORKDIR = join(homedir(), 'rc');
const CONFIG_PATH = join(WORKDIR, 'config.json');
const TOKEN_PATH = join(WORKDIR, 'mcp-token');

function readConfig(): AgentConfig {
  return JSON.parse(readFileSync(CONFIG_PATH, 'utf8')) as AgentConfig;
}

function say(line: string): void {
  console.error(`[agent] ${line}`);
}

function emit(result: Record<string, unknown>): never {
  console.log(JSON.stringify(result));
  process.exit(result.ok === false ? 1 : 0);
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

// ---------------------------------------------------------------------------
// Platform seam (the one place Linux and macOS differ)

interface Platform {
  os: 'linux' | 'macos';
  olympusBin: string;
  workerEnvPath: string;
  engineLogPaths: string[];
  /** Fetch against the engine's worker origin as the owner. */
  workerFetch(path: string, init?: RequestInit): Promise<Response>;
  /** Linux only: the owner socket the worker listens on. macOS has none; the engine listens on the loopback port itself. */
  socketPath?: string;
}

const WORKER_ORIGIN = 'http://127.0.0.1:8010';

function platform(): Platform {
  const home = homedir();
  if (process.platform === 'darwin') {
    const logs = join(home, 'Library', 'Logs', 'Olympus');
    return {
      os: 'macos',
      olympusBin: join(home, '.local', 'bin', 'olympus'),
      workerEnvPath: join(home, '.config', 'olympus', 'worker.env'),
      engineLogPaths: [join(logs, 'engine.log'), join(logs, 'engine.err'), join(logs, 'install.log')],
      workerFetch: (path, init = {}) => fetch(`${WORKER_ORIGIN}${path}`, init),
    };
  }
  if (process.platform !== 'linux') throw new Error(`the in-machine agent supports Linux and macOS (got ${process.platform})`);
  const runtime = process.env.XDG_RUNTIME_DIR ?? `/run/user/${process.getuid?.() ?? 1000}`;
  const socketPath = join(runtime, 'olympus', 'worker.sock');
  return {
    os: 'linux',
    olympusBin: join(home, '.local', 'bin', 'olympus'),
    workerEnvPath: join(home, '.config', 'olympus', 'worker.env'),
    engineLogPaths: [
      join(home, '.local', 'state', 'olympus', 'engine', 'engine.log'),
      join(home, '.local', 'state', 'olympus', 'engine', 'engine.err'),
    ],
    socketPath,
    workerFetch: (path, init = {}) => fetch(`${WORKER_ORIGIN}${path}`, { ...init, unix: socketPath } as RequestInit),
  };
}

// ---------------------------------------------------------------------------
// Running the olympus CLI

interface CliResult { code: number; stdout: string; stderr: string }

function olympus(args: string[], options: { input?: string; env?: Record<string, string>; timeoutMs?: number } = {}): CliResult {
  const result = spawnSync(platform().olympusBin, args, {
    input: options.input,
    encoding: 'utf8',
    timeout: options.timeoutMs ?? 120_000,
    env: { ...process.env, ...options.env },
  });
  return { code: result.status ?? 1, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

function workerBearer(): string {
  const result = olympus(['dashboard', 'token']);
  if (result.code !== 0 || !result.stdout.trim()) throw new Error('olympus dashboard token failed');
  return result.stdout.trim();
}

/** A dashboard control session: what the dashboard page itself holds after sign-in. */
async function ownerSession(): Promise<{ call(method: string, path: string, body?: unknown): Promise<{ status: number; json: any; text: string }> }> {
  const p = platform();
  const bearer = workerBearer();
  const origin = WORKER_ORIGIN;
  const mint = await p.workerFetch('/dashboard/control/session', {
    method: 'POST',
    headers: { authorization: `Bearer ${bearer}`, origin, 'content-type': 'application/json' },
    body: '{}',
  });
  if (mint.status !== 200) throw new Error(`dashboard control session answered ${mint.status}`);
  const cookie = (mint.headers.getSetCookie?.() ?? []).map((line) => line.split(';')[0]).join('; ');
  const minted = await mint.json() as { csrf_token?: string };
  return {
    async call(method, path, body) {
      const response = await p.workerFetch(path, {
        method,
        headers: {
          authorization: `Bearer ${bearer}`,
          cookie,
          origin,
          'x-olympus-csrf': minted.csrf_token ?? '',
          ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
      const text = await response.text();
      let json: any;
      try { json = JSON.parse(text); } catch { json = undefined; }
      return { status: response.status, json, text };
    },
  };
}

async function dashboardJson(): Promise<{ status: number; json: any; text: string }> {
  const session = await ownerSession();
  return await session.call('GET', '/dashboard.json');
}

// ---------------------------------------------------------------------------
// prepare-source: the stand-in, the owner's tier rules, a restart

function upsertEnv(path: string, values: Record<string, string>): void {
  const existing = existsSync(path) ? readFileSync(path, 'utf8').split('\n') : [];
  const keys = new Set(Object.keys(values));
  const kept = existing.filter((line) => !keys.has(line.split('=')[0] ?? ''));
  while (kept.length > 0 && kept[kept.length - 1] === '') kept.pop();
  const next = [...kept, ...Object.entries(values).map(([k, v]) => `${k}=${v}`)];
  writeFileSync(path, `${next.join('\n')}\n`, { mode: 0o600 });
}

async function fakeIsUp(config: AgentConfig): Promise<boolean> {
  try {
    const response = await fetch(`http://127.0.0.1:${config.fakePort}/api/v2/auth/`, { headers: { authorization: `Token ${config.fakeToken}` } });
    return response.status === 204;
  } catch {
    return false;
  }
}

async function startFakeDetached(config: AgentConfig): Promise<void> {
  if (await fakeIsUp(config)) return;
  mkdirSync(WORKDIR, { recursive: true });
  const logFd = openSync(join(WORKDIR, 'fake-readwise.log'), 'a');
  const child = spawn(process.execPath, [process.argv[1]!, 'fake-readwise'], { detached: true, stdio: ['ignore', logFd, logFd] });
  child.unref();
  closeSync(logFd);
  for (let i = 0; i < 40; i += 1) {
    if (await fakeIsUp(config)) return;
    await sleep(250);
  }
  throw new Error('the Readwise stand-in did not start');
}

async function waitForEngine(timeoutMs: number): Promise<number> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const dash = await dashboardJson();
      if (dash.status === 200 && dash.json?.model_setup?.ready === true) return Date.now() - started;
    } catch { /* engine still starting */ }
    await sleep(3_000);
  }
  throw new Error(`the engine was not ready (models included) within ${Math.round(timeoutMs / 1000)} s`);
}

async function prepareSource(): Promise<never> {
  const config = readConfig();
  const p = platform();
  await startFakeDetached(config);
  say('stand-in running');
  upsertEnv(p.workerEnvPath, {
    OLYMPUS_SOURCE_INDEX_READWISE_API_V2_BASE_URL: `http://127.0.0.1:${config.fakePort}/api/v2/`,
    OLYMPUS_SOURCE_INDEX_READWISE_READER_API_V3_BASE_URL: `http://127.0.0.1:${config.fakePort}/api/v3/`,
    OLYMPUS_CONNECT_READWISE_AUTH_URL: `http://127.0.0.1:${config.fakePort}/api/v2/auth/`,
  });
  const rules = olympus(['tier', 'rules', 'list']);
  for (const rule of config.tierRules) {
    if (rules.stdout.includes(`"id": "${rule.id}"`)) olympus(['tier', 'rules', 'remove', rule.id]);
    const added = olympus(['tier', 'rules', 'add', '--id', rule.id, '--match', `label=${rule.label}`, '--tier', rule.tier, '--strength', 'force', '--source', 'readwise']);
    if (added.code !== 0) emit({ ok: false, step: 'tier-rules', detail: `could not add rule ${rule.id}` });
  }
  say('tier rules pinned');
  const restart = olympus(['engine', 'restart'], { timeoutMs: 180_000 });
  if (restart.code !== 0) emit({ ok: false, step: 'engine-restart', detail: restart.stderr.slice(0, 300) });
  const readyMs = await waitForEngine(300_000);
  emit({ ok: true, rules: config.tierRules.length, engineReadyMs: readyMs });
}

// ---------------------------------------------------------------------------
// connect, sync, settle

async function connectSource(): Promise<never> {
  const config = readConfig();
  const session = await ownerSession();
  const response = await session.call('POST', '/dashboard/connect/api-key', { source: 'readwise', api_key: config.fakeToken });
  if (response.status !== 200 || response.json?.ok !== true) {
    emit({ ok: false, status: response.status, detail: String(response.json?.error?.code ?? 'connect refused') });
  }
  emit({ ok: true, message: String(response.json?.status_message ?? '') });
}

async function syncNow(): Promise<never> {
  const session = await ownerSession();
  const response = await session.call('POST', '/dashboard/sync-now', { source: 'readwise' });
  emit({ ok: response.status === 200, status: response.status });
}

interface SettleSnapshot {
  seen: number;
  indexed: number;
  contentReady: number;
  embedded: number;
  secretsLocated: number;
  pending: number;
  queueWaiting: number;
  queueActive: number;
  personal: number;
  privateItems: number;
  lastRun: string;
  missingChunks: number;
}

function snapshot(json: any): SettleSnapshot | undefined {
  const source = (json?.sources ?? []).find((s: any) => s.provider === 'readwise');
  if (!source) return undefined;
  const tier = (label: string): number => (source.tier_composition ?? []).find((t: any) => t.label === label)?.content_ready_items ?? 0;
  return {
    seen: source.last_run?.items_seen ?? 0,
    indexed: source.coverage?.indexed_items ?? 0,
    contentReady: source.coverage?.content_ready_items ?? 0,
    embedded: source.coverage?.embedded_items ?? 0,
    secretsLocated: source.tier_classification?.secrets_located ?? 0,
    pending: source.tier_classification?.pending_classification_items ?? 0,
    queueWaiting: source.queue_health?.waiting ?? 0,
    queueActive: source.queue_health?.active ?? 0,
    personal: tier('Personal'),
    privateItems: tier('Private'),
    lastRun: String(source.last_run?.status ?? 'none'),
    missingChunks: source.embedding_backlog?.missing_chunks ?? 0,
  };
}

function isSettled(s: SettleSnapshot | undefined, config: AgentConfig): boolean {
  if (!s) return false;
  const stored = config.expectedItems - config.expectedSecrets;
  return s.lastRun === 'completed'
    && s.seen >= config.expectedItems
    && s.indexed >= stored
    && s.contentReady >= stored
    && s.embedded >= stored
    && s.pending === 0
    && s.queueWaiting === 0
    && s.queueActive === 0
    && s.missingChunks === 0;
}

async function settle(timeoutS: number): Promise<never> {
  const config = readConfig();
  const started = Date.now();
  let stable = 0;
  let last: SettleSnapshot | undefined;
  let polls = 0;
  while (Date.now() - started < timeoutS * 1000) {
    polls += 1;
    try {
      const dash = await dashboardJson();
      last = snapshot(dash.json);
    } catch { /* engine busy */ }
    stable = isSettled(last, config) ? stable + 1 : 0;
    if (stable >= 2) emit({ ok: true, settled: true, polls, waitedMs: Date.now() - started, snapshot: last });
    await sleep(5_000);
  }
  emit({ ok: false, settled: false, polls, waitedMs: Date.now() - started, snapshot: last ?? null });
}

// ---------------------------------------------------------------------------
// The engine's own MCP endpoint, as a connected agent reaches it

async function mcpToken(): Promise<never> {
  const created = olympus(['connections', 'add', 'release-check']);
  if (created.code !== 0) emit({ ok: false, detail: 'connections add failed' });
  const parsed = JSON.parse(created.stdout) as { token?: string; connection?: { id?: string } };
  if (!parsed.token) emit({ ok: false, detail: 'no token returned' });
  mkdirSync(WORKDIR, { recursive: true });
  writeFileSync(TOKEN_PATH, parsed.token!, { mode: 0o600 });
  chmodSync(TOKEN_PATH, 0o600);
  emit({ ok: true, connection: parsed.connection?.id ?? null });
}

async function mcpRpc(sessionHeaders: { sid?: string }, body: unknown): Promise<{ status: number; text: string }> {
  const token = readFileSync(TOKEN_PATH, 'utf8').trim();
  const response = await platform().workerFetch('/mcp', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      authorization: `Bearer ${token}`,
      ...(sessionHeaders.sid ? { 'mcp-session-id': sessionHeaders.sid } : {}),
    },
    body: JSON.stringify(body),
  });
  const issued = response.headers.get('mcp-session-id') ?? sessionHeaders.sid;
  if (issued !== undefined) sessionHeaders.sid = issued;
  return { status: response.status, text: await response.text() };
}

function parseRpc(text: string): any {
  const trimmed = text.trim();
  if (trimmed.startsWith('{')) return JSON.parse(trimmed);
  // Streamable HTTP may answer as one SSE data frame.
  const data = trimmed.split('\n').filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trim()).pop();
  return data ? JSON.parse(data) : {};
}

async function mcpSession(): Promise<{ sid?: string }> {
  const session: { sid?: string } = {};
  const init = await mcpRpc(session, { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'release-check', version: '1' } } });
  if (init.status !== 200) throw new Error(`mcp initialize answered ${init.status}`);
  await mcpRpc(session, { jsonrpc: '2.0', method: 'notifications/initialized' });
  return session;
}

/**
 * One raw MCP request relayed to the engine for an agent running elsewhere
 * (the harness's loopback proxy hands each JSON-RPC message here). The input
 * is a JSON object {sid?, body} on stdin; the answer is {status, sid, contentType, text}.
 */
async function mcpRpcRelay(inputFile: string): Promise<never> {
  const input = JSON.parse(readFileSync(inputFile, 'utf8')) as { sid?: string; body: unknown };
  const token = readFileSync(TOKEN_PATH, 'utf8').trim();
  const response = await platform().workerFetch('/mcp', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      authorization: `Bearer ${token}`,
      ...(input.sid ? { 'mcp-session-id': input.sid } : {}),
    },
    body: JSON.stringify(input.body),
  });
  emit({
    ok: true,
    status: response.status,
    sid: response.headers.get('mcp-session-id'),
    contentType: response.headers.get('content-type') ?? 'application/json',
    text: await response.text(),
  });
}

async function mcpTools(): Promise<never> {
  const session = await mcpSession();
  const listed = await mcpRpc(session, { jsonrpc: '2.0', id: 2, method: 'tools/list' });
  const tools = (parseRpc(listed.text).result?.tools ?? []) as Array<{ name: string; description?: string; inputSchema?: unknown; annotations?: unknown }>;
  emit({ ok: listed.status === 200, tools: tools.map((t) => ({ name: t.name, description: t.description ?? '', inputSchema: t.inputSchema ?? { type: 'object' }, annotations: t.annotations ?? {} })) });
}

async function mcpCall(tool: string, rawArgs: string): Promise<never> {
  const session = await mcpSession();
  const called = await mcpRpc(session, { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: tool, arguments: JSON.parse(rawArgs || '{}') } });
  const message = parseRpc(called.text);
  const result = message.result ?? {};
  const text = ((result.content ?? []) as Array<{ type: string; text?: string }>).filter((part) => part.type === 'text').map((part) => part.text ?? '').join('\n');
  const structured = result.structuredContent ?? null;
  const noteKind = privateNoteKindIn(text, structured);
  emit({ ok: called.status === 200 && !message.error, status: called.status, isError: result.isError === true || Boolean(message.error), text, structured, noteKind, error: message.error?.message ?? null });
}

// ---------------------------------------------------------------------------
// The owner-socket bridge: what an owner-authenticated socket forward does for a browser

function startBridge(port: number): () => void {
  const p = platform();
  // macOS: the engine already listens on the loopback port the browser and the smoke use, so there is nothing to forward.
  if (p.socketPath === undefined) return () => undefined;
  type Upstream = { write(data: Uint8Array): number; end(): void };
  const server = Bun.listen<{ upstream?: Upstream; queue: Uint8Array[]; closed: boolean }>({
    hostname: '127.0.0.1',
    port,
    socket: {
      async open(socket) {
        socket.data = { queue: [], closed: false };
        try {
          const upstream = await Bun.connect({
            unix: p.socketPath!,
            socket: {
              data(_up, data) { socket.write(data); },
              close() { socket.end(); },
              error() { socket.end(); },
            },
          });
          socket.data.upstream = upstream;
          for (const chunk of socket.data.queue) upstream.write(chunk);
          socket.data.queue = [];
          if (socket.data.closed) upstream.end();
        } catch { socket.end(); }
      },
      data(socket, data) {
        if (socket.data.upstream) socket.data.upstream.write(data); else socket.data.queue.push(new Uint8Array(data));
      },
      close(socket) { socket.data.closed = true; socket.data.upstream?.end(); },
      error(socket) { socket.data.closed = true; socket.data.upstream?.end(); },
    },
  });
  return () => server.stop(true);
}

// ---------------------------------------------------------------------------
// smoke: the ChatGPT-protocol pass, through the production relay

interface SmokeQuestionIn { id: string; text: string; kind?: string }

/** How long a Private question may wait for the on-computer answer model to start after a fresh install. */
const PRIVATE_WARMUP_S = 300;
const PRIVATE_WARMUP_POLL_S = 15;

async function smoke(questionsFile: string): Promise<never> {
  const config = readConfig();
  const questions = JSON.parse(readFileSync(questionsFile, 'utf8')) as SmokeQuestionIn[];
  const stopBridge = startBridge(config.enginePort);
  const observed: Array<{ id: string; obs: SmokeObservation }> = [];
  const printed: string[] = [];
  const realLog = console.log;
  console.log = (...parts: unknown[]) => { printed.push(parts.map(String).join(' ')); };
  let tools: string[] = [];
  /** The smoke's own verdict: 0 clean, anything else a failure. Failures from a Private question's earlier warm-up attempts are tolerated; its last attempt counts. */
  let exit: number | undefined;
  const startedAt = Date.now();
  /** What each Private question looked like on each attempt: panel state and which fixed note, never text. */
  const attempts: Record<string, Array<{ panelState: string | null; noteKind: string | null; atS: number }>> = {};
  const ask = async (batch: SmokeQuestionIn[]): Promise<number> => await runSmoke({
    questions: batch.map((q) => ({ question: q.text, detail: 'summary' as const })),
    quiet: true,
    expectPrivate: false,
    dashboard: false,
    relay: config.relay,
    engine: `http://127.0.0.1:${config.enginePort}`,
    origin: desktopSandboxOrigin(),
    stateFile: join(WORKDIR, 'smoke-client.json'),
  }, {
    onTools: (names) => { tools = [...names]; },
    onQuestion: (obs) => {
      const match = batch.find((q) => q.text === obs.question.question);
      if (!match) return;
      const at = observed.findIndex((row) => row.id === match.id);
      if (at !== -1) observed.splice(at, 1);
      observed.push({ id: match.id, obs });
      if (match.kind === 'private') {
        (attempts[match.id] ??= []).push({ panelState: panelMeta(obs.result)?.state ?? null, noteKind: privateNoteKind(resultText(obs.result)) ?? null, atS: Math.round((Date.now() - startedAt) / 1000) });
      }
    },
  });
  try {
    // A fresh install starts its on-computer answer model on first use, so a Private question is
    // asked until its answer panel exists (bounded), and the wait is reported rather than hidden.
    const priv = questions.filter((q) => q.kind === 'private');
    const rest = questions.filter((q) => q.kind !== 'private');
    for (const q of priv) {
      let code: number;
      for (;;) {
        code = await ask([q]);
        const latest = observed.find((row) => row.id === q.id)?.obs;
        if (latest?.panel !== undefined || (Date.now() - startedAt) / 1000 > PRIVATE_WARMUP_S) break;
        await sleep(PRIVATE_WARMUP_POLL_S * 1000);
      }
      exit = Math.max(exit ?? 0, code);
    }
    if (rest.length > 0) {
      const code = await ask(rest);
      exit = Math.max(exit ?? 0, code);
    }
  } finally {
    console.log = realLog;
    stopBridge();
  }
  const order = new Map(questions.map((q, index) => [q.id, index]));
  observed.sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));
  const results = observed.map(({ id, obs }) => {
    const text = resultText(obs.result);
    const answer = obs.privateAnswer?.answer ?? '';
    const facts = config.privateFacts[id] ?? [];
    return {
      id,
      text,
      isError: obs.result.isError === true,
      noteKind: privateNoteKind(text) ?? null,
      panelState: panelMeta(obs.result)?.state ?? null,
      evidence: ((obs.result.structuredContent as { evidence?: Array<{ title?: string; url?: string }> } | undefined)?.evidence ?? []).map((e) => ({ title: e.title ?? '', url: e.url ?? '' })),
      searchMs: obs.searchMs,
      panel: obs.panel ?? null,
      attempts: attempts[id] ?? [],
      // Private plaintext stays here: only whether each expected fact is stated, and the answer's size, leave the machine.
      privateAnswer: obs.privateAnswer ? { chars: answer.length, citations: obs.privateAnswer.citations.length, factsStated: facts.map((fact) => answer.includes(fact)) } : null,
    };
  });
  const lines = printed.filter((line) => /^\s+(FAIL|warn):/.test(line) || /^\s+(PASS|\d+ failure)/.test(line)).map((line) => line.trim());
  emit({ ok: true, exit: exit ?? 1, tools, results, smokeChecks: lines });
}

// ---------------------------------------------------------------------------
// Dashboard screenshots (390 and 1280 wide, light and dark) over the owner bridge

interface Cdp { send(method: string, params?: Record<string, unknown>): Promise<any>; close(): void }

async function cdpConnect(wsUrl: string): Promise<Cdp> {
  const ws = new WebSocket(wsUrl);
  await new Promise<void>((resolve, reject) => { ws.onopen = () => resolve(); ws.onerror = () => reject(new Error('cdp connect failed')); });
  let nextId = 1;
  const pending = new Map<number, { resolve(v: any): void; reject(e: Error): void }>();
  ws.onmessage = (event) => {
    const message = JSON.parse(String(event.data)) as { id?: number; result?: any; error?: { message: string } };
    if (message.id === undefined) return;
    const waiter = pending.get(message.id);
    if (!waiter) return;
    pending.delete(message.id);
    if (message.error) waiter.reject(new Error(message.error.message)); else waiter.resolve(message.result);
  };
  return {
    send: (method, params = {}) => new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params }));
    }),
    close: () => ws.close(),
  };
}

function findBrowser(): string | undefined {
  if (process.platform === 'darwin') {
    const chrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
    return existsSync(chrome) ? chrome : undefined;
  }
  for (const name of ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser']) {
    const found = spawnSync('sh', ['-c', `command -v ${name}`], { encoding: 'utf8' });
    if (found.status === 0 && found.stdout.trim()) return found.stdout.trim();
  }
  return undefined;
}

async function screenshots(outDir: string): Promise<void> {
  const config = readConfig();
  const browser = findBrowser();
  if (!browser) emit({ ok: false, detail: 'no headless browser on the machine' });
  mkdirSync(outDir, { recursive: true });
  const launched = olympus(['dashboard', '--no-open', '--target', 'dashboard'], { timeoutMs: 60_000 });
  const url = /https?:\/\/[^\s"]+/.exec(launched.stdout + launched.stderr)?.[0];
  if (!url) emit({ ok: false, detail: 'olympus dashboard --no-open printed no URL' });
  const port = Number(new URL(url!).port || 80);
  const stopBridge = startBridge(port);
  const profile = join(WORKDIR, 'chrome-profile');
  mkdirSync(profile, { recursive: true });
  const debugPort = 9333;
  const chrome = spawn(browser!, [
    '--headless=new', '--no-sandbox', '--disable-gpu', '--hide-scrollbars', '--no-first-run',
    // A throwaway profile must not ask the desktop session's keychain for a browser-storage key.
    ...(process.platform === 'darwin' ? ['--use-mock-keychain', '--password-store=basic'] : []),
    `--user-data-dir=${profile}`, `--remote-debugging-port=${debugPort}`, '--remote-allow-origins=*', 'about:blank',
  ], { stdio: 'ignore' });
  const shots: Array<{ file: string; width: number; theme: 'light' | 'dark'; bytes: number }> = [];
  let cdp: Cdp | undefined;
  let outcome: Record<string, unknown> = { ok: false, detail: 'screenshots did not finish' };
  try {
    let wsUrl: string | undefined;
    for (let i = 0; i < 60 && !wsUrl; i += 1) {
      try {
        const targets = await (await fetch(`http://127.0.0.1:${debugPort}/json`)).json() as Array<{ type: string; webSocketDebuggerUrl: string }>;
        wsUrl = targets.find((t) => t.type === 'page')?.webSocketDebuggerUrl;
      } catch { /* browser starting */ }
      if (!wsUrl) await sleep(500);
    }
    if (!wsUrl) throw new Error('the browser did not open a debugging page');
    cdp = await cdpConnect(wsUrl);
    await cdp.send('Page.enable');
    // The one-time ticket URL signs the browser in; later captures reuse its session.
    await cdp.send('Page.navigate', { url });
    await sleep(6_000);
    const landed = await cdp.send('Runtime.evaluate', { expression: 'JSON.stringify({ path: location.pathname, text: (document.body ? document.body.innerText : "").slice(0, 240) })', returnByValue: true });
    for (const theme of ['light', 'dark'] as const) {
      for (const width of [390, 1280]) {
        await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: theme }] });
        await cdp.send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: width < 600 });
        await sleep(1_500);
        const metrics = await cdp.send('Page.getLayoutMetrics');
        const height = Math.min(6000, Math.ceil(metrics.cssContentSize?.height ?? 900));
        await cdp.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: width < 600 });
        await sleep(800);
        const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
        const file = join(outDir, `dashboard-${width}-${theme}.png`);
        const bytes = Buffer.from(shot.data as string, 'base64');
        writeFileSync(file, bytes);
        shots.push({ file, width, theme, bytes: bytes.length });
      }
    }
    // Horizontal overflow at phone width is a layout failure the pixels alone do not name.
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 900, deviceScaleFactor: 1, mobile: true });
    const overflow = await cdp.send('Runtime.evaluate', { expression: 'document.documentElement.scrollWidth - document.documentElement.clientWidth', returnByValue: true });
    const title = await cdp.send('Runtime.evaluate', { expression: 'document.title', returnByValue: true });
    outcome = { ok: true, shots, overflowPx390: overflow.result?.value ?? null, pageTitle: String(title.result?.value ?? ''), landed: String(landed.result?.value ?? ''), enginePort: config.enginePort };
  } catch (error) {
    outcome = { ok: false, detail: error instanceof Error ? error.message : String(error) };
  } finally {
    cdp?.close();
    chrome.kill('SIGKILL');
    stopBridge();
  }
  emit(outcome);
}

// ---------------------------------------------------------------------------
// Logs

function collectLogs(outDir: string): never {
  const p = platform();
  mkdirSync(outDir, { recursive: true });
  const written: string[] = [];
  for (const path of p.engineLogPaths) {
    if (existsSync(path)) {
      writeFileSync(join(outDir, path.split('/').pop()!), readFileSync(path));
      written.push(path.split('/').pop()!);
    }
  }
  if (p.os === 'macos') {
    // launchd's own account of the engine agent (state, last exit status, program), the macOS counterpart of the journal.
    const agent = spawnSync('launchctl', ['print', `gui/${process.getuid?.() ?? 501}/ai.olympusplugin.engine`], { encoding: 'utf8' });
    writeFileSync(join(outDir, 'engine-launchd.txt'), `${agent.stdout ?? ''}${agent.stderr ?? ''}`);
    written.push('engine-launchd.txt');
  } else {
    const journal = spawnSync('journalctl', ['--user', '-u', 'olympus-engine', '--no-pager', '-n', '3000'], { encoding: 'utf8' });
    writeFileSync(join(outDir, 'engine-journal.log'), journal.stdout ?? '');
    written.push('engine-journal.log');
  }
  writeFileSync(join(outDir, 'engine-status.json'), olympus(['engine', 'status']).stdout);
  written.push('engine-status.json');
  writeFileSync(join(outDir, 'doctor.json'), olympus(['doctor']).stdout);
  written.push('doctor.json');
  const fakeLog = join(WORKDIR, 'fake-readwise.log');
  if (existsSync(fakeLog)) { writeFileSync(join(outDir, 'fake-readwise.log'), readFileSync(fakeLog)); written.push('fake-readwise.log'); }
  emit({ ok: true, files: written });
}

async function engineBuild(): Promise<never> {
  const status = olympus(['engine', 'status']);
  let build: string | null = null;
  let remote: unknown = null;
  try {
    const parsed = JSON.parse(status.stdout) as { engine?: { build?: string; remote_mode?: string } };
    build = parsed.engine?.build ?? null;
    remote = parsed.engine?.remote_mode ?? null;
  } catch { /* leave null */ }
  const conn = olympus(['connections', 'status']);
  let relay: unknown = null;
  try {
    const parsed = JSON.parse(conn.stdout) as { relay?: { state?: string; connected?: boolean } };
    relay = { state: parsed.relay?.state ?? null, connected: parsed.relay?.connected ?? null };
  } catch { /* leave null */ }
  emit({ ok: status.code === 0, build, remoteMode: remote, relay });
}

// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);
  const flag = (name: string, fallback?: string): string => {
    const at = rest.indexOf(name);
    const value = at === -1 ? fallback : rest[at + 1];
    if (value === undefined) throw new Error(`${name} is required`);
    return value;
  };
  switch (command) {
    case 'fake-readwise': {
      const config = existsSync(CONFIG_PATH) ? readConfig() : undefined;
      startFakeReadwise({
        port: config?.fakePort ?? FAKE_READWISE_PORT,
        token: config?.fakeToken ?? FAKE_READWISE_TOKEN,
        documents: config?.documents as never,
      });
      await new Promise(() => undefined);
      return;
    }
    case 'prepare-source': return await prepareSource();
    case 'connect-source': return await connectSource();
    case 'sync': return await syncNow();
    case 'settle': return await settle(Number(flag('--timeout-s', '600')));
    case 'mcp-token': return await mcpToken();
    case 'mcp-tools': return await mcpTools();
    case 'mcp-call': return await mcpCall(rest[0] ?? '', rest[1] ?? '{}');
    case 'mcp-rpc': return await mcpRpcRelay(flag('--input'));
    case 'smoke': return await smoke(flag('--questions'));
    case 'dashboard-json': {
      const dash = await dashboardJson();
      console.log(JSON.stringify({ ok: dash.status === 200, status: dash.status, body: dash.text }));
      process.exit(dash.status === 200 ? 0 : 1);
    }
    case 'screenshots': return await screenshots(flag('--out'));
    case 'collect-logs': return collectLogs(flag('--out'));
    case 'engine-build': return await engineBuild();
    default:
      console.error('usage: agent <prepare-source|connect-source|sync|settle|mcp-token|mcp-tools|mcp-call|mcp-rpc|smoke|dashboard-json|screenshots|collect-logs|engine-build>');
      process.exit(2);
  }
}

if (import.meta.main || process.argv[1]?.endsWith('agent.js')) {
  main().catch((error) => {
    console.log(JSON.stringify({ ok: false, detail: error instanceof Error ? error.message : String(error) }));
    process.exit(1);
  });
}

