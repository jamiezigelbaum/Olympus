// zkAPI consult transport tests; shared fixture in ./helpers/zkapi-transport-harness.ts.
import { describe, expect, test } from 'bun:test';
import { chmodSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  recoverZkapiSession,
  sendZkapiConsult,
  abandonZkapiFence,
  zkapiOutstandingFences,
  zkapiUnresolvedSession,
} from '../src/core/consult-transport-zkapi.ts';
import {
  ZKAPI_RISK_ACKNOWLEDGEMENTS,
  ZKAPI_RISK_ACKNOWLEDGEMENTS_VERSION,
} from '../src/core/zkapi-consult-settings.ts';
import {
  QUESTION,
  API_KEY,
  NOW,
  SLOW,
  binDir,
  root,
  configDir,
  statePath,
  daemonPort,
  torPort,
  writePlan,
  completions,
  settings,
  transport,
  NO_CONFINEMENT_LABEL,
  ledger,
  baseConfig,
  zkapiProfile,
  useZkapiHarness,
} from './helpers/zkapi-transport-harness.ts';

useZkapiHarness();

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
