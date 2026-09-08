/**
 * Native macOS branch of openclaw-safe-restart.sh. Qualified contract: OpenClaw
 * 2026.9.2 default-profile LaunchAgent. No systemd emulation or exec SecretRefs.
 * Parser tests are fixtures; only a real invocation can produce a boot proof.
 */
import { spawnSync } from 'node:child_process';
import { accessSync, closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, readSync, realpathSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { userInfo } from 'node:os';

const LABEL = 'ai.openclaw.gateway';
const WRAPPER = '#!/bin/sh\nset -eu\nenv_file="$1"\nshift\nif [ -f "$env_file" ]; then\n  . "$env_file"\nfi\nexec "$@"\n';
const MAX_BYTES = 8 * 1024 * 1024;
const fail = (message, code = 75) => { const error = new Error(message); error.exitCode = code; throw error; };
const digest = value => createHash('sha256').update(value).digest('hex');
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const count = value => Number.isSafeInteger(value) && value >= 0;
const exactKeys = (value, keys) => record(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const safeText = value => typeof value === 'string' && value.trim() && !/[\u0000-\u001f\u007f]/u.test(value);

export function assertManagedWrapper(text) {
  if (text !== WRAPPER) fail('Managed environment wrapper differs from the qualified native wrapper.');
}

export function parseServiceEnvironment(text) {
  if (Buffer.byteLength(text) > 1024 * 1024 || text.includes('\0')) fail('Unsupported service environment file.');
  const env = Object.create(null);
  for (const line of text.split('\n')) {
    if (!line.trim() || line.startsWith('#')) continue;
    const match = /^export ([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
    if (!match || Object.hasOwn(env, match[1])) fail('Unsupported service environment assignment.');
    const token = match[2];
    let value = '', cursor = 0;
    while (cursor < token.length) {
      if (token[cursor] !== "'") fail('Service environment must use literal single-quoted values.');
      const end = token.indexOf("'", cursor + 1);
      if (end < 0) fail('Unterminated service environment value.');
      value += token.slice(cursor + 1, end); cursor = end + 1;
      if (cursor === token.length) break;
      if (token.slice(cursor, cursor + 2) === "\\'") { value += "'"; cursor += 2; }
      else if (token.slice(cursor, cursor + 3) === '"\'"') { value += "'"; cursor += 3; }
      else fail('Service environment contains executable shell syntax.');
    }
    if (token.length === 0 || value.includes('\r')) fail('Invalid service environment value.');
    env[match[1]] = value;
  }
  if (Object.keys(env).some(key => /^(?:OLYMPUS_OP_|OP_|ONEPASSWORD_|DYLD_)/.test(key))) {
    fail('External credential or process-loader environment requires a deployment-owned readiness procedure.', 78);
  }
  if (env.NODE_OPTIONS && !/^--max-old-space-size=[1-9][0-9]*$/.test(env.NODE_OPTIONS)) {
    fail('Unsupported Node startup options require separate review.', 78);
  }
  return env;
}

export function validateNativeAudit(report, exitCode) {
  if (!exactKeys(report, ['version', 'status', 'resolution', 'filesScanned', 'summary', 'findings'])
    || report.version !== 1 || !Array.isArray(report.findings)
    || !Array.isArray(report.filesScanned) || report.filesScanned.length === 0
    || !report.filesScanned.every(path => safeText(path) && isAbsolute(path))
    || new Set(report.filesScanned).size !== report.filesScanned.length
    || !exactKeys(report.resolution, ['refsChecked', 'skippedExecRefs', 'resolvabilityComplete'])
    || !count(report.resolution.refsChecked) || report.resolution.skippedExecRefs !== 0
    || report.resolution.resolvabilityComplete !== true
    || !exactKeys(report.summary, ['plaintextCount', 'unresolvedRefCount', 'shadowedRefCount', 'storeResidueCount', 'legacyResidueCount'])
    || !Object.values(report.summary).every(count) || report.summary.plaintextCount !== 0
    || report.summary.unresolvedRefCount !== 0 || report.summary.shadowedRefCount !== 0
    || report.summary.storeResidueCount !== 0
    || report.summary.legacyResidueCount !== report.findings.length) fail('Native credential audit was incomplete or unsafe.', 78);
  for (const finding of report.findings) {
    if (!exactKeys(finding, ['code', 'severity', 'file', 'jsonPath', 'message', 'provider', 'profileId'])
      || finding.code !== 'LEGACY_RESIDUE' || finding.severity !== 'info'
      || finding.message !== 'OAuth credentials are present (out of scope for static SecretRef migration).'
      || !safeText(finding.provider) || !safeText(finding.profileId)
      || finding.jsonPath !== `profiles.${finding.profileId}` || !safeText(finding.file)
      || basename(finding.file) !== 'openclaw.sqlite' || !report.filesScanned.includes(finding.file)) {
      fail('Native credential audit reported a blocking finding.', 78);
    }
  }
  const hasOAuth = report.findings.length > 0;
  if (report.status !== (hasOAuth ? 'findings' : 'clean') || exitCode !== (hasOAuth ? 1 : 0)) {
    fail('Native credential audit status was inconsistent.', 78);
  }
  return { refsChecked: report.resolution.refsChecked, nativeOAuthProfiles: report.findings.length };
}

export function parseLaunchdPid(text, target, expectedPath, expectedArguments) {
  if (!text.startsWith(`${target} = {\n`)) fail('Unexpected launchd job identity.');
  if (expectedPath !== undefined) {
    const paths = [...text.matchAll(/^\tpath = ([^\r\n]+)$/gm)];
    const programs = [...text.matchAll(/^\tprogram = ([^\r\n]+)$/gm)];
    if (paths.length !== 1 || paths[0][1] !== expectedPath || programs.length !== 1 || programs[0][1] !== '/bin/sh') {
      fail('Loaded launchd definition differs from the inspected managed plist.');
    }
  }
  if (expectedArguments !== undefined) {
    const blocks = [...text.matchAll(/^\targuments = \{\n([\s\S]*?)^\t\}/gm)];
    const lines = blocks.length === 1 ? blocks[0][1].split('\n').filter(Boolean) : [];
    if (!lines.length || lines.some(line => !/^\t\t[^\t\r\n]/.test(line))
      || JSON.stringify(lines.map(line => line.slice(2))) !== JSON.stringify(expectedArguments)) {
      fail('Loaded launchd arguments differ from the inspected managed definition.');
    }
  }
  const states = [...text.matchAll(/^\tstate = ([^\r\n]+)$/gm)];
  const pids = [...text.matchAll(/^\tpid = ([0-9]+)$/gm)];
  if (states.length !== 1 || states[0][1] !== 'running' || pids.length !== 1) fail('LaunchAgent is not unambiguously running.');
  const pid = Number(pids[0][1]);
  if (!Number.isSafeInteger(pid) || pid <= 1) fail('LaunchAgent has no valid PID.');
  return pid;
}

export function parseProcessStart(text) {
  const value = text.trim();
  if (!/^(Mon|Tue|Wed|Thu|Fri|Sat|Sun) (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) +[0-9]{1,2} [0-9]{2}:[0-9]{2}:[0-9]{2} [0-9]{4}$/.test(value)
    || !Number.isFinite(Date.parse(value + ' UTC'))) fail('Process start identity is unavailable.');
  return value;
}

export function assertListenerOwner(text, pid, hostname, port) {
  let owner; let expectedSocket = false; let sockets = 0;
  for (const line of text.trim().split('\n')) {
    if (/^p[1-9][0-9]*$/.test(line)) {
      owner = Number(line.slice(1));
      if (owner !== pid) fail('Gateway listener belongs to an unexpected process.');
      continue;
    }
    if (/^f.+$/.test(line)) {
      if (owner !== pid) fail('Gateway listener file has no expected process owner.');
      continue;
    }
    if (!line.startsWith('n') || owner !== pid) fail('Gateway listener belongs to an unexpected process.');
    const address = line.slice(1);
    if (![ `127.0.0.1:${port}`, `[::1]:${port}` ].includes(address)) fail('Gateway listener is not exclusively loopback.');
    sockets++; if (address === `${hostname}:${port}`) expectedSocket = true;
  }
  if (!sockets || !expectedSocket) fail('Expected loopback Gateway listener was not found.');
}

export function assertNewStableIdentity(previous, first, last) {
  if (first.pid === previous.pid && first.startedAt === previous.startedAt) fail('Gateway restart did not establish a new process.', 77);
  if (first.pid !== last.pid || first.startedAt !== last.startedAt || first.executable !== last.executable) {
    fail('Gateway process changed during boot proof.', 77);
  }
}

export function freshBootLine(text, startedAt, observedAtMs = Date.now()) {
  // ps lstart is only second-precision. Requiring the next whole UTC second
  // conservatively excludes every predecessor line from the birth second.
  const notBefore = Date.parse(parseProcessStart(startedAt) + ' UTC') + 1000;
  if (!Number.isFinite(observedAtMs)) fail('Boot-log observation time is unavailable.', 77);
  const pattern = /^(\d{4}-\d{2}-\d{2}T[0-9:.]+(?:Z|[+-][0-9:]+)) \[gateway\] http server listening \((?:0 plugins(?:, [0-9]+\.[0-9]+s)?|[1-9][0-9]* plugins?: [A-Za-z0-9_./@, -]+(?:; [0-9]+\.[0-9]+s)?)\)$/;
  for (const line of text.split('\n').slice(0, -1)) {
    const match = pattern.exec(line);
    if (!match) continue;
    const timestamp = Date.parse(match[1]);
    if (Number.isFinite(timestamp) && timestamp >= notBefore && timestamp <= observedAtMs) return line;
  }
  fail('No complete ready line is unambiguously newer than the final process start.', 77);
}

export function readFreshLogAppend(logFd, path, frontier, startedAt, observedAtMs = Date.now()) {
  const current = lstatSync(path), opened = fstatSync(logFd);
  if (!current.isFile() || current.dev !== frontier.dev || current.ino !== frontier.ino
    || current.uid !== frontier.uid || (current.mode & 0o022) !== 0
    || opened.size < frontier.size || opened.size - frontier.size > MAX_BYTES) {
    fail('Gateway log rotated, shrank, or exceeded the fresh-proof budget.', 77);
  }
  const appended = Buffer.alloc(opened.size - frontier.size);
  const read = readSync(logFd, appended, 0, appended.length, frontier.size);
  return freshBootLine(decode(appended.subarray(0, read)), startedAt, observedAtMs);
}

function executablePath(command, env) {
  const candidates = isAbsolute(command) ? [command] : (env.PATH || '').split(':').filter(isAbsolute).map(path => join(path, command));
  for (const candidate of candidates) {
    try { accessSync(candidate, constants.X_OK); return realpathSync(candidate); } catch { /* Try the next declared PATH entry. */ }
  }
  fail('The approved OpenClaw executable is unavailable.');
}
function execute(command, args, env, timeout = 10000) {
  const result = spawnSync(command, args, { env, stdio: ['ignore', 'pipe', 'pipe'], timeout, maxBuffer: MAX_BYTES });
  if (result.error || result.signal) fail('A required native command did not complete.');
  return result;
}
function decode(bytes) { try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { fail('Invalid command output encoding.'); } }
function commandText(command, args, env) {
  const result = execute(command, args, env);
  if (result.status !== 0) fail('A required native inspection failed.');
  return decode(result.stdout);
}
function commandJson(command, args, env) { try { return JSON.parse(commandText(command, args, env)); } catch { fail('Unsupported native status response.'); } }
function privateFile(path, uid, secret = false) {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  const stat = fstatSync(fd);
  if (!stat.isFile() || stat.uid !== uid || (stat.mode & (secret ? 0o077 : 0o022)) !== 0 || stat.size > MAX_BYTES) {
    closeSync(fd); fail('Managed file ownership, permissions, or size are unsafe.');
  }
  try { return readFileSync(fd); } finally { closeSync(fd); }
}
export function statusDescriptor(status, home) {
  const sourcePath = join(home, 'Library', 'LaunchAgents', LABEL + '.plist');
  if (!record(status) || status.service?.label !== 'LaunchAgent' || status.service.loaded !== true
    || status.service.runtime?.status !== 'running' || status.service.runtime.cachedLabel !== false
    || !Number.isSafeInteger(status.service.runtime.pid) || status.service.runtime.pid <= 1
    || status.service.command?.sourcePath !== sourcePath
    || status.config?.cli?.exists !== true || status.config.cli.valid !== true
    || status.config?.daemon?.exists !== true || status.config.daemon.valid !== true
    || status.config.cli.path !== status.config.daemon.path
    || status.config.daemon.path !== join(home, '.openclaw', 'openclaw.json')) fail('Unsupported default-profile LaunchAgent status.');
  return { sourcePath, pid: status.service.runtime.pid, configPath: status.config.daemon.path, command: status.service.command };
}

export async function runDarwinRestart(argv = process.argv.slice(2), env = process.env) {
  for (const arg of argv) if (!['--dry-run', '--preflight-only', '--secrets-touched', '--help', '-h'].includes(arg)) fail('Unknown safe-restart argument.', 64);
  if (argv.some(arg => ['--dry-run', '--help', '-h'].includes(arg))) {
    console.log('Darwin safe restart: verify the native managed environment; require reload mode off; config validate; doctor lint; complete native secrets audit without exec providers; invoke one official restart command; prove new launchd PID/start, owned loopback listener, HTTP success, and fresh boot-log append. No checks or restart executed.');
    return;
  }
  if (process.platform !== 'darwin' || typeof process.getuid !== 'function') fail('Darwin proof requires native macOS.');
  if (env.OPENCLAW_PROFILE) fail('Darwin safe restart currently supports the default profile only.');
  const uid = process.getuid(), home = env.HOME;
  const openclaw = executablePath(env.OPENCLAW_SAFE_RESTART_OPENCLAW_BIN || 'openclaw', env);
  if (!home || !isAbsolute(home) || home !== userInfo().homedir) fail('The actual macOS user home is required.');
  const inspectEnv = { ...env, LC_ALL: 'C' };
  if (!/^OpenClaw 2026\.9\.2 \([0-9a-f]+\)\s*$/.test(commandText(openclaw, ['--version'], inspectEnv))) fail('Darwin status/proof contract is qualified for OpenClaw 2026.9.2 only.');
  const status = commandJson(openclaw, ['gateway', 'status', '--no-probe', '--json'], inspectEnv);
  const descriptor = statusDescriptor(status, home);
  const configBytes = privateFile(descriptor.configPath, uid);
  const plistBytes = privateFile(descriptor.sourcePath, uid);
  const plist = commandJson('/usr/bin/plutil', ['-convert', 'json', '-o', '-', descriptor.sourcePath], inspectEnv);
  const expectedWrapper = join(home, '.openclaw', 'service-env', LABEL + '-env-wrapper.sh');
  const environmentPath = join(home, '.openclaw', 'service-env', LABEL + '.env');
  const arguments_ = plist.ProgramArguments;
  if (plist.Label !== LABEL || plist.Program !== undefined || !Array.isArray(arguments_)
    || arguments_[0] !== '/bin/sh' || arguments_[1] !== expectedWrapper || arguments_[2] !== environmentPath
    || JSON.stringify(arguments_.slice(3)) !== JSON.stringify(descriptor.command.programArguments)
    || (plist.EnvironmentVariables && Object.keys(plist.EnvironmentVariables).length !== 0)) fail('Unsupported managed LaunchAgent command or environment wrapper.');
  const wrapperBytes = privateFile(expectedWrapper, uid);
  assertManagedWrapper(decode(wrapperBytes));
  const environmentBytes = privateFile(environmentPath, uid, true);
  const serviceEnv = parseServiceEnvironment(decode(environmentBytes));
  if (serviceEnv.HOME !== home || serviceEnv.OPENCLAW_LAUNCHD_LABEL !== LABEL || !serviceEnv.PATH
    || ['OPENCLAW_PROFILE', 'OPENCLAW_STATE_DIR', 'OPENCLAW_CONFIG_PATH'].some(key => Boolean(serviceEnv[key]))) fail('Service environment does not identify this user and LaunchAgent.');
  const nativeEnv = { ...serviceEnv, LC_ALL: 'C', TZ: 'UTC' };
  const program = arguments_[3], entryIndex = arguments_.indexOf('gateway') - 1;
  if (!isAbsolute(program) || basename(program) !== 'node' || entryIndex < 4
    || !isAbsolute(arguments_[entryIndex]) || !arguments_[entryIndex].endsWith('/openclaw/dist/index.js')
    || arguments_.slice(4, entryIndex).some(arg => !/^--max-old-space-size=[1-9][0-9]*$/.test(arg))
    || JSON.stringify(arguments_.slice(entryIndex + 1, -1)) !== JSON.stringify(['gateway', '--port'])) fail('Unsupported native Gateway invocation.');
  if (realpathSync(join(dirname(dirname(arguments_[entryIndex])), 'openclaw.mjs')) !== openclaw) fail('CLI and managed Gateway entry do not belong to the same OpenClaw install.');
  const port = Number(arguments_.at(-1));
  if (!Number.isInteger(port) || port < 1 || port > 65535 || status.gateway?.port !== port || status.gateway.bindHost !== '127.0.0.1') fail('Gateway is not configured on the expected loopback port.');
  const expectedUrl = `http://127.0.0.1:${port}/`;
  if (env.OPENCLAW_GATEWAY_LOOPBACK_URL && env.OPENCLAW_GATEWAY_LOOPBACK_URL !== expectedUrl) fail('Configured proof URL differs from the managed Gateway endpoint.');
  if (commandJson(openclaw, ['config', 'get', 'gateway.reload.mode', '--json'], nativeEnv) !== 'off') fail('Set gateway.reload.mode off through the blessed CLI before controlled activation.');
  const bootTimeout = Number(env.OPENCLAW_SAFE_RESTART_BOOT_TIMEOUT_SECONDS ?? 90);
  const pollSeconds = Number(env.OPENCLAW_SAFE_RESTART_BOOT_POLL_SECONDS ?? 2);
  if (!Number.isInteger(bootTimeout) || bootTimeout < 0 || bootTimeout > 600 || !Number.isInteger(pollSeconds) || pollSeconds < 1 || pollSeconds > 30) fail('Invalid bounded boot-proof timing.', 64);
  const target = `gui/${uid}/${LABEL}`, expectedExecutable = realpathSync(program);
  const capture = () => {
    const pid = parseLaunchdPid(commandText('/bin/launchctl', ['print', target], nativeEnv), target, descriptor.sourcePath, arguments_);
    const startedAt = parseProcessStart(commandText('/bin/ps', ['-p', String(pid), '-o', 'lstart='], nativeEnv));
    if (Number(commandText('/bin/ps', ['-p', String(pid), '-o', 'uid='], nativeEnv).trim()) !== uid) fail('Gateway process owner changed.');
    const executable = realpathSync(commandText('/bin/ps', ['-p', String(pid), '-o', 'comm='], nativeEnv).trim());
    if (executable !== expectedExecutable) fail('LaunchAgent PID is not the expected Gateway executable.');
    return { pid, startedAt, executable };
  };
  const listeners = pid => assertListenerOwner(commandText('/usr/sbin/lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-Fpn'], nativeEnv), pid, '127.0.0.1', port);
  const previous = capture();
  if (previous.pid !== descriptor.pid) fail('Gateway changed while its service environment was inspected.');
  listeners(previous.pid);
  console.log('Darwin native config and credential preflight.');
  for (const args of [['config', 'validate'], ['doctor', '--lint', '--severity-min', 'error', '--non-interactive']]) {
    if (execute(openclaw, args, nativeEnv, 60000).status !== 0) fail('Native validation or lint refused restart.', 78);
  }
  const audit = execute(openclaw, ['secrets', 'audit', '--check', '--json'], nativeEnv, 60000);
  let auditReport;
  try { auditReport = JSON.parse(decode(audit.stdout)); } catch { fail('Native credential audit did not return supported JSON.', 78); }
  const readiness = validateNativeAudit(auditReport, audit.status);
  console.log(`Native credential readiness proved: ${readiness.refsChecked} local references; ${readiness.nativeOAuthProfiles} native OAuth profiles; no skipped exec references.`);
  const watched = [[descriptor.sourcePath, plistBytes, false], [expectedWrapper, wrapperBytes, false], [environmentPath, environmentBytes, true], [descriptor.configPath, configBytes, false]];
  for (const [path, bytes, secretFile] of watched) if (digest(privateFile(path, uid, secretFile)) !== digest(bytes)) fail('Managed startup inputs changed during preflight.');
  if (argv.includes('--preflight-only')) { console.log('Darwin preflight passed; no restart was run.'); return; }
  if (!isAbsolute(plist.StandardOutPath) || !plist.StandardOutPath.startsWith(join(home, 'Library', 'Logs') + '/')) fail('Unsupported managed Gateway stdout log path.');
  const logFd = openSync(plist.StandardOutPath, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const frontier = fstatSync(logFd);
    if (!frontier.isFile() || frontier.uid !== uid || (frontier.mode & 0o022) !== 0) fail('Gateway stdout log is not an owned regular file.');
    const before = capture(); listeners(before.pid);
    if (before.pid !== previous.pid || before.startedAt !== previous.startedAt) fail('Gateway changed during preflight.');
    for (const [path, bytes, secretFile] of watched) if (digest(privateFile(path, uid, secretFile)) !== digest(bytes)) fail('Managed startup inputs changed during preflight.');
    console.log('Invoking one official Gateway restart command; OpenClaw owns its internal lifecycle operations.');
    let restart;
    try { restart = execute(openclaw, ['gateway', 'restart', '--preserve-definition'], nativeEnv, 120000); }
    catch { fail('Official Gateway restart did not complete; no retry was attempted.', 76); }
    if (restart.status !== 0) fail('Official Gateway restart failed; no retry was attempted.', 76);
    const deadline = Date.now() + bootTimeout * 1000;
    do {
      try {
        const first = capture(); listeners(first.pid);
        const http = execute('/usr/bin/curl', ['--fail', '--silent', '--show-error', '--noproxy', '*', '--connect-timeout', '1', '--max-time', '3', '--output', '/dev/null', '--write-out', '%{http_code}', expectedUrl], nativeEnv, 5000);
        if (http.status !== 0 || !/^2[0-9]{2}$/.test(decode(http.stdout))) fail('Gateway loopback HTTP function was not successful.', 77);
        const line = readFreshLogAppend(logFd, plist.StandardOutPath, frontier, first.startedAt);
        const last = capture(); listeners(last.pid); assertNewStableIdentity(previous, first, last);
        for (const [path, bytes, secretFile] of watched) if (digest(privateFile(path, uid, secretFile)) !== digest(bytes)) fail('Managed startup inputs changed across restart.', 77);
        console.log(`Gateway boot proved: LaunchAgent=${target} PID=${last.pid} startedUTC=${last.startedAt}; owned loopback listener answered at ${expectedUrl}; fresh corroborating log line: ${line}`);
        return;
      } catch { if (Date.now() >= deadline) break; }
      await new Promise(resolve => setTimeout(resolve, pollSeconds * 1000));
    } while (Date.now() <= deadline);
    fail('Darwin Gateway boot unproven: new stable process, owned listener, HTTP success, and fresh log are all required. Run openclaw gateway stability --bundle latest; do not retry restart automatically.', 77);
  } finally { closeSync(logFd); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runDarwinRestart().catch(error => {
    // Never print command output, service environment assignments, or audit bodies.
    console.error(error?.exitCode ? error.message : 'Darwin safe restart refused an unsupported or unreadable native prerequisite.');
    process.exitCode = error?.exitCode ?? 75;
  });
}
