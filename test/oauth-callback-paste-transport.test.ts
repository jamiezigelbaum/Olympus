import { expect, test } from 'bun:test';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bindWorkerSocket, prepareWorkerSocket } from '../src/core/worker-transport.ts';

// Headless recovery must reach the local engine without a browser tunnel
// (docs/ops/OAUTH_RELAY.md, "Linux"). Exercise the default, uninjected client.
for (const platform of ['linux', 'darwin'] as const) {
  test.skipIf(platform === 'linux' && process.platform !== 'linux')(
    `connect finish defaults to ${platform === 'linux' ? 'the real Linux owner socket' : 'Mac loopback TCP'}`,
    async () => {
      const runtime = mkdtempSync(join(realpathSync(tmpdir()), 'paste-'));
      const seen: Array<{ method: string; url: string }> = [];
      const handler = (request: Request) => {
        seen.push({ method: request.method, url: request.url });
        return new Response(null, { status: 303, headers: { Location: '/oauth/callback/gmail/done' } });
      };
      const tcp = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: handler });
      const workerRoot = `http://127.0.0.1:${tcp.port}`;
      let socket: ReturnType<typeof Bun.serve> | undefined;
      try {
        if (platform === 'linux') {
          await tcp.stop(true);
          const path = prepareWorkerSocket({ env: { XDG_RUNTIME_DIR: runtime } })!;
          socket = bindWorkerSocket(path, () => Bun.serve({ unix: path, fetch: handler }));
        }
        // Isolate the runtime directory and Mac platform selection from other
        // tests. On Linux, Mac coverage exercises the TCP branch, not macOS itself.
        const child = Bun.spawn([process.execPath, '-e', `
          ${platform === 'darwin' ? "Object.defineProperty(process, 'platform', { value: 'darwin' });" : ''}
          const { finishPastedOAuthCallback } = await import('./src/core/oauth-callback-paste.ts');
          const result = await finishPastedOAuthCallback(
            'http://localhost:9/oauth/callback/gmail?code=fixture-code&state=fixture-state&extra=discard',
            { workerRoot: ${JSON.stringify(workerRoot)}, timeoutMs: 2000 },
          );
          console.log(JSON.stringify(result));
        `], {
          cwd: join(import.meta.dir, '..'),
          env: { ...process.env, XDG_RUNTIME_DIR: runtime },
          stdout: 'pipe', stderr: 'pipe',
        });
        const [status, stdout, stderr] = await Promise.all([
          child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
        ]);
        expect(status, stderr).toBe(0);
        expect(JSON.parse(stdout)).toMatchObject({ ok: true, source: 'gmail', connected: true });
        // Exactly one request also proves that the /done redirect was not followed.
        expect(seen).toHaveLength(1);
        expect(seen[0]!.method).toBe('GET');
        expect(seen[0]!.url).toBe(`${workerRoot}/oauth/callback/gmail?code=fixture-code&state=fixture-state`);
      } finally {
        await socket?.stop(true);
        await tcp.stop(true);
        rmSync(runtime, { recursive: true, force: true });
      }
    },
  );
}
