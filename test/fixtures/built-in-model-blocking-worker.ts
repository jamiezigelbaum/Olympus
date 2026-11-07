// A deterministic lifecycle stand-in: the installer/start can monopolise this
// thread while the owner request loop must remain responsive.
import { parentPort, workerData } from 'node:worker_threads';
const port = parentPort!;
port.on('message', (message: { id: number; request?: { kind: string }; shutdown?: boolean }) => {
  if (message.shutdown) {
    Atomics.store(workerData.shutdown, 0, 1); Atomics.notify(workerData.shutdown, 0); return;
  }
  if (message.request?.kind === 'shutdown') { port.postMessage({ id: message.id }); port.close(); return; }
  port.postMessage({ id: message.id, log: 'blocking' });
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 600);
  port.postMessage({ id: message.id, result: 'finished' });
});
