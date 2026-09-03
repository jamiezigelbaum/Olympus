import { castorWorkspaceRootsFromEnv, createCastorWorkspaceWorker } from './index.ts';
import {
  resolveWorkerBindHost,
  warnIfWorkerAuthDisabled,
  withWorkerBearerAuth,
  workerAuthTokenFromEnv,
} from '../http.ts';

export function resolveCastorWorkspaceBindHostFromEnv(env: Record<string, string | undefined> = process.env): string {
  return resolveWorkerBindHost(env, ['OLYMPUS_CASTOR_WORKSPACE_HOST']);
}

function main(): void {
  const port = parsePort(process.env.OLYMPUS_CASTOR_WORKSPACE_PORT ?? '8030');
  const hostname = resolveCastorWorkspaceBindHostFromEnv(process.env);
  const authToken = workerAuthTokenFromEnv(process.env);
  const roots = castorWorkspaceRootsFromEnv(process.env);
  const worker = createCastorWorkspaceWorker({ roots });
  warnIfWorkerAuthDisabled('Castor Workspace worker', authToken, hostname);

  Bun.serve({
    hostname,
    port,
    fetch: withWorkerBearerAuth(worker.fetch, { authToken }),
  });

  console.log(`Olympus delegated workspace worker listening on http://${hostname}:${port}/v1`);
  console.log(
    roots.length > 0
      ? `Configured delegated workspace roots: ${roots.map((root) => root.rootId).join(', ')}.`
      : 'No delegated workspace roots configured. Set OLYMPUS_CASTOR_WORKSPACE_ROOTS_JSON before enabling workspace access.',
  );
}

function parsePort(value: string): number {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error('OLYMPUS_CASTOR_WORKSPACE_PORT must be an integer from 1 to 65535.');
  }
  return port;
}

if (import.meta.main) {
  main();
}
