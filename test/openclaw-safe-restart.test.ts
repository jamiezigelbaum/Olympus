import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'bun:test';
import { optionalToolchain } from './helpers/required-toolchain.ts';

const SCRIPT = join(import.meta.dir, '..', 'scripts', 'ops', 'openclaw-safe-restart.sh');
const script = readFileSync(SCRIPT, 'utf8');

const oauthFinding = {
  code: 'LEGACY_RESIDUE',
  severity: 'info',
  file: '/fixture/agents/main/agent/openclaw-agent.sqlite',
  jsonPath: 'profiles.openai-codex:default',
  message: 'OAuth credentials are present (out of scope for static SecretRef migration).',
  provider: 'openai-codex',
  profileId: 'openai-codex:default',
};

const sharedOauthFinding = { ...oauthFinding, file: '/fixture/state/openclaw.sqlite' };

function auditReport(findings: ReadonlyArray<Record<string, unknown>> = []) {
  return {
    version: 1,
    status: findings.some(finding => finding.code === 'REF_UNRESOLVED')
      ? 'unresolved' : findings.length ? 'findings' : 'clean',
    resolution: { refsChecked: 3, skippedExecRefs: 0, resolvabilityComplete: true },
    filesScanned: ['/fixture/openclaw.json', oauthFinding.file],
    summary: {
      plaintextCount: findings.filter(finding => finding.code === 'PLAINTEXT_FOUND').length,
      unresolvedRefCount: findings.filter(finding => finding.code === 'REF_UNRESOLVED').length,
      shadowedRefCount: findings.filter(finding => finding.code === 'REF_SHADOWED').length,
      legacyResidueCount: findings.filter(finding => finding.code === 'LEGACY_RESIDUE').length,
    },
    findings,
  };
}

function extendedAuditReport(findings: ReadonlyArray<Record<string, unknown>> = []) {
  const report = auditReport(findings);
  return {
    ...report,
    filesScanned: [...report.filesScanned, sharedOauthFinding.file],
    summary: {
      ...report.summary,
      storeResidueCount: findings.filter(finding => finding.code === 'STORE_RESIDUE').length,
    },
  };
}

describe('OpenClaw safe restart', () => {
  test('is valid Bash and shellcheck clean when shellcheck is available', () => {
    const bash = Bun.which('bash');
    if (!bash) throw new Error('bash is required to test a Bash runbook');
    execFileSync(bash, ['-n', SCRIPT], { stdio: 'pipe' });
    const shellcheck = optionalToolchain('shellcheck');
    if (shellcheck) execFileSync(shellcheck, [SCRIPT], { stdio: 'pipe' });
  }, 30_000);

  test('runs every gate in order, restarts once, and proves identity + function + corroboration', () => {
    const result = runScenario({ args: ['--secrets-touched'] });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Gateway boot proved: MainPID=4242');
    expect(result.stdout).toContain('loopback answered at http://127.0.0.1:18789/');
    expect(result.stdout).toContain('corroborating journal line:');
    expect(result.captured).toContain('broker_args=--status\n');
    expect(result.captured).toContain('curl_args=');
    expect(result.captured).toContain('_SYSTEMD_INVOCATION_ID=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
    const quota = result.captured.indexOf('broker_args=--status');
    const validate = result.captured.indexOf('openclaw_args=config validate');
    const lint = result.captured.indexOf('openclaw_args=doctor --lint --severity-min error --non-interactive');
    const secrets = result.captured.indexOf('openclaw_args=secrets audit --check --allow-exec');
    const restart = result.captured.indexOf('openclaw_args=gateway restart');
    const functionProof = result.captured.indexOf('curl_args=');
    const journalProof = result.captured.indexOf('_SYSTEMD_INVOCATION_ID=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
    expect(quota).toBeGreaterThanOrEqual(0);
    expect(quota).toBeLessThan(validate);
    expect(validate).toBeLessThan(lint);
    expect(lint).toBeLessThan(secrets);
    expect(secrets).toBeLessThan(restart);
    expect(restart).toBeLessThan(functionProof);
    expect(functionProof).toBeLessThan(journalProof);
    expect(result.captured.match(/openclaw_args=gateway restart/g)).toHaveLength(1);
    expect(script).toContain('systemd_classify_unit_activity "$GATEWAY_UNIT"');
    expect(script).toContain('lib/systemd-activity-classifier.sh');
    expect(script).not.toContain('systemctl --user restart');
  }, 30_000);

  test('refuses below-threshold 1Password quota before validation or restart', () => {
    const result = runScenario({ quotaRemaining: 24 });

    expect(result.exitCode).toBe(78);
    expect(result.stderr).toContain('Credential broker or 1Password quota is unsafe; refusing Gateway restart.');
    expect(result.captured).not.toContain('openclaw_args=');
  }, 30_000);

  test('uses the general preflight-refusal exit when quota metadata is unavailable', () => {
    const result = runScenario({ quotaEnvMissing: true });

    expect(result.exitCode).toBe(75);
    expect(result.stderr).toContain('Could not read credential broker quota status; refusing Gateway restart.');
    expect(result.captured).not.toContain('openclaw_args=');
  }, 30_000);

  test('permits only an internal-window block when every Gateway cache is max-stale ready', () => {
    const result = runScenario({
      brokerState: 'blocked',
      brokerReason: 'broker_window_budget_exhausted',
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Gateway credential cache proof passed');
    expect(result.stdout).toContain('proceeding with a cache-covered Gateway restart');
    expect(result.captured).toContain('cache_readiness_args=');
    expect(result.captured).toContain('--caller openclaw-gateway');
    expect(result.captured).toContain('--freshness-window max-stale');
    expect(result.captured.match(/openclaw_args=gateway restart/g)).toHaveLength(1);
  }, 30_000);

  test('refuses an internal-window block when the Gateway cache proof fails', () => {
    const result = runScenario({
      brokerState: 'blocked',
      brokerReason: 'broker_window_budget_exhausted',
      cacheReadinessFail: true,
    });

    expect(result.exitCode).toBe(78);
    expect(result.stderr).toContain('Gateway credential caches cannot safely cover');
    expect(result.captured).not.toContain('openclaw_args=');
  }, 30_000);

  test('names both cache-readiness overrides when this installation configured neither', () => {
    // The readiness implementation and its manifest are deployment-owned, so
    // the public copy defaults to empty. A rolling-window block must still
    // name the exact seam, or the operator's only recovery is reading the
    // script (2026-08-31 review: the branch refused anonymously).
    const result = runScenario({
      brokerState: 'blocked',
      brokerReason: 'broker_window_budget_exhausted',
      cacheSeamUnconfigured: true,
    });

    expect(result.exitCode).toBe(75);
    expect(result.stderr).toContain('OPENCLAW_SAFE_RESTART_CACHE_READINESS_SCRIPT');
    expect(result.stderr).toContain('OPENCLAW_SAFE_RESTART_BROKER_MANIFEST');
    expect(result.captured).not.toContain('cache_readiness_args=');
    expect(result.captured).not.toContain('openclaw_args=');
  }, 30_000);

  test('names the configured cache-readiness path when that path is absent', () => {
    const result = runScenario({
      brokerState: 'blocked',
      brokerReason: 'broker_window_budget_exhausted',
      cacheReadinessMissing: true,
    });

    expect(result.exitCode).toBe(75);
    expect(result.stderr).toContain('absent-cache-readiness.ts');
    expect(result.stderr).toContain('OPENCLAW_SAFE_RESTART_CACHE_READINESS_SCRIPT');
    expect(result.captured).not.toContain('cache_readiness_args=');
    expect(result.captured).not.toContain('openclaw_args=');
  }, 30_000);

  test('refuses every broker block reason except the internal rolling-window ceiling', () => {
    const result = runScenario({
      brokerState: 'blocked',
      brokerReason: 'account_reserve_reached',
    });

    expect(result.exitCode).toBe(78);
    expect(result.stderr).toContain('not the cache-safe rolling-window case');
    expect(result.captured).not.toContain('cache_readiness_args=');
    expect(result.captured).not.toContain('openclaw_args=');
  }, 30_000);

  test('refuses a config validation failure', () => {
    const result = runScenario({ failStep: 'config' });

    expect(result.exitCode).toBe(78);
    expect(result.stderr).toContain('openclaw config validate failed; refusing Gateway restart.');
    expect(result.captured).not.toContain('openclaw_args=doctor');
    expect(result.captured).not.toContain('openclaw_args=gateway restart');
  }, 30_000);

  test('refuses a doctor lint failure', () => {
    const result = runScenario({ failStep: 'doctor' });

    expect(result.exitCode).toBe(78);
    expect(result.stderr).toContain('openclaw doctor --lint --severity-min error --non-interactive failed; refusing Gateway restart.');
    expect(result.captured).not.toContain('openclaw_args=gateway restart');
  }, 30_000);

  test('runs the secrets audit under the Gateway broker environment when the unit exposes it', () => {
    // A bare CLI shell lacks OLYMPUS_OP_*, so broker-backed refs report
    // REF_UNRESOLVED and the gate cannot tell a real credential failure from
    // its own missing environment (private host 2026-07-30: op_venice live and
    // serving while every --secrets-touched restart was refused). The audit
    // must borrow the Gateway unit's broker variables.
    const result = runScenario({ args: ['--secrets-touched'], gatewayBrokerEnv: true });

    expect(result.exitCode).toBe(0);
    expect(result.captured).toContain(
      'systemctl_args=--user show openclaw-gateway.service --property Environment --value\n',
    );
    expect(result.captured).toContain('audit_env_caller=openclaw-gateway\n');
    expect(result.stdout).toContain('borrowed from openclaw-gateway.service');
  }, 30_000);

  test('audits under the plain environment when the Gateway unit exposes no broker variables', () => {
    const result = runScenario({ args: ['--secrets-touched'] });

    expect(result.exitCode).toBe(0);
    expect(result.captured).toContain('audit_env_caller=unset\n');
    expect(result.stdout).not.toContain('borrowed from');
  }, 30_000);

  test('scrubs inherited OLYMPUS_OP variables absent from the Gateway unit snapshot', () => {
    const result = runScenario({
      args: ['--secrets-touched'],
      inheritedBrokerValue: 'operator-shell-only',
    });

    expect(result.exitCode).toBe(0);
    expect(result.captured).toContain('audit_env_inherited=unset\n');
  }, 30_000);

  test('parses a shell-quoted Gateway environment value containing spaces exactly', () => {
    const result = runScenario({
      args: ['--secrets-touched'],
      gatewayEnvironment:
        '"OLYMPUS_OP_BROKER_CALLER=openclaw gateway" OLYMPUS_OP_BROKER_SOCKET=/run/user/1000/olympus/credential-broker.sock',
    });

    expect(result.exitCode).toBe(0);
    expect(result.captured).toContain('audit_env_caller=openclaw gateway\n');
  }, 30_000);

  test('fails closed clearly when the systemd Environment property is malformed', () => {
    const result = runScenario({
      args: ['--secrets-touched'],
      gatewayEnvironment: '"OLYMPUS_OP_BROKER_CALLER=unterminated',
    });

    expect(result.exitCode).toBe(78);
    expect(result.stderr).toContain('Could not parse the Gateway unit Environment property');
    expect(result.captured).not.toContain('openclaw_args=secrets audit');
  }, 30_000);

  test('refuses a secrets audit failure when secrets were touched', () => {
    const result = runScenario({ args: ['--secrets-touched'], failStep: 'secrets' });

    expect(result.exitCode).toBe(78);
    expect(result.stderr).toContain('openclaw secrets audit --check --allow-exec --json refused:');
    expect(result.captured).not.toContain('openclaw_args=gateway restart');
  }, 30_000);

  test('permits exact native OAuth information with exit 1 and still proves one restart', () => {
    const result = runScenario({
      args: ['--secrets-touched'],
      auditOutput: JSON.stringify(auditReport([
        oauthFinding,
        { ...oauthFinding, provider: 'another-provider', profileId: 'another-provider:work', jsonPath: 'profiles.another-provider:work' },
      ])),
      auditExit: 1,
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('only native OAuth informational records');
    expect(result.stdout).toContain('Gateway boot proved: MainPID=4242');
    expect(result.captured).toContain('openclaw_args=secrets audit --check --allow-exec --json\n');
    expect(result.captured.match(/openclaw_args=gateway restart/g)).toHaveLength(1);
    expect(result.stdout + result.stderr).not.toContain(oauthFinding.profileId);
  }, 30_000);

  test('permits the extended v1 summary and exact shared-state OAuth information', () => {
    const findings = [
      { ...sharedOauthFinding, provider: 'openai', profileId: 'openai:primary', jsonPath: 'profiles.openai:primary' },
      { ...sharedOauthFinding, provider: 'openai', profileId: 'openai:secondary', jsonPath: 'profiles.openai:secondary' },
      { ...sharedOauthFinding, provider: 'xai', profileId: 'xai:default', jsonPath: 'profiles.xai:default' },
    ];
    const report = extendedAuditReport(findings);
    report.resolution.refsChecked = 12;
    const result = runScenario({
      args: ['--secrets-touched'], auditOutput: JSON.stringify(report), auditExit: 1,
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('only native OAuth informational records');
    expect(result.stdout).toContain('Gateway boot proved: MainPID=4242');
    expect(result.captured.match(/openclaw_args=gateway restart/g)).toHaveLength(1);
    expect(result.stdout + result.stderr).not.toContain(sharedOauthFinding.file);
    expect(result.stdout + result.stderr).not.toContain('openai:primary');
  }, 30_000);

  test.each([{ findings: [] }, { findings: [oauthFinding] }, { findings: [oauthFinding, sharedOauthFinding] }])(
    'permits extended clean, per-agent, and mixed native OAuth reports %#', ({ findings }) => {
      const result = runScenario({
        args: ['--secrets-touched', '--preflight-only'],
        auditOutput: JSON.stringify(extendedAuditReport(findings)), auditExit: findings.length ? 1 : 0,
      });
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('preflight passed');
      expect(result.captured).not.toContain('openclaw_args=gateway restart');
    }, 30_000,
  );

  test.each([
    '/fixture/openclaw.sqlite',
    '/fixture/cache/openclaw.sqlite',
    '/fixture/state/nested/openclaw.sqlite',
    '/fixture/state/openclaw.sqlite.bak',
    '/fixture/state/../state/openclaw.sqlite',
    '/fixture/state//openclaw.sqlite',
    'relative/state/openclaw.sqlite',
  ])('refuses a scanned OAuth finding at unsupported shared database path %s', (file) => {
    const report = extendedAuditReport([{ ...sharedOauthFinding, file }]);
    report.filesScanned = ['/fixture/openclaw.json', file];
    const result = runScenario({
      args: ['--secrets-touched', '--preflight-only'], auditOutput: JSON.stringify(report), auditExit: 1,
    });
    expect(result.exitCode).toBe(78);
    expect(result.captured).not.toContain('openclaw_args=gateway restart');
  }, 30_000);

  test('refuses shared-state OAuth without the known extended summary or scanned file', () => {
    const legacySummary = auditReport([sharedOauthFinding]);
    legacySummary.filesScanned.push(sharedOauthFinding.file);
    const unscanned = extendedAuditReport([sharedOauthFinding]);
    unscanned.filesScanned = ['/fixture/openclaw.json'];
    for (const report of [legacySummary, unscanned]) {
      const result = runScenario({
        args: ['--secrets-touched', '--preflight-only'], auditOutput: JSON.stringify(report), auditExit: 1,
      });
      expect(result.exitCode).toBe(78);
      expect(result.captured).not.toContain('openclaw_args=gateway restart');
    }
  }, 30_000);

  test.each([
    { storeResidueCount: 1 },
    { storeResidueCount: -1 },
    { storeResidueCount: '0' },
    { storeResidueCount: null },
    { storeResidueCount: false },
    { unknownCount: 0 },
    { plaintextCount: 1 },
    { unresolvedRefCount: 1 },
    { shadowedRefCount: 1 },
    { legacyResidueCount: 0 },
  ])('refuses unsafe or unknown extended summary %j', (patch) => {
    const report = extendedAuditReport([sharedOauthFinding]);
    const result = runScenario({
      args: ['--secrets-touched', '--preflight-only'],
      auditOutput: JSON.stringify({ ...report, summary: { ...report.summary, ...patch } }), auditExit: 1,
    });
    expect(result.exitCode).toBe(78);
    expect(result.captured).not.toContain('openclaw_args=gateway restart');
  }, 30_000);

  test.each([0, 1])('refuses STORE_RESIDUE even when its summary count is %i', (storeResidueCount) => {
    const report = extendedAuditReport([sharedOauthFinding, { ...sharedOauthFinding, code: 'STORE_RESIDUE' }]);
    report.summary.storeResidueCount = storeResidueCount;
    const result = runScenario({
      args: ['--secrets-touched', '--preflight-only'], auditOutput: JSON.stringify(report), auditExit: 1,
    });
    expect(result.exitCode).toBe(78);
    expect(result.captured).not.toContain('openclaw_args=gateway restart');
  }, 30_000);

  test.each([
    { code: 'PLAINTEXT_FOUND', severity: 'warn' },
    { code: 'REF_SHADOWED', severity: 'warn' },
    { code: 'REF_UNRESOLVED', severity: 'error' },
    { code: 'UNKNOWN_CODE', severity: 'info' },
    { code: 'LEGACY_RESIDUE', severity: 'warn' },
    { message: 'Legacy credential residue exists.' },
    { severity: 'error' },
    { severity: 'warning' },
    { file: '/fixture/auth.json' },
    { file: '/unscanned/openclaw-agent.sqlite' },
    { jsonPath: 'profiles.some-other-profile' },
    { profileId: '' },
    { provider: '' },
    { provider: null },
    { profileId: 'invalid\nprofile' },
    { extra: 'unknown schema' },
  ])('refuses changed OAuth record %j alone and mixed with valid OAuth information', (patch) => {
    for (const mixed of [false, true]) {
      const finding = { ...oauthFinding, ...patch };
      const result = runScenario({
        args: ['--secrets-touched', '--preflight-only'],
        auditOutput: JSON.stringify(auditReport(mixed ? [oauthFinding, finding] : [finding])),
        auditExit: finding.code === 'REF_UNRESOLVED' ? 2 : 1,
      });
      expect(result.exitCode).toBe(78);
      expect(result.captured).not.toContain('openclaw_args=gateway restart');
      expect(result.stdout).not.toContain('preflight passed');
    }
  }, 30_000);

  test.each([
    '', 'not-json upstream-private-sentinel', '{}', 'null', '[]',
    JSON.stringify({ ...auditReport(), version: 2 }),
    JSON.stringify({ ...auditReport(), findings: [null] }),
    JSON.stringify({ ...auditReport(), findings: {} }),
    JSON.stringify({ ...auditReport(), status: 'findings' }),
    JSON.stringify({ ...auditReport(), extra: true }),
    JSON.stringify({ ...auditReport(), filesScanned: [] }),
    JSON.stringify({ ...auditReport(), filesScanned: [1] }),
    JSON.stringify({ ...auditReport(), resolution: { refsChecked: 3, skippedExecRefs: 1, resolvabilityComplete: true } }),
    JSON.stringify({ ...auditReport(), resolution: { refsChecked: 3, skippedExecRefs: 0, resolvabilityComplete: false } }),
    JSON.stringify({ ...auditReport(), resolution: { refsChecked: -1, skippedExecRefs: 0, resolvabilityComplete: true } }),
    JSON.stringify({ ...auditReport(), resolution: null }),
    JSON.stringify({ ...auditReport(), summary: { ...auditReport().summary, legacyResidueCount: 1 } }),
    JSON.stringify({ ...auditReport(), summary: { ...auditReport().summary, plaintextCount: 1 } }),
    JSON.stringify({ ...auditReport(), summary: { ...auditReport().summary, unresolvedRefCount: 1 } }),
    JSON.stringify({ ...auditReport(), summary: { ...auditReport().summary, shadowedRefCount: 1 } }),
    JSON.stringify({ ...auditReport(), summary: { ...auditReport().summary, plaintextCount: '0' } }),
    JSON.stringify({ ...auditReport([oauthFinding]), summary: auditReport().summary }),
    JSON.stringify({ ...auditReport([oauthFinding]), status: 'clean' }),
    JSON.stringify({ ...auditReport([oauthFinding]), status: 'unresolved' }),
  ])('refuses malformed or inconsistent audit report %# without leaking diagnostics', (auditOutput) => {
    const result = runScenario({
      args: ['--secrets-touched', '--preflight-only'],
      auditOutput,
      auditStderr: 'upstream-private-sentinel',
      auditExit: auditOutput.includes('OAuth credentials') ? 1 : 0,
    });
    expect(result.exitCode).toBe(78);
    expect(result.captured).not.toContain('openclaw_args=gateway restart');
    expect(result.stdout).not.toContain('preflight passed');
    expect(result.stdout + result.stderr).not.toContain('upstream-private-sentinel');
  }, 30_000);

  test.each([0, 1, 2, 7, 126, 127, 137])('accepts exit %i only with its consistent supported report', (auditExit) => {
    for (const hasOAuth of [false, true]) {
      for (const report of [auditReport(hasOAuth ? [oauthFinding] : []), extendedAuditReport(hasOAuth ? [sharedOauthFinding] : [])]) {
        const result = runScenario({
          args: ['--secrets-touched', '--preflight-only'],
          auditOutput: JSON.stringify(report),
          auditExit,
        });
        expect(result.exitCode).toBe(auditExit === (hasOAuth ? 1 : 0) ? 0 : 78);
        expect(result.captured).not.toContain('openclaw_args=gateway restart');
      }
    }
  }, 30_000);

  test.each(['nul', 'utf8', 'oversize', 'signal'] as const)('refuses %s audit output or termination', (auditCorruption) => {
    const result = runScenario({
      args: ['--secrets-touched', '--preflight-only'],
      auditCorruption,
    });
    expect(result.exitCode).toBe(78);
    expect(result.stdout).not.toContain('preflight passed');
    expect(result.captured).not.toContain('openclaw_args=gateway restart');
  }, 30_000);

  test('preflight-only runs every requested gate and exits before journal capture or restart', () => {
    const result = runScenario({ args: ['--secrets-touched', '--preflight-only'] });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('OpenClaw safe-restart preflight passed');
    const quota = result.captured.indexOf('broker_args=--status');
    const validate = result.captured.indexOf('openclaw_args=config validate');
    const lint = result.captured.indexOf('openclaw_args=doctor --lint --severity-min error --non-interactive');
    const secrets = result.captured.indexOf('openclaw_args=secrets audit --check --allow-exec');
    expect(quota).toBeGreaterThanOrEqual(0);
    expect(quota).toBeLessThan(validate);
    expect(validate).toBeLessThan(lint);
    expect(lint).toBeLessThan(secrets);
    expect(result.captured).not.toContain('journal_args=');
    expect(result.captured).not.toContain('openclaw_args=gateway restart');
  }, 30_000);

  test('preflight-only omits the optional secrets audit when secrets were not touched', () => {
    const result = runScenario({ args: ['--preflight-only'] });

    expect(result.exitCode).toBe(0);
    expect(result.captured).toContain('broker_args=--status\n');
    expect(result.captured).toContain('openclaw_args=config validate\n');
    expect(result.captured).toContain('openclaw_args=doctor --lint --severity-min error --non-interactive\n');
    expect(result.captured).not.toContain('openclaw_args=secrets audit');
    expect(result.captured).not.toContain('journal_args=');
    expect(result.captured).not.toContain('openclaw_args=gateway restart');
  }, 30_000);

  test('preflight-only fails closed on a pre-restart gate failure', () => {
    const result = runScenario({ args: ['--preflight-only'], failStep: 'doctor' });

    expect(result.exitCode).toBe(78);
    expect(result.stderr).toContain('openclaw doctor --lint --severity-min error --non-interactive failed');
    expect(result.stdout).not.toContain('OpenClaw safe-restart preflight passed');
    expect(result.captured).not.toContain('journal_args=');
    expect(result.captured).not.toContain('openclaw_args=gateway restart');
  }, 30_000);

  test('does not retry a failed Gateway restart', () => {
    const result = runScenario({ failStep: 'restart' });

    expect(result.exitCode).toBe(76);
    expect(result.stderr).toContain('openclaw gateway restart failed; no retry was attempted.');
    expect(result.captured.match(/openclaw_args=gateway restart/g)).toHaveLength(1);
  }, 30_000);

  test('fails closed before restart when an active Gateway identity cannot be read', () => {
    const result = runScenario({ preRestartIdentityUnreadable: true });

    expect(result.exitCode).toBe(75);
    expect(result.stderr).toContain('active Gateway identity');
    expect(result.captured).not.toContain('openclaw_args=gateway restart');
  }, 30_000);

  test('allows an empty prior identity only when the Gateway is inactive before restart', () => {
    const result = runScenario({
      gatewayPreRestartState: 'inactive',
      preRestartIdentityUnreadable: true,
    });

    expect(result.exitCode).toBe(0);
    expect(result.captured.match(/openclaw_args=gateway restart/g)).toHaveLength(1);
  }, 30_000);

  test('fails closed when is-active reports active text with a query-error exit on an active Gateway', () => {
    const result = runScenario({
      gatewayPreRestartState: 'query-error-active',
      gatewayRestartNoOp: true,
    });

    expect(result.exitCode).toBe(75);
    expect(result.stderr).toContain('Could not determine the Gateway pre-restart active state');
    expect(result.captured).not.toContain('openclaw_args=gateway restart');
  }, 30_000);

  test.each([
    { label: 'inactive/3 after stop success', output: 'inactive', exit: 3, trusted: true },
    { label: 'failed/3 after stop success', output: 'failed', exit: 3, trusted: true },
    { label: 'active/0 after stop success', output: 'active', exit: 0, trusted: true },
    { label: 'active/0 after stop failure', output: 'active', exit: 0, trusted: true },
    { label: 'unknown/4 after stop success', output: 'unknown', exit: 4, trusted: false },
    { label: 'DBus error/7 after stop success', output: 'Failed to connect to bus', exit: 7, trusted: false },
    { label: 'active/7 after stop success', output: 'active', exit: 7, trusted: false },
    { label: 'DBus error/7 after stop failure', output: 'Failed to connect to bus', exit: 7, trusted: false },
    { label: 'inactive/3 after stop failure', output: 'inactive', exit: 3, trusted: true },
    { label: 'inactive/0 after stop success', output: 'inactive', exit: 0, trusted: false },
  ])('uses the shared activity verdict for $label', ({ output, exit, trusted }) => {
    const result = runScenario({
      gatewayPreRestartActivityOutput: output,
      gatewayPreRestartActivityExit: exit,
    });

    expect(result.exitCode).toBe(trusted ? 0 : 75);
    if (trusted) {
      expect(result.captured).toContain('openclaw_args=gateway restart');
    } else {
      expect(result.captured).not.toContain('openclaw_args=gateway restart');
    }
  }, 30_000);

  test('fails closed when the bounded proof times out, with recovery and real-undo pointers', () => {
    const result = runScenario({ bootTimeoutSeconds: 0, journalMode: 'timeout' });

    expect(result.exitCode).toBe(77);
    expect(result.stderr).toContain('Gateway proof failed after 0s');
    expect(result.stderr).toContain('no corroborating listening line');
    expect(result.stderr).toContain('openclaw gateway stability --bundle latest');
    expect(result.stderr).toContain("OpenClaw's .bak.* rotation");
    expect(result.captured.match(/openclaw_args=gateway restart/g)).toHaveLength(1);
  }, 30_000);

  test('does not need a realtime fallback when current invocation identity is available', () => {
    const result = runScenario({ bootTimeoutSeconds: 0, journalMode: 'fallback-fresh' });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Gateway boot proved:');
    expect(result.captured).not.toContain('--since');
    expect(result.captured).not.toContain('--after-cursor');
  }, 30_000);

  test('keeps boot unproven when the cursor and since-timestamp fallback are both empty', () => {
    const result = runScenario({ bootTimeoutSeconds: 0, journalMode: 'fallback-empty' });

    expect(result.exitCode).toBe(77);
    expect(result.stderr).toContain('no corroborating listening line');
  }, 30_000);

  test('does not compare a current-invocation boot line to realtime', () => {
    const result = runScenario({ bootTimeoutSeconds: 0, journalMode: 'fallback-stale' });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Gateway boot proved:');
  }, 30_000);

  test('does not accept a journal line that merely quotes the boot-proof doctrine', () => {
    const result = runScenario({ bootTimeoutSeconds: 0, journalMode: 'quote' });

    expect(result.exitCode).toBe(77);
    expect(result.stdout).not.toContain('Gateway boot proved');
    expect(result.stderr).toContain('no corroborating listening line');
  }, 30_000);

  test('rejects a copied numeric boot line emitted by an agent process', () => {
    const result = runScenario({ bootTimeoutSeconds: 0, journalMode: 'quoted-numeric-boot' });

    expect(result.exitCode).toBe(77);
    expect(result.stdout).not.toContain('Gateway boot proved');
    expect(result.stderr).toContain('no corroborating listening line');
  }, 30_000);

  test('accepts the real private-host user-manager boot shape from the current Gateway invocation', () => {
    const result = runScenario({ bootTimeoutSeconds: 0, journalMode: 'real-private-host-boot' });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Gateway boot proved:');
  }, 30_000);

  test('an earlier synthetic same-invocation line cannot certify a non-answering Gateway', () => {
    const result = runScenario({
      bootTimeoutSeconds: 0,
      gatewayHttpAnswer: false,
      journalMode: 'early-synthetic-then-genuine',
    });

    expect(result.exitCode).toBe(77);
    expect(result.stdout).not.toContain('Gateway boot proved');
    expect(result.stderr).toContain('loopback');
  }, 30_000);

  test('rejects an answering HTTP endpoint when it returns a failure status', () => {
    const result = runScenario({
      bootTimeoutSeconds: 0,
      gatewayHttpFailureStatus: true,
      journalMode: 'real-private-host-boot',
    });

    expect(result.exitCode).toBe(77);
    expect(result.captured).toContain('curl_args=--fail');
    expect(result.stderr).toContain('loopback HTTP port');
  }, 30_000);

  test('same-invocation line ordering is irrelevant when the loopback function answers', () => {
    const result = runScenario({
      bootTimeoutSeconds: 0,
      gatewayHttpAnswer: true,
      journalMode: 'early-synthetic-then-genuine',
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Gateway boot proved:');
    expect(result.stdout).toContain(
      'corroborating journal line: [gateway] http server listening (14 plugins: genuine)',
    );
  }, 30_000);

  test('still fails closed when the current MainPID, InvocationID, or ActiveEnterTimestamp is incomplete', () => {
    const result = runScenario({
      bootTimeoutSeconds: 0,
      gatewayIdentityIncomplete: true,
      journalMode: 'real-private-host-boot',
    });

    expect(result.exitCode).toBe(77);
    expect(result.stdout).not.toContain('Gateway boot proved');
    expect(result.stderr).toContain('incomplete Gateway MainPID');
  }, 30_000);

  test('does not reject the invocation first listening line merely because it arrived after 30 seconds', () => {
    const result = runScenario({
      bootTimeoutSeconds: 0,
      journalMode: 'same-process-copied-boot',
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Gateway boot proved');
  }, 30_000);

  test('same-invocation duplicate ordering is irrelevant when function answers', () => {
    const result = runScenario({
      bootTimeoutSeconds: 0,
      fixedDateEpoch: 2_000_000_000,
      gatewayActiveEnterEpoch: 1_999_999_990,
      journalMode: 'fallback-inside-window-duplicate',
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Gateway boot proved:');
  }, 30_000);

  test('accepts the real boot line even when doctrine-quote noise precedes it', () => {
    const result = runScenario({ journalMode: 'quote-then-boot' });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Gateway boot proved:');
  }, 30_000);

  test('rejects a fresh fallback line that only quotes the doctrine', () => {
    const result = runScenario({ bootTimeoutSeconds: 0, journalMode: 'fallback-quote' });

    expect(result.exitCode).toBe(77);
    expect(result.stdout).not.toContain('Gateway boot proved');
    expect(result.stderr).toContain('no corroborating listening line');
  }, 30_000);

  test('documents distinct refusal, restart-failure, boot-unproven, and credential-unsafe exits', () => {
    expect(script).toContain('75  preflight refusal');
    expect(script).toContain('76  restart command failed');
    expect(script).toContain('77  Gateway boot could not be proven');
    expect(script).toContain('78  credential startup is unsafe');
  });

  test('dry-run prints the ordered plan without touching quota, OpenClaw, or the journal', () => {
    const result = runScenario({ args: ['--secrets-touched', '--dry-run'] });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('OpenClaw safe restart plan:');
    expect(result.stdout).toContain('secrets audit --check --allow-exec');
    expect(result.stdout).toContain('Dry run only; no checks or restart executed.');
    expect(result.captured).toBe('');
  }, 30_000);

  test('dry-run stops advertising the cache-covered path this installation cannot run', () => {
    const configured = runScenario({ args: ['--dry-run'] });
    const unconfigured = runScenario({ args: ['--dry-run'], cacheSeamUnconfigured: true });

    expect(configured.stdout).toContain('prove every Gateway cache inside its max-stale window');
    expect(unconfigured.stdout).not.toContain('prove every Gateway cache inside its max-stale window');
    expect(unconfigured.stdout).toContain('OPENCLAW_SAFE_RESTART_CACHE_READINESS_SCRIPT');
  }, 30_000);

  test('dry-run remains non-executing when combined with preflight-only', () => {
    const result = runScenario({ args: ['--secrets-touched', '--preflight-only', '--dry-run'] });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Dry run only; no checks or restart executed.');
    expect(result.stdout).not.toContain('OpenClaw safe-restart preflight passed');
    expect(result.captured).toBe('');
  }, 30_000);
});

interface ScenarioOptions {
  auditOutput?: string;
  auditStderr?: string;
  auditExit?: number;
  auditCorruption?: 'nul' | 'utf8' | 'oversize' | 'signal';
  args?: string[];
  brokerReason?: string;
  brokerState?: 'ok' | 'blocked';
  bootTimeoutSeconds?: number;
  cacheReadinessFail?: boolean;
  cacheReadinessMissing?: boolean;
  cacheSeamUnconfigured?: boolean;
  failStep?: 'config' | 'doctor' | 'secrets' | 'restart';
  journalMode?:
    | 'boot'
    | 'timeout'
    | 'fallback-fresh'
    | 'fallback-empty'
    | 'fallback-stale'
    | 'quote'
    | 'quoted-numeric-boot'
    | 'real-private-host-boot'
    | 'early-synthetic-then-genuine'
    | 'same-process-copied-boot'
    | 'fallback-inside-window-duplicate'
    | 'quote-then-boot'
    | 'fallback-quote';
  fixedDateEpoch?: number;
  gatewayActiveEnterEpoch?: number;
  gatewayBrokerEnv?: boolean;
  gatewayEnvironment?: string;
  gatewayHttpAnswer?: boolean;
  gatewayHttpFailureStatus?: boolean;
  gatewayIdentityIncomplete?: boolean;
  gatewayPreRestartActivityExit?: number;
  gatewayPreRestartActivityOutput?: string;
  gatewayPreRestartActive?: boolean;
  gatewayPreRestartState?: 'active' | 'inactive' | 'failed' | 'query-error-active';
  gatewayRestartNoOp?: boolean;
  inheritedBrokerValue?: string;
  quotaEnvMissing?: boolean;
  quotaRemaining?: number;
  preRestartIdentityUnreadable?: boolean;
}

function runScenario(options: ScenarioOptions = {}): {
  captured: string;
  exitCode: number;
  stderr: string;
  stdout: string;
} {
  const root = mkdtempSync(join(tmpdir(), 'openclaw-safe-restart-'));
  const bin = join(root, 'bin');
  const home = join(root, 'home');
  const brokerRead = join(bin, 'op-cached-read');
  const cacheReadiness = join(root, 'cache-readiness.ts');
  const brokerManifest = join(root, 'broker-manifest.json');
  const brokerCacheDir = join(root, 'broker-cache');
  const capture = join(root, 'capture.txt');
  const restartDone = join(root, 'restart-done');
  mkdirSync(bin, { recursive: true });
  mkdirSync(home, { recursive: true });
  mkdirSync(brokerCacheDir, { recursive: true });
  writeFileSync(cacheReadiness, '// fixture');
  writeFileSync(brokerManifest, '{}');
  writeFileSync(brokerRead, [
    '#!/usr/bin/env bash',
    'set -euo pipefail',
    `printf 'broker_args=%s\\n' "$*" >> ${shellQuote(capture)}`,
    '[[ "${TEST_QUOTA_UNAVAILABLE:-0}" != "1" ]] || exit 1',
    'printf \'{"state":"%s","reason":"%s","quota":{"remaining":%s,"resetSeconds":60,"used":1,"limit":100},"brokerLiveReadsInWindow":1,"maxLiveReadsPerWindow":100}\\n\' "${TEST_BROKER_STATE:-ok}" "${TEST_BROKER_REASON:-}" "${TEST_QUOTA_REMAINING:-99}"',
  ].join('\n'));
  writeFileSync(join(bin, 'bun'), [
    '#!/usr/bin/env bash',
    'set -euo pipefail',
    `printf 'cache_readiness_args=%s\\n' "$*" >> ${shellQuote(capture)}`,
    '[[ "${TEST_CACHE_READINESS_FAIL:-0}" != "1" ]] || exit 75',
    'printf \'{"status":"ready","reasonCounts":{}}\\n\'',
  ].join('\n'));
  writeFileSync(join(bin, 'openclaw'), [
    '#!/usr/bin/env bash',
    'set -euo pipefail',
    `printf 'openclaw_args=%s\\n' "$*" >> ${shellQuote(capture)}`,
    'if [[ "$*" == "secrets audit --check --allow-exec --json" ]]; then',
    `  printf 'audit_env_caller=%s\\n' "\${OLYMPUS_OP_BROKER_CALLER:-unset}" >> ${shellQuote(capture)}`,
    `  printf 'audit_env_inherited=%s\\n' "\${OLYMPUS_OP_INHERITED:-unset}" >> ${shellQuote(capture)}`,
    'fi',
    'case "${TEST_FAIL_STEP:-}" in',
    '  config) [[ "$*" == "config validate" ]] && exit 7 ;;',
    '  doctor) [[ "$*" == "doctor --lint --severity-min error --non-interactive" ]] && exit 8 ;;',
    '  secrets) [[ "$*" == "secrets audit --check --allow-exec --json" ]] && exit 9 ;;',
    '  restart) [[ "$*" == "gateway restart" ]] && exit 10 ;;',
    'esac',
    'if [[ "$*" == "secrets audit --check --allow-exec --json" ]]; then',
    '  printf "%s" "$TEST_AUDIT_OUTPUT"',
    '  printf "%s" "$TEST_AUDIT_STDERR" >&2',
    '  case "$TEST_AUDIT_CORRUPTION" in',
    "    nul) printf '\\000' ;;",
    "    utf8) printf '\\377' ;;",
    '    oversize) head -c 8388609 /dev/zero ;;',
    '    signal) kill -TERM "$$" ;;',
    '  esac',
    '  exit "$TEST_AUDIT_EXIT"',
    'fi',
    `if [[ "$*" == "gateway restart" ]]; then : > ${shellQuote(restartDone)}; fi`,
    'exit 0',
  ].join('\n'));
  // These scenarios exercise Linux even when the tests run on macOS.
  writeFileSync(join(bin, 'uname'), '#!/bin/sh\nprintf \"Linux\\n\"\n');
  writeFileSync(join(bin, 'journalctl'), [
    '#!/usr/bin/env bash',
    'set -euo pipefail',
    `printf 'journal_args=%s\\n' "$*" >> ${shellQuote(capture)}`,
    'if [[ "$*" == *"--show-cursor"* ]]; then echo "-- cursor: test-cursor"; exit 0; fi',
    'if [[ "$*" == *"_SYSTEMD_INVOCATION_ID="* ]]; then',
    '  case "${TEST_JOURNAL_MODE:-boot}" in',
    `    boot) echo '{"__REALTIME_TIMESTAMP":"9999999999168000","_SYSTEMD_UNIT":"user@1000.service","_SYSTEMD_USER_UNIT":"openclaw-gateway.service","SYSLOG_IDENTIFIER":"node","_PID":"4242","_SYSTEMD_INVOCATION_ID":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","MESSAGE":"2026-07-30T12:37:33.168+01:00 [gateway] http server listening (13 plugins)"}' ;;`,
    `    real-private-host-boot) echo '{"__REALTIME_TIMESTAMP":"9999999999168000","_SYSTEMD_UNIT":"user@1000.service","_SYSTEMD_USER_UNIT":"openclaw-gateway.service","SYSLOG_IDENTIFIER":"node","_PID":"4242","_SYSTEMD_INVOCATION_ID":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","_COMM":"MainThread","PRIORITY":"6","MESSAGE":"2026-07-30T12:37:33.168+01:00 [gateway] http server listening (14 plugins: a)"}' ;;`,
    `    early-synthetic-then-genuine) printf '%s\\n' '{"__REALTIME_TIMESTAMP":"9999999998000000","_SYSTEMD_UNIT":"user@1000.service","_SYSTEMD_USER_UNIT":"openclaw-gateway.service","SYSLOG_IDENTIFIER":"node","_PID":"4242","_SYSTEMD_INVOCATION_ID":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","MESSAGE":"[gateway] http server listening (99 plugins: synthetic)"}' '{"__REALTIME_TIMESTAMP":"9999999999168000","_SYSTEMD_UNIT":"user@1000.service","_SYSTEMD_USER_UNIT":"openclaw-gateway.service","SYSLOG_IDENTIFIER":"node","_PID":"4242","_SYSTEMD_INVOCATION_ID":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","MESSAGE":"[gateway] http server listening (14 plugins: genuine)"}' ;;`,
    `    same-process-copied-boot) echo '{"__REALTIME_TIMESTAMP":"10000000120000000","_SYSTEMD_UNIT":"user@1000.service","_SYSTEMD_USER_UNIT":"openclaw-gateway.service","SYSLOG_IDENTIFIER":"node","_PID":"4242","_SYSTEMD_INVOCATION_ID":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","_COMM":"MainThread","PRIORITY":"6","MESSAGE":"2026-07-30T12:39:33.168+01:00 [gateway] http server listening (14 plugins: a)"}' ;;`,
    '    timeout) echo "gateway still starting" ;;',
    `    quote) echo '{"__REALTIME_TIMESTAMP":"9999999999000000","_SYSTEMD_UNIT":"openclaw-gateway.service","SYSLOG_IDENTIFIER":"openclaw-agent","MESSAGE":"A new journal line saying [gateway] http server listening (N plugins) is required."}' ;;`,
    `    quoted-numeric-boot) echo '{"__REALTIME_TIMESTAMP":"9999999999168000","_SYSTEMD_UNIT":"user@1000.service","_SYSTEMD_USER_UNIT":"openclaw-gateway.service","SYSLOG_IDENTIFIER":"node","_PID":"9000","_SYSTEMD_INVOCATION_ID":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","_COMM":"MainThread","PRIORITY":"6","MESSAGE":"2026-07-30T12:37:33.168+01:00 [gateway] http server listening (13 plugins)"}' ;;`,
    `    quote-then-boot) printf '%s\\n' '{"__REALTIME_TIMESTAMP":"9999999998000000","_SYSTEMD_UNIT":"user@1000.service","_SYSTEMD_USER_UNIT":"openclaw-gateway.service","SYSLOG_IDENTIFIER":"node","_PID":"9000","_SYSTEMD_INVOCATION_ID":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","MESSAGE":"A new journal line saying [gateway] http server listening (N plugins) is required."}' '{"__REALTIME_TIMESTAMP":"9999999999168000","_SYSTEMD_UNIT":"user@1000.service","_SYSTEMD_USER_UNIT":"openclaw-gateway.service","SYSLOG_IDENTIFIER":"node","_PID":"4242","_SYSTEMD_INVOCATION_ID":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","MESSAGE":"2026-07-30T12:37:33.168+01:00 [gateway] http server listening (13 plugins)"}' ;;`,
    `    fallback-fresh|fallback-stale) echo '{"__REALTIME_TIMESTAMP":"1000000","_SYSTEMD_UNIT":"user@1000.service","_SYSTEMD_USER_UNIT":"openclaw-gateway.service","SYSLOG_IDENTIFIER":"node","_PID":"4242","_SYSTEMD_INVOCATION_ID":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","MESSAGE":"[gateway] http server listening (13 plugins)"}' ;;`,
    '    fallback-empty|fallback-quote) : ;;',
    `    fallback-inside-window-duplicate) printf '%s\\n' '{"__REALTIME_TIMESTAMP":"2000000001000000","__MONOTONIC_TIMESTAMP":"20000000","_SYSTEMD_UNIT":"user@1000.service","_SYSTEMD_USER_UNIT":"openclaw-gateway.service","SYSLOG_IDENTIFIER":"node","_PID":"4242","_SYSTEMD_INVOCATION_ID":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","MESSAGE":"[gateway] http server listening (13 plugins)"}' '{"__REALTIME_TIMESTAMP":"1999999999000000","__MONOTONIC_TIMESTAMP":"10000000","_SYSTEMD_UNIT":"user@1000.service","_SYSTEMD_USER_UNIT":"openclaw-gateway.service","SYSLOG_IDENTIFIER":"node","_PID":"4242","_SYSTEMD_INVOCATION_ID":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","MESSAGE":"[gateway] http server listening (13 plugins)"}' ;;`,
    '  esac',
    '  exit 0',
    'fi',
  ].join('\n'));
  writeFileSync(join(bin, 'systemctl'), [
    '#!/usr/bin/env bash',
    'set -euo pipefail',
    `printf 'systemctl_args=%s\\n' "$*" >> ${shellQuote(capture)}`,
    'if [[ "$*" == "--user is-active openclaw-gateway.service" || "$*" == "--user is-active --quiet openclaw-gateway.service" ]]; then',
    `  if [[ ! -e ${shellQuote(restartDone)} ]]; then`,
    '    if [[ -n "${TEST_GATEWAY_PRE_RESTART_ACTIVITY_EXIT:-}" ]]; then',
    '      [[ "$*" == *"--quiet"* ]] || printf "%s\\n" "${TEST_GATEWAY_PRE_RESTART_ACTIVITY_OUTPUT:-}"',
    '      exit "$TEST_GATEWAY_PRE_RESTART_ACTIVITY_EXIT"',
    '    fi',
    '    case "${TEST_GATEWAY_PRE_RESTART_STATE:-active}" in',
    '      active) [[ "$*" == *"--quiet"* ]] || echo active; exit 0 ;;',
    '      inactive) [[ "$*" == *"--quiet"* ]] || echo inactive; exit 3 ;;',
    '      failed) [[ "$*" == *"--quiet"* ]] || echo failed; exit 3 ;;',
    '      query-error-active) [[ "$*" == *"--quiet"* ]] || echo active; exit 7 ;;',
    '    esac',
    '  fi',
    '  exit 0',
    'fi',
    'if [[ "$*" == *"--property MainPID"* ]]; then',
    `  if [[ ! -e ${shellQuote(restartDone)} ]] && [[ "\${TEST_PRE_RESTART_IDENTITY_UNREADABLE:-0}" == "1" ]]; then exit 7; fi`,
    `  if [[ ! -e ${shellQuote(restartDone)} ]] || [[ "\${TEST_GATEWAY_IDENTITY_INCOMPLETE:-0}" != "1" ]]; then echo "MainPID=4242"; fi`,
    `  if [[ -e ${shellQuote(restartDone)} ]] || [[ "\${TEST_GATEWAY_RESTART_NOOP:-0}" == "1" ]]; then`,
    '    echo "InvocationID=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"',
    '  else',
    '    echo "InvocationID=dddddddddddddddddddddddddddddddd"',
    '  fi',
    '  printf "ActiveEnterTimestamp=@%s\\n" "${TEST_GATEWAY_ACTIVE_ENTER_EPOCH:-9999999990}"',
    'elif [[ -n "${TEST_GATEWAY_ENVIRONMENT:-}" ]]; then',
    '  printf \'%s\\n\' "${TEST_GATEWAY_ENVIRONMENT}"',
    'elif [[ "${TEST_GATEWAY_BROKER_ENV:-0}" == "1" ]]; then',
    '  echo "OLYMPUS_OP_BROKER_CALLER=openclaw-gateway OLYMPUS_OP_BROKER_SOCKET=/run/user/1000/olympus/credential-broker.sock"',
    'else',
    '  echo ""',
    'fi',
  ].join('\n'));
  writeFileSync(join(bin, 'curl'), [
    '#!/usr/bin/env bash',
    'set -euo pipefail',
    `printf 'curl_args=%s\\n' "$*" >> ${shellQuote(capture)}`,
    'if [[ "${TEST_GATEWAY_HTTP_FAILURE_STATUS:-0}" == "1" ]] && [[ " $* " == *" --fail "* ]]; then exit 22; fi',
    '[[ "${TEST_GATEWAY_HTTP_ANSWER:-1}" == "1" ]]',
  ].join('\n'));
  writeFileSync(join(bin, 'date'), [
    '#!/usr/bin/env bash',
    'set -euo pipefail',
    'if [[ -n "${TEST_FIXED_DATE_EPOCH:-}" ]]; then',
    '  case "$*" in',
    '    "+%s") printf "%s\\n" "$TEST_FIXED_DATE_EPOCH" ;;',
    '    "-u +%Y-%m-%dT%H:%M:%SZ") printf "2033-05-18T03:33:20Z\\n" ;;',
    '    *) exec /bin/date "$@" ;;',
    '  esac',
    'else',
    '  exec /bin/date "$@"',
    'fi',
  ].join('\n'));
  for (const path of [brokerRead, ...['bun', 'curl', 'date', 'openclaw', 'journalctl', 'systemctl', 'uname'].map((name) => join(bin, name))]) {
    chmodSync(path, 0o755);
  }

  const scenarioEnv: Record<string, string | undefined> = {
    ...process.env,
    HOME: home,
    PATH: `${bin}:${process.env.PATH ?? ''}`,
    TEST_FAIL_STEP: options.failStep ?? '',
    TEST_AUDIT_OUTPUT: options.auditOutput ?? JSON.stringify(auditReport()),
    TEST_AUDIT_STDERR: options.auditStderr ?? '',
    TEST_AUDIT_EXIT: String(options.auditExit ?? 0),
    TEST_AUDIT_CORRUPTION: options.auditCorruption ?? '',
    TEST_BROKER_STATE: options.brokerState ?? 'ok',
    TEST_BROKER_REASON: options.brokerReason ?? '',
    TEST_CACHE_READINESS_FAIL: options.cacheReadinessFail ? '1' : '0',
    TEST_GATEWAY_BROKER_ENV: options.gatewayBrokerEnv ? '1' : '0',
    TEST_GATEWAY_ENVIRONMENT: options.gatewayEnvironment ?? '',
    TEST_GATEWAY_HTTP_ANSWER: options.gatewayHttpAnswer === false ? '0' : '1',
    TEST_GATEWAY_HTTP_FAILURE_STATUS: options.gatewayHttpFailureStatus ? '1' : '0',
    TEST_GATEWAY_IDENTITY_INCOMPLETE: options.gatewayIdentityIncomplete ? '1' : '0',
    TEST_GATEWAY_PRE_RESTART_ACTIVITY_EXIT:
      options.gatewayPreRestartActivityExit === undefined
        ? ''
        : String(options.gatewayPreRestartActivityExit),
    TEST_GATEWAY_PRE_RESTART_ACTIVITY_OUTPUT: options.gatewayPreRestartActivityOutput ?? '',
    TEST_GATEWAY_PRE_RESTART_STATE: options.gatewayPreRestartState
      ?? (options.gatewayPreRestartActive === false ? 'inactive' : 'active'),
    TEST_GATEWAY_RESTART_NOOP: options.gatewayRestartNoOp ? '1' : '0',
    TEST_GATEWAY_ACTIVE_ENTER_EPOCH: String(options.gatewayActiveEnterEpoch ?? 9_999_999_990),
    TEST_JOURNAL_MODE: options.journalMode ?? 'boot',
    TEST_FIXED_DATE_EPOCH: options.fixedDateEpoch === undefined ? '' : String(options.fixedDateEpoch),
    TEST_QUOTA_REMAINING: String(options.quotaRemaining ?? 99),
    TEST_QUOTA_UNAVAILABLE: options.quotaEnvMissing ? '1' : '0',
    TEST_PRE_RESTART_IDENTITY_UNREADABLE: options.preRestartIdentityUnreadable ? '1' : '0',
    OLYMPUS_OP_INHERITED: options.inheritedBrokerValue ?? '',
    OPENCLAW_SAFE_RESTART_1PASSWORD_BROKER_READ_BIN: brokerRead,
    OPENCLAW_SAFE_RESTART_BROKER_CACHE_DIR: brokerCacheDir,
    OPENCLAW_SAFE_RESTART_BROKER_MANIFEST: brokerManifest,
    OPENCLAW_SAFE_RESTART_BUN_BIN: join(bin, 'bun'),
    OPENCLAW_SAFE_RESTART_CACHE_READINESS_SCRIPT: cacheReadiness,
    OPENCLAW_SAFE_RESTART_BOOT_POLL_SECONDS: '1',
    OPENCLAW_SAFE_RESTART_BOOT_TIMEOUT_SECONDS: String(options.bootTimeoutSeconds ?? 90),
    OPENCLAW_SAFE_RESTART_JOURNALCTL_BIN: join(bin, 'journalctl'),
    OPENCLAW_SAFE_RESTART_NODE_BIN: process.execPath,
    OPENCLAW_SAFE_RESTART_OPENCLAW_BIN: join(bin, 'openclaw'),
    OPENCLAW_SAFE_RESTART_SYSTEMCTL_BIN: join(bin, 'systemctl'),
    OPENCLAW_SAFE_RESTART_CURL_BIN: join(bin, 'curl'),
  };
  // Deleted, not emptied: an operator shell that exports either override must
  // not leak into the unconfigured-installation scenario.
  if (options.cacheSeamUnconfigured) {
    delete scenarioEnv.OPENCLAW_SAFE_RESTART_CACHE_READINESS_SCRIPT;
    delete scenarioEnv.OPENCLAW_SAFE_RESTART_BROKER_MANIFEST;
  }
  if (options.cacheReadinessMissing) {
    scenarioEnv.OPENCLAW_SAFE_RESTART_CACHE_READINESS_SCRIPT = join(root, 'absent-cache-readiness.ts');
  }

  const proc = Bun.spawnSync([SCRIPT, ...(options.args ?? [])], {
    env: scenarioEnv,
    stdout: 'pipe',
    stderr: 'pipe',
  });

  return {
    captured: readFileIfExists(capture),
    exitCode: proc.exitCode,
    stderr: new TextDecoder().decode(proc.stderr),
    stdout: new TextDecoder().decode(proc.stdout),
  };
}

function readFileIfExists(path: string): string {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return '';
  }
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}
