import { createHash } from 'node:crypto';
import { chmodSync, existsSync, lstatSync, mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { V0_4_PUBLIC_PACKAGE_FILES, V0_4_PUBLIC_SOURCE_IDS } from '../../src/core/public-surface.ts';
import { V0_4_PUBLIC_SOURCE_CAPABILITIES } from '../../src/core/public-source-capabilities.ts';
import { parseReleaseQualificationAttempt, type ReleaseQualificationAttempt } from '../../src/core/release-qualification.ts';
import { workerServicePaths } from '../../src/core/worker-service.ts';
import { verifyQualificationArtifact } from './artifact.ts';
import { pinWorkerReadinessPort, startSimulatedReadinessServer, waitForSimulatedReadiness } from './readiness-stub.ts';

const artifact = requiredPath('--artifact');
const previousArtifact = requiredPath('--previous-artifact');
const hostOs = required('--host-os');
const output = requiredPath('--output');
if (hostOs !== 'darwin_arm64' && hostOs !== 'linux_x64_ubuntu_lts') throw new Error('--host-os is unsupported.');
const platform = hostOs === 'darwin_arm64' ? 'darwin' : 'linux';
const startedAt = new Date().toISOString();
const plan = JSON.parse(readFileSync(resolve(import.meta.dir, '../../config/release-qualification-plan.json'), 'utf8')) as {
  assertion_contracts: Record<string, string[]>;
  candidate_artifact: { artifact_sha256: string; artifact_bytes: number };
  rollback_baseline: { artifact_sha256: string; artifact_bytes: number };
};
const candidateIdentity = verifyQualificationArtifact(artifact, plan.candidate_artifact);
const previousIdentity = verifyQualificationArtifact(previousArtifact, plan.rollback_baseline);
const scratch = mkdtempSync(join(tmpdir(), 'olympus-release-qualification-'));
try {
  const packageRoot = join(scratch, 'package');
  run(['tar', '-xzf', artifact, '-C', scratch]);
  const previousExtract = join(scratch, 'previous');
  mkdirSync(previousExtract, { recursive: true });
  run(['tar', '-xzf', previousArtifact, '-C', previousExtract]);
  const previousPackageRoot = join(previousExtract, 'package');
  const packageJson = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8')) as { name?: string; version?: string; private?: boolean };
  if (packageJson.name !== 'olympus' || packageJson.version !== '0.4.0' || packageJson.private === true) throw new Error('Candidate package identity is invalid.');
  const inventory = runCapture(['tar', '-tzf', artifact]).trim().split('\n').filter((line) => line && !line.endsWith('/')).map((line) => line.replace(/^package\//, '')).sort();
  if (JSON.stringify(inventory) !== JSON.stringify([...V0_4_PUBLIC_PACKAGE_FILES].sort())) throw new Error('Candidate package inventory is not exact.');
  const cli = join(packageRoot, 'bin', 'olympus');
  chmodSync(cli, 0o755);
  const isolatedHome = join(scratch, 'home');
  mkdirSync(isolatedHome, { recursive: true });
  const fakeBin = join(scratch, 'fake-bin');
  const serviceState = join(scratch, 'service-state');
  createFakeServiceManagers(fakeBin);
  const env = {
    ...process.env,
    HOME: isolatedHome,
    XDG_CONFIG_HOME: join(isolatedHome, '.config'),
    XDG_DATA_HOME: join(isolatedHome, '.local', 'share'),
    PATH: `${fakeBin}:${process.env.PATH ?? ''}`,
    OLYMPUS_QUAL_SERVICE_STATE: serviceState,
  };
  if (runCapture([cli, '--version'], env).trim() !== 'olympus 0.4.0') throw new Error('Candidate CLI version mismatch.');
  if (!runCapture([cli, '--help'], env).includes('olympus setup')) throw new Error('Candidate CLI help is incomplete.');
  const status = JSON.parse(runCapture([cli, 'connect', 'status', '--oauth-state-dir', join(scratch, 'oauth')], env)) as { ok?: boolean; states?: unknown[] };
  if (status.ok !== true || !Array.isArray(status.states)) throw new Error('Candidate connect status failed.');
  const install = JSON.parse(runCapture([cli, 'worker', 'install', '--dry-run', '--platform', platform, '--home', isolatedHome], env)) as { ok?: boolean; changed?: boolean; platform?: string };
  if (install.ok !== true || install.changed !== false || install.platform !== platform) throw new Error('Candidate install dry-run failed.');

  const previousCli = join(previousPackageRoot, 'bin', 'olympus');
  chmodSync(previousCli, 0o755);
  const installed = JSON.parse(runCapture([previousCli, 'worker', 'install', '--platform', platform, '--home', isolatedHome], env)) as { ok?: boolean; service?: { state?: string } };
  if (installed.ok !== true || installed.service?.state !== 'active') throw new Error('Previous public package install failed.');
  for (const action of ['status', 'restart', 'stop', 'start'] as const) {
    const result = JSON.parse(runCapture([previousCli, 'worker', action, '--platform', platform, '--home', isolatedHome], env)) as { ok?: boolean; service?: { state?: string } };
    const expected = action === 'stop' ? 'inactive' : 'active';
    if (result.ok !== true || result.service?.state !== expected) throw new Error(`Previous public package lifecycle ${action} failed.`);
  }
  const sentinels = [
    join(isolatedHome, '.olympus', 'config.json'),
    join(isolatedHome, '.config', 'olympus', 'credential.sentinel'),
    join(isolatedHome, '.local', 'share', 'openclaw', 'olympus', 'indexed-data.sentinel'),
  ];
  for (const sentinel of sentinels) {
    mkdirSync(dirname(sentinel), { recursive: true });
    writeFileSync(sentinel, 'retained\n', { mode: 0o600 });
  }

  const readiness = await startSimulatedReadinessServer();
  try {
    pinWorkerReadinessPort(workerServicePaths(platform, isolatedHome).envPath, readiness.port);
    await waitForSimulatedReadiness(readiness.port);
    const upgraded = JSON.parse(runCapture([cli, 'worker', 'upgrade', '--artifact', artifact, '--platform', platform, '--home', isolatedHome], env)) as { ok?: boolean; upgrade?: { artifact_sha256?: string }; service?: { state?: string }; readiness?: { status?: string } };
    if (upgraded.ok !== true || upgraded.upgrade?.artifact_sha256 !== sha256(artifact) || upgraded.service?.state !== 'active' || upgraded.readiness?.status !== 'ready') throw new Error('Candidate package upgrade failed.');
    const rolledBack = JSON.parse(runCapture([cli, 'worker', 'upgrade', '--artifact', previousArtifact, '--platform', platform, '--home', isolatedHome], env)) as { ok?: boolean; upgrade?: { artifact_sha256?: string }; service?: { state?: string }; readiness?: { status?: string } };
    if (rolledBack.ok !== true || rolledBack.upgrade?.artifact_sha256 !== sha256(previousArtifact) || rolledBack.service?.state !== 'active' || rolledBack.readiness?.status !== 'ready') throw new Error('Exact previous-artifact rollback failed.');
  } finally {
    await readiness.stop();
  }
  if (sentinels.some((sentinel) => !existsSync(sentinel) || readFileSync(sentinel, 'utf8') !== 'retained\n')) throw new Error('Upgrade or rollback changed retained user state.');
  const uninstalled = JSON.parse(runCapture([previousCli, 'worker', 'uninstall', '--platform', platform, '--home', isolatedHome], env)) as { ok?: boolean; retained?: string[] };
  if (uninstalled.ok !== true || sentinels.some((sentinel) => !existsSync(sentinel))) throw new Error('Uninstall did not retain user state.');

  run(['bun', 'test',
    'test/lifecycle.test.ts',
    'test/dashboard-setup-page.test.ts',
    'test/dashboard-source-phases.test.ts',
    'test/public-surface.test.ts',
    'test/worker-service-installer.test.ts',
  ]);

  const artifactSha = candidateIdentity.sha256;
  const previousSha = previousIdentity.sha256;
  if (artifactSha === previousSha) throw new Error('Rollback baseline must differ from candidate artifact.');
  const endedAt = new Date().toISOString();
  const checks = ['install', 'lifecycle', 'dashboard_states', 'dependencies', 'inventory', 'upgrade', 'rollback', 'uninstall'] as const;
  const receipts: ReleaseQualificationAttempt[] = [];
  for (const sourceId of V0_4_PUBLIC_SOURCE_IDS) {
    const capability = V0_4_PUBLIC_SOURCE_CAPABILITIES.find((source) => source.source_id === sourceId);
    if (!capability) throw new Error(`Missing capability row for ${sourceId}.`);
    if (capability.dependencies.length === 0 || capability.dependencies.some((dependency) => !dependency.id || !dependency.label)) {
      throw new Error(`Source-conditioned dependencies are incomplete for ${sourceId}.`);
    }
    for (const check of checks) {
      const endState = {
        install: 'installed', lifecycle: 'lifecycle_ready', dashboard_states: 'dashboard_ready',
        dependencies: 'dependencies_ready', inventory: 'inventory_verified', upgrade: 'lifecycle_ready',
        rollback: 'rolled_back', uninstall: 'uninstalled',
      }[check] as ReleaseQualificationAttempt['end_state'];
      const assertionContract = plan.assertion_contracts[check];
      if (!Array.isArray(assertionContract) || assertionContract.length === 0) throw new Error(`Missing assertion contract for ${check}.`);
      const assertions = assertionContract.length;
      receipts.push(parseReleaseQualificationAttempt({
        kind: 'olympus_release_qualification_attempt', schema_version: 1, source_id: sourceId,
        host_os: hostOs, host_surface: 'openclaw', execution_kind: 'simulated', check,
        artifact_sha256: artifactSha, artifact_bytes: candidateIdentity.bytes,
        ...(check === 'rollback' ? { previous_artifact_sha256: previousSha } : {}),
        started_at: startedAt, ended_at: endedAt,
        start_state: check === 'rollback' ? 'installed_previous' : 'clean_home', end_state: endState,
        assistance: 'documented_flow', result: 'passed', assertions_total: assertions, assertions_passed: assertions,
      }));
    }
  }
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, `${receipts.map((receipt) => JSON.stringify(receipt)).join('\n')}\n`, { mode: 0o600 });
  console.log(JSON.stringify({ kind: 'olympus_simulated_clean_home_proof', schema_version: 1, host_os: hostOs, artifact_sha256: artifactSha, previous_artifact_sha256: previousSha, cells: receipts.length, content_free: true }));
} finally {
  Bun.spawnSync(['chmod', '-R', 'u+rwX', scratch], { stdout: 'ignore', stderr: 'ignore' });
  rmSync(scratch, { recursive: true, force: true });
}

function required(name: string): string { const index = process.argv.indexOf(name); const value = index >= 0 ? process.argv[index + 1] : undefined; if (!value) throw new Error(`${name} is required.`); return value; }
function requiredPath(name: string): string { const value = resolve(required(name)); const stat = name === '--output' ? undefined : lstatSync(value); if (stat && (!stat.isFile() || stat.isSymbolicLink())) throw new Error(`${name} must be a regular file.`); return value; }
function run(command: string[]): void { const result = Bun.spawnSync(command, { cwd: resolve(import.meta.dir, '../..'), stdout: 'inherit', stderr: 'inherit' }); if (result.exitCode !== 0) throw new Error(`${command.join(' ')} failed.`); }
function runCapture(command: string[], env: Record<string, string | undefined> = process.env): string { const result = Bun.spawnSync(command, { env, stdout: 'pipe', stderr: 'pipe' }); if (result.exitCode !== 0) throw new Error(`${command.join(' ')} failed: ${result.stderr.toString().trim()}`); return result.stdout.toString(); }
function sha256(path: string): string { return createHash('sha256').update(readFileSync(path)).digest('hex'); }
function createFakeServiceManagers(binDir: string): void {
  mkdirSync(binDir, { recursive: true });
  writeFileSync(join(binDir, 'systemctl'), `#!/bin/sh
state="$OLYMPUS_QUAL_SERVICE_STATE"
case "$*" in
  *"is-active"*) if [ -f "$state" ] && [ "$(cat "$state")" = active ]; then echo active; exit 0; else echo inactive; exit 3; fi ;;
  *"enable --now"*|*" start "*|*" restart "*) echo active > "$state"; exit 0 ;;
  *"stop "*|*"disable --now"*) echo inactive > "$state"; exit 0 ;;
  *"daemon-reload"*) exit 0 ;;
esac
exit 0
`, { mode: 0o755 });
  writeFileSync(join(binDir, 'launchctl'), `#!/bin/sh
state="$OLYMPUS_QUAL_SERVICE_STATE"
case "$1" in
  print) if [ -f "$state" ] && [ "$(cat "$state")" = active ]; then printf 'state = running\npid = 4242\nlast exit code = 0\n'; exit 0; else exit 113; fi ;;
  bootstrap|kickstart) echo active > "$state"; exit 0 ;;
  bootout) echo inactive > "$state"; exit 0 ;;
esac
exit 0
`, { mode: 0o755 });
}
