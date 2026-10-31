/** Host-owned browser listener. Workers only ask this private control socket
 * for status or a ticket; killing/reloading a worker cannot release TCP. */
import { randomBytes } from 'node:crypto';
import { lstatSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { linuxGraphicalSessionReadinessAsync } from './linux-desktop-opener.ts';
import { manageLinuxOwnerBridge, type DesktopBridgeStatus, type LinuxOwnerBridgeOptions } from './linux-owner-bridge.ts';
import { bindWorkerSocket, validateWorkerSocketDirectory, type WorkerTransportOptions } from './worker-transport.ts';

export const OWNER_BRIDGE_HOST_ENV = 'OLYMPUS_OWNER_BRIDGE_HOST_SOCKET';

export function startLinuxOwnerBridgeHost(options: Omit<LinuxOwnerBridgeOptions, 'ready' | 'workerReady'> & {
  desktopReady?: () => Promise<boolean>;
  workerReady: () => Promise<boolean>;
  /** Synchronous supervisor proof; loss must bypass the debounced endpoint probe. */
  workerOwned?: () => boolean;
  onChange?: () => void;
}) {
  let closed = false, probing = false, workerProbing = false, ready = false, workerReady = false;
  const manager = manageLinuxOwnerBridge({ ...options, platform: 'linux', listenerOwner: 'engine-host', ready: () => !closed && ready, workerReady: () => workerReady && options.workerOwned?.() !== false });
  let workerFailures = 0;
  // Worker availability never delays or coalesces a desktop-presence probe.
  const probeWorker = async () => {
    if (closed || workerProbing) return;
    workerProbing = true;
    try {
      const value = ready && await options.workerReady().catch(() => false);
      if (!closed) {
        workerFailures = value ? 0 : workerFailures + 1;
        workerReady = ready && (value || (workerReady && workerFailures < 2));
      }
    } finally { workerProbing = false; if (!closed) options.onChange?.(); }
  };
  const probe = async () => {
    if (closed || probing) return;
    probing = true;
    try {
      const desktop = await (options.desktopReady ?? (async () => (await linuxGraphicalSessionReadinessAsync()).ready))();
      if (closed) return;
      ready = desktop;
      // Publish logout BEFORE waiting for a potentially unavailable worker.
      manager.refresh();
      if (!desktop) { workerReady = false; workerFailures = 0; }
      void probeWorker();
    } catch { ready = false; workerReady = false; }
    finally { probing = false; if (!closed) { manager.refresh(); options.onChange?.(); } }
  };
  if (validateWorkerSocketDirectory(options.transport) !== options.socketPath) throw new Error('Owner runtime changed.');
  const controlPath = join(dirname(options.socketPath), `owner-host-${process.pid}-${randomBytes(6).toString('hex')}.sock`);
  const control = bindWorkerSocket(controlPath, () => Bun.serve({ unix: controlPath, async fetch(request) {
    if (closed) return new Response(null, { status: 503 });
    const url = new URL(request.url);
    if (url.pathname === '/status' && request.method === 'GET') return Response.json(manager.status());
    if (url.pathname !== '/open' || request.method !== 'POST') return new Response(null, { status: 403 });
    try { return Response.json({ origin: await manager.open(url.searchParams.get('target') ?? '') }); }
    catch { return new Response(null, { status: 503 }); }
  } }));
  const inode = lstatSync(controlPath);
  const timer = setInterval(() => { void probe(); }, 2_000); timer.unref();
  void probe();
  return {
    controlPath, probe, status: manager.status,
    close() {
      if (closed) return;
      closed = true; ready = false; clearInterval(timer); manager.close(); control.stop(true);
      try { const current = lstatSync(controlPath); if (current.ino === inode.ino && current.dev === inode.dev) unlinkSync(controlPath); } catch {}
    },
  };
}

/** The worker has no authority over the host epoch, including on signals. */
export function connectLinuxOwnerBridgeHost(path: string, transport?: WorkerTransportOptions) {
  let status: DesktopBridgeStatus = { state: 'unavailable', remedy: 'The engine host desktop listener is unavailable. Open Olympus again after the engine starts.' };
  let closed = false;
  const request = async (suffix: string, method = 'GET') => {
    const workerPath = validateWorkerSocketDirectory(transport);
    const stat = lstatSync(path);
    if (!workerPath || dirname(path) !== dirname(workerPath) || !/^owner-host-\d+-[a-f0-9]{12}\.sock$/.test(path.split('/').at(-1)!)
      || !stat.isSocket() || stat.uid !== (transport?.uid ?? process.getuid?.()) || (stat.mode & 0o777) !== 0o600) throw new Error('Unsafe owner host socket.');
    return fetch('http://localhost' + suffix, { unix: path, method, signal: AbortSignal.timeout(5_000) } as RequestInit);
  };
  return {
    async refresh() {
      if (closed) return;
      try {
        const response = await request('/status');
        if (!response.ok) throw new Error('Host unavailable.');
        const next = await response.json() as DesktopBridgeStatus;
        if (!closed) status = next;
      } catch { if (!closed) status = { state: 'unavailable', remedy: 'Restart the Olympus engine or use the owner SSH socket forward.' }; }
    },
    status: () => ({ ...status }),
    async open(target: string): Promise<string> {
      if (closed) throw new Error('Worker stopped.');
      const response = await request('/open?target=' + encodeURIComponent(target), 'POST');
      if (!response.ok || closed) throw new Error('Owner ticket unavailable.');
      return (await response.json() as { origin: string }).origin;
    },
    close() { closed = true; },
  };
}
