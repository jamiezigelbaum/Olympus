// OLYMPUS_TEST_LANE: deploy
// The release check's upgrade leg: the comparisons (pure), the settle rule that depends on the privacy policy, and the whole
// flow against a scripted stand-in for a machine, including the two self-tests that must fail the run.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FIXTURE_ITEMS } from '../scripts/release-check/fixture.ts';
import { isSettled, privateEmbeddedUnder, type AgentConfig } from '../scripts/release-check/machine-agent.ts';
import { newRunId, parseCli, runReleaseCheck, UPGRADE_SELFTEST_FAILS, type RunConfigFile } from '../scripts/release-check/run.ts';
import {
  compareItems, describeDifferences, differingPaths, evaluateCounts, evaluateUpgrade, isKeywordOnlyPrivate, isLocalMeaningPrivate,
  sha256Hex, versionFromTarballName, withoutMigratedParts,
  type ItemRow, type StateSnapshot,
} from '../scripts/release-check/upgrade.ts';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const OLD_POLICY: any = {
  schemaVersion: 1,
  modelProfiles: {
    'built-in-embedding': { provider: 'built-in', trust: 'local', model: 'embeddinggemma-2-litert-24d962e', purpose: 'embedding' },
    'cloud-openclaw-infer': { provider: 'openclaw-infer', trust: 'standard_cloud', purpose: 'analyst' },
  },
  routes: {
    internal: { pool: { members: ['cloud-openclaw-infer'], order: ['cloud-openclaw-infer'] } },
    secure_local: { pool: { members: [] }, mode: 'disabled', disabledReason: 'keeps secure-classified items metadata-only until a lane is configured.' },
  },
  retrieval: {
    trustDomains: {
      internal: { minimumExecutionTrust: 'standard_cloud', allowedEmbeddingTrust: ['local', 'standard_cloud'], allowCloudQuery: false, embeddingProfile: 'built-in-embedding', activationMode: 'hybrid_shadow' },
      secure_local: { minimumExecutionTrust: 'local', allowedEmbeddingTrust: ['local'], allowCloudQuery: false, embeddingProfile: null, activationMode: 'metadata_only', secureHandling: 'metadata_only_gap' },
    },
  },
};

/** What the 1.0.1 migration does to the default: the Private block and its explanatory text, nothing else. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function migrated(policy: any): any {
  const next = JSON.parse(JSON.stringify(policy));
  next.retrieval.trustDomains.secure_local = { ...next.retrieval.trustDomains.secure_local, embeddingProfile: 'built-in-embedding', activationMode: 'hybrid_shadow' };
  next.routes.secure_local.disabledReason = 'keeps Private search on this computer.';
  return next;
}

const ITEMS: ItemRow[] = [
  { store: 'a', id: 'doc-1', tier: 'internal', tombstoned: 0, contentHash: 'h1', metadataTier: 'personal', contentTier: 'personal' },
  { store: 'b', id: 'doc-2', tier: 'secure_local', tombstoned: 0, contentHash: 'h2', metadataTier: 'private', contentTier: 'private' },
];

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function snapshot(version: string, policy: any, overrides: Partial<StateSnapshot> = {}, backups: Array<{ name: string; sha256: string }> = []): StateSnapshot {
  const text = `${JSON.stringify(policy, null, 2)}\n`;
  return {
    version, build: `${version}+abc`, engineState: 'running', installId: 'install-1', relayConnected: true,
    policy: { sha256: sha256Hex(text), json: policy, backups },
    configFiles: ['engine.json', 'sovereignty.json', 'worker.env'],
    workerEnvKeys: ['OLYMPUS_WORKER_AUTH_TOKEN', 'OLYMPUS_SOURCE_INDEX_READWISE_API_V2_BASE_URL'],
    tierRuleIds: ['rc-private', 'rc-secrets'], connections: ['conn-1'],
    items: ITEMS, dashboard: { seen: 4, indexed: 4, contentReady: 3, embedded: 2, secretsLocated: 1, personal: 2, privateItems: 1 },
    ...overrides,
  };
}

const before = (): StateSnapshot => snapshot('1.0.0', OLD_POLICY);
const goodAfter = (): StateSnapshot => {
  const b = before();
  return snapshot('1.0.1', migrated(OLD_POLICY), { configFiles: ['engine.json', 'sovereignty.json', 'sovereignty.json.backup-private-meaning-x', 'worker.env'] }, [{ name: 'sovereignty.json.backup-private-meaning-x', sha256: b.policy!.sha256 }]);
};
const failing = (checks: ReturnType<typeof evaluateUpgrade>): string[] => checks.filter((c) => c.status === 'fail').map((c) => c.id);

describe('upgrade comparisons', () => {
  test('a clean update of the earlier default passes every check', () => {
    const checks = evaluateUpgrade(before(), goodAfter(), { fromVersion: '1.0.0', toVersion: '1.0.1' });
    expect(failing(checks)).toEqual([]);
    expect(checks.map((c) => c.id)).toEqual([
      'upgrade.version', 'upgrade.engine-running', 'upgrade.install-identity', 'upgrade.baseline-default', 'upgrade.privacy-migration',
      'upgrade.settings-kept', 'upgrade.tier-rules-kept', 'upgrade.worker-settings-kept', 'upgrade.connection-kept', 'upgrade.items-kept',
    ]);
  });

  test('the migration that did not happen is a failure of the migration check alone', () => {
    // The shape of the real finding: the engine started, kept the old policy, and wrote no backup.
    const stuck = snapshot('1.0.1', OLD_POLICY);
    const checks = evaluateUpgrade(before(), stuck, { fromVersion: '1.0.0', toVersion: '1.0.1' });
    expect(failing(checks)).toEqual(['upgrade.privacy-migration']);
    expect(checks.find((c) => c.id === 'upgrade.privacy-migration')!.detail).toContain('metadata_only');
  });

  test('a migrated policy without a backup of the original bytes fails; so does a backup of other bytes', () => {
    const noBackup = snapshot('1.0.1', migrated(OLD_POLICY));
    expect(failing(evaluateUpgrade(before(), noBackup))).toEqual(['upgrade.privacy-migration']);
    const wrongBackup = snapshot('1.0.1', migrated(OLD_POLICY), {}, [{ name: 'sovereignty.json.backup-x', sha256: sha256Hex('something else') }]);
    expect(failing(evaluateUpgrade(before(), wrongBackup))).toEqual(['upgrade.privacy-migration']);
  });

  test('a setting the owner changed that the update reset is caught, and the migration alone may move the Private block', () => {
    const reset = migrated(OLD_POLICY);
    reset.retrieval.trustDomains.internal.allowCloudQuery = true;
    const b = before();
    const after = snapshot('1.0.1', reset, {}, [{ name: 'sovereignty.json.backup-x', sha256: b.policy!.sha256 }]);
    const checks = evaluateUpgrade(b, after);
    expect(failing(checks)).toEqual(['upgrade.settings-kept']);
    expect(checks.find((c) => c.id === 'upgrade.settings-kept')!.detail).toContain('retrieval.trustDomains.internal.allowCloudQuery');
  });

  describe('a baseline the earlier release already migrated (1.0.1 to a later release)', () => {
    const migratedBefore = (): StateSnapshot => snapshot('1.0.1', migrated(OLD_POLICY), { configFiles: ['engine.json', 'sovereignty.json', 'sovereignty.json.backup-private-meaning-x', 'worker.env'] }, [{ name: 'sovereignty.json.backup-private-meaning-x', sha256: sha256Hex('first-run original') }]);
    const noOpAfter = (): StateSnapshot => ({ ...migratedBefore(), version: '1.1.0', build: '1.1.0+abc' });

    test('no migration needed and none done passes: the policy is unchanged and no second backup appears', () => {
      const checks = evaluateUpgrade(migratedBefore(), noOpAfter(), { fromVersion: '1.0.1', toVersion: '1.1.0' });
      expect(failing(checks)).toEqual([]);
      expect(checks.find((c) => c.id === 'upgrade.baseline-default')!.detail).toContain('already on the new default');
      expect(checks.find((c) => c.id === 'upgrade.privacy-migration')!.detail).toContain('no new backup was written');
    });

    test('a second backup, a changed Private block, or a policy that fell back to keyword-only each fail the migration check', () => {
      const second = noOpAfter();
      second.policy = { ...second.policy!, backups: [...second.policy!.backups, { name: 'sovereignty.json.backup-private-meaning-y', sha256: sha256Hex('again') }] };
      expect(failing(evaluateUpgrade(migratedBefore(), second))).toEqual(['upgrade.privacy-migration']);
      expect(evaluateUpgrade(migratedBefore(), second).find((c) => c.id === 'upgrade.privacy-migration')!.detail).toContain('1 new backup file(s)');
      // The Private block itself changed (still local meaning, but another field moved): a no-op must not touch it.
      const touched = noOpAfter();
      touched.policy = { ...touched.policy!, json: { ...touched.policy!.json, routes: { ...touched.policy!.json.routes, secure_local: { ...touched.policy!.json.routes.secure_local, disabledReason: 'rewritten' } } } };
      expect(failing(evaluateUpgrade(migratedBefore(), touched))).toEqual(['upgrade.privacy-migration']);
      const regressed = { ...noOpAfter(), policy: { ...noOpAfter().policy!, json: OLD_POLICY } };
      expect(failing(evaluateUpgrade(migratedBefore(), regressed))).toContain('upgrade.privacy-migration');
    });
  });

  test('what a newer release adds to the data folder shows in the differences table, and nothing else does', () => {
    const a = { ...before(), dataFiles: ['connector.sqlite'] };
    const b = { ...goodAfter(), dataFiles: ['connector.sqlite', 'private-answers.sqlite'] };
    expect(describeDifferences(a, b).find((row) => row.what === 'Files in the data folder')).toEqual({ what: 'Files in the data folder', before: '1', after: '2: +private-answers.sqlite -none' });
    expect(describeDifferences({ ...a }, { ...a }).some((row) => row.what === 'Files in the data folder')).toBe(false);
  });

  test('an install that was not on the earlier default cannot have its migration checked', () => {
    const custom = JSON.parse(JSON.stringify(OLD_POLICY));
    custom.retrieval.trustDomains.secure_local.activationMode = 'lexical_only';
    const checks = evaluateUpgrade(snapshot('1.0.0', custom), snapshot('1.0.1', custom));
    expect(failing(checks)).toContain('upgrade.baseline-default');
    expect(failing(checks)).toContain('upgrade.privacy-migration');
  });

  test('lost tier rules, a lost connection, a lost engine setting and a changed install id each fail their own check', () => {
    const a = goodAfter();
    expect(failing(evaluateUpgrade(before(), { ...a, tierRuleIds: [] }))).toEqual(['upgrade.tier-rules-kept']);
    expect(failing(evaluateUpgrade(before(), { ...a, connections: [] }))).toEqual(['upgrade.connection-kept']);
    expect(failing(evaluateUpgrade(before(), { ...a, workerEnvKeys: ['OLYMPUS_WORKER_AUTH_TOKEN'] }))).toEqual(['upgrade.worker-settings-kept']);
    expect(failing(evaluateUpgrade(before(), { ...a, installId: 'install-2' }))).toEqual(['upgrade.install-identity']);
    expect(failing(evaluateUpgrade(before(), { ...a, engineState: 'failed' }))).toEqual(['upgrade.engine-running']);
  });

  test('the version must change to the expected one; an update that left the old version fails', () => {
    expect(failing(evaluateUpgrade(before(), { ...goodAfter(), version: '1.0.0' }, { fromVersion: '1.0.0', toVersion: '1.0.1' }))).toEqual(['upgrade.version']);
    expect(failing(evaluateUpgrade(before(), { ...goodAfter(), version: '1.0.2' }, { fromVersion: '1.0.0', toVersion: '1.0.1' }))).toEqual(['upgrade.version']);
    expect(failing(evaluateUpgrade({ ...before(), version: '0.9.0' }, goodAfter(), { fromVersion: '1.0.0', toVersion: '1.0.1' }))).toEqual(['upgrade.version']);
  });

  test('items: a missing item, a new one, or a changed tier or content digest fails; unreadable items fail rather than pass', () => {
    const a = goodAfter();
    expect(compareItems(ITEMS, ITEMS)).toEqual({ missing: [], added: [], changed: [] });
    expect(failing(evaluateUpgrade(before(), { ...a, items: ITEMS.slice(0, 1) }))).toEqual(['upgrade.items-kept']);
    expect(failing(evaluateUpgrade(before(), { ...a, items: [...ITEMS, { store: 'a', id: 'doc-3', tier: 'internal', tombstoned: 0, contentHash: 'h3' }] }))).toEqual(['upgrade.items-kept']);
    expect(compareItems(ITEMS, [ITEMS[0]!, { ...ITEMS[1]!, tier: 'internal' }]).changed).toEqual(['b/doc-2']);
    expect(compareItems(ITEMS, [ITEMS[0]!, { ...ITEMS[1]!, contentHash: 'other' }]).changed).toEqual(['b/doc-2']);
    expect(compareItems(ITEMS, [ITEMS[0]!, { ...ITEMS[1]!, tombstoned: 1 }]).changed).toEqual(['b/doc-2']);
    const unreadable = evaluateUpgrade(before(), { ...a, items: null, itemsError: 'database is locked' });
    expect(failing(unreadable)).toEqual(['upgrade.items-kept']);
    expect(unreadable.find((c) => c.id === 'upgrade.items-kept')!.detail).toContain('database is locked');
  });

  test('counts: equal counts pass and embedded may grow; a changed count, or embedded falling, fails', () => {
    const was = { seen: 4, indexed: 4, contentReady: 3, embedded: 2, secretsLocated: 1, personal: 2, privateItems: 1 };
    const ok = evaluateCounts(was, { ...was, embedded: 3 });
    expect(ok[0]!.status).toBe('pass');
    expect(ok[0]!.detail).toContain('embedded 2 -> 3');
    expect(evaluateCounts(was, { ...was, seen: 5 })[0]!.status).toBe('fail');
    expect(evaluateCounts(was, { ...was, privateItems: 0 })[0]!.status).toBe('fail');
    expect(evaluateCounts(was, { ...was, embedded: 1 })[0]!.status).toBe('fail');
    expect(evaluateCounts(null, was)[0]!.status).toBe('fail');
  });

  test('the differences table lists what changed and nothing that did not', () => {
    const rows = describeDifferences(before(), goodAfter());
    const whats = rows.map((row) => row.what);
    expect(whats).toContain('Version');
    expect(whats).toContain('Private search setting');
    expect(whats).toContain('Policy backups beside the policy file');
    expect(whats).toContain('Files in the config folder');
    expect(whats).not.toContain('Items embedded');
    expect(describeDifferences(before(), before())).toEqual([]);
  });

  test('helpers: policy shapes, path diffs, tarball names', () => {
    expect(isKeywordOnlyPrivate(before().policy)).toBe(true);
    expect(isLocalMeaningPrivate(before().policy)).toBe(false);
    expect(isLocalMeaningPrivate(goodAfter().policy)).toBe(true);
    expect(withoutMigratedParts(OLD_POLICY)).toEqual(withoutMigratedParts(migrated(OLD_POLICY)));
    expect(differingPaths({ a: { b: 1, c: [1, 2] } }, { a: { b: 2, c: [1, 3] } })).toEqual(['a.b', 'a.c.1']);
    expect(versionFromTarballName('olympus-1.0.1.tgz')).toBe('1.0.1');
    expect(versionFromTarballName('olympus-1.0.1-rc.2.tgz')).toBe('1.0.1-rc.2');
    expect(versionFromTarballName('olympus-latest.tgz')).toBeUndefined();
  });
});

describe('what "settled" means under each privacy policy', () => {
  const config = { expectedItems: 4, expectedSecrets: 1, expectedPrivate: 1 } as AgentConfig;
  const settled = { lastRun: 'completed', seen: 4, indexed: 4, contentReady: 3, embedded: 2, secretsLocated: 1, pending: 0, queueWaiting: 0, queueActive: 0, personal: 2, privateItems: 1, missingChunks: 0 };

  test('keyword-only Private search never embeds the Private item; the new default must', () => {
    expect(privateEmbeddedUnder(OLD_POLICY as never)).toBe(false);
    expect(privateEmbeddedUnder(migrated(OLD_POLICY) as never)).toBe(true);
    expect(privateEmbeddedUnder(null)).toBe(true);
    expect(isSettled(settled, config, false)).toBe(true);
    // Under the new default the same counts are not settled: the Private item still lacks its embedding.
    expect(isSettled(settled, config, true)).toBe(false);
    expect(isSettled({ ...settled, embedded: 3 }, config, true)).toBe(true);
    // The default argument is the fresh-install rule that existed before the upgrade leg.
    expect(isSettled({ ...settled, embedded: 3 }, config)).toBe(true);
  });

  test('anything still pending is not settled under either policy', () => {
    expect(isSettled({ ...settled, pending: 1 }, config, false)).toBe(false);
    expect(isSettled({ ...settled, missingChunks: 2 }, config, false)).toBe(false);
    expect(isSettled({ ...settled, lastRun: 'running' }, config, false)).toBe(false);
    expect(isSettled(undefined, config, false)).toBe(false);
  });
});

describe('upgrade run arguments', () => {
  test('--upgrade-from needs an existing directory; a self-test needs --upgrade-from and a known mode; it cannot be mixed with the leak self-test', () => {
    const dir = mkdtempSync(join(tmpdir(), 'rc-upgrade-cli-'));
    try {
      const config = join(dir, 'config.json');
      writeFileSync(config, JSON.stringify({ driver: ['/bin/true'] }));
      const base = ['--config', config, '--candidate', dir, '--out', join(dir, 'out')];
      expect(parseCli([...base, '--upgrade-from', dir]).upgradeFromDir).toBe(dir);
      expect(parseCli([...base, '--upgrade-from', dir, '--upgrade-selftest', 'lose-tier-rules']).upgradeSelftest).toBe('lose-tier-rules');
      expect(parseCli(base).upgradeFromDir).toBeUndefined();
      expect(() => parseCli([...base, '--upgrade-from', join(dir, 'missing')])).toThrow('must exist');
      expect(() => parseCli([...base, '--upgrade-selftest', 'lose-tier-rules'])).toThrow('only goes with --upgrade-from');
      expect(() => parseCli([...base, '--upgrade-from', dir, '--upgrade-selftest', 'explode'])).toThrow('one of');
      expect(() => parseCli([...base, '--upgrade-from', dir, '--mistier', 'private'])).toThrow('separate self-tests');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// The whole flow against a scripted machine

const SCRIPTED_DRIVER = String.raw`#!/usr/bin/env bun
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
const [verb, ...rest] = process.argv.slice(2);
const state = process.env.FAKE_STATE;
const log = (line) => appendFileSync(state + '/driver.log', line + '\n');
log([verb, ...rest].join(' '));
const flag = (name) => existsSync(state + '/' + name);
const mark = (name) => writeFileSync(state + '/' + name, '');
const arg = (name) => rest[rest.indexOf(name) + 1];
const OLD = JSON.parse(readFileSync(process.env.FAKE_OLD_POLICY, 'utf8'));
const NEW = JSON.parse(readFileSync(process.env.FAKE_NEW_POLICY, 'utf8'));
const sha = (value) => new Bun.CryptoHasher('sha256').update(value).digest('hex');
const oldText = JSON.stringify(OLD, null, 2) + '\n';
if (verb === 'provision') {
  console.log('{"machine":"fake-' + arg('--run-id') + '","label":"Scripted machine","os":"linux","driver":"fake"}');
} else if (verb === 'upgrade') {
  if (process.env.FAKE_UPGRADE_FAIL === '1') { console.error('the installer failed'); process.exit(1); }
  mark('upgraded');
} else if (verb === 'exec') {
  const script = await new Response(Bun.stdin.stream()).text();
  const sub = /agent\.js (\S+)/.exec(script)?.[1];
  const upgraded = flag('upgraded');
  const say = (value) => console.log(JSON.stringify(value));
  const life = JSON.parse(readFileSync(state + '/life.json', 'utf8'));
  const migrated = upgraded && process.env.FAKE_NO_MIGRATION !== '1';
  const counts = { seen: life.seen, indexed: life.stored, contentReady: life.stored, embedded: migrated ? life.stored : life.stored - life.privateItems, secretsLocated: life.secrets, pending: 0, queueWaiting: 0, queueActive: 0, personal: life.personal, privateItems: life.privateItems, lastRun: 'completed', missingChunks: 0 };
  if (sub === 'engine-build') say({ ok: true, build: (upgraded ? '1.0.1' : '1.0.0') + '+abc', version: upgraded ? '1.0.1' : '1.0.0', remoteMode: 'relay', relay: {} });
  else if (sub === 'prepare-source') say({ ok: true, rules: 2, engineReadyMs: 1000 });
  else if (sub === 'connect-source') say({ ok: true, message: 'Connected' });
  else if (sub === 'sync') say({ ok: true, status: 200 });
  else if (sub === 'settle') say({ ok: true, settled: true, polls: 2, waitedMs: 1000, snapshot: counts });
  else if (sub === 'mcp-token') say({ ok: true, connection: 'conn-1' });
  else if (sub === 'mcp-tools') say({ ok: process.env.FAKE_TOKEN_REFUSED !== '1' || !upgraded, tools: process.env.FAKE_TOKEN_REFUSED === '1' && upgraded ? [] : [{ name: 'olympus_search', annotations: { readOnlyHint: true } }] });
  else if (sub === 'set-policy-setting') { mark('setting'); say({ ok: true, changed: 'retrieval.trustDomains.internal.allowCloudQuery', value: false }); }
  else if (sub === 'upgrade-selftest') { const mode = /--mode (\S+)/.exec(script)?.[1]; mark(mode); say({ ok: true, mode }); }
  else if (sub === 'await-engine') say({ ok: true, readyMs: 2000 });
  else if (sub === 'snapshot-state') {
    const migratedNow = upgraded && process.env.FAKE_NO_MIGRATION !== '1' && !flag('revert-policy');
    const policy = migratedNow ? NEW : OLD;
    const items = [
      { store: 'a', id: 'doc-1', tier: 'internal', tombstoned: 0, contentHash: 'h1', metadataTier: 'personal', contentTier: 'personal' },
      { store: 'b', id: 'doc-2', tier: 'secure_local', tombstoned: 0, contentHash: 'h2', metadataTier: 'private', contentTier: 'private' },
    ];
    say({ ok: true, state: {
      version: upgraded ? '1.0.1' : '1.0.0', build: (upgraded ? '1.0.1' : '1.0.0') + '+abc', engineState: 'running', installId: 'install-1', relayConnected: true,
      policy: { sha256: sha(oldText), json: policy, backups: migratedNow ? [{ name: 'sovereignty.json.backup-private-meaning-x', sha256: sha(oldText) }] : [] },
      configFiles: ['engine.json', 'sovereignty.json', 'worker.env'], workerEnvKeys: ['OLYMPUS_WORKER_AUTH_TOKEN'],
      tierRuleIds: flag('lose-tier-rules') ? [] : ['rc-private', 'rc-secrets'], connections: ['conn-1'],
      items, dashboard: { seen: counts.seen, indexed: counts.indexed, contentReady: counts.contentReady, embedded: counts.embedded, secretsLocated: counts.secretsLocated, personal: counts.personal, privateItems: counts.privateItems },
    } });
  }
  else if (sub === 'dashboard-json') say({ ok: true, status: 200, body: '{}' });
  else if (sub === 'collect-logs') say({ ok: true, files: [] });
  else if (sub === 'screenshots') say({ ok: false, detail: 'no browser in the scripted machine' });
  else say({ ok: false, detail: 'scripted machine: unknown ' + sub });
} else if (verb === 'destroy') {
  mark('destroyed');
}
`;

let dir: string;
let driverPath: string;
let candidateDir: string;
let baselineDir: string;
const saved: Record<string, string | undefined> = {};
const ENV_KEYS = ['FAKE_STATE', 'FAKE_OLD_POLICY', 'FAKE_NEW_POLICY', 'FAKE_UPGRADE_FAIL', 'FAKE_NO_MIGRATION', 'FAKE_TOKEN_REFUSED'];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'rc-upgrade-flow-'));
  driverPath = join(dir, 'driver.ts');
  writeFileSync(driverPath, SCRIPTED_DRIVER);
  chmodSync(driverPath, 0o755);
  for (const [name, bundle, version] of [['candidate', 'candidateDir', '1.0.1'], ['baseline', 'baselineDir', '1.0.0']] as const) {
    const bundleDir = join(dir, name);
    mkdirSync(bundleDir);
    writeFileSync(join(bundleDir, `olympus-${version}.tgz`), 'x');
    if (bundle === 'candidateDir') candidateDir = bundleDir; else baselineDir = bundleDir;
  }
  writeFileSync(join(dir, 'old.json'), JSON.stringify(OLD_POLICY));
  writeFileSync(join(dir, 'new.json'), JSON.stringify(migrated(OLD_POLICY)));
  const countTier = (tier: string): number => FIXTURE_ITEMS.filter((item) => item.tier === tier).length;
  writeFileSync(join(dir, 'life.json'), JSON.stringify({ seen: FIXTURE_ITEMS.length, stored: FIXTURE_ITEMS.length - countTier('secrets'), secrets: countTier('secrets'), personal: countTier('personal'), privateItems: countTier('private') }));
  for (const key of ENV_KEYS) saved[key] = process.env[key];
  process.env.FAKE_STATE = dir;
  process.env.FAKE_OLD_POLICY = join(dir, 'old.json');
  process.env.FAKE_NEW_POLICY = join(dir, 'new.json');
  for (const key of ['FAKE_UPGRADE_FAIL', 'FAKE_NO_MIGRATION', 'FAKE_TOKEN_REFUSED']) delete process.env[key];
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  for (const key of ENV_KEYS) { if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key]; }
});
const driverLog = (): string[] => readFileSync(join(dir, 'driver.log'), 'utf8').split('\n').filter(Boolean);

function options(extra: Record<string, unknown> = {}) {
  const runId = newRunId();
  // No agent asks a question here, so every run also carries the standing "no agent asked a question" problem; the checks are what is asserted.
  const config: RunConfigFile = { driver: [driverPath], agents: [], settleTimeoutS: 5 };
  return { runId, candidateDir, upgradeFromDir: baselineDir, candidateLabel: 'upgrade test', outDir: join(dir, 'out', runId), config, skipRelay: true, skipScreenshots: true, ...extra };
}
const checkOf = (report: Awaited<ReturnType<typeof runReleaseCheck>>, id: string) => {
  const machine = report.machines[0]!;
  const all = [...(machine.upgrade?.from.checks ?? []), ...(machine.upgrade?.step.checks ?? []), ...machine.checks];
  return all.find((check) => check.id === id);
};
const failedIds = (report: Awaited<ReturnType<typeof runReleaseCheck>>): string[] => {
  const machine = report.machines[0]!;
  return [...(machine.upgrade?.from.checks ?? []), ...(machine.upgrade?.step.checks ?? []), ...machine.checks].filter((c) => c.status === 'fail').map((c) => c.id);
};

describe('the upgrade leg end to end, against a scripted machine', () => {
  test('the earlier release is provisioned, the candidate installs over it with the upgrade verb, and every comparison passes', async () => {
    const opts = options();
    const report = await runReleaseCheck(opts);
    // The one standing problem is that this stand-in has no model agent; nothing else fails.
    expect(failedIds(report)).toEqual([]);
    expect(report.errors.every((e) => e.includes('no agent asked a question'))).toBe(true);
    expect(driverLog()[0]).toContain(`provision --run-id ${opts.runId} --candidate ${baselineDir}`);
    const upgrade = driverLog().find((line) => line.startsWith('upgrade'))!;
    expect(upgrade).toContain(`--machine fake-${opts.runId} --candidate ${candidateDir}`);
    // Provision came first, the update after the baseline's suite, and the machine was destroyed at the end.
    const verbs = driverLog().map((line) => line.split(' ')[0]);
    expect(verbs.indexOf('provision')).toBeLessThan(verbs.indexOf('upgrade'));
    expect(verbs[verbs.length - 1]).toBe('destroy');
    // Both stages are in the report, with a verdict each, and the updated install was settled without another sync.
    const machine = report.machines[0]!;
    expect(machine.upgrade?.from.version).toBe('1.0.0');
    expect(machine.upgrade?.afterVersion).toBe('1.0.1');
    expect(report.phases.map((p) => p.id)).toEqual(['before', 'upgrade', 'after']);
    const life = JSON.parse(readFileSync(join(dir, 'life.json'), 'utf8')) as { stored: number; privateItems: number };
    expect(checkOf(report, 'upgrade.counts-kept')?.detail).toContain(`embedded ${life.stored - life.privateItems} -> ${life.stored}`);
    const afterScripts = readFileSync(join(opts.outDir, 'logs', 'run.log'), 'utf8');
    expect(afterScripts).toContain('check PASS upgrade.privacy-migration');
    const html = readFileSync(join(opts.outDir, 'report.html'), 'utf8');
    expect(html).toContain('1. Before the upgrade');
    expect(html).toContain('2. The upgrade');
    expect(html).toContain('3. After the upgrade');
    expect(html).toContain('What differs across the upgrade');
  }, 120_000);

  test('the sync verb is never repeated after the update: the test life is not brought in again', async () => {
    const opts = options();
    await runReleaseCheck(opts);
    const runLog = readFileSync(join(opts.outDir, 'logs', 'run.log'), 'utf8');
    // connect-source and sync are part of the baseline setup only: one setup, one connect.
    expect(runLog.match(/check PASS source\.connect/g)?.length).toBe(1);
    expect(runLog.match(/check PASS source\.prepare/g)?.length).toBe(1);
  }, 120_000);

  test('a privacy migration that did not happen fails the run on the migration check, and the machine is still destroyed', async () => {
    process.env.FAKE_NO_MIGRATION = '1';
    const opts = options();
    const report = await runReleaseCheck(opts);
    expect(report.verdict).toBe('fail');
    expect(failedIds(report)).toEqual(['upgrade.privacy-migration']);
    expect(report.phases.find((p) => p.id === 'upgrade')?.verdict).toBe('fail');
    expect(driverLog().some((line) => line === `destroy --machine fake-${opts.runId}`)).toBe(true);
  }, 120_000);

  test('an earlier token the update no longer honours fails the connection check after the update', async () => {
    process.env.FAKE_TOKEN_REFUSED = '1';
    const report = await runReleaseCheck(options());
    expect(failedIds(report)).toContain('mcp.connection');
    expect(report.phases.find((p) => p.id === 'after')?.verdict).toBe('fail');
  }, 120_000);

  for (const mode of ['lose-tier-rules', 'revert-policy'] as const) {
    test(`the ${mode} self-test makes the run fail on ${UPGRADE_SELFTEST_FAILS[mode]}, says so in the report, and destroys the machine`, async () => {
      const opts = options({ upgradeSelftest: mode });
      const report = await runReleaseCheck(opts);
      expect(report.verdict).toBe('fail');
      expect(failedIds(report)).toContain(UPGRADE_SELFTEST_FAILS[mode]);
      expect(report.selfTest).toContain(mode);
      expect(readFileSync(join(opts.outDir, 'report.html'), 'utf8')).toContain('Self-test');
      expect(driverLog().some((line) => line === `destroy --machine fake-${opts.runId}`)).toBe(true);
    }, 120_000);
  }

  test('an installer that fails stops the leg with the failure recorded, and the machine is destroyed', async () => {
    process.env.FAKE_UPGRADE_FAIL = '1';
    const opts = options();
    const report = await runReleaseCheck(opts);
    expect(report.verdict).toBe('fail');
    expect(checkOf(report, 'upgrade.installer')?.status).toBe('fail');
    expect(checkOf(report, 'upgrade.installer')?.detail).toContain('driver upgrade failed');
    // Nothing after the installer ran: no snapshot comparison, no second suite.
    expect(checkOf(report, 'upgrade.version')).toBeUndefined();
    expect(driverLog().some((line) => line === `destroy --machine fake-${opts.runId}`)).toBe(true);
  }, 120_000);

  test('a failure right after the earlier release is provisioned never reaches the update, and the machine is destroyed', async () => {
    const opts = options({ failAfterProvision: true });
    const report = await runReleaseCheck(opts);
    expect(report.verdict).toBe('fail');
    expect(report.errors.join(' ')).toContain('simulated failure after provision');
    expect(driverLog().some((line) => line.startsWith('upgrade'))).toBe(false);
    expect(driverLog().some((line) => line === `destroy --machine fake-${opts.runId}`)).toBe(true);
    // A stage that never ran cannot pass.
    expect(report.phases.find((p) => p.id === 'after')?.verdict).toBe('fail');
    expect(existsSync(join(opts.outDir, 'report.json'))).toBe(true);
  }, 120_000);

  test('a plain run (no --upgrade-from) is unchanged: one stage, no upgrade section, the candidate provisioned directly', async () => {
    const opts = options({ upgradeFromDir: undefined });
    delete (opts as Record<string, unknown>).upgradeFromDir;
    const report = await runReleaseCheck(opts);
    expect(report.machines[0]!.upgrade).toBeUndefined();
    expect(report.phases.map((p) => p.id)).toEqual(['install']);
    expect(driverLog()[0]).toContain(`--candidate ${candidateDir}`);
    expect(driverLog().some((line) => line.startsWith('upgrade'))).toBe(false);
  }, 120_000);
});
