/** Isolated real processes: OS probes and viewer opening are the only fakes. */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { startEngineHost } from '../../src/core/engine-host.ts';
import { prepareWorkerSocket, bindWorkerSocket, workerSocketPath } from '../../src/core/worker-transport.ts';
import { installWorkerShutdownSignals } from '../../src/core/worker-shutdown.ts';
import { connectLinuxOwnerBridgeHost, OWNER_BRIDGE_HOST_ENV } from '../../src/core/linux-owner-bridge-host.ts';

const root = process.env.HOME!;
const mode = process.argv[2];
const keepAlive = setInterval(() => {}, 1000);
if (mode === 'host') {
  await startEngineHost({ moduleUrl: import.meta.url, services: () => [], log: () => {}, desktop: {
    ready: async () => readFileSync(join(root, 'desktop'), 'utf8') === 'ready',
    openFile: async path => { writeFileSync(join(root, 'opened'), path); },
  } });
  console.log('host-started');
} else {
  const client = connectLinuxOwnerBridgeHost(process.env[OWNER_BRIDGE_HOST_ENV]!);
  const signals = installWorkerShutdownSignals({ closeOwnerBridge: () => client.close(), exit: code => process.exit(code) });
  if (mode === 'startup') {
    console.log('worker-startup');
  } else {
    const socketPath = prepareWorkerSocket()!;
    const server = bindWorkerSocket(socketPath, () => Bun.serve({ unix: socketPath, fetch(request) {
      const path = new URL(request.url).pathname;
      if (path === '/health') return Response.json({ status: 'ok' });
      if (path === '/reload') { reload(); return new Response('saving'); }
      return new Response('PRIVATE OWNER DATA');
    } }));
    signals.setShutdown(() => { clearInterval(keepAlive); void server.stop(true); });
    const reload = signals.modelReload({ managed: true, drain: async () => {
      writeFileSync(join(root, 'reloading'), 'yes');
      await Bun.sleep(1_000);
    }, exit: code => process.exit(code) });
    console.log('worker-ready');
  }
}
