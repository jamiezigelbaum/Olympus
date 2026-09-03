import {
  createDomainExpertWorker,
  domainExpertAnnasConfigFromEnv,
  domainExpertGoogleConfigFromEnv,
  domainExpertNotionConfigFromEnv,
  domainExpertRootsFromEnv,
  domainExpertWorkerFlagsFromEnv,
} from './index.ts';
import {
  resolveWorkerBindHost,
  warnIfWorkerAuthDisabled,
  withWorkerBearerAuth,
  workerAuthTokenFromEnv,
} from '../http.ts';

export function resolveDomainExpertBindHostFromEnv(env: Record<string, string | undefined> = process.env): string {
  return resolveWorkerBindHost(env, ['OLYMPUS_DOMAIN_EXPERT_HOST']);
}

function main(): void {
  const port = parsePort(process.env.OLYMPUS_DOMAIN_EXPERT_PORT ?? '8040');
  const hostname = resolveDomainExpertBindHostFromEnv(process.env);
  const authToken = workerAuthTokenFromEnv(process.env);
  const roots = domainExpertRootsFromEnv(process.env);
  const workerFlags = domainExpertWorkerFlagsFromEnv(process.env);
  const worker = createDomainExpertWorker({
    ...workerFlags,
    roots,
    google: domainExpertGoogleConfigFromEnv(process.env),
    annas: domainExpertAnnasConfigFromEnv(process.env),
    notion: domainExpertNotionConfigFromEnv(process.env),
    ...(process.env.OLYMPUS_DOMAIN_EXPERT_DATA_DIR
      ? { dataDir: process.env.OLYMPUS_DOMAIN_EXPERT_DATA_DIR }
      : {}),
  });
  warnIfWorkerAuthDisabled('domain expert worker', authToken, hostname);

  Bun.serve({
    hostname,
    port,
    fetch: withWorkerBearerAuth(worker.fetch, { authToken }),
  });

  console.log(`Olympus domain expert worker listening on http://${hostname}:${port}/v1`);
  if (!workerFlags.enabled || !workerFlags.liveToolsEnabled) {
    console.log(
      'Domain expert dispatch is disabled: OLYMPUS_DOMAIN_EXPERT_ENABLED and '
      + 'OLYMPUS_DOMAIN_EXPERT_LIVE_TOOLS_ENABLED must both be true.',
    );
  }
  console.log(
    roots.length > 0
      ? `Configured domain expert workspace roots: ${roots.map((root) => root.rootId).join(', ')}.`
      : 'No domain expert roots configured. Set OLYMPUS_DOMAIN_EXPERT_ROOTS_JSON before enabling live domain work.',
  );
}

function parsePort(value: string): number {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error('OLYMPUS_DOMAIN_EXPERT_PORT must be an integer from 1 to 65535.');
  }
  return port;
}

if (import.meta.main) {
  main();
}
