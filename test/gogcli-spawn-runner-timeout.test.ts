import { describe, expect, test } from 'bun:test';
import { SpawnCommandRunner } from '../src/workers/email-source/gogcli.ts';

// A child that ignores SIGTERM stands in for the abnormal cases the budget
// exists to cover: a wedged gog, or a grandchild that inherited the stdout
// pipe and keeps it open after its parent is signalled.
const IGNORES_SIGTERM = "process.on('SIGTERM', () => {}); setTimeout(() => {}, 3000);";

describe('gog command runner timeout', () => {
  test('settles inside the budget when the child ignores SIGTERM', async () => {
    const runner = new SpawnCommandRunner();
    const started = Date.now();

    const result = await runner.run(process.execPath, ['-e', IGNORES_SIGTERM], { timeoutMs: 150 });
    const elapsedMs = Date.now() - started;

    expect(elapsedMs).toBeLessThan(2_000);
    expect(result.code).toBe(124);
    expect(result.stderr).toContain('timed out');
  });

  test('a command that finishes inside the budget reports its own result', async () => {
    const runner = new SpawnCommandRunner();

    const result = await runner.run(
      process.execPath,
      ['-e', 'process.stdout.write("ok"); process.exit(3);'],
      { timeoutMs: 10_000 },
    );

    expect(result).toMatchObject({ code: 3, stdout: 'ok' });
  });
});
