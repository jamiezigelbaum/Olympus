// OLYMPUS_TEST_LANE: deploy
// Processes start in the transport under test (fake Tor and daemon), not in this file.
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

import { describe, expect, test } from 'bun:test';
import { spawn } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultConfig } from '../src/core/config.ts';
import type { EvidencePack } from '../src/core/contracts.ts';
import {
  daemonEnvironment,
  formatZkapiStageTable,
  inspectLoopbackListener,
  reserveZkapiRequest,
  resolveExecutable,
  sendZkapiConsult,
  standardExecutableDirectories,
  trustedFallbackExecutable,
  type ExecutableTrustProbe,
  zkapiConsultReadiness,
  zkapiFenceScope,
  zkapiUsageToday,
  type ZkapiConfinement,
} from '../src/core/consult-transport-zkapi.ts';
import { DelphiClient, DirectHttpDelphiTransport } from '../src/core/delphi.ts';
import { fetchModelEndpoint } from '../src/core/model-transport.ts';
import { ModelSetupService } from '../src/core/model-setup.ts';
import { connectGeminiApiKey } from '../src/core/connect.ts';
import { createSovereigntyEngine, type SovereigntyConfig } from '../src/core/sovereignty.ts';
import {
  assertNotZkapiDaemonEndpoint,
  assertNotZkapiDaemonEndpointResolved,
  ZKAPI_RISK_ACKNOWLEDGEMENTS,
  ZKAPI_RISK_ACKNOWLEDGEMENTS_VERSION,
  type ZkapiConsultSettings,
} from '../src/core/zkapi-consult-settings.ts';
import {
  assertSnifferProfileAllowed,
  resolveSnifferLane,
} from '../src/workers/classification/sniffer-lane.ts';
import { applyModelChoice } from '../src/workers/chatgpt/model-choice.ts';
import { requireLocalHttpBaseUrl } from '../src/workers/file-extraction/extractors/remote-vlm.ts';
import {
  OpenAICompatibleVlmClient,
} from '../src/workers/file-extraction/extractors/openai-compatible-client.ts';
import { OpenAICompatibleSourceEmbeddingProvider } from '../src/workers/source-index/embeddings.ts';
import {
  QUESTION,
  API_KEY,
  MODEL,
  NOW,
  SLOW,
  binDir,
  freePorts,
  freePort,
  filteredConfinement,
  root,
  configDir,
  statePath,
  daemonPort,
  torPort,
  writePlan,
  events,
  torRuns,
  completions,
  settings,
  transport,
  portFree,
  NO_CONFINEMENT_LABEL,
  OP,
  virtualTime,
  timedTransport,
  ledger,
  baseConfig,
  zkapiProfile,
  configError,
  engineWith,
  doctorDeps,
  zkapiCheck,
  useZkapiHarness,
} from './helpers/zkapi-transport-harness.ts';

useZkapiHarness();

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
