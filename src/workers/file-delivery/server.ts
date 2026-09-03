import { createFileDeliveryWorker, fileDeliveryRootsFromEnv } from './index.ts';
import {
  resolveWorkerBindHost,
  warnIfWorkerAuthDisabled,
  withWorkerBearerAuth,
  workerAuthTokenFromEnv,
} from '../http.ts';

export function resolveFileDeliveryBindHostFromEnv(env: Record<string, string | undefined> = process.env): string {
  return resolveWorkerBindHost(env, ['OLYMPUS_FILE_DELIVERY_HOST']);
}

function main(): void {
  const port = parsePort(process.env.OLYMPUS_FILE_DELIVERY_PORT ?? '8020');
  const hostname = resolveFileDeliveryBindHostFromEnv(process.env);
  const authToken = workerAuthTokenFromEnv(process.env);
  const roots = fileDeliveryRootsFromEnv(process.env);
  const worker = createFileDeliveryWorker({ roots });
  warnIfWorkerAuthDisabled('bounded file-delivery worker', authToken, hostname);

  Bun.serve({
    hostname,
    port,
    fetch: withWorkerBearerAuth(worker.fetch, { authToken }),
  });

  console.log(`Olympus bounded file-delivery worker listening on http://${hostname}:${port}/v1`);
  console.log(
    roots.length > 0
      ? `Configured file-delivery roots: ${roots.map((root) => root.rootId).join(', ')}.`
      : 'No file-delivery roots configured. Set OLYMPUS_FILE_DELIVERY_ROOTS_JSON before enabling writes.',
  );
}

function parsePort(value: string): number {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error('OLYMPUS_FILE_DELIVERY_PORT must be an integer from 1 to 65535.');
  }
  return port;
}

if (import.meta.main) {
  main();
}
