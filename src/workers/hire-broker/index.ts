import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';

import { JsonRpcA2aTransport } from './a2a.ts';
import { HireBroker, HireJobStore } from './broker.ts';
import { HireBrokerClient } from './client.ts';
import {
  CounterpartyIdentityResolver,
  HttpAgentCardResolver,
  ReadOnlyErc8004IdentityVerifier,
} from './identity.ts';
import { HireLedger } from './ledger.ts';
import { HostileInputMembrane, LocalTrustedReportSummarizer } from './membrane.ts';
import { MockPaymentProvider } from './payment.ts';
import { CounterpartyRegistry } from './registry.ts';
import { startHireBrokerServer } from './server.ts';

export interface HireBrokerPluginConfig {
  enabled: boolean;
  socketPath: string;
  requestTimeoutSeconds: number;
}

export function hireBrokerPluginConfig(pluginConfig: unknown): HireBrokerPluginConfig {
  const root = asRecord(pluginConfig);
  const section = asRecord(root?.hireBroker);
  const enabled = section?.enabled === true;
  const socketPath = typeof section?.socketPath === 'string' && section.socketPath.trim()
    ? section.socketPath.trim()
    : join(homedir(), '.olympus', 'run', 'hire-broker.sock');
  const requestTimeoutSeconds = typeof section?.requestTimeoutSeconds === 'number'
    ? section.requestTimeoutSeconds
    : 35;
  if (!isAbsolute(socketPath) || /[\r\n\u0000]/.test(socketPath)) {
    throw new Error('hireBroker.socketPath must be an absolute safe path.');
  }
  if (!Number.isFinite(requestTimeoutSeconds) || requestTimeoutSeconds <= 0) {
    throw new Error('hireBroker.requestTimeoutSeconds must be greater than zero.');
  }
  return { enabled, socketPath, requestTimeoutSeconds };
}

export function createHireBrokerClientFromPluginConfig(pluginConfig: unknown): HireBrokerClient | undefined {
  const config = hireBrokerPluginConfig(pluginConfig);
  return config.enabled
    ? new HireBrokerClient({ socketPath: config.socketPath, timeoutMs: config.requestTimeoutSeconds * 1_000 })
    : undefined;
}

export async function runHireBrokerFromEnvironment(
  env: Record<string, string | undefined> = process.env,
): Promise<Awaited<ReturnType<typeof startHireBrokerServer>>> {
  const stateDir = env.OLYMPUS_HIRE_BROKER_STATE_DIR ?? join(homedir(), '.olympus', 'hire-broker');
  const socketPath = env.OLYMPUS_HIRE_BROKER_SOCKET ?? join(homedir(), '.olympus', 'run', 'hire-broker.sock');
  if (!isAbsolute(stateDir) || !isAbsolute(socketPath)) throw new Error('Hire Broker paths must be absolute.');
  const fetchImpl = globalThis.fetch;
  const broker = new HireBroker({
    registry: new CounterpartyRegistry(join(stateDir, 'counterparties.json')),
    ledger: new HireLedger(join(stateDir, 'ledger.jsonl')),
    jobs: new HireJobStore(join(stateDir, 'jobs.json'), join(stateDir, 'reports')),
    identityResolver: new CounterpartyIdentityResolver(
      new HttpAgentCardResolver(fetchImpl),
      new ReadOnlyErc8004IdentityVerifier(fetchImpl, {
        rpcEndpoints: {
          ...(env.OLYMPUS_HIRE_BROKER_RPC_ETHEREUM ? { ethereum: env.OLYMPUS_HIRE_BROKER_RPC_ETHEREUM } : {}),
          ...(env.OLYMPUS_HIRE_BROKER_RPC_ARBITRUM ? { arbitrum: env.OLYMPUS_HIRE_BROKER_RPC_ARBITRUM } : {}),
          ...(env.OLYMPUS_HIRE_BROKER_RPC_BASE ? { base: env.OLYMPUS_HIRE_BROKER_RPC_BASE } : {}),
        },
        ...(env.OLYMPUS_HIRE_BROKER_IPFS_GATEWAY ? { ipfsGateway: env.OLYMPUS_HIRE_BROKER_IPFS_GATEWAY } : {}),
      }),
    ),
    ...(env.OLYMPUS_HIRE_BROKER_PAYMENT_PROVIDER === 'mock'
      ? { paymentProvider: new MockPaymentProvider() }
      : {}),
    transport: new JsonRpcA2aTransport(fetchImpl),
    membrane: new HostileInputMembrane(new LocalTrustedReportSummarizer({
      baseUrl: env.OLYMPUS_HIRE_BROKER_SUMMARIZER_BASE_URL ?? 'http://127.0.0.1:28090/v1',
      model: env.OLYMPUS_HIRE_BROKER_SUMMARIZER_MODEL
        // A delphi/* profile per the consumer contract; models rotate.
        ?? 'delphi/default-chat',
      fetchImpl,
    })),
  });
  return startHireBrokerServer({ broker, socketPath });
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

if (import.meta.main) {
  const server = await runHireBrokerFromEnvironment();
  process.stdout.write(`Hire Broker listening on ${server.socketPath}\n`);
  let closing = false;
  const close = async () => {
    if (closing) return;
    closing = true;
    await server.close();
    process.exit(0);
  };
  process.once('SIGINT', () => void close());
  process.once('SIGTERM', () => void close());
}

export * from './a2a.ts';
export * from './broker.ts';
export * from './client.ts';
export * from './identity.ts';
export * from './ledger.ts';
export * from './membrane.ts';
export * from './payment.ts';
export * from './registry.ts';
export * from './release.ts';
export * from './server.ts';
export * from './types.ts';
