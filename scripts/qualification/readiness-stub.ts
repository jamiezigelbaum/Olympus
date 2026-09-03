import { readFileSync, writeFileSync } from 'node:fs';

export interface SimulatedReadinessServer {
  port: number;
  url: string;
  stop(): Promise<void>;
}

/**
 * Serve the simulated worker readiness endpoint on an OS-assigned loopback port.
 *
 * A fixed port cannot isolate anything: 8010 is the managed worker's default, so
 * on a host that already runs Olympus the child's bind fails and the operator's
 * live worker answers the upgrade/rollback readiness probe instead of the stub.
 * Binding port 0 and reading back the port the child actually bound both removes
 * the collision and makes a bind failure surface here rather than be masked.
 */
export async function startSimulatedReadinessServer(): Promise<SimulatedReadinessServer> {
  const script = [
    "const server = Bun.serve({",
    "  hostname: '127.0.0.1',",
    "  port: 0,",
    "  fetch(request) {",
    "    const url = new URL(request.url);",
    "    if (url.pathname !== '/v1/health') return new Response('not found', { status: 404 });",
    "    return Response.json({ reachable: true, status: 'ok' });",
    "  },",
    "});",
    "console.log(server.port);",
    "await new Promise(() => {});",
  ].join('\n');
  const child = Bun.spawn([process.execPath, '-e', script], { stdout: 'pipe', stderr: 'pipe' });
  const reader = child.stdout.getReader();
  const decoder = new TextDecoder();
  let output = '';
  try {
    while (!output.includes('\n')) {
      const chunk = await reader.read();
      if (chunk.done) break;
      output += decoder.decode(chunk.value, { stream: true });
    }
  } finally {
    reader.releaseLock();
  }
  const port = Number(output.trim());
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    child.kill();
    const detail = await new Response(child.stderr).text();
    throw new Error(`Simulated readiness server did not bind a loopback port: ${detail.trim() || output.trim()}`);
  }
  return {
    port,
    url: `http://127.0.0.1:${port}/v1/health`,
    async stop() {
      child.kill();
      await child.exited;
    },
  };
}

/**
 * Point the managed worker environment's readiness port at the stub.
 *
 * `olympus worker upgrade` resolves its loopback probe from this file, and the
 * upgrade's environment reconcile preserves an existing port line, so pinning
 * the port once after install keeps every later probe inside the sandbox.
 */
export function pinWorkerReadinessPort(envPath: string, port: number): void {
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`Refusing to pin an invalid simulated readiness port: ${port}`);
  }
  const current = readFileSync(envPath, 'utf8');
  if (!/^OLYMPUS_EMAIL_SOURCE_PORT=.*$/m.test(current)) {
    throw new Error(`Managed worker environment has no readiness port to isolate: ${envPath}`);
  }
  writeFileSync(envPath, current.replace(/^OLYMPUS_EMAIL_SOURCE_PORT=.*$/m, `OLYMPUS_EMAIL_SOURCE_PORT=${port}`), { mode: 0o600 });
}

export async function waitForSimulatedReadiness(port: number): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/v1/health`);
      if (response.ok) return;
    } catch {}
    await Bun.sleep(20);
  }
  throw new Error('Simulated readiness server did not start.');
}
