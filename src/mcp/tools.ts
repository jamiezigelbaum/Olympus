import type { OlympusConfig } from '../core/config.ts';
import { exposedOperations, type OperationSurface } from '../core/operation-exposure.ts';
import { operations, operationDescription, operationToolSchema } from '../core/operations.ts';

export function listMcpTools(config: OlympusConfig, surface: Extract<OperationSurface, 'mcp' | 'remote'> = 'mcp'): Array<{
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}> {
  return exposedOperations(operations, { config, surface }).map((operation) => ({
    name: operation.name,
    description: operationDescription(operation, { config }),
    inputSchema: operationToolSchema(operation, { config }),
  }));
}
