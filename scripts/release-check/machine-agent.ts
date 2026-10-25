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
import { Database } from 'bun:sqlite';
import { createHash } from 'node:crypto';
import { chmodSync, closeSync, copyFileSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, readlinkSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { SourceFamily } from '../../src/core/source-index/types.ts';
import { archiveConnectorStoreDbPath } from '../../src/workers/archive-import/store.ts';
import { tierLedgerPathForStore } from '../../src/workers/classification/tier-ledger-path.ts';
import { defaultReadwiseConnectorStoreDbPath } from '../../src/workers/readwise/connector.ts';
import { defaultReadwiseSecureConnectorStoreDbPath } from '../../src/workers/readwise/tier-set.ts';
import { desktopSandboxOrigin, runSmoke, type SmokeObservation, privateNoteKind, panelMeta, resultText } from '../chatgpt-live-smoke.ts';
import { privateNoteKindIn } from './private-note.ts';
import { FAKE_READWISE_PORT, FAKE_READWISE_TOKEN, startFakeReadwise } from './readwise-fake.ts';
import type { DashboardCounts, ItemRow, PolicyState, StateSnapshot } from './upgrade.ts';
import { freshEgress, normalizeIp, outboundFromLsof, outboundFromProcNet, requestsOutsideMachine, type Connection } from './egress.ts';
import {
  anchorPresent, ASK_VIEW, centerOf, factsIn, FOCUS_QUESTION, PAGE_STATE, PAGE_UNLOCK_OFFERED, PAGE_UNLOCKED, pageApi, rowView, sourceNames,
} from './inbox-page.ts';
import { findBrowser, openBrowser, type Cdp, type OpenedBrowser } from './browser.ts';
import { captureScreens, CdpJourneyDriver, type CapturedScreen } from './journey-driver.ts';
import { runJourney, type JourneyTrace } from './journey.ts';
import { selectJourneys } from './journeys.ts';
import { explore, pagesAccessibilityAudit, withPageAudits, type Seed } from './explore.ts';
import { composeSeeds, localFilesDriver, type SeedContext } from './explore-seeds.ts';
import { explorePages } from './explore-pages.ts';
import type { PageInventory } from './explore-pages-inventory.ts';
import type { InventoryControl } from './explore-inventory.ts';
import { FIXTURE_FOLDER, STRESS_FORMAT, legFixture, type FixtureRole } from './archive-fixtures.ts';
import type { StoreView } from './archive-leg.ts';
import { changedStage, drainStage, importStage, modelStage, removeAllStage, removeStage, type ArchiveBrowserSession, type ArchiveHost } from './archive-stages.ts';

export { ISOLATED_BROWSER_FLAGS } from './browser.ts';
import type { AskView, CardView, DestinationId, EgressView, EntryView, FixView, InboxObservation, PageView, ShotView } from './inbox.ts';

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
  /** How many of the stand-in's items the owner's tier rules make Private. */
  expectedPrivate: number;
  relay: string;
  /** Per-question private facts, checked inside the machine so Private plaintext never leaves it. */
  privateFacts: Record<string, string[]>;
  /** Port the owner-socket bridge listens on; the engine's logical origin port. */
  enginePort: number;
  /** The 1.1.0 inbox leg: the question an agent asks, the question typed on the Ask page, and what their local answers must state and cite. */
  inbox?: {
    agent: { text: string; facts: string[]; citedTitle: string };
    ask: { text: string; facts: string[]; citedTitle: string };
  };
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
  configDir: string;
  dataDir: string;
  sovereigntyPath: string;
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
      // The owner's policy directory (engine.json, sovereignty.json and its backups) and the data root, as the engine lays them out on macOS.
      configDir: join(home, '.olympus'),
      dataDir: join(home, '.local', 'share', 'openclaw', 'olympus'),
      sovereigntyPath: join(home, '.olympus', 'sovereignty.json'),
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
    configDir: join(home, '.config', 'olympus'),
    dataDir: join(home, '.local', 'share', 'olympus'),
    sovereigntyPath: join(home, '.config', 'olympus', 'sovereignty.json'),
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

/** The privacy policy file as the engine reads it, with its digest and any owner-only backups the product wrote beside it. */
function readPolicy(): PolicyState | null {
  const path = platform().sovereigntyPath;
  if (!existsSync(path)) return null;
  const text = readFileSync(path, 'utf8');
  let json: unknown;
  try { json = JSON.parse(text); } catch { return null; }
  const dir = platform().configDir;
  const backups = readdirSync(dir)
    .filter((name) => name.startsWith('sovereignty.json.backup-'))
    .sort()
    .map((name) => ({ name, sha256: createHash('sha256').update(readFileSync(join(dir, name))).digest('hex') }));
  return { sha256: createHash('sha256').update(text).digest('hex'), json, backups };
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

export interface SettleSnapshot {
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

/**
 * Whether the machine's Private items are embedded under its current privacy policy. The earlier default is keyword-only
 * search for Private items (`metadata_only`): they are stored and classified but never embedded, so a settled install
 * has embedded only what is not Private. The newer default embeds them too.
 */
export function privateEmbeddedUnder(policy: { retrieval?: { trustDomains?: { secure_local?: { activationMode?: string } } } } | null): boolean {
  return policy?.retrieval?.trustDomains?.secure_local?.activationMode !== 'metadata_only';
}

export function isSettled(s: SettleSnapshot | undefined, config: AgentConfig, privateEmbedded = true): boolean {
  if (!s) return false;
  const stored = config.expectedItems - config.expectedSecrets;
  const embeddable = stored - (privateEmbedded ? 0 : config.expectedPrivate);
  return s.lastRun === 'completed'
    && s.seen >= config.expectedItems
    && s.indexed >= stored
    && s.contentReady >= stored
    && s.embedded >= embeddable
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
    stable = isSettled(last, config, privateEmbeddedUnder(readPolicy()?.json ?? null)) ? stable + 1 : 0;
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
  const shots: Array<{ file: string; width: number; theme: 'light' | 'dark'; bytes: number }> = [];
  let opened: OpenedBrowser | undefined;
  let outcome: Record<string, unknown> = { ok: false, detail: 'screenshots did not finish' };
  try {
    opened = await openBrowser(browser!, 'chrome-profile', 9333);
    const cdp = opened.cdp;
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
    opened?.close();
    stopBridge();
  }
  emit(outcome);
}

// ---------------------------------------------------------------------------
// The Ask page and the Inbox (1.1.0), driven in the owner's browser

const INBOX_DEBUG_PORT = 9334;
const squash = (text: string): string => text.replace(/\s+/g, ' ').trim();

/** The live outbound TCP connections the machine has right now. */
function currentConnections(): Connection[] {
  if (process.platform === 'darwin') {
    const listed = spawnSync('lsof', ['-nP', '-iTCP', '-sTCP:ESTABLISHED,SYN_SENT', '-F', 'pcn'], { encoding: 'utf8', timeout: 5_000 });
    return outboundFromLsof(listed.stdout ?? '');
  }
  const rows: Connection[] = [];
  for (const table of ['/proc/net/tcp', '/proc/net/tcp6']) {
    try { rows.push(...outboundFromProcNet(readFileSync(table, 'utf8'))); } catch { /* table unreadable: nothing to add */ }
  }
  return rows;
}

/** Linux: the name of the process that holds a socket open, found through this user's open files; undefined when it has closed. */
function ownerOfSocket(inode: string): string | undefined {
  try {
    for (const pid of readdirSync('/proc').filter((name) => /^\d+$/.test(name))) {
      let fds: string[];
      try { fds = readdirSync(`/proc/${pid}/fd`); } catch { continue; }
      for (const fd of fds) {
        try {
          if (readlinkSync(`/proc/${pid}/fd/${fd}`) === `socket:[${inode}]`) return readFileSync(`/proc/${pid}/comm`, 'utf8').trim();
        } catch { /* closed meanwhile */ }
      }
    }
  } catch { /* no /proc */ }
  return undefined;
}

/** Linux: the socket inodes held by a process and everything it started (the browser and its network service), read fresh. */
function socketsOfTree(rootPid: number | undefined): Set<string> {
  const held = new Set<string>();
  if (rootPid === undefined || process.platform !== 'linux') return held;
  try {
    const parentOf = new Map<number, number>();
    for (const name of readdirSync('/proc').filter((entry) => /^\d+$/.test(entry))) {
      try {
        // /proc/<pid>/stat: "pid (comm) state ppid ..."; comm may hold spaces and parentheses, so read after the last ")".
        const stat = readFileSync(`/proc/${name}/stat`, 'utf8');
        const after = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
        parentOf.set(Number(name), Number(after[1]));
      } catch { /* gone meanwhile */ }
    }
    const tree = new Set<number>([rootPid]);
    for (let grew = true; grew;) {
      grew = false;
      for (const [pid, parent] of parentOf) if (!tree.has(pid) && tree.has(parent)) { tree.add(pid); grew = true; }
    }
    for (const pid of tree) {
      let fds: string[];
      try { fds = readdirSync(`/proc/${pid}/fd`); } catch { continue; }
      for (const fd of fds) {
        try {
          const target = readlinkSync(`/proc/${pid}/fd/${fd}`);
          if (target.startsWith('socket:[')) held.add(target.slice(8, -1));
        } catch { /* closed meanwhile */ }
      }
    }
  } catch { /* no /proc */ }
  return held;
}

/**
 * Samples the machine's connections until stopped. What was connected at the start (the relay a connected agent uses, for one) is the
 * baseline; anything else that is not loopback, not the check's own browser and not an address of the relay is fresh egress.
 */
function startEgressWatch(allowedIps: ReadonlySet<string>, browserPid: () => number | undefined): { stop(): Omit<EgressView, 'pageRequests' | 'pageOutside'> } {
  const intervalMs = process.platform === 'darwin' ? 500 : 150;
  const baseline = new Set(currentConnections().map((connection) => connection.remote));
  const seen: Connection[] = [];
  const attributed = new Set<string>();
  let samples = 1;
  const timer = setInterval(() => {
    samples += 1;
    for (const connection of currentConnections()) {
      if (baseline.has(connection.remote)) continue;
      const key = `${connection.remote}|${connection.inode ?? connection.pid ?? ''}`;
      if (attributed.has(key)) continue;
      attributed.add(key);
      // The browser's own sockets are found first, in its small process tree, before the connection can close; the whole-machine search is the fallback.
      const comm = connection.comm ?? (connection.inode && socketsOfTree(browserPid()).has(connection.inode) ? 'chrome' : connection.inode ? ownerOfSocket(connection.inode) : undefined);
      seen.push({ ...connection, ...(comm ? { comm } : {}) });
    }
  }, intervalMs);
  return {
    stop() {
      clearInterval(timer);
      return { samples, intervalMs, baseline: baseline.size, fresh: freshEgress({ baseline, seen, allowedIps }) };
    },
  };
}

/** The addresses the relay host resolves to: a connected agent's tunnel may reconnect to any of them at any time. */
async function relayAddresses(relay: string): Promise<Set<string>> {
  const found = new Set<string>();
  let host: string;
  try { host = new URL(relay).hostname; } catch { return found; }
  const { resolve4, resolve6 } = await import('node:dns/promises');
  for (const ip of await resolve4(host).catch(() => [] as string[])) found.add(normalizeIp(ip));
  for (const ip of await resolve6(host).catch(() => [] as string[])) found.add(normalizeIp(ip));
  return found;
}

async function inboxCheck(primary: string, otherIds: string[], waitS: number, outDir: string, faultEntryId = false): Promise<void> {
  const config = readConfig();
  const inbox = config.inbox;
  if (!inbox) emit({ ok: false, detail: 'the machine was not given the inbox check settings' });
  const browser = findBrowser();
  if (!browser) emit({ ok: false, detail: 'no headless browser on the machine' });
  mkdirSync(outDir, { recursive: true });

  const observation: InboxObservation = {
    ok: false,
    ownerPath: { bearerStatus: null, unlockOffered: false, unlocked: false },
    destinations: {},
    entries: [],
    pages: [],
    ask: null,
    fixes: { venice: null, anonymous: null },
    refusals: { venice: null },
    egress: { samples: 0, intervalMs: 0, baseline: 0, fresh: [], pageRequests: 0, pageOutside: [] },
    shots: [],
    trace: [],
  };

  // This agent holds the engine's bearer. The Inbox route is for an unlocked browser on this computer only, so a bearer-minted
  // session must be refused: the check never uses it for anything else.
  try {
    const session = await ownerSession();
    observation.ownerPath.bearerStatus = (await session.call('POST', '/dashboard/private-answers', { action: 'list' })).status;
  } catch { /* the status stays unknown, which the check reports */ }

  let browserPid: number | undefined;
  const watch = startEgressWatch(await relayAddresses(config.relay), () => browserPid);
  const requests: string[] = [];
  let opened: OpenedBrowser | undefined;
  let stopBridge: () => void = () => undefined;
  let bridgeStarted = false;
  let failure: string | undefined;
  let egress: Omit<EgressView, 'pageRequests' | 'pageOutside'> | undefined;
  try {
    opened = await openBrowser(browser!, 'chrome-profile-inbox', INBOX_DEBUG_PORT, true);
    browserPid = opened.pid;
    const cdp = opened.cdp;
    await cdp.send('Page.enable');
    await cdp.send('Network.enable');
    cdp.on('Network.requestWillBeSent', (params) => { requests.push(String(params?.request?.url ?? '')); });
    await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }] });
    const metrics = async (width: number, height = 900): Promise<void> => {
      await cdp.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: width < 600 });
    };
    await metrics(1280);

    const evalIn = async (expression: string): Promise<any> => {
      const result = await cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
      if (result.exceptionDetails) throw new Error(`a page script failed: ${String(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text).slice(0, 160)}`);
      return result.result?.value;
    };
    const waitFor = async (expression: string, timeoutMs: number, everyMs = 500): Promise<boolean> => {
      const until = Date.now() + timeoutMs;
      for (;;) {
        try { if ((await evalIn(expression)) === true) return true; } catch { /* the page is changing */ }
        if (Date.now() >= until) return false;
        await sleep(everyMs);
      }
    };
    /** A real click: the element is scrolled into view and the mouse pressed on its centre. */
    const click = async (selector: string): Promise<boolean> => {
      const raw = await evalIn(centerOf(selector));
      if (typeof raw !== 'string') return false;
      const { x, y } = JSON.parse(raw) as { x: number; y: number };
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
      await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
      return true;
    };
    const stateNow = async (): Promise<any> => JSON.parse(String(await evalIn(PAGE_STATE)));
    const api = async (body: unknown): Promise<{ status: number; body: any }> => JSON.parse(String(await evalIn(pageApi(body)))) as { status: number; body: any };
    const shoot = async (name: string, label: string, width: number): Promise<void> => {
      await metrics(width);
      await sleep(1_000);
      const layout = await cdp.send('Page.getLayoutMetrics');
      await metrics(width, Math.min(6000, Math.ceil(layout.cssContentSize?.height ?? 900)));
      await sleep(600);
      const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
      const bytes = Buffer.from(shot.data as string, 'base64');
      writeFileSync(join(outDir, name), bytes);
      observation.shots.push({ file: join(outDir, name), label, width, theme: 'light', bytes: bytes.length });
      await metrics(1280);
    };

    // The trace: for each browser-driven step, what was done, what was expected, what happened, a picture after it, and what the page
    // logged or failed to load meanwhile. The harness brings the pictures back and renders them step by step in the report.
    const pageConsole: string[] = [];
    const pageFailed: string[] = [];
    const urlOf = new Map<string, string>();
    await cdp.send('Runtime.enable');
    cdp.on('Runtime.consoleAPICalled', (params) => { if (params?.type === 'error') pageConsole.push(String((params.args ?? []).map((a: any) => a?.value ?? a?.description ?? '').join(' ')).slice(0, 200)); });
    cdp.on('Runtime.exceptionThrown', (params) => { pageConsole.push(`uncaught: ${String(params?.exceptionDetails?.exception?.description ?? params?.exceptionDetails?.text ?? '').slice(0, 200)}`); });
    cdp.on('Network.requestWillBeSent', (params) => { urlOf.set(String(params?.requestId), String(params?.request?.url ?? '')); });
    cdp.on('Network.loadingFailed', (params) => {
      const url = urlOf.get(String(params?.requestId)) ?? '';
      if (params?.canceled !== true && !/favicon\.ico/.test(url)) pageFailed.push(`${url.replace(/[?#].*$/, '')} (${String(params?.errorText ?? 'failed')})`);
    });
    cdp.on('Network.responseReceived', (params) => {
      const status = Number(params?.response?.status ?? 0);
      const url = String(params?.response?.url ?? '');
      if (status >= 400 && !/favicon\.ico/.test(url)) pageFailed.push(`${url.replace(/[?#].*$/, '')} -> ${status}`);
    });
    const step = async <T>(name: string, action: string, expected: string, work: () => Promise<T>, actual: (value: T) => { text: string; ok: boolean }): Promise<T> => {
      const started = Date.now();
      pageConsole.length = 0;
      pageFailed.length = 0;
      let value: T | undefined;
      let error: unknown;
      try { value = await work(); } catch (caught) { error = caught; }
      const n = (observation.trace ?? []).length + 1;
      const file = `trace-${String(n).padStart(2, '0')}.jpg`;
      let screenshot: string | undefined;
      try {
        const shot = await cdp.send('Page.captureScreenshot', { format: 'jpeg', quality: 60 });
        writeFileSync(join(outDir, file), Buffer.from(shot.data as string, 'base64'));
        screenshot = file;
      } catch { /* the picture is a courtesy */ }
      let at = '';
      try { at = String(await evalIn(`location.pathname + location.search + location.hash`)).replace(/token=[^&#]*/g, 'token=...'); } catch { /* the page is changing */ }
      const result = error === undefined ? actual(value as T) : { text: `failed: ${error instanceof Error ? error.message : String(error)}`, ok: false };
      // The page's own errors during the step fail it, as in the journeys (a failed request also logs "Failed to load resource": reported once).
      const consoleErrors = [...new Set(pageConsole)].filter((message) => !(/Failed to load resource/.test(message) && pageFailed.length > 0));
      const failedRequests = [...new Set(pageFailed)];
      const findings = [...consoleErrors.map((message) => `console error: ${message}`), ...failedRequests.map((request) => `failed request: ${request}`)];
      (observation.trace ??= []).push({
        n, name, action, expected, actual: result.text, ok: result.ok && findings.length === 0, ms: Date.now() - started, at,
        ...(screenshot ? { screenshot } : {}), consoleErrors: consoleErrors.slice(0, 5), failedRequests: failedRequests.slice(0, 5), findings: findings.slice(0, 10),
      });
      if (error !== undefined) throw error;
      return value as T;
    };

    let origin = '';
    /** The owner's own way in: a one-time opening link for the place, then Unlock on the page. */
    const openTarget = async (target: string): Promise<{ state: any; unlockOffered: boolean; unlocked: boolean }> => {
      const minted = olympus(['dashboard', '--no-open', '--target', target], { timeoutMs: 60_000 });
      const url = /https?:\/\/[^\s"]+/.exec(minted.stdout + minted.stderr)?.[0];
      if (!url) throw new Error(`olympus dashboard --no-open --target ${target.startsWith('private/') ? 'private/<id>' : target} printed no opening link`);
      origin = new URL(url).origin;
      if (!bridgeStarted) { stopBridge = startBridge(Number(new URL(url).port || 80)); bridgeStarted = true; }
      await cdp.send('Page.navigate', { url });
      if (!(await waitFor(`!!document.querySelector('[data-private-answers]')`, 45_000))) throw new Error('the Private answers page did not open from the owner\'s opening link');
      const offered = (await evalIn(PAGE_UNLOCK_OFFERED)) === true;
      if (offered && !(await click('[data-private-answers] form[data-pa-unlock] button'))) throw new Error('the page\'s Unlock button could not be pressed');
      const unlocked = await waitFor(PAGE_UNLOCKED, 45_000);
      return { state: await stateNow(), unlockOffered: offered, unlocked };
    };

    const viewEntry = async (id: string, spec: { question: string | null; facts: string[]; citedTitle: string; waitUntil: number | null }): Promise<EntryView> => {
      const started = Date.now();
      const listed = await api({ action: 'list' });
      const row = (Array.isArray(listed.body?.questions) ? listed.body.questions : []).find((q: any) => q?.id === id);
      const view: EntryView = {
        id, listed: row !== undefined, path: typeof row?.path === 'string' ? row.path : null,
        fromShown: typeof row?.from === 'string' && row.from.trim() !== '',
        questionMatches: row === undefined || spec.question === null ? null : squash(String(row.question)) === squash(spec.question),
        status: null, factsStated: [], citations: 0, citesExpected: false, waitedS: 0,
      };
      if (row === undefined) return view;
      for (;;) {
        const read = await api({ action: 'read', id });
        if (read.status === 200 && read.body?.ok === true) {
          view.status = String(read.body.status);
          if (read.body.status === 'answered') {
            const citations: any[] = Array.isArray(read.body.citations) ? read.body.citations : [];
            view.factsStated = factsIn(String(read.body.answer ?? ''), spec.facts);
            view.citations = citations.length;
            view.citesExpected = sourceNames(citations.map((c) => [c?.title, c?.source, c?.date].filter(Boolean).join(' · ')), spec.citedTitle);
            break;
          }
        } else {
          view.status = `http ${read.status}`;
        }
        if (spec.waitUntil === null || Date.now() >= spec.waitUntil) break;
        await sleep(10_000);
      }
      view.waitedS = Math.round((Date.now() - started) / 1000);
      return view;
    };

    /** Waits (bounded) for the local model to be ready to ask; the page's own refresh turns the card, a reload covers a page that is not refreshing. */
    const untilComputerReady = async (state: any, timeoutMs: number): Promise<any> => {
      const until = Date.now() + timeoutMs;
      let latest = state;
      let lastReload = Date.now();
      while (latest.cards?.computer?.state !== 'ready' && Date.now() < until) {
        await sleep(5_000);
        if (Date.now() - lastReload > 60_000) { await cdp.send('Page.reload'); lastReload = Date.now(); await waitFor(PAGE_UNLOCKED, 45_000); }
        latest = await stateNow();
      }
      return latest;
    };

    // 1. The Ask page, opened by the owner's link and unlocked.
    const ready = await step(
      'Open the Ask page', 'open the owner\'s link, press Unlock, wait for the local model to be ready',
      'the controls unlock and the destination cards show',
      async () => {
        const first = await openTarget('private');
        observation.ownerPath.unlockOffered = first.unlockOffered;
        observation.ownerPath.unlocked = first.unlocked;
        if (!first.unlocked) throw new Error(`the Private answers page did not open its controls (Unlock ${first.unlockOffered ? 'was pressed' : 'was not offered'})`);
        return await untilComputerReady(first.state, 300_000);
      },
      (state) => ({ text: `unlocked; local model ${String(state.cards?.computer?.state ?? 'not shown')}`, ok: true }),
    );
    for (const key of ['computer', 'anonymous', 'venice'] as DestinationId[]) {
      if (ready.cards?.[key]) observation.destinations[key] = ready.cards[key] as CardView;
    }
    await step('Look at the Ask page at both widths', 'resize to 1280 and 390 px and capture', 'both pictures are taken',
      async () => { await shoot('ask-page-1280.png', 'The Ask page, 1280 px wide (the owner\'s unlocked browser)', 1280); await shoot('ask-page-390.png', 'The Ask page, 390 px wide (the owner\'s unlocked browser)', 390); },
      () => ({ text: 'captured', ok: true }));

    // 2. The agent's entry, by the id its link names: the route, waiting for the local model's answer.
    const agentSpec = { question: inbox.agent.text, facts: inbox.agent.facts, citedTitle: inbox.agent.citedTitle };
    if (primary) {
      observation.entries.push(await step('Read the agent\'s entry by its link id', 'ask the Inbox route for the entry, waiting for the local model\'s answer', 'the entry is listed and answered',
        () => viewEntry(primary, { ...agentSpec, waitUntil: Date.now() + waitS * 1000 }),
        (view) => ({ text: `${view.listed ? 'listed' : 'not listed'}; ${view.status ?? 'no status'}; ${view.factsStated.length} fact(s) stated; ${view.citations} source(s)`, ok: view.listed && view.status === 'answered' })));
    }
    for (const id of otherIds) {
      if (id !== primary && !observation.entries.some((entry) => entry.id === id)) observation.entries.push(await viewEntry(id, { question: null, facts: [], citedTitle: '', waitUntil: null }));
    }

    // The address an Open link names, opened by the owner: the Inbox lands on that entry and opens it.
    const openByAddress = async (addressId: string, pageId: string, spec: { facts: string[]; citedTitle: string }, shotLabel: string): Promise<PageView> => {
      const view = await step('Open the entry\'s address', 'open the one-time link for the entry, press Unlock', 'the Inbox lands on the entry and opens it',
        () => openTarget(`private/${addressId}`), (opened2) => ({ text: opened2.unlocked ? 'unlocked' : 'stayed locked', ok: opened2.unlocked }));
      observation.ownerPath.unlocked = observation.ownerPath.unlocked && view.unlocked;
      let row: any = { found: false };
      const until = Date.now() + 90_000;
      for (;;) {
        row = JSON.parse(String(await evalIn(rowView(pageId))));
        if (row.opened === true || Date.now() >= until) break;
        await sleep(2_000);
      }
      const now = await stateNow();
      const sources: string[] = Array.isArray(row.sources) ? row.sources : [];
      const page: PageView = {
        id: pageId,
        landedOnInbox: now.page === true && now.ask === true && /private-answers/.test(String(now.where)),
        rowFound: row.found === true,
        opened: row.opened === true,
        factsStated: factsIn(String(row.answer ?? ''), spec.facts),
        citations: sources.length,
        citesExpected: sourceNames(sources, spec.citedTitle),
      };
      observation.pages.push(page);
      if (row.opened === true) {
        await shoot('inbox-entry-1280.png', `An opened Inbox entry, 1280 px wide (${shotLabel})`, 1280);
        await shoot('inbox-entry-390.png', `An opened Inbox entry, 390 px wide (${shotLabel})`, 390);
      }
      return page;
    };

    // 3. The link's own address, opened by the owner: the Inbox lands on that entry.
    if (primary) await openByAddress(primary, primary, { facts: inbox.agent.facts, citedTitle: inbox.agent.citedTitle }, 'from the agent\'s link');

    // 4. Ask the local model: typed into the page and pressed, on a clean Ask page.
    const secondReady = await step('Open a clean Ask page', 'open the owner\'s link again, press Unlock, wait for the local model', 'the controls unlock and the local model is ready',
      async () => {
        const second = await openTarget('private');
        observation.ownerPath.unlocked = observation.ownerPath.unlocked && second.unlocked;
        return await untilComputerReady(second.state, 120_000);
      },
      (state) => ({ text: `local model ${String(state.cards?.computer?.state ?? 'not shown')}`, ok: true }));
    const knownRows = new Set<string>((secondReady.rows ?? []).map((row: any) => String(row.id)));
    const ask: AskView = { pressed: false, answered: false, message: '', factsStated: [], citations: 0, citesExpected: false, ms: 0, entry: null };
    observation.ask = ask;
    if ((await evalIn(FOCUS_QUESTION)) === true && secondReady.cards?.computer?.state === 'ready') await step('Ask the local model', 'type the question into the page and press "Ask the local model"', 'an answer with its sources appears and a new Inbox entry is kept', async () => {
      await cdp.send('Input.insertText', { text: inbox.ask.text });
      const started = Date.now();
      ask.pressed = await click('form[data-pa-ask] button[data-pa-destination="computer"]');
      if (ask.pressed) {
        await sleep(1_000);
        const until = started + waitS * 1000;
        let view: any = { found: false };
        for (;;) {
          view = JSON.parse(String(await evalIn(ASK_VIEW)));
          if ((view.found === true && view.busy !== true) || Date.now() >= until) break;
          await sleep(2_000);
        }
        ask.ms = Date.now() - started;
        const answer = typeof view.answer === 'string' ? view.answer : '';
        const sources: string[] = Array.isArray(view.sources) ? view.sources : [];
        ask.answered = answer !== '';
        ask.message = ask.answered ? '' : String(view.message ?? '').slice(0, 120);
        ask.factsStated = factsIn(answer, inbox.ask.facts);
        ask.citations = sources.length;
        ask.citesExpected = sourceNames(sources, inbox.ask.citedTitle);
        if (ask.answered) {
          let newId: string | undefined;
          const listUntil = Date.now() + 90_000;
          while (newId === undefined && Date.now() < listUntil) {
            const listed = await api({ action: 'list' });
            const row = (Array.isArray(listed.body?.questions) ? listed.body.questions : []).find((q: any) => !knownRows.has(String(q?.id)) && squash(String(q?.question)) === squash(inbox.ask.text));
            if (row) newId = String(row.id); else await sleep(3_000);
          }
          if (newId !== undefined) ask.entry = await viewEntry(newId, { question: inbox.ask.text, facts: inbox.ask.facts, citedTitle: inbox.ask.citedTitle, waitUntil: Date.now() + 120_000 });
          await evalIn(`window.scrollTo(0, 0)`);
          await shoot('ask-answered-1280.png', 'The Ask page after "Ask the local model": the answer, its sources, and the new Inbox entry', 1280);
        }
      }
    }, () => ({ text: ask.pressed ? (ask.answered ? `answered in ${Math.round(ask.ms / 1000)} s; ${ask.citations} source(s)` : `no answer: ${ask.message}`) : 'the button could not be pressed', ok: ask.pressed && ask.answered }));

    // 5. Destinations that are not set up: Venice's ask is refused by the route; the way to fix each is a link that lands on the right Models section.
    const venice = secondReady.cards?.venice;
    if (venice?.state === 'not_set_up') {
      const refused = await api({ action: 'ask_venice', question: 'Release check: Venice is not set up, so this must be refused.' });
      observation.refusals.venice = refused.status;
    }
    const followFix = (key: 'venice' | 'anonymous', anchor: string): Promise<FixView> => step(`Follow the way to fix ${key === 'venice' ? 'Venice' : 'the anonymous route'}`, `press the fix link on the ${key} card`, `the link lands on the ${anchor} section of Models`, () => followFixNow(key, anchor), (fix) => ({ text: fix.clicked ? `landed at ${fix.landedAt}; section ${fix.anchorShown ? 'shown' : 'NOT shown'}` : 'no fix link to press', ok: fix.clicked && fix.anchorShown }));
    const followFixNow = async (key: 'venice' | 'anonymous', anchor: string): Promise<FixView> => {
      const clicked = await click(`[data-pa-card="${key}"] .paaction a`);
      if (!clicked) return { clicked: false, landedAt: '', anchorShown: false };
      const shown = await waitFor(anchorPresent(anchor), 30_000);
      const where = String(await evalIn(`location.pathname + location.search + location.hash`));
      await cdp.send('Page.navigate', { url: `${origin}/dashboard?private-answers` });
      await waitFor(PAGE_UNLOCKED, 45_000);
      return { clicked: true, landedAt: where.replace(/token=[^&#]*/g, 'token=…'), anchorShown: shown };
    };
    if (secondReady.cards?.venice) observation.fixes.venice = await followFix('venice', 'venice-setup');
    if (secondReady.cards?.anonymous) observation.fixes.anonymous = await followFix('anonymous', 'anonymous');

    // 6. No link from an agent (this install issues none): the entry the Ask page just made is opened by its address instead, so the
    //    id-to-entry route is still exercised with a real id. The fault self-test changes the last character of the address.
    if (!primary && ask.entry) {
      const entryId = ask.entry.id;
      const address = faultEntryId ? `${entryId.slice(0, -1)}${entryId.endsWith('A') ? 'B' : 'A'}` : entryId;
      await openByAddress(address, entryId, { facts: inbox.ask.facts, citedTitle: inbox.ask.citedTitle }, 'from its own address');
    }
  } catch (error) {
    failure = error instanceof Error ? error.message : String(error);
  } finally {
    egress = watch.stop();
    opened?.close();
    stopBridge();
  }
  observation.egress = { ...(egress ?? observation.egress), pageRequests: requests.length, pageOutside: requestsOutsideMachine(requests) };
  if (failure !== undefined) { observation.ok = false; observation.detail = failure; } else { observation.ok = true; }
  emit({ ...observation });
}

// ---------------------------------------------------------------------------
// Journeys and the screens for the visual baselines

const JOURNEY_DEBUG_PORT = 9335;

/**
 * Walks the journeys in the owner's browser (journeys.ts) and takes the screens the visual baselines compare (visual.ts). Everything
 * goes into one folder, which is archived for the harness to fetch in one transfer: the screens, and a trace for each journey with
 * a screenshot after each step. The screens are taken first, while the install is as the run left it; the journeys that change the
 * install run last.
 */
async function journeysCommand(outDir: string, only: string[], skipScreens: boolean): Promise<never> {
  const browser = findBrowser();
  if (!browser) emit({ ok: false, detail: 'no headless browser on the machine' });
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });
  let stopBridge: () => void = () => undefined;
  let bridgeStarted = false;
  let opened: OpenedBrowser | undefined;
  const traces: JourneyTrace[] = [];
  let screens: CapturedScreen[] = [];
  let failure: string | undefined;
  try {
    opened = await openBrowser(browser!, 'chrome-profile-journeys', JOURNEY_DEBUG_PORT, true);
    const driver = new CdpJourneyDriver({
      cdp: opened.cdp,
      debugPort: JOURNEY_DEBUG_PORT,
      outDir,
      mintLink: async (place) => {
        const minted = olympus(['dashboard', '--no-open', '--target', place], { timeoutMs: 60_000 });
        const url = /https?:\/\/[^\s"]+/.exec(minted.stdout + minted.stderr)?.[0];
        if (!url) throw new Error(`olympus dashboard --no-open --target ${place} printed no opening link`);
        return url;
      },
      onOrigin: (origin) => {
        if (!bridgeStarted) { stopBridge = startBridge(Number(new URL(origin).port || 80)); bridgeStarted = true; }
      },
    });
    await driver.start();
    if (!skipScreens) {
      try { screens = await captureScreens(driver, outDir); } catch (error) { failure = `the screens could not be captured: ${error instanceof Error ? error.message : String(error)}`; }
    }
    for (const journey of selectJourneys(only)) {
      try {
        traces.push(await runJourney(driver, journey));
      } catch (error) {
        traces.push({ id: journey.id, title: journey.title, source: journey.source, ok: false, steps: [], ms: 0, error: error instanceof Error ? error.message : String(error) });
      }
      say(`journey ${journey.id}: ${traces[traces.length - 1]!.ok ? 'ok' : 'FAILED'}`);
    }
  } catch (error) {
    failure = error instanceof Error ? error.message : String(error);
  } finally {
    opened?.close();
    stopBridge();
  }
  writeFileSync(join(outDir, 'traces.json'), JSON.stringify(traces));
  const archive = join(WORKDIR, 'journeys.tgz');
  const packed = spawnSync('tar', ['-czf', archive, '-C', outDir, '.'], { encoding: 'utf8' });
  if (packed.status !== 0) emit({ ok: false, detail: `the journey files could not be archived: ${packed.stderr.slice(0, 160)}` });
  emit({ ok: failure === undefined, ...(failure === undefined ? {} : { detail: failure }), traces, screens, archive });
}


// ---------------------------------------------------------------------------
// Bounded exploration of the Sources section (explore.ts)

const EXPLORE_DEBUG_PORT = 9336;
const WRONG_TOKEN = 'release-check-rejected-token';

function stopFake(): void {
  spawnSync('pkill', ['-f', 'fake-readwise'], { encoding: 'utf8' });
}

/** The stand-in for Readwise, started detached with the given token (the right one, or one the connector's stored key will not match). */
async function startFakeWith(config: AgentConfig, token: string): Promise<void> {
  stopFake();
  await sleep(500);
  mkdirSync(WORKDIR, { recursive: true });
  const logFd = openSync(join(WORKDIR, 'fake-readwise.log'), 'a');
  const child = spawn(process.execPath, [process.argv[1]!, 'fake-readwise', '--token', token], { detached: true, stdio: ['ignore', logFd, logFd] });
  child.unref();
  closeSync(logFd);
  for (let i = 0; i < 40; i += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${config.fakePort}/api/v2/auth/`, { headers: { authorization: `Token ${token}` } });
      if (response.status === 204) return;
    } catch { /* not up yet */ }
    await sleep(250);
  }
  throw new Error('the Readwise stand-in did not start');
}

/** A source's card; the engine can be briefly unreachable right after a delete or a restart, so a failed read is tried again. */
async function cardOf(provider: string): Promise<any> {
  let last: unknown;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try {
      const dash = await dashboardJson();
      return (dash.json?.sources ?? []).find((card: any) => card.provider === provider);
    } catch (error) { last = error; await sleep(3_000); }
  }
  throw last;
}
const readwiseCard = (): Promise<any> => cardOf('readwise');

async function until<T>(read: () => Promise<T | undefined>, timeoutMs: number, everyMs = 2_000): Promise<T | undefined> {
  const stop = Date.now() + timeoutMs;
  for (;;) {
    const got = await read().catch(() => undefined);
    if (got !== undefined) return got;
    if (Date.now() >= stop) return undefined;
    await sleep(everyMs);
  }
}

const cardSummary = (card: any): string => `connection ${String(card?.connection?.state ?? '?')}, ${String(card?.coverage?.indexed_items ?? '?')} indexed, answers ${String(card?.answer_readiness?.state ?? '?')}${card?.connection?.provider_refusal ? ', refused by the provider' : ''}`;

/** Disconnects Readwise; a 409 means the source is busy (a sync in flight), so it is asked again for a minute, and the answer says what it refused with. */
async function disconnectReadwise(session: { call(method: string, path: string, body?: unknown): Promise<{ status: number; json: any; text: string }> }): Promise<{ status: number; json: any; text: string }> {
  let response = await session.call('POST', '/dashboard/disconnect', { source_id: 'readwise.library', acknowledge: true });
  for (let attempt = 0; attempt < 12 && response.status === 409; attempt += 1) {
    await sleep(5_000);
    response = await session.call('POST', '/dashboard/disconnect', { source_id: 'readwise.library', acknowledge: true });
  }
  return response;
}

/**
 * The seeded states of the install the exploration starts from, produced through the dashboard's own routes: Readwise through the stand-in
 * for its API, Telegram and WhatsApp through stand-ins for their capture daemons, and on Linux Files on this computer with a real folder.
 */
function exploreSeeds(config: AgentConfig): Seed[] {
  const ctx: SeedContext = {
    call: async (method, path, body) => await (await ownerSession()).call(method, path, body),
    cardOf, sleep, now: () => Date.now(), home: homedir(), env: process.env,
  };
  return composeSeeds(readwiseSeeds(config), [
    ...(platform().os === 'linux' ? [localFilesDriver(ctx)] : []),
  ]);
}

/** Readwise's seeded states: the stand-in API, with the stored key accepted, rejected, or the source disconnected or emptied. */
function readwiseSeeds(config: AgentConfig): Seed[] {
  // The card's connection reads `synced` once the source has been read; not connected, needs setup, awaiting consent and reauth are the others.
  const connected = (card: any): boolean => !!card && !['not_connected', 'needs_setup', 'awaiting_consent', 'reauth_required'].includes(String(card.connection?.state ?? 'not_connected'));
  const connect = async (): Promise<void> => {
    const session = await ownerSession();
    await startFakeWith(config, config.fakeToken);
    const response = await session.call('POST', '/dashboard/connect/api-key', { source: 'readwise', api_key: config.fakeToken });
    if (response.status !== 200 || response.json?.ok !== true) throw new Error(`connect answered ${response.status}`);
  };
  const populated = async (): Promise<{ ok: boolean; detail: string }> => {
    let card = await readwiseCard();
    if (!connected(card) || card?.connection?.provider_refusal || card?.connection?.state === 'reauth_required') await connect();
    else await startFakeWith(config, config.fakeToken);
    const session = await ownerSession();
    await session.call('POST', '/dashboard/sync-now', { source: 'readwise' });
    card = await until(async () => { const now = await readwiseCard(); return connected(now) && !now?.connection?.provider_refusal && (now?.coverage?.indexed_items ?? 0) > 0 ? now : undefined; }, 120_000);
    return card ? { ok: true, detail: cardSummary(card) } : { ok: false, detail: `the source did not come back to connected with its data: ${cardSummary(await readwiseCard())}` };
  };
  return [
    // Unpair ends a pairing the machine cannot make again (there is no phone), so its Confirm runs last, like Delete indexed data.
    { id: 'populated', title: 'populated', apply: populated, resetAfter: ['confirm'] },
    {
      id: 'failed', title: 'failed',
      apply: async () => {
        const first = await populated();
        if (!first.ok) return first;
        // The stored key stops being accepted: the next sync is refused, and the page owes the owner a way to fix it.
        await startFakeWith(config, WRONG_TOKEN);
        const refused = async (): Promise<any> => {
          const now = await readwiseCard();
          return now?.connection?.provider_refusal || now?.connection?.state === 'reauth_required' || now?.answer_readiness?.state === 'needs_attention' ? now : undefined;
        };
        const session = await ownerSession();
        const sync = await session.call('POST', '/dashboard/sync-now', { source: 'readwise' });
        // The pull that meets the refusal is the scheduler's; Sync now is asked again now and then in case a press is throttled.
        let card: any;
        for (let round = 0; round < 6 && !card; round += 1) {
          card = await until(refused, 45_000, 5_000);
          if (!card) await session.call('POST', '/dashboard/sync-now', { source: 'readwise' }).catch(() => undefined);
        }
        // A key the provider no longer accepts, entered again, is the other way a source ends up needing the owner.
        let entered = 0;
        if (!card) {
          const again = await session.call('POST', '/dashboard/connect/api-key', { source: 'readwise', api_key: config.fakeToken });
          entered = again.status;
          card = await until(refused, 60_000);
        }
        return card ? { ok: true, detail: cardSummary(card) } : { ok: false, detail: `a sync with a rejected key (sync answered ${sync.status}${entered ? `, a rejected key entered again answered ${entered}` : ''}) did not leave the source needing attention: ${cardSummary(await readwiseCard())} (connection: ${JSON.stringify((await readwiseCard())?.connection ?? null).slice(0, 300)})` };
      },
      resetAfter: ['confirm', 'sync'],
    },
    {
      id: 'disconnected', title: 'disconnected, its data kept',
      apply: async () => {
        const first = await populated();
        if (!first.ok) return first;
        const session = await ownerSession();
        const response = await disconnectReadwise(session);
        if (response.status !== 200) return { ok: false, detail: `disconnect answered ${response.status}: ${String(response.text ?? '').replace(/\s+/g, ' ').slice(0, 160)}` };
        const card = await until(async () => { const now = await readwiseCard(); return now && !connected(now) && (now?.coverage?.indexed_items ?? 0) > 0 ? now : undefined; }, 60_000);
        return card ? { ok: true, detail: cardSummary(card) } : { ok: false, detail: `the source did not read as disconnected with its data kept: ${cardSummary(await readwiseCard())}` };
      },
      resetAfter: ['confirm'],
      last: ['delete-data'],
    },
    {
      id: 'empty', title: 'empty (disconnected, nothing indexed)',
      apply: async () => {
        await startFakeWith(config, config.fakeToken).catch(() => undefined);
        // The engine restarts a moment after a delete; the card read waits for it to answer again before anything else is asked.
        await readwiseCard();
        const session = await ownerSession();
        let card = await readwiseCard();
        if (connected(card)) {
          const response = await disconnectReadwise(session);
          if (response.status !== 200) return { ok: false, detail: `disconnect answered ${response.status}: ${String(response.text ?? '').replace(/\s+/g, ' ').slice(0, 160)}` };
          card = await until(async () => { const now = await readwiseCard(); return now && !connected(now) ? now : undefined; }, 60_000);
        }
        if (card && (card?.coverage?.indexed_items ?? 0) > 0) {
          const response = await session.call('POST', '/dashboard/delete-source-data', { source_id: 'readwise.library', acknowledge: true });
          if (response.status !== 200) return { ok: false, detail: `delete-source-data answered ${response.status}` };
          card = await until(async () => { const now = await readwiseCard(); return now && (now?.coverage?.indexed_items ?? 0) === 0 && !connected(now) ? now : undefined; }, 120_000, 3_000);
        }
        // A delete (here or in the press just before) restarts the engine's worker a moment later; the page is not opened until it has had time to come back.
        await sleep(10_000);
        card = await readwiseCard();
        return card && !connected(card) && (card?.coverage?.indexed_items ?? 0) === 0 ? { ok: true, detail: cardSummary(card) } : { ok: false, detail: `the source did not read as empty (not connected, nothing indexed): ${cardSummary(await readwiseCard())}` };
      },
    },
  ];
}

async function exploreCommand(outDir: string, inventoryPath: string, pagesInventoryPath?: string): Promise<never> {
  const startedAt = Date.now();
  const browser = findBrowser();
  if (!browser) emit({ ok: false, detail: 'no headless browser on the machine' });
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });
  const inventory = JSON.parse(readFileSync(inventoryPath, 'utf8')) as InventoryControl[];
  const config = readConfig();
  let stopBridge: () => void = () => undefined;
  let bridgeStarted = false;
  let opened: OpenedBrowser | undefined;
  let failure: string | undefined;
  let result: Awaited<ReturnType<typeof explore>> | undefined;
  try {
    opened = await openBrowser(browser!, 'chrome-profile-explore', EXPLORE_DEBUG_PORT, true);
    const driver = new CdpJourneyDriver({
      cdp: opened.cdp,
      debugPort: EXPLORE_DEBUG_PORT,
      outDir,
      mintLink: async (place) => {
        const minted = olympus(['dashboard', '--no-open', '--target', place], { timeoutMs: 60_000 });
        const url = /https?:\/\/[^\s"]+/.exec(minted.stdout + minted.stderr)?.[0];
        if (!url) throw new Error(`olympus dashboard --no-open --target ${place} printed no opening link`);
        return url;
      },
      onOrigin: (origin) => {
        if (!bridgeStarted) { stopBridge = startBridge(Number(new URL(origin).port || 80)); bridgeStarted = true; }
      },
    });
    await driver.start();
    // The first opening link signs the browser in and Unlock opens the controls (the Private answers page offers it); the dashboard then opens in that session.
    await driver.open('private');
    // The accessibility checker's script, put on the machine by the orchestrator beside the inventory; without it the audit is skipped and says so.
    const axePath = join(WORKDIR, 'axe.min.js');
    const axeSource = existsSync(axePath) ? readFileSync(axePath, 'utf8') : undefined;
    result = await explore({ driver, seeds: exploreSeeds(config), inventory, signedIn: true, deadlineAt: startedAt + 45 * 60_000, ...(axeSource ? { axeSource } : {}) });
    // The computer's other pages, in the same signed-in browser, after the Sources section (Lock ends the session, so it comes last).
    // Each is audited as it loads, in the same accessibility check.
    if (pagesInventoryPath && existsSync(pagesInventoryPath)) {
      const pagesInventory = JSON.parse(readFileSync(pagesInventoryPath, 'utf8')) as PageInventory;
      const pageAudit = axeSource ? pagesAccessibilityAudit(axeSource) : undefined;
      const pages = await explorePages({ driver, inventory: pagesInventory, deadlineAt: startedAt + 75 * 60_000, ...(pageAudit ? { audit: pageAudit.audit } : {}) });
      result = { ...result, pages, ...(pageAudit ? { accessibility: withPageAudits(result.accessibility, pageAudit) } : {}) };
    }
  } catch (error) {
    failure = error instanceof Error ? error.message : String(error);
  } finally {
    opened?.close();
    stopBridge();
  }
  writeFileSync(join(outDir, 'explore.json'), JSON.stringify(result ?? null));
  const archive = join(WORKDIR, 'explore.tgz');
  const packed = spawnSync('tar', ['-czf', archive, '-C', outDir, '.'], { encoding: 'utf8' });
  if (packed.status !== 0) emit({ ok: false, detail: `the exploration files could not be archived: ${packed.stderr.slice(0, 160)}` });
  emit({ ok: failure === undefined, ...(failure === undefined ? {} : { detail: failure }), result: result ?? null, archive });
}

// ---------------------------------------------------------------------------
// Archive import (archive-leg.ts holds the checks, archive-stages.ts the stages; this is the machine they stand on)

const ARCHIVE_DEBUG_PORT = 9337;
const ARCHIVE_OUT = join(WORKDIR, 'archive');

/** The JSON an `olympus` command printed: the whole of stdout, else the JSON object that starts at its first brace (stdout, then stderr). */
function jsonFrom(...texts: string[]): unknown {
  for (const text of texts) {
    const trimmed = text.trim();
    if (!trimmed) continue;
    for (const candidate of [trimmed, trimmed.slice(Math.max(0, trimmed.indexOf('{')))]) {
      try { return JSON.parse(candidate); } catch { /* not the whole of it: try the next form */ }
    }
  }
  return undefined;
}

/** The engine's MCP token, made once for a machine that has none yet (the smoke leg makes it first on a full run). */
function ensureMcpToken(): void {
  if (existsSync(TOKEN_PATH)) return;
  const created = olympus(['connections', 'add', 'release-check-archive']);
  const parsed = jsonFrom(created.stdout) as { token?: string } | undefined;
  if (created.code !== 0 || !parsed?.token) throw new Error('connections add did not give a token');
  mkdirSync(WORKDIR, { recursive: true });
  writeFileSync(TOKEN_PATH, parsed.token, { mode: 0o600 });
  chmodSync(TOKEN_PATH, 0o600);
}

/** `olympus_search` on the engine's MCP endpoint, the way a connected agent asks. */
async function archiveSearch(question: string): Promise<{ ok: boolean; isError: boolean; structured: unknown; error?: string }> {
  ensureMcpToken();
  const session = await mcpSession();
  const called = await mcpRpc(session, { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'olympus_search', arguments: { question, limit: 10 } } });
  const message = parseRpc(called.text);
  const result = message.result ?? {};
  return {
    ok: called.status === 200 && !message.error,
    isError: result.isError === true || Boolean(message.error),
    structured: result.structuredContent ?? null,
    ...(message.error?.message ? { error: String(message.error.message).slice(0, 160) } : {}),
  };
}

/**
 * The three tier stores an archive family writes to (Private, Personal, Public), read-only: how many live items an archive has in each, and
 * how many rows (items, chunks, search rows) carry its word. The word is only in message bodies, so a row that holds it holds content.
 */
function readArchiveStores(spec: { family: string; provider: string }, archiveId: string | undefined, token: string): StoreView[] {
  // Where the engine keeps them, by the same resolvers the engine uses (a new install's are in the archive's account folder).
  const files: Array<[StoreView['tier'], string]> = [
    ['private', archiveConnectorStoreDbPath('secure_local', spec.family as SourceFamily)],
    ['personal', archiveConnectorStoreDbPath('internal', spec.family as SourceFamily)],
    ['public', archiveConnectorStoreDbPath('public_safe', spec.family as SourceFamily)],
  ];
  const like = `%${token}%`;
  return files.map(([tier, path]): StoreView => {
    if (!existsSync(path)) return { tier, exists: false, live: 0, tokenRows: 0 };
    try {
      const db = new Database(path, { readonly: true });
      try {
        db.exec('PRAGMA busy_timeout = 10000;');
        const count = (sql: string, ...params: string[]): number => Number((db.query(sql).get(...params) as { n: number } | null)?.n ?? 0);
        const tokenRows = count('select count(*) as n from items where title like ? or search_text like ?', like, like)
          + count('select count(*) as n from chunks where bounded_text like ?', like)
          + count('select count(*) as n from connector_store_fts where bounded_text like ?', like);
        // An archive's own items when its id is known; otherwise the items whose text carries its word.
        const live = archiveId !== undefined
          ? count('select count(*) as n from items where provider = ? and account_scope = ? and tombstoned = 0', spec.provider, archiveId)
          : count('select count(distinct i.item_pk) as n from items i join chunks c on c.item_pk = i.item_pk where i.provider = ? and i.tombstoned = 0 and c.bounded_text like ?', spec.provider, like);
        return { tier, exists: true, live, tokenRows };
      } finally { db.close(); }
    } catch (error) {
      return { tier, exists: true, live: 0, tokenRows: 0, error: (error instanceof Error ? error.message : String(error)).slice(0, 160) };
    }
  });
}

/** One signed-in browser for the whole of `work`: a fresh profile, the owner's opening link and Unlock, the dashboard open. */
async function withArchiveBrowser<T>(work: (session: ArchiveBrowserSession) => Promise<T>): Promise<T> {
  const browser = findBrowser();
  if (!browser) throw new Error('no headless browser on the machine');
  mkdirSync(ARCHIVE_OUT, { recursive: true });
  rmSync(join(WORKDIR, 'chrome-profile-archive'), { recursive: true, force: true });
  let stopBridge: () => void = () => undefined;
  let bridgeStarted = false;
  const opened = await openBrowser(browser, 'chrome-profile-archive', ARCHIVE_DEBUG_PORT, true);
  try {
    const requests: string[] = [];
    opened.cdp.on('Network.requestWillBeSent', (params) => { requests.push(String(params?.request?.url ?? '')); });
    await opened.cdp.send('Network.enable');
    const driver = new CdpJourneyDriver({
      cdp: opened.cdp,
      debugPort: ARCHIVE_DEBUG_PORT,
      outDir: ARCHIVE_OUT,
      mintLink: async (place) => {
        const minted = olympus(['dashboard', '--no-open', '--target', place], { timeoutMs: 60_000 });
        const url = /https?:\/\/[^\s"]+/.exec(minted.stdout + minted.stderr)?.[0];
        if (!url) throw new Error(`olympus dashboard --no-open --target ${place} printed no opening link`);
        return url;
      },
      onOrigin: (origin) => {
        if (!bridgeStarted) { stopBridge = startBridge(Number(new URL(origin).port || 80)); bridgeStarted = true; }
      },
    });
    await driver.start();
    // Archive approval, browsing and removal are for an unlocked browser on this computer: the opening link, then Unlock.
    await driver.open('private');
    await driver.go('/dashboard');
    return await work({ driver, pid: opened.pid, requests });
  } finally {
    opened.close();
    stopBridge();
  }
}

function archiveHost(): ArchiveHost {
  const p = platform();
  return {
    os: p.os,
    home: homedir(),
    workDir: WORKDIR,
    workerEnvPath: p.workerEnvPath,
    say,
    sleep,
    now: () => Date.now(),
    cli(args) {
      const result = olympus(['archive', ...args], { timeoutMs: 120_000 });
      return { code: result.code, json: jsonFrom(result.stdout, result.stderr), stderr: result.stderr };
    },
    withBrowser: withArchiveBrowser,
    watchEgress: async (browserPid) => startEgressWatch(await relayAddresses(readConfig().relay), browserPid),
    search: archiveSearch,
    readStores: readArchiveStores,
    async restartEngine(timeoutMs) {
      const started = Date.now();
      const restart = olympus(['engine', 'restart'], { timeoutMs: 180_000 });
      if (restart.code !== 0) return { ok: false, ms: Date.now() - started, detail: `engine restart exited ${restart.code}: ${restart.stderr.slice(0, 200)}` };
      try {
        await waitForEngine(timeoutMs);
        return { ok: true, ms: Date.now() - started };
      } catch (error) {
        return { ok: false, ms: Date.now() - started, detail: error instanceof Error ? error.message : String(error) };
      }
    },
  };
}

const ROLES: readonly FixtureRole[] = ['agent', 'picker', 'held', 'bulk'];
const roleOf = (value: string): FixtureRole => {
  if (!(ROLES as readonly string[]).includes(value)) throw new Error(`--role must be one of ${ROLES.join(', ')} (got "${value}")`);
  return value as FixtureRole;
};

async function archiveImportCommand(args: { role: string; format: string; via: string; seed: string; resetFolder: boolean; clean: boolean; drainS?: number; search: boolean; watchEgress: boolean; settleS?: number }): Promise<never> {
  if (args.via !== 'request' && args.via !== 'picker') throw new Error(`--via must be request or picker (got "${args.via}")`);
  const observation = await importStage(archiveHost(), {
    role: roleOf(args.role), format: args.format, via: args.via, seed: args.seed,
    resetFolder: args.resetFolder, clean: args.clean, search: args.search, watchEgress: args.watchEgress,
    ...(args.drainS !== undefined ? { drainS: args.drainS } : {}),
    ...(args.settleS !== undefined ? { settleS: args.settleS } : {}),
  });
  emit({ ...observation });
}

async function archiveDrainCommand(args: { role: string; format: string; seed: string; search: boolean; boundS?: number }): Promise<never> {
  const observation = await drainStage(archiveHost(), {
    role: roleOf(args.role), format: args.format, seed: args.seed, os: platform().os, search: args.search,
    ...(args.boundS !== undefined ? { boundS: args.boundS } : {}),
  });
  emit({ ...observation });
}

async function archiveRemoveCommand(args: { targets: string; seed: string }): Promise<never> {
  const targets = args.targets.split(',').map((entry) => entry.trim()).filter(Boolean).map((entry) => {
    const [role = '', format = STRESS_FORMAT] = entry.split(':');
    const fx = legFixture(roleOf(role), args.seed, format);
    return { role: fx.role, format: fx.format, fileName: fx.fileName, token: fx.token };
  });
  emit({ ...(await removeStage(archiveHost(), { targets })) });
}

async function archiveModelCommand(mode: string): Promise<never> {
  if (mode !== 'off' && mode !== 'on') throw new Error(`--mode must be off or on (got "${mode}")`);
  emit({ ...(await modelStage(archiveHost(), mode)) });
}

async function archiveChangedCommand(seed: string, sizes: number[]): Promise<never> {
  emit({ ...(await changedStage(archiveHost(), { seed, sizes })) });
}

/** The last step of the leg, run whatever came before: every archive off the Archives line and the fixtures folder gone. */
async function archiveCleanupCommand(): Promise<never> {
  const host = archiveHost();
  const removed = await removeAllStage(host);
  // The files go only once no archive is listed: an import still on the page would otherwise lose its file and stop on it.
  if (removed.ok) rmSync(join(homedir(), FIXTURE_FOLDER), { recursive: true, force: true });
  emit({ ...removed });
}

/** The leg's pictures and traces in one archive for the harness to fetch. */
function archiveCollectCommand(): never {
  mkdirSync(ARCHIVE_OUT, { recursive: true });
  const archive = join(WORKDIR, 'archive.tgz');
  const packed = spawnSync('tar', ['-czf', archive, '-C', ARCHIVE_OUT, '.'], { encoding: 'utf8' });
  if (packed.status !== 0) emit({ ok: false, detail: `the archive files could not be packed: ${packed.stderr.slice(0, 160)}` });
  emit({ ok: true, archive });
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

// ---------------------------------------------------------------------------
// Upgrade leg: state before and after the installer runs over an existing install

/** Readwise's two stores (the second holds the Private items), where the engine keeps them. */
function readwiseStorePaths(): Array<{ store: string; path: string }> {
  return [
    { store: 'readwise-connector-store', path: defaultReadwiseConnectorStoreDbPath() },
    { store: 'readwise-secure-connector-store', path: defaultReadwiseSecureConnectorStoreDbPath() },
  ];
}

/** Stored items and the tier ledger's verdicts for them, read-only. Ids are the stand-in's synthetic ids; no content leaves. */
function readItems(): { items: ItemRow[] | null; error?: string } {
  const rows: ItemRow[] = [];
  try {
    for (const { store, path: itemsPath } of readwiseStorePaths()) {
      if (!existsSync(itemsPath)) continue;
      const db = new Database(itemsPath, { readonly: true });
      db.exec('PRAGMA busy_timeout = 10000;');
      let ledger = new Map<string, { metadataTier: string | null; contentTier: string | null }>();
      try {
        const ledgerPath = tierLedgerPathForStore(itemsPath);
        if (existsSync(ledgerPath)) {
          const ledgerDb = new Database(ledgerPath, { readonly: true });
          ledgerDb.exec('PRAGMA busy_timeout = 10000;');
          try {
            ledger = new Map((ledgerDb.query('select provider_item_id as id, metadata_tier as m, content_tier as c from tier_items').all() as Array<{ id: string; m: string | null; c: string | null }>).map((r) => [r.id, { metadataTier: r.m, contentTier: r.c }]));
          } finally { ledgerDb.close(); }
        }
        for (const row of db.query('select provider_item_id as id, trust_tier as tier, tombstoned, content_hash as contentHash from items order by provider_item_id').all() as Array<{ id: string; tier: string | null; tombstoned: number | null; contentHash: string | null }>) {
          const verdict = ledger.get(row.id);
          rows.push({ store, id: row.id, tier: row.tier, tombstoned: row.tombstoned, contentHash: row.contentHash, ...(verdict ?? {}) });
        }
      } finally { db.close(); }
    }
    return { items: rows };
  } catch (error) {
    return { items: null, error: error instanceof Error ? error.message.slice(0, 160) : String(error).slice(0, 160) };
  }
}

function jsonOf(result: CliResult): any {
  try { return JSON.parse(result.stdout); } catch { return undefined; }
}

async function snapshotState(): Promise<never> {
  const p = platform();
  const version = /\b(\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?)\b/.exec(olympus(['--version']).stdout)?.[1] ?? null;
  const status = jsonOf(olympus(['engine', 'status']));
  const connections = jsonOf(olympus(['connections', 'list']));
  const remote = jsonOf(olympus(['connections', 'status']));
  const rules = jsonOf(olympus(['tier', 'rules', 'list']));
  let dashboard: DashboardCounts | null = null;
  try {
    const dash = await dashboardJson();
    const snap = snapshot(dash.json);
    if (snap) dashboard = { seen: snap.seen, indexed: snap.indexed, contentReady: snap.contentReady, embedded: snap.embedded, secretsLocated: snap.secretsLocated, personal: snap.personal, privateItems: snap.privateItems };
  } catch { /* the engine may still be starting; the harness treats null as unreadable */ }
  const workerEnv = existsSync(p.workerEnvPath) ? readFileSync(p.workerEnvPath, 'utf8').split('\n').map((line) => line.split('=')[0]!.trim()).filter(Boolean).sort() : [];
  const found = readItems();
  const state: StateSnapshot = {
    version,
    build: status?.engine?.build ?? null,
    engineState: status?.engine?.state ?? null,
    installId: remote?.relay?.install_id ?? null,
    relayConnected: remote?.relay?.connected ?? null,
    policy: readPolicy(),
    configFiles: existsSync(p.configDir) ? readdirSync(p.configDir).sort() : [],
    dataFiles: existsSync(p.dataDir) ? readdirSync(p.dataDir).filter((name) => !/-(wal|shm|journal)$/.test(name)).sort() : [],
    workerEnvKeys: workerEnv,
    tierRuleIds: ((rules?.rules ?? []) as Array<{ id: string }>).map((rule) => rule.id).sort(),
    connections: ((connections?.connections ?? []) as Array<{ id: string }>).map((connection) => connection.id).sort(),
    items: found.items,
    ...(found.error ? { itemsError: found.error } : {}),
    dashboard,
  };
  emit({ ok: true, state });
}

/**
 * The owner changes one privacy setting before the upgrade, the way the privacy policy documents: a field of the
 * policy file the install seeded. Only the internal tier's cloud-query switch moves (a stricter, valid value), and the
 * file's bytes from before are kept beside the run's files so a self-test can put them back.
 */
async function setPolicySetting(): Promise<never> {
  const p = platform();
  if (!existsSync(p.sovereigntyPath)) emit({ ok: false, detail: 'no privacy policy file to change' });
  mkdirSync(WORKDIR, { recursive: true });
  copyFileSync(p.sovereigntyPath, join(WORKDIR, 'sovereignty.pre-upgrade.json'));
  const policy = JSON.parse(readFileSync(p.sovereigntyPath, 'utf8'));
  const internal = policy?.retrieval?.trustDomains?.internal;
  if (!internal) emit({ ok: false, detail: 'the policy has no internal tier to change' });
  internal.allowCloudQuery = false;
  writeFileSync(p.sovereigntyPath, `${JSON.stringify(policy, null, 2)}\n`, { mode: 0o600 });
  emit({ ok: true, changed: 'retrieval.trustDomains.internal.allowCloudQuery', value: false });
}

/** Waits until the engine reports ready (models included) again after the installer's restart. */
async function awaitEngine(timeoutS: number): Promise<never> {
  const readyMs = await waitForEngine(timeoutS * 1000);
  emit({ ok: true, readyMs });
}

/**
 * Self-tests of the upgrade leg: a fault is made to happen so the run must fail. `before-upgrade` modes run after the
 * baseline snapshot and before the installer (a rule the owner had is gone when the new version starts); `after-upgrade`
 * modes run once the engine is back (the policy migration did not apply).
 */
async function upgradeSelftest(mode: string): Promise<never> {
  const p = platform();
  if (mode === 'lose-tier-rules') {
    // Data loss across the upgrade: the owner's tier rules vanish.
    const rules = jsonOf(olympus(['tier', 'rules', 'list']));
    for (const rule of (rules?.rules ?? []) as Array<{ id: string }>) olympus(['tier', 'rules', 'remove', rule.id]);
    emit({ ok: true, mode });
  }
  if (mode === 'revert-policy') {
    // A migration that did not apply: the pre-upgrade policy bytes are back and the backups are gone.
    const before = join(WORKDIR, 'sovereignty.pre-upgrade.json');
    if (!existsSync(before)) emit({ ok: false, detail: 'no pre-upgrade policy copy to restore' });
    for (const name of readdirSync(p.configDir)) if (name.startsWith('sovereignty.json.backup-')) rmSync(join(p.configDir, name));
    copyFileSync(before, p.sovereigntyPath);
    emit({ ok: true, mode });
  }
  emit({ ok: false, detail: `unknown self-test mode ${mode}` });
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
  const version = /\b(\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?)\b/.exec(olympus(['--version']).stdout)?.[1] ?? null;
  emit({ ok: status.code === 0, build, version, remoteMode: remote, relay });
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
        token: flag('--token', config?.fakeToken ?? FAKE_READWISE_TOKEN),
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
    case 'inbox-check': return await inboxCheck(flag('--primary', ''), flag('--ids', '').split(',').map((id) => id.trim()).filter(Boolean), Number(flag('--wait-s', '600')), flag('--out'), process.argv.includes('--fault-entry-id'));
    case 'journeys': return await journeysCommand(flag('--out'), flag('--only', '').split(',').map((id) => id.trim()).filter(Boolean), process.argv.includes('--skip-screens'));
    case 'explore': return await exploreCommand(flag('--out'), flag('--inventory'), process.argv.includes('--pages-inventory') ? flag('--pages-inventory') : undefined);
    case 'archive-import': return await archiveImportCommand({
      role: flag('--role'), format: flag('--format', STRESS_FORMAT), via: flag('--via'), seed: flag('--seed'),
      resetFolder: rest.includes('--reset-folder'), clean: rest.includes('--clean'), search: rest.includes('--search'), watchEgress: rest.includes('--watch-egress'),
      ...(rest.includes('--drain-s') ? { drainS: Number(flag('--drain-s')) } : {}),
      ...(rest.includes('--settle-s') ? { settleS: Number(flag('--settle-s')) } : {}),
    });
    case 'archive-drain': return await archiveDrainCommand({
      role: flag('--role'), format: flag('--format', STRESS_FORMAT), seed: flag('--seed'), search: rest.includes('--search'),
      ...(rest.includes('--bound-s') ? { boundS: Number(flag('--bound-s')) } : {}),
    });
    case 'archive-remove': return await archiveRemoveCommand({ targets: flag('--targets'), seed: flag('--seed') });
    case 'archive-model': return await archiveModelCommand(flag('--mode'));
    case 'archive-changed': return await archiveChangedCommand(flag('--seed'), flag('--sizes').split(',').map((n) => Number(n)).filter((n) => Number.isFinite(n) && n > 0));
    case 'archive-cleanup': return await archiveCleanupCommand();
    case 'archive-collect': return archiveCollectCommand();
    case 'collect-logs': return collectLogs(flag('--out'));
    case 'engine-build': return await engineBuild();
    case 'snapshot-state': return await snapshotState();
    case 'set-policy-setting': return await setPolicySetting();
    case 'await-engine': return await awaitEngine(Number(flag('--timeout-s', '300')));
    case 'upgrade-selftest': return await upgradeSelftest(flag('--mode'));
    default:
      console.error('usage: agent <prepare-source|connect-source|sync|settle|mcp-token|mcp-tools|mcp-call|mcp-rpc|smoke|dashboard-json|screenshots|inbox-check|journeys|explore|archive-import|archive-drain|archive-remove|archive-model|archive-changed|archive-cleanup|archive-collect|collect-logs|engine-build|snapshot-state|set-policy-setting|await-engine|upgrade-selftest>');
      process.exit(2);
  }
}

if (import.meta.main || process.argv[1]?.endsWith('agent.js')) {
  main().catch((error) => {
    console.log(JSON.stringify({ ok: false, detail: error instanceof Error ? error.message : String(error) }));
    process.exit(1);
  });
}

