import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'bun:test';
import { linuxWorkerRestartLoop, type WorkerServiceExec } from '../src/core/worker-service.ts';

const show = (stdout: string): WorkerServiceExec => () => ({ status: 0, stdout, stderr: '' });
const errLog = () => {
  const path = join(mkdtempSync(join(tmpdir(), 'olympus-loop-')), 'worker.err');
  writeFileSync(path, 'starting\nConnector store schema has broken foreign-key references after migration.\n');
  return path;
};

test('a worker waiting to restart after repeated exits is a crash loop, with the last exit and error', () => {
  expect(linuxWorkerRestartLoop(show('NRestarts=156\nSubState=auto-restart\nMainPID=0\nExecMainStatus=1\n'), errLog())).toEqual({
    restarts: 156,
    last_exit_code: 1,
    last_error: 'Connector store schema has broken foreign-key references after migration.',
  });
});

test('a worker that just restarted again is still in the loop; one that has stayed up is not', () => {
  // This test process started moments ago: a fresh run.
  expect(linuxWorkerRestartLoop(show(`NRestarts=5\nSubState=running\nMainPID=${process.pid}\nExecMainStatus=0\n`), errLog())?.restarts).toBe(5);
  // pid 1 has been up since boot.
  expect(linuxWorkerRestartLoop(show('NRestarts=5\nSubState=running\nMainPID=1\nExecMainStatus=0\n'), errLog())).toBeUndefined();
});

test('a couple of restarts, or no systemd record, is not a loop', () => {
  expect(linuxWorkerRestartLoop(show('NRestarts=2\nSubState=auto-restart\nMainPID=0\nExecMainStatus=1\n'), errLog())).toBeUndefined();
  expect(linuxWorkerRestartLoop(() => ({ status: 1, stdout: '', stderr: 'no bus' }), errLog())).toBeUndefined();
});
