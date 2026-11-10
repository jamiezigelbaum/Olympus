// The zkAPI funding date: one public setter (`olympus zkapi funding-date`)
// that writes sovereignty.json under the policy file lease, and a live read
// the running worker uses, so a renewal needs no hand edit and no restart
// (#846).
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { withFileLeaseSync } from '../src/core/file-lease.ts';
import { V0_4_PUBLIC_CLI_COMMANDS } from '../src/core/public-surface.ts';
import { loadSovereigntyPreset, type SovereigntyConfig } from '../src/core/sovereignty.ts';
import { ZKAPI_RISK_ACKNOWLEDGEMENTS, ZKAPI_RISK_ACKNOWLEDGEMENTS_VERSION } from '../src/core/zkapi-consult-settings.ts';
import { setZkapiFundingDate, zkapiFundingDateRefresher } from '../src/core/zkapi-funding-date.ts';
import { createDashboardConsultAdapter } from '../src/workers/email-source/dashboard-consult.ts';

const ALL_IDS = ZKAPI_RISK_ACKNOWLEDGEMENTS.map((item) => item.id);
const homes: string[] = [];
afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

function policy(zkapi = true): SovereigntyConfig {
  const config = structuredClone(loadSovereigntyPreset('private-cloud-only')) as SovereigntyConfig;
  if (zkapi) {
    (config.modelProfiles as Record<string, unknown>)['zkapi-consult'] = {
      provider: 'zkapi',
      trust: 'standard_cloud',
      purpose: 'consult',
      baseUrl: 'http://127.0.0.1:8787/v1',
      model: 'openai/gpt-5-mini',
      secretRef: 'env:OLYMPUS_ZKAPI_API_KEY',
      zkapi: { fundingDate: '2026-10-01', dailyRequestCap: 5, acknowledgements: { version: ZKAPI_RISK_ACKNOWLEDGEMENTS_VERSION, accepted: ALL_IDS } },
    };
  }
  return config;
}

function policyFile(zkapi = true): { home: string; path: string; config: SovereigntyConfig } {
  const home = mkdtempSync(join(tmpdir(), 'olympus-zkapi-funding-'));
  homes.push(home);
  const dir = join(home, '.olympus');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, 'sovereignty.json');
  const config = policy(zkapi);
  writeFileSync(path, JSON.stringify(config), { mode: 0o600 });
  return { home, path, config };
}

const fileZkapi = (path: string) => (JSON.parse(readFileSync(path, 'utf8')) as SovereigntyConfig).modelProfiles['zkapi-consult']?.zkapi;

describe('setZkapiFundingDate', () => {
  test('writes only the funding date of the one zkapi route and keeps everything else', () => {
    const { path } = policyFile();
    const before = JSON.parse(readFileSync(path, 'utf8')) as SovereigntyConfig;
    const result = setZkapiFundingDate({ path, date: '2026-11-10' });
    expect(result).toMatchObject({ ok: true, changed: true, fundingDate: '2026-11-10', previous: '2026-10-01', profileId: 'zkapi-consult' });
    const after = JSON.parse(readFileSync(path, 'utf8')) as SovereigntyConfig;
    expect(after.modelProfiles['zkapi-consult']?.zkapi).toMatchObject({ fundingDate: '2026-11-10', dailyRequestCap: 5, acknowledgements: { version: ZKAPI_RISK_ACKNOWLEDGEMENTS_VERSION } });
    expect(Object.keys(after.modelProfiles).sort()).toEqual(Object.keys(before.modelProfiles).sort());
    // The same date again changes nothing.
    expect(setZkapiFundingDate({ path, date: '2026-11-10' })).toMatchObject({ ok: true, changed: false });
  });

  test('refuses an impossible or misformatted date and writes nothing', () => {
    const { path } = policyFile();
    const before = readFileSync(path, 'utf8');
    for (const date of ['2026-02-30', '2026-1-05', '10/11/2026', '']) {
      expect(setZkapiFundingDate({ path, date })).toMatchObject({ ok: false, code: 'funding_date_invalid' });
    }
    expect(readFileSync(path, 'utf8')).toBe(before);
  });

  test('refuses when the policy has no zkapi route', () => {
    const { path } = policyFile(false);
    const before = readFileSync(path, 'utf8');
    expect(setZkapiFundingDate({ path, date: '2026-11-10' })).toMatchObject({ ok: false, code: 'route_not_configured' });
    expect(readFileSync(path, 'utf8')).toBe(before);
  });

  test('takes the policy file lease: a held lease refuses as busy and nothing is written', () => {
    const { path } = policyFile();
    const before = readFileSync(path, 'utf8');
    const result = withFileLeaseSync(path, () => setZkapiFundingDate({ path, date: '2026-11-10' }), { acquireTimeoutMs: 1_000 });
    expect(result).toMatchObject({ ok: false, code: 'policy_busy' });
    expect(readFileSync(path, 'utf8')).toBe(before);
  }, 20_000);
});

describe('zkapiFundingDateRefresher (the running worker)', () => {
  test('follows the file: a date set after boot is used without a restart, and the boot policy is not mutated', () => {
    const { path, config } = policyFile();
    const live = zkapiFundingDateRefresher(path);
    expect(live(config.modelProfiles)['zkapi-consult']?.zkapi?.fundingDate).toBe('2026-10-01');
    expect(setZkapiFundingDate({ path, date: '2026-11-10' }).ok).toBe(true);
    const refreshed = live(config.modelProfiles);
    expect(refreshed['zkapi-consult']?.zkapi).toMatchObject({ fundingDate: '2026-11-10', dailyRequestCap: 5 });
    expect(config.modelProfiles['zkapi-consult']?.zkapi?.fundingDate).toBe('2026-10-01');
    // Other profiles pass through untouched.
    for (const [id, profile] of Object.entries(config.modelProfiles)) {
      if (id !== 'zkapi-consult') expect(refreshed[id]).toBe(profile);
    }
  });

  test('keeps the last good date when the file is unreadable or holds an invalid date', () => {
    const { path, config } = policyFile();
    const live = zkapiFundingDateRefresher(path);
    expect(setZkapiFundingDate({ path, date: '2026-11-10' }).ok).toBe(true);
    expect(live(config.modelProfiles)['zkapi-consult']?.zkapi?.fundingDate).toBe('2026-11-10');
    writeFileSync(path, '{ not json');
    expect(live(config.modelProfiles)['zkapi-consult']?.zkapi?.fundingDate).toBe('2026-11-10');
    const bad = policy();
    (bad.modelProfiles['zkapi-consult']!.zkapi as { fundingDate?: string }).fundingDate = '2026-02-30';
    writeFileSync(path, JSON.stringify(bad));
    expect(live(config.modelProfiles)['zkapi-consult']?.zkapi?.fundingDate).toBe('2026-11-10');
    rmSync(path);
    expect(live(config.modelProfiles)['zkapi-consult']?.zkapi?.fundingDate).toBe('2026-11-10');
  });

  test('without a policy file the boot profiles are returned as they are', () => {
    const config = policy();
    expect(zkapiFundingDateRefresher(undefined)(config.modelProfiles)).toBe(config.modelProfiles);
  });
});

describe('the dashboard follows a date set from the command line', () => {
  test('status and the readiness probe use the new date without a restart', async () => {
    const { home, path, config } = policyFile();
    const probes: Array<{ settings: { fundingDate?: string } }> = [];
    const reloads: number[] = [];
    const backend = createDashboardConsultAdapter({
      sovereignty: { config, source: 'file', path },
      secretPresent: () => false,
      requestReload: () => { reloads.push(1); return true; },
      env: { HOME: home },
      statePath: join(home, '.olympus', 'zkapi-consult-state.json'),
      now: () => new Date('2026-11-10T12:00:00.000Z'),
      readiness: async (options) => { probes.push(options as never); throw new Error('probe only'); },
      recoverSession: async () => ({ ok: false, error: { code: 'transport_failed', message: 'x', outcome: 'not_sent', networkIdentity: 'not_verified' } }) as never,
      confinement: { level: 'confined', limit: 'test', check: async () => ({ ok: true }) } as never,
    });
    expect((await backend.status()).route).toMatchObject({ fundingDate: '2026-10-01' });
    expect(setZkapiFundingDate({ path, date: '2026-11-10' }).ok).toBe(true);
    expect((await backend.status()).route).toMatchObject({ fundingDate: '2026-11-10' });
    expect(probes.at(-1)?.settings.fundingDate).toBe('2026-11-10');
    expect(reloads).toEqual([]);
  });
});

describe('olympus zkapi funding-date', () => {
  test('is a public CLI command', () => {
    expect(V0_4_PUBLIC_CLI_COMMANDS).toContain('zkapi funding-date');
  });

  async function run(args: string[], env: Record<string, string>): Promise<{ stdout: string; stderr: string; code: number }> {
    const proc = Bun.spawn(['bin/olympus', ...args], { cwd: join(import.meta.dir, '..'), env: { PATH: process.env.PATH ?? '', ...env }, stdout: 'pipe', stderr: 'pipe' });
    const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    return { stdout, stderr, code };
  }

  test('sets the date in the policy file the worker reads', async () => {
    const { home, path } = policyFile();
    const env = { HOME: home, OLYMPUS_SOVEREIGNTY_CONFIG: path };
    const set = await run(['zkapi', 'funding-date', '2026-11-10'], env);
    expect(set.code).toBe(0);
    expect(set.stdout).toContain('2026-11-10');
    expect(fileZkapi(path)?.fundingDate).toBe('2026-11-10');
    const bad = await run(['zkapi', 'funding-date', '2026-02-30'], env);
    expect(bad.code).not.toBe(0);
    expect(fileZkapi(path)?.fundingDate).toBe('2026-11-10');
    const none = await run(['zkapi', 'funding-date'], env);
    expect(none.code).not.toBe(0);
  }, 30_000);
});
