/**
 * Update now (issue #1063): the engine updates itself from the dashboard on
 * this computer, with no Terminal.
 *
 * 1. Download the signed release manifest and the installer it names.
 * 2. Check the manifest's signature against the release key shipped in this
 *    package, and the installer against the manifest (release-signing.ts).
 * 3. Run that installer's own update path, which checks every download
 *    against its pins, swaps the new version in, restarts the engine on it
 *    and puts the previous version back by itself when the new one does not
 *    prove healthy.
 * 4. The engine restarts; the new (or restored) engine reports the outcome.
 *
 * The installer runs outside the engine's own process tree, so restarting the
 * engine cannot stop it: a detached session on macOS (the same handoff the
 * server-mode change uses) and a transient systemd user unit on Linux. The
 * engine runs it, not the browser, so a Mac in server mode or a Linux host
 * with nobody signed in at the console updates the same way.
 *
 * Progress is a small record on disk, so the engine that comes back after the
 * restart can say how it went. No secret, path or item content is in it.
 */
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { writePrivateFileAtomicSync } from './atomic-file.ts';
import { linuxEngineEnvironment, resolveLinuxEngineLayout } from './linux-engine-layout.ts';
import {
  checkInstallerAgainstManifest, RELEASE_MANIFEST_MAX_BYTES, RELEASE_SIGNING_PUBLIC_KEY, releaseManifestUrl,
  releasePlatformFor, releasePublicKey, verifySignedReleaseManifest,
} from './release-signing.ts';
import { installerForPlatform, newerVersion, UPDATE_MAX_BYTES } from './update-check.ts';

export const SELF_UPDATE_DOWNLOAD_TIMEOUT_MS = 30_000;
/** A run with no result after this long did not finish. */
export const SELF_UPDATE_STALE_MS = 30 * 60_000;
/** How long a finished update keeps saying so on the dashboard. */
export const SELF_UPDATE_SHOWN_MS = 10 * 60_000;

export type SelfUpdateStep = 1 | 2 | 3 | 4;
export type SelfUpdateStatus =
  | { state: 'idle' }
  | { state: 'running'; step: SelfUpdateStep; from: string; to: string }
  | { state: 'done'; from: string; version: string }
  | { state: 'rolled_back'; from: string; to: string }
  | { state: 'failed'; from: string; to?: string; reason: SelfUpdateFailure };

export type SelfUpdateFailure =
  | 'download_failed'
  | 'bad_signature'
  | 'installer_mismatch'
  | 'launch_failed'
  | 'install_failed'
  | 'interrupted'
  | 'did_not_finish';

export type SelfUpdateRefusal = 'no_release_key' | 'not_available' | 'no_update';
export type SelfUpdateStart =
  | { ok: true; status: SelfUpdateStatus }
  | { ok: false; refusal: SelfUpdateRefusal };

interface SelfUpdateRecord {
  id: string;
  from: string;
  to: string;
  /** 1 download, 2 check signature, 3 install (the installer is running), or the failure. */
  step: 1 | 2 | 3;
  failure?: SelfUpdateFailure;
  started_at: number;
  engine_pid: number;
}

export interface SelfUpdaterOptions {
  platform: string;
  runningVersion: string;
  /** Owner-only folder for the progress record and each run's files. */
  stateDir: string;
  /** Only the standalone engine was installed by the installer this runs. */
  standaloneEngine: boolean;
  /** The version the update check found, when it found one. */
  available: () => { version: string } | undefined;
  /** The shipped key unless a test supplies its own. */
  publicKeyPem?: string | undefined;
  fetchImpl?: typeof fetch;
  /** Starts `/bin/sh <runner> <run dir>` outside the engine's process tree. */
  launch?: (runner: string, runDir: string) => Promise<void>;
  now?: () => number;
  pid?: number;
  homeDir?: string;
}

/** Fixed text: run the verified installer, then record its exit status and when it ended. */
const RUNNER = `#!/bin/sh
dir=$1
/bin/sh "$dir/install.sh" > "$dir/install.log" 2>&1 < /dev/null
code=$?
printf '%s %s\\n' "$code" "$(date +%s)" > "$dir/result.next" && mv -f "$dir/result.next" "$dir/result"
`;

/**
 * What the installers print when the previous version is back and healthy:
 * install-macos.sh's own lines, and on Linux the lifecycle's
 * (engine-service.ts) "Previous installation restoration proved healthy."
 * A failed restoration ("restoration failed") is not a rollback.
 */
const RESTORED = /previous version was (?:restored|put back)|Previous installation restoration proved healthy/i;

/**
 * The systemd-run arguments for the update on Linux. A transient unit takes the
 * user manager's environment, not the engine's, so the engine's own layout
 * (the variables its unit sets, linuxEngineEnvironment) is passed in full:
 * otherwise install-linux.sh would fall back to $HOME defaults and could
 * update a different tree.
 */
export function linuxSelfUpdateRunArgs(runner: string, runDir: string, layoutEnv: Record<string, string>): string[] {
  return [
    '--user', '--collect', '--quiet', `--unit=olympus-update-${runDir.slice(-16)}`,
    ...Object.entries(layoutEnv).map(([name, value]) => `--setenv=${name}=${value}`),
    '--', '/bin/sh', runner, runDir,
  ];
}

function defaultLaunch(platform: string, homeDir: string | undefined): (runner: string, runDir: string) => Promise<void> {
  return (runner, runDir) => new Promise((resolve, reject) => {
    if (platform === 'linux') {
      // Its own transient unit: the engine unit's restart stops every process
      // in the engine's cgroup, so a plain child would die with it.
      let args: string[];
      try { args = linuxSelfUpdateRunArgs(runner, runDir, linuxEngineEnvironment(resolveLinuxEngineLayout(process.env))); } catch (error) { reject(error); return; }
      const child = spawn('/usr/bin/systemd-run', args, { stdio: 'ignore' });
      child.once('error', reject);
      child.once('exit', code => code === 0 ? resolve() : reject(new Error('systemd-run failed')));
      return;
    }
    // Its own session, out of the engine job's process group, as the
    // server-mode handoff (engine-service.ts) does.
    const child = spawn('/bin/sh', [runner, runDir], {
      detached: true, stdio: 'ignore',
      env: { HOME: homeDir ?? process.env.HOME ?? '', PATH: '/usr/bin:/bin:/usr/sbin:/sbin', OLYMPUS_NO_MODIFY_PATH: '1', ...(process.env.TMPDIR ? { TMPDIR: process.env.TMPDIR } : {}) },
    });
    child.once('error', reject);
    child.once('spawn', () => { child.unref(); resolve(); });
  });
}

async function download(fetchImpl: typeof fetch, url: string, maxBytes: number): Promise<Uint8Array> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), SELF_UPDATE_DOWNLOAD_TIMEOUT_MS);
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    const response = await fetchImpl(url, { method: 'GET', headers: { 'User-Agent': 'Olympus' }, credentials: 'omit', redirect: 'error', signal: controller.signal });
    reader = response.body?.getReader();
    if (!response.ok || Number(response.headers.get('content-length')) > maxBytes || !reader) throw new Error('unavailable');
    const chunks: Uint8Array[] = [];
    let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) throw new Error('oversized');
      chunks.push(value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return bytes;
  } finally {
    clearTimeout(timeout);
    void reader?.cancel().catch(() => undefined);
  }
}

export function createSelfUpdater(options: SelfUpdaterOptions) {
  const now = options.now ?? Date.now;
  const pid = options.pid ?? process.pid;
  const fetchImpl = options.fetchImpl ?? fetch;
  const launch = options.launch ?? defaultLaunch(options.platform, options.homeDir);
  const publicKeyPem = 'publicKeyPem' in options ? options.publicKeyPem : RELEASE_SIGNING_PUBLIC_KEY;
  const statePath = join(options.stateDir, 'state.json');
  const installer = installerForPlatform(options.platform);
  const platform = releasePlatformFor(options.platform);
  let busy = false;

  function read(): SelfUpdateRecord | undefined {
    try {
      const value = JSON.parse(readFileSync(statePath, 'utf8')) as SelfUpdateRecord;
      return typeof value?.id === 'string' && /^[0-9a-f]{16}$/.test(value.id) ? value : undefined;
    } catch { return undefined; }
  }
  function write(record: SelfUpdateRecord): void {
    mkdirSync(options.stateDir, { recursive: true, mode: 0o700 });
    writePrivateFileAtomicSync(statePath, JSON.stringify(record));
  }
  const runDir = (id: string) => join(options.stateDir, `run-${id}`);

  function status(): SelfUpdateStatus {
    const record = read();
    if (!record) return { state: 'idle' };
    const { from, to } = record;
    if (record.failure) return now() - record.started_at > SELF_UPDATE_SHOWN_MS ? { state: 'idle' } : { state: 'failed', from, to, reason: record.failure };
    if (record.step < 3) {
      // Downloading or checking happens inside the engine: a different engine means it was cut short.
      if (record.engine_pid === pid) return { state: 'running', step: record.step, from, to };
      return now() - record.started_at > SELF_UPDATE_SHOWN_MS ? { state: 'idle' } : { state: 'failed', from, to, reason: 'interrupted' };
    }
    let result: string | undefined;
    try { result = readFileSync(join(runDir(record.id), 'result'), 'utf8'); } catch { result = undefined; }
    if (result === undefined) {
      if (now() - record.started_at > SELF_UPDATE_STALE_MS) return { state: 'failed', from, to, reason: 'did_not_finish' };
      // The installer is still running. A new engine process means it already restarted the engine.
      return { state: 'running', step: record.engine_pid === pid ? 3 : 4, from, to };
    }
    const [codeText, endedText] = result.trim().split(/\s+/);
    const ended = Number(endedText) * 1000;
    if (Number.isFinite(ended) && now() - ended > SELF_UPDATE_SHOWN_MS) return { state: 'idle' };
    if (codeText === '0') {
      // The installer proved the new build healthy; this engine may be the old one, about to stop.
      return options.runningVersion === to ? { state: 'done', from, version: to } : { state: 'running', step: 4, from, to };
    }
    let log = '';
    try { log = readFileSync(join(runDir(record.id), 'install.log'), 'utf8'); } catch { log = ''; }
    // Structured first: a failed install never restarts the engine before its
    // swap, so a different engine process running the old version means the
    // installer swapped, restarted, and put the old version back. The log
    // wording covers a restore that kept the same process.
    if (options.runningVersion === from && (record.engine_pid !== pid || RESTORED.test(log))) return { state: 'rolled_back', from, to };
    return { state: 'failed', from, to, reason: 'install_failed' };
  }

  function fail(record: SelfUpdateRecord, failure: SelfUpdateFailure): void {
    write({ ...record, failure });
  }

  async function run(record: SelfUpdateRecord): Promise<void> {
    let manifestBytes: Uint8Array, installerBytes: Uint8Array;
    try {
      manifestBytes = await download(fetchImpl, releaseManifestUrl(installer!.url), RELEASE_MANIFEST_MAX_BYTES);
      installerBytes = await download(fetchImpl, installer!.url, UPDATE_MAX_BYTES);
    } catch { fail(record, 'download_failed'); return; }
    write({ ...record, step: 2 });
    const signed = verifySignedReleaseManifest(manifestBytes, publicKeyPem);
    if (!signed.ok) { fail(record, 'bad_signature'); return; }
    const manifest = signed.manifest;
    if (!newerVersion(manifest.version, options.runningVersion)) { fail(record, 'installer_mismatch'); return; }
    const checked = checkInstallerAgainstManifest(manifest, installerBytes, platform!);
    if (!checked.ok) { fail(record, 'installer_mismatch'); return; }
    const next: SelfUpdateRecord = { ...record, to: manifest.version, step: 3 };
    const dir = runDir(record.id);
    try {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      chmodSync(dir, 0o700);
      writePrivateFileAtomicSync(join(dir, 'install.sh'), installerBytes);
      writePrivateFileAtomicSync(join(dir, 'run.sh'), RUNNER);
      write(next);
      await launch(join(dir, 'run.sh'), dir);
    } catch { fail(next, 'launch_failed'); }
  }

  return {
    status,
    /** Starts an update when one is available and nothing is running; the steps continue in the background. */
    start(): SelfUpdateStart {
      if (!installer || !platform || !options.standaloneEngine) return { ok: false, refusal: 'not_available' };
      if (!releasePublicKey(publicKeyPem)) return { ok: false, refusal: 'no_release_key' };
      const current = status();
      if (busy || current.state === 'running') return { ok: true, status: current };
      const target = options.available();
      if (!target || !newerVersion(target.version, options.runningVersion)) return { ok: false, refusal: 'no_update' };
      // One run's files at a time: an earlier run's are no longer needed.
      try {
        for (const name of existsSync(options.stateDir) ? readdirSync(options.stateDir) : []) {
          if (name.startsWith('run-')) rmSync(join(options.stateDir, name), { recursive: true, force: true });
        }
      } catch { /* Leftovers are harmless. */ }
      const record: SelfUpdateRecord = { id: randomBytes(8).toString('hex'), from: options.runningVersion, to: target.version, step: 1, started_at: now(), engine_pid: pid };
      write(record);
      busy = true;
      void run(record).catch(() => fail(record, 'launch_failed')).finally(() => { busy = false; });
      return { ok: true, status: status() };
    },
  };
}

export type SelfUpdater = ReturnType<typeof createSelfUpdater>;
