// Tranche Z1 of the frontier-consult design: the experimental zkAPI consult
// transport, proven against stand-in executables. A fake `tor` binds the SOCKS
// port and reports bootstrap; a fake `zkapi-clientd` answers `--version` and
// `serve` the way the real daemon's loopback API and foreground log do
// (`internal/server/logging.go` request lines included). No real daemon, no Tor
// network, no funds, and no binary beyond Bun itself (plus the base-system
// sandbox on macOS for the one confinement test).
//
// Hermetic: every test runs with HOME, the sovereignty config variables and
// the zkapi-clientd config variables pointed at a fresh temp directory.

import { afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { execFileSync, spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { defaultConfig } from '../src/core/config.ts';
import type { EvidencePack } from '../src/core/contracts.ts';
import {
  daemonEnvironment,
  formatZkapiStageTable,
  inspectLoopbackListener,
  openZkapiConsultSession,
  recoverZkapiSession,
  reserveZkapiRequest,
  resolveExecutable,
  sendZkapiConsult,
  standardExecutableDirectories,
  trustedFallbackExecutable,
  type ExecutableTrustProbe,
  zkapiConsultReadiness,
  abandonZkapiFence,
  zkapiFenceScope,
  zkapiOutstandingFences,
  zkapiUnresolvedSession,
  zkapiUsageToday,
  type ZkapiConfinement,
  type ZkapiConsultReply,
  type ZkapiConsultResult,
  type ZkapiConsultSession,
  type ZkapiConsultTransportOptions,
} from '../src/core/consult-transport-zkapi.ts';
import { DelphiClient, DirectHttpDelphiTransport } from '../src/core/delphi.ts';
import { fetchModelEndpoint } from '../src/core/model-transport.ts';
import { ModelSetupService } from '../src/core/model-setup.ts';
import { connectGeminiApiKey } from '../src/core/connect.ts';
import { runDoctor, type DoctorCheck, type DoctorDeps } from '../src/core/doctor.ts';
import { processInstanceIdentity } from '../src/core/file-lease.ts';
import { OperationError } from '../src/core/operation-error.ts';
import { createSovereigntyEngine, loadSovereigntyPreset, type SovereigntyConfig } from '../src/core/sovereignty.ts';
import {
  assertNotZkapiDaemonEndpoint,
  assertNotZkapiDaemonEndpointResolved,
  parseZkapiConsultSettings,
  ZKAPI_RISK_ACKNOWLEDGEMENTS,
  ZKAPI_RISK_ACKNOWLEDGEMENTS_VERSION,
  type ZkapiConsultSettings,
} from '../src/core/zkapi-consult-settings.ts';
import { assertSnifferProfileAllowed, resolveSnifferLane } from '../src/workers/classification/sniffer-lane.ts';
import { applyModelChoice } from '../src/workers/chatgpt/model-choice.ts';
import { requireLocalHttpBaseUrl } from '../src/workers/file-extraction/extractors/remote-vlm.ts';
import { OpenAICompatibleVlmClient } from '../src/workers/file-extraction/extractors/openai-compatible-client.ts';
import { OpenAICompatibleSourceEmbeddingProvider } from '../src/workers/source-index/embeddings.ts';

const QUESTION = 'What is the usual notice period rule for ending a residential lease, across common durations?';
const API_KEY = 'k'.repeat(40);
const MODEL = 'openai/gpt-6-astra';
const NOW = new Date('2026-10-05T12:00:00.000Z');
const SLOW = 40_000;

// ---------------------------------------------------------------------------
// Stand-in executables

const FAKE_TOR = `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
const value = (flag) => args[args.indexOf(flag) + 1];
const dir = process.env.ZKAPI_CLIENTD_CONFIG_DIR;
const plan = JSON.parse(fs.readFileSync(dir + '/plan.json', 'utf8'));
const dataDir = value('--DataDirectory');
const mode = (fs.statSync(dataDir).mode & 0o777).toString(8);
fs.appendFileSync(dir + '/tor-runs.log', dataDir + ' ' + mode + ' ' + value('--__OwningControllerProcess') + '\\n');
const port = Number(value('--SocksPort').split(':')[1]);
Bun.listen({ hostname: '127.0.0.1', port, socket: { open(s) { s.end(); }, data() {} } });
if (!plan.torNeverBootstraps) console.log('Oct 05 12:00:00.000 [notice] Bootstrapped 100% (done): Done');
if (plan.torDiesAfterMs) setTimeout(() => process.exit(1), plan.torDiesAfterMs);
setInterval(() => { if (fs.existsSync(dir + '/kill-tor')) process.exit(1); }, 50);
setInterval(() => {}, 1 << 30);
`;

const FAKE_DAEMON = `#!${process.execPath}
const fs = require('node:fs');
const net = require('node:net');
const dgram = require('node:dgram');
const { spawn } = require('node:child_process');
const dir = process.env.ZKAPI_CLIENTD_CONFIG_DIR;
const planPath = dir + '/plan.json';
const plan = fs.existsSync(planPath) ? JSON.parse(fs.readFileSync(planPath, 'utf8')) : { version: '0.1.6' };
if (process.argv[2] === '--version') { console.log('zkapi-clientd ' + plan.version); process.exit(0); }
if (process.argv[2] !== 'serve') process.exit(2);
const log = (line) => console.log('zkapi-clientd 2026/10/05 12:00:00 ' + line);
const event = (line) => fs.appendFileSync(dir + '/events.log', line + '\\n');
const relayUp = () => new Promise((resolve) => {
  if (!plan.relayPort) return resolve(true);
  const s = net.createConnection({ host: '127.0.0.1', port: plan.relayPort });
  s.once('connect', () => { s.destroy(); resolve(true); });
  s.once('error', () => resolve(false));
});
const tryTcp = (host, port) => new Promise((resolve) => {
  const started = Date.now();
  const s = net.createConnection({ host, port });
  s.setTimeout(2000, () => { s.destroy(); resolve('timeout'); });
  s.once('connect', () => { s.destroy(); resolve('connected'); });
  s.once('error', () => resolve(Date.now() - started < 1000 ? 'refused_fast' : 'error_slow'));
});
const tryUdp = () => new Promise((resolve) => { const s = dgram.createSocket('udp4'); s.send(Buffer.from([0]), 53, '192.0.2.1', (e) => { s.close(); resolve(e ? 'denied' : 'sent'); }); });
const tryResolver = () => new Promise((resolve) => { const s = net.createConnection({ path: '/private/var/run/mDNSResponder' }); s.once('connect', () => { s.destroy(); resolve('connected'); }); s.once('error', () => resolve('denied')); });
const json = (status, body, headers = {}) => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...headers } });
const err = (status, code, message = 'fixed daemon text') => json(status, { error: { message, type: code, code, param: null } }, status === 401 ? { 'WWW-Authenticate': 'Bearer' } : {});
let key = 0;
let request = 0;
(async () => {
  if (!(await relayUp())) { log('ERROR configuration check failed'); process.exit(1); }
  if (plan.egressProbe) {
    const result = { direct: await tryTcp('192.0.2.1', 9), udp: await tryUdp(), resolver: await tryResolver(), loopbackOther: await tryTcp('127.0.0.1', plan.egressProbe) };
    event('egress ' + JSON.stringify(result));
  }
  if (plan.companion) {
    // A companion that ignores SIGTERM, as a stuck wallet helper might.
    const companion = spawn(process.execPath, ['-e', "process.on('SIGTERM', () => {}); setInterval(() => {}, 1 << 30)"], { stdio: 'ignore' });
    event('companion ' + companion.pid);
  }
  if (plan.startDelayMs) await Bun.sleep(plan.startDelayMs);
  event('serve ' + process.pid);
  Bun.serve({ hostname: '127.0.0.1', port: plan.port, async fetch(httpRequest) {
    const url = new URL(httpRequest.url);
    if (url.pathname === '/healthz') return json(200, '{"status":"ok"}');
    const keyless = !plan.requireKey && (url.pathname === '/v1/models' || url.pathname === '/v1/chat/completions');
    if (!keyless && httpRequest.headers.get('authorization') !== 'Bearer ' + plan.apiKey) return err(401, 'invalid_api_key', 'A valid local zkAPI client API key is required.');
    if (url.pathname === '/admin/status') return json(200, { backend: 'zkapi', network: 'mainnet', request_budget_policy: 'model' });
    if (url.pathname === '/v1/models' && httpRequest.method !== 'GET') return err(405, 'method_not_allowed');
    if (url.pathname === '/v1/models') {
      if (plan.policyNeverLoads) return err(502, 'models_unavailable');
      const up = plan.bypassTor || (await relayUp());
      if (!up) return plan.postStopShape === 'unauthorized' ? err(401, 'invalid_api_key') : err(502, 'models_unavailable');
      return json(200, { object: 'list', data: [{ id: 'other/model', oa_request_limit_micro_usd: 1000000 }, ...(plan.modelMissing ? [] : [{ id: '${MODEL}', oa_request_limit_micro_usd: plan.allowance ?? 1000000 }])] });
    }
    if (url.pathname === '/v1/chat/completions' && httpRequest.method === 'POST') {
      request += 1;
      const id = request;
      log('request started method=POST route=/v1/chat/completions request=' + id);
      const finish = (response) => { log('request completed method=POST route=/v1/chat/completions status=' + response.status + ' duration=1ms request=' + id); if (plan.crashAfterCompletion) setTimeout(() => process.exit(1), 50); return response; };
      const body = await httpRequest.text();
      const state = plan.statePath && fs.existsSync(plan.statePath) ? JSON.parse(fs.readFileSync(plan.statePath, 'utf8')) : {};
      event('completion ' + JSON.stringify({ body, auth: httpRequest.headers.get('authorization'), origin: httpRequest.headers.get('origin'), countAtArrival: state.count ?? 0, fenceAtArrival: Object.keys(state.fences ?? {}).length > 0 }));
      const completion = (content) => json(200, { object: 'chat.completion', choices: [{ index: 0, message: { role: 'assistant', content } }] }, { 'X-OA-Verification-Status': 'verified' });
      if (plan.completion === 'error') return finish(err(400, 'model_budget_unavailable', 'echo: ' + body + ' ?secret=1'));
      key += 1;
      const ref = key;
      if (!plan.noKeyLog) log('request key selected request=' + id + ' key_ref=' + ref + ' source=' + (plan.reusedKey ? 'reused' : 'fresh'));
      if (!plan.noSettlement) setTimeout(() => {
        log('automatic settlement result key_ref=' + ref + ' ready=true duration=30ms');
        log('zkAPI OpenRouter key session ' + ref + ' ended (settled); cost: 0.000123 ETH; balance remaining: 0.004567 ETH');
        if (plan.crashAfterSettlement) process.exit(1);
      }, plan.settleDelayMs ?? 30);
      switch (plan.completion) {
        case 'redirect': return finish(new Response(null, { status: 307, headers: { Location: '/v1/elsewhere' } }));
        case 'oversize': return finish(completion('x'.repeat(200000)));
        case 'garbage': return finish(new Response('<html>' + body + '</html>', { status: 502 }));
        case 'empty': return finish(completion('   '));
        case 'slow': await Bun.sleep(1500); return finish(completion('late'));
        case 'held': while (!fs.existsSync(dir + '/release')) await Bun.sleep(20); return finish(completion('held'));
        default: return finish(completion('Generally, notice scales with term length.'));
      }
    }
    if (url.pathname === '/v1/elsewhere') event('followed redirect');
    return err(404, 'not_found');
  } });
  log('zkAPI client ' + plan.version + ' listening at http://127.0.0.1:' + plan.port + '/v1 (zkapi); ' + (plan.relayPort ? 'SOCKS5 proxy required' : 'direct HTTPS (network proxy off)'));
  log('zkAPI network: mainnet');
  log(plan.requireKey ? 'Use zkapi-clientd config --api-key to configure your client; Ctrl+C stops the service' : 'Localhost inference needs no API key; Ctrl+C stops the service');
  log(plan.reuse > 0 ? 'Ephemeral key reuse enabled for up to ' + plan.reuse + ' seconds: different chats and local clients can share a key and spending cap.' : 'Ephemeral key isolation: fresh OpenRouter key for every completion, including background UI requests');
})();
`;

let binDir: string;

beforeAll(() => {
  binDir = mkdtempSync(join(tmpdir(), 'olympus-zkapi-bin-'));
  writeFileSync(join(binDir, 'tor'), FAKE_TOR);
  writeFileSync(join(binDir, 'zkapi-clientd'), FAKE_DAEMON);
  chmodSync(join(binDir, 'tor'), 0o755);
  chmodSync(join(binDir, 'zkapi-clientd'), 0o755);
  process.on('exit', () => rmSync(binDir, { recursive: true, force: true }));
});

/**
 * Distinct free ports. Every listener stays bound until all are chosen: two
 * separate picks can return the same port once the first is released, and a
 * daemon sharing Tor's port dies on its own listen.
 */
function freePorts(count: number): number[] {
  const listeners = Array.from({ length: count }, () => Bun.listen({ hostname: '127.0.0.1', port: 0, socket: { data() {} } }));
  const ports = listeners.map((listener) => listener.port);
  for (const listener of listeners) listener.stop(true);
  return ports;
}

function freePort(): number {
  return freePorts(1)[0]!;
}

interface Plan {
  port: number;
  relayPort: number | null;
  apiKey: string;
  version: string;
  requireKey: boolean;
  reuse: number;
  statePath: string;
  completion?: string;
  bypassTor?: boolean;
  postStopShape?: 'unauthorized';
  reusedKey?: boolean;
  noKeyLog?: boolean;
  noSettlement?: boolean;
  settleDelayMs?: number;
  torNeverBootstraps?: boolean;
  torDiesAfterMs?: number;
  startDelayMs?: number;
  policyNeverLoads?: boolean;
  modelMissing?: boolean;
  allowance?: number;
  companion?: boolean;
  crashAfterCompletion?: boolean;
  crashAfterSettlement?: boolean;
  egressProbe?: number;
}

/** A confinement that filters loopback ports: no shipped platform provides one. */
const filteredConfinement: ZkapiConfinement = {
  level: 'loopback_filtered',
  limit: 'test confinement',
  wrap: (argv) => [...argv],
  selfTest: async () => true,
};
const noConfinement: ZkapiConfinement = {
  level: 'none',
  limit: 'no network confinement is implemented on this platform',
  wrap: (argv) => [...argv],
  selfTest: async () => false,
};

let root: string;
let configDir: string;
let statePath: string;
let daemonPort: number;
let torPort: number;
let plan: Plan;
const HERMETIC_ENV_KEYS = ['HOME', 'OLYMPUS_SOVEREIGNTY_CONFIG', 'OLYMPUS_SOVEREIGNTY_CONFIG_PATH', 'ZKAPI_CLIENTD_CONFIG_DIR', 'XDG_CONFIG_HOME'];
let savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'olympus-zkapi-'));
  savedEnv = Object.fromEntries(HERMETIC_ENV_KEYS.map((key) => [key, process.env[key]]));
  for (const key of HERMETIC_ENV_KEYS) delete process.env[key];
  process.env.HOME = root;
  configDir = join(root, 'zkapi-config');
  mkdirSync(configDir);
  statePath = join(root, 'zkapi-consult-state.json');
  [daemonPort, torPort] = freePorts(2) as [number, number];
  plan = { port: daemonPort, relayPort: torPort, apiKey: API_KEY, version: '0.1.6', requireKey: true, reuse: 0, statePath };
  writePlan();
});

afterEach(() => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(root, { recursive: true, force: true });
});

function writePlan(overrides: Partial<Plan> = {}): void {
  plan = { ...plan, ...overrides };
  writeFileSync(join(configDir, 'plan.json'), JSON.stringify(plan));
}

function readLines(name: string): string[] {
  const path = join(configDir, name);
  return existsSync(path) ? readFileSync(path, 'utf8').trim().split('\n').filter(Boolean) : [];
}

const events = (): string[] => readLines('events.log');
const torRuns = (): string[] => readLines('tor-runs.log');

function completions(): Array<{ body: string; auth: string; origin: string | null; countAtArrival: number; fenceAtArrival: boolean }> {
  return events().filter((line) => line.startsWith('completion ')).map((line) => JSON.parse(line.slice('completion '.length)));
}

function settings(overrides: Partial<ZkapiConsultSettings> = {}): ZkapiConsultSettings {
  return {
    ...parseZkapiConsultSettings({
      fundingDate: '2026-09-30',
      acknowledgements: {
        version: ZKAPI_RISK_ACKNOWLEDGEMENTS_VERSION,
        accepted: ZKAPI_RISK_ACKNOWLEDGEMENTS.map((item) => item.id),
      },
    }, 'test'),
    torSocksPort: torPort,
    daemonExecutable: join(binDir, 'zkapi-clientd'),
    torExecutable: join(binDir, 'tor'),
    timeoutMs: 5_000,
    torBootstrapTimeoutMs: 5_000,
    daemonReadyTimeoutMs: 8_000,
    policyWarmTimeoutMs: 3_000,
    settleTimeoutMs: 3_000,
    maxResponseBytes: 64 * 1024,
    ...overrides,
  };
}

function transport(overrides: Partial<ZkapiConsultTransportOptions> = {}): ZkapiConsultTransportOptions {
  return {
    baseUrl: `http://127.0.0.1:${daemonPort}/v1`,
    model: MODEL,
    apiKey: API_KEY,
    settings: settings(),
    statePath,
    env: { HOME: root, PATH: '/usr/bin:/bin', ZKAPI_CLIENTD_CONFIG_DIR: configDir },
    confinement: noConfinement,
    now: () => NOW,
    ...overrides,
  };
}

async function portFree(port: number): Promise<boolean> {
  try {
    const socket = await Bun.connect({ hostname: '127.0.0.1', port, socket: { data() {} } });
    socket.end();
    return false;
  } catch {
    return true;
  }
}

const TRANSPORT_MODULE = join(import.meta.dir, '..', 'src', 'core', 'consult-transport-zkapi.ts');

/** Runs one consult in a separate Bun process over the same ledger, without confinement. */
function startConsultInChildProcess(options: ZkapiConsultTransportOptions) {
  const { now: _now, confinement: _confinement, ...plain } = options;
  const script = `
    const { sendZkapiConsult } = await import(${JSON.stringify(TRANSPORT_MODULE)});
    const options = JSON.parse(process.argv[1]);
    options.now = () => new Date(${JSON.stringify(NOW.toISOString())});
    options.confinement = { level: 'none', limit: 'none', wrap: (argv) => [...argv], selfTest: async () => false };
    const result = await sendZkapiConsult(${JSON.stringify(QUESTION)}, options);
    console.log(JSON.stringify(result.ok ? { ok: true } : { ok: false, code: result.error.code }));
    process.exit(0);
  `;
  return spawn(process.execPath, ['-e', script, JSON.stringify(plain)], { stdio: ['ignore', 'pipe', 'ignore'] });
}

async function runConsultInChildProcess(options: ZkapiConsultTransportOptions): Promise<unknown> {
  const child = startConsultInChildProcess(options);
  let out = '';
  child.stdout!.on('data', (chunk) => { out += String(chunk); });
  await new Promise((resolve) => child.on('exit', resolve));
  return JSON.parse(out.trim().split('\n').at(-1)!);
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

const NO_CONFINEMENT_LABEL = 'payment privacy; a fresh Tor client was started and the daemon reports SOCKS5 mode, but the actual route is not verified; no network confinement';

/** What each mocked operation advances virtual time by; distinct so a misplaced one shows. */
const OP = { selfTest: 1, now: 2, healthz: 3, inspect: 5, unauthenticatedProbe: 7, adminStatus: 11, models: 13, dispatch: 17, body: 19 } as const;

/**
 * Virtual time for stage timings. Mocked operations advance it by their own
 * amount; read k of the clock returns the current time, then advances it by
 * k x 1000. A stage opened at read k and closed at read k + 1 therefore lasts
 * k x 1000 plus the operations that ran inside it.
 */
function virtualTime() {
  let time = 0;
  let reads = 0;
  const values: number[] = [];
  return {
    values,
    advance: (ms: number): void => {
      time += ms;
    },
    clock: (): number => {
      reads += 1;
      const value = time;
      values.push(value);
      time += reads * 1000;
      return value;
    },
  };
}

function timedTransport(time: ReturnType<typeof virtualTime>, overrides: Partial<ZkapiConsultTransportOptions> = {}): ZkapiConsultTransportOptions {
  const inspect = overrides.inspectListener ?? inspectLoopbackListener;
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.pathname === '/v1/chat/completions') {
      let response: Response;
      try {
        response = await fetch(input, init);
      } finally {
        time.advance(OP.dispatch);
      }
      const bytes = new Uint8Array(await response.arrayBuffer());
      return new Response(new ReadableStream({
        pull(controller) {
          time.advance(OP.body);
          controller.enqueue(bytes);
          controller.close();
        },
        // No eager pull: the body is read only when the transport reads it.
      }, { highWaterMark: 0 }), { status: response.status, headers: response.headers });
    }
    const op = url.pathname === '/healthz'
      ? OP.healthz
      : url.pathname === '/admin/status'
        ? OP.adminStatus
        : url.pathname === '/v1/models'
          ? (init?.method === 'POST' ? OP.unauthenticatedProbe : OP.models)
          : 0;
    try {
      return await fetch(input, init);
    } finally {
      time.advance(op);
    }
  }) as typeof fetch;
  return transport({
    clock: time.clock,
    now: () => {
      time.advance(OP.now);
      return NOW;
    },
    confinement: { ...noConfinement, selfTest: async () => { time.advance(OP.selfTest); return false; } },
    fetchImpl,
    ...overrides,
    inspectListener: async (port) => {
      time.advance(OP.inspect);
      return inspect(port);
    },
  });
}

// ---------------------------------------------------------------------------
// Sessions and labels

describe('zkAPI consult transport: a supervised session', () => {
  test('fresh Tor, verified daemon, fixed body, correlated settlement, fence cleared, everything stopped', async () => {
    const result = await sendZkapiConsult(QUESTION, transport());
    expect(result).toMatchObject({
      ok: true,
      text: 'Generally, notice scales with term length.',
      networkIdentity: 'not_verified',
      routeLabel: NO_CONFINEMENT_LABEL,
      providerVerification: 'verified',
      receipt: {
        recovery: false,
        keyReuse: 'verified_off',
        inferenceAuth: 'verified',
        tor: 'per_consult',
        freshTorClient: true,
        confinement: 'none',
        postStopProbe: 'route_lost',
        settlement: 'confirmed',
        fence: 'clear',
        daemonVersion: '0.1.6',
        network: 'mainnet',
        listedAllowanceUsd: 1,
        reservedUsd: 1,
      },
    });
    const sent = completions();
    expect(sent).toHaveLength(1);
    expect(JSON.parse(sent[0]!.body)).toEqual({ model: MODEL, messages: [{ role: 'user', content: QUESTION }], stream: false });
    expect(sent[0]!.auth).toBe(`Bearer ${API_KEY}`);
    expect(sent[0]!.origin).toBeNull();
    // Reserved, and fenced, before the daemon saw the request.
    expect(sent[0]!.countAtArrival).toBe(1);
    expect(sent[0]!.fenceAtArrival).toBe(true);
    const [dataDir, mode, owner] = torRuns()[0]!.split(' ');
    expect(mode).toBe('700');
    expect(owner).toBe(String(process.pid));
    expect(existsSync(dataDir!)).toBe(false);
    expect(await portFree(daemonPort)).toBe(true);
    expect(await portFree(torPort)).toBe(true);
    const ledger = readFileSync(statePath, 'utf8');
    expect(JSON.parse(ledger)).toMatchObject({ day: '2026-10-05', count: 1, reservedMicroUsd: 1_000_000, lastSession: { result: 'ok' } });
    for (const forbidden of ['notice period', 'balance', 'cost', API_KEY]) expect(ledger).not.toContain(forbidden);
    expect(JSON.parse(ledger).running).toBeUndefined();
    expect(JSON.parse(ledger).fence).toBeUndefined();
  }, SLOW);

  test('the strong label needs loopback-filtered confinement that passed its self-test', async () => {
    expect(await sendZkapiConsult(QUESTION, transport({ confinement: filteredConfinement }))).toMatchObject({
      ok: true,
      networkIdentity: 'hidden',
      routeLabel: 'anonymous route (payment, key and network identity hidden)',
      receipt: { confinement: 'loopback_filtered', confinementSelfTest: 'passed' },
    });
    // Confinement that was requested but cannot prove itself refuses the session.
    const failingSelfTest: ZkapiConfinement = { ...filteredConfinement, selfTest: async () => false };
    expect(await sendZkapiConsult(QUESTION, transport({ confinement: failingSelfTest }))).toMatchObject({
      ok: false,
      error: { code: 'confinement_self_test_failed', outcome: 'not_sent', receipt: { confinementSelfTest: 'failed' } },
    });
    expect(completions()).toHaveLength(1);
  }, SLOW);

  test('every consult gets a brand-new Tor client', async () => {
    expect(await sendZkapiConsult(QUESTION, transport())).toMatchObject({ ok: true });
    expect(await sendZkapiConsult(QUESTION, transport())).toMatchObject({ ok: true });
    const dirs = torRuns().map((run) => run.split(' ')[0]);
    expect(dirs).toHaveLength(2);
    expect(dirs[0]).not.toBe(dirs[1]);
  }, SLOW);

  test('without Tor the mode is named payment privacy only', async () => {
    writePlan({ relayPort: null });
    expect(await sendZkapiConsult(QUESTION, transport({ settings: settings({ tor: 'off' }) }))).toMatchObject({
      ok: true,
      networkIdentity: 'visible',
      routeLabel: 'payment privacy only (network address visible)',
      receipt: { tor: 'off', freshTorClient: false },
    });
    expect(torRuns()).toEqual([]);
  }, SLOW);

  test('the post-stop probe is secondary: a bypass is visible, a 401 is never proof', async () => {
    writePlan({ bypassTor: true });
    expect(await sendZkapiConsult(QUESTION, transport({ confinement: filteredConfinement }))).toMatchObject({
      ok: true,
      networkIdentity: 'visible',
      routeLabel: 'payment privacy only: the daemon still reached the network after Tor stopped (Tor bypass observed)',
      receipt: { postStopProbe: 'still_reachable' },
    });
    writePlan({ bypassTor: false, postStopShape: 'unauthorized' });
    const inconclusive = await sendZkapiConsult(QUESTION, transport());
    expect(inconclusive).toMatchObject({ ok: true, routeLabel: NO_CONFINEMENT_LABEL, receipt: { postStopProbe: 'inconclusive' } });
  }, SLOW);

  test('a reused key in the daemon log withdraws the key-isolation claim', async () => {
    writePlan({ reusedKey: true });
    expect(await sendZkapiConsult(QUESTION, transport({ confinement: filteredConfinement }))).toMatchObject({
      ok: true,
      routeLabel: 'not anonymous: key isolation or local authentication not confirmed',
      receipt: { keyReuse: 'not_verified' },
    });
  }, SLOW);

  test('a value that is not a plain question string cannot be sent', async () => {
    const pack = { question: QUESTION } as unknown as EvidencePack;
    // @ts-expect-error an EvidencePack is not a consult question
    expect(await sendZkapiConsult(pack, transport())).toMatchObject({ ok: false, error: { code: 'invalid_question', outcome: 'not_sent' } });
    for (const bad of ['', '   ', 'a\u0000b', 'x'.repeat(9000)]) {
      expect(await sendZkapiConsult(bad, transport())).toMatchObject({ ok: false, error: { code: 'invalid_question' } });
    }
    expect(torRuns()).toEqual([]);
  });
});

describe('zkAPI consult transport: stage timings', () => {
  // Virtual time (see `virtualTime`): each stage reads as
  // (its opening read's position x 1000) + (the mocked operations inside it),
  // so a stage attributed to the wrong key, or a boundary moved across an
  // operation or a read, changes the number. The ready boundary (policy warm
  // closed, question awaited) is read 8; the reservation opens at read 9.
  const SUCCESS = {
    leaseAcquireMs: 1000,
    confinementSelfTestMs: 3000 + OP.selfTest,
    torBootstrapMs: 4000 + OP.now,
    daemonReadyMs: 5000 + OP.now + OP.healthz,
    daemonVerifyMs: 6000 + 4 * OP.inspect + OP.unauthenticatedProbe + OP.adminStatus,
    policyWarmMs: 7000 + 2 * OP.inspect + OP.models,
    reservationMs: 9000 + OP.now + 2 * OP.inspect,
    dispatchToFirstByteMs: 10000 + OP.dispatch,
    firstByteToCompletionMs: 11000 + OP.body,
  };
  /** Warm total ends at the ready read (8); the reply is handed over at the read that closes the body (12). */
  const warmAndReply = (time: ReturnType<typeof virtualTime>) => ({
    warmTotalMs: time.values[7]! - time.values[0]!,
    replyHandedOverAtMs: time.values[11]! - time.values[0]!,
  });

  test('a successful session records every stage, in the receipt and the ledger', async () => {
    const time = virtualTime();
    const result = await sendZkapiConsult(QUESTION, timedTransport(time));
    const expected = {
      ...SUCCESS,
      ...warmAndReply(time),
      correlationWaitMs: 13000,
      settlementWaitMs: 14000,
      torStopMs: 16000,
      postStopProbeMs: 18000 + OP.models,
      teardownMs: 20000,
      totalMs: time.values.at(-1)! - time.values[0]!,
    };
    expect(time.values).toHaveLength(22);
    expect(result).toMatchObject({ ok: true, receipt: { settlement: 'confirmed', fence: 'clear', postStopProbe: 'route_lost' } });
    expect(result.ok && result.receipt.stageMs).toEqual(expected);
    expect(JSON.parse(readFileSync(statePath, 'utf8')).lastSession.stageMs).toEqual(expected);
  }, SLOW);

  test('a failure before dispatch records only the stages it reached', async () => {
    writePlan({ modelMissing: true });
    const time = virtualTime();
    const result = await sendZkapiConsult(QUESTION, timedTransport(time));
    expect(result).toMatchObject({ ok: false, error: { code: 'model_unavailable', outcome: 'not_sent' } });
    const expected = {
      leaseAcquireMs: SUCCESS.leaseAcquireMs,
      confinementSelfTestMs: SUCCESS.confinementSelfTestMs,
      torBootstrapMs: SUCCESS.torBootstrapMs,
      daemonReadyMs: SUCCESS.daemonReadyMs,
      daemonVerifyMs: SUCCESS.daemonVerifyMs,
      policyWarmMs: SUCCESS.policyWarmMs,
      teardownMs: 8000,
      totalMs: time.values.at(-1)! - time.values[0]!,
    };
    expect(!result.ok && result.error.receipt?.stageMs).toEqual(expected);
    expect(JSON.parse(readFileSync(statePath, 'utf8')).lastSession.stageMs).toEqual(expected);
  }, SLOW);

  test('a refusal before any process starts records the lease and the total', async () => {
    const time = virtualTime();
    const partial = settings({ acknowledgements: { version: ZKAPI_RISK_ACKNOWLEDGEMENTS_VERSION, accepted: [] } });
    const result = await sendZkapiConsult(QUESTION, timedTransport(time, { settings: partial }));
    expect(result).toMatchObject({ ok: false, error: { code: 'acknowledgements_incomplete' } });
    // The owner-settings check reads `now` once between the lease and the total.
    expect(!result.ok && result.error.receipt?.stageMs).toEqual({ leaseAcquireMs: 1000, totalMs: 3000 + OP.now });
  });

  test('a failure after dispatch times the wait until it failed and every later stage', async () => {
    writePlan({ completion: 'slow' });
    const time = virtualTime();
    const result = await sendZkapiConsult(QUESTION, timedTransport(time, { settings: settings({ timeoutMs: 300 }) }));
    expect(result).toMatchObject({ ok: false, error: { code: 'timeout', outcome: 'unknown', receipt: { settlement: 'confirmed' } } });
    // No response headers arrived, so first byte to completion is absent, and
    // no reply was handed over.
    const { firstByteToCompletionMs: _absent, ...beforeDispatch } = SUCCESS;
    const expected = {
      ...beforeDispatch,
      warmTotalMs: time.values[7]! - time.values[0]!,
      correlationWaitMs: 11000,
      settlementWaitMs: 12000,
      torStopMs: 14000,
      postStopProbeMs: 16000 + OP.models,
      teardownMs: 18000,
      totalMs: time.values.at(-1)! - time.values[0]!,
    };
    expect(!result.ok && result.error.receipt?.stageMs).toEqual(expected);
    expect(JSON.parse(readFileSync(statePath, 'utf8')).lastSession).toMatchObject({ result: 'timeout', stageMs: expected });
  }, SLOW);

  test('no post-stop probe timing when the probe never runs', async () => {
    // Once Tor has stopped, the daemon's port is no longer attributable, so
    // the probe is skipped.
    const time = virtualTime();
    const result = await sendZkapiConsult(QUESTION, timedTransport(time, {
      inspectListener: async (port) => (port === daemonPort && await portFree(torPort) ? { kind: 'not_visible' } : inspectLoopbackListener(port)),
    }));
    expect(result).toMatchObject({ ok: true, receipt: { postStopProbe: 'inconclusive' } });
    const stageMs = result.ok ? result.receipt.stageMs! : {};
    expect(stageMs.torStopMs).toBe(16000);
    expect(stageMs).not.toHaveProperty('postStopProbeMs');
    expect(stageMs.teardownMs).toBe(18000);
  }, SLOW);

  test('a throwing or non-finite clock changes nothing but the timings', async () => {
    for (const clock of [() => { throw new Error('clock exploded'); }, () => Number.NaN]) {
      const result = await sendZkapiConsult(QUESTION, transport({ clock }));
      expect(result).toMatchObject({ ok: true, receipt: { settlement: 'confirmed', fence: 'clear', postStopProbe: 'route_lost' } });
      expect(result.ok && result.receipt).not.toHaveProperty('stageMs');
      const ledger = JSON.parse(readFileSync(statePath, 'utf8'));
      expect(ledger.lastSession).toMatchObject({ result: 'ok', fence: 'clear' });
      expect(ledger.lastSession).not.toHaveProperty('stageMs');
      expect(ledger.running).toBeUndefined();
      expect(ledger.fences).toBeUndefined();
      expect(await portFree(daemonPort)).toBe(true);
      expect(await portFree(torPort)).toBe(true);
    }
    // The in-flight flag was released: the next session runs, not `busy`.
    expect(await sendZkapiConsult(QUESTION, transport())).toMatchObject({ ok: true });
    expect(zkapiUsageToday(statePath, NOW).count).toBe(3);
  }, 90_000);

  test('a session lease that is busy or cannot be taken still reports lease and total timings', async () => {
    const holder = spawn(process.execPath, [
      '-e',
      `const { withFileLease } = await import(${JSON.stringify(join(import.meta.dir, '..', 'src', 'core', 'file-lease.ts'))});
       await withFileLease(${JSON.stringify(`${statePath}.session`)}, async () => { console.log('held'); await new Promise(() => {}); });`,
    ], { stdio: ['ignore', 'pipe', 'ignore'] });
    try {
      await new Promise<void>((resolve) => holder.stdout!.on('data', (chunk) => { if (String(chunk).includes('held')) resolve(); }));
      const busy = await sendZkapiConsult(QUESTION, timedTransport(virtualTime()));
      expect(busy).toMatchObject({ ok: false, error: { code: 'busy', outcome: 'not_sent', stageMs: { leaseAcquireMs: 1000, totalMs: 1000 } } });
      expect(!busy.ok && busy.error.receipt).toBeUndefined();
    } finally {
      holder.kill('SIGKILL');
    }
    expect(existsSync(statePath)).toBe(false);
    // A ledger directory that cannot be created fails as before, still timed.
    const blocked = join(root, 'not-a-directory');
    writeFileSync(blocked, '');
    const failed = await sendZkapiConsult(QUESTION, timedTransport(virtualTime(), { statePath: join(blocked, 'state.json') }));
    expect(failed).toMatchObject({ ok: false, error: { code: 'internal_error', outcome: 'not_sent', stageMs: { leaseAcquireMs: 1000, totalMs: 1000 } } });
    expect(events()).toEqual([]);
  }, SLOW);

  test('the stage table lists recorded stages in session order', () => {
    expect(formatZkapiStageTable({ totalMs: 1234, leaseAcquireMs: 5, dispatchToFirstByteMs: 870 })).toBe([
      'lease acquire              5 ms',
      'dispatch to first byte   870 ms',
      'total                   1234 ms',
    ].join('\n'));
    expect(formatZkapiStageTable(undefined)).toBe('no stage timings recorded');
  });
});

describe('zkAPI consult transport: macOS confinement', () => {
  test.skipIf(process.platform !== 'darwin')('the real sandbox denies the daemon direct TCP, UDP and DNS, but not other loopback ports', async () => {
    const otherLoopback = Bun.listen({ hostname: '127.0.0.1', port: 0, socket: { data() {} } });
    try {
      writePlan({ egressProbe: otherLoopback.port });
      const { confinement: _injected, ...withDefault } = transport();
      const result = await sendZkapiConsult(QUESTION, withDefault);
      const egress = JSON.parse(events().find((line) => line.startsWith('egress '))!.slice('egress '.length));
      expect(egress.direct).not.toBe('connected');
      expect(egress.direct).not.toBe('timeout');
      expect(egress.udp).toBe('denied');
      expect(egress.resolver).toBe('denied');
      // The stated limit: loopback is not port-filtered.
      expect(egress.loopbackOther).toBe('connected');
      expect(result).toMatchObject({
        ok: true,
        networkIdentity: 'not_verified',
        receipt: { confinement: 'non_loopback_blocked', confinementSelfTest: 'passed' },
      });
      if (result.ok) expect(result.routeLabel).toContain('failed at once inside the sandbox but not outside it');
      if (result.ok) expect(result.routeLabel).toContain('loopback is not port-filtered');
    } finally {
      otherLoopback.stop(true);
    }
  }, SLOW);
});

describe('zkAPI consult transport: verification refusals', () => {
  test('key reuse on refuses; so does a keyless daemon; nothing is sent', async () => {
    writePlan({ reuse: 60 });
    expect(await sendZkapiConsult(QUESTION, transport())).toMatchObject({ ok: false, error: { code: 'key_reuse_on', outcome: 'not_sent' } });
    writePlan({ reuse: 0, requireKey: false });
    expect(await sendZkapiConsult(QUESTION, transport())).toMatchObject({ ok: false, error: { code: 'daemon_keyless' } });
    expect(completions()).toEqual([]);
    expect(await portFree(daemonPort)).toBe(true);
    expect(await portFree(torPort)).toBe(true);
  }, SLOW);

  test('a daemon not routed through SOCKS refuses', async () => {
    writePlan({ relayPort: null });
    expect(await sendZkapiConsult(QUESTION, transport())).toMatchObject({ ok: false, error: { code: 'relay_mismatch' } });
  }, SLOW);

  test('only reviewed daemon versions are accepted', async () => {
    for (const version of ['0.1.4', '0.1.7']) {
      writePlan({ version });
      expect(await sendZkapiConsult(QUESTION, transport())).toMatchObject({ ok: false, error: { code: 'daemon_version_unsupported' } });
    }
  }, SLOW);

  test('a daemon or Tor port not held by the group Olympus started is refused', async () => {
    const foreign = await sendZkapiConsult(QUESTION, transport({ inspectListener: () => ({ kind: 'found', pid: 1, pgid: 1 }) }));
    expect(foreign).toMatchObject({ ok: false, error: { code: 'daemon_identity_failed', outcome: 'not_sent' } });
    const { inspectLoopbackListener } = await import('../src/core/consult-transport-zkapi.ts');
    const foreignTor = await sendZkapiConsult(QUESTION, transport({
      inspectListener: (port) => (port === torPort ? { kind: 'found', pid: 1, pgid: 1 } : inspectLoopbackListener(port)),
    }));
    expect(foreignTor).toMatchObject({ ok: false, error: { code: 'daemon_identity_failed' } });
    expect(completions()).toEqual([]);
  }, SLOW);

  test('a Tor client that dies after bootstrap ends the session', async () => {
    writePlan({ torDiesAfterMs: 150, startDelayMs: 600 });
    expect(await sendZkapiConsult(QUESTION, transport())).toMatchObject({ ok: false, error: { code: 'session_process_exited', outcome: 'not_sent' } });
    expect(completions()).toEqual([]);
  }, SLOW);

  test('a wrong or missing local API key refuses', async () => {
    expect(await sendZkapiConsult(QUESTION, transport({ apiKey: 'w'.repeat(40) }))).toMatchObject({ ok: false, error: { code: 'daemon_api_key_rejected' } });
    const { apiKey: _key, ...noKey } = transport();
    expect(await sendZkapiConsult(QUESTION, noKey)).toMatchObject({ ok: false, error: { code: 'daemon_api_key_missing' } });
  }, SLOW);

  test('an occupied daemon or Tor port refuses before anything starts', async () => {
    const squatter = Bun.serve({ hostname: '127.0.0.1', port: daemonPort, fetch: () => new Response('{"status":"ok"}') });
    try {
      expect(await sendZkapiConsult(QUESTION, transport())).toMatchObject({ ok: false, error: { code: 'daemon_already_running' } });
    } finally {
      squatter.stop(true);
    }
    const torSquatter = Bun.listen({ hostname: '127.0.0.1', port: torPort, socket: { data() {} } });
    try {
      expect(await sendZkapiConsult(QUESTION, transport())).toMatchObject({ ok: false, error: { code: 'tor_port_busy' } });
    } finally {
      torSquatter.stop(true);
    }
    expect(torRuns()).toEqual([]);
  }, SLOW);

  test('missing executables and a Tor that never bootstraps refuse', async () => {
    expect(await sendZkapiConsult(QUESTION, transport({ settings: settings({ torExecutable: join(binDir, 'missing-tor') }) })))
      .toMatchObject({ ok: false, error: { code: 'tor_not_found' } });
    expect(await sendZkapiConsult(QUESTION, transport({ settings: settings({ daemonExecutable: join(binDir, 'missing') }) })))
      .toMatchObject({ ok: false, error: { code: 'daemon_not_found' } });
    writePlan({ torNeverBootstraps: true });
    expect(await sendZkapiConsult(QUESTION, transport({ settings: settings({ torBootstrapTimeoutMs: 500 }) })))
      .toMatchObject({ ok: false, error: { code: 'tor_bootstrap_failed' } });
    expect(events().filter((line) => line.startsWith('serve '))).toEqual([]);
    expect(await portFree(torPort)).toBe(true);
  }, SLOW);

  test('the selected model must be in the live list (membership, not a test request)', async () => {
    writePlan({ modelMissing: true });
    expect(await sendZkapiConsult(QUESTION, transport())).toMatchObject({ ok: false, error: { code: 'model_unavailable' } });
    writePlan({ modelMissing: false, policyNeverLoads: true });
    expect(await sendZkapiConsult(QUESTION, transport({ settings: settings({ policyWarmTimeoutMs: 300 }) })))
      .toMatchObject({ ok: false, error: { code: 'policy_unavailable' } });
    expect(completions()).toEqual([]);
    expect(zkapiUsageToday(statePath, NOW)).toEqual({ count: 0, reservedMicroUsd: 0 });
  }, SLOW);

  test('owner preconditions refuse before any process starts', async () => {
    const partial = settings({ acknowledgements: { version: ZKAPI_RISK_ACKNOWLEDGEMENTS_VERSION, accepted: ['deposit_fee'] } });
    expect(await sendZkapiConsult(QUESTION, transport({ settings: partial }))).toMatchObject({ ok: false, error: { code: 'acknowledgements_incomplete' } });
    const { fundingDate: _date, ...noDate } = settings();
    expect(await sendZkapiConsult(QUESTION, transport({ settings: noDate }))).toMatchObject({ ok: false, error: { code: 'funding_date_missing' } });
    expect(await sendZkapiConsult(QUESTION, transport({ settings: settings({ fundingDate: '2026-09-05' }) })))
      .toMatchObject({ ok: false, error: { code: 'note_expired' } });
    expect(await sendZkapiConsult(QUESTION, transport({ settings: settings({ fundingDate: '2026-10-09' }) })))
      .toMatchObject({ ok: false, error: { code: 'funding_date_invalid' } });
    expect(torRuns()).toEqual([]);
    expect(events()).toEqual([]);
  });
});

describe('zkAPI consult transport: responses', () => {
  test('a redirect is never followed', async () => {
    writePlan({ completion: 'redirect' });
    expect(await sendZkapiConsult(QUESTION, transport())).toMatchObject({ ok: false, error: { code: 'redirect_refused' } });
    expect(events()).not.toContain('followed redirect');
  }, SLOW);

  test('an oversize response is cut off with a typed error', async () => {
    writePlan({ completion: 'oversize' });
    expect(await sendZkapiConsult(QUESTION, transport())).toMatchObject({ ok: false, error: { code: 'response_too_large', outcome: 'unknown' } });
  }, SLOW);

  test('a 200 with an empty completion is not trusted', async () => {
    writePlan({ completion: 'empty' });
    expect(await sendZkapiConsult(QUESTION, transport())).toMatchObject({ ok: false, error: { code: 'invalid_response' } });
  }, SLOW);

  test('errors carry no question text, URL query or daemon body', async () => {
    writePlan({ completion: 'error' });
    const rejected = await sendZkapiConsult(QUESTION, transport());
    expect(rejected).toMatchObject({
      ok: false,
      error: { code: 'daemon_error', daemonCode: 'model_budget_unavailable', httpStatus: 400, outcome: 'sent_failed' },
    });
    writePlan({ completion: 'garbage' });
    const unknown = await sendZkapiConsult(QUESTION, transport());
    expect(unknown).toMatchObject({ ok: false, error: { code: 'daemon_error', daemonCode: 'unrecognized' } });
    for (const result of [rejected, unknown]) {
      const serialized = JSON.stringify(result);
      for (const forbidden of ['notice period', 'secret=1', 'echo', 'html']) expect(serialized).not.toContain(forbidden);
    }
    expect(readFileSync(statePath, 'utf8')).not.toContain('notice period');
  }, SLOW);

  test('a timeout is typed, outcome unknown, still counted, and still settles', async () => {
    writePlan({ completion: 'slow' });
    const result = await sendZkapiConsult(QUESTION, transport({ settings: settings({ timeoutMs: 300 }) }));
    expect(result).toMatchObject({ ok: false, error: { code: 'timeout', outcome: 'unknown', receipt: { settlement: 'confirmed', fence: 'clear' } } });
    expect(zkapiUsageToday(statePath, NOW).count).toBe(1);
  }, SLOW);

  test('an abort while settling keeps settling and returns a typed cancellation', async () => {
    writePlan({ settleDelayMs: 800 });
    const controller = new AbortController();
    const pending = sendZkapiConsult(QUESTION, transport(), { signal: controller.signal });
    while (completions().length === 0) await Bun.sleep(20);
    await Bun.sleep(100);
    controller.abort();
    expect(await pending).toMatchObject({
      ok: false,
      error: { code: 'aborted', outcome: 'unknown', receipt: { settlement: 'confirmed', fence: 'clear' } },
    });
  }, SLOW);

  test('an exception inside the session becomes a typed error and everything still stops', async () => {
    const result = await sendZkapiConsult(QUESTION, transport({
      inspectListener: () => {
        throw new Error('inspector exploded with /secret/path');
      },
    }));
    expect(result).toMatchObject({ ok: false, error: { code: 'internal_error', outcome: 'not_sent' } });
    expect(JSON.stringify(result)).not.toContain('secret');
    expect(await portFree(daemonPort)).toBe(true);
    expect(await portFree(torPort)).toBe(true);
    expect(JSON.parse(readFileSync(statePath, 'utf8')).running).toBeUndefined();
  }, SLOW);
});

describe('zkAPI consult transport: fence and recovery', () => {
  test('an unconfirmed settlement holds the fence and blocks the next consult until recovery', async () => {
    writePlan({ noSettlement: true });
    expect(await sendZkapiConsult(QUESTION, transport())).toMatchObject({
      ok: true,
      routeLabel: `${NO_CONFINEMENT_LABEL}; lease settlement not confirmed`,
      receipt: { settlement: 'not_confirmed', fence: 'held' },
    });
    expect(zkapiUnresolvedSession(statePath)).toBe(true);
    writePlan({ noSettlement: false });
    expect(await sendZkapiConsult(QUESTION, transport())).toMatchObject({ ok: false, error: { code: 'unresolved_session', outcome: 'not_sent' } });
    expect(completions()).toHaveLength(1);
    const recovered = await recoverZkapiSession(transport());
    expect(recovered).toMatchObject({ ok: true, receipt: { recovery: true, settlement: 'confirmed', fence: 'clear' } });
    expect(JSON.parse(completions()[1]!.body).messages).toEqual([{ role: 'user', content: 'Reply with the single word OK.' }]);
    expect(zkapiUnresolvedSession(statePath)).toBe(false);
    expect(await sendZkapiConsult(QUESTION, transport())).toMatchObject({ ok: true });
    expect(await recoverZkapiSession(transport())).toMatchObject({ ok: false, error: { code: 'no_unresolved_session' } });
  }, SLOW);

  test('a recovery the daemon refuses before any lease keeps the fence', async () => {
    writePlan({ noSettlement: true });
    expect(await sendZkapiConsult(QUESTION, transport())).toMatchObject({ ok: true, receipt: { fence: 'held' } });
    writePlan({ noSettlement: false, completion: 'error' });
    expect(await recoverZkapiSession(transport())).toMatchObject({
      ok: false,
      error: { code: 'daemon_error', daemonCode: 'model_budget_unavailable', receipt: { recovery: true, settlement: 'not_confirmed', fence: 'held' } },
    });
    expect(zkapiUnresolvedSession(statePath)).toBe(true);
  }, SLOW);

  test('a fence belongs to the wallet directory: a replaced daemon or moved port is the same wallet', async () => {
    writePlan({ noSettlement: true });
    expect(await sendZkapiConsult(QUESTION, transport())).toMatchObject({ ok: true, receipt: { fence: 'held' } });
    writePlan({ noSettlement: false });
    // A different executable path (an upgrade) over the same config directory,
    // spelled with a trailing slash: still this wallet's fence.
    const upgraded = join(root, 'cellar', '0.1.6', 'zkapi-clientd');
    mkdirSync(dirname(upgraded), { recursive: true });
    writeFileSync(upgraded, readFileSync(join(binDir, 'zkapi-clientd')));
    chmodSync(upgraded, 0o755);
    const sameWallet = transport({
      settings: settings({ daemonExecutable: upgraded }),
      env: { HOME: root, PATH: '/usr/bin:/bin', ZKAPI_CLIENTD_CONFIG_DIR: `${configDir}/` },
    });
    expect(await sendZkapiConsult(QUESTION, sameWallet)).toMatchObject({
      ok: false,
      error: { code: 'unresolved_session', receipt: { fence: 'held', settlement: 'not_confirmed' } },
    });
    expect(await recoverZkapiSession(sameWallet)).toMatchObject({ ok: true, receipt: { fence: 'clear', settlement: 'confirmed' } });
    expect(zkapiUnresolvedSession(statePath)).toBe(false);
  }, 60_000);

  test('another wallet\'s fence blocks every consult, cannot be recovered here, and clears only by recovery there or explicit abandonment', async () => {
    writePlan({ noSettlement: true });
    expect(await sendZkapiConsult(QUESTION, transport())).toMatchObject({ ok: true, receipt: { fence: 'held' } });
    const otherWallet = join(root, 'other-wallet');
    mkdirSync(otherWallet);
    const other = transport({ env: { HOME: root, PATH: '/usr/bin:/bin', ZKAPI_CLIENTD_CONFIG_DIR: otherWallet } });
    expect(await sendZkapiConsult(QUESTION, other)).toMatchObject({
      ok: false,
      error: { code: 'unresolved_session_other_wallet', outcome: 'not_sent', receipt: { fence: 'held' } },
    });
    expect(await recoverZkapiSession(other)).toMatchObject({ ok: false, error: { code: 'unresolved_session_other_wallet' } });
    const [scope] = Object.keys(zkapiOutstandingFences(statePath));
    expect(zkapiOutstandingFences(statePath)[scope!]).toMatchObject({
      configDir: realpathSync(configDir),
      daemonExecutable: join(binDir, 'zkapi-clientd'),
      daemonPort,
    });
    expect(abandonZkapiFence(statePath, scope!, NOW)).toBe(true);
    expect(zkapiUnresolvedSession(statePath)).toBe(false);
    expect(JSON.parse(readFileSync(statePath, 'utf8')).abandonedFences[scope!]).toMatchObject({ configDir: realpathSync(configDir) });
  }, 60_000);

  test('the recovery script exits 0 only when settlement is confirmed and the fence cleared', async () => {
    const olympusDir = join(root, '.olympus');
    mkdirSync(olympusDir, { recursive: true });
    const ledger = join(olympusDir, 'zkapi-consult-state.json');
    writePlan({ noSettlement: true, statePath: ledger });
    expect(await sendZkapiConsult(QUESTION, transport({ statePath: ledger }))).toMatchObject({ ok: true, receipt: { fence: 'held' } });
    const config = baseConfig();
    config.modelProfiles.zk = zkapiProfile({
      baseUrl: `http://127.0.0.1:${daemonPort}/v1`,
      zkapi: {
        fundingDate: new Date().toISOString().slice(0, 10),
        acknowledgements: { version: ZKAPI_RISK_ACKNOWLEDGEMENTS_VERSION, accepted: ZKAPI_RISK_ACKNOWLEDGEMENTS.map((item) => item.id) },
        torSocksPort: torPort,
        daemonExecutable: join(binDir, 'zkapi-clientd'),
        torExecutable: join(binDir, 'tor'),
        settleTimeoutMs: 5_000,
        policyWarmTimeoutMs: 5_000,
        daemonReadyTimeoutMs: 10_000,
        torBootstrapTimeoutMs: 10_000,
      },
    });
    writeFileSync(join(olympusDir, 'sovereignty.json'), JSON.stringify(config));
    const script = join(import.meta.dir, '..', 'scripts', 'zkapi-consult-recover.ts');
    const env = { HOME: root, PATH: '/usr/bin:/bin', ZKAPI_CLIENTD_CONFIG_DIR: configDir, OLYMPUS_ZKAPI_LOCAL_API_KEY: API_KEY };
    expect(Bun.spawnSync([process.execPath, script], { env }).exitCode).toBe(2);
    expect(Bun.spawnSync([process.execPath, script, '--yes'], { env }).exitCode).toBe(3);
    expect(zkapiUnresolvedSession(ledger)).toBe(true);
    writePlan({ noSettlement: false });
    const recovered = Bun.spawnSync([process.execPath, script, '--yes'], { env });
    expect(recovered.exitCode).toBe(0);
    const printed = recovered.stdout.toString();
    expect(printed).toContain('Stage timings:');
    for (const label of ['lease acquire', 'Tor start to bootstrapped', 'daemon start to ready', 'dispatch to first byte', 'settlement wait', 'teardown', 'total']) {
      expect(printed).toMatch(new RegExp(`\\n${label} +\\d+ ms`));
    }
    expect(zkapiUnresolvedSession(ledger)).toBe(false);
  }, 120_000);

  test('an early refusal still reports a held fence', async () => {
    writePlan({ noSettlement: true });
    await sendZkapiConsult(QUESTION, transport());
    const { apiKey: _key, ...noKey } = transport();
    expect(await sendZkapiConsult(QUESTION, noKey)).toMatchObject({ ok: false, error: { code: 'daemon_api_key_missing', receipt: { fence: 'held' } } });
    expect(await sendZkapiConsult(QUESTION, transport({ settings: settings({ acknowledgements: { version: 0, accepted: [] } }) })))
      .toMatchObject({ ok: false, error: { code: 'acknowledgements_incomplete', receipt: { fence: 'held' } } });
  }, SLOW);

  test('a receipt reflects a held fence even when the session is refused before starting', async () => {
    writePlan({ noSettlement: true });
    await sendZkapiConsult(QUESTION, transport());
    const squatter = Bun.serve({ hostname: '127.0.0.1', port: daemonPort, fetch: () => new Response('x') });
    try {
      expect(await recoverZkapiSession(transport())).toMatchObject({
        ok: false,
        error: { code: 'daemon_already_running', receipt: { recovery: true, fence: 'held', settlement: 'not_confirmed' } },
      });
    } finally {
      squatter.stop(true);
    }
  }, SLOW);

  test('settlement already reported is kept when the daemon exits right after it', async () => {
    writePlan({ crashAfterSettlement: true, settleDelayMs: 30 });
    expect(await sendZkapiConsult(QUESTION, transport())).toMatchObject({
      ok: false,
      error: { code: 'session_process_exited', receipt: { settlement: 'confirmed', fence: 'clear' } },
    });
    expect(zkapiUnresolvedSession(statePath)).toBe(false);
  }, SLOW);

  test('a missing key line is not proof that no lease exists', async () => {
    writePlan({ noKeyLog: true });
    expect(await sendZkapiConsult(QUESTION, transport())).toMatchObject({ ok: true, receipt: { settlement: 'not_confirmed', fence: 'held' } });
    expect(zkapiUnresolvedSession(statePath)).toBe(true);
  }, SLOW);

  test('only a refusal made before any lease request clears the fence without a key', async () => {
    writePlan({ completion: 'error' });
    expect(await sendZkapiConsult(QUESTION, transport())).toMatchObject({ ok: false, error: { receipt: { settlement: 'no_lease', fence: 'clear' } } });
    writePlan({ completion: 'garbage', noSettlement: true });
    expect(await sendZkapiConsult(QUESTION, transport())).toMatchObject({ ok: false, error: { receipt: { fence: 'held' } } });
  }, SLOW);
});

describe('zkAPI consult transport: exclusivity, processes, caps', () => {
  test('a second consult while one is in flight is refused as busy', async () => {
    writePlan({ completion: 'held' });
    const first = sendZkapiConsult(QUESTION, transport());
    while (completions().length === 0) await Bun.sleep(20);
    expect(await sendZkapiConsult(QUESTION, transport())).toMatchObject({ ok: false, error: { code: 'busy', outcome: 'not_sent' } });
    writeFileSync(join(configDir, 'release'), '');
    expect(await first).toMatchObject({ ok: true, text: 'held' });
    expect(completions()).toHaveLength(1);
  }, SLOW);

  test('the session lease excludes a separate process holding it', async () => {
    const holder = spawn(process.execPath, [
      '-e',
      `const { withFileLease } = await import(${JSON.stringify(join(import.meta.dir, '..', 'src', 'core', 'file-lease.ts'))});
       await withFileLease(${JSON.stringify(`${statePath}.session`)}, async () => { console.log('held'); await new Promise(() => {}); });`,
    ], { stdio: ['ignore', 'pipe', 'ignore'] });
    try {
      await new Promise<void>((resolve) => holder.stdout!.on('data', (chunk) => { if (String(chunk).includes('held')) resolve(); }));
      expect(await sendZkapiConsult(QUESTION, transport())).toMatchObject({ ok: false, error: { code: 'busy' } });
      expect(events()).toEqual([]);
    } finally {
      holder.kill('SIGKILL');
    }
  }, SLOW);

  test('a separate process\'s consult counts toward an owner-set limit in this one', async () => {
    const limited = settings({ dailyRequestCap: 2 });
    const result = await runConsultInChildProcess({ ...transport({ settings: limited }) });
    expect(result).toEqual({ ok: true });
    expect(await sendZkapiConsult(QUESTION, transport({ settings: limited }))).toMatchObject({ ok: true });
    expect(await sendZkapiConsult(QUESTION, transport({ settings: limited }))).toMatchObject({ ok: false, error: { code: 'daily_cap_reached' } });
    expect(completions()).toHaveLength(2);
  }, 60_000);

  test('a supervisor killed mid-consult leaves no process behind, even one that ignores SIGTERM', async () => {
    writePlan({ completion: 'held', companion: true });
    const child = startConsultInChildProcess({ ...transport() });
    try {
      while (completions().length === 0) await Bun.sleep(50);
      const daemonPid = Number(events().find((line) => line.startsWith('serve '))!.split(' ')[1]);
      const companion = Number(events().find((line) => line.startsWith('companion '))!.split(' ')[1]);
      expect(alive(daemonPid) && alive(companion)).toBe(true);
      child.kill('SIGKILL');
      const deadline = Date.now() + 15_000;
      while ((alive(daemonPid) || alive(companion)) && Date.now() < deadline) await Bun.sleep(100);
      expect(alive(daemonPid)).toBe(false);
      expect(alive(companion)).toBe(false);
      expect(await portFree(torPort)).toBe(true);
    } finally {
      child.kill('SIGKILL');
    }
  }, 60_000);

  test('a session whose processes cannot be proven ours at teardown fails, is never signalled, and blocks the next', async () => {
    writePlan({ completion: 'held' });
    const pending = sendZkapiConsult(QUESTION, transport({ settings: settings({ timeoutMs: 30_000 }) }));
    while (completions().length === 0) await Bun.sleep(20);
    const daemonPid = Number(events().find((line) => line.startsWith('serve '))!.split(' ')[1]);
    const watchdogPid = Number(execFileSync('/bin/ps', ['-o', 'pgid=', '-p', String(daemonPid)], { encoding: 'utf8' }).trim());
    try {
      // The group's leader disappears without its members: its id can no
      // longer be proven ours, so nothing may signal it.
      process.kill(watchdogPid, 'SIGKILL');
      expect(await pending).toMatchObject({ ok: false, error: { code: 'teardown_incomplete' } });
      expect(alive(daemonPid)).toBe(true);
      expect(JSON.parse(readFileSync(statePath, 'utf8')).running).toBeDefined();
      expect(JSON.parse(readFileSync(statePath, 'utf8')).lastSession.result).toBe('teardown_incomplete');
      expect(await sendZkapiConsult(QUESTION, transport())).toMatchObject({ ok: false, error: { code: 'stranded_processes' } });
    } finally {
      try { process.kill(daemonPid, 'SIGKILL'); } catch {}
    }
  }, 60_000);

  test('a live group whose leader is gone is never signalled: ownership cannot be proven', async () => {
    const orphanMaker = spawn(process.execPath, [
      '-e',
      `const { spawn } = require('node:child_process');
       const member = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1 << 30)'], { stdio: 'ignore' });
       console.log(member.pid); setTimeout(() => process.exit(0), 100);`,
    ], { stdio: ['ignore', 'pipe', 'ignore'], detached: true });
    const memberPid = Number(await new Promise<string>((resolve) => orphanMaker.stdout!.once('data', (chunk) => resolve(String(chunk).trim()))));
    while (alive(orphanMaker.pid!)) await Bun.sleep(20);
    try {
      writeFileSync(statePath, JSON.stringify({
        version: 1,
        day: '2026-10-05',
        count: 0,
        reservedMicroUsd: 0,
        running: {
          sessionId: 'earlier',
          supervisor: { pid: 999_999 },
          groups: [{ role: 'daemon', pgid: orphanMaker.pid!, leader: processInstanceIdentity(process.pid) }],
        },
      }));
      expect(await sendZkapiConsult(QUESTION, transport())).toMatchObject({ ok: false, error: { code: 'stranded_processes' } });
      expect(alive(memberPid)).toBe(true);
      expect(JSON.parse(readFileSync(statePath, 'utf8')).running).toBeDefined();
    } finally {
      process.kill(memberPid, 'SIGKILL');
    }
  }, SLOW);

  test('a stranded group is stopped only once its supervisor is proven dead, and a live supervisor is never preempted', async () => {
    const supervisor = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1 << 30)'], { stdio: 'ignore' });
    const strandedGroup = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1 << 30)'], { stdio: 'ignore', detached: true });
    try {
      const record = (supervisorPid: number) => ({
        version: 1,
        day: '2026-10-05',
        count: 0,
        reservedMicroUsd: 0,
        running: {
          sessionId: 'earlier',
          supervisor: { pid: supervisorPid, instance: processInstanceIdentity(supervisorPid) },
          groups: [{ role: 'daemon', pgid: strandedGroup.pid!, leader: processInstanceIdentity(strandedGroup.pid!) }],
        },
      });
      writeFileSync(statePath, JSON.stringify(record(supervisor.pid!)));
      expect(await sendZkapiConsult(QUESTION, transport())).toMatchObject({ ok: false, error: { code: 'busy' } });
      expect(alive(strandedGroup.pid!)).toBe(true);
      supervisor.kill('SIGKILL');
      while (alive(supervisor.pid!)) await Bun.sleep(20);
      expect(await sendZkapiConsult(QUESTION, transport())).toMatchObject({ ok: true });
      expect(alive(strandedGroup.pid!)).toBe(false);
    } finally {
      supervisor.kill('SIGKILL');
      strandedGroup.kill('SIGKILL');
    }
  }, SLOW);

  test('a recorded leader from another boot is never signalled', async () => {
    const live = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1 << 30)'], { stdio: 'ignore', detached: true });
    try {
      const identity = processInstanceIdentity(live.pid!);
      if (!identity?.bootId) return; // this platform reports no boot identity
      writeFileSync(statePath, JSON.stringify({
        version: 1,
        day: '2026-10-05',
        count: 0,
        reservedMicroUsd: 0,
        running: {
          sessionId: 'earlier',
          supervisor: { pid: 999_999 },
          groups: [{ role: 'daemon', pgid: live.pid!, leader: { ...identity, bootId: 'another-boot' } }],
        },
      }));
      expect(await sendZkapiConsult(QUESTION, transport())).toMatchObject({ ok: true });
      expect(alive(live.pid!)).toBe(true);
    } finally {
      live.kill('SIGKILL');
    }
  }, SLOW);

  test('a daemon that crashes after answering fails the session, holds the fence, and leaves no descendant', async () => {
    writePlan({ companion: true, crashAfterCompletion: true, settleDelayMs: 2_000 });
    expect(await sendZkapiConsult(QUESTION, transport({ settings: settings({ settleTimeoutMs: 3_000 }) }))).toMatchObject({
      ok: false,
      error: { code: 'session_process_exited', outcome: 'unknown', receipt: { fence: 'held' } },
    });
    const companion = Number(events().find((line) => line.startsWith('companion '))!.split(' ')[1]);
    expect(alive(companion)).toBe(false);
    expect(zkapiUnresolvedSession(statePath)).toBe(true);
    expect(JSON.parse(readFileSync(statePath, 'utf8')).running).toBeUndefined();
  }, SLOW);

  test('a Tor client that dies while a consult is in flight ends it at once with a typed failure', async () => {
    writePlan({ completion: 'held' });
    const pending = sendZkapiConsult(QUESTION, transport({ settings: settings({ timeoutMs: 30_000 }) }));
    while (completions().length === 0) await Bun.sleep(20);
    const killedAt = Date.now();
    writeFileSync(join(configDir, 'kill-tor'), '');
    expect(await pending).toMatchObject({ ok: false, error: { code: 'session_process_exited', outcome: 'unknown', receipt: { fence: 'held' } } });
    expect(Date.now() - killedAt).toBeLessThan(15_000);
    expect(zkapiUnresolvedSession(statePath)).toBe(true);
  }, SLOW);

  test('a failed consult is never resent, and nothing but the daemon is contacted', async () => {
    const urls: string[] = [];
    const recordingFetch = (async (input: string | URL | Request, init?: RequestInit) => {
      urls.push(String(input));
      return fetch(input, init);
    }) as typeof fetch;
    writePlan({ completion: 'garbage' });
    await sendZkapiConsult(QUESTION, transport({ fetchImpl: recordingFetch }));
    expect(urls.length).toBeGreaterThan(0);
    expect(urls.every((url) => url.startsWith(`http://127.0.0.1:${daemonPort}/`))).toBe(true);
    expect(urls.filter((url) => url.endsWith('/v1/chat/completions'))).toHaveLength(1);
    expect(completions()).toHaveLength(1);
  }, SLOW);

  test('no limit applies by default: many sequential consults are not refused by any cap', async () => {
    writePlan({ allowance: 1_000_000 });
    for (let index = 0; index < 11; index += 1) {
      expect(await sendZkapiConsult(QUESTION, transport())).toMatchObject({ ok: true, receipt: { listedAllowanceUsd: 1, reservedUsd: 1 } });
    }
    expect(completions()).toHaveLength(11);
    // Still recorded for disclosure: each consult counts its model's listed hold.
    expect(zkapiUsageToday(statePath, NOW)).toEqual({ count: 11, reservedMicroUsd: 11_000_000 });
  }, 120_000);

  test('an owner-set money limit refuses at the boundary across a restart, counting each consult at its listed hold', async () => {
    writePlan({ allowance: 1_000_000 });
    const limited = settings({ dailySpendCapUsd: 2 });
    expect(await sendZkapiConsult(QUESTION, transport({ settings: limited }))).toMatchObject({ ok: true });
    // A real second process over the same ledger stands in for a restart.
    expect(await runConsultInChildProcess({ ...transport({ settings: limited }) })).toEqual({ ok: true });
    expect(await sendZkapiConsult(QUESTION, transport({ settings: limited }))).toMatchObject({
      ok: false,
      error: { code: 'spend_cap_reached', outcome: 'not_sent' },
    });
    expect(completions()).toHaveLength(2);
    expect(zkapiUsageToday(statePath, NOW)).toEqual({ count: 2, reservedMicroUsd: 2_000_000 });
    // A $6-tier model does not fit a $7 limit after $2 is used; refused at the send, after warming.
    writePlan({ allowance: 6_000_000 });
    expect(await sendZkapiConsult(QUESTION, transport({ settings: settings({ dailySpendCapUsd: 7 }) }))).toMatchObject({
      ok: false,
      error: { code: 'spend_cap_reached', outcome: 'not_sent' },
    });
    expect(completions()).toHaveLength(2);
  }, 60_000);

  test('an owner-set request limit refuses at the boundary, and an ambiguous send counts toward it', async () => {
    writePlan({ completion: 'slow' });
    const limited = settings({ dailyRequestCap: 2, timeoutMs: 300 });
    expect(await sendZkapiConsult(QUESTION, transport({ settings: limited }))).toMatchObject({ ok: false, error: { code: 'timeout', outcome: 'unknown' } });
    writePlan({ completion: 'normal' });
    expect(await sendZkapiConsult(QUESTION, { ...transport({ settings: limited }) })).toMatchObject({ ok: true });
    expect(await sendZkapiConsult(QUESTION, transport({ settings: limited }))).toMatchObject({
      ok: false,
      error: { code: 'daily_cap_reached', outcome: 'not_sent' },
    });
    expect(completions()).toHaveLength(2);
    // The ledger is atomic across processes, and a new UTC day starts a new count.
    expect(reserveZkapiRequest(statePath, { requestCap: 2 }, NOW)).toEqual({ reserved: false, reason: 'daily_cap_reached' });
    expect(reserveZkapiRequest(statePath, { requestCap: 2 }, new Date('2026-10-06T00:00:01.000Z'))).toEqual({ reserved: true });
  }, SLOW);
});

// ---------------------------------------------------------------------------
// The one-shot session (design §A.8, stage C2): open warms the route before
// the question exists, send hands the reply over before settlement, finished
// settles and tears down, and nothing is reserved until dispatch.

function ledger(): Record<string, any> {
  return existsSync(statePath) ? JSON.parse(readFileSync(statePath, 'utf8')) : {};
}

/** Nothing reserved, fenced or counted; the ledger may hold lifecycle records (a running session, a last session). */
function expectNothingReserved(): void {
  expect(zkapiUsageToday(statePath, NOW)).toEqual({ count: 0, reservedMicroUsd: 0 });
  expect(zkapiOutstandingFences(statePath)).toEqual({});
}

async function expectProcessesGone(): Promise<void> {
  expect(await portFree(daemonPort)).toBe(true);
  expect(await portFree(torPort)).toBe(true);
}

async function openReady(overrides: Partial<ZkapiConsultTransportOptions> = {}): Promise<ZkapiConsultSession> {
  const opened = await openZkapiConsultSession(transport(overrides));
  if (!opened.ok) throw new Error(`open failed: ${opened.error.code}`);
  return opened.session;
}

function settledFlag<T>(promise: Promise<T>): () => boolean {
  let settled = false;
  void promise.then(() => { settled = true; }, () => { settled = true; });
  return () => settled;
}

describe('zkAPI consult transport: one-shot session', () => {
  test('open warms the route and reserves nothing; cancel before send tears down and releases the lease', async () => {
    const session = await openReady();
    expect(session.state).toBe('ready');
    // The route is warm: Tor and the daemon are up, the policy is listed.
    expect(events().some((line) => line.startsWith('serve '))).toBe(true);
    expect(await portFree(daemonPort)).toBe(false);
    expect(completions()).toEqual([]);
    expectNothingReserved();
    // The lease spans the open session: another open is busy.
    expect(await openZkapiConsultSession(transport())).toMatchObject({ ok: false, error: { code: 'busy', outcome: 'not_sent' } });
    session.cancel();
    const result = await session.finished;
    expect(result).toMatchObject({ ok: false, error: { code: 'aborted', outcome: 'not_sent', receipt: { fence: 'clear', settlement: 'no_lease' } } });
    expect(session.state).toBe('cancelled');
    expect(completions()).toEqual([]);
    expectNothingReserved();
    await expectProcessesGone();
    // Lifecycle receipts are allowed; the running record is gone and the lease
    // is released: the next consult runs.
    expect(ledger().running).toBeUndefined();
    expect(ledger().lastSession).toMatchObject({ result: 'aborted', fence: 'clear' });
    const stageMs = !result.ok ? result.error.receipt?.stageMs : undefined;
    expect(stageMs).toMatchObject({ warmTotalMs: expect.any(Number), teardownMs: expect.any(Number), totalMs: expect.any(Number) });
    expect(stageMs).not.toHaveProperty('replyHandedOverAtMs');
    expect(stageMs).not.toHaveProperty('reservationMs');
    expect(await sendZkapiConsult(QUESTION, transport())).toMatchObject({ ok: true });
    // A send after cancellation is refused without touching anything.
    expect(await session.send(QUESTION)).toMatchObject({ kind: 'failed', error: { code: 'session_spent', outcome: 'not_sent' } });
  }, SLOW);

  test('a caller signal during opening cancels at that await: nothing reserved, processes gone', async () => {
    writePlan({ startDelayMs: 1_500 });
    const controller = new AbortController();
    const pending = openZkapiConsultSession(transport(), { signal: controller.signal });
    while (torRuns().length === 0) await Bun.sleep(20);
    controller.abort();
    const opened = await pending;
    expect(opened).toMatchObject({ ok: false, error: { code: 'aborted', outcome: 'not_sent' } });
    expect(completions()).toEqual([]);
    expectNothingReserved();
    await expectProcessesGone();
    // Already cancelled before the lease: nothing starts at all.
    const early = new AbortController();
    early.abort();
    expect(await openZkapiConsultSession(transport(), { signal: early.signal })).toMatchObject({ ok: false, error: { code: 'aborted', outcome: 'not_sent' } });
    expect(torRuns()).toHaveLength(1);
  }, SLOW);

  test('an open deadline that passes refuses with timeout, nothing reserved, and the lease released', async () => {
    writePlan({ startDelayMs: 2_000 });
    const opened = await openZkapiConsultSession(transport(), { deadlineMs: 400 });
    expect(opened).toMatchObject({ ok: false, error: { code: 'timeout', outcome: 'not_sent', receipt: { fence: 'clear', stageMs: { totalMs: expect.any(Number) } } } });
    expect(completions()).toEqual([]);
    expectNothingReserved();
    await expectProcessesGone();
    writePlan({ startDelayMs: 0 });
    const next = await openZkapiConsultSession(transport(), { deadlineMs: 20_000 });
    expect(next.ok).toBe(true);
    if (next.ok) {
      next.session.cancel();
      await next.session.finished;
    }
  }, SLOW);

  test('the reply is handed over before settlement, pending and fenced; finished settles and clears the fence', async () => {
    writePlan({ settleDelayMs: 1_500 });
    const session = await openReady();
    const finishedFlag = settledFlag(session.finished);
    const reply = await session.send(QUESTION);
    expect(reply).toMatchObject({
      kind: 'reply',
      text: 'Generally, notice scales with term length.',
      providerVerification: 'verified',
      networkIdentity: 'not_verified',
      routeLabel: `${NO_CONFINEMENT_LABEL}; lease settlement pending`,
      receipt: { settlement: 'pending', fence: 'held', reservedUsd: 1, postStopProbe: 'not_run' },
    });
    expect(session.state).toBe('replied');
    // At hand-over the money is still fenced and the session still owns its processes.
    expect(finishedFlag()).toBe(false);
    expect(zkapiUnresolvedSession(statePath)).toBe(true);
    expect(await portFree(daemonPort)).toBe(false);
    const replyStages = reply.kind === 'reply' ? reply.receipt.stageMs! : {};
    for (const key of ['warmTotalMs', 'reservationMs', 'replyHandedOverAtMs'] as const) expect(typeof replyStages[key]).toBe('number');
    expect(replyStages).not.toHaveProperty('settlementWaitMs');
    expect(replyStages).not.toHaveProperty('totalMs');
    // The one-shot refuses a second send while the first is settling.
    expect(await session.send(QUESTION)).toMatchObject({ kind: 'failed', error: { code: 'session_spent', outcome: 'not_sent' } });
    const result = await session.finished;
    expect(result).toMatchObject({
      ok: true,
      text: 'Generally, notice scales with term length.',
      routeLabel: NO_CONFINEMENT_LABEL,
      receipt: { settlement: 'confirmed', fence: 'clear', postStopProbe: 'route_lost', reservedUsd: 1 },
    });
    expect(session.state).toBe('finished');
    expect(zkapiUnresolvedSession(statePath)).toBe(false);
    expect(zkapiUsageToday(statePath, NOW)).toEqual({ count: 1, reservedMicroUsd: 1_000_000 });
    const stageMs = result.ok ? result.receipt.stageMs! : {};
    expect(stageMs.replyHandedOverAtMs).toBe(replyStages.replyHandedOverAtMs!);
    expect(stageMs.warmTotalMs).toBe(replyStages.warmTotalMs!);
    expect(stageMs.settlementWaitMs).toBeGreaterThanOrEqual(1_000);
    expect(stageMs.totalMs).toBeGreaterThan(stageMs.replyHandedOverAtMs!);
    expect(ledger().lastSession).toMatchObject({ result: 'ok', settlement: 'confirmed', fence: 'clear', stageMs: { replyHandedOverAtMs: stageMs.replyHandedOverAtMs } });
    // Reserved and fenced before the daemon saw the request.
    expect(completions()[0]).toMatchObject({ countAtArrival: 1, fenceAtArrival: true });
    await expectProcessesGone();
    expect(await session.send(QUESTION)).toMatchObject({ kind: 'failed', error: { code: 'session_spent' } });
  }, SLOW);

  test('a caller cancel after dispatch detaches the caller; the session keeps the reply, settles and clears the fence', async () => {
    writePlan({ completion: 'held', settleDelayMs: 800 });
    const session = await openReady();
    const controller = new AbortController();
    const pending = session.send(QUESTION, { signal: controller.signal });
    while (completions().length === 0) await Bun.sleep(20);
    expect(session.state).toBe('dispatched');
    controller.abort();
    expect(await pending).toMatchObject({ kind: 'failed', error: { code: 'aborted', outcome: 'unknown', receipt: { settlement: 'pending', fence: 'held' } } });
    // The fetch was not aborted: the daemon still holds the request until released.
    await Bun.sleep(200);
    expect(zkapiUnresolvedSession(statePath)).toBe(true);
    writeFileSync(join(configDir, 'release'), '');
    expect(await session.finished).toMatchObject({ ok: true, text: 'held', receipt: { settlement: 'confirmed', fence: 'clear' } });
    expect(zkapiUnresolvedSession(statePath)).toBe(false);
    expect(completions()).toHaveLength(1);
    await expectProcessesGone();
  }, SLOW);

  test('session.cancel after dispatch is the same detachment, and the open signal is detached too', async () => {
    writePlan({ completion: 'held', settleDelayMs: 300 });
    const openController = new AbortController();
    const opened = await openZkapiConsultSession(transport(), { signal: openController.signal });
    if (!opened.ok) throw new Error(opened.error.code);
    const pending = opened.session.send(QUESTION);
    while (completions().length === 0) await Bun.sleep(20);
    openController.abort();
    opened.session.cancel();
    expect(await pending).toMatchObject({ kind: 'failed', error: { code: 'aborted', outcome: 'unknown' } });
    writeFileSync(join(configDir, 'release'), '');
    expect(await opened.session.finished).toMatchObject({ ok: true, receipt: { settlement: 'confirmed', fence: 'clear' } });
  }, SLOW);

  test('a process that dies after dispatch holds the fence; recovery is needed', async () => {
    writePlan({ crashAfterCompletion: true, settleDelayMs: 2_000 });
    const session = await openReady({ settings: settings({ settleTimeoutMs: 3_000 }) });
    const reply = await session.send(QUESTION);
    expect(reply).toMatchObject({ kind: 'reply', receipt: { settlement: 'pending', fence: 'held' } });
    expect(await session.finished).toMatchObject({
      ok: false,
      error: { code: 'session_process_exited', outcome: 'unknown', receipt: { settlement: 'not_confirmed', fence: 'held' } },
    });
    expect(zkapiUnresolvedSession(statePath)).toBe(true);
    expect(ledger().running).toBeUndefined();
    await expectProcessesGone();
    expect(await openZkapiConsultSession(transport())).toMatchObject({ ok: false, error: { code: 'unresolved_session', outcome: 'not_sent' } });
    writePlan({ crashAfterCompletion: false, settleDelayMs: 30 });
    expect(await recoverZkapiSession(transport())).toMatchObject({ ok: true, receipt: { recovery: true, settlement: 'confirmed', fence: 'clear' } });
  }, SLOW);

  test('a process that dies while the session is ready ends it with nothing reserved', async () => {
    const session = await openReady();
    writeFileSync(join(configDir, 'kill-tor'), '');
    expect(await session.finished).toMatchObject({ ok: false, error: { code: 'session_process_exited', outcome: 'not_sent' } });
    expectNothingReserved();
    await expectProcessesGone();
    expect(await session.send(QUESTION)).toMatchObject({ kind: 'failed', error: { code: 'session_spent' } });
  }, SLOW);

  test('two concurrent opens: the second is busy in this process and across processes', async () => {
    const first = await openReady();
    expect(await openZkapiConsultSession(transport())).toMatchObject({ ok: false, error: { code: 'busy', outcome: 'not_sent' } });
    // Another process over the same ledger cannot take the session lease either.
    expect(await runConsultInChildProcess({ ...transport() })).toEqual({ ok: false, code: 'busy' });
    expect(completions()).toEqual([]);
    first.cancel();
    await first.finished;
    const second = await openReady();
    second.cancel();
    await second.finished;
    expect(torRuns()).toHaveLength(2);
  }, 60_000);

  test('final authorization runs at the last boundary: a refusal reserves nothing; it sees the session signal', async () => {
    const session = await openReady();
    let seenSignal: AbortSignal | undefined;
    const result = await session.send(QUESTION, {
      authorize: async (signal) => {
        seenSignal = signal;
        // Nothing is reserved while the caller decides.
        expectNothingReserved();
        return false;
      },
    });
    expect(result).toMatchObject({ kind: 'failed', error: { code: 'authorization_refused', outcome: 'not_sent', receipt: { fence: 'clear' } } });
    expect(seenSignal?.aborted).toBe(false);
    expect(await session.finished).toMatchObject({ ok: false, error: { code: 'authorization_refused', outcome: 'not_sent' } });
    expect(completions()).toEqual([]);
    expectNothingReserved();
    await expectProcessesGone();
    expect(ledger().lastSession).toMatchObject({ result: 'authorization_refused', fence: 'clear' });
    // An authorization that approves dispatches once: reserved and fenced before the daemon sees it.
    const approved = await openReady();
    const reply = await approved.send(QUESTION, { authorize: () => true });
    expect(reply).toMatchObject({ kind: 'reply', receipt: { settlement: 'pending' } });
    expect(await approved.finished).toMatchObject({ ok: true, receipt: { settlement: 'confirmed', fence: 'clear' } });
    expect(completions()).toHaveLength(1);
    expect(completions()[0]).toMatchObject({ countAtArrival: 1, fenceAtArrival: true });
  }, SLOW);

  test('a cancel, a send deadline or a throwing authorization during authorization reserves nothing', async () => {
    // Cancel while the caller's authorization is pending: cancel wins.
    const cancelled = await openReady();
    const cancelResult = await cancelled.send(QUESTION, {
      authorize: async (signal) => {
        cancelled.cancel();
        await Bun.sleep(50);
        expect(signal.aborted).toBe(true);
        return true;
      },
    });
    expect(cancelResult).toMatchObject({ kind: 'failed', error: { code: 'aborted', outcome: 'not_sent' } });
    expectNothingReserved();
    // The send deadline passes while authorization is slow.
    const late = await openReady();
    const lateResult = await late.send(QUESTION, { deadlineMs: 200, authorize: async () => { await Bun.sleep(600); return true; } });
    expect(lateResult).toMatchObject({ kind: 'failed', error: { code: 'timeout', outcome: 'not_sent' } });
    expectNothingReserved();
    // An authorization that throws is an internal error, nothing reserved.
    const thrown = await openReady();
    expect(await thrown.send(QUESTION, { authorize: () => { throw new Error('policy /secret/path'); } }))
      .toMatchObject({ kind: 'failed', error: { code: 'internal_error', outcome: 'not_sent' } });
    expectNothingReserved();
    // A send signal already aborted cancels before any check.
    const aborted = new AbortController();
    aborted.abort();
    const early = await openReady();
    expect(await early.send(QUESTION, { signal: aborted.signal })).toMatchObject({ kind: 'failed', error: { code: 'aborted', outcome: 'not_sent' } });
    expectNothingReserved();
    expect(completions()).toEqual([]);
    await expectProcessesGone();
  }, 90_000);

  test('once fetchImpl is invoked every exception is an unknown dispatch: a call-through-then-throw keeps the fence', async () => {
    // An injected fetch may send the request and then throw synchronously.
    const callThroughThenThrow = ((input: string | URL | Request, init?: RequestInit) => {
      if (String(input).endsWith('/v1/chat/completions')) {
        void fetch(input, init).catch(() => undefined);
        throw new Error('threw after sending');
      }
      return fetch(input, init);
    }) as typeof fetch;
    writePlan({ settleDelayMs: 300 });
    const session = await openReady({ fetchImpl: callThroughThenThrow });
    expect(await session.send(QUESTION)).toMatchObject({ kind: 'failed', error: { code: 'transport_failed', outcome: 'unknown', receipt: { settlement: 'pending', fence: 'held', reservedUsd: 1 } } });
    const result = await session.finished;
    // The daemon did see the request; its settlement evidence is what clears the fence, never a rollback.
    while (completions().length === 0) await Bun.sleep(20);
    expect(result).toMatchObject({ ok: false, error: { code: 'transport_failed', outcome: 'unknown', receipt: { reservedUsd: 1 } } });
    expect(zkapiUsageToday(statePath, NOW)).toEqual({ count: 1, reservedMicroUsd: 1_000_000 });
    expect(ledger().lastSession).toMatchObject({ result: 'transport_failed', reservedUsd: 1 });
    // A fetch that throws without sending is indistinguishable from the above and is treated the same.
    const throwingFetch = ((input: string | URL | Request, init?: RequestInit) => {
      if (String(input).endsWith('/v1/chat/completions')) throw new Error('never left the process');
      return fetch(input, init);
    }) as typeof fetch;
    writePlan({ settleDelayMs: 30 });
    if (zkapiUnresolvedSession(statePath)) expect(await recoverZkapiSession(transport())).toMatchObject({ ok: true, receipt: { fence: 'clear' } });
    const countBefore = zkapiUsageToday(statePath, NOW).count;
    expect(await sendZkapiConsult(QUESTION, transport({ fetchImpl: throwingFetch }))).toMatchObject({
      ok: false,
      error: { code: 'transport_failed', outcome: 'unknown', receipt: { settlement: 'not_confirmed', fence: 'held', reservedUsd: 1 } },
    });
    expect(zkapiUsageToday(statePath, NOW).count).toBe(countBefore + 1);
    expect(zkapiUnresolvedSession(statePath)).toBe(true);
  }, 90_000);

  test('a hung authorization never holds the session: cancel and the send deadline win, a late answer never dispatches', async () => {
    const never = (): Promise<boolean> => new Promise(() => undefined);
    const cancelled = await openReady();
    const pendingCancel = cancelled.send(QUESTION, { authorize: never });
    await Bun.sleep(150);
    expect(cancelled.state).toBe('authorizing');
    cancelled.cancel();
    expect(await pendingCancel).toMatchObject({ kind: 'failed', error: { code: 'aborted', outcome: 'not_sent' } });
    expect(await cancelled.finished).toMatchObject({ ok: false, error: { code: 'aborted', outcome: 'not_sent' } });
    expectNothingReserved();
    const timed = await openReady();
    expect(await timed.send(QUESTION, { deadlineMs: 200, authorize: never })).toMatchObject({ kind: 'failed', error: { code: 'timeout', outcome: 'not_sent' } });
    expectNothingReserved();
    // A late approval, and a late rejection, after the race was lost change nothing.
    let approve!: (value: boolean) => void;
    let rejectLate!: (error: Error) => void;
    const late = await openReady();
    const pendingLate = late.send(QUESTION, { authorize: () => new Promise<boolean>((resolve, reject) => { approve = resolve; rejectLate = reject; }) });
    await Bun.sleep(100);
    late.cancel();
    expect(await pendingLate).toMatchObject({ kind: 'failed', error: { code: 'aborted', outcome: 'not_sent' } });
    await late.finished;
    approve(true);
    const rejecting = await openReady();
    const pendingReject = rejecting.send(QUESTION, { authorize: () => new Promise<boolean>((_resolve, reject) => { rejectLate = reject; }) });
    await Bun.sleep(100);
    rejecting.cancel();
    expect(await pendingReject).toMatchObject({ kind: 'failed', error: { code: 'aborted' } });
    await rejecting.finished;
    rejectLate(new Error('too late'));
    await Bun.sleep(50);
    expect(completions()).toEqual([]);
    expectNothingReserved();
    await expectProcessesGone();
  }, 90_000);

  test('the dispatch deadline is absolute: a synchronous overrun is caught after authorization and again before the fetch', async () => {
    const busyWait = (ms: number): void => {
      const until = performance.now() + ms;
      while (performance.now() < until) { /* hold the event loop */ }
    };
    // A synchronous authorization that overruns the deadline: no timer could
    // fire, so only the absolute check refuses it. Nothing reserved.
    const overrun = await openReady();
    expect(await overrun.send(QUESTION, { deadlineMs: 100, authorize: () => { busyWait(300); return true; } }))
      .toMatchObject({ kind: 'failed', error: { code: 'timeout', outcome: 'not_sent' } });
    expect(await overrun.finished).toMatchObject({ ok: false, error: { code: 'timeout', outcome: 'not_sent' } });
    expectNothingReserved();
    // The reservation itself consumes the remaining time: the fetch is
    // provably not invoked, so the reservation, count and fence roll back.
    let reserving = false;
    const slowLedger = transport({
      now: () => {
        if (reserving) {
          reserving = false;
          busyWait(400);
        }
        return NOW;
      },
    });
    const opened = await openZkapiConsultSession(slowLedger);
    if (!opened.ok) throw new Error(opened.error.code);
    expect(await opened.session.send(QUESTION, { deadlineMs: 200, authorize: () => { reserving = true; return true; } }))
      .toMatchObject({ kind: 'failed', error: { code: 'timeout', outcome: 'not_sent', receipt: { fence: 'clear' } } });
    expect(await opened.session.finished).toMatchObject({ ok: false, error: { code: 'timeout', outcome: 'not_sent', receipt: { fence: 'clear' } } });
    expect(ledger().lastSession).toMatchObject({ result: 'timeout', fence: 'clear' });
    expect(ledger().lastSession.reservedUsd).toBeUndefined();
    expectNothingReserved();
    expect(completions()).toEqual([]);
    await expectProcessesGone();
  }, 90_000);

  test('the deadline is captured inside send and checked at the last instant before fetch is invoked', async () => {
    const busyWait = (ms: number): void => {
      const until = performance.now() + ms;
      while (performance.now() < until) { /* hold the event loop */ }
    };
    // Event-loop delay between the send call and the machine resuming counts:
    // the deadline was captured synchronously inside send.
    const blocked = await openReady();
    const pending = blocked.send(QUESTION, { deadlineMs: 100 });
    busyWait(300);
    expect(await pending).toMatchObject({ kind: 'failed', error: { code: 'timeout', outcome: 'not_sent' } });
    expect(await blocked.finished).toMatchObject({ ok: false, error: { code: 'timeout', outcome: 'not_sent' } });
    expectNothingReserved();
    // The stage clock sample taken just before the fetch overruns the deadline:
    // the fetch is not invoked, and the reservation rolls back.
    let armed = false;
    const slowClock = transport({
      clock: () => {
        if (armed) {
          armed = false;
          busyWait(400);
        }
        return performance.now();
      },
    });
    const opened = await openZkapiConsultSession(slowClock);
    if (!opened.ok) throw new Error(opened.error.code);
    const result = await opened.session.send(QUESTION, { deadlineMs: 200, authorize: () => { armed = true; return true; } });
    expect(result).toMatchObject({ kind: 'failed', error: { code: 'timeout', outcome: 'not_sent', receipt: { fence: 'clear' } } });
    expect(await opened.session.finished).toMatchObject({ ok: false, error: { code: 'timeout', outcome: 'not_sent', receipt: { fence: 'clear' } } });
    expect(ledger().lastSession).toMatchObject({ result: 'timeout', fence: 'clear' });
    expect(ledger().lastSession.reservedUsd).toBeUndefined();
    // The dispatch stage was opened but no fetch followed it.
    expect(ledger().lastSession.stageMs).toHaveProperty('dispatchToFirstByteMs');
    expectNothingReserved();
    expect(completions()).toEqual([]);
    await expectProcessesGone();
  }, 90_000);

  test('a ready session nobody sends on ends itself after the ready timeout, nothing reserved', async () => {
    const opened = await openZkapiConsultSession(transport(), { readyTimeoutMs: 400 });
    if (!opened.ok) throw new Error(opened.error.code);
    expect(opened.session.state).toBe('ready');
    expect(await opened.session.finished).toMatchObject({ ok: false, error: { code: 'timeout', outcome: 'not_sent' } });
    expect(opened.session.state).toBe('cancelled');
    expectNothingReserved();
    await expectProcessesGone();
    expect(await opened.session.send(QUESTION)).toMatchObject({ kind: 'failed', error: { code: 'session_spent' } });
    // The lease is free again.
    const next = await openReady();
    next.cancel();
    await next.finished;
  }, SLOW);

  test('a supervisor killed between the early reply and settlement leaves the running record and the fence; reopening is refused until recovery', async () => {
    writePlan({ settleDelayMs: 20_000 });
    const { now: _now, confinement: _confinement, ...plain } = transport();
    const script = `
      const { openZkapiConsultSession } = await import(${JSON.stringify(TRANSPORT_MODULE)});
      const options = JSON.parse(process.argv[1]);
      options.now = () => new Date(${JSON.stringify(NOW.toISOString())});
      options.confinement = { level: 'none', limit: 'none', wrap: (argv) => [...argv], selfTest: async () => false };
      const opened = await openZkapiConsultSession(options);
      if (!opened.ok) { console.log('open-failed ' + opened.error.code); process.exit(1); }
      const reply = await opened.session.send(${JSON.stringify(QUESTION)});
      console.log('reply ' + reply.kind);
      await opened.session.finished;
    `;
    const child = spawn(process.execPath, ['-e', script, JSON.stringify(plain)], { stdio: ['ignore', 'pipe', 'ignore'] });
    try {
      const line = await new Promise<string>((resolve) => child.stdout!.on('data', (chunk) => resolve(String(chunk).trim())));
      expect(line).toBe('reply reply');
      child.kill('SIGKILL');
      while (alive(child.pid!)) await Bun.sleep(20);
      // The ledger still names the session and the fence is held: the money is still fenced.
      expect(ledger().running).toBeDefined();
      expect(zkapiUnresolvedSession(statePath)).toBe(true);
      expect(zkapiUsageToday(statePath, NOW)).toEqual({ count: 1, reservedMicroUsd: 1_000_000 });
      // The watchdogs follow their supervisor; once they are gone an ordinary
      // reopen clears the stale record but is refused by the fence.
      const deadline = Date.now() + 15_000;
      while ((!await portFree(daemonPort) || !await portFree(torPort)) && Date.now() < deadline) await Bun.sleep(100);
      expect(await openZkapiConsultSession(transport())).toMatchObject({ ok: false, error: { code: 'unresolved_session', outcome: 'not_sent', receipt: { fence: 'held' } } });
      expect(ledger().running).toBeUndefined();
      writePlan({ settleDelayMs: 30 });
      expect(await recoverZkapiSession(transport())).toMatchObject({ ok: true, receipt: { recovery: true, settlement: 'confirmed', fence: 'clear' } });
      expect(zkapiUnresolvedSession(statePath)).toBe(false);
    } finally {
      child.kill('SIGKILL');
    }
  }, 90_000);

  test('a completion failure is handed over before settlement too, and finished carries the settled receipt', async () => {
    writePlan({ completion: 'error' });
    const session = await openReady();
    const reply = await session.send(QUESTION);
    expect(reply).toMatchObject({
      kind: 'failed',
      error: { code: 'daemon_error', daemonCode: 'model_budget_unavailable', httpStatus: 400, outcome: 'sent_failed', receipt: { settlement: 'pending', fence: 'held' } },
    });
    expect(await session.finished).toMatchObject({
      ok: false,
      error: { code: 'daemon_error', daemonCode: 'model_budget_unavailable', outcome: 'sent_failed', receipt: { settlement: 'no_lease', fence: 'clear' } },
    });
    expect(JSON.stringify(reply)).not.toContain('notice period');
  }, SLOW);

  test('an invalid question is refused without spending the one shot', async () => {
    const session = await openReady();
    expect(await session.send('')).toMatchObject({ kind: 'failed', error: { code: 'invalid_question', outcome: 'not_sent' } });
    expect(session.state).toBe('ready');
    expect(await session.send(QUESTION)).toMatchObject({ kind: 'reply' });
    expect(await session.finished).toMatchObject({ ok: true });
  }, SLOW);

  test('sendZkapiConsult is open, send and finished: the same receipts on success and failure paths', async () => {
    const strip = (result: ZkapiConsultResult): unknown => {
      const copy = JSON.parse(JSON.stringify(result)) as { ok: boolean; receipt?: { stageMs?: unknown }; error?: { receipt?: { stageMs?: unknown } }; elapsedMs?: number };
      delete copy.receipt?.stageMs;
      delete copy.error?.receipt?.stageMs;
      delete copy.elapsedMs;
      return copy;
    };
    const viaSession = async (): Promise<ZkapiConsultResult> => {
      const session = await openReady();
      await session.send(QUESTION);
      return session.finished;
    };
    expect(strip(await sendZkapiConsult(QUESTION, transport()))).toEqual(strip(await viaSession()));
    expect(ledger().lastSession.stageMs).toMatchObject({ warmTotalMs: expect.any(Number), replyHandedOverAtMs: expect.any(Number), totalMs: expect.any(Number) });
    writePlan({ completion: 'error' });
    const failed = await sendZkapiConsult(QUESTION, transport());
    expect(failed).toMatchObject({ ok: false, error: { code: 'daemon_error', outcome: 'sent_failed', receipt: { settlement: 'no_lease', fence: 'clear' } } });
    expect(strip(failed)).toEqual(strip(await viaSession()));
    // Every path records the warm total; only a reply records when it was handed over.
    const last = ledger().lastSession;
    expect(last.stageMs).toMatchObject({ warmTotalMs: expect.any(Number), totalMs: expect.any(Number) });
    expect(last.stageMs).not.toHaveProperty('replyHandedOverAtMs');
  }, 120_000);

  test('the reply type is the same text the finished result carries; nothing is resent', async () => {
    const urls: string[] = [];
    const recordingFetch = (async (input: string | URL | Request, init?: RequestInit) => {
      urls.push(String(input));
      return fetch(input, init);
    }) as typeof fetch;
    const session = await openReady({ fetchImpl: recordingFetch });
    const reply: ZkapiConsultReply = await session.send(QUESTION);
    const result = await session.finished;
    expect(reply.kind === 'reply' && result.ok && reply.text === result.text).toBe(true);
    expect(urls.filter((url) => url.endsWith('/v1/chat/completions'))).toHaveLength(1);
  }, SLOW);
});

// ---------------------------------------------------------------------------
// Evidence adapters refuse the daemon at dispatch

describe('evidence adapters refuse a zkAPI daemon endpoint where they dispatch', () => {
  test('an Argus lane chosen at runtime on the daemon port never dispatches, in any loopback spelling', async () => {
    for (const baseUrl of ['http://127.0.0.1:8787/v1', 'http://[::ffff:127.0.0.1]:8787/v1', 'http://localhost:8787/v1', 'http://2130706433:8787/v1']) {
      const config = defaultConfig();
      config.argus.lanes.deep.baseUrl = baseUrl;
      let dispatched = false;
      const fetchDouble = (async () => {
        dispatched = true;
        return new Response('{}');
      }) as unknown as typeof fetch;
      const client = new DelphiClient(config, new DirectHttpDelphiTransport(fetchDouble));
      await expect(client.complete({ lane: 'deep', prompt: 'evidence' })).rejects.toMatchObject({ code: 'config_error', name: 'ZkapiDaemonEndpointRefusal' });
      expect(dispatched).toBe(false);
    }
  });

  test('the guard reads the owner\'s policy itself: no validation needed first, and an unreadable policy fails closed', async () => {
    const [port, otherPort] = freePorts(2) as [number, number];
    mkdirSync(join(root, '.olympus'), { recursive: true });
    const policyPath = join(root, '.olympus', 'sovereignty.json');
    const config = baseConfig();
    config.modelProfiles.zk = zkapiProfile({ baseUrl: `http://127.0.0.1:${port}/v1` });
    writeFileSync(policyPath, JSON.stringify(config));
    expect(() => assertNotZkapiDaemonEndpoint(`http://127.0.0.1:${port}/v1/chat/completions`, 'probe')).toThrow(/zkAPI daemon/);
    const localModel = `http://127.0.0.1:${otherPort}/v1/chat/completions`;
    expect(() => assertNotZkapiDaemonEndpoint(localModel, 'probe')).not.toThrow();
    writeFileSync(policyPath, '{ not json');
    expect(() => assertNotZkapiDaemonEndpoint(localModel, 'probe')).toThrow(/cannot be read/);
    expect(() => assertNotZkapiDaemonEndpoint('https://api.example.com/v1/chat/completions', 'probe')).not.toThrow();
    rmSync(policyPath);
    expect(() => assertNotZkapiDaemonEndpoint(localModel, 'probe')).not.toThrow();
  });

  test('any host name on a daemon port is refused, without a lookup', async () => {
    for (const url of ['http://my-alias.example:8787/v1/chat/completions', 'https://api.example.com:8787/v1']) {
      expect(() => assertNotZkapiDaemonEndpoint(url, 'probe')).toThrow(expect.objectContaining({ reason: 'hostname_on_daemon_port' }));
      await expect(assertNotZkapiDaemonEndpointResolved(url, 'probe', async () => {
        throw new Error('looked up');
      })).rejects.toMatchObject({ reason: 'hostname_on_daemon_port' });
    }
    // A cloud endpoint on an ordinary port is never looked up while the policy is readable.
    await assertNotZkapiDaemonEndpointResolved('https://api.example.com/v1/chat/completions', 'probe', async () => {
      throw new Error('looked up');
    });
  });

  test('policy refresh fails closed on every read error, never caches a failure, and sees same-size same-time replacements', async () => {
    const dir = join(root, '.olympus');
    mkdirSync(dir, { recursive: true });
    const policyPath = join(dir, 'sovereignty.json');
    const localModel = `http://127.0.0.1:${freePort()}/v1/chat/completions`;
    const write = (port: number) => {
      const config = baseConfig();
      config.modelProfiles.zk = zkapiProfile({ baseUrl: `http://127.0.0.1:${port}/v1` });
      writeFileSync(policyPath, JSON.stringify(config));
    };
    write(41001);
    expect(() => assertNotZkapiDaemonEndpoint(localModel, 'probe')).not.toThrow();
    // stat fails with EACCES (directory not searchable): fail closed, not "absent".
    chmodSync(dir, 0o000);
    try {
      expect(() => assertNotZkapiDaemonEndpoint(localModel, 'probe')).toThrow(expect.objectContaining({ reason: 'policy_unreadable' }));
    } finally {
      chmodSync(dir, 0o700);
    }
    // read fails with EACCES, then access is restored with nothing else changed.
    chmodSync(policyPath, 0o000);
    try {
      expect(() => assertNotZkapiDaemonEndpoint(localModel, 'probe')).toThrow(expect.objectContaining({ reason: 'policy_unreadable' }));
    } finally {
      chmodSync(policyPath, 0o600);
    }
    expect(() => assertNotZkapiDaemonEndpoint(localModel, 'probe')).not.toThrow();
    // Same size, same modification time, different daemon port.
    const before = statSync(policyPath);
    write(41002);
    utimesSync(policyPath, before.atime, before.mtime);
    expect(statSync(policyPath).size).toBe(before.size);
    expect(() => assertNotZkapiDaemonEndpoint('http://127.0.0.1:41002/v1/chat/completions', 'probe')).toThrow(expect.objectContaining({ reason: 'daemon_port' }));
    // A snapshot that is not a policy is unreadable too.
    writeFileSync(policyPath, '[]');
    expect(() => assertNotZkapiDaemonEndpoint(localModel, 'probe')).toThrow(/cannot be read/);
    // While unreadable, a host name on any port is resolved and refused if it is local or unresolvable.
    await expect(assertNotZkapiDaemonEndpointResolved('http://alias.example:29999/v1', 'probe', async () => ['127.0.0.1']))
      .rejects.toMatchObject({ reason: 'policy_unreadable' });
    await expect(assertNotZkapiDaemonEndpointResolved('http://alias.example:29999/v1', 'probe', async () => {
      throw new Error('no answer');
    })).rejects.toMatchObject({ reason: 'policy_unreadable' });
    await assertNotZkapiDaemonEndpointResolved('https://api.example.com/v1', 'probe', async () => ['93.184.216.34']);
    rmSync(policyPath);
    expect(() => assertNotZkapiDaemonEndpoint(localModel, 'probe')).not.toThrow();
  });

  test('a refusal reaches the owner as a configuration problem, not an outage', async () => {
    await expect(connectGeminiApiKey({
      apiKey: 'test-key',
      fetch: (async () => new Response('{}')) as unknown as typeof fetch,
      geminiModelsUrl: 'http://127.0.0.1:8787/v1/models',
      homeDir: root,
      envPath: join(root, 'worker.env'),
    })).rejects.toMatchObject({ name: 'ZkapiDaemonEndpointRefusal', reason: 'daemon_port', suggestion: expect.stringContaining('zkAPI daemon') });
    mkdirSync(join(root, '.olympus'), { recursive: true });
    writeFileSync(join(root, '.olympus', 'sovereignty.json'), '{ broken');
    try {
      expect(() => assertNotZkapiDaemonEndpoint('http://127.0.0.1:28090/v1', 'probe')).toThrow(
        expect.objectContaining({ suggestion: expect.stringContaining(join(root, '.olympus', 'sovereignty.json')) }),
      );
    } finally {
      rmSync(join(root, '.olympus', 'sovereignty.json'));
    }
  });

  test('configurable setup probes refuse the daemon port before sending a key', async () => {
    let dispatched = 0;
    const fetchDouble = (async () => {
      dispatched += 1;
      return new Response('{"data":[]}', { headers: { 'Content-Type': 'application/json' } });
    }) as unknown as typeof fetch;
    const config = baseConfig();
    config.modelProfiles['local-source-answer'].baseUrl = 'http://127.0.0.1:8787/v1';
    const setup = new ModelSetupService({
      config: config as SovereigntyConfig,
      credentialState: () => 'ready',
      localApiKey: () => 'local-key',
      fetch: fetchDouble,
      autoCheck: false,
    });
    await setup.checkLocalModels();
    await expect(connectGeminiApiKey({
      apiKey: 'test-key',
      fetch: fetchDouble,
      geminiModelsUrl: 'http://127.0.0.1:8787/v1/models',
      homeDir: root,
      envPath: join(root, 'worker.env'),
    })).rejects.toThrow();
    expect(dispatched).toBe(0);
  });

  test('the shared model transport refuses every loopback spelling of a daemon port, for any adapter', async () => {
    let dispatched = 0;
    const fetchDouble = async () => {
      dispatched += 1;
      return new Response('{}');
    };
    for (const url of [
      'http://127.0.0.1:8787/v1/chat/completions',
      'http://127.9.9.9:8787/v1/chat/completions',
      'http://[::1]:8787/v1/chat/completions',
      'http://[::ffff:7f00:1]:8787/v1/chat/completions',
      'http://api.localhost:8787/v1/messages',
      'http://0x7f.1:8787/v1/embeddings',
      'http://0.0.0.0:8787/v1/chat/completions',
    ]) {
      await expect(fetchModelEndpoint(fetchDouble, url, { method: 'POST', body: 'evidence' })).rejects.toMatchObject({ code: 'config_error' });
    }
    expect(dispatched).toBe(0);
    await fetchModelEndpoint(fetchDouble, 'http://127.0.0.1:28090/v1/chat/completions', { method: 'POST' });
    expect(dispatched).toBe(1);
  });

  test('a configured non-default daemon port is refused for embeddings and vision too', async () => {
    const port = freePort();
    const config = baseConfig();
    config.modelProfiles.zk = zkapiProfile({ baseUrl: `http://127.0.0.1:${port}/v1` });
    createSovereigntyEngine(config as SovereigntyConfig);
    let fetched = false;
    const fetchDouble = (async () => {
      fetched = true;
      return new Response('{}');
    }) as unknown as typeof fetch;
    const embeddings = new OpenAICompatibleSourceEmbeddingProvider({ baseUrl: `http://127.0.0.1:${port}/v1`, model: 'm', dimension: 4, fetchImpl: fetchDouble });
    await expect(embeddings.embed([{ text: 'evidence' }], { taskType: 'RETRIEVAL_DOCUMENT' })).rejects.toMatchObject({ name: 'ZkapiDaemonEndpointRefusal' });
    expect(() => requireLocalHttpBaseUrl(`http://127.0.0.1:${port}/v1`, 'vision url')).toThrow(/zkAPI daemon/);
    expect(() => new OpenAICompatibleVlmClient({ baseUrl: `http://127.0.0.1:${port}/v1`, model: 'm', fetchImpl: fetchDouble })).toThrow(/zkAPI daemon/);
    expect(fetched).toBe(false);
  });
});


// ---------------------------------------------------------------------------
// Sovereignty: a zkapi profile is consult-only

function baseConfig(): Record<string, any> {
  return JSON.parse(JSON.stringify(loadSovereigntyPreset('local-first')));
}

function zkapiProfile(overrides: Record<string, unknown> = {}): Record<string, any> {
  return {
    provider: 'zkapi',
    trust: 'standard_cloud',
    purpose: 'consult',
    baseUrl: 'http://127.0.0.1:8787/v1',
    model: MODEL,
    secretRef: 'env:OLYMPUS_ZKAPI_LOCAL_API_KEY',
    zkapi: {
      tor: 'per_consult',
      fundingDate: '2026-09-30',
      acknowledgements: { version: ZKAPI_RISK_ACKNOWLEDGEMENTS_VERSION, accepted: ZKAPI_RISK_ACKNOWLEDGEMENTS.map((item) => item.id) },
    },
    ...overrides,
  };
}

function configError(build: () => unknown): string {
  try {
    build();
  } catch (error) {
    expect(error).toBeInstanceOf(OperationError);
    expect((error as OperationError).code).toBe('config_error');
    return (error as OperationError).message;
  }
  throw new Error('expected a config_error');
}

function engineWith(mutate: (config: Record<string, any>) => void) {
  const config = baseConfig();
  config.modelProfiles.zk = zkapiProfile();
  mutate(config);
  return createSovereigntyEngine(config as SovereigntyConfig);
}

describe('sovereignty: zkapi provider', () => {
  test('a consult-only zkapi profile is accepted and parses its settings', () => {
    const profile = engineWith(() => undefined).config.modelProfiles.zk!;
    expect(profile).toMatchObject({ provider: 'zkapi', trust: 'standard_cloud', purpose: 'consult' });
    expect(profile.zkapi).toMatchObject({ tor: 'per_consult', torSocksPort: 19050, timeoutMs: 360_000 });
    // No default limit (owner ruling, 2026-10-05): both are unset unless the owner sets them.
    expect(profile.zkapi?.dailyRequestCap).toBeUndefined();
    expect(profile.zkapi?.dailySpendCapUsd).toBeUndefined();
  });

  test('is refused in every evidence-carrying role', () => {
    expect(configError(() => engineWith((config) => {
      config.routes.secure_local.pool.members.push('zk');
      config.routes.secure_local.pool.order.push('zk');
    }))).toContain('Consult-only profile "zk" cannot serve the secure_local analyst route');
    for (const domain of ['internal', 'public_safe']) {
      expect(configError(() => engineWith((config) => {
        config.routes[domain].pool.members.push('zk');
        config.routes[domain].pool.order.push('zk');
      }))).toContain(`cannot serve the ${domain} analyst route`);
    }
    for (const domain of ['secure_local', 'internal', 'public_safe']) {
      expect(configError(() => engineWith((config) => {
        config.retrieval.trustDomains[domain].embeddingProfile = 'zk';
        config.retrieval.trustDomains[domain].allowedEmbeddingTrust = ['local', 'standard_cloud'];
      }))).toMatch(/cannot serve the \w+ embedding policy|secure_local embeddings/);
    }
    for (const purpose of ['analyst', 'embedding', 'vision', 'classification']) {
      expect(configError(() => engineWith((config) => {
        config.modelProfiles.zk.purpose = purpose;
      }))).toContain('must declare purpose "consult"');
    }
    expect(() => assertSnifferProfileAllowed('zk', engineWith(() => undefined).config.modelProfiles.zk!)).toThrow();
  });

  test('the sniffer lane never resolves to a zkapi profile', () => {
    const lane = resolveSnifferLane(engineWith(() => undefined));
    expect(lane.profileId).not.toBe('zk');
    expect(lane.profile.provider).not.toBe('zkapi');
  });

  test('the ChatGPT model choice cannot route answers to a zkapi profile', () => {
    // A zkapi profile sitting under the id the "local" choice installs.
    const config = baseConfig();
    config.modelProfiles['local-source-answer'] = zkapiProfile({ baseUrl: 'http://127.0.0.1:9797/v1' });
    config.routes = {
      secure_local: { pool: { members: ['venice-private'] } },
      internal: { pool: { members: ['venice-private'] } },
      public_safe: { pool: { members: ['venice-private'] } },
    };
    const parsed = createSovereigntyEngine(config as SovereigntyConfig).config;
    expect(configError(() => applyModelChoice(parsed, { answers: 'local' }, { local: true, venice: true })))
      .toContain('Consult-only profile "local-source-answer"');
  });

  test('a purpose consult profile of any provider is refused for evidence roles', () => {
    expect(configError(() => engineWith((config) => {
      config.modelProfiles['cloud-openclaw-infer'].purpose = 'consult';
    }))).toContain('Consult-only profile "cloud-openclaw-infer"');
  });

  test('trust is fixed at standard_cloud whatever the loopback address', () => {
    for (const trust of ['local', 'encrypted_cloud']) {
      expect(configError(() => engineWith((config) => {
        config.modelProfiles.zk.trust = trust;
      }))).toContain('must declare trust "standard_cloud"');
    }
  });

  test('the daemon base URL must be its plain loopback API', () => {
    for (const baseUrl of ['https://zkapi.example/v1', 'http://user:pw@127.0.0.1:8787/v1', 'http://127.0.0.1:8787/v1?x=1', 'http://127.0.0.1:8787/other']) {
      expect(configError(() => engineWith((config) => {
        config.modelProfiles.zk.baseUrl = baseUrl;
      }))).toContain('baseUrl');
    }
  });

  test('a local profile on the daemon port is refused with the reason', () => {
    expect(configError(() => engineWith((config) => {
      config.modelProfiles['local-source-answer'].baseUrl = 'http://127.0.0.1:8787/v1';
    }))).toContain('where the zkAPI daemon serves');
    expect(configError(() => engineWith((config) => {
      config.modelProfiles.zk.baseUrl = 'http://127.0.0.1:9797/v1';
      config.modelProfiles['local-source-answer'].baseUrl = 'http://localhost:9797/v1';
    }))).toContain('port 9797');
    const withoutZkapi = baseConfig();
    withoutZkapi.modelProfiles['local-source-answer'].baseUrl = 'http://127.0.0.1:8787/v1';
    expect(configError(() => createSovereigntyEngine(withoutZkapi as SovereigntyConfig))).toContain('zkAPI daemon');
    expect(() => requireLocalHttpBaseUrl('http://127.0.0.1:8787/v1', 'vision url')).toThrow(/zkAPI daemon/);
  });

  test('a profile of any provider and declared trust is refused on a daemon port', () => {
    for (const baseUrl of ['http://127.0.0.1:8787/v1', 'http://[::ffff:127.0.0.1]:8787/v1', 'http://api.localhost:8787/v1']) {
      expect(configError(() => engineWith((config) => {
        config.modelProfiles['cloud-direct'] = {
          provider: 'openai-compatible',
          trust: 'standard_cloud',
          baseUrl,
          model: 'gpt-x',
          secretRef: 'env:OPENAI_API_KEY',
          purpose: 'analyst',
        };
      }))).toContain('where the zkAPI daemon serves');
    }
  });

  test('the settings block is strict and belongs to zkapi profiles only', () => {
    expect(configError(() => engineWith((config) => {
      config.modelProfiles.zk.zkapi.keyReuseWindowSeconds = 0;
    }))).toContain('keyReuseWindowSeconds is not a zkAPI consult setting');
    expect(configError(() => engineWith((config) => {
      config.modelProfiles.zk.zkapi.tor = 'declared';
    }))).toContain('tor must be "per_consult" or "off"');
    expect(configError(() => engineWith((config) => {
      config.modelProfiles.zk.zkapi.fundingDate = '2026-02-30';
    }))).toContain('fundingDate');
    expect(configError(() => engineWith((config) => {
      config.modelProfiles['cloud-openclaw-infer'].zkapi = { tor: 'off' };
    }))).toContain('only valid on a provider "zkapi" profile');
  });
});

// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Doctor

function doctorDeps(profile: Record<string, unknown> = {}, env: Record<string, string> = {}): DoctorDeps {
  const config = baseConfig();
  const base = zkapiProfile();
  config.modelProfiles.zk = {
    ...base,
    baseUrl: `http://127.0.0.1:${daemonPort}/v1`,
    ...profile,
    zkapi: {
      ...base.zkapi,
      torSocksPort: torPort,
      daemonExecutable: join(binDir, 'zkapi-clientd'),
      torExecutable: join(binDir, 'tor'),
      ...(profile.zkapi as object | undefined),
    },
  };
  return {
    config: defaultConfig(),
    delphi: {
      listModels: async () => [],
      listModelsForProfile: async () => [],
      complete: async () => ({ text: 'OLYMPUS_DOCTOR_OK', model: 'm' }),
    },
    sovereigntyEngine: createSovereigntyEngine(config as SovereigntyConfig),
    fetchImpl: (async () => new Response('{}', { status: 404, headers: { 'Content-Type': 'application/json' } })) as unknown as typeof fetch,
    commandExists: async () => true,
    pythonModuleExists: async () => false,
    readHandleRegistry: () => ({ version: 1, handles: [] }),
    env: { HOME: root, PATH: '/usr/bin:/bin', ZKAPI_CLIENTD_CONFIG_DIR: configDir, OLYMPUS_ZKAPI_LOCAL_API_KEY: API_KEY, ...env },
    secretStore: { get: async () => undefined, getSync: () => undefined },
    ingestionHealthStatePath: join(root, 'ingestion.json'),
    workerEnvPath: join(root, 'worker.env'),
    zkapiStatePath: statePath,
    now: () => NOW,
  };
}

async function zkapiCheck(deps: DoctorDeps): Promise<DoctorCheck> {
  const check = (await runDoctor(deps)).checks.find((candidate) => candidate.name === 'zkapi_consult_transport');
  expect(check).toBeDefined();
  return check!;
}

describe('doctor: zkapi_consult_transport', () => {
  test('not configured', async () => {
    const check = await zkapiCheck({ ...doctorDeps(), sovereigntyEngine: createSovereigntyEngine(baseConfig() as SovereigntyConfig) });
    expect(check).toEqual({
      name: 'zkapi_consult_transport',
      ok: true,
      detail: 'Not configured: the experimental zkAPI consult transport is off.',
    });
  }, SLOW);

  test('ready before any consult, then reports what the last consult verified', async () => {
    const before = await zkapiCheck(doctorDeps());
    expect(before.ok).toBe(true);
    for (const part of [
      'no consult is sent until the consult lane lands',
      'zkapi-clientd 0.1.6',
      'tor found (a fresh client per consult)',
      'confinement on this platform: ',
      'daemon port free, Tor port free',
      'local API key configured',
      `acknowledgements complete (${ZKAPI_RISK_ACKNOWLEDGEMENTS.length}/${ZKAPI_RISK_ACKNOWLEDGEMENTS.length})`,
      'estimated expiry 2026-10-30 from the confirmed funding date (25 days left, notice none)',
      'requests today 0 (no limit set), worst-case authorized today $0.00 (no limit set; each consult counts its model\'s hold, up to $6.00)',
      'no unresolved session',
      'balance, fee quotes and on-chain expiry not available from the daemon',
      'no consult run yet',
      'route: not yet verified',
    ]) expect(before.detail).toContain(part);
    expect(before.detail).toEndWith('; ready');
    expect(before.detail).not.toContain(API_KEY);
    expect(events()).toEqual([]);

    const time = virtualTime();
    expect(await sendZkapiConsult(QUESTION, timedTransport(time))).toMatchObject({ ok: true });
    const after = await zkapiCheck(doctorDeps());
    expect(after.detail).toContain('requests today 1 (no limit set), worst-case authorized today $1.00 (no limit set;');
    expect(after.detail).toContain('(ok): key reuse verified_off, local auth verified, Tor per_consult, confinement none (self-test not_run), settlement confirmed');
    expect(after.detail).toContain(', stage timings lease acquire 1000 ms, confinement self-test 3001 ms, Tor start to bootstrapped 4002 ms,');
    expect(after.detail).toContain(`teardown 20000 ms, total ${time.values.at(-1)! - time.values[0]!} ms;`);
    expect(after.detail).toContain(`route: ${NO_CONFINEMENT_LABEL}`);
  }, SLOW);

  test('names what blocks, including an exhausted spend cap and an unresolved session', async () => {
    const torOff = await zkapiCheck(doctorDeps({ zkapi: { tor: 'off', fundingDate: '2026-09-07' } }));
    expect(torOff.detail).toContain('Tor off');
    expect(torOff.detail).toContain('route: payment privacy only (network address visible)');
    expect(torOff.detail).toContain('2 days left, notice two_days');

    const blocked = await zkapiCheck(doctorDeps(
      { zkapi: { acknowledgements: { version: ZKAPI_RISK_ACKNOWLEDGEMENTS_VERSION, accepted: [] }, fundingDate: '2026-09-01', torExecutable: join(binDir, 'none') } },
      { OLYMPUS_ZKAPI_LOCAL_API_KEY: '' },
    ));
    expect(blocked.ok).toBe(false);
    expect(blocked.detail).toContain(`acknowledgements incomplete (0/${ZKAPI_RISK_ACKNOWLEDGEMENTS.length})`);
    expect(blocked.detail).toContain('estimated expiry PASSED on 2026-10-01; an unwithdrawn note becomes claimable by the operator');
    expect(blocked.detail).toContain('local API key NOT configured');
    expect(blocked.detail).toContain('not ready: acknowledgements_incomplete, note_expired, daemon_api_key_missing, tor_not_found');

    const fence = { scope: zkapiFenceScope({ env: { HOME: root, ZKAPI_CLIENTD_CONFIG_DIR: configDir } }), configDir };
    reserveZkapiRequest(statePath, {}, NOW, fence);
    reserveZkapiRequest(statePath, {}, NOW, fence);
    reserveZkapiRequest(statePath, {}, NOW, fence);
    // Without an owner-set limit, a high count blocks nothing; only the fence does.
    const unlimited = await zkapiCheck(doctorDeps());
    expect(unlimited.detail).toContain('requests today 3 (no limit set), worst-case authorized today $18.00 (no limit set;');
    expect(unlimited.detail).toContain(`UNRESOLVED SESSION: fence since 2026-10-05T12:00:00.000Z for wallet directory ${configDir}, this wallet`);
    expect(unlimited.hint).toContain('scripts/zkapi-consult-recover.ts --yes');
    expect(unlimited.detail).toContain('not ready: unresolved_session');
    expect(unlimited.detail).not.toContain('spend_cap_reached');
    expect(unlimited.detail).not.toContain('daily_cap_reached');
    // Before a session the next hold is unknown, so a limit blocks only once it is used up.
    const room = await zkapiCheck(doctorDeps({ zkapi: { dailyRequestCap: 5, dailySpendCapUsd: 20 } }));
    expect(room.detail).toContain('requests today 3 (limit 5), worst-case authorized today $18.00 (limit $20.00;');
    expect(room.detail).not.toContain('spend_cap_reached');
    const exhausted = await zkapiCheck(doctorDeps({ zkapi: { dailyRequestCap: 5, dailySpendCapUsd: 18 } }));
    expect(exhausted.ok).toBe(false);
    expect(exhausted.detail).toContain('requests today 3 (limit 5), worst-case authorized today $18.00 (limit $18.00;');
    expect(exhausted.detail).toContain('not ready: unresolved_session, spend_cap_reached');

    const squatter = Bun.serve({ hostname: '127.0.0.1', port: daemonPort, fetch: () => new Response('x') });
    try {
      const busy = await zkapiCheck(doctorDeps());
      expect(busy.detail).toContain('daemon port IN USE');
      expect(busy.detail).toContain('daemon_already_running');
    } finally {
      squatter.stop(true);
    }
  }, SLOW);
});

describe('zkAPI consult transport: finding the programs', () => {
  test('after PATH, the standard install folders: ~/.local/bin, then Homebrew and /usr/local/bin on macOS; ~/.local/bin and /usr/local/bin on Linux', () => {
    expect(standardExecutableDirectories({ HOME: '/Users/me' }, 'darwin')).toEqual(['/Users/me/.local/bin', '/opt/homebrew/bin', '/usr/local/bin']);
    expect(standardExecutableDirectories({ HOME: '/home/me' }, 'linux')).toEqual(['/home/me/.local/bin', '/usr/local/bin']);
    // No HOME, or a relative one: no home folder is guessed.
    expect(standardExecutableDirectories({}, 'darwin')).toEqual(['/opt/homebrew/bin', '/usr/local/bin']);
    expect(standardExecutableDirectories({ HOME: 'relative' }, 'linux')).toEqual(['/usr/local/bin']);
  });

  // A described filesystem for the fallback trust check: owner, mode, kind and links.
  function fakeTrust(entries: Record<string, { uid?: number; mode?: number; kind?: 'dir' | 'file'; link?: string; exec?: boolean }>): ExecutableTrustProbe {
    const real = (path: string): string => {
      const parts = path.split('/').filter(Boolean);
      let current = '/';
      for (const part of parts) {
        current = current === '/' ? `/${part}` : `${current}/${part}`;
        const entry = entries[current];
        if (!entry) throw new Error(`ENOENT ${current}`);
        if (entry.link) current = real(entry.link);
      }
      return current;
    };
    return {
      realpath: real,
      stat: (path) => {
        const entry = path === '/' ? { uid: 0, mode: 0o755, kind: 'dir' as const } : entries[path];
        if (!entry || entry.link) throw new Error(`ENOENT ${path}`);
        return { uid: entry.uid ?? 0, mode: entry.mode ?? 0o755, isFile: () => entry.kind === 'file', isDirectory: () => (entry.kind ?? 'dir') === 'dir' };
      },
      executable: (path) => entries[path]?.exec !== false,
      uid: () => 501,
    };
  }
  const HOME_TREE = {
    '/Users': { uid: 0 },
    '/Users/me': { uid: 501, mode: 0o750 },
    '/Users/me/.local': { uid: 501 },
    '/Users/me/.local/bin': { uid: 501 },
    '/opt': { uid: 0 },
    '/opt/homebrew': { uid: 501 },
    '/opt/homebrew/bin': { uid: 501 },
    '/opt/homebrew/Cellar': { uid: 501 },
    '/opt/homebrew/Cellar/tor': { uid: 501 },
    '/opt/homebrew/Cellar/tor/bin': { uid: 501 },
    '/opt/homebrew/Cellar/tor/bin/tor': { uid: 501, kind: 'file' as const },
    '/opt/homebrew/bin/tor': { link: '/opt/homebrew/Cellar/tor/bin/tor' },
  };
  const BARE = { HOME: '/Users/me', PATH: '/nonexistent-olympus-path' };

  test('a fallback match runs as its canonical file only when this user or root owns it and every folder above it, none writable by others', () => {
    const trusted = fakeTrust({ ...HOME_TREE, '/Users/me/.local/bin/zkapi-clientd': { uid: 501, kind: 'file' } });
    expect(resolveExecutable('zkapi-clientd', undefined, BARE, 'darwin', trusted)).toBe('/Users/me/.local/bin/zkapi-clientd');
    // A Homebrew symlink resolves to the canonical Cellar file, which is what probe and session both run.
    expect(resolveExecutable('tor', undefined, BARE, 'darwin', trusted)).toBe('/opt/homebrew/Cellar/tor/bin/tor');
    // A world-writable folder in the chain: skipped.
    const worldWritable = fakeTrust({ ...HOME_TREE, '/Users/me/.local/bin': { uid: 501, mode: 0o777 }, '/Users/me/.local/bin/zkapi-clientd': { uid: 501, kind: 'file' } });
    expect(resolveExecutable('zkapi-clientd', undefined, BARE, 'darwin', worldWritable)).toBeUndefined();
    const groupWritable = fakeTrust({ ...HOME_TREE, '/Users/me': { uid: 501, mode: 0o770 }, '/Users/me/.local/bin/zkapi-clientd': { uid: 501, kind: 'file' } });
    expect(resolveExecutable('zkapi-clientd', undefined, BARE, 'darwin', groupWritable)).toBeUndefined();
    // A file owned by another account: skipped.
    const foreign = fakeTrust({ ...HOME_TREE, '/Users/me/.local/bin/zkapi-clientd': { uid: 502, kind: 'file' } });
    expect(resolveExecutable('zkapi-clientd', undefined, BARE, 'darwin', foreign)).toBeUndefined();
    const foreignFolder = fakeTrust({ ...HOME_TREE, '/opt/homebrew/Cellar/tor': { uid: 502 } });
    expect(resolveExecutable('tor', undefined, BARE, 'darwin', foreignFolder)).toBeUndefined();
    // A trusted-looking symlink to a file in a writable folder: skipped.
    const writableTarget = fakeTrust({
      ...HOME_TREE,
      '/tmp': { uid: 0, mode: 0o1777 },
      '/tmp/drop': { uid: 501, mode: 0o777 },
      '/tmp/drop/tor': { uid: 501, kind: 'file' },
      '/opt/homebrew/bin/tor': { link: '/tmp/drop/tor' },
    });
    expect(resolveExecutable('tor', undefined, BARE, 'darwin', writableTarget)).toBeUndefined();
    // Not executable, or a directory: skipped.
    expect(resolveExecutable('zkapi-clientd', undefined, BARE, 'darwin', fakeTrust({ ...HOME_TREE, '/Users/me/.local/bin/zkapi-clientd': { uid: 501, kind: 'file', exec: false } }))).toBeUndefined();
    expect(trustedFallbackExecutable('/Users/me/.local/bin', fakeTrust(HOME_TREE))).toBeUndefined();
    // Linux has no Homebrew folder in the list.
    expect(resolveExecutable('tor', undefined, { HOME: '/Users/me', PATH: '' }, 'linux', trusted)).toBeUndefined();
  });

  test('PATH and explicit paths behave as before: no ownership check, PATH wins, an explicit path is the only candidate', () => {
    const home = mkdtempSync(join(tmpdir(), 'olympus-zkapi-home-'));
    const pathDir = mkdtempSync(join(tmpdir(), 'olympus-zkapi-path-'));
    try {
      writeFileSync(join(pathDir, 'zkapi-clientd'), '#!/bin/sh\n');
      chmodSync(join(pathDir, 'zkapi-clientd'), 0o755);
      chmodSync(pathDir, 0o777);
      // Even a world-writable PATH folder is used as before: PATH is the operator's choice.
      expect(resolveExecutable('zkapi-clientd', undefined, { HOME: home, PATH: `/usr/bin:${pathDir}` }, 'darwin')).toBe(join(pathDir, 'zkapi-clientd'));
      expect(resolveExecutable('zkapi-clientd', join(home, 'missing'), { HOME: home, PATH: pathDir }, 'darwin')).toBeUndefined();
      expect(resolveExecutable('zkapi-clientd', join(pathDir, 'zkapi-clientd'), { HOME: home, PATH: '' }, 'darwin')).toBe(join(pathDir, 'zkapi-clientd'));
      // The real filesystem: a world-writable ~/.local/bin is never trusted.
      const local = join(home, '.local', 'bin');
      mkdirSync(local, { recursive: true });
      writeFileSync(join(local, 'tor'), '#!/bin/sh\n');
      chmodSync(join(local, 'tor'), 0o755);
      chmodSync(local, 0o777);
      expect(trustedFallbackExecutable(join(local, 'tor'))).toBeUndefined();
    } finally {
      chmodSync(pathDir, 0o700);
      rmSync(home, { recursive: true, force: true });
      rmSync(pathDir, { recursive: true, force: true });
    }
  });

  test('the readiness probe finds zkapi-clientd and tor in ~/.local/bin with the LaunchAgent\'s PATH, so neither reads as not installed', async () => {
    const local = join(root, '.local', 'bin');
    mkdirSync(local, { recursive: true });
    for (const name of ['tor', 'zkapi-clientd']) {
      writeFileSync(join(local, name), readFileSync(join(binDir, name)));
      chmodSync(join(local, name), 0o755);
    }
    const { daemonExecutable: _d, torExecutable: _t, ...unpinned } = settings();
    const ready = await zkapiConsultReadiness({ ...transport({ settings: unpinned as ZkapiConsultSettings }), env: { HOME: root, PATH: '/usr/bin:/bin:/usr/sbin:/sbin', ZKAPI_CLIENTD_CONFIG_DIR: configDir } });
    // Found exactly when the real folders above the temp HOME pass the trust check (a
    // world-writable /tmp, as on Linux runners, rightly fails it).
    const trusted = trustedFallbackExecutable(join(local, 'zkapi-clientd'));
    expect(ready.daemonExecutable).toBe(trusted);
    expect(ready.torExecutable).toBe(trustedFallbackExecutable(join(local, 'tor')));
    if (trusted) {
      expect(trusted).toBe(realpathSync(join(local, 'zkapi-clientd')));
      expect(ready.blockers).not.toContain('daemon_not_found');
      expect(ready.blockers).not.toContain('tor_not_found');
    } else {
      expect(ready.blockers).toContain('daemon_not_found');
    }
  });
});

describe('zkAPI consult transport: the daemon finds its wallet companion', () => {
  test('the daemon install folder leads PATH, resolved through symlinks', () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'zkapi-companion-')));
    try {
      const installBin = join(root, 'lib', 'current', 'bin');
      mkdirSync(installBin, { recursive: true });
      writeFileSync(join(installBin, 'zkapi-clientd'), '#!/bin/sh\n');
      const linkDir = join(root, 'bin');
      mkdirSync(linkDir);
      symlinkSync(join(installBin, 'zkapi-clientd'), join(linkDir, 'zkapi-clientd'));
      const env = daemonEnvironment({ HOME: '/home/x', PATH: `/usr/bin:${installBin}:/bin` }, join(linkDir, 'zkapi-clientd'));
      expect(env.PATH).toBe(`${installBin}:/usr/bin:/bin`);
      expect(env.HOME).toBe('/home/x');
      expect(daemonEnvironment({}, join(installBin, 'zkapi-clientd')).PATH).toBe(installBin);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
