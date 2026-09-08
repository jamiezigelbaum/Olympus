import { execFileSync } from 'node:child_process';
import { appendFileSync, closeSync, fstatSync, mkdtempSync, openSync, readFileSync, renameSync, rmSync, truncateSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'bun:test';

// Pure parser/contract fixtures only. These are not a live macOS rehearsal.
const helperPath = join(import.meta.dir, '..', 'scripts', 'ops', 'lib', 'gateway-darwin-proof.mjs');
const helper = await import(new URL('../scripts/ops/lib/gateway-darwin-proof.mjs', import.meta.url).href);
const { assertManagedWrapper, parseServiceEnvironment, validateNativeAudit, parseLaunchdPid, parseProcessStart, assertListenerOwner, assertNewStableIdentity, freshBootLine, readFreshLogAppend, statusDescriptor } = helper;
const target = 'gui/501/ai.openclaw.gateway';
const identity = { pid: 42, startedAt: 'Tue Sep  8 10:00:00 2026', executable: '/usr/local/bin/node' };
const next = { ...identity, pid: 43, startedAt: 'Tue Sep  8 10:01:00 2026' };
const observedAt = Date.parse('2026-09-08T10:04:00.000Z');
const oauth = { code: 'LEGACY_RESIDUE', severity: 'info', file: '/fixture/agents/main/agent/openclaw-agent.sqlite', jsonPath: 'profiles.fixture:default', message: 'OAuth credentials are present (out of scope for static SecretRef migration).', provider: 'fixture', profileId: 'fixture:default' };
function audit(findings: unknown[] = []) {
  return { version: 1, status: findings.length ? 'findings' : 'clean', resolution: { refsChecked: 4, skippedExecRefs: 0, resolvabilityComplete: true }, filesScanned: ['/fixture/openclaw.json', oauth.file], summary: { plaintextCount: 0, unresolvedRefCount: 0, shadowedRefCount: 0, legacyResidueCount: findings.length }, findings };
}

describe('native Darwin safe-restart proof contracts', () => {
  test('accepts only the exact qualified official wrapper, including the quoted argument', () => {
    const official = '#!/bin/sh\nset -eu\nenv_file="$1"\nshift\nif [ -f "$env_file" ]; then\n  . "$env_file"\nfi\nexec "$@"\n';
    expect(() => assertManagedWrapper(official)).not.toThrow();
    expect(() => assertManagedWrapper(official.replace('env_file="$1"', 'env_file=$1'))).toThrow();
    expect(() => assertManagedWrapper(official + 'unreviewed-command\n')).toThrow();
  });
  test('accepts literal generated env values without evaluating shell syntax', () => {
    const parsed = parseServiceEnvironment("export HOME='/Users/fixture'\nexport TOKEN='$(must-not-run) `must-not-run`'\nexport QUOTE='one'\\''two'\n");
    expect(parsed.HOME).toBe('/Users/fixture');
    expect(parsed.TOKEN).toBe('$(must-not-run) `must-not-run`');
    expect(parsed.QUOTE).toBe("one'two");
  });
  test.each([
    "export TOKEN=$(must-not-run)\n", "export TOKEN='value'; command\n", "export TOKEN=\"$VALUE\"\n",
    "export TOKEN='a'\nexport TOKEN='b'\n", "export TOKEN='unterminated\n", "export TOKEN='a' trailing\n",
    "export OP_SERVICE_ACCOUNT_TOKEN='fixture'\n", "export OLYMPUS_OP_CALLER='gateway'\n", "export NODE_OPTIONS='--require /tmp/inject.cjs'\n",
  ])('refuses unsupported or externally resolved service environment: %s', value => {
    expect(() => parseServiceEnvironment(value)).toThrow();
  });
  test('accepts complete local references and exact native OAuth informational findings', () => {
    expect(validateNativeAudit(audit(), 0)).toEqual({ refsChecked: 4, nativeOAuthProfiles: 0 });
    expect(validateNativeAudit(audit([oauth]), 1)).toEqual({ refsChecked: 4, nativeOAuthProfiles: 1 });
  });
  test('refuses skipped exec resolution and inconsistent audit exit/status', () => {
    const skipped = audit(); skipped.resolution.skippedExecRefs = 1; skipped.resolution.resolvabilityComplete = false;
    expect(() => validateNativeAudit(skipped, 0)).toThrow();
    expect(() => validateNativeAudit(audit([oauth]), 0)).toThrow();
    expect(() => validateNativeAudit(audit(), 1)).toThrow();
    expect(() => validateNativeAudit({ ...audit(), version: 2 }, 0)).toThrow();
  });
  test('does not broaden native OAuth exception to plaintext, warnings, or arbitrary residues', () => {
    for (const change of [{ severity: 'warning' }, { code: 'PLAINTEXT_FOUND' }, { message: 'Other legacy residue' }, { file: '/fixture/auth.json' }, { jsonPath: 'profiles.another' }]) {
      expect(() => validateNativeAudit(audit([{ ...oauth, ...change }]), 1)).toThrow();
    }
    const unresolved = audit(); unresolved.summary.unresolvedRefCount = 1;
    expect(() => validateNativeAudit(unresolved, 0)).toThrow();
  });
  test('uses the root launchd job identity, not nested active-state fields', () => {
    const job = `${target} = {\n\tstate = running\n\tpid = 42\n\tnested = {\n\t\tstate = active\n\t\tpid = 900\n\t}\n}\n`;
    expect(parseLaunchdPid(job, target)).toBe(42);
    const path = '/Users/fixture/Library/LaunchAgents/ai.openclaw.gateway.plist';
    const loaded = job.replace('\tstate = running', `\tpath = ${path}\n\tprogram = /bin/sh\n\tstate = running`);
    expect(parseLaunchdPid(loaded, target, path)).toBe(42);
    const args = ['/bin/sh', '/fixture/env-wrapper.sh'];
    const withArguments = loaded.replace('\tstate = running', `\targuments = {\n${args.map(arg => `\t\t${arg}`).join('\n')}\n\t}\n\tstate = running`);
    expect(parseLaunchdPid(withArguments, target, path, args)).toBe(42);
    expect(() => parseLaunchdPid(withArguments, target, path, ['/bin/sh', '/different/wrapper.sh'])).toThrow();

    expect(() => parseLaunchdPid(loaded, target, '/another/job.plist')).toThrow();
    expect(() => parseLaunchdPid(job.replace('\tstate = running', '\tstate = waiting'), target)).toThrow();
    expect(() => parseLaunchdPid(job.replace('\tpid = 42', '\tpid = 42\n\tpid = 43'), target)).toThrow();
    expect(() => parseLaunchdPid(job, 'gui/502/ai.openclaw.gateway')).toThrow();
  });
  test('requires a real process-start shape and rejects PID-only or unstable identity', () => {
    expect(parseProcessStart(identity.startedAt)).toBe(identity.startedAt);
    expect(() => parseProcessStart('unknown')).toThrow();
    expect(() => assertNewStableIdentity(identity, identity, identity)).toThrow();
    expect(() => assertNewStableIdentity(identity, next, { ...next, pid: 44 })).toThrow();
    expect(() => assertNewStableIdentity(identity, next, { ...next, startedAt: identity.startedAt })).toThrow();
    expect(() => assertNewStableIdentity(identity, next, next)).not.toThrow();
  });
  test('ties every listener to the launchd PID and the exact loopback endpoint', () => {
    expect(() => assertListenerOwner('p43\nf32\nn127.0.0.1:18789\nf33\nn[::1]:18789\n', 43, '127.0.0.1', 18789)).not.toThrow();
    for (const wrong of ['p44\nn127.0.0.1:18789\n', 'f32\nn127.0.0.1:18789\n', 'p43\nn*:18789\n', 'p43\nn127.0.0.1:18888\n', 'p43\nn127.0.0.1:18789\np44\nn[::1]:18789\n', '']) {
      expect(() => assertListenerOwner(wrong, 43, '127.0.0.1', 18789)).toThrow();
    }
  });
  test('accepts timestamped complete current-process startup lines only', () => {
    expect(freshBootLine('2026-09-08T10:01:01.100Z [gateway] http server listening (2 plugins: olympus, acpx; 1.3s)\n', next.startedAt, observedAt)).toContain('(2 plugins:');
    expect(freshBootLine('2026-09-08T10:01:01.100Z [gateway] http server listening (0 plugins, 0.4s)\n', next.startedAt, observedAt)).toContain('0 plugins');
    for (const wrong of [
      'An operator quoted [gateway] http server listening (2 plugins: olympus)\n',
      '2026-09-08T10:01:01.100Z [gateway] http server listening (N plugins)\n',
      '2026-09-08T10:01:01.100Z [gateway] http server listening (1 plugin: olympus)',
      '[gateway] http server listening (1 plugin: olympus)\n',
      '2026-09-08T10:01:00.999Z [gateway] http server listening (1 plugin: olympus)\n',
      '2026-09-08T10:05:00.000Z [gateway] http server listening (1 plugin: olympus)\n',
    ]) expect(() => freshBootLine(wrong, next.startedAt, observedAt)).toThrow();
  });
  test('predecessor A ready cannot certify successor B even when B owns the answering listener', () => {
    const predecessor = { ...next, pid: 43, startedAt: 'Tue Sep  8 10:01:00 2026' };
    const successor = { ...next, pid: 44, startedAt: 'Tue Sep  8 10:02:00 2026' };
    const aReady = '2026-09-08T10:01:01.100Z [gateway] http server listening (1 plugin: olympus; 1.1s)\n';
    // The identity/listener/HTTP legs can all succeed while B is initializing.
    expect(() => assertNewStableIdentity(identity, successor, successor)).not.toThrow();
    expect(() => assertListenerOwner('p44\nn127.0.0.1:18789\n', 44, '127.0.0.1', 18789)).not.toThrow();
    expect(freshBootLine(aReady, predecessor.startedAt, observedAt)).toContain('http server listening');
    expect(() => freshBootLine(aReady, successor.startedAt, observedAt)).toThrow();
    // An A line inside B's rounded birth second is also ambiguous and refused.
    expect(() => freshBootLine(aReady.replace('10:01:01.100', '10:02:00.999'), successor.startedAt, observedAt)).toThrow();
    const bReady = '2026-09-08T10:02:01.100Z [gateway] http server listening (1 plugin: olympus; 1.1s)\n';
    expect(freshBootLine(aReady + bReady, successor.startedAt, observedAt)).toBe(bReady.trim());
  });
  test('rejects old log bytes, rotation, and truncation while accepting a new complete append', () => {
    const dir = mkdtempSync(join(tmpdir(), 'darwin-boot-log-'));
    const path = join(dir, 'gateway.log');
    const boot = '2026-09-08T10:01:01.300Z [gateway] http server listening (1 plugin: olympus; 1.3s)\n';
    writeFileSync(path, boot, { mode: 0o600 });
    const fd = openSync(path, 'r'), frontier = fstatSync(fd);
    try {
      expect(() => readFreshLogAppend(fd, path, frontier, next.startedAt, observedAt)).toThrow();
      appendFileSync(path, 'waiting for startup\n');
      expect(() => readFreshLogAppend(fd, path, frontier, next.startedAt, observedAt)).toThrow();
      appendFileSync(path, boot);
      expect(readFreshLogAppend(fd, path, frontier, next.startedAt, observedAt)).toBe(boot.trim());
      truncateSync(path, 0);
      expect(() => readFreshLogAppend(fd, path, frontier, next.startedAt, observedAt)).toThrow();
      renameSync(path, join(dir, 'rotated.log'));
      writeFileSync(path, boot, { mode: 0o600 });
      expect(() => readFreshLogAppend(fd, path, frontier, next.startedAt, observedAt)).toThrow();
    } finally { closeSync(fd); rmSync(dir, { recursive: true, force: true }); }
  });
  test('requires matching valid default-profile CLI/service status and a live managed PID', () => {
    const home = '/Users/fixture', path = home + '/.openclaw/openclaw.json';
    const status = {
      service: { label: 'LaunchAgent', loaded: true, runtime: { status: 'running', pid: 42, cachedLabel: false }, command: { sourcePath: home + '/Library/LaunchAgents/ai.openclaw.gateway.plist' } },
      config: { cli: { exists: true, valid: true, path }, daemon: { exists: true, valid: true, path } },
    };
    expect(statusDescriptor(status, home).pid).toBe(42);
    expect(() => statusDescriptor({ ...status, service: { ...status.service, loaded: false } }, home)).toThrow();
    expect(() => statusDescriptor({ ...status, service: { ...status.service, runtime: { ...status.service.runtime, cachedLabel: true } } }, home)).toThrow();
    expect(() => statusDescriptor({ ...status, config: { ...status.config, daemon: { ...status.config.daemon, path: '/another/config.json' } } }, home)).toThrow();
  });
  test('dry-run performs no platform, credential, or lifecycle operations', () => {
    const node = Bun.which('node'); if (!node) throw new Error('node required');
    const out = execFileSync(node, [helperPath, '--dry-run'], { encoding: 'utf8', env: { PATH: '/nonexistent', HOME: '/nonexistent', OPENCLAW_SAFE_RESTART_OPENCLAW_BIN: '/must-not-run' } });
    expect(out).toContain('No checks or restart executed.');
  }, 30_000);
  test('native branch never enables exec audit or issues launchctl lifecycle verbs itself', () => {
    const source = readFileSync(helperPath, 'utf8');
    expect(source).toContain("['secrets', 'audit', '--check', '--json']");
    expect(source).not.toContain("'--allow-exec'");
    expect(source.match(/\['gateway', 'restart', '--preserve-definition'\]/g)).toHaveLength(1);
    expect(source).not.toMatch(/\['(?:kickstart|bootstrap|bootout)'/);
    expect(source).toContain('constants.O_NOFOLLOW');
    expect(source).toContain('frontier.size');
    expect(source).toContain('OpenClaw owns its internal lifecycle operations.');
    expect(source).not.toContain('Restarting the native Gateway exactly once.');
  });
});
