/**
 * Shared fixture for the zkAPI consult transport tests: fake Tor and daemon
 * binaries, hermetic per-test state, and helpers. Split out of one 2.5k-line
 * file so its ~140 s of tests run in parallel across files.
 */
import { afterEach, beforeAll, beforeEach, expect, test } from 'bun:test';
import { spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultConfig } from '../../src/core/config.ts';
import {
  inspectLoopbackListener,
  openZkapiConsultSession,
  sendZkapiConsult,
  zkapiOutstandingFences,
  zkapiUsageToday,
  type ZkapiConfinement,
  type ZkapiConsultSession,
  type ZkapiConsultTransportOptions,
} from '../../src/core/consult-transport-zkapi.ts';
import { runDoctor, type DoctorCheck, type DoctorDeps } from '../../src/core/doctor.ts';
import { OperationError } from '../../src/core/operation-error.ts';
import {
  createSovereigntyEngine,
  loadSovereigntyPreset,
  type SovereigntyConfig,
} from '../../src/core/sovereignty.ts';
import {
  parseZkapiConsultSettings,
  ZKAPI_RISK_ACKNOWLEDGEMENTS,
  ZKAPI_RISK_ACKNOWLEDGEMENTS_VERSION,
  type ZkapiConsultSettings,
} from '../../src/core/zkapi-consult-settings.ts';
export const QUESTION = 'What is the usual notice period rule for ending a residential lease, across common durations?';
export const API_KEY = 'k'.repeat(40);
export const MODEL = 'openai/gpt-6-astra';
export const NOW = new Date('2026-10-05T12:00:00.000Z');
export const SLOW = 40_000;

// ---------------------------------------------------------------------------
// Stand-in executables

export const FAKE_TOR = `#!${process.execPath}
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

export const FAKE_DAEMON = `#!${process.execPath}
const fs = require('node:fs');
const net = require('node:net');
const dgram = require('node:dgram');
const { spawn } = require('node:child_process');
const dir = process.env.ZKAPI_CLIENTD_CONFIG_DIR;
const planPath = dir + '/plan.json';
const plan = fs.existsSync(planPath) ? JSON.parse(fs.readFileSync(planPath, 'utf8')) : { version: '0.1.6' };
if (process.argv[2] === '--version') { console.log('zkapi-clientd ' + plan.version); process.exit(0); }
if (process.argv[2] === 'serve' && process.argv[3] === '--help') { console.log(plan.noSupervisor ? 'Usage: serve' : '--relay-url --companion-proxy-listen --wallet-api-listen --require-managed-companion --require-companion-custody'); process.exit(0); }
if (process.argv[2] !== 'serve') process.exit(2);
const flagValue = (flag) => { const i = process.argv.indexOf(flag); return i < 0 ? undefined : process.argv[i + 1]; };
const proxyListen = flagValue('--companion-proxy-listen');
const walletListen = flagValue('--wallet-api-listen');
const supervised = Boolean(proxyListen && walletListen);
const transportStatus = supervised ? { kind: 'socks5', relay_endpoint: '127.0.0.1:' + plan.relayPort, companion: 'managed', wallet_custody: 'connection_owner_verified', connect_proxy: proxyListen, wallet_api: walletListen, ...plan.transportStatus } : undefined;
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
const tryUdp = () => new Promise((resolve) => { const s = dgram.createSocket('udp4'); const done = (value) => { try { s.close(); } catch {} resolve(value); }; s.once('error', () => done('denied')); s.send(Buffer.from([0]), 53, '192.0.2.1', (e) => done(e ? 'denied' : 'sent')); });
const tryResolver = () => new Promise((resolve) => { const s = net.createConnection({ path: '/private/var/run/mDNSResponder' }); s.once('connect', () => { s.destroy(); resolve('connected'); }); s.once('error', () => resolve('denied')); });
const json = (status, body, headers = {}) => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...headers } });
const err = (status, code, message = 'fixed daemon text') => json(status, { error: { message, type: code, code, param: null } }, status === 401 ? { 'WWW-Authenticate': 'Bearer' } : {});
let key = 0;
let request = 0;
(async () => {
  if (supervised) {
    const bind = (address) => Bun.listen({ hostname: '127.0.0.1', port: Number(address.split(':')[1]), socket: { open(s) { s.end(); }, data() {} } });
    bind(proxyListen);
    if (plan.walletBindDelayMs) setTimeout(() => bind(walletListen), plan.walletBindDelayMs);
    else bind(walletListen);
    event('supervisor ' + JSON.stringify(process.argv.slice(3)));
  }
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
    if (url.pathname === '/admin/status') return json(200, { backend: 'zkapi', network: 'mainnet', request_budget_policy: 'model', transport: transportStatus });
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

export let binDir: string;


/**
 * Distinct free ports. Every listener stays bound until all are chosen: two
 * separate picks can return the same port once the first is released, and a
 * daemon sharing Tor's port dies on its own listen.
 */
export function freePorts(count: number): number[] {
  const listeners = Array.from({ length: count }, () => Bun.listen({ hostname: '127.0.0.1', port: 0, socket: { data() {} } }));
  const ports = listeners.map((listener) => listener.port);
  for (const listener of listeners) listener.stop(true);
  return ports;
}

export function freePort(): number {
  return freePorts(1)[0]!;
}

export interface Plan {
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
  transportStatus?: Record<string, string>;
  noSupervisor?: boolean;
  walletBindDelayMs?: number;
}

/** Injected stand-in; the macOS test uses the real platform confinement. */
export const filteredConfinement: ZkapiConfinement = {
  level: 'loopback_filtered',
  limit: 'test confinement',
  wrap: (argv) => [...argv],
  selfTest: async () => true,
};
export const noConfinement: ZkapiConfinement = {
  level: 'none',
  limit: 'no network confinement is implemented on this platform',
  wrap: (argv) => [...argv],
  selfTest: async () => false,
};

export let root: string;
export let configDir: string;
export let statePath: string;
export let daemonPort: number;
export let torPort: number;
export let plan: Plan;
export const HERMETIC_ENV_KEYS = ['HOME', 'OLYMPUS_SOVEREIGNTY_CONFIG', 'OLYMPUS_SOVEREIGNTY_CONFIG_PATH', 'ZKAPI_CLIENTD_CONFIG_DIR', 'XDG_CONFIG_HOME'];
export let savedEnv: Record<string, string | undefined> = {};



export function writePlan(overrides: Partial<Plan> = {}): void {
  plan = { ...plan, ...overrides };
  writeFileSync(join(configDir, 'plan.json'), JSON.stringify(plan));
}

export function readLines(name: string): string[] {
  const path = join(configDir, name);
  return existsSync(path) ? readFileSync(path, 'utf8').trim().split('\n').filter(Boolean) : [];
}

export const events = (): string[] => readLines('events.log');
export const torRuns = (): string[] => readLines('tor-runs.log');

export function completions(): Array<{ body: string; auth: string; origin: string | null; countAtArrival: number; fenceAtArrival: boolean }> {
  return events().filter((line) => line.startsWith('completion ')).map((line) => JSON.parse(line.slice('completion '.length)));
}

export function settings(overrides: Partial<ZkapiConsultSettings> = {}): ZkapiConsultSettings {
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

export function transport(overrides: Partial<ZkapiConsultTransportOptions> = {}): ZkapiConsultTransportOptions {
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

export async function portFree(port: number): Promise<boolean> {
  try {
    const socket = await Bun.connect({ hostname: '127.0.0.1', port, socket: { data() {} } });
    socket.end();
    return false;
  } catch {
    return true;
  }
}

export const TRANSPORT_MODULE = join(import.meta.dir, '..', '..', 'src', 'core', 'consult-transport-zkapi.ts');

/** Runs one consult in a separate Bun process over the same ledger, without confinement. */
export function startConsultInChildProcess(options: ZkapiConsultTransportOptions) {
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

export async function runConsultInChildProcess(options: ZkapiConsultTransportOptions): Promise<unknown> {
  const child = startConsultInChildProcess(options);
  let out = '';
  child.stdout!.on('data', (chunk) => { out += String(chunk); });
  await new Promise((resolve) => child.on('exit', resolve));
  return JSON.parse(out.trim().split('\n').at(-1)!);
}

export function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export const NO_CONFINEMENT_LABEL = 'payment privacy; a fresh Tor client was started and the daemon reports SOCKS5 mode, but the actual route is not verified; no network confinement';

/** What each mocked operation advances virtual time by; distinct so a misplaced one shows. */
export const OP = { selfTest: 1, now: 2, healthz: 3, inspect: 5, unauthenticatedProbe: 7, adminStatus: 11, models: 13, dispatch: 17, body: 19 } as const;

/**
 * Virtual time for stage timings. Mocked operations advance it by their own
 * amount; read k of the clock returns the current time, then advances it by
 * k x 1000. A stage opened at read k and closed at read k + 1 therefore lasts
 * k x 1000 plus the operations that ran inside it.
 */
export function virtualTime() {
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

export function timedTransport(time: ReturnType<typeof virtualTime>, overrides: Partial<ZkapiConsultTransportOptions> = {}): ZkapiConsultTransportOptions {
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








// ---------------------------------------------------------------------------
// The one-shot session (design §A.8, stage C2): open warms the route before
// the question exists, send hands the reply over before settlement, finished
// settles and tears down, and nothing is reserved until dispatch.

export function ledger(): Record<string, any> {
  return existsSync(statePath) ? JSON.parse(readFileSync(statePath, 'utf8')) : {};
}

/** Nothing reserved, fenced or counted; the ledger may hold lifecycle records (a running session, a last session). */
export function expectNothingReserved(): void {
  expect(zkapiUsageToday(statePath, NOW)).toEqual({ count: 0, reservedMicroUsd: 0 });
  expect(zkapiOutstandingFences(statePath)).toEqual({});
}

export async function expectProcessesGone(): Promise<void> {
  expect(await portFree(daemonPort)).toBe(true);
  expect(await portFree(torPort)).toBe(true);
}

export async function openReady(overrides: Partial<ZkapiConsultTransportOptions> = {}): Promise<ZkapiConsultSession> {
  const opened = await openZkapiConsultSession(transport(overrides));
  if (!opened.ok) throw new Error(`open failed: ${opened.error.code}`);
  return opened.session;
}

export function settledFlag<T>(promise: Promise<T>): () => boolean {
  let settled = false;
  void promise.then(() => { settled = true; }, () => { settled = true; });
  return () => settled;
}


// ---------------------------------------------------------------------------
// Evidence adapters refuse the daemon at dispatch



// ---------------------------------------------------------------------------
// Sovereignty: a zkapi profile is consult-only

export function baseConfig(): Record<string, any> {
  return JSON.parse(JSON.stringify(loadSovereigntyPreset('local-first')));
}

export function zkapiProfile(overrides: Record<string, unknown> = {}): Record<string, any> {
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

export function configError(build: () => unknown): string {
  try {
    build();
  } catch (error) {
    expect(error).toBeInstanceOf(OperationError);
    expect((error as OperationError).code).toBe('config_error');
    return (error as OperationError).message;
  }
  throw new Error('expected a config_error');
}

export function engineWith(mutate: (config: Record<string, any>) => void) {
  const config = baseConfig();
  config.modelProfiles.zk = zkapiProfile();
  mutate(config);
  return createSovereigntyEngine(config as SovereigntyConfig);
}


// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Doctor

export function doctorDeps(profile: Record<string, unknown> = {}, env: Record<string, string> = {}): DoctorDeps {
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

export async function zkapiCheck(deps: DoctorDeps): Promise<DoctorCheck> {
  const check = (await runDoctor(deps)).checks.find((candidate) => candidate.name === 'zkapi_consult_transport');
  expect(check).toBeDefined();
  return check!;
}




/** Registers the shared fake-binary and per-test hermetic setup for the calling file. */
export function useZkapiHarness(): void {
  beforeAll(() => {
    binDir = mkdtempSync(join(tmpdir(), 'olympus-zkapi-bin-'));
    writeFileSync(join(binDir, 'tor'), FAKE_TOR);
    writeFileSync(join(binDir, 'zkapi-clientd'), FAKE_DAEMON);
    chmodSync(join(binDir, 'tor'), 0o755);
    chmodSync(join(binDir, 'zkapi-clientd'), 0o755);
    process.on('exit', () => rmSync(binDir, { recursive: true, force: true }));
  });
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
}
