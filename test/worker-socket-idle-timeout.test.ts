// OLYMPUS_TEST_LANE: deploy
import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { workerSocketServe } from '../src/core/worker-transport.ts';

// Sparta, 2026-11-04: a dashboard status read that took 12-15 s came back empty, and the worker logged
// "[Bun.serve]: request timed out after 10 seconds". On a unix socket, server.timeout(request, 0) does
// not lift Bun's default; the server's own idleTimeout must.
test('a worker-socket request may take longer than Bun\'s default 10 s idle timeout', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'olympus-idle-'));
  const unix = join(dir, 'w.sock');
  const server = Bun.serve(workerSocketServe({ unix, async fetch(request, served) {
    served.timeout(request, 0);
    await Bun.sleep(14_000);
    return new Response('answered');
  } }));
  try {
    const response = await fetch('http://localhost/status', { unix } as RequestInit);
    expect(await response.text()).toBe('answered');
  } finally {
    server.stop(true);
    rmSync(dir, { recursive: true, force: true });
  }
}, 25_000);
