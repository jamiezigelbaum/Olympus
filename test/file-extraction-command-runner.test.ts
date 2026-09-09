// The local command seam, exercised against real processes.
//
// The unit tests around the extractors inject a fake runner, so nothing had
// ever run `runExtractionCommand` against a shell whose grandchild outlives
// the timeout. That is precisely the shape of every transcription command (a
// bash wrapper around a `whisper` python process), and it is what orphaned
// seven whisper processes on sparta on 2026-09-08. This file starts real
// subprocesses through the runner (node's child_process.spawn() underneath),
// so it belongs to the deploy lane.

import { describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import {
  ExtractionCommandError,
  ExtractionCommandTimeoutError,
  killExtractionProcessGroup,
  runExtractionCommand,
  type ExtractionKillFn,
} from '../src/workers/file-extraction/extractors/command-runner.ts';

function errno(code: string): NodeJS.ErrnoException {
  const error = new Error(code) as NodeJS.ErrnoException;
  error.code = code;
  return error;
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means it exists but is not ours; that never happens for a child
    // we started, so anything but ESRCH is reported as alive.
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

async function waitForPidFile(path: string, budgetMs: number): Promise<number> {
  const deadline = Date.now() + budgetMs;
  while (Date.now() < deadline) {
    if (existsSync(path)) {
      const text = (await readFile(path, 'utf8')).trim();
      if (text) return Number(text);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`pid file ${path} never appeared`);
}

async function waitUntilGone(pid: number, budgetMs: number): Promise<boolean> {
  const deadline = Date.now() + budgetMs;
  while (Date.now() < deadline) {
    if (!processIsAlive(pid)) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return !processIsAlive(pid);
}

describe('runExtractionCommand: normal completion', () => {
  test('collects both streams and resolves on exit 0', async () => {
    const result = await runExtractionCommand({
      command: 'bash',
      args: ['-c', 'printf out; printf err >&2'],
      timeoutMs: 10_000,
    });
    expect(result).toEqual({ stdout: 'out', stderr: 'err' });
  }, 30_000);

  test('a non-zero exit rejects with the structured error carrying both streams', async () => {
    let caught: unknown;
    try {
      await runExtractionCommand({
        command: 'bash',
        args: ['-c', 'printf partial; printf why >&2; exit 7'],
        timeoutMs: 10_000,
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ExtractionCommandError);
    const failure = caught as ExtractionCommandError;
    expect(failure.exitCode).toBe(7);
    expect(failure.stdout).toBe('partial');
    expect(failure.stderr).toBe('why');
  }, 30_000);

  test('a missing binary rejects with the spawn error', async () => {
    let caught: unknown;
    try {
      await runExtractionCommand({
        command: join(tmpdir(), 'olympus-no-such-binary-' + process.pid),
        args: [],
        timeoutMs: 10_000,
      });
    } catch (error) {
      caught = error;
    }
    expect((caught as NodeJS.ErrnoException).code).toBe('ENOENT');
  }, 30_000);
});

describe('runExtractionCommand: timeout kills the whole process group', () => {
  test('a grandchild that outlives the wrapper is killed with it', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'olympus-command-runner-'));
    const pidFile = join(dir, 'grandchild.pid');
    try {
      // The wrapper backgrounds a long sleep, records its pid, then waits on
      // it — the same shape as a bash wrapper around whisper. The `wait`
      // keeps the wrapper alive so the timeout is what ends it.
      const run = runExtractionCommand({
        command: 'bash',
        args: ['-c', `sleep 300 & echo $! > "${pidFile}"; wait`],
        timeoutMs: 400,
      });
      const grandchild = await waitForPidFile(pidFile, 5_000);
      expect(processIsAlive(grandchild)).toBe(true);

      let caught: unknown;
      try {
        await run;
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(ExtractionCommandTimeoutError);
      expect((caught as ExtractionCommandTimeoutError).timeoutMs).toBe(400);

      // The old runner SIGKILLed only bash; `sleep` lived on for its full
      // five minutes. The group kill has to reach it.
      expect(await waitUntilGone(grandchild, 5_000)).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 15_000);

  test('the timeout rejection never carries partial output', async () => {
    let caught: unknown;
    try {
      await runExtractionCommand({
        command: 'bash',
        args: ['-c', 'printf partial; sleep 300'],
        timeoutMs: 300,
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ExtractionCommandTimeoutError);
    expect('stdout' in (caught as object)).toBe(false);
  }, 15_000);
});

describe('killExtractionProcessGroup: ESRCH is benign, anything else is a termination failure', () => {
  test('ESRCH on the group falls through to the direct kill and reports ok', () => {
    const child = spawn('sleep', ['60'], { detached: true, stdio: 'ignore' });
    const calls: number[] = [];
    const kill: ExtractionKillFn = (pid) => {
      calls.push(pid);
      if (pid < 0) throw errno('ESRCH');
    };
    try {
      expect(killExtractionProcessGroup(child, 'SIGKILL', kill)).toEqual({ ok: true });
      expect(calls).toEqual([-child.pid!, child.pid!]);
    } finally {
      child.kill('SIGKILL');
    }
  }, 15_000);

  test('EPERM on the group still attempts the direct kill, and EPERM there too is surfaced', () => {
    const child = spawn('sleep', ['60'], { detached: true, stdio: 'ignore' });
    const calls: number[] = [];
    const kill: ExtractionKillFn = (pid) => {
      calls.push(pid);
      throw errno('EPERM');
    };
    try {
      expect(killExtractionProcessGroup(child, 'SIGKILL', kill)).toEqual({ ok: false, code: 'EPERM' });
      expect(calls).toEqual([-child.pid!, child.pid!]);
    } finally {
      child.kill('SIGKILL');
    }
  }, 15_000);

  test('a group EPERM followed by a direct ESRCH is still reported: the grandchildren may live on', () => {
    const child = spawn('sleep', ['60'], { detached: true, stdio: 'ignore' });
    const kill: ExtractionKillFn = (pid) => {
      throw errno(pid < 0 ? 'EPERM' : 'ESRCH');
    };
    try {
      expect(killExtractionProcessGroup(child, 'SIGKILL', kill)).toEqual({ ok: false, code: 'EPERM' });
    } finally {
      child.kill('SIGKILL');
    }
  }, 15_000);

  test('a timeout whose kill fails rejects with the failure named on the error', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'olympus-command-runner-'));
    const pidFile = join(dir, 'child.pid');
    let caught: unknown;
    try {
      const run = runExtractionCommand(
        { command: 'bash', args: ['-c', `echo $$ > "${pidFile}"; sleep 300`], timeoutMs: 300 },
        { kill: () => { throw errno('EPERM'); } },
      );
      const wrapper = await waitForPidFile(pidFile, 5_000);
      try {
        await run;
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(ExtractionCommandTimeoutError);
      const failure = caught as ExtractionCommandTimeoutError;
      expect(failure.terminationFailed).toBe('EPERM');
      expect(failure.message).toContain('could not be terminated (EPERM)');
      // The stubbed kill never signalled anything, so the wrapper is still
      // alive: exactly the situation the error exists to report.
      expect(processIsAlive(wrapper)).toBe(true);
      process.kill(-wrapper, 'SIGKILL');
      expect(await waitUntilGone(wrapper, 5_000)).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 15_000);

  test('a plain timeout carries no termination failure', async () => {
    let caught: unknown;
    try {
      await runExtractionCommand({ command: 'sleep', args: ['300'], timeoutMs: 200 });
    } catch (error) {
      caught = error;
    }
    expect((caught as ExtractionCommandTimeoutError).terminationFailed).toBeUndefined();
  }, 15_000);
});
