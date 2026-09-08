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

  const ffprobe = fakeBinary(bin, 'ffprobe', 'echo "${FAKE_DURATION_SECONDS:-60}.250000"');
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
  ].join('\n'));

  return {
    dir, tmpRoot, lockDir, input, whisperMarker, curlMarker,
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

describe('transcription wrapper: remote lane', () => {
  flockTest('uses the remote transcript and never starts whisper', () => {
    const h = harness('remote-ok', {
      OLYMPUS_TRANSCRIBE_URL: 'http://127.0.0.1:28090/v1/audio/transcriptions',
      OLYMPUS_TRANSCRIBE_REMOTE_MODEL: 'whisper-large-v3',
    });
    const result = run(h, [h.input], { FAKE_HTTP_CODE: '200', FAKE_REMOTE_BODY: 'remote transcript\n' });
    expect(result.stderr).toBe('');
    expect(result.code).toBe(0);
    expect(result.stdout).toBe('remote transcript\n');
    const curlArgs = readFileSync(h.curlMarker, 'utf8');
    expect(curlArgs).toContain('--max-time 1800');
    expect(curlArgs).toContain('model=whisper-large-v3');
    expect(curlArgs).toContain('response_format=text');
    expect(curlArgs).toContain('http://127.0.0.1:28090/v1/audio/transcriptions');
    expect(existsSync(h.whisperMarker)).toBe(false);
    expect(workDirsUnder(h.tmpRoot)).toEqual([]);
  });

  flockTest('falls back to local whisper on a 5xx', () => {
    const h = harness('remote-5xx', { OLYMPUS_TRANSCRIBE_URL: 'http://127.0.0.1:28090/v1/audio/transcriptions' });
    const result = run(h, [h.input], { FAKE_HTTP_CODE: '503', FAKE_REMOTE_BODY: 'overloaded' });
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('local transcript');
    expect(result.stderr).toContain('remote lane http://127.0.0.1:28090/v1/audio/transcriptions failed (http 503');
    expect(existsSync(h.whisperMarker)).toBe(true);
  });

  flockTest('falls back to local whisper when the remote returns an empty body', () => {
    const h = harness('remote-empty', { OLYMPUS_TRANSCRIBE_URL: 'http://127.0.0.1:28090/v1/audio/transcriptions' });
    const result = run(h, [h.input], { FAKE_HTTP_CODE: '200', FAKE_REMOTE_BODY: '  \n' });
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('local transcript');
    expect(existsSync(h.whisperMarker)).toBe(true);
  });
});

describe('transcription wrapper: orphan sweep', () => {
  test('removes stale unreferenced temp dirs and keeps fresh or referenced ones', () => {
    const h = harness('sweep');
    const stale = join(h.tmpRoot, 'olympus-whisper.stale01');
    const staleSpill = join(h.tmpRoot, 'olympus-transcribe-stale02');
    const fresh = join(h.tmpRoot, 'olympus-whisper.fresh03');
    const referenced = join(h.tmpRoot, 'olympus-transcribe-referenced04');
    const unrelated = join(h.tmpRoot, 'something-else-old');
    for (const dir of [stale, staleSpill, fresh, referenced, unrelated]) {
      mkdirSync(dir);
      writeFileSync(join(dir, 'blob'), 'x');
    }
    const twoDaysAgo = new Date(Date.now() - 2 * 24 * 3600 * 1000);
    for (const dir of [stale, staleSpill, referenced, unrelated]) {
      utimesSync(dir, twoDaysAgo, twoDaysAgo);
    }
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
});
