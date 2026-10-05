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
import { spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultConfig } from '../src/core/config.ts';
import type { EvidencePack } from '../src/core/contracts.ts';
import {
  recoverZkapiSession,
  reserveZkapiRequest,
  sendZkapiConsult,
  zkapiUnresolvedSession,
  zkapiUsageToday,
  type ZkapiConfinement,
  type ZkapiConsultTransportOptions,
} from '../src/core/consult-transport-zkapi.ts';
import { DelphiClient, type DelphiTransport } from '../src/core/delphi.ts';
import { runDoctor, type DoctorCheck, type DoctorDeps } from '../src/core/doctor.ts';
import { processInstanceIdentity, withFileLease } from '../src/core/file-lease.ts';
import { OperationError } from '../src/core/operation-error.ts';
import { createSovereigntyEngine, loadSovereigntyPreset, type SovereigntyConfig } from '../src/core/sovereignty.ts';
import {
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
    const companion = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1 << 30)'], { stdio: 'ignore' });
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
      event('completion ' + JSON.stringify({ body, auth: httpRequest.headers.get('authorization'), origin: httpRequest.headers.get('origin'), countAtArrival: state.count ?? 0, fenceAtArrival: Boolean(state.fence) }));
      const completion = (content) => json(200, { object: 'chat.completion', choices: [{ index: 0, message: { role: 'assistant', content } }] }, { 'X-OA-Verification-Status': 'verified' });
      if (plan.completion === 'error') return finish(err(400, 'model_budget_unavailable', 'echo: ' + body + ' ?secret=1'));
      key += 1;
      const ref = key;
      if (!plan.noKeyLog) log('request key selected request=' + id + ' key_ref=' + ref + ' source=' + (plan.reusedKey ? 'reused' : 'fresh'));
      if (!plan.noSettlement) setTimeout(() => {
        log('automatic settlement result key_ref=' + ref + ' ready=true duration=30ms');
        log('zkAPI OpenRouter key session ' + ref + ' ended (settled); cost: 0.000123 ETH; balance remaining: 0.004567 ETH');
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

function freePort(): number {
  const listener = Bun.listen({ hostname: '127.0.0.1', port: 0, socket: { data() {} } });
  const port = listener.port;
  listener.stop(true);
  return port;
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
  daemonPort = freePort();
  torPort = freePort();
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

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

const NO_CONFINEMENT_LABEL = 'payment privacy; inference through a fresh Tor client; no network confinement, so the daemon and companion route is not verified';

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
        reservedUsd: 6,
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
    expect(JSON.parse(ledger)).toMatchObject({ day: '2026-10-05', count: 1, reservedMicroUsd: 6_000_000, lastSession: { result: 'ok' } });
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
    const failingSelfTest: ZkapiConfinement = { ...filteredConfinement, selfTest: async () => false };
    expect(await sendZkapiConsult(QUESTION, transport({ confinement: failingSelfTest }))).toMatchObject({
      ok: true,
      networkIdentity: 'not_verified',
      routeLabel: NO_CONFINEMENT_LABEL,
      receipt: { confinementSelfTest: 'failed' },
    });
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
      if (result.ok) expect(result.routeLabel).toContain('loopback was not port-filtered');
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

  test('the session lease excludes another process holding it', async () => {
    mkdirSync(root, { recursive: true });
    await withFileLease(`${statePath}.session`, async () => {
      expect(await sendZkapiConsult(QUESTION, transport())).toMatchObject({ ok: false, error: { code: 'busy' } });
    });
    expect(events()).toEqual([]);
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

  test('a daemon that crashes leaves no descendant behind', async () => {
    writePlan({ companion: true, crashAfterCompletion: true, settleDelayMs: 2_000 });
    await sendZkapiConsult(QUESTION, transport({ settings: settings({ settleTimeoutMs: 1_000 }) }));
    const companion = Number(events().find((line) => line.startsWith('companion '))!.split(' ')[1]);
    expect(alive(companion)).toBe(false);
    expect(JSON.parse(readFileSync(statePath, 'utf8')).running).toBeUndefined();
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
      expect(await sendZkapiConsult(QUESTION, transport())).toMatchObject({ ok: true, receipt: { listedAllowanceUsd: 1, reservedUsd: 6 } });
    }
    expect(completions()).toHaveLength(11);
    // Still recorded for disclosure: each consult counts the $6 worst case.
    expect(zkapiUsageToday(statePath, NOW)).toEqual({ count: 11, reservedMicroUsd: 66_000_000 });
  }, 120_000);

  test('an owner-set money limit refuses at the boundary across a restart, counting the $6 worst case', async () => {
    writePlan({ allowance: 1_000_000 });
    const limited = settings({ dailySpendCapUsd: 13 });
    expect(await sendZkapiConsult(QUESTION, transport({ settings: limited }))).toMatchObject({ ok: true });
    // A fresh options object over the same ledger stands in for a restart.
    expect(await sendZkapiConsult(QUESTION, { ...transport({ settings: limited }) })).toMatchObject({ ok: true });
    expect(await sendZkapiConsult(QUESTION, transport({ settings: limited }))).toMatchObject({
      ok: false,
      error: { code: 'spend_cap_reached', outcome: 'not_sent' },
    });
    expect(completions()).toHaveLength(2);
    expect(zkapiUsageToday(statePath, NOW)).toEqual({ count: 2, reservedMicroUsd: 12_000_000 });
  }, SLOW);

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
// Evidence adapters refuse the daemon at dispatch

describe('evidence adapters refuse a zkAPI daemon endpoint where they dispatch', () => {
  test('an Argus lane chosen at runtime on the daemon port never dispatches', async () => {
    const config = defaultConfig();
    config.argus.lanes.deep.baseUrl = 'http://127.0.0.1:8787/v1';
    let dispatched = false;
    const transportDouble: DelphiTransport = {
      requestJson: async () => {
        dispatched = true;
        return {};
      },
    };
    const client = new DelphiClient(config, transportDouble);
    await expect(client.complete({ lane: 'deep', prompt: 'evidence' })).rejects.toMatchObject({ code: 'config_error' });
    expect(dispatched).toBe(false);
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
    await expect(embeddings.embed([{ text: 'evidence' }], { taskType: 'RETRIEVAL_DOCUMENT' })).rejects.toThrow(/zkAPI daemon/);
    expect(() => requireLocalHttpBaseUrl(`http://127.0.0.1:${port}/v1`, 'vision url')).toThrow(/zkAPI daemon port/);
    expect(() => new OpenAICompatibleVlmClient({ baseUrl: `http://127.0.0.1:${port}/v1`, model: 'm', fetchImpl: fetchDouble })).toThrow(/zkAPI daemon port/);
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
    expect(() => requireLocalHttpBaseUrl('http://127.0.0.1:8787/v1', 'vision url')).toThrow(/zkAPI daemon port/);
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
      'requests today 0 (no limit set), worst-case authorized today $0.00 (no limit set; each consult counts up to $6.00)',
      'no unresolved session',
      'balance, fee quotes and on-chain expiry not available from the daemon',
      'no consult run yet',
      'route: not yet verified',
    ]) expect(before.detail).toContain(part);
    expect(before.detail).toEndWith('; ready');
    expect(before.detail).not.toContain(API_KEY);
    expect(events()).toEqual([]);

    expect(await sendZkapiConsult(QUESTION, transport())).toMatchObject({ ok: true });
    const after = await zkapiCheck(doctorDeps());
    expect(after.detail).toContain('requests today 1 (no limit set), worst-case authorized today $6.00 (no limit set;');
    expect(after.detail).toContain('(ok): key reuse verified_off, local auth verified, Tor per_consult, confinement none (self-test not_run), settlement confirmed');
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

    reserveZkapiRequest(statePath, {}, NOW);
    reserveZkapiRequest(statePath, {}, NOW);
    reserveZkapiRequest(statePath, {}, NOW);
    // Without an owner-set limit, a high count blocks nothing; only the fence does.
    const unlimited = await zkapiCheck(doctorDeps());
    expect(unlimited.detail).toContain('requests today 3 (no limit set), worst-case authorized today $18.00 (no limit set;');
    expect(unlimited.detail).toContain('UNRESOLVED SESSION: run a recovery-only session');
    expect(unlimited.detail).toContain('not ready: unresolved_session');
    expect(unlimited.detail).not.toContain('spend_cap_reached');
    expect(unlimited.detail).not.toContain('daily_cap_reached');
    const exhausted = await zkapiCheck(doctorDeps({ zkapi: { dailyRequestCap: 5, dailySpendCapUsd: 20 } }));
    expect(exhausted.ok).toBe(false);
    expect(exhausted.detail).toContain('requests today 3 (limit 5), worst-case authorized today $18.00 (limit $20.00;');
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
