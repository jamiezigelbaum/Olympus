// The host transcription wrapper template, executed for real.
//
// config/systemd/user/olympus-whisper-transcribe.sh is what every transcription
// caller on the host runs (OLYMPUS_TRANSCRIBE_COMMAND, the WhatsApp drain,
// manual runs). It is derived here, never transcribed: each case runs the real
// script (Bun.spawn of bash) against fake ffprobe/ffmpeg/whisper/curl binaries
// that record what they were asked to do. `flock` has to be real, because the
// semaphore is the point; on a host without it the semaphore cases skip.

import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, test } from 'bun:test';

const WRAPPER = join(import.meta.dir, '..', 'config', 'systemd', 'user', 'olympus-whisper-transcribe.sh');
const FLOCK = Bun.which('flock');
const flockTest = FLOCK ? test : test.skip;
const LOOPBACK_URL = 'http://127.0.0.1:28090/v1/audio/transcriptions';

const root = mkdtempSync(join(tmpdir(), 'olympus-transcribe-wrapper-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

function fakeBinary(dir: string, name: string, body: string): string {
  const path = join(dir, name);
  writeFileSync(path, `#!/usr/bin/env bash\nset -euo pipefail\n${body}\n`);
  chmodSync(path, 0o755);
  return path;
}

interface Harness {
  dir: string;
  tmpRoot: string;
  lockDir: string;
  input: string;
  whisperMarker: string;
  curlMarker: string;
  ffprobeMarker: string;
  env: Record<string, string>;
}

function harness(name: string, overrides: Record<string, string> = {}): Harness {
  const dir = join(root, name);
  const bin = join(dir, 'bin');
  const tmpRoot = join(dir, 'tmp');
  const lockDir = join(dir, 'locks');
  mkdirSync(bin, { recursive: true });
  mkdirSync(tmpRoot, { recursive: true });
  const input = join(dir, 'voice note.m4a');
  writeFileSync(input, 'not really audio');
  const whisperMarker = join(dir, 'whisper.ran');
  const curlMarker = join(dir, 'curl.ran');
  const ffprobeMarker = join(dir, 'ffprobe.ran');

  const ffprobe = fakeBinary(bin, 'ffprobe', [
    `touch "${ffprobeMarker}"`,
    'if [[ "${FAKE_FFPROBE_FAILS:-}" == "1" ]]; then echo "ffprobe: bad input" >&2; exit 1; fi',
    'echo "${FAKE_DURATION_SECONDS:-60}.250000"',
  ].join('\n'));
  const ffmpeg = fakeBinary(bin, 'ffmpeg', [
    'out="${@: -1}"',
    'src=""; prev=""',
    'for a in "$@"; do if [[ "$prev" == "-i" ]]; then src="$a"; fi; prev="$a"; done',
    'cp -- "$src" "$out"',
  ].join('\n'));
  const whisper = fakeBinary(bin, 'whisper', [
    `printf '%s\\n' "$*" > "${whisperMarker}"`,
    'out=""; prev=""',
    'for a in "$@"; do if [[ "$prev" == "--output_dir" ]]; then out="$a"; fi; prev="$a"; done',
    'stem="$(basename -- "$1")"; stem="${stem%.*}"',
    'printf "local transcript from ${OMP_NUM_THREADS:-unset} threads\\n" > "${out}/${stem}.txt"',
  ].join('\n'));
  const curl = fakeBinary(bin, 'curl', [
    `printf '%s\\n' "$*" > "${curlMarker}"`,
    'out=""; prev=""',
    'for a in "$@"; do if [[ "$prev" == "--output" ]]; then out="$a"; fi; prev="$a"; done',
    'printf "%s" "${FAKE_REMOTE_BODY:-}" > "$out"',
    'printf "%s" "${FAKE_HTTP_CODE:-200}"',
    'if [[ -n "${FAKE_CURL_EXIT:-}" ]]; then echo "curl: (${FAKE_CURL_EXIT}) simulated transport failure" >&2; exit "${FAKE_CURL_EXIT}"; fi',
  ].join('\n'));

  return {
    dir, tmpRoot, lockDir, input, whisperMarker, curlMarker, ffprobeMarker,
    env: {
      PATH: process.env.PATH ?? '',
      HOME: dir,
      OLYMPUS_TRANSCRIBE_TMP_ROOT: tmpRoot,
      OLYMPUS_TRANSCRIBE_LOCK_DIR: lockDir,
      OLYMPUS_TRANSCRIBE_FFPROBE_BIN: ffprobe,
      OLYMPUS_TRANSCRIBE_FFMPEG_BIN: ffmpeg,
      OLYMPUS_WHISPER_BIN: whisper,
      OLYMPUS_TRANSCRIBE_CURL_BIN: curl,
      OLYMPUS_TRANSCRIBE_SWEEP_ON_START: 'false',
      ...(FLOCK ? { OLYMPUS_TRANSCRIBE_FLOCK_BIN: FLOCK } : {}),
      ...overrides,
    },
  };
}

function run(h: Harness, args: string[] = [h.input], extraEnv: Record<string, string> = {}) {
  const proc = Bun.spawnSync(['bash', WRAPPER, ...args], {
    env: { ...h.env, ...extraEnv },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  return {
    code: proc.exitCode,
    stdout: proc.stdout.toString(),
    stderr: proc.stderr.toString(),
  };
}

/**
 * Starts a process that owns one slot lock and resolves once it actually
 * holds it (it prints `held` after flock returns), so the wrapper under test
 * races a lock that is already taken rather than one about to be.
 */
async function holdSlot(h: Harness, slot: number) {
  mkdirSync(h.lockDir, { recursive: true });
  const lockFile = join(h.lockDir, `slot-${slot}.lock`);
  const holder = Bun.spawn(['bash', '-c', `exec 9>"${lockFile}"; "${FLOCK}" 9; echo held; sleep 60`], {
    stdout: 'pipe',
  });
  await holder.stdout.getReader().read();
  return holder;
}

function workDirsUnder(tmpRoot: string): string[] {
  return Array.from(new Bun.Glob('olympus-whisper.*').scanSync({ cwd: tmpRoot, onlyFiles: false }));
}

function pidIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

async function waitFor(predicate: () => boolean, budgetMs: number): Promise<boolean> {
  const deadline = Date.now() + budgetMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return predicate();
}

describe('transcription wrapper: local lane', () => {
  flockTest('downmixes, caps threads, runs whisper under the semaphore, cleans up', () => {
    const h = harness('local', { OLYMPUS_TRANSCRIBE_THREADS: '3', OLYMPUS_WHISPER_MODEL: 'small' });
    const result = run(h);
    expect(result.stderr).toBe('');
    expect(result.code).toBe(0);
    expect(result.stdout).toBe('local transcript from 3 threads\n');
    const whisperArgs = readFileSync(h.whisperMarker, 'utf8');
    expect(whisperArgs).toContain('/input.wav --model small --output_format txt');
    expect(whisperArgs).toContain('--fp16 False');
    expect(existsSync(h.curlMarker)).toBe(false);
    expect(workDirsUnder(h.tmpRoot)).toEqual([]);
    expect(existsSync(join(h.lockDir, 'slot-0.lock'))).toBe(true);
  });

  test('refuses an input over the duration cap before touching a slot', () => {
    const h = harness('too-long', { OLYMPUS_TRANSCRIBE_MAX_MINUTES: '180' });
    const result = run(h, [h.input], { FAKE_DURATION_SECONDS: String(181 * 60) });
    expect(result.code).toBe(65);
    expect(result.stderr).toContain('duration 181 min exceeds OLYMPUS_TRANSCRIBE_MAX_MINUTES=180');
    expect(existsSync(h.whisperMarker)).toBe(false);
    expect(existsSync(h.lockDir)).toBe(false);
  }, 30_000);

  test('with no remote lane, the LOCAL cap is applied before the slot is taken', () => {
    const h = harness('too-long-local', { OLYMPUS_TRANSCRIBE_LOCAL_MAX_MINUTES: '25' });
    const result = run(h, [h.input], { FAKE_DURATION_SECONDS: String(26 * 60) });
    expect(result.code).toBe(65);
    expect(result.stderr).toContain('duration 26 min exceeds OLYMPUS_TRANSCRIBE_LOCAL_MAX_MINUTES=25 (no remote lane configured)');
    expect(existsSync(h.whisperMarker)).toBe(false);
    expect(existsSync(h.lockDir)).toBe(false);
    expect(workDirsUnder(h.tmpRoot)).toEqual([]);
  }, 30_000);

  test('rejects a malformed knob with a usage exit', () => {
    const h = harness('bad-knob', { OLYMPUS_TRANSCRIBE_SLOTS: 'many' });
    const result = run(h);
    expect(result.code).toBe(64);
    expect(result.stderr).toContain('OLYMPUS_TRANSCRIBE_SLOTS');
  }, 30_000);

  test('a missing input is a clear failure', () => {
    const h = harness('missing');
    const result = run(h, [join(h.dir, 'nope.mp3')]);
    expect(result.code).toBe(66);
    expect(result.stderr).toContain('not a readable file');
  }, 30_000);
});

describe('transcription wrapper: required tools fail closed', () => {
  test('a missing ffprobe refuses the job before any slot or work dir', () => {
    const h = harness('no-ffprobe', { OLYMPUS_TRANSCRIBE_FFPROBE_BIN: join(root, 'no-such-ffprobe') });
    const result = run(h);
    expect(result.code).toBe(69);
    expect(result.stderr).toContain('ffprobe is required but was not found');
    expect(existsSync(h.whisperMarker)).toBe(false);
    expect(existsSync(h.lockDir)).toBe(false);
    expect(workDirsUnder(h.tmpRoot)).toEqual([]);
  }, 30_000);

  test('a missing ffmpeg refuses the job rather than passing the original media through', () => {
    const h = harness('no-ffmpeg', { OLYMPUS_TRANSCRIBE_FFMPEG_BIN: join(root, 'no-such-ffmpeg') });
    const result = run(h);
    expect(result.code).toBe(69);
    expect(result.stderr).toContain('ffmpeg is required but was not found');
    expect(existsSync(h.whisperMarker)).toBe(false);
    expect(existsSync(h.lockDir)).toBe(false);
  }, 30_000);

  test('an ffprobe failure is an unreadable input, never "proceed without the cap"', () => {
    const h = harness('ffprobe-fails');
    const result = run(h, [h.input], { FAKE_FFPROBE_FAILS: '1' });
    expect(result.code).toBe(66);
    expect(result.stderr).toContain('ffprobe could not read the duration');
    expect(existsSync(h.whisperMarker)).toBe(false);
    expect(existsSync(h.lockDir)).toBe(false);
  }, 30_000);
});

describe('transcription wrapper: deadline arithmetic', () => {
  test('explicit budgets that cannot fit the deadline are a usage error', () => {
    const h = harness('bad-budget', {
      OLYMPUS_TRANSCRIBE_DEADLINE_SECONDS: '1800',
      OLYMPUS_TRANSCRIBE_LOCK_WAIT_SECONDS: '1000',
      OLYMPUS_TRANSCRIBE_REMOTE_TIMEOUT_SECONDS: '900',
    });
    const result = run(h);
    expect(result.code).toBe(64);
    expect(result.stderr).toContain('must be below OLYMPUS_TRANSCRIBE_DEADLINE_SECONDS (1800)');
    expect(existsSync(h.ffprobeMarker)).toBe(false);
  }, 30_000);

  test('a local-only job whose audio is longer than the deadline is refused before the slot', () => {
    const h = harness('deadline-local', { OLYMPUS_TRANSCRIBE_DEADLINE_SECONDS: '30' });
    const result = run(h, [h.input], { FAKE_DURATION_SECONDS: '60' });
    expect(result.code).toBe(69);
    expect(result.stderr).toContain('is less than the 60s of audio the local CPU lane needs');
    expect(existsSync(h.whisperMarker)).toBe(false);
    expect(existsSync(h.lockDir)).toBe(false);
  }, 30_000);
});

describe('transcription wrapper: semaphore', () => {
  flockTest('gives up with a clear message when every slot stays busy past the wait', async () => {
    const h = harness('busy', { OLYMPUS_TRANSCRIBE_SLOTS: '1', OLYMPUS_TRANSCRIBE_LOCK_WAIT_SECONDS: '0' });
    const holder = await holdSlot(h, 0);
    try {
      const started = Date.now();
      const result = run(h);
      expect(result.code).toBe(69);
      expect(result.stderr).toContain('all 1 transcription slot(s) busy');
      expect(result.stderr).toContain('gave up waiting 0s for a transcription slot');
      expect(existsSync(h.whisperMarker)).toBe(false);
      expect(Date.now() - started).toBeLessThan(15_000);
    } finally {
      holder.kill('SIGKILL');
    }
  }, 30_000);

  flockTest('a second slot lets a second caller through while the first is held', async () => {
    const h = harness('two-slots', { OLYMPUS_TRANSCRIBE_SLOTS: '2', OLYMPUS_TRANSCRIBE_LOCK_WAIT_SECONDS: '0' });
    const holder = await holdSlot(h, 0);
    try {
      const result = run(h);
      expect(result.code).toBe(0);
      expect(result.stdout).toContain('local transcript');
      expect(readFileSync(h.whisperMarker, 'utf8')).toContain('--model base');
    } finally {
      holder.kill('SIGKILL');
    }
  }, 30_000);
});

describe('transcription wrapper: egress boundary', () => {
  for (const url of [
    'https://api.openai.com/v1/audio/transcriptions',
    'http://delphi.tail1234.ts.net:28090/v1/audio/transcriptions',
    'http://127.0.0.1.evil.example/v1/audio/transcriptions',
    'http://user@127.0.0.1:28090/v1/audio/transcriptions',
    'http://[::1]:28090/v1/audio/transcriptions',
    'ftp://127.0.0.1/v1/audio/transcriptions',
  ]) {
    test(`refuses a non-loopback OLYMPUS_TRANSCRIBE_URL before any work: ${url}`, () => {
      const h = harness(`egress-${Bun.hash(url).toString(16)}`, { OLYMPUS_TRANSCRIBE_URL: url });
      const result = run(h);
      expect(result.code).toBe(78);
      expect(result.stderr).toContain('the remote lane must be loopback');
      expect(result.stderr).toContain(url);
      expect(existsSync(h.ffprobeMarker)).toBe(false);
      expect(existsSync(h.curlMarker)).toBe(false);
      expect(existsSync(h.whisperMarker)).toBe(false);
      expect(existsSync(h.lockDir)).toBe(false);
    }, 30_000);
  }

  flockTest('accepts localhost as well as 127.0.0.1', () => {
    const h = harness('egress-localhost', { OLYMPUS_TRANSCRIBE_URL: 'http://localhost:28090/v1/audio/transcriptions' });
    const result = run(h, [h.input], { FAKE_REMOTE_BODY: 'remote transcript\n' });
    expect(result.code).toBe(0);
    expect(result.stdout).toBe('remote transcript\n');
  });
});

describe('transcription wrapper: remote lane', () => {
  flockTest('uses the remote transcript and never starts whisper', () => {
    const h = harness('remote-ok', {
      OLYMPUS_TRANSCRIBE_URL: LOOPBACK_URL,
      OLYMPUS_TRANSCRIBE_REMOTE_MODEL: 'delphi/transcription',
    });
    const result = run(h, [h.input], { FAKE_HTTP_CODE: '200', FAKE_REMOTE_BODY: 'remote transcript\n' });
    expect(result.stderr).toBe('');
    expect(result.code).toBe(0);
    expect(result.stdout).toBe('remote transcript\n');
    const curlArgs = readFileSync(h.curlMarker, 'utf8');
    // Half the 1800 s default deadline: lock wait (600) + remote (900) < 1800.
    expect(curlArgs).toContain('--max-time 900');
    expect(curlArgs).toContain('model=delphi/transcription');
    expect(curlArgs).toContain('response_format=text');
    expect(curlArgs).toContain(LOOPBACK_URL);
    expect(existsSync(h.whisperMarker)).toBe(false);
    expect(workDirsUnder(h.tmpRoot)).toEqual([]);
  });

  flockTest('the remote budget is derived from an explicit deadline', () => {
    const h = harness('remote-deadline', {
      OLYMPUS_TRANSCRIBE_URL: LOOPBACK_URL,
      OLYMPUS_TRANSCRIBE_DEADLINE_SECONDS: '600',
    });
    const result = run(h, [h.input], { FAKE_REMOTE_BODY: 'remote transcript\n' });
    expect(result.code).toBe(0);
    expect(readFileSync(h.curlMarker, 'utf8')).toContain('--max-time 300');
  });

  flockTest('falls back to local whisper on a 5xx', () => {
    const h = harness('remote-5xx', { OLYMPUS_TRANSCRIBE_URL: LOOPBACK_URL });
    const result = run(h, [h.input], { FAKE_HTTP_CODE: '503', FAKE_REMOTE_BODY: 'overloaded' });
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('local transcript');
    expect(result.stderr).toContain(`remote lane ${LOOPBACK_URL} failed (curl exit 0, http 503`);
    expect(existsSync(h.whisperMarker)).toBe(true);
  });

  flockTest('falls back to local whisper when the remote returns an empty body', () => {
    const h = harness('remote-empty', { OLYMPUS_TRANSCRIBE_URL: LOOPBACK_URL });
    const result = run(h, [h.input], { FAKE_HTTP_CODE: '200', FAKE_REMOTE_BODY: '  \n' });
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('local transcript');
    expect(existsSync(h.whisperMarker)).toBe(true);
  });

  flockTest('a partial body from a curl that exits non-zero is never accepted', () => {
    const h = harness('remote-partial', { OLYMPUS_TRANSCRIBE_URL: LOOPBACK_URL });
    // curl wrote a 200 and half a transcript, then died mid-transfer (28 = timeout).
    const result = run(h, [h.input], { FAKE_HTTP_CODE: '200', FAKE_REMOTE_BODY: 'half a transcr', FAKE_CURL_EXIT: '28' });
    expect(result.code).toBe(0);
    expect(result.stdout).toBe('local transcript from 4 threads\n');
    expect(result.stdout).not.toContain('half a transcr');
    expect(result.stderr).toContain('curl exit 28');
    expect(existsSync(h.whisperMarker)).toBe(true);
  });

  flockTest('a permanent 4xx is a configuration failure: distinct exit, no local fallback', () => {
    const h = harness('remote-404', { OLYMPUS_TRANSCRIBE_URL: LOOPBACK_URL });
    const result = run(h, [h.input], { FAKE_HTTP_CODE: '404', FAKE_REMOTE_BODY: 'no such model' });
    expect(result.code).toBe(76);
    expect(result.stderr).toContain(`remote lane ${LOOPBACK_URL} rejected model=delphi/transcription with http 404`);
    expect(result.stderr).toContain('OLYMPUS_TRANSCRIBE_REMOTE_MODEL');
    expect(result.stdout).toBe('');
    expect(existsSync(h.whisperMarker)).toBe(false);
    expect(workDirsUnder(h.tmpRoot)).toEqual([]);
  });

  flockTest('a file over the local cap still gets the remote attempt, but no local fallback', () => {
    const h = harness('remote-over-local-cap', {
      OLYMPUS_TRANSCRIBE_URL: LOOPBACK_URL,
      OLYMPUS_TRANSCRIBE_LOCAL_MAX_MINUTES: '25',
    });
    const ok = run(h, [h.input], { FAKE_DURATION_SECONDS: String(100 * 60), FAKE_REMOTE_BODY: 'remote transcript\n' });
    expect(ok.code).toBe(0);
    expect(ok.stdout).toBe('remote transcript\n');
    expect(existsSync(h.whisperMarker)).toBe(false);

    rmSync(h.curlMarker);
    const failed = run(h, [h.input], { FAKE_DURATION_SECONDS: String(100 * 60), FAKE_HTTP_CODE: '503' });
    expect(failed.code).toBe(65);
    expect(existsSync(h.curlMarker)).toBe(true);
    expect(failed.stderr).toContain('duration 100 min exceeds OLYMPUS_TRANSCRIBE_LOCAL_MAX_MINUTES=25 (remote lane failed)');
    expect(existsSync(h.whisperMarker)).toBe(false);
    expect(workDirsUnder(h.tmpRoot)).toEqual([]);
  });
});

describe('transcription wrapper: signals', () => {
  for (const [signal, code] of [['SIGTERM', 143], ['SIGINT', 130]] as const) {
    flockTest(`${signal} stops whisper and its descendants, removes the work dir, exits ${code}`, async () => {
      const h = harness(`signal-${signal.toLowerCase()}`);
      const sleeperPid = join(h.dir, 'sleeper.pid');
      // A whisper that forks a grandchild and waits, like python spawning a
      // worker; the pid file is the signal that everything is running.
      fakeBinary(join(h.dir, 'bin'), 'whisper', [
        'sleep 60 &',
        `echo $! > "${sleeperPid}"`,
        'wait',
      ].join('\n'));
      const proc = Bun.spawn(['bash', WRAPPER, h.input], { env: h.env, stdout: 'pipe', stderr: 'pipe' });
      const stderrText = new Response(proc.stderr).text();
      expect(await waitFor(() => existsSync(sleeperPid) && readFileSync(sleeperPid, 'utf8').trim() !== '', 10_000)).toBe(true);
      const sleeper = Number(readFileSync(sleeperPid, 'utf8').trim());
      expect(pidIsAlive(sleeper)).toBe(true);
      expect(workDirsUnder(h.tmpRoot)).toHaveLength(1);

      const started = Date.now();
      proc.kill(signal);
      const exitCode = await proc.exited;
      const stderr = await stderrText;
      expect(exitCode).toBe(code);
      expect(stderr).toContain(`received ${signal}; stopping`);
      // Forwarded as TERM, so the grace period (10 s) is never reached.
      expect(Date.now() - started).toBeLessThan(5_000);
      expect(await waitFor(() => !pidIsAlive(sleeper), 5_000)).toBe(true);
      expect(workDirsUnder(h.tmpRoot)).toEqual([]);
    }, 30_000);
  }
});

describe('transcription wrapper: orphan sweep', () => {
  function staleDirs(h: Harness, names: string[]): string[] {
    const twoDaysAgo = new Date(Date.now() - 2 * 24 * 3600 * 1000);
    return names.map((name) => {
      const dir = join(h.tmpRoot, name);
      mkdirSync(dir);
      writeFileSync(join(dir, 'blob'), 'x');
      utimesSync(dir, twoDaysAgo, twoDaysAgo);
      return dir;
    });
  }

  test('removes stale unreferenced temp dirs and keeps fresh or referenced ones', () => {
    const h = harness('sweep');
    const [stale, staleSpill, referenced, unrelated] = staleDirs(h, [
      'olympus-whisper.stale01', 'olympus-transcribe-stale02', 'olympus-transcribe-referenced04', 'something-else-old',
    ]) as [string, string, string, string];
    const fresh = join(h.tmpRoot, 'olympus-whisper.fresh03');
    mkdirSync(fresh);
    writeFileSync(join(fresh, 'blob'), 'x');
    // A live process whose command line names the directory keeps it. The
    // loop matters: bash exec-optimizes a single `sleep` out of `-c`, which
    // would drop the argument from the surviving process's command line.
    const user = Bun.spawn(['bash', '-c', 'while :; do sleep 1; done', 'bash', referenced]);
    try {
      const result = run(h, ['--sweep']);
      expect(result.code).toBe(0);
      expect(result.stderr).toContain(`sweep: removed stale ${stale}`);
      expect(result.stderr).toContain(`sweep: removed stale ${staleSpill}`);
      expect(result.stderr).toContain('sweep: removed 2, kept 1');
      expect(existsSync(stale)).toBe(false);
      expect(existsSync(staleSpill)).toBe(false);
      expect(existsSync(fresh)).toBe(true);
      expect(existsSync(referenced)).toBe(true);
      expect(existsSync(unrelated)).toBe(true);
    } finally {
      user.kill('SIGKILL');
    }
  }, 30_000);

  test('a process whose cwd is inside a stale dir keeps it, even with nothing on its command line', () => {
    const h = harness('sweep-cwd');
    const [stale, cwdHeld] = staleDirs(h, ['olympus-whisper.stale11', 'olympus-whisper.cwdheld12']) as [string, string];
    const user = Bun.spawn(['bash', '-c', 'while :; do sleep 1; done'], { cwd: cwdHeld });
    try {
      const result = run(h, ['--sweep']);
      expect(result.code).toBe(0);
      expect(result.stderr).toContain('sweep: removed 1, kept 1');
      expect(existsSync(stale)).toBe(false);
      expect(existsSync(cwdHeld)).toBe(true);
    } finally {
      user.kill('SIGKILL');
    }
  }, 60_000);

  test('without pgrep the sweep removes nothing', () => {
    const h = harness('sweep-no-pgrep', { OLYMPUS_TRANSCRIBE_PGREP_BIN: join(root, 'no-such-pgrep') });
    const [stale] = staleDirs(h, ['olympus-whisper.stale21']) as [string];
    const result = run(h, ['--sweep']);
    expect(result.code).toBe(0);
    expect(result.stderr).toContain('pgrep not found; refusing to remove anything');
    expect(existsSync(stale)).toBe(true);
  }, 30_000);
});
